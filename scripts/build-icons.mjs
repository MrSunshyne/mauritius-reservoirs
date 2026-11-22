// Writes public/favicon.svg (the drop half full, before the data loads) and the
// SVG for the 180 px Apple touch icon, which has a solid background because iOS
// rounds the corners itself. Rasterise apple-touch-icon.svg to PNG with any tool.
//   node scripts/build-icons.mjs
import { writeFileSync } from "node:fs";
import { dropSvg } from "../src/lib/favicon.js";

writeFileSync(new URL("../public/favicon.svg", import.meta.url), dropSvg(50) + "\n");
writeFileSync(new URL("../public/apple-touch-icon.svg", import.meta.url), dropSvg(50, { background: "#0a0a0a" }) + "\n");
