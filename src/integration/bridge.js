import * as THREE from "three";

export function createBridge({ renderer, readState }) {
  let enabled = false, lastFrameId = 0, framePending = false;
  const capture = document.createElement("canvas");
  capture.width = 480;
  capture.height = 270;
  const context = capture.getContext("2d");
  async function checkHealth() {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      enabled = response.ok && (await response.json()).ok === true;
    } catch { enabled = false; }
  }
  async function report() {
    if (!enabled) return;
    try {
      const response = await fetch("/api/state", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(readState()),
      });
      if (!response.ok) enabled = false;
    } catch { enabled = false; }
  }
  function sendFrame(viewport) {
    if (!enabled || framePending) return;
    framePending = true;
    const bounds = renderer.domElement.getBoundingClientRect();
    const ratio = renderer.domElement.width / bounds.width;
    const sourceTop = bounds.height - viewport.y - viewport.height;
    context.drawImage(renderer.domElement,
      viewport.x * ratio, sourceTop * ratio,
      viewport.width * ratio, viewport.height * ratio,
      0, 0, capture.width, capture.height);
    capture.toBlob(async (blob) => {
      try {
        if (!blob) return;
        const response = await fetch("/api/frame", {
          method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob,
        });
        if (response.ok) lastFrameId = (await response.json()).frameId;
        else enabled = false;
      } catch {
        enabled = false;
      } finally { framePending = false; }
    }, "image/jpeg", 0.55);
  }
  checkHealth();
  setInterval(checkHealth, 5000);
  setInterval(report, 500);
  return { sendFrame, get lastFrameId() { return lastFrameId; } };
}

