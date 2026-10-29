#!/usr/bin/env bash
# Starts Docsmith on this machine (macOS / Linux).
#
#   ./start.sh          production build
#   ./start.sh --dev    Next.js dev server with hot reload
#
# Both services bind to 127.0.0.1 only.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
API_PORT="${PDFE_PORT:-8420}"
UI_PORT="${PDFE_UI_PORT:-3000}"
DEV=0
[ "${1:-}" = "--dev" ] && DEV=1

# Must be exported before the frontend build: Next.js evaluates rewrites() at
# build time and freezes the destination into .next/routes-manifest.json, so a
# build that runs with a stale value proxies /api to the wrong port at runtime.
API_ORIGIN="http://127.0.0.1:$API_PORT"
export NEXT_PUBLIC_API_URL="$API_ORIGIN"
export PDFE_PORT="$API_PORT"
export PDFE_ALLOWED_ORIGINS="http://localhost:$UI_PORT,http://127.0.0.1:$UI_PORT"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }

VENV_PY="$BACKEND/.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  step "Creating the Python virtual environment"
  python3 -m venv "$BACKEND/.venv"
  "$VENV_PY" -m pip install --upgrade pip --quiet
fi

MARKER="$BACKEND/.venv/.deps-installed"
if [ ! -f "$MARKER" ] || [ "$BACKEND/requirements.txt" -nt "$MARKER" ]; then
  step "Installing Python dependencies (first run takes a few minutes)"
  "$VENV_PY" -m pip install -r "$BACKEND/requirements.txt" --quiet
  touch "$MARKER"
fi

if [ ! -d "$FRONTEND/node_modules" ]; then
  step "Installing Node dependencies"
  (cd "$FRONTEND" && npm install --no-audit --no-fund)
fi

if [ "$DEV" -eq 0 ]; then
  step "Building the frontend for $API_ORIGIN"
  (cd "$FRONTEND" && npm run build)
  # Next.js freezes rewrites() into the build; make sure it took the right port.
  if ! grep -q "$API_ORIGIN" "$FRONTEND/.next/routes-manifest.json" 2>/dev/null; then
    echo "The build did not pick up $API_ORIGIN. Remove $FRONTEND/.next and retry." >&2
    exit 1
  fi
fi

cleanup() {
  step "Shutting down"
  [ -n "${API_PID:-}" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "${UI_PID:-}" ] && kill "$UI_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

step "Starting the editor service on 127.0.0.1:$API_PORT"
(cd "$BACKEND" && "$VENV_PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$API_PORT") &
API_PID=$!

sleep 2
kill -0 "$API_PID" 2>/dev/null || { echo "The editor service failed to start."; exit 1; }

step "Starting the interface on http://127.0.0.1:$UI_PORT"
if [ "$DEV" -eq 1 ]; then
  (cd "$FRONTEND" && npm run dev -- -p "$UI_PORT") &
else
  (cd "$FRONTEND" && npm run start -- -p "$UI_PORT") &
fi
UI_PID=$!

cat <<INFO

  Docsmith is running.
    Interface : http://127.0.0.1:$UI_PORT
    API docs  : http://127.0.0.1:$API_PORT/api/docs

  Press Ctrl+C to stop both services.

INFO

wait "$UI_PID"
