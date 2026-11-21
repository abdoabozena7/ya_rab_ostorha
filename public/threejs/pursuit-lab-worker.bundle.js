(() => {
  // config/pursuit-rl-development.json
  var pursuit_rl_development_default = {
    schema: 1,
    description: "Development only. Shared Metro geometry and pursuit World, including controlled L09/L10/L12 workloads; not the protected acceptance cases. Uses dispatch-scan-v3 pedestrian refinement, bounded displacement shaping, a shared forward exploration prior, the dispatch brake guard, and bootstrapped truncation.",
    trainingSeeds: ["dispatch-train-00", "dispatch-train-01", "dispatch-train-02", "dispatch-train-03"],
    validationSeeds: ["dispatch-dev-eval-00", "dispatch-dev-eval-01"],
    stages: [
      { id: "maneuver", traffic: 0, pedestrians: 0, episodeSeconds: 6, wantedLevel: 1, patrols: 0 },
      { id: "left-crossing", scenario: "L09", traffic: 0, pedestrians: 0, episodeSeconds: 8, wantedLevel: 1, patrols: 0 },
      { id: "right-crossing", scenario: "L10", traffic: 0, pedestrians: 0, episodeSeconds: 8, wantedLevel: 1, patrols: 0 },
      { id: "crossing-pursuit", scenario: "L12", traffic: 12, pedestrians: 28, episodeSeconds: 8, wantedLevel: 1, patrols: 1 },
      { id: "mixed-crossings", traffic: 12, pedestrians: 28, episodeSeconds: 12, wantedLevel: 1, patrols: 1 },
      { id: "city-pressure", traffic: 36, pedestrians: 80, episodeSeconds: 20, wantedLevel: 3, patrols: 5 }
    ]
  };

  // config/pursuit-rl-route-development.json
  var pursuit_rl_route_development_default = {
    schema: 1,
    description: "Development only. Civic junction turn/loss with one active patrol, followed by full-population Metro. No protected holdout seeds.",
    trainingSeeds: ["route-train-00", "route-train-01", "route-train-02", "route-train-03"],
    validationSeeds: ["route-dev-eval-00", "route-dev-eval-01"],
    stages: [
      { id: "junction-escape", scenarios: ["tail-civic-eastbound", "tail-civic-westbound"], observation: "dispatch-route-v1", traffic: 0, pedestrians: 0, episodeSeconds: 42, wantedLevel: 1, wantedLevelMax: 1, patrols: 1 },
      { id: "city-escape", observation: "dispatch-route-v1", traffic: 36, pedestrians: 80, episodeSeconds: 60, wantedLevel: 3, patrols: 7 }
    ]
  };

  // config/pursuit-rl-city-route-development.json
  var pursuit_rl_city_route_development_default = {
    schema: 1,
    description: "Development only. Full-population Metro with a public route that continues past zone boundaries. No protected holdout seeds.",
    trainingSeeds: ["route-train-00", "city-route-train-01", "city-route-train-02"],
    validationSeeds: ["city-route-dev-eval-00", "city-route-dev-eval-01"],
    stages: [
      { id: "city-clearance", observation: "dispatch-route-v2", traffic: 36, pedestrians: 80, episodeSeconds: 65, wantedLevel: 3, wantedLevelMax: 3, patrols: 7, demonstrationSpeedMps: 12 },
      { id: "city-clearance-dense", observation: "dispatch-route-v2", traffic: 96, pedestrians: 144, episodeSeconds: 65, wantedLevel: 5, wantedLevelMax: 5, patrols: 12 }
    ]
  };

  // src/core/random.js
  var Random = class {
    constructor(seed = 1) {
      this.state = 2166136261;
      for (const char of String(seed))
        this.state = Math.imul(this.state ^ char.charCodeAt(0), 16777619) >>> 0;
    }
    next() {
      let t = this.state = this.state + 1831565813 | 0;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    range(a, b) {
      return a + (b - a) * this.next();
    }
    pick(items) {
      return items[Math.floor(this.next() * items.length)];
    }
  };

  // src/core/config.js
  var STEP = 1 / 60;
  var VERSION = "2.0.0";
  var PEOPLE_MODELS = Object.freeze([
    "man-polo",
    "woman-shirt",
    "man-jacket",
    "woman-jacket"
  ]);
  var DEFAULTS = Object.freeze({
    seed: "cairo-42",
    traffic: 28,
    pedestrians: 32,
    chaos: 0.4,
    speedLimit: 35,
    difficulty: 2,
    scenarioInterval: 7
  });
  var VEHICLE = Object.freeze({
    length: 4.2,
    width: 1.85,
    wheelbase: 2.6,
    maxSteer: 0.62,
    steerRate: 0.9,
    acceleration: 2.4,
    braking: 7,
    reverseSpeed: 2.5
  });
  var clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  function districtOptions(input = {}) {
    const districtVersion = input.districtVersion ?? 1;
    const districtCase = input.districtCase ?? "ambient";
    if (districtVersion !== 1)
      throw new Error("Unsupported Egyptian district layout version");
    if (typeof districtCase !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(districtCase))
      throw new Error("District encounter must have a valid explicit identifier");
    return { districtVersion, districtCase };
  }
  function settings(input = {}, metroLimits = null) {
    const number2 = (key3, min, max, integer = false) => {
      const fallback = metroLimits && key3 === "traffic" ? 36 : metroLimits && key3 === "pedestrians" ? 48 : DEFAULTS[key3];
      const n = Number(input[key3] ?? fallback);
      const value = clamp(Number.isFinite(n) ? n : fallback, min, max);
      return integer ? Math.round(value) : value;
    };
    return {
      seed: String(input.seed ?? DEFAULTS.seed).slice(0, 64),
      traffic: number2("traffic", 0, metroLimits?.traffic ?? 72, true),
      pedestrians: number2("pedestrians", 0, metroLimits?.pedestrians ?? 96, true),
      chaos: number2("chaos", 0, 1),
      speedLimit: number2("speedLimit", 15, 50),
      difficulty: number2("difficulty", 1, 5, true),
      scenarioInterval: number2("scenarioInterval", 2, 20)
    };
  }

  // src/core/geometry.js
  var EPS = 1e-7;
  var CIRCULAR_CONTACT_TOLERANCE_M = 1e-7;
  var distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  var angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  function corner(x, z, s, c, w, l, sx, sz) {
    return { x: x + c * w * sx + s * l * sz, z: z + -s * w * sx + c * l * sz };
  }
  function corners(body, gap = 0) {
    const s = Math.sin(body.heading ?? 0), c = Math.cos(body.heading ?? 0);
    const l = (body.length ?? 0) / 2 + gap, w = (body.width ?? 0) / 2 + gap;
    const x = body.x, z = body.z;
    return [
      corner(x, z, s, c, w, l, -1, -1),
      corner(x, z, s, c, w, l, 1, -1),
      corner(x, z, s, c, w, l, 1, 1),
      corner(x, z, s, c, w, l, -1, 1)
    ];
  }
  function separates(pa, pb, heading2) {
    const x = Math.sin(heading2), z = Math.cos(heading2);
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (let i = 0; i < 4; i++) {
      const a = pa[i].x * x + pa[i].z * z;
      const b = pb[i].x * x + pb[i].z * z;
      minA = Math.min(minA, a);
      maxA = Math.max(maxA, a);
      minB = Math.min(minB, b);
      maxB = Math.max(maxB, b);
    }
    return maxA <= minB + EPS || maxB <= minA + EPS;
  }
  function overlaps(a, b, gap = 0) {
    const ac = a.type === "pedestrian", bc = b.type === "pedestrian";
    const dx = a.x - b.x, dz = a.z - b.z;
    const reach = (ac ? Math.abs(a.radius) : (Math.abs(a.length) + Math.abs(a.width)) / 2) + (bc ? Math.abs(b.radius) : (Math.abs(b.length) + Math.abs(b.width)) / 2) + Math.abs(gap);
    const bound = reach + EPS + reach * Number.EPSILON * 4;
    if (Math.abs(dx) > bound || Math.abs(dz) > bound) return false;
    const ra = ac ? a.radius : Math.hypot(a.length, a.width) / 2;
    const rb = bc ? b.radius : Math.hypot(b.length, b.width) / 2;
    const separation = Math.hypot(dx, dz);
    if (separation >= ra + rb + gap) return false;
    if (ac && bc) return separation < ra + rb + gap - CIRCULAR_CONTACT_TOLERANCE_M;
    if (ac || bc) {
      const circle = ac ? a : b, rect = ac ? b : a, h = rect.heading ?? 0;
      const dx2 = circle.x - rect.x, dz2 = circle.z - rect.z;
      const localX = dx2 * Math.cos(h) - dz2 * Math.sin(h), localZ = dx2 * Math.sin(h) + dz2 * Math.cos(h);
      const ex = Math.max(0, Math.abs(localX) - rect.width / 2), ez = Math.max(0, Math.abs(localZ) - rect.length / 2);
      return Math.hypot(ex, ez) < circle.radius + gap - CIRCULAR_CONTACT_TOLERANCE_M;
    }
    const pa = corners(a, gap / 2), pb = corners(b, gap / 2);
    const ah = a.heading ?? 0, bh = b.heading ?? 0;
    return !separates(pa, pb, ah + 0) && !separates(pa, pb, ah + Math.PI / 2) && !separates(pa, pb, bh + 0) && !separates(pa, pb, bh + Math.PI / 2);
  }
  function roadRect(road4, margin = 0) {
    const h = road4.width / 2 - margin;
    return road4.axis === "z" ? {
      minX: road4.fixed - h,
      maxX: road4.fixed + h,
      minZ: road4.min - h,
      maxZ: road4.max + h
    } : {
      minX: road4.min - h,
      maxX: road4.max + h,
      minZ: road4.fixed - h,
      maxZ: road4.fixed + h
    };
  }
  function pointOnRoad(p, roads, margin = 0) {
    const x = p.x, z = p.z;
    for (const road4 of roads) {
      const h = road4.width / 2 - margin;
      const along2 = road4.axis === "z" ? z : x;
      const lateral2 = road4.axis === "z" ? x : z;
      if (lateral2 >= road4.fixed - h && lateral2 <= road4.fixed + h && along2 >= road4.min - h && along2 <= road4.max + h) return true;
    }
    return false;
  }
  function area(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      a += p.x * q.z - q.x * p.z;
    }
    return Math.abs(a) / 2;
  }
  function split(poly, axis, value, sign) {
    const inside = [], outside = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = (a[axis] - value) * sign, db = (b[axis] - value) * sign;
      (da >= 0 ? inside : outside).push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db), p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
        inside.push(p);
        outside.push(p);
      }
    }
    return { inside, outside };
  }
  function bodyOnRoad(body, roads, margin = 0.08) {
    let uncovered = [corners(body)];
    const radius = Math.hypot(body.length, body.width) / 2;
    for (const road4 of roads) {
      const r = roadRect(road4, margin);
      if (body.x + radius < r.minX || body.x - radius > r.maxX || body.z + radius < r.minZ || body.z - radius > r.maxZ)
        continue;
      const remaining = [];
      for (let polygon of uncovered) {
        if (polygon.every((p) => p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ)) continue;
        for (const [axis, value, sign] of [
          ["x", r.minX, 1],
          ["x", r.maxX, -1],
          ["z", r.minZ, 1],
          ["z", r.maxZ, -1]
        ]) {
          if (polygon.length < 3) break;
          const parts = split(polygon, axis, value, sign);
          if (parts.outside.length >= 3 && area(parts.outside) > EPS)
            remaining.push(parts.outside);
          polygon = parts.inside;
        }
      }
      uncovered = remaining;
      if (!uncovered.length) return true;
    }
    return uncovered.reduce((sum, p) => sum + area(p), 0) < EPS;
  }
  function interpolate(a, b, t, pose5 = { ...b }) {
    pose5.x = a.x + (b.x - a.x) * t;
    pose5.z = a.z + (b.z - a.z) * t;
    pose5.heading = (a.heading ?? 0) + angleDelta(b.heading ?? 0, a.heading ?? 0) * t;
    return pose5;
  }
  function sweepSafe(before, after, others, roads = null) {
    const heading2 = before.heading ?? 0;
    const turn = angleDelta(after.heading ?? 0, heading2);
    const dx = after.x - before.x, dz = after.z - before.z;
    const travel2 = distance(before, after) + Math.abs(turn) * Math.hypot(before.length ?? 1, before.width ?? 1) / 2;
    const steps = Math.max(1, Math.ceil(travel2 / 0.12));
    const pose5 = {
      x: 0,
      z: 0,
      heading: 0,
      type: after.type,
      radius: after.radius,
      length: after.length,
      width: after.width
    };
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      pose5.x = before.x + dx * t;
      pose5.z = before.z + dz * t;
      pose5.heading = heading2 + turn * t;
      if (roads && !bodyOnRoad(pose5, roads))
        return { safe: false, reason: "road-boundary" };
      for (const other of others)
        if (overlaps(pose5, other, 0.12))
          return { safe: false, reason: "occupied", actor: other.id };
    }
    return { safe: true, reason: "clear" };
  }

  // src/core/pursuit-dispatch.js
  var DISPATCH_RULESET = "dispatch-v1";
  var noZones = Object.freeze([]);
  var zoneFields = ["id", "minX", "maxX", "minZ", "maxZ"];
  var DEFAULT_SURVEILLANCE_ZONES = Object.freeze([
    Object.freeze({ id: "civic", minX: -256, maxX: -156, minZ: -120, maxZ: 36 }),
    Object.freeze({ id: "gateway", minX: -174, maxX: -70, minZ: -118, maxZ: 18 }),
    Object.freeze({ id: "market", minX: -102, maxX: 25, minZ: -68, maxZ: 23 })
  ]);
  var LAST_KNOWN_TICKS = Math.round(1.25 / STEP);
  var SEARCH_TICKS = Math.round(6 / STEP);
  var ELIGIBLE_TICKS = Math.ceil(1 / STEP);
  var LOSS_GRACE_TICKS = Math.round(3 / STEP);
  var FADE_TICKS = Math.round(2.4 / STEP);
  function resolveSurveillanceZones(zones) {
    if (!Array.isArray(zones)) throw new TypeError("surveillanceZones must be an array");
    if (zones.length > 16) throw new RangeError("surveillanceZones allows at most 16 zones");
    const resolved = [], ids = /* @__PURE__ */ new Set();
    for (const zone of zones) {
      if (!zone || Object.getPrototypeOf(zone) !== Object.prototype || Reflect.ownKeys(zone).length !== zoneFields.length || !zoneFields.every((key3) => Object.hasOwn(zone, key3)))
        throw new TypeError("Each surveillance zone needs exactly id, minX, maxX, minZ, and maxZ");
      const { id, minX, maxX, minZ, maxZ } = zone;
      if (typeof id !== "string" || !id.trim() || id.length > 64 || ids.has(id))
        throw new TypeError("Each surveillance zone needs a unique non-blank string id of at most 64 characters");
      if (![minX, maxX, minZ, maxZ].every(Number.isFinite) || !(minX < maxX && minZ < maxZ))
        throw new RangeError("Surveillance zone bounds must be finite and strictly ordered");
      ids.add(id);
      resolved.push(Object.freeze({ id, minX, maxX, minZ, maxZ }));
    }
    return Object.freeze(resolved);
  }
  function createDispatchResponse() {
    return {
      state: "LOST",
      zoneIds: noZones,
      lastReportTick: null,
      lastSampleTick: null,
      mobileTrackTicks: 0,
      escapeEligible: false
    };
  }
  function isDispatchTracked(response) {
    const state = response?.dispatch?.state;
    return state === "ZONE_TRACKED" || state === "VISUALLY_SPOTTED";
  }
  var active = (unit2) => unit2.health > 0 && unit2.aiState !== "WRECKED";
  function mobileNearby(patrols, player) {
    for (const unit2 of patrols) {
      if (active(unit2) && unit2.aiState !== "ROADBLOCK" && unit2.previous && Math.abs(unit2.speed) >= 3 && distance(unit2, unit2.previous) >= 3 * STEP - 1e-8 && distance(unit2, player) <= 65) return true;
    }
    return false;
  }
  function updateDispatchTracking(world, initial) {
    const { player, pursuit, tick } = world, { response, gta } = pursuit;
    const d = response.dispatch, wasTracked = isDispatchTracked(response);
    const { x, z, heading: heading2, speed } = player;
    const zoneIds = [];
    for (const zone of gta.config.surveillanceZones)
      if (x >= zone.minX && x <= zone.maxX && z >= zone.minZ && z <= zone.maxZ)
        zoneIds.push(zone.id);
    d.zoneIds = zoneIds.length ? Object.freeze(zoneIds) : noZones;
    const tracked = zoneIds.length > 0 || response.unitsInContact > 0;
    if (!d.escapeEligible && (initial || d.lastSampleTick !== tick)) {
      const qualifyingStep = !initial && d.lastSampleTick === tick - 1 && tracked && mobileNearby(pursuit.patrols, player);
      d.mobileTrackTicks = qualifyingStep ? d.mobileTrackTicks + 1 : 0;
      d.escapeEligible = d.mobileTrackTicks >= ELIGIBLE_TICKS;
    }
    d.lastSampleTick = tick;
    if (tracked) {
      const sin = Math.sin(heading2), cos = Math.cos(heading2), slip = player.gtaSlipMps ?? 0;
      response.lastSeen = Object.freeze({
        x,
        z,
        heading: heading2,
        speed,
        tick,
        vx: sin * speed + cos * slip,
        vz: cos * speed - sin * slip
      });
      d.lastReportTick = tick;
      d.state = zoneIds.length ? "ZONE_TRACKED" : "VISUALLY_SPOTTED";
      response.stage = "contact";
      response.lostAtTick = response.clearAtTick = null;
      response.clearProgress = 0;
      return !initial && !wasTracked ? "reacquired" : null;
    }
    response.lostAtTick ??= tick;
    const age = tick - response.lostAtTick;
    d.state = !response.lastSeen || age >= SEARCH_TICKS ? "LOST" : age >= LAST_KNOWN_TICKS ? "SEARCHING" : "LAST_KNOWN";
    response.stage = "search";
    return wasTracked ? "contact-lost" : null;
  }
  function separated(player, pursuit) {
    if (distance(player, pursuit.playerStart) < 45 || distance(player, pursuit.response.lastSeen) < 32)
      return false;
    for (const unit2 of pursuit.patrols)
      if (active(unit2) && distance(player, unit2) < 28) return false;
    return true;
  }
  function updateDispatchEscape(world, tracked) {
    const { player, pursuit, tick } = world, { response, gta } = pursuit;
    if (tracked) {
      gta.lostTicks = 0;
      gta.fadeStars = pursuit.wantedLevel;
      return;
    }
    gta.lostTicks = tick - (response.lostAtTick ?? tick);
    if (!response.dispatch.escapeEligible || !response.lastSeen || !separated(player, pursuit)) {
      response.clearAtTick = null;
      response.clearProgress = 0;
      pursuit.wantedLevel = gta.fadeStars;
      return;
    }
    response.clearAtTick ??= tick;
    const fading = Math.max(0, tick - response.clearAtTick - LOSS_GRACE_TICKS);
    const stars = gta.fadeStars;
    const wanted = Math.max(0, stars - Math.floor(fading / FADE_TICKS));
    if (wanted < pursuit.wantedLevel) gta.heat = 0;
    pursuit.wantedLevel = wanted;
    response.stage = fading > 0 ? "clearing" : "search";
    response.clearProgress = clamp(fading / (FADE_TICKS * stars), 0, 1);
  }

  // src/core/vehicle-spec.js
  var PLAYER_VEHICLE = Object.freeze({
    lengthM: 4.2,
    widthM: 1.85,
    heightM: 1.82,
    wheelbaseM: 2.6,
    trackM: 1.55,
    wheelRadiusM: 0.35,
    massKg: 1800,
    steeringRatio: 14.5,
    maxSteerRad: 0.62,
    maxRangeM: 35,
    roadHeightM: 0.12,
    centerOfMassHeightM: 0.68,
    suspensionTravelM: 0.07
  });
  var rangeLayout = [
    ["left-outer", -70, -0.76],
    ["left-inner", -35, -0.43],
    ["center", 0, 0],
    ["right-inner", 35, 0.43],
    ["right-outer", 70, 0.76]
  ];
  var dimension = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
  function getVehicleMounts(body = {}) {
    const scale = body.giantScale ?? 1;
    const length = dimension(body.length, PLAYER_VEHICLE.lengthM) / scale;
    const width = dimension(body.width, PLAYER_VEHICLE.widthM) / scale;
    const camera = {
      id: "front-camera",
      angleDeg: 0,
      position: { x: 0, y: 1.46, z: 0.72 }
    };
    const mounts2 = {
      ranges: rangeLayout.map(([id, angleDeg, x]) => ({
        id,
        angleDeg,
        position: {
          x: x * width / PLAYER_VEHICLE.widthM,
          y: 0.54,
          z: length / 2 + 0.04
        }
      })),
      auxiliary: [
        ...[
          ["rear-left", -145, -0.66],
          ["rear-center", 180, 0],
          ["rear-right", 145, 0.66]
        ].map(([id, angleDeg, x]) => ({
          id,
          angleDeg,
          position: {
            x: x * width / PLAYER_VEHICLE.widthM,
            y: 0.58,
            z: -length / 2 - 0.04
          }
        })),
        {
          id: "side-left",
          angleDeg: -90,
          position: { x: -width / 2 - 0.03, y: 0.64, z: 0.15 }
        },
        {
          id: "side-right",
          angleDeg: 90,
          position: { x: width / 2 + 0.03, y: 0.64, z: 0.15 }
        }
      ],
      camera,
      cameras: [
        camera,
        {
          id: "rear-camera",
          angleDeg: 180,
          position: { x: 0, y: 1.3, z: -length / 2 - 0.035 }
        }
      ],
      telemetry: {
        id: "roof-imu-gnss",
        position: { x: 0, y: 1.88, z: -0.15 }
      }
    };
    if (scale !== 1) {
      for (const { position: p } of [...mounts2.ranges, ...mounts2.auxiliary, ...mounts2.cameras, mounts2.telemetry]) {
        p.x *= scale;
        p.y *= scale;
        p.z *= scale;
      }
    }
    return mounts2;
  }
  function mountToWorld(body, position2) {
    const c = Math.cos(body.heading ?? 0);
    const s = Math.sin(body.heading ?? 0);
    return {
      x: body.x + position2.x * c + position2.z * s,
      y: PLAYER_VEHICLE.roadHeightM + (body.y ?? 0) + position2.y,
      z: body.z - position2.x * s + position2.z * c
    };
  }

  // src/core/vehicle.js
  var approach = (a, b, amount) => a + clamp(b - a, -amount, amount);
  var fixedPathGeometry = /* @__PURE__ */ new WeakMap();
  var immutablePaths = /* @__PURE__ */ new WeakSet();
  function hasImmutablePathPoints(path) {
    if (immutablePaths.has(path)) return true;
    if (!Object.isFrozen(path)) return false;
    for (let i = 0; i < path.length; i++) {
      const entry = Object.getOwnPropertyDescriptor(path, i);
      if (!entry || !Object.hasOwn(entry, "value") || !Object.isFrozen(entry.value))
        return false;
      const x = Object.getOwnPropertyDescriptor(entry.value, "x");
      const z = Object.getOwnPropertyDescriptor(entry.value, "z");
      if (typeof x?.value !== "number" || typeof z?.value !== "number") return false;
    }
    immutablePaths.add(path);
    return true;
  }
  function immutablePathGeometry(path) {
    const cached = fixedPathGeometry.get(path);
    if (cached) return cached;
    if (!hasImmutablePathPoints(path)) return null;
    const lengths = new Float64Array(path.length - 1);
    const headings = new Float64Array(lengths.length);
    const bends = new Float64Array(lengths.length);
    const upcoming = [];
    for (let i = 0; i < path.length - 1; i++) {
      const dx = path[i + 1].x - path[i].x, dz = path[i + 1].z - path[i].z;
      lengths[i] = Math.hypot(dx, dz);
      headings[i] = Math.atan2(dx, dz);
    }
    for (let i = 1; i < path.length - 1; i++)
      bends[i] = Math.abs(angleDelta(headings[i], headings[i - 1])) / Math.max(0.1, lengths[i - 1]);
    const geometry = { lengths, bends, upcoming };
    fixedPathGeometry.set(path, geometry);
    return geometry;
  }
  function vehicleProbe(body, speed) {
    return {
      x: body.x,
      z: body.z,
      heading: body.heading,
      speed,
      steer: body.steer,
      maxSpeed: body.maxSpeed,
      spec: body.spec,
      type: body.type,
      length: body.length,
      width: body.width,
      radius: body.radius,
      ...body.arcadeSlip ? { arcadeSlip: body.arcadeSlip } : {}
    };
  }
  function integrateVehicle(body, command, dt, out = null) {
    if (!Number.isFinite(dt) || dt < 0)
      throw new RangeError("Vehicle integration needs a nonnegative step");
    const spec = body.spec == null ? VEHICLE : { ...VEHICLE, ...body.spec };
    const explicitDeceleration = Object.prototype.hasOwnProperty.call(command, "decelerationMps2");
    if (explicitDeceleration && (!Number.isFinite(spec.braking) || spec.braking <= 0 || !Number.isFinite(command.decelerationMps2) || command.decelerationMps2 <= 0 || command.decelerationMps2 > spec.braking))
      throw new RangeError("Explicit vehicle deceleration must be finite, positive and at most spec.braking");
    const braking = explicitDeceleration ? command.decelerationMps2 : spec.braking;
    const steer = approach(
      body.steer ?? 0,
      clamp(Number.isFinite(command.steer) ? command.steer : 0, -spec.maxSteer, spec.maxSteer),
      spec.steerRate * dt
    );
    const requested = clamp(
      Number.isFinite(command.targetSpeed) ? command.targetSpeed : 0,
      -spec.reverseSpeed,
      body.maxSpeed ?? 13.89
    );
    const reversing = (body.speed ?? 0) * requested < 0;
    const target = reversing ? 0 : requested;
    const slowing = Math.abs(target) < Math.abs(body.speed ?? 0) || reversing;
    const speed = approach(
      body.speed ?? 0,
      target,
      (slowing ? braking : spec.acceleration) * dt
    );
    const average = (speed + (body.speed ?? 0)) / 2;
    const tangent = Math.tan(steer);
    const beta = Math.atan(0.5 * tangent);
    const yawRate = average / spec.wheelbase * Math.cos(beta) * tangent;
    const drift = command.arcadeDrift === true && average > 0;
    const slip = drift ? (body.arcadeSlip ?? 0) + (clamp(-yawRate * speed * 0.036, -0.32, 0.32) - (body.arcadeSlip ?? 0)) * (1 - Math.exp(-7 * dt)) : 0;
    const middle = body.heading + yawRate * dt / 2 + beta + slip;
    const result = out ?? { ...body };
    result.x = body.x + Math.sin(middle) * average * dt;
    result.z = body.z + Math.cos(middle) * average * dt;
    result.heading = body.heading + yawRate * dt;
    result.steer = steer;
    result.speed = speed;
    if (drift || body.arcadeSlip !== void 0) result.arcadeSlip = slip;
    return result;
  }
  function resolveVehicleContact(before, proposed, obstacle, dt = STEP) {
    if (!Number.isFinite(dt) || dt <= 0)
      throw new RangeError("Contact needs a positive step");
    if (overlaps(before, obstacle)) return null;
    const travel2 = distance(before, proposed) + Math.abs(angleDelta(proposed.heading, before.heading)) * Math.hypot(before.length, before.width) / 2;
    if (travel2 < 1e-10) return null;
    const steps = Math.max(1, Math.ceil(travel2 / 0.04));
    let low = 0;
    let high = null;
    for (let i = 1; i <= steps; i++) {
      if (overlaps(interpolate(before, proposed, i / steps), obstacle)) {
        high = i / steps;
        low = (i - 1) / steps;
        break;
      }
    }
    if (high === null) return null;
    for (let i = 0; i < 32; i++) {
      const middle = (low + high) / 2;
      if (overlaps(interpolate(before, proposed, middle), obstacle)) high = middle;
      else low = middle;
    }
    const body = interpolate(before, proposed, low);
    const a = corners(body);
    const b = corners(obstacle);
    let separation = -Infinity;
    let normal2;
    for (const shape2 of [body, obstacle]) {
      for (const offset2 of [0, Math.PI / 2]) {
        const axis = {
          x: Math.sin((shape2.heading ?? 0) + offset2),
          z: Math.cos((shape2.heading ?? 0) + offset2)
        };
        const pa = a.map((p) => p.x * axis.x + p.z * axis.z);
        const pb = b.map((p) => p.x * axis.x + p.z * axis.z);
        const forwardGap = Math.min(...pb) - Math.max(...pa);
        const reverseGap = Math.min(...pa) - Math.max(...pb);
        const gap = Math.max(forwardGap, reverseGap);
        if (gap > separation) {
          separation = gap;
          const sign = forwardGap >= reverseGap ? 1 : -1;
          normal2 = { x: axis.x * sign, z: axis.z * sign };
        }
      }
    }
    const forward2 = normal2.x * Math.sin(body.heading) + normal2.z * Math.cos(body.heading);
    const right = normal2.x * Math.cos(body.heading) - normal2.z * Math.sin(body.heading);
    const side = Math.abs(forward2) >= Math.abs(right) ? forward2 > 0 ? "front" : "rear" : right > 0 ? "right" : "left";
    const obstacleSpeed = obstacle.speed ?? 0;
    const vx = (proposed.x - before.x) / dt - Math.sin(obstacle.heading ?? 0) * obstacleSpeed;
    const vz = (proposed.z - before.z) / dt - Math.cos(obstacle.heading ?? 0) * obstacleSpeed;
    const closingSpeedMps = Math.max(0, vx * normal2.x + vz * normal2.z);
    return {
      body: { ...body, speed: 0, reason: "vehicle-contact", blockedBy: obstacle.id },
      hitId: obstacle.id,
      side,
      normal: normal2,
      closingSpeedMps,
      energyJ: 0.5 * PLAYER_VEHICLE.massKg * closingSpeedMps ** 2,
      proposedTravelM: distance(before, proposed)
    };
  }
  function nearestPathPoint(path, x, z, cursor, fallback = cursor) {
    const end = Math.min(path.length, cursor + 18);
    let nearest2 = fallback, best = Infinity;
    for (let i = Math.max(0, cursor - 2); i < end; i++) {
      const dx = path[i].x - x, dz = path[i].z - z;
      if (Math.abs(dx) > best || Math.abs(dz) > best) continue;
      const d = Math.hypot(dx, dz);
      if (d < best) {
        nearest2 = i;
        best = d;
      }
    }
    return nearest2;
  }
  function followPath(body, path, cursor = 0, steeringOnly = false) {
    if (path.length < 2)
      return { steer: 0, targetSpeed: 0, cursor, remaining: 0 };
    const wheelbase = body.spec?.wheelbase ?? VEHICLE.wheelbase;
    const fixed = immutablePathGeometry(path);
    const x = body.x - Math.sin(body.heading) * wheelbase / 2;
    const z = body.z - Math.cos(body.heading) * wheelbase / 2;
    const nearest2 = nearestPathPoint(path, x, z, cursor);
    let target = nearest2, length = 0;
    const lookahead = 2 + Math.abs(body.speed ?? 0) * 0.18;
    while (target < path.length - 1 && length < lookahead) {
      length += fixed ? fixed.lengths[target] : Math.hypot(
        path[target + 1].x - path[target].x,
        path[target + 1].z - path[target].z
      );
      target++;
    }
    const point2 = path[target];
    const alpha = angleDelta(
      Math.atan2(point2.x - x, point2.z - z),
      body.heading
    );
    const actualDistance = Math.max(
      1,
      Math.hypot(point2.x - x, point2.z - z)
    );
    const steer = Math.atan2(2 * wheelbase * Math.sin(alpha), actualDistance);
    if (steeringOnly) return { steer, cursor: nearest2 };
    let remaining = Math.hypot(
      path[nearest2].x - body.x,
      path[nearest2].z - body.z
    );
    if (fixed) {
      const lengths = fixed.lengths;
      for (let i = nearest2; i < lengths.length; i++) remaining += lengths[i];
    } else {
      for (let i = nearest2; i < path.length - 1; i++) remaining += Math.hypot(
        path[i + 1].x - path[i].x,
        path[i + 1].z - path[i].z
      );
    }
    const curvature = Math.abs(Math.tan(steer) / VEHICLE.wheelbase);
    const curveSpeed = Math.sqrt(2.5 / Math.max(8e-3, curvature));
    let upcomingSpeed = fixed?.upcoming[nearest2];
    if (upcomingSpeed === void 0) {
      upcomingSpeed = Infinity;
      let along2 = 0;
      for (let i = nearest2 + 1; i < path.length - 1 && along2 < 14; i++) {
        const a = path[i - 1], b = path[i], c = path[i + 1];
        const segment = fixed ? fixed.lengths[i - 1] : Math.hypot(b.x - a.x, b.z - a.z);
        along2 += segment;
        const bend = fixed ? fixed.bends[i] : Math.abs(angleDelta(
          Math.atan2(c.x - b.x, c.z - b.z),
          Math.atan2(b.x - a.x, b.z - a.z)
        )) / Math.max(0.1, segment);
        if (bend > 0.03)
          upcomingSpeed = Math.min(
            upcomingSpeed,
            Math.sqrt(2.1 / bend + 2 * 2.5 * Math.max(0, along2 - 2))
          );
      }
      if (fixed) fixed.upcoming[nearest2] = upcomingSpeed;
    }
    return {
      steer,
      targetSpeed: Math.min(
        body.maxSpeed,
        curveSpeed,
        upcomingSpeed,
        Math.sqrt(Math.max(0, remaining - 0.6) * 4)
      ),
      cursor: nearest2,
      remaining
    };
  }

  // src/core/pursuit-gta.js
  var GtaChaseConfig = Object.freeze({
    wantedLevelStart: 1,
    wantedLevelMax: 5,
    maxActivePatrols: 12,
    npcSpeedMultiplier: 1,
    enablePitManeuver: true,
    enableRamming: true,
    enableRoadblocks: true,
    enableSwat: true,
    playerMaxHealth: 100,
    episodeMaxSeconds: 120,
    minSpawnRadius: 16,
    wreckSeconds: 8
  });
  var GTA_MAX_SPEED = 28;
  var GTA_PIN_SECONDS = 2.2;
  var CIVILIAN_MOTION_PREVIEW = "visible-motion-v2";
  var PATROL_TRAFFIC_PREVIEW = "visible-traffic-v1";
  var DISPATCH_DAMAGE_FEEDBACK = "accepted-contact-v1";
  var GTA_UNIT_TYPES = Object.freeze(["patrol", "interceptor", "swat"]);
  var GTA_AI_STATES = Object.freeze([
    "APPROACH",
    "PURSUIT",
    "FLANK",
    "PIT_MANEUVER",
    "RAM",
    "BLOCK_INTERCEPT",
    "ROADBLOCK",
    "SEARCH",
    "RECOVER",
    "WRECKED"
  ]);
  var GTA_PATROL_PROFILES = Object.freeze({
    patrol: Object.freeze({ kind: "sedan", mass: 1750, health: 85, speed: 20, acceleration: 3.1, steerRate: 0.95 }),
    interceptor: Object.freeze({ kind: "suv", mass: 1650, health: 78, speed: 25, acceleration: 4.2, steerRate: 1.2 }),
    swat: Object.freeze({ kind: "van", mass: 4200, health: 165, speed: 16, acceleration: 2.55, steerRate: 0.68 })
  });
  var DISPATCH_LIGHT_PACE = Object.freeze({
    patrol: Object.freeze({ speed: 31.6, acceleration: 4.5 }),
    interceptor: Object.freeze({ speed: 33, acceleration: 5.2 })
  });
  var DISPATCH_LIGHT_CAP = 34.1;
  var PURSUIT_LATERAL_ACCEL = 6;
  var PIN_TICKS = Math.round(GTA_PIN_SECONDS / STEP);
  var FADE_TICKS2 = Math.round(2.4 / STEP);
  var LOST_GRACE_TICKS = Math.round(3 / STEP);
  var GTA_SLIP_LIMIT = 11;
  var GTA_YAW_LIMIT = 4;
  var STUCK_TICKS = Math.round(1.4 / STEP);
  var RECOVER_TICKS = Math.round(0.9 / STEP);
  var headingTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
  function resolveGtaChaseConfig(options2 = {}, level = GtaChaseConfig.wantedLevelStart) {
    if (!options2 || Object.getPrototypeOf(options2) !== Object.prototype)
      throw new TypeError("GTA chase config must be a plain object");
    for (const key3 of Object.keys(options2))
      if (!Object.hasOwn(GtaChaseConfig, key3) && !["ruleset", "surveillanceZones", "civilianCrossingPreview", "patrolTrafficPreview", "damageFeedback"].includes(key3))
        throw new TypeError(`Unknown GTA chase config field: ${key3}`);
    const config = { ...GtaChaseConfig, wantedLevelStart: level, ...options2 };
    if (Object.hasOwn(config, "ruleset") && config.ruleset !== "legacy" && config.ruleset !== DISPATCH_RULESET)
      throw new RangeError("Unknown GTA chase ruleset");
    if (config.ruleset === DISPATCH_RULESET) {
      config.surveillanceZones = Object.hasOwn(config, "surveillanceZones") ? resolveSurveillanceZones(config.surveillanceZones) : DEFAULT_SURVEILLANCE_ZONES;
    } else if (Object.hasOwn(config, "surveillanceZones"))
      throw new TypeError(`surveillanceZones requires ruleset "${DISPATCH_RULESET}"`);
    if (Object.hasOwn(config, "civilianCrossingPreview") && (config.ruleset !== DISPATCH_RULESET || typeof config.civilianCrossingPreview !== "boolean" && config.civilianCrossingPreview !== CIVILIAN_MOTION_PREVIEW))
      throw new TypeError(`civilianCrossingPreview requires a boolean or "${CIVILIAN_MOTION_PREVIEW}" and ruleset "${DISPATCH_RULESET}"`);
    if (Object.hasOwn(config, "patrolTrafficPreview") && (config.ruleset !== DISPATCH_RULESET || config.patrolTrafficPreview !== PATROL_TRAFFIC_PREVIEW))
      throw new TypeError(`patrolTrafficPreview requires "${PATROL_TRAFFIC_PREVIEW}" and ruleset "${DISPATCH_RULESET}"`);
    if (Object.hasOwn(config, "damageFeedback") && (config.ruleset !== DISPATCH_RULESET || config.damageFeedback !== DISPATCH_DAMAGE_FEEDBACK))
      throw new TypeError(`damageFeedback requires "${DISPATCH_DAMAGE_FEEDBACK}" and ruleset "${DISPATCH_RULESET}"`);
    for (const key3 of ["wantedLevelStart", "wantedLevelMax", "maxActivePatrols"]) {
      const min = key3 === "maxActivePatrols" ? 0 : 1, max = key3 === "maxActivePatrols" ? 32 : 5;
      if (!Number.isInteger(config[key3]) || config[key3] < min || config[key3] > max)
        throw new RangeError(`${key3} must be an integer between ${min} and ${max}`);
    }
    if (config.wantedLevelStart > config.wantedLevelMax)
      throw new RangeError("wantedLevelStart must not exceed wantedLevelMax");
    for (const [key3, max] of [
      ["npcSpeedMultiplier", 3],
      ["playerMaxHealth", 1e6],
      ["episodeMaxSeconds", 86400],
      ["minSpawnRadius", 45],
      ["wreckSeconds", 120]
    ])
      if (!Number.isFinite(config[key3]) || config[key3] <= 0 || config[key3] > max)
        throw new RangeError(`${key3} must be positive and at most ${max}`);
    for (const key3 of ["enablePitManeuver", "enableRamming", "enableRoadblocks", "enableSwat"])
      if (typeof config[key3] !== "boolean") throw new TypeError(`${key3} must be a boolean`);
    return Object.freeze(config);
  }
  function initializeGtaPursuit(state, player, config) {
    const dispatch = config.ruleset === DISPATCH_RULESET;
    state.wantedLevel = config.wantedLevelStart;
    state.stepEvents = [];
    state.gta = {
      config,
      normalMaxSpeed: player.maxSpeed,
      serial: 0,
      pinnedTicks: 0,
      fadeStars: dispatch ? state.wantedLevel : 0,
      lostTicks: 0,
      roadblock: null,
      heat: 0,
      nextDispatchTick: 0,
      nextRoadblockTick: 0,
      nextSquadTick: 0
    };
    if (dispatch) state.response.dispatch = createDispatchResponse();
  }
  function initializeGtaDurability(actor, maxHealth, massKg) {
    Object.assign(actor, { health: maxHealth, maxHealth, gtaMassKg: massKg, gtaSlipMps: 0, gtaYawRate: 0 });
  }
  function initializeGtaPatrol(car, unitType, state) {
    const profile = GTA_PATROL_PROFILES[unitType];
    const { config } = state.gta;
    const faster = config.ruleset === DISPATCH_RULESET && DISPATCH_LIGHT_PACE[unitType];
    car.unitType = unitType;
    car.aiState = "APPROACH";
    car.squadRole = "SUPPORT";
    car.pursuitRole = "police";
    car.reckless = false;
    car.height = unitType === "swat" ? 2.1 : 1.5;
    if (unitType === "swat") {
      car.length = 5.2;
      car.width = 2.1;
    }
    car.spec = {
      acceleration: faster?.acceleration ?? profile.acceleration,
      steerRate: profile.steerRate,
      wheelbase: unitType === "swat" ? 3.15 : VEHICLE.wheelbase
    };
    car.maxSpeed = faster ? Math.min(DISPATCH_LIGHT_CAP, faster.speed * config.npcSpeedMultiplier) : profile.speed * config.npcSpeedMultiplier;
    car.gtaAI = { order: state.gta.serial, nextPlan: 0, stuckTicks: 0, behindTicks: 0 };
    initializeGtaDurability(car, profile.health, profile.mass);
  }
  function gtaOffset(from, forward2, right = 0) {
    const sin = Math.sin(from.heading), cos = Math.cos(from.heading);
    return { x: from.x + forward2 * sin + right * cos, z: from.z + forward2 * cos - right * sin };
  }
  function gtaLocal(from, to) {
    const dx = to.x - from.x, dz = to.z - from.z, sin = Math.sin(from.heading), cos = Math.cos(from.heading);
    return { forward: dx * sin + dz * cos, right: dx * cos - dz * sin };
  }
  function directCommand(car, aim, pace, steerBias = 0, dispatch = false) {
    const error = angleDelta(headingTo(car, aim), car.heading);
    const steer = clamp(error * 0.91 + steerBias, -VEHICLE.maxSteer, VEHICLE.maxSteer);
    const curvature = Math.abs(Math.tan(steer)) / car.spec.wheelbase;
    const curveSpeed = Math.sqrt(PURSUIT_LATERAL_ACCEL / (dispatch ? curvature : Math.max(8e-3, curvature)));
    return { steer, targetSpeed: Math.min(car.maxSpeed, pace, curveSpeed) };
  }
  function recoveryBlockers(world, car) {
    const { player, pursuit } = world;
    const blockers = world.statics.concat(world.actorIndex.near(car, 9).filter((body) => body !== car && body !== player));
    if (isDispatchTracked(pursuit.response)) {
      blockers.push({ ...vehicleProbe(player, 0), ...pursuit.response.lastSeen });
    }
    return blockers;
  }
  function projectRecovery(world, car, command, steps, blockers) {
    let pose5 = { ...vehicleProbe(car, car.speed), gtaSlipMps: car.gtaSlipMps, gtaYawRate: car.gtaYawRate };
    for (let i = 0; i < steps; i++) {
      const next = integrateVehicle(pose5, command, STEP);
      integrateGtaSlip(pose5, next);
      if (!sweepSafe(pose5, next, blockers, world.roads).safe) return null;
      pose5 = next;
    }
    return pose5;
  }
  function chooseDispatchRecovery(world, car) {
    const blockers = recoveryBlockers(world, car);
    let best = null, bestScore = -Infinity;
    for (const targetSpeed of [2.8, -2.35]) for (const steer of [0, -0.5, 0.5]) {
      const command = { steer, targetSpeed, reason: "RECOVER" };
      const pose5 = projectRecovery(world, car, command, RECOVER_TICKS, blockers);
      if (!pose5) continue;
      let alignment = 0;
      for (const road4 of world.drivingRoads) {
        if (road4.parkingBay || road4.supportApron || !pointOnRoad(pose5, [road4])) continue;
        const direction3 = road4.axis === "x" ? Math.sin(pose5.heading) : Math.cos(pose5.heading);
        alignment = Math.max(alignment, road4.flow ? direction3 * road4.flow : Math.abs(direction3));
      }
      const score = alignment * 4 + distance(car, pose5) * 0.2 + (targetSpeed > 0 ? 0.08 : 0);
      if (score > bestScore) {
        best = command;
        bestScore = score;
      }
    }
    return best;
  }
  function usesCheckedRecovery(pursuit) {
    return Boolean(pursuit.response.dispatch) && pursuit.wantedLevel >= 3;
  }
  function trackGtaPatrolProgress(world, car, command, moved) {
    const ai = car.gtaAI;
    if (isGtaStationary(car) || car.aiState === "RECOVER") return;
    const { pursuit } = world;
    const checked = usesCheckedRecovery(pursuit);
    const noRoute = checked && command.needsTrackedRecovery && isDispatchTracked(pursuit.response);
    ai.stuckTicks = (command.targetSpeed > 0.5 || noRoute) && moved / STEP < 0.5 ? ai.stuckTicks + 1 : 0;
    if (ai.stuckTicks <= STUCK_TICKS) return;
    ai.stuckTicks = 0;
    ai.checkedRecovery = checked ? chooseDispatchRecovery(world, car) : null;
    if (checked && !ai.checkedRecovery) return;
    ai.resumeState = car.aiState;
    ai.recoverUntil = world.tick + 1 + RECOVER_TICKS;
    ai.counterSteer = -0.24 * (Math.sign(car.steer) || (ai.order % 2 ? 1 : -1));
    ai.commitUntil = null;
    car.aiState = "RECOVER";
  }
  function dispatchPathCommand(car, pace, steerBias, arrivalSpeed) {
    const { path } = car;
    const follow = followPath(car, path, car.cursor, true);
    const steer = clamp(follow.steer + steerBias, -VEHICLE.maxSteer, VEHICLE.maxSteer);
    const curvature = Math.abs(Math.tan(steer)) / car.spec.wheelbase;
    let targetSpeed = Math.min(car.maxSpeed, pace, Math.sqrt(PURSUIT_LATERAL_ACCEL / curvature));
    const braking = car.spec.braking ?? VEHICLE.braking;
    const margin = 2;
    const horizon = margin + targetSpeed ** 2 / (2 * braking);
    let remaining = 0;
    for (let i = follow.cursor; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1], dx = b.x - a.x, dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (!length) continue;
      const used = i === follow.cursor ? clamp(((car.x - a.x) * dx + (car.z - a.z) * dz) / length, 0, length) : 0;
      remaining += length - used;
      if (remaining > horizon) break;
      const c = path[i + 2];
      const available = 2 * braking * Math.max(0, remaining - margin);
      if (!c) {
        targetSpeed = Math.min(targetSpeed, Math.sqrt(arrivalSpeed ** 2 + available));
      } else {
        const nextLength = distance(b, c);
        const bend = Math.abs(angleDelta(headingTo(b, c), headingTo(a, b))) / Math.max(0.1, (length + nextLength) / 2);
        if (bend > 3e-3)
          targetSpeed = Math.min(targetSpeed, Math.sqrt(PURSUIT_LATERAL_ACCEL / bend + available));
      }
    }
    return { cursor: follow.cursor, remaining, steer, targetSpeed };
  }
  function routeCommand(world, car, aim, pace, planRoute, steerBias, dispatchArrivalSpeed = null, tracked = false) {
    const ai = car.gtaAI;
    if (world.tick >= ai.nextPlan) {
      ai.nextPlan = world.tick + (car.path.length ? 48 : 65) + Math.floor(car.phase * 17);
      if (!planRoute(world, car, aim)) {
        car.path = [];
        car.cursor = 0;
      }
    }
    if (car.path.length > 1) {
      if (dispatchArrivalSpeed !== null) {
        const { cursor, remaining, steer, targetSpeed } = dispatchPathCommand(car, pace, steerBias, dispatchArrivalSpeed);
        car.cursor = cursor;
        if (remaining >= 1.5) return { steer, targetSpeed };
      } else {
        const command = followPath(car, car.path, car.cursor);
        car.cursor = command.cursor;
        if (command.remaining >= 1.5) return {
          steer: clamp(command.steer + steerBias, -VEHICLE.maxSteer, VEHICLE.maxSteer),
          targetSpeed: Math.min(pace, car.maxSpeed, Math.max(2, command.targetSpeed * 1.25))
        };
      }
      car.path = [];
      ai.nextPlan = world.tick + 1;
    }
    const next = gtaOffset(car, 3);
    const aligned = Math.abs(angleDelta(headingTo(car, aim), car.heading)) < 1;
    return pointOnRoad(next, world.drivingRoads) && aligned ? directCommand(car, aim, Math.min(3.2, pace), steerBias, dispatchArrivalSpeed !== null) : { steer: 0, targetSpeed: 0, ...dispatchArrivalSpeed !== null && tracked ? { needsTrackedRecovery: true } : {} };
  }
  function gtaPatrolCommand(world, car, planRoute, canDriveDirect, steerBias) {
    const { pursuit: s, tick } = world, { config } = s.gta, ai = car.gtaAI;
    if (car.aiState === "RECOVER") {
      if (tick < ai.recoverUntil) {
        if (!ai.checkedRecovery) return { steer: ai.counterSteer, targetSpeed: -2.35, reason: "RECOVER" };
        return projectRecovery(world, car, ai.checkedRecovery, 6, recoveryBlockers(world, car)) ? ai.checkedRecovery : { steer: 0, targetSpeed: 0, reason: "RECOVER" };
      }
      car.aiState = ai.resumeState;
      ai.checkedRecovery = null;
      car.path = [];
      ai.nextPlan = 0;
    }
    const seen = s.response.sightedBy.has(car);
    const dispatch = Boolean(s.response.dispatch);
    const tracked = dispatch ? isDispatchTracked(s.response) : seen;
    if (dispatch && !s.response.lastSeen) {
      ai.commitUntil = null;
      car.aiState = "SEARCH";
      return { steer: 0, targetSpeed: 0, reason: "SEARCH" };
    }
    const report = s.response.lastSeen ?? s.playerStart;
    const range = distance(car, report), rel = gtaLocal(report, car);
    const reportSpeed = Math.abs(report.speed);
    const pace = Math.min(car.maxSpeed, Math.max(
      5.5,
      (dispatch && tracked ? reportSpeed * 1.14 : reportSpeed) + 2.8 + range * 0.15
    ) * config.npcSpeedMultiplier);
    let state, aim, command;
    if (!seen) ai.commitUntil = null;
    if (!tracked) {
      const searching = dispatch ? s.response.dispatch.state !== "LAST_KNOWN" : s.gta.lostTicks >= 75;
      state = searching || range < 7 ? "SEARCH" : "APPROACH";
      const sector2 = (ai.order + Math.floor(s.gta.lostTicks / 210)) % 4;
      aim = state === "SEARCH" ? gtaOffset(report, sector2 < 2 ? 13 : -13, sector2 % 2 ? 9 : -9) : report;
    } else {
      const lead = clamp(report.speed * clamp(0.35 + range * 0.015, 0.35, 1.1), -12, 12);
      state = "PURSUIT";
      aim = gtaOffset(report, lead);
      if (s.wantedLevel >= 3 && car.squadRole === "FLANKER") {
        state = "FLANK";
        aim = gtaOffset(report, lead + 2, car.squadSide * 4.2);
      } else if (s.wantedLevel >= 3 && car.squadRole === "INTERCEPTOR") {
        state = "BLOCK_INTERCEPT";
        aim = gtaOffset(report, clamp(lead + 12, 11, 23), car.squadSide * 2.6);
        if (rel.forward > 6 && distance(car, aim) < 5.5) {
          const inward = angleDelta(headingTo(car, report), car.heading);
          command = { steer: clamp(inward, -0.55, 0.55), targetSpeed: distance(car, aim) < 2.8 ? 0 : 1.8 };
        }
      } else if (s.wantedLevel >= 3 && car.squadRole === "SUPPORT") {
        aim = gtaOffset(report, lead - (4 + ai.order % 4 * 3), (ai.order % 2 ? 1 : -1) * 2.5);
      }
      const pit = seen && config.enablePitManeuver && s.wantedLevel >= 2 && car.unitType !== "swat" && car.squadRole === "PRIMARY_CHASER" && report.speed > 2.8 && rel.forward >= -4.5 && rel.forward < -0.5 && Math.abs(rel.right) > 1.2 && Math.abs(rel.right) < 4.8 && Math.abs(car.speed - report.speed) < 4.5 && Math.abs(angleDelta(report.heading, car.heading)) < 0.57;
      const ramAim = gtaOffset(report, clamp(report.speed * 0.28, -3, 5));
      const ram = seen && config.enableRamming && s.wantedLevel >= 4 && (car.unitType === "swat" || s.wantedLevel === 5 && car.squadRole !== "PRIMARY_CHASER") && car.speed >= 5 && range <= 19 && rel.forward < 3 && Math.abs(angleDelta(headingTo(car, ramAim), car.heading)) < 0.48 && canDriveDirect(world, car, ramAim, true);
      if (pit) {
        state = "PIT_MANEUVER";
        aim = gtaOffset(report, Math.max(2.5, report.speed * 0.48), Math.sign(rel.right) * 0.28);
        command = directCommand(car, aim, report.speed + 3, 0, dispatch);
      } else if (seen && (ai.commitUntil > tick || ram && tick >= (ai.nextRam ?? 0))) {
        if (!(ai.commitUntil > tick)) {
          ai.commitUntil = tick + 38;
          ai.nextRam = tick + 105;
          ai.ramAim = ramAim;
        }
        if (canDriveDirect(world, car, ai.ramAim, true)) {
          state = "RAM";
          command = directCommand(car, ai.ramAim, car.maxSpeed, 0, dispatch);
        } else ai.commitUntil = null;
      }
      if (!command && canDriveDirect(world, car, aim)) {
        if (car.path.length) {
          car.path = [];
          car.cursor = 0;
          ai.nextPlan = 0;
        }
        command = directCommand(car, aim, pace, steerBias, dispatch);
      }
    }
    if (!command) {
      if (ai.routeState !== state) {
        car.path = [];
        car.cursor = 0;
        ai.nextPlan = 0;
        ai.routeState = state;
      }
      command = routeCommand(
        world,
        car,
        aim,
        pace,
        planRoute,
        steerBias,
        dispatch ? tracked ? reportSpeed : 0 : null,
        tracked
      );
    }
    car.aiState = state;
    return { ...command, reason: state };
  }
  function emitGtaEvent(world, type, fields) {
    const { pursuit } = world;
    pursuit.stepEvents.push({ type, tick: pursuit.gta.eventTick, ...fields });
  }
  function integrateGtaSlip(actor, next) {
    const slip = actor.gtaSlipMps * Math.exp(-3.8 * STEP);
    const yaw = actor.gtaYawRate * Math.exp(-3 * STEP);
    next.x += Math.cos(next.heading) * slip * STEP;
    next.z -= Math.sin(next.heading) * slip * STEP;
    next.heading += yaw * STEP;
    next.gtaSlipMps = slip;
    next.gtaYawRate = yaw;
  }
  function isGtaStationary(actor) {
    return actor.aiState === "WRECKED" || actor.aiState === "ROADBLOCK";
  }
  function mass(actor) {
    return actor.gtaMassKg ?? (actor.type === "static" ? Infinity : actor.type === "pedestrian" ? actor.body?.massKg ?? 75 : actor.kind === "tuktuk" ? 620 : 1450);
  }
  function contactEvidence(a, b, closingSpeed2) {
    const inverseMass = 1 / mass(a) + 1 / mass(b);
    const energyJ = inverseMass > 0 ? 0.5 * closingSpeed2 ** 2 / inverseMass : 0;
    return { energyJ, severity: clamp(energyJ / 42e3, 0, 1) };
  }
  function gtaVelocity(actor, heading2 = actor.heading) {
    const speed = actor.speed ?? 0, slip = actor.gtaSlipMps ?? 0;
    const s = Math.sin(heading2 ?? 0), c = Math.cos(heading2 ?? 0);
    return { x: s * speed + c * slip, z: c * speed - s * slip };
  }
  function velocityAtContact(motion, pose5) {
    if (motion.impulse) return gtaVelocity(motion.impulse, pose5.heading);
    if (motion.stop < 1 || isGtaStationary(motion.a)) return { x: 0, z: 0 };
    return gtaVelocity(motion.next, pose5.heading);
  }
  function leverArm(pose5, other) {
    const dx = other.x - pose5.x, dz = other.z - pose5.z;
    const sin = Math.sin(pose5.heading), cos = Math.cos(pose5.heading);
    return {
      lateral: clamp(dx * cos - dz * sin, -pose5.width / 2, pose5.width / 2),
      forward: clamp(dx * sin + dz * cos, -pose5.length / 2, pose5.length / 2)
    };
  }
  function shove(motion, pose5, velocity, arm, nx, nz, delta, pit) {
    const actor = motion.a;
    if (isGtaStationary(actor)) return;
    const sin = Math.sin(pose5.heading), cos = Math.cos(pose5.heading);
    const forward2 = delta * (nx * sin + nz * cos), lateral2 = delta * (nx * cos - nz * sin);
    const spin = (arm.forward * lateral2 - arm.lateral * forward2) / (actor.length ** 2 / 8);
    motion.impulse = {
      speed: clamp(velocity.x * sin + velocity.z * cos + forward2, -(actor.spec?.reverseSpeed ?? VEHICLE.reverseSpeed) * 2, actor.maxSpeed + 5),
      gtaSlipMps: clamp(velocity.x * cos - velocity.z * sin + lateral2, -GTA_SLIP_LIMIT, GTA_SLIP_LIMIT),
      gtaYawRate: clamp((motion.impulse?.gtaYawRate ?? motion.next.gtaYawRate ?? 0) + spin * (pit ? 2.6 : 1), -GTA_YAW_LIMIT, GTA_YAW_LIMIT)
    };
  }
  function damage(world, motion, other, closingSpeed2, share) {
    const actor = motion.a;
    if (actor.health <= 0) return 0;
    const damage2 = Math.min(actor.health, Math.max(0, closingSpeed2 - 0.65) ** 1.45 * share * 1.55);
    actor.health -= damage2;
    if (actor.health <= 0 && world.pursuit.patrols.has(actor)) {
      actor.aiState = "WRECKED";
      actor.wreckUntilTick = world.pursuit.gta.eventTick + Math.ceil(world.pursuit.gta.config.wreckSeconds / STEP);
      actor.path = [];
      actor.cursor = 0;
      motion.impulse = { speed: 0, gtaSlipMps: 0, gtaYawRate: 0 };
      emitGtaEvent(world, "patrol_wrecked", { unitType: actor.unitType, causedByPlayer: other === world.player });
      if (other === world.player) world.pursuit.gta.heat += 1;
    }
    return damage2;
  }
  function applyGtaContact(world, a, b, pa, pb, normal2, sweptClosing, fresh) {
    const { player, pursuit } = world;
    const dispatch = Boolean(pursuit.response.dispatch);
    const ownedA = a.a === player || pursuit.patrols.has(a.a);
    const ownedB = b.a === player || pursuit.patrols.has(b.a);
    if (!ownedA && !ownedB && (!dispatch || !fresh)) return;
    const va = velocityAtContact(a, pa), vb = velocityAtContact(b, pb);
    const { x, z } = normal2;
    const closingSpeed2 = Math.max(0, sweptClosing, (va.x - vb.x) * x + (va.z - vb.z) * z);
    const other = a.a === player ? b.a : b.a === player ? a.a : null;
    if (!other && dispatch && fresh) {
      const describe = (body) => ({
        id: body.id,
        type: body.type,
        kind: body.unitType ?? body.kind ?? body.type,
        patrol: pursuit.patrols.has(body)
      });
      emitGtaEvent(world, "ambient_collision", {
        first: describe(a.a),
        second: describe(b.a),
        closingSpeed: closingSpeed2,
        ...contactEvidence(a.a, b.a, closingSpeed2)
      });
    }
    if (!ownedA && !ownedB) return;
    const patrol2 = other && pursuit.patrols.has(other);
    const egoPose = a.a === player ? pa : pb, otherPose = a.a === player ? pb : pa;
    const egoArm = other ? leverArm(egoPose, otherPose) : null;
    const isPit = Boolean(patrol2 && other.aiState === "PIT_MANEUVER" && pursuit.gta.config.enablePitManeuver && (!pursuit.response.dispatch || pursuit.response.sightedBy.has(other)) && closingSpeed2 > 0.65 && egoArm.forward < -egoPose.length * 0.14 && Math.abs(x * Math.cos(egoPose.heading) - z * Math.sin(egoPose.heading)) > 0.65);
    const ma = mass(a.a), mb = mass(b.a);
    const shareA = Number.isFinite(mb) ? mb / (ma + mb) : 1;
    const shareB = Number.isFinite(ma) ? ma / (ma + mb) : 1;
    const invA = isGtaStationary(a.a) ? 0 : 1 / ma, invB = isGtaStationary(b.a) ? 0 : 1 / mb;
    if (closingSpeed2 > 0 && invA + invB > 0) {
      const impulse = Math.min(42, closingSpeed2) * (isPit ? 1.38 : 1.17) / (invA + invB);
      if (ownedA) shove(a, pa, va, leverArm(pa, pb), x, z, -impulse * invA, isPit && a.a === player);
      if (ownedB) shove(b, pb, vb, leverArm(pb, pa), x, z, impulse * invB, isPit && b.a === player);
    }
    const damageA = ownedA ? damage(world, a, b.a, closingSpeed2, shareA) : 0;
    const damageB = ownedB ? damage(world, b, a.a, closingSpeed2, shareB) : 0;
    if (!other || !(fresh || damageA > 0 || damageB > 0)) return;
    if (fresh && other.gtaRoadblock && closingSpeed2 > 1) pursuit.gta.heat += 0.55;
    const damageToPlayer = a.a === player ? damageA : damageB;
    const evidence = dispatch ? {
      actorId: other.id,
      actorType: other.type,
      fresh,
      ...contactEvidence(player, other, closingSpeed2)
    } : {};
    if (patrol2) emitGtaEvent(world, "patrol_collision", {
      unitType: other.unitType,
      closingSpeed: closingSpeed2,
      damageToPlayer,
      damageToPatrol: a.a === player ? damageB : damageA,
      isPit,
      ...evidence
    });
    else emitGtaEvent(world, "static_or_civilian_hit", {
      kind: other.gtaRoadblock ? "roadblock" : other.type === "pedestrian" ? "pedestrian" : other.kind ?? other.type,
      closingSpeed: closingSpeed2,
      damageToPlayer,
      ...evidence
    });
  }
  function updateGtaPhase(world) {
    const { player, pursuit: s } = world, { gta, response, metrics } = s;
    const nearby = [...response.closePatrols].filter((unit2) => unit2.aiState !== "WRECKED");
    const boxed = nearby.some((a, i) => nearby.slice(i + 1).some((b) => {
      const dot2 = (a.x - player.x) * (b.x - player.x) + (a.z - player.z) * (b.z - player.z);
      return dot2 <= 0.5 * distance(a, player) * distance(b, player);
    }));
    gta.pinnedTicks = Math.hypot(player.speed, player.gtaSlipMps) < 0.8 && boxed ? Math.min(PIN_TICKS, gta.pinnedTicks + 1) : 0;
    metrics.capturePressureS = gta.pinnedTicks * STEP;
    emitGtaEvent(world, "pinned_progress", { ratio: gta.pinnedTicks / PIN_TICKS });
    const from = s.wantedLevel, dispatch = response.dispatch;
    const tracked = dispatch ? isDispatchTracked(response) : response.unitsInContact;
    if (dispatch && tracked) s.wantedLevel = gta.fadeStars;
    if (tracked) gta.heat += STEP / (13 + (s.wantedLevel - 1) * 2);
    if ((!dispatch || tracked) && gta.heat >= 1 && s.wantedLevel < gta.config.wantedLevelMax) {
      s.wantedLevel++;
      gta.heat -= 1;
      gta.lostTicks = 0;
      gta.fadeStars = s.wantedLevel;
      gta.nextDispatchTick = Math.min(gta.nextDispatchTick, world.tick);
      gta.nextRoadblockTick = Math.min(gta.nextRoadblockTick, world.tick);
    }
    if (s.wantedLevel === gta.config.wantedLevelMax) gta.heat = 0;
    if (dispatch) updateDispatchEscape(world, tracked);
    else if (response.unitsInContact) {
      gta.lostTicks = 0;
      gta.fadeStars = s.wantedLevel;
      response.clearProgress = 0;
    } else {
      gta.lostTicks++;
      const fading = Math.max(0, gta.lostTicks - LOST_GRACE_TICKS);
      if (fading) {
        s.wantedLevel = Math.max(0, gta.fadeStars - Math.floor(fading / FADE_TICKS2));
        response.stage = "clearing";
        if (s.wantedLevel < from) gta.heat = 0;
      } else response.stage = "search";
      response.clearProgress = clamp(fading / (FADE_TICKS2 * Math.max(1, gta.fadeStars)), 0, 1);
    }
    if (s.wantedLevel !== from) emitGtaEvent(world, "wanted_changed", { from, to: s.wantedLevel });
    if (player.health <= 0) s.phase = "wrecked";
    else if (gta.pinnedTicks >= PIN_TICKS) s.phase = "busted";
    else if (s.wantedLevel === 0) {
      s.phase = "escaped";
      metrics.escape = true;
      if (dispatch) dispatch.state = "ESCAPED";
    } else if (metrics.survivalS >= gta.config.episodeMaxSeconds) s.phase = "timeout";
  }

  // src/core/walk-route.js
  function pointSegment(px, pz, ax, az, dx, dz, lengthSquared) {
    const t = Math.max(
      0,
      Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSquared)
    );
    return Math.hypot(px - ax - dx * t, pz - az - dz * t);
  }
  function walkSegmentBlocker(person, a, b, obstacles, gap = 0.16, allowMarginExit = false) {
    const ax = a.x, az = a.z, bx = b.x, bz = b.z;
    const dx = bx - ax, dz = bz - az, lengthSquared = dx * dx + dz * dz || 1;
    const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
    const minZ = Math.min(az, bz), maxZ = Math.max(az, bz);
    const padding = person.radius + gap;
    const exitsMargin = (start, end, clearance, physical) => allowMarginExit && clearance >= physical - CIRCULAR_CONTACT_TOLERANCE_M && end > start + 1e-7 && clearance >= start - 1e-7;
    for (const item of obstacles) {
      if (item.id === person.id) continue;
      const x = item.x, z = item.z;
      if (item.type === "pedestrian") {
        const clearance2 = person.radius + item.radius + gap;
        if (x < minX - clearance2 - 1e-7 || x > maxX + clearance2 + 1e-7 || z < minZ - clearance2 - 1e-7 || z > maxZ + clearance2 + 1e-7) continue;
        const closest = pointSegment(x, z, ax, az, dx, dz, lengthSquared);
        if (closest < clearance2 && !exitsMargin(
          Math.hypot(ax - x, az - z),
          Math.hypot(bx - x, bz - z),
          closest,
          person.radius + item.radius
        )) return item;
        continue;
      }
      const hw = item.width / 2, hl = item.length / 2;
      const reach = Math.abs(hw) + Math.abs(hl) + Math.max(0, padding) + 1e-7;
      if (x < minX - reach || x > maxX + reach || z < minZ - reach || z > maxZ + reach)
        continue;
      const c = Math.cos(item.heading ?? 0), s = Math.sin(item.heading ?? 0);
      const sx = (ax - x) * c - (az - z) * s, sz = (ax - x) * s + (az - z) * c;
      const ex = (bx - x) * c - (bz - z) * s, ez = (bx - x) * s + (bz - z) * c;
      const lx = ex - sx, lz = ez - sz;
      let low = 0, high = 1;
      if (Math.abs(lx) < 1e-10) {
        if (Math.abs(sx) > hw) low = 2;
      } else {
        const t1 = (-hw - sx) / lx, t2 = (hw - sx) / lx;
        low = Math.max(low, Math.min(t1, t2));
        high = Math.min(high, Math.max(t1, t2));
      }
      if (Math.abs(lz) < 1e-10) {
        if (Math.abs(sz) > hl) low = 2;
      } else {
        const t1 = (-hl - sz) / lz, t2 = (hl - sz) / lz;
        low = Math.max(low, Math.min(t1, t2));
        high = Math.min(high, Math.max(t1, t2));
      }
      if (low <= high) return item;
      const rectStart = Math.hypot(Math.max(0, Math.abs(sx) - hw), Math.max(0, Math.abs(sz) - hl));
      const rectEnd = Math.hypot(Math.max(0, Math.abs(ex) - hw), Math.max(0, Math.abs(ez) - hl));
      const localLengthSquared = lx * lx + lz * lz || 1;
      const clearance = Math.min(
        rectStart,
        rectEnd,
        pointSegment(-hw, -hl, sx, sz, lx, lz, localLengthSquared),
        pointSegment(-hw, hl, sx, sz, lx, lz, localLengthSquared),
        pointSegment(hw, -hl, sx, sz, lx, lz, localLengthSquared),
        pointSegment(hw, hl, sx, sz, lx, lz, localLengthSquared)
      );
      if (clearance < padding - 1e-7 && !exitsMargin(rectStart, rectEnd, clearance, person.radius))
        return item;
    }
    return null;
  }
  function walkSegmentClear(person, a, b, obstacles, gap = 0.16, allowMarginExit = false) {
    return walkSegmentBlocker(person, a, b, obstacles, gap, allowMarginExit) === null;
  }
  function planWalk(person, target, obstacles, allowMarginExit = false) {
    if (walkSegmentClear(person, person, target, obstacles, 0.16, allowMarginExit)) return [target];
    const nodes = [person, target];
    for (const body of obstacles) {
      if (body.type === "pedestrian") continue;
      for (const point2 of corners(body, person.radius + 0.28)) {
        const pose5 = {
          type: person.type,
          radius: person.radius,
          heading: person.heading,
          length: person.length,
          width: person.width,
          x: point2.x,
          z: point2.z
        };
        if (!obstacles.some((a) => overlaps(pose5, a, 0.16)))
          nodes.push(point2);
      }
    }
    const costs = nodes.map(() => Infinity), parents = nodes.map(() => -1), open = /* @__PURE__ */ new Set([0]);
    costs[0] = 0;
    while (open.size) {
      const current = [...open].sort(
        (a, b) => costs[a] + distance(nodes[a], target) - costs[b] - distance(nodes[b], target) || a - b
      )[0];
      open.delete(current);
      if (current === 1) {
        const route = [];
        for (let i = 1; i > 0; i = parents[i])
          route.unshift({ x: nodes[i].x, z: nodes[i].z });
        return route;
      }
      for (let next = 1; next < nodes.length; next++) {
        const cost = costs[current] + distance(nodes[current], nodes[next]);
        if (cost >= costs[next] || !walkSegmentClear(person, nodes[current], nodes[next], obstacles, 0.16, current === 0 && allowMarginExit))
          continue;
        costs[next] = cost;
        parents[next] = current;
        open.add(next);
      }
    }
    return [];
  }
  function canLeaveWalkMargin(world, person) {
    return Boolean(world.pursuit?.response?.dispatch && person.district?.routeConstrained && !person.district?.caseId);
  }
  function walkingWaypoint(world, person, nearby) {
    const obstacles = nearby.filter(
      (a) => a.type !== "pedestrian" && (a.speed ?? 0) < 0.8
    );
    const pose5 = { ...person, ...person.target };
    if (obstacles.some((a) => overlaps(pose5, a, 0.2))) {
      for (const offset2 of [1.5, -1.5, 3, -3, 5, -5]) {
        const target = { ...person.target };
        target[person.road.axis === "z" ? "z" : "x"] += offset2;
        pose5.x = target.x;
        pose5.z = target.z;
        if (!obstacles.some((a) => overlaps(pose5, a, 0.3))) {
          person.target = target;
          person.walkRoute = null;
          break;
        }
      }
    }
    const goalKey = `${person.target.x},${person.target.z}`;
    if (person.walkGoal !== goalKey || !person.walkRoute || world.tick >= (person.walkPlanTick ?? 0) + 90) {
      const previous = person.walkRoute?.[0];
      if (person.walkGoal !== goalKey || !previous || !walkSegmentClear(person, person, previous, obstacles, 0.12))
        person.walkRoute = planWalk(person, person.target, obstacles);
      person.walkGoal = goalKey;
      person.walkPlanTick = world.tick;
    }
    while (person.walkRoute.length > 1 && distance(person, person.walkRoute[0]) < 0.25)
      person.walkRoute.shift();
    return person.walkRoute[0] ?? person.target;
  }

  // src/core/pedestrian-body.js
  var profiles = Object.freeze({
    "man-polo": { height: 1.78, width: 0.3222, depth: 0.2136, mass: 76 },
    "man-jacket": { height: 1.8, width: 0.3385, depth: 0.2304, mass: 79 },
    "woman-shirt": { height: 1.66, width: 0.2693, depth: 0.2169, mass: 63 },
    "woman-jacket": { height: 1.69, width: 0.2723, depth: 0.2042, mass: 66 }
  });
  var modes = /* @__PURE__ */ new Set(["ambient", "walk", "jog", "stop"]);
  var finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  function createPedestrianBody(actor = {}) {
    const person = actor ?? {};
    const kind = typeof person.kind === "string" ? person.kind : "";
    const female = /^(woman|female)-/.test(kind);
    const profile = Object.hasOwn(profiles, kind) ? profiles[kind] : profiles[female ? "woman-shirt" : "man-polo"];
    const variation = clamp(finite(person.phase, 0.5), 0, 1) - 0.5;
    const heightM = profile.height + variation * 0.14;
    const widthM = heightM * profile.width;
    const depthM = heightM * profile.depth;
    const walkSpeedMps = clamp(finite(person.walkSpeed, 1.35), 0.6, 2.4);
    return Object.freeze({
      heightM,
      widthM,
      depthM,
      massKg: profile.mass * (heightM / profile.height) ** 3,
      // The circle encloses the neutral clothed body, not an extended arm pose.
      radiusM: Math.max(0.3, Math.hypot(widthM, depthM) / 2),
      walkSpeedMps,
      jogSpeedMps: clamp(walkSpeedMps * 1.8, 2, 3.2),
      maxAccelerationMps2: 2.5,
      maxDecelerationMps2: 3.5,
      maxTurnRateRadS: 3
    });
  }
  function setPedestrianMotionMode(actor, mode) {
    if (!actor || actor.type !== "pedestrian" || actor.script?.type === "vision-linear" || !modes.has(mode))
      return false;
    actor.motionMode = mode;
    return true;
  }

  // src/core/pedestrian.js
  var WALK_TURNS = [0, -0.5, 0.5, -1, 1, -1.6, 1.6, -2.2, 2.2, Math.PI];
  var pose = (road4, along2, side, offset2) => road4.axis === "z" ? { x: road4.fixed - side * offset2, z: along2 } : { x: along2, z: road4.fixed + side * offset2 };
  function nextWalk(world, person) {
    person.walkRoute = null;
    const road4 = person.road;
    person.walkDirection ??= person.phase < 0.5 ? -1 : 1;
    const crossing3 = world.rng.next() < 0.15 + world.config.chaos * 0.3;
    if (crossing3) {
      person.target = pose(
        road4,
        person.along,
        -person.side,
        road4.width / 2 + 1.25
      );
      person.crossing = true;
      person.pause = world.rng.range(0.4, 1.4);
    } else {
      const min = road4.min + 6, max = road4.max - 6;
      if (person.walkDirection > 0 && max - person.along < 5 || person.walkDirection < 0 && person.along - min < 5)
        person.walkDirection *= -1;
      const stride = world.rng.range(18, 42);
      let next = clamp(person.along + stride * person.walkDirection, min, max);
      if (Math.abs(next - person.along) < 3) {
        person.walkDirection *= -1;
        next = clamp(person.along + stride * person.walkDirection, min, max);
      }
      person.target = pose(road4, next, person.side, road4.width / 2 + 1.25);
      person.crossing = false;
      person.pause = world.rng.next() < 0.1 ? world.rng.range(0.4, 1.2) : 0;
    }
  }
  function nearbyBodies(world, p) {
    const nearby = world.actorIndex.near(p, 28);
    const self2 = nearby.indexOf(p);
    if (self2 !== -1) nearby.splice(self2, 1);
    for (const body of world.staticIndex.near(p, 34)) nearby.push(body);
    return nearby;
  }
  function move(world, p, body, heading2, targetSpeed, reason, nearby, district, reuseProposal) {
    const speed = clamp(
      targetSpeed,
      Math.max(0, p.speed - body.maxDecelerationMps2 * STEP),
      p.speed + body.maxAccelerationMps2 * STEP
    );
    const x = p.x + Math.sin(heading2) * speed * STEP;
    const z = p.z + Math.cos(heading2) * speed * STEP;
    const oldSpeed = p.speed;
    const turnRateRadS = angleDelta(heading2, p.heading) / STEP;
    const blocker = speed > 0 ? walkSegmentBlocker(p, p, { x, z }, nearby ?? nearbyBodies(world, p), 0.12, canLeaveWalkMargin(world, p)) : null;
    const next = reuseProposal ? p : { ...p };
    if (!blocker) {
      next.x = x;
      next.z = z;
    }
    next.heading = heading2;
    next.speed = blocker ? 0 : speed;
    next.accelerationMps2 = blocker ? -oldSpeed / STEP : (speed - oldSpeed) / STEP;
    next.turnRateRadS = turnRateRadS;
    next.reason = blocker ? "blocked" : reason;
    if (district) next.blockedBy = blocker?.id ?? null;
    return next;
  }
  function pedestrianMotion(world, p, reuseProposal = false) {
    const district = world.environment === "egypt" || world.environment === "metro";
    const metro = world.environment === "metro";
    const body = p.body ??= createPedestrianBody(p);
    const stop = (reason) => move(world, p, body, p.heading, 0, reason, null, district, reuseProposal);
    if (p.motionMode === "stop")
      return stop(p.speed > 0 ? "stopping" : "stopped");
    if (p.pause > 0) {
      if (p.speed === 0) p.pause = Math.max(0, p.pause - STEP);
      return stop("waiting");
    }
    let remaining = distance(p, p.target);
    if (district && p.district?.holdAtTarget && remaining < Math.max(
      0.22,
      p.speed ** 2 / (2 * body.maxDecelerationMps2) + p.speed * STEP + 0.04
    ))
      return stop("district-target");
    if (remaining < 0.22) {
      if (p.crossing) p.side = -p.side;
      p.along = p.road.axis === "z" ? p.z : p.x;
      world.nextWalk(p);
      if (p.pause > 0) return stop("waiting");
      remaining = distance(p, p.target);
      if (remaining < 0.22) return stop("waiting");
    }
    const curbTarget = metro && p.walkRoute?.[0] ? p.walkRoute[0] : p.target;
    const curbDistance = Math.max(1e-3, curbTarget === p.target ? remaining : distance(p, curbTarget));
    const approach2 = Math.min(
      metro ? curbDistance : remaining,
      Math.max(
        1,
        p.speed ** 2 / (2 * body.maxDecelerationMps2) + p.speed * STEP + p.radius + 0.1
      )
    );
    if (!(district && p.district?.yieldAtCurb === false) && !pointOnRoad(p, world.roads) && pointOnRoad(
      {
        x: p.x + (curbTarget.x - p.x) / (metro ? curbDistance : remaining) * approach2,
        z: p.z + (curbTarget.z - p.z) / (metro ? curbDistance : remaining) * approach2
      },
      world.roads
    )) {
      const danger = world.actors.some(
        (a) => a.type === "vehicle" && a.speed > 0.4 && distance(p, a) < Math.max(5, a.speed * 2.2) && (p.x - a.x) * Math.sin(a.heading) + (p.z - a.z) * Math.cos(a.heading) > -2
      );
      if (danger) return stop("looking");
    }
    const nearby = nearbyBodies(world, p);
    const waypoint = district && p.district?.routeConstrained ? p.walkRoute?.[0] ?? p.target : walkingWaypoint(world, p, nearby);
    const desired = Math.atan2(waypoint.x - p.x, waypoint.z - p.z);
    const close = nearby.filter((a) => {
      const range = a.type === "static" ? 10 : 5;
      const dx = a.x - p.x, dz = a.z - p.z;
      return Math.abs(dx) <= range && Math.abs(dz) <= range && Math.hypot(dx, dz) < range;
    });
    let targetHeading = desired, best = Infinity;
    const probeLength = Math.min(0.95, distance(p, waypoint));
    const previousHeading = p.walkHeading ?? p.heading;
    const probe = { x: 0, z: 0 };
    const allowMarginExit = canLeaveWalkMargin(world, p);
    for (const turn2 of WALK_TURNS) {
      const heading3 = desired + turn2;
      probe.x = p.x + Math.sin(heading3) * probeLength;
      probe.z = p.z + Math.cos(heading3) * probeLength;
      const partialScore = distance(probe, waypoint) + Math.abs(turn2) * 0.08 + (turn2 > 0 ? 0.03 : 0);
      if (partialScore >= best) continue;
      const score = partialScore + Math.abs(angleDelta(heading3, previousHeading)) * 0.24;
      if (score < best && !walkSegmentBlocker(p, p, probe, close, 0.12, allowMarginExit)) {
        best = score;
        targetHeading = heading3;
      }
    }
    if (best !== Infinity) p.walkHeading = targetHeading;
    const heading2 = p.heading + clamp(
      angleDelta(targetHeading, p.heading),
      -body.maxTurnRateRadS * STEP,
      body.maxTurnRateRadS * STEP
    );
    const turn = Math.abs(angleDelta(targetHeading, heading2));
    const walkingSpeed = clamp(
      Number.isFinite(p.walkSpeed) ? p.walkSpeed : body.walkSpeedMps,
      0,
      3.2
    );
    const requestedSpeed = p.motionMode === "jog" ? Math.max(walkingSpeed, body.jogSpeedMps) : walkingSpeed;
    const targetSpeed = best === Infinity ? 0 : requestedSpeed * Math.max(0, Math.cos(turn)) ** 3;
    return move(
      world,
      p,
      body,
      heading2,
      targetSpeed,
      best === Infinity ? "yielding" : p.crossing ? "crossing" : "walking",
      nearby,
      district,
      reuseProposal
    );
  }

  // src/core/signals.js
  function signalSpeedLimit(world, car) {
    if (world.environment === "egypt" || world.environment === "metro") return Infinity;
    if (car.reckless) return Infinity;
    let limit = Infinity;
    for (const junction of world.junctions) {
      if (Math.abs(junction.x) % 50 !== 0 || Math.abs(junction.z) % 20 !== 0)
        continue;
      const dx = junction.x - car.x, dz = junction.z - car.z;
      const forward2 = dx * Math.sin(car.heading) + dz * Math.cos(car.heading);
      const lateral2 = Math.abs(
        dx * Math.cos(car.heading) - dz * Math.sin(car.heading)
      );
      if (forward2 < 6 || forward2 > 24 || lateral2 > 3.7) continue;
      const vertical = Math.abs(Math.cos(car.heading)) > 0.75;
      const phase = world.tick * STEP % 24;
      const green = vertical ? phase < 10 : phase >= 12 && phase < 22;
      if (!green)
        limit = Math.min(limit, Math.sqrt(Math.max(0, forward2 - 7) * 5));
    }
    return limit;
  }

  // src/core/junctions.js
  function junctionGroups(junctions) {
    const remaining = new Set(junctions), groups = [];
    while (remaining.size) {
      const members = [remaining.values().next().value];
      remaining.delete(members[0]);
      for (let i = 0; i < members.length; i++)
        for (const node of remaining) {
          if (distance(members[i], node) < 24) {
            members.push(node);
            remaining.delete(node);
          }
        }
      groups.push({
        key: members.map((n) => n.key).sort().join("|"),
        members,
        minX: Math.min(...members.map((n) => n.x)) - 8.4,
        maxX: Math.max(...members.map((n) => n.x)) + 8.4,
        minZ: Math.min(...members.map((n) => n.z)) - 8.4,
        maxZ: Math.max(...members.map((n) => n.z)) + 8.4
      });
    }
    return groups;
  }
  function insideJunction(car, group, margin = 0) {
    return car.x >= group.minX - margin && car.x <= group.maxX + margin && car.z >= group.minZ - margin && car.z <= group.maxZ + margin;
  }
  function entryDistance(car, group) {
    let near = 0, far = Infinity;
    for (const [axis, velocity, min, max] of [
      ["x", Math.sin(car.heading), group.minX, group.maxX],
      ["z", Math.cos(car.heading), group.minZ, group.maxZ]
    ]) {
      if (Math.abs(velocity) < 1e-6) {
        if (car[axis] < min || car[axis] > max) return Infinity;
      } else {
        const a = (min - car[axis]) / velocity, b = (max - car[axis]) / velocity;
        near = Math.max(near, Math.min(a, b));
        far = Math.min(far, Math.max(a, b));
      }
    }
    return near <= far && far >= 0 ? near : Infinity;
  }
  function corridor(world, car, group) {
    world.junctionCorridors ??= /* @__PURE__ */ new Map();
    const key3 = `${group.key}:${car.id}`;
    const cached = world.junctionCorridors.get(key3);
    if (cached?.path === car.path) return cached.samples;
    const samples = [];
    const path = car.path.length ? car.path.slice(Math.max(0, car.cursor - 2)) : Array.from({ length: 45 }, (_, i) => ({
      x: car.x + Math.sin(car.heading) * i * 2,
      z: car.z + Math.cos(car.heading) * i * 2
    }));
    let entered = false, last = null;
    for (let i = 0; i < path.length; i++) {
      const point2 = path[i];
      if (!insideJunction(point2, group, 3)) {
        if (entered) break;
        else continue;
      }
      entered = true;
      if (last && distance(last, point2) < 1.5 && i < path.length - 1) continue;
      const next = path[Math.min(i + 1, path.length - 1)], before = path[Math.max(0, i - 1)];
      const heading2 = Math.atan2(next.x - before.x, next.z - before.z);
      samples.push({
        type: "vehicle",
        ...point2,
        heading: heading2,
        width: car.width + 0.35,
        length: car.length + 2
      });
      last = point2;
    }
    world.junctionCorridors.set(key3, { path: car.path, samples });
    return samples;
  }
  var conflictCache = /* @__PURE__ */ new WeakMap();
  function conflicts(a, b) {
    let cache = conflictCache.get(a);
    if (!cache) {
      cache = /* @__PURE__ */ new WeakMap();
      conflictCache.set(a, cache);
    }
    if (!cache.has(b))
      cache.set(
        b,
        a.some((p) => b.some((q) => overlaps(p, q)))
      );
    return cache.get(b);
  }
  function sameLane(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    return Math.abs(angleDelta(a.heading, b.heading)) < 0.16 && Math.abs(dx * Math.cos(a.heading) - dz * Math.sin(a.heading)) < 1.25;
  }
  function aheadOfQueuedOwner(car, owner, group) {
    if (insideJunction(owner, group)) return false;
    const heading2 = Math.round(owner.heading / (Math.PI / 2)) * (Math.PI / 2), dx = car.x - owner.x, dz = car.z - owner.z;
    return Math.abs(angleDelta(car.heading, owner.heading)) < 0.4 && Math.abs(angleDelta(car.heading, heading2)) < 0.4 && Math.abs(angleDelta(owner.heading, heading2)) < 0.4 && Math.abs(dx * Math.cos(heading2) - dz * Math.sin(heading2)) < 1.25 && dx * Math.sin(heading2) + dz * Math.cos(heading2) > 2;
  }
  function junctionLimit(world, car) {
    let limit = Infinity, blockedBy = null;
    for (const group of world.junctionGroups) {
      const owners = world.junctionOwners.get(group.key) ?? [];
      if (owners.some((owner) => owner.id === car.id)) continue;
      const entry = entryDistance(car, group);
      if (entry > 24) continue;
      const speed = Math.sqrt(Math.max(0, entry - 0.3) * 4);
      if (speed < limit) {
        limit = speed;
        blockedBy = owners[0]?.id ?? null;
      }
    }
    return { limit, blockedBy };
  }
  function updateJunctions(world) {
    const cars = world.actors.filter((a) => a.type === "vehicle"), approaches = /* @__PURE__ */ new Map();
    for (const car of cars) {
      let closest = null, best = 24;
      for (const group of world.junctionGroups) {
        const d = entryDistance(car, group);
        if (d < best) {
          closest = group;
          best = d;
        }
      }
      if (car.queuedJunction !== closest?.key) {
        car.queuedJunction = closest?.key ?? null;
        car.junctionArrival = world.tick;
      }
      if (closest) approaches.set(car.id, { group: closest, distance: best });
    }
    for (const group of world.junctionGroups) {
      const owners = world.junctionOwners.get(group.key) ?? [];
      const retained = owners.filter((owner) => {
        const car = cars.find((a) => a.id === owner.id);
        if (!car) return false;
        if (insideJunction(car, group)) owner.entered = true;
        const cleared = owner.entered && !insideJunction(car, group, car.length / 2 + 0.15);
        const parked = !car.path.length || car.speed < 0.05 && signalSpeedLimit(world, car) < Infinity || car === world.player && world.mode === "manual" && world.input.targetSpeed === 0 && car.speed === 0;
        const retain = !cleared && !parked && (owner.entered || entryDistance(car, group) < 26);
        if (!retain) world.junctionCorridors?.delete(`${group.key}:${car.id}`);
        return retain;
      });
      if (retained.length) world.junctionOwners.set(group.key, retained);
      else world.junctionOwners.delete(group.key);
    }
    const holding = new Set(
      [...world.junctionOwners.values()].flat().map((o) => o.id)
    );
    for (const group of world.junctionGroups) {
      const owners = world.junctionOwners.get(group.key) ?? [];
      const candidates2 = cars.filter(
        (a) => !holding.has(a.id) && (a.path.length || a === world.player && world.input.targetSpeed > 0) && approaches.get(a.id)?.group === group && signalSpeedLimit(world, a) === Infinity
      );
      const fronts = /* @__PURE__ */ new Map();
      for (const candidate of candidates2) {
        const direction3 = (Math.round(candidate.heading / (Math.PI / 2)) % 4 + 4) % 4;
        const lane2 = Math.round(
          (direction3 % 2 === 0 ? candidate.x : candidate.z) / 10
        );
        const approachKey = `${direction3}:${lane2}`;
        const prior = fronts.get(approachKey);
        if (!prior || approaches.get(candidate.id).distance < approaches.get(prior.id).distance)
          fronts.set(approachKey, candidate);
      }
      const waiting = [...fronts.values()].sort(
        (a, b) => a.junctionArrival - b.junctionArrival || a.id.localeCompare(b.id)
      );
      const earlier = [];
      for (const car of waiting) {
        const path = corridor(world, car, group);
        if (!path.length) continue;
        const blocked = owners.some((o) => {
          const owner = cars.find((a) => a.id === o.id);
          return !sameLane(car, owner) && !aheadOfQueuedOwner(car, owner, group) && conflicts(path, corridor(world, owner, group));
        }) || earlier.some(
          (entry) => !sameLane(car, entry.car) && conflicts(path, entry.path)
        );
        earlier.push({ car, path });
        if (blocked) continue;
        owners.push({
          id: car.id,
          entered: insideJunction(car, group),
          since: world.tick
        });
        holding.add(car.id);
      }
      if (owners.length) world.junctionOwners.set(group.key, owners);
    }
  }

  // src/core/pursuit-survival.js
  var ticks = (seconds2) => Math.round(seconds2 / STEP);
  var POWERS = ["giant", "mine", "ghost", "pulse"];
  var GIANT_SCALE = 1.45;
  var SURVIVAL_GIANT_PHYSICS = "scaled-v1";
  var SURVIVAL_REVIEW_TICKS = ticks(0.46);
  var isSurvival = (variant) => variant === "survival";
  var isCityHunt = (variant) => variant === "hunt" || isSurvival(variant);
  function createSurvival(player, tick, giantPhysics) {
    if (giantPhysics !== void 0 && giantPhysics !== SURVIVAL_GIANT_PHYSICS)
      throw new RangeError("Unsupported Giant physics profile");
    return {
      footprint: { length: player.length, width: player.width },
      giantBase: giantPhysics ? { height: player.height, spec: player.spec } : null,
      active: null,
      held: null,
      pickup: null,
      devices: [],
      wrecks: /* @__PURE__ */ new Map(),
      pendingWrecks: /* @__PURE__ */ new Map(),
      effects: [],
      nextEffect: 0,
      nextPower: 0,
      nextPickupTick: tick,
      spawnCount: 0,
      heavyCount: 0,
      fireQueued: false,
      lastSolid: null
    };
  }
  function setSurvivalShape(player, survival, footprint, giant = false) {
    player.length = footprint.length;
    player.width = footprint.width;
    const base = survival.giantBase;
    if (!base) return;
    if (giant) {
      player.giantScale = GIANT_SCALE;
      player.height = base.height * GIANT_SCALE;
      player.spec = {
        ...base.spec,
        wheelbase: (base.spec?.wheelbase ?? VEHICLE.wheelbase) * GIANT_SCALE,
        acceleration: (base.spec?.acceleration ?? VEHICLE.acceleration) * 0.8
      };
    } else if (player.giantScale) {
      player.height = base.height;
      player.spec = base.spec;
      delete player.giantScale;
    }
  }
  function emitSurvival(world, type, at, kind, extra) {
    const { survival } = world.pursuit;
    survival.effects.push({
      id: ++survival.nextEffect,
      tick: world.tick,
      x: at.x,
      z: at.z,
      type,
      kind,
      ...extra
    });
    if (survival.effects.length > 48) survival.effects.shift();
  }
  var token = (x, z, radius) => ({ type: "pedestrian", x, z, radius });
  function isPhaseable(body) {
    return body.type === "vehicle" || body.kind === "barrier" || body.kind === "parked-vehicle";
  }
  function survivalGhostPair(world, a, b) {
    if (world.pursuit?.survival?.active?.kind !== "ghost") return false;
    const { player } = world;
    return a === player ? isPhaseable(b) : b === player && isPhaseable(a);
  }
  function fits(world, candidate, ignore = () => false) {
    return bodyOnRoad(candidate, world.roads) && !world.statics.some((body) => !ignore(body) && overlaps(candidate, body)) && !world.actors.some((body) => body !== world.player && !ignore(body) && overlaps(candidate, body));
  }
  function playerPose({ x, z, heading: heading2 }) {
    return { x, z, heading: heading2 };
  }
  function canEndSurvival(world) {
    const { survival } = world.pursuit;
    return survival.active?.kind !== "ghost" || fits(world, world.player, (actor) => world.pursuit.patrols.has(actor) || survival.wrecks.has(actor));
  }
  function releaseSurvival(world) {
    const { player, pursuit } = world, { survival } = pursuit;
    if (survival.active?.kind === "ghost" && !canEndSurvival(world)) {
      const ignore = (actor) => pursuit.patrols.has(actor) || survival.wrecks.has(actor);
      const origin = playerPose(player);
      const choices = survival.lastSolid ? [survival.lastSolid] : [];
      for (const metres of [1, 2, 3.5, 5, 7.5, 10, 14]) for (let i = 0; i < 12; i++) {
        const bearing = player.heading + i * Math.PI / 6;
        choices.push({ ...origin, x: origin.x + Math.sin(bearing) * metres, z: origin.z + Math.cos(bearing) * metres });
      }
      const clear = choices.find((pose5) => fits(world, { ...player, ...pose5 }, ignore));
      if (!clear) return false;
      Object.assign(player, clear, { previous: { ...player.previous, ...clear }, speed: 0, arcadeSlip: 0 });
    }
    setSurvivalShape(player, survival, survival.footprint);
    player.arcadeSlip = 0;
    survival.active = survival.held = survival.pickup = null;
    survival.devices.length = 0;
    survival.fireQueued = false;
    return true;
  }
  function updateSurvivalBeforeMotion(world) {
    const { pursuit: s, player, tick } = world, a = s.survival;
    for (const [body, until] of a.wrecks) {
      if (tick < until && distance(body, player) < 70) continue;
      removeActor(world, body);
      a.wrecks.delete(body);
    }
    const power = a.active;
    if (power && tick >= power.until && (power.kind !== "ghost" || fits(world, player))) {
      setSurvivalShape(player, a, a.footprint);
      a.active = null;
    }
    if (!a.fireQueued) return;
    a.fireQueued = false;
    if (!a.held) return;
    const kind = a.held, behind = kind === "mine", heading2 = player.heading;
    const offset2 = (behind ? -1 : 1) * (player.length / 2 + 0.75);
    const x = player.x + Math.sin(heading2) * offset2, z = player.z + Math.cos(heading2) * offset2;
    a.held = null;
    a.devices.push({
      id: a.nextEffect + 1,
      kind,
      x,
      z,
      heading: heading2,
      armedAt: tick + (behind ? ticks(0.25) : 0),
      until: tick + ticks(behind ? 3.6 : 0.65)
    });
    emitSurvival(world, "use", { x, z }, kind);
  }
  function removeActor(world, actor) {
    const index = world.actors.indexOf(actor);
    if (index >= 0) world.actors.splice(index, 1);
  }
  function disableSurvivalPatrol(world, body, reason, erased = false) {
    const { pursuit, tick } = world, { survival: a } = pursuit;
    const active2 = pursuit.patrols.delete(body);
    if (!active2 && !a.wrecks.has(body)) return;
    if (erased) {
      a.wrecks.delete(body);
      removeActor(world, body);
    } else {
      a.wrecks.set(body, tick + ticks(4.5));
      body.pursuitWreck = true;
      body.speed = 0;
      body.path = [];
      body.cursor = 0;
      body.reason = "wreck";
    }
    emitSurvival(world, "wreck", body, body.pursuitUnit ?? "cruiser", { reason, actorId: body.id });
  }
  function useDevices(world) {
    const { pursuit, tick } = world, { survival: a } = pursuit;
    for (let i = a.devices.length - 1; i >= 0; i--) {
      const device = a.devices[i], pulse = device.kind === "pulse";
      if (tick >= device.until) {
        a.devices.splice(i, 1);
        continue;
      }
      if (tick < device.armedAt) continue;
      const x = device.x, z = device.z;
      const distanceM = pulse ? 31 * STEP : 0;
      let hit = null, blocked = false;
      for (const fraction of pulse ? [0, 0.5, 1] : [1]) {
        device.x = x + Math.sin(device.heading) * distanceM * fraction;
        device.z = z + Math.cos(device.heading) * distanceM * fraction;
        const shape2 = token(device.x, device.z, pulse ? 0.52 : 1.6);
        blocked = pulse && (!pointOnRoad(shape2, world.roads, 0.18) || world.staticIndex.near(shape2, 16).some((body) => overlaps(shape2, body)));
        if (blocked) break;
        for (const car of pursuit.patrols) if (overlaps(shape2, car)) {
          hit = car;
          break;
        }
        if (hit) break;
      }
      if (hit) disableSurvivalPatrol(world, hit, device.kind);
      if (hit || blocked) {
        a.devices.splice(i, 1);
        emitSurvival(world, "burst", device, device.kind);
      }
    }
  }
  function dropPickup(world) {
    const { tick, player, pursuit: s } = world, a = s.survival;
    if (a.pickup && (tick >= a.pickup.until || distance(player, a.pickup) > 40)) {
      a.pickup = null;
      a.nextPickupTick = tick + ticks(1.5);
    }
    if (a.pickup || tick < a.nextPickupTick) return;
    const sx = Math.sin(player.heading), sz = Math.cos(player.heading);
    const ahead = (d) => ({ x: player.x + sx * d, z: player.z + sz * d, heading: player.heading });
    const free = (p) => {
      const shape2 = token(p.x, p.z, 1.05);
      return bodyOnRoad({ ...p, width: 2.15, length: 1.8 }, world.drivingRoads) && !world.statics.some((body) => overlaps(shape2, body, 0.25)) && !world.actors.some((body) => overlaps(shape2, body, 0.8));
    };
    const straight = [12, 16, 9, 20].map(ahead);
    const path = player.path.slice(player.cursor).filter((p) => distance(p, player) >= 8 && distance(p, player) <= 23 && (p.x - player.x) * sx + (p.z - player.z) * sz > 3);
    const spot = straight.find(free) ?? path.find(free);
    if (spot) a.pickup = { x: spot.x, z: spot.z, kind: POWERS[a.nextPower++ % POWERS.length], until: tick + ticks(11) };
    else a.nextPickupTick = tick + ticks(0.75);
  }
  function updateSurvivalAfterMotion(world) {
    const { player, pursuit: s, tick } = world, a = s.survival;
    for (const [actor, crash] of a.pendingWrecks) disableSurvivalPatrol(world, actor, crash.reason, crash.erased);
    a.pendingWrecks.clear();
    if (s.metrics.terminalCause) return;
    useDevices(world);
    const pickup = a.pickup;
    if (pickup && overlaps(player, token(pickup.x, pickup.z, 0.9))) {
      const { kind } = pickup, charge = kind === "mine" || kind === "pulse";
      const giant = { ...player, length: a.footprint.length * GIANT_SCALE, width: a.footprint.width * GIANT_SCALE };
      if (!(charge && a.held) && !(kind === "giant" && !fits(world, giant)) && !(a.active?.kind === "ghost" && kind === "giant" && !fits(world, player))) {
        if (charge) a.held = kind;
        else {
          a.active = { kind, until: tick + ticks(kind === "ghost" ? 4.25 : 3.55) };
          setSurvivalShape(player, a, kind === "giant" ? giant : a.footprint, kind === "giant");
        }
        emitSurvival(world, "pickup", pickup, kind);
        a.pickup = null;
        a.nextPickupTick = tick + ticks(2.6);
      }
    }
    if (a.active?.kind === "ghost" && fits(world, player)) a.lastSolid = playerPose(player);
    dropPickup(world);
  }
  function survivalSnapshot(state, tick) {
    const a = state.survival;
    return {
      active: a.active && { kind: a.active.kind, timeLeftS: Math.max(0, (a.active.until - tick) * STEP) },
      held: a.held,
      spawned: a.spawnCount,
      wrecks: a.wrecks.size,
      heavy: a.heavyCount,
      impact: state.metrics.terminalCause,
      review: state.reviewUntilTick > tick
    };
  }

  // src/core/traffic-control.js
  function safeSpeed(world, car, command, usePlannedPath = true) {
    const district = world.environment === "egypt" || world.environment === "metro";
    let speed = command.targetSpeed, reason = district ? command.reason ?? (speed > 0 ? "driving" : "idle") : speed > 0 ? "driving" : "idle", blockedBy = district ? command.blockedBy ?? null : null;
    const softStop = district && speed === 0 && car.speed > 0 && Number.isFinite(command.decelerationMps2) && command.decelerationMps2 > 0 && command.decelerationMps2 < VEHICLE.braking;
    const survival = world.pursuit?.phase === "running" ? world.pursuit.survival : null;
    const manual = survival && car === world.player && world.mode === "manual" && speed >= 0;
    const giant = survival?.active?.kind === "giant" && car === world.player && speed >= 0;
    function danger(body) {
      if (body === car || survival && survivalGhostPair(world, car, body)) return false;
      if ((manual || giant) && (body.pursuitWreck || world.pursuit.patrols.has(body))) return false;
      return !manual || body.type !== "static";
    }
    if (speed < 0 && car === world.player && world.pursuit?.phase === "running" && isCityHunt(world.pursuit.variant)) {
      const probe2 = vehicleProbe(car, -Math.max(1.2, -car.speed));
      const horizon2 = 1.1 + probe2.speed ** 2 / (2 * VEHICLE.braking);
      const bodies = world.actorIndex.near(car, horizon2 + 6).concat(world.staticIndex.near(car, horizon2 + 14)).filter(danger);
      const backwards = { steer: command.steer, targetSpeed: probe2.speed };
      for (let travel2 = 0; travel2 < horizon2; ) {
        const { x, z } = probe2;
        integrateVehicle(probe2, backwards, 0.1, probe2);
        travel2 += Math.hypot(probe2.x - x, probe2.z - z);
        const blocker = bodies.find((body) => overlaps(probe2, body, 0.12) && !overlaps(car, body) && Math.hypot(probe2.x - body.x, probe2.z - body.z) < Math.hypot(car.x - body.x, car.z - body.z));
        if (blocker) {
          return {
            ...command,
            targetSpeed: -Math.min(-speed, Math.sqrt(7 * Math.max(0, travel2 - 0.45))),
            reason: "yielding",
            blockedBy: blocker.id
          };
        }
      }
      return { ...command, reason: command.reason ?? "reversing" };
    }
    let physicalStop = false;
    if (speed <= 0 && !softStop) return { ...command, reason };
    const probe = vehicleProbe(car, Math.max(1.2, Math.abs(car.speed)));
    const horizon = Math.max(
      5,
      car.speed * car.speed / (2 * VEHICLE.braking) + car.speed * 0.55 + 2
    );
    let travelled = 0;
    const nearby = world.actorIndex.near(car, horizon + 8).concat(world.staticIndex.near(car, horizon + 10)).filter(danger);
    let probeCursor = car.cursor;
    const probeCommand = { steer: 0, targetSpeed: 0, arcadeDrift: command.arcadeDrift };
    for (let i = 0; i < 45 && travelled < horizon; i++) {
      const prediction = usePlannedPath && car.path.length ? followPath(probe, car.path, probeCursor, true) : command;
      probeCursor = prediction.cursor ?? probeCursor;
      const x = probe.x, z = probe.z;
      probeCommand.steer = prediction.steer;
      probeCommand.targetSpeed = probe.speed;
      integrateVehicle(probe, probeCommand, 0.16, probe);
      travelled += Math.hypot(x - probe.x, z - probe.z);
      const blocker = nearby.find((a) => overlaps(probe, a, 0.3));
      if (blocker) {
        const limit = Math.sqrt(Math.max(0, travelled - 0.5) * 2 * 3.5);
        const softStoppingDistance = softStop ? car.speed ** 2 / (2 * command.decelerationMps2) + car.speed * 0.16 + 0.5 : 0;
        if (!district || limit < speed || softStop && travelled <= softStoppingDistance) {
          speed = Math.min(speed, limit);
          reason = "yielding";
          blockedBy = blocker.id;
          physicalStop = softStop;
        }
        break;
      }
    }
    const junction = junctionLimit(world, car);
    if (junction.limit < speed || softStop && junction.limit < car.speed) {
      speed = Math.min(speed, junction.limit);
      reason = "junction";
      blockedBy = junction.blockedBy;
      physicalStop = softStop;
    }
    const signalCap = signalSpeedLimit(world, car);
    if (signalCap < speed || signalCap < Infinity && reason === "junction" && speed < 0.15 || softStop && signalCap < car.speed) {
      speed = Math.min(speed, signalCap);
      reason = "red-light";
      blockedBy = null;
      physicalStop = softStop;
    }
    const result = { ...command, targetSpeed: speed, reason, blockedBy };
    if (district && (speed < command.targetSpeed || physicalStop))
      delete result.decelerationMps2;
    return result;
  }

  // src/core/navigation.js
  var LANE_OFFSET = 1.65;
  var key = (p) => `${p.x.toFixed(4)},${p.z.toFixed(4)}`;
  var direction = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
  function createRoadGraph(roads) {
    const nodes = /* @__PURE__ */ new Map();
    const put = (p) => {
      const k = key(p);
      if (!nodes.has(k)) nodes.set(k, { ...p, key: k, edges: [] });
      return nodes.get(k);
    };
    for (const road4 of roads) {
      const values = /* @__PURE__ */ new Set([road4.min, road4.max]);
      for (let n = road4.min; n < road4.max; n += 10) values.add(n);
      for (const other of roads) {
        if (other.axis === road4.axis) continue;
        if (other.fixed >= road4.min && other.fixed <= road4.max && road4.fixed >= other.min && road4.fixed <= other.max)
          values.add(other.fixed);
      }
      let previous = null;
      for (const value of [...values].sort((a, b) => a - b)) {
        const node = put(
          road4.axis === "z" ? { x: road4.fixed, z: value } : { x: value, z: road4.fixed }
        );
        if (previous) {
          previous.edges.push(node.key);
          node.edges.push(previous.key);
        }
        previous = node;
      }
    }
    for (const node of nodes.values()) node.edges = [...new Set(node.edges)];
    return nodes;
  }
  function junctionPressure(groups, actors) {
    const costs = /* @__PURE__ */ new Map();
    for (const group of groups) {
      const queue = actors.filter(
        (actor) => actor.type === "vehicle" && actor.path?.length && actor.queuedJunction === group.key && actor.wait > 2
      );
      if (!queue.length) continue;
      const longest = Math.max(...queue.map((actor) => actor.wait));
      const penalty = Math.min(120, queue.length * 5 + longest * 0.8);
      for (const node of group.members)
        costs.set(node.key, Math.max(costs.get(node.key) ?? 0, penalty));
    }
    return costs;
  }
  function planNavigation(graph, body, goal, actors = [], pressure = null, initialTurnLimit = 0.5) {
    const all = [...graph.values()];
    const nearest2 = (p) => all.reduce((a, b) => distance(a, p) < distance(b, p) ? a : b);
    const start = nearest2(body), end = nearest2(goal);
    if (start === end && distance(body, goal) < 5) return [];
    const heading2 = Number.isFinite(body.heading) ? body.heading : 0;
    const initial = { node: start, heading: heading2, parent: null, cost: 0 };
    const open = [initial], best = /* @__PURE__ */ new Map();
    let found = null;
    while (open.length) {
      open.sort(
        (a, b) => a.cost + distance(a.node, end) - (b.cost + distance(b.node, end))
      );
      const current = open.shift();
      if (current.node === end && current.parent) {
        found = current;
        break;
      }
      for (const edge of current.node.edges) {
        const next = graph.get(edge), h = direction(current.node, next);
        const turn = Math.abs(angleDelta(h, current.heading));
        if (turn > Math.PI * 0.75 || !current.parent && turn > initialTurnLimit) continue;
        const mid = {
          x: (current.node.x + next.x) / 2,
          z: (current.node.z + next.z) / 2
        };
        const congestion = actors.filter(
          (actor) => actor.id !== body.id && actor.type !== "pedestrian" && distance(actor, mid) < 8
        ).length;
        const cost = current.cost + distance(current.node, next) * (1 + congestion * 0.8) + (pressure?.get(next.key) ?? 0) + (turn > 0.1 ? 3 : 0);
        const state = `${edge}:${Math.round(h * 100)}`;
        if (cost >= (best.get(state) ?? Infinity)) continue;
        best.set(state, cost);
        open.push({ node: next, heading: h, parent: current, cost });
      }
    }
    if (!found) return [];
    const points = [];
    for (let node = found; node; node = node.parent)
      points.push({ x: node.node.x, z: node.node.z });
    return lanePath(points.reverse());
  }
  function lanePath(points, offset2 = LANE_OFFSET) {
    if (points.length < 2) return [];
    const turns = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      if (Math.abs(
        angleDelta(
          direction(points[i], points[i + 1]),
          direction(points[i - 1], points[i])
        )
      ) > 0.01)
        turns.push(points[i]);
    }
    turns.push(points.at(-1));
    const normals = [];
    for (let i = 0; i < turns.length - 1; i++) {
      const length = distance(turns[i], turns[i + 1]);
      normals.push({
        x: (turns[i + 1].x - turns[i].x) / length,
        z: (turns[i + 1].z - turns[i].z) / length
      });
    }
    const shifted = turns.map((p, i) => {
      const a = normals[Math.max(0, i - 1)], b = normals[Math.min(i, normals.length - 1)];
      const count = i === 0 || i === turns.length - 1 ? 1 : 2;
      return {
        x: p.x - offset2 * (count === 1 ? b.z : a.z + b.z),
        z: p.z + offset2 * (count === 1 ? b.x : a.x + b.x)
      };
    });
    const path = [];
    const append2 = (p) => {
      const prev = path.at(-1);
      if (!prev) {
        path.push(p);
        return;
      }
      const length = distance(prev, p), count = Math.max(1, Math.ceil(length / 0.65));
      for (let i = 1; i <= count; i++)
        path.push({
          x: prev.x + (p.x - prev.x) * i / count,
          z: prev.z + (p.z - prev.z) * i / count
        });
    };
    append2(shifted[0]);
    for (let i = 1; i < shifted.length - 1; i++) {
      const p = shifted[i], a = normals[i - 1], b = normals[i];
      const radius = Math.min(
        4.2,
        distance(shifted[i - 1], p) * 0.45,
        distance(p, shifted[i + 1]) * 0.45
      );
      const start = { x: p.x - a.x * radius, z: p.z - a.z * radius };
      const end = { x: p.x + b.x * radius, z: p.z + b.z * radius };
      const center = { x: start.x + b.x * radius, z: start.z + b.z * radius };
      append2(start);
      const first = Math.atan2(start.z - center.z, start.x - center.x);
      const last = Math.atan2(end.z - center.z, end.x - center.x);
      const arc = angleDelta(last, first), steps = Math.ceil(radius * Math.abs(arc) / 0.5);
      for (let j = 1; j <= steps; j++)
        append2({
          x: center.x + Math.cos(first + arc * j / steps) * radius,
          z: center.z + Math.sin(first + arc * j / steps) * radius
        });
    }
    append2(shifted.at(-1));
    return path;
  }

  // src/core/vehicle-state.js
  var wheelNames = ["frontLeft", "frontRight", "rearLeft", "rearRight"];
  var damageSides = ["front", "rear", "left", "right"];
  var staticWheelLoad = PLAYER_VEHICLE.massKg * 9.81 / 4;
  var tau = Math.PI * 2;
  function createVehicleState() {
    return {
      wheelAngles: { frontLeft: 0, frontRight: 0 },
      wheelSpinRad: 0,
      steeringWheelRad: 0,
      suspension: {
        pitchRad: 0,
        rollRad: 0,
        heaveM: 0,
        pitchVelocityRadS: 0,
        rollVelocityRadS: 0,
        heaveVelocityMps: 0,
        wheelOffsetsM: Object.fromEntries(wheelNames.map((name) => [name, 0]))
      },
      wheelLoadsN: Object.fromEntries(
        wheelNames.map((name) => [name, staticWheelLoad])
      ),
      controls: { throttle: 0, brake: 0, gear: "N" },
      contact: null,
      damage: {
        front: 0,
        rear: 0,
        left: 0,
        right: 0,
        total: 0,
        impactCount: 0,
        lastImpact: null
      }
    };
  }
  function wheelAngles(steer) {
    if (Math.abs(steer) < 1e-10) return { frontLeft: 0, frontRight: 0 };
    const sign = Math.sign(steer);
    const radius = PLAYER_VEHICLE.wheelbaseM / Math.tan(Math.abs(steer));
    const inner = Math.atan(
      PLAYER_VEHICLE.wheelbaseM / (radius - PLAYER_VEHICLE.trackM / 2)
    );
    const outer = Math.atan(
      PLAYER_VEHICLE.wheelbaseM / (radius + PLAYER_VEHICLE.trackM / 2)
    );
    return sign > 0 ? { frontLeft: outer, frontRight: inner } : { frontLeft: -inner, frontRight: -outer };
  }
  function spring(value, velocity, target, frequency, limit, dt) {
    const displacement = value - target;
    const coefficient = velocity + frequency * displacement;
    const decay = Math.exp(-frequency * dt);
    const raw = target + (displacement + coefficient * dt) * decay;
    const result = clamp(raw, -limit, limit);
    const speed = result === raw ? (velocity - frequency * coefficient * dt) * decay : 0;
    return {
      value: Math.abs(result) < 1e-12 ? 0 : result,
      velocity: Math.abs(speed) < 1e-12 ? 0 : speed
    };
  }
  function dent(damage2, side, closingSpeedMps, energyJ, tick) {
    damage2[side] = clamp(damage2[side] + energyJ / 45e3, 0, 1);
    damage2.total = 1 - damageSides.reduce((p, part) => p * (1 - damage2[part]), 1);
    damage2.impactCount++;
    damage2.lastImpact = { side, closingSpeedMps, energyJ, tick };
  }
  function advanceVehicleState(before, after, command, dt, { tick = 0, contact = null, freshImpacts = null } = {}) {
    if (!Number.isFinite(dt) || dt <= 0)
      throw new RangeError("Vehicle state needs a positive fixed step");
    const previous = before.vehicle ?? createVehicleState();
    const steer = clamp(after.steer ?? 0, -PLAYER_VEHICLE.maxSteerRad, PLAYER_VEHICLE.maxSteerRad);
    const yaw = angleDelta(after.heading, before.heading);
    const heading2 = before.heading + yaw / 2;
    const dx = after.x - before.x;
    const dz = after.z - before.z;
    const forwardTravel = dx * Math.sin(heading2) + dz * Math.cos(heading2);
    const signedTravel = Math.hypot(dx, dz) * Math.sign(forwardTravel);
    const speed = after.speed ?? 0;
    const oldSpeed = before.speed ?? 0;
    const averageSpeed = (speed + oldSpeed) / 2;
    const acceleration = clamp((speed - oldSpeed) / dt, -9, 9);
    const lateral2 = clamp(averageSpeed * yaw / dt, -8, 8);
    const load = previous.suspension;
    const pitch = spring(
      load.pitchRad,
      load.pitchVelocityRadS,
      clamp(-acceleration * 8e-3, -0.06, 0.06),
      11,
      0.065,
      dt
    );
    const roll = spring(
      load.rollRad,
      load.rollVelocityRadS,
      clamp(lateral2 * 9e-3, -0.065, 0.065),
      10,
      0.07,
      dt
    );
    const heave = spring(
      load.heaveM,
      load.heaveVelocityMps,
      contact ? -0.035 : -Math.min(0.018, Math.abs(acceleration) * 12e-4 + Math.abs(lateral2) * 1e-3),
      13,
      0.04,
      dt
    );
    const wheelOffsetsM = {};
    const wheelLoadsN = {};
    const weight = PLAYER_VEHICLE.massKg * 9.81;
    const foreTransfer = PLAYER_VEHICLE.massKg * acceleration * PLAYER_VEHICLE.centerOfMassHeightM / (2 * PLAYER_VEHICLE.wheelbaseM);
    const sideTransfer = PLAYER_VEHICLE.massKg * lateral2 * PLAYER_VEHICLE.centerOfMassHeightM / (2 * PLAYER_VEHICLE.trackM);
    for (const name of wheelNames) {
      const front = name.startsWith("front");
      const left = name.endsWith("Left");
      const x = (left ? -1 : 1) * PLAYER_VEHICLE.trackM / 2;
      const z = (front ? 1 : -1) * PLAYER_VEHICLE.wheelbaseM / 2;
      wheelOffsetsM[name] = clamp(
        -heave.value + Math.sin(pitch.value) * z - Math.sin(roll.value) * x,
        -PLAYER_VEHICLE.suspensionTravelM,
        PLAYER_VEHICLE.suspensionTravelM
      );
      wheelLoadsN[name] = Math.max(
        weight * 0.02,
        staticWheelLoad + (front ? -foreTransfer : foreTransfer) + (left ? sideTransfer : -sideTransfer)
      );
    }
    const loadScale = weight / Object.values(wheelLoadsN).reduce((a, b) => a + b, 0);
    for (const name of wheelNames) wheelLoadsN[name] *= loadScale;
    const requested = Number.isFinite(command.targetSpeed) ? command.targetSpeed : 0;
    const reversing = oldSpeed * requested < 0;
    const slowing = Math.abs(requested) < Math.abs(oldSpeed) || reversing;
    const controls = {
      throttle: !contact && !slowing && Math.abs(requested) > Math.abs(oldSpeed) + 1e-8 ? 1 : 0,
      brake: contact || slowing && Math.abs(oldSpeed) > 1e-8 ? 1 : 0,
      gear: Math.abs(speed) > 1e-8 ? speed > 0 ? "D" : "R" : requested === 0 ? "N" : requested > 0 ? "D" : "R"
    };
    let latchedContact = previous.contact;
    if (latchedContact && Math.hypot(after.x - latchedContact.x, after.z - latchedContact.z) > 0.25)
      latchedContact = null;
    const damage2 = { ...previous.damage };
    if (freshImpacts) {
      for (const { side, closingSpeedMps, energyJ } of freshImpacts) {
        if (closingSpeedMps >= 0.35) dent(damage2, side, closingSpeedMps, energyJ, tick);
      }
    }
    if (contact) {
      const closingSpeedMps = Math.max(0, contact.closingSpeedMps);
      if (!freshImpacts && closingSpeedMps >= 0.35 && Math.abs(oldSpeed) >= 0.15 && contact.proposedTravelM > 1e-8 && latchedContact?.hitId !== contact.hitId && damageSides.includes(contact.side)) {
        const energyJ = 0.5 * PLAYER_VEHICLE.massKg * closingSpeedMps ** 2;
        dent(damage2, contact.side, closingSpeedMps, energyJ, tick);
      }
      latchedContact = {
        hitId: contact.hitId,
        x: after.x,
        z: after.z,
        tick
      };
    }
    return {
      wheelAngles: wheelAngles(steer),
      wheelSpinRad: (previous.wheelSpinRad + signedTravel / (PLAYER_VEHICLE.wheelRadiusM * (before.giantScale ?? 1))) % tau,
      steeringWheelRad: steer * PLAYER_VEHICLE.steeringRatio,
      suspension: {
        pitchRad: pitch.value,
        rollRad: roll.value,
        heaveM: heave.value,
        pitchVelocityRadS: pitch.velocity,
        rollVelocityRadS: roll.velocity,
        heaveVelocityMps: heave.velocity,
        wheelOffsetsM
      },
      wheelLoadsN,
      controls,
      contact: latchedContact,
      damage: damage2
    };
  }

  // src/core/roads.js
  var INNER_X = [-100, -70, -20, 20, 50, 100];
  var INNER_Z = [-100, -60, -20, 20, 70, 100];
  function roadLayout(extent2 = 100) {
    const outer = [];
    for (let n = 140; n <= extent2; n += 40) outer.push(-n, n);
    const xs = [.../* @__PURE__ */ new Set([...INNER_X, ...outer])].sort((a, b) => a - b);
    const zs = [.../* @__PURE__ */ new Set([...INNER_Z, ...outer])].sort((a, b) => a - b);
    const roads = [
      ...xs.flatMap(
        (x) => (x === -70 ? [
          { min: -extent2, max: -20 },
          { min: 20, max: extent2 }
        ] : [{ min: -extent2, max: extent2 }]).map((span2) => ({
          axis: "z",
          fixed: x,
          width: x === -70 ? 8 : 10,
          ...span2
        }))
      ),
      ...zs.flatMap(
        (z) => (z === -60 ? [
          { min: -extent2, max: -20 },
          { min: 20, max: extent2 }
        ] : z === 70 ? [
          { min: -extent2, max: 20 },
          { min: 50, max: extent2 }
        ] : [{ min: -extent2, max: extent2 }]).map((span2) => ({
          axis: "x",
          fixed: z,
          width: z === 70 ? 8 : 10,
          ...span2
        }))
      )
    ];
    if (extent2 >= 100)
      roads.push(
        {
          axis: "x",
          fixed: -80,
          min: -100,
          max: -20,
          width: 8,
          sideStreet: true
        },
        { axis: "x", fixed: 40, min: 20, max: 100, width: 8, sideStreet: true },
        { axis: "z", fixed: -40, min: -60, max: 20, width: 8, sideStreet: true },
        // This uneven local link breaks a long regular block. It is a real
        // two-way road in navigation and collision, with no lane paint.
        { axis: "z", fixed: 75, min: -60, max: 40, width: 8, sideStreet: true }
      );
    return { xs, zs, roads };
  }

  // src/core/places.js
  var PLACES = Object.freeze([
    { id: "downtown", name: "\u0648\u0633\u0637 \u0627\u0644\u0628\u0644\u062F", x: 20, z: 20 },
    { id: "market", name: "\u0627\u0644\u0633\u0648\u0642", x: -70, z: 20 },
    { id: "station", name: "\u0627\u0644\u0645\u062D\u0637\u0629", x: 50, z: -60 },
    { id: "hospital", name: "\u0627\u0644\u0645\u0633\u062A\u0634\u0641\u0649", x: -20, z: 70 },
    { id: "university", name: "\u0627\u0644\u062C\u0627\u0645\u0639\u0629", x: 100, z: 100 },
    { id: "corniche", name: "\u0627\u0644\u0643\u0648\u0631\u0646\u064A\u0634", x: -100, z: -60 }
  ]);
  var LAB_PLACES = Object.freeze([
    { id: "lab-north", name: "\u0634\u0645\u0627\u0644 \u0627\u0644\u0623\u0648\u0636\u0629", x: 20, z: 40 },
    { id: "lab-south", name: "\u062C\u0646\u0648\u0628 \u0627\u0644\u0623\u0648\u0636\u0629", x: -20, z: -40 }
  ]);

  // src/core/scenery.js
  function cityFootprints(roads) {
    const exclusions = roads.map((road4, i) => {
      const r = roadRect(road4, -2.7);
      return {
        id: `road-${i}`,
        x: (r.minX + r.maxX) / 2,
        z: (r.minZ + r.maxZ) / 2,
        width: r.maxX - r.minX,
        length: r.maxZ - r.minZ,
        heading: 0
      };
    });
    const sites2 = [];
    for (let x = -91; x < 100; x += 5)
      for (let z = -91; z < 100; z += 5) {
        const site = {
          id: `building-${sites2.length}`,
          type: "static",
          kind: "building",
          x,
          z,
          width: 8,
          length: 8,
          heading: 0,
          height: 10 + sites2.length % 4 * 3
        };
        if (!exclusions.some((road4) => overlaps(site, road4)) && !sites2.some((other) => overlaps(site, other, 1.5)))
          sites2.push(site);
      }
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
        height: 2.3
      };
      if (!exclusions.some((road4) => overlaps(stall, road4, 0.3)) && !sites2.some((site) => overlaps(stall, site, 0.4)))
        sites2.push(stall);
    }
    for (const place2 of PLACES) {
      const road4 = roads.find(
        (candidate) => candidate.axis === "x" && candidate.fixed === place2.z && candidate.min <= place2.x && candidate.max >= place2.x && !candidate.parkingBay
      );
      if (!road4) throw new Error(`No sign road for ${place2.id}`);
      const base = Math.max(road4.min + 6, Math.min(road4.max - 6, place2.x + 7));
      let placed = false;
      for (const setback of [3.2, 10]) {
        for (const side of [1, -1]) {
          for (const shift2 of [0, -7, 7, -14, 14]) {
            const post = {
              id: `place-sign-${place2.id}`,
              type: "static",
              kind: "place-sign",
              placeId: place2.id,
              x: Math.max(road4.min + 6, Math.min(road4.max - 6, base + shift2)),
              z: road4.fixed + side * (road4.width / 2 + setback),
              width: 0.28,
              length: 0.28,
              heading: 0,
              height: 3.8,
              facingY: side > 0 ? 3 * Math.PI / 4 : -Math.PI / 4
            };
            if (exclusions.some((exclusion) => overlaps(post, exclusion, 0.1)) || sites2.some((site) => overlaps(post, site, 0.3)))
              continue;
            sites2.push(post);
            placed = true;
            break;
          }
          if (placed) break;
        }
        if (placed) break;
      }
      if (!placed) throw new Error(`No clear sign post for ${place2.id}`);
    }
    return sites2;
  }

  // src/core/spatial-index.js
  var SpatialIndex = class {
    constructor(items = [], size = 12) {
      this.size = size;
      this.cells = /* @__PURE__ */ new Map();
      for (const item of items) this.add(item);
    }
    add(item) {
      const x = Math.floor(item.x / this.size), z = Math.floor(item.z / this.size);
      let row = this.cells.get(x);
      if (!row) this.cells.set(x, row = /* @__PURE__ */ new Map());
      const cell = row.get(z);
      if (cell) cell.push(item);
      else row.set(z, [item]);
    }
    near(point2, radius) {
      const result = [];
      const right = Math.floor((point2.x + radius) / this.size);
      const back = Math.floor((point2.z - radius) / this.size), front = Math.floor((point2.z + radius) / this.size);
      for (let x = Math.floor((point2.x - radius) / this.size); x <= right; x++) {
        const row = this.cells.get(x);
        if (!row) continue;
        for (let z = back; z <= front; z++) {
          const cell = row.get(z);
          if (!cell) continue;
          for (const item of cell)
            if (Math.hypot(item.x - point2.x, item.z - point2.z) <= radius) result.push(item);
        }
      }
      return result;
    }
  };

  // src/core/scenarios.js
  var SCENARIOS = Object.freeze(["crossing", "side-traffic", "barrier"]);
  function triggerScenario(world, kind = world.rng.pick(SCENARIOS)) {
    if (world.environment !== "lab" || !SCENARIOS.includes(kind)) return false;
    const player = world.player;
    let changed = false;
    if (kind === "crossing") {
      const people = world.actors.filter(
        (a) => a.type === "pedestrian" && !a.crossing
      );
      people.sort(
        (a, b) => distance(a, player) - distance(b, player) || a.id.localeCompare(b.id)
      );
      const person = people[0];
      if (person) {
        const road4 = person.road, offset2 = road4.width / 2 + 1.25;
        person.target = road4.axis === "z" ? { x: road4.fixed + person.side * offset2, z: person.z } : { x: person.x, z: road4.fixed - person.side * offset2 };
        person.crossing = true;
        person.pause = 0;
        person.walkSpeed = 1.35 + world.config.difficulty * 0.2;
        changed = true;
      }
    } else if (kind === "side-traffic") {
      const vehicles = world.actors.filter(
        (a) => a !== player && a.kind === "tuktuk" && distance(a, player) > 9
      );
      vehicles.sort(
        (a, b) => distance(a, player) - distance(b, player) || a.id.localeCompare(b.id)
      );
      for (const vehicle2 of vehicles) {
        const goals = [...world.junctions].sort(
          (a, b) => distance(a, player) - distance(b, player)
        );
        for (const goal of goals.slice(0, 3)) {
          const path = planNavigation(world.graph, vehicle2, goal, world.actors);
          if (path.length < 12) continue;
          const last = path.at(-1), before = path.at(-2), heading2 = Math.atan2(last.x - before.x, last.z - before.z);
          if (!goal.edges.some((key3) => {
            const p = world.graph.get(key3);
            return Math.abs(
              angleDelta(Math.atan2(p.x - goal.x, p.z - goal.z), heading2)
            ) < 0.1;
          }))
            continue;
          vehicle2.path = path;
          vehicle2.cursor = 0;
          vehicle2.reckless = true;
          changed = true;
          break;
        }
        if (changed) break;
      }
    } else {
      const candidates2 = player.path.filter(
        (p) => distance(p, player) > 16 && distance(p, player) < 24
      );
      if (!candidates2.length)
        candidates2.push({
          x: player.x + Math.sin(player.heading) * 18,
          z: player.z + Math.cos(player.heading) * 18
        });
      for (const point2 of candidates2) {
        const barrier2 = {
          id: `barrier-${world.tick}`,
          type: "static",
          kind: "barrier",
          x: point2.x,
          z: point2.z,
          heading: player.heading,
          width: 2.3,
          length: 0.7,
          height: 0.9,
          expires: world.tick + Math.round((8 + world.rng.range(0, 5)) * 60)
        };
        if (!bodyOnRoad(barrier2, world.roads) || !world.free(barrier2, 4))
          continue;
        world.statics.push(barrier2);
        world.staticIndex = new SpatialIndex(world.statics);
        changed = true;
        break;
      }
    }
    world.scenario = { kind, tick: world.tick, applied: changed };
    if (changed) world.metrics.scenarios++;
    return changed;
  }
  function updateScenarios(world) {
    if (world.environment !== "lab") return;
    if (world.statics.some((item) => item.expires && item.expires <= world.tick)) {
      world.statics = world.statics.filter(
        (item) => !item.expires || item.expires > world.tick
      );
      world.staticIndex = new SpatialIndex(world.statics);
    }
    const interval2 = Math.round(world.config.scenarioInterval * 60);
    if (world.tick > 0 && world.tick % interval2 === 0) triggerScenario(world);
  }

  // src/core/arrival.js
  function parkingBays(graph, junctionGroups2, roads) {
    const bays = [], used = /* @__PURE__ */ new Set();
    for (const place2 of PLACES) {
      let count = 0;
      for (const node of [...graph.values()].sort(
        (a, b) => distance(a, place2) - distance(b, place2)
      )) {
        if (distance(node, place2) > 70 || count >= 16) break;
        if (junctionGroups2.some((group) => insideJunction(node, group, 4)))
          continue;
        for (const road4 of roads) {
          if (road4.width < 10) continue;
          const along2 = road4.axis === "z" ? node.z : node.x;
          const cross2 = road4.axis === "z" ? node.x : node.z;
          if (Math.abs(cross2 - road4.fixed) > 0.01 || along2 < road4.min + 6 || along2 > road4.max - 6)
            continue;
          const marker = `${road4.axis}:${road4.fixed}:${along2}`;
          if (used.has(marker)) break;
          used.add(marker);
          for (const side of [-1, 1])
            bays.push({
              axis: road4.axis,
              fixed: road4.fixed + side * 5.6,
              min: Math.max(road4.min, along2 - 18),
              max: Math.min(road4.max, along2 + 18),
              width: 2.2,
              parkingBay: true,
              nodeKey: node.key,
              side
            });
          count++;
          break;
        }
      }
    }
    return bays;
  }
  function planArrival(world, goal) {
    const car = world.player;
    const candidates2 = [...world.graph.values()].filter(
      (node) => !world.junctionGroups.some((group) => insideJunction(node, group, 4))
    ).sort((a, b) => distance(a, goal) - distance(b, goal));
    for (const node of candidates2) {
      if (distance(node, goal) > 70) break;
      const path = planNavigation(
        world.graph,
        car,
        node,
        world.actors,
        world.trafficPressure()
      );
      if (path.length < 3) continue;
      const end = path.at(-1), before = path.at(-2);
      const heading2 = Math.atan2(end.x - before.x, end.z - before.z);
      const forward2 = { x: Math.sin(heading2), z: Math.cos(heading2) };
      const right = { x: -forward2.z, z: forward2.x };
      const road4 = world.drivingRoads.find(
        (r) => r.width >= 10 && Math.abs(angleDelta(heading2, r.axis === "z" ? 0 : Math.PI / 2)) % Math.PI < 0.01 && Math.abs((r.axis === "z" ? node.x : node.z) - r.fixed) < 0.01 && (r.axis === "z" ? node.z : node.x) > r.min + 4 && (r.axis === "z" ? node.z : node.x) < r.max - 4
      );
      if (!road4) continue;
      const side = Math.sign(road4.axis === "z" ? right.x : right.z);
      if (!world.parkingBays.some(
        (bay) => bay.nodeKey === node.key && bay.side === side && bay.axis === road4.axis && Math.abs(bay.fixed - road4.fixed - side * 5.6) < 0.01
      ))
        continue;
      let start = path.length - 1;
      while (start > 0 && distance(path[start], end) < 16) start--;
      if (distance(path[start], end) < 16) continue;
      if (path.slice(start).some(
        (p) => Math.abs((p.x - end.x) * right.x + (p.z - end.z) * right.z) > 0.02
      ))
        continue;
      const shift2 = 4.9 - LANE_OFFSET;
      const parking = {
        x: end.x + right.x * shift2 + forward2.x * 1.2,
        z: end.z + right.z * shift2 + forward2.z * 1.2,
        heading: heading2
      };
      if (world.actors.some(
        (a) => a !== car && overlaps({ ...car, ...parking }, a, 0.6)
      ))
        continue;
      const centers = path.map((p, i) => {
        if (i < start) return p;
        const t = Math.max(0, Math.min(1, (16 - distance(p, end)) / 12));
        const lateral2 = shift2 * t * t * (3 - 2 * t);
        return { x: p.x + right.x * lateral2, z: p.z + right.z * lateral2 };
      });
      if (centers.slice(start).some((p, i, tail) => {
        const next = tail[Math.min(i + 1, tail.length - 1)];
        const yaw = i === tail.length - 1 ? heading2 : Math.atan2(next.x - p.x, next.z - p.z);
        return !bodyOnRoad({ ...car, ...p, heading: yaw }, world.roads);
      }))
        continue;
      const route = centers.map((p, i) => {
        if (i < start || i === centers.length - 1) return p;
        const next = centers[i + 1];
        const yaw = Math.atan2(next.x - p.x, next.z - p.z);
        const correction = Math.sin(angleDelta(yaw, heading2)) * 1.3;
        return { x: p.x + right.x * correction, z: p.z + right.z * correction };
      });
      return { path: route, parking };
    }
    return null;
  }

  // src/core/policy.js
  var POLICY_VERSION = 1;
  var SPEED_ACTIONS = Object.freeze([0.35, 0.6, 0.8, 1]);
  function policyObservation(world, car) {
    let nearest2 = Infinity;
    let kind = "clear";
    for (const actor of [...world.actors, ...world.statics]) {
      if (actor === car) continue;
      const dx = actor.x - car.x;
      const dz = actor.z - car.z;
      const ahead = dx * Math.sin(car.heading) + dz * Math.cos(car.heading);
      const side = Math.abs(
        dx * Math.cos(car.heading) - dz * Math.sin(car.heading)
      );
      if (ahead < -1 || ahead > 30 || side > 3.1 || ahead >= nearest2) continue;
      nearest2 = ahead;
      kind = actor.type === "pedestrian" ? "person" : "obstacle";
    }
    const range = nearest2 < 7 ? "near" : nearest2 < 16 ? "middle" : nearest2 < 30 ? "far" : "clear";
    const speed = car.speed < 2 ? "slow" : car.speed < 5 ? "medium" : "fast";
    return `${range}:${kind}:${speed}`;
  }
  function validatePolicy(value) {
    if (value?.schemaVersion !== POLICY_VERSION || value.algorithm !== "tabular-q-learning" || !value.q || typeof value.q !== "object" || Array.isArray(value.q))
      throw new Error("Unsupported policy weights");
    const entries = Object.entries(value.q);
    if (entries.length > 100 || entries.some(
      ([key3, row]) => !/^(near|middle|far|clear):(clear|person|obstacle):(slow|medium|fast)$/.test(
        key3
      ) || !Array.isArray(row) || row.length !== SPEED_ACTIONS.length || row.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e6)
    ))
      throw new Error("Invalid policy weights");
    return value;
  }
  function policyAction(weights, state) {
    const row = weights.q[state];
    if (!row) return SPEED_ACTIONS.length - 1;
    let selected = 0;
    for (let i = 1; i < row.length; i++) if (row[i] > row[selected]) selected = i;
    return selected;
  }
  function policySpeed(world, car, requested) {
    if (world.policyActionOverride != null) {
      const i = world.policyActionOverride;
      if (Number.isInteger(i) && i >= 0 && i < SPEED_ACTIONS.length)
        return Math.min(requested, car.maxSpeed * SPEED_ACTIONS[i]);
    }
    if (!world.policy || car !== world.player || world.mode !== "auto")
      return requested;
    const action = policyAction(world.policy, policyObservation(world, car));
    return Math.min(requested, car.maxSpeed * SPEED_ACTIONS[action]);
  }

  // src/core/queue-metrics.js
  function findStoppedCycles(stopped) {
    const byId = new Map(stopped.map((actor) => [actor.id, actor]));
    const examined = /* @__PURE__ */ new Set();
    const cycles = [];
    for (const first of stopped) {
      if (examined.has(first.id)) continue;
      const path = [];
      const index = /* @__PURE__ */ new Map();
      let actor = first;
      while (actor && !examined.has(actor.id) && !index.has(actor.id)) {
        index.set(actor.id, path.length);
        path.push(actor.id);
        actor = byId.get(actor.blockedBy);
      }
      if (actor && index.has(actor.id))
        cycles.push(path.slice(index.get(actor.id)));
      for (const id of path) examined.add(id);
    }
    return cycles;
  }
  function trafficQueueStats(actors, canProceed = () => true) {
    const traffic = actors.filter(
      (actor) => actor.type === "vehicle" && actor.id !== "player"
    );
    const stopped = traffic.filter(
      (actor) => actor.speed < 0.15 && actor.wait >= 5
    );
    return {
      trafficStoppedOver5: stopped.length,
      trafficStoppedOver20: traffic.filter(
        (actor) => actor.speed < 0.15 && actor.wait >= 20
      ).length,
      longestCurrentTrafficWait: Math.max(
        0,
        ...traffic.map((actor) => actor.wait)
      ),
      trafficBlockingCycles: findStoppedCycles(stopped.filter(canProceed)).length
    };
  }

  // src/core/body-path-evidence.js
  function bodyPathAllowsLateralMotion(track2, motion, ego) {
    const c = Math.cos(ego.headingRad), s = Math.sin(ego.headingRad);
    const lateralVariance = (matrix) => Math.max(
      0,
      c * c * matrix.xx - 2 * c * s * matrix.xz + s * s * matrix.zz
    );
    const forwardVariance = (matrix) => Math.max(
      0,
      s * s * matrix.xx + 2 * c * s * matrix.xz + c * c * matrix.zz
    );
    const lateralMps = track2.velocity.x * c - track2.velocity.z * s;
    const forwardMps = track2.velocity.x * s + track2.velocity.z * c;
    const lateralErrorMps = 0.05 + Math.sqrt(lateralVariance(track2.velocityCovarianceM2S2));
    const forwardErrorMps = 0.05 + Math.sqrt(forwardVariance(track2.velocityCovarianceM2S2));
    const forwardPositionErrorM = Math.sqrt(forwardVariance(track2.positionCovarianceM2) + forwardVariance(track2.regressionResidualCovarianceM2));
    if (!track2.reliable || Math.abs(lateralMps) - lateralErrorMps >= 0.2 || Math.abs(forwardMps) - forwardErrorMps <= 0.2 || Math.abs(forwardMps) * track2.spanS <= 2 * forwardPositionErrorM)
      return true;
    const positionVariance = lateralVariance(track2.positionCovarianceM2) + lateralVariance(track2.regressionResidualCovarianceM2);
    const velocityVariance = lateralVariance(track2.velocityCovarianceM2S2);
    let firstOutsideS = track2.lastSeenS;
    for (let i = track2.history.length - 1; i >= 0; i--) {
      const sample = track2.history[i];
      if (sample.simulationTimeS < motion.supportTimeS - 1e-8) break;
      const dt = sample.simulationTimeS - track2.lastSeenS;
      const dx = sample.position.x - track2.position.x - track2.velocity.x * dt;
      const dz = sample.position.z - track2.position.z - track2.velocity.z * dt;
      const innovationM = dx * c - dz * s;
      const errorM = 2 * Math.sqrt(positionVariance + dt * dt * velocityVariance);
      if (innovationM * motion.lateralMps <= 0 || Math.abs(innovationM) <= errorM) break;
      firstOutsideS = sample.simulationTimeS;
    }
    return track2.lastSeenS - firstOutsideS >= 0.1 - 1e-8;
  }

  // src/core/visual-prediction.js
  var SOURCE = "visual-prediction";
  var PIXELS = "camera-pixels";
  var MAX_AGE_S = 0.75;
  var HORIZON_S = 6;
  var HOLD_S = 0.35;
  var MAX_TRACKS = 24;
  var MAX_HISTORY = 12;
  var MAX_WALK_SPEED = 4;
  var STOP_SPEED_MPS = 0.05;
  var PERSON_CONFIDENCE = 0.55;
  var MOTION_CONFIDENCE = 0.65;
  var LABELS = ["person", "motion", "vehicle"];
  var RESULT_KEYS = [
    "streamId",
    "frameId",
    "simulationTimeS",
    "camera",
    "ego",
    "width",
    "height",
    "latencyMs",
    "model",
    "detections",
    "observations",
    "status"
  ];
  var TRACK_KEYS = [
    "id",
    "source",
    "streamId",
    "label",
    "confidence",
    "frameId",
    "firstSeenS",
    "lastSeenS",
    "observations",
    "spanS",
    "position",
    "velocity",
    "uncertaintyM",
    "velocityUncertaintyMps",
    "reliable",
    "box",
    "history",
    "holdUntilS",
    "holdSpeedMps",
    "lastConflictS",
    "conflictFrameId",
    "conflictCrossingTimeS",
    "ageMs",
    "positionCovarianceM2",
    "velocityCovarianceM2S2",
    "regressionResidualCovarianceM2",
    "stopEpisode"
  ];
  var EPISODE_KEYS = [
    "source",
    "trackId",
    "streamId",
    "phase",
    "originFrameId",
    "originTimeS",
    "originConfidence",
    "requestedAtS",
    "referenceEgo",
    "referenceSpeedMps",
    "lowestSpeedMps",
    "lastProgressSpeedMps",
    "lastProgressAtS",
    "brakingObservedAtS",
    "stoppedAtS",
    "stopDeadlineS",
    "clearanceDeadlineS",
    "lastSupportFrameId",
    "lastSupportTimeS",
    "clearFrameId",
    "clearedAtS",
    "expiryReason"
  ];
  var clamp2 = (n, low, high) => Math.min(high, Math.max(low, n));
  function imageOverlap(a, b) {
    const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const intersection = width * height;
    return intersection / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection);
  }
  function object(value, keys, name) {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new TypeError(`${name} must be a plain object`);
    for (const key3 of Reflect.ownKeys(value)) {
      if (!keys.includes(key3))
        throw new TypeError(`${name}: unknown field ${String(key3)}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key3);
      if (descriptor.get || descriptor.set)
        throw new TypeError(`${name}: accessors are not observation data`);
    }
  }
  function number(value, min, max, name, integer = false) {
    if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value))
      throw new TypeError(`${name} is outside its finite bounds`);
  }
  function token2(value, name, max = 80) {
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw new TypeError(`${name} must be a nonempty string of at most ${max} characters`);
  }
  function point(value, name) {
    object(value, ["x", "z"], name);
    number(value.x, -1e5, 1e5, `${name}.x`);
    number(value.z, -1e5, 1e5, `${name}.z`);
  }
  function odometry(ego) {
    object(ego, ["x", "z", "headingRad", "speedMps", "lengthM", "widthM"], "ego");
    point({ x: ego.x, z: ego.z }, "ego position");
    number(ego.headingRad, -1e5, 1e5, "ego.headingRad");
    number(ego.speedMps, -55, 55, "ego.speedMps");
    number(ego.lengthM, 1, 10, "ego.lengthM");
    number(ego.widthM, 0.5, 4, "ego.widthM");
  }
  function calibration(camera) {
    object(camera, ["width", "height", "fovYDeg", "position", "headingRad", "groundY"], "camera");
    number(camera.width, 160, 1920, "camera.width", true);
    number(camera.height, 90, 1080, "camera.height", true);
    number(camera.fovYDeg, 20, 140, "camera.fovYDeg");
    object(camera.position, ["x", "y", "z"], "camera.position");
    for (const key3 of ["x", "y", "z"])
      number(camera.position[key3], -1e5, 1e5, `camera.position.${key3}`);
    number(camera.headingRad, -1e5, 1e5, "camera.headingRad");
    number(camera.groundY, -100, 100, "camera.groundY");
    number(camera.position.y - camera.groundY, 0.2, 8, "camera height above ground");
  }
  function box(value, width, height) {
    if (!Array.isArray(value) || value.length !== 4)
      throw new TypeError("box must contain four pixel coordinates");
    value.forEach((v, i) => number(v, 0, i % 2 ? height : width, "box coordinate"));
    if (value[0] >= value[2] || value[1] >= value[3])
      throw new TypeError("box must have positive pixel area");
  }
  function qualityMetadata(value, depth = 0) {
    if (depth > 4) throw new TypeError("observations quality metadata is too deep");
    if (typeof value === "number") number(value, -1e9, 1e9, "observation quality");
    else if (typeof value === "string") {
      if (value.length > 256) throw new TypeError("observation quality text is too long");
    } else if (value != null && typeof value === "object") {
      const keys = Reflect.ownKeys(value);
      if (keys.length > 64) throw new TypeError("observation quality metadata is too large");
      for (const key3 of keys) {
        if (typeof key3 !== "string" || /actor|world|future|scenario|case.?id|intent|ground.?truth|hit.?id|script|path|target/i.test(key3))
          throw new TypeError(`observations: forbidden truth field ${String(key3)}`);
        qualityMetadata(value[key3], depth + 1);
      }
    } else if (value != null && typeof value !== "boolean")
      throw new TypeError("observations must contain only serializable pixel quality metadata");
  }
  function resultData(result) {
    object(result, RESULT_KEYS, "result");
    token2(result.streamId, "streamId");
    number(result.frameId, 0, Number.MAX_SAFE_INTEGER, "frameId", true);
    number(result.simulationTimeS, 0, 1e9, "simulationTimeS");
    if (result.status !== "ready") throw new TypeError("result is not a ready pixel observation");
    calibration(result.camera);
    odometry(result.ego);
    if (result.width !== result.camera.width || result.height !== result.camera.height)
      throw new TypeError("result dimensions must match the captured camera");
    number(result.latencyMs, 0, 6e4, "latencyMs");
    object(result.model, ["id", "method", "provider", "weightsSha256"], "model");
    for (const key3 of ["id", "method", "provider"]) token2(result.model[key3], `model.${key3}`, 200);
    if (result.model.weightsSha256 !== null && !/^[a-f0-9]{64}$/i.test(result.model.weightsSha256 ?? ""))
      throw new TypeError("model.weightsSha256 must be null or an actual SHA-256");
    if (!Array.isArray(result.detections) || result.detections.length > 128)
      throw new TypeError("detections must be a bounded array");
    for (const detection of result.detections) {
      object(detection, ["box", "label", "confidence", "trackHint"], "detection");
      box(detection.box, result.width, result.height);
      if (!LABELS.includes(detection.label)) throw new TypeError("unsupported detector label");
      number(detection.confidence, 0, 1, "detection.confidence");
      if (detection.trackHint !== void 0) token2(detection.trackHint, "trackHint");
    }
    if (result.observations !== void 0) {
      if (!Array.isArray(result.observations) || result.observations.length > 64)
        throw new TypeError("observations must be a bounded pixel-quality array");
      qualityMetadata(result.observations);
    }
  }
  function project(detection, camera) {
    const focal = camera.height / (2 * Math.tan(camera.fovYDeg * Math.PI / 360));
    const belowHorizon = detection.box[3] - camera.height / 2;
    if (belowHorizon < 2 || detection.box[3] >= camera.height - 1) return null;
    const depth = (camera.position.y - camera.groundY) * focal / belowHorizon;
    if (depth < 0.5 || depth > 60) return null;
    const side = ((detection.box[0] + detection.box[2]) / 2 - camera.width / 2) * depth / focal;
    const sine = Math.sin(camera.headingRad), cosine = Math.cos(camera.headingRad);
    const offsetX = sine * depth - cosine * side, offsetZ = cosine * depth + sine * side;
    const duX = -cosine * depth / focal, duZ = sine * depth / focal;
    const dvX = -offsetX / belowHorizon, dvZ = -offsetZ / belowHorizon;
    const projectionCovarianceM2 = {
      xx: 0.25 * (duX * duX + dvX * dvX),
      xz: 0.25 * (duX * duZ + dvX * dvZ),
      zz: 0.25 * (duZ * duZ + dvZ * dvZ)
    };
    return {
      x: camera.position.x + offsetX,
      z: camera.position.z + offsetZ,
      projectionCovarianceM2,
      sigmaM: Math.max(0.08, Math.sqrt(projectionCovarianceM2.xx + projectionCovarianceM2.zz))
    };
  }
  function fit(history) {
    const last = history.at(-1);
    const meanT = history.reduce((sum, p) => sum + p.timeS - last.timeS, 0) / history.length;
    const meanX = history.reduce((sum, p) => sum + p.x, 0) / history.length;
    const meanZ = history.reduce((sum, p) => sum + p.z, 0) / history.length;
    let variance = 0, covX = 0, covZ = 0;
    for (const p of history) {
      const dt = p.timeS - last.timeS - meanT;
      variance += dt * dt;
      covX += dt * (p.x - meanX);
      covZ += dt * (p.z - meanZ);
    }
    const rawX = variance > 1e-8 ? covX / variance : 0;
    const rawZ = variance > 1e-8 ? covZ / variance : 0;
    const rawSpeed = Math.hypot(rawX, rawZ);
    const scale = rawSpeed > MAX_WALK_SPEED ? MAX_WALK_SPEED / rawSpeed : 1;
    const x = meanX - rawX * meanT, z = meanZ - rawZ * meanT;
    let residualXX = 0, residualXZ = 0, residualZZ = 0;
    for (const p of history) {
      const dx = p.x - x - rawX * (p.timeS - last.timeS);
      const dz = p.z - z - rawZ * (p.timeS - last.timeS);
      residualXX += dx * dx;
      residualXZ += dx * dz;
      residualZZ += dz * dz;
    }
    const residual = Math.sqrt((residualXX + residualZZ) / history.length);
    const degrees = Math.max(1, history.length - 2);
    const regressionResidualCovarianceM2 = {
      xx: residualXX / degrees,
      xz: residualXZ / degrees,
      zz: residualZZ / degrees
    };
    const velocityFactor = variance > 1e-8 ? 1 / variance : 0;
    const positionFactor = 1 / history.length + meanT * meanT * velocityFactor;
    const positionCovarianceM2 = {}, velocityCovarianceM2S2 = {};
    for (const key3 of ["xx", "xz", "zz"]) {
      positionCovarianceM2[key3] = last.projectionCovarianceM2[key3] + positionFactor * regressionResidualCovarianceM2[key3];
      velocityCovarianceM2S2[key3] = velocityFactor * regressionResidualCovarianceM2[key3];
    }
    const spanS = last.timeS - history[0].timeS;
    return {
      position: { x, z },
      velocity: { x: rawX * scale, z: rawZ * scale },
      spanS,
      uncertaintyM: clamp2(last.sigmaM + residual * 2, 0.08, 10),
      velocityUncertaintyMps: clamp2(0.05 + residual * 2 / Math.max(0.2, spanS), 0.05, 8),
      positionCovarianceM2,
      velocityCovarianceM2S2,
      regressionResidualCovarianceM2,
      reliable: rawSpeed <= MAX_WALK_SPEED && residual <= 0.8
    };
  }
  function validateCovariance(value, name) {
    object(value, ["xx", "xz", "zz"], name);
    number(value.xx, 0, 1e15, `${name}.xx`);
    number(value.zz, 0, 1e15, `${name}.zz`);
    number(value.xz, -1e15, 1e15, `${name}.xz`);
    const bound = Math.sqrt(value.xx * value.zz);
    if (Math.abs(value.xz) > bound + 1e-9 * Math.max(1, bound))
      throw new TypeError(`${name} must be a positive-semidefinite covariance`);
  }
  function copyEpisode(value) {
    return value ? { ...value, referenceEgo: { ...value.referenceEgo } } : null;
  }
  function validateEpisode(value, track2) {
    if (value === null) return;
    object(value, EPISODE_KEYS, "stop episode");
    if (value.source !== SOURCE || value.trackId !== track2.id || value.streamId !== track2.streamId)
      throw new TypeError("stop episode must retain its qualified visual track/stream identity");
    if (!["stopping", "awaiting-clearance", "cleared", "expired"].includes(value.phase))
      throw new TypeError("unknown stop episode phase");
    odometry(value.referenceEgo);
    number(value.referenceSpeedMps, 0.2, 55, "episode reference speed");
    if (value.referenceSpeedMps !== value.referenceEgo.speedMps)
      throw new TypeError("episode reference speed must be captured own odometry");
    number(value.originConfidence, track2.label === "motion" ? 0.65 : 0.55, 1, "episode origin confidence");
    number(value.originFrameId, 0, track2.frameId, "episode origin frame", true);
    number(value.originTimeS, 0, track2.lastSeenS, "episode origin time");
    number(value.requestedAtS, value.originTimeS, 1e9, "episode request time");
    for (const key3 of ["lowestSpeedMps", "lastProgressSpeedMps"])
      number(value[key3], 0, value.referenceSpeedMps, `episode.${key3}`);
    const maximumDeadline = value.requestedAtS + HORIZON_S + value.referenceSpeedMps / VEHICLE.braking + MAX_AGE_S;
    number(value.clearanceDeadlineS, value.requestedAtS, maximumDeadline + 1e-8, "episode clearance deadline");
    number(value.stopDeadlineS, value.requestedAtS, value.clearanceDeadlineS, "episode stop deadline");
    number(value.lastProgressAtS, value.requestedAtS, 1e9, "episode last progress time");
    number(value.lastSupportFrameId, value.originFrameId, track2.frameId, "episode support frame", true);
    number(value.lastSupportTimeS, value.originTimeS, track2.lastSeenS, "episode support time");
    for (const key3 of ["brakingObservedAtS", "stoppedAtS", "clearedAtS"])
      if (value[key3] !== null) number(value[key3], value.requestedAtS, 1e9, `episode.${key3}`);
    if (value.clearFrameId !== null)
      number(value.clearFrameId, value.originFrameId, track2.frameId, "episode clear frame", true);
    if (value.expiryReason !== null) token2(value.expiryReason, "episode expiry reason");
  }
  function publicTrack(track2, nowS, ego, freshMotionSupport = false) {
    let history = track2.history;
    if (freshMotionSupport) {
      const first = history.findIndex((sample) => nowS - sample.timeS <= MAX_AGE_S + 1e-8);
      history = history.slice(first < 0 ? -1 : first);
    }
    const result = {
      id: track2.id,
      source: PIXELS,
      streamId: track2.streamId,
      label: track2.label,
      confidence: track2.confidence,
      frameId: track2.frameId,
      firstSeenS: history[0].timeS,
      lastSeenS: track2.lastSeenS,
      observations: history.length,
      ...fit(history),
      box: [...track2.box],
      history: history.map((p) => ({
        frameId: p.frameId,
        simulationTimeS: p.timeS,
        position: { x: p.x, z: p.z }
      })),
      holdUntilS: track2.holdUntilS,
      holdSpeedMps: track2.holdSpeedMps,
      lastConflictS: track2.lastConflictS,
      conflictFrameId: track2.conflictFrameId,
      conflictCrossingTimeS: track2.conflictCrossingTimeS,
      ageMs: Math.max(0, (nowS - track2.lastSeenS) * 1e3),
      stopEpisode: copyEpisode(track2.stopEpisode)
    };
    if (freshMotionSupport && track2.label !== "vehicle" && result.reliable && history.length >= 3 && history.length < track2.history.length && (!track2.stopEpisode || track2.stopEpisode.phase === "cleared")) {
      const reference = { ...fit(track2.history), history: result.history, lastSeenS: track2.lastSeenS };
      const c = Math.cos(ego.headingRad), s = Math.sin(ego.headingRad);
      const lateral2 = ({ x, z }) => x * c - z * s;
      const error = (covariance) => Math.sqrt(Math.max(
        0,
        c * c * covariance.xx - 2 * c * s * covariance.xz + s * s * covariance.zz
      ));
      const lateralMps = lateral2(result.velocity), direction3 = Math.sign(lateralMps);
      const oldDirectionMps = direction3 * lateral2(reference.velocity) - (0.05 + error(reference.velocityCovarianceM2S2));
      const observedShiftM = direction3 * (lateral2(history.at(-1)) - lateral2(history[0]));
      const resolvedShiftM = observedShiftM - 2 * error(result.positionCovarianceM2);
      result.reliable = (!reference.reliable || oldDirectionMps >= 0.2 || resolvedShiftM > 0.35) && bodyPathAllowsLateralMotion(reference, { lateralMps, supportTimeS: result.firstSeenS }, ego);
    }
    return result;
  }
  function validateTrack(track2) {
    object(track2, TRACK_KEYS, "visual track");
    if (track2.source !== PIXELS) throw new TypeError("visual tracks require camera-pixels provenance");
    token2(track2.id, "visual track id");
    token2(track2.streamId, "visual track stream");
    if (!LABELS.includes(track2.label)) throw new TypeError("unsupported visual track label");
    for (const key3 of ["position", "velocity"]) point(track2[key3], `track.${key3}`);
    number(track2.confidence, 0, 1, "track.confidence");
    number(track2.observations, 1, MAX_HISTORY, "track.observations", true);
    number(track2.firstSeenS, 0, 1e9, "track.firstSeenS");
    number(track2.lastSeenS, track2.firstSeenS, 1e9, "track.lastSeenS");
    number(track2.spanS, 0, 2, "track.spanS");
    number(track2.frameId, 0, Number.MAX_SAFE_INTEGER, "track.frameId", true);
    number(track2.uncertaintyM, 0, 10, "track.uncertaintyM");
    number(track2.velocityUncertaintyMps, 0, 8, "track.velocityUncertaintyMps");
    for (const key3 of ["positionCovarianceM2", "velocityCovarianceM2S2", "regressionResidualCovarianceM2"])
      validateCovariance(track2[key3], key3);
    validateEpisode(track2.stopEpisode, track2);
    number(track2.holdSpeedMps, 0, 55, "track.holdSpeedMps");
    for (const key3 of ["holdUntilS", "lastConflictS", "conflictCrossingTimeS"])
      if (track2[key3] !== null) number(track2[key3], 0, 1e9, `track.${key3}`);
    if (track2.conflictFrameId !== null)
      number(track2.conflictFrameId, 0, Number.MAX_SAFE_INTEGER, "track.conflictFrameId", true);
    if (typeof track2.reliable !== "boolean") throw new TypeError("track reliability is missing");
    box(track2.box, 1920, 1080);
    number(track2.ageMs, 0, 1e12, "track.ageMs");
    if (!Array.isArray(track2.history) || track2.history.length !== track2.observations)
      throw new TypeError("track history must match its actual observation count");
    let priorTime = -1, priorFrame = -1;
    for (const sample of track2.history) {
      object(sample, ["frameId", "simulationTimeS", "position"], "track history sample");
      point(sample.position, "track history position");
      number(sample.frameId, 0, Number.MAX_SAFE_INTEGER, "history frameId", true);
      number(sample.simulationTimeS, 0, 1e9, "history simulationTimeS");
      if (sample.frameId <= priorFrame || sample.simulationTimeS <= priorTime)
        throw new TypeError("track history must contain distinct ordered observations");
      priorTime = sample.simulationTimeS;
      priorFrame = sample.frameId;
    }
    if (Math.abs(track2.history[0].simulationTimeS - track2.firstSeenS) > 1e-8 || Math.abs(priorTime - track2.lastSeenS) > 1e-8 || priorFrame !== track2.frameId || Math.abs(track2.lastSeenS - track2.firstSeenS - track2.spanS) > 1e-8)
      throw new TypeError("track history identity/span does not match the observed evidence");
  }
  function interval(position2, velocity, halfExtent) {
    if (Math.abs(velocity) < 1e-8)
      return Math.abs(position2) <= halfExtent ? [0, HORIZON_S] : null;
    const a = (-halfExtent - position2) / velocity, b = (halfExtent - position2) / velocity;
    const enter = Math.max(0, Math.min(a, b)), leave = Math.min(HORIZON_S, Math.max(a, b));
    return leave >= enter ? [enter, leave] : null;
  }
  function directionalSigma(matrix, x, z) {
    return Math.sqrt(Math.max(0, x * x * matrix.xx + 2 * x * z * matrix.xz + z * z * matrix.zz));
  }
  function occupiedInterval(position2, velocity, halfExtent, positionError, velocityError) {
    let enter = 0, leave = HORIZON_S;
    for (const [offset2, rate] of [
      [position2, velocity + velocityError],
      [-position2, -velocity + velocityError]
    ]) {
      const remaining = halfExtent - positionError - offset2;
      if (Math.abs(rate) < 1e-8) {
        if (remaining < 0) return null;
      } else if (rate > 0) leave = Math.min(leave, remaining / rate);
      else enter = Math.max(enter, remaining / rate);
    }
    return leave >= enter ? [enter, leave] : null;
  }
  function forecast(track2, nowS, ego) {
    const ageS = nowS - track2.lastSeenS;
    const c = Math.cos(ego.headingRad), s = Math.sin(ego.headingRad);
    const dx = track2.position.x + track2.velocity.x * Math.max(0, ageS) - ego.x;
    const dz = track2.position.z + track2.velocity.z * Math.max(0, ageS) - ego.z;
    const lateralM = dx * c - dz * s, longitudinalM = dx * s + dz * c;
    const lateralSpeedMps = track2.velocity.x * c - track2.velocity.z * s;
    const forwardSpeedMps = track2.velocity.x * s + track2.velocity.z * c;
    const lateralVelocityUncertaintyMps = 0.05 + directionalSigma(track2.velocityCovarianceM2S2, c, -s);
    const longitudinalVelocityUncertaintyMps = 0.05 + directionalSigma(track2.velocityCovarianceM2S2, s, c);
    const lateralPositionUncertaintyM = Math.max(
      0.08,
      directionalSigma(track2.positionCovarianceM2, c, -s)
    ) + Math.max(0, ageS) * lateralVelocityUncertaintyMps;
    const longitudinalPositionUncertaintyM = Math.max(
      0.08,
      directionalSigma(track2.positionCovarianceM2, s, c)
    ) + Math.max(0, ageS) * longitudinalVelocityUncertaintyMps;
    const confidence = track2.confidence * clamp2(1 - lateralVelocityUncertaintyMps / 0.9, 0.35, 1) * clamp2(1 - lateralPositionUncertaintyM / 8, 0.35, 1);
    const held = track2.lastConflictS !== null && track2.holdUntilS !== null && nowS >= track2.lastConflictS && nowS <= track2.holdUntilS + 1e-8 && track2.holdUntilS - track2.lastConflictS <= HOLD_S + 1e-8;
    const laneHalf = ego.widthM / 2 + 0.35;
    const band = laneHalf + Math.min(lateralPositionUncertaintyM, 0.65);
    const prediction = {
      trackId: track2.id,
      label: track2.label,
      confidence,
      lateralM,
      longitudinalM,
      lateralSpeedMps,
      forwardSpeedMps,
      lateralPositionUncertaintyM,
      longitudinalPositionUncertaintyM,
      lateralVelocityUncertaintyMps,
      longitudinalVelocityUncertaintyMps,
      lateralOccupancyS: null,
      longitudinalArrivalS: null,
      arrivalQualified: false,
      uncertaintyM: track2.uncertaintyM,
      crossingTimeS: null,
      clearanceTimeS: null,
      egoArrivalTimeS: null,
      conflictTimeS: null,
      conflict: false,
      qualified: false,
      held,
      reason: "insufficient-history"
    };
    const reject = (reason) => ({ ...prediction, reason });
    if (ageS < -1e-8) return reject("future-observation");
    if (ageS > MAX_AGE_S + 1e-8) return reject("stale-observation");
    if (track2.label === "vehicle") return reject("not-a-crossing-class");
    if (track2.observations < 3 || track2.spanS + 1e-8 < 0.2) return prediction;
    if (!track2.reliable || Math.hypot(track2.velocity.x, track2.velocity.z) > MAX_WALK_SPEED || track2.uncertaintyM > 2.5 || lateralVelocityUncertaintyMps > 0.65)
      return reject("uncertain-visual-track");
    if (confidence < (track2.label === "motion" ? MOTION_CONFIDENCE : PERSON_CONFIDENCE))
      return reject("low-visual-confidence");
    prediction.qualified = true;
    if (Math.abs(lateralSpeedMps) - lateralVelocityUncertaintyMps < 0.2)
      return reject("no-confident-lateral-motion");
    if (!(lateralM * lateralSpeedMps < 0 || held && Math.abs(lateralM) <= band))
      return reject("moving-away-from-lane");
    if (longitudinalM < -ego.lengthM / 2 - 0.35) return reject("behind-ego");
    const possibleLateral = interval(lateralM, lateralSpeedMps, band);
    if (!possibleLateral) return reject("outside-forecast-horizon");
    const lateral2 = occupiedInterval(
      lateralM,
      lateralSpeedMps,
      laneHalf,
      lateralPositionUncertaintyM,
      lateralVelocityUncertaintyMps
    );
    if (!lateral2) return { ...reject("uncertain-lane-occupancy"), qualified: false };
    prediction.lateralOccupancyS = lateral2;
    prediction.crossingTimeS = clamp2((Math.abs(lateralM) - laneHalf) / Math.abs(lateralSpeedMps), 0, HORIZON_S);
    prediction.clearanceTimeS = lateral2[1];
    const speed = Math.max(0, ego.speedMps, held ? track2.holdSpeedMps : 0);
    if (speed < 0.2) return reject("ego-not-approaching");
    prediction.egoArrivalTimeS = clamp2(longitudinalM / speed, 0, HORIZON_S);
    const closing = speed - forwardSpeedMps;
    const closingLow = closing - longitudinalVelocityUncertaintyMps;
    const closingHigh = closing + longitudinalVelocityUncertaintyMps;
    if (closingHigh <= 0.2) return reject("no-temporal-lane-conflict");
    if (closingLow <= 0.2)
      return { ...reject("uncertain-longitudinal-arrival"), qualified: false };
    const halfLength = ego.lengthM / 2 + 0.35;
    const near = longitudinalM - longitudinalPositionUncertaintyM;
    const far = longitudinalM + longitudinalPositionUncertaintyM;
    const earliestEntry = Math.max(0, (near - halfLength) / closingHigh);
    const latestEntry = Math.max(0, (far - halfLength) / closingLow);
    const earliestExit = Math.max(0, (near + halfLength) / closingHigh);
    const latestExit = Math.max(0, (far + halfLength) / closingLow);
    const withinHorizon = (time) => time <= HORIZON_S ? time : null;
    prediction.longitudinalArrivalS = {
      earliestEntryS: withinHorizon(earliestEntry),
      latestEntryS: withinHorizon(latestEntry),
      earliestExitS: withinHorizon(earliestExit),
      latestExitS: withinHorizon(latestExit)
    };
    if (earliestEntry > lateral2[1] + 0.25 || latestExit < lateral2[0] - 0.25)
      return reject("no-temporal-lane-conflict");
    if (latestEntry > HORIZON_S || latestEntry > lateral2[1] + 0.25 || earliestExit < lateral2[0] - 0.25 || earliestExit <= 0)
      return { ...reject("uncertain-longitudinal-arrival"), qualified: false };
    prediction.arrivalQualified = true;
    prediction.conflict = true;
    prediction.conflictTimeS = Math.max(lateral2[0], latestEntry);
    prediction.reason = track2.label === "person" ? "observed-person-crossing-conflict" : "observed-motion-crossing-conflict";
    return prediction;
  }
  function decision(reason, available = false, track2 = null, nowS = 0) {
    return {
      source: SOURCE,
      available,
      brake: false,
      targetSpeedMps: null,
      reason,
      trackId: null,
      confidence: 0,
      crossingTimeS: null,
      ageMs: track2 ? Math.max(0, (nowS - track2.lastSeenS) * 1e3) : null,
      evidenceFrameId: track2?.frameId ?? null
    };
  }
  function beginStopEpisode(track2, prediction, nowS, ego) {
    const referenceSpeedMps = ego.speedMps;
    const stoppingS = referenceSpeedMps / VEHICLE.braking;
    const clearanceS = Math.min(
      HORIZON_S,
      (Math.abs(prediction.lateralM) + ego.widthM / 2 + 0.35 + prediction.lateralPositionUncertaintyM) / Math.max(0.2, Math.abs(prediction.lateralSpeedMps) - prediction.lateralVelocityUncertaintyMps)
    );
    return {
      source: SOURCE,
      trackId: track2.id,
      streamId: track2.streamId,
      phase: "stopping",
      originFrameId: track2.frameId,
      originTimeS: track2.lastSeenS,
      originConfidence: prediction.confidence,
      requestedAtS: nowS,
      referenceEgo: { ...ego },
      referenceSpeedMps,
      lowestSpeedMps: referenceSpeedMps,
      lastProgressSpeedMps: referenceSpeedMps,
      lastProgressAtS: nowS,
      brakingObservedAtS: null,
      stoppedAtS: null,
      stopDeadlineS: nowS + stoppingS + MAX_AGE_S,
      clearanceDeadlineS: nowS + clearanceS + stoppingS + MAX_AGE_S,
      lastSupportFrameId: track2.frameId,
      lastSupportTimeS: track2.lastSeenS,
      clearFrameId: null,
      clearedAtS: null,
      expiryReason: null
    };
  }
  function observedClearance(track2, episode, nowS, ego) {
    if (nowS - track2.lastSeenS > MAX_AGE_S || nowS < track2.lastSeenS || track2.history.length < 3 || !track2.reliable || track2.uncertaintyM > 2.5)
      return false;
    const reference = { ...episode.referenceEgo, speedMps: ego.speedMps };
    const visible2 = forecast(track2, nowS, reference);
    if (visible2.confidence < (track2.label === "motion" ? MOTION_CONFIDENCE : PERSON_CONFIDENCE) || visible2.lateralVelocityUncertaintyMps > 0.65)
      return false;
    const recent = track2.history.slice(-3);
    if (recent[2].simulationTimeS - recent[0].simulationTimeS + 1e-8 < 0.2) return false;
    const side = Math.sign(visible2.lateralM), half = reference.widthM / 2 + 0.35;
    const c = Math.cos(reference.headingRad), s = Math.sin(reference.headingRad);
    if (!side || recent.some(({ position: position2 }) => side * ((position2.x - reference.x) * c - (position2.z - reference.z) * s) - visible2.lateralPositionUncertaintyM <= half))
      return false;
    const away = side * visible2.lateralSpeedMps - visible2.lateralVelocityUncertaintyMps >= 0.2;
    const stationaryClear = Math.abs(visible2.lateralSpeedMps) + visible2.lateralVelocityUncertaintyMps <= 0.2;
    return away || stationaryClear;
  }
  function advanceStopEpisode(track2, nowS, ego, usable = true, allowLateClearance = false) {
    const episode = copyEpisode(track2.stopEpisode);
    if (!episode || episode.phase === "cleared") return episode;
    const speed = Math.abs(ego.speedMps);
    if (episode.phase === "expired") {
      const oldestClearanceS = track2.history.at(-3)?.simulationTimeS;
      if (allowLateClearance && usable && episode.stoppedAtS !== null && speed < STOP_SPEED_MPS && track2.frameId > episode.lastSupportFrameId && track2.lastSeenS > episode.lastSupportTimeS && nowS - oldestClearanceS <= MAX_AGE_S + 1e-8 && observedClearance(track2, episode, nowS, ego)) {
        episode.phase = "cleared";
        episode.clearFrameId = track2.frameId;
        episode.clearedAtS = nowS;
      }
      return episode;
    }
    episode.lowestSpeedMps = Math.min(episode.lowestSpeedMps, speed);
    if (episode.lastProgressSpeedMps - episode.lowestSpeedMps >= STOP_SPEED_MPS) {
      episode.lastProgressAtS = nowS;
      episode.lastProgressSpeedMps = episode.lowestSpeedMps;
      episode.brakingObservedAtS ??= nowS;
    }
    if (episode.brakingObservedAtS !== null && nowS > episode.requestedAtS) {
      const observedDeceleration = (episode.referenceSpeedMps - episode.lowestSpeedMps) / (nowS - episode.requestedAtS);
      if (observedDeceleration > 0) episode.stopDeadlineS = Math.min(
        episode.clearanceDeadlineS,
        episode.requestedAtS + episode.referenceSpeedMps / Math.min(VEHICLE.braking, observedDeceleration) + MAX_AGE_S
      );
    }
    if (speed < STOP_SPEED_MPS) {
      episode.stoppedAtS ??= nowS;
      episode.phase = "awaiting-clearance";
    }
    const stopped = episode.stoppedAtS !== null;
    const noProgress = !stopped && nowS - episode.lastProgressAtS > MAX_AGE_S;
    if (nowS > episode.clearanceDeadlineS || !stopped && nowS > episode.stopDeadlineS || noProgress) {
      episode.phase = "expired";
      episode.expiryReason = noProgress ? "visual-stop-no-braking-progress" : "visual-stop-episode-expired";
      return episode;
    }
    const fresh = usable && nowS >= track2.lastSeenS && nowS - track2.lastSeenS <= MAX_AGE_S;
    if (fresh) {
      episode.lastSupportFrameId = track2.frameId;
      episode.lastSupportTimeS = track2.lastSeenS;
      if (stopped && observedClearance(track2, episode, nowS, ego)) {
        episode.phase = "cleared";
        episode.clearFrameId = track2.frameId;
        episode.clearedAtS = nowS;
      }
    }
    return episode;
  }
  function stopEpisodeDecision(track2, prediction, nowS, ego) {
    if (!track2.stopEpisode) return null;
    const episode = advanceStopEpisode(track2, nowS, ego);
    if (nowS < track2.lastSeenS || nowS - track2.lastSeenS > MAX_AGE_S)
      return decision("stale-stop-observation", false, track2, nowS);
    if (episode.phase === "expired")
      return decision(episode.expiryReason, false, track2, nowS);
    if (episode.phase === "cleared") {
      if (episode.clearFrameId === track2.frameId && observedClearance(track2, episode, nowS, ego))
        return decision("visual-clearance-confirmed", true, track2, nowS);
      return null;
    }
    return {
      ...decision(prediction.conflict ? prediction.reason : episode.stoppedAtS === null ? "committed-visual-stop" : "awaiting-visual-clearance", true, track2, nowS),
      brake: true,
      targetSpeedMps: 0,
      trackId: track2.id,
      confidence: prediction.confidence,
      crossingTimeS: prediction.conflict ? prediction.crossingTimeS : null
    };
  }
  function decideVisualBrake(input = {}) {
    object(input, ["tracks", "nowS", "ego", "enabled"], "visual decision");
    const { tracks = [], nowS, ego, enabled = true } = input;
    number(nowS, 0, 1e9, "nowS");
    odometry(ego);
    if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
    if (!Array.isArray(tracks) || tracks.length > MAX_TRACKS)
      throw new TypeError("visual tracks must be bounded");
    tracks.forEach(validateTrack);
    if (!enabled) return decision("disabled");
    if (!tracks.length) return decision("no-visual-tracks");
    const predictions = tracks.map((track2) => ({ track: track2, value: forecast(track2, nowS, ego) }));
    const episodes = predictions.map(({ track: track2, value }) => stopEpisodeDecision(track2, value, nowS, ego)).filter(Boolean);
    const committed = episodes.find((value) => value.available && value.brake);
    if (committed) return committed;
    const candidates2 = predictions.filter(({ value }) => value.conflict).sort((a, b) => a.value.conflictTimeS - b.value.conflictTimeS || b.value.confidence - a.value.confidence);
    const held = predictions.find(({ track: track2, value }) => value.qualified && value.held && nowS - track2.lastSeenS <= MAX_AGE_S);
    const selected = candidates2[0] ?? held;
    if (selected) {
      const { track: track2, value } = selected;
      return {
        ...decision(value.conflict ? value.reason : "release-hysteresis", true, track2, nowS),
        brake: true,
        targetSpeedMps: 0,
        trackId: track2.id,
        confidence: value.confidence,
        crossingTimeS: value.crossingTimeS ?? Math.max(
          0,
          (track2.conflictCrossingTimeS ?? 0) - (nowS - track2.lastConflictS)
        ),
        evidenceFrameId: value.conflict ? track2.frameId : track2.conflictFrameId
      };
    }
    if (episodes.length) return episodes[0];
    const latest = predictions.sort((a, b) => b.track.lastSeenS - a.track.lastSeenS)[0];
    return decision(latest.value.reason, latest.value.qualified, latest.track, nowS);
  }
  var VisualCrossingPredictor = class {
    constructor({ allowLateClearance = false, freshMotionSupport = false } = {}) {
      this.allowLateClearance = allowLateClearance;
      this.freshMotionSupport = freshMotionSupport;
      this.streamId = null;
      this.tracks = [];
      this.latest = null;
      this.error = null;
      this.nextId = 1;
      this.nowS = 0;
    }
    reset(streamId) {
      token2(streamId, "streamId");
      this.streamId = streamId;
      this.tracks = [];
      this.latest = null;
      this.error = null;
      this.nextId = 1;
      this.nowS = 0;
    }
    observe(result) {
      try {
        resultData(result);
        if (!this.streamId || result.streamId !== this.streamId)
          throw new TypeError("result stream does not match the explicitly reset stream");
        if (this.latest && (result.frameId <= this.latest.frameId || result.simulationTimeS <= this.latest.simulationTimeS))
          throw new TypeError("duplicate or out-of-order visual observation");
        if (this.nowS - result.simulationTimeS > MAX_AGE_S + 1e-8)
          throw new TypeError("visual result is already stale");
        if (result.latencyMs > MAX_AGE_S * 1e3)
          throw new TypeError("visual inference result exceeds the stale latency bound");
        const timeS = result.simulationTimeS;
        this.tracks = this.tracks.filter((track2) => timeS - track2.lastSeenS <= 2);
        const projected = result.detections.map((detection) => ({
          detection,
          projected: project(detection, result.camera)
        })).filter((item) => item.projected);
        const observed = projected.filter(({ detection }) => detection.label === "vehicle" || detection.confidence >= (detection.label === "motion" ? MOTION_CONFIDENCE : PERSON_CONFIDENCE));
        const pairs = [], imagePairs = [];
        observed.forEach((item, index) => {
          this.tracks.forEach((track2) => {
            const age = timeS - track2.lastSeenS;
            if (age > MAX_AGE_S || track2.label !== item.detection.label) return;
            const estimate = fit(track2.history);
            const distance2 = Math.hypot(
              item.projected.x - estimate.position.x - estimate.velocity.x * age,
              item.projected.z - estimate.position.z - estimate.velocity.z * age
            );
            const gate = Math.min(3, 0.55 + MAX_WALK_SPEED * age + Math.min(estimate.uncertaintyM + item.projected.sigmaM, 1.5));
            if (distance2 <= gate) pairs.push({ index, track: track2, distance: distance2 });
            if (this.freshMotionSupport && track2.label !== "vehicle" && !track2.stopEpisode && track2.frameId === this.latest?.frameId && age <= 0.25 + 1e-8 && imageOverlap(track2.box, item.detection.box) >= 0.5) {
              const yaw = result.camera.headingRad;
              const dx = item.projected.x - estimate.position.x - estimate.velocity.x * age;
              const dz = item.projected.z - estimate.position.z - estimate.velocity.z * age;
              if (Math.abs(dx * Math.cos(yaw) - dz * Math.sin(yaw)) <= gate)
                imagePairs.push({ index, track: track2 });
            }
          });
        });
        pairs.sort((a, b) => a.distance - b.distance || a.index - b.index);
        const assignments = /* @__PURE__ */ new Map(), used = /* @__PURE__ */ new Set();
        for (const pair of pairs) {
          if (assignments.has(pair.index) || used.has(pair.track)) continue;
          assignments.set(pair.index, pair.track);
          used.add(pair.track);
        }
        for (const { index, track: track2 } of imagePairs) {
          if (assignments.has(index) || used.has(track2) || imagePairs.some((pair) => pair.index === index !== (pair.track === track2))) continue;
          track2.history = [];
          assignments.set(index, track2);
          used.add(track2);
        }
        observed.forEach(({ detection, projected: projected2 }, index) => {
          let track2 = assignments.get(index);
          if (!track2) {
            if (this.tracks.length >= MAX_TRACKS) return;
            track2 = {
              id: `visual-${this.nextId++}`,
              streamId: this.streamId,
              label: detection.label,
              history: [],
              holdUntilS: null,
              holdSpeedMps: 0,
              lastConflictS: null,
              conflictFrameId: null,
              conflictCrossingTimeS: null,
              stopEpisode: null
            };
            this.tracks.push(track2);
          }
          track2.history.push({ ...projected2, timeS, frameId: result.frameId });
          track2.history = track2.history.filter((sample) => timeS - sample.timeS <= 1.5).slice(-MAX_HISTORY);
          track2.lastSeenS = timeS;
          track2.frameId = result.frameId;
          track2.box = [...detection.box];
          track2.confidence = detection.confidence;
        });
        this.latest = {
          streamId: this.streamId,
          frameId: result.frameId,
          simulationTimeS: timeS,
          latencyMs: result.latencyMs,
          model: { ...result.model },
          detections: result.detections.length,
          projectedDetections: projected.length,
          unprojectableDetections: result.detections.length - projected.length
        };
        this.error = null;
        return {
          accepted: true,
          streamId: this.streamId,
          frameId: result.frameId,
          projectedDetections: projected.length
        };
      } catch (failure) {
        this.error = failure.message;
        throw failure;
      }
    }
    snapshot(nowS, ego) {
      number(nowS, 0, 1e9, "nowS");
      odometry(ego);
      this.nowS = Math.max(this.nowS, nowS);
      const ageMs = this.latest ? (nowS - this.latest.simulationTimeS) * 1e3 : null;
      const status = this.error ? "error" : !this.latest ? "unavailable" : ageMs < -1e-5 ? "error" : ageMs > MAX_AGE_S * 1e3 + 1e-5 ? "stale" : "ready";
      const snapshotTracks = () => this.tracks.map((track2) => publicTrack(track2, nowS, ego, this.freshMotionSupport));
      let tracks = snapshotTracks();
      const available = status === "ready";
      for (const track2 of tracks) {
        if (!track2.stopEpisode) continue;
        const internal = this.tracks.find((item) => item.id === track2.id);
        internal.stopEpisode = advanceStopEpisode(track2, nowS, ego, available, this.allowLateClearance);
      }
      tracks = snapshotTracks();
      let result = available ? decideVisualBrake({ tracks, nowS, ego, enabled: true }) : decision(this.error ? "invalid-visual-result" : status === "stale" ? "stale-visual-result" : status === "error" ? "future-visual-result" : "no-visual-evidence");
      if (!available) {
        result.ageMs = ageMs === null ? null : Math.max(0, ageMs);
        result.evidenceFrameId = this.latest?.frameId ?? null;
      }
      if (result.brake && ["observed-person-crossing-conflict", "observed-motion-crossing-conflict"].includes(result.reason)) {
        const track2 = this.tracks.find((item) => item.id === result.trackId);
        const observed = tracks.find((item) => item.id === result.trackId);
        if (ego.speedMps >= 0.2 && (!track2.stopEpisode || track2.stopEpisode.phase === "cleared"))
          track2.stopEpisode = beginStopEpisode(observed, forecast(observed, nowS, ego), nowS, ego);
        if (track2.conflictFrameId !== track2.frameId) {
          const heldSpeed = track2.holdUntilS !== null && nowS <= track2.holdUntilS ? track2.holdSpeedMps : 0;
          track2.lastConflictS = track2.lastSeenS;
          track2.holdUntilS = track2.lastSeenS + HOLD_S;
          track2.holdSpeedMps = Math.max(heldSpeed, 0, ego.speedMps);
          track2.conflictFrameId = track2.frameId;
          track2.conflictCrossingTimeS = result.crossingTimeS;
          tracks = snapshotTracks();
        }
      }
      return {
        source: SOURCE,
        streamId: this.streamId,
        status,
        available,
        availability: { status, available, error: this.error },
        frameId: this.latest?.frameId ?? null,
        ageMs: ageMs === null ? null : Math.max(0, ageMs),
        model: this.latest ? { ...this.latest.model } : null,
        latencyMs: this.latest?.latencyMs ?? null,
        detections: this.latest?.detections ?? 0,
        projectedDetections: this.latest?.projectedDetections ?? 0,
        unprojectableDetections: this.latest?.unprojectableDetections ?? 0,
        tracks,
        forecasts: available ? tracks.map((track2) => forecast(track2, nowS, ego)) : [],
        decision: result
      };
    }
  };

  // src/core/vision-scenarios.js
  var VISION_CASES = Object.freeze([
    { id: "cross-left", label: "Crossing from left", description: "A visible walker starts across after a short pause." },
    { id: "cross-right", label: "Crossing from right", description: "The mirrored actual crossing, with the same walker and speed." },
    { id: "parallel", label: "Walking along the curb", description: "The same walker moves forward, not into the ego lane." },
    { id: "stationary", label: "Waiting at the curb", description: "The same visible walker remains still." },
    { id: "empty", label: "No walker", description: "The identical road without a pedestrian." }
  ].map(Object.freeze));
  function finite2(value, name, min = -1e5, max = 1e5) {
    if (!Number.isFinite(value) || value < min || value > max)
      throw new TypeError(`${name} is outside its finite bounds`);
  }
  function createVisionScenario(caseId) {
    if (!VISION_CASES.some((item) => item.id === caseId))
      throw new RangeError(`Unknown visual case: ${String(caseId)}`);
    const side = caseId === "cross-right" ? 1 : -1;
    const start = { x: side * 4.8, z: 0 };
    const crossing3 = caseId === "cross-left" || caseId === "cross-right";
    const velocity = { x: crossing3 ? -side * 0.9 : 0, z: caseId === "parallel" ? 0.9 : 0 };
    const destination = crossing3 ? { x: -side * 6.4, z: 0 } : caseId === "parallel" ? { x: start.x, z: 12 } : { ...start };
    const people = caseId === "empty" ? [] : [{
      id: "vision-walker",
      type: "pedestrian",
      kind: "man-polo",
      radius: 0.34,
      ...start,
      heading: crossing3 ? -side * Math.PI / 2 : 0,
      speed: 0,
      walkSpeed: 0.9,
      phase: 0.25,
      distance: 0,
      wait: 0,
      reason: "waiting",
      target: { ...destination },
      script: {
        type: "vision-linear",
        elapsedS: 0,
        onsetS: 0.65,
        velocity,
        destination,
        evaluation: {
          source: "committed-scenario-motion",
          sampleIntervalS: 0.1,
          samples: [],
          droppedSamples: 0
        }
      }
    }];
    const statics = [-1, 1].flatMap((sideSign) => [-39, -23, -7, 9, 25, 41, 57].map((z, i) => ({
      id: `vision-building-${sideSign < 0 ? "west" : "east"}-${i}`,
      type: "static",
      kind: "building",
      x: sideSign * 13,
      z,
      width: 8,
      length: 11,
      height: 10 + i % 3 * 3,
      heading: 0
    })));
    return {
      id: caseId,
      roads: [{ axis: "z", fixed: 0, min: -60, max: 70, width: 10 }],
      statics,
      playerStart: { x: 0, z: -22, heading: 0, speed: 0 },
      people,
      goalZ: 14,
      requestedSpeedMps: 4.5
    };
  }
  function advanceVisionActor(actor, dt, context = {}) {
    finite2(dt, "dt", 0, 0.1);
    if (!actor || actor.type !== "pedestrian" || actor.script?.type !== "vision-linear")
      throw new TypeError("An assigned vision-linear pedestrian is required");
    const script = actor.script;
    for (const key3 of ["x", "z", "heading", "speed", "distance", "wait", "phase"])
      finite2(actor[key3], `actor.${key3}`);
    finite2(script.elapsedS, "elapsedS", 0, 1e9);
    finite2(script.onsetS, "onsetS", 0, 5);
    for (const key3 of ["x", "z"]) {
      finite2(script.velocity[key3], `velocity.${key3}`, -1.5, 1.5);
      finite2(script.destination[key3], `destination.${key3}`, -60, 70);
    }
    if (Math.hypot(script.velocity.x, script.velocity.z) > 1.5)
      throw new TypeError("Scenario walker speed exceeds its physical bound");
    const timeS = context.simulationTimeS ?? context.timeS ?? script.elapsedS;
    finite2(timeS, "simulationTimeS", 0, 1e9);
    const samples = [...script.evaluation.samples];
    const last = samples.at(-1);
    if (last && timeS < last.simulationTimeS)
      throw new TypeError("Evaluation time cannot go backwards");
    if (!last || timeS - last.simulationTimeS >= 0.1 - 1e-8)
      samples.push({ simulationTimeS: timeS, x: actor.x, z: actor.z, speedMps: actor.speed });
    const dropped = Math.max(0, samples.length - 320);
    const nextElapsed = script.elapsedS + dt;
    const activeDt = Math.max(0, nextElapsed - Math.max(script.elapsedS, script.onsetS));
    const remaining = Math.hypot(script.destination.x - actor.x, script.destination.z - actor.z);
    const commandedSpeed = Math.hypot(script.velocity.x, script.velocity.z);
    const travel2 = Math.min(remaining, commandedSpeed * activeDt);
    const moving = travel2 > 1e-10 && commandedSpeed > 0;
    const x = actor.x + (moving ? script.velocity.x / commandedSpeed * travel2 : 0);
    const z = actor.z + (moving ? script.velocity.z / commandedSpeed * travel2 : 0);
    return {
      ...actor,
      x,
      z,
      heading: moving ? Math.atan2(script.velocity.x, script.velocity.z) : actor.heading,
      speed: dt > 0 ? travel2 / dt : 0,
      distance: actor.distance + travel2,
      wait: moving ? 0 : actor.wait + dt,
      reason: moving ? "walking" : nextElapsed < script.onsetS ? "waiting" : "standing",
      target: { ...script.destination },
      script: {
        ...script,
        velocity: { ...script.velocity },
        destination: { ...script.destination },
        elapsedS: nextElapsed,
        evaluation: {
          source: "committed-scenario-motion",
          sampleIntervalS: 0.1,
          samples: samples.slice(-320),
          droppedSamples: script.evaluation.droppedSamples + dropped
        }
      }
    };
  }

  // src/core/egypt-district.js
  var HALF_PI = Math.PI / 2;
  var road = (id, axis, fixed, min, max, width, laneOffsetM, extra = {}) => ({
    id,
    axis,
    fixed,
    min,
    max,
    width,
    laneOffsetM,
    flow: 0,
    speedLimitMps: 5.5,
    marking: "none",
    sideStreet: true,
    ...extra
  });
  function districtRoadPose(street, along2, side = 1) {
    if (![-1, 1].includes(side)) throw new RangeError("District road side must be -1 or 1");
    if (street.flow && arguments.length >= 3 && side !== street.flow)
      throw new RangeError(`Wrong-way pose on ${street.id}`);
    side = street.flow || side;
    if (!Number.isFinite(along2) || along2 < street.min || along2 > street.max)
      throw new RangeError(`Pose is outside ${street.id}`);
    const offset2 = street.laneOffsetM ?? 0;
    return street.axis === "z" ? { x: street.fixed - side * offset2, z: along2, heading: side === 1 ? 0 : Math.PI } : { x: along2, z: street.fixed + side * offset2, heading: side * HALF_PI };
  }
  function crossings(streets) {
    const nodes = [];
    for (let i = 0; i < streets.length; i++) {
      const a = streets[i];
      for (const b of streets.slice(i + 1)) {
        if (a.axis === b.axis) continue;
        const vertical = a.axis === "z" ? a : b, horizontal = a.axis === "x" ? a : b;
        if (horizontal.fixed < vertical.min || horizontal.fixed > vertical.max || vertical.fixed < horizontal.min || vertical.fixed > horizontal.max) continue;
        if (!nodes.some((p) => p.x === vertical.fixed && p.z === horizontal.fixed))
          nodes.push({ x: vertical.fixed, z: horizontal.fixed });
      }
    }
    return nodes;
  }
  function buildingPlots(roads) {
    const plots = [];
    const add = (x, z, width, length, height) => plots.push({ x, z, width, length, height });
    [-49, -35, -21, -6, 10, 26, 42, 56].forEach((x, i) => add(x, -52.5, i % 2 ? 11 : 12, 8, 11 + i % 4 * 2.6));
    [-44, -29, -14, 2, 17, 33, 49].forEach((x, i) => add(x, 48.5, 11 + i % 2, 8, 11 + (i + 2) % 4 * 2.6));
    [-32, -17, 12, 28].forEach((z, i) => {
      add(-56.5, z, 8, 11, 12 + i % 3 * 2.6);
      add(64.5, z, 8, 11, 11 + (i + 1) % 4 * 2.6);
    });
    add(-34, -30, 10, 9, 15.6);
    add(-34, -9.8, 10, 7, 13);
    add(-34, -18.5, 10, 10, 18.2);
    add(-20.8, -29, 12.8, 8.6, 15.6);
    add(-20.8, -15.55, 12.8, 13.7, 18.2);
    add(-3.2, -29, 12.8, 8.6, 13);
    add(-3.2, -10.1, 12.8, 2.8, 10.4);
    add(1, -18.5, 8, 7, 13);
    for (const [x, width] of [[12, 12], [27, 12], [42, 11]]) {
      add(x, -30, width, 10, 11 + x % 3 * 2.6);
      add(x, -15, width, 13, 15.6);
    }
    for (const [x, width] of [[-34, 10], [-20, 12], [-5, 12]]) {
      add(x, 11, width, 10, 13);
      add(x, 26, width, 10, 15.6);
    }
    add(10.4, 19, 14.2, 17, 15.6);
    add(28, 19, 11, 17, 18.2);
    for (const z of [11, 26]) add(42, z, 11, 10, z === 11 ? 15.6 : 11);
    const exclusions = roads.map((r) => {
      const b = roadRect(r);
      return {
        x: (b.minX + b.maxX) / 2,
        z: (b.minZ + b.maxZ) / 2,
        width: b.maxX - b.minX,
        length: b.maxZ - b.minZ,
        heading: 0
      };
    });
    return plots.map((plot, i) => ({
      id: `district-building-${i}`,
      type: "static",
      kind: "building",
      heading: 0,
      ...plot
    })).filter((plot) => !exclusions.some((r) => overlaps(plot, r, 0.3)));
  }
  function makeWalkways(streets) {
    return streets.flatMap((street) => [-1, 1].map((side) => {
      const shared = street.width < 4;
      const offset2 = street.id === "alley-west" && side === -1 ? 1.2 : street.id === "east-connector" && side === -1 ? 3.6 : shared ? 1.75 : street.width / 2 + 1.15;
      return {
        id: `${street.id}-walk-${side}`,
        roadId: street.id,
        axis: street.axis,
        fixed: street.fixed + (street.axis === "z" ? -side : side) * offset2,
        min: street.min + 7,
        max: street.max - 7,
        side,
        shared
      };
    })).concat([
      {
        id: "van-doorway",
        roadId: "alley-west",
        axis: "x",
        fixed: -14.7,
        min: -10.8,
        max: -7.5,
        side: -1,
        shared: true,
        doorway: true
      },
      {
        id: "van-rear-walk",
        roadId: "alley-west",
        axis: "z",
        fixed: -7.5,
        min: -20.8,
        max: -14.7,
        side: -1,
        shared: true,
        doorway: true
      },
      {
        id: "west-doorway",
        roadId: "alley-west",
        axis: "x",
        fixed: -23,
        min: -15.1,
        max: -13.75,
        side: 1,
        shared: true,
        doorway: true
      },
      {
        id: "visible-crossing",
        roadId: "alley-west",
        axis: "x",
        fixed: -23,
        min: -14.7,
        max: -9.3,
        side: 1,
        shared: true,
        doorway: true
      },
      {
        id: "case-left-walk",
        roadId: "alley-west",
        axis: "x",
        fixed: -23.5,
        min: -14.7,
        max: -13.75,
        side: 1,
        shared: true,
        doorway: true
      },
      {
        id: "case-right-walk",
        roadId: "alley-west",
        axis: "z",
        fixed: -9.3,
        min: -23,
        max: -22,
        side: -1,
        shared: true,
        doorway: true
      }
    ]);
  }
  function makeCaseAnchors(district) {
    const start = { x: -12, z: -33, heading: 0 };
    const goal = { x: -12, z: -7, heading: 0, roadId: "alley-west" };
    const left = { x: -14.7, z: -23, heading: HALF_PI };
    const right = { x: -9.3, z: -23, heading: -HALF_PI };
    const hidden = { x: -7.5, z: -18.7, heading: -HALF_PI };
    const emergence = { ...hidden, z: -16.8 };
    const emergenceTarget = { x: -13.75, z: -14.7 };
    const specs = [
      ["visible-left", left, right, 2, null],
      ["visible-right", right, left, 2, null],
      ["diagonal-hesitant", { ...left, z: -23.5 }, { ...right, z: -22 }, 2, null],
      ["partial-occluded-history", { ...hidden, z: -14.7 }, { x: -13.75, z: -14.7 }, 1, "same-occluder-empty"],
      ["fully-hidden-emergence", emergence, emergenceTarget, 0.5, "same-occluder-empty"],
      ["same-occluder-empty", emergence, emergenceTarget, 0.5, "fully-hidden-emergence"],
      [
        "stationary-curb",
        { x: -13.75, z: -18.7, heading: 0 },
        { x: -13.75, z: -18.7, heading: 0 },
        0,
        null
      ],
      [
        "parallel-away",
        { x: -13.75, z: -20.5, heading: 0 },
        { x: -13.75, z: -9, heading: 0 },
        0,
        null
      ],
      ["blind-corner-empty", hidden, left, 5, "fully-hidden-emergence"],
      [
        "two-car-narrow-passage",
        { x: 8, z: -1.4, heading: -HALF_PI },
        { x: 4, z: -40.5, heading: HALF_PI },
        0,
        null
      ],
      ["queue-alternate-route", left, right, 0, null],
      ["camera-loss-recovery", left, right, 2, null]
    ];
    return specs.map(([id, actorStart, actorTarget, triggerEgoAlongM, emptyTwin]) => ({
      id,
      matrixCase: id,
      routeId: "bakery-via-west-alley",
      roadId: "alley-west",
      occluderId: "district-parked-van",
      playerStart: { ...start },
      goal: { ...goal },
      actorStart: { ...actorStart },
      actorTarget: { ...actorTarget },
      triggerEgoAlongM,
      emptyTwin,
      traffic: [],
      ...id === "two-car-narrow-passage" ? {
        playerStart: { x: -32, z: -40.5, heading: HALF_PI },
        goal: { ...district.places[0] },
        waitingZoneId: "west-alley-passage",
        traffic: [{
          id: "district-opposing-car",
          kind: "sedan",
          start: { ...actorStart, roadId: "market-local" },
          goal: { ...district.places[2] }
        }]
      } : id === "queue-alternate-route" ? {
        playerStart: { ...district.playerStart },
        goal: { ...district.places[0] },
        traffic: [{
          id: "district-loading-car",
          kind: "van",
          start: { x: -31, z: -40.5, heading: HALF_PI, roadId: "entry-local" },
          goal: { ...district.places[1] }
        }]
      } : {}
    }));
  }
  function createEgyptDistrict() {
    const drivingRoads = [
      road("entry-local", "x", -42, -58, 54, 6.4, 1.5),
      road("west-local", "z", -46, -42, 38, 6.2, 1.5),
      road("school-local", "x", 38, -46, 54, 6.2, 1.5),
      road("east-connector", "z", 54, -42, 38, 6.4, 1.5),
      road("market-local", "x", 0, -46, 54, 6, 1.4, { speedLimitMps: 4.5 }),
      road("alley-west", "z", -12, -42, 0, 3.8, 0, { speedLimitMps: 3.8 }),
      road(
        "alley-east",
        "z",
        20,
        0,
        38,
        3.6,
        0,
        { flow: 1, speedLimitMps: 3.5 }
      )
    ];
    const nodes = crossings(drivingRoads);
    const aprons = nodes.map((p, i) => {
      const inward = p.x === -12 ? p.z === -42 ? 2.2 : -2.2 : p.x === 20 ? p.z === 0 ? 2.2 : -2.2 : 0;
      return road(`turn-mouth-${i}`, "z", p.x, p.z + inward, p.z + inward, 12, 0, {
        parkingBay: true,
        supportApron: true,
        speedLimitMps: 4.5,
        junctionX: p.x,
        junctionZ: p.z
      });
    });
    const roads = [...drivingRoads, ...aprons];
    const playerStart = { x: -56, z: -40.5, heading: HALF_PI, roadId: "entry-local" };
    const places = [
      {
        id: "district-bakery",
        name: "\u0627\u0644\u0641\u0631\u0646 \u0627\u0644\u0628\u0644\u062F\u064A",
        x: 4,
        z: 1.4,
        heading: HALF_PI,
        roadId: "market-local"
      },
      {
        id: "district-school",
        name: "\u0645\u062F\u0631\u0633\u0629 \u0627\u0644\u062D\u064A",
        x: 36,
        z: 39.5,
        heading: HALF_PI,
        roadId: "school-local"
      },
      {
        id: "district-workshop",
        name: "\u0648\u0631\u0634\u0629 \u0627\u0644\u062D\u0627\u0631\u0629",
        x: 4,
        z: -40.5,
        heading: HALF_PI,
        roadId: "entry-local"
      }
    ];
    const statics = buildingPlots(roads);
    statics.push(
      {
        id: "district-parked-van",
        type: "static",
        kind: "parked-vehicle",
        vehicleKind: "van",
        x: -9.15,
        z: -18.7,
        heading: 0,
        width: 1.9,
        length: 4.6,
        height: 2.12
      },
      {
        id: "district-parked-sedan",
        type: "static",
        kind: "parked-vehicle",
        vehicleKind: "sedan",
        x: 59.4,
        z: 12,
        heading: Math.PI,
        width: 1.85,
        length: 4.2,
        height: 1.48
      },
      {
        id: "district-produce",
        type: "static",
        kind: "market-stall",
        x: -27.5,
        z: 5.8,
        heading: Math.PI,
        width: 2.5,
        length: 1.7,
        height: 2.3
      }
    );
    const conflictZones = nodes.filter((p) => p.x !== -12).map((p, i) => ({
      id: `district-junction-${i}`,
      kind: "junction",
      ...roadRect(aprons.find((r) => r.junctionX === p.x && r.junctionZ === p.z)),
      approachM: 8
    }));
    conflictZones.push({
      id: "west-alley-passage",
      kind: "single-lane",
      minX: -18,
      maxX: -6,
      minZ: -48,
      maxZ: 6,
      approachM: 8,
      waitingSpots: [
        { x: -22, z: -40.5, heading: HALF_PI, approach: "south-west" },
        { x: -2, z: -43.5, heading: -HALF_PI, approach: "south-east" },
        { x: -22, z: 1.4, heading: HALF_PI, approach: "north-west" },
        { x: -2, z: -1.4, heading: -HALF_PI, approach: "north-east" }
      ]
    });
    const cautionZones = [
      {
        id: "van-frontage-north",
        x: -12,
        z: -17,
        heading: 0,
        approachM: 18,
        clearanceM: 6,
        visibilityDistanceM: 8,
        speedLimitMps: 3
      },
      {
        id: "west-alley-north-mouth",
        x: -12,
        z: -1,
        heading: 0,
        approachM: 14,
        clearanceM: 5,
        visibilityDistanceM: 7,
        speedLimitMps: 3
      },
      {
        id: "west-alley-south-mouth",
        x: -12,
        z: -41,
        heading: Math.PI,
        approachM: 14,
        clearanceM: 5,
        visibilityDistanceM: 7,
        speedLimitMps: 3
      },
      {
        id: "school-alley-mouth",
        x: 20,
        z: 37,
        heading: 0,
        approachM: 14,
        clearanceM: 5,
        visibilityDistanceM: 7.5,
        speedLimitMps: 3
      }
    ];
    const trafficGoals = [];
    for (const [id, positions] of [
      ["entry-local", [-31, 4, 35]],
      ["west-local", [-24, 19]],
      ["school-local", [-30, 3, 37]],
      ["east-connector", [-24, 19]],
      ["market-local", [-30, 4, 37]]
    ]) {
      const street = drivingRoads.find((r) => r.id === id);
      for (const along2 of positions)
        for (const side of [-1, 1])
          trafficGoals.push({
            id: `${id}-goal-${along2}-${side}`,
            roadId: id,
            ...districtRoadPose(street, along2, side)
          });
    }
    const trafficSpawns = [];
    const shape2 = { type: "vehicle", length: 4.2, width: 1.85, heading: 0 };
    for (const id of ["entry-local", "school-local", "west-local", "east-connector", "market-local"]) {
      const street = drivingRoads.find((r) => r.id === id);
      for (let along2 = street.min + 12; along2 <= street.max - 11; along2 += 10)
        for (const side of [1, -1]) {
          const candidate = { ...districtRoadPose(street, along2, side), roadId: id };
          const body = { ...shape2, ...candidate };
          if (distance(candidate, playerStart) < 14 || !bodyOnRoad(body, roads, 0.12) || statics.some((s) => overlaps(body, s, 0.12)) || trafficSpawns.some((s) => overlaps(body, { ...shape2, ...s }, 0.8)) || conflictZones.some((zone) => overlaps(body, {
            x: (zone.minX + zone.maxX) / 2,
            z: (zone.minZ + zone.maxZ) / 2,
            width: zone.maxX - zone.minX,
            length: zone.maxZ - zone.minZ,
            heading: 0
          }, 0.3))) continue;
          trafficSpawns.push(candidate);
        }
    }
    const walkways = makeWalkways(drivingRoads);
    const pedestrianSpawns = [];
    for (let round = 0; round < 20; round++)
      for (const walkway of walkways.filter((w) => !w.doorway)) {
        const along2 = walkway.min + 1 + round * 7;
        if (along2 > walkway.max - 1) continue;
        const candidate = {
          x: walkway.axis === "z" ? walkway.fixed : along2,
          z: walkway.axis === "x" ? walkway.fixed : along2,
          heading: walkway.axis === "z" ? 0 : HALF_PI,
          roadId: walkway.roadId,
          walkwayId: walkway.id,
          side: walkway.side,
          along: along2
        };
        const body = { ...candidate, type: "pedestrian", radius: 0.38 };
        if (statics.some((s) => overlaps(body, s, 0.12)) || overlaps(body, { ...shape2, ...playerStart }, 0.12) || trafficSpawns.some((s) => overlaps(body, { ...shape2, ...s }, 0.12)) || pedestrianSpawns.some((s) => distance(s, body) < 1)) continue;
        pedestrianSpawns.push(candidate);
      }
    if (trafficSpawns.length < 28 || pedestrianSpawns.length < 32)
      throw new Error(`District authored capacity is too small: ${trafficSpawns.length}/${pedestrianSpawns.length}`);
    const showcaseRoutes = places.map((goal, i) => ({
      id: ["bakery-via-west-alley", "school-via-east-alley", "workshop-via-west-alley"][i],
      start: { ...i ? places[i - 1] : playerStart },
      goal: { ...goal },
      mustUseRoadIds: [i === 1 ? "alley-east" : "alley-west"]
    }));
    const district = {
      id: "egypt-district-v1",
      version: 1,
      drivingRoads,
      roads,
      statics,
      places,
      playerStart,
      trafficSpawns,
      pedestrianSpawns,
      trafficGoals,
      walkways,
      conflictZones,
      cautionZones,
      showcaseRoutes
    };
    district.caseAnchors = makeCaseAnchors(district);
    return district;
  }

  // src/core/unified-city.js
  var HALF_PI2 = Math.PI / 2;
  var GATE_X = -96;
  var SOUTH_LINK_X = -32;
  var SOUTH_LINK = "bab-el-louk-link";
  var START_ROAD = "tahrir-boulevard";
  var CAR = { type: "vehicle", width: VEHICLE.width, length: VEHICLE.length };
  var WALKER = { type: "pedestrian", radius: 0.38 };
  var LEGACY_POPULATION_LIMITS = { traffic: 72, pedestrians: 96 };
  var METRO_POPULATION_LIMITS = Object.freeze({ traffic: 96, pedestrians: 120 });
  var RUSH_CITY_POPULATION_LIMITS = Object.freeze({ traffic: 96, pedestrians: 144 });
  var RUSH_CITY_POPULATION_DEFAULTS = Object.freeze({ traffic: 36, pedestrians: 80 });
  var avenue = (id, axis, fixed, min, max, width, laneOffsetM, speedLimitMps) => ({
    id,
    axis,
    fixed,
    min,
    max,
    width,
    laneOffsetM,
    speedLimitMps,
    flow: 0,
    zone: "avenue",
    marking: "center"
  });
  var local = (id, axis, fixed, min, max, width, laneOffsetM, speedLimitMps) => ({
    ...avenue(id, axis, fixed, min, max, width, laneOffsetM, speedLimitMps),
    zone: "neighborhood",
    marking: "none",
    sideStreet: true
  });
  var lane = (road4, along2, side = 1) => ({
    ...districtRoadPose(road4, along2, side),
    roadId: road4.id
  });
  var box2 = ({ minX, maxX, minZ, maxZ }) => ({
    x: (minX + maxX) / 2,
    z: (minZ + maxZ) / 2,
    width: maxX - minX,
    length: maxZ - minZ,
    heading: 0
  });
  var sidewalkPreference = (road4) => road4.zone === "avenue" ? "avenue" : "market";
  var position = (line, along2) => line.axis === "z" ? { x: line.fixed, z: along2 } : { x: along2, z: line.fixed };
  var crossing = (a, b) => a.axis !== b.axis && a.fixed >= b.min && a.fixed <= b.max && b.fixed >= a.min && b.fixed <= a.max;
  function avenueNetwork() {
    return [
      avenue("corniche-avenue", "z", -278, -112, 90, 14, 2.7, 10.5),
      avenue("civic-avenue", "z", -183, -112, 90, 12, 2.5, 9.5),
      avenue("gateway-avenue", "z", GATE_X, -112, 90, 12, 2.5, 9),
      avenue(START_ROAD, "x", -112, -278, SOUTH_LINK_X, 14, 2.7, 10.5),
      avenue("station-avenue", "x", -75, -278, GATE_X, 12, 2.5, 9.5),
      local("souq-collector", "x", 8, -278, GATE_X, 10, 2.2, 6.5),
      avenue("university-avenue", "x", 90, -278, GATE_X, 12, 2.5, 9.5),
      local(SOUTH_LINK, "z", SOUTH_LINK_X, -112, -42, 8.6, 2, 6.5)
    ];
  }
  function newJunctionAprons(added, drivingRoads) {
    const junctions = /* @__PURE__ */ new Map(), newIds = new Set(added.map((road4) => road4.id));
    for (const vertical of drivingRoads.filter((road4) => road4.axis === "z"))
      for (const horizontal of drivingRoads.filter((road4) => road4.axis === "x")) {
        if (!newIds.has(vertical.id) && !newIds.has(horizontal.id) || !crossing(vertical, horizontal)) continue;
        const { fixed: x } = vertical, { fixed: z } = horizontal;
        junctions.set(`${x}:${z}`, {
          id: `metro-mouth-${x}-${z}`,
          axis: "z",
          fixed: x,
          min: z,
          max: z,
          width: 16,
          laneOffsetM: 0,
          flow: 0,
          speedLimitMps: 4.5,
          zone: vertical.zone === "avenue" || horizontal.zone === "avenue" ? "avenue" : "neighborhood",
          marking: "none",
          parkingBay: true,
          supportApron: true,
          junctionX: x,
          junctionZ: z
        });
      }
    return [...junctions.values()];
  }
  function newWalkways(frontages) {
    return frontages.flatMap((street) => [-1, 1].map((side) => ({
      id: `${street.id}-metro-walk-${side}`,
      roadId: street.id,
      axis: street.axis,
      fixed: street.fixed + (street.axis === "z" ? -side : side) * (street.width / 2 + 1.65),
      min: street.min + 7,
      max: street.max - 7,
      side,
      shared: false,
      roadPreference: sidewalkPreference(street)
    })));
  }
  function newBuildings(frontages, roads, walkways, original) {
    const reserved = [
      ...roads.map((road4) => box2(roadRect(road4))),
      ...walkways.map((line) => box2(roadRect({ ...line, width: 1.7 }))),
      ...original
    ];
    const buildings = [];
    for (const [index, street] of frontages.entries()) {
      const architecture = street.zone === "avenue" ? "boulevard" : "neighborhood";
      for (const side of [-1, 1])
        for (let i = 0, along2 = street.min + 22 + (side + 1) * 2; along2 <= street.max - 12; i++, along2 += 32) {
          const style = (i * 3 + index + (side > 0 ? 2 : 0)) % 5;
          const width = [16, 20, 23, 18, 22][style];
          const length = [14, 17, 15, 19, 16][style];
          const fixed = street.fixed + side * (street.width / 2 + 3.4 + length / 2);
          const site = {
            ...position({ ...street, fixed }, along2),
            id: `${street.id}-frontage-${side}-${i}`,
            type: "static",
            kind: "building",
            architecture,
            width,
            length,
            height: architecture === "boulevard" ? [23, 28, 19, 33, 25][style] : [11, 16, 12, 18, 14][style],
            heading: street.axis === "z" ? -side * HALF_PI2 : side === 1 ? Math.PI : 0
          };
          if (!reserved.some((other) => overlaps(site, other, 0.35))) {
            buildings.push(site);
            reserved.push(site);
          }
        }
    }
    return buildings;
  }
  function streetSpans(road4, streets) {
    const cuts = [.../* @__PURE__ */ new Set([
      road4.min,
      road4.max,
      ...streets.filter((other) => crossing(road4, other)).map((other) => other.fixed)
    ])].sort((a, b) => a - b);
    return cuts.slice(1).map((max, i) => ({ road: road4, min: cuts[i], max }));
  }
  function interleave(groups) {
    const results = [];
    for (let index = 0; index < Math.max(...groups.map((group) => group.length)); index++)
      for (const group of groups)
        if (index < group.length) results.push(group[index]);
    return results;
  }
  function spreadByRoad(poses) {
    const groups = /* @__PURE__ */ new Map();
    for (const pose5 of poses) {
      if (!groups.has(pose5.roadId)) groups.set(pose5.roadId, []);
      groups.get(pose5.roadId).push(pose5);
    }
    return interleave([...groups.values()]);
  }
  function populateTraffic(city, widerSpans, originalSpawns, target) {
    const vehicles = [], conflictBodies = city.conflictZones.map(box2);
    const positions = [0.5, 0.28, 0.72, 0.15, 0.85];
    const candidates2 = positions.flatMap((fraction) => [-1, 1].flatMap((side) => widerSpans.flatMap(({ road: road4, min, max }, index) => {
      const sign = index % 2 ? -side : side;
      if (road4.id === START_ROAD && min < city.playerStart.x && sign === 1) return [];
      return [lane(road4, min + fraction * (max - min), sign)];
    })));
    const avenueIds = new Set(city.drivingRoads.filter((road4) => road4.zone === "avenue").map((road4) => road4.id));
    const avenues = candidates2.filter((pose5) => avenueIds.has(pose5.roadId));
    const local2 = candidates2.filter((pose5) => !avenueIds.has(pose5.roadId));
    const inherited = spreadByRoad(originalSpawns);
    const groups = [
      avenues.filter((_, i) => i % 4 === 0),
      avenues.filter((_, i) => i % 4 === 1),
      interleave([local2, inherited]),
      avenues.filter((_, i) => i % 4 === 2),
      avenues.filter((_, i) => i % 4 === 3)
    ];
    for (const pose5 of interleave(groups)) {
      const body = { ...CAR, ...pose5 };
      if (distance(pose5, city.playerStart) < 14 || !bodyOnRoad(body, city.roads, 0.12) || city.statics.some((other) => overlaps(body, other, 0.12)) || conflictBodies.some((other) => overlaps(body, other, 0.45)) || vehicles.some((other) => overlaps(body, { ...CAR, ...other }, 0.8) || pose5.roadId === other.roadId && pose5.heading === other.heading && distance(pose5, other) < 12))
        continue;
      vehicles.push(pose5);
      if (vehicles.length === target) break;
    }
    return vehicles;
  }
  function populateWalkers(city, original, addedWalkways, target) {
    const avenues = addedWalkways.filter((line) => line.roadPreference === "avenue");
    const local2 = addedWalkways.filter((line) => line.roadPreference === "market");
    const addedSpawns = (lines) => Array.from({ length: 16 }, (_, round) => lines.map((line, i) => {
      const fraction = ((round * 7 + i * 5 + 2) % 17 + 0.5) / 17;
      const along2 = line.min + 1 + fraction * (line.max - line.min - 2);
      return {
        ...position(line, along2),
        along: along2,
        side: line.side,
        roadId: line.roadId,
        heading: line.axis === "z" ? 0 : HALF_PI2,
        walkwayId: line.id,
        roadPreference: line.roadPreference
      };
    })).flat();
    const locals = addedSpawns(local2), boulevard = addedSpawns(avenues);
    const old = spreadByRoad(original).map((pose5) => ({ ...pose5, roadPreference: "market" }));
    const candidates2 = interleave([
      boulevard.filter((_, i) => i % 2 === 0),
      old,
      boulevard.filter((_, i) => i % 2 !== 0),
      locals
    ]);
    const vehicles = city.trafficSpawns.map((spawn) => ({ ...CAR, ...spawn }));
    const player = { ...CAR, ...city.playerStart, length: PLAYER_VEHICLE.lengthM, width: PLAYER_VEHICLE.widthM };
    const pavement = target > METRO_POPULATION_LIMITS.pedestrians ? city.roads.map((road4) => ({ ...box2(roadRect(road4)), id: road4.id })) : [];
    const pedestrians = [];
    for (const pose5 of candidates2) {
      const body = { ...WALKER, ...pose5 };
      if (city.statics.some((other) => overlaps(body, other, 0.12)) || overlaps(body, player, 0.12) || vehicles.some((other) => overlaps(body, other, 0.12)) || pedestrians.some((other) => distance(pose5, other) < 1.4)) continue;
      if (pedestrians.length >= METRO_POPULATION_LIMITS.pedestrians) {
        const line = city.walkways.find(({ id }) => id === pose5.walkwayId);
        if (pavement.some((road4) => (!line.shared || road4.id !== line.roadId) && overlaps(body, road4, 0.12))) continue;
      }
      pedestrians.push(pose5);
      if (pedestrians.length === target) break;
    }
    return pedestrians;
  }
  function createUnifiedCity({ dense = false, rush = false } = {}) {
    const district = createEgyptDistrict(), added = avenueNetwork();
    const inherited = district.drivingRoads.map((road4) => ({
      ...road4,
      zone: "neighborhood",
      min: road4.id === "school-local" ? GATE_X : road4.min
    }));
    const drivingRoads = [...inherited, ...added];
    const roadById = new Map(drivingRoads.map((road4) => [road4.id, road4]));
    const aprons = newJunctionAprons(added, drivingRoads);
    const roads = [
      ...drivingRoads,
      ...district.roads.filter((road4) => road4.supportApron).map((road4) => ({ ...road4, zone: "neighborhood" })),
      ...aprons
    ];
    const frontages = [...added, { ...roadById.get("school-local"), max: -64 }];
    const addedWalkways = newWalkways(frontages);
    const walkways = [
      ...district.walkways.map((line) => ({ ...line, roadPreference: "market" })),
      ...addedWalkways
    ];
    const newPavement = [...added, ...aprons].map((road4) => box2(roadRect(road4)));
    const oldStatics = district.statics.flatMap((site) => {
      if (site.kind !== "building") return [site];
      return newPavement.some((paved) => overlaps(site, paved, 0.35)) ? [] : [{ ...site, architecture: "neighborhood" }];
    });
    const statics = [...oldStatics, ...newBuildings(frontages, roads, walkways, oldStatics)];
    const playerStart = lane(roadById.get(START_ROAD), -254);
    const cityAnchors = {
      downtown: [START_ROAD, -148, 1],
      market: ["souq-collector", -225, 1],
      station: ["station-avenue", -137, -1],
      hospital: ["civic-avenue", 56, 1],
      university: ["university-avenue", -126, 1],
      corniche: ["corniche-avenue", -34, -1]
    };
    const places = [...district.places, ...PLACES.map(({ id, name }) => {
      const [roadId, along2, side] = cityAnchors[id];
      return { id, name, ...lane(roadById.get(roadId), along2, side) };
    })];
    const widerSpans = interleave(added.map((road4) => streetSpans(road4, drivingRoads)));
    const widerGoals = widerSpans.flatMap(({ road: road4, min, max }) => [-1, 1].map((side) => ({
      id: `${road4.id}-goal-${min}-${side}`,
      ...lane(road4, (min + max) / 2, side)
    })));
    const exitSites = [
      ["tahrir-east", START_ROAD, -209, 1],
      ["tahrir-west", START_ROAD, -217, -1],
      ["station-west", "station-avenue", -232, -1],
      ["south-link", SOUTH_LINK, -74, 1],
      ["gate-south", "gateway-avenue", -57, -1],
      ["gate-north", "gateway-avenue", 61, 1],
      ["riverside", "corniche-avenue", -26, 1],
      ["station", "station-avenue", -139, -1],
      ["east-local", "east-connector", 20, 1],
      ["school-side", "school-local", -30, -1],
      ["market-side", "market-local", 36, 1],
      ["workshops", "entry-local", 32, -1]
    ];
    const pursuitExits = exitSites.map(([name, roadId, along2, side]) => ({
      id: `metro-exit-${name}`,
      ...lane(roadById.get(roadId), along2, side)
    }));
    const city = {
      ...district,
      id: "unified-city-v1",
      version: 1,
      drivingRoads,
      roads,
      statics,
      places,
      ...rush ? { rush: true } : {},
      playerStart,
      walkways,
      pursuitExits,
      trafficGoals: [...district.trafficGoals, ...widerGoals],
      conflictZones: [...district.conflictZones, ...aprons.map((road4) => ({
        id: `${road4.id}-conflict`,
        kind: "junction",
        ...roadRect(road4),
        approachM: 8
      }))],
      showcaseRoutes: [{
        id: "boulevard-to-bakery",
        start: { ...playerStart },
        goal: { ...places[0] },
        mustUseRoadIds: [START_ROAD, "alley-west"]
      }, ...district.showcaseRoutes]
    };
    const capacity = rush ? RUSH_CITY_POPULATION_LIMITS : dense ? METRO_POPULATION_LIMITS : LEGACY_POPULATION_LIMITS;
    city.trafficSpawns = populateTraffic(city, widerSpans, district.trafficSpawns, capacity.traffic);
    city.pedestrianSpawns = populateWalkers(city, district.pedestrianSpawns, addedWalkways, capacity.pedestrians);
    if (city.trafficSpawns.length < capacity.traffic || city.pedestrianSpawns.length < capacity.pedestrians)
      throw new Error(`Insufficient metro spawn capacity: ${city.trafficSpawns.length}/${city.pedestrianSpawns.length}`);
    return city;
  }

  // src/core/district-navigation.js
  var RADIUS_M = 3.8;
  var SAMPLE_M = 0.35;
  var EXIT_COMPENSATION_M = 0.5;
  var RECOVERY_M = 8;
  var geometryCache = /* @__PURE__ */ new WeakMap();
  var key2 = (p) => `${p.x.toFixed(5)},${p.z.toFixed(5)}`;
  var dot = (a, b) => a.x * b.x + a.z * b.z;
  var shift = (p, direction3, amount) => ({
    x: p.x + direction3.x * amount,
    z: p.z + direction3.z * amount
  });
  var heading = (v) => Math.atan2(v.x, v.z);
  function graphFor(district, body) {
    const signature = JSON.stringify([district.drivingRoads, district.roads, district.statics]);
    let cached = geometryCache.get(district);
    if (!cached || cached.signature !== signature) {
      cached = { signature, shapes: /* @__PURE__ */ new Map() };
      geometryCache.set(district, cached);
    }
    const shapeKey = `${body.length}:${body.width}`;
    if (cached.shapes.has(shapeKey)) return cached.shapes.get(shapeKey);
    const roads = district.drivingRoads.filter((r) => !r.parkingBay && !r.supportApron && r.width >= body.width + 0.24);
    const nodes = /* @__PURE__ */ new Map(), links = [];
    const put = (p) => {
      const id = key2(p);
      if (!nodes.has(id)) nodes.set(id, { ...p, id, incoming: [], outgoing: [] });
      return nodes.get(id);
    };
    for (const road4 of roads) {
      const cuts = /* @__PURE__ */ new Set([road4.min, road4.max]);
      for (const other of roads) {
        if (road4.axis === other.axis) continue;
        if (other.fixed >= road4.min && other.fixed <= road4.max && road4.fixed >= other.min && road4.fixed <= other.max) cuts.add(other.fixed);
      }
      const along2 = [...cuts].sort((a, b) => a - b);
      const at = (value) => put(road4.axis === "z" ? { x: road4.fixed, z: value } : { x: value, z: road4.fixed });
      for (let i = 1; i < along2.length; i++) {
        const a = at(along2[i - 1]), b = at(along2[i]);
        for (const sign of road4.flow ? [road4.flow] : [1, -1]) {
          const from = sign === 1 ? a : b, to = sign === 1 ? b : a;
          const length = distance(from, to);
          const direction3 = { x: (to.x - from.x) / length, z: (to.z - from.z) / length };
          const normal2 = { x: -direction3.z, z: direction3.x };
          const link = {
            id: `${road4.id}:${sign}:${from.id}>${to.id}`,
            road: road4,
            sign,
            from,
            to,
            length,
            direction: direction3,
            normal: normal2,
            offset: road4.laneOffsetM ?? 0,
            heading: heading(direction3),
            turnCache: /* @__PURE__ */ new Map()
          };
          links.push(link);
          from.outgoing.push(link);
          to.incoming.push(link);
        }
      }
    }
    const graph = { nodes, links };
    if (cached.shapes.size >= 8) cached.shapes.clear();
    cached.shapes.set(shapeKey, graph);
    return graph;
  }
  function laneAt(link, along2) {
    return shift(shift(link.from, link.direction, along2), link.normal, link.offset);
  }
  function append(path, point2) {
    const from = path.at(-1);
    if (!from) {
      path.push({ x: point2.x, z: point2.z });
      return;
    }
    const length = distance(from, point2);
    if (length < 1e-8) return;
    const count = Math.ceil(length / SAMPLE_M);
    for (let i = 1; i <= count; i++) path.push({
      x: from.x + (point2.x - from.x) * i / count,
      z: from.z + (point2.z - from.z) * i / count
    });
  }
  function turnBetween(incoming, outgoing) {
    const bend = angleDelta(outgoing.heading, incoming.heading);
    if (Math.abs(bend) > Math.PI * 0.75) return null;
    if (Math.abs(bend) < 0.01) {
      if (incoming.road.id !== outgoing.road.id) return null;
      const point2 = laneAt(incoming, incoming.length);
      return { start: point2, end: point2, points: [point2], bend, inset: 0, outset: 0 };
    }
    const inLane = laneAt(incoming, incoming.length), outLane = laneAt(outgoing, 0);
    const intersection = incoming.road.axis === "z" ? { x: inLane.x, z: outLane.z } : { x: outLane.x, z: inLane.z };
    const start = shift(intersection, incoming.direction, -RADIUS_M);
    const end = shift(intersection, outgoing.direction, RADIUS_M);
    const center = shift(start, outgoing.direction, RADIUS_M);
    const first = Math.atan2(start.z - center.z, start.x - center.x);
    const last = Math.atan2(end.z - center.z, end.x - center.x);
    const arc = angleDelta(last, first);
    const points = [];
    const steps = Math.ceil(Math.abs(arc) * RADIUS_M / SAMPLE_M);
    const inside = -Math.sign(bend) * EXIT_COMPENSATION_M;
    for (let i = 0; i <= steps; i++) {
      const a = first + arc * i / steps;
      const t = i / steps, correction = inside * t * t * (3 - 2 * t);
      points.push({
        x: center.x + Math.cos(a) * RADIUS_M + outgoing.normal.x * correction,
        z: center.z + Math.sin(a) * RADIUS_M + outgoing.normal.z * correction,
        heading: incoming.heading + bend * i / steps
      });
    }
    return {
      start,
      end: shift(end, outgoing.normal, inside),
      points,
      bend,
      recovery: shift(end, outgoing.direction, RECOVERY_M),
      inset: dot({ x: inLane.x - start.x, z: inLane.z - start.z }, incoming.direction),
      outset: dot({ x: end.x - outLane.x, z: end.z - outLane.z }, outgoing.direction)
    };
  }
  function clearPose(district, shape2, point2, yaw) {
    const pose5 = { ...shape2, ...point2, heading: yaw };
    if (district.metro) {
      const cached = geometryCache.get(district);
      if (cached && !cached.staticIndex) {
        cached.staticIndex = new SpatialIndex(district.statics);
        cached.staticReach = district.statics.reduce((max, body) => Math.max(max, Math.hypot(body.width ?? 0, body.length ?? 0) / 2), 0);
      }
      if (cached) {
        return bodyOnRoad(pose5, district.roads, 0.12) && !cached.staticIndex.near(pose5, cached.staticReach + Math.hypot(pose5.width, pose5.length) / 2 + 0.3).some((other) => overlaps(pose5, other, 0.12));
      }
    }
    return bodyOnRoad(pose5, district.roads, 0.12) && !district.statics.some((other) => overlaps(pose5, other, 0.12));
  }
  function clearPath(district, body, path) {
    for (let i = 1; i < path.length; i++) {
      const yaw = Math.atan2(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
      if (!clearPose(district, body, path[i], yaw)) return false;
    }
    return true;
  }
  function allowedTurn(district, body, incoming, outgoing) {
    if (incoming.turnCache.has(outgoing.id)) return incoming.turnCache.get(outgoing.id);
    const turn = turnBetween(incoming, outgoing);
    const guide = [];
    if (turn) {
      append(guide, turn.start);
      for (const point2 of turn.points) append(guide, point2);
      append(guide, turn.end);
    }
    const valid = turn && turn.inset + 2.2 <= incoming.length && turn.outset + 2.2 <= outgoing.length && turn.points.every((p) => clearPose(district, body, p, p.heading ?? incoming.heading)) && clearPath(district, body, guide);
    if (valid) Object.assign(turn, { guide, bridges: /* @__PURE__ */ new Map(), tails: /* @__PURE__ */ new Map() });
    incoming.turnCache.set(outgoing.id, valid ? turn : null);
    return valid ? turn : null;
  }
  function attachments(district, graph, pose5, body, isGoal) {
    if (![pose5.x, pose5.z].every(Number.isFinite) || !clearPose(district, body, pose5, pose5.heading ?? body.heading ?? 0)) return [];
    const matches = [];
    for (const link of graph.links) {
      if (isGoal && pose5.roadId && pose5.roadId !== link.road.id) continue;
      const start = laneAt(link, 0);
      const along2 = dot({ x: pose5.x - start.x, z: pose5.z - start.z }, link.direction);
      const lateral2 = Math.abs(dot({ x: pose5.x - start.x, z: pose5.z - start.z }, link.normal));
      const attachWidth = district.metro && !isGoal ? Math.max(0.65, link.road.width / 2 - body.width / 2) : 0.65;
      if (along2 < -0.02 || along2 > link.length + 0.02 || lateral2 > attachWidth) continue;
      if (Number.isFinite(pose5.heading) && Math.abs(angleDelta(pose5.heading, link.heading)) > (isGoal ? 0.2 : 0.65)) continue;
      matches.push({ link, along: Math.max(0, Math.min(link.length, along2)), lateral: lateral2 });
    }
    return matches.sort((a, b) => a.lateral - b.lateral);
  }
  function routePath(district, body, goal, links, startAlong, endAlong) {
    const transitions = [];
    for (let i = 1; i < links.length; i++) {
      const turn = allowedTurn(district, body, links[i - 1], links[i]);
      if (!turn) return [];
      transitions.push(turn);
    }
    if (transitions.length && links[0].length - startAlong < transitions[0].inset + 0.5)
      return [];
    if (transitions.length && endAlong < transitions.at(-1).outset + 1)
      return [];
    const path = [];
    const wheelbase = body.spec?.wheelbase ?? 2.6;
    append(path, shift(body, { x: Math.sin(body.heading), z: Math.cos(body.heading) }, -wheelbase / 2));
    if (!transitions.length) {
      append(path, goal);
      return clearPath(district, body, path) ? path : [];
    }
    append(path, transitions[0].start);
    if (!clearPath(district, body, path)) return [];
    const join = (part) => {
      for (let i = 1; i < part.length; i++) path.push(part[i]);
    };
    for (let i = 0; i < transitions.length; i++) {
      const turn = transitions[i], next = transitions[i + 1];
      join(turn.guide);
      const cache = next ? turn.bridges : turn.tails;
      const cacheKey = next ? `${links[i + 1].id}>${links[i + 2].id}` : `${goal.x}:${goal.z}:${goal.heading}`;
      if (!cache.has(cacheKey)) {
        const part2 = [];
        append(part2, turn.end);
        if (turn.recovery) {
          const available = next ? links[i + 1].length - next.inset - turn.outset : endAlong - turn.outset;
          const recoveryM = Math.min(RECOVERY_M, Math.max(0, available - 1));
          append(part2, shift(laneAt(links[i + 1], turn.outset), links[i + 1].direction, recoveryM));
        }
        append(part2, next ? next.start : goal);
        if (cache.size >= 64) cache.clear();
        cache.set(cacheKey, clearPath(district, body, part2) ? part2 : null);
      }
      const part = cache.get(cacheKey);
      if (!part) return [];
      join(part);
    }
    return path.map((p) => ({ x: p.x, z: p.z }));
  }
  function planDistrictRoute(district, body, goal, actors = []) {
    if (!district || !body || !goal || !Number.isFinite(body.heading) || !Number.isFinite(body.width) || !Number.isFinite(body.length)) return [];
    const graph = graphFor(district, body);
    const starts = attachments(district, graph, body, body, false);
    const ends = attachments(district, graph, goal, body, true);
    if (!starts.length || !ends.length) return [];
    const endByLink = new Map(ends.map((end) => [end.link.id, end]));
    const open = starts.map((start) => ({
      link: start.link,
      start,
      parent: null,
      cost: 0
    }));
    const best = /* @__PURE__ */ new Map();
    const occupancy = /* @__PURE__ */ new Map();
    while (open.length) {
      open.sort((a, b) => a.cost - b.cost || a.link.id.localeCompare(b.link.id));
      const current = open.shift();
      const end = endByLink.get(current.link.id);
      if (end && (current.parent || end.along > current.start.along + 0.75)) {
        const links = [];
        for (let state = current; state; state = state.parent) links.push(state.link);
        const path = routePath(district, body, goal, links.reverse(), current.start.along, end.along);
        if (path.length > 2) return path;
      }
      for (const next of current.link.to.outgoing) {
        const turn = allowedTurn(district, body, current.link, next);
        if (!turn || !current.parent && current.link.length - current.start.along < turn.inset + 0.5) continue;
        let occupied = occupancy.get(next);
        if (occupied === void 0) {
          occupied = 0;
          const midpoint = laneAt(next, next.length / 2);
          for (const actor of actors)
            if (actor.id !== body.id && actor.type !== "pedestrian" && distance(actor, midpoint) < 9) occupied++;
          occupancy.set(next, occupied);
        }
        const length = current.parent ? current.link.length : current.link.length - current.start.along;
        const cost = current.cost + length + Math.abs(turn.bend) * 1.8 + occupied * 9;
        if (cost >= (best.get(next.id) ?? Infinity)) continue;
        best.set(next.id, cost);
        open.push({ link: next, start: current.start, parent: current, cost });
      }
    }
    return [];
  }

  // src/core/district-behavior.js
  var HISTORY_LIMIT = 96;
  var WALK_TARGET_GAP = 0.12;
  var PROFILE = Object.freeze({
    cautious: { headwayS: 2.2, speedFactor: 0.88 },
    ordinary: { headwayS: 1.6, speedFactor: 1 },
    assertive: { headwayS: 1, speedFactor: 1 }
  });
  var HUMAN_PATTERNS = [
    "diagonal",
    "hesitant",
    "retreat",
    "emergence",
    "stationary",
    "parallel",
    "crossing"
  ];
  var zoneGeometryCache = /* @__PURE__ */ new WeakMap();
  var adjoiningJunctionResources = /* @__PURE__ */ new WeakMap();
  var pathGeometryCache = /* @__PURE__ */ new WeakMap();
  var isDistrict = (world) => world.environment === "egypt" || world.environment === "metro";
  var now = (world) => world.tick * STEP;
  var along = (walkway, point2) => point2[walkway.axis === "z" ? "z" : "x"];
  var walkPose = (walkway, position2) => walkway.axis === "z" ? { x: walkway.fixed, z: position2 } : { x: position2, z: walkway.fixed };
  function avenueCrossings(road4, roads) {
    if (road4.zone !== "avenue") return [];
    return [...new Set(roads.filter((other) => other.axis !== road4.axis && road4.fixed >= other.min && road4.fixed <= other.max && other.fixed >= road4.min && other.fixed <= road4.max).flatMap((other) => {
      const offset2 = other.width / 2 + 2.4;
      return [other.fixed - offset2, other.fixed + offset2];
    }).filter((along2) => along2 > road4.min + 8 && along2 < road4.max - 8))];
  }
  function zoneGeometry(zone) {
    let geometry = zoneGeometryCache.get(zone);
    if (!geometry || geometry.id !== zone.id || !Object.is(geometry.minX, zone.minX) || !Object.is(geometry.maxX, zone.maxX) || !Object.is(geometry.minZ, zone.minZ) || !Object.is(geometry.maxZ, zone.maxZ)) {
      geometry = {
        id: zone.id,
        minX: zone.minX,
        maxX: zone.maxX,
        minZ: zone.minZ,
        maxZ: zone.maxZ,
        body: {
          id: zone.id,
          type: "static",
          heading: 0,
          x: (zone.minX + zone.maxX) / 2,
          z: (zone.minZ + zone.maxZ) / 2,
          width: zone.maxX - zone.minX,
          length: zone.maxZ - zone.minZ
        }
      };
      zoneGeometryCache.set(zone, geometry);
    }
    return geometry;
  }
  function occupies(car, zone, gap = 0.12, geometry = zoneGeometry(zone)) {
    const reach = (Math.abs(car.length) + Math.abs(car.width)) / 2 + Math.abs(gap) * 2;
    if (car.x + reach < geometry.minX || car.x - reach > geometry.maxX || car.z + reach < geometry.minZ || car.z - reach > geometry.maxZ) return false;
    return overlaps(car, geometry.body, gap);
  }
  function outsideApproach(car, zone, range) {
    const dx = Math.max(zone.minX - car.x, 0, car.x - zone.maxX);
    const dz = Math.max(zone.minZ - car.z, 0, car.z - zone.maxZ);
    return dx > range || dz > range || Math.hypot(dx, dz) > range;
  }
  var queueClearance = (world, car, zone) => 0.55 + (zone.kind === "junction" && car.path?.length > 1 && !(car === world.player && world.mode === "manual") ? car.width : 0);
  function createDistrictBehaviorState() {
    return {
      reservations: {},
      queues: {},
      approaches: {},
      holds: {},
      observedPedestrians: {},
      nextTicket: 1,
      lastTick: -1,
      metrics: {
        grants: 0,
        releases: 0,
        occupiedRetentions: 0,
        eligibleBypasses: 0,
        exitStorageHolds: 0,
        entryQueueHolds: 0,
        peakWaitS: 0,
        replans: 0,
        reroutes: 0,
        blockingCycles: 0,
        peakBlockingCycles: 0,
        pedestrianDecisions: 0,
        acceptedPedestrianDistanceM: 0
      },
      events: []
    };
  }
  function stateFor(world) {
    return world.districtBehavior ??= createDistrictBehaviorState();
  }
  function event(world, actor, kind, trigger, details = {}) {
    const state = stateFor(world);
    state.events.push({
      tick: world.tick,
      timeS: now(world),
      actorId: actor?.id ?? null,
      kind,
      trigger,
      ...details
    });
    if (state.events.length > HISTORY_LIMIT)
      state.events.splice(0, state.events.length - HISTORY_LIMIT);
  }
  function initializeDistrictActor(world, actor) {
    if (!isDistrict(world) || actor.district) return actor;
    const choice = world.rng.next();
    if (actor.type === "vehicle") {
      const profile = choice < 0.28 ? "cautious" : choice < 0.8 ? "ordinary" : "assertive";
      actor.district = {
        profile,
        headwayS: PROFILE[profile].headwayS,
        nextLoadingDistanceM: (actor.distance ?? 0) + world.rng.range(38, 72),
        loadingDurationS: world.rng.range(0.7, 1.8),
        loadingUntilTick: null,
        reroutedTicket: null,
        ...actor === world.player && (!world.districtCase || world.districtCase.allowReroute) ? { allowReroute: true } : {}
      };
    } else if (actor.type === "pedestrian") {
      const pattern = HUMAN_PATTERNS[Math.min(
        HUMAN_PATTERNS.length - 1,
        Math.floor(choice * HUMAN_PATTERNS.length)
      )];
      actor.district = {
        pattern,
        yieldAtCurb: !["diagonal", "emergence", "retreat"].includes(pattern),
        decision: 0,
        stage: "ready",
        holdAtTarget: false,
        observedDistanceM: actor.distance ?? 0
      };
    }
    return actor;
  }
  function closestWalkway(world, person) {
    const walkways = world.district?.walkways ?? [];
    let closest = null, best = Infinity;
    for (const walkway of walkways) {
      const position2 = clamp(along(walkway, person), walkway.min, walkway.max);
      const score = distance(person, walkPose(walkway, position2));
      if (score < best) {
        best = score;
        closest = walkway;
      }
    }
    return closest;
  }
  function clearWalkTarget(world, person, target) {
    const stopped = (world.actors ?? []).filter((actor) => actor.type === "vehicle" && Math.abs(actor.speed) < 0.8);
    return walkSegmentClear(
      person,
      target,
      target,
      (world.statics ?? []).concat(stopped),
      0.12
    );
  }
  function clearWalkLeg(world, person, target) {
    return clearWalkTarget(world, person, target) && walkSegmentClear(person, person, target, world.statics ?? [], 0.12);
  }
  function lineConnection(a, b) {
    if (a.axis === b.axis) return null;
    const vertical = a.axis === "z" ? a : b, horizontal = a.axis === "x" ? a : b;
    const point2 = { x: vertical.fixed, z: horizontal.fixed };
    return point2.z >= vertical.min && point2.z <= vertical.max && point2.x >= horizontal.min && point2.x <= horizontal.max ? point2 : null;
  }
  function nextDistrictWalk(world, person) {
    if (!isDistrict(world)) return false;
    initializeDistrictActor(world, person);
    const state = person.district;
    if (state.caseId) return false;
    const walkway = closestWalkway(world, person);
    if (!walkway) {
      person.target = { x: person.x, z: person.z };
      person.pause = 1;
      state.stage = "no-walkway";
      return false;
    }
    const inset = person.radius + 0.12;
    const lower = walkway.min + inset, upper = walkway.max - inset;
    if (lower > upper) return false;
    const position2 = clamp(along(walkway, person), lower, upper);
    person.walkDirection ??= person.phase < 0.5 ? -1 : 1;
    if (position2 < lower + 2) person.walkDirection = 1;
    if (position2 > upper - 2) person.walkDirection = -1;
    const draw = world.rng.next();
    let pattern = HUMAN_PATTERNS[Math.min(
      HUMAN_PATTERNS.length - 1,
      Math.floor(draw * HUMAN_PATTERNS.length)
    )];
    const stride = world.rng.range(6, 14);
    const holdS = world.rng.range(0.45, 1.15);
    const street = world.environment === "metro" ? world.district.drivingRoads.find((road4) => road4.id === walkway.roadId) : null;
    const avenue2 = street?.zone === "avenue";
    const crossing3 = avenue2 ? avenueCrossings(street, world.district.drivingRoads).filter((value) => Math.abs(value - position2) < 1.6 && value >= lower && value <= upper).sort((a, b) => Math.abs(a - position2) - Math.abs(b - position2))[0] : void 0;
    const opposite = (world.district.walkways ?? []).filter((line) => line.roadId === walkway.roadId && line.axis === walkway.axis && line.side !== walkway.side && Math.abs(line.fixed - walkway.fixed) > 0.5 && (!avenue2 || crossing3 !== void 0) && (crossing3 ?? position2) >= line.min + inset && (crossing3 ?? position2) <= line.max - inset);
    let selected = walkway, target = null, declaredRoute = null;
    if (pattern === "emergence" || position2 < lower + 2 || position2 > upper - 2) {
      const connections = (world.district.walkways ?? []).flatMap((line) => {
        if (line.id === walkway.id) return [];
        const joint = lineConnection(walkway, line);
        if (!joint || !clearWalkLeg(world, person, joint)) return [];
        const from = along(line, joint);
        const direction3 = line.max - from >= from - line.min ? 1 : -1;
        const point2 = walkPose(line, clamp(
          from + stride * direction3,
          line.min + inset,
          line.max - inset
        ));
        return distance(joint, point2) > 0.6 && clearWalkTarget(world, person, point2) && walkSegmentClear(person, joint, point2, world.statics ?? [], 0.12) ? [{ line, joint, point: point2 }] : [];
      });
      if (connections.length) {
        const connection = world.rng.pick(connections);
        selected = connection.line;
        target = connection.point;
        declaredRoute = [connection.joint, target];
      }
    }
    if (!target && !["parallel", "stationary"].includes(pattern) && opposite.length) {
      selected = world.rng.pick(opposite);
      if (avenue2) pattern = "crossing";
      const shift2 = pattern === "diagonal" ? person.walkDirection * world.rng.range(2, 4) : 0;
      const candidate = walkPose(
        selected,
        clamp((crossing3 ?? position2) + shift2, selected.min + inset, selected.max - inset)
      );
      if (clearWalkLeg(world, person, candidate)) {
        target = candidate;
        if (avenue2) declaredRoute = [walkPose(walkway, crossing3), candidate];
      }
    }
    if (!target) {
      pattern = pattern === "stationary" ? pattern : "parallel";
      selected = walkway;
      for (const multiplier of [1, -1, 0.5, -0.5]) {
        const candidate = walkPose(
          walkway,
          clamp(position2 + stride * person.walkDirection * multiplier, lower, upper)
        );
        if (distance(person, candidate) > 0.5 && clearWalkLeg(world, person, candidate)) {
          target = candidate;
          if (multiplier < 0) person.walkDirection *= -1;
          break;
        }
      }
    }
    if (!target) {
      const candidate = walkPose(walkway, position2);
      target = clearWalkTarget(world, person, candidate) ? candidate : { x: person.x, z: person.z };
      pattern = "stationary";
    }
    Object.assign(state, {
      pattern,
      walkwayId: walkway.id,
      targetWalkwayId: selected.id,
      decision: (state.decision ?? 0) + 1,
      stage: pattern === "emergence" ? "await-approach" : "moving",
      origin: { x: person.x, z: person.z },
      destination: { ...target },
      startedTick: world.tick,
      startedDistanceM: person.distance ?? 0,
      holdS,
      reactionDone: false,
      holdAtTarget: false,
      routeConstrained: true,
      yieldAtCurb: !["diagonal", "emergence", "retreat"].includes(pattern)
    });
    person.walkRoute = declaredRoute;
    person.walkGoal = declaredRoute ? `${target.x},${target.z}` : null;
    person.walkPlanTick = world.tick;
    person.target = target;
    person.crossing = selected.axis === walkway.axis && selected.side !== walkway.side;
    person.side = walkway.side;
    person.along = position2;
    const targetRoad = (world.district.drivingRoads ?? []).find((road4) => road4.id === selected.roadId);
    if (targetRoad) person.road = targetRoad;
    person.pause = pattern === "stationary" ? holdS + 0.8 : 0;
    if (pattern === "stationary" || pattern === "emergence") {
      state.holdUntilTick = world.tick + Math.ceil(
        (pattern === "stationary" ? holdS + 0.8 : 4) / STEP
      );
      if (pattern === "stationary") person.target = { x: person.x, z: person.z };
    }
    stateFor(world).metrics.pedestrianDecisions++;
    event(world, person, "walk-decision", person.distance > 0 ? "accepted-waypoint" : "authored-start", {
      pattern,
      walkwayId: walkway.id,
      targetWalkwayId: selected.id
    });
    return true;
  }
  function approachingVehicle(world, person, range = 15) {
    let nearest2 = null, best = range;
    for (const car of world.actors ?? []) {
      if (car.type !== "vehicle" || car.speed < 0.35) continue;
      const dx = person.x - car.x, dz = person.z - car.z;
      if (Math.abs(dx) > best || Math.abs(dz) > best) continue;
      const d = Math.hypot(dx, dz);
      if (d >= best) continue;
      const s = Math.sin(car.heading), c = Math.cos(car.heading);
      const forward2 = dx * s + dz * c;
      const lateral2 = Math.abs(dx * c - dz * s);
      if (forward2 > -car.length / 2 && lateral2 < 7 && d < best) {
        best = d;
        nearest2 = car;
      }
    }
    return nearest2 ? { triggerActorId: nearest2.id, distanceM: best, speedMps: nearest2.speed } : null;
  }
  function copyWalker(person) {
    return {
      ...person,
      target: person.target ? { ...person.target } : { x: person.x, z: person.z },
      walkRoute: person.walkRoute?.map((point2) => ({ ...point2 })) ?? null,
      district: {
        ...person.district,
        origin: person.district?.origin ? { ...person.district.origin } : null,
        destination: person.district?.destination ? { ...person.district.destination } : null
      }
    };
  }
  function prepareWalkRoute(world, person) {
    const key3 = `${person.target.x},${person.target.z}`;
    if (person.walkGoal !== key3 || !person.walkRoute || world.tick >= (person.walkPlanTick ?? 0) + 90) {
      const nearby = world.actorIndex.near(person, 28);
      const obstacles = nearby.filter((actor) => actor.id !== person.id && actor.type !== "pedestrian" && Math.abs(actor.speed ?? 0) < 0.8).concat(world.staticIndex.near(person, 34));
      for (const actor of nearby)
        if (actor.id !== person.id && actor.type === "pedestrian" && actor.speed < 0.1 && actor.wait >= 1)
          obstacles.push({
            id: actor.id,
            type: "static",
            x: actor.x,
            z: actor.z,
            heading: 0,
            width: actor.radius * 2,
            length: actor.radius * 2
          });
      const first = person.walkRoute?.[0];
      const allowMarginExit = canLeaveWalkMargin(world, person);
      if (person.walkGoal !== key3 || !first || !walkSegmentClear(person, person, first, obstacles, 0.12, allowMarginExit))
        person.walkRoute = planWalk(person, person.target, obstacles, allowMarginExit);
      person.walkGoal = key3;
      person.walkPlanTick = world.tick;
    }
    while (person.walkRoute.length > 1 && distance(person, person.walkRoute[0]) < 0.25)
      person.walkRoute.shift();
  }
  function isStoppedVehicle(actor) {
    return actor.type === "vehicle" && Math.abs(actor.speed) < 0.8;
  }
  function findWalkTargetBlocker(actors, target) {
    return actors.find((actor) => isStoppedVehicle(actor) && overlaps(target, actor, WALK_TARGET_GAP));
  }
  function createWalkTargetQuery(actors) {
    const parked = new SpatialIndex();
    let maxRadius = 0;
    for (let order = 0; order < actors.length; order++) {
      const actor = actors[order];
      if (!isStoppedVehicle(actor)) continue;
      maxRadius = Math.max(maxRadius, Math.hypot(actor.length, actor.width) / 2);
      parked.add({ x: actor.x, z: actor.z, actor, order });
    }
    return (target) => {
      const reach = target.radius + maxRadius + WALK_TARGET_GAP;
      if (!Number.isFinite(reach) || !Number.isFinite(target.x) || !Number.isFinite(target.z))
        return findWalkTargetBlocker(actors, target);
      let first;
      for (const candidate of parked.near(target, reach)) {
        if ((!first || candidate.order < first.order) && overlaps(target, candidate.actor, WALK_TARGET_GAP)) first = candidate;
      }
      return first?.actor;
    };
  }
  function stepDistrictPedestrian(world, person, targetBlocker) {
    if (!isDistrict(world)) return pedestrianMotion(world, person);
    initializeDistrictActor(world, person);
    const working = copyWalker(person), state = working.district;
    const behavior = stateFor(world), observations = behavior.observedPedestrians;
    const acceptedDistance = Math.max(
      0,
      (person.distance ?? 0) - (observations[person.id] ?? person.distance ?? 0)
    );
    behavior.metrics.acceptedPedestrianDistanceM += acceptedDistance;
    observations[person.id] = person.distance ?? 0;
    state.observedDistanceM = person.distance ?? 0;
    if (!state.caseId && !person.target) nextDistrictWalk(world, working);
    if (!state.caseId && world.tick >= (state.targetRetryTick ?? 0)) {
      const target = {
        type: "pedestrian",
        radius: working.radius,
        x: working.target.x,
        z: working.target.z
      };
      const blocker = targetBlocker ? targetBlocker(target) : findWalkTargetBlocker(world.actors, target);
      if (blocker) {
        state.targetRetryTick = world.tick + 90;
        event(world, person, "walk-retarget", "occupied-catalog-target", { blockedBy: blocker.id });
        nextDistrictWalk(world, working);
      }
    }
    const progressed = (person.distance ?? 0) - (state.startedDistanceM ?? 0);
    let vehicle2, approachChecked = false;
    let hold = false;
    if (!state.caseId && state.stage === "await-approach") {
      vehicle2 = approachingVehicle(world, working);
      approachChecked = true;
      hold = !vehicle2 && world.tick < state.holdUntilTick;
      if (!hold) {
        state.stage = "moving";
        working.pause = 0;
        event(
          world,
          person,
          "emergence",
          vehicle2 ? "vehicle-approach" : "bounded-idle-release",
          vehicle2 ?? {}
        );
      }
    }
    if (!state.caseId && state.pattern === "stationary" && world.tick < state.holdUntilTick)
      hold = true;
    if (!state.caseId && state.pattern === "stationary" && world.tick >= state.holdUntilTick) {
      event(world, person, "resume", "bounded-curb-hold-complete");
      nextDistrictWalk(world, working);
    }
    if (!state.caseId && !state.reactionDone && progressed > 0.55 && (state.pattern === "hesitant" || state.pattern === "retreat")) {
      if (!approachChecked) vehicle2 = approachingVehicle(world, working);
      if (vehicle2) {
        state.reactionDone = true;
        state.holdUntilTick = world.tick + Math.ceil(state.holdS / STEP);
        state.stage = state.pattern === "retreat" ? "retreating" : "hesitating";
        if (state.pattern === "retreat") {
          working.target = { ...state.origin };
          working.walkRoute = null;
          working.crossing = false;
          state.holdAtTarget = true;
        }
        event(world, person, state.stage, "vehicle-approach-after-entry", {
          ...vehicle2,
          acceptedProgressM: progressed
        });
      }
    }
    if (!state.caseId && state.stage === "hesitating") {
      hold = world.tick < state.holdUntilTick;
      if (!hold) {
        state.stage = "moving";
        event(world, person, "resume", "bounded-hesitation-complete");
      }
    }
    if (!state.caseId && state.stage === "retreating" && distance(working, state.origin) < 0.3 && working.speed < 0.08) {
      state.stage = "moving";
      state.holdAtTarget = false;
      working.target = { ...state.destination };
      working.walkRoute = null;
      working.crossing = true;
      event(world, person, "resume", "accepted-retreat-arrival");
    }
    const requestedMode = working.motionMode;
    if (hold) working.motionMode = "stop";
    if (state.routeConstrained) prepareWalkRoute(world, working);
    const proposal = pedestrianMotion(world, working, true);
    proposal.motionMode = requestedMode;
    if (hold && proposal.reason !== "blocked") proposal.reason = `district-${state.stage}`;
    else if (!state.caseId && proposal.reason === "walking" && state.pattern === "parallel")
      proposal.reason = "district-parallel";
    return proposal;
  }
  function activeVehicle(world, car) {
    if (car === world.player && world.mode === "manual")
      return Math.abs(world.input?.targetSpeed ?? 0) > 0.01 || Math.abs(car.speed) > 0.05;
    return (car.path?.length ?? 0) > 1 || Math.abs(car.speed) > 0.05;
  }
  function pathGeometry(path) {
    let geometry = pathGeometryCache.get(path);
    if (geometry?.immutable) return geometry;
    let valid = geometry?.points.length === path.length;
    for (let i = 0; valid && i < path.length; i++)
      valid = Object.is(path[i].x, geometry.points[i].x) && Object.is(path[i].z, geometry.points[i].z);
    const immutable = hasImmutablePathPoints(path);
    if (valid) {
      geometry.immutable = immutable;
      return geometry;
    }
    const points = immutable ? path : path.map((point2) => ({ x: point2.x, z: point2.z }));
    const next = new Int32Array(points.length).fill(-1);
    const lengths = new Float64Array(points.length), samples = new Array(points.length);
    for (let i = 0; i < points.length - 1; i++)
      for (let j = i + 1; j < points.length; j++) {
        const segment = distance(points[i], points[j]);
        if (segment < 0.03) continue;
        next[i] = j;
        lengths[i] = segment;
        samples[i] = {
          x: points[j].x,
          z: points[j].z,
          heading: Math.atan2(points[j].x - points[i].x, points[j].z - points[i].z)
        };
        break;
      }
    geometry = { immutable, points, next, lengths, samples, zones: /* @__PURE__ */ new WeakMap() };
    pathGeometryCache.set(path, geometry);
    return geometry;
  }
  function footprintFlags(path, car, zone, geometry) {
    let cached = path.zones.get(zone);
    if (!cached || cached.geometry !== geometry) {
      cached = { geometry, shapes: /* @__PURE__ */ new Map() };
      path.zones.set(zone, cached);
    }
    const key3 = `${car.length}:${car.width}`;
    if (!cached.shapes.has(key3)) {
      if (cached.shapes.size >= 8) cached.shapes.clear();
      cached.shapes.set(key3, new Uint8Array(path.points.length));
    }
    return cached.shapes.get(key3);
  }
  function forwardPath(world, car, horizonM = 110) {
    const result = [{ x: car.x, z: car.z, heading: car.heading }];
    const distances = [0];
    const fromIndices = [-1];
    let geometry = null, tail = -1;
    const manual = car === world.player && world.mode === "manual";
    if (manual) {
      const sign = (world.input?.targetSpeed ?? car.speed) < 0 ? -1 : 1;
      const probe = vehicleProbe(car, sign * Math.max(1.2, Math.abs(car.speed)));
      const command = { targetSpeed: probe.speed, steer: world.input?.steer ?? 0 };
      let travelled = 0;
      for (let i = 0; i < 500 && travelled < 90; i++) {
        const x = probe.x, z = probe.z;
        command.targetSpeed = probe.speed;
        integrateVehicle(probe, command, Math.min(0.16, 0.3 / Math.abs(probe.speed)), probe);
        travelled += Math.hypot(x - probe.x, z - probe.z);
        result.push({ x: probe.x, z: probe.z, heading: probe.heading });
        distances.push(travelled);
      }
    } else if (car.path?.length > 1) {
      geometry = pathGeometry(car.path);
      const cursor = car.cursor ?? 0;
      const nearest2 = nearestPathPoint(car.path, car.x, car.z, cursor, Math.max(0, cursor - 2));
      for (let i = nearest2; i < car.path.length && horizonM > 0; i++) {
        const point2 = geometry.points[i];
        if (i === nearest2 && (point2.x - car.x) * Math.sin(car.heading) + (point2.z - car.z) * Math.cos(car.heading) < -0.05) continue;
        const segment = distance(car, point2);
        if (segment < 0.03) continue;
        result.push({
          x: point2.x,
          z: point2.z,
          heading: Math.atan2(point2.x - car.x, point2.z - car.z)
        });
        distances.push(0 + segment);
        fromIndices.push(-1);
        tail = i;
        break;
      }
    } else {
      const sign = car.speed < 0 ? -1 : 1;
      const s = Math.sin(car.heading), c = Math.cos(car.heading);
      for (let d = 0.5; d <= 90; d += 0.5) {
        result.push({
          x: car.x + s * d * sign,
          z: car.z + c * d * sign,
          heading: car.heading
        });
        distances.push(d);
      }
    }
    return { points: result, distances, geometry, fromIndices, tail, horizonM };
  }
  function extendTrajectory(path) {
    const from = path.tail;
    if (from < 0 || path.geometry.next[from] < 0) return false;
    const distances = path.distances, travelled = distances[distances.length - 1];
    if (!(travelled < path.horizonM)) return false;
    distances.push(travelled + path.geometry.lengths[from]);
    path.points.push(path.geometry.samples[from]);
    path.fromIndices.push(from);
    path.tail = path.geometry.next[from];
    return true;
  }
  function trajectoryLength(path) {
    while (extendTrajectory(path)) {
    }
    return path.distances.at(-1);
  }
  function routeThroughZone(car, zone, path, geometry = zoneGeometry(zone), approachM = Infinity) {
    let entryM = Infinity, exitedAtM = null, entryCount = 0;
    const exitSamples = [];
    const flags = path.geometry ? footprintFlags(path.geometry, car, zone, geometry) : null;
    const occupied = occupies(car, zone, 0.12, geometry);
    const pose5 = {
      type: car.type,
      length: car.length,
      width: car.width,
      x: car.x,
      z: car.z,
      heading: car.heading
    };
    let entered = occupied;
    if (entered) entryM = 0;
    for (let i = 0; i < path.points.length || extendTrajectory(path); i++) {
      const point2 = path.points[i], from = path.fromIndices[i] ?? -1;
      const alongM = path.distances[i];
      if (!entered && alongM > approachM) return null;
      let inside;
      if (i === 0) inside = occupied;
      else if (from >= 0 && flags?.[from]) inside = flags[from] === 2;
      else {
        pose5.x = point2.x;
        pose5.z = point2.z;
        pose5.heading = point2.heading;
        inside = occupies(pose5, zone, 0.12, geometry);
        if (from >= 0 && flags) flags[from] = inside ? 2 : 1;
      }
      if (inside && entryM === Infinity) {
        entryM = alongM;
        entered = true;
      }
      if (!entered) entryCount++;
      if (entered && !inside && alongM > entryM) {
        exitedAtM ??= alongM;
        exitSamples.push({
          type: car.type,
          length: car.length,
          width: car.width,
          x: point2.x,
          z: point2.z,
          heading: point2.heading,
          alongM
        });
        if (alongM - exitedAtM >= car.length + 0.5) break;
      }
    }
    if (!entered && entryM > approachM) return null;
    return {
      distanceM: entryM,
      exitDistanceM: exitedAtM ?? Infinity,
      hasExit: exitedAtM !== null && exitSamples.length > 0 && exitSamples.at(-1).alongM - exitedAtM >= car.length + 0.35,
      entryCount,
      entryPath: path,
      exitSamples
    };
  }
  function approachBlocker(world, car, route) {
    const vehicles = world.actors.filter((actor) => actor.id !== car.id && actor.type === "vehicle");
    for (let i = 0; i < route.entryCount; i++) {
      const point2 = route.entryPath.points[i];
      const pose5 = { type: "vehicle", length: car.length, width: car.width, ...point2 };
      const blocker = vehicles.find((other) => overlaps(pose5, other, 0.12));
      if (blocker) return blocker.id;
    }
    return null;
  }
  function storageBlocker(world, car, route, zone) {
    if (!route.hasExit) return zone.id;
    const obstacles = (world.actors ?? []).filter((actor) => actor.id !== car.id).concat(world.statics ?? []);
    for (const pose5 of route.exitSamples) {
      if (!bodyOnRoad(pose5, world.roads, 0.12)) return zone.id;
      const blocker = obstacles.find((other) => overlaps(pose5, other, 0.12));
      if (blocker) return blocker.id;
    }
    return null;
  }
  function onRoadLimit(world, car) {
    let limit = Infinity, roadId = null, width = 0;
    for (const road4 of world.district?.drivingRoads ?? world.drivingRoads ?? []) {
      const position2 = road4.axis === "z" ? car.z : car.x;
      const lateral2 = Math.abs((road4.axis === "z" ? car.x : car.z) - road4.fixed);
      if (position2 < road4.min - 0.2 || position2 > road4.max + 0.2 || lateral2 > road4.width / 2)
        continue;
      const heading2 = road4.axis === "z" ? 0 : Math.PI / 2;
      const aligned = Math.min(
        Math.abs(angleDelta(car.heading, heading2)),
        Math.abs(angleDelta(car.heading, heading2 + Math.PI))
      ) < 0.8;
      if (!aligned) continue;
      if (Number.isFinite(road4.speedLimitMps) && road4.speedLimitMps < limit) {
        limit = Math.max(0, road4.speedLimitMps);
        roadId = road4.id;
        width = road4.width;
      }
    }
    return { limit, roadId, width };
  }
  function rushRoadLimit(road4, police = false) {
    return road4.width >= 12 && road4.limit >= 9 ? road4.limit + (police ? 5 : 3.2) : road4.limit;
  }
  var isPackPursuit = (variant) => variant === "pack" || variant === "hunt" || variant === "survival";
  var isRushPack = (variant) => isPackPursuit(variant) || variant === "arcade";
  var usesRushPace = (variant) => variant === "rush" || variant === "cinematic" || isRushPack(variant);
  function arcadePatrolLimit(road4) {
    return rushRoadLimit(road4) + (road4.width >= 12 ? 6.5 : 4.5);
  }
  function blockingCycles(cars) {
    const stopped = new Map(cars.filter((car) => Math.abs(car.speed) < 0.15 && car.wait >= 5).map((car) => [car.id, car]));
    const examined = /* @__PURE__ */ new Set();
    let count = 0;
    for (const id of stopped.keys()) {
      const chain = /* @__PURE__ */ new Set();
      let current = id;
      while (stopped.has(current) && !examined.has(current) && !chain.has(current)) {
        chain.add(current);
        current = stopped.get(current).blockedBy;
      }
      if (chain.has(current)) count++;
      for (const visited of chain) examined.add(visited);
    }
    return count;
  }
  function withoutQueuedDeparture(world, route) {
    const exit2 = route?.exitSamples[0];
    if (!exit2) return null;
    const district = world.district;
    const road4 = district.drivingRoads.find((item) => item.id === onRoadLimit(world, exit2).roadId);
    if (!road4) return null;
    const sign = (road4.axis === "z" ? Math.cos(exit2.heading) : Math.sin(exit2.heading)) > 0 ? 1 : -1;
    if (road4.flow && road4.flow !== sign) return null;
    const cuts = /* @__PURE__ */ new Set([road4.min, road4.max]);
    for (const other of district.drivingRoads)
      if (other.axis !== road4.axis && other.fixed >= road4.min && other.fixed <= road4.max && road4.fixed >= other.min && road4.fixed <= other.max)
        cuts.add(other.fixed);
    const along2 = exit2[road4.axis === "z" ? "z" : "x"], sorted = [...cuts].sort((a, b) => a - b);
    const index = sorted.findIndex((value, i) => i + 1 < sorted.length && along2 >= value && along2 <= sorted[i + 1]);
    if (index < 0) return null;
    const min = sorted[index], max = sorted[index + 1], pieces = [];
    if (road4.min < min) pieces.push({ ...road4, max: min });
    if (!road4.flow) pieces.push({ ...road4, min, max, flow: -sign });
    if (max < road4.max) pieces.push({ ...road4, min: max });
    return { ...district, drivingRoads: district.drivingRoads.flatMap((item) => item === road4 ? pieces : [item]) };
  }
  function plannedPassageVisits(car, path, zone, cursor = 0) {
    const reach = car.length / 2;
    let visits = 0, inside = false;
    for (let i = cursor; i < path.length; i++) {
      const point2 = path[i];
      const next = point2.x >= zone.minX - reach && point2.x <= zone.maxX + reach && point2.z >= zone.minZ - reach && point2.z <= zone.maxZ + reach;
      if (next && !inside) visits++;
      inside = next;
    }
    return visits;
  }
  function planDistrictTrafficTrip(world, car, start) {
    const { district, actors } = world;
    const congested = district.conflictZones.filter((zone) => zone.kind === "single-lane" && actors.filter((actor) => actor !== car && actor.type === "vehicle" && plannedPassageVisits(actor, actor.path ?? [], zone, actor.cursor)).length >= 2);
    const goals = district.trafficGoals;
    let fallback = [];
    for (let i = 0; i < goals.length; i++) {
      const goal = goals[(start + i) % goals.length];
      if (distance(car, goal) < 12) continue;
      const path = planDistrictRoute(district, car, goal, actors);
      if (path.length <= 10) continue;
      if (!congested.some((zone) => plannedPassageVisits(car, path, zone))) return path;
      if (!fallback.length) fallback = path;
    }
    return fallback;
  }
  function replanQueuedVehicle(world, car, zone, queuedRoute, waitS = 0) {
    if (car.district.caseId && !car.district.allowReroute) return false;
    if (!queuedRoute || !storageBlocker(world, car, queuedRoute, zone)) return false;
    const end = car.path?.at(-1), before = car.path?.at(-2);
    const goal = car.goal ?? car.parking ?? car.district.goal ?? (end && before ? {
      x: end.x,
      z: end.z,
      heading: Math.atan2(end.x - before.x, end.z - before.z)
    } : null);
    if (!goal) return false;
    const remaining = car.parking ? trajectoryLength(forwardPath(world, car, Infinity)) : null;
    const district = world.district;
    const roads = district.drivingRoads.filter((road4) => {
      if (zone.kind !== "single-lane" || road4.flow || (road4.laneOffsetM ?? 0) !== 0)
        return true;
      return road4.axis === "z" ? road4.fixed < zone.minX || road4.fixed > zone.maxX || road4.min < zone.minZ || road4.max > zone.maxZ : road4.fixed < zone.minZ || road4.fixed > zone.maxZ || road4.min < zone.minX || road4.max > zone.maxX;
    });
    const profiles2 = roads.length < district.drivingRoads.length ? [{ ...district, drivingRoads: roads }, district] : [district];
    if (queuedRoute && storageBlocker(world, car, queuedRoute, zone)) {
      const alternative = withoutQueuedDeparture(world, queuedRoute);
      if (alternative) profiles2.push(alternative);
    }
    for (const profile of profiles2) {
      const path = planDistrictRoute(profile, car, goal, world.actors);
      if (path.length <= 10 || !routeChanged(car.path, path)) continue;
      if (zone.kind === "single-lane" && plannedPassageVisits(car, path, zone) > plannedPassageVisits(car, car.path, car.cursor)) continue;
      const proposed = { ...car, path, cursor: 0 };
      const trajectory = forwardPath(world, proposed, car.parking ? Infinity : 110);
      if (car.parking) {
        const speedBound = Math.min(car.maxSpeed ?? 0, onRoadLimit(world, car).limit);
        if (trajectoryLength(trajectory) - remaining > Math.max(0, waitS) * speedBound + 1e-6)
          continue;
      }
      const exit2 = routeThroughZone(proposed, zone, trajectory);
      if (storageBlocker(world, car, exit2, zone)) continue;
      car.path = path;
      car.cursor = 0;
      return true;
    }
    return false;
  }
  function routeChanged(before, after) {
    for (let i = 0; i < after.length; i += 8)
      if (!before.some((point2) => (point2.x - after[i].x) ** 2 + (point2.z - after[i].z) ** 2 <= 1))
        return true;
    return false;
  }
  function distanceInsideZone(path, zone) {
    while (extendTrajectory(path)) {
    }
    let total = 0;
    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1], b = path.points[i];
      let enter = 0, leave = 1;
      for (const [axis, min, max] of [["x", zone.minX, zone.maxX], ["z", zone.minZ, zone.maxZ]]) {
        const delta = b[axis] - a[axis];
        if (Math.abs(delta) < 1e-8) {
          if (a[axis] < min || a[axis] > max) {
            enter = 2;
            break;
          }
        } else {
          const low = (min - a[axis]) / delta, high = (max - a[axis]) / delta;
          enter = Math.max(enter, Math.min(low, high));
          leave = Math.min(leave, Math.max(low, high));
        }
      }
      total += Math.max(0, leave - enter) * distance(a, b);
    }
    return total;
  }
  function divertCongestedCirculation(world, car, approachZone, approachPath) {
    const state = stateFor(world);
    if (car === world.player || car.parking || car.district.caseId || occupies(car, approachZone) || state.reservations[approachZone.id]?.ownerId === car.id || world.tick < (car.district.nextCongestionPlanTick ?? 0)) return false;
    for (const zone of world.district.conflictZones) {
      if (zone.kind !== "single-lane") continue;
      const demand = world.actors.filter((actor) => actor !== car && actor.type === "vehicle" && (occupies(actor, zone) || state.approaches[actor.id]?.zoneId === zone.id)).length;
      const queued = (state.queues[zone.id] ?? []).some((entry) => entry.waitS > 6 && state.approaches[entry.actorId]?.zoneId === zone.id);
      if (demand < 2 && !queued) continue;
      const near = routeThroughZone(car, zone, approachPath);
      if (!near.hasExit) continue;
      const roads = world.district.drivingRoads.filter((road4) => {
        if (road4.flow || (road4.laneOffsetM ?? 0) !== 0) return true;
        const contained = road4.axis === "z" ? road4.fixed >= zone.minX && road4.fixed <= zone.maxX && road4.min >= zone.minZ && road4.max <= zone.maxZ : road4.fixed >= zone.minZ && road4.fixed <= zone.maxZ && road4.min >= zone.minX && road4.max <= zone.maxX;
        if (!contained) return true;
        return !car.path.slice(Math.max(0, car.cursor - 2)).some((point2) => {
          const along2 = point2[road4.axis === "z" ? "z" : "x"];
          return along2 > road4.min + car.length && along2 < road4.max - car.length && Math.abs(point2[road4.axis === "z" ? "x" : "z"] - road4.fixed) < 1e-4;
        });
      });
      if (roads.length === world.district.drivingRoads.length) continue;
      car.district.nextCongestionPlanTick = world.tick + Math.ceil(6 / STEP);
      const end = car.path.at(-1), before = car.path.at(-2);
      const goal = car.goal ?? car.district.goal ?? {
        ...end,
        heading: Math.atan2(end.x - before.x, end.z - before.z)
      };
      const path = planDistrictRoute({ ...world.district, drivingRoads: roads }, car, goal, world.actors);
      if (path.length <= 10 || !routeChanged(car.path, path)) continue;
      const proposed = { ...car, path, cursor: 0 }, future = forwardPath(world, proposed, Infinity);
      const exit2 = routeThroughZone(proposed, approachZone, future);
      if (!Number.isFinite(exit2.distanceM) || storageBlocker(world, car, exit2, approachZone)) continue;
      const oldTransitM = distanceInsideZone(forwardPath(world, car, Infinity), zone);
      const newTransitM = distanceInsideZone(future, zone);
      if (newTransitM + car.length >= oldTransitM) continue;
      car.path = path;
      car.cursor = 0;
      state.metrics.replans++;
      state.metrics.reroutes++;
      event(world, car, "traffic-reroute", "observed-downstream-resource-queue", {
        zoneId: approachZone.id,
        congestedZoneId: zone.id,
        oldTransitM,
        newTransitM,
        routeChanged: true
      });
      return true;
    }
    return false;
  }
  function trafficApproach(world, car, zoneRows, paths, routes) {
    let closest = null;
    const active2 = activeVehicle(world, car);
    let path;
    for (const { zone, geometry } of zoneRows) {
      if ((!active2 || outsideApproach(car, zone, Math.max(zone.approachM, car.length + 1) + car.length + 3)) && !occupies(car, zone, 0.12, geometry)) continue;
      if (active2 && !path) {
        path = forwardPath(world, car);
        paths.set(car.id, path);
      }
      const threshold = Math.max(zone.approachM, car.length + 1, car.speed ** 2 / (2 * 3.5) + 2);
      const route = active2 ? routeThroughZone(car, zone, path, geometry, threshold) : { distanceM: 0, hasExit: false, exitSamples: [], entryCount: 0 };
      if (!route) continue;
      routes.set(`${zone.id}:${car.id}`, route);
      if (!closest || route.distanceM < closest.distanceM)
        closest = { zoneId: zone.id, distanceM: route.distanceM };
    }
    return closest;
  }
  function trafficResources(world) {
    const zones = world.district?.conflictZones;
    if (!zones || world.config?.cityVersion !== 4) return zones ?? [];
    if (adjoiningJunctionResources.has(zones)) return adjoiningJunctionResources.get(zones);
    const resources = zones.slice();
    for (let i = 0; i < resources.length; i++) {
      let a = resources[i];
      if (a.kind !== "junction") continue;
      for (let j = i + 1; j < resources.length; j++) {
        const b = resources[j];
        if (b.kind !== "junction") continue;
        const x = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const z = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
        if (!(x === 0 && z >= VEHICLE.length || z === 0 && x >= VEHICLE.length)) continue;
        a = resources[i] = {
          ...a,
          id: `${a.id}+${b.id}`,
          approachM: Math.max(a.approachM, b.approachM),
          minX: Math.min(a.minX, b.minX),
          maxX: Math.max(a.maxX, b.maxX),
          minZ: Math.min(a.minZ, b.minZ),
          maxZ: Math.max(a.maxZ, b.maxZ)
        };
        resources.splice(j--, 1);
      }
    }
    adjoiningJunctionResources.set(zones, resources);
    return resources;
  }
  function updateDistrictTraffic(world) {
    if (!isDistrict(world)) return;
    const state = stateFor(world);
    if (state.lastTick === world.tick) return;
    state.lastTick = world.tick;
    state.approaches = {};
    state.holds = {};
    const cars = world.actors.filter((actor) => actor.type === "vehicle");
    state.metrics.blockingCycles = blockingCycles(cars);
    state.metrics.peakBlockingCycles = Math.max(
      state.metrics.peakBlockingCycles,
      state.metrics.blockingCycles
    );
    const byId = new Map(cars.map((car) => [car.id, car]));
    const paths = /* @__PURE__ */ new Map();
    const routes = /* @__PURE__ */ new Map();
    const zones = trafficResources(world);
    const zoneRows = zones.map((zone) => ({ zone, geometry: zoneGeometry(zone) }));
    for (const car of cars) {
      initializeDistrictActor(world, car);
      const closest = trafficApproach(world, car, zoneRows, paths, routes);
      if (closest) state.approaches[car.id] = closest;
    }
    const approachesByZone = /* @__PURE__ */ new Map();
    for (const car of cars) {
      const closest = state.approaches[car.id];
      if (closest && paths.has(car.id) && divertCongestedCirculation(
        world,
        car,
        zones.find((zone) => zone.id === closest.zoneId),
        paths.get(car.id)
      )) {
        paths.delete(car.id);
        const updated = trafficApproach(world, car, zoneRows, paths, routes);
        if (updated) state.approaches[car.id] = updated;
        else delete state.approaches[car.id];
      }
      const approach2 = state.approaches[car.id];
      if (approach2) {
        const group = approachesByZone.get(approach2.zoneId);
        if (group) group.push(car);
        else approachesByZone.set(approach2.zoneId, [car]);
      }
    }
    for (const { zone, geometry } of zoneRows) {
      let reservation = state.reservations[zone.id];
      const occupants = cars.filter((car) => occupies(car, zone, 0.12, geometry));
      if (reservation) {
        const owner = byId.get(reservation.ownerId);
        const occupied = owner && occupants.includes(owner);
        if (occupied) {
          reservation.entered = true;
          if (distance(owner, reservation.lastPose) > 0.08) {
            reservation.lastProgressTick = world.tick;
            reservation.lastPose = { x: owner.x, z: owner.z };
          }
          state.metrics.occupiedRetentions++;
        } else {
          const stillApproaching = owner && activeVehicle(world, owner) && state.approaches[owner.id]?.zoneId === zone.id;
          const progressed = owner && distance(owner, reservation.lastPose) > 0.08;
          if (progressed) {
            reservation.lastPose = { x: owner.x, z: owner.z };
            reservation.lastProgressTick = world.tick;
          }
          if (!owner || reservation.entered || !stillApproaching || world.tick - reservation.lastProgressTick > 6 / STEP) {
            event(
              world,
              owner,
              "resource-release",
              reservation.entered ? "whole-body-cleared" : "inactive-outside-resource",
              { zoneId: zone.id, ticket: reservation.ticket }
            );
            delete state.reservations[zone.id];
            reservation = null;
            state.metrics.releases++;
          }
        }
      }
      if (occupants.length && (!reservation || !occupants.some((car) => car.id === reservation.ownerId))) {
        const occupant = occupants[0];
        reservation = {
          ownerId: occupant.id,
          ticket: state.nextTicket++,
          sinceTick: world.tick,
          entered: true,
          lastProgressTick: world.tick,
          lastPose: { x: occupant.x, z: occupant.z }
        };
        state.reservations[zone.id] = reservation;
        event(world, occupant, "resource-occupancy", "actual-body-in-resource", { zoneId: zone.id });
      }
      const previousQueue = state.queues[zone.id] ?? [];
      const queue = [];
      for (const car of approachesByZone.get(zone.id) ?? []) {
        if (!activeVehicle(world, car) || reservation?.ownerId === car.id) continue;
        const earlier = previousQueue.find((entry2) => entry2.actorId === car.id);
        const entry = earlier ?? {
          actorId: car.id,
          ticket: state.nextTicket++,
          arrivedTick: world.tick,
          startDistanceM: car.distance ?? 0
        };
        entry.waitS = (world.tick - entry.arrivedTick) * STEP;
        entry.progressM = Math.max(0, (car.distance ?? 0) - entry.startDistanceM);
        queue.push(entry);
        if (!earlier)
          event(world, car, "resource-arrival", "actual-path-approach", {
            zoneId: zone.id,
            ticket: entry.ticket,
            distanceM: state.approaches[car.id].distanceM
          });
        state.metrics.peakWaitS = Math.max(state.metrics.peakWaitS, entry.waitS);
      }
      queue.sort((a, b) => {
        const arrival = a.arrivedTick - b.arrivedTick;
        if (arrival || zone.kind !== "single-lane") return arrival || a.ticket - b.ticket;
        const aExit = routes.get(`${zone.id}:${a.actorId}`).exitDistanceM;
        const bExit = routes.get(`${zone.id}:${b.actorId}`).exitDistanceM;
        if (Number.isFinite(aExit) && Number.isFinite(bExit)) {
          const clearance = Math.round(aExit * 1e6) - Math.round(bExit * 1e6);
          if (clearance) return clearance;
        }
        return a.ticket - b.ticket;
      });
      state.queues[zone.id] = queue;
      if (!reservation && !occupants.length && queue.length) {
        for (let index = 0; index < queue.length; index++) {
          const entry = queue[index], candidate = byId.get(entry.actorId);
          const route = routes.get(`${zone.id}:${candidate.id}`);
          const heldResource = Object.entries(state.reservations).find(([, lease]) => lease.ownerId === candidate.id)?.[0];
          const entryBlocker = heldResource ? null : approachBlocker(world, candidate, route);
          const blocker = heldResource ?? entryBlocker ?? storageBlocker(world, candidate, route, zone);
          if (blocker) {
            if (entryBlocker) state.metrics.entryQueueHolds++;
            else state.metrics.exitStorageHolds++;
            state.holds[candidate.id] = {
              zoneId: zone.id,
              blockedBy: blocker,
              reason: entryBlocker ? "district-entry-queue" : "district-exit-storage",
              distanceM: state.approaches[candidate.id].distanceM,
              stopBeforeM: queueClearance(world, candidate, zone),
              ticket: entry.ticket,
              waitS: entry.waitS
            };
            continue;
          }
          queue.splice(index, 1);
          reservation = {
            ownerId: candidate.id,
            ticket: entry.ticket,
            sinceTick: world.tick,
            entered: false,
            lastProgressTick: world.tick,
            lastPose: { x: candidate.x, z: candidate.z }
          };
          state.reservations[zone.id] = reservation;
          state.metrics.grants++;
          if (index > 0) state.metrics.eligibleBypasses++;
          event(world, candidate, "resource-grant", "first-eligible-ticket-and-clear-exit", {
            zoneId: zone.id,
            ticket: entry.ticket,
            waitS: entry.waitS,
            skippedBlockedTickets: index,
            arrivedTick: entry.arrivedTick,
            exitDistanceM: route.exitDistanceM
          });
          break;
        }
      }
      for (const entry of queue) {
        const car = byId.get(entry.actorId);
        if (occupants.includes(car)) continue;
        state.holds[car.id] ??= {
          zoneId: zone.id,
          blockedBy: reservation?.ownerId ?? zone.id,
          reason: zone.kind === "single-lane" ? "district-single-lane" : "district-merge",
          distanceM: state.approaches[car.id].distanceM,
          stopBeforeM: queueClearance(world, car, zone),
          ticket: entry.ticket,
          waitS: entry.waitS
        };
        if (entry.waitS > 6 && (car !== world.player || world.mode === "auto" && car.district.allowReroute === true) && (!car.district.caseId || car.district.allowReroute) && car.district.reroutedTicket !== entry.ticket && car.speed < 0.08 && world.tick >= (car.district.nextReplanTick ?? 0)) {
          car.district.nextReplanTick = world.tick + Math.ceil(6 / STEP);
          const previousPath = car.path;
          if (replanQueuedVehicle(world, car, zone, routes.get(`${zone.id}:${car.id}`), entry.waitS)) {
            car.district.reroutedTicket = entry.ticket;
            const changed = routeChanged(previousPath, car.path);
            state.metrics.replans++;
            if (changed) state.metrics.reroutes++;
            event(world, car, changed ? "traffic-reroute" : "traffic-replan", "accepted-queue-wait", {
              zoneId: zone.id,
              ticket: entry.ticket,
              waitS: entry.waitS,
              blockedBy: state.holds[car.id].blockedBy,
              routeChanged: changed
            });
          }
        }
      }
    }
    for (const car of cars) {
      const profile = car.district;
      if (car === world.player || profile.caseId && !profile.loadingEnabled) continue;
      if (profile.loadingUntilTick !== null && world.tick >= profile.loadingUntilTick) {
        profile.loadingUntilTick = null;
        if (profile.loadingOnce) profile.nextLoadingDistanceM = null;
        else {
          profile.nextLoadingDistanceM = (car.distance ?? 0) + world.rng.range(38, 72);
          profile.loadingDurationS = world.rng.range(0.7, 1.8);
        }
        event(world, car, "loading-resume", "bounded-loading-complete");
      }
      if (profile.loadingUntilTick === null && Number.isFinite(profile.nextLoadingDistanceM) && (car.distance ?? 0) >= profile.nextLoadingDistanceM && !state.approaches[car.id] && onRoadLimit(world, car).width >= 5 && !cars.some((other) => other !== car && distance(other, car) < 9)) {
        profile.loadingUntilTick = world.tick + Math.ceil(
          (profile.loadingDurationS + Math.abs(car.speed) / VEHICLE.braking) / STEP
        );
        event(world, car, "loading-hold", "actual-trip-distance-and-clear-road", {
          distanceM: car.distance,
          durationS: profile.loadingDurationS
        });
      }
    }
  }
  function districtTrafficCommand(world, car, command) {
    if (!isDistrict(world)) return command;
    initializeDistrictActor(world, car);
    const result = { ...command };
    const originalSign = command.targetSpeed < 0 ? -1 : 1;
    let speed = Math.abs(command.targetSpeed);
    const cap = (limit, reason, blockedBy) => {
      if (!Number.isFinite(limit) || limit >= speed - 1e-8) return;
      speed = Math.max(0, limit);
      result.targetSpeed = originalSign * speed;
      result.reason = reason;
      result.blockedBy = blockedBy;
    };
    const road4 = onRoadLimit(world, car);
    const rush = world.pursuit?.phase === "running" && usesRushPace(world.pursuit.variant);
    const patrol2 = rush && car.pursuitRole === "police";
    const arcadePatrol = patrol2 && isRushPack(world.pursuit.variant);
    const survival = world.pursuit?.phase === "running" && world.pursuit.survival;
    const reversingHunt = originalSign < 0 && world.pursuit?.phase === "running" && ["hunt", "survival"].includes(world.pursuit.variant) && (car === world.player || command.reason === "police-reposition");
    const response = patrol2 ? world.pursuit.response : null;
    cap(
      arcadePatrol ? arcadePatrolLimit(road4) : rush && (patrol2 || car === world.player) ? rushRoadLimit(road4, patrol2) : road4.limit,
      "district-road-limit",
      road4.roadId
    );
    if (car !== world.player) {
      if (!patrol2)
        cap(
          (car.maxSpeed ?? speed) * (PROFILE[car.district.profile]?.speedFactor ?? 1),
          "district-profile",
          null
        );
      const s = Math.sin(car.heading), c = Math.cos(car.heading);
      const usualHeadway = car.district.headwayS ?? 1.6;
      for (const other of reversingHunt ? [] : world.actors) {
        if (other === car || other.type !== "vehicle") continue;
        if (arcadePatrol && (other === world.player || survival && world.pursuit.patrols.has(other))) continue;
        const target = response && other === world.player;
        if (target && !response.sightedBy.has(car)) continue;
        const measured2 = target ? response.lastSeen : other;
        const dx = measured2.x - car.x, dz = measured2.z - car.z;
        const halfLength = (car.length + other.length) / 2;
        const side = (car.width + other.width) / 2 + 0.18;
        const reach = 30 + Math.abs(halfLength) + Math.abs(side) + 1e-7;
        if (Math.abs(dx) > reach || Math.abs(dz) > reach || Math.abs(angleDelta(car.heading, measured2.heading)) > 0.65) continue;
        const forward2 = dx * s + dz * c;
        const lateral2 = Math.abs(dx * c - dz * s);
        const gap = forward2 - halfLength;
        if (forward2 <= 0 || lateral2 > side || gap > 30) continue;
        const headway = patrol2 ? other === world.player ? 0.55 : 0.95 : usualHeadway;
        cap(Math.min(
          Math.max(0, measured2.speed + (gap - 1.5 - Math.abs(car.speed) * headway) / headway),
          Math.sqrt(Math.max(0, measured2.speed ** 2 + 2 * 3.5 * (gap - 1.5)))
        ), "district-following", other.id);
      }
      if (car.district.loadingUntilTick !== null && world.tick < car.district.loadingUntilTick)
        cap(0, "district-loading", `loading:${car.id}`);
    }
    const hold = reversingHunt ? null : stateFor(world).holds[car.id];
    if (hold)
      cap(
        Math.sqrt(Math.max(0, hold.distanceM - (hold.stopBeforeM ?? 0.55)) * 2 * 3.5),
        hold.reason,
        hold.blockedBy
      );
    return result;
  }
  function districtBehaviorDiagnostics(world) {
    if (!isDistrict(world)) return null;
    const state = stateFor(world);
    return structuredClone({
      source: "world-reference",
      perceptionInput: false,
      tick: world.tick,
      reservations: state.reservations,
      queues: state.queues,
      approaches: state.approaches,
      holds: state.holds,
      metrics: state.metrics,
      events: state.events,
      actors: world.actors.slice(0, 170).map((actor) => ({
        id: actor.id,
        type: actor.type,
        profile: actor.district?.profile ?? actor.district?.pattern ?? null,
        stage: actor.district?.stage ?? null,
        acceptedDistanceM: actor.distance,
        speedMps: actor.speed,
        reason: actor.reason,
        blockedBy: actor.blockedBy ?? null
      }))
    });
  }

  // src/core/city-encounters.js
  var CITY_ENCOUNTERS = Object.freeze([
    "curb-pickup",
    "traffic-wave",
    "side-street-tuktuk",
    "curb-crossing",
    "roadworks"
  ]);
  var seconds = (value) => Math.round(value / STEP);
  var span = (road4, point2) => road4.axis === "z" ? point2.z : point2.x;
  var cross = (road4, point2) => road4.axis === "z" ? point2.x : point2.z;
  var place = (road4, along2, across) => road4.axis === "z" ? { x: across, z: along2 } : { x: along2, z: across };
  var longitudinal = (body, point2) => (point2.x - body.x) * Math.sin(body.heading) + (point2.z - body.z) * Math.cos(body.heading);
  var lateral = (body, point2) => Math.abs((point2.x - body.x) * Math.cos(body.heading) - (point2.z - body.z) * Math.sin(body.heading));
  function createCityEncounters(config) {
    const rng = new Random(`${config.seed}:city-encounters-v1`);
    return {
      rng,
      nextTick: seconds(config.scenarioInterval * rng.range(0.75, 1.2)),
      active: [],
      events: [],
      capByActor: /* @__PURE__ */ new Map(),
      lastStarted: /* @__PURE__ */ new Map(),
      serial: 0,
      lastKind: null
    };
  }
  function log(world, event2, phase, extra = {}) {
    const state = world.cityEncounters;
    state.events.push({
      id: event2.id,
      kind: event2.kind,
      phase,
      tick: world.tick,
      actorId: event2.actor?.id ?? event2.barrier?.id ?? null,
      roadId: event2.road?.id ?? null,
      x: event2.start.x,
      z: event2.start.z,
      ...extra
    });
    if (state.events.length > 32) state.events.shift();
    if (phase === "applied") world.metrics.scenarios++;
  }
  function nearZone(world, point2, margin = 1) {
    return world.district.conflictZones.some((zone) => point2.x >= zone.minX - margin && point2.x <= zone.maxX + margin && point2.z >= zone.minZ - margin && point2.z <= zone.maxZ + margin);
  }
  function laneAt2(world, actor) {
    return world.drivingRoads.find((road4) => span(road4, actor) >= road4.min && span(road4, actor) <= road4.max && Math.abs(cross(road4, actor) - road4.fixed) < road4.width / 2 && Math.abs(Math.sin(actor.heading - (road4.axis === "z" ? 0 : Math.PI / 2))) < 0.45);
  }
  function ordered(rng, candidates2) {
    return candidates2.map((candidate) => ({ candidate, order: rng.next() })).sort((a, b) => a.order - b.order).map((result) => result.candidate);
  }
  function vehicleEvent(kind, world, lead, road4, follower = null) {
    const now2 = world.tick, rng = world.cityEncounters.rng;
    const hold = kind === "side-street-tuktuk" ? rng.range(0.65, 1.4) : rng.range(2.4, 3.8) + world.config.difficulty * 0.18;
    const landing = kind === "traffic-wave" ? rng.range(0.45, 1.35) : 0;
    return {
      actor: lead,
      road: road4,
      follower,
      landing,
      start: { x: lead.x, z: lead.z },
      leadSpeed: lead.speed,
      followerSpeed: follower?.speed ?? 0,
      leadMin: lead.speed,
      followerMin: follower?.speed ?? 0,
      capUntil: now2 + seconds(hold),
      endTick: now2 + seconds(hold + 7)
    };
  }
  function chooseVehicle(kind, world, nearby) {
    const { player, cityEncounters: state } = world;
    const playerRoad = kind === "side-street-tuktuk" ? laneAt2(world, player) : null;
    if (kind === "side-street-tuktuk" && !playerRoad) return null;
    const civilians = nearby.filter((actor) => actor !== player && actor.type === "vehicle" && actor.pursuitRole !== "police" && actor.path.length > actor.cursor + 3);
    for (const actor of ordered(state.rng, civilians)) {
      if (state.capByActor.has(actor.id) || actor.speed < (kind === "side-street-tuktuk" ? 0.75 : 1.8)) continue;
      const road4 = laneAt2(world, actor), forward2 = longitudinal(player, actor);
      if (!road4) continue;
      if (kind === "curb-pickup") {
        if (!["van", "taxi"].includes(actor.kind) || forward2 < 6 || nearZone(world, actor, 4) || road4.width < 5.5) continue;
        return vehicleEvent(kind, world, actor, road4);
      }
      if (kind === "traffic-wave") {
        if (road4.zone !== "avenue" || forward2 < 7 || nearZone(world, actor, 4)) continue;
        const follower = civilians.concat(player).find((other) => other !== actor && other.speed > 1.3 && longitudinal(actor, other) < -5 && longitudinal(actor, other) > -25 && lateral(actor, other) < 1.6 && Math.abs(angleDelta(actor.heading, other.heading)) < 0.32);
        if (follower) return vehicleEvent(kind, world, actor, road4, follower);
      } else if (kind === "side-street-tuktuk") {
        if (actor.kind !== "tuktuk" || road4.axis === playerRoad.axis || forward2 < -3 || nearZone(world, actor)) continue;
        const join = world.junctions.find((node) => longitudinal(actor, node) > 5 && longitudinal(actor, node) < 19 && lateral(actor, node) < road4.width / 2 && longitudinal(player, node) > 5 && longitudinal(player, node) < 37 && lateral(player, node) < playerRoad.width / 2);
        if (join && actor.path.slice(actor.cursor, actor.cursor + 65).some((point2) => distance(join, point2) < 4))
          return { ...vehicleEvent(kind, world, actor, road4), join };
      }
    }
    return null;
  }
  function chooseCrossing(world, nearby) {
    const { cityEncounters: state, district, player } = world;
    for (const actor of ordered(state.rng, nearby.filter((actor2) => actor2.type === "pedestrian"))) {
      if (actor.crossing || actor.motionMode !== "ambient" || longitudinal(player, actor) < 2 || state.active.some((event2) => event2.actor === actor) || pointOnRoad(actor, world.roads)) continue;
      const line = district.walkways.find((walkway) => !walkway.doorway && Math.abs(cross(walkway, actor) - walkway.fixed) < 0.8 && span(walkway, actor) > walkway.min + 0.8 && span(walkway, actor) < walkway.max - 0.8);
      if (!line) continue;
      const road4 = district.drivingRoads.find((road5) => road5.id === line.roadId);
      const opposite = district.walkways.find((other) => !other.doorway && other.roadId === line.roadId && other.side !== line.side && other.axis === line.axis);
      if (!road4 || !opposite) continue;
      const at = span(line, actor);
      const along2 = road4.zone === "avenue" ? avenueCrossings(road4, world.drivingRoads).sort((a, b) => Math.abs(at - a) - Math.abs(at - b))[0] : at + state.rng.range(-1, 1);
      if (!Number.isFinite(along2) || Math.abs(along2 - at) > 3 || along2 < line.min + 0.6 || along2 > line.max - 0.6 || along2 < opposite.min + 0.6 || along2 > opposite.max - 0.6) continue;
      const curb = place(line, along2, line.fixed), target = place(opposite, along2, opposite.fixed);
      if (!walkSegmentClear(actor, actor, curb, world.statics, 0.12) || !walkSegmentClear(actor, curb, target, world.statics, 0.12)) continue;
      return {
        actor,
        road: road4,
        target,
        curb,
        originLine: line,
        targetLine: opposite,
        start: { x: actor.x, z: actor.z },
        initialDistance: actor.distance,
        endTick: world.tick + seconds(Math.max(13, distance(curb, target) / 0.95 + 5))
      };
    }
    return null;
  }
  function chooseRoadworks(world) {
    const { player, cityEncounters: state } = world;
    const road4 = laneAt2(world, player);
    if (!road4 || road4.width < 5.5) return null;
    const yaw = road4.axis === "z" ? 0 : Math.PI / 2;
    const ahead = angleDelta(player.heading, yaw);
    const direction3 = Math.cos(ahead) > 0 ? 1 : -1;
    const minimum = 17 + Math.abs(player.speed) * 0.55 + player.speed ** 2 / 7;
    for (const offset2 of ordered(state.rng, [0, 3, 6, 9, 12])) {
      const along2 = span(road4, player) + direction3 * (minimum + offset2);
      if (along2 < road4.min + 5 || along2 > road4.max - 5) continue;
      const centre = cross(road4, player);
      const side = Math.sign(centre - road4.fixed) || direction3;
      const position2 = place(road4, along2, road4.fixed + side * Math.min(road4.width / 2 - 1.2, Math.max(Math.abs(centre - road4.fixed), road4.laneOffsetM) + 0.6));
      const barrier2 = {
        ...position2,
        id: `metro-roadworks-${state.serial + 1}`,
        kind: "barrier",
        type: "static",
        width: 2,
        length: 0.62,
        height: 0.86,
        heading: yaw,
        cityEncounter: "roadworks"
      };
      if (nearZone(world, position2, 2.8) || !bodyOnRoad(barrier2, world.roads) || !world.free(barrier2, 2.5)) continue;
      return { barrier: barrier2, road: road4, start: position2, endTick: world.tick + seconds(state.rng.range(4.5, 6.5)) };
    }
    return null;
  }
  function refreshStatics(world) {
    world.staticIndex = new SpatialIndex(world.statics);
  }
  function admit(world, kind, event2) {
    const state = world.cityEncounters;
    Object.assign(event2, { id: ++state.serial, kind, applied: false, revealed: false });
    state.lastKind = kind;
    state.lastStarted.set(kind, world.tick);
    state.active.push(event2);
    log(world, event2, "started");
    if (event2.barrier) {
      if (world.statics === world.district.statics) world.statics = world.statics.slice();
      world.statics.push(event2.barrier);
      refreshStatics(world);
      event2.applied = true;
      log(world, event2, "applied");
    } else if (event2.target) {
      const { actor, road: road4, curb, target, originLine, targetLine } = event2;
      actor.target = target;
      actor.road = road4;
      actor.pause = state.rng.range(0.35, 0.9);
      actor.crossing = true;
      actor.side = originLine.side;
      actor.walkRoute = [curb, target];
      actor.walkGoal = `${target.x},${target.z}`;
      actor.walkPlanTick = world.tick;
      Object.assign(actor.district, {
        stage: "moving",
        pattern: "crossing",
        origin: { ...event2.start },
        destination: { ...target },
        routeConstrained: true,
        yieldAtCurb: true,
        holdAtTarget: false,
        targetRetryTick: event2.endTick,
        startedTick: world.tick,
        startedDistanceM: actor.distance,
        walkwayId: originLine.id,
        targetWalkwayId: targetLine.id
      });
    } else state.capByActor.set(event2.actor.id, event2);
  }
  function observeEffect(world, event2) {
    const { actor, follower, barrier: barrier2, start, applied } = event2;
    if (barrier2) {
      if (!event2.revealed) {
        const response = world.actors.find((actor2) => actor2.blockedBy === barrier2.id);
        if (response) {
          event2.revealed = true;
          log(world, event2, "response", { blockedId: response.id, speedMps: response.speed });
        }
      }
      return;
    }
    if (applied && !event2.revealed && actor.type === "vehicle" && world.tick >= event2.capUntil && actor.speed > event2.landing + 0.55) {
      event2.revealed = true;
      log(world, event2, "resumed", { speedMps: actor.speed });
    }
    if (applied && !event2.revealed && event2.target && distance(actor, event2.target) < 0.6) {
      event2.revealed = true;
      log(world, event2, "response", { reachedOppositeSide: true });
    }
    if (!applied && actor.type === "vehicle") {
      event2.leadMin = Math.min(event2.leadMin, actor.speed);
      if (follower && follower.blockedBy === actor.id)
        event2.followerMin = Math.min(event2.followerMin, follower.speed);
    }
    if (applied) return;
    let effect;
    if (event2.kind === "curb-pickup" && world.tick < event2.capUntil && actor.speed < 0.25)
      effect = { speedBeforeMps: event2.leadSpeed, speedMps: actor.speed };
    if (event2.kind === "traffic-wave" && event2.followerSpeed - event2.followerMin > 0.32 && event2.leadSpeed - event2.leadMin > 0.6)
      effect = {
        speedBeforeMps: event2.leadSpeed,
        speedMps: event2.leadMin,
        followerId: follower.id,
        followerDropMps: event2.followerSpeed - event2.followerMin
      };
    if (event2.kind === "side-street-tuktuk" && event2.leadSpeed - event2.leadMin > 0.3 && world.tick >= event2.capUntil && distance(start, actor) > 3 && distance(event2.join, actor) < 5)
      effect = { movedM: distance(start, actor), speedBeforeMps: event2.leadSpeed, lowMps: event2.leadMin };
    if (event2.kind === "curb-crossing" && actor.distance - event2.initialDistance > 1 && pointOnRoad(actor, [event2.road]))
      effect = { movedM: actor.distance - event2.initialDistance };
    if (effect) {
      event2.applied = true;
      log(world, event2, "applied", effect);
    }
  }
  function advanceCityEncounters(world) {
    const state = world.cityEncounters;
    if (!state || world.config.chaos === 0) return;
    for (let i = state.active.length - 1; i >= 0; i--) {
      const event2 = state.active[i];
      observeEffect(world, event2);
      if (world.tick < event2.endTick) continue;
      state.active.splice(i, 1);
      if (event2.actor) state.capByActor.delete(event2.actor.id);
      if (event2.barrier) {
        const index = world.statics.indexOf(event2.barrier);
        if (index >= 0) {
          world.statics.splice(index, 1);
          if (world.statics.length === world.district.statics.length && world.statics.every((body, index2) => body === world.district.statics[index2]))
            world.statics = world.district.statics;
          refreshStatics(world);
        }
      }
      log(world, event2, event2.applied ? event2.target && !event2.revealed ? "ended" : "cleared" : "not-observed");
    }
    const pursuing = world.pursuit?.phase === "running";
    if (world.tick < state.nextTick || pursuing && world.pursuit.gta?.config.ruleset !== DISPATCH_RULESET) return;
    state.nextTick = world.tick + seconds(world.config.scenarioInterval * state.rng.range(0.8, 1.25));
    if (Math.abs(world.player.speed) < 0.5 || state.active.length >= (world.config.difficulty >= 4 ? 3 : 1) || state.rng.next() > world.config.chaos) return;
    const nearby = world.actorIndex.near(world.player, 46);
    for (const kind of ordered(state.rng, CITY_ENCOUNTERS)) {
      if (pursuing && kind === "roadworks") continue;
      const cooldown = kind === "roadworks" ? 11 : 5;
      if (kind === state.lastKind || world.tick - (state.lastStarted.get(kind) ?? -Infinity) < seconds(cooldown) || state.active.some((event3) => event3.kind === kind)) continue;
      const event2 = kind === "roadworks" ? chooseRoadworks(world) : kind === "curb-crossing" ? chooseCrossing(world, nearby) : chooseVehicle(kind, world, nearby);
      if (!event2) continue;
      admit(world, kind, event2);
      return;
    }
  }
  function capCityEncounter(world, actor, command) {
    const event2 = world.cityEncounters?.capByActor.get(actor.id);
    if (!event2 || world.tick >= event2.capUntil || command.targetSpeed <= event2.landing) return command;
    return { ...command, targetSpeed: event2.landing, reason: event2.kind, blockedBy: null };
  }

  // src/core/district-scenarios.js
  var DISTRICT_CASES = Object.freeze([
    ["ambient", "District life", "The requested seeded population, without a clean-case fixture."],
    ["visible-left", "Visible crossing \xB7 left", "An actual walker enters from the left after the ego reaches the approach marker."],
    ["visible-right", "Visible crossing \xB7 right", "The mirrored actual crossing with the same physical walking bounds."],
    ["diagonal-hesitant", "Diagonal and hesitation", "A walker reaches a diagonal intermediate point, holds, then resumes."],
    ["partial-occluded-history", "Partial occlusion and history", "Actual movement beside the registered occluder supplies only the pixels that are visible."],
    ["fully-hidden-emergence", "Hidden emergence", "A walker emerges from behind the registered vehicle; the map cannot know it is there."],
    ["same-occluder-empty", "Same occluder \xB7 empty", "The same static occluder and seeded draws, without the walker."],
    ["stationary-curb", "Stationary curb", "A real stationary person is not a crossing instruction."],
    ["parallel-away", "Parallel walking", "A bounded walker follows the declared curb away from the ego."],
    ["blind-corner-empty", "Blind corner \xB7 empty", "Static mapped caution without a hidden pedestrian."],
    ["two-car-narrow-passage", "Opposing narrow passage", "Construction-time opposing vehicles share the actual fair passage resource."],
    ["queue-alternate-route", "Queue and alternate route", "Construction-time traffic queues and may replan without changing its pose."],
    ["camera-loss-recovery", "Camera loss and recovery", "The same actual crossing; camera withholding and recovery are external observations, not actor cues."]
  ].map(([id, label, description]) => Object.freeze({ id, label, description })));
  var EMPTY_CASES = /* @__PURE__ */ new Set([
    "same-occluder-empty",
    "blind-corner-empty",
    "two-car-narrow-passage",
    "queue-alternate-route"
  ]);
  var CROSSING_CASES = /* @__PURE__ */ new Set([
    "visible-left",
    "visible-right",
    "diagonal-hesitant",
    "partial-occluded-history",
    "fully-hidden-emergence",
    "camera-loss-recovery"
  ]);
  function checkedPose(value, name) {
    if (!value || ![value.x, value.z].every(Number.isFinite) || value.heading !== void 0 && !Number.isFinite(value.heading))
      throw new TypeError(`District case requires a finite ${name}`);
    return {
      x: value.x,
      z: value.z,
      heading: value.heading ?? 0,
      ...value.roadId ? { roadId: value.roadId } : {}
    };
  }
  function closestWalkline(district, start) {
    return [...district.walkways ?? []].sort((a, b) => {
      const gap = (line) => {
        const position2 = line.axis === "z" ? start.z : start.x;
        const lateral2 = line.axis === "z" ? start.x : start.z;
        return Math.hypot(
          lateral2 - line.fixed,
          Math.max(line.min - position2, 0, position2 - line.max)
        );
      };
      return gap(a) - gap(b);
    })[0];
  }
  function makePerson(district, anchor, caseId, samples) {
    const start = checkedPose(anchor.actorStart, "actorStart");
    const target = checkedPose(anchor.actorTarget, "actorTarget");
    const line = closestWalkline(district, start);
    const roads = district.drivingRoads ?? district.roads ?? [];
    const road4 = roads.find((item) => item.id === (start.roadId ?? line?.roadId));
    if (!road4 || !line)
      throw new RangeError(`District case ${caseId} has no declared actor walkline/road`);
    const person = {
      id: "district-case-person",
      type: "pedestrian",
      kind: "man-polo",
      x: start.x,
      z: start.z,
      heading: caseId === "stationary-curb" ? start.heading : Math.atan2(target.x - start.x, target.z - start.z),
      speed: 0,
      walkSpeed: 1.05 + samples[0] * 0.2,
      radius: 0.34,
      phase: 0.2 + samples[1] * 0.1,
      distance: 0,
      wait: 0,
      pause: 0,
      reason: "waiting",
      road: road4,
      side: line.side,
      along: line.axis === "z" ? start.z : start.x,
      crossing: CROSSING_CASES.has(caseId),
      target: { x: target.x, z: target.z },
      walkRoute: null,
      motionMode: "ambient",
      accelerationMps2: 0,
      motionTimeS: 0,
      district: {
        caseId,
        pattern: caseId === "stationary-curb" ? "stationary" : caseId === "parallel-away" ? "parallel" : "crossing",
        caseStage: "waiting",
        stage: "waiting",
        yieldAtCurb: !CROSSING_CASES.has(caseId),
        holdAtTarget: true,
        routeConstrained: true,
        observedDistanceM: 0,
        walkwayId: line.id,
        origin: { x: start.x, z: start.z },
        destination: { x: target.x, z: target.z },
        intermediate: {
          x: start.x + (target.x - start.x) * 0.38,
          z: start.z + (target.z - start.z) * 0.38
        },
        hesitationS: 0.45 + samples[2] * 0.35,
        triggerEgoAlongM: anchor.triggerEgoAlongM,
        triggers: []
      }
    };
    person.body = createPedestrianBody(person);
    person.radius = person.body.radiusM;
    for (const [name, point2] of [["start", person], ["target", target]])
      if (!walkSegmentClear(person, point2, point2, district.statics ?? [], 0.12))
        throw new RangeError(`District case ${caseId} actor ${name} intersects a registered static`);
    return person;
  }
  function makeTraffic(district, anchor, requestedSpeedMps) {
    const caseId = anchor.matrixCase ?? anchor.id;
    const loading = caseId === "queue-alternate-route";
    const loadingRoad = loading ? district.drivingRoads?.find((road4) => road4.id === "entry-local") : null;
    return (anchor.traffic ?? []).map((item, index) => {
      const service = loading && index === 0;
      const start = checkedPose(service && loadingRoad ? {
        ...districtRoadPose(loadingRoad, loadingRoad.min + 15.5),
        roadId: loadingRoad.id
      } : item.start, "traffic start");
      const goal = checkedPose(item.goal, "traffic goal");
      return {
        id: item.id ?? `district-case-traffic-${index}`,
        type: "vehicle",
        kind: item.kind ?? "sedan",
        ...start,
        goal,
        speed: 0,
        steer: 0,
        length: VEHICLE.length,
        width: VEHICLE.width,
        maxSpeed: requestedSpeedMps,
        spec: null,
        path: [],
        cursor: 0,
        distance: 0,
        wait: 0,
        reason: "ready",
        phase: 0.5,
        reckless: false,
        district: {
          caseId,
          profile: "ordinary",
          headwayS: 1.6,
          nextLoadingDistanceM: service ? 5 : null,
          loadingUntilTick: null,
          reroutedTicket: null,
          goal: { ...goal },
          allowReroute: loading,
          ...service ? { loadingEnabled: true, loadingOnce: true, loadingDurationS: 10 } : {}
        }
      };
    });
  }
  function createDistrictCase(district, caseId = "ambient", seed = "") {
    if (!DISTRICT_CASES.some((item) => item.id === caseId))
      throw new RangeError(`Unknown district case: ${String(caseId)}`);
    if (caseId === "ambient") return null;
    const anchor = district.caseAnchors?.find((item) => item.matrixCase === caseId || item.id === caseId);
    if (!anchor) throw new RangeError(`District profile has no anchor for ${caseId}`);
    const playerStart = checkedPose(anchor.playerStart, "playerStart");
    const route = district.showcaseRoutes?.find((item) => item.id === anchor.routeId);
    const goal = checkedPose(anchor.goal ?? route?.goal, "goal");
    if (!Number.isFinite(anchor.triggerEgoAlongM) || anchor.triggerEgoAlongM < 0)
      throw new RangeError(`District case ${caseId} has no nonnegative ego-distance trigger`);
    const rng = new Random(`${String(seed)}:district-case-v1`);
    const samples = Array.from({ length: 4 }, () => rng.next());
    const requestedSpeedMps = Number.isFinite(anchor.requestedSpeedMps) ? Math.max(0, Math.min(4.5, anchor.requestedSpeedMps)) : 4.5;
    const traffic = makeTraffic(district, anchor, requestedSpeedMps);
    if (["two-car-narrow-passage", "queue-alternate-route"].includes(caseId) && !traffic.length)
      throw new RangeError(`District traffic case ${caseId} needs construction-time opposing traffic`);
    return {
      id: caseId,
      playerStart,
      goal,
      people: EMPTY_CASES.has(caseId) ? [] : [makePerson(district, anchor, caseId, samples)],
      traffic,
      requestedSpeedMps,
      triggerEgoAlongM: anchor.triggerEgoAlongM,
      allowReroute: caseId === "queue-alternate-route",
      phase: "ready",
      startedTick: null,
      anchorId: anchor.id,
      occluderId: anchor.occluderId ?? null,
      waitingZoneId: anchor.waitingZoneId ?? null,
      emptyTwin: anchor.emptyTwin ?? null,
      caseRngState: rng.state,
      triggeredTick: null,
      triggerObservedAlongM: null,
      populationLabel: "clean construction-time district fixture; not the 28/32 ambient workload"
    };
  }
  function recordTrigger(world, person, trigger, details = {}) {
    const entry = {
      tick: world.tick,
      trigger,
      x: person.x,
      z: person.z,
      speedMps: person.speed,
      acceptedDistanceM: person.distance,
      ...details
    };
    person.district.triggers.push(entry);
    if (person.district.triggers.length > 16) person.district.triggers.shift();
  }
  function advanceDistrictCase(world, person) {
    if (world.environment !== "egypt" || world.districtCase?.phase !== "running" || !person.district?.caseId)
      return { ...person };
    const working = {
      ...person,
      target: { ...person.target },
      walkRoute: person.walkRoute?.map((point2) => ({ ...point2 })) ?? null,
      district: {
        ...person.district,
        origin: { ...person.district.origin },
        destination: { ...person.district.destination },
        intermediate: { ...person.district.intermediate },
        triggers: [...person.district.triggers]
      }
    };
    const state = working.district, fixture = world.districtCase;
    const start = fixture.playerStart;
    const egoAlongM = (world.player.x - start.x) * Math.sin(start.heading) + (world.player.z - start.z) * Math.cos(start.heading);
    let hold = state.caseId === "stationary-curb";
    if (state.caseStage === "waiting") {
      hold = true;
      if (egoAlongM >= fixture.triggerEgoAlongM) {
        state.caseStage = hold && state.caseId === "stationary-curb" ? "stationary" : "moving";
        fixture.triggeredTick ??= world.tick;
        fixture.triggerObservedAlongM ??= egoAlongM;
        recordTrigger(world, working, "actual-ego-approach-distance", {
          egoAlongM,
          thresholdM: fixture.triggerEgoAlongM
        });
        if (state.caseId === "diagonal-hesitant")
          working.target = { ...state.intermediate };
        hold = state.caseId === "stationary-curb";
      }
    }
    if (state.caseStage === "moving" && state.caseId === "diagonal-hesitant" && !state.hesitated && distance(working, state.intermediate) < 0.3 && working.speed < 0.08) {
      state.hesitated = true;
      state.caseStage = "hesitating";
      state.holdUntilTick = world.tick + Math.ceil(state.hesitationS / STEP);
      working.walkRoute = null;
      recordTrigger(world, working, "accepted-intermediate-arrival");
    }
    if (state.caseStage === "hesitating") {
      hold = world.tick < state.holdUntilTick;
      if (!hold) {
        state.caseStage = "moving";
        working.target = { ...state.destination };
        working.walkRoute = null;
        recordTrigger(world, working, "bounded-hesitation-complete", {
          holdS: state.hesitationS
        });
      }
    }
    if (state.caseStage === "moving" && (state.caseId !== "diagonal-hesitant" || state.hesitated) && distance(working, state.destination) < 0.3 && working.speed < 0.08) {
      state.caseStage = "complete";
      recordTrigger(world, working, "accepted-destination-arrival");
    }
    if (["complete", "stationary", "waiting"].includes(state.caseStage)) hold = true;
    state.stage = state.caseStage;
    const requestedMode = working.motionMode;
    if (hold) working.motionMode = "stop";
    const proposal = stepDistrictPedestrian(world, working);
    proposal.motionMode = requestedMode;
    if (hold && proposal.reason !== "blocked") proposal.reason = `district-${state.caseStage}`;
    return proposal;
  }

  // src/core/pack-drills.js
  var PACK_DRILLS = Object.freeze([
    {
      id: "pack-dodge",
      label: "Thread the pack",
      description: "Three patrols close from the rear, side and front. Take the open arm of the junction."
    },
    {
      id: "pack-touch",
      label: "Rear bumper touch",
      description: "The SUV starts still, with a slow patrol already close behind. See how a light bumper touch ends the run."
    },
    {
      id: "pack-crossing",
      label: "Yield and resume",
      description: "Give the person already crossing space, then continue past the crossing."
    },
    {
      id: "pack-person-impact",
      label: "Too close to stop",
      description: "The practice car starts rolling just before a close crosswalk conflict. Watch the real contact and its consequence."
    }
  ].map(Object.freeze));
  var road2 = (axis, fixed, min, max, width) => ({ axis, fixed, min, max, width });
  var pose2 = (x, z, heading2 = 0, speed = 0) => ({ x, z, heading: heading2, speed });
  var wall = (id, x, z) => ({ id, type: "static", kind: "wall", x, z, heading: 0, width: 0.56, length: 8.2, height: 1.15 });
  function patrol(id, x, z, heading2, speed, behaviour, cruise) {
    return { id: `pack-patrol-${id}`, position: pose2(x, z, heading2, speed), behaviour, cruise };
  }
  function dodge(scene, rng, side, origin) {
    const start = scene.playerStart = pose2(side * 0.48, origin - 4.1, 0, rng.range(3.75, 4.2));
    scene.drivingRoads.push(
      road2("z", 0, origin - 36, origin + 43, 15.6),
      road2("x", origin + 4.2, -40, 40, 21.2)
    );
    scene.statics.push(
      wall("pack-corner-wall", -side * 10.1, origin + 21.2),
      wall("pack-entry-wall", side * 10.1, origin - 15.7)
    );
    scene.exits.push({ id: "open-arm", x: side * 29, z: origin + 4.2 });
    scene.cars.push(
      patrol(
        "rear",
        start.x + side * rng.range(0.48, 0.82),
        start.z - rng.range(15, 16.4),
        0,
        rng.range(4.7, 5.3),
        "tail",
        10.8
      ),
      patrol(
        "side",
        -side * rng.range(16.6, 18.1),
        start.z - rng.range(0.55, 0.82),
        side * Math.PI / 2,
        rng.range(4.3, 5),
        "flank",
        9.5
      ),
      patrol(
        "front",
        -side * rng.range(3.5, 4.3),
        start.z + rng.range(17.2, 18.8),
        Math.PI,
        rng.range(3.75, 4.4),
        "intercept",
        8.9
      )
    );
  }
  function touch(scene, rng, side, origin) {
    const x = side * 0.53;
    scene.drivingRoads.push(road2("z", 0, origin - 27, origin + 38, 7.6));
    scene.playerStart = pose2(x, origin);
    scene.exits.push({ id: "ahead", x, z: origin + 26 });
    const gap = rng.range(0.31, 0.37);
    scene.cars.push(patrol(
      "rear",
      x + side * rng.range(0.04, 0.13),
      origin - PLAYER_VEHICLE.lengthM - gap,
      0,
      rng.range(1.35, 1.54),
      "tail",
      rng.range(1.62, 1.78)
    ));
  }
  function crossing2(scene, rng, side, origin, close) {
    const width = 6.4, x = side * 0.32;
    const speed = close ? rng.range(5.2, 5.55) : rng.range(3.75, 4.1);
    const across = close ? rng.range(0.82, 1) : rng.range(1.76, 1.89);
    const gap = close ? rng.range(0.77, 0.92) : rng.range(6, 6.3);
    const along2 = origin + PLAYER_VEHICLE.lengthM / 2 + gap;
    scene.drivingRoads.push(road2("z", 0, origin - 23, origin + 39, width));
    scene.playerStart = pose2(x, origin, 0, speed);
    scene.exits.push({ id: "beyond-crossing", x, z: origin + 25 });
    scene.people.push({
      id: "pack-crossing-walker",
      road: 0,
      along: along2,
      side,
      pause: 0,
      started: true,
      pose: { x: x - side * across, z: along2, heading: side * Math.PI / 2 },
      walkSpeed: rng.range(1.65, 1.83),
      target: { x: side * (width / 2 + 0.98), z: along2 }
    });
  }
  function createPackDrill(caseId, seed) {
    const rng = new Random(`${seed}:pack-drill-v1:${caseId}`);
    const side = rng.next() < 0.5 ? -1 : 1;
    const origin = rng.range(-0.45, 0.45);
    const scene = {
      drivingRoads: [],
      shoulders: [],
      statics: [],
      playerStart: null,
      exits: [],
      cars: [],
      people: [],
      closure: null
    };
    switch (caseId) {
      case "pack-dodge":
        dodge(scene, rng, side, origin);
        break;
      case "pack-touch":
        touch(scene, rng, side, origin);
        break;
      case "pack-crossing":
      case "pack-person-impact":
        crossing2(scene, rng, side, origin, caseId === "pack-person-impact");
        break;
      default:
        throw new RangeError(`Unknown pack drill: ${caseId}`);
    }
    return scene;
  }

  // src/core/pack-patrol.js
  var SLOTS = [
    { role: "tail", bearing: 3.02, range: 18, forward: -6.5, lateral: 0.8 },
    { role: "flank", bearing: 1.67, range: 19.5, forward: -0.5, lateral: 7.4, openingRange: 7.6 },
    { role: "intercept", bearing: -0.15, range: 21, forward: 7.1, lateral: -1.6 },
    { role: "flank", bearing: -1.72, range: 19.5, forward: -1.2, lateral: -7.4, openingRange: 8.6 },
    { role: "tail", bearing: -2.57, range: 22, forward: -5.7, lateral: -3.4 },
    { role: "intercept", bearing: 0.71, range: 23, forward: 5.9, lateral: 5 },
    { role: "tail", bearing: 2.48, range: 23, forward: -5.6, lateral: 4.3 },
    { role: "intercept", bearing: -0.78, range: 23, forward: 5.3, lateral: -5.4 }
  ];
  var slotFor = (order = 0) => SLOTS[order % SLOTS.length];
  var ringFor = (order = 0) => Math.min(2, Math.floor(order / SLOTS.length));
  var ageOf = (report, tick) => Math.max(0, tick - (report.tick ?? tick)) * STEP;
  var headingTo2 = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
  function offset(report, forward2, lateral2) {
    const s = Math.sin(report.heading), c = Math.cos(report.heading);
    return { x: report.x + s * forward2 + c * lateral2, z: report.z + c * forward2 - s * lateral2 };
  }
  function packTactic(order) {
    return slotFor(order).role;
  }
  function packSpawnBias({ order, forward: forward2, lateral: lateral2, range, alignment, opening, fronts = [] }) {
    const slot = slotFor(order);
    const bearing = Math.atan2(lateral2, forward2);
    const ring = ringFor(order);
    const closeFlank = opening && ring === 0 && slot.openingRange !== void 0;
    const desiredRange = closeFlank ? slot.openingRange : slot.range + 2.5 * ring + (opening ? 0 : 2);
    let crowding = 0;
    for (const other of fronts) {
      const gap = Math.abs(angleDelta(bearing, Math.atan2(other.lateral, other.forward)));
      const sharedArc = Math.max(0, 1 - gap / (Math.PI / 2));
      crowding = Math.max(crowding, 33 * sharedArc ** 2);
    }
    const parallel = closeFlank ? clamp((20 - range) / 10, 0, 1) : 0;
    const alignmentCost = slot.role === "tail" ? 5 * (1 - alignment) : slot.role === "intercept" ? 4 * (1 + alignment) : (1 - parallel) * 5 * Math.abs(alignment) + parallel * 6 * (1 - alignment);
    return Math.abs(range - desiredRange) * 0.68 + Math.abs(angleDelta(bearing, slot.bearing)) * (closeFlank ? 13 : 10) + alignmentCost + crowding;
  }
  function packApproach({ car, report, order, street, tick, startedTick, clear }) {
    const hold = () => ({ x: car.x, z: car.z, heading: car.heading, speed: 0 });
    if (!report) return hold();
    const slot = slotFor(order);
    const range = Math.hypot(car.x - report.x, car.z - report.z);
    const age = ageOf(report, tick);
    const freshness = clear === false ? 0 : clamp(1 - age / 0.8, 0, 1);
    const canUse = typeof clear === "function" ? clear : null;
    const opening = clamp(1 - (tick - (startedTick ?? tick)) * STEP / 2.4, 0, 1);
    const spread = 0.91 + 0.23 * opening + 0.13 * ringFor(order);
    const measuredSpeed = report.speed ?? 0;
    const horizon = street ? clamp(0.34 + range * 0.018, 0.38, 0.84) : clamp(0.22 + range * 0.016, 0.24, 0.62);
    const leadLimit = street ? 7.2 : 5.4;
    const lead = clamp(measuredSpeed * horizon, -leadLimit, leadLimit) * freshness;
    const speed = clamp((street ? 7.4 : 5.8) + 0.58 * Math.abs(measuredSpeed) * freshness + 0.064 * range, 0, street ? 15.5 : 10.8);
    const centre = offset(report, lead, 0);
    for (const scale of [spread, spread * 0.49, 0]) {
      const point2 = scale ? offset(report, lead + slot.forward * scale, slot.lateral * scale) : { x: report.x, z: report.z };
      const heading2 = scale ? headingTo2(point2, centre) : headingTo2(car, point2);
      const aim = { ...point2, heading: heading2, speed };
      if (!canUse || canUse(aim)) return aim;
    }
    return hold();
  }
  function packRamAim({ car, report, order, tick, startedTick }) {
    if (!report || ageOf(report, tick) > 0.3) return null;
    const range = Math.hypot(car.x - report.x, car.z - report.z);
    const progress = clamp((tick - (startedTick ?? tick)) * STEP / 3, 0, 1);
    if (range > 12.5 + 13.5 * progress) return null;
    const slot = slotFor(order);
    const measuredSpeed = report.speed ?? 0;
    const lead = clamp(measuredSpeed * clamp(range / (Math.max(3, car.speed ?? 0) + 10), 0.08, 0.55), -5.2, 5.2);
    const staging = clamp((range - 6) / 17, 0, 1);
    const openingPace = (slot.role === "flank" ? 3.8 : 4.6) + 0.2 * Math.min(8, Math.abs(measuredSpeed));
    const speed = Math.min(
      5.1 + 0.82 * Math.abs(measuredSpeed) + 0.095 * range,
      openingPace + (15.5 - openingPace) * progress ** 1.5
    );
    const projected = offset(report, lead + 0.16 * slot.forward * staging, 0.35 * slot.lateral * staging);
    for (const point2 of [projected, offset(report, lead, 0), report]) {
      const heading2 = headingTo2(car, point2);
      if (Math.hypot(point2.x - car.x, point2.z - car.z) < 0.35 || Math.abs(angleDelta(heading2, car.heading)) > (range < 9 ? 0.87 : 0.73)) continue;
      return { x: point2.x, z: point2.z, heading: heading2, speed };
    }
    return null;
  }
  function assignGtaSquad(patrols, report) {
    const slots = [...patrols].filter((unit2) => !isGtaStationary(unit2)).map((unit2) => ({
      unit: unit2,
      ...gtaLocal(report, unit2),
      previousRole: unit2.squadRole,
      previousSide: unit2.squadSide
    }));
    for (const { unit: unit2 } of slots) {
      unit2.squadRole = "SUPPORT";
      unit2.squadSide = 0;
    }
    const assign = (role, side, forward2, right, typeBias) => {
      const score = (slot) => Math.hypot((slot.forward - forward2) * 0.85, slot.right - right) + typeBias(slot.unit.unitType) - (slot.previousRole === role && slot.previousSide === side ? 1.5 : 0);
      slots.sort((a, b) => score(a) - score(b) || a.unit.gtaAI.order - b.unit.gtaAI.order);
      const chosen = slots.shift()?.unit;
      if (chosen) {
        chosen.squadRole = role;
        chosen.squadSide = side;
      }
    };
    const count = slots.length;
    assign("PRIMARY_CHASER", 0, -9, 0, (type) => type === "swat" ? 9 : 0);
    const fast = (type) => type === "interceptor" ? -8 : type === "swat" ? 4 : 0;
    if (count >= 4) assign("INTERCEPTOR", 1, 17, 3, fast);
    if (count >= 6) assign("INTERCEPTOR", -1, 21, -3, fast);
    assign("FLANKER", -1, 0, -7, (type) => type === "swat" ? 5 : 0);
    assign("FLANKER", 1, 0, 7, (type) => type === "swat" ? 5 : 0);
  }
  function gtaSpacingSteer(car, patrols) {
    let bias = 0;
    for (const other of patrols) {
      if (other === car || isGtaStationary(other)) continue;
      const { forward: forward2, right } = gtaLocal(car, other);
      const distance2 = Math.hypot(forward2, right);
      if (Math.abs(right) > 4.8 || distance2 > 9) continue;
      const side = Math.abs(right) > 0.25 ? Math.sign(right) : car.gtaAI.order < other.gtaAI.order ? 1 : -1;
      bias -= side * 0.14 * (1 - distance2 / 9);
    }
    return clamp(bias, -0.19, 0.19);
  }

  // src/core/pursuit-controls.js
  var PURSUIT_STOP = Object.freeze({ steer: 0, throttle: 0, brake: 1, gear: 1 });
  function validatePursuitAction(action) {
    if (!action || Object.getPrototypeOf(action) !== Object.prototype || Object.keys(action).length !== 4 || ![action.steer, action.throttle, action.brake].every(Number.isFinite) || Math.abs(action.steer) > 1 || action.throttle < 0 || action.throttle > 1 || action.brake < 0 || action.brake > 1 || ![1, -1].includes(action.gear))
      throw new RangeError("Pursuit action needs normalized steering, throttle and brake, and gear 1 or -1");
    return action;
  }
  function pursuitCommand(body, action, dt = STEP) {
    const maxSteer = body.spec?.maxSteer ?? VEHICLE.maxSteer;
    const steer = action.steer * maxSteer;
    if (action.brake > 0) return {
      steer,
      targetSpeed: 0,
      decelerationMps2: (body.spec?.braking ?? VEHICLE.braking) * action.brake
    };
    const speed = body.speed ?? 0;
    const limit = action.gear > 0 ? body.maxSpeed ?? 9.72 : VEHICLE.reverseSpeed;
    const acceleration = (body.spec?.acceleration ?? VEHICLE.acceleration) * action.throttle;
    const targetSpeed = action.throttle === 0 ? Math.sign(speed) * Math.max(0, Math.abs(speed) - 0.18 * dt) : action.gear * clamp(speed * action.gear + acceleration * dt, acceleration * dt, limit);
    return { steer, targetSpeed };
  }

  // src/core/pack-driving.js
  var PACK_ACTIONS = Object.freeze([
    "follow",
    "forward",
    "left",
    "right",
    "tight-left",
    "tight-right",
    "ease",
    "hold",
    "reverse-left",
    "reverse-right",
    "reverse",
    "creep",
    "creep-left",
    "creep-right"
  ]);
  var PACK_PENALTIES = Object.freeze({ police: 120, pedestrian: 240 });
  function pedestrianImpactCost(closingMps) {
    return PACK_PENALTIES.pedestrian + Math.round(clamp(closingMps, 0, 15) * 8);
  }
  function packCommand(body, action, dt = STEP) {
    const command = pursuitCommand(body, action, dt);
    const speed = Math.max(Math.abs(body.speed ?? 0), Math.abs(command.targetSpeed));
    const wheelbase = body.spec?.wheelbase ?? VEHICLE.wheelbase;
    const curveLimit = Math.atan2(4.6 * wheelbase, speed ** 2);
    const desired = clamp(command.steer, -curveLimit, curveLimit);
    const accepted = body.steer ?? 0;
    const maxChange = 0.88 * dt;
    command.steer = accepted + clamp((desired - accepted) * -Math.expm1(-dt / 0.14), -maxChange, maxChange);
    return command;
  }
  var SCHEMA = 1;
  var ALGORITHM = "pack-tabular-q-learning";
  var HOLD = PACK_ACTIONS.indexOf("hold");
  var MAX_STATES = 5 * 3 ** 3;
  var MAX_Q = 4096;
  var KEY = /^pack-v1:(?:none|front|rear|left|right):[0-2]:(?:reverse|slow|moving):[0-2]$/;
  var validKey = (key3) => typeof key3 === "string" && KEY.test(key3);
  var validIndex = (index) => Number.isInteger(index) && index >= 0 && index < PACK_ACTIONS.length;
  function starterPackPolicy() {
    const q = {};
    for (const threat of ["none", "front", "rear", "left", "right"])
      for (let crowd = 0; crowd < 3; crowd++)
        for (const pace of ["reverse", "slow", "moving"])
          for (let openings = 0; openings < 3; openings++) {
            const row = [1.4, 1, 0.6, 0.6, 0.15, 0.15, 0, -0.5, -0.8, -0.8, -0.7, 0.35, 0.15, 0.15];
            if (threat === "rear") {
              row[1] += 3;
              row[7] -= 2;
            } else if (threat === "front") {
              for (const index of [2, 3, 8, 9, 10]) row[index] += pace === "slow" ? 2.8 : 1.4;
              row[1] -= 1.5;
            } else if (threat === "left" || threat === "right") {
              const right = threat === "left";
              row[right ? 3 : 2] += 2.6;
              row[right ? 5 : 4] += 1.1;
            }
            if (openings === 0 && pace !== "moving")
              for (const index of [8, 9, 10]) row[index] += 1.6;
            q[`pack-v1:${threat}:${crowd}:${pace}:${openings}`] = row;
          }
    return { schemaVersion: SCHEMA, algorithm: ALGORITHM, actions: [...PACK_ACTIONS], updates: 0, q };
  }
  function validatePackPolicy(checkpoint) {
    if (!checkpoint || Object.getPrototypeOf(checkpoint) !== Object.prototype || checkpoint.schemaVersion !== SCHEMA || checkpoint.algorithm !== ALGORITHM || !Number.isSafeInteger(checkpoint.updates) || checkpoint.updates < 0 || !Array.isArray(checkpoint.actions) || checkpoint.actions.length !== PACK_ACTIONS.length || !PACK_ACTIONS.every((name, i) => Object.hasOwn(checkpoint.actions, i) && checkpoint.actions[i] === name) || !checkpoint.q || Object.getPrototypeOf(checkpoint.q) !== Object.prototype)
      throw new Error("Unsupported pack policy checkpoint");
    const rows = Object.entries(checkpoint.q);
    if (rows.length > MAX_STATES || rows.some(([key3, row]) => !validKey(key3) || !Array.isArray(row) || row.length !== PACK_ACTIONS.length || !PACK_ACTIONS.every((_, i) => Object.hasOwn(row, i) && Number.isFinite(row[i]) && Math.abs(row[i]) <= MAX_Q)))
      throw new Error("Invalid pack policy weights");
    return checkpoint;
  }
  function measured(metrics) {
    const values = {
      distanceM: metrics?.distanceM ?? metrics?.progress,
      collisions: metrics?.collisions ?? 0,
      policeContacts: metrics?.policeContacts ?? 0,
      pedestrianCollisions: metrics?.pedestrianCollisions ?? 0,
      nearCollisions: metrics?.nearCollisions ?? 0,
      survivalS: metrics?.survivalS ?? null,
      guard: typeof metrics?.guard === "string" ? metrics.guard.slice(0, 40) : null,
      pedestrianDanger: metrics?.pedestrianDanger ?? 0,
      pedestrianCost: metrics?.pedestrianCost ?? 0,
      pedestrianCleared: metrics?.pedestrianCost !== void 0 && metrics.firstClearTick != null ? 1 : 0
    };
    if (!Number.isFinite(values.distanceM) || values.distanceM < 0 || [values.collisions, values.policeContacts, values.pedestrianCollisions, values.nearCollisions].some((value) => !Number.isSafeInteger(value) || value < 0) || values.survivalS !== null && (!Number.isFinite(values.survivalS) || values.survivalS < 0)) return null;
    return values;
  }
  function executed(decision2, before) {
    if (!before || !validKey(decision2?.key) || !validIndex(decision2.index) || !Array.isArray(decision2.availableActions)) return null;
    const safe = decision2.availableActions.filter(validIndex);
    const forcedHold = decision2.forcedHold === true && decision2.availableActions.length === 0 && decision2.index === HOLD;
    if (!forcedHold && !safe.includes(decision2.index)) return null;
    return {
      key: decision2.key,
      index: decision2.index,
      safe,
      before,
      forcedHold,
      source: decision2.source === "learned-tactical" || decision2.source === "exploration" ? decision2.source : "rollout",
      lookup: decision2.policyLookup === true && safe.length > 0,
      changed: decision2.changed === true && decision2.index === decision2.learnedIndex
    };
  }
  function createPackLearner(seed, checkpoint = null, training = true) {
    if (checkpoint !== null) validatePackPolicy(checkpoint);
    const rng = new Random(`${seed}:pack-learning-v1`);
    const q = /* @__PURE__ */ Object.create(null);
    for (const [key3, row] of Object.entries(checkpoint?.q ?? {}))
      q[key3] = training ? [...row] : Object.freeze([...row]);
    if (!training) Object.freeze(q);
    const weights = Object.freeze({ q });
    let prior = null, lastTransition = null;
    let updates = checkpoint?.updates ?? 0;
    let states = Object.keys(q).length, explored = 0, lookups = 0, changedDecisions = 0;
    function settle(after, next, terminal) {
      if (!prior || !after) return;
      const { key: key3, index, before, forcedHold, source, lookup, changed } = prior;
      const deltas = {
        distanceM: after.distanceM - before.distanceM,
        collisions: after.collisions - before.collisions,
        policeContacts: after.policeContacts - before.policeContacts,
        pedestrianCollisions: after.pedestrianCollisions - before.pedestrianCollisions,
        nearCollisions: after.nearCollisions - before.nearCollisions,
        elapsedS: after.survivalS !== null && before.survivalS !== null ? after.survivalS - before.survivalS : 0,
        ...after.pedestrianCost !== before.pedestrianCost ? { pedestrianCost: after.pedestrianCost - before.pedestrianCost } : {},
        ...after.pedestrianDanger !== before.pedestrianDanger ? { pedestrianDanger: after.pedestrianDanger - before.pedestrianDanger } : {},
        ...after.pedestrianCleared > before.pedestrianCleared ? { pedestrianCleared: 1 } : {}
      };
      const values = Object.values(deltas);
      if (values.some((value) => value < 0) || values.every((value) => value === 0)) return;
      const { distanceM, policeContacts, pedestrianCollisions, collisions, nearCollisions, elapsedS } = deltas;
      const contactCost = policeContacts * PACK_PENALTIES.police + (deltas.pedestrianCost ?? pedestrianCollisions * PACK_PENALTIES.pedestrian);
      const otherContacts = Math.max(0, collisions - policeContacts - pedestrianCollisions);
      const cause = pedestrianCollisions ? "pedestrian-impact" : policeContacts ? "police-contact" : collisions ? "contact" : terminal ?? (deltas.pedestrianDanger ? "pedestrian-danger" : nearCollisions ? "near-contact" : distanceM > 0.05 ? "progress" : "held");
      const reward = contactCost ? -contactCost - otherContacts * 8 : 0.55 * Math.min(distanceM, 3) - 0.45 * elapsedS - otherContacts * 8 - nearCollisions * 1.4 + (deltas.pedestrianCleared ?? 0) * 2 - (deltas.pedestrianDanger ?? 0) * 6 + (terminal === "escaped" ? 14 : terminal === "captured" ? -12 : terminal === "timeout" ? -4 : 0);
      const qBefore = q[key3]?.[index] ?? 0;
      let qAfter = qBefore;
      if (training) {
        const future = next?.safe.length ? Math.max(...next.safe.map((i) => q[next.key]?.[i] ?? 0)) : 0;
        if (!q[key3]) {
          q[key3] = PACK_ACTIONS.map(() => 0);
          states++;
        }
        qAfter = clamp(qBefore + 0.3 * (reward + 0.88 * future - qBefore), -MAX_Q, MAX_Q);
        q[key3][index] = qAfter;
        updates = Math.min(Number.MAX_SAFE_INTEGER, updates + 1);
      }
      if (training && source === "exploration") explored++;
      if (lookup) lookups++;
      if (lookup && changed) changedDecisions++;
      lastTransition = Object.freeze({
        key: key3,
        action: PACK_ACTIONS[index],
        index,
        next: next?.key ?? null,
        reward,
        deltas: Object.freeze(deltas),
        cause,
        terminal,
        forcedHold,
        source,
        guard: after.guard,
        qBefore,
        qAfter
      });
    }
    return {
      weights,
      choose(_key, safe, best) {
        if (!training || safe.length < 2 || rng.next() >= 0.14) return best;
        const alternatives = safe.filter((index) => index !== best);
        return alternatives.length ? rng.pick(alternatives) : best;
      },
      record(decision2, metrics) {
        const after = measured(metrics);
        const next = executed(decision2, after);
        settle(after, next, null);
        prior = next;
      },
      finish(metrics, phase) {
        settle(measured(metrics), null, typeof phase === "string" ? phase.slice(0, 32) : null);
        prior = null;
      },
      interrupt() {
        prior = null;
      },
      snapshot() {
        return {
          updates,
          states,
          explored,
          lookups,
          changedDecisions,
          lastTransition,
          lastReward: lastTransition?.reward ?? null,
          lastCause: lastTransition?.cause ?? null
        };
      },
      checkpoint() {
        return {
          schemaVersion: SCHEMA,
          algorithm: ALGORITHM,
          actions: [...PACK_ACTIONS],
          updates,
          q: Object.fromEntries(Object.entries(q).map(([key3, row]) => [key3, [...row]]))
        };
      }
    };
  }

  // src/core/dispatch-junctions.js
  function isOnRoad(body, road4, pad = 0) {
    const across = road4.axis === "x" ? body.z : body.x;
    return Math.abs(across - road4.fixed) <= road4.width / 2 + pad && body[road4.axis] >= road4.min - pad && body[road4.axis] <= road4.max + pad;
  }
  function selectDispatchJunction(roads, patrol2, report) {
    if (!report || Math.abs(report.speed) < 3) return null;
    const effective = report.speed < 0 ? report.heading + Math.PI : report.heading;
    const incoming = roads.filter((road5) => !road5.supportApron && !road5.parkingBay && isOnRoad(report, road5)).map((road5) => ({ road: road5, align: road5.axis === "x" ? Math.sin(effective) : Math.cos(effective) })).sort((a, b) => Math.abs(b.align) - Math.abs(a.align))[0];
    if (!incoming || Math.abs(incoming.align) < 0.86) return null;
    const { road: road4 } = incoming, direction3 = Math.sign(incoming.align), choices = [];
    for (const crossing3 of roads) {
      if (crossing3.axis === road4.axis || crossing3.supportApron || crossing3.parkingBay || crossing3.width < 5 || road4.fixed < crossing3.min || road4.fixed > crossing3.max || crossing3.fixed < road4.min || crossing3.fixed > road4.max || !isOnRoad(patrol2, crossing3, 0.42)) continue;
      const gap = (crossing3.fixed - report[road4.axis]) * direction3;
      const crossGap = road4.fixed - patrol2[crossing3.axis], crossSign = Math.sign(crossGap);
      if (gap < 7 || gap > 70 || Math.abs(crossGap) < 4 || Math.abs(crossGap) > 42 || crossing3.flow && crossing3.flow !== crossSign) continue;
      const heading2 = districtRoadPose(crossing3, patrol2[crossing3.axis], crossSign).heading;
      if (Math.abs(angleDelta(heading2, patrol2.heading)) > 0.42) continue;
      const evidence = Math.abs(report.speed), egoEta = gap / evidence;
      const intercept = patrol2.squadRole === "INTERCEPTOR";
      const entryEta = Math.abs(crossGap) / Math.max(5, Math.min(12, Math.abs(patrol2.speed) + 4)) + (intercept ? 2 : 0);
      if (entryEta > egoEta + (intercept ? 0 : 1.4)) continue;
      if (intercept && road4.flow && road4.flow !== direction3) continue;
      const along2 = intercept ? crossing3.fixed + 12 * direction3 : road4.fixed - crossSign * 2.7;
      const targetRoad = intercept ? road4 : crossing3;
      const targetSign = intercept ? direction3 : crossSign;
      if (along2 < targetRoad.min + patrol2.length / 2 || along2 > targetRoad.max - patrol2.length / 2) continue;
      const goal = { ...districtRoadPose(targetRoad, along2, targetSign), roadId: targetRoad.id };
      const junction = road4.axis === "x" ? { x: crossing3.fixed, z: road4.fixed } : { x: road4.fixed, z: crossing3.fixed };
      choices.push({
        id: `${crossing3.id}:${targetSign}:${road4.id}`,
        junction,
        goal,
        entryEta,
        egoEta,
        approach: road4,
        direction: direction3,
        role: intercept ? "BLOCK_INTERCEPT" : "FLANK",
        score: Math.abs(egoEta - entryEta) + gap * 0.015
      });
    }
    choices.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
    return choices[0] ?? null;
  }
  function dispatchJunctionStillRelevant(route, report) {
    const { approach: road4, direction: direction3, junction } = route;
    const effective = report.speed < 0 ? report.heading + Math.PI : report.heading;
    const heading2 = districtRoadPose(road4, report[road4.axis], direction3).heading;
    return isOnRoad(report, road4, 2) && Math.abs(angleDelta(heading2, effective)) < 0.72 && (report[road4.axis] - junction[road4.axis]) * direction3 < 12;
  }
  function dispatchRoadblockDetour(map, ego, road4, direction3, site, blockers) {
    const progress = (along2) => (along2 - ego[road4.axis]) * direction3;
    const before = progress(site) - 8;
    const branches = map.drivingRoads.filter((branch) => branch.axis !== road4.axis && !branch.supportApron && !branch.parkingBay && branch.fixed >= road4.min && branch.fixed <= road4.max && road4.fixed >= branch.min && road4.fixed <= branch.max && progress(branch.fixed) >= 10 && progress(branch.fixed) <= before);
    for (const branch of branches) for (const sign of branch.flow ? [branch.flow] : [1, -1]) {
      const along2 = road4.fixed + sign * 24;
      if (along2 <= branch.min + 3 || along2 >= branch.max - 3) continue;
      const goal = { ...districtRoadPose(branch, along2, sign), roadId: branch.id };
      const path = planDistrictRoute(map, ego, goal);
      if (path.length < 3 || path.some((point2) => progress(point2[road4.axis]) > before + 3)) continue;
      let prior = ego;
      const axle = (ego.spec?.wheelbase ?? 2.6) / 2;
      let clear = true;
      for (let i = 1; i < path.length; i++) {
        const heading2 = Math.atan2(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
        const pose5 = {
          ...ego,
          heading: heading2,
          x: path[i].x + axle * Math.sin(heading2),
          z: path[i].z + axle * Math.cos(heading2)
        };
        if (!sweepSafe(prior, pose5, blockers).safe) {
          clear = false;
          break;
        }
        prior = pose5;
      }
      if (clear) return goal;
    }
    return null;
  }

  // src/core/pursuit-response.js
  var CONTACT_RANGE_M = 52;
  var ARCADE_CONTACT_RANGE_M = 60;
  var FORWARD_CONE_COS = Math.cos(100 * Math.PI / 180);
  var CLOSE_RANGE_M = 7.2;
  var GTA_RANGE_M = 65;
  var GTA_PROXIMITY_M = 14;
  var GTA_CLOSE_M = 7.5;
  var GTA_FORWARD_COS = Math.cos(55 * Math.PI / 180);
  var SEPARATION_M = 24;
  var SEARCH_TICKS2 = Math.round(2.5 / STEP);
  var CLEAR_TICKS = Math.round(4.5 / STEP);
  var STAR_TICKS = Math.round(2.4 / STEP);
  var visibilityGeometry = /* @__PURE__ */ new WeakMap();
  function staticGeometry(world) {
    const { staticIndex } = world;
    let geometry = visibilityGeometry.get(staticIndex);
    if (geometry) return geometry;
    const boxes = /* @__PURE__ */ new Map();
    let reach = 0;
    for (const body of world.statics) {
      const w = body.width / 2, l = body.length / 2;
      if (!(w > 0 && l > 0)) continue;
      reach = Math.max(reach, Math.hypot(w, l));
      boxes.set(body, { w, l, sin: Math.sin(body.heading ?? 0), cos: Math.cos(body.heading ?? 0) });
    }
    geometry = { boxes, reach };
    visibilityGeometry.set(staticIndex, geometry);
    return geometry;
  }
  function intersects(x, z, dx, dz, body, { w, l, sin, cos }) {
    const bx = x - body.x, bz = z - body.z;
    const across = bx * cos - bz * sin, along2 = bx * sin + bz * cos;
    const da = dx * cos - dz * sin, dl = dx * sin + dz * cos;
    let enter = 0, leave = 1;
    if (Math.abs(da) < 1e-8) {
      if (Math.abs(across) > w) return false;
    } else {
      const near2 = (-w - across) / da, far2 = (w - across) / da;
      enter = Math.max(enter, Math.min(near2, far2));
      leave = Math.min(leave, Math.max(near2, far2));
      if (enter > leave) return false;
    }
    if (Math.abs(dl) < 1e-8) return Math.abs(along2) <= l;
    const near = (-l - along2) / dl, far = (l - along2) / dl;
    return Math.max(enter, Math.min(near, far)) <= Math.min(leave, Math.max(near, far));
  }
  function unobstructed(world, from, dx, dz, range) {
    const { boxes, reach } = staticGeometry(world);
    const midpoint = { x: from.x + dx / 2, z: from.z + dz / 2 };
    return !world.staticIndex.near(midpoint, range / 2 + reach).some((body) => {
      const box3 = boxes.get(body);
      return box3 && intersects(from.x, from.z, dx, dz, body, box3);
    });
  }
  var gtaLineClear = unobstructed;
  function gtaDeploymentHidden(world, from, body) {
    const radius = Math.hypot(body.width, body.length) / 2;
    const range = distance(from, body);
    if (range - radius > 55) return true;
    const { boxes, reach } = staticGeometry(world);
    const midpoint = { x: (from.x + body.x) / 2, z: (from.z + body.z) / 2 };
    const footprint = corners(body);
    const height = Math.max(from.height ?? 1.8, body.height ?? 0);
    return world.staticIndex.near(midpoint, range / 2 + reach + radius).some((cover) => {
      const box3 = boxes.get(cover);
      return box3 && cover.height >= height && footprint.every((point2) => intersects(from.x, from.z, point2.x - from.x, point2.z - from.z, cover, box3));
    });
  }
  function createPursuitResponse() {
    return {
      stage: "search",
      pressure: 0,
      clearProgress: 0,
      unitsInContact: 0,
      lastSeen: null,
      sightedBy: /* @__PURE__ */ new Set(),
      closePatrols: /* @__PURE__ */ new Set(),
      lostAtTick: null,
      clearAtTick: null
    };
  }
  function updatePursuitResponse(world, initial = false) {
    const { player, pursuit, tick } = world;
    const r = pursuit.response;
    const gta = pursuit.variant === "gta";
    const hunt = isCityHunt(pursuit.variant) && pursuit.street;
    const arcade = pursuit.variant === "arcade" || pursuit.variant === "pack" || isCityHunt(pursuit.variant);
    const contactRange = gta ? GTA_RANGE_M : arcade ? ARCADE_CONTACT_RANGE_M : CONTACT_RANGE_M;
    const before = r.stage;
    r.sightedBy.clear();
    r.closePatrols.clear();
    let nearest2 = contactRange;
    for (const unit2 of pursuit.patrols) {
      if (gta && (unit2.aiState === "WRECKED" || r.dispatch && unit2.health <= 0)) continue;
      const dx = player.x - unit2.x, dz = player.z - unit2.z;
      const range = Math.hypot(dx, dz);
      if (range > contactRange) continue;
      const close = range < (gta ? GTA_CLOSE_M : CLOSE_RANGE_M);
      const ahead = dx * Math.sin(unit2.heading) + dz * Math.cos(unit2.heading);
      const outsideCone = gta ? range > GTA_PROXIMITY_M && ahead < range * GTA_FORWARD_COS : !arcade && !close && ahead < range * FORWARD_CONE_COS;
      if (outsideCone || !unobstructed(world, unit2, dx, dz, range)) continue;
      if (close) r.closePatrols.add(unit2);
      r.sightedBy.add(unit2);
      nearest2 = Math.min(range, nearest2);
    }
    r.unitsInContact = r.sightedBy.size;
    const desired = r.unitsInContact ? clamp(
      0.12 + 0.64 * (1 - nearest2 / contactRange) + 0.09 * (r.unitsInContact - 1),
      0,
      1
    ) : 0;
    r.pressure = initial ? desired : r.pressure + clamp(desired - r.pressure, -0.28 * STEP, 0.37 * STEP);
    if (r.dispatch) return updateDispatchTracking(world, initial);
    if (r.unitsInContact) {
      r.lastSeen = Object.freeze({ x: player.x, z: player.z, heading: player.heading, speed: player.speed, tick });
      r.stage = "contact";
      r.lostAtTick = r.clearAtTick = null;
      if (hunt) r.clearInitialStars = 0;
      r.clearProgress = 0;
      return !initial && before !== "contact" ? "reacquired" : null;
    }
    r.lostAtTick ??= tick;
    if (gta) return before === "contact" ? "contact-lost" : null;
    if (hunt) {
      const report = r.lastSeen ?? pursuit.playerStart;
      const separated3 = pursuit.metrics.distanceM >= 14 && distance(player, report) >= 18 && [...pursuit.patrols].every((unit2) => distance(player, unit2) >= 17);
      if (separated3 && tick - r.lostAtTick >= SEARCH_TICKS2) {
        if (r.clearAtTick === null) {
          r.clearAtTick = tick;
          r.clearInitialStars = pursuit.wantedLevel;
        }
        const faded = Math.floor((tick - r.clearAtTick) / STAR_TICKS);
        pursuit.wantedLevel = Math.max(0, r.clearInitialStars - faded);
        r.clearProgress = clamp((tick - r.clearAtTick) / (STAR_TICKS * Math.max(1, r.clearInitialStars)), 0, 1);
        r.stage = "clearing";
        return before !== "clearing" ? "clearing" : null;
      }
      r.stage = "search";
      r.clearAtTick = null;
      r.clearProgress = 0;
      return before === "contact" ? "contact-lost" : null;
    }
    const separated2 = pursuit.metrics.distanceM >= SEPARATION_M && distance(player, pursuit.playerStart) >= SEPARATION_M;
    if (tick - r.lostAtTick >= SEARCH_TICKS2 && separated2) {
      r.stage = "clearing";
      r.clearAtTick ??= tick;
      r.clearProgress = clamp((tick - r.clearAtTick) / CLEAR_TICKS, 0, 1);
      return before !== "clearing" ? "clearing" : null;
    }
    r.stage = "search";
    r.clearAtTick = null;
    r.clearProgress = 0;
    return before === "contact" ? "contact-lost" : null;
  }
  function pursuitResponseSnapshot({ stage, pressure, clearProgress, unitsInContact, dispatch }) {
    return {
      stage,
      pressure,
      clearProgress,
      unitsInContact,
      ...dispatch ? { dispatch: {
        state: dispatch.state,
        zoneIds: [...dispatch.zoneIds],
        lastReportTick: dispatch.lastReportTick
      } } : {}
    };
  }

  // src/signal_processing/pursuit-scanner.js
  var PURSUIT_SCAN_RAYS = 72;
  var PURSUIT_SCAN_RANGE_M = 48;
  var PURSUIT_SCAN_TICKS = 6;
  var PURSUIT_TRACK_TTL_S = 0.5;
  var RAY_STEP = 2 * Math.PI / PURSUIT_SCAN_RAYS;
  var PED_RAYS_PER_PRIMARY = 10;
  var PED_RAYS = PURSUIT_SCAN_RAYS * PED_RAYS_PER_PRIMARY;
  var PED_RAY_STEP = RAY_STEP / PED_RAYS_PER_PRIMARY;
  var TRACK_TTL_TICKS = Math.round(PURSUIT_TRACK_TTL_S / STEP);
  var MAX_TTC_S = 6;
  var EPS2 = 1e-9;
  var zeroSmall = (n) => Math.abs(n) < EPS2 ? 0 : n;
  var direction2 = (angle) => ({
    right: zeroSmall(Math.sin(angle)),
    forward: zeroSmall(Math.cos(angle))
  });
  var beams = Array.from({ length: PURSUIT_SCAN_RAYS }, (_, i) => direction2(i * RAY_STEP));
  var pedBeams = Array.from({ length: PED_RAYS }, (_, i) => i % PED_RAYS_PER_PRIMARY ? direction2(i * PED_RAY_STEP) : beams[i / PED_RAYS_PER_PRIMARY]);
  var priority = { none: 0, civilian: 1, pedestrian: 2, police: 3, static: 4 };
  function candidates(world, heading2) {
    const { player } = world, c = Math.cos(heading2), s = Math.sin(heading2);
    const shapes = [];
    function add(body, kind) {
      if (body === player) return;
      const dx = body.x - player.x, dz = body.z - player.z;
      const right = dx * c - dz * s, forward2 = dx * s + dz * c;
      const circle = kind === "pedestrian";
      const w = body.width / 2, l = body.length / 2;
      if (!circle && !(w > 0 && l > 0)) return;
      const radius = circle ? body.radius : Math.hypot(w, l);
      if (!Number.isFinite(radius) || !(radius > 0) || !(Math.hypot(dx, dz) <= PURSUIT_SCAN_RANGE_M + radius + EPS2)) return;
      if (circle) {
        shapes.push({ kind, radius, right, forward: forward2 });
      } else {
        const angle = (body.heading ?? 0) - heading2;
        if (!Number.isFinite(angle)) return;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        shapes.push({
          kind,
          w,
          l,
          cos,
          sin,
          x: -right * cos + forward2 * sin,
          z: -right * sin - forward2 * cos
        });
      }
    }
    for (const body of world.statics) add(body, "static");
    for (const body of world.actors) {
      if (body.type === "pedestrian" || body.type === "static") add(body, body.type);
      else if (body.type === "vehicle")
        add(body, body.pursuitRole === "police" ? "police" : "civilian");
    }
    return shapes;
  }
  function circleHit({ right, forward: forward2, radius }, r, f) {
    const cross2 = right * f - forward2 * r;
    if (Math.abs(cross2) > radius + EPS2) return Infinity;
    const projection2 = right * r + forward2 * f;
    const chord = Math.sqrt(Math.max(0, radius * radius - cross2 * cross2));
    return projection2 + chord < 0 ? Infinity : Math.max(0, projection2 - chord);
  }
  function boxHit({ x, z, w, l, cos, sin }, r, f, far) {
    const dx = r * cos - f * sin, dz = r * sin + f * cos;
    let near = 0;
    if (Math.abs(dx) < EPS2) {
      if (Math.abs(x) > w + EPS2) return Infinity;
    } else {
      const a = (-w - x) / dx, b = (w - x) / dx;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
      if (near > far + EPS2) return Infinity;
    }
    if (Math.abs(dz) < EPS2) {
      if (Math.abs(z) > l + EPS2) return Infinity;
    } else {
      const a = (-l - z) / dz, b = (l - z) / dz;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    return near <= far + EPS2 ? near : Infinity;
  }
  function firstReturn(shapes, { right, forward: forward2 }) {
    let rangeM = PURSUIT_SCAN_RANGE_M, kind = "none";
    for (const body of shapes) {
      const hit = body.kind === "pedestrian" ? circleHit(body, right, forward2) : boxHit(body, right, forward2, rangeM);
      if (hit > PURSUIT_SCAN_RANGE_M + EPS2) continue;
      const measured2 = Math.min(hit, PURSUIT_SCAN_RANGE_M);
      if (measured2 < rangeM || measured2 === rangeM && priority[body.kind] > priority[kind]) {
        rangeM = measured2;
        kind = body.kind;
      }
    }
    return { rangeM, kind };
  }
  function pedestrianReturns(shapes, rays) {
    let samples;
    for (const body of shapes) {
      if (body.kind !== "pedestrian") continue;
      samples ??= new Array(PED_RAYS);
      const coverage = (body.radius + EPS2) / Math.hypot(body.right, body.forward);
      const bearing = Math.atan2(body.right, body.forward);
      const half = Math.asin(Math.min(1, coverage));
      const first = coverage >= 1 ? 0 : Math.ceil((bearing - half) / PED_RAY_STEP - EPS2);
      const last = coverage >= 1 ? PED_RAYS - 1 : Math.floor((bearing + half) / PED_RAY_STEP + EPS2);
      for (let bin = first; bin <= last; bin++) {
        const i = (bin + PED_RAYS) % PED_RAYS;
        if (samples[i] !== void 0) continue;
        const hit = i % PED_RAYS_PER_PRIMARY ? firstReturn(shapes, pedBeams[i]) : rays[i / PED_RAYS_PER_PRIMARY];
        samples[i] = hit.kind === "pedestrian" ? hit : null;
      }
    }
    return samples ?? [];
  }
  function surfaces(rays, directions, pedestrians, tick, heading2) {
    const relevant = (ray) => ray && ray.kind !== "none" && ray.kind === "pedestrian" === pedestrians;
    const connected = (a, b) => relevant(a) && a.kind === b?.kind && Math.abs(a.rangeM - b.rangeM) <= 2;
    const anchors = [];
    for (let i = 0; i < rays.length; i++) {
      if (!relevant(rays[i])) continue;
      const last = anchors.length - 1;
      if (i === 0 || !connected(rays[i - 1], rays[i])) anchors.push(i);
      else if (rays[i].rangeM < rays[anchors[last]].rangeM) anchors[last] = i;
    }
    if (anchors.length > 1 && connected(rays.at(-1), rays[0])) {
      const end = anchors.pop();
      if (rays[end].rangeM < rays[anchors[0]].rangeM) anchors[0] = end;
    }
    return anchors.map((i) => {
      const { kind, rangeM } = rays[i], { right, forward: forward2 } = directions[i];
      return { kind, rangeM, rightM: rangeM * right, forwardM: rangeM * forward2, tick, heading: heading2 };
    });
  }
  var options = (n) => Array.from({ length: n }, () => ({
    index: -1,
    distance: Infinity,
    second: Infinity
  }));
  function offer(best, index, distance2) {
    if (distance2 < best.distance) {
      best.second = best.distance;
      best.distance = distance2;
      best.index = index;
    } else if (distance2 < best.second) best.second = distance2;
  }
  function correspond(current, previous, heading2) {
    const from = options(current.length), to = options(previous.length);
    const aligned = previous.map((point2) => {
      const angle = heading2 - point2.heading, c = Math.cos(angle), s = Math.sin(angle);
      return {
        rightM: point2.rightM * c - point2.forwardM * s,
        forwardM: point2.rightM * s + point2.forwardM * c
      };
    });
    for (const [i, point2] of current.entries()) {
      for (const [j, old] of previous.entries()) {
        if (point2.kind !== old.kind) continue;
        const d = Math.hypot(point2.rightM - aligned[j].rightM, point2.forwardM - aligned[j].forwardM);
        const spacing = point2.kind === "pedestrian" ? PED_RAY_STEP : RAY_STEP;
        if (d > 75 * STEP * PURSUIT_SCAN_TICKS + point2.rangeM * spacing) continue;
        offer(from[i], j, d);
        offer(to[j], i, d);
      }
    }
    return from.map(({ index, distance: distance2, second }, i) => {
      if (index < 0 || to[index].index !== i || second - distance2 < 0.5 || to[index].second - distance2 < 0.5) return null;
      return { index, ...aligned[index] };
    });
  }
  function track(point2, tick, match, previous) {
    const { kind, rightM, forwardM, rangeM } = point2;
    const motionKnown = match !== null && tick === point2.tick && point2.tick - previous[match.index].tick === PURSUIT_SCAN_TICKS;
    let rightMps = 0, forwardMps = 0, ttcS = null;
    if (motionKnown) {
      const elapsed = PURSUIT_SCAN_TICKS * STEP;
      rightMps = (rightM - match.rightM) / elapsed;
      forwardMps = (forwardM - match.forwardM) / elapsed;
      const closing = rangeM > 0 ? -(rightM * rightMps + forwardM * forwardMps) / rangeM : 0;
      if (closing > EPS2) ttcS = Math.min(MAX_TTC_S, rangeM / closing);
    }
    return Object.freeze({
      kind,
      rightM,
      forwardM,
      rightMps,
      forwardMps,
      ageS: (tick - point2.tick) * STEP,
      motionKnown,
      ttcS
    });
  }
  var PursuitScanner = class {
    #world;
    #frame;
    #history = [];
    sample(world) {
      const { tick, player } = world;
      if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError("Invalid pursuit sample tick");
      if (world !== this.#world || tick < this.#frame?.tick) {
        this.#world = world;
        this.#frame = void 0;
        this.#history = [];
      }
      if (this.#frame && tick - this.#frame.tick < PURSUIT_SCAN_TICKS) return this.#frame;
      const heading2 = player.heading ?? 0;
      if (![player.x, player.z, heading2].every(Number.isFinite))
        throw new RangeError("Invalid pursuit sample pose");
      const shapes = candidates(world, heading2);
      const rays = Object.freeze(beams.map((beam) => Object.freeze(firstReturn(shapes, beam))));
      const current = surfaces(rays, beams, false, tick, heading2).concat(surfaces(pedestrianReturns(shapes, rays), pedBeams, true, tick, heading2)).sort((a, b) => a.rangeM - b.rangeM);
      const previous = this.#history.filter((point2) => tick - point2.tick < TRACK_TTL_TICKS);
      const matches = correspond(current, previous, heading2);
      const matched = new Set(matches.flatMap((match) => match ? [match.index] : []));
      const stale = previous.filter((_, i) => !matched.has(i)).sort((a, b) => b.tick - a.tick || a.rangeM - b.rangeM);
      const tracks = current.map((point2, i) => track(point2, tick, matches[i], previous));
      for (const point2 of stale) tracks.push(track(point2, tick, null, previous));
      this.#history = current.concat(stale);
      this.#frame = Object.freeze({ tick, rays, tracks: Object.freeze(tracks) });
      return this.#frame;
    }
  };

  // src/core/pursuit-world.js
  var TIERS = [
    { police: 1, traffic: 3, pedestrians: 1, durationS: 38 },
    { police: 4, traffic: 5, pedestrians: 2, durationS: 41 },
    { police: 5, traffic: 7, pedestrians: 3, durationS: 44 },
    { police: 6, traffic: 9, pedestrians: 4, durationS: 47 }
  ];
  var CASE_IDS = /* @__PURE__ */ new Set([
    "ambient",
    "short-route-open",
    "short-route-closes-or-becomes-risky",
    "rear-close-forward-clear",
    "rear-close-front-blocked-side-clear",
    "reverse-then-side",
    "incoming-left-or-right",
    "front-obstruction-with-rear-traffic",
    "pedestrian-priority-no-safe-exit",
    "legal-gap-and-rejected-cut",
    "curb-bypass-and-return",
    "boxed-in-multi-threat",
    "occluded-stale-and-recovery"
  ]);
  var CAR_KINDS = ["sedan", "taxi", "suv", "van", "tuktuk"];
  var MAX_EVENTS = 48;
  var STREET_DEPLOY_RANGE_M = 52;
  var RUSH_TACTICS = ["tail", "flank", "intercept", "tail", "flank", "intercept", "tail", "flank", "tail", "intercept"];
  var RUSH_WAVES = [[4, 6], [5, 7], [6, 9], [7, 10]];
  var ARCADE_WAVES = [[5, 14], [7, 18], [9, 22], [11, 26]];
  var headingTo3 = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
  var ticks2 = (seconds2) => Math.round(seconds2 / STEP);
  var ARCADE_BACKUP_TICKS = ticks2(3);
  var PACK_REVIEW_TICKS = ticks2(1.65);
  var road3 = (axis, fixed, min, max, width) => ({ axis, fixed, min, max, width });
  var pose3 = (x, z, heading2 = 0, speed = 0) => ({ x, z, heading: heading2, speed });
  var exit = (id, x, z) => ({ id, x, z });
  var barrier = (id, x, z, width, length = 0.8, heading2 = 0, height = 0.95) => ({ id, type: "static", kind: "barrier", x, z, heading: heading2, width, length, height });
  var vehicle = (id, position2, behaviour, cruise) => ({ id, position: position2, behaviour, cruise });
  function grid() {
    return [
      road3("z", 0, -56, 60, 12),
      road3("z", -22, -32, 42, 10),
      road3("z", 22, -32, 42, 10),
      ...[-32, -8, 22, 42].map((z) => road3("x", z, -22, 22, z === -8 ? 12 : 10))
    ];
  }
  function streetSolids(rng) {
    const sites2 = [];
    for (const side of [-1, 1]) {
      const name = side < 0 ? "west" : "east";
      const place2 = (id, kind, x, z, width, length, height, heading2 = 0) => sites2.push({ id: `pursuit-${name}-${id}`, type: "static", kind, x: side * x, z, width, length, height, heading: heading2 });
      for (const [id, z, depth, minHeight, maxHeight] of [
        ["entry", -43.5, 8.6, 3.6, 5.2],
        ["south", -20.6, 7.8, 4.5, 7.2],
        ["centre", 7.3, 10.1, 5.2, 8.4],
        ["north", 32, 5.4, 3.2, 5.8]
      ]) {
        place2(
          `building-${id}`,
          "building",
          11.85 + rng.range(-0.2, 0.3),
          z + rng.range(-0.4, 0.4),
          rng.range(5.7, 6.5),
          depth,
          rng.range(minHeight, maxHeight)
        );
      }
      place2(
        "building-edge",
        "building",
        34.8,
        side < 0 ? -9 : 19.5,
        rng.range(7.7, 8.5),
        10.5,
        rng.range(4.5, 7)
      );
      place2("entry-wall", "wall", 7.9, -42, 0.48, 4.8, 1.1);
      place2("edge-wall", "wall", 30.1, side < 0 ? 8.8 : -8.8, 0.52, 8, 1.25);
      place2(
        "entry-parked",
        "parked-vehicle",
        8.45,
        -51.8,
        1.78,
        4.18,
        1.43,
        side < 0 ? 0 : Math.PI
      );
      sites2.at(-1).vehicleKind = side < 0 ? "taxi" : "sedan";
      place2("edge-parked", "parked-vehicle", 29.5, -22.4, 1.88, 4.48, 1.85, Math.PI);
      sites2.at(-1).vehicleKind = "van";
    }
    return sites2;
  }
  function layout(caseId, rng) {
    const sign = rng.next() < 0.5 ? -1 : 1;
    const drivingRoads = grid();
    const statics = [];
    const shoulders = [];
    const cars = [], people = [];
    const scene = {
      drivingRoads,
      shoulders,
      statics,
      cars,
      people,
      playerStart: pose3(-LANE_OFFSET, -39),
      exits: [exit("north", -LANE_OFFSET, 54)],
      closure: null
    };
    const setPlayer = (x, z, speed = 0) => {
      scene.playerStart = pose3(x, z, 0, speed);
    };
    const tail = (x, z, speed) => cars.push(vehicle("police-tail-1", pose3(x, z, 0, speed), "tail", 9.5));
    const cross2 = (x, z, speed, tactic = "flank", cruise = 8.6) => cars.push(vehicle(`police-${tactic}-1`, pose3(x, z, -Math.sign(x) * Math.PI / 2, speed), tactic, cruise));
    const stop = (id, x, z) => cars.push(vehicle(id, pose3(x, z), "parked", 0));
    switch (caseId) {
      case "ambient":
        scene.playerStart.z += rng.range(-1.3, 1.3);
        scene.exits.push(exit("west", -22 - LANE_OFFSET, 36), exit("east", 22 - LANE_OFFSET, 36));
        break;
      case "short-route-open":
      case "short-route-closes-or-becomes-risky":
        setPlayer(-LANE_OFFSET, -36);
        cars.push(vehicle("civilian-bypass", pose3(sign * 22 - LANE_OFFSET, -18, 0, 3.2), "lane", 4.5));
        if (caseId === "short-route-closes-or-becomes-risky") {
          scene.closure = {
            at: ticks2(rng.range(2.1, 2.8)),
            body: barrier("pursuit-short-closure", 0, 8 + rng.range(-0.4, 0.4), 12.1)
          };
        }
        break;
      case "rear-close-forward-clear":
        setPlayer(sign * LANE_OFFSET, -27, 3.4);
        tail(sign * LANE_OFFSET, -35.6, 6.4);
        break;
      case "rear-close-front-blocked-side-clear":
        setPlayer(sign * 1.65, -18.5, 1.4);
        tail(sign * 1.65, -32, 6.1);
        stop("civilian-front", sign * 1.65, -9.2);
        statics.push(barrier("pursuit-side-block", sign * 4.5, -12.7, 2.7, 5.5));
        break;
      case "reverse-then-side":
        scene.drivingRoads = [
          road3("z", 0, -20, 12, 5.4),
          road3("x", -9, -33, 33, 9.4),
          road3("z", sign * 33, -9, 14, 8)
        ];
        setPlayer(0, -0.5);
        statics.push(barrier("pursuit-bay-end", 0, 2.45, 5.6));
        cross2(-sign * 31, -9, 2, "flank", 4.3);
        scene.exits = [exit("side", sign * 30, -9)];
        break;
      case "incoming-left-or-right":
        setPlayer(0, -8.5, 1);
        cross2(sign * 15, -8.5, 6.4);
        break;
      case "front-obstruction-with-rear-traffic":
        setPlayer(sign * 1.65, -18.5, 3);
        cars.push(
          vehicle("civilian-oncoming", pose3(sign * 1.65, -1.6, Math.PI, 5.3), "lane", 6),
          vehicle("civilian-behind", pose3(sign * 1.65, -28.3, 0, 5.5), "lane", 6.8)
        );
        break;
      case "pedestrian-priority-no-safe-exit":
        scene.drivingRoads = [road3("z", 0, -24, 24, 4.6)];
        setPlayer(0, -4.5);
        tail(0, -13.6, 5.4);
        people.push({ id: "walker-crossing", road: 0, along: -0.35, side: sign, pause: 0, started: true });
        scene.exits = [exit("ahead", 0, 18)];
        break;
      case "legal-gap-and-rejected-cut":
        setPlayer(sign * 1.65, -29, 4.3);
        cars.push(
          vehicle("civilian-lead", pose3(sign * 1.65, -19.3, 0, 2.1), "lane", 3.5),
          vehicle("civilian-gap-ahead", pose3(-sign * 1.65, -11.2, 0, 5.5), "lane", 5.5),
          vehicle("civilian-gap-behind", pose3(-sign * 1.65, -34.2, 0, 4.8), "lane", 6.5)
        );
        break;
      case "curb-bypass-and-return":
        scene.drivingRoads = [road3("z", 0, -29, 34, 7.5)];
        shoulders.push({
          ...road3("z", sign * 5, -23.5, 15.5, 3.45),
          pursuitShoulder: true,
          supportHeightM: 0.14
        });
        setPlayer(sign * 1.3, -23);
        statics.push(barrier("pursuit-curb-closure", 0, 0, 7.15));
        scene.exits = [exit("re-entry", 0, 25)];
        break;
      case "boxed-in-multi-threat":
        setPlayer(0, -8.5, 0.8);
        tail(0, -21.5, 6.4);
        cross2(sign * 17.5, -8, 6.1);
        cross2(-sign * 19, -10.4, 5.8, "intercept");
        stop("civilian-box-front", 0, -0.8);
        people.push({ id: "walker-crossing", road: 0, along: 1.9, side: sign, pause: 0.3 });
        break;
      case "occluded-stale-and-recovery":
        setPlayer(0, -14.3, 1.4);
        statics.push(barrier("pursuit-opaque-screen", sign * 5.7, -12.9, 3.4, 1.7, 0, 2.3));
        cross2(sign * 16, -10, 4.6);
        break;
    }
    return scene;
  }
  function validateLevel(level) {
    if (!Number.isInteger(level) || level < 1 || level > TIERS.length)
      throw new RangeError("Pursuit level must be an integer from 1 to 4");
  }
  function pursuitMetrics() {
    return {
      survivalS: 0,
      distanceM: 0,
      collisions: 0,
      pedestrianCollisions: 0,
      nearCollisions: 0,
      escape: false,
      impact: null,
      trafficCollisions: 0,
      guard: "clear",
      requestedAction: null,
      supportHeightM: 0,
      maxSupportHeightM: 0,
      shoulderEntries: 0,
      shoulderExits: 0,
      capturePressureS: 0
    };
  }
  function initializePack(state, phase = "ready") {
    state.variant = "pack";
    state.response = createPursuitResponse();
    state.patrols ??= /* @__PURE__ */ new Set();
    state.wantedLevel = state.level;
    state.driver = "planner";
    state.phase = phase;
    Object.assign(state.metrics, {
      policeContacts: 0,
      penalty: 0,
      terminalCause: null,
      pedestrianStatus: null,
      firstYieldTick: null,
      firstClearTick: null,
      surroundSectors: 0
    });
    return state;
  }
  function createPursuitState(options2 = {}) {
    if (!options2 || typeof options2 !== "object" || Array.isArray(options2))
      throw new TypeError("Pursuit options must be an object");
    const pack = isPackPursuit(options2.pursuitVariant);
    const { pursuitLevel: level = 1, pursuitCase: caseId = pack ? "pack-dodge" : "ambient" } = options2;
    validateLevel(level);
    if (pack ? !PACK_DRILLS.some((drill) => drill.id === caseId) : !CASE_IDS.has(caseId))
      throw new RangeError("Unknown pursuit case");
    const seed = String(options2.seed ?? "cairo-42").slice(0, 64);
    const rng = new Random(`${seed}:pursuit-world-v1`);
    const scene = pack ? createPackDrill(caseId, seed) : layout(caseId, rng);
    if (caseId === "ambient") {
      scene.statics.push(...streetSolids(new Random(`${seed}:pursuit-streets-v1`)));
    }
    const state = {
      level,
      caseId,
      phase: "ready",
      drivingRoads: scene.drivingRoads,
      roads: [...scene.drivingRoads, ...scene.shoulders],
      statics: scene.statics,
      playerStart: scene.playerStart,
      exits: scene.exits,
      events: [],
      action: null,
      decision: null,
      startedTick: null,
      metrics: pursuitMetrics(),
      rng,
      scene,
      graph: createRoadGraph(scene.drivingRoads),
      support: scene.shoulders.map((r) => ({ ...roadRect(r), height: r.supportHeightM })),
      nextEventTick: ticks2(rng.range(2.4, 4.2)),
      eventKinds: [],
      eventSerial: 0,
      closures: /* @__PURE__ */ new Map(),
      contacts: /* @__PURE__ */ new Set(),
      near: /* @__PURE__ */ new Set(),
      navGraph: null,
      junctions: scene.drivingRoads.filter((r) => r.axis === "x").flatMap((a) => scene.drivingRoads.filter((r) => r.axis === "z" && r.fixed >= a.min && r.fixed <= a.max && a.fixed >= r.min && a.fixed <= r.max).map((r) => ({ x: r.fixed, z: a.fixed })))
    };
    if (!pack) return state;
    state.packLab = true;
    state.targetPatrols = scene.cars.filter((car) => RUSH_TACTICS.includes(car.behaviour)).length;
    initializePack(state);
    if (options2.pursuitVariant === "hunt") {
      state.variant = "hunt";
      Object.assign(state.metrics, { pedestrianCost: 0, pedestrianDanger: 0 });
    }
    if (!state.targetPatrols) state.wantedLevel = 0;
    return state;
  }
  function shuffled(rng, values) {
    const result = values.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  function isFree(world, shape2, gap = 0.24) {
    return !world.actors.some((a) => overlaps(a, shape2, gap)) && !world.statics.some((a) => overlaps(a, shape2, gap));
  }
  function setPursuitDrive(a, data, kind) {
    const police = ["tail", "flank", "intercept"].includes(data.behaviour);
    a.pursuitRole = police ? "police" : "civilian";
    if (police) a.policeTactic = data.behaviour;
    a.speed = Math.min(data.position.speed, a.maxSpeed);
    a.y = a.supportHeightM = 0;
    a.height ??= kind === "van" ? 2.05 : 1.5;
    a.pursuitDrive = {
      pattern: data.behaviour,
      cruise: Math.min(a.maxSpeed, data.cruise),
      paceMps: Infinity,
      paceUntil: 0,
      nextPlan: 0,
      target: null,
      laneBiasM: 0,
      laneUntil: 0,
      laneProbeAt: 0
    };
  }
  function addVehicle(world, data, kind = "sedan") {
    const a = world.makeVehicle(data.id, kind, data.position);
    if (!bodyOnRoad(a, world.drivingRoads) || !isFree(world, a)) return null;
    setPursuitDrive(a, data, kind);
    if (data.path) a.path = data.path;
    if (data.behaviour === "lane" && !data.path) {
      const p = a.pursuitDrive.target = { x: a.x, z: a.z };
      for (let n = 1; n <= 100; n++) {
        const next = {
          ...a,
          x: a.x + n * Math.sin(a.heading),
          z: a.z + n * Math.cos(a.heading)
        };
        if (!bodyOnRoad(next, world.drivingRoads)) break;
        p.x = next.x;
        p.z = next.z;
      }
    }
    a.previous = copyPose(a);
    world.actors.push(a);
    return a;
  }
  function sidewalkPose(r, along2, side) {
    const lateral2 = side * (r.width / 2 + 0.9);
    return r.axis === "z" ? { x: r.fixed - lateral2, z: along2 } : { x: along2, z: r.fixed + lateral2 };
  }
  function addPerson(world, data) {
    const { rng } = world.pursuit;
    const r = world.drivingRoads[data.road];
    const start = sidewalkPose(r, data.along, data.side);
    if (data.started) {
      if (r.axis === "z") start.x = r.fixed - data.side * (r.width / 2 - 0.4);
      else start.z = r.fixed + data.side * (r.width / 2 - 0.4);
    }
    const target = sidewalkPose(r, data.along, -data.side);
    const p = {
      id: data.id,
      type: "pedestrian",
      kind: rng.pick(PEOPLE_MODELS),
      ...start,
      heading: headingTo3(start, target),
      target,
      road: r,
      side: data.side,
      speed: 0,
      walkSpeed: rng.range(1.05, 2),
      phase: rng.next(),
      crossing: true,
      along: data.along,
      pause: data.pause,
      distance: 0,
      wait: 0,
      reason: "ready",
      motionMode: "ambient",
      motionTimeS: 0,
      accelerationMps2: 0
    };
    if (world.pursuit.packLab) {
      if (data.pose) Object.assign(p, data.pose);
      if (data.target) p.target = { ...data.target };
      if (Number.isFinite(data.walkSpeed)) p.walkSpeed = data.walkSpeed;
    }
    p.body = createPedestrianBody(p);
    p.radius = p.body.radiusM;
    p.height = p.body.heightM;
    if (!isFree(world, p)) return false;
    p.previous = copyPose(p);
    world.actors.push(p);
    return true;
  }
  function spawnPolice(world, count) {
    const { rng, level } = world.pursuit;
    const side = rng.next() < 0.5 ? -1 : 1;
    const start = world.player;
    const spread = level - 1;
    const innerFlankZ = level > 2 ? -8 : -32;
    const outerFlankZ = level > 2 ? 22 : -8;
    const positions = [
      ["tail", start.x + rng.range(-0.55, 0.55), start.z - rng.range(10.5 + spread * 1.95, 15.5 + spread * 0.88), 0],
      ["flank", side * rng.range(12 + spread * 1.8, 22), innerFlankZ + side * 0.9, -side * Math.PI / 2],
      ["intercept", rng.range(0.35, 2.5), rng.range(13 + spread * 2.6, 23 + spread * 3.4), Math.PI],
      ["flank", -side * rng.range(14 + spread * 1.2, 22), outerFlankZ - side * 1.3, side * Math.PI / 2],
      ["tail", -side * 22 + LANE_OFFSET, rng.range(-17, -6), Math.PI],
      ["intercept", side * 22 + LANE_OFFSET, rng.range(17, 30), Math.PI]
    ];
    const counts = { tail: 0, flank: 0, intercept: 0 };
    for (const [tactic, x, z, heading2] of positions.slice(0, count)) {
      const id = `police-${tactic}-${++counts[tactic]}`;
      const cruise = 6.9 + level * 0.6 + rng.range(-0.3, 0.5);
      let car = null;
      for (const offset2 of [0, -2.6, 2.6, -5.2, 5.2]) {
        const p = pose3(
          x + Math.sin(heading2) * offset2,
          z + Math.cos(heading2) * offset2,
          heading2,
          rng.range(2.7, 4.2) + level * 0.35
        );
        car = addVehicle(world, vehicle(id, p, tactic, cruise));
        if (car) break;
      }
      if (!car) throw new Error(`No clean pursuit spawn for ${id}`);
    }
  }
  var square = (a, b, low, high) => [{ x: a, z: low }, { x: a, z: high }, { x: b, z: high }, { x: b, z: low }];
  function spawnCivilians(world, count) {
    const { rng } = world.pursuit;
    const rings = [
      square(0, 22, -32, 42),
      square(0, -22, -32, 42),
      square(-22, 22, -32, 42),
      square(0, 22, -8, 22),
      square(0, -22, -8, 22),
      square(-22, 22, -8, 42)
    ];
    const slots = rings.flatMap((ring) => [ring, ring.slice().reverse()].flatMap((ordered2) => ordered2.map((_, i) => [...ordered2.slice(i), ...ordered2.slice(0, i)])));
    const orderedSlots = shuffled(rng, slots);
    for (let i = 0; i < count; i++) {
      const kind = rng.pick(CAR_KINDS);
      const cruise = i === 0 ? rng.range(3.2, 4.6) : rng.range(4.3, 8.5);
      let car = null;
      for (const ring of i === 0 ? [rings[0], ...orderedSlots] : orderedSlots) {
        const [a, b] = ring;
        const heading2 = headingTo3(a, b);
        const t = i === 0 && ring === rings[0] ? rng.range(0.15, 0.25) : rng.range(0.24, 0.74);
        const start = {
          x: a.x + (b.x - a.x) * t,
          z: a.z + (b.z - a.z) * t
        };
        const offset2 = LANE_OFFSET + rng.range(-0.22, 0.22);
        const p = pose3(
          start.x - offset2 * Math.cos(heading2),
          start.z + offset2 * Math.sin(heading2),
          heading2,
          cruise * rng.range(0.55, 0.86)
        );
        if (distance(p, world.player) < 11) continue;
        const loop = [...ring.slice(1), ring[0]];
        const path = lanePath([start, ...loop, ...loop, ...loop, ...loop], offset2);
        car = addVehicle(world, { ...vehicle(`civilian-${i + 1}`, p, "lane", cruise), path }, kind);
        if (car) break;
      }
      if (!car) throw new Error(`No clean pursuit spawn for civilian-${i + 1}`);
    }
  }
  function spawnPeople(world, count) {
    const { rng } = world.pursuit;
    for (let i = 0; i < count; i++) {
      let placed = false;
      for (let attempt = 0; attempt < 36 && !placed; attempt++) {
        const roadIndex = i === 0 ? 0 : Math.floor(rng.next() * world.drivingRoads.length);
        const r = world.drivingRoads[roadIndex];
        placed = addPerson(world, {
          id: `walker-${i + 1}`,
          road: roadIndex,
          side: rng.next() < 0.5 ? -1 : 1,
          along: i === 0 ? rng.range(-22, -15) : rng.range(r.min + 5, r.max - 5),
          pause: rng.range(0.1, 1.25),
          started: i === 0
        });
      }
      if (!placed) throw new Error(`No clean pursuit spawn for walker-${i + 1}`);
    }
  }
  function populatePursuit(world) {
    const state = world.pursuit;
    const { player } = world;
    if (!bodyOnRoad(player, state.roads) || state.statics.some((body) => overlaps(player, body, 0.24)))
      throw new Error("Pursuit player start is not clear and supported");
    player.speed = Math.min(player.maxSpeed, state.playerStart.speed);
    player.y = player.supportHeightM = heightOnSupport(state, player);
    player.previous = copyPose(player);
    if (state.caseId === "ambient") {
      const tier = TIERS[state.level - 1];
      spawnPolice(world, tier.police);
      spawnCivilians(world, tier.traffic);
      spawnPeople(world, tier.pedestrians);
    } else {
      for (const data of state.scene.cars)
        if (!addVehicle(world, data)) throw new Error(`No clean pursuit spawn for ${data.id}`);
      for (const data of state.scene.people)
        if (!addPerson(world, data)) throw new Error(`No clean pursuit spawn for ${data.id}`);
    }
    world.capacity = {
      traffic: world.actors.filter((a) => a.type === "vehicle" && a !== player).length,
      pedestrians: world.actors.filter((a) => a.type === "pedestrian").length
    };
    world.actorIndex = new SpatialIndex(world.actors);
    world.staticIndex = new SpatialIndex(world.statics);
    world.mode = "auto";
    if (state.packLab) {
      for (const actor of world.actors) {
        if (actor.pursuitRole !== "police") continue;
        actor.pursuitDrive.packOrder = state.patrols.size;
        state.patrols.add(actor);
      }
      state.lanes = streetLanes(world.drivingRoads, player);
      state.patrolMap = { roads: world.roads, drivingRoads: world.drivingRoads, statics: world.statics };
    }
  }
  function lanePoint(lane2, along2) {
    return {
      ...districtRoadPose(lane2.road, clamp(along2, lane2.low, lane2.high), lane2.sign),
      roadId: lane2.road.id
    };
  }
  function streetLanes(roads, car) {
    const pad = car.length / 2 + 0.3;
    return roads.filter((r) => !r.parkingBay && !r.supportApron && r.max - r.min > pad * 2 && r.width / 2 >= Math.abs(r.laneOffsetM ?? 0) + car.width / 2 + 0.12).flatMap((road4) => (road4.flow ? [road4.flow] : [1, -1]).map((sign) => ({
      road: road4,
      sign,
      low: road4.min + pad,
      high: road4.max - pad
    })));
  }
  function packDeploymentLanes(lanes, car) {
    return lanes.concat(lanes.flatMap((lane2) => {
      const offset2 = lane2.road.width / 2 - car.width / 2 - 0.55;
      return !lane2.road.flow && offset2 > (lane2.road.laneOffsetM ?? 0) + 1.45 ? [{ ...lane2, road: { ...lane2.road, laneOffsetM: offset2 }, outside: true }] : [];
    }));
  }
  function deploymentSlots(state, ego, tactic, minRange = 13, maxRange = STREET_DEPLOY_RANGE_M) {
    const sin = Math.sin(ego.heading), cos = Math.cos(ego.heading);
    const slots = [];
    for (const lane2 of state.lanes) {
      const along2 = ego[lane2.road.axis];
      const low = Math.max(lane2.low, along2 - maxRange);
      const high = Math.min(lane2.high, along2 + maxRange);
      for (let at = low; at <= high; at += 3.5) {
        const position2 = lanePoint(lane2, at);
        const range = distance(ego, position2);
        if (range < minRange || range > maxRange) continue;
        const front = (position2.x - ego.x) * sin + (position2.z - ego.z) * cos;
        const alignment = Math.cos(angleDelta(position2.heading, ego.heading));
        const approach2 = tactic === "tail" ? Math.max(0, front) + 7 * (1 - alignment) : tactic === "intercept" ? Math.max(0, -front) + 4 * (1 + alignment) : 7 * Math.abs(alignment);
        slots.push({ lane: lane2, position: position2, score: Math.abs(range - 18) + approach2 });
      }
    }
    return slots.sort((a, b) => a.score - b.score);
  }
  function setStreetPatrolPath(state, car, aim, fallback = null, lanes = state.lanes) {
    const goals = lanes.map((lane2) => lanePoint(lane2, aim[lane2.road.axis]));
    goals.sort((a, b) => distance(a, aim) - distance(b, aim));
    const nearbyGoals = goals.slice(0, fallback ? 3 : 4);
    if (fallback) nearbyGoals.push(fallback);
    for (const goal of nearbyGoals) {
      const path = planDistrictRoute(state.patrolMap, car, goal);
      if (path.length < 3) continue;
      const length = path.reduce((total, point2, i) => i ? total + distance(path[i - 1], point2) : 0, 0);
      if (length > Math.max(30, distance(car, goal) * 2.5 + 15)) continue;
      for (const point2 of path) Object.freeze(point2);
      car.path = Object.freeze(path);
      car.cursor = 0;
      if (car.pursuitDrive) car.pursuitDrive.target = goal;
      return true;
    }
    return false;
  }
  function patrolReach(lane2, car) {
    return lane2.sign > 0 ? lane2.high - car[lane2.road.axis] : car[lane2.road.axis] - lane2.low;
  }
  function huntSector(point2, report) {
    return Math.round(angleDelta(headingTo3(report, point2), report.heading) / (Math.PI / 2)) & 3;
  }
  function huntApproachPoints(world, state, car, report) {
    const occupied = [0, 0, 0, 0], taken = [];
    for (const unit2 of state.patrols) {
      if (unit2 === car) continue;
      if (distance(unit2, report) < 19) occupied[huntSector(unit2, report)] += 1;
      const goal = unit2.pursuitDrive.approach;
      if (goal && distance(goal, report) < 31) {
        occupied[huntSector(goal, report)] += 0.6;
        taken.push(goal);
      }
    }
    const lead = clamp(report.speed * 0.65, -5, 8);
    const ahead = { x: report.x + Math.sin(report.heading) * lead, z: report.z + Math.cos(report.heading) * lead };
    const groups = [[], [], [], []];
    for (const lane2 of state.lanes) {
      for (const inset of [8, 15, 23]) {
        const pose5 = lanePoint(lane2, ahead[lane2.road.axis] - lane2.sign * inset);
        const gap = distance(pose5, report);
        if (gap < 6 || gap > 32 || distance(car, pose5) < 5 || Math.abs(angleDelta(headingTo3(pose5, ahead), pose5.heading)) > 1.15) continue;
        const side = huntSector(pose5, report);
        const crowd = Math.min(3, occupied[side]) * 15 + taken.filter((goal) => distance(goal, pose5) < 7).length * 9;
        const score = Math.abs(gap - 13) + distance(car, pose5) * 0.45 + crowd;
        const options2 = groups[side];
        if (!options2.some((option) => distance(option.pose, pose5) < 1))
          options2.push({ pose: pose5, score });
      }
    }
    for (const options2 of groups) options2.sort((a, b) => a.score - b.score);
    const traffic = world.actorIndex.near(car, 65).filter((actor) => actor !== world.player && actor !== car);
    return { goals: groups.flatMap((options2) => options2.slice(0, 2)).sort((a, b) => a.score - b.score), traffic };
  }
  function planRushPatrol(world, state, car, lane2 = null, player = world.player, search = false) {
    const { pattern } = car.pursuitDrive;
    const lead = search ? 0 : isRushPack(state.variant) ? (pattern === "tail" ? 9 : pattern === "flank" ? 5 : 13) + clamp(player.speed * 0.7, -2, 10) : (pattern === "tail" ? 15 : pattern === "flank" ? 10 : 24) + clamp(player.speed * 1.3, -3, 18);
    const pack = isPackPursuit(state.variant);
    const aim = pack && !search ? packApproach({
      car,
      report: player,
      order: car.pursuitDrive.packOrder,
      street: state.street === true,
      tick: world.tick,
      startedTick: state.startedTick ?? world.tick,
      clear: state.response.sightedBy.has(car)
    }) : { x: player.x + Math.sin(player.heading) * lead, z: player.z + Math.cos(player.heading) * lead };
    state.patrolMap.statics = world.statics;
    let goals = state.lanes.map((candidate) => {
      const pose5 = lanePoint(candidate, aim[candidate.road.axis]);
      const alignment = Math.cos(angleDelta(pose5.heading, pack ? headingTo3(pose5, player) : player.heading));
      const score = distance(pose5, aim) + (1 - alignment) * (pack ? 4 : 7) + (patrolReach(candidate, pose5) < 3 ? 5 : 0);
      return { pose: pose5, score, candidate };
    }).sort((a, b) => a.score - b.score).slice(0, search ? 2 : 4);
    const hunt = isCityHunt(state.variant) && !search && !lane2 && state.response.lastSeen;
    const approaches = hunt && huntApproachPoints(world, state, car, player);
    if (approaches) goals = approaches.goals.slice(0, 4).concat(goals.slice(0, 2));
    if (search) {
      const nearest2 = goals[0];
      if (nearest2) for (const offset2 of [-14, 14]) {
        const { pose: pose5, candidate } = nearest2;
        const alternative = lanePoint(candidate, pose5[candidate.road.axis] + candidate.sign * offset2);
        if (distance(alternative, pose5) >= 6 && distance(alternative, player) <= 23)
          goals.push({ pose: alternative });
      }
    }
    if (lane2 && patrolReach(lane2, car) >= 8)
      goals.push({ pose: lanePoint(lane2, car[lane2.road.axis] + lane2.sign * 21) });
    for (const { pose: pose5 } of goals) {
      if (distance(car, pose5) < 7) continue;
      const path = planDistrictRoute(state.patrolMap, car, pose5, approaches?.traffic);
      if (path.length < 3) continue;
      let length = 0;
      for (let i = 1; i < path.length; i++) length += distance(path[i - 1], path[i]);
      if (length > Math.max(32, distance(car, pose5) * (hunt ? 2.7 : 2.2) + (hunt ? 28 : 13))) continue;
      for (const point2 of path) Object.freeze(point2);
      car.path = Object.freeze(path);
      car.cursor = 0;
      car.pursuitDrive.target = pose5;
      if (isCityHunt(state.variant)) {
        const before = car.pursuitDrive.approach;
        car.pursuitDrive.approach = hunt ? pose5 : null;
        if (hunt && before && distance(before, pose5) > 5 && (before.roadId !== pose5.roadId || huntSector(before, player) !== huntSector(pose5, player)))
          state.metrics.patrolReassignments = (state.metrics.patrolReassignments ?? 0) + 1;
      }
      return true;
    }
    return false;
  }
  function rushDispatch(world, state, count, player = world.player) {
    const arcade = isRushPack(state.variant);
    const pack = isPackPursuit(state.variant);
    const opening = arcade && world.pursuit !== state;
    const survival = state.survival;
    const sin = Math.sin(player.heading), cos = Math.cos(player.heading);
    const close = world.actors.filter((other) => distance(player, other) < STREET_DEPLOY_RANGE_M + 17);
    const dispatched = [];
    for (let i = 0; i < count; i++) {
      const order = survival ? survival.spawnCount : state.patrols.size;
      const time = (world.tick - state.startedTick) * STEP;
      const heavy = survival && time >= 13 && (!survival.heavyCount || order % 5 === 4);
      const kind = heavy ? "van" : "sedan";
      const pattern = heavy ? "intercept" : pack ? packTactic(order) : RUSH_TACTICS[order % RUSH_TACTICS.length];
      const id = `street-pursuit-${state.run}-patrol-${order + 1}`;
      const car = world.makeVehicle(id, kind, { x: player.x, z: player.z, heading: player.heading });
      if (!state.lanes.length) state.lanes = streetLanes(world.drivingRoads, car);
      if (heavy) Object.assign(car, { width: 2.26, length: 5.55, height: 2.62 });
      const fronts = pack ? [...state.patrols].map((car2) => ({
        forward: (car2.x - player.x) * sin + (car2.z - player.z) * cos,
        lateral: (car2.x - player.x) * cos - (car2.z - player.z) * sin
      })) : null;
      const lanes = pack ? packDeploymentLanes(state.lanes, car) : state.lanes;
      const slots = deploymentSlots({ lanes }, player, pattern, pack && opening ? 7 : 13).flatMap(({ lane: lane2, position: position2 }) => {
        const dx = position2.x - player.x, dz = position2.z - player.z;
        const range = Math.hypot(dx, dz), forward2 = dx * sin + dz * cos;
        const lateral2 = dx * cos - dz * sin;
        const alignment = Math.cos(angleDelta(position2.heading, player.heading));
        if (survival && (range < (opening ? 21 : 18) || heavy && lane2.road.width < 6.8)) return [];
        if (range < (pack && opening && Math.abs(lateral2) >= 2.45 ? 7 : pack ? 14 : 18) || patrolReach(lane2, position2) < 10 || forward2 > 0 && forward2 < 37 && Math.abs(lateral2) < 3) return [];
        if (pack) {
          if (survival) {
            const preferred = opening ? order === 0 ? 2 : 1 : order % 4;
            const step = (huntSector(position2, player) - preferred + 4) % 4;
            const score2 = Math.abs(range - (opening ? 29 : 32)) + Math.min(step, 4 - step) * 13 + (opening && forward2 > 0 ? 8 : 0);
            return [{ lane: lane2, position: position2, stance: false, score: score2 }];
          }
          const stance = opening && order < 4 && Math.abs(lateral2) > 2.45 && Math.abs(lateral2) <= 11 && Math.abs(forward2) < 15;
          const score = packSpawnBias({ order, forward: forward2, lateral: lateral2, range, alignment, opening, fronts });
          return [{ lane: lane2, position: position2, stance, score: score - (stance && order !== 0 ? 13 : 0) }];
        }
        if (opening && alignment < -0.85 && forward2 > 0 && range < 49 && Math.abs(lateral2) < 7)
          return [];
        const side = (arcade ? order : i) % 2 ? -1 : 1;
        const desired = arcade ? pattern === "tail" ? 30 + order % 4 * 4 : 36 : order >= 7 ? 35 : pattern === "tail" ? 24 + order * 1.5 : 28;
        const approach2 = pattern === "tail" ? Math.max(0, forward2 + 5) * 1.8 + (1 - alignment) * 21 + Math.abs(lateral2) * 0.32 : pattern === "flank" ? Math.abs(alignment) * 9 + Math.max(0, -side * lateral2) * 0.45 : Math.max(0, -forward2) * 1.25 + 4 * (alignment + 1);
        return [{ lane: lane2, position: position2, score: Math.abs(range - desired) + approach2 }];
      }).sort((a, b) => a.score - b.score);
      let placed = false, tried = 0;
      for (const { lane: lane2, position: position2, stance } of slots) {
        Object.assign(car, position2);
        if (!bodyOnRoad(car, world.drivingRoads, 0.12) || close.some((other) => overlaps(car, other, pack ? 0.65 : 2)) || [...state.patrols].some((other) => overlaps(car, other, pack ? 1.4 : 3.6)) || world.statics.some((other) => overlaps(car, other, 0.45))) continue;
        const road4 = { width: lane2.road.width, limit: lane2.road.speedLimitMps };
        const pace = arcade ? arcadePatrolLimit(road4) : rushRoadLimit(road4, true);
        const end = { ...car, ...lanePoint(lane2, position2[lane2.road.axis] + lane2.sign * 7) };
        if (!sweepSafe(car, end, close.concat([...state.patrols], world.statics), world.drivingRoads).safe) continue;
        car.maxSpeed = arcade ? 22.5 + state.level * 0.65 : 14.6 + state.level * 0.25;
        if (survival) car.pursuitUnit = heavy ? "heavy" : time >= 5 && order % 3 !== 2 ? "interceptor" : "cruiser";
        if (arcade) car.spec = {
          ...car.spec,
          acceleration: heavy ? 5.1 : 6.4,
          braking: 9,
          steerRate: heavy ? 1.65 : 2.2,
          ...heavy ? { wheelbase: 3.2 } : {}
        };
        const shortLaunch = opening && distance(car, player) < 32 && (car.x - player.x) * sin + (car.z - player.z) * cos < -8 && Math.abs(angleDelta(car.heading, player.heading)) < 0.3;
        const packOpening = pack && opening && distance(car, player) <= 29 && !survival;
        setPursuitDrive(car, {
          position: { speed: Math.min(packOpening ? 3.4 : shortLaunch ? 5 : arcade ? 9 : 7.5, pace * 0.62) },
          behaviour: pattern,
          cruise: car.maxSpeed
        }, kind);
        if (shortLaunch) car.pursuitDrive.launchUntil = world.tick + ARCADE_BACKUP_TICKS;
        if (pack) car.pursuitDrive.packOrder = order;
        if (stance || packOpening && lane2.outside) {
          const along2 = position2[lane2.road.axis];
          car.path = Object.freeze(Array.from({ length: 11 }, (_, i2) => Object.freeze(lanePoint(lane2, along2 + i2 * lane2.sign))));
          car.pursuitDrive.target = car.path.at(-1);
        } else if (!planRushPatrol(world, state, car, lane2, player)) {
          if (++tried >= 16) break;
          continue;
        }
        car.phase = state.rng.next();
        car.reckless = false;
        initializeDistrictActor({ environment: world.environment, rng: state.rng }, car);
        car.district.nextLoadingDistanceM = Infinity;
        car.pursuitDrive.nextPlan = world.tick + ticks2(pack ? 0.3 + 0.4 * car.phase : 0.75 + 0.6 * car.phase);
        if (packOpening) {
          car.pursuitDrive.openingUntil = world.tick + ticks2(2.6 + order % 3 * 0.32);
          car.pursuitDrive.nextPlan = car.pursuitDrive.openingUntil;
        }
        car.previous = copyPose(car);
        state.patrols.add(car);
        if (survival) {
          survival.spawnCount++;
          if (heavy) survival.heavyCount++;
        }
        dispatched.push(car);
        placed = true;
        break;
      }
      if (!placed) break;
    }
    world.actors.push(...dispatched);
    if (world.pursuit === state)
      for (const car of dispatched) {
        logEvent(world, "reinforcement", car, car.id);
        if (survival) emitSurvival(
          world,
          "dispatch",
          car,
          car.pursuitUnit,
          { actorId: car.id, sector: huntSector(car, player) }
        );
      }
    return dispatched.length;
  }
  function newGtaPatrol(world, state, unitType) {
    const id = `street-pursuit-${state.run}-gta-${++state.gta.serial}`;
    const { x, z, heading: heading2 } = world.player;
    const car = world.makeVehicle(id, GTA_PATROL_PROFILES[unitType].kind, { x, z, heading: heading2 }, state.rng);
    initializeGtaPatrol(car, unitType, state);
    car.gtaAI.lanes = streetLanes(world.drivingRoads, car);
    return car;
  }
  function registerGtaPatrol(world, state, car) {
    initializeDistrictActor({ environment: world.environment, rng: state.rng }, car);
    car.district.nextLoadingDistanceM = Infinity;
    car.previous = copyPose(car);
    state.patrols.add(car);
    world.actors.push(car);
    if (world.pursuit === state) logEvent(world, "reinforcement", car, car.id);
    return car;
  }
  function visibleGtaDeployment(world, state, position2) {
    if (state.gta.config.ruleset !== "dispatch-v1" || world.tick === state.startedTick) return false;
    return !gtaDeploymentHidden(world, world.player, position2);
  }
  function openingTravel(speed, acceleration, cap) {
    const seconds2 = 4;
    const limitedSpeed = clamp(speed, 0, cap);
    const accelerating = Math.min(seconds2, (cap - limitedSpeed) / acceleration);
    return limitedSpeed * accelerating + acceleration * accelerating ** 2 / 2 + cap * (seconds2 - accelerating);
  }
  function deployGtaPatrol(world, state, tactic, unitType, forwardOnly = false) {
    const car = newGtaPatrol(world, state, unitType);
    const player = world.player;
    const opening = state.gta.config.ruleset === "dispatch-v1" && world.tick === state.startedTick;
    const berth = opening ? Math.min(46, 35 + 0.55 * Math.abs(player.speed)) : 0;
    const slots = deploymentSlots(
      { lanes: car.gtaAI.lanes },
      player,
      tactic,
      Math.max(state.gta.config.minSpawnRadius, berth),
      opening ? 66 : STREET_DEPLOY_RANGE_M
    );
    const others = [...state.patrols];
    const openingRoad = opening && (!others.length && tactic === "tail" || state.wantedLevel >= 4) && world.drivingRoads.find((road4) => !road4.parkingBay && !road4.supportApron && road4.axis === (Math.abs(Math.sin(player.heading)) > 0.707 ? "x" : "z") && pointOnRoad(player, [road4]));
    const approach2 = openingRoad && !others.length && tactic === "tail";
    const reactionRoom = openingRoad && state.wantedLevel >= 4 && openingTravel(player.speed, player.spec?.acceleration ?? VEHICLE.acceleration, GTA_MAX_SPEED) + (player.length + car.length) / 2;
    const approachTravel = reactionRoom ? openingTravel(2, car.spec.acceleration, car.maxSpeed) : 0;
    for (const slot of slots) {
      const { forward: forward2, right } = gtaLocal(player, slot.position);
      if (forwardOnly && forward2 <= 0) {
        slot.score = Infinity;
        continue;
      }
      if (forwardOnly) slot.score += 10 * (1 - Math.cos(angleDelta(slot.position.heading, player.heading)));
      if (tactic === "flank") {
        const side = car.gtaAI.order % 2 ? -1 : 1;
        slot.score += 0.3 * Math.abs(forward2) + (right * side < 0 ? 13 : 0);
      }
      if (reactionRoom && forward2 > 0 && slot.lane.road.id === openingRoad.id) {
        const opposing = -Math.cos(angleDelta(slot.position.heading, player.heading));
        if (opposing > 0.5 && forward2 < reactionRoom + approachTravel * opposing) {
          slot.score = Infinity;
          continue;
        }
      }
      if (approach2) {
        const { road: road4, sign } = slot.lane;
        const sameLane2 = road4.id === openingRoad.id && forward2 < 0 && Math.abs(right) < 3 && Math.abs(angleDelta(slot.position.heading, player.heading)) < 0.4;
        const joinsBehind = road4.axis !== openingRoad.axis && forward2 < 0 && road4.fixed >= openingRoad.min && road4.fixed <= openingRoad.max && openingRoad.fixed >= road4.min && openingRoad.fixed <= road4.max && (openingRoad.fixed - slot.position[road4.axis]) * sign > 0;
        if (!sameLane2 && !joinsBehind) slot.score += 45;
      }
      for (const other of others) slot.score += Math.max(0, 13 - distance(other, slot.position)) * 0.9;
    }
    slots.sort((a, b) => a.score - b.score);
    for (const { position: position2, score } of slots) {
      if (!Number.isFinite(score)) break;
      Object.assign(car, position2);
      if (visibleGtaDeployment(world, state, car) || !isFree(world, car, 0.65) || !bodyOnRoad(car, world.drivingRoads)) continue;
      car.speed = Math.min(2, car.maxSpeed);
      return registerGtaPatrol(world, state, car);
    }
    return null;
  }
  function gtaPatrolCount(state) {
    let count = 0;
    for (const unit2 of state.patrols) if (unit2.aiState !== "WRECKED") count++;
    return count;
  }
  function gtaPatrolTarget(state) {
    const { maxActivePatrols } = state.gta.config;
    return Math.min(maxActivePatrols, [0, 3, 5, 7, 9, maxActivePatrols][state.wantedLevel]);
  }
  function fillGtaPatrols(world, state, count) {
    const target = gtaPatrolTarget(state), star = state.wantedLevel;
    const squad = [...state.patrols].filter((unit2) => unit2.aiState !== "WRECKED");
    const fast = squad.filter((unit2) => unit2.unitType === "interceptor").length;
    const heavy = squad.filter((unit2) => unit2.unitType === "swat").length;
    let fastNeeded = star >= 3 ? Math.max(0, Math.min(star - 1, Math.floor(target / 2)) - fast) : 0;
    let heavyNeeded = state.gta.config.enableSwat && star >= 4 ? Math.max(0, Math.min(star - 3, Math.floor(target / 3)) - heavy) : 0;
    for (let i = 0; i < count; i++) {
      const unitType = heavyNeeded > 0 ? "swat" : fastNeeded > 0 ? "interceptor" : "patrol";
      const tactic = RUSH_TACTICS[(squad.length + i) % RUSH_TACTICS.length];
      const spawned = deployGtaPatrol(world, state, tactic, unitType) ?? (unitType !== "patrol" ? deployGtaPatrol(world, state, tactic, "patrol") : null);
      if (spawned?.unitType === "swat") heavyNeeded--;
      if (spawned?.unitType === "interceptor") fastNeeded--;
    }
  }
  function removeGtaPatrol(world, state, car) {
    state.patrols.delete(car);
    state.response?.sightedBy.delete(car);
    state.response?.closePatrols.delete(car);
    const index = world.actors.indexOf(car);
    if (index >= 0) world.actors.splice(index, 1);
  }
  function gtaRoadblocksEnabled(state) {
    return state.wantedLevel >= 3 && state.gta.config.enableRoadblocks && gtaPatrolTarget(state) >= 3;
  }
  function placeGtaRoadblock(world) {
    const { pursuit: s, player, tick } = world, { gta } = s;
    if (!gtaRoadblocksEnabled(s) || gta.roadblock || tick < gta.nextRoadblockTick) return;
    const coordinated = gta.config.ruleset === "dispatch-v1";
    const report = coordinated ? s.response.lastSeen : player;
    if (coordinated && (tick === s.startedTick || !isDispatchTracked(s.response) || report?.tick !== tick || report.speed < 3)) return;
    gta.nextRoadblockTick = tick + ticks2(1.1);
    const needed = Math.max(0, gtaPatrolCount(s) + 2 - gtaPatrolTarget(s));
    if (needed && coordinated) return;
    const spare = [...s.patrols].filter((car) => !isGtaStationary(car) && !s.response.sightedBy.has(car) && distance(player, car) > gta.config.minSpawnRadius + 5).sort((a, b) => distance(player, b) - distance(player, a)).slice(0, needed);
    if (spare.length !== needed) return;
    const cars = [newGtaPatrol(world, s, "patrol"), newGtaPatrol(
      world,
      s,
      gta.config.enableSwat && s.wantedLevel >= 4 ? "swat" : "patrol"
    )];
    const barrier2 = {
      id: `street-pursuit-${s.run}-gta-barrier-${gta.serial}`,
      type: "static",
      kind: "barrier",
      width: 1.35,
      length: s.wantedLevel >= 4 ? 0.95 : 0.65,
      height: 0.75,
      gtaRoadblock: true
    };
    const shapes = [...cars, barrier2];
    const sin = Math.sin(report.heading), cos = Math.cos(report.heading);
    const avenues = world.drivingRoads.filter((road4) => road4.width >= 12 && !road4.parkingBay && !road4.supportApron).map((road4) => ({
      road: road4,
      align: road4.axis === "x" ? sin : cos,
      away: Math.abs(road4.fixed - report[road4.axis === "x" ? "z" : "x"])
    })).filter(({ road: road4, align, away }) => coordinated ? Math.abs(align) > 0.86 && away < road4.width / 2 : Math.abs(align) > 0.62 && away < 18).sort((a, b) => a.away - b.away);
    const spacing = gta.rngSide ??= s.rng.next() < 0.5 ? 1 : -1;
    const occupied = coordinated ? [...s.closures.keys(), ...world.actors.filter((actor) => actor !== player)] : [];
    for (const { road: road4, align } of avenues) {
      const sign = Math.sign(align);
      if (road4.flow && road4.flow !== sign) continue;
      const maxFront = gta.config.minSpawnRadius + (coordinated ? 58 : 34);
      for (let front = gta.config.minSpawnRadius + 9; front <= maxFront; front += 4) {
        const along2 = report[road4.axis] + sign * front;
        if (along2 < road4.min + 5 || along2 > road4.max - 5) continue;
        const center = districtRoadPose({ ...road4, laneOffsetM: 0 }, along2, sign);
        Object.assign(cars[0], gtaOffset(center, 0, -spacing * 3.1), { heading: center.heading + spacing * 0.72 });
        Object.assign(cars[1], gtaOffset(center, 1.9, spacing * 3.1), { heading: center.heading - spacing * 0.74 });
        Object.assign(barrier2, gtaOffset(center, -1.6), { heading: center.heading, roadId: road4.id });
        if (shapes.some((body, i) => visibleGtaDeployment(world, s, body) || distance(player, body) <= gta.config.minSpawnRadius || gtaLocal(player, body).forward <= 0 || !bodyOnRoad(body, [road4]) || !isFree(world, body, 0.5) || shapes.slice(i + 1).some((other) => overlaps(body, other, 0.5)))) continue;
        const detour = coordinated ? dispatchRoadblockDetour(
          s.patrolMap,
          { ...vehicleProbe(player, report.speed), ...report },
          road4,
          sign,
          along2,
          [...occupied, ...shapes]
        ) : null;
        if (coordinated && !detour) continue;
        const expires = tick + ticks2([0, 0, 0, 14, 11, 8][s.wantedLevel]);
        if (!registerBarrier(world, barrier2, "roadblock", expires)) continue;
        for (const old of spare) removeGtaPatrol(world, s, old);
        for (const car of cars) {
          Object.assign(car, { gtaRoadblock: true, aiState: "ROADBLOCK", squadRole: "ROADBLOCK", speed: 0 });
          registerGtaPatrol(world, s, car);
        }
        gta.roadblock = { cars, barrier: barrier2, expires, ...detour ? { detour } : {} };
        gta.nextRoadblockTick = expires;
        return;
      }
    }
  }
  function maintainGtaSquad(world) {
    const { pursuit: s, tick, player } = world, { gta } = s;
    const coordinated = gta.config.ruleset === "dispatch-v1";
    for (const car of s.patrols) if (car.wreckUntilTick <= tick) removeGtaPatrol(world, s, car);
    if (gta.roadblock?.expires <= tick) {
      const { cars, barrier: barrier2 } = gta.roadblock;
      for (const car of cars) if (car.aiState !== "WRECKED") removeGtaPatrol(world, s, car);
      const index = world.statics.indexOf(barrier2);
      if (index >= 0) world.statics.splice(index, 1);
      s.closures.delete(barrier2);
      releaseStreetStatics(world);
      s.patrolMap.statics = world.statics;
      world.staticIndex = new SpatialIndex(world.statics);
      gta.roadblock = null;
    }
    if (!coordinated) for (const car of [...s.patrols]) {
      if (isGtaStationary(car)) continue;
      const ai = car.gtaAI;
      ai.behindTicks = !s.response.sightedBy.has(car) && distance(car, player) > 95 && gtaLocal(player, car).forward < 0 ? ai.behindTicks + 1 : 0;
      if (ai.behindTicks <= ticks2(6) || tick < (ai.nextRecycle ?? 0)) continue;
      ai.nextRecycle = tick + ticks2(0.75);
      const replacement = deployGtaPatrol(world, s, "intercept", car.unitType, true);
      if (replacement) removeGtaPatrol(world, s, car);
    }
    if (coordinated ? isDispatchTracked(s.response) : s.response.sightedBy.size) {
      placeGtaRoadblock(world);
      const reserve = coordinated && !gta.roadblock && gtaRoadblocksEnabled(s) && tick - s.startedTick < ticks2(12) ? 2 : 0;
      const deficit = gtaPatrolTarget(s) - reserve - gtaPatrolCount(s);
      if (deficit > 0 && tick >= gta.nextDispatchTick) {
        fillGtaPatrols(world, s, Math.min(deficit, 2));
        gta.nextDispatchTick = tick + ticks2(1.2);
      }
    }
    if (tick >= gta.nextSquadTick) {
      if (!coordinated || s.response.lastSeen)
        assignGtaSquad(s.patrols, s.response.lastSeen ?? s.playerStart);
      gta.nextSquadTick = tick + ticks2(0.5);
    }
  }
  function beginStreetPursuit(world, level = 1, variant = "legacy", config) {
    const gtaConfig = variant === "gta" ? resolveGtaChaseConfig(config, level) : null;
    if (gtaConfig) level = gtaConfig.wantedLevelStart;
    else validateLevel(level);
    if (!["legacy", "rush", "cinematic", "arcade", "pack", "hunt", "survival", "gta"].includes(variant))
      throw new Error("Unsupported street pursuit variant");
    if (world.environment !== "metro" || !world.district?.pursuitExits?.length)
      throw new Error("Street pursuit requires a metro district with pursuit exits");
    if (gtaConfig && world.config.cityVersion !== 4)
      throw new Error("GTA Chase requires Metro City v4");
    if (world.pursuit?.phase === "running") throw new Error("Street pursuit is already running");
    if (world.pursuit?.reviewUntilTick > world.tick) throw new Error("Let the impact review finish first");
    const { player } = world;
    if (!bodyOnRoad(player, world.roads)) throw new Error("No safe street pursuit deployment");
    const occupiedIds = [...world.actors, ...world.statics].map((body) => body.id);
    let run = (world.pursuit?.run ?? 0) + 1;
    while (occupiedIds.some((id) => id.startsWith(`street-pursuit-${run}-`))) run++;
    const rush = usesRushPace(variant);
    const arcade = isRushPack(variant), pack = isPackPursuit(variant);
    const rng = new Random(`${world.config.seed}:street-pursuit-${gtaConfig || arcade ? variant : rush ? "rush" : "v1"}:${world.tick}:${run}:${level}`);
    const state = {
      street: true,
      run,
      level,
      caseId: "street",
      phase: "running",
      playerStart: copyPose(player),
      exits: world.district.pursuitExits.map((exit2) => ({ ...exit2 })),
      events: [],
      action: null,
      appliedCommand: null,
      decision: null,
      startedTick: world.tick,
      endedTick: null,
      metrics: pursuitMetrics(),
      rng,
      patrols: /* @__PURE__ */ new Set(),
      closures: /* @__PURE__ */ new Map(),
      contacts: /* @__PURE__ */ new Set(),
      near: /* @__PURE__ */ new Set(),
      nextEventTick: ticks2(rng.range(2.4, 4.2)),
      eventKinds: [],
      eventSerial: 0,
      patrolMap: { roads: world.roads, drivingRoads: world.drivingRoads, statics: world.statics },
      lanes: [],
      junctions: world.drivingRoads.filter((r) => r.axis === "x" && !r.supportApron).flatMap((a) => world.drivingRoads.filter((r) => r.axis === "z" && !r.supportApron && r.fixed >= a.min && r.fixed <= a.max && a.fixed >= r.min && a.fixed <= r.max).map((r) => ({ x: r.fixed, z: a.fixed })))
    };
    const tactics = ["tail", "flank", "intercept", "flank", "tail", "intercept"];
    const ambientRandomState = world.rng.state;
    try {
      if (gtaConfig) {
        state.variant = "gta";
        state.response = createPursuitResponse();
        state.patrolMap.metro = true;
        initializeGtaPursuit(state, player, gtaConfig);
        state.gta.fadeStars = level;
        const count = gtaPatrolTarget(state);
        fillGtaPatrols(world, state, Math.max(0, count - (gtaRoadblocksEnabled(state) ? 2 : 0)));
        if (count && !state.patrols.size) throw new Error("No safe GTA patrol deployment");
        initializeGtaDurability(player, gtaConfig.playerMaxHealth, PLAYER_VEHICLE.massKg);
        player.maxSpeed = GTA_MAX_SPEED;
        player.path = [];
        player.parking = null;
        player.cursor = 0;
      } else if (rush) {
        const [initial, target] = (arcade ? ARCADE_WAVES : RUSH_WAVES)[level - 1];
        state.variant = variant;
        if (pack) {
          initializePack(state, "running");
          state.variant = variant;
          if (isCityHunt(variant)) Object.assign(state.metrics, { pedestrianCost: 0, pedestrianDanger: 0 });
        } else if (arcade || variant === "cinematic") state.response = createPursuitResponse();
        state.targetPatrols = target;
        state.nextDispatchTick = world.tick + (arcade ? ARCADE_BACKUP_TICKS : ticks2(rng.range(2.4, 3.1)));
        if (arcade) state.wantedLevel = level;
        if (isSurvival(variant)) {
          state.survival = createSurvival(player, world.tick, config?.giantPhysics);
          state.wantedLevel = 1;
          state.manualAction = { steer: 0, throttle: 1, brake: 0, gear: 1 };
          state.nextDispatchTick = world.tick + ticks2(2.4);
        }
        state.nextEventTick = ticks2(rng.range(5.2, 5.8));
        state.patrolMap.metro = true;
        rushDispatch(world, state, state.survival ? 2 : initial, state.response ? state.playerStart : player);
        if (!state.patrols.size) throw new Error("No safe street pursuit deployment");
      } else for (const [i, behaviour] of tactics.slice(0, TIERS[level - 1].police).entries()) {
        const id = `street-pursuit-${run}-patrol-${i + 1}`;
        const car = world.makeVehicle(id, "sedan", { x: player.x, z: player.z, heading: player.heading });
        if (!i) state.lanes = streetLanes(world.drivingRoads, car);
        let found = false;
        for (const { lane: lane2, position: position2 } of deploymentSlots(state, player, behaviour)) {
          const { x, z, heading: heading2 } = position2;
          Object.assign(car, { x, z, heading: heading2 });
          if (!isFree(world, car, 0.65) || !bodyOnRoad(car, world.drivingRoads) || [...state.patrols].some((other) => overlaps(car, other, 0.65))) continue;
          const cruise = 6.9 + level * 0.6 + rng.range(-0.3, 0.5);
          const speed = Math.min(2.5, (lane2.road.speedLimitMps ?? cruise) * 0.5);
          setPursuitDrive(car, { position: { speed }, behaviour, cruise }, "sedan");
          const fallback = lanePoint(lane2, position2[lane2.road.axis] + lane2.sign * 16);
          if (!setStreetPatrolPath(state, car, player, fallback)) continue;
          car.phase = rng.next();
          car.reckless = false;
          initializeDistrictActor({ environment: world.environment, rng }, car);
          car.district.nextLoadingDistanceM = Infinity;
          car.pursuitDrive.nextPlan = world.tick + 26 + Math.floor(car.phase * 17);
          car.previous = copyPose(car);
          state.patrols.add(car);
          found = true;
          break;
        }
        if (!found) throw new Error(`No safe street pursuit deployment for patrol ${i + 1}`);
      }
    } finally {
      world.rng.state = ambientRandomState;
    }
    if (!rush && !gtaConfig) world.actors.push(...state.patrols);
    world.actorIndex = new SpatialIndex(world.actors);
    world.pursuit = state;
    if (state.gta) {
      placeGtaRoadblock(world);
      const reserve = state.gta.config.ruleset === "dispatch-v1" && gtaRoadblocksEnabled(state) ? 2 : 0;
      fillGtaPatrols(world, state, gtaPatrolTarget(state) - reserve - gtaPatrolCount(state));
      world.actorIndex = new SpatialIndex(world.actors);
    }
    if (state.response) {
      updatePursuitResponse(world, true);
      if (!state.gta) for (const patrol2 of state.patrols)
        patrol2.pursuitDrive.tracking = state.response.sightedBy.has(patrol2);
    }
    if (state.gta) {
      world.updateSensors(false);
      if (state.gta.config.ruleset === "dispatch-v1") {
        state.gta.scanner = new PursuitScanner();
        state.gta.scan = state.gta.scanner.sample(world);
      }
    }
    logEvent(world, "start", player);
    return state;
  }
  function releaseStreetStatics(world) {
    const state = world.pursuit;
    const { staticOverlay } = state;
    if (!staticOverlay || state.closures.size) return;
    const { live, permanent } = staticOverlay;
    if (world.statics === live && live.length === permanent.length && live.every((body, i) => body === permanent[i])) world.statics = permanent;
    state.staticOverlay = null;
    state.patrolMap.statics = world.statics;
  }
  function cleanupStreetPursuit(world) {
    const state = world.pursuit;
    if (state.survival && !releaseSurvival(world)) return false;
    for (let i = world.actors.length - 1; i >= 0; i--)
      if (state.patrols.has(world.actors[i]) || state.survival?.wrecks.has(world.actors[i])) world.actors.splice(i, 1);
    for (let i = world.statics.length - 1; i >= 0; i--)
      if (state.closures.has(world.statics[i])) world.statics.splice(i, 1);
    state.patrols.clear();
    state.survival?.wrecks.clear();
    state.closures.clear();
    releaseStreetStatics(world);
    state.contacts.clear();
    state.near.clear();
    state.sightings?.clear();
    if (state.response) {
      state.response.sightedBy.clear();
      state.response.closePatrols.clear();
      state.response.unitsInContact = 0;
    }
    if (isRushPack(state.variant)) state.wantedLevel = 0;
    if (state.gta) {
      world.player.maxSpeed = state.gta.normalMaxSpeed;
      world.player.gtaSlipMps = world.player.gtaYawRate = 0;
      state.gta.roadblock = null;
    }
    state.reviewUntilTick = null;
    if (state.endedTick == null) {
      state.endedTick = world.tick;
      logEvent(world, state.phase, world.player);
    }
    world.actorIndex = new SpatialIndex(world.actors);
    world.staticIndex = new SpatialIndex(world.statics);
    return true;
  }
  function endStreetPursuit(world) {
    const state = world.pursuit;
    if (state?.street && (state.phase === "running" || state.reviewUntilTick)) {
      if (state.phase === "running") state.phase = "stopped";
      cleanupStreetPursuit(world);
      world.updateSensors(false);
    }
    return state?.street ? state : null;
  }
  function startPackDrill(world) {
    const state = world.pursuit;
    state.startedTick = world.tick;
    updatePursuitResponse(world, true);
    logEvent(world, "start", world.player);
  }
  function stepPackReview(world) {
    const state = world.pursuit;
    if (!isPackPursuit(state?.variant) || !state.reviewUntilTick) return false;
    if (++world.tick >= state.reviewUntilTick) {
      if (state.street) {
        const restoreMounts = Boolean(world.player.giantScale);
        if (cleanupStreetPursuit(world)) {
          world.resumeStreetDrive();
          if (restoreMounts) world.updateSensors(false);
        } else state.reviewUntilTick = world.tick + 1;
      } else state.reviewUntilTick = null;
    }
    return true;
  }
  function copyPose(a) {
    return {
      id: a.id,
      type: a.type,
      x: a.x,
      z: a.z,
      y: a.y ?? 0,
      heading: a.heading,
      speed: a.speed ?? 0,
      length: a.length,
      width: a.width,
      radius: a.radius
    };
  }
  function heightOnSupport(state, a) {
    if (!state.support.length) return 0;
    const reach = (a.spec?.wheelbase ?? VEHICLE.wheelbase) / 2;
    const track2 = a.id === "player" ? PLAYER_VEHICLE.trackM : a.width * 0.83;
    const cos = Math.cos(a.heading), sin = Math.sin(a.heading);
    let support = 0;
    for (const side of [-1, 1]) for (const end of [-1, 1]) {
      const x = a.x + side * track2 * cos / 2 + end * reach * sin;
      const z = a.z - side * track2 * sin / 2 + end * reach * cos;
      let height = 0;
      for (const r of state.support) {
        const inside = Math.min(x - r.minX, r.maxX - x, z - r.minZ, r.maxZ - z);
        height = Math.max(height, clamp(inside / 0.65, 0, 1) * r.height);
      }
      support += height / 4;
    }
    return support;
  }
  function logEvent(world, kind, point2, actorId, tick = world.tick) {
    const state = world.pursuit;
    state.events.push({
      id: `${state.street ? `street-pursuit-${state.run}` : "pursuit"}-event-${++state.eventSerial}`,
      kind,
      tick,
      x: point2.x,
      z: point2.z,
      ...actorId ? { actorId } : {}
    });
    if (state.events.length > MAX_EVENTS) state.events.shift();
  }
  function registerBarrier(world, body, kind, removeAt = Infinity) {
    if (!isFree(world, body, 0.4)) return false;
    const state = world.pursuit;
    if (state.street && world.statics === world.district.statics) {
      const permanent = world.statics;
      state.staticOverlay = { permanent, live: permanent.slice() };
      world.statics = state.staticOverlay.live;
      if (state.gta) state.patrolMap.statics = world.statics;
    }
    world.statics.push(body);
    state.closures.set(body, removeAt);
    state.navGraph = null;
    world.staticIndex = new SpatialIndex(world.statics);
    logEvent(world, kind, body, body.id);
    return true;
  }
  function chooseBarrier(world, kind, player = world.player) {
    const { rng, eventSerial, street, run, variant } = world.pursuit;
    const candidates2 = [];
    for (const r of world.drivingRoads) {
      if (street && (r.supportApron || r.parkingBay)) continue;
      for (let n = r.min + 8; n <= r.max - 6; n += 7) {
        const along2 = n + rng.range(-1.1, 1.1);
        const offset2 = kind === "roadblock" && !street ? rng.next() < 0.5 ? -1.65 : 1.65 : 0;
        const point2 = street && kind === "roadblock" ? districtRoadPose(r, along2, r.flow || (rng.next() < 0.5 ? -1 : 1)) : r.axis === "z" ? { x: r.fixed + offset2, z: along2 } : { x: along2, z: r.fixed + offset2 };
        const d = distance(point2, player);
        if (d < (street ? 12 : 7) || d > 45 || world.drivingRoads.some((other) => other.axis !== r.axis && pointOnRoad(point2, [other], -2)) || world.pursuit.exits.some((goal) => distance(point2, goal) < 6))
          continue;
        const forward2 = Math.sin(player.heading) * (point2.x - player.x) + Math.cos(player.heading) * (point2.z - player.z);
        if (usesRushPace(variant)) {
          const speed = Math.abs(player.speed);
          const reactionRoom = player.length + speed * 0.55 + speed ** 2 / (2 * 4.2);
          if (d < Math.max(17, reactionRoom)) continue;
          if (kind === "closure" && forward2 > 0 && pointOnRoad(player, [r], 0)) {
            const own = player[r.axis], low = Math.min(own, along2) + 7, high = Math.max(own, along2) - 6;
            if (!world.drivingRoads.some((other) => other.axis !== r.axis && !other.supportApron && other.width >= player.width + 0.4 && other.fixed >= low && other.fixed <= high && r.fixed >= other.min && r.fixed <= other.max)) continue;
          }
        }
        const width = kind === "closure" ? r.width + (street ? 0 : 0.15) : street ? Math.min(3.2, r.width - 2 * Math.abs(r.laneOffsetM ?? 0)) : 3.2;
        const prefix = street ? `street-pursuit-${run}` : "pursuit";
        const body = barrier(
          `${prefix}-${kind}-${eventSerial + 1}`,
          point2.x,
          point2.z,
          width,
          0.8,
          r.axis === "x" ? Math.PI / 2 : 0
        );
        candidates2.push({ body, score: rng.next() * 36 + Math.abs(d - 19) + (forward2 < -2 ? 11 : 0) });
      }
    }
    candidates2.sort((a, b) => a.score - b.score);
    return candidates2.find(({ body }) => isFree(world, body, 0.4))?.body;
  }
  function updateEvents(world) {
    const s = world.pursuit;
    const elapsed = world.tick - s.startedTick, r = s.response;
    if (isRushPack(s.variant)) {
      if (s.packLab) return;
      if (world.tick >= s.nextDispatchTick) {
        if (s.survival) {
          const timeS = elapsed * STEP;
          s.nextDispatchTick = world.tick + ticks2(timeS < 5 ? 2.4 : Math.max(1.05, 2.05 - timeS * 0.036));
          if (r.unitsInContact || r.stage === "search" && r.lostAtTick !== null && world.tick - r.lostAtTick <= ticks2(2.5)) {
            const room = Math.min(s.targetPatrols, 4 + Math.floor(timeS / 3) * 2) - s.patrols.size;
            const seed = world.rng.state;
            try {
              const count = room > 0 ? rushDispatch(
                world,
                s,
                Math.min(timeS < 6 ? 1 : 2, room),
                r.lastSeen ?? s.playerStart
              ) : 0;
              if (count && r.unitsInContact) s.wantedLevel = Math.min(5, 1 + Math.floor(s.survival.spawnCount / 3));
            } finally {
              world.rng.state = seed;
            }
          }
          return;
        }
        s.nextDispatchTick += ARCADE_BACKUP_TICKS;
        if (r.unitsInContact && s.patrols.size < s.targetPatrols) {
          const ambientSeed = world.rng.state;
          try {
            if (rushDispatch(world, s, 1, r.lastSeen)) s.wantedLevel = Math.min(5, s.wantedLevel + 1);
          } finally {
            world.rng.state = ambientSeed;
          }
        }
      }
      return;
    }
    const confirmed = r?.unitsInContact > 0 && r.pressure >= 0.2;
    const dispatchAt = r ? confirmed ? r.lastSeen : !r.lastSeen && elapsed <= ticks2(3.2) ? s.playerStart : null : world.player;
    if (usesRushPace(s.variant) && dispatchAt && s.patrols.size < s.targetPatrols && world.tick >= s.nextDispatchTick) {
      const ambientSeed = world.rng.state;
      try {
        rushDispatch(world, s, Math.min(2, s.targetPatrols - s.patrols.size), dispatchAt);
      } finally {
        world.rng.state = ambientSeed;
      }
      s.nextDispatchTick = world.tick + ticks2(s.rng.range(0.85, 1.25));
    }
    for (const [body, expires] of s.closures) {
      if (world.tick < expires) continue;
      const index = world.statics.indexOf(body);
      if (index >= 0) world.statics.splice(index, 1);
      s.closures.delete(body);
      s.navGraph = null;
      if (s.street) releaseStreetStatics(world);
      world.staticIndex = new SpatialIndex(world.statics);
      logEvent(world, "reopen", body, body.id);
    }
    if (s.scene?.closure && elapsed >= s.scene.closure.at && registerBarrier(world, s.scene.closure.body, "closure")) s.scene.closure = null;
    if (!s.street && s.caseId !== "ambient" || elapsed < s.nextEventTick || r && !confirmed) return;
    const { rng } = s;
    if (!s.eventKinds.length)
      s.eventKinds.push(...shuffled(rng, s.street ? ["closure", "roadblock"] : ["closure", "roadblock", "congestion"]));
    const kind = s.eventKinds[0];
    let applied = false;
    if (kind === "congestion") {
      const cars = world.actors.filter((a) => a.pursuitRole === "civilian" && a.pursuitDrive.paceUntil <= world.tick);
      const ordered2 = shuffled(rng, cars).sort((a, b) => Number(distance(world.player, b) < 38) - Number(distance(world.player, a) < 38));
      if (ordered2.length) {
        const car = ordered2[0];
        car.pursuitDrive.paceMps = rng.range(0.55, 1.65);
        car.pursuitDrive.paceUntil = world.tick + ticks2(rng.range(3.2, 6));
        logEvent(world, "congestion", car, car.id);
        applied = true;
      }
    } else if (s.closures.size < 2) {
      const position2 = r && { ...r.lastSeen, width: world.player.width, length: world.player.length };
      const body = chooseBarrier(world, kind, position2 ?? void 0);
      if (body) applied = registerBarrier(world, body, kind, world.tick + ticks2(rng.range(5.5, 9)));
    }
    if (applied) s.eventKinds.shift();
    s.nextEventTick = elapsed + ticks2(applied ? rng.range(3.2, 5.7) - (s.level - 1) * 0.24 : 0.65);
  }
  function safeRoadTarget(point2, roads) {
    if (pointOnRoad(point2, roads, 1.35)) return point2;
    let target = null;
    for (const r of roads) {
      const p = r.axis === "z" ? { x: r.fixed, z: clamp(point2.z, r.min, r.max) } : { x: clamp(point2.x, r.min, r.max), z: r.fixed };
      if (!target || distance(point2, p) < distance(point2, target)) target = p;
    }
    return target;
  }
  function navigableGraph(world) {
    const s = world.pursuit;
    if (s.navGraph) return s.navGraph;
    s.navGraph = new Map(Array.from(s.graph, ([key3, node]) => [key3, {
      ...node,
      edges: node.edges.filter((edge) => {
        const end = s.graph.get(edge);
        const heading2 = headingTo3(node, end);
        for (let i = 0, count = Math.ceil(distance(node, end)); i <= count; i++) {
          const probe = { ...interpolate(node, end, i / count), heading: heading2, width: 1.8, length: 1 };
          if (world.statics.some((body) => overlaps(probe, body, 0.12))) return false;
        }
        return true;
      })
    }]));
    return s.navGraph;
  }
  function straightApproach(world, a, target) {
    const heading2 = headingTo3(a, target);
    if (Math.abs(angleDelta(heading2, a.heading)) > 1.18) return false;
    for (let i = 1; i <= 8; i++) {
      const probe = { ...a, ...interpolate(a, target, i / 8), heading: heading2 };
      if (!pointOnRoad(probe, world.drivingRoads, 1.2) || world.statics.some((body) => overlaps(probe, body, 0.2))) return false;
    }
    return true;
  }
  function gtaStreetRoute(world, car, aim) {
    return setStreetPatrolPath(world.pursuit, car, aim, null, car.gtaAI.lanes);
  }
  function gtaJunctionCommand(world, car) {
    const { pursuit: s } = world, ai = car.gtaAI;
    if (!isDispatchTracked(s.response) || s.wantedLevel < 3 || !["INTERCEPTOR", "FLANKER"].includes(car.squadRole) || car.aiState === "RECOVER" || (ai.commitUntil ?? 0) > world.tick) {
      ai.junctionRoute = null;
      return null;
    }
    const role = car.squadRole === "INTERCEPTOR" ? "BLOCK_INTERCEPT" : "FLANK";
    if (ai.junctionRoute && (ai.junctionRoute.role !== role || world.tick >= ai.junctionRoute.expires || !dispatchJunctionStillRelevant(ai.junctionRoute, s.response.lastSeen)))
      ai.junctionRoute = null;
    if (!ai.junctionRoute && world.tick >= (ai.nextJointCheck ?? 0)) {
      ai.nextJointCheck = world.tick + ticks2(0.35);
      const target = selectDispatchJunction(world.drivingRoads, car, s.response.lastSeen);
      if (target) {
        const path = planDistrictRoute(s.patrolMap, car, target.goal);
        if (path.length > 2)
          ai.junctionRoute = {
            ...target,
            path: Object.freeze(path.map((point2) => Object.freeze(point2))),
            cursor: 0,
            expires: world.tick + ticks2(Math.max(target.entryEta, target.egoEta) + 1.65)
          };
      }
    }
    const route = ai.junctionRoute;
    if (!route) return null;
    const { steer, targetSpeed, remaining, cursor } = followPath(car, route.path, route.cursor);
    route.cursor = cursor;
    if (remaining < 2) return null;
    car.aiState = route.role;
    return { steer, targetSpeed: Math.min(12.5, targetSpeed), reason: route.role };
  }
  function gtaDirectApproach(world, car, aim, requireClearLane = false) {
    const heading2 = headingTo3(car, aim);
    if (Math.abs(angleDelta(heading2, car.heading)) > 1.04) return false;
    const range = distance(car, aim);
    if (range < 0.45) return false;
    const horizon = Math.min(range, 18);
    const dx = Math.sin(heading2) * horizon, dz = Math.cos(heading2) * horizon;
    const blockers = requireClearLane ? world.actorIndex.near(car, horizon + 4).filter((other) => other !== car && other !== world.player) : [];
    for (let i = 1; i <= 5; i++) {
      const probe = { ...vehicleProbe(car, car.speed), x: car.x + dx * i / 5, z: car.z + dz * i / 5, heading: heading2 };
      if (!pointOnRoad(probe, world.drivingRoads, 0.75) || blockers.some((other) => overlaps(probe, other, 0.14))) return false;
    }
    return gtaLineClear(world, car, dx, dz, horizon);
  }
  function replanPolice(world, a) {
    const { player: ego, pursuit: s } = world, drive = a.pursuitDrive;
    if (usesRushPace(s.variant)) {
      const segment = a.path[Math.min(a.cursor + 13, a.path.length - 1)];
      const error = segment && Math.abs(angleDelta(headingTo3(a, segment), a.heading));
      if (s.response) {
        const sighted = s.response.sightedBy.has(a);
        const report = s.response.lastSeen ?? s.playerStart;
        const pack = isPackPursuit(s.variant);
        const searching = isRushPack(s.variant) ? s.response.unitsInContact === 0 : !sighted;
        const lost = drive.tracking && !sighted;
        const inSearch = searching && drive.searchReport && distance(report, drive.searchReport) < 6 && world.staticIndex === drive.searchMap && a.path.length > 1 && distance(a, a.path.at(-1)) > 6 && a.wait < 0.6;
        const hunt = isCityHunt(s.variant);
        if (!inSearch && (lost || !segment || error < 0.65 || a.wait > 0.6)) {
          const found = s.packLab && !searching ? true : planRushPatrol(world, s, a, null, report, searching);
          if (!found && (lost || hunt && a.wait > 0.8)) {
            a.path = [];
            a.cursor = 0;
            drive.target = null;
          }
          drive.searchReport = searching ? report : null;
          drive.searchMap = searching ? world.staticIndex : null;
          drive.tracking = sighted;
        }
      } else if (!segment || error < 0.65 || a.wait > 0.6) planRushPatrol(world, s, a);
      drive.nextPlan = world.tick + ticks2(isPackPursuit(s.variant) ? 0.48 + a.phase * 0.45 : 0.83 + a.phase * 0.52);
      return;
    }
    const dx = Math.sin(ego.heading), dz = Math.cos(ego.heading);
    const ahead = (metres) => ({ x: ego.x + dx * metres, z: ego.z + dz * metres });
    const speed = ego.speed;
    let target = ahead(speed * 0.6);
    if (drive.pattern === "intercept") target = ahead(clamp(7 + speed * 2.5, 3, 24));
    if (drive.pattern === "flank") {
      const projected = ahead(clamp(5 + speed * 1.4, 3, 16));
      target = s.junctions.reduce((best, point2) => {
        const score = (p) => distance(p, projected) + 0.42 * distance(a, p);
        return !best || score(point2) < score(best) ? point2 : best;
      }, null) ?? projected;
    }
    if (drive.pattern === "intercept" && distance(a, ego) < 10 && Math.cos(angleDelta(a.heading, ego.heading)) < -0.5) target = ahead(speed * 0.3);
    if (s.street) {
      s.patrolMap.statics = world.statics;
      setStreetPatrolPath(s, a, target);
      drive.nextPlan = world.tick + 60 + Math.floor(a.phase * 24);
      return;
    }
    target = safeRoadTarget(target, world.drivingRoads);
    const direct = distance(a, target) < 1 || straightApproach(world, a, target);
    a.path = direct ? [] : planNavigation(navigableGraph(world), a, target);
    a.cursor = 0;
    drive.target = target;
    drive.nextPlan = world.tick + 26 + Math.floor(a.phase * 17);
  }
  function steerToward(a, target) {
    const axle = a.spec?.wheelbase ?? VEHICLE.wheelbase;
    const rear = {
      x: a.x - Math.sin(a.heading) * axle / 2,
      z: a.z - Math.cos(a.heading) * axle / 2
    };
    const alpha = angleDelta(headingTo3(rear, target), a.heading);
    return Math.atan2(2 * axle * Math.sin(alpha), Math.max(1, distance(rear, target)));
  }
  function frontHazards(world, a, targetSpeed) {
    const sin = Math.sin(a.heading), cos = Math.cos(a.heading);
    const { variant, response } = world.pursuit;
    const police = a.pursuitRole === "police";
    let cap = targetSpeed, lead = null, blockedBy = null;
    for (const b of world.actorIndex.near(a, 21).concat(world.staticIndex.near(a, 23))) {
      if (b === a) continue;
      const target = b === world.player && police;
      if (target && isRushPack(variant)) continue;
      if (police && world.pursuit.survival && world.pursuit.patrols.has(b)) continue;
      if (target && !(response ? response.sightedBy.has(a) : variant === "rush")) continue;
      const measured2 = target && response ? response.lastSeen : b;
      const dx = measured2.x - a.x, dz = measured2.z - a.z;
      const front = dx * sin + dz * cos, side = dx * cos - dz * sin;
      const otherTurn = angleDelta(measured2.heading ?? 0, a.heading);
      const otherAlong = Math.cos(otherTurn) * (measured2.speed ?? 0);
      const otherLateral = Math.sin(otherTurn) * (measured2.speed ?? 0);
      const across = extent(b, cos, -sin);
      const lane2 = a.width / 2 + across + 0.32;
      const crossingAt = Math.abs(side) > lane2 && side * otherLateral < 0 ? (Math.abs(side) - lane2) / Math.abs(otherLateral) : 0;
      if (front < 0.1 || Math.abs(side) > lane2 && !(crossingAt > 0 && crossingAt < 1.4))
        continue;
      const gap = front - a.length / 2 - extent(b, sin, cos);
      if (crossingAt && gap > Math.max(3, a.speed) * (crossingAt + 1.1)) continue;
      const floor = b.type === "pedestrian" ? 1.7 : b === world.player && usesRushPace(variant) ? 1.4 : 0.8;
      const desired = Math.max(0, otherAlong + (gap - floor) / (b.type === "pedestrian" ? 2 : 1.35));
      if (desired < cap) {
        cap = desired;
        blockedBy = b.id;
        lead = b.type === "vehicle" && !crossingAt && Math.abs(otherTurn) < 0.45 && gap < 12 ? b : null;
      }
    }
    return { cap, lead, blockedBy };
  }
  function ramApproach(world, car) {
    const state = world.pursuit, { sightedBy, lastSeen } = state.response;
    if (!sightedBy.has(car)) return null;
    const range = distance(car, lastSeen);
    if (range > 32) return null;
    const lead = lastSeen.speed * clamp(range / (car.speed + 14), 0, 0.65);
    const projected = {
      x: lastSeen.x + Math.sin(lastSeen.heading) * lead,
      z: lastSeen.z + Math.cos(lastSeen.heading) * lead
    };
    const pack = isPackPursuit(state.variant);
    if (pack && world.tick < car.pursuitDrive.openingUntil) return null;
    const packAim = pack ? packRamAim({
      car,
      report: lastSeen,
      order: car.pursuitDrive.packOrder,
      tick: world.tick,
      startedTick: state.startedTick
    }) : null;
    const targets = pack ? packAim ? [packAim] : [] : lead ? [projected, lastSeen] : [lastSeen];
    for (const aim of targets) {
      const heading2 = headingTo3(car, aim);
      if (Math.abs(angleDelta(heading2, car.heading)) > (pack ? 0.9 : 0.58)) continue;
      const step = Math.min(1, 12 / Math.max(1, distance(car, aim))) / 3;
      if ([1, 2, 3].every((i) => bodyOnRoad(
        { ...car, ...interpolate(car, aim, i * step), heading: heading2 },
        world.drivingRoads,
        0.12
      ))) return { steer: steerToward(car, aim), speed: packAim?.speed ?? Infinity };
    }
    return null;
  }
  function repositionHuntPatrol(world, car) {
    const { pursuit } = world, { response } = pursuit;
    const sighted = response.sightedBy.has(car);
    if (car.wait < 0.7 && car.speed >= 0) return null;
    const nearby = world.actorIndex.near(car, 10).filter((actor) => actor !== car && (actor !== world.player || sighted)).concat(world.staticIndex.near(car, 22));
    const target = response.lastSeen ?? pursuit.playerStart;
    const facing = Math.sign(angleDelta(headingTo3(car, target), car.heading));
    for (const steer of [-facing * 0.5, 0, facing * 0.5]) {
      const command = { steer, targetSpeed: -1.8, reason: "police-reposition" };
      let pose5 = car;
      for (let i = 0; i < 8; i++) {
        const next = integrateVehicle(pose5, command, 0.125);
        if (!sweepSafe(pose5, next, nearby, world.drivingRoads).safe) break;
        pose5 = next;
      }
      if (distance(pose5, car) > 0.85) return command;
    }
    return null;
  }
  function shiftedTarget(a, path, shift2) {
    const start = path[a.cursor], end = path[Math.min(path.length - 1, a.cursor + 11)];
    if (!start || !end || distance(start, end) < 1.8) return null;
    const heading2 = headingTo3(start, end);
    if (Math.abs(angleDelta(heading2, a.heading)) > 0.31) return null;
    return { x: end.x + Math.cos(heading2) * shift2, z: end.z - Math.sin(heading2) * shift2, heading: heading2 };
  }
  function updateLane(world, a, lead) {
    const drive = a.pursuitDrive, now2 = world.tick;
    if (now2 >= drive.laneUntil) drive.laneBiasM = 0;
    if (!lead || now2 < drive.laneProbeAt || drive.laneBiasM) return;
    drive.laneProbeAt = now2 + 30;
    const close = world.actorIndex.near(a, 18).filter((b) => b !== a).concat(world.staticIndex.near(a, 19));
    const side = a.phase < 0.5 ? -1 : 1;
    for (const shift2 of [side * 2.85, -side * 2.85]) {
      const target = shiftedTarget(a, a.path, shift2);
      if (!target) continue;
      const next = { ...a, ...target };
      if (sweepSafe(a, next, close, world.drivingRoads).safe) {
        drive.laneBiasM = shift2;
        drive.laneUntil = now2 + ticks2(2.6);
        return;
      }
    }
  }
  function patrolHasSupport(world, patrol2) {
    return world.actorIndex.near(world.player, 11.2).some((a) => a !== patrol2 && a.pursuitRole === "police");
  }
  function patrolReassessment(world, a) {
    const { player: ego, tick } = world, drive = a.pursuitDrive;
    const reaction = drive.reaction;
    if (!reaction) return null;
    const sin = Math.sin(a.heading), cos = Math.cos(a.heading);
    const dx = ego.x - a.x, dz = ego.z - a.z;
    const ahead = dx * sin + dz * cos;
    const gap = ahead - a.length / 2 - extent(ego, sin, cos);
    const aligned = ahead > a.length / 2 && Math.abs(dx * cos - dz * sin) < a.width / 2 + extent(ego, cos, -sin) + 0.8;
    if (patrolHasSupport(world, a) || !aligned || gap > 4.2) {
      drive.reaction = null;
      drive.nextPlan = tick;
      return null;
    }
    const hold = { steer: 0, targetSpeed: 0, reason: "patrol-reassess" };
    if (tick < reaction.settleUntil) return hold;
    const retreat = 1.35 - distance(a, reaction);
    if (tick < reaction.backUntil && gap < 2.05 && retreat > 0) {
      const body = {
        ...a,
        x: a.x - sin * retreat,
        z: a.z - cos * retreat
      };
      const obstacles = world.actorIndex.near(a, 9).filter((b) => b !== a && b !== ego).concat(world.staticIndex.near(a, 11));
      const clear = sweepSafe(a, body, obstacles, world.drivingRoads);
      if (!clear.safe) return { ...hold, blockedBy: clear.actor ?? null };
      return {
        steer: 0,
        targetSpeed: -Math.min(1.3, Math.sqrt(4 * retreat)),
        reason: "patrol-backoff"
      };
    }
    if (a.speed < 0) return hold;
    const aheadSpeed = ego.speed * Math.cos(angleDelta(ego.heading, a.heading));
    const threat = frontHazards(world, a, clamp(aheadSpeed + (gap - 1.12) / 1.3, 0, drive.cruise));
    return { steer: steerToward(a, ego), targetSpeed: threat.cap, blockedBy: threat.blockedBy, reason: hold.reason };
  }
  function npcCommand(world, a) {
    const drive = a.pursuitDrive;
    if (!drive || drive.pattern === "parked") return { steer: 0, targetSpeed: 0, reason: "holding" };
    const police = a.pursuitRole === "police";
    const response = world.pursuit.response;
    const pack = police && isPackPursuit(world.pursuit.variant);
    const arcade = police && isRushPack(world.pursuit.variant);
    const reaction = police && !world.pursuit.street && patrolReassessment(world, a);
    if (reaction) return reaction;
    if (police && (world.tick >= drive.nextPlan || drive.tracking && !response?.sightedBy.has(a)))
      replanPolice(world, a);
    let steer, speed;
    const ram = arcade ? ramApproach(world, a) : null;
    if (ram) {
      steer = ram.steer;
      const curvature = Math.abs(Math.tan(steer)) / VEHICLE.wheelbase;
      speed = Math.min(drive.cruise, ram.speed, Math.sqrt((pack ? 5.2 : 4.2) / Math.max(6e-3, curvature)));
    } else if (a.path.length > 1) {
      const path = followPath(a, a.path, a.cursor);
      a.cursor = path.cursor;
      steer = path.steer;
      speed = Math.min(drive.cruise, path.targetSpeed * (arcade ? 1.22 : 1));
    } else {
      if (response && police) {
        if (isCityHunt(world.pursuit.variant) && world.pursuit.street) {
          const reposition = repositionHuntPatrol(world, a);
          if (reposition) return reposition;
        }
        if (pack && world.pursuit.packLab && response.sightedBy.has(a)) {
          const target2 = response.lastSeen;
          const heading2 = headingTo3(a, target2);
          return {
            steer: steerToward(a, target2),
            targetSpeed: Math.min(drive.cruise, 4.5),
            reason: Math.abs(angleDelta(heading2, a.heading)) > 0.9 ? "police-turn" : "police-pack"
          };
        }
        return { steer: 0, targetSpeed: 0, reason: "patrol-reassess" };
      }
      const target = drive.target;
      steer = steerToward(a, target);
      const remaining = distance(a, target);
      const error = Math.abs(angleDelta(headingTo3(a, target), a.heading));
      speed = Math.min(drive.cruise, 7.5 / (1 + Math.abs(steer)), Math.sqrt(5 * Math.max(0, remaining - 0.75)));
      if (error > 1.4) speed = Math.min(speed, 1.4);
      if (police && drive.pattern === "tail" && error < 0.8) {
        speed = Math.min(drive.cruise, Math.max(speed, Math.abs(world.player.speed) + 1.7));
      }
    }
    if (world.tick < drive.launchUntil) speed = Math.min(speed, 5);
    if (world.tick < drive.openingUntil) speed = Math.min(speed, 4.6);
    if (world.tick < drive.paceUntil) speed = Math.min(speed, drive.paceMps);
    const threat = frontHazards(world, a, speed);
    if (!police && a.path.length > 1) {
      updateLane(world, a, threat.lead);
      const target = drive.laneBiasM && shiftedTarget(a, a.path, drive.laneBiasM);
      if (target) steer = steerToward(a, target);
    }
    return {
      steer,
      targetSpeed: threat.cap,
      blockedBy: threat.blockedBy,
      reason: threat.cap < speed - 0.1 ? "yielding" : world.tick < drive.paceUntil ? "congested" : ram ? "police-ram" : police ? `police-${drive.pattern}` : drive.laneBiasM ? "lane-change" : "traffic"
    };
  }
  function shapeRadius(a) {
    return a.type === "pedestrian" ? a.radius : Math.hypot(a.length, a.width) / 2;
  }
  function extent(a, x, z) {
    if (a.type === "pedestrian") return a.radius;
    const cos = Math.cos(a.heading ?? 0), sin = Math.sin(a.heading ?? 0);
    return Math.abs(x * sin + z * cos) * a.length / 2 + Math.abs(x * cos - z * sin) * a.width / 2;
  }
  function travel(before, after, radius = shapeRadius(before)) {
    return distance(before, after) + Math.abs(angleDelta(after.heading, before.heading)) * radius;
  }
  function poseAt(p, t, footprint) {
    if (t <= 0) return p.a;
    if (!p.travel) return p.next;
    const time = Math.min(t, p.stop);
    if (time === 1) return p.next;
    if (footprint) {
      footprint.type = p.next.type;
      footprint.width = p.next.width;
      footprint.length = p.next.length;
      footprint.radius = p.next.radius;
    }
    return interpolate(p.a, p.next, time, footprint);
  }
  function findContact(a, b, since, probes) {
    if ((a.stop <= since || !a.travel) && (b.stop <= since || !b.travel)) return null;
    const maxTravel = a.travel + b.travel;
    if (distance(a.a, b.a) > a.radius + b.radius + maxTravel) return null;
    const occupied = (t) => overlaps(poseAt(a, t, probes?.[0]), poseAt(b, t, probes?.[1]));
    const steps = Math.max(1, Math.ceil(maxTravel * (1 - since) / 0.035));
    for (let i = 1; i <= steps; i++) {
      let high = since + (1 - since) * i / steps;
      if (!occupied(high)) continue;
      let low = since + (1 - since) * (i - 1) / steps;
      for (let j = 0; j < 28; j++) {
        const mid = (low + high) / 2;
        if (occupied(mid)) high = mid;
        else low = mid;
      }
      return { a, b, time: low, overlapAt: high };
    }
    return null;
  }
  function normalAt(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const axes = [];
    for (const actor of [a, b]) {
      if (actor.type === "pedestrian") continue;
      axes.push(actor.heading, actor.heading + Math.PI / 2);
      if ([a, b].some((body) => body.type === "pedestrian"))
        axes.push(...corners(actor).map((p) => headingTo3(p, actor === a ? b : a)));
    }
    if (!axes.length) axes.push(Math.atan2(dx, dz));
    let normal2 = null, bestGap = -Infinity;
    for (const h of axes) {
      const x = Math.sin(h), z = Math.cos(h);
      const separation = dx * x + dz * z;
      const gap = Math.abs(separation) - extent(a, x, z) - extent(b, x, z);
      if (gap > bestGap) {
        const sign = separation < 0 ? -1 : 1;
        bestGap = gap;
        normal2 = { x: x * sign, z: z * sign };
      }
    }
    return normal2;
  }
  function closingSpeed(a, b, t, normal2) {
    const earlier = Math.max(0, t - 0.1);
    const gap = (at) => {
      const p = poseAt(a, at), q = poseAt(b, at);
      const { x, z } = normal2;
      return (q.x - p.x) * x + (q.z - p.z) * z - extent(p, x, z) - extent(q, x, z);
    };
    return (gap(earlier) - gap(t)) / (Math.max(1e-8, t - earlier) * STEP);
  }
  function contactImpact(ego, other, time, overlapAt, tick) {
    const a = poseAt(ego, time), b = poseAt(other, time), normal2 = normalAt(a, b);
    const front = normal2.x * Math.sin(a.heading) + normal2.z * Math.cos(a.heading);
    const right = normal2.x * Math.cos(a.heading) - normal2.z * Math.sin(a.heading);
    const side = Math.abs(front) >= Math.abs(right) ? front > 0 ? "front" : "rear" : right > 0 ? "right" : "left";
    const closingSpeedMps = Math.max(0, closingSpeed(ego, other, overlapAt, normal2));
    const mass2 = PLAYER_VEHICLE.massKg;
    const otherMass = b.type === "pedestrian" ? other.a.body?.massKg ?? 75 : b.type === "vehicle" ? b.kind === "tuktuk" ? 620 : 1450 : Infinity;
    const effectiveMass = b.type === "static" ? mass2 : mass2 * otherMass / (mass2 + otherMass);
    const energyJ = 0.5 * effectiveMass * closingSpeedMps ** 2;
    return { actorId: b.id, side, closingSpeedMps, energyJ, severity: clamp(energyJ / 42e3, 0, 1), tick, x: a.x, z: a.z };
  }
  var pairId = (a, b) => [a.id, b.id].sort().join(":");
  var CONTACT_CELL_M = 8;
  var staticContactGrids = /* @__PURE__ */ new WeakMap();
  var contactOrder = (a, b) => a - b;
  function sweptContactBounds({ a, next, radius }) {
    const circle = a.type === "pedestrian";
    const sin = Math.abs(Math.sin(a.heading ?? 0)), cos = Math.abs(Math.cos(a.heading ?? 0));
    const pad = 0.24 + (circle ? 0 : radius * Math.abs(angleDelta(next.heading ?? 0, a.heading ?? 0)));
    const x = pad + (circle ? radius : (a.width * cos + a.length * sin) / 2);
    const z = pad + (circle ? radius : (a.length * cos + a.width * sin) / 2);
    return [
      Math.min(a.x, next.x) - x,
      Math.max(a.x, next.x) + x,
      Math.min(a.z, next.z) - z,
      Math.max(a.z, next.z) + z
    ];
  }
  function contactCellSpan(box3) {
    return box3.map((edge) => Math.floor(edge / CONTACT_CELL_M));
  }
  function indexContactSpan(cells, [left, right, bottom, top], i) {
    for (let x = left; x <= right; x++) {
      let row = cells.get(x);
      if (!row) cells.set(x, row = /* @__PURE__ */ new Map());
      for (let z = bottom; z <= top; z++) {
        const bucket = row.get(z);
        if (bucket) bucket.push(i);
        else row.set(z, [i]);
      }
    }
  }
  function staticContactPlan(a) {
    return { a, next: a, travel: 0, stop: 0, radius: shapeRadius(a) };
  }
  function dispatchStaticContacts(world) {
    const { statics } = world;
    const last = staticContactGrids.get(world);
    if (last?.entries.length === statics.length && statics.every((a, i) => {
      const p = last.entries[i];
      return a.type === "static" && p.a === a && p.x === a.x && p.z === a.z && p.heading === a.heading && p.width === a.width && p.length === a.length;
    })) return last;
    if (statics.some((a) => a.type !== "static")) return null;
    const plans = statics.map(staticContactPlan);
    const bounds = plans.map(sweptContactBounds), cells = /* @__PURE__ */ new Map();
    for (let i = 0; i < bounds.length; i++) indexContactSpan(cells, contactCellSpan(bounds[i]), i);
    const entries = statics.map(({ x, z, heading: heading2, width, length }, i) => ({ a: statics[i], x, z, heading: heading2, width, length }));
    const next = { plans, bounds, cells, entries };
    staticContactGrids.set(world, next);
    return next;
  }
  function dispatchStreetContactPairs(moving, solids) {
    const bounds = moving.map(sweptContactBounds), spans = bounds.map(contactCellSpan), cells = /* @__PURE__ */ new Map();
    for (let i = 0; i < spans.length; i++) indexContactSpan(cells, spans[i], i);
    const n = moving.length, marked = new Uint32Array(n + solids.plans.length);
    const pairs = [], candidates2 = [];
    for (let i = 0; i < n; i++) {
      const [left, right, bottom, top] = spans[i], a = moving[i], own = bounds[i], stamp = i + 1;
      candidates2.length = 0;
      for (let x = left; x <= right; x++) {
        const row = cells.get(x), staticRow = solids.cells.get(x);
        for (let z = bottom; z <= top; z++) {
          const local2 = row?.get(z);
          if (local2) {
            for (const j of local2) if (j > i && marked[j] !== stamp) {
              marked[j] = stamp;
              candidates2.push(j);
            }
          }
          const fixed = a.travel ? staticRow?.get(z) : void 0;
          if (fixed) for (const index of fixed) {
            const j = n + index;
            if (marked[j] === stamp) continue;
            marked[j] = stamp;
            candidates2.push(j);
          }
        }
      }
      candidates2.sort(contactOrder);
      for (const j of candidates2) {
        const b = j < n ? moving[j] : solids.plans[j - n];
        if (!a.travel && !b.travel) continue;
        const other = j < n ? bounds[j] : solids.bounds[j - n];
        if (own[0] > other[1] || own[1] < other[0] || own[2] > other[3] || own[3] < other[2]) continue;
        if (distance(a.a, b.a) <= a.radius + b.radius + a.travel + b.travel + 0.24) pairs.push([a, b]);
      }
    }
    return pairs;
  }
  function streetContactPairs(moving, solid, dispatch) {
    const cells = /* @__PURE__ */ new Map(), cellSize = CONTACT_CELL_M;
    const bounds = (body) => {
      const reach = body.radius + body.travel + 0.24;
      return [
        Math.floor((body.a.x - reach) / cellSize),
        Math.floor((body.a.x + reach) / cellSize),
        Math.floor((body.a.z - reach) / cellSize),
        Math.floor((body.a.z + reach) / cellSize)
      ];
    };
    const bodies = moving.concat(solid);
    const swept = dispatch ? bodies.map(sweptContactBounds) : null;
    const spans = swept ? swept.map((box3) => box3.map((edge) => Math.floor(edge / cellSize))) : bodies.map(bounds);
    for (let i = 0; i < bodies.length; i++) {
      const [left, right, bottom, top] = spans[i];
      for (let x = left; x <= right; x++) for (let z = bottom; z <= top; z++) {
        const key3 = `${x},${z}`;
        const bucket = cells.get(key3);
        if (bucket) bucket.push(i);
        else cells.set(key3, [i]);
      }
    }
    const pairs = [];
    for (let i = 0; i < moving.length; i++) {
      const [left, right, bottom, top] = spans[i];
      const a = bodies[i], candidates2 = /* @__PURE__ */ new Set();
      for (let x = left; x <= right; x++) for (let z = bottom; z <= top; z++)
        for (const j of cells.get(`${x},${z}`) ?? [])
          if (j > i) candidates2.add(j);
      for (const j of [...candidates2].sort((a2, b) => a2 - b)) {
        const b = bodies[j];
        if (swept) {
          const [minX, maxX, minZ, maxZ] = swept[i], other = swept[j];
          if (minX > other[1] || maxX < other[0] || minZ > other[3] || maxZ < other[2]) continue;
        }
        if (distance(a.a, b.a) <= a.radius + b.radius + a.travel + b.travel + 0.24)
          pairs.push([a, b]);
      }
    }
    return pairs;
  }
  function resolveContacts(world, moving, solid, staticGrid, freshImpacts) {
    const s = world.pursuit, pairs = staticGrid ? dispatchStreetContactPairs(moving, staticGrid) : s.street ? streetContactPairs(moving, solid, s.response?.dispatch) : [];
    const gtaPairs = s.gta ? /* @__PURE__ */ new Set() : null;
    const probes = s.response?.dispatch ? [{}, {}] : null;
    if (!s.street) for (const [i, a] of moving.entries()) {
      for (const b of [...moving.slice(i + 1), ...solid]) {
        if (distance(a.a, b.a) <= a.radius + b.radius + a.travel + b.travel + 0.24)
          pairs.push([a, b]);
      }
    }
    let since = 0, playerHit = null;
    for (let n = 0; n < moving.length; n++) {
      let hit = null;
      for (const [a2, b2] of pairs) {
        if (a2.erased || b2.erased || survivalGhostPair(world, a2.a, b2.a)) continue;
        if (!staticGrid && gtaPairs?.has(pairId(a2.a, b2.a))) continue;
        const found = findContact(a2, b2, since, probes);
        if (found && (!hit || found.time < hit.time) && (!staticGrid || !gtaPairs?.size || !gtaPairs.has(pairId(a2.a, b2.a)))) hit = found;
      }
      if (!hit) break;
      const { a, b, time, overlapAt } = hit;
      const key3 = pairId(a.a, b.a);
      const fresh = !s.contacts.has(key3);
      if (gtaPairs) {
        gtaPairs.add(key3);
        const pa = poseAt(a, time), pb = poseAt(b, time), normal2 = normalAt(pa, pb);
        applyGtaContact(world, a, b, pa, pb, normal2, closingSpeed(a, b, overlapAt, normal2), fresh);
      }
      if (a.a === world.player || b.a === world.player) {
        const [ego, other] = a.a === world.player ? [a, b] : [b, a];
        if (s.survival?.active?.kind === "giant" && (s.patrols.has(other.a) || s.survival.wrecks.has(other.a))) {
          other.stop = time;
          other.erased = true;
          s.survival.pendingWrecks.set(other.a, { reason: "giant", erased: true });
          continue;
        }
        const impact = contactImpact(ego, other, time, overlapAt, world.tick + 1);
        if (!playerHit || impact.severity > playerHit.severity) playerHit = impact;
        if (fresh) {
          freshImpacts?.push(impact);
          const pack = isPackPursuit(s.variant), pedestrian = other.a.type === "pedestrian";
          if (!pack || !s.metrics.terminalCause || pedestrian && s.metrics.terminalCause !== "pedestrian-impact")
            s.metrics.impact = impact;
          s.metrics.collisions++;
          if (pedestrian) s.metrics.pedestrianCollisions++;
          if (pack) {
            if (pedestrian) {
              const person = poseAt(other, time), origin = poseAt(ego, time);
              other.a.impact = {
                tick: impact.tick,
                heading: headingTo3(origin, person),
                closingSpeedMps: impact.closingSpeedMps,
                sourceId: world.player.id
              };
              s.metrics.pedestrianStatus = "impact";
              s.metrics.terminalCause = "pedestrian-impact";
              const cost = isCityHunt(s.variant) ? pedestrianImpactCost(impact.closingSpeedMps) : PACK_PENALTIES.pedestrian;
              s.metrics.penalty -= cost;
              if (isCityHunt(s.variant)) s.metrics.pedestrianCost += cost;
            } else if (s.patrols.has(other.a)) {
              s.metrics.policeContacts++;
              s.metrics.terminalCause ??= "police-touch";
              s.metrics.penalty -= PACK_PENALTIES.police;
            } else if (s.survival) {
              s.metrics.terminalCause ??= s.survival.wrecks.has(other.a) ? "police-wreck" : other.a.type === "static" ? "street-obstacle" : "traffic-contact";
              s.metrics.penalty -= PACK_PENALTIES.police;
            }
          }
          if (s.survival && s.metrics.terminalCause && !s.survival.contactAt) {
            const body = poseAt(ego, time);
            const normal2 = normalAt(body, poseAt(other, time));
            const reach = extent(body, normal2.x, normal2.z) + 0.08;
            s.survival.contactAt = { x: body.x + normal2.x * reach, z: body.z + normal2.z * reach };
          }
          logEvent(world, "impact", impact, impact.actorId, impact.tick);
          const patrol2 = other.a;
          if (!s.street && impact.side === "rear" && impact.closingSpeedMps > 0.2 && patrol2.pursuitRole === "police" && patrol2.speed > 0.2 && other.stop > time && !patrolHasSupport(world, patrol2)) {
            const hitPose = poseAt(other, time);
            patrol2.pursuitDrive.reaction = {
              x: hitPose.x,
              z: hitPose.z,
              settleUntil: impact.tick + ticks2(0.16),
              backUntil: impact.tick + ticks2(1.7)
            };
          }
        }
      } else if (fresh) {
        s.metrics.trafficCollisions++;
        if (s.survival) {
          const normal2 = normalAt(poseAt(a, time), poseAt(b, time));
          if (closingSpeed(a, b, overlapAt, normal2) >= 2.6) {
            for (const [current, other] of [[a, b], [b, a]]) if (s.patrols.has(current.a))
              s.survival.pendingWrecks.set(current.a, { reason: s.patrols.has(other.a) ? "patrol" : other.a.kind ?? "contact" });
          }
        }
      }
      s.contacts.add(key3);
      if (a.travel && a.stop > time) {
        a.stop = time;
        a.hit = b.a.id;
      }
      if (b.travel && b.stop > time) {
        b.stop = time;
        b.hit = a.a.id;
      }
      if (a.a.type !== "static" && !a.hit) a.hit = b.a.id;
      if (b.a.type !== "static" && !b.hit) b.hit = a.a.id;
      since = time;
    }
    return playerHit;
  }
  function updateClearance(world, playerMotion, bodies) {
    const s = world.pursuit, near = /* @__PURE__ */ new Set(), touching = /* @__PURE__ */ new Set();
    const ego = poseAt(playerMotion, 1);
    for (const body of bodies) {
      if (s.street && distance(ego, body.a) > playerMotion.radius + body.radius + body.travel + 0.72) continue;
      const other = poseAt(body, 1);
      if (other.id === ego.id || body.erased || survivalGhostPair(world, world.player, body.a)) continue;
      const key3 = pairId(ego, other);
      if (overlaps(ego, other, 0.25)) touching.add(key3);
      if (s.contacts.has(key3) || !overlaps(ego, other, 0.72)) continue;
      const normal2 = normalAt(ego, other);
      const minDist = s.gta ? Math.max(0, (other.x - ego.x) * normal2.x + (other.z - ego.z) * normal2.z - extent(ego, normal2.x, normal2.z) - extent(other, normal2.x, normal2.z)) : 0;
      const approach2 = s.gta ? (distance(poseAt(playerMotion, 0.9), poseAt(body, 0.9)) - distance(ego, other)) / (0.1 * STEP) : closingSpeed(playerMotion, body, 1, normal2);
      const entered = !s.near.has(key3) && approach2 > 0.6 && (!s.gta || minDist <= 0.72);
      if (!s.gta || entered || s.near.has(key3)) near.add(key3);
      if (entered) {
        s.metrics.nearCollisions++;
        logEvent(world, "near", ego, other.id, world.tick + 1);
        if (s.gta) emitGtaEvent(world, "near_miss", {
          actorKind: body.a.aiState === "WRECKED" ? "wrecked" : body.a.unitType ?? (other.gtaRoadblock ? "roadblock" : other.kind ?? other.type),
          minDist,
          ...s.response.dispatch ? { actorId: body.a.id, actorType: body.a.type, approachMps: approach2 } : {}
        });
      }
    }
    for (const key3 of s.contacts) {
      if (touching.has(key3)) continue;
      const [a, b] = key3.split(":");
      const p = bodies.find((body) => body.a.id === a), q = bodies.find((body) => body.a.id === b);
      if (!p || !q || !overlaps(poseAt(p, 1), poseAt(q, 1), 0.25)) s.contacts.delete(key3);
    }
    s.near = near;
  }
  function motionPlan(world, actor, action, streetHooks) {
    let next, command, sweptTravel, guard = "clear";
    const radius = shapeRadius(actor);
    if (actor.type === "pedestrian")
      next = streetHooks ? streetHooks.pedestrianMotion(actor) : pedestrianMotion(world, actor);
    else {
      const pack = isPackPursuit(world.pursuit.variant);
      const survival = world.pursuit.survival;
      const gta = world.pursuit.gta && (actor === world.player || world.pursuit.patrols.has(actor));
      if (survival?.wrecks.has(actor) || gta && isGtaStationary(actor)) return {
        a: actor,
        next: actor,
        command: { steer: 0, targetSpeed: 0 },
        guard,
        travel: 0,
        radius,
        stop: 0,
        hit: null
      };
      command = actor === world.player ? (pack ? packCommand : pursuitCommand)(actor, action, STEP) : gta ? world.pursuit.response.dispatch && gtaJunctionCommand(world, actor) || gtaPatrolCommand(world, actor, gtaStreetRoute, gtaDirectApproach, gtaSpacingSteer(actor, world.pursuit.patrols)) : !streetHooks || world.pursuit.patrols.has(actor) ? npcCommand(world, actor) : null;
      if (survival && actor === world.player && world.mode === "manual") command.arcadeDrift = true;
      if (streetHooks) command = streetHooks.vehicleCommand(actor, command);
      else if (pack && actor === world.player) command = world.safeSpeed(actor, command, false);
      if (actor !== world.player && world.pursuit.response?.dispatch) {
        const preview = !gta && world.pursuit.gta.config.civilianCrossingPreview;
        if (gta || preview) command = dispatchPedestrianYield(world, actor, command, preview);
        if (gta && world.pursuit.gta.config.patrolTrafficPreview) command = dispatchPatrolTrafficYield(world, actor, command);
      }
      const pose5 = usesRushPace(world.pursuit.variant) ? Object.assign(vehicleProbe(actor, actor.speed), {
        id: actor.id,
        kind: actor.kind,
        y: actor.y,
        supportHeightM: actor.supportHeightM
      }) : null;
      next = integrateVehicle(actor, command, STEP, pose5);
      if (gta) integrateGtaSlip(actor, next);
      next.reason = command.reason ?? "driving";
      next.blockedBy = command.blockedBy ?? null;
      const roads = streetHooks || actor === world.player ? world.roads : world.drivingRoads;
      sweptTravel = travel(actor, next, radius);
      if (sweptTravel > 0 && !sweepSafe(actor, next, [], roads).safe) {
        guard = "road-boundary";
        sweptTravel = 0;
        next = {
          ...actor,
          speed: 0,
          steer: next.steer,
          reason: guard,
          blockedBy: null,
          ...gta ? { gtaSlipMps: 0, gtaYawRate: 0 } : {}
        };
      }
    }
    return { a: actor, next, command, guard, travel: sweptTravel ?? travel(actor, next, radius), radius, stop: 1, hit: null };
  }
  function dispatchPedestrianYield(world, car, command, civilianPreview) {
    const { targetSpeed } = command;
    if (!targetSpeed || civilianPreview && targetSpeed < 0) return command;
    const braking = car.spec?.braking ?? VEHICLE.braking;
    const deceleration = Math.min(braking, 6);
    const speed = Math.abs(car.speed) + 0.12 * (car.spec?.acceleration ?? VEHICLE.acceleration);
    const reach = car.length / 2 + speed * 0.12 + speed ** 2 / (2 * deceleration) + 2.5;
    const walkers = world.actorIndex.near(car, reach).filter((body) => body.type === "pedestrian" && (!civilianPreview || body.speed > 0.2 && (civilianPreview !== true || body.crossing)) && gtaLineClear(world, car, body.x - car.x, body.z - car.z, distance(car, body)));
    if (!walkers.length) return command;
    const stride = 0.1, horizon = 0.2 + speed / deceleration;
    const probe = vehicleProbe(car, car.speed);
    const slow = { steer: command.steer, targetSpeed: 0, decelerationMps2: deceleration };
    for (let t = stride; t <= horizon; t += stride) {
      integrateVehicle(probe, t <= 0.12 ? command : slow, stride, probe);
      for (const person of walkers) {
        const time = Math.min(t, 1.2);
        const dx = Math.sin(person.heading) * person.speed * time;
        const dz = Math.cos(person.heading) * person.speed * time;
        for (const fraction of [0, 0.5, 1]) {
          const possible = {
            type: "pedestrian",
            radius: person.radius,
            x: person.x + fraction * dx,
            z: person.z + fraction * dz
          };
          if (overlaps(probe, possible, 0.42))
            return { ...command, targetSpeed: 0, reason: "pedestrian-yield", blockedBy: person.id };
        }
      }
    }
    return command;
  }
  function dispatchPatrolTrafficYield(world, car, command) {
    if (command.targetSpeed <= 0 || car.speed < 0) return command;
    const { pursuit } = world, braking = car.spec?.braking ?? VEHICLE.braking;
    const reactionTicks = 21, reactionS = reactionTicks * STEP;
    const speed = Math.max(car.speed, Math.min(
      command.targetSpeed,
      car.speed + reactionS * (car.spec?.acceleration ?? VEHICLE.acceleration)
    ));
    const reach = speed * reactionS + speed ** 2 / (2 * braking) + Math.abs(car.gtaSlipMps) / 3 + 10;
    const blockers = [];
    for (const other of world.actorIndex.near(car, reach)) {
      if (other === world.player || other.type !== "vehicle" || pursuit.patrols.has(other) || gtaLocal(car, other).forward <= 0 || !gtaLineClear(world, car, other.x - car.x, other.z - car.z, distance(car, other))) continue;
      blockers.push({
        body: other,
        dx: Math.sin(other.heading) * other.speed,
        dz: Math.cos(other.heading) * other.speed,
        pose: vehicleProbe(other, other.speed)
      });
    }
    if (!blockers.length) return command;
    const clearanceM = 0.55;
    const project2 = (steer, delay, roads) => {
      const brake = { steer, targetSpeed: 0 };
      const limit = delay + Math.ceil(speed / (braking * STEP)) + 6;
      let pose5 = { ...vehicleProbe(car, car.speed), gtaYawRate: car.gtaYawRate, gtaSlipMps: car.gtaSlipMps };
      let next = { ...pose5 };
      for (let i = 0; i < limit; i++) {
        integrateVehicle(pose5, i < delay ? command : brake, STEP, next);
        integrateGtaSlip(pose5, next);
        if (roads && !sweepSafe(pose5, next, [], roads).safe) return { tick: i };
        const time = Math.min(0.65, (i + 1) * STEP);
        for (const { body, dx, dz, pose: other } of blockers) {
          other.x = body.x + dx * time;
          other.z = body.z + dz * time;
          if (overlaps(next, other, clearanceM)) return { body, tick: i };
        }
        if (i >= delay && next.speed <= 0 && Math.abs(next.gtaSlipMps) < 0.02 && Math.abs(next.gtaYawRate) < 0.02) return null;
        [pose5, next] = [next, pose5];
      }
      return null;
    };
    const conflict = project2(command.steer, reactionTicks);
    if (!conflict) return command;
    const sides = gtaLocal(car, conflict.body).right < 0 ? 1 : -1;
    let best = { steer: command.steer, safeTicks: -1 };
    for (const steer of [command.steer, 0, sides * 0.2, -sides * 0.2]) {
      const blocked = project2(steer, 0, world.roads);
      if (!blocked) {
        best = { steer, safeTicks: Infinity };
        break;
      }
      if (blocked.tick > best.safeTicks) best = { steer, safeTicks: blocked.tick };
    }
    return { ...command, steer: best.steer, targetSpeed: 0, reason: "traffic-yield", blockedBy: conflict.body.id };
  }
  function approachingPedestrianDanger(world, car) {
    const speed = Math.abs(car.speed);
    if (speed < 1.4 || speed < Math.abs(car.previous.speed) - 0.01) return 0;
    const direction3 = Math.sign(car.speed);
    const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
    const brakingRoom = 0.8 + speed * 0.24 + speed ** 2 / 11;
    let danger = 0;
    for (const person of world.actorIndex.near(car, car.length / 2 + brakingRoom + 2)) {
      if (person.type !== "pedestrian") continue;
      const dx = person.x - car.x, dz = person.z - car.z;
      const gap = (dx * sin + dz * cos) * direction3 - car.length / 2 - person.radius;
      if (gap < -0.15 || gap > brakingRoom) continue;
      const side = dx * cos - dz * sin;
      const lateralPace = Math.sin(person.heading - car.heading) * person.speed;
      const predictedSide = side + lateralPace * Math.min(0.9, Math.max(0, gap / speed));
      if (side * predictedSide > 0 && Math.min(Math.abs(side), Math.abs(predictedSide)) > car.width / 2 + person.radius + 0.22) continue;
      danger = Math.max(danger, 1 - Math.max(0, gap) / brakingRoom);
    }
    return danger * STEP;
  }
  function updatePhase(world, moved, playerHit) {
    const { player: ego, pursuit: s } = world, m = s.metrics;
    const r = s.response;
    if (r) {
      const event2 = updatePursuitResponse(world);
      if (event2) logEvent(world, event2, r.lastSeen ?? s.playerStart);
    }
    if (s.gta) {
      updateGtaPhase(world);
      return;
    }
    if (isPackPursuit(s.variant)) {
      const nearSectors = /* @__PURE__ */ new Set();
      for (const car of r.sightedBy) if (distance(car, ego) <= 22) {
        const angle = angleDelta(headingTo3(ego, car), ego.heading);
        nearSectors.add(Math.round(angle / (Math.PI / 2)) & 3);
      }
      m.surroundSectors = nearSectors.size;
      if (m.terminalCause) {
        s.phase = "crashed";
        return;
      }
    }
    const sectors = /* @__PURE__ */ new Set();
    for (const a of r?.closePatrols ?? world.actors) {
      if (!r && ((s.street ? !s.patrols.has(a) : a.pursuitRole !== "police") || distance(a, ego) >= 7.2)) continue;
      const angle = angleDelta(headingTo3(ego, a), ego.heading) + Math.PI;
      sectors.add(Math.floor((angle + Math.PI / 6) / (Math.PI / 3)) % 6);
    }
    let surrounded = false;
    for (const a of sectors) for (const b of sectors) {
      const separation = Math.abs(a - b);
      if (separation >= 2 && separation <= 4) surrounded = true;
    }
    m.capturePressureS = Math.abs(ego.speed) < 0.8 && surrounded ? m.capturePressureS + STEP : Math.max(0, m.capturePressureS - STEP * 2);
    if (m.pedestrianCollisions || playerHit && playerHit.severity >= 0.44) {
      s.phase = "crashed";
    } else if (m.capturePressureS >= 2.1) {
      s.phase = "captured";
    } else if (r && !s.packLab ? r.clearProgress >= 1 : moved > 1e-3 && m.distanceM >= 8 && distance(ego, s.playerStart) >= 6 && s.exits.some((point2) => distance(ego, point2) <= 2.6 && (!s.street || Math.abs(angleDelta(ego.heading, point2.heading)) <= 0.55))) {
      m.escape = true;
      s.phase = "escaped";
    } else if (!s.survival && m.survivalS >= (s.packLab ? 22 : TIERS[s.level - 1].durationS + (r ? 32 : 0))) {
      s.phase = "timeout";
    }
  }
  function stepPursuit(world, action, streetHooks = null) {
    const { player, pursuit: s } = world;
    if (s?.phase !== "running") return;
    const requested = { ...validatePursuitAction(action) };
    if (!s.street) streetHooks = null;
    else if (typeof streetHooks?.vehicleCommand !== "function" || typeof streetHooks?.pedestrianMotion !== "function")
      throw new TypeError("Street pursuit requires city vehicleCommand and pedestrianMotion hooks");
    s.startedTick ??= world.tick;
    if (s.gta) {
      s.stepEvents.length = 0;
      s.gta.eventTick = world.tick + 1;
      maintainGtaSquad(world);
    }
    if (s.survival) updateSurvivalBeforeMotion(world);
    if (!s.gta) updateEvents(world);
    world.actorIndex = new SpatialIndex(world.actors);
    for (const a of world.actors) a.previous = copyPose(a);
    const plans = world.actors.map((a) => motionPlan(world, a, requested, streetHooks));
    const ego = plans.find((p) => p.a === player);
    const staticGrid = s.street && s.response?.dispatch && dispatchStaticContacts(world);
    const solids = staticGrid?.plans ?? world.statics.map(staticContactPlan);
    const freshImpacts = s.gta?.config.damageFeedback === DISPATCH_DAMAGE_FEEDBACK ? [] : null;
    const impact = resolveContacts(world, plans, solids, staticGrid, freshImpacts);
    updateClearance(world, ego, [...plans, ...solids]);
    const m = s.metrics;
    if (isPackPursuit(s.variant) && m.pedestrianStatus !== "impact") {
      const blocker = ego.command.blockedBy && world.actorIndex.near(player, 24).find((actor) => actor.type === "pedestrian" && actor.id === ego.command.blockedBy);
      if (blocker && ego.command.reason === "yielding") {
        s.yieldingFor = blocker;
        m.pedestrianStatus = "yielding";
        m.firstYieldTick ??= world.tick + 1;
      } else if (s.yieldingFor && ego.stop === 1 && ego.next.speed > 0.5) {
        const walking = plans.find((plan) => plan.a === s.yieldingFor);
        if (walking) {
          const person = poseAt(walking, 1), { x, z, heading: heading2 } = ego.next;
          const cos = Math.cos(heading2), sin = Math.sin(heading2);
          const dx = person.x - x, dz = person.z - z;
          const side = dx * cos - dz * sin;
          const walkingSide = (person.x - walking.a.x) * cos - (person.z - walking.a.z) * sin;
          const behind = dx * sin + dz * cos < -player.length / 2 - person.radius;
          const leavingCorridor = Math.abs(side) > player.width / 2 + person.radius + 0.25 && side * walkingSide >= -1e-5;
          if (behind || leavingCorridor) {
            s.yieldingFor = null;
            m.pedestrianStatus = "clear";
            m.firstClearTick ??= world.tick + 1;
          }
        }
      }
    }
    m.guard = impact ? "contact" : ego.guard;
    m.requestedAction = requested;
    s.action = ego.guard === "road-boundary" ? { ...requested, throttle: 0, brake: 1 } : requested;
    let moved = 0;
    const reuseAcceptedPose = Boolean(s.response?.dispatch) || usesRushPace(s.variant);
    for (const p of plans) {
      const a = p.a, accepted = poseAt(p, 1);
      const next = reuseAcceptedPose && a !== accepted ? accepted : { ...accepted };
      const acceptedDistance = distance(a, next);
      const gtaBody = s.gta && (a === player || s.patrols.has(a));
      if (p.hit) Object.assign(next, { ...gtaBody ? p.impulse : { speed: 0 }, reason: "contact", blockedBy: p.hit });
      if (gtaBody) {
        next.health = a.health;
        next.aiState = a.aiState;
        if (a.aiState === "WRECKED") Object.assign(next, {
          path: a.path,
          cursor: 0,
          wreckUntilTick: a.wreckUntilTick,
          speed: 0,
          gtaSlipMps: 0,
          gtaYawRate: 0,
          reason: "WRECKED"
        });
      }
      if (a.type === "pedestrian") {
        next.accelerationMps2 = (next.speed - a.speed) / STEP;
        next.motionTimeS = (world.tick + 1) * STEP;
      } else if (!s.street) {
        next.y = next.supportHeightM = heightOnSupport(s, next);
      }
      if (s.gta && a === player && world.mode === "manual") next.districtSources = null;
      else if (s.street && a.type === "vehicle") {
        const sources = p.command.districtSources ?? a.districtSources;
        if (sources) next.districtSources = p.hit || p.guard !== "clear" ? { ...sources, finalMps: gtaBody ? Math.abs(next.speed) : 0, appliedSource: "physical-guard" } : sources;
      }
      if (a === player) {
        moved = acceptedDistance;
        const blocked = ego.guard === "road-boundary";
        const applied = !blocked ? p.command : s.street ? { ...p.command, targetSpeed: 0, reason: p.guard } : pursuitCommand(a, s.action, STEP);
        if (s.street || s.packLab) s.appliedCommand = {
          steer: applied.steer,
          targetSpeed: applied.targetSpeed,
          reason: applied.reason ?? null,
          blockedBy: applied.blockedBy ?? null,
          ...applied.decelerationMps2 === void 0 ? {} : { decelerationMps2: applied.decelerationMps2 }
        };
        next.vehicle = advanceVehicleState(a, next, applied, STEP, {
          tick: world.tick + 1,
          contact: impact ? { ...impact, hitId: impact.actorId, proposedTravelM: distance(a, p.next) } : null,
          freshImpacts
        });
        const height = next.supportHeightM ?? 0;
        if (m.supportHeightM < 0.045 && height >= 0.045) m.shoulderEntries++;
        if (m.supportHeightM >= 0.045 && height < 0.045) m.shoulderExits++;
        m.supportHeightM = height;
        m.maxSupportHeightM = Math.max(m.maxSupportHeightM, height);
        if (blocked && a.reason !== "road-boundary") world.metrics.interventions++;
      }
      Object.assign(a, next, {
        distance: a.distance + acceptedDistance,
        wait: acceptedDistance < 1e-3 ? a.wait + STEP : 0
      });
      if (gtaBody && a !== player) trackGtaPatrolProgress(world, a, p.command, acceptedDistance);
    }
    world.tick++;
    world.metrics.distance += moved;
    if (moved < 1e-3 && world.mode === "auto" && (!s.street || player.path.length))
      world.metrics.waitSeconds += STEP;
    m.distanceM += moved;
    if (isCityHunt(s.variant) && moved > 2e-3 && !impact)
      m.pedestrianDanger += approachingPedestrianDanger(world, player);
    m.survivalS = (world.tick - s.startedTick) * STEP;
    if (s.survival) {
      if (m.terminalCause && impact) emitSurvival(world, "impact", s.survival.contactAt ?? impact, m.terminalCause);
      updateSurvivalAfterMotion(world);
    }
    updatePhase(world, moved, impact);
    if (s.gta?.scanner && (world.tick - s.startedTick) % PURSUIT_SCAN_TICKS === 0)
      s.gta.scan = s.gta.scanner.sample(world);
    if (isPackPursuit(s.variant) && (s.phase === "crashed" || s.phase === "captured")) {
      s.reviewUntilTick = world.tick + (s.survival ? SURVIVAL_REVIEW_TICKS : PACK_REVIEW_TICKS);
      s.endedTick = world.tick;
      logEvent(world, s.phase, player);
      for (const a of world.actors) a.previous = copyPose(a);
      world.actorIndex = new SpatialIndex(world.actors);
    } else if (s.street && s.phase !== "running") cleanupStreetPursuit(world);
    else world.actorIndex = new SpatialIndex(world.actors);
    world.updateSensors(world.tick % 6 === 0);
    if (s.street) return { distanceM: moved, impact };
  }
  function boundedDecision(value, depth = 0) {
    if (typeof value === "string") return value.slice(0, 300);
    if (value === null || typeof value === "boolean" || Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || depth >= 6) return null;
    if (Array.isArray(value)) return value.slice(0, 64).map((v) => boundedDecision(v, depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 32).map(([key3, v]) => [key3, boundedDecision(v, depth + 1)]));
  }
  function pursuitSnapshot(world) {
    const s = world.pursuit;
    return {
      level: s.level,
      caseId: s.caseId,
      phase: s.phase,
      events: s.events.map((e) => ({ ...e })),
      metrics: structuredClone(s.metrics),
      action: s.action ? { ...s.action } : null,
      decision: boundedDecision(s.decision),
      exits: s.exits.map((e) => ({ ...e })),
      ...usesRushPace(s.variant) ? { variant: s.variant, targetPatrols: s.targetPatrols } : {},
      ...s.gta ? { variant: "gta", wantedLevel: s.wantedLevel, gta: {
        playerHealth: world.player.health,
        playerMaxHealth: world.player.maxHealth,
        activePatrols: [...s.patrols].filter((unit2) => unit2.aiState !== "WRECKED").length,
        pinnedRatio: s.gta.pinnedTicks * STEP / GTA_PIN_SECONDS
      } } : {},
      ...isRushPack(s.variant) ? { wantedLevel: s.wantedLevel, learning: s.learner?.snapshot() ?? null } : {},
      ...isPackPursuit(s.variant) ? {
        pack: true,
        packLab: s.packLab === true,
        driver: s.driver,
        review: s.reviewUntilTick > world.tick
      } : {},
      ...s.response ? { response: pursuitResponseSnapshot(s.response) } : {},
      ...s.survival ? { survival: survivalSnapshot(s, world.tick) } : {},
      ...s.street ? {
        street: true,
        startedTick: s.startedTick,
        endedTick: s.endedTick,
        appliedCommand: s.appliedCommand ? { ...s.appliedCommand } : null
      } : {}
    };
  }

  // src/core/pursuit-policy.js
  var PURSUIT_POLICY_VERSION = 2;
  var PURSUIT_DECISION_TICKS = 12;
  var RANGE = 42;
  var graphCache = /* @__PURE__ */ new WeakMap();
  var cutStreetProfiles = /* @__PURE__ */ new WeakMap();
  var boxRadius = (body) => body.radius ?? Math.hypot(body.width ?? 0, body.length ?? 0) / 2;
  var projection = (point2, ego) => {
    const dx = point2.x - ego.x, dz = point2.z - ego.z;
    const s = Math.sin(ego.heading), c = Math.cos(ego.heading);
    return { lateral: dx * c - dz * s, forward: dx * s + dz * c };
  };
  function lineIntersects(a, b, body, pad = 0) {
    const c = Math.cos(body.heading ?? 0), s = Math.sin(body.heading ?? 0);
    let low = 0, high = 1;
    const axes = [
      [
        a.x * c - a.z * s - (body.x * c - body.z * s),
        (b.x - a.x) * c - (b.z - a.z) * s,
        (body.width ?? (body.radius ?? 0) * 2) / 2 + pad
      ],
      [
        a.x * s + a.z * c - (body.x * s + body.z * c),
        (b.x - a.x) * s + (b.z - a.z) * c,
        (body.length ?? (body.radius ?? 0) * 2) / 2 + pad
      ]
    ];
    for (const [offset2, delta, half] of axes) {
      if (Math.abs(delta) < 1e-8) {
        if (Math.abs(offset2) > half) return false;
        continue;
      }
      const t1 = (-half - offset2) / delta, t2 = (half - offset2) / delta;
      low = Math.max(low, Math.min(t1, t2));
      high = Math.min(high, Math.max(t1, t2));
      if (low >= high) return false;
    }
    return low < 0.99 && high > 0.01;
  }
  function visible(ego, target, occluders) {
    const dx = target.x - ego.x, dz = target.z - ego.z, d = Math.hypot(dx, dz);
    if (d <= boxRadius(target) || d === 0) return true;
    const side = boxRadius(target) * 0.48;
    return [-side, 0, side].some((offset2) => {
      const point2 = { x: target.x + offset2 * dz / d, z: target.z - offset2 * dx / d };
      return !occluders.some((body) => body !== target && lineIntersects(ego, point2, body));
    });
  }
  var shape = (body) => ({
    id: body.id,
    type: body.type,
    kind: body.kind,
    x: body.x,
    z: body.z,
    heading: body.heading ?? 0,
    width: body.width,
    length: body.length,
    radius: body.radius
  });
  function observePursuit(world) {
    const ego = world.player, nowS = world.tick * STEP;
    const local2 = [...world.actors.filter((actor) => actor !== ego), ...world.statics].filter((actor) => distance(ego, actor) - boxRadius(actor) <= RANGE).sort((a, b) => distance(ego, a) - distance(ego, b) || a.id.localeCompare(b.id));
    const solid = local2.filter((actor) => actor.type !== "pedestrian");
    const last = world.pursuit.sightings ?? /* @__PURE__ */ new Map(), next = /* @__PURE__ */ new Map(), entities = [], unknown = [];
    const missing = (before) => {
      const ageS = nowS - before.timeS;
      next.set(before.id, { ...before, missing: true });
      unknown.push({
        id: before.id,
        ageS,
        lastSeen: shape(before),
        bearingRad: Math.atan2(before.x - ego.x, before.z - ego.z)
      });
    };
    for (const actor of local2) {
      if (!visible(ego, actor, solid)) {
        const before = last.get(actor.id);
        if (before && nowS - before.timeS <= 0.6) missing(before);
        continue;
      }
      const prior = last.get(actor.id), dt = nowS - (prior?.timeS ?? nowS);
      const continuous = prior && !prior.missing && dt <= 0.6;
      const resolved = continuous && dt >= 0.08;
      const vx = resolved ? (actor.x - prior.x) / dt : continuous ? prior.vx : 0;
      const vz = resolved ? (actor.z - prior.z) / dt : continuous ? prior.vz : 0;
      const measured2 = {
        ...shape(actor),
        ...projection(actor, ego),
        vx,
        vz,
        timeS: nowS,
        rangeM: distance(ego, actor),
        ageS: 0,
        motionKnown: Boolean(resolved || continuous && prior.motionKnown),
        police: actor.pursuitRole === "police",
        source: "virtual-ranging"
      };
      next.set(actor.id, continuous && dt > 0 && dt < 0.08 ? prior : measured2);
      entities.push(measured2);
    }
    for (const [id, before] of last)
      if (!next.has(id) && nowS - before.timeS <= 0.6) missing(before);
    world.pursuit.sightings = next;
    const fixed = world.statics.filter((body) => body.kind === "building" || body.kind === "wall");
    const obstacles = [...fixed.map(shape), ...entities.filter((body) => body.type === "static" && body.kind !== "building" && body.kind !== "wall")];
    return {
      ego: { ...shape(ego), speed: ego.speed, steer: ego.steer, maxSpeed: ego.maxSpeed, spec: { ...ego.spec } },
      timeS: nowS,
      entities,
      unknown,
      obstacles,
      source: "virtual-ranging",
      drivingRoads: world.drivingRoads,
      roads: world.roads,
      exits: world.pursuit.exits,
      ...isPackPursuit(world.pursuit.variant) ? { pack: true } : {},
      ...["hunt", "survival"].includes(world.pursuit.variant) ? { hunt: true, recovery: world.pursuit.recovery } : {}
    };
  }
  function routeCost(path, observed) {
    let value = 0;
    const relevant = observed.entities.filter((actor) => actor.forward > -3 || Math.abs(actor.lateral) > actor.width);
    for (let i = 1; i < path.length; i++) {
      const ds = distance(path[i - 1], path[i]);
      value += ds;
      for (const actor of relevant) {
        if (Math.abs(actor.x - path[i].x) >= 7 || Math.abs(actor.z - path[i].z) >= 7) continue;
        const d = distance(actor, path[i]);
        if (d < 7) value += ds * (1 - d / 7) * (actor.police ? 2 : 0.45);
      }
    }
    return value;
  }
  function shoulderRoute(observed, exit2, shoulder) {
    const ego = observed.ego, axis = shoulder.axis, across = axis === "z" ? "x" : "z";
    const sign = Math.sign(exit2[axis] - ego[axis]);
    const travel2 = (exit2[axis] - ego[axis]) * sign;
    const direction3 = axis === "z" ? Math.cos(ego.heading) : Math.sin(ego.heading);
    if (travel2 < 16 || direction3 * sign < 0.45) return null;
    const rampM = Math.max(2 * ego.length, Math.abs(shoulder.fixed - ego[across]) * 2.4);
    const near = (sign > 0 ? shoulder.min : shoulder.max) - ego[axis];
    const far = (sign > 0 ? shoulder.max : shoulder.min) - ego[axis];
    const take = Math.max(0, near * sign);
    const leave = Math.min(travel2, far * sign);
    if (leave - take < rampM * 2 + ego.length) return null;
    const blend = (t) => t * t * (3 - 2 * t);
    const path = [];
    for (let meter = 0; meter < travel2 + 1e-3; meter += 0.45) {
      const along2 = Math.min(meter, travel2);
      const a = blend(clamp((along2 - take) / rampM, 0, 1));
      const b = blend(clamp((along2 - leave + rampM) / rampM, 0, 1));
      path.push({
        [axis]: ego[axis] + along2 * sign,
        [across]: (ego[across] * (1 - a) + shoulder.fixed * a) * (1 - b) + exit2[across] * b
      });
    }
    if (distance(path.at(-1), exit2) > 1e-8) path.push({ x: exit2.x, z: exit2.z });
    for (let index = 1; index < path.length; index++) {
      const previous = path[index - 1], point2 = path[index];
      const pose5 = { ...ego, ...point2, heading: Math.atan2(point2.x - previous.x, point2.z - previous.z) };
      if (!bodyOnRoad(pose5, observed.roads, 0.12) || observed.obstacles.some((body) => overlaps(pose5, body, 0.12))) return null;
    }
    return { id: exit2.id, exit: exit2, path, cost: routeCost(path, observed) + 2, shoulder: true };
  }
  function selectPursuitRoute(observed, previous = null) {
    let graph = graphCache.get(observed.drivingRoads);
    if (!graph) {
      graph = createRoadGraph(observed.drivingRoads);
      graphCache.set(observed.drivingRoads, graph);
    }
    if (!graph.size) return null;
    const { ego, entities, obstacles } = observed;
    const barriers = obstacles.filter((body) => body.kind !== "building" && body.kind !== "wall");
    const filtered = !barriers.length ? graph : new Map([...graph].map(([key3, node]) => [
      key3,
      { ...node, edges: node.edges.filter((edge) => !barriers.some((body) => lineIntersects(node, graph.get(edge), body, ego.width / 2))) }
    ]));
    const cars = entities.filter((body) => body.type === "vehicle" && (body.forward > -3 || Math.abs(body.lateral) > ego.width));
    const pressure = /* @__PURE__ */ new Map();
    for (const [key3, node] of filtered) {
      let penalty = 0;
      for (const car of cars) if (car.police) {
        const d = distance(node, { x: car.x + car.vx * 1.5, z: car.z + car.vz * 1.5 });
        penalty += Math.max(0, 10 - d) * 1.3;
      }
      if (penalty) pressure.set(key3, penalty);
    }
    const crossesBarrier = (path) => barriers.some((body) => path.some((point2, index) => index > 0 && lineIntersects(path[index - 1], point2, body, ego.width / 2 + 0.12)));
    if (previous?.recovery && !crossesBarrier(previous.path)) {
      const { entry, approach: approach2, heading: heading2 } = previous.recovery;
      const pastEntry = (ego.x - entry.x) * Math.sin(approach2) + (ego.z - entry.z) * Math.cos(approach2) <= 0.8;
      if (Math.abs(angleDelta(heading2, ego.heading)) > 0.28) return {
        ...previous,
        recovery: { ...previous.recovery, turning: previous.recovery.turning || pastEntry }
      };
    }
    const options2 = observed.exits.flatMap((exit2) => {
      let path;
      if (distance(ego, exit2) < 8 && !barriers.some((body) => lineIntersects(ego, exit2, body, ego.width / 2)))
        path = [{ x: ego.x, z: ego.z }, { x: exit2.x, z: exit2.z }];
      else path = planNavigation(filtered, ego, exit2, cars, pressure, Math.PI / 2 + 0.08);
      if (path.length < 2) return [];
      if (crossesBarrier(path)) return [];
      return [{ id: exit2.id, exit: exit2, path, cost: routeCost(path, observed) }];
    });
    for (const shoulder of observed.roads.filter((road4) => road4.pursuitShoulder))
      for (const exit2 of observed.exits) {
        const path = shoulderRoute(observed, exit2, shoulder);
        if (path) options2.push(path);
      }
    options2.sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
    if (previous?.path.length > 2 && !previous.recovery) {
      const best = options2[0];
      let nearest2 = 0;
      for (let i = 1; i < previous.path.length; i++)
        if (distance(ego, previous.path[i]) < distance(ego, previous.path[nearest2])) nearest2 = i;
      const path = previous.path.slice(Math.max(0, nearest2 - 1));
      const ahead = path.find((point2) => distance(point2, ego) > 4);
      if (ahead && projection(ahead, ego).forward > -2 && distance(ego, previous.path[nearest2]) < 4 && !crossesBarrier(path)) {
        const cost = routeCost(path, observed);
        if (!best || cost <= best.cost + 8)
          return { ...previous, path, cost };
      }
    }
    return options2[0] ?? reverseConnector(observed, filtered, cars, pressure, crossesBarrier);
  }
  function streetProfile(district, barriers, obstacles) {
    if (!barriers.length) return district;
    const signature = JSON.stringify(obstacles.map(({ id, x, z, width, length, heading: heading2 }) => [id, x, z, width, length, heading2]));
    let profiles2 = cutStreetProfiles.get(district);
    if (!profiles2) {
      profiles2 = /* @__PURE__ */ new Map();
      cutStreetProfiles.set(district, profiles2);
    }
    if (profiles2.has(signature)) return profiles2.get(signature);
    const roads = district.drivingRoads.flatMap((road4) => {
      const cuts = barriers.filter((body) => body.width >= road4.width - 0.25 && Math.abs((road4.axis === "z" ? body.x : body.z) - road4.fixed) < 1 && Math.abs(Math.cos((body.heading ?? 0) - (road4.axis === "z" ? 0 : Math.PI / 2))) > 0.9).map((body) => road4.axis === "z" ? body.z : body.x).filter((along2) => along2 > road4.min && along2 < road4.max).sort((a, b) => a - b);
      let min = road4.min;
      const spans = [];
      for (const cut of cuts) {
        if (cut - 3 > min) spans.push({ ...road4, min, max: cut - 3 });
        min = cut + 3;
      }
      if (road4.max > min) spans.push(cuts.length ? { ...road4, min } : road4);
      return spans;
    });
    const profile = { ...district, drivingRoads: roads, statics: obstacles };
    if (profiles2.size >= 4) profiles2.delete(profiles2.keys().next().value);
    profiles2.set(signature, profile);
    return profile;
  }
  function selectStreetPursuitRoute(observed, district, previous = null) {
    const { ego, exits, entities, obstacles } = observed;
    const barriers = obstacles.filter((body) => body.kind === "barrier");
    const blocked = (path) => barriers.some((body) => path.some((point2, index) => index > 0 && lineIntersects(path[index - 1], point2, body, ego.width / 2 + 0.12)));
    if (previous?.path.length > 2) {
      let index = 0;
      for (let i = 1; i < previous.path.length; i++)
        if (distance(ego, previous.path[i]) < distance(ego, previous.path[index])) index = i;
      const remaining = previous.path.slice(Math.max(0, index - 3));
      const ahead = remaining.find((point2) => projection(point2, ego).forward > 2);
      if (ahead && distance(ego, previous.path[index]) < 3 && !blocked(remaining))
        return { ...previous, path: remaining };
    }
    const profile = streetProfile(district, barriers, obstacles);
    const traffic = entities.filter((body) => body.type === "vehicle");
    const options2 = exits.filter((exit2) => distance(exit2, ego) > 8).sort((a, b) => distance(a, ego) - distance(b, ego)).slice(0, 6);
    let best = null;
    for (const exit2 of options2) {
      const path = planDistrictRoute(profile, ego, exit2, traffic);
      if (path.length < 2 || blocked(path)) continue;
      const cost = routeCost(path, observed);
      if (!best || cost < best.cost)
        best = { id: exit2.id, exit: exit2, path, cost };
    }
    return best;
  }
  var act = (steer, throttle, brake = 0, gear = 1) => ({ steer, throttle, brake, gear });
  function reverseConnector(observed, graph, cars, pressure, crossesBarrier) {
    const { ego, drivingRoads, roads, exits, obstacles } = observed;
    const sideways = Math.abs(Math.cos(ego.heading)) > 0.72;
    const axis = sideways ? "x" : "z", across = sideways ? "z" : "x";
    const frontAxis = sideways ? Math.cos(ego.heading) : Math.sin(ego.heading);
    const options2 = [];
    for (const road4 of drivingRoads) {
      if (road4.axis !== axis || ego[axis] < road4.min || ego[axis] > road4.max) continue;
      const entry = { ...ego, [across]: road4.fixed - Math.sign(frontAxis) * 1.4 };
      const { forward: forward2 } = projection(entry, ego);
      if (forward2 > -2 || forward2 < -16 || !bodyOnRoad(entry, roads, 0.12) || obstacles.some((body) => lineIntersects(ego, entry, body, ego.width / 2 + 0.12))) continue;
      for (const heading2 of sideways ? [-Math.PI / 2, Math.PI / 2] : [0, Math.PI]) {
        for (const exit2 of exits) {
          const path = planNavigation(graph, { ...ego, [across]: road4.fixed, heading: heading2 }, exit2, cars, pressure);
          if (path.length < 2 || crossesBarrier(path)) continue;
          const cost = routeCost(path, observed) + 2 * distance(ego, entry);
          options2.push({ id: exit2.id, exit: exit2, path, cost, recovery: {
            entry: { x: entry.x, z: entry.z },
            approach: ego.heading,
            heading: heading2,
            turning: false
          } });
        }
      }
    }
    return options2.sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id))[0] ?? null;
  }
  function retreatPoint(observed) {
    const { ego } = observed;
    const aligned = Math.abs(Math.cos(ego.heading)) > 0.72;
    const axis = aligned ? "x" : "z";
    return observed.drivingRoads.filter((road4) => road4.axis === axis && ego[axis] >= road4.min + 0.5 && ego[axis] <= road4.max - 0.5).map((road4) => ({ ...ego, [axis === "x" ? "z" : "x"]: road4.fixed })).filter((point2) => {
      const { forward: forward2 } = projection(point2, ego);
      return forward2 < -1 && forward2 > -16 && !observed.obstacles.some((body) => lineIntersects(ego, point2, body, ego.width / 2));
    }).sort((a, b) => distance(ego, a) - distance(ego, b))[0] ?? null;
  }
  function routeCommand2(body, route) {
    if (!route?.path.length) return act(0, 0.74);
    if (route.recovery) {
      const { entry, approach: approach2, heading: heading2, turning } = route.recovery;
      const dx = body.x - entry.x, dz = body.z - entry.z;
      if (!turning && dx * Math.sin(approach2) + dz * Math.cos(approach2) > 0.8) {
        const error2 = angleDelta(Math.atan2(dx, dz), body.heading);
        return act(clamp(-1.6 * error2, -0.65, 0.65), 0.96, 0, -1);
      }
      const error = angleDelta(heading2, body.heading);
      if (Math.abs(error) > 0.17) {
        const steer2 = clamp(error * 2.5, -1, 1);
        return body.speed > 3.3 ? act(steer2, 0, 0.36) : act(steer2, 0.84);
      }
    }
    let cursor = 0;
    for (let i = 1; i < route.path.length; i++)
      if (distance(body, route.path[i]) < distance(body, route.path[cursor])) cursor = i;
    let { steer, targetSpeed } = followPath(body, route.path, cursor);
    const start = route.path[cursor];
    if (!route.shoulder && body.speed > 2.5 && distance(body, start) > 0.65) {
      const mergeLead = 6 + body.speed * 0.8;
      let tail = cursor;
      while (tail + 1 < route.path.length && distance(start, route.path[tail]) < mergeLead) tail++;
      const end = route.path[tail];
      const heading2 = Math.atan2(end.x - start.x, end.z - start.z);
      if (distance(start, end) >= mergeLead && Math.abs(angleDelta(heading2, body.heading)) < 0.32 && route.path.slice(cursor + 1, tail).every((point2) => Math.abs(projection(point2, { ...start, heading: heading2 }).lateral) < 0.24)) {
        const desired = Math.atan2(end.x - body.x, end.z - body.z);
        steer = clamp(angleDelta(desired, body.heading) * 0.64, -0.23, 0.23);
        targetSpeed = body.maxSpeed;
      }
    }
    const normalized = clamp(steer / (body.spec?.maxSteer ?? VEHICLE.maxSteer), -1, 1);
    const overshoot = body.speed - targetSpeed;
    if (overshoot > 0.3) return act(normalized, 0, clamp(overshoot * 0.4, 0.18, 0.8));
    return act(normalized, clamp((targetSpeed - body.speed) * 0.65, 0.05, 0.96));
  }
  function buildCandidates(follow) {
    const steer = follow.steer;
    return [
      follow,
      act(0, 1),
      act(-0.58, 0.78),
      act(0.58, 0.78),
      act(-1, 0.52),
      act(1, 0.52),
      act(steer, 0, 0.35),
      PURSUIT_STOP,
      act(-0.85, 0.72, 0, -1),
      act(0.85, 0.72, 0, -1),
      act(0, 0.65, 0, -1),
      act(steer, 0.42),
      act(-0.75, 0.36),
      act(0.75, 0.36)
    ];
  }
  function alongRoute(body, path) {
    let distanceM = Infinity, progressM = 0, accumulatedM = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const x = b.x - a.x, z = b.z - a.z, length = Math.hypot(x, z);
      if (!length) continue;
      const ratio = clamp(((body.x - a.x) * x + (body.z - a.z) * z) / (length * length), 0, 1);
      const offset2 = Math.hypot(body.x - a.x - x * ratio, body.z - a.z - z * ratio);
      if (offset2 < distanceM) {
        distanceM = offset2;
        progressM = accumulatedM + ratio * length;
      }
      accumulatedM += length;
    }
    return { distanceM, progressM };
  }
  var PACK_SAMPLE_TICKS = 6;
  var PACK_SAMPLE_S = PACK_SAMPLE_TICKS * STEP;
  var ROLLOUT_SAMPLES = 18;
  function packRolloutScene(observed, samples = ROLLOUT_SAMPLES) {
    const { ego } = observed;
    const reach = samples * PACK_SAMPLE_S * Math.max(
      ego.maxSpeed ?? 9.72,
      Math.abs(ego.speed),
      ego.spec?.reverseSpeed ?? VEHICLE.reverseSpeed
    ) + boxRadius(ego) + 2;
    const localRoad = (road4) => {
      const r = roadRect(road4);
      return r.minX <= ego.x + reach && r.maxX >= ego.x - reach && r.minZ <= ego.z + reach && r.maxZ >= ego.z - reach;
    };
    const movers = observed.entities.filter((actor) => actor.type !== "static");
    const forecasts = Array.from({ length: samples }, (_, index) => {
      const timeS = (index + 1) * PACK_SAMPLE_S, leadS = Math.min(timeS, 1.4);
      const intervalS = leadS - Math.min(index * PACK_SAMPLE_S, 1.4);
      return movers.map((actor) => {
        const vx = actor.motionKnown ? actor.vx : 0, vz = actor.motionKnown ? actor.vz : 0;
        return {
          body: { ...actor, x: actor.x + vx * leadS, z: actor.z + vz * leadS },
          dx: vx * intervalS,
          dz: vz * intervalS,
          travel: Math.hypot(vx, vz) * intervalS,
          radius: boxRadius(actor),
          uncertainty: actor.motionKnown ? 0.15 + timeS * 0.16 : 0.36 + timeS * 0.27
        };
      });
    });
    return {
      movers,
      forecasts,
      roads: observed.roads.filter(localRoad),
      roadLimits: { drivingRoads: observed.drivingRoads.filter(localRoad) },
      polys: observed.obstacles.filter((body) => distance(body, ego) < reach + boxRadius(body))
    };
  }
  function advancePackRollout(observed, pack, pose5, command) {
    let limit = Infinity;
    if (observed.street) {
      const road4 = onRoadLimit(pack.roadLimits, pose5);
      limit = observed.rush ? rushRoadLimit(road4) : road4.limit;
    }
    const next = { ...pose5 };
    for (let tick = 0; tick < PACK_SAMPLE_TICKS; tick++) {
      const requested = packCommand(next, command, STEP);
      requested.targetSpeed = Math.min(requested.targetSpeed, limit);
      integrateVehicle(next, requested, STEP, next);
    }
    return next;
  }
  function packSweepsInto(before, next, other, separates2, uncertainty = 0.12) {
    const guarded = overlaps(next, other, uncertainty) || !sweepSafe(before, next, [other]).safe;
    if (!guarded) return false;
    if (!separates2(next, other)) return true;
    const travel2 = distance(before, next) + Math.abs(angleDelta(next.heading, before.heading)) * boxRadius(next);
    const steps = Math.max(1, Math.ceil(travel2 / 0.035));
    for (let i = 1; i <= steps; i++) {
      if (overlaps(interpolate(before, next, i / steps), other)) return true;
    }
    return false;
  }
  function rollout(observed, action, route, index, retreat, pack = null, probe = null) {
    const { ego, obstacles } = observed;
    const roads = pack?.roads ?? observed.roads;
    const movers = pack?.movers ?? observed.entities.filter((actor) => actor.type !== "static");
    const start = ego;
    let pose5 = ego, score = 0, clearance = RANGE, failure = null, failureAtS = Infinity;
    let hardFailure = false, usablePose = ego, backedM = 0, forwardM = 0;
    const polys = pack?.polys ?? obstacles.filter((body) => distance(body, ego) < 28 + boxRadius(body));
    const dt = pack ? PACK_SAMPLE_S : 0.12;
    const intervals = probe?.samples ?? ROLLOUT_SAMPLES;
    const touching = new Map([...movers, ...polys].filter((body) => body.type !== "pedestrian" && overlaps(ego, body, 0.36)).map((body) => [body.id, distance(ego, body)]));
    const separates2 = (next, other) => {
      if (!touching.has(other.id) || overlaps(next, other)) return false;
      const gap = distance(next, other);
      if (gap <= touching.get(other.id) + 1e-5) return false;
      touching.set(other.id, gap);
      return true;
    };
    const roadMargin = !pack && bodyOnRoad(ego, roads, 0.12) ? 0.12 : 0.08;
    const backingTarget = retreat || !route?.recovery?.turning && route?.recovery?.entry;
    for (let step = 1; step <= intervals; step++) {
      const timeS = step * dt;
      const command = probe ? probe.command(pose5, step) : index === 0 ? pack && step * PACK_SAMPLE_TICKS <= PURSUIT_DECISION_TICKS ? action : routeCommand2(pose5, route) : index >= 11 && timeS >= 0.72 ? act(action.steer, 0, 0.7) : action.gear < 0 && timeS > 0.84 && !retreat ? act(-action.steer, 0.68) : (index === 2 || index === 3) && timeS > 0.84 && timeS < 1.56 ? act(-action.steer * 0.7, action.throttle) : (index === 2 || index === 3) && timeS >= 1.56 ? act(0, action.throttle) : action;
      let next;
      if (pack) next = advancePackRollout(observed, pack, pose5, command);
      else {
        const requested = pursuitCommand(pose5, command, dt);
        if (observed.street) {
          const road4 = onRoadLimit(observed, pose5);
          const limit = observed.rush ? rushRoadLimit(road4) : road4.limit;
          if (requested.targetSpeed > limit) requested.targetSpeed = limit;
        }
        next = integrateVehicle(pose5, requested, dt);
      }
      if (!(pack ? sweepSafe(pose5, next, [], roads).safe : bodyOnRoad(next, roads, roadMargin))) {
        failure ??= "road-edge";
        failureAtS = Math.min(failureAtS, timeS);
        hardFailure = true;
        break;
      }
      const radius = pack ? boxRadius(next) : 0;
      const travel2 = pack ? distance(pose5, next) + radius * Math.abs(next.heading - pose5.heading) : 0;
      if (polys.some((body) => pack ? distance(next, body) <= radius + boxRadius(body) + travel2 + 0.12 && packSweepsInto(pose5, next, body, separates2) : overlaps(next, body, 0.12) && !separates2(next, body))) {
        failure ??= "obstacle";
        failureAtS = Math.min(failureAtS, timeS);
        hardFailure = true;
        break;
      }
      if (observed.unknown.some(({ lastSeen, ageS }) => lastSeen && distance(next, ego) > 0.1 && !overlaps(ego, lastSeen, 0.36) && overlaps(next, lastSeen, 0.24 + Math.min(0.8, ageS + timeS)))) {
        failure ??= "unknown";
        failureAtS = Math.min(failureAtS, timeS);
        hardFailure = true;
        break;
      }
      for (let i = 0; i < movers.length; i++) {
        const actor = movers[i], forecast2 = pack?.forecasts[step - 1][i];
        const leadS = Math.min(timeS, 1.4);
        const other = forecast2?.body ?? { ...actor, x: actor.x + actor.vx * leadS, z: actor.z + actor.vz * leadS };
        const gap = distance(next, other) - (pack ? radius : boxRadius(next)) - (forecast2?.radius ?? boxRadius(other));
        clearance = Math.min(clearance, gap);
        const uncertainty = forecast2?.uncertainty ?? (actor.motionKnown ? 0.15 + timeS * 0.16 : 0.36 + timeS * 0.27);
        const blocked = forecast2 ? gap < Math.max(uncertainty, travel2 + forecast2.travel + 0.12) && packSweepsInto(
          { ...pose5, x: pose5.x + forecast2.dx, z: pose5.z + forecast2.dz },
          next,
          other,
          separates2,
          uncertainty
        ) : gap < 1 && overlaps(next, other, uncertainty) && !separates2(next, other);
        if (blocked) {
          const cause = actor.type === "pedestrian" ? "pedestrian" : actor.police ? "police" : "traffic";
          failure ??= cause;
          failureAtS = Math.min(failureAtS, timeS);
          if (cause === "pedestrian") {
            failure = cause;
            hardFailure = true;
          }
        }
        if (gap < 5) score -= Math.max(0, 5 - gap) * (actor.police ? pack ? 0.52 : 0.37 : 0.11);
      }
      if (hardFailure || probe && failure) break;
      if (probe) {
        if (next.speed < -0.05) backedM += distance(pose5, next);
        if (next.speed > 0.05) forwardM += distance(pose5, next);
      }
      pose5 = next;
      if (!failure) usablePose = pose5;
    }
    pose5 = usablePose;
    if (backingTarget) score += (distance(start, backingTarget) - distance(pose5, backingTarget)) * 2.7;
    else if (route?.path.length > 1) {
      const a = alongRoute(start, route.path), b = alongRoute(pose5, route.path);
      score += (b.progressM - a.progressM) * 1.65 - (b.distanceM - a.distanceM) * 0.9;
    } else if (observed.cinematic) {
      score += projection(pose5, start).forward * 1.65;
    } else {
      const exit2 = observed.exits.reduce((nearest2, point2) => !nearest2 || distance(point2, ego) < distance(nearest2, ego) ? point2 : nearest2, null);
      if (exit2) score += (distance(start, exit2) - distance(pose5, exit2)) * 1.65;
    }
    if (route?.recovery) score += Math.max(
      0,
      Math.abs(angleDelta(route.recovery.heading, start.heading)) - Math.abs(angleDelta(route.recovery.heading, pose5.heading))
    );
    for (const actor of movers.filter((body) => body.police && body.rangeM < 24)) {
      const timeS = Math.min(1.4, failureAtS);
      const projected = { x: actor.x + actor.vx * timeS, z: actor.z + actor.vz * timeS };
      score += (distance(pose5, projected) - distance(start, actor)) * Math.max(0, 1 - actor.rangeM / 24) * 1.3;
    }
    score += distance(start, pose5) * 0.17 - Math.abs(action.steer) * 0.28 - (action.gear < 0 ? 1.4 : 0) - (index === 7 ? 1.8 : 0);
    if (pack) {
      const normalized = (start.steer ?? 0) / (start.spec?.maxSteer ?? VEHICLE.maxSteer);
      score -= 0.75 * Math.abs(action.steer - normalized);
      score -= Math.max(0, 2 - clearance) * 0.95;
    }
    if (observed.unknown.length && Math.abs(pose5.speed) > 3) score -= 0.8;
    return { index, action, score, failure, failureAtS, hardFailure, clearance, pose: pose5, backedM, forwardM };
  }
  function checkedRecovery(observed) {
    const { ego, timeS } = observed;
    const gearAction = (plan) => timeS < plan.turnAtS ? act(plan.backSteer, 0.95, 0, -1) : act(plan.turnSteer, 0.82);
    const indexFor = (action) => action.gear > 0 ? action.steer < 0 ? 4 : 5 : action.steer < 0 ? 8 : action.steer > 0 ? 9 : 10;
    if (observed.recovery?.untilS > timeS) {
      const plan = observed.recovery, action = gearAction(plan);
      const samples = 7;
      const trial = rollout(
        observed,
        action,
        null,
        indexFor(action),
        null,
        packRolloutScene(observed, samples),
        { samples, command: () => action }
      );
      if (!trial.failure) return { ...trial, recovery: plan };
      return null;
    }
    const scene = packRolloutScene(observed, 51);
    let best = null;
    for (const backSteps of [17, 23]) for (const turnSteer of [-1, 1]) {
      for (const backSteer of [0, -turnSteer * 0.8]) {
        const action = act(backSteer, 0.95, 0, -1), samples = backSteps + 28;
        const trial = rollout(
          observed,
          action,
          null,
          indexFor(action),
          null,
          scene,
          { samples, command: (_, step) => step <= backSteps ? action : act(turnSteer, 0.82) }
        );
        if (trial.failure || trial.backedM < 1.5 || trial.forwardM < 2) continue;
        const yaw = Math.abs(angleDelta(trial.pose.heading, ego.heading));
        if (yaw < 0.54) continue;
        const value = trial.forwardM + 2 * yaw + Math.min(trial.clearance, 3) - backSteps * 0.04;
        if (!best || value > best.value) best = { ...trial, value, recovery: {
          backSteer,
          turnSteer,
          turnAtS: timeS + backSteps * PACK_SAMPLE_S,
          untilS: timeS + samples * PACK_SAMPLE_S
        } };
      }
    }
    return best;
  }
  function checkedPrefix(observed, route, candidates2) {
    const samples = Math.ceil((0.55 + Math.abs(observed.ego.speed) / VEHICLE.braking) / PACK_SAMPLE_S);
    if (samples > ROLLOUT_SAMPLES) return null;
    const scene = packRolloutScene(observed, samples);
    let best = null;
    for (const candidate of candidates2) {
      const { action, index } = candidate;
      if (!action.throttle || action.brake || candidate.failureAtS <= 0.65) continue;
      const trial = rollout(
        observed,
        action,
        route,
        index,
        null,
        scene,
        { samples, command: (_, step) => step <= 3 ? action : act(action.steer, 0, 1, action.gear) }
      );
      if (trial.failure || distance(trial.pose, observed.ego) < 0.15 || Math.abs(trial.pose.speed) > 0.15) continue;
      const value = trial.score + Math.min(trial.clearance, 3) + 0.1 * distance(trial.pose, observed.ego);
      if (!best || value > best.value) best = { ...trial, value };
    }
    return best;
  }
  var sector = ({ lateral: lateral2, forward: forward2 }) => Math.abs(lateral2) > Math.abs(forward2) ? lateral2 > 0 ? "right" : "left" : forward2 > 0 ? "front" : "rear";
  function observedPackThreats({ ego, entities }) {
    const sectors = /* @__PURE__ */ new Set(), closingSectors = /* @__PURE__ */ new Set();
    const vx = ego.speed * Math.sin(ego.heading), vz = ego.speed * Math.cos(ego.heading);
    let primary = "none", urgency = -Infinity, nearestM = Infinity;
    for (const actor of entities) {
      if (!actor.police || actor.rangeM > 22) continue;
      const side = sector(actor);
      const closing = actor.motionKnown ? ((vx - actor.vx) * (actor.x - ego.x) + (vz - actor.vz) * (actor.z - ego.z)) / Math.max(1, actor.rangeM) : 0;
      sectors.add(side);
      if (closing > 0.6) closingSectors.add(side);
      nearestM = Math.min(nearestM, actor.rangeM);
      const risk = (1 + Math.max(0, closing)) / Math.max(1, actor.rangeM - 3);
      if (risk > urgency) {
        urgency = risk;
        primary = side;
      }
    }
    return {
      primary,
      sectors: [...sectors],
      closingSectors: [...closingSectors],
      nearestM: Number.isFinite(nearestM) ? nearestM : null
    };
  }
  function packObservationKey(ego, candidates2, threat) {
    const pace = ego.speed < -0.15 ? "reverse" : ego.speed < 1.2 ? "slow" : "moving";
    const spread = clamp(threat.sectors.length - 1, 0, 2);
    const openings = candidates2.filter((c) => !c.failure && c.index < 6 && (c.action?.gear ?? 1) > 0).length;
    return `pack-v1:${threat.primary}:${spread}:${pace}:${openings === 0 ? 0 : openings < 3 ? 1 : 2}`;
  }
  function pursuitObservationKey(observed, candidates2 = []) {
    if (observed.pack) return packObservationKey(observed.ego, candidates2, observedPackThreats(observed));
    const { ego, entities } = observed;
    let mask = 0;
    for (const entity of entities) {
      if (entity.type === "static" || entity.rangeM > (entity.police ? 19 : 9)) continue;
      mask |= { front: 1, rear: 2, left: 4, right: 8 }[sector(entity)];
    }
    const pace = ego.speed < -0.15 ? "reverse" : ego.speed < 1.2 ? "slow" : ego.speed < 5 ? "cruise" : "fast";
    const crowd = Math.min(2, entities.filter((a) => a.type !== "static" && a.rangeM < 16).length);
    const openness = candidates2.filter((candidate) => !candidate.failure && candidate.index < 6).length;
    const key3 = `${mask}:${pace}:${crowd}:${Math.min(3, openness)}`;
    if (!observed.arcade) return key3;
    const vx = ego.speed * Math.sin(ego.heading), vz = ego.speed * Math.cos(ego.heading);
    let threat = "none", urgency = 0;
    for (const entity of entities) {
      if (!entity.police || !entity.motionKnown || entity.rangeM > 25) continue;
      const dx = entity.x - ego.x, dz = entity.z - ego.z;
      const range = Math.max(1, entity.rangeM);
      const closing = ((vx - entity.vx) * dx + (vz - entity.vz) * dz) / range;
      if (closing < 1 || closing / range <= urgency) continue;
      urgency = closing / range;
      threat = sector(entity);
    }
    return `${key3}:${threat}`;
  }
  function validatePursuitPolicy(weights) {
    if (!weights || weights.schemaVersion !== PURSUIT_POLICY_VERSION || weights.algorithm !== "tabular-q-learning" || !Array.isArray(weights.actions) || weights.actions.length !== PACK_ACTIONS.length || weights.actions.some((value, i) => value !== PACK_ACTIONS[i]) || !Number.isSafeInteger(weights.episodes) || weights.episodes < 0 || !weights.q || Object.getPrototypeOf(weights.q) !== Object.prototype)
      throw new Error("Unsupported pursuit policy");
    const rows = Object.entries(weights.q);
    if (rows.length > 768 || rows.some(([key3, row]) => !/^(?:\d|1[0-5]):(?:reverse|slow|cruise|fast):[0-2]:[0-3]$/.test(key3) || !Array.isArray(row) || row.length !== PACK_ACTIONS.length || row.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e5)))
      throw new Error("Invalid pursuit policy weights");
    return weights;
  }
  function decidePursuit(observed, route, weights = null, choose = null) {
    if (observed.street && route?.path.length > 80) route = { ...route, path: route.path.slice(0, 80) };
    const follow = routeCommand2(observed.ego, route);
    const retreat = route || observed.street ? null : retreatPoint(observed);
    const pack = observed.pack ? packRolloutScene(observed) : null;
    const candidates2 = buildCandidates(follow).map((action, index) => rollout(observed, action, route, index, retreat, pack));
    if (pack) return decidePack(observed, candidates2, route, weights, choose);
    const key3 = pursuitObservationKey(observed, candidates2);
    const safe = candidates2.filter((candidate) => !candidate.failure);
    const row = weights?.q[key3];
    const rank = (candidate) => candidate.score + (candidate.index === 0 && route ? 0.5 : 0) + clamp(row?.[candidate.index] ?? 0, -4, 4);
    safe.sort((a, b) => rank(b) - rank(a) || a.index - b.index);
    const fallback = candidates2[7];
    let selected = safe[0] ?? fallback;
    if (!safe.length && !fallback.hardFailure && fallback.failure) {
      const escape = candidates2.filter((candidate) => !candidate.hardFailure && candidate.failureAtS >= 0.6 && candidate.failureAtS > fallback.failureAtS && candidate.index !== fallback.index && distance(observed.ego, candidate.pose) > 0.15).sort((a, b) => b.failureAtS - a.failureAtS || b.score - a.score)[0];
      if (escape) selected = escape;
    }
    if (choose && safe.length) {
      const choice = choose(key3, safe.map((r) => r.index), selected.index);
      selected = safe.find((candidate) => candidate.index === choice) ?? selected;
    }
    return {
      action: selected.action,
      index: selected.index,
      name: PACK_ACTIONS[selected.index],
      key: key3,
      source: row && (!observed.arcade || safe.length) ? "learned-tactical" : "rollout",
      routeId: route?.id ?? null,
      clearanceM: selected.clearance,
      availableActions: safe.map((candidate) => candidate.index),
      threatSectors: [...new Set(observed.entities.filter((a) => a.type !== "static" && a.rangeM < (a.police ? 20 : 10)).map(sector))],
      rejected: candidates2.filter((c) => c.failure).map((c) => ({ action: PACK_ACTIONS[c.index], reason: c.failure }))
    };
  }
  function decidePack(observed, candidates2, route, weights, choose) {
    const packThreat = observedPackThreats(observed);
    const key3 = packObservationKey(observed.ego, candidates2, packThreat);
    const planRank = (candidate) => candidate.score + (candidate.index === 0 && route ? 0.5 : 0);
    const safe = candidates2.filter((c) => !c.failure).sort((a, b) => planRank(b) - planRank(a) || a.index - b.index);
    const safeForward = observed.hunt && safe.some((c) => c.action.gear > 0 && c.action.throttle && projection(c.pose, observed.ego).forward > 1.4);
    const stalled = Math.abs(observed.ego.speed) < 1.15 && !safeForward;
    const continuing = observed.recovery?.untilS > observed.timeS;
    const recover = observed.hunt && (continuing || stalled) && checkedRecovery(observed);
    const prefix = observed.hunt && !recover && !safe.some((c) => c.action.throttle) && checkedPrefix(observed, route, candidates2);
    const maneuver = recover || prefix;
    if (maneuver) return {
      action: maneuver.action,
      index: maneuver.index,
      name: PACK_ACTIONS[maneuver.index],
      key: key3,
      source: recover ? "escape-search" : "checked-prefix",
      routeId: route?.id ?? null,
      recovery: recover?.recovery ?? null,
      clearanceM: maneuver.clearance,
      availableActions: [maneuver.index],
      threatSectors: packThreat.sectors,
      rejected: candidates2.filter((c) => c.failure).map((c) => ({ action: PACK_ACTIONS[c.index], reason: c.failure }))
    };
    const baseline = safe[0] ?? candidates2[7];
    const row = weights?.q?.[key3];
    const policyLookup = Boolean(row && safe.length);
    let learned = baseline;
    if (policyLookup) {
      const rank = (candidate) => planRank(candidate) + clamp((row[candidate.index] ?? 0) * 0.55, -3, 3);
      for (const candidate of safe) {
        if (planRank(baseline) - planRank(candidate) > 3) break;
        if (rank(candidate) > rank(learned)) learned = candidate;
      }
    }
    const availableActions = safe.map((c) => c.index);
    const explorationIndex = choose && safe.length ? choose(key3, availableActions.slice(), learned.index) : learned.index;
    const selected = safe.find((c) => c.index === explorationIndex) ?? learned;
    const rankChanged = learned.index !== baseline.index;
    const explored = selected.index !== learned.index;
    return {
      action: selected.action,
      index: selected.index,
      name: PACK_ACTIONS[selected.index],
      key: key3,
      source: explored ? "exploration" : policyLookup ? "learned-tactical" : "rollout",
      routeId: route?.id ?? null,
      baselineIndex: baseline.index,
      learnedIndex: policyLookup ? learned.index : null,
      rankChanged,
      changed: rankChanged && !explored,
      policyLookup,
      explored,
      forcedHold: !safe.length,
      clearanceM: selected.clearance,
      availableActions,
      packThreat,
      threatSectors: packThreat.sectors,
      rejected: candidates2.filter((c) => c.failure).map((c) => ({ action: PACK_ACTIONS[c.index], reason: c.failure }))
    };
  }
  function createArcadeLearner(seed) {
    const rng = new Random(`${seed}:arcade-learning-v1`);
    const weights = { q: /* @__PURE__ */ Object.create(null) };
    let prior = null, updates = 0, explored = 0;
    function learn(metrics, next, outcome) {
      if (!prior) return;
      const { key: key3, index, before } = prior;
      const progress = metrics.distanceM - before.distanceM;
      const reward = 0.25 * Math.min(progress, 2) + (progress < 0.05 ? -0.12 : 0.04) - 12 * (metrics.collisions - before.collisions) - 25 * (metrics.pedestrianCollisions - before.pedestrianCollisions) - 0.6 * (metrics.nearCollisions - before.nearCollisions) + (outcome === "escaped" ? 14 : outcome === "crashed" || outcome === "captured" ? -12 : 0);
      const future = next?.availableActions.length ? Math.max(...next.availableActions.map((index2) => weights.q[next.key]?.[index2] ?? 0)) : 0;
      const row = weights.q[key3] ??= PACK_ACTIONS.map(() => 0);
      row[index] = clamp(row[index] + 0.24 * (reward + 0.9 * future - row[index]), -4, 4);
      updates++;
    }
    return {
      weights,
      choose(_key, safe, best) {
        if (safe.length < 2 || rng.next() >= 0.16) return best;
        explored++;
        return rng.pick(safe.filter((index) => index !== best));
      },
      record(decision2, metrics) {
        learn(metrics, decision2);
        prior = decision2.availableActions.includes(decision2.index) ? {
          key: decision2.key,
          index: decision2.index,
          before: {
            distanceM: metrics.distanceM,
            collisions: metrics.collisions,
            pedestrianCollisions: metrics.pedestrianCollisions,
            nearCollisions: metrics.nearCollisions
          }
        } : null;
      },
      finish(metrics, outcome) {
        learn(metrics, null, outcome);
        prior = null;
      },
      interrupt() {
        prior = null;
      },
      snapshot() {
        return { updates, explored, states: Object.keys(weights.q).length };
      }
    };
  }

  // src/core/visual-speed-policy.js
  var MAX_AGE_MS = 750;
  var RELEASE_MPS2 = 2.4;
  var ORDINARY_DECEL_MPS2 = 2;
  var MAX_VISUAL_DECEL_MPS2 = 7;
  var EPS3 = 1e-8;
  var finite3 = Number.isFinite;
  var STATES = ["clear", "caution", "slow", "stop", "unavailable"];
  var SNAPSHOT_KEYS = [
    "source",
    "streamId",
    "status",
    "available",
    "availability",
    "frameId",
    "ageMs",
    "model",
    "latencyMs",
    "detections",
    "projectedDetections",
    "unprojectableDetections",
    "tracks",
    "forecasts",
    "decision"
  ];
  var FORECAST_KEYS = [
    "trackId",
    "label",
    "confidence",
    "lateralM",
    "longitudinalM",
    "lateralSpeedMps",
    "forwardSpeedMps",
    "lateralPositionUncertaintyM",
    "longitudinalPositionUncertaintyM",
    "lateralVelocityUncertaintyMps",
    "longitudinalVelocityUncertaintyMps",
    "lateralOccupancyS",
    "longitudinalArrivalS",
    "arrivalQualified",
    "uncertaintyM",
    "crossingTimeS",
    "clearanceTimeS",
    "egoArrivalTimeS",
    "conflictTimeS",
    "conflict",
    "qualified",
    "held",
    "reason"
  ];
  var DECISION_KEYS = [
    "source",
    "available",
    "brake",
    "targetSpeedMps",
    "reason",
    "trackId",
    "confidence",
    "crossingTimeS",
    "ageMs",
    "evidenceFrameId"
  ];
  var VISUAL_KEYS = [
    "source",
    "available",
    "state",
    "targetSpeedMps",
    "reason",
    "streamId",
    "frameId",
    "ageMs",
    "evidenceTrackId",
    "nextState",
    "decelerationMps2"
  ];
  var MAP_KEYS = [
    "source",
    "available",
    "state",
    "reason",
    "targetSpeedMps",
    "zoneId",
    "distanceM"
  ];
  var STATE_KEYS = [
    "state",
    "capMps",
    "sinceS",
    "evidenceKey",
    "recoveryFrames",
    "lastFrameId",
    "lastTimeS",
    "streamId",
    "recoverySinceS",
    "supportTimeS",
    "stopTrackId",
    "mapCapMps",
    "composedCapMps",
    "evidenceTrackId",
    "visualDecelerationMps2"
  ];
  function plain(value, keys, name) {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new TypeError(`${name} must be a plain object`);
    for (const key3 of Reflect.ownKeys(value)) {
      if (!keys.includes(key3)) throw new TypeError(`${name}: unknown field ${String(key3)}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key3);
      if (descriptor.get || descriptor.set) throw new TypeError(`${name}: accessors are not data`);
    }
  }
  function bounded(value, min, max, name) {
    if (!finite3(value) || value < min || value > max)
      throw new TypeError(`${name} must be finite within ${min}..${max}`);
  }
  function token3(value, name) {
    if (typeof value !== "string" || !value.trim() || value.length > 200)
      throw new TypeError(`${name} must be a bounded nonempty string`);
  }
  function nullableNumber(value, min, max, name) {
    if (value !== null) bounded(value, min, max, name);
  }
  function optionalDeceleration(value, key3, name) {
    if (Object.prototype.hasOwnProperty.call(value, key3))
      nullableNumber(value[key3], ORDINARY_DECEL_MPS2, MAX_VISUAL_DECEL_MPS2, `${name}.${key3}`);
  }
  function validateState(value) {
    plain(value, STATE_KEYS, "district speed state");
    optionalDeceleration(value, "visualDecelerationMps2", "state");
    if (!STATES.includes(value.state)) throw new TypeError("Unknown district speed state");
    for (const key3 of ["capMps", "mapCapMps", "composedCapMps"])
      nullableNumber(value[key3], 0, 55, `state.${key3}`);
    for (const key3 of ["sinceS", "lastTimeS", "recoverySinceS", "supportTimeS"])
      nullableNumber(value[key3], 0, 1e9, `state.${key3}`);
    nullableNumber(value.lastFrameId, 0, Number.MAX_SAFE_INTEGER, "state.lastFrameId");
    if (value.lastFrameId !== null && !Number.isSafeInteger(value.lastFrameId))
      throw new TypeError("State frame identity must be an integer");
    bounded(value.recoveryFrames, 0, 2, "state.recoveryFrames");
    if (!Number.isInteger(value.recoveryFrames)) throw new TypeError("Invalid recovery frame count");
    for (const key3 of ["streamId", "stopTrackId", "evidenceTrackId"])
      if (value[key3] !== null) token3(value[key3], `state.${key3}`);
    if (value.evidenceKey !== null && (typeof value.evidenceKey !== "string" || value.evidenceKey.length > 400))
      throw new TypeError("Invalid state evidence identity");
  }
  function createDistrictSpeedState() {
    return {
      state: "clear",
      capMps: null,
      sinceS: null,
      evidenceKey: null,
      recoveryFrames: 0,
      lastFrameId: null,
      lastTimeS: null,
      streamId: null,
      recoverySinceS: null,
      supportTimeS: null,
      stopTrackId: null,
      mapCapMps: null,
      composedCapMps: null,
      evidenceTrackId: null,
      visualDecelerationMps2: null
    };
  }
  function validateSnapshot(visual, nowS, ego) {
    plain(visual, SNAPSHOT_KEYS, "visual snapshot");
    if (visual.source !== "visual-prediction") throw new TypeError("Expected pixel predictor snapshot");
    if (visual.streamId !== null) token3(visual.streamId, "visual.streamId");
    nullableNumber(visual.frameId, 0, Number.MAX_SAFE_INTEGER, "visual.frameId");
    if (visual.frameId !== null && !Number.isSafeInteger(visual.frameId))
      throw new TypeError("Visual frame identity must be an integer");
    nullableNumber(visual.ageMs, 0, 1e12, "visual.ageMs");
    if (typeof visual.available !== "boolean" || !["ready", "unavailable", "stale", "error"].includes(visual.status))
      throw new TypeError("Invalid visual availability");
    if (visual.availability !== void 0) {
      plain(visual.availability, ["status", "available", "error"], "visual availability");
      if (!["ready", "unavailable", "stale", "error"].includes(visual.availability.status) || typeof visual.availability.available !== "boolean" || visual.availability.error !== null && typeof visual.availability.error !== "string")
        throw new TypeError("Invalid nested visual availability");
    }
    if (visual.model !== null && visual.model !== void 0) {
      plain(visual.model, ["id", "method", "provider", "weightsSha256"], "visual model");
      for (const key3 of ["id", "method", "provider"]) token3(visual.model[key3], `visual model.${key3}`);
      if (visual.model.weightsSha256 !== null && !/^[a-f0-9]{64}$/i.test(visual.model.weightsSha256 ?? ""))
        throw new TypeError("Invalid visual model identity");
    }
    for (const key3 of ["detections", "projectedDetections", "unprojectableDetections"]) {
      if (visual[key3] !== void 0) {
        bounded(visual[key3], 0, 128, `visual.${key3}`);
        if (!Number.isInteger(visual[key3])) throw new TypeError("Detection counts must be integers");
      }
    }
    if (visual.latencyMs !== null && visual.latencyMs !== void 0)
      bounded(visual.latencyMs, 0, 6e4, "visual.latencyMs");
    if (visual.decision !== void 0) {
      plain(visual.decision, DECISION_KEYS, "visual decision");
      if (visual.decision.source !== "visual-prediction" || typeof visual.decision.available !== "boolean" || typeof visual.decision.brake !== "boolean")
        throw new TypeError("Invalid original visual decision");
      token3(visual.decision.reason, "visual decision reason");
      if (visual.decision.trackId !== null) token3(visual.decision.trackId, "visual decision track");
      for (const key3 of ["targetSpeedMps", "crossingTimeS", "ageMs", "evidenceFrameId"])
        nullableNumber(visual.decision[key3], 0, 1e12, `visual decision.${key3}`);
      bounded(visual.decision.confidence, 0, 1, "visual decision confidence");
    }
    if (!Array.isArray(visual.forecasts) || visual.forecasts.length > 24)
      throw new TypeError("Visual forecasts must be bounded");
    for (const forecast2 of visual.forecasts) {
      plain(forecast2, FORECAST_KEYS, "visual forecast");
      for (const key3 of ["trackId", "reason"]) token3(forecast2[key3], `forecast.${key3}`);
      if (!["person", "motion", "vehicle"].includes(forecast2.label))
        throw new TypeError("Invalid visual forecast class");
      for (const key3 of ["arrivalQualified", "conflict", "qualified", "held"])
        if (typeof forecast2[key3] !== "boolean") throw new TypeError("Invalid forecast qualification");
      for (const key3 of FORECAST_KEYS.filter((key4) => ![
        "trackId",
        "label",
        "reason",
        "arrivalQualified",
        "conflict",
        "qualified",
        "held",
        "lateralOccupancyS",
        "longitudinalArrivalS"
      ].includes(key4)))
        nullableNumber(forecast2[key3], -1e12, 1e12, `forecast.${key3}`);
      if (forecast2.longitudinalArrivalS !== null && forecast2.longitudinalArrivalS !== void 0) {
        plain(
          forecast2.longitudinalArrivalS,
          ["earliestEntryS", "latestEntryS", "earliestExitS", "latestExitS"],
          "visual arrival"
        );
        for (const value of Object.values(forecast2.longitudinalArrivalS))
          nullableNumber(value, 0, 6, "visual arrival time");
      }
      if (forecast2.lateralOccupancyS !== null && forecast2.lateralOccupancyS !== void 0) {
        if (!Array.isArray(forecast2.lateralOccupancyS) || forecast2.lateralOccupancyS.length !== 2)
          throw new TypeError("Visual occupancy must be an interval");
        forecast2.lateralOccupancyS.forEach((v) => bounded(v, 0, 6, "visual occupancy"));
      }
    }
    const brake = decideVisualBrake({ tracks: visual.tracks, nowS, ego });
    const frameTimeS = finite3(visual.ageMs) ? nowS - visual.ageMs / 1e3 : null;
    const coherent = visual.frameId !== null && visual.streamId !== null && frameTimeS !== null && frameTimeS >= -EPS3 && visual.model !== null && visual.model !== void 0 && finite3(visual.latencyMs) && visual.latencyMs <= MAX_AGE_MS && visual.tracks.every((track2) => track2.streamId === visual.streamId && track2.frameId <= visual.frameId && track2.lastSeenS <= frameTimeS + EPS3 && (track2.frameId !== visual.frameId || Math.abs(track2.lastSeenS - frameTimeS) <= EPS3));
    return { brake, frameTimeS, coherent };
  }
  function supportAge(nowS, times, ages = []) {
    return Math.max(...times.map((time) => (nowS - time) * 1e3), ...ages);
  }
  function recentMotion(track2, nowS, ego) {
    for (let count = Math.max(2, Math.min(3, track2.history.length)); count <= track2.history.length; count++) {
      const samples = track2.history.slice(-count);
      const span2 = samples.at(-1).simulationTimeS - samples[0].simulationTimeS;
      if (span2 > MAX_AGE_MS / 1e3 + EPS3) break;
      if (count >= 3 && span2 < 0.2 - EPS3) continue;
      const motion = fitRecentMotion(track2, samples, nowS, ego);
      if (motion && Math.abs(motion.lateralMps) - motion.lateralVelocityErrorMps >= 0.2)
        return motion;
    }
    return null;
  }
  function fitRecentMotion(track2, samples, nowS, ego) {
    if (samples.length < 2) return null;
    const first = samples[0], last = samples.at(-1), span2 = last.simulationTimeS - first.simulationTimeS;
    if (span2 < 0.1 - EPS3) return null;
    const vx = (last.position.x - first.position.x) / span2;
    const vz = (last.position.z - first.position.z) / span2;
    const c = Math.cos(ego.headingRad), s = Math.sin(ego.headingRad);
    let residual = 0, lateralResidual = 0, forwardResidual = 0;
    for (const sample of samples) {
      const t = sample.simulationTimeS - first.simulationTimeS;
      const dx2 = sample.position.x - first.position.x - vx * t;
      const dz2 = sample.position.z - first.position.z - vz * t;
      residual = Math.max(residual, Math.hypot(dx2, dz2));
      lateralResidual = Math.max(lateralResidual, Math.abs(dx2 * c - dz2 * s));
      forwardResidual = Math.max(forwardResidual, Math.abs(dx2 * s + dz2 * c));
    }
    if (Math.hypot(vx, vz) > 4 || residual > 0.35) return null;
    const ageS = Math.max(0, nowS - last.simulationTimeS);
    const dx = last.position.x + vx * ageS - ego.x;
    const dz = last.position.z + vz * ageS - ego.z;
    const covariance = track2.positionCovarianceM2;
    const lateralPositionErrorM = Math.sqrt(Math.max(
      0,
      c * c * covariance.xx - 2 * c * s * covariance.xz + s * s * covariance.zz
    ));
    const forwardPositionErrorM = Math.sqrt(Math.max(
      0,
      s * s * covariance.xx + 2 * c * s * covariance.xz + c * c * covariance.zz
    ));
    const velocityErrorMps = Math.max(0.1 + 2 * residual / span2, 2 * lateralPositionErrorM / span2);
    return {
      lateralM: dx * c - dz * s,
      forwardM: dx * s + dz * c,
      lateralMps: vx * c - vz * s,
      forwardMps: vx * s + vz * c,
      lateralVelocityErrorMps: Math.max(0.1 + 2 * lateralResidual / span2, 2 * lateralPositionErrorM / span2),
      forwardVelocityErrorMps: Math.max(0.1 + 2 * forwardResidual / span2, 2 * forwardPositionErrorM / span2),
      velocityErrorMps,
      positionErrorM: track2.uncertaintyM + ageS * velocityErrorMps,
      supportTimeS: first.simulationTimeS,
      ageMs: supportAge(nowS, samples.map((p) => p.simulationTimeS), [track2.ageMs])
    };
  }
  function cityApproach(track2, motion, nowS, ego, requestedSpeedMps, currentFrameId) {
    if (track2.frameId !== currentFrameId || track2.history.length < 3 || nowS - motion.supportTimeS > MAX_AGE_MS / 1e3 + EPS3 || track2.lastSeenS - motion.supportTimeS < 0.2 - EPS3) return null;
    const {
      lateralM,
      forwardM,
      lateralMps,
      forwardMps,
      lateralVelocityErrorMps,
      forwardVelocityErrorMps,
      positionErrorM
    } = motion;
    const laneHalf = ego.widthM / 2 + 0.35;
    const toward = -Math.sign(lateralM) * lateralMps;
    const closing = ego.speedMps - forwardMps;
    if (toward - lateralVelocityErrorMps < 0.2 || lateralVelocityErrorMps > 0.65 || closing - forwardVelocityErrorMps < 0.2 || Math.abs(lateralM) <= laneHalf) return null;
    const gap = forwardM - ego.lengthM / 2 - 0.35;
    const entry = (Math.abs(lateralM) - laneHalf) / toward;
    const exit2 = (Math.abs(lateralM) + laneHalf) / toward;
    const arrival = gap / closing;
    const egoExit = (forwardM + ego.lengthM / 2 + 0.35) / closing;
    if (gap <= 0 || arrival > 6 || entry > 4 || egoExit < entry - 0.2 || arrival > exit2 + 0.35) return null;
    const clearRoom = Math.max(0, gap - Math.min(3, positionErrorM) - 3.5);
    const targetSpeedMps = Math.min(requestedSpeedMps, Math.max(1.5, Math.min(
      Math.sqrt(2 * ORDINARY_DECEL_MPS2 * clearRoom),
      clearRoom / Math.max(1, exit2 + 0.4)
    )));
    if (targetSpeedMps >= Math.min(ego.speedMps, requestedSpeedMps) - 0.08) return null;
    return {
      ...motion,
      track: track2,
      state: "slow",
      reason: "observed-approach-slow",
      targetSpeedMps,
      decelerationMps2: Math.min(MAX_VISUAL_DECEL_MPS2, Math.max(
        ORDINARY_DECEL_MPS2,
        (ego.speedMps ** 2 - targetSpeedMps ** 2) / Math.max(1, 2 * clearRoom)
      ))
    };
  }
  function gradedCandidate(track2, nowS, ego, requestedSpeedMps, forecast2, currentFrameId, cityLead) {
    if (track2.confidence < (track2.label === "motion" ? 0.7 : 0.6)) return null;
    if (track2.label === "vehicle") {
      if (track2.frameId !== currentFrameId || track2.history.length < 2) return null;
      const observed = track2.history.at(-1), c2 = Math.cos(ego.headingRad), s2 = Math.sin(ego.headingRad);
      const dx = observed.position.x - ego.x, dz = observed.position.z - ego.z;
      const side = Math.abs(dx * c2 - dz * s2), forwardM2 = dx * s2 + dz * c2;
      if (side < ego.widthM / 2 || side > ego.widthM / 2 + 1.8 || forwardM2 <= ego.lengthM / 2 || forwardM2 > 14) return null;
      return {
        track: track2,
        state: "caution",
        reason: "observed-vehicle-view-caution",
        supportTimeS: observed.simulationTimeS,
        ageMs: supportAge(nowS, [observed.simulationTimeS], [track2.ageMs]),
        targetSpeedMps: Math.min(requestedSpeedMps, Math.max(1.5, requestedSpeedMps * 0.9))
      };
    }
    if (!track2.reliable) return null;
    const motion = recentMotion(track2, nowS, ego);
    if (!motion) return null;
    const { lateralM, forwardM, lateralMps, forwardMps, velocityErrorMps } = motion;
    if (forwardM <= ego.lengthM / 2 || forwardM > 30) return null;
    if (!bodyPathAllowsLateralMotion(track2, motion, ego)) return null;
    if (cityLead) return cityApproach(track2, motion, nowS, ego, requestedSpeedMps, currentFrameId);
    if (Math.abs(lateralMps) - motion.lateralVelocityErrorMps < 0.2 || lateralM * lateralMps >= 0)
      return null;
    const laneHalf = ego.widthM / 2 + 0.35;
    const entryS = Math.max(0, (Math.abs(lateralM) - laneHalf) / Math.abs(lateralMps));
    const exitS = (Math.abs(lateralM) + laneHalf) / Math.abs(lateralMps);
    const closingMps = ego.speedMps - forwardMps;
    if (closingMps - motion.forwardVelocityErrorMps <= 0.2 || entryS > 6) return null;
    const gapM = forwardM - ego.lengthM / 2 - 0.35;
    const egoEntryS = Math.max(0, gapM / closingMps);
    const egoExitS = (forwardM + ego.lengthM / 2 + 0.35) / closingMps;
    if (egoEntryS > exitS + 0.25 || egoExitS < entryS - 0.25 || egoEntryS > 6) return null;
    const close = entryS < 1.4 || gapM < ego.speedMps ** 2 / 4 + ego.speedMps * 0.9 + 1.5;
    const availableTimeS = Math.max(0, (Math.abs(lateralM) - laneHalf - motion.positionErrorM) / (Math.abs(lateralMps) + velocityErrorMps));
    const availableDistanceM = Math.max(0, gapM - motion.positionErrorM);
    const stoppingCapMps = Math.min(
      Math.max(0, ego.speedMps),
      ORDINARY_DECEL_MPS2 * availableTimeS,
      Math.sqrt(2 * ORDINARY_DECEL_MPS2 * availableDistanceM)
    );
    const targetSpeedMps = Math.min(requestedSpeedMps, Math.max(1.5, stoppingCapMps));
    const selectedSamples = track2.history.filter((sample) => sample.simulationTimeS >= motion.supportTimeS - EPS3);
    const corroboration = selectedSamples.length >= 3 ? motion : fitRecentMotion(track2, track2.history.slice(-3), nowS, ego);
    const c = Math.cos(ego.headingRad), s = Math.sin(ego.headingRad);
    const fittedLateralMps = track2.velocity.x * c - track2.velocity.z * s;
    const fittedLateralErrorMps = 0.05 + Math.sqrt(Math.max(
      0,
      c * c * track2.velocityCovarianceM2S2.xx - 2 * c * s * track2.velocityCovarianceM2S2.xz + s * s * track2.velocityCovarianceM2S2.zz
    ));
    let decelerationMps2, supportTimeS = motion.supportTimeS, ageMs = motion.ageMs;
    if (track2.observations >= 3 && track2.frameId === currentFrameId && targetSpeedMps > 0 && targetSpeedMps < Math.min(requestedSpeedMps, ego.speedMps) - EPS3 && Math.abs(fittedLateralMps) > fittedLateralErrorMps && fittedLateralMps * lateralMps > 0 && finite3(forecast2?.confidence) && forecast2.confidence <= 1 && forecast2.confidence >= (track2.label === "motion" ? 0.65 : 0.55) && corroboration && track2.lastSeenS - corroboration.supportTimeS >= 0.2 - EPS3 && corroboration.ageMs <= MAX_AGE_MS + EPS3 && Math.abs(corroboration.lateralMps) - corroboration.lateralVelocityErrorMps >= 0.2 && corroboration.lateralMps * lateralMps > 0 && corroboration.lateralM * corroboration.lateralMps < 0 && ego.speedMps - corroboration.forwardMps - corroboration.forwardVelocityErrorMps > 0.2) {
      const needed = Math.min(MAX_VISUAL_DECEL_MPS2, Math.max(
        ORDINARY_DECEL_MPS2,
        ego.speedMps / Math.max(EPS3, availableTimeS),
        ego.speedMps ** 2 / (2 * Math.max(EPS3, availableDistanceM))
      ));
      if (needed > ORDINARY_DECEL_MPS2 + EPS3) {
        decelerationMps2 = needed;
        supportTimeS = Math.min(supportTimeS, corroboration.supportTimeS);
        ageMs = Math.max(ageMs, corroboration.ageMs);
      }
    }
    return {
      ...motion,
      track: track2,
      supportTimeS,
      ageMs,
      decelerationMps2,
      state: close ? "slow" : "caution",
      reason: close ? "observed-approach-slow" : "observed-approach-caution",
      targetSpeedMps
    };
  }
  function decideDistrictVisualSpeed(input = {}) {
    plain(
      input,
      ["visual", "ego", "requestedSpeedMps", "nowS", "visionRequired", "previousState", "cityLead"],
      "district visual input"
    );
    const {
      visual = null,
      ego,
      requestedSpeedMps,
      nowS,
      visionRequired,
      previousState = createDistrictSpeedState(),
      cityLead = false
    } = input;
    bounded(nowS, 0, 1e9, "nowS");
    bounded(requestedSpeedMps, 0, 55, "requestedSpeedMps");
    if (typeof visionRequired !== "boolean") throw new TypeError("visionRequired must be explicit");
    if (typeof cityLead !== "boolean") throw new TypeError("City lead must be a boolean");
    validateState(previousState);
    if (previousState.lastTimeS !== null && nowS < previousState.lastTimeS - EPS3)
      throw new TypeError("District visual time cannot go backwards");
    const checked = visual === null ? { brake: decideVisualBrake({ tracks: [], nowS, ego }), frameTimeS: null, coherent: false } : validateSnapshot(visual, nowS, ego);
    const next = { ...previousState, lastTimeS: nowS };
    const result = {
      source: "camera-pixels",
      available: false,
      state: "unavailable",
      targetSpeedMps: null,
      reason: "camera-evidence-unavailable",
      streamId: visual?.streamId ?? null,
      frameId: visual?.frameId ?? null,
      ageMs: visual?.ageMs ?? null,
      evidenceTrackId: null
    };
    const finish = () => {
      if (next.state !== result.state || next.sinceS === null) next.sinceS = nowS;
      next.state = result.state;
      next.evidenceTrackId = result.evidenceTrackId;
      if (!result.available || !["caution", "slow"].includes(result.state) || result.targetSpeedMps === null || result.targetSpeedMps < 1.5 - EPS3)
        delete result.decelerationMps2;
      next.visualDecelerationMps2 = result.decelerationMps2 ?? null;
      return { ...result, nextState: next };
    };
    if (!visionRequired) {
      Object.assign(next, {
        capMps: null,
        recoveryFrames: 0,
        recoverySinceS: null,
        evidenceKey: null,
        supportTimeS: null,
        stopTrackId: null,
        streamId: result.streamId,
        lastFrameId: result.frameId
      });
      result.reason = "camera-policy-not-requested";
      return finish();
    }
    const unavailable = (reason, ageMs = result.ageMs) => {
      Object.assign(result, { reason, ageMs, targetSpeedMps: 0 });
      Object.assign(next, {
        capMps: 0,
        recoveryFrames: 0,
        recoverySinceS: null,
        streamId: result.streamId,
        lastFrameId: result.frameId
      });
      return finish();
    };
    if (!visual) return unavailable("camera-evidence-unavailable", null);
    if (!checked.coherent) return unavailable("camera-evidence-mismatch", null);
    if (visual.status !== "ready" || !visual.available || visual.availability?.available === false || visual.availability?.error || visual.availability !== void 0 && visual.availability.status !== "ready" || !finite3(visual.ageMs) || visual.ageMs > MAX_AGE_MS + EPS3)
      return unavailable("camera-evidence-unavailable");
    const key3 = `${visual.streamId.length}:${visual.streamId}:${visual.frameId}`;
    const sameStream = previousState.streamId === visual.streamId;
    if (sameStream && previousState.lastFrameId !== null && visual.frameId < previousState.lastFrameId)
      return unavailable("camera-frame-out-of-order");
    const track2 = visual.tracks.find((item) => item.id === checked.brake.trackId);
    const priorStop = previousState.stopTrackId && sameStream ? visual.tracks.find((item) => item.id === previousState.stopTrackId) : null;
    const clearance = priorStop?.stopEpisode?.phase === "cleared" && nowS - priorStop.lastSeenS <= MAX_AGE_MS / 1e3 + EPS3;
    let supportTimeS = checked.frameTimeS;
    if (checked.brake.available && checked.brake.brake && track2) {
      const evidence = track2.history.find((p) => p.frameId === checked.brake.evidenceFrameId);
      const times = [track2.lastSeenS, evidence?.simulationTimeS ?? track2.lastSeenS];
      if (track2.stopEpisode && ["stopping", "awaiting-clearance"].includes(track2.stopEpisode.phase))
        times.push(track2.stopEpisode.lastSupportTimeS);
      else times.push(...track2.history.slice(-3).map((p) => p.simulationTimeS));
      result.ageMs = supportAge(nowS, times, [visual.ageMs, track2.ageMs, checked.brake.ageMs]);
      result.evidenceTrackId = track2.id;
      if (result.ageMs > MAX_AGE_MS + EPS3)
        return unavailable("camera-support-stale", result.ageMs);
      Object.assign(result, {
        available: true,
        state: "stop",
        targetSpeedMps: 0,
        reason: checked.brake.reason
      });
      Object.assign(next, {
        capMps: 0,
        evidenceKey: key3,
        supportTimeS: Math.min(...times),
        stopTrackId: track2.id,
        recoveryFrames: 0,
        recoverySinceS: null,
        lastFrameId: visual.frameId,
        streamId: visual.streamId
      });
      return finish();
    }
    if (previousState.stopTrackId && !clearance) {
      result.evidenceTrackId = previousState.stopTrackId;
      const ageMs = priorStop ? supportAge(nowS, [priorStop.lastSeenS], [visual.ageMs, priorStop.ageMs]) : previousState.supportTimeS === null ? null : (nowS - previousState.supportTimeS) * 1e3;
      return unavailable("awaiting-fresh-visual-clearance", ageMs);
    }
    next.stopTrackId = null;
    const candidates2 = visual.tracks.map((item) => gradedCandidate(
      item,
      nowS,
      ego,
      requestedSpeedMps,
      visual.forecasts.find((forecast2) => forecast2.trackId === item.id && forecast2.label === item.label),
      visual.frameId,
      cityLead
    )).filter(Boolean).sort((a, b) => a.targetSpeedMps - b.targetSpeedMps || a.track.id.localeCompare(b.track.id));
    const candidate = candidates2[0];
    if (candidate) {
      result.ageMs = Math.max(visual.ageMs, candidate.ageMs);
      result.evidenceTrackId = candidate.track.id;
      if (previousState.evidenceKey === key3 && previousState.evidenceTrackId === candidate.track.id && previousState.visualDecelerationMps2 != null && previousState.supportTimeS !== null)
        result.ageMs = Math.max(result.ageMs, (nowS - previousState.supportTimeS) * 1e3);
      if (result.ageMs > MAX_AGE_MS + EPS3)
        return unavailable("camera-support-stale", result.ageMs);
      supportTimeS = Math.min(supportTimeS, candidate.supportTimeS);
      if (previousState.evidenceKey === key3 && previousState.evidenceTrackId === candidate.track.id && previousState.visualDecelerationMps2 != null && previousState.supportTimeS !== null)
        supportTimeS = Math.min(supportTimeS, previousState.supportTimeS);
    }
    const newFrame = !sameStream || previousState.lastFrameId === null || visual.frameId > previousState.lastFrameId;
    if (previousState.state === "unavailable" || !sameStream && previousState.streamId !== null) {
      const count = sameStream ? previousState.recoveryFrames : 0;
      next.recoverySinceS = count ? previousState.recoverySinceS : checked.frameTimeS;
      next.recoveryFrames = Math.min(2, count + (newFrame ? 1 : 0));
      if (next.recoveryFrames < 2 || checked.frameTimeS - next.recoverySinceS < 0.1 - EPS3) {
        Object.assign(result, { reason: "camera-recovering", targetSpeedMps: 0 });
        Object.assign(next, {
          capMps: 0,
          evidenceKey: key3,
          supportTimeS,
          streamId: visual.streamId,
          lastFrameId: visual.frameId
        });
        return finish();
      }
    }
    const desired = candidate?.targetSpeedMps ?? requestedSpeedMps;
    let cap = desired;
    let holding = false;
    if (previousState.capMps !== null && cap > previousState.capMps) {
      const sameEvidenceHold = previousState.evidenceKey === key3 && ["caution", "slow"].includes(previousState.state);
      holding = sameEvidenceHold;
      const difference = cap - previousState.capMps;
      const elapsed = previousState.lastTimeS === null ? 0 : nowS - previousState.lastTimeS;
      cap = sameEvidenceHold || candidate && difference <= 0.3 ? previousState.capMps : Math.min(cap, previousState.capMps + RELEASE_MPS2 * elapsed);
    }
    if (holding && previousState.supportTimeS !== null) {
      result.evidenceTrackId ??= previousState.evidenceTrackId;
      supportTimeS = Math.min(supportTimeS, previousState.supportTimeS);
      result.ageMs = Math.max(result.ageMs, (nowS - supportTimeS) * 1e3);
      if (result.ageMs > MAX_AGE_MS + EPS3)
        return unavailable("camera-support-stale", result.ageMs);
    }
    Object.assign(result, {
      available: true,
      state: holding ? previousState.state : candidate?.state ?? "clear",
      targetSpeedMps: candidate || cap < requestedSpeedMps - EPS3 ? cap : null,
      reason: holding ? "camera-evidence-hold" : candidate?.reason ?? (cap < requestedSpeedMps - EPS3 ? "camera-cap-release" : "no-observed-crossing-conflict")
    });
    if (candidate?.decelerationMps2 !== void 0)
      result.decelerationMps2 = candidate.decelerationMps2;
    if (holding && result.evidenceTrackId !== null && previousState.evidenceTrackId === result.evidenceTrackId && previousState.visualDecelerationMps2 != null)
      result.decelerationMps2 = Math.max(
        result.decelerationMps2 ?? ORDINARY_DECEL_MPS2,
        previousState.visualDecelerationMps2
      );
    Object.assign(next, {
      capMps: result.targetSpeedMps,
      supportTimeS,
      evidenceKey: key3,
      recoveryFrames: 2,
      recoverySinceS: null,
      lastFrameId: visual.frameId,
      streamId: visual.streamId
    });
    return finish();
  }
  function mappedDistrictSpeed(input = {}) {
    plain(input, ["zones", "ego"], "mapped district input");
    const { zones, ego } = input;
    decideVisualBrake({ tracks: [], nowS: 0, ego });
    if (!Array.isArray(zones) || zones.length > 128) throw new TypeError("Static zones must be bounded");
    let selected = null;
    for (const zone of zones) {
      plain(zone, [
        "id",
        "x",
        "z",
        "heading",
        "approachM",
        "clearanceM",
        "visibilityDistanceM",
        "speedLimitMps"
      ], "static caution zone");
      token3(zone.id, "zone.id");
      for (const key3 of ["x", "z", "heading"]) bounded(zone[key3], -1e5, 1e5, `zone.${key3}`);
      bounded(zone.approachM, 0.01, 200, "zone.approachM");
      bounded(zone.clearanceM, 0, 30, "zone.clearanceM");
      bounded(zone.visibilityDistanceM, 0, 100, "zone.visibilityDistanceM");
      bounded(zone.speedLimitMps, 0.01, 55, "zone.speedLimitMps");
      const yaw = Math.atan2(
        Math.sin(ego.headingRad - zone.heading),
        Math.cos(ego.headingRad - zone.heading)
      );
      if (Math.abs(yaw) > 0.7 + EPS3) continue;
      const dx = zone.x - ego.x, dz = zone.z - ego.z;
      const distanceM = dx * Math.sin(zone.heading) + dz * Math.cos(zone.heading);
      const lateralM = dx * Math.cos(zone.heading) - dz * Math.sin(zone.heading);
      const approaching = distanceM > 0 && distanceM <= zone.approachM;
      const clearing = distanceM <= 0 && distanceM > -zone.clearanceM;
      if (!approaching && !clearing || Math.abs(lateralM) > 4 + EPS3) continue;
      const cornerCap = Math.max(1.5, Math.min(
        zone.speedLimitMps,
        Math.sqrt(4 * Math.max(0, zone.visibilityDistanceM - ego.lengthM / 2 - 0.35))
      ));
      const cap = Math.max(1.5, Math.min(
        zone.speedLimitMps,
        Math.sqrt(cornerCap ** 2 + 4 * Math.max(0, distanceM - zone.visibilityDistanceM))
      ));
      const value = {
        source: "static-map",
        available: true,
        state: "caution",
        reason: "mapped-blind-corner",
        targetSpeedMps: cap,
        zoneId: zone.id,
        distanceM
      };
      if (!selected || cap < selected.targetSpeedMps || cap === selected.targetSpeedMps && zone.id < selected.zoneId) selected = value;
    }
    return selected ?? {
      source: "static-map",
      available: true,
      state: "clear",
      reason: "outside-mapped-caution",
      targetSpeedMps: null,
      zoneId: null,
      distanceM: null
    };
  }
  function sourceRecord(value, keys) {
    return value ? Object.fromEntries(keys.filter((key3) => key3 !== "nextState" && key3 in value).map((key3) => [key3, value[key3]])) : null;
  }
  function validateCap(value, keys, source, name) {
    if (value === null) return;
    plain(value, keys, name);
    if (value.source !== source || !STATES.includes(value.state) || typeof value.available !== "boolean")
      throw new TypeError(`Invalid ${name} provenance/state`);
    nullableNumber(value.targetSpeedMps, 0, 55, `${name}.targetSpeedMps`);
    token3(value.reason, `${name}.reason`);
    if (source === "camera-pixels") {
      optionalDeceleration(value, "decelerationMps2", "visual");
      if (value.streamId !== null) token3(value.streamId, "visual cap stream");
      if (value.evidenceTrackId !== null) token3(value.evidenceTrackId, "visual cap track");
      nullableNumber(value.frameId, 0, Number.MAX_SAFE_INTEGER, "visual cap frame");
      nullableNumber(value.ageMs, 0, 1e12, "visual cap age");
    } else {
      if (value.zoneId !== null) token3(value.zoneId, "map cap zone");
      nullableNumber(value.distanceM, -1e6, 1e6, "map cap distance");
    }
  }
  function composeDistrictSpeed(command, input = {}) {
    plain(input, ["visual", "map", "dt", "previousState"], "district composition");
    const { visual = null, map = null, dt, previousState = createDistrictSpeedState() } = input;
    bounded(command.targetSpeed, -55, 55, "command.targetSpeed");
    bounded(dt, 0, 1, "dt");
    validateState(previousState);
    validateCap(visual, VISUAL_KEYS, "camera-pixels", "visual cap");
    validateCap(map, MAP_KEYS, "static-map", "map cap");
    const nextState = { ...visual?.nextState ?? previousState };
    validateState(nextState);
    const visualCap = visual?.targetSpeedMps ?? Infinity;
    let mapCap = map?.targetSpeedMps ?? Infinity;
    if (previousState.mapCapMps !== null && mapCap > previousState.mapCapMps)
      mapCap = Math.min(mapCap, previousState.mapCapMps + RELEASE_MPS2 * dt);
    const requested = Math.max(0, command.targetSpeed);
    nextState.mapCapMps = finite3(mapCap) && mapCap < 55 ? mapCap : null;
    const targetSpeed = command.targetSpeed < 0 ? command.targetSpeed : Math.min(requested, visualCap, mapCap);
    nextState.composedCapMps = Math.max(0, targetSpeed);
    const cameraBinds = command.targetSpeed >= 0 && visualCap < requested - EPS3 && visualCap <= mapCap + EPS3;
    const mapBinds = command.targetSpeed >= 0 && mapCap < requested - EPS3 && mapCap <= visualCap + EPS3;
    const supportedCameraResponse = cameraBinds && visual.available && visualCap >= 1.5 - EPS3 && ["caution", "slow"].includes(visual.state) && visual.evidenceTrackId !== null && visual.streamId !== null && Number.isSafeInteger(visual.frameId) && finite3(visual.ageMs) && visual.ageMs <= MAX_AGE_MS + EPS3;
    nextState.visualDecelerationMps2 = supportedCameraResponse ? visual.decelerationMps2 ?? null : null;
    const appliedSource = cameraBinds && mapBinds ? "both" : cameraBinds ? "camera-pixels" : mapBinds ? "static-map" : "behavior";
    const mapRecord = sourceRecord(map, MAP_KEYS) ?? (finite3(mapCap) ? {
      source: "static-map",
      available: false,
      state: "clear",
      reason: "mapped-caution-release",
      targetSpeedMps: mapCap,
      zoneId: null,
      distanceM: null
    } : null);
    if (mapRecord && mapCap < Infinity) {
      mapRecord.targetSpeedMps = mapCap;
      if (map?.targetSpeedMps == null) mapRecord.reason = "mapped-caution-release";
    }
    const result = {
      ...command,
      targetSpeed,
      nextState,
      districtSources: {
        requestedMps: command.targetSpeed,
        behaviorMps: command.targetSpeed,
        visual: sourceRecord(visual, VISUAL_KEYS),
        map: mapRecord,
        composedMps: targetSpeed,
        finalMps: targetSpeed,
        appliedSource
      }
    };
    if (cameraBinds || mapBinds) {
      result.reason = cameraBinds && mapBinds ? "camera-and-mapped-caution" : cameraBinds ? visual.reason : mapRecord.reason;
      result.blockedBy = cameraBinds ? visual.evidenceTrackId : mapRecord.zoneId;
      if (targetSpeed > 0 || cameraBinds && visual.state === "unavailable")
        result.decelerationMps2 = supportedCameraResponse ? visual.decelerationMps2 ?? ORDINARY_DECEL_MPS2 : ORDINARY_DECEL_MPS2;
      else delete result.decelerationMps2;
    } else if (targetSpeed === 0) delete result.decelerationMps2;
    return result;
  }
  function attributeDistrictApplied({ requested, behavior, composed, safe }) {
    for (const [name, command] of Object.entries({ requested, behavior, composed, safe }))
      bounded(command?.targetSpeed, -55, 55, `${name}.targetSpeed`);
    const physicalReduction = safe.targetSpeed < composed.targetSpeed - EPS3;
    const guardBinds = safe.targetSpeed < composed.targetSpeed - 0.05;
    const guardStop = safe.targetSpeed === 0 && typeof safe.reason === "string" && safe.reason !== composed.reason && !["idle", "driving"].includes(safe.reason);
    let appliedSource = composed.districtSources?.appliedSource ?? "requested";
    if (guardBinds || guardStop) appliedSource = "physical-guard";
    else if (!["camera-pixels", "static-map", "both"].includes(appliedSource))
      appliedSource = behavior.targetSpeed < requested.targetSpeed - EPS3 ? "behavior" : "requested";
    const result = {
      ...composed,
      ...safe,
      districtSources: {
        ...composed.districtSources,
        requestedMps: requested.targetSpeed,
        behaviorMps: behavior.targetSpeed,
        composedMps: composed.targetSpeed,
        finalMps: safe.targetSpeed,
        appliedSource
      }
    };
    if (!physicalReduction && !guardStop) {
      result.reason = composed.reason ?? safe.reason;
      result.blockedBy = composed.blockedBy === void 0 ? safe.blockedBy : composed.blockedBy;
    }
    if (physicalReduction || guardStop || safe.targetSpeed === 0 && (appliedSource !== "camera-pixels" || composed.districtSources?.visual?.state !== "unavailable"))
      delete result.decelerationMps2;
    return result;
  }

  // src/signal_processing/range-sensors.js
  var SENSOR_ANGLES_DEG = Object.freeze(
    getVehicleMounts().ranges.map((mount) => mount.angleDeg)
  );
  var SENSOR_MAX_M = PLAYER_VEHICLE.maxRangeM;
  function circleHit2(origin, ray, body) {
    const dx = body.x - origin.x;
    const dz = body.z - origin.z;
    const projection2 = dx * ray.x + dz * ray.z;
    const radius = body.radius;
    const sideSquared = dx * dx + dz * dz - projection2 * projection2;
    if (sideSquared > radius * radius) return Infinity;
    const halfChord = Math.sqrt(Math.max(0, radius * radius - sideSquared));
    const near = projection2 - halfChord;
    return projection2 + halfChord < 0 ? Infinity : Math.max(0, near);
  }
  function boxHit2(origin, ray, body) {
    const angle = body.heading ?? 0;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const dx = origin.x - body.x;
    const dz = origin.z - body.z;
    const local2 = { x: dx * c - dz * s, z: dx * s + dz * c };
    const direction3 = { x: ray.x * c - ray.z * s, z: ray.x * s + ray.z * c };
    let near = -Infinity;
    let far = Infinity;
    for (const [axis, extent2] of [
      ["x", body.width / 2],
      ["z", body.length / 2]
    ]) {
      if (Math.abs(direction3[axis]) < 1e-9) {
        if (Math.abs(local2[axis]) > extent2) return Infinity;
        continue;
      }
      const a = (-extent2 - local2[axis]) / direction3[axis];
      const b = (extent2 - local2[axis]) / direction3[axis];
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
      if (near > far) return Infinity;
    }
    return far < 0 ? Infinity : Math.max(0, near);
  }
  function measureVehicleSensors(world, car) {
    const local2 = getVehicleMounts(car);
    const worldMount = (mount) => ({
      ...mount,
      position: mountToWorld(car, mount.position)
    });
    const cameras = local2.cameras.map((mount) => ({
      ...worldMount(mount),
      headingRad: (car.heading ?? 0) + mount.angleDeg * Math.PI / 180
    }));
    const mounts2 = {
      ranges: local2.ranges.map(worldMount),
      auxiliary: local2.auxiliary.map(worldMount),
      camera: cameras[0],
      cameras,
      telemetry: worldMount(local2.telemetry)
    };
    const proximityMounts = [...mounts2.ranges, ...mounts2.auxiliary];
    const mountReach = Math.max(
      ...[...local2.ranges, ...local2.auxiliary].map(
        (mount) => Math.hypot(mount.position.x, mount.position.z)
      )
    );
    const obstacles = [...world.actors ?? [], ...world.statics ?? []].filter((body) => {
      if (body === car || car.id !== void 0 && body.id === car.id) return false;
      const radius = body.type === "pedestrian" ? body.radius : Math.hypot(body.width, body.length) / 2;
      return Number.isFinite(radius) && radius > 0 && Number.isFinite(body.x) && Number.isFinite(body.z) && Math.hypot(body.x - car.x, body.z - car.z) <= SENSOR_MAX_M + mountReach + radius;
    });
    const rays = proximityMounts.map((mount) => {
      const origin = { ...mount.position };
      const angle = (car.heading ?? 0) + mount.angleDeg * Math.PI / 180;
      const ray = { x: Math.sin(angle), z: Math.cos(angle) };
      let nearest2 = SENSOR_MAX_M;
      let hitId = null;
      for (const body of obstacles) {
        const bottom = PLAYER_VEHICLE.roadHeightM + (body.y ?? 0);
        if (Number.isFinite(body.height) && (origin.y < bottom || origin.y > bottom + body.height))
          continue;
        const hit = body.type === "pedestrian" ? circleHit2(origin, ray, body) : boxHit2(origin, ray, body);
        if (hit <= nearest2 && (hitId === null || hit < nearest2)) {
          nearest2 = hit;
          hitId = body.id ?? null;
        }
      }
      return {
        id: mount.id,
        angleDeg: mount.angleDeg,
        origin,
        end: {
          x: origin.x + ray.x * nearest2,
          y: origin.y,
          z: origin.z + ray.z * nearest2
        },
        hitId,
        rangeM: nearest2
      };
    });
    return {
      rawM: rays.slice(0, SENSOR_ANGLES_DEG.length).map(
        (ray) => Math.round(ray.rangeM * 100) / 100
      ),
      auxiliary: rays.slice(SENSOR_ANGLES_DEG.length),
      mounts: mounts2,
      rays
    };
  }
  var RangeSignalProcessor = class {
    constructor() {
      this.history = [];
      this.filtered = null;
    }
    update(raw) {
      if (raw.length !== SENSOR_ANGLES_DEG.length || raw.some((n) => !Number.isFinite(n) || n < 0 || n > SENSOR_MAX_M))
        throw new Error("Invalid proximity sample");
      this.history.push([...raw]);
      if (this.history.length > 3) this.history.shift();
      const median = raw.map(
        (_, index) => [...this.history.map((sample) => sample[index])].sort((a, b) => a - b)[Math.floor(this.history.length / 2)]
      );
      this.filtered = this.filtered ? median.map(
        (value, index) => Math.round((this.filtered[index] * 0.55 + value * 0.45) * 100) / 100
      ) : median;
      return {
        source: "simulated-geometry",
        anglesDeg: SENSOR_ANGLES_DEG,
        maxRangeM: SENSOR_MAX_M,
        rawM: [...raw],
        filteredM: [...this.filtered]
      };
    }
  };

  // src/core/world.js
  var LAB_ROADS = [
    ...[-20, 20].map((fixed) => ({
      axis: "z",
      fixed,
      min: -40,
      max: 40,
      width: 10
    })),
    ...[-40, 0, 40].map((fixed) => ({
      axis: "x",
      fixed,
      min: -20,
      max: 20,
      width: 10
    }))
  ];
  var vehicleStart = { x: 20 - LANE_OFFSET, z: -25, heading: 0 };
  var VEHICLE_TEST_BARRIER = Object.freeze({
    id: "vehicle-impact-barrier",
    type: "static",
    kind: "barrier",
    x: vehicleStart.x,
    z: -8.6,
    heading: 0,
    width: 3.6,
    length: 0.8,
    height: 0.9
  });
  var carKinds = ["sedan", "taxi", "suv", "van", "tuktuk", "tuktuk"];
  var pose4 = (road4, along2, side = 1, offset2 = LANE_OFFSET) => road4.axis === "z" ? {
    x: road4.fixed - side * offset2,
    z: along2,
    heading: side === 1 ? 0 : Math.PI
  } : {
    x: along2,
    z: road4.fixed + side * offset2,
    heading: side === 1 ? Math.PI / 2 : -Math.PI / 2
  };
  var copyPose2 = (a) => ({
    id: a.id,
    type: a.type,
    x: a.x,
    z: a.z,
    heading: a.heading,
    speed: a.speed,
    length: a.length,
    width: a.width,
    radius: a.radius
  });
  function freezePath(path) {
    if (!Object.isFrozen(path)) {
      path.forEach(Object.freeze);
      Object.freeze(path);
    }
  }
  var World = class _World {
    constructor(options2 = {}, environment = "city") {
      const cityVersion = environment === "metro" ? options2.cityVersion ?? 2 : null;
      const rush = cityVersion === 4;
      this.config = settings(
        rush ? { ...RUSH_CITY_POPULATION_DEFAULTS, speedLimit: 48, ...options2 } : options2,
        rush ? RUSH_CITY_POPULATION_LIMITS : cityVersion === 3 ? METRO_POPULATION_LIMITS : null
      );
      this.environment = environment;
      this.pursuit = environment === "pursuit" ? createPursuitState(options2) : null;
      if (this.pursuit) Object.assign(this.config, {
        pursuitLevel: this.pursuit.level,
        pursuitCase: this.pursuit.caseId,
        ...this.pursuit.packLab ? { pursuitVariant: this.pursuit.variant } : {}
      });
      if (environment === "egypt") Object.assign(this.config, districtOptions(options2));
      this.district = environment === "metro" ? { ...createUnifiedCity({ dense: cityVersion >= 3, rush }), metro: true } : environment === "egypt" ? createEgyptDistrict() : null;
      this.districtCase = environment === "egypt" ? createDistrictCase(this.district, this.config.districtCase, this.config.seed) : null;
      if (this.district) {
        if (environment === "metro") {
          if (![1, 2, 3, 4].includes(cityVersion))
            throw new Error("Unsupported city layout version");
          this.config.cityVersion = cityVersion;
          if (cityVersion >= 2) this.cityEncounters = createCityEncounters(this.config);
        } else this.config.districtVersion = this.district.version;
        this.districtBehavior = createDistrictBehaviorState();
        this.districtSpeedState = createDistrictSpeedState();
      }
      const visualScene = environment === "vision" ? createVisionScenario(options2.visionCase ?? "cross-left") : null;
      if (visualScene) this.config.visionCase = visualScene.id;
      this.visualPredictor = new VisualCrossingPredictor({
        allowLateClearance: this.district !== null,
        freshMotionSupport: this.district !== null
      });
      this.visualMode = environment === "metro" ? "sensors-only" : "vision-first";
      this.visualDecision = null;
      this.visionLab = visualScene ? {
        caseId: visualScene.id,
        phase: "ready",
        startedTick: null,
        goalZ: visualScene.goalZ,
        requestedSpeedMps: visualScene.requestedSpeedMps,
        firstVisualBrakeS: null,
        firstReactiveBrakeS: null,
        firstSensorTriggerS: null,
        firstLaneEntryS: null,
        completedAtS: null,
        minimumClearanceM: null
      } : null;
      this.rng = new Random(`${this.config.seed}:${environment}`);
      this.drivingRoads = this.pursuit?.drivingRoads ?? this.district?.drivingRoads ?? visualScene?.roads ?? (environment === "lab" || environment === "vehicle" ? LAB_ROADS : roadLayout(100).roads);
      this.graph = createRoadGraph(this.drivingRoads);
      this.junctions = [...this.graph.values()].filter(
        (n) => n.edges.length >= 3
      );
      const corners2 = (environment === "lab" || environment === "vehicle" ? [...this.graph.values()] : []).filter((n) => {
        if (n.edges.length !== 2) return false;
        const a = this.graph.get(n.edges[0]), b = this.graph.get(n.edges[1]);
        return Math.abs((a.x - n.x) * (b.z - n.z) - (a.z - n.z) * (b.x - n.x)) > 0.01;
      });
      this.junctionGroups = this.district || this.pursuit ? [] : junctionGroups([...this.junctions, ...corners2]);
      this.parkingBays = environment === "city" ? parkingBays(this.graph, this.junctionGroups, this.drivingRoads) : [];
      this.roads = this.pursuit?.roads ?? this.district?.roads ?? [...this.drivingRoads, ...this.parkingBays];
      this.tick = 0;
      this.events = [];
      this.mode = "manual";
      this.policy = null;
      this.input = { targetSpeed: 0, steer: 0 };
      this.destination = null;
      this.routeRevision = 0;
      this.statics = [];
      this.actors = [];
      this.junctionOwners = /* @__PURE__ */ new Map();
      this.statics = this.pursuit?.statics ?? this.district?.statics ?? visualScene?.statics ?? (environment === "city" ? cityFootprints(this.roads) : environment === "vehicle" ? [{ ...VEHICLE_TEST_BARRIER }] : []);
      this.staticIndex = new SpatialIndex(this.statics);
      this.metrics = {
        distance: 0,
        interventions: 0,
        completedTrips: 0,
        trafficTrips: 0,
        waitSeconds: 0,
        scenarios: 0,
        trafficStoppedOver5: 0,
        trafficStoppedOver20: 0,
        longestCurrentTrafficWait: 0,
        peakTrafficWait: 0,
        trafficBlockingCycles: 0
      };
      this.scenario = null;
      this.vehicleTest = environment === "vehicle" ? {
        phase: "ready",
        barrierId: VEHICLE_TEST_BARRIER.id,
        maxSpeedMps: 5,
        maxTicks: 8 * 60,
        startedTick: null,
        contactTick: null,
        impact: null,
        error: null
      } : null;
      const startingBay = environment === "city" ? this.parkingBays.find(
        (bay) => bay.axis === "z" && bay.side === -1 && bay.nodeKey === "20.0000,-40.0000" && bay.min <= -40 && bay.max >= -40
      ) : null;
      if (environment === "city" && !startingBay)
        throw new Error("City starting parking bay is missing");
      this.player = this.makeVehicle("player", "sedan", this.pursuit?.playerStart ?? this.districtCase?.playerStart ?? this.district?.playerStart ?? visualScene?.playerStart ?? {
        // The city starts in a marked shoulder bay. An idle player in the
        // northbound lane used to block an entire traffic queue before input.
        x: startingBay?.fixed ?? 20 - LANE_OFFSET,
        z: environment === "city" ? -40 : -25,
        heading: 0
      });
      this.actors.push(this.player);
      if (this.pursuit) {
        populatePursuit(this);
      } else if (this.district) {
        this.populateDistrict();
      } else if (visualScene) {
        this.actors.push(...structuredClone(visualScene.people));
        this.capacity = { traffic: 0, pedestrians: visualScene.people.length };
      } else if (environment === "vehicle")
        this.capacity = { traffic: 0, pedestrians: 0 };
      else this.populate();
      for (const actor of this.actors) {
        if (actor.type !== "pedestrian") continue;
        actor.body ??= createPedestrianBody(actor);
        if (visualScene) actor.body = { ...actor.body, heightM: 1.78, radiusM: actor.radius };
        actor.motionMode ??= "ambient";
        actor.motionTimeS = 0;
        actor.accelerationMps2 = 0;
      }
      this.sensorProcessor = new RangeSignalProcessor();
      this.updateSensors();
    }
    makeVehicle(id, kind, position2, rng = this.rng) {
      const tuk = kind === "tuktuk";
      return {
        id,
        type: "vehicle",
        kind,
        ...position2,
        speed: 0,
        steer: 0,
        length: id === "player" ? PLAYER_VEHICLE.lengthM : tuk ? 2.9 : VEHICLE.length,
        width: id === "player" ? PLAYER_VEHICLE.widthM : tuk ? 1.5 : VEHICLE.width,
        spec: id === "player" ? {
          wheelbase: PLAYER_VEHICLE.wheelbaseM,
          maxSteer: PLAYER_VEHICLE.maxSteerRad
        } : tuk ? { wheelbase: 1.9 } : null,
        maxSpeed: this.config.speedLimit / 3.6 * (tuk ? 0.7 : 1),
        path: [],
        cursor: 0,
        distance: 0,
        wait: 0,
        reason: "ready",
        phase: rng.next(),
        reckless: id !== "player" && rng.next() < this.config.chaos,
        ...id === "player" ? { height: PLAYER_VEHICLE.heightM, vehicle: createVehicleState() } : {}
      };
    }
    updateSensors(filter = true) {
      const geometry = measureVehicleSensors(this, this.player);
      const previous = this.player.previous;
      this.sensors = {
        ...filter ? this.sensorProcessor.update(geometry.rawM) : this.sensors,
        ...geometry,
        imu: {
          source: "simulated-vehicle-state",
          positionM: { ...geometry.mounts.telemetry.position },
          headingRad: this.player.heading,
          speedMps: this.player.speed,
          yawRateRadS: previous ? angleDelta(this.player.heading, previous.heading) / STEP : 0,
          longitudinalAccelerationMps2: previous ? (this.player.speed - previous.speed) / STEP : 0
        }
      };
    }
    free(body, gap = 1) {
      return !this.actors.some((a) => overlaps(body, a, gap)) && !this.statics.some((a) => overlaps(body, a, gap));
    }
    populate() {
      for (let i = 0, attempts = 0; i < this.config.traffic && attempts < 3e3; attempts++) {
        const road4 = this.rng.pick(this.drivingRoads), along2 = this.rng.range(road4.min + 7, road4.max - 7), side = this.rng.next() < 0.5 ? -1 : 1;
        const car = this.makeVehicle(
          `traffic-${i}`,
          this.rng.pick(carKinds),
          pose4(road4, along2, side)
        );
        if (distance(car, this.player) < 14 || !this.free(car, 4) || !bodyOnRoad(car, this.roads))
          continue;
        if (this.junctionGroups.some((j) => insideJunction(car, j, 1))) continue;
        this.assignTrafficRoute(car);
        if (!car.path.length) continue;
        this.actors.push(car);
        i++;
      }
      for (let i = 0, attempts = 0; i < this.config.pedestrians && attempts < 2500; attempts++) {
        const road4 = this.rng.pick(this.drivingRoads), side = this.rng.next() < 0.5 ? -1 : 1;
        const along2 = this.rng.range(road4.min + 7, road4.max - 7), offset2 = road4.width / 2 + 1.25;
        const p = {
          id: `person-${i}`,
          type: "pedestrian",
          kind: PEOPLE_MODELS[i % PEOPLE_MODELS.length],
          ...pose4(road4, along2, side, offset2),
          radius: 0.34,
          speed: 0,
          walkSpeed: this.rng.range(1.1, 1.65),
          phase: this.rng.next(),
          distance: 0,
          wait: 0,
          reason: "walking",
          road: road4,
          side,
          along: along2,
          target: null,
          pause: 0,
          crossing: false
        };
        p.body = createPedestrianBody(p);
        p.radius = p.body.radiusM;
        p.motionMode = "ambient";
        if (!this.free(p, 0.7) || pointOnRoad(p, this.roads)) continue;
        this.nextWalk(p);
        this.actors.push(p);
        i++;
      }
      this.capacity = {
        traffic: this.actors.filter(
          (a) => a.type === "vehicle" && a !== this.player
        ).length,
        pedestrians: this.actors.filter((a) => a.type === "pedestrian").length
      };
    }
    populateDistrict() {
      const district = this.district;
      const encounter = this.districtCase;
      if (encounter && encounter.id !== "ambient") {
        encounter.phase = "ready";
        encounter.startedTick = null;
        encounter.firstVisualBrakeS = null;
        encounter.firstReactiveBrakeS = null;
        encounter.firstLaneEntryS = null;
        encounter.completedAtS = null;
        if (!Number.isFinite(encounter.requestedSpeedMps) || encounter.requestedSpeedMps <= 0 || encounter.requestedSpeedMps > 8)
          throw new Error("District encounter has no bounded requested speed.");
        for (const data of encounter.traffic ?? []) {
          const car = this.makeVehicle(data.id, data.kind ?? "sedan", data);
          if (!data.goal) throw new Error(`District encounter traffic ${data.id} has no declared goal.`);
          car.path = planDistrictRoute(district, car, data.goal, this.actors);
          if (!car.path.length) throw new Error(`District encounter traffic ${data.id} has no legal route.`);
          car.parking = { ...data.goal };
          car.districtTripCompleted = false;
          initializeDistrictActor(this, car);
          this.actors.push(car);
        }
        this.actors.push(...structuredClone(encounter.people ?? []));
        this.capacity = { traffic: (encounter.traffic ?? []).length, pedestrians: (encounter.people ?? []).length };
        return;
      }
      if (this.config.traffic > district.trafficSpawns.length || this.config.pedestrians > district.pedestrianSpawns.length)
        throw new Error("The requested population exceeds this district's registered spawn capacity.");
      for (let i = 0; i < this.config.traffic; i++) {
        const car = this.makeVehicle(`traffic-${i}`, carKinds[i % carKinds.length], district.trafficSpawns[i]);
        if (!this.free(car, 0.12) || !bodyOnRoad(car, this.roads))
          throw new Error(`District vehicle spawn ${i} is not physically clear.`);
        initializeDistrictActor(this, car);
        this.actors.push(car);
      }
      for (const car of this.actors.filter((actor) => actor !== this.player))
        if (!this.assignTrafficRoute(car)) throw new Error(`No district continuation for ${car.id}.`);
      for (let i = 0; i < this.config.pedestrians; i++) {
        const spawn = district.pedestrianSpawns[i];
        const road4 = district.drivingRoads.find((item) => item.id === spawn.roadId);
        if (!road4) throw new Error(`District person spawn ${i} has no registered road.`);
        const person = {
          id: `person-${i}`,
          type: "pedestrian",
          kind: PEOPLE_MODELS[i % PEOPLE_MODELS.length],
          ...spawn,
          road: road4,
          speed: 0,
          walkSpeed: this.rng.range(1.1, 1.65),
          phase: this.rng.next(),
          distance: 0,
          wait: 0,
          reason: "walking",
          target: null,
          pause: 0,
          crossing: false,
          motionMode: "ambient"
        };
        person.body = createPedestrianBody(person);
        person.radius = person.body.radiusM;
        if (!this.free(person, 0.12)) throw new Error(`District person spawn ${i} is not clear.`);
        initializeDistrictActor(this, person);
        this.nextWalk(person);
        this.actors.push(person);
      }
      this.capacity = { traffic: this.config.traffic, pedestrians: this.config.pedestrians };
    }
    assignTrafficRoute(car) {
      if (this.district) {
        const goals = this.district.trafficGoals;
        const start = Math.floor(this.rng.next() * goals.length);
        car.path = planDistrictTrafficTrip(this, car, start);
        car.cursor = 0;
        return car.path.length > 10;
      }
      const pressure = this.trafficPressure();
      for (let trial = 0; trial < 14; trial++) {
        const goal = this.rng.pick(this.junctions);
        if (!goal || distance(car, goal) < 22) continue;
        const path = planNavigation(this.graph, car, goal, this.actors, pressure);
        if (path.length > 10) {
          const end = path.at(-1), before = path.at(-2), heading2 = Math.atan2(end.x - before.x, end.z - before.z);
          const canContinue = goal.edges.some((key3) => {
            const next = this.graph.get(key3);
            return Math.abs(
              angleDelta(Math.atan2(next.x - goal.x, next.z - goal.z), heading2)
            ) < 0.1;
          });
          if (!canContinue) continue;
          const arrivalGroup = this.junctionGroups.find(
            (group) => insideJunction(goal, group)
          );
          let tail = { ...end }, valid = true;
          while (arrivalGroup && insideJunction(tail, arrivalGroup, 3)) {
            tail = {
              x: tail.x + Math.sin(heading2) * 0.65,
              z: tail.z + Math.cos(heading2) * 0.65
            };
            if (!bodyOnRoad({ ...car, ...tail, heading: heading2 }, this.roads)) {
              valid = false;
              break;
            }
            path.push(tail);
          }
          if (!valid) continue;
          car.path = path;
          car.cursor = 0;
          return true;
        }
      }
      car.path = [];
      return false;
    }
    trafficPressure() {
      if (this.pressureTick !== this.tick) {
        this.pressureTick = this.tick;
        this.pressure = junctionPressure(this.junctionGroups, this.actors);
      }
      return this.pressure;
    }
    nextWalk(person) {
      return this.district ? nextDistrictWalk(this, person) : nextWalk(this, person);
    }
    command(command, record = true) {
      if (command.type === "street-pursuit-start" || command.type === "street-pursuit-stop") {
        if (this.environment !== "metro") throw new Error("Street pursuit is only available in City");
        if (command.type === "street-pursuit-start") {
          if (this.pursuit?.phase === "running") throw new Error("A street pursuit is already running");
          const pack = isPackPursuit(command.variant);
          const training = pack && !isSurvival(command.variant);
          validatePracticeCommand(command, training || command.variant === "arcade", training);
          const resumeMode = this.mode;
          const resumeTrip = resumeMode === "auto" && Boolean(this.destination) && this.player.path.length > 1;
          beginStreetPursuit(this, command.level, command.variant, command.config);
          const { pursuit } = this;
          if (pack) this.configurePackDriver(command);
          else if (command.learn) pursuit.learner = this.arcadeLearner ??= createArcadeLearner(this.config.seed);
          pursuit.resumeMode = resumeMode;
          pursuit.resumeTrip = resumeTrip;
          const outsideStartBlock = pursuit.exits.filter((exit2) => distance(exit2, this.player) >= 30 + pursuit.level * 6);
          if (outsideStartBlock.length) pursuit.exits = outsideStartBlock;
          this.player.path = [];
          this.player.parking = null;
          this.player.cursor = 0;
          this.routeRevision++;
          this.mode = pursuit.gta ? "manual" : "auto";
        } else {
          if (this.pursuit?.phase !== "running" && !this.pursuit?.reviewUntilTick)
            throw new Error("No running street pursuit");
          if (this.pursuit.survival && !canEndSurvival(this))
            throw new Error("Move clear of the obstacle before ending Ghost mode.");
          this.pursuit.learner?.interrupt();
          endStreetPursuit(this);
          this.resumeStreetDrive();
        }
        if (record) {
          const config = this.pursuit?.gta?.config;
          const recorded = command.type === "street-pursuit-start" && config?.ruleset === "dispatch-v1" ? { ...command, config } : command;
          this.events.push({ tick: this.tick, command: structuredClone(recorded) });
        }
        return true;
      }
      if (command.type === "pursuit-use") {
        if (this.pursuit?.phase !== "running" || !this.pursuit.survival?.held || this.pursuit.survival.fireQueued)
          return false;
        this.pursuit.survival.fireQueued = true;
        if (record) this.events.push({ tick: this.tick, command: { type: "pursuit-use" } });
        return true;
      }
      if (["pursuit-run", "pursuit-drive", "pursuit-policy"].includes(command.type)) {
        if (!this.pursuit) throw new Error("Pursuit controls are only available in the pursuit mode");
        if (this.environment === "metro" && (command.type !== "pursuit-drive" || this.pursuit.phase !== "running"))
          throw new Error("Use City street pursuit controls for this event");
        if (command.type === "pursuit-run") {
          if (this.pursuit.phase !== "ready") throw new Error("Reset the pursuit before starting a new run");
          validatePracticeCommand(command, this.pursuit.packLab, this.pursuit.packLab);
          if (this.pursuit.packLab) {
            this.configurePackDriver(command);
            startPackDrill(this);
          }
          this.pursuit.phase = "running";
        } else if (command.type === "pursuit-drive") {
          this.pursuit.manualAction = { ...validatePursuitAction(command.action) };
        } else {
          this.pursuit.policy = command.weights === null ? null : structuredClone(validatePursuitPolicy(command.weights));
          this.pursuit.nextDecisionTick = 0;
        }
        if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
        return true;
      }
      if (command.type === "district-run") {
        if (!this.districtCase || this.districtCase.id === "ambient" || this.districtCase.phase !== "ready")
          throw new Error("Select and reset a district encounter before running it.");
        const path = planDistrictRoute(this.district, this.player, this.districtCase.goal, this.actors);
        if (!path.length) throw new Error("The district encounter goal is not reachable.");
        this.player.path = path;
        this.player.cursor = 0;
        this.player.parking = { ...this.districtCase.goal };
        this.destination = { ...this.districtCase.goal, name: "District encounter" };
        this.districtCase.phase = "running";
        this.districtCase.startedTick = this.tick;
        this.mode = "auto";
        if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
        return true;
      }
      if (command.type === "pedestrian-motion") {
        if (!["city", "lab", "egypt", "metro"].includes(this.environment) || this.districtCase && this.districtCase.id !== "ambient")
          throw new Error("Human motion controls are unavailable in fixed Vision and vehicle fixtures.");
        if (Object.keys(command).some((key3) => !["type", "id", "mode"].includes(key3)))
          throw new Error("Human motion accepts only a person ID and an explicit motion mode.");
        const person = this.actors.find((actor) => actor.id === command.id && actor.type === "pedestrian");
        if (!person) throw new Error("The requested person is not in this world.");
        if (!setPedestrianMotionMode(person, command.mode))
          throw new Error("Choose ambient, walk, jog or stop for an ordinary person.");
        if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
        return true;
      }
      if (command.type === "visual-observation") {
        this.visualPredictor.observe(structuredClone(command.result));
        if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
        return true;
      }
      if (command.type === "visual-reset") {
        this.visualPredictor.reset(command.streamId);
        if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
        return true;
      }
      if (command.type === "visual-mode") {
        if (!["vision-first", "sensors-only"].includes(command.mode))
          throw new Error("Unknown visual driving mode");
        this.visualMode = command.mode;
        if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
        return true;
      }
      if (command.type === "vision-run") {
        if (!this.visionLab || this.visionLab.phase !== "ready") return false;
        this.visionLab.phase = "running";
        this.visionLab.startedTick = this.tick;
        this.input = { targetSpeed: this.visionLab.requestedSpeedMps, steer: 0 };
        if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
        return true;
      }
      if (command.type === "vehicle-test") {
        if (this.environment !== "vehicle" || command.operation !== "run" || this.vehicleTest.phase !== "ready")
          return false;
        if (record)
          this.events.push({ tick: this.tick, command: structuredClone(command) });
        if (Math.abs(this.player.speed) > 0.01 || Math.abs(this.player.steer) > 0.01 || distance(this.player, vehicleStart) > 0.05 || Math.abs(angleDelta(this.player.heading, vehicleStart.heading)) > 0.01 || this.player.vehicle.damage.total > 0) {
          this.vehicleTest.error = "Stop and reset the car at the marked start before running";
          return false;
        }
        this.mode = "manual";
        this.input = { targetSpeed: 0, steer: 0 };
        this.player.path = [];
        this.player.parking = null;
        this.player.cursor = 0;
        this.destination = null;
        this.routeRevision++;
        Object.assign(this.vehicleTest, {
          phase: "running",
          startedTick: this.tick,
          error: null
        });
        return true;
      }
      if (this.vehicleTest?.phase === "running" && ["drive", "mode", "destination", "scenario"].includes(command.type))
        return false;
      if (this.environment === "metro" && (this.pursuit?.phase === "running" || this.pursuit?.reviewUntilTick) && command.type === "destination")
        return false;
      if (command.type === "policy" && command.weights)
        validatePolicy(command.weights);
      if (record)
        this.events.push({ tick: this.tick, command: structuredClone(command) });
      if (command.type === "drive")
        this.input = {
          targetSpeed: clamp(
            Number(command.targetSpeed) || 0,
            -2.5,
            this.player.maxSpeed
          ),
          steer: clamp(
            Number(command.steer) || 0,
            -VEHICLE.maxSteer,
            VEHICLE.maxSteer
          )
        };
      if (command.type === "mode")
        this.mode = command.mode === "auto" ? "auto" : "manual";
      if (command.type === "policy") {
        this.policy = command.weights ? validatePolicy(command.weights) : null;
        return true;
      }
      if (command.type === "stop") {
        if (this.vehicleTest?.phase === "running") {
          this.vehicleTest.phase = "ready";
          this.vehicleTest.error = "Test stopped; reset the car before another run";
        }
        if (this.visionLab && this.visionLab.phase !== "complete") {
          this.visionLab.error = "Driver stopped this bounded test. Reset to run again.";
          if (this.player.speed === 0) this.visionLab.phase = "complete";
        }
        this.mode = "manual";
        this.input = { targetSpeed: 0, steer: 0 };
        this.player.path = [];
        this.player.parking = null;
        this.player.cursor = 0;
        this.destination = null;
        this.routeRevision++;
      }
      if (command.type === "scenario") return triggerScenario(this, command.kind);
      if (command.type === "destination" && Number.isFinite(command.place?.x) && Number.isFinite(command.place?.z)) {
        const arrival = this.environment === "city" ? planArrival(this, command.place) : null;
        const path = arrival?.path ?? (this.district ? planDistrictRoute(this.district, this.player, command.place, this.actors) : this.environment === "lab" ? planNavigation(this.graph, this.player, command.place, this.actors) : []);
        if (path.length) {
          this.destination = { ...command.place };
          this.player.path = path;
          this.player.parking = this.district ? { ...command.place } : arrival?.parking ?? null;
          this.player.cursor = 0;
          this.mode = "auto";
          this.routeRevision++;
          return true;
        }
        this.player.reason = "no-route";
        return false;
      }
      return true;
    }
    // Predict vehicles in the intended corridor, rather than braking for an
    // inflated circle around everything, including traffic in the opposite lane.
    safeSpeed(car, command, usePlannedPath = true) {
      return safeSpeed(this, car, command, usePlannedPath);
    }
    pedestrianMotion(p) {
      return pedestrianMotion(this, p);
    }
    districtDrivingCommand(actor, requested, ownMotion, nowS, usePlannedPath = true) {
      const behavior = capCityEncounter(this, actor, districtTrafficCommand(this, actor, requested));
      const previousState = this.districtSpeedState;
      const predictive = actor === this.player && this.mode === "auto";
      const composed = predictive ? composeDistrictSpeed(behavior, {
        visual: decideDistrictVisualSpeed({
          visual: this.visualState,
          ego: ownMotion,
          requestedSpeedMps: Math.max(0, behavior.targetSpeed),
          nowS,
          visionRequired: this.visualMode === "vision-first",
          previousState,
          cityLead: this.config.cityVersion >= 3
        }),
        map: mappedDistrictSpeed({ zones: this.district.cautionZones, ego: ownMotion }),
        dt: STEP,
        previousState
      }) : behavior;
      if (predictive) this.districtSpeedState = composed.nextState;
      const safe = this.safeSpeed(actor, composed, usePlannedPath);
      const command = attributeDistrictApplied({ requested, behavior, composed, safe });
      actor.districtSources = command.districtSources;
      if (actor === this.player && this.districtCase && this.districtCase.id !== "ambient") {
        if (safe.targetSpeed < composed.targetSpeed - 0.05 && this.districtCase.firstReactiveBrakeS === null)
          this.districtCase.firstReactiveBrakeS = nowS;
        if (["camera-pixels", "both"].includes(command.districtSources?.appliedSource) && command.targetSpeed === 0 && this.districtCase.firstVisualBrakeS === null)
          this.districtCase.firstVisualBrakeS = nowS;
      }
      return command;
    }
    resumeStreetDrive() {
      this.mode = this.pursuit.resumeMode;
      this.input = { targetSpeed: 0, steer: 0 };
      const goal = this.destination;
      const path = goal && this.pursuit.resumeTrip ? planDistrictRoute(this.district, this.player, goal, this.actors) : [];
      this.player.path = path;
      this.player.cursor = 0;
      this.player.parking = path.length ? { ...goal } : null;
      this.pursuit.tripResumed = path.length > 0;
      this.routeRevision++;
      if (this.pursuit.resumeTrip && !path.length) this.player.reason = "no-route";
    }
    configurePackDriver(command) {
      const pursuit = this.pursuit;
      const checkpoint = command.checkpoint ?? (isCityHunt(pursuit.variant) ? starterPackPolicy() : null);
      if (command.learn) {
        pursuit.driver = "training";
        pursuit.learner = createPackLearner(this.config.seed, checkpoint, true);
      } else if (checkpoint) {
        pursuit.driver = command.checkpoint ? command.localPolicy === true ? "local-policy" : "lab-policy" : "starter";
        pursuit.learner = createPackLearner(this.config.seed, checkpoint, false);
      }
    }
    followTrafficTrip(actor) {
      if (!actor.path.length && this.tick % 120 === 0) this.assignTrafficRoute(actor);
      freezePath(actor.path);
      let command = followPath(actor, actor.path, actor.cursor);
      actor.cursor = command.cursor;
      if (actor.path.length && command.remaining < 1.5) {
        this.metrics.trafficTrips++;
        this.assignTrafficRoute(actor);
        freezePath(actor.path);
        command = followPath(actor, actor.path, 0);
      }
      return command;
    }
    stepPursuitMode(ownMotion = null, nowS = null) {
      const pursuit = this.pursuit;
      const street = this.environment === "metro";
      const learner = pursuit.learner;
      let action = pursuit.manualAction ?? PURSUIT_STOP;
      if (this.mode === "auto") {
        if (!pursuit.decision || this.tick >= (pursuit.nextDecisionTick ?? 0)) {
          const observed = observePursuit(this);
          if (street) observed.street = true;
          if (pursuit.response) observed.cinematic = true;
          if (pursuit.variant === "arcade") observed.arcade = true;
          if (isPackPursuit(pursuit.variant)) observed.pack = true;
          if (street && usesRushPace(pursuit.variant)) observed.rush = true;
          if (this.tick >= (pursuit.nextRouteTick ?? 0)) {
            const previous = pursuit.route;
            pursuit.route = street ? selectStreetPursuitRoute(observed, this.district, previous) : selectPursuitRoute(observed, previous);
            if (previous?.id !== pursuit.route?.id) pursuit.routeChanges = (pursuit.routeChanges ?? 0) + 1;
            this.player.path = pursuit.route?.path ?? [];
            this.routeRevision++;
            pursuit.nextRouteTick = this.tick + (observed.rush ? 42 : street ? 60 : 36);
          }
          pursuit.decision = decidePursuit(
            observed,
            pursuit.route,
            learner?.weights ?? pursuit.policy,
            learner?.choose ?? pursuit.trainingChoice
          );
          if (isCityHunt(pursuit.variant)) pursuit.recovery = pursuit.decision.recovery ?? null;
          learner?.record(pursuit.decision, pursuit.metrics);
          pursuit.nextDecisionTick = this.tick + PURSUIT_DECISION_TICKS;
        }
        action = pursuit.decision.action;
      } else {
        pursuit.decision = null;
        if (isCityHunt(pursuit.variant)) pursuit.recovery = null;
        learner?.interrupt();
        if (pursuit.survival && !action.brake && action.gear === 1)
          action = { ...action, throttle: 1 };
      }
      if (!street) {
        stepPursuit(this, action);
        if (pursuit.phase !== "running") learner?.finish(pursuit.metrics, pursuit.phase);
        return;
      }
      if (!usesRushPace(pursuit.variant)) this.actorIndex = new SpatialIndex(this.actors);
      updateDistrictTraffic(this);
      let query;
      const targetBlocker = pursuit.response?.dispatch ? (target) => (query ??= createWalkTargetQuery(this.actors))(target) : void 0;
      stepPursuit(this, action, {
        pedestrianMotion: (actor) => stepDistrictPedestrian(this, actor, targetBlocker),
        vehicleCommand: (actor, requested) => pursuit.gta && (pursuit.patrols.has(actor) || actor === this.player && this.mode === "manual") ? requested : actor.pursuitRole === "police" ? districtTrafficCommand(this, actor, requested) : this.districtDrivingCommand(
          actor,
          requested ?? this.followTrafficTrip(actor),
          ownMotion,
          nowS,
          actor !== this.player
        )
      });
      if (pursuit.phase !== "running") {
        learner?.finish(pursuit.metrics, pursuit.phase);
        if (!pursuit.reviewUntilTick) this.resumeStreetDrive();
      }
    }
    step() {
      if (this.pursuit?.gta && this.pursuit.phase !== "running") this.pursuit.stepEvents.length = 0;
      if (stepPackReview(this)) return;
      if (this.environment === "pursuit" && this.pursuit.phase !== "running") return;
      if (this.visionLab && this.visionLab.phase !== "running") return;
      if (this.districtCase && this.districtCase.id !== "ambient" && this.districtCase.phase !== "running") return;
      const nowS = this.tick * STEP;
      const ownMotion = {
        x: this.player.x,
        z: this.player.z,
        headingRad: this.player.heading,
        speedMps: this.player.speed,
        lengthM: this.player.length,
        widthM: this.player.width
      };
      this.visualState = this.visualPredictor.snapshot(nowS, ownMotion);
      this.visualDecision = this.visualState.decision;
      if (this.cityEncounters) advanceCityEncounters(this);
      if (this.pursuit?.phase === "running") {
        this.stepPursuitMode(ownMotion, nowS);
        return;
      }
      if (this.district) updateDistrictTraffic(this);
      if (this.environment !== "vehicle") updateScenarios(this);
      this.actorIndex = new SpatialIndex(this.actors);
      this.updateJunctions();
      const reserved = new SpatialIndex(this.actors.map(copyPose2));
      for (const actor of this.actors) {
        actor.previous = copyPose2(actor);
        let next;
        let appliedCommand;
        let contact = null;
        let controlledTest = actor === this.player && this.vehicleTest?.phase === "running";
        if (controlledTest && this.tick - this.vehicleTest.startedTick >= this.vehicleTest.maxTicks) {
          this.vehicleTest.phase = "ready";
          this.vehicleTest.error = "Contact was not reached within the bounded test; reset the car";
          this.input = { targetSpeed: 0, steer: 0 };
          controlledTest = false;
        }
        const physicalBarrier = actor === this.player && this.environment === "vehicle" && (controlledTest || this.vehicleTest.phase === "contact");
        if (actor.type === "pedestrian") next = this.district ? this.districtCase && this.districtCase.id !== "ambient" ? advanceDistrictCase(this, actor) : stepDistrictPedestrian(this, actor) : this.visionLab ? advanceVisionActor(actor, STEP, {
          timeS: (this.tick - this.visionLab.startedTick) * STEP,
          tick: this.tick
        }) : this.pedestrianMotion(actor);
        else {
          let command;
          if (controlledTest)
            command = {
              targetSpeed: this.vehicleTest.maxSpeedMps,
              steer: 0,
              reason: "vehicle-test",
              blockedBy: null
            };
          else if (actor === this.player && this.mode === "manual")
            command = { ...this.input };
          else {
            if (!actor.path.length && actor !== this.player && !(this.districtCase && this.districtCase.id !== "ambient") && this.tick % 120 === 0)
              this.assignTrafficRoute(actor);
            if (this.district) freezePath(actor.path);
            command = followPath(actor, actor.path, actor.cursor);
            actor.cursor = command.cursor;
            if (actor.parking && (!this.district || distance(actor, actor.parking) < 14 && Math.abs(angleDelta(actor.heading, actor.parking.heading)) < 0.35)) {
              const toStop = (actor.parking.x - actor.x) * Math.sin(actor.parking.heading) + (actor.parking.z - actor.z) * Math.cos(actor.parking.heading);
              command.targetSpeed = Math.min(
                command.targetSpeed,
                toStop < 26 ? 2.5 : actor.maxSpeed,
                Math.sqrt(Math.max(0, toStop - 0.25) * 3.2)
              );
            }
            if (actor.path.length && (actor.parking ? Math.abs(actor.speed) < 0.05 && distance(actor, actor.parking) < 0.8 && (!this.district || Math.abs(angleDelta(actor.heading, actor.parking.heading)) <= 0.2) : command.remaining < 1.5)) {
              if (actor === this.player) {
                actor.path = [];
                this.metrics.completedTrips++;
                this.routeRevision++;
                command.targetSpeed = 0;
                actor.reason = "arrived";
              } else {
                this.metrics.trafficTrips++;
                if (this.districtCase && this.districtCase.id !== "ambient") {
                  actor.path = [];
                  actor.districtTripCompleted = true;
                  command.targetSpeed = 0;
                } else {
                  this.assignTrafficRoute(actor);
                  command = followPath(actor, actor.path, 0);
                }
              }
            }
          }
          if (actor === this.player && this.mode === "auto" && command.targetSpeed > 0)
            command.targetSpeed = policySpeed(this, actor, command.targetSpeed);
          if (actor === this.player && this.districtCase && this.districtCase.id !== "ambient")
            command.targetSpeed = this.districtCase.error ? 0 : Math.min(command.targetSpeed, this.districtCase.requestedSpeedMps);
          if (this.district) command = this.districtDrivingCommand(actor, command, ownMotion, nowS);
          else {
            const predictedBrake = !controlledTest && actor === this.player && this.visualMode === "vision-first" && this.visualDecision?.available === true && this.visualDecision.brake === true;
            const reactiveCommand = controlledTest ? command : this.safeSpeed(actor, command);
            if (actor === this.player && this.visionLab && reactiveCommand.targetSpeed < command.targetSpeed - 0.1 && this.visionLab.firstReactiveBrakeS === null)
              this.visionLab.firstReactiveBrakeS = nowS;
            const appliedVisualBrake = predictedBrake && reactiveCommand.targetSpeed > 0;
            command = appliedVisualBrake ? { ...reactiveCommand, targetSpeed: 0, reason: "visual-prediction" } : reactiveCommand;
            if (appliedVisualBrake && this.visionLab?.firstVisualBrakeS === null)
              this.visionLab.firstVisualBrakeS = nowS;
          }
          appliedCommand = command;
          next = integrateVehicle(actor, command, STEP);
          next.reason = actor === this.player && !actor.path.length && this.destination && this.metrics.completedTrips ? "arrived" : command.reason;
          next.blockedBy = command.blockedBy;
        }
        if (physicalBarrier) {
          const barrier2 = this.statics.find(
            (body) => body.id === this.vehicleTest.barrierId
          );
          if (barrier2) {
            contact = resolveVehicleContact(actor, next, barrier2, STEP);
            if (contact) next = contact.body;
          }
        }
        const nearby = reserved.near(actor, 8).filter((a) => a.id !== actor.id).concat(this.staticIndex.near(actor, 11)).filter(
          (a) => !physicalBarrier || a.id !== this.vehicleTest.barrierId
        );
        const guard = sweepSafe(
          actor,
          next,
          nearby,
          actor.type === "vehicle" ? this.roads : null
        );
        if (!guard.safe) {
          contact = null;
          next = {
            ...actor,
            heading: actor.type === "pedestrian" ? next.heading : actor.heading,
            speed: 0,
            steer: next.steer ?? actor.steer,
            reason: guard.reason,
            blockedBy: guard.actor
          };
          if (actor === this.player && actor.reason !== guard.reason)
            this.metrics.interventions++;
          if (this.district && actor.districtSources)
            next.districtSources = { ...actor.districtSources, finalMps: 0, appliedSource: "physical-guard" };
        }
        if (actor === this.player) {
          next.vehicle = advanceVehicleState(actor, next, appliedCommand, STEP, {
            tick: this.tick,
            contact
          });
          if (contact) {
            this.vehicleTest.phase = "contact";
            this.vehicleTest.contactTick = this.tick;
            this.vehicleTest.impact = {
              ...next.vehicle.damage.lastImpact,
              hitId: contact.hitId
            };
            this.input = { targetSpeed: 0, steer: 0 };
          }
        }
        const moved = distance(actor, next);
        if (actor.type === "pedestrian") {
          next.accelerationMps2 = (next.speed - actor.speed) / STEP;
          next.motionTimeS = (this.tick + 1) * STEP;
        }
        const oldPrevious = actor.previous;
        Object.assign(actor, next, {
          previous: oldPrevious,
          distance: actor.distance + moved,
          wait: moved < 1e-3 ? actor.wait + STEP : 0
        });
        reserved.add(copyPose2(actor));
        if (actor === this.player) {
          this.metrics.distance += moved;
          if (moved < 1e-3 && this.mode === "auto" && actor.path.length)
            this.metrics.waitSeconds += STEP;
        }
      }
      this.updateSensors(this.tick % 6 === 0);
      Object.assign(
        this.metrics,
        trafficQueueStats(
          this.actors,
          (actor) => signalSpeedLimit(this, actor) === Infinity
        )
      );
      this.metrics.peakTrafficWait = Math.max(
        this.metrics.peakTrafficWait,
        this.metrics.longestCurrentTrafficWait
      );
      this.tick++;
      if (this.districtCase && this.districtCase.id !== "ambient") {
        const state = this.districtCase;
        const elapsedS = (this.tick - state.startedTick) * STEP;
        const start = state.playerStart;
        if (state.firstLaneEntryS === null && this.actors.some((actor) => actor.type === "pedestrian" && Math.abs(
          (actor.x - start.x) * Math.cos(start.heading) - (actor.z - start.z) * Math.sin(start.heading)
        ) <= this.player.width / 2 + actor.radius))
          state.firstLaneEntryS = elapsedS;
        if (this.destination && !this.player.path.length && this.player.speed === 0 && distance(this.player, state.goal) <= 0.8 && this.actors.filter((actor) => actor.type === "vehicle" && actor !== this.player).every((actor) => actor.districtTripCompleted)) {
          state.phase = "complete";
          state.completedAtS = elapsedS;
        }
        if (elapsedS > 90 && state.phase !== "complete") {
          state.error = "The district encounter did not reach its declared goal.";
          this.input = { targetSpeed: 0, steer: 0 };
        }
      }
      if (this.visionLab) {
        const state = this.visionLab;
        const timeS = this.tick * STEP;
        if (state.firstSensorTriggerS === null && this.sensors.rawM.some((range) => range <= 5))
          state.firstSensorTriggerS = timeS;
        if (state.firstLaneEntryS === null && this.actors.some((actor) => actor.type === "pedestrian" && Math.abs(actor.x) < this.player.width / 2 + actor.radius))
          state.firstLaneEntryS = timeS;
        if (timeS >= 24 && this.player.z < state.goalZ)
          state.error = "The bounded case timed out before reaching its goal.";
        if (this.player.z >= state.goalZ || state.error)
          this.input = { targetSpeed: 0, steer: 0 };
        if ((this.player.z >= state.goalZ || state.error) && this.player.speed === 0) {
          state.phase = "complete";
          state.completedAtS = timeS;
        }
      }
    }
    updateJunctions() {
      return updateJunctions(this);
    }
    audit() {
      const errors = [];
      const ghost = this.pursuit?.survival?.active?.kind === "ghost";
      for (let i = 0; i < this.actors.length; i++) {
        const actor = this.actors[i];
        if (![actor.x, actor.z, actor.heading, actor.speed].every(Number.isFinite))
          errors.push(`non-finite:${actor.id}`);
        if (actor.type === "vehicle" && !bodyOnRoad(actor, this.roads))
          errors.push(`off-road:${actor.id}`);
        for (const other of [...this.actors.slice(i + 1), ...this.statics])
          if (!(ghost && survivalGhostPair(this, actor, other)) && overlaps(actor, other))
            errors.push(`overlap:${actor.id}:${other.id}`);
      }
      return errors;
    }
    snapshot() {
      return {
        version: VERSION,
        environment: this.environment,
        config: this.config,
        tick: this.tick,
        mode: this.mode,
        policy: this.policy?.id ?? null,
        destination: this.destination,
        rng: this.rng.state,
        metrics: { ...this.metrics },
        scenario: this.scenario,
        vehicleTest: this.vehicleTest ? structuredClone(this.vehicleTest) : null,
        sensors: this.sensors,
        visualMode: this.visualMode,
        visualState: this.visualState ? structuredClone(this.visualState) : null,
        visionLab: this.visionLab ? structuredClone(this.visionLab) : null,
        ...this.pursuit ? { pursuit: pursuitSnapshot(this) } : {},
        ...this.cityEncounters ? { cityEncounters: {
          nextTick: this.cityEncounters.nextTick,
          rng: this.cityEncounters.rng.state,
          events: this.cityEncounters.events.map((event2) => ({ ...event2 }))
        } } : {},
        ...this.district ? {
          district: {
            id: this.district.id,
            version: this.district.version,
            case: this.districtCase ? structuredClone(this.districtCase) : null,
            speedState: structuredClone(this.districtSpeedState),
            behavior: districtBehaviorDiagnostics(this)
          }
        } : {},
        statics: this.statics.map((a) => ({ ...a })),
        actors: this.actors.map((a) => ({
          id: a.id,
          type: a.type,
          x: a.x,
          z: a.z,
          heading: a.heading,
          speed: a.speed,
          steer: a.steer ?? 0,
          distance: a.distance,
          reason: a.reason,
          cursor: a.cursor ?? 0,
          ...this.pursuit && a.pursuitRole ? { pursuitRole: a.pursuitRole, policeTactic: a.policeTactic } : {},
          ...a.vehicle ? { vehicle: structuredClone(a.vehicle) } : {},
          ...this.district && a.districtSources ? { districtSources: structuredClone(a.districtSources) } : {},
          ...a.type === "pedestrian" ? {
            body: structuredClone(a.body),
            motionMode: a.motionMode,
            accelerationMps2: a.accelerationMps2,
            motionTimeS: a.motionTimeS,
            ...a.impact ? { impact: { ...a.impact } } : {}
          } : {}
        }))
      };
    }
    replay() {
      return {
        version: VERSION,
        environment: this.environment,
        config: this.config,
        totalTicks: this.tick,
        events: structuredClone(this.events)
      };
    }
    static *reconstruct(data, shouldYield) {
      if (data?.version !== VERSION || !["city", "lab", "vehicle", "vision", "egypt", "pursuit", "metro"].includes(data.environment) || !Number.isSafeInteger(data.totalTicks) || data.totalTicks < 0 || data.totalTicks > 60 * 60 * 24 || !Array.isArray(data.events))
        throw new Error("Unsupported replay");
      let lastTick = -1;
      for (const event2 of data.events) {
        if (!Number.isSafeInteger(event2.tick) || event2.tick < 0 || event2.tick < lastTick || event2.tick > data.totalTicks || ![
          "drive",
          "mode",
          "destination",
          "scenario",
          "stop",
          "policy",
          "visual-observation",
          "visual-reset",
          "visual-mode",
          "vision-run",
          "vehicle-test",
          "pedestrian-motion",
          "district-run",
          "pursuit-run",
          "pursuit-drive",
          "pursuit-use",
          "pursuit-policy",
          "street-pursuit-start",
          "street-pursuit-stop"
        ].includes(event2.command?.type) || event2.command.type === "vehicle-test" && (data.environment !== "vehicle" || event2.command.operation !== "run"))
          throw new Error("Invalid replay event");
        lastTick = event2.tick;
      }
      const world = new _World(data.config, data.environment);
      let index = 0;
      while (world.tick < data.totalTicks) {
        while (index < data.events.length && data.events[index].tick === world.tick)
          world.command(data.events[index++].command);
        const beforeTick = world.tick;
        world.step();
        if (world.tick === beforeTick)
          throw new Error("Replay cannot advance a stopped scene without its recorded run event");
        if (world.tick % 120 === 0 || shouldYield?.()) yield world;
      }
      while (index < data.events.length && data.events[index].tick === world.tick)
        world.command(data.events[index++].command);
      return world;
    }
    static fromReplay(data) {
      const steps = _World.reconstruct(data);
      let result = steps.next();
      while (!result.done) result = steps.next();
      return result.value;
    }
  };
  function validatePracticeCommand(command, canLearn, canLoad) {
    if (command.learn !== void 0 && (!canLearn || typeof command.learn !== "boolean"))
      throw new TypeError("Practice needs a boolean option on a learning pursuit");
    if (command.checkpoint !== void 0) {
      if (!canLoad) throw new TypeError("A Lab checkpoint requires a pack pursuit");
      validatePackPolicy(command.checkpoint);
    }
  }

  // src/rl/pursuit-shield.js
  var kinds = /* @__PURE__ */ new Set(["static", "civilian", "pedestrian", "police"]);
  var verifiedFrames = /* @__PURE__ */ new WeakSet();
  var trafficHistory = /* @__PURE__ */ new WeakMap();
  var angleStep = Math.PI * 2 / PURSUIT_SCAN_RAYS;
  function requireDispatchScan({ pursuit, tick }) {
    const scan = pursuit?.gta?.scan;
    const ageTicks = tick - scan?.tick;
    if (!scan || !Number.isSafeInteger(scan.tick) || scan.tick < 0 || !Number.isInteger(ageTicks) || ageTicks < 0 || ageTicks >= PURSUIT_SCAN_TICKS)
      throw new Error("Pursuit brake guard needs a current scan");
    if (!verifiedFrames.has(scan)) {
      if (!Object.isFrozen(scan) || !Array.isArray(scan.rays) || !Object.isFrozen(scan.rays) || scan.rays.length !== PURSUIT_SCAN_RAYS || !Array.isArray(scan.tracks) || !Object.isFrozen(scan.tracks) || scan.rays.some((ray) => !ray || !Object.isFrozen(ray) || ray.kind !== "none" && !kinds.has(ray.kind) || !Number.isFinite(ray.rangeM) || ray.rangeM < 0 || ray.rangeM > PURSUIT_SCAN_RANGE_M) || scan.tracks.some((track2) => !track2 || !Object.isFrozen(track2) || !kinds.has(track2.kind) || ![track2.rightM, track2.forwardM, track2.rightMps, track2.forwardMps, track2.ageS].every(Number.isFinite) || track2.ageS < 0 || track2.ageS > PURSUIT_TRACK_TTL_S || typeof track2.motionKnown !== "boolean" || track2.ttcS !== null && (!Number.isFinite(track2.ttcS) || track2.ttcS < 0)))
        throw new Error("Malformed pursuit scan");
      verifiedFrames.add(scan);
    }
    return scan;
  }
  function nearObservedSegment(point2, frame) {
    for (let i = 0; i < frame.length; i++) {
      const a = frame[i], b = frame[(i + 1) % frame.length];
      if (!a || !b) continue;
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      if (length < 0.02 || length > 0.9) continue;
      const t = ((point2.x - a.x) * dx + (point2.z - a.z) * dz) / (length * length);
      if (t >= -0.14 / length && t <= 1 + 0.14 / length && Math.hypot(a.x + t * dx - point2.x, a.z + t * dz - point2.z) <= 0.075) return true;
    }
    return false;
  }
  function measuredLoadingTraffic(world, scan) {
    if (world.tick !== scan.tick) return null;
    const { player, pursuit } = world;
    const old = trafficHistory.get(pursuit);
    if (old?.tick === scan.tick) return old;
    const frames = old?.tick === scan.tick - PURSUIT_SCAN_TICKS ? old.frames.slice(-2) : [];
    const points = scan.rays.map((ray, i) => {
      if (ray.kind !== "civilian" || ray.rangeM > 14) return null;
      const heading2 = player.heading + i * angleStep;
      return { x: player.x + Math.sin(heading2) * ray.rangeM, z: player.z + Math.cos(heading2) * ray.rangeM };
    });
    const current = { tick: scan.tick, frames: [...frames, points], stable: (i) => {
      const point2 = points[i];
      return Boolean(point2 && frames.length === 2 && frames.every((frame) => nearObservedSegment(point2, frame)));
    } };
    trafficHistory.set(pursuit, current);
    return current;
  }
  function stoppingSweep(world, scan, requested, reaction, reach, includeTraffic) {
    const { player } = world;
    const returns = [];
    for (const [i, ray] of scan.rays.entries()) {
      if (ray.kind === "none" || ray.kind !== "static" && !includeTraffic || ray.rangeM > reach + player.length + 2) continue;
      const heading2 = player.heading + i * angleStep;
      returns.push({
        type: "pedestrian",
        radius: 0.1 + ray.rangeM * Math.sin(angleStep / 2) + (ray.kind === "static" ? 0 : 0.18),
        x: player.x + Math.sin(heading2) * ray.rangeM,
        z: player.z + Math.cos(heading2) * ray.rangeM
      });
    }
    const brake = { ...requested, throttle: 0, brake: 1 };
    const delayTicks = Math.ceil(reaction / STEP);
    let pose5 = { ...vehicleProbe(player, player.speed), gtaSlipMps: player.gtaSlipMps, gtaYawRate: player.gtaYawRate };
    for (let i = 0; i < 180; i++) {
      const action = i < delayTicks ? requested : brake;
      const next = integrateVehicle(pose5, pursuitCommand(pose5, action), STEP);
      integrateGtaSlip(pose5, next);
      if (!sweepSafe(pose5, next, returns, world.roads).safe) return false;
      if (i >= delayTicks && Math.abs(next.speed) < 0.02 && Math.abs(next.gtaSlipMps) < 0.02) return true;
      pose5 = next;
    }
    return false;
  }
  function guardDispatchAction(world, requested) {
    const scan = requireDispatchScan(world);
    const { player, tick } = world;
    const ageTicks = tick - scan.tick;
    const evidence = measuredLoadingTraffic(world, scan);
    if (requested.brake === 1) return { action: requested, reason: null };
    const speed = Math.abs(player.speed), direction3 = speed > 0.1 ? Math.sign(player.speed) : requested.gear;
    const braking = player.spec?.braking ?? VEHICLE.braking;
    const reaction = (ageTicks + PURSUIT_SCAN_TICKS) * STEP + 0.12;
    const length = player.length / 2, width = player.width / 2;
    const reach = length + 0.65 + speed * reaction + speed * speed / (2 * braking);
    const horizon = Math.min(3, reaction + speed / braking);
    const sway = Math.abs(player.gtaSlipMps ?? 0) * reaction;
    const inside = (right, forward2, pad = 0) => {
      const along2 = forward2 * direction3;
      return along2 >= 0 && along2 <= reach + pad && Math.abs(right) <= width + 0.27 + sway + pad;
    };
    const stop = (reason) => ({ action: { ...requested, throttle: 0, brake: 1 }, reason });
    let sweepReason = null;
    const checkTurn = ageTicks === 0 && world.roads && Math.abs(requested.steer) >= 0.1;
    const pedestrianNear = scan.tracks.some((track2) => track2.kind === "pedestrian" && Math.hypot(track2.rightM, track2.forwardM) < reach + 4);
    const nearLoading = (index, vx = 0, vz = 0) => {
      const ray = scan.rays[index];
      return checkTurn && !pedestrianNear && direction3 === 1 && requested.gear === 1 && speed <= 8 && ray.kind === "civilian" && evidence?.stable(index) && Math.abs(vz) <= 0.8 + ray.rangeM * 0.12 && Math.abs(vx) <= 0.7 + ray.rangeM * 0.55;
    };
    for (const track2 of scan.tracks) {
      if (track2.kind === "static") continue;
      const pedestrian = track2.kind === "pedestrian";
      const freshMotion = track2.motionKnown && track2.ageS === 0;
      let vx = track2.rightMps + (player.gtaSlipMps ?? 0);
      const vz = track2.forwardMps + player.speed;
      const index = (Math.round(Math.atan2(track2.rightM, track2.forwardM) / angleStep) + PURSUIT_SCAN_RAYS) % PURSUIT_SCAN_RAYS;
      const admitSweep = track2.kind === "civilian" && freshMotion && nearLoading(index, vx, vz);
      if (inside(track2.rightM, track2.forwardM, (0.18 + 1.2 * track2.ageS) * Number(pedestrian || track2.ageS > 0))) {
        if (!admitSweep) return stop(track2.kind);
        sweepReason = "civilian";
      }
      if (!freshMotion) continue;
      if (!pedestrian && direction3 * track2.forwardM < 0 && direction3 * vz > 0) continue;
      if (pedestrian) {
        const sampleWidth = Math.hypot(track2.rightM, track2.forwardM) * 0.01;
        if (Math.abs(vx) * PURSUIT_SCAN_TICKS * STEP <= sampleWidth) vx = 0;
      }
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        const t = horizon * fraction;
        if (inside(track2.rightM + vx * t, track2.forwardM + vz * t, pedestrian ? 0.4 : 0.15)) {
          if (!admitSweep) return stop(track2.kind);
          sweepReason = "civilian";
        }
      }
    }
    for (let i = 0; i < scan.rays.length; i++) {
      const { rangeM, kind } = scan.rays[i];
      if (kind === "none") continue;
      const angle = i * angleStep;
      if (!inside(rangeM * Math.sin(angle), rangeM * Math.cos(angle), kind === "pedestrian" ? 0.2 : 0)) continue;
      if (kind !== "static") {
        if (!nearLoading(i)) return stop(kind);
        sweepReason = "civilian";
      } else sweepReason ??= "static";
    }
    if (sweepReason && (!checkTurn || !stoppingSweep(world, scan, requested, reaction, reach, sweepReason === "civilian")))
      return stop(sweepReason);
    return { action: requested, reason: null };
  }

  // src/rl/pursuit-pocket-scenario.js
  var sites = Object.freeze({
    "civic-souq": ["civic-avenue", "souq-collector", 1, 1, 6.7],
    "gateway-station": ["gateway-avenue", "station-avenue", 1, -1, 7.35],
    "gateway-university": ["university-avenue", "gateway-avenue", 1, -1, 7],
    "corniche-station": ["corniche-avenue", "station-avenue", 1, 1, 7.7],
    "civic-university": ["civic-avenue", "university-avenue", 1, -1, 8.6]
  });
  function stagePocketCourse(world, id) {
    const [, name, mode] = /^pocket-([a-z-]+):(open|boxed)$/.exec(id) ?? [];
    if (!Object.hasOwn(sites, name) || world.tick !== 0 || world.environment !== "metro" || world.pursuit)
      throw new RangeError("Unknown or late Metro pocket course");
    const [approachId, exitId, input, output, approachM] = sites[name];
    const { player, district } = world;
    const approach2 = world.drivingRoads.find((road4) => road4.id === approachId);
    const exit2 = world.drivingRoads.find((road4) => road4.id === exitId);
    if (!approach2 || !exit2 || approach2.axis === exit2.axis) throw new Error("Missing pocket junction");
    const center = approach2.axis === "z" ? { x: approach2.fixed, z: exit2.fixed } : { x: exit2.fixed, z: approach2.fixed };
    const rng = new Random(`${world.config.seed}:${name}:pocket-v1`);
    const start = districtRoadPose(approach2, exit2.fixed - input * (approachM + rng.range(-0.16, 0.16)), input);
    const speed = rng.range(3.1, 3.5);
    const goal = {
      ...districtRoadPose(exit2, approach2.fixed + 33 * output, output),
      roadId: exit2.id,
      id: `${name}-pocket-goal`
    };
    const ego = { ...player, ...start, speed };
    const path = planDistrictRoute(district, ego, goal);
    if (!bodyOnRoad(ego, world.roads) || path.length < 20 || path.length > 200 || world.statics.concat(world.actors).some((body) => body !== player && overlaps(body, ego, 0.12)))
      throw new Error(`No checked pocket approach to ${name}`);
    const halfX = approach2.axis === "x" ? 11.5 : 8.2, halfZ = approach2.axis === "z" ? 11.5 : 8.2;
    const thickness = 0.7;
    const sides = [["x", -1], ["x", 1], ["z", -1], ["z", 1]];
    const wall2 = ([axis, sign]) => ({
      id: `metro-lab-${name}-wall-${axis}-${sign}`,
      type: "static",
      kind: "barrier",
      height: 0.85,
      x: center.x + (axis === "x" ? sign * (halfX + thickness / 2) : 0),
      z: center.z + (axis === "z" ? sign * (halfZ + thickness / 2) : 0),
      heading: 0,
      width: axis === "x" ? thickness : 2 * (halfX + thickness),
      length: axis === "z" ? thickness : 2 * (halfZ + thickness)
    });
    const gate = wall2([exit2.axis, output]);
    const walls = sides.map(wall2).filter((body) => mode === "boxed" || body.id !== gate.id);
    if (walls.some((body) => overlaps(body, ego, 0.12) || world.actors.some((other) => other !== player && overlaps(body, other, 0.12))))
      throw new Error(`The pocket wall at ${name} intersects a starting body`);
    Object.assign(player, start, { speed });
    world.statics = world.statics.concat(walls);
    const patrolStart = { ...districtRoadPose(exit2, approach2.fixed + 45 * output, output), speed: 4.5 };
    return Object.freeze({
      id,
      name,
      mode,
      goal: Object.freeze(goal),
      roadId: exit2.id,
      barrierId: gate.id,
      patrolStart: Object.freeze(patrolStart),
      wallIds: Object.freeze(walls.map((body) => body.id)),
      axis: exit2.axis,
      sign: output,
      exitPlane: center[exit2.axis] + output * ((exit2.axis === "x" ? halfX : halfZ) + thickness),
      heading: goal.heading,
      center: Object.freeze(center),
      halfX,
      halfZ
    });
  }

  // src/rl/pursuit-reverse-scenario.js
  var EAST = Math.PI / 2;
  var RESET_GAP_M = 0.15;
  function stageReverseCourse(world, id) {
    if (id !== "L07" && id !== "L07-blocked" || world.environment !== "metro" || world.tick !== 0 || world.pursuit)
      throw new RangeError("Unknown or late Metro reverse Lab scenario");
    const avenue2 = world.drivingRoads.find((road4) => road4.id === "tahrir-boulevard");
    const exit2 = world.drivingRoads.find((road4) => road4.id === "civic-avenue");
    const station = world.drivingRoads.find((road4) => road4.id === "station-avenue");
    if (avenue2?.axis !== "x" || exit2?.axis !== "z" || station?.axis !== "x")
      throw new Error("Missing registered Metro reverse junction");
    const { player } = world;
    const pose5 = { x: exit2.fixed + 7, z: avenue2.fixed + 1, heading: EAST, speed: 0 };
    const ego = { ...player, ...pose5 };
    const occupied = world.statics.concat(world.actors.filter((actor) => actor !== player));
    if (!bodyOnRoad(ego, [avenue2]) || occupied.some((body) => overlaps(body, ego, RESET_GAP_M)))
      throw new Error("Metro reverse start has no clear berth for the SUV");
    occupied.push(ego);
    const barrier2 = (position2, x) => ({
      id: `metro-lab-L07-${position2}-barrier`,
      type: "static",
      kind: "barrier",
      x,
      z: avenue2.fixed,
      heading: EAST,
      width: avenue2.width,
      length: 0.7,
      height: 0.8
    });
    const front = barrier2("front", pose5.x + 8);
    const rear = id === "L07-blocked" ? barrier2("rear", exit2.fixed + 2) : null;
    const barriers = rear ? [front, rear] : [front];
    for (const body of barriers) {
      if (!bodyOnRoad(body, [avenue2], 0) || occupied.some((other) => overlaps(body, other, RESET_GAP_M)))
        throw new Error(`Metro reverse barrier has no clear berth: ${body.id}`);
      occupied.push(body);
    }
    const patrolStart = Object.freeze({
      ...districtRoadPose(station, pose5.x + 6, -1),
      speed: 5
    });
    Object.assign(player, pose5);
    world.statics = world.statics.concat(barriers);
    return Object.freeze({
      id,
      roadId: avenue2.id,
      exitRoadId: exit2.id,
      barrierId: front.id,
      rearBarrierId: rear?.id ?? null,
      patrolStart
    });
  }

  // src/rl/pursuit-lab-scenarios.js
  var crossingCases = Object.freeze({ L09: 1, L10: -1, L12: 1, "L12-control": 1 });
  var turnCases = Object.freeze({ "tail-civic-eastbound": 1, "tail-civic-westbound": -1 });
  var approachCases = Object.freeze({ L01: 1, "L01-control": 0, L03: 2, "L03-control": 2 });
  function approachCourse(world, id) {
    const road4 = world.drivingRoads.find((road5) => road5.id === "university-avenue");
    const ego = districtRoadPose(road4, -218, 1);
    const body = { ...world.player, ...ego };
    if (!bodyOnRoad(body, [road4]) || world.statics.concat(world.actors).some((other) => other !== world.player && overlaps(other, body, 0.15)))
      throw new Error("The lab approach has no physically clear SUV berth");
    const patrolStarts = [];
    if (approachCases[id] > 0)
      patrolStarts.push(Object.freeze({ ...districtRoadPose(road4, -249, 1), speed: 10 }));
    if (approachCases[id] === 2) {
      const opposing = id === "L03";
      const where = districtRoadPose(road4, opposing ? -181 : -261, opposing ? -1 : 1);
      patrolStarts.push(Object.freeze({ ...where, ...opposing ? { z: ego.z } : {}, speed: 8 }));
    }
    Object.assign(world.player, ego, { speed: 6 });
    return Object.freeze({ id, roadId: road4.id, patrolStarts: Object.freeze(patrolStarts) });
  }
  function frontRearCourse(world) {
    const avenue2 = world.drivingRoads.find((road4) => road4.id === "tahrir-boulevard");
    const { player } = world, pose5 = { x: -245, z: avenue2.fixed, heading: Math.PI / 2, speed: 5.5 };
    const barrier2 = {
      id: "metro-lab-L13-barrier",
      type: "static",
      kind: "barrier",
      x: -236,
      z: pose5.z,
      heading: pose5.heading,
      width: 2,
      length: 0.7,
      height: 0.8
    };
    const probe = { ...player, ...pose5 };
    if (!bodyOnRoad(probe, [avenue2]) || !bodyOnRoad(barrier2, [avenue2]) || !world.free(barrier2, 0.1) || world.statics.concat(world.actors).some((body) => body !== player && overlaps(body, probe, 0.12)))
      throw new Error("The lab front/rear approach is not clear at reset");
    Object.assign(player, pose5);
    world.statics = world.statics.concat(barrier2);
    return Object.freeze({
      id: "L13",
      roadId: avenue2.id,
      barrierId: barrier2.id,
      patrolStart: Object.freeze({ x: pose5.x - 26, z: pose5.z, heading: pose5.heading, speed: 7 })
    });
  }
  function turnCourse(world, id, sign) {
    const avenue2 = world.drivingRoads.find((road4) => road4.id === "tahrir-boulevard");
    const cross2 = world.drivingRoads.find((road4) => road4.id === "civic-avenue");
    const rng = new Random(`${world.config.seed}:${id}:turn-v1`);
    const start = sign > 0 ? -241 : -140;
    const target = { ...districtRoadPose(cross2, 62, 1), roadId: cross2.id, id: "civic-north-lab-goal" };
    const where = districtRoadPose(avenue2, start + rng.range(-0.16, 0.16), sign);
    const speed = sign > 0 ? rng.range(14.5, 15.1) : rng.range(13.9, 14.1);
    const patrolStart = { ...districtRoadPose(avenue2, sign > 0 ? -271 : -90, sign), speed: 8 };
    const [minX, maxX] = sign > 0 ? [-277, -178] : [-191, -73];
    if (!bodyOnRoad({ ...world.player, ...where }, [avenue2]) || world.actors.some((actor) => actor !== world.player && overlaps({ ...world.player, ...where }, actor, 0.15)))
      throw new Error("The lab turn approach has no physically clear berth");
    Object.assign(world.player, where, { speed });
    return Object.freeze({
      id,
      roadId: avenue2.id,
      goal: Object.freeze(target),
      patrolStart: Object.freeze(patrolStart),
      zones: [{ id: "civic-approach-lab", minX, maxX, minZ: -122, maxZ: -68 }]
    });
  }
  function narrowCourse(world, id) {
    const { player, district } = world;
    const alley = world.drivingRoads.find((road4) => road4.id === "alley-west");
    const market = world.drivingRoads.find((road4) => road4.id === "market-local");
    const mouth = world.roads.find((road4) => road4.supportApron && road4.junctionX === alley?.fixed && road4.junctionZ === alley?.max);
    if (!alley || !market || !mouth) throw new Error("Missing registered Metro alley mouth");
    const pose5 = { x: alley.fixed - 2.8, z: mouth.min, heading: Math.PI, speed: 0 };
    const ego = { ...player, ...pose5 };
    const oncoming = world.makeVehicle(
      "metro-lab-L18-oncoming",
      "sedan",
      districtRoadPose(alley, -19.5, 1)
    );
    const destination = { ...districtRoadPose(market, 35, 1), roadId: market.id };
    const closure = id === "L18-blocked" ? {
      id: "metro-lab-L18-closure",
      type: "static",
      kind: "barrier",
      height: 0.8,
      x: alley.fixed,
      z: -24,
      heading: 0,
      width: alley.width,
      length: 0.7
    } : null;
    if (!bodyOnRoad(ego, world.roads) || !bodyOnRoad(oncoming, [alley]) || !world.free(ego, 0.15) || !world.free(oncoming, 0.15) || overlaps(ego, oncoming, 0.15) || closure && (!bodyOnRoad(closure, [alley], 0) || !world.free(closure, 0.15) || overlaps(closure, ego, 0.15) || overlaps(closure, oncoming, 0.15)))
      throw new Error("The lab narrow approach has no physically clear berth");
    oncoming.path = planDistrictRoute(district, oncoming, destination);
    if (oncoming.path.length < 3) throw new Error("No drivable civilian exit from the alley");
    initializeDistrictActor(world, oncoming);
    Object.assign(oncoming.district, { caseId: "L18", nextLoadingDistanceM: null });
    Object.assign(oncoming, { speed: 2.6, maxSpeed: 3.8 });
    Object.assign(player, pose5);
    world.actors.push(oncoming);
    if (closure) world.statics = world.statics.concat(closure);
    return Object.freeze({
      id,
      roadId: alley.id,
      oncomingId: oncoming.id,
      barrierId: closure?.id ?? null,
      patrolStart: Object.freeze({ ...districtRoadPose(market, 30, -1), speed: 3 })
    });
  }
  function stagePursuitLabScenario(world, id) {
    if (world.tick !== 0 || world.environment !== "metro" || world.pursuit)
      throw new RangeError("Unknown or late Metro pursuit Lab scenario");
    if (typeof id === "string" && id.startsWith("pocket-")) return stagePocketCourse(world, id);
    if (Object.hasOwn(approachCases, id)) return approachCourse(world, id);
    if (id === "L07" || id === "L07-blocked") return stageReverseCourse(world, id);
    if (id === "L13") return frontRearCourse(world);
    if (id === "L18" || id === "L18-blocked") return narrowCourse(world, id);
    if (Object.hasOwn(turnCases, id)) return turnCourse(world, id, turnCases[id]);
    if (!Object.hasOwn(crossingCases, id)) throw new RangeError("Unknown or late Metro pursuit Lab scenario");
    const { player } = world;
    const road4 = world.drivingRoads.find((road5) => road5.id === "tahrir-boulevard");
    if (!road4 || road4.axis !== "x") throw new Error("Missing registered Lab approach");
    const layout2 = id === "L12-control" ? "L12" : id;
    const random = new Random(`${world.config.seed}:${layout2}:crossing-v1`);
    const side = crossingCases[id], x = -207 + random.range(-0.25, 0.25);
    const z = road4.fixed + side * (road4.width / 2 + 0.32);
    const target = { x, z: road4.fixed - side * (road4.width / 2 + 0.32) };
    const pose5 = { x: -245, z: road4.fixed, heading: Math.PI / 2, speed: 8 };
    const setup = { ...player, ...pose5 };
    if (!bodyOnRoad(setup, [road4]) || world.statics.some((body) => overlaps(setup, body, 0.12)) || world.actors.some((body) => body !== player && overlaps(setup, body, 0.12)))
      throw new Error("Lab approach is not clear for the SUV");
    const person = {
      id: `metro-lab-${id}-walker`,
      type: "pedestrian",
      kind: "man-polo",
      x,
      z,
      heading: side === 1 ? Math.PI : 0,
      speed: 0,
      walkSpeed: 1.55,
      phase: 0.5,
      road: road4,
      target,
      side,
      along: x,
      pause: 0.15,
      motionMode: "jog",
      crossing: true,
      distance: 0,
      wait: 0,
      reason: "waiting",
      motionTimeS: 0,
      accelerationMps2: 0,
      district: { caseId: id, routeConstrained: true, holdAtTarget: true, yieldAtCurb: false }
    };
    person.body = createPedestrianBody(person);
    person.radius = person.body.radiusM;
    person.height = person.body.heightM;
    if (!world.free(person, 0.12) || !walkSegmentClear(person, person, target, world.statics, 0.12))
      throw new Error("Lab crossing is obstructed at reset");
    Object.assign(player, pose5);
    world.actors.push(person);
    return Object.freeze({ id, walkerId: person.id, roadId: road4.id });
  }

  // src/rl/pursuit-route-context.js
  var LEGACY_ROUTE_CONTEXT = "dispatch-route-v1";
  var CLEARANCE_ROUTE_CONTEXT = "dispatch-route-v2";
  var guides = /* @__PURE__ */ new Map([[LEGACY_ROUTE_CONTEXT, /* @__PURE__ */ new WeakMap()], [CLEARANCE_ROUTE_CONTEXT, /* @__PURE__ */ new WeakMap()]]);
  var ROUTE_NAVIGATION_FIELDS = Object.freeze([
    "available",
    "nearRight",
    "nearForward",
    "laterRight",
    "laterForward",
    "headingSin",
    "headingCos",
    "curveAhead",
    "remaining"
  ]);
  function isOutside(goal, zones) {
    return zones.every((zone) => goal.x < zone.minX - 1 || goal.x > zone.maxX + 1 || goal.z < zone.minZ - 1 || goal.z > zone.maxZ + 1);
  }
  function clearanceFromZones(point2, zones) {
    let clearance = Infinity;
    for (const zone of zones) clearance = Math.min(clearance, Math.hypot(
      Math.max(0, zone.minX - point2.x, point2.x - zone.maxX),
      Math.max(0, zone.minZ - point2.z, point2.z - zone.maxZ)
    ));
    return clearance;
  }
  function clearanceGoals(district, zones) {
    const goals = [];
    for (const road4 of district.drivingRoads) {
      if (road4.parkingBay || road4.supportApron || road4.max - road4.min < 24) continue;
      for (const direction3 of road4.flow ? [road4.flow] : [-1, 1]) {
        const along2 = direction3 > 0 ? road4.max - 12 : road4.min + 12;
        const goal = {
          ...districtRoadPose(road4, along2, direction3),
          roadId: road4.id,
          id: `clearance:${road4.id}:${direction3}`
        };
        if (clearanceFromZones(goal, zones) >= 38) goals.push(goal);
      }
    }
    return goals;
  }
  function dispatchRouteGuide(world, version = LEGACY_ROUTE_CONTEXT) {
    const { district, player, pursuit } = world;
    if (!district || !pursuit?.gta) return null;
    const cache = guides.get(version);
    if (!cache) throw new RangeError("Unknown Metro route context");
    const cached = cache.get(pursuit);
    if (cached && (cached.guide || world.tick < cached.retryAt)) return cached.guide;
    const { surveillanceZones } = pursuit.gta.config;
    const extended = version === CLEARANCE_ROUTE_CONTEXT;
    const goals = pursuit.gta.publicRouteGoal ? [pursuit.gta.publicRouteGoal] : (extended ? clearanceGoals(district, surveillanceZones) : district.pursuitExits.filter((goal) => isOutside(goal, surveillanceZones))).sort((a, b) => distance(a, player) - distance(b, player) || a.id.localeCompare(b.id)).slice(0, extended ? 8 : 5);
    let best = null;
    for (const goal of goals) {
      const path = planDistrictRoute(district, player, goal);
      if (path.length < 3) continue;
      const across = path.reduce((total, point2, i) => i ? total + distance(path[i - 1], point2) : 0, 0);
      if (!best || across < best.lengthM) best = {
        id: goal.id,
        path: Object.freeze(path.map((point2) => Object.freeze(point2))),
        lengthM: across
      };
    }
    cache.set(pursuit, { guide: best, retryAt: world.tick + 30 });
    return best;
  }
  function sampleRouteNavigation(world, version) {
    const guide = dispatchRouteGuide(world, version);
    if (!guide) return new Float32Array(ROUTE_NAVIGATION_FIELDS.length);
    const { player } = world, { path } = guide;
    const sin = Math.sin(player.heading), cos = Math.cos(player.heading);
    const axle = (player.spec?.wheelbase ?? 2.6) / 2;
    const x = player.x - sin * axle, z = player.z - cos * axle;
    let index = 0, min = Infinity;
    for (let i = 0; i < path.length; i++) {
      const dist = (path[i].x - x) ** 2 + (path[i].z - z) ** 2;
      if (dist < min) {
        min = dist;
        index = i;
      }
    }
    const nearest2 = nearestPathPoint(path, x, z, index), limit = path.length - 1;
    const ahead = 2 + Math.abs(player.speed) * 0.18;
    let nearIndex = nearest2, farIndex = nearest2, arc = 0, remaining = 0, bend = 0;
    const heading2 = (i) => Math.atan2(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z);
    for (let i = nearest2; i < limit; i++) {
      remaining += distance(path[i], path[i + 1]);
      if (arc < ahead) nearIndex = i + 1;
      if (arc < ahead + 8) farIndex = i + 1;
      if (arc < 14 && i + 1 < limit)
        bend = Math.max(bend, Math.abs(angleDelta(heading2(i + 1), heading2(i))) / Math.max(1, arc + 1));
      arc = remaining;
    }
    const local2 = (i) => {
      const dx = path[i].x - x, dz = path[i].z - z;
      return [dx * cos - dz * sin, dx * sin + dz * cos];
    };
    const near = local2(nearIndex), far = local2(farIndex);
    const error = angleDelta(heading2(Math.min(nearest2, limit - 1)), player.heading);
    return Float32Array.of(
      1,
      clamp(near[0] / 6, -1, 1),
      clamp(near[1] / 12, -1, 1),
      clamp(far[0] / 14, -1, 1),
      clamp(far[1] / 24, -1, 1),
      Math.sin(error),
      Math.cos(error),
      clamp(bend * 5, 0, 1),
      clamp(remaining / 35, 0, 1)
    );
  }

  // src/rl/gta-pursuit-env.js
  var K = 8;
  var M = 4;
  var UNIT_TYPES = Object.freeze([...GTA_UNIT_TYPES, "wrecked"]);
  var mounts = getVehicleMounts();
  var egoFields = Object.freeze(["speed", "steer", "lateralSlip", "yawRate", "health", "wanted", "pinned", "lineOfSight", "cooldown"]);
  var rayFields = Object.freeze(mounts.ranges.concat(mounts.auxiliary).map((mount) => mount.id));
  var patrolFields = Object.freeze([
    "dx",
    "dy",
    "dvx",
    "dvy",
    "headingSin",
    "headingCos",
    "health",
    ...UNIT_TYPES,
    "fsmState"
  ]);
  var hazardFields = Object.freeze(["dx", "dy", "relativeSpeed", "footprintRadius"]);
  var rayOffset = egoFields.length;
  var patrolOffset = rayOffset + rayFields.length;
  var hazardOffset = patrolOffset + K * patrolFields.length;
  var scales = Object.freeze({
    speedMps: GTA_MAX_SPEED,
    steerRad: PLAYER_VEHICLE.maxSteerRad,
    slipMps: 11,
    yawRadS: 4,
    offsetM: 65,
    relativeSpeedMps: 60,
    radiusM: 5,
    rayM: SENSOR_MAX_M
  });
  var block = (offset2, count, fields) => Object.freeze({ offset: offset2, count, stride: fields.length, fields });
  var GTA_OBSERVATION_SCHEMA = Object.freeze({
    source: "virtual/privileged simulation state",
    dtype: "Float32Array",
    frame: "ego-local: x right, y forward",
    length: hazardOffset + M * hazardFields.length,
    ego: block(0, 1, egoFields),
    rays: block(rayOffset, 1, rayFields),
    patrols: block(patrolOffset, K, patrolFields),
    hazards: block(hazardOffset, M, hazardFields),
    scales,
    fsmStates: GTA_AI_STATES,
    fsmEncoding: "(zero-based index + 1) / state count; 0 is padding"
  });
  var scanKinds = Object.freeze(["static", "civilian", "pedestrian", "police"]);
  var scanEgo = Object.freeze(["speed", "steer", "lateralSlip", "yawRate", "health", "frameAge"]);
  var scanRays = Object.freeze(["range", ...scanKinds]);
  var scanTracks = Object.freeze([
    "present",
    ...scanKinds,
    "right",
    "forward",
    "rightMps",
    "forwardMps",
    "age",
    "motionKnown",
    "ttcKnown",
    "ttc"
  ]);
  var scanTrackOffset = scanEgo.length + PURSUIT_SCAN_RAYS * scanRays.length;
  var scanTrackCount = 16;
  var QUALIFIED_REWARD = "qualified-progress-v2";
  var PRACTICE_REWARD = "maneuver-practice-v1";
  var DISPATCH_OBSERVATION_SCHEMA = Object.freeze({
    version: "dispatch-scan-v3",
    source: "virtual first-return geometry",
    dtype: "Float32Array",
    frame: "ego-local: x right, y forward; ray 0 forward, increasing clockwise",
    length: scanTrackOffset + scanTrackCount * scanTracks.length,
    ego: block(0, 1, scanEgo),
    rays: block(scanEgo.length, PURSUIT_SCAN_RAYS, scanRays),
    tracks: block(scanTrackOffset, scanTrackCount, scanTracks),
    scales: Object.freeze({
      ...scales,
      offsetM: PURSUIT_SCAN_RANGE_M,
      rayM: PURSUIT_SCAN_RANGE_M,
      sampleTicks: PURSUIT_SCAN_TICKS,
      ageS: PURSUIT_TRACK_TTL_S,
      ttcS: 6
    })
  });
  var ROUTE_OBSERVATION_SCHEMA = Object.freeze({
    ...DISPATCH_OBSERVATION_SCHEMA,
    version: LEGACY_ROUTE_CONTEXT,
    source: "virtual first-return geometry and public static Metro route cues",
    length: DISPATCH_OBSERVATION_SCHEMA.length + ROUTE_NAVIGATION_FIELDS.length,
    navigation: block(DISPATCH_OBSERVATION_SCHEMA.length, 1, ROUTE_NAVIGATION_FIELDS)
  });
  var CLEARANCE_ROUTE_OBSERVATION_SCHEMA = Object.freeze({
    ...ROUTE_OBSERVATION_SCHEMA,
    version: CLEARANCE_ROUTE_CONTEXT,
    source: "virtual first-return geometry and public static Metro clearance-route cues"
  });
  var dispatchSchemas = new Map([
    DISPATCH_OBSERVATION_SCHEMA,
    ROUTE_OBSERVATION_SCHEMA,
    CLEARANCE_ROUTE_OBSERVATION_SCHEMA
  ].map((schema) => [schema.version, schema]));
  var signed = (n, scale) => clamp(n / scale, -1, 1);
  var unit = (n, scale) => clamp(n / scale, 0, 1);
  var distanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
  var nearest = (bodies, ego) => bodies.sort((a, b) => distanceSquared(a, ego) - distanceSquared(b, ego));
  function getDispatchObservation(world, version = DISPATCH_OBSERVATION_SCHEMA.version) {
    const { player, sensors, pursuit, tick } = world;
    if (pursuit?.gta?.config.ruleset !== "dispatch-v1" || !pursuit.gta.scan)
      throw new Error("Dispatch observation requires a sampled dispatch-v1 chase");
    const scan = requireDispatchScan(world);
    const schema = dispatchSchemas.get(version);
    if (!schema) throw new RangeError("Unknown dispatch observation version");
    const { ego, rays, tracks, scales: s, length } = schema;
    const obs = new Float32Array(length);
    obs.set([
      signed(player.speed, s.speedMps),
      signed(player.steer, s.steerRad),
      signed(player.gtaSlipMps, s.slipMps),
      signed(sensors.imu.yawRateRadS, s.yawRadS),
      // Wanted decay is scored using hidden separation, so it remains UI/metrics only.
      unit(player.health, player.maxHealth),
      unit(tick - scan.tick, s.sampleTicks)
    ], ego.offset);
    for (const [i, ray] of scan.rays.entries()) {
      const offset2 = rays.offset + i * rays.stride;
      obs[offset2] = unit(ray.rangeM, s.rayM);
      const kind = scanKinds.indexOf(ray.kind);
      if (kind >= 0) obs[offset2 + 1 + kind] = 1;
    }
    for (const [i, track2] of scan.tracks.slice(0, tracks.count).entries()) {
      const ttcKnown = Number.isFinite(track2.ttcS);
      obs.set([
        1,
        ...scanKinds.map((kind) => Number(track2.kind === kind)),
        signed(track2.rightM, s.offsetM),
        signed(track2.forwardM, s.offsetM),
        signed(track2.rightMps, s.relativeSpeedMps),
        signed(track2.forwardMps, s.relativeSpeedMps),
        unit(track2.ageS, s.ageS),
        Number(track2.motionKnown),
        Number(ttcKnown),
        ttcKnown ? unit(track2.ttcS, s.ttcS) : 0
      ], tracks.offset + i * tracks.stride);
    }
    if (schema.navigation) obs.set(sampleRouteNavigation(world, version), schema.navigation.offset);
    if (!obs.every(Number.isFinite)) throw new Error("Nonfinite dispatch observation");
    return obs;
  }
  function getObservation(world) {
    const { player, pursuit, sensors } = world;
    if (!pursuit?.gta) throw new Error("GTA observation requires a GTA Chase");
    const obs = new Float32Array(GTA_OBSERVATION_SCHEMA.length);
    obs.set([
      signed(player.speed, scales.speedMps),
      signed(player.steer, scales.steerRad),
      signed(player.gtaSlipMps, scales.slipMps),
      signed(sensors.imu.yawRateRadS, scales.yawRadS),
      unit(player.health, player.maxHealth),
      unit(pursuit.wantedLevel, 5),
      unit(pursuit.metrics.capturePressureS, GTA_PIN_SECONDS),
      Number(pursuit.response.unitsInContact > 0),
      pursuit.response.clearProgress
    ]);
    for (const [i, ray] of sensors.rays.entries()) obs[rayOffset + i] = unit(ray.rangeM, scales.rayM);
    const egoVelocity = gtaVelocity(player);
    const relativeVelocity = (body) => {
      const v = gtaVelocity(body);
      return gtaLocal({ x: egoVelocity.x, z: egoVelocity.z, heading: player.heading }, v);
    };
    const patrols = [...pursuit.patrols];
    const tracks = nearest(patrols.filter((body) => body.aiState !== "WRECKED"), player).concat(nearest(patrols.filter((body) => body.aiState === "WRECKED"), player)).slice(0, K);
    for (const [i, body] of tracks.entries()) {
      const { right, forward: forward2 } = gtaLocal(player, body), velocity = relativeVelocity(body);
      const heading2 = body.heading - player.heading;
      const type = body.aiState === "WRECKED" ? "wrecked" : body.unitType;
      obs.set([
        signed(right, scales.offsetM),
        signed(forward2, scales.offsetM),
        signed(velocity.right, scales.relativeSpeedMps),
        signed(velocity.forward, scales.relativeSpeedMps),
        Math.sin(heading2),
        Math.cos(heading2),
        unit(body.health, body.maxHealth),
        ...UNIT_TYPES.map((unitType) => Number(unitType === type)),
        (GTA_AI_STATES.indexOf(body.aiState) + 1) / GTA_AI_STATES.length
      ], patrolOffset + i * patrolFields.length);
    }
    const hazards = nearest(world.actors.filter((body) => body !== player && (!pursuit.patrols.has(body) || body.gtaRoadblock || body.aiState === "WRECKED")).concat([...pursuit.closures.keys()]), player).slice(0, M);
    for (const [i, body] of hazards.entries()) {
      const { right, forward: forward2 } = gtaLocal(player, body);
      const radius = body.type === "pedestrian" ? body.radius : Math.hypot(body.length, body.width) / 2;
      obs.set([
        signed(right, scales.offsetM),
        signed(forward2, scales.offsetM),
        signed(relativeVelocity(body).forward, scales.relativeSpeedMps),
        unit(radius, scales.radiusM)
      ], hazardOffset + i * hazardFields.length);
    }
    return obs;
  }
  function tickReward(world, moved, events) {
    let reward = 0.16 * STEP + 0.012 * moved;
    for (const event2 of events) {
      if (event2.type === "patrol_collision") reward -= 3 * event2.damageToPlayer / world.player.maxHealth;
      else if (event2.type === "static_or_civilian_hit")
        reward -= 6 * event2.damageToPlayer / world.player.maxHealth + (event2.kind === "pedestrian" ? 2 : 0.1);
      else if (event2.type === "near_miss") reward -= 0.015 * (1 - unit(event2.minDist, 0.72));
      else if (event2.type === "pinned_progress") reward -= 0.2 * STEP * event2.ratio;
    }
    if (world.pursuit.phase === "escaped") reward += 5;
    else if (["wrecked", "busted"].includes(world.pursuit.phase)) reward -= 4;
    return reward;
  }
  function infoFor(world, requestedAction, events) {
    const { pursuit } = world;
    return {
      requestedAction,
      appliedCommand: pursuit.appliedCommand ? { ...pursuit.appliedCommand } : null,
      phase: pursuit.phase,
      wantedLevel: pursuit.wantedLevel,
      playerHealth: world.player.health,
      activePatrols: [...pursuit.patrols].filter((unit2) => unit2.aiState !== "WRECKED").length,
      events,
      tick: world.tick,
      ...pursuit.gta.config.ruleset === "dispatch-v1" ? {
        observationVersion: DISPATCH_OBSERVATION_SCHEMA.version,
        sampleTick: pursuit.gta.scan?.tick ?? null
      } : {}
    };
  }
  var GtaPursuitEnv = class {
    static observationSchema = GTA_OBSERVATION_SCHEMA;
    get observationSchema() {
      return this.schema ?? GTA_OBSERVATION_SCHEMA;
    }
    reset({ seed, config, traffic, pedestrians, shield = false, scenario, observation, practiceProgress = false } = {}) {
      const options2 = resolveGtaChaseConfig(config);
      for (const [density, max, label] of [[traffic, 96, "traffic"], [pedestrians, 144, "pedestrians"]])
        if (density !== void 0 && (!Number.isInteger(density) || density < 0 || density > max))
          throw new RangeError(`Invalid Metro ${label} count`);
      if (typeof shield !== "boolean" || shield && options2.ruleset !== "dispatch-v1")
        throw new TypeError("Brake shield is only available for dispatch-v1");
      if (typeof practiceProgress !== "boolean")
        throw new TypeError("practiceProgress must be a boolean");
      if (practiceProgress && (options2.ruleset !== "dispatch-v1" || options2.maxActivePatrols !== 0))
        throw new TypeError("Progress practice is only available in no-patrol Dispatch drills");
      if (scenario !== void 0 && (options2.ruleset !== "dispatch-v1" || scenario === "L12" && options2.maxActivePatrols < 1 || scenario === "L12-control" && options2.maxActivePatrols !== 0))
        throw new TypeError("Dispatch Lab scenario requires compatible pursuit settings");
      const schema = observation === void 0 ? DISPATCH_OBSERVATION_SCHEMA : dispatchSchemas.get(observation);
      if (observation !== void 0 && (options2.ruleset !== "dispatch-v1" || !schema))
        throw new RangeError("Invalid observation for this pursuit ruleset");
      const world = new World({
        cityVersion: 4,
        seed,
        ...traffic === void 0 ? {} : { traffic },
        ...pedestrians === void 0 ? {} : { pedestrians }
      }, "metro");
      const staged = scenario === void 0 ? null : stagePursuitLabScenario(world, scenario);
      if (staged?.barrierId) world.staticIndex = new SpatialIndex(world.statics);
      const runConfig = staged?.zones ? { ...options2, surveillanceZones: staged.zones } : options2;
      if (staged?.patrolStart && options2.maxActivePatrols > 1)
        throw new RangeError("A controlled tail approach supports at most one patrol");
      if (staged?.patrolStarts && options2.maxActivePatrols !== staged.patrolStarts.length)
        throw new RangeError(`The lab approach fixture requires ${staged.patrolStarts.length} patrols`);
      world.command({ type: "street-pursuit-start", variant: "gta", level: options2.wantedLevelStart, config: runConfig }, false);
      if (staged?.goal) world.pursuit.gta.publicRouteGoal = staged.goal;
      const starts = staged?.patrolStarts ?? (staged?.patrolStart ? [staged.patrolStart] : null);
      if (starts) {
        const { pursuit } = world;
        const units = [...pursuit.patrols];
        if (staged.patrolStarts && units.length !== starts.length)
          throw new Error("The lab approach could not deploy all required patrols");
        if (units.length) {
          const proposed = units.map((unit2, i) => ({ ...unit2, ...starts[i] }));
          const obstacles = world.statics.concat(world.actors.filter((actor) => !pursuit.patrols.has(actor)));
          if (proposed.some((pose5, i) => !bodyOnRoad(pose5, world.drivingRoads) || obstacles.some((actor) => overlaps(actor, pose5, 0.15)) || proposed.slice(0, i).some((other) => overlaps(other, pose5, 0.15))))
            throw new Error("The staged patrol has no physically clear berth");
          units.forEach((unit2, i) => Object.assign(unit2, starts[i]));
          world.actorIndex = new SpatialIndex(world.actors);
        }
        updatePursuitResponse(world, true);
        pursuit.gta.scanner = new PursuitScanner();
        pursuit.gta.scan = pursuit.gta.scanner.sample(world);
      }
      this.world = world;
      this.schema = options2.ruleset === "dispatch-v1" ? schema : GTA_OBSERVATION_SCHEMA;
      this.furthestM = 0;
      this.shield = shield;
      this.rewardProfile = practiceProgress ? PRACTICE_REWARD : QUALIFIED_REWARD;
      const info = infoFor(world, null, []);
      if (options2.ruleset === "dispatch-v1") info.rewardProfile = this.rewardProfile;
      if (schema.navigation) info.observationVersion = schema.version;
      if (staged) info.scenario = staged;
      return { obs: this.getObservation(), info };
    }
    getObservation() {
      if (!this.world) throw new Error("Reset the GTA environment before reading observations");
      return this.observationSchema === GTA_OBSERVATION_SCHEMA ? getObservation(this.world) : getDispatchObservation(this.world, this.observationSchema.version);
    }
    step(action, actionRepeat = 6) {
      const { world } = this;
      if (world?.pursuit.phase !== "running") throw new Error("Reset the GTA environment before stepping");
      if (!Number.isSafeInteger(actionRepeat) || actionRepeat < 1)
        throw new RangeError("actionRepeat must be a positive integer");
      world.command({ type: "pursuit-drive", action }, false);
      const requestedAction = { ...world.pursuit.manualAction }, events = [];
      const dispatch = this.observationSchema !== GTA_OBSERVATION_SCHEMA;
      const rewardComponents = dispatch ? { progress: 0, time: 0, instability: 0, safety: 0, capture: 0, outcome: 0 } : null;
      let shieldTick = null, shieldReason = null, interventions = 0;
      let reward = 0;
      for (let i = 0; i < actionRepeat && world.pursuit.phase === "running"; i++) {
        if (this.shield && shieldTick !== requireDispatchScan(world).tick) {
          const { action: safe, reason } = guardDispatchAction(world, requestedAction);
          world.command({ type: "pursuit-drive", action: safe }, false);
          shieldTick = world.pursuit.gta.scan.tick;
          shieldReason = reason;
          if (reason) interventions++;
        }
        const before = world.pursuit.metrics.distanceM;
        const beforeSteer = world.player.steer;
        world.step();
        const stepEvents = world.pursuit.stepEvents;
        if (dispatch) this.scoreDispatchTick(rewardComponents, beforeSteer, stepEvents);
        else reward += tickReward(world, world.pursuit.metrics.distanceM - before, stepEvents);
        for (const event2 of stepEvents) events.push({ ...event2 });
      }
      const { phase } = world.pursuit;
      const info = infoFor(world, requestedAction, events);
      if (dispatch) {
        reward = Object.values(rewardComponents).reduce((sum, component) => sum + component, 0);
        info.rewardComponents = rewardComponents;
        info.rewardProfile = this.rewardProfile;
        info.observationVersion = this.schema.version;
        if (this.shield) info.shield = { reason: shieldReason, interventions };
      }
      return {
        obs: this.getObservation(),
        reward,
        terminated: ["escaped", "wrecked", "busted"].includes(phase),
        truncated: phase === "timeout",
        info
      };
    }
    scoreDispatchTick(reward, beforeSteer, events) {
      const { player, pursuit } = this.world;
      const separation = Math.min(100, distance(player, pursuit.playerStart));
      if (this.rewardProfile === PRACTICE_REWARD || pursuit.response.dispatch.escapeEligible)
        reward.progress += 0.06 * Math.max(0, separation - this.furthestM);
      this.furthestM = Math.max(this.furthestM, separation);
      reward.time -= 0.04 * STEP;
      reward.instability -= 0.025 * Math.abs(player.steer - beforeSteer);
      for (const event2 of events) {
        if (event2.type === "patrol_collision") reward.safety -= 1 + 4 * event2.damageToPlayer / player.maxHealth;
        else if (event2.type === "static_or_civilian_hit")
          reward.safety -= (event2.kind === "pedestrian" ? 24 : 3) + 8 * event2.damageToPlayer / player.maxHealth;
        else if (event2.type === "ambient_collision" && this.rewardProfile === QUALIFIED_REWARD) {
          const { first, second } = event2;
          const pedestrian = first.type === "pedestrian" || second.type === "pedestrian";
          const civilianVehicle = first.type === "vehicle" && !first.patrol || second.type === "vehicle" && !second.patrol;
          if (pedestrian || civilianVehicle) reward.safety -= (pedestrian ? 24 : 3) + 8 * event2.severity;
        } else if (event2.type === "near_miss") reward.safety -= 0.12 * (1 - unit(event2.minDist, 0.72));
        else if (event2.type === "pinned_progress") reward.capture -= 0.2 * STEP * event2.ratio;
      }
      if (pursuit.phase === "escaped") reward.outcome += 12;
      else if (pursuit.phase === "busted" || pursuit.phase === "wrecked") reward.outcome -= 8;
    }
  };

  // src/rl/pursuit-ppo.js
  var HIDDEN = 24;
  var ACTIONS = 3;
  var HEADS = ACTIONS + 1;
  var POLICY_ID = "metro-dispatch-ppo-v2";
  var GAUSS_CONSTANT = Math.log(2 * Math.PI) / 2;
  var normal = (rng) => Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
  var layouts = new Map([DISPATCH_OBSERVATION_SCHEMA, ROUTE_OBSERVATION_SCHEMA, CLEARANCE_ROUTE_OBSERVATION_SCHEMA].map((schema) => {
    const INPUT = schema.length, HIDDEN_BIAS = INPUT * HIDDEN, OUTPUT_WEIGHTS = HIDDEN_BIAS + HIDDEN;
    const OUTPUT_BIAS = OUTPUT_WEIGHTS + HIDDEN * HEADS, PARAMETERS = OUTPUT_BIAS + HEADS;
    return [schema.version, Object.freeze({
      schema,
      INPUT,
      HIDDEN_BIAS,
      OUTPUT_WEIGHTS,
      OUTPUT_BIAS,
      PARAMETERS,
      std: Object.freeze(schema.navigation ? [0.07, 0.27, 0.2] : [0.18, 0.52, 0.35])
    })];
  }));
  function logProbability(mean, raw, std) {
    let logp = 0;
    for (let i = 0; i < ACTIONS; i++) {
      const z = (raw[i] - mean[i]) / std[i];
      logp -= 0.5 * z * z + Math.log(std[i]) + GAUSS_CONSTANT;
    }
    return logp;
  }
  function actionFor(raw) {
    const effort = Math.tanh(raw[1]);
    const brake = Math.max(0, Math.tanh(raw[2] - 0.35));
    return {
      steer: Math.tanh(raw[0]),
      throttle: brake > 0 ? 0 : Math.abs(effort),
      brake,
      gear: effort < 0 ? -1 : 1
    };
  }
  function forward(layout2, weights, obs) {
    const { INPUT, HIDDEN_BIAS, OUTPUT_WEIGHTS, OUTPUT_BIAS } = layout2;
    if (!(obs instanceof Float32Array) || obs.length !== INPUT || !obs.every(Number.isFinite))
      throw new TypeError(`Expected a finite ${layout2.schema.version} observation`);
    const hidden = new Float64Array(HIDDEN);
    for (let h = 0; h < HIDDEN; h++) {
      let sum = weights[HIDDEN_BIAS + h], offset2 = h * INPUT;
      for (let j = 0; j < INPUT; j++) sum += obs[j] * weights[offset2 + j];
      hidden[h] = Math.tanh(sum);
    }
    const out = new Float64Array(HEADS);
    for (let head = 0; head < HEADS; head++) {
      let sum = weights[OUTPUT_BIAS + head], offset2 = OUTPUT_WEIGHTS + head * HIDDEN;
      for (let h = 0; h < HIDDEN; h++) sum += hidden[h] * weights[offset2 + h];
      out[head] = sum;
    }
    return { hidden, out };
  }
  var validCounter = (value) => Number.isSafeInteger(value) && value >= 0;
  function readCheckpoint(checkpoint, optimizerRequired) {
    const layout2 = layouts.get(checkpoint?.observation);
    const isParameters = (a, min) => Array.isArray(a) && a.length === layout2.PARAMETERS && a.every((x) => Number.isFinite(x) && x >= min && x <= 1e4);
    if (checkpoint?.schema !== 1 || checkpoint.algorithm !== POLICY_ID || !layout2 || typeof checkpoint.seed !== "string" || checkpoint.seed.length < 1 || checkpoint.seed.length > 200 || !validCounter(checkpoint.updates) || !validCounter(checkpoint.transitions) || !validCounter(checkpoint.optimizerSteps) || checkpoint.demonstrations !== void 0 && !validCounter(checkpoint.demonstrations) || !isParameters(checkpoint.weights, -1e4) || optimizerRequired && (!isParameters(checkpoint.firstMoment, -1e4) || !isParameters(checkpoint.secondMoment, 0)))
      throw new TypeError("Incompatible or nonfinite Metro PPO checkpoint");
    return checkpoint;
  }
  function accumulate({ INPUT, HIDDEN_BIAS, OUTPUT_WEIGHTS, OUTPUT_BIAS }, weights, grad, obs, hidden, derivatives) {
    const hiddenGrad = new Float64Array(HIDDEN);
    for (let head = 0; head < HEADS; head++) {
      const derivative = derivatives[head], offset2 = OUTPUT_WEIGHTS + head * HIDDEN;
      grad[OUTPUT_BIAS + head] += derivative;
      for (let h = 0; h < HIDDEN; h++) {
        grad[offset2 + h] += derivative * hidden[h];
        if (head < ACTIONS || INPUT === DISPATCH_OBSERVATION_SCHEMA.length)
          hiddenGrad[h] += derivative * weights[offset2 + h];
      }
    }
    for (let h = 0; h < HIDDEN; h++) {
      const derivative = hiddenGrad[h] * (1 - hidden[h] ** 2), offset2 = h * INPUT;
      grad[HIDDEN_BIAS + h] += derivative;
      for (let j = 0; j < INPUT; j++) grad[offset2 + j] += derivative * obs[j];
    }
  }
  var PursuitPpo = class {
    constructor(seed = "pursuit-development", checkpoint = null, observation = DISPATCH_OBSERVATION_SCHEMA.version) {
      const previous = checkpoint === null ? null : readCheckpoint(checkpoint, true);
      this.observation = previous?.observation ?? observation;
      this.layout = layouts.get(this.observation);
      if (!this.layout) throw new RangeError("Unknown Metro PPO observation version");
      const { INPUT, HIDDEN_BIAS, OUTPUT_WEIGHTS, OUTPUT_BIAS, PARAMETERS, schema } = this.layout;
      this.seed = previous ? previous.seed : String(seed);
      if (this.seed.length < 1 || this.seed.length > 200) throw new RangeError("Invalid training seed");
      const rng = new Random(this.seed);
      this.weights = previous ? Float64Array.from(previous.weights) : new Float64Array(PARAMETERS);
      if (!previous) {
        for (let i = 0; i < HIDDEN_BIAS; i++) {
          const scale = schema.navigation ? i % INPUT >= schema.navigation.offset ? 0.75 : 25e-4 : Math.sqrt(3 / INPUT);
          this.weights[i] = rng.range(-1, 1) * scale;
        }
        for (let i = OUTPUT_WEIGHTS; i < OUTPUT_BIAS; i++) this.weights[i] = rng.range(-0.025, 0.025);
        this.weights[OUTPUT_BIAS + 1] = 0.22;
      }
      this.firstMoment = new Float64Array(previous?.firstMoment ?? PARAMETERS);
      this.secondMoment = new Float64Array(previous?.secondMoment ?? PARAMETERS);
      this.updates = previous?.updates ?? 0;
      this.transitions = previous?.transitions ?? 0;
      this.optimizerSteps = previous?.optimizerSteps ?? 0;
      this.demonstrations = previous?.demonstrations ?? 0;
    }
    action(obs) {
      return actionFor(forward(this.layout, this.weights, obs).out);
    }
    value(obs) {
      return forward(this.layout, this.weights, obs).out[ACTIONS];
    }
    sample(obs, rng) {
      const { out } = forward(this.layout, this.weights, obs), { std } = this.layout;
      const raw = std.map((variance, i) => out[i] + variance * normal(rng));
      return { raw, action: actionFor(raw), value: out[ACTIONS], logp: logProbability(out, raw, std) };
    }
    checkpoint() {
      return {
        schema: 1,
        algorithm: POLICY_ID,
        observation: this.observation,
        seed: this.seed,
        updates: this.updates,
        transitions: this.transitions,
        optimizerSteps: this.optimizerSteps,
        ...this.demonstrations ? { demonstrations: this.demonstrations } : {},
        weights: Array.from(this.weights),
        firstMoment: Array.from(this.firstMoment),
        secondMoment: Array.from(this.secondMoment)
      };
    }
    update(rollout2, bootstrap = 0) {
      const { std, PARAMETERS } = this.layout;
      if (!rollout2.length || !Number.isFinite(bootstrap) || rollout2.some((step) => ![step.value, step.reward, step.logp].every(Number.isFinite) || step.raw.length !== ACTIONS || !step.raw.every(Number.isFinite)))
        throw new TypeError("PPO needs a finite on-policy rollout");
      const gamma = 0.99, lambda = 0.95, epsilon = 0.2;
      let next = bootstrap, last = 0;
      const advantages = new Float64Array(rollout2.length), targets = new Float64Array(rollout2.length);
      for (let i = rollout2.length - 1; i >= 0; i--) {
        const { reward, value, episodeBootstrap } = rollout2[i];
        if (episodeBootstrap !== void 0) {
          if (!Number.isFinite(episodeBootstrap)) throw new TypeError("Invalid episode bootstrap");
          next = episodeBootstrap;
          last = 0;
        }
        last = reward + gamma * next - value + gamma * lambda * last;
        advantages[i] = last;
        targets[i] = value + last;
        next = value;
      }
      const mean = advantages.reduce((a, x) => a + x, 0) / advantages.length;
      const scale = Math.sqrt(advantages.reduce((v, x) => v + (x - mean) ** 2, 0) / advantages.length + 1e-8);
      for (let i = 0; i < advantages.length; i++) advantages[i] = (advantages[i] - mean) / scale;
      const rng = new Random(`${this.seed}:update:${this.updates}`);
      const order = Array.from(rollout2.keys());
      let loss = 0, batches = 0;
      for (let epoch = 0; epoch < 4; epoch++) {
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(rng.next() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        for (let start = 0; start < order.length; start += 32) {
          const grad = new Float64Array(PARAMETERS);
          const batch = order.slice(start, start + 32);
          for (const i of batch) {
            const { obs, raw, logp } = rollout2[i];
            const { hidden, out } = forward(this.layout, this.weights, obs);
            const adv = advantages[i], ratio = Math.exp(Math.min(20, logProbability(out, raw, std) - logp));
            const clipped = Math.min(1 + epsilon, Math.max(1 - epsilon, ratio));
            const delta = ratio !== clipped && ratio * adv > clipped * adv ? 0 : -adv * ratio;
            const error = out[ACTIONS] - targets[i];
            loss += (-Math.min(adv * ratio, adv * clipped) + 0.25 * error * error) / batch.length;
            const derivatives = new Float64Array(HEADS);
            for (let head = 0; head < HEADS; head++) {
              derivatives[head] = (head === ACTIONS ? 0.5 * error : delta * (raw[head] - out[head]) / std[head] ** 2) / batch.length;
            }
            accumulate(this.layout, this.weights, grad, obs, hidden, derivatives);
          }
          this.applyAdam(grad, this.layout.schema.navigation ? 25e-6 : 3e-4);
          batches++;
        }
      }
      this.transitions += rollout2.length;
      this.updates++;
      return { loss: loss / batches, transitions: rollout2.length, optimizerSteps: this.optimizerSteps };
    }
    warmStart(demonstrations, epochs) {
      if (this.updates || this.demonstrations || !this.layout.schema.navigation || demonstrations.length < 60 || !Number.isInteger(epochs) || epochs < 1 || epochs > 80)
        throw new RangeError("Warm start needs a new route model, demonstrations and 1-80 epochs");
      const inverse = (x) => Math.atanh(Math.max(-0.96, Math.min(0.96, x)));
      const samples = demonstrations.map(({ obs, action }) => {
        validatePursuitAction(action);
        return { obs, target: [
          inverse(action.steer),
          inverse(action.brake > 0 ? 0 : action.throttle * action.gear),
          action.brake > 0 ? 0.35 + inverse(action.brake) : -0.12
        ] };
      });
      const rng = new Random(`${this.seed}:warm-start`), order = Array.from(samples.keys());
      const losses = [];
      for (let epoch = 0; epoch < epochs; epoch++) {
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(rng.next() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        let loss = 0;
        for (let start = 0; start < order.length; start += 32) {
          const grad = new Float64Array(this.layout.PARAMETERS), batch = order.slice(start, start + 32);
          for (const index of batch) {
            const { obs, target } = samples[index], { hidden, out } = forward(this.layout, this.weights, obs);
            const derivatives = new Float64Array(HEADS);
            for (let head = 0; head < ACTIONS; head++) {
              const error = out[head] - target[head];
              const importance = head === 0 ? 4 : 1;
              loss += importance * error ** 2;
              derivatives[head] = importance * error / batch.length;
            }
            accumulate(this.layout, this.weights, grad, obs, hidden, derivatives);
          }
          this.applyAdam(grad, 1e-3);
        }
        losses.push(loss / order.length);
      }
      this.demonstrations = samples.length;
      return losses;
    }
    applyAdam(grad, rate = 3e-4) {
      const { PARAMETERS } = this.layout;
      const norm = Math.sqrt(grad.reduce((sum, x) => sum + x * x, 0));
      if (!Number.isFinite(norm)) throw new Error("Nonfinite PPO gradient");
      const scale = Math.min(1, 0.5 / Math.max(1e-9, norm)), t = ++this.optimizerSteps;
      const mBias = 1 - 0.9 ** t, vBias = 1 - 0.999 ** t;
      for (let i = 0; i < PARAMETERS; i++) {
        const x = grad[i] * scale;
        const m = this.firstMoment[i] = 0.9 * this.firstMoment[i] + 0.1 * x;
        const v = this.secondMoment[i] = 0.999 * this.secondMoment[i] + 1e-3 * x * x;
        this.weights[i] -= rate * (m / mBias) / (Math.sqrt(v / vBias) + 1e-8);
      }
    }
  };

  // src/rl/pursuit-rollouts.js
  var isDispatchIncident = (event2) => event2.type === "patrol_collision" || event2.type === "static_or_civilian_hit" || event2.type === "near_miss" || event2.type === "ambient_collision";
  function resetPursuitEpisode(stage, seed) {
    const env = new GtaPursuitEnv();
    const initial = env.reset({
      seed,
      traffic: stage.traffic,
      pedestrians: stage.pedestrians,
      shield: true,
      scenario: stage.scenario,
      observation: stage.observation,
      practiceProgress: stage.practiceProgress,
      config: {
        ruleset: "dispatch-v1",
        episodeMaxSeconds: stage.episodeSeconds,
        ...stage.civilianCrossingPreview === void 0 ? {} : { civilianCrossingPreview: stage.civilianCrossingPreview },
        ...stage.patrolTrafficPreview === void 0 ? {} : { patrolTrafficPreview: stage.patrolTrafficPreview },
        wantedLevelStart: stage.wantedLevel,
        wantedLevelMax: stage.wantedLevelMax ?? 5,
        maxActivePatrols: stage.patrols
      }
    });
    return { env, initial };
  }
  function runPursuitEpisode(stage, seed, select, collect = false, observeStep = null, observeWorld = null) {
    const { env, initial } = resetPursuitEpisode(stage, seed);
    let { obs } = initial, result, reward = 0, firstAction, interventions = 0, ambientPedestrianImpacts = 0;
    const rollout2 = [], events = {}, rewardComponents = {};
    observeWorld?.(env.world);
    do {
      const decision2 = select(obs);
      const action = collect ? decision2.action : decision2;
      firstAction ??= action;
      result = env.step(action, PURSUIT_SCAN_TICKS);
      interventions += result.info.shield.interventions;
      for (const event2 of result.info.events) {
        if (event2.type === "ambient_collision") {
          ambientPedestrianImpacts += Number(event2.first.type === "pedestrian" || event2.second.type === "pedestrian");
        } else if (isDispatchIncident(event2)) {
          const key3 = event2.kind ?? event2.actorKind ?? event2.type;
          const count = events[key3] ??= { impacts: 0, nearMisses: 0, maxClosingMps: 0 };
          count[event2.type === "near_miss" ? "nearMisses" : "impacts"]++;
          if (event2.closingSpeed !== void 0) count.maxClosingMps = Math.max(count.maxClosingMps, event2.closingSpeed);
        }
      }
      for (const [key3, value] of Object.entries(result.info.rewardComponents))
        rewardComponents[key3] = (rewardComponents[key3] ?? 0) + value;
      reward += result.reward;
      if (collect) rollout2.push({ obs, raw: decision2.raw, value: decision2.value, logp: decision2.logp, reward: result.reward });
      obs = result.obs;
      if (observeStep) {
        const { x, z, speed, heading: heading2 } = env.world.player;
        observeStep([env.world.tick, x, z, speed, heading2, result.info.appliedCommand], result.info.events);
      }
      observeWorld?.(env.world);
    } while (!result.terminated && !result.truncated);
    const { pursuit } = env.world, { metrics } = pursuit;
    return { rollout: rollout2, last: result, metrics: {
      seed,
      phase: pursuit.phase,
      ticks: env.world.tick,
      ...initial.info.scenario ? { scenario: initial.info.scenario } : {},
      reward,
      rewardComponents,
      rewardProfile: initial.info.rewardProfile,
      distanceM: metrics.distanceM,
      firstAction,
      collisions: metrics.collisions,
      interventions,
      pedestrianImpacts: metrics.pedestrianCollisions,
      nearMisses: metrics.nearCollisions,
      contacts: events,
      ambientCollisions: metrics.trafficCollisions,
      ambientPedestrianImpacts,
      pursuitQualified: pursuit.response.dispatch?.escapeEligible === true
    } };
  }
  function collectPursuitRollout(model, stage, trainingSeeds, observeStep) {
    const variants = pursuitStageVariants(stage);
    const seed = trainingSeeds[model.updates % trainingSeeds.length];
    const rng = new Random(`${model.seed}:rollout:${model.updates}`);
    const episodes = variants.map((variant) => {
      const episode = runPursuitEpisode(variant, seed, (obs) => model.sample(obs, rng), true, observeStep);
      return { ...episode, bootstrap: episode.last.terminated ? 0 : model.value(episode.last.obs) };
    });
    if (episodes.length === 1) return episodes[0];
    const rollout2 = episodes.flatMap((episode) => {
      episode.rollout.at(-1).episodeBootstrap = episode.bootstrap;
      return episode.rollout;
    });
    return { rollout: rollout2, bootstrap: 0, metrics: { seed, episodes: episodes.map((episode) => episode.metrics) } };
  }
  function pursuitStageVariants(stage) {
    const workload = stage.patrols === 0 ? { ...stage, practiceProgress: true } : stage;
    return workload.scenarios ? workload.scenarios.map((scenario) => ({ ...workload, scenario })) : [workload];
  }

  // src/rl/pursuit-lab-worker.js
  var commissioned = false;
  self.onmessage = async ({ data }) => {
    if (commissioned) return;
    commissioned = true;
    try {
      const manifest = [pursuit_rl_development_default, pursuit_rl_route_development_default, pursuit_rl_city_route_development_default].find((group) => group.stages.some((row) => row.id === data.stage));
      const stage = manifest?.stages.find((row) => row.id === data.stage);
      if (!stage) throw new RangeError("Choose a Lab workload.");
      const bytes = new TextEncoder().encode(JSON.stringify(manifest));
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const curriculumSha256 = [...hash].map((n) => n.toString(16).padStart(2, "0")).join("");
      if (data.checkpoint && data.checkpoint.development?.curriculumSha256 !== curriculumSha256)
        throw new Error("Resume requires the same Lab scenarios and scoring.");
      const model = new PursuitPpo("metro-dispatch-development", data.checkpoint ?? null, stage.observation);
      if (model.observation !== (stage.observation ?? "dispatch-scan-v3"))
        throw new Error("Resume requires the checkpoint observation for this workload.");
      const { rollout: rollout2, bootstrap, metrics } = collectPursuitRollout(model, stage, manifest.trainingSeeds);
      model.update(rollout2, bootstrap);
      self.postMessage({ checkpoint: { ...model.checkpoint(), development: { curriculumSha256, stage: stage.id } }, metrics });
    } catch (error) {
      self.postMessage({ error: error.message });
    }
  };
})();
