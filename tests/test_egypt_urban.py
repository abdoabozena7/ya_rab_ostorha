import ast
import copy
from contextlib import closing
from dataclasses import replace
import math
from pathlib import Path
import tempfile
import hashlib
import sqlite3
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch
import numpy as np

from backend.carla.egypt_urban import EgyptUrbanChaos, body_separation, validate_route
from backend.carla.routes import RouteService
from backend.core.contracts import freeze_json
from backend.core.driver_profiles import driver_profile
from backend.core.egypt_urban import (
    SCENARIO_ID, PROTOCOL, DRIVER_ID, EventLedger, acceptance_matrix,
    admission, configuration, deployment_status, evaluate_pair, event_realized,
)
from backend.core.journey_comparison import JourneyComparison
from backend.core.kinematic_prediction import kinematic_modes
from backend.core.urban_driver import UrbanManeuverDriver, urban_forecast
from tests import test_control_scene as measured_fixtures
from tests import test_guided_presentation as guided_fixtures


class Location:
    def __init__(self, x=0., y=0., z=0.):
        self.x, self.y, self.z = x, y, z

    def distance(self, other):
        return math.dist((self.x, self.y, self.z), (other.x, other.y, other.z))


def waypoint(x, y=0., *, junction=False, neighbour=True):
    other = NS(lane_type='Driving', is_junction=False, lane_width=3.5,
               transform=NS(get_forward_vector=lambda: NS(x=1., y=0.)))
    return NS(transform=NS(location=Location(x, y), get_forward_vector=lambda: NS(x=1., y=0.)),
              lane_type='Driving', is_junction=junction, lane_width=3.5, lane_change='Both',
              get_left_lane=lambda: other if neighbour else None, get_right_lane=lambda: None)


class OpenMeasuredSpace:
    """Ranking/dynamic fixtures only; unknown-space tests use the real map."""
    def __init__(self, visible=70.):
        self.visible = visible
        self.paths = []

    def ensure_scope(self, path):
        self.paths.append(np.asarray(path))

    def continuous_coverage(self, path):
        return self.visible

    def certificate(self, path):
        return {'verified': True, 'source': 'TEST_FIXTURE_MEASURED_SPACE', 'known_percent': 100.}


def track(identity, x, y, vx=0., vy=0., *, person=False):
    return {'id': identity, 'position_m': [x, y], 'half_size_m': [.3, .3] if person else [2., .9],
            'velocity_mps': [vx, vy], 'confirmed': True, 'class': 'person' if person else 'vehicle',
            'quality': 1., 'uncertainty_m': .1, 'occlusion_s': 0., 'motion_observations': 8}


class UrbanDriverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.measured, cls.base, _ = measured_fixtures.ControlSceneTests().measured()

    def scene(self, tracks=(), *, stamp=1., frame=20, speed=6., lateral=0., measured=False):
        source = self.measured
        prediction = {**dict(source.prediction), 'tracks': list(tracks), 'control_trajectories': kinematic_modes(tracks),
                      'motion_tracking_complete': True, 'odometry_origin_m': [0., lateral], 'horizon_s': 3.}
        scene = replace(source, observation=replace(source.observation, frame_id=frame, timestamp_s=stamp,
                         ego=replace(source.observation.ego, speed_mps=speed),
                         channels=tuple(replace(c, frame_id=frame, timestamp_s=stamp, sensor_timestamp_s=stamp)
                                        for c in source.observation.channels)),
                        prediction=freeze_json(prediction), received_wall_s=100.,
                        space=source.space if measured else OpenMeasuredSpace())
        base = replace(self.base, frame_id=frame, timestamp_s=stamp)
        road = {'session_id': 'test', 'centerline': [[0., -lateral], [120., -lateral]],
                'lane_width_m': 3.5, 'left_allowed': True, 'right_allowed': False, 'return_allowed': False,
                'left_clear_distance_m': 110., 'right_clear_distance_m': 110.,
                'junction_ahead': False, 'traffic_stop': None,
                'drivable_strips': [[-100., -lateral, 120., -lateral, 1.75, 1., 0.],
                                    [-100., -3.5-lateral, 120., -3.5-lateral, 1.75, 1., 0.]]}
        return scene, base, road

    def warm(self, driver, tracks):
        scene, base, road = self.scene(tracks)
        driver.evaluate(scene, base, road, 8., wall=100.)
        scene, base, road = self.scene(tracks, stamp=1.5, frame=30)
        return scene, base, road

    def test_moving_lead_can_start_a_complete_physically_checked_lane_change(self):
        driver = UrbanManeuverDriver(self.measured.geometry)
        scene, base, road = self.warm(driver, [track('lead', 35., 0., 3.)])
        command, result = driver.evaluate(scene, base, road, 8., wall=100.)
        self.assertEqual(result['action'], 'CHANGE_LEFT', result)
        self.assertEqual(driver.phase, 'CHANGE')
        self.assertLess(command.steering, 0.)
        self.assertTrue(result['maneuver_proof']['stopping_tail_included_in_intended_path'])
        self.assertGreater(max(p[-1, 0] for p in scene.space.paths), 3.)
        self.assertEqual(result['driver_id'], DRIVER_ID)

    def test_fast_rear_vehicle_and_occupied_side_lane_veto_the_entire_change(self):
        for hazard in (track('rear', -20., -3.5, 20.), track('accelerating_rear', -35., -3.5, 10.),
                       track('side', 15., -3.5)):
            with self.subTest(hazard=hazard['id']):
                driver = UrbanManeuverDriver(self.measured.geometry)
                scene, base, road = self.warm(driver, [track('lead', 35., 0., 3.), hazard])
                _, result = driver.evaluate(scene, base, road, 8., wall=100.)
                self.assertFalse(result['action'].startswith('CHANGE_'), result)
                self.assertTrue(any(r['reason'] == 'PREDICTED_INTERSECTION' for r in result['rejected']), result)
                self.assertIsNone(driver.selected_side)

    def test_cut_in_brakes_instead_of_using_a_crossing_gap(self):
        scene, base, road = self.scene([track('cut_in', 6.5, -2.8, 1., 2.)])
        command, result = UrbanManeuverDriver(scene.geometry).evaluate(scene, base, road, 8., wall=100.)
        self.assertEqual(command.throttle, 0., result)
        self.assertGreater(command.brake, 0.)
        self.assertEqual(result['action'], 'HOLD')

    def test_occluded_space_and_stale_or_missing_motion_data_never_admit_a_maneuver(self):
        scene, base, road = self.scene([track('person', 7., 2.5, person=True)])
        for stale in (replace(scene, received_wall_s=99.7),
                      replace(scene, prediction=freeze_json({**dict(scene.prediction), 'motion_tracking_complete': False}))):
            command, result = UrbanManeuverDriver(scene.geometry).evaluate(stale, base, road, 8., wall=100.)
            self.assertEqual(command.brake, 1., result)
            self.assertIsNone(result['selected_path'])
        scene, base, road = self.scene([track('lead', 12., 0.)], measured=True)
        driver = UrbanManeuverDriver(scene.geometry)
        driver.lead_id = 'lead'
        driver.lead_seen_since = 0.
        _, result = driver.evaluate(scene, base, road, 8., wall=100.)
        self.assertFalse(result['action'].startswith('CHANGE_'), result)
        self.assertTrue(any('SPACE' in r['reason'] or 'INTERSECTION' in r['reason'] for r in result['rejected']), result)

    def test_closed_road_safe_hold_is_not_completion_and_clear_road_resumes(self):
        scene, base, road = self.scene([track('wall', 4., 0.)], speed=0.)
        road['left_allowed'] = False
        driver = UrbanManeuverDriver(scene.geometry)
        command, result = driver.evaluate(scene, base, road, 8., wall=100.)
        self.assertEqual(command.brake, 1., result)
        self.assertEqual(driver.completed_maneuvers, [])
        self.assertIsNone(result['fallback_hold_safe_against_rear_impact'])
        cleared, base, road = self.scene([], stamp=1.5, frame=30, speed=0.)
        command, result = driver.evaluate(cleared, base, road, 8., wall=100.)
        self.assertGreater(command.throttle, 0., result)
        self.assertEqual(command.brake, 0.)

    def test_lost_moving_lead_and_elapsed_time_do_not_complete_an_overtake(self):
        scene, base, road = self.scene([], lateral=-3.5, stamp=20.)
        driver = UrbanManeuverDriver(scene.geometry)
        driver.phase, driver.offset, driver.blocker = 'PASS', -3.5, 'lost'
        driver.evaluate(scene, base, road, 8., wall=100.)
        self.assertEqual(driver.phase, 'PASS')
        self.assertIsNone(driver.clearance_proof)
        self.assertEqual(driver.completed_maneuvers, [])

    def test_overtake_counts_only_after_measured_body_clearance_and_safe_return(self):
        driver = UrbanManeuverDriver(self.measured.geometry)
        driver.phase, driver.offset, driver.blocker, driver.maneuver_id = 'PASS', -3.5, 'lead', 1
        scene, base, road = self.scene([track('lead', -15., 3.5, 3.)], lateral=-3.5)
        road['return_allowed'] = True
        _, result = driver.evaluate(scene, base, road, 8., wall=100.)
        self.assertEqual(driver.phase, 'PASS')
        self.assertEqual(driver.completed_maneuvers, [])
        self.assertEqual(result['wait_reason'], 'WAITING_FOR_VERIFIED_RETURN')
        scene, base, road = self.scene([track('lead', -45., 3.5, 3.)], lateral=-3.5, stamp=11., frame=220)
        scene = replace(scene, prediction=freeze_json({**dict(scene.prediction), 'odometry_origin_m': [60., -3.5]}))
        road['return_allowed'] = True
        _, result = driver.evaluate(scene, base, road, 8., wall=100.)
        self.assertEqual(result['action'], 'START_RETURN', result)
        self.assertEqual(driver.completed_maneuvers, [])
        returned, base, road = self.scene([track('lead', -63., 0., 3.)], stamp=17., frame=340)
        returned = replace(returned, prediction=freeze_json({**dict(returned.prediction), 'odometry_origin_m': [96., 0.]}))
        driver.evaluate(returned, base, road, 8., wall=100.)
        self.assertEqual(len(driver.completed_maneuvers), 1)
        self.assertTrue(driver.completed_maneuvers[0]['returned'])
        self.assertGreater(driver.completed_maneuvers[0]['clearance_proof']['rear_clearance_m'], 2.)

    def test_committed_curve_and_side_survive_a_veto_without_oscillation(self):
        driver = UrbanManeuverDriver(self.measured.geometry)
        scene, base, road = self.warm(driver, [track('lead', 35., 0., 3.)])
        driver.evaluate(scene, base, road, 8., wall=100.)
        curve = driver.maneuver_curve
        stale = replace(scene, received_wall_s=99.)
        command, _ = driver.evaluate(stale, base, road, 8., wall=100.)
        self.assertEqual(command.brake, 1.)
        self.assertIs(driver.maneuver_curve, curve)
        self.assertEqual(driver.selected_side, 'left')

    def test_hesitation_and_retreat_are_physical_alternatives_not_future_labels(self):
        scene, _, _ = self.scene([track('walker', 15., 3., 0., -1.5, person=True)])
        forecast = urban_forecast(scene, 8.)
        modes = forecast.prediction['control_trajectories']
        self.assertTrue(any(m['source'] == 'POSSIBLE_HESITATION_RETREAT' for m in modes))
        self.assertTrue(all(m['points'][-1][0] >= 8. for m in modes))
        self.assertEqual(forecast.received_wall_s, scene.received_wall_s)
        self.assertEqual(forecast.observation.frame_id, scene.observation.frame_id)
        self.assertNotIn('hypothesis_set_id', scene.prediction)

    def test_speed_ceiling_and_missing_legal_tail(self):
        scene, base, road = self.scene([], speed=60. / 3.6)
        command, result = UrbanManeuverDriver(scene.geometry).evaluate(scene, base, road, 100., wall=100.)
        self.assertEqual(command.throttle, 0., result)
        self.assertGreaterEqual(command.brake, .35)
        self.assertLessEqual(result.get('target_speed_kmh', 60.), 60.)
        driver = UrbanManeuverDriver(scene.geometry)
        scene, base, road = self.warm(driver, [track('lead', 35., 0., 3.)])
        road['left_clear_distance_m'] = 15.
        _, result = driver.evaluate(scene, base, road, 8., wall=100.)
        self.assertFalse(result['action'].startswith('CHANGE_'))
        self.assertEqual(result['rejected'][0]['reason'], 'COMPLETE_LEGAL_LANE_UNAVAILABLE')

    def test_driver_has_no_privileged_actor_or_scenario_schedule_access(self):
        from backend.core import urban_driver
        tree = ast.parse(Path(urban_driver.__file__).read_text())
        forbidden = {'provider', 'world', 'get_actors', 'get_actor', 'plans', 'seed', 'force_lane_change'}
        self.assertFalse({n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)} & forbidden)


