import * as THREE from "three";
import { World } from "./core/world.js";
import { FixedClock } from "./core/clock.js";
import { WorldView } from "./render/world-view.js";
import { PLACES, LAB_PLACES } from "./core/places.js";
import { mountPhone } from "./ui/phone.js";
import { createBridge } from "./integration/bridge.js";
import { createPerceptionOverlay } from "./ui/perception-overlay.js";
import { createDecisionInspector } from "./ui/decision-inspector.js";
import { bodyOnRoad } from "./core/geometry.js";

const $ = (id) => document.getElementById(id);
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
});
renderer.domElement.className = "scene";
document.body.prepend(renderer.domElement);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
const camera = new THREE.PerspectiveCamera(
  62,
  innerWidth / innerHeight,
  0.1,
  500,
);
const frontCamera = new THREE.PerspectiveCamera(76, 16 / 9, 0.1, 250);
const worlds = { city: new World() };
const views = new Map();
let environment = "city",
  world = worlds.city;
let learnedPolicy = null,
  useLearnedPolicy = false;
let view,
  clock = new FixedClock(),
  paused = false,
  driverView = false,
  showCamera = true,
  lastInput = "",
  lastTime = performance.now(),
  lastUI = 0,
  lastFrame = 0;
const keys = new Set();
let cameraSnap = true;
let phone;
function activate(next) {
  phone?.reset();
  environment = next;
  world = worlds[next] ?? (worlds[next] = new World(world.config, next));
  if (world.policy !== (useLearnedPolicy ? learnedPolicy : null))
    world.command({
      type: "policy",
      weights: useLearnedPolicy ? learnedPolicy : null,
    });
  if (!views.has(world)) views.set(world, new WorldView(world));
  view = views.get(world);
  clock = new FixedClock();
  cameraSnap = true;
  keys.clear();
  lastInput = "";
  $("environmentLabel").textContent =
    next === "city" ? "City simulation" : "Test lab";
  $("labBtn").textContent = next === "city" ? "Test lab" : "Return to city";
  $("mapLabel").textContent = next === "city" ? "City" : "Test lab";
  $("phoneStatus").textContent =
    next === "city"
      ? "Type or speak a destination, or choose a place."
      : "Choose the north or south lab destination.";
  $("labScenarios").hidden = next !== "lab";
  $("phonePlaces").replaceChildren(
    ...(next === "city" ? PLACES : LAB_PLACES).map((place) => {
      const button = document.createElement("button");
      button.textContent = place.name;
      button.onclick = () => {
        phone?.reset();
        $("phoneStatus").textContent = choosePlace(place)
          ? `Navigating to ${place.name}.`
          : "No legal route from the current heading.";
      };
      return button;
    }),
  );
  for (const name of [
    "seed",
    "traffic",
    "pedestrians",
    "chaos",
    "speedLimit",
    "difficulty",
    "scenarioInterval",
  ]) {
    $("settingsForm").elements[name].value = world.config[name];
    if ($(name + "Output")) $(name + "Output").textContent = world.config[name];
  }
  updateUI();
}
function reset(options) {
  view.dispose();
  views.delete(world);
  worlds[environment] = new World(options, environment);
  activate(environment);
}
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();
function autoToggle() {
  world.command({
    type: "mode",
    mode: world.mode === "auto" ? "manual" : "auto",
  });
  if (world.mode === "auto" && !world.player.path.length)
    choosePlace((environment === "city" ? PLACES : LAB_PLACES)[0]);
}
function choosePlace(place) {
  return world.command({ type: "destination", place });
}
phone = mountPhone({
  onDestination: choosePlace,
  getWorld: () => world,
  getPlaces: () => (environment === "city" ? PLACES : LAB_PLACES),
});
const isEditing = (target) =>
  ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
