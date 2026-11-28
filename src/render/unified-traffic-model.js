import * as THREE from "three";
import { VEHICLE } from "../core/config.js";

const STREET_PAINT = [0x788f98, 0x9b5140, 0xb9b5a2, 0x48677f, 0x8c7358, 0x66796b];
const TAXI_PAINT = [0xddd0ac, 0xd5c49e, 0xe4dbba];
const TUK_PAINT = [0xbb9142, 0x547868, 0x974d38];
const TRUCK_PAINT = [0xe0ddd0, 0x4c6882, 0xb88649, 0x5d6e62, 0x9c4d3c];
const TRUCK_SHELL_HALF_X = .509;
const RUBBER = 0x292c2c, TRIM = 0x3e4543, GLASS = 0x3d5359;
const LAMP = 0xf1e3be, AMBER = 0xcd8a37, TAIL = 0xb94335;
const PLATE = 0xd4cbb0, EXHAUST = 0x757d78, MIRROR_GLASS = 0x8fa6ad;
const WIPER = 0x242929, AIR_DAM = 0x1e2323;

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
  truck: { height: 3.35, tire: .145, tread: .150, sill: .145 },
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
  windshieldWipers(f, p);
}

function windshieldWipers(f, p) {
  const [n, nTop, nw, nTw] = p.front;
  const lower = p.belt - .027, upper = p.roof - .030;
  // Cowl plenum strip along windshield base plus twin angled wiper blades.
  f.face([
    [-nw * .88, lower + .004, n + .014], [nw * .88, lower + .004, n + .014],
    [nw * .88, lower + .016, n + .002], [-nw * .88, lower + .016, n + .002],
  ], WIPER);
  const onGlass = (u, v, lift = .006) => {
    const w = lerp(nw, nTw, v);
    return [u * w, lerp(lower, upper, v) + lift * .65, lerp(n, nTop, v) + lift];
  };
  for (const [u0, u1, v0, v1] of [[-.68, -.06, .048, .125], [.04, .64, .048, .122]]) {
    f.face([
      onGlass(u0, v0, .005), onGlass(u1, v1, .005),
      onGlass(u1, v1 + .020, .008), onGlass(u0, v0 + .020, .008),
    ], WIPER);
  }
}

function sideMirror(f, side, p, paint) {
  const z0 = p.front[0] - .062, z1 = p.front[0] - .020;
  const yMid = Math.max(p.belt + .036, .585);
  const xRoot = p.front[2] - .006, xNeck = .456, xOuter = .4995;
  // Stalk connecting A-pillar sail panel to mirror housing (visible top & front).
  const [sx0, sx1] = side < 0 ? [-xNeck, -xRoot] : [xRoot, xNeck];
  const sz0 = z0 + .010, sz1 = z1 - .006;
  f.face([[sx0, yMid - .004, sz0], [sx0, yMid - .004, sz1], [sx1, yMid - .004, sz1], [sx1, yMid - .004, sz0]], TRIM);
  f.face([[sx0, yMid - .014, sz1], [sx1, yMid - .014, sz1], [sx1, yMid - .004, sz1], [sx0, yMid - .004, sz1]], TRIM);
  // Sculpted tapered aerodynamic mirror shell + rear reflective glass face.
  const [xa0, xb0] = side < 0 ? [-xOuter, -xNeck] : [xNeck, xOuter];
  const [xa1, xb1] = side < 0 ? [-xOuter + .008, -xNeck - .003] : [xNeck + .003, xOuter - .008];
  const pts = [
    [xa0, yMid - .021, z0], [xb0, yMid - .021, z0], [xb1, yMid - .014, z1], [xa1, yMid - .014, z1],
    [xa0, yMid + .021, z0], [xb0, yMid + .021, z0], [xb1, yMid + .015, z1], [xa1, yMid + .015, z1],
  ];
  f.face([pts[0], pts[1], pts[2], pts[3]], TRIM);
  f.face([pts[4], pts[7], pts[6], pts[5]], paint);
  f.face([pts[2], pts[6], pts[7], pts[3]], paint);
  if (side > 0) f.face([pts[1], pts[5], pts[6], pts[2]], paint);
  else f.face([pts[3], pts[7], pts[4], pts[0]], paint);
  f.face([pts[0], pts[4], pts[5], pts[1]], MIRROR_GLASS);
}

