"""Runtime configuration.

Everything here is tuned for a *local-only* deployment: the service binds to
the loopback interface, never phones home, and keeps documents in RAM so that
nothing sensitive is written to disk unless the user explicitly downloads it.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    # --- network ----------------------------------------------------------
    host: str = os.getenv("PDFE_HOST", "127.0.0.1")
    port: int = int(os.getenv("PDFE_PORT", "8420"))

    # Only the local Next.js dev/prod server may talk to us.
    allowed_origins: list[str] = [
        o.strip()
        for o in os.getenv(
            "PDFE_ALLOWED_ORIGINS",
            "http://localhost:3000,http://127.0.0.1:3000",
        ).split(",")
        if o.strip()
    ]

    # --- limits -----------------------------------------------------------
    max_upload_bytes: int = int(os.getenv("PDFE_MAX_UPLOAD_MB", "256")) * 1024 * 1024
    max_open_documents: int = int(os.getenv("PDFE_MAX_DOCS", "24"))
    session_ttl_seconds: int = int(os.getenv("PDFE_SESSION_TTL", str(6 * 3600)))

    # --- behaviour --------------------------------------------------------
    # Disallow PDFs that try to run JavaScript / launch actions on open.
    strip_active_content: bool = _env_bool("PDFE_STRIP_ACTIVE_CONTENT", True)

    # Scratch space used only by converters that shell out (LibreOffice).
    scratch_dir: Path = Path(os.getenv("PDFE_SCRATCH", tempfile.gettempdir())) / "pdf-editor"

    # --- external binaries ------------------------------------------------
    @property
    def soffice(self) -> str | None:
        """Locate a LibreOffice binary for Office <-> PDF conversion."""
        explicit = os.getenv("PDFE_SOFFICE")
        if explicit and Path(explicit).exists():
            return explicit
        for candidate in ("soffice", "soffice.exe", "libreoffice"):
            found = shutil.which(candidate)
            if found:
                return found
        for guess in (
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
            "/usr/bin/soffice",
            "/usr/lib/libreoffice/program/soffice",
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        ):
            if Path(guess).exists():
                return guess
        return None


settings = Settings()
settings.scratch_dir.mkdir(parents=True, exist_ok=True)
