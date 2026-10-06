// Keyboard-to-pedal/gear policy. Motion and drivetrain are exclusively BeamNG's.
export class DrivingControls {
  constructor() { this.clear(); }
  clear() { this.keys = new Set(); this.reverseSince = null; this.mode = 'D'; this.gear = 1; }
  setMode(mode) { this.mode = mode; this.reverseSince = null; }
  sample(speedMps, nowMs) {
    const w = this.keys.has('KeyW'), s = this.keys.has('KeyS');
    const result = {throttle: 0, brake: 0, steering: Number(this.keys.has('KeyA')) - Number(this.keys.has('KeyD')),
      parkingbrake: this.keys.has('Space') ? 1 : 0, gear: this.gear};
    if (!Number.isFinite(speedMps)) return {...result, brake: 1, steering: 0};
    if (this.keys.has('Space') || (w && s)) { this.reverseSince = null; return {...result, brake: 1}; }
    if (this.mode === 'N') { this.gear = result.gear = 0; result.brake = Number(s); return result; }
    if (w) {
      this.reverseSince = null;
      const oppositeMotion = this.mode === 'R' ? speedMps > .35 : speedMps < -.35;
      result.brake = Number(oppositeMotion); result.throttle = Number(!oppositeMotion);
      if (!oppositeMotion) this.gear = result.gear = this.mode === 'R' ? -1 : 1;
    } else if (s) {
      if (this.mode === 'R') { result.brake = 1; return result; }
      if (speedMps > .35) { this.reverseSince = null; result.brake = 1; }
      else {
        this.reverseSince ??= nowMs;
        if (speedMps < -.35 || nowMs - this.reverseSince >= 300) {
          this.gear = result.gear = -1; result.throttle = 1;
        } else result.brake = 1;
      }
    } else this.reverseSince = null;
    return result;
  }
}
