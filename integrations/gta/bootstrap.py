"""Inspect a completed original download; optionally run an owned native probe.

This is only bootstrap evidence. It never trains, creates driving commands,
accepts sensors or retires CARLA/data. args.txt and NativeTrainer are not
installed. Existing game files and Windows/security/account settings are not
changed. A Windows job bounds all children of the one owned game process.
"""
import argparse
import ctypes
from ctypes import wintypes as wt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
import zipfile
import preflight

HERE = Path(__file__).resolve().parent
CANDIDATE = Path(r'C:\Users\A-plus\Downloads\ScriptHookV_3889.0_1158.13.zip')
ARCHIVE_HASH = 'b64c97c3353906f14621e7e9511e4aec2a7d436ecc21ed124d3816585e2e6188'
SOURCE = 'https://www.dev-c.com/files/ScriptHookV_3889.0_1158.13.zip'
VCVARS = Path(r'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat')
RUNTIME_LIMIT = 10800
RESERVATION = 600


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def advertised_versions(readme):
    # The changelog must never be mistaken for the explicit supported-build list.
    section = readme.split('Supported enhanced game versions:', 1)
    if len(section) != 2:
        return []
    section = section[1].split('NATIVE TRAINER', 1)[0]
    values = []
    for prefix, suffix in re.findall(r'(\d+\.\d+\.\d+\.)(\d+(?:/\d+)*)', section):
        values.extend(prefix+part for part in suffix.split('/'))
    return sorted(set(values))


def inspect_candidate():
    if digest(CANDIDATE) != ARCHIVE_HASH:
        raise ValueError('Completed archive changed since inspection; candidate hash mismatch')
    zone = Path(str(CANDIDATE)+':Zone.Identifier').read_text(encoding='utf8').replace('\x00','')
    if ('HostUrl='+SOURCE) not in zone.splitlines():
        raise ValueError('Original download HostUrl provenance missing')
    with zipfile.ZipFile(CANDIDATE) as archive:
        for info in archive.infolist():
            name = info.orig_filename
            if '..' in Path(name).parts or '\\' in name or ':' in name or name.startswith('/'):
                raise ValueError('Unsafe candidate archive path')
        text = archive.read('readme.txt').decode('utf8','replace')
        if 'v3889.0/1158.13' not in text.split('Description:',1)[0]:
            raise ValueError('Wrong archive release')
        versions = advertised_versions(text)
        binaries = {name:archive.read('bin/'+name) for name in ('ScriptHookV.dll','dinput8.dll','xinput1_4.dll')}
        if any(not body.startswith(b'MZ') for body in binaries.values()):
            raise ValueError('Invalid DLL candidate')
    return {'candidate_available':True,'path':str(CANDIDATE),'source_url':SOURCE,
            'bytes':CANDIDATE.stat().st_size,'sha256':ARCHIVE_HASH,'release':'v3889.0/1158.13',
            'installed_build':preflight.file_version(preflight.GAME),'explicit_enhanced_versions':versions,
            'advertised_installed_build':preflight.BUILD in versions,
            'changelog_mentions_installed_build':'v3725.0/1013.20' in text,
            'binary_sha256':{name:hashlib.sha256(body).hexdigest() for name,body in binaries.items()},
            'native_compatibility_verified':False,'policy_sensors_accepted':False}


class RuntimeBudget:
    """One immutable 10800-second grant; unfinished reservations stay charged."""
    def __init__(self, path):
        self.path = path
        self.state = json.loads(path.read_text()) if path.exists() else {
            'grant_id':'user-approved-gta-migration-10800s-20261030',
            'limit_seconds':RUNTIME_LIMIT,'charged_seconds':0.,'reservations':[]}
        if (self.state['limit_seconds'] != RUNTIME_LIMIT or
                not 0 <= self.state['charged_seconds'] <= RUNTIME_LIMIT):
            raise ValueError('Invalid native runtime ledger; no automatic reset')

    def reserve(self, run):
        if self.state['charged_seconds']+RESERVATION > RUNTIME_LIMIT:
            raise ValueError('Insufficient GTA runtime budget')
        item={'id':run,'reserved_seconds':RESERVATION,'finished':False}
        self.state['reservations'].append(item); self.state['charged_seconds']+=RESERVATION
        preflight.write_json(self.path,self.state)
        return item

    def finish(self,item,elapsed):
        if item['finished'] or elapsed < 0 or elapsed > RESERVATION:
            raise ValueError('Invalid runtime close or runtime overrun; keep full charge')
        self.state['charged_seconds']-=RESERVATION-elapsed
        item.update(finished=True,actual_seconds=elapsed)
        preflight.write_json(self.path,self.state)


