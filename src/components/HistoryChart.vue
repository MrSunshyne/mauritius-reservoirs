<script setup>
import { computed } from "vue";
import { formatDate, levelColor } from "../lib/data.js";

const props = defineProps({
  points: { type: Array, required: true }, // [{ date, percent, lastYear, average }]
  marker: { type: String, default: null }, // date shown as a vertical line
  height: { type: Number, default: 120 },
  width: { type: Number, default: 320 }, // viewBox width: wider charts keep their text small
  label: { type: String, default: "Fill level history" },
});

const PAD = { l: 26, r: 6, t: 8, b: 18 };
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
  // A gap of more than six weeks between bulletins breaks the line: nothing is known in between.
  const segs = [];
  pts.forEach((p, i) => {
    if (!i || t(p.date) - t(pts[i - 1].date) > 42 * 86400000) segs.push([]);
    segs[segs.length - 1].push(p);
  });
  const path = (s) => s.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)},${y(p.percent).toFixed(1)}`).join("");
  // Comparisons come with only some bulletins, so they are marks, not lines.
  const marks = (key) => pts.filter((p) => p[key] != null).map((p) => ({ x: x(p.date), y: y(p[key]) }));
  const last = pts[pts.length - 1];
  return {
    W,
    H,
    main: segs.map(path).join(""),
    lastYear: marks("lastYear"),
    average: marks("average"),
    area: segs.map((s) => `${path(s)}L${x(s[s.length - 1].date).toFixed(1)},${y(0)}L${x(s[0].date).toFixed(1)},${y(0)}Z`).join(""),
    dots: pts.length < 40 ? pts.map((p) => ({ x: x(p.date), y: y(p.percent) })) : segs.filter((s) => s.length === 1).map(([p]) => ({ x: x(p.date), y: y(p.percent) })),
    grid: [0, 50, 100].map((v) => ({ v, y: y(v) })),
    first: formatDate(pts[0].date),
    lastDate: formatDate(last.date),
    markerX: props.marker && t(props.marker) >= t0 && t(props.marker) <= t1 ? x(props.marker) : null,
    color: levelColor(last.percent),
  };
});
</script>

<template>
  <figure v-if="view" class="w-full">
    <svg :viewBox="`0 0 ${view.W} ${view.H}`" class="w-full" role="img" :aria-label="label">
      <g class="text-slate-500" font-size="8" fill="currentColor">
        <g v-for="g in view.grid" :key="g.v">
          <line :x1="PAD.l" :x2="view.W - PAD.r" :y1="g.y" :y2="g.y" stroke="currentColor" stroke-opacity="0.25" stroke-width="0.5" />
          <text :x="PAD.l - 4" :y="g.y + 3" text-anchor="end">{{ g.v }}%</text>
        </g>
        <text :x="PAD.l" :y="view.H - 4">{{ view.first }}</text>
        <text :x="view.W - PAD.r" :y="view.H - 4" text-anchor="end">{{ view.lastDate }}</text>
      </g>
      <path :d="view.area" :fill="view.color" fill-opacity="0.12" />
      <path :d="view.main" fill="none" :stroke="view.color" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
      <circle v-for="(d, i) in view.dots" :key="i" :cx="d.x" :cy="d.y" r="1.8" :fill="view.color" />
      <circle v-for="(d, i) in view.average" :key="`a${i}`" :cx="d.x" :cy="d.y" r="1.6" fill="none" stroke="#e2e8f0" stroke-width="0.8" />
      <circle v-for="(d, i) in view.lastYear" :key="`l${i}`" :cx="d.x" :cy="d.y" r="1.6" fill="#ffb347" />
      <line v-if="view.markerX != null" :x1="view.markerX" :x2="view.markerX" :y1="PAD.t" :y2="view.H - PAD.b" stroke="#fff" stroke-opacity="0.6" stroke-width="0.8" />
    </svg>
    <figcaption class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
      <span><span class="inline-block h-0.5 w-3 align-middle" :style="{ background: view.color }"></span> reported</span>
      <span v-if="view.lastYear.length"><span class="inline-block size-1.5 rounded-full bg-[#ffb347] align-middle"></span> same date last year</span>
      <span v-if="view.average.length"><span class="inline-block size-1.5 rounded-full border border-slate-200 align-middle"></span> long-term average</span>
    </figcaption>
  </figure>
  <p v-else class="text-sm text-slate-400">No history yet.</p>
</template>
