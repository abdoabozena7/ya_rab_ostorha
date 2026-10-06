import { stepVehicle } from './vehicle-dynamics.js?v=drive-final';

// Contract shared by the browser dashboard and the future authoritative backend.
// Every value carries a simulation timestamp and a source label.
export const WHEEL_RADIUS_M = 0.35;
// Matches detailed-sedan wheel construction order: left rear/front, right rear/front.
export const WHEEL_NAMES = ['rearLeft', 'frontLeft', 'rearRight', 'frontRight'];

export class SimulationProvider {
  getVehicleState() { throw new Error('getVehicleState must be implemented'); }
  getEngineState() { return this.getVehicleState(); }
  getDamageState() { return this.getVehicleState().damage; }
  getSensorFrame() { return null; }
  setThrottle(value) { this.commandThrottle = value; }
  setBrake(value) { this.commandBrake = value; }
  setSteering(value) { this.commandSteering = value; }
}

export class DevelopmentMockProvider extends SimulationProvider {
  constructor() { super(); this.resetVehicle(); }

  resetVehicle() {
    this.time = 0;
    this.tick = 0;
    this.state = { speed: 0, angle: 0, steering: 0, reverseWait: 0,
      throttle: 0, brake: 0, acceleration: 0, lateralAcceleration: 0 };
    this.fuelCapacity = 55;
    this.fuelLitres = 55;
    this.fuelUsed = 0;
    this.distanceM = 0;
    this.engineTemperature = 90;
    this.damage = Object.fromEntries(['body', 'front', 'rear', 'engine', 'cooling',
      'transmission', ...WHEEL_NAMES].map(name => [name, 0]));
    this.lastCollision = null;
    this.wheelAngles = [0, 0, 0, 0];
    this.wheelAngularVelocity = [0, 0, 0, 0];
    this.gear = 'N';
    this.rpm = 800;
    this.instantConsumption = 0;
    this.commandThrottle = undefined;
    this.commandBrake = undefined;
    this.commandSteering = undefined;
    return this.getVehicleState();
  }

  setFuelLitres(litres) { this.fuelLitres = Math.max(0, Math.min(this.fuelCapacity, litres)); }
  setThrottle(value) { this.commandThrottle = value; }
  setBrake(value) { this.commandBrake = value; }
  setSteering(value) { this.commandSteering = value; }

  step(input, dt = 1 / 60) {
    this.time += dt;
    this.tick++;
    const running = this.fuelLitres > 0 && this.damage.engine < 0.95;
    if(!running)this.state.throttle=0;
    const next = stepVehicle(this.state, {
      ...input,
      backward: running && input.backward,
      throttle: running ? (input.throttle ?? this.commandThrottle ?? 0) *
        Math.max(0.2, 1 - this.damage.transmission * 0.7) : 0,
      brake: input.brake ?? this.commandBrake ?? 0,
      ...(this.commandSteering === undefined ? {} : { steering: this.commandSteering }),
    }, dt);
    this.commandSteering = undefined;
    const v = next.speed * 60;
    const oldV = this.state.speed * 60;
    this.distanceM += Math.abs(v) * dt;
    this.state = next;
    this.gear = v < -0.1 ? 'R' : Math.abs(v) < 0.1 && next.throttle < 0.02 ? 'N' :
      String(Math.min(5, Math.max(1, Math.ceil(Math.abs(v) / 8))));
    const ratio = { R: 3.3, N: 0, 1: 3.4, 2: 2.1, 3: 1.4, 4: 1, 5: 0.8 }[this.gear];
    this.rpm = running ? Math.max(800, Math.min(6500,
      this.gear === 'N' ? 800 + next.throttle * 2500 : Math.abs(v) / WHEEL_RADIUS_M * ratio * 3.7 * 60 / (2 * Math.PI))) : 0;
    // Development-only fuel estimate in L/h, based on idle, load and engine speed.
    this.instantConsumption = running ? 0.7 + 11 * next.throttle * (0.35 + this.rpm / 6500) +
      1.2 * Math.max(0, (v - oldV) / dt) / 5 : 0;
    const used = this.instantConsumption * dt / 3600;
    this.fuelUsed += Math.min(used, this.fuelLitres);
    this.fuelLitres = Math.max(0, this.fuelLitres - used);
    const targetTemperature=running ? 90 + 10 * next.throttle + this.damage.cooling * 45 : 25;
    this.engineTemperature += (targetTemperature - this.engineTemperature) * dt / 35;
    this.wheelAngularVelocity = this.wheelAngularVelocity.map(() => v / WHEEL_RADIUS_M);
    this.wheelAngles = this.wheelAngles.map((angle, i) => angle + this.wheelAngularVelocity[i] * dt);
    return this.getVehicleState();
  }

