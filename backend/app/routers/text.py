"""Text layout, editing, search/replace, case changes and spell checking."""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field

from app.core.session import DocumentError
from app.routers.documents import get_session, summarize
from app.services import spell as spellsvc
from app.services import text as textsvc

router = APIRouter(prefix="/api/documents/{doc_id}/text", tags=["text"])


class StylePayload(BaseModel):
    font: str | None = None
    size: float | None = Field(default=None, gt=0, le=1600)
    color: str | None = None
    bold: bool | None = None
    italic: bool | None = None
    underline: bool | None = None
    strike: bool | None = None
    align: str | None = None
    lineHeight: float | None = Field(default=None, gt=0, le=10)
    letterSpacing: float | None = Field(default=None, ge=-20, le=200)
    background: str | None = None


class EditPayload(BaseModel):
    page: int = Field(ge=0)
    action: str = "replace"           # replace | delete | insert
    spanId: str | None = None
    spanIds: list[str] | None = None
    rect: list[float] | None = None
    text: str = ""
    style: StylePayload | None = None


class EditBatch(BaseModel):
    edits: list[EditPayload]


class SearchPayload(BaseModel):
    query: str
    regex: bool = False
    caseSensitive: bool = False
    wholeWord: bool = False
    pages: list[int] | None = None


class ReplacePayload(SearchPayload):
    replacement: str = ""
    matchIds: list[str] | None = None


class SpellPayload(BaseModel):
    pages: list[int] | None = None
    language: str = "en"
    customWords: list[str] = Field(default_factory=list)


def _guard(fn):
    try:
        return fn()
    except DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/layout/{page}")
def layout(doc_id: str, page: int):
    session = get_session(doc_id)
    return _guard(lambda: textsvc.serialize_layout(session, page))


@router.post("/edit")
def edit(doc_id: str, payload: EditBatch = Body(...)):
    session = get_session(doc_id)
    edits = [e.model_dump(exclude_none=False) for e in payload.edits]
    for e in edits:
        if e.get("style"):
            e["style"] = {k: v for k, v in e["style"].items() if v is not None}
    result = _guard(lambda: textsvc.apply_edits(session, edits))
    return {**result, "document": summarize(session)}


@router.post("/search")
def search(doc_id: str, payload: SearchPayload = Body(...)):
    session = get_session(doc_id)
    hits = _guard(
        lambda: textsvc.search(
            session,
            payload.query,
            regex=payload.regex,
            case=payload.caseSensitive,
            whole_word=payload.wholeWord,
            pages=payload.pages,
        )
    )
    return {"count": len(hits), "matches": hits}


@router.post("/replace")
def replace(doc_id: str, payload: ReplacePayload = Body(...)):
    session = get_session(doc_id)
    result = _guard(
        lambda: textsvc.replace(
            session,
            payload.query,
            payload.replacement,
            regex=payload.regex,
            case=payload.caseSensitive,
            whole_word=payload.wholeWord,
            pages=payload.pages,
            match_ids=payload.matchIds,
        )
    )
    return {**result, "document": summarize(session)}


@router.post("/case")
def change_case(doc_id: str, payload: dict = Body(...)):
    """Apply a capitalisation change to a set of existing text runs."""
    session = get_session(doc_id)
    mode = payload.get("mode", "upper")
    page = int(payload.get("page", 0))
    span_ids = payload.get("spanIds") or []
    if not span_ids:
        raise HTTPException(status_code=400, detail="Select some text first.")

    index = _guard(lambda: textsvc.build_index(session, page))
    edits = []
    for sid in span_ids:
        span = index.spans.get(sid)
        if span is None:
            continue
        edits.append(
            {
                "page": page,
                "action": "replace",
                "spanIds": [sid],
                "text": textsvc.change_case(span.text, mode),
                "style": None,
            }
        )
    result = _guard(lambda: textsvc.apply_edits(session, edits))
    return {**result, "document": summarize(session)}


@router.get("/extract")
def extract(doc_id: str, pages: str | None = None):
    session = get_session(doc_id)
    selection = None
    if pages:
        from app.services.pages import parse_page_spec

        selection = _guard(lambda: parse_page_spec(pages, session.doc.page_count))
    return {"text": textsvc.extract_text(session, selection)}


@router.post("/spell")
def spell(doc_id: str, payload: SpellPayload = Body(...)):
    session = get_session(doc_id)
    findings = _guard(
        lambda: spellsvc.check(
            session,
            pages=payload.pages,
            language=payload.language,
            custom_words=payload.customWords,
        )
    )
    return {"count": len(findings), "issues": findings}


@router.get("/spell/languages")
def spell_languages(doc_id: str):
    return spellsvc.languages()
