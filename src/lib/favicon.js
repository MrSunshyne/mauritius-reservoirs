// The site's icon: a water drop filled to a level, like the gauges on the map.
// `scripts/build-icons.mjs` writes the static files from it; the page then swaps
// the tab icon for one filled to the latest island total.

const WATER = "#4aa8e0";
const EMPTY = "#0a0a0a";
// Tip at the top, round at the bottom; fills y = 2 to 30 of a 32 × 32 box.
const DROP = "M16 2C16 2 6 13.4 6 20a10 10 0 0 0 20 0C26 13.4 16 2 16 2Z";

// Half-width of the drop at height y: a cone from the tip (y = 2) to where it
// meets the r = 10 circle round (16, 20) tangentially (y ≈ 14.4), then the circle.
function halfWidth(y) {
  const tangentY = 20 - 100 / 18;
  if (y <= 2) return 0;
  if (y < tangentY) return ((y - 2) / (tangentY - 2)) * 10 * Math.sqrt(1 - (10 / 18) ** 2);
  return Math.sqrt(Math.max(0, 100 - (y - 20) ** 2));
}

// Area of the drop below height y (y grows downwards), by the midpoint rule.
function areaBelow(y) {
  let a = 0;
  for (let s = Math.max(2, y); s < 30; s += 0.1) a += 2 * halfWidth(s + 0.05) * 0.1;
  return a;
}
const TOTAL = areaBelow(2);

/**
 * SVG markup of the drop with its water at `percent` (0–100) of its area, so a
 * half-full drop looks half full rather than filled to half its height.
 * With a `background`, the drop shrinks to leave a margin, for app icons that the
 * system rounds or masks.
 */
export function dropSvg(percent, { background } = {}) {
  const target = (Math.min(100, Math.max(0, percent)) / 100) * TOTAL;
  let lo = 2, hi = 30; // the water line lies between the tip and the bottom
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (areaBelow(mid) > target) lo = mid; else hi = mid;
  }
  const level = hi.toFixed(2);
  const drop = `<clipPath id="d"><path d="${DROP}"/></clipPath>`
    + `<path d="${DROP}" fill="${EMPTY}"/>`
    + `<rect x="0" y="${level}" width="32" height="32" fill="${WATER}" clip-path="url(#d)"/>`
    + `<path d="${DROP}" fill="none" stroke="${WATER}" stroke-width="2" stroke-linejoin="round"/>`;
  const body = background
    ? `<rect width="32" height="32" fill="${background}"/><g transform="translate(5.6 5.6) scale(0.65)">${drop}</g>`
    : drop;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`;
}

/** Point the tab icon at a drop filled to `percent`. */
export function setFavicon(percent) {
  let link = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    document.head.append(link);
  }
  link.href = `data:image/svg+xml,${encodeURIComponent(dropSvg(percent))}`;
}
