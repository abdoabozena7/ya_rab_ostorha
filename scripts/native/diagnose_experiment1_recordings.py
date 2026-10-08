"""Offline diagnosis of authentic recordings and frozen SAC weights.

No simulator access, training, optimizer steps, weight saving, or sensor editing.
World geometry is used only in labeled diagnostic measurements, never inference.
"""
from collections import Counter, defaultdict
from dataclasses import replace
import hashlib
import json
import math
from pathlib import Path
import numpy as np
import torch
from stable_baselines3 import SAC
from backend.core.contracts import ControlCommand, CommandSource, SensorKind
from backend.core.replay import ReplayReader
from backend.core.safety_policy import sensor_observation
from backend.rl.observations import ObservationAssembler, CONFIGS
from backend.rl.supervisor import policy_features, decide_intervention

ROOT=Path(__file__).resolve().parents[2]
RUN=ROOT/'runs/experiments/experiment1_20261008T165154Z'
DEST=ROOT/'docs/evidence/experiment1-1'


def rows(path):
    with path.open(encoding='utf8') as f:
        return [json.loads(line) for line in f if line.strip()]


def write(path,value):
    path.write_text(json.dumps(value,indent=2,allow_nan=False)+'\n',encoding='utf8')


def distribution(values):
    a=np.asarray(values,dtype=float)
    return {'n':len(a),'min':float(a.min()),'max':float(a.max()),'mean':float(a.mean()),
            'std':float(a.std()),'p05':float(np.percentile(a,5)),'median':float(np.median(a)),
            'p95':float(np.percentile(a,95))}


def rotation(rotation):
    r,p,y=(rotation[k] for k in ('roll','pitch','yaw'))
    cr,sr,cp,sp,cy,sy=math.cos(r),math.sin(r),math.cos(p),math.sin(p),math.cos(y),math.sin(y)
    # CARLA left-handed native Transform matrix, including pitch/roll.
    return np.array([[cp*cy,cy*sp*sr-sy*cr,-cy*sp*cr-sy*sr],
                     [cp*sy,sy*sp*sr+cy*cr,-sy*sp*cr+cy*sr],
                     [sp,-cp*sr,cp*cr]])


def world_hits(sensor):
    detections=sensor.data['detections']
    d=np.array([[v[k] for k in ('depth_m','azimuth_rad','altitude_rad','velocity_mps')]
                for v in detections],float).reshape(-1,4)
    local=np.column_stack((d[:,0]*np.cos(d[:,2])*np.cos(d[:,1]),
                           d[:,0]*np.cos(d[:,2])*np.sin(d[:,1]),d[:,0]*np.sin(d[:,2])))
    return d,(local@rotation(dict(roll=sensor.transform.rotation_rad.roll,
        pitch=sensor.transform.rotation_rad.pitch,yaw=sensor.transform.rotation_rad.yaw)).T+
        np.array(sensor.transform.position_m))


def leader_masks(frame,metadata,d,hits):
    actor_id=next(v['actor_id'] for v in metadata['config']['intended_initial_states']['actors'] if v['name']=='leader')
    actor=next(o.actor for o in frame.ground_truth.objects if o.actor.actor_id==actor_id)
    box=next(v['bounding_box'] for v in metadata['config']['intended_initial_states']['actors'] if v['name']=='leader')
    rr=actor.transform.rotation_rad
    local=(hits-np.array(actor.transform.position_m))@rotation(dict(roll=rr.roll,pitch=rr.pitch,yaw=rr.yaw))
    br={k:math.radians(v) for k,v in zip(('roll','pitch','yaw'),box['rotation_deg'])}
    local=(local-np.array(box['center_offset_m']))@rotation(br)
    # Geometric association, not a semantic radar label or production feature.
    inside=np.all(np.abs(local)<=np.array(box['extent_m'])+.15,axis=1)
    return actor,inside


def reconstructed(trace):
    by_episode=defaultdict(list)
    for row in trace:by_episode[row['episode_id']].append(row)
    for episode_trace in by_episode.values():
        path=Path(episode_trace[0]['recording_path'])
        reader=ReplayReader(path);frames=list(reader.frames());positions={f.frame_id:i for i,f in enumerate(frames)}
        assembler=ObservationAssembler(CONFIGS['lightweight'],lambda _:b'')
        raw=assembler.append(sensor_observation(frames[0]),[0.,0.,0.])
        for row in episode_trace:
            i=positions[row['frame_id']]
            previous=frames[i-1]
            assert int(raw['frame_time'][-1,0])==row['frame_id']-1==previous.frame_id
            features=policy_features(raw,row['base_proposed_action'])
            yield row,features,previous,raw,reader.metadata.config
            raw=assembler.append(sensor_observation(frames[i]),row['applied_action'])