def samples_qualify(rows,pid,run):
    frames=[r for r in rows if r.get('stage')=='FRAME']
    return (len(frames)>=3 and all(r.get('pid')==pid and r.get('run_id')==run for r in rows)
            and all(b['frame']>a['frame'] and b['game_ms']>a['game_ms'] for a,b in zip(frames,frames[1:])))


def read_samples(path):
    try:
        return [json.loads(line) for line in path.read_text().splitlines() if line]
    except (OSError,ValueError):
        return []


def compile_probe(output):
    # SDK-compatible import declarations, without downloading another SDK/runtime.
    exports=['?scriptRegister@@YAXPEAUHINSTANCE__@@P6AXXZ@Z',
             '?scriptUnregister@@YAXPEAUHINSTANCE__@@@Z','?scriptWait@@YAXK@Z',
             '?nativeInit@@YAX_K@Z','?nativeCall@@YAPEA_KXZ',
             '?getGameVersion@@YA?AW4eGameVersion@@XZ']
    definition=output/'ScriptHookV.def'
    definition.write_text('LIBRARY ScriptHookV.dll\nEXPORTS\n'+'\n'.join(exports)+'\n')
    # These paths are our own collector-generated paths, not shell input.
    for path in (HERE,output,VCVARS):
        if any(c in str(path) for c in '&|<>^%!"\r\n'):
            raise ValueError('Unsafe compiler command path')
    command=(f'call "{VCVARS}" >nul && lib.exe /nologo /machine:x64 '
             f'/def:"{definition}" /out:"{output / "ScriptHookV.lib"}" && '
             f'cl.exe /nologo /LD /MT /EHsc /std:c++17 "{HERE / "bootstrap_probe.cpp"}" '
             f'"{output / "ScriptHookV.lib"}" /Fo"{output / "probe.obj"}" '
             f'/Fe"{output / "OstorhaBootstrap.asi"}"')
    # cmd.exe requires its own outer quoting. Passing this /c payload through
    # list2cmdline adds backslash escapes that cmd treats as literal characters.
    # All interpolated paths were explicitly checked above; no user shell text.
    completed=subprocess.run('cmd.exe /d /s /c "'+command+'"',
                             cwd=output,capture_output=True,timeout=90)
    (output/'build.stdout.log').write_bytes(completed.stdout)
    (output/'build.stderr.log').write_bytes(completed.stderr)
    if completed.returncode:
        raise RuntimeError('Native probe compilation failed; inspect build logs')
    return output/'OstorhaBootstrap.asi'


