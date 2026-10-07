import { SimulationProvider } from './provider.js';

export function unavailableState() {
  return { source: 'carla', timestamp: null, physicsTick: null, speedMps: null,
    accelerationMps2: null, steeringAngleRad: null, steeringWheelAngleRad: null,
    throttle: null, brake: null, gear: null, engineRPM: null, engineRunning: null,
    fuelLevelL: null, fuelCapacityL: null, instantConsumptionLph: null,
    positionWorldM: null, velocityWorldMps: null, steeringInput: null, frame: null, reverse: null };
}

// This transport has no renderer, vehicle model, or fallback physics.
export class SimulationClient extends SimulationProvider {
  constructor({fetcher = (...args) => globalThis.fetch(...args), Socket = globalThis.WebSocket,
    location = globalThis.location, now = () => performance.now(),
    schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
    cancel = timer => globalThis.clearTimeout(timer)} = {}) {
    super();
    Object.assign(this, {fetcher, Socket, location, now, schedule, cancel});
    this.telemetry = unavailableState();
    this.world = {};
    this.connected = false;
    this.controller = false;
    this.status = 'CARLA — DISCONNECTED';
    this.phase = 'DISCONNECTED';
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
    this.isReplay = false;
    this.controlMode = 'DISCONNECTED';
    this.replay = null;
    this.lastFrame = this.lastTimestamp = null;
  }

