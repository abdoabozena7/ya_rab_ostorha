param(
    [switch]$Check,
    [switch]$NoBrowser,
    [ValidateRange(1, 65535)]
    [int]$Port = 8000
)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$python = Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $python) {
    throw 'Python 3.10 or newer must be available as python on PATH. No simulator environment is required.'
}
Push-Location -LiteralPath $projectRoot
try {
    $runtimeArgs = @('-m', 'backend.threejs.server', '--port', $Port)
    if ($Check) { $runtimeArgs += '--check' }
    elseif (-not $NoBrowser) { $runtimeArgs += '--open-browser' }
    & $python.Source @runtimeArgs
    if ($LASTEXITCODE -ne 0) { throw 'Three.js startup failed. See the error above and README.md.' }
} finally { Pop-Location }
