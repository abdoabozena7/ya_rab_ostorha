"""Cached front-camera semantics associated to historical measured tracks."""
import numpy as np
from .camera_geometry import project
from .prediction import rotation


class SemanticAssociator:
    def __init__(self):self.labels={};self.last_result=None

    def apply(self,prediction,observation,poses,result):
        now=observation.timestamp_s
        evidence=[]
        key=(result.get('session_id'),result.get('frame_id'),result.get('timestamp_s')) if result else None
        valid=(result and result.get('status')=='RUNNING' and result.get('session_id')==prediction['session_id']
            and type(result.get('frame_id')) is int and result['frame_id']<=observation.frame_id
            and 0<=now-result.get('timestamp_s',-1)<=.75)
        if valid and key!=self.last_result:
            stamp=result['timestamp_s'];history=np.asarray(poses)
            frame=result['frame_id']
            frame_matches=(len(history) and history.ndim==2 and history.shape[1]>=5
                and history[0,4]<=frame<=history[-1,4]
                and abs(float(np.interp(frame,history[:,4],history[:,0]))-stamp)<=1e-5)
            if frame_matches and history[0,0]<=stamp<=history[-1,0]:
                origin=np.array([np.interp(stamp,history[:,0],history[:,i]) for i in (1,2)])
                yaw=np.interp(stamp,history[:,0],np.unwrap(history[:,3]))
                rgb=next(c for c in observation.channels if c.sensor_id=='frontCamera')
                candidates=[]
                for track in prediction['tracks']:
                    samples=np.asarray(track['history'])
                    if not len(samples) or not samples[0,0]<=stamp<=samples[-1,0]:continue
                    position=np.array([np.interp(stamp,samples[:,0],samples[:,i]) for i in (1,2)])
                    pixel=project(rotation(yaw).T@(position-origin),rgb.calibration)
                    if pixel is None:continue
                    for i,d in enumerate(result.get('detections',[])):
                        box=d.get('xyxy',[])
                        if len(box)!=4 or not np.isfinite(box).all() or box[2]<=box[0] or box[3]<=box[1]:continue
                        if d.get('confidence',0)<.65 or not (box[0]<=pixel[0]<=box[2] and box[1]<=pixel[1]<=box[3]):continue
                        distance=((pixel[0]-(box[0]+box[2])/2)/(box[2]-box[0]))**2+((pixel[1]-(box[1]+box[3])/2)/(box[3]-box[1]))**2
                        candidates.append((distance,-d['confidence'],str(track['id']),i,d))
                used_tracks=set();used_detections=set()
                for _,negative_confidence,track_id,index,detection in sorted(candidates,key=lambda c:c[:4]):
                    if track_id in used_tracks or index in used_detections:continue
                    used_tracks.add(track_id);used_detections.add(index)
                    self.labels[track_id]={'class':detection['class'],'confidence':-negative_confidence,'timestamp_s':stamp,
                        'session_id':prediction['session_id'],'source_sensor':'frontCamera','source_frame':result['frame_id']}
                self.last_result=key
        for track in prediction['tracks']:
            track['class']='UNKNOWN';track.pop('semantic_evidence',None)
            label=self.labels.get(str(track['id']))
            if label and label['session_id']==prediction['session_id'] and 0<=now-label['timestamp_s']<=1.:
                track['class']=label['class'];track['semantic_evidence']=label;evidence.append(label)
        self.labels={key:value for key,value in self.labels.items() if 0<=now-value['timestamp_s']<=1.}
        return {'front':'PARTIAL_CLASSIFIED' if evidence else 'GEOMETRY_ONLY','left':'GEOMETRY_ONLY',
                'right':'GEOMETRY_ONLY','rear':'GEOMETRY_ONLY','classified':bool(evidence),
                'classified_tracks':len(evidence),'segmentation_admitted':False}