def gate_summary(trace):
    return {'gate':distribution([r['proposed_action'][0] for r in trace]),
        'brake_head':distribution([r['proposed_action'][1] for r in trace]),
        'steering_head':distribution([r['proposed_action'][2] for r in trace]),
        'positive_gate_proposals':sum(r['proposed_action'][0]>0 for r in trace),
        'accepted':sum(r['intervention']['accepted'] for r in trace),
        'validator_rejected':sum(r['intervention']['decision']=='REJECTED' for r in trace),
        'no_control_change_positive_gate':sum(r['proposed_action'][0]>0 and
            r['intervention']['decision']=='NO_INTERVENTION' for r in trace),
        'steering_axis_rejections':sum(r['intervention']['steering_adjustment_rejected'] for r in trace),
        'reasons':dict(Counter(r['intervention']['reason'] for r in trace))}


def trajectory(label,path,trace):
    result=json.loads((path/'outcome.json').read_text())
    sums={k:sum(r['reward_components'][k] for r in trace) for k in trace[0]['reward_components']}
    total=sum(sums.values());assert abs(total-result['reward'])<1e-5
    gamma=.99
    return {'label':label,'recording_path':str(path.relative_to(ROOT)).replace('\\','/'),
        'seed':result['seed'],'outcome':result['outcome'],'steps':result['steps'],
        'return':total,'discounted_return_gamma_099':sum((gamma**i)*r['reward'] for i,r in enumerate(trace)),
        'components':sums,'metrics':result['metrics']}


