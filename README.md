# Local PDF Editor

An offline PDF editor with an Acrobat-style interface. A Python/FastAPI service
does the PDF work; a Next.js app provides the UI. Nothing is uploaded, nothing
is saved to disk unless you download it, and no request ever leaves the machine.

There is no "save" step by design: you open a file, edit it, and download the
result.

---

## Running it

**Windows**

```powershell
.\start.ps1
```

**macOS / Linux**

```bash
./start.sh
```

The first run creates a virtualenv, installs dependencies and builds the
frontend; after that it starts in a few seconds. The editor opens at
<http://127.0.0.1:3000>, and the API documentation is at
<http://127.0.0.1:8420/api/docs>.

Add `-Dev` / `--dev` for a hot-reloading frontend.

### Requirements

| Component | Needed for | Notes |
|---|---|---|
| Python 3.11+ | everything | 3.13 tested |
| Node 18+ | the interface | 20 tested |
| LibreOffice | Word/Excel/PowerPoint **→** PDF | optional; install from libreoffice.org, or set `PDFE_SOFFICE` to the `soffice` binary |

Everything else installs from PyPI and npm. Export *from* PDF to Office formats
works without LibreOffice.

---

## How the fidelity guarantee works

The requirement was that an edited PDF stay identical to the original except
for what you changed. That rules out the usual shortcut of rasterizing pages,
so the editor works structurally instead:

**Text.** Pages are read at character granularity, so every glyph carries its
own bounding box, origin, font, size, colour and style flags. To change a run
of text, a redaction annotation is placed over exactly those glyph boxes and
applied with image and vector-art removal switched *off* — that deletes the old
glyphs from the content stream and leaves every other object untouched. The
replacement is then drawn with the font program extracted from the document
itself, positioned so its baseline lands where the original baseline was.

The test suite asserts this directly: after editing a heading, the image
streams on the page are compared byte-for-byte against their pre-edit state and
must be identical.

**Images.** Moving or resizing an image re-places the existing XObject by
reference, so the compressed stream is reused verbatim — a move costs zero
quality. Only operations that genuinely change pixels (crop, rotate, flip,
transparency) decode and re-encode, and those go out as lossless PNG unless you
explicitly ask for JPEG.

**Pages.** Reorder, split, merge, extract and rotate all copy pages by object
reference. No page is ever re-rendered.

**The one exception** is Compress Images, which is deliberately lossy. It says
so in the dialog, and undo restores the originals.

### Fonts

Every embeddable font program in the document is extracted and re-registered,
so retyped text is drawn with *the document's own font*, not a lookalike.
Fonts that cannot be re-embedded (bitmap Type 3, bare CFF subsets) fall back to
a metric-compatible base-14 face chosen from the font's own name; the font
picker marks which fonts came from the file.

---

## Features

**Viewing** — continuous, single-page and two-page layouts; zoom with fit-page,
fit-width and 100% presets; Ctrl+scroll zoom; page navigation; normal, reading
and night modes; thumbnail navigator.

**Text** — edit existing text in place, add text, delete text; change font,
size, weight, italic, underline, strikethrough, colour, alignment, line spacing
and character spacing; resize text boxes; change capitalization; find and
replace with regex, whole-word and case options; offline spell check with
suggestions in eleven languages.

**Images** — add, replace, delete, move, resize, crop, rotate, flip, adjust
transparency, extract to file, and compress.

**Pages** — add blank pages, delete, duplicate, reorder by drag, rotate,
extract to a new document, insert pages from another PDF, replace pages, split,
merge, move pages between open documents, add cover and end pages, and add page
numbers (arabic, roman or alphabetic, with templates like `Page {n} of {total}`).

**Comments** — highlight, underline, strikethrough, sticky notes and text
boxes, all as real PDF annotation objects that any reader can see.

**Conversion** — *to* PDF from Word, Excel, PowerPoint, images, HTML and text;
*from* PDF to Word, Excel, PowerPoint, JPG/PNG, TXT, HTML and CSV.

**Security** — AES-256 (or AES-128/RC4-128) encryption with an open password
and a separate owner password; permission flags for printing, copying, editing,
commenting, form filling, assembly and accessibility; password removal;
metadata and script sanitization.

**Redaction** — mark areas by dragging, or find content to redact by phrase or
by pattern (email, phone, SSN, payment card with Luhn validation, IBAN, IP
address, dates, Aadhaar). Applying a redaction rewrites the page content
streams so the text and image data are *deleted from the file*, then verifies
that the removed strings no longer appear anywhere in it.