addEventListener("keydown", (event) => {
  if (event.code === "Escape") {
    $("settingsPanel").hidden = true;
    $("settingsBtn").setAttribute("aria-expanded", "false");
    $("inspectorPanel").hidden = true;
    $("inspectorBtn").setAttribute("aria-expanded", "false");
  }
  if (isEditing(event.target)) return;
  if (
    ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
      event.code,
    )
  )
    event.preventDefault();
  keys.add(event.code);
  if (event.repeat) return;
  if (event.code === "KeyP") $("phoneToggleBtn").click();
  if (event.code === "KeyC") {
    driverView = !driverView;
    cameraSnap = true;
  }
  if (event.code === "KeyI") autoToggle();
});
addEventListener("keyup", (event) => keys.delete(event.code));
addEventListener("blur", () => keys.clear());
document.addEventListener("visibilitychange", () => {
  keys.clear();
  lastTime = performance.now();
  clock = new FixedClock();
});
$("aiToggleBtn").onclick = autoToggle;
$("labBtn").onclick = () => activate(environment === "city" ? "lab" : "city");
$("cameraBtn").onclick = () => {
  showCamera = !showCamera;
  $("cameraLabel").hidden = !showCamera;
  perceptionOverlay?.setVisible(showCamera);
  $("cameraBtn").textContent = showCamera ? "Hide camera" : "Show camera";
};
$("pauseBtn").onclick = () => {
  paused = !paused;
  keys.clear();
  $("pauseBtn").textContent = paused ? "Resume" : "Pause";
};
function settingsOpen(open) {
  $("settingsPanel").hidden = !open;
  $("settingsBtn").setAttribute("aria-expanded", String(open));
  if (open) {
    $("inGamePhone").hidden = true;
    $("phoneToggleBtn").setAttribute("aria-expanded", "false");
    $("inspectorPanel").hidden = true;
    $("inspectorBtn").setAttribute("aria-expanded", "false");
  }
}
$("settingsBtn").onclick = () => settingsOpen($("settingsPanel").hidden);
$("closeSettings").onclick = () => settingsOpen(false);
for (const name of [
  "traffic",
  "pedestrians",
  "chaos",
  "difficulty",
  "scenarioInterval",
])
  $("settingsForm").elements[name].oninput = (event) =>
    ($(name + "Output").textContent = event.target.value);
$("settingsForm").onsubmit = (event) => {
  event.preventDefault();
  reset(Object.fromEntries(new FormData(event.target)));
};
$("stressBtn").onclick = () => {
  const form = $("settingsForm");
  for (const [key, value] of Object.entries({
    traffic: 72,
    pedestrians: 96,
    chaos: 1,
  })) {
    form.elements[key].value = value;
    $(key + "Output").textContent = value;
  }
  reset(Object.fromEntries(new FormData(form)));
};
$("replayBtn").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(world.replay(), null, 2)], {
      type: "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `ostorha-${world.config.seed}-${world.tick}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
};
$("replayFile").onchange = async (event) => {
  const wasPaused = paused;
  paused = true;
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 2000000) throw new Error("Replay file is too large");
    const replay = JSON.parse(await file.text()),
      steps = World.reconstruct(replay);
    let result = steps.next();
    while (!result.done) {
      $("replayProgress").textContent =
        `Replaying: ${Math.round((result.value.tick / replay.totalTicks) * 100)}%`;
      await new Promise((resolve) => setTimeout(resolve, 0));
      result = steps.next();
    }
    const restored = result.value,
      previous = worlds[restored.environment];
    views.get(previous)?.dispose();
    views.delete(previous);
    worlds[restored.environment] = restored;
    activate(restored.environment);
    $("replayProgress").textContent = "Replay restored from recorded commands.";
  } catch (error) {
    $("replayProgress").textContent = `Could not load replay: ${error.message}`;
  } finally {
    paused = wasPaused;
    event.target.value = "";
  }
};
for (const button of document.querySelectorAll("[data-scenario]"))
  button.onclick = () =>
    world.command({ type: "scenario", kind: button.dataset.scenario });

