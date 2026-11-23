import preact from "@preact/preset-vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Content script: a single classic script (executeScript can't load modules).
// Preact UI; CSS is imported with ?inline and put in the shadow root.
export default defineConfig({
  publicDir: false,
  plugins: [preact()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
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
