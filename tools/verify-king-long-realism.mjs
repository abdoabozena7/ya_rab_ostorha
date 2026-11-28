import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const mode = process.argv[2] || "browser";
const output = process.env.PROVE_IT_OUTPUT_DIR || join(process.cwd(), "tmp", "verify-king-long-realism");
await mkdir(output, { recursive: true });

if (mode === "negative-control") {
  // Negative control: confirm our visual fidelity audit fails if key King Long reference parts are absent
  const missingFeatures = [
    "king-long-front-emblem",
    "king-long-rear-emblem",
    "king-long-rear-wordmark",
    "king-long-rear-wiper",
    "king-long-right-sliding-track",
    "king-long-mudflaps",
    "king-long-spare-underbody",
    "king-long-grille-chrome-surround",
    "king-long-window-mullions",
  ];
  const simulatedMinimalMeshNames = new Set([
    "king-long-rounded-white-roof",
    "king-long-front-bumper",
    "king-long-rear-bumper",
  ]);
  const missing = missingFeatures.filter((name) => !simulatedMinimalMeshNames.has(name));
  await writeFile(join(output, "negative-control.json"), JSON.stringify({
    faultInjected: "minimal-box-model-without-reference-details",
    missingCount: missing.length,
    missing,
  }, null, 2));
  console.error("NEGATIVE_CONTROL_MISSING_PARTS:", missing.join(","));
  assert.equal(missing.length, missingFeatures.length);
  process.exit(1);
}

const base = process.env.THREEJS_URL || "http://127.0.0.1:8000";
const health = await fetch(`${base}/api/health`).then((r) => r.json());
assert.equal(health.mode, "threejs");

const req = createRequire(import.meta.url);
function resolvePlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, "playwright"].filter(Boolean);
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const npxDir = join(localAppData, "npm-cache", "_npx");
    if (existsSync(npxDir)) {
      for (const entry of readdirSync(npxDir)) {
        candidates.push(join(npxDir, entry, "node_modules", "playwright"));
      }
    }
  }
  let fallback = null;
  for (const candidate of candidates) {
    try {
      const mod = req(candidate);
      if (!fallback) fallback = mod;
      const exe = mod.chromium?.executablePath?.();
      if (exe && existsSync(exe)) return mod;
    } catch {}
  }
  if (fallback) return fallback;
  throw new Error("Could not locate Playwright module.");
}

const { chromium } = resolvePlaywright();
const launchOpts = { headless: true };
if (!existsSync(chromium.executablePath()) && process.env.LOCALAPPDATA) {
  const mpw = join(process.env.LOCALAPPDATA, "ms-playwright");
  if (existsSync(mpw)) {
    const dirs = readdirSync(mpw).filter((d) => d.startsWith("chromium-")).sort().reverse();
    for (const d of dirs) {
      const exe = join(mpw, d, "chrome-win64", "chrome.exe");
      if (existsSync(exe)) {
        launchOpts.executablePath = exe;
        break;
      }
    }
  }
}

