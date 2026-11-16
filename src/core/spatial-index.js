// Broad-phase lookup only; all accepted moves still pass exact shape checks.
export class SpatialIndex {
  constructor(items = [], size = 12) {
    this.size = size;
    this.cells = new Map();
    for (const item of items) this.add(item);
  }
  add(item) {
    const key = `${Math.floor(item.x / this.size)},${Math.floor(item.z / this.size)}`;
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(item);
  }
  near(point, radius) {
    const result = [];
    for (
      let x = Math.floor((point.x - radius) / this.size);
      x <= Math.floor((point.x + radius) / this.size);
      x++
    )
      for (
        let z = Math.floor((point.z - radius) / this.size);
        z <= Math.floor((point.z + radius) / this.size);
        z++
      )
        for (const item of this.cells.get(`${x},${z}`) ?? [])
          if (Math.hypot(item.x - point.x, item.z - point.z) <= radius)
            result.push(item);
    return result;
  }
}
