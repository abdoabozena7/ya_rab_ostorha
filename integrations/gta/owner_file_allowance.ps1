param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$RequestPath,
    [switch]$Elevated,
    [switch]$ValidateOnly
)
$ErrorActionPreference='Stop'
# The desktop collector can inherit PowerShell 7's module search path. Load
# Windows PowerShell's own signed built-ins explicitly in this process only.
foreach($moduleName in @('Microsoft.PowerShell.Utility','Microsoft.PowerShell.Security')){
    Import-Module (Join-Path $PSHOME "Modules\$moduleName\$moduleName.psd1")
}
$component=[IO.Path]::GetFullPath($PSScriptRoot)
$gameRoot='D:\games\Grand Theft Auto V Enhanced'
$targets=@("$gameRoot\RUNE64.dll","$gameRoot\PlayGTAV.exe","$gameRoot\version.dll")
$output=[IO.Path]::GetFullPath($OutputDirectory)
$proofRoot=Join-Path $component '.runtime-proof'
if(-not $output.StartsWith($proofRoot+'\',[StringComparison]::OrdinalIgnoreCase)){
    throw 'Output must stay inside the component proof directory'
}
function Write-Record($name,$value){
    $value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $output $name) -Encoding UTF8
}
function Assert-Request($request){
    if($request.schema -ne 1 -or $request.operation -ne 'OWNER_THREE_FILE_ALLOWANCE'){
        throw 'Unknown owner operation'
    }
    if($request.request_id -notmatch '^[a-f0-9]{32}$') {throw 'Invalid request identity'}
    if($request.helper_sha256 -ne (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash){
        throw 'Helper source hash mismatch'
    }
    $requested=@($request.targets)
    if($requested.Count -ne 3){throw 'Scope must contain exactly three approved files'}
    foreach($path in $requested){
        if(-not [IO.Path]::IsPathRooted($path) -or $targets -notcontains $path){
            throw 'Path outside approved file scope'
        }
    }
    if(@($requested | Select-Object -Unique).Count -ne 3){throw 'Repeated scope path'}
    if($request.false_positive_proven -ne $false){throw 'False-positive verdict is not established'}
}
if(-not (Test-Path -LiteralPath $output)){New-Item -ItemType Directory -Path $output | Out-Null}
if(-not $RequestPath){
    if($Elevated -or $ValidateOnly){throw 'Explicit request file required'}
    $RequestPath=Join-Path $output 'request.json'
    $request=[ordered]@{schema=1;operation='OWNER_THREE_FILE_ALLOWANCE';request_id=[Guid]::NewGuid().ToString('N');
        helper_sha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash;
        targets=$targets;false_positive_proven=$false;
        owner_authorization='Owner explicitly authorized these GTA files and personally approving the ordinary Windows UAC prompt. No safety verdict, global protection change, game execution or wider file allowance is authorized here.'}
    Write-Record 'request.json' $request
}
$request=Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
Assert-Request $request
if($ValidateOnly){Write-Output 'VALIDATED_NO_MUTATION';exit 0}
foreach($root in @($gameRoot,$output)){
    $cursor=Get-Item -LiteralPath $root
    while($cursor){
        if(($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse-point operation target refused'}
        $cursor=$cursor.Parent
    }
}
if(-not $Elevated){
    Write-Record 'uac-request.json' @{stage='UAC_REQUESTED';request_id=$request.request_id;targets=$targets;automated_uac_interaction=$false}
    Write-Output 'UAC_REQUESTED: the owner must approve the normal Windows prompt.'
    $psExe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments='-NoProfile -NonInteractive -File "'+$PSCommandPath+'" -OutputDirectory "'+$output+'" -RequestPath "'+$RequestPath+'" -Elevated'
    try{
        $child=Start-Process -FilePath $psExe -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru
        Write-Record 'elevated-launch.json' @{pid=$child.Id;request_id=$request.request_id;automated_uac_interaction=$false}
        $deadline=[DateTime]::UtcNow.AddSeconds(300)
        $resultPath=Join-Path $output 'result.json'
        while([DateTime]::UtcNow -lt $deadline){
            if(Test-Path -LiteralPath $resultPath){
                try{$finished=Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json}catch{Start-Sleep -Milliseconds 200;continue}
                if($finished.completed){
                    if($finished.success){exit 0}else{exit 1}
                }
            }
            Start-Sleep -Milliseconds 500
        }
        throw 'Elevated helper result not observed before deadline; inspect it before retrying'
    }catch{
        Write-Record 'uac-error.json' @{error=$_.Exception.Message;request_id=$request.request_id;success=$false}
        throw
    }
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
$result=[ordered]@{success=$false;completed=$false;request_id=$request.request_id;
    helper_sha256=$request.helper_sha256;is_elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
    false_positive_proven=$false;game_started=$false;unrelated_settings_unchanged=$false;targets=$targets;
    started_utc=[DateTime]::UtcNow.ToString('o');added_exclusions=@();files=@();error=$null}
$before=$null
$protectedNames=@('DisableRealtimeMonitoring','DisableBehaviorMonitoring','DisableIOAVProtection','DisableScriptScanning','PUAProtection','MAPSReporting','SubmitSamplesConsent')
function Protection-Snapshot($preferences){
    $snapshot=[ordered]@{}
    foreach($name in $protectedNames){$snapshot[$name]=[string]$preferences.$name}
    return ($snapshot | ConvertTo-Json -Compress)
}
function Invoke-MicrosoftTool([string[]]$ToolArguments){
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=$mp
    $start.Arguments=($ToolArguments | ForEach-Object {'"'+$_+'"'}) -join ' '
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $tool=[Diagnostics.Process]::Start($start)
    $stdout=$tool.StandardOutput.ReadToEndAsync();$stderr=$tool.StandardError.ReadToEndAsync()
    if(-not $tool.WaitForExit(60000)){$tool.Kill();throw 'Microsoft file operation timed out'}
    return @{exit_code=$tool.ExitCode;stdout=$stdout.Result;stderr=$stderr.Result}
}
try{
    if(-not $result.is_elevated){throw 'The OS did not grant an elevated administrator token'}
    $before=Get-MpPreference
    $beforePaths=@($before.ExclusionPath)
    Write-Record 'preferences-before.json' @{exclusions=$beforePaths;protected=(Protection-Snapshot $before)}
    $mp=Get-ChildItem -LiteralPath "$env:ProgramData\Microsoft\Windows Defender\Platform" -Directory |
        Where-Object {$_.Name -match '^\d+\.\d+\.\d+\.\d+-\d+$'} |
        Sort-Object Name -Descending | ForEach-Object {Join-Path $_.FullName 'MpCmdRun.exe'} |
        Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
    if(-not $mp){$mp=Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'}
    $signature=Get-AuthenticodeSignature -LiteralPath $mp
    if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft'){
        throw 'A signed installed Microsoft restore tool is required'
    }
    foreach($path in $targets){
        if($beforePaths -notcontains $path){
            Add-MpPreference -ExclusionPath $path
            $result.added_exclusions+=@($path)
        }
    }
    if(@($targets | Where-Object {@((Get-MpPreference).ExclusionPath) -notcontains $_}).Count){throw 'Exact file exclusions were not applied'}
    # Preference visibility is not proof the running engine has consumed it.
    $engineChecks=@();$engineDeadline=[DateTime]::UtcNow.AddSeconds(30)
    do{
        $engineReady=$true
        foreach($path in $targets){
            $check=Invoke-MicrosoftTool @('-CheckExclusion','-Path',$path)
            $engineChecks+=@(@{path=$path;exit_code=$check.exit_code;stdout=$check.stdout;stderr=$check.stderr})
            if($check.exit_code -ne 0){$engineReady=$false}
        }
        if(-not $engineReady){Start-Sleep -Milliseconds 1000}
    }while(-not $engineReady -and [DateTime]::UtcNow -lt $engineDeadline)
    Write-Record 'engine-exclusion-checks.json' $engineChecks
    if(-not $engineReady){throw 'Running Defender engine did not confirm the exact-file allowance; no broader protection change is attempted'}
    for($index=0;$index -lt $targets.Count;$index++){
        $path=$targets[$index]
        if(-not (Test-Path -LiteralPath $path -PathType Leaf)){
            $restore=Invoke-MicrosoftTool @('-Restore','-FilePath',$path)
            $restore.stdout | Set-Content -LiteralPath (Join-Path $output "restore-$index.stdout.log") -Encoding UTF8
            $restore.stderr | Set-Content -LiteralPath (Join-Path $output "restore-$index.stderr.log") -Encoding UTF8
            $result["restore_${index}_exit_code"]=$restore.exit_code
            if($restore.exit_code -ne 0 -or -not (Test-Path -LiteralPath $path -PathType Leaf)){
                throw ('Exact quarantined file could not be restored: '+$path)
            }
        }
        $readDeadline=[DateTime]::UtcNow.AddSeconds(15)
        do{
            try{$fileHash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash;break}
            catch{if([DateTime]::UtcNow -ge $readDeadline){throw};Start-Sleep -Milliseconds 500}
        }while($true)
        $result.files+=@(@{path=$path;sha256=$fileHash})
    }
    $result.success=$true
}catch{$result.error=$_.Exception.Message}
finally{
    if($before){
        if(-not $result.success){
            try{
                foreach($path in $targets){
                    if($beforePaths -notcontains $path -and @((Get-MpPreference).ExclusionPath) -contains $path){Remove-MpPreference -ExclusionPath $path}
                }
                $result['new_exclusions_rolled_back']=$true
            }catch{$result['rollback_error']=$_.Exception.Message}
        }
        try{
            $after=Get-MpPreference
            $outsideBefore=@($beforePaths | Where-Object {$targets -notcontains $_} | Sort-Object)
            $outsideAfter=@($after.ExclusionPath | Where-Object {$targets -notcontains $_} | Sort-Object)
            $sameOutside=(@($outsideBefore) -join "`n") -eq (@($outsideAfter) -join "`n")
            $result.unrelated_settings_unchanged=$sameOutside -and ((Protection-Snapshot $before) -eq (Protection-Snapshot $after))
            Write-Record 'preferences-after.json' @{exclusions=@($after.ExclusionPath);protected=(Protection-Snapshot $after)}
            if(-not $result.unrelated_settings_unchanged){$result.success=$false;$result.error='Unrelated preferences changed; inspection required'}
        }catch{$result.success=$false;$result['verification_error']=$_.Exception.Message}
    }
    $result.completed=$true;$result['finished_utc']=[DateTime]::UtcNow.ToString('o')
    Write-Record 'result.json' $result
}
if($result.success){exit 0}else{exit 1}
