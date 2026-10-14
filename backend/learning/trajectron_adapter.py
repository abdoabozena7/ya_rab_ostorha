"""Pinned legacy adapter. Import only in the isolated CPU worker environment."""
import ast
import collections
import collections.abc
import hashlib
import json
from pathlib import Path
import sys
import numpy as np

ROOT = Path(__file__).resolve().parents[2]


class TrajectronAdapter:
    def __init__(self, directory=ROOT/'.cache/trajectron'):
        import torch
        torch.set_num_threads(1)
        self.torch = torch; self.directory = Path(directory)
        lock = json.loads((ROOT/'config/trajectron-lock.json').read_text())
        self.lock = lock
        for name,key in [('config.json','config_sha256'),('model_registrar-12.pt','weights_sha256')]:
            if hashlib.sha256((self.directory/name).read_bytes()).hexdigest() != lock[key]: raise ValueError('Pinned Trajectron checksum mismatch')
        import subprocess
        source = self.directory/'source'
        revision = subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
        if revision != lock['revision']: raise ValueError('Pinned Trajectron revision mismatch')
        if subprocess.run(['git','diff','--quiet','HEAD','--'],cwd=source).returncode:
            raise ValueError('Pinned Trajectron source was modified')
        # Two removed Python/NumPy names; no changes to upstream model algorithms.
        collections.Sequence = collections.abc.Sequence
        np.float = float
        sys.path.insert(0,str(source/'trajectron'))
        from environment import Environment, Scene
        from model.model_registrar import ModelRegistrar
        from model.trajectron import Trajectron
        import dill
        if not hasattr(dill,'extend'): dill.extend = lambda **kwargs: None
        tree = ast.parse((source/'experiments/nuScenes/process_data.py').read_text(encoding='utf8'))
        standard = next(n.value for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='standardization' for t in n.targets))
        standardization = eval(compile(ast.Expression(standard),'<official standardization>','eval'), {'np':np})
        self.env = Environment(['VEHICLE','PEDESTRIAN'], standardization, scenes=[Scene(timesteps=9,dt=.5)])
        self.env.attention_radius = {(a,b): 10. if a.name==b.name=='PEDESTRIAN' else 30. if a.name==b.name=='VEHICLE' else 20. for a,b in self.env.get_edge_types()}
        self.config = json.loads((self.directory/'config.json').read_text())
        if self.config['use_map_encoding'] or self.config['incl_robot_node'] or self.config['prediction_horizon'] != 6:
            raise ValueError('Trajectron configuration requires forbidden inputs')
        registrar = ModelRegistrar(str(self.directory),'cpu')
        # Trusted upstream pickle is accepted only after the pinned digest check.
        registrar.model_dict = torch.load(self.directory/'model_registrar-12.pt', map_location='cpu', weights_only=False)
        registrar.eval()
        self.model = Trajectron(registrar,self.config,None,'cpu')
        self.model.set_environment(self.env); self.model.set_annealing_params()

    def predict(self, request):
        import pandas as pd
        from environment import Scene, Node
        scene = Scene(timesteps=9,dt=.5,name='measured-odometry')
        accepted = {}
        for tr in request['tracks'][:16]:
            if tr['class'] not in ('person','car','truck','bus','bicycle','motorcycle'): continue
            h = np.asarray(tr['history'],float)
            if len(h)<2 or h[-1,0]-h[0,0] < .5: continue
            times = request['timestamp_s']-np.arange(8,-1,-1)*.5
            valid = times >= h[0,0]; times = times[valid]
            xy = np.column_stack([np.interp(times,h[:,0],h[:,i]) for i in (1,2)])
            # CARLA/odometry is y-right; the pretrained nuScenes dynamics use
            # a right-handed plane. Reflect at this boundary and undo on output.
            xy[:,1]*=-1
            velocity = np.gradient(xy,.5,axis=0); accel = np.gradient(velocity,.5,axis=0)
            kind = 'PEDESTRIAN' if tr['class']=='person' else 'VEHICLE'
            values = np.column_stack((xy,velocity,accel)); columns = [('position','x'),('position','y'),('velocity','x'),('velocity','y'),('acceleration','x'),('acceleration','y')]
            if kind=='VEHICLE':
                moving=np.linalg.norm(velocity,axis=1)>.3
                heading=np.arctan2(velocity[:,1],velocity[:,0])
                last=float(heading[np.flatnonzero(moving)[0]]) if moving.any() else 0.
                for i in range(len(heading)):
                    if moving[i]:last=float(heading[i])
                    else:heading[i]=last
                heading=np.unwrap(heading); rate=np.clip(np.gradient(heading,.5),-.7,.7)
                values=np.column_stack((values,heading,rate)); columns += [('heading','°'),('heading','d°')]
            node=Node(getattr(self.env.NodeType,kind),tr['id'],pd.DataFrame(values,columns=pd.MultiIndex.from_tuples(columns)),first_timestep=9-len(times))
            scene.nodes.append(node); accepted[node.id]=tr
        if not scene.nodes: return {'modes':[], 'accepted_objects':0}
        scene.calculate_scene_graph(self.env.attention_radius,self.config['edge_addition_filter'],self.config['edge_removal_filter'])
        self.torch.manual_seed(int(request.get('seed',20261011)))
        with self.torch.no_grad():
            prediction=self.model.predict(scene,np.array([8]),ph=6,num_samples=1,full_dist=False,all_z_sep=True,gmm_mode=True)
        modes=[]
        for node, samples in prediction.get(8,{}).items():
            samples=np.asarray(samples)[0]
            if samples.ndim!=3 or samples.shape[1:]!=(6,2) or not np.isfinite(samples).all(): raise ValueError('Invalid Trajectron output')
            start=accepted[node.id]['fixed_position_m']
            for index, xy in enumerate(samples):
                modes.append({'track_id':node.id,'mode':index,'probability':None,
                    'source':'TRAJECTRON_ECCV2020_INT_EE','points':[[0.,*start]]+[[float((i+1)*.5),float(p[0]),-float(p[1])] for i,p in enumerate(xy)]})
        return {'modes':modes,'accepted_objects':len(scene.nodes),'sample_interval_s':.5,'prediction_steps':6,
                'mode_weights':'UNRANKED_ALTERNATIVES; NOT_CALIBRATED_PROBABILITIES'}
