// The close-up: a cut-out block of the Land Drainage Authority's 1 m terrain (MNT 2021,
// via Moris 3D) around one reservoir, like a museum diorama: earth layers on the sides,
// a plinth on a softly lit floor, its own low warm sun. Blocks are cut offline at 1-2 m
// by scripts/build-closeups.mjs and loaded when a lake is opened.
//
// Heights are drawn CLOSE_EXAG times, terrain and basin alike. The basin is modelled as
// on the island (depth grows away from the shore, sized to hold the official capacity),
// then roughened and smoothed so it reads as a drawn-down valley rather than a cut: no
// crease at the rim, an irregular waterline as it drops. The mesh is coarser than the
// data; the detail comes back through a normal map, baked occlusion and per-pixel colour.
import * as THREE from "three";
import { KM, toY, LAND_STOPS, ROCK, levelCurve, lakeShapeGeometry, BACKGROUND } from "./common.js";
import { BASIN_SHAPE, CLOSE_EXAG } from "../lib/model.js";

const BASE = import.meta.env.BASE_URL + "closeups/";
// Earth layers down the sides, as fractions of the block's width (Moris 3D's diorama);
// the last runs to the base.
const STRATA = ["#5a3f2c", "#7d5a40", "#9a7a5a", "#3b3734"].map((c) => new THREE.Color(c));
const LAYER_FRACTIONS = [0.008, 0.045, 0.1];
const BASE_FRAC = 0.17;
// A warm low sun from the north-west: long shadows that model the relief.
const CLOSE_SUN = new THREE.Vector3(-0.72, 0.5, -0.48).normalize();

