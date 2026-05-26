#!/usr/bin/env node
// W869+ extension to the existing CLI doc generator family.
// Writes hand-curated docs for the highest-priority verbs surfaced by
// the W869 docs-coverage audit. Skips files that already exist.

const fs = require('fs');
const path = require('path');

const outDir = path.resolve(__dirname, '..', 'public', 'docs', 'cli');
const KOLM_GITHUB_URL = process.env.KOLM_GITHUB_URL || 'https://github.com/sneaky-hippo/kolm';

const verbs = [
  {
    name: 'bundle',
    title: 'kolm bundle',
    desc: 'Build deployment-ready bundles. The primary sub-verb is `airgap`, which produces a tar.gz of the kolm runtime + your local checkout for offline install.',
    usage: 'kolm bundle airgap --out <path.tar.gz> [--with-node-modules] [--with-wheels] [--with-models] [--force] [--json]',
    flags: [
      ['airgap', 'required', 'Sub-verb. Builds a tar.gz containing the kolm runtime + checkout suitable for offline install.'],
      ['--out <path>', 'required', 'Destination path. Must end in <code>.tar.gz</code> or <code>.tgz</code>.'],
      ['--repo-root <dir>', 'auto', 'Source repo root. Defaults to the directory where the kolm CLI lives.'],
      ['--models-dir <dir>', 'none', 'Optional models directory to include when paired with <code>--with-models</code>.'],
      ['--with-node-modules', 'off', 'Include <code>node_modules/</code> (large, ~300 MB). Use for fully offline install.'],
      ['--with-wheels', 'off', 'Include any <code>wheels/</code> directory (Python wheels for offline pip install).'],
      ['--with-models', 'off', 'Include the models directory passed via <code>--models-dir</code>.'],
      ['--force', 'off', 'Overwrite the destination if it already exists.'],
      ['--json', 'off', 'Print the result envelope as JSON instead of human text.'],
    ],
    examples: [
      'kolm bundle airgap --out /tmp/kolm-airgap.tar.gz',
      'kolm bundle airgap --out kolm.tgz --with-node-modules --with-wheels',
      'kolm bundle airgap --out /tmp/kolm.tar.gz --with-models --models-dir ~/models --json',
    ],
    notes: 'Produces a deterministic file list (sorted, sha256 per file) plus <code>MANIFEST.json</code>, <code>BUNDLE-README.md</code>, and <code>VERSION</code>. The bundle README contains the offline install quick-start. Default size is ~30 MB compressed; <code>--with-node-modules</code> pushes that to ~300 MB. The HTTP endpoint <code>/v1/bundle/airgap</code> returns <code>501 bundle_airgap_requires_cli</code> — air-gap bundles are CLI-only by design.',
    see: [
      ['kolm pack', '/docs/cli/pack'],
      ['kolm airgap', '/docs/cli/airgap'],
      ['Self-hosted deploy guide', '/docs/enterprise'],
    ],
  },
  {
    name: 'forge',
    title: 'kolm forge',
    desc: 'Umbrella verb for the Forge pipeline: hardware detection, fit checks, model inspection, MoE expert routing, merging, serving, and benchmarking.',
    usage: 'kolm forge <sub-verb> [flags]',
    flags: [
      ['hardware', '-', 'Auto-detect local GPU/CPU and report VRAM/RAM (alias for <code>kolm hardware</code>).'],
      ['fit', '-', 'Check whether a target model will fit on detected hardware before compile (alias for <code>kolm fit</code>).'],
      ['inspect', '-', 'Inspect a <code>.kolm</code> or <code>.safetensors</code> file (alias for <code>kolm inspect</code>).'],
      ['experts', '-', 'List or route Mixture-of-Experts components (alias for <code>kolm experts</code>).'],
      ['merge', '-', 'Merge two artifacts (alias for <code>kolm merge</code>).'],
      ['serve', '-', 'Start a local inference server (alias for <code>kolm serve</code>).'],
      ['bench', '-', 'Benchmark an artifact (alias for <code>kolm bench</code>).'],
    ],
    examples: [
      'kolm forge hardware',
      'kolm forge fit --model meta-llama/Llama-3.1-8B --target cuda',
      'kolm forge inspect ./out/recipe.kolm',
      'kolm forge serve ./out/recipe.kolm --port 8787',
    ],
    notes: 'The forge umbrella is for discoverability — every sub-verb is also reachable directly. Add <code>--json</code> to any sub-verb for machine-readable output.',
    see: [
      ['kolm hardware', '/docs/cli/hardware'],
      ['kolm fit', '/docs/cli/fit'],
      ['kolm compile', '/docs/cli/compile'],
      ['kolm serve', '/docs/cli/serve'],
    ],
  },
  {
    name: 'studio',
    title: 'kolm studio',
    desc: 'Launch or interact with the kolm Studio surface — the unified compile wizard, session manager, and recipe library.',
    usage: 'kolm studio <open|status|list|sessions|recipes> [--json]',
    flags: [
      ['open', '-', 'Open the Studio surface in the default browser at <code>/studio/compile</code>.'],
      ['status', '-', 'Print Studio surface status (auth, active sessions, recipe count).'],
      ['list', '-', 'List Studio-discovered recipes.'],
      ['sessions', '-', 'List active compile sessions.'],
      ['recipes', '-', 'Print the recipe library (paths, slugs, last edited).'],
      ['--json', 'off', 'Print machine-readable JSON instead of human text.'],
      ['--no-color', 'off', 'Strip ANSI color from output (a11y).'],
      ['--no-unicode', 'off', 'Use ASCII-only output (a11y).'],
      ['--plain', 'off', 'Shortcut for <code>--no-color --no-unicode</code>.'],
    ],
    examples: [
      'kolm studio status',
      'kolm studio sessions --json',
      'kolm studio open',
    ],
    notes: 'The Studio surface ships at <a href="/studio/compile">/studio/compile</a>. The CLI verb mirrors what the TUI shows under view key <code>W</code>.',
    see: [
      ['kolm compile', '/docs/cli/compile'],
      ['kolm tui', '/docs/cli/tui'],
      ['kolm wizard', '/docs/cli/wizard'],
    ],
  },
  {
    name: 'ai-act',
    title: 'kolm ai-act',
    desc: 'EU AI Act compliance helpers: Annex IV export, risk classification, human-in-loop logging, and governance reports.',
    usage: 'kolm ai-act <export|risk-score|human-in-loop|governance-report> [flags]',
    flags: [
      ['export', '-', 'Build Annex IV technical documentation for an artifact.'],
      ['risk-score', '-', 'Classify a manifest against the AI Act risk tiers (minimal, limited, high, unacceptable).'],
      ['human-in-loop', '-', 'Persist a human-in-loop decision (with confirm).'],
      ['governance-report', '-', 'Aggregate captures into a governance summary.'],
      ['--artifact <path>', 'required-for-export', 'Path to the <code>.kolm</code> artifact under review.'],
      ['--out <path>', 'stdout', 'Where to write the export / report.'],
      ['--json', 'off', 'JSON output.'],
    ],
    examples: [
      'kolm ai-act risk-score --manifest ./manifest.json',
      'kolm ai-act export --artifact ./out/recipe.kolm --out ./annex-iv.pdf',
      'kolm ai-act governance-report --period 2026-Q2',
    ],
    notes: 'Backed by the <code>/v1/compliance/ai-act/*</code> routes. Output is auditor-ready; pair with <code>kolm passport</code> for model risk review packs.',
    see: [
      ['kolm passport', '/docs/cli/passport'],
      ['kolm sbom', '/docs/cli/sbom'],
      ['kolm cert', '/docs/cli/cert'],
    ],
  },
  {
    name: 'sbom',
    title: 'kolm sbom',
    desc: 'Generate Software Bill of Materials (SBOM) for an artifact in SPDX or CycloneDX format. Required for SOC 2 / FedRAMP / NIST.',
    usage: 'kolm sbom <artifact.kolm> [--format spdx|cyclonedx] [--out <path>] [--json]',
    flags: [
      ['<artifact.kolm>', 'required', 'Path to the artifact to scan.'],
      ['--format <fmt>', '<code>spdx</code>', 'Output format: <code>spdx</code> (default), <code>cyclonedx</code>.'],
      ['--out <path>', 'stdout', 'Destination file. Use <code>-</code> for stdout.'],
      ['--json', 'off', 'Print envelope summary as JSON.'],
    ],
    examples: [
      'kolm sbom ./out/recipe.kolm',
      'kolm sbom ./out/recipe.kolm --format cyclonedx --out ./sbom.json',
    ],
    notes: 'Includes base model, tokenizer, training data hashes, dependency tree, and license declarations. Matches the schema published at <a href="/security/sbom">/security/sbom</a>.',
    see: [
      ['kolm passport', '/docs/cli/passport'],
      ['kolm cert', '/docs/cli/cert'],
      ['kolm verify', '/docs/cli/verify'],
    ],
  },
  {
    name: 'passport',
    title: 'kolm passport',
    desc: 'Export a compliance-friendly model card envelope for model risk review (MRR) and vendor security review.',
    usage: 'kolm passport export <artifact.kolm> [--format compliance|model-card|json] [--out <path>]',
    flags: [
      ['export', 'required', 'Sub-verb. Currently the only one.'],
      ['<artifact.kolm>', 'required', 'Artifact to export from.'],
      ['--format <fmt>', '<code>compliance</code>', 'Output format. <code>compliance</code> = MRR pack, <code>model-card</code> = HF-style card, <code>json</code> = raw envelope.'],
      ['--out <path>', 'stdout', 'Destination file.'],
    ],
    examples: [
      'kolm passport export ./out/recipe.kolm --format compliance --out ./passport.pdf',
      'kolm passport export ./out/recipe.kolm --format model-card --out ./MODEL_CARD.md',
    ],
    notes: 'The compliance format bundles K-Score axes, training data lineage, evals, base model attribution, license, and SBOM into a single document review boards typically request. Sign with <code>kolm attest</code> for cryptographic provenance.',
    see: [
      ['kolm sbom', '/docs/cli/sbom'],
      ['kolm attest', '/docs/cli/attest'],
      ['kolm ai-act', '/docs/cli/ai-act'],
      ['kolm model-card', '/docs/cli/model-card'],
    ],
  },
  {
    name: 'audit',
    title: 'kolm audit',
    desc: 'View, filter, and stream the audit log. Every state-changing CLI verb and HTTP request is recorded.',
    usage: 'kolm audit [--since <ts>] [--actor <id>] [--action <slug>] [--json] [--tail]',
    flags: [
      ['--since <ts>', '<code>24h</code>', 'Show events since this timestamp or relative duration.'],
      ['--actor <id>', 'all', 'Filter to a specific tenant id or API key prefix.'],
      ['--action <slug>', 'all', 'Filter to one action class (e.g. <code>compile</code>, <code>auth.signup</code>).'],
      ['--json', 'off', 'JSON line stream.'],
      ['--tail', 'off', 'Follow the log (like <code>tail -f</code>).'],
    ],
    examples: [
      'kolm audit --since 1h',
      'kolm audit --action compile --json | jq .',
      'kolm audit --tail',
    ],
    notes: 'Mirrors <code>/v1/account/audit-log</code>. Retention is plan-tiered: free 30d, pro 90d, business 365d, enterprise 2555d (7y).',
    see: [
      ['kolm audit-export', '/docs/cli/audit-export'],
      ['kolm evidence', '/docs/cli/evidence'],
    ],
  },
  {
    name: 'audit-export',
    title: 'kolm audit-export',
    desc: 'Export an audit log slice for SIEM ingestion, archival, or regulator submission.',
    usage: 'kolm audit-export [--since <ts>] [--until <ts>] [--format jsonl|csv|cef] [--out <path>]',
    flags: [
      ['--since <ts>', 'epoch', 'Start of the export window.'],
      ['--until <ts>', 'now', 'End of the export window.'],
      ['--format <fmt>', '<code>jsonl</code>', '<code>jsonl</code>, <code>csv</code>, or <code>cef</code> (ArcSight Common Event Format).'],
      ['--out <path>', 'stdout', 'Destination file.'],
      ['--signed', 'off', 'Attach an Ed25519 signature for tamper-evidence.'],
    ],
    examples: [
      'kolm audit-export --since 2026-04-01 --until 2026-04-30 --format csv --out apr.csv',
      'kolm audit-export --format cef --signed --out audit.cef',
    ],
    notes: 'Pairs with the SIEM-streaming feature (Enterprise tier) at <code>/account/enterprise</code>. The signed flag produces a sidecar <code>.sig</code> file.',
    see: [
      ['kolm audit', '/docs/cli/audit'],
      ['kolm attest', '/docs/cli/attest'],
    ],
  },
  {
    name: 'cert',
    title: 'kolm cert',
    desc: 'Compliance certification packet management — generate, validate, and submit attestation packets.',
    usage: 'kolm cert <generate|validate|submit> [--type <slug>] [--out <path>]',
    flags: [
      ['generate', '-', 'Generate a certification packet for a given certification.'],
      ['validate', '-', 'Validate an existing packet against the schema.'],
      ['submit', '-', 'Submit a packet to an external auditor (HTTPS POST).'],
      ['--type <slug>', 'required', '<code>soc2-type2</code>, <code>iso27001</code>, <code>hipaa</code>, <code>gdpr</code>, <code>aiact</code>.'],
      ['--out <path>', 'stdout', 'Where to write the packet.'],
    ],
    examples: [
      'kolm cert generate --type soc2-type2 --out ./soc2-packet.zip',
      'kolm cert validate ./soc2-packet.zip',
    ],
    notes: 'Backed by <code>/v1/compliance/certification-packet</code>. The packet bundles audit log, SBOMs, model passports, training data lineage, and signed attestations.',
    see: [
      ['kolm sbom', '/docs/cli/sbom'],
      ['kolm passport', '/docs/cli/passport'],
      ['kolm ai-act', '/docs/cli/ai-act'],
    ],
  },
  {
    name: 'procurement',
    title: 'kolm procurement',
    desc: 'Auto-answer vendor security questionnaires (SIG Lite, CAIQ v4.0.2). Pulls answers from the procurement vault and renders to PDF/JSON.',
    usage: 'kolm procurement <sig|caiq|all> [--out <path>] [--json]',
    flags: [
      ['sig', '-', 'Render Shared Assessments SIG Lite responses.'],
      ['caiq', '-', 'Render CSA CAIQ v4.0.2 responses.'],
      ['all', '-', 'Render both packs.'],
      ['--out <path>', 'stdout', 'Destination file or directory.'],
      ['--json', 'off', 'JSON output.'],
    ],
    examples: [
      'kolm procurement sig --out ./sig-lite.pdf',
      'kolm procurement caiq --out ./caiq.json --json',
      'kolm procurement all --out ./vendor-pack/',
    ],
    notes: 'Backed by <code>/v1/procurement/sig</code>, <code>/v1/procurement/caiq</code>, <code>/v1/procurement/all</code>. Answers are sourced from <code>data/procurement/vault.json</code> and reviewed quarterly.',
    see: [
      ['kolm sbom', '/docs/cli/sbom'],
      ['kolm cert', '/docs/cli/cert'],
      ['Enterprise admin', '/account/enterprise'],
    ],
  },
  {
    name: 'poison',
    title: 'kolm poison',
    desc: 'Run model-poisoning detection on a candidate artifact. Returns axis scores for backdoor probability, weight anomaly, and trigger-pattern correlation.',
    usage: 'kolm poison detect <artifact.kolm> [--baseline <baseline.kolm>] [--json]',
    flags: [
      ['detect', '-', 'Run the poisoning detector.'],
      ['<artifact.kolm>', 'required', 'Candidate artifact.'],
      ['--baseline <baseline.kolm>', 'none', 'Compare against a known-clean baseline.'],
      ['--json', 'off', 'JSON output.'],
    ],
    examples: [
      'kolm poison detect ./out/candidate.kolm',
      'kolm poison detect ./out/candidate.kolm --baseline ./out/known-clean.kolm --json',
    ],
    notes: 'Currently uses statistical weight-distribution checks + adversarial-prompt regression. Cryptographic backdoor proof is not yet available; report is labeled <code>shape_valid</code> not <code>cryptographically_verified</code>.',
    see: [
      ['kolm redteam', '/docs/cli/redteam'],
      ['kolm verify', '/docs/cli/verify'],
    ],
  },
  {
    name: 'redteam',
    title: 'kolm redteam',
    desc: 'Run adversarial prompt suites against an artifact to surface jailbreaks, prompt injection, and policy bypass.',
    usage: 'kolm redteam <artifact.kolm> [--suite <slug>] [--out <path>] [--json]',
    flags: [
      ['<artifact.kolm>', 'required', 'Artifact under test.'],
      ['--suite <slug>', '<code>k-default</code>', '<code>k-default</code>, <code>owasp-llm-top10</code>, <code>strongreject</code>, or a path to a custom JSONL.'],
      ['--out <path>', 'stdout', 'Where to write the per-prompt report.'],
      ['--json', 'off', 'JSON output.'],
    ],
    examples: [
      'kolm redteam ./out/recipe.kolm',
      'kolm redteam ./out/recipe.kolm --suite owasp-llm-top10 --out ./redteam.json --json',
    ],
    notes: 'Suites are versioned. Results are deterministic for a given (artifact, suite) pair so CI can pin them.',
    see: [
      ['kolm poison', '/docs/cli/poison'],
      ['kolm guardrails', '/docs/cli/guardrails'],
    ],
  },
  {
    name: 'make',
    title: 'kolm make',
    desc: 'Unified pipeline verb: takes a recipe and runs distill, quantize, compile, eval, and (optionally) deploy. Like <code>make</code> for AI models.',
    usage: 'kolm make <recipe.toml> [--target <slug>] [--deploy]',
    flags: [
      ['<recipe.toml>', 'required', 'Path to the recipe file.'],
      ['--target <slug>', '<code>cuda</code>', 'Compile target. See <code>kolm compile --help</code> for the full list.'],
      ['--deploy', 'off', 'Push to the deploy hook after a green compile.'],
      ['--gate <n>', '<code>0.85</code>', 'K-Score floor for the gate.'],
    ],
    examples: [
      'kolm make ./recipes/support-bot.toml',
      'kolm make ./recipes/support-bot.toml --target metal --deploy',
    ],
    notes: 'Wrapper over <code>kolm distill</code> + <code>kolm quantize</code> + <code>kolm compile</code> + <code>kolm eval</code>. Use the explicit verbs for per-step overrides.',
    see: [
      ['kolm ship', '/docs/cli/ship'],
      ['kolm build', '/docs/cli/build'],
      ['kolm compile', '/docs/cli/compile'],
    ],
  },
  {
    name: 'ship',
    title: 'kolm ship',
    desc: 'End-to-end deploy verb: takes a recipe or artifact, runs gate checks, signs, and ships to your configured runtime.',
    usage: 'kolm ship <recipe.toml|artifact.kolm> [--target <slug>] [--region <slug>]',
    flags: [
      ['<recipe-or-artifact>', 'required', 'Recipe (will be made first) or pre-built artifact.'],
      ['--target <slug>', '<code>cuda</code>', 'Compile target.'],
      ['--region <slug>', '<code>us-east-1</code>', 'Deploy region (when shipping to managed runtime).'],
      ['--byoc', 'off', 'Ship to your BYOC cluster instead of managed runtime.'],
    ],
    examples: [
      'kolm ship ./recipes/support-bot.toml',
      'kolm ship ./out/recipe.kolm --byoc',
    ],
    notes: 'Pairs with <code>kolm make</code>. <code>ship</code> is the last-mile deploy; <code>make</code> is the build pipeline.',
    see: [
      ['kolm make', '/docs/cli/make'],
      ['kolm serve', '/docs/cli/serve'],
    ],
  },
  {
    name: 'pack',
    title: 'kolm pack',
    desc: 'Package one or more artifacts into a USB-transportable bundle for sneakernet delivery to an air-gapped host.',
    usage: 'kolm pack <artifact.kolm> [<more.kolm>...] --out <bundle.tar>',
    flags: [
      ['<artifact.kolm>', 'required', 'One or more artifacts to include.'],
      ['--out <path>', 'required', 'Output tar (USTAR format).'],
      ['--signed', 'on', 'Attach Ed25519 signatures (default on).'],
      ['--unsigned', 'off', 'Skip signing (for testing only).'],
    ],
    examples: [
      'kolm pack ./out/a.kolm ./out/b.kolm --out /media/usb/bundle.tar',
    ],
    notes: 'Pairs with <code>kolm unpack</code>. The bundle is plain USTAR + a manifest sidecar; any tar implementation can extract it.',
    see: [
      ['kolm unpack', '/docs/cli/unpack'],
      ['kolm bundle', '/docs/cli/bundle'],
      ['kolm airgap', '/docs/cli/airgap'],
    ],
  },
  {
    name: 'unpack',
    title: 'kolm unpack',
    desc: 'Unpack a sneakernet bundle produced by <code>kolm pack</code>, verifying signatures.',
    usage: 'kolm unpack <bundle.tar> [--into <dir>] [--no-verify]',
    flags: [
      ['<bundle.tar>', 'required', 'Bundle file.'],
      ['--into <dir>', '<code>~/.kolm/artifacts</code>', 'Destination directory.'],
      ['--no-verify', 'off', 'Skip signature verification (NOT recommended).'],
    ],
    examples: [
      'kolm unpack /media/usb/bundle.tar',
      'kolm unpack /media/usb/bundle.tar --into ./inbox/',
    ],
    notes: 'A failed signature check exits non-zero and leaves no files extracted.',
    see: [
      ['kolm pack', '/docs/cli/pack'],
      ['kolm verify', '/docs/cli/verify'],
    ],
  },
  {
    name: 'audio',
    title: 'kolm audio',
    desc: 'Capture and run audio through the multimodal pipeline. Whisper-class ASR + optional speaker diarization.',
    usage: 'kolm audio <capture|transcribe> <file.wav|mp3|m4a> [--language <code>]',
    flags: [
      ['capture', '-', 'Record an audio capture into the corpus.'],
      ['transcribe', '-', 'Transcribe to text without storing.'],
      ['<file>', 'required', 'Audio file (wav, mp3, m4a, ogg).'],
      ['--language <code>', 'auto', 'BCP-47 code; auto-detect when omitted.'],
    ],
    examples: [
      'kolm audio capture ./call.mp3',
      'kolm audio transcribe ./meeting.wav --language en',
    ],
    notes: 'Backed by <code>workers/audio-redact/</code>. Captures go through the redaction layer before storage.',
    see: [
      ['kolm video', '/docs/cli/video'],
      ['kolm capture', '/docs/cli/capture'],
    ],
  },
  {
    name: 'video',
    title: 'kolm video',
    desc: 'Capture and run video through the multimodal pipeline. Frame-extract + per-frame VLM analysis.',
    usage: 'kolm video <capture|extract> <file.mp4|webm> [--every <s>]',
    flags: [
      ['capture', '-', 'Record a video capture into the corpus.'],
      ['extract', '-', 'Extract frames + per-frame caption without storing.'],
      ['<file>', 'required', 'Video file.'],
      ['--every <s>', '<code>1</code>', 'Frame extraction interval in seconds.'],
    ],
    examples: [
      'kolm video capture ./demo.mp4',
      'kolm video extract ./demo.mp4 --every 5',
    ],
    notes: 'Heavy work runs in <code>workers/video-redact/</code>. Faces and license plates are redacted by default.',
    see: [
      ['kolm vlm', '/docs/cli/vlm'],
      ['kolm capture', '/docs/cli/capture'],
    ],
  },
  {
    name: 'vlm',
    title: 'kolm vlm',
    desc: 'Run a vision-language model (VLM) against an image or image set. CLIP / LLaVA / Qwen-VL backends.',
    usage: 'kolm vlm <ask|caption|embed> <image.jpg|png> [--prompt <text>] [--model <slug>]',
    flags: [
      ['ask', '-', 'Ask a question grounded in the image.'],
      ['caption', '-', 'Generate a caption.'],
      ['embed', '-', 'Produce an embedding vector.'],
      ['<image>', 'required', 'Image file.'],
      ['--prompt <text>', 'for ask', 'Question text.'],
      ['--model <slug>', 'default', 'VLM backend.'],
    ],
    examples: [
      'kolm vlm caption ./photo.jpg',
      'kolm vlm ask ./diagram.png --prompt "what does this show?"',
    ],
    notes: 'Backed by <code>workers/vlm/</code>. CPU fallback available but slow; CUDA strongly recommended.',
    see: [
      ['kolm video', '/docs/cli/video'],
      ['kolm compile', '/docs/cli/compile'],
    ],
  },
  {
    name: 'xlang',
    title: 'kolm xlang',
    desc: 'Cross-language helpers: detect, translate, and verify cross-lingual consistency in captures and evals.',
    usage: 'kolm xlang <detect|translate|verify> [<input>] [--target <code>]',
    flags: [
      ['detect', '-', 'Detect language of input text.'],
      ['translate', '-', 'Translate text to another language.'],
      ['verify', '-', 'Verify a multilingual capture set is consistent.'],
      ['<input>', 'required', 'Text, file path, or <code>-</code> for stdin.'],
      ['--target <code>', '<code>en</code>', 'BCP-47 target language code.'],
    ],
    examples: [
      'echo "bonjour" | kolm xlang detect',
      'kolm xlang translate "hello" --target fr',
    ],
    notes: 'Uses the same translation backend as the evals pipeline so capture + eval languages stay in sync.',
    see: [
      ['kolm lingual', '/docs/cli/lingual'],
      ['kolm capture', '/docs/cli/capture'],
    ],
  },
  {
    name: 'quickstart',
    title: 'kolm quickstart',
    desc: 'Interactive setup wizard. Walks new users through signup, key install, recipe scaffold, and first compile.',
    usage: 'kolm quickstart [--non-interactive] [--profile <name>]',
    flags: [
      ['--non-interactive', 'off', 'Run with reasonable defaults (signup expected to be done already).'],
      ['--profile <name>', '<code>default</code>', 'Credential profile to use.'],
    ],
    examples: [
      'kolm quickstart',
      'kolm quickstart --non-interactive',
    ],
    notes: 'Defers to <code>kolm signup</code> + <code>kolm init</code> + <code>kolm build</code> under the hood. Re-runnable; existing files are not overwritten.',
    see: [
      ['kolm signup', '/docs/cli/signup'],
      ['kolm init', '/docs/cli/init'],
      ['Quickstart guide', '/quickstart'],
    ],
  },
  {
    name: 'pubkey',
    title: 'kolm pubkey',
    desc: 'Print, export, or rotate the local Ed25519 public key used by <code>kolm attest</code>.',
    usage: 'kolm pubkey [--export <path>] [--rotate] [--json]',
    flags: [
      ['--export <path>', 'stdout', 'Write the public key to a file (PEM).'],
      ['--rotate', 'off', 'Generate a fresh keypair (existing key archived).'],
      ['--json', 'off', 'JSON envelope.'],
    ],
    examples: [
      'kolm pubkey',
      'kolm pubkey --export ./kolm.pub',
      'kolm pubkey --rotate',
    ],
    notes: 'Keys live under <code>~/.kolm/keys/</code>. Rotation archives the previous key so old signatures still verify.',
    see: [
      ['kolm attest', '/docs/cli/attest'],
      ['kolm verify', '/docs/cli/verify'],
    ],
  },
  {
    name: 'shell-init',
    title: 'kolm shell-init',
    desc: 'Print shell-init snippet (PATH, completion, env) for sourcing in <code>~/.bashrc</code> / <code>~/.zshrc</code> / Fish config.',
    usage: 'kolm shell-init [--shell <bash|zsh|fish|powershell>]',
    flags: [
      ['--shell <slug>', 'auto', 'Target shell. Auto-detect when omitted.'],
    ],
    examples: [
      'kolm shell-init',
      'kolm shell-init --shell zsh >> ~/.zshrc',
    ],
    notes: 'For an interactive installer use <code>kolm setup</code>. For completion-only output use <code>kolm completion</code>.',
    see: [
      ['kolm setup', '/docs/cli/setup'],
      ['kolm completion', '/docs/cli/completion'],
    ],
  },
  {
    name: 'attest',
    title: 'kolm attest',
    desc: 'Sign an artifact or document with the local Ed25519 keypair. Produces a sidecar <code>.sig</code> verifiable by <code>kolm verify</code>.',
    usage: 'kolm attest <file> [--key <path>] [--out <path.sig>]',
    flags: [
      ['<file>', 'required', 'File to sign.'],
      ['--key <path>', '<code>~/.kolm/keys/ed25519</code>', 'Private key path.'],
      ['--out <path.sig>', '<code>&lt;file&gt;.sig</code>', 'Where to write the signature.'],
    ],
    examples: [
      'kolm attest ./out/recipe.kolm',
      'kolm attest ./out/audit.cef --out ./audit.sig',
    ],
    notes: 'Pair with <code>kolm pubkey</code> to publish your verification key. Sigstore integration is available via <code>kolm sigstore-attest</code>.',
    see: [
      ['kolm verify', '/docs/cli/verify'],
      ['kolm sigstore-attest', '/docs/cli/sigstore-attest'],
      ['kolm pubkey', '/docs/cli/pubkey'],
    ],
  },
  {
    name: 'setup',
    title: 'kolm setup',
    desc: 'Set up shell integrations: completion, aliases, environment helpers.',
    usage: 'kolm setup [--shell <bash|zsh|fish|powershell>] [--alias]',
    flags: [
      ['--shell <slug>', 'auto', 'Target shell. Auto-detected when omitted.'],
      ['--alias', 'off', 'Install convenience aliases (<code>k</code>, <code>kc</code>, <code>kr</code>).'],
    ],
    examples: [
      'kolm setup',
      'kolm setup --shell zsh --alias',
    ],
    notes: 'Idempotent. Re-running upgrades the installed snippet in place. Use <code>kolm completion</code> for one-shot completion script output.',
    see: [
      ['kolm bootstrap', '/docs/cli/bootstrap'],
      ['kolm completion', '/docs/cli/completion'],
      ['kolm shell-init', '/docs/cli/shell-init'],
    ],
  },
  {
    name: 'model-card',
    title: 'kolm model-card',
    desc: 'Render a HuggingFace-style MODEL_CARD.md for an artifact.',
    usage: 'kolm model-card <artifact.kolm> [--out <path>]',
    flags: [
      ['<artifact.kolm>', 'required', 'Artifact to describe.'],
      ['--out <path>', 'stdout', 'Destination file.'],
    ],
    examples: [
      'kolm model-card ./out/recipe.kolm --out MODEL_CARD.md',
    ],
    notes: 'Covers intended use, training data, evals, base model attribution, license, and limitations. For compliance-oriented review packs use <code>kolm passport export --format compliance</code> instead.',
    see: [
      ['kolm passport', '/docs/cli/passport'],
      ['kolm sbom', '/docs/cli/sbom'],
    ],
  },
  {
    name: 'guardrails',
    title: 'kolm guardrails',
    desc: 'Compile, test, and ship guardrails (input/output filters, policy bundles) that bind to artifacts.',
    usage: 'kolm guardrails <list|compile|test|attach> [flags]',
    flags: [
      ['list', '-', 'List built-in guardrail packs.'],
      ['compile', '-', 'Compile a guardrail spec (YAML/JSON) to a runtime filter.'],
      ['test', '-', 'Run a guardrail against a prompt set.'],
      ['attach', '-', 'Attach a compiled guardrail to an artifact.'],
    ],
    examples: [
      'kolm guardrails list',
      'kolm guardrails compile ./guardrails/pii.yaml --out pii.kgr',
      'kolm guardrails attach ./out/recipe.kolm --rail pii.kgr',
    ],
    notes: 'Guardrails are versioned alongside artifacts. Verification covers both content (the policy) and binding (the artifact-rail signature).',
    see: [
      ['kolm redteam', '/docs/cli/redteam'],
      ['kolm verify', '/docs/cli/verify'],
    ],
  },
  {
    name: 'wizard',
    title: 'kolm wizard',
    desc: 'Interactive wizards: compile, distill, deploy. Walks step-by-step with sensible defaults and validation at each step.',
    usage: 'kolm wizard <compile|distill|deploy>',
    flags: [
      ['compile', '-', 'Compile wizard. Same flow as <code>/studio/compile</code>.'],
      ['distill', '-', 'Distillation wizard.'],
      ['deploy', '-', 'Deployment wizard (cloud + BYOC).'],
    ],
    examples: [
      'kolm wizard compile',
    ],
    notes: 'Wizards are TTY-only. For scripts use the underlying verb directly (e.g. <code>kolm compile</code>) with explicit flags.',
    see: [
      ['kolm studio', '/docs/cli/studio'],
      ['kolm compile', '/docs/cli/compile'],
      ['kolm tui', '/docs/cli/tui'],
    ],
  },
  {
    name: 'lingual',
    title: 'kolm lingual',
    desc: 'Multilingual capture, translation, and language-stratified evaluation helpers.',
    usage: 'kolm lingual <detect|stratify|eval> [flags]',
    flags: [
      ['detect', '-', 'Detect language of a capture or file.'],
      ['stratify', '-', 'Stratify a dataset by language (for per-language evals).'],
      ['eval', '-', 'Run a language-stratified evaluation against an artifact.'],
    ],
    examples: [
      'kolm lingual stratify ./dataset.jsonl --out ./stratified/',
      'kolm lingual eval ./out/recipe.kolm --dataset ./stratified/fr.jsonl',
    ],
    notes: 'Use with <code>kolm xlang</code> for translation and cross-lingual verification.',
    see: [
      ['kolm xlang', '/docs/cli/xlang'],
      ['kolm eval', '/docs/cli/eval'],
    ],
  },
  {
    name: 'bootstrap',
    title: 'kolm bootstrap',
    desc: 'Bootstrap a fresh cluster or container with the kolm runtime + a starter set of artifacts.',
    usage: 'kolm bootstrap [--with-artifacts] [--with-models] [--out <dir>]',
    flags: [
      ['--with-artifacts', 'off', 'Include a starter set of community artifacts.'],
      ['--with-models', 'off', 'Pre-pull common base models (large download).'],
      ['--out <dir>', '<code>~/.kolm</code>', 'Bootstrap target directory.'],
    ],
    examples: [
      'kolm bootstrap',
      'kolm bootstrap --with-artifacts --with-models',
    ],
    notes: 'Idempotent. Safe to re-run on an existing install — files are added but never overwritten.',
    see: [
      ['kolm init', '/docs/cli/init'],
      ['kolm setup', '/docs/cli/setup'],
    ],
  },
];