class EgyptScenarioTests(unittest.TestCase):
    def test_request_and_controller_commands_cannot_certify_realization(self):
        ledger = EventLedger({'merge': {'kind': 'CUT_IN'}})
        ledger.transition('merge', 'REQUESTED', 1, .05)
        ledger.transition('merge', 'EXECUTING', 2, .1)
        with self.assertRaisesRegex(ValueError, 'Physical realization'):
            ledger.transition('merge', 'COMPLETED', 3, .15)
        m = {'signal_s': 1., 'lane_entry_complete': True, 'lateral_m': 3.5, 'forward_m': 8.}
        ledger.transition('merge', 'COMPLETED', 100, 5., measurements=m)
        self.assertTrue(ledger.events['merge']['realized'])
        self.assertEqual([t['phase'] for t in ledger.events['merge']['transitions']], ['REQUESTED', 'EXECUTING', 'COMPLETED'])

    def test_pedestrian_intent_occlusion_and_stop_resume_need_measurements(self):
        crossing = {'crossing_m': 8., 'road_observed': True, 'sidewalk_reached': True}
        for persona, measurement in (('OCCLUDED', {'occluded_observed': True}),
                                     ('HESITANT', {'hesitated_s': .8}), ('RETREATING', {'retreated_m': .8})):
            self.assertFalse(event_realized('PEDESTRIAN_CROSSING', crossing, persona))
            self.assertTrue(event_realized('PEDESTRIAN_CROSSING', {**crossing, **measurement}, persona))
        self.assertFalse(event_realized('STOP_GO', {'stopped_s': 10., 'approach_m': 3.}))
        self.assertTrue(event_realized('STOP_GO', {'stopped_s': 2., 'approach_m': 3., 'resumed_m': 2.}))
        self.assertFalse(event_realized('OVERLAP', {'both_realized': True, 'overlap_s': .1}))

    def native_fixture(self):
        native = [(waypoint(x), NS(name='LANEFOLLOW')) for x in range(0, 701, 5)]
        world = NS(get_actor=lambda _: NS(bounding_box=NS()))
        p = NS(dashboard_tools=NS(native_route=native, route={'points': [[x, 0., 0.] for x in range(0, 701, 5)]}),
               world=NS(world=world))
        rows = []
        for i, (x, y) in enumerate(((35, 0), (125, 0), (175, 3.5), (210, 3.5), (325, 0), (340, 3.5),
                                    (525, 0), (560, 0), (620, 0))):
            rows.append({'id': i+1, 'role': f'participant_{i}', 'blueprint': 'vehicle.test',
                         'pose': {'location': [x, y, 0.], 'rotation': [0., 0., 0.]}, 'profile': {'category': 'car'}})
        for i in range(4):
            rows.append({'id': 20+i, 'role': f'person_{i}', 'blueprint': 'walker.test',
                         'pose': {'location': [0., 5., 1.], 'rotation': [0., 0., 0.]}})
        validation = {'passed': True, 'gates': {}, 'passing_sections': [{'progress_m': x} for x in (100., 300., 500.)]}
        return p, rows, validation

    def compile_fixture(self, seed):
        p, rows, validation = self.native_fixture()
        scenario = EgyptUrbanChaos(p, seed, validation)
        scenario.crossing_pair = lambda progress, used: ([progress, 6., 1.], [progress, -6., 1.], round(progress / 5))
        scenario._stage_walker = Mock()
        scenario.compile(rows)
        return scenario, rows

    def test_seeded_plans_and_role_reconstruction_do_not_depend_on_native_ids(self):
        a, rows = self.compile_fixture(1703)
        b, _ = self.compile_fixture(1703)
        c, _ = self.compile_fixture(2707)
        self.assertEqual(a.descriptor(), b.descriptor())
        self.assertNotEqual(a.descriptor()['definition_sha256'], c.descriptor()['definition_sha256'])
        before = a.descriptor()
        for row in rows:
            row['id'] += 1000
        a.bind(rows)
        self.assertEqual(a.descriptor(), before)
        self.assertTrue(all(e['status'] == 'PENDING' for e in a.ledger.events.values()))
        self.assertTrue(all(identity >= 1000 for identity in a.bindings.values()))

    def test_native_route_requires_length_connectivity_and_three_usable_sections(self):
        route = [(waypoint(x), None) for x in range(0, 701, 5)]
        self.assertTrue(validate_route(route)['passed'])
        self.assertFalse(validate_route(route[:40])['passed'])
        blocked = [(waypoint(x, neighbour=False), None) for x in range(0, 701, 5)]
        self.assertFalse(validate_route(blocked)['gates']['three_separated_passing_sections'])
        disconnected = route[:30] + route[35:]
        self.assertFalse(validate_route(disconnected)['gates']['connected_driving_lanes'])

    def test_body_separation_is_edge_distance_not_actor_center_distance(self):
        a = [(-2., -1.), (2., -1.), (2., 1.), (-2., 1.)]
        self.assertAlmostEqual(body_separation(a, [(x+5., y) for x, y in a]), 1.)
        self.assertEqual(body_separation(a, [(x+3., y) for x, y in a]), 0.)
        self.assertEqual(body_separation(a, [(x+4., y) for x, y in a]), 0.)

    def physical(self, plan):
        p, _, validation = self.native_fixture()
        p.connection = NS(api=NS(VehicleControl=lambda **v: NS(**v), WalkerControl=lambda **v: NS(**v),
            Vector3D=lambda x=0., y=0., z=0.: NS(x=x, y=y, z=z), Location=Location, LaneType=NS(Driving='Driving'),
            VehicleLightState=NS(Brake=1, LeftBlinker=2, RightBlinker=4, NONE=0)))
        p.population = NS(traffic_manager=NS(port=8052))
        p.dashboard_tools.map = NS(get_waypoint=lambda location, **_: object() if abs(location.y) < 3.6 else None)
        scenario = EgyptUrbanChaos(p, 1703, validation)
        scenario.plans = {'participant': plan}
        scenario.ledger = EventLedger(scenario.plans)
        scenario.ledger.transition('participant', 'REQUESTED', 20, 1.)
        scenario.follow = Mock(return_value=False)
        return p, scenario, scenario.ledger.events['participant']

    def test_stop_go_requires_physical_approach_stop_and_resumption(self):
        plan = {'kind': 'STOP_GO', 'origin': [10., 0., 0.], 'points': [[10., 0., 0.], [50., 0., 0.]],
                'hold_s': 1.5, 'speed_mps': 4., 'index': 2}
        p, scenario, event = self.physical(plan)
        location, speed = Location(10.), [0.]
        actor = NS(get_location=lambda: location, get_velocity=lambda: NS(length=lambda: speed[0]),
                   apply_control=Mock(), set_light_state=Mock(), set_autopilot=Mock())
        def step(stamp):
            scenario._vehicle('participant', actor, plan, event, NS(frame=round(stamp*20), timestamp=NS(elapsed_seconds=stamp)))
        step(1.)
        self.assertFalse(event['realized'])
        location.x, speed[0] = 14., 1.
        step(2.)
        self.assertEqual(actor.apply_control.call_args.args[0].brake, 1.)
        speed[0] = 0.
        step(3.); step(4.); step(5.)
        self.assertFalse(event['realized'])
        location.x = 16.
        step(5.5)
        self.assertEqual(event['status'], 'COMPLETED')
        actor.set_autopilot.assert_called_once_with(True, 8052)

    def test_hesitation_and_retreat_use_measured_walker_motion_and_real_stops(self):
        for persona in ('HESITANT', 'RETREATING'):
            with self.subTest(persona=persona):
                plan = {'kind': 'PEDESTRIAN_CROSSING', 'persona': persona, 'origin': [10., 6., 1.],
                        'target': [10., -6., 1.], 'speed_mps': 1.5}
                _, scenario, event = self.physical(plan)
                location = Location(10., 6., 1.)
                actor = NS(get_location=lambda: location, apply_control=Mock())
                def step(stamp):
                    scenario._walker('participant', actor, plan, event, NS(frame=round(stamp*20), timestamp=NS(elapsed_seconds=stamp)))
                step(1.)
                location.y = 3.
                step(2.); step(2.5)
                self.assertEqual(actor.apply_control.call_args.args[0].speed, 0.)
                step(3.)
                direction = actor.apply_control.call_args.args[0].direction.y
                self.assertGreater(direction, 0.) if persona == 'RETREATING' else self.assertLess(direction, 0.)
                if persona == 'RETREATING':
                    location.y = 3.9
                    step(3.5)
                location.y = -6.
                step(8.)
                self.assertEqual(event['status'], 'COMPLETED')
                self.assertEqual(actor.apply_control.call_args.args[0].speed, 0.)

    def test_cut_in_waits_for_observed_signaling_and_actual_lane_entry(self):
        plan = {'kind': 'CUT_IN', 'origin': [10., 3.5, 0.], 'speed_mps': 4., 'index': 2,
                'progress_m': 10., 'lane_width_m': 3.5}
        _, scenario, event = self.physical(plan)
        location, lights = Location(10., 3.5), [0]
        actor = NS(id=1, get_location=lambda: location, get_velocity=lambda: NS(length=lambda: 0.),
                   get_transform=lambda: NS(get_right_vector=lambda: NS(x=0., y=1.)),
                   bounding_box=NS(extent=NS(y=.9)), apply_control=Mock(), set_light_state=Mock(),
                   get_light_state=lambda: lights[0], set_autopilot=Mock())
        scenario._gap = Mock(return_value=True)
        scenario._stream_gap = Mock(return_value=10.)
        def step(stamp):
            scenario._vehicle('participant', actor, plan, event, NS(frame=round(stamp*20), timestamp=NS(elapsed_seconds=stamp)))
        step(1.); step(1.5)
        self.assertEqual(event['status'], 'REQUESTED')
        scenario.follow.assert_not_called()
        lights[0] = 2
        step(2.); step(2.5)
        self.assertEqual(event['status'], 'EXECUTING')
        self.assertFalse(event['realized'])
        location.x, location.y = 30., 0.
        step(3.)
        self.assertEqual(event['status'], 'COMPLETED')
        self.assertGreaterEqual(event['measurements']['lateral_m'], 2.)
        self.assertEqual(event['signal_side'], 'left')

    def test_runtime_environment_control_never_teleports_or_forces_a_lane_change(self):
        from backend.carla import egypt_urban
        tree = ast.parse(Path(egypt_urban.__file__).read_text())
        methods = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)
                   and n.name in ('start', 'before_tick', '_vehicle', '_walker', 'after_tick')]
        forbidden = {'set_transform', 'set_location', 'set_target_velocity', 'set_simulate_physics',
                     'force_lane_change', 'driving_mode', 'driver_profile'}
        self.assertFalse({n.attr for method in methods for n in ast.walk(method) if isinstance(n, ast.Attribute)} & forbidden)

    def test_multileg_route_is_not_shortened_and_progress_cannot_skip_to_nearby_finish(self):
        option = NS(name='LANEFOLLOW')
        native_map = NS(name='Town10HD_Opt',
                        get_waypoint=lambda loc, **_: waypoint(loc.x, loc.y))
        service = RouteService(native_map, NS(Location=Location, LaneType=NS(Driving='Driving')))
        calls = []
        def trace(origin, target):
            calls.append((origin, target))
            count = max(1, round(origin.distance(target) / 5.))
            return [(waypoint(origin.x + (target.x-origin.x)*i/count,
                              origin.y + (target.y-origin.y)*i/count), option) for i in range(count+1)]
        service.planner = NS(trace_route=trace)
        target = {'map': 'Town10HD_Opt', 'location': [-100., 200., 0.],
                  'via': [[200., 0., 0.], [200., 200., 0.], [0., 200., 0.]]}
        route, _ = service.plan(Location(), target)
        self.assertAlmostEqual(route['length_m'], 700.)
        self.assertEqual(len(calls), 4)
        self.assertFalse(service.progress(route, target['location'])['arrived'])
        for position in route['points']:
            progress = service.progress(route, position)
        self.assertTrue(progress['arrived'])
        self.assertEqual(route['destination']['via'], target['via'])


