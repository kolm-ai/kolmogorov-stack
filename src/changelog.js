// W456: source-of-truth wave history.
// Public marketing surface — no tenant scoping, no auth. The /v1/changelog
// route and `kolm changelog` CLI verb both render this array.
//
// Add new waves at the TOP. Keep entries terse: a one-line `title` for the
// card, a 1-2-sentence `summary` for the row body, tags for filtering. The
// honest format the dashboard auto-stays-in-sync with is the wave-by-wave
// rollup here, not 1077 lines of hand-rolled HTML.

const WAVES = [
  {
    wave: 'W466',
    date: '2026-05-19',
    title: 'multimodal bake-off harness (compare base vs compiled across image/audio/video/pdf)',
    summary: 'Closes audit P1 Multimodal cluster open item ("multimodal bake-off harness — compare base vs compiled across image/audio/video tasks"). New src/multimodal-bakeoff.js orchestrator replays captured multimodal events (event-store rows with media_kind set) through each compiled .kolm artifact and scores the artifact\'s output against the captured base-model response by token-overlap (Jaccard). Tenant-fenced via listEvents tenant_id filter + per-row defense-in-depth tenant check. Pure string/token compute — no heavy ML in the router (per the standing constraint). Embedding-similarity scoring (CLIP for images, etc.) is opt-in via the KOLM_MULTIMODAL_SCORE_CMD worker hook and lives outside Node. runMultimodalBakeoff() returns a ranked contestants[] envelope with mean_score/median_score/samples/scored/errors + a winner field (highest mean_score, samples desc tie-breaker). When zero captures match the filter, the envelope is ok:true with samples:0 + message:"no_multimodal_captures" so the dashboard can render a "no data yet" panel instead of an error. Why a separate module from src/bakeoff.js: that one compares hosted-model contestants across a dataset (text-only); W466 compares ARTIFACTS across CAPTURES where media_kind is set, which is a fundamentally different input source. Keeping them split makes the tenant-fence + media_kind filter obvious in the source instead of buried in another module\'s branches. New POST /v1/multimodal/bakeoff (auth-gated, tenant_id forced from req.tenant_record, never from body) + GET /v1/multimodal/bakeoff (auto-discovers up to 4 ~/.kolm/artifacts/*.kolm artifacts so the page works zero-config). New `kolm bakeoff multimodal [--modality image|audio|video|pdf] [--namespace ns] [--artifact PATH ...] [--limit N] [--remote]` CLI sub-branch + pretty-printed table. New 17th TUI view multimodal-bakeoff (key M) + :multimodal / :mm / :mm-bakeoff aliases. New /account/multimodal-bakeoff.html page with modality picker + namespace input + winner pill + contestants table + honest empty-state (distinguishes no_multimodal_captures from no_local_artifacts). 10 W466 tests pin the loop: exports + Jaccard edge cases + tenant fence + modality filter + no-captures envelope + artifact_load_failed envelope + route auth + GET auto-discovery + CLI/TUI/sw.js source-pins.',
    tags: ['multimodal', 'bakeoff', 'audit', 'tenant-isolation', 'jaccard'],
  },
  {
    wave: 'W465',
    date: '2026-05-19',
    title: 'per-namespace cost attribution + team-level rollup (closes P1 Billing)',
    summary: 'Closes audit P1 Billing cluster open item ("hosted dashboard for usage breakdown; per-namespace cost attribution; team-level rollup"). New src/billing-breakdown.js aggregates event-store rows (the authoritative cost ledger — not the meter file) into a per-namespace cost+token+latency breakdown for one tenant in a billing period; teamRollup() walks team members via listMembers() and aggregates each member tenant\'s breakdown into a single envelope. Per-member detail is gated by role: owner/admin see every member\'s namespaces; member/viewer see only their own. Connector capture path now reads `x-kolm-namespace:` header (or body.corpus_namespace, or body.metadata.namespace) and stamps it on the event-store row + capture-store row + response header — previously every connector capture landed under literal "default", which made per-namespace attribution useless. New GET /v1/billing/breakdown?period=YYYY-MM[&by=team&team_id=<id>] auth-gated route (tenant_id forced from req.tenant_record, never from query/body). New `kolm billing breakdown [--by namespace|team] [--team-id <id>] [--period YYYY-MM]` CLI verb. New "Per-namespace breakdown" panel on /account/billing.html. New 16th TUI view billing-breakdown (key J) + :breakdown / :rollup / :spend-breakdown command-mode aliases. 10 W465 tests pin the loop: route auth, tenant fence, per-namespace aggregation correctness, team rollup correctness, role-gated detail visibility, period validation, connector namespace threading via header.',
    tags: ['billing', 'cost-attribution', 'namespace', 'team', 'audit', 'rollup'],
  },
  {
    wave: 'W464',
    date: '2026-05-19',
    title: 'multimodal audio voiceprint scrub worker (third media-redact primitive)',
    summary: 'Closes audit P1 Multimodal "audio-side voiceprint scrub" open item. W454 ships audio-to-text via whisper + transcript redaction (what was said); W462 ships pixel-space image PII redaction (faces + license plates); W464 ships the third primitive — voiceprint anonymization on raw audio (who said it). The threat model: leaked audio of a customer/patient/suspect whose VOICE itself is identifying — even after the transcript text is redacted, a voiceprint match against a public sample re-identifies the speaker. Combined with W454 transcript scrub you get "what" and "who" both severed. New workers/multimodal-redact-audio/ isolated package + redact-audio.mjs worker shells out to an external voiceprint redactor: $VOICEPRINT_REDACT_CMD env override (priority 1), pyannote-audio-redact on PATH (priority 2), or python3 ~/.kolm/scripts/voiceprint-redact.py (priority 3). Heavy Python deps (pyannote.audio, torch, speaker embedding models) live OUTSIDE Node entirely — root kolm install stays light (W464 #9 lock). Honest-by-default envelope: when NO external redactor is wired the worker exits 3 with {ok:false, error:"no_detector_installed", install_hint, redacted_audio:null} — never silently passes audio through claiming it was anonymized. New POST /v1/multimodal/redact-audio route spawns the worker (5-min timeout, 64MB stdout buffer for inline base64 audio). New `kolm media audio-doctor` + `kolm media redact-audio [--strength 0..1]` CLI verbs. 10 W464 tests pin the worker shape, the no-soft-claims envelope, the auth-gated routes, the root-package-stays-light invariant, AND an end-to-end working path via an injected Node stub redactor.',
    tags: ['multimodal', 'privacy', 'pii', 'audit', 'voiceprint', 'audio', 'pyannote'],
  },
  {
    wave: 'W463',
    date: '2026-05-19',
    title: 'agent trace compilation MVP (trace_id → IR → seeded cache-hit replay)',
    summary: 'Closes audit P1 Agent Trace cluster open item ("trace storage schema + replay verification + workflow IR across providers"). The trace storage primitive (src/trace-capture.js, W144) and the IR compile/replay primitives (src/workflow-ir.js + src/compile-ir.js, W409w) shipped earlier. What was missing was the loop CLOSER tying the three together. New src/trace-compile.js ships two exports: compileTraceToReplay(trace_id, {tenant_id, opts}) walks the trace, builds the IR via compileIr.traceToIr, seeds the IR with the (user_input → final LLM/tool output) pair, and returns {ir, ir_hash, seeds_count, dropped}. verifyTraceReplay(trace_id, {tenant_id, exec}) replays the seeded input through runCompiledWorkflow and reports per-output match/mismatch with a coverage ratio. Tenant-fenced at the trace_id level via traceCapture.readTrace tenant_mismatch semantics — foreign traces fail loud, never silently rebind. New POST /v1/trace/compile + POST /v1/trace/verify routes (auth-gated, wave144Limiter rate-limit, force tenant scope from req.tenant_record). New `kolm trace compile <trace_id>` + `kolm trace verify <trace_id>` CLI verbs. 10 W463 tests pin the loop end-to-end with inline span fixtures.',
    tags: ['agent-trace', 'workflow-ir', 'replay', 'audit', 'tenant-isolation'],
  },
  {
    wave: 'W462',
    date: '2026-05-19',
    title: 'multimodal image PII redactor (face + license-plate, pixel-space)',
    summary: 'Closes audit P1 Multimodal cluster open item ("redactor for non-text modalities"). New workers/multimodal-redact-image/ isolated package + redact-image.mjs worker ships pixel-space face + license-plate detection (YOLO-format ONNX models in ~/.kolm/models/yolov8n-face.onnx and license-plate-detector.onnx). Complementary to W454 (which redacts TEXT extracted from media via OCR/ASR/PDF-parse) — for medical photos, dashcam frames, and ID-card scans, you typically want BOTH passes. Heavy ML deps (onnxruntime-node + sharp) live in optionalDependencies of the worker package; root kolm install stays light. Honest-by-default envelope: when ANY of {onnxruntime-node, sharp, an ONNX model} is missing, the worker exits 3 with {ok:false, error:"no_detector_installed", install_hint, redacted_image:null} — never silently claims it redacted PII it could not see. New POST /v1/multimodal/redact-image route spawns the worker (5-min timeout, 64MB stdout buffer for inline base64 PNG). New `kolm media image-doctor` + `kolm media redact-image [--mode blur|mask] [--threshold 0.35]` CLI verbs. 10 W462 tests pin the worker shape, the no-soft-claims envelope, the auth-gated routes, and the root-package-stays-light invariant.',
    tags: ['multimodal', 'privacy', 'pii', 'audit', 'face-detection', 'license-plate', 'onnx'],
  },
  {
    wave: 'W461',
    date: '2026-05-19',
    title: 'federated approval-row sharing (hash-only cross-org decisions)',
    summary: 'Closes audit P1 Federated Foundations cluster open item ("approval-row sharing (decisions, not data); cross-org demo with 2+ tenants; opt-in policy + audit chain"). New src/federated-approvals.js ships a decision-aggregation primitive distinct from src/federated-learning.js (gradient-aggregation foundation). approval_hash = sha256(namespace + ":" + sha256(input) + ":" + decision_kind); only the hash, not the input/output text, crosses tenant boundaries. Opt-in is per-tenant and durable; opt-out is default. shareApprovalRows() reads the local approvals store, filters to the caller\'s tenant_id + namespace scope, and emits one hash-only row per approval (approval_hash + input_hash + decision_kind + decided_at — no input/output text, no reviewer). aggregateApprovals() adds Laplace noise (ε=1.0 default, sensitivity=1, scale=1.0) to peer counts so cross-tenant histograms preserve privacy. AUDIT_OPS gains FEDERATED_OPTIN / FEDERATED_OPTOUT / FEDERATED_SHARE; every action lands in the local audit chain. Routes POST /v1/federated/{opt-in,opt-out,share-approvals,aggregate} + GET /v1/federated/{peers,audit}. CLI `kolm federated {opt-in,opt-out,peers,share,aggregate,audit}`. 13 W461 tests pin the cross-org demo, the no-raw-text invariant, the cross-tenant fence, and the Laplace noise envelope.',
    tags: ['federated', 'privacy', 'audit', 'differential-privacy', 'cross-org'],
  },
  {
    wave: 'W460',
    date: '2026-05-19',
    title: 'confidential compute attestation embed in .kolm RS-1 receipt',
    summary: 'Closes audit P1 Confidential Compute cluster open item ("attestation report embed in .kolm RS-1 receipt; verification path"). src/spec-compile.js accepts opts.attestation_report (filesystem path or pre-loaded object) + opts.attestation_kind (pccs/snp-report/nitro-attestation/nras); the report flows through buildAndZip → verifyAttestation → manifest.confidential_compute. The state machine is honest-by-default — shape_ok + verified:false when only the shipped shape-only stub is wired, cryptographically_verified + verified:true only when a tenant has registered a real crypto verifier via registerAttestationVerifier(kind, fn). confidential_compute_hash binds into artifact_hash so post-build tampering of the attestation invalidates the receipt. CLI: `kolm compile --attestation-report <file> --attestation-kind <kind>` + `kolm verify --attestation` pretty-prints the embedded block. 10 W460 tests exercise the full spec→artifact path, hash-binding, plugin upgrade, malformed-report rejection, missing-kind error, and no-attestation default.',
    tags: ['confidential-compute', 'attestation', 'audit', 'tee', 'rs-1'],
  },
  {
    wave: 'W459',
    date: '2026-05-19',
    title: 'distillation reliability: teacher fallback + partial-run resume',
    summary: 'Closes audit P1 distillation cluster. src/distill-pipeline.js wraps the worker spawn in an attempt loop over _pickTeachers() — first teacher whose worker exits clean (code 0 + no `teacher_error` in manifest) wins. KOLM_DISTILL_TEACHER accepts a comma list for explicit operator-ordered fallback. distill() exposes new params `teacher_fallback:true` (auto-retry next teacher) and `resume_from:<run_id>` (reuse prior runDir + seeds.jsonl, append to progress.jsonl, monotonic step counter). Resume is tenant-fenced — mismatched tenant_id throws, never silently rebinds. run-meta.json records teacher_planned + resume_from + first teacher. Done envelope adds teacher_used + teacher_attempts[] + resumed_from + resume_prior_steps. 10 W459 tests pin the contract end-to-end with inline stub workers.',
    tags: ['distill', 'reliability', 'audit', 'tenant-isolation'],
  },
  {
    wave: 'W458',
    date: '2026-05-19',
    title: 'definition-of-done 12-step e2e test',
    summary: 'tests/wave458-dod-12-step-e2e.test.js is now the canonical "did we ship?" assertion. One in-process flow walks all 12 audit DoD steps: tenant provisioning → /v1/whoami → BASE_URL proxy chain → 30 captures land → /v1/intent/next ranks actions → /v1/distill/from-captures → /v1/bakeoff/run → compileFull → loadArtifact + Ed25519 sidecar → runArtifact (RS-1 receipt + kolm-audit-1) → /v1/drift/snapshot + /v1/drift/detect (verdict ≠ within on a 23-pt K drop) → compileFull --since=last-compile fresh artifact. Zero hand-curation between steps 4-10; behavior assertions only. Plus an invariant lock so a 13th DoD step cannot ship without its assertion landing here.',
    tags: ['e2e', 'audit', 'compile', 'verify', 'distill', 'drift'],
  },
  {
    wave: 'W457',
    date: '2026-05-19',
    title: 'omnibus finish: runtime/GGUF + CLI auth + telemetry + EPERM + hrefs + trust honesty',
    summary: '7-block finish closing every release blocker. (1) manifest.runtime === manifest.runtime_target === receipt.runtime_target locked in; bundled 491MB Qwen2.5-0.5B q4_k_m as proof. (2) kolm whoami/doctor split api-key into config + server rows; capture status + distill runs fall back to local store on cloud failure (no AggregateError). (3) kolm what / lake / opportunities / capture status all read the canonical event-store. (4) kolm build honors --out, EPERM on locked file gives a clean error, --from override warns when overridden by curated baseline. (5) 7 broken hrefs cleared (/cookbook reroute to /docs/cookbook, /security.txt rewrite); homepage drops weight-class artifact overclaim, names rule-class today + roadmap separately. (6) trust.html demo-signature replaced with clearly-invalid fixture; status.html 99.97% placeholder rows now explain the cell populates from /v1/uptime; 34 mojibake fixes across cookbook/research/vs/soc2. (7) Recent-shipped panel on /account/overview reads /v1/changelog; soup-to-nuts phrase scrubbed from generated changelog. 3907/3907 + 0 broken hrefs.',
    tags: ['compile', 'verify', 'distill', 'cli', 'trust', 'docs', 'hero'],
  },
  {
    wave: 'W456',
    date: '2026-05-19',
    title: 'public changelog + roadmap surface',
    summary: 'Source-of-truth WAVES array drives /v1/changelog + `kolm changelog` CLI + auto-refresh of /changelog and /roadmap recent strips.',
    tags: ['website', 'cli', 'docs'],
  },
  {
    wave: 'W455',
    date: '2026-05-19',
    title: 'per-prompt loss telemetry to /account/distill-runs',
    summary: 'Distill writes run-meta.json + progress.jsonl per iteration. New /v1/distill/runs[/:id] routes + `kolm distill runs` CLI + /account/distill-runs page with SVG sparklines render loss + K-score curves per run.',
    tags: ['distill', 'account', 'cli', 'telemetry'],
  },
  {
    wave: 'W454',
    date: '2026-05-19',
    title: 'media redact worker doctor + capture wiring',
    summary: 'workers/media-redact doctor surface + tenant-scoped media-capture redaction wiring. Closes the audit P0-5 cluster for image/audio capture flows.',
    tags: ['privacy', 'multimodal', 'worker'],
  },
  {
    wave: 'W443-W446',
    date: '2026-05-19',
    title: 'audit-finish batch (DoD honest verify)',
    summary: 'W443 compile honesty (synthClassifier rewrite, coverage K=0.984), W444 lake storage+retention verbs, W445 verify failure taxonomy + /v1/devices/recommend + CC state machine + FL roundHash + trace tenant_id rebind, W446 value-loop audit pin.',
    tags: ['audit', 'distill', 'verify'],
  },
  {
    wave: 'W438-W439',
    date: '2026-05-19',
    title: 'real compile + incremental retrain',
    summary: 'W438 closes audit item 5 (rule-class real synth-path compile, allow_below_gate productionReady gate). W439 closes item 6 (--since wired through prepareDistillCorpus → compileFull → cmdCompile, --since-last-compile).',
    tags: ['compile', 'distill'],
  },
  {
    wave: 'W433-W436',
    date: '2026-05-19',
    title: 'DoD closure batch',
    summary: '/v1/whoami SDK alias, /v1/drift HTTP surface, /v1/bridges/observations ?since= + cmdBridges + --since-last-compile, /v1/verify/:cid + POST /v1/artifact/verify-manifest with manifest_hash_mismatch envelope.',
    tags: ['verify', 'cli', 'audit'],
  },
  {
    wave: 'W419-W432',
    date: '2026-05-19',
    title: 'audit-finish batch (13-item w415-outstanding-diffs)',
    summary: 'Closes 13 audit P0/P1/P2 items: opportunity tenant, pipeline force, distill real-bridge, media-capture tenant_id, agent-telemetry, trace, job ownedBy, distill metadata, mojibake guard, snapshotContext. 173 tests green.',
    tags: ['audit', 'tenant', 'telemetry'],
  },
  {
    wave: 'W411-W414',
    date: '2026-05-19',
    title: 'P0 correctness + NL ask + Next-actions triangle',
    summary: 'W411 12 P0 correctness atoms (tenant_id parity, content-dedupe, fail-closed redaction). W412 NL intent learns lake/opps/dataset/labels/bakeoff verbs. W413 Next-Actions panel on /account/overview. W414 TUI Next view + /docs/verify.',
    tags: ['audit', 'nl', 'tui', 'web'],
  },
  {
    wave: 'W408-W410',
    date: '2026-05-18',
    title: 'finish-loop batch (38 atoms via 13 parallel agents)',
    summary: 'Hero atoms (v0.2 delete, K-score delete, two-CTAs, FAQ), canonical event-store, fail-closed redaction, runtime dispatch, production gate, account-routes, OpenAI-compat /v1/models envelope, e2e loop, CLI+TUI+UI parity, 9 SDK recipes (openai/anthropic/openrouter/langchain/vercel-ai/litellm/cursor/docker/env).',
    tags: ['hero', 'audit', 'sdk', 'integrations'],
  },
  {
    wave: 'W405',
    date: '2026-05-19',
    title: 'Apple-style restraint (homepage)',
    summary: '25-section wall-of-text → 17 sections. Deleted 5 sections (~1100 lines) moved to /taxonomy /docs /roi /remote verticals. Hero artifact swapped phi-redactor → qwen3.6-27b. PNG 2.42 → 1.45MB.',
    tags: ['hero', 'design'],
  },
  {
    wave: 'W403',
    date: '2026-05-19',
    title: 'surface-map + proxy dogfood',
    summary: 'W373 sec 1-6 plain-English rewrite + sec 7 8-card 40-link map. Proxy dogfood: ANTHROPIC_BASE_URL=127.0.0.1:7403 pinned in Claude Code settings, captures durable to ~/.kolm/captures/claude-code.jsonl with PHI redaction verified.',
    tags: ['hero', 'dogfood', 'integrations'],
  },
  {
    wave: 'W402',
    date: '2026-05-18',
    title: 'hero "the local AI stack"',
    summary: 'H1 13 words: "Your own AI stack. Compile workflows. Distill models. Train frontier. On hardware you control." 5-use-case lede.',
    tags: ['hero', 'copy'],
  },
  {
    wave: 'W398-W400',
    date: '2026-05-18',
    title: 'Jung-grade plain-English hero + docs audit close',
    summary: 'W398 H1 24 → 14 words ("Stop the duplicate API calls / Run the repeats on your hardware"); dropped OpenAI/Anthropic/OpenRouter/Claude/ChatGPT/Cursor brand-name drops. W400-401 docs.html 35k → 46k Zone 5 Reference matrix.',
    tags: ['hero', 'copy', 'docs'],
  },
  {
    wave: 'W397',
    date: '2026-05-18',
    title: 'dataset-to-bakeoff hydration',
    summary: 'loadDatasetRows async + resolves ds_*/ns via ~/.kolm/datasets/<id>.json + getEvent() hydration of holdout_ids; cmdBakeoff curated-template demoted to catch-only fallback (real data wins).',
    tags: ['dataset', 'bakeoff'],
  },
  {
    wave: 'W367-W386',
    date: '2026-05-18',
    title: 'finish-product batch (20 waves)',
    summary: 'W370 17-class privacy membrane / W373 website rewrite / W374 docs tree / W375 15-section /account / W376+W385 13-view TUI / W377 multimodal capture / W378 4-state cloud sync / W379 RBAC + reviewer queues / W381 7-step pipeline / W382 dev-agent installers / W383 telemetry dashboard / W384 CLI+router consolidator R2 / W386 model-weights catalog.',
    tags: ['privacy', 'tui', 'multimodal', 'rbac', 'pipeline'],
  },
  {
    wave: 'W339-W365',
    date: '2026-05-18',
    title: 'finish-everything batch (8 parallel agents)',
    summary: 'A production-verdict + cmdRun --strict/--force; B real claims-redactor.kolm (K=0.985); C eval-bench parity; D Windows libuv crash fix + Gemma 3n mobile; F NL intent classifier (src/intent.js 1055 LOC + cmdDo/What/Next/Explain/Fix); G 5 seeds modules; H 7-step pipeline-make/ship/train --watch; I closed 4 P0s. 478 tests.',
    tags: ['audit', 'distill', 'nl'],
  },
  {
    wave: 'W338',
    date: '2026-05-18',
    title: 'reality audit (codex-grade)',
    summary: '13 compute backends REAL (fal/replicate/runpod=HTTPS+poll, modal=spawn CLI, lambda/vast=SSH-handle, 6 local-*=child_process). 280-LOC workers/quantize/scripts/quantize.py for int4/8/gptq/awq.',
    tags: ['audit', 'compute', 'quantize'],
  },
  {
    wave: 'W334',
    date: '2026-05-18',
    title: 'hero rescue: drop salmon + PHI niche',
    summary: 'CSS .stop salmon → cream; pill drops "for regulated buyers"; H1 3 beats → 2; thesis drops PHI/privileged/KYC vertical framing. Verticals belong on /healthcare /legal /finance not home.',
    tags: ['hero', 'design'],
  },
  {
    wave: 'W326-W332',
    date: '2026-05-18',
    title: 'sprint scorecard + prod deploy',
    summary: 'W326 sweep 216/216 + W327 W211-W325 cross-sweep 2599/2615 caught 3 regressions (W218 doctor slice, W206 docs gaps, value-loop em-dash). W328 lighthouse. W329 sitemap 298→317. W330 vercel prod 49s. W331 9/9 prod 200.',
    tags: ['sprint', 'deploy'],
  },
  {
    wave: 'W314-W317',
    date: '2026-05-18',
    title: '/captures inbox UI polish',
    summary: 'Client-side substring search + MutationObserver across SSE; ?namespace= deep link; promote-confirm modal (role=dialog, Escape, backdrop); CSV download honoring search filter + RFC4180 escape.',
    tags: ['captures', 'web'],
  },
  {
    wave: 'W312-W313',
    date: '2026-05-18',
    title: '/value-loop status badge + try-it form',
    summary: 'loop-status pill probes /health w/4s AbortController (green=200, amber=network-error, red=HTTP-error). POST /v1/loop/try public anonymous returns real receipt + `demo:true`+`durable:false`.',
    tags: ['website', 'value-loop'],
  },
  {
    wave: 'W297',
    date: '2026-05-18',
    title: 'value-loop lock-in + corpus_namespace bugfix',
    summary: '8-test buildRouter() harness walks capture→SSE→bridges→distill→replay + cross-tenant isolation. W297 fix /v1/bridges/observations: recordCapture wrote corpus_namespace but handler filtered on namespace.',
    tags: ['value-loop', 'tenant'],
  },
];

