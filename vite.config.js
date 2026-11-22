import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// Deployed to GitHub Pages by .github/workflows/deploy.yml at https://reservoirs.ramgolam.com/
export default defineConfig({
  base: "/",
  plugins: [vue(), tailwindcss()],
  // three.js is most of the 3D view's chunk, loaded after the page shows.
  build: { chunkSizeWarningLimit: 700 },
});
