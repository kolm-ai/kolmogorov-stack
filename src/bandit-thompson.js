// src/bandit-thompson.js
//
// W921 - Autopilot improvement-loop decision layer: a BUDGETED, NON-STATIONARY
// multi-armed bandit (Thompson sampling) over the autopilot's improvement
// strategies.
//
// PROBLEM. Each autopilot tick must answer: which improvement strategy
// (dedup / ingest-more / gap-fill / preference / evol) buys the most K-Score
// per dollar on THIS namespace's corpus right now? The shipping cost-optimizer
// (src/cost-optimizer.js, OFF-LIMITS / read-only) answers this with a one-shot
// greedy argmax over FROZEN characteristic feature-delta priors. It never learns
// which strategy actually paid off, never explores under uncertainty, and clamps
// regressions to zero. That is exactly a budgeted, non-stationary bandit:
//   arms   = strategies
//   reward = realized post-compile ΔK (continuous, CAN be negative)
//   cost   = teacher-token spend (near-deterministic)
// The reward distribution DRIFTS because the corpus changes every round (dedup
// stops paying once clean; ingest-more saturates per the data-scaling law), so a
// stationary policy is wrong by construction.
//
// MODEL (Normal-Gamma per arm). Reward is continuous, so the conjugate model is
// Normal-Gamma (a.k.a. Normal-Inverse-Gamma) per arm with unknown mean mu_a and
// precision tau_a and hyperparameters (mu0, kappa0, alpha0, beta0). Given a
// discounted effective count n_eff, discounted mean xbar and discounted
// sum-of-squares S, the posterior is:
//     kappa_n = kappa0 + n_eff
//     mu_n    = (kappa0 * mu0 + n_eff * xbar) / kappa_n
//     alpha_n = alpha0 + n_eff / 2
//     beta_n  = beta0 + 0.5 * S + 0.5 * (kappa0 * n_eff * (xbar - mu0)^2) / kappa_n
// A Thompson DRAW of arm a's mean reward is:
//     tau      ~ Gamma(shape = alpha_n, rate = beta_n)
//     mu_tilde ~ Normal(mu_n, 1 / (kappa_n * tau))
// (Honda & Takemura 2014; van den Burg NIG reference.)
//
// NON-STATIONARITY (Discounted TS, Qi et al. 2023). A discount gamma in (0,1]
// weights the j-th most-recent reward (j = 0 newest) by gamma^j, so:
//     n_eff = sum_j gamma^j
//     xbar  = (sum_j gamma^j r_j) / n_eff
//     S     = sum_j gamma^j (r_j - xbar)^2
// gamma ~ 0.9 forgets over ~10 effective rounds; gamma = 1 recovers stationary
// TS. (Sliding-window TS is the alternative; discounting is chosen because it
// needs no window buffer.)
//
// BUDGETED / COST-AWARE SELECTION (Xia et al. IJCAI 2015). The autopilot
// optimizes ΔK PER DOLLAR, so we pick argmax of the sampled-reward-over-cost
// RATIO, not the sampled mean: draw mu_tilde_a (NIG) and treat cost as a
// near-deterministic degenerate posterior; ratio_a = mu_tilde_a / max(cost_a,
// EPSILON); recommend argmax ratio_a among budget-feasible arms. dedup (cost = 0)
// floats to the top whenever its sampled reward > 0 - exactly the shipping
// behavior - preserved by the epsilon floor.
//
// WARM-START COLD-START (Empirical-Bayes / Dynamic-Prior TS). The hard part is
// the n = 0 cold start. Warm-start each arm's prior mean mu0_a from the caller's
// supplied prior (the cost-optimizer's existing characteristic-prior ΔK) with
// WEAK strength (kappa0 = 1, alpha0 = 1, beta0 set so prior var ~ (0.1)^2). At
// zero outcomes the sampled mean concentrates near the heuristic ranking
// (graceful degradation, no day-0 regression); realized rewards then override it.
//
// DETERMINISM. All randomness flows through an injectable rng() (defaults to
// Math.random). Tests pass a seeded mulberry32 so draws are reproducible. The
// module reads NO wall clock for its math; timestamps are only attached to
// ledger rows (the persistence side-channel) and never feed the posterior.
//
// PERSISTENCE. The strategy-outcome ledger rides src/event-store.js with a
// dedicated provider tag (kolm_strategy_bandit), W411 tenant + namespace fenced
// on every read. recordStrategyChoice writes a 'pending' row at SELECT (base_k +
// chosen strategy); recordStrategyOutcome folds a realized ΔK into the discounted
// posterior at OBSERVE. Both are best-effort: a record returns ok:true with
// persisted:false when the store is unavailable rather than failing the call.
//
// CONTRACT (sb-v1). Every exported function returns an envelope and NEVER throws
// across the public API (mirrors qp-v1 / co-v1 / kts-v1).

