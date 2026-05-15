// Read the sitewide audit report and rank pages by issues to fix.
import { readFile } from 'node:fs/promises';
const report = JSON.parse(await readFile('tmp/sitewide-v7.15/report.json', 'utf8'));

// Index by url for cross-viewport comparison
const byUrl = new Map();
for (const r of report.mobile) byUrl.set(r.url, { mob: r });
for (const r of report.desktop) {
  if (!byUrl.has(r.url)) byUrl.set(r.url, {});
  byUrl.get(r.url).desk = r;
}

const rows = [];
for (const [url, { mob, desk }] of byUrl) {
  const issues = [];
  if (mob?.error) issues.push(`mob:err:${mob.error}`);
  if (desk?.error) issues.push(`desk:err:${desk.error}`);
  if (mob?.status && mob.status !== 200) issues.push(`mob:status:${mob.status}`);
  if (desk?.status && desk.status !== 200) issues.push(`desk:status:${desk.status}`);
  if (mob?.broken?.length) issues.push(`mob:broken:${mob.broken.join('|')}`);
  if (desk?.broken?.length) issues.push(`desk:broken:${desk.broken.join('|')}`);
  if (mob?.emDashes > 0) issues.push(`mob:emdash:${mob.emDashes}`);
  if (desk?.emDashes > 0) issues.push(`desk:emdash:${desk.emDashes}`);
  if (mob?.heroPresent === false) issues.push('mob:no-hero');
  if (desk?.heroPresent === false) issues.push('desk:no-hero');
  if (mob?.pageH && mob.pageH > 12000) issues.push(`mob:tall:${mob.pageH}`);
  if (desk?.pageH && desk.pageH > 10000) issues.push(`desk:tall:${desk.pageH}`);

  rows.push({ url, issues, mobH: mob?.pageH, deskH: desk?.pageH, h1: mob?.h1 || desk?.h1 });
}

// Sort by issue count desc, then by mobile height desc
rows.sort((a, b) => (b.issues.length - a.issues.length) || (b.mobH || 0) - (a.mobH || 0));

console.log('=== TOP ISSUES ===');
let count = 0;
for (const r of rows) {
  if (r.issues.length === 0) continue;
  console.log(`${r.url.padEnd(40)}  mobH=${(r.mobH||0).toString().padStart(5)}  deskH=${(r.deskH||0).toString().padStart(5)}  ${r.issues.join(' | ')}`);
  if (++count >= 40) break;
}

console.log(`\n=== TALL PAGES (mob > 8000px) ===`);
const tall = rows.filter((r) => (r.mobH || 0) > 8000).sort((a, b) => (b.mobH || 0) - (a.mobH || 0));
for (const r of tall.slice(0, 20)) {
  console.log(`  ${r.url.padEnd(40)} mobH=${r.mobH} (${r.h1?.slice(0,40)})`);
}

console.log(`\n=== EM-DASH CARRIERS ===`);
let emCount = 0;
for (const r of rows) {
  const em = (r.issues || []).find((s) => s.includes('emdash'));
  if (em) {
    console.log(`  ${r.url.padEnd(40)} ${em}`);
    if (++emCount >= 20) break;
  }
}

console.log(`\n=== CLEAN PAGES (no issues) ===`);
const clean = rows.filter((r) => r.issues.length === 0);
console.log(`${clean.length} / ${rows.length} pages have zero detected issues`);
