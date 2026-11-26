import * as THREE from "three";
import { PLAYER_VEHICLE } from "../core/vehicle-spec.js";
import { createSuvModel } from "./suv-model.js";

const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const vector = (p) => new THREE.Vector3(p.x, p.y, p.z);
const point = (p) => ({ x: p.x, y: p.y, z: p.z });
const UP = new THREE.Vector3(0, 1, 0);
const _scratchVecA = new THREE.Vector3();
const _scratchVecB = new THREE.Vector3();
const _scratchInvRoot = new THREE.Matrix4();
const lerpNum = (a, b, t) => t >= 1 ? b : t <= 0 ? a : a + (b - a) * t;

function createRoadPoolTexture(textures) {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = ((y + 0.5) / size) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const falloff = Math.max(0, 1 - Math.hypot(u, v));
      const smooth = falloff * falloff * (3 - 2 * falloff);
      const alpha = Math.round(smooth * falloff * 255);
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = alpha;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  textures.add(texture);
  return texture;
}

function dashboardPainter(model) {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 768; canvas.height = 256;
  const context = canvas.getContext?.("2d");
  if (!context) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  model.resources.textures.add(texture);
  model.cockpit.displayMaterial.map = texture;
  model.cockpit.displayMaterial.color.setHex(0xffffff);
  model.cockpit.displayMaterial.needsUpdate = true;
  let previous;
  return (speed, gear, brake) => {
    const digits = String(Math.round(Math.abs(speed))).padStart(3, "0");
    const signature = `${digits}:${gear}:${brake > 0.03}`;
    if (signature === previous) return;
    previous = signature;
    context.fillStyle = "#15231d";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.textAlign = "left";
    context.fillStyle = "#dfebd1";
    context.font = "600 143px Tahoma,Arial,sans-serif";
    context.fillText(digits, 35, 168);
    context.font = "31px Tahoma,Arial,sans-serif";
    context.fillStyle = "#c1cdb8";
    context.fillText("km/h", 43, 217);
    context.fillStyle = "#60765e";
    context.fillRect(486, 33, 2, 188);
    context.textAlign = "center";
    context.fillStyle = "#edf1df";
    context.font = "600 114px Tahoma,Arial,sans-serif";
    context.fillText(String(gear), 617, 150);
    context.fillStyle = brake > 0.03 ? "#f1bc8e" : "#c2d5b6";
    context.font = "28px Tahoma,Arial,sans-serif";
    context.fillText(brake > 0.03 ? "BRAKE" : "READY", 614, 211);
    texture.needsUpdate = true;
  };
}

function resolvePartInput(parts, keys, coreAuthoritative) {
  if (!parts || typeof parts !== "object") return { active: false, level: 0, tag: null, raw: null };
  for (const key of keys) {
    const raw = parts[key];
    if (raw == null) continue;
    if (typeof raw === "number") {
      const level = clamp(finite(raw), 0, 1);
      return { active: coreAuthoritative || level > 0, level, tag: null, raw };
    }
    if (typeof raw === "string") {
      const tag = raw.toLowerCase();
      if (tag === "intact" || tag === "ok" || tag === "pristine")
        return { active: true, level: 0, tag: "intact", raw };
      if (tag === "detached" || tag === "missing" || tag === "torn")
        return { active: true, level: 0.95, tag: "detached", raw };
      if (tag === "shattered" || tag === "broken" || tag === "smashed")
        return { active: true, level: 0.75, tag: "shattered", raw };
      if (tag === "unlatched" || tag === "buckled" || tag === "popped" || tag === "open")
        return { active: true, level: 0.55, tag: "unlatched", raw };
      if (tag === "dangling" || tag === "folded")
        return { active: true, level: 0.52, tag: "dangling", raw };
      if (tag === "sagging")
        return { active: true, level: 0.52, tag: "sagging", raw };
      if (tag === "tilted" || tag === "askew" || tag === "loose" || tag === "bent" || tag === "crooked" || tag === "recessed")
        return { active: true, level: 0.5, tag: "loose", raw };
      if (tag === "cracked" || tag === "dimmed" || tag === "scratched")
        return { active: true, level: 0.48, tag: "cracked", raw };
      return { active: true, level: 0.25, tag, raw };
    }
    if (typeof raw === "object") {
      const numeric = Number.isFinite(raw.damage)
        ? clamp(raw.damage, 0, 1)
        : Number.isFinite(raw.integrity) ? clamp(1 - raw.integrity, 0, 1) : 0;
      const state = typeof raw.state === "string" ? raw.state.toLowerCase() : null;
      if (raw.detached || state === "detached") return { active: true, level: Math.max(0.95, numeric), tag: "detached", raw };
      if (raw.shattered || state === "shattered") return { active: true, level: Math.max(0.75, numeric), tag: "shattered", raw };
      if (raw.unlatched || state === "unlatched") return { active: true, level: Math.max(0.55, numeric), tag: "unlatched", raw };
      if (raw.dangling || state === "dangling") return { active: true, level: Math.max(0.52, numeric), tag: "dangling", raw };
      if (raw.tilted || state === "tilted") return { active: true, level: Math.max(0.5, numeric), tag: "tilted", raw };
      if (raw.sagging || state === "sagging") return { active: true, level: Math.max(0.52, numeric), tag: "sagging", raw };
      if (raw.claddingLoose || state === "loose") return { active: true, level: Math.max(0.5, numeric), tag: "loose", raw };
      if (raw.cracked || raw.glassCracked || state === "cracked")
        return { active: true, level: Math.max(0.48, numeric), tag: "cracked", raw };
      const touched = numeric > 0 || (state && state !== "intact");
      return { active: coreAuthoritative || touched, level: numeric, tag: state ?? "intact", raw };
    }
  }
  return { active: false, level: 0, tag: null, raw: null };
}

