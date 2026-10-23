$ErrorActionPreference = 'Stop'
# Optional GPU (DirectML) detector runtime. The default CPU environment from
# setup_perception.ps1 stays unchanged and is still required for the model files.
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
if (-not (Test-Path -LiteralPath '.venv-perception-dml/Scripts/python.exe')) {
    & '.venv-carla/Scripts/python.exe' -m venv .venv-perception-dml
    if ($LASTEXITCODE -ne 0) { throw 'DirectML perception environment creation failed' }
}
& '.venv-perception-dml/Scripts/python.exe' -m pip install -r backend/requirements-perception-directml.txt
if ($LASTEXITCODE -ne 0) { throw 'DirectML perception package installation failed' }
& '.venv-perception-dml/Scripts/python.exe' -c "import onnxruntime as o; assert 'DmlExecutionProvider' in o.get_available_providers(), o.get_available_providers(); print('DirectML provider available')"
if ($LASTEXITCODE -ne 0) { throw 'DirectML execution provider is not available on this machine' }
