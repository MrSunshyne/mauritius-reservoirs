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

// Called by the scene every rendered frame. Each label is placed beside its vial and
// joined to it by a leader line. Candidate spots (either side, above, level, below, at
// growing distances) are scored: overlapping a placed label, covering another vial,
// a leader running through a label, crossing another leader or leaving the frame all
// cost; the cheapest spot wins. The opened lake is placed first, then top to bottom.
// DOM writes only, no Vue updates.
const inside = (r, x, y) => x > r.x0 - 2 && x < r.x1 + 2 && y > r.y0 - 2 && y < r.y1 + 2;
const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 6) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 4);
function crosses(p, q, r, s) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return d(p, q, r) * d(p, q, s) < 0 && d(r, s, p) * d(r, s, q) < 0;
}
function segmentHitsRect(a, b, r) {
  for (let k = 1; k < 10; k++) if (inside(r, a.x + ((b.x - a.x) * k) / 10, a.y + ((b.y - a.y) * k) / 10)) return true;
  return false;
}

// The layout (which side, how far, each label sits from its vial) is worked out once
// per view and size, and when the vials have moved well apart from where they were
// (the camera turned) but never while playing. In between, each label just follows
// its vial at the same offset: no flips, no jumps.
let layout = null; // { key, offsets: { id: { dx, dy, ex, ey, side } }, anchors: { id: [x, y] } }

function solveLayout(shown, w, h) {
  const top = 44; // clear of the controls along the top
  const bottom = h - 70; // and of the timeline along the bottom
  const reach = mobile ? 20 : 34;
  const cx = shown.length > 1 ? shown.reduce((s, l) => s + l.x, 0) / shown.length : w / 2;
  const order = [...shown].sort((a, b) => (a.id === props.selected ? -1 : b.id === props.selected ? 1 : a.y - b.y));
  const rects = [];
  const leaders = [];
  const offsets = {};
  for (const l of order) {
    const el = labelEls[l.id];
    if (!el) continue;
    const lw = el.offsetWidth;
    const lh = el.offsetHeight;
    const pref = l.x >= cx ? 1 : -1;
    let best = null;
    for (const k of [1, 1.7, 2.5, 3.5]) {
      for (const side of [pref, -pref]) {
        for (const dy of [-0.8, 0, 0.8, -1.8, 1.8]) {
          const ax = l.x + side * reach * k;
          const ay = l.y + dy * reach * k - reach * 0.4;
          const r = side > 0 ? { x0: ax + 4, x1: ax + 4 + lw, y0: ay - lh / 2, y1: ay + lh / 2 } : { x0: ax - 4 - lw, x1: ax - 4, y0: ay - lh / 2, y1: ay + lh / 2 };
          const end = { x: side > 0 ? r.x0 : r.x1, y: ay };
          let cost = k * 2 + Math.abs(dy) + (side === pref ? 0 : 1.5) + (layout?.offsets[l.id]?.side === side ? 0 : 2);
          if (r.x0 < 4 || r.x1 > w - 4 || r.y0 < top || r.y1 > bottom) cost += 60;
          for (const o of rects) cost += overlap(r, o) * 0.5;
          for (const o of shown) if (o !== l && inside(r, o.x, o.y)) cost += 40;
          for (const o of rects) if (segmentHitsRect(l, end, o)) cost += 40;
          for (const [p, q] of leaders) {
            if (segmentHitsRect(p, q, r)) cost += 40;
            if (crosses(l, end, p, q)) cost += 12;
          }
          if (!best || cost < best.cost) best = { cost, r, end, side };
        }
      }
    }
    rects.push(best.r);
    leaders.push([{ x: l.x, y: l.y }, best.end]);
    offsets[l.id] = { dx: best.r.x0 - l.x, dy: best.r.y0 - l.y, ex: best.end.x - l.x, ey: best.end.y - l.y, side: best.side };
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
  // How far the vials have moved relative to each other since the layout was made.
  let drift = 0;
  if (layout && layout.key === key) {
    const c = (pts) => pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length], [0, 0]);
    const now = shown.map((l) => [l.x, l.y]);
    const then = shown.map((l) => layout.anchors[l.id]);
    const [ax, ay] = c(now);
    const [bx, by] = c(then);
    drift = Math.max(...shown.map((l, i) => Math.hypot(now[i][0] - ax - (then[i][0] - bx), now[i][1] - ay - (then[i][1] - by))));
  }
  if (!layout || layout.key !== key || (drift > 45 && !props.playing)) {
    layout = { key, offsets: solveLayout(shown, w, h), anchors: Object.fromEntries(shown.map((l) => [l.id, [l.x, l.y]])) };
  }
  for (const l of list) {
    const el = labelEls[l.id];
    const line = lineEls[l.id];
    const dot = dotEls[l.id];
    if (!el || !line || !dot) continue;
    const o = layout.offsets[l.id];
    if (!l.visible || !o) {
      el.style.visibility = line.style.visibility = dot.style.visibility = "hidden";
      continue;
    }
    el.style.visibility = line.style.visibility = dot.style.visibility = "";
    el.style.transform = `translate3d(${(l.x + o.dx).toFixed(1)}px, ${(l.y + o.dy).toFixed(1)}px, 0)`;
    el.style.textAlign = o.side > 0 ? "left" : "right";
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
        class="label absolute left-0 top-0 whitespace-nowrap bg-ink/75 px-2 py-1 leading-tight"
        @click="emit('select', r.id)"
      >
        <span class="block text-[11px] font-bold uppercase tracking-[0.1em] text-paper sm:text-xs" :class="selected === r.id || hovered === r.id ? 'underline underline-offset-4' : ''">{{ r.name }}</span>
        <!-- A fixed-width figure; grey when the reservoir is not in this bulletin (its last reported level). -->
        <span class="inline-block min-w-[4.4em] font-display text-base tabular-nums sm:text-xl" :style="{ color: !levels[r.id] ? '#666' : levels[r.id].percent < CRITICAL ? ALERT : levels[r.id].stale ? '#a3a3a3' : '#fcfcfc' }">{{ levels[r.id] ? pct(levels[r.id].percent) : "–" }}</span>
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
