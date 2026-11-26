import { STEP, clamp } from "./config.js";
import { distance, overlaps } from "./geometry.js";
import { gtaLineClear } from "./pursuit-response.js";

export const DISPATCH_RULESET = "dispatch-v1";
export const GTA_SEARCH_GRACE_S = 3.0;
export const GTA_STAR_DECAY_S = 4.0;
export const GTA_COVER_STAR_DECAY_S = 3.2;
export const GTA_OPEN_ESCAPE_BASE_M = 80;
export const GTA_COVER_ESCAPE_M = 52;

const noZones = Object.freeze([]);
const zoneFields = ["id", "minX", "maxX", "minZ", "maxZ"];
export const DEFAULT_SURVEILLANCE_ZONES = Object.freeze([
  Object.freeze({ id: "civic", minX: -256, maxX: -156, minZ: -120, maxZ: 36 }),
  Object.freeze({ id: "gateway", minX: -174, maxX: -70, minZ: -118, maxZ: 18 }),
  Object.freeze({ id: "market", minX: -102, maxX: 25, minZ: -68, maxZ: 23 }),
]);

const ticks = seconds => Math.round(seconds / STEP);
const LAST_KNOWN_TICKS = Math.round(1.25 / STEP);
const SEARCH_TICKS = Math.round(6 / STEP);
const ELIGIBLE_TICKS = Math.ceil(1 / STEP);
const LOSS_GRACE_TICKS = Math.round(3 / STEP);
const FADE_TICKS = Math.round(2.4 / STEP);

const isTacticalGta = pursuit => pursuit?.gta?.config?.tacticalPursuit === "gta-tactical-v1";
const activeTacticalPatrol = unit => unit && unit.aiState !== "WRECKED" && (unit.health === undefined || unit.health > 0);

function nearestActivePatrolM(player, patrols) {
  let nearest = Infinity;
  for (const unit of patrols ?? []) {
    if (activeTacticalPatrol(unit)) nearest = Math.min(nearest, distance(player, unit));
  }
  return nearest;
}

export function isHiddenInBuildingCover(world, nearestPatrolM, distFromLastSeenM) {
  const { player, pursuit } = world;
  const response = pursuit?.response;
  if (!player || !response || (response.unitsInContact ?? 0) !== 0) return false;
  if (!(nearestPatrolM >= GTA_COVER_ESCAPE_M && distFromLastSeenM >= 32)) return false;
  if (Math.abs(player.speed ?? 0) > 5.5) return false;
  for (const unit of pursuit?.patrols ?? []) {
    if (!activeTacticalPatrol(unit)) continue;
    const dx = player.x - unit.x, dz = player.z - unit.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= 135 && gtaLineClear(world, unit, dx, dz, dist)) return false;
  }
  if (Boolean(player.curbSupportId)) return true;
  const candidates = world.staticIndex ? world.staticIndex.near(player, 28) : (world.statics ?? []);
  let nearBuildings = 0;
  for (const body of candidates) {
    if (body?.kind === "building" && distance(player, body) <= 26) nearBuildings++;
  }
  return nearBuildings >= 2;
}

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

function mobileNearbyTactical(patrols, player) {
  for (const unit of patrols ?? []) {
    if (activeTacticalPatrol(unit) && unit.aiState !== "ROADBLOCK" && unit.previous &&
        Math.abs(unit.speed) >= 3 && distance(unit, unit.previous) >= 3 * STEP - 1e-8 &&
        distance(unit, player) <= 110) return true;
  }
  return false;
}

