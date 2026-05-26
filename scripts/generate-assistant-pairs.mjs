#!/usr/bin/env node
// W888-N — generate-assistant-pairs.
//
// For each seed in data/assistant-corpus/seeds.jsonl, dispatch the same
// system+user prompt to TWO teachers (Anthropic claude-opus-4-7 and OpenAI
// gpt-4o), compute a Jaccard token-set similarity over the two responses,
// merge above the threshold (keep the longer as canonical) or write the
// disagreement to disagreements.jsonl, drop any pair whose canonical
// response contains a hallucinated `kolm <verb>` invocation, and emit
// training-pairs.jsonl + training-passport.json.
//
// Defaults are DRY-RUN-FRIENDLY:
//   - --dry-run never makes external API calls (mock teacher responses).
//   - --budget 50 caps spend; abort when running cost exceeds the cap.
//   - Per-call cost is computed from a token table near the top.
//
// The gateway dispatcher lives at `kolm gateway test-call` in-tree (we
// looked — there is no `gateway dispatch` subcommand even though the plan
// uses that phrasing). We shell out via spawnSync when --dry-run is OFF.
// The wrapper keeps the dispatch surface modular so the caller can override
// via $KOLM_GATEWAY_URL (HTTP fallback) if the CLI is not on $PATH.
//
// Captures: every teacher call is logged via `kolm capture log` if that
// verb exists (we probe once with --help and gracefully skip if absent).
//
// Flags:
//   --seeds <path>         default data/assistant-corpus/seeds.jsonl
//   --out <path>           default data/assistant-corpus/training-pairs.jsonl
//   --passport <path>      default data/assistant-corpus/training-passport.json
//   --disagreements <p>    default data/assistant-corpus/disagreements.jsonl
//   --rejected <p>         default data/assistant-corpus/rejected.jsonl
//   --inventory <p>        default data/assistant-corpus/cli-inventory.json
//   --budget <dollars>     default 50; aborts cleanly when exceeded
//   --limit <N>            process only first N seeds (test mode)
//   --dry-run              skip teacher dispatch; emit placeholder responses
//   --json                 emit final passport to stdout
//   --namespace <ns>       capture lake namespace (default assistant-distill-2026-05-26)
//   --similarity <f>       jaccard threshold (default 0.85)
//   --run-id <s>           tag passport + rows with a run id (default ts-derived)
//   --help

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
const CORPUS_DIR = path.join(REPO, 'data', 'assistant-corpus');

// ---------- per-1k-token cost table (USD) ----------
// Anthropic claude-opus-4-7: $0.015 in / $0.075 out per 1k.
// OpenAI gpt-4o:             $0.005 in / $0.015 out per 1k.
// These are documented constants; the budget gate uses them as a deterministic
// cost model rather than parsing live billing telemetry.
const COST = {
  'anthropic:claude-opus-4-7': { in: 0.015 / 1000, out: 0.075 / 1000 },
  'openai:gpt-4o':             { in: 0.005 / 1000, out: 0.015 / 1000 },
};

// Dry-run synthetic cost per dispatch — defaults to 0 so a normal dry-run
// reports cost_usd: 0 (matching the W888-N spec). The budget lock-in test
// overrides this via --mock-cost-per-call to exercise the abort path
// without real spend.
const DRY_RUN_COST_PER_CALL_DEFAULT = 0;

// Jaccard similarity threshold above which we consider two teacher
// responses "in agreement". 0.85 is the spec value; document the choice
// here so a future reviewer doesn't need to chase the magic number.
const DEFAULT_SIMILARITY = 0.85;

// English stopwords — kept short and inline. We strip these before
// tokenizing so jaccard is computed over content words rather than glue.
const STOPWORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being','am',
  'of','in','on','at','for','to','from','by','with','as','about',
  'and','or','but','if','then','else','than','because','so',
  'this','that','these','those','it','its','they','them','their',
  'i','you','your','we','our','he','she','his','her',
  'do','does','did','done','have','has','had','having',
  'will','would','can','could','should','may','might','must','shall',
  'not','no','yes',
  'kolm', // very high-frequency in this corpus — strip so similarity isn't dominated by brand
]);

