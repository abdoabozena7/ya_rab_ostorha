// Boxes come only from Python's JPEG pixel detector, never World.actors.
export function createPerceptionOverlay({ canvas, status, bridge }) {
  const context = canvas.getContext("2d");
  let visible = true;
  let latest = null;
  let busy = false;
  let external = false;

  function draw() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!visible || !latest || (!external && latest.frameId < bridge.lastFrameId - 3)) return;
    for (const detection of latest.detections) {
      const [x1, y1, x2, y2] = detection.box;
      const color = detection.label === "person" ? "#f4a65c" : "#a6edbc";
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.strokeRect(x1, y1, x2 - x1, y2 - y1);
      const label = `${detection.label} ${Math.round(detection.confidence * 100)}%`;
      context.font = "13px Tahoma, Arial, sans-serif";
      const width = context.measureText(label).width + 10;
      context.fillStyle = "#18241de8";
      context.fillRect(x1, Math.max(0, y1 - 20), width, 20);
      context.fillStyle = color;
      context.fillText(label, x1 + 5, Math.max(15, y1 - 5));
    }
  }

  async function poll() {
    if (!visible || busy || external) return;
    busy = true;
    try {
      const response = await fetch("/api/detections", { cache: "no-store" });
      if (!response.ok) throw new Error("API unavailable");
      const data = await response.json();
      latest = data.status === "error" ? null : data.result;
      if (!data.available) {
        status.textContent =
          data.status === "disabled" ? "Pixel detector off" : "Pixel detector not installed";
      } else if (data.status === "error") {
        status.textContent = "Pixel detector error";
      } else if (!latest) {
        status.textContent = "Analyzing frame…";
      } else {
        const count = latest.detections.length;
        status.textContent = `Experimental CV · ${count} ${count === 1 ? "box" : "boxes"} · ${latest.latencyMs} ms`;
      }
      draw();
    } catch {
      latest = null;
      status.textContent = "Pixel detection unavailable";
      draw();
    } finally {
      busy = false;
    }
  }

  function setViewport({ x, y, width, height }) {
    canvas.style.left = `${x}px`;
    canvas.style.bottom = `${y}px`;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  function setVisible(value) {
    visible = value;
    canvas.hidden = !value;
    draw();
  }
  function setExternal(result) {
    external = true;
    latest = result;
    if (result) {
      canvas.width = result.width;
      canvas.height = result.height;
      status.textContent = `${result.model?.id ?? "Camera CV"} · ${result.detections.length} observed objects · ${result.latencyMs.toFixed(1)} ms`;
    } else status.textContent = "Camera observations unavailable";
    draw();
  }

  setInterval(poll, 500);
  poll();
  return {
    setViewport,
    setVisible,
    setExternal,
    draw,
    get latest() {
      return latest;
    },
  };
}
