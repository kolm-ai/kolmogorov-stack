export const meta = {
  name: 'kolm-strategy-wf1-ideate',
  description: 'Deca-granular strategy: synthesize Grok/X evidence -> cross-cut analysis -> greenfield ideation (12 lenses) -> 4-gate kill/dedup/score -> shortlist',
  phases: [
    { title: 'Synthesize', detail: 'one Explore agent per research track reads the raw Grok artifacts' },
    { title: 'Analyze', detail: 'bulldozer map, whitespace map, winner-pattern' },
    { title: 'Ideate', detail: '12 greenfield idea lenses, ~10 ideas each' },
    { title: 'Gate', detail: 'adversarial 4-gate scoring + dedup -> shortlist' },
  ],
};

const RAW = 'C:/Users/user/Desktop/kolmogorov-stack/research/strategy-2026/raw';
const GROK = 'node C:/Users/user/Desktop/kolmogorov-stack/scripts/grok-research.mjs';

const TRACKS = [
  { key: 'funding', prefix: 't1', focus: 'who raised $50M+ / crossed $1B in 2025-2026, fastest ARR, and the shared pattern of the winners' },
  { key: 'velocity', prefix: 't2', focus: 'what is growing fastest right now by revenue/usage/adoption and what builders are excited about on X' },
  { key: 'bulldozer', prefix: 't3', focus: 'what frontier labs + hyperscalers are commoditizing now and next 6-18mo, and what is structurally safe' },
  { key: 'demand', prefix: 't4', focus: 'what founders/teams are in pain about and PAYING for today; explicit wishlist; budget holders' },
  { key: 'whitespace', prefix: 't5', focus: 'underserved categories with budget, emerging primitives, regulation-driven openings, VC theses' },
  { key: 'landscape', prefix: 't6', focus: 'competitive maps per category: who owns what, funding, what is commoditized, the gaps' },
];

const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['track', 'top_findings', 'dominant_pattern', 'whitespace_signals', 'bulldozer_risks', 'notable_companies'],
  properties: {
    track: { type: 'string' },
    top_findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fact', 'evidence'], properties: { fact: { type: 'string' }, evidence: { type: 'string' } } } },
    dominant_pattern: { type: 'string' },
    whitespace_signals: { type: 'array', items: { type: 'string' } },
    bulldozer_risks: { type: 'array', items: { type: 'string' } },
    notable_companies: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'what', 'signal'], properties: { name: { type: 'string' }, what: { type: 'string' }, signal: { type: 'string' } } } },
  },
};

phase('Synthesize');
const synth = await parallel(TRACKS.map((t) => () =>
  agent(
    `You are a research analyst. Read EVERY file matching ${RAW}/${t.prefix}-*.json (use Glob then Read each; each file has a .content field of Grok web+X research with citations). Track focus: ${t.focus}.\n\nSynthesize the evidence for the "${t.key}" track into the schema. Rules: be specific and quantitative (names, $ amounts, dates, growth numbers); keep each fact one tight sentence with its source in 'evidence' (URL or publication+date); dominant_pattern = the single most important takeaway; whitespace_signals = concrete under-served openings the evidence implies; bulldozer_risks = what in this track is at risk of being commoditized by labs/hyperscalers. No fluff.`,
    { label: `synth:${t.key}`, phase: 'Synthesize', agentType: 'Explore', schema: SYNTH_SCHEMA }
  )
));
const synthOk = synth.filter(Boolean);
log(`Synthesized ${synthOk.length}/${TRACKS.length} tracks`);
const synthBrief = synthOk.map((s) => `### ${s.track}\nPATTERN: ${s.dominant_pattern}\nFINDINGS: ${s.top_findings.map((f) => f.fact).join(' | ')}\nWHITESPACE: ${s.whitespace_signals.join(' | ')}\nBULLDOZER-RISK: ${s.bulldozer_risks.join(' | ')}\nCOMPANIES: ${s.notable_companies.map((c) => `${c.name} (${c.what})`).join(' | ')}`).join('\n\n');

