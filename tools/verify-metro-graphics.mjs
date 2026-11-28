import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GRAPHICS_STORAGE_KEY } from "../src/ui/graphics-settings.js";
import { clickCityTool } from "./city-tool-button.mjs";

const [url, mode] = process.argv.slice(2);
assert.ok(url && new URL(url).hostname === "127.0.0.1", "Pass the owned loopback City URL.");
const negative = mode === "--negative";
const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set PROVE_IT_OUTPUT_DIR to the evidence directory.");
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const viewport = { width: 1280, height: 900 };
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const report = { controls: {}, finish: {}, isolation: {}, errors: [] };

try {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
  page.setDefaultTimeout(22000);
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", message => {
    const text = message.text();
    if (/^(graphics verifier:|WebGL: INVALID|THREE.WebGLProgram: Shader Error)/.test(text))
      report.errors.push(text);
  });
  page.on("response", response => {
    if (response.status() >= 400 && new URL(response.url()).pathname !== "/favicon.ico")
      report.errors.push(`${response.status()} ${response.url()}`);
  });
  await page.addInitScript(() => {
    const proto = WebGL2RenderingContext.prototype;
    const link = proto.linkProgram;
    proto.linkProgram = function (program) {
      link.call(this, program);
      if (!this.getProgramParameter(program, this.LINK_STATUS)) {
        const logs = this.getAttachedShaders(program).map(shader => this.getShaderInfoLog(shader));
        console.error(`graphics verifier: ${this.getProgramInfoLog(program)}\n${logs.join("\n")}`);
      }
    };
  });

  const id = name => page.locator(`#${name}`);
  const image = name => page.screenshot({ path: join(output, `${name}.png`), animations: "disabled" });
  const wait = (fn, value) => page.waitForFunction(fn, value, { timeout: 29000 });
  const readGraphics = () => page.evaluate(() => window.sim.graphicsDiagnostics());
  const readRender = () => page.evaluate(() => window.sim.renderDiagnostics());
  async function frames(count = 3) {
    const last = await page.evaluate(() => window.sim.renderDiagnostics().renderedFrames);
    await wait(target => window.sim.renderDiagnostics().renderedFrames >= target, last + count);
  }
  const ready = () => wait(() => window.sim?.view.actorDiagnostics().ready &&
    window.sim.view.scene.environment && window.sim.graphicsDiagnostics);
  async function openSettings() {
    await clickCityTool(page, "settingsBtn");
    const group = id("graphicsSettings");
    if (await group.getAttribute("open") === null) await group.locator("summary").click();
  }
  async function change(action) {
    await openSettings();
    await action();
    await id("closeSettings").click();
    await frames();
  }
  function rememberPreview() {
    return page.evaluate(() => {
      const { width, height, pixels } = window.previewBeforeGraphics = window.sim.readCameraPreviewPixels();
      return { width, height, nonZero: pixels.filter(value => value > 0).length };
    });
  }
  function comparePreview() {
    return page.evaluate(() => {
      const baseline = window.previewBeforeGraphics;
      const current = window.sim.readCameraPreviewPixels();
      let different = 0;
      for (let i = 0; i < current.pixels.length; i += 4) {
        if (current.pixels.subarray(i, i + 4).some((value, j) => value !== baseline.pixels[i + j])) different++;
      }
      return {
        samePreviewSize: current.width === baseline.width && current.height === baseline.height,
        previewChangedPixels: different,
      };
    });
  }
  function compare(a, b, clips, threshold = 3) {
    return page.evaluate(async ({ a, b, clips, threshold }) => {
      const read = async encoded => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))]));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return clips.map(({ x, y, w, h }) => context.getImageData(x, y, w, h).data);
      };
      const [old, next] = await Promise.all([read(a), read(b)]);
      let changed = 0, lumaChange = 0, count = 0;
      for (let region = 0; region < old.length; region++) {
        for (let i = 0; i < old[region].length; i += 4) {
          const r = next[region][i] - old[region][i];
          const g = next[region][i + 1] - old[region][i + 1];
          const b = next[region][i + 2] - old[region][i + 2];
          if (Math.max(Math.abs(r), Math.abs(g), Math.abs(b)) >= threshold) changed++;
          lumaChange += 0.2126 * r + 0.7152 * g + 0.0722 * b;
          count++;
        }
      }
      return { changed, meanLumaChange: lumaChange / count };
    }, { a: a.toString("base64"), b: b.toString("base64"), clips, threshold });
  }

  await page.goto(url);
  await ready();
  await id("pauseBtn").click();
  if (!negative) {
    await change(() => id("graphicsPreset").selectOption("performance"));
    report.controls.performanceWidth = (await readRender()).width;
    assert.equal(report.controls.performanceWidth, Math.floor(1280 * 0.67));
    await change(() => id("graphicsPreset").selectOption("balanced"));
    assert.equal((await readRender()).width, 1280);
    const preview = await rememberPreview();
    await page.evaluate(() => {
      const sim = window.sim;
      window.graphicsBefore = {
        world: sim.world, actors: [...sim.world.actors], tick: sim.world.tick,
        snapshot: JSON.stringify(sim.snapshot()),
      };
    });
    assert.ok(preview.width === 240 && preview.height === 135 && preview.nonZero > 2 * preview.width * preview.height);
    const clips = [{ x: 400, y: 180, w: 480, h: 230 }, { x: 395, y: 662, w: 490, h: 125 }];
    const fine = await image("01-fine-natural");
    await change(() => id("graphicsDetail").selectOption("standard"));
    const standard = await image("02-standard-natural");
    report.finish.detailChangedPixels = (await compare(standard, fine, clips)).changed;
    assert.ok(report.finish.detailChangedPixels > 2500, JSON.stringify(report.finish));
    await change(() => id("graphicsColor").selectOption("cinematic"));
    const cinematic = await image("03-cinematic");
    report.finish.colorChangedPixels = (await compare(standard, cinematic, clips)).changed;
    assert.ok(report.finish.colorChangedPixels > 10000, JSON.stringify(report.finish));
    await change(async () => {
      await id("graphicsColor").selectOption("natural");
      await id("graphicsExposure").press("Home");
    });
    const darker = await image("04-exposure-70");
    report.finish.exposureLumaChange = (await compare(standard, darker, clips)).meanLumaChange;
    assert.ok(report.finish.exposureLumaChange < -6, JSON.stringify(report.finish));
    await change(async () => {
      await id("graphicsReflections").selectOption("live");
      await id("graphicsLens").check();
      await id("graphicsScale").fill("83");
    });
    assert.equal((await readRender()).width, Math.floor(1280 * 0.83));
    assert.equal(await page.evaluate(() => window.sim.cinematicDiagnostics().post.lastState.lensEffects), false);
    report.isolation = await page.evaluate(() => {
      const { world, actors, tick, snapshot } = window.graphicsBefore;
      const sim = window.sim;
      return {
        sameWorld: world === sim.world, sameTick: tick === sim.world.tick,
        sameActors: actors.length === world.actors.length && actors.every((actor, i) => actor === world.actors[i]),
        sameSnapshot: JSON.stringify(sim.snapshot()) === snapshot,
      };
    });
    Object.assign(report.isolation, await comparePreview());
    assert.ok(Object.entries(report.isolation).every(([key, value]) =>
      key === "previewChangedPixels" ? value === 0 : value === true), JSON.stringify(report.isolation));
    await id("pauseBtn").click();
    await page.keyboard.down("w");
    try {
      await wait(() => window.sim.world.player.speed > 2);
      report.isolation.manualDriveMps = await page.evaluate(() => window.sim.world.player.speed);
    } finally {
      await page.keyboard.up("w");
    }

    await page.reload();
    await ready();
    await id("pauseBtn").click();
    await openSettings();
    report.controls.restoredRenderScale = await id("graphicsScale").inputValue();
    assert.equal(report.controls.restoredRenderScale, "83");
    assert.equal(await id("graphicsPreset").inputValue(), "custom");
    assert.equal(await id("graphicsExposure").inputValue(), "70");
    assert.equal(await id("graphicsDetail").inputValue(), "standard");
    assert.ok(await id("graphicsLens").isChecked());
    await id("graphicsReset").click();
    assert.equal(await id("graphicsPreset").inputValue(), "auto");
    await id("closeSettings").click();

    await page.evaluate(key => localStorage.setItem(key, "not-valid-graphics-json"), GRAPHICS_STORAGE_KEY);
    await page.reload();
    await ready();
    await id("pauseBtn").click();
    await openSettings();
    assert.equal(await id("graphicsPreset").inputValue(), "auto");
    assert.match(await id("graphicsStatus").textContent(), /invalid.*Auto/);
    await id("graphicsReset").click();
    await id("closeSettings").click();
  }

  assert.ok((await readGraphics()).supportsLiveReflections, "The verification browser must support the live reflection pass.");
  await change(async () => {
    await id("graphicsPreset").selectOption("ultra");
    await id("graphicsReflections").selectOption("environment");
  });
  assert.equal((await readRender()).width, 1600);
  await page.evaluate(() => {
    const sim = window.sim;
    const puddle = sim.view.streetSurfaces.reflectionPlanes.find(plane => plane.id === "tahrir-west-puddle");
    Object.assign(sim.world.player, {
      x: puddle.x - 20, z: puddle.z, heading: Math.PI / 2, speed: 0, previous: null,
    });
    sim.setFreeCameraShot({
      pos: { x: puddle.x - 12, y: puddle.y + 1.6, z: puddle.z },
      lookAt: { x: puddle.x, y: puddle.y, z: puddle.z },
    });
    // At this height the geometric mirror ray through the image center meets
    // the card. The direct card lands well above the sampled puddle pixels.
    const sky = sim.view.skyDome;
    const Plane = sim.view.scene.children.find(mesh => mesh.geometry?.type === "PlaneGeometry").geometry.constructor;
    const card = new sky.constructor(new Plane(4, 1.4),
      new sky.material.constructor({ color: 0xfd3ff9, side: 2, toneMapped: false }));
    card.position.set(puddle.x + 10, puddle.y + (1.6 * 10) / 12, puddle.z);
    card.rotation.y = Math.PI / 2;
    card.visible = false;
    sim.view.scene.add(card);
    window.reflectionCard = card;
  });
  await frames(5);
  if (!negative) {
    const shadowPasses = (await readRender()).shadowPassFrames;
    await wait(last => window.sim.renderDiagnostics().shadowPassFrames >= last + 2, shadowPasses);
    await frames(3);
    const preview = await rememberPreview();
    assert.ok(preview.nonZero > 2 * preview.width * preview.height);
    await frames();
    assert.deepEqual(await comparePreview(), { samePreviewSize: true, previewChangedPixels: 0 },
      "The paused puddle preview must be stable before toggling display reflections.");
    await change(() => id("graphicsReflections").selectOption("live"));
    await wait(() => window.sim.graphicsDiagnostics().reflection.puddle === "tahrir-west-puddle");
    await frames(3);
    const puddlePreview = await comparePreview();
    report.isolation.puddlePreviewChangedPixels = puddlePreview.previewChangedPixels;
    assert.deepEqual(puddlePreview, { samePreviewSize: true, previewChangedPixels: 0 });
  }
  const puddleClip = [{ x: 600, y: 434, w: 80, h: 32 }];
  const directClip = [{ x: 595, y: 307, w: 90, h: 88 }];
  const setCard = async visible => {
    const captures = (await readGraphics()).reflection.captures;
    await page.evaluate(visible => { window.reflectionCard.visible = visible; }, visible);
    if ((await readGraphics()).settings.reflections === "live")
      await wait(last => window.sim.graphicsDiagnostics().reflection.captures > last, captures);
    await frames();
  };
  const first = await image("reflection-without-card");
  await setCard(true);
  const second = await image("reflection-with-card");
  assert.ok((await compare(first, second, directClip, 6)).changed > 100, "Calibration card was not drawn above the puddle.");
  assert.deepEqual(report.errors, []);
  report.finish.reflectedObjectChangedPixels = (await compare(first, second, puddleClip, 6)).changed;
  assert.ok(report.finish.reflectedObjectChangedPixels > 30,
    `Moving object was not visible in the puddle reflection: ${report.finish.reflectedObjectChangedPixels} changed pixels`);

  await setCard(false);
  await change(() => id("graphicsReflections").selectOption("environment"));
  const env = await image("reflection-environment-without-card");
  await setCard(true);
  const envCard = await image("reflection-environment-with-card");
  report.finish.environmentObjectChangedPixels = (await compare(env, envCard, puddleClip, 6)).changed;
  assert.equal(report.finish.environmentObjectChangedPixels, 0);
  await page.evaluate(() => {
    const card = window.reflectionCard;
    card.removeFromParent();
    card.geometry.dispose();
    card.material.dispose();
    window.sim.setFreeCameraShot(null);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings();
  await id("graphicsReset").click();
  const summary = id("graphicsSettings").locator("summary");
  await summary.press("Enter");
  assert.equal(await id("graphicsSettings").getAttribute("open"), null);
  await summary.press("Enter");
  assert.ok(await id("graphicsPreset").isVisible());
  report.controls.mobileHorizontalOverflow = await id("settingsPanel").evaluate(drawer =>
    Math.max(0, drawer.scrollWidth - drawer.clientWidth, Math.ceil(drawer.getBoundingClientRect().right - innerWidth)));
  assert.equal(report.controls.mobileHorizontalOverflow, 0);
  await image("graphics-mobile");
  await page.setViewportSize(viewport);
  await image("graphics-desktop");
  assert.deepEqual(report.errors, []);
} finally {
  await browser.close();
  await writeFile(join(output, "graphics-result.json"), JSON.stringify(report, null, 2));
}
