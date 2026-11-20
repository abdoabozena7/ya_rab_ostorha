import * as THREE from "three";
import { VEHICLE } from "../core/config.js";

const STREET_PAINT = [0x788f98, 0x9b5140, 0xb9b5a2, 0x48677f, 0x8c7358, 0x66796b];
const TAXI_PAINT = [0xddd0ac, 0xd5c49e, 0xe4dbba];
const TUK_PAINT = [0xbb9142, 0x547868, 0x974d38];
const RUBBER = 0x292c2c, TRIM = 0x3e4543, GLASS = 0x3d5359;
const LAMP = 0xf1e3be, AMBER = 0xcd8a37, TAIL = 0xb94335;

// Each profile sets its own waist, overhangs and greenhouse, even on the
// identical sedan-sized hulls used for four-wheel traffic. Coordinates are
// fractions of the registered width, visual height and registered length.
const SHAPES = {
  sedan: {
    height: 1.47, tire: .209, tread: .104, sill: .175,
    belt: .586, nose: .530, tail: .549, ends: [.435, .420],
    rear: [-.322, -.160, .421, .354], front: [.255, .088, .430, .342],
    roof: 1, panes: [[.07, .46], [.51, .92]],
  },
  taxi: {
    height: 1.57, tire: .195, tread: .106, sill: .179,
    belt: .555, nose: .520, tail: .538, ends: [.458, .450],
    rear: [-.345, -.235, .436, .386], front: [.220, .112, .434, .383],
    roof: .915, panes: [[.06, .46], [.52, .94]],
  },
  suv: {
    height: 1.84, tire: .185, tread: .124, sill: .205, cladding: true,
    belt: .620, nose: .562, tail: .576, ends: [.446, .438],
    rear: [-.463, -.389, .433, .367], front: [.235, .121, .429, .358],
    roof: .965, panes: [[.05, .40], [.45, .73], [.78, .94]],
  },
  van: {
    height: 2.05, tire: .156, tread: .114, sill: .138, cladding: true,
    belt: .523, nose: .468, tail: .496, ends: [.455, .446],
    rear: [-.478, -.452, .444, .409], front: [.436, .280, .441, .392],
    roof: 1, panes: [[.045, .32], [.36, .65], [.69, .941]],
  },
  tuktuk: { height: 1.79, tire: .135, tread: .121 },
};

const lerp = THREE.MathUtils.lerp;

// One opaque, vertex-colored buffer for all stationary surfaces. Hard
// normals are kept where the actual bevels meet; trim needs no texture or pass.
function facets(width = 1, height = 1, length = 1) {
  const positions = [], colors = [], palette = new Map();
  return {
    face(points, color, flip = false) {
      if (!palette.has(color)) palette.set(color, new THREE.Color(color));
      const { r, g, b } = palette.get(color);
      for (let i = 1; i < points.length - 1; i++) {
        for (const [x, y, z] of [points[0], points[flip ? i + 1 : i], points[flip ? i : i + 1]]) {
          positions.push(x * width, y * height, z * length);
          colors.push(r, g, b);
        }
      }
    },
    geometry() {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      geometry.computeVertexNormals();
      return geometry;
    },
  };
}

function box(f, x, y, z, w, h, l, color) {
  const a = x - w / 2, b = x + w / 2, c = y - h / 2, d = y + h / 2, e = z - l / 2, g = z + l / 2;
  const points = [[a,c,e], [b,c,e], [b,c,g], [a,c,g], [a,d,e], [b,d,e], [b,d,g], [a,d,g]];
  for (const face of [[0,1,2,3], [4,7,6,5], [0,4,5,1], [1,5,6,2], [2,6,7,3], [3,7,4,0]])
    f.face(face.map((i) => points[i]), color);
}

