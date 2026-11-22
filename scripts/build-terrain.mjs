// One-off: builds the compact island heightmap in public/terrain/ from Moris 3D's
// 30 m grid (Copernicus DEM GLO-30 + Land Drainage Authority MNT 2021).
//
//   node scripts/build-terrain.mjs [path/to/mauritius-elevations/web/public/data]
//
// Output: heights.bin (gzip, row-delta, byte-planes, uint16 decimetres, same
// encoding as Moris 3D) and meta.json (grid size, cell size, projection).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";

const SRC = process.argv[2] ?? join(homedir(), "Projects/github.com/MrSunshyne/mauritius-elevations/web/public/data");
const OUT = new URL("../public/terrain/", import.meta.url);
const FACTOR = 3; // 30 m -> 90 m

const meta = JSON.parse(await readFile(join(SRC, "meta.json"), "utf8"));
const heights = decodeHeights(gunzipSync(await readFile(join(SRC, "heights.bin"))), meta);

const W = Math.floor(meta.width / FACTOR);
const H = Math.floor(meta.height / FACTOR);
const out = new Float32Array(W * H);
for (let r = 0; r < H; r++) {
  for (let c = 0; c < W; c++) {
    // Box filter, but keep a block as land if most of it is land, so the coast stays crisp.
    let sum = 0;
    let land = 0;
    let landSum = 0;
    for (let dr = 0; dr < FACTOR; dr++) {
      for (let dc = 0; dc < FACTOR; dc++) {
        const v = heights[(r * FACTOR + dr) * meta.width + c * FACTOR + dc];
        sum += v;
        if (v > 0.3) {
          land++;
          landSum += v;
        }
      }
    }
    const n = FACTOR * FACTOR;
    out[r * W + c] = land * 2 > n ? landSum / land : Math.min(sum / n, 0);
  }
}

const scale = 0.1;
const offset = -10;
const q = new Uint16Array(W * H);
let max = 0;
for (let i = 0; i < q.length; i++) {
  q[i] = Math.max(0, Math.min(0xffff, Math.round((out[i] - offset) / scale)));
  max = Math.max(max, out[i]);
}
// Row-delta, then low bytes followed by high bytes: compresses far better than raw uint16.
const n = W * H;
const bytes = new Uint8Array(n * 2);
for (let r = 0; r < H; r++) {
  let prev = 0;
  for (let c = 0; c < W; c++) {
    const i = r * W + c;
    const d = c === 0 ? q[i] : (q[i] - prev) & 0xffff;
    prev = q[i];
    bytes[i] = d & 0xff;
    bytes[n + i] = d >> 8;
  }
}
const packed = gzipSync(bytes, { level: 9 });

await mkdir(OUT, { recursive: true });
await writeFile(new URL("heights.bin", OUT), packed);
await writeFile(
  new URL("meta.json", OUT),
  JSON.stringify(
    {
      source: "Copernicus DEM GLO-30 + Land Drainage Authority MNT 2021, via Moris 3D (https://moris3d.ramgolam.com)",
      crs: meta.crs,
      width: W,
      height: H,
      cellSize: meta.cellSize * FACTOR,
      originUtm: meta.originUtm,
      encoding: "gzip,row-delta,byte-planes",
      heightScale: scale,
      heightOffset: offset,
      maxElevation: Math.round(max * 10) / 10,
      projection: { fromLonLat: meta.projection.fromLonLat, toLonLat: meta.projection.toLonLat },
    },
    null,
    2,
  ) + "\n",
);
console.log(`${W}x${H} at ${meta.cellSize * FACTOR} m, ${(packed.length / 1024).toFixed(0)} KB, max ${max.toFixed(1)} m`);

// Same as decodeHeights() in mauritius-elevations/web/app/engine/terrain.js.
function decodeHeights(bytes, { width: W, height: H, heightScale, heightOffset }) {
  const n = W * H;
  const res = new Float32Array(n);
  for (let r = 0; r < H; r++) {
    let v = 0;
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const d = bytes[i] | (bytes[n + i] << 8);
      v = c === 0 ? d : (v + d) & 0xffff;
      res[i] = v * heightScale + heightOffset;
    }
  }
  return res;
}
