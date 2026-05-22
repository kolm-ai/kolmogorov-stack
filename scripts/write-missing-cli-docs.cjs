#!/usr/bin/env node
// Generates the 29 missing CLI doc pages at public/docs/cli/.
// Uses a single ks.css template, one per verb.

const fs = require('fs');
const path = require('path');

const outDir = path.resolve(__dirname, '..', 'public', 'docs', 'cli');

const verbs = [
  {
    name: 'signup',
    title: 'kolm signup',
    desc: 'Create a tenant and API key from the CLI. The same flow as /signup on the web.',
    usage: 'kolm signup [--email <addr>] [--namespace <n>] [--json]',
    flags: [
      ['--email <addr>', 'autofill', 'Email address. Prompted if not passed and stdin is a TTY.'],
      ['--namespace <n>', 'default', 'Starting namespace for the new tenant.'],
      ['--json', 'off', 'Print the result as JSON instead of human text.'],
    ],
    examples: [
      'kolm signup',
      'kolm signup --email alice@acme.com --namespace inbox',
      'kolm signup --json | jq -r .api_key | kolm login --token -',
    ],
    notes: 'Posts to <code>/v1/signup</code> and writes the returned API key to <code>~/.kolm/credentials</code>. The route is public and rate-limited 10/IP/24h. If you already have a key, prefer <code>kolm login</code>.',
    see: [['kolm login', '/docs/cli/login'], ['kolm whoami', '/docs/cli/whoami'], ['Quickstart', '/quickstart']],
  },
  {
    name: 'login',
    title: 'kolm login',
    desc: 'Save an existing API key to your local credentials store.',
    usage: 'kolm login [--token <ks_...>] [--from-env] [--profile <name>]',
    flags: [
      ['--token <ks_...>', 'prompt', 'API key to save. Use <code>-</code> to read from stdin.'],
      ['--from-env', 'off', 'Read <code>KOLM_API_KEY</code> from environment.'],
      ['--profile <name>', 'default', 'Save under a named profile.'],
    ],
    examples: [
      'kolm login',
      'kolm login --token ks_4b7bc3b...',
      'echo $KOLM_API_KEY | kolm login --token -',
      'kolm login --from-env --profile prod',
    ],
    notes: 'Validates the key by calling <code>/v1/whoami</code> before saving. A rejected key exits non-zero and never writes to disk.',
    see: [['kolm whoami', '/docs/cli/whoami'], ['kolm signup', '/docs/cli/signup'], ['kolm logout', '/docs/cli/logout']],
  },
  {
    name: 'init',
    title: 'kolm init',
    desc: 'Initialize a project directory with a kolm.toml and a starter recipe.',
    usage: 'kolm init [--template <name>] [--namespace <n>]',
    flags: [
      ['--template <name>', '<code>blank</code>', 'Starter: <code>blank</code>, <code>distill</code>, <code>compile</code>, <code>capture-only</code>.'],
      ['--namespace <n>', '<code>default</code>', 'Namespace recorded into kolm.toml.'],
    ],
    examples: [
      'kolm init',
      'kolm init --template distill --namespace inbox',
    ],
    notes: 'Refuses to overwrite an existing kolm.toml unless <code>--force</code> is passed. Run <code>kolm new</code> for a one-off file scaffold inside an existing project.',
    see: [['kolm new', '/docs/cli/new'], ['kolm build', '/docs/cli/build']],
  },
  {
    name: 'new',
    title: 'kolm new',
    desc: 'Scaffold a new recipe, dataset, or eval file inside an existing project.',
    usage: 'kolm new <kind> [name] [--from <template>]',
    flags: [
      ['&lt;kind&gt;', 'required', 'One of <code>recipe</code>, <code>dataset</code>, <code>eval</code>, <code>connector</code>.'],
      ['name', 'auto', 'File name. Auto-derived from kind when omitted.'],
      ['--from <template>', 'kind default', 'Template to copy from.'],
    ],
    examples: [
      'kolm new recipe distill-inbox',
      'kolm new dataset gold-200',
      'kolm new eval frozen-eval --from k-score-classic',
    ],
    notes: 'Templates live under <code>~/.kolm/templates</code>. The list is printed by <code>kolm new --list</code>.',
    see: [['kolm init', '/docs/cli/init'], ['kolm build', '/docs/cli/build']],
  },
  {
    name: 'build',
    title: 'kolm build',
    desc: 'High-level alias that runs the full distill + quantize + compile loop from a kolm.toml recipe.',
    usage: 'kolm build [--target <cuda|rocm|metal|cpu|wasm|c|rust>] [--out <path>]',
    flags: [
      ['--target <t>', '<code>cuda</code>', 'Runtime target the final artifact compiles for.'],
      ['--out <path>', '<code>./out/</code>', 'Output directory for the <code>.kolm</code> artifact.'],
      ['--no-cache', 'off', 'Re-run every step even if cached.'],
    ],
    examples: [
      'kolm build',
      'kolm build --target metal --out ./mac.kolm',
      'kolm build --target wasm --out ./web.kolm',
    ],
    notes: '<code>kolm build</code> is a thin wrapper over <code>kolm distill</code> + <code>kolm quantize</code> + <code>kolm compile</code>. Use the explicit verbs when you want step-level control or a k-score override.',
    see: [['kolm compile', '/docs/cli/compile'], ['kolm distill', '/docs/cli/distill'], ['kolm train', '/docs/cli/train']],
  },
  {
    name: 'train',
    title: 'kolm train',
    desc: 'Run a training loop from captured data. Alias for <code>kolm distill from-captures</code> with sensible defaults.',
    usage: 'kolm train [--teacher <id>] [--student <id>] [--since <window>] [--namespace <n>]',
    flags: [
      ['--teacher <id>', 'auto', 'Teacher model. Defaults to the highest-k-score available teacher.'],
      ['--student <id>', 'auto', 'Student model. Defaults to the smallest student that fits the eval.'],
      ['--since <window>', '<code>7d</code>', 'Captures window: <code>24h</code>, <code>7d</code>, <code>30d</code>, or ISO range.'],
      ['--namespace <n>', '<code>default</code>', 'Capture namespace to draw rows from.'],
      ['--resume <run_id|auto>', 'off', 'Resume an interrupted run.'],
    ],
    examples: [
      'kolm train',
      'kolm train --teacher claude-sonnet-4-6 --student qwen2.5-3b-instruct',
      'kolm train --namespace inbox --since 24h --resume auto',
    ],
    notes: 'Writes checkpoints to <code>~/.kolm/runs/&lt;run_id&gt;</code> with a row per step. Fail over to a backup teacher is on by default. See <code>kolm distill</code> for the lower-level surface.',
    see: [['kolm distill', '/docs/cli/distill'], ['kolm compile', '/docs/cli/compile']],
  },
  {
    name: 'trace',
    title: 'kolm trace',
    desc: 'Record an agent trace and (optionally) compile it into a deterministic replay artifact.',
    usage: 'kolm trace <capture|compile|verify|list> [trace_id] [--namespace <n>]',
    flags: [
      ['capture', 'sub', 'Start a recorder for the next agent run.'],
      ['compile <trace_id>', 'sub', 'Compile a recorded trace into a replay artifact.'],
      ['verify <trace_id>', 'sub', 'Replay a compiled trace and assert identical output.'],
      ['list', 'sub', 'List traces in the current namespace.'],
    ],
    examples: [
      'kolm trace capture --namespace shopper',
      'kolm trace list --namespace shopper',
      'kolm trace compile tr_8f3a1e2c',
      'kolm trace verify tr_8f3a1e2c',
    ],
    notes: 'Traces are tenant-fenced. A foreign trace fails loud with <code>403 tenant_mismatch</code>. Compiled traces are deterministic: same input, same output, no LLM call needed.',
    see: [['kolm ir', '/docs/cli/ir'], ['kolm verify', '/docs/cli/verify']],
  },
  {
    name: 'ir',
    title: 'kolm ir',
    desc: 'Inspect, lint, or compile a workflow IR (the JSON intermediate that <code>kolm trace compile</code> writes).',
    usage: 'kolm ir <dump|lint|compile> <ir_path>',
    flags: [
      ['dump <path>', 'sub', 'Pretty-print the IR.'],
      ['lint <path>', 'sub', 'Lint the IR for invalid op shapes or dangling edges.'],
      ['compile <path>', 'sub', 'Compile the IR into a runnable workflow.'],
    ],
    examples: [
      'kolm ir dump ~/.kolm/traces/tr_8f3a1e2c.ir.json',
      'kolm ir lint ./shopper.ir.json',
      'kolm ir compile ./shopper.ir.json --out shopper.kolm-workflow',
    ],
    notes: 'IR is plain JSON. You can hand-edit it. <code>kolm ir lint</code> catches the common mistakes (missing seed, dangling op, no terminal node).',
    see: [['kolm trace', '/docs/cli/trace']],
  },
  {
    name: 'cc',
    title: 'kolm cc',
    desc: 'Confidential-compute attestation helpers (Intel SGX/TDX, AMD SEV-SNP, AWS Nitro, NVIDIA NRAS).',
    usage: 'kolm cc <attest|verify|embed> [--kind <pccs|snp-report|nitro-attestation|nras>]',
    flags: [
      ['attest', 'sub', 'Fetch an attestation report from the current host enclave.'],
      ['verify <report>', 'sub', 'Verify an attestation report.'],
      ['embed <artifact>', 'sub', 'Embed an attestation report into a <code>.kolm</code> artifact.'],
    ],
    examples: [
      'kolm cc attest --kind snp-report --out ./snp.json',
      'kolm cc verify ./snp.json --kind snp-report',
      'kolm cc embed ./inbox-router.kolm --report ./snp.json --kind snp-report',
    ],
    notes: 'Embedded reports bind into the artifact hash. A post-build tamper makes the receipt invalid. Default state is <code>shape_ok + verified:false</code> until a tenant registers a crypto verifier via <code>registerAttestationVerifier</code>.',
    see: [['kolm verify', '/docs/cli/verify'], ['kolm compile', '/docs/cli/compile']],
  },
  {
    name: 'fl',
    title: 'kolm fl',
    desc: 'Federated learning helpers (per-tenant gradient aggregation across an opt-in mesh).',
    usage: 'kolm fl <opt-in|opt-out|peers|round|status>',
    flags: [
      ['opt-in', 'sub', 'Opt this tenant into the gradient mesh.'],
      ['opt-out', 'sub', 'Opt out. Existing aggregates are not deleted.'],
      ['peers', 'sub', 'List opted-in peers.'],
      ['round <recipe>', 'sub', 'Run one federated round for the named recipe.'],
      ['status', 'sub', 'Show the last round status.'],
    ],
    examples: [
      'kolm fl opt-in',
      'kolm fl peers',
      'kolm fl round inbox-router-recipe.toml',
    ],
    notes: 'Gradients are noised (DP-SGD, &epsilon;=1.0) and only aggregates ever cross a tenant boundary. See <code>kolm federated</code> for the approval-row side.',
    see: [['kolm federated', '/docs/cli/federated']],
  },
  {
    name: 'federated',
    title: 'kolm federated',
    desc: 'Decision-aggregation federation: share hash-only approval rows across opted-in tenants. Distinct from gradient federation in <code>kolm fl</code>.',
    usage: 'kolm federated <opt-in|opt-out|peers|share|aggregate|audit>',
    flags: [
      ['opt-in', 'sub', 'Opt this tenant in.'],
      ['opt-out', 'sub', 'Opt out.'],
      ['peers', 'sub', 'List federated peers.'],
      ['share', 'sub', 'Share approval-row hashes (never raw input/output).'],
      ['aggregate', 'sub', 'Pull noised per-decision counts from peers.'],
      ['audit', 'sub', 'Show the federation audit log.'],
    ],
    examples: [
      'kolm federated opt-in',
      'kolm federated share --namespace inbox',
      'kolm federated aggregate --namespace inbox',
    ],
    notes: 'Approval hashes are <code>sha256(namespace+input+decision)</code>. Aggregates use Laplace noise &epsilon;=1.0. Raw text never leaves your tenant boundary.',
    see: [['kolm fl', '/docs/cli/fl']],
  },
  {
    name: 'compute',
    title: 'kolm compute',
    desc: 'Rent and manage compute pools (RunPod, Lambda, CoreWeave, your own).',
    usage: 'kolm compute <providers|rent|list|stop|logs>',
    flags: [
      ['providers', 'sub', 'List available compute providers.'],
      ['rent --gpu <id>', 'sub', 'Rent a GPU. E.g. <code>5090</code>, <code>h100</code>, <code>a100-80g</code>.'],
      ['list', 'sub', 'List active rentals.'],
      ['stop <rental_id>', 'sub', 'Stop a rental.'],
      ['logs <rental_id>', 'sub', 'Tail the worker log.'],
    ],
    examples: [
      'kolm compute providers',
      'kolm compute rent --gpu 5090 --hours 4',
      'kolm compute list',
    ],
    notes: 'Rentals are billed per second. <code>kolm compute stop</code> teardown is idempotent. Provider credentials live in <code>~/.kolm/credentials</code> under per-provider sections.',
    see: [['kolm gpu', '/docs/cli/gpu']],
  },
  {
    name: 'auditor',
    title: 'kolm auditor',
    desc: 'Generate and rotate auditor keys for the receipt-signing pipeline.',
    usage: 'kolm auditor <keygen|rotate|list|publish>',
    flags: [
      ['keygen', 'sub', 'Generate a fresh Ed25519 auditor keypair.'],
      ['rotate', 'sub', 'Rotate the active auditor key.'],
      ['list', 'sub', 'List local auditor keys.'],
      ['publish', 'sub', 'Publish the public auditor key to <code>pki.kolm.ai</code>.'],
    ],
    examples: [
      'kolm auditor keygen',
      'kolm auditor list',
      'kolm auditor publish --name acme-prod',
    ],
    notes: 'Auditor keys are independent of tenant API keys. They sign receipts that a third party can verify offline against <code>pki.kolm.ai</code>.',
    see: [['kolm sigstore-attest', '/docs/cli/sigstore-attest'], ['kolm verify', '/docs/cli/verify']],
  },
  {
    name: 'sigstore-attest',
    title: 'kolm sigstore-attest',
    desc: 'Generate a Sigstore + in-toto attestation for a <code>.kolm</code> artifact.',
    usage: 'kolm sigstore-attest <artifact> [--bundle <out.bundle>]',
    flags: [
      ['<artifact>', 'required', 'Path to a <code>.kolm</code> file.'],
      ['--bundle <out>', '<code>artifact.bundle</code>', 'Output bundle path.'],
    ],
    examples: [
      'kolm sigstore-attest ./inbox-router.kolm',
      'kolm sigstore-attest ./inbox-router.kolm --bundle ./router.bundle',
    ],
    notes: 'Bundle is OIDC-signed via Fulcio. Verify with <code>cosign verify-blob --bundle &lt;bundle&gt; &lt;artifact&gt;</code>.',
    see: [['kolm auditor', '/docs/cli/auditor'], ['kolm verify', '/docs/cli/verify']],
  },
  {
    name: 'anonymize',
    title: 'kolm anonymize',
    desc: 'Anonymize a dataset or capture log in place: PII redact + voiceprint scrub + image PII mask.',
    usage: 'kolm anonymize <path> [--strength <0..1>] [--modalities <list>]',
    flags: [
      ['<path>', 'required', 'Dataset, capture log, or directory.'],
      ['--strength <0..1>', '<code>0.5</code>', 'Anonymizer strength (voiceprint/image only).'],
      ['--modalities <list>', '<code>text,image,audio</code>', 'Comma-separated modalities to process.'],
    ],
    examples: [
      'kolm anonymize ./inbox-captures.jsonl',
      'kolm anonymize ./voice-samples/ --modalities audio --strength 0.7',
    ],
    notes: 'Refuses to run if a detector is missing for a requested modality. Use <code>kolm media doctor</code> to see which detectors are installed.',
    see: [['kolm media (image|audio) doctor', '/docs/cli']],
  },
  {
    name: 'improve',
    title: 'kolm improve',
    desc: 'One-shot loop: capture recent traffic, distill, quantize, compile, and replace the active artifact if k-score does not regress.',
    usage: 'kolm improve [--namespace <n>] [--since <window>]',
    flags: [
      ['--namespace <n>', '<code>default</code>', 'Namespace to capture and target.'],
      ['--since <window>', '<code>7d</code>', 'Window of recent captures.'],
      ['--dry-run', 'off', 'Run every step but do not promote the new artifact.'],
    ],
    examples: [
      'kolm improve',
      'kolm improve --namespace inbox --since 24h --dry-run',
    ],
    notes: 'Refuses to promote on k-score regression. Override with <code>--i-accept-regression</code> + <code>--reason</code>, logged to the audit log.',
    see: [['kolm train', '/docs/cli/train'], ['kolm compile', '/docs/cli/compile']],
  },
  {
    name: 'instant',
    title: 'kolm instant',
    desc: 'Run an artifact against a single prompt without spinning up a runtime server.',
    usage: 'kolm instant <artifact> <prompt> [--system <text>]',
    flags: [
      ['<artifact>', 'required', 'Path to a <code>.kolm</code> file.'],
      ['<prompt>', 'required', 'Prompt text. Use <code>-</code> for stdin.'],
      ['--system <text>', 'off', 'System message.'],
      ['--json', 'off', 'Output as JSON instead of plain text.'],
    ],
    examples: [
      'kolm instant ./inbox-router.kolm "route this support email about a refund"',
      'echo "summarize this" | kolm instant ./summary.kolm -',
    ],
    notes: 'In-process, no network. Good for CI smoke tests and one-off prompts. For sustained throughput use <code>kolm runtime serve</code>.',
    see: [['kolm runtime', '/docs/cli/runtime'], ['kolm verify', '/docs/cli/verify']],
  },
  {
    name: 'gpu',
    title: 'kolm gpu',
    desc: 'Inspect local GPUs and recommend a compile target.',
    usage: 'kolm gpu [list|recommend|test]',
    flags: [
      ['list', 'sub', 'List visible GPUs.'],
      ['recommend', 'sub', 'Recommend a compile target for the best GPU.'],
      ['test', 'sub', 'Run a quick INT4 matmul against each GPU.'],
    ],
    examples: [
      'kolm gpu list',
      'kolm gpu recommend',
      'kolm gpu test',
    ],
    notes: 'Reads CUDA, ROCm, and Metal device info. Falls back to CPU on hosts with no accelerator.',
    see: [['kolm compute', '/docs/cli/compute'], ['kolm compile', '/docs/cli/compile']],
  },
  {
    name: 'hub',
    title: 'kolm hub',
    desc: 'Talk to the public artifact hub: search, pull, publish, star.',
    usage: 'kolm hub <search|pull|publish|star|list>',
    flags: [
      ['search <q>', 'sub', 'Search the public hub.'],
      ['pull <slug>', 'sub', 'Pull an artifact by slug, e.g. <code>kolm/qwen-distill</code>.'],
      ['publish <artifact>', 'sub', 'Publish an artifact to your namespace.'],
      ['star <slug>', 'sub', 'Star an artifact.'],
      ['list', 'sub', 'List your published artifacts.'],
    ],
    examples: [
      'kolm hub search redactor',
      'kolm hub pull kolm/phi-redactor',
      'kolm hub publish ./my-router.kolm --as acme/inbox-router',
    ],
    notes: 'The public hub is opt-in. Private artifacts stay in your private registry. See <code>kolm registry</code>.',
    see: [['kolm pull', '/docs/cli/pull'], ['kolm registry', '/docs/cli/registry']],
  },
  {
    name: 'pull',
    title: 'kolm pull',
    desc: 'Pull an artifact from a registry into the local artifact cache.',
    usage: 'kolm pull <slug> [--registry <url>] [--out <path>]',
    flags: [
      ['<slug>', 'required', 'Artifact slug, e.g. <code>acme/inbox-router:1.4.0</code>.'],
      ['--registry <url>', 'public hub', 'Registry URL.'],
      ['--out <path>', '<code>~/.kolm/artifacts/</code>', 'Destination directory.'],
    ],
    examples: [
      'kolm pull kolm/phi-redactor',
      'kolm pull acme/inbox-router:1.4.0 --registry registry.acme.internal',
    ],
    notes: 'Hash and signature are verified before the file is written to disk. A failed verify exits non-zero and leaves no partial file.',
    see: [['kolm hub', '/docs/cli/hub'], ['kolm verify', '/docs/cli/verify']],
  },
  {
    name: 'score',
    title: 'kolm score',
    desc: 'Compute k-score for a row, file, or live capture stream.',
    usage: 'kolm score <row|file|stream> [args]',
    flags: [
      ['row <json>', 'sub', 'Score a single JSON row from stdin or a literal.'],
      ['file <path>', 'sub', 'Score every row in a JSONL file.'],
      ['stream', 'sub', 'Score the live capture SSE stream.'],
    ],
    examples: [
      'echo \'{"input":"hi","output":"hello"}\' | kolm score row -',
      'kolm score file ./inbox-eval.jsonl',
      'kolm score stream --namespace inbox',
    ],
    notes: 'k-score is a 0&ndash;100 composite of exact-match, semantic, latency, cost, and PII leak. Spec lives at <a href="/k-score">/k-score</a>.',
    see: [['k-score spec', '/k-score']],
  },
  {
    name: 'export',
    title: 'kolm export',
    desc: 'Export captures, datasets, artifacts, or audit log as JSONL or tar.',
    usage: 'kolm export <captures|datasets|artifacts|audit> [--since <window>] [--out <path>]',
    flags: [
      ['captures', 'sub', 'Export the capture log.'],
      ['datasets', 'sub', 'Export every dataset in the namespace.'],
      ['artifacts', 'sub', 'Export <code>.kolm</code> artifacts.'],
      ['audit', 'sub', 'Export the audit log.'],
      ['--since <window>', '<code>30d</code>', 'Optional time window.'],
      ['--out <path>', 'stdout', 'Output file or directory.'],
    ],
    examples: [
      'kolm export captures --since 7d --out ./inbox-7d.jsonl',
      'kolm export audit --since 30d',
    ],
    notes: 'Tenant-fenced. Exports never include another tenant\'s rows even if a credential is misconfigured.',
    see: [['kolm diff', '/docs/cli/diff']],
  },
  {
    name: 'diff',
    title: 'kolm diff',
    desc: 'Diff two artifacts, two capture exports, or two eval runs.',
    usage: 'kolm diff <a> <b> [--kind <artifacts|captures|evals>]',
    flags: [
      ['<a> <b>', 'required', 'Two paths to compare.'],
      ['--kind <k>', 'auto', 'Auto-detected from extension. Force with this flag.'],
    ],
    examples: [
      'kolm diff ./v1.kolm ./v2.kolm',
      'kolm diff ./eval-friday.jsonl ./eval-monday.jsonl --kind evals',
    ],
    notes: 'For artifacts, diff prints metadata + k-score delta + size delta. For evals, prints per-prompt delta and aggregate regression. Exit 1 on regression.',
    see: [['kolm export', '/docs/cli/export']],
  },
  {
    name: 'surfaces',
    title: 'kolm surfaces',
    desc: 'Smoke-test every documented HTTP route, CLI verb, SDK call, and TUI view in one pass.',
    usage: 'kolm surfaces [--deep] [--json]',
    flags: [
      ['--deep', 'off', 'Hit every documented route with a real request, not just an OPTIONS check.'],
      ['--json', 'off', 'Print machine-readable results.'],
    ],
    examples: [
      'kolm surfaces',
      'kolm surfaces --deep',
      'kolm surfaces --json | jq .summary',
    ],
    notes: 'Surfaces is the same check that runs in release-verify gate #6. Use it before a deploy or after a config change.',
    see: [['kolm doctor', '/docs/cli/doctor']],
  },
  {
    name: 'airgap',
    title: 'kolm airgap',
    desc: 'Air-gapped install helpers: bundle, restore, verify-no-network.',
    usage: 'kolm airgap <bundle|restore|verify-no-network>',
    flags: [
      ['bundle', 'sub', 'Bundle a kolm install + artifacts into a single tar for transfer.'],
      ['restore <tar>', 'sub', 'Restore an air-gap bundle on the target host.'],
      ['verify-no-network', 'sub', 'Sniff outgoing connections during a runtime serve. Fails on any phone-home.'],
    ],
    examples: [
      'kolm airgap bundle --include-runtime --out ./acme-airgap.tar',
      'kolm airgap restore ./acme-airgap.tar',
      'kolm airgap verify-no-network --artifact ./inbox.kolm --duration 60s',
    ],
    notes: 'Tested green against the public release: 0 outbound calls during a 60-second serve. See <a href="/airgap">/airgap</a> for the full deployment story.',
    see: [['kolm runtime', '/docs/cli/runtime']],
  },
  {
    name: 'device',
    title: 'kolm device',
    desc: 'Pair, list, and run on a paired device (phone, edge box, embedded board).',
    usage: 'kolm device <pair|list|push|run> [args]',
    flags: [
      ['pair', 'sub', 'Pair a new device. Prints a 6-digit code.'],
      ['list', 'sub', 'List paired devices.'],
      ['push <artifact> <device>', 'sub', 'Push an artifact to a paired device.'],
      ['run <device> <prompt>', 'sub', 'Run a prompt on a device.'],
    ],
    examples: [
      'kolm device pair',
      'kolm device list',
      'kolm device push ./mobile.kolm phone-rod',
      'kolm device run phone-rod "summarize my unread mail"',
    ],
    notes: 'Pairing uses an Ed25519 challenge over the kolm tunnel. Devices stay tenant-fenced. See <code>kolm devices</code> for the plural surface.',
    see: [['kolm devices', '/docs/cli/devices'], ['kolm tunnel', '/docs/cli/tunnel']],
  },
  {
    name: 'devices',
    title: 'kolm devices',
    desc: 'Manage device fleets in bulk (group, tag, broadcast).',
    usage: 'kolm devices <list|group|tag|broadcast>',
    flags: [
      ['list', 'sub', 'List all paired devices.'],
      ['group <name> <device...>', 'sub', 'Create a device group.'],
      ['tag <device> <tag>', 'sub', 'Tag a device.'],
      ['broadcast <group> <artifact>', 'sub', 'Push an artifact to every device in a group.'],
    ],
    examples: [
      'kolm devices list',
      'kolm devices group floor-1 phone-alice phone-bob',
      'kolm devices broadcast floor-1 ./mobile.kolm',
    ],
    notes: 'Broadcast is sequential by default. Pass <code>--parallel</code> to push in parallel up to a soft cap.',
    see: [['kolm device', '/docs/cli/device']],
  },
  {
    name: 'tunnel',
    title: 'kolm tunnel',
    desc: 'Open a secure tunnel from a paired device to a kolm runtime running on your laptop or a VPC box.',
    usage: 'kolm tunnel <open|list|close>',
    flags: [
      ['open <device>', 'sub', 'Open a tunnel to the named device.'],
      ['list', 'sub', 'List active tunnels.'],
      ['close <tunnel_id>', 'sub', 'Close a tunnel.'],
    ],
    examples: [
      'kolm tunnel open phone-rod',
      'kolm tunnel list',
      'kolm tunnel close t_8f3a',
    ],
    notes: 'Tunnels are Ed25519-mutually-authed. No NAT punch-through, no phone-home. Tear down with Ctrl-C or <code>kolm tunnel close</code>.',
    see: [['kolm device', '/docs/cli/device']],
  },
  {
    name: 'version',
    title: 'kolm version',
    desc: 'Print kolm CLI version, runtime version, and recent release notes.',
    usage: 'kolm version [--json]',
    flags: [
      ['--json', 'off', 'Print machine-readable JSON.'],
    ],
    examples: [
      'kolm version',
      'kolm version --json | jq .cli',
    ],
    notes: 'The CLI version, the runtime version, the registry version, and the public release date are all returned. <code>kolm update</code> uses this to decide whether to nudge.',
    see: [['kolm update', '/docs/cli/update'], ['kolm upgrade', '/docs/cli/upgrade']],
  },
  {
    name: 'update',
    title: 'kolm update',
    desc: 'Update the kolm CLI in place. Refuses to update from inside a repo clone.',
    usage: 'kolm update [--channel <stable|nightly>]',
    flags: [
      ['--channel <c>', '<code>stable</code>', 'Release channel.'],
      ['--check', 'off', 'Only check, do not install.'],
    ],
    examples: [
      'kolm update --check',
      'kolm update --channel stable',
    ],
    notes: 'Refuses to run when the binary path matches a checked-out repo: that path is a silent global-install hazard. Use <code>kolm upgrade</code> for major-version migrations.',
    see: [['kolm upgrade', '/docs/cli/upgrade'], ['kolm version', '/docs/cli/version']],
  },
  {
    name: 'upgrade',
    title: 'kolm upgrade',
    desc: 'Migrate kolm.toml, recipes, and cached artifacts to the next major version.',
    usage: 'kolm upgrade [--to <version>] [--dry-run]',
    flags: [
      ['--to <version>', 'latest', 'Target version. Defaults to latest stable.'],
      ['--dry-run', 'off', 'Print the migration plan, do not apply.'],
    ],
    examples: [
      'kolm upgrade --dry-run',
      'kolm upgrade --to 0.3.0',
    ],
    notes: 'Backups the prior state under <code>~/.kolm/backups/&lt;timestamp&gt;</code>. Roll back with <code>kolm upgrade --rollback</code>.',
    see: [['kolm update', '/docs/cli/update'], ['kolm version', '/docs/cli/version']],
  },
  {
    name: 'completion',
    title: 'kolm completion',
    desc: 'Print or install shell completion for bash, zsh, fish, or PowerShell.',
    usage: 'kolm completion <bash|zsh|fish|powershell> [--install]',
    flags: [
      ['<shell>', 'required', 'One of <code>bash</code>, <code>zsh</code>, <code>fish</code>, <code>powershell</code>.'],
      ['--install', 'off', 'Install into the default completion path for the shell.'],
    ],
    examples: [
      'kolm completion zsh',
      'kolm completion bash --install',
      "kolm completion powershell | Out-String | Invoke-Expression",
    ],
    notes: 'Auto-completes every verb, every flag, and every artifact slug in your cache.',
    see: [['kolm tui', '/docs/cli/tui']],
  },
  {
    name: 'tui',
    title: 'kolm tui',
    desc: 'Open the terminal UI: 20 panes, every surface, one keystroke each.',
    usage: 'kolm tui [--view <id>]',
    flags: [
      ['--view <id>', 'home', 'Start in a specific view, e.g. <code>captures</code>, <code>builds</code>, <code>k-score</code>, <code>multimodal</code>.'],
    ],
    examples: [
      'kolm tui',
      'kolm tui --view captures',
      'kolm tui --view multimodal',
    ],
    notes: 'Built on the same router as the web account dashboard. Works inside Windows Terminal, iTerm, Alacritty, Kitty, and tmux.',
    see: [['kolm completion', '/docs/cli/completion']],
  },
  {
    name: 'ask',
    title: 'kolm ask',
    desc: 'Ask the kolm planner a question in natural language. Returns a route plus an explanation.',
    usage: 'kolm ask <question> [--modality <text|image|audio|pdf>]',
    flags: [
      ['<question>', 'required', 'Free-form natural language.'],
      ['--modality <m>', '<code>text</code>', 'Input modality.'],
      ['--json', 'off', 'Print as JSON.'],
    ],
    examples: [
      'kolm ask "route this support email"',
      'kolm ask "redact this image" --modality image',
    ],
    notes: 'Calls <code>/v1/intent/ask</code>. Returns the suggested artifact, the suggested namespace, and the rationale.',
    see: [['kolm chat', '/docs/cli/chat'], ['kolm instant', '/docs/cli/instant']],
  },
  {
    name: 'chat',
    title: 'kolm chat',
    desc: 'Open an interactive chat against a model, a hosted gateway, or a local artifact.',
    usage: 'kolm chat [model|artifact] [--system <text>]',
    flags: [
      ['model|artifact', 'optional', 'Model id (e.g. <code>claude-sonnet-4-6</code>) or path to a <code>.kolm</code> file.'],
      ['--system <text>', 'off', 'System prompt.'],
      ['--json', 'off', 'Print every turn as JSON.'],
    ],
    examples: [
      'kolm chat',
      'kolm chat claude-sonnet-4-6',
      'kolm chat ./inbox-router.kolm --system "you triage inbound emails"',
    ],
    notes: 'Multi-turn. <code>/exit</code> to leave. Captures are written if the active gateway is the kolm wrapper.',
    see: [['kolm ask', '/docs/cli/ask'], ['kolm instant', '/docs/cli/instant']],
  },
];

