#!/usr/bin/env node
// workers/distill/distill.mjs
//
// Wave J — isolated kolm distillation worker. Lives in its own package so
// the heavy ML deps (torch, transformers, peft, bitsandbytes, sentencepiece,
// accelerate, datasets) NEVER land in the root kolm install. The root CLI
// invokes this worker only when the tenant explicitly opts in via
// `kolm distill --local-worker`.
//
// Pipeline:
//   1. Read spec.json + seeds.jsonl
//   2. Split train/holdout deterministically (matches src/spec-compile.js
//      seed gate)
//   3. For each train row:
//        a. Redact PHI via src/phi-redactor.js (Q+3a)
//        b. Call teacher (Anthropic / OpenAI / local) via teacher-bridge
//        c. Reinject identifiers into teacher response
//        d. Append { input, teacher_output } to training-pairs.jsonl
//   4. Optional: invoke scripts/train_lora.py for the actual LoRA fine-tune.
//      ONLY runs when both python3 AND torch are detected. Otherwise stops
//      at step 3 and writes an honest manifest:
//        ml_pipeline_run: false
//        training_pairs_collected: <N>
//        next: "install torch + transformers + peft in a Python venv to run
//               the LoRA fine-tune; this worker remains the right entry"
//
// Modes:
//   --doctor           print toolchain readiness and exit
//   --mode=collect     run steps 1-3 (collect training pairs only)
//   --mode=stub        run steps 1-2 + emit deterministic stub manifest (no
//                      teacher calls; used in offline tests)
//   --mode=full        run 1-4 (requires Python ML stack present)
//
// Required flags for collect/full:
//   --spec <path>
//   --seeds <path>
//   --out <dir>
//   --teacher <vendor:model>     (or --no-teacher in stub mode)
//   --student-base <name>        (informational; recorded in manifest)
//
// Optional:
//   --max-rows <N>               cap teacher calls (default: 200)
//   --split-seed <int>           defaults to 1 (matches kolm compile)
//   --redact / --no-redact       default: --redact
//   --redact-class <class>       (wave 157) tag the redactor profile applied to this
//                                run: phi | pci | multi | none | auto. Recorded in
//                                manifest.redact_class so the artifact's verifier
//                                check #14 can confirm receipt-chain completeness
//                                (redaction_map_hash + teacher_call_log_hash +
//                                reinjection_log_hash all present when class != 'none').
//   --local-endpoint <url>       for vendor=local
//   --local-api-key <key>        for vendor=local
//   --teacher-holdout            (wave 145) invoke teacher on holdout inputs
//                                AFTER training-pair collection; record
//                                teacher_holdout_accuracy + teacher_holdout_log_hash
//                                in the manifest so the K-score T axis
//                                (student_holdout / teacher_holdout) is
//                                computable downstream. Comparator is
//                                exact-after-normalize by default.
//   --teacher-holdout-max <N>    cap teacher holdout calls (default: 50)
//   --teacher-holdout-comparator <name>
//                                exact (default) | substring | jaccard
//   --student-holdout <path>     eval-only JSONL for train_lora.py; never used
//                                for training-pair collection.
//   --train-from-seeds           build training-pairs.jsonl from split train
//                                seed outputs instead of calling a teacher.
//   --export-portable <gguf>     after successful full training, attempt a real
//                                portable export; missing toolchains are
//                                recorded honestly, never faked.
//   --export-quant <Q4_K_M>      GGUF quant level for --export-portable.
//   --export-skip-coherence      skip the llama-cli coherence probe.
//   --train-preset <qdora>       one-click quality preset.
//   --train-method <qlora|lora>  trainer method override; qlora forwards
//                                --qlora into train_lora.py.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { callTeacher, parseTeacherSpec } from './teacher-bridge.mjs';
import {
  isKnownStudentBase,
  studentBaseEntry,
  isKnownDistillationMethod,
  DISTILLATION_METHODS,
  STUDENT_BASES,
  formatCatalogSummary,
  formatCatalogJson,
} from './catalog.mjs';
// Wave 253 ML#7: delegate splitting to the canonical src/seeds.js so the
// distill worker and the build path agree on what holdout is. The legacy
// in-worker `splitSeeds` used a divergent `% 5` bucket scheme that did not
// match `src/seeds.js`'s 1000-bucket scheme, so a row that was "train" for the
// build was sometimes "holdout" for the distill worker. The audit flagged
// this as ML#7. The wrapper below preserves the (rows, splitSeed:number)
// signature this file calls with while delegating the actual logic.
import { splitSeeds as canonicalSplitSeeds } from '../../src/seeds.js';
import { buildTrainLaunchPlan } from '../../src/distill-recipe-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..', '..');

const args = parseArgs(process.argv.slice(2));

if (args.doctor) {
  console.log(JSON.stringify(await doctor(), null, 2));
  process.exit(0);
}

// Wave 158 — `--list-catalog` prints the teacher vendor/model + student-base
// + distillation-method catalog and exits. Used by `kolm distill --list-catalog`
// surface so tenants don't have to crack open catalog.mjs. `--json` switches
// to a stable JSON shape so automation can parse it without scraping the
// pretty-printed form.
if (args['list-catalog']) {
  if (args.json) {
    console.log(JSON.stringify(formatCatalogJson(), null, 2));
  } else {
    console.log(formatCatalogSummary());
  }
  process.exit(0);
}

const mode = args.mode || 'collect';
if (!['collect', 'stub', 'full'].includes(mode)) {
  fail(`unknown --mode=${mode}; expected collect | stub | full`);
}

const specPath  = args.spec  ? path.resolve(process.cwd(), args.spec)  : null;
const seedsPath = args.seeds ? path.resolve(process.cwd(), args.seeds) : null;
const outDir    = args.out   ? path.resolve(process.cwd(), args.out)   : null;

if (!specPath || !seedsPath || !outDir) {
  fail('--spec, --seeds, and --out are required (use --mode=stub for offline)');
}
if (!fs.existsSync(specPath))  fail(`spec not found: ${specPath}`);
if (!fs.existsSync(seedsPath)) fail(`seeds not found: ${seedsPath}`);

fs.mkdirSync(outDir, { recursive: true });

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const seeds = readSeeds(seedsPath);
const split = splitSeeds(seeds, Number(args['split-seed'] || 1));

