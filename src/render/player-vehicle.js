import * as THREE from "three";
import { PLAYER_VEHICLE } from "../core/vehicle-spec.js";
import { createSuvModel } from "./suv-model.js";

const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const vector = (p) => new THREE.Vector3(p.x, p.y, p.z);
const point = (p) => ({ x: p.x, y: p.y, z: p.z });
const UP = new THREE.Vector3(0, 1, 0);

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

export function createPlayerVehicle(_templateScene, initialActor = {}) {
  const model = createSuvModel(initialActor);
  const { root, chassis, kit } = model;
  const drawDashboard = dashboardPainter(model);
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
  const diagnostics = {
    asset: "Original faceted SUV",
    ready: true, disposed: false, cutaway: false, sensorVisualization: false,
    coordinates: "+X right, +Y up, +Z forward; metres/radians",
    wheels: {}, cockpit: {}, sensors: { ranges: [], auxiliary: [], cameras: [] },
    damage: { total: 0, deformedVertices: 0, maximumDisplacementM: 0 },
  };
  let currentActor = initialActor;
  let disposed = false, cutaway = false, previousDamage = "0:0:0:0";
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

  function damagePanels(vehicle) {
    const damage = vehicle.damage ?? {};
    const sides = ["front", "rear", "left", "right"]
      .map((side) => clamp(finite(damage[side]), 0, 1));
    const signature = sides.join(":");
    const metadata = {
      total: finite(damage.total), impactCount: finite(damage.impactCount),
      lastImpact: damage.lastImpact ? { ...damage.lastImpact } : null,
    };
    if (signature === previousDamage) {
      Object.assign(diagnostics.damage, metadata);
      return;
    }
    previousDamage = signature;
    let count = 0, maximum = 0;
    for (const { part, pristine, normals, mobility } of model.bodyPanels) {
      const positions = part.geometry.attributes.position;
      const colors = part.geometry.attributes.color;
      for (let i = 0; i < positions.count; i++) {
        const x = pristine[i * 3], y = pristine[i * 3 + 1], z = pristine[i * 3 + 2];
        let dx = 0, dz = 0, weight = 0;
        for (let side = 0; side < 4; side++) {
          if (!sides[side]) continue;
          const end = side < 2;
          const across = end ? x / 0.7 : (z - 0.12) / 0.65;
          const depth = end
            ? (z - (side === 0 ? 2.1 : -2.1)) / 0.4
            : (x - (side === 2 ? -0.925 : 0.925)) / 0.22;
          const vertical = (y - (end ? 0.65 : 0.78)) / 0.38;
          const influence = (mobility ? mobility[i] : 1) * sides[side] * Math.exp(
            -across * across * 1.6 - depth * depth * 1.5 - vertical * vertical,
          );
          const crease = 0.9 + 0.1 * Math.cos(x * 23 + y * 17 + z * 11);
          if (end) dz += (side === 0 ? -1 : 1) * influence * 0.24 * crease;
          else dx += (side === 2 ? 1 : -1) * influence * 0.2 * crease;
          weight = Math.max(weight, influence);
        }
        positions.setXYZ(i, x + dx, y - weight * 0.014, z + dz);
        const distance = Math.hypot(dx, weight * 0.014, dz);
        if (distance > 0.0001) count++;
        maximum = Math.max(maximum, distance);
        const scuff = clamp((weight - 0.035) * 3, 0, 0.85);
        colors.setXYZ(i, 1 - scuff * 0.6, 1 - scuff * 0.62, 1 - scuff * 0.58);
      }
      positions.needsUpdate = true;
      colors.needsUpdate = true;
      if (sides.some(Boolean)) part.geometry.computeVertexNormals();
      else {
        part.geometry.attributes.normal.array.set(normals);
        part.geometry.attributes.normal.needsUpdate = true;
      }
      part.geometry.computeBoundingSphere();
    }
    diagnostics.damage = {
      ...metadata, deformedVertices: count, maximumDisplacementM: maximum,
    };
  }

  function update(actor = currentActor, sensors, alpha = 1) {
    if (disposed) return;
    currentActor = actor;
    const vehicle = actor.vehicle ?? {};
    const suspension = vehicle.suspension ?? {};
    chassis.position.y = clamp(finite(suspension.heaveM), -0.045, 0.045);
    chassis.rotation.set(
      clamp(finite(suspension.pitchRad), -0.1, 0.1), 0,
      clamp(finite(suspension.rollRad), -0.1, 0.1),
    );
    chassis.updateMatrix();
    for (const wheel of model.wheels) {
      wheel.pivot.rotation.set(
        0, wheel.axle > 0 ? finite(vehicle.wheelAngles?.[wheel.key]) : 0, 0,
      );
      wheel.spin.rotation.set(finite(vehicle.wheelSpinRad), 0, 0);
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
    damagePanels(vehicle);
    root.updateWorldMatrix(true, true);
    const inverseRoot = root.matrixWorld.clone().invert();
    const rays = new Map((sensors?.rays ?? []).map((ray) => [ray.id, ray]));
    const records = model.sensors.ranges.map((record) => {
      const ray = rays.get(record.id);
      const origin = vector(record.position);
      const end = ray?.end ? vector(ray.end).applyMatrix4(inverseRoot) : origin;
      const p = record.beam.geometry.attributes.position;
      p.setXYZ(0, origin.x, origin.y, origin.z);
      p.setXYZ(1, end.x, end.y, end.z);
      p.needsUpdate = true;
      record.beam.visible = Boolean(ray);
      record.beam.material.color.setHex(ray?.hitId ? 0xe9bb84 : 0xa5d8ba);
      record.hit.visible = Boolean(ray?.hitId);
      record.hit.position.copy(end);
      record.beam.userData.hitId = ray?.hitId ?? null;
      return {
        id: record.id, angleDeg: record.angleDeg,
        localPosition: { ...record.position },
        worldPosition: point(record.lens.getWorldPosition(new THREE.Vector3())),
        direction: point(record.lens.getWorldDirection(new THREE.Vector3())),
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
      worldPosition: point(camera.lens.getWorldPosition(new THREE.Vector3())),
      direction: point(camera.lens.getWorldDirection(new THREE.Vector3())),
    }));
    diagnostics.sensors.camera = diagnostics.sensors.cameras[0];
    diagnostics.sensors.telemetry = model.sensors.telemetry ? {
      worldPosition: point(model.sensors.telemetry.getWorldPosition(new THREE.Vector3())),
      source: sensors?.imu?.source ?? "simulated-vehicle-state",
    } : null;
    diagnostics.suspension = {
      pitchRad: chassis.rotation.x, rollRad: chassis.rotation.z,
      heaveM: chassis.position.y,
      springLengthsM: Object.fromEntries(model.wheels.map((wheel) => [wheel.key, wheel.spring.scale.y])),
    };
    diagnostics.alpha = finite(alpha, 1);
  }
  function setInspection(options = {}) {
    if (disposed) return;
    if (typeof options.cutaway === "boolean") {
      cutaway = options.cutaway;
      for (const part of model.cutawayParts) part.visible = !cutaway;
    }
    if (typeof options.sensors === "boolean") beams.visible = options.sensors;
    diagnostics.cutaway = cutaway;
    diagnostics.sensorVisualization = beams.visible;
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
  return { root, update, setInspection, getCameraPose, dispose, diagnostics };
}
