<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { pct, fillColor, ALERT } from "../lib/data.js";
import { CRITICAL } from "../lib/model.js";

const props = defineProps({
  reservoirs: { type: Array, required: true },
  levels: { type: Object, required: true }, // id -> level | null
  selected: { type: String, default: null },
  playing: { type: Boolean, default: false },
});
const emit = defineEmits(["select", "closeup"]);

const root = ref(null);
const canvas = ref(null);
const labelEls = {};
const lineEls = {};
const dotEls = {};
const status = ref("loading"); // loading | ready | unsupported | error
const hovered = ref(null);
const scene = shallowRef(null);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const mobile = window.matchMedia("(max-width: 767px), (pointer: coarse)").matches;

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function sceneLevels() {
  return Object.fromEntries(props.reservoirs.map((r) => [r.id, props.levels[r.id]]));
}

onMounted(async () => {
  if (!webglAvailable()) {
    status.value = "unsupported";
    return;
  }
  try {
    const [{ loadTerrain }, { ReservoirScene }] = await Promise.all([import("../lib/terrain.js"), import("../scene/reservoir-scene.js")]);
    const terrain = await loadTerrain();
    if (!canvas.value) return;
    scene.value = new ReservoirScene(canvas.value, {
      terrain,
      reservoirs: props.reservoirs,
      reducedMotion,
      mobile,
      onSelect: (id) => emit("select", id),
      onHover: (id) => (hovered.value = id),
      onLabels: placeLabels,
      onCloseUp: (state) => emit("closeup", state),
    });
    scene.value.setLevels(sceneLevels(), 1400);
    if (props.selected) scene.value.select(props.selected);
    status.value = "ready";
  } catch (err) {
    console.error(err);
    status.value = "error";
  }
});

onBeforeUnmount(() => scene.value?.dispose());

watch(
  () => props.levels,
  // While playing the levels already move continuously, frame by frame: no tween on top.
  () => scene.value?.setLevels(sceneLevels(), props.playing ? 0 : 700),
);
watch(
  () => props.selected,
  (id) => scene.value?.select(id),
);
watch(
  () => props.playing,
  (on) => scene.value?.setPlaying(on),
);

// Labels. Each sits beside its vial, joined to it by a leader line, at an offset from
// the vial chosen by scoring candidate spots (either side; above, level or below; at
// growing distances): overlapping another label, covering another vial, a leader
// through a label, crossing leaders or leaving the frame all cost, and staying on the
// side it already had is cheaper. Midlands and Piton du Milieu, 2.5 km apart, have
// fixed preferred sides so they never trade places.
//
// The offsets are kept from frame to frame and only worked out again when something
// actually collides (or the view or size changes), never while playing (the idle
// drift is held then, so nothing moves). Labels glide to new spots rather than jump.
// DOM writes only, no Vue updates.
const PREFERRED = { "piton-du-milieu": { side: -1, up: true }, midlands: { side: 1, up: false } };
const GAP = 4; // pixels kept between labels
const inside = (r, x, y) => x > r.x0 - 2 && x < r.x1 + 2 && y > r.y0 - 2 && y < r.y1 + 2;
const intersects = (a, b) => a.x0 < b.x1 + GAP && b.x0 < a.x1 + GAP && a.y0 < b.y1 + GAP && b.y0 < a.y1 + GAP;
const overlapArea = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + GAP) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + GAP);
function crosses(p, q, r, s) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return d(p, q, r) * d(p, q, s) < 0 && d(r, s, p) * d(r, s, q) < 0;
}
function segmentHitsRect(a, b, r) {
  for (let k = 1; k < 10; k++) if (inside(r, a.x + ((b.x - a.x) * k) / 10, a.y + ((b.y - a.y) * k) / 10)) return true;
  return false;
}

let layout = null; // { key, target: { id: offset }, shown: Set }
const current = {}; // the offsets on screen, gliding towards layout.target
let cooldown = 0; // frames to wait before trying again when no layout is free of collisions

const rectAt = (l, o) => ({ x0: l.x + o.dx, y0: l.y + o.dy, x1: l.x + o.dx + o.w, y1: l.y + o.dy + o.h });
const endAt = (l, o) => ({ x: l.x + o.ex, y: l.y + o.ey });

function bounds(h) {
  return { top: 44, bottom: h - 70 }; // clear of the controls along the top and the timeline along the bottom
}

// How many collisions the layout has at the vials' current positions (0: none).
function conflicts(shown, offsets, w, h) {
  const { top, bottom } = bounds(h);
  const items = shown.filter((l) => offsets[l.id]).map((l) => ({ l, r: rectAt(l, offsets[l.id]), e: endAt(l, offsets[l.id]) }));
  let n = 0;
  for (const a of items) {
    if (a.r.x0 < 2 || a.r.x1 > w - 2 || a.r.y0 < top - 8 || a.r.y1 > bottom + 8) n++;
    for (const b of items) {
      if (a === b) continue;
      if (intersects(a.r, b.r)) n += 2;
      if (inside(a.r, b.l.x, b.l.y) || segmentHitsRect(b.l, b.e, a.r)) n++;
    }
  }
  return n;
}

