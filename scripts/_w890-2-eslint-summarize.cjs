// W890-2 helper — summarize ESLint JSON output to ruleId + remaining_warnings.
// Argv: <in.json> <out.json> <stage:before|after>
'use strict';
const fs = require('fs');
const path = require('path');

const [, , INFILE, OUTFILE, STAGE] = process.argv;
if (!INFILE || !OUTFILE || !STAGE) {
  console.error('usage: node _w890-2-eslint-summarize.cjs <in.json> <out.json> <stage>');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
function rel(p) {
  return p.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, '');
}

const r = JSON.parse(fs.readFileSync(INFILE, 'utf8'));

let errorCount = 0;
let warningCount = 0;
const ruleCounts = {};
const remaining = [];
const files_autofixed = [];

for (const f of r) {
  errorCount += f.errorCount || 0;
  warningCount += f.warningCount || 0;
  if (f.output) files_autofixed.push(rel(f.filePath));
  for (const m of f.messages) {
    const k = m.ruleId || '(syntax)';
    ruleCounts[k] = (ruleCounts[k] || 0) + 1;
    if (remaining.length < 200) {
      remaining.push({
        file: rel(f.filePath),
        line: m.line,
        column: m.column,
        rule: k,
        severity: m.severity === 2 ? 'error' : 'warning',
        message: m.message,
      });
    }
  }
}

const out = {
  stage: STAGE,
  total_files_scanned: r.length,
  errors: errorCount,
  warnings: warningCount,
  rule_breakdown: Object.fromEntries(
    Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])
  ),
  files_autofixed,
  remaining_top_50: remaining.slice(0, 50),
};
fs.writeFileSync(OUTFILE, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${OUTFILE}: errors=${errorCount} warnings=${warningCount} files_scanned=${r.length}`);
