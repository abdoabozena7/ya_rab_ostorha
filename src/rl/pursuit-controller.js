import { PURSUIT_STOP, validatePursuitAction } from "../core/pursuit-controls.js";
import { PURSUIT_SCAN_TICKS } from "../signal_processing/pursuit-scanner.js";
import { getDispatchObservation } from "./gta-pursuit-env.js";
import { selectDispatchMovement, requireDispatchScan } from "./pursuit-shield.js";
import { planDispatchEvasion } from "./pursuit-evasion.js";
import { PAKO_EVASIVE_CONTROL, planPakoEvasiveAction } from "./pako-evasive-control.js";
import { SMART_ESCAPE_CONTROL, planSmartEscapeAction } from "./pako-smart-escape.js";

function stripNitro(action) {
  if (!action || !Object.prototype.hasOwnProperty.call(action, "nitro")) return action;
  const { steer, throttle, brake, gear } = action;
  return { steer, throttle, brake, gear };
}

function dispatchCommandAction(action) {
  if (!action?.nitro) return action;
  try {
    return validatePursuitAction(action);
  } catch {
    return stripNitro(action);
  }
}

function setPedestrianNitroHold(player, suppressed) {
  if (!player || typeof player !== "object") return;
  const desc = Object.getOwnPropertyDescriptor(player, "nitroSuppressedByPedestrian");
  if ((desc && desc.writable) || (!desc && Object.isExtensible(player))) {
    player.nitroSuppressedByPedestrian = Boolean(suppressed);
  }
}

function visualCrossingBrake(visual, cameraStream, guarded) {
  if (!cameraStream || guarded.reason || guarded.action.gear !== 1 || !guarded.action.throttle ||
      visual?.source !== "visual-prediction" || visual.streamId !== cameraStream || !visual.available ||
      visual.status !== "ready" || !Number.isSafeInteger(visual.frameId) ||
      !Number.isFinite(visual.ageMs) || visual.ageMs < 0 || visual.ageMs > 650) return null;
  const decision = visual.decision;
  if (!decision?.brake || decision.available !== true || decision.evidenceFrameId !== visual.frameId) return null;
  if (decision.reason === "observed-person-crossing-conflict") {
    if (!visual.forecasts?.some(forecast => forecast.trackId === decision.trackId && forecast.qualified &&
        forecast.conflict && forecast.label === "person")) return null;
  } else if (decision.reason === "committed-visual-stop" || decision.reason === "awaiting-visual-clearance") {
    // Reuse the predictor's bounded stop episode rather than reframing the
    // slowdown itself as loss of crossing risk on the next decision.
    const track = visual.tracks?.find(item => item.id === decision.trackId);
    const episode = track?.stopEpisode;
    if (track?.source !== "camera-pixels" || track.label !== "person" || track.streamId !== cameraStream ||
        track.frameId !== visual.frameId || episode?.streamId !== cameraStream ||
        episode.trackId !== track.id || !["stopping", "awaiting-clearance"].includes(episode.phase)) return null;
  } else return null;
  return { frameId: visual.frameId, streamId: cameraStream, trackId: decision.trackId, reason: decision.reason };
}

export function applyFrozenDispatchAction(world, driver, cameraStream = null) {
  if (driver?.status !== "active" && driver?.status !== "waiting-for-scan") return false;
  let action = null;
  const start = performance.now();
  try {
    const scan = requireDispatchScan(world);
    if (driver.lastTick === scan.tick && driver.lastScan === scan) return false;
    const ignorePedCol = Boolean(driver._faultIgnorePedestrianCollisionOnly);
    const obsWorld = ignorePedCol
      ? {
          ...world,
          pursuit: {
            ...world.pursuit,
            gta: {
              ...world.pursuit.gta,
              scan: Object.freeze({
                ...scan,
                rays: Object.freeze(
                  scan.rays.map((r) =>
                    r.kind === "pedestrian" ? Object.freeze({ kind: "none", rangeM: 48 }) : r,
                  ),
                ),
                tracks: Object.freeze(scan.tracks.filter((t) => t.kind !== "pedestrian")),
              }),
            },
          },
        }
      : world;
    action = driver.policy.action(getDispatchObservation(obsWorld, driver.policy.observation));
    const alternate = driver.evasiveControl === SMART_ESCAPE_CONTROL ? planSmartEscapeAction
      : driver.evasiveControl === PAKO_EVASIVE_CONTROL ? planPakoEvasiveAction
      : driver.evasion ? planDispatchEvasion : null;
    const guarded = selectDispatchMovement(world, action, alternate);
    const cameraBrake = ignorePedCol ? null : visualCrossingBrake(world.visualState, cameraStream, guarded);
    const submitted = cameraBrake
      ? { ...stripNitro(guarded.action), throttle: 0, brake: 1 }
      : guarded.action;
    setPedestrianNitroHold(world.player, Boolean(cameraBrake || guarded.planner?.nitroSuppressedByPedestrian));
    driver.inferenceMs = performance.now() - start;
    world.command({ type: "pursuit-drive", action: dispatchCommandAction(submitted) });
    const resumed = driver.status === "waiting-for-scan";
    driver.status = "active";
    driver.scanDeadline = null;
    driver.error = driver.faultCode = null;
    driver.shieldReason = guarded.reason;
    driver.cameraBrake = cameraBrake;
    driver.lastDecision = { source: "policy", policyId: driver.sha256, status: driver.status,
      requested: action, submitted, shieldReason: guarded.reason, cameraBrake,
      planner: guarded.planner ?? null, inferenceMs: driver.inferenceMs };
    driver.lastTick = scan.tick;
    driver.lastScan = scan;
    driver.decisions++;
    return resumed;
  } catch (error) {
    driver.cameraBrake = null;
    if (error?.code === "STALE_OBSERVATION" && driver.recoverStale) {
      if (driver.status === "active") {
        driver.status = "waiting-for-scan";
        driver.scanDeadline = world.tick + 3 * PURSUIT_SCAN_TICKS;
        driver.shieldReason = null;
        driver.lastDecision = { source: "policy", policyId: driver.sha256, status: driver.status,
          requested: action, submitted: PURSUIT_STOP, inferenceMs: performance.now() - start,
          fault: { code: error.code, message: error.message } };
        world.command({ type: "pursuit-drive", action: PURSUIT_STOP });
        return true;
      }
      if (world.tick < driver.scanDeadline) return false;
    }
    driver.status = "fault";
    driver.error = error instanceof Error ? error.message : String(error);
    driver.faultCode = error?.code === "STALE_OBSERVATION" ? error.code : "CONTROLLER_FAULT";
    driver.inferenceMs = performance.now() - start;
    driver.lastDecision = { source: "policy", policyId: driver.sha256, status: "fault",
      requested: action, submitted: PURSUIT_STOP, inferenceMs: driver.inferenceMs,
      fault: { code: driver.faultCode, message: driver.error } };
    driver.policy = null;
    world.command({ type: "pursuit-drive", action: PURSUIT_STOP });
    return true;
  }
}
