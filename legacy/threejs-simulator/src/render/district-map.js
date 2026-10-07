import { roadLayout } from '../simulation/road-lanes.js?v=drive-final';
import { createParcels } from './city-layout.js?v=drive-final';

// A lightweight, north-up map avoids rendering all 3D agents a third time.
export function createDistrictMap(element) {
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=320;
  canvas.setAttribute('aria-label','District map, player position, traffic and planned route');element.appendChild(canvas);
  const ctx=canvas.getContext('2d'),background=document.createElement('canvas');background.width=640;background.height=640;
  let cachedExtent=0;
  function rebuild(extent) {
    cachedExtent=extent;const c=background.getContext('2d'),scale=640/(extent*2+40),offset=extent+20;
    c.fillStyle='#223c43';c.fillRect(0,0,640,640);
    const roads=roadLayout(extent).roads;
    c.fillStyle='#718583';
    for(const r of roads) {
      const x=r.axis==='z'?r.fixed-r.width/2:r.min,z=r.axis==='x'?r.fixed-r.width/2:r.min;
      c.fillRect((x+offset)*scale,(z+offset)*scale,(r.axis==='z'?r.width:r.max-r.min)*scale,(r.axis==='x'?r.width:r.max-r.min)*scale);
    }
    c.fillStyle='#3f5759';
    for(const p of createParcels(roads,extent))c.fillRect((p.x-p.hx+offset)*scale,(p.z-p.hz+offset)*scale,p.hx*2*scale,p.hz*2*scale);
  }
  return {update(car,angle,extent,path,destination,vehicles) {
    if(extent!==cachedExtent)rebuild(extent);
    const span=180,scale=320/span,sx=x=>(x-car.position.x)*scale+160,sy=z=>(z-car.position.z)*scale+160;
    ctx.fillStyle='#223c43';ctx.fillRect(0,0,320,320);
    const bgScale=640/(extent*2+40),srcX=(car.position.x-span/2+extent+20)*bgScale,srcY=(car.position.z-span/2+extent+20)*bgScale;
    ctx.drawImage(background,srcX,srcY,span*bgScale,span*bgScale,0,0,320,320);
    if(path.length) {
      ctx.strokeStyle='#f4d757';ctx.lineWidth=6;ctx.lineJoin='round';ctx.beginPath();
      path.forEach((p,i)=>i?ctx.lineTo(sx(p.x),sy(p.z)):ctx.moveTo(sx(p.x),sy(p.z)));ctx.stroke();
    }
    ctx.fillStyle='#b0c9c5';vehicles.forEach(v=>{ctx.fillRect(sx(v.group.position.x)-1.5,sy(v.group.position.z)-1.5,3,3);});
    if(destination){ctx.fillStyle='#f4d757';ctx.beginPath();ctx.arc(sx(destination.position.x),sy(destination.position.z),7,0,Math.PI*2);ctx.fill();}
    ctx.save();ctx.translate(160,160);ctx.rotate(-angle);ctx.beginPath();ctx.moveTo(0,11);ctx.lineTo(-8,-8);ctx.lineTo(0,-4);ctx.lineTo(8,-8);ctx.closePath();ctx.fillStyle='#57b8e1';ctx.fill();ctx.strokeStyle='#fff4d8';ctx.lineWidth=3;ctx.stroke();ctx.restore();
  }};
}