export class CloseUp {
  constructor(core) {
    this.core = core;
    this.active = null;
    this.token = 0;
    this.index = null;
    this.rampTexture = rampTexture();
    this.backdrop = backdropTexture();
    this.fade = radialTexture([
      [0, "rgba(255,255,255,1)"],
      [0.45, "rgba(255,255,255,0.9)"],
      [1, "rgba(255,255,255,0)"],
    ]);

    const sun = new THREE.DirectionalLight("#ffd9b0", 3.6);
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
    core.scene.background = this.backdrop;
    core.scene.fog = null;
    this.sun.visible = true;
    core.islandSun.visible = false;
    // Cool, dim sky light so the warm sun does the modelling.
    core.hemi.color.set("#93aed0");
    core.hemi.groundColor.set("#3a2e24");
    core.hemi.intensity = 0.55;
    this.setLevel(lake);
    core.dirty = true;
    // Far enough to see the whole block, its sides and its shadow, like a diorama on a table.
    return { target: block.center.clone().setY(block.center.y - block.sizeKm * 0.06), distance: block.sizeKm * 2.05 };
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
    const y = a.yOf(a.fullM - h);
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
    core.scene.background = BACKGROUND;
    core.scene.fog = core.fog;
    this.sun.visible = false;
    core.islandSun.visible = true;
    core.hemi.color.set("#b9d4ff");
    core.hemi.groundColor.set("#5a4630");
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
    let rMin = n;
    let rMax = 0;
    let cMin = n;
    let cMax = 0;
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
        if (c1 >= c0) {
          rMin = Math.min(rMin, r);
          rMax = Math.max(rMax, r);
          cMin = Math.min(cMin, c0);
          cMax = Math.max(cMax, c1);
        }
      }
    }

    // Distance from the shore, in cells.
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

    // Basin profile: distance-to-shore ^ SHAPE, warped by low-frequency noise so the
    // waterline wanders as it drops, with a little small-scale roughness on the bed,
    // then smoothed so the bank eases into the land around it without a crease.
    const g = new Float32Array(n * n);
    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        const i = r * n + c;
        if (!mask[i]) continue;
        const xm = c * res;
        const ym = r * res;
        const warp = (fbm(xm / 140, ym / 140) - 0.5) * 0.5;
        const s = Math.max(0, Math.min(1, dist[i] / dmax + warp * Math.min(1, (dist[i] * res) / 60)));
        g[i] = Math.pow(s, BASIN_SHAPE) * (0.92 + 0.16 * fbm(xm / 18, ym / 18));
      }
    }
    const radius = Math.max(1, Math.round(22 / res));
    const pad = radius * 3;
    boxBlur(g, n, Math.max(0, rMin - pad), Math.min(n - 1, rMax + pad), Math.max(0, cMin - pad), Math.min(n - 1, cMax + pad), radius, 3);

    // Scale so the basin holds the official capacity, and its level-volume curve.
    const cellArea = res * res;
    let sumG = 0;
    for (let i = 0; i < n * n; i++) sumG += g[i];
    const D = (lake.capacity * 1e6) / (sumG * cellArea);
    const depths = new Float32Array(n * n);
    const lakeDepths = [];
    for (let i = 0; i < n * n; i++) {
      depths[i] = D * g[i];
      if (depths[i] > 0.01) lakeDepths.push(depths[i]);
    }
    const depthFor = levelCurve(Float32Array.from(lakeDepths), cellArea, D);

    // Scene heights: drawn CLOSE_EXAG times around the lake's full level, which stays
    // where it is on the island.
    const fullY = toY(fullM);
    const yOf = (m) => fullY + (m - fullM) * KM * CLOSE_EXAG;
    const Y = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) Y[i] = yOf((mask[i] ? Math.min(heights[i], fullM) : heights[i]) - depths[i]);

    const { normalTex, dataTex } = this.#textures(n, res, cellKm, heights, Y, depths, D);

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
      uFullY: { value: fullY },
      uFullM: { value: fullM },
      uYPerM: { value: KM * CLOSE_EXAG },
    };
    const top = new THREE.Mesh(topGeo, terrainMaterial(normalTex, dataTex, this.rampTexture, bedUniforms));
    top.castShadow = top.receiveShadow = true;

    const baseY = minY - BASE_FRAC * sizeKm;
    const walls = wallsMesh(pos, V, N, sizeKm, baseY);
    walls.castShadow = walls.receiveShadow = true;
    const plinthT = 0.03 * sizeKm;
    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(sizeKm * 1.035, plinthT, sizeKm * 1.035),
      new THREE.MeshStandardMaterial({ color: "#1c1c1c", roughness: 0.55, metalness: 0.1 }),
    );
    const cx = x0 + sizeKm / 2;
    const cz = z0 + sizeKm / 2;
    plinth.position.set(cx, baseY - plinthT / 2, cz);
    plinth.castShadow = plinth.receiveShadow = true;

    // A floor that fades into the background, to catch the block's shadow, and a soft
    // contact shadow right under it.
    const floorY = baseY - plinthT - 0.001;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(sizeKm * 7, sizeKm * 7).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: "#3a3a3c", roughness: 1, transparent: true, opacity: 0.55, alphaMap: this.fade, depthWrite: false }),
    );
    floor.position.set(cx, floorY, cz);
    floor.receiveShadow = true;
    floor.renderOrder = -2;
    const contact = new THREE.Mesh(
      new THREE.PlaneGeometry(sizeKm * 1.5, sizeKm * 1.5).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.55, alphaMap: this.fade, depthWrite: false }),
    );
    contact.position.set(cx, floorY + 0.0005, cz);
    contact.renderOrder = -1;

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
    group.add(floor, contact, top, walls, plinth, water);

    // The sun's shadow camera covers the block and the floor around it.
    const center = new THREE.Vector3(cx, fullY, cz);
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(CLOSE_SUN, sizeKm * 3);
    const sc = this.sun.shadow.camera;
    Object.assign(sc, { left: -sizeKm * 1.3, right: sizeKm * 1.3, top: sizeKm * 1.3, bottom: -sizeKm * 1.3, near: sizeKm * 0.5, far: sizeKm * 6 });
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.0015 * sizeKm;
    this.sun.shadow.radius = 3;

    // The vial stands on the bank beyond the lake (north-east), so it never hides the water.
    let vialAt = null;
    for (let k = 0; k < 24 && !vialAt; k++) {
      const a = -Math.PI / 4 + ((k % 2 ? 1 : -1) * Math.ceil(k / 2) * Math.PI) / 12;
      for (let d = lake.radius * 0.7; d < sizeKm / 2 - 0.1 && !vialAt; d += 0.05) {
        const x = lake.center.x + Math.cos(a) * d;
        const z = lake.center.z + Math.sin(a) * d;
        const c = (x - x0) / cellKm - 0.5;
        const r = (z - z0) / cellKm - 0.5;
        if (c < 4 || r < 4 || c > n - 5 || r > n - 5) break;
        // Clear of the basin by at least 60 m all round.
        const m = Math.ceil(60 / res);
        let clear = true;
        for (let dr = -m; dr <= m && clear; dr += Math.max(1, m >> 2)) {
          for (let dc = -m; dc <= m && clear; dc += Math.max(1, m >> 2)) {
            const i = Math.min(n - 1, Math.max(0, Math.round(r) + dr)) * n + Math.min(n - 1, Math.max(0, Math.round(c) + dc));
            clear = !mask[i] && depths[i] < 0.05;
          }
        }
        if (clear) vialAt = new THREE.Vector3(x, bilinear(Y, n, c, r), z);
      }
    }
    vialAt ??= new THREE.Vector3(x0 + sizeKm * 0.1, bilinear(Y, n, n * 0.1, n * 0.9), z0 + sizeKm * 0.9);

    return { id: lake.id, group, water, waterUniforms, bedUniforms, depthFor, D, fullM, yOf, center, sizeKm, vialAt, vialScale: Math.min(0.7, sizeKm * 0.11) };
  }

  // Object-space normals from the drawn heights, and a data texture: ambient occlusion
  // (R), how much of the basin's bed shows here (G), slope (B, 0-60 degrees) and
  // basin depth / D (A).
  #textures(n, res, cellKm, heights, Y, depths, D) {
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
        const bed = Math.min(1, Math.max(0, (depths[i] - 0.03) / 0.6));
        data[i * 4 + 1] = bed * 255;
        data[i * 4 + 2] = Math.min(255, (Math.atan(Math.hypot(sx, sz)) * (180 / Math.PI) * 255) / 60);
        data[i * 4 + 3] = Math.min(255, (depths[i] / D) * 255);
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
        ao[r * m + c] = 1 - Math.min(1, (occ / 8) * 2.2);
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

