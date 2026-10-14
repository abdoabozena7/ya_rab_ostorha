"""New discrete maneuver task; never silently alters the legacy braking env."""
import gymnasium as gym
from gymnasium import spaces
from gymnasium.envs.registration import EnvSpec
import numpy as np
from .env import HttpTransport
from .maneuver_observations import observation_space
from ...core.maneuver_candidates import CANDIDATE_IDS,MODES
from ...core.scenarios import DatasetSplit,SEED_RANGES


class ManeuverEnv(gym.Env):
    metadata={'render_modes':[]}
    render_mode=None
    def __init__(self,*,mode='AUTONOMOUS',split='TRAIN',scenario='EMPTY_ROAD',parameters=None,
                 transport=None,policy_id='PHYSICAL_BASELINE',max_steps=600):
        if mode not in MODES:raise ValueError('Unknown mode')
        self.mode=mode;self.split=DatasetSplit(split);self.scenario=scenario;self.parameters=dict(parameters or {})
        self.transport=transport or HttpTransport();self.policy_id=policy_id;self.max_steps=max_steps
        self.observation_space=observation_space();self.action_space=spaces.Discrete(len(CANDIDATE_IDS))
        self.spec=EnvSpec('YaRabOstorha-Maneuver-v1',nondeterministic=True)
        self.token=None;self.done=True;self.closed=False;self.bundle=None;self.info=None

    def _request(self,operation,**data):return self.transport('maneuver_'+operation,**data)

    def reset(self,*,seed=None,options=None):
        super().reset(seed=seed)
        if self.closed:raise RuntimeError('Environment closed')
        lo,hi=SEED_RANGES[self.split]
        if seed is None:seed=int(self.np_random.integers(lo,hi+1))
        if type(seed) is not int or not lo<=seed<=hi:raise ValueError('Seed outside reserved split')
        options=dict(options or {})
        if set(options)-{'mode','scenario','parameters'}:raise ValueError('Unknown reset option')
        if self.token is None:
            self.token=self._request('acquire',split=self.split.value,max_steps=self.max_steps,policy_id=self.policy_id)['token']
        value=self._request('reset',token=self.token,seed=seed,mode=options.get('mode',self.mode),
                            scenario=options.get('scenario',self.scenario),parameters={**self.parameters,**options.get('parameters',{})})
        self.done=False;return self._accept(value),value['info']

    def _accept(self,value):
        self.bundle=value['bundle'];self.info=value['info']
        if tuple(self.bundle['candidate_ids'])!=CANDIDATE_IDS:raise ValueError('Candidate ABI changed')
        observation={k:np.asarray(v,np.float32) for k,v in value['observation'].items()}
        if not self.observation_space.contains(observation):raise ValueError('Malformed measured policy observation')
        return observation

    def action_masks(self):
        if self.bundle is None:raise RuntimeError('Reset before querying action masks')
        return np.asarray(self.bundle['action_masks'],bool).copy()

    def step(self,action):
        if self.closed or self.done:raise RuntimeError('Reset before stepping')
        if not self.action_space.contains(action):raise ValueError('Invalid candidate index')
        value=self._request('step',token=self.token,action=int(action),snapshot_hash=self.bundle['snapshot_hash'],
                            frame_id=self.bundle['frame_id'],timestamp_s=self.bundle['timestamp_s'])
        self.done=bool(value['terminated'] or value['truncated'])
        return self._accept(value),float(value['reward']),bool(value['terminated']),bool(value['truncated']),value['info']

    def close(self):
        if self.token:
            self.last_close_info=self._request('close',token=self.token);self.token=None
        self.closed=True;self.done=True