function resolveCrashStates(damage, sides) {
  const [front, rear, left, right] = sides;
  const parts = damage.parts;
  const coreAuthoritative = Boolean(
    parts && (finite(damage.brokenCount) > 0 || Array.isArray(damage.lastImpact?.brokenParts)),
  );
  const impactSide = damage.lastImpact?.side ?? null;
  const rawLat = finite(damage.lastImpact?.lateralOffsetM, finite(damage.lastImpact?.localX, 0));
  const frontLat = (impactSide === "front" || (!impactSide && front > 0)) ? clamp(rawLat / 0.65, -1, 1) : 0;
  const rearLat = (impactSide === "rear" || (!impactSide && rear > 0)) ? clamp(rawLat / 0.65, -1, 1) : 0;
  const pick = (...keys) => resolvePartInput(parts, keys, coreAuthoritative);

  const hoodIn = pick("hood");
  const hoodLvl = hoodIn.active ? hoodIn.level : front;
  const hood = hoodIn.tag === "detached" || (!hoodIn.active && hoodLvl >= 0.82)
    ? "detached"
    : hoodIn.tag === "unlatched" || hoodLvl >= 0.18 ? "unlatched" : "intact";

  const grilleIn = pick("grille", "frontGrille");
  const grilleLvl = grilleIn.active ? grilleIn.level : front;
  const grille = grilleIn.tag === "detached" || (!grilleIn.active && grilleLvl >= 0.85)
    ? "detached"
    : grilleIn.tag === "cracked" || grilleIn.tag === "shattered" || grilleLvl >= 0.2
      ? "broken" : "intact";

  const fPlateIn = pick("frontPlate", "licensePlate");
  const fBumperIn = pick("frontBumper");
  const fPlateLvl = fPlateIn.active ? fPlateIn.level : Math.max(front, fBumperIn.level);
  const frontPlate = fPlateIn.tag === "detached" || fBumperIn.tag === "detached" || grilleIn.tag === "detached" || fPlateLvl >= 0.8
    ? "detached"
    : fPlateIn.tag === "dangling" || fPlateIn.tag === "loose" || fPlateLvl >= 0.18 ? "dangling" : "intact";

  const hlLeftIn = pick("headlampLeft", "leftHeadlamp");
  const hlLeftLvl = hlLeftIn.active ? hlLeftIn.level : front * (1 - 0.55 * frontLat) + left * 0.32;
  const headlampLeft = hlLeftIn.tag === "shattered" || hlLeftIn.tag === "detached" || (!hlLeftIn.active && hlLeftLvl >= 0.52)
    ? "shattered"
    : hlLeftIn.tag === "cracked" || (!hlLeftIn.active && hlLeftLvl >= 0.34) ? "cracked" : "intact";

  const hlRightIn = pick("headlampRight", "rightHeadlamp");
  const hlRightLvl = hlRightIn.active ? hlRightIn.level : front * (1 + 0.55 * frontLat) + right * 0.32;
  const headlampRight = hlRightIn.tag === "shattered" || hlRightIn.tag === "detached" || (!hlRightIn.active && hlRightLvl >= 0.52)
    ? "shattered"
    : hlRightIn.tag === "cracked" || (!hlRightIn.active && hlRightLvl >= 0.34) ? "cracked" : "intact";

  const wsIn = pick("windshield");
  const wsLvl = wsIn.active ? wsIn.level : Math.max(front, Math.max(left, right) * 0.62);
  const windshield = wsIn.tag === "cracked" || wsIn.tag === "shattered" || (!wsIn.active && wsLvl >= 0.42)
    ? "cracked" : "intact";

  const mLeftIn = pick("mirrorLeft", "leftMirror");
  const mLeftLvl = mLeftIn.active ? mLeftIn.level : left;
  const mirrorLeft = mLeftIn.tag === "detached" || (!mLeftIn.active && mLeftLvl >= 0.72)
    ? "detached"
    : mLeftIn.tag === "dangling" || (!mLeftIn.active && mLeftLvl >= 0.22) ? "dangling" : "intact";

  const mRightIn = pick("mirrorRight", "rightMirror");
  const mRightLvl = mRightIn.active ? mRightIn.level : right;
  const mirrorRight = mRightIn.tag === "detached" || (!mRightIn.active && mRightLvl >= 0.72)
    ? "detached"
    : mRightIn.tag === "dangling" || (!mRightIn.active && mRightLvl >= 0.22) ? "dangling" : "intact";

  const cLeftIn = pick("claddingLeft", "leftDoorCladding", "leftCladding", "doorLeft");
  const cLeftLvl = Math.max(cLeftIn.level, left);
  const claddingLeft = cLeftIn.tag === "loose" || cLeftIn.raw?.claddingLoose || cLeftLvl >= 0.25 ? "loose" : "intact";

  const cRightIn = pick("claddingRight", "rightDoorCladding", "rightCladding", "doorRight");
  const cRightLvl = Math.max(cRightIn.level, right);
  const claddingRight = cRightIn.tag === "loose" || cRightIn.raw?.claddingLoose || cRightLvl >= 0.25 ? "loose" : "intact";

  const dLeftIn = pick("doorLeft", "leftDoor");
  const dLeftLvl = dLeftIn.active ? dLeftIn.level : left;
  const doorLeft = dLeftIn.tag === "ajar" || dLeftIn.raw?.ajar || (!dLeftIn.active && dLeftLvl >= 0.34)
    ? "ajar" : "intact";

  const dRightIn = pick("doorRight", "rightDoor");
  const dRightLvl = dRightIn.active ? dRightIn.level : right;
  const doorRight = dRightIn.tag === "ajar" || dRightIn.raw?.ajar || (!dRightIn.active && dRightLvl >= 0.34)
    ? "ajar" : "intact";

  const tlLeftIn = pick("tailLampLeft", "leftTailLamp");
  const tlLeftLvl = tlLeftIn.active ? tlLeftIn.level : rear * (1 - 0.55 * rearLat) + left * 0.28;
  const tailLampLeft = tlLeftIn.tag === "shattered" || tlLeftIn.tag === "detached" || (!tlLeftIn.active && tlLeftLvl >= 0.52)
    ? "shattered"
    : tlLeftIn.tag === "cracked" || (!tlLeftIn.active && tlLeftLvl >= 0.34) ? "cracked" : "intact";

  const tlRightIn = pick("tailLampRight", "rightTailLamp");
  const tlRightLvl = tlRightIn.active ? tlRightIn.level : rear * (1 + 0.55 * rearLat) + right * 0.28;
  const tailLampRight = tlRightIn.tag === "shattered" || tlRightIn.tag === "detached" || (!tlRightIn.active && tlRightLvl >= 0.52)
    ? "shattered"
    : tlRightIn.tag === "cracked" || (!tlRightIn.active && tlRightLvl >= 0.34) ? "cracked" : "intact";

  const spareIn = pick("spareCover", "rearSpareCover", "spareCarrier");
  const spareLvl = spareIn.active ? spareIn.level : rear;
  const spareCover = spareIn.tag === "detached" || (!spareIn.active && spareLvl >= 0.75)
    ? "detached"
    : spareIn.tag === "tilted" || spareIn.tag === "loose" || (!spareIn.active && spareLvl >= 0.25) ? "tilted" : "intact";

  const exhaustIn = pick("exhaust", "rearExhaust");
  const exhaustLvl = exhaustIn.active ? exhaustIn.level : rear;
  const exhaust = exhaustIn.tag === "detached" || (!exhaustIn.active && exhaustLvl >= 0.85)
    ? "detached"
    : exhaustIn.tag === "sagging" || (!exhaustIn.active && exhaustLvl >= 0.22)
      ? "sagging" : "intact";

  const rPlateIn = pick("rearPlate");
  const rBumperIn = pick("rearBumper");
  const rPlateLvl = rPlateIn.active ? rPlateIn.level : Math.max(rear, rBumperIn.level);
  const rearPlate = rPlateIn.tag === "detached" || rBumperIn.tag === "detached" || rPlateLvl >= 0.85
    ? "detached"
    : rPlateIn.tag === "dangling" || rPlateIn.tag === "loose" || rPlateLvl >= 0.22 ? "dangling" : "intact";

  const rwIn = pick("rearWindow", "rearHatch");
  const rwLvl = rwIn.active ? rwIn.level : rear;
  const rearWindow = rwIn.tag === "cracked" || rwIn.tag === "shattered" || rwIn.raw?.glassCracked || (!rwIn.active && rwLvl >= 0.42)
    ? "cracked" : "intact";

  const states = {
    hood, grille, frontPlate, headlampLeft, headlampRight, windshield,
    mirrorLeft, mirrorRight, claddingLeft, claddingRight, doorLeft, doorRight,
    tailLampLeft, tailLampRight, spareCover, exhaust, rearPlate, rearWindow,
  };
  const levels = {
    hood: hoodLvl, grille: grilleLvl, frontPlate: fPlateLvl,
    headlampLeft: hlLeftLvl, headlampRight: hlRightLvl, windshield: wsLvl,
    mirrorLeft: mLeftLvl, mirrorRight: mRightLvl,
    claddingLeft: cLeftLvl, claddingRight: cRightLvl,
    doorLeft: dLeftLvl, doorRight: dRightLvl,
    tailLampLeft: tlLeftLvl, tailLampRight: tlRightLvl,
    spareCover: spareLvl, exhaust: exhaustLvl, rearPlate: rPlateLvl, rearWindow: rwLvl,
  };
  const brokenParts = Object.keys(states).filter((k) => states[k] !== "intact");
  const detachedParts = Object.keys(states).filter((k) => states[k] === "detached");
  const pristine = sides.every((s) => s === 0) && finite(damage.impactCount) === 0 && brokenParts.length === 0;
  return {
    pristine,
    frontLat,
    rearLat,
    states,
    levels,
    brokenParts,
    detachedParts,
    radiatorExposed: hood !== "intact",
    windshieldCracked: windshield !== "intact",
    rearWindowCracked: rearWindow !== "intact",
  };
}

