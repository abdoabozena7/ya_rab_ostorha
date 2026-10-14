"""Experimental v2 policies. MODEL never calls the historical RULE supervisor."""
from dataclasses import replace
import time
import numpy as np
from .active_safety import ActiveSafetySupervisor, assess_forward_space
from .contracts import CommandSource, SensorKind, to_dict
from .prediction import PredictionEngine, ego_paths, assess_conflicts, geometric_modes, intended_conflict
from ..learned.features import features
from ..learning.supervised.motion import PredictiveModel


def pedals(base, speed, target, braking):
    error = target-speed
    brake = max(base.brake, braking, min(1., max(0., -error*.35)))
    throttle = 0. if brake > .01 else min(base.throttle, max(0., .18+error*.28))
    return replace(base, source=CommandSource.SAFETY, throttle=throttle, brake=brake)


class PredictiveSafetySupervisor(ActiveSafetySupervisor):
    def __init__(self, side, session_id, *, model=None, cap_mps=20/3.6, ablate=False):
        if side not in ('RULE', 'MODEL'): raise ValueError('Invalid predictive side')
        self.controller = side; self.session_id = session_id; self.cap_mps = cap_mps
        self.ablate = ablate; self.model = (model or PredictiveModel()) if side == 'MODEL' else None
        self.source_counts = {}; self.learned_config = {'version': 'PREDICTIVE_V2', 'experimental': True}
        super().__init__()
        self.classifier = None; self.classifier_error = None; self.last_classification = -float('inf')
        try:
            from ..learning.async_worker import AsyncPredictionWorker
            self.classifier = AsyncPredictionWorker('classification')
        except OSError as error: self.classifier_error = str(error)

    def reset(self):
        super().reset()
        self.engine = PredictionEngine(self.session_id); self.clear_readings = 0
        self.weak_readings = 0; self.last_weak_distance = None
        if self.model: self.model.reset()
        self.last_command = None

    def close(self):
        if self.classifier: self.classifier.close()

    def snapshot(self):
        return {**super().snapshot(), 'controller': self.controller, 'experimental': True,
            'available_controllers': ['RULE'], 'model_health': 'READY' if self.model else 'NOT_USED',
            'model_weights_sha256': self.model.metadata['weights_sha256'] if self.model else None,
            'model_identity': 'PREDICTIVE_V2', 'prediction': self.engine.latest,
            'actual_generator': self.status.get('decision_source', self.controller)}

    def evaluate(self, observation, base, asset_reader, *, as_of_timestamp_s):
        began = time.perf_counter(); now = observation.timestamp_s
        if not 0 <= as_of_timestamp_s-now <= self.config.teacher.maximum_observation_age_s:
            raise ValueError('Safety sensor simulation freshness limit exceeded')
        if self.previous_s is not None and now <= self.previous_s: raise ValueError('Observation did not advance')
        # None is the shared command contract's "retain current gear", used
        # by navigation's final full-brake command. It is not neutral/reverse.
        gear = observation.ego.gear if base.gear is None else base.gear
        if base.reverse or gear != 1 or base.handbrake: raise ValueError('Predictive v2 requires forward drive')
        if base.frame_id != observation.frame_id or abs(base.timestamp_s-now) > 1e-6:
            raise ValueError('Misaligned predictive command')
        if any(c.frame_id != observation.frame_id or abs(c.sensor_timestamp_s-now) > 1e-6 for c in observation.channels):
            raise ValueError('Predictive sensors unsynchronized')
        scene = assess_forward_space(observation, asset_reader, self.config, steering=base.steering)
        prediction = self.engine.evaluate(scene['lidar_surfaces'], observation, base)
        prediction['quality_metrics']['classification_error'] = self.classifier_error
        if self.classifier:
            classified = self.classifier.current(self.session_id, now)
            if classified:
                for key, point in classified['request'].get('projected_tracks', {}).items():
                    choices=[d for d in classified['detections'] if d['confidence']>=.5 and
                        d['xyxy'][0]<=point[0]<=d['xyxy'][2] and d['xyxy'][1]<=point[1]<=d['xyxy'][3]]
                    if choices and int(key) in self.engine.tracker.tracks:
                        self.engine.tracker.tracks[int(key)]['class']=max(choices,key=lambda d:d['confidence'])['class']
                for tr in prediction['tracks']:
                    tr['class']=self.engine.tracker.tracks[int(tr['id'])]['class']
            wall=time.monotonic()
            if wall-self.last_classification>=.2:
                import base64
                from .camera_geometry import project
                rgb=next(c for c in observation.channels if c.kind==SensorKind.RGB)
                projected={}
                for tr in prediction['tracks']:
                    point=project(tr['position_m'],rgb.calibration)
                    if point: projected[tr['id']]=point
                self.classifier.submit(dict(session_id=self.session_id,frame_id=observation.frame_id,
                    timestamp_s=now,image=base64.b64encode(asset_reader(rgb.asset)).decode(),projected_tracks=projected))
                self.last_classification=wall
            prediction['quality_metrics']['classification_error']=self.classifier.error
        paths = ego_paths(observation.ego.speed_mps, base.steering, base.throttle)
        if self.model:
            learned_tracks = sorted([t for t in prediction['tracks'] if t['class']!='UNKNOWN' and t['confirmed']],
                key=lambda t: np.linalg.norm(t['position_m']))[:16]
            try:
                modes = self.model.modes(learned_tracks, ablate=self.ablate)
            except Exception as error:
                raise ValueError('MODEL_FAILURE: motion prediction: '+str(error)) from error
            # Unclassified / insufficient histories always retain geometric motion.
            learned_ids = {m['track_id'] for m in modes}
            modes += [m for m in geometric_modes(prediction['tracks']) if m['track_id'] not in learned_ids]
            valid = []
            static = [tr for tr in prediction['tracks'] if tr['confirmed'] and np.linalg.norm(tr['velocity_mps']) < .15]
            rejected = []
            for mode in modes:
                xy = np.asarray(mode['points'])[:, 1:3]
                physical = np.max(np.linalg.norm(np.diff(xy, axis=0), axis=1)/.5) <= 22.
                blocked = any(tr['id'] != mode['track_id'] and np.any(np.all(np.abs(xy-np.asarray(tr['position_m'])) < np.asarray(tr['half_size_m']), axis=1)) for tr in static)
                if physical and not blocked: valid.append(mode)
                else: rejected.append(mode['track_id'])
            # Invalid learned paths do not make a measured object disappear.
            valid += [m for m in geometric_modes(prediction['tracks']) if m['track_id'] in rejected and not any(v['track_id']==m['track_id'] for v in valid)]
            prediction['trajectories'] = valid
            prediction['conflicts'] = assess_conflicts(prediction['tracks'], valid, paths)
            prediction['conflict_point'] = intended_conflict(prediction['conflicts'], observation.ego.speed_mps, base.throttle)
            prediction['quality_metrics']['rejected_learned_paths'] = len(rejected)
        conflict = prediction['conflict_point']; speed = observation.ego.speed_mps
        distance = scene['target_range_m']; cfg = self.config; teacher = cfg.teacher
        strong = scene['target_support_points'] >= 3
        if distance is not None and not strong and distance > 2.:
            self.weak_readings = self.weak_readings+1 if self.last_weak_distance is not None and abs(distance-self.last_weak_distance)<1.5 else 1
            self.last_weak_distance = distance
            if self.weak_readings < 3: distance = None
        else: self.weak_readings = 0; self.last_weak_distance = None
        emergency_distance = teacher.minimum_clearance_m+speed*.15+speed*speed/(2*teacher.assumed_deceleration_mps2)
        emergency = distance is not None and distance <= emergency_distance
        sufficient = scene['observed_road_range_m'] >= emergency_distance+2 or distance is not None
        unknown = not sufficient
        earliest = conflict['time_s'] if conflict else 3.
        closing = scene['closing_speed_mps']
        measured_ttc = distance/closing if distance is not None and closing is not None and closing > .2 else None
        cap = self.cap_mps
        if self.model:
            try:
                target = self.model.target_speed(features(observation, base,
                    [observation.ego.steering, observation.ego.throttle, observation.ego.brake]),
                    dict(speed=speed, distance=distance if distance is not None else 50.,
                         conflict_time=earliest, conflict=conflict is not None,
                         free_range=scene['observed_road_range_m'], cap=cap), ablate=self.ablate)
            except Exception as error: raise ValueError('MODEL_FAILURE: '+str(error)) from error
            if not np.isfinite(target): raise ValueError('MODEL_FAILURE: nonfinite target speed')
            requested = target < .15
            reason = 'Learned continuous target speed'
        else:
            # Physics planner: smoothly reduce target before a predicted conflict.
            target = cap
            if conflict: target = min(target, max(0., speed*(earliest-.8)/max(.1, earliest)))
            if distance is not None:
                target = min(target, np.sqrt(max(0., 2*3.*(distance-3.))))
            if measured_ttc is not None and measured_ttc < cfg.ttc_trigger_s:
                target = min(target, max(0., speed*(measured_ttc-.8)/max(.1, measured_ttc)))
            requested = emergency or unknown or conflict is not None and earliest <= .8 or measured_ttc is not None and measured_ttc <= .8
            reason = 'Predicted time-aligned occupancy conflict' if conflict else 'Measured obstacle' if distance is not None else 'Measured corridor clear'
        self.clear_readings = self.clear_readings+1 if not conflict and sufficient and not emergency else 0
        dt = .05 if self.previous_s is None else min(.15, now-self.previous_s)
        protection = emergency or unknown
        pre_protection = pedals(base, speed, float(target), 0.)
        if protection or requested:
            if self.brake <= 0: self.started_s = now
            braking = 1. if protection else .65
        elif self.brake > 0 and (self.clear_readings < 3 or now-self.started_s < cfg.minimum_brake_hold_s):
            braking = self.brake; reason = 'Holding for three clear readings and minimum hold'
        else: braking = max(0., self.brake-cfg.brake_release_rate_per_s*dt)
        if protection:
            target = 0.; reason = 'Measured hazard within emergency stopping distance' if emergency else 'Insufficient measured sensor coverage'
        command = pedals(base, speed, float(target), braking)
        self.last_command = command; self.previous_s = now; self.brake = braking
        was_active = self.active; self.active = command.brake > base.brake or command.throttle < base.throttle
        if self.active and not was_active: self.interventions += 1
        source = 'EMERGENCY_PROTECTION' if protection else self.controller
        prediction['decision_source'] = source
        prediction['quality_metrics']['controller_pipeline_ms'] = (time.perf_counter()-began)*1000
        self.status.update(type='PREDICTIVE_V2', status='STOPPING' if command.brake > .6 else 'DECELERATING' if self.active else 'MONITORING',
            active=self.active, risk='MEASURED_HAZARD' if emergency else 'INSUFFICIENT_COVERAGE' if unknown else 'PREDICTED_CONFLICT' if conflict else 'CLEAR',
            frame_id=observation.frame_id, timestamp_s=now, reason=reason, decision_source=source,
            measured_range_m=distance, target_source=scene['target_source'], observed_road_range_m=scene['observed_road_range_m'],
            measured_ttc_s=measured_ttc,
            raw_measured_range_m=scene['target_range_m'],target_support_points=scene['target_support_points'],weak_confirmation_readings=self.weak_readings,
            target_speed_mps=float(target), clear_readings=self.clear_readings,
            pre_protection_command=to_dict(pre_protection),
            applied_command=to_dict(command), emergency_active=protection,
            sensor_ages_s={c.sensor_id: as_of_timestamp_s-c.sensor_timestamp_s for c in observation.channels},
            base_driver_brake=base.brake, base_command_source=base.source.value,
            proposed_safety_brake=command.brake)
        return command
