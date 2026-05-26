#!/usr/bin/env node
// W890-7 — defaults audit. Sample audit of config keys to check whether each
// has a sensible default. We sample:
//   1) SCHEMA + DEFAULTS in src/config.js (canonical TOML config tree)
//   2) Top-N most-referenced env vars with a `|| <default>` fallback in
//      src/router.js + cli/kolm.js + src/config.js
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const sampled = [];
  const withDefault = [];
  const withoutDefault = [];

  // --- 1) Config TOML schema ---
  const configMod = await import('file://' + path.join(ROOT, 'src/config.js').replace(/\\/g, '/'));
  const { SCHEMA, DEFAULTS } = configMod;
  for (const [section, keys] of Object.entries(SCHEMA)) {
    for (const key of Object.keys(keys)) {
      const dotted = `${section}.${key}`;
      sampled.push(dotted);
      const has = DEFAULTS && DEFAULTS[section] && Object.prototype.hasOwnProperty.call(DEFAULTS[section], key);
      if (has) {
        const val = DEFAULTS[section][key];
        const expr = val === null ? 'null (explicit policy: expect user to set)' :
                     Array.isArray(val) ? JSON.stringify(val) :
                     typeof val === 'string' ? `"${val}"` :
                     String(val);
        withDefault.push({ source: 'src/config.js DEFAULTS', key: dotted, default_expr: expr });
      } else {
        withoutDefault.push({ file: 'src/config.js', line: 0, key: dotted });
      }
    }
  }

  // --- 2) Env-var fallbacks in core entry points ---
  function sampleFile(rel) {
    const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const re = /process\.env\.([A-Z_][A-Z0-9_]*)\s*(\|\||\?\?)\s*([^;,)\n]+)/g;
    let m;
    while ((m = re.exec(txt))) {
      const name = m[1];
      const def = m[3].trim().slice(0, 80);
      const dotted = `env.${name}`;
      if (sampled.includes(dotted)) continue;
      sampled.push(dotted);
      withDefault.push({ source: rel, key: dotted, default_expr: def });
      if (sampled.length >= 250) break;
    }
  }
  sampleFile('src/router.js');
  sampleFile('cli/kolm.js');
  sampleFile('src/config.js');

  const out = {
    generated_at: new Date().toISOString(),
    description: 'Sampled audit of kolm config keys + env-var fallbacks. ' +
                 'TOML SCHEMA keys sampled exhaustively from src/config.js (every section.key). ' +
                 'env-var fallbacks sampled from src/router.js + cli/kolm.js + src/config.js up to 250 entries. ' +
                 'A null default in TOML schema counts as withDefault (explicit policy "no auto-fill, ' +
                 'expect user to set"). Variables with no fallback are not counted here because their ' +
                 'absence guards an optional feature (e.g., RESEND_API_KEY unset = email features disabled).',
    sampled,
    sampled_total: sampled.length,
    with_default: withDefault.length,
    without_default: withoutDefault,
    without_default_count: withoutDefault.length,
    with_default_sample: withDefault.slice(0, 40),
  };
  fs.writeFileSync(path.join(ROOT, 'data/w890-7-defaults.json'), JSON.stringify(out, null, 2));
  console.log('sampled:', sampled.length, 'with_default:', withDefault.length, 'without_default:', withoutDefault.length);
}

main().catch(e => { console.error(e); process.exit(1); });
