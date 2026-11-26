import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { createUnifiedCity } from "../src/core/unified-city.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import {
  DEFAULT_CINEMATIC_GRADE,
  CITY_CLEAR_CINEMATIC_GRADE,
  evaluateCinematicGradePixel,
  createCinematicPost,
} from "../src/render/cinematic-post.js";
import { createSuvModel } from "../src/render/suv-model.js";
import { createPlayerVehicle } from "../src/render/player-vehicle.js";
import {
  WorldView,
  PEDESTRIAN_ANIM_LOD_M,
  PEDESTRIAN_CULL_LOD_M,
} from "../src/render/world-view.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("privacy glazing blocks exterior rays on every side without blocking cockpit rays", () => {
  const model = createSuvModel();
  model.root.updateMatrixWorld(true);
  const cases = [
    ["suv-windshield", [0, 1.4, 3], [0, 1.4, 0]],
    ["suv-rear-window", [0, 1.4, -3], [0, 1.4, -1]],
    ["suv-left-front-window", [-3, 1.4, 0], [0, 1.4, 0]],
    ["suv-right-front-window", [3, 1.4, 0], [0, 1.4, 0]],
  ];
  try {
    for (const [name, outside, inside] of cases) {
      const pane = model.root.getObjectByName(name);
      const start = new THREE.Vector3(...outside), end = new THREE.Vector3(...inside);
      const ray = new THREE.Raycaster(start, end.clone().sub(start).normalize());
      assert.equal(ray.intersectObject(pane).length > 0, true, `${name} conceals cabin`);
      assert.equal(pane.material.transparent, false);
      assert.equal(pane.material.opacity, 1);
      assert.ok(Math.max(...pane.material.color.toArray()) < 0.01, `${name} is black`);
      ray.set(end, start.clone().sub(end).normalize());
      assert.equal(ray.intersectObject(pane).length, 0, `${name} leaves outward view clear`);
    }
  } finally {
    for (const resources of Object.values(model.resources))
      for (const resource of resources) resource.dispose();
  }
});

