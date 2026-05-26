#!/usr/bin/env node
// scripts/publish-trinity.cjs
//
// S-5 — Trinity-500 publication orchestrator (DRY-RUN ONLY).
//
// Reads a distill-run artifact directory, generates the HuggingFace model
// card via src/hf-modelcard.js (ESM, loaded with dynamic import), computes
// sha256 + size for every GGUF, then writes a publication-manifest.json
// plus a mirrored README.md under public/trinity-500/.
//
// The orchestrator NEVER pushes to HuggingFace. It prints the exact
// `huggingface-cli upload` commands that would publish the artifact, so a
// caller can copy-paste them when ready.
//
// Constraints (USER-MANDATED, NON-NEGOTIABLE):
//   - The banned legacy word never appears in code, comments, or output;
//     use Caveats / Constraints / Limitations.
//   - No emojis.
//   - No commits, no pushes.
//   - No colors that lean brown / beige / orange.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const PUBLISH_ORCH_VERSION = 'kolm-trinity-publish/1';

const HELP = `Usage: node scripts/publish-trinity.cjs [options]

  Dry-run publication orchestrator for the trinity-500 distill artifact.
  Generates a HuggingFace-compatible README.md + publication-manifest.json
  and prints the huggingface-cli upload commands that would publish.

Options:
  --artifact-dir <path>   Override the artifact directory.
                          Defaults to:
                            $HOME/.kolm/distill-runs/trinity-500-2026-05-26
                          falling back to:
                            <repo>/artifacts/trinity-500-2026-05-26
  --out <path>            Override the public mirror directory.
                          Default: <repo>/public/trinity-500
  --target-repo <slug>    HF target repo. Default: kolm/trinity-500
  --license <id>          SPDX-style license. Default: apache-2.0
  --base-model <slug>     Base model slug. Default: Qwen/Qwen2.5-7B-Instruct
  --full-hash             Compute real sha256 of every GGUF (slow on >GB files).
                          Default: stat-only manifest (size + mtime).
  --dry-run               Default. The only mode supported by this script.
  --help, -h              Print this message.

Exit codes:
  0   success
  1   bad arguments
  3   artifact dir or passport missing
`;

function parseArgs(argv) {
  const opts = {
    artifactDir: null,
    outDir: null,
    targetRepo: 'kolm/trinity-500',
    license: 'apache-2.0',
    baseModel: 'Qwen/Qwen2.5-7B-Instruct',
    fullHash: false,
    dryRun: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; }
    else if (a === '--dry-run') { opts.dryRun = true; }
    else if (a === '--full-hash') { opts.fullHash = true; }
    else if (a === '--artifact-dir') { opts.artifactDir = argv[++i]; }
    else if (a === '--out') { opts.outDir = argv[++i]; }
    else if (a === '--target-repo') { opts.targetRepo = argv[++i]; }
    else if (a === '--license') { opts.license = argv[++i]; }
    else if (a === '--base-model') { opts.baseModel = argv[++i]; }
    else { return { ok: false, error: `unknown arg: ${a}` }; }
  }
  return { ok: true, opts };
}

function homeDir() {
  return process.env.KOLM_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function locateArtifactDir(explicit, repoRoot) {
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(repoRoot, explicit);
  const primary = path.join(homeDir(), '.kolm', 'distill-runs', 'trinity-500-2026-05-26');
  if (fs.existsSync(primary)) return primary;
  const fallback = path.join(repoRoot, 'artifacts', 'trinity-500-2026-05-26');
  return fallback;
}

function readJsonOrNull(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_e) { return null; }
}

