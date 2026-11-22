// The lakes on the island: a modelled basin is carved under each real outline and
// the water sits at the level whose volume matches the reported %, so the shoreline
// pulls back and exposes the dry bed, with a pale "bathtub ring" below the full level.
//
// There is no public depth survey of the reservoirs, so the shape is a model: depth
// grows with distance from the shore, depth = D * (d / dmax)^BASIN_SHAPE, with D chosen
// so the basin holds exactly the official capacity. Depths are drawn BASIN_EXAG times
// deeper on top of the terrain's exaggeration.
import * as THREE from "three";
import { KM, toY, pointInRing, distToRing, lakeShapeGeometry, flatWaterMaterial, levelCurve, BED_GLSL } from "./common.js";
import { BASIN_EXAG, BASIN_SHAPE } from "../lib/model.js";

export const RING_M = 1.2; // metres of bleached bank below the full level

export class Basins {
  constructor(core) {
    this.core = core;
    this.group = new THREE.Group();
    this.basins = new Map();
    this.pickables = [];
    for (const lake of core.lakes.values()) this.#build(lake);
    core.scene.add(this.group);
  }

  setVisible(on) {
    this.group.visible = on;
  }

  setLevel(lake) {
    const b = this.basins.get(lake.id);
    const s = lake.level;
    // Water depth below the full level whose volume matches the fill fraction.
    const h = s.known ? b.depthFor(s.current) : b.D;
    const y = toY(lake.fullM - h * BASIN_EXAG);
    b.water.position.y = y;
    b.water.visible = s.known && s.current > 0.002;
    b.uniforms.uWater.value = s.known ? y : -1e3;
  }

  focus(lake) {
    return { target: new THREE.Vector3(lake.center.x, lake.fullY, lake.center.z), distance: lake.radius * 4 + 3 };
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
    for (let i = 0; i < n; i++) if (inside[i]) sumF += Math.pow(dist[i] / dmax, BASIN_SHAPE);
    const D = (lake.capacity * 1e6) / (sumF * cellM);
    const depths = [];
    for (let i = 0; i < n; i++) {
      if (!inside[i]) continue;
      const depth = D * Math.pow(dist[i] / dmax, BASIN_SHAPE);
      depths.push(depth);
      pos[i * 3 + 1] = Math.min(pos[i * 3 + 1], toY(lake.fullM - depth * BASIN_EXAG));
      bed[i] = 1;
    }
    const depthFor = levelCurve(Float32Array.from(depths), cellM, D);

    const idx = [];
    for (const [gx, gy] of lake.quads) {
      const ox = (gx - qx0) * k;
      const oy = (gy - qy0) * k;
      for (let y = 0; y < k; y++) {
        for (let x = 0; x < k; x++) {
          const a = (oy + y) * sw + ox + x;
          idx.push(a, a + sw, a + 1, a + 1, a + sw, a + sw + 1);
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

    const water = new THREE.Mesh(lakeShapeGeometry(lake.ring), flatWaterMaterial(core.uniforms.uTime));
    water.renderOrder = 1;

    const pick = new THREE.Mesh(lakeShapeGeometry(lake.ring), new THREE.MeshBasicMaterial());
    pick.position.y = lake.fullY;
    pick.visible = false;
    pick.userData.id = lake.id;

    this.group.add(mesh, water, pick);
    this.pickables.push(pick);
    this.basins.set(lake.id, { water, uniforms, D, depthFor });
  }
}

// The terrain's vertex colours, except inside the lake: the dry bed (see BED_GLSL).
function bedMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aBed;\nvarying float vBed;\nvarying vec3 vBedWorld;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBed = aBed;\nvBedWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying float vBed; varying vec3 vBedWorld;\nuniform float uWater; uniform float uFull; uniform float uRing; uniform float uDeep;\n${BED_GLSL}`)
      .replace("#include <color_fragment>", "#include <color_fragment>\nif (vBed > 0.5) diffuseColor.rgb = bedColor(vBedWorld, uWater, uFull, uRing, uDeep, 40.0);");
  };
  mat.customProgramCacheKey = () => "basin-bed";
  return mat;
}