import crypto from 'node:crypto';
import * as eventStore from './event-store.js';

export const STRATEGY_BANDIT_VERSION = 'sb-v1';

// Event-store provider tag for the strategy-outcome ledger. Distinct from
// kolm_cost_plan / kolm_kscore_series so the ledger is queryable independently.
export const BANDIT_PROVIDER = 'kolm_strategy_bandit';

// Ledger workflow_ids. CHOICE rows are written at SELECT; OUTCOME rows at OBSERVE.
export const BANDIT_WORKFLOW = Object.freeze({
  CHOICE: 'bandit:choice',
  OUTCOME: 'bandit:outcome',
});

const DEFAULT_TENANT = 'tenant_local';
const DEFAULT_NAMESPACE = 'default';

// Default discount factor: forget over ~10 effective rounds (Qi et al. 2023).
export const DEFAULT_GAMMA = 0.9;

// Cost-ratio epsilon floor (mirrors cost-optimizer.SMALL_EPSILON) so a free arm
// (cost 0) gets a very large, finite ratio rather than Infinity.
export const DEFAULT_EPSILON = 1e-6;

// Weak warm-start prior strength. kappa0 = 1 (one pseudo-observation of the
// prior mean) + alpha0 = 1 keeps the n = 0 sampled mean concentrated near the
// supplied prior_mu while letting a handful of real outcomes dominate quickly.
export const PRIOR_KAPPA = 1;
export const PRIOR_ALPHA = 1;
// beta0 chosen so the prior marginal variance of the mean ~ (0.1)^2. With
// alpha0 = 1 the expected precision is alpha0/beta0, so beta0 = alpha0 * sigma^2
// = 1 * 0.01 = 0.01 gives E[tau] = 100 -> E[variance of one obs] = 0.01.
export const PRIOR_BETA = 0.01;

// ---------------------------------------------------------------------------
// Tiny helpers.
// ---------------------------------------------------------------------------

function _tenant(t) { return (t && String(t)) || DEFAULT_TENANT; }
function _ns(n) { return (n && String(n)) || DEFAULT_NAMESPACE; }
function _num(x, d = 0) { const v = Number(x); return Number.isFinite(v) ? v : d; }
function _isoNow() { return new Date().toISOString(); }
function _genChoiceId() { return 'sbc_' + crypto.randomBytes(8).toString('hex'); }

function _rng(rng) {
  return (typeof rng === 'function') ? rng : Math.random;
}

// ---------------------------------------------------------------------------
// _sampleNormal(mean, variance, rng) - Box-Muller. Seedable via rng.
// ---------------------------------------------------------------------------
function _sampleNormal(mean, variance, rng) {
  const r = _rng(rng);
  const v = Math.max(0, _num(variance, 0));
  if (v === 0) return _num(mean, 0);
  let u1 = 0;
  let u2 = 0;
  // Guard against log(0).
  while (u1 <= 0) u1 = r();
  u2 = r();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return _num(mean, 0) + Math.sqrt(v) * z;
}

