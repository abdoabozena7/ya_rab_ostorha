import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { getVehicleMounts, KING_LONG_MICROBUS, KING_LONG_MICROBUS_ID } from "../core/vehicle-spec.js";

const UP = new THREE.Vector3(0, 1, 0);
const v = (p) => new THREE.Vector3(...p);
const mix = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;
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
    [r, -0.26], [r, -0.178], [r - 0.005, -0.148], [r, -0.116],
    [r, -0.025], [r - 0.005, 0], [r, 0.025],
    [r, 0.116], [r - 0.005, 0.148], [r, 0.178], [r, 0.26],
    [r * 0.977, 0.38], [r * 0.91, 0.47], [r * 0.77, 0.5], [0.184, 0.46],
  ];
  // Keep the tire's clean LatheGeometry profile and add subtle recessed tread grooves (strictly inside radius r, keeping wheelFace spokes cleanly ray-hittable)
  return new THREE.LatheGeometry(profile.map(([radius, t]) => new THREE.Vector2(radius, t * w)), 36)
    .rotateZ(-Math.PI / 2);
}

function wheelFace(w) {
  const dish = [[0.185, -0.066], [0.187, w * 0.395], [0.1915, w * 0.448],
    [0.188, w * 0.486], [0.174, w * 0.488], [0.171, w * 0.42], [0.174, w * 0.385], [0.174, -0.066]];
  const parts = [
    new THREE.LatheGeometry(dish.map(([r, x]) => new THREE.Vector2(r, x)), 36).rotateZ(-Math.PI / 2),
    // Recessed sculpted center hub dish + raised King Long center cap
    new THREE.CylinderGeometry(0.068, 0.074, 0.022, 24).rotateZ(-Math.PI / 2).translate(w * 0.365, 0, 0),
    new THREE.CylinderGeometry(0.036, 0.041, 0.032, 20).rotateZ(-Math.PI / 2).translate(w * 0.415, 0, 0),
  ];
  // 10-spoke (5 split twin-spoke) alloy wheel pattern matching the King Long reference photos
  // Offset by +0.18 rad so one spoke sits directly at 12 o'clock (y = 0.43) while gaps reveal the dark brake/barrel behind
  for (let i = 0; i < 5; i++) {
    const baseAngle = i * (Math.PI * 2) / 5;
    for (const spread of [0, 0.34]) {
      const a = baseAngle + spread;
      parts.push(softBox(0.022, 0.128, 0.024, 0.004).rotateZ(0.105)
        .translate(w * 0.415, 0.115, 0).rotateX(a));
    }
  }
  // 5 recessed lug nuts in chrome finish
  for (let i = 0; i < 5; i++) {
    const a = i * (Math.PI * 2) / 5 + Math.PI / 5;
    parts.push(new THREE.CylinderGeometry(0.0095, 0.0105, 0.016, 6)
      .rotateZ(Math.PI / 2).translate(w * 0.432, 0.054 * Math.cos(a), 0.054 * Math.sin(a)));
  }
  return merged(parts);
}

function makeCanvasTexture(width, height, draw) {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  draw(ctx, width, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function makeEmblemTexture() {
  return makeCanvasTexture(256, 160, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, rx = w * 0.44, ry = h * 0.41;
    // Outer chrome oval bezel
    const grad = ctx.createLinearGradient(0, cy - ry, 0, cy + ry);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.42, "#b8c0c8");
    grad.addColorStop(0.55, "#59626a");
    grad.addColorStop(1, "#e5eaee");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Stylized King Long chevron-K inside the oval
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx - rx * 0.56, cy);
    ctx.lineTo(cx + rx * 0.28, cy - ry * 0.52);
    ctx.lineTo(cx + rx * 0.48, cy - ry * 0.42);
    ctx.lineTo(cx - rx * 0.16, cy);
    ctx.lineTo(cx + rx * 0.52, cy + ry * 0.45);
    ctx.lineTo(cx + rx * 0.26, cy + ry * 0.54);
    ctx.closePath();
    ctx.fill();
    // Inner secondary wing accent
    ctx.beginPath();
    ctx.moveTo(cx - rx * 0.04, cy - ry * 0.05);
    ctx.lineTo(cx + rx * 0.58, cy - ry * 0.12);
    ctx.lineTo(cx + rx * 0.48, cy + ry * 0.09);
    ctx.closePath();
    ctx.fill();
  });
}

function makeWordmarkTexture() {
  return makeCanvasTexture(512, 96, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, 14, 0, h - 14);
    grad.addColorStop(0, "#3b4248");
    grad.addColorStop(0.45, "#15191d");
    grad.addColorStop(0.58, "#7b848e");
    grad.addColorStop(1, "#121619");
    ctx.fillStyle = grad;
    ctx.font = "italic 900 58px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("KING LONG", w / 2, h / 2 + 2);
  });
}

function makeModelBadgeTexture() {
  return makeCanvasTexture(256, 72, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#2b3137";
    ctx.font = "800 34px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("XMQ6520", w / 2, h / 2 + 1);
  });
}

