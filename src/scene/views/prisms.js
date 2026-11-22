// Prisms: over each lake a glass prism extruded from its outline, as tall as the
// reservoir is big (height proportional to capacity), filled to the reported %.
import * as THREE from "three";
import { SUN, toY, lakeShapeGeometry } from "../common.js";

const KM_PER_MM3 = 0.15; // prism height per million m³ of capacity

export class PrismsView {
  name = "prisms";
  holes = false;

  constructor(core) {
    this.core = core;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.cols = new Map();
    this.pickables = [];
    for (const lake of core.lakes.values()) this.#build(lake);
    core.scene.add(this.group);
  }

  enter() {
    this.group.visible = true;
  }

  leave() {
    this.group.visible = false;
  }

  setLevel(lake) {
    const col = this.cols.get(lake.id);
    const s = lake.level;
    col.water.scale.y = Math.max(s.current, 0.0015) * col.height;
    col.levelRing.position.y = col.base + col.water.scale.y + 0.002;
    col.water.visible = col.levelRing.visible = s.known;
    col.glass.material.uniforms.uUnknown.value = s.known ? 0 : 1;
  }

  setMarkers(lake) {
    const col = this.cols.get(lake.id);
    for (const [ring, pct] of [
      [col.lastYearRing, lake.level.lastYear],
      [col.averageRing, lake.level.average],
    ]) {
      ring.visible = pct != null;
      if (pct != null) ring.position.y = col.base + (col.height * Math.min(pct, 100)) / 100 + 0.004;
    }
  }

  setHover(id) {
    for (const [cid, col] of this.cols) col.glass.material.uniforms.uHover.value = cid === id ? 1 : 0;
  }

  setSelected(id) {
    for (const [cid, col] of this.cols) col.glass.material.uniforms.uSelected.value = cid === id ? 1 : 0;
  }

  labelPoint(lake, v) {
    const col = this.cols.get(lake.id);
    return v.set(lake.center.x, col.base + col.height + 0.05, lake.center.z);
  }

  focus(lake) {
    const col = this.cols.get(lake.id);
    return { target: new THREE.Vector3(lake.center.x, col.base + col.height * 0.45, lake.center.z), distance: Math.max(3.2, col.height * 2.6 + lake.radius * 3.2) };
  }

  #build(lake) {
    const base = toY(lake.shoreMinM - 4);
    const height = lake.capacity * KM_PER_MM3;
    const geo = prismGeometry(lake.ring);

    const water = new THREE.Mesh(geo, waterMaterial(this.core.uniforms.uTime));
    water.position.y = base;
    water.renderOrder = 1;
    water.castShadow = true;

    const glass = new THREE.Mesh(geo, glassMaterial());
    glass.position.y = base;
    glass.scale.y = height;
    glass.renderOrder = 2;
    glass.userData.id = lake.id;

    const ringGeo = new THREE.BufferGeometry().setFromPoints(lake.ring.map((p) => new THREE.Vector3(p.x, 0, p.y)));
    const rim = (color, opacity, y) => {
      const line = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      line.position.y = y;
      line.renderOrder = 3;
      return line;
    };
    const dashed = (color) => {
      const line = new THREE.LineLoop(ringGeo.clone(), new THREE.LineDashedMaterial({ color, dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: 0.95, depthWrite: false }));
      line.computeLineDistances();
      line.renderOrder = 3;
      line.visible = false;
      return line;
    };
    const lastYearRing = dashed("#ffb347");
    const averageRing = dashed("#ffffff");
    // A bright line where the water meets the glass, so the level reads from afar.
    const levelRing = rim("#c8f3ff", 0.95, base);