function render(v) {
  const flagsRows = v.flags.map(([f, d, desc]) =>
    `<tr><td><code>${f}</code></td><td>${d}</td><td>${desc}</td></tr>`
  ).join('\n');
  const examplesBlock = v.examples.map(e => e).join('\n');
  const seeBlock = v.see.map(([t, h]) => `<li><a href="${h}">${t}</a></li>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark" style="background:#07090c;color-scheme:dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${v.title} | CLI reference | kolm.ai</title>
<meta name="description" content="${v.desc.replace(/<[^>]+>/g, '')}">
<meta name="theme-color" content="#07090c" media="(prefers-color-scheme: dark)">
<link rel="canonical" href="https://kolm.ai/docs/cli/${v.name}">
<meta property="og:title" content="${v.title} &middot; kolm.ai">
<meta property="og:description" content="${v.desc.replace(/<[^>]+>/g, '')}">
<meta property="og:url" content="https://kolm.ai/docs/cli/${v.name}">
<meta property="og:type" content="article">
<meta property="og:image" content="/og/docs-cli.svg">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/ks.css">
<style>
  .docs-main { max-width: 880px; margin: 0 auto; padding: var(--ks-16) var(--ks-pad-x) var(--ks-20); }
  .docs-main h1 { font-size: clamp(36px, 4.6vw, 56px); margin: var(--ks-3) 0 var(--ks-3); font-weight: 520; letter-spacing: -0.022em; }
  .docs-main h2 { font-size: 22px; margin: var(--ks-12) 0 var(--ks-3); font-weight: 520; letter-spacing: -0.015em; }
  .docs-main p { color: var(--ks-ink-2); line-height: 1.7; font-size: 16px; }
  .docs-main .crumbs { font-family: var(--ks-mono); font-size: 12px; color: var(--ks-ink-3); margin-bottom: var(--ks-3); }
  .docs-main .crumbs a { color: var(--ks-ink-3); }
  .docs-main .crumbs a:hover { color: var(--ks-accent); }
  .docs-main blockquote { border-left: 2px solid var(--ks-accent); padding: 4px 0 4px 18px; margin: var(--ks-3) 0 0; color: var(--ks-ink); }
  .docs-main pre { background: var(--ks-bg-1); border: 1px solid var(--ks-line-1); border-radius: var(--ks-r-md); padding: 16px 18px; overflow-x: auto; font-family: var(--ks-mono); font-size: 13px; line-height: 1.65; color: var(--ks-ink); }
  .docs-main code { font-family: var(--ks-mono); font-size: 0.92em; padding: 1px 6px; border-radius: 5px; background: var(--ks-accent-soft); color: var(--ks-accent); }
  .docs-main table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: var(--ks-3); }
  .docs-main th, .docs-main td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--ks-line-1); vertical-align: top; }
  .docs-main th { color: var(--ks-ink-3); font-weight: 520; font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase; }
  .docs-main td { color: var(--ks-ink-2); }
  .docs-main td:first-child { white-space: nowrap; }
  .docs-main ul { color: var(--ks-ink-2); line-height: 1.8; padding-left: 18px; }
  .docs-main ul li::marker { color: var(--ks-accent); }
</style>
<script>(function(){try{var t=localStorage.getItem('kolm-theme');if(t==='light'){document.documentElement.setAttribute('data-theme','light');document.documentElement.style.background='#fbfaf6';document.documentElement.style.colorScheme='light';}}catch(e){}})();</script>
</head>
<body class="ks">
<a href="#main" class="ks-skip">Skip to content</a>

<div class="ks-nav-wrap">
  <nav class="ks-nav" aria-label="Primary">
    <a href="/" class="ks-nav__brand"><span class="ks-nav__mark">k</span><span>kolm<b>.ai</b></span></a>
    <ul class="ks-nav__list">
      <li><a href="/wrapper">Wrapper</a></li>
      <li><a href="/studio">Studio</a></li>
      <li><a href="/pricing">Pricing</a></li>
      <li><a href="/docs" aria-current="page">Docs</a></li>
      <li><a href="https://github.com/sneaky-hippo/kolmogorov-stack" rel="noopener">GitHub</a></li>
    </ul>
    <div class="ks-nav__right">
      <a href="/signup?intent=login" class="ks-nav__signin">Sign in</a>
      <a href="/signup" class="ks-btn ks-btn--primary ks-btn--sm">Get started <span class="ks-btn-arrow">&rarr;</span></a>
      <button class="ks-nav__toggle" id="navToggle" aria-label="Open menu" aria-expanded="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
    </div>
  </nav>
  <div class="ks-nav__sheet" id="navSheet">
    <a href="/wrapper">Wrapper</a><a href="/studio">Studio</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="https://github.com/sneaky-hippo/kolmogorov-stack" rel="noopener">GitHub</a><a href="/signup?intent=login">Sign in</a><a href="/signup">Get started &rarr;</a>
  </div>
</div>

<main id="main" class="docs-main" data-w401f="cli-verb" data-verb="${v.name}">
<nav aria-label="Breadcrumb" class="crumbs"><a href="/docs">Docs</a> / <a href="/docs/cli">CLI</a> / <span>${v.name}</span></nav>
<h1>${v.title}</h1>
<blockquote><p>${v.desc}</p></blockquote>

<h2>Usage</h2>
<pre><code>${v.usage}</code></pre>

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

<footer class="ks-footer">
  <div class="ks-wrap">
    <div class="ks-footer__grid">
      <div>
        <a href="/" class="ks-nav__brand"><span class="ks-nav__mark">k</span><span>kolm<b>.ai</b></span></a>
        <p class="ks-footer__tagline">Compile any AI model. Run it anywhere.</p>
      </div>
      <div>
        <h4>Wrapper</h4>
        <ul><li><a href="/wrapper">Overview</a></li><li><a href="/capture">Capture</a></li><li><a href="/security">Security &amp; receipts</a></li><li><a href="/integrations">Integrations</a></li><li><a href="/docs/api">API reference</a></li></ul>
      </div>
      <div>
        <h4>Studio</h4>
        <ul><li><a href="/studio">Overview</a></li><li><a href="/distill">Distill</a></li><li><a href="/compile">Compile</a></li><li><a href="/k-score">k-score</a></li><li><a href="/models">Models</a></li></ul>
      </div>
      <div>
        <h4>Company</h4>
        <ul><li><a href="/pricing">Pricing</a></li><li><a href="/docs">Docs</a></li><li><a href="/manifesto">Manifesto</a></li><li><a href="/changelog">Changelog</a></li><li><a href="https://github.com/sneaky-hippo/kolmogorov-stack" rel="noopener">GitHub</a></li></ul>
      </div>
    </div>
    <div class="ks-footer__bottom">
      <span>&copy; 2026 kolm.ai &middot; Apache-2.0 &middot; <a href="/legal">Legal</a> &middot; <a href="/security">Security</a></span>
    </div>
  </div>
</footer>

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
console.log(`write-missing-cli-docs: wrote=${wrote} skipped-existing=${skipped} total=${verbs.length}`);
