import { MathUtils, Vector3 } from "three";

const WALL_PAD_M = 0.43;
const HEIGHT_PAD_M = 0.28;
const STOP_SHORT_M = 0.08;
// SpatialIndex tests centers; the largest City v4 half-diagonal is 13.73 m.
const CITY_FOOTPRINT_MARGIN_M = 16;
const TETHER_HEIGHT_M = 2.15;

function sweepFraction(from, to, sites) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  let first = Infinity;
  for (const site of sites) {
    if (!(site.width > 0 && site.length > 0) || site.kind === "place-sign") continue;
    const c = Math.cos(site.heading ?? 0), s = Math.sin(site.heading ?? 0);
    const x = from.x - site.x, z = from.z - site.z;
    const lowY = (site.y ?? 0.12) - HEIGHT_PAD_M;
    const highY = lowY + (site.height ?? Infinity) + HEIGHT_PAD_M * 2;
    let enter = 0, exit = Math.min(1, first);
    for (let axis = 0; axis < 3; axis++) {
      const start = axis === 0 ? x * c - z * s : axis === 1 ? x * s + z * c : from.y;
      const delta = axis === 0 ? dx * c - dz * s : axis === 1 ? dx * s + dz * c : dy;
      const half = (axis === 0 ? site.width : site.length) / 2 + WALL_PAD_M;
      const low = axis === 2 ? lowY : -half, high = axis === 2 ? highY : half;
      if (Math.abs(delta) < 1e-8) {
        if (start >= low && start <= high) continue;
        exit = -1;
        break;
      }
      const a = (low - start) / delta, b = (high - start) / delta;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) break;
    }
    if (enter <= exit) first = enter;
  }
  return first === Infinity ? 1 : Math.max(0, first - STOP_SHORT_M / Math.hypot(dx, dy, dz));
}

