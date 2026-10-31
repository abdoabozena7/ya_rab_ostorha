"""Owner-requested exact per-game RUNASADMIN removal; ordinary launches only."""
import argparse
import ctypes
from ctypes import wintypes as wt
import hashlib
import json
from pathlib import Path
import winreg
import bootstrap as boot
import preflight
from uac_bootstrap import elevated

HERE=Path(__file__).resolve().parent
KEY=r'Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'
LAUNCHER=preflight.GAME.parent/'PlayGTAV.exe'
TASK=HERE/'.runtime-proof/gta-standard-owner-20261031/runs/two-standard-native-starts'


def compatibility():
    values={}
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER,KEY) as key:
        index=0
        while True:
            try:name,value,kind=winreg.EnumValue(key,index);index+=1
            except OSError:break
            values[name]=(value,kind)
    return values


def exact_entry(values):
    names=[name for name in values if str(Path(name).resolve()).casefold()==str(LAUNCHER.resolve()).casefold()]
    if len(names)!=1:raise ValueError('Expected one exact owner-selected launcher compatibility value')
    name=names[0];value,kind=values[name]
    if kind!=winreg.REG_SZ or value.strip().upper()!='RUNASADMIN':raise ValueError('Unexpected compatibility value; not modified')
    return name


def policy():
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,r'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System') as key:
        return {name:winreg.QueryValueEx(key,name) for name in ('EnableLUA','ConsentPromptBehaviorAdmin','PromptOnSecureDesktop')}


def token_elevation(pid):
    kernel=ctypes.WinDLL('kernel32',use_last_error=True);advapi=ctypes.WinDLL('advapi32',use_last_error=True)
    kernel.OpenProcess.argtypes=[wt.DWORD,wt.BOOL,wt.DWORD];kernel.OpenProcess.restype=wt.HANDLE
    kernel.CloseHandle.argtypes=[wt.HANDLE]
    advapi.OpenProcessToken.argtypes=[wt.HANDLE,wt.DWORD,ctypes.POINTER(wt.HANDLE)]
    advapi.GetTokenInformation.argtypes=[wt.HANDLE,ctypes.c_int,ctypes.c_void_p,wt.DWORD,ctypes.POINTER(wt.DWORD)]
    process=kernel.OpenProcess(0x1000,False,pid);token=wt.HANDLE()
    if not process:raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not advapi.OpenProcessToken(process,8,ctypes.byref(token)):raise ctypes.WinError(ctypes.get_last_error())
        value=wt.DWORD();size=wt.DWORD()
        if not advapi.GetTokenInformation(token,20,ctypes.byref(value),ctypes.sizeof(value),ctypes.byref(size)):raise ctypes.WinError(ctypes.get_last_error())
        return bool(value.value)
    finally:
        if token:kernel.CloseHandle(token)
        kernel.CloseHandle(process)


def qualified(result,tokens):
    pid=result.get('owned_game_pid')
    return bool(result.get('bootstrap_verified') and result.get('cleanup_confirmed') and result.get('files_restored')
                and result.get('protected_inputs_unchanged') and pid in tokens and tokens[pid] is False
                and not result.get('budget_error'))


def run(output):
    output=output.resolve()
    if output.parent!=TASK.resolve():raise ValueError('Outside dedicated standard-launch proof run')
    if elevated():raise ValueError('An ordinary owner process is required')
    if boot.existing_native():raise RuntimeError('Native host occupied')
    before=compatibility();name=exact_entry(before);uac_before=policy();candidate=boot.inspect_candidate()
    others={k:v for k,v in before.items() if k!=name};other_hash=hashlib.sha256(json.dumps(others,sort_keys=True).encode()).hexdigest()
    preflight.write_json(output/'compatibility-before.json',{'target':name,'value':before[name],
           'other_values_sha256':other_hash,'uac':uac_before,'launcher_sha256':boot.digest(LAUNCHER)})
    result={'two_normal_launches_verified':False,'global_uac_unchanged':False,'other_compatibility_unchanged':False,
            'launches':[],'training_started':False,'full_migration_accepted':False,'controller_elevated':False}
    removed=False;original_class=boot.OwnedJob;tokens={}
    class ObservedJob(original_class):
        def members(self):
            members=super().members()
            for pid in members:
                if pid not in tokens and boot.process_image(pid)==preflight.GAME.resolve():
                    tokens[pid]=token_elevation(pid)
                    if tokens[pid]:raise RuntimeError('Owned game unexpectedly elevated; ordinary start not qualified')
            return members
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,KEY,0,winreg.KEY_QUERY_VALUE|winreg.KEY_SET_VALUE) as key:
            if winreg.QueryValueEx(key,name)!=before[name]:raise ValueError('Compatibility changed before mutation')
            winreg.DeleteValue(key,name);removed=True
        boot.OwnedJob=ObservedJob
        for index in (1,2):
            folder=output/('launch-%d'%index);folder.mkdir()
            native=boot.native_probe(folder,candidate)
            entry={'index':index,'native':native,'owned_game_tokens':dict(tokens),'normal_launch_verified':qualified(native,tokens)}
            result['launches'].append(entry);preflight.write_json(output/'standard-progress.json',entry)
            if not entry['normal_launch_verified']:raise RuntimeError('Actual ordinary launch failed; inspect native evidence')
        result['two_normal_launches_verified']=True
    except Exception as error:result['error']=str(error)
    finally:
        boot.OwnedJob=original_class
        after=compatibility();result['global_uac_unchanged']=policy()==uac_before
        result['other_compatibility_unchanged']={k:v for k,v in after.items() if k!=name}==others
        success=result['two_normal_launches_verified'] and result['global_uac_unchanged'] and result['other_compatibility_unchanged']
        if removed and not success:
            if name not in after:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER,KEY,0,winreg.KEY_SET_VALUE) as key:winreg.SetValueEx(key,name,0,before[name][1],before[name][0])
                result['owner_flag_restored_after_failure']=True
            else:result['restore_conflict']='Current launcher preference changed; preserved'
        result['runasadmin_removed']=name not in compatibility();preflight.write_json(output/'standard-result.json',result)
    print(json.dumps({k:v for k,v in result.items() if k!='launches'},indent=2))
    return int(not (result['two_normal_launches_verified'] and result['global_uac_unchanged'] and result['other_compatibility_unchanged']))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True);raise SystemExit(run(parser.parse_args().output))