export function updateDispatchTracking(world, initial) {
  const { player, pursuit, tick } = world, { response, gta } = pursuit;
  if (isTacticalGta(pursuit)) {
    const fair = gta.config.policeFairness === "city-fair-v1";
    if (fair) {
      for (const unit of response.sightedBy) {
        const dx = player.x - unit.x, dz = player.z - unit.z;
        const range = Math.hypot(dx, dz);
        const forward = dx * Math.sin(unit.heading) + dz * Math.cos(unit.heading);
        const right = dx * Math.cos(unit.heading) - dz * Math.sin(unit.heading);
        const touching = overlaps(unit, player, .05);
        const visible = range <= 105 && forward > 0 &&
          Math.abs(Math.atan2(right, forward)) <= 1.15;
        if (!(touching || visible) || !gtaLineClear(world, unit, dx, dz, range)) {
          response.sightedBy.delete(unit);
          response.closePatrols.delete(unit);
        }
      }
      response.unitsInContact = response.sightedBy.size;
    }
    const d = (response.dispatch ??= createDispatchResponse());
    const wasInSight = d.state === "VISUALLY_SPOTTED" || (!d.tactical && isDispatchTracked(response));
    const { x, z, heading, speed } = player;
    const zoneIds = [];
    for (const zone of gta.config.surveillanceZones ?? noZones)
      if (x >= zone.minX && x <= zone.maxX && z >= zone.minZ && z <= zone.maxZ)
        zoneIds.push(zone.id);
    d.tactical = true;
    d.zoneIds = zoneIds.length ? Object.freeze(zoneIds) : noZones;
    const nearestPatrolM = nearestActivePatrolM(player, pursuit.patrols);
    response.nearestPatrolM = Number.isFinite(nearestPatrolM) ? nearestPatrolM : null;
    d.nearestPatrolM = Number.isFinite(nearestPatrolM) ? Number(nearestPatrolM.toFixed(1)) : null;
    d.minEscapeDistanceM = GTA_OPEN_ESCAPE_BASE_M + 6 * Math.max(1, pursuit.wantedLevel);
    const inSight = (response.unitsInContact ?? 0) > 0;
    if (inSight) d.everSpotted = true;
    const patrolCount = pursuit.patrols?.size ?? pursuit.patrols?.length ?? 0;
    if (!d.escapeEligible && (initial || d.lastSampleTick !== tick)) {
      const consecutiveStep = !initial && (d.lastSampleTick === null || d.lastSampleTick === tick - 1);
      const qualifyingStep = consecutiveStep &&
        (inSight || (!fair && mobileNearbyTactical(pursuit.patrols, player)) || Boolean(d.everSpotted && patrolCount === 0));
      d.mobileTrackTicks = qualifyingStep ? (d.mobileTrackTicks ?? 0) + 1 : 0;
      d.escapeEligible = d.mobileTrackTicks >= ELIGIBLE_TICKS || Boolean(d.everSpotted && patrolCount === 0);
    }
    d.lastSampleTick = tick;
    if (inSight) {
      const sin = Math.sin(heading), cos = Math.cos(heading), slip = player.gtaSlipMps ?? 0;
      response.lastSeen = Object.freeze({
        x, z,
        vx: player.vx ?? (sin * speed + cos * slip),
        vz: player.vz ?? (cos * speed - sin * slip),
        speed,
        heading,
        roadId: player.roadId ?? player.road?.id ?? null,
        tick,
        lastSeenTick: tick,
      });
      d.lastReportTick = tick;
      d.state = "VISUALLY_SPOTTED";
      gta.lostTicks = 0;
      d.coolingDown = false;
      d.hiddenInCover = false;
      d.starDecayTicks = 0;
      d.starProgress = 0;
      d.nextStarDropS = null;
      d.cooldownInitialStars = 0;
      gta.fadeStars = pursuit.wantedLevel;
      response.stage = "contact";
      response.lostAtTick = response.clearAtTick = null;
      response.clearProgress = 0;
      const prox = Number.isFinite(nearestPatrolM) ? clamp(1 - nearestPatrolM / 105, 0, 1) : 0.5;
      response.strobeIntensity = clamp(0.56 + 0.32 * prox + 0.03 * pursuit.wantedLevel, 0.55, 1.0);
      return !initial && !wasInSight ? "reacquired" : null;
    }
    if (!initial) gta.lostTicks = (gta.lostTicks ?? 0) + 1;
    else gta.lostTicks ??= 0;
    response.lostAtTick ??= tick;
    if (!d.coolingDown) {
      d.state = gta.lostTicks < ticks(1.5) ? "LAST_KNOWN" : "SEARCHING";
      response.stage = "search";
      const prox = Number.isFinite(nearestPatrolM) ? clamp(1 - nearestPatrolM / 120, 0, 1) : 0.2;
      response.strobeIntensity = clamp(0.18 + 0.18 * prox, 0.16, 0.36);
    } else {
      response.stage = "clearing";
    }
    return wasInSight ? "contact-lost" : null;
  }
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
  if (isTacticalGta(pursuit)) {
    const dispatch = (response.dispatch ??= createDispatchResponse());
    dispatch.tactical = true;
    if (gta.config.policeFairness === "city-fair-v1" && !dispatch.everSpotted) {
      dispatch.coolingDown = false;
      dispatch.starDecayTicks = 0;
      response.clearProgress = 0;
      return false;
    }
    if ((response.unitsInContact ?? 0) > 0) return false;
    const nearestPatrolM = nearestActivePatrolM(player, pursuit.patrols);
    response.nearestPatrolM = Number.isFinite(nearestPatrolM) ? nearestPatrolM : null;
    const distFromLastSeenM = response.lastSeen ? distance(player, response.lastSeen) : Infinity;
    const minEscapeDistanceM = GTA_OPEN_ESCAPE_BASE_M + 6 * Math.max(1, pursuit.wantedLevel);
    const separatedOpenRoad = nearestPatrolM >= minEscapeDistanceM &&
      (distFromLastSeenM >= 48 || !Number.isFinite(nearestPatrolM));
    const hiddenInCover = isHiddenInBuildingCover(world, nearestPatrolM, distFromLastSeenM);
    const graceTicks = ticks(GTA_SEARCH_GRACE_S);
    dispatch.minEscapeDistanceM = minEscapeDistanceM;
    dispatch.nearestPatrolM = Number.isFinite(nearestPatrolM) ? Number(nearestPatrolM.toFixed(1)) : null;
    if ((gta.lostTicks ?? 0) < graceTicks || (!separatedOpenRoad && !hiddenInCover)) {
      dispatch.state = (gta.lostTicks ?? 0) < ticks(1.5) ? "LAST_KNOWN" : "SEARCHING";
      dispatch.coolingDown = false;
      dispatch.hiddenInCover = Boolean(hiddenInCover);
      dispatch.starDecayTicks = 0;
      dispatch.starProgress = 0;
      dispatch.nextStarDropS = null;
      response.stage = "search";
      response.clearProgress = 0;
      const prox = Number.isFinite(nearestPatrolM) ? clamp(1 - nearestPatrolM / 120, 0, 1) : 0.2;
      response.strobeIntensity = clamp(0.18 + 0.18 * prox, 0.16, 0.36);
      return false;
    }
    dispatch.state = "COOLING_DOWN";
    dispatch.coolingDown = true;
    dispatch.hiddenInCover = Boolean(hiddenInCover);
    response.stage = "clearing";
    const initialStars = Math.max(dispatch.cooldownInitialStars || pursuit.wantedLevel, pursuit.wantedLevel);
    dispatch.cooldownInitialStars = initialStars;
    const perStarTicks = ticks(hiddenInCover ? GTA_COVER_STAR_DECAY_S : GTA_STAR_DECAY_S);
    dispatch.starDecayTicks = (dispatch.starDecayTicks ?? 0) + 1;
    if (dispatch.starDecayTicks >= perStarTicks) {
      dispatch.starDecayTicks = 0;
      const previousStars = pursuit.wantedLevel;
      pursuit.wantedLevel = Math.max(0, pursuit.wantedLevel - 1);
      gta.fadeStars = pursuit.wantedLevel;
      if (pursuit.wantedLevel !== previousStars) {
        gta.heat = 0;
        pursuit.stepEvents?.push({
          type: "wanted_changed",
          tick: world.tick,
          wantedLevel: pursuit.wantedLevel,
          previousWantedLevel: previousStars,
          reason: hiddenInCover ? "hidden-cover-decay" : "los-distance-decay",
        });
      }
      if (pursuit.wantedLevel <= 0) {
        response.clearProgress = 1;
        response.strobeIntensity = 0;
        dispatch.starProgress = 1;
        dispatch.nextStarDropS = 0;
        return true;
      }
    }
    const starProgress = clamp(dispatch.starDecayTicks / perStarTicks, 0, 1);
    dispatch.starProgress = Number(starProgress.toFixed(3));
    dispatch.nextStarDropS = Number(((perStarTicks - dispatch.starDecayTicks) / 60).toFixed(1));
    const starsDroppedSoFar = Math.max(0, initialStars - pursuit.wantedLevel);
    response.clearProgress = clamp((starsDroppedSoFar + starProgress) / Math.max(1, initialStars), 0, 0.999);
    response.strobeIntensity = clamp(0.06 + 0.10 * (1 - response.clearProgress), 0.05, 0.16);
    return false;
  }
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
