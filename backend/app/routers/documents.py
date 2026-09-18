"""Document lifecycle: open, inspect, undo/redo, download, close."""
from __future__ import annotations

import io
from urllib.parse import quote

from fastapi import APIRouter, Body, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.responses import StreamingResponse

from app.core.session import DocumentError, DocumentSession, store
from app.services import convert, fonts, pages as pagesvc, security as secsvc

router = APIRouter(prefix="/api/documents", tags=["documents"])


def get_session(doc_id: str) -> DocumentSession:
    try:
        return store.get(doc_id)
    except DocumentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def summarize(session: DocumentSession) -> dict:
    doc = session.doc
    meta = doc.metadata or {}
    return {
        "id": session.doc_id,
        "filename": session.filename,
        "pageCount": doc.page_count,
        "version": session.version,
        "canUndo": session.can_undo,
        "canRedo": session.can_redo,
        "encrypted": bool(meta.get("encryption")),
        "isFormPdf": bool(doc.is_form_pdf),
        "hasLinks": True,
        "metadata": {
            "title": meta.get("title", ""),
            "author": meta.get("author", ""),
            "subject": meta.get("subject", ""),
            "keywords": meta.get("keywords", ""),
            "creator": meta.get("creator", ""),
            "producer": meta.get("producer", ""),
            "created": meta.get("creationDate", ""),
            "modified": meta.get("modDate", ""),
        },
        "pages": pagesvc.describe(session),
    }


@router.post("/open")
async def open_document(
    file: UploadFile = File(...),
    password: str | None = Form(default=None),
    convert_to_pdf: bool = Form(default=True),
):
    """Open a PDF. Non-PDF uploads are converted first when possible."""
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")

    filename = file.filename or "document.pdf"
    if not data.startswith(b"%PDF") and convert_to_pdf:
        try:
            data = convert.to_pdf(data, filename)
            filename = filename.rsplit(".", 1)[0] + ".pdf"
        except DocumentError as exc:
            raise HTTPException(status_code=415, detail=str(exc)) from exc

    try:
        session = store.open(data, filename, password)
    except DocumentError as exc:
        if str(exc) == "PASSWORD_REQUIRED":
            raise HTTPException(
                status_code=401,
                detail="This PDF is password protected. Supply the open password.",
            ) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return summarize(session)


@router.get("")
def list_documents():
    return [
        {
            "id": s.doc_id,
            "filename": s.filename,
            "pageCount": s.doc.page_count,
            "version": s.version,
        }
        for s in store.list()
    ]


@router.get("/{doc_id}")
def document_info(doc_id: str):
    return summarize(get_session(doc_id))


@router.get("/{doc_id}/file")
def document_file(doc_id: str, v: int | None = Query(default=None)):
    """The current bytes of the document, for the pdf.js viewer."""
    session = get_session(doc_id)
    data = session.serialize()   # non-compacting: keeps xrefs stable for the UI
    return Response(
        content=data,
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'inline; filename="{0}"'.format(quote(session.filename)),
            "Cache-Control": "no-store",
            "X-Document-Version": str(session.version),
        },
    )


@router.get("/{doc_id}/download")
def download(doc_id: str, filename: str | None = Query(default=None)):
    session = get_session(doc_id)
    data = session.export_bytes(compact=True)
    name = filename or session.filename
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/pdf",
        headers={
            "Content-Disposition": "attachment; filename*=UTF-8''{0}".format(quote(name)),
            "Content-Length": str(len(data)),
        },
    )


@router.post("/{doc_id}/undo")
def undo(doc_id: str):
    session = get_session(doc_id)
    with session.lock:
        changed = session.undo()
    return {"changed": changed, **summarize(session)}


@router.post("/{doc_id}/redo")
def redo(doc_id: str):
    session = get_session(doc_id)
    with session.lock:
        changed = session.redo()
    return {"changed": changed, **summarize(session)}


@router.get("/{doc_id}/fonts")
def document_fonts(doc_id: str):
    return fonts.available_families(get_session(doc_id))


@router.get("/{doc_id}/security")
def document_security(doc_id: str):
    return secsvc.describe(get_session(doc_id))


@router.put("/{doc_id}/metadata")
def set_metadata(doc_id: str, payload: dict = Body(...)):
    session = get_session(doc_id)
    allowed = {"title", "author", "subject", "keywords", "creator", "producer"}
    with session.lock:
        session.checkpoint()
        current = session.doc.metadata or {}
        current.update({k: str(v) for k, v in payload.items() if k in allowed})
        session.doc.set_metadata(current)
        session.invalidate_cache()
    return summarize(session)


@router.post("/{doc_id}/sanitize")
def sanitize(doc_id: str):
    session = get_session(doc_id)
    try:
        return secsvc.sanitize(session)
    except DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/{doc_id}")
def close_document(doc_id: str):
    store.close(doc_id)
    return {"closed": True}
