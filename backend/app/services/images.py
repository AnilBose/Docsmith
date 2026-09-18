"""Image objects: list, move, resize, crop, rotate, flip, replace, extract.

Geometry-only changes (move / resize) re-place the *existing* XObject by xref,
so the compressed image stream is reused untouched -- a move costs zero
quality. Pixel changes (crop / rotate / flip / opacity / compress) round-trip
through Pillow and are re-embedded as lossless PNG unless the caller explicitly
asks for JPEG compression.
"""
from __future__ import annotations

import io
import math
from dataclasses import dataclass

import fitz
from PIL import Image, ImageEnhance

from app.core.session import DocumentError, DocumentSession

_MAX_PIXELS = 80_000_000          # guard against decompression bombs
Image.MAX_IMAGE_PIXELS = _MAX_PIXELS


@dataclass
class ImageRef:
    xref: int
    page: int
    rect: fitz.Rect
    width: int
    height: int
    colorspace: str
    bpc: int
    ext: str
    smask: int
    size: int


def _page(session: DocumentSession, pno: int) -> fitz.Page:
    if pno < 0 or pno >= session.doc.page_count:
        raise DocumentError("Page {0} is out of range.".format(pno + 1))
    return session.doc[pno]


def _safe_rects(page: fitz.Page, xref: int) -> list[fitz.Rect]:
    """Placement rectangles for an image, or ``[]`` if the xref is unusable.

    Applying a redaction can leave a resource entry pointing at a stream that
    is no longer decodable. Those orphans must never reach the UI, so any
    failure here means "this image is not really on the page".
    """
    try:
        rects = page.get_image_rects(xref)
    except Exception:
        return []
    return [fitz.Rect(r) for r in rects if not fitz.Rect(r).is_empty]


def list_images(session: DocumentSession, pno: int) -> list[dict]:
    page = _page(session, pno)
    out: list[dict] = []
    for info in page.get_images(full=True):
        xref, smask, width, height, bpc, colorspace, _alt, name, _filt = info[:9]
        rects = _safe_rects(page, xref)
        if not rects:
            continue        # orphaned resource entry, not a visible image
        for occurrence, rect in enumerate(rects):
            out.append(
                {
                    "id": "p{0}x{1}i{2}".format(pno, xref, occurrence),
                    "xref": xref,
                    "page": pno,
                    "occurrence": occurrence,
                    "name": name,
                    "bbox": [rect.x0, rect.y0, rect.x1, rect.y1],
                    "width": width,
                    "height": height,
                    "bpc": bpc,
                    "colorspace": colorspace,
                    "hasAlpha": bool(smask),
                    "dpiX": round(width / max(rect.width / 72.0, 1e-6)) if rect.width else 0,
                    "dpiY": round(height / max(rect.height / 72.0, 1e-6)) if rect.height else 0,
                }
            )
    return out


def _find(session: DocumentSession, pno: int, xref: int, occurrence: int = 0) -> fitz.Rect:
    page = _page(session, pno)
    rects = _safe_rects(page, xref)
    if not rects:
        raise DocumentError(
            "That image is no longer on page {0}; reload the page.".format(pno + 1)
        )
    if occurrence >= len(rects):
        occurrence = 0
    return rects[occurrence]


def extract(session: DocumentSession, xref: int) -> tuple[bytes, str]:
    """Return the image bytes exactly as stored, plus its extension."""
    try:
        info = session.doc.extract_image(xref)
    except Exception as exc:
        raise DocumentError("Could not extract that image: {0}".format(exc)) from exc
    if not info or not info.get("image"):
        raise DocumentError("That image has no decodable stream.")
    return info["image"], info.get("ext", "png")


def _to_pillow(session: DocumentSession, xref: int) -> Image.Image:
    """Decode an image xref, re-attaching its soft mask so alpha survives."""
    try:
        pix = fitz.Pixmap(session.doc, xref)
        if pix.colorspace and pix.colorspace.n == 4:      # CMYK -> RGB
            pix = fitz.Pixmap(fitz.csRGB, pix)
        data = pix.tobytes("png")
        return Image.open(io.BytesIO(data)).convert("RGBA")
    except Exception:
        raw, _ext = extract(session, xref)
        return Image.open(io.BytesIO(raw)).convert("RGBA")


