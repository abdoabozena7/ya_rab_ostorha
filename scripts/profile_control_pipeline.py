"""Offline control-pipeline profiler on recorded native sensor bytes.

Replays a retained recording through ControlSceneBuilder and the RULE
supervisor (no simulator, no commands applied). Reports per-stage wall time,
cProfile hotspots and a digest of every published track set and safety
decision, so an optimization can be shown to leave outputs unchanged.
"""
import argparse
import cProfile
import hashlib
import json
from pathlib import Path
import pstats
import sys
import time
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _override(name, path):
    """Before/after benchmarking: load an alternative module file before anything imports it."""
    import importlib.util
    import backend.core  # noqa: F401
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec);sys.modules[name] = module;spec.loader.exec_module(module)


if '--contracts-file' in sys.argv:
    _override('backend.core.contracts', sys.argv[sys.argv.index('--contracts-file')+1])
for _index, _arg in enumerate(sys.argv):
    if _arg == '--override':
        _name, _path = sys.argv[_index+1].split('=', 1);_override(_name, _path)
from backend.core.active_safety import ActiveSafetySupervisor  # noqa: E402
from backend.core.contracts import CommandSource, ControlCommand, to_dict  # noqa: E402
from backend.core.control_scene import ControlSceneBuilder  # noqa: E402
from backend.core.motion_geometry import VehicleGeometry  # noqa: E402
from backend.core.replay import ReplayReader  # noqa: E402
from backend.core.recording import read_asset  # noqa: E402
from backend.core.safety_policy import sensor_observation  # noqa: E402


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def run(root, frames, geometry):
    reader = ReplayReader(root);builder = ControlSceneBuilder('profile-session', geometry)
    from backend.core import active_safety
    config = active_safety.RuntimeSafetyConfig.load(ROOT/'config/ya_rab_ostorha_safety.json')
    supervisor = ActiveSafetySupervisor(config);supervisor.geometry = geometry
    timings = {'scene_build_ms': [], 'safety_ms': [], 'total_ms': []};outputs = hashlib.sha256();count = 0
    def read(asset):return read_asset(root, asset)
    for frame in reader.frames():
        if count >= frames:break
        try:observation = sensor_observation(frame)
        except ValueError:continue
        began = time.perf_counter()
        scene = builder.build(observation, read, received_wall_s=time.monotonic())
        built = time.perf_counter()
        v = frame.vehicle
        base = ControlCommand(frame.frame_id, frame.timestamp_s, v.throttle, v.brake, v.steering, False, False, CommandSource.NAVIGATION, 1)
        supervisor.measured_space = scene.space;supervisor.control_prediction = scene.prediction
        try:
            command = supervisor.evaluate(observation, base, read, as_of_timestamp_s=observation.timestamp_s)
            decision = {'brake': None if command is None else round(command.brake, 9), 'throttle': None if command is None else round(command.throttle, 9),
                        'status': supervisor.status.get('status'), 'reason': supervisor.status.get('reason')}
        except ValueError as error:
            decision = {'error': str(error)};supervisor.reset()
        done = time.perf_counter()
        tracks = [{k: to_dict(t.get(k)) for k in ('id', 'class', 'position_m', 'velocity_mps', 'confirmed')} for t in to_dict(scene.prediction)['tracks']]
        outputs.update(digest({'frame': frame.frame_id, 'tracks': tracks, 'decision': decision}).encode())
        timings['scene_build_ms'].append((built-began)*1000);timings['safety_ms'].append((done-built)*1000)
        timings['total_ms'].append((done-began)*1000);count += 1
    return timings, outputs.hexdigest(), count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', default=str(ROOT/'runs/normal_city/run_57c0aceb80604461a9608725b47c5683'))
    parser.add_argument('--frames', type=int, default=150);parser.add_argument('--out', required=True)
    parser.add_argument('--label', default='baseline');parser.add_argument('--profile', action='store_true')
    parser.add_argument('--contracts-file', default=None, help='Alternative backend/core/contracts.py for before/after runs')
    parser.add_argument('--override', action='append', default=[], help='module=path alternative module file (before/after runs)')
    args = parser.parse_args()
    metadata = json.loads((Path(args.run)/'metadata.json').read_text(encoding='utf8'))
    geometry_data = (metadata.get('config') or {}).get('vehicle_geometry') or metadata.get('vehicle_geometry')
    geometry = VehicleGeometry(**{k: v for k, v in geometry_data.items() if k in VehicleGeometry.__dataclass_fields__}) if geometry_data else VehicleGeometry()
    profiler = cProfile.Profile() if args.profile else None
    if profiler:profiler.enable()
    timings, output_digest, count = run(args.run, args.frames, geometry)
    if profiler:profiler.disable()
    result = {'label': args.label, 'run': args.run, 'frames': count, 'output_sha256': output_digest,
              'contracts_sha256': hashlib.sha256(Path(sys.modules['backend.core.contracts'].__file__).read_bytes()).hexdigest(),
              'stages': {k: {'median_ms': float(np.median(v)), 'p95_ms': float(np.percentile(v, 95)), 'mean_ms': float(np.mean(v))}
                         for k, v in timings.items() if v}}
    if profiler:
        stats = pstats.Stats(profiler);rows = []
        for (filename, line, name), (cc, nc, tt, ct, _) in stats.stats.items():
            rows.append({'function': f'{Path(filename).name}:{line}:{name}', 'calls': nc, 'self_s': tt, 'cumulative_s': ct})
        result['hotspots_self'] = sorted(rows, key=lambda r: -r['self_s'])[:25]
        result['hotspots_cumulative'] = sorted(rows, key=lambda r: -r['cumulative_s'])[:25]
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=1), encoding='utf8')
    print(json.dumps({k: result[k] for k in ('label', 'frames', 'output_sha256', 'stages')}, indent=1))
    return 0


if __name__ == '__main__':sys.exit(main())