// Summary form of the split: counts + hashes only, never row content. The
// full row content lives in (train|holdout).jsonl on disk so a downstream
// consumer (kolm compile --distill-provenance) can re-hash and confirm.
const splitSummary = {
  seeds_path: seedsPath,
  seeds_basename: path.basename(seedsPath),
  split_seed: Number(args['split-seed'] || 1),
  train_count: split.train.length,
  holdout_count: split.holdout.length,
  train_hash: rowsHash(split.train),
  holdout_hash: rowsHash(split.holdout),
};
writeJson(path.join(outDir, 'split.json'), splitSummary);
fs.writeFileSync(path.join(outDir, 'train.jsonl'),
  split.train.map(r => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'holdout.jsonl'),
  split.holdout.map(r => JSON.stringify(r)).join('\n') + '\n');
const studentHoldoutPath = args['student-holdout']
  ? path.resolve(process.cwd(), String(args['student-holdout']))
  : (split.holdout.length > 0 ? path.join(outDir, 'holdout.jsonl') : null);
const studentHoldoutRows = studentHoldoutPath && fs.existsSync(studentHoldoutPath)
  ? readHoldoutRows(studentHoldoutPath)
  : [];
const studentHoldoutSource = args['student-holdout']
  ? 'explicit'
  : (split.holdout.length > 0 ? 'worker_split' : null);
const studentHoldoutHash = studentHoldoutPath && fs.existsSync(studentHoldoutPath)
  ? fileSha256(studentHoldoutPath)
  : null;

// Wave 158 — student-base catalog validation. Accepts catalog slugs OR any
// "org/repo" form (for HF repos that aren't in the catalog yet) when
// --allow-unknown-student-base is set. Default behavior: catalog only.
const studentBaseArg = args['student-base'] || null;
const allowUnknownBase = args['allow-unknown-student-base'] === true;
if (studentBaseArg && !isKnownStudentBase(studentBaseArg) && !allowUnknownBase) {
  fail(`unknown --student-base "${studentBaseArg}"; expected one of [${Object.keys(STUDENT_BASES).join(', ')}] or pass --allow-unknown-student-base`);
}

// Wave 158 — distillation method (record-only when ml_pipeline_run=false,
// authoritative when true). Defaults: 'lora' when --mode=full and ML stack
// present, 'prompt-distill' when collect mode only. Tenants can override
// (e.g., --distillation-method=qlora) so the receipt chain records what they
// actually ran with downstream scripts.
const distillMethodArg = args['distillation-method'] || null;
if (distillMethodArg && !isKnownDistillationMethod(distillMethodArg)) {
  fail(`unknown --distillation-method "${distillMethodArg}"; expected one of [${DISTILLATION_METHODS.join(', ')}]`);
}
// C4 truthfulness guard (cross-tokenizer KD): 'uld' / 'seq-level-kd' have a real,
// tested alignment module (src/distill-cross-tokenizer.js) but NO trainer in this
// worker yet consumes cross-vocab aligned targets (ULD needs a soft-target
// trainer; seq-KD needs student-retokenized rows fed to SFT). In --mode=full they
// would fall through to train_lora.py and the manifest would stamp a FALSE
// distillation_method='uld'. Rather than sign an artifact that lies about the
// objective, FAIL LOUD. (collect/stub modes only gather pairs and never claim a
// training objective, so they are unaffected.)
if (mode === 'full' && (distillMethodArg === 'uld' || distillMethodArg === 'seq-level-kd')) {
  fail(`distillation_method='${distillMethodArg}' (cross-tokenizer KD) is not yet runnable in --mode=full: the alignment math is built + tested (src/distill-cross-tokenizer.js) but no soft-target / retokenized-SFT trainer consumes it here. Refusing to train a DIFFERENT objective under a '${distillMethodArg}' label (that would sign a false receipt). Use --distillation-method=lora for plain SFT-KD until the cross-vocab trainer lands.`);
}
// C4 truthfulness guard (logit-level objectives): the collect worker's
// train_lora.py is sequence-level SFT and does NOT implement the logit objectives
// (forward_kl / reverse_kl / jsd / distillm2 / gkd), which need teacher LOGITS +
// the on-policy GKD trainer. The CLI advertises --objective=<logit>; honor it
// truthfully by failing loud here (it would otherwise be a silent no-op that runs
// LoRA) and point at the real entry point.
const _objectiveArg = args.objective || process.env.KOLM_DISTILL_OBJECTIVE || null;
const _LOGIT_OBJECTIVES = new Set(['forward_kl', 'reverse_kl', 'jsd', 'distillm2', 'gkd']);
if (mode === 'full' && _objectiveArg && _LOGIT_OBJECTIVES.has(_objectiveArg)) {
  fail(`--objective=${_objectiveArg} is a logit-level objective the --local-worker --mode=full SFT path cannot run (it needs teacher logits + the on-policy GKD trainer). Use \`kolm distill onpolicy train --objective=${_objectiveArg} ...\` (src/distill-onpolicy.js -> train_gkd.py). The collect worker supports sequence-level SFT only (--objective=seqkd / --distillation-method=lora|qlora|full-ft|rejection_sampling).`);
}

// Wave 158 — optional --teacher-version + --student-base-revision pin the
// vendor's response version + the HF commit hash so a verifier can rebuild
// the exact corpus that produced the LoRA. Both are informational strings;
// validation is "non-empty if provided." Stored in receipt chain.
const teacherVersionArg = args['teacher-version'] || null;
const studentBaseRevArg = args['student-base-revision'] || null;

