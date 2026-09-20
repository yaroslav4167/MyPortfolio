/**
 * Real page-loading progress: images, fonts and network activity.
 *
 * The catch on this page is that the bundle builds most of the DOM after the
 * loader has already started. At subscribe time there are no images yet — only
 * the preload links. So the watched set is rebuilt every frame, and readiness is
 * judged mainly by network silence: `load` can be held back indefinitely by the
 * analytics beacon, so it counts as a hint, never as a requirement.
 *
 * A warm cache takes a shortcut: if everything is already in place within
 * `fastPathMs`, readiness is reported at once instead of waiting out the silence
 * window — that is what lets a repeat visit skip the animation entirely.
 */

/**
 * Whether this visit is served from cache.
 *
 * A cached navigation and cached sub-resources both report `transferSize: 0`,
 * and that is known before a single frame is drawn — early enough to decide
 * against showing the animation at all.
 *
 * @returns {boolean}
 */
export function isCachedVisit() {
  if (typeof performance?.getEntriesByType !== "function") return false;

  const nav = performance.getEntriesByType("navigation")[0];
  if (nav && nav.transferSize === 0) return true;

  // The document itself may be uncacheable while everything around it is not.
  const assets = performance
    .getEntriesByType("resource")
    .filter((e) => /\.(js|css)(\?|$)/.test(e.name));
  return assets.length >= 2 && assets.every((e) => e.transferSize === 0);
}

/** Assets the page requests only once it creates the matching elements. */
export const PRELOAD_PATHS = Object.freeze([
  "icons/arrow-left.svg",
  "icons/arrow-right.svg",
  "icons/behance.svg",
  "icons/burger-menu.svg",
  "icons/close.svg",
  "icons/cursor-figma.png",
  "icons/cv.svg",
  "icons/linkedin.svg",
  "icons/mail.svg",
  "icons/minus-hover.svg",
  "icons/minus.svg",
  "icons/plus-hover.svg",
  "icons/plus.svg",
  "icons/telegram.svg",
  "images/avatar.png",
  "images/card-citybike.png",
  "images/card-default.png",
  "images/case-dragon-hero.png",
  "images/comp.png",
  "images/dragon.png",
  "images/img-1.png",
  "images/img-2.png",
  "images/img-3.png",
  "images/img-bg.png",
  "images/macbook-248-17115.png",
  "images/macbook-lid.png",
  "images/me.png",
  "images/phish.png",
  "images/stickers/anime.png",
  "images/stickers/anime.svg",
  "images/stickers/books.png",
  "images/stickers/books.svg",
  "images/stickers/create.png",
  "images/stickers/create.svg",
  "images/stickers/question.png",
  "images/stickers/question.svg",
  "images/stickers/seal.png",
  "images/stickers/seal.svg",
  "images/stickers/sport.png",
  "images/stickers/sport.svg",
]);

/**
 * Base these paths resolve against: .../ds-showcase/assets/
 *
 * @param {string} [pathname]
 * @returns {string}
 */
export function assetBase(pathname = location.pathname) {
  const root = pathname.replace(/\/portfolio\/[^/]*$/, "/");
  return `${root}ds-showcase/assets/`;
}

/**
 * @param {(progress: number) => void} onProgress called every frame, monotonic
 * @param {{
 *   preload?: string[], timeout?: number, idleAfter?: number,
 *   minWait?: number, minTotal?: number, imageGrace?: number,
 * }} [options]
 * @returns {() => void} stop watching
 */
export function trackAssets(onProgress, {
  preload = [],
  timeout = 15000,
  idleAfter = 1200,
  minWait = 600,
  minTotal = 8,
  imageGrace = 2500,
  fastPathMs = 600,
  fastIdleAfter = 180,
} = {}) {
  const startedAt = performance.now();
  let progress = 0;
  let warmed = 0;
  let stopped = false;
  let loaded = false;
  let fontsReady = false;
  let lastActivity = startedAt;
  let settledAt = 0;

  // Warm the cache up front: some images are only requested once the loader is
  // gone, so they cannot be awaited — but they can be ready by then. The page's
  // own preload links join the list: on a repeat visit they settle instantly and
  // let the fast path fire.
  const warmUrls = new Set(preload);
  for (const link of document.querySelectorAll?.('link[rel="preload"][as="image"]') ?? []) {
    if (link.href) warmUrls.add(link.href);
  }
  preload = Array.from(warmUrls);

  for (const url of preload) {
    const probe = new Image();
    const tick = () => {
      warmed++;
      lastActivity = performance.now();
    };
    // `complete` only means the bytes arrived; decoding still happens on first
    // paint, which is exactly the flicker this warm-up is meant to avoid.
    const settle = () => {
      const decoded = typeof probe.decode === "function" ? probe.decode() : null;
      if (decoded) decoded.then(tick, tick);
      else tick();
    };
    probe.onload = settle;
    probe.onerror = tick;
    probe.src = url;
    if (probe.complete) settle();
  }

  const onLoad = () => { loaded = true; };
  window.addEventListener("load", onLoad, { once: true });
  if (document.readyState === "complete") loaded = true;

  const fonts = document.fonts?.ready ?? Promise.resolve();
  const markFonts = () => { fontsReady = true; };
  fonts.then(markFonts, markFonts);

  // CSS background images never show up in document.images, so they are tracked
  // through resource timing instead.
  let observer = null;
  if (typeof PerformanceObserver === "function") {
    try {
      observer = new PerformanceObserver(() => { lastActivity = performance.now(); });
      observer.observe({ type: "resource", buffered: true });
    } catch {
      observer = null; // older browser — network silence is simply not watched
    }
  }

  function measure(now) {
    // Lazy images may never be fetched at all; waiting on them is pointless.
    const images = Array.from(document.images ?? []).filter((img) => img.loading !== "lazy");
    const ready = images.filter((img) => img.complete).length;
    const elapsed = now - startedAt;

    // Everything already in place this early means a warm cache: report ready
    // right away so the loader can skip the animation instead of holding the
    // page back for the silence window.
    // Only meaningful when there is a warm-up list to judge by: without it an
    // early quiet moment says nothing about what the page will request next.
    if (
      preload.length > 0 &&
      elapsed < fastPathMs &&
      fontsReady &&
      warmed >= preload.length &&
      ready === images.length &&
      now - lastActivity >= fastIdleAfter
    ) {
      return 1;
    }

    // While the page is still empty the denominator is padded, otherwise the
    // counter would hit 100% before the site orders its first image.
    const total = Math.max(minTotal, images.length + 2) + preload.length;
    const done = ready + (fontsReady ? 1 : 0) + (loaded ? 1 : 0) + warmed;

    const quiet = !observer || now - lastActivity >= idleAfter;
    const settled = fontsReady && quiet && elapsed >= minWait && warmed >= preload.length;
    if (settled && !settledAt) settledAt = now;

    // Images added by script after `load` are awaited, but not forever: some may
    // be hidden and never finish.
    const waitedEnough = settledAt && now - settledAt >= imageGrace;
    const complete = settled && (ready === images.length || waitedEnough);

    // The last percent is exactly the time background images take to arrive.
    return complete ? 1 : Math.min(0.97, done / total);
  }

  let raf = requestAnimationFrame(function tick() {
    if (stopped) return;
    const now = performance.now();
    const value = now - startedAt >= timeout ? 1 : measure(now);

    progress = Math.max(progress, value);
    onProgress(progress);

    if (progress >= 1) {
      observer?.disconnect();
      return;
    }
    raf = requestAnimationFrame(tick);
  });

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    window.removeEventListener("load", onLoad);
  };
}
