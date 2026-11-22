<script setup>
import { computed, onBeforeUnmount, ref } from "vue";
import { formatDate, pct, levelColor } from "../lib/data.js";

const props = defineProps({
  timeline: { type: Array, required: true },
});
const index = defineModel({ type: Number, required: true });

const playing = ref(false);
let timer = null;
const STEP_MS = 260;

const entry = computed(() => props.timeline[index.value]);
const last = computed(() => props.timeline.length - 1);
const firstYear = computed(() => props.timeline[0]?.date.slice(0, 4));
const lastYear = computed(() => props.timeline[last.value]?.date.slice(0, 4));

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
  <div class="panel flex items-center gap-3 px-3 py-2.5 sm:gap-4 sm:px-4">
    <button
      class="grid size-10 shrink-0 place-items-center rounded-full bg-white text-slate-900 shadow-lg transition hover:scale-105 disabled:opacity-40"
      :aria-label="playing ? 'Pause' : 'Play the timeline'"
      :disabled="timeline.length < 2"
      @click="play"
    >
      <svg v-if="playing" viewBox="0 0 20 20" class="size-4" fill="currentColor"><path d="M5 4h3.5v12H5zM11.5 4H15v12h-3.5z" /></svg>
      <svg v-else viewBox="0 0 20 20" class="ml-0.5 size-4" fill="currentColor"><path d="M6 4l10 6-10 6z" /></svg>
    </button>
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline justify-between gap-2 text-sm">
        <span class="font-medium text-white tabular-nums">{{ formatDate(entry.date) }}</span>
        <span class="text-slate-300">
          island total
          <span class="font-semibold tabular-nums" :style="{ color: levelColor(entry.total) }">{{ pct(entry.total) }}</span>
        </span>
      </div>
      <input
        type="range"
        class="timeline mt-1 w-full"
        min="0"
        :max="last"
        step="1"
        :value="index"
        :aria-valuetext="`${formatDate(entry.date)}, island total ${pct(entry.total)}`"
        aria-label="Bulletin date"
        @input="onInput"
      />
      <div class="flex justify-between text-[10px] uppercase tracking-wider text-slate-500">
        <span>{{ firstYear }}</span>
        <span>{{ timeline.length }} bulletins</span>
        <span>{{ lastYear }}</span>
      </div>
    </div>
  </div>
</template>
