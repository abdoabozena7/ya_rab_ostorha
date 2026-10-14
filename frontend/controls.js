// Keyboard-to-pedal/gear policy. Motion and drivetrain are exclusively the native simulator's.
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
      const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      const speedLimitMps = (boost ? 80 : 30) / 3.6;
      const forwardSpeed = Math.max(0, speedMps);
      // Manual boost raises the speed ceiling; it never bypasses a brake or
      // asks the simulator to exceed 80 km/h on a clear straight road.
      const remaining = Math.max(0, speedLimitMps - forwardSpeed);
      const pedal = boost ? Math.min(1, remaining / 3) : Math.min(.55, remaining / 3);
      result.brake = Number(oppositeMotion);
      result.throttle = oppositeMotion ? 0 : this.mode === 'R' ? .55 : pedal;
      if (!oppositeMotion && this.mode === 'D' && forwardSpeed > speedLimitMps)
        result.brake = Math.min(.35, Math.max(.05, (forwardSpeed - speedLimitMps) / 4));
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
