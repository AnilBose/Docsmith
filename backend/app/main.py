"""Docsmith API: the PDF editing and conversion service.

Runs on the loopback interface only. No document ever leaves this process
except through an explicit download, and no request is ever made to the
internet.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.core.session import DocumentError, store
from app.routers import annotations, convert, documents, images, pages, security, text

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
)
log = logging.getLogger("docsmith")

app = FastAPI(
    title="Docsmith",
    version="1.0.0",
    description=(
        "Offline PDF editing: lossless text and image editing, page assembly, "
        "conversion, encryption and true redaction."
    ),
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Requested-With"],
    expose_headers=["Content-Disposition", "X-Document-Version"],
    max_age=600,
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """Defensive headers. The API serves no HTML, so the CSP can be absolute."""
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Cross-Origin-Resource-Policy", "same-site")
    response.headers.setdefault(
        "Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'"
    )
    return response


@app.exception_handler(DocumentError)
async def document_error_handler(_request: Request, exc: DocumentError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(Exception)
async def unhandled_handler(_request: Request, exc: Exception):
    # Log the detail locally; return a generic message to the client.
    log.exception("Unhandled error: %s", exc)
    return JSONResponse(
        status_code=500,
        content={"detail": "The editor hit an internal error. Check the server log."},
    )


for router in (
    documents.router,
    text.router,
    images.router,
    pages.router,
    annotations.router,
    convert.router,
    security.router,
):
    app.include_router(router)


@app.get("/api/health")
def health():
    from app.services.convert import capabilities

    return {
        "status": "ok",
        "openDocuments": len(store.list()),
        "limits": {
            "maxUploadMb": settings.max_upload_bytes // (1024 * 1024),
            "maxOpenDocuments": settings.max_open_documents,
            "sessionTtlSeconds": settings.session_ttl_seconds,
        },
        "capabilities": capabilities(),
    }


@app.on_event("startup")
def on_startup():
    log.info("Docsmith API on http://%s:%s", settings.host, settings.port)
    log.info("Allowed origins: %s", ", ".join(settings.allowed_origins))
    from app.services.convert import capabilities

    caps = capabilities()
    if not caps["libreOffice"]:
        log.warning(
            "LibreOffice not found -- Word/Excel/PowerPoint import is disabled. "
            "Install it from libreoffice.org or set PDFE_SOFFICE."
        )


def run() -> None:
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    run()