phase('Analyze');
const ANALYZE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'summary', 'points'],
  properties: { title: { type: 'string' }, summary: { type: 'string' }, points: { type: 'array', items: { type: 'string' } } },
};
const [bulldozer, whitespace, pattern] = await parallel([
  () => agent(`Using this evidence:\n${synthBrief}\n\nProduce the BULLDOZER MAP: what frontier labs/hyperscalers/open-weights will commoditize in the next 6-18 months (kill list) AND what is structurally protected (safe list: proprietary-data moats, distribution, regulation, deep workflow/real-world lock-in, trust/liability). points = concrete items tagged [KILL] or [SAFE] with a one-line reason. Verify anything uncertain by running: ${GROK} --sources x,web "<query>".`, { label: 'analyze:bulldozer', phase: 'Analyze', agentType: 'Explore', schema: ANALYZE_SCHEMA }),
  () => agent(`Using this evidence:\n${synthBrief}\n\nProduce the WHITESPACE+DEMAND MAP: where is there real budget and pull TODAY but no dominant winner? points = concrete openings, each with the demand evidence and why it is still open. Prioritize openings a small team can enter and a founder will pay for now.`, { label: 'analyze:whitespace', phase: 'Analyze', agentType: 'Explore', schema: ANALYZE_SCHEMA }),
  () => agent(`Using this evidence:\n${synthBrief}\n\nProduce the WINNER-PATTERN: what do the biggest and fastest-growing 2026 AI businesses share (category, business model, pricing, wedge, GTM)? points = the repeatable ingredients of a fast-growing, defensible 2026 AI business, each with an example company.`, { label: 'analyze:pattern', phase: 'Analyze', agentType: 'Explore', schema: ANALYZE_SCHEMA }),
]);
const analysisBrief = [bulldozer, whitespace, pattern].filter(Boolean).map((a) => `## ${a.title}\n${a.summary}\n- ${a.points.join('\n- ')}`).join('\n\n');

phase('Ideate');
const LENSES = [
  { key: 'fastest-growth-rider', angle: 'Ride the single fastest-growing vector in the funding/velocity evidence. Where money and usage are exploding, what adjacent business captures that wave?' },
  { key: 'data-moat', angle: 'Businesses whose moat is a proprietary data + feedback loop that compounds and that labs cannot replicate. Bulldozer-proof by data.' },
  { key: 'top-founder-pain', angle: 'Directly solve the most-cited, highest-budget founder/team pain from the demand evidence. Painkiller, not vitamin.' },
  { key: 'wishlist', angle: 'Build exactly what founders/engineers explicitly said they WISH existed. Quote the demand.' },
  { key: 'new-primitive', angle: 'Productize an emerging AI primitive (verifiable inference, agent payments, agent identity, memory, sandboxes, world models, on-device agents) into a real product with a buyer today.' },
  { key: 'regulation-driven', angle: 'Businesses created by 2026 AI regulation/enforcement. Mandatory budget, deadline-driven.' },
  { key: 'pick-and-shovel', angle: 'Underbuilt infrastructure that nearly every AI/agent company needs but is missing or fragmented.' },
  { key: 'vertical-agent-lockin', angle: 'A vertical AI agent with deep real-world workflow/system integration and switching cost - safe from horizontal labs.' },
  { key: 'fast-cash-services-to-product', angle: 'A productized high-ACV offer that bills $5-25k within weeks (the two-speed FAST leg) and compounds into recurring software.' },
  { key: 'anti-bulldozer-contrarian', angle: 'Bet against what labs will commoditize: own the layer they structurally cannot (distribution, trust/liability, real-world integration, neutrality across vendors).' },
  { key: 'open-weights-arbitrage', angle: 'Exploit open-weights/base-model commoditization to create NEW value (own/run/verify/specialize/serve) that did not exist when models were closed.' },
  { key: 'category-creator', angle: 'An invention-grade, forward-looking category a full magnitude ahead - what a great founder would build for where the puck is going.' },
];
const IDEAS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'ideas'],
  properties: {
    lens: { type: 'string' },
    ideas: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['name', 'one_liner', 'buyer', 'pays_today_evidence', 'wedge', 'differentiation', 'bulldozer_distance', 'growth_vector', 'fast_cash_8wk', 'needs_model', 'rough_25k_path'],
      properties: {
        name: { type: 'string' }, one_liner: { type: 'string' }, buyer: { type: 'string' },
        pays_today_evidence: { type: 'string' }, wedge: { type: 'string' },
        differentiation: { type: 'string' }, bulldozer_distance: { type: 'string' },
        growth_vector: { type: 'string' }, fast_cash_8wk: { type: 'string' },
        needs_model: { type: 'string', enum: ['none', 'distill', 'finetune', 'foundation'] },
        rough_25k_path: { type: 'string' },
      } } },
  },
};
const ideaBatches = await parallel(LENSES.map((L) => () =>
  agent(
    `You are a world-class founder + seed VC generating GREENFIELD AI business ideas (no obligation to reuse any existing assets). LENS: ${L.key} - ${L.angle}\n\nEVIDENCE (2026, Grok web+X):\n${synthBrief}\n\n${analysisBrief}\n\nGenerate 9 distinct, SPECIFIC ideas through this lens. Each must plausibly clear all four gates: (G1) a real buyer pays TODAY (cite the demand signal), (G2) >=1 order-of-magnitude differentiation from existing players (not a feature a competitor ships in a sprint), (G3) survives the bulldozer >=18 months (say why), (G4) rides a fast-growth vector. Be concrete: name it, name the buyer, name the wedge. Avoid generic "AI for X" and avoid commodity gateway/observability/eval-dashboard clones. For fast_cash_8wk, state the realistic path to first $ in 8 weeks (or say 'slow'). needs_model = none|distill|finetune|foundation. Spot-check live competitors/claims with: ${GROK} --sources x,web "<query>".`,
    { label: `ideate:${L.key}`, phase: 'Ideate', schema: IDEAS_SCHEMA }
  )
));
let allIdeas = ideaBatches.filter(Boolean).flatMap((b) => (b.ideas || []).map((i) => ({ ...i, lens: b.lens })));
// dedup by normalized name
const seen = new Set();
allIdeas = allIdeas.filter((i) => { const k = (i.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24); if (!k || seen.has(k)) return false; seen.add(k); return true; });
log(`Generated ${allIdeas.length} unique ideas across ${LENSES.length} lenses`);

