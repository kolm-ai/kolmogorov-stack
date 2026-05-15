#!/usr/bin/env node
// Probes every internal href found in public/**/*.html against the live URL.
// Reports anything returning >=400.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || ".");
const PUB = path.join(ROOT, "public");
const BASE = process.env.URL || "https://kolm.ai";

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && p.endsWith(".html")) out.push(p);
  }
  return out;
}

const htmlFiles = walk(PUB);
const hrefs = new Map();
const HREF_RE = /href\s*=\s*"([^"]+)"/g;
for (const f of htmlFiles) {
  const src = fs.readFileSync(f, "utf8");
  let m;
  while ((m = HREF_RE.exec(src))) {
    let h = m[1];
    if (!h.startsWith("/")) continue;
    if (h.startsWith("//")) continue;
    h = h.split("#")[0].split("?")[0];
    if (!h) continue;
    if (h.startsWith("/v1/") || h.startsWith("/health") || h.startsWith("/ready")) continue;
    if (h.endsWith(".css") || h.endsWith(".js") || h.endsWith(".svg") || h.endsWith(".png") || h.endsWith(".ico") || h.endsWith(".json") || h.endsWith(".xml") || h.endsWith(".webmanifest")) continue;
    if (!hrefs.has(h)) hrefs.set(h, new Set());
    hrefs.get(h).add(path.relative(ROOT, f));
  }
}

async function check(href) {
  try {
    const r = await fetch(BASE + href, { method: "HEAD", redirect: "manual" });
    return r.status;
  } catch (e) {
    return 0;
  }
}

const all = [...hrefs.keys()];
console.log(`Probing ${all.length} unique hrefs against ${BASE} ...`);

const results = [];
const CONCURRENCY = 16;
let idx = 0;
async function worker() {
  while (idx < all.length) {
    const i = idx++;
    const h = all[i];
    const s = await check(h);
    results.push({ href: h, status: s });
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const bad = results.filter(r => r.status >= 400 || r.status === 0);
bad.sort((a, b) => a.href.localeCompare(b.href));

console.log(`\nStatus distribution:`);
const dist = {};
for (const r of results) dist[r.status] = (dist[r.status] || 0) + 1;
for (const [k, v] of Object.entries(dist).sort()) console.log(`  ${k}: ${v}`);

console.log(`\nBroken (${bad.length}):`);
for (const b of bad) {
  console.log(`${b.status}  ${b.href}`);
  const sources = [...(hrefs.get(b.href) || [])].slice(0, 3);
  for (const s of sources) console.log(`        ← ${s}`);
}

process.exit(bad.length ? 1 : 0);