// ---------------------------------------------------------------------------
// _sampleGamma(shape, rate, rng) - Marsaglia & Tsang (2000) method.
//
// Returns a draw from Gamma(shape, rate) where rate is the inverse-scale
// (so mean = shape / rate). One normal + one uniform per accepted draw; for
// shape < 1 we use the boosting trick X = X_{shape+1} * U^{1/shape}.
// ---------------------------------------------------------------------------
function _sampleGamma(shape, rate, rng) {
  const r = _rng(rng);
  let k = _num(shape, 1);
  const lambda = _num(rate, 1);
  if (!(k > 0) || !(lambda > 0)) return 0;

  if (k < 1) {
    // Boosting (Marsaglia-Tsang §6): draw with shape+1 then scale by U^{1/k}.
    const u = Math.max(Number.MIN_VALUE, r());
    return _sampleGamma(k + 1, lambda, rng) * Math.pow(u, 1 / k);
  }

  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Bound the loop defensively; in practice acceptance is ~0.95 so this always
  // returns well within a handful of iterations. The cap prevents a pathological
  // rng from hanging the math.
  for (let iter = 0; iter < 1000; iter++) {
    let x = _sampleNormal(0, 1, rng);
    let vCubeRoot = 1 + c * x;
    if (vCubeRoot <= 0) continue;
    const v = vCubeRoot * vCubeRoot * vCubeRoot;
    const u = r();
    const x2 = x * x;
    // Squeeze + full acceptance test.
    if (u < 1 - 0.0331 * x2 * x2) return (d * v) / lambda;
    if (Math.log(Math.max(Number.MIN_VALUE, u)) < 0.5 * x2 + d * (1 - v + Math.log(v))) {
      return (d * v) / lambda;
    }
  }
  // Extremely unlikely fallback: return the mean.
  return k / lambda;
}

// ---------------------------------------------------------------------------
// _normalGammaUpdate(prior, rewards, gamma) - discounted Normal-Gamma fold.
//
// rewards is ordered NEWEST FIRST (index 0 = most recent); reward j is weighted
// gamma^j. Returns the posterior hyperparameters plus the discounted effective
// count. With gamma = 1 this reduces to the closed-form NIG posterior for the
// reward set.
//
//   prior = { mu0, kappa0, alpha0, beta0 }
//   -> { mu_n, kappa_n, alpha_n, beta_n, n_eff }
// ---------------------------------------------------------------------------
function _normalGammaUpdate(prior, rewards, gamma) {
  const mu0 = _num(prior && prior.mu0, 0);
  const kappa0 = Math.max(1e-9, _num(prior && prior.kappa0, PRIOR_KAPPA));
  const alpha0 = Math.max(1e-9, _num(prior && prior.alpha0, PRIOR_ALPHA));
  const beta0 = Math.max(1e-9, _num(prior && prior.beta0, PRIOR_BETA));
  const g = Math.min(1, Math.max(0, _num(gamma, DEFAULT_GAMMA)));

  const rs = Array.isArray(rewards) ? rewards.map((x) => _num(x, 0)) : [];
  if (rs.length === 0) {
    return { mu_n: mu0, kappa_n: kappa0, alpha_n: alpha0, beta_n: beta0, n_eff: 0 };
  }

  // Discounted sufficient statistics. weight_j = gamma^j (newest first).
  let nEff = 0;
  let wSum = 0; // sum w_j r_j
  let wSumSq = 0; // sum w_j r_j^2
  let w = 1;
  for (let j = 0; j < rs.length; j++) {
    nEff += w;
    wSum += w * rs[j];
    wSumSq += w * rs[j] * rs[j];
    w *= g;
  }
  const xbar = nEff > 0 ? wSum / nEff : 0;
  // Discounted sum-of-squares S = sum w_j (r_j - xbar)^2
  //                            = sum w_j r_j^2 - n_eff * xbar^2.
  const S = Math.max(0, wSumSq - nEff * xbar * xbar);

  const kappa_n = kappa0 + nEff;
  const mu_n = (kappa0 * mu0 + nEff * xbar) / kappa_n;
  const alpha_n = alpha0 + nEff / 2;
  const beta_n = beta0 + 0.5 * S + (0.5 * kappa0 * nEff * (xbar - mu0) * (xbar - mu0)) / kappa_n;

  return { mu_n, kappa_n, alpha_n, beta_n, n_eff: nEff };
}

