import * as THREE from "three";
import { World } from "./core/world.js";
import { METRO_POPULATION_LIMITS, RUSH_CITY_POPULATION_LIMITS } from "./core/unified-city.js";
import { FixedClock } from "./core/clock.js";
import { WorldView } from "./render/world-view.js";
import { createPursuitCamera } from "./render/pursuit-camera.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PLACES, LAB_PLACES } from "./core/places.js";
import { mountPhone } from "./ui/phone.js";
import { createBridge, createVisualClient } from "./integration/bridge.js";
import { createPerceptionOverlay } from "./ui/perception-overlay.js";
import { createDecisionInspector } from "./ui/decision-inspector.js";
import { bodyOnRoad, distance } from "./core/geometry.js";
import { mountVehiclePanel } from "./ui/vehicle-panel.js";
import { mountVisionPanel } from "./ui/vision-panel.js";
import { mountCameraScreen } from "./ui/camera-screen.js";
import { mountPeoplePanel } from "./ui/people-panel.js";
import { createReplayBlob, readReplayFile } from "./ui/replay-file.js";
import { DISTRICT_CASES } from "./core/district-scenarios.js";
import { pursuitSnapshot } from "./core/pursuit-world.js";
import { PACK_DRILLS } from "./core/pack-drills.js";
import { mountPursuitPanel } from "./ui/pursuit-panel.js";
import { PursuitAudio } from "./ui/pursuit-audio.js";
import { isPackPursuit, onRoadLimit, rushRoadLimit, usesRushPace } from "./core/district-behavior.js";
import { validatePackPolicy } from "./core/pack-driving.js";

const $ = (id) => document.getElementById(id);
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
});
const gl = renderer.getContext();
const hardwareInfo = gl.getExtension("WEBGL_debug_renderer_info");
const graphicsAdapter = hardwareInfo ? gl.getParameter(hardwareInfo.UNMASKED_RENDERER_WEBGL) : null;
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
const drivingHud = document.querySelector(".driving-hud");
let previewViewport;
const camera = new THREE.PerspectiveCamera(
  62,
  viewportWidth / viewportHeight,
  0.1,
  500,
);
const frontCamera = new THREE.PerspectiveCamera(76, 16 / 9, 0.1, 250);
const visionCamera = new THREE.PerspectiveCamera(76, 16 / 9, 0.1, 250);
const pursuitCamera = createPursuitCamera();
const worlds = { metro: new World({ cityVersion: 4 }, "metro") };
const views = new Map();
const scenePauses = new WeakMap();
let environment = "metro", cityResumeEnvironment = "metro",
  world = worlds.metro;
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
const touchPursuit = new Map();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enabled = false;
orbit.enablePan = false;
orbit.enableDamping = true;
orbit.minDistance = 1.2;
orbit.maxDistance = 12;
let cameraSnap = true;
let lastPursuitShot = null;
let phone, vehiclePanel, visionPanel, visualClient, cameraScreen, peoplePanel;
let selectedPersonId = null, focusedPersonId = null, cameraScreenVisible = false;
let visionCaseId = "cross-left", visionMode = "vision-first", pendingVisionRun = false;
let districtCaseId = "ambient", streetPursuitOpen = false, streetPursuitLevel = 3, streetPursuitStyle = "survival";
let packDrillWorld = null, labPackCheckpoint = null, cityPackCheckpoint = null;
let cityDriver = "vision-first", cameraStartup = null, cityCameraError = null;
const hasCityCameraDriver = (target) => target.environment === "metro" && target.config.cityVersion >= 3;
const isCity = (id) => id === "city" || id === "metro";
const isPursuing = () => environment === "pursuit" || world.pursuit?.phase === "running" ||
  Boolean(world.pursuit?.reviewUntilTick);
const placesForWorld = () => environment === "pursuit" ? [] :
  world.district?.places ?? (environment === "city" ? PLACES : LAB_PLACES);
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
let pursuitPreview = null, overlayPreview = null;
const activeCinematic = () => world.pursuit?.response &&
  (world.pursuit.phase === "running" || (isPackPursuit(world.pursuit.variant) &&
    (world.pursuit.packLab || world.pursuit.reviewUntilTick))) ? world.pursuit : null;
function previewVisible(pursuit = activeCinematic()) {
  return pursuit ? pursuitPreview?.run === pursuit && pursuitPreview.show : showCamera;
}
function updatePreview() {
  const visible = previewVisible();
  const label = $("cameraLabel");
  if (label.hidden === visible) label.hidden = !visible;
  const button = $("cameraBtn"), title = visible ? "Hide camera" : "Show camera";
  if (button.textContent !== title) button.textContent = title;
  const overlay = visible && sensorCamera === "front";
  if (overlay !== overlayPreview) {
    perceptionOverlay.setVisible(overlay);
    overlayPreview = overlay;
  }
}
let renderedFrames = 0;
let mainCalls = 0, mainTriangles = 0;
let lastShadowWorld = null, lastShadowTick = -1;
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
  touchPursuit.clear();
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
    updatePreview();
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
    activate(cityResumeEnvironment);
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
    activate(cityResumeEnvironment);
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
function startLocalCamera() {
  if (!cameraStartup) cameraStartup = visualClient.start().then(result => {
    if (result.ok) world.command({ type: "visual-reset", streamId: result.streamId });
    cityCameraError = result.ok ? null : result.error;
    return result;
  }).finally(() => {
    cameraStartup = null;
    updateUI();
  });
  return cameraStartup;
}

