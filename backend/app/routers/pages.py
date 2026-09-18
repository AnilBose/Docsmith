"""Page organisation: insert, delete, reorder, rotate, split, merge, numbering."""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Query, Response
from pydantic import BaseModel, Field

from app.core.session import DocumentError, store
from app.routers.documents import get_session, summarize
from app.services import pages as pagesvc

router = APIRouter(prefix="/api", tags=["pages"])


def _guard(fn):
    try:
        return fn()
    except DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class PageSelection(BaseModel):
    pages: list[int] | None = None
    spec: str | None = None      # e.g. "1-3,7,10-"


class BlankPayload(BaseModel):
    at: int | None = None
    width: float | None = Field(default=None, gt=0, le=14400)
    height: float | None = Field(default=None, gt=0, le=14400)
    copySizeFrom: int | None = None


class RotatePayload(PageSelection):
    angle: int = 90
    absolute: bool = False


class ReorderPayload(BaseModel):
    order: list[int]


class MovePayload(BaseModel):
    source: int
    destination: int


class InsertFromPayload(BaseModel):
    sourceId: str
    at: int | None = None
    pages: list[int] | None = None


class ReplacePagesPayload(BaseModel):
    sourceId: str
    targets: list[int]
    sourcePages: list[int] | None = None


class SplitPayload(BaseModel):
    every: int | None = Field(default=None, ge=1)
    at: list[int] | None = None


class MergePayload(BaseModel):
    documentIds: list[str]
    filename: str = "merged.pdf"


class MoveBetweenPayload(BaseModel):
    targetId: str
    pages: list[int]
    at: int | None = None


class CoverPayload(BaseModel):
    title: str = ""
    subtitle: str = ""
    atEnd: bool = False


class NumberingPayload(PageSelection):
    position: str = "bottom-center"
    template: str = "{n}"
    startAt: int = 1
    style: str = "arabic"          # arabic | roman | ROMAN | alpha | ALPHA
    fontSize: float = Field(default=10.0, gt=0, le=96)
    color: str = "#000000"
    margin: float = Field(default=28.0, ge=0, le=300)
    skipFirst: bool = False


def _resolve(session, selection: PageSelection) -> list[int] | None:
    if selection.pages is not None:
        return selection.pages
    if selection.spec:
        return _guard(lambda: pagesvc.parse_page_spec(selection.spec, session.doc.page_count))
    return None


# --------------------------------------------------------------------------- #
@router.get("/documents/{doc_id}/pages")
def list_pages(doc_id: str):
    return pagesvc.describe(get_session(doc_id))


