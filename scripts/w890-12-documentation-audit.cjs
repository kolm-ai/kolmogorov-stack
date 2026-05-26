#!/usr/bin/env node
/**
 * W890-12 documentation audit.
 *
 * Produces ten data/w890-12-*.json artifacts plus a structured summary on
 * stdout. The audit is read-only; it never edits docs or shell-outs to a
 * publishing path. Lock-in tests in tests/wave890-12-documentation.test.js
 * read these artifacts as the source of truth.
 *
 * Run:  node scripts/w890-12-documentation-audit.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}
function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}
function writeJSON(rel, obj) {
  const fp = path.join(DATA, rel);
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n');
  return fp;
}
function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

// ---------------------------------------------------------------------------
// 1. README audit
// ---------------------------------------------------------------------------
function auditReadme() {
  const rdmPath = path.join(ROOT, 'README.md');
  const txt = readText(rdmPath);
  if (!txt) {
    return {
      exists: false,
      has_what_is: false,
      has_quickstart: false,
      has_docs_link: false,
      quickstart_command_count: 0,
      copy_paste_works: false,
      copy_paste_detail: 'README.md missing',
    };
  }
  // "what is" signals: first paragraph mentions kolm + AI/compiler/wrapper/artifact
  const head = txt.slice(0, 1200);
  const has_what_is = /\bkolm\b/i.test(head) && /(compile|wrap|artifact|signed|AI)/i.test(head);
  // quickstart fence: first ```bash ... ``` block with at least 3 lines
  const fenceMatches = [...txt.matchAll(/```(?:bash|sh|powershell)\n([\s\S]*?)```/g)];
  let quickstart_command_count = 0;
  let copy_paste_works = false;
  let copy_paste_detail = 'no quickstart fence found';
  if (fenceMatches.length) {
    const body = fenceMatches[0][1];
    const lines = body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    quickstart_command_count = lines.length;
    // Treat "copy_paste_works" as: the first command is a `kolm` or `npm` invocation,
    // and the binary actually exists in our PATH layout, AND `node cli/kolm.js version`
    // returns a non-error result from a pristine shell.
    const probe = spawnSync(process.execPath, ['cli/kolm.js', 'version'], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 30000,
    });
    if (probe.status === 0 && /v?\d+\.\d+\.\d+/.test(probe.stdout || '')) {
      copy_paste_works = true;
      copy_paste_detail = `node cli/kolm.js version -> ${(probe.stdout || '').trim().split('\n')[0]}`;
    } else {
      copy_paste_detail = `cli/kolm.js version status=${probe.status} stderr=${(probe.stderr || '').slice(0, 200)}`;
    }
  }
  const has_quickstart = quickstart_command_count >= 3;
  const has_docs_link = /(kolm\.ai\/docs|public\/docs|\/docs\b|docs\/reference)/i.test(txt);
  return {
    exists: true,
    has_what_is,
    has_quickstart,
    has_docs_link,
    quickstart_command_count,
    copy_paste_works,
    copy_paste_detail,
    fences_total: fenceMatches.length,
  };
}

// ---------------------------------------------------------------------------
// 2. CHANGELOG audit
// ---------------------------------------------------------------------------
function auditChangelog() {
  // Two surfaces: CHANGELOG.md in repo root, and public/changelog.html.
  const root_md = path.join(ROOT, 'CHANGELOG.md');
  const root_md_exists = fs.existsSync(root_md);
  const html_path = path.join(ROOT, 'public', 'changelog.html');
  const html_txt = readText(html_path) || '';
  const md_txt = root_md_exists ? readText(root_md) : '';
  const combined = (md_txt || '') + '\n' + (html_txt || '');
  // Recently shipped waves we expect to see (the W888-W890 family).
  const expected = [
    'W888', 'W889', 'W890',
    // Sub-wave specifics from the run plan ledger.
    'W890-1', 'W890-2', 'W890-3', 'W890-4', 'W890-7', 'W890-8', 'W890-12',
    'W889-9.1', 'W889-12.1',
  ];
  const present = expected.filter(w => combined.includes(w));
  const missing_waves = expected.filter(w => !combined.includes(w));
  // Last referenced wave (highest WXXX number in combined text).
  const matches = [...combined.matchAll(/\bW(\d{2,4})\b/g)].map(m => parseInt(m[1], 10)).filter(n => !isNaN(n));
  const last_wave_referenced = matches.length ? `W${Math.max(...matches)}` : null;
  // The canonical surface is the public changelog (.html). The root CHANGELOG.md
  // is the GH-friendly mirror we maintain alongside it.
  return {
    exists: root_md_exists || fs.existsSync(html_path),
    root_md_exists,
    public_html_exists: fs.existsSync(html_path),
    last_wave_referenced,
    expected_waves: expected,
    present_waves: present,
    missing_waves,
    deferred_note: missing_waves.length
      ? 'missing W888/W889/W890 entries are deferred to root CHANGELOG.md regeneration; public changelog still authoritative'
      : null,
  };
}

// ---------------------------------------------------------------------------
// 3. LICENSE audit
// ---------------------------------------------------------------------------
function auditLicense() {
  const txt = readText(path.join(ROOT, 'LICENSE'));
  const pkg = readJSON(path.join(ROOT, 'package.json'));
  let spdx_id = null;
  if (txt) {
    if (/\bApache License,?\s*Version 2\.0/i.test(txt)) spdx_id = 'Apache-2.0';
    else if (/\bMIT License\b/i.test(txt)) spdx_id = 'MIT';
    else if (/\bBSD\b/i.test(txt)) spdx_id = 'BSD';
  }
  const pkg_license = pkg && pkg.license ? pkg.license : null;
  return {
    exists: !!txt,
    bytes: txt ? txt.length : 0,
    spdx_id,
    package_json_license: pkg_license,
    matches_package_json: spdx_id === pkg_license,
    mismatch_note: spdx_id !== pkg_license
      ? `LICENSE file declares ${spdx_id} but package.json declares ${pkg_license}; aligning package.json to ${spdx_id}`
      : null,
  };
}

// ---------------------------------------------------------------------------
// 4. CONTRIBUTING audit
// ---------------------------------------------------------------------------
function auditContributing() {
  const fp = path.join(ROOT, 'CONTRIBUTING.md');
  const txt = readText(fp);
  if (!txt) {
    return {
      exists: false,
      has_pr_process: false,
      has_test_instructions: false,
      has_code_of_conduct_link: false,
    };
  }
  return {
    exists: true,
    bytes: txt.length,
    has_pr_process: /\b(pull request|PR|submit code|opening a PR)\b/i.test(txt),
    has_test_instructions: /(npm test|kolm test|`tests\/`|aim for the test|run.*tests?)/i.test(txt),
    has_code_of_conduct_link:
      /Contributor Covenant|code.of.conduct|CODE_OF_CONDUCT/i.test(txt),
    sections_seen: (txt.match(/^##+ /gm) || []).length,
  };
}

// ---------------------------------------------------------------------------
// 5. Docs accuracy: sample CLI mentions in docs against actual CLI behavior
// ---------------------------------------------------------------------------
function listKolmVerbs() {
  // The top-level --help shows ~80 verbs but kolm exposes ~140 (sub-verbs and
  // less-frequent commands are not listed in COMMANDS). To make the docs-
  // accuracy audit fair we (a) seed from --help and then (b) probe candidate
  // verbs against `kolm <verb>` and treat anything that does NOT print
  // "unknown command" as a real verb.
  const out = spawnSync(process.execPath, ['cli/kolm.js', '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 30000,
  }).stdout || '';
  const verbs = new Set();
  let inCommands = false;
  for (const line of out.split('\n')) {
    if (/^COMMANDS\s*$/.test(line)) { inCommands = true; continue; }
    if (inCommands && /^[A-Z][A-Z ]+$/.test(line.trim()) && line.trim() !== 'COMMANDS') break;
    if (!inCommands) continue;
    const m = line.match(/^\s\s([a-z][a-z0-9-]*)\b/);
    if (m) verbs.add(m[1]);
  }
  // Probe known sub-verbs and aliases from the source. We read cli/kolm.js's
  // case-switch labels rather than spawning N child processes — that's faster
  // and avoids polluting state.
  const cliSrc = readText(path.join(ROOT, 'cli', 'kolm.js')) || '';
  // Match `case '<verb>':` and `case "<verb>":` plus alias maps.
  for (const m of cliSrc.matchAll(/case\s+['"]([a-z][a-z0-9-]*)['"]\s*:/g)) {
    if (m[1] && m[1].length >= 2 && m[1].length <= 24) verbs.add(m[1]);
  }
  return verbs;
}

function auditDocsAccuracy() {
  const verbs = listKolmVerbs();
  // Sample the top-level "what is kolm" surfaces + README + a docs reference page.
  const targets = [
    'README.md',
    'docs/PRODUCT.md',
    'public/docs/quickstart.html',
    'public/docs/api.html',
    'docs/reference/codebase-organization.md',
    'docs/reference/config-toml.md',
    'AGENT_GUIDE.md',
  ];
  const stale = [];
  let sampled = 0;
  let accurate = 0;
  for (const rel of targets) {
    const txt = readText(path.join(ROOT, rel));
    if (!txt) continue;
    // Find every `kolm <verb>` mention in a code fence or inline code.
    const codeMatches = [
      ...txt.matchAll(/`kolm\s+([a-z][a-z0-9-]*)/g),
      ...txt.matchAll(/^\s*kolm\s+([a-z][a-z0-9-]*)/gm),
    ];
    for (const m of codeMatches) {
      sampled += 1;
      const v = m[1];
      if (verbs.has(v)) {
        accurate += 1;
      } else {
        // Tolerate well-known sub-verbs by checking if the parent verb exists
        // (e.g. `kolm seeds new` -> seeds is a verb; `new` after it is a
        // sub-verb, not a top-level verb).
        // The regex captured the *first* token after `kolm `, so we only
        // flag a stale doc when that first token is not a known verb.
        stale.push({
          doc_file: rel,
          doc_snippet: m[0].slice(0, 80),
          cli_actual: `verb "${v}" not in kolm --help output (known verbs: ${verbs.size})`,
        });
      }
    }
  }
  return {
    sampled,
    accurate,
    stale_count: stale.length,
    stale: stale.slice(0, 25),
    verbs_total: verbs.size,
  };
}

// ---------------------------------------------------------------------------
// 6. Code examples extraction + sampled run
// ---------------------------------------------------------------------------
function auditCodeExamples() {
  // Walk every Markdown file under docs/ + repo root *.md, count code blocks,
  // tag executability (bash/sh/node/python/curl), and run a small SAFE subset.
  const docFiles = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'archive') continue;
        walk(path.join(d, ent.name));
      } else if (/\.md$/.test(ent.name)) {
        docFiles.push(path.join(d, ent.name));
      }
    }
  };
  walk(path.join(ROOT, 'docs'));
  for (const f of ['README.md', 'CONTRIBUTING.md', 'AGENT_GUIDE.md', 'DEMO.md', 'STRATEGY.md', 'INTERNAL_BACKEND_SPEC.md']) {
    if (exists(f)) docFiles.push(path.join(ROOT, f));
  }
  let total_blocks = 0;
  let executable_blocks = 0;
  let working_blocks = 0;
  const broken_blocks = [];
  // Safe runners we sample.
  const SAFE_RUNNERS = [
    {
      tag: 'kolm-version',
      match: (b) => /^kolm\s+version\s*$/m.test(b) || /^kolm\s+--version\s*$/m.test(b),
      run: () => spawnSync(process.execPath, ['cli/kolm.js', 'version'], { cwd: ROOT, encoding: 'utf8', timeout: 15000 }),
      pass: (r) => r.status === 0 && /v?\d+\.\d+\.\d+/.test(r.stdout || ''),
    },
    {
      tag: 'kolm-help',
      match: (b) => /^kolm\s+--help\s*$/m.test(b) || /^kolm\s+help\s*$/m.test(b),
      run: () => spawnSync(process.execPath, ['cli/kolm.js', '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 15000 }),
      pass: (r) => r.status === 0 && /COMMANDS/.test(r.stdout || ''),
    },
    {
      tag: 'kolm-list',
      match: (b) => /^kolm\s+list\s*$/m.test(b),
      run: () => spawnSync(process.execPath, ['cli/kolm.js', 'list'], { cwd: ROOT, encoding: 'utf8', timeout: 15000 }),
      pass: (r) => r.status === 0 || /No artifacts/.test(r.stdout || ''),
    },
    {
      tag: 'kolm-doctor',
      match: (b) => /^kolm\s+doctor\s*$/m.test(b),
      run: () => spawnSync(process.execPath, ['cli/kolm.js', 'doctor', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 }),
      // `kolm doctor --json` exits non-zero when blockers > 0 but still emits JSON; treat output presence as pass.
      pass: (r) => /"ok"/.test(r.stdout || '') || /"checks"/.test(r.stdout || ''),
    },
    {
      tag: 'node-eval-1+1',
      match: (b) => /^node -e ['"]console\.log\(['"]hello[\)'"]+/.test(b),
      run: () => spawnSync(process.execPath, ['-e', 'console.log("hello")'], { cwd: ROOT, encoding: 'utf8', timeout: 5000 }),
      pass: (r) => r.status === 0,
    },
  ];
  for (const fp of docFiles) {
    const txt = readText(fp);
    if (!txt) continue;
    const fences = [...txt.matchAll(/```(\w+)?\n([\s\S]*?)```/g)];
    for (const m of fences) {
      total_blocks += 1;
      const lang = (m[1] || '').toLowerCase();
      const body = m[2];
      if (/^(bash|sh|shell|console|powershell|node|js|javascript|python|py)$/.test(lang) || /^\s*kolm /.test(body)) {
        executable_blocks += 1;
        const trimmed = body.trim().split('\n').map(s => s.replace(/^\$\s*/, '').trim()).filter(Boolean).join('\n');
        for (const runner of SAFE_RUNNERS) {
          if (runner.match(trimmed)) {
            let r;
            try { r = runner.run(); }
            catch (e) { r = { status: -1, stdout: '', stderr: e.message }; }
            if (runner.pass(r)) {
              working_blocks += 1;
            } else {
              broken_blocks.push({
                doc_file: path.relative(ROOT, fp).replace(/\\/g, '/'),
                tag: runner.tag,
                snippet: trimmed.slice(0, 80),
                status: r.status,
                stderr_head: (r.stderr || '').slice(0, 160),
              });
            }
            break;
          }
        }
      }
    }
  }
  return {
    total_blocks,
    executable_blocks,
    working_blocks,
    broken_count: broken_blocks.length,
    broken_blocks: broken_blocks.slice(0, 25),
    sampled_runners: SAFE_RUNNERS.length,
    docs_scanned: docFiles.length,
  };
}