// Posterior mean + variance of the arm-mean reward from NIG hyperparameters.
// E[mu]   = mu_n
// Var[mu] = beta_n / ((alpha_n - 1) * kappa_n)   (defined for alpha_n > 1;
//           for alpha_n <= 1 the variance is heavy-tailed - we report a finite
//           conservative proxy beta_n / (alpha_n * kappa_n) for diagnostics).
function _posteriorMoments(post) {
  const mean = _num(post && post.mu_n, 0);
  const a = _num(post && post.alpha_n, PRIOR_ALPHA);
  const b = _num(post && post.beta_n, PRIOR_BETA);
  const kap = Math.max(1e-9, _num(post && post.kappa_n, PRIOR_KAPPA));
  let variance;
  if (a > 1) variance = b / ((a - 1) * kap);
  else variance = b / (Math.max(1e-9, a) * kap);
  return { mean, variance: Math.max(0, variance) };
}

// Draw one Thompson sample of an arm's mean reward from its NIG posterior.
function _drawPosteriorMean(post, rng) {
  const a = Math.max(1e-9, _num(post && post.alpha_n, PRIOR_ALPHA));
  const b = Math.max(1e-9, _num(post && post.beta_n, PRIOR_BETA));
  const kap = Math.max(1e-9, _num(post && post.kappa_n, PRIOR_KAPPA));
  const mu = _num(post && post.mu_n, 0);
  const tau = _sampleGamma(a, b, rng); // precision draw
  const safeTau = tau > 0 ? tau : (a / b); // fall back to E[tau] if degenerate
  const variance = 1 / (kap * safeTau);
  return _sampleNormal(mu, variance, rng);
}

// ---------------------------------------------------------------------------
// Ledger I/O - best-effort event-store persistence, W411 tenant + ns fenced.
// ---------------------------------------------------------------------------

async function _appendLedger({ tenant, namespace, workflow, payload }) {
  try {
    const ev = await eventStore.appendEvent({
      tenant_id: tenant, namespace: namespace || DEFAULT_NAMESPACE,
      provider: BANDIT_PROVIDER, vendor: 'kolm', model: 'strategy-bandit/v1',
      workflow_id: workflow, status: 'ok',
      prompt_tokens: 0, completion_tokens: 0,
      feedback: JSON.stringify(payload || {}),
    });
    return { persisted: true, event_id: ev && ev.event_id };
  } catch (e) {
    return { persisted: false, error: String((e && e.message) || e) };
  }
}

