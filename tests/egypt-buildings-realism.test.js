import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createUnifiedCity } from "../src/core/unified-city.js";
import { createEgyptStreetLayer } from "../src/render/egypt-streets.js";

test("Grand Metro City v5 boulevard & neighborhood towers emit full-height 3D balconies, AC units, shop awnings, and rooftop equipment within GPU budget", (t) => {
  const grandMap = createUnifiedCity({ grand: true });
  const world = {
    ...grandMap,
    environment: "metro",
    config: { cityVersion: 5 },
    player: { ...grandMap.playerStart, speed: 0 },
  };
  const layer = createEgyptStreetLayer(world);
  t.after(() => layer.dispose());

  const { counts, budget, drawCalls, triangles, residentSites } = layer.diagnostics;
  assert.equal(budget.withinBudget, true, `draws=${drawCalls}/${budget.maxDrawCalls}, tris=${triangles}/${budget.maxTriangles}`);
  assert.ok(drawCalls <= budget.maxDrawCalls, `drawCalls ${drawCalls} <= ${budget.maxDrawCalls}`);
  assert.ok(triangles <= budget.maxTriangles, `triangles ${triangles} <= ${budget.maxTriangles}`);
  assert.ok(residentSites >= 8, `expanded v5 detail radius makes nearby boulevard blocks resident (${residentSites})`);
  assert.ok(counts.balconies >= 30, `boulevard & neighborhood v5 towers emit 3D balconies (${counts.balconies})`);
  assert.ok(counts.airConditioners >= 15, `v5 towers emit staggered split AC outdoor units (${counts.airConditioners})`);
  assert.ok(counts.awnings >= 12, `v5 storefronts emit 3D sloped shop awnings (${counts.awnings})`);
  assert.ok(counts.shops >= 18, `v5 ground floors emit commercial storefronts (${counts.shops})`);
  assert.ok(counts.tanks >= 4, `v5 rooftops emit water tanks (${counts.tanks})`);
  assert.ok(counts.dishes >= 4, `v5 rooftops emit satellite dishes (${counts.dishes})`);
});

test("boulevard-only v5 tower has 3D balconies, AC units, shop awnings, and recessed upper-floor reveals above floor 4", (t) => {
  const road = {
    id: "tahrir-boulevard",
    axis: "x",
    fixed: 0,
    min: -120,
    max: 120,
    width: 14,
    laneOffsetM: 2.7,
    speedLimitMps: 10.5,
    zone: "avenue",
    marking: "center",
  };
  const tower = {
    id: "cairo-boulevard-imara-0",
    type: "static",
    kind: "building",
    architecture: "boulevard",
    x: 0,
    z: 22,
    width: 26,
    length: 18,
    height: 38,
    heading: Math.PI,
  };
  const world = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [road],
    drivingRoads: [road],
    statics: [tower],
    player: { x: 0, z: 0 },
  };
  const layer = createEgyptStreetLayer(world, { streamDetails: false });
  t.after(() => layer.dispose());

  assert.ok(layer.diagnostics.counts.balconies >= 6, "boulevard tower must emit 3D balconies");
  assert.ok(layer.diagnostics.counts.airConditioners >= 2, "boulevard tower must emit split AC units");
  assert.ok(layer.diagnostics.counts.awnings >= 2, "boulevard tower must emit 3D shop awnings");
  assert.ok(layer.diagnostics.counts.tanks >= 1 || layer.diagnostics.counts.dishes >= 1, "boulevard tower must emit roof equipment");

  // Verify upper floors (y > 22 m, i.e. above floor 5) have recessed jamb/window structure vertices in structure batch
  const structure = layer.root.children.find((m) => m.name.endsWith("-structure"));
  assert.ok(structure, "structure batch exists");
  const pos = structure.geometry.getAttribute("position");
  const feat = structure.geometry.getAttribute("featureIndex");
  let highFloorWindowOrBalconyVerts = 0;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 22 && (feat.getX(i) === 1 || feat.getX(i) === 2)) {
      highFloorWindowOrBalconyVerts++;
    }
  }
  assert.ok(highFloorWindowOrBalconyVerts >= 24, `upper floors > 22m retain real 3D window reveals & balconies (${highFloorWindowOrBalconyVerts} verts)`);
});

