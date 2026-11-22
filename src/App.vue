<script setup>
import { computed, nextTick, onMounted, ref, shallowRef, watch } from "vue";
import SceneView from "./components/SceneView.vue";
import TimelineBar from "./components/TimelineBar.vue";
import ReservoirDetail from "./components/ReservoirDetail.vue";
import HistoryChart from "./components/HistoryChart.vue";
import { loadDataset, buildTimeline, historyOf, totalHistory, formatDate, pct, mm3, pts, fillColor, ALERT, DATASET_REPO } from "./lib/data.js";
import { islandSummary, reservoirSummary, sortedByLevel } from "./lib/stats.js";
import { BASIN_EXAG, TERRAIN_EXAG, CRITICAL } from "./lib/model.js";

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
const entry = computed(() => timeline.value[index.value]);
const isLatest = computed(() => index.value === timeline.value.length - 1);
const capacity = computed(() => reservoirs.value.reduce((s, r) => s + r.capacity_mm3, 0));
const island = computed(() => (entry.value ? islandSummary(timeline.value, readings.value, index.value, capacity.value) : null));
const sorted = computed(() => (entry.value ? sortedByLevel(reservoirs.value, entry.value) : []));
const selectedReservoir = computed(() => reservoirs.value.find((r) => r.id === selected.value));
const selectedSummary = computed(() => (selectedReservoir.value ? reservoirSummary(timeline.value, readings.value, index.value, selectedReservoir.value) : null));
const selectedHistory = computed(() => (selected.value ? historyOf(readings.value, selected.value) : []));
const totals = computed(() => totalHistory(readings.value));
const verified = computed(() => readings.value.filter((r) => r.verified).length);
const firstDate = computed(() => readings.value[0]?.date);

// The timeline steps every 260 ms while playing; anything slower is a person dragging.
const playing = ref(false);
let lastIndexChange = 0;
watch(index, () => {
  const now = performance.now();
  playing.value = now - lastIndexChange < 400;
  lastIndexChange = now;
});

// The tab title carries the latest figure, like the owner's other sites.
watch(island, (s) => {
  if (s && isLatest.value && s.total != null) document.title = `Mauritius reservoirs: ${pct(s.total)} full (${formatDate(s.date)})`;
});

const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
const normalDay = (iso) => dayMonth.format(new Date(iso + "T00:00:00Z"));
const below = (v) => (v < 0 ? "below" : "above");
const lessMore = (v) => (v < 0 ? "less" : "more");
const onDate = (pair) => (pair.date !== entry.value.date ? `On ${formatDate(pair.date)} the island was at ${pct(pair.total)}, ` : "");

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
        <p class="kicker">Island total · bulletin of {{ formatDate(entry.date) }}</p>
        <p class="mt-3 font-display text-7xl leading-none tabular-nums sm:text-8xl" :style="{ color: island.critical ? ALERT : undefined }">{{ pct(island.total) }}</p>
        <p class="mt-4 text-base text-soft">
          {{ island.volume != null ? `${mm3(island.volume, 1)} in the seven reservoirs, of ${mm3(capacity, 1)} they can hold.` : `The seven reservoirs hold up to ${mm3(capacity, 1)}.` }}
          <button v-if="!isLatest" class="ml-1 text-paper underline underline-offset-4" @click="index = timeline.length - 1">Back to the latest</button>
        </p>

        <dl class="mt-6 border-t border-line text-sm leading-relaxed">
          <div v-if="island.lastYear" class="border-b border-line py-3">
            <dt class="kicker">A year earlier</dt>
            <dd class="mt-1 text-soft">
              {{ onDate(island.lastYear) }}<span class="text-paper">{{ Math.abs(island.lastYear.pts).toFixed(1) }} pts {{ below(island.lastYear.pts) }}</span> the same day the year before ({{ pct(island.lastYear.ref) }}):
              <span class="text-paper">{{ mm3(Math.abs(island.lastYear.mm3), 1) }} {{ lessMore(island.lastYear.mm3) }}</span> water.
            </dd>
          </div>
          <div v-if="island.average" class="border-b border-line py-3">
            <dt class="kicker">Long-term average</dt>
            <dd class="mt-1 text-soft">
              {{ onDate(island.average) }}<span class="text-paper">{{ Math.abs(island.average.pts).toFixed(1) }} pts {{ below(island.average.pts) }}</span> the average for the date ({{ pct(island.average.ref) }}):
              <span class="text-paper">{{ mm3(Math.abs(island.average.mm3), 1) }} {{ lessMore(island.average.mm3) }}</span> than a normal {{ normalDay(island.average.date) }}.
            </dd>
          </div>
          <div v-if="island.week || island.month" class="grid grid-cols-2 border-b border-line py-3">
            <div v-if="island.week">
              <dt class="kicker">Last {{ island.week.days }} days</dt>
              <dd class="mt-1 font-display text-xl tabular-nums">{{ pts(island.week.pts) }}</dd>
              <dd class="text-xs text-muted">from {{ pct(island.week.fromTotal) }} on {{ formatDate(island.week.from) }}</dd>
            </div>
            <div v-if="island.month">
              <dt class="kicker">Last {{ island.month.days }} days</dt>
              <dd class="mt-1 font-display text-xl tabular-nums">{{ pts(island.month.pts) }}</dd>
              <dd class="text-xs text-muted">{{ pts(island.month.perWeek) }} a week</dd>
            </div>
          </div>
        </dl>
      </div>

      <!-- 3D -->
      <div ref="stageEl" class="relative h-[66svh] min-h-[440px] scroll-mt-2 border-y border-line md:col-start-2 md:row-span-2 md:row-start-1 md:h-auto md:border-y-0">
        <SceneView :reservoirs="reservoirs" :levels="entry.levels" :date="entry.date" :selected="selected" :playing="playing" @select="select" @closeup="closeup = $event" />
        <div v-if="selected" class="absolute left-4 top-4 z-10 flex items-baseline gap-4 sm:left-6">
          <button class="kicker hover:text-paper" @click="selected = null">← Back to the island</button>
          <span v-if="closeup?.loading" class="text-xs text-soft">Loading the 1 m terrain…</span>
        </div>
        <div class="absolute inset-x-0 bottom-0 border-t border-line bg-ink px-4 py-2 sm:px-6">
          <TimelineBar v-model="index" :timeline="timeline" />
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
                <span class="col-span-2 mt-1.5 text-xs text-muted">
                  {{ mm3(entry.levels[r.id]?.volume, 1) }} of {{ mm3(r.capacity_mm3, 1) }}<template v-if="entry.levels[r.id] && entry.levels[r.id].asOf !== entry.date"> · last reported {{ formatDate(entry.levels[r.id].asOf) }}</template>
                </span>
              </button>
            </li>
          </ul>
          <p class="mt-3 text-xs text-muted">White tick: the same day a year earlier, when the bulletin gave it. Select a reservoir to open it.</p>
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
              the water stands at the level that holds the reported %. Depths are drawn {{ BASIN_EXAG }}× deeper on top of the terrain's {{ TERRAIN_EXAG }}×. The real shoreline at a given % will differ.
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
