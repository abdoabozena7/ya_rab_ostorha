import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image
from backend.core.shared_perception import common_prefix,divergence,export_shared
from backend.core.scene_overlays import overlay_geometry,box_corners


def frame(index):
    return {'frame_id':index,'timestamp_s':index*.05,'vehicle':{'transform':{'position_m':[index*.1,0.,0.],
        'rotation_rad':{'yaw':0.}},'speed_mps':2.,'steering':0.,'throttle':.5,'brake':0.},
        'comparison':{'elapsed_s':index*.05,'scenario_id':'same','roles':{'critical_pedestrian':[10.,3.,.95,0.]}}}


class SharedPrefixTests(unittest.TestCase):
    def test_held_start_is_retained_when_traffic_diverges_on_the_first_released_tick(self):
        a=[frame(i) for i in range(-2,3)];b=[frame(i) for i in range(-1,3)]
        b[2]['comparison']['roles']['critical_pedestrian'][3]=20.
        prefix,reason=common_prefix(a,b)
        self.assertEqual([f['comparison']['elapsed_s'] for f in prefix],[-.05,0.])
        self.assertEqual(reason,'VISIBLE_PARTICIPANT_MOTION_DIVERGED')

    def test_first_control_pose_or_scene_difference_ends_prefix_permanently(self):
        a=[frame(i) for i in range(5)];b=copy.deepcopy(a);b[2]['vehicle']['speed_mps']=1.
        prefix,reason=common_prefix(a,b)
        self.assertEqual(len(prefix),2);self.assertEqual(reason,'EGO_SPEED_DIVERGED')
        changed=copy.deepcopy(a[0]);changed['vehicle']['brake']=1.
        self.assertIsNone(divergence(a[0],changed)) # Compare motion, not desired pedals.
        for key,value,expected in [('elapsed_s',.5,'SIMULATION_CLOCK_MISMATCH'),('roles',{},'VISIBLE_PARTICIPANTS_DIVERGED')]:
            changed=copy.deepcopy(a[0]);changed['comparison'][key]=value
            self.assertEqual(divergence(a[0],changed),expected)
        changed=copy.deepcopy(a[0]);changed['vehicle']['transform']['position_m'][0]=1.
        self.assertEqual(divergence(a[0],changed),'EGO_POSITION_DIVERGED')
        self.assertEqual(common_prefix(a,[changed])[0],[])

    def test_export_uses_front_camera_and_exact_image_detections_only(self):
        try:import imageio_ffmpeg
        except ImportError:self.skipTest('MP4 encoder unavailable')
        with tempfile.TemporaryDirectory() as directory:
            roots={m:Path(directory)/m for m in ('NORMAL','ROBOSPHERE')}
            for mode,root in roots.items():
                (root/'telemetry').mkdir(parents=True)
                (root/'metadata.json').write_text(json.dumps({'provider':'fixture','config':{'session_id':mode}}))
                (root/'recording-status.json').write_text(json.dumps({'finalized':True,'incomplete':False}))
                frames=[];trace=[]
                for i in range(4):
                    image=root/f'{i}.jpg';Image.new('RGB',(160,90),'#172932').save(image)
                    digest=hashlib.sha256(image.read_bytes()).hexdigest();f=frame(i)
                    if mode=='ROBOSPHERE' and i==3:f['vehicle']['speed_mps']=1.
                    native=f.pop('comparison');trace.append({'kind':'SCENARIO_FRAME','frame_id':i,**native})
                    f['sensors']=[{'sensor_id':'frontCamera','frame_id':i,'timestamp_s':i*.05,'asset':{'path':image.name,'sha256':digest}}];frames.append(f)
                    trace.append({'kind':'CAMERA_DETECTIONS','result':{'frame_id':i,'timestamp_s':i*.05,'session_id':mode,
                        'source_image_sha256':digest if i!=1 else 'foreign-image','detections':[{'class':'person','confidence':.9,'xyxy':[3.,3.,15.,30.]}]}})
                (root/'telemetry/frames.jsonl').write_text(''.join(json.dumps(f)+'\n' for f in frames))
                (root/'telemetry/comparison-controls.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in trace))
            pair={'pair_id':'pair','runs':{m:{'recording':str(root)} for m,root in roots.items()}}
            status=export_shared(pair,allow_test_data=True)
            self.assertEqual(status['frames'],3);self.assertEqual(status['detection_boxes'],2)
            self.assertEqual(status['boundary_reason'],'EGO_SPEED_DIVERGED')
            self.assertAlmostEqual(status['end_elapsed_s'],.1)
            self.assertTrue((roots['NORMAL']/'shared-perception.mp4').is_file())

    def test_measured_volume_and_arrow_geometry_reject_stale_boxes_without_global_cap(self):
        box={'track_id':1,'source':'CURRENT_SENSOR_GEOMETRY','measurement_frame':3,'class':'person',
            'center_m':[10.,2.,1.],'half_size_m':[.3,.4,.8],'velocity_mps':[0.,1.]}
        p={'timestamp_s':1.,'evaluation_frame':3,'boxes_3d':[box]*9,
            'trajectories':[{'track_id':i,'class':'person','points':[[0.,10.,2.],[1.,10.,-2.]]} for i in range(5)]}
        self.assertEqual(len(box_corners(box)),8)
        self.assertEqual(tuple(map(len,overlay_geometry(p,1.1))),(9,5))
        self.assertEqual(tuple(map(len,overlay_geometry(p,1.2))),(0,5))
        self.assertEqual(tuple(map(len,overlay_geometry(p,.9))),(0,0))