test("terrainElevationAt elevates v5 building roofs, anchors downhill foundation plinths, and conforms street curbs to slopes", (t) => {
  const road = {
    id: "citadel-ramp-avenue",
    axis: "x",
    fixed: 0,
    min: -80,
    max: 80,
    width: 13,
    laneOffsetM: 2.6,
    speedLimitMps: 10,
    zone: "avenue",
    marking: "center",
  };
  const tower = {
    id: "hillside-imara-0",
    type: "static",
    kind: "building",
    architecture: "boulevard",
    x: 30,
    z: 20,
    width: 20,
    length: 16,
    height: 28,
    heading: Math.PI,
  };
  const terrainElevationAt = (x) => Math.max(0, 2.0 + 0.03 * x);
  const flatWorld = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [road],
    drivingRoads: [road],
    statics: [tower],
    player: { x: 30, z: 0 },
  };
  const slopedWorld = { ...flatWorld, terrainElevationAt };

  const flatLayer = createEgyptStreetLayer(flatWorld, { streamDetails: false });
  const slopedLayer = createEgyptStreetLayer(slopedWorld, { streamDetails: false });
  t.after(() => {
    flatLayer.dispose();
    slopedLayer.dispose();
  });

  const expectedSiteLift = terrainElevationAt(tower.x, tower.z); // 2.9 m
  assert.ok(Math.abs(slopedLayer.diagnostics.sites[0].roofY - (flatLayer.diagnostics.sites[0].roofY + expectedSiteLift)) < 1e-4);

  // Foundation plinth extends below local ground so hillside buildings never float
  const slopedStruct = slopedLayer.root.children.find((m) => m.name.endsWith("-structure"));
  slopedStruct.geometry.computeBoundingBox();
  assert.ok(slopedStruct.geometry.boundingBox.min.y < expectedSiteLift - 0.5, "foundation skirt anchors below hillside surface");

  // Curbs follow slope from west (-80 -> elev 0) to east (+80 -> elev 4.4)
  const curbs = slopedLayer.root.getObjectByName("egypt-painted-curb");
  assert.ok(curbs);
  curbs.geometry.computeBoundingBox();
  assert.ok(curbs.geometry.boundingBox.max.y - curbs.geometry.boundingBox.min.y > 3.5, "curb mesh conforms across sloped elevation span");
});

