"""Explicit Doppler geometry packets; these tests simulate no vehicle physics."""
from collections import deque
from dataclasses import replace
import math
import unittest
import numpy as np
from backend.core.contracts import SensorKind
from backend.core.control_radar import RadarVelocityFusion, measured_returns
from backend.core.prediction import MotionTracker,rotation
from tests.test_safety_teacher import case


class ControlRadarTests(unittest.TestCase):
    def test_vectorized_returns_preserve_scalar_geometry_and_filtering(self):
        from backend.core.active_safety import _mount
        observation,poses,_,_=self.packet((1.,2.),yaw=.05)
        channel=next(c for c in observation.channels if c.kind==SensorKind.RADAR)
        bad=[dict(channel.data['detections'][0],**change) for change in
             ({'depth_m':-1.},{'altitude_rad':.8},{'altitude_rad':-.8})]
        revised=replace(channel,data={'detections':[*channel.data['detections'],*bad]})
        observation=replace(observation,channels=tuple(revised if c is channel else c for c in observation.channels))
        expected=[];old,current=poses;dt=current[0]-old[0]
        r,prior=rotation(current[3]),rotation(old[3])
        position,angles=_mount(revised)
        velocity=r.T@((np.array(current[1:3])+r@position[:2])-(np.array(old[1:3])+prior@position[:2]))/dt
        for d in revised.data['detections']:
            distance,az,alt,speed=(d[k] for k in ('depth_m','azimuth_rad','altitude_rad','velocity_mps'))
            if not all(math.isfinite(v) for v in (distance,az,alt,speed)) or distance<=0:continue
            direction=rotation(math.radians(angles[2]))@np.array([math.cos(alt)*math.cos(az),math.cos(alt)*math.sin(az)])
            xyz=np.r_[position[:2]+distance*direction,position[2]+distance*math.sin(alt)]
            if .25<xyz[2]<2.5 and abs(alt)<.2:expected.append([*xyz,*direction,speed+direction@velocity])
        np.testing.assert_allclose(measured_returns(observation,poses),expected,atol=1e-12)

    def packet(self,velocity=(0.,0.),*,collinear=False,yaw=.0):
        observation,_=case(1,distance=None,speed=4.)
        mount=np.array([2.5,0.,.65]);r=rotation(yaw)
        poses=[(observation.timestamp_s-.05,0.,0.,0.),(observation.timestamp_s,.2,0.,yaw)]
        sensor_velocity=r.T@((np.array([.2,0.])+r@mount[:2])-mount[:2])/.05
        points=[(x,y,1.) for x in ((8.,8.5,9.,9.5,10.) if collinear else (8.,9.,10.)) for y in ((0.,) if collinear else (2.,3.,4.))]
        data=[]
        for point in points:
            delta=np.array(point)-mount;distance=np.linalg.norm(delta);direction=delta/distance
            data.append({'depth_m':distance,'azimuth_rad':math.atan2(delta[1],delta[0])-math.pi/4,
                         'altitude_rad':math.asin(direction[2]),
                         'velocity_mps':float((np.asarray(velocity)-sensor_velocity)@direction[:2])})
        channel=next(c for c in observation.channels if c.kind==SensorKind.RADAR)
        channel=replace(channel,sensor_id='frontRightRadar',data={'detections':data},
            calibration={'mount_transform':{'position_m':mount.tolist(),'rotation_deg':{'roll':0.,'pitch':0.,'yaw':45.}}})
        observation=replace(observation,channels=tuple(channel if c.kind==SensorKind.RADAR else c for c in observation.channels))
        position=np.array([9.,0. if collinear else 3.]);world=np.array([.2,0.])+r@position
        track={'id':'1','position_m':position.tolist(),'half_size_m':[1.1,1.1],
               'velocity_mps':[2.,-1.],'acceleration_mps2':[1.,-1.],'occlusion_s':0.,
               'confirmed':True,'history':[]}
        tracker=MotionTracker(enhanced=True)
        tracker.tracks[1]={'position':world.copy(),'anchor':world.copy(),'velocity':r@np.array([2.,-1.]),
            'acceleration':np.zeros(2),'history':deque([(observation.timestamp_s,*world,2.,-1.)])}
        prediction={'tracks':[track],'odometry_yaw_rad':yaw,'odometry_origin_m':[.2,0.]}
        return observation,poses,tracker,prediction

    def test_parked_body_keeps_its_measured_bounds_and_loses_spurious_registered_motion(self):
        observation,poses,tracker,prediction=self.packet()
        count=RadarVelocityFusion().apply(prediction,observation,poses,tracker)
        self.assertEqual(count,1)
        track=prediction['tracks'][0]
        np.testing.assert_allclose(track['velocity_mps'],[0.,0.],atol=1e-10)
        self.assertEqual(track['position_m'],[9.,3.]);self.assertEqual(track['half_size_m'],[1.1,1.1])
        self.assertEqual(track['doppler_evidence']['source_frame'],observation.frame_id)

    def test_crossing_velocity_is_recovered_from_relative_doppler_without_actor_labels(self):
        observation,poses,tracker,prediction=self.packet((1.,2.))
        self.assertEqual(RadarVelocityFusion().apply(prediction,observation,poses,tracker),1)
        np.testing.assert_allclose(prediction['tracks'][0]['velocity_mps'],[1.,2.],atol=1e-10)

    def test_own_yaw_and_offset_sensor_motion_use_the_same_finite_pose_interval(self):
        observation,poses,tracker,prediction=self.packet(yaw=.05)
        self.assertEqual(RadarVelocityFusion().apply(prediction,observation,poses,tracker),1)
        np.testing.assert_allclose(prediction['tracks'][0]['velocity_mps'],[0.,0.],atol=1e-10)

    def test_unobservable_lateral_velocity_and_ambiguous_boxes_are_not_invented(self):
        observation,poses,tracker,prediction=self.packet(collinear=True)
        self.assertEqual(RadarVelocityFusion().apply(prediction,observation,poses,tracker),1)
        track=prediction['tracks'][0]
        np.testing.assert_allclose(track['velocity_mps'],[0.,-1.],atol=1e-10)
        self.assertEqual(track['doppler_evidence']['observable_rank'],1)
        self.assertEqual(track['doppler_evidence']['unobserved_directions'],'RETAINED_UNCALIBRATED_SURFACE_ESTIMATE')
        observation,poses,tracker,prediction=self.packet()
        prediction['tracks'].append({**prediction['tracks'][0],'id':'2'})
        self.assertEqual(RadarVelocityFusion().apply(prediction,observation,poses,tracker),0)

    def test_rank_one_doppler_preserves_true_radial_motion_and_does_not_zero_the_other_axis(self):
        observation,poses,tracker,prediction=self.packet((1.5,2.),collinear=True)
        self.assertEqual(RadarVelocityFusion().apply(prediction,observation,poses,tracker),1)
        np.testing.assert_allclose(prediction['tracks'][0]['velocity_mps'],[1.5,-1.],atol=1e-10)
        self.assertEqual(prediction['tracks'][0]['half_size_m'],[1.1,1.1])

    def test_inconsistent_doppler_cannot_overwrite_the_surface_estimate(self):
        observation,poses,tracker,prediction=self.packet(collinear=True)
        channel=next(c for c in observation.channels if c.kind==SensorKind.RADAR)
        detections=[{**d,'velocity_mps':d['velocity_mps']+(4. if i%2 else -4.)} for i,d in enumerate(channel.data['detections'])]
        bad=replace(channel,data={'detections':detections})
        observation=replace(observation,channels=tuple(bad if c is channel else c for c in observation.channels))
        self.assertEqual(RadarVelocityFusion().apply(prediction,observation,poses,tracker),0)
        self.assertEqual(prediction['tracks'][0]['velocity_mps'],[2.,-1.])


if __name__=='__main__':unittest.main()
