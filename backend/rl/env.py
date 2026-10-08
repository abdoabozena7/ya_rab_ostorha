"""Gymnasium client of the existing CARLA service. Never creates a CARLA client."""
import json
from pathlib import Path
import urllib.error
import urllib.request
import gymnasium as gym
from gymnasium import spaces
from gymnasium.envs.registration import EnvSpec
import numpy as np
from .actions import ACTION_LOW, ACTION_HIGH, normalize_action
from .observations import CONFIGS, observation_space, unpack_observation
from ..core.scenarios import DatasetSplit, SEED_RANGES


class HttpTransport:
    def __init__(self,url='http://127.0.0.1:8000/api/simulation/rl'):
        self.url=url

    def __call__(self, operation, **data):
        request=urllib.request.Request(self.url,json.dumps({'operation':operation,**data},allow_nan=False).encode(),
                                      {'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request,timeout=60) as response:return json.load(response)
        except urllib.error.HTTPError as error:
            message=json.load(error).get('error',str(error))
            if error.code==400:raise ValueError(message) from error
            raise RuntimeError(message) from error


class YaRabOstorhaEnv(gym.Env):
    metadata={'render_modes':[]}
    render_mode=None

    def __init__(self, *, profile='lightweight', split='TRAIN', scenario='FRONT_OBSTACLE',
                 parameters=None, max_steps=400, transport=None, baseline_id='SCRIPTED_DIAGNOSTIC',
                 reward_weights=None, collision_impulse_threshold=0., supervisor=False, policy_id=None):
        self.config=CONFIGS[profile];self.split=DatasetSplit(split)
        self.scenario=scenario;self.parameters=dict(parameters or {});self.max_steps=max_steps
        self.baseline_id=baseline_id;self.transport=transport or HttpTransport()
        self.reward_weights=dict(reward_weights or {});self.collision_impulse_threshold=collision_impulse_threshold
        self.supervisor=supervisor;self.policy_id=policy_id
        self.observation_space=observation_space(self.config)
        self.action_space=spaces.Box(ACTION_LOW,ACTION_HIGH,dtype=np.float32)
        if self.supervisor:
            from .supervisor import INTERVENTION_LOW,INTERVENTION_HIGH
            self.action_space=spaces.Box(INTERVENTION_LOW,INTERVENTION_HIGH,dtype=np.float32)
        # The persisted scenario configuration is reproducible; absolute frames,
        # sensor noise and reused-world physics are not bitwise deterministic.
        self.spec=EnvSpec('YaRabOstorha-v0',nondeterministic=True)
        self.token=None;self.done=True;self.closed=False;self.current_info=None
        self.last_observation=None;self.last_close_info=None

    def reset(self, *, seed=None, options=None):
        if self.closed:raise RuntimeError('Environment is closed')
        super().reset(seed=seed)
        lo,hi=SEED_RANGES[self.split]
        if seed is None:seed=int(self.np_random.integers(lo,hi+1))
        if type(seed) is not int or not lo<=seed<=hi:raise ValueError('Seed outside the reserved split range')
        options=dict(options or {})
        if set(options)-{'scenario','parameters'}:raise ValueError('Unknown reset option')
        if self.token is None:
            self.token=self.transport('acquire',profile=self.config.name,split=self.split.value,
                                      max_steps=self.max_steps,baseline_id=self.baseline_id,
                                      reward_weights=self.reward_weights,collision_impulse_threshold=self.collision_impulse_threshold,
                                      **({'supervisor':True,'policy_id':self.policy_id} if self.supervisor else {}))['token']
        result=self.transport('reset',token=self.token,seed=seed,scenario=options.get('scenario',self.scenario),
                              parameters={**self.parameters,**options.get('parameters',{})})
        self.done=False;self.current_info=result['info']
        self.last_observation=unpack_observation(result['observation'],self.observation_space)
        return self.last_observation,result['info']

    def step(self, action):
        if self.closed or self.done:raise RuntimeError('Reset before stepping an inactive or completed episode')
        if self.supervisor:
            from .supervisor import normalize_intervention
            proposed,_=normalize_intervention(action)
        else:proposed,_=normalize_action(action)
        try:
            result=self.transport('step',token=self.token,action=proposed.tolist(),
                                  frame_id=self.current_info['frame_id'],timestamp_s=self.current_info['timestamp_s'])
        except (OSError,urllib.error.URLError) as error:
            # A killed backend cannot acknowledge whether the attempted action
            # reached physics. Preserve that uncertainty and the last valid data.
            self.done=True
            invalid={k:v.copy() for k,v in self.last_observation.items()}
            for key in ('history_valid','radar_valid','lidar_valid'):
                if key in invalid:invalid[key].fill(0)
            info={**self.current_info,'outcome':'SIMULATOR_FAILURE','termination_reason':None,
                  'truncation_reason':'backend_transport_failure','observation_valid':False,
                  'proposed_action':proposed.tolist(),'applied_action':None,'reward_components':{},
                  'error':str(error),'cleanup_confirmed':False}
            # This local marker supplements the durable server run; it never
            # overwrites an outcome already finalized by the actual tick owner.
            root=Path(self.current_info['recording_path']).resolve()
            allowed=Path(__file__).resolve().parents[2]/'runs/rl'
            if root.is_relative_to(allowed.resolve()) and root.is_dir():
                (root/'client_failure.json').write_text(json.dumps(info,indent=2,allow_nan=False),encoding='utf8')
            return invalid,0.,False,True,info
        self.done=result['terminated'] or result['truncated'];self.current_info=result['info']
        self.last_observation=unpack_observation(result['observation'],self.observation_space)
        return (self.last_observation,float(result['reward']),
                bool(result['terminated']),bool(result['truncated']),result['info'])

    def close(self):
        if not self.closed:
            if self.token:
                try:self.last_close_info=self.transport('close',token=self.token)
                except (OSError,urllib.error.URLError) as error:
                    self.last_close_info={'restored':False,'cleanup_confirmed':False,'error':str(error)}
            self.token=None;self.closed=True;self.done=True
