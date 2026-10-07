import { SimulationProvider, WHEEL_NAMES } from '/frontend/provider.js';

export function unavailableBeamNGState() {
  return { source: 'beamng', timestamp: null, physicsTick: null, speedMps: null,
    accelerationMps2: null, steeringAngleRad: null, steeringWheelAngleRad: null,
    throttle: null, brake: null, gear: null, engineRPM: null, engineRunning: null,
    fuelLevelL: null, fuelCapacityL: null, instantConsumptionLph: null,
    wheels: WHEEL_NAMES.map(name => ({name, rpm: null, angleRad: null,
      steeringAngleRad: null, suspensionCompressionM: null})), damage: {} };
}

// This transport has no renderer, vehicle model, or fallback physics.
export class BeamNGProvider extends SimulationProvider {
  constructor({fetcher = (...args) => globalThis.fetch(...args), Socket = globalThis.WebSocket,
    location = globalThis.location, now = () => performance.now(),
    schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
    cancel = timer => globalThis.clearTimeout(timer)} = {}) {
    super();
    Object.assign(this, {fetcher, Socket, location, now, schedule, cancel});
    this.telemetry = unavailableBeamNGState();
    this.connected = false;
    this.controller = false;
    this.status = 'BEAMNG NOT AVAILABLE';
    this.sequence = 0;
    this.pending = new Map();
    this.sensorMetadata = {};
    this.sensorRates = {};
    this.sensorErrors = {};
    this.latencyMs = null;
    this.receivedAt = -Infinity;
    this.gearCommand = 1;
    this.retryMs = 1000;
    this.closed = false;
  }

  async connect() {
    if (this.closed || this.connecting || this.socket?.readyState <= 1) return;
    this.cancel(this.retryTimer); this.retryTimer = null;
    this.connecting = true;
    try {
      const response = await this.fetcher('/api/simulation/status', {cache: 'no-store'});
      if (!response.ok) throw new Error('Application backend unavailable');
      const status = await response.json();
      if (!status.configured || status.provider !== 'beamng' || !status.websocketPort)
        throw new Error(status.error || 'BeamNG.tech installation is required');
      if (this.closed) return;
      const socket = new this.Socket(`${this.location.protocol === 'https:' ? 'wss' : 'ws'}://${this.location.hostname}:${status.websocketPort}`);
      this.socket = socket;
      socket.onmessage = event => {
        if (socket !== this.socket) return;
        try { this.acceptSnapshot(JSON.parse(event.data)); }
        catch { this.disconnect('Invalid backend telemetry'); socket.close(); }
      };
      socket.onclose = () => {
        if (socket !== this.socket) return;
        this.socket = null;
        this.disconnect('BeamNG connection closed; controls released');
        this.retry();
      };
      socket.onerror = () => {
        this.disconnect('BeamNG connection error; controls released');
        socket.close();
      };
    } catch (error) {
      this.disconnect(error.message);
      this.retry();
    } finally { this.connecting = false; }
  }

  acceptSnapshot(message) {
    if (message.type === 'error') { this.status = message.error; return; }
    if (message.type !== 'snapshot') return;
    const live = message.connected === true && message.vehicle?.source === 'beamng';
    if (!live) this.disconnect(message.error || 'Waiting for live BeamNG telemetry');
    else {
      this.connected = true;
      this.controller = message.controller === true;
      this.telemetry = message.vehicle;
      this.receivedAt = this.now();
      this.retryMs = 1000;
      this.status = this.controller ? 'BEAMNG CONNECTED' : 'BEAMNG CONNECTED · READ ONLY';
      this.sensorMetadata = message.sensors ?? {};
      this.sensorRates = message.sensorPollHz ?? {};
      this.sensorErrors = message.sensorErrors ?? {};
    }
    const sent = this.pending.get(message.acknowledged);
    if (sent != null) {
      this.latencyMs = this.now() - sent;
      this.pending.delete(message.acknowledged);
    }
  }

  disconnect(reason) {
    this.connected = this.controller = false;
    this.telemetry = unavailableBeamNGState();
    this.sensorMetadata = {}; this.sensorRates = {}; this.sensorErrors = {};
    this.pending.clear(); this.latencyMs = null; this.gearCommand = 1;
    this.status = reason;
  }

  retry() {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = this.schedule(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(15000, this.retryMs * 2);
  }

  get fresh() { return this.connected && this.now() - this.receivedAt < 750; }
  getVehicleState() { return this.fresh ? this.telemetry : unavailableBeamNGState(); }
  async getSensorFrame(name) {
    const response = await this.fetcher(`/api/simulation/sensor?name=${encodeURIComponent(name)}`, {cache: 'no-store'});
    const frame = await response.json();
    if (!response.ok) throw new Error(frame.error);
    return frame;
  }
  send(type, payload = {}) {
    if (this.closed || !this.fresh || !this.controller || this.socket?.readyState !== 1) return false;
    const sequence = ++this.sequence;
    this.pending.set(sequence, this.now());
    if (this.pending.size > 40) this.pending.delete(this.pending.keys().next().value);
    this.socket.send(JSON.stringify({type, sequence, ...payload}));
    return true;
  }
  updateControls({throttle = 0, brake = 0, steering = 0, parkingbrake = 0} = {}) {
    const controls = {throttle, brake, steering, parkingbrake};
    if (this.gearCommand != null) controls.gear = this.gearCommand;
    if (this.send('controls', {controls})) this.gearCommand = null;
  }
  setGear(gear) { this.gearCommand = gear; }
  resetVehicle() { this.releaseControls(); this.send('reset'); this.gearCommand = 1; }
  setPaused(paused) { this.releaseControls(); this.send('pause', {paused}); }
  releaseControls() { this.updateControls({brake: 1}); }
  close() {
    this.releaseControls(); this.closed = true;
    this.cancel(this.retryTimer); this.retryTimer = null;
    this.socket?.close(); this.disconnect('Disconnected');
  }
}
