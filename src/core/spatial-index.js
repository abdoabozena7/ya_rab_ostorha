// Broad-phase lookup only; all accepted moves still pass exact shape checks.
export class SpatialIndex {
  constructor(items = [], size = 12) {
    this.size = size;
    this.invSize = 1 / size;
    this.cells = new Map();
    for (let i = 0; i < items.length; i++) this.add(items[i]);
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