// ---------- arg parsing ----------
function parseArgs(argv) {
  const out = {
    seeds: path.join(CORPUS_DIR, 'seeds.jsonl'),
    outPairs: path.join(CORPUS_DIR, 'training-pairs.jsonl'),
    outPassport: path.join(CORPUS_DIR, 'training-passport.json'),
    outDisagreements: path.join(CORPUS_DIR, 'disagreements.jsonl'),
    outRejected: path.join(CORPUS_DIR, 'rejected.jsonl'),
    inventory: path.join(CORPUS_DIR, 'cli-inventory.json'),
    budget: 50,
    limit: 0,
    dryRun: false,
    json: false,
    namespace: 'assistant-distill-2026-05-26',
    similarity: DEFAULT_SIMILARITY,
    runId: '',
    mockCostPerCall: DRY_RUN_COST_PER_CALL_DEFAULT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a === '--seeds') out.seeds = argv[++i];
    else if (a === '--out') out.outPairs = argv[++i];
    else if (a === '--passport') out.outPassport = argv[++i];
    else if (a === '--disagreements') out.outDisagreements = argv[++i];
    else if (a === '--rejected') out.outRejected = argv[++i];
    else if (a === '--inventory') out.inventory = argv[++i];
    else if (a === '--budget') out.budget = Number(argv[++i]);
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--namespace') out.namespace = argv[++i];
    else if (a === '--similarity') out.similarity = Number(argv[++i]);
    else if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--mock-cost-per-call') out.mockCostPerCall = Number(argv[++i]);
  }
  if (!out.runId) {
    out.runId = 'w888n-' + new Date().toISOString().replace(/[:.]/g, '-');
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    'generate-assistant-pairs — W888-N Q&A generation (dual-teacher + jaccard merge).\n' +
    '\n' +
    'usage: node scripts/generate-assistant-pairs.mjs [flags]\n' +
    '\n' +
    'flags:\n' +
    '  --seeds <path>          default: data/assistant-corpus/seeds.jsonl\n' +
    '  --out <path>            default: data/assistant-corpus/training-pairs.jsonl\n' +
    '  --passport <path>       default: data/assistant-corpus/training-passport.json\n' +
    '  --disagreements <path>  default: data/assistant-corpus/disagreements.jsonl\n' +
    '  --rejected <path>       default: data/assistant-corpus/rejected.jsonl\n' +
    '  --inventory <path>      default: data/assistant-corpus/cli-inventory.json\n' +
    '  --budget <dollars>      default: 50 (aborts cleanly when exceeded)\n' +
    '  --limit <N>             only process first N seeds (test mode)\n' +
    '  --dry-run               no external API calls; mock teacher responses\n' +
    '  --json                  emit passport to stdout\n' +
    '  --namespace <ns>        capture lake namespace (default assistant-distill-2026-05-26)\n' +
    '  --similarity <f>        jaccard threshold (default 0.85)\n' +
    '  --run-id <s>            tag passport + rows with this run id\n' +
    '  --mock-cost-per-call <f> dry-run cost per teacher call (default 0; set\n' +
    '                          to a small number to exercise the budget abort\n' +
    '                          path without real spend)\n' +
    '  --help                  show this help\n'
  );
}

// ---------- jsonl io ----------
function readJsonl(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function appendJsonl(p, row) {
  ensureDir(p);
  fs.appendFileSync(p, JSON.stringify(row) + '\n');
}

function touch(p) {
  ensureDir(p);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
}

function resetFile(p) {
  ensureDir(p);
  fs.writeFileSync(p, '');
}

// ---------- inventory + verb extraction ----------
function loadInventory(p) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const verbs = new Set();
  for (const v of (raw.verbs || [])) {
    if (v && typeof v.verb === 'string') verbs.add(v.verb);
  }
  return verbs;
}

function extractKolmInvocations(text) {
  if (typeof text !== 'string') return [];
  const found = [];
  const inline = /`(kolm\s+[^`\n]+)`/g;
  let m;
  while ((m = inline.exec(text)) !== null) {
    found.push(m[1].trim());
  }
  const fenced = /```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g;
  while ((m = fenced.exec(text)) !== null) {
    const body = m[1] || '';
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim().replace(/^\$\s+/, '');
      if (t.startsWith('kolm ')) found.push(t);
    }
  }
  return found;
}

