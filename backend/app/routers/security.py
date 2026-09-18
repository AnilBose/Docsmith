"""Passwords, permissions and redaction endpoints."""
from __future__ import annotations

import io
from urllib.parse import quote

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.session import DocumentError, store
from app.routers.documents import get_session, summarize
from app.services import redaction as redsvc
from app.services import security as secsvc

router = APIRouter(prefix="/api", tags=["security"])


def _guard(fn):
    try:
        return fn()
    except DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# --------------------------------------------------------------------------- #
# Encryption
# --------------------------------------------------------------------------- #
class PermissionsPayload(BaseModel):
    printDocument: bool = True
    printHighResolution: bool = True
    copyContent: bool = True
    modifyContent: bool = True
    modifyAnnotations: bool = True
    fillForms: bool = True
    accessibility: bool = True
    assembleDocument: bool = True


class ProtectPayload(BaseModel):
    openPassword: str = ""
    ownerPassword: str = ""
    algorithm: str = "aes-256"
    permissions: PermissionsPayload = Field(default_factory=PermissionsPayload)


@router.post("/documents/{doc_id}/protect")
def protect(doc_id: str, payload: ProtectPayload = Body(...)):
    """Return an encrypted copy for download. The open session stays plain."""
    session = get_session(doc_id)
    data = _guard(
        lambda: secsvc.encrypt(
            session,
            open_password=payload.openPassword,
            owner_password=payload.ownerPassword,
            permissions=secsvc.PermissionSet.from_payload(payload.permissions.model_dump()),
            algorithm=payload.algorithm,
        )
    )
    name = session.filename.rsplit(".", 1)[0] + "-protected.pdf"
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/pdf",
        headers={
            "Content-Disposition": "attachment; filename*=UTF-8''{0}".format(quote(name)),
            "Content-Length": str(len(data)),
        },
    )


@router.post("/documents/{doc_id}/remove-password")
def remove_password(doc_id: str):
    """The in-memory document is already decrypted; export it unprotected."""
    session = get_session(doc_id)
    data = secsvc.decrypt_session(session)
    name = session.filename.rsplit(".", 1)[0] + "-unprotected.pdf"
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename*=UTF-8''{0}".format(quote(name))},
    )


@router.post("/unlock")
async def unlock(file: UploadFile = File(...), password: str = Form(...)):
    """Strip encryption from an uploaded file, given its password."""
    data = await file.read()
    plain = _guard(lambda: secsvc.remove_password(data, password))
    session = _guard(lambda: store.open(plain, file.filename or "unlocked.pdf"))
    return {"document": summarize(session)}


@router.get("/security/certificate-support")
def certificate_support():
    return {"supported": False, "reason": secsvc.CERTIFICATE_ENCRYPTION_NOTE}


# --------------------------------------------------------------------------- #
# Redaction
# --------------------------------------------------------------------------- #
class DetectPayload(BaseModel):
    kinds: list[str] = Field(default_factory=lambda: ["email", "phone", "ssn"])
    pages: list[int] | None = None
    customPatterns: list[str] = Field(default_factory=list)


class FindPayload(BaseModel):
    query: str
    regex: bool = False
    caseSensitive: bool = False
    wholeWord: bool = False
    pages: list[int] | None = None


class MarkPayload(BaseModel):
    marks: list[dict]
    fill: str | None = "#000000"
    overlayText: str = ""
    textColor: str = "#ffffff"
    fontSize: float = Field(default=8.0, gt=0, le=72)


class ApplyPayload(BaseModel):
    pages: list[int] | None = None
    removeImages: bool = True
    removeVectors: bool = True
    scrubMetadata: bool = True


class VerifyPayload(BaseModel):
    strings: list[str]


@router.get("/redaction/patterns")
def patterns():
    return [
        {"id": key, "label": spec["label"]}
        for key, spec in redsvc.PATTERNS.items()
    ]


@router.post("/documents/{doc_id}/redaction/detect")
def detect(doc_id: str, payload: DetectPayload = Body(...)):
    session = get_session(doc_id)
    findings = _guard(
        lambda: redsvc.detect(
            session, payload.kinds, pages=payload.pages,
            custom_patterns=payload.customPatterns,
        )
    )
    return {"count": len(findings), "findings": findings}


@router.post("/documents/{doc_id}/redaction/find")
def find(doc_id: str, payload: FindPayload = Body(...)):
    session = get_session(doc_id)
    findings = _guard(
        lambda: redsvc.find_text(
            session, payload.query, regex=payload.regex,
            case=payload.caseSensitive, whole_word=payload.wholeWord,
            pages=payload.pages,
        )
    )
    return {"count": len(findings), "findings": findings}


@router.get("/documents/{doc_id}/redaction/marks")
def list_marks(doc_id: str, page: int | None = None):
    session = get_session(doc_id)
    return _guard(lambda: redsvc.list_marks(session, page))


@router.post("/documents/{doc_id}/redaction/mark")
def mark(doc_id: str, payload: MarkPayload = Body(...)):
    session = get_session(doc_id)
    result = _guard(
        lambda: redsvc.mark(
            session, payload.marks, fill=payload.fill,
            overlay_text=payload.overlayText, text_color=payload.textColor,
            font_size=payload.fontSize,
        )
    )
    return {**result, "document": summarize(session)}


@router.post("/documents/{doc_id}/redaction/clear")
def clear(doc_id: str, payload: ApplyPayload = Body(default=ApplyPayload())):
    session = get_session(doc_id)
    result = _guard(lambda: redsvc.clear_marks(session, payload.pages))
    return {**result, "document": summarize(session)}


@router.post("/documents/{doc_id}/redaction/apply")
def apply(doc_id: str, payload: ApplyPayload = Body(default=ApplyPayload())):
    """Irreversible: the marked content is deleted from the file."""
    session = get_session(doc_id)
    result = _guard(
        lambda: redsvc.apply(
            session, pages=payload.pages,
            remove_images=payload.removeImages,
            remove_vectors=payload.removeVectors,
            scrub_metadata=payload.scrubMetadata,
        )
    )
    return {**result, "document": summarize(session)}


@router.post("/documents/{doc_id}/redaction/verify")
def verify(doc_id: str, payload: VerifyPayload = Body(...)):
    session = get_session(doc_id)
    return _guard(lambda: redsvc.verify(session, payload.strings))
