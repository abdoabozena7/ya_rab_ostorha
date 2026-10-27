"""Track camera-classified people in current measured depth, apart from merged surfaces.

The detector supplies a recent RGB classification and measured depth seed. Every
published position then needs this frame's calibrated depth. No actor state or
fixture schedule enters this module; missing/occluded measurements are omitted.
"""
import math
import numpy as np
from numba import njit
from .camera_geometry import mount_rotation
from .prediction import rotation
from .contracts import freeze_float_rows, freeze_json


@njit(cache=True, nogil=True, fastmath=False)
def measured_body_core(image, left, right, top, bottom, axial_expected, focal, sensor_rotation, mount_position):
    values = np.empty((bottom-top)*(right-left), dtype=np.float32)
    xyz = np.empty((len(values), 3), dtype=np.float64)
    h, w = image.shape
    count = 0
    tolerance = max(.6, .04*axial_expected)
    for v in range(top, bottom):
        for u in range(left, right):
            value = image[v, u]
            if not np.isfinite(value) or value <= np.float32(.1) or abs(value-axial_expected) >= tolerance:
                continue
            values[count] = value
            rx = float(value)
            ry = (u-(w-1)/2)/focal * value
            rz = -(v-(h-1)/2)/focal * value
            for axis in range(3):
                xyz[count, axis] = (rx*sensor_rotation[axis, 0] + ry*sensor_rotation[axis, 1]
                                    + rz*sensor_rotation[axis, 2]) + mount_position[axis]
            count += 1
    if count < 4:
        return False, 0., 0., count, np.zeros(3)
    selected = values[:count]
    axial = float(np.float32(np.median(selected)))
    deviation = np.empty(count, dtype=np.float32)
    for i in range(count):
        deviation[i] = abs(selected[i]-np.float32(axial))
    mad = float(np.float32(np.median(deviation)))
    if mad > .25:
        return False, axial, mad, count, np.zeros(3)
    center = np.array([np.median(xyz[:count, i]) for i in range(3)])
    return True, axial, mad, count, center


def warm_depth_people():
    image = np.ones((4, 4), dtype=np.float32)
    image.flags.writeable = False
    measured_body_core(image, 0, 4, 0, 4, 1., 2., np.eye(3), np.zeros(3))


