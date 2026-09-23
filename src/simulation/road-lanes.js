// Shared geometry for the street scene, routing and safety checks.
// Center lines use 10 m increments so A* nodes meet at intersections.
const INNER_X = [-100, -70, -20, 20, 50, 100];
const INNER_Z = [-100, -60, -20, 20, 70, 100];

export function roadLayout(extent = 100) {
  const outer = [];
  for (let n = 140; n <= extent; n += 40) outer.push(-n, n);
  const xs = [...new Set([...INNER_X, ...outer])].sort((a, b) => a - b);
  const zs = [...new Set([...INNER_Z, ...outer])].sort((a, b) => a - b);
  const roads = [
    ...xs.flatMap(x => (x === -70
      ? [{min:-extent,max:-20},{min:20,max:extent}]
      : [{min:-extent,max:extent}]).map(span =>
      ({axis:'z',fixed:x,width:x===-70?8:10,...span}))),
    ...zs.flatMap(z => (z === -60
      ? [{min:-extent,max:-20},{min:20,max:extent}]
      : z === 70
        ? [{min:-extent,max:20},{min:50,max:extent}]
        : [{min:-extent,max:extent}]).map(span =>
      ({axis:'x',fixed:z,width:z===70?8:10,...span}))),
  ];
  if (extent >= 100) roads.push(
    { axis: 'x', fixed: -80, min: -100, max: -20, width: 8, sideStreet: true },
    { axis: 'x', fixed: 40, min: 20, max: 100, width: 8, sideStreet: true },
    { axis: 'z', fixed: -40, min: -60, max: 20, width: 8, sideStreet: true },
  );
  return { xs, zs, roads };
}

function nearestOnRoad(x, z, extent, halfWidth) {
  let best = null;
  for (const road of roadLayout(extent).roads) {
    const px = road.axis === 'z' ? road.fixed : Math.max(road.min, Math.min(road.max, x));
    const pz = road.axis === 'x' ? road.fixed : Math.max(road.min, Math.min(road.max, z));
    const distance = Math.hypot(px - x, pz - z);
    const edge = distance - Math.min(halfWidth, road.width / 2 - 0.2);
    if (!best || edge < best.edge) best = { x: px, z: pz, distance, edge, road };
  }
  return best;
}

export function isOnRoad(x, z, extent, halfWidth = 4) {
  if (Math.abs(x) > extent || Math.abs(z) > extent) return false;
  return nearestOnRoad(x, z, extent, halfWidth)?.edge <= 0;
}

export function constrainToRoad(x, z, extent, halfWidth = 3.8) {
  const px = Math.max(-extent, Math.min(extent, x));
  const pz = Math.max(-extent, Math.min(extent, z));
  const nearest = nearestOnRoad(px, pz, extent, halfWidth);
  if (nearest.edge <= 0) return { x: px, z: pz };
  const { road } = nearest;
  const margin = Math.min(halfWidth, road.width / 2 - 0.2);
  if (road.axis === 'z') return { x: road.fixed + Math.sign(px - road.fixed) * margin, z: nearest.z };
  return { x: nearest.x, z: road.fixed + Math.sign(pz - road.fixed) * margin };
}
