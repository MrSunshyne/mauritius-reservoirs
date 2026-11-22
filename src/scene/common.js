// Constants and helpers shared by the scene, the basins, the vials and the close-up.
import * as THREE from "three";
import { TERRAIN_EXAG } from "../lib/model.js";

export const KM = 1 / 1000; // scene units are kilometres
export const EXAG = TERRAIN_EXAG;
export const SUN = new THREE.Vector3(-0.55, 0.5, -0.67).normalize(); // low sun from the north-west (scene -z is north)
export const BACKGROUND = new THREE.Color("#0a0a0a");
export const DEEP_SEA = new THREE.Color("#0b2233");

// Metres above sea level to scene height.
export const toY = (m) => m * KM * EXAG;

const ramp = (stops) => stops.map(([v, hex]) => [v, new THREE.Color(hex)]);
// Moris 3D's "natural" palette (mauritius-elevations/web/app/engine/palettes.js).
export const LAND_STOPS = [
  [0, "#b4bd84"],
  [4, "#9db470"],
  [25, "#86aa5f"],
  [150, "#6c9a53"],
  [300, "#558849"],
  [500, "#497944"],
  [650, "#456f3f"],
  [780, "#596e4a"],
  [850, "#6c7358"],
];
const LAND = ramp(LAND_STOPS);
// Sea floor by distance from the coast in metres; ends on the deep-sea plane's colour.
const LAGOON = ramp([
  [0, "#a9e2d6"],
  [300, "#6fcfc8"],
  [900, "#2e9ab8"],
  [2500, "#11577e"],
  [7000, "#" + DEEP_SEA.getHexString()],
]);
export const ROCK = new THREE.Color("#68625a");

function sampleRamp(stops, v, out) {
  if (v <= stops[0][0]) return out.copy(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [h0, c0] = stops[i - 1];
      const [h1, c1] = stops[i];
      return out.copy(c0).lerp(c1, (v - h0) / (h1 - h0));
    }
  }
  return out.copy(stops[stops.length - 1][1]);
}

// Land colour from elevation and slope (rise over run): slopes of 28-50 degrees turn to rock.
export function landColor(h, slope, out) {
  sampleRamp(LAND, h, out);
  const t = Math.min(1, Math.max(0, (slope - 0.53) / 0.66));
  return out.lerp(ROCK, t * t * (3 - 2 * t) * 0.8);
}

export function seaColor(coastMetres, out) {
  return sampleRamp(LAGOON, coastMetres, out);
}

// Douglas-Peucker on a closed ring (without the repeated first point), tolerance in scene units.
// The ring is cut in two at the point farthest from the first, and each half simplified.
export function simplify(points, tol) {
  if (points.length < 8) return points;
  const n = points.length;
  let far = 0;
  for (let i = 1; i < n; i++) if (points[i].distanceTo(points[0]) > points[far].distanceTo(points[0])) far = i;
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = keep[n - 1] = 1;
  const stack = [
    [0, far],
    [far, n - 1],
  ];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0;
    let at = -1;
    const pa = points[a];
    const pb = points[b];
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * points[i].x - dx * points[i].y + pb.x * pa.y - pb.y * pa.x) / len;
      if (d > max) {
        max = d;
        at = i;
      }
    }
    if (max > tol && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// One round of corner cutting.
export function chaikin(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push(a.clone().lerp(b, 0.25), a.clone().lerp(b, 0.75));
  }
  return out;
}

export function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distToRing(ring, x, y) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1e-12)));
    best = Math.min(best, Math.hypot(a.x + t * dx - x, a.y + t * dy - y));
  }
  return best;
}

// The lake outline as a THREE.Shape in (x, -z): rotateX(-90°) maps it back onto the ground.
export function lakeShapeGeometry(ring) {
  const geo = new THREE.ShapeGeometry(new THREE.Shape(ring.map((p) => new THREE.Vector2(p.x, -p.y))));
  return geo.rotateX(-Math.PI / 2);
}

