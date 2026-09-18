"""Image objects on a page."""
from __future__ import annotations

import io
from urllib.parse import quote

from fastapi import APIRouter, Body, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field

from app.core.session import DocumentError
from app.routers.documents import get_session, summarize
from app.services import images as imgsvc

router = APIRouter(prefix="/api/documents/{doc_id}/images", tags=["images"])

_MAX_IMAGE_BYTES = 64 * 1024 * 1024


class TransformPayload(BaseModel):
    page: int = Field(ge=0)
    xref: int
    occurrence: int = 0
    rect: list[float] | None = None
    rotate: int = 0
    flipH: bool = False
    flipV: bool = False
    crop: list[float] | None = None          # fractional l, t, r, b
    opacity: float = Field(default=1.0, ge=0.0, le=1.0)
    jpegQuality: int | None = Field(default=None, ge=10, le=100)
    keepAspect: bool = False


class CompressPayload(BaseModel):
    quality: int = Field(default=75, ge=10, le=100)
    maxDpi: int = Field(default=200, ge=36, le=600)
    pages: list[int] | None = None


def _guard(fn):
    try:
        return fn()
    except DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{page}")
def list_images(doc_id: str, page: int):
    session = get_session(doc_id)
    return _guard(lambda: imgsvc.list_images(session, page))


@router.post("")
async def add_image(
    doc_id: str,
    file: UploadFile = File(...),
    page: int = Form(...),
    rect: str | None = Form(default=None),
    keepAspect: bool = Form(default=True),
):
    session = get_session(doc_id)
    data = await file.read()
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="That image is too large.")
    box = [float(v) for v in rect.split(",")] if rect else None
    result = _guard(lambda: imgsvc.add_image(session, page, data, box, keep_aspect=keepAspect))
    return {**result, "document": summarize(session)}


@router.post("/replace")
async def replace_image(
    doc_id: str,
    file: UploadFile = File(...),
    page: int = Form(...),
    xref: int = Form(...),
    occurrence: int = Form(default=0),
):
    session = get_session(doc_id)
    data = await file.read()
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="That image is too large.")
    result = _guard(lambda: imgsvc.replace_image(session, page, xref, data, occurrence))
    return {**result, "document": summarize(session)}


@router.post("/transform")
def transform(doc_id: str, payload: TransformPayload = Body(...)):
    session = get_session(doc_id)
    result = _guard(
        lambda: imgsvc.transform_image(
            session,
            payload.page,
            payload.xref,
            occurrence=payload.occurrence,
            rect=payload.rect,
            rotate=payload.rotate,
            flip_h=payload.flipH,
            flip_v=payload.flipV,
            crop=payload.crop,
            opacity=payload.opacity,
            jpeg_quality=payload.jpegQuality,
            keep_aspect=payload.keepAspect,
        )
    )
    return {**result, "document": summarize(session)}


@router.delete("/{page}/{xref}")
def delete_image(doc_id: str, page: int, xref: int, occurrence: int = 0):
    session = get_session(doc_id)
    result = _guard(lambda: imgsvc.delete_image(session, page, xref, occurrence))
    return {**result, "document": summarize(session)}


@router.get("/{page}/{xref}/extract")
def extract_image(doc_id: str, page: int, xref: int):
    session = get_session(doc_id)
    data, ext = _guard(lambda: imgsvc.extract(session, xref))
    mime = {
        "png": "image/png", "jpeg": "image/jpeg", "jpg": "image/jpeg",
        "tiff": "image/tiff", "bmp": "image/bmp", "webp": "image/webp",
    }.get(ext, "application/octet-stream")
    name = "image-{0}.{1}".format(xref, ext)
    return Response(
        content=data,
        media_type=mime,
        headers={"Content-Disposition": "attachment; filename*=UTF-8''{0}".format(quote(name))},
    )


@router.get("/{page}/{xref}/thumbnail")
def thumbnail(doc_id: str, page: int, xref: int):
    session = get_session(doc_id)
    data = _guard(lambda: imgsvc.render_thumbnail(session, xref))
    return Response(content=data, media_type="image/png", headers={"Cache-Control": "no-store"})


@router.post("/compress")
def compress(doc_id: str, payload: CompressPayload = Body(...)):
    session = get_session(doc_id)
    result = _guard(
        lambda: imgsvc.compress_images(
            session, quality=payload.quality, max_dpi=payload.maxDpi, pages=payload.pages
        )
    )
    return {**result, "document": summarize(session)}
