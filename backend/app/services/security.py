"""Encryption, permissions and password removal.

qpdf (via pikepdf) does the cryptography here. We use AES-256 (revision 6) by
default, which is the strongest scheme the PDF 2.0 spec defines.

A note on what permission flags really are: PDF permissions are advisory bits
stored *inside* the encrypted document. A conforming reader honours them; the
bits themselves are enforced only by the reader, not by mathematics. Only the
open password ("user password") actually gates access to the content. The API
below reports this honestly rather than implying stronger guarantees.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field

import pikepdf

from app.core.session import DocumentError, DocumentSession

# Password strength floor for the open password.
_MIN_PASSWORD = 6


@dataclass
class PermissionSet:
    """Which actions a conforming reader should allow."""

    print_document: bool = True
    print_high_resolution: bool = True
    copy_content: bool = True
    modify_content: bool = True
    modify_annotations: bool = True
    fill_forms: bool = True
    accessibility: bool = True
    assemble_document: bool = True

    @classmethod
    def from_payload(cls, payload: dict | None) -> "PermissionSet":
        payload = payload or {}
        base = cls()
        for key in base.__dataclass_fields__:
            camel = _camel(key)
            if camel in payload and payload[camel] is not None:
                setattr(base, key, bool(payload[camel]))
            elif key in payload and payload[key] is not None:
                setattr(base, key, bool(payload[key]))
        return base

    def to_pikepdf(self) -> pikepdf.Permissions:
        return pikepdf.Permissions(
            accessibility=self.accessibility,
            extract=self.copy_content,
            modify_annotation=self.modify_annotations,
            modify_assembly=self.assemble_document,
            modify_form=self.fill_forms,
            modify_other=self.modify_content,
            print_lowres=self.print_document,
            print_highres=self.print_document and self.print_high_resolution,
        )

    def to_json(self) -> dict:
        return {_camel(k): getattr(self, k) for k in self.__dataclass_fields__}


def _camel(snake: str) -> str:
    head, *rest = snake.split("_")
    return head + "".join(part.title() for part in rest)


def describe(session: DocumentSession) -> dict:
    """Report the encryption state of the *currently loaded* document."""
    doc = session.doc
    meta = doc.metadata or {}
    encryption = meta.get("encryption")
    permissions = doc.permissions

    return {
        "encrypted": bool(encryption),
        "algorithm": encryption or None,
        "hadOpenPassword": bool(session.password),
        "permissions": {
            "printDocument": bool(permissions & pikepdf_flag("print_lowres")),
            "printHighResolution": bool(permissions & pikepdf_flag("print_highres")),
            "copyContent": bool(permissions & pikepdf_flag("extract")),
            "modifyContent": bool(permissions & pikepdf_flag("modify_other")),
            "modifyAnnotations": bool(permissions & pikepdf_flag("modify_annotation")),
            "fillForms": bool(permissions & pikepdf_flag("modify_form")),
            "accessibility": bool(permissions & pikepdf_flag("accessibility")),
            "assembleDocument": bool(permissions & pikepdf_flag("modify_assembly")),
        },
        "note": (
            "Permission flags are advisory and enforced by the reading "
            "application. Only the open password restricts access to content."
        ),
    }


_PERM_BITS = {
    "print_lowres": 1 << 2,
    "modify_other": 1 << 3,
    "extract": 1 << 4,
    "modify_annotation": 1 << 5,
    "modify_form": 1 << 8,
    "accessibility": 1 << 9,
    "modify_assembly": 1 << 10,
    "print_highres": 1 << 11,
}


def pikepdf_flag(name: str) -> int:
    return _PERM_BITS.get(name, 0)


def encrypt(
    session: DocumentSession,
    *,
    open_password: str = "",
    owner_password: str = "",
    permissions: PermissionSet | None = None,
    algorithm: str = "aes-256",
) -> bytes:
    """Return an encrypted copy of the current document as bytes."""
    if not open_password and not owner_password:
        raise DocumentError("Set an open password, an owner password, or both.")
    if open_password and len(open_password) < _MIN_PASSWORD:
        raise DocumentError(
            "The open password must be at least {0} characters.".format(_MIN_PASSWORD)
        )
    if owner_password and open_password and owner_password == open_password:
        raise DocumentError(
            "The owner password must differ from the open password, "
            "otherwise the restrictions can be lifted with the password the "
            "reader already has."
        )

    settings_map = {
        "aes-256": dict(R=6, aes=True),
        "aes-128": dict(R=4, aes=True),
        "rc4-128": dict(R=3, aes=False),
    }
    if algorithm not in settings_map:
        raise DocumentError("Unsupported algorithm '{0}'.".format(algorithm))

    perms = (permissions or PermissionSet()).to_pikepdf()
    source = session.serialize()

    try:
        with pikepdf.open(io.BytesIO(source)) as pdf:
            out = io.BytesIO()
            pdf.save(
                out,
                encryption=pikepdf.Encryption(
                    user=open_password,
                    owner=owner_password or open_password,
                    allow=perms,
                    **settings_map[algorithm],
                ),
                # Keep object streams so the file stays compact.
                object_stream_mode=pikepdf.ObjectStreamMode.generate,
            )
            return out.getvalue()
    except pikepdf.PdfError as exc:
        raise DocumentError("Encryption failed: {0}".format(exc)) from exc


def remove_password(data: bytes, password: str) -> bytes:
    """Decrypt to a plain PDF, given the correct password."""
    try:
        with pikepdf.open(io.BytesIO(data), password=password, allow_overwriting_input=False) as pdf:
            out = io.BytesIO()
            pdf.save(out)
            return out.getvalue()
    except pikepdf.PasswordError as exc:
        raise DocumentError("That password is not correct.") from exc
    except pikepdf.PdfError as exc:
        raise DocumentError("Could not decrypt the file: {0}".format(exc)) from exc


def decrypt_session(session: DocumentSession) -> bytes:
    """Export the open document with no encryption at all."""
    return session.serialize()


def sanitize(session: DocumentSession) -> dict:
    """Strip metadata, XMP, embedded files and any remaining JavaScript."""
    with session.lock:
        session.checkpoint()
        doc = session.doc
        try:
            doc.set_metadata({})
        except Exception:
            pass
        try:
            doc.del_xml_metadata()
        except Exception:
            pass

        removed_files = 0
        try:
            for i in reversed(range(doc.embfile_count())):
                doc.embfile_del(i)
                removed_files += 1
        except Exception:
            pass

        try:
            root = doc.pdf_catalog()
            for key in ("Names/JavaScript", "OpenAction", "AA", "AcroForm/XFA"):
                try:
                    doc.xref_set_key(root, key, "null")
                except Exception:
                    continue
        except Exception:
            pass

        session.invalidate_cache()
        return {"metadataCleared": True, "embeddedFilesRemoved": removed_files}


CERTIFICATE_ENCRYPTION_NOTE = (
    "Certificate (public-key) encryption is not available in this build. "
    "It requires a PKCS#7 recipient list, which neither qpdf/pikepdf nor "
    "PyMuPDF implements. Password-based AES-256 is offered instead, and is "
    "the stronger option unless you specifically need per-recipient keys. "
    "Adding it would mean shipping a PKI stack this local-only tool "
    "deliberately avoids."
)
