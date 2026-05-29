export const meta = {
  name: 'frontier-tail-build-w1',
  description: 'Wave 1: close outstanding items + build 6 data-engine Python workers + fix WebGPU status claim (disjoint owners)',
  phases: [{ title: 'Build' }, { title: 'Verify' }],
}

const ROOT = 'C:/Users/user/Desktop/kolmogorov-stack'
const R = {
  type: 'object', additionalProperties: false,
  required: ['owner', 'status', 'self_check'],
  properties: {
    owner: { type: 'string' },
    status: { type: 'string', enum: ['complete', 'partial', 'failed'] },
    changes: { type: 'array', items: { type: 'string' } },
    self_check: { type: 'string', description: 'node --check / python self-test result' },
    issues: { type: 'string' },
  },
}
const C = `Repo root: ${ROOT}. You OWN only the file(s) named below — edit/create ONLY those; no other agent touches them. Write REAL,
working code (no stubs/TODOs). Match surrounding style. After building, SELF-VERIFY (node --check for .js, run the python self-test
for .py) and report the exact result. Determinism: no wall-clock/RNG in control flow — accept any seed as a parameter. Return ONLY the object.`

const PY = `${C}
Each Python worker is an OPTIONAL acceleration backend for an existing JS module that already has a working JS fallback. The worker MUST:
(1) read JSONL pairs from --pairs <path> or stdin; (2) write a JSON result to stdout (and --out <path> if given); (3) degrade gracefully —
if an optional dependency (numpy/sklearn/sentence-transformers/etc.) is missing, print a JSON {ok:false, error:'dep_missing', need:'<pkg>'}
and exit 0 (NOT crash) so the JS side cleanly falls back; (4) be deterministic (seed param, default 0x6b6f6c6d=1801677709). Include a
\`--self-test\` flag that runs an in-process check on a tiny synthetic corpus and prints PASS/FAIL counts, exit 0 on all-pass. Use only the
Python stdlib for the core path where possible; treat heavy ML libs as optional-with-fallback. Keep ~150-300 lines.`

