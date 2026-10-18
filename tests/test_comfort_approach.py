from dataclasses import replace
from types import SimpleNamespace
import unittest
from backend.core.comfort_control import ComfortControl,measured_approach_target
from tests.test_normal_navigation import command


class ComfortApproachTests(unittest.TestCase):
    def setUp(self):
        self.command=command(.4)
        self.vehicle=SimpleNamespace(speed_mps=8.,throttle=.4,brake=0.,
            longitudinal_acceleration_mps2=0.)
        self.status={'enabled':True,'frame_id':41,'timestamp_s':2.05,
            'measured_range_m':20.,'observed_road_range_m':19.}

    def test_measured_approach_reduces_target_before_the_hard_envelope(self):
        target=measured_approach_target(self.command,self.vehicle,13.89,self.status)
        self.assertAlmostEqual(target,(4.*8.)**.5)
        self.assertLess(target,self.vehicle.speed_mps)
        self.assertGreater(self.status['measured_range_m'],3.+8.*.35+8.**2/10.)

    def test_missing_stale_future_or_invalid_measurement_never_invents_a_target(self):
        for change in ({'enabled':False},{'frame_id':43},{'frame_id':39},{'timestamp_s':1.8},
                {'timestamp_s':3.},{'measured_range_m':None},{'measured_range_m':float('nan')},
                {'observed_road_range_m':float('inf')},{'observed_road_range_m':-1.}):
            with self.subTest(change=change):
                self.assertEqual(measured_approach_target(self.command,self.vehicle,13.89,
                    {**self.status,**change}),13.89)

    def test_approach_can_only_reduce_the_existing_route_target(self):
        self.assertEqual(measured_approach_target(self.command,self.vehicle,2.,self.status),2.)
        stopped={**self.status,'measured_range_m':5.,'observed_road_range_m':5.}
        self.assertEqual(measured_approach_target(self.command,self.vehicle,13.89,stopped),0.)

    def test_explicit_hazard_reverse_and_signal_brakes_are_unchanged(self):
        controller=ComfortControl()
        for value in (replace(self.command,throttle=0.,brake=1.),replace(self.command,reverse=True,gear=-1)):
            self.assertIs(controller.apply(value,self.vehicle,13.89,hazard=True,
                forward_status=self.status),value)

    def test_normal_without_measurements_retains_the_existing_route_target(self):
        controller=ComfortControl();controller.apply(self.command,self.vehicle,13.89)
        self.assertEqual(controller.status['constraint'],'ROUTE_TARGET')
        self.assertEqual(controller.status['effective_target_mps'],13.89)

    def test_approach_does_not_change_steering_or_gear(self):
        controller=ComfortControl()
        actual=controller.apply(self.command,self.vehicle,13.89,forward_status=self.status)
        self.assertEqual(actual.steering,self.command.steering)
        self.assertEqual(actual.gear,self.command.gear)
        self.assertEqual(controller.status['constraint'],'MEASURED_APPROACH')
        self.assertEqual(controller.status['source_frame'],41)

    def test_previous_hold_brake_does_not_latch_after_route_requests_forward_motion(self):
        vehicle=SimpleNamespace(speed_mps=0.,throttle=0.,brake=.028,longitudinal_acceleration_mps2=0.)
        controller=ComfortControl()
        actual=controller.apply(self.command,vehicle,8.)
        self.assertEqual(actual.brake,0.)
        # Signal/explicit hazard stops retain precedence over integrator release.
        stop=replace(self.command,throttle=0.,brake=1.)
        self.assertIs(controller.apply(stop,vehicle,8.,hazard=True),stop)
