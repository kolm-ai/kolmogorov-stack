#!/usr/bin/env node
// Run the showcase PHI redactor against an arbitrary string.
//
//   node apps/showcase/healthcare/run.mjs "Patient John Doe, MRN 8847-21."
//
// Loads model.js from dist/ (run build.mjs first), then prints the redacted
// output and a one-line audit entry naming the CID and credential id.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "dist");
const input = process.argv.slice(2).join(" ");

if (!fs.existsSync(path.join(dist, "model.js"))) {
  console.error("dist/model.js not found. Run: node apps/showcase/healthcare/build.mjs");
  process.exit(1);
}
if (!input) {
  console.error("usage: run.mjs <text to redact>");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8"));
const credential = JSON.parse(fs.readFileSync(path.join(dist, "credential.json"), "utf8"));
const model = await import(pathToFileURL(path.join(dist, "model.js")).href);
const out = model.predict(input);

console.log(out.text);
console.log("");
console.log(`cid: ${manifest.cid}`);
console.log(`credential: ${credential.credential_id}`);
console.log(`K: ${manifest.metrics.k_score}  redactions: ${out.redactions.length}`);
