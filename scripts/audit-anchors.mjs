#!/usr/bin/env node
// Finds href="/path#anchor" where the target page exists but #anchor does not.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || ".");
const PUB = path.join(ROOT, "public");

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && p.endsWith(".html")) out.push(p);
  }
  return out;
}

const files = walk(PUB);

// 1) build id index per HTML file
const idsByPath = new Map();
for (const f of files) {
  const url = "/" + path.relative(PUB, f).replaceAll("\\", "/").replace(/\.html$/, "").replace(/\/index$/, "/");
  const norm = url === "/" ? "/" : url.replace(/\/$/, "");
  const src = fs.readFileSync(f, "utf8");
  const ids = new Set();
  const ID_RE = /\bid\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = ID_RE.exec(src))) ids.add(m[1]);
  idsByPath.set(norm, ids);
  // also accept .html-suffixed
  idsByPath.set(norm + ".html", ids);
}

// 2) walk hrefs with #anchors, resolve target page, check anchor present
const HREF_RE = /href\s*=\s*"([^"]+)"/g;
const broken = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  let m;
  while ((m = HREF_RE.exec(src))) {
    const h = m[1];
    if (!h.includes("#")) continue;
    if (h.startsWith("http")) continue;
    let [p, anchor] = h.split("#");
    anchor = (anchor || "").split("?")[0];
    if (!anchor) continue;
    // Skip pure JS hooks and trivial anchors
    if (anchor === "top" || anchor === "main") continue;
    let target;
    if (p === "" || p === undefined) {
      // same-page anchor
      target = "/" + path.relative(PUB, f).replaceAll("\\", "/").replace(/\.html$/, "");
      target = target.replace(/\/index$/, "/");
      if (target !== "/") target = target.replace(/\/$/, "");
    } else {
      target = p.replace(/\/$/, "");
      if (target === "") target = "/";
    }
    const ids = idsByPath.get(target) || idsByPath.get(target + "/") || idsByPath.get(target + ".html");
    if (!ids) continue; // page doesn't exist locally; covered by other audit
    if (!ids.has(anchor)) {
      broken.push({ from: path.relative(ROOT, f), target, anchor });
    }
  }
}

console.log(`Broken anchors: ${broken.length}\n`);
const grouped = new Map();
for (const b of broken) {
  const k = `${b.target}#${b.anchor}`;
  if (!grouped.has(k)) grouped.set(k, []);
  grouped.get(k).push(b.from);
}
const keys = [...grouped.keys()].sort();
for (const k of keys) {
  console.log(k);
  const srcs = grouped.get(k);
  for (const s of srcs.slice(0, 3)) console.log(`  ← ${s}`);
  if (srcs.length > 3) console.log(`  ← (+${srcs.length - 3} more)`);
}
process.exit(broken.length ? 1 : 0);
