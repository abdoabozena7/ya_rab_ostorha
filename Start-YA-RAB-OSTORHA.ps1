param([switch]$Reload, [switch]$Check, [double]$NativeValidationSeconds = 0, [string]$ValidationTicket)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    $nativePython = Join-Path $projectRoot '.venv-carla\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $nativePython)) { throw 'Native Python environment is missing. See README.md for setup.' }
    $runtimeArgs = @('-m', 'scripts.final_runtime')
    if ($Check) { $runtimeArgs += '--check' }
    elseif ($Reload) { $runtimeArgs += '--reload' }
    if ($NativeValidationSeconds) { $runtimeArgs += @('--native-validation-seconds', $NativeValidationSeconds) }
    if ($ValidationTicket) { $runtimeArgs += @('--validation-ticket', $ValidationTicket) }
    & $nativePython @runtimeArgs
    if ($LASTEXITCODE -ne 0) { throw 'YA RAB OSTORHA startup failed. See output/final-delivery.' }
    if (-not $Check) { Start-Process 'http://127.0.0.1:8000/' }
} finally { Pop-Location }