export function createVisualClient({ renderer, onResult, onStatus, onFrame }) {
  const width = 640, height = 360;
  const target = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: true, stencilBuffer: false,
  });
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const pixels = new Uint8Array(width * height * 4);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const image = context.createImageData(width, height);
  let streamId = crypto.randomUUID(), frameId = 0, lastSampleS = -Infinity;
  let enabled = false, previewEnabled = false, disposed = false, pending = false, generation = 0;
  let lifecycle = 0, latestFrame = null;
  const frames = new Map();
  const results = new Map();
  let restartRequired = false;
  let timer = null, lastResultId = -1;
  const timings = [];
  let status = { available: false, status: "disabled", source: "camera-pixels", error: null, result: null };
  const notify = (next) => {
    if (next.status === "error") restartRequired = true;
    if (next.status === "ready" && next.result) restartRequired = false;
    status = { ...status, ...next };
    onStatus?.(status);
  };
  async function request(url, options) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `Vision HTTP ${response.status}`);
    return data;
  }
  async function poll() {
    if (!enabled || disposed) return;
    const currentGeneration = generation;
    try {
      const data = await request(`/api/vision/state?streamId=${encodeURIComponent(streamId)}`);
      if (currentGeneration !== generation || disposed) return;
      notify(data);
      if (data.result?.streamId === streamId && data.result.frameId > lastResultId) {
        lastResultId = data.result.frameId;
        results.set(lastResultId, data.result);
        if (results.size > 12) results.delete(results.keys().next().value);
        const timing = timings.find((item) => item.streamId === streamId && item.frameId === lastResultId);
        if (timing) timing.observedAfterMs = performance.now() - timing.startedMs;
        onResult(data.result);
      }
    } catch (error) {
      if (currentGeneration === generation && !disposed)
        notify({ available: false, status: "error", error: error.message, result: null });
    } finally {
      if (enabled && !disposed && currentGeneration === generation)
        timer = setTimeout(poll, 80);
    }
  }
  function reset() {
    generation++;
    clearTimeout(timer);
    frames.clear();
    results.clear();
    latestFrame = null;
    streamId = crypto.randomUUID();
    frameId = 0;
    lastResultId = -1;
    lastSampleS = -Infinity;
    pending = false;
    notify({ available: false, result: null, status: enabled ? "loading" : "disabled", error: null });
    if (enabled && !disposed) timer = setTimeout(poll, 0);
    return streamId;
  }
  async function start() {
    const operation = ++lifecycle;
    notify({ available: false, status: "loading", error: null });
    try {
      if (restartRequired) await request("/api/vision/stop", { method: "POST" });
      const result = await request("/api/vision/start", { method: "POST" });
      if (operation !== lifecycle || disposed)
        return { ok: false, error: "Camera startup was superseded by a newer action." };
      if (!result.available) throw new Error(result.error ?? "Local camera perception is unavailable.");
      enabled = true;
      restartRequired = false;
      reset();
      clearTimeout(timer);
      notify(result);
      poll();
      return { ok: true, streamId };
    } catch (error) {
      if (operation === lifecycle && !disposed) {
        enabled = false;
        notify({ available: false, status: "error", error: error.message, result: null });
      }
      return { ok: false, error: error.message };
    }
  }
  async function stop() {
    const operation = ++lifecycle;
    enabled = false;
    restartRequired = false;
    reset();
    try {
      await request("/api/vision/stop", { method: "POST" });
      if (operation !== lifecycle || disposed)
        return { ok: false, error: "Camera stop was superseded by a newer action." };
      return { ok: true };
    } catch (error) {
      if (operation === lifecycle && !disposed)
        notify({ available: false, status: "error", error: error.message, result: null });
      return { ok: false, error: error.message };
    }
  }
  function capture(scene, camera, ego, simulationTimeS) {
    if ((!enabled && !previewEnabled) || disposed || pending || simulationTimeS - lastSampleS < 0.1) return;
    lastSampleS = simulationTimeS;
    const currentGeneration = generation, capturedStream = streamId;
    const currentFrame = ++frameId;
    const timing = { streamId: capturedStream, frameId: currentFrame, simulationTimeS, startedMs: performance.now() };
    timings.push(timing);
    if (timings.length > 120) timings.shift();
    pending = true;
    const oldTarget = renderer.getRenderTarget();
    const oldViewport = renderer.getViewport(new THREE.Vector4());
    const oldScissor = renderer.getScissor(new THREE.Vector4());
    const oldScissorTest = renderer.getScissorTest();
    try {
      renderer.setRenderTarget(target);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, width, height);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      for (let row = 0; row < height; row++)
        image.data.set(pixels.subarray((height - row - 1) * width * 4,
          (height - row) * width * 4), row * width * 4);
      context.putImageData(image, 0, 0);
      timing.renderReadbackMs = performance.now() - timing.startedMs;
    } catch (error) {
      pending = false;
      notify({ available: false, status: "error", error: `Camera capture failed: ${error.message}` });
      return;
    } finally {
      renderer.setRenderTarget(oldTarget);
      renderer.setViewport(oldViewport);
      renderer.setScissor(oldScissor);
      renderer.setScissorTest(oldScissorTest);
    }
    const position = camera.getWorldPosition(new THREE.Vector3());
    const direction = camera.getWorldDirection(new THREE.Vector3());
    const frame = {
      schema: 1, streamId: capturedStream, frameId: currentFrame, simulationTimeS,
      camera: { width, height, fovYDeg: camera.fov,
        position: { x: position.x, y: position.y, z: position.z },
        headingRad: Math.atan2(direction.x, direction.z), groundY: 0.12 },
      ego: { x: ego.x, z: ego.z, headingRad: ego.heading,
        speedMps: ego.speed, lengthM: ego.length, widthM: ego.width },
    };
    try {
      const encoded = canvas.toDataURL("image/jpeg", 0.86);
      const prefix = "data:image/jpeg;base64,";
      if (!encoded.startsWith(prefix)) throw new Error("The front camera did not encode a JPEG.");
      frame.imageJpegBase64 = encoded.slice(prefix.length);
      timing.encodedAfterMs = performance.now() - timing.startedMs;
      Object.freeze(frame.camera.position);
      Object.freeze(frame.camera);
      Object.freeze(frame.ego);
      Object.freeze(frame);
      frames.set(currentFrame, frame);
      if (frames.size > 12) frames.delete(frames.keys().next().value);
      latestFrame = frame;
      onFrame?.(frame);
      if (!enabled) {
        pending = false;
        return;
      }
      timing.postedAfterMs = timing.encodedAfterMs;
      request("/api/vision/frame", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(frame),
      }).then(() => {
        timing.acknowledgedAfterMs = performance.now() - timing.startedMs;
      }).catch((error) => {
        if (generation === currentGeneration && !disposed)
          notify({ available: false, status: "error", error: error.message, result: null });
      }).finally(() => {
        if (generation === currentGeneration) pending = false;
      });
    } catch (error) {
      pending = false;
      notify({ available: false, status: "error", error: `Camera encoding failed: ${error.message}` });
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    enabled = false;
    lifecycle++;
    generation++;
    clearTimeout(timer);
    frames.clear();
    results.clear();
    latestFrame = null;
    target.dispose();
  }
  return {
    start, stop, reset, capture, dispose,
    setPreviewEnabled(value) {
      if (typeof value !== "boolean") throw new Error("Camera preview needs a boolean state.");
      previewEnabled = value;
    },
    getFrame(resultStream, resultFrame) {
      return resultStream === streamId ? frames.get(resultFrame) ?? null : null;
    },
    getResult(resultStream, resultFrame) {
      return resultStream === streamId ? results.get(resultFrame) ?? null : null;
    },
    get latestFrame() { return latestFrame; },
    get streamId() { return streamId; },
    get status() { return status; },
    get enabled() { return enabled; },
    get restartRequired() { return restartRequired; },
    get timings() { return timings.map((item) => ({ ...item })); },
  };
}