// The opened lake first, then by height on screen, by left to right, and by distance
// from the middle: the order with the fewest collisions wins (ties: fewest labels
// changing side).
function solveLayout(shown, w, h) {
  const first = (cmp) => [...shown].sort((a, b) => (a.id === props.selected ? -1 : b.id === props.selected ? 1 : cmp(a, b)));
  const cx = shown.reduce((s, l) => s + l.x, 0) / Math.max(1, shown.length);
  const cy = shown.reduce((s, l) => s + l.y, 0) / Math.max(1, shown.length);
  const orders = [first((a, b) => a.y - b.y), first((a, b) => a.x - b.x), first((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy)), first((a, b) => b.y - a.y)];
  let best = null;
  for (const order of orders) {
    const offsets = solveInOrder(shown, w, h, order);
    const score = conflicts(shown, offsets, w, h) * 100 + shown.filter((l) => layout?.target[l.id] && layout.target[l.id].side !== offsets[l.id]?.side).length;
    if (!best || score < best.score) best = { score, offsets };
  }
  return best.offsets;
}

// Greedy placement in a given order; solveLayout() tries a few orders and keeps the best.
function solveInOrder(shown, w, h, order) {
  const { top, bottom } = bounds(h);
  const reach = mobile ? 20 : 34;
  const cx = shown.length > 1 ? shown.reduce((s, l) => s + l.x, 0) / shown.length : w / 2;
  const placed = [];
  const offsets = {};
  for (const l of order) {
    const el = labelEls[l.id];
    if (!el) continue;
    const lw = el.offsetWidth;
    const lh = el.offsetHeight;
    const fixed = PREFERRED[l.id];
    const pref = fixed?.side ?? (l.x >= cx ? 1 : -1);
    const was = layout?.target[l.id];
    let best = null;
    const consider = (r, end, side, base) => {
      let cost = base + (was && was.side !== side ? 3 : 0);
      if (r.x0 < 4 || r.x1 > w - 4 || r.y0 < top || r.y1 > bottom) cost += 80;
      for (const p of placed) {
        if (intersects(r, p.r)) cost += 300 + overlapArea(r, p.r);
        if (segmentHitsRect(l, end, p.r) || segmentHitsRect(p.l, p.end, r)) cost += 100;
        if (crosses(l, end, p.l, p.end)) cost += 15;
      }
      for (const o of shown) if (o !== l && inside(r, o.x, o.y)) cost += 60;
      if (!best || cost < best.cost) best = { cost, r, end, side };
    };
    for (const k of [1, 1.7, 2.5, 3.5, 4.6]) {
      // Beside the vial, either side.
      for (const side of [pref, -pref]) {
        for (const dy of [-0.8, 0, 0.8, -1.8, 1.8, -2.8, 2.8]) {
          const ax = l.x + side * reach * k;
          const ay = l.y + dy * reach * k - reach * 0.4;
          const r = side > 0 ? { x0: ax + 4, x1: ax + 4 + lw, y0: ay - lh / 2, y1: ay + lh / 2 } : { x0: ax - 4 - lw, x1: ax - 4, y0: ay - lh / 2, y1: ay + lh / 2 };
          let base = k * 2 + Math.abs(dy) + (side === pref ? 0 : fixed ? 6 : 1.5);
          if (fixed && dy !== 0 && dy < 0 !== fixed.up) base += 1.5;
          consider(r, { x: side > 0 ? r.x0 : r.x1, y: ay }, side, base);
        }
      }
      // Stacked straight above or below it, centred: for the edges of the frame.
      for (const up of [true, false]) {
        const gap = reach * k * 0.8;
        const r = up ? { x0: l.x - lw / 2, x1: l.x + lw / 2, y0: l.y - gap - lh, y1: l.y - gap } : { x0: l.x - lw / 2, x1: l.x + lw / 2, y0: l.y + gap, y1: l.y + gap + lh };
        consider(r, { x: l.x, y: up ? r.y1 : r.y0 }, 0, k * 2 + 4 + (fixed ? 6 : 0));
      }
    }
    placed.push({ l, r: best.r, end: best.end });
    offsets[l.id] = { dx: best.r.x0 - l.x, dy: best.r.y0 - l.y, ex: best.end.x - l.x, ey: best.end.y - l.y, side: best.side, w: lw, h: lh };
  }
  return offsets;
}

