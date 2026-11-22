// The close-up: a cut-out block of the Land Drainage Authority's 1 m terrain (MNT 2021,
// via Moris 3D) around one reservoir, like a museum diorama: earth layers on the sides,
// a plinth, its own low sun and soft shadows. Blocks are cut offline at 1-2 m by
// scripts/build-closeups.mjs and loaded when a lake is opened.
//
// The basin is modelled the same way as on the island (see basins.js), on this
// block's own grid: depth grows with distance from the shore, scaled so the basin holds
// the official capacity. The mesh is coarser than the data; the full detail comes back
// through a normal map, a baked ambient-occlusion term and per-pixel colour.
import * as THREE from "three";
import { KM, toY, EXAG, LAND_STOPS, ROCK, BED_GLSL, levelCurve, lakeShapeGeometry } from "./common.js";
import { BASIN_EXAG, BASIN_SHAPE } from "../lib/model.js";
import { RING_M } from "./basins.js";

const BASE = import.meta.env.BASE_URL + "closeups/";
// Moris 3D's diorama: side layers as fractions of the block's width, the last runs to the base.
const STRATA = ["#5e4636", "#7f6249", "#9b7d60", "#736d66"].map((c) => new THREE.Color(c));
const LAYER_FRACTIONS = [0.006, 0.03, 0.07];
const BASE_FRAC = 0.1;
const CLOSE_SUN = new THREE.Vector3(-0.75, 0.42, -0.5).normalize(); // lower than the island's: it models the relief

export class CloseUp {
  constructor(core) {
    this.core = core;
    this.active = null;
    this.token = 0;
    this.index = null;
    this.rampTexture = rampTexture();

    const sun = new THREE.DirectionalLight("#fff3e2", 3.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(core.mobile ? 1024 : 2048, core.mobile ? 1024 : 2048);
    sun.visible = false;
    core.scene.add(sun, sun.target);
    this.sun = sun;
  }

  get id() {
    return this.active?.id ?? null;
  }

  // Resolves to the camera framing once the block is built, or null if another lake
  // was opened (or the close-up closed) in the meantime.
  async open(lake) {
    this.#teardown();
    const token = ++this.token;
    this.index ??= fetch(BASE + "index.json").then((r) => r.json());
    const meta = (await this.index).blocks.find((b) => b.id === lake.id);
    if (!meta) return null;
    const heights = await loadHeights(BASE + `${lake.id}.bin`, meta);
    if (token !== this.token) return null;
    const block = this.#build(lake, meta, heights);
    if (token !== this.token) {
      dispose(block.group);
      return null;
    }
    this.active = block;
    const core = this.core;
    core.scene.add(block.group);
    core.setIslandVisible(false);
    core.basins.setVisible(false);
    core.vials.isolate(lake.id);
    core.vials.place(lake.id, block.vialAt, block.vialScale);
    this.sun.visible = true;
    core.islandSun.visible = false;
    core.hemi.intensity = 0.65; // let the low sun model the relief
    this.setLevel(lake);
    core.dirty = true;
    return { target: block.center.clone(), distance: block.sizeKm * 1.45 };
  }

  close() {
    this.token++;
    this.#teardown();
  }

  setLevel(lake) {
    const a = this.active;
    if (!a || a.id !== lake.id) return;
    const s = lake.level;
    const h = s.known ? a.depthFor(s.current) : a.D;
    const y = toY(a.fullM - h * BASIN_EXAG);
    a.water.position.y = y;
    a.water.visible = s.known && s.current > 0.002;
    a.bedUniforms.uWater.value = s.known ? y : -1e3;
    a.waterUniforms.uH.value = h;
  }

  #teardown() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    const core = this.core;
    core.scene.remove(a.group);
    dispose(a.group);
    core.setIslandVisible(true);
    core.basins.setVisible(true);
    core.vials.isolate(null);
    core.vials.place(a.id, null);
    this.sun.visible = false;
    core.islandSun.visible = true;
    core.hemi.intensity = 1.1;
    core.dirty = true;
  }

