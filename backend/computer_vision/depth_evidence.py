"""Measured axial depth inside RGB detections; no simulator actor information."""
import numpy as np


def attach_depth(detections,depth,frame_id,timestamp_s,*,rgb_size=None):
    h,w=depth.shape
    rgb_size=rgb_size or (w,h);sx,sy=w/rgb_size[0],h/rgb_size[1]
    if abs(sx-sy)>1e-6:raise ValueError('RGB/depth aspect ratio differs')
    for detection in detections:
        xx1,yy1,xx2,yy2=detection['xyxy']
        x1,x2=(xx1+.5)*sx-.5,(xx2+.5)*sx-.5;y1,y2=(yy1+.5)*sy-.5,(yy2+.5)*sy-.5;cx=(x1+x2)/2
        left,right=max(0,int(cx-(x2-x1)*.15)),min(w,int(cx+(x2-x1)*.15)+1)
        # Walking legs contain real background gaps. Seed a person's measured
        # torso, retaining the same layer-spread and minimum-support checks.
        start,end=(.25,.55) if detection.get('class')=='person' else (.25,.75)
        top,bottom=max(0,int(y1+(y2-y1)*start)),min(h,int(y1+(y2-y1)*end)+1)
        values=depth[top:bottom,left:right].reshape(-1)
        values=values[np.isfinite(values)&(values>.1)&(values<100.)]
        if len(values)<4:continue
        median=float(np.median(values));mad=float(np.median(abs(values-median)))
        if mad>max(.5,median*.05) or np.quantile(values,.9)-np.quantile(values,.1)>max(1.,median*.1):continue
        detection['depth_evidence']={'source_sensor':'depth','frame_id':frame_id,
            'timestamp_s':timestamp_s,'axial_m':median,'mad_m':mad,'samples':len(values),
            'pixel_center_depth':[(left+right-1)/2.,(top+bottom-1)/2.],
            'depth_resolution':[w,h],'region':'TORSO' if detection.get('class')=='person' else 'BODY_CORE'}
    return detections