async function trainingRequest(action) {
  try {
    const response = await fetch(`/api/training/${action}`, { method: "POST" });
    if (!response.ok && response.status !== 409)
      throw new Error(`HTTP ${response.status}`);
    await updateTrainingStatus();
  } catch (error) {
    $("trainingStatus").textContent =
      `Could not start training: ${error.message}`;
  }
}
async function updateTrainingStatus() {
  try {
    const response = await fetch("/api/training", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    $("downloadPolicy").hidden = !data.weightsReady;
    $("trainPolicyBtn").disabled = data.running;
    $("stopTrainingBtn").disabled = !data.running;
    if (data.running) {
      $("trainingStatus").textContent =
        `Training · ${data.episodes ?? 0} saved episodes. You can stop and resume.`;
    } else if (data.report) {
      const a = data.report.baseline,
        b = data.report.trained;
      $("trainingStatus").textContent =
        `${data.episodes} episodes · ${data.report.evaluationSeeds} unseen seeds: arrivals ${a.arrivals}/${data.report.evaluationSeeds} baseline vs ${b.arrivals}/${data.report.evaluationSeeds} trained · mean time ${a.seconds.toFixed(1)} s vs ${b.seconds.toFixed(1)} s · interventions ${a.interventions.toFixed(1)} vs ${b.interventions.toFixed(1)}. Policy stays off until applied.`;
    } else {
      $("trainingStatus").textContent = data.episodes
        ? `${data.episodes} saved episodes. Train to resume and compare.`
        : "No weights saved yet.";
    }
  } catch (error) {
    $("trainingStatus").textContent =
      `Training service unavailable: ${error.message}`;
  }
}
$("trainPolicyBtn").onclick = () => trainingRequest("start");
$("stopTrainingBtn").onclick = () => trainingRequest("stop");
$("applyPolicyBtn").onclick = async () => {
  if (useLearnedPolicy) {
    useLearnedPolicy = false;
    world.command({ type: "policy", weights: null });
    $("applyPolicyBtn").textContent = "Apply weights";
    return;
  }
  try {
    const response = await fetch("/output/policy-lab.json", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("No saved weights");
    learnedPolicy = await response.json();
    world.command({ type: "policy", weights: learnedPolicy });
    useLearnedPolicy = true;
    $("applyPolicyBtn").textContent = "Disable policy";
  } catch (error) {
    $("trainingStatus").textContent =
      `Could not load weights: ${error.message}`;
  }
};
updateTrainingStatus();
setInterval(updateTrainingStatus, 2500);

function input() {
  const editing = isEditing(document.activeElement),
    pressed = (code) => !editing && keys.has(code);
  const targetSpeed = pressed("Space")
    ? 0
    : pressed("KeyW") || pressed("ArrowUp")
      ? world.player.maxSpeed
      : pressed("KeyS") || pressed("ArrowDown")
        ? -2.5
        : 0;
  const steer =
    ((pressed("KeyA") || pressed("ArrowLeft") ? 1 : 0) -
      (pressed("KeyD") || pressed("ArrowRight") ? 1 : 0)) *
    0.62;
  const command = { type: "drive", targetSpeed, steer };
  const signature = JSON.stringify(command);
  if (signature !== lastInput) {
    world.command(command);
    lastInput = signature;
  }
  if (pressed("Space") && world.mode === "auto")
    world.command({ type: "mode", mode: "manual" });
}
const reasons = {
  ready: "Ready",
  driving: "Road clear",
  idle: "Stopped",
  yielding: "Maintaining clearance",
  junction: "Waiting at junction",
  "red-light": "Red light",
  occupied: "Safety brake",
  "road-boundary": "Road boundary",
  "no-route": "No legal route",
  arrived: "Arrived",
};
function updateUI() {
  $("speedVal").textContent = Math.round(Math.abs(world.player.speed) * 3.6);
  $("aiToggleBtn").textContent =
    world.mode === "auto" ? "Autonomous drive" : "Manual drive";
  $("safetyStatus").textContent = paused
    ? "Simulation paused"
    : world.destination && !world.player.path.length
      ? "Destination reached"
      : (reasons[world.player.reason] ?? world.player.reason);
  $("cameraDecision").textContent =
    `Simulator safety: ${reasons[world.player.reason] ?? world.player.reason}${world.player.blockedBy ? ` · ${world.player.blockedBy}` : ""}`;
  $("tripLabel").textContent = world.destination
    ? `${world.destination.name ?? "Destination"} · ${world.player.path.length ? "En route" : "Arrived"}`
    : "Choose a destination on the phone";
  $("diagnostics").textContent =
    `Seed: ${world.config.seed} · Tick ${world.tick} | ${world.capacity.traffic} vehicles / ${world.capacity.pedestrians} pedestrians | ${Math.round(world.metrics.distance)} m | Safety interventions: ${world.metrics.interventions} | Player wait: ${world.metrics.waitSeconds.toFixed(1)} s`;
  $("scenarioStatus").textContent = world.scenario
    ? `${{ crossing: "Pedestrian crossing", "side-traffic": "Side street tuk-tuk", barrier: "Road barrier" }[world.scenario.kind]} · ${world.scenario.applied ? "Active" : "Deferred: no free space"}`
    : "Seeded scenarios run on a replayable schedule";
  $("loadingStatus").textContent = view.status.failed.length
    ? `${view.status.failed.length} models failed to load · fallback shapes shown`
    : `${environment === "lab" ? "Test lab" : "City"} · ${world.config.seed} · ${world.capacity.traffic} vehicles · ${world.capacity.pedestrians} pedestrians`;
  inspector.update(world, perceptionOverlay.latest);
  drawMap();
}
const map = $("minimap").getContext("2d");
function drawMap() {
  const scale = environment === "city" ? 0.93 : 2.25,
    c = 110;
  map.clearRect(0, 0, 220, 220);
  map.fillStyle = "#293930";
  map.fillRect(0, 0, 220, 220);
  const line = (points, color, width) => {
    map.strokeStyle = color;
    map.lineWidth = width;
    map.beginPath();
    points.forEach((p, i) =>
      map[i ? "lineTo" : "moveTo"](c + p.x * scale, c + p.z * scale),
    );
    map.stroke();
  };
  for (const road of world.roads)
    line(
      road.axis === "z"
        ? [
            { x: road.fixed, z: road.min },
            { x: road.fixed, z: road.max },
          ]
        : [
            { x: road.min, z: road.fixed },
            { x: road.max, z: road.fixed },
          ],
      "#738075",
      road.width * scale,
    );
  if (world.player.path.length) line(world.player.path, "#a5e4bc", 1.8);
  for (const actor of world.actors) {
    map.fillStyle =
      actor === world.player
        ? "#f6efd8"
        : actor.type === "pedestrian"
          ? "#dac29c"
          : "#a5b6b0";
    map.beginPath();
    map.arc(
      c + actor.x * scale,
      c + actor.z * scale,
      actor === world.player ? 3.5 : actor.type === "pedestrian" ? 1 : 1.7,
      0,
      Math.PI * 2,
    );
    map.fill();
  }
}
const bridge = createBridge({
  renderer,
  readState: () => ({
    speedKmh: Math.abs(world.player.speed) * 3.6,
    mode: world.mode,
    safety: world.player.reason,
    position: { x: world.player.x, z: world.player.z },
    onRoad: bodyOnRoad(world.player, world.roads),
    sensorsM: world.sensors.filteredM,
    destination: world.destination?.name ?? null,
    actors: world.actors
      .filter(
        (a) =>
          a !== world.player &&
          Math.hypot(a.x - world.player.x, a.z - world.player.z) < 40,
      )
      .map((a) => ({ id: a.id, type: a.type, x: a.x, z: a.z, speed: a.speed })),
  }),
});
const perceptionOverlay = createPerceptionOverlay({
  canvas: $("cameraOverlay"),
  status: $("cvStatus"),
  bridge,
});
const inspector = createDecisionInspector();
const offset = new THREE.Vector3(),
  target = new THREE.Vector3(),
  forward = new THREE.Vector3();
function frame(time) {
  requestAnimationFrame(frame);
  const delta = (time - lastTime) / 1000;
  lastTime = time;
  input();
  if (!paused && !document.hidden) clock.advance(delta, () => world.step());
  const player = view.sync(clock.alpha);
  forward.set(Math.sin(player.rotation.y), 0, Math.cos(player.rotation.y));
  offset
    .copy(player.position)
    .addScaledVector(forward, driverView ? 0.9 : -10.5);
  offset.y += driverView ? 1.25 : 5;
  camera.position.lerp(offset, cameraSnap ? 1 : 1 - Math.exp(-delta * 6));
  cameraSnap = false;
  target.copy(player.position).addScaledVector(forward, driverView ? 15 : 5);
  target.y += 1;
  camera.lookAt(target);
  frontCamera.position.copy(player.position).addScaledVector(forward, 1.5);
  frontCamera.position.y += 1.25;
  frontCamera.lookAt(
    target.copy(frontCamera.position).addScaledVector(forward, 20),
  );
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.render(view.scene, camera);
  if (showCamera) {
    const width = innerWidth < 850 ? 230 : 276,
      height = Math.round((width * 9) / 16),
      x = 24,
      y = innerWidth < 850 ? 100 : 94;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, width, height);
    renderer.setViewport(x, y, width, height);
    renderer.clearDepth();
    renderer.render(view.scene, frontCamera);
    perceptionOverlay.setViewport({ x, y, width, height });
    if (time - lastFrame > 1000) {
      bridge.sendFrame({ x, y, width, height });
      lastFrame = time;
    }
    renderer.setScissorTest(false);
  }
  if (time - lastUI > 180) {
    updateUI();
    lastUI = time;
  }
}
activate("city");
requestAnimationFrame(frame);
// Reproducible diagnostics used by browser smoke tests and Python adapters.
window.sim = {
  get world() {
    return world;
  },
  get view() {
    return view;
  },
  get paused() {
    return paused;
  },
  pause(value = true) {
    paused = value;
  },
  step(count = 1) {
    for (let i = 0; i < count; i++) world.step();
  },
  snapshot: () => world.snapshot(),
  audit: () => world.audit(),
  replay: () => world.replay(),
  command: (command) => world.command(command),
  activate,
  reset,
};
