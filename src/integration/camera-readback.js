const FENCE_POLL_MS = 8;
const FENCE_TIMEOUT_MS = 250;

export function createCameraReadback(renderer, pixels) {
  const gl = renderer.getContext?.();
  const asynchronous = renderer.capabilities?.isWebGL2 === true &&
    typeof gl?.PIXEL_PACK_BUFFER === "number" &&
    typeof gl.fenceSync === "function" &&
    typeof gl.clientWaitSync === "function" &&
    typeof gl.deleteSync === "function" &&
    typeof gl.getBufferSubData === "function";
  let buffer = null, pending = null;

  function releaseBuffer() {
    if (buffer) gl.deleteBuffer(buffer);
    buffer = null;
  }

  function retire(job) {
    pending = null;
    clearTimeout(job.timer);
    gl.deleteSync(job.fence);
  }

  function reset() {
    if (pending) retire(pending);
    releaseBuffer();
  }

  function withPackBuffer(run) {
    // Three r152 doesn't track PIXEL_PACK_BUFFER. Don't change its framebuffer binding.
    const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    try { run(); }
    finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous); }
  }

  function checkError(message) {
    const error = gl.getError();
    if (error !== gl.NO_ERROR || gl.isContextLost?.())
      throw new Error(`${message} (WebGL ${error})`);
  }

  function fail(job, error) {
    reset();
    job.onError(error);
  }

  function poll(job) {
    if (job !== pending) return;
    try {
      if (gl.isContextLost?.()) throw new Error("WebGL context was lost");
      if (performance.now() >= job.deadline) throw new Error("WebGL camera fence timed out");

      const state = gl.clientWaitSync(job.fence, 0, 0);
      if (state === gl.TIMEOUT_EXPIRED) {
        job.timer = setTimeout(() => poll(job), FENCE_POLL_MS);
        return;
      }
      if (state !== gl.ALREADY_SIGNALED && state !== gl.CONDITION_SATISFIED)
        throw new Error("WebGL camera fence wait failed");
      withPackBuffer(() => gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels));
      checkError("Could not copy WebGL camera pixels");
    } catch (error) {
      fail(job, error);
      return;
    }
    retire(job);
    job.onReady();
  }

  function begin(target, onReady, onError) {
    if (gl?.isContextLost?.()) throw new Error("WebGL context was lost");
    const { width, height } = target;
    if (!asynchronous) {
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      return false;
    }

    // Read the single-sample RGBA8 target while Three still has it bound, in the render turn.
    if (renderer.getRenderTarget() !== target) throw new Error("Camera render target is not bound");
    if (pending) throw new Error("Camera readback is already pending");
    let fence;
    try {
      const allocate = buffer === null;
      if (allocate) buffer = gl.createBuffer();
      if (!buffer) throw new Error("Could not allocate WebGL camera pixel buffer");
      withPackBuffer(() => {
        if (allocate) gl.bufferData(gl.PIXEL_PACK_BUFFER, pixels.byteLength, gl.STREAM_READ);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      });
      fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!fence) throw new Error("Could not create WebGL camera fence");
      checkError("Could not queue WebGL camera readback");
      gl.flush();
      const job = { fence, onReady, onError, deadline: performance.now() + FENCE_TIMEOUT_MS };
      job.timer = setTimeout(() => poll(job), FENCE_POLL_MS);
      pending = job;
      return true;
    } catch (error) {
      if (fence) gl.deleteSync(fence);
      releaseBuffer();
      throw error;
    }
  }

  function loseContext() {
    if (pending) fail(pending, new Error("WebGL context was lost"));
    else reset();
  }
  if (asynchronous) renderer.domElement?.addEventListener?.("webglcontextlost", loseContext);

  return {
    asynchronous, begin, reset,
    dispose() {
      if (asynchronous) renderer.domElement?.removeEventListener?.("webglcontextlost", loseContext);
      reset();
    },
  };
}
