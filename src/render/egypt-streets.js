import * as THREE from "three";

const GROUND = 0.12;
const ATLAS_SIZE = 2048;
const TILE_SIZE = ATLAS_SIZE / 4;
const SHOP_NAMES = ["بقالة", "صيدلية", "فرن بلدي", "ورشة", "قهوة"];
const FEATURES = ["masonry", "window", "balcony", "shop", "roof", "equipment", "patch", "curb"];
const COLORS = {
  concrete: 0xb9ac94, limestone: 0xcbbda0, mortar: 0xb3a38b,
  iron: 0x4c5a51, timber: 0x738070, dark: 0x454942,
  tank: 0x535550, pipe: 0x827c6b, dish: 0xb8b8a7,
};

function hash(value) {
  let state = 2166136261;
  for (const char of String(value)) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return state >>> 0;
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function atlasRect(tile) {
  const sign = tile >= 9 && tile <= 13;
  return {
    x: (tile % 4) * TILE_SIZE,
    y: Math.floor(tile / 4) * TILE_SIZE + (sign ? 192 : 0),
    width: TILE_SIZE,
    height: sign ? 128 : TILE_SIZE,
  };
}

function makeAtlas() {
  let canvas;
  if (typeof document !== "undefined" && document.createElement)
    canvas = document.createElement("canvas");
  else if (typeof OffscreenCanvas !== "undefined")
    canvas = new OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE);
  const ctx = canvas?.getContext("2d");
  if (!ctx) return null;
  canvas.width = canvas.height = ATLAS_SIZE;
  const rng = random(0x45475950);
  const bases = [
    "#bcab90", "#c8bea7", "#ad987a", "#a4775e",
    "#718071", "#a98069", "#c2b49b", "#7d8175",
    "#c8b18b", "#4c6a64", "#405b4d", "#8c5944",
    "#5d6665", "#6e5945", "#b7a283", "#a69e8c",
  ];
  for (let tile = 0; tile < 16; tile++) {
    const x = (tile % 4) * TILE_SIZE, y = Math.floor(tile / 4) * TILE_SIZE;
    ctx.fillStyle = bases[tile];
    ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
    if ([0, 1, 2, 14, 15].includes(tile)) {
      for (let n = 0; n < 180; n++) {
        ctx.fillStyle = n % 3 ? "rgba(90,72,50,.035)" : "rgba(238,226,197,.10)";
        ctx.fillRect(x + rng() * 500, y + rng() * 500, 7 + rng() * 72, 2 + rng() * 24);
      }
      ctx.fillStyle = "rgba(92,75,53,.13)";
      for (const drip of [67, 241, 397])
        ctx.fillRect(x + drip, y + 3, 5, 65 + rng() * 90);
    } else if (tile === 3 || tile === 5) {
      for (let row = 0; row < 17; row++)
        for (let column = -1; column < 17; column++) {
          const bx = x + column * 34 + (row % 2) * 17;
          ctx.fillStyle = ["#9e6d54", "#b38368", "#ad785c", "#976b56"][(row + column + 5) % 4];
          const left = Math.max(x, bx + 2), right = Math.min(x + 512, bx + 33);
          if (right > left) ctx.fillRect(left, y + row * 30 + 2, right - left, 27);
        }
      ctx.fillStyle = "rgba(213,190,154,.16)";
      ctx.fillRect(x + 34, y + 31, 77, 446);
    } else if (tile === 4) {
      for (let n = 8; n < 512; n += 35) {
        ctx.fillStyle = "#56675a"; ctx.fillRect(x + n, y, 4, 512);
        ctx.fillStyle = "#94a08b"; ctx.fillRect(x + n + 4, y, 2, 512);
      }
      ctx.fillStyle = "#56675a";
      ctx.fillRect(x, y + 64, 512, 16); ctx.fillRect(x, y + 429, 512, 16);
    } else if (tile === 6) {
      ctx.fillStyle = "#4d5852"; ctx.fillRect(x + 30, y + 25, 452, 462);
      ctx.fillStyle = "#697b75"; ctx.fillRect(x + 50, y + 49, 412, 417);
      ctx.fillStyle = "#89968b"; ctx.fillRect(x + 58, y + 58, 174, 326);
      ctx.fillStyle = "#394a47"; ctx.fillRect(x + 251, y + 58, 203, 326);
      ctx.fillStyle = "#b5ae93";
      ctx.fillRect(x + 237, y + 31, 15, 447); ctx.fillRect(x + 33, y + 325, 444, 12);
      ctx.fillStyle = "rgba(199,195,166,.18)"; ctx.fillRect(x + 45, y + 411, 420, 53);
    } else if (tile === 7) {
      for (let n = 6; n < 512; n += 18) {
        ctx.fillStyle = "#646d64"; ctx.fillRect(x, y + n, 512, 4);
        ctx.fillStyle = "#96998b"; ctx.fillRect(x, y + n + 4, 512, 2);
      }
      ctx.fillStyle = "#4e5950"; ctx.fillRect(x + 238, y + 394, 37, 10);
    } else if (tile === 8) {
      for (let n = 0; n < 512; n += 86) {
        ctx.fillStyle = "#717c68"; ctx.fillRect(x + n, y, 40, 512);
      }
    } else if (tile >= 9 && tile <= 13) {
      const rect = atlasRect(tile);
      ctx.fillStyle = "#d9c9a4";
      ctx.fillRect(rect.x + 7, rect.y + 7, 498, 114);
      ctx.fillStyle = bases[tile];
      ctx.fillRect(rect.x + 12, rect.y + 12, 488, 104);
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.direction = "rtl";
      ctx.fillStyle = "#f4e7c7"; ctx.font = "bold 70px Tahoma, sans-serif";
      ctx.fillText(SHOP_NAMES[tile - 9], rect.x + 256, rect.y + 56, 450);
      ctx.font = "21px Tahoma, sans-serif";
      ctx.fillText(["مواد غذائية", "دواء وعناية", "عيش طازة", "خدمة سيارات", "شاي وقهوة"][tile - 9],
        rect.x + 256, rect.y + 99, 440);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = "egypt-local-plaster-brick-shops";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

const colorCache = new Map();
function rgb(hex) {
  if (!colorCache.has(hex)) colorCache.set(hex, new THREE.Color(hex));
  return colorCache.get(hex);
}

class Batch {
  constructor(name, material, surface = false) {
    this.name = name;
    this.material = material;
    this.surface = surface;
    this.positions = []; this.normals = []; this.uvs = []; this.colors = [];
    this.sites = []; this.features = [];
  }
  triangle(points, color, tile, site, feature, uv) {
    const [a, b, c] = points;
    const ab = new THREE.Vector3().subVectors(b, a), ac = new THREE.Vector3().subVectors(c, a);
    const normal = ab.cross(ac).normalize(), tint = rgb(color);
    for (let n = 0; n < 3; n++) {
      this.positions.push(points[n].x, points[n].y, points[n].z);
      this.normals.push(normal.x, normal.y, normal.z);
      this.colors.push(tint.r, tint.g, tint.b);
      this.uvs.push(...uv[n]); this.sites.push(site); this.features.push(feature);
    }
  }
  quad(points, color, tile, site, feature) {
    const rect = atlasRect(Math.max(0, tile));
    const left = (rect.x + 6) / ATLAS_SIZE, right = (rect.x + rect.width - 6) / ATLAS_SIZE;
    const bottom = 1 - (rect.y + rect.height - 6) / ATLAS_SIZE, top = 1 - (rect.y + 6) / ATLAS_SIZE;
    const uv = [[left, bottom], [right, bottom], [right, top], [left, top]];
    for (const indices of [[0, 1, 2], [0, 2, 3]])
      this.triangle(indices.map((i) => points[i]), color, tile, site, feature, indices.map((i) => uv[i]));
  }
  mesh() {
    if (!this.positions.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute("siteIndex", new THREE.Float32BufferAttribute(this.sites, 1));
    geometry.setAttribute("featureIndex", new THREE.Float32BufferAttribute(this.features, 1));
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = this.name;
    mesh.castShadow = !this.surface; mesh.receiveShadow = true;
    mesh.userData.egyptStreetBatch = true;
    return mesh;
  }
}

class Writer {
  constructor(batch, site, index, feature = 0) {
    this.batch = batch; this.site = site; this.index = index; this.feature = feature;
    this.cos = Math.cos(site.heading ?? 0); this.sin = Math.sin(site.heading ?? 0);
  }
  point(x, y, z) {
    return new THREE.Vector3(this.site.x + x * this.cos + z * this.sin, y + GROUND,
      this.site.z - x * this.sin + z * this.cos);
  }
  quad(points, tile = 0, color = 0xffffff) {
    this.batch.quad(points.map(([x, y, z]) => this.point(x, y, z)), color, tile, this.index, this.feature);
  }
  box(x, y, z, width, height, depth, tile = 0, color = 0xffffff, yaw = 0, omit = []) {
    const hx = width / 2, hy = height / 2, hz = depth / 2, c = Math.cos(yaw), s = Math.sin(yaw);
    const p = (px, py, pz) => [x + px * c + pz * s, y + py, z - px * s + pz * c];
    const faces = [
      [[-hx,-hy,hz],[hx,-hy,hz],[hx,hy,hz],[-hx,hy,hz]],
      [[hx,-hy,-hz],[-hx,-hy,-hz],[-hx,hy,-hz],[hx,hy,-hz]],
      [[hx,-hy,hz],[hx,-hy,-hz],[hx,hy,-hz],[hx,hy,hz]],
      [[-hx,-hy,-hz],[-hx,-hy,hz],[-hx,hy,hz],[-hx,hy,-hz]],
      [[-hx,hy,hz],[hx,hy,hz],[hx,hy,-hz],[-hx,hy,-hz]],
      [[-hx,-hy,-hz],[hx,-hy,-hz],[hx,-hy,hz],[-hx,-hy,hz]],
    ];
    for (let n = 0; n < faces.length; n++)
      if (!omit.includes(n)) this.quad(faces[n].map((v) => p(...v)), tile, color);
  }
  faceBox(face, u, y, out, width, height, depth, tile = 0, color = 0xffffff) {
    const c = Math.cos(face.angle), s = Math.sin(face.angle);
    const flush = this.feature !== 4 && out - depth / 2 <= face.out + 1e-5;
    this.box(u * c + out * s, y, -u * s + out * c, width, height, depth, tile, color, face.angle, flush ? [1] : []);
  }
  faceQuad(face, u, y, out, width, height, tile, color = 0xffffff, turn = 0) {
    const angle = face.angle + turn, c = Math.cos(angle), s = Math.sin(angle);
    const x = u * Math.cos(face.angle) + out * Math.sin(face.angle);
    const z = -u * Math.sin(face.angle) + out * Math.cos(face.angle);
    this.quad([[-1,-1],[1,-1],[1,1],[-1,1]].map(([a,b]) =>
      [x + a * width / 2 * c, y + b * height / 2, z - a * width / 2 * s]), tile, color);
  }
  cylinder(x, bottom, z, radius, height, color, segments = 8) {
    const ring = (angle, y) => [x + Math.cos(angle) * radius, y, z + Math.sin(angle) * radius];
    for (let n = 0; n < segments; n++) {
      const a = n * Math.PI * 2 / segments, b = (n + 1) * Math.PI * 2 / segments;
      this.quad([ring(b, bottom), ring(a, bottom), ring(a, bottom + height), ring(b, bottom + height)], 0, color);
      for (const [y, angles] of [[bottom + height, [b, a]]]) {
        this.batch.triangle([[x,y,z], ring(angles[0], y), ring(angles[1], y)].map((p) => this.point(...p)),
          color, 0, this.index, this.feature, [[0,0],[0,0],[0,0]]);
      }
    }
  }
}

function streetFaces(site, faces, roads) {
  const scores = faces.map(() => Infinity), c = Math.cos(site.heading ?? 0), s = Math.sin(site.heading ?? 0);
  for (const road of roads) {
    if (road.parkingBay) continue;
    const along = Math.max(road.min, Math.min(road.max, road.axis === "z" ? site.z : site.x));
    const dx = (road.axis === "z" ? road.fixed : along) - site.x;
    const dz = (road.axis === "x" ? road.fixed : along) - site.z;
    const localX = dx * c - dz * s, localZ = dx * s + dz * c;
    const index = Math.abs(localX) > Math.abs(localZ) ? (localX > 0 ? 1 : 3) : (localZ > 0 ? 0 : 2);
    scores[index] = Math.min(scores[index], Math.hypot(dx, dz) - road.width / 2);
  }
  const order = [0, 1, 2, 3].sort((a, b) => scores[a] - scores[b] || a - b);
  return { primary: order[0], shops: new Set(order.filter((i, n) => n === 0 || (n === 1 && scores[i] < scores[order[0]] + 7))) };
}

function windowDetail(atlas, solid, face, u, y, width, height, shutters) {
  atlas.feature = solid.feature = 1;
  atlas.faceQuad(face, u, y, face.out + 0.027, width, height, 6);
  solid.faceBox(face, u, y - height / 2, face.out + 0.075, width + 0.16, 0.095, 0.19, 0, COLORS.limestone);
  if (shutters) {
    for (const side of [-1, 1])
      atlas.faceQuad(face, u + side * (width / 2 + 0.18), y, face.out + 0.07,
        0.31, height * 0.94, 4, shutters === 2 ? 0xc9bd9e : 0xffffff, side * 0.28);
  }
}

function balcony(solid, face, floorY, width, openRail) {
  solid.feature = 2;
  solid.faceBox(face, 0, floorY + 0.08, face.out + 0.28, width, 0.14, 0.60, 0, COLORS.concrete);
  for (const side of [-1, 1]) {
    solid.faceBox(face, side * (width / 2 - 0.04), floorY + 0.47, face.out + 0.26,
      0.08, 0.65, 0.53, 0, COLORS.concrete);
    solid.faceBox(face, side * width * 0.31, floorY - 0.105, face.out + 0.12,
      0.16, 0.27, 0.30, 0, COLORS.concrete);
  }
  if (openRail) {
    for (const y of [floorY + 0.27, floorY + 0.94])
      solid.faceBox(face, 0, y, face.out + 0.55, width, 0.055, 0.055, 0, COLORS.iron);
    for (const u of [-width / 2 + 0.035, 0, width / 2 - 0.035])
      solid.faceBox(face, u, floorY + 0.605, face.out + 0.55, 0.045, 0.67, 0.045, 0, COLORS.iron);
  } else {
    solid.faceBox(face, 0, floorY + 0.47, face.out + 0.55, width, 0.65, 0.08, 0, COLORS.concrete);
    solid.faceBox(face, 0, floorY + 0.82, face.out + 0.55, width + 0.025, 0.07, 0.12, 0, COLORS.limestone);
  }
}

function roofEquipment(solid, atlas, width, depth, roof, seed, counts) {
  solid.feature = atlas.feature = 5;
  if (seed % 4 !== 0) {
    const x = -width * 0.23, z = -depth * 0.22, r = seed % 2 ? 0.48 : 0.41;
    solid.box(x, roof + 0.09, z, 1.18, 0.18, 1.18, 0, COLORS.concrete);
    solid.cylinder(x, roof + 0.18, z, r, 1.04, COLORS.tank);
    solid.cylinder(x, roof + 1.22, z, r * 0.91, 0.10, COLORS.dark);
    solid.box(x + r + 0.07, roof + 0.51, z, 0.07, 1.02, 0.07, 0, COLORS.pipe);
    solid.box(x + r - 0.035, roof + 0.99, z, 0.27, 0.07, 0.07, 0, COLORS.pipe);
    counts.tanks++;
  }
  if (seed % 3 !== 0) {
    const x = width * 0.24, z = depth * 0.18;
    solid.box(x, roof + 0.06, z, 0.58, 0.12, 0.58, 0, COLORS.concrete);
    solid.box(x, roof + 0.42, z, 0.075, 0.68, 0.075, 0, COLORS.iron);
    const center = [x, roof + 0.74, z];
    const rim = (angle) => [x + Math.cos(angle) * 0.45,
      roof + 0.74 + 0.12 * 0.82 + Math.sin(angle) * 0.45 * 0.57,
      z + 0.12 * 0.57 - Math.sin(angle) * 0.45 * 0.82];
    for (let n = 0; n < 10; n++) {
      const a = rim(n * Math.PI / 5), b = rim((n + 1) * Math.PI / 5);
      for (const points of [[center, b, a], [center, a, b]])
        solid.batch.triangle(points.map((p) => solid.point(...p)), COLORS.dish, 0, solid.index, solid.feature,
          [[0,0],[0,0],[0,0]]);
    }
    solid.box(x, roof + 0.74, z + 0.26, 0.035, 0.04, 0.56, 0, COLORS.iron);
    counts.dishes++;
  }
}

function buildSite(site, index, atlasBatch, solidBatch, roads, counts) {
  const seed = hash(site.id), style = seed % 4;
  const width = Math.max(0.7, site.width - 1.28), depth = Math.max(0.7, site.length - 1.28);
  const floors = Math.max(1, Math.min(5, Math.floor((site.height - 4.6) / 2.6)));
  const roof = 3 + floors * 2.6, plaster = style === 3 ? 1 : style % 3;
  const atlas = new Writer(atlasBatch, site, index), solid = new Writer(solidBatch, site, index);
  const faces = [0, 1, 2, 3].map((n) => ({
    angle: n * Math.PI / 2, width: n % 2 ? depth : width, out: (n % 2 ? width : depth) / 2,
  }));
  const streets = streetFaces(site, faces, roads);
  solid.box(0, 0.11, 0, site.width - 0.10, 0.22, site.length - 0.10, 0, COLORS.mortar);
  atlas.box(0, 1.5, 0, width, 3, depth, 15, 0xffffff, 0, [4, 5]);
  for (let floor = 0; floor < floors; floor++) {
    const bottom = 3 + floor * 2.6;
    atlas.feature = solid.feature = 0;
    atlas.box(0, bottom + 1.3, 0, width, 2.6, depth,
      style === 1 && floor >= floors - 2 ? 3 : plaster, 0xffffff, 0, [4, 5]);
    solid.box(0, bottom + 0.035, 0, width + 0.10, 0.14, depth + 0.10, 0, COLORS.concrete);
    for (let f = 0; f < 4; f++) {
      const face = faces[f], hasBalcony = f === streets.primary && (floor + seed) % 3 !== 1;
      const columns = hasBalcony ? 3 : 2;
      for (let column = 0; column < columns; column++) {
        const u = columns === 3 ? (column - 1) * face.width * 0.30 : (column - 0.5) * face.width * 0.46;
        const door = hasBalcony && column === 1;
        windowDetail(atlas, solid, face, u, bottom + (door ? 1.20 : 1.39),
          door ? 0.97 : 1.02, door ? 2.12 : 1.37, (seed + floor + column + f) % 3);
        counts.windows++;
      }
      if (hasBalcony) {
        balcony(solid, face, bottom, Math.min(2.65, face.width * 0.42), style === 2);
        counts.balconies++;
      }
      if (floor === floors - 1 && style !== 1 && f === (streets.primary + 1) % 4) {
        atlas.feature = 0;
        atlas.faceQuad(face, 0, bottom + 0.59, face.out + 0.014, 0.72, 0.94, 5);
      }
    }
  }
  for (let f = 0; f < 4; f++) {
    const face = faces[f];
    atlas.feature = solid.feature = 3;
    if (streets.shops.has(f)) {
      const bays = face.width >= 4 ? 2 : 1;
      for (let n = 0; n < bays; n++) {
        const u = (n - (bays - 1) / 2) * face.width * 0.49;
        const bayWidth = Math.min(2.83, face.width / bays - 0.28);
        const shop = (seed + n + f) % SHOP_NAMES.length;
        atlas.faceQuad(face, u, 1.17, face.out + 0.032, bayWidth, 2.05, [0, 1, 4].includes(shop) ? 6 : 7);
        solid.faceBox(face, u, 2.52, face.out + 0.085, bayWidth + 0.16, 0.78, 0.17, 0, COLORS.iron);
        atlas.faceQuad(face, u, 2.52, face.out + 0.175, bayWidth + 0.10, 0.70, 9 + shop);
        atlas.faceBox(face, u, 2.99, face.out + 0.22, bayWidth + 0.20, 0.11, 0.52, 8);
        for (const side of [-1, 1])
          solid.faceBox(face, u + side * bayWidth * 0.40, 2.87, face.out + 0.15,
            0.055, 0.19, 0.34, 0, COLORS.iron);
        counts.shops++;
      }
    } else {
      windowDetail(atlas, solid, face, -face.width * 0.22, 1.55, 0.85, 1.13, 1);
      counts.windows++;
      atlas.feature = 3;
      atlas.faceQuad(face, face.width * 0.20, 1.15, face.out + 0.03, 0.98, 2.06, 4);
    }
  }
  const acFace = faces[(streets.primary + 1) % 4];
  solid.feature = atlas.feature = 5;
  const acY = 4.75;
  solid.faceBox(acFace, 0.27, acY, acFace.out + 0.21, 0.83, 0.49, 0.37, 0, COLORS.limestone);
  atlas.faceQuad(acFace, 0.27, acY, acFace.out + 0.402, 0.68, 0.37, 7);
  for (const u of [-0.03, 0.57])
    solid.faceBox(acFace, u, acY - 0.28, acFace.out + 0.17, 0.055, 0.08, 0.40, 0, COLORS.iron);
  solid.faceBox(acFace, 0.69, acY - 0.11, acFace.out + 0.05, 0.24, 0.04, 0.04, 0, COLORS.pipe);
  solid.faceBox(acFace, 0.80, acY / 2, acFace.out + 0.045, 0.04, acY, 0.04, 0, COLORS.pipe);
  counts.airConditioners++;
  solid.feature = atlas.feature = 4;
  solid.box(0, roof + 0.06, 0, width + 0.16, 0.16, depth + 0.16, 0, COLORS.concrete);
  for (const face of faces) {
    atlas.faceBox(face, 0, roof + 0.43, face.out - 0.01, face.width + 0.12, 0.63, 0.16,
      style === 1 ? 3 : plaster);
    solid.faceBox(face, 0, roof + 0.77, face.out - 0.01, face.width + 0.18, 0.08, 0.21, 0, COLORS.limestone);
  }
  roofEquipment(solid, atlas, width, depth, roof, seed, counts);
  return { id: site.id, index, style, upperFloors: floors, roofY: roof + GROUND,
    primaryFace: streets.primary, shopFaces: [...streets.shops], width: site.width, length: site.length };
}

function roadBounds(road) {
  const h = road.width / 2;
  return road.axis === "z"
    ? { minX: road.fixed - h, maxX: road.fixed + h, minZ: road.min - h, maxZ: road.max + h }
    : { minX: road.min - h, maxX: road.max + h, minZ: road.fixed - h, maxZ: road.fixed + h };
}
const intersects = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;

function buildStreetSurfaces(roads, patches, curbs, counts) {
  const bounds = roads.map(roadBounds);
  for (let index = 0; index < roads.length; index++) {
    const road = roads[index];
    if (road.parkingBay) continue;
    const rng = random(hash(`${road.axis}:${road.fixed}:${road.min}:${road.max}`));
    const site = road.axis === "z"
      ? { x: road.fixed, z: 0, heading: 0 } : { x: 0, z: road.fixed, heading: Math.PI / 2 };
    const patch = new Writer(patches, site, -1, 6), curb = new Writer(curbs, site, -1, 7);
    const rectAt = (u, along, halfWidth, halfLength) => road.axis === "z"
      ? { minX: road.fixed + u - halfWidth, maxX: road.fixed + u + halfWidth, minZ: along - halfLength, maxZ: along + halfLength }
      : { minX: along - halfLength, maxX: along + halfLength, minZ: road.fixed - u - halfWidth, maxZ: road.fixed - u + halfWidth };
    const blocked = (rect) => bounds.some((other, n) => n !== index && intersects(rect, other));
    for (let along = road.min + 12 + rng() * 6; along < road.max - 6; along += 31) {
      const u = (rng() > 0.5 ? 1 : -1) * road.width * 0.23;
      const halfWidth = 0.56 + rng() * 0.38, halfLength = 1.1 + rng() * 0.8;
      if (blocked(rectAt(u, along, halfWidth + 0.3, halfLength + 0.6))) continue;
      const points = [
        [u-halfWidth*.8, along-halfLength], [u-halfWidth, along+halfLength*.7],
        [u-halfWidth*.4, along+halfLength], [u+halfWidth*.85, along+halfLength*.85],
        [u+halfWidth, along-halfLength*.65], [u+halfWidth*.35, along-halfLength],
      ];
      const tint = rng() > 0.5 ? 0x575950 : 0x69695b;
      for (let n = 1; n < points.length - 1; n++)
        patches.triangle([points[0], points[n], points[n+1]].map(([x,z]) => patch.point(x, 0.004, z)),
          tint, 0, -1, 6, [[0,0],[0,0],[0,0]]);
      counts.patches++;
    }
    for (const side of [-1, 1])
      for (let n = 0, along = road.min + 2; along < road.max - 3; n++, along += 1.42) {
        const u = side * (road.width / 2 + 0.23), length = Math.min(1.38, road.max - 2 - along);
        if (blocked(rectAt(u, along + length / 2, 0.19, length / 2 + 0.16))) continue;
        curb.quad([[u-0.14,-0.040,along],[u-0.14,-0.040,along+length],
          [u+0.14,-0.040,along+length],[u+0.14,-0.040,along]], 0, n % 2 ? 0xbcb8a4 : 0x55574e);
        counts.curbSegments++;
      }
  }
}

/**
 * Owns only the registered building visuals and flat road/curb paint.
 * The consumer attaches root once and calls dispose before generic scene cleanup.
 */
export function createEgyptStreetLayer(world) {
  const root = new THREE.Group();
  root.name = "egypt-street-layer";
  root.userData.egyptStreetLayer = true;
  const active = world.environment === "city" || world.environment === "vision";
  const diagnostics = {
    active, siteIds: [], sites: [], featureNames: [...FEATURES], drawCalls: 0, triangles: 0,
    counts: { windows: 0, balconies: 0, shops: 0, tanks: 0, dishes: 0, airConditioners: 0, patches: 0, curbSegments: 0 },
    textAtlasAvailable: false, shopNames: [...SHOP_NAMES], disposed: false,
    resources: { geometries: 0, materials: 0, textures: 0, liveGeometries: 0, liveMaterials: 0, liveTextures: 0 },
    budget: { maxDrawCalls: 45, maxTriangles: 100000, withinBudget: true },
  };
  const geometries = new Set(), materials = new Set(), textures = new Set();
  const dispose = () => {
    if (diagnostics.disposed) return;
    root.removeFromParent(); root.clear();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    geometries.clear(); materials.clear(); textures.clear();
    diagnostics.resources.liveGeometries = diagnostics.resources.liveMaterials = diagnostics.resources.liveTextures = 0;
    diagnostics.disposed = true;
  };
  if (!active) return { root, diagnostics, dispose };
  const sites = (world.statics ?? []).filter((site) => site.kind === "building").slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id), "en"));
  const roads = (world.roads ?? []).slice().sort((a, b) =>
    `${a.axis}:${a.fixed}:${a.min}:${a.max}:${a.width}`.localeCompare(`${b.axis}:${b.fixed}:${b.min}:${b.max}:${b.width}`, "en"));
  diagnostics.siteIds = sites.map((site) => site.id);
  if (!sites.length && !roads.length) return { root, diagnostics, dispose };
  const texture = sites.length ? makeAtlas() : null;
  if (texture) textures.add(texture);
  diagnostics.textAtlasAvailable = !!texture;
  const flat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
  flat.name = "egypt-matte-masonry-and-hardware";
  materials.add(flat);
  const mapped = sites.length ? new THREE.MeshStandardMaterial({
    map: texture, vertexColors: true, roughness: 0.98, metalness: 0,
  }) : null;
  if (mapped) { mapped.name = "egypt-authored-facade-atlas"; materials.add(mapped); }
  const batches = [];
  const districts = new Map();
  sites.forEach((site, index) => {
    const key = `${site.x < 0 ? "west" : "east"}-${site.z < 0 ? "south" : "north"}`;
    if (!districts.has(key)) {
      const pair = [new Batch(`egypt-${key}-facades`, mapped), new Batch(`egypt-${key}-structure`, flat)];
      districts.set(key, pair); batches.push(...pair);
    }
    diagnostics.sites.push(buildSite(site, index, ...districts.get(key), roads, diagnostics.counts));
  });
  if (roads.length) {
    const paint = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    paint.name = "egypt-flat-road-repairs-and-curb-paint";
    materials.add(paint);
    const patches = new Batch("egypt-asphalt-repairs", paint, true), curbs = new Batch("egypt-painted-curb", paint, true);
    buildStreetSurfaces(roads, patches, curbs, diagnostics.counts);
    batches.push(patches, curbs);
  }
  for (const batch of batches) {
    const mesh = batch.mesh();
    if (!mesh) continue;
    root.add(mesh); geometries.add(mesh.geometry);
    diagnostics.drawCalls++; diagnostics.triangles += mesh.geometry.attributes.position.count / 3;
  }
  Object.assign(diagnostics.resources, {
    geometries: geometries.size, materials: materials.size, textures: textures.size,
    liveGeometries: geometries.size, liveMaterials: materials.size, liveTextures: textures.size,
  });
  diagnostics.budget.withinBudget = diagnostics.drawCalls <= 45 && diagnostics.triangles <= 100000;
  return { root, diagnostics, dispose };
}
