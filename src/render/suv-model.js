import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { PLAYER_VEHICLE, getVehicleMounts } from "../core/vehicle-spec.js";

const UP = new THREE.Vector3(0, 1, 0);
const v = (p) => new THREE.Vector3(...p);

function facesGeometry(points, faces) {
  const positions = [];
  for (const face of faces)
    for (let i = 1; i + 1 < face.length; i++)
      for (const index of [face[0], face[i], face[i + 1]])
        positions.push(...points[index]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.computeVertexNormals();
  return geometry;
}

function outline(width, depth, cut, y) {
  const x = width / 2, z = depth / 2;
  return [
    [-x + cut, y, -z], [x - cut, y, -z],
    [x, y, -z + cut], [x, y, z - cut],
    [x - cut, y, z], [-x + cut, y, z],
    [-x, y, z - cut], [-x, y, -z + cut],
  ];
}

function loft(rings) {
  const n = rings[0].length;
  const faces = [Array.from({ length: n }, (_, i) => i)];
  for (let ring = 0; ring < rings.length - 1; ring++)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = ring * n, b = a + n;
      faces.push([a + j, a + i, b + i, b + j]);
    }
  faces.push(
    Array.from({ length: n }, (_, i) => rings.length * n - 1 - i),
  );
  return facesGeometry(rings.flat(), faces);
}

function bevelBox(width, height, depth, cut = 0.025) {
  const b = Math.min(cut, width / 5, height / 5, depth / 5);
  return loft([
    outline(width - 2 * b, depth - 2 * b, b / 2, -height / 2),
    outline(width, depth, b, -height / 2 + b),
    outline(width, depth, b, height / 2 - b),
    outline(width - 2 * b, depth - 2 * b, b / 2, height / 2),
  ]);
}

function sidePanel(points, x) {
  const shape = new THREE.Shape();
  points.forEach(([z, y], i) => {
    if (i) shape.lineTo(-z, y);
    else shape.moveTo(-z, y);
  });
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    depth: 0.045, steps: 1, bevelEnabled: true,
    bevelSegments: 1, bevelSize: 0.012, bevelThickness: 0.012,
    curveSegments: 1,
  }).rotateY(Math.PI / 2).translate(x, 0, 0);
}

function archTrimGeometry(points, x, radius = 0.055) {
  const normals = points.slice(1).map(([z, y], i) =>
    new THREE.Vector2(points[i][1] - y, z - points[i][0]).normalize());
  const rings = points.map(([z, y], i) => {
    const normal = normals[Math.max(0, i - 1)].clone();
    if (i > 0 && i < normals.length) normal.add(normals[i]).normalize();
    const miter = normal.multiplyScalar(
      radius / normal.dot(normals[Math.min(i, normals.length - 1)]),
    );
    return Array.from({ length: 6 }, (_, j) => {
      const angle = j * Math.PI / 3, offset = Math.cos(angle);
      return [
        x + radius * Math.sin(angle),
        y + miter.y * offset,
        z + miter.x * offset,
      ];
    });
  });
  return loft(rings);
}

function bumperGeometry(rear = false) {
  const sign = rear ? -1 : 1;
  const rows = rear
    ? [[0.4, 0.81], [0.46, 0.9], [0.66, 0.9], [0.73, 0.81]]
    : [[0.37, 0.81], [0.43, 0.9], [0.63, 0.9], [0.7, 0.81]];
  const points = [];
  for (const back of [false, true])
    for (const [y, half] of rows)
      for (let i = 0; i <= 6; i++) {
        const x = (i / 3 - 1) * half;
        const bevel = Math.max(0, Math.abs(x) - 0.7) * 0.18;
        const edge = y === rows[0][0] || y === rows[3][0] ? 0.035 : 0;
        points.push([x, y, sign * (back ? 1.91 : 2.1 - bevel - edge)]);
      }
  const faces = [];
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 6; col++) {
      const a = row * 7 + col, b = a + 28;
      faces.push([a, a + 1, a + 8, a + 7]);
      faces.push([b + 7, b + 8, b + 1, b]);
    }
  const perimeter = [
    ...Array.from({ length: 7 }, (_, i) => i),
    13, 20, 27,
    ...Array.from({ length: 6 }, (_, i) => 26 - i),
    14, 7,
  ];
  perimeter.forEach((a, i) => {
    const b = perimeter[(i + 1) % perimeter.length];
    faces.push([a + 28, b + 28, b, a]);
  });
  if (rear) for (const face of faces) face.reverse();
  return facesGeometry(points, faces);
}

