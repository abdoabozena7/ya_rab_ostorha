import * as THREE from "three";
import { World } from "./core/world.js";
import { JETOUR_T2_ID, KING_LONG_MICROBUS_ID } from "./core/vehicle-spec.js";
import {
  GRAND_CITY_POPULATION_LIMITS,
  METRO_POPULATION_LIMITS,
  RUSH_CITY_POPULATION_LIMITS,
} from "./core/unified-city.js";
import { FixedClock } from "./core/clock.js";
import { WorldView } from "./render/world-view.js";
import { createPursuitCamera } from "./render/pursuit-camera.js";
import { CITY_CLEAR_CINEMATIC_GRADE, createCinematicPost } from "./render/cinematic-post.js";
import { createMetroPlanarReflections } from "./render/metro-planar-reflections.js";
import { createPakoPerspective } from "./render/pako-perspective.js";
import { createPedestrianForecastView } from "./render/pedestrian-forecast-view.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PLACES, LAB_PLACES } from "./core/places.js";
import { mountPhone } from "./ui/phone.js";
import { createBridge, createVisualClient } from "./integration/bridge.js";
import { createPerceptionOverlay } from "./ui/perception-overlay.js";
import { createDecisionInspector } from "./ui/decision-inspector.js";
import { mountGraphicsSettings } from "./ui/graphics-settings.js";
import { bodyOnRoad, distance, isDiagonalRoad } from "./core/geometry.js";
import { mountVehiclePanel } from "./ui/vehicle-panel.js";
import { mountVisionPanel } from "./ui/vision-panel.js";
import { mountCameraScreen } from "./ui/camera-screen.js";
import { mountPeoplePanel } from "./ui/people-panel.js";
import { mountCityPerception, pedestrianForecasts } from "./ui/city-perception.js";
import { createReplayBlob, readReplayFile } from "./ui/replay-file.js";
import { DISTRICT_CASES } from "./core/district-scenarios.js";
import { pursuitSnapshot } from "./core/pursuit-world.js";
import { streetChaosSnapshot } from "./core/street-chaos.js";
import { DISPATCH_DAMAGE_FEEDBACK, PATROL_TRAFFIC_PREVIEW } from "./core/pursuit-gta.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "./core/pako-aggressive-police.js";
import { CITY_PACK_PRESSURE, TACTICAL_PURSUIT_MODE } from "./core/pako-tactical-police.js";
import { METRO_CITY_CURBS, METRO_CURB_SUPPORT } from "./core/pako-curb.js";
import { PATROL_LATERAL_YIELD } from "./core/pako-patrol-yield.js";
import { SURVIVAL_GIANT_PHYSICS } from "./core/pursuit-survival.js";
import { OBSERVED_CORRIDOR_MEMORY, PURSUIT_STOP } from "./core/pursuit-controls.js";
import { PACK_DRILLS } from "./core/pack-drills.js";
import { mountPursuitPanel } from "./ui/pursuit-panel.js";
import { mountPursuitStrobe } from "./ui/pursuit-strobe.js";
import { mountStreetChaosHud } from "./ui/street-chaos-hud.js";
import { mountForecastComparison, mountRolloutPlayback } from "./ui/pako-rollouts.js";
import { PursuitAudio } from "./ui/pursuit-audio.js";
import { isPackPursuit, onRoadLimit, rushRoadLimit, usesRushPace } from "./core/district-behavior.js";
import { validatePackPolicy } from "./core/pack-driving.js";
import { freezePursuitPolicy, PursuitPpo } from "./rl/pursuit-ppo.js";
import { SMART_ESCAPE_CONTROL } from "./rl/pako-smart-escape.js";
import { applyFrozenDispatchAction } from "./rl/pursuit-controller.js";
import { PursuitDecisionTrace, finishPursuitDecision, observePursuitDecision,
  startPursuitDecision } from "./rl/pursuit-diagnostics.js";
import { CLEARANCE_ROUTE_CONTEXT, LEGACY_ROUTE_CONTEXT } from "./rl/pursuit-route-context.js";
import labCurriculum from "../config/pursuit-rl-development.json";
import labRouteCurriculum from "../config/pursuit-rl-route-development.json";
import labClearanceCurriculum from "../config/pursuit-rl-city-route-development.json";
import labChaseCurriculum from "../config/pursuit-rl-city-escape-focus.json";
import pakoReleasePolicies from "../config/pako-release-policies.json";
import { PursuitScanner, PURSUIT_SCAN_TICKS } from "./signal_processing/pursuit-scanner.js";

const $ = (id) => document.getElementById(id);
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
});
const gl = renderer.getContext();
const hardwareInfo = gl.getExtension("WEBGL_debug_renderer_info");
const graphicsAdapter = hardwareInfo ? gl.getParameter(hardwareInfo.UNMASKED_RENDERER_WEBGL) : null;
const isIntegratedApu = /Radeon\(TM\) Graphics|Intel|UHD|Iris|SwiftShader|Basic Render/i.test(
  graphicsAdapter ?? "",
);
const supportsLiveReflections =
  renderer.capabilities.isWebGL2 && renderer.extensions.has("EXT_color_buffer_float");
const maxDisplayEdge = Math.min(renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
const maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
const MAX_METRO_DISPLAY_PIXELS = 3840 * 2160;
renderer.domElement.className = "scene";
document.body.prepend(renderer.domElement);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = isIntegratedApu ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.info.autoReset = false;
renderer.debug.checkShaderErrors = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.14;
let viewportWidth = document.documentElement.clientWidth;
let viewportHeight = innerHeight;
const drivingHud = document.querySelector(".driving-hud");
let previewViewport;
const camera = new THREE.PerspectiveCamera(
  62,
  viewportWidth / viewportHeight,
  0.1,
  950,
);
const frontCamera = new THREE.PerspectiveCamera(76, 16 / 9, 0.1, 52);
const visionCamera = new THREE.PerspectiveCamera(76, 16 / 9, 0.1, 250);
const frontPreviewTarget = new THREE.WebGLRenderTarget(240, 135, {
  samples: 0,
  depthBuffer: true,
  stencilBuffer: false,
  colorSpace: THREE.SRGBColorSpace,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  generateMipmaps: false,
});
const previewBlitScene = new THREE.Scene();
const previewBlitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const previewBlitMat = new THREE.MeshBasicMaterial({
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});
const previewBlitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), previewBlitMat);
previewBlitQuad.frustumCulled = false;
previewBlitScene.add(previewBlitQuad);
const pursuitCamera = createPursuitCamera();
const cinematicPost = createCinematicPost(renderer, {
  samples: isIntegratedApu ? 0 : 4,
  grade: CITY_CLEAR_CINEMATIC_GRADE,
});
const metroReflections = createMetroPlanarReflections(renderer);
let lastImpactWorld = null, lastImpactCount = 0, cameraImpactPulse = 0;
const worlds = { metro: new World({ cityVersion: 5 }, "metro") };
worlds.metro.command({ type: "player-vehicle", model: KING_LONG_MICROBUS_ID });
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
  chaseCameraStyle = "follow",
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
let phone, vehiclePanel, visionPanel, visualClient, cameraScreen, peoplePanel, cityPerception, cairoChaosHud;
const senseScanner = new PursuitScanner();
const pedestrianForecastView = createPedestrianForecastView();
let senseScan = null, senseWorld = null, senseForecasts = [];
let selectedPersonId = null, focusedPersonId = null, cameraScreenVisible = false;
let visionCaseId = "cross-left", visionMode = "vision-first", pendingVisionRun = false;
let districtCaseId = "ambient", streetPursuitOpen = false, streetPursuitLevel = 3, streetPursuitStyle = "survival";
let pakoPanelOpen = false, useEvasionPreview = false, useSurveyedCurb = false;
let pakoDriverMode = "rl", customCheckpoint = false, defaultChaseReady = false;
const isDispatchStyle = style => style === "dispatch" || style === "dispatch-ppo" || style === "pako";
const isGtaStyle = style => style === "gta" || isDispatchStyle(style);
let dispatchCheckpoint = null, checkpointStatus = "";
const formatPpoSummary = policy => policy
  ? `${policy.updates} updates · ${policy.transitions >= 1000 ? `${(policy.transitions / 1000).toFixed(1)}k` : policy.transitions} steps · ε = 0.20`
  : "";
let replayLoad = null;
const labPpoCheckpoints = new Map();
let labPpoWorker = null;
let labSession = null;
const ghostPlayback = mountRolloutPlayback(document, worlds.metro.drivingRoads);
mountForecastComparison(document);
const perspectiveGhosts = createPakoPerspective();
let lastPerspectiveReplay = null;
let packDrillWorld = null, labPackCheckpoint = null, cityPackCheckpoint = null;
let cityDriver = "vision-first", cameraStartup = null, cityCameraError = null;
const hasCityCameraDriver = (target) => target.environment === "metro" && target.config.cityVersion >= 3;
const hasMetroGraphics = (target) => target.environment === "metro" && target.config.cityVersion >= 5;
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
  if (pursuit) return pursuitPreview?.run === pursuit && pursuitPreview.show;
  if (cityPerception?.open) return false;
  return showCamera;
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
let mainCalls = 0, mainTriangles = 0, totalFrameCalls = 0, totalFrameTriangles = 0;
let shadowPassFrames = 0, visionCaptureFrames = 0, frontPreviewFrames = 0;
let lastShadowWorld = null, lastShadowFrame = -99, lastPerceptionTime = -999, lastVisionCaptureTick = -999;
let inspectionRig = null, appliedCutaway = null, appliedSensors = null;
let freeCameraShotOverride = null;
const isInspection = () => cameraMode === "inspection" || cameraMode === "running-gear";
function setChaseCameraStyle(style) {
  if (!["follow", "chasing"].includes(style)) throw new Error("Unknown chase camera style");
  chaseCameraStyle = style;
  if (cameraMode !== "chase") setCarView("chase");
  const btn = $("chaseCamBtn");
  if (btn) {
    btn.textContent = chaseCameraStyle === "chasing" ? "Chasing cam" : "Behind car";
    btn.setAttribute("aria-pressed", String(chaseCameraStyle === "chasing"));
  }
}
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
  else if (action === "player-vehicle") {
    const result = world.command({ type: "player-vehicle", model: value });
    if (!result.ok || !result.changed) return result;
    keys.clear();
    touchPursuit.clear();
    touchNitroActive = false;
    lastInput = "";
    freeCameraShotOverride = null;
    cameraSnap = true;
    senseWorld = senseScan = null;
    senseForecasts = [];
    lastVisionCaptureTick = -999;
    world.command({ type: "visual-reset", streamId: visualClient.reset() });
    perceptionOverlay.setExternal(null);
    phone.reset();
    view.crashEffects?.clearPlayerDebris();
    view.sync(1);
    updateUI();
    return result;
  } else if (action === "cutaway") cutaway = Boolean(value);
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
  } else if (action === "heavy-impact-run") {
    if (environment !== "vehicle" || world.vehicleTest?.phase !== "ready")
      return { ok: false, error: "Enter the vehicle test bay and reset it before starting a heavy crash run." };
    setCarView("chase");
    paused = false;
    cutaway = false;
    if (!world.command({ type: "vehicle-test", operation: "run", heavy: true }))
      return { ok: false, error: "The heavy crash run could not start. Reset the vehicle test bay." };
  } else if (action === "reset-car") {
    if (environment !== "vehicle")
      return { ok: false, error: "Car repair/reset is available in the isolated vehicle test bay." };
    setCarView("chase");
    world.command({ type: "vehicle-test", operation: "reset" });
    view.sync(1);
    paused = false;
    cutaway = false;
    updateUI();
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
  cancelReplayLoad();
  if (next !== "lab" && labPpoWorker) stopLabPpo("Update stopped. Completed checkpoints are retained.");
  const nextWorld = worlds[next] ?? new World(world.config, next);
  const graphicsChanged = hasMetroGraphics(world) !== hasMetroGraphics(nextWorld);
  const sceneTransition = next !== environment;
  if (sceneTransition) {
    rememberPackPractice(world);
    scenePauses.set(world, paused);
  }
  setCarView("chase");
  phone?.reset();
  environment = next;
  world = worlds[next] = nextWorld;
  graphics.show(hasMetroGraphics(world));
  if (graphicsChanged) {
    metroReflections.clear();
    resize();
  }
  senseWorld = senseScan = null;
  senseForecasts = [];
  if (next !== "metro") cityPerception?.show(false);
  $("driveSenseBtn").hidden = next !== "metro";
  document.body.toggleAttribute("data-city-focus", next === "metro");
  if (isCity(next)) cityResumeEnvironment = next;
  if (sceneTransition) paused = scenePauses.get(nextWorld) ?? false;
  if (visualClient) {
    lastVisionCaptureTick = -999;
    world.command({ type: "visual-reset", streamId: visualClient.reset() });
    if (visualClient.enabled) perceptionOverlay.setExternal(null);
  }
  if (world.policy !== (useLearnedPolicy ? learnedPolicy : null))
    world.command({
      type: "policy",
      weights: useLearnedPolicy ? learnedPolicy : null,
    });
  if (!views.has(world)) {
    const createdView = new WorldView(world);
    views.set(world, createdView);
    prewarmSceneShaders(createdView.scene, createdView);
  }
  view = views.get(world);
  if (isIntegratedApu && view.sun?.shadow) {
    view.sun.shadow.mapSize.set(512, 512);
  }
  view.scene.matrixWorldAutoUpdate = false;
  if (isIntegratedApu && next === "metro" && view.sun?.shadow?.mapSize?.x > 1024) {
    view.sun.shadow.map?.dispose?.();
    view.sun.shadow.map = null;
    view.sun.shadow.mapSize.set(1024, 1024);
  }
  clock = new FixedClock();
  cameraSnap = true;
  keys.clear();
  lastInput = "";
  $("environmentLabel").textContent =
    next === "pursuit" ? (world.pursuit.packLab ? "Pursuit lab" : "Pursuit replay") : next === "egypt" ? "Egyptian district replay" :
      isCity(next) ? "City" : next === "vehicle" ? "Vehicle test bay" :
      next === "vision" ? "Visual prediction lab" : "Training lab";
  const labButton = $("labBtn");
  labButton.textContent = isCity(next) ? "Lab" : "Return to city";
  if (isCity(next)) $("cityToolItems").insertBefore(labButton, $("inspectorBtn"));
  else $("cityTools").before(labButton);
  $("mapLabel").textContent = isCity(next) ? "City" : next === "vehicle" ? "Vehicle bay" : "Lab";
  $("streetPursuitBtn").hidden = next !== "metro" && next !== "lab" && !world.pursuit?.packLab;
  $("selfDrivingBtn").hidden = $("pakoBtn").hidden = $("cairoChaosBtn").hidden = next !== "metro";
  $("streetPursuitBtn").textContent = next === "lab" ? "Pursuit drills"
    : world.pursuit?.packLab ? "Back to Lab" : "Experiments";
  updatePursuitNavigation();
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
        ? (world.config.cityVersion >= 5
            ? GRAND_CITY_POPULATION_LIMITS
            : world.config.cityVersion === 4
              ? RUSH_CITY_POPULATION_LIMITS
              : METRO_POPULATION_LIMITS)[name]
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
  lastTime = null;
}
function reset(options) {
  rememberPackPractice(world);
  const preservedVehicle = environment === "metro"
    ? (world.player.vehicleModel ?? JETOUR_T2_ID)
    : null;
  const replacement = new World(environment === "metro"
    ? { cityVersion: world.config.cityVersion, ...options } : options, environment);
  if (environment === "metro" && preservedVehicle === KING_LONG_MICROBUS_ID) {
    replacement.command({ type: "player-vehicle", model: KING_LONG_MICROBUS_ID });
  }
  if (replacement.pursuit?.packLab) packDrillWorld = replacement;
  view.dispose();
  views.delete(world);
  worlds[environment] = replacement;
  activate(environment);
}
const compiledSkinnedUrls = new Set();

