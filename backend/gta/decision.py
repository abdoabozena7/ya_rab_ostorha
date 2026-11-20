"""Local Laya project experiment, with no actuator or coding-agent authority."""
import json
import time
import urllib.request

BASE = 'http://127.0.0.1:11434'
MODEL = 'laya:latest'
DIGEST = '1f196b378202837961e8856ceeb36af8b03c4b6158f6b02f15cc2b0a99b65e5a'
QUESTIONS = {'action': {'type': 'choice', 'instructions': 'Choose a cautious low-speed driving proposal from the measured state. Unknown or stale sensing requires STOP.',
    'criteria': {'STOP': 'Brake for stale or unknown sensors, a crossing person, or an unsafe front gap.',
                 'WAIT': 'Wait behind a stopped queue; do not pass without verified side and rear clearance.',
                 'CREEP': 'Proceed slowly only with fresh known sensing and a clear front gap.'}}}


def request(path, data=None, timeout=60):
    req = urllib.request.Request(BASE+path, data=json.dumps(data).encode() if data is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def identify():
    models = request('/api/tags')['models']
    model = next(x for x in models if x['name'] == MODEL)
    if model['digest'] != DIGEST or model.get('remote_host') or 'decision' not in model.get('capabilities', []):
        raise ValueError('Pinned installed local Laya decision model required; no fallback/pull/cloud')
    return model


def unload():
    receipt = request('/api/generate', {'model': MODEL, 'keep_alive': 0}, timeout=15)
    deadline = time.monotonic()+15
    while time.monotonic() < deadline:
        running = request('/api/ps', timeout=3)['models']
        if not any(m['name'] == MODEL for m in running):
            return {'unloaded': True, 'receipt': receipt}
        time.sleep(.1)
    raise RuntimeError('Laya did not unload; native GPU launch must wait')


def propose(measured):
    allowed = {'sensor_age_ms', 'sensing_known', 'front_gap_m', 'speed_mps', 'crossing_person', 'stopped_queue', 'side_rear_verified'}
    if set(measured) - allowed:
        raise ValueError('Only declared measured state may enter this decision experiment')
    started = time.perf_counter()
    response = request('/v1/systemone', {'model': MODEL, 'state': measured, 'questions': QUESTIONS, 'keep_alive': '20s'})
    answer = response['answers']['action']
    if answer.get('choice') not in QUESTIONS['action']['criteria']:
        raise ValueError('Unexpected decision option')
    return {'model': MODEL, 'digest': DIGEST, 'input': measured, 'response': response,
            'roundtrip_ms': (time.perf_counter()-started)*1000, 'driving_authority': False,
            'confidence_semantics': 'Concentration of probabilities; not probability of correct driving'}
