"""Bounded semantic proposals with no command, trajectory or execution authority."""
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
import hashlib
import json
import logging
import math
import threading

from .contracts import Contract, SensorKind, finite, freeze_json, from_dict, to_dict
from .logging import LogCategory, log


class BehaviorIntent(str, Enum):
    FOLLOW = 'FOLLOW'
    FOLLOW_QUEUE = 'FOLLOW_QUEUE'
    WAIT = 'WAIT'
    PREPARE_TO_PASS = 'PREPARE_TO_PASS'


class BehaviorReason(str, Enum):
    CLEAR_ROAD = 'CLEAR_ROAD'
    MOVING_QUEUE = 'MOVING_QUEUE'
    STOP_GO_QUEUE = 'STOP_GO_QUEUE'
    PERSISTENT_STATIONARY_BLOCKAGE = 'PERSISTENT_STATIONARY_BLOCKAGE'
    PASS_FORBIDDEN = 'PASS_FORBIDDEN'
    UNSAFE_GAP = 'UNSAFE_GAP'
    AMBIGUOUS = 'AMBIGUOUS'
    INSUFFICIENT_EVIDENCE = 'INSUFFICIENT_EVIDENCE'


@dataclass(frozen=True)
class BehaviorProposal(Contract):
    version: int
    request_id: str
    session_id: str
    source_frame: int
    source_timestamp_s: float
    expires_timestamp_s: float
    intent: BehaviorIntent
    blocker_track_id: str | None
    reason_code: BehaviorReason
    abstain: bool

    def validate(self):
        if (self.version != 1 or self.source_frame < 0 or self.source_timestamp_s < 0
                or not self.source_timestamp_s < self.expires_timestamp_s <= self.source_timestamp_s + 1.):
            raise ValueError('Invalid proposal version, frame or simulation lifetime')
        for value in (self.request_id, self.session_id):
            if not value or len(value) > 128:
                raise ValueError('Proposal references must be bounded, nonempty strings')
        if self.blocker_track_id is not None and (not self.blocker_track_id or len(self.blocker_track_id) > 128):
            raise ValueError('Invalid measured blocker reference')
        permitted = {
            BehaviorIntent.FOLLOW: {BehaviorReason.CLEAR_ROAD},
            BehaviorIntent.FOLLOW_QUEUE: {BehaviorReason.MOVING_QUEUE, BehaviorReason.STOP_GO_QUEUE},
            BehaviorIntent.WAIT: {BehaviorReason.PASS_FORBIDDEN, BehaviorReason.UNSAFE_GAP,
                                  BehaviorReason.AMBIGUOUS, BehaviorReason.INSUFFICIENT_EVIDENCE},
            BehaviorIntent.PREPARE_TO_PASS: {BehaviorReason.PERSISTENT_STATIONARY_BLOCKAGE},
        }
        if self.reason_code not in permitted[self.intent]:
            raise ValueError('Intent and reason code conflict')
        if self.intent in (BehaviorIntent.FOLLOW_QUEUE, BehaviorIntent.PREPARE_TO_PASS) and self.blocker_track_id is None:
            raise ValueError('This intent requires a measured blocker')
        if self.intent == BehaviorIntent.FOLLOW and self.blocker_track_id is not None:
            raise ValueError('Clear-road intent cannot name a blocker')
        if self.abstain and (self.intent != BehaviorIntent.WAIT or self.reason_code != BehaviorReason.INSUFFICIENT_EVIDENCE):
            raise ValueError('Abstention must explicitly wait for sufficient evidence')


