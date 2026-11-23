import * as THREE from "three";
import { createSurvivalEffects } from "./pursuit-survival-effects.js";
import { roadRect } from "../core/geometry.js";

const ROAD_TOP = 0.115; // WorldView's shared asphalt surface.
const LIGHTBAR_HOLD_TICKS = 20; // At 60 Hz each lens pulses 1.5 times per second.
const BOUNCE_LIGHT_RANGE_M = 48;
const BOUNCE_LIGHT_HEIGHT_M = 2.35;
const finite = Number.isFinite;
const positive = (n) => finite(n) && n > 0;
const matte = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
const accent = (color) => new THREE.MeshBasicMaterial({ color });

function createRadialGlowTexture() {
  const size = 64;
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext?.("2d");
    if (ctx) {
      const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0.0, "rgba(255, 255, 255, 1.0)");
      grad.addColorStop(0.24, "rgba(255, 255, 255, 0.78)");
      grad.addColorStop(0.58, "rgba(255, 255, 255, 0.24)");
      grad.addColorStop(1.0, "rgba(255, 255, 255, 0.0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      return tex;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half;
      const alpha = r >= 1 ? 0 : Math.pow(1 - r * r, 2.2);
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(alpha * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

function doubleFlashEnvelope(u) {
  const pulse1 = Math.exp(-(((u - 0.18) / 0.14) ** 2));
  const pulse2 = Math.exp(-(((u - 0.64) / 0.15) ** 2));
  return Math.min(1, 0.36 + 0.68 * Math.max(pulse1, pulse2));
}

function bounceDistanceGain(distM) {
  if (!(distM < BOUNCE_LIGHT_RANGE_M)) return 0;
  if (distM <= 25) {
    const nearT = Math.max(0, distM / 25);
    return THREE.MathUtils.lerp(21.5, 14.5, nearT * nearT);
  }
  return 14.5 * (1 - THREE.MathUtils.smoothstep(distM, 25, BOUNCE_LIGHT_RANGE_M));
}

function patrolBank(id) {
  let parity = 0;
  for (const char of String(id)) parity ^= char.charCodeAt(0) & 1;
  return parity;
}

function reflectors() {
  const positions = [];
  for (const side of [-1, 1]) {
    for (let x = -0.43; x < 0.36; x += 0.18) {
      const z = side * 0.501;
      positions.push(
        x, -0.12, z, x + 0.09, -0.12, z, x + 0.15, 0.27, z,
        x, -0.12, z, x + 0.15, 0.27, z, x + 0.06, 0.27, z,
      );
    }
  }
  return new THREE.BufferGeometry().setAttribute(
    "position", new THREE.Float32BufferAttribute(positions, 3),
  );
}

function splitPaint(points, signedDistance) {
  const forward = [], back = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const da = signedDistance(a), db = signedDistance(b);
    (da >= 0 ? forward : back).push(a);
    if ((da >= 0) === (db >= 0)) continue;
    const t = da / (da - db);
    const seam = a.map((n, k) => THREE.MathUtils.lerp(n, b[k], t));
    forward.push(seam);
    back.push(seam);
  }
  return [forward, back];
}

function twoToneShell(source) {
  // The procedural traffic shell is a non-indexed, flat-normal color buffer.
  // Substitute a patrol-only buffer; the residency pool keeps its exact source.
  const { position, normal, color } = source.attributes;
  if (!position || !normal || !color || source.index || !source.boundingBox) return null;
  const { min, max } = source.boundingBox;
  const height = max.y - min.y, length = max.z - min.z;
  const centerZ = (max.z + min.z) / 2;
  let top = 0;
  while (top < position.count && (position.getY(top) <= max.y - 0.003 || normal.getY(top) <= 0.75)) top++;
  if (top === position.count || !positive(height) || !positive(length)) return null;
  const read = (attribute, i) => [attribute.getX(i), attribute.getY(i), attribute.getZ(i)];
  const base = read(color, top);
  const ink = new THREE.Color(0x263e49).toArray(), chalk = new THREE.Color(0xd8d7c6).toArray();
  const positions = [], normals = [], colors = [];
  const emit = (points, n, rgb) => {
    for (let i = 1; i < points.length - 1; i++)
      for (const point of [points[0], points[i], points[i + 1]]) {
        positions.push(...point);
        normals.push(...n);
        colors.push(...rgb);
      }
  };
  for (let i = 0; i < position.count; i += 3) {
    const points = [read(position, i), read(position, i + 1), read(position, i + 2)];
    const n = read(normal, i), rgb = read(color, i);
    if (!rgb.every((v, k) => v === base[k])) {
      emit(points, n, rgb); // Retain windows, running gear, handles, and lamps.
      continue;
    }
    const y = (points.reduce((sum, p) => sum + p[1], 0) / 3 - min.y) / height;
    if (y > 0.82 && n[1] > 0.45) {
      emit(points, n, chalk);
    } else if (y < 0.61 && Math.abs(n[0]) > 0.5) {
      // Angled lacquer seams stay on the original sheet metal, including its
      // shoulder bevel and cut wheel arches; no floating box over the doors.
      const z = p => (p[2] - centerZ) / length;
      const down = p => 0.55 - (p[1] - min.y) / height;
      const [inFront, front] = splitPaint(points, p => 0.22 - z(p) - 0.23 * down(p));
      const [door, quarter] = splitPaint(inFront, p => z(p) + 0.26 - 0.30 * down(p));
      emit(front, n, ink);
      emit(quarter, n, ink);
      emit(door, n, chalk);
    } else {
      emit(points, n, ink);
    }
  }
  return new THREE.BufferGeometry()
    .setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
    .setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3))
    .setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
}

