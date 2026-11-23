// Build the unpacked extension into extension/dist/.
import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "dist");

await build({ configFile: resolve(here, "vite.config.ts"), logLevel: "warn" });
await build({ configFile: resolve(here, "vite.content.config.ts"), logLevel: "warn" });

copyFileSync(resolve(here, "manifest.json"), resolve(dist, "manifest.json"));
console.log(`built ${dist}`);
