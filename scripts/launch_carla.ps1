param([string]$InstallRoot = 'C:\CARLA\CARLA_0.9.16', [ValidateSet('Development','Evaluation')][string]$Profile = 'Development')
$ErrorActionPreference = 'Stop'
$markerPath = Join-Path $InstallRoot '.carla-install.json'
if (-not (Test-Path -LiteralPath $markerPath)) { throw 'CARLA 0.9.16 BLOCKER: run prepare_carla.ps1 to verify the official package/API first' }
$installed = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
if ($installed.version -ne '0.9.16') { throw 'CARLA 0.9.16 BLOCKER: installation version mismatch' }
if (-not $installed.packageVerified -or -not $installed.pythonApiValidated) { throw 'CARLA 0.9.16 BLOCKER: package/API preparation is incomplete' }
if ($Profile -eq 'Evaluation') { throw 'CARLA 0.9.16 BLOCKER: final evaluation settings are deferred until native vehicle and sensor validation; use Development for Gate 1' }
$nativeExe = [IO.Path]::GetFullPath($installed.executable)
$rootPrefix = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
if (-not $nativeExe.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $nativeExe)) { throw 'CARLA 0.9.16 BLOCKER: detected package launcher is missing or outside the install folder' }
$quality = 'Low'
Write-Host "Launching actual CARLA 0.9.16: $nativeExe ($Profile, $quality, 1280x720). See docs/LIVE_NATIVE_VALIDATION.md for gate evidence."
Push-Location -LiteralPath (Split-Path -Parent $nativeExe)
try {
    $nativeProcess = Start-Process -FilePath $nativeExe -ArgumentList "-quality-level=$quality", '-windowed', '-ResX=1280', '-ResY=720', '-carla-rpc-port=2000' -WindowStyle Hidden -PassThru -Wait
    if ($nativeProcess.ExitCode -ne 0) { throw "CARLA 0.9.16 BLOCKER: native launcher exited with code $($nativeProcess.ExitCode); inspect CarlaUE4 logs" }
} finally { Pop-Location }
