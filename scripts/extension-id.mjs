#!/usr/bin/env node
// Stable extension ID for the unpacked extension (PLAN §5.4).
//
//   npm run extension-id            print the ID for the key in extension/manifest.json
//   npm run extension-id -- --init  create extension-key.pem (gitignored) if missing
//                                   and write its public key into the manifest
//
// ID = first 32 hex chars of SHA-256(DER public key), mapped 0-f → a-p.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "extension/manifest.json");
const keyPath = resolve(root, "extension-key.pem");

export function extensionIdFromKey(base64Der) {
  const hash = createHash("sha256").update(Buffer.from(base64Der, "base64")).digest("hex").slice(0, 32);
  return [...hash].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (process.argv.includes("--init")) {
  let privateKey;
  if (existsSync(keyPath)) {
    privateKey = createPrivateKey(readFileSync(keyPath));
  } else {
    ({ privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }));
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    console.error(`wrote ${keyPath} (keep it private; it's gitignored)`);
  }
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  manifest.key = der.toString("base64");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error("updated extension/manifest.json \"key\"");
}

if (!manifest.key) {
  console.error('extension/manifest.json has no "key"; run: npm run extension-id -- --init');
  process.exit(1);
}
console.log(extensionIdFromKey(manifest.key));
