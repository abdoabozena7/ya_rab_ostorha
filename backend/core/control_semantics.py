"""Cached front-camera semantics associated to historical measured tracks."""
import numpy as np
from .camera_geometry import project
from .prediction import rotation


class SemanticAssociator:
    def __init__(self):self.labels={};self.last_result=None

    def apply(self,prediction,observation,poses,result):
        now=observation.timestamp_s
        evidence=[]
        if result and result.get('status')=='RUNNING' and 0<=now-result.get('timestamp_s',-1)<=.75:
            stamp=result['timestamp_s'];history=np.asarray(poses)
            if len(history) and history[0,0]<=stamp<=history[-1,0]:
                origin=np.array([np.interp(stamp,history[:,0],history[:,i]) for i in (1,2)])
                yaw=np.interp(stamp,history[:,0],np.unwrap(history[:,3]))
                rgb=next(c for c in observation.channels if c.sensor_id=='frontCamera')
                used=set()
                for track in prediction['tracks']:
                    samples=np.asarray(track['history'])
                    if not len(samples) or not samples[0,0]<=stamp<=samples[-1,0]:continue
                    position=np.array([np.interp(stamp,samples[:,0],samples[:,i]) for i in (1,2)])
                    pixel=project(rotation(yaw).T@(position-origin),rgb.calibration)
                    if pixel is None:continue
                    choices=[(d['confidence'],i,d) for i,d in enumerate(result.get('detections',[])) if i not in used and
                             d['confidence']>=.65 and d['xyxy'][0]<=pixel[0]<=d['xyxy'][2] and d['xyxy'][1]<=pixel[1]<=d['xyxy'][3]]
                    if choices:
                        confidence,index,detection=max(choices,key=lambda x:x[0]);used.add(index)
                        self.labels[track['id']]={'class':detection['class'],'confidence':confidence,'timestamp_s':stamp,
                            'source_sensor':'frontCamera','source_frame':result.get('frame_id')}
        for track in prediction['tracks']:
            label=self.labels.get(track['id'])
            if label and 0<=now-label['timestamp_s']<=1.:
                track['class']=label['class'];track['semantic_evidence']=label;evidence.append(label)
        self.labels={key:value for key,value in self.labels.items() if 0<=now-value['timestamp_s']<=1.}
        return {'front':'PARTIAL_CLASSIFIED' if evidence else 'GEOMETRY_ONLY','left':'GEOMETRY_ONLY',
                'right':'GEOMETRY_ONLY','rear':'GEOMETRY_ONLY','classified':bool(evidence),
                'classified_tracks':len(evidence),'segmentation_admitted':False}
