import { clamp } from "../core/config.js";
import { angleDelta } from "../core/geometry.js";
import { gtaVelocity } from "../core/pursuit-gta.js";
import { requireDispatchScan } from "./pursuit-shield.js";

const fields = Object.freeze([
  "laneError", "heading", "yaw", "steer", "speed", "slip", "roadHalfWidth",
  "frontLeftClear", "frontCenterClear", "frontRightClear", "farSideClear",
  "leadDistance", "leadClosing", "leadKnown", "personDistance", "rearClosure", "rearTtc",
]);
export const PAKO_QUEUE_OBSERVATION = Object.freeze({
  version: "pako-queue-intent-v1", length: fields.length, researchOnly: true,
  source: "public lane intent, ego odometry and first-return scan",
  navigation: Object.freeze({ offset: 0, fields }),
});
const branchFields = Object.freeze([...fields, "branchSide", "branchApproach", "outboundRoom", "branchSpeed"]);
export const PAKO_QUEUE_BRANCH_OBSERVATION = Object.freeze({
  version: "pako-queue-branch-v1", length: branchFields.length, researchOnly: true,
  source: "public lane and branch intent, ego odometry and first-return scan",
  navigation: Object.freeze({ offset: 0, fields: branchFields }),
});

export function measureQueueIntent(world, intent) {
  const { player } = world;
  const { heading, targetLateral, center, halfWidth } = intent;
  if (![heading, targetLateral, center, halfWidth].every(Number.isFinite) || halfWidth <= player.width / 2)
    throw new Error("The queue route needs a finite public lane and direction");
  const scan = requireDispatchScan(world), { rays, tracks } = scan;
  const c = Math.cos(heading), s = Math.sin(heading);
  const lateral = player.x * c - player.z * s - center;
  const nearest = (kind, check) => tracks.find(track => track.kind === kind && track.ageS === 0 && check(track));
  const lead = nearest("civilian", track => track.forwardM > 0 && Math.abs(track.rightM) < 1.65);
  const rear = nearest("police", track => track.forwardM < 0);
  const person = nearest("pedestrian", track => track.forwardM > 0 && Math.abs(track.rightM) < 5.5);
  const unit = (x, scale) => clamp(x / scale, 0, 1), signed = (x, scale) => clamp(x / scale, -1, 1);
  const range = indices => unit(Math.min(...indices.map(i => rays[i].rangeM)), 18);
  const v = gtaVelocity(player);
  return Float32Array.of(
    signed(targetLateral - lateral, 8), signed(angleDelta(player.heading, heading), 1.4),
    signed(player.gtaYawRate, 3), signed(player.steer, player.spec.maxSteer),
    signed(Math.hypot(v.x, v.z) * Math.sign(player.speed), 10), signed(player.gtaSlipMps, 4), unit(halfWidth, 10),
    range([63, 65, 67, 69]), range([71, 0, 1]), range([3, 5, 7, 9]), range([10, 13, 16]),
    lead ? unit(lead.forwardM, 20) : 1, lead?.motionKnown ? signed(-lead.forwardMps, 9) : 0, Number(lead?.motionKnown ?? false),
    person ? unit(Math.hypot(person.rightM, person.forwardM), 20) : 1,
    rear?.motionKnown ? signed(rear.forwardMps, 10) : 0, rear?.ttcS == null ? 1 : unit(rear.ttcS, 6),
  );
}

export function measureQueueBranchIntent(world, intent, { approachM, roomM, turn }) {
  if (!Number.isFinite(approachM) || !Number.isFinite(roomM) || ![-1, 1].includes(turn))
    throw new TypeError("The connected queue route needs finite public branch geometry");
  return Float32Array.of(...measureQueueIntent(world, intent), turn, Math.tanh(approachM / 15),
    clamp(roomM / 120, 0, 1), clamp(world.player.speed / 24, -1, 1));
}
