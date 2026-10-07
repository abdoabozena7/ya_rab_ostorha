import { clamp } from './longitudinal.js?v=drive-final';
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const direction=(a,b)=>{const l=distance(a,b)||1;return{x:(b.x-a.x)/l,z:(b.z-a.z)/l};};
export function buildDrivingPath(path,offset=2.5) {
  if(path.length<2)return [];
  const corners=path.map((p,i)=>{
    const incoming=direction(path[Math.max(0,i-1)],path[i||1]);
    const outgoing=i<path.length-1?direction(p,path[i+1]):incoming;
    const turn=Math.abs(incoming.x*outgoing.z-incoming.z*outgoing.x)>.1;
    const inOffset=typeof offset==='function'?offset(p,incoming):offset;
    const outOffset=typeof offset==='function'?offset(p,outgoing):offset;
    return {x:p.x-incoming.z*inOffset-(turn?outgoing.z*outOffset:0),z:p.z+incoming.x*inOffset+(turn?outgoing.x*outOffset:0),incoming,outgoing,turn};
  });
  const controls=[];
  for(const p of corners) {
    if(!p.turn){controls.push(p);continue;}
    const radius=4,a={x:p.x-p.incoming.x*radius,z:p.z-p.incoming.z*radius},b={x:p.x+p.outgoing.x*radius,z:p.z+p.outgoing.z*radius};
    for(let i=0;i<=8;i++){const t=i/8;controls.push({x:(1-t)**2*a.x+2*t*(1-t)*p.x+t*t*b.x,z:(1-t)**2*a.z+2*t*(1-t)*p.z+t*t*b.z});}
  }
  const sampled=[{...controls[0],s:0}];let s=0;
  for(let i=1;i<controls.length;i++) {
    const a=controls[i-1],b=controls[i],length=distance(a,b),count=Math.max(1,Math.ceil(length/2));
    for(let j=1;j<=count;j++){s+=length/count;sampled.push({x:a.x+(b.x-a.x)*j/count,z:a.z+(b.z-a.z)*j/count,s});}
  }
  return sampled;
}
export function followRoute(points,position,heading,speedMps,cursor=0) {
  if(points.length<2)return {steering:0,limit:0,cursor:0,remaining:0};
  let closest=cursor,best=Infinity;
  for(let i=Math.max(0,cursor-2);i<Math.min(points.length,cursor+25);i++) {
    const d=distance(position,points[i]);if(d<best){best=d;closest=i;}
  }
  cursor=Math.max(cursor,closest);
  const lookahead=clamp(3+speedMps*.45,3,14);let target=cursor;
  while(target<points.length-1&&points[target].s-points[cursor].s<lookahead)target++;
  const p=points[target],dx=p.x-position.x,dz=p.z-position.z,alpha=Math.atan2(dx,dz)-heading;
  const steering=Math.atan2(2*2.78*Math.sin(alpha),Math.max(2,Math.hypot(dx,dz)));
  let limit=50;
  for(let i=Math.max(1,cursor);i<points.length-1;i++) {
    const d=points[i].s-points[cursor].s;if(d>120)break;
    const a=points[i-1],b=points[i],c=points[i+1],ab=distance(a,b),bc=distance(b,c),ac=distance(a,c);
    const cross=Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x));
    const curvature=2*cross/Math.max(.001,ab*bc*ac);
    if(curvature>.001)limit=Math.min(limit,Math.sqrt(2.4/curvature+2*2.8*Math.max(0,d-3)));
  }
  const remaining=Math.max(0,points.at(-1).s-points[cursor].s);
  limit=Math.min(limit,Math.sqrt(2*2.5*Math.max(0,remaining-1)));
  return {steering,limit,cursor,remaining,target:p};
}

export function endTurn(road,direction,roads,index=0) {
  const endpoint=direction>0?road.max:road.min;
  const continuation=roads.find(r=>r!==road&&r.axis===road.axis&&r.fixed===road.fixed&&(direction>0?r.min===endpoint:r.max===endpoint));
  if(continuation) {
    const lane=direction*(road.sideStreet?1.5:2.5);
    const points=Array.from({length:17},(_,i)=>road.axis==='z'?{x:road.fixed-lane,z:endpoint-direction*8+direction*i,s:i}:{x:endpoint-direction*8+direction*i,z:road.fixed+lane,s:i});
    return {road:continuation,direction,points,cursor:0};
  }
  const candidates=roads.filter(r=>r!==road&&r.axis!==road.axis&&r.fixed===endpoint&&road.fixed>=r.min&&road.fixed<=r.max);
  if(!candidates.length)return null;
  const next=candidates[index%candidates.length];
  const directions=[-1,1].filter(d=>d>0?next.max-road.fixed>12:road.fixed-next.min>12);
  if(!directions.length)return null;
  const nextDirection=directions[index%directions.length];
  const lane=r=>r.sideStreet?1.5:2.5;
  const point=(r,d,along)=>r.axis==='z'?{x:r.fixed-d*lane(r),z:along}:{x:along,z:r.fixed+d*lane(r)};
  const a=point(road,direction,endpoint-direction*8),b=point(next,nextDirection,road.fixed+nextDirection*8);
  const c=road.axis==='z'?{x:a.x,z:b.z}:{x:b.x,z:a.z};
  const points=[];let s=0;
  for(let i=0;i<=24;i++) {
    const t=i/24,p={x:(1-t)**2*a.x+2*t*(1-t)*c.x+t*t*b.x,z:(1-t)**2*a.z+2*t*(1-t)*c.z+t*t*b.z};
    if(points.length)s+=distance(points.at(-1),p);points.push({...p,s});
  }
  return {road:next,direction:nextDirection,points,cursor:0};
}
