import * as THREE from 'three';
import { loadVisual, fitVisual, instanceVisual, facadeMaterial } from './visual-assets.js?v=drive-final';
import { createParcels, randomFor } from './city-layout.js?v=drive-final';
import { createShopfronts } from './shopfronts.js?v=drive-final';
import { createStreetProps } from './street-props.js?v=drive-final';

const BUILDINGS=['building-a','building-b','building-d','building-e','building-f','building-g','building-i','building-l'];
const boxGeometry=new THREE.BoxGeometry(1,1,1);
const material=(color,roughness=.9)=>new THREE.MeshStandardMaterial({color,roughness});
const plaster=material(0xd7c3a3), trim=material(0xaca18e), glass=material(0x304853,.28), metal=material(0x536064,.7);
const colliderMaterial=new THREE.MeshBasicMaterial({visible:false});

function matrix(x,y,z,sx=1,sy=1,sz=1,yaw=0) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x,y,z),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),yaw),new THREE.Vector3(sx,sy,sz));
}
function localMatrix(p,x,y,z,sx=1,sy=1,sz=1,yaw=0) {
  return matrix(p.x,0,p.z,1,1,1,p.yaw).multiply(matrix(x,y,z,sx,sy,sz,yaw));
}
function batch(geometry,mat,matrices,parent,shadow=false) {
  if(!matrices.length)return;
  const mesh=new THREE.InstancedMesh(geometry,mat,matrices.length);
  matrices.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.castShadow=shadow;mesh.receiveShadow=false;
  mesh.userData.lod={matrices,minDistance:0,maxDistance:110};
  parent.add(mesh);return mesh;
}

