// The 3D view: the island's terrain, and over each reservoir a glass prism
// extruded from its real OpenStreetMap outline. The prism's height is
// proportional to the reservoir's capacity; the water inside it rises to the
// reported fill level. It is a gauge standing on the lake, not the lake's
// shoreline: there is no public bathymetry to draw a shrinking lake from.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { landDistance } from "../lib/terrain.js";

const KM = 1 / 1000;
const EXAG = 2.2; // vertical exaggeration of the terrain
const COLUMN_KM_PER_MM3 = 0.15; // prism height per million m³ of capacity
const SUN = new THREE.Vector3(-0.55, 0.5, -0.67).normalize(); // low sun from the north-west (scene -z is north)
const HORIZON = new THREE.Color("#e7cfb8");

export class ReservoirScene {
  constructor(canvas, { terrain, reservoirs, reducedMotion, mobile, onSelect, onHover, onLabels }) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.mobile = mobile;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.onLabels = onLabels;
    this.columns = new Map();
    this.hovered = null;
    this.selected = null;
    this.flight = null;
    this.dirty = true;
    this.clock = new THREE.Clock();
    this.lastInteraction = -4; // start drifting a few seconds after load

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.5 : 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = !mobile;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(HORIZON, 90, 230);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 600);

    this.#addSky();
    this.#addLights();
    this.#addTerrain(terrain);
    for (const r of reservoirs) this.#addColumn(r, terrain);
    this.#homeView();

    const controls = new OrbitControls(this.camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.2;
    controls.maxDistance = 150;
    controls.maxPolarAngle = 1.38;
    controls.screenSpacePanning = false;
    controls.autoRotateSpeed = 0.35;
    controls.target.copy(this.home.target);
    controls.addEventListener("start", () => {
      this.flight = null;
      this.lastInteraction = this.clock.getElapsedTime();
      controls.autoRotate = false;
    });
    controls.addEventListener("change", () => (this.dirty = true));
    controls.update();
    this.controls = controls;

    this.raycaster = new THREE.Raycaster();
    this.pointer = null;
    this.down = null;
    canvas.addEventListener("pointermove", this.#onPointerMove);
    canvas.addEventListener("pointerdown", this.#onPointerDown);
    canvas.addEventListener("pointerup", this.#onPointerUp);
    canvas.addEventListener("pointerleave", this.#onPointerLeave);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();

    this.visible = true;
    this.intersection = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      if (this.visible) this.dirty = true;
    });
    this.intersection.observe(canvas);

    this.renderer.setAnimationLoop(() => this.#frame());
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.intersection.disconnect();
    this.controls.dispose();
    this.canvas.removeEventListener("pointermove", this.#onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.#onPointerDown);
    this.canvas.removeEventListener("pointerup", this.#onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.#onPointerLeave);
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) [].concat(o.material).forEach((m) => m.dispose());
    });
    this.renderer.dispose();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole island in frame on tall phone screens.
    this.camera.fov = w / h < 0.8 ? 52 : 38;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  // levels: { id: { percent, lastYear, average } | null }; animates there over `ms`.
  setLevels(levels, ms = 700) {
    const now = performance.now();
    for (const [id, col] of this.columns) {
      const l = levels[id];
      col.known = l?.percent != null;
      col.from = col.current;
      col.to = col.known ? Math.max(0, Math.min(100, l.percent)) / 100 : 0;
      col.t0 = now;
      col.ms = this.reducedMotion ? 0 : ms;
      setRing(col.lastYearRing, l?.lastYear);
      setRing(col.averageRing, l?.average);
      col.glass.material.uniforms.uUnknown.value = col.known ? 0 : 1;
      col.water.visible = col.levelRing.visible = col.known;
    }
    this.dirty = true;

    function setRing(ring, pct) {
      ring.visible = pct != null;
      if (pct != null) ring.position.y = ring.userData.base + ring.userData.height * Math.min(pct, 100) / 100 + 0.004;
    }
  }

  select(id) {
    this.selected = id;
    for (const [cid, col] of this.columns) col.glass.material.uniforms.uSelected.value = cid === id ? 1 : 0;
    if (id) this.flyTo(id);
    else this.flyHome();
    this.dirty = true;
  }

  flyTo(id) {
    const col = this.columns.get(id);
    const target = col.center.clone().setY(col.base + col.height * 0.45);
    const dist = Math.max(3.2, col.height * 2.6 + col.radius * 3.2);
    // Approach from the side the camera is already on, a little above the column.
    const dir = this.camera.position.clone().sub(this.controls.target).setY(0).normalize();
    const pos = target.clone().addScaledVector(dir, dist * 0.82).setY(target.y + dist * 0.55);
    this.#fly(target, pos);
  }

  flyHome() {
    this.#fly(this.home.target.clone(), this.home.position.clone());
  }

  #fly(target, position) {
    this.lastInteraction = this.clock.getElapsedTime();
    this.controls.autoRotate = false;
    if (this.reducedMotion) {
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      this.controls.update();
      this.dirty = true;
      return;
    }
    this.flight = {
      t0: performance.now(),
      ms: 1800,
      fromTarget: this.controls.target.clone(),
      fromPos: this.camera.position.clone(),
      target,
      position,
    };
  }

  #homeView() {
    // Centre of the reservoirs, seen from the south-west so the central plateau faces the light.
    const c = new THREE.Vector3();
    for (const col of this.columns.values()) c.add(col.center);
    c.divideScalar(this.columns.size);
    c.y = 0.4;
    const target = c.clone().add(new THREE.Vector3(1, 0, -2));
    this.home = { target, position: target.clone().add(new THREE.Vector3(-14, 34, 44)) };
    this.camera.position.copy(this.home.position);
    this.camera.lookAt(target);
  }

  #frame() {
    const t = this.clock.getElapsedTime();
    const now = performance.now();
    const animated = !this.reducedMotion;

    if (this.flight) {
      const f = this.flight;
      const k = Math.min(1, (now - f.t0) / f.ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.controls.target.lerpVectors(f.fromTarget, f.target, e);
      // Arc up a little mid-flight for a smoother sense of travel.
      this.camera.position.lerpVectors(f.fromPos, f.position, e);
      this.camera.position.y += Math.sin(Math.PI * e) * f.fromPos.distanceTo(f.position) * 0.12;
      if (k >= 1) {
        this.flight = null;
        this.lastInteraction = t;
      }
      this.dirty = true;
    }

    // Calm idle drift once the visitor has left the controls alone for a while.
    if (animated && !this.flight && !this.controls.autoRotate && t - this.lastInteraction > 7) {
      this.controls.autoRotate = true;
    }

    for (const col of this.columns.values()) {
      if (col.current !== col.to) {
        const k = col.ms ? Math.min(1, (now - col.t0) / col.ms) : 1;
        const e = 1 - Math.pow(1 - k, 3);
        col.current = col.from + (col.to - col.from) * e;
        if (k >= 1) col.current = col.to;
        col.water.scale.y = Math.max(col.current, 0.0015) * col.height;
        col.levelRing.position.y = col.base + col.water.scale.y + 0.002;
        col.water.visible = col.levelRing.visible = col.known;
        this.dirty = true;
      }
    }

    this.controls.update();

    if (!this.visible || document.hidden) return;
    if (!animated && !this.dirty) return;

    this.uniforms.uTime.value = animated ? t : 0;
    this.#emitLabels();
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  }

  #emitLabels() {
    if (!this.onLabels) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const v = new THREE.Vector3();
    const out = [];
    for (const [id, col] of this.columns) {
      v.copy(col.center).setY(col.base + col.height + 0.05);
      const dist = v.distanceTo(this.camera.position);
      v.project(this.camera);
      out.push({ id, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible: v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2, dist });
    }
    this.onLabels(out);
  }

  #pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(p, this.camera);
    const hits = this.raycaster.intersectObjects([...this.columns.values()].map((c) => c.glass), false);
    return hits[0]?.object.userData.id ?? null;
  }

  #onPointerMove = (e) => {
    if (e.pointerType !== "mouse") return;
    const id = this.#pick(e);
    if (id === this.hovered) return;
    this.hovered = id;
    this.canvas.style.cursor = id ? "pointer" : "";
    for (const [cid, col] of this.columns) col.glass.material.uniforms.uHover.value = cid === id ? 1 : 0;
    this.onHover?.(id);
    this.dirty = true;
  };

  #onPointerDown = (e) => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  #onPointerUp = (e) => {
    if (!this.down) return;
    const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
    this.down = null;
    if (moved > 6) return;
    const id = this.#pick(e);
    if (id) this.onSelect?.(id);
  };

  #onPointerLeave = () => {
    if (!this.hovered) return;
    this.hovered = null;
    for (const col of this.columns.values()) col.glass.material.uniforms.uHover.value = 0;
    this.onHover?.(null);
    this.dirty = true;
  };

  #addSky() {
    const geo = new THREE.SphereGeometry(400, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { uHorizon: { value: HORIZON }, uZenith: { value: new THREE.Color("#3d6aa3") }, uSun: { value: SUN } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uHorizon; uniform vec3 uZenith; uniform vec3 uSun;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(h, 0.55));
          float sun = max(dot(normalize(vDir), uSun), 0.0);
          col += vec3(1.0, 0.75, 0.45) * (pow(sun, 18.0) * 0.35 + pow(sun, 600.0) * 2.0);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    this.scene.add(sky);
    this.sky = sky;
  }

  #addLights() {
    this.scene.add(new THREE.HemisphereLight("#b9d4ff", "#5a4630", 1.1));
    const sun = new THREE.DirectionalLight("#ffdcb0", 3.2);
    sun.position.copy(SUN).multiplyScalar(80);
    sun.castShadow = !this.mobile;
    sun.shadow.mapSize.set(4096, 4096);
    const s = sun.shadow.camera;
    s.left = -45;
    s.right = 45;
    s.top = 45;
    s.bottom = -45;
    s.near = 10;
    s.far = 180;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.uniforms = { uTime: { value: 0 } };
  }

  #addTerrain(T) {
    const { width: W, height: H, cellSize: cell } = T.meta;
    this.T = T;
    this.cx = (W * cell) / 2;
    this.cy = (H * cell) / 2;
    const dist = landDistance(T.heights, W, H);
    const step = this.mobile ? 2 : 1;
    const nx = Math.floor((W - 1) / step) + 1;
    const ny = Math.floor((H - 1) / step) + 1;
    const pos = new Float32Array(nx * ny * 3);
    const col = new Float32Array(nx * ny * 3);
    const far = new Uint8Array(nx * ny);
    const c = new THREE.Color();
    const FAR_CELLS = 7000 / cell;

    const ramp = [
      [0, "#d9c79b"],
      [12, "#a5b36e"],
      [80, "#7ea156"],
      [250, "#5d8a45"],
      [450, "#3f6e3a"],
      [650, "#365a33"],
      [800, "#5e5a4b"],
    ].map(([h, hex]) => [h, new THREE.Color(hex)]);
    const lagoon = [
      [0, "#9fe3d0"],
      [5, "#3cc2c4"],
      [14, "#1b8fae"],
      [40, "#0c4f7a"],
      [80, "#09365a"],
    ].map(([h, hex]) => [h, new THREE.Color(hex)]);

    let i = 0;
    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++, i++) {
        const r = gy * step;
        const cc = gx * step;
        const k = r * W + cc;
        const h = T.heights[k];
        const d = dist[k];
        const land = d === 0;
        const y = land ? Math.max(h, 0.5) : -Math.min(2 + d * cell * 0.012, 40);
        pos[i * 3] = (cc * cell + cell / 2 - this.cx) * KM;
        pos[i * 3 + 1] = y * KM * EXAG;
        pos[i * 3 + 2] = (r * cell + cell / 2 - this.cy) * KM;
        if (land) {
          // Steep slopes read as bare rock.
          const hx = T.heights[r * W + Math.min(cc + 1, W - 1)] - T.heights[r * W + Math.max(cc - 1, 0)];
          const hy = T.heights[Math.min(r + 1, H - 1) * W + cc] - T.heights[Math.max(r - 1, 0) * W + cc];
          const slope = Math.hypot(hx, hy) / (2 * cell);
          sampleRamp(ramp, h, c);
          c.lerp(ROCK, Math.min(1, Math.max(0, (slope - 0.35) * 1.6)));
        } else {
          sampleRamp(lagoon, d, c);
        }
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
        far[i] = d > FAR_CELLS ? 1 : 0;
      }
    }

    const idx = [];
    for (let gy = 0; gy < ny - 1; gy++) {
      for (let gx = 0; gx < nx - 1; gx++) {
        const a = gy * nx + gx;
        const b = a + 1;
        const d = a + nx;
        const e = d + 1;
        if (far[a] && far[b] && far[d] && far[e]) continue;
        idx.push(a, d, b, b, d, e);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }));
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.terrainMesh = mesh;

    // Deep ocean floor beyond the stylised shelf, and the sea surface above everything.
    const deep = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.MeshBasicMaterial({ color: "#082d4b" }));
    deep.rotation.x = -Math.PI / 2;
    deep.position.y = -40 * KM * EXAG - 0.002;
    this.scene.add(deep);
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(800, 800),
      new THREE.MeshPhysicalMaterial({ color: "#1a6f9a", transparent: true, opacity: 0.42, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.15, depthWrite: false }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = 0.0005;
    sea.receiveShadow = true;
    this.scene.add(sea);
  }

  #toScene(lon, lat) {
    const { x, y } = this.T.fromLonLat(lon, lat);
    return new THREE.Vector2((x - this.cx) * KM, (y - this.cy) * KM);
  }

  #heightAt(sx, sz) {
    const { width: W, height: H, cellSize: cell } = this.T.meta;
    const c = Math.round((sx / KM + this.cx) / cell - 0.5);
    const r = Math.round((sz / KM + this.cy) / cell - 0.5);
    return this.T.heights[Math.min(H - 1, Math.max(0, r)) * W + Math.min(W - 1, Math.max(0, c))];
  }

  #addColumn(res, T) {
    const feature = T.outlines.features.find((f) => f.properties.id === res.id);
    let ring;
    if (feature) {
      const pts = feature.geometry.coordinates[0].map(([lon, lat]) => this.#toScene(lon, lat));
      if (pts[0].equals(pts[pts.length - 1])) pts.pop();
      // ~30 m simplification, then one round of corner cutting: the glass reads as one smooth surface.
      ring = chaikin(simplify(pts, 0.03));
    } else {
      // No outline: a small hexagon at the dataset's coordinates.
      const c = this.#toScene(res.lon, res.lat);
      ring = Array.from({ length: 6 }, (_, k) => new THREE.Vector2(c.x + Math.cos((k / 6) * Math.PI * 2) * 0.3, c.y + Math.sin((k / 6) * Math.PI * 2) * 0.3));
    }

    const center = new THREE.Vector3();
    for (const p of ring) center.add(new THREE.Vector3(p.x, 0, p.y));
    center.divideScalar(ring.length);
    let radius = 0;
    for (const p of ring) radius = Math.max(radius, Math.hypot(p.x - center.x, p.y - center.z));

    // The DEM over a lake is its surface; the prism starts just below the lowest point of the shore.
    let hmin = this.#heightAt(center.x, center.z);
    for (const p of ring) hmin = Math.min(hmin, this.#heightAt(p.x, p.y));
    const base = (hmin - 4) * KM * EXAG;
    const height = res.capacity_mm3 * COLUMN_KM_PER_MM3;

    const geo = prismGeometry(ring);
    const shape = new THREE.Shape(ring.map((p) => new THREE.Vector2(p.x, -p.y)));

    const water = new THREE.Mesh(geo, waterMaterial(this.uniforms));
    water.position.y = base;
    water.scale.y = 0.0015 * height;
    water.renderOrder = 1;
    water.castShadow = true;
    water.visible = false;

    const glass = new THREE.Mesh(geo, glassMaterial(this.uniforms));
    glass.position.y = base;
    glass.scale.y = height;
    glass.renderOrder = 2;
    glass.userData.id = res.id;

    const ringPoints = ring.map((p) => new THREE.Vector3(p.x, 0, p.y));
    const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPoints);
    const rim = (color, opacity, y) => {
      const line = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      line.position.y = y;
      line.renderOrder = 3;
      return line;
    };
    const top = rim("#ffffff", 0.75, base + height);
    const bottom = rim("#ffffff", 0.35, base + 0.003);
    const dashed = (color) => {
      const line = new THREE.LineLoop(ringGeo.clone(), new THREE.LineDashedMaterial({ color, dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: 0.95, depthWrite: false }));
      line.computeLineDistances();
      line.renderOrder = 3;
      line.visible = false;
      line.userData = { base, height };
      return line;
    };
    const lastYearRing = dashed("#ffb347");
    const averageRing = dashed("#ffffff");
    // A bright line where the water meets the glass, so the level reads from afar.
    const levelRing = rim("#c8f3ff", 0.95, base);
    levelRing.visible = false;

    // The lake itself, flat on the terrain, so its real outline shows from far away.
    const lake = new THREE.Mesh(
      new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: "#1d5f86", roughness: 0.2, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    lake.position.y = base + 4 * KM * EXAG;
    lake.receiveShadow = true;

    this.scene.add(lake, water, glass, top, bottom, lastYearRing, averageRing, levelRing);
    this.columns.set(res.id, { water, glass, lastYearRing, averageRing, levelRing, center, radius, base, height, current: 0.0015, from: 0, to: 0, t0: 0, ms: 0, known: false });
  }
}

