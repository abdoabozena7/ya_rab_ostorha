"""Nominal camera projection from retained native mounts, never free-space proof."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from backend.core.camera_geometry import mount_rotation


def camera_contains(point,calibration):
    mount=calibration['mount_transform']
    local=mount_rotation(mount['rotation_deg']).T@(np.asarray(point,float)-mount['position_m'])
    if local[0]<=.05:return False
    width,height=calibration['width'],calibration['height']
    focal=width/(2*np.tan(np.radians(calibration['fov_deg'])/2))
    pixel=[(width-1)/2+focal*local[1]/local[0],(height-1)/2-focal*local[2]/local[0]]
    return bool(0<=pixel[0]<=width-1 and 0<=pixel[1]<=height-1)


def audit(recording):
    root=Path(recording)
    metadata=json.loads((root/'metadata.json').read_text(encoding='utf8'))
    if metadata.get('provider')!='carla' or metadata.get('data_origin')!='REAL_SIMULATION':
        raise ValueError('A retained native recording is required')
    with (root/'telemetry/frames.jsonl').open() as stream:frame_line=next(stream)
    with (root/'telemetry/safety-v2.jsonl').open() as stream:geometry_line=next(stream)
    frame=json.loads(frame_line);geometry=json.loads(geometry_line)['vehicle_geometry']
    cameras={s['sensor_id']:s['metadata'] for s in frame['sensors'] if s['kind']=='DEPTH'}
    targets=[]
    for side,sign in [('left',-1),('right',1)]:
        for x in np.arange(-geometry['rear_m'],geometry['front_m']+.001,.5):
            for distance in (.25,.5,1.,2.):
                for z in (.25,1.):targets.append((side,[float(x),sign*(geometry['half_width_m']+distance),z]))
    for side,x in [('front',geometry['front_m']),('rear',-geometry['rear_m'])]:
        for distance in (.25,.5,1.,2.,4.,8.):
            for y in np.arange(-geometry['half_width_m']-.5,geometry['half_width_m']+.501,.5):
                for z in (.25,1.):targets.append((side,[x+(distance if side=='front' else -distance),float(y),z]))
    def cover(point):return [name for name,calibration in cameras.items() if camera_contains(point,calibration)]
    rows=[{'region':region,'point_m':point,'nominal_depth_cameras':cover(point)} for region,point in targets]
    return {'source':'NATIVE_SENSOR_MOUNT_GEOMETRY_AUDIT','native_accepted':False,
        'method':'MOUNT_AND_INTRINSIC_PROJECTION_ONLY','recording':str(root.resolve()),
        'frame_id':frame['frame_id'],'frame_row_sha256':hashlib.sha256(frame_line.encode()).hexdigest(),
        'geometry_row_sha256':hashlib.sha256(geometry_line.encode()).hexdigest(),
        'depth_mounts':{name:{k:data[k] for k in ('mount_transform','width','height','fov_deg')} for name,data in cameras.items()},
        'regions':{name:{'targets':sum(r['region']==name for r in rows),
            'outside_all_depth_images':sum(r['region']==name and not r['nominal_depth_cameras'] for r in rows)}
            for name in ('front','rear','left','right')},
        'side_examples':[{'point_m':[0.,y,1.],'nominal_depth_cameras':cover([0.,y,1.])} for y in (-3.,3.)],
        'outside_depth_images':[r for r in rows if not r['nominal_depth_cameras']],
        'qualification':'No depth/range returns or occlusion are assessed. LiDAR/radar may cover these points. This audits camera layout only and cannot pass surround calibration.'}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('recording');parser.add_argument('--output',required=True);args=parser.parse_args()
    result=audit(args.recording);output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,indent=2),encoding='utf8')
    print(json.dumps({k:result[k] for k in ('source','regions','side_examples','qualification')}))
