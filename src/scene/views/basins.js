// Basins: a modelled basin is carved under each real lake outline and the water
// sits at the level whose volume matches the reported %, so the shoreline pulls
// back and exposes the dry bed, with a pale "bathtub ring" below the full level.
//
// There is no public depth survey of the reservoirs, so the shape is a model:
// depth grows with distance from the shore, depth = D * (d / dmax)^SHAPE, with D
// chosen so the basin holds exactly the official capacity. Depths are drawn
// exaggerated BASIN_EXAG times on top of the terrain's exaggeration.
import * as THREE from "three";
import { KM, toY, pointInRing, distToRing, lakeShapeGeometry, flatWaterMaterial } from "../common.js";
import { BASIN_EXAG } from "../../lib/views.js";

// Close to a cone (1): reservoirs are flooded valleys, so the shoreline retreats
// fast as they empty. Below 1 would give steep banks that hide the drop.
const SHAPE = 1.1;
const RING_M = 1.2; // metres of bleached bank below the full level
const CURVE = 128; // samples of the level-volume curve

export class BasinsView {
  name = "basins";
  holes = true;

  constructor(core) {
    this.core = core;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.basins = new Map();
    this.pickables = [];
    this.closeUp = null;
    for (const lake of core.lakes.values()) this.#build(lake);
    core.scene.add(this.group);
  }

  enter() {
    this.group.visible = true;
  }

  leave() {
    this.#closeCloseUp();
    this.group.visible = false;
  }

  dispose() {
    this.#closeCloseUp();
  }

  setLevel(lake) {
    const b = this.basins.get(lake.id);
    const s = lake.level;
    // Water depth below the full level whose volume matches the fill fraction.
    const h = s.known ? b.depthFor(s.current) : b.D;
    const y = b.yOf(lake.fullM - h);
    b.water.position.y = y;
    b.water.visible = s.known && s.current > 0.002 && !this.closeUp;
    b.uniforms.uWater.value = s.known ? y : -1e3;
    if (this.closeUp?.id === lake.id) {
      this.closeUp.water.position.y = y;
      this.closeUp.water.visible = s.known && s.current > 0.002;
    }
  }

  setMarkers() {}

  setSelected(id) {
    if (this.closeUp?.id === id) return;
    this.#closeCloseUp();
    if (id) this.#openCloseUp(this.core.lakes.get(id));
  }

  labelPoint(lake, v) {
    return v.set(lake.center.x, lake.fullY + 0.12, lake.center.z);
  }

  labelVisible(lake) {
    return !this.closeUp || this.closeUp.id === lake.id;
  }

  focus(lake) {
    const half = this.closeUp?.half ?? lake.radius + 0.7;
    return { target: new THREE.Vector3(lake.center.x, lake.fullY - 0.05, lake.center.z), distance: half * 3.4 };
  }

  #build(lake) {
    const core = this.core;
    const g = core.grid;
    const k = core.mobile ? 5 : 6; // subdivisions per terrain quad
    let qx0 = Infinity;
    let qy0 = Infinity;
    let qx1 = -Infinity;
    let qy1 = -Infinity;
    for (const [gx, gy] of lake.quads) {
      qx0 = Math.min(qx0, gx);
      qy0 = Math.min(qy0, gy);
      qx1 = Math.max(qx1, gx);
      qy1 = Math.max(qy1, gy);
    }
    const sw = (qx1 - qx0 + 1) * k + 1;
    const sh = (qy1 - qy0 + 1) * k + 1;
    const n = sw * sh;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const bed = new Float32Array(n);
    const dist = new Float32Array(n);
    const inside = new Uint8Array(n);

