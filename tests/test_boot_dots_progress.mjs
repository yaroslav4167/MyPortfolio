/**
 * Dots boot loader: asset readiness and the dark theme toggle.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const load = (rel) => import(pathToFileURL(path.join(REPO_ROOT, rel)).href);

/** Controlled page: time, frames, images and network activity. */
function setupPage() {
  let now = 0;
  let nextId = 1;
  let frames = [];
  const images = [];
  const listeners = {};
  let fontsResolve;
  let notifyResource = () => {};

  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    performance: globalThis.performance,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    PerformanceObserver: globalThis.PerformanceObserver,
    Image: globalThis.Image,
  };

  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = (fn) => {
    const id = nextId++;
    frames.push({ id, fn });
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    frames = frames.filter((f) => f.id !== id);
  };
  globalThis.window = {
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
  };
  globalThis.document = {
    readyState: "loading",
    images,
    fonts: { ready: new Promise((resolve) => { fontsResolve = resolve; }) },
  };
  globalThis.PerformanceObserver = class {
    constructor(cb) { notifyResource = () => cb(); }
    observe() {}
    disconnect() {}
  };
  globalThis.Image = class {
    constructor() { this.complete = false; }
    set src(_url) { /* warm-up probe */ }
  };

  return {
    images,
    addImage(complete = false) {
      images.push({ complete });
      return images[images.length - 1];
    },
    fireLoad() { (listeners.load ?? []).forEach((fn) => fn()); },
    resourceArrived() { notifyResource(); },
    fontsDone() { fontsResolve(); return Promise.resolve(); },
    advance(ms, step = 16) {
      const target = now + ms;
      while (now < target) {
        now = Math.min(now + step, target);
        const pending = frames;
        frames = [];
        pending.forEach((f) => f.fn(now));
      }
    },
    restore() { Object.assign(globalThis, saved); },
  };
}

describe("dots boot: asset readiness", () => {
  it("does not finish while images are still arriving", async () => {
    const page = setupPage();
    try {
      const { trackAssets } = await load("portfolio/js/boot/dots/assets.js");
      let value = 0;
      trackAssets((p) => { value = p; }, { imageGrace: 5000 });

      await page.fontsDone();
      for (let i = 0; i < 5; i++) page.addImage(false);
      page.fireLoad();
      page.advance(2000);
      assert.ok(value < 1, `images pending, loader holds (${value})`);

      page.images.forEach((img) => { img.complete = true; });
      page.advance(1500);
      assert.equal(value, 1, "and finishes once they are in");
    } finally {
      page.restore();
    }
  });

  it("waits for network silence — CSS backgrounds are invisible to document.images", async () => {
    const page = setupPage();
    try {
      const { trackAssets } = await load("portfolio/js/boot/dots/assets.js");
      let value = 0;
      trackAssets((p) => { value = p; }, { idleAfter: 500 });

      await page.fontsDone();
      page.addImage(true);
      page.fireLoad();

      for (let i = 0; i < 8; i++) {
        page.advance(200);
        page.resourceArrived();
      }
      assert.ok(value < 1, "still noisy, so not ready");

      page.advance(900);
      assert.equal(value, 1, "silence means done");
    } finally {
      page.restore();
    }
  });

  it("never waits for the load event — the analytics beacon can hold it forever", async () => {
    const page = setupPage();
    try {
      const { trackAssets } = await load("portfolio/js/boot/dots/assets.js");
      let value = 0;
      trackAssets((p) => { value = p; }, { idleAfter: 500 });

      await page.fontsDone();
      page.addImage(true);
      page.advance(2500); // load never fires
      assert.equal(value, 1);
    } finally {
      page.restore();
    }
  });

  it("reports ready at once when everything came from cache", async () => {
    const page = setupPage();
    try {
      const { trackAssets } = await load("portfolio/js/boot/dots/assets.js");
      // Warm-up probes settle immediately, as they do on a repeat visit.
      globalThis.Image = class {
        constructor() {
          this.complete = true;
          queueMicrotask(() => this.onload?.());
        }
        set src(_url) {}
      };

      let value = 0;
      trackAssets((p) => { value = p; }, { preload: ["/a.png", "/b.png"] });

      await page.fontsDone();
      page.addImage(true);
      page.advance(400);

      assert.equal(value, 1, "ready well before the silence window — no animation needed");
    } finally {
      page.restore();
    }
  });

  it("keeps progress monotonic and honours the hard timeout", async () => {
    const page = setupPage();
    try {
      const { trackAssets } = await load("portfolio/js/boot/dots/assets.js");
      const seen = [];
      trackAssets((p) => seen.push(p), { timeout: 3000 });

      await page.fontsDone();
      page.advance(500);
      for (let i = 0; i < 20; i++) page.addImage(false); // denominator grew
      page.advance(3000);

      for (let i = 1; i < seen.length; i++) {
        assert.ok(seen[i] >= seen[i - 1], "progress never goes back");
      }
      assert.equal(seen.at(-1), 1, "timeout releases the loader");
    } finally {
      page.restore();
    }
  });
});

describe("dots boot: theme", () => {
  it("prefers a stored choice over the system setting", async () => {
    const { resolveTheme } = await load("portfolio/js/boot/dots/theme.js");
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("dark", false), "dark");
    assert.equal(resolveTheme(null, true), "dark");
    assert.equal(resolveTheme("nonsense", true), "dark");
  });

  it("stays inert without a DOM", async () => {
    const { setupTheme } = await load("portfolio/js/boot/dots/theme.js");
    const saved = globalThis.document;
    globalThis.document = undefined;
    try {
      const theme = setupTheme();
      assert.equal(theme.isDark, false);
      theme.toggle();
    } finally {
      globalThis.document = saved;
    }
  });
});
