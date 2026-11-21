import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// Served by GitHub Pages from /docs at https://mrsunshyne.github.io/mauritius-reservoirs/
export default defineConfig({
  base: "/mauritius-reservoirs/",
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: "docs",
    emptyOutDir: true,
  },
});
