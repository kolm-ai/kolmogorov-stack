// W921 — provider-health: per-provider circuit breaker + health-aware load
// balancing for the gateway dispatch chain.
//
// PROBLEM. src/gateway-router.js:dispatchWithFallback walks the fallback
// chain in strict array order with ZERO cross-request state. A hard-down
// primary (Anthropic 503 storm, dead self-hosted vLLM) is re-fired on EVERY
// request, each paying the full clamped timeout (default 60s, up to 300s)
// before falling through. N concurrent users on a dead primary burn
// N x 60s latency + N retry storms. The circuit-breaker pattern prevents
// exactly this.
//
// THIS MODULE implements two cooperating PASSIVE-health layers (inferred
// from real outcomes — no synthetic probes):
//
//   LAYER 1 — PER-PROVIDER CIRCUIT BREAKER (Resilience4j 3-state machine):
//     CLOSED   normal; outcomes recorded into a fixed-size sliding window.
//     OPEN     tripped; provider SKIPPED in chain selection for cooldown_ms.
//     HALF_OPEN after cooldown, admit `permitted_in_half_open` trials;
//              success -> CLOSE, any failure -> re-OPEN with EXPONENTIALLY
//              growing cooldown (base x consecutive_ejections, capped — the
//              Envoy growth rule).
//     TRIP CONDITIONS (OR'd):
//       (a) consecutive_failures >= threshold (Envoy default 5) — INLINE.
//       (b) failure_rate >= 0.5 over the last sliding_window_size outcomes,
//           gated by minimum_calls (Resilience4j cold-start gate).
//       (c) IMMEDIATE trip on terminal-class 401/403/404 (LiteLLM rule).
//     A "failure" == fallback_eligible (shouldFallback === true). A 2xx and
//     any non-fallback 4xx (400 = caller's fault) decay consecutive to 0.
//     RETRY-AFTER AWARE: a 429 with Retry-After sets cooldown =
//     max(cooldown_ms, retry_after_ms).
//
//   LAYER 2 — HEALTH-AWARE LOAD BALANCING (head selection among equivalent
//     providers): 'weighted' (weighted-random shuffle; OPEN -> weight 0),
//     'latency' (lowest EWMA p50 among CLOSED), or 'health' (success_rate x
//     (1 - normalized latency penalty)). The LB chooses the HEAD; the
//     breaker decides who is ELIGIBLE.
//
// SAFETY VALVE (Envoy max_ejection_percent / panic): NEVER eject the last
// eligible provider — if dropping every OPEN entry would leave zero, return
// the chain anyway (FAIL-OPEN). This is the single most important invariant:
// the breaker can only ever IMPROVE availability, never self-inflict an
// outage.
//
// State = in-process Map keyed by provider, PER-PROCESS by design (matches
// metrics.js "resets on restart, V1 not persisting"). A store.js-backed
// distributed breaker is documented Phase-2 for multi-instance fleets.
//
// Zero npm deps — pure JS (Map + arithmetic), matching kolm's
// metrics.js / lake.js zero-dep ethos.
//
// Public surface (singleton-backed module functions + makeRegistry factory):
//   HEALTH_VERSION, CIRCUIT_DEFAULTS
//   makeRegistry(opts) -> ProviderHealthRegistry
//   recordOutcome / isOpen / circuitState / computeCooldownMs / healthScore
//   ewmaLatencyMs / filterChain / selectHeadByStrategy / snapshotHealth
//   successRateOutlierSweep / resetHealth

export const HEALTH_VERSION = 'w921-v1';

export const CIRCUIT_DEFAULTS = Object.freeze({
  consecutive_failure_threshold: 5,    // Envoy consecutive_5xx default
  failure_rate_threshold: 0.5,         // Resilience4j 50%
  sliding_window_size: 50,             // count window (Resilience4j 100 -> 50 for gateway realism)
  minimum_calls: 20,                   // Resilience4j minimumNumberOfCalls cold-start gate
  base_cooldown_ms: 10000,             // Envoy base_ejection_time 30s -> 10s for faster LLM incidents
  max_cooldown_ms: 120000,             // Envoy max_ejection_time 300s -> 120s
  permitted_in_half_open: 2,           // Resilience4j permittedNumberOfCallsInHalfOpenState 10 -> 2
  ewma_alpha: null,                    // null => derive 2/(W+1) from sliding_window_size
  latency_penalty_ceiling_ms: 30000,   // latency at/above this = full penalty in healthScore
  success_rate_stdev_factor: 1.9,      // Envoy success_rate_stdev_factor 1900 / 1000
  success_rate_minimum_hosts: 5,       // Envoy success_rate_minimum_hosts
  success_rate_request_volume: 30,     // Envoy success_rate_request_volume (100 -> 30)
});

