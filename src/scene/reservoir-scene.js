// The 3D view: the island's terrain and its seven reservoirs at their real
// OpenStreetMap outlines. Each lake has a modelled basin (basins.js) and a glass vial
// above it (vials.js); opening one shows a 1 m close-up block (closeup.js). The scene
// owns what they share: terrain, camera, picking, labels and each lake's animated level.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { landDistance } from "../lib/terrain.js";
import { KM, SUN, BACKGROUND, DEEP_SEA, toY, landColor, seaColor, simplify, chaikin, pointInRing, distToRing, sampleBicubic } from "./common.js";
import { Basins } from "./basins.js";
import { Vials } from "./vials.js";
import { CloseUp } from "./closeup.js";

const SEA_FLOOR_MAX = 40; // metres: stylised shelf, not real bathymetry
const DEEP_PLANE = -70; // metres: well below the shelf, so the two never fight for the same depth

export class ReservoirScene {
  constructor(canvas, { terrain, reservoirs, reducedMotion, mobile, onSelect, onHover, onLabels, onCloseUp }) {
    this.canvas = canvas;
    this.T = terrain;
    this.reducedMotion = reducedMotion;
    this.mobile = mobile;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.onLabels = onLabels;
    this.onCloseUp = onCloseUp;
    this.hovered = null;
    this.selected = null;
    this.flight = null;
    this.dirty = true;
    this.t0 = performance.now();
    this.lastInteraction = -4; // start drifting a few seconds after load
    this.uniforms = { uTime: { value: 0 } };

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.5 : 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;

    // The island floats on the page's near-black, the sea fading into it with distance.
    this.scene = new THREE.Scene();
    this.scene.background = BACKGROUND;
    this.fog = new THREE.Fog(BACKGROUND, 70, 200);
    this.scene.fog = this.fog;
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 600);

    const { width: W, height: H, cellSize } = terrain.meta;
    this.cx = (W * cellSize) / 2;
    this.cy = (H * cellSize) / 2;
    this.lakes = new Map(reservoirs.map((r) => [r.id, this.#prepareLake(r)]));

    this.#addLights();
    this.#addTerrain();
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
      this.lastInteraction = this.#elapsed();
      controls.autoRotate = false;
    });
    controls.addEventListener("change", () => (this.dirty = true));
    controls.update();
    this.controls = controls;

    this.basins = new Basins(this);
    this.vials = new Vials(this);
    this.closeup = new CloseUp(this);
    this.terrainMesh.geometry.setIndex(this.holedIndex);
    this.pickables = [...this.basins.pickables, ...this.vials.pickables];

    this.raycaster = new THREE.Raycaster();
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
    this.closeup.close();
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

  #setLevel(lake) {
    this.basins.setLevel(lake);
    this.vials.setLevel(lake);
    this.closeup.setLevel(lake);
  }

  // levels: { id: { percent, lastYear, average } | null }; animates there over `ms`.
  setLevels(levels, ms = 700) {
    const now = performance.now();
    for (const lake of this.lakes.values()) {
      const l = levels[lake.id];
      const s = lake.level;
      s.known = l?.percent != null;
      s.from = s.current;
      s.to = s.known ? Math.max(0, Math.min(100, l.percent)) / 100 : 0;
      s.t0 = now;
      s.ms = this.reducedMotion ? 0 : ms;
      s.lastYear = l?.lastYear ?? null;
      s.average = l?.average ?? null;
      this.vials.setMarkers(lake);
      this.#setLevel(lake);
    }
    this.dirty = true;
  }

  // Opens a lake's close-up (null: back to the island). The camera heads for the lake on
  // the island straight away, then frames the block once its 1 m terrain has loaded.
  select(id) {
    this.selected = id;
    this.vials.setSelected(id);
    if (!id) {
      this.closeup.close();
      this.onCloseUp?.(null);
      this.flyHome();
      return;
    }
    const lake = this.lakes.get(id);
    if (this.closeup.id !== id) this.#focus(this.basins.focus(lake));
    this.onCloseUp?.({ id, loading: true });
    this.closeup
      .open(lake)
      .then((f) => {
        if (!f || this.selected !== id) return;
        this.#focus(f);
        this.onCloseUp?.({ id, loading: false });
      })
      .catch((err) => {
        console.error(err);
        this.onCloseUp?.({ id, loading: false, error: true });
      });
    this.dirty = true;
  }

