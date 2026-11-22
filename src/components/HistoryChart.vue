<script setup>
import { computed } from "vue";
import { formatDate, levelColor } from "../lib/data.js";

const props = defineProps({
  points: { type: Array, required: true }, // [{ date, percent, lastYear, average }]
  marker: { type: String, default: null }, // date shown as a vertical line
  height: { type: Number, default: 120 },
  label: { type: String, default: "Fill level history" },
});

const W = 320;
const PAD = { l: 26, r: 6, t: 8, b: 18 };
const t = (d) => Date.parse(d + "T00:00:00Z");

const view = computed(() => {
  const pts = props.points;
  const H = props.height;
  if (!pts.length) return null;
  const t0 = t(pts[0].date);
  const t1 = Math.max(t(pts[pts.length - 1].date), t0 + 86400000);
  const x = (d) => PAD.l + ((t(d) - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (p) => PAD.t + (1 - Math.min(Math.max(p, 0), 100) / 100) * (H - PAD.t - PAD.b);
  const line = (key) => {
    let d = "";
    let pen = false;
    for (const p of pts) {
      if (p[key] == null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(p.date).toFixed(1)},${y(p[key]).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const last = pts[pts.length - 1];
  const markerX = props.marker && t(props.marker) >= t0 && t(props.marker) <= t1 ? x(props.marker) : null;
  return {
    H,
    main: line("percent"),
    lastYear: line("lastYear"),
    average: line("average"),
    area: `${line("percent")}L${x(last.date).toFixed(1)},${y(0)}L${x(pts[0].date).toFixed(1)},${y(0)}Z`,
    dots: pts.length < 40 ? pts.map((p) => ({ x: x(p.date), y: y(p.percent) })) : [],
    grid: [0, 50, 100].map((v) => ({ v, y: y(v) })),
    first: formatDate(pts[0].date),
    lastDate: formatDate(last.date),
    markerX,
    color: levelColor(last.percent),
    hasLastYear: pts.some((p) => p.lastYear != null),
    hasAverage: pts.some((p) => p.average != null),
  };
});
</script>

<template>
  <figure v-if="view" class="w-full">
    <svg :viewBox="`0 0 ${W} ${view.H}`" class="w-full" role="img" :aria-label="label">
      <g class="text-slate-500" font-size="8" fill="currentColor">
        <g v-for="g in view.grid" :key="g.v">
          <line :x1="PAD.l" :x2="W - PAD.r" :y1="g.y" :y2="g.y" stroke="currentColor" stroke-opacity="0.25" stroke-width="0.5" />
          <text :x="PAD.l - 4" :y="g.y + 3" text-anchor="end">{{ g.v }}%</text>
        </g>
        <text :x="PAD.l" :y="view.H - 4">{{ view.first }}</text>
        <text :x="W - PAD.r" :y="view.H - 4" text-anchor="end">{{ view.lastDate }}</text>
      </g>
      <path :d="view.area" :fill="view.color" fill-opacity="0.12" />
      <path v-if="view.average" :d="view.average" fill="none" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="3 2.5" stroke-opacity="0.8" />
      <path v-if="view.lastYear" :d="view.lastYear" fill="none" stroke="#ffb347" stroke-width="1" stroke-dasharray="1.5 2" />
      <path :d="view.main" fill="none" :stroke="view.color" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />
      <circle v-for="(d, i) in view.dots" :key="i" :cx="d.x" :cy="d.y" r="1.8" :fill="view.color" />
      <line v-if="view.markerX != null" :x1="view.markerX" :x2="view.markerX" :y1="PAD.t" :y2="view.H - PAD.b" stroke="#fff" stroke-opacity="0.6" stroke-width="0.8" />
    </svg>
    <figcaption class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
      <span><span class="inline-block h-0.5 w-3 align-middle" :style="{ background: view.color }"></span> reported</span>
      <span v-if="view.hasLastYear"><span class="inline-block w-3 border-t border-dotted border-[#ffb347] align-middle"></span> same date last year</span>
      <span v-if="view.hasAverage"><span class="inline-block w-3 border-t border-dashed border-slate-200 align-middle"></span> long-term average</span>
    </figcaption>
  </figure>
  <p v-else class="text-sm text-slate-400">No history yet.</p>
</template>
