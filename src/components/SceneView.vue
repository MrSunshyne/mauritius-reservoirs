<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { pct, fillColor, ALERT } from "../lib/data.js";
import { CRITICAL } from "../lib/model.js";

const props = defineProps({
  reservoirs: { type: Array, required: true },
  levels: { type: Object, required: true }, // id -> level | null
  date: { type: String, required: true },
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
  () => scene.value?.setLevels(sceneLevels(), props.playing ? 240 : 700),
);
watch(
  () => props.selected,
  (id) => scene.value?.select(id),
);

// Called by the scene every rendered frame: each label sits off to the side of its
// vial, away from the middle of the group, joined to it by a leader line. Labels on
// the same side are pushed apart. DOM writes only, no Vue updates.
function placeLabels(list) {
  const box = root.value;
  if (!box) return;
  const w = box.clientWidth;
  const h = box.clientHeight;
  const shown = list.filter((l) => l.visible);
  let cx = w / 2;
  if (shown.length > 1) cx = shown.reduce((s, l) => s + l.x, 0) / shown.length;
  const reach = mobile ? 26 : 48;
  const gap = mobile ? 30 : 38;
  const placed = [];
  for (const l of [...list].sort((a, b) => a.y - b.y)) {
    const el = labelEls[l.id];
    const line = lineEls[l.id];
    const dot = dotEls[l.id];
    if (!el || !line || !dot) continue;
    if (!l.visible) {
      el.style.visibility = line.style.visibility = dot.style.visibility = "hidden";
      continue;
    }
    el.style.visibility = line.style.visibility = dot.style.visibility = "";
    // Outward from the group, unless the label would run off the edge.
    let side = shown.length === 1 || l.x >= cx ? 1 : -1;
    const width = el.offsetWidth + 6;
    if (side < 0 && l.x - reach - width < 4) side = 1;
    else if (side > 0 && l.x + reach + width > w - 4) side = -1;
    const lx = Math.min(w - 8, Math.max(8, l.x + side * reach));
    let ly = l.y - reach * 0.7;
    for (const p of placed) if (p.side === side && Math.abs(p.lx - lx) < 150 && Math.abs(p.ly - ly) < gap) ly = p.ly + gap;
    ly = Math.min(h - 20, Math.max(48, ly));
    placed.push({ side, lx, ly });
    el.style.transform = `translate3d(${lx.toFixed(1)}px, ${ly.toFixed(1)}px, 0) translate(${side > 0 ? "6px" : "calc(-100% - 6px)"}, -50%)`;
    el.style.textAlign = side > 0 ? "left" : "right";
    line.setAttribute("x1", l.x.toFixed(1));
    line.setAttribute("y1", l.y.toFixed(1));
    line.setAttribute("x2", lx.toFixed(1));
    line.setAttribute("y2", ly.toFixed(1));
    dot.setAttribute("cx", l.x.toFixed(1));
    dot.setAttribute("cy", l.y.toFixed(1));
  }
}

const short = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const staleDate = (l) => (l && l.asOf !== props.date ? short.format(new Date(l.asOf + "T00:00:00Z")) : "");
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
        class="label absolute left-0 top-0 whitespace-nowrap leading-tight"
        @click="emit('select', r.id)"
      >
        <span class="block text-[10px] font-bold uppercase tracking-[0.12em] sm:text-[11px]" :class="selected === r.id || hovered === r.id ? 'text-paper underline underline-offset-4' : 'text-soft'">{{ r.name }}</span>
        <span class="font-display text-base tabular-nums sm:text-xl" :style="{ color: (levels[r.id]?.percent ?? 100) < CRITICAL ? ALERT : '#fcfcfc' }">{{ levels[r.id] ? pct(levels[r.id].percent) : "–" }}</span>
        <span v-if="staleDate(levels[r.id])" class="ml-1.5 text-[10px] text-muted">{{ staleDate(levels[r.id]) }}</span>
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
}
</style>
