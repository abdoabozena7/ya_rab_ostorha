import { MathUtils, Vector3 } from "three";

const WALL_PAD_M = 0.43;
const HEIGHT_PAD_M = 0.28;
const STOP_SHORT_M = 0.08;
// SpatialIndex tests centers; Grand City v5 54 m × 36 m buildings have half-diagonal ~32.5 m.
const CITY_FOOTPRINT_MARGIN_M = 44;
const TETHER_HEIGHT_M = 2.15;
const FOLLOW_BUMPER_OFFSET_M = 2.0;

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
  let lastHeading = 0, turnRate = 0, yawLead = 0, chasingFovActive = false, baseFov = 62;
  let lastStreetWidth = 0, smoothedSpeed = 0, smoothedY = 0;
  let followMix = 0, chasingMix = 0, cityChaseMix = 0;
  let smoothedVisibility = 1, aimScale = 1, smoothedLead = 0, smoothedSideLead = 0;

  function update(camera, {
    position, heading, speedMps, streetWidthM, staticIndex, deltaS, snap,
    pack = false, packLab = false, cityChase = false, impactReview = false,
    trailingVehicles = null, cameraStyle = "auto",
  }) {
    const reset = snap || !initialized || pack !== packMode;
    packMode = pack;
    const isFollow = !pack && cameraStyle === "follow";
    const isChasing = !pack && cameraStyle === "chasing";
    const isCityChase = !pack && !isFollow && !isChasing && Boolean(cityChase);
    const dt = MathUtils.clamp(deltaS || 0, 0, 0.1);
    const styleEase = reset ? 1 : 1 - Math.exp(-6 * dt);
    followMix = MathUtils.lerp(followMix, isFollow ? 1 : 0, styleEase);
    chasingMix = MathUtils.lerp(chasingMix, isChasing ? 1 : 0, styleEase);
    cityChaseMix = MathUtils.lerp(cityChaseMix, isCityChase ? 1 : 0, styleEase);
    const autoMix = Math.max(0, 1 - followMix - chasingMix - cityChaseMix);
    const reviewTarget = impactReview && !reducedMotion?.matches ? 1 : 0;
    reviewMix = reset ? reviewTarget : MathUtils.damp(reviewMix, reviewTarget, 8, dt);
    if (Math.abs(reviewMix - reviewTarget) < 0.001) reviewMix = reviewTarget;
    const frameEase = reset ? 1 : 1 - Math.exp(-(pack ? 3.2 : 7) * dt);
    const width = streetWidthM > 0 ? (lastStreetWidth = streetWidthM) : (reset ? 0 : lastStreetWidth);
    const rawSpeed = Number.isFinite(speedMps) ? Math.abs(speedMps) : 0;
    smoothedSpeed = reset ? rawSpeed : MathUtils.damp(smoothedSpeed, rawSpeed, 9, dt);
    smoothedY = reset ? position.y : MathUtils.damp(smoothedY, position.y, 14, dt);
    const open = MathUtils.smoothstep(width, 5, 12.5);
    const wide = MathUtils.smoothstep(width, 8.6, 12.5);
    const pace = MathUtils.smoothstep(smoothedSpeed, 2.4, 11.5);
    room = MathUtils.lerp(room, open, frameEase);
    avenue = MathUtils.lerp(avenue, wide, frameEase);
    stretch = MathUtils.lerp(stretch, MathUtils.lerp(0.6 * wide, open, pace), frameEase);
    const headingStep = reset ? 0 : Math.atan2(Math.sin(heading - lastHeading), Math.cos(heading - lastHeading));
    lastHeading = heading;
    const rawTurnRate = dt > 1e-5 ? MathUtils.clamp(headingStep / dt, -2.5, 2.5) : 0;
    turnRate = reset ? 0 : MathUtils.damp(turnRate, rawTurnRate, 11, dt);
    yawLead = reset ? 0 : MathUtils.damp(yawLead, turnRate * (0.10 + 0.08 * pace) * chasingMix, 6, dt);
    const turn = heading - bearing;
    bearing = reset ? heading : bearing + Math.atan2(Math.sin(turn), Math.cos(turn)) * frameEase;
    const camYaw = bearing + yawLead * 0.35 * chasingMix;
    const sin = Math.sin(camYaw), cos = Math.cos(camYaw);
    const followBack = 8.4 + 2.4 * stretch;
    const chasingBack = 12.2 + 6.8 * stretch + avenue * (0.8 + 2.8 * stretch);
    const cityChaseBack = 11.8 + 6.4 * stretch + avenue * (0.6 + 3.2 * stretch);
    const autoBack = 9.2 + 7.55 * stretch + avenue * (0.6 + 4 * stretch);
    let back = pack ? 13.5 + 2.1 * stretch
      : followBack * followMix + chasingBack * chasingMix + cityChaseBack * cityChaseMix + autoBack * autoMix;
    const chasingShoulder = room * (0.35 + 1.4 * stretch);
    const autoShoulder = room * (0.25 + 1.97 * stretch) - 0.4 * avenue * stretch;
    let shoulder = pack ? 1.4 + 1.25 * room
      : chasingShoulder * chasingMix + autoShoulder * (cityChaseMix + autoMix);
    const aspect = camera.aspect || 1.25;
    const labFraming = pack && packLab;
    const narrowScreen = pack ? MathUtils.clamp((labFraming ? 1.57 : 1.25) / aspect, 1, 1.27) : 1;
    const followRise = 3.25 + 0.85 * stretch;
    const chasingRise = 5.8 + 2.4 * stretch;
    const cityChaseRise = 6.2 + 2.3 * stretch;
    const autoRise = 3.8 + 1.9 * stretch;
    let rise = pack ? (31 + 1.8 * stretch) * narrowScreen
      : followRise * followMix + chasingRise * chasingMix + cityChaseRise * cityChaseMix + autoRise * autoMix;
    // The full junction needs room below the nav and left of the drill card.
    if (labFraming) rise += 10.5 * narrowScreen;
    if (reviewMix) {
      // Front quarter, looking across the bumper rather than down through the roof.
      const reviewHeightScale = MathUtils.clamp(1.1 / (camera.aspect || 1.1), 1, 1.6);
      back = MathUtils.lerp(back, -2.6, reviewMix);
      shoulder = MathUtils.lerp(shoulder, 5.6, reviewMix);
      rise = MathUtils.lerp(rise, 7.8 * reviewHeightScale, reviewMix);
    }
    pivot.set(position.x, smoothedY + TETHER_HEIGHT_M, position.z);
    ideal.set(position.x - back * sin + shoulder * cos, smoothedY + rise,
      position.z - back * cos - shoulder * sin);

    const boomReach = reviewMix ? Math.hypot(back, shoulder) : Math.abs(back) + Math.abs(shoulder);
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
        cabin.set(position.x, smoothedY + 1.26, position.z);
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

    if (isChasing && camera.isPerspectiveCamera) {
      if (!chasingFovActive) {
        baseFov = camera.fov || 62;
        chasingFovActive = true;
      }
      const fovPace = MathUtils.smoothstep(smoothedSpeed, 1.5, 12.0);
      const targetFov = 62 + 6 * fovPace;
      const nextFov = reset ? targetFov : MathUtils.damp(camera.fov, targetFov, 6.5, dt);
      if (Math.abs(camera.fov - nextFov) > 1e-4) {
        camera.fov = nextFov;
        camera.updateProjectionMatrix();
      }
    } else if (chasingFovActive && camera.isPerspectiveCamera) {
      const nextFov = reset ? baseFov : MathUtils.damp(camera.fov, baseFov, 8, dt);
      if (Math.abs(nextFov - baseFov) < 0.01) {
        camera.fov = baseFov;
        camera.updateProjectionMatrix();
        chasingFovActive = false;
      } else if (Math.abs(camera.fov - nextFov) > 1e-4) {
        camera.fov = nextFov;
        camera.updateProjectionMatrix();
      }
    }

    // Keep the avenue foreground in the composition, but not when the
    // physical eye is still retracted near the car after a corner.
    const eyeBack = (position.x - eye.x) * sin + (position.z - eye.z) * cos;
    const foreground = avenue * (0.7 + 5.25 * stretch) * MathUtils.smoothstep(eyeBack, 5, back * 0.9);
    const followWideLead = FOLLOW_BUMPER_OFFSET_M + 4.8;
    const chasingWideLead = 3.6 - 3.8 * stretch - foreground * 0.65;
    const autoWideLead = 4.1 - 4.65 * stretch - foreground;
    const wideLead = pack ? (labFraming ? 0.4 : -3.4 + 0.9 * pace)
      : followWideLead * followMix + chasingWideLead * chasingMix + autoWideLead * (cityChaseMix + autoMix);
    const rawVisibility = MathUtils.smoothstep(tether, 0.15, 0.8);
    smoothedVisibility = reset ? rawVisibility : MathUtils.damp(smoothedVisibility, rawVisibility, 9, dt);
    const desiredLead = MathUtils.lerp(wideLead, 1.25, reviewMix) * smoothedVisibility;
    const desiredSideLead = labFraming ? -3.2 * (1 - reviewMix) * smoothedVisibility
      : yawLead * 4.0 * chasingMix * (1 - reviewMix) * smoothedVisibility;
    smoothedLead = reset ? desiredLead : MathUtils.damp(smoothedLead, desiredLead, 9, dt);
    smoothedSideLead = reset ? desiredSideLead : MathUtils.damp(smoothedSideLead, desiredSideLead, 9, dt);
    aim.set(position.x, smoothedY + MathUtils.lerp(1.12, 0.65, reviewMix), position.z);
    forwardAim.set(
      aim.x + smoothedLead * sin + smoothedSideLead * cos,
      aim.y,
      aim.z + smoothedLead * cos - smoothedSideLead * sin,
    );
    let targetAimScale = 1;
    if ((smoothedLead || smoothedSideLead) && sweepFraction(eye, forwardAim, sites) !== 1) {
      // Bring the aim toward the car if the preferred look point is blocked.
      let low = 0, high = 1;
      for (let i = 0; i < 4; i++) {
        const middle = (low + high) / 2;
        proposal.lerpVectors(aim, forwardAim, middle);
        if (sweepFraction(eye, proposal, sites) === 1) low = middle;
        else high = middle;
      }
      targetAimScale = low;
    }
    aimScale = reset
      ? targetAimScale
      : targetAimScale < aimScale
        ? targetAimScale
        : MathUtils.damp(aimScale, targetAimScale, 7.5, dt);
    if (aimScale < 1) {
      forwardAim.lerp(aim, 1 - aimScale);
    }
    camera.position.copy(eye);
    camera.lookAt(forwardAim);
  }

  return { update };
}
