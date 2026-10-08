"""Policy tests only. LIVE acceptance is the separate native verifier."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from backend.core.service import SimulationService
from tests.core_packets import packet
from backend.core.control import CommandArbiter, ControlMode, ControlSafetyLayer, ControlStateMachine
from backend.core.contracts import CommandSource, ControlCommand
from backend.carla.dashboard_tools import NativeDashboardTools, validate_settings
from backend.carla.provider import CarlaProvider


class NavigationPolicyTests(unittest.TestCase):
    def setUp(self):
        self.time = 0.
        self.machine = ControlStateMachine(allow_navigation=True)
        self.machine.transition(ControlMode.MANUAL, connected=True)
        self.safety = ControlSafetyLayer(now=lambda:self.time)
        self.arbiter = CommandArbiter(self.safety,self.machine)

    def command(self, source=CommandSource.NAVIGATION, throttle=.4):
        return ControlCommand(10,.5,throttle,0.,.2,False,False,source,1)

    def automatic(self):
        self.machine.transition(ControlMode.AUTOMATIC,connected=True,explicit=True)

    def test_navigation_requires_explicit_opt_in_and_does_not_enable_ai(self):
        with self.assertRaises(ValueError):
            self.machine.transition(ControlMode.AUTOMATIC,connected=True)
        self.automatic()
        self.machine.transition(ControlMode.MANUAL,connected=True)
        with self.assertRaises(ValueError):
            self.machine.transition(ControlMode.ASSISTED,connected=True,explicit=True)

    def test_navigation_is_admitted_only_in_automatic_mode(self):
        with self.assertRaises(ValueError):
            self.arbiter.submit(self.command(),frame_id=10,timestamp_s=.5,connected=True)
        self.automatic()
        self.arbiter.submit(self.command(),frame_id=10,timestamp_s=.5,connected=True)
        self.assertEqual(self.arbiter.choose(frame_id=10,timestamp_s=.5,connected=True).source,CommandSource.NAVIGATION)

    def test_manual_intervention_cannot_leave_an_automated_command_to_resume(self):
        self.automatic()
        self.arbiter.submit(self.command(),frame_id=10,timestamp_s=.5,connected=True)
        self.arbiter.submit(self.command(CommandSource.MANUAL,.2),frame_id=10,timestamp_s=.5,connected=True)
        self.assertEqual(self.machine.mode,ControlMode.MANUAL)
        self.assertNotIn(CommandSource.NAVIGATION,self.safety.latest)
        self.time = .351
        self.assertEqual(self.arbiter.choose(frame_id=10,timestamp_s=.5,connected=True).brake,1)
        self.assertEqual(self.machine.mode,ControlMode.PAUSED)

    def test_camera_effect_values_are_validated_before_native_reconfiguration(self):
        for settings in ({'camera_postprocess':1},{'camera_motion_blur':float('nan')},{'camera_bloom':3}):
            with self.assertRaises(ValueError):
                validate_settings(settings)
        self.assertEqual(validate_settings({'camera_postprocess':False,'camera_motion_blur':0}),{
            'camera_postprocess':False,'camera_motion_blur':0})

    def test_rejected_destination_cannot_reuse_the_previous_navigation_plan(self):
        tools = NativeDashboardTools.__new__(NativeDashboardTools)
        tools.route = {'destination': {'name': 'previous destination'}}
        tools.native_route = ['previous native plan']
        with self.assertRaises(ValueError):
            tools.set_destination({'location': [float('nan'), 0, 0]})
        self.assertIsNone(tools.route)
        self.assertIsNone(tools.native_route)


class NavigationLeaseTests(unittest.TestCase):
    def setUp(self):
        self.time=0.
        self.provider=SimpleNamespace(name='test-fixture',stop_navigation=Mock(),
            navigation_command=Mock(),route_state=Mock(return_value={'arrived':False}),
            navigation_done=Mock(return_value=False))
        self.service=SimulationService(self.provider,now=lambda:self.time)
        self.service._publish(packet(speed=0))
        self.service.arbiter.machine.allow_navigation=True

    def test_previous_session_heartbeat_cannot_extend_a_current_lease(self):
        self.service.start_journey()
        self.time=.2
        with self.assertRaises(ValueError): self.service.journey_heartbeat('previous-session')
        self.assertEqual(self.service.navigation_heartbeat_at,0)

    def test_focus_release_cancels_a_queued_start_before_controller_creation(self):
        self.service.start_journey()
        self.service.release_controls()
        self.assertNotIn('start_journey',[kind for kind,_ in self.service.actions])
        self.assertEqual(self.service.journey['status'],'PAUSED')

    def test_navigation_controller_cannot_renew_its_own_browser_lease(self):
        self.service.arbiter.machine.transition(ControlMode.AUTOMATIC,connected=True,explicit=True)
        self.service.journey['status']='RUNNING'
        self.service.navigation_heartbeat_at=0
        self.time=.351
        self.service._navigation_step()
        self.assertEqual(self.service.arbiter.machine.mode,ControlMode.PAUSED)
        self.assertEqual(self.service.journey['reason'],'dashboard_heartbeat_timeout')
        self.provider.navigation_command.assert_not_called()

    def test_missing_route_does_not_release_existing_manual_control(self):
        self.provider.route_state.return_value = None
        mode = self.service.arbiter.machine.mode
        with self.assertRaises(ValueError): self.service.start_journey()
        self.assertEqual(self.service.arbiter.machine.mode, mode)
        self.assertFalse(self.service.actions)

    def test_pending_destination_cannot_start_the_previous_route(self):
        self.service.dashboard_result = {'action': 'destination', 'status': 'PENDING'}
        with self.assertRaises(ValueError): self.service.start_journey()
        self.assertFalse(self.service.actions)

    def test_live_speed_change_preserves_route_lease_and_mode(self):
        self.service.arbiter.machine.transition(ControlMode.AUTOMATIC,connected=True,explicit=True)
        self.service.navigation_heartbeat_at=.1
        self.service.journey.update(status='RUNNING',route_id='original')
        self.service.set_journey_speed(10)
        self.assertEqual(self.service.journey['speed_kmh'],10)
        self.assertEqual(self.service.journey['route_id'],'original')
        self.assertEqual(self.service.navigation_heartbeat_at,.1)
        self.assertEqual(self.service.arbiter.machine.mode,ControlMode.AUTOMATIC)
        for speed in (4,31,float('nan')):
            with self.assertRaises(ValueError):self.service.set_journey_speed(speed)

    def test_stop_keeps_destination_and_requires_explicit_restart(self):
        route={'arrived':False,'destination':{'name':'saved goal'}}
        self.provider.route_state.return_value=route
        self.service.arbiter.machine.transition(ControlMode.AUTOMATIC,connected=True,explicit=True)
        self.service.stop_driving()
        self.assertEqual(self.provider.route_state(),route)
        self.assertEqual(self.service.arbiter.machine.mode,ControlMode.PAUSED)
        self.service.journey_heartbeat(self.service.session_id)
        self.assertFalse(any(kind=='start_journey' for kind,_ in self.service.actions))

    def test_back_to_back_native_ticks_do_not_bypass_the_command_rate_guard(self):
        self.service.arbiter.machine.transition(ControlMode.AUTOMATIC,connected=True,explicit=True)
        self.service.navigation_heartbeat_at=0
        self.service.arbiter.safety.receipts[CommandSource.NAVIGATION]=0
        self.time=.001
        self.service._navigation_step()
        self.provider.navigation_command.assert_not_called()


class NativeNavigationAdapterTests(unittest.TestCase):
    def test_replanning_changes_origin_without_changing_goal_identity_or_coordinates(self):
        tools = NativeDashboardTools.__new__(NativeDashboardTools)
        target={'id':'saved-place','name':'same goal','map':'native-map','location':[1.,2.,3.]}
        tools.route={'destination':target};tools.map_name='native-map'
        actor=Mock();actor.get_location.return_value='live-new-origin'
        tools.provider=SimpleNamespace(ego=SimpleNamespace(actor=actor))
        tools.route_service=Mock()
        tools.route_service.plan.return_value=({'destination':target,'id':'new-route'},['new-waypoint'])
        result=tools.replan_route()
        tools.route_service.plan.assert_called_once_with('live-new-origin',target)
        self.assertEqual(result['destination'],target)
        self.assertEqual(result['id'],'new-route')

    def test_native_output_is_canonical_and_speed_capped_without_direct_application(self):
        provider = CarlaProvider()
        actor = Mock(); actor.get_speed_limit.return_value = 12.
        provider.ego = SimpleNamespace(actor=actor)
        provider.navigation = Mock()
        provider.navigation.run_step.return_value = SimpleNamespace(
            throttle=.4, brake=0., steer=.6, reverse=False, hand_brake=False)
        command = provider.navigation_command(10, .5, 20.)
        provider.navigation.set_target_speed.assert_called_once_with(12.)
        self.assertEqual(command.source, CommandSource.NAVIGATION)
        self.assertEqual(command.steering, .6)
        actor.apply_control.assert_not_called()
        provider.connection.api = SimpleNamespace(VehicleControl=lambda **values: SimpleNamespace(**values))
        provider.apply_control(command)
        native = actor.apply_control.call_args.args[0]
        self.assertAlmostEqual(native.steer, .6)
