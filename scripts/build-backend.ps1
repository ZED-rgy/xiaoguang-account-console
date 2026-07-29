$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
try {
  python -m pip install --disable-pip-version-check -r requirements.txt
  if ($LASTEXITCODE -ne 0) { throw "runtime dependency install failed: $LASTEXITCODE" }
  python -m pip install --disable-pip-version-check -r requirements-build.txt
  if ($LASTEXITCODE -ne 0) { throw "build dependency install failed: $LASTEXITCODE" }
  $frontend = Join-Path $root 'frontend'
  $shared = Join-Path $root 'shared'
  $packageJson = Join-Path $root 'package.json'
  python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --name account-console-server `
    --distpath dist-backend `
    --workpath .build/backend `
    --specpath .build `
    --collect-all uvicorn `
    --add-data "$frontend;frontend" `
    --add-data "$shared;shared" `
    --add-data "$packageJson;." `
    run_server.py
  if ($LASTEXITCODE -ne 0) { throw "backend build failed: $LASTEXITCODE" }
} finally {
  Pop-Location
}
