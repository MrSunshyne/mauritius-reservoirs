<script setup>
import { computed } from "vue";
import HistoryChart from "./HistoryChart.vue";
import { formatDate, pct, mm3, levelColor } from "../lib/data.js";

const props = defineProps({
  reservoir: { type: Object, required: true },
  level: { type: Object, default: null }, // timeline level for the selected date, or null
  history: { type: Array, required: true },
  date: { type: String, required: true },
});
defineEmits(["close"]);

const r = computed(() => props.reservoir);
const l = computed(() => props.level);
const delta = (a, b) => (a == null || b == null ? null : a - b);
const signed = (v) => (v == null ? "" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)} pts`);
const vsLastYear = computed(() => delta(l.value?.percent, l.value?.lastYear));
const vsAverage = computed(() => delta(l.value?.percent, l.value?.average));
const meta = computed(() => [r.value.district, r.value.purpose, r.value.built && `built ${r.value.built}`].filter(Boolean).join(" · "));
</script>

<template>
  <article class="panel flex flex-col gap-4 p-5" :aria-label="`${r.name} reservoir`">
    <header class="flex items-start justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold tracking-tight text-white">{{ r.name }}</h2>
        <p v-if="meta" class="text-xs text-slate-400">{{ meta }}</p>
      </div>
      <button class="-mr-2 -mt-1 rounded-full p-2 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Close" @click="$emit('close')">
        <svg viewBox="0 0 20 20" class="size-4" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l10 10M15 5L5 15" /></svg>
      </button>
    </header>

    <div v-if="l" class="flex items-end gap-4">
      <div class="whitespace-nowrap text-4xl font-semibold tabular-nums leading-none sm:text-5xl" :style="{ color: levelColor(l.percent) }">{{ pct(l.percent) }}</div>
      <div class="pb-1 text-sm leading-snug text-slate-300">
        <div>{{ l.volumeEstimated ? "≈ " : "" }}{{ mm3(l.volume) }} stored</div>
        <div class="text-slate-400">of {{ mm3(r.capacity_mm3) }} capacity</div>
      </div>
    </div>
    <p v-else class="text-sm text-slate-300">No level reported for {{ r.name }} up to {{ formatDate(date) }}.</p>

    <p v-if="l?.stale" class="rounded-md bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
      Not in the {{ formatDate(date) }} bulletin: last reported on {{ formatDate(l.asOf) }}.
    </p>

    <dl v-if="l && (l.lastYear != null || l.average != null)" class="grid grid-cols-2 gap-3 text-sm">
      <div v-if="l.lastYear != null" class="rounded-lg bg-white/5 px-3 py-2">
        <dt class="text-xs text-slate-400">Same date last year</dt>
        <dd class="tabular-nums text-white">{{ pct(l.lastYear) }} <span class="text-xs" :class="vsLastYear < 0 ? 'text-rose-300' : 'text-emerald-300'">{{ signed(vsLastYear) }}</span></dd>
      </div>
      <div v-if="l.average != null" class="rounded-lg bg-white/5 px-3 py-2">
        <dt class="text-xs text-slate-400">Long-term average</dt>
        <dd class="tabular-nums text-white">{{ pct(l.average) }} <span class="text-xs" :class="vsAverage < 0 ? 'text-rose-300' : 'text-emerald-300'">{{ signed(vsAverage) }}</span></dd>
      </div>
    </dl>

    <HistoryChart :points="history" :marker="date" :label="`${r.name} fill level history`" />

    <p v-if="r.notes" class="text-xs leading-relaxed text-slate-400">{{ r.notes }}</p>

    <footer v-if="l" class="flex flex-col gap-2 border-t border-white/10 pt-3 text-xs text-slate-400">
      <div>
        <span v-if="l.reading.verified" class="inline-flex items-center gap-1 rounded-full bg-emerald-400/15 px-2 py-0.5 font-medium text-emerald-300" title="All seven reservoirs reported and their capacity-weighted total matches the reported total, or a second source agrees">
          <svg viewBox="0 0 16 16" class="size-3" fill="currentColor"><path d="M6.5 11.2 3.3 8l1.1-1.1 2.1 2.1 5.1-5.1L12.7 5z" /></svg>
          Verified bulletin
        </span>
        <span v-else class="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 font-medium text-slate-300" title="Not cross-checked: either a single source, or not all seven reservoirs were reported">Single source, not cross-checked</span>
        <span class="ml-1">bulletin of {{ formatDate(l.asOf) }}</span>
      </div>
      <ul class="flex flex-col gap-1">
        <li v-for="s in l.reading.sources" :key="s.url">
          <a :href="s.url" target="_blank" rel="noopener" class="underline decoration-white/30 underline-offset-2 hover:text-white">{{ s.name }}</a>
          <span v-if="s.published"> · published {{ formatDate(s.published) }}</span>
        </li>
      </ul>
      <a v-if="r.source" :href="r.source" target="_blank" rel="noopener" class="underline decoration-white/30 underline-offset-2 hover:text-white">Source for the capacity and details</a>
    </footer>
  </article>
</template>
