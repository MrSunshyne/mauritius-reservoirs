<script setup>
import { computed, nextTick, onMounted, ref, shallowRef, watch } from "vue";
import SceneView from "./components/SceneView.vue";
import TimelineBar from "./components/TimelineBar.vue";
import ReservoirCard from "./components/ReservoirCard.vue";
import HistoryChart from "./components/HistoryChart.vue";
import { loadDataset, buildTimeline, historyOf, totalHistory, formatDate, pct, mm3, levelColor, DATASET_REPO } from "./lib/data.js";

const data = shallowRef(null);
const error = ref(null);
const index = ref(0);
const selected = ref(null);
const cardEl = ref(null);

onMounted(async () => {
  try {
    data.value = await loadDataset();
    index.value = timeline.value.length - 1;
  } catch (err) {
    console.error(err);
    error.value = err;
  }
});

const reservoirs = computed(() => data.value?.reservoirs ?? []);
const timeline = computed(() => (data.value ? buildTimeline(data.value.reservoirs, data.value.readings) : []));
const entry = computed(() => timeline.value[index.value]);
const isLatest = computed(() => index.value === timeline.value.length - 1);
const capacity = computed(() => reservoirs.value.reduce((s, r) => s + r.capacity_mm3, 0));
const selectedReservoir = computed(() => reservoirs.value.find((r) => r.id === selected.value));
const selectedHistory = computed(() => (selected.value ? historyOf(data.value.readings, selected.value) : []));
const totals = computed(() => (data.value ? totalHistory(data.value.readings) : []));
const playing = ref(false);
let lastIndexChange = 0;
watch(index, () => {
  // The timeline steps every 260 ms while playing; anything slower is a person dragging.
  const now = performance.now();
  playing.value = now - lastIndexChange < 400;
  lastIndexChange = now;
});

