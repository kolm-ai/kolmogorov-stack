// W921 — Studio engine CLI front-door lock-in.
//
// The engine modules (src/model-merge.js, src/distill-grpo.js,
// src/distill-efficiency.js, src/distill-preference.js, src/judge-calibration.js,
// src/artifact-lineage.js) and their unit tests already ship. This wave wires the
// CLI front doors. The live paths need a GPU / trainer / server, so the
// behavioral cases here exercise the OFFLINE branches (arg-parse, enum
// pre-validation, fail-before-spend refusals, plan envelopes) plus source-level
// lock-ins that the seven front doors are wired:
//   (1) cmdMerge -> mergeAdapters (N-adapter delta-W merge + lineage)
//   (2) cmdDistillLocalWorker -> trainer-variant env (lora-variant/neftune/optim/...)
//   (3) kolm distill grpo -> trainGrpo + buildPromptsJsonl
//   (4) kolm distill --local-worker --objective ... (logit-objective teacher-local guard)
//   (5) kolm distill preference mine -> mineDisagreementPairs/writePreferencePairs
//   (6) kolm gate explain -> judge-calibration gate_decision + compile --json surface
//   (7) kolm data synth -> recipe-loader synth vocabulary + plan envelope

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const KOLM_JS = path.join(REPO, 'cli', 'kolm.js');
const SRC = fs.readFileSync(KOLM_JS, 'utf8');

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921studio-'));
  fs.mkdirSync(path.join(dir, '.kolm'), { recursive: true });
  return dir;
}