test("Grand Metro City v5 emits segmented alternating Egyptian 3D curbs, cast-iron storm drains, and dark bitumen patches within GPU budget", (t) => {
  const grandMap = createUnifiedCity({ grand: true });
  const world = {
    ...grandMap,
    environment: "metro",
    config: { cityVersion: 5 },
    player: { ...grandMap.playerStart, speed: 0 },
  };
  const layer = createEgyptStreetLayer(world);
  t.after(() => layer.dispose());

  const { counts, budget, drawCalls, triangles, featureNames } = layer.diagnostics;
  assert.equal(budget.withinBudget, true, `draws=${drawCalls}/${budget.maxDrawCalls}, tris=${triangles}/${budget.maxTriangles}`);
  assert.ok(drawCalls <= 75, `resident v5 drawCalls (${drawCalls}) <= 75`);
  assert.ok(triangles <= 260_000, `resident v5 triangles (${triangles}) <= 260,000`);
  assert.ok(counts.curbBlocks > 5000, `v5 emits individual segmented 3D curb stones (${counts.curbBlocks})`);
  assert.ok(counts.drains > 20, `v5 emits curbside cast-iron storm-drain inlets (${counts.drains})`);
  assert.ok(counts.patches > 20, `v5 emits dark bitumen trench repairs (${counts.patches})`);

  const curbMesh = layer.root.getObjectByName("egypt-painted-curb");
  assert.ok(curbMesh, "egypt-painted-curb mesh exists");
  const curbColors = curbMesh.geometry.getAttribute("color");
  const curbFeatures = curbMesh.geometry.getAttribute("featureIndex");
  const curbFeatIdx = featureNames.indexOf("curb");
  let darkCurbLinear = 0, lightCurbLinear = 0;
  let darkCurbSrgb = 0, lightCurbSrgb = 0;
  const srgb = new THREE.Color();
  for (let i = 0; i < curbColors.count; i++) {
    if (curbFeatures.getX(i) !== curbFeatIdx) continue;
    const r = curbColors.getX(i), g = curbColors.getY(i), b = curbColors.getZ(i);
    const linLuma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (linLuma < 0.22) darkCurbLinear++;
    if (linLuma > 0.48) lightCurbLinear++;
    srgb.setRGB(r, g, b).convertLinearToSRGB();
    const srgbLuma = 0.2126 * srgb.r + 0.7152 * srgb.g + 0.0722 * srgb.b;
    if (srgbLuma < 0.22) darkCurbSrgb++;
    if (srgbLuma > 0.48) lightCurbSrgb++;
  }
  assert.ok(darkCurbLinear > 500 && darkCurbSrgb > 500,
    `curb mesh has matte charcoal-black curb stone vertices (lin=${darkCurbLinear}, srgb=${darkCurbSrgb})`);
  assert.ok(lightCurbLinear > 500 && lightCurbSrgb > 500,
    `curb mesh has weathered chalk-limestone/ochre curb stone vertices (lin=${lightCurbLinear}, srgb=${lightCurbSrgb})`);

  const repairMesh = layer.root.getObjectByName("egypt-asphalt-repairs");
  assert.ok(repairMesh, "egypt-asphalt-repairs mesh exists");
  const repairColors = repairMesh.geometry.getAttribute("color");
  const repairFeatures = repairMesh.geometry.getAttribute("featureIndex");
  const patchFeatIdx = featureNames.indexOf("patch");
  const paleLegacyCutout = new THREE.Color(0x424749);
  let patchVerts = 0;
  for (let i = 0; i < repairColors.count; i++) {
    if (repairFeatures.getX(i) !== patchFeatIdx) continue;
    patchVerts++;
    const r = repairColors.getX(i), g = repairColors.getY(i), b = repairColors.getZ(i);
    const sameAsLegacyPale =
      Math.abs(r - paleLegacyCutout.r) < 1e-3 &&
      Math.abs(g - paleLegacyCutout.g) < 1e-3 &&
      Math.abs(b - paleLegacyCutout.b) < 1e-3;
    assert.equal(sameAsLegacyPale, false, "v5 asphalt repairs must never emit pale 0x424749 cutout patches");
    srgb.setRGB(r, g, b).convertLinearToSRGB();
    const srgbLuma = 0.2126 * srgb.r + 0.7152 * srgb.g + 0.0722 * srgb.b;
    assert.ok(srgbLuma < 0.20, `v5 bitumen/tar patch vertex stays dark (srgbLuma=${srgbLuma.toFixed(3)})`);
  }
  assert.ok(patchVerts > 100, `inspected real v5 bitumen patch vertices (${patchVerts})`);
});

