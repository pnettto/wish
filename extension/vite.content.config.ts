import { resolve } from "node:path";
import { defineConfig } from "vite";

// Content script: a single classic script (executeScript can't load modules).
export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: false,
    target: "chrome116",
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, "src/content/index.ts"),
      formats: ["iife"],
      name: "webIssuerContent",
      fileName: () => "content.js",
    },
  },
});
