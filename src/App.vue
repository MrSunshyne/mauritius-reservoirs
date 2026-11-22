<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import SceneView from "./components/SceneView.vue";
import TimelineBar from "./components/TimelineBar.vue";
import ReservoirDetail from "./components/ReservoirDetail.vue";
import HistoryChart from "./components/HistoryChart.vue";
import { loadDataset, buildTimeline, historyOf, totalHistory, formatDate, pct, mm3, pts, fillColor, ALERT, DATASET_REPO } from "./lib/data.js";
import { islandSummary, reservoirSummary, sortedByLevel } from "./lib/stats.js";
import { buildSeries, entryAt, dayOf } from "./lib/playback.js";
import { BASIN_EXAG, TERRAIN_EXAG, CLOSE_EXAG, CRITICAL } from "./lib/model.js";

const data = shallowRef(null);
const error = ref(null);
const index = ref(0);
const selected = ref(null);
const closeup = ref(null);
const stageEl = ref(null);
const listEl = ref(null);

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
const readings = computed(() => data.value?.readings ?? []);
const timeline = computed(() => (data.value ? buildTimeline(data.value.reservoirs, data.value.readings) : []));
const series = computed(() => (data.value ? buildSeries(data.value.reservoirs, data.value.readings) : null));

// Playback. `day` runs continuously while playing (null when paused): every level is
// interpolated between its own bulletins, and pausing snaps back to the nearest
// bulletin. With reduced motion it steps from bulletin to bulletin instead.
const DAYS_PER_SECOND = 30;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const day = ref(null);
const stepping = ref(false); // reduced-motion playback
let raf = 0;
let stepTimer = 0;
let lastFrame = 0;
const playing = computed(() => day.value != null || stepping.value);
const frozenOrder = ref(null); // the list keeps its order while playing

// The bulletin at or before the playhead.
const baseIndex = computed(() => {
  if (day.value == null) return index.value;
  let i = 0;
  while (i + 1 < timeline.value.length && dayOf(timeline.value[i + 1].date) <= day.value) i++;
  return i;
});
const entry = computed(() => {
  const base = timeline.value[baseIndex.value];
  return day.value == null || !base ? base : entryAt(series.value, reservoirs.value, base, day.value);
});

