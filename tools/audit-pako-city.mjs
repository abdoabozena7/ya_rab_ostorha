import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { World } from "../src/core/world.js";
import { DEFAULT_SURVEILLANCE_ZONES } from "../src/core/pursuit-dispatch.js";
import { bodyOnRoad, overlaps } from "../src/core/geometry.js";

const city = new World({ cityVersion: 4, seed: "pako-public-map-audit" }, "metro");
const { graph, drivingRoads, player, statics } = city;

function components(excluded = null) {
  const seen = new Set([excluded]), groups = [];
  for (const root of graph.keys()) {
    if (seen.has(root)) continue;
    const group = [root];
    groups.push(group);
    seen.add(root);
    for (let i = 0; i < group.length; i++) {
      for (const edge of graph.get(group[i]).edges) {
        if (seen.has(edge)) continue;
        seen.add(edge);
        group.push(edge);
      }
    }
  }
  return groups;
}

const connected = components();
const degree = {};
const outsideZones = node => !DEFAULT_SURVEILLANCE_ZONES.some(zone =>
  node.x >= zone.minX && node.x <= zone.maxX && node.z >= zone.minZ && node.z <= zone.maxZ);
const nodes = [...graph.values()];
const outside = nodes.filter(outsideZones);
for (const node of nodes) degree[node.edges.length] = (degree[node.edges.length] ?? 0) + 1;
const junctionSplits = nodes.filter(node => node.edges.length > 2).map(node => ({
  key: node.key, componentSizesAfterRemoval: components(node.key).map(group => group.length),
})).filter(result => result.componentSizesAfterRemoval.length > connected.length);
const alignmentTests = drivingRoads.flatMap(road => {
  const out = [];
  for (let d = road.min + 2; d < road.max - 2; d += 4) {
    const pose = { ...player, x: road.axis === "x" ? d : road.fixed, z: road.axis === "x" ? road.fixed : d,
      heading: road.axis === "x" ? Math.PI / 2 : 0 };
    out.push({ roadId: road.id, widthM: road.width, supported: bodyOnRoad(pose, drivingRoads) &&
      !statics.some(solid => overlaps(pose, solid, .12)) });
  }
  return out;
});
const report = {
  profile: "metro-v4", roadCount: drivingRoads.length, nodes: graph.size, degree,
  componentSizes: connected.map(group => group.length), junctionSplits, outsideZoneNodes: outside.length,
  connectedOutsideZoneNodes: connected.map(group => group.filter(key => outsideZones(graph.get(key))).length),
  builtWidthM: player.width, footprintSamples: alignmentTests.length,
  rejectedCenterlineSamples: alignmentTests.filter(entry => !entry.supported),
  population: city.capacity, limitations: "Static centerline and aligned footprint only. Not proof of turning clearance, visible escape, or traffic capacity.",
};
if (process.env.PROVE_IT_OUTPUT_DIR)
  writeFileSync(join(process.env.PROVE_IT_OUTPUT_DIR, "city-graph.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
