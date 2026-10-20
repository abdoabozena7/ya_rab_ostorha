from types import SimpleNamespace as NS
from unittest import TestCase
import numpy as np
from backend.core.depth_people import DepthPeople


class DepthPeopleTests(TestCase):
    def test_torso_seed_accepts_the_immutable_worker_packet_and_uses_its_actual_depth_pixel(self):
        from backend.computer_vision.depth_evidence import attach_depth
        from backend.core.contracts import freeze_json
        tracker=DepthPeople();args=list(self.case())
        attach_depth(args[3]['detections'],args[4]['depth'],20,1.,rgb_size=(320,180))
        pixel=args[3]['detections'][0]['depth_evidence']['pixel_center_depth']
        args[3]=freeze_json(args[3]);tracks=tracker.update(*args)
        self.assertEqual(len(tracks),1);self.assertEqual(tracks[0]['class'],'person')
        self.assertAlmostEqual(tracker.tracks['depth-person-0']['seed_height'],1.-(pixel[1]-89.5)/160*20.)

    def test_current_measured_motion_continues_as_unknown_when_rgb_classification_expires(self):
        tracker=DepthPeople();tracks=[]
        for index in range(90):
            stamp=1.+index*.05;frame=20+index
            prediction,obs,poses,result,images=self.case(stamp,frame)
            y=3.0625+index*.1;u=159.5+160*y/20.
            image=np.full((180,320),1000.);image[75:105,round(u)-3:round(u)+4]=20.;images['depth']=image
            tracks=tracker.update(prediction,obs,poses,result,images)
        self.assertEqual(len(tracks),1);track=tracks[0]
        self.assertEqual(track['class'],'UNKNOWN');self.assertNotIn('semantic_evidence',track)
        self.assertEqual(track['measurement_evidence']['frame_id'],109)
        self.assertGreater(track['measurement_evidence']['motion_span_s'],.15)
        self.assertGreater(track['velocity_mps'][1],1.5)
        prediction,obs,poses,result,images=self.case(5.5,110,visible=False)
        self.assertEqual(tracker.update(prediction,obs,poses,result,images),[])

    def test_crossing_clearance_uses_the_audited_vehicle_width_and_retains_a_margin(self):
        from backend.core.motion_geometry import VehicleGeometry
        for half_width,expected in ((1.01,True),(1.5,False)):
            tracker=DepthPeople()
            for index,y in enumerate(list(np.linspace(4.,-2.5,32))+[-2.5]*10):
                stamp=1.+index*.2;frame=20+index
                prediction,obs,_,result,images=self.case(stamp,frame)
                u=159.5+160*y/20;image=np.full((180,320),1000.)
                image[75:105,round(u)-3:round(u)+4]=20.;images['depth']=image
                result.update(frame_id=frame,timestamp_s=stamp)
                detection=result['detections'][0];detection['xyxy']=[u-3,75,u+3,104]
                detection['depth_evidence'].update(frame_id=frame,timestamp_s=stamp)
                tracks=tracker.update(prediction,obs,[[stamp,0.,0.,0.,frame]],result,images,
                    geometry=VehicleGeometry(half_width_m=half_width))
            self.assertEqual(tracks[0]['observed_crossing_cleared'],expected)

    def test_high_resolution_rgb_maps_to_its_aligned_lower_resolution_depth(self):
        tracker=DepthPeople()
        for index in range(3):
            args=list(self.case(1.+index*.05,20+index,index*.1));rgb=args[1].channels[0]
            rgb.calibration={**rgb.calibration,'width':640,'height':360}
            args[3]['detections'][0]['xyxy']=[(v+.5)*2-.5 for v in args[3]['detections'][0]['xyxy']]
            tracks=tracker.update(*args)
        self.assertEqual(len(tracks),1);self.assertTrue(tracks[0]['confirmed'])
        self.assertAlmostEqual(tracks[0]['position_m'][0],19.8,places=3)

    def case(self,stamp=1.,frame=20,origin=0.,*,visible=True):
        calibration={'width':320,'height':180,'fov_deg':90.,
            'mount_transform':{'position_m':[0.,0.,1.],'rotation_deg':{}}}
        channels=[NS(sensor_id='frontCamera',calibration=calibration),NS(sensor_id='depth',calibration=calibration,asset=NS(path='depth'))]
        obs=NS(frame_id=frame,timestamp_s=stamp,channels=channels)
        image=np.full((180,320),1000.)
        if visible:image[75:105,180:190]=20.-origin
        prediction={'session_id':'s','odometry_origin_m':[origin,0.],'odometry_yaw_rad':0.}
        result={'session_id':'s','status':'RUNNING','frame_id':20,'timestamp_s':1.,'detections':[
            {'class':'person','confidence':.9,'xyxy':[180.,75.,187.,104.],
             'depth_evidence':{'source_sensor':'depth','frame_id':20,'timestamp_s':1.,'axial_m':20.}}]}
        poses=[[1.,0.,0.,0.,20],[stamp,origin,0.,0.,frame]] if frame>20 else [[1.,0.,0.,0.,20]]
        return prediction,obs,poses,result,{'depth':image}

    def test_person_is_separate_from_merged_surfaces_with_current_depth_and_odometry(self):
        tracker=DepthPeople()
        for i in range(3):
            tracks=tracker.update(*self.case(1.+i*.05,20+i,i*.1))
        self.assertEqual(len(tracks),1);track=tracks[0]
        self.assertTrue(track['confirmed']);self.assertEqual(track['class'],'person')
        self.assertAlmostEqual(track['position_m'][0],19.8,places=3)
        self.assertEqual(track['measurement_evidence']['frame_id'],22)
        self.assertLess(np.linalg.norm(track['velocity_mps']),1.)

    def test_absent_current_depth_stale_or_foreign_rgb_never_publishes_a_person(self):
        tracker=DepthPeople();tracker.update(*self.case())
        self.assertEqual(tracker.update(*self.case(1.05,21,.1,visible=False)),[])
        current=tracker.update(*self.case(1.8,36,.1))
        self.assertEqual(current[0]['class'],'UNKNOWN');self.assertNotIn('semantic_evidence',current[0])
        self.assertEqual(current[0]['measurement_evidence']['frame_id'],36)
        self.assertEqual(tracker.update(*self.case(1.85,37,.1,visible=False)),[])
        args=list(self.case());args[3]['session_id']='foreign'
        self.assertEqual(DepthPeople().update(*args),[])

    def test_measured_full_crossing_is_remembered_until_actual_motion_turns_back(self):
        tracker=DepthPeople();track=None
        positions=list(np.linspace(4.,-4.,31))+list(np.linspace(-4.,-2.,10))
        cleared=False
        for index,y in enumerate(positions):
            stamp=1.+index*.2;frame=20+index
            prediction,obs,_,result,images=self.case(stamp,frame)
            u=159.5+160*y/20;image=np.full((180,320),1000.)
            image[75:105,round(u)-3:round(u)+4]=20.;images['depth']=image
            result.update(frame_id=frame,timestamp_s=stamp)
            detection=result['detections'][0];detection['xyxy']=[u-3,75,u+3,104]
            detection['depth_evidence'].update(frame_id=frame,timestamp_s=stamp)
            tracks=tracker.update(prediction,obs,[[stamp,0.,0.,0.,frame]],result,images)
            self.assertEqual(len(tracks),1)
            track=tracks[0]
            if index==30:cleared=track['observed_crossing_cleared']
        self.assertTrue(cleared)
        self.assertFalse(track['observed_crossing_cleared'])

    def test_uncertain_rgb_can_keep_identity_but_never_publish_a_classified_person(self):
        tracker=DepthPeople()
        for index in range(20):
            args=list(self.case(1.+index*.05,20+index))
            result=args[3];result.update(frame_id=20+index,timestamp_s=1.+index*.05)
            detection=result['detections'][0];detection['confidence']=.4
            detection['depth_evidence'].update(frame_id=20+index,timestamp_s=1.+index*.05)
            measured=tracker.update(*args)
            self.assertTrue(all(t['class']=='UNKNOWN' and 'semantic_evidence' not in t for t in measured))
        self.assertEqual(len(tracker.tracks),1)
        args=list(self.case());args[3]['detections'][0]['depth_evidence']['frame_id']=19
        self.assertEqual(DepthPeople().update(*args),[])
