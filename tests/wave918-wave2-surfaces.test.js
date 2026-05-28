// W918 Wave 2 — surface lock-in tests for the 12+ artifacts shipped this wave.
//
// One file, sixteen top-level tests, covers every new public surface so any
// regression (deleted page, missing rewrite, dropped sw.js bump, accidental
// emoji, removed module export) trips before push. Mirrors the structure of
// tests/wave918-openai-migration.test.js and tests/wave918-cerebras-teacher.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readUtf8(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

// Surrogate-pair-safe emoji codepoint detector. Matches the two ranges the
// W850 cool-slate design system bans in shipped HTML.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const HONESTY_RE = /honest/i;

// ---------------------------------------------------------------------------
// 1. agents.html lock-in

test('W918-W2-1 — agents.html exists with title, h1, canonical, recipe link, no honesty, no emoji', () => {
  const rel = 'public/agents.html';
  assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} must exist`);
  const src = readUtf8(rel);
  assert.ok(src.includes('<title>'), `${rel} must declare a <title> element`);
  assert.ok(/<h1[\s>]/.test(src), `${rel} must declare an <h1> element`);
  assert.ok(
    src.includes('https://kolm.ai/agents'),
    `${rel} must declare canonical URL https://kolm.ai/agents`,
  );
  assert.ok(
    src.includes('/docs/recipes/agent'),
    `${rel} must reference /docs/recipes/agent`,
  );
  // Hero / h1 region must use the word "agent" somewhere — the page is the
  // agent landing.
  assert.ok(/agent/i.test(src), `${rel} must mention "agent"`);
  // Cool-slate only: no warm-paper.css import line. (Comments mentioning the
  // word are fine; an actual stylesheet import is not.)
  assert.ok(
    !/<link[^>]+href="\/warm-paper\.css"/.test(src),
    `${rel} must not import /warm-paper.css (cool-slate only)`,
  );
  assert.ok(!HONESTY_RE.test(src), `${rel} must not contain the word "honest"`);
  assert.equal(EMOJI_RE.test(src), false, `${rel} must contain no emoji codepoints`);
});

// ---------------------------------------------------------------------------
// 2. gateway-migration.html lock-in

test('W918-W2-2 — gateway-migration.html lists four gateway names, links to /openai-migration, no honesty', () => {
  const rel = 'public/gateway-migration.html';
  assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} must exist`);
  const src = readUtf8(rel);
  assert.ok(src.includes('<title>'), `${rel} must declare a <title> element`);
  assert.ok(/<h1[\s>]/.test(src), `${rel} must declare an <h1> element`);
  assert.ok(
    src.includes('https://kolm.ai/gateway-migration'),
    `${rel} must declare canonical URL https://kolm.ai/gateway-migration`,
  );
  for (const name of ['Portkey', 'Helicone', 'LiteLLM', 'OpenRouter']) {
    assert.ok(src.includes(name), `${rel} must mention "${name}"`);
  }
  assert.ok(
    src.includes('/openai-migration'),
    `${rel} must link to /openai-migration`,
  );
  assert.ok(
    !/<link[^>]+href="\/warm-paper\.css"/.test(src),
    `${rel} must not import /warm-paper.css (cool-slate only)`,
  );
  assert.ok(!HONESTY_RE.test(src), `${rel} must not contain the word "honest"`);
  assert.equal(EMOJI_RE.test(src), false, `${rel} must contain no emoji codepoints`);
});

// ---------------------------------------------------------------------------
// 3. hobbyist.html lock-in

test('W918-W2-3 — hobbyist.html mentions Apple Silicon + Raspberry Pi + 16 GB GPU, links to /quickstart', () => {
  const rel = 'public/hobbyist.html';
  assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} must exist`);
  const src = readUtf8(rel);
  assert.ok(/<h1[\s>]/.test(src), `${rel} must declare an <h1> element`);
  assert.ok(
    src.includes('https://kolm.ai/hobbyist'),
    `${rel} must declare canonical URL https://kolm.ai/hobbyist`,
  );
  assert.ok(src.includes('Apple Silicon'), `${rel} must mention "Apple Silicon"`);
  assert.ok(src.includes('Raspberry Pi'), `${rel} must mention "Raspberry Pi"`);
  // "16 GB" with a regular space or non-breaking space.
  assert.ok(
    /16[\s ]*GB[^a-z]/i.test(src),
    `${rel} must mention a 16 GB GPU constraint`,
  );
  assert.ok(src.includes('/quickstart'), `${rel} must link to /quickstart`);
  assert.ok(!HONESTY_RE.test(src), `${rel} must not contain the word "honest"`);
  assert.equal(EMOJI_RE.test(src), false, `${rel} must contain no emoji codepoints`);
});

