// The dataset lives in its own repository and is read at runtime, so new
// bulletins show up without rebuilding the site. The copy bundled in
// public/data/ (scripts/copy-data.mjs) is only a fallback.

import { CRITICAL } from "./model.js";

export const DATASET_REPO = "https://github.com/MrSunshyne/mauritius-dataset-reservoirs";
const LIVE = "https://raw.githubusercontent.com/MrSunshyne/mauritius-dataset-reservoirs/main/data/";
const BUNDLED = import.meta.env.BASE_URL + "data/";

async function loadFrom(base) {
  const get = (name) =>
    fetch(base + name, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
      return r.json();
    });
  const [reservoirs, readings, latest] = await Promise.all([get("reservoirs.json"), get("readings.json"), get("latest.json")]);
  if (!Array.isArray(reservoirs) || !Array.isArray(readings) || !readings.length) throw new Error("unexpected dataset shape");
  return { reservoirs, readings, latest };
}

// All three files come from the same place so they agree with each other.
export async function loadDataset() {
  try {
    return { ...(await loadFrom(LIVE)), live: true };
  } catch (err) {
    console.warn("Live dataset unavailable, using the bundled copy:", err);
    return { ...(await loadFrom(BUNDLED)), live: false };
  }
}

// One entry per bulletin date. A reservoir missing from a bulletin keeps its
// last reported value, flagged with the date it was reported (`asOf`).
export function buildTimeline(reservoirs, readings) {
  const last = {};
  const capacity = reservoirs.reduce((s, r) => s + r.capacity_mm3, 0);
  return readings.map((reading, i) => {
    const levels = {};
    for (const res of reservoirs) {
      const v = reading.reservoirs?.[res.id];
      if (v?.percent != null) last[res.id] = { ...v, i };
      const l = last[res.id];
      if (!l) {
        levels[res.id] = null;
        continue;
      }
      const from = readings[l.i];
      levels[res.id] = {
        percent: l.percent,
        volume: l.volume_mm3 ?? (l.percent / 100) * res.capacity_mm3,
        volumeEstimated: l.volume_mm3 == null,
        asOf: from.date,
        stale: l.i !== i,
        lastYear: from.last_year?.reservoirs?.[res.id]?.percent ?? null,
        average: from.average?.reservoirs?.[res.id]?.percent ?? null,
        reading: from,
      };
    }
    // A bulletin without a total gets one computed from the seven, when they were all reported that day.
    let total = reading.total?.percent ?? null;
    if (total == null && reservoirs.every((r) => levels[r.id] && !levels[r.id].stale)) {
      total = (reservoirs.reduce((s, r) => s + levels[r.id].volume, 0) / capacity) * 100;
    }
    return {
      date: reading.date,
      total,
      totalVolume: reading.total?.volume_mm3 ?? (total != null ? (total / 100) * capacity : null),
      totalVolumeEstimated: reading.total?.volume_mm3 == null,
      lastYear: reading.last_year?.total?.percent ?? null,
      average: reading.average?.total?.percent ?? null,
      levels,
      reading,
    };
  });
}

export function historyOf(readings, id) {
  return readings
    .filter((r) => r.reservoirs?.[id]?.percent != null)
    .map((r) => ({ date: r.date, percent: r.reservoirs[id].percent, lastYear: r.last_year?.reservoirs?.[id]?.percent ?? null, average: r.average?.reservoirs?.[id]?.percent ?? null }));
}

export function totalHistory(readings) {
  return readings
    .filter((r) => r.total?.percent != null)
    .map((r) => ({ date: r.date, percent: r.total.percent, lastYear: r.last_year?.total?.percent ?? null, average: r.average?.total?.percent ?? null }));
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const formatDate = (iso) => (iso ? dateFmt.format(new Date(iso + "T00:00:00Z")) : "");
const NNBSP = "\u00a0"; // keeps "46.3 %" on one line (a no-break space every font has)
export const pct = (v, digits = 1) => (v == null ? "–" : `${v.toFixed(digits)}${NNBSP}%`);
export const mm3 = (v, digits = 2) => (v == null ? "–" : `${v.toFixed(digits)}${NNBSP}Mm³`);
export const pts = (v) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)}${NNBSP}pts`);

// One colour for water, one for alarm: the fill of a reservoir is drawn in the same blue
// as the water in the 3D view, and in red below CRITICAL %.
export const WATER = "#4aa8e0";
export const ALERT = "#ff3e3e";
export const fillColor = (p) => (p == null ? "#3a3a3a" : p < CRITICAL ? ALERT : WATER);