    // Everything outside the lake is the terrain itself, interpolated within each
    // terrain quad, so the seams with the surrounding terrain match exactly.
    const corner = (gx, gy) => gy * g.nx + gx;
    let dmax = 0;
    for (let sy = 0; sy < sh; sy++) {
      for (let sx = 0; sx < sw; sx++) {
        const i = sy * sw + sx;
        let gx = qx0 + Math.floor(sx / k);
        let gy = qy0 + Math.floor(sy / k);
        let u = (sx % k) / k;
        let v = (sy % k) / k;
        if (gx > qx1) (gx = qx1), (u = 1);
        if (gy > qy1) (gy = qy1), (v = 1);
        const a = corner(gx, gy);
        const b = corner(gx + 1, gy);
        const c = corner(gx, gy + 1);
        const d = corner(gx + 1, gy + 1);
        const wa = (1 - u) * (1 - v);
        const wb = u * (1 - v);
        const wc = (1 - u) * v;
        const wd = u * v;
        for (let j = 0; j < 3; j++) {
          pos[i * 3 + j] = g.pos[a * 3 + j] * wa + g.pos[b * 3 + j] * wb + g.pos[c * 3 + j] * wc + g.pos[d * 3 + j] * wd;
          nor[i * 3 + j] = g.nor[a * 3 + j] * wa + g.nor[b * 3 + j] * wb + g.nor[c * 3 + j] * wc + g.nor[d * 3 + j] * wd;
          col[i * 3 + j] = g.col[a * 3 + j] * wa + g.col[b * 3 + j] * wb + g.col[c * 3 + j] * wc + g.col[d * 3 + j] * wd;
        }
        const x = pos[i * 3];
        const z = pos[i * 3 + 2];
        if (pointInRing(lake.ring, x, z)) {
          inside[i] = 1;
          dist[i] = distToRing(lake.ring, x, z);
          dmax = Math.max(dmax, dist[i]);
        }
      }
    }

    // Depth profile scaled so the basin holds the official capacity.
    const cellM = (g.q / k / KM) ** 2;
    let sumF = 0;
    for (let i = 0; i < n; i++) if (inside[i]) sumF += Math.pow(dist[i] / dmax, SHAPE);
    const D = (lake.capacity * 1e6) / (sumF * cellM);
    const depthM = new Float32Array(n);
    const yOf = (m) => toY(lake.fullM - (lake.fullM - m) * BASIN_EXAG);
    for (let i = 0; i < n; i++) {
      if (!inside[i]) continue;
      depthM[i] = D * Math.pow(dist[i] / dmax, SHAPE);
      pos[i * 3 + 1] = Math.min(pos[i * 3 + 1], yOf(lake.fullM - depthM[i]));
      bed[i] = 1;
    }

    // Level-volume curve: volume held when the water is h metres below the full level.
    const vol = new Float64Array(CURVE + 1);
    for (let j = 0; j <= CURVE; j++) {
      const h = (D * j) / CURVE;
      let v = 0;
      for (let i = 0; i < n; i++) if (depthM[i] > h) v += (depthM[i] - h) * cellM;
      vol[j] = v;
    }
    const depthFor = (frac) => {
      const target = frac * vol[0];
      if (target >= vol[0]) return 0;
      for (let j = 1; j <= CURVE; j++) {
        if (vol[j] <= target) {
          const t = (vol[j - 1] - target) / (vol[j - 1] - vol[j] || 1);
          return (D * (j - 1 + t)) / CURVE;
        }
      }
      return D;
    };