@router.get("/documents/{doc_id}/pages/{page}/thumbnail")
def page_thumbnail(doc_id: str, page: int, width: int = Query(default=180, ge=40, le=800)):
    import fitz

    session = get_session(doc_id)
    if page < 0 or page >= session.doc.page_count:
        raise HTTPException(status_code=404, detail="No such page.")
    target = session.doc[page]
    scale = width / max(target.rect.width, 1)
    pix = target.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    return Response(
        content=pix.tobytes("png"),
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/documents/{doc_id}/pages/blank")
def add_blank(doc_id: str, payload: BlankPayload = Body(default=BlankPayload())):
    session = get_session(doc_id)
    result = _guard(
        lambda: pagesvc.add_blank(
            session,
            payload.at,
            width=payload.width,
            height=payload.height,
            copy_size_from=payload.copySizeFrom,
        )
    )
    return {**result, "document": summarize(session)}


@router.post("/documents/{doc_id}/pages/delete")
def delete_pages(doc_id: str, payload: PageSelection = Body(...)):
    session = get_session(doc_id)
    targets = _resolve(session, payload)
    if not targets:
        raise HTTPException(status_code=400, detail="No pages selected.")
    result = _guard(lambda: pagesvc.delete_pages(session, targets))
    return {**result, "document": summarize(session)}


@router.post("/documents/{doc_id}/pages/duplicate")
def duplicate_pages(doc_id: str, payload: PageSelection = Body(...)):
    session = get_session(doc_id)
    targets = _resolve(session, payload)
    if not targets:
        raise HTTPException(status_code=400, detail="No pages selected.")
    result = _guard(lambda: pagesvc.duplicate_pages(session, targets))
    return {**result, "document": summarize(session)}


@router.post("/documents/{doc_id}/pages/reorder")
def reorder(doc_id: str, payload: ReorderPayload = Body(...)):
    session = get_session(doc_id)
    result = _guard(lambda: pagesvc.reorder(session, payload.order))
    return {**result, "document": summarize(session)}


@router.post("/documents/{doc_id}/pages/move")
def move(doc_id: str, payload: MovePayload = Body(...)):
    session = get_session(doc_id)
    result = _guard(lambda: pagesvc.move_page(session, payload.source, payload.destination))
    return {**result, "document": summarize(session)}


@router.post("/documents/{doc_id}/pages/rotate")
def rotate(doc_id: str, payload: RotatePayload = Body(...)):
    session = get_session(doc_id)
    targets = _resolve(session, payload) or list(range(session.doc.page_count))
    result = _guard(
        lambda: pagesvc.rotate_pages(session, targets, payload.angle, absolute=payload.absolute)
    )
    return {**result, "document": summarize(session)}


@router.post("/documents/{doc_id}/pages/extract")
def extract(doc_id: str, payload: PageSelection = Body(...)):
    session = get_session(doc_id)
    targets = _resolve(session, payload)
    if not targets:
        raise HTTPException(status_code=400, detail="No pages selected.")
    created = _guard(lambda: pagesvc.extract_pages(session, targets))
    return {"document": summarize(created)}


@router.post("/documents/{doc_id}/pages/insert-from")
def insert_from(doc_id: str, payload: InsertFromPayload = Body(...)):
    session = get_session(doc_id)
    source = get_session(payload.sourceId)
    result = _guard(
        lambda: pagesvc.insert_from(session, source, at=payload.at, pages=payload.pages)
    )
    return {**result, "document": summarize(session)}


@router.post("/documents/{doc_id}/pages/replace")
def replace_pages(doc_id: str, payload: ReplacePagesPayload = Body(...)):
    session = get_session(doc_id)
    source = get_session(payload.sourceId)
    result = _guard(
        lambda: pagesvc.replace_pages(
            session, source, targets=payload.targets, source_pages=payload.sourcePages
        )
    )
    return {**result, "document": summarize(session)}


@router.post("/documents/{doc_id}/pages/split")
def split(doc_id: str, payload: SplitPayload = Body(...)):
    session = get_session(doc_id)
    parts = _guard(lambda: pagesvc.split(session, every=payload.every, at=payload.at))
    return {"parts": [summarize(p) for p in parts]}


@router.post("/documents/{doc_id}/pages/move-between")
def move_between(doc_id: str, payload: MoveBetweenPayload = Body(...)):
    source = get_session(doc_id)
    target = get_session(payload.targetId)
    result = _guard(
        lambda: pagesvc.move_between(source, target, payload.pages, at=payload.at)
    )
    return {**result, "source": summarize(source), "target": summarize(target)}


@router.post("/documents/{doc_id}/pages/cover")
def cover(doc_id: str, payload: CoverPayload = Body(...)):
    session = get_session(doc_id)
    result = _guard(
        lambda: pagesvc.add_cover(
            session, title=payload.title, subtitle=payload.subtitle, at_end=payload.atEnd
        )
    )
    return {**result, "document": summarize(session)}


@router.post("/documents/{doc_id}/pages/numbering")
def numbering(doc_id: str, payload: NumberingPayload = Body(...)):
    session = get_session(doc_id)
    targets = _resolve(session, payload)
    result = _guard(
        lambda: pagesvc.add_page_numbers(
            session,
            pages=targets,
            position=payload.position,
            template=payload.template,
            start_at=payload.startAt,
            style=payload.style,
            font_size=payload.fontSize,
            color=payload.color,
            margin=payload.margin,
            skip_first=payload.skipFirst,
        )
    )
    return {**result, "document": summarize(session)}


@router.post("/merge")
def merge(payload: MergePayload = Body(...)):
    sessions = [get_session(d) for d in payload.documentIds]
    merged = _guard(lambda: pagesvc.merge(sessions, payload.filename))
    return {"document": summarize(merged)}
