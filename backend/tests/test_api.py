"""HTTP-level smoke test.

Exercises the same endpoints the browser calls, against a running server.
Point it at the Next.js proxy to prove the whole path works end to end:

    python tests/test_api.py http://127.0.0.1:3100
"""
from __future__ import annotations

import io
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests.test_pipeline import build_sample  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8420"
PASSES: list[str] = []
FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        PASSES.append(name)
        print("  PASS  {0}".format(name))
    else:
        FAILURES.append("{0} :: {1}".format(name, detail))
        print("  FAIL  {0}  {1}".format(name, detail))


def call(method: str, path: str, body=None, raw=False):
    url = BASE + path
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = response.read()
            if raw:
                return response.status, payload, dict(response.headers)
            return response.status, json.loads(payload or b"null"), dict(response.headers)
    except urllib.error.HTTPError as error:
        payload = error.read()
        if raw:
            return error.code, payload, dict(error.headers)
        try:
            return error.code, json.loads(payload or b"null"), dict(error.headers)
        except Exception:
            return error.code, {"detail": payload[:200].decode("utf-8", "replace")}, {}


def upload(path: str, filename: str, content: bytes, fields: dict[str, str] | None = None):
    boundary = uuid.uuid4().hex
    parts = []
    for key, value in (fields or {}).items():
        parts.append(
            "--{0}\r\nContent-Disposition: form-data; name=\"{1}\"\r\n\r\n{2}\r\n".format(
                boundary, key, value
            ).encode()
        )
    parts.append(
        (
            "--{0}\r\nContent-Disposition: form-data; name=\"file\"; "
            "filename=\"{1}\"\r\nContent-Type: application/pdf\r\n\r\n"
        ).format(boundary, filename).encode()
    )
    parts.append(content)
    parts.append("\r\n--{0}--\r\n".format(boundary).encode())
    payload = b"".join(parts)

    request = urllib.request.Request(
        BASE + path,
        data=payload,
        headers={"Content-Type": "multipart/form-data; boundary=" + boundary},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"null")