def _encode(image: Image.Image, *, jpeg_quality: int | None) -> bytes:
    buffer = io.BytesIO()
    if jpeg_quality is not None:
        image.convert("RGB").save(
            buffer, format="JPEG", quality=int(jpeg_quality), optimize=True, subsampling=0
        )
    else:
        image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def _erase_image(page: fitz.Page, rect: fitz.Rect) -> None:
    """Remove image content in ``rect`` while leaving text and vectors alone."""
    page.add_redact_annot(fitz.Rect(rect))
    page.apply_redactions(
        images=getattr(fitz, "PDF_REDACT_IMAGE_REMOVE", 2),
        graphics=getattr(fitz, "PDF_REDACT_LINE_ART_NONE", 0),
        text=getattr(fitz, "PDF_REDACT_TEXT_NONE", 1),
    )


def delete_image(session: DocumentSession, pno: int, xref: int, occurrence: int = 0) -> dict:
    with session.lock:
        session.checkpoint()
        rect = _find(session, pno, xref, occurrence)
        _erase_image(_page(session, pno), rect)
        session.invalidate_cache()
        return {"deleted": True}


def transform_image(
    session: DocumentSession,
    pno: int,
    xref: int,
    *,
    occurrence: int = 0,
    rect: list[float] | None = None,
    rotate: int = 0,
    flip_h: bool = False,
    flip_v: bool = False,
    crop: list[float] | None = None,     # fractional l,t,r,b in 0..1
    opacity: float = 1.0,
    jpeg_quality: int | None = None,
    keep_aspect: bool = False,
) -> dict:
    """Apply any combination of geometry and pixel edits to one placed image."""
    with session.lock:
        session.checkpoint()
        page = _page(session, pno)
        original = _find(session, pno, xref, occurrence)
        target = fitz.Rect(*rect) if rect else fitz.Rect(original)

        pixel_work = bool(
            rotate % 360 or flip_h or flip_v or crop or opacity < 1.0 or jpeg_quality
        )

        if not pixel_work:
            # Pure re-placement: reuse the stored stream verbatim.
            _erase_image(page, original)
            page.insert_image(target, xref=xref, keep_proportion=keep_aspect, overlay=True)
            session.invalidate_cache()
            return {"bbox": [target.x0, target.y0, target.x1, target.y1], "recompressed": False}

        image = _to_pillow(session, xref)

        if crop:
            left, top, right, bottom = crop
            w, h = image.size
            box = (
                max(0, int(round(left * w))),
                max(0, int(round(top * h))),
                min(w, int(round(right * w))),
                min(h, int(round(bottom * h))),
            )
            if box[2] <= box[0] or box[3] <= box[1]:
                raise DocumentError("The crop region is empty.")
            image = image.crop(box)

        if flip_h:
            image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        if flip_v:
            image = image.transpose(Image.Transpose.FLIP_TOP_BOTTOM)

        angle = rotate % 360
        if angle:
            if angle in (90, 180, 270):
                mapping = {
                    90: Image.Transpose.ROTATE_270,     # clockwise
                    180: Image.Transpose.ROTATE_180,
                    270: Image.Transpose.ROTATE_90,
                }
                image = image.transpose(mapping[angle])
            else:
                image = image.rotate(
                    -angle, resample=Image.Resampling.BICUBIC, expand=True
                )

        if opacity < 1.0:
            alpha = image.getchannel("A")
            image.putalpha(ImageEnhance.Brightness(alpha).enhance(max(opacity, 0.0)))

        data = _encode(image, jpeg_quality=jpeg_quality)

        _erase_image(page, original)
        if rect is None and angle in (90, 270):
            # A quarter turn swaps the aspect ratio; keep the centre fixed.
            cx, cy = (original.x0 + original.x1) / 2, (original.y0 + original.y1) / 2
            half_w, half_h = original.height / 2, original.width / 2
            target = fitz.Rect(cx - half_w, cy - half_h, cx + half_w, cy + half_h)

        page.insert_image(
            target, stream=data, keep_proportion=keep_aspect, overlay=True
        )
        session.invalidate_cache()
        return {
            "bbox": [target.x0, target.y0, target.x1, target.y1],
            "recompressed": True,
            "bytes": len(data),
            "pixelSize": list(image.size),
        }


