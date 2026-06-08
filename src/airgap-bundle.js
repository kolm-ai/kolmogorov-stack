// W869 T4 - `kolm bundle airgap` builder.
//
// Produces a single .tar.gz containing everything an air-gapped operator
// needs to stand up the kolm stack with zero network egress:
//
//   cli/ - kolm CLI entry point
//   src/ - runtime modules
//   apps/ - Python workers (distill, eval, export, runtime, trainer)
//   package.json - pinned dependency manifest
//   package-lock.json (when present)
//   node_modules/ - installed production dependencies (omitted unless --with-node-modules)
//   docs/ - offline doc mirror
//   wheels/ - optional Python wheelhouse (--with-wheels)
//   models/ - optional default model weights (--with-models, points at KOLM_MODELS_DIR)
//   MANIFEST.json - {created_at, git_sha?, sha256_tree, files[], options, version}
//   BUNDLE-README.md - operator instructions, env matrix snippet, deploy checklist
//
// Honest envelope. Every failure returns {ok:false, error, hint}.
// Success returns {ok:true, path, sha256, size_bytes, file_count, manifest}.
//
// We use the `archiver` dep (already in package.json) for tar+gzip rather
// than rolling our own - it's battle-tested for large trees and handles
// long filenames + UTF-8 properly, which sneakernet.js's USTAR writer does
// not. The format is identical to `tar -czf` so any POSIX `tar -xzf` on
// the target host can extract it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const AIRGAP_BUNDLE_VERSION = 'w869-v1';

// Tree exclusions - never include these in the tar regardless of root.
// .git is huge and useless on a target host; .DS_Store is mac noise;
// __pycache__ + .pyc are build droppings; *.test.js + tests/ are dev-only.
const ALWAYS_EXCLUDE = new Set([
  '.git',
  '.github',
  '.gitignore',
  '.DS_Store',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  'env',
  '.next',
  '.cache',
  '.cargo',          // rust dep cache
  '.turbo',
  '.svelte-kit',
  '.nuxt',
  '.nyc_output',
  'coverage',
  'htmlcov',
  '.tox',
  'target',          // rust/maven build output (kept out - see --with-... flags for opt-in)
  'dist',            // generic build output
  'build',           // generic build output
  '.kolm',           // user state - never bundle
  '.env',            // secrets - never bundle
  '.env.local',
  '.env.production',
  'logs',
  'tmp',
  'temp',
]);

const EXT_EXCLUDE = new Set(['.pyc', '.pyo', '.log']);

function shouldExclude(name) {
  if (ALWAYS_EXCLUDE.has(name)) return true;
  if (name.startsWith('.env.')) return true;
  if (name.startsWith('npm-debug.log')) return true;
  const ext = path.extname(name);
  if (EXT_EXCLUDE.has(ext)) return true;
  return false;
}

// Walk a directory tree breadth-first, applying exclusions. Returns
// [{abs, rel, size, mtime}] sorted by `rel` for deterministic ordering
// (so manifest sha256 is stable across runs on the same tree).
function walkTree(rootAbs, prefix = '') {
  const out = [];
  if (!fs.existsSync(rootAbs)) return out;
  const stack = [{ abs: rootAbs, rel: prefix }];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (shouldExclude(ent.name)) continue;
      const absChild = path.join(cur.abs, ent.name);
      const relChild = cur.rel ? cur.rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        stack.push({ abs: absChild, rel: relChild });
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        let st;
        try {
          st = fs.statSync(absChild);
        } catch {
          continue;
        }
        out.push({
          abs: absChild,
          rel: relChild,
          size: st.size,
          mtime: Math.floor(st.mtimeMs / 1000),
        });
      }
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

function sha256File(absPath) {
  const h = crypto.createHash('sha256');
  const buf = fs.readFileSync(absPath);
  h.update(buf);
  return h.digest('hex');
}

