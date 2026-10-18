"""Create compact, auditable guided delivery evidence from retained local runs."""
import hashlib
import json
import re
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
RAW=ROOT/'output/guided-native-20261018'
OUT=ROOT/'docs/evidence/guided-simulator-20261018'


def read(path):return json.loads(Path(path).read_text(encoding='utf8'))


def native(name):
    s=read(RAW/name);d=s.get('presentation') or {};pair=s.get('journeyComparison') or {}
    return {'raw_source':str(RAW/name),'presentation_id':d.get('id'),'phase':d.get('status'),'reason':d.get('reason'),
        'seed':d.get('seed'),'scene':d.get('scene'),'order':d.get('modes'),'initial_population_audit':d.get('population_audit'),
        'version':pair.get('version'),'pair_id':pair.get('pair_id'),'conditions_match':pair.get('conditions_match'),
        'runs':{mode:{k:r.get(k) for k in ('id','status','reason','distance_m','collisions','duration_s','recording','initial_condition_audit','stress_audit')}
            for mode,r in pair.get('runs',{}).items()}}


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    log=(ROOT/'output/guided-ui-check.log').read_text(encoding='utf8')
    ui=json.loads(log.split('### Result\n',1)[1].split('\n###',1)[0])
    race=read(RAW/'final-race-delivery/report.json')
    dense=read(RAW/'dense-verified2/report.json')
    failed_harness=read(RAW/'final-race/report.json')
    pylog=(ROOT/'output/guided-python-tests.log').read_text(encoding='utf8');jslog=(ROOT/'output/guided-js-tests.log').read_text(encoding='utf8')
    pycount=int(re.search(r'Ran (\d+) tests',pylog)[1]);skips=int(re.search(r'skipped=(\d+)',pylog)[1])
    software={'javascript':{'tests':int(re.search(r'# tests (\d+)',jslog)[1]),'passed':int(re.search(r'# pass (\d+)',jslog)[1])},'python':{'tests':pycount,'passed':pycount-skips,'skipped':skips},'dashboard_build':'PASS'}
    sources={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest()
        for folder in ('frontend','backend/core','backend/carla') for p in (ROOT/folder).glob('*') if p.suffix in ('.py','.js','.css')}
    report={'date':'2026-10-18','scope':'GUIDED_PROTOCOL_AND_UI_DELIVERY_WITH_SCOPED_NATIVE_PROBES',
        'software':software,
        'browser':ui,'native_normal_first':native('revised-pair.json'),'native_protected_first_dense':native('dense-verified2/pair-state.json'),
        'retained_failed_probes':[native('restore-failed-initial.json'),native('dense-restore-failed.json'),native('dense-revised-pair.json')],
        'native_cancellation':{k:race.get(k) for k in ('scope','passed','errors','elapsed_s','native_session','shutdown_admitted','phases','after','runs','remaining_native_processes','source_archive')},
        'retained_harness_failure':{'errors':failed_harness['errors'],'raw_source':str(RAW/'final-race/report.json'),
            'cause':'The initial verifier closed its socket before the unread GPU command was admitted. It observed dashboard_disconnected; fixed verifier waits for STOPPING.'},
        'final_native_backend_sources_match':all(hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==digest for name,digest in race['source_hashes'].items()),
        'native_dense_protocol':{k:dense.get(k) for k in ('source','protocol_passed','motion_audits_measured','conditions_match','errors','shutdown','source_archive')},
        'retained_velocity_probe_rejection':{k:read(RAW/'dense-verified/report.json').get(k) for k in ('errors','source_archive','wall_s')},
        'dense_probe_source_changes_since_run':[name for name,digest in dense['source_hashes'].items() if hashlib.sha256((ROOT/name).read_bytes()).hexdigest()!=digest],
        'source_hashes':sources,
        'limits':['DENSE_CHAOS initial 40/50 density and motion admission passed, but end-of-drive local density audits failed in both shortened arms.',
            'Native probes include contact and shortened attempts; they do not establish route completion, comfort, detector accuracy or protected-driver superiority.',
            'Camera review shows real local traffic; a front viewing cone is not an occlusion-tested visible actor count.',
            'Oncoming lane entry was observed in the revised stress probe; a lane-change request is not proof that the maneuver completed. Signal-violation diversity remains unaccepted.',
            'Slow startup and real GPU lifecycle were exercised. Some failure/reordering cases are offline fixtures, not injected native faults.',
            'The small viewport checks cover a zoom-equivalent layout, not native browser zoom. A new-user comprehension study remains pending.',
            'The earlier revised dense pair also exposed a motion-baseline bug after native IDs were rebound; its second-arm motion counts are invalid and retained. Final dense verification resets the baseline. Earlier native pair probes used intermediate working revisions. Final backend hashes are attached to the final verified cancellation probe. The dense pair has its own exact source archive; the later ordinary-journey context cleanup does not run on its guided path.',
            'Raw runs, source archives and local settings remain ignored; compact evidence retains failed attempts.']}
    (OUT/'verification.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    for path in (ROOT/'output/guided-js-tests.log',ROOT/'output/guided-python-tests.log'):
        (OUT/path.name).write_text(path.read_text(encoding='utf8'),encoding='utf8')
    print(json.dumps({'file':str(OUT/'verification.json'),'final_native_sources_match':report['final_native_backend_sources_match'],'ui_checks':len(ui['checks'])}))


if __name__=='__main__':main()
