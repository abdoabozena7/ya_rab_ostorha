$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    & "$projectRoot\.venv-carla\Scripts\python.exe" -m scripts.final_runtime
    if ($LASTEXITCODE -ne 0) { throw 'YA RAB OSTORHA startup failed. See output/final-delivery.' }
    Start-Process 'http://127.0.0.1:8000/'
} finally { Pop-Location }
