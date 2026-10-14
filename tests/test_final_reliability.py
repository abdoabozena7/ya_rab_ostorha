"""Focused recording, measured path-conflict and freshness regressions."""
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
import numpy as np
from backend.core.active_safety import ActiveSafetySupervisor
from backend.core.recording import BufferedRunRecorder, RunRecorder
from backend.core.replay import ReplayReader
from backend.core.path_conflicts import LidarPathConflicts
from backend.core.service import SimulationService
from backend.core.control import ControlMode
from backend.core.contracts import CommandSource, SensorKind
from tests.core_packets import packet, metadata
from tests.test_safety_teacher import case
from tests.test_active_safety import scene
from tests.test_rl import policy_fixture


class FinalReliabilityTests(unittest.TestCase):
    def test_queue_cannot_be_unbounded_or_accumulate_parallel_retired_writers(self):
        for bounds in ({'capacity':0},{'capacity':True},{'maximum_bytes':0}):
            with self.assertRaisesRegex(ValueError,'bounds'):BufferedRunRecorder(Mock(),**bounds)
        service=SimulationService(Mock(sensor_suite=False));service.last_recording=Mock(closed=False)
        with self.assertRaisesRegex(ValueError,'still finalizing'):service._change_recording({'enabled':True})

    def test_overloaded_writer_retains_prefix_and_reports_all_drops_without_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            writer=RunRecorder(directory,metadata());entered=threading.Event();release=threading.Event()
            original=writer.record
            def slow(*args,**kwargs):entered.set();release.wait(2);return original(*args,**kwargs)
            writer.record=slow;recorder=BufferedRunRecorder(writer,capacity=1)
            self.assertTrue(recorder.submit(packet(1,.05),[]));self.assertTrue(entered.wait(1))
            self.assertTrue(recorder.submit(packet(2,.1),[]));began=time.monotonic()
            self.assertFalse(recorder.submit(packet(3,.15),[]));self.assertFalse(recorder.submit(packet(4,.2),[]))
            self.assertLess(time.monotonic()-began,.1)
            release.set();recorder.close();status=json.loads((recorder.root/'recording-status.json').read_text())
            self.assertEqual(status['dropped_frames'],2);self.assertEqual(status['written_frames'],2)
            self.assertTrue(status['finalized']);self.assertEqual(status['first_dropped_frame'],3)
            self.assertEqual([json.loads(r)['frame_id'] for r in (recorder.root/'telemetry/frames.jsonl').read_text().splitlines()],[1,2])
            with self.assertRaisesRegex(ValueError,'incomplete'):ReplayReader(recorder.root,allow_test_data=True)

    def test_byte_bound_and_disk_error_are_reported_without_throwing_into_control(self):
        writer=Mock();writer.record.side_effect=OSError('disk full')
        recorder=BufferedRunRecorder(writer,maximum_bytes=4)
        self.assertFalse(recorder.submit(packet(1),[(None,b'12345')]))
        self.assertEqual(recorder.status()['dropped_frames'],1);recorder.close()
        recorder=BufferedRunRecorder(writer);recorder.submit(packet(1),[])
        recorder.thread.join(.2)
        self.assertFalse(recorder.submit(packet(2,.1),[]))
        self.assertEqual(recorder.status()['dropped_frames'],2)
        with self.assertRaisesRegex(RuntimeError,'disk full'):recorder.close()

    def test_unfinalized_recording_cannot_be_opened_as_a_complete_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            recorder=BufferedRunRecorder(RunRecorder(directory,metadata()))
            with self.assertRaisesRegex(ValueError,'RECORDING_NOT_FINALIZED'):
                ReplayReader(recorder.root,allow_test_data=True)
            recorder.submit(packet(1),[]);recorder.close()
            self.assertEqual(ReplayReader(recorder.root,allow_test_data=True).frame_at(0).frame_id,1)

    def test_comparison_trace_is_queued_and_keeps_native_frame_time_order(self):
        with tempfile.TemporaryDirectory() as directory:
            recorder=BufferedRunRecorder(RunRecorder(directory,metadata()))
            for i in range(1,5):
                recorder.submit(packet(i,i*.05),[])
                recorder.record_trace({'frame_id':i,'timestamp_s':i*.05,'complete':True})
            recorder.close();reader=ReplayReader(recorder.root,allow_test_data=True)
            rows=[json.loads(r) for r in (recorder.root/'telemetry/comparison-controls.jsonl').read_text().splitlines()]
            self.assertEqual([(r['frame_id'],r['timestamp_s']) for r in rows],[(f.frame_id,f.timestamp_s) for f in reader.frames()])
            self.assertEqual(recorder.status()['dropped_trace_rows'],0)

    def test_measured_lateral_motion_brakes_then_releases_without_steering(self):
        supervisor=ActiveSafetySupervisor();braked=False
        for frame in range(1,13):
            o,b=case(frame,distance=None);o,road=scene(o,clear=True)
            o=replace(o,ego=replace(o.ego,speed_mps=3.,angular_velocity_radps=(0.,0.,0.)))
            # Independent LiDAR surface samples of a crossing body; no actor object.
            y=4.-frame*.08
            # Start far enough ahead that ingress into the physical corridor
            # occurs before ego passes it, rather than only into padding.
            side=[[7.-frame*.15+dx,y+dy,-1.,.5] for dx in (-.4,0.,.4) for dy in (-.3,0.,.3)]
            cloud=np.frombuffer(road(None),'<f4').reshape(-1,4)
            data=np.vstack((cloud,np.asarray(side))).astype('<f4').tobytes()
            c=supervisor.evaluate(o,b,lambda _:data,as_of_timestamp_s=o.timestamp_s)
            if supervisor.status['path_conflict']:
                braked=True;self.assertEqual(c.brake,1.);self.assertEqual(c.steering,b.steering)
                self.assertLessEqual(supervisor.status['path_conflict']['time_to_conflict_s'],2.5)
        self.assertTrue(braked)
        for frame in range(13,40):
            o,b=case(frame,distance=None);o,reader=scene(o,clear=True)
            supervisor.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
        self.assertFalse(supervisor.active)
        self.assertFalse(supervisor.status['side_rear_free_space_verified'])

    def test_static_or_away_surface_does_not_invent_a_conflict(self):
        for lateral in (0.,.08):
            tracker=LidarPathConflicts()
            for frame in range(1,12):
                o,_=case(frame,distance=None);o=replace(o,ego=replace(o.ego,speed_mps=0.))
                points=np.asarray([[4.+dx,4.+frame*lateral+dy,1.] for dx in (-.4,0.,.4) for dy in (-.3,0.,.3)])
                result=tracker.assess(points,o);self.assertIsNone(result['conflict'])
                self.assertIn('UNKNOWN',result['coverage'])

    def test_partial_wall_returns_do_not_turn_bounds_motion_into_actor_motion(self):
        tracker=LidarPathConflicts()
        for frame in range(1,15):
            o,_=case(frame,distance=None);o=replace(o,ego=replace(o.ego,speed_mps=0.))
            points=np.asarray([[x,4.,z] for x in np.arange(1+frame*.12,5.,.12) for z in (.6,1.,1.4)])
            self.assertIsNone(tracker.assess(points,o)['conflict'])

    def test_observed_rear_surface_approaching_centerline_is_diagnostic_only(self):
        tracker=LidarPathConflicts();conflicts=[];observations=[]
        for frame in range(1,13):
            o,_=case(frame,distance=None);o=replace(o,ego=replace(o.ego,speed_mps=0.))
            points=np.asarray([[-7+frame*.15,dy,z] for z in (.6,1.,1.4) for dy in (-.3,0.,.3)])
            result=tracker.assess(points,o)
            conflicts.append(result['conflict']);observations.extend(result['observations'])
        self.assertFalse(any(conflicts))
        self.assertTrue(any(item['relation']=='REAR_APPROACH' for item in observations))

    def test_callback_age_cannot_be_refreshed_by_late_publication(self):
        now=[1.];o,b=case(distance=8.,velocity=-8.);o,reader=scene(o)
        p=Mock(sensor_suite=False);p.get_sensor_asset=reader
        s=SimulationService(p,now=lambda:now[0]);s.active_safety=ActiveSafetySupervisor()
        s.observation=policy_fixture();s.clock.observe(s.observation.world);s.policy_history.frames.append(o)
        s.state_at=1.;s.safety_observed_at=.7;s.arbiter.machine.mode=ControlMode.MANUAL
        s.arbiter.submit(replace(b,source=CommandSource.MANUAL),frame_id=o.frame_id,timestamp_s=o.timestamp_s,connected=True)
        with patch.object(s,'_live',return_value=True):s._active_safety_step()
        self.assertEqual(s.active_safety.status['status'],'SENSOR_FAULT_STOP')
        self.assertEqual(s.arbiter.machine.mode,ControlMode.PAUSED);self.assertIsNone(s.safety_command)

    def test_processing_overrun_rejects_the_proposal_and_holds_for_a_new_fresh_frame(self):
        now=[0.];o,b=case(distance=8.,velocity=-8.);o,reader=scene(o)
        def delayed(asset):now[0]=.3;return reader(asset)
        p=Mock(sensor_suite=False);p.get_sensor_asset=delayed
        s=SimulationService(p,now=lambda:now[0]);s.active_safety=ActiveSafetySupervisor()
        s.observation=policy_fixture();s.clock.observe(s.observation.world);s.policy_history.frames.append(o)
        s.safety_observed_at=0.;s.arbiter.machine.mode=ControlMode.MANUAL
        s.arbiter.submit(replace(b,source=CommandSource.MANUAL),frame_id=o.frame_id,timestamp_s=o.timestamp_s,connected=True)
        with patch.object(s,'_live',return_value=True):s._active_safety_step()
        self.assertIn('processing exceeded',s.safety_fault['message'])
        self.assertIsNone(s.active_safety.last_fault)
        self.assertEqual(s.arbiter.machine.mode,ControlMode.MANUAL)
        self.assertEqual(s.safety_command.brake,1.)
        self.assertEqual(s.safety_command.throttle,0.)
        self.assertEqual(s.active_safety.status['status'],'SENSOR_DELAY_HOLD')


if __name__=='__main__':unittest.main()