if (mode === 'stub') {
  const sbEntry = studentBaseArg && isKnownStudentBase(studentBaseArg) ? studentBaseEntry(studentBaseArg) : null;
  const manifest = {
    worker: 'kolm-distill-worker',
    worker_version: '0.1.0',
    mode: 'stub',
    spec_id: spec.job_id || null,
    teacher_vendor: null,
    teacher_model: null,
    teacher_version: null,
    student_base: studentBaseArg,
    student_base_repo: sbEntry ? sbEntry.repo : null,
    student_base_origin: sbEntry ? sbEntry.origin : null,
    student_base_license: sbEntry ? sbEntry.license : null,
    student_base_revision: studentBaseRevArg,
    distillation_method: null,
    ml_pipeline_run: false,
    training_pairs_collected: 0,
    redaction_map_hash: null,
    // wave 157 — stub mode never invokes the teacher so the redactor wasn't
    // exercised; redact_class is 'none' and the log hashes are null. Downstream
    // schema stays consistent (verifier check #14 treats absence-of-class as
    // not-applicable).
    redact_class: 'none',
    teacher_call_log_hash: null,
    reinjection_log_hash: null,
    split: splitSummary,
    // wave 145 — teacher-holdout fields always present as keys so downstream
    // schema is consistent across modes. Stub mode never calls a teacher, so
    // these stay null even when --teacher-holdout is passed.
    teacher_holdout_accuracy: null,
    teacher_holdout_count: null,
    teacher_holdout_log_hash: null,
    note: 'stub mode — no teacher calls were made; offline split/manifest only.',
    finished_at: new Date().toISOString(),
  };
  writeJson(path.join(outDir, 'manifest.json'), manifest);
  console.log(`[distill-worker] stub mode complete. wrote ${outDir}/manifest.json`);
  process.exit(0);
}

const trainFromSeeds = args['train-from-seeds'] === true || String(args['train-from-seeds'] || '').toLowerCase() === 'true';
const teacherSpec = args.teacher;
if (!teacherSpec && !trainFromSeeds) {
  fail('--teacher <vendor:model> required for collect/full mode (or use --mode=stub or --train-from-seeds)');
}
const parsedTeacher = teacherSpec ? parseTeacherSpec(teacherSpec) : { vendor: null, model: null };
const { vendor, model } = parsedTeacher;
const redact = !trainFromSeeds && args['no-redact'] !== true; // default true for teacher calls
const maxRows = Number(args['max-rows'] || 200);

// wave 157 — record the redactor profile applied to this run so verifier
// check #14 can confirm the receipt chain matches the declared class. Default
// 'auto' when --redact is on (no explicit class), 'none' when --no-redact.
const VALID_REDACT_CLASSES = ['none', 'phi', 'pci', 'multi', 'auto'];
let redactClass = args['redact-class'];
if (redactClass && !VALID_REDACT_CLASSES.includes(redactClass)) {
  fail(`--redact-class must be one of [${VALID_REDACT_CLASSES.join(', ')}]; got ${redactClass}`);
}
if (trainFromSeeds && redactClass && redactClass !== 'none') {
  fail(`--train-from-seeds does not invoke the teacher redaction/reinjection path; use --redact-class=none`);
}
if (!redactClass) redactClass = trainFromSeeds ? 'none' : (redact ? 'auto' : 'none');
if (!redact && redactClass !== 'none') {
  fail(`--no-redact conflicts with --redact-class=${redactClass}; pick one`);
}

const pairsPath = path.join(outDir, 'training-pairs.jsonl');
const teacherLogPath = path.join(outDir, 'teacher-call-log.jsonl');
const reinjectionLogPath = path.join(outDir, 'reinjection-log.jsonl');
const pairsOut = fs.createWriteStream(pairsPath, { flags: 'w' });
const logOut = fs.createWriteStream(teacherLogPath, { flags: 'w' });
const reinjectOut = fs.createWriteStream(reinjectionLogPath, { flags: 'w' });

let allMapHashes = [];
let collected = 0;

if (trainFromSeeds) {
  console.log(`[distill-worker] building ${Math.min(maxRows, split.train.length)} training pairs from labeled train seeds`);
  for (let i = 0; i < Math.min(maxRows, split.train.length); i++) {
    const row = split.train[i];
    pairsOut.write(JSON.stringify({
      id: row.id || `train_${i + 1}`,
      input: row.input,
      teacher_output: row.output,
      seed_output: row.output,
      training_pair_source: 'seed_output',
      ...(typeof row.complexity_proxy === 'number' ? { complexity_proxy: row.complexity_proxy } : {}),
    }) + '\n');
    collected++;
    if (collected % 10 === 0) process.stderr.write(`  collected ${collected}\n`);
  }
} else {
  console.log(`[distill-worker] collecting ${Math.min(maxRows, split.train.length)} training pairs from teacher ${vendor}:${model}`);
  for (let i = 0; i < Math.min(maxRows, split.train.length); i++) {
    const row = split.train[i];
    const inputText = typeof row.input === 'string' ? row.input : JSON.stringify(row.input);
    try {
      const r = await callTeacher({
        vendor, model,
        input: inputText,
        system: spec.system || '',
        redact,
        maxTokens: Number(args['max-tokens'] || 1024),
        localEndpoint: args['local-endpoint'],
        localApiKey: args['local-api-key'],
      });
      pairsOut.write(JSON.stringify({
        id: row.id || `train_${i + 1}`,
        input: row.input,
        teacher_output: r.response,
        seed_output: row.output,
        // W713 - carry the per-row complexity_proxy stamped by
        // src/distill-pipeline.js so the Python trainer's SequentialSampler can
        // order the rows simple->complex (only present when --curriculum was set
        // on the staged seeds; absent rows fall back to neutral in the trainer).
        ...(typeof row.complexity_proxy === 'number' ? { complexity_proxy: row.complexity_proxy } : {}),
      }) + '\n');
      logOut.write(JSON.stringify(r.teacher_call_log_entry) + '\n');
    // wave 157 — capture per-row reinjection metadata so an auditor can replay
    // the substitution offline. Stores token counts + a preservation_ok flag
    // (the callTeacher path already reinjected — this log captures whether
    // every input token was echoed back, so a tampered or dropping teacher
    // surfaces in the log). Never stores raw PHI; only the [PHI_*_n] token
    // identifiers.
      const inputTokens   = (r.teacher_call_log_entry.redacted_input || '').match(/\[PHI_[A-Z]+_\d+\]/g) || [];
      const outputTokens  = (r.teacher_call_log_entry.redacted_response || '').match(/\[PHI_[A-Z]+_\d+\]/g) || [];
      const inputUnique   = Array.from(new Set(inputTokens));
      const outputUnique  = Array.from(new Set(outputTokens));
      const preservationOk = inputUnique.every(t => outputUnique.includes(t));
      reinjectOut.write(JSON.stringify({
        row_index: i,
        id: row.id || `train_${i + 1}`,
        input_token_count: inputTokens.length,
        output_token_count: outputTokens.length,
        input_unique_tokens: inputUnique,
        output_unique_tokens: outputUnique,
        preservation_ok: preservationOk,
      }) + '\n');
      allMapHashes.push(r.redaction_map_hash);
      collected++;
      if (collected % 10 === 0) process.stderr.write(`  collected ${collected}\n`);
    } catch (e) {
      process.stderr.write(`  [skip ${i + 1}] ${e.message}\n`);
      logOut.write(JSON.stringify({ error: e.message, row_index: i }) + '\n');
    }
  }
}
pairsOut.end();
logOut.end();
reinjectOut.end();
await Promise.all([waitForStreamFinish(pairsOut), waitForStreamFinish(logOut), waitForStreamFinish(reinjectOut)]);

