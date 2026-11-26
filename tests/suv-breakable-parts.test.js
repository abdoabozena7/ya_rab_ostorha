import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as THREE from "three";
import { createPlayerVehicle } from "../src/render/player-vehicle.js";
import { applyLocalizedPartDamage, createVehicleState } from "../src/core/vehicle-state.js";

const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} should be within ${tolerance} of ${expected}`,
  );

function makeActor() {
  return {
    id: "player",
    type: "vehicle",
    x: 0,
    z: 0,
    heading: 0,
    distance: 0,
    length: 4.2,
    width: 1.85,
    speed: 0,
    vehicle: createVehicleState(),
  };
}

function fixture(t, actor = makeActor()) {
  const rig = createPlayerVehicle(null, actor);
  const parent = new THREE.Group();
  parent.position.set(actor.x, 0.12 + (actor.y ?? 0), actor.z);
  parent.rotation.y = actor.heading;
  parent.add(rig.root);
  rig.update(actor);
  t.after(() => rig.dispose());
  return { rig, actor, parent };
}

function geometryHash(root) {
  const hash = createHash("sha256");
  root.traverse((part) => {
    if (!part.geometry) return;
    for (const name of ["position", "normal", "color"]) {
      const a = part.geometry.attributes[name];
      if (a) hash.update(Buffer.from(a.array.buffer, a.array.byteOffset, a.array.byteLength));
    }
  });
  return hash.digest("hex");
}

function captureTransforms(root, names) {
  return Object.fromEntries(
    names.map((name) => {
      const obj = root.getObjectByName(name);
      assert.ok(obj, `expected object ${name}`);
      return [
        name,
        {
          pos: obj.position.toArray(),
          rot: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
          scale: obj.scale.toArray(),
          visible: obj.visible,
        },
      ];
    }),
  );
}

test("authored under-hood, exterior, and cockpit details preserve roof height, RGB rays, cutaway, and single disposal", (t) => {
  const { rig } = fixture(t);
  const requiredNames = [
    "suv-radiator-core",
    "suv-crash-bar",
    "suv-battery-box",
    "suv-coolant-hose",
    "suv-tow-hook-left",
    "suv-tow-hook-right",
    "suv-left-fender-vent",
    "suv-right-fender-vent",
    "suv-left-mirror-glass",
    "suv-right-mirror-glass",
    "suv-fuel-door",
    "suv-muffler",
    "suv-exhaust-left",
    "suv-exhaust-right",
    "suv-rear-plate",
    "suv-chmsl",
    "cockpit-pedal-throttle",
    "cockpit-pedal-brake",
    "cockpit-center-screen",
    "cockpit-rearview-mirror",
    "suv-windshield-cracks",
    "suv-rear-window-cracks",
  ];
  for (const name of requiredNames) {
    assert.ok(rig.root.getObjectByName(name), `missing authored SUV detail: ${name}`);
  }

  assert.equal(rig.root.getObjectByName("suv-windshield-cracks").visible, false);
  assert.equal(rig.root.getObjectByName("suv-rear-window-cracks").visible, false);

  const roof = rig.root.getObjectByName("suv-faceted-roof");
  close(new THREE.Box3().setFromObject(roof).max.y, 0.12 + 1.82, 1e-6);

  const opaque = [];
  rig.root.traverseVisible((part) => {
    if (part.isMesh && !part.material.transparent) opaque.push(part);
  });
  for (const [mode, lensName, sign] of [
    ["sensor", "sensor-front-camera", 1],
    ["sensor-rear", "sensor-rear-camera", -1],
  ]) {
    const pose = rig.getCameraPose(mode);
    const lens = rig.root.getObjectByName(lensName);
    const dir = new THREE.Vector3(0, 0, sign);
    close(
      new THREE.Vector3(
        pose.target.x - pose.position.x,
        pose.target.y - pose.position.y,
        pose.target.z - pose.position.z,
      ).normalize().distanceTo(dir),
      0,
    );
    const ray = new THREE.Raycaster(lens.getWorldPosition(new THREE.Vector3()), dir, 0.025, 20);
    assert.equal(ray.intersectObjects(opaque, false).length, 0, `${lensName} ray must stay clear`);
  }

  rig.setInspection({ cutaway: true });
  for (const hidden of ["suv-hood", "suv-chmsl", "cockpit-rearview-mirror", "suv-left-mirror-glass"]) {
    assert.equal(rig.root.getObjectByName(hidden).visible, false, `${hidden} should hide in cutaway`);
  }
  for (const exposed of ["suv-radiator-core", "suv-crash-bar", "suv-battery-box", "cockpit-pedal-brake", "cockpit-center-screen"]) {
    assert.equal(rig.root.getObjectByName(exposed).visible, true, `${exposed} should stay visible in cutaway`);
  }
  rig.setInspection({ cutaway: false });
  assert.equal(rig.root.getObjectByName("suv-windshield-cracks").visible, false);
  assert.equal(rig.root.getObjectByName("suv-chmsl").visible, true);

  const standalone = createPlayerVehicle(null, makeActor());
  const resources = new Set();
  standalone.root.traverse((part) => {
    if (part.geometry) resources.add(part.geometry);
    if (part.material) resources.add(part.material);
  });
  const disposeCounts = new Map([...resources].map((res) => [res, 0]));
  for (const res of resources) {
    res.addEventListener("dispose", () => disposeCounts.set(res, disposeCounts.get(res) + 1));
  }
  standalone.dispose();
  standalone.dispose();
  assert.ok([...disposeCounts.values()].every((n) => n === 1), "every geometry and material must dispose once");
});

test("progressive front crash tents & unlatches hood, shatters corner headlamp, cracks windshield, then detaches hood & plate while keeping skid bolted", (t) => {
  const { rig, actor } = fixture(t);
  const hood = rig.root.getObjectByName("suv-hood");
  const hoodPivot = rig.root.getObjectByName("suv-hood-pivot");
  const bumper = rig.root.getObjectByName("suv-front-bumper");
  const skid = rig.root.getObjectByName("suv-front-skid");
  const frontPlate = rig.root.getObjectByName("suv-front-plate");
  const grille = rig.root.getObjectByName("suv-grille-lattice");
  const radiator = rig.root.getObjectByName("suv-radiator-core");
  const wsCracks = rig.root.getObjectByName("suv-windshield-cracks");
  const leftLamp = rig.root.getObjectByName("suv-headlamp--1-0.895");
  const rightLamp = rig.root.getObjectByName("suv-headlamp-1-0.895");

  const hoodPristine = hood.geometry.attributes.position.array.slice();
  const bumperPristine = bumper.geometry.attributes.position.array.slice();
  const skidPristinePos = skid.position.clone();
  const rangeLensBefore = rig.root.getObjectByName("sensor-range-center").getWorldPosition(new THREE.Vector3());
  const frontCamBefore = rig.root.getObjectByName("sensor-front-camera").getWorldPosition(new THREE.Vector3());

  // Negative control: while pristine, closed hood hides suv-radiator-core from above
  const pristineVisible = [];
  rig.root.traverseVisible((part) => {
    if (part.isMesh) pristineVisible.push(part);
  });
  const closedRay = new THREE.Raycaster(new THREE.Vector3(0, 0.12 + 1.45, 1.88), new THREE.Vector3(0, -1, 0));
  assert.equal(closedRay.intersectObjects(pristineVisible, false)[0]?.object?.name, "suv-hood");

  // Medium front-left corner impact (front = 0.45)
  actor.vehicle.damage = {
    ...actor.vehicle.damage,
    front: 0.45,
    total: 0.45,
    impactCount: 1,
    lastImpact: { side: "front", lateralOffsetM: -0.55, closingSpeedMps: 6.5, energyJ: 20250, tick: 12 },
  };
  rig.update(actor);

  // Hood tents upward mid-span (around z ≈ 1.45 -> local lz ≈ 0.585) and hinges open from cowl
  const hoodPos = hood.geometry.attributes.position;
  let tentedMidSpan = 0;
  for (let i = 0; i < hoodPos.count; i++) {
    const lz = hoodPristine[i * 3 + 2];
    const zChassis = lz + 0.88;
    if (Math.abs(zChassis - 1.465) < 0.12 && hoodPos.getY(i) > hoodPristine[i * 3 + 1] + 0.015) {
      tentedMidSpan++;
    }
  }
  assert.ok(tentedMidSpan >= 4, "hood mid-span around z ≈ 1.45 must tent upward like creased sheet metal");
  assert.ok(hoodPivot.rotation.x < -0.08, "hood pivot must hinge open at cowl (negative X rotation)");
  assert.equal(hood.visible, true);
  assert.equal(rig.diagnostics.damage.radiatorExposed, true);

  // Asymmetric headlamp shattering on left-front corner hit
  assert.notEqual(leftLamp.material, rightLamp.material);
  assert.equal(leftLamp.material.emissiveIntensity, 0, "struck left headlamp must shatter dark");
  assert.ok(rightLamp.material.emissiveIntensity > 0.3, "unhit right headlamp must remain lit");

  // Windshield spiderweb cracks visible; grille crooked; front plate still attached but crooked
  assert.equal(wsCracks.visible, true);
  assert.equal(rig.diagnostics.damage.windshieldCracked, true);
  assert.ok(grille.position.z < 2.075 && grille.rotation.x > 0.02);
  assert.equal(frontPlate.visible, true);
  assert.notEqual(frontPlate.rotation.z, 0);

  // Speed-driven deterministic flutter vs stationary stability
  const stationaryAngle = hoodPivot.rotation.x;
  const stationaryHash = geometryHash(rig.root);
  rig.update(actor);
  assert.equal(hoodPivot.rotation.x, stationaryAngle);
  assert.equal(geometryHash(rig.root), stationaryHash);

  actor.speed = 9;
  actor.distance = 1.25;
  rig.update(actor);
  assert.ok(hoodPivot.rotation.x < stationaryAngle, "moving unlatched hood should flutter further open");
  actor.speed = 0;
  actor.distance = 0;
  rig.update(actor);
  close(hoodPivot.rotation.x, stationaryAngle, 1e-9);

  // Heavy front crash (front = 0.90): hood & front plate detach, revealing radiator core directly
  actor.vehicle.damage = {
    ...actor.vehicle.damage,
    front: 0.9,
    total: 0.9,
    impactCount: 2,
    lastImpact: { side: "front", lateralOffsetM: 0, closingSpeedMps: 11, energyJ: 42000, tick: 25 },
  };
  rig.update(actor);

  assert.equal(hood.visible, false, "heavy front crash must detach suv-hood");
  assert.equal(frontPlate.visible, false, "heavy front crash must detach suv-front-plate");
  assert.ok(rig.diagnostics.damage.detachedParts.includes("hood"));
  assert.ok(rig.diagnostics.damage.detachedParts.includes("frontPlate"));
  assert.equal(rig.diagnostics.damage.radiatorExposed, true);

  // Overhead sightline into the open engine bay hits suv-radiator-core once suv-hood detaches
  const visibleMeshes = [];
  rig.root.traverseVisible((part) => {
    if (part.isMesh) visibleMeshes.push(part);
  });
  const radiatorWorld = radiator.getWorldPosition(new THREE.Vector3());
  const sightRay = new THREE.Raycaster(
    new THREE.Vector3(radiatorWorld.x, 0.12 + 1.45, radiatorWorld.z),
    new THREE.Vector3(0, -1, 0),
  );
  const hits = sightRay.intersectObjects(visibleMeshes, false);
  assert.equal(hits[0]?.object?.name, "suv-radiator-core", "detached hood must visibly expose suv-radiator-core");

  // Skid plate, lower bumper center flange, outer bumper sag, and rigid sensor mounts
  assert.deepEqual(skid.position, skidPristinePos, "suv-front-skid must remain bolted");
  const bumperPos = bumper.geometry.attributes.position;
  let pinnedFlange = 0;
  let saggedOuterCorner = 0;
  for (let i = 0; i < bumperPos.count; i++) {
    const [bx, by, bz] = bumperPristine.slice(i * 3, i * 3 + 3);
    if (Math.abs(bx) < 0.4 && by < 0.435) {
      assert.deepEqual([bumperPos.getX(i), bumperPos.getY(i), bumperPos.getZ(i)], [bx, by, bz]);
      pinnedFlange++;
    }
    if (Math.abs(bx) >= 0.48 && bumperPos.getY(i) < by - 0.015) {
      saggedOuterCorner++;
    }
  }
  assert.ok(pinnedFlange > 3, "lower center bumper flange must stay pinned to skid");
  assert.ok(saggedOuterCorner > 4, "outer front bumper corners must sag downward");
  close(rig.root.getObjectByName("sensor-range-center").getWorldPosition(new THREE.Vector3()).distanceTo(rangeLensBefore), 0);
  close(rig.root.getObjectByName("sensor-front-camera").getWorldPosition(new THREE.Vector3()).distanceTo(frontCamBefore), 0);
});

test("side impact dangles then detaches struck mirror only, and rear impact dents hatch, tilts/detaches spare cover, sags exhaust, and cracks rear glass", (t) => {
  const { rig, actor } = fixture(t);
  const leftMirror = rig.root.getObjectByName("suv-left-mirror");
  const rightMirror = rig.root.getObjectByName("suv-right-mirror");
  const leftCladding = rig.root.getObjectByName("suv-left-door-cladding");
  const rightCladding = rig.root.getObjectByName("suv-right-door-cladding");
  const hatch = rig.root.getObjectByName("suv-rear-hatch");
  const spareTire = rig.root.getObjectByName("suv-rear-spare");
  const spareCover = rig.root.getObjectByName("suv-spare-cover");
  const spareCoverPivot = rig.root.getObjectByName("suv-spare-cover-pivot");
  const exhaustLeft = rig.root.getObjectByName("suv-exhaust-left");
  const rearCracks = rig.root.getObjectByName("suv-rear-window-cracks");
  const leftTail = rig.root.getObjectByName("suv-rear-lamp--1");
  const rightTail = rig.root.getObjectByName("suv-rear-lamp-1");
  const chmsl = rig.root.getObjectByName("suv-chmsl");

  const leftMirrorRestY = leftMirror.getWorldPosition(new THREE.Vector3()).y;
  const rightMirrorRestPos = rightMirror.getWorldPosition(new THREE.Vector3());
  const exhaustRestY = exhaustLeft.getWorldPosition(new THREE.Vector3()).y;
  const hatchPristine = hatch.geometry.attributes.position.array.slice();

  // Medium left side impact: dangles left mirror & loosens left cladding; right side untouched
  actor.vehicle.damage = {
    ...actor.vehicle.damage,
    left: 0.42,
    total: 0.42,
    impactCount: 1,
    lastImpact: { side: "left", closingSpeedMps: 5.5, energyJ: 19000, tick: 5 },
  };
  rig.update(actor);

  assert.equal(leftMirror.visible, true);
  assert.ok(
    leftMirror.getWorldPosition(new THREE.Vector3()).y < leftMirrorRestY - 0.04,
    "dangling left mirror must drop downward",
  );
  assert.notEqual(leftCladding.rotation.z, 0, "struck door cladding must pull loose");
  close(rightMirror.getWorldPosition(new THREE.Vector3()).distanceTo(rightMirrorRestPos), 0);
  assert.equal(rightCladding.rotation.z, 0);

  // Heavy left side impact: detaches left mirror without affecting right mirror
  actor.vehicle.damage = {
    ...actor.vehicle.damage,
    left: 0.85,
    total: 0.85,
    impactCount: 2,
  };
  rig.update(actor);
  assert.equal(leftMirror.visible, false);
  assert.equal(rightMirror.visible, true);
  assert.ok(rig.diagnostics.damage.detachedParts.includes("mirrorLeft"));
  assert.ok(!rig.diagnostics.damage.detachedParts.includes("mirrorRight"));

  // Medium rear-left corner impact with braking: tilts spare cover, sags exhaust, cracks rear glass, shatters left tail lamp
  actor.vehicle.controls.brake = 0.9;
  actor.vehicle.damage = {
    ...actor.vehicle.damage,
    rear: 0.5,
    total: 0.92,
    impactCount: 3,
    lastImpact: { side: "rear", lateralOffsetM: -0.55, closingSpeedMps: 6.8, energyJ: 22500, tick: 18 },
  };
  rig.update(actor);

  const hatchPos = hatch.geometry.attributes.position;
  let hatchDented = 0;
  for (let i = 0; i < hatchPos.count; i++) {
    if (hatchPos.getZ(i) > hatchPristine[i * 3 + 2] + 0.01) hatchDented++;
  }
  assert.ok(hatchDented > 3, "rear impact must dent suv-rear-hatch inward (+Z)");
  assert.equal(spareCover.visible, true);
  assert.notEqual(spareCoverPivot.rotation.z, 0, "medium rear hit must tilt spare cover askew");
  assert.ok(
    exhaustLeft.getWorldPosition(new THREE.Vector3()).y < exhaustRestY - 0.03,
    "rear impact must sag exhaust tailpipes downward",
  );
  assert.equal(rearCracks.visible, true, "rear window spiderweb cracks must appear");
  assert.equal(leftTail.material.emissiveIntensity, 0, "struck left tail lamp must shatter");
  assert.ok(rightTail.material.emissiveIntensity > 0.9, "intact right tail lamp must glow brightly under braking");
  assert.ok(chmsl.material.emissiveIntensity > 0.9, "intact CHMSL must glow brightly under braking");

  // Heavy rear impact via core applyLocalizedPartDamage: detaches spare cover, revealing rubber spare tire
  const coreDamage = createVehicleState().damage;
  coreDamage.rear = 0.92;
  coreDamage.total = 0.92;
  coreDamage.impactCount = 1;
  applyLocalizedPartDamage(coreDamage, { side: "rear", energyJ: 43000, lateralOffsetM: 0 });
  actor.vehicle.damage = coreDamage;
  rig.update(actor);

  assert.equal(spareCover.visible, false, "heavy rear crash must detach spare cover");
  assert.equal(spareTire.visible, true, "rubber spare tire underneath must remain visible");
  assert.ok(rig.diagnostics.damage.detachedParts.includes("spareCover"));
});

test("resetting actor.vehicle to createVehicleState() restores geometryHash byte-for-byte and resets all articulated parts", (t) => {
  const { rig, actor } = fixture(t);
  const trackedNames = [
    "suv-hood-pivot",
    "suv-hood",
    "suv-radiator-core",
    "suv-crash-bar",
    "suv-left-mirror-pivot",
    "suv-left-mirror",
    "suv-right-mirror-pivot",
    "suv-right-mirror",
    "suv-grille-lattice",
    "suv-front-plate",
    "suv-rear-plate",
    "suv-left-door-cladding",
    "suv-right-door-cladding",
    "suv-spare-cover-pivot",
    "suv-spare-cover",
    "suv-exhaust-pivot",
    "suv-windshield-cracks",
    "suv-rear-window-cracks",
  ];
  const pristineHash = geometryHash(rig.root);
  const pristineTransforms = captureTransforms(rig.root, trackedNames);
  const leftLamp = rig.root.getObjectByName("suv-headlamp--1-0.895");
  const leftTail = rig.root.getObjectByName("suv-rear-lamp--1");
  const pristineLampIntensity = leftLamp.material.emissiveIntensity;
  const pristineTailIntensity = leftTail.material.emissiveIntensity;

  // Inflict catastrophic multi-side crash
  actor.speed = 8;
  actor.distance = 14.2;
  actor.vehicle.controls.brake = 1;
  actor.vehicle.damage = {
    ...actor.vehicle.damage,
    front: 0.95,
    rear: 0.92,
    left: 0.88,
    right: 0.48,
    total: 0.999,
    impactCount: 4,
    lastImpact: { side: "front", lateralOffsetM: -0.5, closingSpeedMps: 14, energyJ: 52000, tick: 40 },
  };
  rig.update(actor);

  assert.notEqual(geometryHash(rig.root), pristineHash);
  assert.ok(rig.diagnostics.damage.brokenParts.length >= 10);
  assert.ok(rig.diagnostics.damage.detachedParts.length >= 4);
  assert.equal(rig.root.getObjectByName("suv-hood").visible, false);
  assert.equal(rig.root.getObjectByName("suv-spare-cover").visible, false);
  assert.equal(rig.root.getObjectByName("suv-windshield-cracks").visible, true);

  // Reset vehicle state to pristine
  actor.speed = 0;
  actor.distance = 0;
  actor.vehicle = createVehicleState();
  rig.update(actor);

  assert.equal(geometryHash(rig.root), pristineHash, "all geometry buffers must match pristine bytes");
  assert.deepEqual(captureTransforms(rig.root, trackedNames), pristineTransforms);
  assert.equal(leftLamp.material.emissiveIntensity, pristineLampIntensity);
  assert.equal(leftTail.material.emissiveIntensity, pristineTailIntensity);
  assert.deepEqual(rig.diagnostics.damage, {
    total: 0,
    impactCount: 0,
    lastImpact: null,
    deformedVertices: 0,
    maximumDisplacementM: 0,
    brokenParts: [],
    detachedParts: [],
    radiatorExposed: false,
    windshieldCracked: false,
  });
});