// Terminal-class statuses that trip the circuit IMMEDIATELY (LiteLLM rule):
// the upstream is telling us this request will NEVER succeed (bad key /
// forbidden / wrong path), so retrying is pointless.
const TERMINAL_STATUSES = Object.freeze([401, 403, 404]);

// --------------------------------------------------------------------------
// Internal per-provider state container. Created lazily on first record.
// --------------------------------------------------------------------------

function _newState() {
  return {
    state: 'closed',                // 'closed' | 'open' | 'half_open'
    // Sliding window of the last W fallback-eligibility bits (1 = failure).
    // Ring buffer with a running failure sum for O(1) push.
    window: [],
    window_head: 0,                 // next write index into the ring
    window_fail_sum: 0,             // running count of 1-bits in `window`
    consecutive_failures: 0,
    consecutive_ejections: 0,       // grows each time we re-open; drives cooldown
    opened_at_ms: null,             // when the circuit last OPENed
    cooldown_ms: 0,                 // cooldown granted at the last open
    half_open_in_flight: 0,         // trial slots handed out in HALF_OPEN
    // EWMA p50-ish latency in ms; null until first sample.
    ewma_latency_ms: null,
    // Lifetime counters (for healthScore / snapshot; not windowed).
    total_calls: 0,
    total_failures: 0,
  };
}

// --------------------------------------------------------------------------
// ProviderHealthRegistry — the breaker + LB engine. All time is injected
// via an optional nowMs argument so tests are fully deterministic.
// --------------------------------------------------------------------------

export class ProviderHealthRegistry {
  constructor(opts = {}) {
    this.cfg = Object.freeze({ ...CIRCUIT_DEFAULTS, ...(opts || {}) });
    this._map = new Map();
    // Derived EWMA alpha = 2/(W+1) unless explicitly overridden.
    this._alpha = (typeof this.cfg.ewma_alpha === 'number' && this.cfg.ewma_alpha > 0)
      ? this.cfg.ewma_alpha
      : 2 / (this.cfg.sliding_window_size + 1);
  }

  _key(providerKey) {
    return String(providerKey == null ? '' : providerKey);
  }

  _get(providerKey) {
    const k = this._key(providerKey);
    let st = this._map.get(k);
    if (!st) { st = _newState(); this._map.set(k, st); }
    return st;
  }

  _now(nowMs) {
    return typeof nowMs === 'number' ? nowMs : Date.now();
  }

  // ---- sliding window helpers (O(1)) ------------------------------------
  _pushWindow(st, isFailure) {
    const W = this.cfg.sliding_window_size;
    const bit = isFailure ? 1 : 0;
    if (st.window.length < W) {
      st.window.push(bit);
      st.window_fail_sum += bit;
    } else {
      // overwrite oldest at head, keep running sum correct
      const old = st.window[st.window_head] || 0;
      st.window_fail_sum += bit - old;
      st.window[st.window_head] = bit;
      st.window_head = (st.window_head + 1) % W;
    }
  }

  _failureRate(st) {
    if (st.window.length === 0) return null;
    return st.window_fail_sum / st.window.length;
  }

  // ---- cooldown ---------------------------------------------------------
  computeCooldownMs(consecutiveEjections, retryAfterMs = null, cfg = null) {
    const c = cfg || this.cfg;
    const ej = Math.max(1, Math.floor(Number(consecutiveEjections) || 1));
    // Envoy exponential growth: base x ejections, capped at max.
    const grown = Math.min(c.base_cooldown_ms * ej, c.max_cooldown_ms);
    // Retry-After awareness: never undershoot the upstream-advertised wait.
    const ra = (typeof retryAfterMs === 'number' && retryAfterMs > 0) ? retryAfterMs : 0;
    return Math.max(grown, ra);
  }