const combinedMapHash = 'sha256:' + crypto.createHash('sha256').update(allMapHashes.join('\n')).digest('hex');
const trainingPairsHash = fileSha256(pairsPath);
// wave 157 — hash the teacher-call-log and reinjection-log so the receipt
// chain can prove these files weren't modified after the worker wrote them.
const teacherCallLogHash = fileSha256(teacherLogPath);
const reinjectionLogHash = fileSha256(reinjectionLogPath);

let mlRun = false;
let mlReport = null;
let trainerSummary = null;
let portableExport = null;
let rejectionRan = false;   // C4 - true ONLY when the real best-of-N trainer ran
let trainLaunchPlan = null;
let trainLaunchPlanPath = null;
let trainLaunchPlanHash = null;
const trainPreset = String(args['train-preset'] || process.env.KOLM_TRAIN_PRESET || spec?.train?.preset || '').trim().toLowerCase() || null;
const trainMethod = String(args['train-method'] || process.env.KOLM_TRAIN_METHOD || spec?.train?.method || (trainPreset === 'qdora' ? 'qlora' : '')).trim().toLowerCase() || null;
if (trainPreset && !new Set(['qdora']).has(trainPreset)) {
  console.error(`[distill-worker] train preset must be one of [qdora]; got ${JSON.stringify(trainPreset)}`);
  process.exit(2);
}
if (trainMethod && !new Set(['qlora', 'lora', 'full']).has(trainMethod)) {
  console.error(`[distill-worker] train method must be one of [qlora, lora, full]; got ${JSON.stringify(trainMethod)}`);
  process.exit(2);
}
try {
  trainLaunchPlan = buildTrainLaunchPlan(spec, {
    pairsPath,
    outDir,
    studentOut: path.join(outDir, 'student'),
    studentHoldoutPath,
    trainMethod,
    trainPreset,
    dryRun: truthyArg(args['train-launch-dry-run']) || spec?.train?.launch_dry_run === true,
  });
  trainLaunchPlanPath = path.join(outDir, 'train-launch-plan.json');
  writeJson(trainLaunchPlanPath, trainLaunchPlan);
  trainLaunchPlanHash = fileSha256(trainLaunchPlanPath);
} catch (e) {
  fail(`invalid train launch plan: ${e && e.message ? e.message : e}`);
}
if (mode === 'full') {
  const ready = await doctor();
  const dryRunLargeLauncher = trainLaunchPlan
    && trainLaunchPlan.kind !== 'local_worker'
    && trainLaunchPlan.dry_run;
  if (!ready.python_ok || (!ready.torch_ok && !dryRunLargeLauncher)) {
    console.error('[distill-worker] python+torch required for --mode=full; falling back to collect-only.');
    console.error('  install hint: pip install torch transformers peft bitsandbytes accelerate datasets sentencepiece');
  } else if (distillMethodArg === 'rejection_sampling') {
    // C4 - REAL best-of-N rejection sampling (RAFT/STaR/ReST). The default LoRA
    // path makes the student imitate the teacher's single sampled answer; here we
    // instead sample N candidates per prompt at temperature, score every candidate
    // with the reward family, keep the best (or first above threshold), and SFT the
    // student on the ACCEPTED set only. The worker PREVIOUSLY ran train_lora.py for
    // this method while still stamping distillation_method=rejection_sampling -> a
    // SIGNED MANIFEST THAT LIED about the objective. Fixed: run the real trainer
    // and label truthfully (distillMethod below is rejection_sampling ONLY when
    // rejectionRan).
    const rsN = Math.max(1, Math.trunc(Number(args['rs-n']) || 4));
    const rsTemp = Number.isFinite(Number(args['rs-temperature'])) ? Number(args['rs-temperature']) : 0.8;
    const rsThreshold = Number.isFinite(Number(args['rs-threshold'])) ? Number(args['rs-threshold']) : 0.5;
    const rsSelection = (args['rs-threshold-mode'] === 'threshold') ? 'threshold' : 'best';
    const rsReward = args['rs-reward'] || 'kolm_verifier';
    const pyScript = path.join(__dirname, 'scripts', 'train_rejection.py');
    if (!fs.existsSync(pyScript)) {
      console.error('[distill-worker] expected scripts/train_rejection.py; not found - cannot run rejection_sampling.');
    } else {
      // 1. sample N diverse candidates per training prompt from the teacher
      //    (temperature drives diversity; without it best-of-N degenerates to N=1).
      const candPath = path.join(outDir, 'rs-candidates.jsonl');
      const candOut = fs.createWriteStream(candPath, { flags: 'w' });
      const nPrompts = Math.min(maxRows, split.train.length);
      let candPrompts = 0, candTotal = 0;
      console.log(`[distill-worker] rejection-sampling: sampling ${rsN} candidates/prompt over ${nPrompts} prompts (temp=${rsTemp}, reward=${rsReward})`);
      for (let i = 0; i < nPrompts; i++) {
        const row = split.train[i];
        const inputText = typeof row.input === 'string' ? row.input : JSON.stringify(row.input);
        const reference = typeof row.output === 'string' ? row.output : JSON.stringify(row.output);
        const candidates = [];
        for (let k = 0; k < rsN; k++) {
          try {
            const r = await callTeacher({
              vendor, model, input: inputText, system: spec.system || '',
              redact, maxTokens: Number(args['max-tokens'] || 1024),
              temperature: rsTemp,
              localEndpoint: args['local-endpoint'], localApiKey: args['local-api-key'],
            });
            if (r && typeof r.response === 'string' && r.response.length) candidates.push(r.response);
          } catch (e) {
            process.stderr.write(`  [rs sample ${i + 1}.${k + 1}] ${e.message}\n`);
          }
        }
        if (candidates.length === 0) continue;
        candOut.write(JSON.stringify({ id: row.id || `train_${i + 1}`, prompt: inputText, candidates, reference }) + '\n');
        candPrompts++; candTotal += candidates.length;
      }
      candOut.end();
      await new Promise((res) => candOut.on('finish', res));
      if (candPrompts === 0) {
        console.error('[distill-worker] rejection_sampling produced ZERO candidate groups (teacher returned nothing); cannot train. Falling back to collect-only (method will record as prompt-distill, NOT rejection_sampling).');
      } else {
        // 2. score every candidate + select best-of-N + SFT on the accepted set only.
        console.log(`[distill-worker] invoking rejection-sampling trainer on ${candPrompts} prompts / ${candTotal} candidates...`);
        const pyArgs = [
          pyScript,
          '--candidates', candPath,
          '--student', args['student-base'] || 'Qwen/Qwen2.5-0.5B',
          '--out', path.join(outDir, 'student'),
          '--reward', rsReward,
          '--num-candidates', String(rsN),
          '--threshold', String(rsThreshold),
          '--selection', rsSelection,
          '--temperature', String(rsTemp),
        ];
        const res = spawnSync('python3', pyArgs, { stdio: 'inherit' });
        mlRun = res.status === 0;
        rejectionRan = mlRun;
        mlReport = {
          exit_code: res.status, signal: res.signal || null,
          trainer: 'train_rejection.py', rs_n: rsN, rs_threshold: rsThreshold,
          rs_selection: rsSelection, rs_reward: rsReward,
          candidate_prompts: candPrompts, candidates_total: candTotal,
        };
      }
    }
  } else {
    const pyScript = path.join(__dirname, 'scripts', 'train_lora.py');
    if (trainLaunchPlan && trainLaunchPlan.kind !== 'local_worker') {
      const launched = runTrainLaunchPlan({
        plan: trainLaunchPlan,
        outDir,
        pairsPath,
      });
      mlRun = launched.mlRun;
      mlReport = launched.mlReport;
    } else if (!fs.existsSync(pyScript)) {
      console.error(`[distill-worker] expected scripts/train_lora.py; not found.`);
    } else {
      console.log('[distill-worker] invoking Python LoRA trainer (this may take a while)...');
      const pyArgs = [
        pyScript,
        '--pairs', pairsPath,
        '--out', path.join(outDir, 'student'),
        '--student-base', args['student-base'] || 'Qwen/Qwen2.5-0.5B',
      ];
      const trainerBackend = args.backend
        || (spec && spec.train && typeof spec.train.backend === 'string' ? spec.train.backend : null)
        || (typeof spec.backend === 'string' ? spec.backend : null);
      if (trainerBackend) pyArgs.push('--backend', String(trainerBackend));
      if (trainMethod === 'qlora') pyArgs.push('--qlora');
      // W713/W711 - forward the data-ordering flags so train_lora.py engages a
      // SequentialSampler (curriculum) or WeightedRandomSampler (importance).
      // The pairs file already carries complexity_proxy per row (W713); the
      // importance-weights JSONL lives next to the staged seeds.jsonl (W711).
      if (args.curriculum) pyArgs.push('--curriculum', String(args.curriculum));
      if (args['importance-weights']) pyArgs.push('--importance-weights', String(args['importance-weights']));
      if (studentHoldoutPath) pyArgs.push('--holdout', studentHoldoutPath);
      const res = spawnSync('python3', pyArgs, { stdio: 'inherit' });
      mlRun = res.status === 0;
      mlReport = { exit_code: res.status, signal: res.signal || null };
    }
  }
  trainerSummary = readJsonMaybe(path.join(outDir, 'student', 'training-summary.json'));
  if (mlRun) {
    portableExport = await maybeRunPortableExport({
      args,
      outDir,
      spec,
      studentBaseArg: args['student-base'] || 'Qwen/Qwen2.5-0.5B',
      trainerSummary,
      studentHoldoutPath,
      pairsPath,
    });
  }
}

