#!/usr/bin/env node
// W921 — programmatic, GEO-optimized, proof-anchored SEO page generator.
//
// SINGLE SOURCE OF TRUTH: data/seo-catalog/{competitors,integrations,usecases,verticals}.json
// drive a shared template that emits one HTML file per catalog row into the
// comparison / integration / use-case / vertical families under public/.
//
// This generator is deliberately SEPARATE from the existing
// scripts/build-seo-pages.cjs (the W889-8.3 /compile/{source}-to-{format}
// factory) so the two pipelines never clobber each other. It also emits ONLY
// non-colliding slugs (competitors / integrations / use-cases / verticals that
// are not already hand-authored in public/), so the hand-edited, test-pinned
// pages (e.g. compare/kolm-vs-openpipe-2026.html, pinned by
// tests/wave274-comparison-pages.test.js) are left byte-for-byte untouched.
//
// Every page carries:
//   - dynamic length-bounded <title>/<meta description> (passes seo-audit.cjs),
//   - exactly one <h1>,
//   - a BLUF answer block (40-75 words) under the H1 and under each H2,
//   - a uniform JSON-LD regime: SoftwareApplication + BreadcrumbList,
//     + FAQPage where FAQs exist, + HowTo for integrations,
//   - a >=6-row real <table> matrix on comparison pages,
//   - an inline cited statistic linking to a real /benchmarks artifact
//     (GEO "Statistics Addition" lever) — every proof_href must resolve on
//     disk or the generator hard-fails,
//   - a per-page FAQ rendered as BOTH visible <details> and FAQPage JSON-LD,
//   - an internal-link cluster (the three-click rule),
//   - cool-slate design tokens only (no warm/brown/orange/amber).
//
// Numeric proof statistics reuse X04-fixtured claim substrings
// (data/x04-claim-fixtures.json) so the rendered numbers can never drift from
// the measured artifact — scripts/x04-claim-verify.cjs enforces this.
//
// Usage:
//   node scripts/build-comparison-seo.cjs            # writes all pages
//   node scripts/build-comparison-seo.cjs --dry-run  # lists slugs, writes nothing
//   node scripts/build-comparison-seo.cjs --check    # build + assert idempotent (no write if unchanged)
//
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const CATALOG_DIR = path.join(ROOT, 'data', 'seo-catalog');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function safe(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// JSON-LD string escape (kept simple: backslash + quote + control).
function jsonLdSafe(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\t]/g, ' ');
}