function render(v) {
  const flagsRows = v.flags.map((f) => `<tr><td><code>${f[0]}</code></td><td>${f[1]}</td><td>${f[2]}</td></tr>`).join('\n');
  const examplesBlock = v.examples.map((e) => e.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('\n');
  const seeBlock = v.see.map((s) => `<li><a href="${s[1]}">${s[0]}</a></li>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<script>(function(){try{var t=localStorage.getItem('kolm-theme');if(t==='light'){document.documentElement.setAttribute('data-theme','light');document.documentElement.style.background='#f7f4ec';document.documentElement.style.colorScheme='light';}}catch(e){}})();</script>
<title>${v.title} | CLI reference | kolm.ai</title>
<meta name="description" content="${v.desc.replace(/<[^>]+>/g, '').replace(/"/g, '&quot;')}">
<link rel="canonical" href="https://kolm.ai/docs/cli/${v.name}">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/surface-polish.css">
<script src="/nav.js" defer></script>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"TechArticle","headline":"${v.title}","description":"${v.desc.replace(/<[^>]+>/g, '').replace(/"/g, '\\"')}","url":"https://kolm.ai/docs/cli/${v.name}","author":{"@type":"Organization","name":"kolm.ai"}}
</script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>

<main id="main" class="docs-main" data-w401f="cli-verb" data-verb="${v.name}">
<nav aria-label="Breadcrumb" class="crumbs"><a href="/docs">Docs</a> / <a href="/docs/cli">CLI</a> / <span>${v.name}</span></nav>
<h1>${v.title}</h1>
<blockquote><p>${v.desc}</p></blockquote>

<h2>Usage</h2>
<pre><code>${v.usage.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>

<h2>Flags</h2>
<table>
<thead><tr><th>Flag</th><th>Default</th><th>Description</th></tr></thead>
<tbody>
${flagsRows}
</tbody>
</table>

<h2>Examples</h2>
<pre><code>${examplesBlock}</code></pre>

<h2>Notes</h2>
<p>${v.notes}</p>

<h2>See also</h2>
<ul>
${seeBlock}
<li><a href="/docs/cli">All CLI verbs</a></li>
</ul>

</main>

</body>
</html>
`;
}

let wrote = 0, skipped = 0;
for (const v of verbs) {
  const p = path.join(outDir, `${v.name}.html`);
  if (fs.existsSync(p)) { skipped++; continue; }
  fs.writeFileSync(p, render(v));
  wrote++;
}
console.log(`write-w869-cli-docs: wrote=${wrote} skipped-existing=${skipped} total=${verbs.length}`);