class DepthPeople:
    def __init__(self):self.tracks={};self.next_id=0;self.last_result=None

    def update(self,prediction,observation,poses,result,depth_images,*,geometry=None):
        now=observation.timestamp_s;session=prediction['session_id']
        rgb=next((c for c in observation.channels if c.sensor_id=='frontCamera'),None)
        depth=next((c for c in observation.channels if c.sensor_id=='depth'),None)
        if rgb is None or depth is None or depth.asset.path not in depth_images:return []
        calibration=depth.calibration
        keys=('fov_deg','mount_transform')
        if any(rgb.calibration.get(k)!=calibration.get(k) for k in keys):return []
        if abs(rgb.calibration['width']/rgb.calibration['height']-calibration['width']/calibration['height'])>1e-6:return []
        mount=calibration['mount_transform'];mount_position=np.array(mount['position_m'])
        sensor_rotation=mount_rotation(mount['rotation_deg'])
        focal=calibration['width']/(2*math.tan(math.radians(calibration['fov_deg'])/2))
        image=depth_images[depth.asset.path];h,w=image.shape
        if (w,h)!=(calibration['width'],calibration['height']):return []
        history=np.asarray(poses);origin=np.asarray(prediction['odometry_origin_m']);r=rotation(prediction['odometry_yaw_rad'])
        valid=(result and result.get('session_id')==session and result.get('status')=='RUNNING'
            and type(result.get('frame_id')) is int and result['frame_id']<=observation.frame_id
            and 0<=now-result.get('timestamp_s',-10)<=.75)
        identity=(result.get('frame_id'),result.get('timestamp_s')) if valid else None
        if valid and identity!=self.last_result and len(history):
            stamp=result['timestamp_s'];frame=result['frame_id']
            aligned=(history[0,0]<=stamp<=history[-1,0] and history[0,4]<=frame<=history[-1,4]
                and abs(np.interp(frame,history[:,4],history[:,0])-stamp)<1e-5)
            if aligned:
                prior_origin=np.array([np.interp(stamp,history[:,0],history[:,i]) for i in (1,2)])
                prior_yaw=np.interp(stamp,history[:,0],np.unwrap(history[:,3]));used=set()
                for detection in result.get('detections',[]):
                    proof=detection.get('depth_evidence') or {};box=detection.get('xyxy',[])
                    if (detection.get('class')!='person' or detection.get('confidence',0)<.25 or len(box)!=4
                        or proof.get('source_sensor')!='depth' or proof.get('frame_id')!=frame
                        or abs(proof.get('timestamp_s',-10)-stamp)>1e-6 or not .5<proof.get('axial_m',0)<90.):continue
                    u=((box[0]+box[2])/2+.5)*w/rgb.calibration['width']-.5
                    v=((box[1]+box[3])/2+.5)*h/rgb.calibration['height']-.5
                    if 'pixel_center_depth' in proof:
                        pixel=proof['pixel_center_depth']
                        if (tuple(proof.get('depth_resolution') or ())!=(w,h) or len(pixel)!=2 or not np.isfinite(pixel).all()
                                or not 0<=pixel[0]<w or not 0<=pixel[1]<h):continue
                        u,v=pixel
                    ray=np.array([1.,(u-(w-1)/2)/focal,-(v-(h-1)/2)/focal])
                    point=mount_position+sensor_rotation@(ray*proof['axial_m'])
                    world=prior_origin+rotation(prior_yaw)@point[:2]
                    candidates=[(np.linalg.norm(t['position']-world),key) for key,t in self.tracks.items()
                        if key not in used and now-t['last_seen']<=2.]
                    best=min(candidates,default=(float('inf'),None))
                    key=best[1] if best[0]<1.5 else None
                    if key is None:
                        key='depth-person-'+str(self.next_id);self.next_id+=1
                        self.tracks[key]={'position':world,'velocity':np.zeros(2),'last_seen':stamp,'hits':0,'history':[],
                            'initial_side':1 if point[1]>=0 else -1,'observed_inside':False,'crossing_cleared':False}
                    track=self.tracks[key];used.add(key)
                    track.update(seed_world=world,seed_height=point[2],seed_s=stamp)
                    # Uncertain RGB retains identity, never a person class or
                    # speculative intent. Current measured motion stays usable.
                    if detection['confidence']>=.65:
                        track['semantic']={'class':'person','confidence':detection['confidence'],'timestamp_s':stamp,
                            'source_frame':frame,'session_id':session,'source_sensor':'frontCamera','depth_evidence':proof}
            self.last_result=identity
        published=[]
        # Classification expires at .75 s. Current measured geometry remains an
        # unclassified surface; losing its name is not evidence it disappeared.
        self.tracks={key:t for key,t in self.tracks.items() if now-t.get('seed_s',-10)<=4. or 0<=now-t['last_seen']<=.15}
        for key,track in self.tracks.items():
            age=now-track['last_seen'];semantic_age=now-track.get('semantic',{}).get('timestamp_s',-10)
            if age<0 or semantic_age<0:continue
            expected=track['position']+track['velocity']*min(age,.15)
            if age>.15 and now-track['seed_s']<=.75:
                expected=track['seed_world']+track['velocity']*max(0.,now-track['seed_s'])
            local=r.T@(expected-origin)
            camera=sensor_rotation.T@(np.r_[local,track['seed_height']]-mount_position)
            if camera[0]<.5:continue
            u=(w-1)/2+focal*camera[1]/camera[0];v=(h-1)/2-focal*camera[2]/camera[0]
            # Bounded body core. Reject another depth layer rather than attach
            # a recent label to a wall, curb, or occluding vehicle.
            half=max(1.,focal*.18/camera[0]);vertical=max(2.,focal*.35/camera[0])
            cx,cy=round(u),round(v);rx,ry=math.ceil(half),math.ceil(vertical)
            left,right=max(0,cx-rx),min(w,cx+rx+1)
            top,bottom=max(0,cy-ry),min(h,cy+ry+1)
            if left>=right or top>=bottom:continue
            valid, axial, mad, support, center = measured_body_core(
                image, left, right, top, bottom, camera[0], focal, sensor_rotation, mount_position)
            if not valid:continue
            world=origin+r@center[:2]
            if np.linalg.norm(world-track['seed_world'])>1.5+(now-track['seed_s'])*5.:continue
            recent=[row for row in track['history'] if 0<now-row[0]<=.3]
            if recent and now-recent[0][0]>=.15:
                displacement=world-np.asarray(recent[0][1:3]);duration=now-recent[0][0]
                velocity=displacement/duration
                if np.linalg.norm(velocity)>5.:continue
                if np.linalg.norm(displacement)<max(.08,axial/focal*.5):velocity=np.zeros(2)
                track['velocity']=track['velocity']*.6+velocity*.4
            track['position']=world;track['last_seen']=now;track['hits']+=1
            if abs(center[1])<1.5:track['observed_inside']=True
            local_velocity=r.T@track['velocity']
            # Native release follows the audited car width, body half-width,
            # maximum current depth uncertainty and a 0.5 m extra clearance.
            # Retain the historical threshold when replay lacks geometry.
            cleared_distance=geometry.half_width_m+.35+.4+.5 if geometry is not None else 2.8
            if (track['observed_inside'] and center[1]*track['initial_side']<-cleared_distance
                and center[1]*local_velocity[1]>=-.2):track['crossing_cleared']=True
            if center[1]*local_velocity[1]<-.5:track['crossing_cleared']=False
            row = freeze_float_rows(np.array([[now, *world, *track['velocity']]], dtype=float))[0]
            track['history'].append(row);track['history']=track['history'][-60:]
            classified=semantic_age<=.75 and bool(track.get('semantic'))
            entry={'id':key,'class':'person' if classified else 'UNKNOWN','confirmed':track['hits']>=3,'occlusion_s':0.,
                'position_m':center[:2].tolist(),'velocity_mps':local_velocity.tolist(),
                'observed_crossing_cleared':track['crossing_cleared'],
                'half_size_m':[.35,.35],'uncertainty_m':.25+min(semantic_age,.75)*.2,'quality':.8,
                'motion_observations':len(recent)+1,'history':freeze_json(track['history']),
                'measurement_evidence':{'session_id':session,
                    'frame_id':observation.frame_id,'timestamp_s':now,'sensor_ids':['depth'],
                    'source':'CURRENT_DEPTH_BODY_CORE','support_points':support,'mad_m':mad,
                    'motion_span_s':now-recent[0][0] if recent else 0.}}
            if classified:entry['semantic_evidence']=track['semantic']
            published.append(entry)
        return published