def add_image(
    session: DocumentSession,
    pno: int,
    data: bytes,
    rect: list[float] | None = None,
    *,
    keep_aspect: bool = True,
) -> dict:
    with session.lock:
        session.checkpoint()
        page = _page(session, pno)
        try:
            probe = Image.open(io.BytesIO(data))
            probe.verify()
            probe = Image.open(io.BytesIO(data))
            width, height = probe.size
        except Exception as exc:
            raise DocumentError("That file is not a readable image: {0}".format(exc)) from exc
        if width * height > _MAX_PIXELS:
            raise DocumentError("That image is too large to place.")

        if rect:
            target = fitz.Rect(*rect)
        else:
            # Default: centred, at most half the page width, aspect preserved.
            max_w = page.rect.width * 0.5
            scale = min(max_w / width, (page.rect.height * 0.5) / height, 1.0)
            w, h = width * scale, height * scale
            cx, cy = page.rect.width / 2, page.rect.height / 2
            target = fitz.Rect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)

        page.insert_image(target, stream=data, keep_proportion=keep_aspect, overlay=True)
        session.invalidate_cache()
        return {"bbox": [target.x0, target.y0, target.x1, target.y1]}


def replace_image(
    session: DocumentSession, pno: int, xref: int, data: bytes, occurrence: int = 0
) -> dict:
    with session.lock:
        session.checkpoint()
        page = _page(session, pno)
        rect = _find(session, pno, xref, occurrence)
        try:
            Image.open(io.BytesIO(data)).verify()
        except Exception as exc:
            raise DocumentError("Replacement is not a readable image: {0}".format(exc)) from exc
        _erase_image(page, rect)
        page.insert_image(rect, stream=data, keep_proportion=False, overlay=True)
        session.invalidate_cache()
        return {"bbox": [rect.x0, rect.y0, rect.x1, rect.y1]}


def compress_images(
    session: DocumentSession,
    *,
    quality: int = 75,
    max_dpi: int = 200,
    pages: list[int] | None = None,
) -> dict:
    """Downsample and re-encode placed images. This is intentionally lossy."""
    with session.lock:
        session.checkpoint()
        page_range = pages if pages is not None else list(range(session.doc.page_count))
        before = after = 0
        touched = 0

        for pno in page_range:
            page = _page(session, pno)
            for info in list(page.get_images(full=True)):
                xref = info[0]
                try:
                    stored = session.doc.extract_image(xref)
                except Exception:
                    continue
                if not stored or not stored.get("image"):
                    continue
                rects = _safe_rects(page, xref)
                if not rects:
                    continue
                rect = rects[0]
                original_bytes = len(stored["image"])

                image = _to_pillow(session, xref)
                target_w = max(int(rect.width / 72.0 * max_dpi), 1)
                target_h = max(int(rect.height / 72.0 * max_dpi), 1)
                if image.width > target_w or image.height > target_h:
                    image = image.resize(
                        (min(image.width, target_w), min(image.height, target_h)),
                        Image.Resampling.LANCZOS,
                    )

                has_alpha = image.getchannel("A").getextrema()[0] < 255
                data = _encode(image, jpeg_quality=None if has_alpha else quality)
                if len(data) >= original_bytes:
                    continue    # never make a stream bigger

                for occurrence_rect in rects:
                    _erase_image(page, occurrence_rect)
                    page.insert_image(occurrence_rect, stream=data, overlay=True)
                before += original_bytes
                after += len(data)
                touched += 1

        session.invalidate_cache()
        return {
            "images": touched,
            "bytesBefore": before,
            "bytesAfter": after,
            "saved": max(before - after, 0),
        }


def render_thumbnail(session: DocumentSession, xref: int, max_side: int = 320) -> bytes:
    image = _to_pillow(session, xref)
    scale = min(max_side / max(image.width, image.height), 1.0)
    if scale < 1.0:
        image = image.resize(
            (max(int(image.width * scale), 1), max(int(image.height * scale), 1)),
            Image.Resampling.LANCZOS,
        )
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()
