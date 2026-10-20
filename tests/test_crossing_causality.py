import copy
import math
from unittest import TestCase
from scripts.native.crossing_causality import critical_prediction_evidence


class CrossingCausalityTests(TestCase):
    def report(self):
        return {'pair':{'runs':{'ROBOSPHERE':{'scenario_evidence':{'events':{'critical_pedestrian':{'first_motion_elapsed_s':7.}}}},
            'NORMAL':{'scenario_evidence':{'clock_epoch_s':100.},'collision_events':[{'role':'critical_pedestrian','timestamp_s':108.5}]}}},
            'samples':[{'mode':'ROBOSPHERE','timestamp_s':106.5,'yaw_rad':0.,'speed_kmh':50.,'position_m':[0.,0.,0.],
                'scenario':{'clock_epoch_s':100.,'events':{'critical_pedestrian':{'position_m':[20.,4.,1.]}}},
                'stop':{'applied_command':{'source':'SAFETY','brake':1.},'safety':{'pedestrian_prediction':
                    {'source':'PEDESTRIAN_POSSIBLE_RUN','trajectory':[[0.,20.,4.],[1.,20.,1.]]}}}}]}

    def test_only_actual_braking_for_the_designated_person_before_motion_proves_anticipation(self):
        report=self.report();result=critical_prediction_evidence(report)
        self.assertTrue(result['passed']);self.assertEqual(result['normal_critical_contact_elapsed_s'],8.5)
        for mutation in ('different_person','after_motion','creeping','watchdog','no_brake'):
            changed=copy.deepcopy(report);sample=changed['samples'][0]
            if mutation=='different_person':sample['scenario']['events']['critical_pedestrian']['position_m']=[30.,4.,1.]
            elif mutation=='after_motion':sample['timestamp_s']=107.1
            elif mutation=='creeping':sample['speed_kmh']=3.
            elif mutation=='watchdog':sample['stop']['applied_command']['source']='COMMAND_WATCHDOG'
            else:sample['stop']['applied_command']['brake']=0.
            self.assertFalse(critical_prediction_evidence(changed)['passed'],mutation)

    def test_missing_or_historical_evidence_never_claims_verified_early_prediction(self):
        self.assertFalse(critical_prediction_evidence({})['passed'])

    def test_native_heading_is_used_in_evaluation_instead_of_comparing_ego_and_world_coordinates(self):
        report=self.report();sample=report['samples'][0]
        sample.update(yaw_rad=math.pi,position_m=[30.,10.,0.])
        sample['scenario']['events']['critical_pedestrian']['position_m']=[10.,6.,1.]
        result=critical_prediction_evidence(report)
        self.assertTrue(result['passed']);self.assertLess(result['first_critical_braking_forecast']['native_association_error_m'],1e-10)
