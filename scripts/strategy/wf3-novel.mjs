export const meta = {
  name: 'kolm-strategy-wf3-novel',
  description: 'Harder greenfield round (web-only): TAM x pain x profile matrix -> invention-grade ideation at best-fit cells -> LIVE incumbent-existence check per idea -> novelty+fit gate -> shortlist',
  phases: [
    { title: 'Matrix', detail: 'build customer-profile x pain x TAM matrix + non-obvious openings (WebSearch + round-1 artifacts)' },
    { title: 'Ideate', detail: 'invention-grade wedges at the best-fit cells' },
    { title: 'NoveltyCheck', detail: 'live WebSearch: is this already built/funded? kill contested' },
    { title: 'Gate', detail: 'score survivors on TAM/pain/novelty/fit -> shortlist' },
  ],
};

const RAW1 = 'C:/Users/user/Desktop/kolmogorov-stack/research/strategy-2026/raw';

const KILL = `BULLDOZER KILL LIST (commoditized by Cloudflare/AWS/Azure/labs 6-18mo — DO NOT propose): gateways/routers, vector DBs, generic fine-tune-as-a-service, eval/observability dashboards, code sandboxes, standalone memory, no-code agent builders, single-dimension cost optimizers, C2PA/provenance, chatbot wrappers, browser-automation wrappers.`;
const FOUNDER = `FOUNDER: solo/small, cold start, reachable network = AI-native startups; strong technical skills (distillation, quantization, eval/replay verification, gateway capture, signed receipts); self-serve + hand-sell; wants TWO-SPEED (fast-cash wedge clearing ~$25k/mo in ~8 weeks via contingency/services-to-product, funding a durable invention-grade bulldozer-proof bet). Open weights are at parity => no foundation model; only build a model if the model trained on PROPRIETARY data IS the moat.`;
const RULE = `HARD RULE: round one died because every idea was already shipped by a funded incumbent or a lab. This round must surface GENUINELY UNCONTESTED or STRUCTURALLY-NOVEL wedges. Hunt the un-swarmed, huge-TAM, non-AI-native / boring / physical / overlooked spaces and invention-grade primitives — NOT crowded dev-tooling. Every idea must have a concrete reason a funded startup or frontier lab is NOT already doing it (or structurally cannot).`;
const WEB = `Use WebSearch + WebFetch for all live research (Crunchbase/TechCrunch/news/company sites/Reddit/HN). Be specific and current to 2026; cite sources.`;

phase('Matrix');
const MATRIX_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['cells'],
  properties: { cells: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['profile', 'pain', 'tam', 'pain_intensity', 'buying_speed', 'founder_fit', 'why_open'],
    properties: { profile: { type: 'string' }, pain: { type: 'string' }, tam: { type: 'string' },
      pain_intensity: { type: 'integer' }, buying_speed: { type: 'string' }, founder_fit: { type: 'integer' }, why_open: { type: 'string' } } } } },
};
const NOVELTY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['openings'],
  properties: { openings: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['opening', 'why_uncontested', 'why_now', 'why_lab_cant'],
    properties: { opening: { type: 'string' }, why_uncontested: { type: 'string' }, why_now: { type: 'string' }, why_lab_cant: { type: 'string' } } } } },
};
const [matrix, novelty] = await parallel([
  () => agent(`${WEB}\nAlso read files matching ${RAW1}/t1-*.json and ${RAW1}/t4-*.json (round-1 funding + X-grounded demand research; each has a .content field) for grounding.\n\nBuild the CUSTOMER-PROFILE x PAIN x TAM MATRIX: up to 14 cells, each = a specific buyer profile + their top unsolved AI-addressable pain. Hunt the BIGGEST TAM x most acute pain, especially in un-swarmed / non-AI-native / boring / physical / overlooked spaces. Score pain_intensity 1-5 and founder_fit 1-5 (fit to: ${FOUNDER}). tam = market size with a number + source. buying_speed = how fast they decide+pay. why_open = why no one has nailed it yet (verify via WebSearch that it's genuinely open). Rank biggest+most-painful+best-fit first.`, { label: 'matrix:tam', phase: 'Matrix', agentType: 'Explore', schema: MATRIX_SCHEMA }),
  () => agent(`${WEB}\nAlso read files matching ${RAW1}/t5-*.json and ${RAW1}/t3-*.json (round-1 whitespace + bulldozer research) for grounding.\n\nFind up to 12 GENUINELY UNCONTESTED or invention-grade OPENINGS for a new AI business in 2026. For each: the opening; why_uncontested (WebSearch to CONFIRM no funded incumbent owns it — name what you searched); why_now (what changed in 2026); why_lab_cant (why a frontier lab/hyperscaler structurally won't/can't take it). ${RULE}`, { label: 'matrix:novelty', phase: 'Matrix', agentType: 'Explore', schema: NOVELTY_SCHEMA }),
]);
const cells = ((matrix && matrix.cells) || []).slice().sort((a, b) => (b.pain_intensity * b.founder_fit) - (a.pain_intensity * a.founder_fit));
const topCells = cells.slice(0, 8);
const openings = ((novelty && novelty.openings) || []).slice(0, 6);
const targets = [
  ...topCells.map((c) => ({ kind: 'cell', label: `${c.profile} :: ${c.pain}`, detail: JSON.stringify(c) })),
  ...openings.map((o) => ({ kind: 'opening', label: o.opening.slice(0, 50), detail: JSON.stringify(o) })),
];
log(`Matrix: ${cells.length} cells, ${openings.length} openings -> ${targets.length} ideation targets`);

