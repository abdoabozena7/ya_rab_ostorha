"""Read-only, sensor-only inspection of the current native forward corridor."""
import json
import urllib.parse
import urllib.request

from backend.core.active_safety import RuntimeSafetyConfig, assess_forward_space
from backend.core.contracts import AssetReference, SensorKind
from backend.core.safety_policy import EgoMeasurements, PolicySensorChannel, SensorObservation


def fetch(path):
    with urllib.request.urlopen('http://127.0.0.1:8000' + path, timeout=5) as response:
        return response.read()


state = json.loads(fetch('/api/state'))
frame = state['vehicle']['frame']
stamp = state['vehicle']['timestamp']
assets = {}
channels = []
for name, kind in (('frontCamera', SensorKind.RGB), ('depth', SensorKind.DEPTH),
                   ('lidar', SensorKind.LIDAR), ('radar', SensorKind.RADAR), ('imu', SensorKind.IMU)):
    raw = state['sensors'][name]
    asset = None
    if raw.get('asset'):
        info = raw['asset']
        asset = AssetReference(info['path'], info['media_type'], info['byte_count'], info['sha256'])
        query = urllib.parse.urlencode({'name': name, 'frame_id': frame})
        assets[asset.path] = fetch('/api/simulation/sensor.bin?' + query)
    meta = raw['metadata']
    declared = ('mount_transform', 'width', 'height', 'fov_deg', 'encoding', 'dtype',
                'shape', 'columns', 'coordinate_frame', 'sensor_tick_s')
    calibration = {key: meta[key] for key in declared if key in meta}
    channels.append(PolicySensorChannel(name, kind, frame, stamp, stamp,
                                        raw.get('data') or {}, raw.get('units') or {},
                                        asset, calibration))
vehicle = state['vehicle']
ego = EgoMeasurements(vehicle['speedMps'], (0., 0., 0.), 'VEHICLE_LOCAL',
                      vehicle['throttle'], vehicle['brake'], vehicle['steeringInput'],
                      int(vehicle['gear']), bool(vehicle['reverse']), bool(vehicle['handbrake']))
observation = SensorObservation(frame, stamp, ego, tuple(channels), 'carla')
scene = assess_forward_space(observation, lambda asset: assets[asset.path], RuntimeSafetyConfig.load())
print(json.dumps({key: value for key, value in scene.items()
                  if key not in ('teacher_observation', 'lidar_surfaces')}, indent=2))