function chaikin(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push(a.clone().lerp(b, 0.25), a.clone().lerp(b, 0.75));
  }
  return out;
}

// A vertical prism of height 1 over a closed ring of (x, z) points: smooth side
// normals so the glass catches light like one curved surface, flat caps.
function prismGeometry(ring) {
  let pts = ring;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  if (area < 0) pts = [...pts].reverse();
  const n = pts.length;
  const pos = [];
  const nor = [];
  const idx = [];
  // Sides: outward normal of edge (dx, dz) is (dz, -dx) for this winding; vertex normals average both edges.
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const nx = cur.y - prev.y + (next.y - cur.y);
    const nz = -(cur.x - prev.x) - (next.x - cur.x);
    const l = Math.hypot(nx, nz) || 1;
    pos.push(cur.x, 0, cur.y, cur.x, 1, cur.y);
    nor.push(nx / l, 0, nz / l, nx / l, 0, nz / l);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = i * 2;
    const t0 = b0 + 1;
    const b1 = j * 2;
    const t1 = b1 + 1;
    idx.push(b0, t0, b1, b1, t0, t1);
  }
  // Caps.
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

const ROCK = new THREE.Color("#6f6656");

function sampleRamp(ramp, v, out) {
  if (v <= ramp[0][0]) return out.copy(ramp[0][1]);
  for (let i = 1; i < ramp.length; i++) {
    if (v <= ramp[i][0]) {
      const [h0, c0] = ramp[i - 1];
      const [h1, c1] = ramp[i];
      return out.copy(c0).lerp(c1, (v - h0) / (h1 - h0));
    }
  }
  return out.copy(ramp[ramp.length - 1][1]);
}

