/**
 * Dots boot loader wired into the page.
 *
 * The markup and CSS states already exist, so this module creates nothing: it
 * draws into the existing canvas, writes into the existing badge and flips the
 * existing classes.
 *
 *   .boot-loader            container, #f6f5f8 backdrop
 *   .boot-loader__canvas    animation canvas
 *   .boot-loader__pct       percent badge
 *   html.is-boot-slow       reveals canvas and badge
 *   .is-fading-badge        fades the badge out
 *   .is-forming-grid        drops the backdrop so the page shows through
 *   .is-done                dissolves the loader
 *
 * A detail of the existing CSS: while `html.is-booting` is set without
 * `is-boot-slow`, both canvas and badge are hidden. That is deliberate — a fast
 * load shows no animation at all. This module honours it: it stays quiet until
 * the threshold, and if assets arrive first it skips straight to the page.
 */
import { createDotsScene } from "./boot/dots/scene.js";
import { readSiteGrid } from "./boot/dots/siteGrid.js";
import { trackAssets, isCachedVisit, PRELOAD_PATHS, assetBase } from "./boot/dots/assets.js";
import { INFINITE_BG } from "./infiniteBg.js";

const BADGE_SIZE = 100;
const BADGE_GAP = 18;

/** Loader palette and geometry, tuned to the site. */
export const DOTS_BOOT_CONFIG = Object.freeze({
  // The final grid matches the site's own dotted background one to one.
  cell: INFINITE_BG.worldPeriod,
  gridOffsetX: INFINITE_BG.worldPad + INFINITE_BG.worldDotRadius,
  gridOffsetY: INFINITE_BG.worldPad + INFINITE_BG.worldDotRadius,
  gridDotRadius: INFINITE_BG.worldDotRadius,
  colorGrid: 0xe4,

  // Rings get their own step: sharing the grid's density would fuse them into a
  // solid fill. The missing dots are born during the blast.
  ringStep: 11,
  dotRadius: 2.6,
  dotRadiusEdgeRatio: 0.5,

  // The badge sits in the middle, so the rings start outside it.
  ringsInnerRadius: BADGE_SIZE / 2 + BADGE_GAP,
  ringsRadiusRatio: 0.34,

  // --color-black / --color-gray-dark from the design system.
  colorDark: 0x23,
  colorLight: 0xe4,
  dotAlphaCenter: 0.55,
  dotAlphaEdge: 0.08,
  dotAlphaStart: 0.4,

  background: "transparent",
  waveLength: 170,
  explodePush: 90,
  explodeFlare: 0,
  sizeSnap: 0.15,
  explodeFlash: 60,
  morphDuration: 900,
  morphStagger: 200,
});

/** Overrides for the dark theme: light dots on a dark backdrop. */
export const DOTS_BOOT_DARK = Object.freeze({
  colorDark: 0x8c,
  colorLight: 0xf6,
  colorGrid: 0x34,
  dotAlphaCenter: 0.8,
  dotAlphaEdge: 0.12,
  dotAlphaStart: 0.5,
  // The peak flare is a darkening — on a dark backdrop that sinks the dots.
  explodeFlash: -70,
});

/**
 * @param {{
 *   root?: HTMLElement|null, config?: object, dark?: boolean,
 *   revealTarget?: string|null, handOffTo?: string|null,
 *   fallbackGridTo?: string|null, fallbackClearBg?: string|null,
 *   alwaysShow?: boolean, slowAfter?: number, minShow?: number,
 *   reveal?: number, gridFade?: number, gridHold?: number, fadeOut?: number,
 *   onDone?: () => void,
 * }} [options]
 */