phase('Gate');
const SCORE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['scores'],
  properties: { scores: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['name', 'g1_pays_today', 'g2_differentiation', 'g3_bulldozer_survival', 'g4_growth_vector', 'invention', 'verdict', 'reason'],
    properties: {
      name: { type: 'string' },
      g1_pays_today: { type: 'integer' }, g2_differentiation: { type: 'integer' },
      g3_bulldozer_survival: { type: 'integer' }, g4_growth_vector: { type: 'integer' },
      invention: { type: 'integer' }, verdict: { type: 'string', enum: ['keep', 'kill'] }, reason: { type: 'string' },
    } } } },
};
// chunk ideas for judging
const chunks = [];
for (let i = 0; i < allIdeas.length; i += 10) chunks.push(allIdeas.slice(i, i + 10));
const scoreBatches = await parallel(chunks.map((ch, ci) => () =>
  agent(
    `You are a ruthless seed-stage investment partner. Score each idea 1-5 on: g1_pays_today (real buyer pays now), g2_differentiation (>=1 order of magnitude vs incumbents), g3_bulldozer_survival (safe from labs/hyperscalers 18mo+), g4_growth_vector (rides a fast-growing wave), invention (forward-looking novelty). verdict='kill' if ANY of g1-g4 <= 2 OR it is a commodity gateway/observability/eval clone. Be harsh; most should be kill. reason = one sentence.\n\nIDEAS:\n${JSON.stringify(ch.map((i) => ({ name: i.name, one_liner: i.one_liner, buyer: i.buyer, wedge: i.wedge, differentiation: i.differentiation, bulldozer_distance: i.bulldozer_distance, pays_today: i.pays_today_evidence })), null, 1)}`,
    { label: `gate:${ci + 1}`, phase: 'Gate', schema: SCORE_SCHEMA }
  )
));
const scoreMap = new Map();
for (const b of scoreBatches.filter(Boolean)) for (const s of b.scores || []) scoreMap.set((s.name || '').toLowerCase(), s);
const scored = allIdeas.map((i) => {
  const s = scoreMap.get((i.name || '').toLowerCase()) || {};
  const composite = (s.g1_pays_today || 0) + (s.g2_differentiation || 0) + (s.g3_bulldozer_survival || 0) + (s.g4_growth_vector || 0) + (s.invention || 0);
  return { ...i, score: s, composite };
});
const survivors = scored
  .filter((i) => i.score.verdict === 'keep' && (i.score.g1_pays_today || 0) >= 3 && (i.score.g2_differentiation || 0) >= 3 && (i.score.g3_bulldozer_survival || 0) >= 3 && (i.score.g4_growth_vector || 0) >= 3)
  .sort((a, b) => b.composite - a.composite);
const shortlist = survivors.slice(0, 16);
log(`Gate: ${survivors.length} survivors; shortlist top ${shortlist.length}`);

return {
  synth: synthOk,
  analysis: { bulldozer, whitespace, pattern },
  idea_count: allIdeas.length,
  survivor_count: survivors.length,
  shortlist,
  all_scored: scored.map((i) => ({ name: i.name, lens: i.lens, composite: i.composite, verdict: i.score.verdict, one_liner: i.one_liner })),
};