// Douglas-Peucker on a closed ring (without the repeated first point), tolerance in scene units (km).
// The ring is cut in two at the point farthest from the first, and each half simplified.
function simplify(points, tol) {
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

function waterMaterial(shared) {
  return new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uTime: shared.uTime, uSun: { value: SUN }, uDeep: { value: new THREE.Color("#04335c") }, uShallow: { value: new THREE.Color("#1fa6d6") } },
    vertexShader: columnVertex,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uSun; uniform vec3 uDeep; uniform vec3 uShallow;
      varying vec3 vWorld; varying vec3 vNormal; varying float vH;
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 N = normalize(vNormal);
        float top = step(0.5, N.y);
        vec3 col = mix(uDeep, uShallow, smoothstep(0.0, 1.0, vH));
        // Soft caustic bands drifting up the sides.
        float wob = sin(vWorld.x * 9.0 + uTime * 0.9) * sin(vWorld.z * 8.0 - uTime * 0.7);
        col += pow(max(0.0, sin(vWorld.y * 14.0 + wob * 1.2 - uTime * 0.6)), 6.0) * 0.05 * (1.0 - top);
        // Ripples and a sun glint on the surface.
        float rip = sin(vWorld.x * 55.0 + uTime * 2.1) * cos(vWorld.z * 47.0 - uTime * 1.7)
                  + 0.5 * sin((vWorld.x + vWorld.z) * 90.0 - uTime * 2.7);
        vec3 Nn = normalize(mix(N, normalize(vec3(rip * 0.09, 1.0, rip * 0.07)), top));
        vec3 Hh = normalize(uSun + V);
        float spec = pow(max(dot(Nn, Hh), 0.0), 90.0) * 1.4;
        float fres = pow(1.0 - max(dot(Nn, V), 0.0), 3.0);
        float diff = 0.6 + 0.4 * max(dot(Nn, uSun), 0.0);
        col = col * diff + top * 0.12 * uShallow + spec * vec3(1.0, 0.92, 0.78) + fres * 0.3 * vec3(0.75, 0.9, 1.0);
        gl_FragColor = vec4(col, 0.93);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function glassMaterial(shared) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uTime: shared.uTime, uSun: { value: SUN }, uHover: { value: 0 }, uSelected: { value: 0 }, uUnknown: { value: 0 } },
    vertexShader: columnVertex,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uSun; uniform float uHover; uniform float uSelected; uniform float uUnknown;
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