    const idx = [];
    for (const [gx, gy] of lake.quads) {
      const ox = (gx - qx0) * k;
      const oy = (gy - qy0) * k;
      for (let y = 0; y < k; y++) {
        for (let x = 0; x < k; x++) {
          const a = (oy + y) * sw + ox + x;
          const b = a + 1;
          const c = a + sw;
          const d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aBed", new THREE.BufferAttribute(bed, 1));
    geo.setIndex(idx);
    // Carved vertices get their own normals; the rest keep the terrain's, for seamless shading.
    const kept = nor.slice();
    geo.computeVertexNormals();
    const nn = geo.attributes.normal.array;
    for (let i = 0; i < n; i++) if (!inside[i]) for (let j = 0; j < 3; j++) nn[i * 3 + j] = kept[i * 3 + j];

    const uniforms = {
      uWater: { value: -1e3 },
      uFull: { value: lake.fullY },
      uRing: { value: toY(RING_M * BASIN_EXAG) },
      uDeep: { value: toY(D * BASIN_EXAG) * 0.6 },
    };
    const mesh = new THREE.Mesh(geo, bedMaterial(uniforms));
    mesh.receiveShadow = true;
    mesh.castShadow = true;

    const water = new THREE.Mesh(lakeShapeGeometry(lake.ring), flatWaterMaterial(this.core.uniforms.uTime));
    water.renderOrder = 1;

    const pick = new THREE.Mesh(lakeShapeGeometry(lake.ring), new THREE.MeshBasicMaterial());
    pick.position.y = lake.fullY;
    pick.visible = false;
    pick.userData.id = lake.id;

    this.group.add(mesh, water, pick);
    this.pickables.push(pick);
    this.basins.set(lake.id, { mesh, water, uniforms, D, dmax, depthFor, yOf, material: mesh.material });
  }

  // A cut-out block of land around the lake (diorama style), the rest of the island hidden.
  #openCloseUp(lake) {
    const core = this.core;
    const b = this.basins.get(lake.id);
    const half = lake.radius + 0.7;
    const res = core.mobile ? 0.03 : 0.015;
    const n = Math.ceil((2 * half) / res);
    const step = (2 * half) / n;
    const cx = lake.center.x;
    const cz = lake.center.z;
    const W = n + 1;
    const pos = new Float32Array(W * W * 3);
    const col = new Float32Array(W * W * 3);
    const bed = new Float32Array(W * W);
    const c = new THREE.Color();
    let ymin = Infinity;
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const x = cx - half + i * step;
        const z = cz - half + j * step;
        const hM = Math.max(core.heightAt(x, z), 0.5);
        let y = toY(hM);
        core.colorAt(x, z, c);
        if (pointInRing(lake.ring, x, z)) {
          const depth = b.D * Math.pow(Math.min(1, distToRing(lake.ring, x, z) / b.dmax), SHAPE);
          y = Math.min(y, b.yOf(lake.fullM - depth));
          bed[k] = 1;
        }
        pos[k * 3] = x;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = z;
        col[k * 3] = c.r;
        col[k * 3 + 1] = c.g;
        col[k * 3 + 2] = c.b;
        ymin = Math.min(ymin, y);
      }
    }
    const idx = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * W + i;
        idx.push(a, a + W, a + 1, a + 1, a + W, a + W + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aBed", new THREE.BufferAttribute(bed, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const group = new THREE.Group();
    const surface = new THREE.Mesh(geo, b.material);
    surface.castShadow = surface.receiveShadow = true;
    const bottom = ymin - 0.35;
    const water = new THREE.Mesh(b.water.geometry, b.water.material);
    water.renderOrder = 1;
    group.add(surface, water, sidesMesh(pos, W, n, bottom), plinth(half, bottom, cx, cz));
    core.scene.add(group);

    this.closeUp = { id: lake.id, group, water, half };
    for (const other of this.basins.values()) other.mesh.visible = other.water.visible = false;
    core.setIslandVisible(false);
    this.setLevel(lake);
  }

  #closeCloseUp() {
    if (!this.closeUp) return;
    const { group } = this.closeUp;
    this.core.scene.remove(group);
    group.traverse((o) => {
      // The surface and water share the basin's material and the water its geometry.
      if (o.isMesh && o.material?.userData.bed) return o.geometry.dispose();
      if (o.isMesh && o.material?.type === "ShaderMaterial") return;
      o.geometry?.dispose();
      o.material?.dispose();
    });
    this.closeUp = null;
    for (const b of this.basins.values()) b.mesh.visible = true;
    for (const lake of this.core.lakes.values()) this.setLevel(lake);
    this.core.setIslandVisible(true);
  }
}

// Earth layers on the four sides of the block, by depth below the surface.
const LAYERS = [
  [0.025, "#4a3526"], // topsoil
  [0.1, "#8a4b2f"], // red laterite
  [0.22, "#6d625a"], // weathered basalt
  [Infinity, "#3a3634"], // basalt
].map(([d, hex]) => [d, new THREE.Color(hex)]);

