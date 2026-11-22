// Gauges: strictly the data. Each lake is drawn flat at its real outline and
// coloured by how full it is; above it floats a glass vial of the same size for
// every reservoir, filled to the reported %, with marks at 25/50/75 %, last year
// (orange) and the long-term average (white). No modelled shoreline.
import * as THREE from "three";
import { SUN, lakeShapeGeometry } from "../common.js";
import { levelColor } from "../../lib/data.js";

const H = 2.2; // vial height
const R = 0.17; // vial radius
const HOVER = 0.5; // gap between the lake and the vial
const INNER = H - 0.05;

export class GaugesView {
  name = "gauges";
  holes = false;

  constructor(core) {
    this.core = core;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.gauges = new Map();
    this.pickables = [];
    this.tickGeo = new THREE.TorusGeometry(R * 1.01, 0.0035, 6, 48).rotateX(Math.PI / 2);
    this.markGeo = new THREE.TorusGeometry(R * 1.1, 0.011, 8, 48).rotateX(Math.PI / 2);
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
    const g = this.gauges.get(lake.id);
    const s = lake.level;
    const frac = s.known ? Math.max(s.current, 0.004) : 0;
    // A level change sets the water sloshing, in proportion to the step.
    const step = frac - g.frac;
    if (Math.abs(step) > 0.002 && !this.core.reducedMotion) {
      g.slosh = Math.min(0.06, g.slosh + Math.abs(step) * 0.5);
      g.sloshT0 = performance.now();
    }
    g.frac = frac;
    g.water.scale.y = Math.max(frac, 0.0001) * INNER;
    g.water.visible = s.known;
    g.lakeMat.color.set(levelColor(s.known ? s.current * 100 : null));
    g.glass.material.uniforms.uUnknown.value = s.known ? 0 : 1;
  }

  setMarkers(lake) {
    const g = this.gauges.get(lake.id);
    for (const [mark, pct] of [
      [g.lastYear, lake.level.lastYear],
      [g.average, lake.level.average],
    ]) {
      mark.visible = pct != null;
      if (pct != null) mark.position.y = 0.025 + (INNER * Math.min(pct, 100)) / 100;
    }
  }

  setHover(id) {
    for (const [gid, g] of this.gauges) g.glass.material.uniforms.uHover.value = gid === id ? 1 : 0;
  }

  setSelected(id) {
    for (const [gid, g] of this.gauges) g.glass.material.uniforms.uSelected.value = gid === id ? 1 : 0;
  }

  labelPoint(lake, v) {
    return v.set(lake.center.x, lake.fullY + HOVER + H + 0.12, lake.center.z);
  }

  focus(lake) {
    return { target: new THREE.Vector3(lake.center.x, lake.fullY + HOVER + H * 0.4, lake.center.z), distance: Math.max(6.5, lake.radius * 3.5) };
  }

  update(t, animated) {
    let moving = false;
    const now = performance.now();
    for (const g of this.gauges.values()) {
      const u = g.waterUniforms;
      const dt = (now - g.sloshT0) / 1000;
      const amp = g.slosh * Math.exp(-dt * 2.2);
      if (amp < 0.0005) g.slosh = 0;
      else moving = true;
      // A damped sway plus, when motion is allowed, the faintest idle ripple.
      u.uTilt.value = amp * Math.sin(dt * 9) + (animated ? 0.0025 * Math.sin(t * 1.3 + g.phase) : 0);
      u.uDir.value = g.phase + (animated ? t * 0.2 : 0);
    }
    return moving;
  }

  #build(lake) {
    const lakeMat = new THREE.MeshStandardMaterial({ color: "#94a3b8", roughness: 0.35, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2 });
    const flat = new THREE.Mesh(lakeShapeGeometry(lake.ring), lakeMat);
    flat.position.y = lake.fullY;
    flat.receiveShadow = true;
    flat.userData.id = lake.id;

    const vial = new THREE.Group();
    vial.position.set(lake.center.x, lake.fullY + HOVER, lake.center.z);