// wave 145 — optional teacher-holdout pass. When --teacher-holdout is set
// AND a teacher is configured, invoke teacher on holdout INPUTS and score
// teacher responses against holdout outputs. Produces:
//   teacher_holdout_log.jsonl  one entry per holdout call (redacted)
//   teacher_holdout_accuracy   number in [0,1]
//   teacher_holdout_count      int (rows scored)
//   teacher_holdout_log_hash   sha256 of the log file
// Downstream K-score V2 reads teacher_holdout_accuracy + (student) holdout
// accuracy and emits T = student/teacher fidelity ratio.
let teacherHoldoutAccuracy = null;
let teacherHoldoutCount = null;
let teacherHoldoutLogHash = null;
if (args['teacher-holdout'] && split.holdout.length > 0 && !trainFromSeeds) {
  const thMax = Number(args['teacher-holdout-max'] || 50);
  const cap = Math.min(thMax, split.holdout.length);
  const comparator = (args['teacher-holdout-comparator'] || 'exact');
  const thLogPath = path.join(outDir, 'teacher-holdout-log.jsonl');
  const thLog = fs.createWriteStream(thLogPath, { flags: 'w' });
  let correct = 0;
  let counted = 0;
  console.log(`[distill-worker] scoring teacher on ${cap} holdout rows (comparator=${comparator})`);
  for (let i = 0; i < cap; i++) {
    const row = split.holdout[i];
    const inputText = typeof row.input === 'string' ? row.input : JSON.stringify(row.input);
    const expected  = typeof row.output === 'string' ? row.output : JSON.stringify(row.output);
    try {
      const r = await callTeacher({
        vendor, model,
        input: inputText,
        system: spec.system || '',
        redact,
        maxTokens: Number(args['max-tokens'] || 1024),
        localEndpoint: args['local-endpoint'],
        localApiKey: args['local-api-key'],
      });
      const ok = compareTeacherResponse(r.response, expected, comparator);
      if (ok) correct++;
      counted++;
      thLog.write(JSON.stringify({
        ...r.teacher_call_log_entry,
        holdout_index: i,
        comparator,
        correct: ok,
      }) + '\n');
    } catch (e) {
      thLog.write(JSON.stringify({ error: e.message, row_index: i, holdout_index: i }) + '\n');
    }
  }
  thLog.end();
  teacherHoldoutAccuracy = counted > 0 ? correct / counted : 0;
  teacherHoldoutCount = counted;
  teacherHoldoutLogHash = fileSha256(thLogPath);
  console.log(`[distill-worker] teacher holdout accuracy: ${(teacherHoldoutAccuracy * 100).toFixed(1)}% on ${counted} rows`);
}

