#!/usr/bin/env node
// Lists public/*.html files that nothing else in the site links to.
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
const allText = files.map(f => fs.readFileSync(f, "utf8")).join("\n");
const sitemap = fs.existsSync(path.join(PUB, "sitemap.xml")) ? fs.readFileSync(path.join(PUB, "sitemap.xml"), "utf8") : "";

const orphans = [];
for (const f of files) {
  if (f.endsWith("\\404.html") || f.endsWith("/404.html")) continue;
  const rel = path.relative(PUB, f).replaceAll("\\", "/");
  const url = "/" + rel;
  const urlNoExt = url.replace(/\.html$/, "").replace(/\/index$/, "");
  const sitemapUrl = urlNoExt === "" ? "/" : urlNoExt;

  // Check for any href to this page
  const patterns = [
    `href="${url}"`,
    `href="${urlNoExt}"`,
    `href="${urlNoExt}/"`,
    `href="${url}#`,
    `href="${urlNoExt}#`,
    `href='${url}'`,
    `href='${urlNoExt}'`,
  ];
  const linked = patterns.some(p => allText.includes(p));
  const inSitemap = sitemap.includes(`<loc>https://kolm.ai${sitemapUrl}</loc>`);
  if (!linked) orphans.push({ file: rel, inSitemap });
}

console.log(`Orphan pages: ${orphans.length}\n`);
for (const o of orphans) console.log(`${o.inSitemap ? "[SM]" : "    "}  ${o.file}`);
process.exit(0);