// Separable box blur of rows r0..r1, columns c0..c1, repeated (3 passes ~ a Gaussian).
function boxBlur(a, n, r0, r1, c0, c1, radius, passes) {
  const w = c1 - c0 + 1;
  const h = r1 - r0 + 1;
  const tmp = new Float32Array(Math.max(w, h));
  for (let p = 0; p < passes; p++) {
    for (let r = r0; r <= r1; r++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += a[r * n + Math.min(c1, Math.max(c0, c0 + k))];
      for (let c = c0; c <= c1; c++) {
        tmp[c - c0] = sum / (2 * radius + 1);
        sum += a[r * n + Math.min(c1, c + radius + 1)] - a[r * n + Math.max(c0, c - radius)];
      }
      for (let c = c0; c <= c1; c++) a[r * n + c] = tmp[c - c0];
    }
    for (let c = c0; c <= c1; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += a[Math.min(r1, Math.max(r0, r0 + k)) * n + c];
      for (let r = r0; r <= r1; r++) {
        tmp[r - r0] = sum / (2 * radius + 1);
        sum += a[Math.min(r1, r + radius + 1) * n + c] - a[Math.max(r0, r - radius) * n + c];
      }
      for (let r = r0; r <= r1; r++) a[r * n + c] = tmp[r - r0];
    }
  }
}