  // ---- 3-state transitions ----------------------------------------------
  _openCircuit(st, nowMs, retryAfterMs) {
    st.consecutive_ejections += 1;
    st.cooldown_ms = this.computeCooldownMs(st.consecutive_ejections, retryAfterMs);
    st.opened_at_ms = nowMs;
    st.state = 'open';
    st.half_open_in_flight = 0;
  }

  _closeCircuit(st) {
    st.state = 'closed';
    st.consecutive_failures = 0;
    st.consecutive_ejections = 0;
    st.opened_at_ms = null;
    st.cooldown_ms = 0;
    st.half_open_in_flight = 0;
  }

  // Move OPEN -> HALF_OPEN once cooldown has elapsed. Mutates in place.
  _maybeHalfOpen(st, nowMs) {
    if (st.state === 'open' && st.opened_at_ms != null) {
      if (nowMs - st.opened_at_ms >= st.cooldown_ms) {
        st.state = 'half_open';
        st.half_open_in_flight = 0;
      }
    }
  }

  _cooldownRemaining(st, nowMs) {
    if (st.state !== 'open' || st.opened_at_ms == null) return 0;
    const rem = st.cooldown_ms - (nowMs - st.opened_at_ms);
    return rem > 0 ? rem : 0;
  }

  // ---- trip evaluation ---------------------------------------------------
  // Returns true if the circuit should OPEN given current state. Caller
  // passes the just-recorded outcome's status + fallback eligibility.
  _shouldTrip(st, status, isFailure) {
    // (c) terminal-class: immediate trip regardless of window/consecutive.
    if (TERMINAL_STATUSES.includes(Number(status))) return true;
    if (!isFailure) return false;
    // (a) consecutive failures inline trip — catches hard-down hosts instantly.
    if (st.consecutive_failures >= this.cfg.consecutive_failure_threshold) return true;
    // (b) failure-rate trip, gated by minimum_calls.
    if (st.window.length >= this.cfg.minimum_calls) {
      const fr = this._failureRate(st);
      if (fr != null && fr >= this.cfg.failure_rate_threshold) return true;
    }
    return false;
  }

  // ---- public: record an outcome ----------------------------------------
  recordOutcome(providerKey, o = {}, nowMs = undefined) {
    const st = this._get(providerKey);
    const now = this._now(nowMs);
    const status = Number(o && o.status) || 0;
    // A "failure" for the breaker == fallback_eligible. Callers thread the
    // gateway-router shouldFallback(result) verdict in. We also defensively
    // treat ok:false + fallback_eligible:undefined conservatively as a
    // non-failure (only explicit fallback eligibility counts).
    const isFailure = (o && o.fallback_eligible === true);
    const isTerminal = TERMINAL_STATUSES.includes(status);

    st.total_calls += 1;
    if (isFailure) st.total_failures += 1;

    // EWMA latency (ms) from elapsed_us. Only sample successful/answered
    // attempts that actually round-tripped (elapsed > 0).
    const elapsedMs = (typeof o.elapsed_us === 'number' && o.elapsed_us > 0)
      ? o.elapsed_us / 1000
      : null;
    if (elapsedMs != null) {
      st.ewma_latency_ms = (st.ewma_latency_ms == null)
        ? elapsedMs
        : this._alpha * elapsedMs + (1 - this._alpha) * st.ewma_latency_ms;
    }

    // Sliding window + consecutive counter.
    this._pushWindow(st, isFailure);
    if (isFailure) {
      st.consecutive_failures += 1;
    } else {
      // 2xx OR a non-fallback 4xx (e.g. 400 caller's fault) decays the
      // consecutive failure counter — the provider is demonstrably alive.
      st.consecutive_failures = 0;
    }

    const retryAfterMs = (typeof o.retry_after_ms === 'number' && o.retry_after_ms > 0)
      ? o.retry_after_ms
      : null;

    if (st.state === 'half_open') {
      // We are in a trial. Any failure re-opens with grown cooldown; a
      // success closes the circuit.
      if (isFailure || isTerminal) {
        this._openCircuit(st, now, retryAfterMs);
      } else {
        this._closeCircuit(st);
      }
      return;
    }

    if (st.state === 'open') {
      // Outcome recorded while OPEN (e.g. a panic fail-open attempt slipped
      // through). Refresh cooldown on failure so we don't prematurely
      // half-open a still-dead provider; close on a real success.
      if (isFailure || isTerminal) {
        // bump cooldown horizon from "now" without incrementing ejections
        // again (ejection already counted at open).
        st.opened_at_ms = now;
        if (retryAfterMs != null) {
          st.cooldown_ms = Math.max(st.cooldown_ms, retryAfterMs);
        }
      } else {
        this._closeCircuit(st);
      }
      return;
    }

    // CLOSED — evaluate trip conditions.
    if (this._shouldTrip(st, status, isFailure)) {
      this._openCircuit(st, now, retryAfterMs);
    }
  }