function extractVerb(invocation) {
  const norm = invocation.replace(/\s+/g, ' ').trim();
  if (!norm.startsWith('kolm')) return null;
  const rest = norm.slice('kolm'.length).trim();
  if (!rest) return null;
  const m = rest.match(/^([A-Za-z][A-Za-z0-9:_-]*)/);
  return m ? m[1] : null;
}

function findInvalidVerb(text, verbs) {
  const invocations = extractKolmInvocations(text);
  for (const inv of invocations) {
    const v = extractVerb(inv);
    if (!v) return { invocation: inv, invalid: null, reason: 'unparseable' };
    if (!verbs.has(v)) return { invocation: inv, invalid: v, reason: 'invalid_verb' };
  }
  return null;
}

// ---------- jaccard token-set similarity ----------
function tokenize(text) {
  if (typeof text !== 'string') return new Set();
  const tokens = new Set();
  // Lowercase, split on non-alphanumeric, filter stopwords + tiny tokens.
  const raw = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const t of raw) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    tokens.add(t);
  }
  return tokens;
}

function jaccard(aText, bText) {
  const a = tokenize(aText);
  const b = tokenize(bText);
  if (a.size === 0 && b.size === 0) return 1; // both empty = perfectly agreed
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------- system prompt ----------
function buildSystemPrompt(seed) {
  const refs = (seed.must_include || []).slice(0, 8);
  const refsLine = refs.length > 0
    ? refs.map(r => `- ${r}`).join('\n')
    : '(none provided — answer from general kolm knowledge only)';
  const sourcesLine = (seed.sources || []).slice(0, 4).join(', ') || '(unspecified)';
  return [
    'You are the kolm assistant. Answer only with facts from these sources:',
    sourcesLine,
    '',
    'Cite these references when relevant:',
    refsLine,
    '',
    'Rules:',
    "- If you don't know, say \"I'm not sure — check the docs at https://kolm.ai/docs/.\"",
    '- Never invent CLI verbs or flags. If you reference a `kolm <verb>` command, the verb MUST be real.',
    '- Format every CLI command in backticks (e.g. `kolm whoami`).',
    '- Stay under 200 words unless the user explicitly asks for more.',
    "- Do not use the words \"honest\" or \"honesty\" — say \"Caveats\", \"Constraints\", or \"Limitations\".",
  ].join('\n');
}

// ---------- gateway dispatch ----------
// Real path: shell out to `kolm gateway test-call --message ... --model ...`.
// Mock path: deterministic synthetic response keyed on seed.intent + provider.
// HTTP override: if $KOLM_GATEWAY_URL is set, POST to that URL instead of
// shelling out.

function mockResponse(provider, model, seed, systemPrompt) {
  // Mirror what an on-recipe teacher would say for a seed. Reference the
  // first must_include item (often a doc URL or page title) so the verb
  // check downstream still has something to chew on, AND echo each
  // remaining must_include item verbatim — this lets the rejection path
  // be exercised end-to-end when a seed deliberately stuffs a hallucinated
  // `kolm <fake>` snippet into must_include (the synthetic seed in the
  // wave888n-pair-generation test relies on this).
  //
  // We deliberately make the mock response provider-INDEPENDENT (no
  // mention of "anthropic" / "openai" / model name) so jaccard between the
  // two teacher dispatches is ~1.0 and dry-run pairs all "agree". This
  // simulates the post-merge state where both teachers landed on the same
  // canonical answer, which is the only path that exercises the full
  // pipeline downstream of the merge gate.
  const first = (seed.must_include && seed.must_include[0]) || seed.intent;
  const tail = (seed.must_include || []).slice(1).map(s => `- ${s}`).join('\n');
  return (
    `[DRY-RUN] would dispatch to teachers.\n` +
    `Reference: ${first}.\n` +
    (tail ? `Citations:\n${tail}\n` : '') +
    `Caveat: this is a placeholder — set --no-dry-run with KOLM_GATEWAY_URL ` +
    `or a working \`kolm gateway test-call\` to get a real teacher response.`
  );
}

// Returns { ok, response, usage:{prompt_tokens, completion_tokens}, raw, error? }
function dispatchTeacher(provider, model, systemPrompt, userPrompt, opts) {
  if (opts.dryRun) {
    const promptTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4);
    const compText = mockResponse(provider, model, opts.seed, systemPrompt);
    const completionTokens = Math.ceil(compText.length / 4);
    return {
      ok: true,
      response: compText,
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
      raw: { dry_run: true },
    };
  }
  // HTTP override path
  if (process.env.KOLM_GATEWAY_URL) {
    return dispatchTeacherHttp(provider, model, systemPrompt, userPrompt);
  }
  // Default path: shell out to the CLI test-call surface.
  return dispatchTeacherCli(provider, model, systemPrompt, userPrompt);
}