// Read every ledger row of a given workflow for (tenant, namespace), newest
// first. Inner-loop W411 fence on every row.
async function _readLedger({ tenant, namespace, workflow, limit = 5000 }) {
  try {
    const rows = await eventStore.listEvents({
      tenant_id: tenant, namespace: namespace || DEFAULT_NAMESPACE,
      provider: BANDIT_PROVIDER, workflow_id: workflow, limit, order: 'desc',
    });
    const out = [];
    for (const r of rows || []) {
      if (!r) continue;
      if (String(r.tenant_id) !== String(tenant)) continue; // defense-in-depth
      const fb = r.feedback;
      let payload = null;
      if (fb && typeof fb === 'object') payload = fb;
      else if (typeof fb === 'string') { try { payload = JSON.parse(fb); } catch { payload = null; } }
      if (!payload) continue;
      out.push({ created_at: r.created_at, ...payload });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// recordStrategyChoice - write a pending CHOICE row at SELECT.
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ok:boolean, version:string, choice_id?:string, persisted?:boolean, error?:string}>}
 */
export async function recordStrategyChoice({
  tenant, namespace, strategy, base_kscore, base_features,
  est_cost_usd, sampled_ratio, run_id,
} = {}) {
  try {
    if (!strategy || typeof strategy !== 'string') {
      return { ok: false, error: 'missing_strategy', version: STRATEGY_BANDIT_VERSION };
    }
    const t = _tenant(tenant);
    const ns = _ns(namespace);
    const choice_id = _genChoiceId();
    const payload = {
      kind: 'sb_choice',
      choice_id,
      strategy,
      base_kscore: Number.isFinite(Number(base_kscore)) ? Number(base_kscore) : null,
      base_features: (base_features && typeof base_features === 'object' && !Array.isArray(base_features))
        ? base_features : null,
      est_cost_usd: Number.isFinite(Number(est_cost_usd)) ? Number(est_cost_usd) : null,
      sampled_ratio: Number.isFinite(Number(sampled_ratio)) ? Number(sampled_ratio) : null,
      run_id: run_id == null ? null : String(run_id),
      proposed_at: _isoNow(),
      version: STRATEGY_BANDIT_VERSION,
    };
    const res = await _appendLedger({ tenant: t, namespace: ns, workflow: BANDIT_WORKFLOW.CHOICE, payload });
    return {
      ok: true, version: STRATEGY_BANDIT_VERSION,
      choice_id, persisted: res.persisted === true,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: STRATEGY_BANDIT_VERSION };
  }
}

// ---------------------------------------------------------------------------
// recordStrategyOutcome - fold a realized ΔK into the discounted posterior.
//
// IDEMPOTENT on choice_id: a duplicate outcome for the same choice_id is a
// no-op (returns the already-recorded posterior view) so a retried cron tick
// never double-counts a reward.
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ok:boolean, version:string, strategy?:string,
 *   posterior?:{mu_n,kappa_n,alpha_n,beta_n,n_eff}, persisted?:boolean,
 *   idempotent_hit?:boolean, error?:string}>}
 */
