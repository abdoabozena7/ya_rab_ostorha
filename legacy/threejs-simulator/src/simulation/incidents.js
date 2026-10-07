const names={delivery:'ميكروباص واقف · تنزيل ركاب',braking:'فرملة مفاجئة قدّامك',cutin:'دخول مفاجئ للحارة',roadworks:'أعمال طريق · حارة واحدة'};
export function createIncidents(seed=42) {
  let state=seed>>>0,time=0,next=14,serial=0;const active=[];
  const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  function trigger(vehicles,player,type) {
    let candidates=vehicles.filter(v=>{
      const p=v.group?.position??v.position;
      return Math.hypot(p.x-player.x,p.z-player.z)>14&&Math.hypot(p.x-player.x,p.z-player.z)<150&&!active.some(e=>e.vehicle===v);
    });
    if(type==='braking'&&Number.isFinite(player.heading)) {
      const ahead=candidates.filter(v=>{
        const p=v.group?.position??v.position,dx=p.x-player.x,dz=p.z-player.z;
        return dx*Math.sin(player.heading)+dz*Math.cos(player.heading)>14&&Math.abs(dx*Math.cos(player.heading)-dz*Math.sin(player.heading))<2;
      }).sort((a,b)=>Math.hypot((a.group?.position??a.position).x-player.x,(a.group?.position??a.position).z-player.z)-Math.hypot((b.group?.position??b.position).x-player.x,(b.group?.position??b.position).z-player.z));
      if(ahead.length)candidates=ahead.slice(0,1);
    }
    if(!candidates.length)return null;
    const vehicle=candidates[Math.floor(random()*candidates.length)];
    type=type??['delivery','braking','cutin','roadworks'][Math.floor(random()*4)];
    const event={id:++serial,type,name:names[type],vehicle,starts:time,ends:time+(type==='cutin'?6:type==='braking'?7:20+random()*14)};
    active.push(event);return event;
  }
  return {active,trigger,reset(){active.length=0;time=0;next=14;state=seed;serial=0;},
    tick(dt,vehicles,player,enabled=true) {
      time+=dt;
      for(let i=active.length-1;i>=0;i--)if(time>=active[i].ends)active.splice(i,1);
      if(enabled&&time>=next){trigger(vehicles,player);next=time+22+random()*16;}
    },
    forVehicle(vehicle){return active.find(event=>event.vehicle===vehicle);},
    remaining(event){return Math.max(0,event.ends-time);},get time(){return time;},
  };
}
