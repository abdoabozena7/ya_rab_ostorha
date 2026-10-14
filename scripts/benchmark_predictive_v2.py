"""Bounded CPU/IPC benchmark; never claims native simulation acceptance."""
import json
from pathlib import Path
import time
import numpy as np
from backend.learning.async_worker import AsyncPredictionWorker
from backend.learning.experiment_budget import ExperimentBudget
from backend.core.prediction import PredictionEngine
from tests.test_safety_teacher import case

ROOT=Path(__file__).resolve().parents[1]


def main():
    budget=ExperimentBudget(); reservation=budget.reserve('trajectron_benchmark',120)
    report={'scope':'Synthetic measured-history workload, 8 pedestrians and 8 vehicles; no native throughput claim',
            'native_gate_passed':False,'simulation_degradation_percent':None,'live_comparison':None}
    worker=AsyncPredictionWorker(); outputs=[]
    try:
        tracks=[]
        for i in range(16):
            velocity=[1.2, .2] if i%2 else [4.,.1]
            history=[[t,i*4+velocity[0]*t,(i%3)*5+velocity[1]*t,*velocity] for t in np.arange(9)*.5]
            tracks.append({'id':str(i),'class':'person' if i%2 else 'car','history':history,'fixed_position_m':history[-1][1:3]})
        request={'session_id':'benchmark','timestamp_s':4.,'tracks':tracks,'seed':20261011}
        for i in range(27):
            worker.submit({**request,'frame_id':i})
            deadline=time.monotonic()+min(30.,max(.1,120-(time.monotonic()-reservation[1])))
            while time.monotonic()<deadline:
                if worker.error: raise RuntimeError(worker.error)
                if worker.latest and worker.latest['frame_id']==i: break
                time.sleep(.005)
            else: raise TimeoutError('Prediction worker deadline')
            outputs.append(worker.latest)
        latencies=[x['end_to_end_ms'] for x in outputs[2:]]
        reproducible=outputs[-1]['modes']==outputs[-2]['modes']
        report.update(weights_loaded=True,objects=outputs[-1]['accepted_objects'],valid_modes=len(outputs[-1]['modes']),
            reproducible=reproducible,cold_latency_ms=outputs[0]['end_to_end_ms'],
            p95_end_to_end_ms=float(np.percentile(latencies,95)),latency_gate_passed=max(0,float(np.percentile(latencies,95)))<=200)
    except Exception as error: report.update(weights_loaded=False,error=str(error),latency_gate_passed=False)
    finally: worker.close()
    rng=np.random.default_rng(11); cloud=np.column_stack((rng.uniform(-10,30,16000),rng.uniform(-9,9,16000),np.zeros(16000)))
    for i in range(16):
        cluster=rng.uniform(-.3,.3,(50,3))+[i*1.5,4 if i%2 else -4,1.]
        cloud=np.vstack((cloud,cluster))
    engine=PredictionEngine('geometry-benchmark'); timings=[]
    for i in range(60):
        o,b=case(i+1); began=time.perf_counter(); engine.evaluate(cloud,o,b); timings.append((time.perf_counter()-began)*1000)
    report['geometry_p95_ms']=float(np.percentile(timings[5:],95));report['geometry_gate_passed']=report['geometry_p95_ms']<=10
    budget.finish(reservation)
    report['budget']=budget.status()
    report['release_predictor']='LIGHTWEIGHT_LEARNED_MOTION'
    report['exclusion_reason']='Trajectron++ full gate is not established: native degradation, safety, arrival and meaningful improvement remain unproven.'
    path=ROOT/'output/predictive-v2/benchmark.json';path.write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))

if __name__=='__main__': main()