  #build(lake, meta, heights) {
    const core = this.core;
    const n = meta.size;
    const res = meta.res;
    const cellKm = res * KM;
    const sizeKm = n * cellKm;
    const x0 = (meta.x0 - core.cx) * KM; // scene x of the block's west edge
    const z0 = (meta.y0 - core.cy) * KM; // scene z of its north edge

    // Lake mask by scanline: a cell is in the lake if its centre is inside the outline.
    const mask = new Uint8Array(n * n);
    const ring = lake.ring;
    for (let r = 0; r < n; r++) {
      const z = z0 + (r + 0.5) * cellKm;
      const xs = [];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i];
        const b = ring[j];
        if (a.y > z !== b.y > z) xs.push(a.x + ((z - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - x0) / cellKm - 0.5));
        const c1 = Math.min(n - 1, Math.floor((xs[k + 1] - x0) / cellKm - 0.5));
        for (let c = c0; c <= c1; c++) mask[r * n + c] = 1;
      }
    }

    // Distance from the shore, in cells (two-pass chamfer over the mask).
    const dist = chamfer(mask, n);
    let dmax = 0;
    for (let i = 0; i < n * n; i++) if (mask[i]) dmax = Math.max(dmax, dist[i]);

    // The full level: the median height along the shoreline.
    const shore = [];
    for (const p of ring) {
      const c = (p.x - x0) / cellKm - 0.5;
      const r = (p.y - z0) / cellKm - 0.5;
      if (c >= 0 && r >= 0 && c < n - 1 && r < n - 1) shore.push(bilinear(heights, n, c, r));
    }
    shore.sort((a, b) => a - b);
    const fullM = shore[shore.length >> 1];

    // Basin depth scaled so it holds the official capacity, and its level-volume curve.
    const cellArea = res * res;
    let sumF = 0;
    for (let i = 0; i < n * n; i++) if (mask[i]) sumF += Math.pow(dist[i] / dmax, BASIN_SHAPE);
    const D = (lake.capacity * 1e6) / (sumF * cellArea);
    const depths = new Float32Array(n * n);
    const lakeDepths = [];
    const Y = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) {
      const h = heights[i];
      Y[i] = toY(h);
      if (mask[i]) {
        depths[i] = D * Math.pow(dist[i] / dmax, BASIN_SHAPE);
        lakeDepths.push(depths[i]);
        Y[i] = Math.min(Y[i], toY(fullM - depths[i] * BASIN_EXAG));
      }
    }
    const depthFor = levelCurve(Float32Array.from(lakeDepths), cellArea, D);

    const { normalTex, dataTex } = this.#textures(n, res, cellKm, heights, Y, mask, depths, D);

    // The top surface: a grid coarser than the data, sampled from it.
    const N = core.mobile ? 256 : 512;
    const V = N + 1;
    const pos = new Float32Array(V * V * 3);
    const uv = new Float32Array(V * V * 2);
    let minY = Infinity;
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const k = j * V + i;
        const c = (i / N) * (n - 1);
        const r = (j / N) * (n - 1);
        const y = bilinear(Y, n, c, r);
        pos[k * 3] = x0 + (c + 0.5) * cellKm;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = z0 + (r + 0.5) * cellKm;
        uv[k * 2] = (c + 0.5) / n;
        uv[k * 2 + 1] = (r + 0.5) / n;
        minY = Math.min(minY, y);
      }
    }
    const index = new Uint32Array(N * N * 6);
    for (let j = 0, t = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * V + i;
        index.set([a, a + V, a + 1, a + 1, a + V, a + V + 1], t);
        t += 6;
      }
    }
    const topGeo = new THREE.BufferGeometry();
    topGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    topGeo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    topGeo.setIndex(new THREE.BufferAttribute(index, 1));
    topGeo.computeVertexNormals();

    const bedUniforms = {
      uWater: { value: -1e3 },
      uFull: { value: toY(fullM) },
      uRing: { value: toY(RING_M * BASIN_EXAG) },
      uDeep: { value: toY(D * BASIN_EXAG) * 0.6 },
    };
    const top = new THREE.Mesh(topGeo, terrainMaterial(normalTex, dataTex, this.rampTexture, bedUniforms));
    top.castShadow = top.receiveShadow = true;

    const baseY = minY - BASE_FRAC * sizeKm;
    const walls = wallsMesh(pos, V, N, sizeKm, baseY);
    walls.castShadow = walls.receiveShadow = true;
    const plinthT = 0.022 * sizeKm;
    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(sizeKm * 1.03, plinthT, sizeKm * 1.03),
      new THREE.MeshStandardMaterial({ color: "#262626", roughness: 0.7 }),
    );
    plinth.position.set(x0 + sizeKm / 2, baseY - plinthT / 2, z0 + sizeKm / 2);
    plinth.receiveShadow = true;

    const waterUniforms = {
      uTime: core.uniforms.uTime,
      uSun: { value: CLOSE_SUN },
      uData: { value: dataTex },
      uRect: { value: new THREE.Vector3(x0, z0, sizeKm) },
      uD: { value: D },
      uH: { value: 0 },
    };
    const water = new THREE.Mesh(lakeShapeGeometry(ring), waterMaterial(waterUniforms));
    water.renderOrder = 1;

    const group = new THREE.Group();
    group.add(top, walls, plinth, water);

    // The sun's shadow camera fits the block.
    const center = new THREE.Vector3(x0 + sizeKm / 2, toY(fullM), z0 + sizeKm / 2);
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(CLOSE_SUN, sizeKm * 3);
    const s = this.sun.shadow.camera;
    Object.assign(s, { left: -sizeKm * 0.8, right: sizeKm * 0.8, top: sizeKm * 0.8, bottom: -sizeKm * 0.8, near: sizeKm, far: sizeKm * 5 });
    s.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.0015 * sizeKm;

    // The vial stands on the bank beyond the lake (north-east), so it never hides the water.
    let vialAt = null;
    for (let k = 0; k < 24 && !vialAt; k++) {
      const a = -Math.PI / 4 + ((k % 2 ? 1 : -1) * Math.ceil(k / 2) * Math.PI) / 12; // from north-east outwards
      for (let d = lake.radius * 0.7; d < sizeKm / 2 - 0.1 && !vialAt; d += 0.05) {
        const x = lake.center.x + Math.cos(a) * d;
        const z = lake.center.z + Math.sin(a) * d;
        const c = (x - x0) / cellKm - 0.5;
        const r = (z - z0) / cellKm - 0.5;
        if (c < 4 || r < 4 || c > n - 5 || r > n - 5) break;
        // Clear of the lake by at least 60 m all round.
        const m = Math.ceil(60 / res);
        let clear = true;
        for (let dr = -m; dr <= m && clear; dr += Math.max(1, m >> 2)) for (let dc = -m; dc <= m && clear; dc += Math.max(1, m >> 2)) clear = !mask[Math.min(n - 1, Math.max(0, Math.round(r) + dr)) * n + Math.min(n - 1, Math.max(0, Math.round(c) + dc))];
        if (clear) vialAt = new THREE.Vector3(x, bilinear(Y, n, c, r), z);
      }
    }
    vialAt ??= new THREE.Vector3(x0 + sizeKm * 0.1, bilinear(Y, n, n * 0.1, n * 0.9), z0 + sizeKm * 0.9);

    return { id: lake.id, group, water, waterUniforms, bedUniforms, depthFor, D, fullM, center, sizeKm, vialAt, vialScale: Math.min(0.7, sizeKm * 0.11) };
  }

  // Object-space normals from the exaggerated heights, and a data texture: ambient
  // occlusion (R), lake mask (G), slope (B, 0-60 degrees) and basin depth / D (A).
  #textures(n, res, cellKm, heights, Y, mask, depths, D) {
    const nrm = new Uint8Array(n * n * 4);
    const data = new Uint8Array(n * n * 4);
    for (let r = 0; r < n; r++) {
      const ru = Math.max(0, r - 1);
      const rd = Math.min(n - 1, r + 1);
      for (let c = 0; c < n; c++) {
        const cl = Math.max(0, c - 1);
        const cr = Math.min(n - 1, c + 1);
        const i = r * n + c;
        const dx = (Y[r * n + cr] - Y[r * n + cl]) / ((cr - cl) * cellKm);
        const dz = (Y[rd * n + c] - Y[ru * n + c]) / ((rd - ru) * cellKm);
        const l = Math.hypot(dx, 1, dz);
        nrm[i * 4] = ((-dx / l) * 0.5 + 0.5) * 255;
        nrm[i * 4 + 1] = ((1 / l) * 0.5 + 0.5) * 255;
        nrm[i * 4 + 2] = ((-dz / l) * 0.5 + 0.5) * 255;
        nrm[i * 4 + 3] = 255;
        const sx = (heights[r * n + cr] - heights[r * n + cl]) / ((cr - cl) * res);
        const sz = (heights[rd * n + c] - heights[ru * n + c]) / ((rd - ru) * res);
        data[i * 4 + 1] = mask[i] ? 255 : 0;
        data[i * 4 + 2] = Math.min(255, (Math.atan(Math.hypot(sx, sz)) * (180 / Math.PI) * 255) / 60);
        data[i * 4 + 3] = mask[i] ? Math.min(255, (depths[i] / D) * 255) : 0;
      }
    }
    // Ambient occlusion from the horizon in 8 directions, on a grid a quarter as fine.
    const q = 4;
    const m = Math.ceil(n / q);
    const low = new Float32Array(m * m);
    for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) low[r * m + c] = Y[Math.min(n - 1, r * q) * n + Math.min(n - 1, c * q)];
    const ao = new Float32Array(m * m);
    const dirs = [];
    for (let k = 0; k < 8; k++) dirs.push([Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)]);
    const steps = [1, 2, 4, 8, 16, 32];
    const step = q * cellKm;
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) {
        const h0 = low[r * m + c];
        let occ = 0;
        for (const [dx, dz] of dirs) {
          let best = 0;
          for (const s of steps) {
            const cc = Math.round(c + dx * s);
            const rr = Math.round(r + dz * s);
            if (cc < 0 || rr < 0 || cc >= m || rr >= m) break;
            best = Math.max(best, (low[rr * m + cc] - h0) / (s * step * Math.hypot(dx, dz)));
          }
          occ += Math.atan(best) / (Math.PI / 2);
        }
        ao[r * m + c] = 1 - Math.min(1, (occ / 8) * 1.6);
      }
    }
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) data[(r * n + c) * 4] = bilinear(ao, m, c / q, r / q) * 255;

    const make = (arr) => {
      const t = new THREE.DataTexture(arr, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = this.core.renderer.capabilities.getMaxAnisotropy();
      t.needsUpdate = true;
      return t;
    };
    return { normalTex: make(nrm), dataTex: make(data) };
  }
}

