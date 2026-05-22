#!/usr/bin/env node
// Strips the legacy KOLM_NAV_BEGIN..END blocks (and the nearby skip-link dupe)
// from every page that still has them. Safe and idempotent.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'public');
function walk(dir){const out=[];for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...walk(p));else if(e.isFile()&&p.endsWith('.html'))out.push(p);}return out;}

const stripPatterns = [
  // KOLM_NAV_BEGIN/END comment-marked block (with optional surrounding whitespace)
  /\s*<!--\s*KOLM_NAV_BEGIN[\s\S]*?KOLM_NAV_END[^>]*-->\s*/g,
  // Bare second skip-link line  <a class="skip-link" href="#main">Skip to content</a>
  /\s*<a class="skip-link" href="#main">Skip to content<\/a>\s*/g,
  // <nav class="site-nav" ...>...</nav> (in case the wrapper comment is missing)
  /\s*<nav[^>]*class="site-nav"[\s\S]*?<\/nav>\s*/g,
  // <header class="site"> ... </header> fallback
  /\s*<header[^>]*class="site"[\s\S]*?<\/header>\s*/g,
];

let changed=0,skipped=0;
for(const f of walk(root)){
  const before=fs.readFileSync(f,'utf8');
  let after=before;
  for(const p of stripPatterns) after=after.replace(p,'\n');
  if(after!==before){fs.writeFileSync(f,after);changed++;}
  else skipped++;
}
console.log(`strip-legacy-nav-blocks: changed=${changed} skipped=${skipped}`);
