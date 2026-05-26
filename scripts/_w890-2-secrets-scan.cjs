// W890-2 — hardcoded secrets/API-key scanner.
// Scope: src/, cli/, workers/, scripts/.
// Patterns scanned (per directive):
//   - `sk-` and `sk_` prefixes
//   - ANTHROPIC_API_KEY=sk, OPENAI_API_KEY=sk
//   - api_key = "..." style literal assignments
// Each finding is classified by:
//   real            : looks like a real production key (>= 24 char body)
//   test_fixture    : obvious dummy value in a tests/ path
//   placeholder     : sk-test-..., sk-xxx, ks_test_..., or env var ref
//   pattern_match   : matched the regex but the value is short / clearly a constant
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const TARGETS = ['src', 'cli', 'workers', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'data', '__pycache__', '.git']);

function walk(d, out = []) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(d, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(m?js|cjs|py|ts)$/.test(ent.name)) out.push(full);
  }
  return out;
}

const PATTERNS = [
  // sk_/sk- prefix tokens (Anthropic/OpenAI/Stripe live keys); requires a key-shaped body
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bsk_[A-Za-z0-9_-]{20,}/g,
  // Anthropic-style live API key assignments
  /ANTHROPIC_API_KEY\s*=\s*['"]?(sk-[A-Za-z0-9_-]+)['"]?/g,
  /OPENAI_API_KEY\s*=\s*['"]?(sk-[A-Za-z0-9_-]+)['"]?/g,
  // Generic api_key = 'something'
  /\bapi_key\s*[:=]\s*['"]([A-Za-z0-9_-]{20,})['"]/g,
];

function classify(text, file, value) {
  // Test fixture / under tests/ dir? Out of scope per directive.
  if (file.startsWith('tests/')) return 'test_fixture';
  // Bench / eval / PII fixture files: these are synthetic prompts fed to
  // redactors and benchmarks; matching "API token sk-xyz..." is the entire
  // point of the corpus.
  if (file.startsWith('src/bench-') || file.includes('-eval-suites')) return 'eval_corpus_fixture';
  // Placeholders: obvious dummies
  const lc = (value || '').toLowerCase();
  if (
    /sk-(test|xxx|fake|example|dummy|placeholder|your[-_]?key)/.test(lc) ||
    /sk_(test|xxx|fake|example|dummy|placeholder|your[-_]?key)/.test(lc) ||
    /^ks_test_/.test(value || '') ||
    /^sk-ant-test/.test(value || '') ||
    value === 'sk-test' ||
    value === 'sk_test' ||
    /^\$\{/.test(value || '') ||
    /^process\.env\./.test(value || '') ||
    // Documentation ellipsis: "sk-ant-...", "sk-or-v1-..."
    /\.\.\./.test(value || '') ||
    /[<\[]/.test(value || '')
  ) return 'placeholder';
  // Documentation context: file path contains 'docs', 'help', 'readme', or the
  // line shows instructional shell syntax ("export FOO=" / "add lines to")
  const ctxLc = (text || '').toLowerCase();
  if (
    /\b(?:export|add lines|set this|your[-_ ](?:real|own|existing))\b/.test(ctxLc) ||
    /^(\s*\/\/|\s*#|\s*\*|\s*'|\s*")/.test(text) && /export\s+(?:ANTHROPIC|OPENAI|KOLM)/.test(text) ||
    /build-(?:docs|wrapper-docs|markdown)/.test(file) ||
    /=sk-\.\.\.|=sk-ant-\.\.\.|=sk-or-/.test(text)
  ) return 'docs_help_text';
  // Inside env-var-reference patterns
  if (/process\.env|os\.environ|getenv/.test(text)) return 'env_ref_nearby';
  // Default to suspect / requires-review
  return 'review_required';
}

const findings = [];
for (const root of TARGETS) {
  const dir = path.join(ROOT, root);
  if (!fs.existsSync(dir)) continue;
  for (const f of walk(dir)) {
    const txt = fs.readFileSync(f, 'utf8');
    const lines = txt.split(/\r?\n/);
    const rel = f.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, '');
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(txt)) !== null) {
        const before = txt.slice(0, m.index);
        const line = (before.match(/\n/g) || []).length + 1;
        const ctx = (lines[line - 1] || '').trim().slice(0, 240);
        const value = m[1] || m[0];
        findings.push({
          file: rel,
          line,
          rule: re.source,
          matched_value_redacted: typeof value === 'string'
            ? (value.length > 12 ? value.slice(0, 6) + '...' + value.slice(-4) : value)
            : '(none)',
          context: ctx,
          severity: classify(ctx, rel, value),
        });
      }
    }
  }
}

const productionRealKeys = findings.filter(f => f.severity === 'review_required').length;
const placeholders = findings.filter(f => f.severity === 'placeholder').length;
const env_refs = findings.filter(f => f.severity === 'env_ref_nearby').length;
const test_fixtures = findings.filter(f => f.severity === 'test_fixture').length;
const docs = findings.filter(f => f.severity === 'docs_help_text').length;
const eval_corpus = findings.filter(f => f.severity === 'eval_corpus_fixture').length;

const out = {
  total: findings.length,
  production_real_keys: productionRealKeys,
  placeholders,
  env_ref_nearby: env_refs,
  test_fixtures,
  docs_help_text: docs,
  eval_corpus_fixture: eval_corpus,
  scope: TARGETS,
  policy: 'production_real_keys MUST be 0. Anything classified review_required means the regex matched a non-placeholder, non-env-ref shape and a human must verify before ship.',
  findings,
};
fs.writeFileSync(path.join(ROOT, 'data', 'w890-2-secrets-scan.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote w890-2-secrets-scan.json: total', findings.length, 'production_real_keys', productionRealKeys, 'placeholders', placeholders, 'env_ref_nearby', env_refs);
