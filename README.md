<div align="center">

# Docsmith

**A private, offline document workshop for PDF, Word, Excel and CSV files.**

Edit PDFs without degrading them, and edit `.docx`, `.xlsx` and `.csv` files in
familiar Word and Excel-style editors. Everything runs on your machine, so your
documents never leave it.

![Python](https://img.shields.io/badge/python-3.11%2B-3776AB?logo=python&logoColor=white)
![Node](https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-backend-009688?logo=fastapi&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-frontend-000000?logo=next.js&logoColor=white)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue)

[Features](#features) ·
[Quick start](#quick-start) ·
[How it works](#how-lossless-pdf-editing-works) ·
[Project layout](#project-layout) ·
[Contributing](#contributing) ·
[License](#license)

</div>

---

## Why Docsmith?

Most PDF editors rasterize pages or rebuild them from scratch, which quietly
changes fonts, recompresses images and bloats files. Most online editors also
want your documents on their servers. Docsmith works differently:

- **Lossless.** An edited PDF stays byte-identical to the original except for
  what you changed. Images are reused verbatim, and text is redrawn in the
  document's own embedded fonts.
- **Private.** Both services bind to `127.0.0.1`. There's no telemetry, no CDN
  and no upload to a third party, and nothing touches the disk until you
  download it.
- **More than PDF.** Word documents and spreadsheets open in their own editors
  as tabs next to your PDFs, and you can convert between formats in either
  direction.
- **Free.** Every dependency is open source, and none of them calls an external
  service.

There's deliberately no "save" step: open a file, edit it, download the result.

---

## Features

### PDF

| Area | What you can do |
|---|---|
| **Viewing** | Continuous, single-page and two-page layouts · fit-page / fit-width / 100% zoom · Ctrl+scroll zoom · reading and night modes · thumbnail navigator |
| **Text** | Edit existing text in place, add and delete text · font, size, weight, italic, underline, strikethrough, colour, alignment, line and character spacing · change case · find and replace with regex, whole-word and case options · offline spell check in eleven languages |
| **Paragraphs** | Double-click a paragraph to edit it as rich text in the document's own fonts, Word-style: Enter for a new paragraph or bullet, Shift+Enter for a line break, Ctrl+B/I/U to style. The paragraph re-wraps at the same margin, and the content after it reflows down the page, onto later pages, and onto new pages if needed. Headings stay with what follows them, and headers, footers and backgrounds stay in place. |
| **Images** | Add, replace, delete, move, resize, crop, rotate, flip, set transparency, extract, compress |
| **Pages** | Add, delete, duplicate, drag to reorder, rotate · extract, insert, replace, split, merge · move pages between open documents · cover and end pages · page numbers (arabic, roman, alphabetic, with templates such as `Page {n} of {total}`) |
| **Comments** | Highlight, underline, strikethrough, sticky notes and text boxes, saved as standard PDF annotations |
| **Redaction** | Drag to mark areas, or search by phrase or pattern (email, phone, SSN, payment card with Luhn check, IBAN, IP address, dates, Aadhaar). Text and image data are *deleted from the file*, and Docsmith checks that the removed strings no longer appear anywhere in it. |
| **Security** | AES-256 (or AES-128 / RC4-128) encryption · separate open and owner passwords · permission flags · password removal · metadata and script sanitization |

### Word documents (`.docx`)

A Word-style editor on an A4 page, with paragraph styles, fonts and sizes,
bold/italic/underline/strike, colour and highlight, alignment, bulleted and
numbered lists, tables, images, links and a live word count. You can save back
to `.docx` or HTML, or convert to PDF and keep editing it in the PDF view.

### Spreadsheets (`.xlsx`, `.csv`, `.tsv`)

An Excel-style editor built on Fortune-sheet, with a formula bar, formulas,
sheet tabs, number formats, fills, borders, merges and filters. The status bar
shows the Sum, Count and Average of the selection. You can save as `.xlsx` or
CSV, or convert the active sheet to PDF.

Word and spreadsheet files are edited entirely in the browser. They reach the
local server only when you convert them to PDF.

### Conversion

| To PDF from | From PDF to |
|---|---|
| Word, Excel, PowerPoint, images, HTML, text | Word, Excel, PowerPoint, JPG/PNG, TXT, HTML, CSV |

Converting a PDF to Word, Excel or CSV opens the result straight in the
matching editor.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+O` | Open |
| `Ctrl+S` | Download |
| `Ctrl+F` | Find |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl` `+` / `-` / `0` | Zoom in / out / fit page |
| `PageUp` / `PageDown` | Previous / next page |
| `Ctrl+Enter` / `Esc` | Apply / cancel a paragraph edit |

---

## Quick start

### Prerequisites

| Component | Needed for | Notes |
|---|---|---|
| Python 3.11+ | everything | 3.13 tested |
| Node.js 18+ | the interface | 20 tested |
| LibreOffice | PowerPoint, `.doc`, `.xls`, `.odt` → PDF | Optional. Install it from [libreoffice.org](https://www.libreoffice.org/), or set `PDFE_SOFFICE` to the path of the `soffice` binary. |

The Word and spreadsheet editors, and conversion between them and PDF, work
without LibreOffice.

### Run

```bash
git clone <your-fork-url> docsmith
cd docsmith
```

**Windows**

```powershell
.\start.ps1
```

**macOS / Linux**

```bash
./start.sh
```

The first run creates a Python virtualenv, installs the dependencies and builds
the frontend. After that, Docsmith starts in a few seconds.

- Interface: <http://127.0.0.1:3000>
- API docs: <http://127.0.0.1:8420/api/docs>

| Option | PowerShell | Bash |
|---|---|---|
| Hot-reloading frontend | `-Dev` | `--dev` |
| Reuse the last build | `-SkipBuild` | |
| Don't open a browser | `-NoBrowser` | |

---

## How lossless PDF editing works

Docsmith doesn't rasterize pages. It edits the PDF's structure directly.

**Text.** Pages are read character by character, so every glyph has its own
bounding box, origin, font, size, colour and style flags. To change a run of
text, Docsmith places a redaction annotation over exactly those glyph boxes and
applies it with image and vector-art removal switched *off*. That deletes the
old glyphs from the content stream and leaves every other object alone. The
replacement text is drawn with the font program extracted from the document,
with its baseline exactly where the original baseline was.

**Paragraph reflow.** Content that moves to make room for an edited paragraph
is moved, not re-rendered: text stays text and images are not re-encoded. An
unedited paragraph re-wraps at exactly the same words. If a subset font is
missing a character you typed, Docsmith takes it from another face of the same
family, or uses a similar font and shows a warning.

**Images.** Moving or resizing an image places the existing XObject again by
reference, so the compressed stream is reused byte for byte. Only operations
that really change pixels (crop, rotate, flip, transparency) re-encode the
image, and they use lossless PNG unless you choose JPEG.

**Pages.** Reorder, split, merge, extract and rotate all copy pages by object
reference. No page is ever re-rendered.

**Fonts.** Every embeddable font program in the document is extracted and
registered again, so new text is drawn in *the document's own font*, not a
lookalike. Fonts that can't be embedded again (bitmap Type 3, bare CFF subsets)
fall back to a base-14 face with matching metrics, chosen from the font's name.

The test suite checks this directly. After a heading is edited, the image
streams on the page are compared byte for byte with their state before the
edit, and they must be identical.

> The one deliberate exception is **Compress Images**, which is lossy. The
> dialog says so, and undo restores the originals.

---

## Security model

Documents can contain sensitive material, so the defaults are conservative:

- Both services bind to `127.0.0.1`, and CORS accepts only the local frontend
  origin.
- Documents live in memory with an idle timeout and are never written to disk.
  Downloads stream straight from memory.
- When a file is opened, `/OpenAction`, `/AA` and document-level JavaScript are
  removed. These are the classic PDF malware carriers, and editing doesn't need
  them.
- The pdf.js worker is served locally. No external script, font or stylesheet
  is loaded at runtime.
- HTML→PDF conversion strips scripts, frames and event handlers, and doesn't
  fetch remote resources.
- LibreOffice runs headless, with a throwaway profile and a hard timeout.
- Uploads are capped in size (256 MB by default), and images are guarded
  against decompression bombs.
- Server errors are logged locally and reported to the client as a generic
  message.

**Known limitations**

- **PDF permission flags are advisory.** Conforming readers honour them, but
  they aren't enforced cryptographically. Only the open password actually
  restricts access, and the UI says so.
- **Certificate (public-key) encryption isn't implemented.** Neither
  qpdf/pikepdf nor PyMuPDF supports it, so Docsmith offers password-based
  AES-256 instead. `GET /api/security/certificate-support` reports this
  explicitly.
- **Word import** uses mammoth, so text colour, headers, footers and page setup
  in the original `.docx` aren't carried over.
- **Spreadsheet import** doesn't bring in frozen panes or charts.

---

## Project layout

```
backend/                    Python · FastAPI · PyMuPDF
  app/
    config.py               settings, limits, LibreOffice discovery
    core/session.py         in-memory documents, undo/redo snapshots
    services/
      fonts.py              embedded-font extraction and CSS generation
      text.py               character indexing, lossless editing, search
      paragraphs.py         paragraph detection: soft wraps, bullets, pitch, margins
      reflow.py             paragraph editing with Word-style reflow across pages
      images.py             image objects and pixel transforms
      pages.py              page algebra, numbering, cover pages
      annotations.py        markup and comments
      redaction.py          detection, marking, permanent removal
      security.py           encryption, permissions, sanitization
      convert.py            conversion to and from PDF
      spell.py              offline spell check
    routers/                HTTP layer
  tests/
frontend/                   TypeScript · Next.js · Tailwind · pdf.js
  app/                      Next.js app router
  components/               ribbon, viewer, overlays, panels, dialogs
  components/office/        Word-style (TipTap) and Excel-style (Fortune-sheet) editors
  lib/                      typed API client, state stores, pdf.js loader
  scripts/ui-smoke.mjs      end-to-end UI checks in Chromium
start.ps1 / start.sh        one-command launchers
```

---

## Testing

| Suite | Scope | Checks |
|---|---|---|
| `backend/tests/test_pipeline.py` | service layer, no server needed | 92 |
| `backend/tests/test_paragraphs.py` | paragraph editing and reflow | 51 |
| `backend/tests/test_api.py` | HTTP layer, against a running server | 57 |
| `frontend/scripts/ui-smoke.mjs` | the real UI, driven in Chromium | 30 |

```bash
# Service layer
cd backend
.venv/Scripts/python.exe tests/test_pipeline.py      # Unix: .venv/bin/python
.venv/Scripts/python.exe tests/test_paragraphs.py

# HTTP layer: start the app first, then point the suite at it
.venv/Scripts/python.exe tests/test_api.py http://127.0.0.1:3000

# Browser
cd frontend
npm install --no-save playwright && npx playwright install chromium
node scripts/ui-smoke.mjs http://127.0.0.1:3000 scripts/sample.pdf
```

The browser test needs a sample PDF, which `build_sample()` in
`tests/test_pipeline.py` can generate.

---

## Configuration

All settings are environment variables read by the backend.

| Variable | Default | Purpose |
|---|---|---|
| `PDFE_HOST` | `127.0.0.1` | API bind address |
| `PDFE_PORT` | `8420` | API port |
| `PDFE_ALLOWED_ORIGINS` | `http://localhost:3000` | CORS allowlist |
| `PDFE_MAX_UPLOAD_MB` | `256` | Upload size cap |
| `PDFE_MAX_DOCS` | `24` | Maximum number of open documents |
| `PDFE_SESSION_TTL` | `21600` | Idle document lifetime, in seconds |
| `PDFE_STRIP_ACTIVE_CONTENT` | `true` | Remove JavaScript and auto-actions on open |
| `PDFE_SOFFICE` | auto-detected | Path to the LibreOffice binary |
| `PDFE_SCRATCH` | system temp | Directory for short-lived conversion scratch files |

---

## Contributing

Contributions are welcome: bug reports, fixes, new features and documentation.

1. **Open an issue first** for anything larger than a small fix, so the
   approach can be agreed before you write the code.
2. **Fork** the repository and create a branch from `main`.
3. **Keep the fidelity guarantee.** A change to how PDFs are modified must not
   re-render pages or re-encode content that you didn't edit. Add a test that
   proves it.
4. **Run the test suites** above, and make sure they pass before you open a
   pull request.
5. **Match the existing style:** type hints in Python, strict TypeScript, and
   small focused modules in `services/` and `components/`.
6. **Never add network calls.** Docsmith must keep working with the network
   cable unplugged.

When reporting a bug, include your OS, your Python and Node versions, and if
possible a PDF that reproduces it, with any sensitive content removed.

---

## License

Docsmith is released under the **GNU Affero General Public License v3.0**.

The engine that makes lossless editing possible, [PyMuPDF](https://github.com/pymupdf/PyMuPDF),
is AGPL-3.0, so if you distribute Docsmith or offer it to others over a network,
you must make the corresponding source available under the AGPL too. Running it
privately on your own machine has no such obligation.

Most other dependencies are permissively licensed (MIT, BSD, MPL). The
exception is [pdf2docx](https://github.com/ArtifexSoftware/pdf2docx), which is
used only for PDF→Word and is GPL-3.0.

## Acknowledgements

Built on [PyMuPDF](https://pymupdf.readthedocs.io/),
[pikepdf](https://github.com/pikepdf/pikepdf),
[FastAPI](https://fastapi.tiangolo.com/),
[Next.js](https://nextjs.org/),
[pdf.js](https://mozilla.github.io/pdf.js/),
[TipTap](https://tiptap.dev/),
[Fortune-sheet](https://github.com/ruilisi/fortune-sheet),
[mammoth](https://github.com/mwilliamson/mammoth.js) and
[docx](https://github.com/dolanmiu/docx).
