# Mauritius Reservoirs

How full are the seven main reservoirs of Mauritius? The island total and each reservoir, bulletin by bulletin since January 2024, against the same day a year earlier and the long-term average, on a 3D model of the island.

Live at https://mrsunshyne.github.io/mauritius-reservoirs/

## What it shows

- The island total for a bulletin, in % and Mm³; how far it is from the same day a year earlier and from the long-term average, in points and in Mm³; and its change over the last week or two and the last month.
- The seven reservoirs, lowest first: Mare aux Vacoas, Midlands, Bagatelle, La Ferme, Mare Longue, La Nicolière and Piton du Milieu. Each one shows its level, volume, what it supplies, how it compares with last year and the average, the date it was last reported (many bulletins leave some out), its pace over 30 days, and a chart of every report.
- On the 3D island, each lake sits in a modelled basin: the water stands at the level that holds the reported %, so the shoreline pulls back over a dry, cracked bed with a pale ring at the full level. A glass vial above each lake fills to the same %, so the level reads at island scale.
- Opening a reservoir shows a close-up block of the Land Drainage Authority's 1 m terrain around it, with the basin, the water, and the vial beside the lake.
- A timeline over every bulletin, with a play button that animates all the levels.

## Where the data comes from

The levels come from [MrSunshyne/mauritius-dataset-reservoirs](https://github.com/MrSunshyne/mauritius-dataset-reservoirs).
The Water Resources Commission (Ministry of Energy and Public Utilities) measures the reservoirs, but its bulletins are not published as data: they reach the public through press articles and communiqués that quote them.
The dataset collects those, links every date to its sources, and marks a bulletin as verified only when all seven reservoirs are present and add up to the reported total (or a second source agrees).

The site reads `reservoirs.json`, `readings.json` and `latest.json` from the dataset's raw GitHub URLs at runtime, so new bulletins appear without a rebuild.
If that fails it falls back to the copy bundled in `public/data/`.

## Limits

- Not an official source. Bulletins can be missing, and a single press article can carry a typo; unverified bulletins say so.
- The basins are modelled from capacity and outline, not surveyed: the real shoreline at a given % will differ. Depths are drawn 3× deeper on top of the terrain's 2.2×.
- "At that pace" dates are a straight line through a reservoir's last 30 days of reports. They ignore rain and changes in use.
- When a bulletin leaves a reservoir out, the site keeps its last reported level and shows the date it comes from. Nothing is interpolated.
- Island terrain is a 90 m grid, close-ups 1–2 m, heights exaggerated 2.2×.

## Run it

```
pnpm install
pnpm dev       # http://localhost:5173/mauritius-reservoirs/
pnpm build     # into dist/
pnpm preview
```

`pnpm build` first runs `scripts/copy-data.mjs`, which refreshes `public/data/` from a local checkout of the dataset at `../mauritius-dataset-reservoirs` when there is one.

The terrain, lake outlines and close-up blocks are built once:

```
node scripts/build-terrain.mjs [path to mauritius-elevations/web/public/data]
node scripts/build-outlines.mjs
node scripts/build-closeups.mjs [path to mauritius-elevations/web/public/data/meta.json]
```

`build-closeups.mjs` cuts a square around each lake from Moris 3D's 1 m terrain with HTTP range requests (its storage only allows the Moris 3D site to read it from a browser), at 1 m for the small lakes and 2 m for the large ones, into `public/closeups/` (0.2–1.4 MB each).

Pushing to `master` deploys to GitHub Pages with `.github/workflows/deploy.yml`.

## Credits

- Reservoir levels: Water Resources Commission bulletins as quoted by the press, collected in [mauritius-dataset-reservoirs](https://github.com/MrSunshyne/mauritius-dataset-reservoirs).
- Capacities: [Ministry of Energy and Public Utilities](https://publicutilities.govmu.org/Pages/Water%20Sector/WRU.aspx).
- Lake outlines: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.
- Island terrain: Copernicus DEM GLO-30 and Land Drainage Authority MNT 2021, via [Moris 3D](https://moris3d.ramgolam.com).
- Close-ups: Land Drainage Authority MNT 2021 (1 m), via Moris 3D. The diorama style (palette, earth layers, plinth) follows Moris 3D's.
- Fonts: Clash Display and Satoshi, from Fontshare.
- Built with Vue 3, Vite, Tailwind CSS and three.js. Visits counted with GoatCounter.