function dispatchTeacherCli(provider, model, systemPrompt, userPrompt) {
  const cli = process.env.KOLM_CLI || path.join(REPO, 'cli', 'kolm.js');
  const args = [
    cli, 'gateway', 'test-call',
    '--message', `${systemPrompt}\n\n---\n\n${userPrompt}`,
    '--model', model,
  ];
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, KOLM_GATEWAY_MODE: process.env.KOLM_GATEWAY_MODE || 'cloud' },
  });
  if (r.status !== 0) {
    return {
      ok: false,
      response: '',
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      error: { source: 'cli', status: r.status, stderr: (r.stderr || '').slice(0, 500) },
    };
  }
  // Parse the envelope. kolm gateway test-call emits a JSON object.
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); }
  catch {
    return {
      ok: false,
      response: '',
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      error: { source: 'cli', reason: 'unparseable_envelope', snippet: r.stdout.slice(0, 500) },
    };
  }
  const response = parsed?.response?.text || parsed?.response?.response || parsed?.response || '';
  const usage = parsed?.response?.usage || {};
  return {
    ok: !!parsed?.ok,
    response: typeof response === 'string' ? response : JSON.stringify(response),
    usage: {
      prompt_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      completion_tokens: usage.completion_tokens || usage.output_tokens || 0,
    },
    raw: parsed,
  };
}

function dispatchTeacherHttp(provider, model, systemPrompt, userPrompt) {
  const url = process.env.KOLM_GATEWAY_URL;
  // Node 18+ has global fetch. We block via Atomics-on-SharedArrayBuffer? No —
  // instead we shell out a tiny inline curl so this stays synchronous and
  // doesn't drag an async refactor through the rest of the script. (If you're
  // wiring a real cloud workflow, prefer to convert this whole script to an
  // async pipeline; that's a follow-up.)
  const body = JSON.stringify({
    provider, model,
    prompt: userPrompt, system: systemPrompt,
    max_tokens: 600,
  });
  // Try node-fetch via child process so the script stays sync. We invoke
  // a one-shot node -e to fetch and write JSON to stdout.
  const script =
    `const url=${JSON.stringify(url)};` +
    `const body=${JSON.stringify(body)};` +
    `fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{process.stderr.write(String(e));process.exit(1)});`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) {
    return {
      ok: false, response: '',
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      error: { source: 'http', status: r.status, stderr: (r.stderr || '').slice(0, 500) },
    };
  }
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); }
  catch {
    return {
      ok: false, response: '',
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      error: { source: 'http', reason: 'unparseable_response', snippet: r.stdout.slice(0, 500) },
    };
  }
  return {
    ok: true,
    response: parsed.response || parsed.text || '',
    usage: parsed.usage || { prompt_tokens: 0, completion_tokens: 0 },
    raw: parsed,
  };
}

// ---------- capture lake ----------
let captureLogAvailable = null;

function captureAvailable() {
  if (captureLogAvailable !== null) return captureLogAvailable;
  const cli = process.env.KOLM_CLI || path.join(REPO, 'cli', 'kolm.js');
  const r = spawnSync(process.execPath, [cli, 'capture', '--help'], {
    encoding: 'utf8', timeout: 8_000,
  });
  // Treat exit 0 OR stdout mentioning "capture" as available.
  captureLogAvailable = r.status === 0 || (r.stdout || '').toLowerCase().includes('capture');
  return captureLogAvailable;
}

function logCapture(namespace, payload) {
  if (!captureAvailable()) return false;
  const cli = process.env.KOLM_CLI || path.join(REPO, 'cli', 'kolm.js');
  const r = spawnSync(process.execPath, [
    cli, 'capture', 'log',
    '--namespace', namespace,
    '--event', 'teacher_dispatch',
    '--payload', JSON.stringify(payload),
  ], { encoding: 'utf8', timeout: 8_000 });
  return r.status === 0;
}