function runKolm(args, extraEnv = {}) {
  const home = extraEnv.HOME || freshHome();
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, KOLM_HOME: home,
    KOLM_ASSISTANT: '0', KOLM_NO_INTERACTIVE: '1', KOLM_NO_PROGRESS: '1', NO_COLOR: '1',
    ...extraEnv,
  };
  delete env.KOLM_API_KEY;
  const r = spawnSync(process.execPath, [KOLM_JS, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  let json = null; try { json = JSON.parse(r.stdout); } catch (_) {}
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

// ─────────────────────────── (1) merge -> mergeAdapters ──────────────────────

test('W921-STUDIO.1 cmdMerge routes the adapter path through model-merge.mergeAdapters', () => {
  assert.match(SRC, /async function cmdMergeAdapters\(args/);
  const start = SRC.indexOf('async function cmdMergeAdapters(args');
  const body = SRC.slice(start, start + 6000);
  assert.match(body, /import\('\.\.\/src\/model-merge\.js'\)/, 'imports model-merge.js');
  assert.match(body, /mm\.mergeAdapters\(\{/, 'calls mergeAdapters()');
  assert.match(body, /method,\s*\n\s*weights,/, 'threads weights');
  assert.match(body, /majoritySign,/, 'threads majority-sign');
  assert.match(body, /svdRank,/, 'threads svd-rank');
  assert.match(body, /evalHoldout,/, 'threads eval-holdout');
});

test('W921-STUDIO.2 cmdMerge binds multi-parent lineage via setMergeParents', () => {
  const start = SRC.indexOf('async function cmdMergeAdapters(args');
  const body = SRC.slice(start, start + 6000);
  assert.match(body, /artifact-lineage\.js/, 'imports artifact-lineage');
  assert.match(body, /lin\.setMergeParents\(/, 'calls setMergeParents');
});

test('W921-STUDIO.3 legacy two-.kolm recipe merge is preserved (back-compat)', () => {
  // The legacy path still imports kolm-state.mergeRecipes; the adapter branch is
  // strictly opt-in (NOT --dry-run AND adapter-shaped invocation).
  assert.match(SRC, /state\.mergeRecipes\(base, head/, 'recipe merge path intact');
  assert.match(SRC, /const wantAdapterMerge = !args\.includes\('--dry-run'\)/, 'adapter branch gated off --dry-run');
});

test('W921-STUDIO.4 merge --adapters with mismatched --weights count is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921merge-'));
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, 'b'));
  const r = runKolm(['merge', path.join(dir, 'a'), path.join(dir, 'b'), '--method', 'ties', '--weights', '0.5', '--json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--weights has 1 entries but 2 adapters/);
});

test('W921-STUDIO.5 merge rejects an unknown method against the model-merge enum', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921merge-'));
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, 'b'));
  const r = runKolm(['merge', path.join(dir, 'a'), path.join(dir, 'b'), '--method', 'bogus_method', '--json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--method must be one of/);
});

// ─────────────────── (2) local-worker trainer variants ───────────────────────

test('W921-STUDIO.6 local-worker accepts + normalizes the trainer-variant flags', () => {
  const start = SRC.indexOf('async function cmdDistillLocalWorker(args');
  const body = SRC.slice(start, start + 18000);
  assert.match(body, /pick\('--lora-variant'\)/);
  assert.match(body, /pick\('--lora-init'\)/);
  assert.match(body, /pick\('--neftune'\)/);
  assert.match(body, /pick\('--optim'\)/);
  assert.match(body, /pick\('--galore-rank'\)/);
  assert.match(body, /pick\('--galore-proj-gap'\)/);
  assert.match(body, /pick\('--train-preset'\)/);
  assert.match(body, /pick\('--quality-preset'\)/);
  assert.match(body, /args\.includes\('--packing'\)/);
  assert.match(body, /eff\.normalizeTrainerVariantOptions\(vopts\)/, 'normalizes via distill-efficiency');
  assert.match(body, /eff\.buildTrainerVariantEnv\(normalisedVariant\)/, 'builds the variant env');
});

test('W921-STUDIO.7 the variant env is merged into the worker spawn env', () => {
  assert.match(SRC, /env: \{ \.\.\.process\.env, \.\.\._w870ProxyEnv, \.\.\._w787Env, \.\.\._w921VariantEnv, \.\.\._w921ObjectiveEnv \}/);
});

test('W921-STUDIO.8 local-worker auto-maps recipe.train.* to the same env', () => {
  const start = SRC.indexOf('async function cmdDistillLocalWorker(args');
  const body = SRC.slice(start, start + 14000);
  assert.match(body, /_w921RecipeTrain/, 'reads a recipe train block from --spec');
  assert.match(body, /if \(t\.preset != null\) vopts\.preset = t\.preset/);
  assert.match(body, /if \(t\.lora_variant != null\) vopts\.lora_variant = t\.lora_variant/);
  assert.match(body, /if \(t\.backend != null\) vopts\.backend = t\.backend/);
  // Explicit CLI flags override the recipe values.
  assert.match(body, /if \(_w921TrainPreset != null\) vopts\.preset = _w921TrainPreset/);
  assert.match(body, /if \(_w921LoraVariant != null\) vopts\.lora_variant = _w921LoraVariant/);
});

test('W921-STUDIO.9 a bad --lora-variant fails before the spawn (fail-before-spend)', () => {
  const r = runKolm(['distill', '--local-worker', '--mode', 'stub', '--spec', '/tmp/x', '--seeds', '/tmp/y', '--out', '/tmp/z', '--lora-variant', 'bogus']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lora_variant must be one of/);
});

test('W921-STUDIO.10 galore optim + qlora method conflict is refused before spawn', () => {
  const r = runKolm(['distill', '--local-worker', '--mode', 'stub', '--spec', '/tmp/x', '--seeds', '/tmp/y', '--out', '/tmp/z', '--optim', 'galore_adamw', '--distillation-method', 'qlora']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /galore optimizer is incompatible with method=qlora/);
});

// ─────────────────────── (3) distill grpo ────────────────────────────────────

test('W921-STUDIO.11 cmdDistillGrpo is wired into cmdDistill', () => {
  assert.match(SRC, /if \(args\[0\] === 'grpo'\) return cmdDistillGrpo\(args\.slice\(1\)\)/);
  assert.match(SRC, /async function cmdDistillGrpo\(args\)/);
  const start = SRC.indexOf('async function cmdDistillGrpo(args)');
  const body = SRC.slice(start, start + 14000);
  assert.match(body, /buildPromptsJsonl, trainGrpo/, 'imports buildPromptsJsonl + trainGrpo');
  assert.match(body, /buildPromptsJsonl\(seeds, \{ family: rewards\[0\] \}, promptsPath\)/);
  assert.match(body, /trainGrpo\(\{/);
});

test('W921-STUDIO.12 distill grpo doctor returns a parseable envelope', () => {
  const r = runKolm(['distill', 'grpo', 'doctor']);
  assert.ok(r.json, 'doctor emits JSON');
  assert.equal(r.json.kind, 'distill_grpo');
  assert.ok(Array.isArray(r.json.reward_families));
});

test('W921-STUDIO.13 distill grpo rejects an unknown reward family', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921grpo-'));
  const seeds = path.join(dir, 'seeds.jsonl');
  fs.writeFileSync(seeds, '{"prompt":"p","tests":"t"}\n');
  const r = runKolm(['distill', 'grpo', '--seeds', seeds, '--student', '/tmp/s', '--reward', 'not_a_reward']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--reward must be one of/);
});

// ─────────────────────── (4) distill --objective ─────────────────────────────

test('W921-STUDIO.14 local-worker threads --objective with a teacher-local guard', () => {
  const start = SRC.indexOf('async function cmdDistillLocalWorker(args');
  const body = SRC.slice(start, start + 14000);
  assert.match(body, /const objective = pick\('--objective'\)/);
  assert.match(body, /const teacherLocal = args\.includes\('--teacher-local'\)/);
  assert.match(body, /LOGIT_OBJECTIVES\.has\(objective\) && !teacherLocal/, 'logit objectives gated on --teacher-local');
  assert.match(body, /KOLM_DISTILL_OBJECTIVE/, 'objective passed to trainer env');
});

test('W921-STUDIO.15 a logit objective without --teacher-local is refused', () => {
  const r = runKolm(['distill', '--local-worker', '--mode', 'stub', '--spec', '/tmp/x', '--seeds', '/tmp/y', '--out', '/tmp/z', '--objective', 'distillm2']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /requires teacher LOGITS/);
});

test('W921-STUDIO.16 a bad --objective enum is rejected', () => {
  const r = runKolm(['distill', '--local-worker', '--mode', 'stub', '--spec', '/tmp/x', '--seeds', '/tmp/y', '--out', '/tmp/z', '--objective', 'nope']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--objective must be one of/);
});

// ─────────────────── (5) distill preference mine ─────────────────────────────

test('W921-STUDIO.17 distill preference mine routes to the miner + writer', () => {
  const start = SRC.indexOf('async function cmdDistillPreference(args');
  const body = SRC.slice(start, start + 5000);
  assert.match(body, /if \(sub === 'mine'\)/, 'mine subverb wired');
  assert.match(body, /mineDisagreementPairs, writePreferencePairs/, 'imports the miner + writer');
  assert.match(body, /mineDisagreementPairs\(rows, mineOpts\)/);
  assert.match(body, /writePreferencePairs\(mined\.pairs, outFile, \{ format \}\)/);
});

test('W921-STUDIO.18 distill preference mine produces DPO pairs end-to-end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921mine-'));
  const rows = path.join(dir, 'rows.jsonl');
  const out = path.join(dir, 'pairs.jsonl');
  fs.writeFileSync(rows, JSON.stringify({
    prompt: 'q1',
    candidates: [
      { model: 'a', text: 'a clear substantive correct answer to the question' },
      { model: 'b', text: '<think>leak</think> i cannot help' },
    ],
  }) + '\n');
  const r = runKolm(['distill', 'preference', 'mine', '--in', rows, '--out', out, '--json']);
  assert.ok(r.json && r.json.ok === true, 'mine ok');
  assert.equal(r.json.written.count, 1);
  const written = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok('chosen' in written[0] && 'rejected' in written[0], 'pref-format pairs written');
});

test('W921-STUDIO.19 distill preference mine --format kto writes label rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921mine-'));
  const rows = path.join(dir, 'rows.jsonl');
  const out = path.join(dir, 'kto.jsonl');
  fs.writeFileSync(rows, JSON.stringify({
    prompt: 'q', candidates: [{ model: 'a', text: 'good full answer to the prompt' }, { model: 'b', text: 'no' }],
  }) + '\n');
  const r = runKolm(['distill', 'preference', 'mine', '--in', rows, '--out', out, '--format', 'kto', '--json']);
  assert.ok(r.json && r.json.ok === true);
  const written = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(written.every((w) => 'label' in w && 'completion' in w), 'kto rows carry label + completion');
});

