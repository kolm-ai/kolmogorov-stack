export const meta = {
  name: 'kolm-strategy-wf2-diligence',
  description: 'VC-grade diligence + adversarial red-team per shortlisted idea, then IC ranking + two-speed plan + build-a-model answer',
  phases: [
    { title: 'Load', detail: 'bootstrap-read the 16-idea shortlist from disk' },
    { title: 'Diligence', detail: 'live competitor/market check per idea (Grok web+X)' },
    { title: 'RedTeam', detail: 'a skeptic tries to kill each finding' },
    { title: 'IC', detail: 'rank, two-speed plan, build-a-model answer, 8-week plan' },
  ],
};

const GROK = 'node C:/Users/user/Desktop/kolmogorov-stack/scripts/grok-research.mjs';
const SHORTLIST_FILE = 'C:/Users/user/Desktop/kolmogorov-stack/research/strategy-2026/shortlist.json';

const EVIDENCE = `2026 context (from a 44-query Grok web+X evidence base): AI is ~50% of global VC. Fastest growers = vertical/applied AI with proprietary-data flywheels + speed to revenue (Cursor ~$2B ARR fastest SaaS ever; Harvey $11B legal; Abridge healthcare 100+ systems; Cognition/Devin $492M ARR).
BULLDOZER KILL LIST (being commoditized by Cloudflare/AWS/Azure/labs in 6-18mo, AVOID): vector DBs, gateways/routers (Portkey/LiteLLM/OpenRouter), generic fine-tuning-as-a-service, simple eval/observability dashboards, code-exec sandboxes, standalone memory, horizontal agent frameworks, no-code agent builders, single-dimension inference cost optimizers, C2PA/content-provenance, generic chatbot wrappers, browser-automation wrappers.
BULLDOZER SAFE (24-36mo): vertical AI with proprietary/permissioned/regulated data + workflow lock-in (Harvey, Abridge, Tempus), physical/real-world integration (Figure, Waymo), professional licensure/liability moats, defense, proprietary datasets fine-tuned on open weights, neutral cross-vendor positions a lab/hyperscaler is conflicted out of.
WINNER PATTERN: narrow vertical wedge -> land-and-expand; practitioner/founder-led distribution; consumption+seat pricing; production reliability + governance; proprietary data flywheel / system-of-record lock-in; contingency or services-to-product for fast cash.
FOUNDER CONSTRAINTS: cold start, no distribution, reachable network = startups; solo/small; self-serve + founder hand-sell; wants TWO-SPEED — a fast-cash wedge that can realistically clear ~$25k/mo within ~8 weeks (contingency/services-to-product ok) funding a durable, invention-grade, bulldozer-proof bet. GREENFIELD aperture. Open-weights (Nemotron 3 550B+data, Qwen3.5, DeepSeek V4, gpt-oss) are at near-frontier parity under permissive licenses, so a FOUNDATION model is off the table; only build a model if the model itself is the moat (per-customer distillation/finetune on proprietary data).`;

phase('Load');
const LOAD_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['shortlist'],
  properties: { shortlist: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['name', 'one_liner', 'buyer', 'wedge', 'differentiation', 'bulldozer_distance', 'pays_today_evidence', 'fast_cash_8wk', 'needs_model', 'rough_25k_path'],
    properties: {
      name: { type: 'string' }, one_liner: { type: 'string' }, buyer: { type: 'string' }, wedge: { type: 'string' },
      differentiation: { type: 'string' }, bulldozer_distance: { type: 'string' }, pays_today_evidence: { type: 'string' },
      fast_cash_8wk: { type: 'string' }, needs_model: { type: 'string' }, rough_25k_path: { type: 'string' },
    } } } },
};
const loaded = await agent(
  `Read the JSON file at ${SHORTLIST_FILE} (an array of 16 idea objects). Return ALL of them verbatim in the schema's shortlist array — do not drop, summarize, merge, or invent any. Keep every field's text intact.`,
  { label: 'load:shortlist', phase: 'Load', agentType: 'Explore', schema: LOAD_SCHEMA }
);
const shortlist = (loaded && loaded.shortlist) || [];
log(`Loaded ${shortlist.length} ideas for diligence`);

const DILIGENCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'verdict', 'score', 'icp', 'wedge_product', 'live_competitors', 'market_size', 'growth_evidence', 'bulldozer_threat', 'defensibility', 'model_decision', 'gtm_cold_start', 'fast_cash_8wk', 'durable_bet', 'the_25k_math', 'risks', 'sources'],
  properties: {
    name: { type: 'string' }, verdict: { type: 'string', enum: ['pursue', 'maybe', 'pass'] }, score: { type: 'number' },
    icp: { type: 'string' }, wedge_product: { type: 'string' },
    live_competitors: { type: 'array', items: { type: 'string' } },
    market_size: { type: 'string' }, growth_evidence: { type: 'string' }, bulldozer_threat: { type: 'string' },
    defensibility: { type: 'string' }, model_decision: { type: 'string' }, gtm_cold_start: { type: 'string' },
    fast_cash_8wk: { type: 'string' }, durable_bet: { type: 'string' }, the_25k_math: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } }, sources: { type: 'array', items: { type: 'string' } },
  },
};
const REDTEAM_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'strongest_competitor', 'commoditizer', 'will_they_pay', 'bulldozer_verdict', 'kill_or_survive', 'reasoning'],
  properties: {
    name: { type: 'string' }, strongest_competitor: { type: 'string' }, commoditizer: { type: 'string' },
    will_they_pay: { type: 'string' }, bulldozer_verdict: { type: 'string' },
    kill_or_survive: { type: 'string', enum: ['kill', 'survive'] }, reasoning: { type: 'string' },
  },
};