function prewarmPrototypesOnly(scene, activeView) {
  if (!scene || !activeView?.metroSkinnedPrototypes?.size) return;
  const tempPooled = [];
  const tempGroup = new THREE.Group();
  activeView.metroSkinnedCompiled ??= new Set();
  for (const [url, sample] of activeView.metroSkinnedPrototypes.entries()) {
    if (activeView.metroSkinnedCompiled.has(url)) continue;
    if (sample && !sample.parent) {
      tempGroup.add(sample);
      tempPooled.push(sample);
      activeView.metroSkinnedCompiled.add(url);
    }
  }
  if (!tempPooled.length) return;
  const savedChildren = [];
  for (const ch of scene.children) {
    if (!ch.isLight && ch.name !== "pursuit-layer" && ch.visible) {
      savedChildren.push(ch);
      ch.visible = false;
    }
  }
  const apuHidden = [];
  if (isIntegratedApu) {
    for (const nm of [
      "pursuit-bounce-red",
      "pursuit-bounce-blue",
      "player-street-key-light",
      "player-sculpt-fill-light",
    ]) {
      const l = scene.getObjectByName(nm);
      if (l) {
        apuHidden.push([l, l.visible]);
        l.visible = false;
      }
    }
  }
  scene.add(tempGroup);
  const prevTarget = renderer.getRenderTarget?.() ?? null;
  try {
    tempGroup.updateMatrixWorld(true);
    if (cinematicPost?.target) renderer.setRenderTarget(cinematicPost.target);
    renderer.compile(scene, camera);
  } catch {
    // ignore headless/mock renderer fallback
  } finally {
    renderer.setRenderTarget?.(prevTarget);
    for (let i = tempPooled.length - 1; i >= 0; i--) {
      tempPooled[i].removeFromParent();
    }
    tempGroup.removeFromParent();
    for (let i = apuHidden.length - 1; i >= 0; i--) {
      apuHidden[i][0].visible = apuHidden[i][1];
    }
    for (let i = 0; i < savedChildren.length; i++) {
      savedChildren[i].visible = true;
    }
  }
}
function prewarmSceneShaders(scene, activeView) {
  if (!scene || !activeView) return;
  const saved = [];
  const tempAdded = [];
  const tempPooled = [];
  let cleanupPursuitPrewarm = null;
  let tempTrafficSample = null;
  const forceVisible = (obj) => {
    if (!obj) return;
    let cur = obj;
    while (cur && cur !== scene) {
      saved.push([cur, cur.visible, cur.count]);
      cur.visible = true;
      cur = cur.parent;
    }
    if (obj.isInstancedMesh && obj.count === 0) {
      obj.count = 1;
    }
  };
  const crashLayer = activeView.crashEffects?.layer;
  if (crashLayer) {
    crashLayer.traverse((child) => {
      if (child.isMesh || child.isLine) forceVisible(child);
    });
  }
  const surfFx = activeView.streetSurfaces?.fxGroup;
  if (surfFx) {
    surfFx.traverse((child) => {
      if (child.isMesh || child.isLine) forceVisible(child);
    });
  }
  let forecastGroup = scene.getObjectByName("pedestrian-forecast");
  if (!forecastGroup && typeof pedestrianForecastView === "object" && pedestrianForecastView?.group) {
    forecastGroup = pedestrianForecastView.group;
    if (!forecastGroup.parent) {
      scene.add(forecastGroup);
      tempAdded.push(forecastGroup);
    }
  }
  if (forecastGroup) {
    forecastGroup.traverse((child) => {
      if (child.isMesh || child.isInstancedMesh) forceVisible(child);
    });
  }
  const rigRoot = activeView.playerRig?.root;
  if (rigRoot) {
    forceVisible(rigRoot.getObjectByName("suv-windshield-cracks"));
    forceVisible(rigRoot.getObjectByName("suv-rear-window-cracks"));
    forceVisible(rigRoot.nitroFlames ?? rigRoot.getObjectByName("player-nitro-flames"));
    const sensorRays = rigRoot.getObjectByName("vehicle-sensor-rays");
    if (sensorRays) {
      sensorRays.traverse((child) => {
        if (child.isMesh || child.isLine) forceVisible(child);
      });
    }
  }
  forceVisible(scene.getObjectByName("pursuit-lightbar-halos"));
  const tempGroup = new THREE.Group();
  scene.add(tempGroup);
  tempAdded.push(tempGroup);
  if (activeView.pursuitView?.prewarmMaterials) {
    cleanupPursuitPrewarm = activeView.pursuitView.prewarmMaterials(tempGroup, activeView.metroModels);
  }
  if (activeView.metroModels?.acquire) {
    try {
      tempTrafficSample = activeView.metroModels.acquire({
        kind: "sedan",
        phase: 0,
        width: 1.9,
        length: 4.5,
        height: 1.47,
      });
      if (tempTrafficSample?.visual) tempGroup.add(tempTrafficSample.visual);
    } catch {
      tempTrafficSample = null;
    }
  }
  if (activeView.metroSkinnedPrototypes) {
    activeView.metroSkinnedCompiled ??= new Set();
    for (const [url, sample] of activeView.metroSkinnedPrototypes.entries()) {
      if (sample && !sample.parent) {
        tempGroup.add(sample);
        tempPooled.push(sample);
        activeView.metroSkinnedCompiled.add(url);
      }
    }
  }
  const apuHidden = [];
  if (isIntegratedApu) {
    for (const nm of [
      "pursuit-bounce-red",
      "pursuit-bounce-blue",
      "player-street-key-light",
      "player-sculpt-fill-light",
    ]) {
      const l = scene.getObjectByName(nm);
      if (l) {
        apuHidden.push([l, l.visible]);
        l.visible = false;
      }
    }
  }
  const prevTarget = renderer.getRenderTarget?.() ?? null;
  try {
    tempGroup.updateMatrixWorld(true);
    if (cinematicPost?.target) renderer.setRenderTarget(cinematicPost.target);
    renderer.compile(scene, camera);
  } catch {
    // ignore headless/mock renderer fallback
  } finally {
    renderer.setRenderTarget?.(prevTarget);
    for (let i = tempPooled.length - 1; i >= 0; i--) {
      tempPooled[i].removeFromParent();
    }
    if (tempTrafficSample?.visual) {
      tempTrafficSample.visual.removeFromParent();
      activeView.metroModels?.release?.(tempTrafficSample.entry);
    }
    cleanupPursuitPrewarm?.();
    for (let i = tempAdded.length - 1; i >= 0; i--) {
      tempAdded[i].removeFromParent();
    }
    for (let i = apuHidden.length - 1; i >= 0; i--) {
      apuHidden[i][0].visible = apuHidden[i][1];
    }
    for (let i = saved.length - 1; i >= 0; i--) {
      const [node, vis, cnt] = saved[i];
      node.visible = vis;
      if (cnt !== undefined) node.count = cnt;
    }
  }
}
const graphics = mountGraphicsSettings(document, {
  lowPower: isIntegratedApu,
  supportsLiveReflections,
  onChange(next, current) {
    if (hasMetroGraphics(world) && next.renderScale !== current.renderScale) resize();
  },
});
function resize() {
  const bounds = renderer.domElement.getBoundingClientRect();
  viewportWidth = Math.round(bounds.width);
  viewportHeight = Math.round(bounds.height);
  const nativeRatio = Math.min(
    Math.round(devicePixelRatio * 1000) / 1000,
    isIntegratedApu ? 1.0 : 1.5,
  );
  const width = Math.max(1, viewportWidth), height = Math.max(1, viewportHeight);
  const pixelRatio = hasMetroGraphics(world)
    ? Math.min(nativeRatio * graphics.value.renderScale / 100, 2,
      maxDisplayEdge / Math.max(width, height), maxViewport[0] / width, maxViewport[1] / height,
      Math.sqrt(MAX_METRO_DISPLAY_PIXELS / (width * height)))
    : nativeRatio;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(viewportWidth, viewportHeight, false);
  cinematicPost.setSize(viewportWidth, viewportHeight, pixelRatio);
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
function currentCairoChaosState() {
  return environment === "metro" && world?.streetChaos ? streetChaosSnapshot(world) : null;
}
function stopCairoChaos() {
  if (environment !== "metro" || !world.streetChaos?.active) return currentCairoChaosState();
  world.command({ type: "street-chaos-stop" });
  lastInput = "";
  updateUI();
  return currentCairoChaosState();
}
function setCairoChaosDriver(driverMode) {
  if (environment !== "metro" || !world.streetChaos?.active) return currentCairoChaosState();
  world.command({ type: "street-chaos-driver", driverMode: driverMode === "manual" ? "manual" : "auto" });
  lastInput = "";
  updateUI();
  return currentCairoChaosState();
}
function startCairoChaos(options = {}) {
  if (environment !== "metro") activate("metro");
  endCityPursuit();
  streetPursuitOpen = pakoPanelOpen = false;
  updatePursuitNavigation();
  $("pursuitPanelHost").hidden = true;
  settingsOpen(false);
  vehiclePanel?.close();
  const intensity = ["normal", "rush", "max"].includes(options.intensity)
    ? options.intensity : $("chaosIntensitySelect").value;
  const driverMode = options.driverMode === "manual" ? "manual" : "auto";
  $("chaosIntensitySelect").value = intensity;
  if (world.streetChaos?.active) world.command({ type: "street-chaos-stop" });
  world.command({ type: "street-chaos-start", intensity, driverMode });
  paused = false;
  lastInput = "";
  updateUI();
  return currentCairoChaosState();
}
function triggerCairoChaosEvent(kind) {
  if (environment !== "metro" || !world.streetChaos?.active || !["ghorz", "lane-change", "accident"].includes(kind)) return false;
  const result = world.command({ type: "street-chaos-event", kind });
  updateUI();
  return result ?? true;
}
function autoToggle() {
  if (environment === "vehicle" || environment === "vision") return;
  if (isPursuing() && world.pursuit.frozenDriver) {
    takeDispatchControl();
    return;
  }
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
  toolbar: $("cityToolItems"),
  onAction: carAction,
});
visionPanel = mountVisionPanel({
  toolbar: $("cityToolItems"),
  onAction: visionAction,
});
cameraScreen = mountCameraScreen({
  navigation: $("cityToolItems"),
  onAction: cameraAction,
  onVisibilityChange: (visible) => {
    cameraScreenVisible = visible;
    visualClient?.setPreviewEnabled(visible || cityPerception?.open);
    if (visible) {
      cityPerception?.show(false);
      peoplePanel?.close();
      vehiclePanel.close();
      visionPanel.close();
      settingsOpen(false);
    }
  },
});
peoplePanel = mountPeoplePanel({
  navigation: $("cityToolItems"),
  onAction: peopleAction,
});
cityPerception = mountCityPerception($, {
  onVisibility: visible => {
    document.body.toggleAttribute("data-city-sense", visible);
    visualClient?.setPreviewEnabled(visible || cameraScreenVisible);
    if (!visible) {
      senseWorld = senseScan = null;
      senseForecasts = [];
      pedestrianForecastView.update([]);
    } else {
      settingsOpen(false);
      $("inspectorPanel").hidden = true;
      $("inspectorBtn").setAttribute("aria-expanded", "false");
    }
    updatePreview();
  },
  onDetector: () => cameraAction(visualClient.enabled ? "stop" : "start"),
});
cairoChaosHud = mountStreetChaosHud({
  button: $("cairoChaosBtn"), bar: $("chaosBar"), intensity: $("chaosIntensitySelect"),
  driver: $("chaosDriverBtn"), hazard: $("chaosHazardStatus"), reaction: $("chaosReactionStatus"),
  stats: $("chaosStatsText"), notice: $("chaosNotice"), ghorz: $("chaosTriggerGhorzBtn"), lane: $("chaosTriggerLaneBtn"),
  accident: $("chaosTriggerAccidentBtn"), stop: $("stopChaosBtn"),
}, {
  onIntensity: intensity => {
    const state = currentCairoChaosState();
    if (state?.active) startCairoChaos({ intensity, driverMode: state.driverMode });
  },
  onDriverMode: setCairoChaosDriver,
  onEvent: triggerCairoChaosEvent,
  onStop: stopCairoChaos,
});
let touchNitroActive = false;
function spawnChaseCrowdAhead(count = 20) {
  if (environment !== "metro") return null;
  world.command({ type: "spawn-crowd-ahead", count, layout: "dispersed-cohorts-v1" });
  updateUI();
  return world.lastCrowdSpawn ?? null;
}
for (const [id, control] of [["pursuitTouchLeft", "ArrowLeft"], ["pursuitTouchRight", "ArrowRight"],
  ["pursuitTouchBrake", "Space"], ["pursuitTouchThrottle", "KeyW"], ["pursuitTouchReverse", "KeyS"]]) {
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
  if (id) $("cityTools").open = false;
  if (id && id !== "cameraScreenToggleBtn") cameraScreen.close();
  if (id && id !== "peopleToggleBtn") peoplePanel.close();
  if (id && $("cityToolItems").contains(event.target)) cityPerception.show(false);
});
document.addEventListener("click", event => {
  if (!$("cityTools").contains(event.target)) $("cityTools").open = false;
});
const isEditing = (target) =>
  ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