def parse_proposal(payload):
    if isinstance(payload, str):
        if len(payload.encode('utf8')) > 8192:
            raise ValueError('Proposal JSON exceeds 8192 bytes')

        def unique_keys(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError('Duplicate proposal JSON key')
                result[key] = value
            return result

        payload = json.loads(payload, object_pairs_hook=unique_keys)
    if not isinstance(payload, Mapping) or set(payload) != set(BehaviorProposal.__dataclass_fields__):
        raise ValueError('Proposal must contain exactly the declared semantic fields')
    return from_dict(BehaviorProposal, dict(payload))


def _vector(value, name):
    if not isinstance(value, (tuple, list)) or len(value) != 2:
        raise ValueError(name + ' requires two measured coordinates')
    return tuple(finite(v, name) for v in value)


def measured_situation(scene, road, blocker_track_id):
    if scene is None or not scene.prediction.get('motion_tracking_complete'):
        raise ValueError('Current measured motion is unavailable')
    if not isinstance(road, Mapping) or road.get('session_id') != scene.session_id:
        raise ValueError('Road and measured scene belong to different sessions')
    tracks = []
    for track in scene.prediction['tracks']:
        if not track.get('confirmed') or finite(track.get('occlusion_s', 1.), 'occlusion_s') > .1:
            continue
        identity = track['id']
        if not isinstance(identity, str) or not identity or len(identity) > 128:
            raise ValueError('Measured track identity must be a bounded string')
        tracks.append({'id': identity, 'position_m': _vector(track['position_m'], 'position_m'),
                       'velocity_mps': _vector(track['velocity_mps'], 'velocity_mps'),
                       'half_size_m': _vector(track['half_size_m'], 'half_size_m'),
                       'class': str(track.get('class', 'UNKNOWN'))[:64]})
    if len({t['id'] for t in tracks}) != len(tracks):
        raise ValueError('Measured tracks have duplicate identities')
    if blocker_track_id is not None and not any(t['id'] == blocker_track_id for t in tracks):
        raise ValueError('Current blocker is not a confirmed, visible measured track')
    tracks.sort(key=lambda t: (t['id'] != blocker_track_id, math.hypot(*t['position_m']), t['id']))
    road_view = {key: to_dict(road.get(key)) for key in (
        'lane_width_m', 'left_allowed', 'right_allowed', 'return_allowed',
        'left_clear_distance_m', 'right_clear_distance_m', 'junction_ahead', 'traffic_stop')}
    centerline = road.get('centerline')
    if not isinstance(centerline, (list, tuple)) or len(centerline) < 2:
        raise ValueError('A measured road centerline is required')
    road_view['centerline'] = [_vector(p, 'centerline') for p in centerline[:24]]
    road_view['centerline_truncated'] = len(centerline) > 24
    road_view['drivable_coverage_available'] = 'drivable_strips' in road
    road_identity = {**road_view, 'drivable_strips': to_dict(road.get('drivable_strips')),
                     'complete_centerline': to_dict(centerline)}
    road_hash = hashlib.sha256(json.dumps(road_identity, sort_keys=True, allow_nan=False).encode()).hexdigest()
    images = [{'sensor_id': channel.sensor_id, 'frame_id': channel.frame_id,
               'asset': to_dict(channel.asset)} for channel in scene.observation.channels
              if channel.kind == SensorKind.RGB and channel.asset is not None][:2]
    return freeze_json({
        'version': 1, 'session_id': scene.session_id, 'source_frame': scene.observation.frame_id,
        'source_timestamp_s': scene.observation.timestamp_s,
        'coordinate_frame': 'EGO_AT_MEASUREMENT_X_FORWARD_Y_RIGHT',
        'ego_speed_mps': scene.observation.ego.speed_mps,
        'blocker_track_id': blocker_track_id, 'tracks': tracks[:32],
        'tracks_truncated': len(tracks) > 32, 'road': road_view,
        'road_context_sha256': road_hash, 'images': images,
    })


def _context_change(previous, current):
    if previous['session_id'] != current['session_id']:
        return 'SESSION_CHANGED'
    if (current['source_frame'] < previous['source_frame']
            or current['source_timestamp_s'] < previous['source_timestamp_s']):
        return 'OUT_OF_ORDER_SCENE'
    if previous['road_context_sha256'] != current['road_context_sha256']:
        return 'ROAD_CONTEXT_CHANGED'
    blocker = previous['blocker_track_id']
    if blocker != current['blocker_track_id']:
        return 'BLOCKER_CHANGED'
    if blocker is not None:
        old = next(t for t in previous['tracks'] if t['id'] == blocker)
        new = next((t for t in current['tracks'] if t['id'] == blocker), None)
        if new is None:
            return 'BLOCKER_NOT_MEASURED'
        if (math.dist(old['position_m'], new['position_m']) > 1.5
                or math.dist(old['velocity_mps'], new['velocity_mps']) > .5
                or old['class'] != new['class'] or math.dist(old['half_size_m'], new['half_size_m']) > .5):
            return 'BLOCKER_MEASUREMENT_CHANGED'
    return None


class BehaviorProposalShadow:
    """One nonblocking mailbox. Workers supply data; none run inside observe()."""
    def __init__(self):
        self.lock = threading.RLock()
        self.history = deque(maxlen=8)
        self.pending = None
        self.response = None
        self.failure = None
        self.claimed = False
        self.sequence = 0
        self.last_report = None
        self.last_wall_s = None

    def _report(self, status, *, situation=None, baseline=None, detail=None):
        result = {'mode': 'SHADOW_ONLY', 'status': status, 'control_authority': False,
                  'learned_control_used': False, 'fallback': 'UNCHANGED_BASE_DRIVER',
                  'request_id': self.pending['request_id'] if self.pending else None,
                  'baseline_action': (baseline or {}).get('action'),
                  'candidate_feasibility': 'NOT_EVALUATED_BY_PROPOSAL_INTERFACE'}
        if detail is not None:
            result['detail'] = detail
        identity = (status, result['request_id'], str(detail))
        if identity != self.last_report:
            log(LogCategory.AI, 'Behavior proposal shadow: ' + status,
                frame_id=situation['source_frame'] if situation else None,
                timestamp_s=situation['source_timestamp_s'] if situation else None,
                level=logging.INFO if status in ('REQUESTED', 'PENDING', 'RESPONSE_RECEIVED',
                                                 'VALID_SHADOW_PROPOSAL', 'ABSTAINED')
                    else logging.WARNING, **result)
            self.last_report = identity
        return result

    def take_request(self):
        with self.lock:
            if self.pending is None or self.claimed:
                return None
            self.claimed = True
            return to_dict(self.pending)

    def submit(self, request_id, payload):
        with self.lock:
            if self.pending is None or request_id != self.pending['request_id']:
                return self._report('UNKNOWN_REQUEST', detail='Late or cross-session response was not admitted')
            try:
                proposal = parse_proposal(payload)
            except (ValueError, TypeError, KeyError, OverflowError, RecursionError) as error:
                self.failure = ('INVALID_PROPOSAL', str(error)[:256])
                self.response = None
                return self._report(self.failure[0], detail=self.failure[1])
            if (proposal.request_id != request_id or proposal.session_id != self.pending['session_id']
                    or proposal.source_frame != self.pending['source_frame']
                    or proposal.source_timestamp_s != self.pending['source_timestamp_s']):
                self.failure = ('REFERENCE_MISMATCH', 'Proposal does not refer to its captured request')
                self.response = None
                return self._report(self.failure[0], detail=self.failure[1])
            if (self.response is not None and self.response != proposal) or self.failure is not None:
                self.failure = ('CONFLICTING_PROPOSALS', 'Conflicting replies invalidate the request')
                self.response = None
                return self._report(self.failure[0], detail=self.failure[1])
            self.response = proposal
            return self._report('RESPONSE_RECEIVED')

    def fail(self, request_id, code, message):
        with self.lock:
            if self.pending is None or request_id != self.pending['request_id']:
                return self._report('UNKNOWN_REQUEST', detail='Failure belongs to an inactive request')
            if code not in ('MODEL_UNAVAILABLE', 'MODEL_FAILED', 'MODEL_TIMEOUT') or not isinstance(message, str):
                raise ValueError('Model failures require an explicit supported code and message')
            self.failure = (code, message[:256])
            self.response = None
            return self._report(code, detail=message[:256])

    def _request(self, situation, wall_s):
        self.sequence += 1
        self.pending = freeze_json({
            'request_id': f'{situation["session_id"]}:{situation["source_frame"]}:{self.sequence}',
            'session_id': situation['session_id'], 'source_frame': situation['source_frame'],
            'source_timestamp_s': situation['source_timestamp_s'],
            'issued_wall_s': wall_s, 'expires_wall_s': wall_s + 1.,
            'expires_timestamp_s': situation['source_timestamp_s'] + 1.,
            'situation': situation, 'history': tuple(self.history),
        })
        self.response = self.failure = None
        self.claimed = False

    def observe(self, scene, road, baseline, *, wall_s):
        with self.lock:
            if not isinstance(baseline, Mapping):
                self.pending = self.response = self.failure = None
                return self._report('INVALID_MEASURED_CONTEXT', detail='Baseline diagnostics must be an object')
            try:
                wall_s = finite(wall_s, 'proposal observation wall time')
                situation = measured_situation(scene, road, (baseline.get('front_blocker') or {}).get('track_id'))
            except (ValueError, TypeError, KeyError, OverflowError) as error:
                self.pending = self.response = self.failure = None
                self.history.clear()
                return self._report('INVALID_MEASURED_CONTEXT', baseline=baseline, detail=str(error)[:256])
            if not scene.usable(scene.observation.timestamp_s, wall_s):
                self.pending = self.response = self.failure = None
                self.history.clear()
                return self._report('STALE_MEASUREMENTS', situation=situation, baseline=baseline)
            if self.history and self.history[-1]['session_id'] != situation['session_id']:
                self.history.clear()
                self.last_wall_s = None
            if self.history:
                previous = self.history[-1]
                if (situation['source_frame'] < previous['source_frame']
                        or situation['source_timestamp_s'] < previous['source_timestamp_s']
                        or situation['source_frame'] == previous['source_frame']
                        and situation['source_timestamp_s'] != previous['source_timestamp_s']):
                    self.pending = self.response = self.failure = None
                    return self._report('OUT_OF_ORDER_SCENE', situation=situation, baseline=baseline)
            if self.last_wall_s is not None and wall_s < self.last_wall_s:
                self.pending = self.response = self.failure = None
                return self._report('INVALID_HOST_CLOCK', situation=situation, baseline=baseline)
            self.last_wall_s = wall_s
            if not self.history or situation['source_frame'] > self.history[-1]['source_frame']:
                self.history.append(freeze_json({k: situation[k] for k in (
                    'session_id', 'source_frame', 'source_timestamp_s', 'ego_speed_mps', 'tracks')}))
            if self.pending is None:
                self._request(situation, wall_s)
                return self._report('REQUESTED', situation=situation, baseline=baseline)
            changed = _context_change(self.pending['situation'], situation)
            expired = (wall_s >= self.pending['expires_wall_s']
                       or situation['source_timestamp_s'] >= self.pending['expires_timestamp_s'])
            if changed or expired or wall_s < self.pending['issued_wall_s']:
                reason = changed or ('PROPOSAL_TIMEOUT' if expired else 'INVALID_HOST_CLOCK')
                result = self._report(reason, situation=situation, baseline=baseline)
                self._request(situation, wall_s)
                result['next_request_id'] = self.pending['request_id']
                return result
            if self.failure is not None:
                return self._report(self.failure[0], situation=situation, baseline=baseline, detail=self.failure[1])
            proposal = self.response
            if proposal is None:
                return self._report('PENDING', situation=situation, baseline=baseline)
            if situation['source_timestamp_s'] >= proposal.expires_timestamp_s:
                return self._report('PROPOSAL_EXPIRED', situation=situation, baseline=baseline)
            blocker = situation['blocker_track_id']
            if proposal.blocker_track_id != blocker and not (proposal.abstain and proposal.blocker_track_id is None):
                return self._report('BLOCKER_REFERENCE_MISMATCH', situation=situation, baseline=baseline)
            if proposal.intent == BehaviorIntent.PREPARE_TO_PASS:
                track = next(t for t in situation['tracks'] if t['id'] == blocker)
                if math.hypot(*track['velocity_mps']) > .3:
                    return self._report('BLOCKER_NOT_STATIONARY', situation=situation, baseline=baseline)
                context = situation['road']
                if (context['junction_ahead'] is not False or context['traffic_stop']
                        or not (context['left_allowed'] is True or context['right_allowed'] is True)):
                    return self._report('PASS_NOT_PERMITTED', situation=situation, baseline=baseline)
            result = self._report('ABSTAINED' if proposal.abstain else 'VALID_SHADOW_PROPOSAL',
                                  situation=situation, baseline=baseline)
            result['proposal'] = to_dict(proposal)
            return result
