import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { getVehicleMounts, KING_LONG_MICROBUS, KING_LONG_MICROBUS_ID } from "../core/vehicle-spec.js";

const UP = new THREE.Vector3(0, 1, 0);
const v = (p) => new THREE.Vector3(...p);
const mix = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const ACROSS = [-1, -0.93, -0.83, -0.69, -0.49, -0.24, 0, 0.24, 0.49, 0.69, 0.83, 0.93, 1];
const sorted = (a) => [...new Set(a)].sort((x, y) => x - y);

function interpolate(rows, y, field) {
  for (let i = 1; i < rows.length; i++) {
    if (y <= rows[i][0]) {
      const a = rows[i - 1], b = rows[i];
      return mix(a[field], b[field], clamp((y - a[0]) / (b[0] - a[0]), 0, 1));
    }
  }
  return rows.at(-1)[field];
}

function surface(positions, indices) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function grid(columns, rows, sample, flip = false) {
  const positions = [], indices = [], stride = columns.length;
  for (const y of rows) for (const x of columns) positions.push(...sample(x, y));
  for (let j = 0; j < rows.length - 1; j++) for (let i = 0; i < stride - 1; i++) {
    const a = j * stride + i, b = a + 1, c = a + stride, d = c + 1;
    indices.push(...(flip ? [a, c, b, b, c, d] : [a, b, c, b, d, c]));
  }
  return surface(positions, indices);
}

function polygon(outline, holes, map, flip = false) {
  const loops = [outline, ...holes];
  const points = loops.flat();
  const [outside, ...inside] = loops.map((p) => p.map(([x, y]) => new THREE.Vector2(x, y)));
  const face = THREE.ShapeUtils.triangulateShape(outside, inside);
  const indices = face.flatMap(([a, b, c]) => {
    const [x, y] = points[a], [u, w] = points[b], [s, t] = points[c];
    return (((u - x) * (t - y) < (w - y) * (s - x)) !== flip) ? [a, c, b] : [a, b, c];
  });
  return surface(points.flatMap(([x, y]) => map(x, y)), indices);
}

function soften(points, radius) {
  return points.flatMap((p, i) => {
    const trim = (q) => {
      const t = Math.min(0.42, radius / Math.hypot(q[0] - p[0], q[1] - p[1]));
      return [mix(p[0], q[0], t), mix(p[1], q[1], t)];
    };
    const a = trim(points[(i + points.length - 1) % points.length]);
    const b = trim(points[(i + 1) % points.length]);
    return [0, 0.25, 0.5, 0.75, 1].map((t) =>
      [0, 1].map((j) => mix(mix(a[j], p[j], t), mix(p[j], b[j], t), t)));
  });
}

function merged(parts) {
  const flat = parts.map((part) => {
    if (part.index) {
      const geometry = part.toNonIndexed();
      part.dispose();
      part = geometry;
    }
    part.deleteAttribute("uv");
    return part;
  });
  const geometry = mergeGeometries(flat);
  for (const part of flat) part.dispose();
  return geometry;
}

function softBox(w, h, depth, bevel) {
  const x = w / 2 - bevel, y = h / 2 - bevel;
  const shape = new THREE.Shape();
  shape.moveTo(-x, -y); shape.lineTo(x, -y);
  shape.lineTo(x, y); shape.lineTo(-x, y); shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    depth: depth - 2 * bevel, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2,
  }).translate(0, 0, -depth / 2 + bevel);
}

function stroke(path, width, map, flip) {
  const parts = [];
  for (let i = 1; i < path.length; i++) {
    const [x, y] = path[i - 1], [u, w] = path[i];
    const r = (width / 2) / Math.hypot(u - x, w - y);
    const dx = (y - w) * r, dy = (u - x) * r;
    parts.push(polygon([[x + dx, y + dy], [x - dx, y - dy],
      [u - dx, w - dy], [u + dx, w + dy]], [], map, flip));
  }
  return merged(parts);
}

function endBand(map, rows, limits, flip) {
  return grid(ACROSS, rows, (u, y) => {
    const [a, b] = limits(y);
    return map(mix(a, b, (u + 1) / 2), y);
  }, flip);
}

function panelShape(x, y, width, height, rx, ry) {
  const lo = y - height / 2, hi = y + height / 2;
  const rows = [lo, lo + ry * 0.18, lo + ry * 0.52, lo + ry, y,
    hi - ry, hi - ry * 0.52, hi - ry * 0.18, hi];
  const limits = (level) => {
    const t = Math.max(0, 1 - Math.min(level - lo, hi - level) / ry);
    const inset = rx * (1 - Math.sqrt(Math.max(0, 1 - t * t)));
    return [x - width / 2 + inset, x + width / 2 - inset];
  };
  return { lo, hi, rows, limits };
}

function windowFrame(map, outer, inner, flip, bottom = outer.lo, top = outer.hi, full = false) {
  const [lo, hi] = [inner.lo, inner.hi];
  const ringRows = sorted([...outer.rows, ...inner.rows]).filter((y) => y >= lo && y <= hi);
  const outside = full ? () => [-1, 1] : outer.limits;
  return merged([
    endBand(map, sorted([bottom, ...outer.rows.filter((y) => y > bottom && y < lo), lo]), outside, flip),
    endBand(map, ringRows, (y) => [outside(y)[0], inner.limits(y)[0]], flip),
    endBand(map, ringRows, (y) => [inner.limits(y)[1], outside(y)[1]], flip),
    endBand(map, sorted([hi, ...outer.rows.filter((y) => y > hi && y < top), top]), outside, flip),
  ]);
}

