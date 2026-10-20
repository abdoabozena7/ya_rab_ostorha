"""Sensor-volume corners and active risk arrows shared by native/video renderers."""
import math
import numpy as np

EDGES=((0,1),(1,2),(2,3),(3,0),(4,5),(5,6),(6,7),(7,4),(0,4),(1,5),(2,6),(3,7))


def box_corners(box,age=0.):
    c,h=box['center_m'],box['half_size_m'];v=box.get('velocity_mps',[0.,0.]);yaw=box.get('yaw_rad',0.)
    if len(c)!=3 or len(h)!=3 or not np.isfinite([*c,*h,*v,yaw]).all() or min(h)<=0:return []
    co,si=math.cos(yaw),math.sin(yaw)
    return [[c[0]+v[0]*age+x*h[0]*co-y*h[1]*si,c[1]+v[1]*age+x*h[0]*si+y*h[1]*co,c[2]+z*h[2]]
        for z in (-1,1) for x,y in ((-1,-1),(1,-1),(1,1),(-1,1))]


def overlay_geometry(prediction,stamp):
    from .video_prediction import remaining_forecast
    age=stamp-prediction['timestamp_s'];boxes=[];arrows=[]
    if not 0<=age<=.75:return boxes,arrows
    risks={m['track_id']:m for m in prediction.get('trajectories',[])}
    if age<=.15+1e-6:
        for box in prediction.get('boxes_3d',[]):
            if box.get('source')!='CURRENT_SENSOR_GEOMETRY' or box.get('measurement_frame')!=prediction.get('evaluation_frame'):continue
            points=box_corners(box,age)
            if len(points)!=8:continue
            risk=risks.get(box['track_id'])
            color='#FF6B57' if risk and risk.get('used_for_actuation') else '#F5B95F' if risk else '#FFB7B2' if box['class']=='person' else '#83d9df'
            boxes.append({'points':points,'color':color,'box':box})
    for mode in prediction.get('trajectories',[]):
        path=mode.get('points',[])
        if not path or math.dist(path[0][1:3],path[-1][1:3])<.1:continue
        points=[[p[1],p[2],.25] for p in remaining_forecast(path,age)]
        if len(points)>1:arrows.append({'points':points,'color':'#FF6B57' if mode.get('used_for_actuation') else '#FFB7B2' if mode.get('class')=='person' else '#83d9df','track_id':mode['track_id']})
    return boxes,arrows


def draw_scene(image,prediction,camera):
    from PIL import ImageDraw
    from .video_prediction import project_prediction
    drawing=ImageDraw.Draw(image);boxes,arrows=overlay_geometry(prediction,camera['timestamp_s']);count=0
    project=lambda p:project_prediction(p,prediction['render_reference'],camera)
    for row in boxes:
        points=[project(p) for p in row['points']]
        for a,b in EDGES:
            if points[a] is not None and points[b] is not None:drawing.line((points[a],points[b]),fill=row['color'],width=2)
    for row in arrows:
        points=[q for q in map(project,row['points']) if q is not None]
        if len(points)<2:continue
        # Same moving arrowhead phase and selected path as the main camera.
        for i in range(1,len(points)):
            if i%2:drawing.line((points[i-1],points[i]),fill=row['color'],width=2)
        index=min(len(points)-1,max(1,int(math.floor((.35+(camera['timestamp_s']%1)*.65)*len(points)+.5))))
        a,b=points[index-1:index+1];angle=math.atan2(b[1]-a[1],b[0]-a[0])
        drawing.line(((b[0]-8*math.cos(angle-.5),b[1]-8*math.sin(angle-.5)),b,
            (b[0]-8*math.cos(angle+.5),b[1]-8*math.sin(angle+.5))),fill=row['color'],width=2);count+=1
    return len(boxes),count
