// One-off: downloads the shoreline of each reservoir from OpenStreetMap
// (© OpenStreetMap contributors, ODbL) into public/terrain/outlines.json.
//
//   node scripts/build-outlines.mjs
//
// The ways were found with Overpass/Nominatim (water=reservoir / natural=water
// / landuse=reservoir at each dam) and are pinned here so the build is repeatable.
import { writeFile } from "node:fs/promises";

const WAYS = {
  "mare-aux-vacoas": 22882588,
  midlands: 422499557,
  bagatelle: 507755283,
  "la-ferme": 158605915,
  "mare-longue": 461155021,
  "la-nicoliere": 22907630,
  "piton-du-milieu": 422876973,
};

const features = [];
for (const [id, way] of Object.entries(WAYS)) {
  const res = await fetch(`https://api.openstreetmap.org/api/0.6/way/${way}/full.json`, {
    headers: { "User-Agent": "mauritius-reservoirs build script (https://github.com/MrSunshyne/mauritius-reservoirs)" },
  });
  if (!res.ok) throw new Error(`way ${way}: HTTP ${res.status}`);
  const { elements } = await res.json();
  const nodes = new Map(elements.filter((e) => e.type === "node").map((n) => [n.id, n]));
  const w = elements.find((e) => e.type === "way" && e.id === way);
  // 5 decimals is about 1 m: plenty for a 90 m terrain.
  const ring = w.nodes.map((n) => [+nodes.get(n).lon.toFixed(5), +nodes.get(n).lat.toFixed(5)]);
  features.push({
    type: "Feature",
    properties: { id, name: w.tags.name ?? null, osm: `way/${way}`, tags: pick(w.tags, ["natural", "water", "landuse"]) },
    geometry: { type: "Polygon", coordinates: [ring] },
  });
  console.log(`${id}: way/${way} ${w.tags.name ?? ""}, ${ring.length} points`);
}

await writeFile(
  new URL("../public/terrain/outlines.json", import.meta.url),
  JSON.stringify({ type: "FeatureCollection", attribution: "© OpenStreetMap contributors, ODbL 1.0", features }) + "\n",
);

function pick(o, keys) {
  return Object.fromEntries(keys.filter((k) => o[k]).map((k) => [k, o[k]]));
}
