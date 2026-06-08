export const meta = {
  name: 'kolm-strategy-wf4-diligence',
  description: 'Web-only VC diligence + adversarial red-team on the round-2 (novel) shortlist, then IC ranking + two-speed plan + build-a-model answer',
  phases: [
    { title: 'Load', detail: 'bootstrap-read the round-2 shortlist from disk' },
    { title: 'Diligence', detail: 'live WebSearch competitor/market check per idea' },
    { title: 'RedTeam', detail: 'a skeptic tries to kill each finding' },
    { title: 'IC', detail: 'rank, two-speed plan, build-a-model answer, 8-week plan' },
  ],
};

const SHORTLIST_FILE = 'C:/Users/user/Desktop/kolmogorov-stack/research/strategy-2026/wf3-novel-output.json';
const WEB = 'Use WebSearch + WebFetch for all live research (Crunchbase/TechCrunch/news/company sites/Reddit/HN); current to 2026; cite sources.';

const EVIDENCE = `2026 context: AI ~50% of global VC. Fastest growers = vertical/applied AI with proprietary-data flywheels + speed to revenue (Cursor ~$2B ARR; Harvey $11B; Abridge; Cognition $492M ARR).
BULLDOZER KILL LIST (avoid): gateways/routers, vector DBs, generic FTaaS, eval/observability dashboards, sandboxes, standalone memory, no-code agent builders, single-dimension cost optimizers, C2PA/provenance, chatbot wrappers.
BULLDOZER SAFE (24-36mo): vertical AI w/ proprietary/regulated data + workflow lock-in; physical/real-world integration; licensure/liability; neutral cross-vendor positions a lab/hyperscaler is conflicted out of; proprietary datasets fine-tuned on open weights.
ROUND-1 LESSON: every round-1 idea was already shipped by a funded incumbent or a lab; this round-2 shortlist was pre-filtered for genuine novelty/uncontested space — verify that holds under harder scrutiny.
FOUNDER: cold start, network = AI-native startups, solo/small, self-serve + hand-sell, technical (distill/quantize/verify/capture/sign); wants TWO-SPEED — fast-cash wedge clearing ~$25k/mo in ~8 weeks (contingency/services ok) funding a durable bulldozer-proof bet. GREENFIELD. Open weights at parity => no foundation model; build a model only if a model on PROPRIETARY data IS the moat.`;

phase('Load');
const LOAD_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['shortlist'],
  properties: { shortlist: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['name', 'one_liner', 'buyer', 'tam', 'pain', 'wedge', 'why_uncontested', 'invention', 'bulldozer_distance', 'fast_cash_8wk', 'needs_model', 'rough_25k_path'],
    properties: {
      name: { type: 'string' }, one_liner: { type: 'string' }, buyer: { type: 'string' }, tam: { type: 'string' },
      pain: { type: 'string' }, wedge: { type: 'string' }, why_uncontested: { type: 'string' }, invention: { type: 'string' },
      bulldozer_distance: { type: 'string' }, fast_cash_8wk: { type: 'string' }, needs_model: { type: 'string' }, rough_25k_path: { type: 'string' },
    } } } },
};
const loaded = await agent(
  `Read the large JSON file at ${SHORTLIST_FILE} and extract the array at the top-level key "shortlist" (it appears roughly at lines 170-415 of the file — use Read with offset/limit to find it). Return ALL of its items verbatim in the schema's shortlist array — do not drop, summarize, or invent. If a required field is missing in the source, copy the closest field or use an empty string.`,
  { label: 'load:shortlist3', phase: 'Load', agentType: 'Explore', schema: LOAD_SCHEMA }
);
const shortlist = (loaded && loaded.shortlist) || [];
log(`Loaded ${shortlist.length} round-2 ideas for diligence`);

const DILIGENCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'verdict', 'score', 'icp', 'wedge_product', 'live_competitors', 'market_size', 'growth_evidence', 'bulldozer_threat', 'defensibility', 'model_decision', 'gtm_cold_start', 'fast_cash_8wk', 'durable_bet', 'the_25k_math', 'risks', 'sources'],
  properties: {
    name: { type: 'string' }, verdict: { type: 'string', enum: ['pursue', 'maybe', 'pass'] }, score: { type: 'number' },
    icp: { type: 'string' }, wedge_product: { type: 'string' }, live_competitors: { type: 'array', items: { type: 'string' } },
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
    `You are a seed-stage investment partner writing a VC-grade diligence memo on this GREENFIELD AI business idea. ${WEB} Find CURRENT (2026) named competitors + funding + real willingness-to-pay evidence.\n\nIDEA: ${JSON.stringify(idea)}\n\nMARKET EVIDENCE:\n${EVIDENCE}\n\nFill the schema with brutal candor. live_competitors = real named companies w/ funding + what they do. market_size = numbers + source. growth_evidence = why it rides a fast vector. bulldozer_threat = could a frontier lab/hyperscaler flatten it in 18mo? defensibility = the actual moat. model_decision = none|distill|finetune|foundation + why. gtm_cold_start = how a solo founder with a startup network lands the first 10 customers. fast_cash_8wk = realistic path to ~$25k in 8wk (contingency/services ok) or why not. durable_bet = the bigger bulldozer-proof company this becomes. the_25k_math = explicit funnel/ACV arithmetic. verdict pursue/maybe/pass; score 1-10. Do not use the word 'honest'.`,
    { label: `dd:${(idea.name || '').slice(0, 22)}`, phase: 'Diligence', agentType: 'Explore', schema: DILIGENCE_SCHEMA }
  ),
  async (memo, idea) => {
    const rt = await agent(
      `You are a ruthless red-team skeptic. Try to KILL this idea. ${WEB} Find the competitor or commoditizer that makes it pointless, and check whether the buyer REALLY pays today.\n\nMEMO: ${JSON.stringify(memo)}\n\nName the single strongest competitor; the most likely commoditizer; whether the buyer will REALLY pay now; a bulldozer verdict. kill_or_survive = 'kill' unless it has a real moat AND proven willingness-to-pay AND >=18mo bulldozer-distance. One-paragraph reasoning.`,
      { label: `rt:${(idea.name || '').slice(0, 22)}`, phase: 'RedTeam', schema: REDTEAM_SCHEMA }
    );
    return { memo, redteam: rt };
  }
).then((r) => r.filter(Boolean));
log(`Diligence complete: ${results.length} memos`);

phase('IC');
const IC_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ranked', 'fast_cash_pick', 'durable_pick', 'best_fit_matrix_cell', 'two_speed_plan', 'build_a_model_answer', 'eight_week_plan', 'what_to_shelve', 'why_now', 'the_hard_truth'],
  properties: {
    ranked: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'score', 'one_line'], properties: { name: { type: 'string' }, score: { type: 'number' }, one_line: { type: 'string' } } } },
    fast_cash_pick: { type: 'string' }, durable_pick: { type: 'string' }, best_fit_matrix_cell: { type: 'string' },
    two_speed_plan: { type: 'string' }, build_a_model_answer: { type: 'string' },
    eight_week_plan: { type: 'array', items: { type: 'string' } },
    what_to_shelve: { type: 'string' }, why_now: { type: 'string' }, the_hard_truth: { type: 'string' },
  },
};
const verdict = await agent(
  `You are the investment committee chair. Rank ONLY the specific round-2 ideas below by their exact names; do not invent categories. Optimize for the founder's brief: a differentiated, forward-looking, INVENTION-GRADE business a magnitude away from frontier-lab/hyperscaler commoditization; the biggest TAM x pain x founder-fit; cold start; network = startups; TWO-SPEED (fast-cash wedge clearing ~$25k/mo near-term funding a durable bulldozer-proof bet).\n\nMARKET EVIDENCE:\n${EVIDENCE}\n\nDILIGENCE + RED-TEAM RESULTS (each = {memo, redteam}; 'kill' verdicts rank low):\n${JSON.stringify(results)}\n\nrank ALL by exact name. fast_cash_pick + durable_pick (from the list). best_fit_matrix_cell = the single customer-profile x product with the best TAM x pain x fit. two_speed_plan = how the fast leg funds + feeds the durable bet. build_a_model_answer = build a model? what kind (foundation/distill/finetune/none) and why. eight_week_plan = week-by-week to ~$25k. what_to_shelve. why_now. the_hard_truth = candid risk. Do not use the word 'honest'.`,
  { label: 'ic:final', phase: 'IC', schema: IC_SCHEMA }
);

return { loaded_count: shortlist.length, memos: results, verdict };