// Value noise in three octaves, 0..1, for the basin's shape.
function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y) {
  return (noise(x, y) * 0.57 + noise(x * 2.03 + 17, y * 2.03 + 5) * 0.29 + noise(x * 4.1 + 3, y * 4.1 + 11) * 0.14) / 1.0;
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

function radialTexture(stops) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 256;
  const ctx = cv.getContext("2d");
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(cv);
}

// The page's near-black, lifted a little behind the block, like a lit studio backdrop.
function backdropTexture() {
  const cv = document.createElement("canvas");
  cv.width = 512;
  cv.height = 512;
  const ctx = cv.getContext("2d");
  const grad = ctx.createRadialGradient(256, 230, 20, 256, 256, 380);
  grad.addColorStop(0, "#262626");
  grad.addColorStop(0.55, "#151515");
  grad.addColorStop(1, "#0a0a0a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const NOISE_GLSL = /* glsl */ `
  float cuHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float cuNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(cuHash(i), cuHash(i + vec2(1.0, 0.0)), u.x), mix(cuHash(i + vec2(0.0, 1.0)), cuHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // Fades out an octave once a pixel covers too much of it, so nothing shimmers.
  float cuOctave(vec2 m, float wave) {
    float pixel = length(fwidth(m));
    return (cuNoise(m / wave) - 0.5) * (1.0 - smoothstep(0.15 * wave, 0.4 * wave, pixel));
  }
  float cuGrain(vec2 m) {
    float sum = 0.0; float amp = 1.0; float total = 0.0; float wave = 200.0;
    for (int o = 0; o < 6; o++) { sum += cuOctave(m + float(o) * 37.0, wave) * amp; total += amp; amp *= 0.75; wave *= 0.5; }
    return sum / total;
  }
  vec2 cuHash2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
  float cuCracks(vec2 x) {
    vec2 n = floor(x); vec2 f = fract(x); float d1 = 8.0; float d2 = 8.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j)); vec2 r = g + cuHash2(n + g) - f; float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
    return sqrt(d2) - sqrt(d1);
  }
`;

// Per-pixel terrain: Moris 3D's elevation ramp with patches of drier and darker
// vegetation, rock on steep slopes, a ground grain and ambient occlusion; inside the
// basin, the exposed bed. Lit through the object-space normal map.
function terrainMaterial(normalTex, dataTex, ramp, bedUniforms) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, normalMap: normalTex, normalMapType: THREE.ObjectSpaceNormalMap });
  const uniforms = { uData: { value: dataTex }, uRamp: { value: ramp }, uRock: { value: ROCK }, ...bedUniforms };
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
        uniform sampler2D uData; uniform sampler2D uRamp; uniform vec3 uRock;
        uniform float uWater; uniform float uFullY; uniform float uFullM; uniform float uYPerM;
        ${NOISE_GLSL}
        // The exposed bed, by height between the water (t = 0) and the full level (t = 1).
        vec3 bedColor(vec2 m, float y, vec3 land) {
          float n1 = cuNoise(m / 30.0);
          float n2 = cuNoise(m / 9.0 + 7.0);
          if (y < uWater) {
            float below = (uWater - y) / uYPerM;
            return mix(vec3(0.07, 0.06, 0.04), vec3(0.012, 0.02, 0.025), clamp(below / 5.0, 0.0, 1.0));
          }
          float span = max(uFullY - uWater, 1e-5);
          float t = clamp((y - uWater) / span, 0.0, 1.0);
          float tn = t + (n1 - 0.5) * 0.22;
          vec3 damp = vec3(0.11, 0.08, 0.055);
          vec3 dried = vec3(0.36, 0.3, 0.22);
          vec3 c = mix(damp, dried, smoothstep(0.08, 0.55, tn));
          c *= 0.85 + 0.3 * n2;
          // Cracks where the silt has dried, fading with distance.
          float cr = cuCracks(m / 3.5);
          float fade = 1.0 - smoothstep(0.4, 1.2, length(fwidth(m / 3.5)));
          c *= mix(1.0, 0.5 + 0.5 * smoothstep(0.0, 0.14, cr), fade * smoothstep(0.25, 0.6, tn));
          // Grass creeping down from the bank.
          float grass = smoothstep(0.7, 0.95, tn) * smoothstep(0.45, 0.75, n2);
          c = mix(c, land * 0.9, grass * 0.85);
          // The bathtub ring: a soft, uneven stain just below the full level.
          float ring = smoothstep(0.8, 0.9, t) * (1.0 - smoothstep(0.95, 1.0, t));
          c = mix(c, vec3(0.5, 0.48, 0.42), ring * (0.25 + 0.3 * n1));
          // Dark wet mud at the waterline.
          c = mix(c, vec3(0.045, 0.035, 0.025), 1.0 - smoothstep(0.0, 0.05 + 0.04 * n2, t));
          return c;
        }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          vec4 d = texture2D(uData, vTerrainUv);
          vec2 m = vTerrainWorld.xz * 1000.0;
          float elev = uFullM + (vTerrainWorld.y - uFullY) / uYPerM;
          vec3 c = texture2D(uRamp, vec2(clamp(elev / 850.0, 0.0, 1.0), 0.5)).rgb;
          // Patches: drier grass and cane in the open, darker scrub in places.
          float p1 = cuNoise(m / 160.0);
          float p2 = cuNoise(m / 45.0 + 13.0);
          c = mix(c, c * vec3(1.18, 1.08, 0.72), smoothstep(0.55, 0.8, p1) * 0.7);
          c = mix(c, c * vec3(0.72, 0.82, 0.74), smoothstep(0.6, 0.85, p2) * 0.6);
          c = mix(c, uRock, smoothstep(28.0 / 60.0, 50.0 / 60.0, d.b) * 0.8);
          c *= 1.0 + 0.6 * cuGrain(m);
          c = mix(c, bedColor(m, vTerrainWorld.y, c), d.g);
          c *= mix(0.32, 1.0, d.r);
          diffuseColor.rgb = c;
        }`,
      );
  };
  mat.customProgramCacheKey = () => "closeup-terrain-2";
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
  // A little self-light so the shaded sides still show their layers.
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide, emissive: "#3a2a1e", emissiveIntensity: 1 }));
}