phase('Ideate');
const IDEAS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ideas'],
  properties: { ideas: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['name', 'one_liner', 'buyer', 'tam', 'pain', 'wedge', 'why_uncontested', 'invention', 'bulldozer_distance', 'fast_cash_8wk', 'needs_model', 'rough_25k_path'],
    properties: { name: { type: 'string' }, one_liner: { type: 'string' }, buyer: { type: 'string' }, tam: { type: 'string' },
      pain: { type: 'string' }, wedge: { type: 'string' }, why_uncontested: { type: 'string' }, invention: { type: 'string' },
      bulldozer_distance: { type: 'string' }, fast_cash_8wk: { type: 'string' }, needs_model: { type: 'string' }, rough_25k_path: { type: 'string' } } } } },
};
const ideaBatches = await parallel(targets.map((t) => () =>
  agent(`You are a world-class founder generating INVENTION-GRADE, NON-OBVIOUS AI business wedges at this target (biggest-TAM x pain x fit). TARGET (${t.kind}): ${t.detail}\n\n${FOUNDER}\n${KILL}\n${RULE}\n${WEB}\n\nBefore finalizing each idea, WebSearch "who is building <idea>, any funded startups or lab features?" and DISCARD anything already well-served; keep only genuinely uncontested or structurally-novel wedges. Generate 5 ideas. Each: name; one_liner; buyer; tam (number); pain; wedge; why_uncontested (concrete reason no funded startup/lab does this, from your search); invention (what's genuinely new/forward-looking); bulldozer_distance (why safe 18mo+); fast_cash_8wk (realistic path to first $ or 'slow'); needs_model (none|distill|finetune|foundation); rough_25k_path. Be specific and ambitious; avoid generic 'AI for X'.`,
    { label: `ideate:${t.label.slice(0, 18)}`, phase: 'Ideate', agentType: 'Explore', schema: IDEAS_SCHEMA }
  )
));
let ideas = ideaBatches.filter(Boolean).flatMap((b) => b.ideas || []);
const seen = new Set();
ideas = ideas.filter((i) => { const k = (i.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24); if (!k || seen.has(k)) return false; seen.add(k); return true; });
log(`Ideated ${ideas.length} unique candidates`);

