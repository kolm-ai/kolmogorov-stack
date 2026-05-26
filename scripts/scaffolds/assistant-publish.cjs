#!/usr/bin/env node
// W888-O — assistant-publish scaffold.
//
// Wraps `kolm export --hf-repo ...` with passport injection so the published
// artifact carries the full provenance chain:
//   training_passport  (from W888-N)
// + bench_passport     (from this W888-O run)
// + cost_passport      (gateway + GPU + storage spend, summed by orchestrator)
// + artifact_sha256    (computed here)
// + passport_sha256    (computed here over the merged passport.json)
//
// Real HF upload is gated on KOLM_W888O_REAL=1 AND HF_TOKEN env.
// In dry-run mode (default), emits an envelope describing the publish that
// WOULD have happened, including the artifact + passport hashes.
//
// Flags:
//   --artifact <path>          required — the .kolm artifact to publish
//   --hf-repo <id>             required — HuggingFace repo id (e.g. kolm-ai/kolm-assistant-1.5b)
//   --training-passport <p>    optional — merged into the published passport
//   --bench-passport <p>       optional — merged into the published passport
//   --cost-passport <p>        optional — merged into the published passport
//   --include-passport         (no-op flag for parity with `kolm export`)
//   --include-bench            (no-op flag for parity with `kolm export`)
//   --out <path>               default ./publish-report.json
//   --dry-run                  default ON unless KOLM_W888O_REAL=1
//   --json                     emit the publish envelope to stdout
//   --help
//
// Exit codes:
//   0 — publish completed (real or dry-run)
//   1 — real upload failed
//   2 — bad args
//   3 — required inputs missing / unreadable

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 'w888o-assistant-publish-v1';

function parseArgs(argv) {
  const out = {
    artifact: null,
    hfRepo: null,
    trainingPassport: null,
    benchPassport: null,
    costPassport: null,
    out: path.resolve(process.cwd(), 'publish-report.json'),
    dryRun: !(process.env.KOLM_W888O_REAL === '1'),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a === '--artifact') out.artifact = argv[++i];
    else if (a === '--hf-repo') out.hfRepo = argv[++i];
    else if (a === '--training-passport') out.trainingPassport = argv[++i];
    else if (a === '--bench-passport') out.benchPassport = argv[++i];
    else if (a === '--cost-passport') out.costPassport = argv[++i];
    else if (a === '--include-passport') { /* no-op compat flag */ }
    else if (a === '--include-bench') { /* no-op compat flag */ }
    else if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    'assistant-publish — merge passports + publish artifact to HuggingFace.\n' +
    '\n' +
    'usage: node scripts/scaffolds/assistant-publish.cjs --artifact <path> --hf-repo <id> [flags]\n' +
    '\n' +
    'flags:\n' +
    '  --artifact <path>          .kolm artifact (required)\n' +
    '  --hf-repo <id>             HuggingFace repo id (required)\n' +
    '  --training-passport <p>    W888-N training passport\n' +
    '  --bench-passport <p>       W888-O bench passport\n' +
    '  --cost-passport <p>        Cost passport (gateway + GPU + storage)\n' +
    '  --include-passport         compat flag (no-op)\n' +
    '  --include-bench            compat flag (no-op)\n' +
    '  --out <path>               publish report path (default ./publish-report.json)\n' +
    '  --dry-run                  default ON unless KOLM_W888O_REAL=1\n' +
    '  --json                     emit envelope to stdout\n' +
    '  --help                     show this help\n'
  );
}