function listWaves({ limit = 20, since = null, tag = null } = {}) {
  let waves = WAVES.slice();
  if (since) {
    const sinceNum = _waveToNumber(since);
    waves = waves.filter((w) => _waveMaxNumber(w.wave) >= sinceNum);
  }
  if (tag) {
    const t = String(tag).toLowerCase();
    waves = waves.filter((w) => Array.isArray(w.tags) && w.tags.includes(t));
  }
  const n = Math.max(1, Math.min(200, Number(limit) || 20));
  return waves.slice(0, n);
}

function getWave(wave) {
  if (!wave) return null;
  const key = String(wave).toUpperCase().trim();
  return WAVES.find((w) => w.wave.toUpperCase() === key || _waveContains(w.wave, key)) || null;
}

function latestWave() {
  return WAVES[0] || null;
}

function waveCount() {
  return WAVES.length;
}

// "W455" -> 455, "W411-W414" -> 414, "W367-W386" -> 386 (max for range entries).
function _waveMaxNumber(wave) {
  const parts = String(wave).match(/W(\d+)/gi) || [];
  let max = 0;
  for (const p of parts) {
    const n = parseInt(p.replace(/W/i, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

// "W455" or "455" -> 455.
function _waveToNumber(input) {
  const m = String(input).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// "W411-W414".contains("W412") -> false (it's a range label, not a member list).
// Treat the label as opaque; getWave by exact string match if user passes "W411-W414".
function _waveContains(label, key) {
  return String(label).toUpperCase() === String(key).toUpperCase();
}

export { WAVES, listWaves, getWave, latestWave, waveCount };
export default { WAVES, listWaves, getWave, latestWave, waveCount };