### Keyboard

| | |
|---|---|
| `Ctrl+O` | Open |
| `Ctrl+S` | Download |
| `Ctrl+F` | Find |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl` `+` / `-` / `0` | Zoom in / out / fit page |
| `PageUp` / `PageDown` | Previous / next page |
| `Ctrl+scroll` | Zoom |

---

## Security posture

This handles documents that may contain sensitive material, so the defaults are
conservative:

- Both services bind to `127.0.0.1`. Neither is reachable from the network.
- CORS accepts only the local frontend origin.
- Documents live in memory with a TTL and are never written to disk. Downloads
  stream straight from memory.
- On open, `/OpenAction`, `/AA` and document-level JavaScript are stripped —
  the classic PDF malware carriers, and unnecessary for editing.
- The pdf.js worker is served from `/public`, not a CDN. No external script,
  font or stylesheet is loaded at runtime.
- HTML→PDF strips scripts, frames and event handlers, and refuses to fetch
  remote resources, so a hostile document cannot turn a conversion into an
  outbound request.
- LibreOffice runs headless with a throwaway profile and a hard timeout.
- Uploads are size-capped (256 MB default) and images are guarded against
  decompression bombs.
- Server errors are logged locally and returned to the client as a generic
  message.

### Two honest caveats

**PDF permission flags are advisory.** They are stored inside the encrypted
document and honoured by conforming readers, but they are not enforced
cryptographically. Only the open password actually restricts access to the
content. The UI says this where you set them rather than implying otherwise.

**Certificate (public-key) encryption is not implemented.** It needs a PKCS#7
recipient list, which neither qpdf/pikepdf nor PyMuPDF provides. Password-based
AES-256 is offered instead and is the stronger choice unless you specifically
need per-recipient keys. `GET /api/security/certificate-support` reports this
rather than failing silently.

---

## Layout

```
backend/
  app/
    config.py              settings, limits, LibreOffice discovery
    core/session.py        in-memory documents, undo/redo snapshots
    services/
      fonts.py             embedded-font extraction and CSS generation
      text.py              character indexing, lossless editing, search
      images.py            image objects and pixel transforms
      pages.py             page algebra, numbering, cover pages
      annotations.py       markup and comments
      redaction.py         detection, marking, permanent removal
      security.py          encryption, permissions, sanitization
      convert.py           conversion in and out of PDF
      spell.py             offline spell check
    routers/               HTTP layer
  tests/
    test_pipeline.py       92 checks against the services directly
    test_api.py            57 checks against a running server
frontend/
  app/                     Next.js app router
  components/              ribbon, viewer, overlays, panels, dialogs
  lib/                     typed API client, state store, pdf.js loader
  scripts/ui-smoke.mjs     30 checks driving the real UI in Chromium
```

---

## Tests

```bash
# Service layer — no server needed
cd backend && .venv/Scripts/python.exe tests/test_pipeline.py

# HTTP layer — start the app first, then point at either port
.venv/Scripts/python.exe tests/test_api.py http://127.0.0.1:3000

# Browser — drives the real UI end to end
cd frontend && node scripts/ui-smoke.mjs http://127.0.0.1:3000 scripts/sample.pdf
```

On Unix use `.venv/bin/python`. The browser test needs
`npm install --no-save playwright && npx playwright install chromium`, and a
sample PDF, which `tests/test_pipeline.py:build_sample()` can generate.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PDFE_HOST` | `127.0.0.1` | API bind address |
| `PDFE_PORT` | `8420` | API port |
| `PDFE_ALLOWED_ORIGINS` | localhost:3000 | CORS allowlist |
| `PDFE_MAX_UPLOAD_MB` | `256` | Upload size cap |
| `PDFE_MAX_DOCS` | `24` | Concurrent open documents |
| `PDFE_SESSION_TTL` | `21600` | Idle document lifetime, seconds |
| `PDFE_STRIP_ACTIVE_CONTENT` | `true` | Remove JavaScript and auto-actions on open |
| `PDFE_SOFFICE` | auto-detected | Path to the LibreOffice binary |

---

## Licensing

The engine that makes lossless editing possible, **PyMuPDF**, is **AGPL-3.0**.
Running it privately on your own machine is fine. If you distribute this
application or offer it to others over a network, the AGPL requires you to
offer the corresponding source under the AGPL as well. Everything else is
permissively licensed (MIT/BSD/MPL) except **pdf2docx**, used only for
PDF→Word, which is GPL-3.0.

No component is paid, and none calls out to a third-party service.