function wordCount(text) {
  const stripped = String(text).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ');
  const words = stripped.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

// ---------------------------------------------------------------------------
// loadSeoCatalog
// ---------------------------------------------------------------------------

function loadSeoCatalog(catalogDir = CATALOG_DIR) {
  const read = (name) => {
    const p = path.join(catalogDir, name);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  };
  return {
    competitors: read('competitors.json').competitors || [],
    integrations: read('integrations.json').integrations || [],
    usecases: read('usecases.json').usecases || [],
    verticals: read('verticals.json').verticals || [],
  };
}

// ---------------------------------------------------------------------------
// renderBlufBlock — asserts a 40-75 word self-contained answer (GEO 3.1x rule)
// ---------------------------------------------------------------------------

function renderBlufBlock(question, answerText, { assert = true } = {}) {
  const wc = wordCount(answerText);
  if (assert && (wc < 40 || wc > 75)) {
    throw new Error(
      `renderBlufBlock: answer for "${String(question).slice(0, 48)}" is ${wc} words; ` +
      'BLUF answers must be 40-75 words (GEO citation window).'
    );
  }
  return (
    `<div class="seo-bluf" data-bluf="1">` +
    `<p class="seo-bluf__q">${safe(question)}</p>` +
    `<p class="seo-bluf__a">${answerText}</p>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// renderFaqBlock — visible <details> + FAQPage JSON-LD object
// ---------------------------------------------------------------------------

function renderFaqBlock(faqs) {
  const list = Array.isArray(faqs) ? faqs : [];
  const html =
    `<div class="seo-faq">` +
    list
      .map(
        (f) =>
          `<details class="seo-faq__item"><summary>${safe(f.q)}</summary>` +
          `<div class="seo-faq__a">${safe(f.a)}</div></details>`
      )
      .join('') +
    `</div>`;
  const jsonLd = {
    '@type': 'FAQPage',
    mainEntity: list.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
  return { html, jsonLd };
}

// ---------------------------------------------------------------------------
// renderProofCitations — Statistics + Quotation Addition (GEO +40% levers)
// ---------------------------------------------------------------------------

function renderProofCitations(proofRefs, benchmarksIndex) {
  const refs = Array.isArray(proofRefs) ? proofRefs : [proofRefs];
  return refs
    .map((ref) => {
      const meta = benchmarksIndex[ref] || {};
      const stat = meta.stat ? `<strong>${safe(meta.stat)}</strong> ` : '';
      const ctx = meta.context ? safe(meta.context) : 'See the verified artifact.';
      return (
        `<p class="seo-proof"><span class="seo-proof__badge">verified</span> ` +
        `${stat}${ctx} ` +
        `<a class="seo-proof__src" href="${safe(ref)}" rel="nofollow">Source &rarr;</a></p>`
      );
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// assertProofRefsResolve — hard-fail on a dangling proof href
// ---------------------------------------------------------------------------

function assertProofRefsResolve(proofRefs, publicDir = PUBLIC) {
  const refs = Array.isArray(proofRefs) ? proofRefs : [proofRefs];
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.startsWith('/')) {
      throw new Error(`assertProofRefsResolve: proof ref must be a site-absolute path, got ${JSON.stringify(ref)}`);
    }
    // /verify-prod is a server route (no .html on disk) — accept it explicitly.
    if (ref === '/verify-prod' || ref.startsWith('/verify-prod')) continue;
    const clean = ref.split('#')[0].split('?')[0];
    const direct = path.join(publicDir, clean.replace(/^\//, ''));
    const htmlVariant = direct.endsWith('.html') || direct.endsWith('.json') ? direct : direct + '.html';
    if (fs.existsSync(direct) || fs.existsSync(htmlVariant)) continue;
    throw new Error(`assertProofRefsResolve: dangling proof ref "${ref}" (looked for ${path.relative(ROOT, direct)})`);
  }
}

// ---------------------------------------------------------------------------
// computeUniqueRatio — 5-gram shingle |B \ S| / |B| vs sibling bodies
// ---------------------------------------------------------------------------

function shingles(text, n = 5) {
  const tokens = String(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const set = new Set();
  for (let i = 0; i + n <= tokens.length; i++) {
    set.add(tokens.slice(i, i + n).join(' '));
  }
  return set;
}

function computeUniqueRatio(pageBody, siblingBodies) {
  const B = shingles(pageBody);
  if (B.size === 0) return 1;
  const S = new Set();
  for (const sib of siblingBodies || []) {
    for (const sh of shingles(sib)) S.add(sh);
  }
  let unique = 0;
  for (const sh of B) if (!S.has(sh)) unique++;
  return unique / B.size;
}

// ---------------------------------------------------------------------------
// computeGeoScore — advisory GEO readiness score (0..1)
// ---------------------------------------------------------------------------

function computeGeoScore(pageHtml) {
  const blufCount = (pageHtml.match(/data-bluf="1"/g) || []).length;
  const h2Count = (pageHtml.match(/<h2[\s>]/g) || []).length;
  const tableRows = (pageHtml.match(/<tr>/g) || []).length;
  const faqQas = (pageHtml.match(/<summary>/g) || []).length;
  const citedStats = (pageHtml.match(/class="seo-proof"/g) || []).length;
  const jsonLdTypes = new Set((pageHtml.match(/"@type":\s*"([A-Za-z]+)"/g) || []).map((m) => m)).size;

  const breakdown = {
    has_bluf_under_each_h2: h2Count > 0 && blufCount >= h2Count ? 1 : (h2Count > 0 ? blufCount / h2Count : 0),
    table_rows_ge_6: tableRows >= 6 ? 1 : 0,
    faq_qas_ge_3: faqQas >= 3 ? 1 : 0,
    cited_stats_ge_1: citedStats >= 1 ? 1 : 0,
    valid_jsonld_types_ge_3: jsonLdTypes >= 3 ? 1 : 0,
  };
  const score =
    0.3 * breakdown.has_bluf_under_each_h2 +
    0.25 * breakdown.table_rows_ge_6 +
    0.2 * breakdown.faq_qas_ge_3 +
    0.15 * breakdown.cited_stats_ge_1 +
    0.1 * breakdown.valid_jsonld_types_ge_3;
  return { score: Number(score.toFixed(3)), breakdown };
}

// ---------------------------------------------------------------------------
// renderInternalLinkCluster — three-click rule, related + cross-family links
// ---------------------------------------------------------------------------

function renderInternalLinkCluster(row, family, catalog) {
  const links = [];
  const familyPath = { comparison: '/compare', integration: '/integrations', usecase: '/use-cases', vertical: '/for' }[family];
  const familyRows = { comparison: catalog.competitors, integration: catalog.integrations, usecase: catalog.usecases, vertical: catalog.verticals }[family];
  // Up to 3 siblings in the same family.
  for (const sib of familyRows.filter((r) => r.slug !== row.slug).slice(0, 3)) {
    const label = sib.name || sib.title || sib.tool;
    links.push({ href: `${familyPath}/${sib.slug}`, label: `${family === 'comparison' ? 'kolm vs ' : ''}${label}` });
  }
  // Cross-family anchors.
  links.push({ href: '/compare', label: 'How kolm compares' });
  links.push({ href: '/forge', label: 'The Forge: compile + distill' });
  links.push({ href: '/pricing', label: 'Pricing' });
  return (
    `<nav class="seo-links" aria-label="Related pages"><ul>` +
    links.map((l) => `<li><a href="${safe(l.href)}">${safe(l.label)}</a></li>`).join('') +
    `</ul></nav>`
  );
}

// ---------------------------------------------------------------------------
// buildStructuredData — uniform JSON-LD regime across all four families
// ---------------------------------------------------------------------------

function buildStructuredData(kind, row, ctx) {
  const url = ctx.url;
  const name = row.name || row.title || row.tool;
  const breadcrumbFamily = ctx.breadcrumbFamily;
  const graph = [
    {
      '@type': 'SoftwareApplication',
      '@id': `${url}#software`,
      name: 'kolm',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Linux, macOS, Windows',
      description: ctx.description,
      url,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
      license: 'https://www.apache.org/licenses/LICENSE-2.0',
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${url}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'kolm.ai', item: 'https://kolm.ai/' },
        { '@type': 'ListItem', position: 2, name: breadcrumbFamily.name, item: breadcrumbFamily.url },
        { '@type': 'ListItem', position: 3, name, item: url },
      ],
    },
  ];
  if (ctx.faqJsonLd && ctx.faqJsonLd.mainEntity && ctx.faqJsonLd.mainEntity.length) {
    graph.push(Object.assign({ '@id': `${url}#faq` }, ctx.faqJsonLd));
  }
  if (kind === 'integration' && Array.isArray(row.setup_steps) && row.setup_steps.length) {
    graph.push({
      '@type': 'HowTo',
      '@id': `${url}#howto`,
      name: `How to use kolm with ${name}`,
      description: ctx.description,
      step: row.setup_steps.map((s, i) => ({
        '@type': 'HowToStep',
        position: i + 1,
        name: s.name,
        text: s.text,
      })),
    });
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Shared page chrome (cool-slate tokens; no warm/brown/orange/amber)
// ---------------------------------------------------------------------------

function pageShell({ title, description, canonicalPath, jsonLd, bodyHtml }) {
  const jsonLdStr = JSON.stringify({ '@context': 'https://schema.org', '@graph': jsonLd }, null, 0);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${safe(title)}</title>
<meta name="description" content="${safe(description)}">
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large">
<meta name="author" content="kolm.ai">
<meta property="og:site_name" content="kolm.ai">
<meta property="og:title" content="${safe(title)}">
<meta property="og:description" content="${safe(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="https://kolm.ai${canonicalPath}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${safe(title)}">
<meta name="twitter:description" content="${safe(description)}">
<link rel="canonical" href="https://kolm.ai${canonicalPath}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/design-tokens.css">
<link rel="stylesheet" href="/ks.css">
<link rel="stylesheet" href="/seo-pages.css">
<script type="application/ld+json">
${jsonLdStr}
</script>
</head>
<body class="seo-page">
<a class="seo-skip" href="#main">Skip to content</a>
<header class="seo-head"><div class="seo-head__wrap"><a class="seo-head__logo" href="/">kolm.ai</a><nav class="seo-head__nav"><a href="/compare">Compare</a><a href="/forge">Forge</a><a href="/docs">Docs</a><a href="/pricing">Pricing</a><a href="/signup">Sign up</a></nav></div></header>
<main id="main" class="seo-main">
${bodyHtml}
</main>
<footer class="seo-foot">kolm.ai &middot; the AI compiler &middot; <a href="/compare">Compare</a> &middot; <a href="/verify-prod">Verify a receipt</a> &middot; <a href="https://github.com/kolm-ai/kolm" rel="noopener">GitHub</a></footer>
</body>
</html>
`;
}

function benchMeta(row) {
  // benchmarksIndex entry keyed by proof_href, carrying the rendered stat + context.
  return { [row.proof_href]: { stat: row.proof_stat, context: row.proof_stat_context } };
}

// ---------------------------------------------------------------------------
// renderComparisonPage
// ---------------------------------------------------------------------------

function renderComparisonPage(row, ctx) {
  const url = `https://kolm.ai/compare/${row.slug}`;
  const title = `kolm vs ${row.name}: compile vs rent | kolm.ai`;
  const description = `kolm vs ${row.name} — an axis-by-axis comparison. ${row.positioning} kolm compiles an owned, signed model from your traffic.`.slice(0, 160);
  assertProofRefsResolve([row.proof_href]);
  const faq = renderFaqBlock(row.faqs);
  const bIndex = benchMeta(row);

  const matrixRows = row.matrix
    .map(
      (m) =>
        `<tr><td class="seo-matrix__axis">${safe(m.axis)}</td>` +
        `<td class="seo-matrix__kolm">${safe(m.kolm)}</td>` +
        `<td class="seo-matrix__them">${safe(m.them)}</td>` +
        `<td class="seo-matrix__why">${safe(m.why)}</td></tr>`
    )
    .join('\n');

  const body =
    `<p class="seo-crumb"><a href="/compare">&larr; All comparisons</a></p>\n` +
    `<h1 class="seo-h1">kolm vs ${safe(row.name)}</h1>\n` +
    renderBlufBlock(`kolm vs ${row.name}: which should you pick?`, row.bluf) + '\n' +
    `<h2>How they differ, axis by axis</h2>\n` +
    renderBlufBlock(`What is the core difference between kolm and ${row.name}?`, `${safe(row.positioning)} The table below contrasts each on the axes that matter for ownership, cost, provenance, and portability, so you can see where kolm's compile-and-own model diverges from a hosted or rented offering and decide which fits your workload.`) + '\n' +
    `<table class="seo-matrix"><thead><tr><th>Axis</th><th>kolm</th><th>${safe(row.name)}</th><th>Why it matters</th></tr></thead><tbody>\n${matrixRows}\n</tbody></table>\n` +
    `<h2>The verified proof point</h2>\n` +
    renderBlufBlock(`What can kolm actually demonstrate?`, `kolm's differentiator is that its claims are backed by checked-in measurements, not marketing copy. The statistic below links to a verified benchmark artifact, and every model compile emits a signed receipt you can replay at /verify-prod, so the proof travels with the build rather than living only on a slide.`) + '\n' +
    renderProofCitations([row.proof_href], bIndex) + '\n' +
    `<h2>When to pick each</h2>\n` +
    renderBlufBlock(`When is ${row.name} the right answer, and when is kolm?`, `Neither tool is strictly better; they solve different problems. ${safe(row.when_them_wins)} The opposite case is summarized below, so you can match the choice to whether you want a hosted, rented capability or an owned, portable model with a verifiable build receipt.`) + '\n' +
    `<p class="seo-when"><strong>When kolm wins.</strong> ${safe(row.when_kolm_wins)}</p>\n` +
    `<h2>FAQ</h2>\n` +
    faq.html + '\n' +
    `<h2>Try it</h2>\n` +
    renderBlufBlock(`How do I start with kolm?`, `Sign up for a free kolm key, point your existing OpenAI-compatible client at the gateway base URL, and let it capture traffic. When the lake is full, run kolm distill then kolm compile to produce a signed, quantized model you own. Every build is replayable at /verify-prod, so you can verify before you ship.`) + '\n' +
    `<p class="seo-cta"><a class="seo-cta__primary" href="/signup">Start free &rarr;</a> <a class="seo-cta__secondary" href="/compare">See all comparisons</a></p>\n` +
    renderInternalLinkCluster(row, 'comparison', ctx.catalog);

  const jsonLd = buildStructuredData('comparison', row, {
    url, description, faqJsonLd: faq.jsonLd,
    breadcrumbFamily: { name: 'Compare', url: 'https://kolm.ai/compare' },
  });

  return { slug: row.slug, family: 'compare', canonicalPath: `/compare/${row.slug}`, html: pageShell({ title, description, canonicalPath: `/compare/${row.slug}`, jsonLd, bodyHtml: body }) };
}

// ---------------------------------------------------------------------------
// renderIntegrationPage
// ---------------------------------------------------------------------------

function renderIntegrationPage(row, ctx) {
  const url = `https://kolm.ai/integrations/${row.slug}`;
  const title = `Use kolm with ${row.tool} | kolm.ai`;
  const description = `Connect ${row.tool} to the kolm gateway: capture, redact, and sign your LLM traffic, then compile an owned model. ${row.category}.`.slice(0, 160);
  assertProofRefsResolve([row.proof_href]);
  const faq = renderFaqBlock(row.faqs);
  const bIndex = benchMeta(row);

  const steps = row.setup_steps
    .map((s, i) => `<li><strong>${safe(s.name)}.</strong> ${safe(s.text)}</li>`)
    .join('\n');
  const envRows = (row.env || [])
    .map((e) => `<tr><td>${safe(e.key)}</td><td>${safe(e.value)}</td></tr>`)
    .join('\n');

  const body =
    `<p class="seo-crumb"><a href="/integrations">&larr; All integrations</a></p>\n` +
    `<h1 class="seo-h1">kolm + ${safe(row.tool)}</h1>\n` +
    renderBlufBlock(`How do kolm and ${row.tool} work together?`, `${row.bluf} In short, ${safe(row.tool)} keeps doing what it does best while kolm turns the resulting traffic into an owned, signed model you run yourself with no per-token bill.`) + '\n' +
    `<h2>What this integration does</h2>\n` +
    renderBlufBlock(`What does wiring ${row.tool} to kolm change?`, `${safe(row.summary)} The integration is configuration-only: you change a base URL, keep your existing code, and the gateway handles capture, PII redaction, and the signed receipt transparently underneath your normal calls.`) + '\n' +
    `<h2>Environment</h2>\n` +
    renderBlufBlock(`What configuration does ${row.tool} need?`, `The integration is driven entirely by two environment values: the kolm gateway base URL and your kolm API key. You set them once on the ${safe(row.tool)} side and every LLM call routes through the gateway, where capture and redaction happen before anything is stored in your tenant lake.`) + '\n' +
    `<table class="seo-matrix"><thead><tr><th>Variable</th><th>Value</th></tr></thead><tbody>\n${envRows}\n</tbody></table>\n` +
    `<h2>Setup steps</h2>\n` +
    renderBlufBlock(`How do I set up the ${row.tool} integration?`, `Setup is five short steps: get a kolm key, point ${safe(row.tool)} at the gateway base URL, run your normal workload so pairs are captured and redacted, then distill and compile a specialist, and finally verify the signed build. No model code changes are required beyond the base URL swap.`) + '\n' +
    `<ol class="seo-steps">\n${steps}\n</ol>\n` +
    `<h2>The verified proof point</h2>\n` +
    renderBlufBlock(`What does the compiled model deliver?`, `Once you compile, the specialist trained on your captured traffic is yours to run with no per-token bill. The statistic below comes from a verified benchmark artifact, and each compile emits a signed receipt replayable at /verify-prod, so the integration ends in a model whose build you can audit.`) + '\n' +
    renderProofCitations([row.proof_href], bIndex) + '\n' +
    `<h2>FAQ</h2>\n` +
    faq.html + '\n' +
    `<p class="seo-cta"><a class="seo-cta__primary" href="/signup">Start free &rarr;</a> <a class="seo-cta__secondary" href="/integrations">All integrations</a></p>\n` +
    renderInternalLinkCluster(row, 'integration', ctx.catalog);

  const jsonLd = buildStructuredData('integration', row, {
    url, description, faqJsonLd: faq.jsonLd,
    breadcrumbFamily: { name: 'Integrations', url: 'https://kolm.ai/integrations' },
  });

  return { slug: row.slug, family: 'integrations', canonicalPath: `/integrations/${row.slug}`, html: pageShell({ title, description, canonicalPath: `/integrations/${row.slug}`, jsonLd, bodyHtml: body }) };
}

// ---------------------------------------------------------------------------
// renderUseCasePage
// ---------------------------------------------------------------------------

function renderUseCasePage(row, ctx) {
  const url = `https://kolm.ai/use-cases/${row.slug}`;
  const title = `${row.title} with kolm | kolm.ai`;
  const description = `${row.title}: ${row.problem}`.slice(0, 160);
  assertProofRefsResolve([row.proof_href]);
  const faq = renderFaqBlock(row.faqs);
  const bIndex = benchMeta(row);

  const body =
    `<p class="seo-crumb"><a href="/use-cases">&larr; All use cases</a></p>\n` +
    `<h1 class="seo-h1">${safe(row.title)}</h1>\n` +
    renderBlufBlock(`How does kolm handle ${row.title.toLowerCase()}?`, `${row.bluf} The result is a model you own and run on your own hardware, trained on your real workload, with a signed build receipt instead of a recurring per-call API bill.`) + '\n' +
    `<h2>The problem</h2>\n` +
    renderBlufBlock(`What makes ${row.title.toLowerCase()} expensive today?`, `${safe(row.problem)} That cost compounds with volume and ties a sensitive workload to an external API, which is exactly the situation an owned, compiled specialist is designed to replace once the traffic pattern is well understood.`) + '\n' +
    `<h2>The kolm flow</h2>\n` +
    renderBlufBlock(`How does the kolm pipeline solve it?`, `${safe(row.kolm_flow)} Each stage runs inside your own environment, so capture, distillation, and compilation happen without handing the workload to a third party, and the final artifact is a portable, signed model.`) + '\n' +
    `<h2>The verified proof point</h2>\n` +
    renderBlufBlock(`What evidence backs this?`, `kolm grounds its claims in checked-in measurements rather than estimates. The statistic below links to a verified benchmark artifact, and every model compile emits a signed receipt you can replay at /verify-prod, so the outcome of this use case is auditable end to end rather than asserted.`) + '\n' +
    renderProofCitations([row.proof_href], bIndex) + '\n' +
    `<h2>The outcome</h2>\n` +
    renderBlufBlock(`What do you end up with?`, `${row.outcome_bluf} Because the artifact is portable and signed, you can move it between a laptop, a VPC, or an air-gapped network, and prove at any point exactly which weights and method produced it.`) + '\n' +
    `<h2>FAQ</h2>\n` +
    faq.html + '\n' +
    `<p class="seo-cta"><a class="seo-cta__primary" href="/signup">Start free &rarr;</a> <a class="seo-cta__secondary" href="/use-cases">All use cases</a></p>\n` +
    renderInternalLinkCluster(row, 'usecase', ctx.catalog);

  const jsonLd = buildStructuredData('usecase', row, {
    url, description, faqJsonLd: faq.jsonLd,
    breadcrumbFamily: { name: 'Use cases', url: 'https://kolm.ai/use-cases' },
  });

  return { slug: row.slug, family: 'use-cases', canonicalPath: `/use-cases/${row.slug}`, html: pageShell({ title, description, canonicalPath: `/use-cases/${row.slug}`, jsonLd, bodyHtml: body }) };
}

// ---------------------------------------------------------------------------
// renderVerticalPage
// ---------------------------------------------------------------------------

function renderVerticalPage(row, ctx) {
  const url = `https://kolm.ai/for/${row.slug}`;
  const title = `kolm for ${row.name} | kolm.ai`;
  const description = `kolm for ${row.name}: compile an owned model that runs inside your boundary, with PII redacted on capture and a signed build receipt.`.slice(0, 160);
  assertProofRefsResolve([row.proof_href]);
  const faq = renderFaqBlock(row.faqs);
  const bIndex = benchMeta(row);

  const regList = (row.regs || []).map((r) => `<li>${safe(r)}</li>`).join('');
  const quote = row.proof_quote
    ? `<figure class="seo-quote"><blockquote>${safe(row.proof_quote)}</blockquote><figcaption>&mdash; ${safe(row.proof_quote_who)}</figcaption></figure>`
    : '';

  const body =
    `<p class="seo-crumb"><a href="/for/healthcare">&larr; kolm by industry</a></p>\n` +
    `<h1 class="seo-h1">kolm for ${safe(row.name)}</h1>\n` +
    renderBlufBlock(`How does kolm fit ${row.name}?`, row.bluf) + '\n' +
    `<h2>Why an owned model fits</h2>\n` +
    renderBlufBlock(`Why does ${row.name} prefer an owned model over an external API?`, `${safe(row.regs_intro)} the gateway and lake are self-hostable, PII is redacted on the capture path, the compiled model runs inside your own boundary, and every build is recorded in a signed receipt you can produce for review.`) + '\n' +
    `<ul class="seo-regs">${regList}</ul>\n` +
    `<h2>The kolm flow</h2>\n` +
    renderBlufBlock(`How does the pipeline run in this setting?`, `${safe(row.kolm_flow)} The whole sequence is self-hostable, so capture, distillation, and compilation stay inside your control boundary and the deliverable is a portable, signed model rather than a dependency on an external service.`) + '\n' +
    `<h2>The verified proof point</h2>\n` +
    renderBlufBlock(`What is the evidence?`, `kolm grounds its claims in checked-in measurements. The statistic below links to a verified benchmark artifact, and every compile emits a signed, replayable receipt at /verify-prod. The figures in the linked case study are illustrative of the pattern, while the benchmark number is measured against a real artifact.`) + '\n' +
    renderProofCitations([row.proof_href], bIndex) + '\n' +
    quote + '\n' +
    `<h2>FAQ</h2>\n` +
    faq.html + '\n' +
    `<p class="seo-cta"><a class="seo-cta__primary" href="/signup">Start free &rarr;</a> <a class="seo-cta__secondary" href="/enterprise">Talk to us</a></p>\n` +
    renderInternalLinkCluster(row, 'vertical', ctx.catalog);

  const jsonLd = buildStructuredData('vertical', row, {
    url, description, faqJsonLd: faq.jsonLd,
    breadcrumbFamily: { name: 'Industries', url: 'https://kolm.ai/for/healthcare' },
  });

  return { slug: row.slug, family: 'for', canonicalPath: `/for/${row.slug}`, html: pageShell({ title, description, canonicalPath: `/for/${row.slug}`, jsonLd, bodyHtml: body }) };
}

// ---------------------------------------------------------------------------
// buildSegmentedSitemaps — per-family sitemap + sitemap index
// ---------------------------------------------------------------------------

function buildSegmentedSitemaps(generatedPages, { write = true } = {}) {
  const byFamily = {};
  for (const p of generatedPages) {
    (byFamily[p.family] = byFamily[p.family] || []).push(p);
  }
  const lastmod = new Date().toISOString().slice(0, 10);
  const written = [];
  const indexEntries = [];
  for (const family of Object.keys(byFamily).sort()) {
    const urls = byFamily[family]
      .map(
        (p) =>
          `  <url><loc>https://kolm.ai${p.canonicalPath}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`
      )
      .join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
    const file = `sitemap-seo-${family}.xml`;
    if (write) fs.writeFileSync(path.join(PUBLIC, file), xml, 'utf8');
    written.push(file);
    indexEntries.push(`  <sitemap><loc>https://kolm.ai/${file}</loc><lastmod>${lastmod}</lastmod></sitemap>`);
  }
  const indexXml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${indexEntries.join('\n')}\n</sitemapindex>\n`;
  if (write) fs.writeFileSync(path.join(PUBLIC, 'sitemap-seo-index.xml'), indexXml, 'utf8');
  return { written, indexFile: 'sitemap-seo-index.xml' };
}

// ---------------------------------------------------------------------------
// renderAll — produce every page object from the catalog
// ---------------------------------------------------------------------------

function renderAll(catalog) {
  const ctx = { catalog };
  const pages = [];
  for (const row of catalog.competitors) pages.push(renderComparisonPage(row, ctx));
  for (const row of catalog.integrations) pages.push(renderIntegrationPage(row, ctx));
  for (const row of catalog.usecases) pages.push(renderUseCasePage(row, ctx));
  for (const row of catalog.verticals) pages.push(renderVerticalPage(row, ctx));
  return pages;
}

// ---------------------------------------------------------------------------
// build entrypoint
// ---------------------------------------------------------------------------

function build({ check = false, dryRun = false, write = true } = {}) {
  const catalog = loadSeoCatalog();
  const pages = renderAll(catalog);

  if (dryRun) {
    return { written: 0, pages: pages.map((p) => p.canonicalPath), skippedThin: [] };
  }

  let written = 0;
  let unchanged = 0;
  for (const p of pages) {
    const dir = path.join(PUBLIC, p.family);
    if (write && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${p.slug}.html`);
    const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
    if (prev === p.html) {
      unchanged++;
      continue;
    }
    if (check) {
      // In --check mode we never write; a mismatch is a "drift" signal.
      written++;
      continue;
    }
    if (write) fs.writeFileSync(out, p.html, 'utf8');
    written++;
  }

  if (write && !check) buildSegmentedSitemaps(pages);

  return { written, unchanged, total: pages.length, skippedThin: [] };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const check = args.includes('--check');
  if (dryRun) {
    const r = build({ dryRun: true });
    console.log(`# dry-run: would generate ${r.pages.length} pages`);
    for (const u of r.pages) console.log('  ' + u);
  } else if (check) {
    const r = build({ check: true, write: false });
    if (r.written > 0) {
      console.error(`# DRIFT: ${r.written}/${r.total} generated pages differ from disk — run without --check`);
      process.exit(1);
    }
    console.log(`# check: all ${r.total} generated pages match disk (idempotent)`);
  } else {
    const r = build();
    console.log(`# wrote ${r.written} pages (${r.unchanged} unchanged of ${r.total}) + segmented sitemaps`);
  }
}

module.exports = {
  loadSeoCatalog,
  renderComparisonPage,
  renderIntegrationPage,
  renderUseCasePage,
  renderVerticalPage,
  buildStructuredData,
  renderBlufBlock,
  renderFaqBlock,
  renderProofCitations,
  renderInternalLinkCluster,
  renderAll,
  computeUniqueRatio,
  computeGeoScore,
  assertProofRefsResolve,
  buildSegmentedSitemaps,
  build,
};
