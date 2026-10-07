"""Real seven-sensor suite, controlled calibration and a replayable native recording."""
import io
import json
import math
import statistics
import subprocess
import time
from pathlib import Path
import numpy as np
from PIL import Image
from .vehicle_baseline import NativeHarness
from backend.core.contracts import DataOrigin, ExperimentMetadata, to_dict
from backend.core.recording import RunRecorder
from backend.core.replay import ReplayReader


def sensor(h, name):
    return next(s for s in h.service.observation.sensors if s.sensor_id == name)


def depth_array(h):
    return np.load(io.BytesIO(h.provider.get_sensor_asset(sensor(h, 'depth').asset)), allow_pickle=False)


def static_fixture(h, distance):
    """Native mesh on the camera centreline; bounding box only sets approximate range."""
    mount = h.provider.sensor_manager.actors['depth'].get_transform()
    forward = mount.get_forward_vector()
    rotation = h.provider.ego.actor.get_transform().rotation
    ground_z = h.provider.ego.actor.get_location().z
    point = mount.location+forward*(distance+1.)
    point.z = ground_z
    target = h.world.spawn_actor(h.world.get_blueprint_library().find('static.prop.container'), h.api.Transform(point, rotation))
    target.set_simulate_physics(False)
    # Container mesh pivot has a lateral offset. Align its native bounding-box centre.
    right = mount.get_right_vector()
    point -= right*target.bounding_box.location.y
    point += forward*(target.bounding_box.extent.x-1.)
    target.set_transform(h.api.Transform(point, rotation))
    return target