def accepted_pair():
    scenario = {'protocol': PROTOCOL, 'id': SCENARIO_ID, 'version': 1, 'seed': 1703,
                'definition_sha256': 'definition', 'route_validation': {'passed': True}}
    setup = {'map': 'Town10HD_Opt', 'blueprint': 'vehicle.mercedes.coupe_2020',
             'destination': {'location': [700., 0., 0.]}, 'speed_kmh': 60., 'population': {'seed': 1703},
             'weather': {}, 'actual_population': {'vehicles': 60, 'pedestrians': 100},
             'protocol': PROTOCOL, 'origin': {'location': [0., 0., 0.], 'rotation': [0., 0., 0.]},
             'vehicle_geometry': {}, 'vehicle_physics': {},
             'sensor_configuration': {'collision': {'blueprint': 'sensor.other.collision'}},
             'collision_measurement_available': True,
             'perception_profile': {'id': 'fixture'}, 'comparison_scenario': scenario,
             'initial_condition_id': 'same-start', 'route_length_m': 700.}
    measurements = {
        'STOP_GO': {'approach_m': 3., 'stopped_s': 2., 'resumed_m': 3.},
        'DOUBLE_PARK': {'stopped_s': 5., 'resumed_m': 3.},
        'CUT_IN': {'signal_s': 1., 'lane_entry_complete': True, 'lateral_m': 3.5, 'forward_m': 8.},
        'CHANGING_GAPS': {'signal_s': 1., 'lane_entry_complete': True, 'lateral_m': 3.5, 'forward_m': 8., 'gap_change_m': 5.},
        'PEDESTRIAN_CROSSING': {'crossing_m': 8., 'road_observed': True, 'sidewalk_reached': True},
        'OVERLAP': {'both_realized': True, 'overlap_s': 2.}
    }
    events = {kind: {'kind': kind, 'realized': True, 'status': 'COMPLETED', 'measurements': value}
              for kind, value in measurements.items()}
    for persona in ('OCCLUDED', 'HESITANT', 'RETREATING'):
        events[persona] = {'kind': 'PEDESTRIAN_CROSSING', 'persona': persona, 'realized': True, 'status': 'COMPLETED',
                           'measurements': {**measurements['PEDESTRIAN_CROSSING'], 'occluded_observed': True,
                                            'hesitated_s': 1., 'retreated_m': 1.}}
    run = {'status': 'ARRIVED', 'destination_reached': True, 'collisions': 0, 'contact_callbacks': 0,
           'recording': 'test-fixture-not-native', 'setup': setup, 'initial_condition_audit': {'passed': True},
           'scenario_evidence': {'events': events, 'density_verified': True, 'motion_verified': True,
                                 'minimum_body_separation_m': .8, 'collision_measurement_healthy': True},
           'driver_id': DRIVER_ID, 'maximum_speed_kmh': 58., 'simulation_wall_ratio': .4, 'sensor_age_samples': 100,
           'completed_maneuvers': [{'id': i, 'kind': 'OVERTAKE', 'status': 'COMPLETED', 'measured_clearance': True,
                                   'clearance_proof': {'rear_clearance_m': 3., 'frame_id': i * 100 + 1},
                                   'return_required': True, 'returned': True, 'completion_frame': i * 100 + 50,
                                   'return_proof': {'body_inside_lane': True, 'frame_id': i * 100 + 50}} for i in range(3)]}
    return {'manifest': setup, 'runs': {'NORMAL': copy.deepcopy(run), 'ROBOSPHERE': copy.deepcopy(run)}}