function sha256File(p) {
  if (!fs.existsSync(p)) return null;
  const h = crypto.createHash('sha256');
  // Stream-safe for any size. Read in chunks via createReadStream would be
  // ideal; readFileSync is fine for ~1GB GGUFs on dev boxes.
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readJsonSafe(p) {
  if (!p || !fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { _read_error: String(e && e.message || e), _path: p }; }
}

function buildMergedPassport(opts) {
  const merged = {
    schema_version: 'kolm-passport-w888o-v1',
    artifact_path: opts.artifact,
    hf_repo: opts.hfRepo,
    generated_at: new Date().toISOString(),
    dry_run: opts.dryRun,
    training: readJsonSafe(opts.trainingPassport),
    bench: readJsonSafe(opts.benchPassport),
    cost: readJsonSafe(opts.costPassport),
    chain: [
      opts.trainingPassport && { name: 'training', path: opts.trainingPassport },
      opts.benchPassport && { name: 'bench', path: opts.benchPassport },
      opts.costPassport && { name: 'cost', path: opts.costPassport },
    ].filter(Boolean),
  };
  return merged;
}

function publish(opts) {
  if (!opts.artifact) {
    process.stderr.write('error: --artifact <path> is required\n');
    process.exit(2);
  }
  if (!opts.hfRepo) {
    process.stderr.write('error: --hf-repo <id> is required\n');
    process.exit(2);
  }

  const artifactExists = fs.existsSync(opts.artifact);
  let artifactSha = null;
  if (artifactExists) {
    artifactSha = sha256File(opts.artifact);
  } else if (!opts.dryRun) {
    process.stderr.write(`artifact not found: ${opts.artifact}\n`);
    process.exit(3);
  }

  const merged = buildMergedPassport(opts);
  merged.artifact_sha256 = artifactSha;
  const passportBuf = Buffer.from(JSON.stringify(merged, null, 2), 'utf8');
  const passportSha = sha256Buffer(passportBuf);
  merged.passport_sha256 = passportSha;

  const envelope = {
    ok: true,
    dry_run: opts.dryRun,
    version: VERSION,
    artifact: opts.artifact,
    artifact_exists: artifactExists,
    artifact_sha256: artifactSha,
    passport_sha256: passportSha,
    hf_repo: opts.hfRepo,
    hf_token_present: !!process.env.HF_TOKEN,
    generated_at: merged.generated_at,
    passport: merged,
  };

  // Real upload branch — gated on env. We deliberately do NOT have a working
  // HF uploader bundled here; that lives behind `kolm export --hf-repo` in the
  // main CLI. The orchestrator (compile-assistant.cjs) is responsible for
  // running `kolm export ...` and pointing this scaffold at its outputs for
  // passport-injection. When the orchestrator gives the green light, this
  // scaffold becomes a thin metadata layer rather than a transport layer.
  if (opts.dryRun || !process.env.KOLM_W888O_REAL || !process.env.HF_TOKEN) {
    envelope.would_publish = {
      repo: opts.hfRepo,
      artifact_sha256: artifactSha,
      passport_sha256: passportSha,
      reasons: [
        opts.dryRun ? 'dry_run=true' : null,
        process.env.KOLM_W888O_REAL !== '1' ? 'KOLM_W888O_REAL!=1' : null,
        !process.env.HF_TOKEN ? 'HF_TOKEN not set' : null,
      ].filter(Boolean),
    };
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify(envelope, null, 2), 'utf8');
    return envelope;
  }

  // Real-mode publish: defer to `kolm export` for transport. We never spawn
  // here directly because export carries its own retry / mirror / signing
  // logic. The orchestrator must have already called `kolm export`; we just
  // stamp the merged passport and the report.
  envelope.publish_handoff = {
    note: 'real publish delegated to `kolm export --hf-repo`; this scaffold owns passport-merge only',
    cli_verb: `kolm export ${opts.artifact} --hf-repo ${opts.hfRepo} --include-passport`,
  };

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(envelope, null, 2), 'utf8');
  return envelope;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const env = publish(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(env, null, 2) + '\n');
  } else {
    const mode = env.dry_run ? 'dry-run' : 'real';
    const where = env.would_publish ? `(would_publish to ${env.hf_repo})` : `-> ${env.hf_repo}`;
    process.stdout.write(
      `publish (${mode}) ${where}\n` +
      `  artifact sha256: ${env.artifact_sha256 || '(missing)'}\n` +
      `  passport sha256: ${env.passport_sha256}\n` +
      `  report:          ${opts.out}\n`
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  publish,
  buildMergedPassport,
  sha256File,
  sha256Buffer,
  readJsonSafe,
  VERSION,
};
