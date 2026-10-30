param([Parameter(Mandatory=$true)][string]$RequestPath,[switch]$Elevated)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
$component='D:\projects\Ai\ya_rab_ostorha\integrations\gta'
$root=Join-Path $component '.runtime-proof\gta-uac-bootstrap-20261031\runs\native-bootstrap'
$request=[IO.Path]::GetFullPath($RequestPath)
$output=Split-Path $request
if ((Split-Path $output) -ne $root -or (Split-Path $request -Leaf) -ne 'uac-request.json' -or
    (Split-Path $output -Leaf) -notmatch '^\d{8}T\d{6}-[0-9a-f]{10}$') { throw 'Invalid proof request path' }
$data=Get-Content -LiteralPath $request -Raw | ConvertFrom-Json
if ($data.operation -ne 'OWNER_GTA_UAC_BOOTSTRAP' -or $data.controller_elevated -ne $false -or
    $data.false_positive_proven -ne $false) { throw 'Invalid owner UAC operation' }
if ((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
    $data.source_hashes.'uac_bootstrap.ps1') { throw 'UAC helper changed' }
if (!$Elevated) {
    $engine=Join-Path $PSHOME 'powershell.exe'
    $arguments=@('-NoProfile','-NonInteractive','-File',('"'+$PSCommandPath+'"'),
                 '-RequestPath',('"'+$request+'"'),'-Elevated')
    # Windows shows its normal consent UI. Only the owner can approve it.
    $approved=Start-Process -FilePath $engine -Verb RunAs -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $null=$approved.Handle
    $approved.WaitForExit()
    $approved.Refresh()
    exit $approved.ExitCode
}
$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
       [Security.Principal.WindowsBuiltInRole]::Administrator)
if (!$admin) {throw 'No elevated Windows token'}
@{is_elevated=$admin;request_id=$data.id;pid=$PID;started_utc=[DateTime]::UtcNow.ToString('o')} |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'uac-worker-started.json') -Encoding UTF8
$python='D:\projects\Ai\ya_rab_ostorha\.venv-carla\Scripts\python.exe'
$workerExit=1
try {
    & $python -B (Join-Path $component 'uac_bootstrap.py') --worker $request `
        1> (Join-Path $output 'uac-worker.stdout.log') 2> (Join-Path $output 'uac-worker.stderr.log')
    $workerExit=$LASTEXITCODE
} finally {
    @{is_elevated=$admin;request_id=$data.id;worker_exit_code=$workerExit;pid=$PID;
      game_permission_via_normal_uac=$true;security_settings_changed=$false} |
      ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'uac-receipt.json') -Encoding UTF8
}
exit $workerExit