// ---------------------------------------------------------------------------
// 4. account/org.html lock-in
//
// Account templates inherit the site-wide warm-paper cascade (W836); the
// page-specific styling overrides it with cool-slate tokens. We assert
// structure + links + no honesty, not the absence of the inherited CSS link.

test('W918-W2-4 — account/org.html has Organization h1, links to /account/members + /account/audit-log, dialog or transfer trigger', () => {
  const rel = 'public/account/org.html';
  assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} must exist`);
  const src = readUtf8(rel);
  // <h1> mentions Organization (case-insensitive — "Organization settings" ok).
  const h1Match = src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  assert.ok(h1Match, `${rel} must contain an <h1> element`);
  assert.ok(
    /organization/i.test(h1Match[1]),
    `${rel} <h1> must contain "Organization" — got: ${h1Match[1]}`,
  );
  assert.ok(
    src.includes('/account/members'),
    `${rel} must link to /account/members`,
  );
  assert.ok(
    src.includes('/account/audit-log'),
    `${rel} must link to /account/audit-log`,
  );
  // Either a real <dialog> element or some transfer-owner trigger (button /
  // link / form referencing "transfer").
  const hasDialog = /<dialog[\s>]/i.test(src);
  const hasTransfer = /transfer/i.test(src);
  assert.ok(
    hasDialog || hasTransfer,
    `${rel} must contain a <dialog> element or a transfer-owner trigger`,
  );
  assert.ok(!HONESTY_RE.test(src), `${rel} must not contain the word "honest"`);
});

// ---------------------------------------------------------------------------
// 5. account/members.html lock-in

test('W918-W2-5 — account/members.html has Members h1, invite form, member table, link to /account/org', () => {
  const rel = 'public/account/members.html';
  assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} must exist`);
  const src = readUtf8(rel);
  const h1Match = src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  assert.ok(h1Match, `${rel} must contain an <h1> element`);
  assert.ok(
    /members/i.test(h1Match[1]),
    `${rel} <h1> must contain "Members" — got: ${h1Match[1]}`,
  );
  assert.ok(/<form[\s>]/i.test(src), `${rel} must contain a <form> element`);
  assert.ok(/<table[\s>]/i.test(src), `${rel} must contain a <table> element`);
  assert.ok(
    src.includes('/account/org'),
    `${rel} must link to /account/org`,
  );
  assert.ok(!HONESTY_RE.test(src), `${rel} must not contain the word "honest"`);
});

// ---------------------------------------------------------------------------
// 6. healthcare.html polish lock-in

test('W918-W2-6 — healthcare.html polished: w918-bar class, links to /openai-migration + /government + /docs/receipts', () => {
  const rel = 'public/healthcare.html';
  assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} must exist`);
  const src = readUtf8(rel);
  assert.ok(src.includes('w918-bar'), `${rel} must contain the "w918-bar" class`);
  assert.ok(
    src.includes('/openai-migration'),
    `${rel} must link to /openai-migration`,
  );
  assert.ok(
    src.includes('/government'),
    `${rel} must link to /government`,
  );
  assert.ok(
    src.includes('/docs/receipts'),
    `${rel} must link to /docs/receipts`,
  );
  assert.ok(!HONESTY_RE.test(src), `${rel} must not contain the word "honest"`);
});

// ---------------------------------------------------------------------------
// 7. audit-log.html polish lock-in

test('W918-W2-7 — audit-log.html polished: org.create + member.add + owner.transfer + data-orgevents-count + role-chip', () => {
  const rel = 'public/account/audit-log.html';
  assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} must exist`);
  const src = readUtf8(rel);
  assert.ok(src.includes('org.create'), `${rel} must contain "org.create" event type`);
  assert.ok(src.includes('member.add'), `${rel} must contain "member.add" event type`);
  assert.ok(src.includes('owner.transfer'), `${rel} must contain "owner.transfer" event type`);
  assert.ok(
    src.includes('data-orgevents-count'),
    `${rel} must contain "data-orgevents-count" placeholder`,
  );
  assert.ok(src.includes('role-chip'), `${rel} must contain "role-chip" CSS class`);
  assert.ok(!HONESTY_RE.test(src), `${rel} must not contain the word "honest"`);
});

// ---------------------------------------------------------------------------
// 8. blog 2026-06-02 lock-in

