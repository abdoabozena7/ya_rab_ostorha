// Metres, radians and seconds. Display precision does not imply sensor accuracy.
export const PLAYER_SIZE = Object.freeze({width:1.86, length:4.72, wheelbase:2.78});
export const positionOf = actor => actor.position ?? actor.group?.position ?? {x:0,z:0};
export const headingOf = actor => actor.heading ?? actor.group?.rotation.y ?? 0;
export function rectangle(position, heading, width=1.86, length=4.72, margin=0) {
  const s=Math.sin(heading),c=Math.cos(heading),w=width/2+margin,l=length/2+margin;
  return [[-w,-l],[w,-l],[w,l],[-w,l]].map(([x,z])=>({x:position.x+c*x+s*z,z:position.z-s*x+c*z}));
}
export function actorHull(actor, margin=0, time=0) {
  const p=positionOf(actor),v=actor.velocity??{x:0,z:0};
  return rectangle({x:p.x+v.x*60*time,z:p.z+v.z*60*time},headingOf(actor),
    actor.width??(actor.radius??.55)*2,actor.length??(actor.radius??.55)*2,margin);
}
function separated(a,b) {
  for(let i=0;i<2;i++) {
    const next=a[(i+1)%4],p=a[i],nx=next.z-p.z,nz=p.x-next.x;
    let amin=Infinity,amax=-Infinity,bmin=Infinity,bmax=-Infinity;
    for(let j=0;j<4;j++) {
      const av=a[j].x*nx+a[j].z*nz,bv=b[j].x*nx+b[j].z*nz;
      amin=Math.min(amin,av);amax=Math.max(amax,av);bmin=Math.min(bmin,bv);bmax=Math.max(bmax,bv);
    }
    if(amax<bmin||bmax<amin)return true;
  }
  return false;
}
export function overlaps(a,b) {return !separated(a,b)&&!separated(b,a);}
function pointSegment(p,a,b) {
  const x=b.x-a.x,z=b.z-a.z,d=x*x+z*z;
  const t=d?Math.max(0,Math.min(1,((p.x-a.x)*x+(p.z-a.z)*z)/d)):0;
  return Math.hypot(p.x-a.x-t*x,p.z-a.z-t*z);
}
export function hullDistance(a,b) {
  if(overlaps(a,b))return 0;
  let d=Infinity;
  for(let i=0;i<4;i++)for(const p of b)d=Math.min(d,pointSegment(p,a[i],a[(i+1)%4]));
  for(let i=0;i<4;i++)for(const p of a)d=Math.min(d,pointSegment(p,b[i],b[(i+1)%4]));
  return d;
}
export function nearbyClearance(position,heading,actors,size=PLAYER_SIZE) {
  const own=rectangle(position,heading,size.width,size.length);let gap=Infinity,nearest=null;
  for(const actor of actors) {
    const p=positionOf(actor);if(Math.hypot(p.x-position.x,p.z-position.z)>60)continue;
    const d=hullDistance(own,actorHull(actor));if(d<gap){gap=d;nearest=actor;}
  }
  return {gap,nearest,centimetres:Number.isFinite(gap)?Math.round(gap*100):null};
}
export function motionClear(position,heading,distance,actors,size=PLAYER_SIZE,margin=.12) {
  const samples=Math.max(1,Math.ceil(Math.abs(distance)/.2));
  const start=rectangle(position,heading,size.width,size.length,margin);
  for(const actor of actors) {
    const p=positionOf(actor);if(Math.hypot(p.x-position.x,p.z-position.z)>Math.abs(distance)+10)continue;
    const hull=actorHull(actor),initial=hullDistance(start,hull);
    const physicalInitial=initial===0?hullDistance(rectangle(position,heading,size.width,size.length),hull):Infinity;
    for(let i=1;i<=samples;i++) {
      const own=rectangle({x:position.x+Math.sin(heading)*distance*i/samples,z:position.z+Math.cos(heading)*distance*i/samples},heading,size.width,size.length,margin);
      if(overlaps(own,hull)) {
        // A neighbour can already occupy the comfort margin while the bodies
        // are clear. Permit parallel/escaping travel, never a shrinking gap.
        const physical=hullDistance(rectangle({x:position.x+Math.sin(heading)*distance*i/samples,z:position.z+Math.cos(heading)*distance*i/samples},heading,size.width,size.length),hull);
        if(physical<=.00001||physical+1e-7<physicalInitial)return false;
      }
    }
  }
  return true;
}
export function leadVehicle(position,heading,actors,size=PLAYER_SIZE) {
  const fx=Math.sin(heading),fz=Math.cos(heading);let gap=Infinity,leader=null,velocity=0;
  for(const actor of actors) {
    const p=positionOf(actor),dx=p.x-position.x,dz=p.z-position.z;
    const along=dx*fx+dz*fz,lateral=Math.abs(dx*fz-dz*fx);
    const relative=headingOf(actor)-heading;
    const width=actor.width??(actor.radius??.55)*2,length=actor.length??(actor.radius??.55)*2;
    const halfSide=Math.abs(Math.cos(relative))*width/2+Math.abs(Math.sin(relative))*length/2;
    const halfLong=Math.abs(Math.cos(relative))*length/2+Math.abs(Math.sin(relative))*width/2;
    if(along<=0||lateral>size.width/2+halfSide+.2)continue;
    const d=along-size.length/2-halfLong;
    if(d<gap){gap=d;leader=actor;velocity=Math.max(0,((actor.velocity?.x??0)*fx+(actor.velocity?.z??0)*fz)*60);}
  }
  return {gap,leader,velocity};
}
export function collisionRisk(position,heading,speedMps,actors,size=PLAYER_SIZE,horizon=2.5) {
  if(speedMps<1)return null;
  const velocity={x:Math.sin(heading)*speedMps,z:Math.cos(heading)*speedMps};
  let best=null;
  for(const actor of actors) {
    const p=positionOf(actor);if(Math.hypot(p.x-position.x,p.z-position.z)>speedMps*horizon+15)continue;
    for(let t=.1;t<=horizon;t+=.1) {
      const own=rectangle({x:position.x+velocity.x*t,z:position.z+velocity.z*t},heading,size.width,size.length,.2);
      if(overlaps(own,actorHull(actor,.05,t))) {
        if(!best||t<best.ttc)best={actor,ttc:t};break;
      }
    }
  }
  return best;
}