function catmullRom(p0, p1, p2, p3, t) {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

// Smooth sample of a W x H grid; fx, fy are cell coordinates, (0, 0) the centre of the first cell.
export function sampleBicubic(arr, W, H, fx, fy) {
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const cc = (c) => (c < 0 ? 0 : c >= W ? W - 1 : c);
  const row = (r) => {
    const o = (r < 0 ? 0 : r >= H ? H - 1 : r) * W;
    return catmullRom(arr[o + cc(ix - 1)], arr[o + cc(ix)], arr[o + cc(ix + 1)], arr[o + cc(ix + 2)], tx);
  };
  return catmullRom(row(iy - 1), row(iy), row(iy + 1), row(iy + 2), ty);
}

// Flat, rippling water seen from above: used by the basins.
export function flatWaterMaterial(uTime) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime, uSun: { value: SUN }, uColor: { value: new THREE.Color("#0f5f8f") }, uSky: { value: new THREE.Color("#a9d4ef") } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uSun; uniform vec3 uColor; uniform vec3 uSky;
      varying vec3 vWorld;
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        vec2 p = vWorld.xz * 60.0;
        float rip = sin(p.x * 1.3 + uTime * 1.7) * cos(p.y * 1.1 - uTime * 1.3) + 0.5 * sin((p.x + p.y) * 2.1 - uTime * 2.3);
        // Fade ripples where they would be smaller than a pixel, so far lakes don't shimmer.
        float fw = fwidth(p.x) + fwidth(p.y);
        rip *= 1.0 - smoothstep(0.6, 2.0, fw);
        vec3 N = normalize(vec3(rip * 0.06, 1.0, rip * 0.05));
        float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
        float spec = pow(max(dot(N, normalize(uSun + V)), 0.0), 120.0);
        vec3 col = mix(uColor, uSky, fres * 0.7) + spec * vec3(1.0, 0.9, 0.75) * 1.3;
        gl_FragColor = vec4(col, 0.9);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// Level-volume curve of a modelled basin: depths (metres below the full level) of the
// cells inside the lake, each cellArea m². Returns the depth below full at which the
// water holds a given fraction of the basin's volume.
export function levelCurve(depths, cellArea, D, samples = 128) {
  const vol = new Float64Array(samples + 1);
  for (let j = 0; j <= samples; j++) {
    const h = (D * j) / samples;
    let v = 0;
    for (let i = 0; i < depths.length; i++) if (depths[i] > h) v += (depths[i] - h) * cellArea;
    vol[j] = v;
  }
  return (frac) => {
    const target = frac * vol[0];
    if (target >= vol[0]) return 0;
    for (let j = 1; j <= samples; j++) {
      if (vol[j] <= target) {
        const t = (vol[j - 1] - target) / (vol[j - 1] - vol[j] || 1);
        return (D * (j - 1 + t)) / samples;
      }
    }
    return D;
  };
}

// GLSL for the dry bed of a basin, shared by the island and the close-up. Expects
// uWater, uFull, uRing (scene heights) and uDeep (scene depth over which silt darkens).
export const BED_GLSL = /* glsl */ `
  vec2 bedHash(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
  float bedCracks(vec2 x) {
    vec2 n = floor(x); vec2 f = fract(x); float d1 = 8.0; float d2 = 8.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j)); vec2 r = g + bedHash(n + g) - f; float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
    return sqrt(d2) - sqrt(d1);
  }
  // Colours are linear (the renderer converts to sRGB): brown mud drying paler up the
  // bank, a pale bathtub ring just below the full level, a dark wet band at the
  // waterline, and silt that darkens with depth under the water.
  vec3 bedColor(vec3 world, float uWater, float uFull, float uRing, float uDeep, float crackScale) {
    float y = world.y;
    vec2 p = world.xz * crackScale;
    // Cracks fade out where a cell would be smaller than a few pixels, so they never shimmer.
    float fade = 1.0 - smoothstep(0.15, 0.6, fwidth(p.x) + fwidth(p.y));
    float crack = mix(1.0, 0.35 + 0.65 * smoothstep(0.0, 0.16, bedCracks(p)), fade);
    vec3 mud = mix(vec3(0.17, 0.11, 0.065), vec3(0.3, 0.21, 0.13), smoothstep(uWater, uFull, y)) * crack;
    float ring = smoothstep(uFull - uRing, uFull - uRing * 0.55, y);
    vec3 col = mix(mud, vec3(0.72, 0.69, 0.6), ring);
    float wet = 1.0 - smoothstep(uWater, uWater + uRing * 0.35, y);
    col = mix(col, vec3(0.06, 0.045, 0.03), wet * 0.8);
    if (y < uWater) col = mix(vec3(0.09, 0.08, 0.05), vec3(0.01, 0.025, 0.035), clamp((uWater - y) / uDeep, 0.0, 1.0));
    return col;
  }
`;
