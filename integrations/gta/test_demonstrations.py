import copy
import io
import json
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from backend.gta.demonstrations import DemoMemory, eligible, features
from backend.gta.goal import GoalDriver, measured_points
from backend.gta.provider import GOAL_COMMAND
from integrations.gta.test_goal_driver import scan


def qualified():
    return dict(native_acknowledged=True,guard_admitted=True,execution_matches_guard=True,
                diagnostic=False,contact=False,split='TRAIN',future_contact_free=True,
                source_ages_ms={'input':60,'camera':100,'rays':80})


class DemonstrationTests(unittest.TestCase):
    def test_unsafe_stale_diagnostic_unacknowledged_contact_and_holdout_excluded(self):
        self.assertTrue(eligible(qualified()))
        changes=({'native_acknowledged':False},{'guard_admitted':False},{'execution_matches_guard':False},
                 {'diagnostic':True},{'contact':True},{'split':'TEST'},{'future_contact_free':False},
                 {'future_coverage_gap':True},{'source_ages_ms':{'input':351}}, {'source_ages_ms':{'input':-1}})
        for change in changes:self.assertFalse(eligible({**qualified(),**change}),change)

    def test_example_memory_updates_only_qualified_training_and_has_no_authority(self):
        memory=DemoMemory();vector=np.zeros(19,np.float32)
        command=dict(steering=.2,throttle=.3,brake=0.,reverse=False)
        self.assertFalse(memory.observe({**qualified(),'diagnostic':True},vector,command))
        self.assertIsNone(memory.propose(vector))
        for _ in range(3):self.assertTrue(memory.observe(qualified(),vector,command))
        result=memory.propose(vector)
        self.assertAlmostEqual(result['steering'],.2)
        self.assertFalse(result['authority']);self.assertTrue(result['requires_current_execution_shield'])
        self.assertIsNone(memory.propose(np.ones(19,np.float32)))

    def test_native_protocol_binds_input_and_sensor_source(self):
        self.assertEqual(GOAL_COMMAND.size,85)
        packet=GOAL_COMMAND.pack(0x4f475431,2,4,12,1500,b'a'*32+b'\0',.2,.3,0.,42,67)
        self.assertEqual(GOAL_COMMAND.unpack(packet)[-2:],(42,67))

    def test_explicit_ground_transform_preserves_measured_return_and_origin(self):
        s=scan();s['rays'][0]=[0,-65,2,1,3.,3.,0.,-.82,99]
        p,o=measured_points(s,-.9)
        self.assertAlmostEqual(p[0,2],.08);self.assertAlmostEqual(o[2],2.)

    def test_unsafe_user_right_or_left_brakes_without_opposite_command(self):
        for wanted in (-1.,1.):
            driver=GoalDriver(Path('.'),'s');driver.sources_healthy=True
            driver.geometry=SimpleNamespace()
            ego=SimpleNamespace(speed_mps=0.,longitudinal_speed_mps=0.)
            observation=SimpleNamespace(frame_id=1,timestamp_s=1.,ego=ego)
            driver.scene=SimpleNamespace(observation=observation,usable=lambda a,b:True)
            driver.driver=SimpleNamespace(shield=SimpleNamespace(check=lambda *a,**k:(False,'SIDE_OCCUPIED',{})))
            raw=dict(run_id='s',focused=True,host_ms=1000,steering=wanted,forward=1.,brake_reverse=0.,handbrake=0.)
            from unittest.mock import patch
            with patch('backend.gta.goal.signed_path',return_value=np.zeros((2,4))):
                result,ok=driver.manual(raw,1100)
            self.assertFalse(ok);self.assertEqual((result['steering'],result['throttle'],result['brake']),(0.,0.,1.))

    def test_inactive_foreground_or_expired_input_never_moves(self):
        driver=GoalDriver(Path('.'),'s');driver.sources_healthy=True
        for change in ({'focused':False},{'host_ms':800},{'run_id':'other'}):
            raw=dict(run_id='s',focused=True,host_ms=1000)
            result,ok=driver.manual({**raw,**change},1200)
            self.assertFalse(ok);self.assertEqual(result['brake'],1.)


if __name__=='__main__':unittest.main()