function fascia(f, end, x0, x1, y0, y1, color, depth = .499, raised = false) {
  const c = Math.min(.015, (x1 - x0) / 4, (y1 - y0) / 4);
  const ring = [
    [x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c],
    [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c],
  ];
  const front = ring.map(([x, y]) => [x, y, end * depth]);
  f.face(front, color, end < 0);
  if (raised) {
    const back = ring.map(([x, y]) => [
      x + .035 * (x - (x0 + x1) / 2), y + .14 * (y - (y0 + y1) / 2), end * .492,
    ]);
    for (let i = 0; i < front.length; i++) {
      const j = (i + 1) % front.length;
      f.face([back[i], back[j], front[j], front[i]], color, end < 0);
    }
  }
}

function atSection(stations, z) {
  let i = 0;
  while (i < stations.length - 2 && stations[i + 1][0] < z) i++;
  const [a, b] = [stations[i], stations[i + 1]];
  const t = (z - a[0]) / (b[0] - a[0]);
  return [lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
}

// All sides, bonnet/deck and underside are cut from the same stations. The
// underside rises over each axle: the wheel arches are real openings in the
// outline, not circles painted on an opaque body.
function body(f, stations, arches, paint, cladding = false) {
  const z = [...new Set([
    ...stations.map((s) => s[0]),
    ...arches.flatMap(({ centre, half }) => [-1, -.86, -.60, 0, .60, .86, 1].map((t) => centre + half * t)),
  ])].sort((a, b) => a - b);
  const sections = z.map((z) => {
    const [w, top, sill] = atSection(stations, z);
    let low = sill;
    for (const { centre, half, peak } of arches) {
      const t = (z - centre) / half;
      if (Math.abs(t) < 1) low = Math.max(low, lerp(sill, peak, Math.sqrt(1 - t * t)));
    }
    const shoulder = top - .049;
    const welt = Math.min(low + (cladding ? .047 : .022), shoulder - .013);
    const wx = lerp(w - .033, w, (welt - low) / (shoulder - low));
    // From the sill to the horizontal deck, with a cladding break and a shoulder bevel.
    return [-1, 1].map((side) => [
      [side * (w - .033), low, z], [side * wx, welt, z],
      [side * w, shoulder, z], [side * (w - .039), top, z],
    ]);
  });
  for (let i = 1; i < sections.length; i++) {
    const [a, b] = [sections[i - 1], sections[i]];
    for (let s = 0; s < 2; s++)
      for (let j = 0; j < 3; j++)
        f.face([a[s][j], a[s][j + 1], b[s][j + 1], b[s][j]], j === 0 ? TRIM : paint, s === 0);
    f.face([a[0][3], b[0][3], b[1][3], a[1][3]], paint);
    f.face([a[0][0], a[1][0], b[1][0], b[0][0]], TRIM);
  }
  for (const [index, flip] of [[0, true], [sections.length - 1, false]]) {
    const [a, b] = sections[index];
    f.face([a[0], b[0], b[2], b[3], a[3], a[2]], paint, flip);
  }
}

function patcher(f, [a, b, c, d], flip) {
  const point = (u, v) => a.map((n, k) => lerp(lerp(n, b[k], u), lerp(d[k], c[k], u), v));
  return (left, right, bottom, top, color) => {
    if (right > left && top > bottom)
      f.face([point(left, bottom), point(right, bottom), point(right, top), point(left, top)], color, flip);
  };
}

function glazing(f, corners, flip, paint, panes, glass = GLASS) {
  const patch = patcher(f, corners, flip);
  patch(0, 1, 0, .16, paint);
  patch(0, 1, .90, 1, paint);
  let previous = 0;
  for (const [left, right] of panes) {
    patch(previous, left, .16, .90, paint);
    patch(left, right, .16, .90, glass);
    previous = right;
  }
  patch(previous, 1, .16, .90, paint);
}

function roof(f, rear, front, top, paint) {
  const crown = ([a, b]) => [a, [a[0] * .83, top, a[2]], [b[0] * .83, top, b[2]], b];
  const a = crown(rear), b = crown(front);
  for (let i = 0; i < 3; i++)
    f.face([a[i], b[i], b[i + 1], a[i + 1]], paint);
  f.face([a[0], a[1], a[2], a[3]], paint);
  f.face([b[0], b[3], b[2], b[1]], paint);
}

function carCabin(f, p, paint, kind) {
  const edge = (width, y, z) => [[-width, y, z], [width, y, z]];
  const [r, rTop, rw, rTw] = p.rear, [n, nTop, nw, nTw] = p.front;
  const lower = p.belt - .027;
  const a = edge(rw, lower, r), b = edge(nw, lower, n);
  const c = edge(rTw, p.roof - .030, rTop), d = edge(nTw, p.roof - .030, nTop);
  glazing(f, [a[0], a[1], c[1], c[0]], true, paint,
    kind === "van" ? [[.065, .479], [.521, .935]] : [[.092, .908]], 0x424e50);
  glazing(f, [b[0], b[1], d[1], d[0]], false, paint, [[.066, .934]], 0x53686b);
  for (let s = 0; s < 2; s++)
    glazing(f, [b[s], a[s], c[s], d[s]], s === 0, paint, p.panes);
  roof(f, c, d, p.roof, paint);
}

function carEnds(f, p, kind) {
  const [rear, front] = p.ends;
  const lightY = p.nose - (kind === "van" ? .105 : .116);
  const rearY = p.tail - .105;
  const split = kind === "suv" ? .200 : .191;
  fascia(f, 1, -front + .023, front - .023, p.sill + .026, p.sill + .095, TRIM, .5, true);
  fascia(f, -1, -rear + .020, rear - .020, p.sill + .033, p.sill + .094, TRIM, .5, true);
  fascia(f, 1, -split, split, lightY - .037, p.nose - .025, 0x303636);
  fascia(f, 1, -split + .026, split - .026, lightY + .012, lightY + .026, 0x656c66, .5);
  fascia(f, 1, -split + .026, split - .026, lightY + .044, lightY + .056, 0x656c66, .5);
  fascia(f, -1, -.096, .096, rearY - .019, rearY + .029, 0xd4cbb0);
  for (const side of [-1, 1]) {
    const lens = (end, inner, outer, y0, y1, color, z) => side < 0
      ? fascia(f, end, -outer, -inner, y0, y1, color, z)
      : fascia(f, end, inner, outer, y0, y1, color, z);
    lens(1, split + .012, front - .013, lightY - .008, p.nose - .016, TRIM, .497);
    lens(1, split + .026, front - .064, lightY + .009, p.nose - .032, LAMP, .5);
    lens(1, front - .059, front - .023, lightY + .009, p.nose - .032, AMBER, .5);
    lens(-1, rear - .171, rear - .020, rearY, p.tail - .018, TAIL, .498);
    lens(-1, rear - .150, rear - .038, rearY + .010, rearY + .030, AMBER, .5);
  }
}

function car(f, p, arches, paint, kind) {
  body(f, [
    [-.493, p.ends[0], p.tail, p.sill + .013],
    [-.435, .5, p.belt - .015, p.sill],
    [-.27, .5, p.belt, p.sill],
    [.26, .5, p.belt, p.sill],
    [.432, .5, lerp(p.belt, p.nose, .38), p.sill],
    [.493, p.ends[1], p.nose, p.sill + .015],
  ], arches, paint, p.cladding);
  carCabin(f, p, paint, kind);
  carEnds(f, p, kind);
  for (const side of [-1, 1]) {
    for (const z of [.041, kind === "van" ? -.205 : -.187]) {
      box(f, side * .491, p.belt - .098, z, .018, .020, .054, TRIM);
    }
    if (kind === "taxi") {
      // The light insert in the charcoal side band remains large enough to
      // read on a passing car; the taxi also has its own upright cab and topper.
      box(f, side * .485, p.belt - .178, -.015, .020, .068, .387, 0x414241);
      for (const z of [-.067, .009, .085])
        box(f, side * .495, p.belt - .178, z, .006, .032, .036, 0xcaba93);
    }
    if (kind === "suv")
      box(f, side * .274, .979, -.145, .044, .042, .285, TRIM);
  }
  if (kind === "taxi") {
    box(f, 0, .920, -.032, .270, .024, .100, TRIM);
    box(f, 0, .962, -.032, .219, .076, .075, AMBER);
  }
}

function tukTuk(f, arches, paint) {
  const canvas = 0x4a4840, canvasEdge = 0x373a35;
  // Wide passenger tub above the rear pair, then a short, narrow front
  // apron above the exposed centre wheel; the side of the cab is open.
  body(f, [
    [-.493, .398, .420, .177], [-.410, .5, .415, .171],
    [-.190, .5, .384, .161], [.090, .405, .325, .153],
    [.175, .280, .348, .179], [.278, .197, .454, .304],
    [.411, .170, .447, .302], [.493, .139, .433, .316],
  ], arches, paint, true);
  const a = [[-.382, .396, -.461], [.382, .396, -.461]];
  const b = [[-.155, .431, .403], [.155, .431, .403]];
  const c = [[-.406, .929, -.443], [.406, .929, -.443]];
  const d = [[-.347, .917, .202], [.347, .917, .202]];
  glazing(f, [a[0], a[1], c[1], c[0]], true, canvas, [[.190, .810]], 0x434e4c);
  glazing(f, [b[0], b[1], d[1], d[0]], false, paint, [[.120, .880]], 0x596a6a);
  for (let s = 0; s < 2; s++) {
    const patch = patcher(f, [b[s], a[s], c[s], d[s]], s === 0);
    patch(0, .076, 0, 1, TRIM);
    patch(.76, 1, 0, 1, canvas);
    patch(.076, .76, .930, 1, canvasEdge);
    box(f, s ? .413 : -.413, .282, -.057, .065, .023, .204, TRIM);
    fascia(f, -1, s ? .238 : -.357, s ? .357 : -.238, .310, .387, TAIL);
  }
  roof(f, c, d, 1, canvasEdge);
  box(f, 0, .423, -.295, .668, .058, .161, 0x897456);
  box(f, 0, .492, -.375, .666, .163, .030, 0x79664f);
  fascia(f, 1, -.126, .126, .323, .424, TRIM, .497, true);
  fascia(f, 1, -.093, .093, .341, .411, LAMP, .5);
  fascia(f, -1, -.362, .362, .199, .232, TRIM, .5, true);
  fascia(f, -1, -.092, .092, .264, .302, 0xd4cbb0);
}

function tireGeometry(radius, thickness) {
  const f = facets(), steps = 16;
  const rings = [
    [-.5, .53], [-.5, .81], [-.34, 1],
    [.34, 1], [.5, .81], [.5, .53],
  ].map(([x, r]) => Array.from({ length: steps }, (_, i) => {
    const a = i * Math.PI * 2 / steps;
    return [x * thickness, r * radius * Math.cos(a), r * radius * Math.sin(a)];
  }));
  for (let i = 0; i < steps; i++) {
    const j = (i + 1) % steps;
    for (let k = 0; k < rings.length - 1; k++)
      f.face([rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]],
        k === 2 && i % 2 ? 0x303331 : RUBBER);
    const hub = i % 4 === 1 ? 0x606a66 : 0x929893;
    f.face([[-thickness / 2, 0, 0], rings[0][j], rings[0][i]], hub);
    f.face([[thickness / 2, 0, 0], rings[5][i], rings[5][j]], hub);
  }
  return f.geometry();
}

