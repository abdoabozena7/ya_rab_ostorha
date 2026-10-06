// Optional same-origin telemetry bridge for future Python perception/policy work.
// The in-game phone and driving controls run locally in the browser.
export function createBridge({ renderer, readState }) {
  const client=crypto.randomUUID();
  document.body.dataset.telemetryClient=client;
  let enabled = false;
  const capture = document.createElement('canvas');
  capture.width = 480;
  capture.height = 270;
  const context = capture.getContext('2d');

  async function checkHealth() {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      enabled = response.ok && (await response.json()).ok === true;
    } catch { enabled = false; }
  }

  async function report() {
    if (!enabled) return;
    try {
      await fetch(`/api/legacy/state?client=${encodeURIComponent(client)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(readState())
      });
    } catch { enabled = false; }
  }

  function sendFrame(viewport) {
    if (!enabled) return;
    const pixelRatio = renderer.domElement.width / window.innerWidth;
    const sourceTop = window.innerHeight - viewport.y - viewport.height;
    context.drawImage(renderer.domElement,
      viewport.x * pixelRatio, sourceTop * pixelRatio,
      viewport.width * pixelRatio, viewport.height * pixelRatio,
      0, 0, capture.width, capture.height);
    capture.toBlob((blob) => {
      if (blob) fetch('/api/legacy/frame', {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob
      }).catch(() => {});
    }, 'image/jpeg', 0.55);
  }

  checkHealth();
  setInterval(checkHealth, 5000);
  setInterval(report, 500);
  return { sendFrame };
}