export function mountDotsBootLoader({
  root = document.querySelector("#boot-loader"),
  config,
  dark = false,
  revealTarget = null,
  handOffTo = null,
  fallbackGridTo = null,
  fallbackClearBg = null,
  alwaysShow = false,
  slowAfter = 600,
  minShow = 1300,
  reveal = 480,
  gridFade = 520,
  gridHold = 260,
  fadeOut = 260,
  onDone,
} = {}) {
  if (!root) return null;

  const canvas = root.querySelector(".boot-loader__canvas");
  const pct = root.querySelector(".boot-loader__pct");
  const html = document.documentElement;
  if (!canvas) return null;

  let raw = 0;
  let shown = false;
  let shownAt = 0;
  let finished = false;
  let handedOff = false;
  let synced = false;
  let styleTag = null;
  let slowTimer = 0;
  let holdTimer = 0;
  let fadeTimer = 0;
  let ticker = 0;

  const REVEAL_CLASS = "dots-loader-reveal";
  const nativeSelector = typeof handOffTo === "string" ? handOffTo : null;

  const scene = createDotsScene(canvas, {
    transparent: true,
    config: { ...DOTS_BOOT_CONFIG, ...(dark ? DOTS_BOOT_DARK : null), ...config },
    onProgress(p) {
      if (pct) pct.textContent = `${Math.floor(p * 100)}%`;
    },
    onMorphStart() {
      root.classList.add("is-fading-badge");
    },
    onComplete() {
      // Last chance to read the live grid: its element is created by the site
      // after the loader starts and may have appeared only now. Repaint while
      // the opaque backdrop still hides the grid.
      if (syncToSiteGrid()) scene.repaint();

      // Content appears AFTER the animation: the backdrop only leaves now, so
      // neither the rings nor the blast ever run over the cards.
      root.classList.add("is-forming-grid");

      const finishUp = () => {
        handOff();
        revealContent();
        holdTimer = setTimeout(dismiss, gridHold);
      };

      holdTimer = setTimeout(() => {
        // With the site's grid in place ours leaves instantly — an identical
        // copy lies underneath, so the swap is invisible. If its parameters
        // could not be read, showing ours is worse still: two mismatched grids.
        if (nativeGrid()) {
          finishUp();
          return;
        }
        // No native grid at all (mobile layout): paint one ourselves and
        // dissolve the canvas over it, so the dots stay as a backdrop.
        paintFallbackGrid();
        fadeOutGrid(finishUp);
      }, reveal);
    },
  });

  const isHidden = (el) =>
    typeof getComputedStyle === "function" && getComputedStyle(el).display === "none";

  /** The site's live grid, if there is one to hand over to. */
  function nativeGrid() {
    if (!handOffTo) return null;
    const el = typeof handOffTo === "string" ? document.querySelector(handOffTo) : handOffTo;
    return el && !isHidden(el) ? el : null;
  }

  const hostOf = (target) =>
    (typeof target === "string" ? document.querySelector(target) : target) ?? null;

  /**
   * Content is hidden with a CSS rule rather than inline styles: the site keeps
   * building `.viewport` after the loader starts — sidebar, scene background and
   * scrollbars appear later — and a rule covers those too. The native grid is
   * the one child left visible: it has to surface before the rest.
   */
  function hideContent() {
    if (typeof revealTarget !== "string" || styleTag) return;

    const keep = nativeSelector ? `:not(${nativeSelector})` : "";
    styleTag = document.createElement("style");
    styleTag.textContent = `
      ${revealTarget} > *${keep} {
        opacity: 0 !important;
        transition: opacity ${reveal}ms cubic-bezier(.22,.82,.18,1) !important;
      }
      ${revealTarget}.${REVEAL_CLASS} > *${keep} {
        opacity: 1 !important;
      }
    `;
    document.head.append(styleTag);
  }

  /** Reveals the content once the grid has settled underneath it. */
  function revealContent() {
    const host = hostOf(revealTarget);
    if (!host || !styleTag) return;

    host.classList.add(REVEAL_CLASS);
    setTimeout(() => {
      styleTag?.remove();
      styleTag = null;
      host.classList.remove(REVEAL_CLASS);
    }, reveal + 80);
  }

  /**
   * Paints the grid with a CSS gradient where the site draws none — the mobile
   * layout. Mirrors both our dots and the site's own technique.
   */
  function paintFallbackGrid() {
    const host = hostOf(fallbackGridTo);
    if (!host) return false;

    // The mobile sheet is kept hidden and shown later, and its fill is opaque.
    // Painting it would flash; instead paint the always-visible container and
    // strip the sheet's own fill.
    const opaque = hostOf(fallbackClearBg);
    if (opaque) {
      opaque.style.backgroundColor = "transparent";
      opaque.setAttribute("data-dots-clear-bg", "");
    }

    host.setAttribute("data-dots-grid-bg", "");

    const { cell, gridDotRadius: r, gridOffsetX, gridOffsetY, colorGrid } = scene.config;
    const dot = `rgb(${colorGrid}, ${colorGrid}, ${colorGrid})`;
    Object.assign(host.style, {
      backgroundImage: `radial-gradient(circle ${r}px at ${r}px ${r}px, ${dot} 99%, transparent 100%)`,
      backgroundSize: `${cell}px ${cell}px`,
      backgroundPosition: `${gridOffsetX - r}px ${gridOffsetY - r}px`,
      backgroundRepeat: "repeat",
    });
    return true;
  }

  /** Dissolves the grid where there is nothing underneath to take over. */
  function fadeOutGrid(done) {
    canvas.style.transition = `opacity ${gridFade}ms cubic-bezier(.22,.82,.18,1)`;
    void canvas.offsetHeight; // force a reflow, otherwise the transition is merged away
    canvas.style.opacity = "0";
    holdTimer = setTimeout(done, gridFade);
  }

  /**
   * Hands the grid over to the site's own. Ours is static while theirs pans with
   * the camera, so leaving both would show doubled dots of which only one moves.
   * The canvas is removed either way: it lies over the whole page.
   */
  function handOff() {
    if (handedOff) return;
    handedOff = true;
    canvas.remove();
    scene.destroy();
  }

  /**
   * Adapts the grid to the site's own. Its element appears after the loader
   * starts, so this retries every frame until it succeeds — but only before the
   * blast, after which retargeting is too late.
   */
  function syncToSiteGrid() {
    if (synced) return false;
    const native = nativeGrid();
    if (!native) return false;

    const params = readSiteGrid(native);
    if (!params) return false;

    synced = true;
    scene.reconfigure(params);
    return true;
  }

  function teardown() {
    html.classList.remove("is-booting", "is-boot-slow");
    root.hidden = true;
    scene.destroy();
    onDone?.();
  }

  function dismiss() {
    root.classList.add("is-done");
    fadeTimer = setTimeout(teardown, fadeOut);
  }

  /** The load fit within slowAfter — hand over the page without animating. */
  function skip() {
    if (finished) return;
    finished = true;
    clearTimeout(slowTimer);
    cancelAnimationFrame(ticker);
    dismiss();
  }

  function tick() {
    syncToSiteGrid();
    const elapsed = performance.now() - shownAt;
    // Progress never outruns minShow, or the animation flashes past unread.
    scene.setProgress(Math.min(raw, elapsed / minShow));
    if (scene.phase === "loading") ticker = requestAnimationFrame(tick);
  }

  function show() {
    if (finished || shown) return;
    shown = true;
    shownAt = performance.now();
    html.classList.add("is-boot-slow");
    root.classList.add("is-visible");
    hideContent();
    scene.start();
    ticker = requestAnimationFrame(tick);
  }

  const reducedMotion =
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) {
    finished = true;
    dismiss();
    return {
      setProgress() {},
      finish() {},
      get phase() { return "done"; },
      destroy() { clearTimeout(fadeTimer); },
    };
  }

  // alwaysShow is the bench mode: animate even when the page came from cache.
  if (alwaysShow) show();
  else slowTimer = setTimeout(show, slowAfter);

  return {
    /** Raw load progress, 0..1, monotonic. */
    setProgress(value) {
      if (finished) return;
      raw = Math.max(raw, Math.min(1, Math.max(0, value)));
      if (!shown && raw >= 1) skip();
    },
    /** Cut the load short: finish a running animation, otherwise skip it. */
    finish() {
      if (shown) raw = 1;
      else skip();
    },
    get phase() { return finished ? "done" : shown ? scene.phase : "pending"; },
    get synced() { return synced; },
    get handedOff() { return handedOff; },
    destroy() {
      clearTimeout(slowTimer);
      clearTimeout(holdTimer);
      clearTimeout(fadeTimer);
      cancelAnimationFrame(ticker);
      scene.destroy();
    },
  };
}

