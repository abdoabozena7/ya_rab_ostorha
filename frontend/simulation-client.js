import { SimulationProvider } from './provider.js';
import { trafficCommandBlocked } from './traffic-preparation.js';

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
    this.route = this.dashboardResult = this.operationError = null;
    this.safetySystem = null;
    this.comparisonDemo = null;
    this.comparisonV2 = null;
    this.recordedComparisonV2 = null;
    this.stopDiagnostics = null;
    this.rearAssist = false;
    this.manualDrivingMode = 'ROBOSPHERE';
    this.navigationAvailable = false;
    this.lastControlSentAt = -Infinity;
    this.lastManualFrame = null;
    this.simulatorStart = null;
    this.starting = false;
  }

  get simulationStarting() { return this.starting || this.simulatorStart?.status==='STARTING'; }

  async startSimulation() {
    return this.requestSimulationStart(false);
  }

  async resetSimulation() {
    return this.requestSimulationStart(true);
  }

  async requestSimulationStart(reset) {
    if(this.closed || this.isReplay) return false;
    if(!reset && this.connected && this.fresh) return true;
    if(this.simulationStarting) return false;
    this.operationError=null;this.starting=true;this.resetting=reset;this.resetReady=false;this.resetSession=this.sessionId;
    this.simulatorStart={status:'STARTING',...(reset?{operation:'RESET'}:{})};
    this.startTimer=this.schedule(()=>{
      this.starting=false;this.resetting=false;this.simulatorStart={status:'FAILED',error:'Simulation startup timed out. Check runtime details and retry.'};
      this.operationError=this.simulatorStart.error;
    },180_000);
    try {
      const response=await this.fetcher(reset?'/api/simulation/reset-session':'/api/simulation/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const result=await response.json();
      if(!response.ok || result.status==='FAILED')throw new Error(result.error||'Simulation could not start. Retry from this button.');
      this.retryMs=1000;
      await this.connect();
      return true;
    } catch(error) {
      this.cancel(this.startTimer);this.startTimer=null;this.starting=false;this.resetting=false;
      this.simulatorStart={status:'FAILED',error:error.message};this.operationError=error.message;
      return false;
    }
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
      this.imageWebsocketUrl=status.imageWebsocketPath&&!this.isReplay?
        `${this.location.protocol==='https:'?'wss':'ws'}://${this.location.hostname}:${status.websocketPort}${status.imageWebsocketPath}`:null;
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
    if (message.type === 'error') { this.operationError = message.error; this.failedSequence=message.sequence; return; }
    if (message.type !== 'snapshot') return;
    this.lastMessageAt=this.now();
    this.acknowledged=message.acknowledged;
    if (message.sessionId && this.sessionId && message.sessionId !== this.sessionId) this.disconnect('New native session');
    this.sessionId = message.sessionId ?? this.sessionId;
    this.journey = message.journey ?? {};
    this.journeyComparison = message.journeyComparison ?? this.journeyComparison ?? null;
    this.hybridDriving = message.hybridDriving ?? null;
    this.navigationAvailable = message.navigationAvailable === true;
    this.restarting = message.restarting ?? false;
    this.restartResult = message.restartResult ?? null;
    this.presentation = message.presentation ?? null;
    this.drivingForecast = message.drivingForecast ?? null;
    this.simulatorStop = message.simulatorStop ?? null;
    this.simulatorStart = message.simulatorStart ?? this.simulatorStart;
    this.simulatorReset = message.simulatorReset ?? null;
    if(this.simulatorStart?.status==='FAILED') {
      this.starting=false;this.cancel(this.startTimer);this.startTimer=null;
      this.operationError=this.simulatorStart.error;
    }
    this.performance = message.performance ?? {};
    this.controlSource = message.controlSource;
    this.recording = message.recording ?? false;
    this.dashboardResult = message.dashboardResult ?? null;
    this.route = message.route ?? null;
    this.population = message.population ?? null;
    this.environment = message.environment ?? null;
    this.safetySystem = message.safetySystem ?? null;
    this.comparisonDemo = message.comparisonDemo ?? null;
    this.comparisonV2 = message.comparisonV2 ?? null;
    if (this.comparisonV2) this.recordedComparisonV2 = {
      pair_id:this.comparisonV2.pair_id, seed:this.comparisonV2.seed,
      results:this.comparisonV2.results, latest_attempt:this.comparisonV2.latest_attempt};
    this.stopDiagnostics = message.stopDiagnostics ?? null;
    this.lastDriveStop = message.lastDriveStop ?? null;
    this.rearAssist = message.rearAssist === true;
    this.manualDrivingMode = message.manualDrivingMode ?? this.manualDrivingMode;
    this.displayCamera = message.displayCamera ?? null;
    this.motionQuality = message.motionQuality ?? null;
    this.maneuver = message.maneuver ?? null;
    this.controlScene = message.controlScene ?? null;
    this.controlSceneError = message.controlSceneError ?? null;
    this.controlDecisionPrediction = message.controlDecisionPrediction ?? null;
    this.nearbyActors = message.nearbyActors ?? null;
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
      if(!replay && this.starting && (!this.resetting || message.sessionId!==this.resetSession)) {
        this.resetReady=!!this.resetting;this.resetting=false;
        this.starting=false;this.cancel(this.startTimer);this.startTimer=null;
        this.simulatorStart={...this.simulatorStart,status:'READY'};this.operationError=null;
      }
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
    }
    // Snapshots can coalesce several ordered WebSocket acknowledgements.
    // Retire every earlier request, including a start immediately followed by stop.
    if (Number.isInteger(message.acknowledged)) for (const sequence of this.pending.keys()) {
      if (sequence <= message.acknowledged) this.pending.delete(sequence);
    }
  }

  disconnect(reason) {
    this.cancel(this.connectTimer); this.connectTimer = null;
    this.connected = this.controller = false;
    this.telemetry = unavailableState();
    this.world = {};
    this.sensorMetadata = {}; this.sensorRates = {}; this.sensorErrors = {};
    this.displayCamera = this.motionQuality = this.maneuver = null;
    this.controlScene = this.controlSceneError = this.controlDecisionPrediction = null;
    this.pending.clear(); this.latencyMs = null; this.gearCommand = 1;
    this.lastManualFrame = null;
    this.status = reason; this.phase = 'DISCONNECTED';
    this.isReplay = false; this.controlMode = 'DISCONNECTED'; this.replay = null;
    this.lastFrame = this.lastTimestamp = null;
    this.route = null;
    this.navigationAvailable = false;
    this.population = this.nearbyActors = null;
    this.environment = null;
    this.safetySystem = null;
    this.drivingForecast = null;
    this.comparisonDemo = null;
    this.comparisonV2 = null;
    this.stopDiagnostics = null;
    this.rearAssist = false;
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
  get transportAlive() { return this.socket?.readyState===1&&this.now()-(this.lastMessageAt??-Infinity)<2000; }
  getVehicleState() { return this.fresh ? this.telemetry : unavailableState(); }
  async getSensorFrame(name) {
    const response = await this.fetcher(`/api/simulation/sensor?name=${encodeURIComponent(name)}`, {cache: 'no-store'});
    const frame = await response.json();
    if (!response.ok) throw new Error(frame.error);
    return frame;
  }
  send(type, payload = {}) {
    if (this.closed || this.isReplay || this.socket?.readyState !== 1) return false;
    if (this.restarting || this.simulationStarting) return false;
    if (trafficCommandBlocked(this.trafficPreparation, type, payload)) {
      return false;
    }
    const comparisonStart=type==='comparison_v2'&&payload.value?.operation==='RUN';
    const presentationStart=type==='presentation'&&['RESTART','START_GUIDED','PRELOAD'].includes(payload.value?.operation);
    if (!['reconnect','stop_simulator'].includes(type) && (!this.connected || !this.fresh || (!this.controller && !comparisonStart&&!presentationStart&&!['start_driving','start_journey','take_control','emergency_stop'].includes(type)))) return false;
    if (type === 'controls' && ['PAUSED', 'EMERGENCY_STOP', 'DISCONNECTED'].includes(this.controlMode)) return false;
    if (type === 'controls' && this.now()-this.lastControlSentAt < 30) return false;
    const sequence = ++this.sequence;
    this.pending.set(sequence, this.now());
    if (this.pending.size > 40) this.pending.delete(this.pending.keys().next().value);
    this.socket.send(JSON.stringify({type, sequence, frame_id: this.telemetry.frame, timestamp_s: this.telemetry.timestamp, ...payload}));
    if (type === 'controls') this.lastControlSentAt = this.now();
    return true;
  }
  startDriving(driving_mode=null) {
    this.operationError = null; this.lastManualFrame = null;
    return this.send('start_driving', driving_mode?{driving_mode}:{});
  }
  startJourney(speed_kmh, driving_mode=null, pair_id=null, benchmark=false) {
    this.operationError = null;
    return this.send('start_journey', {speed_kmh,...(driving_mode?{driving_mode}:{}),...(pair_id?{pair_id}:{}),...(benchmark?{benchmark:true}:{})});
  }
  journeyHeartbeat() { return this.send('journey_heartbeat', {session_id:this.sessionId}); }
  journeySpeed(speed_kmh) { this.operationError = null; return this.send('journey_speed', {speed_kmh}); }
  stopDriving(reason = 'operator_stop') { return this.send('stop_driving', {reason}); }
  takeControl() { return this.send('take_control'); }
  stopSimulator() { this.operationError=null;return this.send('stop_simulator'); }
  reconnectNative() { this.operationError = null; return this.send('reconnect'); }
  dashboardAction(type, value) {
    this.operationError = null;
    if(this.send(type,{value}))return true;
    this.operationError=this.simulationStarting?'The simulator is still starting.':!this.connected||!this.fresh?
      'Waiting for a live simulator connection. Reconnect to try this action.':!this.controller?
      'This page does not control the current drive. Prepare a fresh drive here.':'The action could not be sent. Check the session connection and try again.';
    return false;
  }
  async catalog() {
    const response = await this.fetcher('/api/simulation/catalog', {cache:'no-store'});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }
  updateControls({throttle = 0, brake = 0, steering = 0, parkingbrake = 0} = {}) {
    // Sample the latest keys once per native observation. Repeated snapshots
    // must not queue old commands faster than the simulator can admit them.
    if (this.telemetry.frame === this.lastManualFrame) return false;
    const controls = {throttle, brake, steering, parkingbrake};
    if (this.gearCommand != null) controls.gear = this.gearCommand;
    if (this.send('controls', {controls})) {
      this.lastManualFrame = this.telemetry.frame;
      this.gearCommand = null; return true;
    }
    return false;
  }
  setGear(gear) { this.gearCommand = gear; }
  resetVehicle() { this.gearCommand = 1; return this.send('reset'); }
  setPaused(paused) { this.releaseControls(); this.send('pause', {paused}); }
  releaseControls() {
    this.cancel(this.releaseTimer);
    if (!this.send('controls', {controls:{throttle:0, brake:1, steering:0, parkingbrake:0}})
        && this.connected && this.controller && !this.isReplay) {
      this.releaseTimer = this.schedule(() => {
        this.releaseTimer = null;
        this.send('controls', {controls:{throttle:0, brake:1, steering:0, parkingbrake:0}});
      }, 35);
    }
  }
  emergencyStop() { return this.send('emergency_stop'); }
  acknowledgeStop() { return this.send('acknowledge_stop'); }
  async setReplayPaused(paused) {
    if (!this.isReplay) return false;
    const response = await this.fetcher('/api/simulation/replay', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({paused})});
    if (!response.ok) throw new Error('Replay playback request failed');
    return true;
  }
  close() {
    if(this.controlMode!=='AUTOMATIC'&&this.journey?.status!=='STARTING')this.releaseControls();
    this.closed = true;
    this.cancel(this.retryTimer); this.retryTimer = null;
    this.cancel(this.connectTimer); this.connectTimer = null;
    this.cancel(this.releaseTimer); this.releaseTimer = null;
    this.cancel(this.startTimer); this.startTimer = null;
    this.socket?.close(); this.disconnect('Disconnected');
  }
}
