// Loads the island heightmap built by scripts/build-terrain.mjs (90 m grid,
// Copernicus DEM GLO-30 + Land Drainage Authority MNT 2021, via Moris 3D).
//
// Local coordinates are metres from the grid's north-west corner: x grows east, y grows south.

const BASE = import.meta.env.BASE_URL + "terrain/";

export async function loadTerrain() {
  const [meta, packed, outlines] = await Promise.all([
    fetch(BASE + "meta.json").then(ok).then((r) => r.json()),
    fetch(BASE + "heights.bin").then(ok).then((r) => r.arrayBuffer()),
    fetch(BASE + "outlines.json").then(ok).then((r) => r.json()),
  ]);
  const bytes = await gunzip(packed);
  return { meta, heights: decodeHeights(bytes, meta), outlines, fromLonLat: (lon, lat) => fromLonLat(meta, lon, lat) };
}

function ok(res) {
  if (!res.ok) throw new Error(`${res.url}: HTTP ${res.status}`);
  return res;
}

async function gunzip(buffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeHeights(bytes, { width: W, height: H, heightScale, heightOffset }) {
  const n = W * H;
  const out = new Float32Array(n);
  for (let r = 0; r < H; r++) {
    let v = 0;
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const d = bytes[i] | (bytes[n + i] << 8);
      v = c === 0 ? d : (v + d) & 0xffff;
      out[i] = v * heightScale + heightOffset;
    }
  }
  return out;
}

// Polynomial fit of the UTM 40S projection over the island, from Moris 3D's meta.json.
function fromLonLat(meta, lon, lat) {
  const p = meta.projection.fromLonLat;
  const u = lon - p.lonOrigin;
  const v = lat - p.latOrigin;
  const f = (c) => c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v;
  return { x: f(p.x), y: f(p.y) };
}

// Distance in cells from every cell to the nearest land cell (two-pass chamfer).
export function landDistance(heights, W, H) {
  const d = new Float32Array(W * H);
  const BIG = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = heights[i] > 0.3 ? 0 : BIG;
  const D = Math.SQRT2;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      let v = d[i];
      if (c > 0) v = Math.min(v, d[i - 1] + 1);
      if (r > 0) {
        v = Math.min(v, d[i - W] + 1);
        if (c > 0) v = Math.min(v, d[i - W - 1] + D);
        if (c < W - 1) v = Math.min(v, d[i - W + 1] + D);
      }
      d[i] = v;
    }
  }
  for (let r = H - 1; r >= 0; r--) {
    for (let c = W - 1; c >= 0; c--) {
      const i = r * W + c;
      let v = d[i];
      if (c < W - 1) v = Math.min(v, d[i + 1] + 1);
      if (r < H - 1) {
        v = Math.min(v, d[i + W] + 1);
        if (c < W - 1) v = Math.min(v, d[i + W + 1] + D);
        if (c > 0) v = Math.min(v, d[i + W - 1] + D);
      }
      d[i] = v;
    }
  }
  return d;
}