addEventListener("keydown", (event) => {
  const inSettings = event.target.closest?.("#settingsPanel:not([hidden]):not([data-pako-workspace])");
  const openTools = event.target.closest?.("#cityTools[open]");
  if (event.code === "Escape") {
    if (inSettings) {
      closeSettingsFromDrawer();
      return;
    }
    if (openTools) {
      openTools.open = false;
      openTools.querySelector("summary").focus();
      return;
    }
    settingsOpen(false);
    $("inspectorPanel").hidden = true;
    $("inspectorBtn").setAttribute("aria-expanded", "false");
  }
  if (inSettings || openTools || isEditing(event.target)) return;
  if (event.code === "Space" && event.target.closest?.("button, summary, a[href]")) return;
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
    if (cameraMode === "cockpit") setChaseCameraStyle("chasing");
    else if (cameraMode === "chase" && chaseCameraStyle === "chasing")
      setChaseCameraStyle("follow");
    else setCarView("cockpit");
  }
  if (event.code === "KeyV") {
    setChaseCameraStyle(chaseCameraStyle === "chasing" ? "follow" : "chasing");
  }
  const chaosManualKeys = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight", "Space"];
  if (world.streetChaos?.active && chaosManualKeys.includes(event.code)) setCairoChaosDriver("manual");
  if (event.code === "KeyI") {
    if (world.streetChaos?.active)
      setCairoChaosDriver(world.streetChaos.driverMode === "manual" ? "auto" : "manual");
    else autoToggle();
  }
  if (event.code === "KeyE") usePursuitPower();
  if (event.code === "KeyG" && environment === "metro") {
    if (isPursuing()) pursuitPanel.triggerSpawnCrowdAhead({ count: 20 });
    else spawnChaseCrowdAhead(20);
  }
  if (event.code === "KeyR" && world.pursuit?.survival && !isPursuing() && streetPursuitOpen &&
      streetPursuitStyle === "survival") $("pursuitRunBtn").click();
});
addEventListener("keyup", (event) => keys.delete(event.code));
addEventListener("blur", () => {
  keys.clear();
  touchPursuit.clear();
  touchNitroActive = false;
});
document.addEventListener("visibilitychange", () => {
  keys.clear();
  touchPursuit.clear();
  touchNitroActive = false;
  lastTime = null;
  clock = new FixedClock();
});
let vehicleSwitchNotice = null;
function showVehicleSwitchNotice(text, durationMs = 3500) {
  vehicleSwitchNotice = text ? { text, until: performance.now() + durationMs } : null;
}
if ($("switchCarBtn")) {
  $("switchCarBtn").onclick = () => {
    if (environment !== "metro") activate("metro");
    if (world.pursuit?.phase === "running" || world.pursuit?.reviewUntilTick) {
      showVehicleSwitchNotice("End Chase before switching vehicle.");
      updateUI();
      return;
    }
    const isMicrobus = world.player.vehicleModel === KING_LONG_MICROBUS_ID;
    const nextModel = isMicrobus ? JETOUR_T2_ID : KING_LONG_MICROBUS_ID;
    if (Math.abs(world.player.speed) < 0.05 &&
        (world.player.path.length > 0 || world.destination || world.input.targetSpeed !== 0)) {
      world.command({ type: "stop" });
    }
    const result = carAction("player-vehicle", nextModel);
    if (result?.ok && result?.changed) {
      showVehicleSwitchNotice(nextModel === KING_LONG_MICROBUS_ID
        ? "Switched to King Long · Microbus"
        : "Switched to Jetour T2 · SUV");
      updateUI();
    } else if (result?.ok === false) {
      showVehicleSwitchNotice(result.error || "Stop the car first to switch vehicle.");
      updateUI();
    }
  };
}
$("aiToggleBtn").onclick = autoToggle;
$("labBtn").onclick = () => activate(isCity(environment) ? "lab" : cityResumeEnvironment);
function updatePursuitNavigation() {
  $("pakoBtn").setAttribute("aria-expanded", String(environment === "metro" && streetPursuitOpen && pakoPanelOpen));
  $("streetPursuitBtn").setAttribute("aria-expanded", String(environment === "metro" && streetPursuitOpen && !pakoPanelOpen));
}
$("pakoBtn").onclick = () => {
  if (environment !== "metro") return;
  stopCairoChaos();
  streetPursuitOpen = !streetPursuitOpen || !pakoPanelOpen;
  pakoPanelOpen = true;
  updatePursuitNavigation();
  settingsOpen(false);
  if (streetPursuitOpen) vehiclePanel?.close();
  updateUI();
  if (streetPursuitOpen) $("pursuitLevel").focus();
};
$("selfDrivingBtn").onclick = () => {
  if (environment !== "metro" || world.player.curbSupportId) return;
  stopCairoChaos();
  endCityPursuit();
  cancelReplayLoad();
  streetPursuitOpen = pakoPanelOpen = false;
  updatePursuitNavigation();
  if (world.mode !== "auto") autoToggle();
  updateUI();
};
$("cairoChaosBtn").onclick = () => {
  if (environment !== "metro") return;
  if (world.streetChaos?.active) stopCairoChaos();
  else startCairoChaos({
    intensity: $("chaosIntensitySelect").value,
    driverMode: "auto",
  });
};
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
  streetPursuitOpen = !streetPursuitOpen || pakoPanelOpen;
  pakoPanelOpen = false;
  if (!isGtaStyle(streetPursuitStyle)) streetPursuitLevel = Math.min(4, streetPursuitLevel);
  updatePursuitNavigation();
  settingsOpen(false);
  updateUI();
};
if ($("chaseCamBtn")) {
  $("chaseCamBtn").onclick = () =>
    setChaseCameraStyle(chaseCameraStyle === "chasing" ? "follow" : "chasing");
  $("chaseCamBtn").setAttribute("aria-pressed", "false");
}
$("cameraBtn").onclick = () => {
  const run = activeCinematic();
  if (run) pursuitPreview = { run, show: !previewVisible(run) };
  else showCamera = !showCamera;
  updatePreview();
};
$("pauseBtn").onclick = () => {
  const canceledImport = cancelReplayLoad();
  if (isInspection()) {
    setCarView("chase");
    paused = false;
  } else paused = canceledImport ? false : !paused;
  if (paused && world.pursuit?.phase === "running" && world.pursuit.trace) {
    const run = world.pursuit;
    flushDecisionTrace(world, run);
    run.trace.append(finishPursuitDecision(world, startPursuitDecision(world,
      { ...currentPursuitDecision(run), paused: true })));
  }
  keys.clear();
  touchPursuit.clear();
  $("pauseBtn").textContent = paused ? "Resume" : "Pause";
};
function settingsOpen(open, pako = false) {
  const panel = $("settingsPanel");
  panel.hidden = !open;
  panel.toggleAttribute("data-pako-workspace", open && pako);
  panel.setAttribute("aria-label", pako ? "PAKO Lab" : "Simulation settings");
  $("settingsTitle").textContent = pako ? "PAKO Lab" : "Simulation settings";
  if (open) {
    $("metroPpoLegacyUpdate").open = !pako;
    $("pakoLabSetup").open = !pako;
  }
  $("settingsBtn").setAttribute("aria-expanded", String(open));
  if (open) {
    $("inGamePhone").hidden = true;
    $("phoneToggleBtn").setAttribute("aria-expanded", "false");
    $("inspectorPanel").hidden = true;
    $("inspectorBtn").setAttribute("aria-expanded", "false");
    if (!pako) {
      keys.clear();
      touchPursuit.clear();
      const section = $("graphicsSettings");
      (section.hidden ? $("closeSettings") : section.querySelector("summary")).focus();
    }
  }
}
function closeSettingsFromDrawer() {
  const pako = $("settingsPanel").hasAttribute("data-pako-workspace");
  settingsOpen(false);
  if (!pako) $("cityTools").querySelector("summary").focus();
}
$("settingsBtn").onclick = () => settingsOpen($("settingsPanel").hidden);
$("closeSettings").onclick = closeSettingsFromDrawer;
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
const PAKO_RECORD_KEY = "ya-rab-ostorha:pako-survival-best-v1";
const pursuitAudio = new PursuitAudio();
let heardRun = null, heardEvent = 0, scoredRun = null, bestSurvivalS = null, pakoBestS = null;
try {
  const value = localStorage.getItem(CITY_RECORD_KEY);
  if (value !== null && Number.isFinite(Number(value)) && Number(value) >= 0) bestSurvivalS = Number(value);
  const pakoBest = localStorage.getItem(PAKO_RECORD_KEY);
  if (pakoBest !== null && Number.isFinite(Number(pakoBest)) && Number(pakoBest) >= 0) pakoBestS = Number(pakoBest);
} catch (error) {
  if (!(error instanceof DOMException)) throw error;
  console.warn("City pursuit records are available in this tab only.", error);
}

function usePursuitPower() {
  if (!paused && world.pursuit?.survival) world.command({ type: "pursuit-use" });
}

