#!/usr/bin/env node
// W888-M scan-cli-verbs — enumerate every `kolm <verb>` from cli/kolm.js
//
// Parses cli/kolm.js with regex (acorn would mis-handle template-literal HELP
// entries that contain backticks). For every `case '<verb>':` arm under
// async function main(), emits one row:
//   { verb, flags, help_summary, dispatcher }
// where dispatcher names the cmdXxx function the case dispatches to, flags is
// the deduped list of long-form --flags found anywhere in that function body,
// and help_summary is the first non-empty line of HELP[verb] (when present).
//
// Hard contract: every distinct case arm in main() becomes one row. Aliases
// (multiple case arms hitting the same dispatcher) are emitted as separate
// rows so the test can assert per-alias coverage if it ever needs to.

'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO, 'cli', 'kolm.js');
const OUT_PATH = path.join(REPO, 'data', 'assistant-corpus', 'cli-inventory.json');

function readSource() {
  return fs.readFileSync(CLI_PATH, 'utf8');
}

// Slice between `async function main()` and the matching dispatcher tail
// (`process.exit(EXIT.OK);` after default arm). Falls back to whole file if
// the main() body cannot be located.
function sliceMainBody(src) {
  const mainIdx = src.indexOf('async function main()');
  if (mainIdx < 0) return src;
  return src.slice(mainIdx);
}

// Build verb -> dispatcher map from `case 'verb':  await ... cmdXxx(rest)`
// arms. Some arms have inline branching (e.g. `cmd === 'export' ? cmdA : cmdB`)
// — for those we record the first cmd* symbol we see in the arm body up to
// the next `break;`.
function extractDispatchArms(mainBody) {
  const arms = [];
  // Match each `case 'name':` up to the next `break;` or `case '` or `default:`.
  const reCase = /case\s+['"]([\w\-:]+)['"]\s*:/g;
  const starts = [];
  let m;
  while ((m = reCase.exec(mainBody)) !== null) {
    starts.push({ verb: m[1], start: m.index, headEnd: m.index + m[0].length });
  }
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const nextStart = (i + 1 < starts.length) ? starts[i + 1].start : mainBody.length;
    const body = mainBody.slice(s.headEnd, nextStart);
    // Find every cmd* identifier reference in the arm body — but stop at the
    // first `break;` token so the next arm's case-fallthrough body does not
    // bleed in.
    const stopIdx = body.indexOf('break;');
    const armBody = stopIdx >= 0 ? body.slice(0, stopIdx) : body;
    const cmdRefs = Array.from(armBody.matchAll(/\bcmd([A-Z]\w+)\b/g)).map(x => 'cmd' + x[1]);
    const dispatcher = cmdRefs[0] || null;
    arms.push({ verb: s.verb, dispatcher, all_dispatchers: Array.from(new Set(cmdRefs)) });
  }
  return arms;
}

// Build dispatcher -> { flags } by scanning the body of each cmd* function.
// We look for occurrences of `--flag-name` literals in source text. Function
// bodies are sliced as: from `async function cmdXxx(` to the next top-level
// `async function ` (greedy, but kolm.js is flat so this is reliable).
function indexDispatchers(src) {
  const fnStarts = [];
  const reFn = /^async\s+function\s+(cmd[A-Z]\w+)\s*\(/gm;
  let m;
  while ((m = reFn.exec(src)) !== null) {
    fnStarts.push({ name: m[1], start: m.index, headEnd: m.index + m[0].length });
  }
  const fns = {};
  for (let i = 0; i < fnStarts.length; i++) {
    const s = fnStarts[i];
    const end = (i + 1 < fnStarts.length) ? fnStarts[i + 1].start : src.length;
    const body = src.slice(s.headEnd, end);
    // Capture `--flag` tokens (long form only; short flags are too ambiguous
    // to attribute reliably). Strip trailing punctuation.
    const flagSet = new Set();
    const reFlag = /--[a-z][a-z0-9-]+/g;
    let f;
    while ((f = reFlag.exec(body)) !== null) {
      const flag = f[0];
      if (flag.length > 2) flagSet.add(flag);
    }
    fns[s.name] = { flags: Array.from(flagSet).sort() };
  }
  return fns;
}

// Pull help_summary from HELP['<verb>'] entry — first non-empty line.
function indexHelpSummaries(src) {
  const helpIdx = src.indexOf('const HELP = {');
  if (helpIdx < 0) return {};
  // Crudely scan for `<key>: \`...\`` entries inside the HELP literal. We
  // stop at the first balanced `};` after the opener.
  const out = {};
  // Match keys: bare ident or 'quoted' / "quoted"
  const reEntry = /\n\s*(?:'([\w\-:]+)'|"([\w\-:]+)"|([\w]+))\s*:\s*`([^`]*)`/g;
  // Only scan from helpIdx onwards (so we do not match templates elsewhere).
  const helpRegion = src.slice(helpIdx);
  let m;
  while ((m = reEntry.exec(helpRegion)) !== null) {
    const key = m[1] || m[2] || m[3];
    if (!key) continue;
    const tpl = m[4] || '';
    const firstLine = tpl.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
    out[key] = firstLine;
  }
  return out;
}

function build() {
  const src = readSource();
  const mainBody = sliceMainBody(src);
  const arms = extractDispatchArms(mainBody);
  const fns = indexDispatchers(src);
  const helps = indexHelpSummaries(src);
  const rows = arms.map(({ verb, dispatcher, all_dispatchers }) => {
    const fnInfo = (dispatcher && fns[dispatcher]) || { flags: [] };
    const help_summary = helps[verb] || '';
    return {
      verb,
      dispatcher,
      all_dispatchers,
      flags: fnInfo.flags,
      help_summary,
    };
  });
  // Filter out flag-shaped pseudo-verbs (--version, -h, --help, help, -v).
  // These are bare aliases for `kolm version` / `kolm <command> --help` and
  // are not addressable as kolm <verb> Q-targets.
  const META_VERBS = new Set(['--help', '-h', '--version', '-v', 'help']);
  const filtered = rows.filter(r => !META_VERBS.has(r.verb));
  // De-dup by verb (preserve first occurrence — the canonical case arm).
  const seen = new Set();
  const deduped = [];
  for (const r of filtered) {
    if (seen.has(r.verb)) continue;
    seen.add(r.verb);
    deduped.push(r);
  }
  return { generated_at: new Date().toISOString(), count: deduped.length, verbs: deduped };
}

function main() {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const result = build();
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
  if (result.count === 0) {
    process.stderr.write('warn: scan-cli-verbs found 0 verbs in cli/kolm.js\n');
  } else {
    process.stdout.write(`scan-cli-verbs: ${result.count} verbs -> ${path.relative(REPO, OUT_PATH)}\n`);
  }
}

if (require.main === module) main();
module.exports = { build };
