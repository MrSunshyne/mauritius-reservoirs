<script setup>
import { computed } from "vue";
import { formatDate, pct, fillColor } from "../lib/data.js";
import { dayOf, isoOf } from "../lib/playback.js";

// A time axis over every bulletin: ticks at the bulletin dates, a playhead that moves
// continuously while playing, and snapping to the nearest bulletin when dragged.
const props = defineProps({
  timeline: { type: Array, required: true },
  index: { type: Number, required: true },
  day: { type: Number, default: null }, // the continuous day while playing, else null
  total: { type: Number, default: null }, // island total shown beside the date
});
const emit = defineEmits(["seek", "play", "pause"]);

const d0 = computed(() => dayOf(props.timeline[0].date));
const d1 = computed(() => dayOf(props.timeline[props.timeline.length - 1].date));
const span = computed(() => Math.max(1, d1.value - d0.value));
const at = (d) => ((d - d0.value) / span.value) * 100;
const current = computed(() => props.day ?? dayOf(props.timeline[props.index].date));
const ticks = computed(() => props.timeline.map((e) => at(dayOf(e.date))));
const years = computed(() => {
  const out = [];
  for (let y = +props.timeline[0].date.slice(0, 4) + 1; dayOf(`${y}-01-01`) <= d1.value; y++) out.push({ y, at: at(dayOf(`${y}-01-01`)) });
  return out;
});

// Dragging lands on the nearest bulletin.
function onInput(e) {
  const d = +e.target.value;
  let best = 0;
  props.timeline.forEach((t, i) => {
    if (Math.abs(dayOf(t.date) - d) < Math.abs(dayOf(props.timeline[best].date) - d)) best = i;
  });
  emit("seek", best);
}
</script>

<template>
  <div class="flex items-center gap-4 sm:gap-6">
    <button class="w-12 shrink-0 text-left text-[11px] font-bold uppercase tracking-[0.12em] hover:underline disabled:opacity-40" :disabled="timeline.length < 2" @click="day == null ? emit('play') : emit('pause')">
      {{ day == null ? "Play" : "Pause" }}
    </button>
    <div class="relative min-w-0 flex-1">
      <input type="range" class="timeline relative z-10 w-full" :min="d0" :max="d1" step="0.01" :value="current" :aria-valuetext="formatDate(isoOf(current))" aria-label="Date" @input="onInput" />
      <div class="pointer-events-none absolute inset-x-0 top-[15px] h-1.5">
        <span v-for="(x, i) in ticks" :key="i" class="absolute top-0 h-1.5 w-px bg-[#4a4a4a]" :style="{ left: `${x}%` }"></span>
      </div>
      <div class="pointer-events-none relative h-4 text-[10px] text-muted">
        <span v-for="y in years" :key="y.y" class="absolute top-0 pl-1" :style="{ left: `${y.at}%` }">{{ y.y }}</span>
      </div>
    </div>
    <div class="w-[8.5rem] shrink-0 whitespace-nowrap text-right sm:w-[10rem]">
      <div class="font-display text-base leading-tight tabular-nums sm:text-lg">{{ formatDate(isoOf(current)) }}</div>
      <div class="text-xs text-soft">
        {{ day != null ? "interpolated" : "island" }}
        <span class="font-bold tabular-nums" :style="{ color: fillColor(total) }">{{ pct(total) }}</span>
      </div>
    </div>
  </div>
</template>