def main() -> int:
    print("Target: {0}\n".format(BASE))

    print("[1] Health")
    status, health, _ = call("GET", "/api/health")
    check("health 200", status == 200, str(status))
    check("capabilities present", "capabilities" in (health or {}))

    print("\n[2] Open")
    status, doc = upload("/api/documents/open", "api-sample.pdf", build_sample())
    check("open 200", status == 200, json.dumps(doc)[:200])
    if status != 200:
        return 1
    doc_id = doc["id"]
    check("page count", doc["pageCount"] == 2, str(doc.get("pageCount")))
    check("pages described", len(doc["pages"]) == 2)

    print("\n[3] Fetch bytes")
    status, blob, headers = call("GET", "/api/documents/{0}/file".format(doc_id), raw=True)
    check("file 200", status == 200, str(status))
    check("is a PDF", blob.startswith(b"%PDF"))
    check("version header", "X-Document-Version" in headers or "x-document-version" in headers)

    print("\n[4] Layout")
    status, layout, _ = call("GET", "/api/documents/{0}/text/layout/0".format(doc_id))
    check("layout 200", status == 200)
    spans = layout["spans"]
    check("spans returned", len(spans) >= 6, str(len(spans)))
    title = next((s for s in spans if "Quarterly" in s["text"]), None)
    check("title span", title is not None)
    check("styling exposed", title and title["bold"] and abs(title["size"] - 24) < 1)

    print("\n[5] Edit")
    status, result, _ = call(
        "POST",
        "/api/documents/{0}/text/edit".format(doc_id),
        {
            "edits": [
                {
                    "page": 0,
                    "action": "replace",
                    "spanIds": [title["id"]],
                    "text": "Edited Over HTTP",
                    "style": {"color": "#0b5cd5", "size": 24, "bold": True},
                }
            ]
        },
    )
    check("edit 200", status == 200, json.dumps(result)[:200])
    check("applied 1", result.get("applied") == 1)
    check("version advanced", result["document"]["version"] > doc["version"])
    check("undo now available", result["document"]["canUndo"] is True)

    status, layout2, _ = call("GET", "/api/documents/{0}/text/layout/0".format(doc_id))
    check("edit visible in layout", "Edited Over HTTP" in layout2["text"])

    print("\n[6] Search and replace")
    status, found, _ = call(
        "POST", "/api/documents/{0}/text/search".format(doc_id), {"query": "Revenue"}
    )
    check("search 200", status == 200)
    check("one hit", found["count"] == 1, str(found["count"]))

    status, replaced, _ = call(
        "POST",
        "/api/documents/{0}/text/replace".format(doc_id),
        {"query": "quarter", "replacement": "period"},
    )
    check("replace 200", status == 200)
    check("replaced something", replaced["replaced"] >= 1, str(replaced))

    print("\n[7] Undo / redo")
    status, undone, _ = call("POST", "/api/documents/{0}/undo".format(doc_id))
    check("undo 200", status == 200)
    check("undo changed", undone.get("changed") is True)
    status, redone, _ = call("POST", "/api/documents/{0}/redo".format(doc_id))
    check("redo 200", status == 200)
    check("redo changed", redone.get("changed") is True)

    print("\n[8] Images")
    status, images, _ = call("GET", "/api/documents/{0}/images/0".format(doc_id))
    check("images 200", status == 200)
    check("one image", len(images) == 1, str(len(images)))
    xref = images[0]["xref"]

    status, thumb, _ = call(
        "GET", "/api/documents/{0}/images/0/{1}/thumbnail".format(doc_id, xref), raw=True
    )
    check("image thumbnail", status == 200 and thumb.startswith(b"\x89PNG"))

    status, moved, _ = call(
        "POST",
        "/api/documents/{0}/images/transform".format(doc_id),
        {"page": 0, "xref": xref, "rect": [300, 300, 520, 450]},
    )
    check("image moved", status == 200 and moved["recompressed"] is False, json.dumps(moved)[:160])

    print("\n[9] Pages")
    status, thumb, _ = call(
        "GET", "/api/documents/{0}/pages/0/thumbnail?width=120".format(doc_id), raw=True
    )
    check("page thumbnail", status == 200 and thumb.startswith(b"\x89PNG"))

    status, added, _ = call("POST", "/api/documents/{0}/pages/blank".format(doc_id), {"at": 1})
    check("blank page added", status == 200 and added["document"]["pageCount"] == 3,
          str(added.get("document", {}).get("pageCount")))

    status, rotated, _ = call(
        "POST", "/api/documents/{0}/pages/rotate".format(doc_id), {"pages": [0], "angle": 90}
    )
    check("rotate 200", status == 200)
    check("rotation recorded", rotated["document"]["pages"][0]["rotation"] == 90,
          str(rotated["document"]["pages"][0]["rotation"]))

    status, reordered, _ = call(
        "POST", "/api/documents/{0}/pages/reorder".format(doc_id), {"order": [2, 1, 0]}
    )
    check("reorder 200", status == 200)

    status, bad, _ = call(
        "POST", "/api/documents/{0}/pages/reorder".format(doc_id), {"order": [0, 0, 0]}
    )
    check("invalid reorder rejected", bad_is_error(status, bad), "{0} {1}".format(status, bad))

    print("\n[10] Annotations")
    status, found, _ = call(
        "POST", "/api/documents/{0}/text/search".format(doc_id), {"query": "Revenue"}
    )
    if found.get("count"):
        hit = found["matches"][0]
        status, markup, _ = call(
            "POST",
            "/api/documents/{0}/annotations/markup".format(doc_id),
            {"page": hit["page"], "kind": "highlight", "quads": hit["rects"]},
        )
        check("highlight 200", status == 200, json.dumps(markup)[:160])
        status, listed, _ = call("GET", "/api/documents/{0}/annotations".format(doc_id))
        check("annotation listed", status == 200 and len(listed) >= 1)
    else:
        check("highlight 200", False, "search returned nothing to highlight")

    print("\n[11] Redaction")
    status, detected, _ = call(
        "POST",
        "/api/documents/{0}/redaction/detect".format(doc_id),
        {"kinds": ["email", "ssn"]},
    )
    check("detect 200", status == 200)
    check("found sensitive data", detected["count"] >= 2, str(detected.get("count")))

    if detected.get("count"):
        marks = [{"page": f["page"], "rects": f["rects"]} for f in detected["findings"]]
        status, marked, _ = call(
            "POST", "/api/documents/{0}/redaction/mark".format(doc_id), {"marks": marks}
        )
        check("mark 200", status == 200 and marked["marked"] >= 2, str(marked))

        status, applied, _ = call("POST", "/api/documents/{0}/redaction/apply".format(doc_id), {})
        check("apply 200", status == 200, json.dumps(applied)[:160])

        status, verdict, _ = call(
            "POST",
            "/api/documents/{0}/redaction/verify".format(doc_id),
            {"strings": ["jane.doe@example.com", "123-45-6789"]},
        )
        check("verified clean", verdict.get("clean") is True, json.dumps(verdict)[:200])

        status, blob, _ = call("GET", "/api/documents/{0}/file".format(doc_id), raw=True)
        check("secret absent from bytes", b"jane.doe@example.com" not in blob)

    print("\n[12] Export")
    # A multi-page image export comes back as a ZIP, so accept either magic.
    for fmt, sniff in (
        ("txt", (b"",)),
        ("html", (b"<",)),
        ("png", (b"\x89PNG", b"PK")),
        ("docx", (b"PK",)),
        ("xlsx", (b"PK",)),
    ):
        status, blob, headers = call(
            "GET", "/api/convert/{0}/export?format={1}".format(doc_id, fmt), raw=True
        )
        ok = (
            status == 200
            and len(blob) > 64
            and any(not magic or blob.startswith(magic) for magic in sniff)
        )
        check("export {0}".format(fmt), ok, "{0} {1} bytes".format(status, len(blob)))

    print("\n[13] Protect")
    status, blob, _ = call(
        "POST",
        "/api/documents/{0}/protect".format(doc_id),
        {
            "openPassword": "correct horse",
            "ownerPassword": "battery staple",
            "algorithm": "aes-256",
            "permissions": {"copyContent": False, "printDocument": False},
        },
        raw=True,
    )
    check("protect 200", status == 200, str(status))
    check("encrypted PDF returned", blob.startswith(b"%PDF") and b"/Encrypt" in blob)

    status, rejected, _ = call(
        "POST",
        "/api/documents/{0}/protect".format(doc_id),
        {"openPassword": "abc", "ownerPassword": "", "algorithm": "aes-256",
         "permissions": {}},
    )
    check("weak password rejected", rejected_is_error(status, rejected), str(status))

    print("\n[14] Download and close")
    status, blob, headers = call("GET", "/api/documents/{0}/download".format(doc_id), raw=True)
    check("download 200", status == 200 and blob.startswith(b"%PDF"), str(status))
    disposition = headers.get("Content-Disposition", headers.get("content-disposition", ""))
    check("attachment disposition", "attachment" in disposition, disposition)

    status, closed, _ = call("DELETE", "/api/documents/{0}".format(doc_id))
    check("close 200", status == 200)
    status, gone, _ = call("GET", "/api/documents/{0}".format(doc_id))
    check("closed doc is gone", status == 404, str(status))

    print("\n[15] Error handling")
    status, missing, _ = call("GET", "/api/documents/does-not-exist")
    check("unknown document -> 404", status == 404, str(status))
    status, badpage, _ = call("GET", "/api/documents/does-not-exist/text/layout/9")
    check("unknown doc layout -> 404", status == 404, str(status))

    print("\n" + "=" * 62)
    print("PASSED {0}   FAILED {1}".format(len(PASSES), len(FAILURES)))
    if FAILURES:
        print("-" * 62)
        for failure in FAILURES:
            print("  " + failure)
    print("=" * 62)
    return 1 if FAILURES else 0


def bad_is_error(status, body) -> bool:
    return status >= 400


def rejected_is_error(status, body) -> bool:
    return status >= 400


if __name__ == "__main__":
    raise SystemExit(main())
