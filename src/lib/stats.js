// Figures computed from the dataset for the text: comparisons, trends, and a
// straight-line projection. Each says which bulletin it comes from.
import { CRITICAL } from "./model.js";

const DAY = 86400000;
const time = (d) => Date.parse(d + "T00:00:00Z");
export const daysBetween = (a, b) => Math.round((time(b) - time(a)) / DAY);

// The island total at timeline entry i, with comparisons and trends.
export function islandSummary(timeline, readings, i, capacity) {
  const entry = timeline[i];
  if (!entry) return null;
  const date = entry.date;
  const toMm3 = (pts) => (pts / 100) * capacity;

  // Last year and the long-term average are only in some bulletins: take the latest
  // bulletin up to this date (within two weeks) that gives them with a total.
  const pair = (key) => {
    for (let k = readings.length - 1; k >= 0; k--) {
      const r = readings[k];
      if (time(r.date) > time(date)) continue;
      if (daysBetween(r.date, date) > 14) break;
      const ref = r[key]?.total?.percent;
      if (r.total?.percent != null && ref != null) return { date: r.date, total: r.total.percent, ref, pts: r.total.percent - ref, mm3: toMm3(r.total.percent - ref) };
    }
    return null;
  };

  // Change in the island total since about `days` ago: from the bulletin closest to that,
  // between `days` and `max` days back.
  const trend = (days, max) => {
    if (entry.total == null) return null;
    let ref = null;
    for (const e of timeline) {
      if (e.total == null || e.reading.total?.percent == null) continue;
      const back = daysBetween(e.date, date);
      if (back >= days && back <= max) ref = e;
    }
    if (!ref) return null;
    const span = daysBetween(ref.date, date);
    const pts = entry.total - ref.total;
    return { from: ref.date, fromTotal: ref.total, days: span, pts, perWeek: (pts / span) * 7 };
  };

  return {
    date,
    total: entry.total,
    volume: entry.totalVolume,
    capacity,
    critical: entry.total != null && entry.total < CRITICAL,
    lastYear: pair("last_year"),
    average: pair("average"),
    week: trend(7, 14),
    month: trend(28, 45),
  };
}

// One reservoir at timeline entry i.
export function reservoirSummary(timeline, readings, i, res) {
  const entry = timeline[i];
  const level = entry?.levels[res.id];
  if (!level) return null;
  const cap = res.capacity_mm3;
  // How many bulletins since it was last reported left it out.
  let skipped = 0;
  for (let k = i; k >= 0 && timeline[k].date !== level.asOf; k--) skipped++;

  const compare = (ref) => (ref == null ? null : { ref, pts: level.percent - ref, mm3: ((level.percent - ref) / 100) * cap });

  // Its own pace over the 30 days to its last report: least-squares slope, if the
  // points are enough to mean something (3 or more, spread over 2 weeks or more).
  const pts = readings
    .filter((r) => r.reservoirs?.[res.id]?.percent != null && time(r.date) <= time(level.asOf) && daysBetween(r.date, level.asOf) <= 30)
    .map((r) => [time(r.date) / DAY, r.reservoirs[res.id].percent]);
  let pace = null;
  if (pts.length >= 3 && pts[pts.length - 1][0] - pts[0][0] >= 14) {
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const slope = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    pace = { perWeek: slope * 7, points: pts.length, from: new Date(pts[0][0] * DAY).toISOString().slice(0, 10) };
    // When it would reach 20 % at that pace: only for a fall, and within a year.
    if (slope < -0.01 && level.percent > 20) {
      const days = (level.percent - 20) / -slope;
      if (days <= 365) pace.reaches20 = new Date(time(level.asOf) + days * DAY).toISOString().slice(0, 10);
    }
  }

  return {
    ...level,
    critical: level.percent < CRITICAL,
    skipped,
    lastYearCmp: compare(level.lastYear),
    averageCmp: compare(level.average),
    pace,
    supplies: supplies(res),
  };
}

// What a reservoir supplies, from the sentences of its description that say so.
export function supplies(res) {
  const sentences = (res.notes ?? "").split(/(?<=\.)\s+/);
  const hits = sentences.filter((s) => /suppl|source for|used for/i.test(s));
  return hits.length ? hits.join(" ") : res.purpose ?? null;
}

// The reservoirs at timeline entry i, lowest first; those never reported go last.
export function sortedByLevel(reservoirs, entry) {
  return [...reservoirs].sort((a, b) => (entry.levels[a.id]?.percent ?? 1e3) - (entry.levels[b.id]?.percent ?? 1e3));
}
