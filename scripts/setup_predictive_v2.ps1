$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$learnedPython = Join-Path $projectRoot '.venv-learned/Scripts/python.exe'
$predictPython = Join-Path $projectRoot '.venv-trajectron/Scripts/python.exe'
Push-Location -LiteralPath $projectRoot
try {
    if (-not (Test-Path -LiteralPath $predictPython)) { & $learnedPython -m venv .venv-trajectron }
    $runtimePaths = @((Join-Path $projectRoot '.venv-learned/Lib/site-packages'), (Join-Path $projectRoot '.venv-rl/Lib/site-packages'))
    Set-Content -LiteralPath '.venv-trajectron/Lib/site-packages/learned-runtime.pth' -Value $runtimePaths
    & $predictPython -m pip install -r backend/requirements-trajectron.txt
    if ($LASTEXITCODE -ne 0) { throw 'Isolated Trajectron dependency installation failed' }
    $predictLock = Get-Content -LiteralPath 'config/trajectron-lock.json' -Raw | ConvertFrom-Json
    New-Item -ItemType Directory -Force '.cache/trajectron' | Out-Null
    if (-not (Test-Path -LiteralPath '.cache/trajectron/source/.git')) {
        git clone --filter=blob:none --no-checkout $predictLock.repository .cache/trajectron/source
        if ($LASTEXITCODE -ne 0) { throw 'Pinned source clone failed' }
        git -C .cache/trajectron/source fetch --depth 1 origin $predictLock.revision
        if ($LASTEXITCODE -ne 0) { throw 'Pinned source fetch failed' }
        git -C .cache/trajectron/source checkout --detach $predictLock.revision
        if ($LASTEXITCODE -ne 0) { throw 'Pinned source checkout failed' }
    }
    $actualRevision = git -C .cache/trajectron/source rev-parse HEAD
    if ($actualRevision -ne $predictLock.revision) { throw 'Source revision differs from pinned lock; preserve and inspect existing checkout' }
    foreach ($asset in @(@('configuration','config.json','config_sha256'), @('weights','model_registrar-12.pt','weights_sha256'))) {
        $url = 'https://raw.githubusercontent.com/StanfordASL/Trajectron-plus-plus/' + $predictLock.revision + '/' + $predictLock.($asset[0])
        $targetPath = Join-Path '.cache/trajectron' $asset[1]
        if (-not (Test-Path -LiteralPath $targetPath)) { Invoke-WebRequest $url -OutFile $targetPath }
        if ((Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash.ToLower() -ne $predictLock.($asset[2])) { throw 'Pinned asset checksum mismatch' }
    }
    Write-Host 'Candidate prepared. Benchmark explicitly; driving buttons never install or train.'
} finally { Pop-Location }
