"""Measured ordinary comparison lifecycle; no CARLA or native mutations."""
import copy
from dataclasses import replace
import tempfile
import unittest
from backend.core.journey_comparison import JourneyComparison, matching_setup
from tests.core_packets import packet


def manifest():
    return {'map':'Town05','blueprint':'vehicle.test','destination':{'name':'Test road','location':[10,0,0]},
            'speed_kmh':30,'population':{'seed':42},'actual_population':{'vehicles':2},'weather':{},
            'origin':{'location':[0,0,0],'rotation':[0,0,0]},'route_length_m':10,
            'collision_measurement_available':True}


class JourneyComparisonTests(unittest.TestCase):
    def test_different_vehicle_protocol_matches_world_without_claiming_equal_vehicle_conditions(self):
        with tempfile.TemporaryDirectory() as directory:
            comparison=JourneyComparison(directory)
            first={**manifest(),'guided':True,'presentation_order':['NORMAL','ROBOSPHERE'],
                'vehicle_variants':{'NORMAL':'vehicle.test','ROBOSPHERE':'vehicle.other'},'initial_condition_id':'same-world'}
            r=comparison.begin('NORMAL',first);r['initial_condition_audit']={'passed':True};comparison.finish('guided_shortened')
            second={**first,'blueprint':'vehicle.other'}
            r=comparison.begin('ROBOSPHERE',second,pair_id=comparison.data['pair_id']);r['initial_condition_audit']={'passed':True};comparison.finish('guided_shortened')
            result=comparison.snapshot()
            self.assertEqual(result['version'],5);self.assertFalse(result['conditions_match'])
            self.assertTrue(result['world_start_match']);self.assertTrue(result['vehicle_models_differ'])
            r['initial_condition_audit']['passed']=False
            self.assertFalse(comparison.snapshot()['world_start_match'])
    def test_measured_peak_does_not_become_the_requested_speed_or_count_duplicate_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            comparison=JourneyComparison(directory);run=comparison.begin('HYBRID',manifest())
            comparison.sample(packet(1,.1,speed=3.),None,{})
            comparison.sample(packet(2,.2,speed=5.),None,{})
            comparison.sample(packet(2,.2,speed=20.),None,{})
            self.assertEqual(run['maximum_speed_kmh'],18.)
            self.assertAlmostEqual(run['mean_speed_kmh'],14.4)
            self.assertEqual(run['setup']['speed_kmh'],30)
            self.assertEqual(run['samples'],2)

    def test_comparability_requires_complete_finite_matching_manifests(self):
        a=manifest();self.assertTrue(matching_setup(a,copy.deepcopy(a)))
        for change in ({'origin':None},{'weather':None},{'live_speed_changed':True},{'actual_population':{'vehicles':3}},
                       {'origin':{'location':[0,0,float('nan')],'rotation':[0,0,0]}},
                       {'origin':{'location':[0,0,0],'rotation':[0]}}):
            self.assertFalse(matching_setup(a,{**a,**change}))
        self.assertFalse(matching_setup({},{}))

    def test_paired_runs_persist_separate_ids_and_retry_preserves_attempt(self):
        with tempfile.TemporaryDirectory() as d:
            c=JourneyComparison(d);first=c.begin('ROBOSPHERE',manifest(),recording='recording-a')['id']
            c.sample(packet(1,.1),{'remaining_m':5},{'frame_id':1,'risk':'CLEAR','active':False})
            c.finish('destination_reached');pair=c.data['pair_id']
            c.begin('NORMAL',manifest(),pair_id=pair,recording='recording-b');c.finish('operator_stop')
            self.assertEqual(c.data['runs']['ROBOSPHERE']['id'],first)
            c.begin('NORMAL',manifest(),pair_id=pair);c.finish('destination_reached')
            self.assertEqual(len(c.data['previous_attempts']),1)
            saved=JourneyComparison(d).snapshot();self.assertTrue(saved['conditions_match'])
            self.assertEqual(saved['runs']['NORMAL']['status'],'ARRIVED')
            self.assertTrue(saved['runs']['ROBOSPHERE']['destination_reached'])

    def test_unknown_and_stale_observers_never_count_as_clear(self):
        with tempfile.TemporaryDirectory() as d:
            c=JourneyComparison(d);r=c.begin('NORMAL',manifest())
            c.sample(packet(1,.1),None,{'frame_id':0,'risk':'CLEAR','active':True})
            c.sample(packet(2,.2),None,{'frame_id':2,'risk':'UNKNOWN_SPACE','active':False})
            self.assertEqual(r['observed_samples'],0);self.assertEqual(r['sensor_coverage_percent'],0)
            self.assertEqual(r['risk_timeline'][0]['risk'],'UNKNOWN');self.assertEqual(r['safety_interventions'],0)

    def test_measured_braking_episodes_and_intervention_time_use_simulation_time(self):
        with tempfile.TemporaryDirectory() as d:
            c=JourneyComparison(d);r=c.begin('ROBOSPHERE',manifest())
            for i,(t,a,active) in enumerate([(0,-4,True),(.1,-4,True),(.3,0,False),(1.5,0,False),(1.6,-4,True)],1):
                c.sample(packet(i,t,accel=a,brake=.8),None,{'frame_id':i,'risk':'CLEAR','active':active})
            self.assertEqual(r['harsh_braking_events'],2);self.assertEqual(r['safety_interventions'],2)
            self.assertAlmostEqual(r['safety_intervention_s'],.3)
            self.assertEqual(r['acceleration_samples'],5)

    def test_restart_marks_unfinished_run_interrupted_and_storage_remains_readable(self):
        with tempfile.TemporaryDirectory() as d:
            c=JourneyComparison(d);c.begin('NORMAL',manifest())
            restored=JourneyComparison(d).snapshot()['runs']['NORMAL']
            self.assertEqual(restored['status'],'INTERRUPTED');self.assertFalse(restored['destination_reached'])

    def test_missing_acceleration_is_not_a_measured_zero(self):
        with tempfile.TemporaryDirectory() as d:
            c=JourneyComparison(d);r=c.begin('NORMAL',manifest());f=packet()
            c.sample(replace(f,vehicle=replace(f.vehicle,longitudinal_acceleration_mps2=None)),None,{})
            self.assertEqual(r['acceleration_samples'],0);self.assertEqual(r['intervention_samples'],0)
