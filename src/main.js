import * as THREE from "three";
import { World } from "./core/world.js";
import { FixedClock } from "./core/clock.js";
import { WorldView } from "./render/world-view.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PLACES, LAB_PLACES } from "./core/places.js";
import { mountPhone } from "./ui/phone.js";
import { createBridge, createVisualClient } from "./integration/bridge.js";
import { createPerceptionOverlay } from "./ui/perception-overlay.js";
import { createDecisionInspector } from "./ui/decision-inspector.js";
import { bodyOnRoad } from "./core/geometry.js";
import { mountVehiclePanel } from "./ui/vehicle-panel.js";
import { mountVisionPanel } from "./ui/vision-panel.js";
import { mountCameraScreen } from "./ui/camera-screen.js";
import { mountPeoplePanel } from "./ui/people-panel.js";

const $ = (id) => document.getElementById(id);
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
});
renderer.domElement.className = "scene";
document.body.prepend(renderer.domElement);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
let viewportWidth = document.documentElement.clientWidth;
let viewportHeight = innerHeight;
const camera = new THREE.PerspectiveCamera(
  62,
  viewportWidth / viewportHeight,
  0.1,
  500,
);
const frontCamera = new THREE.PerspectiveCamera(76, 16 / 9, 0.1, 250);
const visionCamera = new THREE.PerspectiveCamera(76, 16 / 9, 0.1, 250);
const worlds = { city: new World() };
const views = new Map();
let environment = "city",
  world = worlds.city;
let learnedPolicy = null,
  useLearnedPolicy = false;
let view,
  clock = new FixedClock(),
  paused = false,
  cameraMode = "chase",
  showCamera = true,
  lastInput = "",
  lastTime = performance.now(),
  lastUI = 0,
  lastFrame = 0;
