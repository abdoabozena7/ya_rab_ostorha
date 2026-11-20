"""Bounded native takeover and demonstration test; original budget only."""
import argparse
import json
from pathlib import Path
import goal_probe as goal
import live_probe as live
import preflight
HERE=Path(__file__).resolve().parent
ROOT=preflight.PROJECT/'.runtime-proof/gta-human-demonstrations-20261031/runs'
NATIVE=goal.NATIVE
DIAGNOSTIC=True

def native(output,request):
    request.update(mode='GOAL',demonstration_enabled=True,diagnostic=DIAGNOSTIC)
    preflight.write_json(output/'sensor-request.json',request)
    return NATIVE(output,request)

def main():
    global DIAGNOSTIC
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,required=True);p.add_argument('--build-only',action='store_true');p.add_argument('--user-session',action='store_true');a=p.parse_args()
    DIAGNOSTIC=not a.user_session
    live.ROOT=ROOT;live.validate_scenario=goal.validate
    live.build=lambda out:goal.BUILD(out,native_source='goal_runtime.cpp',scenario='goal-scenario.json',duration_ms=300000)
    live.native=native
    original=live.output_path
    live.output_path=lambda path,check='native-human-demo':original(path,check)
    if a.build_only:
        import subprocess
        subprocess.run(['cmd.exe','/d','/c','npm run build:dashboard'],cwd=preflight.PROJECT,check=True)
        live.build(live.output_path(a.output,'demo-build'));return 0
    live.ordinary(a.output)
    from demo_acceptance import finalize
    result=json.loads((a.output/'live-result.json').read_text());result.update(finalize(a.output))
    preflight.write_json(a.output/'demo-result.json',result)
    fields=('native_toggle_observed','guarded_human_motion','source_aligned_dataset','imitation_boundary_verified','fault_stop_observed','cleanup_confirmed','files_restored','protected_inputs_unchanged')
    return int(not all(result.get(k) for k in fields))
if __name__=='__main__':raise SystemExit(main())