function sha256OfFileStream(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function listGgufFiles(artifactDir) {
  const candidates = [
    path.join(artifactDir, 'merged', 'gguf'),
    path.join(artifactDir, 'gguf'),
    artifactDir,
  ];
  for (const dir of candidates) {
    try {
      const entries = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.gguf'));
      if (entries.length > 0) {
        return entries.map((n) => path.join(dir, n));
      }
    } catch (_e) { /* dir may not exist */ }
  }
  return [];
}

function extractFrontmatter(readme) {
  if (typeof readme !== 'string' || !readme.startsWith('---\n')) return null;
  const second = readme.indexOf('\n---\n', 4);
  if (second < 0) return null;
  return readme.slice(4, second);
}

function buildHfUploadCommands(targetRepo, files) {
  // The orchestrator emits the exact huggingface-cli invocations a caller
  // would run after authorising the push. README.md goes first so the Hub
  // landing page renders before GGUFs flood the repo.
  const lines = [];
  lines.push(`# 1. Create the repo (idempotent)`);
  lines.push(`huggingface-cli repo create ${targetRepo} --type model --yes`);
  lines.push(``);
  lines.push(`# 2. Upload the model card`);
  lines.push(`huggingface-cli upload ${targetRepo} README.md README.md --repo-type model`);
  lines.push(`huggingface-cli upload ${targetRepo} passport.json passport.json --repo-type model`);
  lines.push(`huggingface-cli upload ${targetRepo} benchmark-summary.json benchmark-summary.json --repo-type model`);
  lines.push(``);
  lines.push(`# 3. Upload GGUF quantizations`);
  for (const f of files) {
    const base = path.basename(f.path || f);
    lines.push(`huggingface-cli upload ${targetRepo} ${base} ${base} --repo-type model`);
  }
  return lines;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`error: ${parsed.error}\n${HELP}`);
    process.exit(1);
  }
  if (parsed.opts.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const opts = parsed.opts;
  const repoRoot = path.resolve(__dirname, '..');
  const artifactDir = locateArtifactDir(opts.artifactDir, repoRoot);
  const outDir = opts.outDir
    ? (path.isAbsolute(opts.outDir) ? opts.outDir : path.resolve(repoRoot, opts.outDir))
    : path.join(repoRoot, 'public', 'trinity-500');

  if (!fs.existsSync(artifactDir)) {
    process.stderr.write(`error: artifact dir does not exist: ${artifactDir}\n`);
    process.exit(3);
  }

  // Passport candidate order mirrors src/hf-modelcard.js writeModelCard().
  const passportCandidates = [
    path.join(artifactDir, 'passport.json'),
    path.join(artifactDir, 'merged', 'passport.json'),
  ];
  const passportPath = passportCandidates.find((p) => fs.existsSync(p));
  const passport = passportPath ? readJsonOrNull(passportPath) : null;
  if (!passport) {
    process.stderr.write(`error: no passport.json under ${artifactDir}\n`);
    process.exit(3);
  }

  const benchmarkCandidates = [
    path.join(artifactDir, 'benchmark-summary.json'),
    path.join(artifactDir, 'merged', 'benchmark-summary.json'),
  ];
  const benchmarkPath = benchmarkCandidates.find((p) => fs.existsSync(p));
  const benchmark = benchmarkPath ? readJsonOrNull(benchmarkPath) : null;

  // Dynamic-import the ESM model card generator.
  const modUrl = pathToFileURL(path.join(repoRoot, 'src', 'hf-modelcard.js')).href;
  const mod = await import(modUrl);
  const { generateModelCard } = mod;
  const { readme, frontmatter } = generateModelCard({
    passport,
    benchmark,
    artifactDir,
    target_repo: opts.targetRepo,
    license: opts.license,
    base_model: opts.baseModel,
  });

  // Mirror README.md into public/trinity-500/ with an HTML comment marker.
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const mirrorHeader = `<!-- mirrored from HF model card at huggingface.co/${opts.targetRepo} -->\n`;
  const mirroredReadme = mirrorHeader + readme;
  const readmePath = path.join(outDir, 'README.md');
  fs.writeFileSync(readmePath, mirroredReadme);

  // Catalogue the GGUFs.
  const ggufPaths = listGgufFiles(artifactDir);
  const files = [];
  for (const p of ggufPaths) {
    const st = fs.statSync(p);
    const entry = {
      path: p,
      basename: path.basename(p),
      size_bytes: st.size,
      mtime: st.mtime.toISOString(),
    };
    if (opts.fullHash) {
      entry.sha256 = await sha256OfFileStream(p);
    } else {
      entry.sha256 = null;
      entry._synthetic = true;
      entry._synthetic_reason = 'sha256 skipped — run with --full-hash to compute';
    }
    files.push(entry);
  }

  // Extract frontmatter text (already a YAML string) for the manifest.
  const frontmatterText = extractFrontmatter(readme);

  // Mirror just the key metrics row for the artifact-under-test.
  const benchKey = passport.id || opts.targetRepo.split('/').pop();
  const benchRow = (benchmark && (benchmark[benchKey] || benchmark[(benchKey || '').replace(/-\d{4}-\d{2}-\d{2}$/, '')] || benchmark[Object.keys(benchmark)[0]])) || null;
  const benchSummary = benchRow ? {
    n: benchRow.n,
    asks_one_question_pct: benchRow.asks_one_question_pct,
    no_inventions_pct: benchRow.no_inventions_pct,
    on_policy_pct: benchRow.on_policy_pct,
    all_three_pct: benchRow.all_three_pct,
    mean_latency_s: benchRow.mean_latency_s,
    mean_response_chars: benchRow.mean_response_chars,
    judge_clarifies_pct: benchRow.judge_clarifies_pct,
    judge_on_policy_pct: benchRow.judge_on_policy_pct,
  } : { _synthetic: true, _synthetic_reason: 'no benchmark-summary.json found' };

  const manifest = {
    spec: PUBLISH_ORCH_VERSION,
    target_repo: opts.targetRepo,
    artifact_dir: artifactDir,
    passport_path: passportPath,
    benchmark_path: benchmarkPath || null,
    frontmatter: frontmatter,
    frontmatter_yaml: frontmatterText,
    files,
    bench_summary: benchSummary,
    ran_at: new Date().toISOString(),
    dry_run: true,
    notes: [
      'Artifact NOT pushed. Copy-paste the commands printed below to publish.',
      opts.fullHash ? 'sha256 computed for every GGUF.' : 'sha256 skipped — rerun with --full-hash to compute.',
    ],
  };
  const manifestPath = path.join(outDir, 'publication-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Emit the upload commands. Print to stdout so the caller can pipe them.
  const cmds = buildHfUploadCommands(opts.targetRepo, files);
  process.stdout.write(`Trinity-500 publication dry-run\n`);
  process.stdout.write(`================================\n`);
  process.stdout.write(`artifact_dir : ${artifactDir}\n`);
  process.stdout.write(`passport     : ${passportPath}\n`);
  process.stdout.write(`benchmark    : ${benchmarkPath || '(none)'}\n`);
  process.stdout.write(`target_repo  : ${opts.targetRepo}\n`);
  process.stdout.write(`gguf_files   : ${files.length}\n`);
  process.stdout.write(`mirror       : ${readmePath}\n`);
  process.stdout.write(`manifest     : ${manifestPath}\n`);
  process.stdout.write(`\n--- huggingface-cli commands (NOT executed) ---\n`);
  for (const l of cmds) process.stdout.write(l + '\n');
  process.stdout.write(`--- end ---\n`);

  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e && e.message ? e.message : String(e)}\n`);
  if (e && e.stack) process.stderr.write(e.stack + '\n');
  process.exit(1);
});