  // ---- public: is this provider currently OPEN (skip it)? ----------------
  // Returns false when a HALF_OPEN trial slot is available so the caller is
  // allowed to send a probe request through.
  isOpen(providerKey, nowMs = undefined) {
    const k = this._key(providerKey);
    const st = this._map.get(k);
    if (!st) return false; // unknown provider => optimistic, allow.
    const now = this._now(nowMs);
    if (st.state === 'open') {
      this._maybeHalfOpen(st, now);
    }
    if (st.state === 'open') return true;
    if (st.state === 'half_open') {
      // Admit exactly `permitted_in_half_open` concurrent trials.
      if (st.half_open_in_flight < this.cfg.permitted_in_half_open) {
        st.half_open_in_flight += 1;
        return false; // allow the trial
      }
      return true; // trial budget exhausted — keep skipping
    }
    return false; // closed
  }

  // ---- public: structured circuit snapshot for one provider -------------
  circuitState(providerKey, nowMs = undefined) {
    const k = this._key(providerKey);
    const st = this._map.get(k);
    const now = this._now(nowMs);
    if (!st) {
      return {
        state: 'closed',
        consecutive_failures: 0,
        failure_rate: null,
        calls_in_window: 0,
        cooldown_remaining_ms: 0,
        consecutive_ejections: 0,
      };
    }
    if (st.state === 'open') this._maybeHalfOpen(st, now);
    return {
      state: st.state,
      consecutive_failures: st.consecutive_failures,
      failure_rate: this._failureRate(st),
      calls_in_window: st.window.length,
      cooldown_remaining_ms: this._cooldownRemaining(st, now),
      consecutive_ejections: st.consecutive_ejections,
    };
  }

  // ---- public: EWMA latency ---------------------------------------------
  ewmaLatencyMs(providerKey) {
    const st = this._map.get(this._key(providerKey));
    if (!st || st.ewma_latency_ms == null) return null;
    return st.ewma_latency_ms;
  }

  // ---- public: health score (0..1) --------------------------------------
  // success_rate x (1 - normalized latency penalty). Unknown provider => 1
  // (optimistic — never penalize a provider we have no data on).
  healthScore(providerKey) {
    const st = this._map.get(this._key(providerKey));
    if (!st || st.total_calls === 0) return 1;
    const successRate = 1 - (st.total_failures / st.total_calls);
    const ceil = this.cfg.latency_penalty_ceiling_ms;
    let latPenalty = 0;
    if (st.ewma_latency_ms != null && ceil > 0) {
      latPenalty = Math.min(1, st.ewma_latency_ms / ceil);
    }
    const score = successRate * (1 - latPenalty);
    if (score < 0) return 0;
    if (score > 1) return 1;
    return score;
  }

