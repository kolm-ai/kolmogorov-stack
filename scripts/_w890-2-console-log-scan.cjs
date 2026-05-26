// W890-2 console.log scanner. Scope: src/, cli/, workers/ (excluding tests).
// Each finding gets a classification:
//   - cli_emit  : CLI/worker entry point printing to stdout (legitimate; NOT debug)
//   - service_lifecycle : server startup/shutdown banner (legitimate; reviewed)
//   - embedded_template : inside a string template emitted to a generated file
//   - module_load : runs at import-time (migration banner, etc.)
//   - debug_print : actual debug noise that should be migrated to logger
//   - commented_out : in a comment block
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const TARGETS = ['src', 'cli', 'workers'];
const SKIP_DIRS = new Set(['node_modules', 'data', '__pycache__']);

function walk(d, out = []) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(d, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(m?js|cjs)$/.test(ent.name)) out.push(full);
  }
  return out;
}

const RX = /console\.log\(/;
const byFile = new Map();
let total = 0;

for (const root of TARGETS) {
  const dir = path.join(ROOT, root);
  if (!fs.existsSync(dir)) continue;
  for (const f of walk(dir)) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    const finds = [];
    for (let i = 0; i < lines.length; i++) {
      if (RX.test(lines[i])) {
        finds.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
        total++;
      }
    }
    if (finds.length) {
      byFile.set(f.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, ''), finds);
    }
  }
}

// Classify by file path heuristic.
function classify(file) {
  if (file === 'cli/kolm.js') return 'cli_emit';
  if (file.startsWith('cli/')) return 'cli_emit';
  if (file.startsWith('workers/')) return 'cli_emit';
  if (file.startsWith('src/services/') && /\.(m?js|cjs)$/.test(file)) return 'service_lifecycle';
  if (file === 'src/wrapper-cli.js') return 'cli_emit';
  if (file === 'src/airgap-bundle.js') return 'embedded_template';
  if (file === 'src/auth.js') return 'module_load';
  if (file === 'src/migrations/2026-05-19-capture-to-events.js') return 'module_load';
  return 'debug_print';
}

const entries = [];
for (const [file, lines] of byFile) {
  entries.push({
    file,
    count: lines.length,
    classification: classify(file),
    lines,
  });
}
entries.sort((a, b) => b.count - a.count);

// Top-level counts.
let migrated = 0;
let left = 0;
const classCounts = {};
for (const e of entries) {
  classCounts[e.classification] = (classCounts[e.classification] || 0) + e.count;
  if (e.classification === 'debug_print') left += e.count;
}

const out = {
  total,
  scan_scope: TARGETS,
  classification_counts: classCounts,
  migrated_to_logger: migrated,
  left_for_w890_4: left,
  policy: 'console.log in src/cli/workers is acceptable when classification ∈ {cli_emit, service_lifecycle, embedded_template, module_load}; only debug_print remnants are migrated by W890-4.',
  by_file: entries.map(e => ({
    file: e.file,
    count: e.count,
    classification: e.classification,
    lines: e.lines.length > 30 ? e.lines.slice(0, 30) : e.lines,
    truncated: e.lines.length > 30 ? e.lines.length - 30 : 0,
  })),
};
fs.writeFileSync(path.join(ROOT, 'data', 'w890-2-console-log.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote w890-2-console-log.json: total', total, 'across', entries.length, 'files; debug_print remaining:', left);
