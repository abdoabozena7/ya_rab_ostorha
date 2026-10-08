"""Production native scenario reset/repeat/control/cleanup acceptance."""
import json
import math
from pathlib import Path
import time
from .verify_urban_world import Session


def main():
    proof={'source':'LIVE_NATIVE','checks':{},'scenarios':[]}
    root=Path('output/native-validation/gate5-scenarios.json')
    with Session() as s:
        s.action('population','reset')
        for kind in ('FRONT_OBSTACLE','SUDDEN_BRAKING'):
            began=time.monotonic()
            s.action('scenario',{'operation':'load','scenario_type':kind,'seed':42,'split':'TRAIN','difficulty':1})
            s.wait(lambda st:st['environment']['scenario_phase']=='READY')
            first=s.state['environment']; first_ids=list(first['actor_ids'].values())
            assert s.inventory()==dict(vehicles=2,walkers=0,controllers=0,sensors=7)
            assert not first['safety_policy']['active']
            initial=first['run']['initial_states']
            s.action('scenario',{'operation':'reset'})
            s.wait(lambda st:st['environment']['scenario_phase']=='READY')
            second=s.state['environment']; second_ids=list(second['actor_ids'].values())
            assert set(first_ids).isdisjoint(second_ids)
            assert second['run']['condition_id']==first['run']['condition_id']
            deviations=[]
            for a,b in zip(initial['actors'],second['run']['initial_states']['actors']):
                delta=math.dist(a['transform']['position_m'],b['transform']['position_m'])
                assert delta<.3,(a,b)
                deviations.append(delta)
            assert s.inventory()==dict(vehicles=2,walkers=0,controllers=0,sensors=7)
            init_sync=json.loads(json.dumps(s.state['synchronization']))
            s.action('scenario',{'operation':'start'})
            actor_id=next(iter(s.state['environment']['actor_ids'].values()))
            speeds=[];controls=[];start=time.monotonic()
            while time.monotonic()-start<7:
                s.wait(lambda st:st['connected'])
                actor=s.world.get_actor(actor_id)
                v=actor.get_velocity();c=actor.get_control()
                speeds.append(math.hypot(v.x,v.y,v.z));controls.append([c.throttle,c.brake,c.steer])
            s.action('scenario',{'operation':'stop'})
            outcome=s.action('scenario',{'operation':'collect_outcome'})
            # APPLIED status returns current environment; the outcome is also
            # retained there, with its baseline identity and null unknown metrics.
            outcome=s.state['environment']['outcome']
            assert not outcome['safety_policy_enabled']
            assert not outcome['scenario_success']  # stationary ego is not rewarded
            if kind=='SUDDEN_BRAKING':
                assert max(speeds)>3.,max(speeds)
                assert any(brake>.9 for _,brake,_ in controls)
                assert speeds[-1]<.3,speeds[-1]
            else:assert max(speeds)<.3,max(speeds)
            final=s.state['synchronization']
            issues={k:final['issues'][k]-init_sync['issues'][k] for k in final['issues']}
            assert not any(issues.values()),issues
            proof['scenarios'].append({'type':kind,'initial_state_deviation_m':deviations,
                'duration_wall_s':time.monotonic()-began,'reset_duration_wall_s':second['run']['reset_duration_wall_s'],
                'speed_range_mps':[min(speeds),max(speeds)],'sync_issues':issues,
                'initial_run':first['run'],'repeat_run':second['run'],'outcome':outcome})
        s.action('scenario',{'operation':'cleanup'})
        assert s.state['environment']['mode']=='LIVING_CITY'
        assert s.inventory()==dict(vehicles=1,walkers=0,controllers=0,sensors=7)
        proof['checks'].update(repeat_initial_conditions=True,native_leader_braking=True,cleanup=True,
                              no_fake_policy=True,stationary_not_success=True,seven_sensors=True)
        proof['pass']=True
        root.write_text(json.dumps(proof,indent=2),encoding='utf8')
    print(json.dumps({'pass':True,'checks':proof['checks'],'runs':len(proof['scenarios'])}))


if __name__=='__main__':main()
