(() => {
  // frontend/provider.js
  var SimulationProvider = class {
    getVehicleState() {
      throw new Error("getVehicleState must be implemented");
    }
    getEngineState() {
      return this.getVehicleState();
    }
    getDamageState() {
      return this.getVehicleState().damage;
    }
    getSensorFrame() {
      throw new Error("Sensor unavailable");
    }
    updateControls() {
      throw new Error("updateControls must be implemented");
    }
  };

  // frontend/simulation-client.js
  function unavailableState() {
    return {
      source: "carla",
      timestamp: null,
      physicsTick: null,
      speedMps: null,
      accelerationMps2: null,
      steeringAngleRad: null,
      steeringWheelAngleRad: null,
      throttle: null,
      brake: null,
      gear: null,
      engineRPM: null,
      engineRunning: null,
      fuelLevelL: null,
      fuelCapacityL: null,
      instantConsumptionLph: null,
      positionWorldM: null,
      velocityWorldMps: null,
      steeringInput: null,
      frame: null,
      reverse: null
    };
  }
  var SimulationClient = class extends SimulationProvider {
    constructor({
      fetcher = (...args) => globalThis.fetch(...args),
      Socket = globalThis.WebSocket,
      location = globalThis.location,
      now = () => performance.now(),
      schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
      cancel = (timer) => globalThis.clearTimeout(timer)
    } = {}) {
      super();
      Object.assign(this, { fetcher, Socket, location, now, schedule, cancel });
      this.telemetry = unavailableState();
      this.world = {};
      this.connected = false;
      this.controller = false;
      this.status = "CARLA \u2014 DISCONNECTED";
      this.phase = "DISCONNECTED";
      this.sequence = 0;
      this.pending = /* @__PURE__ */ new Map();
      this.sensorMetadata = {};
      this.sensorRates = {};
      this.sensorErrors = {};
      this.latencyMs = null;
      this.receivedAt = -Infinity;
      this.gearCommand = 1;
      this.retryMs = 1e3;
      this.closed = false;
      this.isReplay = false;
      this.controlMode = "DISCONNECTED";
      this.replay = null;
      this.lastFrame = this.lastTimestamp = null;
      this.route = this.dashboardResult = this.operationError = null;
      this.safetySystem = null;
      this.navigationAvailable = false;
      this.lastControlSentAt = -Infinity;
    }
    async connect() {
      if (this.closed || this.connecting || this.socket?.readyState <= 1) return;
      this.cancel(this.retryTimer);
      this.retryTimer = null;
      this.connecting = true;
      this.phase = "STARTING";
      const abort = new AbortController();
      this.connectTimer = this.schedule(() => {
        abort.abort();
        const expiredSocket = this.socket;
        this.socket = null;
        expiredSocket?.close();
        this.disconnect("Connection timeout; controls suspended");
        this.retry();
      }, 5e3);
      try {
        const response = await this.fetcher("/api/simulation/status", { cache: "no-store", signal: abort.signal });
        if (!response.ok) throw new Error("Application backend unavailable");
        const status = await response.json();
        if (!status.configured || !["carla", "replay"].includes(status.provider) || !status.websocketPort)
          throw new Error(status.error || "CARLA must be running with its matching Python API");
        if (this.closed || abort.signal.aborted) return;
        const socket = new this.Socket(`${this.location.protocol === "https:" ? "wss" : "ws"}://${this.location.hostname}:${status.websocketPort}`);
        this.socket = socket;
        socket.onmessage = (event) => {
          if (socket !== this.socket) return;
          try {
            this.acceptSnapshot(JSON.parse(event.data));
          } catch {
            this.disconnect("Invalid backend telemetry");
            socket.close();
          }
        };
        socket.onclose = () => {
          if (socket !== this.socket) return;
          this.socket = null;
          this.disconnect("CARLA connection closed; controls released");
          this.retry();
        };
        socket.onerror = () => {
          this.disconnect("CARLA connection error; controls released");
          socket.close();
        };
      } catch (error) {
        this.cancel(this.connectTimer);
        this.connectTimer = null;
        this.disconnect(error.message);
        this.retry();
      } finally {
        this.connecting = false;
      }
    }
    acceptSnapshot(message) {
      if (message.type === "error") {
        this.operationError = message.error;
        return;
      }
      if (message.type !== "snapshot") return;
      if (message.sessionId && this.sessionId && message.sessionId !== this.sessionId) this.disconnect("New native session");
      this.sessionId = message.sessionId ?? this.sessionId;
      this.journey = message.journey ?? {};
      this.navigationAvailable = message.navigationAvailable === true;
      this.restarting = message.restarting ?? false;
      this.restartResult = message.restartResult ?? null;
      this.performance = message.performance ?? {};
      this.controlSource = message.controlSource;
      this.recording = message.recording ?? false;
      this.dashboardResult = message.dashboardResult ?? null;
      this.route = message.route ?? null;
      this.population = message.population ?? null;
      this.environment = message.environment ?? null;
      this.safetySystem = message.safetySystem ?? null;
      this.nearbyActors = message.nearbyActors ?? null;
      const replay = message.mode === "REPLAY" && message.provider === "replay" && message.connected === false && message.available === true && message.replay?.dataOrigin === "REAL_SIMULATION";
      const sourceValid = replay ? message.vehicle?.source === message.replay.recordedProvider && message.world?.source === message.replay.recordedProvider : message.connected === true && message.mode !== "REPLAY" && message.provider !== "replay" && message.vehicle?.source === "carla" && message.world?.source === "carla";
      const live = sourceValid && Number.isInteger(message.vehicle.frame) && message.vehicle.frame >= 0 && Number.isFinite(message.vehicle.timestamp) && message.vehicle.timestamp >= 0 && message.world.frame === message.vehicle.frame && message.world.timestamp === message.vehicle.timestamp;
      if (!live) {
        this.disconnect(message.error || "Waiting for live CARLA telemetry");
        if (message.error) this.phase = "ERROR";
      } else {
        if (!replay && this.lastFrame != null && (message.vehicle.frame < this.lastFrame || message.vehicle.timestamp < this.lastTimestamp || message.vehicle.frame === this.lastFrame && message.vehicle.timestamp !== this.lastTimestamp || message.vehicle.frame > this.lastFrame && message.vehicle.timestamp <= this.lastTimestamp)) {
          this.disconnect("Out-of-order native observations; controls suspended");
          this.phase = "ERROR";
          return;
        }
        const newFrame = replay || message.vehicle.frame !== this.lastFrame;
        this.connected = !replay;
        this.isReplay = replay;
        this.phase = replay ? "REPLAY" : "CONNECTED";
        this.controlMode = replay ? "REPLAY" : message.mode ?? "MANUAL";
        this.replay = replay ? message.replay : null;
        this.cancel(this.connectTimer);
        this.connectTimer = null;
        this.world = message.world ?? {};
        this.controller = !replay && message.controller === true;
        this.telemetry = message.vehicle;
        if (newFrame || this.controlMode === "PAUSED") this.receivedAt = this.now();
        this.lastFrame = message.vehicle.frame;
        this.lastTimestamp = message.vehicle.timestamp;
        this.retryMs = 1e3;
        this.status = replay ? `MODE: REPLAY \xB7 Recorded run ${message.replay.runId} \xB7 No simulator connection` : this.controller ? `CARLA \u2014 CONNECTED \xB7 ${this.controlMode.replaceAll("_", " ")}` : "CARLA \u2014 CONNECTED \xB7 READ ONLY";
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
      this.cancel(this.connectTimer);
      this.connectTimer = null;
      this.connected = this.controller = false;
      this.telemetry = unavailableState();
      this.world = {};
      this.sensorMetadata = {};
      this.sensorRates = {};
      this.sensorErrors = {};
      this.pending.clear();
      this.latencyMs = null;
      this.gearCommand = 1;
      this.status = reason;
      this.phase = "DISCONNECTED";
      this.isReplay = false;
      this.controlMode = "DISCONNECTED";
      this.replay = null;
      this.lastFrame = this.lastTimestamp = null;
      this.route = null;
      this.navigationAvailable = false;
      this.population = this.nearbyActors = null;
      this.environment = null;
      this.safetySystem = null;
    }
    retry() {
      if (this.closed || this.retryTimer) return;
      this.retryTimer = this.schedule(() => {
        this.retryTimer = null;
        this.connect();
      }, this.retryMs);
      this.retryMs = Math.min(15e3, this.retryMs * 2);
    }
    get fresh() {
      return (this.connected || this.isReplay) && this.now() - this.receivedAt < 750;
    }
    getVehicleState() {
      return this.fresh ? this.telemetry : unavailableState();
    }
    async getSensorFrame(name) {
      const response = await this.fetcher(`/api/simulation/sensor?name=${encodeURIComponent(name)}`, { cache: "no-store" });
      const frame = await response.json();
      if (!response.ok) throw new Error(frame.error);
      return frame;
    }
    send(type, payload = {}) {
      if (this.closed || this.isReplay || this.socket?.readyState !== 1) return false;
      if (this.restarting) return false;
      if (type !== "reconnect" && (!this.connected || !this.fresh || !this.controller && !["start_driving", "start_journey", "take_control"].includes(type))) return false;
      if (type === "controls" && ["PAUSED", "EMERGENCY_STOP", "DISCONNECTED"].includes(this.controlMode)) return false;
      if (type === "controls" && this.now() - this.lastControlSentAt < 30) return false;
      const sequence = ++this.sequence;
      this.pending.set(sequence, this.now());
      if (this.pending.size > 40) this.pending.delete(this.pending.keys().next().value);
      this.socket.send(JSON.stringify({ type, sequence, frame_id: this.telemetry.frame, timestamp_s: this.telemetry.timestamp, ...payload }));
      if (type === "controls") this.lastControlSentAt = this.now();
      return true;
    }
    startDriving() {
      this.operationError = null;
      return this.send("start_driving");
    }
    startJourney(speed_kmh) {
      this.operationError = null;
      return this.send("start_journey", { speed_kmh });
    }
    journeyHeartbeat() {
      return this.send("journey_heartbeat", { session_id: this.sessionId });
    }
    journeySpeed(speed_kmh) {
      this.operationError = null;
      return this.send("journey_speed", { speed_kmh });
    }
    stopDriving(reason = "operator_stop") {
      return this.send("stop_driving", { reason });
    }
    takeControl() {
      return this.send("take_control");
    }
    reconnectNative() {
      this.operationError = null;
      return this.send("reconnect");
    }
    dashboardAction(type, value) {
      this.operationError = null;
      return this.send(type, { value });
    }
    async catalog() {
      const response = await this.fetcher("/api/simulation/catalog", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    }
    updateControls({ throttle = 0, brake = 0, steering = 0, parkingbrake = 0 } = {}) {
      const controls2 = { throttle, brake, steering, parkingbrake };
      if (this.gearCommand != null) controls2.gear = this.gearCommand;
      if (this.send("controls", { controls: controls2 })) {
        this.gearCommand = null;
        return true;
      }
      return false;
    }
    setGear(gear) {
      this.gearCommand = gear;
    }
    resetVehicle() {
      this.releaseControls();
      this.send("reset");
      this.gearCommand = 1;
    }
    setPaused(paused) {
      this.releaseControls();
      this.send("pause", { paused });
    }
    releaseControls() {
      this.cancel(this.releaseTimer);
      if (!this.send("controls", { controls: { throttle: 0, brake: 1, steering: 0, parkingbrake: 0 } }) && this.connected && this.controller && !this.isReplay) {
        this.releaseTimer = this.schedule(() => {
          this.releaseTimer = null;
          this.send("controls", { controls: { throttle: 0, brake: 1, steering: 0, parkingbrake: 0 } });
        }, 35);
      }
    }
    emergencyStop() {
      return this.send("emergency_stop");
    }
    acknowledgeStop() {
      return this.send("acknowledge_stop");
    }
    async setReplayPaused(paused) {
      if (!this.isReplay) return false;
      const response = await this.fetcher("/api/simulation/replay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused }) });
      if (!response.ok) throw new Error("Replay playback request failed");
      return true;
    }
    close() {
      this.releaseControls();
      this.closed = true;
      this.cancel(this.retryTimer);
      this.retryTimer = null;
      this.cancel(this.connectTimer);
      this.connectTimer = null;
      this.cancel(this.releaseTimer);
      this.releaseTimer = null;
      this.socket?.close();
      this.disconnect("Disconnected");
    }
  };

  // frontend/controls.js
  var DrivingControls = class {
    constructor() {
      this.clear();
    }
    clear() {
      this.keys = /* @__PURE__ */ new Set();
      this.reverseSince = null;
      this.mode = "D";
      this.gear = 1;
    }
    setMode(mode) {
      this.mode = mode;
      this.reverseSince = null;
    }
    sample(speedMps, nowMs) {
      const w = this.keys.has("KeyW"), s = this.keys.has("KeyS");
      const result = {
        throttle: 0,
        brake: 0,
        steering: Number(this.keys.has("KeyA")) - Number(this.keys.has("KeyD")),
        parkingbrake: this.keys.has("Space") ? 1 : 0,
        gear: this.gear
      };
      if (!Number.isFinite(speedMps)) return { ...result, brake: 1, steering: 0 };
      if (this.keys.has("Space") || w && s) {
        this.reverseSince = null;
        return { ...result, brake: 1 };
      }
      if (this.mode === "N") {
        this.gear = result.gear = 0;
        result.brake = Number(s);
        return result;
      }
      if (w) {
        this.reverseSince = null;
        const oppositeMotion = this.mode === "R" ? speedMps > 0.35 : speedMps < -0.35;
        const pedal = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? 1 : 0.55;
        result.brake = Number(oppositeMotion);
        result.throttle = oppositeMotion ? 0 : pedal;
        if (!oppositeMotion) this.gear = result.gear = this.mode === "R" ? -1 : 1;
      } else if (s) {
        if (this.mode === "R") {
          result.brake = 1;
          return result;
        }
        if (speedMps > 0.35) {
          this.reverseSince = null;
          result.brake = 1;
        } else {
          this.reverseSince ??= nowMs;
          if (speedMps < -0.35 || nowMs - this.reverseSince >= 300) {
            this.gear = result.gear = -1;
            result.throttle = 1;
          } else result.brake = 1;
        }
      } else this.reverseSince = null;
      return result;
    }
  };

  // frontend/telemetry.js
  var n = (value, scale = 1) => Number.isFinite(value) ? (value * scale).toFixed(2) : "unavailable";
  var vec = (value) => value?.map((v) => n(v)).join(" / ") || "unavailable";
  function telemetryText(t, { latencyMs, sensorRates = {}, sensorErrors = {}, world = {}, mode = "DISCONNECTED" } = {}) {
    return [
      `MODE: ${mode.replaceAll("_", " ")} \xB7 ${mode === "REPLAY" ? "RECORDED OBSERVATIONS" : "LIVE OBSERVATIONS ONLY"}`,
      "VEHICLE",
      `Speed magnitude ${n(t.speedMagnitudeMps, 3.6)} km/h \xB7 Signed longitudinal speed ${n(t.speedMps)} m/s`,
      `Longitudinal acceleration ${n(t.accelerationMps2)} m/s\xB2`,
      `Steering input ${n(t.steeringInput)} (positive right; normalized input, not wheel angle)`,
      `Throttle ${n(t.throttle, 100)}% \xB7 Brake ${n(t.brake, 100)}%`,
      `Gear ${t.gear ?? "unavailable"} \xB7 Reverse ${t.reverse ?? "unavailable"} \xB7 Handbrake ${t.handbrake ?? "unavailable"}`,
      `Position ${vec(t.positionWorldM)} m \xB7 Velocity ${vec(t.velocityWorldMps)} m/s`,
      `Angular velocity ${vec(t.angularVelocityWorldRadps)} rad/s`,
      "PHYSICS \xB7 LIMITATIONS",
      "RPM / wheel dynamics: native 0.9.16 API; mapping and validation pending",
      "Fuel / mechanical engine damage / suspension compression: unavailable",
      "Collision: native event frame/time, other actor and impulse; no component damage inferred",
      "SENSORS \xB7 NATIVE DATA ONLY",
      ...Object.entries({ frontCamera: "RGB", depth: "Depth", radar: "Radar", lidar: "LiDAR", imu: "IMU", gnss: "GNSS", collision: "Collision" }).map(([key, label]) => `${label}: ${n(sensorRates[key])} Hz${sensorErrors[key] ? ` \xB7 ERROR ${sensorErrors[key]}` : ""}`),
      "SIMULATION",
      `CARLA ${world.version ?? "unavailable"} \xB7 API ${world.pythonApiVersion ?? "unavailable"}`,
      `Map ${world.map ?? "unavailable"} \xB7 Frame ${t.frame ?? "unavailable"} \xB7 Time ${n(t.timestamp)} s`,
      `Fixed step ${n(world.fixedDeltaSeconds)} s \xB7 Synchronous ${world.synchronous ?? "unavailable"}`,
      `Backend round trip ${n(latencyMs)} ms`,
      "Sensor frames keep their native IDs/timestamps; unmatched frames are not fused."
    ].join("\n");
  }

  // frontend/sensor-frame.js
  function sensorFrameKey(metadata) {
    if (!metadata?.frameAvailable || !Number.isInteger(metadata.frame) || metadata.frame < 0 || !Number.isFinite(metadata.timestamp) || metadata.timestamp < 0) return null;
    return JSON.stringify([metadata.frame, metadata.timestamp, metadata.asset?.path ?? null]);
  }
  function matchesSensorResponse(metadata, headers) {
    if (sensorFrameKey(metadata) === null) return false;
    const frame = headers.get("X-Sensor-Frame"), timestamp = headers.get("X-Sensor-Time");
    if (frame === null || timestamp === null || frame.trim() === "" || timestamp.trim() === "") return false;
    return Number(frame) === metadata.frame && Number.isInteger(Number(frame)) && Number.isFinite(Number(timestamp)) && Math.abs(Number(timestamp) - metadata.timestamp) <= 1e-6;
  }

  // frontend/dashboard-tools.js
  var $ = (id) => document.getElementById(id);
  var weatherFields = {
    cloudiness: "settingCloud",
    precipitation: "settingRain",
    wetness: "settingWet",
    fog_density: "settingFog",
    sun_altitude_angle: "settingSun",
    sun_azimuth_angle: "settingSunAzimuth"
  };
  var svgNamespace = "http://www.w3.org/2000/svg";
  var DashboardTools = class {
    constructor(provider2, controls2, clearControls2, options = {}) {
      Object.assign(this, { provider: provider2, controls: controls2, clearControls: clearControls2, options });
      this.catalog = null;
      this.session = null;
      this.loading = false;
      this.retryAt = 0;
      this.selectedPlace = null;
      this.result = null;
      this.panel = null;
      this.panelTrigger = null;
      this.restartAfterSave = null;
      this.restartSeen = null;
      this.recordingPath = "";
      const populationAction = (operation) => {
        clearControls2();
        provider2.dashboardAction("population", operation);
      };
      $("clearTrafficBtn").onclick = () => populationAction("clear_traffic");
      $("clearPedestriansBtn").onclick = () => populationAction("clear_pedestrians");
      $("resetPopulationBtn").onclick = () => populationAction("reset");
      $("respawnPopulationBtn").onclick = () => populationAction("respawn");
      const scenario = (operation) => {
        clearControls2();
        provider2.dashboardAction("scenario", { operation });
      };
      $("loadScenarioBtn").onclick = () => {
        clearControls2();
        provider2.dashboardAction("scenario", {
          operation: "load",
          scenario_type: $("scenarioType").value,
          seed: Number($("scenarioSeed").value),
          split: $("scenarioSplit").value,
          difficulty: Number($("scenarioDifficulty").value)
        });
      };
      $("resetScenarioBtn").onclick = () => scenario("reset");
      $("startScenarioBtn").onclick = () => scenario("start");
      $("stopScenarioBtn").onclick = () => scenario("stop");
      $("livingCityBtn").onclick = () => {
        clearControls2();
        provider2.dashboardAction("environment", "LIVING_CITY");
      };
      $("scenarioSplit").onchange = () => {
        $("scenarioSeed").value = { TRAIN: 42, VALIDATION: 1042, TEST: 2042 }[$("scenarioSplit").value];
      };
      $("settingWorldProfile").onchange = () => {
        const profile = this.catalog?.urban_world_profiles?.[$("settingWorldProfile").value];
        if (profile) {
          $("settingTrafficCount").value = profile.vehicle_count;
          $("settingPedestrianCount").value = profile.pedestrian_count;
        }
      };
      $("recordRunBtn").onclick = () => {
        clearControls2();
        provider2.dashboardAction("recording", { enabled: !provider2.recording });
      };
      $("applyRadiusBtn").onclick = () => provider2.dashboardAction("inspector", Number($("nearbyRadius").value));
      $("clearRouteBtn").onclick = () => provider2.dashboardAction("clear_route", null);
      $("worldResetBtn").onclick = () => {
        clearControls2();
        provider2.dashboardAction("world_reset", null);
      };
      $("applySceneBtn").onclick = () => {
        if (this.catalog?.scenes?.[$("settingScene").value]) {
          clearControls2();
          provider2.dashboardAction("scene", $("settingScene").value);
        }
      };
      $("applyProfileBtn").onclick = () => {
        const profile = this.catalog?.profiles?.[$("settingProfile").value];
        if (profile) {
          clearControls2();
          provider2.dashboardAction("settings", { population: profile.population });
        }
      };
      for (const id of Object.values(weatherFields)) $(id).oninput = () => {
        $("settingWeather").value = "CUSTOM";
      };
      $("settingWeather").onchange = () => {
        const values = this.catalog?.settings.weather_preset_values?.[$("settingWeather").value];
        if (values) for (const [key, id] of Object.entries(weatherFields)) $(id).value = values[key];
      };
      $("phoneToggleBtn").onclick = () => this.toggle("inGamePhone", "phoneToggleBtn");
      $("mapDestinationsBtn").onclick = () => this.open("inGamePhone", "mapDestinationsBtn");
      $("settingsBtn").onclick = () => {
        this.toggle("settingsPanel", "settingsBtn");
        this.load(true);
      };
      $("connectionSetupBtn").onclick = () => {
        this.open("settingsPanel", "connectionSetupBtn");
        $("connectionSettings").open = true;
        $("connectionSettings").scrollIntoView({ block: "start", behavior: this.scrollBehavior() });
        $("connectionSettings").querySelector("summary").focus({ preventScroll: true });
        this.load(true);
      };
      $("sensorBtn").onclick = () => this.toggle("sensorPanel", "sensorBtn");
      $("routeBtn").onclick = () => this.toggle("routePanel", "routeBtn");
      $("miniMapToggle").onclick = () => this.toggle("routePanel", "miniMapToggle");
      $("routeMap").onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.open("inGamePhone", "routeMap");
        }
      };
      for (const [panel, button] of [["inGamePhone", "closePhoneBtn"], ["settingsPanel", "closeSettingsBtn"], ["sensorPanel", "closeSensorBtn"], ["routePanel", "closeMapBtn"]])
        $(button).onclick = () => this.close();
      $("panelBackdrop").onclick = () => this.close();
      document.addEventListener("keydown", (event) => {
        if (event.code === "Escape") {
          if (this.panel) this.close();
          else if ($("cameraCard").classList.contains("camera-expanded")) this.expandCamera(false);
        }
        if (event.key === "Tab" && this.panel) {
          const elements = [...$(this.panel).querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter((el) => el.getClientRects().length && !el.closest("[inert]"));
          if (!elements.length) return;
          const first = elements[0], last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      });
      $("reconnectBtn").onclick = () => provider2.connect();
      $("nativeReconnectBtn").onclick = () => {
        clearControls2();
        provider2.reconnectNative();
        provider2.connect();
      };
      $("nativeDisconnectBtn").onclick = () => {
        clearControls2();
        provider2.dashboardAction("disconnect");
      };
      $("takeControlBtn").onclick = () => {
        clearControls2();
        provider2.takeControl();
      };
      $("expandCameraBtn").onclick = () => this.expandCamera(!$("cameraCard").classList.contains("camera-expanded"));
      $("cameraView").onchange = () => {
        clearControls2();
        provider2.dashboardAction("settings", { camera_view: $("cameraView").value });
      };
      $("settingsForm").onsubmit = (event) => {
        event.preventDefault();
        this.apply();
      };
      $("cleanImageBtn").onclick = () => {
        $("settingResolution").value = "800x450";
        $("settingPostprocess").checked = false;
        $("settingMotionBlur").value = 0;
        $("settingBloom").value = 0;
        $("settingsStatus").textContent = "Clear image settings ready. Select Apply changes to activate.";
      };
      $("restartGraphicsBtn").onclick = () => {
        const launch = { quality: $("settingQuality").value, resolution: $("settingWindow").value };
        this.restartAfterSave = launch;
        clearControls2();
        if (!provider2.dashboardAction("settings", { next_launch: launch })) {
          this.restartAfterSave = null;
          $("restartStatus").textContent = "Take control in connection settings first.";
        } else $("restartStatus").textContent = "Save settings then restart simulator\u2026";
      };
      $("destinationSearch").oninput = () => {
        this.selectedPlace = null;
        this.renderPlaces();
      };
      $("chooseDestinationBtn").onclick = () => {
        const text = $("destinationSearch").value.trim();
        const place = this.selectedPlace || this.catalog?.places.find((p) => p.name === text || p.id === text);
        if (!place) {
          $("destinationStatus").textContent = "Choose a destination from the search results first.";
          return;
        }
        this.choose(place.id);
      };
      $("savePlaceBtn").onclick = () => {
        const name = $("savePlaceName").value.trim() || "Saved place " + (/* @__PURE__ */ new Date()).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
        clearControls2();
        provider2.dashboardAction("save_place", name);
      };
      $("routeMap").onclick = (event) => {
        if (!this.project || !this.inverse) return;
        const point = $("routeMap").createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const matrix = $("routeMap").getScreenCTM();
        if (!matrix) return;
        const nativePoint = point.matrixTransform(matrix.inverse());
        this.choose({ location: this.inverse([nativePoint.x, nativePoint.y]) });
      };
    }
    scrollBehavior() {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    }
    expandCamera(enlarged) {
      $("cameraCard").classList.toggle("camera-expanded", enlarged);
      $("expandCameraBtn").textContent = enlarged ? "Shrink image" : "Expand image";
      $("expandCameraBtn").setAttribute("aria-expanded", String(enlarged));
      if (!enlarged) $("expandCameraBtn").focus({ preventScroll: true });
    }
    open(panel, trigger) {
      if (this.panel === panel) return;
      this.close(false);
      if (this.provider.controlMode === "MANUAL") this.clearControls();
      this.panel = panel;
      this.panelTrigger = trigger;
      $(panel).hidden = false;
      $("panelBackdrop").hidden = false;
      document.body.classList.add("panel-open");
      for (const element of document.querySelectorAll(".app-header,.workspace,.app-footer,.skip-link")) element.inert = true;
      $(trigger)?.setAttribute("aria-expanded", "true");
      $(panel).querySelector("button")?.focus();
      if (panel === "inGamePhone") this.load();
    }
    close(returnFocus = true) {
      if (!this.panel) return;
      $(this.panel).hidden = true;
      $("panelBackdrop").hidden = true;
      document.body.classList.remove("panel-open");
      for (const element of document.querySelectorAll(".app-header,.workspace,.app-footer,.skip-link")) element.inert = false;
      $(this.panelTrigger)?.setAttribute("aria-expanded", "false");
      if (returnFocus) $(this.panelTrigger)?.focus();
      this.panel = null;
    }
    toggle(panel, trigger) {
      if (this.panel === panel) this.close();
      else this.open(panel, trigger);
    }
    choose(value) {
      this.clearControls();
      const accepted = this.provider.dashboardAction("destination", value);
      $("destinationStatus").textContent = $("mapSelectionStatus").textContent = accepted ? "Planning from the current vehicle position\u2026" : "Take control in connection settings before selecting a destination.";
      if (accepted) this.close();
    }
    async load(force = false) {
      if (this.loading || !this.provider.fresh || this.provider.isReplay || !force && (this.catalog || performance.now() < this.retryAt)) return;
      this.loading = true;
      const session = this.provider.sessionId;
      try {
        const catalog = await this.provider.catalog();
        if (session !== this.provider.sessionId || !this.provider.fresh) return;
        this.catalog = catalog;
        this.fillSettings();
        this.renderPlaces();
        this.renderRoads();
      } catch (error) {
        this.retryAt = performance.now() + 2e3;
        $("settingsStatus").textContent = error.message;
      } finally {
        this.loading = false;
      }
    }
    renderPlaces() {
      const list = $("placeResults");
      list.replaceChildren();
      const query = $("destinationSearch").value.trim().toLocaleLowerCase();
      const places = this.catalog?.places.filter((p) => p.name.toLocaleLowerCase().includes(query) || String(p.road_id).includes(query)) ?? [];
      const groups = /* @__PURE__ */ new Map();
      for (const place of places) {
        const name = place.favorite ? "Favorites \u2605" : place.id.startsWith("saved-") ? "Your saved places" : place.sector ? place.sector + " \xB7 Road " + place.road_id : "Available places";
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(place);
      }
      for (const [name, entries] of [...groups].sort(([a], [b]) => Number(b === "Favorites \u2605") - Number(a === "Favorites \u2605"))) {
        const title = document.createElement("div");
        title.className = "place-group";
        title.textContent = name;
        list.append(title);
        for (const place of entries) {
          const button = document.createElement("button");
          button.className = "place-option";
          button.type = "button";
          button.textContent = place.name;
          button.dataset.placeId = place.id;
          button.classList.toggle("selected", this.selectedPlace?.id === place.id);
          button.onclick = () => {
            this.selectedPlace = place;
            $("destinationSearch").value = place.name;
            this.renderPlaces();
            $("chooseDestinationBtn").focus();
          };
          button.setAttribute("aria-pressed", String(this.selectedPlace?.id === place.id));
          const row = document.createElement("div");
          row.className = "place-row";
          row.setAttribute("role", "listitem");
          const star = document.createElement("button");
          star.type = "button";
          star.className = "place-favorite";
          star.textContent = place.favorite ? "\u2605" : "\u2606";
          star.setAttribute("aria-label", (place.favorite ? "Remove from favorites: " : "Add to favorites: ") + place.name);
          star.disabled = !this.provider.fresh || !this.provider.controller || this.provider.isReplay;
          star.title = star.disabled ? "Take control in connection settings first" : "Favorites persist after reconnection";
          star.onclick = () => this.provider.dashboardAction("favorite_place", place.id);
          row.append(button, star);
          list.append(row);
        }
      }
      if (!places.length) list.textContent = this.catalog ? "No results. Try an area name or select from the map." : "Waiting for map CARLA\u2026";
    }
    fillSettings() {
      const s = this.catalog.settings;
      for (const [id, entries] of [
        ["settingVehicle", s.vehicle_options.map((p) => [p.id, p.name])],
        ["settingSpawn", s.spawn_options.map((p) => [p.index, p.name])],
        ["settingWeather", [["CUSTOM", "Custom"], ...s.weather_presets.map((name) => [name, { ClearNoon: "Clear \u2014 Noon", CloudyNoon: "Cloudy \u2014 Noon", WetNoon: "Wet ground", WetCloudyNoon: "Wet and cloudy", MidRainyNoon: "Moderate rain", HardRainNoon: "Heavy rain", SoftRainNoon: "Light rain", ClearSunset: "Clear sunset", CloudySunset: "Cloudy sunset", WetSunset: "Wet sunset", HardRainSunset: "Heavy rain sunset" }[name] || name])]],
        ["settingProfile", Object.entries(this.catalog.profiles || {}).map(([name, p]) => [name, name + " \xB7 " + p.population.vehicle_count + " / " + p.population.pedestrian_count])]
      ]) {
        const select = $(id), previous = select.value;
        select.replaceChildren();
        for (const [value, text] of entries) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = text;
          select.append(option);
        }
        if (id === "settingProfile" && entries.some(([value]) => value === previous)) select.value = previous;
      }
      const fields = {
        settingVehicle: s.vehicle,
        settingSpawn: s.spawn_index,
        settingResolution: s.camera_resolution,
        settingFov: s.camera_fov,
        settingHz: s.simulation_hz,
        settingQuality: s.next_launch.quality,
        settingWindow: s.next_launch.resolution,
        settingTrafficCount: s.population_saved.vehicle_count,
        settingPedestrianCount: s.population_saved.pedestrian_count,
        settingTrafficSpeed: s.population_saved.speed_behavior,
        settingFastWalk: s.population_saved.fast_walk_percent,
        settingSeed: s.population_saved.seed,
        settingDriverBehavior: s.population_saved.driver_behavior ?? "NORMAL",
        settingCompliance: s.population_saved.light_compliance_percent ?? 90,
        settingCrossing: s.population_saved.crossing_percent ?? 5,
        settingWorldProfile: s.population_saved.world_profile ?? "TRAINING_DEVELOPMENT",
        settingWeather: s.weather_preset,
        cameraView: s.camera_view,
        settingMotionBlur: s.camera_motion_blur,
        settingBloom: s.camera_bloom
      };
      for (const [id, value] of Object.entries(fields)) $(id).value = value ?? 0;
      $("settingPostprocess").checked = s.camera_postprocess === true;
      for (const [key, id] of Object.entries(weatherFields)) $(id).value = s.weather[key];
      const applied = s.active_launch;
      $("activeGraphics").textContent = applied ? "Applied: " + (applied.quality || "unknown") + " \xB7 " + (applied.resolution || "unknown resolution") + (applied.offscreen ? " \xB7 displayed in dashboard" : "") : "Applied graphics settings are unavailable.";
      $("effectsNote").textContent = s.camera_effects?.note || "";
      $("weatherApplied").textContent = "Applied weather: " + s.weather_preset;
      if (!Object.keys(this.catalog.profiles || {}).length) {
        const option = document.createElement("option");
        option.textContent = "Waiting for performance measurements";
        $("settingProfile").append(option);
      }
    }
    apply() {
      if (!this.catalog) return;
      const number2 = (id) => Number($(id).value), current = this.catalog.settings;
      const data = {
        weather: Object.fromEntries(Object.entries(weatherFields).map(([key, id]) => [key, number2(id)])),
        next_launch: { quality: $("settingQuality").value, resolution: $("settingWindow").value },
        population: {
          vehicle_count: number2("settingTrafficCount"),
          pedestrian_count: number2("settingPedestrianCount"),
          speed_behavior: $("settingTrafficSpeed").value,
          fast_walk_percent: number2("settingFastWalk"),
          seed: number2("settingSeed"),
          driver_behavior: $("settingDriverBehavior").value,
          light_compliance_percent: number2("settingCompliance"),
          crossing_percent: number2("settingCrossing"),
          world_profile: $("settingWorldProfile").value
        }
      };
      if ($("settingWeather").value !== "CUSTOM") {
        delete data.weather;
        data.weather_preset = $("settingWeather").value;
      }
      const candidates = {
        vehicle: $("settingVehicle").value,
        spawn_index: number2("settingSpawn"),
        camera_view: $("cameraView").value,
        camera_resolution: $("settingResolution").value,
        camera_fov: number2("settingFov"),
        simulation_hz: number2("settingHz"),
        camera_postprocess: $("settingPostprocess").checked,
        camera_motion_blur: number2("settingMotionBlur"),
        camera_bloom: number2("settingBloom")
      };
      for (const [key, value] of Object.entries(candidates)) if (value !== current[key]) data[key] = value;
      this.clearControls();
      $("settingsStatus").textContent = this.provider.dashboardAction("settings", data) ? "Applying live settings\u2026" : "Take control in connection settings first.";
    }
    disable(id, reason) {
      const button = $(id);
      button.disabled = !!reason;
      button.title = reason || "";
    }
    render(state, controllable) {
      const p = this.provider;
      if (this.session !== p.sessionId) {
        this.session = p.sessionId;
        this.catalog = null;
        this.selectedPlace = null;
        this.result = null;
        this.project = this.inverse = null;
        $("roadGeometry").replaceChildren();
        $("routeLine").setAttribute("d", "");
        $("miniRoadGeometry").replaceChildren();
        $("miniRouteLine").setAttribute("d", "");
        $("miniRouteCar").setAttribute("hidden", "");
        $("miniRouteTarget").setAttribute("hidden", "");
        $("mapEmpty").hidden = false;
        $("routeCar").setAttribute("hidden", "");
        $("routeTarget").setAttribute("hidden", "");
      }
      const blocked = p.isReplay ? "Replay is read-only; driving is disabled" : p.restarting ? "Restarting CARLA" : !p.fresh ? "Waiting for native connection to CARLA" : "";
      const ownerBlocked = blocked || (!p.controller ? "Take control in connection settings" : "");
      for (const star of document.querySelectorAll(".place-favorite")) {
        star.disabled = !!ownerBlocked;
        star.title = ownerBlocked || "Favorites persist after reconnection";
      }
      const emergency = p.controlMode === "EMERGENCY_STOP" ? "Acknowledge the emergency stop first" : "";
      this.disable("startDrivingBtn", blocked || emergency);
      const journeyBusy = ["STARTING", "RUNNING"].includes(p.journey?.status);
      const destinationPending = p.dashboardResult?.action === "destination" && p.dashboardResult.status === "PENDING";
      const journeyBlocked = blocked || emergency || (!p.navigationAvailable ? "Journeys are unavailable in this mode" : "") || (destinationPending ? "Planning route\u2026" : "") || (!p.route ? "Choose a valid destination and show its route first" : "") || (journeyBusy ? "Journey running; stop it before starting again" : "") || (p.route?.arrived && state.speedMagnitudeMps < 0.15 ? "Vehicle is already at the destination; choose another" : "");
      for (const id of ["startJourneyBtn", "phoneJourneyBtn", "driveJourneyBtn"]) this.disable(id, journeyBlocked);
      this.disable("journeySpeed", ownerBlocked || emergency);
      $("journeySpeedApplied").textContent = journeyBusy ? "Current target speed: " + p.journey.speed_kmh + " km/h; the lower road limit takes priority." : "5\u201330 km/h. You can change it during the journey.";
      const resume = p.route && p.journey?.route_id === p.route.id && ["PAUSED", "ERROR"].includes(p.journey?.status);
      for (const id of ["startJourneyBtn", "driveJourneyBtn"]) $(id).textContent = resume ? "Resume journey to destination" : "Go to destination";
      $("phoneJourneyBtn").textContent = resume ? "Resume journey to current destination" : "Go to current destination";
      $("journeyAvailability").textContent = $("phoneJourneyAvailability").textContent = $("driveJourneyAvailability").textContent = journeyBlocked || "Destination: " + p.route.destination.name + (resume ? " \u2014 saved; resume from your current position." : " \u2014 Select Go to start the destination journey.");
      this.disable("pauseBtn", ownerBlocked || emergency);
      this.disable("emergencyStopBtn", ownerBlocked);
      this.disable("acknowledgeStopBtn", ownerBlocked);
      $("acknowledgeStopBtn").hidden = !emergency;
      for (const id of ["cameraView", "chooseDestinationBtn", "savePlaceBtn", "nativeDisconnectBtn", "resetBtn"])
        this.disable(id, ownerBlocked);
      const configurationBlocked = ownerBlocked || (p.recording ? "Finish recording before changing sensor settings" : "");
      this.disable("applySettingsBtn", configurationBlocked);
      this.disable("worldResetBtn", configurationBlocked);
      this.disable("restartGraphicsBtn", configurationBlocked || (state.speedMagnitudeMps > 0.15 ? "Stop the vehicle first" : ""));
      this.disable("nativeReconnectBtn", p.isReplay ? "Replay not connected to simulator" : p.restarting ? "Restarting" : "");
      this.disable("takeControlBtn", blocked);
      this.disable("drivingMode", blocked || emergency);
      this.disable("clearRouteBtn", ownerBlocked || (!p.route ? "No active route" : ""));
      $("modeExplanation").textContent = p.isReplay ? "Recorded data and camera; native driving disabled." : "Go drives the vehicle to the destination. Enable manual driving prepares the keyboard for driving.";
      $("manualHint").textContent = p.isReplay ? "Keyboard sends no driving commands during Replay." : "Keyboard operates in the dashboard. W/A/S/D Take manual control; destination persists until the route is cleared.";
      $("drivingInstruction").textContent = blocked || emergency || (!p.controller ? "Another page controls the vehicle. Take control in settings." : p.controlMode === "AUTOMATIC" ? "Journey running. Stop driving brakes; manual input transfers control to you." : controllable ? "Keyboard ready. W+Shift increases throttle from 55% to 100%." : "Vehicle held by command safety. Enable manual driving to move.");
      const reasons = {
        manual_intervention: "Manual control taken",
        dashboard_heartbeat_timeout: "Dashboard heartbeat lost",
        destination_reached: "Destination reached and vehicle stopped",
        collision: "Journey stopped after collision",
        controls_released: "Control stopped",
        operator_stop: "Driving stopped",
        focus_lost: "Dashboard lost focus",
        route_ended_before_destination: "Route ended far from destination; select the route again",
        page_closed: "Driving page closed",
        ownership_taken: "Control transferred to this page",
        fresh_native_session: "New session; explicitly choose driving to begin"
      };
      const statuses = {
        IDLE: "",
        READY: "Route ready",
        STARTING: "Starting journey",
        RUNNING: "Destination journey running",
        PAUSED: "Journey paused",
        ARRIVED: "Arrived",
        ERROR: "Journey could not complete"
      };
      $("journeyStatus").textContent = p.route ? p.isReplay ? "Recorded route; driving disabled" : (statuses[p.journey?.status] || "Route ready") + (p.journey?.reason ? " \xB7 " + (reasons[p.journey.reason] || p.journey.reason) : "") : "";
      const population = p.population;
      $("trafficActual").textContent = population?.actual.vehicles ?? "\u2014";
      $("pedestrianActual").textContent = population?.actual.pedestrians ?? "\u2014";
      const health = p.isReplay ? "Recorded frame counts; no connection to Traffic Manager" : population ? "TM " + (population.traffic_manager_connected ? "connected" : "disconnected") + " \xB7 active walkers " + population.actual.walkers_active + " \xB7 requested " + population.requested.vehicle_count + " / " + population.requested.pedestrian_count + " \xB7 last spawn NPC " + population.npc_spawned + " \xB7 failed NPC " + population.npc_failed + " / walkers " + population.walkers_failed + " \xB7 native removals " + population.vehicles_removed_native + " vehicle / " + population.walkers_lost + " walkers" : "Waiting for population data";
      $("populationHealth").textContent = $("populationApplied").textContent = health;
      const environment = p.environment, training = environment?.mode === "TRAINING";
      $("environmentStatus").textContent = environment ? environment.mode + " \xB7 " + environment.scenario_phase + (environment.scenario ? " \xB7 " + environment.scenario.scenario_id + " \xB7 seed " + environment.scenario.random_seed + " \xB7 level " + environment.scenario.difficulty : "") : "Environment unavailable";
      $("safetyPolicyStatus").textContent = p.safetySystem ? "YA RAB OSTORHA \xB7 " + p.safetySystem.controller + " \xB7 " + p.safetySystem.status + " \xB7 generator " + p.safetySystem.actual_generator + " \xB7 model " + p.safetySystem.model_health + " \xB7 control " + (p.controlSource ?? "unavailable") : "Safety sensors unavailable";
      $("policyObservationStatus").textContent = environment?.observation_status ? "Observation " + environment.observation_status.status + " \xB7 history " + environment.observation_status.history_frames + " \xB7 ground truth excluded" : "Waiting for synchronized policy observations";
      $("scenarioOutcome").textContent = environment?.outcome ? JSON.stringify(environment.outcome, null, 2) : "No outcome yet";
      const scenarioBlocked = ownerBlocked || (p.recording ? "Finish recording before changing scenario lifecycle" : "");
      this.disable("loadScenarioBtn", scenarioBlocked);
      this.disable("resetScenarioBtn", scenarioBlocked || (!training ? "Load a scenario first" : ""));
      this.disable("startScenarioBtn", ownerBlocked || (environment?.scenario_phase !== "READY" ? "Reset or load a ready scenario" : ""));
      this.disable("stopScenarioBtn", ownerBlocked || (environment?.scenario_phase !== "RUNNING" ? "No running scenario" : ""));
      this.disable("livingCityBtn", scenarioBlocked || (!training ? "Living city is already selected" : ""));
      const local = population?.local_counts;
      if (local) $("populationHealth").textContent += " \xB7 within 120 m: " + local.vehicles_120m + " vehicles / " + local.walkers_120m + " walkers";
      $("recordRunBtn").textContent = p.recording ? "Stop recording" : "Start recording";
      $("recordRunBtn").dataset.recording = String(!!p.recording);
      $("recordingStatus").textContent = (p.recording ? "Recording camera and sensor data." : "Recording stopped.") + (this.recordingPath ? " " + this.recordingPath : "");
      for (const id of ["recordRunBtn", "clearTrafficBtn", "clearPedestriansBtn", "resetPopulationBtn", "respawnPopulationBtn", "applyRadiusBtn", "applySceneBtn"]) this.disable(id, ownerBlocked);
      this.disable("applyProfileBtn", ownerBlocked || (!Object.keys(this.catalog?.profiles || {}).length ? "Performance measurements are incomplete" : ""));
      if (training) for (const id of ["clearTrafficBtn", "clearPedestriansBtn", "resetPopulationBtn", "respawnPopulationBtn", "applySceneBtn", "applySettingsBtn", "applyProfileBtn"])
        this.disable(id, ownerBlocked || "Return to Living city before changing world settings");
      if (this.panel === "sensorPanel") {
        const native = p.nearbyActors;
        $("trafficLightState").textContent = native?.traffic_light?.relevant ? "Actor " + native.traffic_light.actor_id + " \xB7 " + native.traffic_light.state + " \xB7 " + Math.round(native.traffic_light.distance_to_actor_origin_m) + " m to actor origin" : "Vehicle is not at a traffic light according to CARLA";
        $("nearbyActors").textContent = native ? "Frame " + native.frame_id + " \xB7 Radius " + native.radius_m + " m\n" + native.actors.map((a) => a.category + " #" + a.actor_id + " " + a.type + "\n" + a.distance_m.toFixed(1) + " m \xB7 relative " + a.relative_position_m.map((v) => v.toFixed(1)).join("/") + " \xB7 velocity " + a.velocity_mps.map((v) => v.toFixed(1)).join("/")).join("\n\n") : "No live data";
      }
      if (p.operationError) {
        $("operationStatus").textContent = p.operationError;
        this.errorShown = true;
      } else if (this.errorShown) {
        $("operationStatus").textContent = "";
        this.errorShown = false;
      }
      if (p.dashboardResult && JSON.stringify(p.dashboardResult) !== this.result) {
        const result = p.dashboardResult;
        this.result = JSON.stringify(result);
        if (result.status === "REJECTED") {
          $("operationStatus").textContent = $("settingsStatus").textContent = $("destinationStatus").textContent = result.error;
          if (result.action === "destination") $("mapSelectionStatus").textContent = result.error;
          this.restartAfterSave = null;
        }
        if (result.status === "APPLIED") {
          if (result.action === "settings") {
            $("settingsStatus").textContent = "Live changes applied. Graphics saved for restart.";
            if (this.restartAfterSave) {
              p.dashboardAction("restart_graphics", this.restartAfterSave);
              this.restartAfterSave = null;
            }
            this.load(true);
          }
          if (result.action === "save_place") {
            $("destinationStatus").textContent = "Place saved: " + result.result.name;
            this.load(true);
          }
          if (result.action === "favorite_place") {
            $("destinationStatus").textContent = result.result.favorite ? "Destination added to favorites." : "Destination removed from favorites.";
            this.load(true);
          }
          if (result.action === "destination") $("destinationStatus").textContent = $("mapSelectionStatus").textContent = "Route ready to " + result.result.destination.name + "; select Go or drive manually.";
          if (result.action === "recording") this.recordingPath = result.result.path;
          if (result.action === "population") {
            $("settingsStatus").textContent = "Population updated; actual counts appear in Living city.";
            this.load(true);
          }
          if (result.action === "scene") {
            $("settingsStatus").textContent = "Seeded normal scene and weather applied.";
            this.load(true);
          }
          if (result.action === "world_reset") $("settingsStatus").textContent = "Map created by restarting CARLA and verifying; vehicle stopped and population removed.";
        }
      }
      const restart = p.restartResult;
      if (restart && JSON.stringify(restart) !== this.restartSeen) {
        this.restartSeen = JSON.stringify(restart);
        const names = {
          STOPPING: "Vehicle and sensor cleanup",
          LAUNCHING: "Start CARLA",
          ROLLING_BACK: "Restore previous graphics settings",
          VERIFYING: "Inspect images, sensors and performance",
          APPLIED: "Graphics applied and verified",
          ROLLED_BACK: "Requested settings failed; previous settings restored",
          FAILED: "Failed to start CARLA"
        };
        $("restartStatus").textContent = (names[restart.status] || restart.status) + (restart.error ? " \xB7 " + restart.error : "");
        if (["APPLIED", "ROLLED_BACK"].includes(restart.status)) this.load(true);
      }
      this.load();
      $("originPosition").textContent = state.positionWorldM?.map((v) => v.toFixed(1)).join(" / ") || "Waiting for vehicle position";
      this.renderRoute(p.route, state.positionWorldM);
    }
    renderRoads() {
      const roads = this.catalog?.roads;
      if (!roads) return;
      const [minX, minY, maxX, maxY] = roads.bounds;
      const scale = Math.min(750 / Math.max(1, maxX - minX), 280 / Math.max(1, maxY - minY));
      const offsetX = (800 - (maxX - minX) * scale) / 2, offsetY = (330 - (maxY - minY) * scale) / 2;
      $("routeMap").setAttribute("viewBox", [offsetX - 15, offsetY - 15, (maxX - minX) * scale + 30, (maxY - minY) * scale + 30].join(" "));
      this.project = (p) => [offsetX + (p[0] - minX) * scale, offsetY + (p[1] - minY) * scale];
      this.inverse = (p) => [(p[0] - offsetX) / scale + minX, (p[1] - offsetY) / scale + minY, 0];
      const path = document.createElementNS(svgNamespace, "path");
      path.setAttribute("d", roads.segments.map((line) => "M" + this.project(line[0]).join(",") + "L" + this.project(line[1]).join(",")).join(" "));
      $("roadGeometry").replaceChildren(path);
      $("miniRoadGeometry").replaceChildren(path.cloneNode(true));
      this.mapScale = scale;
      $("mapEmpty").hidden = roads.segments.length > 0;
    }
    renderRoute(route, car) {
      if (!this.project) return;
      const carVisible = this.provider.fresh && !!car;
      $("routeCar").toggleAttribute("hidden", !carVisible);
      if (carVisible) {
        const [x2, y2] = this.project(car);
        $("routeCar").setAttribute("cx", x2);
        $("routeCar").setAttribute("cy", y2);
      }
      $("miniRouteCar").toggleAttribute("hidden", !carVisible);
      $("miniRouteTarget").toggleAttribute("hidden", !route);
      if (carVisible) {
        const [x2, y2] = this.project(car), span = 100 * this.mapScale;
        $("miniRouteCar").setAttribute("cx", x2);
        $("miniRouteCar").setAttribute("cy", y2);
        $("miniRouteMap").setAttribute("viewBox", [x2 - span / 2, y2 - span / 2, span, span].join(" "));
      }
      $("miniRouteHint").textContent = route ? Math.round(route.remaining_m) + " m \xB7 Map" : "Map";
      $("miniRouteLine").setAttribute("d", route ? route.points.map((point, i) => (i ? "L" : "M") + this.project(point).join(",")).join(" ") : "");
      if (route) {
        const [x2, y2] = this.project(route.destination.location);
        $("miniRouteTarget").setAttribute("cx", x2);
        $("miniRouteTarget").setAttribute("cy", y2);
      }
      $("routeTarget").toggleAttribute("hidden", !route);
      if (!route) {
        $("routeLine").setAttribute("d", "");
        $("routeDetail").textContent = "Click a road on the map or choose a destination from the list.";
        $("turnInstruction").textContent = "";
        return;
      }
      $("routeLine").setAttribute("d", route.points.map((point, i) => (i ? "L" : "M") + this.project(point).join(",")).join(" "));
      const [x, y] = this.project(route.destination.location);
      $("routeTarget").setAttribute("cx", x);
      $("routeTarget").setAttribute("cy", y);
      $("routeDetail").textContent = route.destination.name + " \xB7 " + Math.round(route.remaining_m) + " m remaining";
      const names = { LEFT: "North", RIGHT: "Right", STRAIGHT: "Straight", CHANGELANELEFT: "Change lane left", CHANGELANERIGHT: "Change lane right" };
      $("turnInstruction").textContent = route.next_instruction ? "Next direction: " + (names[route.next_instruction.action] || route.next_instruction.action) : "Follow the route to the destination.";
    }
  };

  // frontend/input-policy.js
  var DRIVING_KEYS = /* @__PURE__ */ new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"]);
  function isEditableTarget(target) {
    return !!target && (/INPUT|SELECT|TEXTAREA/.test(target.tagName) || target.isContentEditable);
  }
  function drivingInputAllowed({ fresh, replay, owner, focused, modal, mode, armed }) {
    return fresh && !replay && owner && focused && !modal && (mode === "AUTOMATIC" || mode === "MANUAL" && armed);
  }

  // frontend/perception-view.js
  var $2 = (id) => document.getElementById(id);
  var PerceptionView = class {
    constructor(provider2) {
      this.provider = provider2;
      this.busy = false;
      this.token = null;
      this.url = null;
      this.nextAt = 0;
    }
    metadata(result) {
      $2("perceptionStatus").textContent = "YOLOv8n + OCR \xB7 " + result.device + " \xB7 " + Math.round(result.inference_ms) + " ms";
      $2("perceptionFrame").textContent = "Frame " + result.frame_id + " \xB7 t " + result.timestamp_s.toFixed(3) + " \xB7 " + result.detections.length + " objects \xB7 older by " + Math.max(0, this.provider.telemetry.frame - result.frame_id) + " frame";
    }
    clear(reason) {
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = this.token = null;
      $2("perceptionCamera").hidden = true;
      $2("perceptionCamera").removeAttribute("src");
      $2("perceptionEmpty").hidden = false;
      $2("perceptionEmpty").textContent = reason;
      $2("ocrTexts").replaceChildren();
      $2("perceptionFrame").textContent = "";
    }
    async update() {
      const p = this.provider;
      if (!p.fresh || p.isReplay) {
        $2("perceptionStatus").textContent = p.isReplay ? "REPLAY \xB7 Live inference stopped" : "Inference stopped";
        this.clear(p.isReplay ? "Live inference stopped during Replay." : "Waiting for connection CARLA.");
        return;
      }
      if (this.busy || performance.now() < this.nextAt) return;
      this.busy = true;
      this.nextAt = performance.now() + 500;
      const session = p.sessionId;
      try {
        const response = await fetch("/api/simulation/perception", { cache: "no-store", signal: AbortSignal.timeout(3e3) });
        if (!response.ok) throw new Error("Could not read inference worker");
        const result = await response.json();
        if (result.status !== "RUNNING") {
          const labels = { LOADING: "Loading YOLO and OCR\u2026", WAITING: "Waiting for a frame from this session", UNAVAILABLE: "Inference not installed", STALE: "Inference frame is stale", ERROR: "Inference failed", DISCONNECTED: "Inference stopped" };
          $2("perceptionStatus").textContent = labels[result.status] || result.status;
          this.clear(result.error || "Waiting for a native analyzed frame");
          return;
        }
        if (result.session_id !== session || !p.fresh || p.isReplay) return;
        if (result.image_token === this.token) {
          this.metadata(result);
          return;
        }
        const image = await fetch("/api/simulation/perception.jpg?token=" + encodeURIComponent(result.image_token), { cache: "no-store", signal: AbortSignal.timeout(3e3) });
        if (!image.ok || image.headers.get("X-Perception-Token") !== result.image_token) return;
        const blob = await image.blob();
        if (p.sessionId !== session || !p.fresh || p.isReplay) return;
        const nextUrl = URL.createObjectURL(blob);
        try {
          const decoded = new Image();
          decoded.src = nextUrl;
          await decoded.decode();
        } catch (error) {
          URL.revokeObjectURL(nextUrl);
          throw error;
        }
        if (p.sessionId !== session || !p.fresh || p.isReplay) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        const previousUrl = this.url;
        this.url = nextUrl;
        this.token = result.image_token;
        $2("perceptionCamera").src = this.url;
        $2("perceptionCamera").hidden = false;
        $2("perceptionEmpty").hidden = true;
        this.metadata(result);
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        const rows = result.texts.map((item) => {
          const row = document.createElement("p");
          row.textContent = item.text + " (" + Math.round(item.confidence * 100) + "%)";
          return row;
        });
        if (!rows.length) {
          const empty = document.createElement("p");
          empty.textContent = "No text recognized with sufficient confidence in this frame.";
          rows.push(empty);
        }
        $2("ocrTexts").replaceChildren(...rows);
      } catch (error) {
        $2("perceptionStatus").textContent = "Inference unavailable";
        this.clear(error.message);
      } finally {
        this.busy = false;
      }
    }
  };

  // frontend/dashboard.js
  var $3 = (id) => document.getElementById(id);
  var provider = new SimulationClient();
  var controls = new DrivingControls();
  var perception = new PerceptionView(provider);
  var number = (value, suffix = "", digits = 1) => Number.isFinite(value) ? value.toFixed(digits) + suffix : "\u2014";
  var manualArmed = false;
  var manualRequestedUntil = 0;
  var manualOverridePending = false;
  var lastMode = null;
  var lastGear = null;
  var seenSession = null;
  var cameraReceipt = null;
  var cameraUrl = null;
  var cameraRequest = null;
  var cameraGeneration = 0;
  var tools = new DashboardTools(provider, controls, clearControls, { canInput, intervene });
  function canInput() {
    return drivingInputAllowed({
      fresh: provider.fresh,
      replay: provider.isReplay,
      owner: provider.controller,
      focused: document.hasFocus() && !document.hidden,
      modal: !!tools.panel,
      mode: provider.controlMode,
      armed: manualArmed
    });
  }
  function resetKeys() {
    controls.clear();
    controls.setMode($3("gearSelect").value);
    controls.gear = controls.mode === "R" ? -1 : controls.mode === "N" ? 0 : 1;
    lastGear = null;
    manualOverridePending = false;
  }
  function clearControls(reason = "operator_stop") {
    resetKeys();
    manualArmed = false;
    manualRequestedUntil = 0;
    provider.stopDriving(reason);
  }
  function sendManual(state) {
    const command = controls.sample(state.speedMps, performance.now());
    if (command.gear !== lastGear) {
      provider.setGear(command.gear);
      lastGear = command.gear;
    }
    if (provider.updateControls(command)) manualOverridePending = false;
  }
  function intervene() {
    if (provider.controlMode !== "AUTOMATIC") return;
    manualArmed = true;
    manualOverridePending = true;
    $3("drivingMode").value = "MANUAL";
    $3("gearSelect").value = "D";
    controls.setMode("D");
    lastGear = null;
    sendManual(provider.getVehicleState());
  }
  function clearCamera() {
    cameraGeneration++;
    cameraRequest?.abort();
    cameraRequest = null;
    if (cameraUrl) URL.revokeObjectURL(cameraUrl);
    cameraUrl = cameraReceipt = null;
    $3("authoritativeCamera").hidden = true;
    $3("authoritativeCamera").removeAttribute("src");
    $3("cameraUnavailable").hidden = false;
    $3("cameraActivity").textContent = "Image unavailable";
    $3("cameraTimestamp").textContent = "t \u2014";
  }
  async function updateCamera(metadata) {
    const key = sensorFrameKey(metadata);
    if (key === null || !provider.fresh || provider.sensorErrors.frontCamera) {
      clearCamera();
      return;
    }
    if (cameraRequest || key === cameraReceipt) return;
    const generation = cameraGeneration, request = new AbortController();
    cameraRequest = request;
    try {
      const response = await fetch("/api/simulation/camera.jpg?frame_id=" + metadata.frame, { cache: "no-store", signal: request.signal });
      if (!response.ok || !matchesSensorResponse(metadata, response.headers)) return;
      const blob = await response.blob();
      if (!provider.fresh || generation !== cameraGeneration) return;
      if (cameraUrl) URL.revokeObjectURL(cameraUrl);
      cameraUrl = URL.createObjectURL(blob);
      cameraReceipt = key;
      $3("authoritativeCamera").src = cameraUrl;
      $3("authoritativeCamera").hidden = false;
      $3("cameraUnavailable").hidden = true;
      $3("cameraActivity").textContent = provider.isReplay ? "REPLAY \xB7 Recorded image" : "RGB \xB7 Live image";
      $3("cameraTimestamp").textContent = "t " + number(Number(response.headers.get("X-Sensor-Time")), " s", 3);
      $3("cameraMetadata").textContent = "Frame " + response.headers.get("X-Sensor-Frame") + " \xB7 " + metadata.width + "\xD7" + metadata.height + " \xB7 FOV " + metadata.fovDeg + "\xB0 \xB7 mount " + JSON.stringify(metadata.mountTransform ?? null);
    } catch (error) {
      if (error.name !== "AbortError") clearCamera();
    } finally {
      if (cameraRequest === request) cameraRequest = null;
    }
  }
  function refresh() {
    if ((provider.connected || provider.isReplay) && !provider.fresh) {
      manualArmed = false;
      provider.disconnect("Data stream lost; driving stopped");
    }
    if (provider.sessionId !== seenSession) {
      seenSession = provider.sessionId;
      manualArmed = false;
      resetKeys();
      clearCamera();
    }
    const state = provider.getVehicleState(), live = provider.fresh;
    $3("cameraEmptyTitle").textContent = live ? "Waiting for camera image" : "Waiting for simulator connection";
    $3("cameraEmptyDescription").textContent = live ? "No image available yet. Inspect sensor status in Details." : "Connect CARLA to view camera and telemetry, then enable driving.";
    $3("connectionSetupBtn").hidden = live || provider.isReplay;
    if (!live) $3("mapEmpty").hidden = false;
    if (!live || provider.isReplay || !document.hasFocus() || document.hidden || performance.now() > manualRequestedUntil && (!provider.controller || provider.controlMode === "PAUSED" && lastMode === "MANUAL" || provider.controlMode === "EMERGENCY_STOP")) manualArmed = false;
    lastMode = provider.controlMode;
    const controllable = canInput();
    const connectedLabel = provider.isReplay ? "REPLAY \u2014 real recording" : provider.restarting ? "CARLA \u2014 RESTARTING" : "CARLA \u2014 " + (live && provider.connected ? "CONNECTED" : "DISCONNECTED");
    $3("cityStatus").textContent = $3("simulationState").textContent = connectedLabel;
    $3("connectionDot").classList.toggle("connected", live && provider.connected);
    $3("missionText").textContent = provider.isReplay ? "Replay \xB7 Driving disabled" : provider.population ? provider.population.actual.vehicles + " traffic vehicle \xB7 " + provider.population.actual.pedestrians + " walkers" : "Waiting for population CARLA";
    const modeNames = {
      MANUAL: manualArmed ? "Manual driving" : "Vehicle held by command safety",
      AUTOMATIC: "Destination journey",
      PAUSED: state.speedKmh > 0.54 ? "Stopping vehicle" : "Vehicle stopped",
      EMERGENCY_STOP: "Emergency stop",
      DISCONNECTED: "Simulator disconnected",
      REPLAY: "Replay"
    };
    $3("controlMode").textContent = modeNames[provider.controlMode] || provider.controlMode;
    $3("controlSource").textContent = provider.controlSource || "";
    const safety = provider.safetySystem;
    $3("safetyStatus").textContent = provider.isReplay ? "YA RAB OSTORHA \xB7 Replay, no active control" : !live ? "YA RAB OSTORHA \xB7 Waiting for sensors" : "YA RAB OSTORHA \xB7 " + (safety?.controller ?? "RULE") + " SAFETY \xB7 " + (safety?.status ?? "UNAVAILABLE") + " \xB7 Risk: " + (safety?.risk ?? "UNKNOWN") + " \xB7 " + (safety?.active ? "Intervention active" : "Monitoring / standby") + " \xB7 Generator: " + (safety?.actual_generator ?? "RULE") + " \xB7 Model: " + (safety?.model_health ?? "UNAVAILABLE") + " \xB7 Interventions: " + (safety?.intervention_count ?? 0) + " \xB7 " + (safety?.reason ?? "") + (safety?.model_validation ? " \xB7 " + safety.model_validation : "");
    $3("safetyEnabled").checked = safety?.enabled === true;
    $3("safetyEnabled").disabled = !live || provider.isReplay || !provider.controller || provider.controlMode === "TRAINING" || !Number.isFinite(state.speedMps) || Math.abs(state.speedMps) > 0.15;
    $3("safetyController").disabled = $3("safetyEnabled").disabled;
    $3("safetyController").value = safety?.controller ?? "RULE";
    for (const option of $3("safetyController").options) option.disabled = !(safety?.available_controllers ?? ["RULE"]).includes(option.value);
    $3("connectionDetail").textContent = provider.isReplay ? "Recorded data view; no simulator controls." : live ? provider.controller ? "Take control from this page." : "Another page controls the vehicle; take control in Settings." : provider.restarting ? "Restarting CARLA and reconnecting\u2026" : "Simulator disconnected. Open connection setup to continue.";
    $3("phoneStatus").textContent = live ? "Destinations from map " + (provider.world.map?.split("/").at(-1) || "CARLA") : "Waiting for simulator connection.";
    $3("providerStatus").textContent = provider.status;
    $3("providerTitle").textContent = provider.isReplay ? "Recorded camera" : "Camera CARLA";
    $3("cameraSource").textContent = provider.isReplay ? "RECORDED RGB" : "CARLA RGB";
    $3("speedVal").textContent = number(state.speedKmh, "", 0);
    $3("gearVal").textContent = state.gear ?? "\u2014";
    $3("throttleVal").textContent = number(state.throttle == null ? null : state.throttle * 100, "%");
    $3("brakeVal").textContent = number(state.brake == null ? null : state.brake * 100, "%");
    $3("steerVal").textContent = number(state.steeringInput);
    $3("versionVal").textContent = provider.world.version ?? "\u2014";
    $3("mapVal").textContent = provider.world.map?.split("/").at(-1) ?? "\u2014";
    $3("frameVal").textContent = state.frame ?? "\u2014";
    $3("timeVal").textContent = number(state.timestamp, " s", 3);
    $3("accelVal").textContent = number(state.accelerationMps2, " m/s\xB2");
    $3("reverseVal").textContent = state.reverse == null ? "\u2014" : state.reverse ? "Yes" : "No";
    $3("positionVal").textContent = state.positionWorldM ? "X / Y / Z: " + state.positionWorldM.map((v) => number(v)).join(" / ") + " m" : "Position unavailable";
    $3("headingVal").textContent = state.rotationDeg ? "Yaw " + number(state.rotationDeg.yaw, "\xB0") : "";
    $3("gearSelect").disabled = !controllable || provider.controlMode === "AUTOMATIC";
    $3("gearSelect").title = !$3("gearSelect").disabled ? "" : provider.isReplay ? "Replay is read-only; driving is disabled" : !live ? "Waiting for native connection to CARLA" : provider.controlMode === "AUTOMATIC" ? "Journey controller selects the gear; take manual control to change it" : !provider.controller ? "Take control in connection settings first" : "Enable manual driving to change gear";
    $3("controlStatus").textContent = provider.isReplay ? "REPLAY \xB7 Driving disabled" : !document.hasFocus() || document.hidden ? "Focus the dashboard to use the keyboard" : controllable ? "WASD ready \xB7 W+Shift More throttle" : "Keyboard stopped \u2014 Enable driving first";
    const sensorCount = Object.keys(provider.sensorMetadata).length;
    $3("sensorStatus").textContent = provider.isReplay ? sensorCount + " sensors from recorded frame \xB7 recorded collision events" : live ? sensorCount + " periodic sensors receiving data \xB7 Collision sensor is event-driven" : "Sensors unavailable";
    $3("cameraFps").textContent = number(provider.performance?.sensorWallRatesHz?.frontCamera) + " /wall seconds \xB7 " + number(provider.sensorRates.frontCamera) + " Hz sim";
    const perf = provider.performance || {}, gpu = perf.gpu;
    $3("performance").textContent = "actual steps: " + number(perf.nativeTickRateHz) + " /s \xB7 Simulation time: " + (provider.world.fixedDeltaSeconds ? number(1 / provider.world.fixedDeltaSeconds) + " Hz" : "\u2014") + (gpu ? " \xB7 VRAM " + gpu.usedMiB + " / " + gpu.totalMiB + " MiB" : "") + " \xB7 FPS Rendering unavailable";
    $3("debugTelemetry").textContent = telemetryText(state, {
      remote: true,
      latencyMs: provider.latencyMs,
      sensorRates: provider.sensorRates,
      sensorErrors: provider.sensorErrors,
      world: provider.world,
      mode: provider.controlMode
    });
    $3("replayPauseBtn").hidden = !provider.isReplay;
    $3("replayPauseBtn").textContent = provider.replay?.paused ? "Resume replay" : "Pause replay";
    if (controllable && (provider.controlMode === "MANUAL" || provider.controlMode === "AUTOMATIC" && (manualOverridePending || controls.keys.size > 0))) sendManual(state);
    if (live && provider.controller && !provider.isReplay && document.hasFocus() && !document.hidden && ["STARTING", "RUNNING"].includes(provider.journey?.status) && !manualOverridePending) provider.journeyHeartbeat();
    updateCamera(provider.sensorMetadata.frontCamera);
    tools.render(state, controllable);
    perception.update();
  }
  $3("startDrivingBtn").onclick = () => {
    resetKeys();
    manualArmed = true;
    manualRequestedUntil = performance.now() + 1e3;
    $3("drivingMode").value = "MANUAL";
    provider.startDriving();
    document.activeElement?.blur();
    $3("drivingInstruction").textContent = "Enable manual driving\u2026";
  };
  function startJourney() {
    const speed = Number($3("journeySpeed").value);
    if (!Number.isFinite(speed) || speed < 5 || speed > 30) {
      $3("operationStatus").textContent = "Choose a speed between 5 and 30 km/h.";
      return;
    }
    tools.close(false);
    resetKeys();
    manualArmed = false;
    manualRequestedUntil = 0;
    $3("drivingMode").value = "AUTOMATIC";
    if (provider.startJourney(speed)) $3("journeyStatus").textContent = "Starting destination journey\u2026";
    document.activeElement?.blur();
  }
  $3("startJourneyBtn").onclick = $3("phoneJourneyBtn").onclick = $3("driveJourneyBtn").onclick = startJourney;
  $3("journeySpeed").onchange = () => {
    const speed = Number($3("journeySpeed").value);
    if (!Number.isFinite(speed) || speed < 5 || speed > 30) {
      $3("operationStatus").textContent = "Choose a speed between 5 and 30 km/h.";
      return;
    }
    if (provider.controlMode === "AUTOMATIC") provider.journeySpeed(speed);
  };
  $3("drivingMode").onchange = () => {
    clearControls();
  };
  $3("safetyEnabled").onchange = () => provider.dashboardAction("safety_mode", { enabled: $3("safetyEnabled").checked });
  $3("safetyController").onchange = () => provider.dashboardAction("safety_mode", { enabled: $3("safetyEnabled").checked, controller: $3("safetyController").value });
  $3("gearSelect").onchange = () => {
    controls.setMode($3("gearSelect").value);
    provider.releaseControls();
    lastGear = null;
  };
  $3("pauseBtn").onclick = () => clearControls();
  $3("resetBtn").onclick = () => {
    clearControls();
    provider.resetVehicle();
  };
  $3("emergencyStopBtn").onclick = () => {
    clearControls();
    provider.emergencyStop();
  };
  $3("acknowledgeStopBtn").onclick = () => {
    clearControls();
    provider.acknowledgeStop();
  };
  $3("replayPauseBtn").onclick = () => provider.setReplayPaused(!provider.replay?.paused).catch((e) => {
    $3("operationStatus").textContent = e.message;
  });
  document.addEventListener("keydown", (event) => {
    if (isEditableTarget(event.target)) return;
    if (DRIVING_KEYS.has(event.code)) {
      event.preventDefault();
      if (provider.controlMode === "AUTOMATIC" && event.code.startsWith("Shift")) return;
      if (!event.repeat && canInput()) {
        controls.keys.add(event.code);
        intervene();
      }
    }
    if (!event.repeat && event.code === "KeyP") tools.toggle("inGamePhone", "phoneToggleBtn");
  });
  document.addEventListener("keyup", (event) => controls.keys.delete(event.code));
  window.addEventListener("blur", () => clearControls("focus_lost"));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearControls("focus_lost");
  });
  window.addEventListener("pagehide", () => {
    clearControls("page_closed");
    clearCamera();
    provider.close();
  });
  provider.connect();
  refresh();
  setInterval(refresh, 50);
})();
