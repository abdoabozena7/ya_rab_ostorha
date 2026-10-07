"""Repeatable real CARLA physics/collision characterization through the application core."""
import json
import math
import time
from pathlib import Path
from backend.carla.provider import CarlaProvider
from backend.core.service import SimulationService
from backend.core.contracts import ControlCommand, CommandSource, ExperimentMetadata, DataOrigin, to_dict
from backend.core.events import EventType
from backend.core.recording import RunRecorder


class NativeHarness:
    def __init__(self, *, sensors=False, recorder=None, spawn_index=152):
        self.provider = CarlaProvider(spawn_index=spawn_index, collision_sensor=True)
        self.provider.connect()
        self.service = SimulationService(self.provider, recorder)
        self.service.start(threaded=False)
        self.events = []
        self.service.events.subscribe(self.events.append, EventType.CollisionDetected)
        self.api = self.provider.connection.api
        self.world = self.provider.world.world
        self.last_step_at = time.monotonic()

    def step(self, throttle=0., brake=0., steer=0., reverse=False, handbrake=False):
        # Respect the existing wall-clock command rate limit; never weaken safety for tests.
        time.sleep(max(0., .05-(time.monotonic()-self.last_step_at)))
        self.last_step_at = time.monotonic()
        f = self.service.observation
        self.service.submit_control(ControlCommand(f.frame_id, f.timestamp_s, throttle, brake, steer,
                                                  reverse, handbrake, CommandSource.SYSTEM, -1 if reverse else 1))
        self.service.step_once()
        if self.service.error:
            raise RuntimeError(self.service.error)
        return self.service.observation.vehicle

    def settle(self, ticks=25):
        for _ in range(ticks):
            self.step(brake=1.)

    def reset(self):
        old = self.provider.ego.actor.id
        self.service.reset_vehicle()
        self.service.set_paused(False)
        self.step(brake=1.)
        self.settle()
        assert self.world.get_snapshot().find(old) is None
        return old, self.provider.ego.actor.id

    def close(self):
        owned = [self.provider.ego.actor.id]+[a.id for a in self.provider.sensor_manager.actors.values()]
        self.service.close()
        snapshot = self.world.wait_for_tick(5)
        assert not set(owned)&{a.id for a in self.world.get_actors()}
        assert all(snapshot.find(i) is None for i in owned)
        assert not self.provider.cleanup_errors and not self.service.error
        return owned


def path_length(rows):
    return sum(math.dist(a.transform.position_m, b.transform.position_m) for a, b in zip(rows, rows[1:]))


