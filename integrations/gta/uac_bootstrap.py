"""Normal owner-approved UAC launch; reuse the existing owned-job native probe.

No consent automation, policy changes, unrestricted commands or budget resets.
The elevated worker accepts only a recent hash-bound request in its proof run.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
import bootstrap
import preflight

HERE=Path(__file__).resolve().parent
RUN_ROOT=HERE/'.runtime-proof/gta-uac-bootstrap-20261031/runs/native-bootstrap'
SOURCES=('uac_bootstrap.py','uac_bootstrap.ps1','bootstrap.py','bootstrap_probe.cpp','preflight.py',
         'owner_file_allowance.ps1','downloads/owner-file-allowance.json')


def elevated():
    return bool(ctypes.windll.shell32.IsUserAnAdmin())


def validate_output(output):
    # Inspect original parents too: resolve() alone would hide a junction.
    for parent in (output,*output.parents):
        if parent.exists() and getattr(parent.stat(),'st_file_attributes',0)&0x400:
            raise ValueError('Reparse point in UAC output path')
    path=output.resolve()
    if path.parent!=RUN_ROOT.resolve() or not re.fullmatch(r'\d{8}T\d{6}-[0-9a-f]{10}',path.name):
        raise ValueError('UAC output must be an actual scoped proof run')
    return path


def validate_request(path,now=None):
    path=path.resolve(); output=validate_output(path.parent)
    if path.name!='uac-request.json':raise ValueError('Unexpected UAC request name')
    data=json.loads(path.read_text())
    now=time.monotonic() if now is None else now
    if (data.get('schema')!=1 or data.get('operation')!='OWNER_GTA_UAC_BOOTSTRAP'
            or not re.fullmatch('[0-9a-f]{32}',data.get('id',''))
            or data.get('controller_elevated') is not False
            or data.get('false_positive_proven') is not False
            or not now<data.get('deadline',0)<=now+550
            or set(data.get('source_hashes',{}))!=set(SOURCES)):
        raise ValueError('Invalid, expired or broadened UAC request')
    for source,expected in data['source_hashes'].items():
        if bootstrap.digest(HERE/source)!=expected:raise ValueError('UAC source changed: '+source)
    if bootstrap.digest(preflight.GAME.parent/'PlayGTAV.exe')!=data.get('launcher_sha256'):
        raise ValueError('Existing launcher changed')
    return output,data


def worker(request_path):
    output,data=validate_request(request_path)
    if not elevated():raise RuntimeError('The worker did not receive an elevated token')
    candidate=bootstrap.inspect_candidate();preflight.write_json(output/'candidate.json',candidate)
    result=bootstrap.native_probe(output,candidate,outer_deadline=data['deadline'])
    result.update(uac_worker_elevated=True,uac_request_id=data['id'],false_positive_proven=False)
    preflight.write_json(output/'native-result.json',result)
    return int(not (result['bootstrap_verified'] and result['cleanup_confirmed'] and result['files_restored']
                   and result.get('protected_inputs_unchanged') and not result.get('budget_error')))


def controller(output):
    output=validate_output(output)
    if elevated():raise RuntimeError('Start the controller normally; do not bypass the user UAC step')
    if not bootstrap.load_owner_allowance():raise RuntimeError('No verified exact-file owner allowance')
    bootstrap.inspect_candidate()
    if bootstrap.existing_native():raise RuntimeError('Another native game/simulator already owns this host')
    ledger=HERE/'downloads/native-runtime-ledger.json'
    budget=bootstrap.RuntimeBudget(ledger)
    # Keep room for the child's reservation too. Reload before closing ours so
    # its actual runtime/history can never be overwritten by a stale snapshot.
    if budget.state['charged_seconds']+2*bootstrap.RESERVATION>bootstrap.RUNTIME_LIMIT:
        raise RuntimeError('Insufficient original grant for UAC plus owned-child reservations')
    identifier=uuid.uuid4().hex; item=budget.reserve('uac-'+identifier); started=time.monotonic()
    request={'schema':1,'operation':'OWNER_GTA_UAC_BOOTSTRAP','id':identifier,
             'controller_pid':os.getpid(),'controller_elevated':False,'false_positive_proven':False,
             'deadline':started+550,'source_hashes':{s:bootstrap.digest(HERE/s) for s in SOURCES},
             'launcher_sha256':bootstrap.digest(preflight.GAME.parent/'PlayGTAV.exe')}
    request_path=output/'uac-request.json';preflight.write_json(request_path,request)
    timed_out=False; result={}; code=1
    try:
        command=[str(Path(os.environ['SystemRoot'])/'System32/WindowsPowerShell/v1.0/powershell.exe'),
                 '-NoProfile','-NonInteractive','-File',str(HERE/'uac_bootstrap.ps1'),
                 '-RequestPath',str(request_path)]
        with (output/'uac-controller.stdout.log').open('wb') as stdout,(output/'uac-controller.stderr.log').open('wb') as stderr:
            completed=subprocess.run(command,stdout=stdout,stderr=stderr,timeout=600)
        code=completed.returncode
    except subprocess.TimeoutExpired:
        timed_out=True
    finally:
        result_path=output/'native-result.json'
        if result_path.exists():result=json.loads(result_path.read_text())
        else:
            result={'bootstrap_verified':False,'cleanup_confirmed':False,'files_restored':False,
                    'training_started':False,'full_capability_accepted':False,'native_runtime_seconds':0.,
                    'error':'UAC worker timed out' if timed_out else 'UAC denied or worker did not produce native evidence'}
        elapsed=time.monotonic()-started
        if not timed_out and elapsed<=bootstrap.RESERVATION:
            current=bootstrap.RuntimeBudget(ledger)
            parent=next(r for r in current.state['reservations'] if r['id']==item['id'])
            # The child already charged native time. Charge all UAC/build/guard
            # overhead separately; uncertainty retains the full reservation.
            child=float(result.get('native_runtime_seconds',0.))
            current.finish(parent,max(0.,elapsed-child))
        result.update(uac_controller_elevated=False,uac_request_id=identifier,
                      uac_wall_seconds=elapsed,uac_controller_exit_code=code,
                      budget=json.loads(ledger.read_text()),false_positive_proven=False)
        preflight.write_json(result_path,result)
    print(json.dumps(result,indent=2))
    return 0 if code==0 and result.get('bootstrap_verified') else 1


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--output',type=Path);mode.add_argument('--worker',type=Path)
    args=parser.parse_args()
    return worker(args.worker) if args.worker else controller(args.output)


if __name__=='__main__':raise SystemExit(main())