function diffuserProfile() {
  const outline = new THREE.Shape();
  outline.moveTo(-0.49, -0.28);
  outline.lineTo(-0.41, -0.44);
  outline.lineTo(0.41, -0.44);
  outline.lineTo(0.49, -0.28);
  outline.lineTo(0.49, 0.28);
  outline.lineTo(0.41, 0.44);
  outline.lineTo(-0.41, 0.44);
  outline.lineTo(-0.49, 0.28);
  outline.closePath();
  const profile = new THREE.ExtrudeGeometry(outline, {
    depth: 0.62, bevelSize: 0.04, bevelThickness: 0.14, bevelSegments: 1, steps: 1,
  });
  profile.rotateX(-Math.PI / 2);
  profile.center();
  const { x, y, z } = profile.boundingBox.getSize(new THREE.Vector3());
  profile.scale(1 / x, 1 / y, 1 / z);
  return profile;
}

function fitPatrolKit(kit, source, actorRoot, actor, style) {
  actorRoot.updateWorldMatrix(true, true);
  const toLocal = actorRoot.matrixWorld.clone().invert();
  const bounds = new THREE.Box3();
  const pick = [];
  const painted = [];
  source.traverse((part) => {
    if (!part.isMesh || !part.visible) return;
    if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
    const matrix = new THREE.Matrix4().multiplyMatrices(toLocal, part.matrixWorld);
    bounds.union(part.geometry.boundingBox.clone().applyMatrix4(matrix));
    pick.push(part);
    if (part.material?.name === "paint") painted.push(part);
  });
  if (bounds.isEmpty()) return false;
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const width = Math.min(size.x, actor.width);
  const length = Math.min(size.z, actor.length);
  if (!positive(width) || !positive(length) || !positive(size.y)) return false;

  const rush = style === "rush", cinematic = style === "cinematic";
  const barWidth = width * 0.72;
  const barDepth = length * (cinematic ? 0.057 : rush ? 0.103 : 0.075);
  const barHeight = size.y * (cinematic ? 0.026 : 0.065);
  const lensHeight = size.y * (cinematic ? 0.047 : rush ? 0.126 : 0.09);
  const barZ = center.z - length * 0.055;
  kit.housing.scale.set(barWidth, barHeight, barDepth);
  kit.housing.position.set(center.x, bounds.max.y + barHeight * 0.5, barZ);
  for (let i = 0; i < kit.lenses.length; i++) {
    const lens = kit.lenses[i];
    lens.scale.set(barWidth * (rush || cinematic ? 0.44 : 0.395), lensHeight,
      barDepth * (cinematic ? 0.92 : rush ? 0.89 : 0.78));
    lens.position.set(center.x + (i ? 1 : -1) * barWidth * (cinematic ? 0.245 : rush ? 0.25 : 0.27),
      bounds.max.y + barHeight + lensHeight * 0.5, barZ);
  }

  if (kit.livery && !actor.unitType) {
    kit.stripe.visible = false;
    return true;
  }
  // Project the door stripe to the mounted mesh rather than inventing a box
  // outside its doors. Refit only when the real body replaces the fallback.
  const ray = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const stripe = [];
  const surface = (side, y, z) => {
    origin.set((side < 0 ? bounds.min.x : bounds.max.x) + 0.15 * side, y, z)
      .applyMatrix4(actorRoot.matrixWorld);
    direction.set(-side, 0, 0).transformDirection(actorRoot.matrixWorld);
    ray.set(origin, direction);
    const hit = ray.intersectObjects(painted.length ? painted : pick, false)[0];
    if (!hit) return null;
    const point = hit.point.applyMatrix4(toLocal);
    if ((point.x - center.x) * side < width * 0.3) return null;
    return [point.x + side * 0.014, point.y, point.z];
  };
  for (const side of [-1, 1]) {
    let previous;
    for (let i = 0; i <= 10; i++) {
      const z = center.z + (i / 10 - 0.5) * length * 0.54;
      const low = surface(side, bounds.min.y + size.y * 0.36, z);
      const high = surface(side, bounds.min.y + size.y * 0.445, z);
      if (previous && low && high) stripe.push(...previous[0], ...low, ...high,
        ...previous[0], ...high, ...previous[1]);
      previous = low && high ? [low, high] : null;
    }
  }
  kit.stripe.geometry.dispose();
  kit.stripe.geometry = new THREE.BufferGeometry().setAttribute(
    "position", new THREE.Float32BufferAttribute(stripe, 3),
  );
  kit.stripe.visible = stripe.length > 0;
  return true;
}