def main():
    output = Path('output/native-validation'); output.mkdir(parents=True, exist_ok=True)
    recorder = RunRecorder('runs', ExperimentMetadata('gate2_'+str(int(time.time())), 'Native vehicle baseline',
                           'carla', DataOrigin.REAL_SIMULATION, config={'fixed_delta_seconds': .05, 'spawn_index': 152}))
    h = None; fixtures = []; result = {'status': 'FAIL', 'recording': str(recorder.root)}
    try:
        h = NativeHarness(recorder=recorder)
        h.settle()
        result.update(map=h.world.get_map().name, blueprint=h.provider.ego.actor.type_id,
                      spawn_index=h.provider.ego.selected_spawn_index,
                      spawn_transform=str(h.provider.ego.spawn_transform))
        samples = []; measurements = []
        for target in (5., 10.):
            h.reset(); start = h.service.observation.vehicle
            acceleration = [start]
            for _ in range(160):
                v = h.step(throttle=.7); acceleration.append(v)
                if v.speed_mps >= target: break
            assert v.speed_mps >= target, 'Target speed was not reached'
            braking = [v]
            for _ in range(100):
                v = h.step(brake=1.); braking.append(v)
                if v.speed_mps < .1: break
            assert v.speed_mps < .1, 'Vehicle did not stop'
            elapsed = braking[-1].timestamp_s-braking[0].timestamp_s
            measurements.append({'target_speed_mps': target, 'initial_brake_speed_mps': braking[0].speed_mps,
                'acceleration_time_s': acceleration[-1].timestamp_s-start.timestamp_s,
                'acceleration_distance_m': path_length(acceleration), 'stopping_time_s': elapsed,
                'stopping_distance_m': path_length(braking),
                'mean_braking_deceleration_mps2': (braking[0].speed_mps-v.speed_mps)/elapsed,
                'peak_braking_deceleration_mps2': -min(x.longitudinal_acceleration_mps2 for x in braking)})
            samples += acceleration+braking
        result['acceleration_braking'] = measurements
        turning = []
        for steering in (-1., 1.):
            h.reset(); start = h.service.observation.vehicle
            wheel_before = h.provider.ego.actor.get_wheel_pitch_angle(h.api.VehicleWheelLocation.FL_Wheel)
            for _ in range(45):
                v = h.step(throttle=.55, steer=steering); samples.append(v)
            wheel_after = h.provider.ego.actor.get_wheel_pitch_angle(h.api.VehicleWheelLocation.FL_Wheel)
            wheel_steer = h.provider.ego.actor.get_wheel_steer_angle(h.api.VehicleWheelLocation.FL_Wheel)
            delta_yaw = math.degrees(v.transform.rotation_rad.yaw-start.transform.rotation_rad.yaw)
            delta_yaw = (delta_yaw+180)%360-180
            assert abs(delta_yaw)>3 and abs(v.steering-steering)<.01, f'Yaw={delta_yaw}, steer={v.steering}, speed={v.speed_mps}, gear={v.gear}'
            assert abs(wheel_after-wheel_before)>1, 'Native wheel animation did not rotate'
            turning.append({'input': steering, 'yaw_change_deg': delta_yaw, 'wheel_steer_deg': wheel_steer,
                'wheel_pitch_before_deg': wheel_before, 'wheel_pitch_after_deg': wheel_after,
                'roll_deg': math.degrees(v.transform.rotation_rad.roll),
                'pitch_deg': math.degrees(v.transform.rotation_rad.pitch), 'position': list(v.transform.position_m)})
        result['steering_turning_wheel_animation'] = turning
        h.reset()
        for _ in range(45): v = h.step(throttle=.6, reverse=True); samples.append(v)
        assert v.reverse and v.longitudinal_speed_mps < -.5
        result['reverse_speed_mps'] = v.longitudinal_speed_mps
        for _ in range(40): v = h.step(handbrake=True); samples.append(v)
        assert v.handbrake and v.speed_mps < .2
        result['handbrake_final_speed_mps'] = v.speed_mps
        h.reset(); settled = h.service.observation.vehicle
        result['road_contact'] = {'settled_z_m': settled.transform.position_m[2],
            'vertical_velocity_mps': settled.linear_velocity_mps[2],
            'waypoint_z_m': h.world.get_map().get_waypoint(h.provider.ego.actor.get_location()).transform.location.z}
        assert abs(settled.linear_velocity_mps[2])<.1
        collisions = []
        for name, target_bp, initial_speed in (('low_static', 'static.prop.container', 2.),
                                              ('higher_static', 'static.prop.container', 7.),
                                              ('vehicle_to_vehicle', 'vehicle.audi.a2', 3.)):
            h.reset(); actor = h.provider.ego.actor
            for _ in range(100):
                v = h.step(throttle=.7)
                if v.speed_mps >= initial_speed: break
            assert v.speed_mps >= initial_speed
            measured_initial_speed = v.speed_mps
            base = actor.get_transform(); forward = base.get_forward_vector()
            at = h.api.Transform(base.location+forward*25, base.rotation)
            target = h.world.try_spawn_actor(h.world.get_blueprint_library().find(target_bp), at)
            assert target is not None, 'Controlled target spawn failed'
            fixtures.append(target); target.set_simulate_physics(False)
            gap = 1.5
            at.location = base.location+forward*(actor.bounding_box.extent.x+target.bounding_box.extent.x+gap)
            target.set_transform(at)
            count = len(h.events)
            impact_rows = []
            for _ in range(45):
                v = h.step(throttle=.3); impact_rows.append(v); samples.append(v)
                if len(h.events)>count: break
            h.settle(8); time.sleep(.05); h.service._drain_collision_events()
            observed = [e for e in h.events[count:] if e.payload['collision']['other_actor_id']==target.id]
            assert observed, f'No actual collision with {name} target'
            collisions.append({'case': name, 'target_actor_id': target.id, 'target_type': target.type_id,
                'requested_initial_speed_mps': initial_speed,
                'measured_speed_before_target_mps': measured_initial_speed,
                'observed_initial_speed_mps': impact_rows[0].speed_mps,
                'collision_events': [to_dict(e) for e in observed],
                'final_speed_mps': h.service.observation.vehicle.speed_mps})
            target.destroy(); fixtures.remove(target)
        result['collisions'] = collisions
        # Low-speed lateral departure across this road's lane/curb, without custom geometry.
        h.reset(); start = h.service.observation.vehicle
        curb_rows = []
        for _ in range(90):
            v = h.step(throttle=.45, steer=1.); curb_rows.append(v); samples.append(v)
        result['curb_interaction'] = {'start': list(start.transform.position_m), 'end': list(v.transform.position_m),
            'z_range_m': [min(x.transform.position_m[2] for x in curb_rows), max(x.transform.position_m[2] for x in curb_rows)],
            'roll_range_deg': [math.degrees(min(x.transform.rotation_rad.roll for x in curb_rows)), math.degrees(max(x.transform.rotation_rad.roll for x in curb_rows))],
            'pitch_range_deg': [math.degrees(min(x.transform.rotation_rad.pitch for x in curb_rows)), math.degrees(max(x.transform.rotation_rad.pitch for x in curb_rows))],
            'description': 'Observed native road-edge/body response; no physics parameters changed'}
        result['reset_actor_ids'] = h.reset()
        result['destroyed_actor_ids'] = h.close(); h = None
        recorded = [json.loads(l) for l in (recorder.root/'events/events.jsonl').read_text().splitlines()]
        assert sum(e['event_type']=='CollisionDetected' for e in recorded)>=3
        result['recorded_collision_events'] = sum(e['event_type']=='CollisionDetected' for e in recorded)
        (output/'gate2-vehicle-samples.json').write_text(json.dumps([to_dict(v) for v in samples]))
        result['status'] = 'PASS'
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        for actor in fixtures: actor.destroy()
        if h: h.close()
        recorder.close()
        (output/'gate2.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