function rearTailpipe(f, p) {
  const cx = -(p.ends[0] - .115), cy = p.sill + .019;
  const zFront = -.458, zBack = -.4995, r = .0155, steps = 5;
  const ring = Array.from({ length: steps }, (_, i) => {
    const a = (i * Math.PI * 2) / steps;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
  for (let i = 0; i < steps; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % steps];
    f.face([[x0, y0, zFront], [x1, y1, zFront], [x1, y1, zBack], [x0, y0, zBack]], EXHAUST);
  }
  f.face(ring.map(([x, y]) => [cx + (x - cx) * .72, cy + (y - cy) * .72, zBack]), AIR_DAM, true);
}

function carEnds(f, p, kind) {
  const [rear, front] = p.ends;
  const lightY = p.nose - (kind === "van" ? .105 : .116);
  const rearY = p.tail - .105;
  const split = kind === "suv" ? .200 : .191;
  fascia(f, 1, -front + .023, front - .023, p.sill + .040, p.sill + .096, TRIM, .498, true);
  // Front lower air-dam recess & chin splitter lip.
  const damHalf = Math.min(front - .040, split * 1.18);
  const damY0 = p.sill + .017, damY1 = p.sill + .039;
  f.face([[-damHalf, damY0, .488], [damHalf, damY0, .488], [damHalf, damY1, .488], [-damHalf, damY1, .488]], AIR_DAM);
  f.face([[-damHalf, damY1, .488], [damHalf, damY1, .488], [damHalf, damY1, .498], [-damHalf, damY1, .498]], AIR_DAM);
  const spHalf = front - .020, spY0 = p.sill + .007, spY1 = p.sill + .018;
  f.face([[-spHalf, spY0, .5], [spHalf, spY0, .5], [spHalf, spY1, .5], [-spHalf, spY1, .5]], WIPER);
  f.face([[-spHalf, spY1, .5], [spHalf, spY1, .5], [spHalf, spY1, .486], [-spHalf, spY1, .486]], TRIM);
  // Front license plate & backing frame.
  f.face([[-.103, p.sill + .042, .4992], [.103, p.sill + .042, .4992], [.103, p.sill + .093, .4992], [-.103, p.sill + .093, .4992]], WIPER);
  f.face([[-.096, p.sill + .047, .5], [.096, p.sill + .047, .5], [.096, p.sill + .088, .5], [-.096, p.sill + .088, .5]], PLATE);
  fascia(f, -1, -rear + .020, rear - .020, p.sill + .033, p.sill + .094, TRIM, .5, true);
  fascia(f, 1, -split, split, lightY - .037, p.nose - .025, 0x303636);
  fascia(f, 1, -split + .026, split - .026, lightY + .012, lightY + .026, 0x656c66, .5);
  fascia(f, 1, -split + .026, split - .026, lightY + .044, lightY + .056, 0x656c66, .5);
  fascia(f, -1, -.096, .096, rearY - .019, rearY + .029, PLATE);
  rearTailpipe(f, p);
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
    sideMirror(f, side, p, paint);
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


function heavyTruck(f, arches, paint) {
  const cargo = paint, cargoShade = new THREE.Color(paint).multiplyScalar(.77).getHex();
  const stripe = paint === 0xb88649 ? 0xe1d6b3 : 0xc49b58;
  const steel = 0x68706c, chassis = 0x252a29, rib = 0x343a38;

  // Full-height cargo envelope establishes the registered dimensions. The
  // cab remains visibly lower and occupies the forward 28% of the wheelbase.
  box(f, 0, .680, -.137, 1, .590, .714, cargo);
  box(f, 0, .9835, -.137, .988, .017, .706, cargoShade);
  box(f, 0, .435, .355, .940, .650, .270, paint);
  box(f, 0, .125, .090, .720, .070, .810, chassis);
  for (const side of [-1, 1]) {
    box(f, side * .355, .175, -.075, .048, .075, .735, chassis);
    box(f, side * .455, .150, -.165, .040, .045, .510, steel);
    box(f, side * .5015, .654, -.137, .009, .095, .706, stripe);
    for (const z of [-.438, -.338, -.238, -.138, -.038, .062, .162])
      box(f, side * .5035, .700, z, .011, .520, .018, rib);
    // Cylindrical tanks would require a second shell; a bevel-like faceted
    // tank remains part of the one opaque vertex-coloured traffic shell.
    box(f, side * .414, .245, -.020, .145, .165, .315, 0x777b73);
    box(f, side * .456, .180, .285, .075, .050, .180, steel);
    box(f, side * .456, .245, .318, .075, .040, .135, steel);
    box(f, side * .455, .295, .358, .082, .040, .110, steel);
    box(f, side * .481, .555, .414, .026, .370, .022, chassis);
    box(f, side * .487, .735, .416, .026, .085, .055, paint);
    const mirrorX = side * .5015;
    f.face([[mirrorX, .695, .389], [mirrorX, .695, .444], [mirrorX, .760, .444], [mirrorX, .760, .389]], MIRROR_GLASS, side > 0);
    box(f, side * .450, .085, -.405, .060, .115, .028, 0x292d2c);
  }

  // Upright cab-over glazing, sun visor, radiator and rugged lower bumper.
  fascia(f, 1, -.395, .395, .555, .720, GLASS, .491);
  box(f, 0, .745, .433, .820, .055, .080, paint);
  fascia(f, 1, -.330, .330, .300, .455, 0x252b2a, .496, true);
  for (const y of [.330, .365, .400, .435])
    fascia(f, 1, -.288, .288, y, y + .012, 0x606864, .499);
  box(f, 0, .178, .484, .955, .075, .028, steel);
  fascia(f, 1, -.112, .112, .195, .245, PLATE, .5);
  for (const side of [-1, 1]) {
    const a = side < 0 ? [-.410, -.250] : [.250, .410];
    fascia(f, 1, a[0], a[1], .465, .545, TRIM, .497);
    fascia(f, 1, a[0] + side * -.012, a[1] + side * .012, .480, .530, LAMP, .5);
    const b = side < 0 ? [-.447, -.405] : [.405, .447];
    fascia(f, 1, b[0], b[1], .468, .530, AMBER, .4995);
  }

  // Contrasting side windows preserve a tall Egyptian cab-over profile.
  for (const side of [-1, 1]) {
    const x = side * .471;
    const xFace = side * .4735;
    f.face([[xFace, .545, .245], [xFace, .545, .420], [xFace, .706, .420], [xFace, .706, .245]], GLASS, side > 0);
    box(f, x, .505, .305, .018, .030, .135, TRIM);
  }

  // Rear double cargo doors, hinges, locking rods, lamp stacks and underride.
  fascia(f, -1, -.474, -.012, .405, .960, cargoShade, .497);
  fascia(f, -1, .012, .474, .405, .960, cargoShade, .497);
  for (const x of [-.250, .250]) {
    box(f, x, .680, -.498, .026, .475, .002, steel);
    for (const y of [.445, .700, .910]) box(f, x, y, -.499, .090, .024, .002, rib);
  }
  box(f, 0, .175, -.462, .920, .060, .050, steel);
  for (const side of [-1, 1]) {
    const x = side * .410;
    fascia(f, -1, x - .052, x + .052, .230, .340, TRIM, .498);
    fascia(f, -1, x - .040, x + .040, .285, .328, TAIL, .5);
    fascia(f, -1, x - .040, x + .040, .238, .278, AMBER, .499);
  }
  for (const x of [-.430, 0, .430]) {
    box(f, x, .996, -.486, .042, .008, .018, x === 0 ? TAIL : AMBER);
    box(f, x, .996, .205, .042, .008, .018, AMBER);
  }
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
    for (const side of [-1, 1]) {
      const point = (index, r, x) => {
        const a = index * Math.PI * 2 / steps;
        return [side * thickness * x, radius * r * Math.cos(a), radius * r * Math.sin(a)];
      };
      const recessed = i % 4 > 1;
      f.face([[side * thickness * .4, 0, 0],
        point(i, .53, .5), point(j, .53, .5)],
        recessed ? 0x252a28 : 0x929893, side < 0);
    }
  }
  return f.geometry();
}

const ownedModels = new WeakMap();
const sharedDamagedByPristine = new WeakMap();
const MAX_SHARED_DAMAGED_PER_GEOMETRY = 8;

function defineHidden(target, key, value) {
  if (!target) return value;
  Object.defineProperty(target, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return value;
}

function pushSharedDamagedGeometry(pristine, geometry, shell) {
  if (!pristine || !geometry) return;
  let bucket = sharedDamagedByPristine.get(pristine);
  if (!bucket) {
    bucket = [];
    sharedDamagedByPristine.set(pristine, bucket);
    pristine.addEventListener("dispose", () => flushSharedDamagedPool(pristine));
  }
  for (let i = 0; i < bucket.length; i++) {
    if (bucket[i].geometry === geometry) {
      bucket[i].shell = shell;
      return;
    }
  }
  if (bucket.length >= MAX_SHARED_DAMAGED_PER_GEOMETRY) {
    const evicted = bucket.shift();
    if (evicted.shell?.userData?.pooledDamagedGeometry === evicted.geometry) {
      defineHidden(evicted.shell.userData, "pooledDamagedGeometry", null);
      defineHidden(evicted.shell.userData, "pooledSourceGeometry", null);
    }
    evicted.geometry.userData.owned = false;
    evicted.geometry.dispose();
  }
  bucket.push({ geometry, shell });
}

function removeFromSharedDamagedPool(pristine, geometry) {
  const bucket = pristine ? sharedDamagedByPristine.get(pristine) : null;
  if (!bucket) return;
  for (let i = bucket.length - 1; i >= 0; i--) {
    if (bucket[i].geometry === geometry) {
      bucket.splice(i, 1);
    }
  }
}

function popSharedDamagedGeometry(pristine) {
  const bucket = pristine ? sharedDamagedByPristine.get(pristine) : null;
  if (!bucket || bucket.length === 0) return null;
  const entry = bucket.pop();
  if (entry.shell?.userData?.pooledDamagedGeometry === entry.geometry) {
    defineHidden(entry.shell.userData, "pooledDamagedGeometry", null);
    defineHidden(entry.shell.userData, "pooledSourceGeometry", null);
  }
  return entry.geometry;
}

function flushSharedDamagedPool(pristine) {
  const bucket = pristine ? sharedDamagedByPristine.get(pristine) : null;
  if (!bucket || bucket.length === 0) return;
  const items = bucket.splice(0, bucket.length);
  for (let i = 0; i < items.length; i++) {
    const { geometry, shell } = items[i];
    if (shell?.userData?.pooledDamagedGeometry === geometry) {
      defineHidden(shell.userData, "pooledDamagedGeometry", null);
      defineHidden(shell.userData, "pooledSourceGeometry", null);
    }
    geometry.userData.owned = false;
    geometry.dispose();
  }
}

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
  const colors = kind === "taxi" ? TAXI_PAINT : tuk ? TUK_PAINT : kind === "truck" ? TRUCK_PAINT : STREET_PAINT;
  const phase = Number.isFinite(actor.phase) ? actor.phase : 0;
  const paint = colors[Math.min(colors.length - 1, Math.max(0, Math.floor(phase * colors.length)))];
  const radius = Math.min(height * p.tire, width * .23, length * .09);
  const thickness = Math.min(width * p.tread, radius * .84);
  const truck = kind === "truck";
  const axle = tuk ? [-.321, .334] : truck ? [-.300, .340] : [-.310, .310];
  const half = (Math.hypot(radius, thickness / 2) + length * .010) / length;
  const peak = 2 * radius / height + .023;
  const arches = (tuk ? [axle[0]] : axle).map((centre) => ({ centre, half, peak }));
  const f = facets(truck ? width * (.5 / TRUCK_SHELL_HALF_X) : width, height, length);
  if (tuk) tukTuk(f, arches, paint);
  else if (truck) heavyTruck(f, arches, paint);
  else car(f, p, arches, paint, kind);

  const root = new THREE.Group();
  root.name = `traffic-${kind}`;
  const shellGeometry = f.geometry();
  const shell = markOwner(new THREE.Mesh(shellGeometry, matte(.93)));
  shell.name = "traffic-shell";
  shell.userData.crashSignature = "0:0:0:0:0";
  shell.castShadow = true;
  shell.receiveShadow = kind !== "truck";
  root.add(shell);
  defineHidden(root.userData, "trafficShell", shell);

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
  ownedModels.set(root, { shell, shellGeometry, wheel: markOwner(wheels[0].part) });
  return { root, wheels };
}

const clamp01 = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/**
 * Visibly crumples and scuffs a procedural traffic/police shell in place.
 * Lazily clones `shell.geometry` once so shared pool or police livery buffers
 * remain untouched, and restores pristine geometry cleanly when reset to 0.
 */
export function applyTrafficCrashDamage(root, damageSpec = {}) {
  let shell = root?.userData?.trafficShell?.parent === root ? root.userData.trafficShell : null;
  if (!shell) {
    const first = root?.children?.[0];
    shell = (first?.isMesh && first.name === "traffic-shell")
      ? first
      : root?.getObjectByName?.("traffic-shell");
    if (shell && shell.parent === root && root?.userData) {
      defineHidden(root.userData, "trafficShell", shell);
    }
  }
  if (!shell?.isMesh || !shell.geometry) return false;
  const front = clamp01(damageSpec?.front);
  const rear = clamp01(damageSpec?.rear);
  const left = clamp01(damageSpec?.left);
  const right = clamp01(damageSpec?.right);
  const wrecked = Boolean(damageSpec?.wrecked);
  const sig = `${Math.round(front * 20)}:${Math.round(rear * 20)}:${Math.round(left * 20)}:${Math.round(right * 20)}:${wrecked ? 1 : 0}`;
  if (shell.userData.crashSignature === sig) return false;

  if (sig === "0:0:0:0:0") {
    shell.userData.crashSignature = sig;
    if (shell.userData.pristineGeometry) {
      const pristine = shell.userData.pristineGeometry;
      const damaged = shell.userData.damagedGeometry;
      defineHidden(shell.userData, "damagedGeometry", null);
      shell.geometry = pristine;
      defineHidden(shell.userData, "pristineGeometry", null);
      if (damaged) {
        defineHidden(shell.userData, "pooledDamagedGeometry", damaged);
        defineHidden(shell.userData, "pooledSourceGeometry", pristine);
        pushSharedDamagedGeometry(pristine, damaged, shell);
      }
      return true;
    }
    return false;
  }

  if (shell.userData.damagedGeometry && shell.geometry !== shell.userData.damagedGeometry) {
    const stale = shell.userData.damagedGeometry;
    const staleSource = shell.userData.pristineGeometry;
    defineHidden(shell.userData, "damagedGeometry", null);
    defineHidden(shell.userData, "pristineGeometry", null);
    if (staleSource) {
      defineHidden(shell.userData, "pooledDamagedGeometry", stale);
      defineHidden(shell.userData, "pooledSourceGeometry", staleSource);
      pushSharedDamagedGeometry(staleSource, stale, shell);
    } else {
      stale.dispose();
    }
  }

  if (!shell.userData.damagedGeometry) {
    const pristine = shell.geometry;
    if (!pristine.boundingBox) pristine.computeBoundingBox();
    let clone = null;
    const localPooled = shell.userData.pooledDamagedGeometry;
    if (localPooled) {
      const pooledSrc = shell.userData.pooledSourceGeometry;
      if (pooledSrc === pristine) {
        removeFromSharedDamagedPool(pristine, localPooled);
        clone = localPooled;
      }
      defineHidden(shell.userData, "pooledDamagedGeometry", null);
      defineHidden(shell.userData, "pooledSourceGeometry", null);
    }
    if (!clone) {
      clone = popSharedDamagedGeometry(pristine);
    }
    if (!clone) {
      clone = pristine.clone();
      defineHidden(clone.userData, "ownerShell", null);
      defineHidden(clone.userData, "ownerPristine", null);
      clone.addEventListener("dispose", () => {
        const curShell = clone.userData.ownerShell;
        const curPristine = clone.userData.ownerPristine;
        if (curShell?.userData?.damagedGeometry === clone && curPristine?.userData?.owned) {
          curPristine.userData.owned = false;
          curPristine.dispose();
        }
      });
    }
    clone.userData.owned = Boolean(shell.userData.owned);
    defineHidden(clone.userData, "ownerShell", shell);
    defineHidden(clone.userData, "ownerPristine", pristine);
    defineHidden(shell.userData, "pristineGeometry", pristine);
    defineHidden(shell.userData, "damagedGeometry", clone);
    shell.geometry = clone;
  }

  const pristine = shell.userData.pristineGeometry;
  const damaged = shell.userData.damagedGeometry;
  if (!pristine.boundingBox) pristine.computeBoundingBox();
  const { min, max } = pristine.boundingBox;
  const width = Math.max(.4, max.x - min.x);
  const height = Math.max(.4, max.y - min.y);
  const length = Math.max(.8, max.z - min.z);
  const cx = (min.x + max.x) / 2;
  const cz = (min.z + max.z) / 2;

  const effFront = wrecked ? Math.max(front, .88) : front;
  const effRear = wrecked ? Math.max(rear, .52) : rear;
  const effLeft = wrecked ? Math.max(left, .58) : left;
  const effRight = wrecked ? Math.max(right, .58) : right;

  const srcPos = pristine.attributes.position;
  const dstPos = damaged.attributes.position;
  const srcCol = pristine.attributes.color;
  const dstCol = damaged.attributes.color;
  const srcPosArr = srcPos.array;
  const dstPosArr = dstPos.array;
  const hasColor = Boolean(srcCol && dstCol);
  const srcColArr = hasColor ? srcCol.array : null;
  const dstColArr = hasColor ? dstCol.array : null;
  const vertCount = srcPos.count;
  const strainScaleX = width * .10;
  const strainScaleY = height * .09;
  const strainScaleZ = length * .10;

  for (let i = 0; i < vertCount; i++) {
    const i3 = i * 3;
    const x = srcPosArr[i3];
    const y = srcPosArr[i3 + 1];
    const z = srcPosArr[i3 + 2];
    const xn = (x - cx) / width;
    const yn = (y - min.y) / height;
    const zn = (z - cz) / length;
    let dx = 0, dy = 0, dz = 0;

    if (effFront > 0) {
      if (zn > .18) {
        const ft = clamp01((zn - .18) / .32);
        const lat = .76 + .24 * Math.cos(xn * Math.PI * 1.4) + .08 * Math.cos(xn * 11);
        dz -= effFront * length * .115 * (ft ** 1.3) * lat;
      }
      if (zn > .16 && zn < .45 && yn > .34) {
        const hoodArch = Math.sin(Math.PI * clamp01((zn - .16) / .29));
        const hoodLat = Math.max(.25, 1 - (xn / .52) ** 2);
        dy += effFront * height * .115 * hoodArch * (.52 + .48 * hoodLat);
      }
      if (zn > .36 && yn < .36) {
        const bt = clamp01((zn - .36) / .14);
        const corner = .35 + .65 * Math.min(1, Math.abs(xn) / .40);
        dy -= effFront * height * .075 * bt * corner;
        dx -= Math.sign(xn) * effFront * width * .042 * bt * Math.min(1, Math.abs(xn) * 2);
      }
    }

    if (effRear > 0) {
      if (zn < -.18) {
        const rt = clamp01((-zn - .18) / .32);
        dz += effRear * length * .098 * (rt ** 1.3) * (.82 + .18 * Math.cos(xn * 9));
      }
      if (zn < -.20 && zn > -.44 && yn > .36) {
        const trunkArch = Math.sin(Math.PI * clamp01((-zn - .20) / .24));
        dy += effRear * height * .055 * trunkArch * Math.max(0, 1 - (xn / .45) ** 2);
      }
      if (zn < -.36 && yn < .36) {
        const rbt = clamp01((-zn - .36) / .14);
        dy -= effRear * height * .068 * rbt * (.35 + .65 * Math.min(1, Math.abs(xn) / .40));
      }
    }

    if (effLeft > 0 || effRight > 0) {
      const alongZ = Math.max(0, 1 - (zn / .46) ** 2);
      const vert = yn < .86 ? .28 + .72 * Math.sin(Math.PI * clamp01(yn / .86)) : .12;
      const ripple = .78 + .22 * Math.sin(zn * 18 + yn * 8);
      if (effLeft > 0 && xn < -.16) {
        const lt = clamp01((-xn - .16) / .34);
        dx += effLeft * width * .105 * lt * alongZ * vert * ripple;
        dy -= effLeft * height * .020 * lt * alongZ * Math.sin(zn * 13);
      }
      if (effRight > 0 && xn > .16) {
        const rt = clamp01((xn - .16) / .34);
        dx -= effRight * width * .105 * rt * alongZ * vert * ripple;
        dy += effRight * height * .020 * rt * alongZ * Math.cos(zn * 13);
      }
    }

    dstPosArr[i3] = x + dx;
    dstPosArr[i3 + 1] = y + dy;
    dstPosArr[i3 + 2] = z + dz;

    if (hasColor) {
      if (!wrecked && dx === 0 && dy === 0 && dz === 0) {
        dstColArr[i3] = clamp01(srcColArr[i3]);
        dstColArr[i3 + 1] = clamp01(srcColArr[i3 + 1]);
        dstColArr[i3 + 2] = clamp01(srcColArr[i3 + 2]);
      } else {
        const strain = clamp01(Math.hypot(
          dx / strainScaleX,
          dy / strainScaleY,
          dz / strainScaleZ,
        ));
        let shade = 1 - .38 * strain;
        if (wrecked) {
          const scorch = clamp01((zn - .05) / .16) * clamp01((yn - .20) / .20);
          shade = Math.min(shade, lerp(.68, .44, scorch));
        }
        const scuff = !wrecked && strain > .35 ? (strain - .35) * .025 : 0;
        dstColArr[i3] = clamp01(srcColArr[i3] * shade + scuff);
        dstColArr[i3 + 1] = clamp01(srcColArr[i3 + 1] * shade + scuff);
        dstColArr[i3 + 2] = clamp01(srcColArr[i3 + 2] * shade + scuff * 1.05);
      }
    }
  }

  dstPos.needsUpdate = true;
  if (dstCol) dstCol.needsUpdate = true;
  damaged.computeVertexNormals();
  damaged.computeBoundingBox();
  damaged.computeBoundingSphere();
  shell.userData.crashSignature = sig;
  return true;
}

/**
 * Detach and release a model on individual removal, e.g. a despawned patrol.
 * Idempotent; does not release caller-owned attachments. Alternatively leave
 * it attached for WorldView's owned-mesh teardown. Use one path per model.
 */
export function disposeUnifiedTrafficModel(root) {
  const record = ownedModels.get(root);
  if (!record) return;
  ownedModels.delete(root);
  root.removeFromParent();
  const { shell, shellGeometry, wheel } = record;
  shell.userData.owned = shellGeometry.userData.owned = shell.material.userData.owned = false;
  const activeDamaged = shell.userData.damagedGeometry;
  const pooledDamaged = shell.userData.pooledDamagedGeometry;
  const pooledSrc = shell.userData.pooledSourceGeometry;
  defineHidden(shell.userData, "damagedGeometry", null);
  defineHidden(shell.userData, "pooledDamagedGeometry", null);
  defineHidden(shell.userData, "pooledSourceGeometry", null);
  shell.geometry = shell.userData.pristineGeometry ?? shellGeometry;
  defineHidden(shell.userData, "pristineGeometry", null);
  if (activeDamaged) {
    defineHidden(activeDamaged.userData, "ownerShell", null);
    defineHidden(activeDamaged.userData, "ownerPristine", null);
    activeDamaged.userData.owned = false;
    activeDamaged.dispose();
  }
  if (pooledDamaged && pooledDamaged !== activeDamaged) {
    removeFromSharedDamagedPool(pooledSrc ?? shellGeometry, pooledDamaged);
    defineHidden(pooledDamaged.userData, "ownerShell", null);
    defineHidden(pooledDamaged.userData, "ownerPristine", null);
    pooledDamaged.userData.owned = false;
    pooledDamaged.dispose();
  }
  flushSharedDamagedPool(shellGeometry);
  shellGeometry.dispose();
  shell.material.dispose();
  wheel.userData.owned = wheel.geometry.userData.owned = wheel.material.userData.owned = false;
  wheel.geometry.dispose();
  wheel.material.dispose();
}
