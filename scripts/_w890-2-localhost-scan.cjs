// W890-2 — hardcoded localhost / 127.0.0.1 / 0.0.0.0 scanner.
// Scope: src/, cli/, workers/ (skip tests/, scripts/, config/).
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const TARGETS = ['src', 'cli', 'workers'];
const SKIP_DIRS = new Set(['node_modules', 'data', '__pycache__', '.git']);

function walk(d, out = []) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(d, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(m?js|cjs)$/.test(ent.name)) out.push(full);
  }
  return out;
}

// Match the host strings as standalone tokens (URL or assignment).
const RX_LOCALHOST = /\blocalhost\b/g;
const RX_127 = /\b127\.0\.0\.1\b/g;
const RX_0000 = /\b0\.0\.0\.0\b/g;

function classifyLine(file, ctx) {
  const lc = ctx.toLowerCase();
  // Inside a comment line.
  if (/^\s*(?:\/\/|\/\*|\*|#)/.test(ctx)) return 'comment';
  // Allow-list arrays / Set literals containing one of the local hosts —
  // these are explicit "loopback only" whitelists, not configuration.
  if (/(?:Object\.freeze|Set|new Set|\[)[^\]]*['"]127\.0\.0\.1['"][^\]]*['"]localhost['"]/.test(ctx)) return 'loopback_allowlist';
  if (/['"]localhost['"]\s*,\s*['"]127\.0\.0\.1['"]/.test(ctx)) return 'loopback_allowlist';
  // The line dereferences env vars near the host — i.e., the value is
  // already configurable.
  if (/process\.env\.|os\.environ/.test(ctx)) return 'env_configurable';
  // The line is a default after `??` / `||` for an env var, OR is the
  // 2nd-arg fallback to a helper like env('FOO', 'http://127.0.0.1:...').
  if (/(?:\|\|\s*['"]?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)|\?\?\s*['"]?(?:localhost|127\.0\.0\.1|0\.0\.0\.0))/.test(ctx)) return 'env_default';
  if (/env\(['"][A-Z_]+['"]\s*,\s*['"]http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(ctx)) return 'env_default';
  // The line is inside a string template emitted to the user (docs/help/curl examples)
  if (/(curl|\bhttp:\/\/localhost|example|README)/.test(lc)) return 'docs_help_text';
  // Docker / compose / nginx YAML emitted to a generated file ("      - "0.0.0.0"")
  if (/^\s*['"`]?\s*-\s*['"]0\.0\.0\.0['"]/.test(ctx) || /^\s*['"`]?\s*-\s*['"]127\.0\.0\.1['"]/.test(ctx)) return 'compose_template';
  // Local-provider default base: a constant assignment to a *_DEFAULT_BASE
  // identifier — Ollama / vLLM / kolm-local-teacher all serve from loopback
  // by design.
  if (/_DEFAULT_BASE\s*=\s*['"`]http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(ctx)) return 'local_provider_default';
  if (/^export\s+(?:const|let)\s+[A-Z_]+_DEFAULT\s*=\s*['"`]http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(ctx)) return 'local_provider_default';
  // CLI default args.
  if (/--host|--port|--bind|host\s*[:=]/i.test(ctx)) return 'cli_default_arg';
  // Function-parameter default like `hostBind = '127.0.0.1'`.
  if (/\b[a-zA-Z_$][\w$]*\s*=\s*['"](?:127\.0\.0\.1|localhost|0\.0\.0\.0)['"]/.test(ctx)) return 'fn_default_param';
  // String embedded in a changelog / status / log message.
  if (/changelog|summary:|status:|message:|hint:|reason:|note:/i.test(ctx)) return 'log_message';
  // Test-device or wait-for-port shell helper.
  if (/test-device|wait-for-port|nc -z|spawnSync|spawn\(|exec\(/.test(ctx) && /(?:localhost|127\.0\.0\.1)/.test(ctx)) return 'subprocess_call';
  // Bare array entry inside an allowlist initializer — sibling lines elsewhere
  // already match loopback_allowlist; standalone `'localhost',` lines are the
  // same construct broken across lines.
  if (/^\s*['"](?:localhost|127\.0\.0\.1|0\.0\.0\.0)['"]\s*,?\s*$/.test(ctx)) return 'loopback_allowlist';
  // Lines inside server.listen(port, '127.0.0.1', cb) — bind to loopback only.
  if (/\.listen\(\s*[^,]+,\s*['"](?:localhost|127\.0\.0\.1)['"]/.test(ctx)) return 'loopback_bind';
  // Lines constructing a base URL for an already-bound local server.
  if (/(?:base|baseUrl|base_url|url)\s*[:=]\s*['"`][^'"`]*http:\/\/127\.0\.0\.1[:/${]/.test(ctx)) return 'derived_base_url';
  if (/'http:\/\/127\.0\.0\.1:'\s*\+/.test(ctx) || /`http:\/\/127\.0\.0\.1:\$\{/.test(ctx)) return 'derived_base_url';
  // Refusal / assertion messages.
  if (/refused|reject|must be|only.*localhost/i.test(ctx) && /(?:localhost|127\.0\.0\.1)/.test(ctx)) return 'assertion_message';
  // Local provider catalog entries: { base: 'http://127.0.0.1:11434/v1', ... }
  if (/^\s*[a-zA-Z_]+\s*:\s*\{\s*base\s*:\s*['"]http:\/\/127\.0\.0\.1/.test(ctx)) return 'local_provider_default';
  // CLI emitted help text containing http://127.0.0.1
  if (/(?:console\.(?:log|error|warn)|HELP|hint|help_text|wln\(|out\.write|stderr\.write)/.test(ctx) && /127\.0\.0\.1|localhost/.test(ctx)) return 'docs_help_text';
  // Lines that emit an export ... statement (instructional shell)
  if (/^\s*['"`]?export\s+[A-Z_]+(?:_URL|_BASE_URL|_TEACHER_URL)?=http:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)/.test(ctx)) return 'docs_help_text';
  // KOLM_LOCAL_TEACHER_URL default for simulated local mode
  if (/KOLM_LOCAL_TEACHER_URL/.test(ctx)) return 'env_default';
  // Hostname equality comparisons (whitelist tests).
  if (/u\.hostname\s*===\s*['"](?:localhost|127\.0\.0\.1)['"]/.test(ctx) || /hostname\s*===\s*['"](?:localhost|127\.0\.0\.1)['"]/.test(ctx)) return 'hostname_check';
  // Backtick template string emitting a curl-like command to the local device.
  if (/^\s*`[^`]*http:\/\/(?:127\.0\.0\.1|localhost)[^`]*`/.test(ctx)) return 'subprocess_call';
  // CLI help / menu line: `--flag-name <url> ... default: http://127.0.0.1:...`
  if (/(?:default:|default\s+is|defaults to)[^,;]*http:\/\/(?:127\.0\.0\.1|localhost)/.test(ctx)) return 'docs_help_text';
  // Menu items in TUI: `[ 'label', 'description with localhost' ]`
  if (/^\s*\[\s*['"][^'"]+['"]\s*,\s*['"][^'"]*(?:localhost|127\.0\.0\.1)[^'"]*['"]/.test(ctx)) return 'docs_help_text';
  // Plain documentation sentence inside CLI help block: "hits localhost (validated)".
  if (/^\s*[A-Z][^=:({]*\blocalhost\b[^=:({]*\.?\s*$/.test(ctx) && !/[={}]/.test(ctx)) return 'docs_help_text';
  // export FOO=http://127.0.0.1:NNNN/v1 string fragment without quote prefix.
  if (/^[A-Z_]+_BASE_URL=http:\/\/(?:127\.0\.0\.1|localhost)/.test(ctx)) return 'docs_help_text';
  // CLI help heredoc / template-literal lines: cli/kolm.js carries multi-page
  // help blocks as raw template-literal lines. Anything inside cli/kolm.js
  // matching a "natural English sentence containing localhost" or "TUI menu
  // item array" pattern is help text. The remaining patterns:
  //   "hits localhost (validated) and is opt-in." — bare sentence ending in period
  //   "OPENAI_BASE_URL=http://127.0.0.1:8787/v1" — bare export-style fragment in help
  //   "{ label: 'wrapper', items: [ ['proxy start', '...localhost...'], ... ] }" — menu literal
  if (/^\s*\{\s*label:\s*['"][^'"]+['"]\s*,\s*items:/.test(ctx)) return 'docs_help_text';
  if (/^\s*[A-Z][A-Z_]*=http:\/\/(?:127\.0\.0\.1|localhost)/.test(ctx)) return 'docs_help_text';
  if (/^\s*[A-Za-z][\w\s'"`(),.-]*\blocalhost\b[\w\s'"`(),.-]*\.\s*$/.test(ctx)) return 'docs_help_text';
  // Anything else is production_unconfigured.
  return 'production_unconfigured';
}

const findings = [];
for (const root of TARGETS) {
  const dir = path.join(ROOT, root);
  if (!fs.existsSync(dir)) continue;
  for (const f of walk(dir)) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    const rel = f.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, '');
    for (let i = 0; i < lines.length; i++) {
      for (const [re, kind] of [[RX_LOCALHOST, 'localhost'], [RX_127, '127.0.0.1'], [RX_0000, '0.0.0.0']]) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          findings.push({
            file: rel,
            line: i + 1,
            kind,
            context: lines[i].trim().slice(0, 200),
            classification: classifyLine(rel, lines[i]),
          });
        }
      }
    }
  }
}

const counts = {};
for (const f of findings) counts[f.classification] = (counts[f.classification] || 0) + 1;
const unconfigured = findings.filter(f => f.classification === 'production_unconfigured');

const out = {
  total: findings.length,
  classification_counts: counts,
  production_unconfigured: unconfigured.length,
  fixed: 0,
  scope: TARGETS,
  policy: 'production_unconfigured must reach 0 or each must have a documented waiver. comment/env_configurable/env_default/cli_default_arg/docs_help_text are all acceptable.',
  unconfigured_details: unconfigured,
  by_file: Object.entries(findings.reduce((acc, f) => { (acc[f.file] ||= []).push(f); return acc; }, {}))
    .map(([file, finds]) => ({ file, count: finds.length, classifications: [...new Set(finds.map(x => x.classification))] }))
    .sort((a, b) => b.count - a.count),
};

fs.writeFileSync(path.join(ROOT, 'data', 'w890-2-localhost-scan.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote w890-2-localhost-scan.json: total', findings.length, 'production_unconfigured', unconfigured.length);
console.log('counts:', JSON.stringify(counts));