async function loadHeights(url, meta) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const n = meta.size;
  const cells = n * n;
  const out = new Float32Array(cells);
  for (let r = 0; r < n; r++) {
    let v = 0;
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const d = bytes[i] | (bytes[cells + i] << 8);
      v = c === 0 ? d : (v + d) & 0xffff;
      out[i] = v * meta.heightScale + meta.heightOffset;
    }
  }
  return out;
}

function bilinear(arr, n, c, r) {
  const c0 = Math.max(0, Math.min(n - 1, Math.floor(c)));
  const r0 = Math.max(0, Math.min(n - 1, Math.floor(r)));
  const c1 = Math.min(n - 1, c0 + 1);
  const r1 = Math.min(n - 1, r0 + 1);
  const tx = Math.max(0, Math.min(1, c - c0));
  const ty = Math.max(0, Math.min(1, r - r0));
  const a = arr[r0 * n + c0] * (1 - tx) + arr[r0 * n + c1] * tx;
  const b = arr[r1 * n + c0] * (1 - tx) + arr[r1 * n + c1] * tx;
  return a * (1 - ty) + b * ty;
}

function chamfer(mask, n) {
  const d = new Float32Array(n * n);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 1e9 : 0;
  const S = Math.SQRT2;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (!d[i]) continue;
      let v = d[i];
      if (c > 0) v = Math.min(v, d[i - 1] + 1);
      if (r > 0) {
        v = Math.min(v, d[i - n] + 1);
        if (c > 0) v = Math.min(v, d[i - n - 1] + S);
        if (c < n - 1) v = Math.min(v, d[i - n + 1] + S);
      }
      d[i] = v;
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    for (let c = n - 1; c >= 0; c--) {
      const i = r * n + c;
      if (!d[i]) continue;
      let v = d[i];
      if (c < n - 1) v = Math.min(v, d[i + 1] + 1);
      if (r < n - 1) {
        v = Math.min(v, d[i + n] + 1);
        if (c < n - 1) v = Math.min(v, d[i + n + 1] + S);
        if (c > 0) v = Math.min(v, d[i + n - 1] + S);
      }
      d[i] = v;
    }
  }
  return d;
}

