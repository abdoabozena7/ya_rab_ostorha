import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.152/examples/jsm/loaders/GLTFLoader.js';

// Keep mounts on the car root, separate from the imported visual. Swapping or
// editing the GLB will not move the simulated camera or change sensor origins.
export async function loadCarModel(THREE, car, fallback) {
  const cameraMount = new THREE.Group();
  cameraMount.name = 'front-camera-mount';
  cameraMount.position.set(0, 1.25, 1.15);
  car.add(cameraMount);

  try {
    const gltf = await new GLTFLoader().loadAsync('/assets/models/vehicles/sedan.glb');
    const visual = gltf.scene;
    visual.name = 'replaceable-car-visual';
    // Kenney vehicles use Y-up, with their front pointing toward +Z.
    visual.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(visual);
    const size = box.getSize(new THREE.Vector3());
    if (!Number.isFinite(size.x) || !size.x || !size.z) throw new Error('Invalid car model bounds');
    const scale = Math.min(2.2 / size.x, 4.2 / size.z);
    visual.scale.setScalar(scale);
    visual.updateMatrixWorld(true);
    const fitted = new THREE.Box3().setFromObject(visual);
    const center = fitted.getCenter(new THREE.Vector3());
    visual.position.set(-center.x, -0.48 - fitted.min.y, -center.z);
    visual.traverse((part) => { if (part.isMesh) part.castShadow = true; });
    car.add(visual);
    fallback.visible = false;
    return { cameraMount, visual };
  } catch (error) {
    console.warn('Car GLB unavailable; using the built-in visual.', error);
    return { cameraMount, visual: fallback };
  }
}
