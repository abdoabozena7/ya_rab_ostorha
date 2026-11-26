import * as THREE from "three";
import { createCameraReadback } from "./camera-readback.js";

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
  function sendFrame(viewport, preEncodedJpegBase64 = null) {
    if (!enabled || framePending) return;
    framePending = true;
    if (typeof preEncodedJpegBase64 === "string" && preEncodedJpegBase64.length > 0 && preEncodedJpegBase64.length < 520000) {
      Promise.resolve().then(async () => {
        try {
          const bin = atob(preEncodedJpegBase64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const response = await fetch("/api/frame", {
            method: "POST", headers: { "Content-Type": "image/jpeg" }, body: bytes,
          });
          if (response.ok) lastFrameId = (await response.json()).frameId;
          else enabled = false;
        } catch {
          enabled = false;
        } finally { framePending = false; }
      });
      return;
    }
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
  const maxResultAgeMs = 750, idlePollMs = 80, activePollMs = 32;
  const jpegPrefix = "data:image/jpeg;base64,";
  const target = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: true, stencilBuffer: false,
  });
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const pixels = new Uint8Array(width * height * 4);
  const readback = createCameraReadback(renderer, pixels);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const image = context.createImageData(width, height);
  const position = new THREE.Vector3(), direction = new THREE.Vector3();
  let streamId = crypto.randomUUID(), frameId = 0, lastSampleS = -Infinity;
  let enabled = false, previewEnabled = false, disposed = false, pending = null, generation = 0;
  let streamRequests = new AbortController();
  let lifecycle = 0, latestFrame = null;
  const frames = new Map();
  const results = new Map();
  let restartRequired = false;
  let timer = null, polling = false, lastResultId = -1, lastAcknowledged = null;
  const timings = [];
  let status = { available: false, status: "disabled", source: "camera-pixels", error: null, result: null };
  const notify = (next) => {
    if (next.status === "error") restartRequired = true;
    if (next.status === "ready" && next.result) restartRequired = false;
    status = { ...status, ...next };
    onStatus?.(status);
  };
  async function request(url, options, streamSignal) {
    const timeout = AbortSignal.timeout(10000);
    const signal = streamSignal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([streamSignal, timeout]) : timeout;
    const response = await fetch(url, { ...options, signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `Vision HTTP ${response.status}`);
    return data;
  }
  function schedulePoll(delay) {
    if (!enabled || disposed || polling) return;
    clearTimeout(timer);
    timer = setTimeout(poll, delay);
  }
  async function poll() {
    timer = null;
    if (!enabled || disposed || polling) return;
    polling = true;
    const currentGeneration = generation, requestedStream = streamId;
    try {
      const { result, ...data } = await request(
        `/api/vision/state?streamId=${encodeURIComponent(requestedStream)}`,
        { cache: "no-store" }, streamRequests.signal);
      if (currentGeneration !== generation || disposed) return;
      if (data.available !== true || data.status !== "ready" ||
          (data.source && data.source !== "camera-pixels") ||
          result?.streamId !== requestedStream || !Number.isSafeInteger(result.frameId) || result.frameId < 0) {
        notify({ ...data, result: null });
        return;
      }
      if (result.frameId < lastResultId) return;
      const timing = timings.find((item) => item.streamId === requestedStream && item.frameId === result.frameId);
      const observedAfterMs = timing ? performance.now() - timing.startedMs : null;
      if (timing && (result.simulationTimeS !== timing.simulationTimeS || observedAfterMs >= maxResultAgeMs)) {
        notify({ ...data, available: false, status: "stale", error: "Camera result did not match a fresh capture.", result: null });
        return;
      }
      const newer = result.frameId > lastResultId;
      if (newer) {
        lastResultId = result.frameId;
        results.set(lastResultId, result);
        if (results.size > 12) results.delete(results.keys().next().value);
        if (timing) timing.observedAfterMs = observedAfterMs;
      }
      notify({ ...data, result: results.get(lastResultId) });
      if (newer && currentGeneration === generation && !disposed) onResult?.(result);
    } catch (error) {
      if (currentGeneration === generation && !disposed)
        notify({ available: false, status: "error", error: error.message, result: null });
    } finally {
      if (currentGeneration === generation && !disposed) {
        polling = false;
        // Check sooner while an admitted frame could still produce a fresh result.
        const awaiting = lastAcknowledged?.frameId > lastResultId &&
          performance.now() - lastAcknowledged.startedMs < maxResultAgeMs;
        schedulePoll(awaiting ? activePollMs : idlePollMs);
      }
    }
  }
  function cancelCapture() {
    pending = null;
    readback.reset();
  }
  function reset() {
    if (disposed) return streamId;
    generation++;
    clearTimeout(timer);
    polling = false;
    streamRequests.abort();
    streamRequests = new AbortController();
    cancelCapture();
    frames.clear();
    results.clear();
    latestFrame = null;
    streamId = crypto.randomUUID();
    frameId = 0;
    lastResultId = -1;
    lastAcknowledged = null;
    lastSampleS = -Infinity;
    notify({ available: false, result: null, status: enabled ? "loading" : "disabled", error: null });
    schedulePoll(0);
    return streamId;
  }
  async function start() {
    const superseded = { ok: false, error: "Camera startup was superseded by a newer action." };
    if (disposed) return superseded;
    const operation = ++lifecycle;
    notify({ available: false, status: "loading", error: null });
    try {
      if (restartRequired) await request("/api/vision/stop", { method: "POST" });
      if (operation !== lifecycle || disposed) return superseded;
      const result = await request("/api/vision/start", { method: "POST" });
      if (operation !== lifecycle || disposed) return superseded;
      if (!result.available) throw new Error(result.error ?? "Local camera perception is unavailable.");
      enabled = true;
      restartRequired = false;
      reset();
      notify({ ...result, result: null });
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
    const superseded = { ok: false, error: "Camera stop was superseded by a newer action." };
    if (disposed) return superseded;
    const operation = ++lifecycle;
    enabled = false;
    restartRequired = false;
    reset();
    try {
      await request("/api/vision/stop", { method: "POST" });
      if (operation !== lifecycle || disposed) return superseded;
      return { ok: true };
    } catch (error) {
      if (operation === lifecycle && !disposed)
        notify({ available: false, status: "error", error: error.message, result: null });
      return { ok: false, error: error.message };
    }
  }
  const isCurrent = (job) => pending === job && !disposed && job.generation === generation;

  function failCapture(job, stage, error) {
    if (!isCurrent(job)) return;
    pending = null;
    notify({ available: false, status: "error", error: `Camera ${stage} failed: ${error.message}`, result: null });
  }

  function publishJpeg(job, encoded) {
    if (!isCurrent(job)) return;
    const { frame, timing } = job;
    if (typeof encoded !== "string" || !encoded.startsWith(jpegPrefix) || encoded.length === jpegPrefix.length)
      throw new Error("The front camera did not encode a JPEG.");
    frame.imageJpegBase64 = encoded.slice(jpegPrefix.length);
    timing.encodedAfterMs = performance.now() - timing.startedMs;
    Object.freeze(frame.camera.position);
    Object.freeze(frame.camera);
    Object.freeze(frame.ego);
    Object.freeze(frame);
    frames.set(frame.frameId, frame);
    if (frames.size > 12) frames.delete(frames.keys().next().value);
    latestFrame = frame;
    onFrame?.(frame);
    if (!isCurrent(job)) return;
    if (!enabled) {
      pending = null;
      return;
    }
    timing.postedAfterMs = performance.now() - timing.startedMs;
    request("/api/vision/frame", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(frame),
    }, streamRequests.signal).then(() => {
      if (!isCurrent(job)) return;
      timing.acknowledgedAfterMs = performance.now() - timing.startedMs;
      lastAcknowledged = timing;
      schedulePoll(0);
    }).catch((error) => {
      if (isCurrent(job)) notify({ available: false, status: "error", error: error.message, result: null });
    }).finally(() => {
      if (isCurrent(job)) pending = null;
    });
  }

  function convertPixels(job) {
    if (!isCurrent(job)) return;
    try {
      const stride = width * 4;
      for (let row = 0; row < height; row++)
        image.data.set(pixels.subarray((height - row - 1) * stride, (height - row) * stride), row * stride);
      context.putImageData(image, 0, 0);
      const encodeStartedMs = performance.now();
      job.timing.renderReadbackMs = encodeStartedMs - job.timing.startedMs;
      // Encode in the fence callback: Chrome's toBlob tasks starved this capture slot under load.
      const encoded = canvas.toDataURL("image/jpeg", 0.86);
      job.timing.encodeMs = performance.now() - encodeStartedMs;
      publishJpeg(job, encoded);
    } catch (error) { failCapture(job, "encoding", error); }
  }

  function capture(scene, camera, ego, simulationTimeS) {
    if ((!enabled && !previewEnabled) || disposed || pending || simulationTimeS - lastSampleS < 0.1 - 1e-9) return;
    lastSampleS = simulationTimeS;
    const currentFrame = ++frameId;
    const timing = { streamId, frameId: currentFrame, simulationTimeS,
      startedMs: performance.now(), readbackMode: readback.asynchronous ? "pbo" : "sync" };
    // Sample the supplied front camera and ego at admission, never when the fence or JPEG completes.
    camera.getWorldPosition(position);
    camera.getWorldDirection(direction);
    const frame = {
      schema: 1, streamId, frameId: currentFrame, simulationTimeS,
      camera: { width, height, fovYDeg: camera.fov,
        position: { x: position.x, y: position.y, z: position.z },
        headingRad: Math.atan2(direction.x, direction.z), groundY: 0.12 },
      ego: { x: ego.x, z: ego.z, headingRad: ego.heading,
        speedMps: ego.speed, lengthM: ego.length, widthM: ego.width },
    };
    const job = pending = { frame, timing, generation };
    timings.push(timing);
    if (timings.length > 120) timings.shift();
    const oldTarget = renderer.getRenderTarget();
    const oldFace = renderer.getActiveCubeFace?.() ?? 0;
    const oldLevel = renderer.getActiveMipmapLevel?.() ?? 0;
    let deferred;
    try {
      // The target has its own 640x360 viewport/scissor; setViewport would apply the display DPR.
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      deferred = readback.begin(target, () => convertPixels(job), (error) => failCapture(job, "capture", error));
      timing.renderSubmitMs = performance.now() - timing.startedMs;
    } catch (error) {
      failCapture(job, "capture", error);
      return;
    } finally {
      renderer.setRenderTarget(oldTarget, oldFace, oldLevel);
    }
    if (!deferred) convertPixels(job);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    enabled = false;
    lifecycle++;
    generation++;
    clearTimeout(timer);
    streamRequests.abort();
    pending = null;
    readback.dispose();
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
      if (!value && !enabled) cancelCapture();
    },
    getFrame(resultStream, resultFrame) {
      return resultStream === streamId ? frames.get(resultFrame) ?? null : null;
    },
    getResult(resultStream, resultFrame) {
      return resultStream === streamId ? results.get(resultFrame) ?? null : null;
    },
    get latestFrame() { return latestFrame; },
    get previewTexture() { return target.texture; },
    get streamId() { return streamId; },
    get status() { return status; },
    get enabled() { return enabled; },
    get restartRequired() { return restartRequired; },
    get timings() { return timings.map((item) => ({ ...item })); },
  };
}