/**
 * Drop-in replacement for `runPortfolioBoot`: mounts the loader and drives it
 * from the real page load.
 *
 * @param {HTMLElement|null} _viewportEl kept for signature compatibility
 * @param {HTMLElement|null} [loaderEl]
 * @param {{ dark?: boolean }} [options]
 */
export async function runDotsBoot(_viewportEl, loaderEl, { dark = false } = {}) {
  if (typeof document === "undefined" || typeof window === "undefined") return;

  const root = loaderEl || document.getElementById("boot-loader");

  const cached = isCachedVisit();

  const loader = mountDotsBootLoader({
    root,
    dark,
    revealTarget: ".viewport",
    handOffTo: ".scene-infinite-bg",
    fallbackGridTo: ".viewport",
    fallbackClearBg: "#mobile-sheet",
    // A repeat visit has nothing to wait for, so the animation should not show
    // at all. The threshold is raised rather than disabled: if this particular
    // load turns out slow anyway, the rings still appear instead of a blank
    // page.
    slowAfter: cached ? 2600 : 600,
  });
  if (!loader) return;

  const base = assetBase();
  const stop = trackAssets((p) => loader.setProgress(p), {
    preload: PRELOAD_PATHS.map((path) => base + path),
    // Nothing is being fetched on a cached visit, so readiness should not wait
    // out the silence window — the fast path may fire as soon as warm-up ends.
    fastPathMs: cached ? 2500 : 600,
  });

  await new Promise((resolve) => {
    const done = () => {
      stop();
      resolve();
    };
    const timer = setInterval(() => {
      if (loader.phase === "done") {
        clearInterval(timer);
        done();
      }
    }, 120);
  });
}
