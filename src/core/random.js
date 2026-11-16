// Serialisable PRNG. All simulation randomness must come from this stream.
export class Random {
  constructor(seed = 1) {
    this.state = 2166136261;
    for (const char of String(seed))
      this.state = Math.imul(this.state ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) {
    return a + (b - a) * this.next();
  }
  pick(items) {
    return items[Math.floor(this.next() * items.length)];
  }
}