function tryReadGitSha(repoRoot) {
  try {
    const headPath = path.join(repoRoot, '.git', 'HEAD');
    if (!fs.existsSync(headPath)) return null;
    const head = fs.readFileSync(headPath, 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      const refPath = path.join(repoRoot, '.git', ref);
      if (fs.existsSync(refPath)) {
        return fs.readFileSync(refPath, 'utf8').trim();
      }
      // packed-refs fallback
      const packedPath = path.join(repoRoot, '.git', 'packed-refs');
      if (fs.existsSync(packedPath)) {
        const packed = fs.readFileSync(packedPath, 'utf8');
        for (const line of packed.split('\n')) {
          if (line.endsWith(' ' + ref)) {
            return line.split(' ')[0];
          }
        }
      }
      return null;
    }
    return head;
  } catch {
    return null;
  }
}

function readmeBody({ created_at, git_sha, options, file_count, total_bytes }) {
  const sizeMb = (total_bytes / 1024 / 1024).toFixed(1);
  return [
    '# kolm air-gap bundle',
    '',
    'Self-contained tarball for deploying kolm into a network-isolated environment.',
    '',
    '- **Created:** ' + created_at,
    '- **Git SHA:** ' + (git_sha || '(unknown - built outside a git checkout)'),
    '- **Bundle version:** ' + AIRGAP_BUNDLE_VERSION,
    '- **Files:** ' + file_count,
    '- **Uncompressed payload:** ' + sizeMb + ' MB',
    '- **node_modules included:** ' + (options.with_node_modules ? 'yes' : 'no - run `npm ci --omit=dev` on the target after extract'),
    '- **Python wheels included:** ' + (options.with_wheels ? 'yes (wheels/)' : 'no'),
    '- **Model weights included:** ' + (options.with_models ? 'yes (models/)' : 'no'),
    '',
    '## Quick start (target host)',
    '',
    '```bash',
    '# 1. extract',
    'mkdir -p /opt/kolm && cd /opt/kolm',
    'tar -xzf /path/to/kolm-airgap.tar.gz',
    '',
    '# 2. install Node deps (skip if --with-node-modules was used)',
    'npm ci --omit=dev',
    '',
    '# 3. install Python deps from local wheelhouse (skip if --with-wheels not used)',
    'python3 -m pip install --no-index --find-links wheels -r apps/requirements.txt',
    '',
    '# 4. set air-gap env vars',
    'export KOLM_AIRGAP=1',
    'export TRANSFORMERS_OFFLINE=1',
    'export HF_DATASETS_OFFLINE=1',
    'export HF_HUB_OFFLINE=1',
    'export KOLM_HOME=/opt/kolm',
    'export KOLM_DATA_DIR=/var/lib/kolm',
    'export KOLM_ARTIFACT_DIR=/var/lib/kolm/artifacts',
    'export KOLM_MODELS_DIR=/opt/kolm/models      # only if --with-models',
    'export KOLM_LOCAL_TEACHER_URL=http://localhost:8000/v1  # point at your local vLLM/TGI',
    '',
    '# 5. smoke-test',
    './cli/kolm.js airgap status',
    './cli/kolm.js doctor',
    '',
    '# 6. start the API server',
    'node server.js',
    '```',
    '',
    '## Verification',
    '',
    'Each file in MANIFEST.json carries a sha256. Verify the bundle integrity:',
    '',
    '```bash',
    'node -e "',
    "  const m = require('./MANIFEST.json');",
    "  const fs = require('fs'), c = require('crypto');",
    "  let ok = 0, bad = 0;",
    "  for (const f of m.files) {",
    "    const h = c.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex');",
    "    if (h === f.sha256) ok++;",
    "    else { console.error('MISMATCH', f.path); bad++; }",
    "  }",
    "  console.log({ok, bad});",
    "  process.exit(bad ? 1 : 0);",
    '"',
    '```',
    '',
    '## What is NOT in this bundle',
    '',
    'By design, the following are NOT shipped:',
    '',
    '- `.env` / secrets - supply via your secret manager',
    '- `.git` history - not needed at runtime',
    '- Test fixtures (`tests/`) - not needed at runtime',
    '- User data (`~/.kolm`) - generated per-tenant on the target host',
    '- TLS certificates - install via your reverse proxy (Nginx/Caddy)',
    '',
    'See `docs/self-hosted-deploy-complete.md` for the full env-var matrix,',
    'SSO/SAML/SCIM setup, Postgres setup, systemd unit, and runbook.',
    '',
  ].join('\n');
}

