# Starts Docsmith on this machine.
#
#   .\start.ps1            production build, opens the browser
#   .\start.ps1 -Dev       Next.js dev server with hot reload
#   .\start.ps1 -SkipBuild reuse the last build (only if it targets the same port)
#   .\start.ps1 -NoBrowser don't open a browser window
#
# Both services bind to 127.0.0.1 only. Nothing listens on the network.

param(
    [switch]$Dev,
    [switch]$NoBrowser,
    [switch]$SkipBuild,
    [int]$ApiPort = 8420,
    [int]$UiPort = 3000
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"
$venvPython = Join-Path $backend ".venv\Scripts\python.exe"

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Warn($message) { Write-Host "  ! $message" -ForegroundColor Yellow }

function Test-PortFree([int]$port) {
    $inUse = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return $null -eq $inUse
}

# ---------------------------------------------------------------- preflight --
if (-not (Test-PortFree $ApiPort)) {
    throw "Port $ApiPort is already in use. Pass -ApiPort <n> to pick another."
}
if (-not (Test-PortFree $UiPort)) {
    throw "Port $UiPort is already in use. Pass -UiPort <n> to pick another."
}

# ----------------------------------------------------------- environment --
# These must be set BEFORE the frontend build. Next.js evaluates rewrites()
# at build time and freezes the result into .next/routes-manifest.json, so a
# build that runs with a stale NEXT_PUBLIC_API_URL will proxy /api to the old
# port no matter what the config file says at launch. $env: also persists for
# the whole PowerShell session, so a previous run's value would otherwise leak
# into this one's build.
$apiOrigin = "http://127.0.0.1:$ApiPort"
$env:NEXT_PUBLIC_API_URL = $apiOrigin
$env:PDFE_PORT = "$ApiPort"
$env:PDFE_ALLOWED_ORIGINS = "http://localhost:$UiPort,http://127.0.0.1:$UiPort"

function Test-BuildTargetsApi {
    # Does the existing production build proxy to the port we are about to use?
    $manifest = Join-Path $frontend ".next\routes-manifest.json"
    if (-not (Test-Path $manifest)) { return $false }
    try {
        return (Get-Content $manifest -Raw) -match [regex]::Escape($apiOrigin)
    } catch {
        return $false
    }
}

# ------------------------------------------------------------------ backend --
if (-not (Test-Path $venvPython)) {
    Write-Step "Creating the Python virtual environment"
    python -m venv (Join-Path $backend ".venv")
    & $venvPython -m pip install --upgrade pip --quiet
}

$marker = Join-Path $backend ".venv\.deps-installed"
$requirements = Join-Path $backend "requirements.txt"
if (-not (Test-Path $marker) -or
    (Get-Item $requirements).LastWriteTime -gt (Get-Item $marker).LastWriteTime) {
    Write-Step "Installing Python dependencies (first run takes a few minutes)"
    & $venvPython -m pip install -r $requirements --quiet
    New-Item -ItemType File -Path $marker -Force | Out-Null
}

# ----------------------------------------------------------------- frontend --
if (-not (Test-Path (Join-Path $frontend "node_modules"))) {
    Write-Step "Installing Node dependencies"
    Push-Location $frontend
    npm install --no-audit --no-fund
    Pop-Location
}

if (-not $Dev) {
    if ($SkipBuild -and (Test-BuildTargetsApi)) {
        Write-Step "Reusing the existing frontend build"
    } else {
        if ($SkipBuild) {
            Write-Warn "The existing build does not target $apiOrigin; rebuilding anyway."
        }
        Write-Step "Building the frontend for $apiOrigin"
        Push-Location $frontend
        npm run build
        Pop-Location
        if (-not (Test-BuildTargetsApi)) {
            throw "The build did not pick up $apiOrigin. Delete frontend\.next and retry."
        }
    }
}

# ------------------------------------------------------------------- launch --
Write-Step "Starting the editor service on 127.0.0.1:$ApiPort"

$api = Start-Process -FilePath $venvPython `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "$ApiPort" `
    -WorkingDirectory $backend -PassThru -NoNewWindow

Start-Sleep -Seconds 2
if ($api.HasExited) { throw "The editor service failed to start. Check the output above." }

Write-Step "Starting the interface on http://127.0.0.1:$UiPort"
$uiArgs = if ($Dev) { @("run", "dev", "--", "-p", "$UiPort") } else { @("run", "start", "--", "-p", "$UiPort") }
$ui = Start-Process -FilePath "npm.cmd" -ArgumentList $uiArgs `
    -WorkingDirectory $frontend -PassThru -NoNewWindow

if (-not $NoBrowser) {
    Start-Sleep -Seconds 4
    Start-Process "http://127.0.0.1:$UiPort"
}

Write-Host ""
Write-Host "  Docsmith is running." -ForegroundColor Green
Write-Host "    Interface : http://127.0.0.1:$UiPort"
Write-Host "    API docs  : http://127.0.0.1:$ApiPort/api/docs"
Write-Host ""
Write-Host "  Press Ctrl+C to stop both services."
Write-Host ""

try {
    Wait-Process -Id $ui.Id
} finally {
    Write-Step "Shutting down"
    foreach ($process in @($ui, $api)) {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
