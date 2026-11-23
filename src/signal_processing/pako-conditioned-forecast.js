import { STEP } from "../core/config.js";
import { angleDelta } from "../core/geometry.js";
import { integrateGtaSlip } from "../core/pursuit-gta.js";
import { pursuitCommand, validatePursuitAction } from "../core/pursuit-controls.js";
import { integrateVehicle, vehicleProbe } from "../core/vehicle.js";

export const PAKO_FORECAST_TICKS = Object.freeze([30, 60, 120, 180, 300]);
const local = (x, z, yaw) => [x * Math.cos(yaw) - z * Math.sin(yaw), x * Math.sin(yaw) + z * Math.cos(yaw)];

export function createForecastInputs(ego, track, actions, decisionTicks = 6) {
  if (track?.ageS !== 0 || !track.motionKnown ||
      ![track.observedXM, track.observedZM, track.estimatedXMps, track.estimatedZMps,
        ego.x, ego.z, ego.heading, ego.speed].every(Number.isFinite)) return null;
  if (!Number.isSafeInteger(decisionTicks) || decisionTicks < 1 || decisionTicks > 60 ||
      !Array.isArray(actions) || actions.length * decisionTicks < PAKO_FORECAST_TICKS.at(-1))
    throw new RangeError("Forecast controls must cover the full candidate horizon");
  actions.forEach(validatePursuitAction);
  const { x, z, heading, speed } = ego;
  const origin = local(track.observedXM - x, track.observedZM - z, heading);
  const velocity = local(track.estimatedXMps, track.estimatedZMps, heading);
  const base = [1, ...origin.map(value => value / 24), ...velocity.map(value => value / 16), speed / 18];
  let pose = { ...vehicleProbe(ego, speed), gtaSlipMps: ego.gtaSlipMps, gtaYawRate: ego.gtaYawRate };
  const inputs = [];
  for (let tick = 1; tick <= PAKO_FORECAST_TICKS.at(-1); tick++) {
    const action = actions[Math.floor((tick - 1) / decisionTicks)];
    const next = integrateVehicle(pose, pursuitCommand(pose, action, STEP), STEP);
    integrateGtaSlip(pose, next);
    pose = next;
    if (!PAKO_FORECAST_TICKS.includes(tick)) continue;
    const time = tick * STEP, turn = angleDelta(pose.heading, heading);
    const displacement = local(pose.x - x, pose.z - z, heading);
    inputs.push({ tick, cv: origin.map((value, i) => value + velocity[i] * time),
      independent: base,
      conditioned: [...base, ...displacement.map(value => value / 28), Math.sin(turn), 1 - Math.cos(turn), (pose.speed - speed) / 18] });
  }
  return inputs;
}

function regress(rows, field) {
  const n = rows[0].input[field].length;
  const normal = Array.from({ length: n }, () => new Float64Array(n + 2));
  for (const row of rows) {
    const x = row.input[field], y = row.actual.map((value, i) => value - row.input.cv[i]);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) normal[i][j] += x[i] * x[j];
      normal[i][n] += x[i] * y[0];
      normal[i][n + 1] += x[i] * y[1];
    }
  }
  // Fixed shrinkage for a small development sample, never chosen from evaluation data.
  for (let i = 0; i < n; i++) normal[i][i] += .18;
  for (let column = 0; column < n; column++) {
    const pivot = normal[column][column];
    for (let j = column; j < n + 2; j++) normal[column][j] /= pivot;
    for (let i = 0; i < n; i++) {
      if (i === column) continue;
      const f = normal[i][column];
      for (let j = column; j < n + 2; j++) normal[i][j] -= f * normal[column][j];
    }
  }
  return normal.map(row => Array.from(row.slice(n)));
}

export function predictSurfaceResponse(horizon, input, arm = "conditioned") {
  if (arm === "cv") return [...input.cv];
  if (arm !== "conditioned" && arm !== "independent") throw new TypeError("Unknown forecast arm");
  if (!horizon || horizon.tick !== input.tick) throw new RangeError("Forecast horizon does not match the input");
  return input.cv.map((value, axis) => input[arm].reduce((sum, x, i) => sum + x * horizon[arm][i][axis], value));
}

export function fitSurfaceResponse(rows) {
  return PAKO_FORECAST_TICKS.map(tick => {
    const samples = rows.filter(row => row.input.tick === tick);
    if (samples.length < 24) throw new Error(`Not enough retained trajectories to fit tick ${tick}`);
    const horizon = { tick };
    for (const arm of ["independent", "conditioned"]) horizon[arm] = regress(samples, arm);
    horizon.calibrationM = {};
    for (const arm of ["cv", "independent", "conditioned"]) {
      const residuals = samples.map(row => {
        const pred = predictSurfaceResponse(horizon, row.input, arm);
        return Math.hypot(pred[0] - row.actual[0], pred[1] - row.actual[1]);
      }).sort((a, b) => a - b);
      horizon.calibrationM[arm] = residuals[Math.ceil(.9 * residuals.length) - 1];
    }
    return horizon;
  });
}