// [optical U, bottom across, top across, bottom height, top height].
// Across 1 is the fender seam; values past it turn rearward along the side skin.
const HEADLIGHT_PROFILE = [
  [0, .492, .520, .840, .877],
  [.032, .505, .543, .821, .915],
  [.095, .545, .581, .815, .954],
  [.21, .614, .649, .815, .984],
  [.39, .714, .736, .818, 1.004],
  [.58, .820, .839, .823, 1.016],
  [.72, .918, .926, .827, 1.021],
  [.84, 1, 1, .831, 1.018],
  [.94, 1.093, 1.088, .836, 1.013],
  [.985, 1.130, 1.122, .845, 1.002],
  [1, 1.144, 1.135, .863, .986],
];

function headlightGeometry(front, side, cover) {
  const rows = [0, .17, .39, .62, .84, 1];
  const geometry = grid(HEADLIGHT_PROFILE, rows, ([u, low, high, bottom, top], row) => {
    const across = mix(low, high, row) + (cover ? (u === 0 ? .008 : u === 1 ? -.008 : 0) : 0);
    const y = mix(bottom, top, row) + (cover ? mix(.005, -.005, row) : 0);
    const fender = Math.min(1, across);
    const point = front(side * fender, y);
    const lift = cover ? .007 + .005 * Math.sin(Math.PI * u) * Math.sin(Math.PI * row) : .003;
    point[0] += side * lift * fender ** 4;
    point[2] += lift * (1 - .75 * fender ** 6) - Math.max(0, across - 1) * .85;
    return point;
  }, side < 0);
  if (cover) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(
    rows.flatMap((row) => HEADLIGHT_PROFILE.flatMap(([u]) => [u, row])), 2));
  return geometry;
}

