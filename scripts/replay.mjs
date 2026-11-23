#!/usr/bin/env node
// Sign a webhook fixture with GITHUB_WEBHOOK_SECRET from worker/.dev.vars and
// POST it to the local Worker.
//
//   npm run replay -- workflow_run.in_progress [--url http://localhost:8787]
//
// The event name is the part of the fixture name before the first dot.
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const urlFlag = args.indexOf("--url");
const base = urlFlag === -1 ? "http://localhost:8787" : args.splice(urlFlag, 2)[1];
const name = args[0];
if (!name) {
  console.error("usage: npm run replay -- <fixture> [--url http://localhost:8787]");
  process.exit(2);
}

const candidates = [name, resolve(root, "worker/test/fixtures", name), resolve(root, "worker/test/fixtures", `${name}.json`)];
const file = candidates.find((p) => existsSync(p) && p.endsWith(".json"));
if (!file) {
  console.error(`fixture not found: ${name}`);
  process.exit(2);
}

function devVar(key) {
  if (process.env[key]) return process.env[key];
  const path = resolve(root, "worker/.dev.vars");
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, "");
  }
  return undefined;
}

const secret = devVar("GITHUB_WEBHOOK_SECRET");
if (!secret) {
  console.error("GITHUB_WEBHOOK_SECRET missing (worker/.dev.vars)");
  process.exit(2);
}

const body = readFileSync(file, "utf8");
const event = basename(file).split(".")[0];
const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const res = await fetch(`${base.replace(/\/$/, "")}/webhooks/github`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-GitHub-Event": event, "X-Hub-Signature-256": signature, "X-GitHub-Delivery": crypto.randomUUID() },
  body,
});
console.log(`${event} ${basename(file)} → ${res.status} ${await res.text()}`);
process.exit(res.ok ? 0 : 1);