function luma([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function makeGrandCityWorld(extraActors = []) {
  const grandMap = createUnifiedCity({ dense: true, rush: true, grand: true });
  const player = {
    id: "player",
    type: "vehicle",
    kind: "suv",
    ...grandMap.playerStart,
    y: 0,
    speed: 12.0,
    distance: 0,
    width: PLAYER_VEHICLE.widthM,
    length: PLAYER_VEHICLE.lengthM,
    height: PLAYER_VEHICLE.heightM,
    path: [grandMap.playerStart],
  };
  const terrain = {
    hills: [{ id: "citadel-rise", x: 180, z: -180, radiusX: 120, radiusZ: 110, heightM: 6.5 }],
    waterPuddles: [
      { id: "puddle-1", kind: "water", x: -210, z: -112, heading: Math.PI / 2, halfWidth: 2.8, halfLength: 4.6, depthM: 0.035 },
    ],
    sandZones: [
      { id: "sand-1", kind: "sand", x: 300, z: -210, heading: 0, halfWidth: 4.4, halfLength: 9.0, depthM: 0.03 },
    ],
    cobbleZones: [],
  };
  const world = {
    ...grandMap,
    environment: "metro",
    config: { cityVersion: 5 },
    terrain,
    terrainElevationAt: () => 0,
    actors: [player, ...extraActors],
    player,
    sensors: {},
    routeRevision: 0,
    tick: 0,
    pursuit: null,
  };
  return { world, player };
}

test("CITY_CLEAR_CINEMATIC_GRADE lifts scene exposure, opens shadows, and softens vignette while keeping DEFAULT_CINEMATIC_GRADE intact", () => {
  assert.equal(Object.isFrozen(DEFAULT_CINEMATIC_GRADE), true);
  assert.equal(DEFAULT_CINEMATIC_GRADE.exposure, 0.82);
  assert.equal(DEFAULT_CINEMATIC_GRADE.contrast, 1.26);
  assert.equal(DEFAULT_CINEMATIC_GRADE.shadowToe, 0.085);
  assert.equal(DEFAULT_CINEMATIC_GRADE.saturation, 0.62);
  assert.equal(DEFAULT_CINEMATIC_GRADE.vignette, 0.34);

  assert.equal(Object.isFrozen(CITY_CLEAR_CINEMATIC_GRADE), true);
  assert.ok(
    CITY_CLEAR_CINEMATIC_GRADE.exposure >= 1.08,
    `expected CITY_CLEAR_CINEMATIC_GRADE.exposure >= 1.08, got ${CITY_CLEAR_CINEMATIC_GRADE.exposure}`,
  );
  assert.ok(
    CITY_CLEAR_CINEMATIC_GRADE.shadowToe <= 0.025,
    `expected CITY_CLEAR_CINEMATIC_GRADE.shadowToe <= 0.025, got ${CITY_CLEAR_CINEMATIC_GRADE.shadowToe}`,
  );
  assert.ok(
    CITY_CLEAR_CINEMATIC_GRADE.vignette <= 0.20,
    `expected CITY_CLEAR_CINEMATIC_GRADE.vignette <= 0.20, got ${CITY_CLEAR_CINEMATIC_GRADE.vignette}`,
  );
  assert.equal(CITY_CLEAR_CINEMATIC_GRADE.warmSplit, 0.08);
  assert.equal(CITY_CLEAR_CINEMATIC_GRADE.coolShadows, 0.06);

  const darkStreet = [0.16, 0.16, 0.17];
  const silverBody = [0.76, 0.79, 0.84];
  const defaultShadow = luma(evaluateCinematicGradePixel(darkStreet, [0.5, 0.5], {}, DEFAULT_CINEMATIC_GRADE));
  const clearShadow = luma(evaluateCinematicGradePixel(darkStreet, [0.5, 0.5], {}, CITY_CLEAR_CINEMATIC_GRADE));
  const defaultCorner = luma(evaluateCinematicGradePixel(silverBody, [0.05, 0.05], {}, DEFAULT_CINEMATIC_GRADE));
  const clearCorner = luma(evaluateCinematicGradePixel(silverBody, [0.05, 0.05], {}, CITY_CLEAR_CINEMATIC_GRADE));

  assert.ok(
    clearShadow > defaultShadow * 1.65,
    `expected clear preset to lift street shadows >1.65x (${defaultShadow.toFixed(4)} -> ${clearShadow.toFixed(4)})`,
  );
  assert.ok(
    clearCorner > defaultCorner * 1.25,
    `expected clear preset to brighten peripheral corners >1.25x (${defaultCorner.toFixed(4)} -> ${clearCorner.toFixed(4)})`,
  );

  const stubRenderer = {
    capabilities: { isWebGL2: true },
    outputColorSpace: THREE.SRGBColorSpace,
    autoClear: true,
    getSize(out) {
      return out.set(1280, 720);
    },
    getPixelRatio() {
      return 1;
    },
    getRenderTarget() {
      return null;
    },
    setRenderTarget() {},
    render() {},
  };
  const clearPost = createCinematicPost(stubRenderer, { grade: CITY_CLEAR_CINEMATIC_GRADE });
  assert.equal(clearPost.uniforms.uExposure.value, CITY_CLEAR_CINEMATIC_GRADE.exposure);
  assert.equal(clearPost.uniforms.uShadowToe.value, CITY_CLEAR_CINEMATIC_GRADE.shadowToe);
  assert.equal(clearPost.uniforms.uVignette.value, CITY_CLEAR_CINEMATIC_GRADE.vignette);
  clearPost.dispose();
});

test("styles.css tones down .pursuit-strobe keyframe multipliers (<= 0.28) and confines gradients to slim outer-bezel ellipses (<= 8% width)", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../src/ui/styles.css"), "utf8");

  // No unscaled full-strength `opacity: var(--strobe-intensity, 0)` anywhere in styles.css
  assert.doesNotMatch(css, /opacity:\s*var\(--strobe-intensity[^;)]*\)\s*;/);

  const multipliers = [...css.matchAll(/var\(--strobe-intensity,\s*0\)\s*\*\s*([0-9.]+)/g)].map((m) =>
    Number(m[1]),
  );
  assert.ok(multipliers.length >= 15, `expected >= 15 strobe opacity multipliers, got ${multipliers.length}`);
  for (const factor of multipliers) {
    assert.ok(
      factor > 0 && factor <= 0.28,
      `expected every --strobe-intensity multiplier <= 0.28, found ${factor}`,
    );
  }

  // Extract standalone .pursuit-strobe__red, .pursuit-strobe__blue, and .pursuit-strobe__ambient background blocks
  for (const cls of ["pursuit-strobe__red", "pursuit-strobe__blue", "pursuit-strobe__ambient"]) {
    const blockMatch = css.match(new RegExp(`(?:^|\\n)\\.${cls}\\s*\\{([^}]*background:[^}]*)\\}`, "s"));
    assert.ok(blockMatch, `expected standalone background CSS rule for .${cls}`);
    const ellipses = [...blockMatch[1].matchAll(/ellipse\s+([0-9.]+)%\s+([0-9.]+)%\s+at\s+([0-9.]+)%/g)];
    assert.ok(ellipses.length >= 2, `expected >= 2 bezel ellipses in .${cls}`);
    for (const [, widthPct, , anchorXPct] of ellipses) {
      const w = Number(widthPct);
      const ax = Number(anchorXPct);
      assert.ok(w <= 8, `expected .${cls} ellipse width <= 8%, got ${w}%`);
      assert.ok(ax <= 2.5 || ax >= 97.5, `expected .${cls} ellipse anchored at outer bezel edge, got ${ax}%`);
    }
  }
});

