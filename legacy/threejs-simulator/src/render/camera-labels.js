import * as THREE from 'three';

// Ground-truth geometry labels, explicitly not neural-network detections.
export function createCameraLabels(element,latencyElement) {
  const canvas=document.createElement('canvas');canvas.id='cameraLabels';element.appendChild(canvas);
  const context=canvas.getContext('2d'),cache=new WeakMap(),point=new THREE.Vector3(),origin=new THREE.Vector3();
  const corners=Array.from({length:8},()=>new THREE.Vector3());
  const ray=new THREE.Ray(),hit=new THREE.Vector3(),box=new THREE.Box3();
  return {update(camera,actors,obstacles) {
    const start=performance.now(),width=element.clientWidth,height=element.clientHeight;
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    context.clearRect(0,0,width,height);camera.updateMatrixWorld();camera.getWorldPosition(origin);
    const staticBoxes=obstacles.filter(o=>o.isMesh&&o.material?.visible===false).map(o=>{
      if(!cache.has(o))cache.set(o,new THREE.Box3().setFromObject(o));return cache.get(o);
    });
    let drawn=0;
    for(const actor of actors) {
      if(drawn>=10)break;
      const group=actor.group,distance=group.position.distanceTo(origin);
      if(distance>65||distance<2)continue;
      point.copy(group.position);point.y+=1;point.project(camera);
      if(point.z<=-1||point.z>=1||Math.abs(point.x)>1.1||Math.abs(point.y)>1.1)continue;
      point.copy(group.position);point.y+=1;ray.set(origin,point.sub(origin).normalize());
      if(staticBoxes.some(b=>ray.intersectBox(b,hit)&&origin.distanceTo(hit)<distance-1))continue;
      box.setFromObject(group);
      let left=width,right=0,top=height,bottom=0;
      for(let n=0;n<8;n++) {
        const p=corners[n].set(n&1?box.max.x:box.min.x,n&2?box.max.y:box.min.y,n&4?box.max.z:box.min.z).project(camera);
        const x=(p.x+1)*width/2,y=(1-p.y)*height/2;left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      }
      left=Math.max(1,left);right=Math.min(width-1,right);top=Math.max(12,top);bottom=Math.min(height-1,bottom);
      if(right-left<4||bottom-top<5)continue;
      const label=actor.visualKind|| (actor.kind==='tuktuk'?'tuk-tuk':actor.road&&'crossing' in actor?'person':'car');
      const color=label==='person'?'#ed938a':label==='tuk-tuk'||label==='motorcycle'?'#e6c463':'#8ccdde';
      context.strokeStyle=color;context.lineWidth=1;context.strokeRect(left,top,right-left,bottom-top);
      const caption=`${label} #${actor.index} · ${distance.toFixed(2)} m`;
      context.font='9px Arial';const labelWidth=context.measureText(caption).width+5;
      context.fillStyle=color;context.fillRect(left,top-11,labelWidth,11);context.fillStyle='#16323b';context.fillText(caption,left+2,top-3);drawn++;
    }
    latencyElement.textContent=`GT · ${(performance.now()-start).toFixed(1)} ms`;
  }};
}