export function createPursuitView(scene, world) {
  const layer = new THREE.Group();
  layer.name = "pursuit-layer";
  scene.add(layer);
  let survivalEffects;

  const box = new THREE.BoxGeometry(1, 1, 1);
  const warningStripes = reflectors();
  const contactCircle = new THREE.RingGeometry(1.34, 1.44, 24);
  const paints = {
    casing: matte(0x2d3a40),
    coolLens: accent(0xa6d7f2),
    warmLens: accent(0xf18a71),
    trim: new THREE.MeshBasicMaterial({ color: 0xe7e6d8, side: THREE.DoubleSide }),
    shoulder: matte(0x98998a),
    closure: matte(0x8e552f),
    reflector: new THREE.MeshBasicMaterial({ color: 0xf3cb8b, side: THREE.DoubleSide }),
    contact: new THREE.MeshBasicMaterial({ color: 0xe89680, depthWrite: false }),
    gtaPatrol: matte(0xe4f0ff),
    gtaInterceptor: matte(0x58c9ff),
    gtaSwat: matte(0x82985a),
    gtaRoadblock: matte(0xf0af32),
    gtaWrecked: matte(0x302b28),
  };
  const patrols = new Map(), barriers = new Map(), shoulders = new Map(), activePolice = new Map();
  const patrolShells = new Map();
  const staticLenses = [paints.coolLens, paints.warmLens];
  const tiltEuler = new THREE.Euler(), tiltQuat = new THREE.Quaternion(), haloPos = new THREE.Vector3();
  const redBounceLight = new THREE.PointLight(0xff2442, 0, 26, 1.6);
  redBounceLight.name = "pursuit-bounce-red";
  redBounceLight.castShadow = false;
  const blueBounceLight = new THREE.PointLight(0x2484ff, 0, 26, 1.6);
  blueBounceLight.name = "pursuit-bounce-blue";
  blueBounceLight.castShadow = false;
  const haloGroup = new THREE.Group();
  haloGroup.name = "pursuit-lightbar-halos";
  layer.add(haloGroup);
  if (world?.player) {
    layer.add(redBounceLight, blueBounceLight);
  }
  let rushLenses, cinematicLenses, diffuser, glowTexture = null, lastActiveHalos = 0;
  function sharedGlowTexture() {
    return (glowTexture ??= createRadialGlowTexture());
  }
  function createHaloSprites(id) {
    const map = sharedGlowTexture();
    return [0x3b9eff, 0xff2e4c].map((color, i) => {
      const mat = new THREE.SpriteMaterial({
        map,
        color,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.name = `pursuit-halo-${i ? "red" : "blue"}:${id}`;
      sprite.visible = false;
      haloGroup.add(sprite);
      return sprite;
    });
  }
  function rushPalette() {
    if (!rushLenses) {
      // These small opaque lenses are their own visible pixels; they light no surfaces.
      const lens = color => new THREE.MeshBasicMaterial({ color, toneMapped: false });
      rushLenses = [[lens(0x5ca7ff), lens(0x682b2c)], [lens(0x233d61), lens(0xff5151)]];
    }
    return rushLenses;
  }
  function cinematicPalette() {
    if (!cinematicLenses) {
      const blue = matte(0x344b55), red = matte(0x5c403c);
      cinematicLenses = [[accent(0x82bdde), red], [blue, accent(0xd9806c)], [blue, red]];
    }
    return cinematicLenses;
  }
  const contact = new THREE.Mesh(contactCircle, paints.contact);
  contact.name = "pursuit-contact";
  contact.rotation.x = -Math.PI / 2;
  contact.visible = false;
  layer.add(contact);
  let disposed = false;

  function setPatrolShell(kit, source) {
    const shell = source.getObjectByName("traffic-shell");
    if (!shell?.isMesh) return;
    const original = shell.geometry;
    let paint = patrolShells.get(original);
    if (!paint) {
      if (!original.boundingBox) original.computeBoundingBox();
      const geometry = twoToneShell(original);
      if (!geometry) return;
      paint = { geometry, users: 0 };
      patrolShells.set(original, paint);
    }
    paint.users++;
    shell.geometry = paint.geometry;
    kit.livery = { shell, original, paint };
  }

  function restorePatrolShell(kit) {
    if (!kit.livery) return;
    const { shell, original, paint } = kit.livery;
    shell.geometry = original;
    if (--paint.users === 0) {
      paint.geometry.dispose();
      patrolShells.delete(original);
    }
    kit.livery = null;
  }

  function hideHalos(kit) {
    if (!kit.halos) return;
    for (const halo of kit.halos) {
      halo.visible = false;
      halo.material.opacity = 0;
    }
  }

  function removePatrol(kit) {
    restorePatrolShell(kit);
    if (kit.halos) {
      for (const halo of kit.halos) {
        halo.removeFromParent();
        halo.material.dispose();
      }
      kit.halos = null;
    }
    kit.root.removeFromParent();
    kit.stripe.geometry.dispose();
  }

  function attach(record, actor) {
    if (disposed || !record?.root || actor?.pursuitRole !== "police") return;
    const previous = patrols.get(actor.id);
    if (previous?.record === record) return;
    if (previous) removePatrol(previous);
    const root = new THREE.Group();
    root.name = `pursuit-patrol:${actor.id}`;
    root.visible = false;
    const housing = new THREE.Mesh(box, paints.casing);
    housing.name = "pursuit-lightbar-housing";
    const lenses = staticLenses.map(material => new THREE.Mesh(box, material));
    for (const [i, lens] of lenses.entries())
      lens.name = i ? "pursuit-lightbar-red" : "pursuit-lightbar-blue";
    const stripe = new THREE.Mesh(new THREE.BufferGeometry(), paints.trim);
    root.add(housing, ...lenses, stripe);
    layer.add(root);
    patrols.set(actor.id, { root, record, housing, lenses, stripe, source: null, fitted: false,
      bank: patrolBank(actor.id), style: "legacy", livery: null,
      halos: world?.player ? createHaloSprites(actor.id) : null });
  }

  function syncRoads(current) {
    const active = new Set();
    for (const road of current.roads ?? []) {
      if (road.pursuitShoulder !== true || !positive(road.supportHeightM) ||
          !positive(road.width) || !finite(road.fixed) || !(road.max >= road.min)) continue;
      active.add(road);
      let slab = shoulders.get(road);
      if (!slab) {
        const mesh = new THREE.Mesh(box, paints.shoulder);
        mesh.name = "pursuit-supported-shoulder";
        mesh.receiveShadow = true;
        layer.add(mesh);
        slab = { mesh };
        shoulders.set(road, slab);
      }
      const r = slab.rect = roadRect(road);
      slab.mesh.position.set((r.minX + r.maxX) / 2, ROAD_TOP + road.supportHeightM / 2,
        (r.minZ + r.maxZ) / 2);
      slab.mesh.scale.set(r.maxX - r.minX, road.supportHeightM, r.maxZ - r.minZ);
    }
    for (const [road, { mesh }] of shoulders) if (!active.has(road)) {
      mesh.removeFromParent();
      shoulders.delete(road);
    }
  }

  function syncBarriers(current) {
    const active = new Set();
    for (const site of current.statics ?? []) {
      if (site.kind !== "barrier" || !positive(site.width) || !positive(site.length) ||
          !finite(site.x) || !finite(site.z)) continue;
      active.add(site.id);
      let root = barriers.get(site.id);
      if (!root) {
        root = new THREE.Group();
        root.name = `pursuit-barrier:${site.id}`;
        root.userData.gtaRoadblock = Boolean(site.gtaRoadblock);
        const shell = new THREE.Mesh(box, site.gtaRoadblock ? paints.gtaRoadblock : paints.closure);
        shell.castShadow = shell.receiveShadow = true;
        root.add(shell, new THREE.Mesh(warningStripes, paints.reflector));
        layer.add(root);
        barriers.set(site.id, root);
      }
      const height = positive(site.height) ? site.height : 0.65;
      root.position.set(site.x, ROAD_TOP + height / 2, site.z);
      root.rotation.y = site.heading ?? 0;
      root.scale.set(site.width, height, site.length);
    }
    for (const [id, root] of barriers) if (!active.has(id)) {
      root.removeFromParent();
      barriers.delete(id);
    }
  }

  function syncContact(current) {
    const impact = current.pursuit?.metrics?.impact;
    const age = current.tick - impact?.tick;
    contact.visible = finite(impact?.x) && finite(impact?.z) && age >= 0 && age < 75;
    if (!contact.visible) return;
    let height = 0;
    for (const [road, { rect }] of shoulders)
      if (impact.x >= rect.minX && impact.x <= rect.maxX &&
          impact.z >= rect.minZ && impact.z <= rect.maxZ)
        height = Math.max(height, road.supportHeightM);
    contact.position.set(impact.x, ROAD_TOP + height + 0.014, impact.z);
  }

  function isPatrolWrecked(actor, current) {
    return Boolean(
      actor.pursuitWreck ||
      actor.wrecked ||
      (current.pursuit?.gta && actor.aiState === "WRECKED"),
    );
  }

  function updateBounceLights(current, tickNow, running) {
    redBounceLight.intensity = 0;
    blueBounceLight.intensity = 0;
    const player = current?.player;
    if (!running || !player) return;
    if (!redBounceLight.parent) layer.add(redBounceLight, blueBounceLight);
    const px = finite(player.x) ? player.x : 0;
    const pz = finite(player.z) ? player.z : 0;
    let near1 = null, near2 = null;
    for (const actor of current.actors ?? []) {
      if (actor.pursuitRole !== "police" || isPatrolWrecked(actor, current)) continue;
      const kit = patrols.get(actor.id);
      const resident = kit?.record?.root?.visible && kit.record.root.parent === scene
        ? kit.record.root
        : null;
      const ax = resident ? resident.position.x : actor.x;
      const ay = resident ? resident.position.y : ROAD_TOP + (actor.y ?? 0);
      const az = resident ? resident.position.z : actor.z;
      const heading = resident ? resident.rotation.y : (actor.heading ?? 0);
      if (!finite(ax) || !finite(az)) continue;
      const dist = Math.hypot(ax - px, az - pz);
      if (!(dist < BOUNCE_LIGHT_RANGE_M)) continue;
      const candidate = { x: ax, y: ay, z: az, heading, dist, bank: kit?.bank ?? patrolBank(actor.id) };
      if (!near1 || dist < near1.dist) {
        near2 = near1;
        near1 = candidate;
      } else if (!near2 || dist < near2.dist) {
        near2 = candidate;
      }
    }
    if (!near1) return;
    const halfCycle = tickNow / LIGHTBAR_HOLD_TICKS;
    const u = halfCycle - Math.floor(halfCycle);
    const env = doubleFlashEnvelope(u);
    const side1 = (Math.floor(halfCycle) ^ near1.bank) & 1;
    const gain1 = bounceDistanceGain(near1.dist);
    if (near2) {
      const side2 = (Math.floor(halfCycle) ^ near2.bank) & 1;
      const gain2 = bounceDistanceGain(near2.dist);
      if (side1 === 1) {
        redBounceLight.position.set(near1.x, near1.y + BOUNCE_LIGHT_HEIGHT_M, near1.z);
        redBounceLight.intensity = gain1 * env;
        blueBounceLight.position.set(near2.x, near2.y + BOUNCE_LIGHT_HEIGHT_M, near2.z);
        blueBounceLight.intensity = side2 === 0 ? gain2 * env : Math.max(gain2 * 0.4, gain1 * 0.14);
      } else {
        blueBounceLight.position.set(near1.x, near1.y + BOUNCE_LIGHT_HEIGHT_M, near1.z);
        blueBounceLight.intensity = gain1 * env;
        redBounceLight.position.set(near2.x, near2.y + BOUNCE_LIGHT_HEIGHT_M, near2.z);
        redBounceLight.intensity = side2 === 1 ? gain2 * env : Math.max(gain2 * 0.4, gain1 * 0.14);
      }
    } else {
      const cosH = Math.cos(near1.heading), sinH = Math.sin(near1.heading);
      blueBounceLight.position.set(near1.x - cosH * 0.32, near1.y + BOUNCE_LIGHT_HEIGHT_M, near1.z + sinH * 0.32);
      redBounceLight.position.set(near1.x + cosH * 0.32, near1.y + BOUNCE_LIGHT_HEIGHT_M, near1.z - sinH * 0.32);
      if (side1 === 0) {
        blueBounceLight.intensity = gain1 * env;
        redBounceLight.intensity = gain1 * 0.12;
      } else {
        redBounceLight.intensity = gain1 * env;
        blueBounceLight.intensity = gain1 * 0.12;
      }
    }
    redBounceLight.updateMatrixWorld(true);
    blueBounceLight.updateMatrixWorld(true);
  }

  function update(current = world, alpha = 0) {
    if (disposed) return;
    syncRoads(current);
    syncBarriers(current);
    syncContact(current);
    survivalEffects?.update(current);
    const running = current.pursuit?.phase === "running";
    const subAlpha = finite(alpha) ? THREE.MathUtils.clamp(alpha, 0, 1) : 0;
    const tickNow = (current.tick ?? 0) + subAlpha;
    lastActiveHalos = 0;
    updateBounceLights(current, tickNow, running);
    if (!patrols.size) return;
    const hasPlayer = Boolean(current?.player);
    const cinematic = Boolean(current.pursuit?.response);
    const rush = current.pursuit?.variant === "rush" && running;
    const style = cinematic ? "cinematic" : rush ? "rush" : "legacy";
    const halfCycle = tickNow / LIGHTBAR_HOLD_TICKS;
    const phase = Math.floor((current.tick ?? 0) / LIGHTBAR_HOLD_TICKS) & 1;
    const haloEnv = doubleFlashEnvelope(halfCycle - Math.floor(halfCycle));
    activePolice.clear();
    for (const actor of current.actors)
      if (actor.pursuitRole === "police") activePolice.set(actor.id, actor);
    for (const [id, kit] of patrols) {
      const actor = activePolice.get(id);
      if (!actor) {
        removePatrol(kit);
        patrols.delete(id);
        continue;
      }
      const { record, root } = kit;
      root.visible = false;
      if (!record.root.visible || record.root.parent !== scene) {
        hideHalos(kit);
        if (kit.livery) {
          restorePatrolShell(kit);
          kit.source = null;
        }
        continue;
      }
      const source = record.visual?.visible ? record.visual : record.fallback;
      if (kit.source !== source || kit.style !== style) {
        restorePatrolShell(kit);
        kit.housing.geometry = cinematic ? (diffuser ??= diffuserProfile()) : box;
        for (const lens of kit.lenses) lens.geometry = kit.housing.geometry;
        kit.source = source;
        kit.style = style;
        if (source && cinematic) setPatrolShell(kit, source);
        const savedRx = source ? source.rotation.x : 0;
        const savedRz = source ? source.rotation.z : 0;
        if (source && (savedRx || savedRz)) {
          source.rotation.x = 0;
          source.rotation.z = 0;
        }
        kit.fitted = Boolean(source && fitPatrolKit(kit, source, record.root, actor, style));
        if (source && (savedRx || savedRz)) {
          source.rotation.x = savedRx;
          source.rotation.z = savedRz;
          source.updateWorldMatrix(true, true);
        }
        if (!kit.fitted) restorePatrolShell(kit);
      }
      if (!kit.fitted) {
        hideHalos(kit);
        continue;
      }
      const wrecked = isPatrolWrecked(actor, current);
      const dim = wrecked || !running || current.tick % LIGHTBAR_HOLD_TICKS < 5;
      const gtaAppearance = current.pursuit?.gta ? (actor.aiState === "WRECKED" ? "wrecked"
        : actor.aiState === "ROADBLOCK" ? "roadblock" : actor.unitType) : null;
      if (root.userData.gtaAppearance !== gtaAppearance) {
        root.userData.gtaAppearance = gtaAppearance;
        const paint = gtaAppearance ? paints[`gta${gtaAppearance[0].toUpperCase()}${gtaAppearance.slice(1)}`] : null;
        kit.housing.material = paint ?? paints.casing;
        kit.stripe.material = paint ?? paints.trim;
      }
      const lenses = gtaAppearance === "wrecked" ? [paints.gtaWrecked, paints.gtaWrecked]
        : gtaAppearance === "roadblock" ? [paints.gtaRoadblock, paints.gtaRoadblock]
        : current.pursuit?.survival && !dim ? rushPalette()[phase ^ kit.bank]
        : cinematic ? cinematicPalette()[dim ? 2 : phase ^ kit.bank]
        : rush ? rushPalette()[phase ^ kit.bank] : staticLenses;
      if (kit.lenses[0].material !== lenses[0])
        for (let i = 0; i < lenses.length; i++) kit.lenses[i].material = lenses[i];
      root.position.copy(record.root.position);
      root.quaternion.copy(record.root.quaternion);
      if (record.rollRad || record.pitchRad) {
        tiltEuler.set(record.pitchRad || 0, 0, record.rollRad || 0);
        root.quaternion.multiply(tiltQuat.setFromEuler(tiltEuler));
      }
      root.scale.copy(record.root.scale);
      root.visible = true;

      if (hasPlayer && running && !wrecked && gtaAppearance !== "wrecked") {
        kit.halos ??= createHaloSprites(id);
        const activeSide = (phase ^ kit.bank) & 1;
        for (let i = 0; i < 2; i++) {
          const halo = kit.halos[i];
          haloPos.copy(kit.lenses[i].position)
            .multiply(root.scale)
            .applyQuaternion(root.quaternion)
            .add(root.position);
          haloPos.y += 0.06;
          halo.position.copy(haloPos);
          if (i === activeSide) {
            const s = 1.45 + 1.15 * haloEnv;
            halo.scale.set(s * 1.25, s * 0.88, 1);
            halo.material.opacity = 0.42 + 0.54 * haloEnv;
          } else {
            halo.scale.set(0.78, 0.56, 1);
            halo.material.opacity = 0.08 + 0.06 * (1 - haloEnv);
          }
          halo.visible = true;
          halo.updateMatrixWorld(true);
        }
        lastActiveHalos++;
      } else {
        hideHalos(kit);
      }
    }
  }

  function diagnostics() {
    return {
      bounceLightsActive: redBounceLight.intensity > 0 || blueBounceLight.intensity > 0,
      redIntensity: redBounceLight.intensity,
      blueIntensity: blueBounceLight.intensity,
      activePatrolHalos: lastActiveHalos,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    redBounceLight.intensity = 0;
    blueBounceLight.intensity = 0;
    lastActiveHalos = 0;
    for (const kit of patrols.values()) removePatrol(kit);
    patrols.clear();
    activePolice.clear();
    barriers.clear();
    shoulders.clear();
    layer.removeFromParent();
    layer.clear();
    box.dispose();
    diffuser?.dispose();
    glowTexture?.dispose();
    glowTexture = null;
    warningStripes.dispose();
    contactCircle.dispose();
    for (const paint of Object.values(paints)) paint.dispose();
    survivalEffects?.dispose();
    for (const pair of rushLenses ?? []) for (const lens of pair) lens.dispose();
    for (const lens of new Set(cinematicLenses?.flat())) lens.dispose();
  }

  update();
  return { attach, update, dispose, diagnostics, appearance(root, current) {
    if (current.pursuit?.survival) survivalEffects ??= createSurvivalEffects(layer);
    survivalEffects?.appearance(root, current);
  } };
}
