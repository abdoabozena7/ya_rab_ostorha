import * as THREE from "three";

const colors = { giant: 0xffc45b, ghost: 0x7ce9e3, mine: 0xff9fbe, pulse: 0x8db6ff };
const reduced = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
const pose = new THREE.Object3D();
const tint = new THREE.Color();
const band = new THREE.Vector3();

export function createSurvivalEffects(parent) {
  const layer = new THREE.Group();
  layer.name = "city-pursuit-effects";
  parent.add(layer);
  const batches = [];
  function batch(geometry, material, count, name) {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    layer.add(mesh);
    batches.push(mesh);
    return mesh;
  }
  const marker = batch(new THREE.OctahedronGeometry(1), new THREE.MeshBasicMaterial({ toneMapped: false }), 12, "city-pickups-and-charges");
  const ring = batch(new THREE.RingGeometry(.78, 1, 28).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }), 18, "city-power-rings");
  const smoke = batch(new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: .74, depthWrite: false, toneMapped: false }),
    175, "city-wreck-smoke");
  const spark = batch(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ toneMapped: false }), 200, "city-contact-sparks");
  const track = batch(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
      transparent: true, opacity: .43 }), 176, "city-skid-marks");
  let state = null, lastTick = -1, last = null;
  const marks = [], ghostMaterials = new Map();
  function put(mesh, x, y, z, w, h, l, yaw, color) {
    if (mesh.count === mesh.instanceMatrix.count) return;
    pose.position.set(x, y, z);
    pose.rotation.set(0, yaw, 0);
    pose.scale.set(w, h, l);
    pose.updateMatrix();
    const i = mesh.count++;
    mesh.setMatrixAt(i, pose.matrix);
    mesh.setColorAt(i, tint.setHex(color));
  }
  function appearance(root, world) {
    const survival = world.pursuit?.survival, active = survival?.active?.kind;
    root.scale.setScalar(active === "giant" ? world.player.width / survival.footprint.width : 1);
    if (active === "ghost" && ghostMaterials.size === 0) {
      root.traverse(node => {
        if (!node.isMesh || !node.material) return;
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          if (ghostMaterials.has(material)) continue;
          ghostMaterials.set(material, [material.opacity, material.transparent, material.depthWrite]);
          material.opacity *= .47;
          material.transparent = true;
          material.depthWrite = false;
          material.needsUpdate = true;
        }
      });
    } else if (active !== "ghost" && ghostMaterials.size) restoreGhost();
  }
  function restoreGhost() {
    for (const [material, [opacity, transparent, depthWrite]] of ghostMaterials) {
      Object.assign(material, { opacity, transparent, depthWrite });
      material.needsUpdate = true;
    }
    ghostMaterials.clear();
  }
  function update(world) {
    const { pursuit, tick, player } = world, a = pursuit?.survival;
    layer.visible = Boolean(a && (pursuit.phase === "running" || pursuit.reviewUntilTick));
    if (state !== a || !layer.visible) {
      state = a;
      marks.length = 0;
      last = null;
      lastTick = -1;
    }
    if (!layer.visible) return;
    const calm = reduced?.matches, time = tick / 60;
    for (const mesh of batches) mesh.count = 0;
    if (tick !== lastTick) {
      lastTick = tick;
      const { x, z, arcadeSlip } = player;
      if (pursuit.phase === "running" && Math.abs(arcadeSlip) > .073 && player.speed > 5) {
        if (last) {
          const length = Math.hypot(x - last.x, z - last.z);
          if (length < 1.7 && length > .08) marks.push({ x: (x + last.x) / 2, z: (z + last.z) / 2,
            yaw: Math.atan2(x - last.x, z - last.z), length, tick });
        }
        last = { x, z };
      } else last = null;
      while (marks.length > 86 || (marks[0] && marks[0].tick < tick - 220)) marks.shift();
    }
    for (const mark of marks) {
      band.set(Math.cos(mark.yaw), 0, -Math.sin(mark.yaw));
      for (const offset of [-.67, .67]) put(track, mark.x + band.x * offset, .136, mark.z + band.z * offset,
        .18, 1, mark.length + .17, mark.yaw, 0x272d2c);
    }
    const p = a.pickup;
    if (p) {
      const y = 1.16 + (calm ? 0 : Math.sin(time * 4.5) * .19);
      put(ring, p.x, .17, p.z, 1.34, 1, 1.34, 0, colors[p.kind]);
      put(marker, p.x, y, p.z, .63, .76, .63, calm ? .66 : time * 2.4, colors[p.kind]);
      put(spark, p.x, y + .81, p.z, .24, .26, .24, Math.PI / 4, 0xfff0cc);
    }
    for (const d of a.devices) {
      const pulse = d.kind === "pulse";
      put(marker, d.x, .47, d.z, .39, .32, pulse ? 1.23 : .39, d.heading, colors[d.kind]);
      if (pulse || tick >= d.armedAt)
        put(ring, d.x, .16, d.z, .7, 1, .7, 0, colors[d.kind]);
    }
    if (a.active) put(ring, player.x, .154, player.z, a.active.kind === "ghost" ? 1.95 : 2.46,
      1, player.length * .63, player.heading, colors[a.active.kind]);
    for (const event of a.effects) {
      const age = (tick - event.tick) / 60;
      if (event.type === "pickup" && age < .24)
        put(ring, event.x, .157, event.z, 1.6 + age * 6, 1, 1.6 + age * 6, 0, colors[event.kind]);
      if (age > 1.3 || !["wreck", "impact", "burst"].includes(event.type)) continue;
      if (event.kind === "pedestrian-impact") continue;
      for (let i = 0; i < (calm ? 4 : 9); i++) {
        const yaw = i * 2.399 + event.id * .61;
        const spread = age * (2.1 + (i % 5) * 1.4);
        const dx = Math.sin(yaw) * spread, dz = Math.cos(yaw) * spread;
        const size = .25 + age * .82;
        if (age < .31) {
          const width = .24 - age * .37;
          put(spark, event.x + dx, .53 + age * (8.5 - 9 * age), event.z + dz,
            width, width, width * 2.64, yaw, colors[event.kind] ?? (i % 3 ? 0xffac55 : 0xffe6aa));
        }
        if (i % 2 === 0 && age >= .08)
          put(smoke, event.x + dx * .43 + age * .7, .62 + age * (2.6 + i * .04), event.z + dz * .43,
            size * 1.3, size, size * 1.18, yaw, i % 4 ? 0x727d78 : 0x4b5553);
      }
    }
    for (const mesh of batches) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
  return {
    appearance, update,
    dispose() {
      restoreGhost();
      for (const mesh of batches) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh.dispose();
      }
      layer.removeFromParent().clear();
    },
  };
}