test('W918-W2-8 — blog/2026-06-02-distilling-agents.html mentions "agent", canonical, >= 700 words, no honesty', () => {
  const rel = 'public/blog/2026-06-02-distilling-agents.html';
  assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} must exist`);
  const src = readUtf8(rel);
  const h1Match = src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  assert.ok(h1Match, `${rel} must contain an <h1> element`);
  assert.ok(
    /distilling agents|agent/i.test(h1Match[1]),
    `${rel} <h1> must mention "Distilling agents" or "agent" — got: ${h1Match[1]}`,
  );
  assert.ok(
    src.includes('https://kolm.ai/blog/distilling-agents'),
    `${rel} must declare canonical URL https://kolm.ai/blog/distilling-agents`,
  );
  assert.ok(!HONESTY_RE.test(src), `${rel} must not contain the word "honest"`);
  // Word count: strip HTML tags + style/script bodies, then count whitespace
  // separated tokens. We need >= 700 visible words.
  const textOnly = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
  const words = textOnly.split(/\s+/).filter((w) => w.length > 0);
  assert.ok(
    words.length >= 700,
    `${rel} must have >= 700 visible words; got ${words.length}`,
  );
});

// ---------------------------------------------------------------------------
// 9. blog 2026-06-04 lock-in

test('W918-W2-9 — blog/2026-06-04-distill-from-gateway-logs.html mentions "Portkey" or "gateway logs", canonical, >= 700 words', () => {
  const rel = 'public/blog/2026-06-04-distill-from-gateway-logs.html';
  assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} must exist`);
  const src = readUtf8(rel);
  const titleMatch = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  assert.ok(titleMatch, `${rel} must contain a <title> element`);
  assert.ok(
    /portkey|gateway logs/i.test(titleMatch[1]),
    `${rel} <title> must mention "Portkey" or "gateway logs" — got: ${titleMatch[1]}`,
  );
  assert.ok(
    src.includes('https://kolm.ai/blog/distill-from-gateway-logs'),
    `${rel} must declare canonical URL https://kolm.ai/blog/distill-from-gateway-logs`,
  );
  assert.ok(!HONESTY_RE.test(src), `${rel} must not contain the word "honest"`);
  const textOnly = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
  const words = textOnly.split(/\s+/).filter((w) => w.length > 0);
  assert.ok(
    words.length >= 700,
    `${rel} must have >= 700 visible words; got ${words.length}`,
  );
});

// ---------------------------------------------------------------------------
// 10. agent-trajectory module exports

test('W918-W2-10 — src/distill/agent-trajectory.js exports parseTrajectory, canonicalizeArgs, normalizeToolName with stable key sort', async () => {
  const mod = await import('../src/distill/agent-trajectory.js');
  assert.equal(
    typeof mod.parseTrajectory,
    'function',
    'src/distill/agent-trajectory.js must export parseTrajectory',
  );
  assert.equal(
    typeof mod.canonicalizeArgs,
    'function',
    'src/distill/agent-trajectory.js must export canonicalizeArgs',
  );
  assert.equal(
    typeof mod.normalizeToolName,
    'function',
    'src/distill/agent-trajectory.js must export normalizeToolName',
  );
  // Stable key sort: same canonical string regardless of input key order.
  const a = mod.canonicalizeArgs({ b: 2, a: 1 });
  const b = mod.canonicalizeArgs({ a: 1, b: 2 });
  assert.equal(
    a,
    b,
    `canonicalizeArgs must produce identical output regardless of key order; got "${a}" vs "${b}"`,
  );
});

// ---------------------------------------------------------------------------
// 11. openrouter importer exports

test('W918-W2-11 — src/importers/openrouter.js exports parse + parseFile; sample fixture yields 3 rows / 0 skipped', async () => {
  const mod = await import('../src/importers/openrouter.js');
  assert.equal(typeof mod.parse, 'function', 'openrouter.js must export parse');
  assert.equal(typeof mod.parseFile, 'function', 'openrouter.js must export parseFile');
  const fixturePath = path.join(repoRoot, 'data/eval-fixtures/openrouter-sample.jsonl');
  const result = mod.parseFile(fixturePath);
  assert.equal(
    result.rows.length,
    3,
    `parseFile on sample fixture must yield 3 rows; got ${result.rows.length}`,
  );
  assert.equal(
    result.skipped,
    0,
    `parseFile on sample fixture must skip 0 rows; got ${result.skipped}`,
  );
});

// ---------------------------------------------------------------------------
// 12. orgs + rbac modules

test('W918-W2-12 — src/orgs.js + src/rbac.js exist; rbac.ROLES.OWNER and rbac.can("owner","owner:transfer") match', async () => {
  const orgs = await import('../src/orgs.js');
  const rbac = await import('../src/rbac.js');
  assert.ok(orgs, 'src/orgs.js must be importable');
  assert.equal(
    rbac.ROLES.OWNER,
    'owner',
    'rbac.ROLES.OWNER must equal "owner"',
  );
  assert.equal(
    rbac.can('owner', 'owner:transfer'),
    true,
    'rbac.can("owner", "owner:transfer") must return true',
  );
});