// ---------- cost ----------
function callCost(provider, model, usage, dryRun, mockCostPerCall) {
  if (dryRun) return mockCostPerCall || 0;
  const key = `${provider}:${model}`;
  const c = COST[key];
  if (!c) return 0;
  const inTok = usage.prompt_tokens || 0;
  const outTok = usage.completion_tokens || 0;
  return inTok * c.in + outTok * c.out;
}

// ---------- core pipeline ----------
function generate(args) {
  if (!fs.existsSync(args.seeds)) {
    return { ok: false, error: `seeds file not found: ${args.seeds}` };
  }
  if (!fs.existsSync(args.inventory)) {
    return { ok: false, error: `inventory file not found: ${args.inventory}` };
  }

  const allSeeds = readJsonl(args.seeds);
  const seeds = args.limit > 0 ? allSeeds.slice(0, args.limit) : allSeeds;
  const verbs = loadInventory(args.inventory);

  // Reset outputs so reruns are deterministic.
  resetFile(args.outPairs);
  resetFile(args.outDisagreements);
  resetFile(args.outRejected);

  const teachers = [
    { provider: 'anthropic', model: 'claude-opus-4-7' },
    { provider: 'openai',    model: 'gpt-4o' },
  ];

  let runningCost = 0;
  let kept = 0, disagreed = 0, rejected = 0;
  let budgetAborted = false;
  let seedsProcessed = 0;
  const bucketKept = {};
  const errors = [];

  const startIso = new Date().toISOString();
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    if (runningCost >= args.budget) {
      budgetAborted = true;
      break;
    }
    const systemPrompt = buildSystemPrompt(seed);
    const userPrompt = seed.intent || seed.prompt || '';

    const teacherResults = [];
    for (const t of teachers) {
      const dispatched = dispatchTeacher(
        t.provider, t.model, systemPrompt, userPrompt,
        { dryRun: args.dryRun, seed }
      );
      const cost = callCost(t.provider, t.model, dispatched.usage || {}, args.dryRun, args.mockCostPerCall);
      runningCost += cost;
      teacherResults.push({ ...t, ...dispatched, cost });
      // Capture every call (best-effort).
      logCapture(args.namespace, {
        run_id: args.runId,
        seed_id: seed.id,
        provider: t.provider,
        model: t.model,
        ok: !!dispatched.ok,
        cost_usd: cost,
        ts: new Date().toISOString(),
      });
      if (runningCost >= args.budget) {
        budgetAborted = true;
        break;
      }
    }

    // If we aborted mid-seed, don't count this row at all.
    if (budgetAborted && teacherResults.length < teachers.length) break;

    const [a, b] = teacherResults;
    // If either teacher failed cleanly, treat as disagreement (the manual
    // queue is the right place for partial responses).
    if (!a.ok || !b.ok || !a.response || !b.response) {
      disagreed += 1;
      appendJsonl(args.outDisagreements, {
        seed_id: seed.id,
        reason: 'teacher_error',
        claude: { ok: a.ok, response: a.response, error: a.error || null },
        gpt4o: { ok: b.ok, response: b.response, error: b.error || null },
        run_id: args.runId,
      });
      seedsProcessed += 1;
      if ((i + 1) % 50 === 0) progressTick(i + 1, seeds.length, runningCost);
      continue;
    }

    const sim = jaccard(a.response, b.response);
    const agreed = sim >= args.similarity;

    if (!agreed) {
      disagreed += 1;
      appendJsonl(args.outDisagreements, {
        seed_id: seed.id,
        similarity: sim,
        threshold: args.similarity,
        claude_response: a.response,
        gpt4o_response: b.response,
        run_id: args.runId,
      });
      seedsProcessed += 1;
      if ((i + 1) % 50 === 0) progressTick(i + 1, seeds.length, runningCost);
      continue;
    }

    // Keep the longer of the two as canonical (per spec: "If both above
    // threshold → keep the longer of the two as canonical.").
    const canonical = a.response.length >= b.response.length ? a.response : b.response;

    // Verb validity check — every backticked `kolm <verb>` must be real.
    const bad = findInvalidVerb(canonical, verbs);
    if (bad) {
      rejected += 1;
      appendJsonl(args.outRejected, {
        seed_id: seed.id,
        reason: bad.reason,
        invalid: bad.invalid,
        invocation: bad.invocation,
        canonical_response: canonical,
        run_id: args.runId,
      });
      seedsProcessed += 1;
      if ((i + 1) % 50 === 0) progressTick(i + 1, seeds.length, runningCost);
      continue;
    }

    const row = {
      id: seed.id,
      bucket: seed.bucket,
      source: (seed.sources && seed.sources[0]) || null,
      prompt: userPrompt,
      response: canonical,
      teacher_consensus: {
        agreed: true,
        similarity: sim,
        claude_response: a.response,
        gpt4o_response: b.response,
      },
      provenance: {
        teacher_models: [
          { provider: a.provider, model: a.model },
          { provider: b.provider, model: b.model },
        ],
        gateway_version: 'w742-v1',
        timestamp_iso: new Date().toISOString(),
        seed_row_id: seed.id,
        run_id: args.runId,
      },
    };
    appendJsonl(args.outPairs, row);
    kept += 1;
    bucketKept[seed.bucket] = (bucketKept[seed.bucket] || 0) + 1;
    seedsProcessed += 1;
    if ((i + 1) % 50 === 0) progressTick(i + 1, seeds.length, runningCost);
  }

  // Ensure the rejected and disagreements files exist even if 0 rows landed,
  // so downstream agents can `fs.readFileSync` without an existence guard.
  touch(args.outRejected);
  touch(args.outDisagreements);

  const passport = {
    run_id: args.runId,
    generated_at: new Date().toISOString(),
    started_at: startIso,
    dry_run: !!args.dryRun,
    budget_usd: args.budget,
    cost_usd: Number(runningCost.toFixed(6)),
    budget_aborted: budgetAborted,
    counts: {
      seeds_in: allSeeds.length,
      seeds_processed: seedsProcessed,
      seeds_limit: args.limit || null,
      kept,
      disagreed,
      rejected,
    },
    bucket_kept: bucketKept,
    teacher_models: [
      { provider: 'anthropic', model: 'claude-opus-4-7' },
      { provider: 'openai',    model: 'gpt-4o' },
    ],
    similarity_threshold: args.similarity,
    similarity_metric: 'jaccard_token_set',
    capture_namespace: args.namespace,
    capture_available: captureAvailable(),
    env: {
      node_version: process.version,
      os: `${process.platform}-${process.arch}`,
    },
    outputs: {
      pairs: relPath(args.outPairs),
      disagreements: relPath(args.outDisagreements),
      rejected: relPath(args.outRejected),
    },
    version: 'w888n-v1',
  };
  ensureDir(args.outPassport);
  fs.writeFileSync(args.outPassport, JSON.stringify(passport, null, 2));

  return { ok: true, passport };
}

