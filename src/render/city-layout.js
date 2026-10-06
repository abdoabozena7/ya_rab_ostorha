export function randomFor(seed) {
  let state=seed>>>0;
  return () => {
    state+=0x6d2b79f5;
    let n=state; n=Math.imul(n^(n>>>15),n|1); n^=n+Math.imul(n^(n>>>7),n|61);
    return ((n^(n>>>14))>>>0)/4294967296;
  };
}

// Visual parcels only. Road topology, routing and movement limits are unchanged.
export function createParcels(roads,extent,seed=42) {
  const random=randomFor(seed),parcels=[];
  const ordered=[...roads].sort((a,b)=>(b.axis==='z'&&b.fixed===20)-(a.axis==='z'&&a.fixed===20));
  for(const road of ordered) {
    const junctions=roads.filter(r=>r.axis!==road.axis&&road.fixed>=r.min&&road.fixed<=r.max&&r.fixed>=road.min&&r.fixed<=road.max).sort((a,b)=>a.fixed-b.fixed);
    const segments=[];let start=road.min+7;
    for(const junction of junctions){const end=junction.fixed-junction.width/2-3.1;if(end>start)segments.push([start,end]);start=Math.max(start,junction.fixed+junction.width/2+3.1);}
    if(road.max-7>start)segments.push([start,road.max-7]);
    const centers=segments.flatMap(([a,b])=>{const count=Math.floor((b-a)/10.8);return Array.from({length:count},(_,i)=>a+(b-a)*(i+.5)/count);});
    for(const along of centers)for(const side of [-1,1]) {
      const width=8.5+random()*1.6,depth=7.5+random()*1.2;
      const lateral=road.fixed+side*(road.width/2+3.5+depth/2);
      const x=road.axis==='z'?lateral:along,z=road.axis==='x'?lateral:along;
      const hx=(road.axis==='z'?depth:width)/2,hz=(road.axis==='z'?width:depth)/2;
      if(Math.abs(x)>extent+6||Math.abs(z)>extent+6)continue;
      if(roads.some(r=>r.axis==='z'
        ? Math.abs(x-r.fixed)<hx+r.width/2+2.8&&z+hz>r.min&&z-hz<r.max
        : Math.abs(z-r.fixed)<hz+r.width/2+2.8&&x+hx>r.min&&x-hx<r.max))continue;
      if(parcels.some(p=>Math.abs(x-p.x)<hx+p.hx+.5&&Math.abs(z-p.z)<hz+p.hz+.5))continue;
      const variant=Math.floor(random()*8),height=11+random()*17;
      parcels.push({x,z,hx,hz,width,depth,height,variant,side,road,parking:parcels.length%13===5,
        yaw:road.axis==='z'?-side*Math.PI/2:(side>0?Math.PI:0),
        palette:Math.floor(random()*4),shop:Math.floor(random()*10),detail:random(),id:parcels.length});
    }
  }
  return parcels;
}