  async connect() {
    if (this.closed || this.connecting || this.socket?.readyState <= 1) return;
    this.cancel(this.retryTimer); this.retryTimer = null;
    this.connecting = true; this.phase = 'STARTING';
    const abort = new AbortController();
    this.connectTimer = this.schedule(() => {
      abort.abort(); const expiredSocket = this.socket; this.socket = null; expiredSocket?.close();
      this.disconnect('Connection timeout; controls suspended'); this.retry();
    }, 5000);
    try {
      const response = await this.fetcher('/api/simulation/status', {cache: 'no-store', signal: abort.signal});
      if (!response.ok) throw new Error('Application backend unavailable');
      const status = await response.json();
      if (!status.configured || !['carla', 'replay'].includes(status.provider) || !status.websocketPort)
        throw new Error(status.error || 'CARLA must be running with its matching Python API');
      if (this.closed || abort.signal.aborted) return;
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
        this.disconnect('CARLA connection closed; controls released');
        this.retry();
      };
      socket.onerror = () => {
        this.disconnect('CARLA connection error; controls released');
        socket.close();
      };
    } catch (error) {
      this.cancel(this.connectTimer); this.connectTimer = null;
      this.disconnect(error.message);
      this.retry();
    } finally { this.connecting = false; }
  }

  acceptSnapshot(message) {
    if (message.type === 'error') { this.disconnect(message.error); this.phase = 'ERROR'; return; }
    if (message.type !== 'snapshot') return;
    const replay = message.mode === 'REPLAY' && message.provider === 'replay' && message.connected === false
      && message.available === true && message.replay?.dataOrigin === 'REAL_SIMULATION';
    const sourceValid = replay ? message.vehicle?.source === message.replay.recordedProvider && message.world?.source === message.replay.recordedProvider
      : message.connected === true && message.mode !== 'REPLAY' && message.provider !== 'replay' && message.vehicle?.source === 'carla' && message.world?.source === 'carla';
    const live = sourceValid && Number.isInteger(message.vehicle.frame) && message.vehicle.frame >= 0
      && Number.isFinite(message.vehicle.timestamp) && message.vehicle.timestamp >= 0 && message.world.frame === message.vehicle.frame
      && message.world.timestamp === message.vehicle.timestamp;
    if (!live) { this.disconnect(message.error || 'Waiting for live CARLA telemetry'); if (message.error) this.phase = 'ERROR'; }
    else {
      if (!replay && this.lastFrame != null && (message.vehicle.frame < this.lastFrame || message.vehicle.timestamp < this.lastTimestamp
          || message.vehicle.frame === this.lastFrame && message.vehicle.timestamp !== this.lastTimestamp
          || message.vehicle.frame > this.lastFrame && message.vehicle.timestamp <= this.lastTimestamp)) {
        this.disconnect('Out-of-order native observations; controls suspended'); this.phase = 'ERROR'; return;
      }
      const newFrame = replay || message.vehicle.frame !== this.lastFrame;
      this.connected = !replay; this.isReplay = replay; this.phase = replay ? 'REPLAY' : 'CONNECTED';
      this.controlMode = replay ? 'REPLAY' : message.mode ?? 'MANUAL';
      this.replay = replay ? message.replay : null;
      this.cancel(this.connectTimer); this.connectTimer = null;
      this.world = message.world ?? {};
      this.controller = !replay && message.controller === true;
      this.telemetry = message.vehicle;
      if (newFrame || this.controlMode === 'PAUSED') this.receivedAt = this.now();
      this.lastFrame = message.vehicle.frame; this.lastTimestamp = message.vehicle.timestamp;
      this.retryMs = 1000;
      this.status = replay ? `MODE: REPLAY · Recorded run ${message.replay.runId} · No simulator connection`
        : this.controller ? `CARLA — CONNECTED · ${this.controlMode.replaceAll('_', ' ')}` : 'CARLA — CONNECTED · READ ONLY';
      this.sensorMetadata = message.sensors ?? {};
      this.sensorRates = message.sensorRatesHz ?? {};
      this.sensorErrors = message.sensorErrors ?? {};
    }
    const sent = this.pending.get(message.acknowledged);
    if (sent != null) {
      this.latencyMs = this.now() - sent;
      this.pending.delete(message.acknowledged);
    }
  }

  disconnect(reason) {
    this.cancel(this.connectTimer); this.connectTimer = null;
    this.connected = this.controller = false;
    this.telemetry = unavailableState();
    this.world = {};
    this.sensorMetadata = {}; this.sensorRates = {}; this.sensorErrors = {};
    this.pending.clear(); this.latencyMs = null; this.gearCommand = 1;
    this.status = reason; this.phase = 'DISCONNECTED';
    this.isReplay = false; this.controlMode = 'DISCONNECTED'; this.replay = null;
    this.lastFrame = this.lastTimestamp = null;
  }

  retry() {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = this.schedule(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(15000, this.retryMs * 2);
  }

  get fresh() { return (this.connected || this.isReplay) && this.now() - this.receivedAt < 750; }
  getVehicleState() { return this.fresh ? this.telemetry : unavailableState(); }
  async getSensorFrame(name) {
    const response = await this.fetcher(`/api/simulation/sensor?name=${encodeURIComponent(name)}`, {cache: 'no-store'});
    const frame = await response.json();
    if (!response.ok) throw new Error(frame.error);
    return frame;
  }
  send(type, payload = {}) {
    if (this.closed || this.isReplay || !this.connected || !this.fresh || !this.controller || this.socket?.readyState !== 1) return false;
    if (type === 'controls' && ['PAUSED', 'EMERGENCY_STOP', 'DISCONNECTED'].includes(this.controlMode)) return false;
    const sequence = ++this.sequence;
    this.pending.set(sequence, this.now());
    if (this.pending.size > 40) this.pending.delete(this.pending.keys().next().value);
    this.socket.send(JSON.stringify({type, sequence, frame_id: this.telemetry.frame, timestamp_s: this.telemetry.timestamp, ...payload}));
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
  emergencyStop() { return this.send('emergency_stop'); }
  acknowledgeStop() { return this.send('acknowledge_stop'); }
  async setReplayPaused(paused) {
    if (!this.isReplay) return false;
    const response = await this.fetcher('/api/simulation/replay', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({paused})});
    if (!response.ok) throw new Error('Replay playback request failed');
    return true;
  }
  close() {
    this.releaseControls(); this.closed = true;
    this.cancel(this.retryTimer); this.retryTimer = null;
    this.cancel(this.connectTimer); this.connectTimer = null;
    this.socket?.close(); this.disconnect('Disconnected');
  }
}
