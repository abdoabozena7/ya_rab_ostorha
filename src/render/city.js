import { roadLayout } from '../simulation/road-lanes.js?v=drive-final';
import { randomFor } from './visual-assets.js?v=drive-final';
import { createStreetscape } from './streetscape.js?v=drive-final';
import { WORLD_EXTENT, CONDITION_ZONES } from '../simulation/road-conditions.js?v=drive-final';

export function createCity(THREE, scene, obstacles, {initTraffic,createPetrolBunks,createTrafficLights}) {
  const roadNodes = [];
  const roadGroup = new THREE.Group();
  scene.add(roadGroup);
  const markings=[];
  const streetscape=createStreetscape(scene,obstacles);

  let extent = 100;
  let roads = [];
  const asphalt = new THREE.MeshStandardMaterial({color:0x44464b, roughness:0.95});
  const sideAsphalt = new THREE.MeshStandardMaterial({color:0x505052, roughness:0.95});
  const paint = new THREE.MeshStandardMaterial({color:0xf1e7c9, roughness:1});
  const curbMaterial = new THREE.MeshStandardMaterial({color:0xd8c9ad, roughness:1});

  function road({axis, fixed, min, max, width, sideStreet, arterial}) {
    const vertical = axis === 'z';
    const length = max - min;
    const center = (min + max) / 2;
    const surface = new THREE.Mesh(
      new THREE.BoxGeometry(vertical ? width : length, 0.14, vertical ? length : width),
      sideStreet ? sideAsphalt : asphalt
    );
    // Tiny layer separation removes coplanar flicker at road intersections.
    surface.position.set(vertical ? fixed : center, vertical ? 0 : 0.004, vertical ? center : fixed);
    surface.receiveShadow = true;
    roadGroup.add(surface);
    // Worn, intermittent markings make the minor streets visually different.
    if (!sideStreet) {
      for (let n = min + 3; n < max - 3; n += 16) {
        if(roads.some(other=>other.axis!==axis && fixed>=other.min && fixed<=other.max && Math.abs(n-other.fixed)<other.width/2+2)) continue;
        markings.push(new THREE.Matrix4().compose(new THREE.Vector3(vertical?fixed:n,.09,vertical?n:fixed),new THREE.Quaternion(),new THREE.Vector3(vertical?.15:3.5,.02,vertical?3.5:.15)));
        if(arterial)for(const side of [-1,1])markings.push(new THREE.Matrix4().compose(
          new THREE.Vector3(vertical?fixed+side*3.5:n,.093,vertical?n:fixed+side*3.5),new THREE.Quaternion(),new THREE.Vector3(vertical?.11:3.5,.02,vertical?3.5:.11)));
      }
    }
    for (let n = min; n <= max; n += 10) {
      roadNodes.push(vertical ? {x:fixed,z:n} : {x:n,z:fixed});
    }
  }

  function addShoulders() {
    // A shared instanced strip marks each road edge, with gaps at junctions.
    const placements=[],edges=[];
    for(const road of roads) {
      for(let n=road.min+1;n<road.max;n+=2) for(const side of [-1,1]) {
        const lateral=road.fixed+side*(road.width/2+1.65);
        const x=road.axis==='z'?lateral:n, z=road.axis==='x'?lateral:n;
        if(roads.some(other=>other!==road && (other.axis==='z'
          ? Math.abs(x-other.fixed)<other.width/2+1.8 && z>=other.min-1 && z<=other.max+1
          : Math.abs(z-other.fixed)<other.width/2+1.8 && x>=other.min-1 && x<=other.max+1))) continue;
        placements.push({x,z,vertical:road.axis==='z'});
        edges.push({x:road.axis==='z'?road.fixed+side*(road.width/2+0.16):n,z:road.axis==='x'?road.fixed+side*(road.width/2+0.16):n,vertical:road.axis==='z'});
      }
    }
    const curb=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),curbMaterial,placements.length);
    const transform=new THREE.Matrix4();
    const compose=(point,sx,sy,sz)=>transform.compose(new THREE.Vector3(point.x,0.14,point.z),new THREE.Quaternion(),new THREE.Vector3(sx,sy,sz));
    placements.forEach((point,index)=>{curb.setMatrixAt(index,compose(point,point.vertical?3.1:1.96,0.22,point.vertical?1.96:3.1));curb.setColorAt(index,new THREE.Color(index%7===0?0xbeb09b:0xd2c1a7));});
    curb.receiveShadow=true;
    roadGroup.add(curb);
    const rim=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),curbMaterial,edges.length);
    edges.forEach((point,index)=>{rim.setMatrixAt(index,compose(point,point.vertical?0.32:1.97,0.25,point.vertical?1.97:0.32));rim.setColorAt(index,new THREE.Color(index%4<2?0xf0e9d9:0x595752));});
    rim.receiveShadow=true;roadGroup.add(rim);
  }

  function roadDetails() {
    const random=randomFor(42),patches=[],crossings=[];
    for(const route of roads) {
      for(let n=route.min+8;n<route.max-8;n+=19) {
        const lateral=(random()-.5)*(route.width-2);
        patches.push({x:route.axis==='z'?route.fixed+lateral:n,z:route.axis==='x'?route.fixed+lateral:n,w:0.5+random()*1.7,h:.6+random()*2.4});
      }
      if(route.axis!=='z'||route.sideStreet)continue;
      for(const other of roads.filter(r=>r.axis==='x'&&!r.sideStreet)) {
        if(route.fixed<other.min||route.fixed>other.max||other.fixed<route.min||other.fixed>route.max)continue;
        if(random()>.6)continue;
        for(const side of [-1,1])for(let x=-3.5;x<4;x+=1.1)crossings.push({x:route.fixed+x,z:other.fixed+side*(other.width/2+2)});
      }
    }
    const matrix=new THREE.Matrix4(),quaternion=new THREE.Quaternion();
    const patchesMesh=new THREE.InstancedMesh(new THREE.BoxGeometry(1,.008,1),new THREE.MeshStandardMaterial({color:0x383a3f,roughness:1}),patches.length);
    patches.forEach((p,i)=>patchesMesh.setMatrixAt(i,matrix.compose(new THREE.Vector3(p.x,.082,p.z),quaternion,new THREE.Vector3(p.w,1,p.h))));
    patchesMesh.receiveShadow=true;roadGroup.add(patchesMesh);
    const stripes=new THREE.InstancedMesh(new THREE.BoxGeometry(.65,.012,2.3),paint,crossings.length);
    crossings.forEach((p,i)=>stripes.setMatrixAt(i,matrix.makeTranslation(p.x,.094,p.z)));
    stripes.receiveShadow=true;roadGroup.add(stripes);
    const covers=new THREE.InstancedMesh(new THREE.CylinderGeometry(.36,.36,.013,12),new THREE.MeshStandardMaterial({color:0x30363b,roughness:.82,metalness:.25}),Math.ceil(patches.length/5));
    patches.filter((_,i)=>i%5===0).forEach((p,i)=>covers.setMatrixAt(i,matrix.makeTranslation(p.x,.096,p.z+2)));
    covers.receiveShadow=true;roadGroup.add(covers);
    // Surface patches share the same coordinates as the tyre/grip model.
    for(const zone of CONDITION_ZONES) {
      const wet=zone.type==='wet',stone=zone.type==='cobbles';
      const patch=new THREE.Mesh(new THREE.PlaneGeometry(zone.w,zone.l),
        new THREE.MeshStandardMaterial({color:wet?0x344e5c:stone?0x827b6d:zone.type==='gravel'?0x998771:0x555253,
          roughness:wet?.16:1,metalness:wet?.35:0}));
      patch.rotation.x=-Math.PI/2;patch.position.set(zone.x,.101,zone.z);patch.receiveShadow=true;roadGroup.add(patch);
      if(wet)continue;
      const count=stone?160:65,geometry=stone?new THREE.BoxGeometry(.48,.03,.35):new THREE.CircleGeometry(.4,7);
      const pieces=new THREE.InstancedMesh(geometry,new THREE.MeshStandardMaterial({color:stone?0x9a9281:0x302e2c,roughness:1}),count);
      for(let i=0;i<count;i++) {
        const matrix=new THREE.Matrix4().compose(new THREE.Vector3(zone.x+(random()-.5)*(zone.w-1),.12,zone.z+(random()-.5)*(zone.l-1)),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(stone?0:-Math.PI/2,0,random()*3)),new THREE.Vector3(1+random()*2,1,1));
        pieces.setMatrixAt(i,matrix);
      }
      roadGroup.add(pieces);
    }
  }

  function buildCitySegment(offset) {
    extent = WORLD_EXTENT + offset;
    roadGroup.clear();
    markings.length=0;
    roadNodes.length = 0;
    const layout = roadLayout(extent);
    roads=layout.roads;
    layout.roads.forEach(road);
    const lanes=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),paint,markings.length);
    markings.forEach((matrix,index)=>lanes.setMatrixAt(index,matrix));roadGroup.add(lanes);
    addShoulders();
    roadDetails();

    streetscape.build(roads,extent);
    initTraffic();
    createPetrolBunks();
    createTrafficLights();
  }

  return {roadNodes,buildCitySegment};
}