test("PursuitView caps 3D lightbar halo sprite opacity <= 0.30 and localizes cruiser bounce lights to distance <= 15", (t) => {
  const patrols = Array.from({ length: 4 }, (_, idx) => ({
    id: `patrol-${idx}`,
    pursuitRole: "police",
    type: "vehicle",
    kind: "sedan",
    x: idx * 3.5,
    z: -12 - idx * 4,
    y: 0,
    heading: 0,
    speed: 11,
    distance: 5,
    width: 1.88,
    length: 4.55,
    height: 1.52,
  }));
  const { world, player } = makeGrandCityWorld(patrols);
  for (let i = 0; i < patrols.length; i++) {
    patrols[i].x = player.x + (i - 1.5) * 3.2;
    patrols[i].z = player.z - 12 - i * 3.5;
  }
  world.pursuit = { phase: "running", response: {} };

  const view = new WorldView(world);
  t.after(() => view.dispose());

  const redLight = view.scene.getObjectByName("pursuit-bounce-red");
  const blueLight = view.scene.getObjectByName("pursuit-bounce-blue");
  assert.ok(redLight?.isPointLight && blueLight?.isPointLight);
  assert.ok(redLight.distance <= 15, `expected localized red bounce light distance <= 15, got ${redLight.distance}`);
  assert.ok(blueLight.distance <= 15, `expected localized blue bounce light distance <= 15, got ${blueLight.distance}`);
  assert.ok(redLight.decay >= 2.0, `expected physically steep bounce decay >= 2.0, got ${redLight.decay}`);

  const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 600);
  cam.position.set(player.x, 5.5, player.z - 10);
  const haloGroup = view.scene.getObjectByName("pursuit-lightbar-halos");

  let maxObservedHaloOpacity = 0;
  let maxObservedHaloWidth = 0;
  for (let tick = 0; tick < 40; tick += 2) {
    world.tick = tick;
    view.sync(1);
    view.prepareMetro([cam]);
    for (const sprite of haloGroup.children) {
      if (!sprite.isSprite || !sprite.visible) continue;
      maxObservedHaloOpacity = Math.max(maxObservedHaloOpacity, sprite.material.opacity);
      maxObservedHaloWidth = Math.max(maxObservedHaloWidth, sprite.scale.x);
    }
  }

  assert.ok(
    maxObservedHaloOpacity > 0.12 && maxObservedHaloOpacity <= 0.30,
    `expected 3D lightbar halo opacity in (0.12, 0.30], got ${maxObservedHaloOpacity}`,
  );
  assert.ok(
    maxObservedHaloWidth < 1.85,
    `expected compact 3D lightbar halo width < 1.85m, got ${maxObservedHaloWidth}`,
  );
});