/** Drive the display camera only; the rendered car and mounted RGB stay put. */
export function createPursuitCamera() {
  const pivot = new Vector3(), ideal = new Vector3(), target = new Vector3();
  const eye = new Vector3(), proposal = new Vector3(), lastClearPivot = new Vector3();
  const aim = new Vector3(), forwardAim = new Vector3();
  const cabin = new Vector3(), lifted = new Vector3();
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  let initialized = false, packMode = false, room = 0, stretch = 0, avenue = 0, bearing = 0, reviewMix = 0;

  function update(camera, {
    position, heading, speedMps, streetWidthM, staticIndex, deltaS, snap,
    pack = false, packLab = false, impactReview = false, trailingVehicles = null,
  }) {
    const reset = snap || !initialized || pack !== packMode;
    packMode = pack;
    const dt = MathUtils.clamp(deltaS || 0, 0, 0.1);
    const reviewTarget = impactReview && !reducedMotion?.matches ? 1 : 0;
    reviewMix = reset ? reviewTarget : MathUtils.damp(reviewMix, reviewTarget, 8, dt);
    if (Math.abs(reviewMix - reviewTarget) < 0.001) reviewMix = reviewTarget;
    const frameEase = reset ? 1 : 1 - Math.exp(-(pack ? 3.2 : 7) * dt);
    const width = streetWidthM || 0;
    const open = MathUtils.smoothstep(width, 5, 12.5);
    const wide = MathUtils.smoothstep(width, 8.6, 12.5);
    const pace = MathUtils.smoothstep(speedMps || 0, 2.4, 11.5);
    room = MathUtils.lerp(room, open, frameEase);
    avenue = MathUtils.lerp(avenue, wide, frameEase);
    stretch = MathUtils.lerp(stretch, MathUtils.lerp(0.6 * wide, open, pace), frameEase);
    const turn = heading - bearing;
    bearing = reset ? heading : bearing + Math.atan2(Math.sin(turn), Math.cos(turn)) * frameEase;
    const sin = Math.sin(bearing), cos = Math.cos(bearing);
    let back = pack ? 13.5 + 2.1 * stretch : 9.2 + 7.55 * stretch + avenue * (0.6 + 4 * stretch);
    let shoulder = pack ? 1.4 + 1.25 * room : room * (0.25 + 1.97 * stretch) - 0.4 * avenue * stretch;
    const aspect = camera.aspect || 1.25;
    const labFraming = pack && packLab;
    const narrowScreen = pack ? MathUtils.clamp((labFraming ? 1.57 : 1.25) / aspect, 1, 1.27) : 1;
    let rise = pack ? (31 + 1.8 * stretch) * narrowScreen : 3.8 + 1.9 * stretch;
    // The full junction needs room below the nav and left of the drill card.
    if (labFraming) rise += 10.5 * narrowScreen;
    if (reviewMix) {
      // Front quarter, looking across the bumper rather than down through the roof.
      const reviewHeightScale = MathUtils.clamp(1.1 / (camera.aspect || 1.1), 1, 1.6);
      back = MathUtils.lerp(back, -2.6, reviewMix);
      shoulder = MathUtils.lerp(shoulder, 5.6, reviewMix);
      rise = MathUtils.lerp(rise, 7.8 * reviewHeightScale, reviewMix);
    }
    pivot.copy(position);
    pivot.y += TETHER_HEIGHT_M;
    ideal.set(position.x - back * sin + shoulder * cos, position.y + rise,
      position.z - back * cos - shoulder * sin);

    const boomReach = reviewMix ? Math.hypot(back, shoulder) : back + shoulder;
    const reach = reset ? boomReach : Math.max(boomReach,
      Math.hypot(eye.x - pivot.x, eye.z - pivot.z),
      Math.hypot(lastClearPivot.x - pivot.x, lastClearPivot.z - pivot.z));
    const sites = staticIndex?.near(pivot, reach + CITY_FOOTPRINT_MARGIN_M) ?? [];
    if (trailingVehicles && !impactReview) {
      const blockers = [];
      for (const body of trailingVehicles) {
        const dx = body.x - position.x, dz = body.z - position.z;
        if (body.height >= 1.7 && dx * sin + dz * cos < 0 && dx * dx + dz * dz < 18 ** 2)
          blockers.push(body);
      }
      if (blockers.length) {
        cabin.set(position.x, position.y + 1.26, position.z);
        const ordinary = sweepFraction(pivot, ideal, sites);
        proposal.lerpVectors(pivot, ideal, ordinary);
        if (sweepFraction(cabin, proposal, blockers) < 1) {
          for (const [shorten, lift] of [[.64, 3.2], [.49, 4], [.36, 4.7]]) {
            lifted.set(position.x - back * shorten * sin + shoulder * cos,
              ideal.y + lift, position.z - back * shorten * cos - shoulder * sin);
            if (sweepFraction(pivot, lifted, sites) !== 1 || sweepFraction(cabin, lifted, blockers) !== 1) continue;
            ideal.copy(lifted);
            break;
          }
        }
      }
    }
    let tether = sweepFraction(pivot, ideal, sites);
    if ((pack || reviewMix) && tether < 1) {
      // Shorten the boom horizontally before dropping into the street.
      // This keeps the SUV's surroundings in frame beside tall walls.
      proposal.set(pivot.x, ideal.y, pivot.z);
      if (sweepFraction(pivot, proposal, sites) === 1) {
        let clear = 0, blocked = 1;
        for (let i = 0; i < 5; i++) {
          const middle = (clear + blocked) / 2;
          proposal.x = MathUtils.lerp(pivot.x, ideal.x, middle);
          proposal.z = MathUtils.lerp(pivot.z, ideal.z, middle);
          if (sweepFraction(pivot, proposal, sites) === 1) clear = middle;
          else blocked = middle;
        }
        ideal.x = MathUtils.lerp(pivot.x, ideal.x, clear);
        ideal.z = MathUtils.lerp(pivot.z, ideal.z, clear);
        tether = 1;
      }
    }
    target.lerpVectors(pivot, ideal, tether);
    if (reset) {
      eye.copy(target);
      initialized = true;
    } else {
      const followEase = 1 - Math.exp(-(pack ? 7.5 : 11) * dt);
      proposal.copy(eye).lerp(target, followEase);
      const travel = sweepFraction(eye, proposal, sites);
      if (travel === 1 && sweepFraction(pivot, proposal, sites) === 1) {
        eye.copy(proposal);
      } else {
        // Go back along the visible side of the corner first. Re-clamping
        // the new pose from the car alone could cut straight through the wall.
        const retract = sweepFraction(eye, pivot, sites) === 1 ? pivot : lastClearPivot;
        const retractEase = reviewMix
          ? Math.min(followEase, 26 * dt / Math.max(0.01, eye.distanceTo(retract))) : 1 - Math.exp(-19 * dt);
        proposal.copy(eye).lerp(retract, retractEase);
        const retreat = sweepFraction(eye, proposal, sites);
        if (retreat > 0) eye.lerp(proposal, retreat);
        else if (travel > 0) eye.lerp(target, followEase * travel);
      }
    }
    if (reset || sweepFraction(pivot, eye, sites) === 1) lastClearPivot.copy(pivot);

    // Keep the avenue foreground in the composition, but not when the
    // physical eye is still retracted near the car after a corner.
    const eyeBack = (position.x - eye.x) * sin + (position.z - eye.z) * cos;
    const foreground = avenue * (0.7 + 5.25 * stretch) * MathUtils.smoothstep(eyeBack, 5, back * 0.9);
    const wideLead = pack ? (labFraming ? 0.4 : -3.4 + 0.9 * pace) : 4.1 - 4.65 * stretch - foreground;
    const visibility = MathUtils.smoothstep(tether, 0.15, 0.8);
    const lead = MathUtils.lerp(wideLead, 1.25, reviewMix) * visibility;
    const sideLead = labFraming ? -3.2 * (1 - reviewMix) * visibility : 0;
    aim.set(position.x, position.y + MathUtils.lerp(1.12, 0.65, reviewMix), position.z);
    forwardAim.set(aim.x + lead * sin + sideLead * cos, aim.y, aim.z + lead * cos - sideLead * sin);
    if ((lead || sideLead) && sweepFraction(eye, forwardAim, sites) !== 1) {
      // Bring the aim toward the car if the preferred look point is blocked.
      let low = 0, high = 1;
      for (let i = 0; i < 4; i++) {
        const middle = (low + high) / 2;
        proposal.lerpVectors(aim, forwardAim, middle);
        if (sweepFraction(eye, proposal, sites) === 1) low = middle;
        else high = middle;
      }
      forwardAim.lerp(aim, 1 - low);
    }
    camera.position.copy(eye);
    camera.lookAt(forwardAim);
  }

  return { update };
}
