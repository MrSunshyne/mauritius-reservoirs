// Continuous playback: levels between bulletins, interpolated linearly in time.
// Each reservoir is interpolated between its own reports, so one left out of a
// bulletin runs straight from the report before to the report after. Past its last
// report it holds that value (marked stale); before its first it has none.

const DAY = 86400000;
export const dayOf = (iso) => Date.parse(iso + "T00:00:00Z") / DAY;
export const isoOf = (day) => new Date(Math.round(day) * DAY).toISOString().slice(0, 10);

// Per-reservoir and island-total series of [day, percent, volume], from the readings.
export function buildSeries(reservoirs, readings) {
  const series = { total: [] };
  for (const r of reservoirs) series[r.id] = [];
  const capacity = reservoirs.reduce((s, r) => s + r.capacity_mm3, 0);
  for (const reading of readings) {
    const d = dayOf(reading.date);
    for (const r of reservoirs) {
      const v = reading.reservoirs?.[r.id];
      if (v?.percent != null) series[r.id].push({ d, date: reading.date, percent: v.percent, volume: v.volume_mm3 ?? (v.percent / 100) * r.capacity_mm3 });
    }
    const t = reading.total?.percent;
    if (t != null) series.total.push({ d, date: reading.date, percent: t, volume: reading.total.volume_mm3 ?? (t / 100) * capacity });
  }
  return series;
}

// The value of a series at a (fractional) day.
export function valueAt(points, day) {
  if (!points.length || day < points[0].d) return null;
  let lo = 0;
  let hi = points.length - 1;
  if (day >= points[hi].d) {
    const p = points[hi];
    return { percent: p.percent, volume: p.volume, asOf: p.date, stale: day - p.d >= 1 };
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].d <= day) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const k = (day - a.d) / (b.d - a.d);
  return { percent: a.percent + (b.percent - a.percent) * k, volume: a.volume + (b.volume - a.volume) * k, asOf: a.date, stale: false };
}

// A timeline-shaped entry for a day between bulletins. `base` is the timeline entry of
// the bulletin at or before that day: its last-year and average markers and its
// sources stay as they are.
export function entryAt(series, reservoirs, base, day) {
  const levels = {};
  for (const r of reservoirs) {
    const v = valueAt(series[r.id], day);
    const b = base.levels[r.id];
    levels[r.id] = v ? { ...b, percent: v.percent, volume: v.volume, volumeEstimated: false, asOf: v.asOf, stale: v.stale, interpolated: true } : null;
  }
  const t = valueAt(series.total, day);
  return { ...base, date: isoOf(day), total: t?.percent ?? null, totalVolume: t?.volume ?? null, totalVolumeEstimated: false, levels, interpolated: true };
}
