import { overlaps, roadRect } from "./geometry.js";
import { PLACES } from "./places.js";

// These footprints are shared by physics and rendering. Model loading never
// changes them, and imported meshes are fitted inside their declared bounds.
export function cityFootprints(roads) {
  const exclusions = roads.map((road, i) => {
    const r = roadRect(road, -2.7);
    return {
      id: `road-${i}`,
      x: (r.minX + r.maxX) / 2,
      z: (r.minZ + r.maxZ) / 2,
      width: r.maxX - r.minX,
      length: r.maxZ - r.minZ,
      heading: 0,
    };
  });
  const sites = [];
  for (let x = -91; x < 100; x += 5)
    for (let z = -91; z < 100; z += 5) {
      const site = {
        id: `building-${sites.length}`,
        type: "static",
        kind: "building",
        x,
        z,
        width: 8,
        length: 8,
        heading: 0,
        height: 10 + (sites.length % 4) * 3,
      };
      if (
        !exclusions.some((road) => overlaps(site, road)) &&
        !sites.some((other) => overlaps(site, other, 1.5))
      )
        sites.push(site);
    }
  // The market frontage has room between the building plots and the curb.
  // Stalls are part of the same collision map as buildings, not decoration
  // that pedestrians can walk through after the model finishes loading.
  for (const x of [-86, -76, -66, -56]) {
    const stall = {
      id: `market-stall-${x}`,
      type: "static",
      kind: "market-stall",
      x,
      z: 10.5,
      width: 2.5,
      length: 1.7,
      heading: 0,
      height: 2.3,
    };
    if (
      !exclusions.some((road) => overlaps(stall, road, 0.3)) &&
      !sites.some((site) => overlaps(stall, site, 0.4))
    )
      sites.push(stall);
  }
  for (const place of PLACES) {
    const road = roads.find(
      (candidate) =>
        candidate.axis === "x" &&
        candidate.fixed === place.z &&
        candidate.min <= place.x &&
        candidate.max >= place.x &&
        !candidate.parkingBay,
    );
    if (!road) throw new Error(`No sign road for ${place.id}`);
    const base = Math.max(road.min + 6, Math.min(road.max - 6, place.x + 7));
    let placed = false;
    for (const setback of [3.2, 10]) {
      for (const side of [1, -1]) {
        for (const shift of [0, -7, 7, -14, 14]) {
          const post = {
            id: `place-sign-${place.id}`,
            type: "static",
            kind: "place-sign",
            placeId: place.id,
            x: Math.max(road.min + 6, Math.min(road.max - 6, base + shift)),
            z: road.fixed + side * (road.width / 2 + setback),
            width: 0.28,
            length: 0.28,
            heading: 0,
            height: 3.8,
            facingY: side > 0 ? (3 * Math.PI) / 4 : -Math.PI / 4,
          };
          if (
            exclusions.some((exclusion) => overlaps(post, exclusion, 0.1)) ||
            sites.some((site) => overlaps(post, site, 0.3))
          )
            continue;
          sites.push(post);
          placed = true;
          break;
        }
        if (placed) break;
      }
      if (placed) break;
    }
    if (!placed) throw new Error(`No clear sign post for ${place.id}`);
  }
  return sites;
}