function play() {
  const tl = timeline.value;
  frozenOrder.value = sorted.value.map((r) => r.id);
  if (index.value >= tl.length - 1) index.value = 0;
  if (reducedMotion) {
    stepping.value = true;
    stepTimer = setInterval(() => (index.value >= tl.length - 1 ? pause() : index.value++), 400);
    return;
  }
  day.value = dayOf(tl[index.value].date);
  lastFrame = performance.now();
  const end = dayOf(tl[tl.length - 1].date);
  const tick = (now) => {
    day.value = Math.min(end, day.value + ((now - lastFrame) / 1000) * DAYS_PER_SECOND);
    lastFrame = now;
    if (day.value >= end) return pause();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
function pause() {
  cancelAnimationFrame(raf);
  clearInterval(stepTimer);
  stepping.value = false;
  if (day.value != null) {
    // Snap to the nearest bulletin.
    let best = 0;
    timeline.value.forEach((e, i) => {
      if (Math.abs(dayOf(e.date) - day.value) < Math.abs(dayOf(timeline.value[best].date) - day.value)) best = i;
    });
    index.value = best;
    day.value = null;
  }
  frozenOrder.value = null;
}
function seek(i) {
  if (playing.value) pause();
  index.value = i;
}
onBeforeUnmount(pause);

const isLatest = computed(() => day.value == null && index.value === timeline.value.length - 1);
const capacity = computed(() => reservoirs.value.reduce((s, r) => s + r.capacity_mm3, 0));
// Comparisons and trends come from the bulletin; the headline figures follow the playhead.
const island = computed(() => {
  if (!entry.value) return null;
  const s = islandSummary(timeline.value, readings.value, baseIndex.value, capacity.value);
  return { ...s, date: entry.value.date, total: entry.value.total, volume: entry.value.totalVolume, critical: entry.value.total != null && entry.value.total < CRITICAL };
});
const sorted = computed(() => {
  if (!entry.value) return [];
  if (frozenOrder.value) return frozenOrder.value.map((id) => reservoirs.value.find((r) => r.id === id));
  return sortedByLevel(reservoirs.value, entry.value);
});
const selectedReservoir = computed(() => reservoirs.value.find((r) => r.id === selected.value));
const selectedSummary = computed(() => {
  if (!selectedReservoir.value) return null;
  const s = reservoirSummary(timeline.value, readings.value, baseIndex.value, selectedReservoir.value);
  const l = entry.value.levels[selected.value];
  return s && l && day.value != null ? { ...s, percent: l.percent, volume: l.volume, volumeEstimated: false, critical: l.percent < CRITICAL, interpolated: true } : s;
});
const selectedHistory = computed(() => (selected.value ? historyOf(readings.value, selected.value) : []));
const totals = computed(() => totalHistory(readings.value));
const verified = computed(() => readings.value.filter((r) => r.verified).length);
const firstDate = computed(() => readings.value[0]?.date);

// The tab title carries the latest figure, like the owner's other sites.
watch(island, (s) => {
  if (s && isLatest.value && s.total != null) document.title = `Mauritius reservoirs: ${pct(s.total)} full (${formatDate(s.date)})`;
});

const lessMore = (v) => (v < 0 ? "less" : "more");
const yearBefore = (iso) => formatDate(`${+iso.slice(0, 4) - 1}${iso.slice(4)}`);
// Last year and the average come from the latest bulletin that gave them: say which, once.
const comparedFrom = computed(() => {
  const s = island.value;
  const pairs = [s?.lastYear, s?.average].filter(Boolean);
  const other = pairs.find((p) => p.date !== timeline.value[baseIndex.value]?.date);
  return other ? `From the bulletin of ${formatDate(other.date)} (island at ${pct(other.total)}), the latest to give them.` : "";
});

function select(id) {
  selected.value = selected.value === id ? null : id;
  if (window.matchMedia("(max-width: 767px)").matches) {
    nextTick(() => (selected.value ? stageEl : listEl).value?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
  }
}
</script>

<template>
  <div class="min-h-svh bg-ink font-sans text-paper">
    <header class="flex items-center justify-between gap-4 border-b border-line px-4 py-4 sm:px-8">
      <p class="flex items-baseline gap-3 text-[13px]">
        <span class="font-bold tracking-[0.05em]">MAURITIUS RESERVOIRS</span>
        <span class="hidden text-muted sm:inline">Fill levels from the Water Resources Commission's bulletins</span>
      </p>
      <nav class="flex gap-5 text-[13px] text-soft">
        <a href="#notes" class="hover:text-paper">Notes</a>
        <a :href="DATASET_REPO" target="_blank" rel="noopener" class="hover:text-paper">Dataset</a>
      </nav>
    </header>

    <p v-if="error" class="px-4 py-10 text-soft sm:px-8">The dataset could not be loaded. Try again later.</p>
    <p v-else-if="!data" class="px-4 py-10 text-muted sm:px-8">Loading the bulletins…</p>

    <section v-else class="md:grid md:h-[calc(100svh-53px)] md:min-h-[660px] md:grid-cols-[minmax(380px,440px)_1fr] md:grid-rows-[auto_1fr]">
      <!-- Island total -->
      <div class="px-4 pb-6 pt-8 sm:px-8 md:col-start-1 md:row-start-1 md:border-r md:border-line">
        <p class="kicker truncate">Island total · {{ entry.interpolated ? `${formatDate(entry.date)}, interpolated` : `bulletin of ${formatDate(entry.date)}` }}</p>
        <p class="mt-3 whitespace-nowrap font-display text-7xl leading-none tabular-nums sm:text-8xl" :style="{ color: island.critical ? ALERT : undefined }">{{ pct(island.total) }}</p>
        <p class="mt-4 min-h-[3.2em] text-base text-soft">
          {{ island.volume != null ? `${mm3(island.volume, 1)} in the seven reservoirs, of ${mm3(capacity, 1)} they can hold.` : `The seven reservoirs hold up to ${mm3(capacity, 1)}.` }}
          <button class="ml-1 text-paper underline underline-offset-4" :class="isLatest || playing ? 'invisible' : ''" @click="seek(timeline.length - 1)">Back to the latest</button>
        </p>

        <!-- Every line below keeps its place whatever the bulletin gives: missing figures show as a dash. -->
        <div class="mt-4 border-t border-line text-sm">
          <div class="border-b border-line py-3">
            <p class="kicker">Against last year and the average</p>
            <p class="mt-1 line-clamp-2 h-8 text-xs leading-4 text-muted">{{ comparedFrom }}</p>
            <dl class="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1.5">
              <dt class="truncate text-soft">{{ island.lastYear ? `vs ${yearBefore(island.lastYear.date)} (${pct(island.lastYear.ref)})` : "vs the same day last year" }}</dt>
              <dd class="whitespace-nowrap text-right">
                <span class="font-display text-lg tabular-nums">{{ island.lastYear ? pts(island.lastYear.pts) : "–" }}</span>
                <span class="block text-xs text-muted">{{ island.lastYear ? `${mm3(Math.abs(island.lastYear.mm3), 1)} ${lessMore(island.lastYear.mm3)}` : "\u00a0" }}</span>
              </dd>
              <dt class="truncate text-soft">{{ island.average ? `vs the average for the date (${pct(island.average.ref)})` : "vs the average for the date" }}</dt>
              <dd class="whitespace-nowrap text-right">
                <span class="font-display text-lg tabular-nums">{{ island.average ? pts(island.average.pts) : "–" }}</span>
                <span class="block text-xs text-muted">{{ island.average ? `${mm3(Math.abs(island.average.mm3), 1)} ${lessMore(island.average.mm3)}` : "\u00a0" }}</span>
              </dd>
            </dl>
          </div>
          <dl class="grid grid-cols-2 border-b border-line py-3">
            <div>
              <dt class="kicker">Last {{ island.week?.days ?? 7 }} days</dt>
              <dd class="mt-1 font-display text-xl tabular-nums">{{ island.week ? pts(island.week.pts) : "–" }}</dd>
              <dd class="truncate text-xs text-muted">{{ island.week ? `from ${pct(island.week.fromTotal)} on ${formatDate(island.week.from)}` : "no bulletin a week before" }}</dd>
            </div>
            <div>
              <dt class="kicker">Last {{ island.month?.days ?? 30 }} days</dt>
              <dd class="mt-1 font-display text-xl tabular-nums">{{ island.month ? pts(island.month.pts) : "–" }}</dd>
              <dd class="truncate text-xs text-muted">{{ island.month ? `${pts(island.month.perWeek)} a week` : "no bulletin a month before" }}</dd>
            </div>
          </dl>
        </div>
      </div>

      <!-- 3D -->
      <div ref="stageEl" class="relative h-[66svh] min-h-[440px] scroll-mt-2 border-y border-line md:col-start-2 md:row-span-2 md:row-start-1 md:h-auto md:border-y-0">
        <SceneView :reservoirs="reservoirs" :levels="entry.levels" :selected="selected" :playing="playing" @select="select" @closeup="closeup = $event" />
        <div v-if="selected" class="absolute left-4 top-4 z-10 flex items-baseline gap-4 sm:left-6">
          <button class="kicker hover:text-paper" @click="selected = null">← Back to the island</button>
          <span v-if="closeup?.loading" class="text-xs text-soft">Loading the 1 m terrain…</span>
        </div>
        <div class="absolute inset-x-0 bottom-0 border-t border-line bg-ink px-4 py-2 sm:px-6">
          <TimelineBar :timeline="timeline" :index="index" :day="day" :total="entry.total" @play="play" @pause="pause" @seek="seek" />
        </div>
      </div>

      <!-- Reservoirs, or the one opened -->
      <div ref="listEl" class="scroll-mt-2 px-4 py-8 sm:px-8 md:col-start-1 md:row-start-2 md:overflow-y-auto md:border-r md:border-line">
        <ReservoirDetail
          v-if="selectedReservoir"
          :reservoir="selectedReservoir"
          :summary="selectedSummary"
          :history="selectedHistory"
          :date="entry.date"
          @close="selected = null"
        />
        <template v-else>
          <div class="flex items-baseline justify-between">
            <p class="kicker">Reservoirs, lowest first</p>
            <p class="text-xs text-muted"><span class="mr-1 inline-block size-2 bg-alert"></span>below {{ CRITICAL }}%</p>
          </div>
          <ul class="mt-3 border-t border-line">
            <li v-for="r in sorted" :key="r.id" class="border-b border-line">
              <button class="group grid w-full grid-cols-[1fr_auto] items-baseline gap-x-4 py-3 text-left" @click="select(r.id)">
                <span class="text-sm font-bold group-hover:underline group-hover:underline-offset-4">{{ r.name }}</span>
                <span class="font-display text-xl tabular-nums" :style="{ color: (entry.levels[r.id]?.percent ?? 100) < CRITICAL ? ALERT : undefined }">{{ entry.levels[r.id] ? pct(entry.levels[r.id].percent) : "–" }}</span>
                <span class="relative col-span-2 mt-2 h-1 bg-line">
                  <span class="absolute inset-y-0 left-0" :style="{ width: `${entry.levels[r.id]?.percent ?? 0}%`, background: fillColor(entry.levels[r.id]?.percent) }"></span>
                  <span v-if="entry.levels[r.id]?.lastYear != null" class="absolute -top-1 h-3 w-px bg-paper" :style="{ left: `${entry.levels[r.id].lastYear}%` }"></span>
                </span>
                <span class="col-span-2 mt-1.5 truncate text-xs text-muted">
                  {{ mm3(entry.levels[r.id]?.volume, 1) }} of {{ mm3(r.capacity_mm3, 1) }}<template v-if="entry.levels[r.id] && (entry.levels[r.id].stale || (!entry.interpolated && entry.levels[r.id].asOf !== entry.date))"> · last reported {{ formatDate(entry.levels[r.id].asOf) }}</template>
                </span>
              </button>
            </li>
          </ul>
          <p class="mt-3 text-xs text-muted">
            White tick: the same day a year earlier, when the bulletin gave it. In the 3D view a grey figure is a reservoir left out of that bulletin: its last reported level.
            {{ frozenOrder ? "The order stays as it was when play started." : "" }}
          </p>
        </template>
      </div>
    </section>

    <main v-if="data" class="mx-auto max-w-5xl px-4 py-16 sm:px-8">
      <section aria-labelledby="total">
        <p id="total" class="kicker">Island total, every bulletin since {{ formatDate(firstDate) }}</p>
        <div class="mt-4"><HistoryChart :points="totals" :marker="entry?.date" :width="720" :height="220" label="Island total fill level history" /></div>
      </section>

      <section id="notes" aria-labelledby="notes-h" class="mt-16 scroll-mt-6 border-t border-line pt-8">
        <h2 id="notes-h" class="font-display text-3xl">Notes</h2>
        <div class="mt-6 grid gap-8 text-sm leading-relaxed text-soft md:grid-cols-2">
          <div class="flex flex-col gap-4">
            <p>
              <span class="text-paper">The numbers.</span> The Water Resources Commission measures the reservoirs and issues bulletins, but does not publish them as data.
              Newspapers and the Central Water Authority quote them. The <a :href="DATASET_REPO" target="_blank" rel="noopener" class="text-paper underline underline-offset-4">dataset</a> collects
              {{ readings.length }} bulletins from those articles, each linked to its source.
            </p>
            <p>
              <span class="text-paper">Checks.</span> {{ verified }} of the {{ readings.length }} bulletins are cross-checked: all seven reservoirs are there and add up to the reported island total within half a point, or a second source gives the same figures.
              The others come from one article.
            </p>
            <p>
              <span class="text-paper">Gaps.</span> Many articles name only some reservoirs. A reservoir left out keeps its last reported level, with that date shown. Nothing is interpolated, and the charts break where bulletins are more than six weeks apart.
            </p>
          </div>
          <div class="flex flex-col gap-4">
            <p>
              <span class="text-paper">The basins are modelled.</span> There is no public depth survey of the reservoirs. Each lake's basin is shaped from its outline, deepest in the middle, and sized to hold its official capacity;
              the water stands at the level that holds the reported %. On the island, heights are drawn {{ TERRAIN_EXAG }}× and basin depths {{ BASIN_EXAG }}× more on top, so they show at that scale; in a close-up, terrain and basin are both drawn {{ CLOSE_EXAG }}×. The real shoreline at a given % will differ.
            </p>
            <p>
              <span class="text-paper">Projections.</span> "At that pace" dates are a straight line through a reservoir's last 30 days of reports. They ignore rain and changes in use, and are only shown when the level is falling.
            </p>
            <p class="text-muted">
              Island terrain: Copernicus DEM GLO-30 and Land Drainage Authority MNT 2021, at 90 m. Close-ups: Land Drainage Authority MNT 2021 (1 m), at 1–2 m, via
              <a href="https://moris3d.ramgolam.com" target="_blank" rel="noopener" class="underline underline-offset-4 hover:text-paper">Moris 3D</a>. Lake outlines © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener" class="underline underline-offset-4 hover:text-paper">OpenStreetMap contributors</a>.
              Capacities: <a href="https://publicutilities.govmu.org/Pages/Water%20Sector/WRU.aspx" target="_blank" rel="noopener" class="underline underline-offset-4 hover:text-paper">Ministry of Energy and Public Utilities</a>.
              {{ data.live ? "" : "The live dataset could not be reached: this is the copy bundled with the site." }}
            </p>
          </div>
        </div>
      </section>
    </main>

    <footer class="flex flex-wrap justify-between gap-3 border-t border-line px-4 py-6 text-[13px] text-muted sm:px-8">
      <a href="https://github.com/MrSunshyne" target="_blank" rel="noopener" class="hover:text-paper">Sandeep Ramgolam</a>
      <span class="flex gap-5">
        <a href="https://github.com/MrSunshyne/mauritius-reservoirs" target="_blank" rel="noopener" class="hover:text-paper">Source code</a>
        <a href="https://data.ramgolam.com" target="_blank" rel="noopener" class="hover:text-paper">More data on Mauritius</a>
      </span>
    </footer>
  </div>
</template>