test("WorldView illuminates City streets and tracks player SUV with overhead street key light, corridor fill light, and Pearl-Silver Clearcoat body", (t) => {
  const { world, player } = makeGrandCityWorld();
  const view = new WorldView(world);
  t.after(() => view.dispose());

  // 1. Brightened Grand Metro City lights & streetlamp bulb halos
  assert.equal(view.hemiLight.intensity, 0.72);
  assert.ok(view.sun.intensity >= 3.0, `expected sun.intensity >= 3.0, got ${view.sun.intensity}`);
  assert.ok(view.rimLight.intensity >= 1.2, `expected rimLight.intensity >= 1.2, got ${view.rimLight.intensity}`);

  const corridorFill = view.scene.getObjectByName("street-corridor-fill-light");
  const playerKeyLight = view.scene.getObjectByName("player-street-key-light");
  assert.ok(corridorFill?.isDirectionalLight, "street-corridor-fill-light mounted in scene");
  assert.equal(corridorFill.castShadow, false);
  assert.ok(corridorFill.intensity >= 0.9);

  assert.ok(playerKeyLight?.isPointLight, "player-street-key-light mounted in scene");
  assert.equal(playerKeyLight.castShadow, false);
  assert.ok(playerKeyLight.intensity >= 3.5);
  assert.equal(playerKeyLight.distance, 30);

  const bulbHalos = view.streetSurfaces.root.getObjectByName("street-lamp-bulb-halos");
  assert.ok(bulbHalos?.isPoints, "streetlamp overhead bulb halos mounted");
  assert.ok(view.streetSurfaceDiagnostics().lampBulbHaloCount >= 80);
  view.streetSurfaces.setSensorCleanMode(true);
  assert.equal(bulbHalos.visible, false, "sensor clean mode hides bulb halos");
  view.streetSurfaces.setSensorCleanMode(false);
  assert.equal(bulbHalos.visible, true);

  // 2. Tracking verification when player SUV drives across the city
  player.previous = null;
  player.x = 245;
  player.z = -175;
  player.y = 0;
  player.heading = 0.6;
  const playerRoot = view.sync(1);

  assert.ok(Math.abs(playerKeyLight.position.x - 245) < 1e-6);
  assert.ok(Math.abs(playerKeyLight.position.y - (playerRoot.position.y + 7.8)) < 1e-6);
  assert.ok(Math.abs(playerKeyLight.position.z - (-175 - 1.4)) < 1e-6);
  assert.ok(Math.abs(corridorFill.target.position.x - 245) < 1e-6);
  assert.ok(Math.abs(corridorFill.target.position.z - (-175)) < 1e-6);

  // 3. Pearl-Silver Metallic Titanium Clearcoat SUV body paint (luma >= 0.75) + LED lamps
  const suvHood = view.playerRig.root.getObjectByName("suv-hood");
  const suvRoof = view.playerRig.root.getObjectByName("suv-faceted-roof");
  assert.ok(suvHood?.isMesh && suvRoof?.isMesh);
  const paintMat = suvHood.material;
  assert.equal(suvRoof.material, paintMat, "SUV roof shares bright Pearl-Silver body paint");
  assert.equal(paintMat.color.getHex(), 0xdce4ee);
  const paintLuma = luma([paintMat.color.r, paintMat.color.g, paintMat.color.b]);
  assert.ok(paintLuma >= 0.75, `expected Pearl-Silver SUV paint linear luma >= 0.75, got ${paintLuma.toFixed(4)}`);
  assert.equal(paintMat.metalness, 0.42);
  assert.equal(paintMat.roughness, 0.24);
  assert.equal(paintMat.clearcoat, 0.85);
  assert.equal(paintMat.clearcoatRoughness, 0.14);
  assert.equal(paintMat.envMapIntensity, 1.45);

  const standaloneSuv = createSuvModel();
  assert.equal(standaloneSuv.root.getObjectByName("suv-hood").material.color.getHex(), 0xdce4ee);
  assert.ok(
    standaloneSuv.crashParts.headlamps.left.material.emissiveIntensity >= 1.5,
    "bright crisp white LED headlights",
  );
  assert.ok(
    standaloneSuv.crashParts.tailLamps.left.material.emissiveIntensity >= 1.0,
    "vivid ruby LED tail-bars",
  );
});