const keys = new Set();
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enabled = false;
orbit.enablePan = false;
orbit.enableDamping = true;
orbit.minDistance = 1.2;
orbit.maxDistance = 12;
let cameraSnap = true;
let phone, vehiclePanel, visionPanel, visualClient, cameraScreen, peoplePanel;
let selectedPersonId = null, focusedPersonId = null, cameraScreenVisible = false;
let visionCaseId = "cross-left", visionMode = "vision-first", pendingVisionRun = false;
const visionComparisons = new Map();
function visionComparisonKey(caseId, config = world.config) {
  return `${caseId}|${config.seed}|${config.speedLimit}`;
}
function saveVisionComparison() {
  const lab = world.visionLab;
  if (!lab || lab.phase !== "complete" || lab.error) return;
  const key = visionComparisonKey(lab.caseId);
  const values = visionComparisons.get(key) ?? { visionBrakeTimeS: null, reactiveBrakeTimeS: null };
  if (world.visualMode === "vision-first") values.visionBrakeTimeS = lab.firstVisualBrakeS;
  else values.reactiveBrakeTimeS = lab.firstReactiveBrakeS;
  visionComparisons.set(key, values);
}
let cutaway = false, sensorView = false, sensorCamera = "front", inspectionPause = null;
let renderedFrames = 0;
let inspectionRig = null, appliedCutaway = null, appliedSensors = null;
const isInspection = () => cameraMode === "inspection" || cameraMode === "running-gear";
function setCarView(mode) {
  if (!["chase", "cockpit", "inspection", "running-gear"].includes(mode))
    throw new Error("Unknown car camera view");
  if (mode === "inspection" || mode === "running-gear") {
    if (inspectionPause === null) inspectionPause = paused;
    paused = true;
  } else if (inspectionPause !== null) {
    paused = inspectionPause;
    inspectionPause = null;
  }
  cameraMode = mode;
  focusedPersonId = null;
  if (view) view.focusedPersonId = null;
  if (mode === "running-gear") cutaway = true;
  orbit.enabled = isInspection();
  camera.fov = mode === "cockpit" ? 60 : 62;
  camera.near = mode === "cockpit" ? 0.025 : 0.1;
  camera.updateProjectionMatrix();
  keys.clear();
  cameraSnap = true;
  $("pauseBtn").textContent = paused ? "Resume" : "Pause";
}
function carAction(action, value) {
  if (action === "view") setCarView(value);
  else if (action === "cutaway") cutaway = Boolean(value);
  else if (action === "sensors") sensorView = Boolean(value);
  else if (action === "sensor-camera") {
    if (!["front", "rear"].includes(value))
      return { ok: false, error: "Choose the front or rear installed camera." };
    sensorCamera = value;
    perceptionOverlay?.setVisible(showCamera && sensorCamera === "front");
  }
  else if (action === "impact-bay") {
    setCarView("chase");
    activate("vehicle");
    paused = false;
    cutaway = false;
    sensorView = true;
  } else if (action === "impact-run") {
    if (environment !== "vehicle" || world.vehicleTest?.phase !== "ready")
      return { ok: false, error: "Enter the vehicle test bay and reset it before starting a contact run." };
    setCarView("chase");
    paused = false;
    cutaway = false;
    if (!world.command({ type: "vehicle-test", operation: "run" }))
      return { ok: false, error: "The controlled contact run could not start. Reset the vehicle test bay." };
  } else if (action === "reset-car") {
    if (environment !== "vehicle")
      return { ok: false, error: "Car repair/reset is available in the isolated vehicle test bay." };
    setCarView("chase");
    reset(world.config);
    paused = false;
    cutaway = false;
  } else if (action === "return-city") {
    setCarView("chase");
    activate("city");
  } else return { ok: false, error: "Unknown car action." };
  updateUI();
  return { ok: true };
}
function newVisionScene() {
  saveVisionComparison();
  const previous = worlds.vision;
  const previousView = views.get(previous);
  previousView?.dispose();
  views.delete(previous);
  worlds.vision = new World({ ...world.config, visionCase: visionCaseId }, "vision");
  activate("vision");
  world.command({ type: "visual-mode", mode: visionMode });
  pendingVisionRun = false;
  paused = false;
}
async function visionAction(action, value) {
  if (action === "case") {
    visionCaseId = value;
    newVisionScene();
  } else if (action === "mode") {
    visionMode = value;
    newVisionScene();
  } else if (action === "return-city") {
    saveVisionComparison();
    pendingVisionRun = false;
    activate("city");
  } else if (action === "reset") {
    newVisionScene();
  } else if (action === "enter" || action === "run") {
    if (environment !== "vision" || world.visionLab?.phase === "complete") newVisionScene();
    if (!visualClient.enabled || visualClient.restartRequired) {
      const started = await visualClient.start();
      if (!started.ok) return started;
      world.command({ type: "visual-reset", streamId: visualClient.streamId });
    }
    if (action === "run") {
      world.command({ type: "visual-reset", streamId: visualClient.reset() });
      pendingVisionRun = true;
    }
  } else return { ok: false, error: "Unknown vision action." };
  updateUI();
  return { ok: true };
}
async function cameraAction(action) {
  if (action === "start") {
    const result = await visualClient.start();
    if (!result.ok) return result;
    world.command({ type: "visual-reset", streamId: visualClient.streamId });
  } else if (action === "stop") {
    pendingVisionRun = false;
    const result = await visualClient.stop();
    world.command({ type: "visual-reset", streamId: visualClient.streamId });
    perceptionOverlay.setExternal(null);
    if (!result.ok) return result;
  } else if (action === "vision-lab") {
    cameraScreen.close();
    $("visionToggleBtn").click();
  } else return { ok: false, error: "Unknown camera action." };
  updateUI();
  return { ok: true };
}
function peopleAction(action, value) {
  if (action === "vehicle-view") {
    setCarView("chase");
  } else {
    const id = action === "motion" ? value?.id : value;
    const person = world.actors.find((actor) => actor.id === id && actor.type === "pedestrian");
    if (!person) return { ok: false, error: "That person is no longer in this scene. Select another person." };
    if (action === "select") {
      selectedPersonId = person.id;
      if (focusedPersonId) focusedPersonId = person.id;
    } else if (action === "focus") {
      selectedPersonId = person.id;
      setCarView("chase");
      focusedPersonId = person.id;
      orbit.enabled = true;
      keys.clear();
      cameraSnap = true;
    } else if (action === "motion") {
      try {
        world.command({ type: "pedestrian-motion", id: person.id, mode: value.mode });
      } catch (error) {
        return { ok: false, error: error.message };
      }
    } else return { ok: false, error: "Unknown people action." };
  }
  view.focusedPersonId = focusedPersonId;
  updateUI();
  return { ok: true };
}
function activate(next) {
  setCarView("chase");
  phone?.reset();
  environment = next;
  world = worlds[next] ?? (worlds[next] = new World(world.config, next));
  if (visualClient) {
    world.command({ type: "visual-reset", streamId: visualClient.reset() });
    if (visualClient.enabled) perceptionOverlay.setExternal(null);
  }
  if (world.policy !== (useLearnedPolicy ? learnedPolicy : null))
    world.command({
      type: "policy",
      weights: useLearnedPolicy ? learnedPolicy : null,
    });
  if (!views.has(world)) views.set(world, new WorldView(world));
  view = views.get(world);
  view.scene.matrixWorldAutoUpdate = false;
  clock = new FixedClock();
  cameraSnap = true;
  keys.clear();
  lastInput = "";
  $("environmentLabel").textContent =
    next === "city" ? "City simulation" : next === "vehicle" ? "Vehicle test bay"
      : next === "vision" ? "Visual prediction lab" : "Test lab";
  $("labBtn").textContent = next === "city" ? "Test lab" : "Return to city";
  $("mapLabel").textContent = next === "city" ? "City" : next === "vehicle" ? "Vehicle bay" : "Test lab";
  $("phoneStatus").textContent =
    next === "city"
      ? "Type or speak a destination, or choose a place."
      : "Choose the north or south lab destination.";
  $("labScenarios").hidden = next !== "lab";
  $("aiToggleBtn").disabled = next === "vehicle" || next === "vision";
  $("phoneToggleBtn").disabled = next === "vehicle" || next === "vision";
  if (next === "vehicle" || next === "vision") {
    $("inGamePhone").hidden = true;
    $("phoneToggleBtn").setAttribute("aria-expanded", "false");
  }
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
  lastTime = performance.now();
}
function reset(options) {
  view.dispose();
  views.delete(world);
  worlds[environment] = new World(options, environment);
  activate(environment);
}
function resize() {
  const bounds = renderer.domElement.getBoundingClientRect();
  viewportWidth = Math.round(bounds.width);
  viewportHeight = Math.round(bounds.height);
  renderer.setPixelRatio(Math.min(Math.round(devicePixelRatio * 1000) / 1000, 1.5));
  renderer.setSize(viewportWidth, viewportHeight, false);
  camera.aspect = viewportWidth / viewportHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();
function autoToggle() {
  if (environment === "vehicle" || environment === "vision") return;
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
vehiclePanel = mountVehiclePanel({
  toolbar: document.querySelector(".topbar nav"),
  onAction: carAction,
});
visionPanel = mountVisionPanel({
  toolbar: document.querySelector(".topbar nav"),
  onAction: visionAction,
});
cameraScreen = mountCameraScreen({
  navigation: document.querySelector(".topbar nav"),
  onAction: cameraAction,
  onVisibilityChange: (visible) => {
    cameraScreenVisible = visible;
    visualClient?.setPreviewEnabled(visible);
    if (visible) {
      peoplePanel?.close();
      vehiclePanel.close();
      visionPanel.close();
      settingsOpen(false);
    }
  },
});
peoplePanel = mountPeoplePanel({
  navigation: document.querySelector(".topbar nav"),
  onAction: peopleAction,
});
document.querySelector(".topbar nav").addEventListener("click", (event) => {
  const id = event.target.closest("button")?.id;
  if (id && id !== "cameraScreenToggleBtn") cameraScreen.close();
  if (id && id !== "peopleToggleBtn") peoplePanel.close();
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
    setCarView(cameraMode === "cockpit" ? "chase" : "cockpit");
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
  perceptionOverlay?.setVisible(showCamera && sensorCamera === "front");
  $("cameraBtn").textContent = showCamera ? "Hide camera" : "Show camera";
};
$("pauseBtn").onclick = () => {
  if (isInspection()) {
    setCarView("chase");
    paused = false;
  } else paused = !paused;
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
  const editing = isEditing(document.activeElement) || isInspection() || Boolean(focusedPersonId),
    pressed = (code) => !editing && keys.has(code);
  const targetSpeed = pressed("Space")
    ? 0
    : pressed("KeyW") || pressed("ArrowUp")
      ? world.player.maxSpeed
      : pressed("KeyS") || pressed("ArrowDown")
        ? -2.5
        : 0;
  if (environment === "vision") {
    if (pressed("Space") && !world.visionLab.error) {
      pendingVisionRun = false;
      world.command({ type: "stop" });
    }
    return;
  }
  const steer =
    ((pressed("KeyD") || pressed("ArrowRight") ? 1 : 0) -
      (pressed("KeyA") || pressed("ArrowLeft") ? 1 : 0)) *
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
  "visual-prediction": "Visual forecast: braking for a crossing trajectory",
  "no-route": "No legal route",
  arrived: "Arrived",
};
function updateUI() {
  saveVisionComparison();
  $("pauseBtn").textContent = paused ? "Resume" : "Pause";
  $("speedVal").textContent = Math.round(Math.abs(world.player.speed) * 3.6);
  $("aiToggleBtn").textContent =
    world.mode === "auto" ? "Autonomous drive" : "Manual drive";
  $("safetyStatus").textContent = paused
    ? "Simulation paused"
    : world.destination && !world.player.path.length
      ? "Destination reached"
      : (reasons[world.player.reason] ?? world.player.reason);
  $("cameraDecision").textContent =
    `Control: ${reasons[world.player.reason] ?? world.player.reason}${world.player.blockedBy ? ` · ${world.player.blockedBy}` : ""}`;
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
  vehiclePanel?.update({
    world, actor: world.player, rig: view.playerRig,
    mode: cameraMode, cutaway, sensors: sensorView, sensorCamera,
  });
  visionPanel?.update({
    world, vision: world.visualState,
    availability: visualClient?.status ?? { available: false, status: "disabled" },
    mode: visionMode, caseId: visionCaseId,
    running: world.visionLab?.phase === "running" || pendingVisionRun,
    comparison: visionComparisons.get(visionComparisonKey(visionCaseId)) ?? null,
  });
  if (cameraScreen && visualClient) updateCameraScreen();
  const people = world.actors.filter((actor) => actor.type === "pedestrian")
    .sort((a, b) => Math.hypot(a.x - world.player.x, a.z - world.player.z)
      - Math.hypot(b.x - world.player.x, b.z - world.player.z) || a.id.localeCompare(b.id));
  if (!people.some((person) => person.id === selectedPersonId)) selectedPersonId = people[0]?.id ?? null;
  if (focusedPersonId && !people.some((person) => person.id === focusedPersonId)) setCarView("chase");
  peoplePanel?.update({
    environment, people, selectedId: selectedPersonId,
    focused: Boolean(focusedPersonId), paused,
  });
  if (environment === "vision")
    $("loadingStatus").textContent = world.visionLab.error
      ?? `Visual prediction · ${world.visionLab.phase} · live camera pixels`;
  $("cameraLabel").firstChild.textContent = sensorCamera === "rear" ? "Rear camera " : "Front camera ";
  if (environment === "vehicle") {
    $("loadingStatus").textContent = view.status.failed.length
      ? "Car model failed to load. Reload the page to retry."
      : `Vehicle test bay · ${world.vehicleTest?.phase ?? "ready"} · isolated contact fixture`;
    $("scenarioStatus").textContent = "Vehicle-only fixture. Normal city safety remains unchanged.";
  }
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
visualClient = createVisualClient({
  renderer,
  onFrame: () => {
    if (cameraScreenVisible) updateCameraScreen();
  },
  onStatus: (status) => {
    if (status.status === "error" || status.status === "stale") {
      perceptionOverlay.setExternal(null);
      $("cvStatus").textContent = status.error ?? "Camera observations are stale";
    }
  },
  onResult: (result) => {
    if (result.streamId !== visualClient.streamId) return;
    world.command({ type: "visual-observation", result });
    perceptionOverlay.setExternal?.(result);
    if (pendingVisionRun && environment === "vision") {
      world.command({ type: "vision-run" });
      pendingVisionRun = false;
    }
  },
});
function updateCameraScreen() {
  let result = visualClient.status.result;
  const visual = world.visualState;
  if (result && visual?.available && visual.streamId === result.streamId
      && Number.isSafeInteger(visual.frameId) && visual.frameId < result.frameId)
    result = visualClient.getResult(visual.streamId, visual.frameId) ?? result;
  const matchingMotion = result && visual?.streamId === result.streamId
    && visual.frameId === result.frameId;
  cameraScreen.update({
    frame: result ? visualClient.getFrame(result.streamId, result.frameId) : visualClient.latestFrame,
    result, visual: matchingMotion ? visual : null, availability: visualClient.status,
    enabled: visualClient.enabled, ego: { speedMps: world.player.speed },
    applied: { reason: world.player.reason },
  });
}
const offset = new THREE.Vector3(),
  target = new THREE.Vector3(),
  forward = new THREE.Vector3();
function mountedCameraPose(player, mode) {
  const pose = view.playerRig?.getCameraPose(mode);
  if (!pose) return false;
  offset.set(pose.position.x, pose.position.y, pose.position.z);
  target.set(pose.target.x, pose.target.y, pose.target.z);
  player.localToWorld(offset);
  player.localToWorld(target);
  return true;
}
function frame(time) {
  requestAnimationFrame(frame);
  const delta = (time - lastTime) / 1000;
  lastTime = time;
  input();
  if (!paused && !document.hidden) clock.advance(delta, () => world.step());
  const player = view.sync(clock.alpha);
  // Every camera pass renders the same accepted pose and light-space shadows.
  view.scene.updateMatrixWorld();
  renderer.shadowMap.needsUpdate = true;
  if (view.playerRig && (inspectionRig !== view.playerRig
      || appliedCutaway !== cutaway || appliedSensors !== sensorView)) {
    view.playerRig.setInspection({ cutaway, sensors: sensorView });
    inspectionRig = view.playerRig;
    appliedCutaway = cutaway;
    appliedSensors = sensorView;
  }
  forward.set(Math.sin(player.rotation.y), 0, Math.cos(player.rotation.y));
  const personRoot = focusedPersonId ? view.roots.get(focusedPersonId)?.root : null;
  if (personRoot) {
    const person = world.actors.find((actor) => actor.id === focusedPersonId);
    target.copy(personRoot.position);
    target.y += (person.body?.heightM ?? 1.78) * 0.55;
    if (cameraSnap) {
      camera.position.copy(target);
      camera.position.add(new THREE.Vector3(3.2, 1, -4.2));
    } else {
      offset.subVectors(target, orbit.target);
      camera.position.add(offset);
    }
    orbit.target.copy(target);
    orbit.update();
  } else if (cameraMode !== "chase" && mountedCameraPose(player, cameraMode)) {
    if (isInspection()) {
      if (cameraSnap) {
        camera.position.copy(offset);
        orbit.target.copy(target);
      }
      orbit.update();
    } else {
      camera.position.copy(offset);
      camera.lookAt(target);
    }
  } else {
    offset.copy(player.position).addScaledVector(forward, -10.5);
    offset.y += 5;
    camera.position.lerp(offset, cameraSnap ? 1 : 1 - Math.exp(-delta * 6));
    target.copy(player.position).addScaledVector(forward, 5);
    target.y += 1;
    camera.lookAt(target);
  }
  cameraSnap = false;
  if (mountedCameraPose(player, sensorCamera === "rear" ? "sensor-rear" : "sensor")) {
    frontCamera.position.copy(offset);
    frontCamera.lookAt(target);
  } else {
    frontCamera.position.copy(player.position).addScaledVector(forward, 1.5);
    frontCamera.position.y += 1.25;
    frontCamera.lookAt(target.copy(frontCamera.position).addScaledVector(forward, 20));
  }
  if ((visualClient.enabled || cameraScreenVisible) && mountedCameraPose(player, "sensor")) {
    visionCamera.position.copy(offset);
    visionCamera.lookAt(target);
    const debugRays = view.playerRig?.root.getObjectByName("vehicle-sensor-rays");
    const raysVisible = debugRays?.visible;
    const routeVisible = view.route.visible;
    if (debugRays) debugRays.visible = false;
    view.route.visible = false;
    try {
      visualClient.capture(view.scene, visionCamera, world.player, world.tick / 60);
    } finally {
      if (debugRays) debugRays.visible = raysVisible;
      view.route.visible = routeVisible;
    }
  }
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, viewportWidth, viewportHeight);
  renderer.render(view.scene, camera);
  if (showCamera) {
    const width = viewportWidth < 850 ? 230 : 276,
      height = Math.round((width * 9) / 16),
      x = 24,
      y = viewportWidth < 850 ? 100 : 94;
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
    renderedFrames++;
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
  cameraFrame(streamId, frameId) {
    return visualClient.getFrame(streamId, frameId);
  },
  cameraResult(streamId, frameId) {
    return visualClient.getResult(streamId, frameId);
  },
  get world() {
    return world;
  },
  get view() {
    return view;
  },
  get paused() {
    return paused;
  },
  get vehicleRig() {
    return view.playerRig;
  },
  get vision() {
    return {
      status: visualClient.status, streamId: visualClient.streamId,
      transport: visualClient.timings,
      frame: visualClient.status.result
        ? visualClient.getFrame(visualClient.status.result.streamId, visualClient.status.result.frameId)
        : visualClient.latestFrame,
      state: world.visualState, evaluation: world.visionLab,
    };
  },
  get people() {
    const record = view.roots.get(selectedPersonId);
    return { selectedId: selectedPersonId, focusedId: focusedPersonId,
      rig: record?.pedestrianRig?.diagnostics() ?? null };
  },
  renderDiagnostics() {
    const gl = renderer.getContext();
    return {
      renderedFrames, cameraMode, cutaway, sensorView, sensorCamera,
      width: renderer.domElement.width, height: renderer.domElement.height,
      pixelRatio: renderer.getPixelRatio(),
      renderCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      backend: gl.getParameter(gl.VERSION),
      renderer: gl.getParameter(gl.RENDERER),
      cameraPosition: camera.position.toArray(),
      sensorCameraPosition: frontCamera.position.toArray(),
      sensorCameraDirection: frontCamera.getWorldDirection(new THREE.Vector3()).toArray(),
      vehicle: view.playerRig?.diagnostics ?? null,
    };
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