const OWNERS = [
  { label: 'w1:cli-assistant-seeds', schemaOwner: 'cli/kolm.js', prompt: `${C}
OWN: cli/kolm.js (+ create data/public-seeds/email-classifier.jsonl and data/public-seeds/invoice-fields.jsonl).
Two outstanding stubs to finish:
(A) 'kolm assistant bench' + 'kolm assistant publish' (around cli/kolm.js:13015-13019) currently print a not-yet-shipped placeholder.
    Implement real handlers consistent with the sibling assistant verbs (compile/run/chat): 'bench' should run the assistant artifact
    against a small eval set and print a comparison table (reuse existing bench/k-score helpers in the file — grep for cmdBench / kscore);
    'publish' should package + emit a publish manifest (reuse the existing publish/registry helpers — grep for cmdPublish / registry export).
    If a true backend call isn't available locally, produce a real local result envelope (NOT a 'not shipped' string).
(B) 'kolm seeds bootstrap --task email-classifier|invoice-fields' (PUBLIC_SEEDS at cli/kolm.js:36812-36813, error at :36845-36846):
    create the two missing seed JSONL files under data/public-seeds/ (12-20 realistic {input,output} rows each, matching the shape of an
    existing shipped seed — grep PUBLIC_SEEDS for a ships:true task and mirror its file), and flip ships:false->true for both tasks so the
    resolver no longer throws. Verify the task resolver path reads the new files.
node --check cli/kolm.js after.` },

  { label: 'w1:router-merge-exec', schemaOwner: 'src/router.js', prompt: `${C}
OWN: src/router.js ONLY.
POST /v1/merge (around src/router.js:26099-26108) returns 501 'merge_execution_not_yet_wired' when dry_run=false. Wire real execution:
Read how the dry-run plan is built in the same handler + how other write-routes spawn background jobs (grep router.js for the compile/job
queue pattern, e.g. enqueue / spawnJob / detach). For dry_run=false, actually perform (or enqueue) the merge using the existing merge
implementation (grep src/ for a merge module — e.g. src/merge*.js / mergeArtifacts / TIES merge already proven on the 5090) and return a
real envelope {ok:true, merge_id, status} instead of 501. If the merge primitive is local-CLI-only, enqueue a background job and return
202/accepted with a job id (mirror the existing job pattern) — do NOT leave a 501. Keep auth-gate + error envelope conventions identical to
neighboring routes. node --check src/router.js after.` },

  { label: 'w1:webgpu-status+runner', schemaOwner: 'src/platform-capabilities.js + public/device/webgpu-runner.html', prompt: `${C}
OWN: src/platform-capabilities.js AND new files public/device/webgpu-runner.html + public/device/webgpu-runner.js (create the /device dir
file if needed) AND a new test tests/wave921-webgpu-runner.test.js. Do NOT touch other files.
(A) ACCURACY FIX (important): src/platform-capabilities.js (~line 113-120) marks 'wasm-webgpu' as 'implemented' but no real WebGPU LLM
    inference runner exists. Change that status to an accurate value (e.g. 'in_progress' / 'target_declared') with a short honest note. Do
    the same for any sibling false 'implemented' claim about on-device WebGPU inference. (This must be truthful — every status maps to reality.)
(B) Build a REAL minimal on-device runner: public/device/webgpu-runner.js loads transformers.js (via the @huggingface/transformers CDN ESM
    URL) and generates tokens from a tiny model (e.g. 'Xenova/distilgpt2' or 'onnx-community/Qwen2.5-0.5B-Instruct') using the WebGPU backend
    when navigator.gpu is present, falling back to wasm; it emits a result envelope {ok, runtime:'webgpu'|'wasm', tokens, ms, device}. The
    .html is a tiny harness page that runs it + shows the output. Keep it dependency-light (CDN import, no build step).
(C) tests/wave921-webgpu-runner.test.js: a node:test that asserts the runner FILES exist + are well-formed (the .js exports/IIFE parses, the
    html references the .js, the CDN import URL is present) — a static contract test (headless WebGPU GPU may be absent in CI, so do NOT
    require real token generation; assert structure). Run node --check on the .js + node --test on the test file.` },

  { label: 'w1:py-select-subset', schemaOwner: 'workers/data/scripts/select_subset.py', prompt: `${PY}
OWN: workers/data/scripts/select_subset.py (create workers/data/scripts/ dir).
Interface: argv [--method {k-center|facility-location|badge|repr-filter}, --pairs <jsonl>, --out <json>, --target-size <int>, --seed <int>];
stdin JSONL {input,output}; stdout JSON {ok:true, selected_indices:int[], coverage_radius:float, backend_used:str}. Implement greedy
k-center (farthest-point), facility-location (lazy-greedy submodular), and BADGE (k-means++ over gradient-proxy = embedding magnitude),
all over embeddings. Embed via a simple deterministic hash-bag (mirror src/embedding.js 256-d) so NO heavy dep is required for the core;
if numpy present use it for speed else pure-python. Mirrors src/data-select.js / data-diversity-select.js which fall back in JS on failure.
--self-test: 30 synthetic pairs, target 6, assert len(selected)==6 + deterministic across two runs.` },

  { label: 'w1:py-minhash', schemaOwner: 'workers/data/scripts/minhash_dedup.py', prompt: `${PY}
OWN: workers/data/scripts/minhash_dedup.py.
MUST be a deterministic PARITY mirror of src/minhash-dedup.js (read it first): same seed 0x6b6f6c6d, FNV-1a hashing, 5-gram (char) shingles,
same num_perm + LSH banding so a given text yields the SAME signature in Python and JS. Interface: argv [--pairs <jsonl>, --out <json>,
--threshold <float default 0.8>, --num-perm <int>, --bands <int>]; stdout JSON {ok:true, duplicate_groups:int[][], kept_indices:int[],
removed:int}. --self-test: feed 3 near-dup + 3 distinct pairs, assert the near-dups collapse to one group and signatures match a hardcoded
expected value computed by the same rule (parity check).` },

  { label: 'w1:py-score-quality', schemaOwner: 'workers/data/scripts/score_quality.py', prompt: `${PY}
OWN: workers/data/scripts/score_quality.py. Optional learned-quality backend for src/data-quality-classifier.js (read it for the score shape).
Interface: argv [--pairs <jsonl>, --out <json>, --model <path optional>, --keep-fraction <float>]; stdout JSON {ok:true, scores:float[0..1],
threshold_used:float, kept_indices:int[], backend_used:str}. Core path: a deterministic logistic scorer over cheap features (length ratios,
type-token ratio, punctuation/format signals, refusal/boilerplate flags) — mirror the JS heuristic so scores are comparable; if scikit-learn
or fasttext or an ONNX model is available + --model given, use it, else fall back to the heuristic (backend_used reflects which). --self-test:
assert a clearly-good pair scores higher than a clearly-bad (empty/garbage) pair + keep-fraction selects the right count.` },

  { label: 'w1:py-dsir', schemaOwner: 'workers/data/scripts/dsir_resample.py', prompt: `${PY}
OWN: workers/data/scripts/dsir_resample.py. Optional DSIR importance-resampling backend for src/data-select.js (read selectInformativeSubset).
Implement DSIR: estimate raw vs target feature distributions (hashed n-gram bag, deterministic), compute per-example importance weights
log(p_target/p_raw), Gumbel-top-k sample target-size examples. Interface: argv [--pairs <jsonl>, --target <jsonl optional, defines the target
distribution; if absent use uniform/self>, --out <json>, --target-size <int>, --seed <int>]; stdout JSON {ok:true, selected_indices:int[],
weights:float[]}. Pure-python + optional numpy. --self-test: build a raw set skewed to topic A, target skewed to topic B, assert resampled
subset shifts toward B (more B than the raw proportion).` },

  { label: 'w1:py-score-errors', schemaOwner: 'workers/data/scripts/score_errors.py', prompt: `${PY}
OWN: workers/data/scripts/score_errors.py. Optional Confident-Learning label-error backend for src/data-label-errors.js (read detectLabelErrors).
Implement Confident Learning: given pairs with a cluster_id label + a predicted-class proxy (derive a cheap class proxy from text features
if no probs given), estimate the confident joint, rank off-diagonal (likely-mislabeled) examples. Interface: argv [--pairs <jsonl>, --out
<json>, --cluster-field cluster_id, --action {review|filter}]; stdout JSON {ok:true, flagged_indices:int[], off_diagonal_rate:float,
scores:float[]}. If cleanlab is installed use it, else the pure-python confident-joint implementation. --self-test: inject 3 deliberately
mislabeled rows into 27 clean (3 clusters), assert >=2 of the 3 are flagged.` },

  { label: 'w1:py-embed', schemaOwner: 'workers/data/scripts/_embed.py', prompt: `${PY}
OWN: workers/data/scripts/_embed.py. Optional embedding backend for src/embedding.js (read it — it's a deterministic 256-d hash-bag).
Interface: argv [--texts <jsonl of strings or {text}>, --out <json>, --dim <int default 256>, --backend {auto|hashbag|st}]; stdout JSON
{ok:true, dim:int, vectors:float[][], backend_used:str}. Default backend 'hashbag' = exact deterministic parity with src/embedding.js
(same hashing + L2 norm) so it's a drop-in. If --backend st and sentence-transformers is installed, use 'all-MiniLM-L6-v2' (backend_used='st'),
else fall back to hashbag. --self-test: assert hashbag vectors are L2-normalized, deterministic across runs, and identical-text => identical vector.` },
]