function sidesMesh(pos, W, n, bottom) {
  const out = [];
  const nrm = [];
  const col = [];
  const edge = (k) => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]];
  const sides = [
    [(i) => i, [0, 0, -1]], // north edge, row 0
    [(i) => n * W + (n - i), [0, 0, 1]], // south edge, reversed
    [(i) => (n - i) * W, [-1, 0, 0]], // west edge, reversed
    [(i) => i * W + n, [1, 0, 0]], // east edge
  ];
  for (const [at, normal] of sides) {
    for (let i = 0; i < n; i++) {
      const p = edge(at(i));
      const q = edge(at(i + 1));
      let top0 = p[1];
      let top1 = q[1];
      for (const [depth, color] of LAYERS) {
        const b0 = Math.max(bottom, p[1] - depth);
        const b1 = Math.max(bottom, q[1] - depth);
        if (top0 > b0 || top1 > b1) {
          out.push(p[0], top0, p[2], p[0], b0, p[2], q[0], top1, q[2], q[0], top1, q[2], p[0], b0, p[2], q[0], b1, q[2]);
          for (let v = 0; v < 6; v++) {
            nrm.push(...normal);
            col.push(color.r, color.g, color.b);
          }
        }
        top0 = b0;
        top1 = b1;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }));
}

function plinth(half, bottom, x, z) {
  const geo = new THREE.BoxGeometry(2 * half + 0.14, 0.09, 2 * half + 0.14);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: "#151d2b", roughness: 0.45, metalness: 0.3 }));
  mesh.position.set(x, bottom - 0.045, z);
  mesh.receiveShadow = true;
  return mesh;
}

// Terrain material, except inside the lake: dry cracked mud above the water, a pale
// bathtub ring just below the full level, a dark wet band at the waterline, and
// silt that darkens with depth below the water.
function bedMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  mat.userData.bed = true;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aBed;\nvarying float vBed;\nvarying vec3 vBedWorld;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBed = aBed;\nvBedWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        varying float vBed; varying vec3 vBedWorld;
        uniform float uWater; uniform float uFull; uniform float uRing; uniform float uDeep;
        vec2 bedHash(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
        float cracks(vec2 x) {
          vec2 n = floor(x); vec2 f = fract(x); float d1 = 8.0; float d2 = 8.0;
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            vec2 g = vec2(float(i), float(j)); vec2 r = g + bedHash(n + g) - f; float d = dot(r, r);
            if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
          }
          return sqrt(d2) - sqrt(d1);
        }`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        if (vBed > 0.5) {
          float y = vBedWorld.y;
          vec2 p = vBedWorld.xz * 40.0;
          // Cracks fade out where a cell would be smaller than a few pixels, so they never shimmer.
          float fade = 1.0 - smoothstep(0.15, 0.6, fwidth(p.x) + fwidth(p.y));
          float crack = mix(1.0, 0.35 + 0.65 * smoothstep(0.0, 0.16, cracks(p)), fade);
          // Colours are linear (the renderer converts to sRGB): brown mud drying paler up the bank.
          vec3 mud = mix(vec3(0.17, 0.11, 0.065), vec3(0.3, 0.21, 0.13), smoothstep(uWater, uFull, y)) * crack;
          float ring = smoothstep(uFull - uRing, uFull - uRing * 0.55, y);
          vec3 col = mix(mud, vec3(0.72, 0.69, 0.6), ring);
          float wet = 1.0 - smoothstep(uWater, uWater + uRing * 0.35, y);
          col = mix(col, vec3(0.06, 0.045, 0.03), wet * 0.8);
          if (y < uWater) col = mix(vec3(0.09, 0.08, 0.05), vec3(0.01, 0.025, 0.035), clamp((uWater - y) / uDeep, 0.0, 1.0));
          diffuseColor.rgb = col;
        }`,
      );
  };
  mat.customProgramCacheKey = () => "basin-bed";
  return mat;
}