test("PlayerVehicle player-nitro-flames stays hidden when idle, ignites twin additive exhaust cones on nitro, and hides during withExteriorChaseCulling", (t) => {
  const rig = createPlayerVehicle(null, {
    id: "player",
    kind: "suv",
    width: PLAYER_VEHICLE.widthM,
    length: PLAYER_VEHICLE.lengthM,
    pearlClearcoat: true,
  });
  t.after(() => rig.dispose());

  const nitroGroup = rig.root.getObjectByName("player-nitro-flames");
  assert.ok(nitroGroup?.isGroup, "player-nitro-flames group mounted on SUV");
  assert.equal(nitroGroup.visible, false, "idle vehicle has 0 visible nitro draw calls");

  // Negative control: nitroIntensity <= 0.01 keeps flames hidden
  rig.sync({ player: { id: "player", nitroIntensity: 0.005, nitroActive: false, speed: 10, distance: 4 } });
  assert.equal(nitroGroup.visible, false);

  // Positive 1: nitroIntensity > 0.1 activates twin additive Mach cones and scales with intensity
  rig.sync({ player: { id: "player", nitroIntensity: 0.35, nitroActive: true, speed: 18, distance: 12 } });
  assert.equal(nitroGroup.visible, true);
  const leftPlume = nitroGroup.getObjectByName("nitro-plume-left");
  const rightPlume = nitroGroup.getObjectByName("nitro-plume-right");
  assert.ok(leftPlume && rightPlume);
  const lowLen = leftPlume.scale.z;

  rig.sync({ player: { id: "player", nitroIntensity: 1.0, nitroActive: true, speed: 28, distance: 12 } });
  assert.ok(
    leftPlume.scale.z > lowLen,
    `expected full nitro plume length (${leftPlume.scale.z.toFixed(3)}) > partial nitro (${lowLen.toFixed(3)})`,
  );

  let additiveMeshes = 0;
  nitroGroup.traverse((child) => {
    if (child.isMesh) {
      additiveMeshes++;
      assert.equal(child.material.blending, THREE.AdditiveBlending);
      assert.equal(child.material.depthWrite, false);
    }
  });
  assert.ok(additiveMeshes >= 8, `expected twin layered nitro cones + pool, got ${additiveMeshes} meshes`);

  // Positive 2: visible on exterior chase camera, hidden during AI sensor pass (withSensorOverlayCulling)
  let visibleOnExteriorChaseCam = false;
  rig.withExteriorChaseCulling(() => {
    visibleOnExteriorChaseCam = nitroGroup.visible;
  });
  assert.equal(visibleOnExteriorChaseCam, true, "player-nitro-flames remains visible on exterior chase camera");

  let visibleInsideVisionPass = true;
  rig.withSensorOverlayCulling(() => {
    visibleInsideVisionPass = nitroGroup.visible;
  });
  assert.equal(visibleInsideVisionPass, false, "player-nitro-flames hidden during withSensorOverlayCulling");
  assert.equal(nitroGroup.visible, true, "player-nitro-flames restored immediately after withSensorOverlayCulling");

  // Positive 3: returning to nitroIntensity = 0 turns flames cleanly off
  rig.update({ id: "player", nitroIntensity: 0, nitroActive: false, speed: 14, distance: 20 });
  assert.equal(nitroGroup.visible, false);
});

