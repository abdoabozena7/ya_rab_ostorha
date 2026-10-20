"""Native debug geometry from the same sensor evidence exported in the video."""
import math
import numpy as np
from backend.core.scene_overlays import overlay_geometry
from backend.core.video_prediction import pose_rotation


def draw(provider,prediction):
    if not prediction or not prediction.get('render_reference') or prediction.get('visual_version')!=1:return
    api=provider.connection.api;debug=provider.world.world.debug
    stamp=provider.last_vehicle['timestamp'];boxes,arrows=overlay_geometry(prediction,stamp)
    reference=prediction['render_reference'];rotation=pose_rotation(reference);origin=np.asarray(reference['position_m'])
    def location(point):
        p=rotation@np.asarray(point)+origin;return api.Location(*[float(x) for x in p])
    def color(hex):return api.Color(*[int(hex[i:i+2],16) for i in (1,3,5)])
    # HUD primitives project world coordinates only in the server viewport.
    # World debug primitives also enter RGB sensor captures, contaminating
    # model inputs and drawing a second copy beneath client/video overlays.
    # No actor queries, dimensions or simulator boxes enter this renderer.
    lifetime=provider.fixed_delta+1e-4
    for row in boxes:
        box=row['box'];points=row['points'];center=np.mean(points,axis=0)
        debug.draw_hud_box(api.BoundingBox(location(center),api.Vector3D(*box['half_size_m'])),
            api.Rotation(yaw=math.degrees(reference.get('rotation_rad',{}).get('yaw',0)+box.get('yaw_rad',0)),
                pitch=math.degrees(reference.get('rotation_rad',{}).get('pitch',0)),roll=math.degrees(reference.get('rotation_rad',{}).get('roll',0))),
            thickness=.025,color=color(row['color']),life_time=lifetime)
    for row in arrows:
        points=row['points'];shade=color(row['color'])
        for i in range(0,len(points)-1,2):
            debug.draw_hud_line(location(points[i]),location(points[min(i+1,len(points)-1)]),thickness=.025,color=shade,life_time=lifetime)
        index=min(len(points)-1,max(1,int(math.floor((.35+(stamp%1)*.65)*len(points)+.5))))
        debug.draw_hud_arrow(location(points[index-1]),location(points[index]),thickness=.03,arrow_size=.15,color=shade,life_time=lifetime)
    age=stamp-prediction.get('selected_path_timestamp_s',prediction['timestamp_s'])
    path_reference=prediction.get('selected_path_reference')
    if path_reference and prediction.get('selected_path') and 0<=age<=.1+1e-6:
        from backend.core.video_prediction import remaining_forecast
        path_rotation=pose_rotation(path_reference);path_origin=np.asarray(path_reference['position_m'])
        def chosen_location(row):
            p=path_rotation@np.asarray([row[1],row[2],.15])+path_origin
            return api.Location(*[float(x) for x in p])
        path=remaining_forecast(prediction['selected_path'],age)
        for a,b in zip(path,path[1:]):debug.draw_hud_line(chosen_location(a),chosen_location(b),thickness=.03,color=color('#00BA69'),life_time=lifetime)
