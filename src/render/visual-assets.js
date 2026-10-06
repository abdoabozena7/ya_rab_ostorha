import * as THREE from 'three';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.152/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'https://cdn.jsdelivr.net/npm/three@0.152/examples/jsm/utils/BufferGeometryUtils.js';
export { randomFor } from './city-layout.js?v=drive-final';

// A small shared cache for the polish assets. Existing simulation APIs stay intact.
const loader = new GLTFLoader();
const cache = new Map();
export function loadVisual(path) {
  if (!cache.has(path)) cache.set(path, loader.loadAsync(`/assets/models/${path}`));
  return cache.get(path);
}

export function fitVisual(template, width, length, height) {
  const root=new THREE.Group(), model=template.clone(true);
  model.updateMatrixWorld(true);
  const bounds=new THREE.Box3().setFromObject(model), size=bounds.getSize(new THREE.Vector3());
  const scale=height ? height/size.y : Math.min(width/size.x,length/size.z);
  model.scale.setScalar(scale);
  const center=bounds.getCenter(new THREE.Vector3());
  model.position.set(-center.x*scale,-bounds.min.y*scale,-center.z*scale);
  root.add(model);
  return root;
}

// NPC vehicles and repeated scenery have no animated parts. Bake their node
// transforms and combine meshes sharing a material; retain the original GLBs.
export function mergeStaticVisual(template) {
  const groups=new Map(),root=new THREE.Group();template.updateMatrixWorld(true);
  template.traverse(part=>{
    if(!part.isMesh||Array.isArray(part.material))return;
    const key=part.material.uuid;
    if(!groups.has(key))groups.set(key,{material:part.material,geometry:[]});
    const geometry=part.geometry.clone();
    // Quantized GLBs store normalized integers. Decode before baking transforms
    // so coordinates beyond [-1,1] are not clamped or wrapped by typed arrays.
    for(const [name,attribute] of Object.entries(geometry.attributes))if(attribute.normalized) {
      const values=new Float32Array(attribute.count*attribute.itemSize),getters=['getX','getY','getZ','getW'];
      for(let i=0;i<attribute.count;i++)for(let c=0;c<attribute.itemSize;c++)values[i*attribute.itemSize+c]=attribute[getters[c]](i);
      geometry.setAttribute(name,new THREE.BufferAttribute(values,attribute.itemSize));
    }
    geometry.applyMatrix4(part.matrixWorld);
    groups.get(key).geometry.push(geometry);
  });
  groups.forEach(({material,geometry})=>{
    if(geometry.some(g=>!g.index))geometry=geometry.map(g=>g.index?g.toNonIndexed():g);
    const shared=Object.keys(geometry[0].attributes).filter(name=>geometry.every(g=>g.attributes[name]));
    geometry.forEach(g=>Object.keys(g.attributes).filter(name=>!shared.includes(name)).forEach(name=>g.deleteAttribute(name)));
    const mesh=new THREE.Mesh(mergeGeometries(geometry),material);mesh.castShadow=true;root.add(mesh);
    geometry.forEach(g=>g.dispose());
  });
  root.userData={...template.userData};return root;
}

// Flatten repeated external GLBs into one instanced draw per original mesh.
// Each placement is a world-space matrix; geometry/materials stay shared.
export function instanceVisual(template, matrices, parent, {shadow=false,maxDistance=90,minDistance=0}={}) {
  if(!matrices.length)return [];
  template=mergeStaticVisual(template);
  template.updateMatrixWorld(true);
  const placed=[];
  template.traverse(part=>{
    if(!part.isMesh) return;
    const mesh=new THREE.InstancedMesh(part.geometry,part.material,matrices.length);
    const matrix=new THREE.Matrix4();
    matrices.forEach((world,index)=>mesh.setMatrixAt(index,matrix.multiplyMatrices(world,part.matrixWorld)));
    mesh.castShadow=shadow; mesh.receiveShadow=true;
    mesh.userData.lod={matrices,maxDistance,minDistance};
    parent.add(mesh); placed.push(mesh);
  });
  return placed;
}

export function updateVisualLOD(scene,position) {
  const cell=`${Math.floor(position.x/3)},${Math.floor(position.z/3)}`;
  scene.traverse(mesh=>{
    const lod=mesh.userData.lod;
    if(!lod||lod.cell===cell)return;
    lod.cell=cell;let count=0;
    for(const matrix of lod.matrices) {
      const distance=Math.hypot(matrix.elements[12]-position.x,matrix.elements[14]-position.z);
      if(distance<=lod.maxDistance&&distance>lod.minDistance)mesh.setMatrixAt(count++,matrix);
    }
    mesh.count=count;mesh.visible=count>0;mesh.instanceMatrix.needsUpdate=true;
    mesh.computeBoundingSphere();
  });
}

const palettes=new Map();
export function facadeMaterial(source, variant) {
  const key=`${source.map?.image?.src||source.uuid}:${variant}`;
  if(palettes.has(key)) return palettes.get(key);
  const mat=source.clone(); mat.roughness=0.92; mat.metalness=0;
  if(source.map?.image) {
    const image=source.map.image, canvas=document.createElement('canvas');
    canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d');context.drawImage(image,0,0);
    const pixels=context.getImageData(0,0,canvas.width,canvas.height);
    const shades=[[203,174,132],[226,207,172],[192,145,108],[214,187,154],[182,172,153],[223,196,158]];
    const warm=shades[variant%shades.length];
    for(let i=0;i<pixels.data.length;i+=4) {
      const [r,g,b]=pixels.data.slice(i,i+3), v=(r+g+b)/3;
      if(r>130 && b>r*1.12 && b>g*1.06) {
        pixels.data[i]=49;pixels.data[i+1]=68;pixels.data[i+2]=76;
      } else if(v>40 && v<235) {
        const light=0.78+v/650;
        pixels.data[i]=Math.min(255,warm[0]*light);
        pixels.data[i+1]=Math.min(255,warm[1]*light);
        pixels.data[i+2]=Math.min(255,warm[2]*light);
      }
    }
    context.putImageData(pixels,0,0);
    mat.map=new THREE.CanvasTexture(canvas);mat.map.flipY=source.map.flipY;
    mat.map.colorSpace=THREE.SRGBColorSpace;mat.map.magFilter=THREE.NearestFilter;
  }
  palettes.set(key,mat);return mat;
}
