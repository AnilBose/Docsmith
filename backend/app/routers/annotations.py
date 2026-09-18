"""Markup annotations and comments."""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field

from app.core.session import DocumentError
from app.routers.documents import get_session, summarize
from app.services import annotations as annsvc

router = APIRouter(prefix="/api/documents/{doc_id}/annotations", tags=["annotations"])


def _guard(fn):
    try:
        return fn()
    except DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class MarkupPayload(BaseModel):
    page: int = Field(ge=0)
    kind: str                              # highlight | underline | strikeout | squiggly
    quads: list[list[float]]               # rects [x0,y0,x1,y1] or 8-point quads
    color: str | None = None
    opacity: float = Field(default=1.0, ge=0.05, le=1.0)
    author: str = ""
    note: str = ""


class NotePayload(BaseModel):
    page: int = Field(ge=0)
    point: list[float]
    contents: str
    author: str = ""
    color: str = "#ffd24d"


class FreeTextPayload(BaseModel):
    page: int = Field(ge=0)
    rect: list[float]
    contents: str
    size: float = Field(default=11.0, gt=0, le=400)
    color: str = "#000000"
    fill: str | None = "#fffde7"
    border: str | None = "#b0a04a"
    align: str = "left"


class UpdatePayload(BaseModel):
    page: int = Field(ge=0)
    xref: int
    contents: str | None = None
    color: str | None = None
    opacity: float | None = Field(default=None, ge=0.05, le=1.0)
    rect: list[float] | None = None


@router.get("")
def list_annotations(doc_id: str, page: int | None = None):
    session = get_session(doc_id)
    return _guard(lambda: annsvc.list_annotations(session, page))


@router.post("/markup")
def markup(doc_id: str, payload: MarkupPayload = Body(...)):
    session = get_session(doc_id)
    result = _guard(
        lambda: annsvc.add_markup(
            session,
            payload.page,
            payload.kind,
            payload.quads,
            color=payload.color,
            opacity=payload.opacity,
            author=payload.author,
            note=payload.note,
        )
    )
    return {"annotation": result, "document": summarize(session)}


@router.post("/note")
def note(doc_id: str, payload: NotePayload = Body(...)):
    session = get_session(doc_id)
    result = _guard(
        lambda: annsvc.add_note(
            session, payload.page, payload.point, payload.contents,
            author=payload.author, color=payload.color,
        )
    )
    return {"annotation": result, "document": summarize(session)}


@router.post("/free-text")
def free_text(doc_id: str, payload: FreeTextPayload = Body(...)):
    session = get_session(doc_id)
    result = _guard(
        lambda: annsvc.add_free_text(
            session, payload.page, payload.rect, payload.contents,
            size=payload.size, color=payload.color, fill=payload.fill,
            border=payload.border, align=payload.align,
        )
    )
    return {"annotation": result, "document": summarize(session)}


@router.put("")
def update(doc_id: str, payload: UpdatePayload = Body(...)):
    session = get_session(doc_id)
    result = _guard(
        lambda: annsvc.update_annotation(
            session, payload.page, payload.xref,
            contents=payload.contents, color=payload.color,
            opacity=payload.opacity, rect=payload.rect,
        )
    )
    return {"annotation": result, "document": summarize(session)}


@router.delete("/{page}/{xref}")
def delete(doc_id: str, page: int, xref: int):
    session = get_session(doc_id)
    result = _guard(lambda: annsvc.delete_annotation(session, page, xref))
    return {**result, "document": summarize(session)}