phase('Build')
const built = await parallel(OWNERS.map((o) => () => agent(o.prompt, { label: o.label, phase: 'Build', schema: R })))
const ok = built.filter(Boolean)
log(`Wave1 build: ${ok.map((b) => `${b.owner||'?'}=${b.status}`).join(', ')}`)

phase('Verify')
const VS = { type:'object', additionalProperties:false, required:['verdict','checks'], properties:{ verdict:{type:'string',enum:['green','issues']}, checks:{type:'array',items:{type:'object',additionalProperties:false,required:['name','pass','detail'],properties:{name:{type:'string'},pass:{type:'boolean'},detail:{type:'string'}}}}, failures:{type:'string'} } }
const verify = await agent(`Wave-1 just created/edited: cli/kolm.js, src/router.js, src/platform-capabilities.js, public/device/webgpu-runner.{html,js},
tests/wave921-webgpu-runner.test.js, and workers/data/scripts/{select_subset,minhash_dedup,score_quality,dsir_resample,score_errors,_embed}.py.
Verify: (1) node --check src/router.js && node --check cli/kolm.js && node --check src/platform-capabilities.js && node --check public/device/webgpu-runner.js;
(2) each python worker runs '--self-test' exit 0 (python workers/data/scripts/<f>.py --self-test) — report PASS/FAIL per file;
(3) the 2 new seed JSONL files exist + are valid JSONL; (4) grep router.js confirms /v1/merge no longer returns 501 on dry_run=false;
(5) grep platform-capabilities.js confirms wasm-webgpu is no longer falsely 'implemented'; (6) node --test tests/wave921-webgpu-runner.test.js.
Report each check pass/fail with exact output. Return ONLY the object.`, { label: 'w1:verify', phase: 'Verify', schema: VS })

return { built: ok, verify }
