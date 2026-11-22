<script setup>
import { computed } from "vue";
import HistoryChart from "./HistoryChart.vue";
import { formatDate, pct, mm3, pts, fillColor } from "../lib/data.js";

const props = defineProps({
  reservoir: { type: Object, required: true },
  summary: { type: Object, default: null }, // reservoirSummary(), null if never reported
  history: { type: Array, required: true },
  date: { type: String, required: true },
});
defineEmits(["close"]);

const r = computed(() => props.reservoir);
const s = computed(() => props.summary);
const facts = computed(() => [r.value.district, r.value.built && `built ${r.value.built}`, `holds ${mm3(r.value.capacity_mm3)}`].filter(Boolean).join(" · "));
const less = (v) => (v < 0 ? `${mm3(-v)} less` : `${mm3(v)} more`);
const reported = computed(() => {
  const v = s.value;
  if (!v) return "";
  if (!v.skipped) return `Reported in the bulletin of ${formatDate(v.asOf)}.`;
  return `Left out of the last ${v.skipped === 1 ? "bulletin" : `${v.skipped} bulletins`}: this is its level on ${formatDate(v.asOf)}.`;
});
</script>

<template>
  <article class="flex flex-col" :aria-label="`${r.name} reservoir`">
    <button class="kicker self-start hover:text-paper" @click="$emit('close')">← All reservoirs</button>

    <h2 class="mt-5 font-display text-4xl leading-none tracking-tight">{{ r.name }}</h2>
    <p class="mt-2 text-sm text-soft">{{ facts }}</p>

    <template v-if="s">
      <div class="mt-6 flex items-baseline gap-4">
        <span class="font-display text-6xl leading-none tabular-nums" :style="{ color: s.critical ? fillColor(s.percent) : undefined }">{{ pct(s.percent) }}</span>
        <span class="text-sm text-soft">{{ s.volumeEstimated ? "about " : "" }}{{ mm3(s.volume) }} of {{ mm3(r.capacity_mm3) }}</span>
      </div>
      <p class="mt-3 text-sm" :class="s.skipped ? 'text-paper' : 'text-soft'">{{ reported }}</p>
      <p v-if="s.supplies" class="mt-3 text-sm text-soft">{{ s.supplies }}</p>

      <dl class="mt-6 border-t border-line text-sm">
        <div v-if="s.lastYearCmp" class="flex items-baseline justify-between gap-4 border-b border-line py-3">
          <dt class="text-soft">Same day a year earlier</dt>
          <dd class="text-right tabular-nums">{{ pct(s.lastYearCmp.ref) }}<span class="block text-xs text-muted">{{ pts(s.lastYearCmp.pts) }} · {{ less(s.lastYearCmp.mm3) }}</span></dd>
        </div>
        <div v-if="s.averageCmp" class="flex items-baseline justify-between gap-4 border-b border-line py-3">
          <dt class="text-soft">Long-term average</dt>
          <dd class="text-right tabular-nums">{{ pct(s.averageCmp.ref) }}<span class="block text-xs text-muted">{{ pts(s.averageCmp.pts) }} · {{ less(s.averageCmp.mm3) }}</span></dd>
        </div>
        <div v-if="s.pace" class="flex items-baseline justify-between gap-4 border-b border-line py-3">
          <dt class="text-soft">Pace over 30 days</dt>
          <dd class="text-right tabular-nums">{{ pts(s.pace.perWeek) }} a week</dd>
        </div>
      </dl>
      <p v-if="s.pace?.reaches20" class="mt-3 text-sm text-soft">
        At that pace it would be down to {{ pct(20, 0) }} around <span class="text-paper">{{ formatDate(s.pace.reaches20) }}</span>. A straight line through {{ s.pace.points }} reports: it ignores rain and changes in use.
      </p>
    </template>
    <p v-else class="mt-6 text-sm text-soft">Not reported in any bulletin up to {{ formatDate(date) }}.</p>

    <div class="mt-8">
      <p class="kicker mb-3">Reported levels</p>
      <HistoryChart :points="history" :marker="date" :label="`${r.name} fill level history`" />
    </div>

    <div v-if="s" class="mt-6 border-t border-line pt-4 text-xs text-muted">
      <p>
        {{ s.reading.verified ? "Cross-checked bulletin" : "Single source, not cross-checked" }} of {{ formatDate(s.asOf) }}:
        <template v-for="(src, k) in s.reading.sources" :key="src.url">
          <a :href="src.url" target="_blank" rel="noopener" class="underline underline-offset-2 hover:text-paper">{{ src.name }}</a
          >{{ k < s.reading.sources.length - 1 ? ", " : "." }}
        </template>
      </p>
      <p class="mt-2">Terrain: Land Drainage Authority MNT 2021 (1 m), via Moris 3D. The basin under the water is modelled, not surveyed.</p>
    </div>
  </article>
</template>
