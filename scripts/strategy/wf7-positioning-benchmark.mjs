export const meta = {
  name: 'kolm-positioning-benchmark',
  description: 'Dissect ~25 best-in-class / unicorn product sites for positioning + IA + proof + visual patterns, then synthesize a concrete rebuild spec for kolm.ai around the new AI-security-audit meta.',
  phases: [
    { title: 'Review', detail: 'deep-review reference sites (WebFetch + Grok) -> structured profiles' },
    { title: 'Synthesize', detail: 'cross-site patterns -> kolm rebuild spec (hero options, IA, visual, proof)' },
  ],
};

const GROK = 'node C:/Users/user/Desktop/kolmogorov-stack/scripts/grok-research.mjs';
const WEB = 'For each site, WebFetch its homepage (and /product or /platform if useful), AND run ' + GROK + ' --sources x,web "how does <company> position itself / what is notable about its website + hero + messaging in 2026" to enrich. Current to 2026; cite.';
const CTX = `GOAL: rebuild kolm.ai around a new meta — an AI-AGENT SECURITY-REVIEW READINESS audit product that issues cryptographically SIGNED, offline-verifiable evidence reports that unblock enterprise deals. Keep the kolm name + logo; change the entire site style + structure. CONSTRAINTS the founder set: NO named researchers anywhere (none recruited yet), ESPECIALLY not in the hero; the SITE + PRODUCT must itself be impressive enough to recruit elite security researchers and win enterprise buyers. Lead like a unicorn product (value/outcome/credibility-by-product), not "co-signed by X". Learn the actual positioning playbook of best-in-class sites so we are not off-the-mark.`;

phase('Review');
const SITE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['profiles'],
  properties: { profiles: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['site', 'category', 'hero', 'positioning_angle', 'structure', 'proof_elements', 'visual_style', 'why_it_works', 'lessons_for_kolm'],
    properties: {
      site: { type: 'string' }, category: { type: 'string' },
      hero: { type: 'object', additionalProperties: false, required: ['eyebrow', 'headline', 'subhead', 'primary_cta'], properties: { eyebrow: { type: 'string' }, headline: { type: 'string' }, subhead: { type: 'string' }, primary_cta: { type: 'string' } } },
      positioning_angle: { type: 'string' },
      structure: { type: 'array', items: { type: 'string' } },
      proof_elements: { type: 'array', items: { type: 'string' } },
      visual_style: { type: 'array', items: { type: 'string' } },
      why_it_works: { type: 'string' },
      lessons_for_kolm: { type: 'array', items: { type: 'string' } },
    } } } },
};
const batches = [
  { key: 'dev-infra', sites: ['vercel.com', 'linear.app', 'stripe.com', 'tailscale.com'] },
  { key: 'ai-apps', sites: ['cursor.com', 'perplexity.ai', 'sierra.ai', 'decagon.ai'] },
  { key: 'frontier-labs', sites: ['anthropic.com', 'openai.com', 'mistral.ai'] },
  { key: 'security-posture', sites: ['wiz.io', 'lakera.ai', 'snyk.io', 'sentry.io'] },
  { key: 'compliance-trust', sites: ['vanta.com', 'drata.com', 'secureframe.com', 'safebase.io'] },
  { key: 'eval-verifiable', sites: ['braintrust.dev', 'galileo.ai', 'sigstore.dev', 'opaque.co'] },
  { key: 'ai-security-emerging', sites: ['hiddenlayer.com', 'prompt.security', 'robustintelligence.com', 'noma.security'] },
];
const reviews = await parallel(batches.map((b) => () =>
  agent(`${CTX}\n\n${WEB}\n\nReview these sites: ${b.sites.join(', ')}. For EACH, return a profile: exact hero (eyebrow/headline/subhead/primary_cta as written), positioning_angle (the core promise), structure (homepage sections in order), proof_elements (how they build credibility — logos, metrics, demos, certs, docs), visual_style (type/color/layout/motion/density notes), why_it_works, and lessons_for_kolm. Be concrete; quote real hero copy.`,
    { label: `review:${b.key}`, phase: 'Review', agentType: 'Explore', schema: SITE_SCHEMA })
));
const profiles = reviews.filter(Boolean).flatMap((r) => r.profiles || []);
const digest = profiles.map((p) => `### ${p.site} [${p.category}]\nHERO: ${p.hero.eyebrow} | ${p.hero.headline} | ${p.hero.subhead} | CTA: ${p.hero.primary_cta}\nANGLE: ${p.positioning_angle}\nSTRUCTURE: ${p.structure.join(' > ')}\nPROOF: ${p.proof_elements.join(', ')}\nVISUAL: ${p.visual_style.join(', ')}\nWHY: ${p.why_it_works}\nLESSONS: ${p.lessons_for_kolm.join(' | ')}`).join('\n\n');
log(`Reviewed ${profiles.length} sites`);

phase('Synthesize');
const PLAYBOOK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['hero_formula', 'ia_patterns', 'proof_patterns', 'visual_patterns', 'unicorn_dos', 'unicorn_donts', 'kolm_hero_options', 'kolm_sitemap', 'kolm_homepage_sections', 'kolm_visual_direction', 'kolm_proof_strategy'],
  properties: {
    hero_formula: { type: 'string' },
    ia_patterns: { type: 'array', items: { type: 'string' } },
    proof_patterns: { type: 'array', items: { type: 'string' } },
    visual_patterns: { type: 'array', items: { type: 'string' } },
    unicorn_dos: { type: 'array', items: { type: 'string' } },
    unicorn_donts: { type: 'array', items: { type: 'string' } },
    kolm_hero_options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['eyebrow', 'headline', 'subhead', 'primary_cta', 'rationale'], properties: { eyebrow: { type: 'string' }, headline: { type: 'string' }, subhead: { type: 'string' }, primary_cta: { type: 'string' }, rationale: { type: 'string' } } } },
    kolm_sitemap: { type: 'array', items: { type: 'string' } },
    kolm_homepage_sections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['section', 'purpose', 'content'], properties: { section: { type: 'string' }, purpose: { type: 'string' }, content: { type: 'string' } } } },
    kolm_visual_direction: { type: 'array', items: { type: 'string' } },
    kolm_proof_strategy: { type: 'array', items: { type: 'string' } },
  },
};
const playbook = await agent(
  `${CTX}\n\nYou reviewed these best-in-class sites:\n${digest}\n\nSynthesize the UNICORN POSITIONING PLAYBOOK and apply it to kolm. hero_formula = the repeatable pattern top sites use (eyebrow/headline/subhead/CTA). ia_patterns / proof_patterns / visual_patterns = what the best share. unicorn_dos / unicorn_donts. THEN for kolm (agent-security-audit, signed evidence, NO named researchers in hero, lead with product value/outcome): kolm_hero_options = 4-5 concrete hero sets (eyebrow/headline/subhead/CTA + rationale), each unicorn-grade; kolm_sitemap = the new page set; kolm_homepage_sections = section-by-section spec (section, purpose, content); kolm_visual_direction = concrete style (keep kolm logo; pick palette/type/layout/motion direction modeled on the best, e.g. premium/technical/high-contrast); kolm_proof_strategy = product-led credibility (live in-browser receipt-verify demo, Halborn badge, transparency log, the signed-evidence artifact, metrics) — NOT people. Be specific and buildable.`,
  { label: 'synth:playbook', phase: 'Synthesize', schema: PLAYBOOK_SCHEMA }
);

return { profiles, playbook };
