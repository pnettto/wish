import preact from "@preact/preset-vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Side panel (HTML + Preact) and the background service worker (ES module).
export default defineConfig({
  root: resolve(__dirname, "src"),
  base: "./",
  plugins: [preact()],
  publicDir: false,
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "chrome116",
    sourcemap: true,
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "src/sidepanel/index.html"),
        background: resolve(__dirname, "src/background/index.ts"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