const PRISTINE_STATES = Object.freeze({
  hood: "intact",
  grille: "intact",
  frontPlate: "intact",
  headlampLeft: "intact",
  headlampRight: "intact",
  windshield: "intact",
  mirrorLeft: "intact",
  mirrorRight: "intact",
  claddingLeft: "intact",
  claddingRight: "intact",
  doorLeft: "intact",
  doorRight: "intact",
  tailLampLeft: "intact",
  tailLampRight: "intact",
  spareCover: "intact",
  exhaust: "intact",
  rearPlate: "intact",
  rearWindow: "intact",
});
const PRISTINE_DAMAGE_SIG = `0:0:0:0:0.0000:0.0000:${Object.values(PRISTINE_STATES).join(",")}`;

function hasAnyNonIntactPart(parts) {
  if (!parts || typeof parts !== "object") return false;
  for (const key in parts) {
    const raw = parts[key];
    if (raw == null) continue;
    if (typeof raw === "number") {
      if (raw > 0) return true;
      continue;
    }
    if (typeof raw === "string") {
      if (raw !== "intact" && raw !== "ok" && raw !== "pristine") return true;
      continue;
    }
    if (typeof raw === "object") {
      if (
        (raw.damage ?? 0) > 0 ||
        (raw.state !== undefined && raw.state !== "intact") ||
        (raw.integrity !== undefined && raw.integrity < 1) ||
        raw.detached ||
        raw.shattered ||
        raw.unlatched ||
        raw.dangling ||
        raw.tilted ||
        raw.sagging ||
        raw.claddingLoose ||
        raw.ajar ||
        raw.cracked ||
        raw.glassCracked ||
        raw.leaking ||
        raw.unclippedLeft ||
        raw.unclippedRight
      ) {
        return true;
      }
    }
  }
  return false;
}