// ─────────────────────── (6) gate explain + compile surface ──────────────────

test('W619-BON.1 local-worker exposes --bon as the rejection-sampling N alias', () => {
  const start = SRC.indexOf('async function cmdDistillLocalWorker(args');
  const body = SRC.slice(start, start + 13000);
  assert.match(body, /const bonN = pick\('--bon'\)/, 'reads --bon');
  assert.match(body, /const rsN = rsNFlag \|\| bonN/, 'uses --bon as --rs-n alias');
  assert.match(body, /--bon\/--rs-n must be an integer/, 'validates before worker spawn');
  assert.match(body, /passthru\.push\(`--rs-n=\$\{rsN\}`\)/, 'forwards to worker rs-n contract');
});

test('W619-BON.2 bad local-worker --bon is rejected before spend', () => {
  const r = runKolm(['distill', '--local-worker', '--mode', 'rejection_sampling', '--spec', '/tmp/x', '--seeds', '/tmp/y', '--out', '/tmp/z', '--bon', '0']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--bon\/--rs-n must be an integer/);
});

test('W619-BON.3 distill preference bon writes SeqKD targets end-to-end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w619bon-'));
  const rows = path.join(dir, 'rows.jsonl');
  const out = path.join(dir, 'targets.jsonl');
  fs.writeFileSync(rows, JSON.stringify({
    prompt: 'How should support process a refund?',
    seed_output: 'refund to original payment method with confirmation',
    candidates: [
      { text: 'no' },
      { text: 'Process the refund to the original payment method and send confirmation.' },
    ],
  }) + '\n');
  const r = runKolm(['distill', 'preference', 'bon', '--in', rows, '--out', out, '--bon', '2', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.json && r.json.ok === true, 'bon ok');
  assert.equal(r.json.written.count, 1);
  const written = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(written[0].input, 'How should support process a refund?');
  assert.equal(written[0].output, 'Process the refund to the original payment method and send confirmation.');
  assert.equal(written[0].teacher_output, written[0].output);
  assert.equal(written[0].bon.n_requested, 2);
});