  // ---- public: head selection among eligible entries --------------------
  // strategy: 'weighted' | 'latency' | 'health'. Returns the chosen entry
  // (an element of eligibleEntries) or null when the list is empty.
  selectHeadByStrategy(eligibleEntries, strategy, weights = {}, rng = Math.random) {
    const entries = Array.isArray(eligibleEntries) ? eligibleEntries.filter(Boolean) : [];
    if (entries.length === 0) return null;
    if (entries.length === 1) return entries[0];

    if (strategy === 'latency') {
      // Lowest EWMA p50 among the eligible (CLOSED/half-open) entries.
      // Providers with no latency sample yet are treated as 0 (untested =>
      // optimistically fast, so a fresh provider gets a chance).
      let best = entries[0];
      let bestLat = this._latOrZero(best.provider);
      for (let i = 1; i < entries.length; i++) {
        const lat = this._latOrZero(entries[i].provider);
        if (lat < bestLat) { best = entries[i]; bestLat = lat; }
      }
      return best;
    }

    if (strategy === 'health') {
      // Max healthScore among eligible entries.
      let best = entries[0];
      let bestScore = this.healthScore(best.provider);
      for (let i = 1; i < entries.length; i++) {
        const s = this.healthScore(entries[i].provider);
        if (s > bestScore) { best = entries[i]; bestScore = s; }
      }
      return best;
    }

    // 'weighted' (LiteLLM simple-shuffle): weighted-random draw. An entry's
    // weight is weights[provider] (default 1). OPEN entries never reach here
    // (they are filtered out before selection), so any entry here is eligible.
    const weighted = entries.map((e) => ({
      entry: e,
      w: Math.max(0, Number((weights && weights[e.provider]) != null ? weights[e.provider] : 1)),
    }));
    const total = weighted.reduce((a, b) => a + b.w, 0);
    if (total <= 0) return entries[0]; // all-zero weights => deterministic head
    let r = rng() * total;
    for (const { entry, w } of weighted) {
      r -= w;
      if (r < 0) return entry;
    }
    return weighted[weighted.length - 1].entry;
  }

  _latOrZero(providerKey) {
    const l = this.ewmaLatencyMs(providerKey);
    return l == null ? 0 : l;
  }

  // ---- public: filter + reorder a dispatch chain by health --------------
  // cfg: { strategy, weights, overrides }. Returns:
  //   { chain, skipped, lb_strategy, lb_chosen, health_scores, panic_fail_open }
  filterChain(chain, cfg = {}, nowMs = undefined) {
    const inputChain = Array.isArray(chain) ? chain.slice() : [];
    const strategy = (cfg && cfg.strategy) || 'ordered';
    const weights = (cfg && cfg.weights) || {};
    const rng = (cfg && typeof cfg.rng === 'function') ? cfg.rng : Math.random;
    const now = this._now(nowMs);

    const health_scores = {};
    for (const e of inputChain) {
      if (e && e.provider != null) health_scores[e.provider] = this.healthScore(e.provider);
    }

    // 'ordered' === today's behavior: identity, zero-regression. We do NOT
    // even consult breaker state here so the default path is byte-identical.
    if (strategy === 'ordered') {
      return {
        chain: inputChain,
        skipped: [],
        lb_strategy: 'ordered',
        lb_chosen: null,
        health_scores,
        panic_fail_open: false,
      };
    }

    // Partition into eligible (not OPEN) and skipped (OPEN).
    const eligible = [];
    const skipped = [];
    for (const e of inputChain) {
      if (!e || e.provider == null) { eligible.push(e); continue; }
      if (this.isOpen(e.provider, now)) {
        const cs = this.circuitState(e.provider, now);
        skipped.push({
          provider: e.provider,
          state: cs.state,
          cooldown_remaining_ms: cs.cooldown_remaining_ms,
        });
      } else {
        eligible.push(e);
      }
    }

    // PANIC FAIL-OPEN invariant: never reduce the chain to zero eligible
    // entries. If every provider is OPEN, return the ORIGINAL chain
    // unchanged and flag it — the breaker can only improve availability.
    if (eligible.length === 0) {
      return {
        chain: inputChain,
        skipped: [],          // we did not actually skip anyone (fail-open)
        lb_strategy: strategy,
        lb_chosen: null,
        health_scores,
        panic_fail_open: true,
      };
    }

    // Health-aware HEAD selection among the eligible set, then keep the
    // remaining eligible entries in their original relative order behind it.
    const head = this.selectHeadByStrategy(eligible, strategy, weights, rng);
    let reordered = eligible;
    let lb_chosen = head && head.provider != null ? head.provider : null;
    if (head) {
      reordered = [head, ...eligible.filter((e) => e !== head)];
    }

    return {
      chain: reordered,
      skipped,
      lb_strategy: strategy,
      lb_chosen,
      health_scores,
      panic_fail_open: false,
    };
  }

