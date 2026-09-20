/**
 * Progressive image loading: a light preview first, the original afterwards.
 *
 * The scene builders receive `resolveAsset` as a parameter, so progressiveness is
 * injected the same way — by wrapping that resolver. Nothing in the rendering code
 * has to know about it: the wrapper hands out preview URLs and remembers the original
 * behind each one.
 *
 * Order matters more than it looks. The canvas zooms up to 4x, and a preview built
 * for a 372px card smears badly at that size, so whatever the viewer is looking at
 * has to arrive first: upgrades are sorted by how large the image currently is on
 * screen, and zooming re-sorts the queue.
 */
import { LOW_RES_IMAGES } from "../../shared/lowResImages.js";

/** preview URL → original URL, filled in as the scene resolves its assets. */
const ORIGINALS = new Map();
/** Images already being upgraded, so a re-sort never fetches them twice. */
const INFLIGHT = new WeakSet();

/**
 * The preview URL for a resolved asset URL, if that asset has one.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function previewUrlFor(url) {
  if (typeof url !== "string") return null;
  const marker = "/assets/";
  const at = url.lastIndexOf(marker);
  if (at < 0) return null;

  const preview = LOW_RES_IMAGES[url.slice(at + marker.length)];
  return preview ? url.slice(0, at + marker.length) + preview : null;
}

/**
 * Wraps a resolver so it hands out light previews where they exist.
 *
 * @param {(key: string, options?: object) => string} resolve
 * @returns {(key: string, options?: object) => string}
 */
export function withProgressiveAssets(resolve) {
  return (key, options) => {
    const full = resolve(key, options);
    const preview = previewUrlFor(full);
    if (!preview) return full;

    ORIGINALS.set(preview, full);
    return preview;
  };
}

/** How much of the viewport an image covers right now; 0 when off-screen. */
function visibleArea(img) {
  const rect = img.getBoundingClientRect();
  const width = Math.min(rect.right, innerWidth) - Math.max(rect.left, 0);
  const height = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

const stillPreview = (img) =>
  ORIGINALS.has(img.getAttribute("src")) && !INFLIGHT.has(img);

/**
 * Loads one original and swaps it in once decoded.
 *
 * @param {HTMLImageElement} img
 * @param {"high"|"low"} priority
 * @returns {Promise<number>} 1 when the image was upgraded
 */
function upgrade(img, priority) {
  const full = ORIGINALS.get(img.getAttribute("src"));
  if (!full) return Promise.resolve(0);
  INFLIGHT.add(img);

  return new Promise((resolve) => {
    const probe = new Image();
    probe.fetchPriority = priority;
    probe.onload = () => {
      // Decode before swapping, otherwise the change lands as a flicker.
      const decoded = typeof probe.decode === "function" ? probe.decode() : null;
      const apply = () => {
        img.setAttribute("src", full);
        resolve(1);
      };
      if (decoded) decoded.then(apply, apply);
      else apply();
    };
    probe.onerror = () => resolve(0); // the preview stays, which is fine
    probe.src = full;
  });
}

/**
 * Replaces previews with originals, largest on screen first.
 *
 * @param {ParentNode} [root]
 * @returns {Promise<number>} how many images were upgraded
 */
export function upgradeImages(root = document) {
  const pending = Array.from(root.querySelectorAll?.("img") ?? []).filter(stillPreview);

  // What the viewer is actually looking at goes first, and goes with priority.
  const ordered = pending
    .map((img) => ({ img, area: visibleArea(img) }))
    .sort((a, b) => b.area - a.area);

  return Promise.all(
    ordered.map(({ img, area }) => upgrade(img, area > 0 ? "high" : "low")),
  ).then((results) => results.reduce((sum, n) => sum + n, 0));
}

/**
 * Re-prioritises upgrades as the viewer zooms and pans.
 *
 * A preview that was fine at 1x becomes visibly soft at 4x, so an image that grows
 * past the size its preview was built for is fetched straight away instead of waiting
 * its turn in the queue.
 *
 * @param {{ root?: ParentNode, previewWidth?: number }} [options]
 * @returns {() => void} stop watching
 */
export function watchZoom({ root = document, previewWidth = 744 } = {}) {
  if (typeof window === "undefined") return () => {};

  let scheduled = false;
  const review = () => {
    scheduled = false;
    const images = Array.from(root.querySelectorAll?.("img") ?? []).filter(stillPreview);
    for (const img of images) {
      const rect = img.getBoundingClientRect();
      const needed = rect.width * (window.devicePixelRatio || 1);
      if (needed > previewWidth && visibleArea(img) > 0) upgrade(img, "high");
    }
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(review);
  };

  // Zoom and pan both end up as transforms, so watching input is enough.
  const events = ["wheel", "pointerup", "keyup", "resize"];
  for (const type of events) window.addEventListener(type, schedule, { passive: true });
  schedule();

  return () => {
    for (const type of events) window.removeEventListener(type, schedule);
  };
}