// Water that reads as water: wind ripples as a normal, colour and opacity by the
// depth of the modelled basin under it (clear and foamy at the edge, dark offshore),
// a fresnel reflection of a sky gradient and the sun's glint.
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
      ${NOISE_GLSL}
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
        vec3 R = reflect(-V, N);
        vec3 sky = mix(vec3(0.55, 0.6, 0.64), vec3(0.16, 0.26, 0.42), clamp(R.y * 1.6, 0.0, 1.0));
        vec3 body = mix(vec3(0.08, 0.13, 0.1), vec3(0.006, 0.035, 0.065), 1.0 - exp(-depth / 5.0));
        float spec = pow(max(dot(R, uSun), 0.0), 260.0) * 5.0;
        vec3 col = mix(body, sky, fres) + spec * vec3(1.0, 0.9, 0.75);
        // Foam and clear water where it is only a few centimetres deep.
        float edge = 1.0 - smoothstep(0.0, 0.18, depth);
        float foam = edge * smoothstep(0.35, 0.8, cuNoise(m / 7.0 + uTime * 0.15)) * 0.3 * (1.0 - smoothstep(0.6, 2.0, length(fwidth(m))));
        col = mix(col, vec3(0.75, 0.75, 0.7), foam);
        float alpha = clamp(mix(0.15, 0.95, 1.0 - exp(-depth / 1.0)) + fres * 0.35 + spec + foam, 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function dispose(group) {
  group.traverse((o) => {
    o.geometry?.dispose();
    if (!o.material) return;
    for (const m of [].concat(o.material)) {
      // Shared textures (the ramp, the floor's fade) stay; the block's own go.
      if (m.uniforms?.uData) m.uniforms.uData.value.dispose();
      m.normalMap?.dispose();
      m.dispose();
    }
  });
}