// ---------------------------------------------------------------------------
// 13. vercel.json rewrites for Wave 2
//
// The 7 Wave 2 sources also collide with legacy `redirects` entries (e.g. the
// old /agents -> /product redirect). We only assert against `cfg.rewrites`,
// which is the array the W918 Wave 2 rewrites were appended to.

test('W918-W2-13 — vercel.json rewrites array contains each of the 7 Wave 2 source paths exactly once', () => {
  const cfg = JSON.parse(readUtf8('vercel.json'));
  const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
  const sources = [
    '/agents',
    '/gateway-migration',
    '/hobbyist',
    '/account/org',
    '/account/members',
    '/blog/distilling-agents',
    '/blog/distill-from-gateway-logs',
  ];
  for (const src of sources) {
    const hits = rewrites.filter((r) => r && r.source === src);
    assert.equal(
      hits.length,
      1,
      `vercel.json rewrites must contain { source: "${src}" } exactly once; got ${hits.length}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 14. server.js W918_PRETTY_REWRITES extended

test('W918-W2-14 — server.js W918_PRETTY_REWRITES contains all 7 Wave 2 routes', () => {
  const src = readUtf8('server.js');
  const routes = [
    '/agents',
    '/gateway-migration',
    '/hobbyist',
    '/account/org',
    '/account/members',
    '/blog/distilling-agents',
    '/blog/distill-from-gateway-logs',
  ];
  // Anchor to the W918_PRETTY_REWRITES block so we don't accidentally match
  // a hit elsewhere in the file.
  const blockMatch = src.match(/W918_PRETTY_REWRITES\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(blockMatch, 'server.js must declare a W918_PRETTY_REWRITES = [...] block');
  const block = blockMatch[1];
  for (const route of routes) {
    assert.ok(
      block.includes(`'${route}'`),
      `server.js W918_PRETTY_REWRITES must contain route '${route}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// 15. sw.js cache-version + wave-floor (W604/W829 regex+threshold convention)
//
// The parent orchestrator continuously bumps both CACHE_VERSION and the wave
// slug as later sub-waves ship (e.g. wave918-about-manifesto-collapse). We do
// NOT pin a literal version number or a literal slug suffix — that goes stale
// on the next bump. Instead we assert the documented floor: CACHE_VERSION must
// have reached >= 155 and the CACHE slug must carry a wave token >= 918.

test('W918-W2-15 — public/sw.js CACHE_VERSION reached >= 155 and CACHE wave token reached >= 918', () => {
  const src = readUtf8('public/sw.js');
  const verMatch = src.match(/CACHE_VERSION\s*=\s*(\d+)/);
  assert.ok(verMatch, 'public/sw.js must declare a "CACHE_VERSION = <n>" constant');
  assert.ok(
    parseInt(verMatch[1], 10) >= 155,
    `public/sw.js CACHE_VERSION must reach >= 155 (saw ${verMatch[1]}); coordinator bumps this`,
  );
  // The CACHE string is a single-line const at the top of the file.
  const cacheMatch = src.match(/const\s+CACHE\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(cacheMatch, 'public/sw.js must declare a CACHE = "<slug>" constant');
  const waves = [...cacheMatch[1].matchAll(/wave(\d{3,4})/g)].map((m) => parseInt(m[1], 10));
  assert.ok(waves.length > 0, `public/sw.js CACHE slug must carry a wave token; got "${cacheMatch[1]}"`);
  const maxWave = Math.max(...waves);
  assert.ok(
    maxWave >= 918,
    `public/sw.js CACHE wave token must reach >= 918 (saw max wave ${maxWave}); got "${cacheMatch[1]}"`,
  );
});

// ---------------------------------------------------------------------------
// 16. pioneer notes internal-only marker

test('W918-W2-16 — docs/research/pioneer-agent-mode-notes.md exists with INTERNAL / NOT FOR PUSH marker in first 200 chars', () => {
  const rel = 'docs/research/pioneer-agent-mode-notes.md';
  assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} must exist on disk`);
  const src = readUtf8(rel);
  const head = src.slice(0, 200);
  const hasMarker =
    /internal/i.test(head) ||
    /not for push/i.test(head) ||
    /never[- ]stage/i.test(head);
  assert.ok(
    hasMarker,
    `${rel} must contain an INTERNAL / NOT FOR PUSH / never-stage marker in the first 200 chars; got: ${JSON.stringify(head)}`,
  );
});