export function createPlayerVehicle(_templateScene, initialActor = {}) {
  const scale = initialActor.giantScale;
  // An active Giant replay still builds one unscaled rig. WorldView applies its size.
  const modelBody = scale
    ? { length: initialActor.length / scale, width: initialActor.width / scale }
    : { ...initialActor };
  if (!initialActor?.pearlClearcoat && modelBody.matteLabFinish === undefined) {
    modelBody.matteLabFinish = true;
  }
  const model = createSuvModel(modelBody);
  const { root, chassis, kit } = model;
  const drawDashboard = dashboardPainter(model);
  const poolTexture = createRoadPoolTexture(model.resources.textures);
  const lightPools = new THREE.Group();
  lightPools.name = "suv-road-light-pools";
  lightPools.position.y = 0.022;
  lightPools.renderOrder = 2;
  root.add(lightPools);
  const headlampPoolGeo = kit.ownGeometry(new THREE.PlaneGeometry(2.85, 11.6));
  const makeHeadlampPool = (name, x) => {
    const mat = kit.ownMaterial(new THREE.MeshBasicMaterial({
      map: poolTexture,
      color: 0xfff0d4,
      transparent: true,
      opacity: 0.24,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }));
    const pool = new THREE.Mesh(headlampPoolGeo, mat);
    pool.name = name;
    pool.position.set(x, 0, 7.4);
    pool.rotation.x = -Math.PI / 2;
    pool.renderOrder = 2;
    pool.castShadow = false;
    pool.receiveShadow = false;
    lightPools.add(pool);
    return { mesh: pool, material: mat };
  };
  const leftHeadlampPool = makeHeadlampPool("suv-headlamp-pool-left", -0.64);
  const rightHeadlampPool = makeHeadlampPool("suv-headlamp-pool-right", 0.64);
  const tailPoolMat = kit.ownMaterial(new THREE.MeshBasicMaterial({
    map: poolTexture,
    color: 0xff2a20,
    transparent: true,
    opacity: 0.08,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  }));
  const tailPool = new THREE.Mesh(
    kit.ownGeometry(new THREE.PlaneGeometry(2.5, 3.3)),
    tailPoolMat,
  );
  tailPool.name = "suv-tail-pool";
  tailPool.position.set(0, 0, -3.15);
  tailPool.rotation.x = -Math.PI / 2;
  tailPool.renderOrder = 2;
  tailPool.castShadow = false;
  tailPool.receiveShadow = false;
  lightPools.add(tailPool);

  // Twin Nitro Afterburner Exhaust FX attached to SUV rear tailpipes (±0.52, 0.34, -2.075)
  const nitroFlames = new THREE.Group();
  nitroFlames.name = "player-nitro-flames";
  nitroFlames.position.set(0, 0.34, -2.075);
  nitroFlames.visible = false;
  nitroFlames.renderOrder = 5;
  chassis.add(nitroFlames);

  const makeJetConeGeo = (radius, length, zOffset = 0, radialSegs = 10) => {
    const g = new THREE.ConeGeometry(radius, length, radialSegs, 1, true);
    g.translate(0, length * 0.5, 0);
    g.rotateX(-Math.PI / 2);
    if (zOffset !== 0) g.translate(0, 0, zOffset);
    return kit.ownGeometry(g);
  };
  const nitroCoreGeo = makeJetConeGeo(0.036, 0.56, 0, 10);
  const nitroMidGeo = makeJetConeGeo(0.058, 0.94, 0, 10);
  const nitroDiamondGeo = makeJetConeGeo(0.048, 0.28, -0.18, 8);
  const nitroOuterGeo = makeJetConeGeo(0.084, 1.26, 0, 10);

  const makeAdditiveJetMat = (name, color, opacity) =>
    kit.ownMaterial(new THREE.MeshBasicMaterial({
      name,
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    }));

  const nitroCoreMat = makeAdditiveJetMat("nitro-mach-core-mat", 0x8cfaff, 0.94);
  const nitroMidMat = makeAdditiveJetMat("nitro-cyan-jet-mat", 0x1e96ff, 0.72);
  const nitroDiamondMat = makeAdditiveJetMat("nitro-amber-diamond-mat", 0xffb347, 0.58);
  const nitroOuterMat = makeAdditiveJetMat("nitro-violet-shock-mat", 0xb85cff, 0.44);

  const makeExhaustPlume = (label, x) => {
    const plume = new THREE.Group();
    plume.name = `nitro-plume-${label}`;
    plume.position.set(x, 0, 0);
    const layers = [
      ["core", nitroCoreGeo, nitroCoreMat],
      ["mid", nitroMidGeo, nitroMidMat],
      ["diamond", nitroDiamondGeo, nitroDiamondMat],
      ["outer", nitroOuterGeo, nitroOuterMat],
    ];
    for (const [partLabel, geo, mat] of layers) {
      const m = new THREE.Mesh(geo, mat);
      m.name = `nitro-${label}-${partLabel}`;
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
      m.renderOrder = 5;
      plume.add(m);
    }
    nitroFlames.add(plume);
    return plume;
  };
  const nitroPlumeLeft = makeExhaustPlume("left", -0.52);
  const nitroPlumeRight = makeExhaustPlume("right", 0.52);

  const nitroGroundPoolMat = kit.ownMaterial(new THREE.MeshBasicMaterial({
    name: "nitro-ground-pool-mat",
    map: poolTexture,
    color: 0x38b6ff,
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  }));
  const nitroGroundPool = new THREE.Mesh(
    kit.ownGeometry(new THREE.PlaneGeometry(1.95, 2.85)),
    nitroGroundPoolMat,
  );
  nitroGroundPool.name = "nitro-ground-pool";
  nitroGroundPool.position.set(0, -0.315, -1.15);
  nitroGroundPool.rotation.x = -Math.PI / 2;
  nitroGroundPool.castShadow = false;
  nitroGroundPool.receiveShadow = false;
  nitroGroundPool.frustumCulled = false;
  nitroGroundPool.renderOrder = 4;
  nitroFlames.add(nitroGroundPool);
  let nitroAnimStep = 0;

  const beams = new THREE.Group();
  beams.name = "vehicle-sensor-rays";
  beams.visible = false;
  root.add(beams);
  for (const record of model.sensors.ranges) {
    const geometry = kit.ownGeometry(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    );
    const material = kit.ownMaterial(
      new THREE.LineBasicMaterial({
        color: 0xa5d8ba, transparent: true, opacity: 0.75, depthWrite: false,
      }),
    );
    const beam = new THREE.Line(geometry, material);
    beam.name = `sensor-ray-${record.id}`;
    beam.frustumCulled = false;
    beams.add(beam);
    const hit = kit.mesh(
      new THREE.OctahedronGeometry(0.032),
      kit.ownMaterial(new THREE.MeshBasicMaterial({ color: 0xe9bb84 })),
      beams, `sensor-hit-${record.id}`,
    );
    hit.castShadow = false;
    Object.assign(record, { beam, hit });
  }
  const EXTERIOR_HULL_SHADOW_RE =
    /^suv-(hood|faceted-roof|front-bumper|rear-bumper|front-fascia|rear-hatch|rear-spare|spare-cover|left-front-fender|right-front-fender|left-rear-quarter|right-rear-quarter|left-doors|right-doors|left-pillar|right-pillar|left-mirror|right-mirror)|^wheel-.*-(tire|rim)/;
  const SEALED_EXTERIOR_OCCLUDED_RE =
    /^cockpit-|^suv-(seat|headrest|cabin-floor|cargo-floor|center-console|console-top|gear-selector|selector-grip|-?1-inner-door|-?1-armrest|subframe|differential|transverse-powerunit|powerunit|airbox|intake-join)|^suv-.*-(door-seam|headlamp-well|rear-lamp-well|roof-foot)|^chassis-center-spine|^wheel-.*-(wishbone|damper|spring|upright|halfshaft|brake-|strut-tower|disc|hub)|^range-(housing|ring|support)-|^sensor-range-|^front-camera-(foot|windscreen-support|header-foot)|^rear-camera-(foot|pedestal)|^roof-telemetry-(base|foot)/;
  const sealedInteriorParts = [];
  const hoodPart = root.getObjectByName("suv-hood");
  root.traverse((part) => {
    if (!part.isMesh) return;
    if (!EXTERIOR_HULL_SHADOW_RE.test(part.name)) {
      part.castShadow = false;
    }
    if (SEALED_EXTERIOR_OCCLUDED_RE.test(part.name)) {
      sealedInteriorParts.push(part);
    }
  });
  const savedSealedVis = new Array(sealedInteriorParts.length);
  function withExteriorChaseCulling(fn) {
    if (disposed) return fn();
    const cullSealed = !cutaway && hoodPart?.visible !== false;
    if (cullSealed) {
      for (let i = 0; i < sealedInteriorParts.length; i++) {
        savedSealedVis[i] = sealedInteriorParts[i].visible;
        sealedInteriorParts[i].visible = false;
      }
    }
    try {
      return fn();
    } finally {
      if (cullSealed) {
        for (let i = 0; i < sealedInteriorParts.length; i++) {
          sealedInteriorParts[i].visible = savedSealedVis[i];
        }
      }
    }
  }
  function withSensorOverlayCulling(fn) {
    if (disposed) return fn();
    const savedNitroVis = nitroFlames.visible;
    nitroFlames.visible = false;
    try {
      return fn();
    } finally {
      nitroFlames.visible = savedNitroVis;
    }
  }
  const diagnostics = {
    asset: "Original faceted SUV",
    ready: true, disposed: false, cutaway: false, sensorVisualization: false,
    coordinates: "+X right, +Y up, +Z forward; metres/radians",
    wheels: {}, cockpit: {}, sensors: { ranges: [], auxiliary: [], cameras: [] },
    damage: {
      total: 0, impactCount: 0, lastImpact: null,
      deformedVertices: 0, maximumDisplacementM: 0,
      brokenParts: [], detachedParts: [],
      radiatorExposed: false, windshieldCracked: false,
    },
  };
  let currentActor = initialActor;
  let disposed = false, cutaway = false, previousDamage = "";
  let prevDamageCutaway = false, prevPoolBrake = -1;
  let latestCrash = {
    pristine: true, states: {}, levels: {},
    brokenParts: [], detachedParts: [],
    radiatorExposed: false, windshieldCracked: false, rearWindowCracked: false,
  };
  const fixedPoses = {
    cockpit: {
      position: { x: -0.36, y: 1.4, z: 0.03 },
      target: { x: -0.36, y: 1.32, z: 4.2 },
    },
    inspection: {
      position: { x: -4.1, y: 2.65, z: 5.2 },
      target: { x: 0, y: 0.88, z: 0 },
    },
    "running-gear": {
      position: { x: -2.35, y: 0.88, z: 2.65 },
      target: { x: -0.45, y: 0.48, z: 0.95 },
    },
  };
  for (const camera of model.sensors.cameras) {
    const a = finite(camera.angleDeg) * Math.PI / 180;
    fixedPoses[camera.id === "rear-camera" ? "sensor-rear" : "sensor"] = {
      position: { ...camera.position },
      target: {
        x: camera.position.x + Math.sin(a) * 20,
        y: camera.position.y,
        z: camera.position.z + Math.cos(a) * 20,
      },
    };
  }

  function restoreAssembly(rec, visibleOverride) {
    rec.target.position.copy(rec.pristinePos);
    rec.target.rotation.copy(rec.pristineRot);
    rec.target.scale.copy(rec.pristineScale);
    const vis = visibleOverride ?? (rec.cutaway ? !cutaway : true);
    for (const obj of rec.meshes) obj.visible = vis;
  }

  function syncPartVisibility() {
    const cp = model.crashParts;
    if (!cp) return;
    const assemblies = [
      ["hood", cp.hood],
      ["mirrorLeft", cp.mirrorLeft],
      ["mirrorRight", cp.mirrorRight],
      ["grille", cp.grille],
      ["frontPlate", cp.frontPlate],
      ["rearPlate", cp.rearPlate],
      ["claddingLeft", cp.claddingLeft],
      ["claddingRight", cp.claddingRight],
      ["doorLeft", cp.doorLeft],
      ["doorRight", cp.doorRight],
      ["spareCover", cp.spareCover],
      ["exhaust", cp.exhaust],
    ];
    for (const [key, rec] of assemblies) {
      const detached = latestCrash.states[key] === "detached";
      const vis = !detached && (rec.cutaway ? !cutaway : true);
      for (const obj of rec.meshes) obj.visible = vis;
    }
    cp.cracks.windshield.line.visible = !cutaway && Boolean(latestCrash.windshieldCracked);
    cp.cracks.rearWindow.line.visible = !cutaway && Boolean(latestCrash.rearWindowCracked);
    lightPools.visible = !cutaway;
  }

  function syncLightPools(states = {}, brake = 0) {
    lightPools.visible = !cutaway;
    for (const [key, pool] of [
      ["headlampLeft", leftHeadlampPool],
      ["headlampRight", rightHeadlampPool],
    ]) {
      const st = states[key] ?? "intact";
      const opacity = st === "shattered" ? 0 : st === "cracked" ? 0.09 : 0.24;
      pool.material.opacity = opacity;
      pool.mesh.visible = opacity > 0;
    }
    const tailWeight = (st) => st === "shattered" ? 0 : st === "cracked" ? 0.22 : 0.5;
    const tailHealth = tailWeight(states.tailLampLeft ?? "intact") + tailWeight(states.tailLampRight ?? "intact");
    const baseRearOpacity = brake > 0.03 ? 0.16 + brake * 0.28 : 0.08;
    const rearOpacity = baseRearOpacity * tailHealth;
    tailPoolMat.opacity = rearOpacity;
    tailPool.visible = rearOpacity > 0;
    prevPoolBrake = brake;
  }

  function syncPristineTailBrakes(brake) {
    const cp = model.crashParts;
    if (cp) {
      for (const rec of [cp.tailLamps.left, cp.tailLamps.right]) {
        rec.material.color.setHex(rec.color);
        rec.material.emissive.setHex(brake > 0.03 ? 0xe83b28 : rec.emissive);
        rec.material.emissiveIntensity = brake > 0.03 ? 0.35 + brake * 0.85 : rec.intensity;
      }
      const chmsl = cp.tailLamps.chmsl;
      chmsl.material.color.setHex(chmsl.color);
      chmsl.material.emissive.setHex(brake > 0.03 ? 0xff3824 : chmsl.emissive);
      chmsl.material.emissiveIntensity = brake > 0.03 ? 0.28 + brake * 0.95 : chmsl.intensity;
    }
    syncLightPools(PRISTINE_STATES, brake);
  }

  function applyCrashParts(crash, actor, brake) {
    const cp = model.crashParts;
    if (!cp) return;
    const setTailLamp = (rec, state) => {
      if (state === "shattered") {
        rec.material.color.setHex(0x282221);
        rec.material.emissive.setHex(0x000000);
        rec.material.emissiveIntensity = 0;
      } else if (state === "cracked") {
        rec.material.color.setHex(0x6e362c);
        rec.material.emissive.setHex(brake > 0.03 ? 0x992619 : 0x3b150f);
        rec.material.emissiveIntensity = brake > 0.03 ? 0.22 + brake * 0.25 : 0.08;
      } else {
        rec.material.color.setHex(rec.color);
        rec.material.emissive.setHex(brake > 0.03 ? 0xe83b28 : rec.emissive);
        rec.material.emissiveIntensity = brake > 0.03 ? 0.35 + brake * 0.85 : rec.intensity;
      }
    };
    const setChmsl = (shattered = false) => {
      const rec = cp.tailLamps.chmsl;
      if (shattered) {
        rec.material.color.setHex(0x282221);
        rec.material.emissive.setHex(0x000000);
        rec.material.emissiveIntensity = 0;
        return;
      }
      rec.material.color.setHex(rec.color);
      rec.material.emissive.setHex(brake > 0.03 ? 0xff3824 : rec.emissive);
      rec.material.emissiveIntensity = brake > 0.03 ? 0.28 + brake * 0.95 : rec.intensity;
    };

    if (crash.pristine) {
      for (const rec of [
        cp.hood, cp.radiator, cp.crashBar, cp.mirrorLeft, cp.mirrorRight, cp.grille,
        cp.frontPlate, cp.rearPlate, cp.claddingLeft, cp.claddingRight,
        cp.doorLeft, cp.doorRight, cp.spareCover, cp.exhaust,
      ]) if (rec) restoreAssembly(rec);
      for (const rec of [cp.headlamps.left, cp.headlamps.right]) {
        rec.material.color.setHex(rec.color);
        rec.material.emissive.setHex(rec.emissive);
        rec.material.emissiveIntensity = Math.max(rec.intensity, 0.85);
      }
      setTailLamp(cp.tailLamps.left, "intact");
      setTailLamp(cp.tailLamps.right, "intact");
      setChmsl(false);
      cp.cracks.windshield.line.visible = false;
      cp.cracks.windshield.material.opacity = 0.8;
      cp.cracks.rearWindow.line.visible = false;
      cp.cracks.rearWindow.material.opacity = 0.8;
      syncLightPools(crash.states, brake);
      return;
    }

    const absSpeed = Math.abs(finite(actor.speed));
    const moveFactor = absSpeed > 1 ? clamp((absSpeed - 1) / 11, 0, 1) : 0;
    const dist = finite(actor.distance);

    restoreAssembly(cp.hood, crash.states.hood !== "detached" && !cutaway);
    if (crash.states.hood === "unlatched") {
      const open = clamp((crash.levels.hood - 0.16) / 0.62, 0.12, 1);
      const flutter = moveFactor * Math.abs(Math.sin(dist * 3.7)) * 0.038;
      cp.hood.target.rotation.x = -(0.09 + 0.25 * open + flutter);
      cp.hood.target.rotation.z = crash.frontLat * 0.055 * open;
    }

    restoreAssembly(cp.radiator);
    restoreAssembly(cp.crashBar);
    if (crash.levels.hood > 0.05 || crash.levels.grille > 0.05) {
      const crush = clamp(Math.max(crash.levels.hood, crash.levels.grille), 0, 1);
      cp.radiator.target.position.z = cp.radiator.pristinePos.z - 0.2 * crush;
      cp.radiator.target.rotation.x = -0.14 * crush;
      cp.radiator.target.rotation.y = -crash.frontLat * 0.08 * crush;
      cp.crashBar.target.position.z = cp.crashBar.pristinePos.z - 0.19 * crush;
      cp.crashBar.target.rotation.y = -crash.frontLat * 0.1 * crush;
    }

    for (const [key, rec, side] of [
      ["mirrorLeft", cp.mirrorLeft, -1],
      ["mirrorRight", cp.mirrorRight, 1],
    ]) {
      const st = crash.states[key];
      restoreAssembly(rec, st !== "detached" && (rec.cutaway ? !cutaway : true));
      if (st === "dangling") {
        const d = clamp((crash.levels[key] - 0.2) / 0.52, 0.2, 1);
        const rattle = moveFactor * Math.abs(Math.sin(dist * 6.3 + side)) * 0.055;
        rec.target.rotation.z = -side * (0.36 + 0.54 * d + rattle);
        rec.target.rotation.y = side * (0.24 + 0.34 * d);
        rec.target.rotation.x = 0.16 * d;
      }
    }

    restoreAssembly(cp.grille, crash.states.grille !== "detached");
    if (crash.states.grille === "broken") {
      const g = clamp((crash.levels.grille - 0.18) / 0.7, 0.1, 1);
      cp.grille.target.position.z = cp.grille.pristinePos.z - 0.058 * g;
      cp.grille.target.rotation.x = 0.17 * g;
      cp.grille.target.rotation.z = (crash.frontLat || 0.35) * 0.085 * g;
    }

    restoreAssembly(cp.frontPlate, crash.states.frontPlate !== "detached");
    if (crash.states.frontPlate === "dangling") {
      const fp = clamp((crash.levels.frontPlate - 0.16) / 0.62, 0.15, 1);
      const rattle = moveFactor * Math.sin(dist * 7.1) * 0.04;
      cp.frontPlate.target.position.z = cp.frontPlate.pristinePos.z - 0.045 * fp;
      cp.frontPlate.target.position.y = cp.frontPlate.pristinePos.y - 0.028 * fp;
      cp.frontPlate.target.rotation.z = (crash.frontLat || 0.65) * 0.32 * fp + rattle;
      cp.frontPlate.target.rotation.x = 0.22 * fp;
    }

    for (const [key, rec, side] of [
      ["claddingLeft", cp.claddingLeft, -1],
      ["claddingRight", cp.claddingRight, 1],
    ]) {
      restoreAssembly(rec);
      if (crash.states[key] === "loose") {
        const cl = clamp((crash.levels[key] - 0.22) / 0.65, 0.15, 1);
        rec.target.position.x = rec.pristinePos.x + side * 0.024 * cl;
        rec.target.position.y = rec.pristinePos.y - 0.025 * cl;
        rec.target.rotation.z = -side * 0.068 * cl;
        rec.target.rotation.x = 0.052 * cl;
        rec.target.rotation.y = side * 0.045 * cl;
      }
    }

    for (const [key, rec, side] of [
      ["doorLeft", cp.doorLeft, -1],
      ["doorRight", cp.doorRight, 1],
    ]) {
      if (!rec) continue;
      restoreAssembly(rec);
      if (crash.states[key] === "ajar") {
        const dl = clamp((crash.levels[key] - 0.3) / 0.65, 0.2, 1);
        const flutter = moveFactor * Math.abs(Math.sin(dist * 4.9 + side)) * 0.03;
        rec.target.rotation.y = -side * (0.12 + 0.16 * dl + flutter);
        rec.target.rotation.z = -side * 0.025 * dl;
      }
    }

    restoreAssembly(cp.spareCover, crash.states.spareCover !== "detached");
    if (crash.states.spareCover === "tilted") {
      const sc = clamp((crash.levels.spareCover - 0.22) / 0.52, 0.18, 1);
      cp.spareCover.target.position.y = cp.spareCover.pristinePos.y - 0.036 * sc;
      cp.spareCover.target.position.z = cp.spareCover.pristinePos.z - 0.018 * sc;
      cp.spareCover.target.rotation.z = (crash.rearLat || 0.72) * 0.35 * sc;
      cp.spareCover.target.rotation.x = -0.17 * sc;
    }

    restoreAssembly(cp.exhaust, crash.states.exhaust !== "detached");
    if (crash.states.exhaust === "sagging") {
      const ex = clamp((crash.levels.exhaust - 0.2) / 0.68, 0.18, 1);
      const rattle = moveFactor * Math.abs(Math.sin(dist * 8.1)) * 0.035;
      cp.exhaust.target.rotation.x = -(0.13 + 0.21 * ex + rattle);
      cp.exhaust.target.rotation.z = (crash.rearLat || -0.5) * 0.085 * ex;
    }

    restoreAssembly(cp.rearPlate, crash.states.rearPlate !== "detached");
    if (crash.states.rearPlate === "dangling") {
      const rp = clamp((crash.levels.rearPlate - 0.2) / 0.62, 0.15, 1);
      cp.rearPlate.target.position.y = cp.rearPlate.pristinePos.y - 0.024 * rp;
      cp.rearPlate.target.rotation.z = -0.28 * rp;
      cp.rearPlate.target.rotation.x = -0.15 * rp;
    }

    for (const [key, rec] of [
      ["headlampLeft", cp.headlamps.left],
      ["headlampRight", cp.headlamps.right],
    ]) {
      const st = crash.states[key];
      if (st === "shattered") {
        rec.material.color.setHex(0x28302d);
        rec.material.emissive.setHex(0x000000);
        rec.material.emissiveIntensity = 0;
      } else if (st === "cracked") {
        rec.material.color.setHex(0x938d7c);
        rec.material.emissive.setHex(0x6d644c);
        rec.material.emissiveIntensity = 0.1;
      } else {
        rec.material.color.setHex(rec.color);
        rec.material.emissive.setHex(rec.emissive);
        rec.material.emissiveIntensity = Math.max(rec.intensity, 0.85);
      }
    }

    setTailLamp(cp.tailLamps.left, crash.states.tailLampLeft);
    setTailLamp(cp.tailLamps.right, crash.states.tailLampRight);
    setChmsl(crash.levels.rearWindow >= 0.92);
    syncLightPools(crash.states, brake);

    cp.cracks.windshield.line.visible = !cutaway && crash.windshieldCracked;
    cp.cracks.windshield.material.opacity = clamp(0.46 + (crash.levels.windshield - 0.42) * 0.85, 0.46, 0.92);
    cp.cracks.rearWindow.line.visible = !cutaway && crash.rearWindowCracked;
    cp.cracks.rearWindow.material.opacity = clamp(0.46 + (crash.levels.rearWindow - 0.42) * 0.85, 0.46, 0.92);
  }

  function damagePanels(vehicle, actor, brake) {
    const damage = vehicle.damage ?? {};
    if (
      previousDamage === PRISTINE_DAMAGE_SIG &&
      cutaway === prevDamageCutaway &&
      (damage.front ?? 0) === 0 &&
      (damage.rear ?? 0) === 0 &&
      (damage.left ?? 0) === 0 &&
      (damage.right ?? 0) === 0 &&
      (damage.impactCount ?? 0) === 0 &&
      !damage.lastImpact &&
      (damage.brokenCount ?? 0) === 0 &&
      (damage.detachedCount ?? 0) === 0 &&
      !hasAnyNonIntactPart(damage.parts)
    ) {
      if (brake !== prevPoolBrake) {
        syncPristineTailBrakes(brake);
      }
      diagnostics.damage.total = finite(damage.total);
      diagnostics.damage.impactCount = 0;
      diagnostics.damage.lastImpact = null;
      return;
    }
    const sides = ["front", "rear", "left", "right"]
      .map((side) => clamp(finite(damage[side]), 0, 1));
    const crash = resolveCrashStates(damage, sides);
    latestCrash = crash;
    const impactSide = damage.lastImpact?.side ?? null;
    const rawLat = finite(damage.lastImpact?.lateralOffsetM, finite(damage.lastImpact?.localX, 0));
    const frontBiasX = (impactSide === "front" || (!impactSide && sides[0] > 0)) ? clamp(rawLat, -0.85, 0.85) : 0;
    const rearBiasX = (impactSide === "rear" || (!impactSide && sides[1] > 0)) ? clamp(rawLat, -0.85, 0.85) : 0;
    const partsKey = Object.values(crash.states).join(",");
    const signature = `${sides.join(":")}:${frontBiasX.toFixed(4)}:${rearBiasX.toFixed(4)}:${partsKey}`;
    const metadata = {
      total: finite(damage.total),
      impactCount: finite(damage.impactCount),
      lastImpact: damage.lastImpact ? { ...damage.lastImpact } : null,
    };
    applyCrashParts(crash, actor, brake);
    prevDamageCutaway = cutaway;
    if (signature === previousDamage) {
      Object.assign(diagnostics.damage, metadata);
      return;
    }
    previousDamage = signature;
    let count = 0, maximum = 0;
    const anySide = sides.some(Boolean);
    for (const { part, origin = [0, 0, 0], pristine, normals, mobility } of model.bodyPanels) {
      const positions = part.geometry.attributes.position;
      const colors = part.geometry.attributes.color;
      if (!anySide) {
        positions.array.set(pristine);
        colors.array.fill(1);
        positions.needsUpdate = true;
        colors.needsUpdate = true;
        part.geometry.attributes.normal.array.set(normals);
        part.geometry.attributes.normal.needsUpdate = true;
        part.geometry.computeBoundingSphere();
        continue;
      }
      const isHood = part.name === "suv-hood";
      const isFrontBumper = part.name === "suv-front-bumper";
      const isRearBumper = part.name === "suv-rear-bumper";
      for (let i = 0; i < positions.count; i++) {
        const lx = pristine[i * 3], ly = pristine[i * 3 + 1], lz = pristine[i * 3 + 2];
        const x = lx + origin[0], y = ly + origin[1], z = lz + origin[2];
        const m = mobility ? mobility[i] : 1;
        if (m === 0) {
          positions.setXYZ(i, lx, ly, lz);
          colors.setXYZ(i, 1, 1, 1);
          continue;
        }
        let dx = 0, dy = 0, dz = 0, weight = 0;
        for (let side = 0; side < 4; side++) {
          if (!sides[side]) continue;
          const end = side < 2;
          const biasX = side === 0 ? frontBiasX : side === 1 ? rearBiasX : 0;
          const acrossTerm = end
            ? biasX !== 0
              ? 0.42 * Math.exp(-((x / 0.88) ** 2) * 1.15) + 0.86 * Math.exp(-(((x - biasX) / 0.5) ** 2) * 1.8)
              : Math.exp(-((x / 0.7) ** 2) * 1.6)
            : Math.exp(-(((z - 0.12) / 0.65) ** 2) * 1.6);
          const depth = end
            ? (z - (side === 0 ? 2.1 : -2.1)) / 0.4
            : (x - (side === 2 ? -0.925 : 0.925)) / 0.22;
          const vertical = (y - (end ? 0.65 : 0.78)) / 0.38;
          const rawInfluence = m * sides[side] * acrossTerm * Math.exp(-depth * depth * 1.5 - vertical * vertical);
          const influence = rawInfluence < 1e-6 ? 0 : rawInfluence;
          if (!influence) continue;
          const crease = 0.9 + 0.1 * Math.cos(x * 23 + y * 17 + z * 11);
          if (end) dz += (side === 0 ? -1 : 1) * influence * 0.24 * crease;
          else dx += (side === 2 ? 1 : -1) * influence * 0.2 * crease;
          weight = Math.max(weight, influence);
        }
        if (isHood && sides[0] > 0.15) {
          const tentFactor = clamp((sides[0] - 0.15) / 0.75, 0, 1);
          const span = Math.exp(-(((z - 1.45) / 0.28) ** 2));
          const acrossTent = frontBiasX
            ? 0.62 + 0.38 * Math.exp(-(((x - frontBiasX * 0.55) / 0.65) ** 2))
            : 0.72 + 0.28 * Math.cos(x * 2.1);
          dy += m * tentFactor * span * acrossTent * 0.092;
          dz -= m * tentFactor * clamp((z - 0.88) / 1.16, 0, 1) * 0.075;
        } else {
          dy -= weight * 0.014;
        }
        if (isFrontBumper && sides[0] > 0.25 && Math.abs(x) >= 0.48) {
          const sagFactor = clamp((sides[0] - 0.25) / 0.65, 0, 1);
          const corner = clamp((Math.abs(x) - 0.46) / 0.38, 0, 1);
          const cornerBias = frontBiasX ? 0.55 + 0.65 * clamp(Math.sign(x) * Math.sign(frontBiasX), 0, 1) : 1;
          dy -= m * sagFactor * corner * cornerBias * 0.055;
          dx += m * Math.sign(x) * sagFactor * corner * 0.024;
        }
        if (isRearBumper && sides[1] > 0.25 && Math.abs(x) >= 0.48) {
          const sagFactor = clamp((sides[1] - 0.25) / 0.65, 0, 1);
          const corner = clamp((Math.abs(x) - 0.46) / 0.38, 0, 1);
          const cornerBias = rearBiasX ? 0.55 + 0.65 * clamp(Math.sign(x) * Math.sign(rearBiasX), 0, 1) : 1;
          dy -= m * sagFactor * corner * cornerBias * 0.058;
          dx += m * Math.sign(x) * sagFactor * corner * 0.022;
        }
        positions.setXYZ(i, lx + dx, ly + dy, lz + dz);
        const distance = Math.hypot(dx, dy, dz);
        if (distance > 0.0001) count++;
        maximum = Math.max(maximum, distance);
        const strain = Math.max(weight, distance * 3.6);
        const scuff = clamp((strain - 0.03) * 3.1, 0, 0.88);
        const primer = clamp((strain - 0.16) * 2.4, 0, 1) * (0.5 + 0.5 * Math.sin(x * 31 - y * 23 + z * 19));
        colors.setXYZ(
          i,
          clamp(1 - scuff * 0.61 - primer * 0.12, 0.18, 1),
          clamp(1 - scuff * 0.63 - primer * 0.1, 0.18, 1),
          clamp(1 - scuff * 0.58 - primer * 0.06, 0.2, 1),
        );
      }
      positions.needsUpdate = true;
      colors.needsUpdate = true;
      part.geometry.computeVertexNormals();
      part.geometry.computeBoundingSphere();
    }
    diagnostics.damage = {
      ...metadata,
      deformedVertices: count,
      maximumDisplacementM: maximum,
      brokenParts: crash.brokenParts,
      detachedParts: crash.detachedParts,
      radiatorExposed: crash.radiatorExposed,
      windshieldCracked: crash.windshieldCracked,
    };
  }

  function syncNitroFlames(actor, stateWrapper = null) {
    const rawIntensity =
      actor?.nitroIntensity ??
      stateWrapper?.player?.nitroIntensity ??
      actor?.vehicle?.nitroIntensity ??
      actor?.vehicle?.controls?.nitroIntensity;
    const nitroActive = Boolean(
      actor?.nitroActive ??
      stateWrapper?.player?.nitroActive ??
      actor?.vehicle?.nitroActive ??
      actor?.vehicle?.controls?.nitro,
    );
    const nitroIntensity = clamp(
      Number.isFinite(rawIntensity) ? rawIntensity : (nitroActive ? 1 : 0),
      0,
      1.5,
    );
    if (nitroIntensity <= 0.01 || cutaway) {
      nitroFlames.visible = false;
      diagnostics.nitro = { active: false, intensity: 0 };
      return;
    }
    nitroFlames.visible = true;
    nitroAnimStep = (nitroAnimStep + 1) % 4096;
    const phase = finite(actor?.distance) * 3.9 + nitroAnimStep * 0.67;
    const flickerL = 0.88 + 0.24 * Math.abs(Math.sin(phase * 13.7));
    const flickerR = 0.88 + 0.24 * Math.abs(Math.cos(phase * 15.3 + 0.9));
    const norm = clamp(nitroIntensity, 0, 1.25);
    const lenScale = 0.46 + 0.94 * norm;
    const radScale = 0.74 + 0.40 * norm;
    nitroPlumeLeft.scale.set(radScale, radScale, lenScale * flickerL);
    nitroPlumeRight.scale.set(radScale, radScale, lenScale * flickerR);
    nitroPlumeLeft.rotation.z = (phase * 1.9) % (Math.PI * 2);
    nitroPlumeRight.rotation.z = -(phase * 2.1 + 0.6) % (Math.PI * 2);
    const gain = clamp(nitroIntensity, 0, 1);
    nitroCoreMat.opacity = 0.56 + 0.40 * gain;
    nitroMidMat.opacity = 0.36 + 0.40 * gain;
    nitroDiamondMat.opacity = 0.28 + 0.34 * gain * flickerL;
    nitroOuterMat.opacity = 0.20 + 0.28 * gain * flickerR;
    nitroGroundPoolMat.opacity = 0.14 + 0.24 * gain * ((flickerL + flickerR) * 0.5);
    diagnostics.nitro = { active: true, intensity: nitroIntensity };
  }

  function update(actorOrState = currentActor, sensors, alpha = 1) {
    if (disposed) return;
    const hasWrappedPlayer =
      actorOrState &&
      typeof actorOrState === "object" &&
      actorOrState.player &&
      typeof actorOrState.player === "object" &&
      actorOrState.id !== "player";
    const actor = hasWrappedPlayer ? actorOrState.player : (actorOrState ?? currentActor ?? {});
    currentActor = actor;
    const t = clamp(finite(alpha, 1), 0, 1);
    const vehicle = actor.vehicle ?? {};
    const prevVehicle = actor.previous?.vehicle ?? null;
    const prevSusp = prevVehicle?.suspension ?? null;
    const currSusp = vehicle.suspension ?? {};
    const currHeave = finite(currSusp.heaveM);
    const currPitch = finite(currSusp.pitchRad);
    const currRoll = finite(currSusp.rollRad);
    const heaveM = prevSusp ? lerpNum(finite(prevSusp.heaveM, currHeave), currHeave, t) : currHeave;
    const pitchRad = prevSusp ? lerpNum(finite(prevSusp.pitchRad, currPitch), currPitch, t) : currPitch;
    const rollRad = prevSusp ? lerpNum(finite(prevSusp.rollRad, currRoll), currRoll, t) : currRoll;
    chassis.position.y = clamp(heaveM, -0.055, 0.055);
    chassis.rotation.set(
      clamp(pitchRad, -0.115, 0.115), 0,
      clamp(rollRad, -0.115, 0.115),
    );
    chassis.updateMatrix();
    const currSpin = finite(vehicle.wheelSpinRad);
    const prevSpin = prevVehicle ? finite(prevVehicle.wheelSpinRad, currSpin) : currSpin;
    const interpSpin = prevVehicle && Math.abs(currSpin - prevSpin) < Math.PI
      ? lerpNum(prevSpin, currSpin, t)
      : currSpin;
    const activeScrape = vehicle.interaction?.scraping;
    const scrapeFlutter =
      activeScrape?.active && Math.abs(finite(actor.speed)) > 0.5
        ? Math.sin(finite(actor.distance) * 19.5) * 0.032 * clamp(finite(activeScrape.intensity), 0, 1)
        : 0;
    for (const wheel of model.wheels) {
      const currSteer = wheel.axle > 0 ? finite(vehicle.wheelAngles?.[wheel.key]) : 0;
      const prevSteer = wheel.axle > 0 && prevVehicle
        ? finite(prevVehicle.wheelAngles?.[wheel.key], currSteer)
        : currSteer;
      const interpSteer = wheel.axle > 0 && prevVehicle ? lerpNum(prevSteer, currSteer, t) : currSteer;
      const isScrapingWheel = Boolean(activeScrape?.active && activeScrape.wheel === wheel.key);
      const wheelCamberJudder = isScrapingWheel ? scrapeFlutter * 0.65 : 0;
      const wheelSteerJudder = isScrapingWheel && wheel.axle > 0 ? scrapeFlutter : 0;
      wheel.pivot.rotation.set(0, interpSteer + wheelSteerJudder, wheelCamberJudder);
      wheel.spin.rotation.set(interpSpin, 0, 0);
      diagnostics.wheels[wheel.key] = {
        center: point(wheel.pivot.position), radiusM: PLAYER_VEHICLE.wheelRadiusM,
        steerRad: wheel.pivot.rotation.y, spinRad: wheel.spin.rotation.x,
        caliperSpinRad: wheel.caliper.rotation.x, spinAxis: { x: 1, y: 0, z: 0 },
      };
    }
    for (const link of model.links) {
      const top = link.upper.clone().applyMatrix4(chassis.matrix);
      const bottom = link.lower.clone();
      if (link.steering) {
        bottom.sub(link.steering.position)
          .applyAxisAngle(UP, link.steering.rotation.y).add(link.steering.position);
      }
      if (link.damper) bottom.lerp(top, 0.45);
      if (link.shaft) top.lerp(bottom, 0.5);
      if (link.spring) { top.lerp(bottom, 0.12); bottom.lerp(top, 0.12); }
      kit.between(link.part, top, bottom);
    }
    model.cockpit.steering.rotation.z = finite(vehicle.steeringWheelRad);
    const speed = finite(actor.speed) * 3.6;
    const gear = vehicle.controls?.gear ?? "N";
    const brake = clamp(finite(vehicle.controls?.brake), 0, 1);
    drawDashboard?.(speed, gear, brake);
    model.cockpit.dashboard.userData.reading = { speedKmh: speed, gear, brake };
    diagnostics.cockpit = {
      steeringWheelRad: model.cockpit.steering.rotation.z,
      speedKmh: speed, gear, brake, leftHandDrive: true,
    };
    damagePanels(vehicle, actor, brake);
    syncNitroFlames(actor, hasWrappedPlayer ? actorOrState : null);
    root.updateWorldMatrix(true, true);
    const inverseRoot = _scratchInvRoot.copy(root.matrixWorld).invert();
    const rays = new Map((sensors?.rays ?? []).map((ray) => [ray.id, ray]));
    const records = model.sensors.ranges.map((record) => {
      const ray = rays.get(record.id);
      const origin = record.position;
      const end = ray?.end ? _scratchVecA.set(ray.end.x, ray.end.y, ray.end.z).applyMatrix4(inverseRoot) : origin;
      const p = record.beam.geometry.attributes.position;
      const arr = p.array;
      if (
        arr[0] !== origin.x ||
        arr[1] !== origin.y ||
        arr[2] !== origin.z ||
        arr[3] !== end.x ||
        arr[4] !== end.y ||
        arr[5] !== end.z
      ) {
        p.setXYZ(0, origin.x, origin.y, origin.z);
        p.setXYZ(1, end.x, end.y, end.z);
        p.needsUpdate = true;
      }
      record.beam.visible = Boolean(ray);
      record.beam.material.color.setHex(ray?.hitId ? 0xe9bb84 : 0xa5d8ba);
      record.hit.visible = Boolean(ray?.hitId);
      record.hit.position.set(end.x, end.y, end.z);
      record.beam.userData.hitId = ray?.hitId ?? null;
      return {
        id: record.id, angleDeg: record.angleDeg,
        localPosition: { ...record.position },
        worldPosition: point(record.lens.getWorldPosition(_scratchVecB)),
        direction: point(record.lens.getWorldDirection(_scratchVecB)),
        rayOrigin: ray?.origin ? { ...ray.origin } : null,
        rayEnd: ray?.end ? { ...ray.end } : null,
        rangeM: finite(ray?.rangeM, PLAYER_VEHICLE.maxRangeM),
        hitId: ray?.hitId ?? null,
      };
    });
    diagnostics.sensors.ranges = records.slice(0, 5);
    diagnostics.sensors.auxiliary = records.slice(5);
    diagnostics.sensors.cameras = model.sensors.cameras.map((camera) => ({
      id: camera.id, angleDeg: camera.angleDeg ?? 0,
      localPosition: { ...camera.position },
      worldPosition: point(camera.lens.getWorldPosition(_scratchVecB)),
      direction: point(camera.lens.getWorldDirection(_scratchVecB)),
    }));
    diagnostics.sensors.camera = diagnostics.sensors.cameras[0];
    diagnostics.sensors.telemetry = model.sensors.telemetry ? {
      worldPosition: point(model.sensors.telemetry.getWorldPosition(_scratchVecB)),
      source: sensors?.imu?.source ?? "simulated-vehicle-state",
    } : null;
    diagnostics.suspension = {
      pitchRad: chassis.rotation.x, rollRad: chassis.rotation.z,
      heaveM: chassis.position.y,
      springLengthsM: Object.fromEntries(model.wheels.map((wheel) => [wheel.key, wheel.spring.scale.y])),
    };
    diagnostics.alpha = t;
  }
  function setInspection(options = {}) {
    if (disposed) return;
    if (typeof options.cutaway === "boolean") {
      cutaway = options.cutaway;
      for (const part of model.cutawayParts) part.visible = !cutaway;
      lightPools.visible = !cutaway;
      syncPartVisibility();
      syncNitroFlames(currentActor);
    }
    if (typeof options.sensors === "boolean") beams.visible = options.sensors;
    diagnostics.cutaway = cutaway;
    diagnostics.sensorVisualization = beams.visible;
  }
  function sync(stateOrActor = currentActor, sensors, alpha = 1) {
    update(stateOrActor, sensors, alpha);
    return root;
  }
  function getCameraPose(mode) {
    const pose = fixedPoses[mode];
    if (!pose) return null;
    return mode === "cockpit" ? {
      position: point(vector(pose.position).applyMatrix4(chassis.matrix)),
      target: point(vector(pose.target).applyMatrix4(chassis.matrix)),
    } : { position: { ...pose.position }, target: { ...pose.target } };
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const group of Object.values(model.resources))
      for (const resource of group) resource.dispose();
    root.removeFromParent();
    root.clear();
    diagnostics.ready = false; diagnostics.disposed = true;
  }
  update(initialActor);
  return { root, nitroFlames, update, sync, setInspection, withExteriorChaseCulling, withSensorOverlayCulling, getCameraPose, dispose, diagnostics };
}
