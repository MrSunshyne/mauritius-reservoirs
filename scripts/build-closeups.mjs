// One-off: cuts a block of the Land Drainage Authority's 1 m terrain (MNT 2021, via
// Moris 3D) around each reservoir, for the close-up view. Writes public/closeups/<id>.bin
// and public/closeups/index.json.
//
//   node scripts/build-closeups.mjs [path/to/mauritius-elevations/web/public/data/meta.json]
//
// The terrain is Moris 3D's fine.bin (format: mauritius-elevations/pipeline/fine_format.py),
// read with HTTP range requests from its public R2 parts. Its CORS headers only allow
// Moris 3D, so the site can't read it directly: the blocks are cut here, once.
//
// Output per lake: heights in decimetres as uint16 (offset -100 m), row-delta coded, low
// bytes then high bytes, gzipped: the same encoding as public/terrain/heights.bin.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync, zstdDecompressSync } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";

const MORIS = process.argv[2] ?? join(homedir(), "Projects/github.com/MrSunshyne/mauritius-elevations/web/public/data/meta.json");
const OUT = new URL("../public/closeups/", import.meta.url);
// At most ~2300 x 2300 cells: one texture's worth of detail, and well under 3 MB once
// compressed (heights at 1-2 m are smooth, so they pack to well under a byte a cell).
const MAX_CELLS = 5.3e6;
const HEADER_SIZE = 4096;

const moris = JSON.parse(await readFile(MORIS, "utf8"));
const fine = moris.fine;
const terrain = JSON.parse(await readFile(new URL("../public/terrain/meta.json", import.meta.url), "utf8"));
const outlines = JSON.parse(await readFile(new URL("../public/terrain/outlines.json", import.meta.url), "utf8"));

// Local metres of the island grid (x east, y south from its north-west corner).
const [ox0, oy0] = terrain.originUtm;
const fineX = fine.originUtm[0] - ox0;
const fineY = oy0 - fine.originUtm[1];

async function readBytes(offset, length) {
  const out = new Uint8Array(length);
  let done = 0;
  while (done < length) {
    const at = offset + done;
    const part = Math.floor(at / fine.partSize);
    const start = at - part * fine.partSize;
    const n = Math.min(length - done, fine.partSize - start);
    const res = await fetch(fine.parts[part], { headers: { Range: `bytes=${start}-${start + n - 1}` } });
    if (res.status !== 206) throw new Error(`${fine.parts[part]}: HTTP ${res.status}`);
    out.set(new Uint8Array(await res.arrayBuffer()), done);
    done += n;
  }
  return out;
}

const head = await readBytes(0, HEADER_SIZE);
const headerLength = new DataView(head.buffer).getUint32(8, true);
const header = JSON.parse(new TextDecoder().decode(head.subarray(12, 12 + headerLength)));
const TILE = header.tileSize;
const offsetsCache = new Map();

async function tileOffsets(level) {
  if (!offsetsCache.has(level)) {
    const count = level.tilesX * level.tilesY;
    const sizes = await readBytes(level.index, 4 * count);
    const dv = new DataView(sizes.buffer);
    const out = new Float64Array(count + 1);
    out[0] = level.data;
    for (let k = 0; k < count; k++) out[k + 1] = out[k] + dv.getUint32(4 * k, true);
    offsetsCache.set(level, out);
  }
  return offsetsCache.get(level);
}

// Inverse of encode_tile() in fine_format.py. Cells without data were filled from their
// nearest neighbour when the file was built, which is what we want under the lakes.
function decodeTile(blob) {
  const cells = TILE * TILE;
  const raw = zstdDecompressSync(blob.subarray(1));
  const v = new Int16Array(cells);
  for (let r = 0; r < TILE; r++) {
    let west = 0;
    let northWest = 0;
    for (let c = 0; c < TILE; c++) {
      const i = r * TILE + c;
      const z = raw[i] | (raw[cells + i] << 8);
      const north = r > 0 ? v[i - TILE] : 0;
      v[i] = ((z >>> 1) ^ -(z & 1)) + west + north - northWest;
      west = v[i];
      northWest = north;
    }
  }
  return v;
}

function fromLonLat(lon, lat) {
  const p = terrain.projection.fromLonLat;
  const u = lon - p.lonOrigin;
  const v = lat - p.latOrigin;
  const f = (c) => c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v;
  return { x: f(p.x), y: f(p.y) };
}

await mkdir(OUT, { recursive: true });
const index = [];
for (const feature of outlines.features) {
  const id = feature.properties.id;
  const pts = feature.geometry.coordinates[0].map(([lon, lat]) => fromLonLat(lon, lat));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // A square around the lake with room for its banks and dam: 15 % of its size on each side, at least 250 m.
  const span = Math.max(maxX - minX, maxY - minY);
  const side = span + 2 * Math.max(250, span * 0.15);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // Finest pyramid level that keeps the block under MAX_CELLS: 1 m for small lakes, 2 m for the big ones.
  const level = header.levels.find((l) => (side / l.cellSize) ** 2 <= MAX_CELLS) ?? header.levels.at(-1);
  const res = level.cellSize;
  const n = Math.round(side / res);
  const c0 = Math.round((cx - side / 2 - fineX) / res);
  const r0 = Math.round((cy - side / 2 - fineY) / res);
  const offsets = await tileOffsets(level);

  const heights = new Float32Array(n * n);
  const tiles = new Map();
  for (let ty = Math.floor(r0 / TILE); ty <= Math.floor((r0 + n - 1) / TILE); ty++) {
    for (let tx = Math.floor(c0 / TILE); tx <= Math.floor((c0 + n - 1) / TILE); tx++) {
      const k = ty * level.tilesX + tx;
      const length = offsets[k + 1] - offsets[k];
      tiles.set(k, length ? decodeTile(await readBytes(offsets[k], length)) : null);
    }
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const gr = r0 + r;
      const gc = c0 + c;
      const t = tiles.get(Math.floor(gr / TILE) * level.tilesX + Math.floor(gc / TILE));
      heights[r * n + c] = t ? t[(gr % TILE) * TILE + (gc % TILE)] * level.step : 0;
    }
  }

  // uint16 decimetres from -100 m, row-delta, byte planes, gzip.
  const cells = n * n;
  const bytes = new Uint8Array(cells * 2);
  for (let r = 0; r < n; r++) {
    let prev = 0;
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const q = Math.max(0, Math.min(0xffff, Math.round((heights[i] + 100) * 10)));
      const d = c === 0 ? q : (q - prev) & 0xffff;
      prev = q;
      bytes[i] = d & 0xff;
      bytes[cells + i] = d >> 8;
    }
  }
  const packed = gzipSync(bytes, { level: 9 });
  await writeFile(new URL(`${id}.bin`, OUT), packed);
  // x0, y0: the north-west corner of the block in the island grid's local metres.
  index.push({ id, res, size: n, x0: fineX + c0 * res, y0: fineY + r0 * res, heightScale: 0.1, heightOffset: -100, bytes: packed.length });
  console.log(`${id}: ${(n * res / 1000).toFixed(2)} km square at ${res} m, ${n}x${n}, ${(packed.length / 1e6).toFixed(2)} MB`);
}

await writeFile(
  new URL("index.json", OUT),
  JSON.stringify({ source: "Land Drainage Authority MNT 2021 (1 m), via Moris 3D (https://moris3d.ramgolam.com)", encoding: "gzip,row-delta,byte-planes", blocks: index }, null, 2) + "\n",
);
