import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.152/examples/jsm/loaders/GLTFLoader.js';
import { roadLayout, isOnRoad } from '../simulation/road-lanes.js';

export function createCity(THREE, scene, obstacles, {initTraffic,createPetrolBunks,createTrafficLights}) {
  const roadNodes = [];
  const roadGroup = new THREE.Group();
  const scenery = new THREE.Group();
  scene.add(roadGroup, scenery);
  const buildingRecords = [];
  const buildingModels = [];
  let lampModel = null;
  let extent = 100;

  function road({axis, fixed, min, max, width, sideStreet}) {
    const vertical = axis === 'z';
    const length = max - min;
    const center = (min + max) / 2;
    const surface = new THREE.Mesh(
      new THREE.BoxGeometry(vertical ? width : length, 0.14, vertical ? length : width),
      new THREE.MeshPhongMaterial({color:sideStreet ? 0x353432 : 0x302f30})
    );
    surface.position.set(vertical ? fixed : center, 0, vertical ? center : fixed);
    surface.receiveShadow = true;
    roadGroup.add(surface);
    // Worn, intermittent markings make the minor streets visually different.
    if (!sideStreet) {
      const stripe = new THREE.MeshPhongMaterial({color:0xd7caa1});
      for (let n = min + 3; n < max - 3; n += 16) {
        const dash = new THREE.Mesh(new THREE.BoxGeometry(vertical ? 0.22 : 3.5, 0.02, vertical ? 3.5 : 0.22), stripe);
        dash.position.set(vertical ? fixed : n, 0.09, vertical ? n : fixed);
        roadGroup.add(dash);
      }
    }
    for (let n = min; n <= max; n += 10) {
      roadNodes.push(vertical ? {x:fixed,z:n} : {x:n,z:fixed});
    }
  }

  function fitBuilding(record) {
    if (!buildingModels.length) return;
    const visual = buildingModels[record.variant % buildingModels.length].clone(true);
    const box = new THREE.Box3().setFromObject(visual);
    const size = box.getSize(new THREE.Vector3());
    const scale = record.size / Math.max(size.x, size.z);
    visual.scale.setScalar(scale);
    visual.position.y = -box.min.y * scale;
    visual.traverse(part => { if (part.isMesh) { part.castShadow = true; part.receiveShadow = true; } });
    record.root.clear();
    record.root.add(visual);
  }

  function building(x, z, size, variant) {
    const root = new THREE.Group();
    root.position.set(x, 0, z);
    const height = 9 + (variant % 5) * 2.7;
    const fallback = new THREE.Mesh(
      new THREE.BoxGeometry(size, height, size),
      new THREE.MeshPhongMaterial({color:[0x8e8a77,0xa98d78,0x9b9d8e,0x867c72][variant % 4]})
    );
    fallback.position.y = height / 2;
    root.add(fallback);
    scenery.add(root);
    obstacles.push(root);
    const record = {root, size, variant};
    buildingRecords.push(record);
    fitBuilding(record);
  }

  function lamp(x, z) {
    if (!lampModel) return;
    const light = lampModel.clone(true);
    light.scale.setScalar(9);
    light.position.set(x,0,z);
    scenery.add(light);
  }

  function buildCitySegment(offset) {
    extent = 100 + offset;
    for (const record of buildingRecords) {
      const index = obstacles.indexOf(record.root);
      if (index >= 0) obstacles.splice(index, 1);
    }
    buildingRecords.length = 0;
    roadGroup.clear();
    scenery.clear();
    roadNodes.length = 0;
    const layout = roadLayout(extent);
    layout.roads.forEach(road);

    // Irregular block widths create small alleys beside larger open blocks.
    for (let ix = 0; ix < layout.xs.length - 1; ix++) {
      for (let iz = 0; iz < layout.zs.length - 1; iz++) {
        const left = layout.xs[ix], right = layout.xs[ix + 1];
        const top = layout.zs[iz], bottom = layout.zs[iz + 1];
        const cx = (left + right) / 2, cz = (top + bottom) / 2;
        if (Math.abs(cx) < 22 && Math.abs(cz) < 22) continue;
        const span = Math.min(right - left, bottom - top);
        const crossedByAlley=layout.roads.some(road=>road.sideStreet&&(
          road.axis==='x' ? road.fixed>top&&road.fixed<bottom&&road.max>left&&road.min<right
            : road.fixed>left&&road.fixed<right&&road.max>top&&road.min<bottom));
        if (span < 18 || crossedByAlley || isOnRoad(cx, cz, extent, 6)) continue;
        const variant = (ix * 17 + iz * 7) % 11;
        const size = Math.min(12, span - 14);
        building(cx, cz, size, variant);
        if ((ix + iz) % 3 === 0) lamp(left + 6, (top + bottom) / 2);
      }
    }
    initTraffic();
    createPetrolBunks();
    createTrafficLights();
  }

  const loader = new GLTFLoader();
  Promise.all(['building-a','building-c','building-h','building-skyscraper-a'].map(name =>
    loader.loadAsync(`/assets/models/buildings/${name}.glb`)
  )).then(models => {
    buildingModels.push(...models.map(model => model.scene));
    buildingRecords.forEach(fitBuilding);
  }).catch(error => console.warn('Building models unavailable; using simple buildings.', error));
  loader.loadAsync('/assets/models/props/light-curved.glb').then(model => {
    lampModel = model.scene;
    buildCitySegment(extent - 100);
  }).catch(error => console.warn('Street lights unavailable.', error));

  return {roadNodes,buildCitySegment};
}