export async function recordStrategyOutcome({
  tenant, namespace, strategy, realized_delta_k, realized_cost_usd,
  choice_id, run_id, candidate_kscore, base_kscore, gamma = DEFAULT_GAMMA, prior_mu,
} = {}) {
  try {
    if (!strategy || typeof strategy !== 'string') {
      return { ok: false, error: 'missing_strategy', version: STRATEGY_BANDIT_VERSION };
    }
    const t = _tenant(tenant);
    const ns = _ns(namespace);

    // Resolve the realized reward. Prefer an explicit realized_delta_k; otherwise
    // derive candidate_K - base_K. NEVER clamp to 0 - negatives are real evidence
    // (the whole point of the upgrade over the cost-optimizer's clamp).
    let reward = Number(realized_delta_k);
    if (!Number.isFinite(reward)) {
      const cand = Number(candidate_kscore);
      const base = Number(base_kscore);
      if (Number.isFinite(cand) && Number.isFinite(base)) reward = cand - base;
    }
    if (!Number.isFinite(reward)) {
      return { ok: false, error: 'no_realized_reward', version: STRATEGY_BANDIT_VERSION };
    }

    // Idempotence: if an outcome already exists for this choice_id, do not append.
    if (choice_id) {
      const existing = await _readLedger({ tenant: t, namespace: ns, workflow: BANDIT_WORKFLOW.OUTCOME });
      const hit = existing.find((r) => r && r.choice_id === choice_id);
      if (hit) {
        const post = await readStrategyPosteriors({ tenant: t, namespace: ns, gamma, prior_mu });
        const p = (post.ok && post.posteriors && post.posteriors[strategy]) || null;
        return {
          ok: true, version: STRATEGY_BANDIT_VERSION, strategy,
          posterior: p ? p.posterior : null, persisted: false, idempotent_hit: true,
        };
      }
    }

    const payload = {
      kind: 'sb_outcome',
      strategy,
      reward,
      realized_cost_usd: Number.isFinite(Number(realized_cost_usd)) ? Number(realized_cost_usd) : null,
      choice_id: choice_id == null ? null : String(choice_id),
      run_id: run_id == null ? null : String(run_id),
      candidate_kscore: Number.isFinite(Number(candidate_kscore)) ? Number(candidate_kscore) : null,
      base_kscore: Number.isFinite(Number(base_kscore)) ? Number(base_kscore) : null,
      observed_at: _isoNow(),
      version: STRATEGY_BANDIT_VERSION,
    };
    const res = await _appendLedger({ tenant: t, namespace: ns, workflow: BANDIT_WORKFLOW.OUTCOME, payload });

    // Recompute the strategy's posterior including the row we just wrote (when
    // persisted) or fold the new reward in-memory (when not persisted) so the
    // returned posterior always reflects the new evidence.
    const post = await readStrategyPosteriors({ tenant: t, namespace: ns, gamma, prior_mu });
    let posterior = (post.ok && post.posteriors && post.posteriors[strategy])
      ? post.posteriors[strategy].posterior : null;
    if (!res.persisted || !posterior) {
      const prior = {
        mu0: Number.isFinite(Number(prior_mu)) ? Number(prior_mu) : 0,
        kappa0: PRIOR_KAPPA, alpha0: PRIOR_ALPHA, beta0: PRIOR_BETA,
      };
      posterior = _normalGammaUpdate(prior, [reward], gamma);
    }

    return {
      ok: true, version: STRATEGY_BANDIT_VERSION, strategy,
      posterior, reward, persisted: res.persisted === true,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: STRATEGY_BANDIT_VERSION };
  }
}

// ---------------------------------------------------------------------------
// readStrategyPosteriors - rebuild the per-strategy discounted posterior from
// the OUTCOME ledger. Warm-starts each arm's prior mean from prior_mu (a number
// applied to every arm, or a map strategy->mu). Unseen arms get the prior only.
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} [args.tenant]
 * @param {string} [args.namespace]
 * @param {number} [args.gamma]
 * @param {(number|object)} [args.prior_mu]  warm-start mean(s)
 * @param {string[]} [args.strategies]        arms to surface even with no data
 * @returns {Promise<{ok:boolean, version:string, posteriors?:object, error?:string}>}
 */
export async function readStrategyPosteriors({
  tenant, namespace, gamma = DEFAULT_GAMMA, prior_mu, strategies,
} = {}) {
  try {
    const t = _tenant(tenant);
    const ns = _ns(namespace);
    const rows = await _readLedger({ tenant: t, namespace: ns, workflow: BANDIT_WORKFLOW.OUTCOME });

    // Group rewards by strategy, NEWEST FIRST (the ledger is read desc by
    // created_at, so rows[0] is the most recent).
    const byStrategy = new Map();
    for (const r of rows) {
      if (!r || r.kind !== 'sb_outcome' || !r.strategy) continue;
      const reward = Number(r.reward);
      if (!Number.isFinite(reward)) continue;
      if (!byStrategy.has(r.strategy)) byStrategy.set(r.strategy, []);
      byStrategy.get(r.strategy).push(reward);
    }

    // Determine the full arm set: explicit strategies + any seen in the ledger.
    const arms = new Set();
    if (Array.isArray(strategies)) for (const s of strategies) arms.add(String(s));
    for (const s of byStrategy.keys()) arms.add(s);

    const priorMuFor = (s) => {
      if (prior_mu && typeof prior_mu === 'object' && !Array.isArray(prior_mu)) {
        return Number.isFinite(Number(prior_mu[s])) ? Number(prior_mu[s]) : 0;
      }
      return Number.isFinite(Number(prior_mu)) ? Number(prior_mu) : 0;
    };

    const posteriors = {};
    for (const s of arms) {
      const rewards = byStrategy.get(s) || [];
      const prior = { mu0: priorMuFor(s), kappa0: PRIOR_KAPPA, alpha0: PRIOR_ALPHA, beta0: PRIOR_BETA };
      const post = _normalGammaUpdate(prior, rewards, gamma);
      const mom = _posteriorMoments(post);
      posteriors[s] = {
        posterior: post,
        posterior_mean: mom.mean,
        posterior_var: mom.variance,
        n_obs: rewards.length,
        n_eff: post.n_eff,
        warm_started: rewards.length === 0,
      };
    }

    return { ok: true, version: STRATEGY_BANDIT_VERSION, posteriors };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: STRATEGY_BANDIT_VERSION };
  }
}