function updateSurvivalFeedback() {
  const run = world.pursuit;
  const active = (run?.survival || run?.cityChase) && (run.phase === "running" || run.reviewUntilTick);
  if (heardRun !== run) {
    heardRun = run;
    heardEvent = 0;
  }
  const audible = Boolean(active && !paused && !document.hidden);
  pursuitAudio.update(world, audible);
  if (active && run?.survival) for (const event of run.survival.effects) {
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

function takeDispatchControl() {
  const driver = world.pursuit?.frozenDriver;
  if (!driver || driver.status === "manual") return;
  driver.status = "manual";
  driver.policy = null;
  world.command({ type: "pursuit-drive", action: PURSUIT_STOP });
  lastInput = "";
  updateUI();
}

let cityTraceSequence = 0;
function currentPursuitDecision(run) {
  const driver = run.frozenDriver;
  if (driver && driver.status !== "manual") return driver.lastDecision;
  return { source: "manual", status: "manual", requested: run.manualAction, submitted: run.manualAction };
}

function flushDecisionTrace(target, run) {
  if (!run.pendingTrace) return;
  run.trace.append(finishPursuitDecision(target, run.pendingTrace));
  run.pendingTrace = null;
}

function stepWorld() {
  const run = world.pursuit;
  const capture = run?.phase === "running" && run.trace;
  if (run?.phase === "running") {
    if (capture && run.pendingTrace && run.traceAction !== run.manualAction) flushDecisionTrace(world, run);
    const cameraStream = run.cityChase && !run.pako && visualClient.enabled && visualClient.status.status === "ready"
      ? visualClient.streamId : null;
    const faulted = applyFrozenDispatchAction(world, run.frozenDriver, cameraStream);
    if (capture && run.pendingTrace && run.traceAction !== run.manualAction) flushDecisionTrace(world, run);
    if (capture && !run.pendingTrace) {
      run.traceAction = run.manualAction;
      run.pendingTrace = startPursuitDecision(world, currentPursuitDecision(run));
    }
    if (faulted) updateUI();
  }
  world.step();
  const pursuitScan = world.pursuit?.phase === "running" && world.pursuit.gta?.scan;
  if (!pursuitScan && cityPerception.open && environment === "metro" && world.tick % PURSUIT_SCAN_TICKS === 0) {
    senseWorld = world;
    senseScan = senseScanner.sample(world);
  }
  if (run?.pako && !run.pakoScored && ["escaped", "busted", "wrecked", "timeout"].includes(run.phase)) {
    run.pakoScored = true;
    if (run.response.dispatch.escapeEligible && run.frozenDriver?.status !== "fault" &&
        run.metrics.survivalS > (pakoBestS ?? 0)) {
      pakoBestS = run.metrics.survivalS;
      try { localStorage.setItem(PAKO_RECORD_KEY, String(pakoBestS)); }
      catch (error) {
        if (!(error instanceof DOMException)) throw error;
        console.warn("PAKO best time is retained in this tab only.", error);
      }
    }
  }
  if (capture) {
    observePursuitDecision(world, run.pendingTrace);
    if (run.phase !== "running" || world.tick - run.pendingTrace.tick >= PURSUIT_SCAN_TICKS)
      flushDecisionTrace(world, run);
  }
  if (capture && run.cityChase && run.phase !== "running") updateUI();
}

function approvedPakoPolicy() {
  return dispatchCheckpoint && pakoReleasePolicies.verified.find(entry =>
    entry.sha256 === dispatchCheckpoint.sha256 && entry.observation === dispatchCheckpoint.policy.observation);
}

async function loadDispatchCheckpoint(file, source = file?.name, isCustom = true) {
  dispatchCheckpoint = null;
  checkpointStatus = file ? "Checking checkpoint…" : "";
  updateUI();
  if (!file) return false;
  try {
    if (file.size < 1 || file.size > 2_000_000) throw new RangeError("Choose a Metro PPO JSON file under 2 MB.");
    const bytes = await file.arrayBuffer();
    const policy = freezePursuitPolicy(JSON.parse(new TextDecoder().decode(bytes)));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = [...digest].map(n => n.toString(16).padStart(2, "0")).join("");
    dispatchCheckpoint = { policy, sha256 };
    customCheckpoint = Boolean(isCustom);
    pakoDriverMode = "rl";
    const mapCues = policy.observation === CLEARANCE_ROUTE_CONTEXT ? " · Extended map cues" :
      policy.observation === LEGACY_ROUTE_CONTEXT ? " · Static map cues" : "";
    checkpointStatus = `${source} · ${policy.updates} updates${mapCues} · SHA-256 ${sha256.slice(0, 12)}`;
  } catch (error) {
    checkpointStatus = `Checkpoint rejected: ${error.message}`;
  }
  updateUI();
  return dispatchCheckpoint !== null;
}

async function loadDefaultChasePolicy() {
  try {
    const response = await fetch("/public/threejs/pako-chase-ppo.json");
    if (!response.ok) return;
    const bytes = await response.arrayBuffer();
    const raw = JSON.parse(new TextDecoder().decode(bytes));
    const policy = freezePursuitPolicy(raw);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = [...digest].map(n => n.toString(16).padStart(2, "0")).join("");
    if (!dispatchCheckpoint) {
      dispatchCheckpoint = { policy, sha256 };
      customCheckpoint = false;
      pakoDriverMode = "rl";
      checkpointStatus = `Built-in RL PPO · ${formatPpoSummary(policy)} · SHA-256 ${sha256.slice(0, 12)}`;
    }
    if (!labPpoCheckpoints.has(raw.observation)) labPpoCheckpoints.set(raw.observation, raw);
  } catch (error) {
    console.warn("Default Chase PPO policy could not be preloaded:", error);
  } finally {
    defaultChaseReady = true;
    updateUI();
  }
}

function stopLabPpo(message) {
  labPpoWorker?.terminate();
  labPpoWorker = null;
  if (labSession && ["running", "paused", "starting"].includes(labSession.status)) {
    labSession.status = "stopped";
    updateLabSession(message);
  }
  showLabPpoCheckpoint(message);
}

function selectedLabPpoStage() {
  const id = $("metroPpoStage").value;
  for (const manifest of [labCurriculum, labRouteCurriculum, labClearanceCurriculum, labChaseCurriculum]) {
    const stage = manifest.stages.find(row => row.id === id);
    if (stage) return { manifest, stage, observation: stage.observation ?? "dispatch-scan-v3" };
  }
  throw new RangeError("Choose a Metro training workload.");
}

function renderLabDownload(checkpoint) {
  const download = $("metroPpoDownload");
  if (download.hasAttribute("href")) {
    URL.revokeObjectURL(download.href);
    download.removeAttribute("href");
  }
  download.hidden = !checkpoint;
  if (checkpoint)
    download.href = URL.createObjectURL(new Blob([JSON.stringify(checkpoint) + "\n"], { type: "application/json" }));
}

function showLabPpoCheckpoint(message) {
  const { stage, observation } = selectedLabPpoStage();
  const checkpoint = labPpoCheckpoints.get(observation);
  $("pakoWorkloadNote").textContent = stage.traffic >= 36 && !stage.scenario
    ? `City chase · Level ${stage.wantedLevel} · ${stage.traffic} vehicles and ${stage.pedestrians} people. Up to ${stage.episodeSeconds} s per chase.`
    : "Development drill. It does not establish escape performance in the City.";
  $("metroPpoTrain").disabled = false;
  $("metroPpoTrain").textContent = checkpoint ? "Train another update" : "Train one update";
  $("metroPpoStop").disabled = true;
  $("metroPpoStage").disabled = $("metroPpoResume").disabled = false;
  $("metroPpoUse").disabled = !checkpoint;
  renderLabDownload(checkpoint);
  $("metroPpoStatus").textContent = message ?? (checkpoint
    ? `PPO update ${checkpoint.updates} · ${checkpoint.transitions} transitions total.`
    : "No checkpoint for this workload. Start one update to collect real Metro transitions.");
  updateLabSession();
}

function labSessionCheckpoint() {
  const { observation, stage } = selectedLabPpoStage();
  const checkpoint = labPpoCheckpoints.get(observation);
  return checkpoint?.development?.stage === stage.id ? checkpoint : null;
}

function updateLabSession(message) {
  const busy = labPpoWorker !== null, session = labSession;
  $("pakoTrain").disabled = busy;
  $("pakoEvaluate").disabled = busy || $("metroPpoResume").disabled || !labSessionCheckpoint();
  $("pakoPause").disabled = !busy || !["running", "paused"].includes(session?.status);
  $("pakoPause").textContent = session?.status === "paused" ? "Resume session" : "Pause session";
  $("pakoStop").disabled = !busy || !["running", "paused", "starting"].includes(session?.status);
  for (const id of ["pakoEpisodeLimit", "pakoTimeLimit", "pakoTrainingSpeed", "pakoWorldCount"]) $(id).disabled = busy;
  if (session) {
    const task = session.mode === "evaluate" ? "Testing" : "Training";
    const outcome = session.lastEpisode;
    const counts = `${session.episodes ?? 0} episodes · ${session.updates ?? 0} PPO updates · ${session.transitions ?? 0} transitions`;
    const active = session.activeEpisode;
    const text = message ?? `${task} ${session.status} · ${counts}${
      active ? ` · Episode ${active.index}: ${Math.floor(active.ticks / 60)} s` : ""}${
      session.worlds > 1 ? ` · ${session.activeWorlds ?? 0}/${session.worlds} simulation worlds · One worker` : ""}${
      outcome ? ` · Last: ${outcome.phase}, ${outcome.collisions} contacts` : ""}${session.error ? ` · ${session.error}` : ""}`;
    if ($("pakoSessionStatus").textContent !== text) $("pakoSessionStatus").textContent = text;
  }
  const summary = $("pakoEpisodeOutcomes");
  const outcomes = session?.outcomes;
  $("pakoWatchLast").hidden = !session?.lastEpisode;
  summary.hidden = !outcomes || !session.episodes;
  if (!summary.hidden)
    summary.textContent = `${outcomes.cleanEscapes}/${session.episodes} clean escapes · ${outcomes.captured} captured · ` +
      `${outcomes.crashed} crashed · ${outcomes.timeout} timed out · ${outcomes.escapedWithContact} escaped with contact. ` +
      `${outcomes.contacts} ego contacts · ${outcomes.pedestrianContacts} ego / ${outcomes.ambientPedestrianContacts} ambient pedestrian contacts.`;
}

function startLabSession(mode) {
  if (environment !== "lab" || labPpoWorker || $("metroPpoResume").disabled) return;
  const episodeLimit = $("pakoEpisodeLimit"), timeLimit = $("pakoTimeLimit");
  if (!episodeLimit.reportValidity() || !timeLimit.reportValidity()) return;
  const checkpoint = labSessionCheckpoint();
  if (mode === "evaluate" && !checkpoint) return;
  try {
    const worker = new Worker("/public/threejs/pursuit-lab-worker.bundle.js");
    const sessionId = crypto.randomUUID();
    labPpoWorker = worker;
    labSession = { sessionId, mode, status: "starting" };
    ghostPlayback.clear(mode);
    for (const id of ["metroPpoTrain", "metroPpoUse", "metroPpoStage", "metroPpoResume"]) $(id).disabled = true;
    $("metroPpoStop").disabled = true;
    updateLabSession();
    worker.onmessage = ({ data }) => {
      if (worker !== labPpoWorker || data.type !== "session" || data.sessionId !== sessionId) return;
      try {
        if (mode === "train" && data.checkpoint) {
          freezePursuitPolicy(data.checkpoint);
          labPpoCheckpoints.set(data.checkpoint.observation, data.checkpoint);
          renderLabDownload(data.checkpoint);
        }
        const { checkpoint: discarded, actorRecording, ...status } = data;
        labSession = { ...labSession, ...status, activeEpisode: status.activeEpisode ?? null };
        if (Number.isInteger(data.worlds)) ghostPlayback.setWorldCount(data.worlds);
        if (data.lastEpisode) ghostPlayback.add(data.lastEpisode, data.lastEpisode.index ?? data.episodes, actorRecording);
        if (["completed", "stopped", "fault"].includes(data.status)) stopLabPpo(data.error);
        else updateLabSession();
      } catch (error) {
        labSession = { ...labSession, status: "fault", error: error.message };
        stopLabPpo(`Training checkpoint rejected: ${error.message}`);
      }
    };
    worker.onerror = event => {
      if (worker !== labPpoWorker) return;
      labSession = { ...labSession, status: "fault", error: event.message || "Worker unavailable." };
      stopLabPpo(labSession.error);
    };
    worker.postMessage({ type: "session-start", sessionId, mode, checkpoint, stage: $("metroPpoStage").value,
      maxEpisodes: episodeLimit.valueAsNumber, maxSeconds: timeLimit.valueAsNumber,
      speed: $("pakoTrainingSpeed").value, worlds: Number($("pakoWorldCount").value) });
  } catch (error) {
    labSession = { mode, status: "fault", error: error.message };
    stopLabPpo(error.message);
  }
}

$("pakoTrain").onclick = () => startLabSession("train");
$("pakoEvaluate").onclick = () => startLabSession("evaluate");
$("pakoWatchLast").onclick = () => {
  if (!ghostPlayback.watchLatest()) {
    $("pakoSessionStatus").textContent = "Finish a City episode before starting playback.";
  }
};
$("pakoPause").onclick = () => labPpoWorker?.postMessage({ type: "session-control", sessionId: labSession?.sessionId,
  action: labSession?.status === "paused" ? "resume" : "pause" });
$("pakoStop").onclick = () => labPpoWorker?.postMessage({ type: "session-control", sessionId: labSession?.sessionId, action: "stop" });

function startLabPpo() {
  if (environment !== "lab" || labPpoWorker) return;
  try {
    const worker = new Worker("/public/threejs/pursuit-lab-worker.bundle.js");
    labPpoWorker = worker;
    $("metroPpoTrain").disabled = $("metroPpoUse").disabled = true;
    $("metroPpoStage").disabled = $("metroPpoResume").disabled = true;
    $("metroPpoStop").disabled = false;
    updateLabSession();
    $("metroPpoStatus").textContent = "Collecting Metro transitions and updating PPO…";
    worker.onerror = event => {
      if (worker === labPpoWorker) stopLabPpo(`Metro training failed: ${event.message || "worker unavailable"}.`);
    };
    worker.onmessage = ({ data }) => {
      if (worker !== labPpoWorker) return;
      if (data.error) return stopLabPpo(`Metro training failed: ${data.error}`);
      const { checkpoint, metrics } = data;
      try { freezePursuitPolicy(checkpoint); }
      catch (error) { return stopLabPpo(`Metro training did not yield a compatible checkpoint: ${error.message}`); }
      labPpoCheckpoints.set(checkpoint.observation, checkpoint);
      $("pakoWorldCount").value = "1";
      const outcomes = metrics.episodes?.map(episode => `${episode.phase}, ${episode.collisions} contacts`).join(" / ")
        ?? `${metrics.phase}, ${metrics.collisions} contacts`;
      stopLabPpo(`PPO update ${checkpoint.updates} · ${checkpoint.transitions} transitions total · last: ${outcomes}.`);
    };
    worker.postMessage({ stage: $("metroPpoStage").value, checkpoint: labPpoCheckpoints.get(selectedLabPpoStage().observation) });
  } catch (error) {
    stopLabPpo(`Metro training failed: ${error.message}`);
  }
}

$("metroPpoTrain").onclick = startLabPpo;
$("metroPpoStop").onclick = () => stopLabPpo("Update stopped. Completed checkpoints are retained.");
$("metroPpoStage").onchange = () => showLabPpoCheckpoint();
$("metroPpoResume").onchange = async event => {
  const input = event.currentTarget, file = input.files[0];
  if (!file || environment !== "lab" || labPpoWorker) return;
  const { manifest, observation } = selectedLabPpoStage();
  $("metroPpoTrain").disabled = $("metroPpoUse").disabled = true;
  $("metroPpoStage").disabled = input.disabled = true;
  try {
    if (file.size < 1 || file.size > 2_000_000) throw new RangeError("Choose a Metro PPO JSON file under 2 MB.");
    const checkpoint = JSON.parse(await file.text());
    freezePursuitPolicy(checkpoint);
    new PursuitPpo(null, checkpoint);
    if (checkpoint.observation !== observation)
      throw new Error("Select the workload matching this checkpoint before importing.");
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = [...digest].map(n => n.toString(16).padStart(2, "0")).join("");
    if (checkpoint.development?.curriculumSha256 !== sha256)
      throw new Error("Checkpoint belongs to another curriculum revision.");
    const savedWidth = checkpoint.development.worlds ?? 1;
    if (!Number.isInteger(savedWidth) || savedWidth < 1 || savedWidth > 4)
      throw new Error("Checkpoint has an invalid number of training worlds.");
    labPpoCheckpoints.set(checkpoint.observation, checkpoint);
    $("pakoWorldCount").value = String(savedWidth);
    showLabPpoCheckpoint(`Loaded PPO update ${checkpoint.updates} · ${checkpoint.transitions} transitions total.`);
  } catch (error) {
    showLabPpoCheckpoint(`Resume rejected: ${error.message}`);
  } finally {
    input.value = "";
    updateLabSession();
  }
};
$("metroPpoUse").onclick = async () => {
  const labPpoCheckpoint = labPpoCheckpoints.get(selectedLabPpoStage().observation);
  if (environment !== "lab" || !labPpoCheckpoint) return;
  const file = new File([JSON.stringify(labPpoCheckpoint) + "\n"], "metro-dispatch-ppo.json", { type: "application/json" });
  if (await loadDispatchCheckpoint(file, "Lab checkpoint")) {
    $("pursuitCheckpoint").value = "";
    streetPursuitStyle = "dispatch-ppo";
    if ($("settingsPanel").hasAttribute("data-pako-workspace")) {
      activate(cityResumeEnvironment);
      settingsOpen(false);
      streetPursuitOpen = pakoPanelOpen = true;
      updatePursuitNavigation();
      updateUI();
      $("pursuitLevel").focus();
    } else $("metroPpoStatus").textContent = `Checkpoint selected for City · ${checkpointStatus}. Return to City to start a chase.`;
  } else $("metroPpoStatus").textContent = checkpointStatus;
};

const pursuitStrobe = mountPursuitStrobe({ container: document.body });
const pursuitPanel = mountPursuitPanel({
  container: $("pursuitPanelHost"),
  onCheckpoint: file => loadDispatchCheckpoint(file, file?.name, true),
  onDriverMode: mode => {
    pakoDriverMode = mode === "manual" ? "manual" : "rl";
    updateUI();
  },
  onCameraStyle: style => {
    setChaseCameraStyle(style);
    updateUI();
  },
  onSpawnCrowdAhead: ({ count = 20 } = {}) => spawnChaseCrowdAhead(count),
  onStopChase: () => {
    if (environment === "metro") {
      endCityPursuit();
      updateUI();
    } else if (world.pursuit) reset(world.config);
  },
  onNitro: active => {
    touchNitroActive = Boolean(active);
  },
  onEvasion: enabled => { useEvasionPreview = enabled; },
  onCurbSupport: enabled => { useSurveyedCurb = enabled; },
  onRun: async (learn, useLabPolicy) => {
    const active = world;
    if (active.environment === "metro") {
      stopCairoChaos();
      const simple = pakoPanelOpen;
      const microbus = active.player.vehicleModel === KING_LONG_MICROBUS_ID;
      if (microbus && !simple) throw new Error("Use Chase for the microbus. Experimental pursuit modes require the SUV.");
      const simpleRl = simple && pakoDriverMode !== "manual" && Boolean(dispatchCheckpoint);
      const release = simpleRl ? approvedPakoPolicy() : null;
      const style = simple ? release ? "pako" : simpleRl ? "dispatch-ppo" : "dispatch" : streetPursuitStyle;
      rememberPackPractice(active);
      const rushCity = (active.config.cityVersion ?? 0) >= 4;
      const pako = rushCity && style === "pako";
      const arcade = rushCity && style === "survival";
      const gta = rushCity && isGtaStyle(style);
      const frozen = rushCity && (style === "dispatch-ppo" || pako);
      if (frozen && !dispatchCheckpoint) throw new Error("Load a compatible Metro PPO checkpoint to start.");
      if (!arcade && !gta && useLabPolicy && !labPackCheckpoint) throw new Error("Complete a learning run in the Lab first.");
      const checkpoint = arcade || gta ? null : useLabPolicy ? labPackCheckpoint : readCityPractice();
      active.command({ type: "street-pursuit-start", level: streetPursuitLevel,
        ...(gta ? { variant: "gta", ...(isDispatchStyle(style)
          ? { config: { ruleset: "dispatch-v1", damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
            ...(simple ? {
              wantedLevelMax: 5,
              maxActivePatrols: 14,
              curbSupport: METRO_CITY_CURBS,
              chasePresence: AGGRESSIVE_CHASE_PRESENCE,
              tacticalPursuit: TACTICAL_PURSUIT_MODE,
              policeFairness: "city-fair-v1",
              ...(active.config.cityVersion >= 5 && streetPursuitLevel >= 4 ? {
                cityPackPressure: CITY_PACK_PRESSURE,
                ...(release ? { routeMemory: OBSERVED_CORRIDOR_MEMORY } : {}),
              } : {}),
              patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
              patrolChainYield: PATROL_LATERAL_YIELD,
            } : {}),
            ...(!simple && style === "dispatch" && useSurveyedCurb ? { curbSupport: METRO_CURB_SUPPORT } : {}) } } : {}) }
          : arcade ? { variant: "survival", config: { giantPhysics: SURVIVAL_GIANT_PHYSICS } }
            : rushCity ? { variant: "hunt", learn: !useLabPolicy && learn,
          ...(checkpoint ? { checkpoint, ...(!useLabPolicy ? { localPolicy: true } : {}) } : {}) } : {}) });
      if (simple && ![...active.pursuit.patrols].some(patrol => patrol.aiState !== "WRECKED")) {
        active.command({ type: "street-pursuit-stop" });
        throw new Error("No patrol could deploy here. Move to a clear street and try again.");
      }
      if (simple) active.pursuit.cityChase = true;
      if (pako) active.pursuit.pako = true;
      if (frozen) active.pursuit.frozenDriver = { ...dispatchCheckpoint, status: "active",
        lastTick: -1, decisions: 0, recoverStale: simple || useEvasionPreview,
        evasion: pako ? release.evasionProfile === "bounded-recovery-v1" : useEvasionPreview,
        ...(simple ? { evasiveControl: SMART_ESCAPE_CONTROL } : {}) };
      if (isDispatchStyle(style)) active.pursuit.trace =
        new PursuitDecisionTrace(`city-${Date.now()}-${++cityTraceSequence}`);
      if (arcade || simple) void pursuitAudio.unlock();
      cityPracticeRun = active.pursuit.driver === "training" ? active.pursuit : null;
      paused = false;
      lastInput = "";
      clock = new FixedClock();
      lastTime = null;
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
      endCityPursuit();
      updateUI();
    } else if (world.pursuit) reset(world.config);
  },
  onOpenLab: () => {
    activate("lab");
    settingsOpen(true, true);
    $("metroPpoLab").open = true;
    $("metroPpoStage").value = `chase-level-${streetPursuitLevel}`;
    $("pakoTrainingSpeed").value = "fast";
    showLabPpoCheckpoint();
    $("pakoTrain").focus();
    $("pakoTrain").scrollIntoView({ block: "nearest" });
  },
  onExportTrace: () => {
    const run = world.pursuit;
    if (!run?.trace) return;
    if (run.pendingTrace) flushDecisionTrace(world, run);
    const url = URL.createObjectURL(new Blob([run.trace.toJSONL()], { type: "application/x-ndjson" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${run.trace.episodeId}.jsonl`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  onLevel: (level) => {
    if (environment === "metro") {
      streetPursuitLevel = level;
      updateUI();
    } else if (world.pursuit) reset({ ...world.config, pursuitLevel: level });
  },
  onStyle: (style) => {
    if (style !== "survival" && style !== "hunt" && !isGtaStyle(style)) return;
    streetPursuitStyle = style;
    if (!isGtaStyle(style)) streetPursuitLevel = Math.min(4, streetPursuitLevel);
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

function endCityPursuit() {
  const run = world.pursuit;
  if (run?.phase !== "running" && !run?.reviewUntilTick) return;
  const stopping = run.trace && !run.pendingTrace ? startPursuitDecision(world, currentPursuitDecision(run)) : null;
  world.command({ type: "street-pursuit-stop" });
  if (run.trace) {
    if (run.pendingTrace) flushDecisionTrace(world, run);
    else run.trace.append(finishPursuitDecision(world, stopping));
  }
  touchPursuit.clear();
  rememberPackPractice(world);
  lastInput = "";
}
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
function cancelReplayLoad() {
  if (!replayLoad) return false;
  paused = replayLoad.wasPaused;
  replayLoad = null;
  $("replayProgress").textContent = "Replay import canceled.";
  return true;
}

$("replayFile").onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = "";
  const load = { wasPaused: replayLoad?.wasPaused ?? paused };
  replayLoad = load;
  paused = true;
  const progress = $("replayProgress");
  progress.textContent = "Reading replay...";
  let committing = false;
  try {
    const replay = await readReplayFile(file);
    if (replayLoad !== load) return;
    const sliceMs = 22;
    let deadline = performance.now() + sliceMs, previousPercent = -1;
    const steps = World.reconstruct(replay, () => performance.now() >= deadline);
    let result = steps.next();
    while (!result.done) {
      const percent = Math.floor((result.value.tick / replay.totalTicks) * 100);
      if (percent !== previousPercent) {
        progress.textContent = `Replaying: ${percent}%`;
        previousPercent = percent;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (replayLoad !== load) return;
      deadline = performance.now() + sliceMs;
      result = steps.next();
    }
    const restored = result.value,
      previous = worlds[restored.environment];
    committing = true;
    replayLoad = null;
    views.get(previous)?.dispose();
    views.delete(previous);
    worlds[restored.environment] = restored;
    activate(restored.environment);
    progress.textContent = "Replay restored from recorded commands.";
  } catch (error) {
    if (replayLoad === load || committing)
      progress.textContent = `Could not load replay: ${error.message}`;
  } finally {
    if (replayLoad === load || committing) {
      replayLoad = null;
      paused = load.wasPaused;
    }
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
  // With the car facing +Z, the driving cameras' screen right is -X.
  // Keep the plant and recorded actions unchanged; map keys at the boundary.
  const cameraSteer = Number(pressed("KeyA") || pressed("ArrowLeft")) -
    Number(pressed("KeyD") || pressed("ArrowRight"));
  const nitroHeld = touchNitroActive || pressed("ShiftLeft") || pressed("ShiftRight") || pressed("KeyN");
  const chaosManualPressed = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight", "Space"].some(pressed);
  if (world.streetChaos?.active) {
    if (chaosManualPressed && world.streetChaos.driverMode !== "manual") setCairoChaosDriver("manual");
    else if (!chaosManualPressed && world.streetChaos.driverMode !== "manual") return;
  }
  if (world.pursuit?.reviewUntilTick) return;
  if (isPursuing()) {
    if (paused) return;
    const frozen = world.pursuit.frozenDriver;
    if (frozen && frozen.status !== "manual") {
      if (!["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight", "Space"].some(pressed))
        return;
      takeDispatchControl();
    }
    if (pressed("Space") && world.mode === "auto") world.command({ type: "mode", mode: "manual" });
    if (world.mode !== "manual") return;
    const reverse = pressed("KeyS") || pressed("ArrowDown");
    const command = { type: "pursuit-drive", action: {
      steer: cameraSteer,
      throttle: Number(reverse || pressed("KeyW") || pressed("ArrowUp") || nitroHeld),
      brake: Number(pressed("Space")), gear: reverse ? -1 : 1,
      ...(nitroHeld && !reverse && !pressed("Space") ? { nitro: 1 } : {}),
    } };
    const signature = JSON.stringify(command);
    if (signature !== lastInput) {
      world.command(command);
      lastInput = signature;
    }
    return;
  }
  const microbusSpec = world.player.vehicleModel === KING_LONG_MICROBUS_ID ? world.player.spec : null;
  const targetSpeed = pressed("Space")
    ? 0
    : pressed("KeyW") || pressed("ArrowUp") || nitroHeld
      ? world.player.maxSpeed
      : pressed("KeyS") || pressed("ArrowDown")
        ? -(microbusSpec?.reverseSpeed ?? 2.5)
        : 0;
  if (environment === "vision") {
    if (pressed("Space") && !world.visionLab.error) {
      pendingVisionRun = false;
      world.command({ type: "stop" });
    }
    return;
  }
  const command = {
    type: "drive",
    targetSpeed,
    steer: cameraSteer * (microbusSpec?.maxSteer ?? .62),
    ...(nitroHeld && targetSpeed > 0 ? { nitro: 1 } : {}),
  };
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
  const drivingPursuit = world.pursuit?.phase === "running" ? world.pursuit : null;
  const dispatchDriving = drivingPursuit?.gta?.config.ruleset === "dispatch-v1";
  const touchDriving = (drivingPursuit?.survival || dispatchDriving) &&
    world.mode === "manual" && !paused && !isInspection() && !focusedPersonId;
  const pursuitTouch = $("pursuitTouch");
  pursuitTouch.hidden = !touchDriving;
  const touchLabel = dispatchDriving ? "Pursuit driving controls" : "Arcade steering";
  if (pursuitTouch.getAttribute("aria-label") !== touchLabel) pursuitTouch.setAttribute("aria-label", touchLabel);
  $("pursuitTouchReverse").hidden = $("pursuitTouchThrottle").hidden = !dispatchDriving;
  if ($("touchNitro")) $("touchNitro").hidden = !dispatchDriving;
  if (!touchDriving) {
    touchPursuit.clear();
    touchNitroActive = false;
  }
  saveVisionComparison();
  if (pursuitPreview && pursuitPreview.run !== activeCinematic()) pursuitPreview = null;
  updatePreview();
  $("pauseBtn").textContent = paused ? "Resume" : "Pause";
  const cairoState = currentCairoChaosState();
  cairoChaosHud?.update(cairoState);
  document.body.classList.toggle("cairo-active", Boolean(cairoState?.active));
  document.body.classList.toggle("chase-active", isPursuing());
  $("cairoChaosBtn").hidden = environment !== "metro";
  $("speedVal").textContent = Math.round(Math.abs(world.player.speed) * 3.6);
  const frozen = drivingPursuit?.frozenDriver;
  $("selfDrivingBtn").disabled = Boolean(world.player.curbSupportId);
  $("aiToggleBtn").textContent = frozen?.status === "active" ? "PPO · Take over"
    : frozen?.status === "fault" ? "PPO stopped" : frozen?.status === "waiting-for-scan" ? "PPO waiting for scan"
    : world.mode === "auto" ? "Autonomous drive" : "Manual drive";
  $("drivingHelp").textContent = frozen
    ? "W A S D drive · Shift nitro · G +20 people · V exterior cam · C cycle cams · I takes over"
    : "W A S D drive · Shift nitro · Space brake · G +20 people · V exterior cam · C cycle cams · I auto";
  if ($("chaseCamBtn")) {
    $("chaseCamBtn").textContent = chaseCameraStyle === "chasing" ? "Chasing cam" : "Behind car";
    $("chaseCamBtn").setAttribute("aria-pressed", String(chaseCameraStyle === "chasing"));
  }
  $("safetyStatus").textContent = paused
    ? "Simulation paused"
    : frozen?.status === "fault" ? `PPO stopped: ${frozen.error} · Take over with I`
    : frozen?.status === "waiting-for-scan" ? "Braking while waiting for a fresh pursuit scan"
    : frozen?.status === "active" && frozen.cameraBrake ? "Camera forecast: braking for a person"
    : world.destination && !world.player.path.length &&
        !(environment === "metro" && world.pursuit?.resumeTrip && !world.pursuit.tripResumed)
      ? "Destination reached"
      : (reasons[world.player.reason] ?? world.player.reason);
  const controlBasis = frozen?.status === "active" ? "Frozen PPO"
    : isPursuing() ? world.mode === "auto" ? "Virtual ranging" : "Manual" : "Control";
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
  const switchCarBtn = $("switchCarBtn");
  if (switchCarBtn) {
    const inMetro = environment === "metro";
    const targetWorld = inMetro ? world : worlds.metro;
    const isMicrobus = targetWorld?.player?.vehicleModel === KING_LONG_MICROBUS_ID;
    const chaseActive = inMetro && (world.pursuit?.phase === "running" || Boolean(world.pursuit?.reviewUntilTick));
    switchCarBtn.textContent = isMicrobus ? "Switch car · SUV" : "Switch car · Microbus";
    switchCarBtn.disabled = chaseActive;
    switchCarBtn.title = chaseActive
      ? "End Chase before switching vehicle"
      : !inMetro
        ? "Return to City and switch vehicle"
        : isMicrobus
          ? "Switch from King Long microbus to Jetour T2 SUV"
          : "Switch from Jetour T2 SUV to King Long microbus";
  }
  visionPanel?.update({
    world, vision: world.visualState,
    availability: visualClient?.status ?? { available: false, status: "disabled" },
    mode: visionMode, caseId: visionCaseId,
    running: world.visionLab?.phase === "running" || pendingVisionRun,
    comparison: visionComparisons.get(visionComparisonKey(visionCaseId)) ?? null,
  });
  if (cameraScreenVisible && visualClient) updateCameraScreen();
  const peoplePanelOpen = $("peoplePanel") && !$("peoplePanel").hidden;
  if (peoplePanelOpen || focusedPersonId) {
    const people = world.actors.filter((actor) => actor.type === "pedestrian")
      .sort((a, b) => Math.hypot(a.x - world.player.x, a.z - world.player.z)
        - Math.hypot(b.x - world.player.x, b.z - world.player.z) || a.id.localeCompare(b.id));
    if (!people.some((person) => person.id === selectedPersonId)) selectedPersonId = people[0]?.id ?? null;
    if (focusedPersonId && !people.some((person) => person.id === focusedPersonId)) setCarView("chase");
    peoplePanel?.update({
      environment, people, selectedId: selectedPersonId,
      focused: Boolean(focusedPersonId), paused,
    });
  }
  if (environment === "vision")
    $("loadingStatus").textContent = world.visionLab.error
      ?? `Visual prediction · ${world.visionLab.phase} · live camera pixels`;
  $("cameraLabel").firstChild.textContent = sensorCamera === "rear" ? "Rear camera " : "Front camera ";
  if (environment === "metro") {
    const roadReading = onRoadLimit(world, world.player);
    const { roadId, width } = roadReading;
    const result = world.pursuit;
    const pako = result?.phase === "running" ? result.cityChase === true || result.pako === true : pakoPanelOpen;
    const gta = result?.phase === "running" ? result.variant === "gta" : pako || isGtaStyle(streetPursuitStyle);
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
        : world.pursuit.cityChase ? "Chase · live City streets"
        : world.pursuit.gta?.config.ruleset === "dispatch-v1" ? "Metro Dispatch · live City streets"
        : world.pursuit.gta ? "GTA Chase · live City streets"
        : world.pursuit.survival ? "Pursuit · live City streets" : "Pursuit · checking exits";
    else if (world.destination && !world.player.path.length && world.pursuit?.resumeTrip && !world.pursuit.tripResumed)
      $("tripLabel").textContent = "Trip paused · choose a destination";
    $("pursuitPanelHost").hidden = !streetPursuitOpen;
    const rushCity = (world.config.cityVersion ?? 0) >= 4;
    const metroSnapshot = result && (!pako || result.cityChase || result.pako) ? pursuitSnapshot(world) : null;
    const metroPatrolStatus = dispatch || result?.reviewUntilTick || result?.gta ? packPatrolStatus(result) : null;
    pursuitStrobe.update(metroSnapshot ? { ...metroSnapshot, patrolStatus: metroPatrolStatus } : null);
    const chaseWorldState = metroSnapshot
      ? {
          ...metroSnapshot,
          patrolStatus: metroPatrolStatus,
          paused,
          player: world.player,
          nitroCharge: world.player.nitroCharge,
          nitroActive: world.player.nitroActive,
          nitroSuppressedByPedestrian: world.player.nitroSuppressedByPedestrian,
          crowdAheadCount: world.crowdAheadCount ?? 0,
        }
      : {
          phase: "ready",
          player: world.player,
          nitroCharge: world.player.nitroCharge,
          nitroActive: world.player.nitroActive,
          nitroSuppressedByPedestrian: world.player.nitroSuppressedByPedestrian,
          crowdAheadCount: world.crowdAheadCount ?? 0,
        };
    pursuitPanel.update(streetPursuitOpen ? {
      ...(metroSnapshot ?? { phase: "ready", metrics: {} }),
      street: true, mode: world.mode, paused,
      cinematic: Boolean(result?.response) || (!result && rushCity),
      arcade: rushCity,
      cityPursuitStyle: rushCity ? streetPursuitStyle : null,
      pako, pakoAvailable: Boolean(approvedPakoPolicy()), pakoBestS,
      pakoDriverMode, chaseCameraStyle, customCheckpoint, ppoSummary: formatPpoSummary(dispatchCheckpoint?.policy),
      cityPackPressureAvailable: world.config.cityVersion >= 5 && streetPursuitLevel >= 4,
      microbus: world.player.vehicleModel === KING_LONG_MICROBUS_ID,
      checkpointStatus, checkpointReady: dispatchCheckpoint !== null,
      surface: world.player?.vehicle?.surface ?? null,
      frozenDriver: result?.frozenDriver,
      trace: result?.trace,
      bestSurvivalS, soundMuted: pursuitAudio.muted, soundError: pursuitAudio.error,
      pack: !gta && rushCity && (!dispatch || isPackPursuit(result.variant)),
      labPolicyAvailable: Boolean(labPackCheckpoint),
      speedMps: world.player.speed,
      nitroCharge: world.player.nitroCharge,
      nitroActive: world.player.nitroActive,
      nitroSuppressedByPedestrian: world.player.nitroSuppressedByPedestrian,
      crowdAheadCount: world.crowdAheadCount ?? 0,
      dispatchWaves: rushCity,
      patrolStatus: metroPatrolStatus,
      appliedSpeedMps: world.player.districtSources?.finalMps,
      appliedSource: world.player.districtSources?.appliedSource,
      level: result?.phase === "running" ? result.level : streetPursuitLevel,
    } : null, chaseWorldState);
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
    const snap = pursuitSnapshot(world);
    const patrolStatus = packLab ? packPatrolStatus(world.pursuit) : null;
    pursuitStrobe.update({ ...snap, patrolStatus });
    pursuitPanel.update({ ...snap, mode: world.mode, paused,
      ...(packLab ? { cinematic: true, arcade: true, cases: PACK_DRILLS,
        speedMps: world.player.speed, patrolStatus } : {}) });
  } else if (environment !== "metro") {
    pursuitStrobe.update(null);
    pursuitPanel.update(null);
  }
  if (vehicleSwitchNotice) {
    if (performance.now() < vehicleSwitchNotice.until && !isPursuing()) {
      $("tripLabel").textContent = vehicleSwitchNotice.text;
    } else {
      vehicleSwitchNotice = null;
    }
  }
  const nowMapMs = performance.now();
  if (!isPursuing() || nowMapMs - lastMapDrawMs >= 360) {
    lastMapDrawMs = nowMapMs;
    drawMap();
  }
}
let lastMapDrawMs = -999;
const map = $("minimap").getContext("2d");
function drawMap() {
  const scale = environment === "metro"
    ? ((world.config.cityVersion ?? 0) >= 5 ? 0.78 : 1.35)
    : environment === "pursuit" ? 1.55 :
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
  for (const road of world.roads) {
    let rx1, rz1, rx2, rz2;
    if (isDiagonalRoad(road)) {
      rx1 = road.x1;
      rz1 = road.z1;
      rx2 = road.x2;
      rz2 = road.z2;
    } else if (road.axis === "z") {
      rx1 = rx2 = road.fixed;
      rz1 = road.min;
      rz2 = road.max;
    } else {
      rx1 = road.min;
      rx2 = road.max;
      rz1 = rz2 = road.fixed;
    }
    map.strokeStyle = road.zone === "avenue" ? "#a3ad9c" : "#738075";
    map.lineWidth = road.width * scale;
    map.beginPath();
    map.moveTo(cx + rx1 * scale, cz + rz1 * scale);
    map.lineTo(cx + rx2 * scale, cz + rz2 * scale);
    map.stroke();
  }
  if (world.player.path.length) line(world.player.path, "#a5e4bc", 1.8);
  const escapeGoal = environment === "metro" && world.pursuit?.phase === "running"
    ? world.pursuit?.gta?.escapeGoal
    : null;
  if (escapeGoal) {
    const gx = cx + escapeGoal.x * scale, gz = cz + escapeGoal.z * scale;
    const clampedX = Math.max(10, Math.min(210, gx));
    const clampedZ = Math.max(10, Math.min(210, gz));
    map.save();
    map.setLineDash([4, 4]);
    map.strokeStyle = "rgba(110, 238, 194, 0.72)";
    map.lineWidth = 1.5;
    map.beginPath();
    map.moveTo(110, 110);
    map.lineTo(clampedX, clampedZ);
    map.stroke();
    map.setLineDash([]);
    map.fillStyle = "#6eeec2";
    map.beginPath();
    map.arc(clampedX, clampedZ, 4.2, 0, Math.PI * 2);
    map.fill();
    map.strokeStyle = "#14261f";
    map.lineWidth = 1.4;
    map.stroke();
    map.restore();
  }
  if (environment === "metro" && (world.config.cityVersion ?? 0) >= 5) {
    map.fillStyle = "#4d5c57";
    for (const st of world.statics) {
      if (st.kind !== "parked-vehicle") continue;
      const sx = cx + st.x * scale, sz = cz + st.z * scale;
      if (sx < -4 || sx > 224 || sz < -4 || sz > 224) continue;
      map.fillRect(sx - 1.2, sz - 1.2, 2.4, 2.4);
    }
  }
  const accidentIds = world.streetChaos?.accidentActorIds;
  const pulse = .5 + .5 * Math.sin(performance.now() * .009);
  for (const actor of world.actors) {
    const wreck = Boolean(world.streetChaos?.active &&
      (actor.chaosAccident || accidentIds?.has?.(actor.id) || accidentIds?.includes?.(actor.id)));
    const mx = cx + actor.x * scale, mz = cz + actor.z * scale;
    if (actor.kind === "truck" && !wreck) {
      map.save();
      map.translate(mx, mz);
      map.rotate(-(actor.heading ?? 0));
      map.fillStyle = "#c38a43";
      map.fillRect(-2.15, -3.9, 4.3, 7.8);
      map.restore();
      continue;
    }
    map.fillStyle = wreck ? (pulse > .5 ? "#ff553d" : "#ff9b37")
      : actor === world.player ? "#f6efd8"
        : actor.pursuitRole === "police" ? "#ff887a" : actor.type === "pedestrian"
          ? "#dac29c" : "#a5b6b0";
    map.beginPath();
    map.arc(mx, mz, wreck ? 2.3 + pulse * 1.2
      : actor === world.player ? 3.5 : actor.type === "pedestrian" ? 1 : 1.7, 0, Math.PI * 2);
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
function currentCameraEvidence() {
  let result = visualClient.status.result;
  const visual = world.visualState;
  if (result && visual?.available && visual.streamId === result.streamId
      && Number.isSafeInteger(visual.frameId) && visual.frameId < result.frameId)
    result = visualClient.getResult(visual.streamId, visual.frameId) ?? result;
  const matchingMotion = result && visual?.streamId === result.streamId
    && visual.frameId === result.frameId;
  return {
    frame: result ? visualClient.getFrame(result.streamId, result.frameId) : visualClient.latestFrame,
    result, visual: matchingMotion ? visual : null, availability: visualClient.status,
    enabled: visualClient.enabled, ego: { speedMps: world.player.speed },
    applied: { reason: world.player.reason, ...(world.district
      ? { districtSources: world.player.districtSources } : {}) },
  };
}
function updateCameraScreen() {
  cameraScreen.update(currentCameraEvidence());
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
const previewDetailMeshCache = new WeakMap();
const sceneOverlayNodeCache = new WeakMap();
const rigOverlayNodeCache = new WeakMap();
function getPreviewFineDetailMeshes(activeView) {
  let cached = previewDetailMeshCache.get(activeView);
  if (!cached) {
    cached = [
      activeView.scene.getObjectByName("egypt-painted-curb"),
      activeView.scene.getObjectByName("road-markings"),
      activeView.scene.getObjectByName("egypt-asphalt-repairs"),
      activeView.scene.getObjectByName("street-manholes-and-cracks"),
    ].filter(Boolean);
    previewDetailMeshCache.set(activeView, cached);
  }
  return cached;
}
function getSceneOverlayNodes(activeView) {
  let cached = sceneOverlayNodeCache.get(activeView);
  if (!cached || (activeView.pursuitView && !cached.pursuitHalos)) {
    cached = {
      pursuitHalos: activeView.scene.getObjectByName("pursuit-lightbar-halos") ?? null,
      bounceRed: activeView.scene.getObjectByName("pursuit-bounce-red") ?? null,
      bounceBlue: activeView.scene.getObjectByName("pursuit-bounce-blue") ?? null,
      streetPt: activeView.scene.getObjectByName("player-street-key-light") ?? null,
      sculptPt: activeView.scene.getObjectByName("player-sculpt-fill-light") ?? null,
    };
    sceneOverlayNodeCache.set(activeView, cached);
  }
  return cached;
}
function getRigOverlayNodes(rig) {
  if (!rig?.root) return null;
  let cached = rigOverlayNodeCache.get(rig.root);
  if (!cached) {
    cached = {
      debugRays: rig.root.getObjectByName("vehicle-sensor-rays") ?? null,
      wsCracks: rig.root.getObjectByName("suv-windshield-cracks") ?? null,
      rwCracks: rig.root.getObjectByName("suv-rear-window-cracks") ?? null,
      roadPools: rig.root.getObjectByName("suv-road-light-pools") ?? null,
      nitroFlames: rig.nitroFlames ?? rig.root.getObjectByName("player-nitro-flames") ?? null,
    };
    rigOverlayNodeCache.set(rig.root, cached);
  }
  return cached;
}
let lastFrameWorkMs = 0;
let lastPreviewTargetWorld = null;
let lastPreviewSensorCam = null;
let lastPreviewRenderFrame = -999;
function frame(time) {
  requestAnimationFrame(frame);
  const frameStartMs = performance.now();
  renderer.info.reset();
  const delta = lastTime === null ? 1 / 60 : Math.max(0, (time - lastTime) / 1000);
  lastTime = time;
  const perspective = environment === "lab" ? ghostPlayback.perspective() : null;
  const replayCity = perspective && views.get(worlds.metro);
  if (!replayCity) input();
  const survivalReview = world.pursuit?.survival && world.pursuit.reviewUntilTick;
  const tickBeforeAdvance = world.tick;
  if (!paused && !document.hidden) {
    clock.advance(delta * (survivalReview && !reducedMotion.matches ? .33 : 1),
      stepWorld, environment === "metro" ? 5 : Infinity);
  }
  const stepsRanThisFrame = Math.max(0, world.tick - tickBeforeAdvance);
  if (replayCity) {
    if (!lastPerspectiveReplay) {
      $("environmentLabel").textContent = "Recorded Metro playback";
      document.body.setAttribute("data-pako-perspective", "");
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, viewportWidth, viewportHeight);
    lastPerspectiveReplay = perspectiveGhosts.draw(renderer, replayCity, perspective, viewportWidth, viewportHeight);
    mainCalls = totalFrameCalls = renderer.info.render.calls;
    mainTriangles = totalFrameTriangles = renderer.info.render.triangles;
    renderedFrames++;
    lastFrameWorkMs = performance.now() - frameStartMs;
    return;
  }
  if (lastPerspectiveReplay) {
    lastPerspectiveReplay = null;
    document.body.removeAttribute("data-pako-perspective");
    if (environment === "lab") $("environmentLabel").textContent = "Training lab";
    cameraSnap = true;
  }
  updateSurvivalFeedback();
  const player = view.sync(clock.alpha);
  const cinematic = activeCinematic();
  const preview = previewVisible(cinematic);
  // Keep the full scene and camera cadence; the static sun's depth map
  // does not need to be rebuilt up to 60 times a second in a dense City.
  const simSecNow = world.tick / 60;
  const visionIntervalTicks = 6;
  const wantVisionSample = Boolean(
    (visualClient.enabled || cameraScreenVisible || cityPerception.open) &&
      (world.tick < lastVisionCaptureTick || world.tick - lastVisionCaptureTick >= visionIntervalTicks),
  );
  const shadowFrames = (world.config.cityVersion ?? 0) >= 4
    ? (isIntegratedApu ? 24 : 12)
    : 1;
  const currentImpactsPre = world.player?.vehicle?.damage?.impactCount ?? 0;
  const deferShadowOnHeavyTick =
    environment === "metro" &&
    world === lastShadowWorld &&
    renderedFrames - lastShadowFrame < shadowFrames + 16 &&
    (stepsRanThisFrame > 0 ||
      currentImpactsPre > lastImpactCount ||
      lastFrameWorkMs > 11.0);
  if (environment !== "metro" || world !== lastShadowWorld ||
      (!wantVisionSample && !deferShadowOnHeavyTick && renderedFrames - lastShadowFrame >= shadowFrames) ||
      isInspection() || cameraSnap || appliedCutaway !== cutaway) {
    renderer.shadowMap.needsUpdate = true;
    lastShadowWorld = world;
    lastShadowFrame = renderedFrames;
    shadowPassFrames++;
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
  const grandCityMetro = hasMetroGraphics(world);
  const currentImpacts = world.player?.vehicle?.damage?.impactCount ?? 0;
  if (world !== lastImpactWorld) {
    lastImpactWorld = world;
    lastImpactCount = currentImpacts;
    cameraImpactPulse = 0;
  } else if (currentImpacts > lastImpactCount) {
    cameraImpactPulse = 1;
    lastImpactCount = currentImpacts;
  } else {
    cameraImpactPulse *= Math.exp(-5.5 * Math.max(0, Math.min(delta || 0, 0.1)));
    if (cameraImpactPulse < 1e-4) cameraImpactPulse = 0;
  }
  if (freeCameraShotOverride) {
    camera.up.set(0, 1, 0);
    camera.position.set(
      freeCameraShotOverride.pos.x,
      freeCameraShotOverride.pos.y,
      freeCameraShotOverride.pos.z,
    );
    camera.lookAt(
      freeCameraShotOverride.lookAt.x,
      freeCameraShotOverride.lookAt.y,
      freeCameraShotOverride.lookAt.z,
    );
  } else if (personRoot) {
    camera.up.set(0, 1, 0);
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
    camera.up.set(0, 1, 0);
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
  } else if (pursuitShot || (grandCityMetro && cameraMode === "chase")) {
    const packActive = Boolean(pursuitShot && isPackPursuit(pursuitShot.variant));
    const prevSpeed = world.player.previous?.speed ?? world.player.speed ?? 0;
    const accelMps2 = world.sensors?.imu?.longitudinalAccelMps2
      ?? ((world.player.speed ?? 0) - prevSpeed) * 60;
    const surfKind = world.player.vehicle?.surface?.kind ?? "asphalt";
    const baseRough = surfKind === "cobble" ? 0.78 : surfKind === "sand" ? 0.62 : surfKind === "water" ? 0.28 : 0.16;
    const activeScrape = world.player.vehicle?.interaction?.scraping;
    const scrapeIntensity = activeScrape?.active ? (activeScrape.intensity ?? 0) : 0;
    const surfaceRoughness = Math.min(1, Math.max(baseRough + (world.player.curbSupportId ? 0.42 : 0), scrapeIntensity * 0.85));
    pursuitCamera.update(camera, {
      position: player.position,
      heading: player.rotation.y,
      speedMps: Math.abs(world.player.speed),
      streetWidthM: onRoadLimit(world, world.player).width,
      staticIndex: world.staticIndex,
      deltaS: delta,
      snap: cameraSnap || pursuitShot !== lastPursuitShot,
      pack: packActive,
      packLab: Boolean(pursuitShot?.packLab && pursuitShot.patrols.size >= 3),
      cityChase: Boolean(pursuitShot?.cityChase),
      cameraStyle: packActive ? "auto" : chaseCameraStyle,
      trailingVehicles: pursuitShot?.gta?.config.ruleset === "dispatch-v1" ? pursuitShot.patrols : null,
      impactReview: Boolean(pursuitShot && (pursuitShot.metrics.terminalCause === "pedestrian-impact" || Boolean(survivalReview && !reducedMotion.matches))),
      cinematicMotion: grandCityMetro && !packActive,
      accelMps2,
      slipRad: world.player.chaseSlip ?? world.player.arcadeSlip ?? 0,
      surfaceRoughness,
      impactPulse: Math.max(cameraImpactPulse, scrapeIntensity * 0.28),
    });
    if (world.terrainElevationAt) {
      const minCamY = 0.12 + world.terrainElevationAt(camera.position.x, camera.position.z) + 1.15;
      if (camera.position.y < minCamY) camera.position.y = minCamY;
    }
  } else {
    camera.up.set(0, 1, 0);
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
  const captureVision =
    (visualClient.enabled || cameraScreenVisible || cityPerception.open) &&
    mountedCameraPose(player, "sensor");
  if (captureVision) {
    visionCamera.position.copy(offset);
    visionCamera.lookAt(target);
  }
  view.selectedPersonId = $("peopleToggleBtn").getAttribute("aria-expanded") === "true" ? selectedPersonId : null;
  const extraPreviewCam = preview && (cameraMode !== "chase" || sensorCamera === "rear") ? frontCamera : null;
  const extraVisionCam = captureVision && wantVisionSample && cameraMode !== "chase" ? visionCamera : null;
  view.prepareFrame({ cameras: [camera, extraPreviewCam, extraVisionCam] });
  const sceneOverlayNodes = getSceneOverlayNodes(view);
  const rigOverlayNodes = getRigOverlayNodes(view.playerRig);
  const withCleanSensorOverlays = (fn) => {
    const rigRoot = sensorCamera === "front" ? view.playerRig?.root : null;
    const debugRays = rigOverlayNodes?.debugRays ?? null;
    const wsCracks = rigOverlayNodes?.wsCracks ?? null;
    const rwCracks = rigOverlayNodes?.rwCracks ?? null;
    const roadPools = rigOverlayNodes?.roadPools ?? null;
    const nitroFlames = rigOverlayNodes?.nitroFlames ?? null;
    const fxLayer = view.crashEffects?.layer;
    const surfFx = view.streetSurfaces?.fxGroup;
    const pursuitHalos = sceneOverlayNodes.pursuitHalos;
    const apuRed = isIntegratedApu ? sceneOverlayNodes.bounceRed : null;
    const apuBlue = isIntegratedApu ? sceneOverlayNodes.bounceBlue : null;
    const apuStreet = isIntegratedApu ? sceneOverlayNodes.streetPt : null;
    const apuSculpt = isIntegratedApu ? sceneOverlayNodes.sculptPt : null;
    const rigVis = rigRoot?.visible;
    const raysVis = debugRays?.visible;
    const wsVis = wsCracks?.visible;
    const rwVis = rwCracks?.visible;
    const poolsVis = roadPools?.visible;
    const nitroVis = nitroFlames?.visible;
    const fxVis = fxLayer?.visible;
    const surfFxVis = surfFx?.visible;
    const halosVis = pursuitHalos?.visible;
    const apuRedVis = apuRed?.visible;
    const apuBlueVis = apuBlue?.visible;
    const apuStreetVis = apuStreet?.visible;
    const apuSculptVis = apuSculpt?.visible;
    const rVis = view.route.visible;
    if (rigRoot) rigRoot.visible = false;
    if (debugRays) debugRays.visible = false;
    if (wsCracks) wsCracks.visible = false;
    if (rwCracks) rwCracks.visible = false;
    if (roadPools) roadPools.visible = false;
    if (nitroFlames) nitroFlames.visible = false;
    if (fxLayer) fxLayer.visible = false;
    if (surfFx) surfFx.visible = false;
    if (pursuitHalos) pursuitHalos.visible = false;
    if (apuRed) apuRed.visible = false;
    if (apuBlue) apuBlue.visible = false;
    if (apuStreet) apuStreet.visible = false;
    if (apuSculpt) apuSculpt.visible = false;
    view.streetSurfaces?.setSensorCleanMode?.(true);
    view.route.visible = false;
    try {
      return fn();
    } finally {
      if (rigRoot) rigRoot.visible = rigVis;
      if (debugRays) debugRays.visible = raysVis;
      if (wsCracks) wsCracks.visible = wsVis;
      if (rwCracks) rwCracks.visible = rwVis;
      if (roadPools) roadPools.visible = poolsVis;
      if (nitroFlames) nitroFlames.visible = nitroVis;
      if (fxLayer) fxLayer.visible = fxVis;
      if (pursuitHalos) pursuitHalos.visible = halosVis;
      if (apuRed) apuRed.visible = apuRedVis;
      if (apuBlue) apuBlue.visible = apuBlueVis;
      if (apuStreet) apuStreet.visible = apuStreetVis;
      if (apuSculpt) apuSculpt.visible = apuSculptVis;
      view.streetSurfaces?.setSensorCleanMode?.(false);
      if (surfFx) surfFx.visible = surfFxVis;
      view.route.visible = rVis;
    }
  };
  let didVisionCaptureThisFrame = false;
  if (captureVision && wantVisionSample) {
    const callsBeforeCap = renderer.info.render.calls;
    withCleanSensorOverlays(() => {
      const playerRoot = view.playerRig?.root;
      const pVis = playerRoot?.visible;
      if (playerRoot) playerRoot.visible = false;
      try {
        visualClient.capture(view.scene, visionCamera, world.player, simSecNow);
      } finally {
        if (playerRoot) playerRoot.visible = pVis;
      }
    });
    if (renderer.info.render.calls > callsBeforeCap) {
      lastVisionCaptureTick = world.tick;
      visionCaptureFrames++;
      didVisionCaptureThisFrame = true;
    }
  }
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, viewportWidth, viewportHeight);
  const routeVisible = view.route.visible;
  if (cinematic && $("inspectorPanel").hidden) view.route.visible = false;
  const activePursuit = world.pursuit?.phase === "running" ? world.pursuit : null;
  const showForecastGhosts = environment === "metro" && (cityPerception.open || activePursuit?.cityChase);
  if (showForecastGhosts) {
    const pursuitScan = activePursuit?.gta?.scan;
    if (!pursuitScan && (senseWorld !== world || !senseScan)) {
      senseWorld = world;
      senseScan = senseScanner.sample(world);
    }
    const mountedNow = pedestrianForecastView.group.parent !== view.scene;
    if (mountedNow) view.scene.add(pedestrianForecastView.group);
    const shadowUpdatedThisFrame = lastShadowFrame === renderedFrames;
    if (mountedNow || (!shadowUpdatedThisFrame && time - lastPerceptionTime > 150)) {
      lastPerceptionTime = time;
      const activeScan = pursuitScan || senseScan;
      senseForecasts = cityPerception.open
        ? cityPerception.update({ scan: activeScan, tick: world.tick, evidence: currentCameraEvidence() })
        : pedestrianForecasts({ scan: activeScan, tick: world.tick, pair: null });
      pedestrianForecastView.update(senseForecasts, world.terrainElevationAt);
      pedestrianForecastView.group.updateMatrixWorld(true);
    }
  }
  pedestrianForecastView.group.visible = showForecastGhosts && senseForecasts.length > 0;
  if (grandCityMetro && view.metroSkinnedPrototypes?.size > 0) {
    const ad = view.actorDiagnostics?.();
    if ((ad?.loadingPeopleAssets ?? 0) === 0 && (ad?.unwarmedPeopleAssets ?? 0) > 0) {
      prewarmPrototypesOnly(view.scene, view);
      view._allPeoplePrewarmed = true;
    }
  }
  const withChaseSuvCull =
    cameraMode === "chase" && !cutaway && !sensorView && view.playerRig?.withExteriorChaseCulling
      ? view.playerRig.withExteriorChaseCulling
      : (fn) => fn();
  if (grandCityMetro) {
    const camDiag = pursuitCamera.diagnostics();
    const settings = graphics.value;
    const streetSurfaces = view.streetSurfaces;
    const baseExposure = renderer.toneMappingExposure;
    const apuBounceRed = isIntegratedApu ? sceneOverlayNodes.bounceRed : null;
    const apuBounceBlue = isIntegratedApu ? sceneOverlayNodes.bounceBlue : null;
    const apuStreetPt = isIntegratedApu ? sceneOverlayNodes.streetPt : null;
    const apuSculptPt = isIntegratedApu ? sceneOverlayNodes.sculptPt : null;
    const prevRedVis = apuBounceRed?.visible;
    const prevBlueVis = apuBounceBlue?.visible;
    const prevStreetPtVis = apuStreetPt?.visible;
    const prevSculptPtVis = apuSculptPt?.visible;
    if (apuBounceRed) apuBounceRed.visible = false;
    if (apuBounceBlue) apuBounceBlue.visible = false;
    if (apuStreetPt) apuStreetPt.visible = false;
    if (apuSculptPt) apuSculptPt.visible = false;
    try {
      const reflectionPlanes = streetSurfaces?.reflectionPlanes;
      if (settings.reflections === "live" && supportsLiveReflections && reflectionPlanes?.length) {
        const reflection = metroReflections.capture(view.scene, camera, reflectionPlanes, time, [
          view.route, pedestrianForecastView.group, view.crashEffects?.layer,
          streetSurfaces.fxGroup, rigOverlayNodes?.debugRays, sceneOverlayNodes.pursuitHalos,
        ]);
        streetSurfaces.setLiveReflection(reflection);
      } else {
        metroReflections.clear();
      }
      view.metroMaterialDetail?.setEnabled(settings.detail === "fine");
      renderer.toneMappingExposure = baseExposure * settings.exposure / 100;
      withChaseSuvCull(() => {
        cinematicPost.render(view.scene, camera, {
          speedNorm: cameraMode === "chase" ? camDiag.speedNorm : Math.min(1, Math.abs(world.player.speed ?? 0) / 19),
          turnNorm: cameraMode === "chase" ? camDiag.turnNorm : 0,
          impactPulse: cameraImpactPulse,
          timeS: time * 0.001,
          reducedMotion: Boolean(reducedMotion?.matches),
          color: settings.color,
          lensEffects: settings.lensEffects,
          edgeSmoothing: settings.edgeSmoothing,
          enabled: true,
        });
      });
    } finally {
      renderer.toneMappingExposure = baseExposure;
      view.metroMaterialDetail?.setEnabled(false);
      streetSurfaces?.setLiveReflection(null);
      if (apuBounceRed) apuBounceRed.visible = prevRedVis;
      if (apuBounceBlue) apuBounceBlue.visible = prevBlueVis;
      if (apuStreetPt) apuStreetPt.visible = prevStreetPtVis;
      if (apuSculptPt) apuSculptPt.visible = prevSculptPtVis;
    }
    const postDiag = cinematicPost.diagnostics();
    mainCalls = postDiag.sceneCalls + postDiag.postCalls;
    mainTriangles = postDiag.sceneTriangles + 1;
  } else {
    const beforeCalls = renderer.info.render.calls;
    const beforeTris = renderer.info.render.triangles;
    withChaseSuvCull(() => {
      renderer.render(view.scene, camera);
    });
    mainCalls = renderer.info.render.calls - beforeCalls;
    mainTriangles = renderer.info.render.triangles - beforeTris;
  }
  pedestrianForecastView.group.visible = false;
  renderedFrames++;
  if (preview) {
    frontPreviewFrames++;
    const { x, y, width, height } = previewViewport;
    let activePreviewTarget = frontPreviewTarget;
    if (didVisionCaptureThisFrame && sensorCamera === "front" && visualClient?.previewTexture) {
      activePreviewTarget = visualClient.previewTarget;
    } else {
      const shadowJustUpdated = lastShadowFrame === renderedFrames - 1;
      const forceFreshPreview =
        !grandCityMetro ||
        lastPreviewTargetWorld !== world ||
        lastPreviewSensorCam !== sensorCamera ||
        renderedFrames - lastPreviewRenderFrame >= 2;
      if (forceFreshPreview && (!shadowJustUpdated || lastPreviewTargetWorld !== world || lastPreviewSensorCam !== sensorCamera || renderedFrames - lastPreviewRenderFrame >= 3)) {
        const prevTarget = renderer.getRenderTarget();
        withCleanSensorOverlays(() => {
          const fineMeshes = getPreviewFineDetailMeshes(view);
          const fineVis = new Array(fineMeshes.length);
          for (let i = 0; i < fineMeshes.length; i++) {
            fineVis[i] = fineMeshes[i].visible;
            fineMeshes[i].visible = false;
          }
          view.streetSurfaces?.setPreviewThumbnailMode?.(true);
          try {
            renderer.setRenderTarget(frontPreviewTarget);
            renderer.render(view.scene, frontCamera);
          } finally {
            renderer.setRenderTarget(prevTarget);
            view.streetSurfaces?.setPreviewThumbnailMode?.(false);
            for (let i = 0; i < fineMeshes.length; i++) fineMeshes[i].visible = fineVis[i];
          }
        });
        lastPreviewTargetWorld = world;
        lastPreviewSensorCam = sensorCamera;
        lastPreviewRenderFrame = renderedFrames;
      }
    }
    previewBlitMat.map = activePreviewTarget.texture;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, width, height);
    renderer.setViewport(x, y, width, height);
    renderer.clearDepth();
    renderer.render(previewBlitScene, previewBlitCam);
    perceptionOverlay.setViewport(previewViewport);
    if (time - lastFrame > 1000) {
      const asyncB64 = sensorCamera === "front" ? visualClient?.latestFrame?.imageJpegBase64 ?? null : null;
      bridge.sendFrame(activePreviewTarget, asyncB64);
      lastFrame = time;
    }
    renderer.setScissorTest(false);
  }
  view.route.visible = routeVisible;
  totalFrameCalls = renderer.info.render.calls;
  totalFrameTriangles = renderer.info.render.triangles;
  if (time - lastUI > 180 && lastShadowFrame !== renderedFrames - 1 && lastPerceptionTime !== time) {
    updateUI();
    lastUI = time;
  }
  lastFrameWorkMs = performance.now() - frameStartMs;
}
activate("metro");
if (isIntegratedApu && view?.scene) {
  const initNodes = getSceneOverlayNodes(view);
  if (initNodes.streetPt) initNodes.streetPt.visible = false;
  if (initNodes.sculptPt) initNodes.sculptPt.visible = false;
}
prewarmSceneShaders(view.scene, view);
void loadDefaultChasePolicy();
requestAnimationFrame(frame);
// Reproducible diagnostics used by browser smoke tests and Python adapters.
window.sim = {
  get defaultChaseReady() { return defaultChaseReady; },
  get ghostReplay() { return lastPerspectiveReplay; },
  get cityPerception() { return cityPerception.report; },
  get pursuitTraining() { return labSession && { ...labSession }; },
  pursuitAudio: () => ({ ...pursuitAudio.cues, muted: pursuitAudio.muted, audible: Boolean(pursuitAudio.audible) }),
  crashDiagnostics: () => view?.crashDiagnostics?.() ?? null,
  streetSurfaceDiagnostics: () => view?.streetSurfaceDiagnostics?.() ?? null,
  spawnCrowdAhead: (count = 20) => spawnChaseCrowdAhead(count),
  startCairoChaos: (options = {}) => startCairoChaos(options),
  stopCairoChaos: () => stopCairoChaos(),
  triggerCairoChaosEvent: (kind) => triggerCairoChaosEvent(kind),
  cairoChaosState: () => currentCairoChaosState(),
  setSensorCamera: (dir) => carAction("sensor-camera", dir),
  setFreeCameraShot: (shot) => {
    freeCameraShotOverride = shot && shot.pos && shot.lookAt ? shot : null;
    cameraSnap = true;
  },
  nitroStatus: () => ({
    charge: world?.player?.nitroCharge ?? 1,
    active: Boolean(world?.player?.nitroActive),
    intensity: world?.player?.nitroIntensity ?? 0,
    suppressedByPedestrian: Boolean(world?.player?.nitroSuppressedByPedestrian),
    crowdAheadCount: world?.crowdAheadCount ?? 0,
    lastCrowdSpawn: world?.lastCrowdSpawn ?? null,
  }),
  forecastDiagnostics: () => {
    let visibleInstances = 0;
    pedestrianForecastView?.group?.traverse?.((c) => {
      if (c.isInstancedMesh && c.visible) visibleInstances += c.count ?? 0;
    });
    return {
      count: senseForecasts?.length ?? 0,
      visibleMeshes: visibleInstances,
      groupParented: pedestrianForecastView?.group?.parent === view?.scene,
    };
  },
  cinematicDiagnostics: () => ({
    camera: pursuitCamera.diagnostics(),
    post: cinematicPost.diagnostics(),
    atmosphere: view?.atmosphereDiagnostics?.() ?? null,
  }),
  graphicsDiagnostics: () => ({
    settings: { ...graphics.value },
    supportsLiveReflections,
    reflection: metroReflections.diagnostics(),
  }),
  readCameraPreviewPixels() {
    const { width, height } = frontPreviewTarget;
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(frontPreviewTarget, 0, 0, width, height, pixels);
    return { width, height, pixels };
  },
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
  get chaseCameraStyle() { return chaseCameraStyle; },
  setChaseCameraStyle(style) { setChaseCameraStyle(style); },
  carAction(action, value) { return carAction(action, value); },
  prewarmShaders() { prewarmSceneShaders(view?.scene, view); },
  renderDiagnostics() {
    const gl = renderer.getContext();
    return {
      renderedFrames, cameraMode, chaseCameraStyle, cameraFov: camera.fov, cutaway, sensorView, sensorCamera,
      width: renderer.domElement.width, height: renderer.domElement.height,
      pixelRatio: renderer.getPixelRatio(),
      renderCalls: totalFrameCalls,
      triangles: totalFrameTriangles,
      autoReset: renderer.info.autoReset,
      shadowPassFrames,
      visionCaptureFrames,
      frontPreviewFrames,
      previewActive: Boolean(previewVisible()),
      cameraScreenVisible,
      mainCalls, mainTriangles,
      lastFrameWorkMs,
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
    updateUI();
  },
  step(count = 1) {
    for (let i = 0; i < count; i++) stepWorld();
    updateUI();
  },
  snapshot: () => world.snapshot(),
  audit: () => world.audit(),
  replay: () => world.replay(),
  command: (command) => world.command(command),
  activate,
  reset,
};
