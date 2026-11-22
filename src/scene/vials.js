// A glass vial floating above each lake, the same size for every reservoir, filled to
// the reported %: the level reads at island scale, where the basins are a few pixels
// wide. Marks at 25/50/75 %, a white ring for the same date last year and a grey one
// for the long-term average. In the close-up the vial stands on the ground beside the lake.
import * as THREE from "three";
import { SUN } from "./common.js";

const H = 2.2; // vial height
const R = 0.17; // vial radius
const HOVER = 0.5; // gap between the lake and the vial
const INNER = H - 0.05;

export class Vials {
  constructor(core) {
    this.core = core;
    this.group = new THREE.Group();
    this.vials = new Map();
    this.pickables = [];
    this.tickGeo = new THREE.TorusGeometry(R * 1.01, 0.0035, 6, 48).rotateX(Math.PI / 2);
    this.markGeo = new THREE.TorusGeometry(R * 1.1, 0.011, 8, 48).rotateX(Math.PI / 2);
    for (const lake of core.lakes.values()) this.#build(lake);
    core.scene.add(this.group);
  }

  setLevel(lake) {
    const g = this.vials.get(lake.id);
    const s = lake.level;
    const frac = s.known ? Math.max(s.current, 0.004) : 0;
    // A level change sets the water sloshing, in proportion to the step.
    const step = frac - g.frac;
    // Only a jump (a new bulletin) does; continuous playback moves it smoothly, in place.
    if (Math.abs(step) > 0.002 && lake.level.ms > 0) {
      g.slosh = Math.min(0.06, g.slosh + Math.abs(step) * 0.5);
      g.sloshT0 = performance.now();
    }
    g.frac = frac;
    g.water.scale.y = Math.max(frac, 0.0001) * INNER;
    g.water.visible = s.known;
    g.glass.material.uniforms.uUnknown.value = s.known ? 0 : 1;
  }

  setMarkers(lake) {
    const g = this.vials.get(lake.id);
    for (const [mark, pct] of [
      [g.lastYear, lake.level.lastYear],
      [g.average, lake.level.average],
    ]) {
      mark.visible = pct != null;
      if (pct != null) mark.position.y = 0.025 + (INNER * Math.min(pct, 100)) / 100;
    }
  }

  setHover(id) {
    for (const [gid, g] of this.vials) g.glass.material.uniforms.uHover.value = gid === id ? 1 : 0;
  }

  setSelected(id) {
    for (const [gid, g] of this.vials) g.glass.material.uniforms.uSelected.value = gid === id ? 1 : 0;
  }

  // Where a lake's label points: the top of its vial.
  labelPoint(lake, v) {
    const g = this.vials.get(lake.id);
    return v.copy(g.vial.position).setY(g.vial.position.y + H * g.vial.scale.y + 0.08 * g.vial.scale.y);
  }

  // Stand a vial somewhere else (the close-up) at a given scale, or put it back with null.
  place(id, position, scale = 1) {
    const g = this.vials.get(id);
    if (position) {
      g.vial.position.copy(position);
      g.vial.scale.setScalar(scale);
      g.stem.visible = false;
    } else {
      g.vial.position.copy(g.home);
      g.vial.scale.setScalar(1);
      g.stem.visible = true;
    }
  }

  // Show only one lake's vial (the close-up), or all of them with null.
  isolate(id) {
    for (const [gid, g] of this.vials) g.vial.visible = g.stem.visible = !id || gid === id;
    if (id) this.vials.get(id).stem.visible = false;
  }

  update(t, animated) {
    let moving = false;
    const now = performance.now();
    for (const g of this.vials.values()) {
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
    const vial = new THREE.Group();
    const home = new THREE.Vector3(lake.center.x, lake.fullY + HOVER, lake.center.z);
    vial.position.copy(home);

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

    const metal = new THREE.MeshStandardMaterial({ color: "#d4d4d4", roughness: 0.35, metalness: 0.15 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.3, R * 1.45, 0.05, 40), metal);
    base.position.y = -0.005;
    base.castShadow = true;
    const cap = new THREE.Mesh(new THREE.TorusGeometry(R * 1.02, 0.012, 8, 40).rotateX(Math.PI / 2), metal);
    cap.position.y = H;

    const tickMat = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.6, depthWrite: false });
    for (const f of [0.25, 0.5, 0.75]) {
      const tick = new THREE.Mesh(this.tickGeo, tickMat);
      tick.position.y = 0.025 + INNER * f;
      tick.renderOrder = 3;
      vial.add(tick);
    }
    const lastYear = new THREE.Mesh(this.markGeo, new THREE.MeshBasicMaterial({ color: "#fcfcfc" }));
    const average = new THREE.Mesh(this.markGeo, new THREE.MeshBasicMaterial({ color: "#7a7a7a" }));
    average.scale.set(1.06, 1, 1.06);
    lastYear.visible = average.visible = false;
    vial.add(water, glass, base, cap, lastYear, average);

    // A thin stem from the lake up to the vial.
    const stem = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(lake.center.x, lake.fullY, lake.center.z), new THREE.Vector3(lake.center.x, lake.fullY + HOVER - 0.03, lake.center.z)]),
      new THREE.LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.45 }),
    );

    this.group.add(vial, stem);
    this.pickables.push(glass);
    this.vials.set(lake.id, { vial, stem, home, water, glass, lastYear, average, waterUniforms, frac: 0, slosh: 0, sloshT0: 0, phase: Math.random() * 6.28 });
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