function tireGeometry(r, w) {
  const profile = [
    [0.184, -0.46], [r * 0.77, -0.5], [r * 0.91, -0.47], [r * 0.977, -0.38],
    [r, -0.26], [r, -0.178], [r - 0.003, -0.148], [r, -0.116],
    [r, 0.116], [r - 0.003, 0.148], [r, 0.178], [r, 0.26],
    [r * 0.977, 0.38], [r * 0.91, 0.47], [r * 0.77, 0.5], [0.184, 0.46],
  ];
  return new THREE.LatheGeometry(profile.map(([radius, t]) => new THREE.Vector2(radius, t * w)), 32)
    .rotateZ(-Math.PI / 2);
}

function wheelFace(w) {
  const dish = [[0.185, -0.066], [0.187, w * 0.40], [0.1905, w * 0.453],
    [0.188, w * 0.488], [0.174, w * 0.49], [0.172, w * 0.423], [0.175, w * 0.39], [0.175, -0.066]];
  const parts = [
    new THREE.LatheGeometry(dish.map(([r, x]) => new THREE.Vector2(r, x)), 32).rotateZ(-Math.PI / 2),
    new THREE.CylinderGeometry(0.047, 0.055, 0.041, 16).rotateZ(-Math.PI / 2).translate(w * 0.352, 0, 0),
  ];
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    parts.push(softBox(0.021, 0.132, 0.027, 0.004).rotateZ(0.095)
      .translate(w * 0.383, 0.115, 0.003).rotateX(a));
  }
  for (let i = 0; i < 5; i++) {
    const a = i * Math.PI * 0.4;
    parts.push(new THREE.CylinderGeometry(0.0105, 0.011, 0.014, 6)
      .rotateZ(Math.PI / 2).translate(w * 0.46, 0.061 * Math.cos(a), 0.061 * Math.sin(a)));
  }
  return merged(parts);
}

