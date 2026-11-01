"""Two owned foundation starts, native controls/cameras, no downstream learning."""
import argparse
import json
from pathlib import Path
import subprocess
import uuid
import socket
import time
import live_probe as live
import preflight
from standard_launch import token_elevation, elevated

HERE=Path(__file__).resolve().parent
ROOT=preflight.PROJECT/'.runtime-proof/gta-foundation-20261031/runs'


def build(out):
    return live.build(out,native_source='foundation_runtime.cpp',duration_ms=120000)


def window_preferences(output):
    # Official documented render-window arguments only. Never set online,
    # authentication, update, anti-cheat or administrator launch arguments.
    path=preflight.GAME.parent/'commandline.txt'
    wanted=b'-windowed\n-width 960\n-height 540\n'
    if path.exists():
        if path.read_bytes()!=wanted:raise ValueError('Existing commandline.txt requires exact merge review; preserved')
    else:
        with path.open('xb') as stream:stream.write(wanted)
    preflight.write_json(output/'window-preference.json',{'path':str(path),'requested_flags':wanted.decode(),
        'source':'https://support.rockstargames.com/articles/2VjbVziQCiTiiVhDbmnexc/full-list-of-command-line-parameters-for-grand-theft-auto-v-on-pc',
        'user_requested_persistent_preference':True,'sha256':live.boot.digest(path)})


def run(output, setup=False):
    if elevated() or live.boot.existing_native():raise RuntimeError('Ordinary token and free native owner required')
    window_preferences(output)
    results=[]
    original=live.boot.OwnedJob
    class ObservedJob(original):
        def members(self):
            members=super().members()
            for pid in members:
                if pid not in live.GAME_TOKENS and live.boot.process_image(pid)==preflight.GAME.resolve():
                    live.GAME_TOKENS[pid]=token_elevation(pid)
                    if live.GAME_TOKENS[pid]:raise RuntimeError('Unexpected elevated game')
            return members
    live.boot.OwnedJob=ObservedJob
    try:
        for index in ((0,) if setup else (1,2,3)):
            folder=output/('launch-%d'%index);folder.mkdir()
            build(folder)
            with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as choice:choice.bind(('127.0.0.1',0));port=choice.getsockname()[1]
            request={'id':uuid.uuid4().hex,'owner':uuid.uuid4().hex,'port':port,'deadline':time.monotonic()+550,'mode':'FOUNDATION'}
            request['startup_only']=bool(not setup and index<3)
            request['settings_setup']=bool(setup)
            preflight.write_json(folder/'sensor-request.json',request)
            if setup:(folder/'settings-mode').touch()
            if index==3:(folder/'foundation-startup-qualified').touch()
            result=live.native(folder,request);results.append(result)
            preflight.write_json(folder/'native-result.json',result)
            preflight.write_json(output/'foundation-progress.json',{'launch':index,'result':result})
            if (output/'STOP_AFTER_OWNED_CLEANUP').exists():break
            if not result.get('story_world_observed') or not result.get('cleanup_confirmed'):break
            if not setup and index<3 and not result.get('unattended_story_observed'):break
    finally:live.boot.OwnedJob=original
    fields=('physical_controls','camera_views','sensor_streams','fault_stops','cleanup_confirmed','files_restored','protected_inputs_unchanged')
    summary={k:bool(results and (all(r.get(k) for r in results) if k in ('cleanup_confirmed','files_restored','protected_inputs_unchanged') else len(results)==3 and results[-1].get(k))) for k in fields}
    summary.update(two_story_starts=len(results)>=2 and all(r.get('unattended_story_observed') for r in results[:2]),
                   windowed_and_dashboard=bool(len(results)==3 and results[-1].get('windowed_and_dashboard')),
                   launches=results,full_migration_accepted=False,training_started=False,human_recording=False,
                   stop_after_foundation=True,owned_game_tokens=live.GAME_TOKENS)
    preflight.write_json(output/'foundation-result.json',summary)
    print(json.dumps({k:v for k,v in summary.items() if k!='launches'},indent=2))
    return int(not all(summary[k] for k in (*fields,'two_story_starts','windowed_and_dashboard')))


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,required=True);p.add_argument('--build-only',action='store_true');p.add_argument('--setup-startup',action='store_true');a=p.parse_args()
    live.ROOT=ROOT
    if a.setup_startup:
        out=a.output.resolve()
        if out.parent!=(preflight.PROJECT/'.runtime-proof/gta-foundation-20261031/setup').resolve():raise ValueError('Scoped preference setup only')
        out.mkdir(parents=True,exist_ok=False)
    else:out=live.output_path(a.output,'foundation-build' if a.build_only else 'native-foundation')
    if a.build_only:
        subprocess.run(['cmd.exe','/d','/c','npm run build:dashboard'],cwd=preflight.PROJECT,check=True)
        build(out);return 0
    return run(out,setup=a.setup_startup)

if __name__=='__main__':raise SystemExit(main())
