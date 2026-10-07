import * as THREE from 'three';
import { loadVisual, fitVisual, instanceVisual } from './visual-assets.js?v=drive-final';

const shops=[['فول وطعمية','#ae4134'],['كشري','#b97338'],['صيدلية','#3b8065'],['موبايلات','#326581'],['مخبز','#ae753f'],['سوبر ماركت','#667b48'],['عصير','#b87432'],['قطع غيار','#465b6a'],['بقالة','#4b7963'],['مكتبة','#775d77']];
const box=new THREE.BoxGeometry(1,1,1);
const frameMaterial=new THREE.MeshStandardMaterial({color:0xd8cab4,roughness:.9});
const glassMaterial=new THREE.MeshStandardMaterial({color:0x30444a,roughness:.28,metalness:.05});
const trimMaterial=new THREE.MeshStandardMaterial({color:0x5c6058,roughness:.8});
const signMaterials=shops.map(([text,color])=>{
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=128;
  const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,512,128);
  context.strokeStyle='#d8c99e';context.lineWidth=5;context.strokeRect(5,5,502,118);
  context.textAlign='center';context.textBaseline='middle';context.direction='rtl';context.fillStyle='#fff3d9';context.font='bold 65px Arial';context.fillText(text,256,65,470);
  const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({map,roughness:.8,side:THREE.DoubleSide});
});

export function createShopfronts(parent) {
  const root=new THREE.Group();parent.add(root);let records=[],awning=null;
  const toWorld=(p,x,y,z,sx,sy,sz)=>new THREE.Matrix4()
    .compose(new THREE.Vector3(p.x,0,p.z),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),p.yaw),new THREE.Vector3(1,1,1))
    .multiply(new THREE.Matrix4().compose(new THREE.Vector3(x,y,z),new THREE.Quaternion(),new THREE.Vector3(sx,sy,sz)));
  function batch(geometry,material,matrices,shadow=false) {
    if(!matrices.length)return;
    const mesh=new THREE.InstancedMesh(geometry,material,matrices.length);
    matrices.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.castShadow=shadow;mesh.userData.lod={matrices,minDistance:0,maxDistance:100};root.add(mesh);
  }
  function draw() {
    root.clear();const frames=[],windows=[],mullions=[],steps=[];
    records.forEach(p=>{
      const front=p.depth/2+.1;
      frames.push(toWorld(p,0,1.6,front,p.width*.91,3.2,.14));
      windows.push(toWorld(p,0,1.7,front+.09,p.width*.8,2.75,.035));
      [-.3,0,.3].forEach(side=>mullions.push(toWorld(p,p.width*side,1.7,front+.12,.1,2.8,.05)));
      steps.push(toWorld(p,0,.22,front+.25,p.width*.9,.2,.6));
    });
    batch(box,frameMaterial,frames);batch(box,glassMaterial,windows);batch(box,trimMaterial,mullions);batch(box,frameMaterial,steps);
    for(let shop=0;shop<shops.length;shop++) {
      const selected=records.filter(p=>p.shop===shop);
      batch(new THREE.PlaneGeometry(1,1),signMaterials[shop],selected.map(p=>toWorld(p,0,3.8,p.depth/2+.22,p.width*.9,1.05,1)));
      if(awning) {
        const visual=fitVisual(awning,1,1);
        const size=new THREE.Box3().setFromObject(visual).getSize(new THREE.Vector3());
        visual.scale.set(1/size.x,1/size.y,1/size.z);
        visual.traverse(part=>{if(part.isMesh){part.material=part.material.clone();part.material.color.set(shops[shop][1]);}});
        instanceVisual(visual,selected.filter(p=>p.detail>.18).map(p=>toWorld(p,0,2.8,p.depth/2+.7,p.width*.88,.52,1.2)),root);
      }
    }
  }
  loadVisual('buildings/detail-awning.glb').then(g=>{awning=g.scene;draw();}).catch(error=>console.warn('Awning asset unavailable.',error));
  return {build(parcels){records=parcels;draw();}};
}
