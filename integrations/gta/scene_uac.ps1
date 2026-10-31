param([Parameter(Mandatory=$true)][string]$RequestPath,[switch]$Elevated)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
$component='D:\projects\Ai\ya_rab_ostorha\integrations\gta'
$root=Join-Path $component '.runtime-proof/gta-field-motion-20261031/runs/native-scene-probe'
$request=[IO.Path]::GetFullPath($RequestPath);$output=Split-Path $request
if (([IO.Path]::GetFullPath((Split-Path $output))) -ne ([IO.Path]::GetFullPath($root)) -or
    (Split-Path $request -Leaf) -ne 'sensor-request.json' -or
    (Split-Path $output -Leaf) -notmatch '^\d{8}T\d{6}-[0-9a-f]{10}$') {throw 'Invalid sensor proof path'}
$data=Get-Content -LiteralPath $request -Raw | ConvertFrom-Json
if ($data.operation -ne 'OWNER_GTA_SCENE_PROBE') {throw 'Invalid fixed operation'}
if ((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $data.sources.'scene_uac.ps1') {throw 'Helper changed'}
if (!$Elevated) {
    $argsList=@('-NoProfile','-NonInteractive','-File',('"'+$PSCommandPath+'"'),'-RequestPath',('"'+$request+'"'),'-Elevated')
    $approved=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -ArgumentList $argsList -WindowStyle Hidden -PassThru
    $null=$approved.Handle;$approved.WaitForExit();$approved.Refresh();exit $approved.ExitCode
}
$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (!$admin) {throw 'No user-approved elevated token'}
@{is_elevated=$admin;request_id=$data.id;pid=$PID} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'uac-started.json') -Encoding UTF8
$code=1
try {
    & 'D:\projects\Ai\ya_rab_ostorha\.venv-carla\Scripts\python.exe' -B (Join-Path $component 'scene_probe.py') --worker $request `
        1> (Join-Path $output 'worker.stdout.log') 2> (Join-Path $output 'worker.stderr.log')
    $code=$LASTEXITCODE
} finally {
    @{is_elevated=$admin;request_id=$data.id;worker_exit_code=$code;security_settings_changed=$false} |
      ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'uac-receipt.json') -Encoding UTF8
}
exit $code