// Discover what should go in the bundle. Returns {includes, missing}.
function planContents(repoRoot, opts) {
  const includes = [];
  const missing = [];

  const want = [
    { rel: 'cli',           required: true  },
    { rel: 'src',           required: true  },
    { rel: 'apps',          required: false },
    { rel: 'sdk',           required: false },
    { rel: 'services',      required: false },
    { rel: 'workers',       required: false },
    { rel: 'scripts',       required: false },
    { rel: 'docs',          required: false },
    { rel: 'package.json',  required: true  },
    { rel: 'package-lock.json', required: false },
    { rel: 'server.js',     required: false },
    { rel: 'README.md',     required: false },
    { rel: 'LICENSE',       required: false },
    { rel: 'examples',      required: false },
  ];

  for (const w of want) {
    const abs = path.join(repoRoot, w.rel);
    if (fs.existsSync(abs)) {
      includes.push({ rel: w.rel, abs, kind: fs.statSync(abs).isDirectory() ? 'dir' : 'file' });
    } else if (w.required) {
      missing.push(w.rel);
    }
  }

  if (opts.with_node_modules) {
    const nm = path.join(repoRoot, 'node_modules');
    if (fs.existsSync(nm)) {
      includes.push({ rel: 'node_modules', abs: nm, kind: 'dir' });
    } else {
      missing.push('node_modules (--with-node-modules requested, but directory missing - run `npm ci` first)');
    }
  }

  if (opts.with_wheels) {
    const wh = path.join(repoRoot, 'wheels');
    if (fs.existsSync(wh)) {
      includes.push({ rel: 'wheels', abs: wh, kind: 'dir' });
    } else {
      missing.push('wheels (--with-wheels requested, but directory missing - see docs/airgap-build.md for `pip wheel` build steps)');
    }
  }

  if (opts.with_models) {
    const modelsRoot = opts.models_dir || process.env.KOLM_MODELS_DIR || path.join(repoRoot, 'models');
    if (fs.existsSync(modelsRoot)) {
      includes.push({ rel: 'models', abs: modelsRoot, kind: 'dir' });
    } else {
      missing.push('models (--with-models requested, but ' + modelsRoot + ' missing - set --models-dir or KOLM_MODELS_DIR)');
    }
  }

  return { includes, missing };
}

// Synchronously walk every include and produce a flat manifest.
function buildManifest({ includes, repoRoot, opts, created_at, git_sha }) {
  const files = [];
  let total_bytes = 0;
  for (const inc of includes) {
    if (inc.kind === 'file') {
      const sha = sha256File(inc.abs);
      const size = fs.statSync(inc.abs).size;
      files.push({ path: inc.rel, sha256: sha, bytes: size });
      total_bytes += size;
    } else {
      const tree = walkTree(inc.abs, inc.rel);
      for (const t of tree) {
        const sha = sha256File(t.abs);
        files.push({ path: t.rel, sha256: sha, bytes: t.size });
        total_bytes += t.size;
      }
    }
  }
  // Deterministic order.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    spec: 'kolm-airgap-bundle',
    version: AIRGAP_BUNDLE_VERSION,
    created_at,
    git_sha: git_sha || null,
    options: {
      with_node_modules: !!opts.with_node_modules,
      with_wheels: !!opts.with_wheels,
      with_models: !!opts.with_models,
      models_dir: opts.models_dir || null,
    },
    file_count: files.length,
    total_bytes,
    files,
  };
}