function makeHeadlightTexture() {
  return makeCanvasTexture(512, 256, (ctx, w, h) => {
    ctx.scale(w, h);
    const tones = (stops) => {
      const gradient = ctx.createLinearGradient(0, 0, 0, 1);
      for (const [at, color] of stops) gradient.addColorStop(at, color);
      return gradient;
    };
    const face = (points, fill) => {
      ctx.beginPath();
      points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    ctx.fillStyle = tones([[0, "#37424a"], [.16, "#75848f"], [.39, "#a9b5be"],
      [.56, "#505e68"], [.78, "#9aa7ad"], [1, "#3d4952"]]);
    ctx.fillRect(0, 0, 1, 1);
    const silver = tones([[.09, "#71818a"], [.30, "#e4ecef"], [.49, "#899aa7"],
      [.72, "#bec9ce"], [.85, "#5e707b"], [1, "#b8c2c9"]]);
    face([[.105, .20], [.44, .09], [.70, .16], [.74, .55], [.67, .89], [.26, .88]], silver);
    face([[.151, .25], [.44, .12], [.67, .18], [.54, .35], [.32, .36]], "#d7dfe2");
    face([[.27, .44], [.53, .42], [.69, .31], [.68, .55], [.52, .65], [.32, .62]], "#586b7a");
    face([[.33, .71], [.56, .62], [.70, .59], [.65, .76], [.44, .88]], "#e1e7eb");
    face([[.775, .12], [.958, .11], [1, .32], [.993, .59], [.792, .62]], tones([
      [.10, "#667a86"], [.31, "#303f48"], [.49, "#566570"], [.62, "#172830"],
    ]));
    face([[.775, .10], [.797, .63], [.775, .88], [.749, .86], [.768, .58], [.754, .10]],
      "#bac5cc");
    face([[.788, .595], [.992, .565], [.993, .626], [.791, .654]], "#bac4c8");

    ctx.lineWidth = .004;
    for (let x = .31; x < .96; x += .035) {
      ctx.strokeStyle = x < .76 ? "rgba(47,60,69,.20)" : "rgba(210,223,230,.38)";
      ctx.beginPath();
      ctx.moveTo(x, x < .76 ? .26 : .16);
      ctx.lineTo(x - .016, x < .76 ? .81 : .58);
      ctx.stroke();
    }

    // The small inboard reflector and the low corner repeater share the same clear cover.
    const bulb = ctx.createRadialGradient(.104, .656, .012, .121, .684, .099);
    bulb.addColorStop(0, "#86614c");
    bulb.addColorStop(.52, "#5a4741");
    bulb.addColorStop(.81, "#969fa5");
    bulb.addColorStop(1, "rgba(205,214,220,0)");
    ctx.fillStyle = bulb;
    ctx.fillRect(.024, .585, .200, .239);
    face([[.783, .670], [.974, .640], [.991, .735], [.968, .862],
      [.821, .899], [.775, .827]], tones([
      [.64, "#74321a"], [.71, "#c77626"], [.79, "#9f4b1a"], [.89, "#bb6b21"], [1, "#55271d"],
    ]));
    ctx.save();
    ctx.clip();
    ctx.fillStyle = "rgba(88,36,13,.24)";
    for (let x = .78; x < .99; x += .015) ctx.fillRect(x, .63, .004, .28);
    ctx.restore();
  });
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
  const ownTexture = (t) => { if (t) textures.add(t); return t; };
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
    name: "King Long solid white enamel", color: 0xfbfbfa, vertexColors: true, roughness: 0.24,
    clearcoat: 0.88, clearcoatRoughness: 0.12, envMapIntensity: 0.88,
  }));
  const black = material("black molded trim", 0x15181b, { roughness: 0.68, metalness: 0.06 });
  const mudflapMat = material("rubber mudflap", 0x181b1e, { roughness: 0.88, side: THREE.DoubleSide });
  const well = material("wheelhouse liner", 0x1d2023, { roughness: 0.92, side: THREE.DoubleSide });
  const seam = material("recessed seams", 0xc8ccd0, { roughness: 0.62 });
  const deepCrease = material("deep panel shutline", 0x9aa0a6, { roughness: 0.78 });
  const chrome = ownMaterial(new THREE.MeshPhysicalMaterial({
    name: "King Long mirror chrome", color: 0xe9eef2, roughness: 0.09, metalness: 0.94,
    clearcoat: 0.6, clearcoatRoughness: 0.08, envMapIntensity: 1.35,
  }));
  const satin = ownMaterial(new THREE.MeshPhysicalMaterial({
    name: "King Long alloy silver", color: 0xd5dce2, roughness: 0.24, metalness: 0.68,
    clearcoat: 0.38, clearcoatRoughness: 0.18, envMapIntensity: 0.95,
  }));
  const reflector = ownMaterial(new THREE.MeshPhysicalMaterial({
    name: "King Long lamp reflector", color: 0xe6eff4, roughness: 0.14, metalness: 0.76,
    clearcoat: 0.72, clearcoatRoughness: 0.1, envMapIntensity: 1.15,
  }));
  const amber = material("rear indicator lens", 0xca812e, { roughness: 0.27, metalness: 0.16 });
  const reverseLens = material("clear reverse lens", 0xc3cdd0, { roughness: 0.24, metalness: 0.24 });
  const rubber = material("road tire", 0x1c1e20, { roughness: 0.89 });
  const gearMetal = material("galvanized running gear", 0x767e84, { metalness: 0.45, roughness: 0.52 });
  const lining = material("cabin headliner", 0xb3afa5);
  const dash = material("dashboard charcoal", 0x2a2e32, { roughness: 0.78 });
  const upholstery = material("blue-gray seating cloth", 0x454e54);
  const inserts = material("weave panels", 0x6f7b82);
  // A single dielectric lobe for glass; keep the driver's panes translucent.
  const glass = (label, color, { opacity = 1, ...finish } = {}) => ownMaterial(new THREE.MeshPhysicalMaterial({
    name: `King Long ${label}`, color, opacity, transparent: opacity < 1, depthWrite: opacity === 1,
    side: THREE.FrontSide, roughness: 0.09, envMapIntensity: 1.05, ...finish,
  }));
  const windshield = glass("smoke windshield", 0x162126, { opacity: 0.66 });
  const frontSideGlass = glass("smoke front side glass", 0x152025, { opacity: 0.74 });
  const privacyGlass = glass("passenger privacy glass", 0x10181d);
  const hatchGlass = glass("dark hatch glass", 0x253b43, {
    roughness: 0.40, specularIntensity: 0.24, envMapIntensity: 0.12,
  });
  const root = group(null, "player-vehicle");
  const chassis = group(root, "player-chassis");
  const shell = section(group(chassis, "king-long-shell"));

  function panel(name, geometry, m = paint, deform = false) {
    if (deform || m === paint) {
      const count = geometry.attributes.position.count;
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
    }
    const part = mesh(geometry, m, shell, name);
    part.castShadow = m === paint || (deform && m.vertexColors);
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
  const plateWell = panelShape(0, 0.909, 0.835, 0.262, 0.073, 0.045);
  const plateInset = (across, y) => smoothstep(plateWell.limits(y)[1] - across, 0, 0.082) *
    smoothstep(y, plateWell.lo, 0.819) * (1 - smoothstep(y, 1.008, plateWell.hi));
  const hatchShoulder = y => smoothstep(y, 0.704, 0.766) * (1 - smoothstep(y, 0.797, 0.819));
  const rearSkin = (u, y, lift = 0) => {
    const across = Math.abs(u);
    const sideBlend = 1 - smoothstep(across, 0.82, 1);
    const lowerHatch = 0.032 * smoothstep(y, 0.552, 0.601) * (1 - smoothstep(y, 0.78, 0.826)) +
      0.016 * hatchShoulder(y);
    return rear(u, y, lift - lowerHatch * sideBlend - 0.057 * plateInset(across, y));
  };
  function patch(name, map, flip, label, m, lift = 0.004, deform = true) {
    const s = panelShape(...label);
    return panel(name, endBand((u, y) => map(u, y, lift), s.rows, s.limits, flip), m, deform);
  }

  panel("king-long-front-bumper", endBand(front, yStops.slice(0, 6), full, false), paint, true);
  panel("king-long-front-fascia", endBand(front, yStops.slice(5), full, false), paint, true);
  patch("king-long-front-bumper-strip", front, false, [0, 0.667, 2, 0.044, 0.004, 0.011], black);

  // Both panels sample the same boundary so the stamped hatch stays closed against the bumper.
  const rearColumns = sorted([...ACROSS, ...[-1, 1].flatMap(side =>
    [0.27, 0.315, 0.35, 0.38, 0.41, 0.44, 0.53, 0.73, 0.805, 0.86, 0.89, 0.96].map(u => side * u))]);
  const bumperJoint = 0.575;
  const hatchRows = sorted([bumperJoint, ...yStops.filter(y => y > bumperJoint),
    0.578, 0.601, 0.62, 0.704, 0.74, 0.766, 0.78, 0.797, 0.81, 0.819, 0.826,
    0.963, 1.008, 1.027, ...plateWell.rows]);
  panel("king-long-rear-bumper", grid(rearColumns, [...yStops.filter(y => y < bumperJoint), bumperJoint],
    (u, y) => {
      const point = rearSkin(u, y);
      point[1] += 0.044 * (1 - smoothstep(y, sill, 0.485)) * (1 - smoothstep(Math.abs(u), 0.84, 1));
      return point;
    }, true), paint, true);
  const hatch = grid(rearColumns, hatchRows, rearSkin, true);
  const hatchV = y => (y - bumperJoint) / (belt - bumperJoint);
  hatch.setAttribute("uv", new THREE.Float32BufferAttribute(hatchRows.flatMap(y =>
    rearColumns.flatMap(u => [(u + 1) / 2, hatchV(y)])), 2));
  // Bake just the skylight blocked by the plate well's upper lip, independently of damage colors.
  const aoSize = 64;
  const aoValues = new Uint8Array(aoSize ** 2 * 4);
  for (let index = 0; index < aoSize ** 2; index++) {
    const u = (index % aoSize + 0.5) / aoSize * 2 - 1;
    const y = mix(bumperJoint, belt, (Math.floor(index / aoSize) + 0.5) / aoSize);
    const inset = plateInset(Math.abs(u), y);
    const shoulderShade = 0.17 * hatchShoulder(y) * (1 - smoothstep(Math.abs(u), 0.75, 0.88));
    const value = Math.round(255 * (1 - inset * mix(0.12, 0.49, smoothstep(y, 0.862, 1.008)) - shoulderShade));
    aoValues.set([value, value, value, 255], index * 4);
  }
  const hatchAO = ownTexture(new THREE.DataTexture(aoValues, aoSize, aoSize));
  hatchAO.magFilter = hatchAO.minFilter = THREE.LinearFilter;
  hatchAO.needsUpdate = true;
  const hatchPaint = ownMaterial(paint.clone());
  hatchPaint.aoMap = hatchAO;
  panel("king-long-rear-fascia", hatch, hatchPaint, true);

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
  function taperedHatchWindow(...dimensions) {
    const shape = panelShape(...dimensions);
    return { ...shape, limits: y => shape.limits(y).map(u => u * mix(1, 0.94, (y - shape.lo) / (shape.hi - shape.lo))) };
  }
  endGlass("hatch-glass", rear, true,
    taperedHatchWindow(0, 1.6165, 1.821, 0.605, 0.117, 0.102),
    taperedHatchWindow(0, 1.616, 1.773, 0.58, 0.106, 0.091), hatchGlass);

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
    // Subtle sculpted side swage / character crease along the waist (soft shadow line, matching Ref 1 & 3)
    panel(`king-long-${label}-character-lines`, merged([
      sideLine([[-2.16, 0.965], [1.96, 0.965]], 0.0045, 0.0012),
      sideLine([[-2.16, 0.695], [1.98, 0.695]], 0.005, 0.0012),
    ]), seam, true);
    // Vertical sliding-window dividers inside the middle and rear passenger bays (Ref 1 & 3)
    panel(`king-long-${label}-window-mullions`, merged([
      sideLine([[-0.06, 1.355], [-0.06, 1.852]], 0.016, 0.0055),
      sideLine([[-1.46, 1.355], [-1.46, 1.852]], 0.016, 0.0055),
    ]), black, false);
    // Crisp black front bumper corner wrap & slender trim accents (Ref 1)
    const molding = [
      sideLine([[1.94, 0.667], [front(1, 0.667)[2], 0.667]], 0.042, 0.005),
      sideLine([[1.96, 0.415], [front(1, 0.415)[2], 0.415]], 0.022, 0.004),
    ];
    panel(`king-long-${label}-slender-rubbing-strips`, merged(molding), black, true);
    // Subtle wheel-arch lip brow lines above front & rear arches (Ref 1 & 3)
    const archBrows = archProfile.map(({ z, r }) => {
      const a = Math.acos((0.52 - wheelRadiusM) / (r + 0.026));
      const pts = Array.from({ length: 13 }, (_, i) => {
        const ang = mix(-a, a, i / 12);
        return [z + (r + 0.026) * Math.sin(ang), wheelRadiusM + (r + 0.026) * Math.cos(ang)];
      });
      return sideLine(pts, 0.0055, 0.0015);
    });
    panel(`king-long-${label}-arch-brows`, merged(archBrows), seam, true);
    panel(`king-long-${label}-front-door-shutline`, sideLine([
      [0.695, 1.246], [0.695, 0.506], [0.729, 0.438], [1.115, 0.438],
      [1.131, 0.54], [1.195, 0.686], [1.366, 0.758], [1.62, 0.769], [1.875, 0.776],
      [1.945, 0.902], [1.974, 1.214],
    ], 0.004, 0.0012), deepCrease, true);
    if (side > 0) {
      panel("king-long-sliding-door-shutline", sideLine([
        [0.681, 1.328], [0.681, 1.06], [0.681, 0.478], [0.642, 0.431], [-0.543, 0.431],
        [-0.575, 0.467], [-0.575, 0.578], [-0.78, 0.753], [-0.812, 0.991], [-0.822, 1.329],
      ], 0.0045, 0.0014), deepCrease, true);
      // Iconic bold black horizontal sliding-door track along the right rear quarter (Ref 1)
      panel("king-long-right-sliding-track", sideLine(
        [[-2.07, 1.085], [-0.84, 1.085]], 0.044, 0.006), black, true);
      panel("king-long-sliding-door-guide-channel", sideLine(
        [[-2.05, 1.085], [-0.85, 1.085]], 0.015, 0.008), deepCrease, true);
      // Small black square B-pillar latch / fuel-cap trim detail behind the front right door (Ref 1)
      box(shell, "king-long-right-pillar-vent", [0.014, 0.078, 0.068],
        map(0.76, 1.085, 0.003), black, 0.004);
    }
    // Front door horizontal handle + vertical sliding-door grab handle on right side (Ref 1)
    const handles = [softBox(0.02, 0.036, 0.146, 0.007).translate(...map(0.864, 1.181, 0.005))];
    if (side > 0) {
      handles.push(softBox(0.022, 0.145, 0.046, 0.008).translate(...map(0.522, 1.181, 0.005)));
    }
    panel(`king-long-${label}-door-handles`, merged(handles), black);
    // Chrome-capped wing mirrors with black base bracket & reflective mirror face (Ref 1 & 3)
    const mirror = group(shell, `king-long-${label}-mirror`);
    const mirrorBase = box(mirror, `king-long-${label}-mirror-base`, [0.032, 0.092, 0.088],
      [side * 0.808, 1.335, 1.892], black, 0.008);
    mirrorBase.castShadow = true;
    const stalk = rod(mirror, `king-long-${label}-mirror-stalk`, 0.018, black,
      [side * 0.805, 1.332, 1.892], [side * 0.905, 1.368, 1.874]);
    stalk.castShadow = true;
    const housing = box(mirror, `king-long-${label}-mirror-housing`, [0.148, 0.122, 0.072],
      [side * 0.916, 1.404, 1.878], chrome, 0.026);
    housing.castShadow = true;
    // Lower black bezel trim on mirror housing
    box(mirror, `king-long-${label}-mirror-bezel`, [0.142, 0.036, 0.070],
      [side * 0.916, 1.356, 1.874], black, 0.009);
    box(mirror, `king-long-${label}-mirror-glass`, [0.122, 0.094, 0.008],
      [side * 0.916, 1.404, 1.838], reflector, 0.002);
  }

  const grilleOuter = panelShape(0, 0.920, 0.973, 0.172, 0.088, 0.044);
  const grilleInner = panelShape(0, 0.920, 0.899, 0.132, 0.068, 0.032);
  const grilleFace = (u, y, lift) => {
    const t = (y - grilleOuter.lo) / (grilleOuter.hi - grilleOuter.lo);
    return front(u * mix(.88, 1.12, t), y + .018 * (1 - t) * (2 * u) ** 2, lift);
  };
  panel("king-long-grille-chrome-surround",
    windowFrame((u, y) => grilleFace(u, y, 0.008), grilleOuter, grilleInner, false), chrome, true);
  patch("king-long-slim-black-grille", grilleFace, false, [0, 0.920, 0.897, 0.130, 0.065, 0.030], black, 0.005);
  const grilleSlats = [0.878, 0.905, 0.920, 0.935, 0.962].map((y) => {
    const shape = panelShape(0, y, 0.848, 0.0095, 0.022, 0.0028);
    return endBand((u, yy) => grilleFace(u, yy, 0.009), shape.rows, shape.limits, false);
  });
  panel("king-long-satin-grille-slats", merged(grilleSlats), satin, true);
  // Subtle vertical black louver bars behind the satin grille slats
  const grilleRibs = [-0.32, -0.16, 0, 0.16, 0.32].map((u) => {
    const shape = panelShape(u, 0.920, 0.014, 0.122, 0.003, 0.006);
    return endBand((uu, yy) => grilleFace(uu, yy, 0.007), shape.rows, shape.limits, false);
  });
  panel("king-long-grille-inner-ribs", merged(grilleRibs), dash, true);

  // Lower bumper intake grille with twin horizontal dividers & center plate mount (Ref 1 & 3)
  patch("king-long-lower-pill-intake", front, false, [0, 0.466, 0.945, 0.136, 0.088, 0.056], black, 0.004);
  const bumperTrimWhite = ownMaterial(new THREE.MeshPhysicalMaterial({
    name: "King Long bumper intake trim", color: 0xfbfbfa, roughness: 0.26,
    clearcoat: 0.85, clearcoatRoughness: 0.14, envMapIntensity: 0.85,
  }));
  const intakeBar = panelShape(0, 0.494, 0.895, 0.022, 0.024, 0.006);
  panel("king-long-lower-intake-divider", endBand((u, y) => front(u, y, 0.007), intakeBar.rows, intakeBar.limits, false), bumperTrimWhite, true);
  for (const y of [0.432, 0.478])
    patch(`king-long-lower-intake-vane-${y}`, front, false, [0, y, 0.785, 0.007, 0.014, 0.0025], dash, 0.006);
  // Center white license-plate bracket pad inside lower intake (matches Ref 1 & 3!)
  patch("king-long-front-plate-mount", front, false, [0, 0.448, 0.195, 0.105, 0.014, 0.012], bumperTrimWhite, 0.008, true);
  for (const u of [-0.045, 0.045]) {
    patch(`king-long-front-plate-bolt-${u}`, front, false, [u, 0.472, 0.014, 0.012, 0.003, 0.003], black, 0.013, false);
  }
  patch("king-long-front-tow-port", front, false, [0, 0.422, 0.032, 0.026, 0.008, 0.008], black, 0.013, false);

  // Authentic King Long oval chrome front & rear emblems + rear KING LONG wordmark & model badge (Ref 1, 2, 3)
  const emblemTex = ownTexture(makeEmblemTexture());
  const emblemMat = ownMaterial(new THREE.MeshPhysicalMaterial({
    name: "King Long oval emblem",
    color: emblemTex ? 0xffffff : 0xd5dce2,
    map: emblemTex,
    transparent: Boolean(emblemTex),
    alphaTest: emblemTex ? 0.18 : 0,
    roughness: 0.16,
    metalness: 0.78,
    clearcoat: 0.65,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  }));
  const frontEmblemPos = front(0, 1.078, 0.012);
  const frontEmblemTop = front(0, 1.11, 0.012);
  const frontEmblemPitch = Math.atan2(frontEmblemPos[2] - frontEmblemTop[2], frontEmblemTop[1] - frontEmblemPos[1]);
  const frontEmblem = mesh(new THREE.PlaneGeometry(0.118, 0.074), emblemMat, shell, "king-long-front-emblem", frontEmblemPos);
  frontEmblem.rotation.x = -frontEmblemPitch;
  // Subtle raised 3D chrome oval rim underneath emblem so it reads crisply even in Node/offline tests
  const frontEmblemRim = mesh(new THREE.TorusGeometry(0.046, 0.0055, 8, 24), chrome, shell, "king-long-front-emblem-rim", [frontEmblemPos[0], frontEmblemPos[1], frontEmblemPos[2] - 0.002]);
  frontEmblemRim.scale.set(1.22, 0.76, 0.55);
  frontEmblemRim.rotation.x = -frontEmblemPitch;

  const rearEmblemPos = rearSkin(0, 1.187, 0.011);
  const rearEmblem = mesh(new THREE.PlaneGeometry(0.096, 0.060), emblemMat, shell, "king-long-rear-emblem", rearEmblemPos);
  rearEmblem.rotation.y = Math.PI;
  const rearEmblemRim = mesh(new THREE.TorusGeometry(0.038, 0.0045, 8, 24), gearMetal, shell,
    "king-long-rear-emblem-rim", [rearEmblemPos[0], rearEmblemPos[1], rearEmblemPos[2] + 0.002]);
  rearEmblemRim.scale.set(1.22, 0.76, 0.55);
  rearEmblemRim.rotation.y = Math.PI;

  const wordmarkTex = ownTexture(makeWordmarkTexture());
  const wordmarkMat = ownMaterial(new THREE.MeshStandardMaterial({
    name: "King Long rear wordmark",
    color: wordmarkTex ? 0xffffff : 0x2c3238,
    map: wordmarkTex,
    transparent: Boolean(wordmarkTex),
    alphaTest: wordmarkTex ? 0.14 : 0,
    roughness: 0.25,
    metalness: 0.65,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  }));
  const wordmarkRows = [0, 0.4, 0.75, 1];
  const wordmark = grid(ACROSS, wordmarkRows, (u, t) =>
    rearSkin(-0.58 - 0.249 * u, mix(0.655, 0.738, t), 0.004));
  wordmark.setAttribute("uv", new THREE.Float32BufferAttribute(
    wordmarkRows.flatMap(t => ACROSS.flatMap(u => [(u + 1) / 2, t])), 2));
  panel("king-long-rear-wordmark", wordmark, wordmarkMat, true);

  const modelBadgeTex = ownTexture(makeModelBadgeTexture());
  const modelBadgeMat = ownMaterial(new THREE.MeshStandardMaterial({
    name: "King Long model badge",
    color: modelBadgeTex ? 0xffffff : 0x3b4248,
    map: modelBadgeTex,
    transparent: Boolean(modelBadgeTex),
    alphaTest: modelBadgeTex ? 0.14 : 0,
    roughness: 0.28,
    metalness: 0.6,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  }));
  const modelBadgePos = rearSkin(-0.744, 1.085, 0.010);
  const modelBadgeMesh = mesh(new THREE.PlaneGeometry(0.165, 0.044), modelBadgeMat, shell, "king-long-rear-model-badge", modelBadgePos);
  modelBadgeMesh.rotation.y = Math.PI;

  const headOpticsTex = ownTexture(makeHeadlightTexture());
  const lamps = {
    head: new Map(), tail: new Map(),
    high: ownMaterial(new THREE.MeshPhysicalMaterial({
      name: "King Long high brake lens", color: 0xbd1d20, roughness: 0.18, clearcoat: 0.8,
      emissive: 0x8c1414, emissiveIntensity: 0.42,
    })),
  };
  for (const side of [-1, 1]) {
    const part = side < 0 ? "Left" : "Right", label = part.toLowerCase();
    const head = ownMaterial(new THREE.MeshPhysicalMaterial({
      name: `King Long ${label} clear lens`, color: 0xd7e2e8,
      map: headOpticsTex,
      roughness: 0.18, metalness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.12,
      emissive: 0x78858c, emissiveIntensity: 0.11,
    }));
    const stop = ownMaterial(new THREE.MeshPhysicalMaterial({
      name: `King Long ${label} red tail lens`, color: 0xb8161d,
      roughness: 0.16, metalness: 0.12, clearcoat: 0.92, clearcoatRoughness: 0.08,
      emissive: 0xa4131c, emissiveIntensity: 0.26,
    }));
    lamps.head.set(`headlamp${part}`, head);
    lamps.tail.set(`tailLamp${part}`, stop);
    panel(`king-long-${label}-headlight-seal`, headlightGeometry(front, side, false), black, true);
    panel(`king-long-${label}-headlight-lens`, headlightGeometry(front, side, true), head, true);
    // Recessed square fog lamp pocket with chrome inner bezel & bright reflector (Ref 1 & 3)
    patch(`king-long-${label}-fog-pocket`, front, false, [side * 0.712, 0.472, 0.198, 0.092, 0.030, 0.018], black, 0.004);
    patch(`king-long-${label}-fog-bezel`, front, false, [side * 0.712, 0.473, 0.148, 0.062, 0.018, 0.012], chrome, 0.007);
    patch(`king-long-${label}-fog-lamp`, front, false, [side * 0.712, 0.473, 0.126, 0.048, 0.014, 0.010], reflector, 0.009);

    const tailCenter = side * 0.904, tailWidth = 0.145;
    patch(`king-long-${label}-vertical-tail-light-seal`, rearSkin, true,
      [tailCenter, 1.013, 0.166, 0.367, 0.045, 0.04], black, 0.005);
    const tail = panelShape(tailCenter, 1.013, tailWidth, 0.342, 0.035, 0.03);
    const tailBand = (lo, hi) => endBand(
      (u, y) => rearSkin(u, y, 0.008 + 0.008 * (1 - (2 * (u - tailCenter) / tailWidth) ** 2)),
      sorted([lo, ...tail.rows.filter(y => y > lo && y < hi), hi]), tail.limits, true);
    panel(`king-long-${label}-vertical-tail-light`, merged([
      tailBand(tail.lo, 0.945), tailBand(1.047, tail.hi),
    ]), stop, true);
    panel(`king-long-${label}-tail-amber-band`, tailBand(0.994, 1.044), amber, true);
    panel(`king-long-${label}-reverse-light`, tailBand(0.949, 0.992), reverseLens, true);
  }
  const centerBrake = patch("king-long-high-brake-lamp", rear, true,
    [0, 1.857, 0.265, 0.018, 0.012, 0.006], lamps.high, 0.006, false);
  centerBrake.visible = false;
  const handleShape = new THREE.Shape();
  handleShape.moveTo(-0.368, -0.024);
  handleShape.quadraticCurveTo(-0.356, 0.026, -0.282, 0.032);
  handleShape.lineTo(0.282, 0.032);
  handleShape.quadraticCurveTo(0.356, 0.026, 0.368, -0.024);
  handleShape.closePath();
  const handle = new THREE.ExtrudeGeometry(handleShape, {
    curveSegments: 8, bevelSegments: 2, bevelSize: 0.004, bevelThickness: 0.004, depth: 0.056,
  }).translate(0, 1.061, -0.027);
  const handleVertices = handle.attributes.position;
  for (let i = 0; i < handleVertices.count; i++) {
    const x = handleVertices.getX(i), y = handleVertices.getY(i);
    handleVertices.setZ(i, rear(x / widthAt(y), y, 0.005 - handleVertices.getZ(i))[2]);
  }
  handle.computeVertexNormals();
  panel("king-long-tailgate-handle", handle, black, true);
  patch("king-long-tailgate-keyhole", rear, true, [-0.24, 1.066, 0.017, 0.015, 0.006, 0.006], chrome, 0.039);
  for (const u of [-0.085, 0.085]) {
    patch(`king-long-rear-plate-bolt-${u}`, rearSkin, true, [u, 0.987, 0.014, 0.012, 0.003, 0.003], seam, 0.003);
  }
  const garnishCrease = rearColumns.filter(u => u >= 0.44 && u <= 0.805);
  panel("king-long-tailgate-garnish-crease", merged([-1, 1].map(side =>
    stroke(garnishCrease.map(u => [side * u, 1.043]), 0.0045, (u, y) => rearSkin(u, y, 0.002), true))),
  deepCrease, true);
  // The blade parks low across the glass with its arm attached to the painted hatch.
  panel("king-long-rear-wiper", merged([
    stroke([[0.185, 1.31], [0.112, 1.361], [-0.137, 1.436]], 0.016, (u, y) => rear(u, y, 0.014), true),
    stroke([[-0.015, 1.415], [-0.215, 1.445], [-0.468, 1.471]], 0.013, (u, y) => rear(u, y, 0.016), true),
  ]), black);
  patch("king-long-rear-wiper-pivot", rear, true, [0.185, 1.31, 0.05, 0.039, 0.015, 0.014], black, 0.016, false);
  patch("king-long-rear-washer-nozzle", rear, true, [0, 1.914, 0.022, 0.012, 0.006, 0.004], black, 0.004, false);

  const hatchSide = hatchRows.filter(y => y >= 0.65 && y <= 1.235).map(y =>
    [mix(-0.86, -0.812, (y - 0.65) / (1.235 - 0.65)), y]).reverse();
  hatchSide.push([-0.854, 0.638], [-0.838, 0.611], [-0.812, 0.59], [-0.782, 0.581]);
  const tailgate = [...hatchSide, ...rearColumns.filter(u => Math.abs(u) <= 0.73).map(u => [u, 0.578]),
    ...hatchSide.slice().reverse().map(([u, y]) => [-u, y])];
  panel("king-long-tailgate-shutline", stroke(tailgate, 0.009, (u, y) => rearSkin(u, y, 0.003), true), deepCrease, true);
  // Front windshield wipers + twin washer nozzles along lower cowl (Ref 1 & 3)
  panel("king-long-windscreen-wipers", merged([
    stroke([[-0.23, 1.259], [-0.58, 1.344], [-0.91, 1.371]], 0.017, (u, y) => front(u, y, 0.012), false),
    stroke([[0.605, 1.263], [0.235, 1.336], [-0.172, 1.357]], 0.017, (u, y) => front(u, y, 0.012), false),
  ]), black);
  for (const u of [-0.36, 0.32]) {
    patch(`king-long-front-washer-${u}`, front, false, [u, 1.248, 0.022, 0.016, 0.005, 0.005], black, 0.011, false);
  }

  // Molded black rubber mudflaps behind all 4 wheels + visible rear underbody spare tire (Ref 1 & 2)
  const mudflapParts = [];
  for (const side of [-1, 1]) {
    // Rear mudflaps hang cleanly behind rear wheel arch (prominent in Ref 2, extending subtly below bumper!)
    mudflapParts.push(
      softBox(0.245, 0.30, 0.022, 0.005)
        .rotateX(0.05)
        .translate(side * (trackM / 2 + 0.018), 0.255, rearAxle - wheelRadiusM - 0.058),
    );
    // Front mudflaps tucked neatly behind front wheel arch (Ref 1)
    mudflapParts.push(
      softBox(0.205, 0.225, 0.018, 0.004)
        .rotateX(0.07)
        .translate(side * (trackM / 2 + 0.010), 0.275, frontAxle - wheelRadiusM - 0.070),
    );
  }
  const mudflapsMesh = mesh(merged(mudflapParts), mudflapMat, shell, "king-long-mudflaps");
  mudflapsMesh.castShadow = true;

  // Underbody mounted full-size spare tire & carrier bracket visible from rear view (Ref 2!)
  const spareGroup = group(shell, "king-long-spare-underbody", [0, 0.292, -1.79]);
  const spareTire = mesh(
    new THREE.TorusGeometry(0.255, 0.092, 12, 24).rotateX(Math.PI / 2),
    rubber, spareGroup, "king-long-spare-underbody-tire",
  );
  spareTire.scale.set(1, 0.72, 1);
  spareTire.castShadow = true;
  mesh(
    new THREE.CylinderGeometry(0.16, 0.16, 0.09, 16),
    dash, spareGroup, "king-long-spare-underbody-hub",
  );
  // Leaf-spring shackles & U-bolt brackets visible beneath rear bumper (Ref 2)
  for (const side of [-1, 1]) {
    box(shell, `king-long-rear-leaf-bracket-${side < 0 ? "left" : "right"}`,
      [0.062, 0.175, 0.12], [side * 0.495, 0.245, -1.82], dash, 0.008);
  }

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
    // Three prominent headrests per passenger bench visible through the tinted side & rear glass (Ref 1 & 2)
    mesh(merged([-0.415, 0, 0.415].map((x) =>
      softBox(0.245, 0.165, 0.095, 0.036).translate(x, 1.435, -0.175),
    )), upholstery, row, "king-long-bench-headrests");
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
    // Dark painted wheel-pocket backing behind the 10-spoke alloy face so spoke voids read with realistic shadow depth
    const pocket = mesh(
      new THREE.CylinderGeometry(0.168, 0.168, 0.006, 28).rotateZ(-Math.PI / 2),
      black, spin, `${name}-rim-pocket`, [side * (wheelWidthM * 0.305), 0, 0],
    );
    pocket.receiveShadow = true;
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
      : (p.z > 0 ? front : rearSkin)(p.x / widthAt(p.y), p.y, -0.008);
    const support = section(rod(root, `range-support-${id}`, 0.011, black, face, [p.x, p.y, p.z]));
    if (id.startsWith("rear-")) chaseHidden.push(anchor, support);
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
    const support = section(rod(root, `${id}-support`, 0.012, black, tip, [p.x, p.y, p.z]));
    if (id === "rear-camera") chaseHidden.push(anchor, support);
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
      lamp.color.setHex(state === "shattered" ? 0x303435 : state === "cracked" ? 0x8e8477 : 0xd7e2e8);
      lamp.emissiveIntensity = state === "shattered" ? 0 : state === "cracked" ? 0.05 : 0.11;
    }
    for (const [key, lamp] of lamps.tail) {
      const state = states[key];
      lamp.color.setHex(state === "shattered" ? 0x392020 : state === "cracked" ? 0x863330 : 0xb8161d);
      lamp.emissiveIntensity = state === "shattered" ? 0 : state === "cracked" ? 0.13 + brake * 0.3 : 0.26 + brake * 1.25;
    }
    centerBrake.visible = brake > 0.02;
    lamps.high.emissiveIntensity = 0.42 + brake * 1.4;
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
