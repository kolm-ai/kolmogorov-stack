export const meta = {
  name: 'w921-demo',
  description: '100x /demo-live rebuild: stage 1 authenticity foundation (real fixtures + captured/sourced timeline + real signed receipt + claim-verify gate), stage 2 cinematic HTML re-root (in-browser Ed25519 verify climax, 4-beat, a11y, mobile, reduced-motion, recorder)',
  phases: [{ title: 'Foundation' }, { title: 'HTML rebuild' }],
}

const REPO = 'C:/Users/user/Desktop/kolmogorov-stack'
const SPEC = `Read the FULL spec at ${REPO}/KOLM_W921_DEMO_SPEC.md and follow it exactly. Source-of-truth files (READ-ONLY): public/benchmarks/sota-quantize-matrix.json, public/benchmarks/trinity-500-benchmark.json, public/benchmarks/wave887-wrapper-prod-benchmark.json, data/x04-claim-fixtures.json, src/receipt-schema.js (ALL_FIELDS canonical order), src/gateway-receipt.js (buildAndSignReceipt / verifyReceipt), src/ed25519.js (signature block shape), public/verify.html. Copy discipline: use 'verifiable' / 'reproducible' / 'proof you can check' / 'constraints' — NEVER the word this project's MEMORY bans (no "honest"/"honesty"). Run all commands from ${REPO} (node_modules present here).`

const RESULT = {
  type: 'object', required: ['stage', 'files', 'verify', 'summary'],
  properties: {
    stage: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
    verify: { type: 'string' }, receipt_id: { type: 'string' },
    open_issues: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' },
  },
}