    const waterUniforms = {
      uTime: this.core.uniforms.uTime,
      uSun: { value: SUN },
      uTilt: { value: 0 },
      uDir: { value: 0 },
      uMeniscus: { value: 0.018 },
      uR: { value: R * 0.86 },
    };
    const water = new THREE.Group();
    water.position.y = 0.025;
    const side = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.86, R * 0.86, 1, 40, 1, true).translate(0, 0.5, 0), vialWaterMaterial(waterUniforms, false));
    const top = new THREE.Mesh(new THREE.RingGeometry(0.0001, R * 0.86, 40, 8).rotateX(-Math.PI / 2).translate(0, 1, 0), vialWaterMaterial(waterUniforms, true));
    side.renderOrder = top.renderOrder = 1;
    water.add(side, top);

    const glass = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 48, 1, true).translate(0, H / 2, 0), vialGlassMaterial());
    glass.renderOrder = 2;
    glass.userData.id = lake.id;

    const metal = new THREE.MeshStandardMaterial({ color: "#cbd5e1", roughness: 0.35, metalness: 0.15 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.3, R * 1.45, 0.05, 40), metal);
    base.position.y = -0.005;
    const cap = new THREE.Mesh(new THREE.TorusGeometry(R * 1.02, 0.012, 8, 40).rotateX(Math.PI / 2), metal);
    cap.position.y = H;

    const tickMat = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.6, depthWrite: false });
    for (const f of [0.25, 0.5, 0.75]) {
      const tick = new THREE.Mesh(this.tickGeo, tickMat);
      tick.position.y = 0.025 + INNER * f;
      tick.renderOrder = 3;
      vial.add(tick);
    }
    const lastYear = new THREE.Mesh(this.markGeo, new THREE.MeshBasicMaterial({ color: "#ffb347" }));
    const average = new THREE.Mesh(this.markGeo, new THREE.MeshBasicMaterial({ color: "#f8fafc" }));
    average.scale.set(1.06, 1, 1.06);
    lastYear.visible = average.visible = false;
    vial.add(water, glass, base, cap, lastYear, average);

    // A thin stem from the lake up to the vial.
    const stem = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(lake.center.x, lake.fullY, lake.center.z), new THREE.Vector3(lake.center.x, lake.fullY + HOVER - 0.03, lake.center.z)]),
      new THREE.LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.45 }),
    );

    this.group.add(flat, vial, stem);
    this.pickables.push(glass, flat);
    this.gauges.set(lake.id, { water, glass, lakeMat, lastYear, average, waterUniforms, frac: 0, slosh: 0, sloshT0: 0, phase: Math.random() * 6.28 });
  }
}

// Water in the vial: a meniscus climbing the wall and a tilt that sloshes, both in
// world units so they don't stretch with the fill level.
function vialWaterMaterial(uniforms, isTop) {
  return new THREE.ShaderMaterial({
    transparent: true,
    uniforms,
    defines: isTop ? { TOP: 1 } : {},
    vertexShader: /* glsl */ `
      uniform float uTilt; uniform float uDir; uniform float uMeniscus; uniform float uR;
      varying vec3 vWorld; varying vec3 vNormal; varying float vH;
      void main() {
        vH = position.y;
        vec4 w = modelMatrix * vec4(position, 1.0);
        #ifdef TOP
          float top = 1.0;
        #else
          float top = step(0.999, position.y);
        #endif
        float rad = clamp(length(position.xz) / uR, 0.0, 1.0);
        w.y += top * (uMeniscus * pow(rad, 6.0) + uTilt * (position.x * cos(uDir) + position.z * sin(uDir)) / uR * 0.5);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uSun;
      varying vec3 vWorld; varying vec3 vNormal; varying float vH;
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 N = normalize(vNormal);
        #ifdef TOP
          vec3 col = vec3(0.55, 0.85, 0.98);
          float spec = pow(max(dot(N, normalize(uSun + V)), 0.0), 60.0);
          col += spec * 0.8;
        #else
          vec3 col = mix(vec3(0.02, 0.2, 0.42), vec3(0.12, 0.62, 0.86), smoothstep(0.0, 1.0, vH));
          // A bright band under the surface and a soft light column through the middle.
          col += smoothstep(0.92, 1.0, vH) * 0.25;
          col *= 0.75 + 0.35 * pow(abs(dot(N, V)), 0.6);
          col += pow(1.0 - abs(dot(N, V)), 3.0) * vec3(0.3, 0.5, 0.6);
        #endif
        gl_FragColor = vec4(col, 0.94);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// Thick-looking glass: strong rim, a bright streak on the lit side and a thin
// shadowed one on the other, the way light catches a real test tube.
function vialGlassMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uSun: { value: SUN }, uHover: { value: 0 }, uSelected: { value: 0 }, uUnknown: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld; varying vec3 vNormal; varying vec3 vViewN;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vViewN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; uniform float uHover; uniform float uSelected; uniform float uUnknown;
      varying vec3 vWorld; varying vec3 vNormal; varying vec3 vViewN;
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        float fres = pow(1.0 - abs(dot(N, V)), 2.5);
        float x = vViewN.x * (gl_FrontFacing ? 1.0 : -1.0);
        float streak = smoothstep(0.08, 0.0, abs(x + 0.55)) * 0.9 + smoothstep(0.04, 0.0, abs(x - 0.7)) * 0.35;
        float spec = pow(max(dot(reflect(-uSun, N), V), 0.0), 80.0);
        float hl = max(uHover, uSelected);
        vec3 tint = mix(vec3(0.85, 0.95, 1.0), vec3(1.0, 0.88, 0.6), hl * 0.7);
        tint = mix(tint, vec3(0.75), uUnknown);
        float a = 0.04 + fres * 0.55 + streak * (gl_FrontFacing ? 0.55 : 0.15) + spec * 0.6 + hl * 0.1;
        gl_FragColor = vec4(tint + streak * 0.3 + spec, clamp(a, 0.0, 0.9));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
