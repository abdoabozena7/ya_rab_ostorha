param([string]$InstallRoot = 'C:\CARLA\CARLA_0.9.16', [ValidateSet('Development','Evaluation')][string]$Profile = 'Development', [ValidateSet('D3D11','D3D12')][string]$Renderer = 'D3D12')
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
$resolution = '1280x720'
$preferencesPath = Join-Path $PSScriptRoot '..\config\dashboard-preferences.json'
if (Test-Path -LiteralPath $preferencesPath) {
    $preferences = Get-Content -LiteralPath $preferencesPath -Raw | ConvertFrom-Json
    if ($preferences.next_launch.quality -in @('Low','Epic')) { $quality = $preferences.next_launch.quality }
    if ($preferences.next_launch.resolution -in @('1280x720','1600x900','1920x1080')) { $resolution = $preferences.next_launch.resolution }
}
$dimensions = $resolution.Split('x')
Write-Host "Launching actual CARLA 0.9.16: $nativeExe ($Profile, $quality, $resolution, $Renderer). See docs/LIVE_NATIVE_VALIDATION.md for gate evidence."
Push-Location -LiteralPath (Split-Path -Parent $nativeExe)
try {
    $nativeProcess = Start-Process -FilePath $nativeExe -ArgumentList "-quality-level=$quality", '-windowed', "-ResX=$($dimensions[0])", "-ResY=$($dimensions[1])", "-$Renderer", '-carla-rpc-port=2000' -WindowStyle Hidden -PassThru -Wait
    if ($nativeProcess.ExitCode -ne 0) { throw "CARLA 0.9.16 BLOCKER: native launcher exited with code $($nativeProcess.ExitCode); inspect CarlaUE4 logs" }
} finally { Pop-Location }
