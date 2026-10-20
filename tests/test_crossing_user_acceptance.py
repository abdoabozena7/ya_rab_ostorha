import copy
from unittest import TestCase
from scripts.crossing_user_acceptance import prediction_before_ingress


class CrossingUserAcceptanceTests(TestCase):
    def case(self):
        sample={'mode':'ROBOSPHERE','timestamp_s':105.,'yaw_rad':0.,'speed_kmh':55.,'position_m':[0.,0.,0.],
            'scenario':{'events':{'critical_pedestrian':{'position_m':[20.,4.,1.]}}},
            'stop':{'evaluation_frame':10,'reason':'Braking for a person who may cross the driving path','applied_command':{'source':'SAFETY','brake':1.},
                'safety':{'reactive_risk':'FORWARD_CLEAR_SIDE_REAR_UNVERIFIED','pedestrian_prediction':
                    {'source':'PEDESTRIAN_POSSIBLE_RUN','measurement_frame':10,'trajectory':[[0.,20.,4.],[1.,20.,1.]]}}}}
        entered=copy.deepcopy(sample);entered['timestamp_s']=106.;entered['scenario']['events']['critical_pedestrian']['position_m']=[20.,1.9,1.]
        return {'pair':{'manifest':{'origin':{'location':[0.,0.,0.],'rotation':[0.,0.,0.]}},'runs':{
            'ROBOSPHERE':{'scenario_evidence':{'clock_epoch_s':100.,'events':{'critical_pedestrian':{'first_motion_elapsed_s':4.9}}}},
            'NORMAL':{'scenario_evidence':{'clock_epoch_s':100.},'collision_events':[{'role':'critical_pedestrian','type':'walker.pedestrian.0001','timestamp_s':106.2}]}}},
            'samples':[sample,entered]}

    def test_forecast_after_first_foot_motion_still_precedes_path_ingress_with_measured_clearance(self):
        report=self.case();result=prediction_before_ingress(report)
        self.assertTrue(result['passed']);self.assertEqual(result['path_ingress_lead_s'],1.)
        self.assertGreater(result['first_forecast']['elapsed_s'],result['first_native_motion_elapsed_s'])

    def test_watchdog_reactive_late_wrong_person_stale_frame_and_creeping_are_not_predictive_evidence(self):
        for change in ('watchdog','processing_deadline','reactive','late','wrong_person','stale','creeping'):
            report=self.case();sample=report['samples'][0]
            if change=='watchdog':sample['stop']['applied_command']['source']='COMMAND_WATCHDOG'
            elif change=='processing_deadline':sample['stop']['reason']='CONTROL_PROCESSING_DEADLINE'
            elif change=='reactive':sample['stop']['safety']['reactive_risk']='FORWARD_COLLISION_RISK'
            elif change=='late':sample['timestamp_s']=105.8
            elif change=='wrong_person':sample['scenario']['events']['critical_pedestrian']['position_m']=[25.,4.,1.]
            elif change=='stale':sample['stop']['evaluation_frame']=11
            else:sample['speed_kmh']=3.
            self.assertFalse(prediction_before_ingress(report)['passed'],change)

    def test_missing_history_or_ingress_is_not_a_verified_success(self):
        self.assertFalse(prediction_before_ingress({})['passed'])
        report=self.case();report['samples'].pop()
        self.assertFalse(prediction_before_ingress(report)['passed'])