  // Hide or show the island around a close-up.
  setIslandVisible(on) {
    this.terrainMesh.visible = this.sea.visible = this.deep.visible = on;
    this.dirty = true;
  }

  flyHome() {
    this.#fly(this.home.target.clone(), this.home.position.clone());
  }

  // Terrain height in metres at scene (x, z), smooth.
  heightAt(x, z) {
    const { width: W, height: H, cellSize: cell } = this.T.meta;
    return sampleBicubic(this.T.heights, W, H, (x / KM + this.cx) / cell - 0.5, (z / KM + this.cy) / cell - 0.5);
  }

  // Land colour at scene (x, z), as the terrain paints it.
  colorAt(x, z, out) {
    const h = this.heightAt(x, z);
    const e = 0.06;
    const slope = Math.hypot(this.heightAt(x + e, z) - this.heightAt(x - e, z), this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e * 1000);
    return landColor(h, slope, out);
  }

  #focus(f) {
    const dir = this.camera.position.clone().sub(this.controls.target).setY(0).normalize();
    const pos = f.target.clone().addScaledVector(dir, f.distance * 0.82).setY(f.target.y + f.distance * 0.55);
    this.#fly(f.target, pos);
  }

  #fly(target, position) {
    this.lastInteraction = this.#elapsed();
    this.controls.autoRotate = false;
    if (this.reducedMotion) {
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      this.controls.update();
      this.dirty = true;
      return;
    }
    this.flight = { t0: performance.now(), ms: 1800, fromTarget: this.controls.target.clone(), fromPos: this.camera.position.clone(), target, position };
  }

  #homeView() {
    // Centre of the reservoirs, seen from the south-west so the central plateau faces the light.
    const c = new THREE.Vector3();
    for (const lake of this.lakes.values()) c.add(lake.center);
    c.divideScalar(this.lakes.size);
    c.y = 0.4;
    const target = c.clone().add(new THREE.Vector3(1, 0, 3));
    this.home = { target, position: target.clone().add(new THREE.Vector3(-14, 34, 44)) };
    this.camera.position.copy(this.home.position);
    this.camera.lookAt(target);
  }

  #elapsed() {
    return (performance.now() - this.t0) / 1000;
  }

  #frame() {
    const t = this.#elapsed();
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
    if (animated && !this.flight && !this.controls.autoRotate && t - this.lastInteraction > 7) this.controls.autoRotate = true;

    for (const lake of this.lakes.values()) {
      const s = lake.level;
      if (s.current === s.to) continue;
      const k = s.ms ? Math.min(1, (now - s.t0) / s.ms) : 1;
      s.current = k >= 1 ? s.to : s.from + (s.to - s.from) * (1 - Math.pow(1 - k, 3));
      this.#setLevel(lake);
      this.dirty = true;
    }

    this.controls.update();
    if (this.vials.update(t, animated)) this.dirty = true;

    if (!this.visible || document.hidden) return;
    if (!animated && !this.dirty) return;

    // Depth precision follows the camera: a fixed 5 cm near plane left only ~4 m of
    // depth resolution at island distance, so the sea surface and the coastal terrain
    // (and the shelf and the deep-sea plane) fought for the same pixels: the coast flickered.
    const dist = this.camera.position.distanceTo(this.controls.target);
    const near = Math.min(4, Math.max(0.02, dist * 0.05));
    if (Math.abs(near - this.camera.near) > near * 0.02) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }

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
    for (const lake of this.lakes.values()) {
      this.vials.labelPoint(lake, v);
      const dist = v.distanceTo(this.camera.position);
      v.project(this.camera);
      const shown = !this.closeup.id || this.closeup.id === lake.id;
      out.push({ id: lake.id, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible: shown && v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2, dist });
    }
    this.onLabels(out);
  }

  #pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(p, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    return hits[0]?.object.userData.id ?? null;
  }

  #onPointerMove = (e) => {
    if (e.pointerType !== "mouse") return;
    const id = this.#pick(e);
    if (id === this.hovered) return;
    this.hovered = id;
    this.canvas.style.cursor = id ? "pointer" : "";
    this.vials.setHover(id);
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
    this.vials.setHover(null);
    this.onHover?.(null);
    this.dirty = true;
  };

  #toScene(lon, lat) {
    const { x, y } = this.T.fromLonLat(lon, lat);
    return new THREE.Vector2((x - this.cx) * KM, (y - this.cy) * KM);
  }

  // Outline, centre and surface level of a reservoir, in scene units.
  #prepareLake(res) {
    const feature = this.T.outlines.features.find((f) => f.properties.id === res.id);
    let ring;
    if (feature) {
      const pts = feature.geometry.coordinates[0].map(([lon, lat]) => this.#toScene(lon, lat));
      if (pts[0].equals(pts[pts.length - 1])) pts.pop();
      // ~30 m simplification, then one round of corner cutting: smooth, but still the real outline.
      ring = chaikin(simplify(pts, 0.03));
    } else {
      // No outline: a small hexagon at the dataset's coordinates.
      const c = this.#toScene(res.lon, res.lat);
      ring = Array.from({ length: 6 }, (_, k) => new THREE.Vector2(c.x + Math.cos((k / 6) * Math.PI * 2) * 0.3, c.y + Math.sin((k / 6) * Math.PI * 2) * 0.3));
    }
    // Orient counter-clockwise in (x, z) so outward normals are consistent for every view.
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      area += a.x * b.y - b.x * a.y;
    }
    if (area < 0) ring.reverse();

    const c = new THREE.Vector2();
    for (const p of ring) c.add(p);
    c.divideScalar(ring.length);
    let radius = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of ring) {
      radius = Math.max(radius, p.distanceTo(c));
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.y);
      maxZ = Math.max(maxZ, p.y);
    }
    // The DEM over a lake is its surface when surveyed: take the median inside as the full level.
    const inside = [];
    const step = 0.03;
    for (let x = minX; x <= maxX; x += step) for (let z = minZ; z <= maxZ; z += step) if (pointInRing(ring, x, z)) inside.push(this.heightAt(x, z));
    inside.sort((a, b) => a - b);
    const fullM = inside.length ? inside[inside.length >> 1] : this.heightAt(c.x, c.y);
    let shoreMinM = fullM;
    for (const p of ring) shoreMinM = Math.min(shoreMinM, this.heightAt(p.x, p.y));

    return {
      id: res.id,
      res,
      ring,
      center: new THREE.Vector3(c.x, toY(fullM), c.y),
      radius,
      bbox: { minX, maxX, minZ, maxZ },
      fullM,
      fullY: toY(fullM),
      shoreMinM,
      capacity: res.capacity_mm3,
      level: { current: 0, from: 0, to: 0, t0: 0, ms: 0, known: false, lastYear: null, average: null },
    };
  }

  #addLights() {
    this.hemi = new THREE.HemisphereLight("#b9d4ff", "#5a4630", 1.1);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight("#ffdcb0", 3.2);
    sun.position.copy(SUN).multiplyScalar(80);
    sun.castShadow = !this.mobile;
    this.islandSun = sun;
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 10, far: 180 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);
  }

  #addTerrain() {
    const T = this.T;
    const { width: W, height: H, cellSize: cell } = T.meta;
    const dist = landDistance(T.heights, W, H);
    const step = this.mobile ? 2 : 1;
    const nx = Math.floor((W - 1) / step) + 1;
    const ny = Math.floor((H - 1) / step) + 1;
    const pos = new Float32Array(nx * ny * 3);
    const col = new Float32Array(nx * ny * 3);
    const far = new Uint8Array(nx * ny);
    const c = new THREE.Color();
    const FAR = 7000;

    let i = 0;
    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++, i++) {
        const r = gy * step;
        const cc = gx * step;
        const k = r * W + cc;
        const h = T.heights[k];
        const coast = dist[k] * cell;
        const land = coast === 0;
        // The sea floor drops 4 m right at the coast, then shelves gently: no land-sea
        // triangle lies almost flat at sea level, where it would fight the sea surface.
        const y = land ? Math.max(h, 0.5) : -Math.min(4 + coast * 0.012, SEA_FLOOR_MAX);
        pos[i * 3] = (cc * cell + cell / 2 - this.cx) * KM;
        pos[i * 3 + 1] = toY(y);
        pos[i * 3 + 2] = (r * cell + cell / 2 - this.cy) * KM;
        if (land) {
          const hx = T.heights[r * W + Math.min(cc + 1, W - 1)] - T.heights[r * W + Math.max(cc - 1, 0)];
          const hy = T.heights[Math.min(r + 1, H - 1) * W + cc] - T.heights[Math.max(r - 1, 0) * W + cc];
          landColor(h, Math.hypot(hx, hy) / (2 * cell), c);
        } else {
          seaColor(coast, c);
        }
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
        far[i] = coast > FAR ? 1 : 0;
      }
    }

    // Quads under each lake (with a margin): the basins view replaces them with its own mesh.
    const q = step * cell * KM;
    const x0 = (cell / 2 - this.cx) * KM;
    const z0 = (cell / 2 - this.cy) * KM;
    const hole = new Uint8Array((nx - 1) * (ny - 1));
    for (const lake of this.lakes.values()) {
      const { minX, maxX, minZ, maxZ } = lake.bbox;
      const m = q * 0.75;
      const gx0 = Math.max(0, Math.floor((minX - m - x0) / q) - 1);
      const gx1 = Math.min(nx - 2, Math.ceil((maxX + m - x0) / q) + 1);
      const gy0 = Math.max(0, Math.floor((minZ - m - z0) / q) - 1);
      const gy1 = Math.min(ny - 2, Math.ceil((maxZ + m - z0) / q) + 1);
      lake.quads = [];
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const pts = [
            [0.5, 0.5],
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ];
          const near = pts.some(([u, v]) => {
            const x = x0 + (gx + u) * q;
            const z = z0 + (gy + v) * q;
            return pointInRing(lake.ring, x, z) || distToRing(lake.ring, x, z) <= m;
          });
          if (near) {
            lake.quads.push([gx, gy]);
            hole[gy * (nx - 1) + gx] = 1;
          }
        }
      }
    }

    const full = [];
    const holed = [];
    for (let gy = 0; gy < ny - 1; gy++) {
      for (let gx = 0; gx < nx - 1; gx++) {
        const a = gy * nx + gx;
        const b = a + 1;
        const d = a + nx;
        const e = d + 1;
        if (far[a] && far[b] && far[d] && far[e]) continue;
        full.push(a, d, b, b, d, e);
        if (!hole[gy * (nx - 1) + gx]) holed.push(a, d, b, b, d, e);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.fullIndex = new THREE.BufferAttribute(new Uint32Array(full), 1);
    this.holedIndex = new THREE.BufferAttribute(new Uint32Array(holed), 1);
    geo.setIndex(this.fullIndex);
    geo.computeVertexNormals();
    this.grid = { nx, ny, q, x0, z0, pos, col, nor: geo.attributes.normal.array };

    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }));
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.terrainMesh = mesh;

    this.deep = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.MeshBasicMaterial({ color: DEEP_SEA }));
    this.deep.rotation.x = -Math.PI / 2;
    this.deep.position.y = toY(DEEP_PLANE);
    this.scene.add(this.deep);
    this.sea = new THREE.Mesh(
      new THREE.PlaneGeometry(800, 800),
      new THREE.MeshPhysicalMaterial({ color: "#1a6f9a", transparent: true, opacity: 0.42, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.15, depthWrite: false }),
    );
    this.sea.rotation.x = -Math.PI / 2;
    this.sea.receiveShadow = true;
    this.scene.add(this.sea);
  }
}
