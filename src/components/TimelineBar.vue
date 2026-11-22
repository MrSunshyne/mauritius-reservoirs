<script setup>
import { computed, onBeforeUnmount, ref } from "vue";
import { formatDate, pct, fillColor } from "../lib/data.js";

const props = defineProps({
  timeline: { type: Array, required: true },
});
const index = defineModel({ type: Number, required: true });

const playing = ref(false);
let timer = null;
const STEP_MS = 260;

const entry = computed(() => props.timeline[index.value]);
const last = computed(() => props.timeline.length - 1);
// Year boundaries along the slider, as tick marks.
const years = computed(() => {
  const out = [];
  props.timeline.forEach((e, i) => {
    const y = e.date.slice(0, 4);
    if (i === 0 || props.timeline[i - 1].date.slice(0, 4) !== y) out.push({ y, at: (i / Math.max(1, last.value)) * 100 });
  });
  return out;
});

function play() {
  if (playing.value) return stop();
  if (index.value >= last.value) index.value = 0;
  playing.value = true;
  timer = setInterval(() => {
    if (index.value >= last.value) return stop();
    index.value++;
  }, STEP_MS);
}
function stop() {
  playing.value = false;
  clearInterval(timer);
}
function onInput(e) {
  stop();
  index.value = +e.target.value;
}
onBeforeUnmount(stop);
</script>

<template>
  <div class="flex items-center gap-4 sm:gap-6">
    <button class="w-12 shrink-0 text-left text-[11px] font-bold uppercase tracking-[0.12em] hover:underline disabled:opacity-40" :disabled="timeline.length < 2" @click="play">
      {{ playing ? "Pause" : "Play" }}
    </button>
    <div class="min-w-0 flex-1">
      <div class="relative">
        <input
          type="range"
          class="timeline w-full"
          min="0"
          :max="last"
          step="1"
          :value="index"
          :aria-valuetext="`${formatDate(entry.date)}, island total ${pct(entry.total)}`"
          aria-label="Bulletin date"
          @input="onInput"
        />
        <div class="pointer-events-none relative h-4 text-[10px] text-muted">
          <span v-for="y in years" :key="y.y" class="absolute top-0 border-l border-line pl-1" :style="{ left: `${y.at}%` }">{{ y.y }}</span>
        </div>
      </div>
    </div>
    <div class="shrink-0 text-right">
      <div class="font-display text-base leading-tight sm:text-lg">{{ formatDate(entry.date) }}</div>
      <div class="text-xs text-soft">
        island <span class="font-bold" :style="{ color: fillColor(entry.total) }">{{ pct(entry.total) }}</span>
      </div>
    </div>
  </div>
</template>
