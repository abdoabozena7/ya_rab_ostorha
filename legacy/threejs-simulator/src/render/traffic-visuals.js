import * as THREE from 'three';
import { loadVisual, fitVisual, mergeStaticVisual } from './visual-assets.js?v=drive-final';

const paint=['#c15640','#e5d9bd','#638679','#6a7f96','#b58e63','#d5b948'];
const recolored=new Map();
function preserveWheels(visual) {
  visual.updateMatrixWorld(true);
  const inverse=visual.matrixWorld.clone().invert(),nodes=[];
  visual.traverse(node=>{
    if(!node.name.toLowerCase().startsWith('wheel-'))return;
    let parent=node.parent;
    while(parent&&parent!==visual){if(parent.name.toLowerCase().startsWith('wheel-'))return;parent=parent.parent;}
    nodes.push(node);
  });
  const root=new THREE.Group();
  for(const node of nodes) {
    const bounds=new THREE.Box3().setFromObject(node),center=bounds.getCenter(new THREE.Vector3()).applyMatrix4(inverse);
    const size=bounds.getSize(new THREE.Vector3());
    const pivot=new THREE.Group(),spin=new THREE.Group(),copy=node.clone(true);
    pivot.name=`wheel-pivot-${node.name}`;spin.name='wheel-spin';pivot.position.copy(center);
    pivot.userData.wheel={radiusM:Math.max(size.y,size.z)/2,front:node.name.includes('front')};
    copy.matrix.copy(new THREE.Matrix4().makeTranslation(-center.x,-center.y,-center.z)
      .multiply(inverse).multiply(node.matrixWorld));copy.matrixAutoUpdate=false;
    spin.add(copy);pivot.add(spin);root.add(pivot);
    const combined=mergeStaticVisual(spin);spin.clear();spin.add(combined);
    node.removeFromParent();
  }
  root.add(mergeStaticVisual(visual));root.userData={...visual.userData};return root;
}
function paletteMaterial(source,variant,type) {
  const key=`${source.map?.image?.src||source.uuid}:${variant}:${type}`;
  if(recolored.has(key))return recolored.get(key);
  const mat=source.clone();mat.roughness=.48;mat.metalness=.08;
  if(source.map?.image) {
    const image=source.map.image,canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
    const tint=new THREE.Color(paint[variant%paint.length]).convertLinearToSRGB();
    for(let i=0;i<pixels.data.length;i+=4) {
      const [r,g,b]=pixels.data.slice(i,i+3);let color;
      if(b>200&&g>185&&r>130&&b>r*1.06)color=[45,66,77];
      else if(type==='microbus'&&b>130&&b>r*1.8&&g>70)color=[226,220,202];
      else if(type!=='microbus'&&r>130&&r>g*1.15&&g>35&&b<140)color=[tint.r*255,tint.g*255,tint.b*255];
      if(color)for(let c=0;c<3;c++)pixels.data[i+c]=color[c];
    }
    ctx.putImageData(pixels,0,0);mat.map=new THREE.CanvasTexture(canvas);mat.map.flipY=source.map.flipY;mat.map.colorSpace=THREE.SRGBColorSpace;
  }
  recolored.set(key,mat);return mat;
}

export async function loadTrafficVisuals() {
  const names=['sedan','sedan-sports','hatchback-sports','taxi','van','truck-flat','delivery','microbus','motorcycle'];
  const loaded=await Promise.all(names.map(name=>loadVisual(`vehicles/${name}.glb`)));
  const rider=(await loadVisual('pedestrians/character-d.glb')).scene;
  return names.map((name,index)=>{
    const visual=fitVisual(loaded[index].scene,name==='motorcycle'?.85:2.05,name==='motorcycle'?2.5:4.15);
    visual.traverse(part=>{if(part.isMesh){part.material=paletteMaterial(part.material,name==='taxi'?5:index,name);part.castShadow=true;}});
    if(name==='microbus') {
      const stripe=new THREE.Mesh(new THREE.BoxGeometry(2.06,.28,3.95),new THREE.MeshStandardMaterial({color:0x26799c,roughness:.55}));
      stripe.position.y=.57;visual.add(stripe);
      const canvas=document.createElement('canvas');canvas.width=256;canvas.height=64;
      const c=canvas.getContext('2d');c.fillStyle='#273c45';c.fillRect(0,0,256,64);c.fillStyle='#eee8d4';c.font='bold 34px Arial';c.textAlign='center';c.fillText('القاهرة',128,44);
      const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;
      const sign=new THREE.Mesh(new THREE.PlaneGeometry(.9,.23),new THREE.MeshStandardMaterial({map,roughness:.8}));
      sign.position.set(0,1.22,-2.065);sign.rotation.y=Math.PI;visual.add(sign);
    }
    if(name==='motorcycle') {
      const person=fitVisual(rider,1,1,1.5);
      person.traverse(node=>{if(node.name.startsWith('leg-'))node.rotation.x=-1.1;if(node.name.startsWith('arm-'))node.rotation.x=-.9;});
      person.position.set(0,.45,-.15);visual.add(person);
    }
    visual.userData.visualKind=name==='microbus'?'microbus':name==='motorcycle'?'motorcycle':name==='truck-flat'?'pickup':name==='delivery'?'van':name==='taxi'?'taxi':'car';
    return preserveWheels(visual);
  });
}

export function tukTukVisual(source) {
  const model=source.clone(true),materials=new Map();
  model.traverse(part=>{
    if(!part.isMesh)return;
    if(!materials.has(part.material.name)) {
      const mat=part.material.clone();mat.roughness=.65;
      if(mat.name==='teal')mat.color.setHex(0xe0b425);
      if(mat.name==='saffron')mat.color.setHex(0x2a3034);
      materials.set(part.material.name,mat);
    }
    part.material=materials.get(part.material.name);
  });
  return preserveWheels(model);
}
