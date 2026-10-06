import * as THREE from 'three';
import { loadVisual, fitVisual, instanceVisual } from './visual-assets.js?v=drive-final';
import { randomFor } from './city-layout.js?v=drive-final';

const specs=[
  ['vegetation/tree_palmDetailedTall.glb',8.5],['vegetation/tree_palmBend.glb',7.4],['vegetation/tree_default.glb',5.3],
  ['vegetation/plant_bushLarge.glb',.85],['props/light-curved.glb',7],['props/dumpster.glb',1.05],
  ['props/electricity-pole.glb',8],['props/construction-cone.glb',.65],['props/construction-barrier.glb',.85],
  ['vehicles/box.glb',.55],['furniture/bench.glb',.95],['furniture/chair.glb',.9],
  ['furniture/tableRound.glb',.72],['furniture/trashcan.glb',.8],['furniture/pottedPlant.glb',1.1],
  ['vehicles/sedan.glb',null],['vehicles/delivery.glb',null],['vehicles/motorcycle.glb',null],
  ['tuktuks/auto-rickshaw.glb',null],['pedestrians/character-b.glb',1.74],['pedestrians/character-e.glb',1.65],
];
const keys=specs.map(s=>s[0]);
export function createStreetProps(parent,addCollider) {
  const root=new THREE.Group();parent.add(root);const models=[];let parcels=[],placements=[];
  function draw() {
    root.clear();
    models.forEach((template,index)=>{
      if(!placements[index]?.length)return;
      const height=specs[index][1];
      const model=fitVisual(template,index===17?.9:index===18?1.7:2.05,index===17?2.5:index===18?3:4.1,height);
      model.traverse(part=>{if(part.isMesh&&index<15){part.material=part.material.clone();part.material.roughness=.9;part.material.metalness=0;
        if(index<4&&part.material.name.toLowerCase().includes('leaf'))part.material.color.setHex(0x7c9148);
        if(index<4&&part.material.name.toLowerCase().includes('wood'))part.material.color.setHex(0x93623e);
      }});
      instanceVisual(model,placements[index],root,{shadow:false,maxDistance:80});
    });
    if(models.length&&placements[9]?.length) {
      const transforms=[];
      for(const crate of placements[9])for(const x of [-.17,.05,.25])for(const z of [-.12,.12]) {
        transforms.push(crate.clone().multiply(new THREE.Matrix4().makeTranslation(x,.59,z)).scale(new THREE.Vector3(.14,.13,.14)));
      }
      const fruit=new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1,0),new THREE.MeshStandardMaterial({color:0xffffff,roughness:.85}),transforms.length);
      transforms.forEach((m,i)=>{fruit.setMatrixAt(i,m);fruit.setColorAt(i,new THREE.Color([0xd99534,0xb8b747,0xc45a3b][i%3]));});
      fruit.userData.lod={matrices:transforms,minDistance:0,maxDistance:75};root.add(fruit);
    }
  }
  function build(records) {
    parcels=records;placements=specs.map(()=>[]);const random=randomFor(9042);
    function place(index,p,x,z,y=.25,scale=1,yaw=0) {
      const cos=Math.cos(p.yaw),sin=Math.sin(p.yaw),wx=p.x+x*cos+z*sin,wz=p.z-x*sin+z*cos;
      placements[index].push(new THREE.Matrix4().compose(new THREE.Vector3(wx,y,wz),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),p.yaw+yaw),new THREE.Vector3(scale,scale,scale)));
      return {x:wx,z:wz,yaw:p.yaw+yaw};
    }
    for(const p of parcels) {
      const front=p.depth/2;
      if(p.parking) {
        for(let n=0;n<3;n++){
          const point=place(n===1?16:n===2?18:15,p,(n-1)*2.7,1.45,.08,1,n===0?.08:0);
          addCollider(point.x,point.z,n===2?1.7:2.05,n===2?3:4.1,2,point.yaw);
        }
        const point=place(15,p,.2,-2.4,.08,.94,Math.PI/2);
        addCollider(point.x,point.z,1.92,3.9,1.7,point.yaw);
        place(17,p,p.width/2-.5,front+1.1,.25,1,Math.PI/2);
        place(7,p,-p.width/2+.5,front+.5);continue;
      }
      if(p.id%3===0)place(p.id%2,p,p.width*.44,front+2.35,.25,.9+random()*.15);
      else if(p.id%11===0)place(2,p,p.width*.42,front+2.3);
      if(p.id%3===1)place(4,p,-p.width*.47,front+2.8,.25,1,Math.PI);
      if(p.id%9===1)place(6,p,p.width*.49,front+.9);
      if(p.shop===0||p.shop===1||p.shop===6) {
        place(12,p,-2,front+1.1);place(11,p,-3,front+1.1,.25,1,Math.PI/2);place(11,p,-1,front+1.1,.25,1,-Math.PI/2);
      }
      if(p.shop===5||p.shop===8||p.shop===6) {
        for(let n=0;n<3;n++)place(9,p,1.3+n*.65,front+.7,.25,.85+random()*.2);
        place(9,p,2,front+.7,.76,.8);
      }
      if(p.id%4===0){place(14,p,-p.width*.39,front+.6);place(13,p,p.width*.39,front+.6);}
      if(p.id%10===2)place(10,p,1.7,front+.9,.25,1,Math.PI);
      if(p.id%13===4){place(5,p,2.6,front+.8);place(7,p,1,front+1.6);}
      if(p.id%17===5){place(8,p,2,front+1.3);place(7,p,3.4,front+1.4);}
      if(p.id%3===2)place(p.id%2?19:20,p,p.id%2?-1.5:1.5,front+.65,.25,1,p.id*.4);
      if(p.id%6===0)place(17,p,-2,front+1.2,.25,1,Math.PI/3);
    }
    draw();
  }
  Promise.all(keys.map(path=>loadVisual(path))).then(loaded=>{models.push(...loaded.map(g=>g.scene));draw();}).catch(error=>console.warn('Street props unavailable.',error));
  return {build};
}
