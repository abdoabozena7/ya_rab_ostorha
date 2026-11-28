import * as THREE from "three";
import { CITY_PROP_PROFILE, cityPropVisualState } from "../core/city-props.js";

function createTreeCrownGeometry() {
  const segments = 10;
  // Coordinates are relative to the upper trunk's existing impact pivot.
  const rings = [
    [1.84, .69, 0, -.025, .13],
    [2.29, 1.10, .10, .018, .42],
    [2.91, .77, -.08, .10, .73],
  ];
  const positions = [], colors = [], indices = [];
  const shade = new THREE.Color(0x354532), tip = new THREE.Color(0x748452);
  const color = new THREE.Color();
  const vertex = (x, y, z, tone) => {
    positions.push(x, y, z);
    color.copy(shade).lerp(tip, tone);
    colors.push(color.r, color.g, color.b);
  };
  vertex(0, 1.67, 0, 0);
  for (const [height, radius, phase, lean, tone] of rings) {
    for (let i = 0; i < segments; i++) {
      const angle = i * (2 * Math.PI / segments) + phase;
      const lobe = Math.cos(3 * angle + .65);
      const r = radius * (1 + .076 * lobe + .031 * Math.sin(2 * angle - .8));
      const y = height + .04 * Math.cos(2 * angle + .3) + .022 * lobe;
      const mottling = .075 * Math.sin(3 * angle + 6 * height) + .035 * Math.cos(4 * angle);
      vertex(lean + r * Math.cos(angle), y, r * Math.sin(angle), tone + mottling);
    }
  }
  const top = 1 + rings.length * segments;
  vertex(.12, 3.17, -.04, 1);
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    indices.push(0, 1 + i, 1 + next);
    for (let r = 0; r < rings.length - 1; r++) {
      const row = 1 + r * segments;
      indices.push(row + i, row + i + segments, row + next,
        row + next, row + i + segments, row + next + segments);
    }
    indices.push(top, top - segments + next, top - segments + i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function treeCrownSeed(id) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  return (hash ^ (hash >>> 15)) >>> 0;
}

/** Render residency never adds/removes physical props. All hulls stay in World. */
export function createCityPropsView(scene, world) {
  const root = new THREE.Group();
  root.name = "city-solid-reactive-props";
  scene.add(root);
  const geometries = new Set(), materials = new Set(), residents = new Map(), batches = new Map();
  const material = color => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: .93, flatShading: true });
    materials.add(m);
    return m;
  };
  const bark = material(0x564333), leaf = material(0x34432d), stone = material(0x7d7566);
  const timber = material(0x916c45), canvas = material(0x783228), dark = material(0x353d3c);
  const foliage = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .93 });
  materials.add(foliage);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 7);
  const crown = createTreeCrownGeometry();
  [box, cylinder, crown].forEach(g => geometries.add(g));
  const add = (parent, geometry, mat, x, y, z, width, height, length) => {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(width, height, length);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const build = site => {
    const group = new THREE.Group(), moving = new THREE.Group();
    group.name = site.id;
    group.userData.staticId = site.id;
    group.userData.cityProp = true;
    group.position.set(site.x, site.kind === "city-tree" ? site.y : .12 + (world.terrainElevationAt?.(site.x, site.z) ?? 0), site.z);
    if (site.kind === "city-tree") {
      const s = site.scale;
      add(group, box, stone, 0, .045 * s, 0, 1.12 * s, .09 * s, 1.12 * s);
      add(group, cylinder, bark, 0, 1.175 * s, 0, .205 * s, 2.35 * s, .205 * s);
      moving.position.y = 2.35 * s;
      add(moving, cylinder, bark, 0, s, 0, .142 * s, 2 * s, .142 * s);
      const seed = treeCrownSeed(site.id);
      const squash = .84 + .14 * (seed & 0xff) / 0xff;
      add(moving, crown, foliage, 0, 0, 0, s, s, s * squash).rotation.y =
        (seed >>> 8) * (2 * Math.PI / 0x1000000);
    } else {
      // The fixed solid counter remains full footprint even after its roof crumples.
      group.rotation.y = site.heading ?? 0;
      add(group, box, timber, 0, .45, 0, site.width, .9, site.length);
      moving.position.y = .9;
      const upper = Math.max(.25, site.height - .9);
      for (const x of [-1, 1]) for (const z of [-1, 1])
        add(moving, box, dark, x * (site.width / 2 - .055), upper / 2, z * (site.length / 2 - .055), .11, upper, .11);
      add(moving, box, canvas, 0, upper - .08, 0, site.width, .16, site.length);
      for (let i = 0; i < 5; i++)
        add(moving, box, leaf, (i - 2) * site.width / 6, .08, 0, site.width / 7, .16, site.length * .65);
    }
    group.add(moving);
    const meshes = [];
    group.traverse(part => { if (part.isMesh) meshes.push(part); });
    group.visible = false;
    root.add(group);
    return { group, moving, meshes, site, state: null };
  };
  let sites = [], statics = null;
  const update = (anchors = [world.player]) => {
    if (world.config?.cityPropProfile !== CITY_PROP_PROFILE) return;
    let dirty = false;
    if (statics !== world.statics) {
      statics = world.statics;
      // Lamp posts and bollards are drawn by the street-surface view; they only need physics here.
      sites = statics.filter(s => s.propImpact && (s.kind === "city-tree" || s.kind === "market-stall"));
    }
    const wanted = new Set();
    for (const site of sites) {
      const reach = residents.has(site.id) ? 205 : 180;
      if (!anchors.some(a => a && (a.x - site.x) ** 2 + (a.z - site.z) ** 2 <= reach * reach)) continue;
      wanted.add(site.id);
      let visual = residents.get(site.id);
      if (visual && visual.site !== site) {
        visual.group.removeFromParent();
        residents.delete(site.id);
        visual = null;
      }
      if (!visual) { visual = build(site); residents.set(site.id, visual); }
      const state = cityPropVisualState(world, site);
      const previous = visual.state;
      if (previous && state.damage === previous.damage &&
          state.bendX === previous.bendX && state.bendZ === previous.bendZ &&
          state.crush === previous.crush) continue;
      dirty = true;
      visual.state = state;
      visual.moving.rotation.set(state.bendX, 0, state.bendZ);
      visual.moving.scale.y = 1 - state.crush;
      visual.group.userData.impactDamage = state.damage;
      visual.group.updateMatrix();
      visual.group.updateMatrixWorld(true);
    }
    for (const [id, visual] of residents)
      if (!wanted.has(id)) {
        visual.group.removeFromParent();
        residents.delete(id);
        dirty = true;
      }
    if (!dirty) return;
    for (const batch of batches.values()) batch.count = 0;
    for (const visual of residents.values()) {
      for (const part of visual.meshes) {
        const key = `${part.geometry.uuid}:${part.material.uuid}`;
        let batch = batches.get(key);
        if (!batch) {
          batch = new THREE.InstancedMesh(part.geometry, part.material, Math.max(16, sites.length * 5));
          batch.name = `city-prop-batch-${batches.size}`;
          batch.count = 0;
          batch.frustumCulled = false;
          batch.castShadow = batch.receiveShadow = true;
          batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          batches.set(key, batch);
          root.add(batch);
        }
        batch.setMatrixAt(batch.count++, part.matrixWorld);
      }
    }
    for (const batch of batches.values()) {
      if (batch.count === 0) continue;
      batch.instanceMatrix.updateRange.offset = 0;
      batch.instanceMatrix.updateRange.count = batch.count * 16;
      batch.instanceMatrix.needsUpdate = true;
    }
  };
  return {
    root, update,
    diagnostics: () => ({ registered: sites.length, resident: residents.size, drawCalls: batches.size,
      impacts: sites.filter(s => s.propImpact.hits > 0).map(s => ({ id: s.id, ...s.propImpact })) }),
    dispose() {
      root.removeFromParent(); root.clear(); residents.clear();
      for (const batch of batches.values()) batch.dispose();
      batches.clear();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