// Wave 158 / C4 — compute the authoritative distillation_method. The label must
// reflect what ACTUALLY ran, never merely what was requested: stamping
// rejection_sampling while the LoRA trainer ran (or while nothing trained) would
// sign a manifest that lies about the objective. So: rejection_sampling ONLY when
// the real best-of-N trainer ran; otherwise the requested LoRA-family label when
// train_lora ran; else prompt-distill (collect-only).
const distillMethod = rejectionRan
  ? 'rejection_sampling'
  : (mlRun
    ? ((distillMethodArg && distillMethodArg !== 'rejection_sampling') ? distillMethodArg : 'lora')
    : 'prompt-distill');
const sbEntryFull = studentBaseArg && isKnownStudentBase(studentBaseArg) ? studentBaseEntry(studentBaseArg) : null;

const manifest = {
  worker: 'kolm-distill-worker',
  worker_version: '0.1.0',
  mode,
  spec_id: spec.job_id || null,
  teacher_vendor: vendor,
  teacher_model: model,
  // wave 158 — teacher_version pin (vendor's response version string when
  // provided; null otherwise). Receipt chain records verbatim.
  teacher_version: teacherVersionArg,
  student_base: studentBaseArg,
  // wave 158 — student-base catalog metadata. Recording the repo + origin +
  // license alongside the slug means the receipt chain self-describes the
  // weights' license terms instead of requiring an external lookup.
  student_base_repo: sbEntryFull ? sbEntryFull.repo : null,
  student_base_origin: sbEntryFull ? sbEntryFull.origin : null,
  student_base_license: sbEntryFull ? sbEntryFull.license : null,
  student_base_revision: studentBaseRevArg,
  // wave 158 — explicit distillation method (lora/qlora/full-ft/prompt-distill).
  // Verifier check #15 demands this field be present when ml_pipeline_run=true.
  distillation_method: distillMethod,
  redact,
  // wave 157 — redact_class + receipt-chain extension. Verifier check #14
  // requires all three log hashes when redact_class != 'none'.
  redact_class: redactClass,
  ml_pipeline_run: mlRun,
  ml_report: mlReport,
  trainer_summary: trainerSummary,
  train_preset: trainPreset,
  train_method: trainMethod,
  train_launch_plan: trainLaunchPlan,
  train_launch_plan_path: trainLaunchPlanPath ? path.relative(outDir, trainLaunchPlanPath) : null,
  train_launch_plan_hash: trainLaunchPlanHash,
  training_pair_source: trainFromSeeds ? 'seed_output' : 'teacher',
  portable_export: portableExport,
  portable_weight_path: portableExport && portableExport.ok && portableExport.output_path
    ? portableExport.output_path
    : null,
  student_holdout_accuracy: numberOrNull(
    trainerSummary && (
      trainerSummary.student_holdout_accuracy ??
      trainerSummary.holdout_accuracy ??
      trainerSummary.eval_accuracy
    )
  ),
  holdout_accuracy: numberOrNull(trainerSummary && trainerSummary.holdout_accuracy),
  student_holdout_source: studentHoldoutSource,
  student_holdout_count: studentHoldoutRows.length,
  student_holdout_path: studentHoldoutPath ? path.relative(outDir, studentHoldoutPath) : null,
  student_holdout_hash: studentHoldoutHash,
  loss_final: numberOrNull(trainerSummary && (
    trainerSummary.loss_final ??
    trainerSummary.final_loss ??
    trainerSummary.eval_loss
  )),
  training_pairs_collected: collected,
  training_pairs_path: path.relative(outDir, pairsPath),
  training_pairs_hash: trainingPairsHash,
  teacher_call_log_path: path.relative(outDir, teacherLogPath),
  teacher_call_log_hash: teacherCallLogHash,
  reinjection_log_path: path.relative(outDir, reinjectionLogPath),
  reinjection_log_hash: reinjectionLogHash,
  redaction_map_hash: combinedMapHash,
  teacher_holdout_accuracy: teacherHoldoutAccuracy,
  teacher_holdout_count: teacherHoldoutCount,
  teacher_holdout_log_hash: teacherHoldoutLogHash,
  split: splitSummary,
  finished_at: new Date().toISOString(),
};
writeJson(path.join(outDir, 'manifest.json'), manifest);
console.log(`[distill-worker] done. ${collected} pairs → ${pairsPath}`);
if (!mlRun) {
  console.log(`[distill-worker] ML training stage not run. next:`);
  console.log(`  cd workers/distill && pip install -r requirements.txt && \\`);
  console.log(`    python3 scripts/train_lora.py --pairs ${pairsPath} --out ${outDir}/student --student-base ${args['student-base'] || 'Qwen/Qwen2.5-0.5B'}`);
}
process.exit(0);

// ---------------------------------------------------------------------------
// Helpers (exported for tests via package.json#main re-export)
// ---------------------------------------------------------------------------
function readSeeds(p) {
  const txt = fs.readFileSync(p, 'utf8');
  const lines = txt.trim().split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const ln of lines) {
    try {
      const obj = JSON.parse(ln);
      // Normalize legacy {prompt, completion} to canonical {input, output}.
      if (obj.prompt !== undefined && obj.input === undefined) obj.input = obj.prompt;
      if (obj.completion !== undefined && obj.output === undefined) obj.output = obj.completion;
      if (obj.input !== undefined && obj.output !== undefined) rows.push(obj);
    } catch { /* skip malformed */ }
  }
  return rows;
}