test("WorldView 3-tier pedestrian LOD culls >135m pedestrians and skips 75..135m limb swing across 215+ live pedestrians", (t) => {
  assert.equal(PEDESTRIAN_ANIM_LOD_M, 75);
  assert.equal(PEDESTRIAN_CULL_LOD_M, 135);

  // Build 216 live pedestrians spanning near (<=75m), mid (75..135m), and far (>135m) tiers
  const peds = [];
  for (let i = 0; i < 216; i++) {
    const tier = i % 3;
    const dist = tier === 0 ? 18 + (i % 40) : tier === 1 ? 82 + (i % 45) : 148 + i;
    peds.push({
      id: `ped-${i}`,
      type: "pedestrian",
      kind: "commuter-jacket",
      x: dist,
      z: 0,
      heading: 0.4,
      speed: 1.35,
      distance: i * 0.5,
      body: { widthM: 0.51, heightM: 1.78, depthM: 0.32 },
    });
  }

  // 1. Grand Metro City v5 prepareMetro culls >135m pedestrians from silhouettes & roots
  const { world: metroWorld, player: metroPlayer } = makeGrandCityWorld(peds);
  metroPlayer.x = 0;
  metroPlayer.z = 0;
  for (const p of peds) {
    p.z = metroPlayer.z;
  }
  const metroView = new WorldView(metroWorld, { loadAsset: () => new Promise(() => {}) });
  t.after(() => metroView.dispose());

  const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 600);
  cam.position.set(0, 5, -8);
  metroView.sync(1);
  metroView.prepareMetro([cam]);

  const actorDiag = metroView.actorDiagnostics();
  assert.equal(actorDiag.ready, true);
  assert.equal(actorDiag.culledPedestrians, 72, "all 72 far (>135m) pedestrians culled immediately");
  const silCount = metroView.metroSilhouettes.groups.get("pedestrian")?.mesh?.count ?? 0;
  assert.ok(silCount <= 144, `expected silhouette instance count <= 144 (got ${silCount})`);

  // 2. syncPedestrians 3-tier verification: <=75m animates rig, 75..135m skips rig update, >135m sets root.visible=false
  const nearPed = { id: "ped-near", type: "pedestrian", kind: "commuter-jacket", x: 30, z: 0, heading: 0.2, speed: 1.4 };
  const midPed = { id: "ped-mid", type: "pedestrian", kind: "commuter-jacket", x: 96, z: 0, heading: 0.5, speed: 1.4 };
  const farPed = { id: "ped-far", type: "pedestrian", kind: "commuter-jacket", x: 165, z: 0, heading: 0.9, speed: 1.4 };
  const labPlayer = {
    id: "player",
    type: "vehicle",
    kind: "suv",
    x: 0,
    z: 0,
    y: 0,
    heading: 0,
    speed: 0,
    width: PLAYER_VEHICLE.widthM,
    length: PLAYER_VEHICLE.lengthM,
    path: [{ x: 0, z: 0 }],
  };
  const nonMetroWorld = {
    environment: "vision",
    roads: [{ id: "r0", axis: "x", fixed: 0, min: -300, max: 300, width: 12 }],
    statics: [],
    junctions: [],
    actors: [labPlayer, nearPed, midPed, farPed],
    player: labPlayer,
    sensors: {},
    routeRevision: 0,
    tick: 10,
  };
  const nonMetroView = new WorldView(nonMetroWorld, { loadAsset: () => new Promise(() => {}) });
  t.after(() => nonMetroView.dispose());

  let nearRigCalls = 0;
  let midRigCalls = 0;
  let farRigCalls = 0;
  nonMetroView.roots.get("ped-near").pedestrianRig = { update() { nearRigCalls++; }, dispose() {} };
  nonMetroView.roots.get("ped-mid").pedestrianRig = { update() { midRigCalls++; }, dispose() {} };
  nonMetroView.roots.get("ped-far").pedestrianRig = { update() { farRigCalls++; }, dispose() {} };

  const culled = nonMetroView.syncPedestrians(1, cam);
  assert.equal(culled, 1);
  assert.equal(nonMetroView.roots.get("ped-near").root.visible, true);
  assert.equal(nonMetroView.roots.get("ped-mid").root.visible, true);
  assert.equal(nonMetroView.roots.get("ped-far").root.visible, false);
  assert.equal(nearRigCalls, 1, "pedestrian within 75m runs full limb animation");
  assert.equal(midRigCalls, 0, "pedestrian in 75..135m skips per-limb bone updates");
  assert.equal(farRigCalls, 0, "pedestrian beyond 135m culled before bone updates");
  assert.equal(midPed.x, 96, "pedestrian world coordinates stay intact for forecast ghosts");
});