test('W921-STUDIO.20 cmdGate explain routes to judge-calibration attachGateDecision', () => {
  assert.match(SRC, /async function cmdGate\(args\)/);
  assert.match(SRC, /case 'gate':\s*await withErrorContext\('gate'/);
  const start = SRC.indexOf('async function cmdGate(args)');
  const body = SRC.slice(start, start + 4000);
  assert.match(body, /import\('\.\.\/src\/judge-calibration\.js'\)/);
  assert.match(body, /attachGateDecision\(\{ composite \}, input\)/);
  assert.match(body, /decision\.state/, 'renders ship/abstain/reject state');
});

test('W921-STUDIO.21 compile --json surfaces gate_decision additively (low-risk)', () => {
  // Additive only: gate_decision is spread in conditionally, never replacing a field.
  assert.match(SRC, /_w921GateDecision = attachGateDecision\(\{ composite: r\.k_score\.composite \}/);
  assert.match(SRC, /\.\.\.\(_w921GateDecision \? \{ gate_decision: _w921GateDecision \} : \{\}\)/);
});

test('W921-STUDIO.22 gate explain on a missing artifact exits non-zero', () => {
  const r = runKolm(['gate', 'explain', '/no/such/artifact.kolm', '--json']);
  assert.notEqual(r.status, 0);
});

// ─────────────────────── (7) data synth ──────────────────────────────────────

test('W921-STUDIO.23 cmdData synth validates the recipe-loader synth vocabulary', () => {
  assert.match(SRC, /async function cmdData\(args\)/);
  assert.match(SRC, /case 'data':\s*await withErrorContext\('data'/);
  const start = SRC.indexOf('async function cmdData(args)');
  const body = SRC.slice(start, start + 5000);
  assert.match(body, /\['magpie', 'evol', 'persona-hub', 'glan', 'self-instruct'\]/, 'mirrors VALID_SYNTH_GENERATORS');
  assert.match(body, /loadRecipe\(recipeFlag\)/, 'validates a recipe via the loader');
});

test('W921-STUDIO.24 data synth emits a planned (not fabricated) envelope', () => {
  const r = runKolm(['data', 'synth', 'magpie', '--target', '2000', '--max-share', '0.4', '--json']);
  assert.ok(r.json && r.json.ok === true);
  assert.equal(r.json.status, 'planned');
  assert.equal(r.json.stage, 'augment');
  assert.equal(r.json.generator, 'magpie');
  // It must NOT fabricate rows — only a plan + constraints.
  assert.ok(Array.isArray(r.json.constraints) && r.json.constraints.length > 0);
});

test('W921-STUDIO.25 data synth rejects an unknown generator', () => {
  const r = runKolm(['data', 'synth', 'not-a-generator', '--json']);
  assert.equal(r.json && r.json.error, 'invalid_value');
  assert.equal(r.json.field, 'generator');
  assert.notEqual(r.status, 0);
});

// ─────────────────────── completion + verb surface ───────────────────────────

test('W921-STUDIO.26 gate + data are in COMPLETION_VERBS with dispatch + subs', () => {
  const m = SRC.match(/const COMPLETION_VERBS = \[([\s\S]*?)\];/);
  assert.ok(m, 'found COMPLETION_VERBS');
  assert.match(m[1], /'gate', 'data'/, 'gate + data registered as verbs');
  assert.match(SRC, /gate:\s*\['explain'\]/, 'gate subs');
  assert.match(SRC, /data:\s*\['synth'\]/, 'data subs');
  assert.match(SRC, /distill:\s*\[[^\]]*'grpo'[^\]]*\]/, 'grpo in distill subs');
});
