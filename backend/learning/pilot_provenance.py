"""Bind native qualification to the actual control implementation."""
import hashlib
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
CONTROL_FILES=('backend/core/control_scene.py','backend/core/control_semantics.py','backend/core/ground_geometry.py',
               'backend/core/maneuver.py','backend/core/maneuver_candidates.py','backend/core/motion_geometry.py',
               'backend/core/path_conflicts.py','backend/core/prediction.py','backend/core/kinematic_prediction.py',
               'backend/core/ego_motion.py','backend/core/corridor_uncertainty.py','backend/core/reposition_lease.py',
               'backend/learning/rl/maneuver_runtime.py','backend/learning/rl/maneuver_observations.py',
               'backend/carla/pilot_world.py','backend/carla/sensors.py','backend/carla/provider.py',
               'backend/core/service.py','backend/server.py','backend/learning/rl/maneuver_reward.py',
               'backend/learning/rl/route_progress.py','config/core-repair-pilot.json')


def control_hashes():return {name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in CONTROL_FILES}


def qualified_physical_report(report):
    qualification=report.get('qualification',{})
    return (report.get('ordinary_gate') is True and report.get('historical_ledgers_unchanged') is True and
            qualification.get('implementation_unchanged') is True and
            qualification.get('implementation_sha256')==control_hashes() and
            qualification.get('freshness_measurement')=='AT_ACTION_REQUEST_FROM_ORIGINAL_SENSOR_RECEIPT' and
            qualification.get('fresh_scene_fraction',0)>=.99)


def qualified_motion_viability(report):
    """Controlled ordinary TRAIN pilot only; never a deployment admission gate."""
    qualification=report.get('qualification',{})
    episodes=report.get('episodes',[])
    return (bool(episodes) and report.get('historical_ledgers_unchanged') is True and
        qualification.get('implementation_unchanged') is True and qualification.get('implementation_sha256')==control_hashes() and
        qualification.get('freshness_measurement')=='AT_ACTION_REQUEST_FROM_ORIGINAL_SENSOR_RECEIPT' and
        # The experimental shield rejects every stale action independently.
        # 99% remains a full behavioral admission gate; this research-only
        # readiness check permits a bounded diagnostic fraction of outages.
        qualification.get('fresh_scene_fraction',0)>=.95 and all(e.get('outcome')=='SUCCESS' and
            e.get('scenario_validity',{}).get('valid') and e.get('metrics',{}).get('collisions')==0 and
            e['metrics'].get('native_distance_m',0)>=(1. if e.get('mode')=='MANUAL_PROTECTION' else 5.) and
            e['metrics'].get('maximum_clear_path_stop_s',float('inf'))<=3.
            for e in episodes))
