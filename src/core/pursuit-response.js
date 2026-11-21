import { STEP, clamp } from "./config.js";
import { corners, distance } from "./geometry.js";
import { updateDispatchTracking } from "./pursuit-dispatch.js";
import { isCityHunt } from "./pursuit-survival.js";

const CONTACT_RANGE_M = 52, ARCADE_CONTACT_RANGE_M = 60;
const FORWARD_CONE_COS = Math.cos(100 * Math.PI / 180);
const CLOSE_RANGE_M = 7.2;
const GTA_RANGE_M = 65, GTA_PROXIMITY_M = 14, GTA_CLOSE_M = 7.5;
const GTA_FORWARD_COS = Math.cos(55 * Math.PI / 180);
const SEPARATION_M = 24;
const SEARCH_TICKS = Math.round(2.5 / STEP);
const CLEAR_TICKS = Math.round(4.5 / STEP);
const STAR_TICKS = Math.round(2.4 / STEP);
const visibilityGeometry = new WeakMap();

function staticGeometry(world) {
  const { staticIndex } = world;
  let geometry = visibilityGeometry.get(staticIndex);
  if (geometry) return geometry;
  const boxes = new Map();
  let reach = 0;
  for (const body of world.statics) {
    const w = body.width / 2, l = body.length / 2;
    if (!(w > 0 && l > 0)) continue;
    reach = Math.max(reach, Math.hypot(w, l));
    boxes.set(body, { w, l, sin: Math.sin(body.heading ?? 0), cos: Math.cos(body.heading ?? 0) });
  }
  geometry = { boxes, reach };
  visibilityGeometry.set(staticIndex, geometry);
  return geometry;
}

function intersects(x, z, dx, dz, body, { w, l, sin, cos }) {
  const bx = x - body.x, bz = z - body.z;
  const across = bx * cos - bz * sin, along = bx * sin + bz * cos;
  const da = dx * cos - dz * sin, dl = dx * sin + dz * cos;
  let enter = 0, leave = 1;
  if (Math.abs(da) < 1e-8) {
    if (Math.abs(across) > w) return false;
  } else {
    const near = (-w - across) / da, far = (w - across) / da;
    enter = Math.max(enter, Math.min(near, far));
    leave = Math.min(leave, Math.max(near, far));
    if (enter > leave) return false;
  }
  if (Math.abs(dl) < 1e-8) return Math.abs(along) <= l;
  const near = (-l - along) / dl, far = (l - along) / dl;
  return Math.max(enter, Math.min(near, far)) <= Math.min(leave, Math.max(near, far));
}

function unobstructed(world, from, dx, dz, range) {
  const { boxes, reach } = staticGeometry(world);
  const midpoint = { x: from.x + dx / 2, z: from.z + dz / 2 };
  // The midpoint sphere encloses every intersecting footprint's centre.
  return !world.staticIndex.near(midpoint, range / 2 + reach).some(body => {
    const box = boxes.get(body);
    return box && intersects(from.x, from.z, dx, dz, body, box);
  });
}

export const gtaLineClear = unobstructed;

export function gtaDeploymentHidden(world, from, body) {
  const radius = Math.hypot(body.width, body.length) / 2;
  const range = distance(from, body);
  if (range - radius > 55) return true;
  const { boxes, reach } = staticGeometry(world);
  const midpoint = { x: (from.x + body.x) / 2, z: (from.z + body.z) / 2 };
  const footprint = corners(body);
  const height = Math.max(from.height ?? 1.8, body.height ?? 0);
  // The shadow of one convex rectangle is convex. Covering all four
  // corners with the same solid covers the space between the rays too.
  return world.staticIndex.near(midpoint, range / 2 + reach + radius).some(cover => {
    const box = boxes.get(cover);
    return box && cover.height >= height && footprint.every(point =>
      intersects(from.x, from.z, point.x - from.x, point.z - from.z, cover, box));
  });
}

export function createPursuitResponse() {
  return {
    stage: "search", pressure: 0, clearProgress: 0, unitsInContact: 0,
    lastSeen: null, sightedBy: new Set(), closePatrols: new Set(),
    lostAtTick: null, clearAtTick: null,
  };
}