const signed = (v) => (v == null ? "" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)} pts`);

// Wider charts on wider screens, so their text stays readable.
const wideQuery = window.matchMedia("(min-width: 768px)");
const wide = ref(wideQuery.matches);
wideQuery.addEventListener("change", (e) => (wide.value = e.matches));

// Latest known level of every reservoir, whatever bulletin it came from (latest.json).
const latestRows = computed(() => {
  const latest = new Map((data.value?.latest?.reservoirs ?? []).map((r) => [r.id, r]));
  return reservoirs.value.map((r) => {
    const l = latest.get(r.id);
    return { ...r, level: l?.percent != null ? { percent: l.percent, lastYear: l.last_year_percent ?? null, asOf: l.as_of } : null };
  });
});

const sources = computed(() => {
  const seen = new Map();
  for (const r of data.value?.readings ?? []) for (const s of r.sources ?? []) seen.set(s.name, (seen.get(s.name) ?? 0) + 1);
  return [...seen].sort((a, b) => b[1] - a[1]);
});
const verifiedCount = computed(() => (data.value?.readings ?? []).filter((r) => r.verified).length);

function select(id) {
  selected.value = selected.value === id ? null : id;
  if (selected.value && window.matchMedia("(max-width: 767px)").matches) {
    nextTick(() => cardEl.value?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
  }
}
</script>

<template>
  <div class="min-h-svh bg-slate-950 text-slate-100">
    <p v-if="error" class="p-8 text-rose-300">Could not load the dataset. Please try again later.</p>

    <section v-else class="relative md:h-[calc(100svh-0.5rem)] md:min-h-[600px]">
      <!-- Headline -->
      <header class="relative z-10 p-4 md:absolute md:left-4 md:top-4 md:w-[360px] md:p-0">
        <div class="panel p-5">
          <p class="text-xs font-medium uppercase tracking-[0.18em] text-sky-300">Mauritius reservoirs</p>
          <template v-if="entry">
            <h1 class="mt-2 flex items-baseline gap-3">
              <span class="text-6xl font-semibold tabular-nums leading-none tracking-tight" :style="{ color: levelColor(entry.total) }">{{ entry.total != null ? entry.total.toFixed(1) : "–" }}<span class="text-3xl">%</span></span>
              <span class="text-sm leading-tight text-slate-300">full across<br />the island</span>
            </h1>
            <p class="mt-2 text-sm text-slate-300">
              {{ entry.totalVolume != null ? `${entry.totalVolumeEstimated ? "≈ " : ""}${mm3(entry.totalVolume)} of ${mm3(capacity)}` : `capacity ${mm3(capacity)}` }}
            </p>
            <p class="mt-1 text-sm text-slate-400">
              As of the bulletin of <span class="text-white">{{ formatDate(entry.date) }}</span>
              <button v-if="!isLatest" class="ml-1 text-sky-300 underline underline-offset-2" @click="index = timeline.length - 1">jump to latest</button>
            </p>
            <dl v-if="entry.lastYear != null || entry.average != null" class="mt-4 grid grid-cols-2 gap-2 text-sm">
              <div v-if="entry.lastYear != null" class="rounded-lg bg-white/5 px-3 py-2">
                <dt class="text-xs text-slate-400">Same date last year</dt>
                <dd class="tabular-nums">{{ pct(entry.lastYear) }}</dd>
                <dd v-if="entry.total != null" class="text-xs tabular-nums" :class="entry.total < entry.lastYear ? 'text-rose-300' : 'text-emerald-300'">{{ signed(entry.total - entry.lastYear) }}</dd>
              </div>
              <div v-if="entry.average != null" class="rounded-lg bg-white/5 px-3 py-2">
                <dt class="text-xs text-slate-400">Long-term average</dt>
                <dd class="tabular-nums">{{ pct(entry.average) }}</dd>
                <dd v-if="entry.total != null" class="text-xs tabular-nums" :class="entry.total < entry.average ? 'text-rose-300' : 'text-emerald-300'">{{ signed(entry.total - entry.average) }}</dd>
              </div>
            </dl>
            <p class="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
              <a :href="DATASET_REPO" target="_blank" rel="noopener" class="underline decoration-white/30 underline-offset-2 hover:text-white">Dataset on GitHub</a>
              <a href="#about" class="underline decoration-white/30 underline-offset-2 hover:text-white">Where the data comes from</a>
              <span v-if="!data.live" title="The live dataset could not be reached">bundled copy</span>
            </p>
          </template>
          <p v-else class="mt-2 text-sm text-slate-400">Loading the latest bulletin…</p>
        </div>
      </header>

      <!-- 3D view -->
      <div class="h-[62svh] min-h-[380px] md:absolute md:inset-0 md:h-auto">
        <SceneView v-if="entry" :reservoirs="reservoirs" :levels="entry.levels" :selected="selected" :playing="playing" @select="select" />
        <p class="pointer-events-none absolute bottom-0 right-0 hidden px-3 py-1 text-[10px] text-slate-300/70 md:block">
          Terrain: Copernicus DEM GLO-30, LDA MNT 2021 via Moris 3D · Lakes: © OpenStreetMap contributors
        </p>
      </div>

      <!-- Timeline -->
      <div v-if="entry" class="relative z-10 px-4 pt-3 md:absolute md:bottom-6 md:left-4 md:p-0" :class="selected ? 'md:w-[min(640px,calc(100%-440px))]' : 'md:w-[min(640px,calc(100%-2rem))]'">
        <TimelineBar v-model="index" :timeline="timeline" />
        <p class="mt-2 px-1 text-xs text-slate-400 md:text-slate-300/80">
          Each glass prism stands on its lake: height is proportional to capacity, the water is filled to the reported level.
          <span class="text-[#ffb347]">Orange dashes</span>: same date last year. White dashes: long-term average.
        </p>
      </div>

      <!-- Card -->
      <div ref="cardEl" class="relative z-10 scroll-mt-4 px-4 pt-4 md:pointer-events-none md:absolute md:bottom-6 md:right-4 md:top-4 md:w-[390px] md:overflow-y-auto md:p-0 [&>*]:pointer-events-auto">
        <ReservoirCard v-if="selectedReservoir" :reservoir="selectedReservoir" :level="entry.levels[selected]" :history="selectedHistory" :date="entry.date" @close="selected = null" />
      </div>
    </section>

    <main v-if="data" class="mx-auto flex max-w-5xl flex-col gap-14 px-4 py-14">
      <section aria-labelledby="latest">
        <h2 id="latest" class="text-2xl font-semibold tracking-tight">Every reservoir, latest known level</h2>
        <ul class="mt-5 grid gap-2">
          <li v-for="r in latestRows" :key="r.id">
            <button class="grid w-full grid-cols-[minmax(7rem,10rem)_1fr_4rem] items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-white/5 sm:grid-cols-[12rem_1fr_5rem_8rem]" @click="select(r.id)">
              <span class="truncate font-medium">{{ r.name }}</span>
              <span class="relative h-3 overflow-hidden rounded-full bg-white/10">
                <span class="absolute inset-y-0 left-0 rounded-full" :style="{ width: `${r.level?.percent ?? 0}%`, background: levelColor(r.level?.percent) }"></span>
                <span v-if="r.level?.lastYear != null" class="absolute inset-y-0 w-0.5 bg-[#ffb347]" :style="{ left: `${r.level.lastYear}%` }" title="Same date last year"></span>
              </span>
              <span class="text-right tabular-nums" :style="{ color: levelColor(r.level?.percent) }">{{ r.level ? pct(r.level.percent) : "–" }}</span>
              <span class="hidden text-right text-xs text-slate-400 sm:block">{{ r.level ? formatDate(r.level.asOf) : "not reported" }}</span>
            </button>
          </li>
        </ul>
        <p class="mt-2 text-xs text-slate-500">Bars show % full; the orange tick is the same date last year when the bulletin gave it. Capacities sum to {{ mm3(capacity) }}.</p>
      </section>

      <section v-if="totals.length > 1" aria-labelledby="total">
        <h2 id="total" class="text-2xl font-semibold tracking-tight">Island total over time</h2>
        <div class="mt-5"><HistoryChart :points="totals" :marker="entry?.date" :width="wide ? 720 : 320" :height="wide ? 200 : 150" label="Island total fill level history" /></div>
      </section>

      <section id="about" aria-labelledby="about-h" class="scroll-mt-6">
        <h2 id="about-h" class="text-2xl font-semibold tracking-tight">Where the data comes from</h2>
        <div class="mt-4 grid gap-4 text-slate-300 md:grid-cols-2 md:gap-8">
          <div class="flex flex-col gap-3">
            <p>
              The Water Resources Commission (WRC) of the Ministry of Energy and Public Utilities measures the seven main reservoirs and issues bulletins of how full each one is.
              Those bulletins are not published as open data. They reach the public through press articles and communiqués that quote them.
            </p>
            <p>
              The <a :href="DATASET_REPO" target="_blank" rel="noopener" class="text-sky-300 underline underline-offset-2">dataset</a> collects
              {{ data.readings.length }} bulletin dates from those articles, and links every date to where its numbers came from.
              <template v-if="sources.length">Most come from {{ sources.slice(0, 3).map(([n]) => n).join(", ") }}.</template>
            </p>
            <p>
              A bulletin is marked <span class="text-emerald-300">verified</span> when all seven reservoirs are reported and their capacity-weighted total matches the reported island total within half a point,
              or when a second independent source agrees. {{ verifiedCount }} of {{ data.readings.length }} are. The rest come from a single source and were not cross-checked.
            </p>
          </div>
          <div class="flex flex-col gap-3">
            <p>
              When an article leaves a reservoir out, the site keeps its last reported level and says so. Gaps between bulletins are not interpolated.
              This is not an official source: for decisions, rely on the Central Water Authority and the WRC.
            </p>
            <p>
              The glass prisms are gauges, not lakes. There is no public depth survey of the reservoirs, so the site doesn't pretend to show a shrinking shoreline: each lake keeps its full outline,
              and the prism above it fills to the reported %. Prism height is proportional to capacity.
            </p>
            <p class="text-sm text-slate-400">
              Lake outlines © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener" class="underline underline-offset-2">OpenStreetMap contributors</a> (ODbL).
              Terrain: Copernicus DEM GLO-30 and Land Drainage Authority MNT 2021, via <a href="https://moris3d.ramgolam.com" target="_blank" rel="noopener" class="underline underline-offset-2">Moris 3D</a>, at 90 m, heights exaggerated 2.2×.
              Capacities from the <a href="https://publicutilities.govmu.org/Pages/Water%20Sector/WRU.aspx" target="_blank" rel="noopener" class="underline underline-offset-2">Ministry of Energy and Public Utilities</a>.
            </p>
          </div>
        </div>
      </section>
    </main>

    <footer class="mx-auto flex max-w-5xl flex-wrap justify-between gap-3 border-t border-white/10 px-4 py-8 text-sm text-slate-400">
      <span>By <a href="https://github.com/MrSunshyne" target="_blank" rel="noopener" class="hover:text-white">Sandeep Ramgolam</a></span>
      <span class="flex gap-4">
        <a href="https://github.com/MrSunshyne/mauritius-reservoirs" target="_blank" rel="noopener" class="hover:text-white">Source code</a>
        <a href="https://data.ramgolam.com" target="_blank" rel="noopener" class="hover:text-white">More Mauritius open data →</a>
      </span>
    </footer>
  </div>
</template>