class OwnedJob:
    """Terminate only this launch and its descendants, even if a launcher exits."""
    def __init__(self):
        self.api=ctypes.WinDLL('kernel32',use_last_error=True)
        self.api.CreateJobObjectW.restype=wt.HANDLE
        self.api.SetInformationJobObject.argtypes=[wt.HANDLE,ctypes.c_int,ctypes.c_void_p,wt.DWORD]
        self.api.AssignProcessToJobObject.argtypes=[wt.HANDLE,wt.HANDLE]
        self.api.TerminateJobObject.argtypes=[wt.HANDLE,wt.UINT]
        self.api.QueryInformationJobObject.argtypes=[wt.HANDLE,ctypes.c_int,ctypes.c_void_p,wt.DWORD,ctypes.c_void_p]
        self.api.CloseHandle.argtypes=[wt.HANDLE]
        self.handle=self.api.CreateJobObjectW(None,None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        # JOBOBJECT_EXTENDED_LIMIT_INFORMATION, x64. Set KillOnJobClose flag.
        info=ctypes.create_string_buffer(144)
        ctypes.c_uint32.from_buffer(info,16).value=0x2000
        if not self.api.SetInformationJobObject(self.handle,9,info,144):
            raise ctypes.WinError(ctypes.get_last_error())

    def assign(self,process):
        if not self.api.AssignProcessToJobObject(self.handle,wt.HANDLE(int(process._handle))):
            raise ctypes.WinError(ctypes.get_last_error())

    def members(self):
        info=ctypes.create_string_buffer(8+8*256)
        if not self.api.QueryInformationJobObject(self.handle,3,info,len(info),None):
            raise ctypes.WinError(ctypes.get_last_error())
        count=ctypes.c_uint32.from_buffer(info,4).value
        return list((ctypes.c_size_t*count).from_buffer(info,8))

    def stop(self):
        if not self.api.TerminateJobObject(self.handle,0):
            raise ctypes.WinError(ctypes.get_last_error())
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            info=ctypes.create_string_buffer(48)
            if not self.api.QueryInformationJobObject(self.handle,1,info,48,None):
                raise ctypes.WinError(ctypes.get_last_error())
            if ctypes.c_uint32.from_buffer(info,40).value==0: # ActiveProcesses
                self.api.CloseHandle(self.handle); return True
            time.sleep(.1)
        return False


def existing_native():
    script="Get-CimInstance Win32_Process -Filter \"Name = 'GTA5_Enhanced.exe' OR Name = 'PlayGTAV.exe' OR Name = 'GTA5_Enhanced_BE.exe' OR Name = 'CarlaUE4.exe' OR Name = 'CarlaUE4-Win64-Shipping.exe'\" | Select-Object Name,ProcessId | ConvertTo-Json -Compress"
    result=subprocess.run(['powershell.exe','-NoProfile','-Command',script],capture_output=True,text=True,timeout=30,check=True)
    return json.loads(result.stdout) if result.stdout.strip() else []


def process_image(pid):
    api=ctypes.WinDLL('kernel32',use_last_error=True)
    api.OpenProcess.argtypes=[wt.DWORD,wt.BOOL,wt.DWORD]; api.OpenProcess.restype=wt.HANDLE
    api.QueryFullProcessImageNameW.argtypes=[wt.HANDLE,wt.DWORD,wt.LPWSTR,ctypes.POINTER(wt.DWORD)]
    api.CloseHandle.argtypes=[wt.HANDLE]
    handle=api.OpenProcess(0x1000,False,pid)
    if not handle:
        return None
    try:
        name=ctypes.create_unicode_buffer(32768); length=wt.DWORD(len(name))
        if not api.QueryFullProcessImageNameW(handle,0,name,ctypes.byref(length)):
            return None
        return Path(name.value).resolve()
    finally:api.CloseHandle(handle)


def security_observation():
    # Read only project-related detection metadata. Never restore quarantine,
    # create exclusions, change Defender preferences or alter security services.
    script=("$d=@(Get-MpThreatDetection -ErrorAction Stop | Where-Object { "
            "($_.Resources -join ' ') -like '*Grand Theft Auto V Enhanced*' }); "
            "$ids=@($d | Select-Object -ExpandProperty ThreatID -Unique); "
            "$t=@(Get-MpThreat -ErrorAction Stop | Where-Object { $_.ThreatID -in $ids }); "
            "[pscustomobject]@{ActiveProjectThreats=@($t | Where-Object { $_.IsActive } | "
            "Select-Object ThreatID,ThreatName,SeverityID,IsActive); "
            "ProjectThreats=@($t | Select-Object ThreatID,ThreatName,SeverityID,IsActive); "
            "Detections=@($d | Select-Object ThreatID,InitialDetectionTime,"
            "LastThreatStatusChangeTime,ActionSuccess,ThreatStatusID,Resources)} | ConvertTo-Json -Depth 8")
    completed=subprocess.run(['powershell.exe','-NoProfile','-Command',script],
                             capture_output=True,text=True,timeout=30,check=True)
    return json.loads(completed.stdout)


def load_owner_allowance():
    """Consume the separately verified exact-file operation, never a clean verdict."""
    manifest=HERE/'downloads/owner-file-allowance.json'
    if not manifest.exists():
        return None
    wrapper=json.loads(manifest.read_text())
    result_path=Path(wrapper['result_path']).resolve()
    root=(HERE/'.runtime-proof/gta-owner-allowance-20261031').resolve()
    if (wrapper.get('schema')!=1 or wrapper.get('operation')!='OWNER_THREE_FILE_ALLOWANCE'
            or wrapper.get('false_positive_proven') is not False
            or not result_path.is_relative_to(root) or result_path.name!='result.json'
            or digest(result_path)!=wrapper['result_sha256']):
        raise ValueError('Owner allowance provenance mismatch')
    result=json.loads(result_path.read_text(encoding='utf-8-sig'))
    expected={str((preflight.GAME.parent/name).resolve()) for name in ('RUNE64.dll','PlayGTAV.exe','version.dll')}
    actual={str(Path(p).resolve()) for p in result.get('targets',[])}
    if (actual!=expected or len(result.get('files',[]))!=3 or result.get('success') is not True
            or result.get('is_elevated') is not True or result.get('unrelated_settings_unchanged') is not True
            or result.get('false_positive_proven') is not False or result.get('game_started') is not False
            or result.get('request_id')!=wrapper.get('request_id')
            or result.get('helper_sha256','').lower()!=digest(HERE/'owner_file_allowance.ps1')):
        raise ValueError('Owner allowance result is incomplete or stale')
    hashed=set()
    for item in result['files']:
        path=Path(item['path']).resolve()
        if str(path) not in expected or digest(path)!=item['sha256'].lower():
            raise ValueError('An owner-allowed game file changed')
        hashed.add(str(path))
    if hashed!=expected:
        raise ValueError('Owner allowance hashes omit an approved file')
    wanted=','.join("'"+str(preflight.GAME.parent/name).replace("'","''")+"'"
                    for name in ('RUNE64.dll','PlayGTAV.exe','version.dll'))
    command=("$wanted=@("+wanted+"); $actual=@((Get-MpPreference).ExclusionPath); "
             "$readback=if($actual.Count -eq 1 -and $actual[0] -eq 'N/A: Must be an administrator to view exclusions')"
             "{[pscustomobject]@{visibility='administrator-only';matches=$null}}"
             "else{[pscustomobject]@{visibility='readable';matches=@($wanted | ForEach-Object {$actual -contains $_})}}; "
             "$readback | ConvertTo-Json -Compress")
    current=subprocess.run(['powershell.exe','-NoProfile','-Command',command],
                           capture_output=True,text=True,timeout=30,check=True)
    readback=json.loads(current.stdout)
    validate_exclusion_readback(readback)
    return {'verified':True,'request_id':result['request_id'],'result_sha256':wrapper['result_sha256'],
            'false_positive_proven':False,'allowed_threat_ids':[298189,2147939874],
            'current_exclusion_visibility':readback['visibility'],
            'scope':'Three unchanged, hash-bound local GTA files only; no other detection is admitted'}


def validate_exclusion_readback(readback):
    # A normal game process cannot read administrator-only preferences. That
    # explicit OS response is not evidence the verified admin operation vanished.
    # In that case the caller has already verified the admin result/source and
    # all current file hashes; no present-tense engine-query claim is made.
    if readback.get('visibility')=='administrator-only' and readback.get('matches') is None:
        return
    if readback.get('visibility')=='readable' and readback.get('matches')==[True,True,True]:
        return
    raise ValueError('Exact-file owner exclusions absent or readback unrecognized')


def require_clean_security(observation,owner_allowance=None):
    active=observation.get('ActiveProjectThreats',[])
    if active:
        if (owner_allowance and owner_allowance.get('verified') is True
                and owner_allowance.get('false_positive_proven') is False
                and set(owner_allowance.get('allowed_threat_ids',[]))=={298189,2147939874}
                and all(item.get('ThreatID') in (298189,2147939874) for item in active)):
            return
        raise RuntimeError('Windows protection flags this installation; no quarantine restoration, exclusions or repeated launch attempt is performed')


def native_probe(output,candidate,outer_deadline=None):
    result={'bootstrap_verified':False,'cleanup_confirmed':False,'files_restored':False,
            'training_started':False,'full_capability_accepted':False,'candidate':candidate,
            'native_runtime_seconds':0.,'run_id':uuid.uuid4().hex}
    installed=[]; process=None; job=None; budget=None; reservation=None; started=None
    storage=HERE/'downloads'; lock=storage/'native-bootstrap.lock'
    with lock.open('x') as stream:
        stream.write(str(os.getpid()))
    try:
        if outer_deadline is not None and time.monotonic()+110>=outer_deadline:
            raise ValueError('Insufficient remaining UAC worker deadline; no launch')
        if candidate['installed_build'] != preflight.BUILD:
            raise ValueError('Installed build changed')
        result['native_processes_before']=existing_native()
        if result['native_processes_before']:
            raise RuntimeError('Another native simulator/game already owns this host')
        game=preflight.GAME.parent
        for name in ('ScriptHookV.dll','dinput8.dll','xinput1_4.dll','OstorhaBootstrap.asi'):
            if (game/name).exists():
                raise RuntimeError('Refuse to overwrite existing game dependency/probe: '+name)
        if list(game.glob('*.asi')):
            raise RuntimeError('Other ASI plugins require inspection before this isolated probe')
        before=preflight.protected_inventory(); preflight.write_json(output/'protected-before.json',before)
        result['security_observation']=security_observation()
        preflight.write_json(output/'security-observation.json',result['security_observation'])
        result['owner_file_allowance']=load_owner_allowance()
        require_clean_security(result['security_observation'],result['owner_file_allowance'])
        probe=compile_probe(output)
        payloads={'OstorhaBootstrap.asi':probe.read_bytes()}
        with zipfile.ZipFile(CANDIDATE) as archive:
            # dumpbin /dependents on this actual Enhanced executable lists
            # XINPUT1_4.dll, not dinput8.dll. Use the supplied loader it imports.
            for name in ('ScriptHookV.dll','xinput1_4.dll'):
                payloads[name]=archive.read('bin/'+name)
        for name,body in payloads.items():
            target=game/name
            with target.open('xb') as stream:
                stream.write(body)
            installed.append((target,hashlib.sha256(body).hexdigest()))
        preflight.write_json(output/'install-manifest.json',{'new_files':[{ 'path':str(p),'sha256':h} for p,h in installed],
            'not_installed':['args.txt','dinput8.dll','NativeTrainer.asi'],'candidate_hash':ARCHIVE_HASH})
        budget=RuntimeBudget(storage/'native-runtime-ledger.json'); reservation=budget.reserve(result['run_id'])
        started=time.monotonic()
        job=OwnedJob()
        env={**os.environ,'OSTORHA_BOOTSTRAP_LOG':str(output/'native-frames.jsonl'),
             'OSTORHA_BOOTSTRAP_ID':result['run_id']}
        with (output/'game.stdout.log').open('wb') as stdout,(output/'game.stderr.log').open('wb') as stderr:
            # This is the target of the user's existing public-desktop shortcut.
            # Launching the game binary directly exited 0x1337 before hook load.
            launcher=game/'PlayGTAV.exe'
            result['launcher_path']=str(launcher); result['launcher_sha256']=digest(launcher)
            try:
                process=subprocess.Popen([str(launcher)],cwd=game,env=env,stdout=stdout,stderr=stderr)
            except OSError as error:
                if getattr(error,'winerror',None)!=740:
                    raise
                # The launcher requires elevation. The restored, hash-checked
                # game executable can be tested normally without changing UAC
                # policy or suppressing a requested permission prompt.
                result['launcher_requires_elevation']=True
                launcher=preflight.GAME
                result['launcher_fallback']='Existing game executable with ordinary token'
                result['launcher_path']=str(launcher); result['launcher_sha256']=digest(launcher)
                process=subprocess.Popen([str(launcher)],cwd=game,env=env,stdout=stdout,stderr=stderr)
            result['owned_launcher_pid']=process.pid
            try:
                job.assign(process)
            except Exception:
                process.terminate(); process.wait(timeout=15); raise
            print(json.dumps({'stage':'GTA_LAUNCHER_STARTED','owned_launcher_pid':process.pid,'run_id':result['run_id']}),flush=True)
            preflight.write_json(output/'native-progress.json',{**result,'stage':'LAUNCHER_STARTED'})
            seen_game_pids=set()
            deadline=min(started+240,outer_deadline-20) if outer_deadline is not None else started+240
            while time.monotonic()<deadline:
                rows=read_samples(output/'native-frames.jsonl')
                members=job.members()
                game_pids=[pid for pid in members if process_image(pid)==preflight.GAME.resolve()]
                seen_game_pids.update(game_pids)
                for pid in game_pids:
                    if samples_qualify(rows,pid,result['run_id']):
                        result.update(bootstrap_verified=True,samples=len(rows),owned_game_pid=pid)
                if result['bootstrap_verified']:break
                if not members:
                    result['launcher_exit_code']=process.poll(); break
                time.sleep(.5)
            if not result['bootstrap_verified']:
                result['error']='No matching advancing in-game probe frames before exit/deadline'
            result['observed_game_pids']=sorted(seen_game_pids)
        result['owned_members_before_stop']=job.members()
        preflight.write_json(output/'native-progress.json',{**result,'stage':'STOPPING_OWNED_JOB'})
        result['cleanup_confirmed']=job.stop(); job=None
        process.wait(timeout=15)
    except Exception as error:
        result['error']=str(error)
    finally:
        preflight.write_json(output/'native-progress.json',{**result,'stage':'FINALLY_ENTERED'})
        if job is not None:
            try:result['cleanup_confirmed']=job.stop()
            except Exception as error:result['cleanup_error']=str(error)
        elif process is None:
            result['cleanup_confirmed']=True # no native process was started
        if started is not None:
            result['native_runtime_seconds']=time.monotonic()-started
            try:budget.finish(reservation,result['native_runtime_seconds'])
            except Exception as error:result['budget_error']=str(error)
        if result['cleanup_confirmed']:
            for path,expected in installed:
                try:
                    if path.is_file() and digest(path)==expected:
                        until=time.monotonic()+5
                        while True:
                            try:path.unlink();break # Newly installed, owned, hash-matched file only.
                            except PermissionError:
                                if time.monotonic()>=until:raise
                                time.sleep(.25)
                    elif path.exists():
                        result['restore_error']='Owned temporary file changed; preserved for inspection: '+str(path)
                except OSError as error:
                    result['restore_error']=str(error)
            result['files_restored']=all(not p.exists() for p,_ in installed)
            if result['files_restored']:lock.unlink()
        preflight.write_json(output/'native-progress.json',{**result,'stage':'CHECKING_PROTECTED_INPUTS'})
        if 'before' in locals():
            try:
                after=preflight.protected_inventory(); preflight.write_json(output/'protected-after.json',after)
                result['protected_inputs_unchanged']=before==after
            except Exception as error:
                result.update(protected_inputs_unchanged=False,protected_inventory_error=str(error))
        for name in ('ScriptHookV.log','asiloader.log'):
            source=preflight.GAME.parent/name
            if source.is_file():
                (output/name).write_bytes(source.read_bytes())
        if budget:
            result['budget']=budget.state
        preflight.write_json(output/'native-result.json',result)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True); parser.add_argument('--native',action='store_true')
    args=parser.parse_args(); output=args.output.resolve(); output.mkdir(parents=True,exist_ok=True)
    candidate=inspect_candidate(); preflight.write_json(output/'candidate.json',candidate)
    if not args.native:
        print(json.dumps(candidate,indent=2)); return 0
    result=native_probe(output,candidate); print(json.dumps(result,indent=2))
    return 0 if (result['bootstrap_verified'] and result['cleanup_confirmed'] and result['files_restored']
                 and result.get('protected_inputs_unchanged') and not result.get('budget_error')) else 1


if __name__=='__main__':
    raise SystemExit(main())
