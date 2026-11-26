import * as THREE from "three";
import { roadRect } from "../core/geometry.js";

const GROUND = 0.12;
const ATLAS_SIZE = 2048;
const TILE_SIZE = ATLAS_SIZE / 4;
const SHOP_NAMES = ["بقالة", "صيدلية", "فرن بلدي", "ورشة", "قهوة"];
const GRAND_SHOP_TITLES = [
  ["سوبر ماركت البركة", "مواد غذائية وخضروات طازجة"],
  ["صيدلية الشفاء", "دواء وعناية · خدمة ٢٤ ساعة"],
  ["فرن وحلواني التحرير", "عيش بلدي طازة وفطائر"],
  ["مركز صيانة وقطع غيار", "ميكانيكا وكهرباء سيارات"],
  ["قهوة وعصير المعز", "شاي وقهوة وقصب طازج"],
];
const GRAND_AWNING_TINTS = [0xa39174, 0x7a392f, 0x2c4f42, 0x2c3f52, 0x8a6331];
const FEATURES = ["masonry", "window", "balcony", "shop", "roof", "equipment", "patch", "curb"];
const COLORS = {
  concrete: 0xb9ac94, limestone: 0xcbbda0, mortar: 0xb3a38b,
  iron: 0x4c5a51, timber: 0x738070, dark: 0x454942,
  tank: 0x535550, pipe: 0x827c6b, dish: 0xb8b8a7,
};
const GRAND_COLORS = {
  concrete: 0x8f8573, limestone: 0x9e927d, mortar: 0x7d7261,
  iron: 0x2c3330, timber: 0x566154, dark: 0x2b2f2d,
  tank: 0x3a3d3b, pipe: 0x666053, dish: 0x919082,
};

export const usesCityV4StreetFinish = (world) =>
  world.environment === "metro" && (world.config?.cityVersion ?? 0) >= 4;

function diagRoadFrame(road) {
  const dx = road.x2 - road.x1, dz = road.z2 - road.z1;
  const length = road.length ?? (Math.hypot(dx, dz) || 0);
  const ux = road.ux ?? (length > 0 ? dx / length : 0);
  const uz = road.uz ?? (length > 0 ? dz / length : 1);
  const heading = road.heading ?? Math.atan2(ux, uz);
  return { length, ux, uz, heading };
}

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