def main():
    DEST.mkdir(parents=True,exist_ok=True)
    torch.set_num_threads(2);torch.set_num_interop_threads(1)
    frozen=hashlib.sha256((RUN/'final_model.zip').read_bytes()).hexdigest()
    model=SAC.load(RUN/'final_model.zip',device='cpu')
    initial=SAC.load(RUN/'initial_model.zip',device='cpu')
    test=rows(RUN/'trained_sac_9b3bceb0c77aaea8-steps.jsonl')
    validation=rows(RUN/'validation_1255-steps.jsonl')
    training=rows(RUN/'training-steps.jsonl')
    reconstructed_test=list(reconstructed(test))
    features=np.stack([r[1] for r in reconstructed_test])
    action,_=model.predict(features,deterministic=True)
    expected=np.array([r['proposed_action'] for r in test]);error=float(np.max(np.abs(action-expected)))
    assert error<2e-6
    initial_action,_=initial.predict(features,deterministic=True)
    tensor=torch.tensor(features,dtype=torch.float32)
    with torch.no_grad():
        mean,log_std,_=model.actor.get_action_dist_params(tensor)
        squash=torch.tanh(mean).numpy()
        unscaled=model.policy.unscale_action(squash)
        assert np.allclose(action,unscaled,atol=2e-6,rtol=0)
        probability=.5*(1+torch.erf(mean[:,0]/(torch.exp(log_std[:,0])*math.sqrt(2))))
        critic_rows=[]
        for gate in (-.9,-.5,-.1,.1,.5,.9):
            # Critic input uses library [-1,1] scaled brake, .5 brake maps to 0.
            a=torch.tensor(np.tile([gate,0.,0.],(len(features),1)),dtype=torch.float32)
            q=torch.cat(model.critic(tensor,a),dim=1).min(dim=1).values
            critic_rows.append({'gate':gate,'mean_min_q':float(q.mean()),'min':float(q.min()),'max':float(q.max())})
    # Sensitivity measurement only: gradient with respect to the diagnostic
    # action tensor. No optimizer, parameter gradient accumulation or update.
    diagnostic_action=torch.tensor(model.policy.scale_action(action),requires_grad=True)
    q=torch.cat(model.critic(tensor,diagnostic_action),dim=1).min(dim=1).values
    gate_q_gradient=torch.autograd.grad(q.sum(),diagnostic_action)[0][:,0].detach().numpy()
    mu=mean.numpy();std=torch.exp(log_std).numpy()
    action_paths=[];mapping_checks=defaultdict(int)
    for index,(row,f,frame,raw,config) in enumerate(reconstructed_test):
        base=ControlCommand(frame.frame_id,frame.timestamp_s,row['base_proposed_action'][1],
            row['base_proposed_action'][2],row['base_proposed_action'][0],False,False,CommandSource.TRAINING,1)
        if index in (0,54,67):
            isolated=replace(frame,ground_truth=None,actors=())
            a=ObservationAssembler(CONFIGS['lightweight'],lambda _:b'')
            b=ObservationAssembler(CONFIGS['lightweight'],lambda _:b'')
            left=a.append(sensor_observation(frame),[0.,0.,0.])
            right=b.append(sensor_observation(isolated),[0.,0.,0.])
            np.testing.assert_array_equal(policy_features(left,row['base_proposed_action']),
                policy_features(right,row['base_proposed_action']))
            mapping_checks['native_ground_truth_removal_invariance']+=1
        command,decision=decide_intervention(sensor_observation(frame),base,row['proposed_action'],'OFFLINE_FROZEN_MODEL_DIAGNOSIS')
        assert not decision['accepted'] and decision['decision']=='NO_INTERVENTION'
        np.testing.assert_allclose(row['applied_action'],[command.steering,command.throttle,command.brake],atol=1e-6,rtol=0)
        np.testing.assert_allclose(row['native_applied_action'],row['applied_action'],atol=1e-5,rtol=0)
        assert row['applied_command']['source']=='TRAINING'
        # Decoder tests on authentic observations; these controls are never applied.
        for gate in (-.9,-.5,-.1,0.,1e-6,.5,1.):
            c,info=decide_intervention(sensor_observation(frame),base,[gate,.9,0.],'OFFLINE_MAPPING_DIAGNOSIS')
            if gate<=0:assert c is base;mapping_checks['negative_half_exact_base']+=1
            else:assert c.brake>=base.brake and c.throttle<=base.throttle;mapping_checks['positive_gate_brake_can_be_admitted']+=int(info['accepted'])
        if index<3 or row['collision_events']:
            action_paths.append({'seed':row['seed'],'step':row['step'],'observation_frame':frame.frame_id,
                'actor_unsquashed_mean':mu[index].tolist(),'actor_sigma':std[index].tolist(),
                'tanh_mean':squash[index].tolist(),'env_unscaled_output':action[index].tolist(),
                'decoded':decision,'base_proposed':row['base_proposed_action'],
                'arbitrated_command':row['applied_command'],'native_applied':row['native_applied_action']})
    write(DEST/'gate-analysis.json',{'source_model_sha256':frozen,'training':False,
        'native_test':gate_summary(test),'native_validation':gate_summary(validation),
        'recomputed_prediction_max_abs_error':error,'unsquashed_gate_mean':distribution(mu[:,0]),
        'gate_sigma':distribution(std[:,0]),'probability_stochastic_positive_gate':distribution(probability.numpy()),
        'initial_deterministic_gate_on_same_test_observations':distribution(initial_action[:,0]),
        'critic_slice_brake_05_steering_0':critic_rows,'actual_trace_examples':action_paths,
        'critic_dQ_dgate_at_deterministic_policy_action':distribution(gate_q_gradient),
        'offline_decoder_checks_on_authentic_observations':dict(mapping_checks)})
    # Existing replay file is locally produced trusted experiment data. Read only.
    model.load_replay_buffer(RUN/'replay_buffer.pkl')
    buffer=model.replay_buffer;n=buffer.size()
    assert n==len(training)==1255
    scaled=model.policy.scale_action(np.array([r['proposed_action'] for r in training],np.float32))
    replay_action_error=float(np.max(np.abs(buffer.actions[:n,0]-scaled)))
    replay_reward_error=float(np.max(np.abs(buffer.rewards[:n,0]-[r['reward'] for r in training])))
    assert replay_action_error<2e-6 and replay_reward_error<1e-4
    terminal_indices=np.flatnonzero(buffer.dones[:n,0]);training_episodes=rows(RUN/'training-episodes.jsonl')
    returns=[]
    for e in training_episodes:
        trace=[r for r in training if r['episode_id']==e['outcome']['episode_id']]
        returns.append(trajectory('TRAIN_'+e['outcome']['outcome'],Path(trace[0]['recording_path']),trace))
    batches=[]
    for start,end in ((1,500),(501,1000),(1001,1255)):
        subset=[r for r in training if start<=r['training_step']<=end]
        batches.append({'steps':[start,end],**gate_summary(subset),
            'components':{k:sum(r['reward_components'][k] for r in subset) for k in subset[0]['reward_components']},
            'mean_immediate_reward_gate_positive':float(np.mean([r['reward'] for r in subset if r['proposed_action'][0]>0])),
            'mean_immediate_reward_gate_nonpositive':float(np.mean([r['reward'] for r in subset if r['proposed_action'][0]<=0]))})
    write(DEST/'learning-signal-analysis.json',{'training':False,'replay_buffer_valid_transitions':n,
        'replay_scaled_action_max_abs_error':replay_action_error,'replay_reward_max_abs_error':replay_reward_error,
        'terminal_samples':[{'buffer_index':int(i),'training_step':int(i+1),
            'reward':float(buffer.rewards[i,0]),'done':float(buffer.dones[i,0]),
            'timeout':float(buffer.timeouts[i,0]),'bootstrap_done_mask':float(buffer.dones[i,0]*(1-buffer.timeouts[i,0]))}
            for i in terminal_indices],
        'success_reward_samples':int(sum(r['reward_components']['success']>0 for r in training)),
        'collision_reward_samples':int(sum(r['reward_components']['collision']<0 for r in training)),
        'gradient_updates_after_only_collision':1255-next(r['training_step'] for r in training if r['collision_events']),
        'expected_uniform_minibatch_draws_success_terminal_not_observed':sum(64/k for k in range(501,1256)),
        'expected_uniform_minibatch_draws_collision_terminal_not_observed':sum(64/k for k in range(1207,1256)),
        'batches':batches,'training_episode_trajectories':returns,
        'model_updates':model._n_updates,'final_entropy_coefficient':float(model.log_ent_coef.exp().detach()),
        'target_entropy':model.target_entropy})
    timing=[];per_seed=[];radar_counts=Counter();freshness=Counter()
    metadata_cache={}
    for row,f,frame,raw,config in reconstructed_test:
        path=Path(row['recording_path'])
        if path not in metadata_cache:metadata_cache[path]=json.loads((path/'metadata.json').read_text())
        metadata=metadata_cache[path]
        radar=next(s for s in frame.sensors if s.kind==SensorKind.RADAR)
        d,hits=world_hits(radar);leader,inside=leader_masks(frame,metadata,d,hits)
        order=np.argsort(d[:,0],kind='stable')[:32]
        forward=order[(np.abs(d[order,1])<.12)&(np.abs(d[order,2])<.15)]
        selected=forward[np.argmin(d[forward,0])] if len(forward) else None
        ground=(np.abs(hits[:,2])<=.12)&(~inside)
        elevated=(np.abs(d[:,1])<.12)&(.65+d[:,0]*np.sin(d[:,2])>.25)
        screened_order=order[elevated[order]]
        screened=screened_order[np.argmin(d[screened_order,0])] if len(screened_order) else None
        radar_counts['frames']+=1;radar_counts['raw_has_leader_box_associated_return']+=int(inside.any())
        radar_counts['nearest32_has_leader_box_associated_return']+=int(inside[order].any())
        radar_counts['selected_ground_height_consistent']+=int(selected is not None and ground[selected])
        radar_counts['selected_leader_box_associated']+=int(selected is not None and inside[selected])
        radar_counts['selected_other_or_none']+=int(selected is None or not ground[selected] and not inside[selected])
        radar_counts['diagnostic_height_screen_selected_leader']+=int(screened is not None and inside[screened])
        radar_counts['diagnostic_height_screen_selected_ground']+=int(screened is not None and ground[screened])
        radar_counts['diagnostic_height_screen_other_or_none']+=int(screened is None or not ground[screened] and not inside[screened])
        freshness['complete_frames']+=int(frame.complete)
        freshness['sensor_time_or_frame_mismatch']+=sum(s.frame_id!=frame.frame_id or
            abs(s.sensor_timestamp_s-frame.timestamp_s)>1e-6 for s in frame.sensors)
        history=raw['frame_time'][raw['history_valid'].astype(bool)]
        freshness['history_gap_above_timestep']+=int(len(history)>1 and np.max(np.diff(history[:,1]))>.050001)
        record={'seed':row['seed'],'policy_step':row['step'],'observation_frame':frame.frame_id,
            'simulation_time_s':float(frame.timestamp_s),
            'speed_mps':frame.vehicle.speed_mps,'leader_speed_mps_diagnostic':float(np.linalg.norm(leader.linear_velocity_mps)),
            'center_separation_m_diagnostic':math.dist(frame.vehicle.transform.position_m,leader.transform.position_m),
            'raw_radar_returns':len(d),'lead_box_associated_raw_count':int(inside.sum()),
            'lead_box_associated_nearest32_count':int(inside[order].sum()),
            'selected_return':d[selected].tolist() if selected is not None else None,
            'selected_world_z_m_diagnostic':float(hits[selected,2]) if selected is not None else None,
            'selected_is_lead_box_associated':bool(selected is not None and inside[selected]),
            'selected_is_ground_height_consistent':bool(selected is not None and ground[selected]),
            'lead_associated_range_m_diagnostic':float(d[inside,0].min()) if inside.any() else None,
            'lead_associated_velocity_mps_diagnostic':float(np.median(d[inside,3])) if inside.any() else None,
            'elevated_nearest32_lead_count':int((elevated[order]&inside[order]).sum()),
            'diagnostic_height_screen_range_m':float(d[screened,0]) if screened is not None else None,
            'diagnostic_height_screen_velocity_mps':float(d[screened,3]) if screened is not None else None,
            'gate':row['proposed_action'][0]}
        timing.append(record)
    for seed in sorted({r['seed'] for r in test}):
        native=[r for r in test if r['seed']==seed];sensors=[r for r in timing if r['seed']==seed]
        collision_time=native[-1]['timestamp_s'];start_time=sensors[0]['simulation_time_s']
        selected_lead=[r for r in sensors if r['selected_is_lead_box_associated']]
        first_lead=next((r for r in sensors if r['lead_box_associated_raw_count']),None)
        per_seed.append({'seed':seed,'collision_episode_time_s':collision_time-start_time,
            'first_raw_lead_visible_at_s':first_lead['simulation_time_s']-start_time if first_lead else None,
            'first_selected_lead_at_s':selected_lead[0]['simulation_time_s']-start_time if selected_lead else None,
            'time_before_collision_when_selected_lead_s':collision_time-selected_lead[0]['simulation_time_s'] if selected_lead else None,
            'selected_lead_speed_mps':selected_lead[0]['speed_mps'] if selected_lead else None,
            'selected_lead_range_m':selected_lead[0]['selected_return'][0] if selected_lead else None,
            'selected_lead_gate':selected_lead[0]['gate'] if selected_lead else None})
    with (DEST/'observation-timing.jsonl').open('w',encoding='utf8') as stream:
        for r in timing:stream.write(json.dumps(r,allow_nan=False)+'\n')
    write(DEST/'observation-analysis.json',{'diagnostic_geometry_only':True,
        'ground_height_tolerance_m':.12,'leader_box_tolerance_m':.15,
        'radar_counts':dict(radar_counts),'freshness':dict(freshness),'per_seed':per_seed,
        'initial_observation_example':timing[0],
        'geometry_caveat':'Hit positions near bounding boxes/road are associations, not semantic radar labels. Flat road assumption is limited to sampled lanes.'})
    pointer=json.loads((ROOT/'output/native-validation/experiment1-1-run.json').read_text())
    native_root=Path(pointer['run']);native_result=json.loads((native_root/'result.json').read_text())
    reward_rows=[]
    for e in native_result['episodes']:
        trace=[{'reward':r['reward'],**r['info']} for r in rows(native_root/f"{e['name']}_{e['seed']}-steps.jsonl")]
        reward_rows.append(trajectory(e['name'],Path(e['initial']['recording_path']),trace))
    reward_rows.append(next(r for r in returns if r['outcome']=='SUCCESS'))
    # The existing rule is the early-braking/avoidance reference. It is distinct
    # from permanent full braking and from the new resume-and-stop trajectory.
    early=rows(RUN/'rule_safety_EXPERIMENT1-steps.jsonl')
    early=[r for r in early if r['seed']==2042]
    reward_rows.append(trajectory('existing_early_rule_braking',Path(early[0]['recording_path']),early))
    write(DEST/'reward-analysis.json',{'weights_unchanged':True,'real_trajectories':reward_rows,
        'native_diagnostic_run':str(native_root.relative_to(ROOT)).replace('\\','/'),
        'native_steps':native_result['actual_steps'],'native_duration_wall_s':native_result['duration_wall_s'],
        'scripted_phases':[{k:e[k] for k in ('name','seed','script_phases','step_latency_ms')} for e in native_result['episodes']],
        'runtime_restored':native_result['runtime_restored'],'unchanged_model_sha256':frozen})
    assert hashlib.sha256((RUN/'final_model.zip').read_bytes()).hexdigest()==frozen
    print(json.dumps({'pass':True,'no_training':True,'prediction_max_abs_error':error,
        'gates':gate_summary(test),'radar_counts':dict(radar_counts),'per_seed':per_seed,
        'native_episodes':[(r['label'],r['seed'],r['outcome'],r['return']) for r in reward_rows]}),flush=True)


if __name__=='__main__':main()