// ---------------------------------------------------------------------------
// sampleStrategyPosterior - draw ONE Thompson sample of a single arm's mean
// reward from its discounted NIG posterior (warm-started from prior_mu).
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ok:boolean, version:string, strategy?:string,
 *   sampled_reward?:number, posterior_mean?:number, posterior_var?:number,
 *   n_eff?:number, n_obs?:number, warm_started?:boolean, error?:string}>}
 */
export async function sampleStrategyPosterior({
  tenant, namespace, strategy,
  prior_mu, prior_kappa = PRIOR_KAPPA, prior_alpha = PRIOR_ALPHA, prior_beta = PRIOR_BETA,
  gamma = DEFAULT_GAMMA, rng,
} = {}) {
  try {
    if (!strategy || typeof strategy !== 'string') {
      return { ok: false, error: 'missing_strategy', version: STRATEGY_BANDIT_VERSION };
    }
    const t = _tenant(tenant);
    const ns = _ns(namespace);
    const rows = await _readLedger({ tenant: t, namespace: ns, workflow: BANDIT_WORKFLOW.OUTCOME });
    const rewards = [];
    for (const r of rows) {
      if (!r || r.kind !== 'sb_outcome' || r.strategy !== strategy) continue;
      const reward = Number(r.reward);
      if (Number.isFinite(reward)) rewards.push(reward);
    }
    const prior = {
      mu0: Number.isFinite(Number(prior_mu)) ? Number(prior_mu) : 0,
      kappa0: prior_kappa, alpha0: prior_alpha, beta0: prior_beta,
    };
    const post = _normalGammaUpdate(prior, rewards, gamma);
    const mom = _posteriorMoments(post);
    const sampled_reward = _drawPosteriorMean(post, rng);
    return {
      ok: true, version: STRATEGY_BANDIT_VERSION, strategy,
      sampled_reward,
      posterior_mean: mom.mean,
      posterior_var: mom.variance,
      n_eff: post.n_eff,
      n_obs: rewards.length,
      warm_started: rewards.length === 0,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: STRATEGY_BANDIT_VERSION };
  }
}

// ---------------------------------------------------------------------------
// rankByThompson - the policy. Draws one (reward) sample per arm from its
// discounted posterior, ranks by sampled-reward-over-cost RATIO among
// budget-feasible arms, and recommends the argmax.
//
// arms: [{ strategy, prior_mu, est_cost_usd, fits_budget? }]
//   - prior_mu       warm-start prior mean for this arm (cost-optimizer ΔK)
//   - est_cost_usd   near-deterministic cost; 0 => free (floats to top)
//   - fits_budget    optional precomputed budget feasibility (default true)
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ok:boolean, version:string, gamma:number,
 *   ranked?:Array, recommended?:(string|null), error?:string}>}
 */