export function createStreetscape(scene,obstacles) {
  const root=new THREE.Group(),buildings=new THREE.Group(),details=new THREE.Group(),background=new THREE.Group();
  root.add(background,buildings,details);scene.add(root);
  const shopfronts=createShopfronts(root);
  const props=createStreetProps(root,addCollider);
  const colliders=[],models=[],farModels=[];
  let parcels=[],extent=100;
  function addCollider(x,z,width,depth,height,yaw=0) {
    const collider=new THREE.Mesh(boxGeometry,colliderMaterial);
    collider.position.set(x,height/2,z);collider.scale.set(width,height,depth);collider.rotation.y=yaw;
    root.add(collider);obstacles.push(collider);colliders.push(collider);
  }
  function drawBuildings() {
    buildings.clear();
    if(!models.length) {
      batch(boxGeometry,plaster,parcels.filter(p=>!p.parking).map(p=>matrix(p.x,p.height/2,p.z,p.width,p.height,p.depth,p.yaw)),buildings);
      return;
    }
    for(let variant=0;variant<models.length;variant++)for(let palette=0;palette<4;palette++) {
      const records=parcels.filter(p=>!p.parking&&p.variant===variant&&p.palette===palette);
      if(!records.length)continue;
      const template=models[variant].clone(true), bounds=new THREE.Box3().setFromObject(template),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
      template.traverse(part=>{if(part.isMesh)part.material=facadeMaterial(part.material,palette);});
      const transforms=records.map(p=>matrix(p.x,0,p.z,1,1,1,p.yaw)
        .multiply(matrix(0,0,0,p.width/size.x,p.height/size.y,p.depth/size.z))
        .multiply(matrix(-center.x,-bounds.min.y,-center.z)));
      instanceVisual(template,transforms,buildings,{shadow:true,maxDistance:65}).forEach(mesh=>mesh.receiveShadow=false);
    }
    if(farModels.length)for(let variant=0;variant<3;variant++)for(let palette=0;palette<4;palette++) {
      const records=parcels.filter(p=>!p.parking&&p.variant%3===variant&&p.palette===palette);
      const template=farModels[variant].clone(true),bounds=new THREE.Box3().setFromObject(template),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
      template.traverse(part=>{if(part.isMesh)part.material=facadeMaterial(part.material,palette);});
      const transforms=records.map(p=>matrix(p.x,0,p.z,1,1,1,p.yaw).multiply(matrix(0,0,0,p.width/size.x,p.height/size.y,p.depth/size.z)).multiply(matrix(-center.x,-bounds.min.y,-center.z)));
      instanceVisual(template,transforms,buildings,{shadow:false,minDistance:65,maxDistance:220}).forEach(mesh=>mesh.receiveShadow=false);
    }
  }
  function drawFacades() {
    details.clear();
    const ac=[],vents=[],balconies=[],rails=[],tanks=[],tankBases=[],roofs=[],antennas=[],dishes=[];
    for(const p of parcels) {
      if(p.parking)continue;
      const front=p.depth/2+.13;
      roofs.push(localMatrix(p,0,p.height+.4,0,p.width*.45,.8,p.depth*.45));
      if(p.detail>.2){tanks.push(localMatrix(p,-p.width*.22,p.height+1.3,0,1.1,1.7,1.1));tankBases.push(localMatrix(p,-p.width*.22,p.height+.27,0,1.5,.3,1.5));}
      if(p.id%3===0){antennas.push(localMatrix(p,2,p.height+2,-1,.07,3.8,.07));dishes.push(localMatrix(p,1.3,p.height+1.1,1,.8,.3,.8,.3));}
      for(let y=5;y<p.height-1;y+=3.3) {
        if(p.id%2===0) {
          balconies.push(localMatrix(p,0,y,front+.4,p.width*.66,.18,.95));
          rails.push(localMatrix(p,0,y+.5,front+.85,p.width*.66,.72,.09));
        }
        ac.push(localMatrix(p,p.width*.35,y-.5,front+.18,.8,.5,.38));
        vents.push(localMatrix(p,p.width*.35,y-.5,front+.39,.6,.28,.015));
      }
    }
    batch(boxGeometry,plaster,ac,details);batch(boxGeometry,metal,vents,details,false);
    batch(boxGeometry,trim,balconies,details);batch(boxGeometry,metal,rails,details);
    batch(boxGeometry,plaster,roofs,details);batch(boxGeometry,trim,tankBases,details);
    batch(new THREE.CylinderGeometry(.5,.5,1,10),material(0x69716e),tanks,details);
    batch(boxGeometry,metal,antennas,details,false);
    batch(new THREE.SphereGeometry(1,8,4,0,Math.PI*2,0,Math.PI/2),material(0xb7beb9),dishes,details,false);
  }
  function drawBackground() {
    background.clear();const random=randomFor(421),placements=[];
    for(let side=0;side<4;side++)for(let n=-extent-40;n<=extent+40;n+=16) {
      const distance=extent+35+random()*22,height=12+random()*31;
      placements.push(matrix(side<2?(side===0?-distance:distance):n,height/2,side<2?n:(side===2?-distance:distance),10+random()*7,height,10+random()*7));
    }
    const mesh=batch(boxGeometry,plaster,placements,background,false);
    placements.forEach((_,i)=>mesh.setColorAt(i,new THREE.Color([0xc8bca8,0xb9a992,0xe0cdb0,0xb7b3a8][i%4])));
  }
  function build(roads,newExtent) {
    extent=newExtent;
    for(const collider of colliders){root.remove(collider);const index=obstacles.indexOf(collider);if(index>=0)obstacles.splice(index,1);}
    colliders.length=0;
    parcels=createParcels(roads,extent);
    parcels.filter(p=>!p.parking).forEach(p=>addCollider(p.x,p.z,p.width,p.depth,p.height,p.yaw));
    drawBuildings();drawFacades();drawBackground();shopfronts.build(parcels.filter(p=>!p.parking));props.build(parcels);
  }
  Promise.all(BUILDINGS.map(name=>loadVisual(`buildings/${name}.glb`))).then(loaded=>{models.push(...loaded.map(g=>g.scene));drawBuildings();}).catch(error=>console.warn('Facade assets unavailable.',error));
  Promise.all(['low-detail-building-a','low-detail-building-c','low-detail-building-wide-a'].map(name=>loadVisual(`buildings/${name}.glb`))).then(loaded=>{farModels.push(...loaded.map(g=>g.scene));drawBuildings();}).catch(error=>console.warn('Distant facade assets unavailable.',error));
  return {build};
}
