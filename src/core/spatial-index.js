// Broad-phase lookup only; all accepted moves still pass exact shape checks.
const SNAPSHOTS = new WeakMap();

export class SpatialIndex {
  constructor(items = [], size = 12) {
    this.size = size;
    this.invSize = 1 / size;
    this.itemCount = items.length;
    if (Array.isArray(items)) {
      const snap = items.slice();
      const n = snap.length;
      const st = new Array(n);
      const sx = new Float64Array(n);
      const sz = new Float64Array(n);
      const sw = new Float64Array(n);
      const sl = new Float64Array(n);
      let maxHalfDiag = 0;
      for (let i = 0; i < n; i++) {
        const it = snap[i];
        if (!it) continue;
        st[i] = it.type;
        sx[i] = it.x;
        sz[i] = it.z;
        const isPed = it.type === "pedestrian";
        const w = isPed ? (it.radius ?? 0) : (it.width ?? 0);
        const l = isPed ? 0 : (it.length ?? 0);
        sw[i] = w;
        sl[i] = l;
        const r = isPed ? w : Math.hypot(w * 0.5, l * 0.5);
        if (Number.isFinite(r) && r > maxHalfDiag) maxHalfDiag = r;
      }
      SNAPSHOTS.set(this, { snap, st, sx, sz, sw, sl });
      this.maxHalfDiag = maxHalfDiag;
    } else {
      this.maxHalfDiag = 0;
    }
    this.cells = new Map();
    for (let i = 0; i < items.length; i++) this.add(items[i]);
  }
  get snapshot() {
    return SNAPSHOTS.get(this)?.snap ?? null;
  }
  matchesItems(items) {
    const rec = SNAPSHOTS.get(this);
    if (!Array.isArray(items) || !rec || items.length !== rec.snap.length) return false;
    const { snap, st, sx, sz, sw, sl } = rec;
    for (let i = 0; i < snap.length; i++) {
      const it = items[i];
      if (it !== snap[i]) return false;
      if (it) {
        if (it.type !== st[i]) return false;
        if (!Object.is(it.x, sx[i]) || !Object.is(it.z, sz[i])) return false;
        const isPed = it.type === "pedestrian";
        if (!Object.is(isPed ? (it.radius ?? 0) : (it.width ?? 0), sw[i])) return false;
        if (!isPed && !Object.is(it.length ?? 0, sl[i])) return false;
      }
    }
    return true;
  }
  isAppendedSuperset(items) {
    const rec = SNAPSHOTS.get(this);
    if (!Array.isArray(items) || !rec || items.length < rec.snap.length) return false;
    const { snap, st, sx, sz, sw, sl } = rec;
    for (let i = 0; i < snap.length; i++) {
      const it = items[i];
      if (it !== snap[i]) return false;
      if (it) {
        if (it.type !== st[i]) return false;
        if (!Object.is(it.x, sx[i]) || !Object.is(it.z, sz[i])) return false;
        const isPed = it.type === "pedestrian";
        if (!Object.is(isPed ? (it.radius ?? 0) : (it.width ?? 0), sw[i])) return false;
        if (!isPed && !Object.is(it.length ?? 0, sl[i])) return false;
      }
    }
    return true;
  }
  add(item) {
    const x = Math.floor(item.x * this.invSize), z = Math.floor(item.z * this.invSize);
    const key = (x << 16) ^ (z & 0xffff);
    const cell = this.cells.get(key);
    if (cell) cell.push(item);
    else this.cells.set(key, [item]);
  }
  near(point, radius) {
    const result = [];
    const px = point.x, pz = point.z, r2 = radius * radius + 1e-9;
    const inv = this.invSize;
    const left = Math.floor((px - radius) * inv), right = Math.floor((px + radius) * inv);
    const back = Math.floor((pz - radius) * inv), front = Math.floor((pz + radius) * inv);
    const cells = this.cells;
    for (let x = left; x <= right; x++) {
      const hi = x << 16;
      for (let z = back; z <= front; z++) {
        const cell = cells.get(hi ^ (z & 0xffff));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const item = cell[i];
          const dx = item.x - px, dz = item.z - pz;
          if (dx * dx + dz * dz <= r2) result.push(item);
        }
      }
    }
    return result;
  }
}