export function createKingLongModel(body = {}) {
  const { lengthM, widthM, heightM, wheelbaseM, trackM, wheelRadiusM, wheelWidthM, axleCenterZM } = KING_LONG_MICROBUS;
  const halfLength = lengthM / 2, halfWidth = widthM / 2;
  const frontAxle = axleCenterZM + wheelbaseM / 2, rearAxle = axleCenterZM - wheelbaseM / 2;
  const belt = 1.235, shoulder = heightM - 0.098, sill = 0.36;
  const geometries = new Set(), materials = new Set(), textures = new Set();
  const bodyPanels = [], cutawayParts = [], chaseHidden = [], wheels = [], links = [];
  const ownGeometry = (g) => { geometries.add(g); return g; };
  const ownMaterial = (m) => { materials.add(m); return m; };
  const material = (name, color, options = {}) => ownMaterial(new THREE.MeshStandardMaterial({
    name: `King Long ${name}`, color, roughness: 0.77, ...options,
  }));
  const group = (parent, name, pos) => {
    const g = new THREE.Group();
    g.name = name;
    if (pos) g.position.set(...pos);
    parent?.add(g);
    return g;
  };
  const mesh = (geometry, m, parent, name, pos) => {
    const object = new THREE.Mesh(ownGeometry(geometry), m);
    object.name = name;
    if (pos) object.position.set(...pos);
    object.receiveShadow = !m.transparent;
    parent.add(object);
    return object;
  };
  const box = (parent, name, size, pos, m, bevel = 0.008) =>
    mesh(softBox(...size, bevel), m, parent, name, pos);
  const section = (part) => { cutawayParts.push(part); return part; };
  const linkDirection = new THREE.Vector3();
  const between = (part, a, b) => {
    part.position.copy(a).lerp(b, 0.5);
    linkDirection.subVectors(b, a);
    part.scale.y = linkDirection.length();
    part.quaternion.setFromUnitVectors(UP, linkDirection.normalize());
  };
  const unitRod = new THREE.CylinderGeometry(1, 1, 1, 8);
  const rod = (parent, name, radius, m, top, bottom) => {
    const part = mesh(unitRod, m, parent, name);
    part.scale.set(radius, 1, radius);
    if (top) between(part, v(top), v(bottom));
    return part;
  };
  const paint = ownMaterial(new THREE.MeshPhysicalMaterial({
    name: "King Long solid white enamel", color: 0xf6f5ee, vertexColors: true, roughness: 0.42,
    metalness: 0.04, clearcoat: 0.48, clearcoatRoughness: 0.29, envMapIntensity: 0.64,
  }));
  const black = material("black molded trim", 0x171b1e, { roughness: 0.86 });
  const well = material("wheelhouse liner", 0x25292b, { side: THREE.DoubleSide });
  const seam = material("recessed seams", 0x67696a, { roughness: 0.91 });
  const satin = material("satin silver", 0xc3c8cc, { roughness: 0.32, metalness: 0.46, envMapIntensity: 0.76 });
  const reflector = material("lamp reflector", 0xd7e3e8, { roughness: 0.26, metalness: 0.29 });
  const amber = material("indicator lens", 0xf2a544, { roughness: 0.35, emissive: 0x85490c, emissiveIntensity: 0.25 });
  const rubber = material("road tire", 0x252729, { roughness: 0.91 });
  const gearMetal = material("galvanized running gear", 0x929a9c, { metalness: 0.38, roughness: 0.58 });
  const lining = material("cabin headliner", 0xa9a59a);
  const dash = material("dashboard charcoal", 0x333739);
  const upholstery = material("blue-gray seating cloth", 0x4d565a);
  const inserts = material("weave panels", 0x778389);
  const glass = (label, color, opacity) => ownMaterial(new THREE.MeshPhysicalMaterial({
    name: `King Long ${label}`, color, opacity, transparent: true, depthWrite: false,
    side: THREE.FrontSide, roughness: 0.26, metalness: 0.08,
    clearcoat: 0.77, clearcoatRoughness: 0.25, envMapIntensity: 0.54,
  }));
  const windshield = glass("smoke windshield", 0x26373e, 0.73);
  const frontSideGlass = glass("smoke front side glass", 0x253137, 0.82);
  const privacyGlass = glass("passenger privacy glass", 0x18272d, 0.92);
  const hatchGlass = glass("dark hatch glass", 0x18242a, 0.94);
  const root = group(null, "player-vehicle");
  const chassis = group(root, "player-chassis");
  const shell = section(group(chassis, "king-long-shell"));

  function panel(name, geometry, m = paint, deform = false) {
    if (deform || m === paint) {
      const count = geometry.attributes.position.count;
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
    }
    const part = mesh(geometry, m, shell, name);
    part.castShadow = m === paint;
    if (deform) {
      const { position, normal } = geometry.attributes;
      const mobility = Float32Array.from({ length: position.count },
        (_, i) => clamp((belt - position.getY(i)) / 0.23, 0, 1));
      bodyPanels.push({ part, pristine: position.array.slice(), normals: normal.array.slice(), mobility });
    }
    return part;
  }

  // Lower-body cross sections: [height, half-width, setback from the bumper datum, corner wrap].
  const frontRows = [
    [sill, halfWidth - 0.086, 0.098, 0.114], [0.405, halfWidth - 0.041, 0.042, 0.134],
    [0.485, halfWidth - 0.015, 0.009, 0.148], [0.556, halfWidth - 0.004, 0, 0.151],
    [0.650, halfWidth, 0.011, 0.145], [0.700, halfWidth, 0.031, 0.14],
    [0.840, halfWidth, 0.049, 0.124], [0.995, halfWidth, 0.062, 0.115],
    [1.085, halfWidth - 0.006, 0.084, 0.112], [1.155, halfWidth - 0.011, 0.125, 0.108],
    [belt, halfWidth - 0.019, 0.235, 0.105],
  ];
  const rearRows = frontRows.map(([y, w], i) => [y, w,
    [0.075, 0.025, 0, 0, 0.012, 0.027, 0.034, 0.041, 0.045, 0.053, 0.067][i],
    [0.11, 0.126, 0.131, 0.132, 0.127, 0.121, 0.118, 0.116, 0.11, 0.11, 0.11][i]]);
  const widths = [...frontRows, [shoulder, halfWidth - 0.098]];
  const widthAt = (y) => interpolate(widths, y, 1);
  const end = (rear) => {
    const rows = rear ? rearRows : frontRows, sign = rear ? -1 : 1;
    return (u, y, lift = 0) => {
      const t = clamp((y - belt) / (shoulder - belt), 0, 1);
      const setback = t ? mix(rows.at(-1)[2], rear ? 0.158 : 0.78, t) : interpolate(rows, y, 2);
      const wrap = t ? rows.at(-1)[3] : interpolate(rows, y, 3);
      return [u * widthAt(y), y, sign * (halfLength - setback - wrap * Math.abs(u) ** 5 + lift)];
    };
  };
  const front = end(false), rear = end(true);
  const yStops = frontRows.map(([y]) => y);
  const full = () => [-1, 1];
  function patch(name, map, flip, label, m, lift = 0.004, deform = true) {
    const s = panelShape(...label);
    return panel(name, endBand((u, y) => map(u, y, lift), s.rows, s.limits, flip), m, deform);
  }

  for (const [label, map, flip] of [["front", front, false], ["rear", rear, true]]) {
    panel(`king-long-${label}-bumper`, endBand(map, yStops.slice(0, 6), full, flip), paint, true);
    panel(`king-long-${label}-fascia`, endBand(map, yStops.slice(5), full, flip), paint, true);
    patch(`king-long-${label}-bumper-strip`, map, flip, [0, 0.667, 2, 0.045, 0.004, 0.012], black);
  }

  function endGlass(name, map, flip, outer, inner, glassMaterial) {
    panel(`king-long-${name}-white-frame`, windowFrame(map, outer, outer, flip, belt, shoulder, true));
    panel(`king-long-${name}-gasket`, windowFrame((u, y) => map(u, y, 0.002),
      outer, inner, flip), black);
    panel(`king-long-${name}`, endBand((u, y) => map(u, y, 0.003),
      inner.rows, inner.limits, flip), glassMaterial);
  }
  endGlass("windshield", front, false,
    panelShape(0, 1.579, 1.917, 0.629, 0.106, 0.054),
    panelShape(0, 1.579, 1.873, 0.602, 0.106, 0.046), windshield);
  endGlass("hatch-glass", rear, true,
    panelShape(0, 1.593, 1.69, 0.511, 0.073, 0.055),
    panelShape(0, 1.593, 1.641, 0.484, 0.066, 0.05), hatchGlass);

  const roofSteps = [0, 0.008, 0.022, 0.044, 0.072, 0.14, 0.5, 0.86, 0.928, 0.956, 0.978, 0.992, 1];
  const roof = (u, t, inside = false) => {
    const rise = Math.sqrt(1 - (1 - Math.min(1, t / 0.072, (1 - t) / 0.072)) ** 2);
    return [u * widthAt(shoulder), shoulder + (heightM - shoulder) * rise *
      (1 - Math.abs(u) ** 5) - (inside ? 0.022 : 0),
    mix(rear(u, shoulder)[2], front(u, shoulder)[2], t)];
  };
  panel("king-long-rounded-white-roof", grid(ACROSS, roofSteps, (u, t) => roof(u, t), true));
  mesh(grid(ACROSS, roofSteps, (u, t) => roof(u * 0.985, t, true)),
    lining, shell, "king-long-interior-headliner");

  const archProfile = [
    { z: rearAxle, r: wheelRadiusM + 0.073 },
    { z: frontAxle, r: wheelRadiusM + 0.1 },
  ];
  const archY = (z, c, r) => wheelRadiusM + Math.sqrt(Math.max(0, r * r - (z - c) ** 2));
  const lowerY = (z) => Math.max(sill, ...archProfile.map(({ z: c, r }) => archY(z, c, r)));
  const archSamples = (z, r) => {
    const a = Math.acos((sill - wheelRadiusM) / r);
    return Array.from({ length: 19 }, (_, i) => z + r * Math.sin(mix(-a, a, i / 18)));
  };
  const sideStops = sorted([-2.135, -1.78, -0.580, -0.55, -0.25, 0.1, 0.42, 0.69, 0.73,
    0.81, 1.01, 2.025, ...archProfile.flatMap(({ z, r }) => archSamples(z, r))]);
  function sideMap(side, z, y, lift = 0) { return [side * (widthAt(y) + lift), y, z]; }

  for (const side of [-1, 1]) {
    const label = side < 0 ? "left" : "right", flip = side > 0;
    const map = (z, y, lift) => sideMap(side, z, y, lift);
    panel(`king-long-${label}-sill-and-arches`, grid(
      [-3, ...sideStops, 3], yStops,
      (nominalZ, row) => {
        const y = Math.max(row, lowerY(nominalZ));
        const z = nominalZ === -3 ? rear(1, y)[2] : nominalZ === 3 ? front(1, y)[2] : nominalZ;
        return map(z, y);
      }, flip), paint, true);
    const archReturns = archProfile.map(({ z, r }) => grid(archSamples(z, r), [0, 1], (u, t) => {
      const y = archY(u, z, r);
      return [side * mix(widthAt(y), 0.47, t), y + 0.008 * t, u];
    }, flip));
    panel(`king-long-${label}-wheelhouse-returns`, merged(archReturns), well, true);

    const outline = [[rear(1, belt)[2], belt], [front(1, belt)[2], belt],
      [front(1, shoulder)[2], shoulder], [rear(1, shoulder)[2], shoulder]];
    const openings = [
      ["front-door", [[0.729, 1.303], [1.941, 1.263], [1.930, 1.338], [1.523, 1.862],
        [0.729, 1.862]], frontSideGlass],
      ["middle-passenger", [[-0.795, 1.345], [0.665, 1.345], [0.665, 1.862],
        [-0.795, 1.862]], privacyGlass],
      ["rear-passenger", [[-2.084, 1.345], [-0.852, 1.345], [-0.852, 1.862],
        [-2.034, 1.862]], privacyGlass],
    ].map(([name, p, m]) => {
      const [x, y] = [0, 1].map((d) => p.reduce((sum, a) => sum + a[d], 0) / p.length);
      return { name, m, outer: soften(p, 0.055),
        inner: soften(p.map(([z, h]) => [mix(z, x, 0.021), mix(h, y, 0.054)]), 0.047) };
    });
    panel(`king-long-${label}-pillars`, polygon(outline, openings.map((s) => s.outer), map, flip));
    for (const opening of openings) {
      panel(`king-long-${label}-${opening.name}-gasket`,
        polygon(opening.outer, [opening.inner], (z, y) => map(z, y, 0.002), flip), black);
      panel(`king-long-${label}-${opening.name}-glass`,
        polygon(opening.inner, [], (z, y) => map(z, y, 0.0035), flip), opening.m);
    }
    const sideLine = (p, width, lift) => stroke(p, width, (z, y) => map(z, y, lift), flip);
    const molding = [[-2.155, side > 0 ? -0.58 : 0.703], ...(side > 0 ? [[-0.57, 0.703]] : []),
      [0.715, 2.066]].map(([a, b]) => sideLine([[a, 0.784], [b, 0.784]], 0.038, 0.006));
    molding.push(sideLine([[rear(1, 0.667)[2], 0.667], [-2.064, 0.667]], 0.044, 0.005),
      sideLine([[1.985, 0.667], [front(1, 0.667)[2], 0.667]], 0.044, 0.005));
    panel(`king-long-${label}-slender-rubbing-strips`, merged(molding), black, true);
    panel(`king-long-${label}-front-door-shutline`, sideLine([
      [0.695, 1.246], [0.695, 0.506], [0.729, 0.438], [1.115, 0.438],
      [1.131, 0.54], [1.195, 0.686], [1.366, 0.758], [1.62, 0.769], [1.875, 0.776],
      [1.945, 0.902], [1.974, 1.214],
    ], 0.0045, 0.001), seam, true);
    if (side > 0) {
      panel("king-long-sliding-door-shutline", sideLine([
        [0.681, 1.328], [0.681, 1.06], [0.681, 0.478], [0.642, 0.431], [-0.543, 0.431],
        [-0.575, 0.467], [-0.575, 0.578], [-0.78, 0.753], [-0.812, 0.991], [-0.822, 1.329],
      ], 0.005, 0.0015), seam, true);
      panel("king-long-sliding-door-guide-channel", sideLine(
        [[-2.01, 1.129], [-1.97, 1.137], [-0.846, 1.137]], 0.012, 0.002), seam, true);
    }
    const handles = [softBox(0.018, 0.035, 0.146, 0.007).translate(...map(0.864, 1.181, 0.004))];
    if (side > 0) handles.push(softBox(0.018, 0.036, 0.162, 0.007).translate(...map(0.522, 1.181, 0.004)));
    panel(`king-long-${label}-door-handles`, merged(handles), black);
    const mirror = group(shell, `king-long-${label}-mirror`);
    const stalk = rod(mirror, `king-long-${label}-mirror-stalk`, 0.022, black,
      [side * 0.801, 1.326, 1.895], [side * 0.9, 1.374, 1.878]);
    stalk.castShadow = true;
    const housing = box(mirror, `king-long-${label}-mirror-housing`, [0.132, 0.138, 0.075],
      [side * 0.902, 1.408, 1.877], black, 0.025);
    housing.castShadow = true;
    box(mirror, `king-long-${label}-mirror-glass`, [0.113, 0.107, 0.008],
      [side * 0.902, 1.408, 1.838], satin, 0.002);
  }

  patch("king-long-slim-black-grille", front, false, [0, 0.920, 0.766, 0.122, 0.055, 0.023], black);
  const grilleSlats = [0.884, 0.920, 0.956].map((y) => {
    const shape = panelShape(0, y, 0.675, 0.009, 0.017, 0.0028);
    return endBand((u, yy) => front(u, yy, 0.006), shape.rows, shape.limits, false);
  });
  panel("king-long-satin-grille-slats", merged(grilleSlats), satin, true);
  patch("king-long-lower-pill-intake", front, false, [0, 0.466, 0.935, 0.131, 0.091, 0.065], black);
  for (const y of [0.445, 0.482])
    patch(`king-long-lower-intake-vane-${y}`, front, false, [0, y, 0.709, 0.007, 0.014, 0.0025], dash, 0.006);
  const lamps = {
    head: new Map(), tail: new Map(),
    high: material("high brake lens", 0xbd2023, { emissive: 0x8c1414, emissiveIntensity: 0.4 }),
  };
  for (const side of [-1, 1]) {
    const part = side < 0 ? "Left" : "Right", label = part.toLowerCase();
    const head = material(`${label} clear lens`, 0xe7f0f3,
      { roughness: 0.23, metalness: 0.24, emissive: 0x9ba9aa, emissiveIntensity: 0.58 });
    const stop = material(`${label} red tail lens`, 0xbd2023,
      { roughness: 0.3, emissive: 0xb41720, emissiveIntensity: 0.53 });
    lamps.head.set(`headlamp${part}`, head);
    lamps.tail.set(`tailLamp${part}`, stop);
    patch(`king-long-${label}-headlight-seal`, front, false, [side * 0.658, 0.914, 0.535, 0.181, 0.061, 0.039], black);
    patch(`king-long-${label}-headlight-reflector`, front, false, [side * 0.636, 0.914, 0.448, 0.154, 0.038, 0.028], reflector, 0.008);
    patch(`king-long-${label}-headlight-main`, front, false, [side * 0.535, 0.920, 0.21, 0.128, 0.026, 0.019], head, 0.011);
    patch(`king-long-${label}-headlight-secondary`, front, false, [side * 0.729, 0.920, 0.149, 0.128, 0.028, 0.018], head, 0.01);
    patch(`king-long-${label}-headlight-indicator`, front, false, [side * 0.871, 0.917, 0.091, 0.123, 0.026, 0.028], amber, 0.009);
    patch(`king-long-${label}-fog-pocket`, front, false, [side * 0.712, 0.472, 0.193, 0.087, 0.034, 0.021], black);
    patch(`king-long-${label}-fog-lamp`, front, false, [side * 0.712, 0.473, 0.129, 0.048, 0.015, 0.011], reflector, 0.008);

    patch(`king-long-${label}-vertical-tail-light-seal`, rear, true, [side * 0.921, 1.256, 0.144, 0.405, 0.034, 0.048], black, 0.005);
    patch(`king-long-${label}-vertical-tail-light`, rear, true, [side * 0.921, 1.283, 0.105, 0.314, 0.02, 0.032], stop, 0.01);
    patch(`king-long-${label}-reverse-light`, rear, true, [side * 0.921, 1.099, 0.094, 0.043, 0.019, 0.011], reflector, 0.01);
  }
  patch("king-long-high-brake-lamp", rear, true, [0, 1.875, 0.291, 0.025, 0.014, 0.007], lamps.high, 0.005, false);
  patch("king-long-tailgate-handle", rear, true, [0, 1.144, 0.275, 0.039, 0.023, 0.012], black);
  patch("king-long-blank-tailgate-recess", rear, true, [0, 0.867, 0.47, 0.114, 0.034, 0.018], dash);
  const tailgate = soften([[-0.812, 1.883], [0.812, 1.883], [0.873, 0.771], [-0.873, 0.771]], 0.09);
  tailgate.push(tailgate[0]);
  panel("king-long-tailgate-shutline", stroke(tailgate, 0.004, (u, y) => rear(u, y, 0.005), true), seam, true);
  panel("king-long-windscreen-wipers", merged([
    stroke([[-0.23, 1.259], [-0.58, 1.344], [-0.91, 1.371]], 0.016, (u, y) => front(u, y, 0.012), false),
    stroke([[0.605, 1.263], [0.235, 1.336], [-0.172, 1.357]], 0.016, (u, y) => front(u, y, 0.012), false),
  ]), black);

  const cabin = group(chassis, "king-long-cabin");
  box(cabin, "king-long-cabin-floor", [1.28, 0.072, 4.248], [0, 0.697, -0.033], dash, 0.023);
  const seatBases = [], cushions = [], fabric = [];
  for (const side of [-1, 1]) {
    seatBases.push(softBox(0.4, 0.15, 0.38, 0.023).translate(side * 0.381, 0.805, 1.047));
    cushions.push(softBox(0.432, 0.109, 0.402, 0.035).translate(side * 0.381, 0.926, 1.065),
      softBox(0.418, 0.475, 0.112, 0.043).rotateX(-0.15).translate(side * 0.381, 1.141, 0.876),
      softBox(0.213, 0.13, 0.085, 0.035).translate(side * 0.381, 1.425, 0.848));
    fabric.push(softBox(0.315, 0.35, 0.021, 0.007).rotateX(-0.15)
      .translate(side * 0.381, 1.157, 0.934),
    softBox(0.32, 0.021, 0.283, 0.007).translate(side * 0.381, 0.978, 1.09));
  }
  for (const [i, z] of [[0, 0.035], [1, -0.747], [2, -1.534]]) {
    const row = group(cabin, `king-long-passenger-bench-${i + 1}`, [0, 0, z]);
    box(row, "king-long-bench-plinth", [1.23, 0.148, 0.33], [0, 0.802, -0.018], dash, 0.023);
    mesh(merged([
      softBox(1.285, 0.106, 0.377, 0.033).translate(0, 0.942, 0),
      softBox(1.259, 0.383, 0.107, 0.047).rotateX(-0.135).translate(0, 1.13, -0.151),
    ]), upholstery, row, "king-long-bench-upholstery");
    mesh(merged([-0.413, 0, 0.413].flatMap((x) => [
      softBox(0.377, 0.022, 0.288, 0.008).translate(x, 0.995, 0.013),
      softBox(0.374, 0.295, 0.023, 0.008).rotateX(-0.135).translate(x, 1.14, -0.091),
    ])), inserts, row, "king-long-bench-cushion-insets");
  }
  mesh(merged(seatBases), dash, cabin, "king-long-front-seat-pedestals");
  mesh(merged(cushions), upholstery, cabin, "king-long-front-seats");
  mesh(merged(fabric), inserts, cabin, "king-long-front-seat-inserts");
  const dashboard = group(cabin, "cockpit-dashboard", [0, 1.199, 1.82]);
  box(dashboard, "king-long-dash-molding", [1.47, 0.227, 0.367], [0, 0, 0], dash, 0.061);
  box(dashboard, "king-long-dash-instrument-hood", [0.432, 0.092, 0.226],
    [-0.38, 0.103, -0.06], black, 0.026);
  const vents = [-0.661, -0.156, -0.038, 0.647].flatMap((x) =>
    [-0.014, 0.006, 0.026].map((y) => softBox(0.094, 0.009, 0.011, 0.002)
      .translate(x, y, -0.184)));
  mesh(merged(vents), black, dashboard, "king-long-dash-vent-louvers");
  const displayMaterial = ownMaterial(new THREE.MeshBasicMaterial({ color: 0x415944 }));
  const display = mesh(new THREE.PlaneGeometry(0.186, 0.067), displayMaterial, dashboard,
    "king-long-instrument-display", [-0.38, 0.097, -0.174]);
  display.rotation.y = Math.PI;
  mesh(merged([-0.511, -0.249].map((x) => new THREE.TorusGeometry(0.042, 0.005, 6, 20)
    .translate(x, 0.094, -0.174))), satin, dashboard, "king-long-analog-dial-rings");
  const steeringMount = group(cabin, "king-long-steering-column-mount", [-0.387, 1.315, 1.425]);
  steeringMount.rotation.x = 0.53;
  const steering = group(steeringMount, "cockpit-steering");
  const spokes = [0, 2.2, 4.083].map((a) =>
    softBox(0.041, 0.14, 0.026, 0.008).translate(0, -0.085, 0).rotateZ(a));
  mesh(merged([
    new THREE.TorusGeometry(0.163, 0.016, 9, 32),
    softBox(0.13, 0.104, 0.043, 0.018), ...spokes,
  ]), black, steering, "king-long-three-spoke-steering-wheel");
  rod(cabin, "cockpit-steering-column", 0.034, dash, [-0.387, 1.315, 1.431], [-0.387, 1.17, 1.673]);
  const pedals = [
    softBox(0.092, 0.042, 0.02, 0.006).rotateX(-0.43).translate(-0.433, 0.835, 1.647),
    softBox(0.037, 0.101, 0.019, 0.006).rotateX(-0.39).translate(-0.305, 0.807, 1.682),
  ];
  mesh(merged(pedals), gearMetal, cabin, "king-long-pedals");
  rod(cabin, "king-long-shifter", 0.014, gearMetal, [0.004, 1.131, 1.408], [0.044, 0.849, 1.442]);
  box(cabin, "king-long-shifter-knob", [0.063, 0.053, 0.06], [0.004, 1.13, 1.408], black, 0.019);
  box(shell, "king-long-cabin-rearview", [0.179, 0.053, 0.026], [0.034, 1.771, 1.62], black, 0.009);

  const runningGear = group(chassis, "king-long-underframe");
  mesh(merged([-0.365, 0.365].map((x) =>
    softBox(0.064, 0.103, 3.82, 0.011).translate(x, 0.367, -0.1))), dash, runningGear, "king-long-longitudinal-frame-rails");
  box(runningGear, "king-long-underfloor-engine", [0.564, 0.31, 0.62], [0, 0.48, 1.365], gearMetal, 0.054);
  box(runningGear, "king-long-transmission", [0.223, 0.16, 0.382], [0, 0.377, 0.882], gearMetal, 0.028);
  rod(runningGear, "king-long-propshaft", 0.035, gearMetal, [0, 0.34, 0.733], [0, 0.325, rearAxle]);
  rod(runningGear, "king-long-rear-axle-housing", 0.041, gearMetal, [-0.53, 0.322, rearAxle], [0.53, 0.322, rearAxle]);
  box(runningGear, "king-long-rear-differential", [0.209, 0.181, 0.192], [0, 0.322, rearAxle], gearMetal, 0.04);
  const exhaust = [0.491, 0.28, -halfLength + 0.067];
  box(runningGear, "king-long-underfloor-silencer", [0.197, 0.091, 0.434],
    [exhaust[0], exhaust[1], -1.66], gearMetal, 0.03);
  const tailpipe = new THREE.CylinderGeometry(0.027, 0.027, 0.535, 12, 1, true).rotateX(Math.PI / 2);
  mesh(tailpipe, gearMetal, runningGear, "king-long-single-tailpipe",
    [exhaust[0], exhaust[1], exhaust[2] + 0.2675]);
  chaseHidden.push(runningGear);

  const tire = tireGeometry(wheelRadiusM, wheelWidthM);
  const rim = wheelFace(wheelWidthM);
  const disc = new THREE.CylinderGeometry(0.148, 0.148, 0.018, 24).rotateZ(Math.PI / 2);
  const springGeometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(
    Array.from({ length: 40 }, (_, i) => {
      const t = i / 39, a = t * Math.PI * 10;
      return v([Math.cos(a) * 0.041, t - 0.5, Math.sin(a) * 0.041]);
    })), 40, 0.006, 5);
  const padGeometry = softBox(0.047, 0.066, 0.074, 0.009);
  for (const [key, side, axle] of [
    ["frontLeft", -1, 1], ["frontRight", 1, 1], ["rearLeft", -1, -1], ["rearRight", 1, -1],
  ]) {
    const name = `wheel-${axle > 0 ? "front" : "rear"}-${side < 0 ? "left" : "right"}`;
    const x = side * trackM / 2, z = axle > 0 ? frontAxle : rearAxle;
    const pivot = group(root, name, [x, wheelRadiusM, z]);
    const spin = group(pivot, `${name}-spin`);
    const caliper = group(pivot, `${name}-caliper`);
    mesh(tire, rubber, spin, `${name}-tire`).castShadow = true;
    const face = mesh(rim, satin, spin, `${name}-rim`);
    face.scale.x = side;
    mesh(disc, gearMetal, spin, `${name}-disc`, [side * 0.033, 0, 0]);
    mesh(padGeometry, dash, caliper, `${name}-brake-pad`, [side * 0.021, 0.041, -0.134]);
    const upper = v([side * 0.501, 0.744, z]), lower = v([side * 0.636, 0.347, z]);
    const spring = mesh(springGeometry, gearMetal, root, `${name}-spring`);
    const damper = rod(root, `${name}-damper-body`, 0.026, dash);
    const shaft = rod(root, `${name}-damper-shaft`, 0.012, satin);
    const arm = rod(root, `${name}-lower-arm`, 0.031, gearMetal);
    links.push({ part: damper, upper, lower, damper: true, wheel: pivot },
      { part: shaft, upper, lower, shaft: true, wheel: pivot },
      { part: spring, upper, lower, spring: true, wheel: pivot },
      { part: arm, upper: v([side * 0.352, 0.311, z + 0.072]), lower, wheel: pivot });
    chaseHidden.push(damper, shaft, spring, arm);
    if (axle > 0) {
      const tie = rod(root, `${name}-steering-tie`, 0.015, gearMetal);
      links.push({ part: tie, upper: v([side * 0.255, 0.35, z - 0.14]),
        lower: v([x - side * 0.063, 0.339, z - 0.114]), steering: pivot, wheel: pivot });
      chaseHidden.push(tie);
    }
    wheels.push({ key, pivot, spin, caliper, spring, axle });
  }

  const mounts = getVehicleMounts({ ...body, vehicleModel: KING_LONG_MICROBUS_ID });
  const ranges = [], cameras = [];
  const sensorLens = material("sensor glass", 0x638d8d, { emissive: 0x1d3435, emissiveIntensity: 0.24 });
  const rangeHousing = softBox(0.044, 0.032, 0.033, 0.006).translate(0, 0, -0.018);
  const rangeLens = new THREE.CircleGeometry(0.011, 12);
  for (const mount of [...mounts.ranges, ...mounts.auxiliary]) {
    const { id, position: p } = mount;
    const anchor = section(group(root, `range-mount-${id}`, [p.x, p.y, p.z]));
    anchor.rotation.y = mount.angleDeg * Math.PI / 180;
    mesh(rangeHousing, black, anchor, `range-housing-${id}`);
    const lens = mesh(rangeLens, sensorLens, anchor, `sensor-range-${id}`);
    const side = id.startsWith("side-");
    const face = side ? [Math.sign(p.x) * (widthAt(p.y) - 0.009), p.y, p.z]
      : (p.z > 0 ? front : rear)(p.x / widthAt(p.y), p.y, -0.008);
    section(rod(root, `range-support-${id}`, 0.011, black, face, [p.x, p.y, p.z]));
    ranges.push({ ...mount, lens });
  }
  const cameraHousing = softBox(0.054, 0.039, 0.050, 0.008).translate(0, 0, -0.027);
  const cameraLens = new THREE.CircleGeometry(0.014, 16);
  for (const mount of mounts.cameras) {
    const { id, position: p } = mount;
    const anchor = section(group(root, `camera-mount-${id}`, [p.x, p.y, p.z]));
    anchor.rotation.y = mount.angleDeg * Math.PI / 180;
    mesh(cameraHousing, black, anchor, `${id}-housing`);
    const lens = mesh(cameraLens, sensorLens, anchor, `sensor-${id}`);
    const tip = id === "front-camera" ? [0, 1.916, front(0, 1.916)[2] - 0.065]
      : [0, p.y, rear(0, p.y)[2] + 0.007];
    section(rod(root, `${id}-support`, 0.012, black, tip, [p.x, p.y, p.z]));
    cameras.push({ ...mount, lens });
  }
  const telemetryPoint = mounts.telemetry.position;
  const telemetry = section(group(root, "sensor-roof-imu-gnss", [telemetryPoint.x, telemetryPoint.y, telemetryPoint.z]));
  box(telemetry, "king-long-compact-roof-telemetry", [0.098, 0.028, 0.083],
    [0, -0.013, 0], lining, 0.009);
  box(telemetry, "king-long-roof-telemetry-foot", [0.061, 0.014, 0.056],
    [0, -0.027, 0], dash, 0.004);

  function updateLights(states, brake) {
    for (const [key, lamp] of lamps.head) {
      const state = states[key];
      lamp.color.setHex(state === "shattered" ? 0x303435 : state === "cracked" ? 0x8e8477 : 0xe7f0f3);
      lamp.emissiveIntensity = state === "shattered" ? 0 : state === "cracked" ? 0.16 : 0.58;
    }
    for (const [key, lamp] of lamps.tail) {
      const state = states[key];
      lamp.color.setHex(state === "shattered" ? 0x392020 : state === "cracked" ? 0x863330 : 0xbd2023);
      lamp.emissiveIntensity = state === "shattered" ? 0 : state === "cracked" ? 0.17 + brake * 0.3 : 0.53 + brake * 1.25;
    }
    lamps.high.emissiveIntensity = 0.4 + brake * 1.4;
  }

  return {
    root, chassis, wheels, links, bodyPanels, cutawayParts, chaseHidden, exhaust,
    updateLights, litDamageParts: new Set([...lamps.head.keys(), ...lamps.tail.keys()]),
    cockpit: { steering, dashboard, displayMaterial },
    sensors: { ranges, cameras, telemetry },
    resources: { geometries, materials, textures },
    kit: { mesh, ownGeometry, ownMaterial, between },
  };
}
