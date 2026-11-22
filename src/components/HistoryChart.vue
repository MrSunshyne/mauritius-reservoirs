<script setup>
import { computed } from "vue";
import { formatDate, WATER, ALERT } from "../lib/data.js";
import { CRITICAL } from "../lib/model.js";

const props = defineProps({
  points: { type: Array, required: true }, // [{ date, percent, lastYear, average }]
  marker: { type: String, default: null }, // date shown as a vertical line
  height: { type: Number, default: 130 },
  width: { type: Number, default: 360 }, // viewBox width: wider charts keep their text small
  label: { type: String, default: "Fill level history" },
});

const PAD = { l: 30, r: 4, t: 8, b: 20 };
const t = (d) => Date.parse(d + "T00:00:00Z");

const view = computed(() => {
  const pts = props.points;
  const W = props.width;
  const H = props.height;
  if (!pts.length) return null;
  const t0 = t(pts[0].date);
  const t1 = Math.max(t(pts[pts.length - 1].date), t0 + 86400000);
  const x = (d) => PAD.l + ((t(d) - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (p) => PAD.t + (1 - Math.min(Math.max(p, 0), 100) / 100) * (H - PAD.t - PAD.b);
  // More than six weeks between bulletins breaks the line: nothing is known in between.
  const segs = [];
  pts.forEach((p, i) => {
    if (!i || t(p.date) - t(pts[i - 1].date) > 42 * 86400000) segs.push([]);
    segs[segs.length - 1].push(p);
  });
  const path = (s) => s.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)},${y(p.percent).toFixed(1)}`).join("");
  const marks = (key) => pts.filter((p) => p[key] != null).map((p) => ({ x: x(p.date), y: y(p[key]) }));
  const years = [];
  for (let yr = new Date(t0).getUTCFullYear() + 1; Date.UTC(yr, 0, 1) <= t1; yr++) years.push({ x: x(`${yr}-01-01`), label: yr });
  return {
    W,
    H,
    main: segs.map(path).join(""),
    singles: segs.filter((s) => s.length === 1).map(([p]) => ({ x: x(p.date), y: y(p.percent) })),
    lastYear: marks("lastYear"),
    average: marks("average"),
    grid: [0, 50, 100].map((v) => ({ v, y: y(v) })),
    critical: y(CRITICAL),
    years,
    first: formatDate(pts[0].date),
    markerX: props.marker && t(props.marker) >= t0 && t(props.marker) <= t1 ? x(props.marker) : null,
  };
});
</script>

<template>
  <figure v-if="view" class="w-full">
    <svg :viewBox="`0 0 ${view.W} ${view.H}`" class="w-full" role="img" :aria-label="label">
      <g font-size="9" fill="#666">
        <g v-for="g in view.grid" :key="g.v">
          <line :x1="PAD.l" :x2="view.W - PAD.r" :y1="g.y" :y2="g.y" stroke="#1d1d1d" />
          <text :x="PAD.l - 6" :y="g.y + 3" text-anchor="end">{{ g.v }}%</text>
        </g>
        <g v-for="yr in view.years" :key="yr.label">
          <line :x1="yr.x" :x2="yr.x" :y1="PAD.t" :y2="view.H - PAD.b" stroke="#1d1d1d" />
          <text :x="yr.x + 3" :y="view.H - 6">{{ yr.label }}</text>
        </g>
      </g>
      <line :x1="PAD.l" :x2="view.W - PAD.r" :y1="view.critical" :y2="view.critical" :stroke="ALERT" stroke-width="0.75" stroke-dasharray="2 3" />
      <circle v-for="(d, i) in view.average" :key="`a${i}`" :cx="d.x" :cy="d.y" r="1.8" fill="none" stroke="#7a7a7a" stroke-width="0.9" />
      <circle v-for="(d, i) in view.lastYear" :key="`l${i}`" :cx="d.x" :cy="d.y" r="1.5" fill="#fcfcfc" />
      <path :d="view.main" fill="none" :stroke="WATER" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
      <circle v-for="(d, i) in view.singles" :key="`s${i}`" :cx="d.x" :cy="d.y" r="1.6" :fill="WATER" />
      <line v-if="view.markerX != null" :x1="view.markerX" :x2="view.markerX" :y1="PAD.t" :y2="view.H - PAD.b" stroke="#fcfcfc" stroke-width="0.75" />
    </svg>
    <figcaption class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <span><span class="mr-1.5 inline-block h-0.5 w-3 align-middle" :style="{ background: WATER }"></span>reported</span>
      <span v-if="view.lastYear.length"><span class="mr-1.5 inline-block size-1.5 rounded-full bg-paper align-middle"></span>same day a year earlier</span>
      <span v-if="view.average.length"><span class="mr-1.5 inline-block size-2 rounded-full border border-[#7a7a7a] align-middle"></span>long-term average</span>
      <span><span class="mr-1.5 inline-block w-3 border-t border-dashed border-alert align-middle"></span>{{ CRITICAL }}%</span>
    </figcaption>
  </figure>
  <p v-else class="text-sm text-muted">No reports yet.</p>
</template>
