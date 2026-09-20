/**
 * Progressive images: light twins first, originals swapped in afterwards.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const load = (rel) => import(pathToFileURL(path.join(REPO_ROOT, rel)).href);

describe("low-res twins", () => {
  it("exists on disk for every manifest entry and weighs less", async () => {
    const { LOW_RES_IMAGES } = await load("shared/lowResImages.js");
    const entries = Object.entries(LOW_RES_IMAGES);
    assert.ok(entries.length > 0, "the manifest is not empty");

    for (const [original, twin] of entries) {
      const from = path.join(REPO_ROOT, "ds-showcase/assets", original);
      const to = path.join(REPO_ROOT, "ds-showcase/assets", twin);
      assert.ok(existsSync(to), `${twin} is on disk`);
      assert.ok(
        statSync(to).size < statSync(from).size,
        `${twin} is lighter than ${original}`
      );
    }
  });

  it("keeps only what is genuinely lighter", async () => {
    const { LOW_RES_IMAGES } = await load("shared/lowResImages.js");

    for (const [original, preview] of Object.entries(LOW_RES_IMAGES)) {
      const from = path.join(REPO_ROOT, "ds-showcase/assets", original);
      const to = path.join(REPO_ROOT, "ds-showcase/assets", preview);
      const saving = 1 - statSync(to).size / statSync(from).size;
      assert.ok(saving >= 0.25, `${preview}: saved ${Math.round(saving * 100)}%`);
    }
  });

  it("builds every preview as WebP, which keeps transparency", async () => {
    const { LOW_RES_IMAGES } = await load("shared/lowResImages.js");
    const { usesTransparency } = await load("scripts/detect-alpha.mjs");

    const transparent = Object.keys(LOW_RES_IMAGES).filter((original) =>
      original.endsWith(".png") &&
      usesTransparency(path.join(REPO_ROOT, "ds-showcase/assets", original)));

    assert.ok(transparent.length > 0, "there are images that rely on transparency");
    for (const preview of Object.values(LOW_RES_IMAGES)) {
      // WebP carries an alpha channel, so a single format covers both cases —
      // unlike JPEG, which would fill rounded corners white.
      assert.ok(preview.endsWith(".webp"), `${preview} is WebP`);
    }
  });

  it("hands out a twin and remembers the original", async () => {
    const { withProgressiveAssets, previewUrlFor } = await load("portfolio/js/progressiveImages.js");
    const { LOW_RES_IMAGES } = await load("shared/lowResImages.js");

    const [original, preview] = Object.entries(LOW_RES_IMAGES)[0];
    const fullUrl = `/MyPortfolio/ds-showcase/assets/${original}`;

    assert.equal(previewUrlFor(fullUrl), `/MyPortfolio/ds-showcase/assets/${preview}`);

    const resolve = withProgressiveAssets(() => fullUrl);
    assert.equal(resolve("any.key"), `/MyPortfolio/ds-showcase/assets/${preview}`);
  });

  it("passes through anything without a twin", async () => {
    const { withProgressiveAssets, previewUrlFor } = await load("portfolio/js/progressiveImages.js");

    const icon = "/MyPortfolio/ds-showcase/assets/icons/mail.svg";
    assert.equal(previewUrlFor(icon), null, "icons have no twins");
    assert.equal(previewUrlFor("not a url"), null);

    const resolve = withProgressiveAssets(() => icon);
    assert.equal(resolve("icons.mail"), icon);
  });

  it("upgrades previews to originals, largest on screen first", async () => {
    const { withProgressiveAssets, upgradeImages } = await load("portfolio/js/progressiveImages.js");
    const { LOW_RES_IMAGES } = await load("shared/lowResImages.js");

    const [original, preview] = Object.entries(LOW_RES_IMAGES)[0];
    const fullUrl = `/assets/${original}`;
    const previewUrl = `/assets/${preview}`;
    withProgressiveAssets(() => fullUrl)("key"); // registers the pair

    /** Узел ровно настолько, насколько его трогает апгрейд. */
    const node = (src, size) => ({
      src,
      getAttribute: () => src,
      setAttribute(_name, value) { this.src = value; },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: size, bottom: size }),
    });
    const shown = node(previewUrl, 100);
    const icon = node("/assets/icons/mail.svg", 20);

    const savedWindow = globalThis.innerWidth;
    globalThis.innerWidth = 1280;
    globalThis.innerHeight = 800;
    const saved = globalThis.Image;
    globalThis.Image = class {
      set src(_v) { queueMicrotask(() => this.onload?.()); }
    };
    try {
      const upgraded = await upgradeImages({ querySelectorAll: () => [shown, icon] });
      assert.equal(upgraded, 1, "only the preview was upgraded");
      assert.equal(shown.src, fullUrl, "and it now points at the original");
      assert.equal(icon.src, "/assets/icons/mail.svg", "the icon was untouched");
    } finally {
      globalThis.Image = saved;
      globalThis.innerWidth = savedWindow;
    }
  });
});

describe("zoom priority", () => {
  it("fetches the original as soon as zoom outgrows the preview", async () => {
    const { withProgressiveAssets, watchZoom } = await load("portfolio/js/progressiveImages.js");
    const { LOW_RES_IMAGES } = await load("shared/lowResImages.js");

    const [original, preview] = Object.entries(LOW_RES_IMAGES)[1];
    const fullUrl = `/assets/${original}`;
    const previewUrl = `/assets/${preview}`;
    withProgressiveAssets(() => fullUrl)("key");

    let width = 372; // как на экране при масштабе 1
    const img = {
      src: previewUrl,
      getAttribute: () => img.src,
      setAttribute(_name, value) { img.src = value; },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: 200, width }),
    };

    const saved = {
      Image: globalThis.Image,
      window: globalThis.window,
      raf: globalThis.requestAnimationFrame,
      dpr: globalThis.devicePixelRatio,
    };
    const listeners = {};
    globalThis.window = {
      addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
      removeEventListener() {},
      devicePixelRatio: 1,
    };
    globalThis.innerWidth = 1280;
    globalThis.innerHeight = 800;
    globalThis.devicePixelRatio = 1;
    globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
    globalThis.Image = class {
      set src(_v) { queueMicrotask(() => this.onload?.()); }
    };

    try {
      const stop = watchZoom({ root: { querySelectorAll: () => [img] } });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(img.src, previewUrl, "при масштабе 1 превью хватает");

      width = 1400; // зум примерно 4x
      (listeners.wheel ?? []).forEach((fn) => fn());
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(img.src, fullUrl, "приблизились — оригинал загружен вне очереди");

      stop();
    } finally {
      Object.assign(globalThis, { Image: saved.Image, window: saved.window, requestAnimationFrame: saved.raf, devicePixelRatio: saved.dpr });
    }
  });
});
