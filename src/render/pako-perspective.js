import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { createSuvModel } from "./suv-model.js";
import { MetroSilhouettes } from "./world-view.js";

const colors = { escaped: 0x77dfb1, busted: 0xeab372, wrecked: 0xe9917e, timeout: 0xa6c9e8 };
export const PERSPECTIVE_GHOST_CAP = 12;

function playbackSuv() {
  const { root, resources } = createSuvModel();
  root.updateMatrixWorld(true);
  const pieces = [];
  root.traverseVisible(part => {
    if (!part.isMesh || !part.geometry?.attributes.position ||
        /interior|seat|dashboard|sensor|telemetry|pedal|label/.test(part.name)) return;
    const mesh = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
    mesh.applyMatrix4(part.matrixWorld);
    for (const name of Object.keys(mesh.attributes)) if (name !== "position") mesh.deleteAttribute(name);
    const color = part.material.color ?? new THREE.Color(0x909b9c);
    const shading = Math.min(1, .42 + color.getHSL({}).l * .72);
    const values = new Float32Array(mesh.attributes.position.count * 3);
    values.fill(shading);
    mesh.setAttribute("color", new THREE.BufferAttribute(values, 3));
    pieces.push(mesh);
  });
  const result = mergeGeometries(pieces);
  for (const piece of pieces) piece.dispose();
  for (const collection of Object.values(resources)) for (const resource of collection) resource.dispose();
  return result;
}

export function createPakoPerspective() {
  const camera = new THREE.PerspectiveCamera(62, 1, .2, 430);
  const ghosts = new THREE.Group();
  const trace = new THREE.Group();
  const surroundings = new MetroSilhouettes(ghosts, { markPatrols: true });
  const lookAt = new THREE.Vector3(), behind = new THREE.Vector3();
  ghosts.name = "pako-recorded-ghosts";
  ghosts.add(trace);
  let geometry, previousKey = "", previousView, previousWidth, previousHeight;
  const meshes = [];
  function draw(renderer, city, preview, width, height) {
    const { items, focused, actorFrame } = preview;
    if (!geometry) geometry = playbackSuv();
    while (meshes.length < items.length) {
      const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
      const mesh = new THREE.Mesh(geometry, material);
      meshes.push(mesh);
      ghosts.add(mesh);
    }
    const elevAt = city.world?.terrainElevationAt;
    const selected = [];
    for (const [i, mesh] of meshes.entries()) {
      const entry = items[i];
      mesh.visible = Boolean(entry);
      if (!entry) continue;
      const [, x, z, , heading] = entry.pose;
      const elev = elevAt ? elevAt(x, z) : 0;
      mesh.position.set(x, .12 + elev + (actorFrame?.rise ?? 0), z);
      mesh.rotation.y = heading;
      mesh.material.color.setHex(colors[entry.phase] ?? 0xd1d6da);
      mesh.material.opacity = focused ? 1 : .29;
      if (mesh.material.depthWrite !== focused) {
        mesh.material.depthWrite = focused;
        mesh.material.transparent = !focused;
        mesh.material.needsUpdate = true;
      }
      selected.push({ id: entry.id, x, z, heading });
    }
    const key = items.map(entry => entry.id).join("|");
    if (previousKey !== key) {
      while (trace.children.length) {
        const line = trace.children[0];
        trace.remove(line);
        line.geometry.dispose();
        line.material.dispose();
      }
      for (const entry of items) {
        const points = entry.trajectory.map(([, x, z]) =>
          new THREE.Vector3(x, .135 + (elevAt ? elevAt(x, z) : 0), z));
        trace.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({ color: colors[entry.phase] ?? 0xd1d6da, transparent: true, opacity: .76 })));
      }
      previousKey = key;
    }
    surroundings.begin();
    const recordedActors = actorFrame && { pedestrians: 0, patrols: 0, traffic: 0, examples: {} };
    if (actorFrame) for (const actor of actorFrame.actors) {
      const { x, z, heading } = actor;
      const person = actor.type === "pedestrian";
      const group = person ? "pedestrians" : actor.pursuitRole === "police" ? "patrols" : "traffic";
      const vElev = !person && elevAt ? elevAt(x, z) : 0;
      surroundings.put(actor, x, person ? city.metroGroundHeight(x, z) : .12 + vElev + (actor.y ?? 0), z, heading);
      recordedActors[group]++;
      recordedActors.examples[group] ??= { id: actor.id, x, z };
    }
    surroundings.end();
    const lead = meshes[0].position, heading = items[0].pose[4];
    behind.set(Math.sin(heading), 0, Math.cos(heading));
    lookAt.copy(lead).addScaledVector(behind, 4.4);
    lookAt.y += .85;
    if (width !== previousWidth || height !== previousHeight) {
      previousWidth = width;
      previousHeight = height;
      camera.aspect = width / height;
      // Keep the replay car above the bottom-docked Lab panel on narrow screens.
      if (width <= 650) camera.setViewOffset(width, height, 0, .18 * height, width, height);
      else camera.clearViewOffset();
    }
    camera.position.copy(lead).addScaledVector(behind, -13);
    camera.position.x += behind.z * 4.2;
    camera.position.z -= behind.x * 4.2;
    camera.position.y += 6.8;
    camera.lookAt(lookAt);
    city.egyptStreets.updateResidency?.([camera.position, lead], lookAt);
    if (previousView !== city) {
      renderer.shadowMap.needsUpdate = true;
      previousView = city;
    }
    const hidden = city.scene.children.filter(root => root.visible && !city.metroPlaybackBackdrop.has(root));
    for (const root of hidden) root.visible = false;
    const surfFx = city.streetSurfaces?.fxGroup;
    const surfFxVis = surfFx?.visible;
    if (surfFx) surfFx.visible = false;
    city.scene.add(ghosts);
    ghosts.updateMatrixWorld(true);
    try {
      renderer.render(city.scene, camera);
    } finally {
      city.scene.remove(ghosts);
      if (surfFx) surfFx.visible = surfFxVis;
      for (const root of hidden) root.visible = true;
    }
    return { source: "recorded Metro playback", tick: preview.tick, count: selected.length, selected,
      ...(recordedActors && { recordedActors }) };
  }
  return { draw };
}
