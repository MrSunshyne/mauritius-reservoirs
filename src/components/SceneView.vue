<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { pct, levelColor } from "../lib/data.js";

const props = defineProps({
  reservoirs: { type: Array, required: true },
  levels: { type: Object, required: true }, // id -> level | null
  selected: { type: String, default: null },
  playing: { type: Boolean, default: false },
});
const emit = defineEmits(["select"]);

const canvas = ref(null);
const labelEls = {};
const status = ref("loading"); // loading | ready | unsupported | error
const hovered = ref(null);
const scene = shallowRef(null);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
      mobile: window.matchMedia("(max-width: 767px), (pointer: coarse)").matches,
      onSelect: (id) => emit("select", id),
      onHover: (id) => (hovered.value = id),
      onLabels: placeLabels,
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

// Called by the scene every rendered frame: move the labels without going through Vue.
function placeLabels(list) {
  for (const l of list) {
    const el = labelEls[l.id];
    if (!el) continue;
    el.style.opacity = l.visible ? "" : "0";
    el.style.pointerEvents = l.visible ? "" : "none";
    el.style.transform = `translate3d(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    el.style.zIndex = String(1000 - Math.round(l.dist * 10));
  }
}

// Height of the fallback columns, proportional to capacity like the 3D prisms.
const maxCapacity = Math.max(...props.reservoirs.map((r) => r.capacity_mm3));
</script>

<template>
  <div class="relative isolate h-full w-full overflow-hidden">
    <canvas ref="canvas" class="absolute inset-0 block size-full touch-none outline-none" :class="status === 'ready' ? 'opacity-100' : 'opacity-0'" style="transition: opacity 1.2s"></canvas>

    <template v-if="status === 'ready'">
      <button
        v-for="r in reservoirs"
        :key="r.id"
        :ref="(el) => (labelEls[r.id] = el)"
        class="label absolute left-0 top-0 flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium shadow-lg transition-[opacity,background-color] duration-200"
        :class="selected === r.id || hovered === r.id ? 'bg-white text-slate-900' : 'bg-slate-950/70 text-white backdrop-blur'"
        @click="emit('select', r.id)"
      >
        <span class="size-2 rounded-full" :style="{ background: levelColor(levels[r.id]?.percent) }"></span>
        <span class="hidden sm:inline">{{ r.name }}</span>
        <span class="tabular-nums" :class="selected === r.id || hovered === r.id ? '' : 'text-slate-300'">{{ levels[r.id] ? pct(levels[r.id].percent, 0) : "?" }}</span>
      </button>
    </template>

    <div v-if="status === 'loading'" class="absolute inset-0 grid place-items-center text-sm text-slate-300">
      <div class="flex items-center gap-3"><span class="loader"></span> Raising the island…</div>
    </div>

    <!-- Without WebGL: the same prisms, flattened into columns. -->
    <div v-if="status === 'unsupported' || status === 'error'" class="absolute inset-0 flex flex-col justify-end px-4 pb-4 pt-40 md:pb-48 md:pl-[400px]">
      <p class="mb-3 text-xs text-slate-400">
        {{ status === "unsupported" ? "Your browser can't show the 3D view (no WebGL)." : "The 3D view failed to load." }}
        Columns are scaled by capacity and filled to the reported level.
      </p>
      <div class="flex h-56 items-end gap-2 sm:gap-4">
        <button v-for="r in reservoirs" :key="r.id" class="flex min-w-0 flex-1 flex-col items-center gap-1" @click="emit('select', r.id)">
          <span class="text-xs tabular-nums text-white">{{ levels[r.id] ? pct(levels[r.id].percent, 0) : "?" }}</span>
          <span class="relative w-full overflow-hidden rounded-t-md border border-white/30 bg-white/5" :class="selected === r.id ? 'ring-2 ring-white' : ''" :style="{ height: `${(r.capacity_mm3 / maxCapacity) * 170 + 8}px` }">
            <span class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-sky-700 to-sky-400 transition-[height] duration-500" :style="{ height: `${levels[r.id]?.percent ?? 0}%` }"></span>
          </span>
          <span class="w-full truncate text-center text-[10px] text-slate-300">{{ r.name }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.label {
  will-change: transform;
}
.loader {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid rgb(255 255 255 / 0.2);
  border-top-color: #fff;
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .loader {
    animation: none;
  }
}
</style>