class EgyptAcceptanceTests(unittest.TestCase):
    def test_normal_can_arrive_safely_and_no_contact_is_ever_waived(self):
        data = accepted_pair()
        self.assertTrue(evaluate_pair(data)['passed'])
        for field, value in (('contact_callbacks', 1), ('collisions', 1), ('status', 'TIMEOUT'),
                             ('completed_maneuvers', []), ('maximum_speed_kmh', 60.01)):
            broken = copy.deepcopy(data)
            broken['runs']['ROBOSPHERE'][field] = value
            self.assertFalse(evaluate_pair(broken)['passed'], field)

    def test_same_scenario_geometry_and_seed_are_required(self):
        data = accepted_pair()
        data['runs']['NORMAL']['setup']['comparison_scenario']['seed'] += 1
        self.assertFalse(evaluate_pair(data)['passed'])
        data = accepted_pair()
        data['runs']['ROBOSPHERE']['scenario_evidence']['events']['CUT_IN']['realized'] = False
        self.assertFalse(evaluate_pair(data)['gates']['actual_event_diversity'])

    def test_matrix_needs_three_reserved_seeds_both_orders_and_all_failures(self):
        pairs = []
        for seed in configuration()['holdout_seeds']:
            for first in ('NORMAL', 'ROBOSPHERE'):
                pair = accepted_pair()
                pair['order'] = [first, 'ROBOSPHERE' if first == 'NORMAL' else 'NORMAL']
                for setup in [pair['manifest'], *(r['setup'] for r in pair['runs'].values())]:
                    setup['comparison_scenario']['seed'] = seed
                    setup['seed_partition'] = 'HOLDOUT'
                pairs.append({'seed': seed, 'first_mode': first, 'source': 'LIVE_NATIVE_CARLA',
                              'source_sha256': 'frozen', 'source_unchanged': True,
                              'attempts_retained': True, 'native_acceptance': True, 'pair': pair,
                              'completed_without_shortening': True, 'finish_completed': True, 'exports_closed': True,
                              'cleanup_confirmed': True, 'simulator_exit_confirmed': True,
                              'independent_cleanup_probe': {'passed': True}, 'video_playback_after_exit': {'passed': True},
                              'render_profile': {'render_profile': 'LOW'}})
        self.assertTrue(acceptance_matrix(pairs, 'frozen')['accepted'])
        self.assertFalse(acceptance_matrix(pairs[:-1], 'frozen')['accepted'])
        pairs[0]['native_acceptance'] = False
        self.assertFalse(acceptance_matrix(pairs, 'frozen')['accepted'])
        self.assertFalse(acceptance_matrix(pairs, 'different-source')['accepted'])

    def test_flags_without_physical_measurements_or_return_proof_do_not_pass(self):
        data = accepted_pair()
        data['runs']['ROBOSPHERE']['scenario_evidence']['events']['CUT_IN']['measurements'] = {}
        self.assertFalse(evaluate_pair(data)['passed'])
        data = accepted_pair()
        data['runs']['ROBOSPHERE']['scenario_evidence']['collision_measurement_healthy'] = False
        self.assertFalse(evaluate_pair(data)['passed'])
        data = accepted_pair()
        data['runs']['ROBOSPHERE']['completed_maneuvers'][0].pop('clearance_proof')
        self.assertFalse(evaluate_pair(data)['passed'])

    def test_a_zero_impulse_callback_arriving_after_finish_invalidates_zero_contact(self):
        with tempfile.TemporaryDirectory() as directory:
            comparison = JourneyComparison(directory)
            setup = copy.deepcopy(accepted_pair()['manifest'])
            setup['driver_profile'] = driver_profile('ROBOSPHERE', SCENARIO_ID)
            run = comparison.begin('ROBOSPHERE', setup)
            run.update(first_timestamp_s=1., last_timestamp_s=10.)
            comparison.finish('destination_reached')
            collision = NS(other_actor_id=99, timestamp_s=10., frame_id=200, impulse_ns=(0., 0., 0.),
                           other_actor_type='vehicle.test')
            comparison.collision(collision)
            self.assertEqual(run['contact_callbacks'], 1)
            self.assertEqual(run['status'], 'COLLISION')
            self.assertEqual(run['maximum_impulse_ns'], 0.)
            self.assertFalse(comparison.snapshot()['scenario_validation']['passed'])

    def test_sensor_delay_metrics_retain_stale_frames_instead_of_reporting_only_fresh_zeros(self):
        from tests.core_packets import packet
        scene, _, _ = measured_fixtures.ControlSceneTests().measured()
        with tempfile.TemporaryDirectory() as directory:
            comparison = JourneyComparison(directory)
            setup = copy.deepcopy(accepted_pair()['manifest'])
            setup['driver_profile'] = driver_profile('ROBOSPHERE', SCENARIO_ID)
            run = comparison.begin('ROBOSPHERE', setup)
            comparison.sample_driver(packet(scene.observation.frame_id+1, scene.observation.timestamp_s+.2),
                                     {}, scene, wall_s=scene.received_wall_s+.4)
            self.assertAlmostEqual(run['maximum_sensor_sim_age_s'], .2)
            self.assertAlmostEqual(run['maximum_sensor_wall_age_s'], .4)
            self.assertEqual(run['missing_current_sensor_frames'], 1)

    def test_matrix_preflight_reads_existing_budget_without_reset_or_native_start(self):
        from scripts.native.validate_egypt_urban import existing_budget_status, matrix_plan, preflight
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'budget.sqlite'
            with closing(sqlite3.connect(path)) as db:
                db.execute('CREATE TABLE reservations (seconds REAL,finished INTEGER)')
                db.execute('CREATE TABLE sleep_adjustments (excluded_s REAL)')
                db.execute('INSERT INTO reservations VALUES (14261.8387,1)')
                db.commit()
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            status = existing_budget_status(directory=directory)
            result = preflight(matrix_plan(acceptance=True), 900., status)
            self.assertFalse(result['can_run'])
            self.assertFalse(result['engine_started'])
            self.assertEqual(result['planned_trips'], 12)
            self.assertEqual(result['required_reservation_s'], 7200.)
            self.assertAlmostEqual(status['remaining_s'], 138.1613)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
        with self.assertRaisesRegex(ValueError, 'non-holdout'):
            matrix_plan(development_seed=configuration()['holdout_seeds'][0])
        with self.assertRaisesRegex(ValueError, 'cannot be overridden'):
            matrix_plan(acceptance=True, development_seed=1703)

    def test_unaccepted_driver_requires_an_existing_live_reservation(self):
        with tempfile.TemporaryDirectory() as directory, patch('backend.core.egypt_urban.ACCEPTANCE', Path(directory)/'absent.json'):
            self.assertFalse(deployment_status()['accepted'])
            with patch('backend.learning.hybrid_budget.active_ticket', return_value=None), patch(
                    'backend.learning.native_validation_budget.active_rule_ticket', return_value=None):
                with self.assertRaisesRegex(ValueError, 'existing live bounded'):
                    admission('Town10HD_Opt', 60.)
        with self.assertRaises(ValueError):
            admission('Town10HD_Opt', 61.)
        with self.assertRaises(ValueError):
            admission('OtherTown', 60.)

    def test_new_driver_identity_does_not_relabel_historical_profiles(self):
        normal, protected = (driver_profile(mode, SCENARIO_ID) for mode in ('NORMAL', 'ROBOSPHERE'))
        self.assertFalse(normal['motion_prediction_used'])
        self.assertEqual(protected['id'], DRIVER_ID)
        self.assertFalse(protected['reinforcement_learning_used'])
        self.assertEqual(driver_profile('ROBOSPHERE')['id'], 'ROBOSPHERE_PREDICTIVE_RULE_V1')
        self.assertNotEqual(driver_profile('ROBOSPHERE')['protocol'], protected['protocol'])

    def test_timeout_and_stationary_survival_remain_incomplete(self):
        with tempfile.TemporaryDirectory() as directory:
            comparison = JourneyComparison(directory)
            setup = copy.deepcopy(accepted_pair()['manifest'])
            setup['driver_profile'] = driver_profile('ROBOSPHERE', SCENARIO_ID)
            run = comparison.begin('ROBOSPHERE', setup)
            comparison.finish('egypt_route_timeout')
            self.assertEqual(run['status'], 'TIMEOUT')
            self.assertFalse(run['destination_reached'])
            self.assertFalse(comparison.snapshot()['scenario_validation']['passed'])