def main(check='all'):
    out = Path('output/native-validation'); out.mkdir(parents=True, exist_ok=True)
    metadata = ExperimentMetadata('gate3_'+str(int(time.time())), 'Real native sensor validation', 'carla',
        DataOrigin.REAL_SIMULATION, config={'fixed_delta_seconds': .05, 'simulation_hz': 20, 'spawn_index': 152,
            'blueprint': 'vehicle.lincoln.mkz_2020', 'camera': {'width': 640, 'height': 360, 'fov_deg': 90},
            'native_version': '0.9.16', 'purpose': 'Controlled sensor calibration and short native run; no traffic/AI'})
    recorder = RunRecorder('runs', metadata) if check == 'all' else None
    h = None; targets = []; result = {'status': 'FAIL', 'recording': str(recorder.root) if recorder else None, 'check':check}
    try:
        h = NativeHarness(sensors=True, recorder=recorder)
        h.settle(25)
        rgb = sensor(h, 'frontCamera')
        image_bytes = h.provider.get_sensor_asset(rgb.asset)
        image = Image.open(io.BytesIO(image_bytes)); assert image.size == (640, 360)
        assert np.array(image).std()>5
        (out/'native-front-camera.jpg').write_bytes(image_bytes)
        result['rgb'] = {'status': 'PASS', 'frame': rgb.frame_id, 'timestamp': rgb.timestamp_s,
                         'width': image.width, 'height': image.height, 'fov_deg': rgb.metadata['fov_deg'],
                         'world_transform': to_dict(rgb.transform), 'mount': to_dict(rgb.metadata['mount_transform'])}
        if check == 'rgb':
            result['status']='PASS'; return
        depth_results = []
        for distance in (5., 10., 20., 30.):
            target = static_fixture(h, distance); targets.append(target)
            h.settle(12)
            depth = depth_array(h); d = sensor(h, 'depth')
            # Sample just below the horizon, where the target has an opaque surface.
            # The bin's sloped/open lid does not cover the exact optical centre pixel.
            camera = h.provider.sensor_manager.actors['depth'].get_transform()
            ray = camera.get_forward_vector()-camera.get_up_vector()*(10.5/320.)
            ray /= ray.length()
            hits = h.world.cast_ray(camera.location, camera.location+ray*(distance+5))
            surface = [hit for hit in hits if abs((hit.location-camera.location).length()-distance)<2]
            assert surface, f'No native surface near depth target {distance} m'
            known = min((hit.location-camera.location).length() for hit in surface)
            patch = depth[190:192, 319:321]
            measured = float(np.median(patch)); error = measured-known
            row = {'approximate_target_m': distance, 'native_raycast_surface_distance_m': known,
                   'decoded_depth_m': measured, 'error_m': error, 'absolute_error_m': abs(error),
                   'frame_id': d.frame_id, 'timestamp_s': d.timestamp_s, 'target_actor_id': target.id}
            row['pixel_patch_xy'] = [[319,190],[320,191]]
            depth_results.append(row)
            assert abs(error)<.25, f'Depth error exceeds 0.25 m: {row}'
            if distance == 10:
                cloud = sensor(h, 'lidar'); points = np.frombuffer(h.provider.get_sensor_asset(cloud.asset), '<f4').reshape(-1, 4)
                ground_z = h.world.get_map().get_waypoint(h.provider.ego.actor.get_location()).transform.location.z
                selected = points[(points[:,0]>3)&(points[:,0]<15)&(np.abs(points[:,1])<1.)&(points[:,2]<-1.7)]
                ground_errors = selected[:,2]+cloud.transform.position_m[2]-ground_z
                assert len(selected)>5 and float(np.abs(ground_errors).max())<.05, 'LiDAR road-plane geometry inconsistent'
                native_mount = h.provider.sensor_manager.actors['lidar'].get_transform()
                mesh_errors=[]
                # Use the nearby planar building facade, avoiding vegetation/complex LOD surfaces.
                facade=points[(points[:,2]>1.)&(np.abs(points[:,1]+26.)<.1)]
                for point in facade[:12]:
                    end=native_mount.transform(h.api.Location(*[float(v)*1.1 for v in point[:3]]))
                    hits=h.world.cast_ray(native_mount.location,end)
                    ranges=[(hit.location-native_mount.location).length() for hit in hits]
                    if ranges:
                        mesh_errors.append(min(abs(r-float(np.linalg.norm(point[:3]))) for r in ranges))
                assert len(mesh_errors)>3 and statistics.median(mesh_errors)<.1, f'LiDAR facade raycast comparison failed: {mesh_errors}'
                result['lidar'] = {'status': 'PASS', 'frame_id': cloud.frame_id, 'points': len(points),
                    'road_plane_points': len(selected), 'road_plane_max_error_m':float(np.abs(ground_errors).max()),
                    'static_mesh_raycast_comparisons':len(mesh_errors),'static_mesh_median_error_m':statistics.median(mesh_errors),
                    'intensity_range': [float(points[:, 3].min()), float(points[:, 3].max())],
                    'columns': ['x', 'y', 'z', 'intensity'], 'coordinate_frame': 'sensor-local-x-forward-y-right-z-up'}
            target.destroy(); targets.remove(target); h.settle(4)
        result['depth'] = {'status': 'PASS', 'tolerance_m': .25, 'measurements': depth_results}
        if check in ('depth','lidar'):
            result['status']='PASS'; return
        radar_rows = []
        for name, velocity in (('stationary', 0.), ('approaching', -3.), ('receding', 3.)):
            h.settle(5)
            radar_actor = h.provider.sensor_manager.actors['radar']
            radar_transform = radar_actor.get_transform(); forward = radar_transform.get_forward_vector()
            pos = radar_transform.location+forward*15.; pos.z=h.provider.ego.actor.get_location().z+.6
            target = h.world.spawn_actor(h.world.get_blueprint_library().find('vehicle.audi.a2'),
                                         h.api.Transform(pos, h.provider.ego.actor.get_transform().rotation))
            targets.append(target)
            target.enable_constant_velocity(h.api.Vector3D(x=velocity))
            history = {}; detections = []; truth = []
            for _ in range(20):
                h.step(brake=1.)
                native = h.world.get_snapshot(); actor = native.find(target.id)
                history[native.frame] = (actor.get_transform(), actor.get_velocity())
                radar = sensor(h, 'radar')
                if radar.frame_id not in history: continue
                tf, vel = history[radar.frame_id]
                sensor_pos = h.api.Location(*radar.transform.position_m)
                expected_range = (tf.location-sensor_pos).length()-target.bounding_box.extent.x
                chosen = [to_dict(d) for d in radar.data['detections']
                          if abs(d['depth_m']-expected_range)<1.8 and abs(d['azimuth_rad'])<.10 and abs(d['altitude_rad'])<.08]
                detections += chosen
                truth.append(vel.x*forward.x+vel.y*forward.y+vel.z*forward.z)
            assert detections, f'Radar did not detect {name} target'
            measured = statistics.median(d['velocity_mps'] for d in detections)
            known_velocity = statistics.median(truth)
            assert abs(measured-known_velocity)<.5, f'Radar velocity inconsistent with actual native target: {name}: {measured}/{known_velocity}'
            radar_rows.append({'case': name, 'target_actor_id': target.id, 'native_target_radial_velocity_mps': known_velocity,
                'median_raw_radar_velocity_mps': measured, 'velocity_error_mps': measured-known_velocity,
                'detection_count': len(detections), 'range_m': [min(d['depth_m'] for d in detections), max(d['depth_m'] for d in detections)],
                'raw_detections': detections})
            target.disable_constant_velocity(); target.destroy(); targets.remove(target); h.settle(4)
        result['radar'] = {'status': 'PASS', 'measured_sign': 'negative approaching, positive receding', 'cases': radar_rows}
        if check == 'radar':
            result['status']='PASS'; return
        stationary = to_dict(sensor(h, 'imu').data)
        imu_phases = {'stationary': stationary}; rows=[]
        for name, throttle, brake, steer, ticks in (('acceleration', .7, 0., 0., 55), ('hard_braking', 0., 1., 0., 22),
                                                    ('left_turn', .55, 0., -.7, 35), ('right_turn', .55, 0., .7, 35)):
            samples=[]
            for _ in range(ticks):
                v=h.step(throttle=throttle, brake=brake, steer=steer); rows.append(v)
                samples.append(to_dict(sensor(h, 'imu').data))
            imu_phases[name] = {'accelerometer_x_range_mps2': [min(s['accelerometer_mps2'][0] for s in samples), max(s['accelerometer_mps2'][0] for s in samples)],
                'gyroscope_z_range_radps': [min(s['gyroscope_radps'][2] for s in samples), max(s['gyroscope_radps'][2] for s in samples)],
                'final_compass_rad': samples[-1]['compass_rad']}
        assert abs(stationary['accelerometer_mps2'][0])<.2
        assert imu_phases['acceleration']['accelerometer_x_range_mps2'][1]>1
        assert imu_phases['hard_braking']['accelerometer_x_range_mps2'][0]<-1
        assert imu_phases['left_turn']['gyroscope_z_range_radps'][0]<-.1
        assert imu_phases['right_turn']['gyroscope_z_range_radps'][1]>.1
        result['imu'] = {'status': 'PASS', 'phases': imu_phases,
                         'note': 'Stationary z accelerometer includes simulator gravity (~9.81 m/s^2); no gravity subtraction applied'}
        if check == 'imu':
            result['status']='PASS'; return
        gnss=sensor(h,'gnss'); native_geographic=h.world.get_map().transform_to_geolocation(h.api.Location(*gnss.transform.position_m))
        error=[gnss.data['latitude_deg']-native_geographic.latitude, gnss.data['longitude_deg']-native_geographic.longitude,
               gnss.data['altitude_m']-native_geographic.altitude]
        assert max(abs(e) for e in error)<1e-5
        result['gnss']={'status':'PASS','measurement':to_dict(gnss.data),'world_transform':to_dict(gnss.transform),
                        'map_georeference_error_lat_deg_lon_deg_alt_m': error}
        if check == 'gnss':
            result['status']='PASS'; return
        h.reset()
        for _ in range(45):
            v=h.step(throttle=.7)
            if v.speed_mps>2: break
        # Re-verify real collision with all seven sensor actors active.
        base=h.provider.ego.actor.get_transform(); forward=base.get_forward_vector()
        target=h.world.spawn_actor(h.world.get_blueprint_library().find('static.prop.container'),
                                  h.api.Transform(base.location+forward*6,base.rotation))
        targets.append(target);target.set_simulate_physics(False);count=len(h.events)
        for _ in range(60):
            h.step(throttle=.4)
            if len(h.events)>count:break
        h.settle(5);assert len(h.events)>count,'Collision did not fire with full sensor suite'
        result['collision']={'status':'PASS','events':[to_dict(e) for e in h.events[count:]]}
        target.destroy();targets.remove(target)
        result['sensor_registry']=h.provider.sensor_registry()
        result['sensor_rates_simulation_hz']=h.provider.get_sensor_rates()
        result['synchronization']=h.service.snapshot()['synchronization']
        assert not h.provider.sensor_errors() and h.provider.sensor_manager.queue_overflows==0
        # Measure stable full-suite frame production, native tick throughput and backend CPU.
        h.settle(10);wall=time.monotonic();cpu=time.process_time();frame_start=h.provider.last_world['frame'];sim_start=h.provider.last_world['timestamp']
        step_times=[]
        for _ in range(120):
            h.step(brake=1.);step_times.append(h.service.backend_step_ms)
        elapsed=time.monotonic()-wall;cpu_seconds=time.process_time()-cpu
        count=h.provider.last_world['frame']-frame_start
        gpu=subprocess.check_output(['nvidia-smi','--query-gpu=memory.total,memory.used,utilization.gpu','--format=csv,noheader,nounits'],text=True).strip()
        result['performance']={'native_world_frames_per_wall_second':count/elapsed,
             'simulation_rate_hz':count/(h.provider.last_world['timestamp']-sim_start),
             'fixed_delta_seconds':.05,'measurement_wall_seconds':elapsed,'frames':count,
             'backend_cpu_one_core_percent':cpu_seconds/elapsed*100,
             'backend_step_mean_ms':statistics.mean(step_times),'backend_step_max_ms':max(step_times),
             'gpu_total_mib_used_mib_util_percent':gpu, 'unreal_window_render_fps':None,
             'note':'World frame production measured directly; Unreal window render FPS has no instrumented counter'}
        result['sensors_verified']=['RGB','Depth','Radar','LiDAR','IMU','GNSS','Collision']
        result['destroyed_actor_ids']=h.close();h=None
        reader=ReplayReader(recorder.root);complete=[f for f in reader.frames() if f.complete and len(f.sensors)==6]
        assert len(complete)>100
        assert all(s.frame_id==f.frame_id and abs(s.timestamp_s-f.timestamp_s)<1e-6 for f in complete for s in f.sensors)
        result['recording_summary']={'frames':len(reader.index),'complete_six_sensor_frames':len(complete),
             'duration_simulation_s':reader.index[-1][0]-reader.index[0][0], 'first_frame':reader.index[0][2], 'last_frame':reader.index[-1][2],
             'bytes':sum(p.stat().st_size for p in recorder.root.rglob('*') if p.is_file())}
        result['status']='PASS'
    except Exception as error:
        result['error']=repr(error)
        raise
    finally:
        for target in targets:
            target.disable_constant_velocity() if target.type_id.startswith('vehicle.') else None
            target.destroy()
        if h:result['destroyed_actor_ids']=h.close()
        if recorder:recorder.close()
        (out/('gate3-sensors.json' if check=='all' else f'gate3-{check}.json')).write_text(json.dumps(result,indent=2))
        print(json.dumps({k:v for k,v in result.items() if k not in ('radar','collision')},indent=2))


if __name__=='__main__':main()