const ownedModels = new WeakMap();
const matte = (roughness) => new THREE.MeshStandardMaterial({
  vertexColors: true, flatShading: true, roughness, metalness: 0,
});

function markOwner(part) {
  part.userData.owned = part.geometry.userData.owned = part.material.userData.owned = true;
  return part;
}

/**
 * Creates a local, asset-free model. Mount the root at the road surface and
 * apply the actor's position/heading to its parent. For each wheel, reset to
 * quaternion, yaw front wheels about +Y, then roll by signed travel/radius
 * about local +X. Neither the simulation actor nor the player rig is changed.
 */
export function createUnifiedTrafficModel(actor) {
  const { width, length } = actor;
  if (![width, length].every((n) => Number.isFinite(n) && n > 0))
    throw new RangeError("Traffic models require a positive finite width and length");
  const requested = actor.kind === "parked-vehicle" ? actor.vehicleKind : actor.kind;
  const kind = Object.hasOwn(SHAPES, requested) ? requested : "sedan";
  const p = SHAPES[kind], tuk = kind === "tuktuk";
  const height = Number.isFinite(actor.height) && actor.height > 0 ? actor.height : p.height;
  const colors = kind === "taxi" ? TAXI_PAINT : tuk ? TUK_PAINT : STREET_PAINT;
  const phase = Number.isFinite(actor.phase) ? actor.phase : 0;
  const paint = colors[Math.min(colors.length - 1, Math.max(0, Math.floor(phase * colors.length)))];
  const radius = Math.min(height * p.tire, width * .23, length * .09);
  const thickness = Math.min(width * p.tread, radius * .84);
  const axle = tuk ? [-.321, .334] : [-.310, .310];
  const half = (Math.hypot(radius, thickness / 2) + length * .010) / length;
  const peak = 2 * radius / height + .023;
  const arches = (tuk ? [axle[0]] : axle).map((centre) => ({ centre, half, peak }));
  const f = facets(width, height, length);
  if (tuk) tukTuk(f, arches, paint);
  else car(f, p, arches, paint, kind);

  const root = new THREE.Group();
  root.name = `traffic-${kind}`;
  const shell = markOwner(new THREE.Mesh(f.geometry(), matte(.93)));
  shell.name = "traffic-shell";
  shell.castShadow = shell.receiveShadow = true;
  root.add(shell);

  const tire = tireGeometry(radius, thickness), tireMaterial = matte(.97);
  const wheels = [];
  // Leave room inside the body envelope for the swept front treads at lock.
  const s = Math.sin(VEHICLE.maxSteer), c = Math.cos(VEHICLE.maxSteer);
  const sideAllowance = Math.max(radius * s + thickness * .34 * c, radius * .81 * s + thickness * .5 * c);
  const trackHalf = width / 2 - sideAllowance - width * .01;
  for (const front of [true, false]) {
    for (const side of tuk && front ? [0] : [-1, 1]) {
      const part = new THREE.Mesh(tire, tireMaterial);
      part.name = `wheel-${front ? "front" : "rear"}-${side < 0 ? "left" : side > 0 ? "right" : "center"}`;
      part.position.set(side * trackHalf, radius, axle[Number(front)] * length);
      if (tuk && front) part.scale.x = .78;
      part.receiveShadow = true;
      root.add(part);
      wheels.push({ part, front, quaternion: part.quaternion.clone(), radius });
    }
  }
  // Within this instance the wheels borrow one pair of resources. Flag one
  // custodian so WorldView's legacy `userData.owned` traversal disposes it once.
  ownedModels.set(root, [shell, markOwner(wheels[0].part)]);
  return { root, wheels };
}

/**
 * Detach and release a model on individual removal, e.g. a despawned patrol.
 * Idempotent; does not release caller-owned attachments. Alternatively leave
 * it attached for WorldView's owned-mesh teardown. Use one path per model.
 */
export function disposeUnifiedTrafficModel(root) {
  const owners = ownedModels.get(root);
  if (!owners) return;
  ownedModels.delete(root);
  root.removeFromParent();
  for (const part of owners) {
    part.userData.owned = part.geometry.userData.owned = part.material.userData.owned = false;
    part.geometry.dispose();
    part.material.dispose();
  }
}