// Public API. Synchronous Promise - the caller awaits the archiver close
// event. Defensive: caller controls dest_path; we never write to a path
// that already exists unless opts.force is set.
export async function buildAirgapBundle(opts = {}) {
  const repoRoot = opts.repo_root || path.resolve(__dirname, '..');
  const destPath = opts.dest_path;
  const force = !!opts.force;

  if (!destPath || typeof destPath !== 'string') {
    return {
      ok: false,
      error: 'dest_path_required',
      hint: 'pass {dest_path: "/path/to/kolm-airgap.tar.gz"} - must end in .tar.gz',
      version: AIRGAP_BUNDLE_VERSION,
    };
  }
  if (!destPath.endsWith('.tar.gz') && !destPath.endsWith('.tgz')) {
    return {
      ok: false,
      error: 'dest_path_extension',
      hint: 'dest_path must end in .tar.gz or .tgz - got ' + path.basename(destPath),
      version: AIRGAP_BUNDLE_VERSION,
    };
  }
  if (fs.existsSync(destPath) && !force) {
    return {
      ok: false,
      error: 'dest_path_exists',
      dest_path: destPath,
      hint: 'pass {force: true} to overwrite, or pick a fresh dest_path',
      version: AIRGAP_BUNDLE_VERSION,
    };
  }
  if (!fs.existsSync(path.join(repoRoot, 'package.json'))) {
    return {
      ok: false,
      error: 'repo_root_invalid',
      repo_root: repoRoot,
      hint: 'repo_root must contain package.json - run `kolm bundle airgap` from the kolm checkout',
      version: AIRGAP_BUNDLE_VERSION,
    };
  }

  const plan = planContents(repoRoot, opts);
  if (plan.missing.length) {
    return {
      ok: false,
      error: 'required_path_missing',
      missing: plan.missing,
      hint: 'fix the listed paths and re-run',
      version: AIRGAP_BUNDLE_VERSION,
    };
  }

  const created_at = new Date().toISOString();
  const git_sha = tryReadGitSha(repoRoot);
  const manifest = buildManifest({
    includes: plan.includes,
    repoRoot,
    opts,
    created_at,
    git_sha,
  });

  let archiver;
  try {
    archiver = require('archiver');
  } catch {
    return {
      ok: false,
      error: 'archiver_module_missing',
      hint: 'run `npm install` in the repo root - archiver@^7 is a declared dep',
      version: AIRGAP_BUNDLE_VERSION,
    };
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const output = fs.createWriteStream(destPath);
  const archive = archiver('tar', { gzip: true, gzipOptions: { level: 6 } });

  const closePromise = new Promise((resolve, reject) => {
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });
    archive.on('error', reject);
  });

  archive.pipe(output);

  // Layout the entries. The MANIFEST + README sit at the bundle root.
  const readme = readmeBody({
    created_at,
    git_sha,
    options: manifest.options,
    file_count: manifest.file_count,
    total_bytes: manifest.total_bytes,
  });
  archive.append(JSON.stringify(manifest, null, 2) + '\n', { name: 'MANIFEST.json' });
  archive.append(readme, { name: 'BUNDLE-README.md' });
  archive.append(AIRGAP_BUNDLE_VERSION + '\n', { name: 'VERSION' });

  for (const inc of plan.includes) {
    if (inc.kind === 'file') {
      archive.file(inc.abs, { name: inc.rel });
    } else {
      // Walk the tree and add files individually so we can apply our
      // exclude rules. archiver.directory() would honor a single glob
      // ignore list, but per-name shouldExclude() is more thorough.
      const tree = walkTree(inc.abs, inc.rel);
      for (const t of tree) {
        archive.file(t.abs, { name: t.rel });
      }
    }
  }

  await archive.finalize();
  await closePromise;

  const sha = sha256File(destPath);
  const size = fs.statSync(destPath).size;

  return {
    ok: true,
    path: destPath,
    sha256: sha,
    size_bytes: size,
    file_count: manifest.file_count,
    payload_bytes: manifest.total_bytes,
    compression_ratio: manifest.total_bytes ? Number((size / manifest.total_bytes).toFixed(4)) : null,
    options: manifest.options,
    git_sha,
    created_at,
    version: AIRGAP_BUNDLE_VERSION,
    manifest_files: manifest.files.length,
  };
}
