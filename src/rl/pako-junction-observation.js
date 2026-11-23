import { clamp } from "../core/config.js";
import { angleDelta } from "../core/geometry.js";
import { requireDispatchScan } from "./pursuit-shield.js";

const fields = Object.freeze([
  "approachM", "exitM", "entrySideM", "exitSideM", "turnSin", "turnCos",
  "speed", "steer", "yaw", "slip", "frontRange", "turnSideRange",
  "rearClosure", "rearTtc", "personForward", "personRange",
]);
export const PAKO_JUNCTION_OBSERVATION = Object.freeze({
  version: "pako-junction-intent-v1", length: fields.length, researchOnly: true,
  source: "public Metro road geometry, ego odometry and first-return scan",
  navigation: Object.freeze({ offset: 0, fields }),
});

const routes = new WeakMap();

export function measureJunctionIntent(world) {
  const { player: ego, pursuit, drivingRoads } = world;
  const scan = requireDispatchScan(world);
  let route = routes.get(pursuit);
  if (!route) {
    const goal = pursuit.gta.publicRouteGoal;
    const out = drivingRoads.find(road => road.id === goal?.roadId);
    if (!out || !goal || !Number.isFinite(goal[out.axis])) throw new Error("Select a connected public junction route");
    const headings = [{ axis: "z", dir: 1, angle: 0 }, { axis: "x", dir: 1, angle: Math.PI / 2 },
      { axis: "z", dir: -1, angle: Math.PI }, { axis: "x", dir: -1, angle: -Math.PI / 2 }];
    const heading = headings.find(item => Math.abs(angleDelta(ego.heading, item.angle)) < Math.PI / 4);
    if (!heading || heading.axis === out.axis) throw new Error("A junction course must start on the approaching road");
    const incoming = drivingRoads.filter(road => road.axis === heading.axis &&
      ego[heading.axis] >= road.min && ego[heading.axis] <= road.max &&
      out.fixed >= road.min && out.fixed <= road.max &&
      road.fixed >= out.min && road.fixed <= out.max &&
      Math.abs(ego[out.axis] - road.fixed) <= road.width / 2 &&
      (out.fixed - ego[heading.axis]) * heading.dir > 0);
    incoming.sort((a, b) => Math.abs(ego[out.axis] - a.fixed) - Math.abs(ego[out.axis] - b.fixed));
    const entry = incoming[0];
    if (!entry) throw new Error("No registered approach ahead of the vehicle");
    const exitDir = Math.sign(goal[out.axis] - entry.fixed);
    if (!exitDir) throw new Error("The destination does not continue beyond this junction");
    const headingOut = headings.find(item => item.axis === out.axis && item.dir === exitDir).angle;
    route = { entry, out, heading, exitDir, side: Math.sign(angleDelta(headingOut, heading.angle)) };
    routes.set(pursuit, route);
  }
  const { entry, out, heading, exitDir, side } = route;
  const long = (ego[entry.axis] - out.fixed) * heading.dir;
  const lateral = (ego[out.axis] - entry.fixed) * exitDir;
  const turn = angleDelta(ego.heading, heading.angle) * side;
  const rear = scan.tracks.find(track => track.kind === "police" && track.forwardM < 0 &&
    track.ageS === 0 && track.motionKnown);
  const person = scan.tracks.find(track => track.kind === "pedestrian" && track.forwardM >= 0 && track.ageS === 0);
  const signed = value => clamp(value, -1, 1);
  return {
    side,
    observation: Float32Array.of(signed(long / 12), signed(lateral / 28),
      signed((lateral - entry.laneOffsetM) / 8), signed((long + out.laneOffsetM) / 8),
      Math.sin(turn), Math.cos(turn), signed(ego.speed / 16),
      signed(ego.steer * side / ego.spec.maxSteer), signed(ego.gtaYawRate * side / 3),
      signed(ego.gtaSlipMps * side / 6), scan.rays[0].rangeM / 48,
      scan.rays[side > 0 ? 18 : 54].rangeM / 48,
      rear ? signed(rear.forwardMps / 10) : 0, rear?.ttcS == null ? 1 : clamp(rear.ttcS / 6, 0, 1),
      person ? signed(person.forwardM / 24) : 1,
      person ? clamp(Math.hypot(person.rightM, person.forwardM) / 24, 0, 1) : 1),
  };
}
