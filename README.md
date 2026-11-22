# Mauritius Reservoirs

How full are the seven main reservoirs of Mauritius? This site shows it in 3D: the island's terrain, and over each reservoir a glass prism shaped like the lake, filled with water to the reported level.

Live at https://mrsunshyne.github.io/mauritius-reservoirs/

## What it shows

- The island total, compared with the same date last year and the long-term average, as of the latest bulletin.
- Mare aux Vacoas, Midlands, Bagatelle, La Ferme, Mare Longue, La Nicolière and Piton du Milieu, each drawn at its real position with its real outline.
  Each glass prism is as tall as the reservoir is big (height proportional to capacity), and the water inside rises to the reported %.
  Orange dashes mark the same date last year, white dashes the long-term average, when the bulletin gave them.
- A timeline over every bulletin date in the dataset, with a play button that animates all the levels.
- A card per reservoir: % full, volume, capacity, last year and average, a small history chart, the sources of that bulletin, and whether it was cross-checked.

## Where the data comes from

The levels come from [MrSunshyne/mauritius-dataset-reservoirs](https://github.com/MrSunshyne/mauritius-dataset-reservoirs).
The Water Resources Commission (Ministry of Energy and Public Utilities) measures the reservoirs, but its bulletins are not published as data: they reach the public through press articles and communiqués that quote them.
The dataset collects those, links every date to its sources, and marks a bulletin as verified only when all seven reservoirs are present and add up to the reported total (or a second source agrees).

The site reads `reservoirs.json`, `readings.json` and `latest.json` from the dataset's raw GitHub URLs at runtime, so new bulletins appear without a rebuild.
If that fails it falls back to the copy bundled in `public/data/`.

## Limits

- Not an official source. Bulletins can be missing, and a single press article can carry a typo; unverified bulletins say so.
- When a bulletin leaves a reservoir out, the site keeps its last reported level and shows the date it comes from. Nothing is interpolated.
- The prisms are gauges, not lakes. There is no public depth survey of the reservoirs, so the site does not draw a shrinking shoreline.
- Terrain is a 90 m grid with heights exaggerated 2.2×.

## Run it

```
pnpm install
pnpm dev       # http://localhost:5173/mauritius-reservoirs/
pnpm build     # into dist/
pnpm preview
```

`pnpm build` first runs `scripts/copy-data.mjs`, which refreshes `public/data/` from a local checkout of the dataset at `../mauritius-dataset-reservoirs` when there is one.

The terrain and lake outlines in `public/terrain/` are built once:

```
node scripts/build-terrain.mjs [path to mauritius-elevations/web/public/data]
node scripts/build-outlines.mjs
```

Pushing to `master` deploys to GitHub Pages with `.github/workflows/deploy.yml`.

## Credits

- Reservoir levels: Water Resources Commission bulletins as quoted by the press, collected in [mauritius-dataset-reservoirs](https://github.com/MrSunshyne/mauritius-dataset-reservoirs).
- Capacities: [Ministry of Energy and Public Utilities](https://publicutilities.govmu.org/Pages/Water%20Sector/WRU.aspx).
- Lake outlines: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.
- Terrain: Copernicus DEM GLO-30 and Land Drainage Authority MNT 2021, via [Moris 3D](https://moris3d.ramgolam.com).
- Built with Vue 3, Vite, Tailwind CSS and three.js. Visits counted with GoatCounter.