function makeGrandCairoAtlas() {
  let canvas;
  if (typeof document !== "undefined" && document.createElement)
    canvas = document.createElement("canvas");
  else if (typeof OffscreenCanvas !== "undefined")
    canvas = new OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE);
  const ctx = canvas?.getContext("2d");
  if (!ctx) return null;
  canvas.width = canvas.height = ATLAS_SIZE;
  const rng = random(0x43414952);
  const bases = [
    "#9c8f7b", "#a89d8a", "#8e7d67", "#7f5642",
    "#4a594c", "#865e49", "#968b78", "#5e635c",
    "#aa9677", "#22423e", "#213d33", "#6b3527",
    "#273947", "#523b2a", "#968773", "#8d8678",
  ];
  const weatherBand = (tx, ty) => {
    for (let step = 0; step < 5; step++) {
      ctx.fillStyle = "rgba(24,19,14,0.055)";
      ctx.fillRect(tx, ty, 512, 18 + step * 16);
      ctx.fillRect(tx, ty + 512 - (22 + step * 18), 512, 22 + step * 18);
    }
  };
  for (let tile = 0; tile < 16; tile++) {
    const x = (tile % 4) * TILE_SIZE, y = Math.floor(tile / 4) * TILE_SIZE;
    ctx.fillStyle = bases[tile];
    ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
    if ([0, 1, 2, 14, 15].includes(tile)) {
      // Muted smoky Cairo travertine / aged plaster courses + deep mortar shadow lines
      for (let course = 32; course < 512; course += 64) {
        ctx.fillStyle = "rgba(32,26,20,0.22)";
        ctx.fillRect(x, y + course, 512, 4);
        ctx.fillStyle = "rgba(218,206,184,0.08)";
        ctx.fillRect(x, y + course + 4, 512, 2);
      }
      if (tile === 1 || tile === 14 || tile === 15) {
        for (let row = 0; row < 8; row++) {
          const offset = (row % 2) * 64;
          ctx.fillStyle = "rgba(32,26,20,0.16)";
          for (let jx = offset + 64; jx < 512; jx += 128)
            ctx.fillRect(x + jx, y + row * 64, 2, 64);
        }
      }
      for (let n = 0; n < 240; n++) {
        ctx.fillStyle = n % 3 ? "rgba(32,26,20,0.065)" : "rgba(214,202,178,0.075)";
        ctx.fillRect(x + rng() * 496, y + rng() * 496, 8 + rng() * 68, 2 + rng() * 20);
      }
      weatherBand(x, y);
      ctx.fillStyle = "rgba(28,22,16,0.22)";
      for (const drip of [48, 162, 288, 418])
        ctx.fillRect(x + drip, y + 2, 4, 80 + rng() * 120);
    } else if (tile === 3 || tile === 5) {
      // Weathered Egyptian fired clay brick & dark smoky mortar courses
      ctx.fillStyle = "#5c5245";
      ctx.fillRect(x, y, 512, 512);
      for (let row = 0; row < 17; row++)
        for (let column = -1; column < 17; column++) {
          const bx = x + column * 34 + (row % 2) * 17;
          ctx.fillStyle = ["#7f5642", "#91634c", "#865e49", "#6c4837"][(row * 3 + column + 7) % 4];
          const left = Math.max(x, bx + 2), right = Math.min(x + 512, bx + 32);
          if (right > left) ctx.fillRect(left, y + row * 30 + 2, right - left, 26);
        }
      weatherBand(x, y);
      ctx.fillStyle = "rgba(32,26,20,0.24)";
      ctx.fillRect(x, y, 512, 16);
    } else if (tile === 4) {
      // Muted dusty-olive Egyptian wooden louvered shutters (شيش خشب)
      ctx.fillStyle = "#344036";
      ctx.fillRect(x, y, 512, 512);
      ctx.fillStyle = "#4a594c";
      ctx.fillRect(x + 26, y + 24, 460, 464);
      for (let slat = 38; slat < 474; slat += 18) {
        ctx.fillStyle = "#263128";
        ctx.fillRect(x + 38, y + slat, 436, 8);
        ctx.fillStyle = "#627362";
        ctx.fillRect(x + 38, y + slat + 8, 436, 3);
      }
      ctx.fillStyle = "#344036";
      ctx.fillRect(x + 244, y + 24, 24, 464);
      ctx.fillRect(x + 26, y + 242, 460, 22);
      weatherBand(x, y);
    } else if (tile === 6) {
      // Dark bronze/charcoal casement window with warm tungsten interior & dark unlit glass
      ctx.fillStyle = "#202625";
      ctx.fillRect(x + 18, y + 18, 476, 476);
      ctx.fillStyle = "#2f3836";
      ctx.fillRect(x + 34, y + 34, 444, 444);
      // Left pane: warm muted tungsten interior light behind sheer Cairo curtain
      ctx.fillStyle = "#7d6848";
      ctx.fillRect(x + 48, y + 48, 196, 356);
      ctx.fillStyle = "#d8aa68";
      ctx.fillRect(x + 76, y + 92, 148, 268);
      ctx.fillStyle = "rgba(222,204,170,0.44)";
      ctx.fillRect(x + 52, y + 52, 92, 348);
      ctx.fillStyle = "rgba(238,222,188,0.26)";
      ctx.fillRect(x + 68, y + 52, 24, 348);
      // Right pane: dark unlit apartment interior with subtle dusk reflection
      ctx.fillStyle = "#232d2e";
      ctx.fillRect(x + 268, y + 48, 196, 356);
      ctx.fillStyle = "rgba(116,134,138,0.18)";
      ctx.fillRect(x + 278, y + 60, 176, 88);
      ctx.fillStyle = "rgba(216,170,104,0.15)";
      ctx.fillRect(x + 268, y + 344, 196, 60);
      // Dark metal mullions & transom
      ctx.fillStyle = "#272e2d";
      ctx.fillRect(x + 246, y + 34, 18, 444);
      ctx.fillRect(x + 34, y + 404, 444, 14);
      ctx.fillStyle = "#857a68";
      ctx.fillRect(x + 34, y + 470, 444, 10);
      ctx.fillStyle = "#1d2424";
      ctx.fillRect(x + 48, y + 422, 416, 44);
    } else if (tile === 7) {
      // Weathered corrugated steel shop shutter & dark split-AC outdoor fan grille
      ctx.fillStyle = "#5e635c";
      ctx.fillRect(x, y, 512, 512);
      for (let n = 6; n < 512; n += 16) {
        ctx.fillStyle = "#363b38";
        ctx.fillRect(x, y + n, 512, 6);
        ctx.fillStyle = "#787d74";
        ctx.fillRect(x, y + n + 6, 512, 3);
      }
      ctx.fillStyle = "#1e2322";
      ctx.fillRect(x + 54, y + 96, 256, 256);
      ctx.fillStyle = "#323937";
      for (let r = 116; r < 336; r += 20)
        ctx.fillRect(x + 70, y + r, 224, 8);
      ctx.fillStyle = "#9da095";
      ctx.fillRect(x + 350, y + 120, 108, 42);
      weatherBand(x, y);
    } else if (tile === 8) {
      // Muted sun-faded striped Cairo canvas shop awning
      for (let n = 0; n < 512; n += 64) {
        ctx.fillStyle = "#c2b092";
        ctx.fillRect(x + n, y, 32, 512);
        ctx.fillStyle = "#6b3528";
        ctx.fillRect(x + n + 32, y, 32, 512);
      }
      ctx.fillStyle = "rgba(26,20,14,0.28)";
      ctx.fillRect(x, y + 464, 512, 48);
    } else if (tile >= 9 && tile <= 13) {
      const rect = atlasRect(tile);
      const [title, sub] = GRAND_SHOP_TITLES[tile - 9];
      ctx.fillStyle = "#a89472";
      ctx.fillRect(rect.x + 4, rect.y + 4, 504, 120);
      ctx.fillStyle = "#191f1d";
      ctx.fillRect(rect.x + 10, rect.y + 10, 492, 108);
      ctx.fillStyle = bases[tile];
      ctx.fillRect(rect.x + 15, rect.y + 15, 482, 98);
      ctx.fillStyle = "#c4a162";
      ctx.fillRect(rect.x + 24, rect.y + 22, 464, 3);
      ctx.fillRect(rect.x + 24, rect.y + 103, 464, 3);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.direction = "rtl";
      ctx.fillStyle = "#efe1c2";
      ctx.font = "bold 54px Tahoma, sans-serif";
      ctx.fillText(title, rect.x + 256, rect.y + 52, 452);
      ctx.fillStyle = "#d6bc8b";
      ctx.font = "bold 22px Tahoma, sans-serif";
      ctx.fillText(sub, rect.x + 256, rect.y + 88, 446);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = "egypt-local-plaster-brick-shops";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
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
  constructor(batch, site, index, feature = 0, baseY = GROUND, terrainFn = null) {
    this.batch = batch; this.site = site; this.index = index; this.feature = feature;
    this.baseY = baseY; this.terrainFn = terrainFn;
    this.cos = Math.cos(site.heading ?? 0); this.sin = Math.sin(site.heading ?? 0);
  }
  point(x, y, z) {
    const wx = this.site.x + x * this.cos + z * this.sin;
    const wz = this.site.z - x * this.sin + z * this.cos;
    const wy = y + this.baseY + (this.terrainFn ? this.terrainFn(wx, wz) : 0);
    return new THREE.Vector3(wx, wy, wz);
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
    let dx, dz;
    if (road.axis === "diag") {
      const { length, ux, uz } = diagRoadFrame(road);
      const along = Math.max(0, Math.min(length, (site.x - road.x1) * ux + (site.z - road.z1) * uz));
      dx = road.x1 + ux * along - site.x;
      dz = road.z1 + uz * along - site.z;
    } else {
      const along = Math.max(road.min, Math.min(road.max, road.axis === "z" ? site.z : site.x));
      dx = (road.axis === "z" ? road.fixed : along) - site.x;
      dz = (road.axis === "x" ? road.fixed : along) - site.z;
    }
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

function roofEquipment(solid, atlas, width, depth, roof, seed, counts, grand = false) {
  const palette = grand ? GRAND_COLORS : COLORS;
  solid.feature = atlas.feature = 5;
  if (seed % 4 !== 0) {
    const x = -width * 0.23, z = -depth * 0.22, r = seed % 2 ? 0.48 : 0.41;
    solid.box(x, roof + 0.09, z, 1.18, 0.18, 1.18, 0, palette.concrete);
    solid.cylinder(x, roof + 0.18, z, r, 1.04, palette.tank);
    solid.cylinder(x, roof + 1.22, z, r * 0.91, 0.10, palette.dark);
    solid.box(x + r + 0.07, roof + 0.51, z, 0.07, 1.02, 0.07, 0, palette.pipe);
    solid.box(x + r - 0.035, roof + 0.99, z, 0.27, 0.07, 0.07, 0, palette.pipe);
    counts.tanks++;
  }
  if (seed % 3 !== 0) {
    const x = width * 0.24, z = depth * 0.18;
    solid.box(x, roof + 0.06, z, 0.58, 0.12, 0.58, 0, palette.concrete);
    solid.box(x, roof + 0.42, z, 0.075, 0.68, 0.075, 0, palette.iron);
    const center = [x, roof + 0.74, z];
    const rim = (angle) => [x + Math.cos(angle) * 0.45,
      roof + 0.74 + 0.12 * 0.82 + Math.sin(angle) * 0.45 * 0.57,
      z + 0.12 * 0.57 - Math.sin(angle) * 0.45 * 0.82];
    for (let n = 0; n < 10; n++) {
      const a = rim(n * Math.PI / 5), b = rim((n + 1) * Math.PI / 5);
      for (const points of [[center, b, a], [center, a, b]])
        solid.batch.triangle(points.map((p) => solid.point(...p)), palette.dish, 0, solid.index, solid.feature,
          [[0,0],[0,0],[0,0]]);
    }
    solid.box(x, roof + 0.74, z + 0.26, 0.035, 0.04, 0.56, 0, palette.iron);
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

const METRO_CELL = 56;
const STREAM_CELL = 36;
const GRAND_METRO_CELL = 240;
const GRAND_STREAM_CELL = 125;
const DETAIL_RADIUS = 42;
const PREWARM_RADIUS = 51;
const RELEASE_RADIUS = 59;
const GRAND_DETAIL_RADIUS = 62;
const GRAND_PREWARM_RADIUS = 136;
const GRAND_RELEASE_RADIUS = 108;
const METRO_BUDGET = { maxDrawCalls: 96, maxTriangles: 170000 };
const METRO_V5_BUDGET = { maxDrawCalls: 75, maxTriangles: 260000 };
const METRO_PLASTER = [
  [0, 0xfff5e6, 0xb9a58b], [3, 0xffdfca, 0xae9479],
  [1, 0xf6f1de, 0xb0a595], [2, 0xffecda, 0xaf977d],
];
const METRO_STONE = [
  [1, 0xfffaec, 0xc3b69e], [15, 0xf3efe4, 0xb9afa0],
  [1, 0xe9eddf, 0xa5aaa0], [14, 0xfff5e3, 0xb9a892],
];
const GRAND_METRO_PLASTER = [
  [0, 0xd4cab9, 0x8f8573], [3, 0xcfbcb0, 0x857666],
  [1, 0xcac2b3, 0x8a8172], [2, 0xccbdab, 0x867867],
];
const GRAND_METRO_STONE = [
  [1, 0xd6cebe, 0x9e927d], [15, 0xcac3b5, 0x8f8573],
  [1, 0xc1c5ba, 0x80857c], [14, 0xd0c5b2, 0x928571],
];
const METRO_CLOSE_FEATURES = ["bakery-display", "produce-crates", "repair-bay", "entry-fittings", "balcony-planter"];
const [BAKERY, GROCER, REPAIR, ENTRY, PLANTER] = METRO_CLOSE_FEATURES.map((_, n) => FEATURES.length + n);
const MARKET_FEATURES = ["market-awning", "market-produce", "market-flatbread", "market-tea"];
const [MARKET_AWNING, MARKET_PRODUCE, MARKET_FLATBREAD, MARKET_TEA] =
  MARKET_FEATURES.map((_, n) => FEATURES.length + METRO_CLOSE_FEATURES.length + n);
const MARKET_STALLS = {
  0: { feature: MARKET_PRODUCE, canvas: 0x477962, paint: 0x557868 },
  2: { feature: MARKET_FLATBREAD, canvas: 0xac5740, paint: 0x8c593e },
  4: { feature: MARKET_TEA, canvas: 0x397780, paint: 0x4a6f75 },
};
const GRAND_MARKET_STALLS = {
  0: { feature: MARKET_PRODUCE, canvas: 0x2f5444, paint: 0x3b5449 },
  2: { feature: MARKET_FLATBREAD, canvas: 0x7d3d2d, paint: 0x66402d },
  4: { feature: MARKET_TEA, canvas: 0x2a5359, paint: 0x365054 },
};
const STREET_FINISH_FEATURES = ["masonry-dado", "shop-kickplate", "gutter", "drain-grate", "scored-forecourt"];
const [DADO, KICKPLATE, GUTTER, DRAIN, FORECOURT] = STREET_FINISH_FEATURES.map((_, n) =>
  FEATURES.length + METRO_CLOSE_FEATURES.length + MARKET_FEATURES.length + n);
const GROUND_FINISHES = [
  // Mineral plaster above a more durable street-level stone or tile course.
  { tile: 1, plaster: 0xf3ebd5, dado: [15, 0xaaa99c], height: .69 },
  { tile: 14, plaster: 0xead8b8, dado: [3, 0xb7a58d], height: .76 },
  { tile: 15, plaster: 0xe7e6db, dado: [2, 0xa2ada7], height: .59 },
  { tile: 2, plaster: 0xf3d7c0, dado: [14, 0xc3b9ab], height: .83 },
];
const GRAND_GROUND_FINISHES = [
  { tile: 1, plaster: 0xc4baaa, dado: [15, 0x6f6e64], height: .69 },
  { tile: 14, plaster: 0xbcae96, dado: [3, 0x7a6a58], height: .76 },
  { tile: 15, plaster: 0xb8b6ac, dado: [2, 0x68706b], height: .59 },
  { tile: 2, plaster: 0xbfa994, dado: [14, 0x837a6d], height: .83 },
];
const SHOP_PLATES = [
  [15, 0x829e92], [1, 0xb6b9a2], [15, 0xb07d69], [15, 0x858f8b], [2, 0xa29076],
];
const GRAND_SHOP_PLATES = [
  [15, 0x52655c], [1, 0x797c6c], [15, 0x744f42], [15, 0x555d5a], [2, 0x6b5e4d],
];
const COURT_PAVING = [
  [0x808883, 0x848b87, 0x858882],
  [0x867f74, 0x8e887b, 0x85837a],
];
const GRAND_COURT_PAVING = [
  [0x6e6b62, 0x65625a, 0x757167],
  [0x65625a, 0x6e6b62, 0x757167],
];

function metroStreetFaces(site, faces, roads, boulevard) {
  const entries = faces.flatMap((face, index) => {
    const yaw = face.angle + (site.heading ?? 0), nx = Math.sin(yaw), nz = Math.cos(yaw);
    const x = site.x + nx * face.hull, z = site.z + nz * face.hull;
    return roads.flatMap((road) => {
      if (road.parkingBay || road.supportApron) return [];
      let dx, dz;
      if (road.axis === "diag") {
        const { length, ux, uz } = diagRoadFrame(road);
        const along = Math.max(0, Math.min(length, (x - road.x1) * ux + (z - road.z1) * uz));
        dx = road.x1 + ux * along - x;
        dz = road.z1 + uz * along - z;
      } else {
        const vertical = road.axis === "z";
        const along = Math.max(road.min, Math.min(road.max, vertical ? z : x));
        dx = (vertical ? road.fixed : along) - x;
        dz = (vertical ? along : road.fixed) - z;
      }
      const distance = Math.hypot(dx, dz), lateral = Math.abs(dx * nz - dz * nx);
      if (dx * nx + dz * nz < Math.max(0.01, distance * 0.53)) return [];
      return [{ index, road, score: Math.max(0, distance - road.width / 2) + lateral * 0.3 }];
    });
  }).sort((a, b) => a.score - b.score || a.index - b.index
    || String(a.road.id).localeCompare(String(b.road.id), "en"));
  const first = entries[0];
  const main = (boulevard && entries.find(({ road, score }) =>
    road.zone === "avenue" && score <= first.score + 5)) || first;
  const secondary = main && entries.find(({ index, score }) =>
    index % 2 !== main.index % 2 && score <= Math.min(10, main.score + 3.8));
  const primary = main?.index ?? 0;
  return { primary, roadId: main?.road.id ?? null,
    shops: new Set(secondary ? [primary, secondary.index] : [primary]) };
}

function metroQuad(writer, face, points, tile, color) {
  const { c, s } = face;
  writer.quad(points.map(([u, y, d]) => [u * c + d * s, y, -u * s + d * c]), tile, color);
}

function metroPanel(writer, face, l, r, b, t, d, tile, color) {
  if (r > l + 1e-5 && t > b + 1e-5)
    metroQuad(writer, face, [[l,b,d],[r,b,d],[r,t,d],[l,t,d]], tile, color);
}

// Cut the openings out of the street face; the back, jambs and soffit are real separate planes.
function metroWall(atlas, solid, face, bottom, top, tile, tint, bays, finish = null, grand = false) {
  const { out } = face, edge = face.width / 2;
  let start = -edge;
  const wall = (l, r, b, t) => {
    if (finish && b < finish.height) {
      atlas.feature = DADO;
      metroPanel(atlas, face, l, r, b, Math.min(t, finish.height), out, ...finish.dado);
      b = finish.height;
    }
    atlas.feature = 0;
    metroPanel(atlas, face, l, r, b, t, out, tile, tint);
  };
  const jambL = grand ? 0x6b6050 : 0x9a8b75;
  const jambR = grand ? 0x5d5346 : 0x887c69;
  const sillC = grand ? 0x8a7d69 : 0xb3a38b;
  const soffitC = grand ? 0x473f35 : 0x726658;
  for (const { l, r, b, t, d, feature } of bays) {
    wall(start, l, bottom, top);
    wall(l, r, bottom, b);
    wall(l, r, t, top);
    start = r;
    solid.feature = feature;
    metroQuad(solid, face, [[l,b,out],[l,b,d],[l,t,d],[l,t,out]], 0, jambL);
    metroQuad(solid, face, [[r,b,d],[r,b,out],[r,t,out],[r,t,d]], 0, jambR);
    metroQuad(solid, face, [[l,b,d],[l,b,out],[r,b,out],[r,b,d]], 0, sillC);
    metroQuad(solid, face, [[l,t,out],[l,t,d],[r,t,d],[r,t,out]], 0, soffitC);
  }
  atlas.feature = 0;
  wall(start, edge, bottom, top);
}

function metroGlazing(atlas, solid, face, bay, variant, shutter = false, grand = false) {
  const { l, r, b, t, d, feature } = bay;
  const w = r - l, h = t - b, m = (l + r) / 2, trim = Math.min(0.065, w * 0.11);
  const frame = grand
    ? (variant % 3 === 1 ? 0x2b2f2c : 0x222827)
    : (variant % 3 === 1 ? 0x4c4940 : 0x39463d);
  atlas.feature = solid.feature = feature;
  metroPanel(solid, face, l, r, b, t, d, 0, frame);
  if (shutter) {
    metroPanel(atlas, face, l + trim, r - trim, b + trim, t - trim, d + 0.012, 7, grand ? 0x918e82 : 0xd5d4c3);
    return;
  }
  if (grand) {
    if (feature === 3 && bay.shop) {
      const warm = variant % 5 !== 0;
      metroPanel(solid, face, l + trim, m - trim * 0.65, b + trim, t - trim, d + 0.011, 0,
        warm ? 0xd9ad6b : 0x876a45);
      metroPanel(solid, face, m + trim * 0.65, r - trim, b + trim, t - trim, d + 0.011, 0,
        warm ? 0xc49555 : 0x6b5438);
      const rail = b + h * 0.19, transom = b + h * 0.77;
      metroPanel(solid, face, l, r, rail, rail + 0.06, d + 0.018, 0, frame);
      metroPanel(solid, face, l, r, transom, transom + 0.048, d + 0.018, 0, frame);
      return;
    }
    const lit = variant % 3 === 0;
    metroPanel(solid, face, l + trim, m - trim / 2, b + trim, t - trim, d + 0.011, 0,
      lit ? 0xd8aa68 : 0x232d2e);
    metroPanel(solid, face, m + trim / 2, r - trim, b + trim, t - trim, d + 0.011, 0,
      lit ? 0x7d6848 : 0x1d2627);
    if (feature === 3) {
      const rail = b + h * 0.19;
      metroPanel(solid, face, l, r, rail, rail + 0.06, d + 0.018, 0, frame);
    }
    return;
  }
  const light = variant % 4 === 1;
  metroPanel(solid, face, l + trim, m - trim / 2, b + trim, t - trim, d + 0.011, 0,
    light ? 0x958879 : 0x586c65);
  metroPanel(solid, face, m + trim / 2, r - trim, b + trim, t - trim, d + 0.011, 0,
    light ? 0x687c70 : 0x4c5c58);
  if (feature === 3) {
    const rail = b + h * 0.19;
    metroPanel(solid, face, l, r, rail, rail + 0.06, d + 0.018, 0, frame);
  }
}

function metroGroundBays(face, top, shopfront, main, boulevard, grand = false) {
  const bays = [], bottom = 0.16, setback = Math.min(boulevard ? 0.62 : 0.40, face.out * 0.39);
  const maxShops = grand && face.width > 28 ? (main ? 5 : 3) : (main ? 3 : 2);
  const numShops = shopfront ? Math.min(maxShops, Math.max(1, Math.floor(face.width / 4.1))) : 0;
  const slots = numShops + Number(face.width > 5.5 || numShops === 0);
  const step = face.width / slots, entry = boulevard ? Math.floor(slots / 2) : slots - 1;
  for (let n = 0; n < slots; n++) {
    const shop = numShops > 0 && (numShops === slots || n !== entry);
    const u = (n - (slots - 1) / 2) * step;
    const w = Math.min(shop ? (boulevard ? 4.1 : 3.8) : (boulevard && main ? 2.45 : 1.22),
      step * (shop ? 0.85 : 0.70));
    bays.push({ l: u - w / 2, r: u + w / 2, b: bottom + top * 0.022,
      t: top * (shop ? 0.67 : 0.73), d: face.out - setback, shop, feature: 3, u, w });
  }
  return bays;
}

function metroBreadStack(solid, face, u, y, d, radius, depth, shade) {
  const ring = [[-1, 0], [-.57, 1], [.49, 1], [1, 0], [.53, -1], [-.47, -1]];
  const top = ring.map(([x, z]) => [u + x * radius, y + .087 - z * .02, d + z * depth]);
  const lower = top.map(([x, h, z]) => [x, h - .075, z]);
  const seam = [1, 2].map(n => [top[n][0], top[n][1] - .040, top[n][2] + .006]);
  metroQuad(solid, face, [lower[1], lower[2], seam[1], seam[0]], 0, 0xa26538);
  metroQuad(solid, face, [seam[0], seam[1], top[2], top[1]], 0, 0xc98d52);
  for (const i of [0, 2])
    metroQuad(solid, face, [lower[i], lower[i + 1], top[i + 1], top[i]], 0, 0xa16a3b);
  metroQuad(solid, face, [top[0], top[1], top[2], top[3]], 0, shade);
  metroQuad(solid, face, [top[0], top[3], top[4], top[5]], 0, shade);
}

function metroMerchantDisplay(solid, face, bay, tenant) {
  const bakery = tenant === 2;
  solid.feature = bakery ? BAKERY : GROCER;
  const { l, b, t, d, w } = bay;
  const left = l + w * .09, right = l + w * .68;
  const y = b + (t - b) * .40;
  const back = d + .038, front = d + (face.out - d) * .55;
  // The sloped display reads from the road without bringing the threshold forward.
  metroPanel(solid, face, left, right, y - .17, y, front, 0, bakery ? 0xa37e58 : 0x8c7555);
  metroQuad(solid, face, [[left,y,front],[right,y,front],[right,y+.087,back],[left,y+.087,back]],
    0, bakery ? 0xceb08a : 0xb39465);
  const step = (right - left) / 3;
  for (const [i, color] of (bakery ? [0xe8c288, 0xd8a96a, 0xf0cd91] : [0xbe6450, 0x9ca463, 0xd2964e]).entries()) {
    const u = left + (i + .5) * step;
    if (bakery) {
      metroBreadStack(solid, face, u, y + .037 + i * .015, (back + front) / 2,
        Math.min(step * .39, .17), (front - back) * .42, color);
    } else {
      const lo = u - step * .44, hi = u + step * .44, lip = front - .013;
      const produce = [[lo,y+.063,lip],[hi,y+.063,lip],
        [hi-step*.11,y+.17,back+.015],[lo+step*.09,y+.17,back+.015]];
      metroQuad(solid, face, produce, 0, color);
      metroPanel(solid, face, lo, hi, y + .014, y + .073, front, 0, 0xd1ae77);
      const mid = (lo + hi) / 2;
      const raised = (u, depth) => [u, y + .079 + .107 * (lip - depth) / (lip - back - .015), depth];
      metroQuad(solid, face, [raised(mid-step*.18,lip-.027), raised(mid+step*.13,lip-.027),
        raised(mid+step*.10,back+.040), raised(mid-step*.13,back+.040)],
        0, [0xce7a60, 0xb6b97a, 0xe0b469][i]);
    }
  }
}

function metroRepairBay(atlas, solid, face, bay) {
  const { l, r, b, t, d, w } = bay, h = t - b, recess = face.out - d;
  atlas.feature = solid.feature = REPAIR;
  metroPanel(solid, face, l, r, b, t, d, 0, 0x434c48);
  // A part-raised shutter leaves the bench and spare wheel visible below.
  const shutter = t - h * .33;
  metroPanel(atlas, face, l + .042, r - .042, shutter, t - .035, d + .018, 7, 0xd5ccbb);
  metroPanel(solid, face, l, r, shutter - .035, shutter + .017, d + .027, 0, 0x827d70);
  const left = l + w * .09, right = l + w * .63, bottom = b + h * .19, bench = b + h * .40;
  const front = d + recess * .55;
  metroPanel(solid, face, left, right, bottom, bench, front, 0, 0x92745b);
  metroPanel(solid, face, left, right, bench - .045, bench + .029, front + .007, 0, 0xbda387);
  metroQuad(solid, face, [[left,bench,front],[right,bench,front],[right,bench,d+.027],[left,bench,d+.027]],
    0, 0xc4a983);
  const u = l + w * .37, y = bench + h * .123, radius = Math.min(.25, h * .118, w * .13);
  metroPanel(solid, face, left, right, bench, b + h * .662, d + .024, 0, 0x9b947e);
  const rim = (n, rad) => [u + Math.cos(n * Math.PI / 4) * rad,
    y + Math.sin(n * Math.PI / 4) * rad, d + recess * .27];
  for (let n = 0; n < 8; n++)
    metroQuad(solid, face, [rim(n,radius), rim(n+1,radius), rim(n+1,radius*.57), rim(n,radius*.57)],
      0, n < 4 ? 0x45504b : 0x333c39);
}

function metroEntryFittings(solid, face, bay, variant, boulevard) {
  const { l, r, b, t, d, w } = bay, front = face.out - .008;
  solid.feature = ENTRY;
  // Stone remains in the reveal, not on the pavement, even for narrow doors.
  const sill = b + .084;
  metroPanel(solid, face, l, r, b, sill, front, 0, 0x9d8b73);
  metroQuad(solid, face, [[l,sill,front],[r,sill,front],[r,sill,d+.025],[l,sill,d+.025]], 0, 0xd3c0a3);
  const h = b + (t - b) * .46;
  const handle = r - w * .18;
  metroPanel(solid, face, handle - .022, handle + .022, h, h + (boulevard ? .205 : .13),
    d + .028, 0, variant % 2 ? 0xd3ba84 : 0xa9aea3);
}

function metroMarketAwning(solid, face, bay, y, color, grand = false) {
  solid.feature = MARKET_AWNING;
  const { l, r } = bay;
  const edge = face.hull - .018, front = y - Math.min(.195, (edge - face.out) * .46);
  const lower = front - .16;
  const stripeTint = grand ? 0xb5a282 : 0xe7d0a6;
  for (let i = 0; i < 7; i++) {
    const a = l + (r - l) * i / 7, b = l + (r - l) * (i + 1) / 7;
    const cloth = i % 2 ? stripeTint : color;
    metroQuad(solid, face, [[a,front,edge],[b,front,edge],[b,y,face.out],[a,y,face.out]], 0, cloth);
    metroPanel(solid, face, a, b, lower, front, edge, 0, cloth);
  }
  metroQuad(solid, face, [[l,y,face.out],[r,y,face.out],[r,front,edge],[l,front,edge]], 0, grand ? 0x594f40 : 0x8e7c62);
  metroPanel(solid, face, l, r, lower - .028, lower, edge, 0, color);
  for (const u of [l + .12, r - .12])
    metroQuad(solid, face, [[u-.027,y-.29,face.out],[u+.027,y-.29,face.out],
      [u+.027,front-.025,edge],[u-.027,front-.025,edge]], 0, grand ? 0x332d25 : 0x594e40);
}

function metroMarketCounter(solid, face, bay, stall) {
  solid.feature = stall.feature;
  const width = Math.min(2.94, bay.w * .79), left = bay.u - width / 2, right = bay.u + width / 2;
  const front = face.hull - .095, back = face.out - .15, depth = front - back;
  const mid = (front + back) / 2, top = bay.b + (bay.t - bay.b) * .39;
  solid.faceBox(face, bay.u, (top + .16) / 2, mid - .028, width - .05, top - .16, depth - .055, 0, stall.paint);
  solid.faceBox(face, bay.u, top, mid, width, .095, depth, 0, 0xb39268);
  metroPanel(solid, face, left + .11, right - .11, .26, .32, front - .054, 0, 0x645a48);
  for (const u of [left + width / 3, right - width / 3])
    metroPanel(solid, face, u - .027, u + .027, .33, top - .052, front - .05, 0, 0x3e4940);

  if (stall.feature === MARKET_TEA) {
    const radius = Math.min(.21, depth * .38), z = mid - .032, u = left + width * .30;
    const cylinder = (x, y, d, r, h, tint, sides = 8) =>
      solid.cylinder(x * face.c + d * face.s, y, -x * face.s + d * face.c, r, h, tint, sides);
    cylinder(u, top + .048, z, radius * .76, .115, 0x604c3e);
    cylinder(u, top + .163, z, radius, .43, 0xb67c4d);
    cylinder(u, top + .593, z, radius * .84, .065, 0xe1b57b);
    solid.faceBox(face, u, top + .305, z + radius, .069, .057, .14, 0, 0xe0b584);
    solid.faceBox(face, right - width * .29, top + .070, mid + .038, width * .35, .038, depth * .61, 0, 0xadb2a5);
    for (const offset of [.66, .78])
      cylinder(left + width * offset, top + .09, mid + .06, .048, .11, 0xc98d52, 6);
  } else {
    const step = (width - .12) / 3, floor = top + .049;
    const colors = stall.feature === MARKET_FLATBREAD
      ? [0xe8c288, 0xd8a96a, 0xf0cd91] : [0xc46845, 0x91a663, 0xdd9a40];
    for (const [i, color] of colors.entries()) {
      const u = left + .06 + (i + .5) * step, l = u - step * .46, r = u + step * .46;
      if (stall.feature === MARKET_FLATBREAD) {
        metroBreadStack(solid, face, u, floor + .087, mid, Math.min(.27, step * .39), depth * .31, color);
      } else {
        const low = floor + .105, high = floor + .235, far = back + .06, lip = front - .046;
        const point = ([u, y, d]) => solid.point(u * face.c + d * face.s, y, -u * face.s + d * face.c);
        const peak = point([u, high + .036, mid]);
        const ring = [[l,low,lip],[r,low,lip],[r-step*.12,high,far],[l+step*.12,high,far]].map(point);
        for (let n = 0; n < ring.length; n++)
          solid.batch.triangle([ring[n], ring[(n + 1) % ring.length], peak], color, 0, solid.index,
            solid.feature, [[0,0],[0,0],[0,0]]);
      }
      metroPanel(solid, face, l, r, floor, floor + .112, front - .034, 0, 0xccac79);
    }
  }
}

function metroGround(atlas, solid, face, top, shopfront, main, boulevard, seed, counts, trim, market, finish, grand = false) {
  const bays = metroGroundBays(face, top, shopfront, main, boulevard, grand);
  const palette = grand ? GRAND_COLORS : COLORS;
  const stallTable = grand ? GRAND_MARKET_STALLS : MARKET_STALLS;
  const plates = grand ? GRAND_SHOP_PLATES : SHOP_PLATES;
  metroWall(atlas, solid, face, 0.16, top, finish?.tile ?? (boulevard ? 15 : 14),
    finish?.plaster ?? (grand ? 0xc2b8a6 : 0xf1e8d7), bays, finish, grand);
  let marketBay = false;
  for (const [n, bay] of bays.entries()) {
    const { u, w } = bay, tenant = (seed + n * 3) % SHOP_NAMES.length;
    const recess = face.out - bay.d;
    const showcase = main && bay.shop && w >= 1.65 && bay.t - bay.b >= 1.5 && recess >= .24;
    const stall = market && !marketBay && showcase && face.hull - face.out >= .38 && stallTable[tenant];
    if (showcase && tenant === 3) metroRepairBay(atlas, solid, face, bay);
    else {
      metroGlazing(atlas, solid, face, bay, seed + n, bay.shop && tenant === 3 && !boulevard, grand);
      if (!stall && showcase && (tenant === 0 || tenant === 2)) metroMerchantDisplay(solid, face, bay, tenant);
    }
    if (!bay.shop) {
      if (!boulevard) metroPanel(atlas, face, bay.l + w * 0.12, bay.l + w * 0.48,
        bay.b + 0.1, bay.t - 0.1, bay.d + 0.024, 4, grand ? 0x968e7c : 0xc9beab);
      if (main && recess >= .06 && bay.t - bay.b >= .5)
        metroEntryFittings(solid, face, bay, seed + n, boulevard);
      continue;
    }
    if (finish && tenant !== 3 && !stall && w >= 1.15 && bay.t - bay.b >= 1.2) {
      atlas.feature = solid.feature = KICKPLATE;
      const shoulder = Math.min(bay.t - .6, bay.b + (tenant === 1 ? .57 : .43));
      metroPanel(atlas, face, bay.l + .07, bay.r - .07, bay.b + .055, shoulder,
        bay.d + .021, ...plates[tenant]);
      metroPanel(solid, face, bay.l + .048, bay.r - .048, shoulder, shoulder + .057,
        bay.d + .03, 0, grand ? (tenant === 1 ? 0x6b7068 : 0x3b4039) : (tenant === 1 ? 0x9ca297 : 0x5d6457));
    }
    solid.feature = atlas.feature = 3;
    counts.shops++;
    const signY = top * 0.80, signH = top * 0.18;
    metroPanel(solid, face, bay.l, bay.r, signY - signH / 2, signY + signH / 2,
      face.out + 0.012, 0, grand ? 0x262b27 : 0x4b5143);
    metroPanel(atlas, face, bay.l + w * 0.022, bay.r - w * 0.022, signY - signH * 0.45,
      signY + signH * 0.45, face.out + 0.026, 9 + tenant, 0xffffff);
    if (stall) {
      metroMarketAwning(solid, face, bay, signY - signH * .53, stall.canvas, grand);
      metroMarketCounter(solid, face, bay, stall);
      marketBay = true;
      counts.marketStalls++;
      counts.awnings++;
    } else if (boulevard && !grand) {
      solid.faceBox(face, u, bay.t + 0.06, (face.out + face.hull) / 2,
        w, 0.12, face.hull - face.out, 0, trim);
    } else {
      const l = bay.l - w * 0.035, r = bay.r + w * 0.035;
      const back = signY - signH * 0.52, front = back - top * 0.072;
      const edge = grand ? face.hull + 0.28 : face.hull - 0.012;
      const canvas = [[l,front,edge],[r,front,edge],[r,back,face.out],[l,back,face.out]];
      const awningTint = grand ? GRAND_AWNING_TINTS[(tenant + n) % GRAND_AWNING_TINTS.length] : (tenant % 2 ? 0xc9b49f : 0xe5d9bb);
      const awningTile = grand && (tenant + n) % 2 === 0 ? 8 : (grand ? 0 : 8);
      metroQuad(atlas, face, canvas, awningTile, awningTint);
      metroQuad(solid, face, [...canvas].reverse(), 0, grand ? 0x453e33 : 0x6f6452);
      metroPanel(atlas, face, l, r, front - 0.115, front, edge, awningTile, grand ? awningTint : 0xbeb9a3);
      if (grand) {
        // Rolled shutter box header & iron awning struts on Grand Cairo storefronts
        solid.faceBox(face, u, bay.t - 0.05, bay.d + 0.08, w - 0.06, 0.14, 0.16, 0, 0x3b403c);
        for (const side of [-1, 1]) {
          const sx = u + side * (w * 0.44);
          metroQuad(solid, face, [[sx-0.022,bay.t-0.18,face.out],[sx+0.022,bay.t-0.18,face.out],
            [sx+0.022,front-0.02,edge-0.04],[sx-0.022,front-0.02,edge-0.04]], 0, palette.iron);
        }
      }
      counts.awnings++;
    }
  }
}

function metroBalcony(solid, face, u, floor, width, open, seed, trim, counts, planter, grand = false) {
  const palette = grand ? GRAND_COLORS : COLORS;
  solid.feature = 2;
  const extension = face.hull - face.out, center = face.out + extension * 0.5;
  const l = u - width / 2, r = u + width / 2, rail = face.hull - 0.029;
  solid.faceBox(face, u, floor + 0.10, center, width, 0.17, extension, 0, trim);
  for (const side of [-1, 1])
    solid.faceBox(face, u + side * (width / 2 - 0.042), floor + 0.46, center,
      0.084, 0.56, extension * 0.95, 0, trim);
  if (open) {
    metroPanel(solid, face, l, r, floor + 0.24, floor + 0.29, rail, 0, palette.iron);
    for (let n = 1; n <= 5; n++) {
      const x = l + width * n / 6;
      metroPanel(solid, face, x - 0.022, x + 0.022, floor + 0.26, floor + 0.99, rail, 0, palette.iron);
    }
    solid.faceBox(face, u, floor + 0.97, rail, width, 0.055, 0.055, 0, palette.iron);
  } else {
    solid.faceBox(face, u, floor + 0.47, rail, width, 0.57, 0.056, 0, trim);
    solid.faceBox(face, u, floor + 0.78, rail - 0.015, width, 0.066, 0.075, 0, palette.limestone);
  }
  if (open && seed % 3 !== 2) {
    const a = u - width * 0.32, m = a + width * 0.15, b = a + width * 0.32;
    const near = rail + 0.022, fold = near - 0.018;
    const clothA = grand ? (seed % 3 ? 0x8f806a : 0x825142) : (seed % 3 ? 0xb8a78c : 0xad715d);
    const clothB = grand ? (seed % 3 ? 0x9c8d75 : 0x915f4d) : (seed % 3 ? 0xc7b99b : 0xbf846b);
    metroQuad(solid, face, [[a,floor+0.52,near],[m,floor+0.50,fold],[m,floor+0.985,fold],
      [a,floor+0.984,near]], 0, clothA);
    metroQuad(solid, face, [[m,floor+0.50,fold],[b,floor+0.55,near],[b,floor+0.981,near],
      [m,floor+0.985,fold]], 0, clothB);
    counts.laundry++;
  }
  if (open && planter && width >= .90 && extension >= .24) {
    const x = u + width * .31, d = rail - .12;
    solid.feature = PLANTER;
    solid.faceBox(face, x, floor + .34, d, .30, .21, .16, 0, grand ? 0x7d5740 : 0xa27356);
    metroQuad(solid, face, [[x-.10,floor+.44,d],[x+.08,floor+.44,d],
      [x+.028,floor+.67,d+.02],[x-.055,floor+.62,d-.023]], 0, grand ? 0x566344 : 0x77865f);
    metroQuad(solid, face, [[x-.08,floor+.44,d+.042],[x+.052,floor+.44,d+.048],
      [x+.124,floor+.59,d+.015],[x+.077,floor+.62,d-.013]], 0, grand ? 0x6b704b : 0x919767);
  }
  counts.balconies++;
}

function metroUpperBays(face, floor, pitch, frontage, primary, boulevard, ribbon, seed, row, grand = false) {
  const bays = [];
  const maxCols = grand && face.width > 28
    ? (frontage ? (boulevard ? 6 : 5) : 4)
    : (frontage ? (boulevard ? 5 : 4) : (grand ? 3 : 2));
  const columns = Math.max(1, Math.min(maxCols,
    Math.round(face.width / (frontage ? (grand ? 4.2 : 3.8) : (grand ? 5.2 : 5.9)))));
  const step = face.width / columns;
  for (let n = 0; n < columns; n++) {
    const balcony = grand
      ? (!ribbon && (frontage
          ? ((row + n + seed) % 3 === (primary ? 0 : 1))
          : (face.width >= 13 && n === Math.floor(columns / 2) && (row + seed) % 5 === 0)))
      : (!boulevard && frontage && (row + n + seed) % 3 === (primary ? 0 : 1));
    const u = (n - (columns - 1) / 2) * step;
    const w = Math.min(step * (ribbon ? 0.80 : boulevard ? 0.65 : 0.55),
      ribbon ? 3.2 : boulevard ? (grand ? (balcony ? 2.15 : 2.38) : 2.42) : balcony ? 1.62 : 1.32);
    const b = floor + pitch * (balcony ? 0.09 : ribbon ? 0.39 : 0.32);
    const t = floor + pitch * (ribbon ? 0.80 : 0.84);
    const recess = Math.min(face.out * 0.38, boulevard ? 0.32 : 0.24);
    bays.push({ l: u - w / 2, r: u + w / 2, b, t, d: face.out + (frontage ? -recess : 0.008),
      u, w, balcony, feature: 1 });
  }
  return { bays, step, columns };
}

function metroUpper(atlas, solid, face, floor, pitch, frontage, primary, boulevard, ribbon, seed, row, finish, counts, grand = false) {
  const [tile, tint, trim] = finish;
  const { bays, step, columns } = metroUpperBays(face, floor, pitch, frontage, primary, boulevard, ribbon, seed, row, grand);
  const wallTile = !boulevard && seed % 4 === 0 && row >= 2 ? 5 : (grand && boulevard && seed % 5 === 1 && row % 3 === 1 ? 3 : tile);
  // Keep full recessed reveals on primary/shop frontages across all floors in Grand Cairo v5!
  const recessedWall = grand ? (frontage && (primary || row < 8)) : frontage;
  metroWall(atlas, solid, face, floor, floor + pitch, wallTile, tint, recessedWall ? bays : [], null, grand);
  if (grand && row > 0 && (frontage ? row % 2 === 0 : row % 4 === 0)) {
    // Crisp Cairo concrete floor-slab stringcourse ledge around all exposed tower faces
    solid.feature = 0;
    if (frontage) solid.faceBox(face, 0, floor + 0.05, face.out + 0.06, face.width + 0.08, 0.10, 0.12, 0, trim);
    else metroPanel(solid, face, -face.width / 2, face.width / 2, floor, floor + 0.11, face.out + 0.025, 0, trim);
  }
  for (const [n, bay] of bays.entries()) {
    const bayGeom = recessedWall ? bay : { ...bay, d: face.out + 0.014 };
    if (grand && (frontage || (seed + row + n) % 2 === 0) && (seed + row * 3 + n) % 3 !== 0) {
      // Detailed atlas casement window with curtains/mullions or warm evening interior glow
      atlas.feature = bay.feature;
      const lit = (seed + row * 5 + n * 2) % 4 === 0;
      metroPanel(atlas, face, bayGeom.l, bayGeom.r, bayGeom.b, bayGeom.t, bayGeom.d + 0.012,
        6, lit ? 0xe3b878 : 0xa8a296);
    } else {
      metroGlazing(atlas, solid, face, bayGeom, seed + row + n, false, grand);
    }
    if (bay.balcony) {
      const balWidth = Math.min(step * 0.88, boulevard ? 3.15 : 2.75);
      metroBalcony(solid, face, bay.u, floor, balWidth,
        (seed + row + n) % (grand ? 3 : 4) !== 1, seed + row + n, trim, counts,
        primary && (grand ? row <= 2 : row === 0), grand);
    } else if ((frontage || grand) && !ribbon) {
      if (frontage) {
        solid.faceBox(face, bay.u, bay.b - 0.035, face.out + 0.036, bay.w + step * 0.085,
          0.07, 0.105, 0, trim);
      } else {
        metroPanel(solid, face, bay.l - 0.06, bay.r + 0.06, bay.b - 0.07, bay.b, face.out + 0.024, 0, trim);
      }
      if ((grand || !boulevard) && (seed + row + n) % (grand ? (frontage ? 3 : 4) : 4) === 1) {
        const w = bay.w * 0.26;
        const shutterTint = grand
          ? [0x968e78, 0x5a6b58, 0x7d674e][(seed + row + n) % 3]
          : [0xd8d2b7, 0x8ea389, 0xb89c78][(seed + row + n) % 3];
        metroPanel(atlas, face, bay.l - w, bay.l, bay.b, bay.t, face.out + 0.020, 4, shutterTint);
        if (grand && frontage && step - bay.w > w * 2.2) {
          metroPanel(atlas, face, bay.r, bay.r + w, bay.b, bay.t, face.out + 0.020, 4, shutterTint);
        }
      }
    }
    if (boulevard && !ribbon && frontage && n < columns - 1) {
      const x = bay.u + step / 2;
      solid.feature = 0;
      solid.faceBox(face, x, floor + pitch / 2, face.out + (face.hull - face.out) * 0.29,
        Math.min(step * 0.17, 0.44), pitch, (face.hull - face.out) * 0.58, 0, trim);
    }
    counts.windows++;
  }
  if (ribbon && frontage) {
    solid.feature = 0;
    const projection = (face.hull - face.out) * 0.84;
    solid.faceBox(face, 0, floor + pitch * 0.33, face.out + projection / 2,
      face.width, 0.17, projection, 0, trim);
  }
}

function metroSitePlan(site, index, roads, grand = false) {
  const seed = hash(site.id), style = seed % 4, boulevard = site.architecture === "boulevard";
  const ribbon = !grand && boulevard && style % 2 === 1;
  const finish = (boulevard
    ? (grand ? GRAND_METRO_STONE : METRO_STONE)
    : (grand ? GRAND_METRO_PLASTER : METRO_PLASTER))[style];
  const inset = Math.min(boulevard ? 0.46 : 0.54, Math.min(site.width, site.length) * 0.15);
  const width = site.width - 2 * inset, length = site.length - 2 * inset;
  const faces = [0, 1, 2, 3].map((n) => {
    const angle = n * Math.PI / 2, out = (n % 2 ? width : length) / 2;
    return { angle, c: Math.cos(angle), s: Math.sin(angle), width: n % 2 ? length : width, out, hull: out + inset };
  });
  const streets = metroStreetFaces(site, faces, roads, boulevard);
  const tall = grand && site.height > 34;
  const crown = Math.min(tall ? (boulevard ? 2.1 : 1.85) : (boulevard ? 1.28 : 1.48), site.height * 0.16);
  const roof = site.height - crown;
  const ground = Math.min(tall ? (boulevard ? 4.65 : 3.75) : (boulevard ? 4.13 : 3.33), roof * 0.44);
  const rawFloors = Math.max(1, Math.round((roof - ground) / (boulevard ? 3.18 : 2.82)));
  const floors = grand ? Math.min(16, rawFloors) : rawFloors;
  const pitch = (roof - ground) / floors;
  const info = { id: site.id, index, style, architecture: boulevard ? "boulevard" : "neighborhood",
    facingRoadId: streets.roadId, upperFloors: floors, roofY: roof + GROUND,
    primaryFace: streets.primary, shopFaces: [...streets.shops], width: site.width, length: site.length };
  return { seed, style, boulevard, ribbon, finish, inset, width, length, faces, streets,
    crown, roof, ground, floors, pitch, grand, info };
}

function buildMetroSite(site, index, atlasBatch, solidBatch, roads, counts,
  plan = metroSitePlan(site, index, roads), market = false, elevationAt = null) {
  const { seed, style, boulevard, ribbon, finish, inset, width, length, faces, streets,
    crown, roof, ground, floors, pitch, grand, info } = plan;
  const [tile, tint, trim] = finish;
  const siteElev = grand && elevationAt ? elevationAt(site.x, site.z) : 0;
  const baseY = GROUND + siteElev;
  const atlas = new Writer(atlasBatch, site, index, 0, baseY);
  const solid = new Writer(solidBatch, site, index, 0, baseY);
  const groundFinish = market ? (grand ? GRAND_GROUND_FINISHES : GROUND_FINISHES)[style] : null;
  const palette = grand ? GRAND_COLORS : COLORS;
  if (grand && elevationAt) {
    // Deep foundation plinth skirt anchors buildings solidly into sloped hills/ramps
    solid.box(0, -0.72, 0, site.width, 1.76, site.length, 0, palette.mortar, 0, [5]);
  } else {
    solid.box(0, 0.08, 0, site.width, 0.16, site.length, 0, grand ? palette.mortar : trim, 0, [5]);
  }
  for (const [f, face] of faces.entries()) {
    const main = f === streets.primary, frontage = streets.shops.has(f);
    metroGround(atlas, solid, face, ground, frontage, main, boulevard, seed + f * 7, counts, trim, market, groundFinish, grand);
    for (let row = 0; row < floors; row++)
      metroUpper(atlas, solid, face, ground + row * pitch, pitch, frontage, main,
        boulevard, ribbon, seed + f * 7, row, finish, counts, grand);
    if (grand && frontage && face.width > 5) {
      // Staggered split-AC outdoor condenser boxes across residential floors (both avenue & neighborhood)
      solid.feature = atlas.feature = 5;
      const acStep = Math.max(2, Math.floor(floors / 3));
      for (let acRow = 0; acRow < floors; acRow += acStep) {
        const sideSign = ((acRow + f + seed) % 2 === 0) ? 1 : -1;
        const u = sideSign * face.width * (0.28 + ((acRow + seed) % 3) * 0.06);
        const y = ground + acRow * pitch + pitch * 0.24;
        const acDepth = Math.max(0.28, inset * 0.68);
        const out = face.out + acDepth * 0.5;
        solid.faceBox(face, u, y, out, 0.68, 0.44, acDepth, 0, palette.limestone);
        atlas.faceQuad(face, u, y, face.out + acDepth + 0.008, 0.60, 0.36, 7);
        for (const br of [-1, 1])
          solid.faceBox(face, u + br * 0.23, y - 0.25, out, 0.048, 0.08, acDepth * 0.96, 0, palette.iron);
        counts.airConditioners++;
      }
    } else if (main && face.width > 4 && !boulevard) {
      const u = face.width * 0.37, y = ground + pitch * 0.21, out = face.out + inset * 0.36;
      solid.feature = atlas.feature = 5;
      solid.faceBox(face, u, y, out, 0.62, 0.40, inset * 0.72, 0, palette.limestone);
      atlas.faceQuad(face, u, y, face.out + inset * 0.72 + 0.006, 0.52, 0.31, 7);
      for (const side of [-1, 1])
        solid.faceBox(face, u + side * 0.21, y - 0.24, out, 0.049, 0.09, inset * 0.75, 0, palette.iron);
      counts.airConditioners++;
    }
  }
  solid.feature = 0;
  const cornice = boulevard ? 0.23 : 0.16;
  solid.box(0, ground - cornice / 2, 0, site.width, cornice, site.length, 0, trim, 0, [5]);
  solid.feature = atlas.feature = 4;
  solid.box(0, roof, 0, site.width, Math.min(0.22, crown * 0.3), site.length, 0, trim);
  const rim = Math.min(0.18, inset * 0.60), deck = roof + Math.min(0.11, crown * 0.15);
  for (const [f, face] of faces.entries()) {
    const y = f === streets.primary && boulevard ? site.height : roof + crown * (style % 2 ? 0.54 : 0.68);
    atlas.faceBox(face, 0, (deck + y) / 2, face.hull - rim / 2,
      face.width + 2 * inset - (f % 2 ? 2 * rim : 0), y - deck, rim, tile, tint);
  }
  const stair = crown - (deck - roof);
  atlas.box(width * 0.19, deck + stair / 2, -length * 0.15,
    width * (boulevard ? 0.30 : 0.24), stair, length * 0.28, tile, tint, 0, [5]);
  if ((grand || crown >= 1.43) && width > 3 && length > 3)
    roofEquipment(solid, atlas, width, length, deck, seed, counts, grand);
  return info;
}

function buildMetroProxy(site, plan, batch, elevationAt = null) {
  const { seed, boulevard, ribbon, finish, width, length, faces, streets,
    crown, roof, ground, floors, pitch, grand } = plan;
  const [tile, tint, trim] = finish;
  const siteElev = grand && elevationAt ? elevationAt(site.x, site.z) : 0;
  const w = new Writer(batch, site, plan.info.index, 0, GROUND + siteElev);
  w.box(0, roof / 2, 0, width, roof, length, tile, tint, 0, [5]);
  if (grand && elevationAt) w.box(0, -0.72, 0, site.width, 1.76, site.length, 0, GRAND_COLORS.mortar, 0, [4, 5]);
  else w.box(0, 0.08, 0, site.width, 0.16, site.length, 0, grand ? GRAND_COLORS.mortar : trim, 0, grand ? [4, 5] : [5]);
  w.box(0, ground - 0.095, 0, site.width, 0.19, site.length, 0, trim, 0, grand ? [4, 5] : [5]);
  w.box(0, roof, 0, site.width, 0.20, site.length, 0, trim, 0, [5]);
  w.box(width * .19, roof + crown * .5, -length * .15,
    width * (boulevard ? .30 : .24), crown, length * .28, tile, tint, 0, [5]);
  if (grand && seed % 3 !== 0 && width > 4 && length > 4) {
    // Distant Cairo rooftop water tank silhouette
    w.box(-width * .23, roof + .65, -length * .22, 1.05, 1.15, 1.05, 0, GRAND_COLORS.tank, 0, [5]);
  }
  for (const [f, face] of faces.entries()) {
    const main = f === streets.primary, frontage = streets.shops.has(f), s = seed + f * 7;
    const parapet = boulevard && main ? crown : crown * .55;
    metroPanel(w, face, -face.width / 2, face.width / 2,
      roof, roof + parapet, face.hull - .08, tile, tint);
    if (!grand || frontage) {
      for (const [n, bay] of metroGroundBays(face, ground, frontage, main, boulevard, grand).entries()) {
        const vitrineTint = grand
          ? (bay.shop ? ((s + n) % 4 === 0 ? 0x876a45 : ((s + n) % 2 ? 0xd9ad6b : 0xc49555)) : 0x2a3130)
          : 0x576a61;
        metroPanel(w, face, bay.l, bay.r, bay.b, bay.t, face.out + .016, grand && !bay.shop ? 6 : 0, vitrineTint);
        if (bay.shop) {
          metroPanel(w, face, bay.l, bay.r, ground * .72, ground * .88, face.out + .018,
            9 + (s + n * 3) % SHOP_NAMES.length, 0xffffff);
          if (grand) {
            const awningTint = GRAND_AWNING_TINTS[(s + n) % GRAND_AWNING_TINTS.length];
            metroQuad(w, face, [[bay.l,ground*.63,face.out+.36],[bay.r,ground*.63,face.out+.36],
              [bay.r,ground*.71,face.out+.02],[bay.l,ground*.71,face.out+.02]], 8, awningTint);
          }
        }
      }
    }
    for (let row = 0; row < floors; row++) {
      if (grand && !frontage) {
        if (row % 2 === 0 && face.width > 6) {
          metroPanel(w, face, -0.55, 0.55, ground + row * pitch + pitch * 0.30,
            ground + row * pitch + pitch * 0.80, face.out + .019, 6, (s + row) % 4 === 0 ? 0xd8aa68 : 0x9c968a);
        }
        continue;
      }
      if (grand && main && row > 0 && row % 4 === 0) {
        metroPanel(w, face, -face.width / 2, face.width / 2,
          ground + row * pitch, ground + row * pitch + .10, face.out + .04, 0, trim);
      }
      const { bays } = metroUpperBays(face, ground + row * pitch, pitch, frontage, main, boulevard, ribbon, s, row, grand);
      for (const [n, bay] of bays.entries()) {
        metroPanel(w, face, bay.l, bay.r, bay.b, bay.t, face.out + .019, grand ? 6 : 0,
          grand ? ((s + row + n) % 4 === 0 ? 0xe0b575 : 0xa39d91) : ((s + row + n) % 4 === 1 ? 0x889087 : 0x596c66));
        if (bay.balcony) {
          if (grand) {
            metroPanel(w, face, bay.l - .14, bay.r + .14, bay.b, bay.b + .56, face.hull - .04, 0, trim);
          } else {
            metroPanel(w, face, bay.l, bay.r, bay.b, bay.b + .52, face.hull - .075, 0, trim);
          }
        }
      }
    }
  }
}

function roadBounds(road) {
  return roadRect(road);
}
const intersects = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;

function roadPoly(road, margin = 0) {
  if (road.axis === "diag") {
    const { ux, uz } = diagRoadFrame(road);
    const h = Math.max(0, road.width / 2 - margin);
    const sx = road.x1 - ux * h, sz = road.z1 - uz * h;
    const ex = road.x2 + ux * h, ez = road.z2 + uz * h;
    const lx = uz * h, lz = -ux * h;
    return [
      { x: sx - lx, z: sz - lz },
      { x: sx + lx, z: sz + lz },
      { x: ex + lx, z: ez + lz },
      { x: ex - lx, z: ez - lz },
    ];
  }
  const { minX, maxX, minZ, maxZ } = roadRect(road, margin);
  return [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ];
}

function sitePoly(site) {
  const c = Math.cos(site.heading ?? 0), s = Math.sin(site.heading ?? 0);
  const hw = site.width / 2, hl = site.length / 2;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => ({
    x: site.x + c * hw * sx + s * hl * sz,
    z: site.z - s * hw * sx + c * hl * sz,
  }));
}

function polyAlongStreet(poly, road) {
  if (road.axis === "diag") {
    const { ux, uz } = diagRoadFrame(road);
    return poly.map((p) => {
      const dx = p.x - road.x1, dz = p.z - road.z1;
      return { u: dx * uz - dz * ux, a: dx * ux + dz * uz };
    });
  }
  const f = road.fixed;
  return road.axis === "z"
    ? poly.map((p) => ({ u: p.x - f, a: p.z }))
    : poly.map((p) => ({ u: f - p.z, a: p.x }));
}

function clipStripU(pts, limit, keepGreater) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i], nxt = pts[(i + 1) % pts.length];
    const curIn = keepGreater ? cur.u >= limit : cur.u <= limit;
    const nxtIn = keepGreater ? nxt.u >= limit : nxt.u <= limit;
    if (curIn) out.push(cur);
    if (curIn !== nxtIn) {
      const t = (limit - cur.u) / (nxt.u - cur.u);
      out.push({ u: limit, a: cur.a + (nxt.a - cur.a) * t });
    }
  }
  return out;
}

function polySpanInBand(pts, uMin, uMax) {
  let minU = Infinity, maxU = -Infinity, minA = Infinity, maxA = -Infinity;
  for (const p of pts) {
    if (p.u < minU) minU = p.u;
    if (p.u > maxU) maxU = p.u;
    if (p.a < minA) minA = p.a;
    if (p.a > maxA) maxA = p.a;
  }
  if (!(minU < uMax && maxU > uMin)) return null;
  if (minU >= uMin && maxU <= uMax) return { a0: minA, a1: maxA };
  let clipped = clipStripU(pts, uMin, true);
  if (!clipped.length) return null;
  clipped = clipStripU(clipped, uMax, false);
  if (!clipped.length) return null;
  let a0 = Infinity, a1 = -Infinity;
  for (const p of clipped) {
    if (p.a < a0) a0 = p.a;
    if (p.a > a1) a1 = p.a;
  }
  return { a0, a1 };
}

function openPolyStreetSpans(roadMin, roadMax, left, right, polyBlockers, margin) {
  const lo = Math.min(left, right) - margin, hi = Math.max(left, right) + margin;
  const cuts = [];
  for (const pts of polyBlockers) {
    const span = polySpanInBand(pts, lo, hi);
    if (span) cuts.push(span);
  }
  cuts.sort((a, b) => a.a0 - b.a0);
  const start = roadMin + .85, end = roadMax - .85, runs = [];
  let at = start;
  for (const { a0, a1 } of cuts) {
    const stop = Math.min(end, a0 - margin);
    if (stop > at + .45) runs.push([at, stop]);
    at = Math.max(at, a1 + margin);
    if (at >= end) return runs;
  }
  if (end > at + .45) runs.push([at, end]);
  return runs;
}

function buildStreetSurfaces(roads, patches, curbs, counts, metro = false) {
  const hasDiag = roads.some(r => r.axis === "diag");
  const bounds = hasDiag ? null : roads.map(roadBounds);
  const polys = hasDiag ? roads.map(r => roadPoly(r, 0)) : null;
  for (let index = 0; index < roads.length; index++) {
    const road = roads[index];
    if (road.parkingBay) continue;
    const isDiag = road.axis === "diag";
    const diag = isDiag ? diagRoadFrame(road) : null;
    const roadMin = isDiag ? 0 : road.min, roadMax = isDiag ? diag.length : road.max;
    const seedKey = isDiag
      ? `diag:${road.x1}:${road.z1}:${road.x2}:${road.z2}`
      : `${road.axis}:${road.fixed}:${road.min}:${road.max}`;
    const rng = random(hash(seedKey));
    const site = isDiag
      ? { x: road.x1, z: road.z1, heading: diag.heading }
      : road.axis === "z"
        ? { x: road.fixed, z: 0, heading: 0 }
        : { x: 0, z: road.fixed, heading: Math.PI / 2 };
    const patch = new Writer(patches, site, -1, 6), curb = new Writer(curbs, site, -1, 7);
    const otherPolys = hasDiag ? polys.filter((_, n) => n !== index).map(p => polyAlongStreet(p, road)) : null;
    const blockedBox = (u, along, halfWidth, halfLength) => {
      if (hasDiag) {
        const span = otherPolys.some(pts => {
          const hit = polySpanInBand(pts, u - halfWidth, u + halfWidth);
          return hit && hit.a0 < along + halfLength && hit.a1 > along - halfLength;
        });
        return span;
      }
      const rect = road.axis === "z"
        ? { minX: road.fixed + u - halfWidth, maxX: road.fixed + u + halfWidth, minZ: along - halfLength, maxZ: along + halfLength }
        : { minX: along - halfLength, maxX: along + halfLength, minZ: road.fixed - u - halfWidth, maxZ: road.fixed - u + halfWidth };
      return bounds.some((other, n) => n !== index && intersects(rect, other));
    };
    for (let along = roadMin + 12 + rng() * 6; along < roadMax - 6; along += 31) {
      const u = (rng() > 0.5 ? 1 : -1) * road.width * 0.23;
      const halfWidth = 0.56 + rng() * 0.38, halfLength = 1.1 + rng() * 0.8;
      if (blockedBox(u, along, halfWidth + 0.3, halfLength + 0.6)) continue;
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
    if (metro && road.zone === "avenue") {
      for (const side of [-1, 1]) {
        const toe = side * (road.width / 2 + 0.035), cap = toe + side * 0.088, back = cap + side * 0.23;
        const strip = (a, b, yA, yB, from, to, tint) => {
          const points = [[a,yA,from],[a,yA,to],[b,yB,to],[b,yB,from]];
          curb.quad(side > 0 ? points : points.reverse(), 0, tint);
        };
        let start = null;
        const flush = (end) => {
          if (start === null) return;
          strip(toe, cap, -0.003, 0.055, start, end, 0x9c9281);
          strip(cap, back, 0.055, 0.055, start, end, 0xc5b99f);
          start = null;
          counts.curbSegments++;
        };
        for (let a = roadMin + 1; a < roadMax - 1; a += 2.8) {
          const end = Math.min(a + 2.8, roadMax - 1);
          if (blockedBox((toe + back) / 2, (a + end) / 2, 0.21, (end - a) / 2 + 0.08)) flush(a);
          else start ??= a;
        }
        flush(roadMax - 1);
      }
      continue;
    }
    for (const side of [-1, 1])
      for (let n = 0, along = roadMin + 2; along < roadMax - 3; n++, along += 1.42) {
        const u = side * (road.width / 2 + 0.23), length = Math.min(1.38, roadMax - 2 - along);
        if (blockedBox(u, along + length / 2, 0.19, length / 2 + 0.16)) continue;
        curb.quad([[u-0.14,-0.040,along],[u-0.14,-0.040,along+length],
          [u+0.14,-0.040,along+length],[u+0.14,-0.040,along]], 0, n % 2 ? 0xbcb8a4 : 0x55574e);
        counts.curbSegments++;
      }
  }
}

function alongStreet(rect, road) {
  const { minX, maxX, minZ, maxZ } = rect, f = road.fixed;
  return road.axis === "z"
    ? { u0: minX - f, u1: maxX - f, a0: minZ, a1: maxZ }
    : { u0: f - maxZ, u1: f - minZ, a0: minX, a1: maxX };
}

function openStreetSpans(road, left, right, blockers, margin) {
  const lo = Math.min(left, right), hi = Math.max(left, right);
  const cuts = blockers.filter(b => b.u0 < hi + margin && b.u1 > lo - margin).sort((a, b) => a.a0 - b.a0);
  const start = road.min + .85, end = road.max - .85, runs = [];
  let at = start;
  for (const { a0, a1 } of cuts) {
    const stop = Math.min(end, a0 - margin);
    if (stop > at + .45) runs.push([at, stop]);
    at = Math.max(at, a1 + margin);
    if (at >= end) return runs;
  }
  if (end > at + .45) runs.push([at, end]);
  return runs;
}

function buildV4StreetSurfaces(roads, sites, repairs, edging, counts, elevationAt = null, grand = false) {
  const hasDiag = roads.some(road => road.axis === "diag");
  const asphalt = hasDiag ? null : roads.map(road => roadRect(road));
  const footway = hasDiag ? null : roads.map(road => roadRect(road, -2.5));
  const walls = hasDiag ? null : sites.map(site => {
    const c = Math.abs(Math.cos(site.heading ?? 0)), s = Math.abs(Math.sin(site.heading ?? 0));
    const x = (site.width * c + site.length * s) / 2, z = (site.width * s + site.length * c) / 2;
    return { minX: site.x - x, maxX: site.x + x, minZ: site.z - z, maxZ: site.z + z };
  });
  const asphaltPolys = hasDiag ? roads.map(road => roadPoly(road, 0)) : null;
  const footwayPolys = hasDiag ? roads.map(road => roadPoly(road, -2.5)) : null;
  const wallPolys = hasDiag ? sites.map(sitePoly) : null;
  for (const [index, road] of roads.entries()) {
    if (road.parkingBay) continue;
    const isDiag = road.axis === "diag";
    const diag = isDiag ? diagRoadFrame(road) : null;
    const roadMin = isDiag ? 0 : road.min, roadMax = isDiag ? diag.length : road.max;
    const avenue = road.zone === "avenue", edge = road.width / 2;
    const local = isDiag
      ? { x: road.x1, z: road.z1, heading: diag.heading }
      : road.axis === "z" ? { x: road.fixed, z: 0 } : { x: 0, z: road.fixed, heading: Math.PI / 2 };
    const asphaltCuts = hasDiag
      ? asphaltPolys.filter((_, n) => n !== index).map(poly => polyAlongStreet(poly, road))
      : asphalt.filter((_, n) => n !== index).map(rect => alongStreet(rect, road));
    const wingCuts = hasDiag
      ? [...footwayPolys.filter((_, n) => n !== index), ...wallPolys].map(poly => polyAlongStreet(poly, road))
      : [...footway.filter((_, n) => n !== index), ...walls].map(rect => alongStreet(rect, road));
    const spans = (left, right, cuts, margin) => hasDiag
      ? openPolyStreetSpans(roadMin, roadMax, left, right, cuts, margin)
      : openStreetSpans(road, left, right, cuts, margin);
    const patch = new Writer(repairs, local, -1, 6, GROUND, elevationAt);
    const curb = new Writer(edging, local, -1, 7, GROUND, elevationAt);
    const rng = random(hash(road.id ?? (isDiag ? `${road.x1}:${road.z1}:${road.x2}:${road.z2}` : `${road.axis}:${road.fixed}`)));
    const spanHasSlope = (uMid, a, b) => {
      if (!elevationAt || b - a <= 7.5) return false;
      const samples = 4;
      let minE = Infinity, maxE = -Infinity;
      for (let k = 0; k <= samples; k++) {
        const sPos = a + (b - a) * (k / samples);
        const wx = local.x + uMid * curb.cos + sPos * curb.sin;
        const wz = local.z - uMid * curb.sin + sPos * curb.cos;
        const e = elevationAt(wx, wz);
        if (e < minE) minE = e;
        if (e > maxE) maxE = e;
      }
      return maxE - minE > 0.015 || maxE > 0.02;
    };
    const emitQuad = (w, u0, u1, z0, z1, y0, y1, color) => {
      const points = [[u0,y0,z0],[u0,y0,z1],[u1,y1,z1],[u1,y1,z0]];
      w.quad(u1 > u0 ? points : points.reverse(), 0, color);
    };
    const strip = (w, u0, u1, a, b, y0, y1, color, slopedStep = 7.0) => {
      const stepLen = spanHasSlope((u0 + u1) * 0.5, a, b) ? slopedStep : Infinity;
      for (let pos = a; pos < b - 1e-4; pos += stepLen) {
        const next = Math.min(b, pos + stepLen);
        emitQuad(w, u0, u1, pos, next, y0, y1, color);
      }
    };
    const flush = (w, u0, u1, a, b, y, color) => strip(w, u0, u1, a, b, y, y, color);
    // Overlay within millimetres of the existing road, sidewalk and ground, respectively.
    const roadY = .1165 - GROUND, pathY = .0715 - GROUND, courtY = -.0485 - GROUND;
    if (!grand) {
      for (const side of [-1, 1]) {
        const e = edge * side, at = (out) => e + side * out;
        const drains = avenue ? .56 : .33;
        for (const [a, b] of spans(at(-drains), at(.43), asphaltCuts, .18)) {
          curb.feature = GUTTER;
          flush(curb, at(-drains), at(-.11), a, b, roadY, avenue ? 0x414442 : 0x46443e);
          flush(curb, at(-.11), e, a, b, roadY, 0x333735);
          curb.feature = 7;
          const cap = avenue ? .055 : -.040;
          strip(curb, e, at(.105), a, b, roadY, cap, 0x817e70);
          flush(curb, at(.105), at(.27), a, b, cap, avenue ? 0x9b9587 : 0x918777);
          strip(curb, at(.27), at(.37), a, b, cap, pathY, 0x90897b);
          counts.curbSegments++;
          if (avenue && b - a > 9) {
            // One inlet at the end of a block; a long block also has one by its start.
            for (const d of b - a > 45 ? [a + 11.6, b - 3.65] : [b - 3.65]) {
              patch.feature = DRAIN;
              flush(patch, at(-.52), at(-.05), d - .40, d + .40, roadY + .0013, 0x6a6960);
              flush(patch, at(-.46), at(-.095), d - .33, d + .33, roadY + .0021, 0x282e2e);
              for (let slat = -2; slat <= 2; slat++)
                flush(patch, at(-.46), at(-.095), d + slat * .112 - .016,
                  d + slat * .112 + .016, roadY + .003, 0x6d716a);
              counts.drains++;
            }
          }
        }
        // Separate construction phases: a narrow continuous service apron and
        // wider scored slabs where the frontage isn't occupied by a building.
        curb.feature = FORECOURT;
        const courtBands = avenue ? [[2.505, 3.375, 4.15], [3.415, 5.25, 4.15]] : [[2.505, 3.60, 3.55]];
        for (const [inner, outer, pitch] of courtBands) {
          const palette = COURT_PAVING[Number(inner > 3.4)];
          for (const [a, b] of spans(at(inner), at(outer), wingCuts, .02)) {
            flush(curb, at(inner), at(outer), a, b, courtY - .0008, 0x646660);
            const basis = roadMin + (inner > 3.4 ? .8 : 0);
            for (let n = Math.floor((a - basis) / pitch); basis + n * pitch < b; n++) {
              const start = Math.max(a, basis + n * pitch + .023);
              const end = Math.min(b, basis + (n + 1) * pitch - .023);
              if (end - start < .18) continue;
              flush(curb, at(inner), at(outer), start, end, courtY, palette[Math.floor(rng() * palette.length)]);
              counts.forecourtSlabs++;
            }
          }
        }
      }
      patch.feature = 6;
      // Narrow utility reinstatements, with a seal around the newer mix. They
      // sit away from the paint and never run into a junction apron.
      const side = rng() < .5 ? -1 : 1;
      const u = edge * (avenue ? .59 : .34) * side;
      const half = avenue ? .68 : .43;
      for (const [a, b] of spans(u - half, u + half, asphaltCuts, 2.8)) {
        const length = b - a;
        if (length < 11) continue;
        const from = a + length * (.14 + rng() * .30);
        const to = Math.min(b - 1.2, from + (avenue ? 6.4 : 3.3) + rng() * 3.8);
        const cut = (border, y, tint) => {
          const l = u - half + border, r = u + half - border;
          const lo = from + border, hi = to - border;
          const points = [[l+.11,lo],[l,lo+.24],[l,hi-.11],[l+.10,hi],[r-.16,hi],
            [r,hi-.26],[r,lo+.16],[r-.12,lo]];
          for (let n = 1; n < points.length - 1; n++)
            repairs.triangle([points[0], points[n], points[n + 1]].map(([x,z]) => patch.point(x, y, z)),
              tint, 0, -1, 6, [[0,0],[0,0],[0,0]]);
        };
        cut(0, roadY, 0x303535);
        cut(.07, roadY + .001, avenue ? 0x424749 : 0x555449);
        counts.patches++;
      }
      continue;
    }

    // Grand Metro City v5: realistic dark bitumen gutters, 3D segmented Egyptian curb stones
    // (بلدورة الرصيف المصرية), cast-iron storm-drain grates, dark tar-sealed road patches, and muted forecourts.
    const aveDarkTop = [0x24282b, 0x2b2f33];
    const aveDarkFace = [0x1e2225, 0x24282b];
    const aveLightTop = [0xa59d8c, 0xc2baaa, 0x968e7d];
    const aveLightFace = [0x8e8677, 0xa8a091, 0x827b6c];
    const nbStoneTop = [0x7d776b, 0x34383b, 0x878073, 0x6e695e];
    const nbStoneFace = [0x6b665b, 0x2a2e31, 0x746e62, 0x5d594f];
    for (const side of [-1, 1]) {
      const e = edge * side, at = (out) => e + side * out;
      const drains = avenue ? .58 : .35;
      for (const [a, b] of spans(at(-drains), at(.43), asphaltCuts, .18)) {
        curb.feature = GUTTER;
        flush(curb, at(-drains), at(-.12), a, b, roadY, 0x1b1e21);
        flush(curb, at(-.12), e, a, b, roadY + .0004, 0x282a27);

        curb.feature = 7;
        const cap = avenue ? .058 : -.036;
        // Continuous recessed dark mortar joint bed (0x1a1d1f) + rear concrete step to sidewalk
        strip(curb, at(.003), at(.106), a, b, roadY, cap - .0045, 0x1a1d1f, 2.7);
        strip(curb, at(.106), at(.276), a, b, cap - .0045, cap - .0045, 0x1a1d1f, 2.7);
        strip(curb, at(.276), at(.37), a, b, cap - .001, pathY, avenue ? 0x59554c : 0x524e46, 2.7);

        const blockLen = avenue ? 1.35 : 1.50;
        const halfJoint = 0.02;
        const salt = Math.floor(rng() * 4);
        for (let blockIdx = 0, pos = a; pos < b - 0.08; blockIdx++, pos += blockLen) {
          const next = Math.min(b, pos + blockLen);
          const s0 = pos === a ? pos : pos + halfJoint;
          const s1 = next >= b - 1e-4 ? next : next - halfJoint;
          if (s1 - s0 < 0.06) continue;
          let topColor, faceColor;
          if (avenue) {
            if ((blockIdx + salt) % 2 === 0) {
              const k = ((blockIdx >> 1) + salt) % aveDarkTop.length;
              topColor = aveDarkTop[k];
              faceColor = aveDarkFace[k];
            } else if (b - a > 6 && (pos - a < 2.7 || b - next < 2.7)) {
              topColor = 0x967a44;
              faceColor = 0x7d6537;
            } else {
              const k = ((blockIdx >> 1) + salt) % aveLightTop.length;
              topColor = aveLightTop[k];
              faceColor = aveLightFace[k];
            }
          } else {
            const k = (blockIdx + salt) % nbStoneTop.length;
            topColor = nbStoneTop[k];
            faceColor = nbStoneFace[k];
          }
          emitQuad(curb, e, at(.105), s0, s1, roadY, cap, faceColor);
          emitQuad(curb, at(.105), at(.276), s0, s1, cap, cap, topColor);
          counts.curbBlocks = (counts.curbBlocks ?? 0) + 1;
        }
        counts.curbSegments++;

        if ((avenue && b - a > 9) || (!avenue && b - a > 12)) {
          const drainLocations = avenue
            ? (b - a > 45 ? [a + 11.6, b - 3.65] : [b - 3.65])
            : (b - a > 52 ? [a + 10.4, b - 3.4] : [b - 3.4]);
          const apronOut = avenue ? -.52 : -.34, apronIn = -.045;
          const pitOut = avenue ? -.46 : -.30, pitIn = -.085;
          for (const d of drainLocations) {
            patch.feature = DRAIN;
            flush(patch, at(apronOut), at(apronIn), d - .40, d + .40, roadY + .0013, 0x3d4042);
            flush(patch, at(pitOut), at(pitIn), d - .33, d + .33, roadY + .0021, 0x121517);
            for (let slat = -2; slat <= 2; slat++)
              flush(patch, at(pitOut), at(pitIn), d + slat * .112 - .018,
                d + slat * .112 + .018, roadY + .003, 0x383d40);
            counts.drains++;
          }
        }
      }

      curb.feature = FORECOURT;
      const courtBands = avenue ? [[2.505, 3.375, 5.10], [3.415, 5.25, 5.10]] : [[2.505, 3.60, 4.35]];
      for (const [inner, outer, pitch] of courtBands) {
        const palette = GRAND_COURT_PAVING[Number(inner > 3.4)];
        for (const [a, b] of spans(at(inner), at(outer), wingCuts, .02)) {
          flush(curb, at(inner), at(outer), a, b, courtY - .0008, 0x383a37);
          const basis = roadMin + (inner > 3.4 ? .8 : 0);
          for (let n = Math.floor((a - basis) / pitch); basis + n * pitch < b; n++) {
            const start = Math.max(a, basis + n * pitch + .026);
            const end = Math.min(b, basis + (n + 1) * pitch - .026);
            if (end - start < .18) continue;
            flush(curb, at(inner), at(outer), start, end, courtY, palette[Math.floor(rng() * palette.length)]);
            counts.forecourtSlabs++;
          }
        }
      }
    }

    patch.feature = 6;
    const side = rng() < .5 ? -1 : 1;
    const u = edge * (avenue ? .59 : .34) * side;
    const half = avenue ? .68 : .43;
    for (const [a, b] of spans(u - half, u + half, asphaltCuts, 2.8)) {
      const length = b - a;
      if (length < 11) continue;
      const from = a + length * (.14 + rng() * .30);
      const to = Math.min(b - 1.2, from + (avenue ? 6.4 : 3.3) + rng() * 3.8);
      const cut = (border, y, tint) => {
        const l = u - half + border, r = u + half - border;
        const lo = from + border, hi = to - border;
        const points = [[l+.11,lo],[l,lo+.24],[l,hi-.11],[l+.10,hi],[r-.16,hi],
          [r,hi-.26],[r,lo+.16],[r-.12,lo]];
        for (let n = 1; n < points.length - 1; n++)
          repairs.triangle([points[0], points[n], points[n + 1]].map(([x,z]) => patch.point(x, y, z)),
            tint, 0, -1, 6, [[0,0],[0,0],[0,0]]);
      };
      cut(0, roadY + .0006, 0x16191c);
      cut(.075, roadY + .0014, avenue ? 0x23272b : 0x272a2c);

      // Extra narrow diagonal hot-poured tar-crack seal strip per repaired block
      const sealStart = to + 3.6 < b ? to + 1.0 : (from - 3.6 > a ? a + 1.0 : null);
      if (sealStart !== null) {
        const sealMid = sealStart + 1.15 + rng() * 0.55;
        const sealEnd = Math.min(b - 1.0, sealMid + 1.15 + rng() * 0.65);
        const u0 = -u * (0.32 + rng() * 0.28);
        const u1 = u0 + side * (avenue ? 0.55 : 0.34);
        const u2 = u1 - side * (avenue ? 0.22 : 0.14);
        const hw = 0.036;
        for (const [za, zb, ua, ub] of [[sealStart, sealMid, u0, u1], [sealMid, sealEnd, u1, u2]]) {
          patch.quad([
            [ua - hw, roadY + .0012, za],
            [ub - hw, roadY + .0012, zb],
            [ub + hw, roadY + .0012, zb],
            [ua + hw, roadY + .0012, za],
          ], 0, 0x16191c);
        }
      }
      counts.patches++;
    }
  }
}

function includeFootprint(cell, site) {
  const c = Math.abs(Math.cos(site.heading ?? 0)), s = Math.abs(Math.sin(site.heading ?? 0));
  const x = (site.width * c + site.length * s) / 2, z = (site.width * s + site.length * c) / 2;
  cell.minX = Math.min(cell.minX, site.x - x);
  cell.maxX = Math.max(cell.maxX, site.x + x);
  cell.minZ = Math.min(cell.minZ, site.z - z);
  cell.maxZ = Math.max(cell.maxZ, site.z + z);
}

function cellDistance2(cell, point) {
  const x = Math.max(cell.minX - point.x, 0, point.x - cell.maxX);
  const z = Math.max(cell.minZ - point.z, 0, point.z - cell.maxZ);
  return x * x + z * z;
}

function streamMetroSites(sites, roads, mapped, flat, diagnostics, attach, detach, market, grand = false, elevationAt = null) {
  const cells = new Map(), residents = new Set();
  const cellSpan = grand ? GRAND_STREAM_CELL : STREAM_CELL;
  const detailRadius = grand ? GRAND_DETAIL_RADIUS : DETAIL_RADIUS;
  const prewarmRadius = grand ? GRAND_PREWARM_RADIUS : PREWARM_RADIUS;
  const releaseRadius = grand ? GRAND_RELEASE_RADIUS : RELEASE_RADIUS;
  for (const [index, site] of sites.entries()) {
    const key = `${Math.floor(site.x / cellSpan)}:${Math.floor(site.z / cellSpan)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { key, sites: [], minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      cells.set(key, cell);
    }
    const plan = metroSitePlan(site, index, roads, grand);
    if (grand && elevationAt) {
      plan.info.roofY = plan.roof + GROUND + elevationAt(site.x, site.z);
    }
    cell.sites.push({ site, index, plan });
    diagnostics.sites.push(plan.info);
    includeFootprint(cell, site);
  }
  for (const cell of cells.values()) {
    const batch = new Batch(`egypt-${cell.key}-skyline`, mapped);
    for (const { site, plan } of cell.sites) buildMetroProxy(site, plan, batch, elevationAt);
    cell.proxy = attach(batch.mesh());
  }
  diagnostics.totalCells = cells.size;
  const featureKeys = Object.keys(diagnostics.counts).filter(key =>
    !["patches", "curbSegments", "curbBlocks", "forecourtSlabs", "drains"].includes(key));
  function ensurePrewarmJob(cell) {
    if (!cell.prewarmJob) {
      cell.prewarmJob = {
        atlas: new Batch(`egypt-${cell.key}-facades`, mapped),
        solid: new Batch(`egypt-${cell.key}-structure`, flat, true),
        counts: Object.fromEntries(featureKeys.map(key => [key, 0])),
        nextIdx: 0,
        builtMeshes: null,
      };
    }
    return cell.prewarmJob;
  }
  function advancePrewarmJob(cell, maxSites) {
    const job = ensurePrewarmJob(cell);
    if (job.builtMeshes) return true;
    if (job.nextIdx < cell.sites.length) {
      const stopIdx = Math.min(cell.sites.length, job.nextIdx + maxSites);
      while (job.nextIdx < stopIdx) {
        const { site, index, plan } = cell.sites[job.nextIdx++];
        buildMetroSite(site, index, job.atlas, job.solid, roads, job.counts, plan, market, elevationAt);
      }
      if (maxSites < Infinity) return false;
    }
    job.builtMeshes = [job.atlas.mesh(), job.solid.mesh()].filter(Boolean);
    return true;
  }
  function enter(cell) {
    advancePrewarmJob(cell, Infinity);
    const { builtMeshes, counts } = cell.prewarmJob;
    cell.prewarmJob = null;
    cell.details = builtMeshes.map(attach);
    cell.counts = counts;
    for (const key of featureKeys) diagnostics.counts[key] += counts[key];
    cell.proxy.removeFromParent();
    diagnostics.drawCalls--;
    diagnostics.triangles -= cell.proxy.geometry.attributes.position.count / 3;
    for (const mesh of cell.details) diagnostics.residentTriangles += mesh.geometry.attributes.position.count / 3;
    residents.add(cell);
    diagnostics.residentSites += cell.sites.length;
    diagnostics.cellsBuilt++;
  }
  function leave(cell) {
    // Keep the low-cost coverage buffer so returning doesn't rebuild or re-upload it.
    cell.prewarmJob = null;
    cell.parent.add(cell.proxy);
    diagnostics.drawCalls++;
    diagnostics.triangles += cell.proxy.geometry.attributes.position.count / 3;
    for (const mesh of cell.details) {
      diagnostics.residentTriangles -= mesh.geometry.attributes.position.count / 3;
      detach(mesh);
    }
    for (const key of featureKeys) diagnostics.counts[key] -= cell.counts[key];
    cell.details = cell.counts = null;
    residents.delete(cell);
    diagnostics.residentSites -= cell.sites.length;
    diagnostics.cellsEvicted++;
  }
  for (const cell of cells.values()) cell.parent = cell.proxy.parent;
  return {
    update(anchors, lead) {
      if (diagnostics.disposed) return;
      let nextEnter = null, nextEnterDist = prewarmRadius ** 2;
      let nextPrebuild = null, nextPrebuildDist = prewarmRadius ** 2;
      let enteredSync = false;
      for (const cell of cells.values()) {
        let distance = Infinity;
        for (const point of anchors) distance = Math.min(distance, cellDistance2(cell, point));
        const ahead = lead ? Math.min(distance, cellDistance2(cell, lead)) : distance;
        if (cell.details) {
          if (ahead > releaseRadius ** 2) leave(cell);
        } else if (distance <= detailRadius ** 2) {
          enter(cell);
          enteredSync = true;
        } else {
          if (ahead < nextEnterDist) {
            nextEnter = cell;
            nextEnterDist = ahead;
          }
          if (!cell.prewarmJob?.builtMeshes && ahead < nextPrebuildDist) {
            nextPrebuild = cell;
            nextPrebuildDist = ahead;
          }
        }
      }
      // Always slice CPU geometry pre-building in the outer 68..136 m ring (zero scene triangles/drawCalls!)
      // so cells crossing detailRadius are already 100% built and swap in O(1) without synchronous hitches.
      const withinSpeculativeBudget = !grand || (diagnostics.drawCalls < diagnostics.budget.maxDrawCalls
        && diagnostics.triangles < diagnostics.budget.maxTriangles * 0.84);
      if (!enteredSync) {
        if (nextEnter && withinSpeculativeBudget) {
          if (!grand || advancePrewarmJob(nextEnter, 3)) enter(nextEnter);
        } else if (grand && nextPrebuild) {
          advancePrewarmJob(nextPrebuild, 3);
        }
      }
      diagnostics.residentCells = residents.size;
      diagnostics.budget.withinBudget = diagnostics.drawCalls <= diagnostics.budget.maxDrawCalls
        && diagnostics.triangles <= diagnostics.budget.maxTriangles;
    },
    clear() {
      cells.clear();
      residents.clear();
      diagnostics.residentCells = diagnostics.residentSites = diagnostics.residentTriangles = 0;
    },
  };
}

/**
 * Owns the visuals of registered buildings and surface details, not collision bodies.
 * Streaming keeps the full site registry but feature counts describe resident
 * detail (plus the permanent curb and repair layer). Eager use supports the
 * existing architecture fixtures and non-metro views.
 */
export function createEgyptStreetLayer(world, { streamDetails } = {}) {
  const root = new THREE.Group();
  root.name = "egypt-street-layer";
  root.userData.egyptStreetLayer = true;
  const grandCity = (world.config?.cityVersion ?? 0) >= 5;
  const metro = world.environment === "metro";
  const effectiveStream = streamDetails ?? (metro && grandCity);
  const streaming = metro && effectiveStream;
  const market = (streaming || (metro && grandCity)) && usesCityV4StreetFinish(world);
  const active = metro || world.environment === "city" || world.environment === "vision" || world.environment === "egypt";
  const diagnostics = {
    active, siteIds: [], sites: [], featureNames: [...FEATURES], drawCalls: 0, triangles: 0,
    counts: { windows: 0, balconies: 0, shops: 0, tanks: 0, dishes: 0, airConditioners: 0, patches: 0, curbSegments: 0 },
    textAtlasAvailable: false, shopNames: [...SHOP_NAMES], disposed: false,
    resources: { geometries: 0, materials: 0, textures: 0, liveGeometries: 0, liveMaterials: 0, liveTextures: 0 },
    budget: { maxDrawCalls: 45, maxTriangles: 100000, withinBudget: true },
  };
  if (metro) Object.assign(diagnostics, { totalCells: 0, residentCells: 0, residentSites: 0,
    residentTriangles: 0, cellsBuilt: 0, cellsEvicted: 0 });
  const geometries = new Set(), materials = new Set(), textures = new Set();
  let residency;
  const dispose = () => {
    if (diagnostics.disposed) return;
    residency?.clear();
    if (metro) diagnostics.residentCells = diagnostics.residentSites = diagnostics.residentTriangles = 0;
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
  const roadKey = (r) => r.axis === "diag"
    ? `diag:${r.x1}:${r.z1}:${r.x2}:${r.z2}:${r.width}:${r.id ?? ""}`
    : `${r.axis}:${r.fixed}:${r.min}:${r.max}:${r.width}`;
  const roads = (world.roads ?? []).slice().sort((a, b) => roadKey(a).localeCompare(roadKey(b), "en"));
  diagnostics.siteIds = sites.map((site) => site.id);
  if (metro) {
    diagnostics.featureNames.push(...METRO_CLOSE_FEATURES);
    Object.assign(diagnostics.budget, grandCity ? METRO_V5_BUDGET : METRO_BUDGET);
    Object.assign(diagnostics.counts, { awnings: 0, laundry: 0 });
  } else if (grandCity) {
    Object.assign(diagnostics.budget, METRO_V5_BUDGET);
  }
  if (market) {
    diagnostics.featureNames.push(...MARKET_FEATURES, ...STREET_FINISH_FEATURES);
    Object.assign(diagnostics.counts, { marketStalls: 0, forecourtSlabs: 0, drains: 0 });
    if (grandCity) diagnostics.counts.curbBlocks = 0;
  }
  if (!sites.length && !roads.length) return { root, diagnostics, dispose };
  const elevationAt = grandCity && typeof world.terrainElevationAt === "function" ? world.terrainElevationAt : null;
  const texture = sites.length ? (grandCity ? makeGrandCairoAtlas() : makeAtlas()) : null;
  if (texture) textures.add(texture);
  diagnostics.textAtlasAvailable = !!texture;
  const flat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
  flat.name = "egypt-matte-masonry-and-hardware";
  materials.add(flat);
  const mapped = sites.length ? new THREE.MeshStandardMaterial({
    map: texture, vertexColors: true, roughness: 0.98, metalness: 0,
  }) : null;
  if (mapped) { mapped.name = "egypt-authored-facade-atlas"; materials.add(mapped); }
  const attach = (mesh) => {
    root.add(mesh); geometries.add(mesh.geometry);
    // Streamed meshes are baked in world coordinates, not moved with the camera.
    if (streaming) mesh.matrixAutoUpdate = mesh.matrixWorldAutoUpdate = false;
    diagnostics.drawCalls++; diagnostics.triangles += mesh.geometry.attributes.position.count / 3;
    diagnostics.resources.geometries++;
    diagnostics.resources.liveGeometries++;
    return mesh;
  };
  const detach = (mesh) => {
    mesh.removeFromParent();
    geometries.delete(mesh.geometry);
    mesh.geometry.dispose();
    diagnostics.drawCalls--; diagnostics.triangles -= mesh.geometry.attributes.position.count / 3;
    diagnostics.resources.liveGeometries--;
  };
  const batches = [];
  const districts = new Map();
  const metroCell = grandCity ? GRAND_METRO_CELL : METRO_CELL;
  if (streaming) residency = streamMetroSites(sites, roads, mapped, flat, diagnostics, attach, detach, market, grandCity, elevationAt);
  else sites.forEach((site, index) => {
    const key = metro ? `${Math.floor(site.x / metroCell)}:${Math.floor(site.z / metroCell)}`
      : `${site.x < 0 ? "west" : "east"}-${site.z < 0 ? "south" : "north"}`;
    if (!districts.has(key)) {
      // Only the metro wall and awning shells submit a shadow pass; small hardware still receives it.
      const pair = [new Batch(`egypt-${key}-facades`, mapped), new Batch(`egypt-${key}-structure`, flat, metro)];
      districts.set(key, pair); batches.push(...pair);
    }
    const plan = metro ? metroSitePlan(site, index, roads, grandCity) : null;
    if (plan && grandCity && elevationAt) {
      plan.info.roofY = plan.roof + GROUND + elevationAt(site.x, site.z);
    }
    diagnostics.sites.push(metro
      ? buildMetroSite(site, index, ...districts.get(key), roads, diagnostics.counts,
          plan, market, elevationAt)
      : buildSite(site, index, ...districts.get(key), roads, diagnostics.counts));
  });
  if (metro && !streaming) {
    diagnostics.totalCells = diagnostics.residentCells = districts.size;
    diagnostics.residentSites = sites.length;
    diagnostics.cellsBuilt = districts.size;
  }
  if (roads.length) {
    const paint = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    paint.name = "egypt-flat-road-repairs-and-curb-paint";
    materials.add(paint);
    const patches = new Batch("egypt-asphalt-repairs", paint, true), curbs = new Batch("egypt-painted-curb", paint, true);
    if (market) buildV4StreetSurfaces(roads, sites, patches, curbs, diagnostics.counts, elevationAt, grandCity);
    else buildStreetSurfaces(roads, patches, curbs, diagnostics.counts, metro);
    batches.push(patches, curbs);
  }
  for (const batch of batches) {
    const mesh = batch.mesh();
    if (mesh) {
      attach(mesh);
      if (metro && !streaming && mesh.geometry.getAttribute("siteIndex").getX(0) >= 0)
        diagnostics.residentTriangles += mesh.geometry.attributes.position.count / 3;
    }
  }
  if (streamDetails === undefined && grandCity && residency) {
    const initialAnchor = world.player ?? world.playerStart ?? sites[0];
    if (initialAnchor) residency.update([initialAnchor]);
  }
  Object.assign(diagnostics.resources, {
    geometries: geometries.size, materials: materials.size, textures: textures.size,
    liveGeometries: geometries.size, liveMaterials: materials.size, liveTextures: textures.size,
  });
  const { maxDrawCalls, maxTriangles } = diagnostics.budget;
  diagnostics.budget.withinBudget = diagnostics.drawCalls <= maxDrawCalls && diagnostics.triangles <= maxTriangles;
  return { root, diagnostics, dispose, updateResidency: residency?.update };
}