// Land colours by elevation, 0-850 m, as a 256 x 1 texture (linear values).
function rampTexture() {
  const data = new Uint8Array(256 * 4);
  const c = new THREE.Color();
  const stops = LAND_STOPS.map(([h, hex]) => [h, new THREE.Color(hex)]);
  for (let i = 0; i < 256; i++) {
    const h = (i / 255) * 850;
    let k = 1;
    while (k < stops.length - 1 && stops[k][0] < h) k++;
    const [h0, c0] = stops[k - 1];
    const [h1, c1] = stops[k];
    c.copy(c0).lerp(c1, Math.max(0, Math.min(1, (h - h0) / (h1 - h0))));
    data.set([c.r * 255, c.g * 255, c.b * 255, 255], i * 4);
  }
  const t = new THREE.DataTexture(data, 256, 1);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const GRAIN_GLSL = /* glsl */ `
  float grainHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float grainNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(grainHash(i), grainHash(i + vec2(1.0, 0.0)), u.x), mix(grainHash(i + vec2(0.0, 1.0)), grainHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // Value noise from 200 m down to 6 m, each octave fading out once a pixel covers too much of it.
  float grain(vec2 m) {
    float pixel = length(fwidth(m));
    float sum = 0.0; float amp = 1.0; float total = 0.0; float wave = 200.0;
    for (int o = 0; o < 6; o++) {
      float fade = 1.0 - smoothstep(0.15 * wave, 0.4 * wave, pixel);
      sum += (grainNoise(m / wave + float(o) * 17.0) - 0.5) * amp * fade;
      total += amp; amp *= 0.75; wave *= 0.5;
    }
    return sum / total;
  }
`;

// Per-pixel terrain: elevation ramp, rock on steep slopes, a ground grain, ambient
// occlusion, and the dry bed of the basin; lit through the object-space normal map.
function terrainMaterial(normalTex, dataTex, ramp, bedUniforms) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, normalMap: normalTex, normalMapType: THREE.ObjectSpaceNormalMap });
  const uniforms = { uData: { value: dataTex }, uRamp: { value: ramp }, uRock: { value: ROCK }, uYPerM: { value: KM * EXAG }, ...bedUniforms };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTerrainWorld;\nvarying vec2 vTerrainUv;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvTerrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTerrainUv = uv;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vTerrainWorld; varying vec2 vTerrainUv;
        uniform sampler2D uData; uniform sampler2D uRamp; uniform vec3 uRock; uniform float uYPerM;
        uniform float uWater; uniform float uFull; uniform float uRing; uniform float uDeep;
        ${GRAIN_GLSL}
        ${BED_GLSL}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          vec4 d = texture2D(uData, vTerrainUv);
          float elev = vTerrainWorld.y / uYPerM;
          vec3 c = texture2D(uRamp, vec2(clamp(elev / 850.0, 0.0, 1.0), 0.5)).rgb;
          c = mix(c, uRock, smoothstep(28.0 / 60.0, 50.0 / 60.0, d.b) * 0.8);
          c *= 1.0 + 0.7 * grain(vTerrainWorld.xz * 1000.0);
          if (d.g > 0.5) c = bedColor(vTerrainWorld, uWater, uFull, uRing, uDeep, 260.0);
          // A touch less saturated than the island ramp, and occlusion in the hollows.
          c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, 0.8);
          c *= mix(0.38, 1.0, d.r);
          diffuseColor.rgb = c;
        }`,
      );
  };
  mat.customProgramCacheKey = () => "closeup-terrain";
  return mat;
}

// Earth layers down the sides, following the surface (as in Moris 3D's dioramas).
function wallsMesh(pos, V, N, sizeKm, baseY) {
  const perim = [];
  for (let i = 0; i < N; i++) perim.push(i);
  for (let j = 0; j < N; j++) perim.push(j * V + N);
  for (let i = N; i > 0; i--) perim.push(N * V + i);
  for (let j = N; j > 0; j--) perim.push(j * V);
  perim.push(0);
  const cx = pos[0] + sizeKm / 2;
  const cz = pos[2] + sizeKm / 2;
  const out = [];
  const nrm = [];
  const col = [];
  const depths = LAYER_FRACTIONS.map((f) => f * sizeKm);
  for (let k = 0; k + 1 < perim.length; k++) {
    const p = [pos[perim[k] * 3], pos[perim[k] * 3 + 1], pos[perim[k] * 3 + 2]];
    const q = [pos[perim[k + 1] * 3], pos[perim[k + 1] * 3 + 1], pos[perim[k + 1] * 3 + 2]];
    // Outward normal: away from the block's centre, along the side's axis.
    const mx = (p[0] + q[0]) / 2 - cx;
    const mz = (p[2] + q[2]) / 2 - cz;
    const normal = Math.abs(mx) > Math.abs(mz) ? [Math.sign(mx), 0, 0] : [0, 0, Math.sign(mz)];
    let t0 = p[1];
    let t1 = q[1];
    for (let l = 0; l < STRATA.length; l++) {
      const b0 = l < depths.length ? Math.max(baseY, p[1] - depths[l]) : baseY;
      const b1 = l < depths.length ? Math.max(baseY, q[1] - depths[l]) : baseY;
      if (t0 > b0 || t1 > b1) {
        out.push(p[0], t0, p[2], p[0], b0, p[2], q[0], t1, q[2], q[0], t1, q[2], p[0], b0, p[2], q[0], b1, q[2]);
        for (let v = 0; v < 6; v++) {
          nrm.push(...normal);
          col.push(STRATA[l].r, STRATA[l].g, STRATA[l].b);
        }
      }
      t0 = b0;
      t1 = b1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
}

// Water that looks like water: wind ripples as a normal, colour and opacity by the
// depth of the modelled basin under it, a fresnel reflection of the sky and the sun's glint.
function waterMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uSun; uniform sampler2D uData; uniform vec3 uRect; uniform float uD; uniform float uH;
      varying vec3 vWorld;
      vec2 waves(vec2 p, float t) {
        vec2 g = vec2(0.0);
        float amp = 1.0;
        for (int i = 0; i < 5; i++) {
          float fi = float(i);
          vec2 dir = normalize(vec2(cos(fi * 2.4 + 0.3), sin(fi * 2.4 + 0.3)));
          float freq = 0.35 * pow(1.7, fi);
          float phase = dot(dir, p) * freq + t * (0.8 + 0.25 * fi);
          float fade = 1.0 - smoothstep(0.5, 1.6, fwidth(phase));
          g += dir * freq * cos(phase) * amp * fade;
          amp *= 0.62;
        }
        return g;
      }
      void main() {
        vec2 uv = (vWorld.xz - uRect.xy) / uRect.z;
        vec4 d = texture2D(uData, uv);
        float depth = max(d.a * uD - uH, 0.0); // metres of water here
        vec2 m = vWorld.xz * 1000.0;
        vec2 g = waves(m, uTime);
        vec3 N = normalize(vec3(-g.x * 0.05, 1.0, -g.y * 0.05));
        vec3 V = normalize(cameraPosition - vWorld);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 body = mix(vec3(0.07, 0.12, 0.08), vec3(0.004, 0.03, 0.06), 1.0 - exp(-depth / 6.0));
        vec3 sky = vec3(0.42, 0.5, 0.58);
        float spec = pow(max(dot(reflect(-uSun, N), V), 0.0), 220.0) * 6.0;
        vec3 col = mix(body, sky, fres) + spec * vec3(1.0, 0.92, 0.8);
        float alpha = clamp(mix(0.2, 0.94, 1.0 - exp(-depth / 1.2)) + fres * 0.3 + spec, 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function dispose(group) {
  group.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) {
      for (const m of [].concat(o.material)) {
        for (const v of Object.values(m.uniforms ?? {})) if (v.value?.isTexture && v.value !== undefined) v.value.dispose?.();
        m.normalMap?.dispose();
        m.dispose();
      }
    }
  });
}
