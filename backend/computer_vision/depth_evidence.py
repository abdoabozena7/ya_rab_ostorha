"""Measured axial depth inside RGB detections; no simulator actor information."""
import numpy as np


def attach_depth(detections,depth,frame_id,timestamp_s):
    h,w=depth.shape
    for detection in detections:
        x1,y1,x2,y2=detection['xyxy'];cx=(x1+x2)/2
        left,right=max(0,int(cx-(x2-x1)*.15)),min(w,int(cx+(x2-x1)*.15)+1)
        top,bottom=max(0,int(y1+(y2-y1)*.25)),min(h,int(y1+(y2-y1)*.75)+1)
        values=depth[top:bottom,left:right].reshape(-1)
        values=values[np.isfinite(values)&(values>.1)&(values<100.)]
        if len(values)<4:continue
        median=float(np.median(values));mad=float(np.median(abs(values-median)))
        if mad>max(.5,median*.05) or np.quantile(values,.9)-np.quantile(values,.1)>max(1.,median*.1):continue
        detection['depth_evidence']={'source_sensor':'depth','frame_id':frame_id,
            'timestamp_s':timestamp_s,'axial_m':median,'mad_m':mad,'samples':len(values)}
    return detections
