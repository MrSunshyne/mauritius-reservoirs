// Copies the dataset from a local checkout of MrSunshyne/mauritius-dataset-reservoirs
// into public/data/, the fallback the site uses when the raw GitHub URLs fail.
// Without a local checkout (e.g. in CI) the committed copy is kept as is.
import { copyFile, mkdir, access } from "node:fs/promises";

const FILES = ["reservoirs.json", "readings.json", "latest.json"];
const src = new URL("../../mauritius-dataset-reservoirs/data/", import.meta.url);
const dest = new URL("../public/data/", import.meta.url);

try {
  await Promise.all(FILES.map((f) => access(new URL(f, src))));
} catch {
  console.log("copy-data: no local dataset checkout, keeping public/data/ as is");
  process.exit(0);
}
await mkdir(dest, { recursive: true });
await Promise.all(FILES.map((f) => copyFile(new URL(f, src), new URL(f, dest))));
console.log(`copy-data: copied ${FILES.join(", ")} from the local dataset`);