function readHoldoutRows(p) {
  const txt = fs.readFileSync(p, 'utf8');
  const lines = txt.trim().split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const ln of lines) {
    try {
      const obj = JSON.parse(ln);
      if (!obj || typeof obj !== 'object') continue;
      const input = obj.input ?? obj.prompt;
      const output = obj.output ?? obj.expected ?? obj.teacher_output ?? obj.response;
      if (input !== undefined && output !== undefined) {
        rows.push({ ...obj, input, output });
      }
    } catch { /* skip malformed */ }
  }
  return rows;
}

function readJsonMaybe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function numberOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function splitSeeds(rows, splitSeed) {
  // Wave 253 ML#7: delegate to the canonical implementation in src/seeds.js
  // so train/holdout assignments are identical across the build path and the
  // distill worker. The old divergent five-bucket scheme has been removed.
  const out = canonicalSplitSeeds(rows, { split_seed: String(splitSeed) });
  return { train: out.train, holdout: out.holdout };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function fileSha256(p) {
  if (!fs.existsSync(p)) return null;
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function waitForStreamFinish(stream) {
  if (!stream || stream.writableFinished) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once('finish', resolve);
    stream.once('error', reject);
  });
}

function rowsHash(rows) {
  const lines = rows.map(r => JSON.stringify({ input: r.input, output: r.output })).join('\n');
  return 'sha256:' + crypto.createHash('sha256').update(lines).digest('hex');
}

