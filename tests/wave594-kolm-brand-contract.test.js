import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BACKEND_OWNED_BRAND_FILES = [
  'server.js',
  'package.json',
  'docs/product-journeys.json',
  'docs/product-readiness-closeout.md',
  'docs/product-sota-readiness.json',
  'docs/product-surfaces.json',
];

const BACKEND_OWNED_BRAND_ROOTS = [
  'cli',
  'src',
  'scripts',
  'packages',
];

const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.json',
  '.kt',
  '.kts',
  '.md',
  '.mjs',
  '.ps1',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.xml',
  '.yaml',
  '.yml',
]);

const SKIP_PARTS = [
  `${path.sep}.git${path.sep}`,
  `${path.sep}.gradle${path.sep}`,
  `${path.sep}.tmp${path.sep}`,
  `${path.sep}__pycache__${path.sep}`,
  `${path.sep}build${path.sep}`,
  `${path.sep}coverage${path.sep}`,
  `${path.sep}dist${path.sep}`,
  `${path.sep}node_modules${path.sep}`,
  `${path.sep}reports${path.sep}`,
  `${path.sep}target${path.sep}`,
];

const SKIP_NAME_PATTERNS = [
  /^\.npm-cache/i,
  /^npm-cache/i,
  /\.log$/i,
  /\.pyc$/i,
];

function shouldSkip(filePath, name = path.basename(filePath)) {
  if (SKIP_PARTS.some((part) => filePath.includes(part))) return true;
  return SKIP_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

function walkSource(entry, out = []) {
  const abs = path.join(ROOT, entry);
  if (!fs.existsSync(abs)) return out;
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    if (SOURCE_EXTENSIONS.has(path.extname(abs).toLowerCase()) && !shouldSkip(abs)) out.push(abs);
    return out;
  }
  for (const child of fs.readdirSync(abs, { withFileTypes: true })) {
    const childPath = path.join(abs, child.name);
    if (shouldSkip(childPath, child.name)) continue;
    if (child.isDirectory()) walkSource(path.relative(ROOT, childPath), out);
    else if (SOURCE_EXTENSIONS.has(path.extname(child.name).toLowerCase())) out.push(childPath);
  }
  return out;
}

function rel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

test('backend-owned source surfaces do not reintroduce legacy Kolmogorov slugs', () => {
  const files = [
    ...BACKEND_OWNED_BRAND_FILES.map((entry) => path.join(ROOT, entry)),
    ...BACKEND_OWNED_BRAND_ROOTS.flatMap((entry) => walkSource(entry)),
  ];
  const failures = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    // The upstream GitHub repo slug is `kolmogorov-stack` — it's a real remote
    // we can't rename without breaking every `git clone` in the wild. Strip
    // every github.com URL and every `kolmogorov-stack` filesystem slug (e.g.
    // `pip install git+https://...#subdirectory=...`) before scanning for the
    // brand word in user-facing copy.
    const text = raw
      .replace(/https?:\/\/(?:[a-z0-9.-]+\.)?github\.com\/[\w./@:?+#=&-]*/gi, '')
      .replace(/git\+https?:\/\/[^\s"'`]+/gi, '')
      .replace(/[\w./-]*kolmogorov-stack[\w./@:?+#=&-]*/gi, '');
    if (/kolmogorov/i.test(text)) failures.push(rel(file));
  }
  assert.deepEqual(failures, [], `legacy brand token found in backend-owned files: ${failures.join(', ')}`);
});

test('server CSP defaults to Kolm origins and leaves legacy private origins opt-in', async () => {
  const previous = process.env.KOLM_CSP_CONNECT_SRC;
  delete process.env.KOLM_CSP_CONNECT_SRC;
  try {
    const { app } = await import(`../server.js?brand-csp-default=${Date.now()}`);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const port = server.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const csp = res.headers.get('content-security-policy') || '';
      assert.match(csp, /connect-src[^;]*https:\/\/kolm\.ai/);
      assert.doesNotMatch(csp, /kolmogorov/i);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    if (previous === undefined) delete process.env.KOLM_CSP_CONNECT_SRC;
    else process.env.KOLM_CSP_CONNECT_SRC = previous;
  }
});
