# Official precompiled CARLA only. Never builds Unreal or runs Python installers.
param(
    [string]$InstallRoot = 'C:\CARLA\CARLA_0.9.16',
    [switch]$InspectOnly
)
$ErrorActionPreference = 'Stop'
$version = '0.9.16'
$blocker = "CARLA $version BLOCKER"
$projectRoot = Split-Path -Parent $PSScriptRoot
$downloadRoot = 'C:\CARLA\downloads'
$manifestPath = Join-Path $downloadRoot "CARLA_$version.package.json"
$archivePath = Join-Path $downloadRoot "CARLA_$version.zip"
$partialPath = "$archivePath.part"
$packageUri = 'https://downloads.carlasim.com/Windows/CARLA_0.9.16.zip'
Push-Location -LiteralPath $projectRoot
try {
    New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
    $inspector = Join-Path $PSScriptRoot 'inspect_carla_package.py'
    $inspectionArgs = @('-3', $inspector, '--output', $manifestPath)
    if (Test-Path -LiteralPath $archivePath) { $inspectionArgs += @('--archive', $archivePath) }
    & py.exe @inspectionArgs
    if ($LASTEXITCODE -ne 0) { throw "$blocker`: official ZIP/wheel inspection failed; no installation attempted" }
    $package = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($package.version -ne $version -or $package.url -ne $packageUri) { throw "$blocker`: package version/source mismatch" }
    $wheels = @($package.windowsWheels)
    if ($wheels.Count -ne 1) { throw "$blocker`: expected one inspected Windows wheel; review package compatibility" }
    $wheelName = Split-Path -Leaf $wheels[0].path
    if ($wheelName -notmatch '^carla-0\.9\.16-cp(?<py>3\d+)-cp\k<py>-win_amd64\.whl$') { throw "$blocker`: unsupported API wheel: $wheelName" }
    $pythonDigits = $Matches.py
    $requiredPython = "3.$($pythonDigits.Substring(1))"
    $wheelTag = "cp$pythonDigits-cp$pythonDigits-win_amd64"
    if ($wheels[0].tags -notcontains $wheelTag) { throw "$blocker`: wheel filename and internal ABI tag disagree" }
    if ($wheels[0].packageMetadata -notcontains "Version: $version") { throw "$blocker`: wheel metadata version mismatch" }
    $launchers = @($package.launchers)
    if ($launchers.Count -ne 1) { throw "$blocker`: no unique native launcher in the actual package" }
    Write-Host "Inspected CARLA $version`: $wheelName requires Python $requiredPython x64; launcher $($launchers[0])."
    if ($InspectOnly) { Write-Host 'Inspection only. CARLA is not installed or launched.'; return }
    $runtimeJson = & py.exe "-$requiredPython" -c "import json,struct,sys; print(json.dumps({'version':list(sys.version_info[:2]),'bits':struct.calcsize('P')*8,'path':sys.executable}))"
    if ($LASTEXITCODE -ne 0) {
        throw "$blocker`: Python $requiredPython x64 is missing. Required manual action: install C:\CARLA\downloads\python-3.12.10-amd64.exe. Continue: .\scripts\prepare_carla.ps1"
    }
    $runtime = $runtimeJson | ConvertFrom-Json
    if ($runtime.bits -ne 64 -or ($runtime.version -join '.') -ne $requiredPython) { throw "$blocker`: Python runtime/ABI mismatch" }
    & py.exe "-$requiredPython" -c 'from backend.carla.connection import ensure_runtime; ensure_runtime()'
    if ($LASTEXITCODE -ne 0) { throw "$blocker`: runtime does not match the project's verified version contract" }
    $resolvedInstall = [IO.Path]::GetFullPath($InstallRoot)
    if ($resolvedInstall -eq [IO.Path]::GetPathRoot($resolvedInstall) -or $resolvedInstall -match '0\.10\.0') { throw "$blocker`: choose a clean, separate 0.9.16 installation directory" }
    $nativeExe = Join-Path $resolvedInstall $launchers[0]
    $installedMarker = Join-Path $resolvedInstall '.carla-install.json'
    if (Test-Path -LiteralPath $installedMarker) {
        $existing = Get-Content -LiteralPath $installedMarker -Raw | ConvertFrom-Json
        if ($existing.version -ne $version -or $existing.archiveBytes -ne $package.archiveBytes -or $existing.wheelSha256 -ne $wheels[0].sha256) { throw "$blocker`: existing installation does not match this official package" }
    } else {
        if ((Test-Path -LiteralPath $resolvedInstall) -and (Get-ChildItem -LiteralPath $resolvedInstall -Force | Select-Object -First 1)) { throw "$blocker`: installation folder is nonempty without a verified marker; inspect it or select a clean -InstallRoot" }
        $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($resolvedInstall).Substring(0,1))
        $remainingDownload = if (Test-Path -LiteralPath $archivePath) { 0 } else { $package.archiveBytes }
        if ($drive.Free -lt ($package.uncompressedBytes + $remainingDownload + 2GB)) { throw "$blocker`: insufficient storage for the actual archive, extracted files and Python environment" }
        if (-not (Test-Path -LiteralPath $archivePath)) {
            & curl.exe --fail --location --retry 3 --continue-at - --output $partialPath $packageUri
            if ($LASTEXITCODE -ne 0) { throw "$blocker`: official download failed; partial archive preserved" }
            if ((Get-Item -LiteralPath $partialPath).Length -ne $package.archiveBytes) { throw "$blocker`: incomplete archive; extraction stopped" }
            Move-Item -LiteralPath $partialPath -Destination $archivePath
        }
        if ((Get-Item -LiteralPath $archivePath).Length -ne $package.archiveBytes) { throw "$blocker`: archive length mismatch" }
        $localManifest = Join-Path $downloadRoot "CARLA_$version.local-package.json"
        & py.exe "-$requiredPython" $inspector --archive $archivePath --output $localManifest
        if ($LASTEXITCODE -ne 0) { throw "$blocker`: local archive directory/wheel CRC validation failed" }
        $local = Get-Content -LiteralPath $localManifest -Raw | ConvertFrom-Json
        if ($local.windowsWheels[0].sha256 -ne $wheels[0].sha256) { throw "$blocker`: downloaded API wheel differs from the inspected official package" }
        New-Item -ItemType Directory -Path $resolvedInstall -Force | Out-Null
        & tar.exe -xf $archivePath -C $resolvedInstall
        if ($LASTEXITCODE -ne 0) { throw "$blocker`: extraction failed; installation is incomplete at $resolvedInstall" }
    }
    if (-not (Test-Path -LiteralPath $nativeExe)) { throw "$blocker`: detected launcher missing: $nativeExe" }
    $wheelPath = Join-Path $resolvedInstall $wheels[0].path
    if (-not (Test-Path -LiteralPath $wheelPath)) { throw "$blocker`: packaged API wheel missing: $wheelPath" }
    if ((Get-FileHash -LiteralPath $wheelPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $wheels[0].sha256) { throw "$blocker`: extracted API wheel checksum mismatch" }
    $installRecord = @{version=$version; archiveBytes=$package.archiveBytes; wheelSha256=$wheels[0].sha256; executable=$nativeExe; packageVerified=$true; pythonApiValidated=$false; nativeBootValidated=$false}
    $installRecord | ConvertTo-Json | Set-Content -LiteralPath $installedMarker -Encoding utf8
    $venvPath = Join-Path $projectRoot '.venv-carla'
    $venvPython = Join-Path $venvPath 'Scripts\python.exe'
    if (Test-Path -LiteralPath $venvPath) {
        $compatible = $false
        if (Test-Path -LiteralPath $venvPython) {
            & $venvPython -c "import struct,sys; assert '.'.join(map(str,sys.version_info[:2])) == '$requiredPython' and struct.calcsize('P') == 8"
            $compatible = $LASTEXITCODE -eq 0
        }
        if (-not $compatible) {
            $archivedVenv = Join-Path $projectRoot ('.venv-carla-archive-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
            $workspacePrefix = [IO.Path]::GetFullPath($projectRoot).TrimEnd('\') + '\'
            if (-not ([IO.Path]::GetFullPath($venvPath).StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFullPath($archivedVenv).StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase))) { throw 'Virtual environment archive paths escaped the workspace' }
            Move-Item -LiteralPath $venvPath -Destination $archivedVenv
            Write-Host "Preserved incompatible environment: $archivedVenv"
        }
    }
    if (-not (Test-Path -LiteralPath $venvPython)) {
        & py.exe "-$requiredPython" -m venv $venvPath
        if ($LASTEXITCODE -ne 0) { throw "$blocker`: virtual environment creation failed" }
    }
    & $venvPython -m pip install $wheelPath -r (Join-Path $projectRoot 'backend\requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw "$blocker`: matching API/dependency installation failed" }
    & $venvPython -c "import carla; client=carla.Client('127.0.0.1',2000); version=client.get_client_version(); print('CARLA API:',version); assert version.split('-')[0] == '$version'"
    if ($LASTEXITCODE -ne 0) { throw "$blocker`: API import/version validation failed" }
    $installRecord.python = $venvPython
    $installRecord.pythonVersion = $requiredPython
    $installRecord.pythonApiValidated = $true
    $installRecord | ConvertTo-Json | Set-Content -LiteralPath $installedMarker -Encoding utf8
    Write-Host "CARLA $version package/API installed at $resolvedInstall. Native boot and Gate 1 are NOT validated."
    Write-Host "Launch: .\scripts\launch_carla.ps1 -InstallRoot '$resolvedInstall'"
    Write-Host "Connect: $venvPython -m backend.carla.preflight"
    Write-Host "Backend: $venvPython -m backend.server --carla"
} catch {
    Write-Error ($_.Exception.Message) -ErrorAction Continue
    exit 2
} finally { Pop-Location }
