// Simulation units are metres per frame. This is a simple deterministic
// collision guard, not a trained model and not suitable for a real vehicle.
export function limitForwardSpeed(speed, frontDistance, braking = 0.018) {
  if (speed <= 0 || !Number.isFinite(frontDistance)) return { speed, emergency: false };
  const clearance = Math.max(0, frontDistance - 3.5);
  const allowed = Math.sqrt(2 * braking * clearance);
  return { speed: Math.min(speed, allowed), emergency: speed > allowed };
}

// Ground-plane circle sweep: prevents one actor stepping through another.
export function canAdvance(start, end, actors, ownRadius) {
  const dx=end.x-start.x, dz=end.z-start.z;
  const length2=dx*dx+dz*dz;
  return actors.every(actor=>{
    const p=actor.position ?? actor.group?.position;
    if(!p) return true;
    const current=Math.hypot(p.x-start.x,p.z-start.z);
    const endDistance=Math.hypot(p.x-end.x,p.z-end.z);
    if(current<ownRadius+actor.radius) return endDistance>current;
    const t=length2 ? Math.max(0,Math.min(1,((p.x-start.x)*dx+(p.z-start.z)*dz)/length2)) : 0;
    return Math.hypot(start.x+dx*t-p.x,start.z+dz*t-p.z)>=ownRadius+actor.radius;
  });
}

// Evaluate relative motion over the next short horizon. The chosen speed is
// then checked again by the one-frame sweep, including while reversing.
export function guardDynamicMotion(position, heading, desiredSpeed, actors, ownRadius=2.2) {
  const sign=Math.sign(desiredSpeed);
  const maximum=Math.abs(desiredSpeed);
  const relevant=actors.filter(actor=>{
    const p=actor.position ?? actor.group?.position;
    return p && Math.hypot(p.x-position.x,p.z-position.z)<18;
  });
  if(!relevant.length) return {speed:desiredSpeed, emergency:false};
  const horizon=18;
  const safe=candidate=>relevant.every(actor=>{
    const p=actor.position ?? actor.group.position;
    const vx=Math.sin(heading)*candidate-(actor.velocity?.x??0);
    const vz=Math.cos(heading)*candidate-(actor.velocity?.z??0);
    const rx=p.x-position.x, rz=p.z-position.z;
    const clearance=ownRadius+actor.radius+0.55;
    const magnitude=vx*vx+vz*vz;
    if(Math.hypot(rx,rz)<clearance) return rx*vx+rz*vz<0;
    const time=magnitude?Math.max(0,Math.min(horizon,(rx*vx+rz*vz)/magnitude)):0;
    return Math.hypot(rx-vx*time,rz-vz*time)>=clearance;
  });
  let chosen=0;
  for(let step=20;step>=0;step--) {
    const candidate=sign*maximum*step/20;
    if(safe(candidate)) {chosen=candidate;break;}
  }
  const end={x:position.x+Math.sin(heading)*chosen,z:position.z+Math.cos(heading)*chosen};
  if(!canAdvance(position,end,relevant,ownRadius+0.55)) chosen=0;
  return {speed:chosen,emergency:Math.abs(chosen)<maximum-0.0001};
}
