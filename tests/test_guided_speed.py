"""The guided stress request must reach the native agent without changing research limits."""
from types import SimpleNamespace as NS
from unittest import TestCase
from unittest.mock import Mock
from backend.carla.provider import CarlaProvider
from backend.core.presentation import Presentation
from backend.core.service import SimulationService
from backend.core.control import ControlMode
from tests.core_packets import packet
from tests.test_normal_navigation import command


class GuidedSpeedTests(TestCase):
    def provider(self, *, guided, remaining=200):
        p=object.__new__(CarlaProvider)
        p.ego=NS(actor=NS(get_speed_limit=lambda:30.,get_location=lambda:None))
        p.dashboard_tools=NS(map=NS(get_waypoint=lambda _:None))
        p.hybrid_speed_policy=NS(limit=lambda *_:(30.,'NATIVE_LAST_SIGN'))
        p.presentation_mode=True;p.guided_presentation=guided
        p.navigation=NS(set_target_speed=Mock(),run_step=lambda:NS(
            throttle=.75,brake=0.,steer=0.,reverse=False,hand_brake=False))
        p.route_state=lambda:{'remaining_m':remaining}
        return p

    def test_guided_120_reaches_native_controller_and_retains_posted_limit_as_metadata(self):
        p=self.provider(guided=True)
        p.navigation_command(1,.05,120.)
        p.navigation.set_target_speed.assert_called_once_with(120.)
        self.assertEqual(p.navigation_posted_limit_kmh,30.)
        self.assertEqual(p.hybrid_speed_limit_source,'GUIDED_STRESS_TARGET')

    def test_legacy_presentation_still_respects_posted_speed(self):
        p=self.provider(guided=False)
        p.navigation_command(1,.05,50.)
        p.navigation.set_target_speed.assert_called_once_with(30.)

    def test_guided_goal_approach_still_slows_below_80(self):
        p=self.provider(guided=True,remaining=10.)
        p.navigation_command(1,.05,80.)
        self.assertAlmostEqual(p.navigation.set_target_speed.call_args.args[0],13.5)

    def test_80_is_rejected_by_legacy_presentation_before_touching_service(self):
        p=Presentation(NS())
        with self.assertRaisesRegex(ValueError,'5–50'):
            p.start(80.)

    def test_guided_arms_preserve_native_launch_and_signal_brake_proposals(self):
        for mode in ('NORMAL','ROBOSPHERE'):
            for proposal in (command(.75),command(0.,1.)):
                with self.subTest(mode=mode,proposal=proposal):
                    p=NS(name='test-fixture',sensor_suite=False,navigation_done=lambda:False,
                        route_state=lambda:{'arrived':False},navigation_command=Mock(return_value=proposal),
                        navigation_planner=None,navigation_recovery=None)
                    s=SimulationService(p);s._publish(packet(42,2.1,speed=0.))
                    s.arbiter.machine.mode=ControlMode.AUTOMATIC
                    s.journey.update(status='RUNNING',driving_mode=mode,speed_kmh=80.,presentation_id='guided')
                    s.presentation.data.update(guided=True)
                    s._navigation_connection_alive=lambda:True;s._route_bypass=lambda:None
                    s.comfort_controller=NS(apply=Mock(side_effect=AssertionError('Experimental integrator')))
                    s._navigation_step()
                    self.assertEqual(s.base_driver_command,proposal)
