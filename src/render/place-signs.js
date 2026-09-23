import { PLACES } from '../simulation/places.js';

export function addPlaceSigns(THREE, scene) {
  for (const place of PLACES) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    context.fillStyle = '#063b4a';
    context.fillRect(0, 0, 512, 128);
    context.strokeStyle = '#e4bc5a';
    context.lineWidth = 10;
    context.strokeRect(5, 5, 502, 118);
    context.direction = 'rtl';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#ffffff';
    context.font = 'bold 58px Arial, sans-serif';
    context.fillText(place.name, 256, 68);
    const texture = new THREE.CanvasTexture(canvas);
    const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
    sign.scale.set(10, 2.5, 1);
    sign.position.set(place.x + 7, 4.8, place.z);
    scene.add(sign);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4, 8),
      new THREE.MeshPhongMaterial({ color: 0x667780 }));
    pole.position.set(place.x + 7, 2, place.z);
    scene.add(pole);
  }
}