test("Grand Metro City v5 muted cinematic Cairo atlas, shopfront vitrine glow, neighborhood drains, and eager district budget", (t) => {
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
  const operations = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(tag) {
        assert.equal(tag, "canvas");
        const ctx = {
          fillRect(...args) { operations.push(["rect", ...args, this.fillStyle]); },
          fillText(...args) { operations.push(["text", ...args, this.fillStyle, this.direction]); },
        };
        return { width: 0, height: 0, getContext: () => ctx };
      },
    },
  });
  t.after(() => {
    if (prevDoc) Object.defineProperty(globalThis, "document", prevDoc);
    else delete globalThis.document;
  });

  const avenue = {
    id: "ramses-avenue",
    axis: "x",
    fixed: 0,
    min: -90,
    max: 90,
    width: 14,
    laneOffsetM: 2.7,
    speedLimitMps: 10.5,
    zone: "avenue",
    marking: "center",
  };
  const sideStreet = {
    id: "sayeda-lane",
    axis: "z",
    fixed: -100,
    min: -45,
    max: 45,
    width: 8,
    laneOffsetM: 1.9,
    speedLimitMps: 7,
    zone: "neighborhood",
    marking: "none",
  };
  const buildings = [
    { id: "cairo-bldg-a", kind: "building", architecture: "boulevard", x: -24, z: 22, width: 28, length: 18, height: 36, heading: Math.PI },
    { id: "cairo-bldg-b", kind: "building", architecture: "neighborhood", x: -114, z: 10, width: 18, length: 14, height: 22, heading: Math.PI / 2 },
  ];
  const eagerLayer = createEgyptStreetLayer(
    { environment: "metro", config: { cityVersion: 5 }, roads: [avenue, sideStreet], statics: buildings, player: { x: 0, z: 0 } },
    { streamDetails: false },
  );
  t.after(() => eagerLayer.dispose());

  assert.equal(eagerLayer.diagnostics.textAtlasAvailable, true);
  assert.equal(eagerLayer.diagnostics.budget.withinBudget, true);
  assert.ok(eagerLayer.diagnostics.drawCalls <= 75);
  assert.ok(eagerLayer.diagnostics.triangles <= 260_000);
  assert.ok(eagerLayer.diagnostics.counts.drains >= 6, "both avenue and neighborhood blocks (>12m) emit storm drains");

  // Verify muted cinematic Cairo atlas palette & warm window / crisp cream signboard typography
  const rectStyles = new Set(operations.filter((op) => op[0] === "rect").map((op) => op.at(-1)));
  const textStyles = new Set(operations.filter((op) => op[0] === "text").map((op) => op.at(-2)));
  for (const expectedHex of ["#9c8f7b", "#a89d8a", "#8e7d67", "#7f5642", "#4a594c", "#22423e", "#6b3527", "#d8aa68", "#232d2e"]) {
    assert.ok(rectStyles.has(expectedHex), `Grand Cairo v5 atlas includes ${expectedHex}`);
  }
  assert.ok(rectStyles.has("rgba(32,26,20,0.22)"), "Grand Cairo v5 masonry includes deep mortar shadow lines");
  assert.ok(textStyles.has("#efe1c2"), "Grand Cairo v5 Arabic shop signs use warm cream typography #efe1c2");

  // Verify warm dusk ground-floor shopfront vitrine glow (0xd9ad6b / 0xc49555) in structure batch
  const structMesh = eagerLayer.root.children.find((m) => m.name.endsWith("-structure"));
  const sColors = structMesh.geometry.getAttribute("color");
  const sFeats = structMesh.geometry.getAttribute("featureIndex");
  const shopGlow = new THREE.Color(0xd9ad6b);
  let glowingVitrineVerts = 0;
  for (let i = 0; i < sColors.count; i++) {
    if (sFeats.getX(i) !== 3) continue;
    if (
      Math.abs(sColors.getX(i) - shopGlow.r) < 1e-3 &&
      Math.abs(sColors.getY(i) - shopGlow.g) < 1e-3 &&
      Math.abs(sColors.getZ(i) - shopGlow.b) < 1e-3
    ) {
      glowingVitrineVerts++;
    }
  }
  assert.ok(glowingVitrineVerts >= 4, `ground-floor shop vitrines emit warm interior dusk glow (${glowingVitrineVerts} verts)`);
});

