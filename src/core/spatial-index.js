// Broad-phase lookup only; all accepted moves still pass exact shape checks.
export class SpatialIndex {
  constructor(items = [], size = 12) {
    this.size = size;
    this.cells = new Map();
    for (const item of items) this.add(item);
  }
  add(item) {
    const x = Math.floor(item.x / this.size), z = Math.floor(item.z / this.size);
    let row = this.cells.get(x);
    if (!row) this.cells.set(x, row = new Map());
    const cell = row.get(z);
    if (cell) cell.push(item);
    else row.set(z, [item]);
  }
  near(point, radius) {
    const result = [];
    const right = Math.floor((point.x + radius) / this.size);
    const back = Math.floor((point.z - radius) / this.size), front = Math.floor((point.z + radius) / this.size);
    for (let x = Math.floor((point.x - radius) / this.size); x <= right; x++) {
      const row = this.cells.get(x);
      if (!row) continue;
      for (let z = back; z <= front; z++) {
        const cell = row.get(z);
        if (!cell) continue;
        for (const item of cell)
          if (Math.hypot(item.x - point.x, item.z - point.z) <= radius) result.push(item);
      }
    }
    return result;
  }
}
