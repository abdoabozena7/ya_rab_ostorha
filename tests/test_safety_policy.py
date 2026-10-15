from dataclasses import replace
import json
import unittest
from backend.core.contracts import *
from backend.core.safety_policy import *
from backend.core.research import *
from backend.core.scenarios import DatasetSplit
from tests.core_packets import packet, TRANSFORM, command


def observation_frame(frame_id=1,timestamp=.05):
    channels=[]
    for kind in REQUIRED_POLICY_CHANNELS:
        data={'gyroscope_radps':[0.,0.,0.],'compass_rad':0.} if kind==SensorKind.IMU else {'detections':[]} if kind==SensorKind.RADAR else {}
        units={'gyroscope_radps':'rad/s','compass_rad':'rad'} if kind==SensorKind.IMU else {'depth_m':'m'} if kind==SensorKind.RADAR else {}
        channels.append(SensorFrame(kind.value,kind,frame_id,timestamp,timestamp,TRANSFORM,'test-fixture',
            actor_id=999,data=data,units=units,
            asset=AssetReference('test/'+kind.value+'.bin','application/octet-stream') if kind in (SensorKind.RGB,SensorKind.DEPTH,SensorKind.LIDAR) else None,
            metadata={'future_trajectory':[1,2,3]}))
    return packet(frame_id,timestamp,sensors=tuple(channels))


class PolicyBoundaryTests(unittest.TestCase):
    def test_policy_schema_excludes_privileged_world_data_and_metadata(self):
        frame=observation_frame()
        observation=sensor_observation(frame)
        encoded=json.dumps(to_dict(observation))
        for field in ('ground_truth','actors','transform','actor_id','future_trajectory','predictions','population'):
            self.assertNotIn('"'+field+'"',encoded)
        self.assertEqual(from_dict(SensorObservation,to_dict(observation)),observation)
        imu=next(s for s in frame.sensors if s.kind==SensorKind.IMU)
        unsafe=replace(imu,data={**imu.data,'future_trajectory':[1,2,3]},units={**imu.units,'future_trajectory':'m'})
        with self.assertRaises(ValueError):sensor_observation(replace(frame,sensors=tuple(unsafe if s.kind==SensorKind.IMU else s for s in frame.sensors)))

    def test_history_is_bounded_clears_on_gaps_and_requires_complete_channels(self):
        history=ObservationHistory(2)
        for i in range(1,4):history.append(observation_frame(i,i*.05))
        self.assertEqual([f.frame_id for f in history.snapshot()],[2,3])
        history.append(observation_frame(20,1.))
        self.assertEqual(len(history.snapshot()),1)
        with self.assertRaises(ValueError):history.append(observation_frame(20,1.))
        history.append(replace(observation_frame(21,1.05),sensors=()))
        self.assertFalse(history.snapshot())

    def test_steering_and_acceleration_need_current_side_space_and_path_evidence(self):
        o=sensor_observation(observation_frame())
        base=command()
        c=replace(base,source=CommandSource.SAFETY,steering=.2,throttle=.8,brake=0.)
        proposal=ProposedSafetyAction(c,'TEST_CONTRACT_FIXTURE',1,.05,True,'contract test')
        self.assertFalse(admit_proposal(o,base,proposal).accepted)
        evidence=FeasibilityEvidence(1,.05,True,True,False,False,False,.5,1.,'TEST_CONTRACT_FIXTURE','SENSOR_DERIVED_AND_ONBOARD_LIMITS')
        self.assertFalse(admit_proposal(o,base,proposal,evidence).accepted)
        evidence=replace(evidence,right_space_verified=True)
        self.assertFalse(admit_proposal(o,base,proposal,evidence).accepted)
        self.assertTrue(admit_proposal(o,base,proposal,replace(evidence,acceleration_path_verified=True)).accepted)
        self.assertFalse(admit_proposal(o,base,proposal,replace(evidence,frame_id=0)).accepted)

    def test_prepared_history_reuses_the_frozen_boundary_and_preserves_ordering(self):
        history=ObservationHistory(2)
        prepared=sensor_observation(observation_frame())
        self.assertIs(history.append_observation(prepared),prepared)
        self.assertIs(history.snapshot()[-1],prepared)
        with self.assertRaises(ValueError):history.append_observation(prepared)
        with self.assertRaises(ValueError):history.append_observation(observation_frame(2,.1))
        history.append_observation(sensor_observation(observation_frame(20,1.)))
        self.assertEqual([o.frame_id for o in history.snapshot()],[20])

    def test_comparisons_require_matched_unseen_conditions_and_real_policy_identity(self):
        metrics=ResearchMetrics()
        baseline=ComparisonRun('baseline','scenario','initial',DatasetSplit.TEST,'script-v1','MANUAL_SCRIPTED_TRACE',False,None,metrics)
        enabled=replace(baseline,run_id='enabled',safety_policy_enabled=True,safety_policy_id='TEST_CONTRACT_FIXTURE')
        self.assertTrue(matched_pair(baseline,enabled)['matched_conditions'])
        with self.assertRaises(ValueError):matched_pair(baseline,replace(enabled,actual_initial_condition_id='different'))
        with self.assertRaises(ValueError):matched_pair(replace(baseline,split=DatasetSplit.TRAIN),replace(enabled,split=DatasetSplit.TRAIN))
        with self.assertRaises(ValueError):ResearchMetrics(physically_unavoidable=True)
        self.assertIsNone(RewardComponents().progress_reward)