const [foundation] = await Promise.all([
  (async () => {
    const f = await agent(
      `W921 DEMO — STAGE 1 (authenticity foundation). ${SPEC}
Build, in this order:
1. data/demo/support-tickets.jsonl — ~12-19 realistically messy, PII-redacted (on-screen-safe) support tickets (typos, order IDs, multi-intent, refunds, password resets). Real shape, no toy data.
2. A REAL signed receipt: generate it via node using src/gateway-receipt.js buildAndSignReceipt({...}) with demo-appropriate values (route_decision 'local', model a real Qwen2.5 distilled artifact id, real-ish token counts from the tickets, cost derived from tokens). Capture the FULL returned signed receipt (with its signature_ed25519 block incl public_key) — this MUST verify in-browser later. Save it into the timeline (step 3).
3. public/demo-live-timeline.json — an array of 4 beats (Capture, Compile, Verify, Run), each { label, events:[{at,type,text|html,klass}] } using ONLY the existing engine vocabulary (type/out/page/progress/receipt/capture/prompt/enter/subtitle/end). EVERY number must be read from the benchmarks/*.json source files (sota-quantize-matrix 32B row: 61.0 GB->17.9 GB in 125.3s, 11.5 tok/s on RTX 5090, CUDA 12.8; trinity-500 council = Claude 3.5 Sonnet + GPT-4o + DeepSeek-R1-32B -> Qwen2.5-7B, n=57 holdout metrics; wave887 gateway overhead) and MUST match an x04-claim-fixtures.json row. No invented literal, no claude-3.7-haiku, no M3 Max, no /get install line (use 'npm i -g @kolm/cli' or pip-from-source), no rcpt_compile_71F2A6. Embed the full real receipt blob from step 2 in the Verify beat. Derive spend from token counts (no round-number double-count).
4. scripts/capture-demo-timeline.mjs — a runnable pipeline that (when a GPU box is available) runs the REAL CLI (cli/kolm.js: capture -> distill/compile -> quantize int4 -> serve+one reply -> receipts verify --offline) against the fixtures and serializes the same timeline shape. It must degrade gracefully (emit the sourced-from-benchmarks timeline when the live CLI/GPU path is unavailable) so it always produces a valid file.
5. scripts/demo-claim-verify.cjs — walks public/demo-live-timeline.json, asserts every numeric/metric literal matches an x04-claim-fixtures.json row or a benchmarks/*.json field, AND asserts the embedded receipt blob re-verifies via the canonical ALL_FIELDS-order + Ed25519 path (same as src/gateway-receipt.js verifyReceipt). Wire it into scripts/release-verify.cjs as a gate (add a verify:demo-claims npm script + a gate entry that runs node scripts/demo-claim-verify.cjs).
VERIFY: node --check each .mjs/.cjs; node scripts/demo-claim-verify.cjs exits 0; confirm the receipt verifies. You OWN: data/demo/*, public/demo-live-timeline.json, scripts/capture-demo-timeline.mjs, scripts/demo-claim-verify.cjs, scripts/release-verify.cjs. Do NOT edit public/demo-live.html (stage 2 owns it) or src/* (read-only). Return the receipt_id you committed.`,
      { schema: RESULT, label: 'demo:foundation', phase: 'Foundation' })
    // Stage 2 depends on stage 1's timeline + receipt
    const h = await agent(
      `W921 DEMO — STAGE 2 (cinematic HTML re-root). ${SPEC}
Stage 1 has produced public/demo-live-timeline.json (with the real signed receipt embedded). Receipt id: ${f && f.receipt_id || '(read it from the timeline)'}.
Rebuild ${REPO}/public/demo-live.html per spec build-steps 3-16:
- Delete the hardcoded CHAPTERS (288-439), PAGES (510-521), receipt builders (442-507). Replace with const TIMELINE = await fetch('/demo-live-timeline.json').then(r=>r.json()).catch(()=>INLINE_FALLBACK) where INLINE_FALLBACK is the committed timeline inlined so the page never blanks. KEEP the cinematic engine (tick/typeText/outLine/setPage/setReceipt/addCapture/seek/scrub) — reuse it, do not rewrite it.
- Collapse to 4 beats (Capture, Compile w/ INT4 stopwatch landing on 125.3s/17.9GB, Verify=climax, Run). One primary CTA at the end.
- THE CLIMAX: implement verifyReceiptInBrowser(receipt): rebuild canonical = JSON.stringify over receipt-schema ALL_FIELDS order (schema,receipt_id,timestamp,namespace_id,route_decision,provider,model,artifact_id,confidence,fallback_reason,input_hash,output_hash,capture_eligible,capture_id,redaction_applied,input_tokens,output_tokens,cost_usd,signing_key_id,verify_url) MINUS signature_ed25519; import the embedded public_key as a CryptoKey; crypto.subtle.verify('Ed25519', key, sig, new TextEncoder().encode(canonical)). Wire a 'Verify this receipt' button that runs it on click and animates the check to GREEN — ZERO network. Show verify_url as a clickable progressive-enhancement link (never the source of truth).
- Engine hardening: resumable typeText; per-char timing variance; cursor blink gated by reduced-motion.
- Reduced-motion + ?still=1: serve a static poster (public/demo-live-poster.png if present, else a CSS still of the final verified frame) + full selectable transcript + a working Verify button; no auto-play cascade.
- A11y: chapter chips real <button> (tabindex/Enter/Space/aria-current); scrub aria-valuenow+aria-valuetext+:focus-visible; end-card focus-trapped Esc-dismissable dialog with stage inert; subtitle caption aria-live=polite, terminal NOT a live region; decorative dots aria-hidden.
- Mobile (<1000px): one focused pane per beat + keyboard-reachable beat switcher; end-card one clean screen; tap targets >=44px.
- Real install line (npm i -g @kolm/cli); label localhost URLs as local; 'Run this yourself' strip with per-command Copy; Run beat 'paste your own ticket' -> POST /v1/free/chat {question}.
- ?record=1 disables the 500ms autoplay (recorder is sole trigger). Update meta/JSON-LD to the 4-beat/real-number structure. Bump public/sw.js CACHE_VERSION + slug (current v157 -> v158 wave921-demo).
VERIFY: node scripts/demo-claim-verify.cjs exits 0 (the embedded receipt verifies + numbers trace); node --check public/sw.js; confirm demo-live.html has no claude-3.7-haiku / no /get / no rcpt_compile_71F2A6 / no 'M3 Max'. You OWN: public/demo-live.html, public/sw.js, scripts/record-demo-w905.mjs, public/demo-live-poster.png. Do NOT edit src/* or the timeline/gate (stage 1's). Report open_issues honestly (e.g. poster needs the recorder to generate the PNG).`,
      { schema: RESULT, label: 'demo:html', phase: 'HTML rebuild' })
    return { foundation: f, html: h }
  })(),
])

return foundation
