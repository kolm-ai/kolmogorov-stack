#!/usr/bin/env node
// W888-N / W888-O — check-assistant-hallucinations.
//
// Reads a JSONL of {prompt, response, id?} pairs, extracts every backticked
// `kolm <verb> ...` invocation from each response, and asserts that the
// first word after `kolm` is a real verb listed in
// data/assistant-corpus/cli-inventory.json.
//
// Failure = exit code 1 + summary printed.
// Success = exit code 0 + JSON envelope (or short text) printed.
//
// The W888-O ship gate runs this against 200 holdout responses from the
// distilled artifact. For now (no artifact yet), callers stub responses via
// --responses <path-to-jsonl>. When the artifact lands, the W888-O harness
// will run the holdout pairs through it, write the responses to a JSONL,
// and feed that file in here.
//
// Flags:
//   --responses <path>   required — JSONL of {id?, prompt, response} rows
//   --inventory <path>   default data/assistant-corpus/cli-inventory.json
//   --json               emit JSON envelope to stdout
//   --strict             exit non-zero on warnings too (orphan backticks etc)
//   --help

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const INV_DEFAULT = path.join(REPO, 'data', 'assistant-corpus', 'cli-inventory.json');

function parseArgs(argv) {
  const out = {
    responses: null,
    inventory: INV_DEFAULT,
    json: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a === '--responses') out.responses = argv[++i];
    else if (a === '--inventory') out.inventory = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--strict') out.strict = true;
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    'check-assistant-hallucinations — verify all backticked `kolm <verb>` in\n' +
    'responses are real CLI verbs.\n' +
    '\n' +
    'usage: node scripts/check-assistant-hallucinations.cjs --responses <path> [flags]\n' +
    '\n' +
    'flags:\n' +
    '  --responses <path>  JSONL of {id?, prompt, response} (required)\n' +
    '  --inventory <path>  default: data/assistant-corpus/cli-inventory.json\n' +
    '  --json              emit summary envelope as JSON\n' +
    '  --strict            also fail on soft warnings\n' +
    '  --help              show this help\n'
  );
}

function loadInventory(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`cli-inventory.json not found: ${p}`);
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const verbs = new Set();
  for (const v of (raw.verbs || [])) {
    if (v && typeof v.verb === 'string') verbs.add(v.verb);
  }
  if (verbs.size === 0) {
    throw new Error(`cli-inventory.json has 0 verbs: ${p}`);
  }
  return verbs;
}

function readJsonl(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

// Extract every backticked snippet that starts with `kolm `. Match both
// single-backtick inline code and triple-backtick fenced blocks. We deliberately
// do NOT match `kolm` if it's followed by a non-verb character (newline,
// punctuation that ends the snippet) — only `kolm <word>` patterns.
function extractKolmInvocations(text) {
  if (typeof text !== 'string') return [];
  const found = [];
  // Inline: `kolm <verb> ...`
  const inline = /`(kolm\s+[^`\n]+)`/g;
  let m;
  while ((m = inline.exec(text)) !== null) {
    found.push(m[1].trim());
  }
  // Fenced: ```...kolm <verb>...```
  const fenced = /```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g;
  while ((m = fenced.exec(text)) !== null) {
    const body = m[1] || '';
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim();
      // Strip a leading shell prompt ($ ) if present.
      const stripped = t.replace(/^\$\s+/, '');
      if (stripped.startsWith('kolm ')) {
        found.push(stripped);
      }
    }
  }
  return found;
}

// Given a `kolm <verb> ...` invocation, return the verb token (first word
// after `kolm`). Strips leading `--` flags so `kolm --help` returns `--help`
// (which is NOT a verb) — that gets flagged. Returns null if the string is
// unparseable.
function extractVerb(invocation) {
  // Normalize whitespace.
  const norm = invocation.replace(/\s+/g, ' ').trim();
  if (!norm.startsWith('kolm')) return null;
  const rest = norm.slice('kolm'.length).trim();
  if (!rest) return null;
  // Take the first token. Allow alphanumerics + hyphen + colon (some
  // sub-verbs use colon, e.g. `kolm verify:claims`).
  const m = rest.match(/^([A-Za-z][A-Za-z0-9:_-]*)/);
  if (!m) return null;
  return m[1];
}

function checkResponses(rows, verbs) {
  const offenders = [];
  let totalInvocations = 0;
  let totalChecked = 0;
  for (const row of rows) {
    const id = row.id || row.seed_id || '(no-id)';
    const response = row.response || row.canonical_answer || '';
    const invocations = extractKolmInvocations(response);
    totalInvocations += invocations.length;
    for (const inv of invocations) {
      const verb = extractVerb(inv);
      if (!verb) {
        offenders.push({ id, reason: 'unparseable_invocation', invocation: inv });
        continue;
      }
      // Flags like `--help` would have leading dashes — the regex above
      // requires a leading letter, so flag-only `kolm --help` returns null
      // and lands under unparseable_invocation above.
      totalChecked += 1;
      if (!verbs.has(verb)) {
        offenders.push({
          id,
          reason: 'invalid_verb',
          invocation: inv,
          invalid: verb,
        });
      }
    }
  }
  return {
    rows_checked: rows.length,
    invocations_found: totalInvocations,
    verbs_checked: totalChecked,
    offenders,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.responses) {
    process.stderr.write('error: --responses <path> is required\n');
    printHelp();
    process.exit(2);
  }
  if (!fs.existsSync(args.responses)) {
    process.stderr.write(`responses file not found: ${args.responses}\n`);
    process.exit(2);
  }
  let verbs;
  try { verbs = loadInventory(args.inventory); }
  catch (e) { process.stderr.write(`inventory load failed: ${e.message}\n`); process.exit(2); }
  const rows = readJsonl(args.responses);
  const result = checkResponses(rows, verbs);
  const fail = result.offenders.some(o => o.reason === 'invalid_verb');
  const softFail = args.strict && result.offenders.length > 0;
  const envelope = {
    ok: !fail && !softFail,
    inventory_verbs: verbs.size,
    ...result,
    version: 'w888n-v1',
  };
  if (args.json) {
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
  } else {
    process.stdout.write(
      `checked ${result.rows_checked} responses; ` +
      `${result.invocations_found} kolm invocations; ` +
      `${result.verbs_checked} verbs checked; ` +
      `${result.offenders.length} offenders\n`
    );
    if (result.offenders.length > 0) {
      process.stdout.write('\noffenders (first 10):\n');
      for (const o of result.offenders.slice(0, 10)) {
        process.stdout.write(
          `  [${o.id}] ${o.reason}` +
          (o.invalid ? ` (invalid="${o.invalid}")` : '') +
          ` :: ${o.invocation}\n`
        );
      }
    }
  }
  if (fail || softFail) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadInventory,
  readJsonl,
  extractKolmInvocations,
  extractVerb,
  checkResponses,
};
