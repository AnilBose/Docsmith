"""In-memory document registry.

Documents never touch the disk. Each open document owns a live ``fitz.Document``
plus a bounded snapshot history that powers undo/redo. Snapshots are stored as
incrementally-saved PDF bytes, so an undo restores the file byte-for-byte -- no
re-rendering, no generational quality loss.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import fitz  # PyMuPDF

from app.config import settings

MAX_HISTORY = 40


class DocumentError(RuntimeError):
    """Raised for user-correctable document problems (bad password, bad page...)."""


@dataclass
class DocumentSession:
    doc_id: str
    filename: str
    doc: fitz.Document
    created_at: float = field(default_factory=time.time)
    touched_at: float = field(default_factory=time.time)
    password: str | None = None
    version: int = 0
    # Undo/redo: lists of full PDF byte snapshots.
    _undo: list[bytes] = field(default_factory=list)
    _redo: list[bytes] = field(default_factory=list)
    # Per-document caches (embedded font archive, layout, ...).
    cache: dict[str, Any] = field(default_factory=dict)
    lock: threading.RLock = field(default_factory=threading.RLock)

    # ------------------------------------------------------------------ meta
    @property
    def page_count(self) -> int:
        return self.doc.page_count

    def touch(self) -> None:
        self.touched_at = time.time()

    def invalidate_cache(self) -> None:
        """Drop derived caches and bump the version the client polls on."""
        self.cache.clear()
        self.version += 1

    # -------------------------------------------------------------- history
    def serialize(self, *, compress: bool = True) -> bytes:
        """Full, lossless save of the current state.

        ``garbage`` is deliberately 0. Any garbage-collection level renumbers
        the xref table *of the live in-memory document*, which would silently
        invalidate every object id the client is holding -- image xrefs,
        annotation xrefs -- the moment we took an undo snapshot. Compaction
        belongs in :meth:`export_bytes`, which works on a throwaway copy.
        """
        return self.doc.tobytes(
            garbage=0,
            deflate=compress,
            deflate_images=False,   # never recompress existing image streams
            deflate_fonts=compress,
            clean=False,            # `clean` rewrites content streams; avoid it
            preserve_metadata=True,
        )

    def export_bytes(self, *, compact: bool = True) -> bytes:
        """Bytes for download. Compaction happens on a copy, never in place."""
        raw = self.serialize()
        if not compact:
            return raw
        copy = fitz.open(stream=raw, filetype="pdf")
        try:
            return copy.tobytes(
                garbage=4, deflate=True, deflate_images=False, clean=False
            )
        finally:
            copy.close()

    def checkpoint(self) -> None:
        """Record the *current* state so the next mutation can be undone."""
        self._undo.append(self.serialize())
        if len(self._undo) > MAX_HISTORY:
            self._undo.pop(0)
        self._redo.clear()

    def reload(self) -> None:
        """Reopen the document from its own bytes, dropping MuPDF's page caches.

        Object numbers survive (``serialize`` never garbage-collects), so ids
        the client holds stay valid. Also counts as a change for the client.
        """
        self._swap_to(self.serialize())

    def rollback(self) -> None:
        """Abandon a half-finished mutation by restoring the last checkpoint."""
        if self._undo:
            self._swap_to(self._undo.pop())

    def _swap_to(self, data: bytes) -> None:
        new_doc = fitz.open(stream=data, filetype="pdf")
        try:
            self.doc.close()
        except Exception:
            pass
        self.doc = new_doc
        self.invalidate_cache()

    def undo(self) -> bool:
        if not self._undo:
            return False
        self._redo.append(self.serialize())
        self._swap_to(self._undo.pop())
        self.touch()
        return True

    def redo(self) -> bool:
        if not self._redo:
            return False
        self._undo.append(self.serialize())
        self._swap_to(self._redo.pop())
        self.touch()
        return True

    @property
    def can_undo(self) -> bool:
        return bool(self._undo)

    @property
    def can_redo(self) -> bool:
        return bool(self._redo)

    def close(self) -> None:
        try:
            self.doc.close()
        except Exception:
            pass
        self._undo.clear()
        self._redo.clear()
        self.cache.clear()


class DocumentStore:
    def __init__(self) -> None:
        self._docs: dict[str, DocumentSession] = {}
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ CRUD
    def open(self, data: bytes, filename: str, password: str | None = None) -> DocumentSession:
        if len(data) > settings.max_upload_bytes:
            raise DocumentError(
                f"File exceeds the {settings.max_upload_bytes // (1024 * 1024)} MB limit."
            )
        try:
            doc = fitz.open(stream=data, filetype="pdf")
        except Exception as exc:  # malformed / not a PDF
            raise DocumentError(f"Could not parse this file as a PDF: {exc}") from exc

        if doc.needs_pass:
            if not password or not doc.authenticate(password):
                doc.close()
                raise DocumentError("PASSWORD_REQUIRED")

        if settings.strip_active_content:
            _strip_active_content(doc)

        with self._lock:
            self._evict_expired_locked()
            if len(self._docs) >= settings.max_open_documents:
                oldest = min(self._docs.values(), key=lambda s: s.touched_at)
                self._close_locked(oldest.doc_id)
            session = DocumentSession(
                doc_id=uuid.uuid4().hex,
                filename=_safe_name(filename),
                doc=doc,
                password=password,
            )
            self._docs[session.doc_id] = session
        return session

    def adopt(self, doc: fitz.Document, filename: str) -> DocumentSession:
        """Register an already-built fitz document (merge results, splits...)."""
        with self._lock:
            self._evict_expired_locked()
            session = DocumentSession(
                doc_id=uuid.uuid4().hex, filename=_safe_name(filename), doc=doc
            )
            self._docs[session.doc_id] = session
        return session

    def get(self, doc_id: str) -> DocumentSession:
        with self._lock:
            session = self._docs.get(doc_id)
        if session is None:
            raise DocumentError("Document not found or the session expired.")
        session.touch()
        return session

    def close(self, doc_id: str) -> None:
        with self._lock:
            self._close_locked(doc_id)

    def list(self) -> list[DocumentSession]:
        with self._lock:
            return sorted(self._docs.values(), key=lambda s: s.created_at)

    # --------------------------------------------------------------- private
    def _close_locked(self, doc_id: str) -> None:
        session = self._docs.pop(doc_id, None)
        if session:
            session.close()

    def _evict_expired_locked(self) -> None:
        cutoff = time.time() - settings.session_ttl_seconds
        for doc_id in [d for d, s in self._docs.items() if s.touched_at < cutoff]:
            self._close_locked(doc_id)


def _safe_name(name: str) -> str:
    """Strip any path components a client might smuggle in a filename."""
    cleaned = (name or "document.pdf").replace("\\", "/").split("/")[-1]
    cleaned = "".join(ch for ch in cleaned if ch.isprintable() and ch not in '<>:"|?*')
    return cleaned.strip() or "document.pdf"


def _strip_active_content(doc: fitz.Document) -> None:
    """Remove embedded JavaScript and auto-launch actions.

    A PDF can carry ``/OpenAction``, ``/AA`` (additional actions) and document
    level ``/Names /JavaScript`` entries. None of them are needed for editing,
    and all of them are classic malware carriers, so we drop them on ingest.
    """
    try:
        root = doc.pdf_catalog()
        if root == 0:
            return
        for key in ("OpenAction", "AA"):
            try:
                doc.xref_set_key(root, key, "null")
            except Exception:
                pass
        try:
            names = doc.xref_get_key(root, "Names/JavaScript")
            if names and names[0] != "null":
                doc.xref_set_key(root, "Names/JavaScript", "null")
        except Exception:
            pass
    except Exception:
        # Never let hardening block opening a document.
        pass


store = DocumentStore()