// Compare a teacher response to an expected output. Comparators kept simple
// because the worker should not pull in a heavyweight scoring lib — the goal
// is a reproducible accuracy number, not perfect semantic scoring. Tenants
// who want richer scoring run a follow-up evaluator outside the worker.
function compareTeacherResponse(actual, expected, comparator) {
  const a = String(actual ?? '').trim();
  const e = String(expected ?? '').trim();
  if (comparator === 'substring') {
    return a.toLowerCase().includes(e.toLowerCase()) || e.toLowerCase().includes(a.toLowerCase());
  }
  if (comparator === 'jaccard') {
    const toks = (s) => new Set(s.toLowerCase().split(/\s+/).filter(Boolean));
    const A = toks(a); const E = toks(e);
    if (A.size === 0 && E.size === 0) return true;
    let inter = 0;
    for (const t of A) if (E.has(t)) inter++;
    const union = A.size + E.size - inter;
    return union > 0 && (inter / union) >= 0.7;
  }
  // default: exact-after-normalize (case-insensitive, whitespace collapsed)
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return norm(a) === norm(e);
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

async function doctor() {
  const py = pythonBin();
  const python = spawnSync(py, ['--version'], { encoding: 'utf8' });
  const python_ok = python.status === 0;
  let torch_ok = false;
  let torch_version = null;
  if (python_ok) {
    const t = spawnSync(py, ['-c', 'import torch; print(torch.__version__)'], { encoding: 'utf8' });
    torch_ok = t.status === 0;
    torch_version = torch_ok ? (t.stdout || '').trim() : null;
  }
  let transformers_ok = false;
  if (python_ok) {
    const tr = spawnSync(py, ['-c', 'import transformers; print(transformers.__version__)'], { encoding: 'utf8' });
    transformers_ok = tr.status === 0;
  }
  const node = process.versions.node;
  return {
    node_version: node,
    python_ok,
    python_version: python_ok ? (python.stdout || '').trim() : null,
    torch_ok,
    torch_version,
    transformers_ok,
    ready_for_full_pipeline: python_ok && torch_ok && transformers_ok,
    hint: (python_ok && torch_ok)
      ? null
      : 'install Python 3.10+ then: pip install torch transformers peft bitsandbytes accelerate datasets sentencepiece',
  };
}

function pythonBin() {
  return process.env.KOLM_PYTHON || process.env.KOLM_PYTHON_BIN || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

function truthyArg(v) {
  if (v === true) return true;
  const s = String(v || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function repoPath(rel) {
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

function writeDistillTrainJsonlFromPairs(pairsPath, trainJsonl) {
  const rows = [];
  const text = fs.existsSync(pairsPath) ? fs.readFileSync(pairsPath, 'utf8') : '';
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    const promptRaw = row.input ?? row.prompt;
    const responseRaw = row.teacher_output ?? row.response ?? row.output ?? row.seed_output;
    if (promptRaw === undefined || responseRaw === undefined) continue;
    const prompt = typeof promptRaw === 'string' ? promptRaw : JSON.stringify(promptRaw);
    const response = typeof responseRaw === 'string' ? responseRaw : JSON.stringify(responseRaw);
    rows.push(JSON.stringify({
      id: row.id || row.event_id || `pair_${rows.length + 1}`,
      prompt,
      response,
    }));
  }
  fs.mkdirSync(path.dirname(trainJsonl), { recursive: true });
  fs.writeFileSync(trainJsonl, rows.join('\n') + (rows.length ? '\n' : ''), 'utf8');
  return {
    path: trainJsonl,
    rel_path: path.relative(path.dirname(trainJsonl), trainJsonl),
    row_count: rows.length,
    hash: fileSha256(trainJsonl),
  };
}

function runTrainLaunchPlan({ plan, outDir, pairsPath }) {
  const startedAt = new Date().toISOString();
  const scriptPath = repoPath(plan.script);
  const base = {
    trainer: path.basename(plan.script || ''),
    train_launcher: plan.kind,
    train_launch_plan_version: plan.version || null,
    execution: null,
    exit_code: null,
    signal: null,
    started_at: startedAt,
    finished_at: null,
  };

  if (!fs.existsSync(scriptPath)) {
    return {
      mlRun: false,
      mlReport: {
        ...base,
        execution: 'not_started',
        error: 'train_launcher_script_missing',
        script: plan.script,
        finished_at: new Date().toISOString(),
      },
    };
  }

  if (plan.kind === 'multinode_fsdp') {
    let trainJsonlReport = null;
    if (plan.consumes_training_pairs && plan.train_jsonl) {
      trainJsonlReport = writeDistillTrainJsonlFromPairs(pairsPath, path.resolve(plan.train_jsonl));
    }
    if (plan.required_args_missing?.length && !plan.dry_run) {
      return {
        mlRun: false,
        mlReport: {
          ...base,
          execution: 'not_started',
          error: 'train_launcher_required_args_missing',
          required_args_missing: plan.required_args_missing,
          train_jsonl: trainJsonlReport,
          finished_at: new Date().toISOString(),
        },
      };
    }
    console.log(`[distill-worker] invoking ${plan.kind} launcher${plan.dry_run ? ' dry-run' : ''}...`);
    const res = spawnSync(pythonBin(), [scriptPath, ...plan.args], {
      stdio: 'inherit',
      env: { ...process.env, ...(plan.env || {}) },
    });
    return {
      mlRun: res.status === 0 && !plan.dry_run,
      mlReport: {
        ...base,
        execution: plan.dry_run ? 'dry_run' : 'executed',
        exit_code: res.status,
        signal: res.signal || null,
        train_jsonl: trainJsonlReport,
        distributed: plan.distributed || null,
        finished_at: new Date().toISOString(),
      },
    };
  }

  if (plan.dry_run) {
    return {
      mlRun: false,
      mlReport: {
        ...base,
        execution: 'dry_run_planned',
        reason: 'single_32b_launcher_has_no_gpu_free_dry_run',
        finished_at: new Date().toISOString(),
      },
    };
  }

  console.log(`[distill-worker] invoking ${plan.kind} launcher (this may take a while)...`);
  const env = { ...process.env, ...(plan.env || {}) };
  if (!env.KOLM_32B_OUT) env.KOLM_32B_OUT = path.join(outDir, 'student');
  const res = spawnSync(pythonBin(), [scriptPath, ...(plan.args || [])], {
    stdio: 'inherit',
    env,
  });
  return {
    mlRun: res.status === 0,
    mlReport: {
      ...base,
      execution: 'executed',
      exit_code: res.status,
      signal: res.signal || null,
      pair_env: plan.pair_env || null,
      finished_at: new Date().toISOString(),
    },
  };
}

function tailText(s, n = 2048) {
  return String(s || '').slice(-n);
}

async function maybeRunPortableExport({
  args,
  outDir,
  spec,
  studentBaseArg,
  trainerSummary,
  studentHoldoutPath,
  pairsPath,
}) {
  const requestedRaw = args['export-portable'];
  if (requestedRaw == null || requestedRaw === false) return null;
  const format = String(requestedRaw === true ? 'gguf' : requestedRaw).trim().toLowerCase();
  if (!format || ['0', 'false', 'off', 'none', 'no'].includes(format)) return null;
  if (format !== 'gguf') {
    return {
      requested: true,
      ok: false,
      format,
      error: 'unsupported_portable_export_format',
      supported_formats: ['gguf'],
    };
  }

  const studentDir = path.join(outDir, 'student');
  const mergedDir = path.join(outDir, 'student-merged-hf');
  const quant = String(args['export-quant'] || 'Q4_K_M').toUpperCase();
  const outputPath = path.join(studentDir, 'model.gguf');
  const contextLength = Number.isFinite(Number(args['export-context-length']))
    ? Number(args['export-context-length'])
    : 8192;
  const skipCoherence = truthyArg(args['export-skip-coherence']);
  const startedAt = new Date().toISOString();

  if (!fs.existsSync(studentDir)) {
    return {
      requested: true,
      ok: false,
      format,
      quant,
      error: 'student_dir_missing',
      student_path: path.relative(outDir, studentDir),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  }

  const mergeCode = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(ROOT)})`,
    'from apps.trainer.merge import merge_lora_to_base',
    'merged = merge_lora_to_base(adapter_dir=sys.argv[1], base_model=(sys.argv[2] or None), out_dir=sys.argv[3])',
    'print(json.dumps({"ok": True, "merged_dir": merged}))',
  ].join('\n');
  const merge = spawnSync(pythonBin(), ['-c', mergeCode, studentDir, String(studentBaseArg || ''), mergedDir], {
    encoding: 'utf8',
    timeout: 60 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (merge.status !== 0) {
    return {
      requested: true,
      ok: false,
      format,
      quant,
      step: 'merge_lora_to_base',
      exit_code: merge.status,
      signal: merge.signal || null,
      stderr: tailText(merge.stderr),
      stdout: tailText(merge.stdout),
      install_hint: 'Install torch + transformers + peft and ensure the adapter has adapter_config.json.',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  }

  let mergeEnvelope = null;
  try {
    mergeEnvelope = JSON.parse(String(merge.stdout || '').trim().split(/\r?\n/).pop() || '{}');
  } catch (_) {
    mergeEnvelope = { ok: true, merged_dir: mergedDir };
  }

  try {
    const { exportGguf } = await import('../../src/export-gguf.js');
    const kscore = trainerSummary && Number.isFinite(Number(
      trainerSummary.student_holdout_accuracy ?? trainerSummary.holdout_accuracy ?? trainerSummary.eval_accuracy
    ))
      ? Number(trainerSummary.student_holdout_accuracy ?? trainerSummary.holdout_accuracy ?? trainerSummary.eval_accuracy)
      : null;
    const result = await exportGguf({
      artifact: {
        name: spec.job_id || 'kolm-distilled-student',
        artifact_hash: null,
        params_b: null,
        passport: { kscore },
        merged_dir: mergeEnvelope.merged_dir || mergedDir,
      },
      quant,
      outputPath,
      imatrixSource: studentHoldoutPath || pairsPath,
      skipCoherence,
      context_length: contextLength,
    });
    if (!result.ok) {
      return {
        requested: true,
        ok: false,
        format,
        quant,
        step: 'export_gguf',
        merged_dir: path.relative(outDir, mergeEnvelope.merged_dir || mergedDir),
        error: result.error,
        detail: result.detail || null,
        missing: result.missing || null,
        hint: result.hint || null,
        plan: result.plan || null,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      };
    }
    return {
      requested: true,
      ok: true,
      format,
      quant,
      merged_dir: path.relative(outDir, mergeEnvelope.merged_dir || mergedDir),
      output_path: path.relative(outDir, result.output_path || outputPath),
      runtime_passport: result.runtime_passport || null,
      forge_version: result.forge_version || null,
      skip_coherence: skipCoherence,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  } catch (e) {
    return {
      requested: true,
      ok: false,
      format,
      quant,
      step: 'export_gguf',
      merged_dir: path.relative(outDir, mergeEnvelope.merged_dir || mergedDir),
      error: 'export_exception',
      detail: String(e && e.message || e),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[k] = next;
        i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`[distill-worker] ${msg}\n`);
  process.exit(2);
}