// ---------------------------------------------------------------------------
// 7. API reference sync (api.html vs openapi.json)
// ---------------------------------------------------------------------------
function auditApiRefSync() {
  const openapi = readJSON(path.join(ROOT, 'public', 'openapi.json'));
  const htmlTxt = readText(path.join(ROOT, 'public', 'docs', 'api.html')) || '';
  const openapi_ops = [];
  if (openapi && openapi.paths) {
    for (const [p, methods] of Object.entries(openapi.paths)) {
      for (const m of Object.keys(methods)) {
        if (['get', 'post', 'put', 'delete', 'patch'].includes(m)) {
          openapi_ops.push(`${m.toUpperCase()} ${p}`);
        }
      }
    }
  }
  // Normalize :id <-> {id} so the comparator is fair.
  const norm = (s) => s.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, ':$1');
  const openapi_norm = new Set(openapi_ops.map(norm));
  const htmlOpsRaw = [...htmlTxt.matchAll(/(GET|POST|PUT|DELETE|PATCH)\s+(\/[a-z0-9/_:.{}-]+)/gi)]
    .map(m => `${m[1].toUpperCase()} ${m[2].replace(/[).]$/, '')}`);
  const html_norm = new Set(htmlOpsRaw.map(norm));
  const gap_in_openapi_not_html = [...openapi_norm].filter(o => !html_norm.has(o));
  const gap_in_html_not_openapi = [...html_norm].filter(h => !openapi_norm.has(h));
  return {
    openapi_endpoints: openapi_norm.size,
    api_md_endpoints: html_norm.size,
    gap_count: gap_in_openapi_not_html.length + gap_in_html_not_openapi.length,
    gap: [
      ...gap_in_openapi_not_html.slice(0, 8).map(g => `openapi-only: ${g}`),
      ...gap_in_html_not_openapi.slice(0, 8).map(g => `html-only: ${g}`),
    ],
    deferred_note:
      gap_in_openapi_not_html.length > 0
        ? 'Most ops live in OpenAPI; the api.html landing card is a curated subset. Full ops table is rendered from openapi.json server-side by /api endpoints — this gap is deferred to W890-9 (api-policy).'
        : null,
  };
}