function requestCityDriver(target) {
  if (!hasCityCameraDriver(target)) return;
  if (target.visualMode !== cityDriver) target.command({ type: "visual-mode", mode: cityDriver });
  if (cityDriver === "vision-first" && (!visualClient.enabled || visualClient.restartRequired)) {
    cityCameraError = null;
    void startLocalCamera();
  }
}

async function cameraAction(action) {
  if (action === "start") {
    const active = world;
    const result = await startLocalCamera();
    if (!result.ok) return result;
    if (active === world && active.environment === "metro") {
      cityDriver = "vision-first";
      active.command({ type: "visual-mode", mode: cityDriver });
    }
  } else if (action === "stop") {
    pendingVisionRun = false;
    const result = await visualClient.stop();
    world.command({ type: "visual-reset", streamId: visualClient.streamId });
    if (environment === "metro") {
      cityDriver = "sensors-only";
      world.command({ type: "visual-mode", mode: cityDriver });
    }
    perceptionOverlay.setExternal(null);
    if (!result.ok) return result;
  } else if (action === "vision-lab") {
    cameraScreen.close();
    if (environment === "metro") activate("lab");
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
  const nextWorld = worlds[next] ?? new World(world.config, next);
  const sceneTransition = next !== environment;
  if (sceneTransition) {
    rememberPackPractice(world);
    scenePauses.set(world, paused);
  }
  setCarView("chase");
  phone?.reset();
  environment = next;
  world = worlds[next] = nextWorld;
  if (isCity(next)) cityResumeEnvironment = next;
  if (sceneTransition) paused = scenePauses.get(nextWorld) ?? false;
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
    next === "pursuit" ? (world.pursuit.packLab ? "Pursuit lab" : "Pursuit replay") : next === "egypt" ? "Egyptian district replay" :
      isCity(next) ? "City" : next === "vehicle" ? "Vehicle test bay" :
      next === "vision" ? "Visual prediction lab" : "Training lab";
  $("labBtn").textContent = isCity(next) ? "Lab" : "Return to city";
  $("mapLabel").textContent = isCity(next) ? "City" : next === "vehicle" ? "Vehicle bay" : "Lab";
  $("streetPursuitBtn").hidden = next !== "metro" && next !== "lab" && !world.pursuit?.packLab;
  $("streetPursuitBtn").textContent = next === "lab" ? "Pursuit drills"
    : world.pursuit?.packLab ? "Back to Lab" : "Pursuit";
  $("streetPursuitBtn").setAttribute("aria-expanded", String(next === "metro" && streetPursuitOpen));
  $("visionToggleBtn").hidden = next === "metro";
  $("phoneStatus").textContent =
    hasCityCameraDriver(world) && cityDriver === "vision-first"
      ? "Choosing a destination starts camera-first driving."
      : isCity(next) || next === "egypt"
      ? "Type or speak a destination, or choose a place."
      : "Choose the north or south lab destination.";
  $("labScenarios").hidden = next !== "lab";
  $("policyPanel").hidden = next !== "lab";
  $("aiToggleBtn").disabled = next === "vehicle" || next === "vision";
  $("phoneToggleBtn").disabled = next === "vehicle" || next === "vision" || next === "pursuit";
  if (next === "vehicle" || next === "vision" || next === "pursuit") {
    $("inGamePhone").hidden = true;
    $("phoneToggleBtn").setAttribute("aria-expanded", "false");
  }
  $("phonePlaces").replaceChildren(
    ...placesForWorld().map((place) => {
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
    if (name === "traffic" || name === "pedestrians")
      $("settingsForm").elements[name].max = hasCityCameraDriver(world)
        ? (world.config.cityVersion === 4 ? RUSH_CITY_POPULATION_LIMITS : METRO_POPULATION_LIMITS)[name]
        : name === "traffic" ? 72 : 96;
    $("settingsForm").elements[name].value = world.config[name];
    if ($(name + "Output")) $(name + "Output").textContent = world.config[name];
  }
  $("pursuitPanelHost").hidden = next !== "pursuit" && !(next === "metro" && streetPursuitOpen);
  $("districtControls").hidden = next !== "egypt";
  if (next === "egypt") {
    districtCaseId = world.config.districtCase;
    $("districtCase").value = districtCaseId;
    $("districtMode").value = world.visualMode;
  }
  updateUI();
  lastTime = performance.now();
}
function reset(options) {
  rememberPackPractice(world);
  const replacement = new World(environment === "metro"
    ? { cityVersion: world.config.cityVersion, ...options } : options, environment);
  if (replacement.pursuit?.packLab) packDrillWorld = replacement;
  view.dispose();
  views.delete(world);
  worlds[environment] = replacement;
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
  positionCameraPreview();
}
function positionCameraPreview() {
  const x = 24;
  const y = Math.ceil(viewportHeight - drivingHud.getBoundingClientRect().top + 12);
  const width = Math.max(1, Math.min(viewportWidth <= 850 ? 230 : 276, viewportWidth - x * 2,
    Math.max(100, Math.floor((viewportHeight - y - 146) * 16 / 9))));
  const height = Math.round(width * 9 / 16);
  previewViewport = { x, y, width, height };
  const label = $("cameraLabel");
  label.style.bottom = `${y + height}px`;
  label.style.width = `${width}px`;
}
addEventListener("resize", resize);
resize();
new ResizeObserver(positionCameraPreview).observe(drivingHud);
function autoToggle() {
  if (environment === "vehicle" || environment === "vision") return;
  world.command({
    type: "mode",
    mode: world.mode === "auto" ? "manual" : "auto",
  });
  const defaultPlace = world.district?.showcaseRoutes[0]?.goal ?? placesForWorld()[0];
  if (world.mode === "auto" && !world.player.path.length && !isPursuing() && defaultPlace)
    choosePlace(defaultPlace);
  else if (world.mode === "auto" && !isPursuing()) requestCityDriver(world);
}
function choosePlace(place) {
  const accepted = world.command({ type: "destination", place });
  if (accepted) requestCityDriver(world);
  return accepted;
}
phone = mountPhone({
  onDestination: choosePlace,
  getWorld: () => world,
  getPlaces: placesForWorld,
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
for (const [id, control] of [["pursuitTouchLeft", "ArrowLeft"], ["pursuitTouchRight", "ArrowRight"],
  ["pursuitTouchBrake", "Space"]]) {
  const button = $(id);
  button.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    touchPursuit.set(event.pointerId, control);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    button.addEventListener(type, event => touchPursuit.delete(event.pointerId));
}
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
  if (event.code === "KeyE") usePursuitPower();
  if (event.code === "KeyR" && world.pursuit?.survival && !isPursuing() && streetPursuitOpen &&
      streetPursuitStyle === "survival") $("pursuitRunBtn").click();
});
addEventListener("keyup", (event) => keys.delete(event.code));
addEventListener("blur", () => {
  keys.clear();
  touchPursuit.clear();
});
document.addEventListener("visibilitychange", () => {
  keys.clear();
  touchPursuit.clear();
  lastTime = performance.now();
  clock = new FixedClock();
});
$("aiToggleBtn").onclick = autoToggle;
$("labBtn").onclick = () => activate(isCity(environment) ? "lab" : cityResumeEnvironment);
$("streetPursuitBtn").onclick = () => {
  if (environment === "lab") {
    packDrillWorld ??= new World({ seed: world.config.seed, speedLimit: 48,
      pursuitVariant: "hunt", pursuitLevel: 3 }, "pursuit");
    worlds.pursuit = packDrillWorld;
    activate("pursuit");
    return;
  }
  if (world.pursuit?.packLab) {
    activate("lab");
    return;
  }
  streetPursuitOpen = !streetPursuitOpen;
  $("streetPursuitBtn").setAttribute("aria-expanded", String(streetPursuitOpen));
  settingsOpen(false);
  updateUI();
};
$("cameraBtn").onclick = () => {
  const run = activeCinematic();
  if (run) pursuitPreview = { run, show: !previewVisible(run) };
  else showCamera = !showCamera;
  updatePreview();
};
$("pauseBtn").onclick = () => {
  if (isInspection()) {
    setCarView("chase");
    paused = false;
  } else paused = !paused;
  keys.clear();
  touchPursuit.clear();
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
$("cityDriver").onchange = (event) => {
  cityDriver = event.target.value;
  if (world.mode === "auto") requestCityDriver(world);
  updateUI();
};
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
  try {
    reset({ ...Object.fromEntries(new FormData(event.target)),
      ...(environment === "egypt" ? { districtCase: districtCaseId } : {}),
      ...(environment === "pursuit" ? {
        pursuitLevel: world.pursuit.level,
        pursuitCase: world.pursuit.packLab ? world.pursuit.caseId : "ambient",
        ...(world.pursuit.packLab ? { pursuitVariant: world.pursuit.variant } : {}),
      } : {}) });
    $("settingsError").textContent = "";
  } catch (error) {
    $("settingsError").textContent = error.message;
  }
};
let pursuitWeights;
const CITY_POLICY_KEY = "ya-rab-ostorha:pursuit-hunt-v1";
let cityPracticeRun = null, savedPracticeRun = null, cityPolicyRead = false;
const CITY_RECORD_KEY = "ya-rab-ostorha:city-survival-best-v1";
const pursuitAudio = new PursuitAudio();
let heardRun = null, heardEvent = 0, scoredRun = null, bestSurvivalS = null;
try {
  const value = localStorage.getItem(CITY_RECORD_KEY);
  if (value !== null && Number.isFinite(Number(value)) && Number(value) >= 0) bestSurvivalS = Number(value);
} catch (error) {
  if (!(error instanceof DOMException)) throw error;
  console.warn("City pursuit records are available in this tab only.", error);
}

function usePursuitPower() {
  if (!paused && world.pursuit?.survival) world.command({ type: "pursuit-use" });
}

function updateSurvivalFeedback() {
  const run = world.pursuit;
  const active = run?.survival && (run.phase === "running" || run.reviewUntilTick);
  if (heardRun !== run) {
    heardRun = run;
    heardEvent = 0;
  }
  const audible = Boolean(active && !paused && !document.hidden);
  pursuitAudio.update(world, audible);
  if (active) for (const event of run.survival.effects) {
    if (event.id <= heardEvent) continue;
    heardEvent = event.id;
    if (audible) pursuitAudio.play(event);
  }
  if (run?.survival && !active && scoredRun !== run && ["crashed", "escaped", "captured"].includes(run.phase)) {
    scoredRun = run;
    if (run.metrics.survivalS > (bestSurvivalS ?? 0)) {
      bestSurvivalS = run.metrics.survivalS;
      try {
        localStorage.setItem(CITY_RECORD_KEY, String(bestSurvivalS));
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        console.warn("Best City pursuit time is saved for this tab only.", error);
      }
    }
  }
}

function readCityPractice() {
  if (!cityPolicyRead) {
    cityPolicyRead = true;
    try {
      const saved = localStorage.getItem(CITY_POLICY_KEY);
      if (saved) cityPackCheckpoint = validatePackPolicy(JSON.parse(saved));
    } catch (error) {
      console.warn("Saved City pursuit policy unavailable; starting with the built-in policy.", error);
    }
  }
  return cityPackCheckpoint;
}

function rememberPackPractice(target) {
  const state = target.pursuit;
  if (!isPackPursuit(state?.variant) || state.driver !== "training" ||
      (!state.packLab && state !== cityPracticeRun) ||
      state === savedPracticeRun || !state.learner.snapshot().updates) return;
  if (state.packLab) labPackCheckpoint = state.learner.checkpoint();
  else {
    cityPackCheckpoint = state.learner.checkpoint();
    try {
      localStorage.setItem(CITY_POLICY_KEY, JSON.stringify(cityPackCheckpoint));
    } catch (error) {
      console.warn("City training is retained for this page only; the browser could not save it.", error);
    }
  }
  if (state.phase !== "running") savedPracticeRun = state;
}

function packPatrolStatus(state) {
  const patrols = [...state.patrols].filter(car => !state.gta || car.aiState !== "WRECKED");
  const nearestM = Math.min(...patrols.map(car => distance(car, world.player)));
  return { active: patrols.length, target: state.targetPatrols, nearestM, sectors: state.metrics.surroundSectors };
}

const pursuitPanel = mountPursuitPanel({
  container: $("pursuitPanelHost"),
  onRun: async (learn, useLabPolicy) => {
    const active = world;
    if (active.environment === "metro") {
      rememberPackPractice(active);
      const arcade = active.config.cityVersion === 4 && streetPursuitStyle === "survival";
      const gta = active.config.cityVersion === 4 && streetPursuitStyle === "gta";
      if (!arcade && !gta && useLabPolicy && !labPackCheckpoint) throw new Error("Complete a learning run in the Lab first.");
      const checkpoint = arcade || gta ? null : useLabPolicy ? labPackCheckpoint : readCityPractice();
      active.command({ type: "street-pursuit-start", level: streetPursuitLevel,
        ...(gta ? { variant: "gta" } : arcade ? { variant: "survival" } : active.config.cityVersion === 4 ? { variant: "hunt", learn: !useLabPolicy && learn,
          ...(checkpoint ? { checkpoint, ...(!useLabPolicy ? { localPolicy: true } : {}) } : {}) } : {}) });
      if (arcade) void pursuitAudio.unlock();
      cityPracticeRun = active.pursuit.driver === "training" ? active.pursuit : null;
      paused = false;
      lastInput = "";
      updateUI();
      return true;
    }
    if (active.pursuit?.packLab) {
      active.command({ type: "pursuit-run", learn, ...(learn && labPackCheckpoint ? { checkpoint: labPackCheckpoint } : {}) });
      paused = false;
      lastInput = "";
      settingsOpen(false);
      updateUI();
      return true;
    }
    if (!active.pursuit || active.pursuit.phase !== "ready" || active.pursuit.loadingPolicy) return;
    active.pursuit.loadingPolicy = true;
    try {
      if (!pursuitWeights) {
        const response = await fetch("/public/threejs/pursuit.policy.json");
        if (!response.ok) throw new Error("Learned policy is unavailable");
        pursuitWeights = await response.json();
      }
      if (world !== active) return;
      active.command({ type: "pursuit-policy", weights: pursuitWeights });
      active.pursuit.policyNote = null;
    } catch (error) {
      active.pursuit.policyNote = `${error.message}. Using the deterministic planner.`;
      pursuitWeights = null;
    } finally {
      active.pursuit.loadingPolicy = false;
    }
    if (world !== active) return;
    active.command({ type: "pursuit-run" });
    paused = false;
    settingsOpen(false);
    updateUI();
  },
  onRestart: () => {
    if (environment === "metro") {
      world.command({ type: "street-pursuit-stop" });
      touchPursuit.clear();
      rememberPackPractice(world);
      lastInput = "";
      updateUI();
    } else if (world.pursuit) reset(world.config);
  },
  onLevel: (level) => {
    if (environment === "metro") {
      streetPursuitLevel = level;
      updateUI();
    } else if (world.pursuit) reset({ ...world.config, pursuitLevel: level });
  },
  onStyle: (style) => {
    if (!["survival", "hunt", "gta"].includes(style)) return;
    streetPursuitStyle = style;
    if (style !== "gta") streetPursuitLevel = Math.min(4, streetPursuitLevel);
    updateUI();
  },
  onUse: usePursuitPower,
  onSound: () => {
    pursuitAudio.muted = !pursuitAudio.muted;
    if (pursuitAudio.muted) pursuitAudio.quiet();
    else void pursuitAudio.unlock();
    updateUI();
  },
  onCase: (caseId) => {
    if (!world.pursuit?.packLab) throw new Error("Pursuit drills are only available in the Lab.");
    reset({ ...world.config, pursuitCase: caseId });
  },
});
for (const item of DISTRICT_CASES) {
  if (item.id === "ambient") continue;
  const option = document.createElement("option");
  option.value = item.id;
  option.textContent = item.label;
  $("districtCase").append(option);
}
function resetDistrict() {
  const previous = worlds.egypt;
  const replacement = new World({ ...world.config, districtCase: districtCaseId }, "egypt");
  replacement.command({ type: "visual-mode", mode: world.visualMode });
  views.get(previous)?.dispose();
  views.delete(previous);
  worlds.egypt = replacement;
  activate("egypt");
}
$("districtCase").onchange = (event) => {
  const previous = districtCaseId;
  districtCaseId = event.target.value;
  try {
    resetDistrict();
    $("settingsError").textContent = "";
  } catch (error) {
    districtCaseId = previous;
    event.target.value = previous;
    $("settingsError").textContent = error.message;
  }
};
$("districtResetBtn").onclick = () => {
  try {
    resetDistrict();
    $("settingsError").textContent = "";
  } catch (error) {
    $("settingsError").textContent = error.message;
  }
};
$("districtRunBtn").onclick = async () => {
  try {
    if (world.visualMode === "vision-first") {
      const started = await cameraAction("start");
      if (!started.ok) throw new Error(started.error);
      await new Promise((resolve, reject) => {
        const startedAt = performance.now(), expected = visualClient.streamId;
        const wait = () => {
          if (world.environment !== "egypt" || visualClient.streamId !== expected)
            reject(new Error("The encounter was replaced while starting its camera."));
          else if (visualClient.status.result?.streamId === expected) resolve();
          else if (performance.now() - startedAt > 15000)
            reject(new Error("A fresh camera observation is required before the encounter."));
          else setTimeout(wait, 50);
        };
        wait();
      });
    }
    world.command({ type: "district-run" });
    paused = false;
    settingsOpen(false);
    $("settingsError").textContent = "";
  } catch (error) {
    $("settingsError").textContent = error.message;
  }
};
$("districtMode").onchange = (event) => world.command({ type: "visual-mode", mode: event.target.value });
$("districtReturnBtn").onclick = () => activate(cityResumeEnvironment);
$("stressBtn").onclick = () => {
  const form = $("settingsForm");
  for (const [key, value] of Object.entries({
    traffic: Number(form.elements.traffic.max),
    pedestrians: Number(form.elements.pedestrians.max),
    chaos: 1,
  })) {
    form.elements[key].value = value;
    $(key + "Output").textContent = value;
  }
  try {
    reset({ ...Object.fromEntries(new FormData(form)),
      ...(environment === "egypt" ? { districtCase: districtCaseId } : {}) });
    $("settingsError").textContent = "";
  } catch (error) {
    $("settingsError").textContent = error.message;
  }
};
$("replayBtn").onclick = () => {
  let blob;
  try {
    blob = createReplayBlob(world.replay());
  } catch (error) {
    $("replayProgress").textContent = `Could not save replay: ${error.message}`;
    return;
  }
  const url = URL.createObjectURL(blob);
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
    const replay = await readReplayFile(file),
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
    pressed = (code) => !editing && (keys.has(code) ||
      (touchPursuit.size && [...touchPursuit.values()].includes(code)));
  if (world.pursuit?.reviewUntilTick) return;
  if (isPursuing()) {
    if (paused) return;
    if (pressed("Space") && world.mode === "auto") world.command({ type: "mode", mode: "manual" });
    if (world.mode !== "manual") return;
    const reverse = pressed("KeyS") || pressed("ArrowDown");
    const steer = Number(pressed("KeyD") || pressed("ArrowRight")) -
      Number(pressed("KeyA") || pressed("ArrowLeft"));
    const command = { type: "pursuit-drive", action: {
      steer: world.pursuit.survival ? -steer : steer,
      throttle: Number(reverse || pressed("KeyW") || pressed("ArrowUp")),
      brake: Number(pressed("Space")), gear: reverse ? -1 : 1,
    } };
    const signature = JSON.stringify(command);
    if (signature !== lastInput) {
      world.command(command);
      lastInput = signature;
    }
    return;
  }
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
const streetEncounterLabels = {
  "curb-pickup": "Taxi or microbus pickup",
  "traffic-wave": "Stop-and-go traffic",
  "side-street-tuktuk": "Tuk-tuk at a side street",
  "curb-crossing": "Pedestrian crossing",
  roadworks: "Street maintenance",
};
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
  "observed-approach-slow": "Camera: slowing before a crossing",
  "observed-person-crossing-conflict": "Camera: braking for a crossing",
  "observed-motion-crossing-conflict": "Camera: braking for a crossing",
  "camera-evidence-unavailable": "Waiting for a fresh camera frame",
  "camera-support-stale": "Camera evidence too old",
  "camera-recovering": "Camera recovering",
  "awaiting-fresh-visual-clearance": "Waiting to see the crossing clear",
  "no-route": "No legal route",
  arrived: "Arrived",
};
function updateUI() {
  const survivalDriving = world.pursuit?.phase === "running" && world.pursuit.survival &&
    world.mode === "manual" && !paused && !isInspection() && !focusedPersonId;
  $("pursuitTouch").hidden = !survivalDriving;
  if (!survivalDriving) touchPursuit.clear();
  saveVisionComparison();
  if (pursuitPreview && pursuitPreview.run !== activeCinematic()) pursuitPreview = null;
  updatePreview();
  $("pauseBtn").textContent = paused ? "Resume" : "Pause";
  $("speedVal").textContent = Math.round(Math.abs(world.player.speed) * 3.6);
  $("aiToggleBtn").textContent =
    world.mode === "auto" ? "Autonomous drive" : "Manual drive";
  $("safetyStatus").textContent = paused
    ? "Simulation paused"
    : world.destination && !world.player.path.length &&
        !(environment === "metro" && world.pursuit?.resumeTrip && !world.pursuit.tripResumed)
      ? "Destination reached"
      : (reasons[world.player.reason] ?? world.player.reason);
  const controlBasis = isPursuing() ? world.mode === "auto" ? "Virtual ranging" : "Manual" : "Control";
  const cameraControlReason = isPursuing() && world.player.reason === "driving" ? "Driving" :
    (reasons[world.player.reason] ?? world.player.reason);
  $("cameraDecision").textContent =
    `${controlBasis}: ${cameraControlReason}${world.player.blockedBy ? ` · ${world.player.blockedBy}` : ""}`;
  $("tripLabel").textContent = world.destination
    ? `${world.destination.name ?? "Destination"} · ${world.player.path.length ? "En route" : "Arrived"}`
    : "Choose a destination on the phone";
  $("diagnostics").textContent =
    `Seed: ${world.config.seed} · Tick ${world.tick} | ${world.capacity.traffic} vehicles / ${world.capacity.pedestrians} pedestrians | ${Math.round(world.metrics.distance)} m | Safety interventions: ${world.metrics.interventions} | Player wait: ${world.metrics.waitSeconds.toFixed(1)} s`;
  $("scenarioStatus").textContent = world.scenario
    ? `${{ crossing: "Pedestrian crossing", "side-traffic": "Side street tuk-tuk", barrier: "Road barrier" }[world.scenario.kind]} · ${world.scenario.applied ? "Active" : "Deferred: no free space"}`
    : "Seeded scenarios run on a replayable schedule";
  const encounter = world.cityEncounters?.events.findLast(event => event.phase === "applied");
  $("cityDriverSettings").hidden = !hasCityCameraDriver(world);
  $("cityDriver").value = cityDriver;
  if (hasCityCameraDriver(world)) $("cityDriverStatus").textContent =
    cityDriver === "sensors-only" ? "Camera does not control speed in this comparison." :
    cityCameraError ? `${cityCameraError} Retry from Camera, or use Sensors only.` :
    cameraStartup ? "Starting the local detector. The car waits for fresh frames." :
    "The local detector starts when you choose a destination or switch to autopilot.";
  $("streetEncounterStatus").hidden = environment !== "metro";
  $("streetEncounterStatus").textContent = world.config.chaos === 0
    ? "Scheduled street events are off."
    : encounter ? `Latest: ${streetEncounterLabels[encounter.kind]} · ${world.metrics.scenarios} street events so far.`
    : "Street events vary with the seed, traffic and location.";
  $("graphicsAdapter").textContent = graphicsAdapter ?? "Adapter not reported by this browser";
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
  if (environment === "metro") {
    const roadReading = onRoadLimit(world, world.player);
    const { roadId, width } = roadReading;
    const result = world.pursuit;
    const gta = result?.phase === "running" ? result.variant === "gta" : streetPursuitStyle === "gta";
    if (result && result.phase !== "running") rememberPackPractice(world);
    const dispatch = result?.phase === "running" && usesRushPace(result.variant);
    const limit = dispatch ? rushRoadLimit(roadReading) : roadReading.limit;
    const road = world.drivingRoads.find(entry => entry.id === roadId);
    const street = road?.zone === "avenue" ? "Avenue" : width > 0 && width <= 3.8 ? "Alley" : "Neighborhood";
    const pace = Number.isFinite(limit) ? ` · limit ${Math.round(Math.min(limit, world.player.maxSpeed) * 3.6)} km/h` : "";
    $("loadingStatus").textContent = `${street}${pace} · ${world.capacity.traffic} vehicles · ${world.capacity.pedestrians} people`;
    $("mapLabel").textContent = isPursuing() ? `${street} pursuit` : street;
    if (isPursuing())
      $("tripLabel").textContent = world.pursuit.route
        ? `Pursuit · ${world.pursuit.route.id.replace(/^metro-exit-/, "").replaceAll("-", " ")}`
        : world.pursuit.gta ? "GTA Chase · live City streets"
        : world.pursuit.survival ? "Pursuit · live City streets" : "Pursuit · checking exits";
    else if (world.destination && !world.player.path.length && world.pursuit?.resumeTrip && !world.pursuit.tripResumed)
      $("tripLabel").textContent = "Trip paused · choose a destination";
    $("pursuitPanelHost").hidden = !streetPursuitOpen;
    pursuitPanel.update(streetPursuitOpen ? {
      ...(result ? pursuitSnapshot(world) : { phase: "ready", metrics: {} }),
      street: true, mode: world.mode, paused,
      cinematic: Boolean(result?.response) || (!result && world.config.cityVersion === 4),
      arcade: world.config.cityVersion === 4,
      cityPursuitStyle: world.config.cityVersion === 4 ? streetPursuitStyle : null,
      bestSurvivalS, soundMuted: pursuitAudio.muted, soundError: pursuitAudio.error,
      pack: !gta && world.config.cityVersion === 4 && (!dispatch || isPackPursuit(result.variant)),
      labPolicyAvailable: Boolean(labPackCheckpoint),
      speedMps: world.player.speed,
      dispatchWaves: world.config.cityVersion === 4,
      patrolStatus: dispatch || result?.reviewUntilTick || result?.gta ? packPatrolStatus(result) : null,
      appliedSpeedMps: world.player.districtSources?.finalMps,
      appliedSource: world.player.districtSources?.appliedSource,
      level: result?.phase === "running" ? result.level : streetPursuitLevel,
    } : null);
  } else if (world.district) {
    const state = world.districtCase;
    $("loadingStatus").textContent = state && state.id !== "ambient"
      ? `Isolated district encounter · ${state.id} · ${state.phase} · ${world.capacity.traffic} traffic / ${world.capacity.pedestrians} people`
      : `Egyptian district · ${world.config.seed} · ${world.capacity.traffic} traffic / ${world.capacity.pedestrians} people`;
    const source = world.player.districtSources;
    $("districtStatus").textContent = state?.error ?? (
      world.mode === "auto" && world.visualMode === "vision-first" && !visualClient.enabled
      ? "Camera unavailable. Open Camera and Start detector for predictive driving; map caution is not vision."
      : source
      ? `Applied: ${source.appliedSource} · ${source.finalMps.toFixed(2)} m/s. Camera and static-map caution are separate.`
      : "Choose a destination or an isolated encounter. Camera inference starts only by an explicit action.");
    $("districtRunBtn").disabled = !state || state.id === "ambient" || state.phase !== "ready";
  }
  if (environment === "vehicle") {
    $("loadingStatus").textContent = view.status.failed.length
      ? "Car model failed to load. Reload the page to retry."
      : `Vehicle test bay · ${world.vehicleTest?.phase ?? "ready"} · isolated contact fixture`;
    $("scenarioStatus").textContent = "Vehicle-only fixture. Normal city safety remains unchanged.";
  }
  if (environment === "pursuit") {
    $("tripLabel").textContent = world.pursuit.route?.id
      ? `Exit ${world.pursuit.route.id}` : "Pursuit";
    $("loadingStatus").textContent = world.pursuit.policyNote ??
      `Pursuit · ${world.config.seed} · level ${world.pursuit.level}`;
    const packLab = world.pursuit.packLab;
    pursuitPanel.update({ ...pursuitSnapshot(world), mode: world.mode, paused,
      ...(packLab ? { cinematic: true, arcade: true, cases: PACK_DRILLS,
        speedMps: world.player.speed, patrolStatus: packPatrolStatus(world.pursuit) } : {}) });
  } else if (environment !== "metro") pursuitPanel.update(null);
  drawMap();
}
const map = $("minimap").getContext("2d");
function drawMap() {
  const scale = environment === "metro" ? 1.35 : environment === "pursuit" ? 1.55 :
    environment === "egypt" ? 1.4 : environment === "city" ? .93 : 2.25;
  const cx = 110 - (environment === "metro" ? world.player.x * scale : 0);
  const cz = 110 - (environment === "metro" ? world.player.z * scale : 0);
  map.clearRect(0, 0, 220, 220);
  map.fillStyle = "#293930";
  map.fillRect(0, 0, 220, 220);
  const line = (points, color, width) => {
    map.strokeStyle = color;
    map.lineWidth = width;
    map.beginPath();
    points.forEach((p, i) =>
      map[i ? "lineTo" : "moveTo"](cx + p.x * scale, cz + p.z * scale),
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
      road.zone === "avenue" ? "#a3ad9c" : "#738075",
      road.width * scale,
    );
  if (world.player.path.length) line(world.player.path, "#a5e4bc", 1.8);
  for (const actor of world.actors) {
    map.fillStyle =
      actor === world.player
        ? "#f6efd8"
        : actor.pursuitRole === "police" ? "#ff887a" : actor.type === "pedestrian"
          ? "#dac29c"
          : "#a5b6b0";
    map.beginPath();
    map.arc(
      cx + actor.x * scale,
      cz + actor.z * scale,
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
    applied: { reason: world.player.reason, ...(world.district
      ? { districtSources: world.player.districtSources } : {}) },
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
  const survivalReview = world.pursuit?.survival && world.pursuit.reviewUntilTick;
  if (!paused && !document.hidden) clock.advance(delta * (survivalReview && !reducedMotion.matches ? .33 : 1),
    () => world.step(), environment === "metro" ? 5 : Infinity);
  updateSurvivalFeedback();
  const player = view.sync(clock.alpha);
  const cinematic = activeCinematic();
  const preview = previewVisible(cinematic);
  // Keep the full scene and camera cadence; the static sun's depth map
  // does not need to be rebuilt up to 60 times a second in a dense City.
  const shadowTicks = world.config.cityVersion === 4 && world.capacity.traffic >= 72 ? 3 : 1;
  if (environment !== "metro" || world !== lastShadowWorld || world.tick - lastShadowTick >= shadowTicks ||
      isInspection() || cameraSnap || appliedCutaway !== cutaway) {
    renderer.shadowMap.needsUpdate = true;
    lastShadowWorld = world;
    lastShadowTick = world.tick;
  }
  if (view.playerRig && (inspectionRig !== view.playerRig
      || appliedCutaway !== cutaway || appliedSensors !== sensorView)) {
    view.playerRig.setInspection({ cutaway, sensors: sensorView });
    inspectionRig = view.playerRig;
    appliedCutaway = cutaway;
    appliedSensors = sensorView;
  }
  forward.set(Math.sin(player.rotation.y), 0, Math.cos(player.rotation.y));
  const personRoot = focusedPersonId ? view.roots.get(focusedPersonId)?.root : null;
  const pursuitShot = cinematic && !personRoot && cameraMode === "chase" ? cinematic : null;
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
  } else if (pursuitShot) {
    pursuitCamera.update(camera, {
      position: player.position,
      heading: player.rotation.y,
      speedMps: Math.abs(world.player.speed),
      streetWidthM: onRoadLimit(world, world.player).width,
      staticIndex: world.staticIndex,
      deltaS: delta,
      snap: cameraSnap || pursuitShot !== lastPursuitShot,
      pack: isPackPursuit(pursuitShot.variant),
      packLab: pursuitShot.packLab && pursuitShot.patrols.size >= 3,
      impactReview: pursuitShot.metrics.terminalCause === "pedestrian-impact" || Boolean(survivalReview && !reducedMotion.matches),
    });
  } else {
    const openPursuit = world.pursuit?.variant === "rush" && world.pursuit.phase === "running" &&
      onRoadLimit(world, world.player).width >= 10;
    offset.copy(player.position).addScaledVector(forward, openPursuit ? -19.8 : -10.5);
    if (openPursuit) {
      offset.x += forward.z * 3.2;
      offset.z -= forward.x * 3.2;
    }
    offset.y += openPursuit ? 8.5 : 5;
    camera.position.lerp(offset, cameraSnap ? 1 : 1 - Math.exp(-delta * 6));
    target.copy(player.position).addScaledVector(forward, openPursuit ? -3 : 5);
    target.y += 1;
    camera.lookAt(target);
  }
  lastPursuitShot = pursuitShot;
  // The high chase eye needs more depth precision for layered paving.
  const near = isPackPursuit(pursuitShot?.variant) && camera.position.distanceToSquared(player.position) >= 144
    ? 2.4 : 0.1;
  if (camera.near !== near) {
    camera.near = near;
    camera.updateProjectionMatrix();
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
  const captureVision = (visualClient.enabled || cameraScreenVisible) && mountedCameraPose(player, "sensor");
  if (captureVision) {
    visionCamera.position.copy(offset);
    visionCamera.lookAt(target);
  }
  view.selectedPersonId = $("peopleToggleBtn").getAttribute("aria-expanded") === "true" ? selectedPersonId : null;
  view.prepareFrame({ cameras: [camera, preview ? frontCamera : null, captureVision ? visionCamera : null] });
  if (captureVision) {
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
  const routeVisible = view.route.visible;
  if (cinematic && $("inspectorPanel").hidden) view.route.visible = false;
  renderer.render(view.scene, camera);
  mainCalls = renderer.info.render.calls;
  mainTriangles = renderer.info.render.triangles;
  renderedFrames++;
  if (preview) {
    const { x, y, width, height } = previewViewport;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, width, height);
    renderer.setViewport(x, y, width, height);
    renderer.clearDepth();
    renderer.render(view.scene, frontCamera);
    perceptionOverlay.setViewport(previewViewport);
    if (time - lastFrame > 1000) {
      bridge.sendFrame(previewViewport);
      lastFrame = time;
    }
    renderer.setScissorTest(false);
  }
  view.route.visible = routeVisible;
  if (time - lastUI > 180) {
    updateUI();
    lastUI = time;
  }
}
activate("metro");
requestAnimationFrame(frame);
// Reproducible diagnostics used by browser smoke tests and Python adapters.
window.sim = {
  pursuitAudio: () => ({ ...pursuitAudio.cues, muted: pursuitAudio.muted, audible: Boolean(pursuitAudio.audible) }),
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
      mainCalls, mainTriangles,
      residentGeometries: renderer.info.memory.geometries,
      actors: view.actorDiagnostics(),
      backend: gl.getParameter(gl.VERSION),
      renderer: gl.getParameter(gl.RENDERER),
      graphicsAdapter,
      discardedSimSeconds: clock.discardedSeconds,
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
