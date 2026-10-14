"""Delayed forecast scoring against subsequently measured tracks.

These live scores measure sensor-track consistency, not independent simulator
truth. Offline acceptance reports use a separate truth-only evaluator.
"""
from collections import deque
import numpy as np


class MotionQuality:
    def __init__(self):
        self.pending=deque(maxlen=1024); self.scores={h:deque(maxlen=1000) for h in (1,2,3)}
        self.last_issue=-1.; self.issued=0; self.missing=0;self.scored=0;self.dropped=0;self.short_forecasts=0

    def update(self, timestamp, tracks, modes, origin, yaw):
        indexed={t['id']:t for t in tracks}; co,si=np.cos(yaw),np.sin(yaw); r=np.array([[co,-si],[si,co]])
        retained=deque(maxlen=1024)
        for item in self.pending:
            key,stamp,paths,done=item
            for horizon in (1,2,3):
                if horizon in done or timestamp<stamp+horizon-1e-6: continue
                done.add(horizon); tr=indexed.get(key)
                if paths[0][-1,0]<horizon-1e-6:
                    self.missing+=1;self.short_forecasts+=1;continue
                history=np.asarray(tr.get('history',[]) if tr else [],float)
                if len(history)<2 or history[0,0]>stamp+.01 or history[-1,0]<stamp+horizon-.01:
                    self.missing+=1; continue
                times=np.linspace(0.,horizon,horizon*10+1)
                actual=np.column_stack([np.interp(stamp+times,history[:,0],history[:,i]) for i in (1,2)])
                errors=[]
                for path in paths:
                    xy=np.column_stack([np.interp(times,path[:,0],path[:,i]) for i in (1,2)])
                    errors.append(np.linalg.norm(xy-actual,axis=1))
                selected=errors[0]; threshold=.5 if tr.get('class')=='person' else 1.
                self.scores[horizon].append((float(np.mean(selected)),float(selected[-1]),
                    float(min(e[-1] for e in errors)),bool(selected[-1]<=threshold),threshold))
                self.scored+=1
            if len(done)<3: retained.append(item)
        self.pending=retained
        if timestamp-self.last_issue>=.5-1e-6:
            self.last_issue=timestamp
            for key,tr in indexed.items():
                selected=sorted([m for m in modes if m['track_id']==key],key=lambda m:m.get('rank',0))
                if not tr['confirmed'] or tr.get('occlusion_s',0)>.1 or not selected: continue
                paths=[]
                for mode in selected:
                    path=np.asarray(mode['points'],float).copy(); path[:,1:3]=path[:,1:3]@r.T+origin; paths.append(path)
                if len(self.pending)==self.pending.maxlen:self.dropped+=1;self.missing+=3
                self.pending.append((key,timestamp,paths,set())); self.issued+=1
        return self.snapshot()

    def snapshot(self):
        horizons={}
        scored=self.scored
        for h,rows in self.scores.items():
            a=np.asarray(rows,float)
            horizons[str(h)]={'samples':len(rows),'ade_m':float(a[:,0].mean()) if len(a) else None,
                'fde_m':float(a[:,1].mean()) if len(a) else None,
                'best_alternative_fde_m':float(a[:,2].mean()) if len(a) else None,
                'within_threshold_percent':float(a[:,3].mean()*100) if len(a) else None,
                'threshold_m':'0.5 person / 1.0 other', 'horizon_s':h}
        return {'version':1,'truth_source':'SUBSEQUENT_MEASURED_TRACKS',
            'independent_accuracy':False,'horizons':horizons,'issued':self.issued,
            'unobservable_samples':self.missing,'scored_samples':scored,'metric_window':1000,
            'capacity_dropped_forecasts':self.dropped,'insufficient_forecast_horizon':self.short_forecasts,
            'coverage_percent':100*scored/max(1,scored+self.missing)}
