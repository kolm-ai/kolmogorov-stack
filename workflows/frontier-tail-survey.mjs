export const meta = {
  name: 'frontier-tail-survey',
  description: 'Map the TRUE state + exact buildable gaps of every remaining frontier item + sweep for other outstanding work',
  phases: [{ title: 'Survey' }],
}

const ROOT = 'C:/Users/user/Desktop/kolmogorov-stack'
const FIND_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'overall', 'items'],
  properties: {
    area: { type: 'string' },
    overall: { type: 'string', enum: ['built', 'partial', 'stub', 'mixed'] },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'state', 'gap', 'buildable_locally', 'files'],
        properties: {
          name: { type: 'string' },
          state: { type: 'string', enum: ['built', 'partial', 'stub', 'missing', 'infra_bound'] },
          gap: { type: 'string', description: 'EXACTLY what is missing to reach 100%' },
          buildable_locally: { type: 'boolean', description: 'true if completable on a single RTX 5090 / no special infra' },
          files: { type: 'string', description: 'the file(s) to create/edit, with line anchors where known' },
          next_action: { type: 'string', description: 'the concrete build step' },
        },
      },
    },
  },
}
const COMMON = `Repo root: ${ROOT}. READ-ONLY (Grep/Glob/Read; you may run node --check or a quick read). Be precise + skeptical:
"file exists" != "built" — built means the real algorithm/loop is implemented + reachable + tested, not a stub/TODO. For EACH
item give state (built/partial/stub/missing/infra_bound), the EXACT gap to 100%, whether it's completable on one RTX 5090 with
no special infra (buildable_locally), the file(s) to touch, and the concrete next build step. Cite file:line. Return ONLY the object.`

const READERS = [
  { label: 'survey:data-workers', prompt: `${COMMON}
AREA: the 13 data-engine Python acceleration workers (workers/data/scripts/). The JS modules (src/data-curate.js,
src/data-quality-classifier.js, src/data-cluster-label.js, src/data-label-errors.js, src/data-diversity-select.js,
src/minhash-dedup.js, src/data-select.js) already have working JS fallbacks. The Python workers add embedding/learned backends.
For EACH expected worker — minhash_dedup.py, cluster_pairs.py, score_quality.py, dsir_resample.py, select_subset.py,
score_errors.py, mix_doremi_proxy.py, _embed.py, _console.py, score_datamap.py, score_ifd.py, score_influence.py — report
whether it EXISTS (Glob workers/data/scripts/), whether any JS module shells out to it (grep src for the script name + spawnSync/exec),
and the exact interface (argv + stdin/stdout JSON) the JS side expects. Distinguish "missing file" from "present + wired".` },

  { label: 'survey:trainer-loops', prompt: `${COMMON}
AREA: ROPD + QAD GPU training loops (apps/trainer/ropd.py, apps/trainer/qad.py). Read each main() + the trainer fn.
QAD: did it ever run a real fake-quant training (look for qad_trainer / session.train() actually invoking transformers Trainer)?
ROPD: is the FULL GRPO weight-update loop wired (rollout generation -> teacher-text rubric scoring -> grpo_advantages ->
policy gradient / optimizer.step), or does main() stage 'trainer_not_invoked' and only do scoring? Report the EXACT gap to a
complete ROPD training run on a 5090 (which function to fill, what it must call — e.g. apps/trainer/grpo.py GRPOTrainer,
distill.py generate_student_responses). buildable_locally should be true (5090 + Qwen2.5-0.5B/3B are cached).` },

  { label: 'survey:webgpu-runner', prompt: `${COMMON}
AREA: NOW-5 — WebGPU verified on-device runner. Find any real on-device inference runner (grep public/ src/ for navigator.gpu,
WebGPU, transformers.js, onnxruntime-web, wllama, webllm, a .wasm/gguf browser loader). public/device-transfer/browser-wasm.html
+ public/benchmarks/edge.html exist — read them: is there an ACTUAL runner that loads a model + generates tokens in-browser, or
just marketing/docs? Report the gap to "a .kolm/GGUF artifact runs + verifies on-device via WebGPU with a signed receipt", and
which parts are buildable_locally (the runner code + a headless test) vs need a real browser/WebGPU GPU (full validation).` },

  { label: 'survey:moe-aware', prompt: `${COMMON}
AREA: NEXT-4 (MoE-aware distill/quantize) + BET-2 (distill-from-1T-MoE). Read src/forge-experts.js + src/forge-inspect.js +
grep src/compile.js + workers/quantize/* + apps/trainer/* for MoE handling (num_experts, expert_, router_logits, per-expert
quant, expert-balance). Report what MoE-awareness ALREADY exists (detection? per-expert quant? expert pruning/merging?), the
exact gap to NEXT-4 (MoE models distill+quantize correctly), and for BET-2 mark infra_bound where a true 1T-param MoE cannot run
on a 5090 — but identify what CAN be built+validated locally (the code paths + a small MoE model e.g. a tiny Qwen/OLMoE/Mixtral-style fixture).` },

  { label: 'survey:outstanding-sweep', prompt: `${COMMON}
AREA: ANY OTHER outstanding work. Sweep the codebase (src/, cli/, workers/, apps/, scripts/) for genuine incompletes:
grep for 'not_yet_implemented', 'NOT YET', 'TODO', 'FIXME', 'stub', 'not wired', 'coming soon', 'placeholder', '501', 'unimplemented',
'NotImplemented', 'throw new Error(.*not'. EXCLUDE test fixtures + intentional roadmap/'Not yet shipped' marketing tags. Return the
items that are REAL unfinished functionality a user could hit (a route/CLI verb/feature that errors or no-ops). For each: where it is,
what's missing, and whether buildable_locally. Prioritize ones reachable from the live product surfaces.` },

  { label: 'survey:copy-review', prompt: `${COMMON}
AREA: copy review prep (do NOT edit — just identify). Scan the key user-facing pages (public/index.html, public/about.html [now the
product page], public/pricing.html, public/wrapper.html, public/studio.html, public/docs/index.html) + nav.js/footer for copy that
needs attention: stale or unverifiable claims, leftover references to removed pages (/manifesto, /product, the 6 deleted stubs),
inconsistent product naming, the top promo banner text, broken internal links, placeholder/TBD copy, and anything that reads
wrong now that /about IS the product page. List concrete copy items with file:line + the suggested change. state='partial' per item
where a fix is warranted. buildable_locally=true for all (copy edits).` },
]

phase('Survey')
const found = await parallel(READERS.map((r) => () => agent(r.prompt, { label: r.label, phase: 'Survey', schema: FIND_SCHEMA, agentType: 'Explore' })))
const clean = found.filter(Boolean)
const buildable = []
const infra = []
for (const f of clean) for (const it of (f.items || [])) {
  if (it.state === 'built') continue
  ;(it.buildable_locally ? buildable : infra).push({ area: f.area, ...it })
}
log(`Survey: ${clean.length}/6 areas. ${buildable.length} buildable-locally gaps, ${infra.length} infra-bound.`)
return { areas: clean, buildable, infra }
