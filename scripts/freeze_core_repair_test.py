"""Freeze required TEST protocols before evaluation; never rewrite a manifest."""
import argparse
import hashlib
import json
from pathlib import Path
from backend.learning.pilot_provenance import control_hashes


def main():
    p=argparse.ArgumentParser();p.add_argument('output',type=Path);args=p.parse_args()
    cases=[]
    for i in range(10):
        curve=i>=8
        cases.append({'case_id':f'ordinary_{i+1:02}','split':'TEST','group':'ordinary','seed':2000+i,
            'map':'Town10HD_Opt','scenario':'CURVE' if curve else 'EMPTY_ROAD','mode':'AUTONOMOUS',
            'parameters':{'spawn_index':(120,138)[i%2],'route_length':80. if curve else 30.,'time_limit_s':60.,'cap_mps':4.}})
    trace=[{'at_s':0.,'throttle':.3,'brake':0.,'steering':0.},{'at_s':8.,'throttle':0.,'brake':1.,'steering':0.}]
    for i,site in enumerate((120,138)):
        cases.append({'case_id':f'manual_{i+1:02}','split':'TEST','group':'manual','seed':2020+i,'map':'Town10HD_Opt',
            'scenario':'BENIGN_MANUAL','mode':'MANUAL_PROTECTION','parameters':{'spawn_index':site,'route_length':30.,
                'time_limit_s':30.,'cap_mps':4.,'driver_trace':trace}})
    for i,scenario in enumerate(('SUDDEN_BRAKING','CUT_IN','PARALLEL_TRAFFIC','REAR_APPROACH','PEDESTRIAN_CROSSING',
        'OCCLUDED_PEDESTRIAN','HESITATION_RETREAT','BLOCKED_REVERSE','LEFT_EXIT','RIGHT_EXIT','PASS_RETURN','ALTERNATE_STREET','FULLY_BLOCKED','MIXED_TRAFFIC')):
        cases.append({'case_id':scenario.lower(),'split':'TEST','group':'recovery' if scenario in ('BLOCKED_REVERSE','LEFT_EXIT','RIGHT_EXIT','PASS_RETURN','ALTERNATE_STREET') else 'hazard',
            'independently_verified_feasible':False,'seed':2030+i,'map':'Town10HD_Opt','scenario':scenario,
            'mode':'AUTONOMOUS','parameters':{'spawn_index':120,'route_length':40.,'time_limit_s':60.,'cap_mps':4.}})
    for i,site in enumerate((0,10)):
        cases.append({'case_id':f'town03_{i+1:02}','split':'TEST','group':'layout_holdout','seed':2060+i,'map':'Town03',
            'scenario':'EMPTY_ROAD','mode':'AUTONOMOUS','parameters':{'spawn_index':site,'route_length':40.,'time_limit_s':60.,'cap_mps':4.}})
    for case in cases:case['parameters']['curriculum_stage']=0
    manifest={'version':2,'reward_version':2,'native_initialization_version':3,
        'environment_id':'YaRabOstorha-Maneuver-v1','cases':cases,'implementation_sha256':control_hashes(),
        'unsupported_cases':'Must fail construction explicitly; no geometry or map substitution',
        'comparisons':'Replay identical driver traces; match route, initial conditions, sensors and actor behavior before scoring',
        'feasibility':'Counterfactual feasibility requires independent physical evidence before recovery admission'}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.open('x',encoding='utf8') as stream:stream.write(json.dumps(manifest,indent=2,allow_nan=False))
    digest=hashlib.sha256(args.output.read_bytes()).hexdigest()
    args.output.with_suffix('.lock.json').write_text(json.dumps({'manifest_sha256':digest,'cases':len(cases)},indent=2),encoding='utf8')
    print(json.dumps({'manifest':str(args.output),'sha256':digest,'cases':len(cases)}))


if __name__=='__main__':main()