  // ---- public: read-only snapshot for GET /v1/gateway/health -------------
  snapshotHealth(nowMs = undefined) {
    const now = this._now(nowMs);
    const providers = {};
    for (const [k, st] of this._map.entries()) {
      const cs = this.circuitState(k, now);
      providers[k] = {
        state: cs.state,
        failure_rate: cs.failure_rate,
        consecutive_failures: cs.consecutive_failures,
        consecutive_ejections: cs.consecutive_ejections,
        cooldown_remaining_ms: cs.cooldown_remaining_ms,
        calls_in_window: cs.calls_in_window,
        ewma_latency_ms: this.ewmaLatencyMs(k),
        health_score: this.healthScore(k),
        total_calls: st.total_calls,
        total_failures: st.total_failures,
      };
    }
    return { version: HEALTH_VERSION, providers };
  }

  // ---- public (Phase-2-optional): Envoy success-rate outlier sweep -------
  // Flags providers whose success_rate < mean - stdev x factor across the
  // pool, gated by minimum_hosts + per-provider request_volume. Returns the
  // list of provider keys that would be ejected (does NOT mutate state — the
  // caller decides whether to act, preserving the fail-open invariant).
  successRateOutlierSweep(poolKeys = null) {
    const keys = Array.isArray(poolKeys) && poolKeys.length
      ? poolKeys.map((k) => this._key(k))
      : Array.from(this._map.keys());

    // Eligible hosts = those with >= request_volume recent calls.
    const eligible = [];
    for (const k of keys) {
      const st = this._map.get(k);
      if (!st) continue;
      if (st.total_calls < this.cfg.success_rate_request_volume) continue;
      const sr = 1 - (st.total_failures / st.total_calls);
      eligible.push({ key: k, sr });
    }
    // Envoy minimum_hosts gate: do nothing if the pool is too small.
    if (eligible.length < this.cfg.success_rate_minimum_hosts) {
      return { flagged: [], mean: null, stdev: null, threshold: null, eligible_hosts: eligible.length };
    }
    const n = eligible.length;
    const mean = eligible.reduce((a, b) => a + b.sr, 0) / n;
    const variance = eligible.reduce((a, b) => a + (b.sr - mean) * (b.sr - mean), 0) / n;
    const stdev = Math.sqrt(variance);
    const threshold = mean - stdev * this.cfg.success_rate_stdev_factor;
    const flagged = eligible.filter((e) => e.sr < threshold).map((e) => e.key);
    return { flagged, mean, stdev, threshold, eligible_hosts: n };
  }

  // ---- test/operator helper: clear all state -----------------------------
  resetHealth(providerKey = null) {
    if (providerKey == null) { this._map.clear(); return; }
    this._map.delete(this._key(providerKey));
  }
}

// --------------------------------------------------------------------------
// Factory + process-wide singleton. The singleton is what the gateway
// dispatch path wires into; makeRegistry() gives tests an isolated instance.
// --------------------------------------------------------------------------

export function makeRegistry(opts = {}) {
  return new ProviderHealthRegistry(opts);
}

let _singleton = null;
export function getRegistry() {
  if (!_singleton) _singleton = new ProviderHealthRegistry();
  return _singleton;
}

// Module-level convenience functions delegating to the singleton, matching
// the spec's flat signatures (recordOutcome / isOpen / ... ).
export function recordOutcome(providerKey, o, nowMs) {
  return getRegistry().recordOutcome(providerKey, o, nowMs);
}
export function isOpen(providerKey, nowMs) {
  return getRegistry().isOpen(providerKey, nowMs);
}
export function circuitState(providerKey, nowMs) {
  return getRegistry().circuitState(providerKey, nowMs);
}
export function computeCooldownMs(consecutiveEjections, retryAfterMs, cfg) {
  return getRegistry().computeCooldownMs(consecutiveEjections, retryAfterMs, cfg);
}
export function healthScore(providerKey) {
  return getRegistry().healthScore(providerKey);
}
export function ewmaLatencyMs(providerKey) {
  return getRegistry().ewmaLatencyMs(providerKey);
}
export function filterChain(chain, cfg, nowMs) {
  return getRegistry().filterChain(chain, cfg, nowMs);
}
export function selectHeadByStrategy(eligibleEntries, strategy, weights, rng) {
  return getRegistry().selectHeadByStrategy(eligibleEntries, strategy, weights, rng);
}
export function snapshotHealth(nowMs) {
  return getRegistry().snapshotHealth(nowMs);
}
export function successRateOutlierSweep(poolKeys) {
  return getRegistry().successRateOutlierSweep(poolKeys);
}
export function resetHealth(providerKey) {
  return getRegistry().resetHealth(providerKey);
}
