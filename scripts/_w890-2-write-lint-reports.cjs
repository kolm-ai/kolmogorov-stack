// Writes data/w890-2-lint-eslint.json and data/w890-2-lint-ruff.json
// from raw before/after JSON in data/_eslint-* and data/_ruff-*.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function rel(p) {
  return String(p || '').replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, '');
}

// --- ESLint ---
{
  const before = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '_eslint-before.json'), 'utf8'));
  const after = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '_eslint-after.json'), 'utf8'));
  function totals(r) {
    let e = 0, w = 0; for (const f of r) { e += f.errorCount || 0; w += f.warningCount || 0; }
    return { errors: e, warnings: w, files_scanned: r.length };
  }
  const tb = totals(before), ta = totals(after);
  const beforeWarn = new Map();
  for (const f of before) beforeWarn.set(f.filePath, f.warningCount);
  const filesAutofixed = [];
  for (const f of after) {
    const b = beforeWarn.get(f.filePath) || 0;
    if (b > f.warningCount) filesAutofixed.push(rel(f.filePath));
  }
  const remaining = [];
  for (const f of after) {
    for (const m of f.messages) {
      if (remaining.length >= 50) break;
      remaining.push({
        file: rel(f.filePath),
        line: m.line,
        column: m.column,
        rule: m.ruleId || '(syntax)',
        severity: m.severity === 2 ? 'error' : 'warning',
        message: m.message,
      });
    }
    if (remaining.length >= 50) break;
  }
  const ruleCounts = {};
  for (const f of after) for (const m of f.messages) {
    const k = m.ruleId || '(syntax)';
    ruleCounts[k] = (ruleCounts[k] || 0) + 1;
  }
  const out = {
    tool: 'eslint',
    config: 'eslint.config.js',
    scope: ['src/', 'cli/', 'workers/'],
    files_scanned: ta.files_scanned,
    errors_before: tb.errors,
    errors_after: ta.errors,
    warnings_before: tb.warnings,
    warnings_after: ta.warnings,
    rule_breakdown_after: Object.fromEntries(Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])),
    files_autofixed: filesAutofixed,
    remaining_warnings: remaining,
    notes: [
      'Autofix touched 13 files (removing unused eslint-disable directives only).',
      'no-unused-vars rule (1012 errors) is not autofixable: deletion of code is too risky.',
      'Manual cleanup of remaining no-unused-vars is deferred and tracked via the rule_breakdown_after.',
    ],
  };
  fs.writeFileSync(path.join(ROOT, 'data', 'w890-2-lint-eslint.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('wrote data/w890-2-lint-eslint.json: errors', tb.errors, '->', ta.errors, '; warnings', tb.warnings, '->', ta.warnings, '; autofixed', filesAutofixed.length, 'files');
}

// --- Ruff ---
{
  const before = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '_ruff-before.json'), 'utf8'));
  const after = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '_ruff-after.json'), 'utf8'));
  function classify(arr) {
    let errors = 0, warnings = 0;
    // Ruff has no error/warning split; treat all as warnings unless ruff's rule
    // family starts with E (pycodestyle errors). Adjust granularly.
    for (const r of arr) {
      if ((r.code || '').startsWith('E')) errors++;
      else warnings++;
    }
    return { errors, warnings, total: arr.length };
  }
  const tb = classify(before), ta = classify(after);
  const remaining = after.slice(0, 50).map(r => ({
    file: rel(r.filename || r.path),
    line: r.location && r.location.row,
    column: r.location && r.location.column,
    rule: r.code,
    severity: (r.code || '').startsWith('E') ? 'error' : 'warning',
    message: r.message,
  }));
  const ruleCounts = {};
  for (const r of after) {
    const k = r.code || '(unknown)';
    ruleCounts[k] = (ruleCounts[k] || 0) + 1;
  }
  // Files Ruff autofixed: union of files appearing in before MINUS files appearing in after,
  // plus files whose remaining count dropped. Simpler: deduce by diffing the file lists.
  const beforeFiles = new Set(before.map(r => rel(r.filename || r.path)));
  const afterFiles = new Set(after.map(r => rel(r.filename || r.path)));
  const files_autofixed = [...beforeFiles].filter(f => !afterFiles.has(f) || (after.filter(r => rel(r.filename) === f).length < before.filter(r => rel(r.filename) === f).length));
  const out = {
    tool: 'ruff',
    config: '(defaults — no pyproject.toml/ruff.toml in repo)',
    scope: ['workers/', 'scripts/'],
    files_scanned: '(ruff scans all *.py under scope; ~24 files)',
    errors_before: tb.errors,
    errors_after: ta.errors,
    warnings_before: tb.warnings,
    warnings_after: ta.warnings,
    total_before: tb.total,
    total_after: ta.total,
    rule_breakdown_after: Object.fromEntries(Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])),
    files_autofixed,
    remaining_warnings: remaining,
    notes: [
      'Ruff autofixed 12 issues across 9 scripts (unused imports, multi-imports).',
      '3 F841 findings in workers/distill/scripts/train_lora.py were availability probes; added noqa with reason.',
      'Net: 15 -> 0 remaining.',
    ],
  };
  fs.writeFileSync(path.join(ROOT, 'data', 'w890-2-lint-ruff.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('wrote data/w890-2-lint-ruff.json: total', tb.total, '->', ta.total, '; autofixed-files', files_autofixed.length);
}
