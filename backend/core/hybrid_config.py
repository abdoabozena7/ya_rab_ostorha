"""Explicit capability admission; validation tickets cannot become deployment."""
import json
import time
import hashlib
from functools import lru_cache
from pathlib import Path
from ..learning.hybrid_budget import active_ticket

PATH = Path(__file__).resolve().parents[2] / 'config/hybrid-driving.json'
REPORT = PATH.parents[1] / 'docs/evidence/hybrid_driving/acceptance.json'


def source_fingerprint():
    root=PATH.parents[1]
    files=sorted([*root.glob('backend/core/*.py'),*root.glob('backend/carla/*.py'),root/'backend/learning/hybrid_budget.py'])
    hashes={str(p.relative_to(root)).replace('\\','/'):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    config=configuration()
    for name in ('enabled','native_accepted','accepted_speed_kmh','surround_rig_accepted','reason'):
        config.pop(name,None)
    hashes['config/hybrid-driving.json']=hashlib.sha256(json.dumps(config,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def accepted_report(config):
    try:
        report=json.loads(REPORT.read_text(encoding='utf8'))
        required={'ordinary','speed','recovery','all_maneuvers','hazards','surround','freshness','comfort','throughput','comparison','identity'}
        gates=report.get('gates') if isinstance(report,dict) else None
        return (isinstance(gates,dict) and set(gates)==required and all(v is True for v in gates.values())
                and report.get('accepted') is True and report.get('source_fingerprint')==source_fingerprint()
                and report.get('accepted_speed_kmh',0)>=config['accepted_speed_kmh'])
    except (OSError,ValueError):return False


def configuration():
    return json.loads(PATH.read_text(encoding='utf8'))


@lru_cache(maxsize=2)
def _status(second):
    config = configuration()
    ticket = active_ticket()
    accepted = bool(config['enabled'] and config['native_accepted'] and config['surround_rig_accepted'] and accepted_report(config))
    return {'driver_id':config['driver_id'], 'accepted':accepted, 'validation_active':ticket is not None,
            'available':accepted or ticket is not None, 'accepted_speed_kmh':config['accepted_speed_kmh'],
            'maximum_request_kmh':config['requested_maximum_kmh'], 'reason':config['reason']}


def status():
    return dict(_status(int(time.monotonic())))


def admission(map_name, speed_kmh):
    config = configuration()
    if map_name.rsplit('/', 1)[-1] != config['map']:
        raise ValueError('Hybrid driving requires the accepted Town10HD map')
    if not 5 <= speed_kmh <= config['requested_maximum_kmh']:
        raise ValueError('Hybrid requested speed must be 5–50 km/h')
    ticket = active_ticket()
    deployed = (config['enabled'] and config['native_accepted'] and config['surround_rig_accepted']
                and speed_kmh <= config['accepted_speed_kmh'] and accepted_report(config))
    if not deployed and ticket is None:
        raise ValueError('Hybrid native acceptance is unfinished; see verification results before enabling it')
    return config, None if deployed else ticket