function tireGeometry(radius, width = 0.25) {
  const profile = [
    [-width / 2, radius * 0.74],
    [-width / 2, radius * 0.9],
    [-width * 0.36, radius - 0.007],
    [width * 0.36, radius - 0.007],
    [width / 2, radius * 0.9],
    [width / 2, radius * 0.74],
    [width * 0.3, radius * 0.68],
    [-width * 0.3, radius * 0.68],
  ];
  const points = [], faces = [];
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    for (const [x, r] of profile)
      points.push([x, Math.cos(angle) * r, Math.sin(angle) * r]);
  }
  for (let i = 0; i < 16; i++)
    for (let j = 0; j < profile.length; j++) {
      const k = (j + 1) % profile.length;
      faces.push([
        i * 8 + j, ((i + 1) % 16) * 8 + j,
        ((i + 1) % 16) * 8 + k, i * 8 + k,
      ]);
    }
  return facesGeometry(points, faces);
}

/** Original mesh work: no imported player model or downloaded resources. */
export function createSuvModel(body = {}) {
  const root = new THREE.Group();
  root.name = "player-vehicle";
  const chassis = new THREE.Group();
  chassis.name = "player-chassis";
  root.add(chassis);
  const geometries = new Set(), materials = new Set(), textures = new Set();
  const bodyPanels = [], cutawayParts = [], wheels = [], links = [];
  const ownGeometry = (g) => { geometries.add(g); return g; };
  const ownMaterial = (m) => { materials.add(m); return m; };
  const material = (name, color, options = {}) => ownMaterial(
    new THREE.MeshStandardMaterial({
      name, color, flatShading: true, roughness: 0.94,
      metalness: 0, envMapIntensity: 0.22, ...options,
    }),
  );
  const palette = {
    paint: material("SUV olive stone paint", 0x7d8467, { vertexColors: true }),
    cladding: material("SUV charcoal cladding", 0x333d37, { vertexColors: true }),
    trim: material("SUV interior charcoal", 0x303a35),
    seat: material("SUV woven seats", 0x46534a),
    seatInset: material("SUV stone upholstery", 0x969b81),
    metal: material("SUV satin running gear", 0x738077, { roughness: 0.78, metalness: 0.2 }),
    rubber: material("SUV tire rubber", 0x252c29),
    tread: material("SUV tire tread", 0x303831),
    spring: material("SUV spring ochre", 0xaaa075),
    lens: material("SUV sensor glass", 0x6aaca8, { roughness: 0.5, emissive: 0x173b38, emissiveIntensity: 0.25 }),
    glass: material("SUV upright glazing", 0x70938c, {
      transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide,
    }),
    lamp: material("SUV warm headlamps", 0xe7dec3, {
      emissive: 0xc8bc97, emissiveIntensity: 0.35,
    }),
    tail: material("SUV tail lamps", 0x9b4435, {
      emissive: 0x592016, emissiveIntensity: 0.25,
    }),
    dark: material("SUV recesses", 0x1e2924),
  };
  const mesh = (g, m, parent, name, position) => {
    const part = new THREE.Mesh(ownGeometry(g), m);
    part.name = name;
    if (position) part.position.copy(v(position));
    part.castShadow = true;
    part.receiveShadow = true;
    parent.add(part);
    return part;
  };
  const box = (parent, name, dimensions, position, m, cut) =>
    mesh(bevelBox(...dimensions, cut), m, parent, name, position);
  const rod = (parent, name, radius, m) =>
    mesh(new THREE.CylinderGeometry(radius, radius, 1, 6), m, parent, name);
  const between = (part, a, b) => {
    part.position.copy(a).add(b).multiplyScalar(0.5);
    const direction = b.clone().sub(a);
    part.scale.y = direction.length();
    part.quaternion.setFromUnitVectors(UP, direction.normalize());
  };
  const beam = (parent, name, radius, a, b, m = palette.trim) => {
    const part = rod(parent, name, radius, m);
    between(part, v(a), v(b));
    return part;
  };
  const section = (part) => { cutawayParts.push(part); return part; };
  const panel = (g, m, name, position, mobilityAt) => {
    if (position) g.translate(...position);
    g.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(
        new Float32Array(g.attributes.position.count * 3).fill(1), 3,
      ),
    );
    const part = mesh(g, m, chassis, name);
    bodyPanels.push({
      part, pristine: g.attributes.position.array.slice(),
      normals: g.attributes.normal.array.slice(),
      mobility: mobilityAt ? Float32Array.from(
        { length: g.attributes.position.count }, (_, i) =>
          mobilityAt(g.attributes.position.getX(i), g.attributes.position.getY(i)),
      ) : null,
    });
    return part;
  };
  const quad = (parent, name, points, m) =>
    mesh(facesGeometry(points, [[0, 1, 2, 3]]), m, parent, name);

  const rearProfile = [
    [-2.04, 0.38], [-1.84, 0.38], [-1.84, 0.64], [-1.65, 0.86],
    [-0.95, 0.86], [-0.76, 0.64], [-0.76, 1.12], [-1.94, 1.12],
    [-2.04, 1.01],
  ];
  const frontProfile = [
    [0.76, 1.12], [0.76, 0.64], [0.95, 0.86], [1.65, 0.86],
    [1.84, 0.64], [1.84, 0.38], [2.02, 0.38], [2.08, 0.68],
    [2.02, 0.99], [0.93, 1.12],
  ];
  for (const side of [-1, 1]) {
    const label = side < 0 ? "left" : "right";
    const base = side < 0 ? -0.865 : 0.82;
    panel(sidePanel(rearProfile, base), palette.paint, `suv-${label}-rear-quarter`);
    panel(sidePanel(frontProfile, base), palette.paint, `suv-${label}-front-fender`);
    const doors = panel(
      bevelBox(0.073, 0.73, 1.5, 0.025), palette.paint,
      `suv-${label}-doors`, [side * 0.85, 0.755, 0],
    );
    if (side < 0) section(doors);
    box(chassis, `suv-${label}-sill`, [0.16, 0.12, 1.55], [side * 0.83, 0.34, 0], palette.cladding);
    box(chassis, `suv-${label}-step`, [0.18, 0.06, 1.33], [side * 0.83, 0.29, 0], palette.metal, 0.015);
    box(
      chassis, `suv-${label}-door-cladding`, [0.085, 0.22, 1.45],
      [side * 0.881, 0.56, 0], palette.cladding,
    );
    for (const z of [-0.5, 0.48]) {
      const handle = box(chassis, `suv-${label}-door-handle-${z}`, [0.045, 0.038, 0.15], [side * 0.9, 1.025, z], palette.trim, 0.009);
      const seam = beam(chassis, `suv-${label}-door-seam-${z}`, 0.004,
        [side * 0.889, 0.7, z - 0.3], [side * 0.889, 1.08, z - 0.3], palette.trim);
      if (side < 0) { section(handle); section(seam); }
    }
    for (const axle of [-1, 1]) {
      const center = axle * PLAYER_VEHICLE.wheelbaseM / 2;
      const arch = [
        [center - 0.52, 0.37], [center - 0.52, 0.65],
        [center - 0.34, 0.88], [center + 0.34, 0.88],
        [center + 0.52, 0.65], [center + 0.52, 0.37],
      ];
      mesh(archTrimGeometry(arch, side * 0.879), palette.cladding,
        chassis, `suv-${label}-arch-${axle}`);
    }
    const pillars = [
      [[side * 0.815, 1.09, 0.89], [side * 0.748, 1.715, 0.55]],
      [[side * 0.835, 1.09, -0.31], [side * 0.77, 1.735, -0.31]],
      [[side * 0.835, 1.09, -1.6], [side * 0.77, 1.735, -1.6]],
      [[side * 0.815, 1.09, -1.95], [side * 0.748, 1.715, -1.94]],
    ];
    for (let i = 0; i < pillars.length; i++) {
      const part = beam(chassis, `suv-${label}-pillar-${i}`, 0.045, ...pillars[i], palette.trim);
      if (side < 0) section(part);
    }
    for (const [z0, z1, name] of [
      [-1.89, -1.66, "quarter"], [-1.54, -0.37, "rear"], [-0.25, 0.66, "front"],
    ]) {
      const glass = quad(chassis, `suv-${label}-${name}-window`, [
        [side * 0.824, 1.13, z0], [side * 0.824, 1.13, z1],
        [side * 0.763, 1.68, z1 > 0 ? 0.52 : z1],
        [side * 0.763, 1.68, z0],
      ], palette.glass);
      section(glass);
    }
    const beltline = beam(chassis, `suv-${label}-beltline`, 0.025,
      [side * 0.844, 1.12, -1.97], [side * 0.844, 1.12, 0.88], palette.trim);
    if (side < 0) section(beltline);
    const mirrorStay = beam(chassis, `suv-${label}-mirror-stay`, 0.021,
      [side * 0.81, 1.16, 0.72], [side * 0.95, 1.2, 0.65], palette.trim);
    const mirror = box(chassis, `suv-${label}-mirror`, [0.14, 0.12, 0.15], [side * 0.96, 1.22, 0.64], palette.trim, 0.02);
    if (side < 0) { section(mirrorStay); section(mirror); }
  }
  const hoodRows = [
    [0.88, 1.105, 0.79], [1.04, 1.09, 0.86],
    [1.89, 1.055, 0.86], [2.04, 0.99, 0.78],
  ];
  const hoodPoints = hoodRows.flatMap(([z, y, x]) => [
    [-x, y - 0.05, z], [-x + 0.12, y, z],
    [x - 0.12, y, z], [x, y - 0.05, z],
  ]);
  const hoodFaces = [];
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) {
      const a = row * 4 + col;
      hoodFaces.push([a, a + 4, a + 5, a + 1]);
    }
  section(panel(facesGeometry(hoodPoints, hoodFaces), palette.paint, "suv-hood"));
  panel(bumperGeometry(), palette.cladding, "suv-front-bumper", null, (x, y) => {
    // The lower flange is held by the skid; the cover above it can still crease.
    const lower = THREE.MathUtils.clamp((0.6 - y) / 0.16, 0, 1);
    const across = THREE.MathUtils.clamp((0.545 - Math.abs(x)) / 0.12, 0, 1);
    return 1 - lower * across;
  });
  panel(bumperGeometry(true), palette.cladding, "suv-rear-bumper");
  panel(bumperGeometry().translate(0, 0.29, -0.055), palette.paint, "suv-front-fascia");
  box(chassis, "suv-grille-recess", [0.96, 0.23, 0.025], [0, 0.825, 2.057], palette.dark, 0.015);
  for (let i = -3; i <= 3; i++)
    box(chassis, `suv-grille-slat-${i}`, [0.028, 0.18, 0.024], [i * 0.127, 0.825, 2.075], palette.trim, 0.005);
  for (const side of [-1, 1]) {
    box(chassis, `suv-headlamp-well-${side}`, [0.29, 0.22, 0.035], [side * 0.65, 0.856, 2.047], palette.dark, 0.025);
    for (const y of [0.817, 0.895])
      box(chassis, `suv-headlamp-${side}-${y}`, [0.21, 0.025, 0.018], [side * 0.65, y, 2.069], palette.lamp, 0.004);
    box(chassis, `suv-rear-lamp-well-${side}`, [0.17, 0.32, 0.06], [side * 0.724, 0.995, -1.979], palette.dark);
    box(chassis, `suv-rear-lamp-${side}`, [0.064, 0.255, 0.015], [side * 0.724, 1.01, -2.014], palette.tail, 0.009);
  }
  box(chassis, "suv-front-skid", [0.85, 0.09, 0.06], [0, 0.365, 2.04], palette.metal, 0.013);
  for (const side of [-1, 1])
    beam(chassis, `suv-front-skid-support-${side}`, 0.022,
      [side * 0.32, 0.29, 1.3], [side * 0.32, 0.365, 2.018]);
  box(chassis, "suv-front-plate", [0.25, 0.07, 0.016], [0, 0.665, 2.083], palette.seatInset, 0.008);
  panel(bevelBox(1.67, 0.54, 0.1), palette.paint, "suv-rear-hatch", [0, 0.9, -1.9]);
  section(quad(chassis, "suv-windshield", [
    [-0.785, 1.13, 0.886], [0.785, 1.13, 0.886],
    [0.735, 1.693, 0.56], [-0.735, 1.693, 0.56],
  ], palette.glass));
  section(quad(chassis, "suv-rear-window", [
    [0.75, 1.18, -1.959], [-0.75, 1.18, -1.959],
    [-0.725, 1.66, -1.942], [0.725, 1.66, -1.942],
  ], palette.glass));
  const roof = loft([
    outline(1.63, 2.55, 0.085, 1.725).map(([x, y, z]) => [x, y, z - 0.7]),
    outline(1.47, 2.39, 0.07, 1.82).map(([x, y, z]) => [x, y, z - 0.7]),
  ]);
  section(mesh(roof, palette.trim, chassis, "suv-faceted-roof"));
  section(box(chassis, "suv-windshield-header", [1.5, 0.055, 0.075], [0, 1.71, 0.55], palette.trim, 0.012));
  section(box(chassis, "suv-rear-window-header", [1.5, 0.08, 0.065], [0, 1.688, -1.947], palette.trim, 0.012));
  for (const side of [-1, 1]) {
    section(box(chassis, `suv-window-header-${side}`, [0.05, 0.06, 2.43], [side * 0.78, 1.706, -0.7], palette.trim, 0.01));
    section(box(chassis, `suv-roof-rail-${side}`, [0.05, 0.055, 2.1], [side * 0.64, 1.9, -0.65], palette.trim, 0.01));
    for (const z of [-1.44, 0.14])
      section(box(chassis, `suv-roof-foot-${side}-${z}`, [0.085, 0.07, 0.14], [side * 0.64, 1.846, z], palette.trim, 0.012));
  }
  box(chassis, "suv-spare-carrier", [0.35, 0.35, 0.1], [0, 0.94, -1.95], palette.trim);
  const spare = mesh(
    new THREE.CylinderGeometry(0.29, 0.29, 0.14, 12),
    palette.rubber, chassis, "suv-rear-spare", [0, 0.94, -2.0],
  );
  spare.rotation.x = Math.PI / 2;
  const spareCover = mesh(
    new THREE.CylinderGeometry(0.24, 0.24, 0.025, 8),
    palette.paint, chassis, "suv-spare-cover", [0, 0.94, -2.08],
  );
  spareCover.rotation.x = Math.PI / 2;
  box(chassis, "suv-spare-cover-inset", [0.15, 0.045, 0.012], [0, 0.94, -2.097], palette.trim, 0.006);

  box(chassis, "suv-cabin-floor", [1.45, 0.09, 1.53], [0, 0.43, 0], palette.trim);
  box(chassis, "suv-cargo-floor", [1.37, 0.06, 0.98], [0, 0.73, -1.25], palette.trim);
  for (const [x, z] of [[-0.38, -0.2], [0.38, -0.2], [-0.38, -1.22], [0.38, -1.22]]) {
    const rear = z < -1;
    const y = rear ? 0.87 : 0.7;
    box(chassis, `suv-seat-pedestal-${x}-${z}`, [0.42, rear ? 0.04 : 0.12, 0.43],
      [x, rear ? 0.78 : 0.535, z], palette.trim, 0.012);
    if (!rear)
      for (const dx of [-0.16, 0.16])
        box(chassis, `suv-seat-rail-${x}-${dx}`, [0.03, 0.035, 0.43],
          [x + dx, 0.606, z], palette.metal, 0.006);
    box(chassis, `suv-seat-base-${x}-${z}`, [0.51, 0.17, 0.55], [x, y, z], palette.seat);
    const back = box(chassis, `suv-seat-back-${x}-${z}`, [0.49, 0.55, 0.135], [x, y + 0.29, z - 0.255], palette.seat);
    back.rotation.x = -0.09;
    box(chassis, `suv-seat-inset-${x}-${z}`, [0.34, 0.41, 0.02], [x, y + 0.3, z - 0.174], palette.seatInset, 0.015);
    box(chassis, `suv-headrest-${x}-${z}`, [0.26, 0.2, 0.12], [x, y + 0.64, z - 0.255], palette.seat, 0.04);
  }
  box(chassis, "suv-center-console", [0.21, 0.27, 0.9], [0, 0.66, 0.06], palette.trim);
  box(chassis, "suv-console-top", [0.21, 0.035, 0.48], [0, 0.812, 0.18], palette.seatInset, 0.01);
  beam(chassis, "suv-gear-selector", 0.016, [0, 0.83, 0.23], [0, 0.93, 0.2], palette.trim);
  box(chassis, "suv-selector-grip", [0.07, 0.04, 0.055], [0, 0.93, 0.2], palette.trim, 0.009);
  for (const side of [-1, 1]) {
    const door = box(chassis, `suv-${side}-inner-door`, [0.065, 0.39, 1.44], [side * 0.79, 0.85, -0.05], palette.trim);
    const arm = box(chassis, `suv-${side}-armrest`, [0.13, 0.065, 0.49], [side * 0.745, 0.86, 0.06], palette.seatInset);
    if (side < 0) { section(door); section(arm); }
  }
  box(chassis, "cockpit-dashboard-shell", [1.48, 0.18, 0.34], [0, 1.035, 0.83], palette.trim, 0.045);
  for (const x of [-0.66, 0.05, 0.58])
    box(chassis, `cockpit-vent-${x}`, [0.16, 0.05, 0.025], [x, 1.065, 0.641], palette.dark, 0.006);
  const binnacle = box(chassis, "cockpit-instrument-binnacle", [0.48, 0.19, 0.075], [-0.38, 1.225, 0.8], palette.trim, 0.022);
  const displayMaterial = ownMaterial(new THREE.MeshBasicMaterial({ color: 0xe1ecce, toneMapped: false }));
  const dashboard = mesh(new THREE.PlaneGeometry(0.423, 0.142), displayMaterial, binnacle, "cockpit-dashboard", [0, 0, -0.041]);
  dashboard.rotation.y = Math.PI;
  const steeringMount = new THREE.Group();
  steeringMount.name = "cockpit-steering-mount";
  steeringMount.position.set(-0.38, 1.085, 0.48);
  steeringMount.rotation.x = 0.27;
  chassis.add(steeringMount);
  const steering = new THREE.Group();
  steering.name = "cockpit-steering";
  steeringMount.add(steering);
  mesh(new THREE.TorusGeometry(0.155, 0.014, 4, 12), palette.trim, steering, "cockpit-steering-rim");
  const hub = mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.028, 8), palette.trim, steering, "cockpit-steering-hub");
  hub.rotation.x = Math.PI / 2;
  for (const angle of [0, Math.PI * 2 / 3, Math.PI * 4 / 3]) {
    const spoke = box(steering, "cockpit-steering-spoke", [0.035, 0.117, 0.012], [0, 0.078, 0], palette.metal, 0.005);
    spoke.position.set(-Math.sin(angle) * 0.078, Math.cos(angle) * 0.078, 0);
    spoke.rotation.z = angle;
  }
  beam(chassis, "cockpit-steering-column", 0.034, [-0.38, 1.085, 0.48], [-0.38, 1.045, 0.83], palette.trim);
  box(steering, "cockpit-steering-center-mark", [0.018, 0.026, 0.029], [0, 0.155, 0], palette.seatInset, 0.003);

  const radius = PLAYER_VEHICLE.wheelRadiusM;
  for (const [key, side, axle] of [
    ["frontLeft", -1, 1], ["frontRight", 1, 1],
    ["rearLeft", -1, -1], ["rearRight", 1, -1],
  ]) {
    const name = `wheel-${axle > 0 ? "front" : "rear"}-${side < 0 ? "left" : "right"}`;
    const pivot = new THREE.Group();
    pivot.name = name;
    pivot.position.set(side * PLAYER_VEHICLE.trackM / 2, radius, axle * PLAYER_VEHICLE.wheelbaseM / 2);
    root.add(pivot);
    const spin = new THREE.Group(); spin.name = `${name}-spin`; pivot.add(spin);
    const caliper = new THREE.Group(); caliper.name = `${name}-caliper`; pivot.add(caliper);
    mesh(tireGeometry(radius), palette.rubber, spin, `${name}-tire`);
    const treads = [];
    for (let i = 0; i < 16; i++) {
      const angle = i * Math.PI / 8;
      treads.push(new THREE.BoxGeometry(0.18, 0.014, 0.046)
        .rotateX(angle).translate(0, Math.cos(angle) * (radius - 0.007), Math.sin(angle) * (radius - 0.007)));
    }
    mesh(mergeGeometries(treads), palette.tread, spin, `${name}-tread`);
    treads.forEach((g) => g.dispose());
    const disc = mesh(new THREE.CylinderGeometry(0.185, 0.185, 0.022, 12), palette.metal, spin, `${name}-disc`, [side * 0.07, 0, 0]);
    disc.rotation.z = Math.PI / 2;
    const rim = mesh(new THREE.RingGeometry(0.07, 0.252, 6), palette.trim, spin, `${name}-rim`, [side * 0.127, 0, 0]);
    rim.rotation.y = side * Math.PI / 2;
    const spokes = [];
    for (let i = 0; i < 6; i++) {
      const angle = i * Math.PI / 3;
      spokes.push(bevelBox(0.027, 0.17, 0.033, 0.005)
        .rotateX(angle).translate(side * 0.131, Math.cos(angle) * 0.143, Math.sin(angle) * 0.143));
    }
    mesh(mergeGeometries(spokes), palette.metal, spin, `${name}-alloy-spokes`);
    spokes.forEach((g) => g.dispose());
    const cap = mesh(new THREE.CylinderGeometry(0.067, 0.067, 0.035, 6), palette.trim, spin, `${name}-hub`, [side * 0.132, 0, 0]);
    cap.rotation.z = Math.PI / 2;
    box(caliper, `${name}-brake-pad`, [0.06, 0.13, 0.09], [side * 0.055, 0.065, -0.148], palette.spring, 0.012);
    beam(pivot, `${name}-upright`, 0.025, [-side * 0.05, -0.1, 0], [-side * 0.05, 0.16, 0], palette.metal);
    for (const [height, level] of [[0.27, "lower"], [0.49, "upper"]])
      for (const fore of [-1, 1]) {
        const part = rod(root, `${name}-${level}-wishbone-${fore}`, 0.017, palette.metal);
        links.push({
          part,
          upper: v([side * 0.41, height, pivot.position.z + fore * 0.17]),
          lower: v([side * 0.72, height, pivot.position.z]),
        });
      }
    const upper = v([side * 0.57, 0.81, pivot.position.z]);
    const lower = v([side * 0.71, 0.35, pivot.position.z]);
    const damper = rod(root, `${name}-damper-body`, 0.032, palette.trim);
    const shaft = rod(root, `${name}-damper-shaft`, 0.013, palette.metal);
    links.push({ part: damper, upper, lower, damper: true }, { part: shaft, upper, lower, shaft: true });
    const coilPoints = Array.from({ length: 49 }, (_, i) => {
      const t = i / 48, a = t * Math.PI * 10;
      return v([Math.cos(a) * 0.047, t - 0.5, Math.sin(a) * 0.047]);
    });
    const spring = mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(coilPoints), 48, 0.007, 4),
      palette.spring, root, `${name}-spring`,
    );
    links.push({ part: spring, upper, lower, spring: true });
    beam(chassis, `${name}-strut-tower`, 0.03,
      [side * 0.47, 0.29, pivot.position.z], upper.toArray(), palette.trim);
    if (axle > 0) {
      const tie = rod(root, `${name}-steering-tie`, 0.012, palette.metal);
      links.push({
        part: tie, upper: v([side * 0.25, 0.33, pivot.position.z - 0.14]),
        lower: v([side * 0.72, 0.33, pivot.position.z - 0.09]), steering: pivot,
      });
    }
    const axleShaft = rod(root, `${name}-halfshaft`, 0.023, palette.metal);
    links.push({
      part: axleShaft,
      upper: v([side * 0.15, 0.35, pivot.position.z]),
      lower: v([side * 0.72, 0.35, pivot.position.z]),
      steering: axle > 0 ? pivot : null,
    });
    wheels.push({ key, pivot, spin, caliper, spring, axle, side });
  }
  box(chassis, "chassis-center-spine", [0.22, 0.1, 3.2], [0, 0.27, 0], palette.trim);
  for (const z of [-1.3, 1.3])
    box(chassis, `suv-subframe-${z}`, [1.22, 0.075, 0.14], [0, 0.29, z], palette.trim);
  for (const z of [-1.3, 1.3])
    box(chassis, `suv-differential-${z}`, [0.32, 0.18, 0.24], [0, 0.35, z], palette.metal, 0.04);
  box(chassis, "suv-transverse-powerunit", [0.72, 0.26, 0.62], [0, 0.62, 1.26], palette.metal, 0.05);
  for (const x of [-0.24, -0.12, 0, 0.12, 0.24])
    box(chassis, `suv-powerunit-cover-rib-${x}`, [0.032, 0.024, 0.46], [x, 0.762, 1.26], palette.trim, 0.006);
  for (const x of [-0.23, 0.23])
    beam(chassis, `suv-powerunit-mount-${x}`, 0.04, [x, 0.31, 1.3], [x, 0.5, 1.3], palette.trim);
  box(chassis, "suv-airbox", [0.21, 0.18, 0.34], [-0.48, 0.67, 1.39], palette.trim);
  beam(chassis, "suv-intake-join", 0.024, [-0.36, 0.68, 1.26], [-0.4, 0.68, 1.33], palette.trim);

  const mounts = getVehicleMounts(body);
  const sensorRecords = [], cameraRecords = [];
  for (const mount of [...mounts.ranges, ...(mounts.auxiliary ?? [])]) {
    const group = new THREE.Group();
    group.name = `range-mount-${mount.id}`;
    group.position.set(mount.position.x, mount.position.y, mount.position.z);
    group.rotation.y = mount.angleDeg * Math.PI / 180;
    root.add(group);
    if (!mount.id.startsWith("side-"))
      box(root, `range-support-${mount.id}`, [0.078, 0.014, 0.08],
        [mount.position.x, mount.position.y - 0.027, Math.sign(mount.position.z) * 2.105],
        palette.trim, 0.004);
    box(group, `range-housing-${mount.id}`, [0.052, 0.044, 0.044], [0, 0, -0.023], palette.trim, 0.008);
    const ring = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.007, 8), palette.metal, group, `range-ring-${mount.id}`, [0, 0, -0.004]);
    ring.rotation.x = Math.PI / 2;
    const lens = mesh(new THREE.CircleGeometry(0.011, 8), palette.lens, group, `sensor-range-${mount.id}`);
    sensorRecords.push({ ...mount, group, lens });
  }
  for (const mount of mounts.cameras ?? [mounts.camera]) {
    const group = new THREE.Group();
    group.name = `camera-mount-${mount.id}`;
    group.position.set(mount.position.x, mount.position.y, mount.position.z);
    group.rotation.y = (mount.angleDeg ?? 0) * Math.PI / 180;
    root.add(group);
    box(group, `${mount.id}-housing`, [0.061, 0.045, 0.055], [0, 0, -0.03], palette.trim, 0.009);
    box(group, `${mount.id}-foot`, [0.077, 0.017, mount.id === "rear-camera" ? 0.15 : 0.065], [0, -0.028, -0.063], palette.trim, 0.006);
    const lens = mesh(new THREE.CircleGeometry(0.014, 8), palette.lens, group, `sensor-${mount.id}`);
    if (mount.id === "rear-camera")
      box(root, "rear-camera-pedestal", [0.07, 0.08, 0.14],
        [0, 1.255, -2.05], palette.trim, 0.009);
    else {
      section(group);
      section(beam(root, "front-camera-windscreen-support", 0.009,
        [0, 1.71, 0.55], [0, 1.48, 0.69], palette.trim));
      section(box(root, "front-camera-header-foot", [0.085, 0.018, 0.08],
        [0, 1.708, 0.55], palette.trim, 0.006));
    }
    cameraRecords.push({ ...mount, group, lens });
  }
  let telemetry = null;
  if (mounts.telemetry) {
    telemetry = new THREE.Group();
    telemetry.name = "sensor-roof-imu-gnss";
    telemetry.position.set(mounts.telemetry.position.x, mounts.telemetry.position.y, mounts.telemetry.position.z);
    root.add(telemetry);
    box(telemetry, "roof-telemetry-enclosure", [0.25, 0.07, 0.19], [0, 0, 0], palette.seatInset, 0.018);
    box(telemetry, "roof-telemetry-base", [0.29, 0.012, 0.23], [0, -0.054, 0], palette.trim, 0.006);
    for (const x of [-0.09, 0.09])
      box(telemetry, `roof-telemetry-foot-${x}`, [0.032, 0.02, 0.1], [x, -0.038, 0], palette.trim, 0.004);
    section(telemetry);
  }
  return {
    root, chassis, wheels, links, bodyPanels, cutawayParts,
    cockpit: { steering, steeringMount, dashboard, displayMaterial },
    sensors: { mounts, ranges: sensorRecords, cameras: cameraRecords, telemetry },
    resources: { geometries, materials, textures },
    kit: { mesh, box, material, ownGeometry, ownMaterial, between },
  };
}
