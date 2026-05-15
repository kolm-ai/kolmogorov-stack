#!/usr/bin/env node
// Cross-references every internal href in public/**/*.html against:
//   1. actual files on disk
//   2. vercel.json rewrites + redirects
// Reports broken/orphan links that 404 in production.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || ".");
const PUB = path.join(ROOT, "public");
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));

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
const ondisk = new Set(htmlFiles.map(f => "/" + path.relative(PUB, f).replaceAll("\\", "/")));

const rewriteSrc = (VERCEL.rewrites || []).map(r => r.source);
const redirectSrc = (VERCEL.redirects || []).map(r => r.source);

function existsOnDisk(p) {
  if (ondisk.has(p)) return true;
  if (ondisk.has(p + ".html")) return true;
  if (ondisk.has(p + "/index.html")) return true;
  // public/{name} static asset
  if (fs.existsSync(path.join(PUB, p.slice(1)))) return true;
  return false;
}

function matchesVercel(p) {
  for (const src of [...rewriteSrc, ...redirectSrc]) {
    if (src === p) return true;
    // regex /name/(.*)
    if (src.includes("(.*)")) {
      const prefix = src.replace("(.*)", "");
      if (p.startsWith(prefix)) return true;
    }
  }
  return false;
}

const hrefs = new Map(); // href -> Set(source file)
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
    if (!hrefs.has(h)) hrefs.set(h, new Set());
    hrefs.get(h).add(path.relative(ROOT, f));
  }
}

const broken = [];
for (const [h, sources] of hrefs) {
  const ok = existsOnDisk(h) || matchesVercel(h);
  if (!ok) broken.push({ href: h, sources: [...sources] });
}

broken.sort((a, b) => a.href.localeCompare(b.href));
console.log(`Total unique internal hrefs: ${hrefs.size}`);
console.log(`Broken: ${broken.length}\n`);
for (const b of broken) {
  console.log(`${b.href}`);
  for (const s of b.sources.slice(0, 5)) console.log(`  ← ${s}`);
  if (b.sources.length > 5) console.log(`  ← (+${b.sources.length - 5} more)`);
}

process.exit(broken.length ? 1 : 0);
