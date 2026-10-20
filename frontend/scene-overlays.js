// Only recorded, sensor-derived geometry. No native actor boxes or dimensions.
import {projectPrediction,remainingForecast} from './prediction-view.js';
const edges=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
export function boxCorners(box,age=0){
  const c=box.center_m,h=box.half_size_m,v=box.velocity_mps||[0,0],yaw=box.yaw_rad||0;
  if(!Array.isArray(c)||c.length!==3||!Array.isArray(h)||h.length!==3||![...c,...h,yaw,...v].every(Number.isFinite)||h.some(x=>x<=0))return [];
  const co=Math.cos(yaw),si=Math.sin(yaw);
  return [-1,1].flatMap(z=>[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>
    [c[0]+v[0]*age+x*h[0]*co-y*h[1]*si,c[1]+v[1]*age+x*h[0]*si+y*h[1]*co,c[2]+z*h[2]]));
}
export function drawSceneOverlays(ctx,prediction,camera){
  const age=camera.timestamp-prediction.timestamp_s;
  if(!Number.isFinite(age)||age<0||age>.75)return {boxes:0,arrows:0};
  let boxes=0,arrows=0;
  const risks=new Map((prediction.trajectories||[]).map(m=>[m.track_id,m]));
  if(age<=.15+1e-6)for(const box of prediction.boxes_3d||[]){
    if(box.source!=='CURRENT_SENSOR_GEOMETRY'||box.measurement_frame!==prediction.evaluation_frame)continue;
    const corners=boxCorners(box,age).map(p=>projectPrediction(p,prediction.render_reference,camera));
    if(corners.length!==8)continue;
    const risk=risks.get(box.track_id);
    ctx.strokeStyle=risk?.used_for_actuation?'#FF6B57':risk?'#F5B95F':box.class==='person'?'#FFB7B2':'#83d9df';ctx.lineWidth=2;ctx.setLineDash([]);ctx.beginPath();let count=0;
    for(const [a,b] of edges)if(corners[a]&&corners[b]){ctx.moveTo(...corners[a]);ctx.lineTo(...corners[b]);count++;}
    if(count){ctx.stroke();boxes++;}
  }
  for(const mode of prediction.trajectories||[]){
    if(!mode.points?.length||Math.hypot(mode.points.at(-1)[1]-mode.points[0][1],mode.points.at(-1)[2]-mode.points[0][2])<.1)continue;
    const points=remainingForecast(mode.points,age).map(row=>projectPrediction([row[1],row[2],.25],prediction.render_reference,camera)).filter(Boolean);
    if(points.length<2)continue;
    ctx.strokeStyle=mode.used_for_actuation?'#FF6B57':mode.class==='person'?'#FFB7B2':'#83d9df';ctx.lineWidth=2;ctx.setLineDash([6,5]);ctx.beginPath();
    points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.stroke();ctx.setLineDash([]);
    // The arrowhead advances along the same time-indexed, selected hypothesis.
    const tipIndex=Math.min(points.length-1,Math.max(1,Math.round((.35+(camera.timestamp%1)*.65)*points.length)));
    const a=points[tipIndex-1],b=points[tipIndex],angle=Math.atan2(b[1]-a[1],b[0]-a[0]);
    ctx.beginPath();ctx.moveTo(b[0]-8*Math.cos(angle-.5),b[1]-8*Math.sin(angle-.5));ctx.lineTo(...b);
    ctx.lineTo(b[0]-8*Math.cos(angle+.5),b[1]-8*Math.sin(angle+.5));ctx.stroke();arrows++;
  }
  return {boxes,arrows};
}