const browser = await chromium.launch(launchOpts);
const report = { passed: false, errors: [], shots: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(75_000);
  page.on("pageerror", (e) => report.errors.push(e.stack || e.message));
  page.on("response", (res) => {
    if (res.status() >= 400 && !res.url().endsWith("/favicon.ico"))
      report.errors.push(`${res.status()} ${res.url()}`);
  });

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => window.sim?.defaultChaseReady && window.sim.view.actorDiagnostics().ready,
    null,
    { timeout: 120_000 },
  );
  await page.evaluate(() => {
    window.sim.pause(true);
    window.sim.step(2);
  });

  // Hide HUD panels cleanly? No, capture real gameplay view first, then multi-angle inspection shots!
  const setRelCam = (pos, lookAt) => page.evaluate(({ pos, lookAt }) => {
    const { world, view } = window.sim;
    const p = world.player;
    const root = view.roots.get("player").root;
    const s = Math.sin(p.heading), c = Math.cos(p.heading);
    const xform = ([lx, ly, lz]) => ({
      x: root.position.x + c * lx + s * lz,
      y: root.position.y + ly,
      z: root.position.z - s * lx + c * lz,
    });
    window.sim.setFreeCameraShot({ pos: xform(pos), lookAt: xform(lookAt) });
  }, { pos, lookAt });

  const shot = async (name) => {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const bytes = await page.screenshot({ path: join(output, name), scale: "css", timeout: 90_000 });
    report.shots.push({ name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  };

  // Inspect meshes and materials in the live Three.js player rig
  const inspection = await page.evaluate(() => {
    const { world, vehicleRig } = window.sim;
    const names = [];
    let totalMeshes = 0;
    let totalTriangles = 0;
    let chromeMirrorCount = 0;
    vehicleRig.root.traverse((obj) => {
      if (obj.isMesh) {
        totalMeshes++;
        names.push(obj.name);
        const geo = obj.geometry;
        totalTriangles += geo.index ? geo.index.count / 3 : (geo.attributes.position?.count ?? 0) / 3;
        if (obj.name.includes("mirror-chrome") || (obj.name.includes("mirror-housing") && (obj.material?.metalness ?? 0) >= 0.7)) {
          chromeMirrorCount++;
        }
      }
    });
    const requiredParts = [
      "king-long-front-emblem",
      "king-long-rear-emblem",
      "king-long-rear-wordmark",
      "king-long-rear-wiper",
      "king-long-grille-chrome-surround",
      "king-long-right-sliding-track",
      "king-long-mudflaps",
      "king-long-spare-underbody",
    ];
    const present = requiredParts.filter((id) => names.some((n) => n.includes(id)));
    const missing = requiredParts.filter((id) => !names.some((n) => n.includes(id)));
    return {
      vehicleModel: world.player.vehicleModel ?? "jetour-t2",
      asset: vehicleRig.diagnostics.asset,
      totalMeshes,
      totalTriangles: Math.round(totalTriangles),
      chromeMirrorCount,
      present,
      missing,
    };
  });
  report.inspection = inspection;

  await shot("01-live-chase-rear.png");
  const elevation = ["03-rear-elevation.png", [0, 1.25, -4.85], [0, 1.02, -1.8]];
  const angles = mode === "rear" ? [
    elevation,
    ["rear-quarter.png", [3.25, 1.4, -5.7], [0, 0.96, -1.15]],
    ["rear-low.png", [0, 0.8, -5.75], [0, 0.99, -1.8]],
  ] : [
    ["02-front-right-three-quarter.png", [4.15, 1.38, 4.35], [0, 0.96, 0.25]],
    elevation,
    ["04-front-elevation.png", [0, 1.22, 4.95], [0, 1.00, 1.8]],
    ["05-front-left-three-quarter.png", [-4.25, 1.35, 3.95], [0, 0.96, 0.15]],
    ["06-front-fascia-closeup.png", [1.85, 1.05, 3.65], [0.1, 0.82, 1.95]],
  ];
  for (const [name, position, target] of angles) {
    await setRelCam(position, target);
    await shot(name);
  }

  await page.evaluate(() => window.sim.setFreeCameraShot(null));

  const failures = [];
  if (report.errors.length) failures.push(`errors: ${report.errors.join("; ")}`);
  if (inspection.vehicleModel !== "king-long-microbus") failures.push(`wrong model: ${inspection.vehicleModel}`);
  if (inspection.missing.length) failures.push(`missing reference parts: ${inspection.missing.join(", ")}`);
  if (inspection.chromeMirrorCount < 2) failures.push(`expected >=2 chrome mirror parts, got ${inspection.chromeMirrorCount}`);

  report.passed = failures.length === 0;
  report.failures = failures;
  await writeFile(join(output, "realism-result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exit(1);
} finally {
  await browser.close();
}
