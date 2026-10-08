$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
if (-not (Test-Path -LiteralPath '.venv-perception/Scripts/python.exe')) {
    & '.venv-carla/Scripts/python.exe' -m venv .venv-perception
    if ($LASTEXITCODE -ne 0) { throw 'Perception environment creation failed' }
}
& '.venv-perception/Scripts/python.exe' -m pip install torch==2.14.1+cpu torchvision==0.29.1+cpu --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw 'CPU PyTorch installation failed' }
& '.venv-perception/Scripts/python.exe' -m pip install -r backend/requirements-perception.txt
if ($LASTEXITCODE -ne 0) { throw 'Perception package installation failed' }
& '.venv-perception/Scripts/python.exe' -m scripts.prepare_perception
if ($LASTEXITCODE -ne 0) { throw 'Perception model preparation failed' }