  recordCollision({ speedMps, direction = 'front', position = null, component = 'body' }) {
    const impulseNs = 1450 * Math.abs(speedMps);
    const severity = Math.min(1, impulseNs / 40000);
    const key = Object.hasOwn(this.damage, component) ? component : 'body';
    this.damage.body = Math.min(1, this.damage.body + severity * 0.3);
    if(key!=='body' && key!=='front') this.damage[key] = Math.min(1, this.damage[key] + severity);
    if (direction === 'front') {
      this.damage.front = Math.min(1, this.damage.front + severity);
      if (severity > 0.5) {
        this.damage.cooling = Math.min(1, this.damage.cooling + severity * 0.4);
        this.damage.engine = Math.min(1, this.damage.engine + severity * 0.25);
      }
    }
    this.lastCollision = { timestamp: this.time, impulseNs, collisionVelocityMps: Math.abs(speedMps),
      direction, position, component: key, severity, source: 'development-mock' };
    this.state.speed = 0;
    this.wheelAngularVelocity.fill(0);
    return this.lastCollision;
  }

  getVehicleState() {
    const v = this.state.speed * 60;
    const averageConsumption = this.distanceM > 100 ? this.fuelUsed / this.distanceM * 100000 : null;
    return { schemaVersion:1,source: 'development-mock', timestamp: this.time, physicsTick: this.tick,
      massKg: 1450, centerOfMassM: [0, 0.53, 0], speedMps: v,
      accelerationMps2: this.state.acceleration, lateralAccelerationMps2: this.state.lateralAcceleration,
      steeringAngleRad: this.state.steering, throttle: this.state.throttle, brake: this.state.brake,
      steeringWheelAngleRad:this.state.steering*8,
      gear: this.gear, engineRunning: this.rpm > 0, engineRPM: this.rpm, idleRPM: 800,
      engineLoad: this.state.throttle, engineTemperatureC: this.engineTemperature,
      fuelCapacityL: this.fuelCapacity, fuelLevelL: this.fuelLitres,
      fuelConsumptionRateLph: this.instantConsumption, instantConsumptionLph: this.instantConsumption,
      averageConsumptionLPer100Km: averageConsumption,
      estimatedRangeKm: averageConsumption ? this.fuelLitres / averageConsumption * 100 : null,
      wheels: WHEEL_NAMES.map((name, i) => ({ name, radiusM: WHEEL_RADIUS_M,
        angularVelocityRadps: this.wheelAngularVelocity[i], angleRad: this.wheelAngles[i],
        rpm: this.wheelAngularVelocity[i] * 60 / (2 * Math.PI),
        steeringAngleRad: i % 2 === 1 ? this.state.steering : 0,
        suspensionCompressionM: null, slip: null })),
      damage: { ...this.damage }, lastCollision: this.lastCollision };
  }

  getEngineState() { return this.getVehicleState(); }
  getDamageState() { return { ...this.damage }; }
  getSensorFrame() { return null; } // No fabricated depth, radar or LiDAR data.
  spawnVehicle() { throw new Error('Vehicle spawning requires a real simulation provider'); }
}
