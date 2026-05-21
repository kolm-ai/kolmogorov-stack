// Local repo graph for product/code audits.
//
// Inspired by CodeGraph's useful operating principle: index code once, then
// query structure, routes, imports, symbols, scripts, and product-readiness
// evidence without repeatedly sweeping the whole tree.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ROOT_DIRS = Object.freeze(['src', 'cli', 'services', 'scripts', 'public', 'docs', 'tests']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'coverage', 'tmp', '.codegraph']);
const TEXT_EXTS = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.csv', '.toml', '.yml', '.yaml']);

function normalize(p) {
  return p.replace(/\\/g, '/');
}

function sha256(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function languageFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.json') return 'json';
  if (ext === '.html') return 'html';
  if (ext === '.css') return 'css';
  if (ext === '.md') return 'markdown';
  if (ext === '.csv') return 'csv';
  if (ext === '.toml') return 'toml';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  return 'text';
}

function surfaceFor(rel) {
  if (rel.startsWith('src/')) return 'backend';
  if (rel.startsWith('cli/')) return 'cli';
  if (rel.startsWith('services/')) return 'service';
  if (rel.startsWith('scripts/')) return 'automation';
  if (rel.startsWith('public/account/')) return 'account-ui';
  if (rel.startsWith('public/')) return 'public-web';
  if (rel.startsWith('docs/')) return 'docs';
  if (rel.startsWith('tests/')) return 'tests';
  return 'other';
}

function listFiles(root, dirs = DEFAULT_ROOT_DIRS) {
  const out = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    walk(abs, out);
  }
  return out;
}

function walk(abs, out) {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    const name = path.basename(abs);
    if (SKIP_DIRS.has(name)) return;
    for (const child of fs.readdirSync(abs)) walk(path.join(abs, child), out);
    return;
  }
  if (!st.isFile()) return;
  if (!TEXT_EXTS.has(path.extname(abs).toLowerCase())) return;
  out.push(abs);
}

function lineOf(body, offset) {
  let n = 1;
  for (let i = 0; i < offset; i += 1) if (body.charCodeAt(i) === 10) n += 1;
  return n;
}

function parseImports(body, rel) {
  const imports = [];
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(body))) {
      imports.push({ file: rel, specifier: m[1], line: lineOf(body, m.index) });
    }
  }
  return imports;
}

function parseSymbols(body, rel) {
  const symbols = [];
  const patterns = [
    { type: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm },
    { type: 'class', re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/gm },
    { type: 'const-fn', re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm },
    { type: 'export', re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/gm },
  ];
  for (const { type, re } of patterns) {
    let m;
    while ((m = re.exec(body))) {
      symbols.push({ file: rel, type, name: m[1], line: lineOf(body, m.index) });
    }
  }
  return symbols;
}

function parseRoutes(body, rel) {
  const routes = [];
  const re = /\b(?:app|router)\.(get|post|put|patch|delete|all|use)\(\s*['"`]([^'"`]+)['"`]/gi;
  let m;
  while ((m = re.exec(body))) {
    routes.push({ file: rel, method: m[1].toUpperCase(), path: m[2], line: lineOf(body, m.index) });
  }
  return routes;
}

function parsePackageScripts(root) {
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) return [];
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.entries(pkg.scripts || {}).map(([name, command]) => ({ name, command }));
}

function loadReadinessEvidence(root) {
  const file = path.join(root, 'docs', 'product-sota-readiness.json');
  if (!fs.existsSync(file)) return [];
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const surface of doc.surfaces || []) {
    for (const req of surface.requirements || []) {
      const evidence = Array.isArray(req.evidence_paths) ? req.evidence_paths : [];
      out.push({
        surface_id: surface.id,
        requirement_id: req.id,
        status: req.status,
        evidence_paths: evidence,
        missing_paths: evidence.filter((p) => !fs.existsSync(path.join(root, p))),
      });
    }
  }
  return out;
}

export function buildCodeGraph({ root = process.cwd(), dirs = DEFAULT_ROOT_DIRS } = {}) {
  const files = [];
  const imports = [];
  const symbols = [];
  const routes = [];
  for (const abs of listFiles(root, dirs)) {
    const rel = normalize(path.relative(root, abs));
    const body = fs.readFileSync(abs, 'utf8');
    files.push({
      path: rel,
      bytes: Buffer.byteLength(body),
      sha256: sha256(body),
      language: languageFor(rel),
      surface: surfaceFor(rel),
    });
    if (/\.(?:js|mjs|cjs)$/i.test(rel)) {
      imports.push(...parseImports(body, rel));
      symbols.push(...parseSymbols(body, rel));
      routes.push(...parseRoutes(body, rel));
    } else if (/\.html$/i.test(rel)) {
      const publicPrefix = rel.startsWith('public/') ? rel.slice('public/'.length) : rel;
      const pathNoExt = '/' + publicPrefix.replace(/\.html$/i, '').replace(/\/index$/i, '');
      routes.push({ file: rel, method: 'GET', path: pathNoExt === '/index' ? '/' : pathNoExt, line: 1, static: true });
    }
  }
  const scripts = parsePackageScripts(root);
  const readiness_evidence = loadReadinessEvidence(root);
  return {
    schema_version: 'kolm-codegraph-1',
    generated_at: new Date().toISOString(),
    root: normalize(root),
    counts: {
      files: files.length,
      imports: imports.length,
      symbols: symbols.length,
      routes: routes.length,
      scripts: scripts.length,
      readiness_requirements: readiness_evidence.length,
      readiness_missing_evidence: readiness_evidence.filter((row) => row.missing_paths.length).length,
    },
    files,
    imports,
    symbols,
    routes,
    scripts,
    readiness_evidence,
  };
}

export function auditCodeGraph(graph) {
  const fileSet = new Set((graph.files || []).map((f) => f.path));
  const scriptSet = new Set((graph.scripts || []).map((s) => s.name));
  const routePaths = new Set((graph.routes || []).map((r) => r.path));
  const requiredFiles = [
    'src/router.js',
    'src/completions-api.js',
    'src/compile-pipeline.js',
    'src/distill-pipeline.js',
    'src/remote-compute.js',
    'src/platform-capabilities.js',
    'src/otel.js',
    'src/compute/registry.json',
    'docs/product-sota-readiness.json',
  ];
  const requiredScripts = ['lint:refs', 'verify:compute', 'verify:sota', 'local:surfaces'];
  const requiredRoutes = ['/compute', '/models', '/account/overview', '/spec', '/captures', '/distill', '/train'];
  const missing = [
    ...requiredFiles.filter((p) => !fileSet.has(p)).map((p) => 'file:' + p),
    ...requiredScripts.filter((s) => !scriptSet.has(s)).map((s) => 'script:' + s),
    ...requiredRoutes.filter((r) => !routePaths.has(r)).map((r) => 'route:' + r),
  ];
  const missingEvidence = (graph.readiness_evidence || []).filter((row) => row.missing_paths && row.missing_paths.length);
  if (missingEvidence.length) missing.push('readiness_evidence:' + missingEvidence.length);
  if ((graph.counts?.routes || 0) < 300) missing.push('routes:<300');
  if ((graph.counts?.symbols || 0) < 500) missing.push('symbols:<500');
  return {
    ok: missing.length === 0,
    missing,
    counts: graph.counts,
  };
}

export function writeCodeGraph(graph, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(graph, null, 2) + '\n', 'utf8');
  return outPath;
}