export async function rankByThompson({
  tenant, namespace, arms, gamma = DEFAULT_GAMMA, epsilon = DEFAULT_EPSILON, rng,
} = {}) {
  try {
    if (!Array.isArray(arms) || arms.length === 0) {
      return { ok: false, error: 'arms_required', version: STRATEGY_BANDIT_VERSION };
    }
    const t = _tenant(tenant);
    const ns = _ns(namespace);
    const g = Math.min(1, Math.max(0, _num(gamma, DEFAULT_GAMMA)));
    const eps = Math.max(Number.MIN_VALUE, _num(epsilon, DEFAULT_EPSILON));

    // Read the whole posterior set once (one ledger scan), warm-started per arm.
    const priorMap = {};
    for (const a of arms) {
      if (a && a.strategy) priorMap[String(a.strategy)] = _num(a.prior_mu, 0);
    }
    const post = await readStrategyPosteriors({
      tenant: t, namespace: ns, gamma: g, prior_mu: priorMap,
      strategies: arms.map((a) => a && a.strategy).filter(Boolean),
    });
    const posteriors = (post.ok && post.posteriors) ? post.posteriors : {};

    const ranked = [];
    for (const a of arms) {
      if (!a || !a.strategy) continue;
      const s = String(a.strategy);
      const cost = Math.max(0, _num(a.est_cost_usd, 0));
      const fits_budget = a.fits_budget === undefined ? true : !!a.fits_budget;
      const entry = posteriors[s] || null;
      const postHyper = entry ? entry.posterior : _normalGammaUpdate(
        { mu0: priorMap[s] || 0, kappa0: PRIOR_KAPPA, alpha0: PRIOR_ALPHA, beta0: PRIOR_BETA }, [], g,
      );
      const sampled_reward = _drawPosteriorMean(postHyper, rng);
      // Cost-aware ratio (Xia et al. 2015). Free arm (cost 0) divides by eps so
      // it dominates at equal reward - preserves the cost-optimizer's dedup
      // floats-to-top behavior.
      const sampled_ratio = sampled_reward / Math.max(cost, eps);
      ranked.push({
        strategy: s,
        sampled_reward,
        est_cost_usd: cost,
        sampled_ratio,
        fits_budget,
        posterior_mean: entry ? entry.posterior_mean : postHyper.mu_n,
        posterior_var: entry ? entry.posterior_var : _posteriorMoments(postHyper).variance,
        n_eff: entry ? entry.n_eff : 0,
        n_obs: entry ? entry.n_obs : 0,
        warm_started: entry ? entry.warm_started : true,
      });
    }

    // Sort DESC by sampled ratio; ties broken by lower cost then stable order.
    ranked.sort((x, y) =>
      (y.sampled_ratio - x.sampled_ratio)
      || (x.est_cost_usd - y.est_cost_usd)
      || (arms.findIndex((a) => a && String(a.strategy) === x.strategy)
        - arms.findIndex((a) => a && String(a.strategy) === y.strategy)));

    // Recommend the highest-ratio budget-feasible arm whose sampled reward is
    // strictly positive (recommending a sampled no-op/negative wastes a tick).
    let recommended = null;
    for (const r of ranked) {
      if (r.fits_budget && r.sampled_reward > 0) { recommended = r.strategy; break; }
    }

    return { ok: true, version: STRATEGY_BANDIT_VERSION, gamma: g, ranked, recommended };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: STRATEGY_BANDIT_VERSION };
  }
}

// Exposed for tests + downstream introspection. NOT part of the stable contract.
export const __internals = Object.freeze({
  _normalGammaUpdate,
  _sampleGamma,
  _sampleNormal,
  _posteriorMoments,
  _drawPosteriorMean,
  PRIOR_KAPPA,
  PRIOR_ALPHA,
  PRIOR_BETA,
  DEFAULT_GAMMA,
  DEFAULT_EPSILON,
});

export default {
  STRATEGY_BANDIT_VERSION,
  BANDIT_PROVIDER,
  BANDIT_WORKFLOW,
  DEFAULT_GAMMA,
  DEFAULT_EPSILON,
  rankByThompson,
  sampleStrategyPosterior,
  recordStrategyChoice,
  recordStrategyOutcome,
  readStrategyPosteriors,
  __internals,
};