phase('Diligence');
const results = await pipeline(
  shortlist,
  (idea) => agent(
    `You are a seed-stage investment partner writing a VC-grade diligence memo on this GREENFIELD AI business idea. Do LIVE research: run ${GROK} --sources x,web "<query>" several times to find CURRENT (2026) named competitors, their funding, and real demand/willingness-to-pay evidence; WebSearch/WebFetch too.\n\nIDEA: ${JSON.stringify(idea)}\n\nMARKET EVIDENCE:\n${EVIDENCE}\n\nFill the schema with brutal candor. live_competitors = real named companies w/ funding + what they do (from live search). market_size = numbers + source. growth_evidence = why it rides a fast vector. bulldozer_threat = could a frontier lab/hyperscaler flatten it in 18mo? defensibility = the actual moat (data/regulation/licensure/lock-in), not vibes. model_decision = none|distill|finetune|foundation + why. gtm_cold_start = how a solo founder with a STARTUP network lands the first 10 customers. fast_cash_8wk = realistic path to ~$25k in 8 weeks (contingency/services ok) or why not. durable_bet = the bigger bulldozer-proof company this becomes. the_25k_math = explicit funnel/ACV arithmetic. verdict pursue/maybe/pass; score 1-10. Do not use the word 'honest'.`,
    { label: `dd:${(idea.name || '').slice(0, 22)}`, phase: 'Diligence', agentType: 'Explore', schema: DILIGENCE_SCHEMA }
  ),
  async (memo, idea) => {
    const rt = await agent(
      `You are a ruthless red-team skeptic. Try to KILL this idea. Use ${GROK} --sources x,web "<query>" to find the competitor or commoditizer that makes it pointless, and check whether the buyer REALLY pays today.\n\nMEMO: ${JSON.stringify(memo)}\n\nName the single strongest competitor; the most likely commoditizer (lab/hyperscaler/open-source/incumbent); whether the buyer will REALLY pay now (or just says so); a bulldozer verdict. kill_or_survive = 'kill' unless it has a real moat AND proven willingness-to-pay AND >=18mo bulldozer-distance. One-paragraph reasoning.`,
      { label: `rt:${(idea.name || '').slice(0, 22)}`, phase: 'RedTeam', schema: REDTEAM_SCHEMA }
    );
    return { memo, redteam: rt };
  }
).then((r) => r.filter(Boolean));

log(`Diligence complete: ${results.length} memos`);

phase('IC');
const IC_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ranked', 'fast_cash_pick', 'durable_pick', 'two_speed_plan', 'build_a_model_answer', 'eight_week_plan', 'what_to_shelve', 'why_now', 'the_hard_truth'],
  properties: {
    ranked: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'score', 'one_line'], properties: { name: { type: 'string' }, score: { type: 'number' }, one_line: { type: 'string' } } } },
    fast_cash_pick: { type: 'string' }, durable_pick: { type: 'string' }, two_speed_plan: { type: 'string' },
    build_a_model_answer: { type: 'string' }, eight_week_plan: { type: 'array', items: { type: 'string' } },
    what_to_shelve: { type: 'string' }, why_now: { type: 'string' }, the_hard_truth: { type: 'string' },
  },
};
const verdict = await agent(
  `You are the investment committee chair. You MUST rank ONLY the specific ideas below (use their exact names); do not invent new categories. Optimize for the founder's brief: a differentiated, forward-looking, invention-grade business that grows fast AND sits a magnitude away from frontier-lab/hyperscaler commoditization; cold start; founder self-serve + hand-sell; reachable network = startups; TWO-SPEED (a fast-cash wedge that can clear ~$25k/mo near-term funding a durable bulldozer-proof bet).\n\nMARKET EVIDENCE:\n${EVIDENCE}\n\nDILIGENCE + RED-TEAM RESULTS (each item = {memo, redteam}; ideas whose red-team verdict is 'kill' rank low):\n${JSON.stringify(results)}\n\nrank ALL diligenced ideas by their exact names (best first). fast_cash_pick = the wedge to start now (name it from the list). durable_pick = the bulldozer-proof company it becomes (from the list, or how a fast-cash pick expands into one). two_speed_plan = how the fast leg funds + feeds the durable bet. build_a_model_answer = should the founder build a model, and exactly what kind (foundation/distill/finetune/none) and why, given open-weights commoditization. eight_week_plan = concrete week-by-week to first ~$25k. what_to_shelve = what NOT to do. why_now = the 2026 timing. the_hard_truth = the candid risk the founder must accept. Do not use the word 'honest'.`,
  { label: 'ic:final', phase: 'IC', schema: IC_SCHEMA }
);

return { loaded_count: shortlist.length, memos: results, verdict };
