import { STEP, clamp } from "./config.js";
import { distance } from "./geometry.js";

export const DISPATCH_RULESET = "dispatch-v1";

const noZones = Object.freeze([]);
const zoneFields = ["id", "minX", "maxX", "minZ", "maxZ"];
export const DEFAULT_SURVEILLANCE_ZONES = Object.freeze([
  Object.freeze({ id: "civic", minX: -256, maxX: -156, minZ: -120, maxZ: 36 }),
  Object.freeze({ id: "gateway", minX: -174, maxX: -70, minZ: -118, maxZ: 18 }),
  Object.freeze({ id: "market", minX: -102, maxX: 25, minZ: -68, maxZ: 23 }),
]);

const LAST_KNOWN_TICKS = Math.round(1.25 / STEP);
const SEARCH_TICKS = Math.round(6 / STEP);
const ELIGIBLE_TICKS = Math.ceil(1 / STEP);
const LOSS_GRACE_TICKS = Math.round(3 / STEP);
const FADE_TICKS = Math.round(2.4 / STEP);

export function resolveSurveillanceZones(zones) {
  if (!Array.isArray(zones)) throw new TypeError("surveillanceZones must be an array");
  if (zones.length > 16) throw new RangeError("surveillanceZones allows at most 16 zones");
  const resolved = [], ids = new Set();
  for (const zone of zones) {
    if (!zone || Object.getPrototypeOf(zone) !== Object.prototype ||
        Reflect.ownKeys(zone).length !== zoneFields.length || !zoneFields.every(key => Object.hasOwn(zone, key)))
      throw new TypeError("Each surveillance zone needs exactly id, minX, maxX, minZ, and maxZ");
    const { id, minX, maxX, minZ, maxZ } = zone;
    if (typeof id !== "string" || !id.trim() || id.length > 64 || ids.has(id))
      throw new TypeError("Each surveillance zone needs a unique non-blank string id of at most 64 characters");
    if (![minX, maxX, minZ, maxZ].every(Number.isFinite) || !(minX < maxX && minZ < maxZ))
      throw new RangeError("Surveillance zone bounds must be finite and strictly ordered");
    ids.add(id);
    resolved.push(Object.freeze({ id, minX, maxX, minZ, maxZ }));
  }
  return Object.freeze(resolved);
}

export function createDispatchResponse() {
  return { state: "LOST", zoneIds: noZones, lastReportTick: null,
    lastSampleTick: null, mobileTrackTicks: 0, escapeEligible: false };
}

export function isDispatchTracked(response) {
  const state = response?.dispatch?.state;
  return state === "ZONE_TRACKED" || state === "VISUALLY_SPOTTED";
}

const active = unit => unit.health > 0 && unit.aiState !== "WRECKED";

function mobileNearby(patrols, player) {
  for (const unit of patrols) {
    // The swept solver can leave a body with impulse velocity but no travel.
    // Only motion actually accepted on this step earns pursuit time.
    if (active(unit) && unit.aiState !== "ROADBLOCK" && unit.previous &&
        Math.abs(unit.speed) >= 3 && distance(unit, unit.previous) >= 3 * STEP - 1e-8 &&
        distance(unit, player) <= 65) return true;
  }
  return false;
}

export function updateDispatchTracking(world, initial) {
  const { player, pursuit, tick } = world, { response, gta } = pursuit;
  const d = response.dispatch, wasTracked = isDispatchTracked(response);
  const { x, z, heading, speed } = player;
  const zoneIds = [];
  for (const zone of gta.config.surveillanceZones)
    if (x >= zone.minX && x <= zone.maxX && z >= zone.minZ && z <= zone.maxZ)
      zoneIds.push(zone.id);
  d.zoneIds = zoneIds.length ? Object.freeze(zoneIds) : noZones;
  const tracked = zoneIds.length > 0 || response.unitsInContact > 0;
  if (!d.escapeEligible && (initial || d.lastSampleTick !== tick)) {
    const qualifyingStep = !initial && d.lastSampleTick === tick - 1 && tracked &&
      mobileNearby(pursuit.patrols, player);
    d.mobileTrackTicks = qualifyingStep ? d.mobileTrackTicks + 1 : 0;
    d.escapeEligible = d.mobileTrackTicks >= ELIGIBLE_TICKS;
  }
  d.lastSampleTick = tick;
  if (tracked) {
    const sin = Math.sin(heading), cos = Math.cos(heading), slip = player.gtaSlipMps ?? 0;
    response.lastSeen = Object.freeze({ x, z, heading, speed, tick,
      vx: sin * speed + cos * slip, vz: cos * speed - sin * slip });
    d.lastReportTick = tick;
    d.state = zoneIds.length ? "ZONE_TRACKED" : "VISUALLY_SPOTTED";
    response.stage = "contact";
    response.lostAtTick = response.clearAtTick = null;
    response.clearProgress = 0;
    return !initial && !wasTracked ? "reacquired" : null;
  }
  response.lostAtTick ??= tick;
  const age = tick - response.lostAtTick;
  d.state = !response.lastSeen || age >= SEARCH_TICKS ? "LOST"
    : age >= LAST_KNOWN_TICKS ? "SEARCHING" : "LAST_KNOWN";
  response.stage = "search";
  return wasTracked ? "contact-lost" : null;
}

function separated(player, pursuit) {
  if (distance(player, pursuit.playerStart) < 45 || distance(player, pursuit.response.lastSeen) < 32)
    return false;
  for (const unit of pursuit.patrols)
    if (active(unit) && distance(player, unit) < 28) return false;
  return true;
}

export function updateDispatchEscape(world, tracked) {
  const { player, pursuit, tick } = world, { response, gta } = pursuit;
  if (tracked) {
    gta.lostTicks = 0;
    gta.fadeStars = pursuit.wantedLevel;
    return;
  }
  gta.lostTicks = tick - (response.lostAtTick ?? tick);
  // Ground-truth separation is a scoring condition, not an input to patrol AI.
  if (!response.dispatch.escapeEligible || !response.lastSeen || !separated(player, pursuit)) {
    response.clearAtTick = null;
    response.clearProgress = 0;
    pursuit.wantedLevel = gta.fadeStars;
    return;
  }
  response.clearAtTick ??= tick;
  const fading = Math.max(0, tick - response.clearAtTick - LOSS_GRACE_TICKS);
  const stars = gta.fadeStars;
  const wanted = Math.max(0, stars - Math.floor(fading / FADE_TICKS));
  if (wanted < pursuit.wantedLevel) gta.heat = 0;
  pursuit.wantedLevel = wanted;
  response.stage = fading > 0 ? "clearing" : "search";
  response.clearProgress = clamp(fading / (FADE_TICKS * stars), 0, 1);
}
