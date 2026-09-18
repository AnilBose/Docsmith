"""Offline spell checking.

``pyspellchecker`` ships its frequency dictionaries inside the package, so this
works with no network access and sends nothing anywhere. Results are reported
with page-space rectangles so the UI can underline them in place.
"""
from __future__ import annotations

import re
from functools import lru_cache
from typing import Sequence

from app.core.session import DocumentError, DocumentSession
from app.services.text import build_index

_WORD = re.compile(r"[A-Za-z][A-Za-z'’\-]*[A-Za-z]|[A-Za-z]")

SUPPORTED = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "pt": "Portuguese", "it": "Italian", "nl": "Dutch", "ru": "Russian",
    "ar": "Arabic", "eu": "Basque", "lv": "Latvian",
}

# Tokens we never flag: acronyms, numbers, code-ish and URL-ish strings.
_SKIP = re.compile(r"^(?:[A-Z0-9]{2,}|.*\d.*|.*[_/@].*)$")


@lru_cache(maxsize=8)
def _checker(language: str):
    try:
        from spellchecker import SpellChecker
    except Exception as exc:  # pragma: no cover
        raise DocumentError("pyspellchecker is not installed: {0}".format(exc)) from exc
    if language not in SUPPORTED:
        raise DocumentError("No dictionary for '{0}'.".format(language))
    return SpellChecker(language=language, distance=2)


def check(
    session: DocumentSession,
    *,
    pages: Sequence[int] | None = None,
    language: str = "en",
    custom_words: Sequence[str] = (),
    max_suggestions: int = 5,
    limit: int = 500,
) -> list[dict]:
    checker = _checker(language)
    ignore = {w.lower() for w in custom_words}
    targets = list(pages) if pages is not None else list(range(session.doc.page_count))
    findings: list[dict] = []
    cache: dict[str, list[str]] = {}

    for pno in targets:
        index = build_index(session, pno)
        text = index.text
        for match in _WORD.finditer(text):
            word = match.group(0)
            if len(word) < 3 or _SKIP.match(word) or word.lower() in ignore:
                continue
            normalised = word.replace("’", "'").lower()
            if not checker.unknown([normalised]):
                continue

            if normalised not in cache:
                candidates = checker.candidates(normalised) or set()
                # Rank by corpus frequency so the likeliest correction leads.
                # ``word_frequency[word]`` is the raw count and is available on
                # every pyspellchecker release; ``word_probability`` is not.
                ranked = sorted(
                    candidates, key=lambda c: -checker.word_frequency[c]
                )[:max_suggestions]
                cache[normalised] = ranked
            suggestions = cache[normalised]

            span_ids: list[str] = []
            rects = []
            boxes = [
                c.bbox for c in index.chars[match.start():match.end()]
                if c.ch != "\n" and not c.bbox.is_empty
            ]
            if boxes:
                box = boxes[0]
                for extra in boxes[1:]:
                    box |= extra
                rects = [[box.x0, box.y0, box.x1, box.y1]]
            for c in index.chars[match.start():match.end()]:
                if c.span_id not in span_ids and c.ch != "\n":
                    span_ids.append(c.span_id)

            findings.append(
                {
                    "id": "s{0}-{1}".format(pno, match.start()),
                    "page": pno,
                    "word": word,
                    "start": match.start(),
                    "end": match.end(),
                    "rects": rects,
                    "spanIds": span_ids,
                    "suggestions": suggestions,
                    "context": text[max(0, match.start() - 32):match.end() + 32].replace("\n", " "),
                }
            )
            if len(findings) >= limit:
                return findings
    return findings


def languages() -> list[dict]:
    return [{"code": code, "label": label} for code, label in sorted(SUPPORTED.items())]