/** Sample only accepted game poses; this is separate from the mounted RGB path. */
export function updatePursuitResponse(world, initial = false) {
  const { player, pursuit, tick } = world;
  const r = pursuit.response;
  const gta = pursuit.variant === "gta";
  const hunt = isCityHunt(pursuit.variant) && pursuit.street;
  const arcade = pursuit.variant === "arcade" || pursuit.variant === "pack" || isCityHunt(pursuit.variant);
  const contactRange = gta ? GTA_RANGE_M : arcade ? ARCADE_CONTACT_RANGE_M : CONTACT_RANGE_M;
  const before = r.stage;
  r.sightedBy.clear();
  r.closePatrols.clear();
  let nearest = contactRange;
  for (const unit of pursuit.patrols) {
    if (gta && (unit.aiState === "WRECKED" || (r.dispatch && unit.health <= 0))) continue;
    const dx = player.x - unit.x, dz = player.z - unit.z;
    const range = Math.hypot(dx, dz);
    if (range > contactRange) continue;
    const close = range < (gta ? GTA_CLOSE_M : CLOSE_RANGE_M);
    const ahead = dx * Math.sin(unit.heading) + dz * Math.cos(unit.heading);
    const outsideCone = gta ? range > GTA_PROXIMITY_M && ahead < range * GTA_FORWARD_COS
      : !arcade && !close && ahead < range * FORWARD_CONE_COS;
    if (outsideCone ||
        !unobstructed(world, unit, dx, dz, range)) continue;
    if (close) r.closePatrols.add(unit);
    r.sightedBy.add(unit);
    nearest = Math.min(range, nearest);
  }
  r.unitsInContact = r.sightedBy.size;
  const desired = r.unitsInContact ? clamp(
    .12 + .64 * (1 - nearest / contactRange) + .09 * (r.unitsInContact - 1), 0, 1) : 0;
  r.pressure = initial ? desired : r.pressure + clamp(desired - r.pressure, -.28 * STEP, .37 * STEP);
  if (r.dispatch) return updateDispatchTracking(world, initial);
  if (r.unitsInContact) {
    r.lastSeen = Object.freeze({ x: player.x, z: player.z, heading: player.heading, speed: player.speed, tick });
    r.stage = "contact";
    r.lostAtTick = r.clearAtTick = null;
    if (hunt) r.clearInitialStars = 0;
    r.clearProgress = 0;
    return !initial && before !== "contact" ? "reacquired" : null;
  }
  r.lostAtTick ??= tick;
  if (gta) return before === "contact" ? "contact-lost" : null;
  if (hunt) {
    const report = r.lastSeen ?? pursuit.playerStart;
    const separated = pursuit.metrics.distanceM >= 14 && distance(player, report) >= 18 &&
      [...pursuit.patrols].every(unit => distance(player, unit) >= 17);
    if (separated && tick - r.lostAtTick >= SEARCH_TICKS) {
      if (r.clearAtTick === null) {
        r.clearAtTick = tick;
        r.clearInitialStars = pursuit.wantedLevel;
      }
      const faded = Math.floor((tick - r.clearAtTick) / STAR_TICKS);
      pursuit.wantedLevel = Math.max(0, r.clearInitialStars - faded);
      r.clearProgress = clamp((tick - r.clearAtTick) / (STAR_TICKS * Math.max(1, r.clearInitialStars)), 0, 1);
      r.stage = "clearing";
      return before !== "clearing" ? "clearing" : null;
    }
    r.stage = "search";
    r.clearAtTick = null;
    r.clearProgress = 0;
    return before === "contact" ? "contact-lost" : null;
  }
  const separated = pursuit.metrics.distanceM >= SEPARATION_M && distance(player, pursuit.playerStart) >= SEPARATION_M;
  if (tick - r.lostAtTick >= SEARCH_TICKS && separated) {
    r.stage = "clearing";
    r.clearAtTick ??= tick;
    r.clearProgress = clamp((tick - r.clearAtTick) / CLEAR_TICKS, 0, 1);
    return before !== "clearing" ? "clearing" : null;
  }
  r.stage = "search";
  r.clearAtTick = null;
  r.clearProgress = 0;
  return before === "contact" ? "contact-lost" : null;
}

export function pursuitResponseSnapshot({ stage, pressure, clearProgress, unitsInContact, dispatch }) {
  return { stage, pressure, clearProgress, unitsInContact,
    ...(dispatch ? { dispatch: { state: dispatch.state, zoneIds: [...dispatch.zoneIds],
      lastReportTick: dispatch.lastReportTick } } : {}) };
}
