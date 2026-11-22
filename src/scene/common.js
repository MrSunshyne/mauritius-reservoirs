// Constants and helpers shared by the scene and its views.
import * as THREE from "three";

export const KM = 1 / 1000; // scene units are kilometres
export const EXAG = 2.2; // vertical exaggeration of the terrain
export const SUN = new THREE.Vector3(-0.55, 0.5, -0.67).normalize(); // low sun from the north-west (scene -z is north)
export const HORIZON = new THREE.Color("#e7cfb8");
export const DEEP_SEA = new THREE.Color("#082d4b");

// Metres above sea level to scene height.
export const toY = (m) => m * KM * EXAG;

const ramp = (stops) => stops.map(([v, hex]) => [v, new THREE.Color(hex)]);
const LAND = ramp([
  [0, "#d9c79b"],
  [12, "#a5b36e"],
  [80, "#7ea156"],
  [250, "#5d8a45"],
  [450, "#3f6e3a"],
  [650, "#365a33"],
  [800, "#5e5a4b"],
]);
// Sea floor by distance from the coast in metres; ends on the deep-sea plane's colour.
const LAGOON = ramp([
  [0, "#9fe3d0"],
  [450, "#3cc2c4"],
  [1300, "#1b8fae"],
  [3600, "#0c4f7a"],
  [7000, "#" + DEEP_SEA.getHexString()],
]);
const ROCK = new THREE.Color("#6f6656");

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

// Land colour from elevation and slope (rise over run): steep slopes read as bare rock.
export function landColor(h, slope, out) {
  sampleRamp(LAND, h, out);
  return out.lerp(ROCK, Math.min(1, Math.max(0, (slope - 0.35) * 1.6)));
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
