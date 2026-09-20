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
    const { usesTransparency } = await load("scripts/detect-alpha.mjs");

    for (const [original, twin] of Object.entries(LOW_RES_IMAGES)) {
      const from = path.join(REPO_ROOT, "ds-showcase/assets", original);
      const to = path.join(REPO_ROOT, "ds-showcase/assets", twin);
      const saving = 1 - statSync(to).size / statSync(from).size;
      // Transparent images stay PNG and gain less; opaque ones become JPEG and gain a lot.
      const floor = usesTransparency(from) ? 0.12 : 0.25;
      assert.ok(saving >= floor, `${twin}: saved ${Math.round(saving * 100)}%`);
    }
  });

  it("converts only images that do not actually use transparency", async () => {
    const { LOW_RES_IMAGES } = await load("shared/lowResImages.js");
    const { usesTransparency } = await load("scripts/detect-alpha.mjs");

    for (const [original, twin] of Object.entries(LOW_RES_IMAGES)) {
      const from = path.join(REPO_ROOT, "ds-showcase/assets", original);
      if (twin.endsWith(".jpg")) {
        assert.equal(usesTransparency(from), false, `${original} has nothing to lose`);
      } else {
        assert.equal(usesTransparency(from), true, `${original} needs its alpha`);
      }
    }
  });

  it("keeps transparency as PNG and drops the rest to JPEG", async () => {
    const { LOW_RES_IMAGES } = await load("shared/lowResImages.js");
    for (const [original, twin] of Object.entries(LOW_RES_IMAGES)) {
      const ext = path.extname(twin);
      assert.ok(
        ext === ".jpg" || ext === path.extname(original),
        `${twin} is either a JPEG or keeps the original format`
      );
    }
  });
});

describe("progressive resolver", () => {
  it("hands out a twin and remembers the original", async () => {
    const { withProgressiveAssets, twinUrlFor } = await load("portfolio/js/progressiveImages.js");
    const { LOW_RES_IMAGES } = await load("shared/lowResImages.js");

    const [original, twin] = Object.entries(LOW_RES_IMAGES)[0];
    const fullUrl = `/MyPortfolio/ds-showcase/assets/${original}`;

    assert.equal(twinUrlFor(fullUrl), `/MyPortfolio/ds-showcase/assets/${twin}`);

    const resolve = withProgressiveAssets(() => fullUrl);
    assert.equal(resolve("any.key"), `/MyPortfolio/ds-showcase/assets/${twin}`);
  });

  it("passes through anything without a twin", async () => {
    const { withProgressiveAssets, twinUrlFor } = await load("portfolio/js/progressiveImages.js");

    const icon = "/MyPortfolio/ds-showcase/assets/icons/mail.svg";
    assert.equal(twinUrlFor(icon), null, "icons have no twins");
    assert.equal(twinUrlFor("not a url"), null);

    const resolve = withProgressiveAssets(() => icon);
    assert.equal(resolve("icons.mail"), icon);
  });

  it("upgrades previews to originals and leaves the rest alone", async () => {
    const { withProgressiveAssets, upgradeImages } = await load("portfolio/js/progressiveImages.js");
    const { LOW_RES_IMAGES } = await load("shared/lowResImages.js");

    const [original, twin] = Object.entries(LOW_RES_IMAGES)[0];
    const fullUrl = `/assets/${original}`;
    const twinUrl = `/assets/${twin}`;
    withProgressiveAssets(() => fullUrl)("key"); // registers the pair

    const preview = { src: twinUrl, getAttribute: () => twinUrl };
    const icon = { src: "/assets/icons/mail.svg", getAttribute: () => "/assets/icons/mail.svg" };

    const saved = globalThis.Image;
    globalThis.Image = class {
      set src(_v) { queueMicrotask(() => this.onload?.()); }
    };
    try {
      const upgraded = await upgradeImages({ querySelectorAll: () => [preview, icon] });
      assert.equal(upgraded, 1, "only the preview was upgraded");
      assert.equal(preview.src, fullUrl, "and it now points at the original");
      assert.equal(icon.src, "/assets/icons/mail.svg", "the icon was untouched");
    } finally {
      globalThis.Image = saved;
    }
  });
});
