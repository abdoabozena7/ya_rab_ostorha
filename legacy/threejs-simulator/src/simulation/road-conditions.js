export const WORLD_EXTENT=640;
export const SURFACES=Object.freeze({
  asphalt:{name:'أسفلت',grip:.94,rolling:.17,roughness:.002,limit:180},
  broken:{name:'أسفلت مكسّر',grip:.66,rolling:.58,roughness:.036,limit:24},
  cobbles:{name:'حارة ضيقة · رصف حجري',grip:.7,rolling:.42,roughness:.018,limit:20},
  wet:{name:'مياه على الطريق',grip:.48,rolling:.22,roughness:.003,limit:55},
  gravel:{name:'رمل وحصى',grip:.53,rolling:.65,roughness:.025,limit:30},
});
export const CONDITION_ZONES=Object.freeze([
  {x:20,z:100,w:10,l:38,type:'broken'},
  {x:20,z:270,w:14,l:54,type:'wet'},
  {x:-20,z:390,w:12,l:42,type:'gravel'},
  {x:60,z:40,w:80,l:6.4,type:'cobbles'},
  {x:-60,z:-80,w:80,l:6.4,type:'cobbles'},
  {x:-40,z:-20,w:6.4,l:70,type:'cobbles'},
  {x:20,z:-220,w:14,l:36,type:'broken'},
]);
export function surfaceAt(x,z) {
  return SURFACES[CONDITION_ZONES.find(r=>Math.abs(x-r.x)<r.w/2&&Math.abs(z-r.z)<r.l/2)?.type??'asphalt'];
}
export function surfaceAhead(position,heading,speedMps) {
  let surface=surfaceAt(position.x,position.z),limit=surface.limit/3.6;
  for(let d=2;d<=Math.max(22,speedMps*4);d+=2) {
    const next=surfaceAt(position.x+Math.sin(heading)*d,position.z+Math.cos(heading)*d);
    limit=Math.min(limit,Math.sqrt((next.limit/3.6)**2+2*2.6*Math.max(0,d-4)));
  }
  return {surface,limit};
}
export function roadHeight(x,z) {
  const s=surfaceAt(x,z);
  return s.roughness*(Math.sin(x*3.7+z*2.4)*.55+Math.sin(z*7.1-x*2.3)*.3+Math.sin(z*1.9)*.15);
}