class EgyptPresentationTests(unittest.TestCase):
    setUp = guided_fixtures.GuidedPresentationTests.setUp
    tick = guided_fixtures.GuidedPresentationTests.tick

    def admit(self):
        return patch('backend.core.egypt_urban.admission',
                     return_value={'accepted': False, 'deadline': 1000., 'reason': 'TEST_FIXTURE_WINDOW'})

    def test_identity_is_independent_from_guided_interface_and_speed_is_bounded(self):
        with self.admit():
            self.p.start(60., seed=1703, scenario_id=SCENARIO_ID, guided=False)
            self.tick(); self.tick(); self.tick()
            self.assertEqual(self.provider.prepare_presentation.call_args.kwargs['scenario_id'], SCENARIO_ID)
            self.assertFalse(self.p.data['guided'])
            self.assertEqual(self.p.data['speed_kmh'], 60.)
            self.assertEqual(self.p.data['validation_deadline'], 1000.)
            self.p.cancel('test')
            with self.assertRaisesRegex(ValueError, '60'):
                self.p.start(61., scenario_id=SCENARIO_ID, guided=True)

    def test_ordinary_ui_requests_cannot_consume_reserved_acceptance_seeds(self):
        with self.admit(), self.assertRaisesRegex(ValueError, 'reserved seeds'):
            self.p.start(60., seed=configuration()['holdout_seeds'][0], scenario_id=SCENARIO_ID, guided=True)
        self.assertEqual(self.p.data['status'], 'IDLE')
        self.provider.prepare_presentation.assert_not_called()

    def test_harness_admission_records_the_holdout_partition_without_changing_driver_inputs(self):
        with self.admit():
            self.p.start(60., seed=configuration()['holdout_seeds'][0], scenario_id=SCENARIO_ID,
                         guided=True, holdout_acceptance=True)
        self.assertEqual(self.p.data['seed_partition'], 'HOLDOUT')
        self.assertEqual(self.p.data['seed'], configuration()['holdout_seeds'][0])

    def test_primary_default_is_gated_and_legacy_still_explicitly_selectable(self):
        with patch('backend.core.egypt_urban.deployment_status', return_value={'accepted': False, 'reason': 'pending'}):
            self.p.preload('egypt-page')
            self.assertIsNone(self.p.data['scenario_id'])
        self.p.cancel('test')
        with patch('backend.core.egypt_urban.deployment_status', return_value={'accepted': True, 'reason': 'verified'}), self.admit():
            self.p.preload('egypt-page')
            self.assertEqual(self.p.data['scenario_id'], SCENARIO_ID)
            self.assertEqual(self.p.data['speed_kmh'], 60.)
            self.p.cancel('test')
            self.p.start(120., guided=True, scenario_id='SUDDEN_PEDESTRIAN_COMPARISON_V1')
            self.assertIsNone(self.p.data['scenario_id'])

    def test_expiry_stops_without_resetting_or_extending_the_ticket(self):
        with self.admit():
            self.p.start(60., scenario_id=SCENARIO_ID, seed=1703, guided=True)
        self.time = 1001.
        self.tick()
        self.assertEqual(self.p.data['status'], 'CANCELLED')
        self.assertEqual(self.p.data['reason'], 'egypt_validation_expired')
        self.s.start_journey.assert_not_called()

    def test_disabled_collision_measurement_is_refused_before_building_the_urban_rig(self):
        from backend.carla.provider import CarlaProvider
        with self.assertRaisesRegex(ValueError, 'enabled native collision sensor'):
            CarlaProvider.prepare_guided_vehicle(NS(sensor_suite=True, collision_sensor=False), urban=True)

    def test_new_driver_and_normal_share_native_routing_but_not_maneuver_owner(self):
        from backend.carla.provider import CarlaProvider
        from backend.core.motion_geometry import VehicleGeometry
        for mode in ('NORMAL', 'ROBOSPHERE'):
            with self.subTest(mode=mode), self.admit():
                native_map = NS(to_opendrive=lambda: '<OpenDRIVE/>')
                p = NS(_ensure_dashboard_tools=Mock(), presentation_scenario_id=SCENARIO_ID,
                    dashboard_tools=NS(route={'id': 'route'}, native_route=[(waypoint(x), None) for x in range(0,701,5)], map=native_map,
                        map_name='Town10HD_Opt', route_service=NS(planner=None), replan_route=Mock()),
                    ego=NS(actor=Mock()), benchmark_fixture=None, decision_delta=.05,
                    vehicle_geometry=VehicleGeometry(), route_state=lambda: {'id': 'route'})
                agent = Mock()
                with patch('backend.carla.route_agent.route_agent_class', return_value=Mock(return_value=agent)):
                    CarlaProvider.start_navigation(p, 60., driving_mode=mode, presentation=True)
                agent.ignore_vehicles.assert_called_with(True)
                agent.ignore_traffic_lights.assert_called_with(False)
                self.assertIsNone(p.navigation_bypass)
                if mode == 'NORMAL':
                    self.assertIsNone(p.urban_driver)
                else:
                    self.assertIsInstance(p.urban_driver, UrbanManeuverDriver)
                    self.assertIs(p.hybrid_driver, p.urban_driver)
                points = [[float(x), 0., 0.] for x in range(0,701,5)]
                p.dashboard_tools.route['points'] = copy.deepcopy(points)
                p.benchmark_fixture = NS(condition={'route': points})
                p.dashboard_tools.route['points'][-1][0] += 1.
                with self.assertRaisesRegex(ValueError, 'route changed'):
                    CarlaProvider.start_navigation(p, 60., driving_mode=mode, presentation=True)


if __name__ == '__main__':
    unittest.main()