    // The lake itself, flat on the terrain, so its real outline shows from far away.
    const lakeMesh = new THREE.Mesh(
      lakeShapeGeometry(lake.ring),
      new THREE.MeshStandardMaterial({ color: "#1d5f86", roughness: 0.2, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    lakeMesh.position.y = lake.fullY;
    lakeMesh.receiveShadow = true;

    this.group.add(lakeMesh, water, glass, rim("#ffffff", 0.75, base + height), rim("#ffffff", 0.35, base + 0.003), lastYearRing, averageRing, levelRing);
    this.cols.set(lake.id, { water, glass, lastYearRing, averageRing, levelRing, base, height });
    this.pickables.push(glass);
  }
}

// A vertical prism of height 1 over a counter-clockwise ring of (x, z) points:
// smooth side normals so the glass catches light like one curved surface, flat caps.
function prismGeometry(pts) {
  const n = pts.length;
  const pos = [];
  const nor = [];
  const idx = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    // Outward normal of edge (dx, dz) is (dz, -dx) for this winding; average both edges.
    const nx = cur.y - prev.y + (next.y - cur.y);
    const nz = -(cur.x - prev.x) - (next.x - cur.x);
    const l = Math.hypot(nx, nz) || 1;
    pos.push(cur.x, 0, cur.y, cur.x, 1, cur.y);
    nor.push(nx / l, 0, nz / l, nx / l, 0, nz / l);
  }
  for (let i = 0; i < n; i++) {
    const b0 = i * 2;
    const b1 = ((i + 1) % n) * 2;
    idx.push(b0, b0 + 1, b1, b1, b0 + 1, b1 + 1);
  }
  const tris = THREE.ShapeUtils.triangulateShape(pts, []);
  for (const [y, ny] of [
    [1, 1],
    [0, -1],
  ]) {
    const start = pos.length / 3;
    for (const p of pts) {
      pos.push(p.x, y, p.y);
      nor.push(0, ny, 0);
    }
    for (const [a, b, c] of tris) {
      // Face the cap outwards: check the triangle's winding against the wanted normal.
      const pa = pts[a];
      const pb = pts[b];
      const pc = pts[c];
      const cy = (pc.x - pa.x) * (pb.y - pa.y) - (pb.x - pa.x) * (pc.y - pa.y);
      if (cy * ny > 0) idx.push(start + a, start + b, start + c);
      else idx.push(start + a, start + c, start + b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  return geo;
}

const columnVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vH;
  void main() {
    vH = position.y;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

function waterMaterial(uTime) {
  return new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uTime, uSun: { value: SUN }, uDeep: { value: new THREE.Color("#04335c") }, uShallow: { value: new THREE.Color("#1fa6d6") } },
    vertexShader: columnVertex,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uSun; uniform vec3 uDeep; uniform vec3 uShallow;
      varying vec3 vWorld; varying vec3 vNormal; varying float vH;
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 N = normalize(vNormal);
        float top = step(0.5, N.y);
        vec3 col = mix(uDeep, uShallow, smoothstep(0.0, 1.0, vH));
        float wob = sin(vWorld.x * 9.0 + uTime * 0.9) * sin(vWorld.z * 8.0 - uTime * 0.7);
        col += pow(max(0.0, sin(vWorld.y * 14.0 + wob * 1.2 - uTime * 0.6)), 6.0) * 0.05 * (1.0 - top);
        float rip = sin(vWorld.x * 55.0 + uTime * 2.1) * cos(vWorld.z * 47.0 - uTime * 1.7)
                  + 0.5 * sin((vWorld.x + vWorld.z) * 90.0 - uTime * 2.7);
        vec3 Nn = normalize(mix(N, normalize(vec3(rip * 0.09, 1.0, rip * 0.07)), top));
        float spec = pow(max(dot(Nn, normalize(uSun + V)), 0.0), 90.0) * 1.4;
        float fres = pow(1.0 - max(dot(Nn, V), 0.0), 3.0);
        float diff = 0.6 + 0.4 * max(dot(Nn, uSun), 0.0);
        col = col * diff + top * 0.12 * uShallow + spec * vec3(1.0, 0.92, 0.78) + fres * 0.3 * vec3(0.75, 0.9, 1.0);
        gl_FragColor = vec4(col, 0.93);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function glassMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uSun: { value: SUN }, uHover: { value: 0 }, uSelected: { value: 0 }, uUnknown: { value: 0 } },
    vertexShader: columnVertex,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; uniform float uHover; uniform float uSelected; uniform float uUnknown;
      varying vec3 vWorld; varying vec3 vNormal; varying float vH;
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 N = normalize(vNormal);
        float fres = pow(1.0 - abs(dot(N, V)), 3.0);
        float spec = pow(max(dot(reflect(-uSun, N), V), 0.0), 40.0);
        float hl = max(uHover, uSelected);
        // Faint quarter marks etched into the glass.
        float ticks = float(gl_FrontFacing) * (1.0 - step(0.5, abs(N.y))) * smoothstep(0.012, 0.0, abs(fract(vH * 4.0 + 0.5) - 0.5)) * step(0.01, vH) * step(vH, 0.99);
        vec3 tint = mix(vec3(0.82, 0.93, 1.0), vec3(1.0, 0.86, 0.55), hl * 0.6);
        tint = mix(tint, vec3(0.7), uUnknown);
        float a = 0.05 + fres * 0.32 + spec * 0.4 + hl * 0.08 + ticks * 0.3;
        gl_FragColor = vec4(tint + spec * 0.6, clamp(a, 0.0, 0.85));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
