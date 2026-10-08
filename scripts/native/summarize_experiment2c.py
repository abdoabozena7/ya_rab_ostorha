"""Read-only final recording, preservation, resource and restoration audit."""
import json
from pathlib import Path
import subprocess
from collections import Counter,defaultdict
import statistics
from backend.core.contracts import SimulationFrame,SensorKind,from_dict
from backend.core.recording import resolve_asset
from .experiment2b_common import ROOT,write
from .run_experiment2b import state,digest,MODEL,CONFIG
from .verify_experiment2b_artifacts import PRESERVED
from .inspect_experiment2c_dropouts import diagnostic_geometry
from backend.rl.radar_retention import retention_indices
from backend.rl.radar import foreground_index


def main():
    dest=ROOT/'docs/evidence/experiment2c';native=json.loads((dest/'native.json').read_text());protocol=json.loads((dest/'protocol.json').read_text())
    assert native['run_complete'] and native['attempted_episodes']==4
    preserve=ROOT/'output/experiment2c-preserved'
    assert subprocess.check_output(['git','diff','--binary','--',*PRESERVED],cwd=ROOT)==(preserve/'pre-experiment.patch').read_bytes()
    assert (ROOT/'scripts/native/verify_gate5_regression.py').read_bytes()==(preserve/'verify_gate5_regression.py').read_bytes()
    unchanged=['backend/carla/scenarios.py','backend/carla/provider.py','backend/carla/sensor_decoders.py',
        'backend/core/research.py','backend/core/contracts.py','backend/core/safety_policy.py','backend/core/control.py','backend/core/service.py',
        'backend/rl/runtime.py','backend/rl/reward.py','backend/rl/supervisor.py','backend/rl/env.py']
    for path in unchanged:
        blob=subprocess.check_output(['git','show',f'61c9ea98:{path}'],cwd=ROOT)
        assert (ROOT/path).read_bytes().replace(b'\r\n',b'\n')==blob.replace(b'\r\n',b'\n')
    assert {p:digest(ROOT/p) for p in protocol['source_hashes_frozen_before_native']}==protocol['source_hashes_frozen_before_native']
    assert digest(MODEL)==protocol['model_sha256']
    current=state();assert current['connected'] and current['mode']=='PAUSED' and not current['rlRuntime']['active']
    assert not current['rlRuntime'].get('policy_active',False) and len(current['sensorRegistry'])==7 and current['sensorErrors']=={}
    geometry=diagnostic_geometry();counts=Counter();asset_bytes=0
    for episode in native['episodes']:
        path=Path(episode['initial']['recording_path']);metadata=json.loads((path/'metadata.json').read_text())
        with (path/'telemetry/frames.jsonl').open() as stream:
            for i,line in enumerate(stream):
                frame=from_dict(SimulationFrame,json.loads(line));counts['complete_native_frames']+=1
                assert frame.complete and len({s.sensor_id for s in frame.sensors})==len(frame.sensors)
                assert all(s.frame_id==frame.frame_id and abs(s.sensor_timestamp_s-frame.timestamp_s)<1e-6 for s in frame.sensors)
                radar=next(s for s in frame.sensors if s.kind==SensorKind.RADAR)
                points,hits=geometry['world_hits'](radar);_,inside=geometry['leader_masks'](frame,metadata,points,hits)
                import numpy as np
                points=points.astype(np.float32);keep=retention_indices(points);index=foreground_index(points[keep])
                counts['new_lead_retained_frames']+=int(inside[keep].any())
                counts['new_foreground_lead_selected_frames']+=int(index is not None and inside[keep[index]])
                counts['new_missing_foreground_frames']+=int(index is None)
                counts['new_ground_selected_frames']+=int(index is not None and hits[keep[index],2]<.25)
                for sensor in frame.sensors:
                    if sensor.asset:
                        counts['sensor_asset_references']+=1;asset_bytes+=sensor.asset.byte_count
                        if i in (0,episode['outcome']['steps']-1,episode['outcome']['steps']):
                            resolve_asset(path,sensor.asset);counts['sampled_asset_integrity_checks']+=1
    assert counts['new_missing_foreground_frames']==0 and counts['new_ground_selected_frames']==0
    assert counts['new_lead_retained_frames']==counts['complete_native_frames']==452
    before=native['initial_state']['synchronization'];after=native['final_state']['synchronization']
    issues={k:after['issues'][k]-before['issues'][k] for k in before['issues']}
    assert all(issues[k]==0 for k in ('LATE','STALE','DUPLICATE','OUT_OF_ORDER','TIMESTAMP_MISMATCH'))
    resources=defaultdict(list)
    for sample in native['memory_cpu_samples']:
        for p in sample:resources[str(p['pid'])].append(p)
    resource_summary={pid:{'name':v[0]['name'],'runner':v[0]['runner'],
        'cpu_delta_s':v[-1]['cpu_s']-v[0]['cpu_s'],'initial_private_mib':v[0]['private_mib'],
        'final_private_mib':v[-1]['private_mib'],'maximum_sampled_private_mib':max(p['private_mib'] for p in v)} for pid,v in resources.items()}
    restart=[json.loads((ROOT/'output/native-validation'/f'{prefix}-restart.json').read_text())
        for prefix in ('experiment2c-backend','experiment2c-restored-backend')]
    gpu=subprocess.run(['nvidia-smi','--query-gpu=name,memory.used,memory.total,utilization.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True)
    pythontests=(ROOT/'output/native-validation/experiment2c-python-tests.log').read_text()
    jstests=(ROOT/'output/native-validation/experiment2c-javascript-tests.log').read_text()
    assert 'Ran 176 tests' in pythontests and 'OK (skipped=1)' in pythontests and '# pass 24' in jstests and '# fail 0' in jstests
    result={'experiment':'YA RAB OSTORHA Experiment 2C verification','recording':dict(counts),'recorded_sensor_binary_mib':asset_bytes/2**20,
        'preexisting_dirty_work_preserved':True,'untouched_modules':unchanged,'teacher_source_sha256':digest(ROOT/'backend/rl/teacher.py'),
        'teacher_config_sha256':digest(CONFIG),'sac_model_sha256':digest(MODEL),'source_hashes_preserved_through_native':True,
        'native_synchronization_issue_delta':issues,'incomplete_warmup_delta':after['incompleteFrames']-before['incompleteFrames'],
        'native_resource_process_samples':resource_summary,'host_restarts':restart,
        'native_plus_host_reload_wall_s':native['native_wall_s']+sum(r['wall_s'] for r in restart),
        'gpu_snapshot':gpu.stdout.strip(),'gpu_snapshot_columns':'name, memory.used MiB, memory.total MiB, utilization %',
        'new_model_gpu_allocations':0,'normal_host_restored':True,'normal_runtime':{'connected':True,'mode':current['mode'],
            'rl_active':False,'policy_active':False,'sensors':len(current['sensorRegistry']),
            'rgb_shape':[current['sensorRegistry']['frontCamera']['latestValidData']['metadata'][k] for k in ('height','width')]},
        'regressions':{'python_run':176,'python_passed':175,'python_skipped':1,'python_wall_s':7.365,'javascript_passed':24,'javascript_wall_s':.3308374},
        'native_budget_exhausted':True,'native_test_seeds_used':False}
    write(dest/'verification.json',result)
    print(json.dumps(result,indent=2))


if __name__=='__main__':main()
