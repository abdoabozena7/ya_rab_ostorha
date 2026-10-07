# Run after installing the downloaded, signed Python 3.12 installer manually.
# This script never installs a Python runtime or builds CARLA/Unreal from source.
param([string]$InstallRoot = 'C:\CARLA\CARLA_0.10.0')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    & py.exe -3.12 -c "import struct,sys; assert sys.version_info[:2] == (3,12) and struct.calcsize('P') == 8"
    if ($LASTEXITCODE -ne 0) { throw 'CARLA BLOCKER: manually install Python 3.12 x64 first: C:\CARLA\downloads\python-3.12.10-amd64.exe' }
    $resolvedInstall = [IO.Path]::GetFullPath($InstallRoot)
    if ($resolvedInstall -eq [IO.Path]::GetPathRoot($resolvedInstall)) { throw 'Choose a dedicated CARLA installation directory' }
    $downloadRoot = 'C:\CARLA\downloads'
    New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
    $packageUri = 'https://downloads.carlasim.com/Windows/Carla-0.10.0-Win64-Shipping.zip'
    $archivePath = Join-Path $downloadRoot 'Carla-0.10.0-Win64-Shipping.zip'
    $partialPath = "$archivePath.part"
    $nativeExe = Join-Path $resolvedInstall 'CarlaUnreal.exe'
    if (-not (Test-Path -LiteralPath $nativeExe)) {
        $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($resolvedInstall).Substring(0,1))
        if ($drive.Free -lt 130GB) { throw 'CARLA BLOCKER: official UE5 package requires 130 GB free space; free storage before continuing' }
        $head = Invoke-WebRequest -Uri $packageUri -Method Head
        $expectedBytes = [long]($head.Headers['Content-Length'] | Select-Object -First 1)
        if ($expectedBytes -le 0) { throw 'CARLA BLOCKER: official download did not provide a package length' }
        if (-not (Test-Path -LiteralPath $archivePath)) {
            & curl.exe --fail --location --retry 3 --continue-at - --output $partialPath $packageUri
            if ($LASTEXITCODE -ne 0) { throw 'CARLA BLOCKER: official download failed; partial archive kept for resuming' }
            if ((Get-Item -LiteralPath $partialPath).Length -ne $expectedBytes) { throw 'CARLA BLOCKER: incomplete archive; no extraction attempted' }
            Move-Item -LiteralPath $partialPath -Destination $archivePath
        }
        if ((Get-Item -LiteralPath $archivePath).Length -ne $expectedBytes) { throw 'CARLA BLOCKER: archive length does not match official download' }
        if (Test-Path -LiteralPath $resolvedInstall) {
            if (Get-ChildItem -LiteralPath $resolvedInstall -Force | Select-Object -First 1) { throw 'CARLA BLOCKER: installation folder contains files but no launcher; inspect it or choose a clean -InstallRoot' }
        }
        New-Item -ItemType Directory -Path $resolvedInstall -Force | Out-Null
        & tar.exe -xf $archivePath -C $resolvedInstall
        if ($LASTEXITCODE -ne 0) { throw 'CARLA BLOCKER: package extraction failed; inspect installation folder' }
        if (-not (Test-Path -LiteralPath $nativeExe)) { throw "CARLA BLOCKER: expected launcher missing: $nativeExe. Inspect the official package layout." }
    }
    $wheels = @(Get-ChildItem -LiteralPath $resolvedInstall -Recurse -File -Filter 'carla-0.10.0-cp312-*-win_amd64.whl')
    if ($wheels.Count -ne 1) { throw 'CARLA BLOCKER: exactly one shipped CARLA 0.10.0 cp312 Windows x64 wheel is required; do not install a different API' }
    $venvPython = Join-Path $projectRoot '.venv-carla\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPython)) {
        & py.exe -3.12 -m venv (Join-Path $projectRoot '.venv-carla')
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the CARLA Python environment' }
    }
    & $venvPython -c "import struct,sys; assert sys.version_info[:2] == (3,12) and struct.calcsize('P') == 8"
    if ($LASTEXITCODE -ne 0) { throw 'Existing .venv-carla is not Python 3.12 x64' }
    & $venvPython -m pip install $wheels[0].FullName -r (Join-Path $projectRoot 'backend\requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'CARLA BLOCKER: matching Python API installation failed' }
    & $venvPython -c "import carla; client=carla.Client('127.0.0.1',2000); print('Python API:',client.get_client_version()); assert client.get_client_version().split('-')[0] == '0.10.0'"
    if ($LASTEXITCODE -ne 0) { throw 'CARLA BLOCKER: Python API import/version check failed' }
    Write-Host "Package prepared at $resolvedInstall. Native boot and migration gates are NOT yet validated."
    Write-Host "1. Launch $nativeExe in its installation folder."
    Write-Host "2. Run $venvPython -m backend.server --carla"
    Write-Host '3. Open http://127.0.0.1:8000/ and validate one real vehicle.'
} finally { Pop-Location }
