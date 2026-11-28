import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { clickCityTool } from "./city-tool-button.mjs";

const [url] = process.argv.slice(2);
const target = url && new URL(url);
assert.ok(target?.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname),
  "Pass the owned loopback City URL.");
const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set PROVE_IT_OUTPUT_DIR to the evidence directory.");
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const viewport = { width: 1280, height: 900 };
const clip = { x: 360, y: 155, width: 560, height: 260 };
const diagonal = { left: 43, right: 224 };
const previewSize = [240, 135];
const report = {
  additionalEdgePixels: null,
  flatInteriorPixelChanges: null,
  sameRenderSize: null,
  previewChangedPixels: null,
  restored: null,
  errors: [],
};

function previewDiff(before, after) {
  let changedPixels = 0, changedBytes = 0;
  for (let i = 0; i < before.length; i += 4) {
    let pixelChanged = false;
    for (let c = 0; c < 4; c++) {
      if (before[i + c] !== after[i + c]) {
        pixelChanged = true;
        changedBytes++;
      }
    }
    changedPixels += Number(pixelChanged);
  }
  return { changedPixels, changedBytes };
}

let browser;
try {
  browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
  page.setDefaultTimeout(22000);
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", message => {
    if (/^(WebGL: INVALID|THREE.WebGLProgram: Shader Error|THREE.WebGLRenderer: Context Lost)/.test(message.text())) {
      report.errors.push(message.text());
    }
  });
  page.on("response", response => {
    const resource = new URL(response.url());
    if (resource.origin === target.origin && response.status() >= 400 && resource.pathname !== "/favicon.ico") {
      report.errors.push(`${response.status()} ${resource.pathname}`);
    }
  });

  const id = name => page.locator(`#${name}`);
  const smoothing = id("graphicsEdgeSmoothing");
  const render = () => page.evaluate(() => window.sim.renderDiagnostics());
  const wait = (fn, value) => page.waitForFunction(fn, value, { timeout: 29000 });
  const assetsReady = () => wait(() => {
    const sim = window.sim;
    if (sim?.world.environment !== "metro" || sim.world.config.cityVersion !== 5 ||
        !sim.view.scene.environment || !sim.defaultChaseReady) return false;
    const actors = sim.view.actorDiagnostics();
    return actors.ready && actors.loadingPeopleAssets === 0 && actors.unwarmedPeopleAssets === 0;
  });

  async function frames(count = 5) {
    const { renderedFrames, frontPreviewFrames } = await render();
    await wait(({ rendered, preview }) => {
      const state = window.sim.renderDiagnostics();
      return state.renderedFrames >= rendered && state.frontPreviewFrames >= preview;
    }, { rendered: renderedFrames + count, preview: frontPreviewFrames + count });
  }

  async function openSettings() {
    await clickCityTool(page, "settingsBtn");
    const group = id("graphicsSettings");
    if (await group.getAttribute("open") === null) await group.locator("summary").click();
  }

  async function readFrame() {
    const { encodedPreview, coloredPixels, ...state } = await page.evaluate(() => {
      const sim = window.sim;
      const frozen = window.metroEdgeOracle;
      const render = sim.renderDiagnostics();
      const post = sim.cinematicDiagnostics().post;
      const { width, height, pixels } = sim.readCameraPreviewPixels();
      let raw = "", coloredPixels = 0;
      for (let i = 0; i < pixels.length; i += 8192) {
        raw += String.fromCharCode(...pixels.subarray(i, i + 8192));
      }
      for (let i = 0; i < pixels.length; i += 4) {
        coloredPixels += Number(Boolean(pixels[i] || pixels[i + 1] || pixels[i + 2]));
      }
      return {
        encodedPreview: btoa(raw),
        coloredPixels,
        previewSize: [width, height],
        size: [render.width, render.height, render.pixelRatio],
        postSize: [post.width, post.height],
        camera: render.cameraPosition,
        sensor: [render.sensorCameraPosition, render.sensorCameraDirection],
        settings: sim.graphicsDiagnostics().settings,
        pausedCity: sim.paused && frozen.world === sim.world && frozen.view === sim.view &&
          frozen.tick === sim.world.tick && frozen.actors.length === sim.world.actors.length &&
          frozen.actors.every((actor, i) => actor === sim.world.actors[i]) &&
          frozen.snapshot === JSON.stringify(sim.snapshot()),
        frontPreview: render.previewActive && render.sensorCamera === "front",
      };
    });
    const preview = Buffer.from(encodedPreview, "base64");
    assert.deepEqual(state.previewSize, previewSize);
    assert.equal(preview.length, previewSize[0] * previewSize[1] * 4);
    assert.ok(coloredPixels > previewSize[0] * previewSize[1] / 2, "The front preview was empty or still loading.");
    assert.ok(state.pausedCity, "The paused City, actors or simulation snapshot changed.");
    assert.ok(state.frontPreview, "The original front-camera preview must be active.");
    return { state, preview };
  }

  async function capture(name, filtered) {
    await frames();
    const start = await readFrame();
    assert.equal(start.state.settings.edgeSmoothing, filtered);
    const image = await page.screenshot({ path: join(output, `edge-${name}.png`), animations: "disabled" });
    await frames();
    const end = await readFrame();
    const repeat = await page.screenshot({ clip, animations: "disabled" });
    assert.deepEqual(end.state, start.state, `${name}: frame state did not settle.`);
    assert.ok(start.preview.equals(end.preview), `${name}: front-preview bytes were not stable.`);
    return { ...start, image, repeat };
  }

  const response = await page.goto(url);
  assert.ok(response?.ok() && new URL(page.url()).origin === target.origin, "The owned City did not load.");
  await assetsReady();
  await id("pauseBtn").click();
  await openSettings();
  await id("graphicsPreset").selectOption("ultra");
  assert.ok(await smoothing.isChecked(), "Ultra should enable display edge smoothing.");
  // Use native 1:1 screenshot sampling and remove unrelated reflective and optical effects.
  await id("graphicsScale").fill("100");
  await id("graphicsReflections").selectOption("environment");
  await smoothing.uncheck();
  await id("closeSettings").click();

  await page.evaluate(({ viewport, clip, diagonal }) => {
    const sim = window.sim;
    const { world, view } = sim;
    if (!sim.paused) throw new Error("The City must be paused before adding the calibration card.");
    window.metroEdgeOracle = { world, view, tick: world.tick, actors: [...world.actors],
      snapshot: JSON.stringify(sim.snapshot()) };
    const { x, z, heading } = world.player;
    const ground = world.terrainElevationAt?.(x, z) ?? 0;
    const { skyDome: sky, scene } = view;
    const sin = Math.sin(heading), cos = Math.cos(heading);
    const eye = sky.position.clone().set(x - 15 * sin, ground + 7, z - 15 * cos);
    const aim = sky.position.clone().set(x + 5 * sin, ground + 1.6, z + 5 * cos);
    sim.setFreeCameraShot({ pos: eye, lookAt: aim });

    // Both halves share the same world-space edge, projected at native screen-pixel coordinates.
    const distance = 2.4;
    const center = aim.clone().sub(eye).normalize().multiplyScalar(distance).add(eye);
    const unit = 2 * distance * Math.tan(sim.renderDiagnostics().cameraFov * Math.PI / 360) / viewport.height;
    const Geometry = Object.getPrototypeOf(Object.getPrototypeOf(sky.geometry)).constructor;
    const Attribute = sky.geometry.getAttribute("position").constructor;
    const face = (name, points, color) => {
      const vertices = [0, 1, 2, 0, 2, 3].flatMap(i => [
        (clip.x + points[i][0] - viewport.width / 2) * unit,
        (viewport.height / 2 - clip.y - points[i][1]) * unit, 0,
      ]);
      const geometry = new Geometry();
      geometry.setAttribute("position", new Attribute(vertices, 3));
      const mesh = new sky.constructor(geometry, new sky.material.constructor({
        color, fog: false, toneMapped: false, depthTest: false, depthWrite: false, transparent: true,
      }));
      mesh.name = `edge-calibration-${name}`;
      mesh.position.copy(center);
      mesh.lookAt(eye);
      mesh.renderOrder = 10000;
      scene.add(mesh);
    };
    const left = [0, diagonal.left], right = [clip.width, diagonal.right];
    face("dark", [[0, 0], left, right, [clip.width, 0]], 0x101010);
    face("light", [left, [0, clip.height], [clip.width, clip.height], right], 0xf0f0f0);
    const { sensorCameraPosition, sensorCameraDirection } = sim.renderDiagnostics();
    const sensor = sky.position.clone().fromArray(sensorCameraPosition);
    const direction = sky.position.clone().fromArray(sensorCameraDirection);
    const radius = Math.hypot(viewport.width, viewport.height) * unit / 2;
    if (center.clone().sub(sensor).dot(direction) + radius >= 0) {
      throw new Error("The edge witness must be behind the vehicle's front camera.");
    }
  }, { viewport, clip, diagonal });
  await frames();
  await assetsReady();

  const off = await capture("unfiltered", false);
  await openSettings();
  await smoothing.check();
  await id("closeSettings").click();
  const on = await capture("filtered", true);
  assert.deepEqual(on.state.settings, { ...off.state.settings, edgeSmoothing: true });
  assert.deepEqual(on.state.camera, off.state.camera);
  assert.deepEqual(on.state.sensor, off.state.sensor);
  report.renderSize = { unfiltered: off.state.size, filtered: on.state.size };
  report.sameRenderSize = off.state.size.every((value, i) => value === on.state.size[i]) &&
    off.state.postSize.every((value, i) => value === on.state.postSize[i]);
  assert.deepEqual(off.state.size, [viewport.width, viewport.height, 1], "Screen capture must be at native render size.");
  assert.deepEqual(off.state.postSize, [viewport.width, viewport.height]);
  assert.equal(report.sameRenderSize, true, "Edge smoothing changed a render size.");
  const preview = previewDiff(off.preview, on.preview);
  report.previewSize = on.state.previewSize;
  report.previewChangedPixels = preview.changedPixels;
  report.previewChangedBytes = preview.changedBytes;
  assert.equal(preview.changedBytes, 0, "Display filtering contaminated the 240×135 preview.");

  const pixels = await page.evaluate(async ({ images, clip, diagonal }) => {
    const read = async (data, fullViewport) => {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const context = new OffscreenCanvas(clip.width, clip.height).getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, fullViewport ? -clip.x : 0, fullViewport ? -clip.y : 0);
      bitmap.close();
      return context.getImageData(0, 0, clip.width, clip.height).data;
    };
    const [off, offRepeat, on, onRepeat] = await Promise.all(images.map((image, i) => read(image, i % 2 === 0)));
    const luma = (data, i) => .2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2];
    const different = (a, b, i, j = i) =>
      a[i] !== b[j] || a[i + 1] !== b[j + 1] || a[i + 2] !== b[j + 2] || a[i + 3] !== b[j + 3];
    const dark = (20 * clip.width + 20) * 4;
    const light = ((clip.height - 20) * clip.width + clip.width - 20) * 4;
    const low = luma(off, dark), high = luma(off, light);
    const intermediate = (data, i) => luma(data, i) > low + 5 && luma(data, i) < high - 5;
    const result = {
      contrast: high - low, unfilteredIntermediatePixels: 0, filteredIntermediatePixels: 0,
      flatInteriorPixelChanges: 0, nonflatBaselinePixels: 0,
      temporalPixelChanges: { unfiltered: 0, filtered: 0 }, interiorSamples: [0, 0],
    };
    for (let x = 10; x < clip.width - 10; x++) {
      const edgeY = diagonal.left + (diagonal.right - diagonal.left) * (x + .5) / clip.width;
      for (let y = 10; y < clip.height - 10; y++) {
        const i = (y * clip.width + x) * 4;
        const offset = y + .5 - edgeY;
        result.temporalPixelChanges.unfiltered += Number(different(off, offRepeat, i));
        result.temporalPixelChanges.filtered += Number(different(on, onRepeat, i));
        if (Math.abs(offset) <= 5) {
          result.unfilteredIntermediatePixels += Number(intermediate(off, i));
          result.filteredIntermediatePixels += Number(intermediate(on, i));
        } else if (Math.abs(offset) >= 12) {
          result.interiorSamples[Number(offset > 0)]++;
          result.nonflatBaselinePixels += Number(different(off, off, i, offset < 0 ? dark : light));
          result.flatInteriorPixelChanges += Number(different(off, on, i));
        }
      }
    }
    return result;
  }, { images: [off.image, off.repeat, on.image, on.repeat].map(image => image.toString("base64")), clip, diagonal });
  Object.assign(report, pixels, {
    additionalEdgePixels: pixels.filteredIntermediatePixels - pixels.unfilteredIntermediatePixels,
  });
  assert.ok(pixels.contrast >= 175, `The live card was not high-contrast: ${pixels.contrast}`);
  assert.equal(pixels.nonflatBaselinePixels, 0, "The calibration card was occluded, misaligned, or non-flat.");
  assert.deepEqual(pixels.temporalPixelChanges, { unfiltered: 0, filtered: 0 },
    "Repeated frames of the fixed calibration card were not byte-stable.");
  assert.ok(report.additionalEdgePixels >= 30,
    `Edge smoothing produced only ${report.additionalEdgePixels} additional intermediate pixels (expected at least 30).`);
  assert.equal(report.flatInteriorPixelChanges, 0, "Edge smoothing changed flat interior pixels.");

  await page.reload();
  await assetsReady();
  await id("pauseBtn").click();
  await frames();
  await openSettings();
  const restoredSettings = await page.evaluate(() => window.sim.graphicsDiagnostics().settings);
  report.restored = await smoothing.isChecked() && await id("graphicsScale").inputValue() === "100" &&
    await id("graphicsPreset").inputValue() === "custom" && restoredSettings.edgeSmoothing === true;
  assert.equal(report.restored, true, "The actual edge-smoothing control did not survive reload at the same scale.");
  assert.deepEqual(restoredSettings, on.state.settings);
  const { width, height, pixelRatio } = await render();
  assert.deepEqual([width, height, pixelRatio], on.state.size, "The restored scale did not reach the canvas.");
  await id("graphicsSettings").locator("summary").press("Escape");
  assert.ok(await id("settingsPanel").isHidden());
  assert.ok(await id("cityTools").locator("summary").evaluate(node => node === document.activeElement));

  await page.evaluate(() => window.sim.setSensorCamera("rear"));
  await frames();
  const nextRearJpeg = async () => {
    const response = await page.waitForResponse(item =>
      new URL(item.url()).pathname === "/api/frame" && item.request().method() === "POST");
    assert.ok(response.ok(), "The City did not submit a rear-camera JPEG.");
    const { frameId } = await response.json();
    const received = await page.request.get(new URL("/api/frame", target.origin).href);
    assert.equal(Number(received.headers()["x-frame-id"]), frameId);
    const jpeg = await received.body();
    assert.ok(received.ok() && jpeg.length > 500 && jpeg[0] === 255 && jpeg[1] === 216,
      "The standalone server did not return the accepted camera JPEG.");
    return jpeg;
  };
  const rearNative = await nextRearJpeg();
  await openSettings();
  await id("graphicsScale").fill("83");
  await id("closeSettings").click();
  await frames();
  const rearScaled = await nextRearJpeg();
  report.rearJpegUnchanged = rearNative.equals(rearScaled);
  assert.equal(report.rearJpegUnchanged, true, "Display scale affected the submitted rear-camera JPEG.");
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  try {
    await browser?.close();
  } finally {
    await writeFile(join(output, "edge-result.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
}