phase('NoveltyCheck');
const NC_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name', 'contested', 'incumbents', 'structural_novelty', 'survives', 'reason'],
  properties: { name: { type: 'string' }, contested: { type: 'string', enum: ['none', 'some', 'heavy'] },
    incumbents: { type: 'array', items: { type: 'string' } }, structural_novelty: { type: 'string' },
    survives: { type: 'boolean' }, reason: { type: 'string' } },
};
const checks = await parallel(ideas.map((i) => () =>
  agent(`Live-verify whether this idea is already built/funded. ${WEB} Run 1-3 targeted searches for funded startups, OSS projects, or lab/hyperscaler features that already do it.\n\nIDEA: ${JSON.stringify({ name: i.name, one_liner: i.one_liner, wedge: i.wedge, buyer: i.buyer })}\n\ncontested = none|some|heavy. incumbents = named players found (with funding if known). structural_novelty = the angle (if any) that survives despite incumbents. survives = true ONLY if (contested != heavy) OR there is a genuine structural-novelty angle a funded incumbent/lab cannot easily copy. reason = one sentence.`,
    { label: `nc:${(i.name || '').slice(0, 18)}`, phase: 'NoveltyCheck', agentType: 'Explore', schema: NC_SCHEMA }
  )
));
const ncMap = new Map();
for (const c of checks.filter(Boolean)) ncMap.set((c.name || '').toLowerCase(), c);
const survivors = ideas.map((i) => ({ ...i, nc: ncMap.get((i.name || '').toLowerCase()) })).filter((i) => i.nc && i.nc.survives);
log(`NoveltyCheck: ${survivors.length}/${ideas.length} survive as uncontested/novel`);

phase('Gate');
const SCORE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['scores'],
  properties: { scores: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['name', 'tam', 'pain', 'novelty', 'founder_fit', 'fast_cash', 'bulldozer', 'verdict', 'reason'],
    properties: { name: { type: 'string' }, tam: { type: 'integer' }, pain: { type: 'integer' }, novelty: { type: 'integer' },
      founder_fit: { type: 'integer' }, fast_cash: { type: 'integer' }, bulldozer: { type: 'integer' },
      verdict: { type: 'string', enum: ['keep', 'kill'] }, reason: { type: 'string' } } } } },
};
const chunks = [];
for (let i = 0; i < survivors.length; i += 8) chunks.push(survivors.slice(i, i + 8));
const scoreBatches = await parallel(chunks.map((ch, ci) => () =>
  agent(`Ruthless seed partner. Score each idea 1-5 on: tam, pain (acuteness+budget), novelty (genuinely non-obvious/invention-grade, uncontested), founder_fit (fit to: ${FOUNDER}), fast_cash (can clear ~$25k in 8wk via contingency/services), bulldozer (safe from labs/hyperscalers 18mo+). verdict='kill' if tam<=2 OR pain<=2 OR novelty<=2 OR on the kill list. reason=one sentence.\n\nIDEAS:\n${JSON.stringify(ch.map((i) => ({ name: i.name, one_liner: i.one_liner, buyer: i.buyer, tam: i.tam, wedge: i.wedge, why_uncontested: i.why_uncontested, invention: i.invention, contested: i.nc && i.nc.contested })), null, 1)}`,
    { label: `gate:${ci + 1}`, phase: 'Gate', schema: SCORE_SCHEMA }
  )
));
const sMap = new Map();
for (const b of scoreBatches.filter(Boolean)) for (const s of b.scores || []) sMap.set((s.name || '').toLowerCase(), s);
const scored = survivors.map((i) => {
  const s = sMap.get((i.name || '').toLowerCase()) || {};
  const composite = (s.tam || 0) + (s.pain || 0) + (s.novelty || 0) + (s.founder_fit || 0) + (s.fast_cash || 0) + (s.bulldozer || 0);
  return { ...i, score: s, composite };
});
const kept = scored.filter((i) => i.score.verdict === 'keep' && (i.score.tam || 0) >= 3 && (i.score.pain || 0) >= 3 && (i.score.novelty || 0) >= 3).sort((a, b) => b.composite - a.composite);
const shortlist = kept.slice(0, 14);
log(`Gate: ${kept.length} kept; shortlist ${shortlist.length}`);

return {
  matrix_cells: cells,
  openings,
  idea_count: ideas.length,
  survivor_count: survivors.length,
  shortlist: shortlist.map((i) => ({ name: i.name, one_liner: i.one_liner, buyer: i.buyer, tam: i.tam, pain: i.pain, wedge: i.wedge, why_uncontested: i.why_uncontested, invention: i.invention, bulldozer_distance: i.bulldozer_distance, fast_cash_8wk: i.fast_cash_8wk, needs_model: i.needs_model, rough_25k_path: i.rough_25k_path, contested: i.nc && i.nc.contested, incumbents: i.nc && i.nc.incumbents, composite: i.composite, score: i.score })),
  all_scored: scored.map((i) => ({ name: i.name, composite: i.composite, verdict: i.score.verdict, contested: i.nc && i.nc.contested, one_liner: i.one_liner })),
};