function relPath(p) {
  const r = path.relative(REPO, p);
  return r.split(path.sep).join('/');
}

function progressTick(done, total, cost) {
  const pct = ((done / total) * 100).toFixed(1);
  process.stderr.write(
    `[w888n] ${done}/${total} (${pct}%) · cost=$${cost.toFixed(4)}\n`
  );
}

// ---------- entrypoint ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = generate(args);
  if (!result.ok) {
    process.stderr.write(`error: ${result.error}\n`);
    process.exit(2);
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(result.passport, null, 2) + '\n');
  } else {
    const p = result.passport;
    process.stdout.write(
      `wrote ${p.counts.kept} pairs -> ${args.outPairs}\n` +
      `disagreements: ${p.counts.disagreed} -> ${args.outDisagreements}\n` +
      `rejected:      ${p.counts.rejected} -> ${args.outRejected}\n` +
      `passport:      ${args.outPassport}\n` +
      `cost:          $${p.cost_usd.toFixed(4)} / $${p.budget_usd} budget` +
      (p.budget_aborted ? ' (ABORTED)\n' : '\n')
    );
  }
  process.exit(0);
}

// Run if invoked directly (not when imported as a module).
const isDirectInvoke = (() => {
  try {
    return path.resolve(process.argv[1] || '') === __filename;
  } catch { return false; }
})();
if (isDirectInvoke) main();

export {
  parseArgs, generate, jaccard, tokenize,
  extractKolmInvocations, extractVerb, findInvalidVerb,
  buildSystemPrompt, callCost, COST, DRY_RUN_COST_PER_CALL_DEFAULT,
};