function placeLabels(list) {
  const box = root.value;
  if (!box) return;
  const w = box.clientWidth;
  const h = box.clientHeight;
  const shown = list.filter((l) => l.visible);
  const key = `${w}x${h}|${props.selected}|${shown.map((l) => l.id).join()}`;
  const fresh = !layout || layout.key !== key;
  if (cooldown > 0) cooldown--;
  const now = fresh ? 0 : conflicts(shown, layout.target, w, h);
  if (fresh || (!props.playing && cooldown === 0 && now > 0)) {
    const target = solveLayout(shown, w, h);
    // Move only to something better; if nothing is (a crowded framing), try again later.
    if (fresh || conflicts(shown, target, w, h) < now) layout = { key, target };
    else cooldown = 20;
  }
  for (const l of list) {
    const el = labelEls[l.id];
    const line = lineEls[l.id];
    const dot = dotEls[l.id];
    if (!el || !line || !dot) continue;
    const t = layout.target[l.id];
    if (!l.visible || !t) {
      el.style.visibility = line.style.visibility = dot.style.visibility = "hidden";
      delete current[l.id];
      continue;
    }
    // Glide towards the target spot (straight there with reduced motion or on a fresh view).
    const c = current[l.id];
    if (!c || fresh || reducedMotion) current[l.id] = { ...t };
    else for (const k of ["dx", "dy", "ex", "ey"]) c[k] += (t[k] - c[k]) * 0.2;
    const o = current[l.id];
    el.style.visibility = line.style.visibility = dot.style.visibility = "";
    el.style.transform = `translate3d(${(l.x + o.dx).toFixed(1)}px, ${(l.y + o.dy).toFixed(1)}px, 0)`;
    el.style.textAlign = t.side > 0 ? "left" : t.side < 0 ? "right" : "center";
    line.setAttribute("x1", l.x.toFixed(1));
    line.setAttribute("y1", l.y.toFixed(1));
    line.setAttribute("x2", (l.x + o.ex).toFixed(1));
    line.setAttribute("y2", (l.y + o.ey).toFixed(1));
    dot.setAttribute("cx", l.x.toFixed(1));
    dot.setAttribute("cy", l.y.toFixed(1));
  }
}
</script>

<template>
  <div ref="root" class="relative isolate h-full w-full overflow-hidden">
    <canvas ref="canvas" class="absolute inset-0 block size-full touch-none outline-none" :class="status === 'ready' ? 'opacity-100' : 'opacity-0'" style="transition: opacity 1s"></canvas>

    <template v-if="status === 'ready'">
      <svg class="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
        <g v-for="r in reservoirs" :key="r.id">
          <line :ref="(el) => (lineEls[r.id] = el)" stroke="#fcfcfc" stroke-opacity="0.55" stroke-width="1" />
          <circle :ref="(el) => (dotEls[r.id] = el)" r="2" fill="#fcfcfc" />
        </g>
      </svg>
      <button
        v-for="r in reservoirs"
        :key="r.id"
        :ref="(el) => (labelEls[r.id] = el)"
        class="label absolute left-0 top-0 whitespace-nowrap bg-ink/75 px-1.5 py-0.5 leading-tight sm:px-2 sm:py-1"
        @click="emit('select', r.id)"
      >
        <span class="block text-[10px] font-bold uppercase tracking-[0.08em] text-paper sm:text-xs sm:tracking-[0.1em]" :class="selected === r.id || hovered === r.id ? 'underline underline-offset-4' : ''">{{ r.name }}</span>
        <!-- A fixed-width figure; grey when the reservoir is not in this bulletin (its last reported level). -->
        <span class="inline-block min-w-[4.4em] font-display text-sm tabular-nums sm:text-xl" :style="{ color: !levels[r.id] ? '#666' : levels[r.id].percent < CRITICAL ? ALERT : levels[r.id].stale ? '#a3a3a3' : '#fcfcfc' }">{{ levels[r.id] ? pct(levels[r.id].percent) : "–" }}</span>
      </button>
    </template>

    <p v-if="status === 'loading'" class="absolute inset-0 grid place-items-center text-sm text-muted">Loading the terrain…</p>

    <!-- Without WebGL: one column per reservoir, filled to its level. -->
    <div v-if="status === 'unsupported' || status === 'error'" class="absolute inset-0 flex flex-col justify-end p-4 sm:p-8">
      <p class="mb-4 max-w-md text-sm text-soft">
        {{ status === "unsupported" ? "This browser can't draw the 3D view (no WebGL)." : "The 3D view failed to load." }}
        Each column is one reservoir, filled to its last reported level.
      </p>
      <div class="flex h-56 items-end gap-2 sm:gap-4">
        <button v-for="r in reservoirs" :key="r.id" class="flex min-w-0 flex-1 flex-col items-stretch gap-2 text-left" @click="emit('select', r.id)">
          <span class="font-display text-sm tabular-nums" :style="{ color: (levels[r.id]?.percent ?? 100) < CRITICAL ? ALERT : '#fcfcfc' }">{{ levels[r.id] ? pct(levels[r.id].percent, 0) : "–" }}</span>
          <span class="relative h-40 border border-line" :class="selected === r.id ? 'border-paper' : ''">
            <span class="absolute inset-x-0 bottom-0" :style="{ height: `${levels[r.id]?.percent ?? 0}%`, background: fillColor(levels[r.id]?.percent) }"></span>
          </span>
          <span class="truncate text-[10px] uppercase tracking-[0.08em] text-soft">{{ r.name }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.label {
  will-change: transform;
  /* A soft dark halo keeps the text readable over bright terrain. */
  text-shadow:
    0 0 3px rgb(0 0 0 / 0.9),
    0 0 10px rgb(0 0 0 / 0.6);
}
</style>
