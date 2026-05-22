#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLOSEOUT_PATH = path.join(ROOT, 'public', 'product-readiness-closeout.json');
const GRAPH_PATH = path.join(ROOT, 'public', 'product-graph.json');
const ACCOUNT_OVERVIEW = path.join(ROOT, 'public', 'account', 'overview.html');
const TEXT_EXT = new Set(['.html', '.md', '.txt']);

const SCANNED_ROOTS = [
  path.join(ROOT, 'public'),
  path.join(ROOT, 'README.md'),
  path.join(ROOT, 'docs', 'PRODUCT.md'),
  path.join(ROOT, 'docs', 'AUTHORING.md'),
  path.join(ROOT, 'docs', 'product-readiness-closeout.md'),
];

const SKIP_PATH_PARTS = [
  `${path.sep}reports${path.sep}`,
  `${path.sep}docs${path.sep}research${path.sep}`,
  `${path.sep}public${path.sep}docs${path.sep}showcase${path.sep}`,
];

const ALLOW_SCOPE_WORDS = [
  'not claim',
  'not compliant',
  'not certified',
  'requires',
  'need ',
  'needs ',
  'until',
  'roadmap',
  'target',
  'when it lands',
  'future',
  'planned',
  'pending',
  'gated',
  'auditor-gated',
  'benchmark-gated',
  'closeout',
  'current scope',
  'proof required',
  'done when',
  'honesty',
  'not a certification',
  'certification remains',
  'requires live certification',
  'require live certification',
];

const RISK_RULES = [
  {
    status: 'needs_live_certification',
    code: 'unscoped_soc2_claim',
    pattern: /\bSOC 2(?: Type [I1]+)? (?:certified|certification|attested|attestation available|report available|evidence available now)\b/i,
  },
  {
    status: 'needs_live_certification',
    code: 'unscoped_iso_fedramp_claim',
    pattern: /\b(?:ISO 27001 (?:certified|certification)|FedRAMP (?:authorized|certified|ready)|EU AI Act compliant|HIPAA[- ]ready|HIPAA compliant)\b/i,
  },
  {
    status: 'needs_public_benchmark_data',
    code: 'unscoped_benchmark_superlative',
    pattern: /\b(?:best[- ]in[- ]class|state[- ]of[- ]the[- ]art|11\.6x|7x faster|10x cheaper)\b/i,
  },
  {
    status: 'needs_package_release',
    code: 'unscoped_package_claim',
    pattern: /\b(?:kolm-swift|@kolm-ai\/runtime|ai\.kolm:kolm-runtime|Cleared App Review|brew install kolm|pip install kolm|curl -fsSL https:\/\/kolm\.ai\/install)\b/i,
  },
  {
    status: 'needs_external_partner',
    code: 'unscoped_external_standard_claim',
    pattern: /\b(?:(?:CNCF|Linux Foundation).{0,80}(?:accepted|standardized|certified)|(?:Ollama|Hugging Face|llama\.cpp).{0,80}(?:native|official).{0,80}\.kolm)\b/i,
  },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function walk(entry, out = []) {
  if (!fs.existsSync(entry)) return out;
  const stat = fs.statSync(entry);
  if (stat.isFile()) {
    if (TEXT_EXT.has(path.extname(entry).toLowerCase())) out.push(entry);
    return out;
  }
  for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
    const p = path.join(entry, child.name);
    if (SKIP_PATH_PARTS.some((part) => p.includes(part))) continue;
    if (child.isDirectory()) walk(p, out);
    else if (TEXT_EXT.has(path.extname(child.name).toLowerCase())) out.push(p);
  }
  return out;
}

function scoped(line) {
  const lower = line.toLowerCase();
  return ALLOW_SCOPE_WORDS.some((word) => lower.includes(word));
}

function exemptContext(file, line, rule) {
  const normalizedPath = rel(file);
  const lower = line.toLowerCase();
  if (normalizedPath === 'public/changelog.html' && rule.code === 'unscoped_benchmark_superlative') return true;
  if (lower.includes('pattern:') && line.includes('*/')) return true;
  if (/^\s*(\/\*|\*|<!--)/.test(line)) return true;
  if (rule.code === 'unscoped_benchmark_superlative') {
    if (normalizedPath === 'public/research/methods-2026-q2.html' && lower.includes('state of the art')) return true;
    if (lower.includes('together is best-in-class')) return true;
    if (lower.includes('zk-ml systems as of')) return true;
    if (lower.includes('research dump') || lower.includes('methods - state of the art')) return true;
    if (lower.includes('gating condition') || lower.includes('what must be true')) return true;
    if (lower.includes('hindsight') && lower.includes('recall')) return true;
  }
  return false;
}

function scanClaims(files, enabledStatuses) {
  const failures = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const rule of RISK_RULES) {
        if (!enabledStatuses.has(rule.status)) continue;
        if (!rule.pattern.test(line)) continue;
        if (exemptContext(file, line, rule)) continue;
        if (scoped(line)) continue;
        failures.push({
          code: rule.code,
          status: rule.status,
          path: rel(file),
          line: i + 1,
          excerpt: line.trim().slice(0, 220),
        });
      }
    }
  }
  return failures;
}

function assertAccountReadiness(out) {
  const html = fs.readFileSync(ACCOUNT_OVERVIEW, 'utf8');
  for (const needle of [
    'data-product-readiness',
    '/v1/product/graph',
    '/product-readiness-closeout.json',
    'readiness-counts',
    'readiness-closeout',
  ]) {
    if (!html.includes(needle)) {
      out.failures.push({ code: 'account_readiness_missing', path: rel(ACCOUNT_OVERVIEW), detail: `missing ${needle}` });
    }
  }
}

function assertCliParity(out) {
  const cli = path.join(ROOT, 'cli', 'kolm.js');
  const run = spawnSync(process.execPath, [cli, 'surfaces', '--readiness'], { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) {
    out.failures.push({ code: 'cli_readiness_failed', detail: run.stderr || run.stdout || `exit ${run.status}` });
    return;
  }
  for (const needle of ['open closeout items:', 'needs_public_benchmark_data', 'needs_package_release']) {
    if (!run.stdout.includes(needle)) {
      out.failures.push({ code: 'cli_readiness_missing', detail: `stdout missing ${needle}` });
    }
  }
}

function main() {
  const closeout = readJson(CLOSEOUT_PATH);
  const graph = readJson(GRAPH_PATH);
  const open = closeout.open_requirements || [];
  const enabledStatuses = new Set(open.map((row) => row.status));
  const out = {
    ok: true,
    failures: [],
    counts: {
      open_requirements: open.length,
      scanned_files: 0,
      readiness_statuses: graph.readiness_counts || {},
    },
  };

  if (!open.length) out.failures.push({ code: 'missing_open_closeout_contracts', detail: 'closeout ledger has no open requirements; expected explicit DoD state' });
  for (const row of open) {
    for (const field of ['surface_id', 'requirement_id', 'status', 'next_wave', 'current_scope', 'done_when', 'verification']) {
      if (row[field] == null || (Array.isArray(row[field]) && !row[field].length) || String(row[field]).trim() === '') {
        out.failures.push({ code: 'incomplete_closeout_row', requirement_id: row.requirement_id, field });
      }
    }
  }

  assertAccountReadiness(out);
  assertCliParity(out);

  const files = SCANNED_ROOTS.flatMap((entry) => walk(entry));
  out.counts.scanned_files = files.length;
  out.failures.push(...scanClaims(files, enabledStatuses));

  out.ok = out.failures.length === 0;
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) process.exit(1);
}

main();