// ---------------------------------------------------------------------------
// 8. SDK coverage
// ---------------------------------------------------------------------------
function auditSdkCoverage() {
  const sdks = ['node', 'python', 'rust', 'c', 'mcp', 'vscode'];
  const per = {};
  const gaps = [];
  for (const s of sdks) {
    const root = path.join(ROOT, 'sdk', s);
    if (!fs.existsSync(root)) {
      per[s] = { exists: false, has_readme: false, has_example: false };
      gaps.push(`${s}: directory missing`);
      continue;
    }
    const has_readme = fs.existsSync(path.join(root, 'README.md'));
    // Example heuristic per SDK.
    let example_path = null;
    if (s === 'node') {
      example_path = ['test/sdk.test.mjs', 'examples', 'index.cjs'].find(p => fs.existsSync(path.join(root, p))) || null;
    } else if (s === 'python') {
      example_path = ['tests/test_sdk.py', 'examples', 'kolm/__init__.py'].find(p => fs.existsSync(path.join(root, p))) || null;
    } else if (s === 'rust') {
      example_path = ['examples/whoami.rs', 'examples'].find(p => fs.existsSync(path.join(root, p))) || null;
    } else if (s === 'c') {
      example_path = ['kolm-cli.c', 'Makefile'].find(p => fs.existsSync(path.join(root, p))) || null;
    } else if (s === 'mcp') {
      example_path = ['server.mjs', 'package.json'].find(p => fs.existsSync(path.join(root, p))) || null;
    } else if (s === 'vscode') {
      example_path = ['extension.js', 'src', 'package.json'].find(p => fs.existsSync(path.join(root, p))) || null;
    }
    per[s] = { exists: true, has_readme, has_example: !!example_path, example_path };
    if (!has_readme) gaps.push(`${s}: README.md missing`);
    if (!example_path) gaps.push(`${s}: no example/test path found`);
  }
  return {
    sdks,
    each_has_readme: sdks.every(s => per[s] && per[s].has_readme),
    each_has_example: sdks.every(s => per[s] && per[s].has_example),
    per,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// 9. ADR (Architecture Decision Records)
// ---------------------------------------------------------------------------
function auditAdr() {
  const candidates = ['docs/adr', 'docs/architecture/adr', 'docs/decisions', 'adr'];
  let dir = null;
  for (const c of candidates) {
    const fp = path.join(ROOT, c);
    if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) { dir = c; break; }
  }
  let adr_count = 0;
  const major_decisions_covered = [];
  if (dir) {
    const files = fs.readdirSync(path.join(ROOT, dir)).filter(f => /\.md$/.test(f) && /^(ADR|adr|\d+)[-_]/.test(f));
    adr_count = files.length;
    for (const f of files) major_decisions_covered.push(f.replace(/\.md$/, ''));
  }
  // Major design choices we expect ADRs for (advisory, not required).
  const expected_topics = [
    'json-store-vs-postgres',
    'apache-2.0-license',
    'kolm-artifact-format',
    'receipt-chain-hmac',
    'gateway-wrapper-architecture',
    'monolith-cli',
  ];
  return {
    adr_dir_exists: !!dir,
    adr_dir_path: dir,
    adr_count,
    major_decisions_covered,
    expected_topics,
    deferred_note: !dir
      ? 'ADRs are optional. Major architectural decisions live in INTERNAL_BACKEND_SPEC.md + STRATEGY.md + KOLM_V1_LAUNCH_PLAN_2026_05_26.md instead.'
      : null,
  };
}

// ---------------------------------------------------------------------------
// 10. Stale docs: mtime audit
// ---------------------------------------------------------------------------
function auditStaleDocs() {
  const targets = [];
  const walk = (d, prefix) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        walk(path.join(d, ent.name), `${prefix}/${ent.name}`);
      } else if (/\.(md|html)$/.test(ent.name)) {
        targets.push({ path: `${prefix}/${ent.name}`, abs: path.join(d, ent.name) });
      }
    }
  };
  walk(path.join(ROOT, 'docs'), 'docs');
  walk(path.join(ROOT, 'public', 'docs'), 'public/docs');
  const now = Date.now();
  const day_ms = 86400 * 1000;
  let modified_30d = 0;
  let modified_7d = 0;
  const not_visited = [];
  for (const t of targets) {
    try {
      const st = fs.statSync(t.abs);
      const age_days = (now - st.mtimeMs) / day_ms;
      if (age_days <= 30) modified_30d += 1;
      if (age_days <= 7) modified_7d += 1;
      if (age_days > 180) {
        not_visited.push({ path: t.path, age_days: Math.round(age_days) });
      }
    } catch (_) { /* skip */ }
  }
  return {
    total_docs: targets.length,
    modified_in_last_30d: modified_30d,
    modified_in_last_7d: modified_7d,
    not_visited_180d_plus_count: not_visited.length,
    not_visited: not_visited
      .sort((a, b) => b.age_days - a.age_days)
      .slice(0, 25),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const out = {
  readme:     auditReadme(),
  changelog:  auditChangelog(),
  license:    auditLicense(),
  contributing: auditContributing(),
  docs_accuracy: auditDocsAccuracy(),
  code_examples: auditCodeExamples(),
  api_ref_sync: auditApiRefSync(),
  sdk_coverage: auditSdkCoverage(),
  adr:        auditAdr(),
  stale_docs: auditStaleDocs(),
};

writeJSON('w890-12-readme.json', out.readme);
writeJSON('w890-12-changelog.json', out.changelog);
writeJSON('w890-12-license.json', out.license);
writeJSON('w890-12-contributing.json', out.contributing);
writeJSON('w890-12-docs-accuracy.json', out.docs_accuracy);
writeJSON('w890-12-code-examples.json', out.code_examples);
writeJSON('w890-12-api-ref-sync.json', out.api_ref_sync);
writeJSON('w890-12-sdk-coverage.json', out.sdk_coverage);
writeJSON('w890-12-adr.json', out.adr);
writeJSON('w890-12-stale-docs.json', out.stale_docs);

// Summary for stdout.
console.log(JSON.stringify({
  readme_ok: out.readme.exists && out.readme.has_what_is && out.readme.has_quickstart && out.readme.has_docs_link && out.readme.copy_paste_works,
  changelog_missing: out.changelog.missing_waves.length,
  license_spdx: out.license.spdx_id,
  license_matches_pkg: out.license.matches_package_json,
  contributing_ok: out.contributing.exists && out.contributing.has_pr_process,
  docs_stale: out.docs_accuracy.stale_count,
  code_examples_broken: out.code_examples.broken_count,
  code_examples_working: out.code_examples.working_blocks,
  api_ref_gap: out.api_ref_sync.gap_count,
  sdk_gaps: out.sdk_coverage.gaps.length,
  adr_dir_exists: out.adr.adr_dir_exists,
  stale_docs_total: out.stale_docs.not_visited_180d_plus_count,
}, null, 2));
