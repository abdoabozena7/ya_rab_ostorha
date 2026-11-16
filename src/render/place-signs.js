import { PLACES } from "../core/places.js";

export function addPlaceSigns(THREE, scene, world) {
  const byId = new Map(PLACES.map((place) => [place.id, place]));
  for (const site of world.statics.filter(
    (item) => item.kind === "place-sign",
  )) {
    const place = byId.get(site.placeId);
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    context.fillStyle = "#063b4a";
    context.fillRect(0, 0, 512, 128);
    context.strokeStyle = "#e4bc5a";
    context.lineWidth = 10;
    context.strokeRect(5, 5, 502, 118);
    context.direction = "rtl";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#ffffff";
    context.font = "bold 58px Arial, sans-serif";
    context.fillText(place.name, 256, 68);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const group = new THREE.Group();
    group.position.set(site.x, 0, site.z);
    for (const facing of [site.facingY, site.facingY + Math.PI]) {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(5, 1.25), material);
      face.rotation.y = facing;
      face.position.set(0, 3.5, 0);
      face.userData.owned = true;
      group.add(face);
    }
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.14, 3.5, 8),
      new THREE.MeshStandardMaterial({ color: 0x667780, roughness: 0.8 }),
    );
    pole.position.y = 1.75;
    pole.userData.owned = true;
    group.add(pole);
    scene.add(group);
  }
}
