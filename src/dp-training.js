// src/dp-training.js
//
// FINALIZED-C2 - Differential-privacy TRAINING path for distilled students.
//
// This module is the load-bearing privacy layer that takes kolm's DP story
// past "aggregate-count noise" (src/dp-aggregation.js Laplace counts) and into
// a real, provable training-time guarantee. It supplies two opt-in DP paths:
//
//   1. DP-SGD  - per-example gradient clipping + calibrated Gaussian noise on
//                the *summed* clipped gradients, with a Renyi-DP (RDP) /
//                "moments accountant" that converts (noise_multiplier, steps)
//                into a real (epsilon, delta) budget per trained artifact.
//
//   2. PATE    - train disjoint teacher ensembles on partitioned captures, then
//                answer each student query by NOISY-ARGMAX aggregation over the
//                teacher votes (Gaussian / Laplace report-noisy-max). The
//                per-query privacy cost is accounted in RDP and summed, so a
//                label-transfer / distillation run carries its own (eps, delta).
//
// Both paths emit a privacy_budget block that is stamped into the .kolm
// manifest / receipt chain ALONGSIDE teacher_source (see src/distill-pipeline.js
// classifyTeacher) so every shipped model carries a provable DP guarantee.
//
// COMPOSITION WITH RESIDENCY (load-bearing):
//   The PATE partitioner is residency-aware. When you pass region-tagged
//   captures (the {region} field stamped by src/data-residency.js), the
//   ensemble partitioner NEVER mixes captures from different residency regions
//   into the same teacher unless cross-region training was explicitly opted
//   into via {allow_cross_region:true}. DP and data-locality therefore compose:
//   a per-region teacher is trained only on that region's data, and the noisy
//   aggregation spends a single global privacy budget that the receipt records
//   per region. This is the structural twin of src/data-residency.js
//   enforceRegionPolicy - residency fences WHERE data lives; DP bounds WHAT a
//   trained student can leak about any single example.
//
// CAVEATS / CONSTRAINTS (privacy contract - read before trusting a number):
//   - The accountant is a REAL RDP accountant: it evaluates the analytic RDP of
//     the Sampled Gaussian Mechanism (SGM) at a grid of Renyi orders and
//     converts the tightest order to (epsilon, delta) via the standard
//     RDP->(eps,delta) bound. This is the same family of bound used by
//     TF-Privacy / Opacus (Mironov 2017; Mironov-Talwar-Zhang 2019 SGM). It is
//     NOT a Monte-Carlo PLD accountant, so the epsilon it reports is a valid
//     UPPER BOUND (conservative), never an under-estimate. We prefer to
//     over-report epsilon than to ship a false privacy claim.
//   - The Gaussian noise here is drawn from node:crypto CSPRNG (not Math.random)
//     so the sampler is cryptographic - unlike src/dp-aggregation.js's
//     research-grade Laplace. A DP guarantee with a predictable PRNG is not a
//     guarantee; this path uses crypto.randomBytes-seeded Box-Muller.
//   - The JS DP-SGD primitive is the REFERENCE / verifier path: it clips and
//     noises real gradient arrays so a test (or a small pure-JS student) gets a
//     true DP update, and so the accountant math is independently checkable. The
//     heavy GPU trainer (apps/trainer/distill.py) consumes the SAME accountant
//     output via env (buildDpTrainerEnv) so the Python Opacus/DP-SGD run is
//     calibrated to the exact (noise_multiplier, clip, sample_rate, steps) the
//     accountant priced. The number stamped in the manifest is the number the
//     trainer was told to hit - fail-LOUD if they diverge (see
//     reconcileSpentBudget).
//   - epsilon=Infinity (no privacy) is a legal but LOUD result: when
//     noise_multiplier <= 0 we return epsilon=Infinity and mechanism flags
//     dp_effective=false so no caller can mistake "I asked for DP-SGD" for "I
//     got a finite budget".
//
// Pure JS, zero new npm deps. The optional heavy path (Opacus in the Python
// trainer) is ENV-GATED and fails loud with an install hint if asked for
// without the dependency present.

import crypto from 'node:crypto';

export const DP_TRAINING_VERSION = 'finalized-c2-v1';
export const USER_LEVEL_DP_VERSION = 'w1003-user-level-dp-v1';

export const USER_LEVEL_DP_PRESETS = Object.freeze({
  regulated_strict: Object.freeze({
    id: 'regulated_strict',
    target_epsilon: 2,
    delta: 1e-6,
    noise_multiplier: 1.6,
    max_examples_per_user: 32,
    min_users: 1000,
    intended_use: 'regulated fine-tuning where user-level leakage is the primary risk',
  }),
  balanced: Object.freeze({
    id: 'balanced',
    target_epsilon: 4,
    delta: 1e-6,
    noise_multiplier: 1.1,
    max_examples_per_user: 64,
    min_users: 500,
    intended_use: 'default user-level DP starting point before benchmark calibration',
  }),
  utility_first: Object.freeze({
    id: 'utility_first',
    target_epsilon: 8,
    delta: 1e-5,
    noise_multiplier: 0.8,
    max_examples_per_user: 128,
    min_users: 250,
    intended_use: 'exploratory runs where utility loss is being measured before any regulated claim',
  }),
});

// ---------------------------------------------------------------------------
// Crypto-grade standard normal sampler. node:crypto CSPRNG -> Box-Muller.
// A DP guarantee built on a predictable PRNG is not a guarantee, so every
// Gaussian draw on this path uses randomBytes, NOT Math.random.
// ---------------------------------------------------------------------------
function _cryptoUniform() {
  // 53-bit uniform in (0,1) from 8 CSPRNG bytes. Reject exact-0 so log() is safe.
  const buf = crypto.randomBytes(8);
  // Build a 53-bit integer (two 32-bit halves, top 21 bits of the high word).
  const hi = buf.readUInt32BE(0) & 0x1fffff; // 21 bits
  const lo = buf.readUInt32BE(4);            // 32 bits
  const v = hi * 4294967296 + lo;            // up to 2^53-1
  const u = (v + 0.5) / 9007199254740992;    // (0,1) open-ish
  return u <= 0 ? Number.MIN_VALUE : (u >= 1 ? 1 - 1e-12 : u);
}

export function cryptoGaussian() {
  const u1 = _cryptoUniform();
  const u2 = _cryptoUniform();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// RDP of the Sampled Gaussian Mechanism (SGM).
//
// For Poisson subsampling rate q and noise multiplier sigma (noise stddev in
// units of the clipping norm / sensitivity), the per-step RDP at integer order
// alpha is upper-bounded by:
//
//   RDP(alpha) <= (1/(alpha-1)) * ln( sum_{k=0..alpha} C(alpha,k) (1-q)^(alpha-k) q^k exp( (k^2-k)/(2 sigma^2) ) )
//
// This is the standard binomial bound for integer orders (Mironov-Talwar-Zhang
// 2019, "Renyi Differential Privacy of the Sampled Gaussian Mechanism", eq. for
// integer alpha). We evaluate it in LOG space (log-sum-exp) so the binomial
// terms do not overflow at large alpha, then compose over T steps by simple
// additivity of RDP (RDP_T(alpha) = T * RDP_1(alpha)).
//
// At the no-subsampling limit q=1 the bound reduces to the plain Gaussian
// mechanism RDP: alpha / (2 sigma^2). We special-case q>=1 to that closed form
// (the binomial sum is exact there but the closed form avoids C(alpha,alpha)
// rounding noise).
// ---------------------------------------------------------------------------

function _logComb(n, k) {
  // log C(n,k) via lgamma. n,k are non-negative integers, k<=n.
  return _lgamma(n + 1) - _lgamma(k + 1) - _lgamma(n - k + 1);
}

// Lanczos approximation for ln(Gamma(x)), x>0. Accurate to ~1e-13, ample for
// the binomial coefficients at the integer orders we use (alpha up to ~256).
const _LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];
function _lgamma(x) {
  if (x < 0.5) {
    // Reflection - not needed for our positive-integer args but kept correct.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - _lgamma(1 - x);
  }
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < _LANCZOS.length; i++) a += _LANCZOS[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function _logSumExp(logs) {
  let m = -Infinity;
  for (const l of logs) if (l > m) m = l;
  if (!Number.isFinite(m)) return m;
  let s = 0;
  for (const l of logs) s += Math.exp(l - m);
  return m + Math.log(s);
}

// Per-step RDP at integer order alpha for SGM(q, sigma).
//
// Evaluates the EXACT binomial log-moment of the Sampled Gaussian Mechanism
// (Mironov-Talwar-Zhang 2019, "RDP of the Sampled Gaussian Mechanism", integer
// order). This is a valid RDP UPPER BOUND for the SGM:
//
//   RDP(alpha) <= (1/(alpha-1)) ln( sum_{k=0..alpha} C(alpha,k)
//                    (1-q)^(alpha-k) q^k exp((k^2-k)/(2 sigma^2)) ).
//
// We restrict to INTEGER orders: the integer binomial moment is exact and needs
// no special-function (erfc) machinery, and because we scan a dense integer grid
// and the converter takes the tightest order, the reported (epsilon, delta) is a
// sound conservative bound. (TF-Privacy/Opacus additionally scan fractional
// orders, which can only LOWER the reported epsilon; never reporting that extra
// tightening keeps us strictly on the safe side of the guarantee - we would
// rather over-report epsilon than ship a privacy claim we cannot stand behind.)
export function sgmRdpAtOrder(q, sigma, alpha) {
  const sig2 = sigma * sigma;
  if (!(sigma > 0)) return Infinity;
  if (q <= 0) return 0; // no data touched -> no privacy cost
  if (q >= 1) {
    // Plain Gaussian mechanism RDP.
    return alpha / (2 * sig2);
  }
  const a = Math.round(alpha);
  if (a < 2) return 0;
  const log1mq = Math.log1p(-q);
  const logq = Math.log(q);
  const terms = [];
  for (let k = 0; k <= a; k++) {
    const logBinom = _logComb(a, k);
    const logProb = (a - k) * log1mq + k * logq;
    const gaussTerm = (k * k - k) / (2 * sig2); // (k^2-k)/(2 sigma^2)
    terms.push(logBinom + logProb + gaussTerm);
  }
  const logMoment = _logSumExp(terms);
  return logMoment / (a - 1);
}

// Default Renyi order grid - a dense set of integer orders. The accountant
// converts each to (eps, delta) and keeps the tightest; a dense low-order body
// (where the optimum almost always sits for typical sigma/q) plus a long tail
// for the high-noise / many-steps regime.
export function defaultRdpOrders() {
  const orders = [];
  for (let a = 2; a <= 128; a++) orders.push(a);
  for (const a of [160, 192, 224, 256, 320, 384, 512]) orders.push(a);
  return orders;
}

// ---------------------------------------------------------------------------
// computeDpSgdBudget({ noise_multiplier, sample_rate, steps, delta, orders? })
//
// THE accountant. Returns the real (epsilon, delta) upper bound for a DP-SGD
// run of `steps` Sampled-Gaussian steps at subsampling `sample_rate` and noise
// multiplier `noise_multiplier`, by:
//   1. computing per-step RDP at every order in `orders`,
//   2. scaling by `steps` (RDP additivity),
//   3. converting each order's composed RDP to an (eps, delta) pair via the
//      tightened RDP->DP bound:
//        eps(alpha) = rdp + ln( (alpha-1)/alpha ) - (ln(delta) + ln(alpha))/(alpha-1)
//      (Balle et al. 2020 tightening of Mironov 2017),
//   4. taking the minimum eps over all orders (the accountant's job is to pick
//      the order that gives the tightest valid bound).
//
// epsilon=Infinity (with dp_effective:false) when noise_multiplier<=0 - a LOUD
// "you asked for DP but configured zero noise" signal, never a silent pass.
// ---------------------------------------------------------------------------
export function computeDpSgdBudget({
  noise_multiplier,
  sample_rate,
  steps,
  delta = 1e-5,
  orders = null,
} = {}) {
  const sigma = Number(noise_multiplier);
  const q = Number(sample_rate);
  const T = Math.round(Number(steps));
  const del = Number(delta);
  if (!Number.isFinite(q) || q < 0 || q > 1) {
    throw new Error('sample_rate must be in [0,1]');
  }
  if (!Number.isFinite(T) || T < 0) {
    throw new Error('steps must be a non-negative integer');
  }
  if (!Number.isFinite(del) || del <= 0 || del >= 1) {
    throw new Error('delta must be in (0,1)');
  }
  if (!Number.isFinite(sigma) || sigma <= 0) {
    return {
      epsilon: Infinity,
      delta: del,
      noise_multiplier: Number.isFinite(sigma) ? sigma : 0,
      sample_rate: q,
      steps: T,
      dp_effective: false,
      mechanism: 'dp_sgd_sampled_gaussian',
      accountant: 'rdp_moments_v1',
      note: 'noise_multiplier<=0: no calibrated noise added, epsilon is infinite (no DP guarantee).',
      version: DP_TRAINING_VERSION,
    };
  }
  const ord = (Array.isArray(orders) && orders.length) ? orders.slice() : defaultRdpOrders();
  let bestEps = Infinity;
  let bestOrder = null;
  const perOrder = [];
  for (const alpha of ord) {
    const rdpStep = sgmRdpAtOrder(q, sigma, alpha);
    const rdpTotal = rdpStep * T;
    // RDP -> (eps, delta) conversion (Balle et al. 2020 tightened bound).
    // eps = rdp - (ln(delta) + ln(alpha))/(alpha-1) + ln((alpha-1)/alpha)
    const eps = rdpTotal
      + Math.log((alpha - 1) / alpha)
      - (Math.log(del) + Math.log(alpha)) / (alpha - 1);
    perOrder.push({ order: alpha, rdp: rdpTotal, epsilon: eps });
    if (Number.isFinite(eps) && eps < bestEps) {
      bestEps = eps;
      bestOrder = alpha;
    }
  }
  return {
    epsilon: bestEps,
    delta: del,
    optimal_order: bestOrder,
    noise_multiplier: sigma,
    sample_rate: q,
    steps: T,
    dp_effective: true,
    mechanism: 'dp_sgd_sampled_gaussian',
    accountant: 'rdp_moments_v1',
    orders_scanned: ord.length,
    version: DP_TRAINING_VERSION,
  };
}

// ---------------------------------------------------------------------------
// DP-SGD step primitive (reference / verifier path).
//
// dpSgdStep({ per_example_grads, l2_clip, noise_multiplier, lot_size? }):
//   - clips each per-example gradient vector to L2 norm <= l2_clip,
//   - sums the clipped gradients,
//   - adds Gaussian noise N(0, (noise_multiplier * l2_clip)^2 * I),
//   - returns the noised AVERAGE gradient (sum+noise)/lot_size and a
//     dp_applied record matching the federated-learning.js shape so receipts
//     are uniform across the federated + distill DP paths.
//
// This is the exact per-step mechanism the accountant prices. A test can run N
// steps of this on toy gradients and verify the realized noise scale matches
// noise_multiplier*l2_clip - i.e. the mechanism and the accounting agree.
// ---------------------------------------------------------------------------
export function clipL2(vec, maxNorm) {
  if (!Array.isArray(vec)) throw new Error('vec must be an array');
  if (!(maxNorm > 0)) throw new Error('maxNorm must be > 0');
  let sq = 0;
  for (const v of vec) sq += v * v;
  const norm = Math.sqrt(sq);
  if (norm <= maxNorm || norm === 0) {
    return { clipped: vec.slice(), norm, clip_applied: false };
  }
  const scale = maxNorm / norm;
  return { clipped: vec.map((v) => v * scale), norm, clip_applied: true };
}

export function dpSgdStep({
  per_example_grads,
  l2_clip,
  noise_multiplier,
  lot_size = null,
} = {}) {
  if (!Array.isArray(per_example_grads) || per_example_grads.length === 0) {
    throw new Error('per_example_grads must be a non-empty array of gradient vectors');
  }
  const C = Number(l2_clip);
  const sigma = Number(noise_multiplier);
  if (!(C > 0)) throw new Error('l2_clip must be > 0');
  if (!Number.isFinite(sigma) || sigma < 0) throw new Error('noise_multiplier must be >= 0');
  const dim = per_example_grads[0].length;
  for (const g of per_example_grads) {
    if (!Array.isArray(g) || g.length !== dim) {
      throw new Error('all per-example gradients must be arrays of equal length');
    }
  }
  const lot = lot_size != null ? Number(lot_size) : per_example_grads.length;
  if (!(lot > 0)) throw new Error('lot_size must be > 0');
  // 1. Per-example clip + sum.
  const summed = new Array(dim).fill(0);
  let clip_count = 0;
  for (const g of per_example_grads) {
    const { clipped, clip_applied } = clipL2(g, C);
    if (clip_applied) clip_count += 1;
    for (let i = 0; i < dim; i++) summed[i] += clipped[i];
  }
  // 2. Calibrated Gaussian noise on the summed clipped gradients. The noise
  // stddev is noise_multiplier * clip (sensitivity of the SUM is C because one
  // example changes the sum by at most its clipped norm C).
  const noiseStd = sigma * C;
  const noised = new Array(dim);
  for (let i = 0; i < dim; i++) {
    const noise = noiseStd > 0 ? cryptoGaussian() * noiseStd : 0;
    // 3. Average over the lot (the DP-SGD update is the noised mean).
    noised[i] = (summed[i] + noise) / lot;
  }
  return {
    grad: noised,
    dp_applied: {
      mechanism: 'dp_sgd_sampled_gaussian',
      l2_clip: C,
      noise_multiplier: sigma,
      noise_scale: noiseStd,
      lot_size: lot,
      examples_clipped: clip_count,
      dp_effective: sigma > 0,
    },
    version: DP_TRAINING_VERSION,
  };
}

// ---------------------------------------------------------------------------
// PATE - Private Aggregation of Teacher Ensembles.
//
// partitionForPate({ captures, n_teachers, allow_cross_region?, seed? }):
//   Splits `captures` into `n_teachers` DISJOINT partitions (one private
//   training set per teacher). RESIDENCY-AWARE: captures are first grouped by
//   their {region} tag (src/data-residency.js); each region's captures are
//   partitioned independently and the resulting per-region partitions are
//   assigned to distinct teachers so NO teacher ever sees two regions' data
//   unless allow_cross_region:true. This is what makes DP compose with
//   data-locality: a teacher trained only on EU captures cannot leak US data,
//   and the partition map records which region each teacher covers.
//
//   When allow_cross_region:true the region grouping is bypassed (single global
//   pool) - a LOUD opt-out that the receipt records as cross_region:true so an
//   auditor sees the residency fence was deliberately lowered.
//
//   Disjointness is the PATE privacy precondition: because the partitions do
//   not overlap, changing one capture affects exactly one teacher's votes, so
//   the aggregation's sensitivity is 1 vote regardless of ensemble size.
// ---------------------------------------------------------------------------
function _seededShuffle(arr, seed) {
  // Deterministic Fisher-Yates from a sha256 keystream so partitioning is
  // reproducible (the receipt can re-derive the split) while still being
  // well-mixed. NOT used for the privacy noise - that stays CSPRNG.
  const out = arr.slice();
  let counter = 0;
  let pool = Buffer.alloc(0);
  let off = 0;
  const nextU32 = () => {
    if (off + 4 > pool.length) {
      pool = crypto.createHash('sha256').update(String(seed) + ':' + counter).digest();
      counter += 1;
      off = 0;
    }
    const v = pool.readUInt32BE(off);
    off += 4;
    return v;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = nextU32() % (i + 1);
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

export function partitionForPate({
  captures,
  n_teachers,
  allow_cross_region = false,
  seed = 'kolm-pate',
} = {}) {
  if (!Array.isArray(captures) || captures.length === 0) {
    throw new Error('captures must be a non-empty array');
  }
  const n = Math.round(Number(n_teachers));
  if (!(n >= 1)) throw new Error('n_teachers must be >= 1');
  if (n > captures.length) {
    throw new Error('n_teachers (' + n + ') exceeds capture count (' + captures.length + '); each teacher needs >=1 example');
  }

  // Group by residency region unless cross-region is explicitly allowed.
  const groups = new Map();
  if (allow_cross_region) {
    groups.set('GLOBAL', captures.slice());
  } else {
    for (const c of captures) {
      const region = (c && typeof c === 'object' && c.region) ? String(c.region) : 'GLOBAL';
      if (!groups.has(region)) groups.set(region, []);
      groups.get(region).push(c);
    }
  }

  // Allocate teachers across regions proportionally to each region's size,
  // guaranteeing >=1 teacher per non-empty region (residency fence: a region
  // always gets at least one dedicated teacher so its data is never orphaned
  // into a cross-region teacher).
  const regionList = Array.from(groups.keys());
  const total = captures.length;
  const alloc = {};
  let assigned = 0;
  for (const r of regionList) {
    alloc[r] = Math.max(1, Math.floor((groups.get(r).length / total) * n));
    assigned += alloc[r];
  }
  // Rebalance to exactly n teachers (trim/grow the largest regions).
  const bySize = regionList.slice().sort((a, b) => groups.get(b).length - groups.get(a).length);
  let idx = 0;
  while (assigned > n) {
    const r = bySize[idx % bySize.length];
    if (alloc[r] > 1) { alloc[r] -= 1; assigned -= 1; }
    idx += 1;
    if (idx > 100000) break;
  }
  idx = 0;
  while (assigned < n) {
    const r = bySize[idx % bySize.length];
    alloc[r] += 1; assigned += 1;
    idx += 1;
    if (idx > 100000) break;
  }

  const partitions = [];
  let teacherId = 0;
  for (const r of regionList) {
    const pool = _seededShuffle(groups.get(r), seed + ':' + r);
    const k = alloc[r];
    // Round-robin assign this region's captures to its k teachers (disjoint).
    const buckets = Array.from({ length: k }, () => []);
    pool.forEach((c, i) => buckets[i % k].push(c));
    for (const b of buckets) {
      partitions.push({
        teacher_id: teacherId,
        region: r,
        capture_count: b.length,
        captures: b,
      });
      teacherId += 1;
    }
  }

  return {
    partitions,
    n_teachers: partitions.length,
    cross_region: !!allow_cross_region,
    regions: regionList,
    region_allocation: alloc,
    disjoint: true,
    version: DP_TRAINING_VERSION,
  };
}

// pateAggregate({ votes, n_labels, noise_multiplier, mechanism? }):
//   votes is the per-teacher predicted label index for ONE student query
//   (length = number of teachers). We build the label histogram, add
//   independent Gaussian (or Laplace) noise to each bin, and return the
//   noisy-argmax. This is the "report noisy max" GNMax / LNMax aggregator from
//   Papernot et al. (2018, Scalable Private Learning with PATE).
//
//   Sensitivity of the histogram is 1 (disjoint partitions: one teacher moves
//   one vote). The per-query RDP cost of GNMax is upper-bounded by the SAME
//   Gaussian-mechanism RDP at sensitivity 1 used by DP-SGD (a DATA-INDEPENDENT
//   bound; the tighter data-dependent PATE bound would require the vote gap and
//   is deliberately not claimed here so the receipt stays a valid upper bound).
export function pateAggregate({
  votes,
  n_labels,
  noise_multiplier,
  mechanism = 'gaussian',
} = {}) {
  if (!Array.isArray(votes) || votes.length === 0) {
    throw new Error('votes must be a non-empty array of teacher label indices');
  }
  const L = Math.round(Number(n_labels));
  if (!(L >= 2)) throw new Error('n_labels must be >= 2');
  const sigma = Number(noise_multiplier);
  if (!Number.isFinite(sigma) || sigma < 0) throw new Error('noise_multiplier must be >= 0');
  const hist = new Array(L).fill(0);
  for (const v of votes) {
    const lbl = Math.round(Number(v));
    if (lbl < 0 || lbl >= L) throw new Error('vote label ' + v + ' out of range [0,' + (L - 1) + ']');
    hist[lbl] += 1;
  }
  const noisy = hist.slice();
  if (sigma > 0) {
    for (let i = 0; i < L; i++) {
      if (mechanism === 'laplace') {
        // Laplace(scale = sigma); sensitivity 1. Parameterized by sigma as the
        // scale for a uniform interface with the Gaussian path.
        let u = _cryptoUniform() - 0.5;
        if (u === 0) u = 1e-12;
        noisy[i] += -sigma * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
      } else {
        noisy[i] += cryptoGaussian() * sigma; // sensitivity-1 Gaussian
      }
    }
  }
  let argmax = 0;
  for (let i = 1; i < L; i++) if (noisy[i] > noisy[argmax]) argmax = i;
  return {
    label: argmax,
    histogram: hist,
    noisy_histogram: noisy,
    mechanism: mechanism === 'laplace' ? 'pate_lnmax' : 'pate_gnmax',
    noise_multiplier: sigma,
    dp_effective: sigma > 0,
    sensitivity: 1,
    version: DP_TRAINING_VERSION,
  };
}

// pateBudget({ n_queries, noise_multiplier, delta, orders? }):
//   Composes the per-query GNMax RDP over n_queries answered student queries
//   and converts to (eps, delta). Each query is a sensitivity-1 Gaussian on the
//   histogram, so per-query RDP = alpha/(2 sigma^2) (the q=1 SGM case), summed
//   over n_queries. We reuse computeDpSgdBudget with sample_rate=1 and
//   steps=n_queries so the accountant is the SAME audited code path.
export function pateBudget({ n_queries, noise_multiplier, delta = 1e-5, orders = null } = {}) {
  const budget = computeDpSgdBudget({
    noise_multiplier,
    sample_rate: 1,
    steps: n_queries,
    delta,
    orders,
  });
  return {
    ...budget,
    mechanism: 'pate_gnmax',
    n_queries: Math.round(Number(n_queries)),
    accountant: 'rdp_moments_v1',
  };
}

// ---------------------------------------------------------------------------
// buildPrivacyBudgetBlock(...) - the manifest stamp.
//
// Produces the canonical privacy_budget object that src/distill-pipeline.js
// (and the .kolm manifest builder in src/artifact.js) attach to the receipt
// chain alongside teacher_source. The block is deterministic given its inputs
// so two runs with the same DP config produce the same stamp (modulo the
// realized noise, which is never put in the manifest - only the calibrated
// parameters + the proven budget are).
//
// path: 'dp_sgd' | 'pate' | 'none'.
//   - 'none' is the explicit "DP was NOT applied" stamp (dp_effective:false,
//     epsilon:null) so the absence of DP is itself recorded - a shipped model
//     can never be silently ambiguous about whether it carries a guarantee.
// ---------------------------------------------------------------------------
export function buildPrivacyBudgetBlock({
  path = 'none',
  budget = null,
  teacher_source = null,
  region = null,
  region_allocation = null,
  cross_region = null,
} = {}) {
  const base = {
    privacy_path: path,
    teacher_source: teacher_source ?? null,
    region: region ?? null,
    accountant: 'rdp_moments_v1',
    version: DP_TRAINING_VERSION,
  };
  if (path === 'none' || !budget) {
    return {
      ...base,
      privacy_path: 'none',
      dp_effective: false,
      epsilon: null,
      delta: null,
      note: 'No differential-privacy training path was applied to this artifact.',
    };
  }
  return {
    ...base,
    dp_effective: budget.epsilon !== Infinity && budget.dp_effective !== false,
    epsilon: budget.epsilon === Infinity ? 'Infinity' : budget.epsilon,
    delta: budget.delta ?? null,
    mechanism: budget.mechanism || null,
    noise_multiplier: budget.noise_multiplier ?? null,
    sample_rate: budget.sample_rate ?? null,
    steps: budget.steps ?? null,
    n_queries: budget.n_queries ?? null,
    optimal_order: budget.optimal_order ?? null,
    privacy_unit: budget.privacy_unit ?? null,
    user_count: budget.user_count ?? null,
    total_examples: budget.total_examples ?? null,
    max_examples_per_user: budget.max_examples_per_user ?? null,
    clipped_user_count: budget.clipped_user_count ?? null,
    accountant_comparison: budget.accountant_comparison ?? null,
    region_allocation: region_allocation ?? null,
    cross_region: cross_region ?? null,
  };
}

// ---------------------------------------------------------------------------
// reconcileSpentBudget(requested, observed) - fail-LOUD reconciliation.
//
// The accountant prices a budget from the REQUESTED (noise_multiplier,
// sample_rate, steps). The trainer (JS reference or Python Opacus) may run with
// slightly different realized parameters (e.g. early-stop reduced the steps).
// This re-prices the budget from what the trainer ACTUALLY ran and refuses to
// stamp a tighter epsilon than reality: if the observed config spends MORE than
// requested, the stamped budget is the observed (larger) epsilon, with a
// divergence flag. We never under-report the spend.
// ---------------------------------------------------------------------------
export function reconcileSpentBudget(requested, observed, { delta = 1e-5 } = {}) {
  const req = computeDpSgdBudget({ ...requested, delta });
  if (!observed) return { ...req, reconciled: false };
  const obs = computeDpSgdBudget({ ...observed, delta });
  // Pick the LARGER epsilon (more privacy spent) as the binding number.
  const reqEps = req.epsilon === Infinity ? Infinity : Number(req.epsilon);
  const obsEps = obs.epsilon === Infinity ? Infinity : Number(obs.epsilon);
  const binding = obsEps >= reqEps ? obs : req;
  const reqCmp = Number.isFinite(reqEps) ? reqEps : 1e18;
  const obsCmp = Number.isFinite(obsEps) ? obsEps : 1e18;
  const diverged = Math.abs(obsCmp - reqCmp) > 1e-9;
  return {
    ...binding,
    reconciled: true,
    requested_epsilon: req.epsilon,
    observed_epsilon: obs.epsilon,
    diverged,
    note: diverged
      ? 'Trainer realized config diverged from requested; stamped the larger (more conservative) epsilon.'
      : 'Trainer realized config matched the requested DP config.',
  };
}

// ---------------------------------------------------------------------------
// buildDpTrainerEnv(opts) - ENV-GATED wiring to apps/trainer/distill.py.
//
// When the operator opts into DP-SGD for the heavy GPU trainer, the trainer
// must run real DP-SGD (Opacus PrivacyEngine). We DO NOT silently degrade to a
// non-DP run: this returns the env the worker passes to the Python trainer, and
// the trainer is expected to FAIL LOUD with an install hint if opacus is not
// importable (rather than train without DP and lie in the manifest). The hint
// is embedded here so the JS side can surface it even before the trainer runs.
//
// Returns { env, install_hint, dp_requested }.
// ---------------------------------------------------------------------------
export function buildDpTrainerEnv({
  enabled = false,
  l2_clip = 1.0,
  noise_multiplier = 1.1,
  sample_rate = null,
  steps = null,
  delta = 1e-5,
} = {}) {
  if (!enabled) {
    return { env: {}, dp_requested: false, install_hint: null };
  }
  const sigma = Number(noise_multiplier);
  if (!Number.isFinite(sigma) || sigma <= 0) {
    const e = new Error('dp_sgd_requested_but_zero_noise: noise_multiplier must be > 0 to provide a DP guarantee');
    e.code = 'DP_ZERO_NOISE';
    e.hint = 'set noise_multiplier > 0 (typical DP-SGD value 0.8-1.5) or disable the DP path.';
    throw e;
  }
  return {
    dp_requested: true,
    env: {
      KOLM_DP_SGD: '1',
      KOLM_DP_L2_CLIP: String(Number(l2_clip)),
      KOLM_DP_NOISE_MULTIPLIER: String(sigma),
      KOLM_DP_SAMPLE_RATE: sample_rate != null ? String(Number(sample_rate)) : '',
      KOLM_DP_STEPS: steps != null ? String(Math.round(Number(steps))) : '',
      KOLM_DP_DELTA: String(Number(delta)),
    },
    // The Python trainer (apps/trainer/distill.py) reads KOLM_DP_SGD and, if
    // set, REQUIRES opacus. This hint is what it must print on ImportError.
    install_hint: 'DP-SGD requested (KOLM_DP_SGD=1) but the GPU trainer needs Opacus. Install with: pip install opacus>=1.4 . The trainer MUST fail rather than train without DP.',
  };
}

function _clonePreset(preset) {
  return JSON.parse(JSON.stringify(preset));
}

export function userLevelDpPresets() {
  return Object.fromEntries(Object.entries(USER_LEVEL_DP_PRESETS).map(([k, v]) => [k, _clonePreset(v)]));
}

export function recommendUserLevelDpPreset({ regime = 'balanced', user_count = null } = {}) {
  const key = USER_LEVEL_DP_PRESETS[regime] ? regime
    : (regime === 'regulated' || regime === 'strict' ? 'regulated_strict'
      : (regime === 'utility' ? 'utility_first' : 'balanced'));
  const preset = _clonePreset(USER_LEVEL_DP_PRESETS[key]);
  const users = Number(user_count);
  return {
    ...preset,
    user_count: Number.isFinite(users) && users > 0 ? Math.floor(users) : null,
    ready_for_default: Number.isFinite(users) && users >= preset.min_users,
    warning: Number.isFinite(users) && users < preset.min_users
      ? `user_count ${Math.floor(users)} is below preset min_users ${preset.min_users}; treat as benchmark-only`
      : null,
    version: USER_LEVEL_DP_VERSION,
  };
}

export function summarizeUserContributions(rows, {
  user_key = 'user_id',
  max_examples_per_user = USER_LEVEL_DP_PRESETS.balanced.max_examples_per_user,
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('rows must be a non-empty array');
  }
  const maxPerUser = Math.max(1, Math.floor(Number(max_examples_per_user)));
  const groups = new Map();
  let missing_user_id = 0;
  for (const row of rows) {
    const id = row && row[user_key] != null && String(row[user_key]).trim() !== ''
      ? String(row[user_key])
      : null;
    if (!id) {
      missing_user_id += 1;
      continue;
    }
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  if (groups.size === 0) {
    throw new Error(`no rows carried user key ${user_key}`);
  }

  const users = [];
  let retained = 0;
  let clipped_user_count = 0;
  let clipped_examples = 0;
  for (const [user_id, userRows] of groups.entries()) {
    const kept = userRows.slice(0, maxPerUser);
    retained += kept.length;
    if (userRows.length > kept.length) {
      clipped_user_count += 1;
      clipped_examples += userRows.length - kept.length;
    }
    users.push({
      user_id,
      original_examples: userRows.length,
      retained_examples: kept.length,
      clipped_examples: userRows.length - kept.length,
    });
  }
  users.sort((a, b) => b.original_examples - a.original_examples || a.user_id.localeCompare(b.user_id));

  return {
    privacy_unit: 'user',
    user_key,
    user_count: users.length,
    total_examples: rows.length,
    retained_examples: retained,
    missing_user_id,
    max_examples_per_user: maxPerUser,
    clipped_user_count,
    clipped_examples,
    max_user_examples_observed: users[0]?.original_examples || 0,
    users,
    version: USER_LEVEL_DP_VERSION,
  };
}

export function computeUserLevelDpSgdBudget({
  rows = null,
  user_key = 'user_id',
  user_count = null,
  total_examples = null,
  batch_users = null,
  epochs = 1,
  steps = null,
  noise_multiplier = USER_LEVEL_DP_PRESETS.balanced.noise_multiplier,
  max_examples_per_user = USER_LEVEL_DP_PRESETS.balanced.max_examples_per_user,
  delta = USER_LEVEL_DP_PRESETS.balanced.delta,
  preset = null,
  accountant_comparison = true,
} = {}) {
  const selectedPreset = preset ? recommendUserLevelDpPreset({ regime: preset, user_count }) : null;
  const summary = rows
    ? summarizeUserContributions(rows, { user_key, max_examples_per_user: selectedPreset?.max_examples_per_user || max_examples_per_user })
    : {
        privacy_unit: 'user',
        user_key,
        user_count: Math.floor(Number(user_count)),
        total_examples: Math.floor(Number(total_examples || 0)),
        retained_examples: Math.floor(Number(total_examples || 0)),
        missing_user_id: 0,
        max_examples_per_user: selectedPreset?.max_examples_per_user || max_examples_per_user,
        clipped_user_count: 0,
        clipped_examples: 0,
        users: [],
        version: USER_LEVEL_DP_VERSION,
      };
  if (!Number.isFinite(summary.user_count) || summary.user_count <= 0) {
    throw new Error('user_count must be > 0 for user-level DP');
  }
  const usersPerStep = batch_users != null
    ? Math.max(1, Math.floor(Number(batch_users)))
    : Math.max(1, Math.ceil(Math.sqrt(summary.user_count)));
  const sampleRate = Math.min(1, usersPerStep / summary.user_count);
  const resolvedSteps = steps != null
    ? Math.max(0, Math.floor(Number(steps)))
    : Math.ceil(summary.user_count / usersPerStep) * Math.max(1, Math.ceil(Number(epochs)));
  const sigma = selectedPreset?.noise_multiplier ?? noise_multiplier;
  const resolvedDelta = selectedPreset?.delta ?? delta;
  const budget = computeDpSgdBudget({
    noise_multiplier: sigma,
    sample_rate: sampleRate,
    steps: resolvedSteps,
    delta: resolvedDelta,
  });

  const comparison = accountant_comparison ? {
    primary: 'rdp_integer_upper_bound',
    secondary: 'pld_or_fractional_order_external_check_required',
    status: 'safe_upper_bound_only',
    note: 'The local claim uses the conservative integer-order RDP upper bound; PLD/fractional-order runs may only lower epsilon after an external accountant report is attached.',
  } : null;

  return {
    ...budget,
    mechanism: 'user_level_dp_sgd_sampled_gaussian',
    privacy_unit: 'user',
    user_key: summary.user_key,
    user_count: summary.user_count,
    total_examples: summary.total_examples,
    retained_examples: summary.retained_examples,
    missing_user_id: summary.missing_user_id,
    max_examples_per_user: summary.max_examples_per_user,
    clipped_user_count: summary.clipped_user_count,
    clipped_examples: summary.clipped_examples,
    batch_users: usersPerStep,
    sample_rate: sampleRate,
    steps: resolvedSteps,
    preset: selectedPreset?.id || null,
    target_epsilon: selectedPreset?.target_epsilon || null,
    ready_for_default: selectedPreset ? selectedPreset.ready_for_default : null,
    accountant_comparison: comparison,
    contribution_summary: summary,
    version: USER_LEVEL_DP_VERSION,
  };
}

export function buildUserLevelDpBenchmarkPlan({
  model_id,
  dataset_id,
  user_key = 'user_id',
  preset = 'balanced',
  user_count = null,
  baseline_metric = null,
  dp_metric = null,
  metric_name = 'eval_accuracy',
  receipt_hash = null,
  report_url = null,
} = {}) {
  const recommendation = recommendUserLevelDpPreset({ regime: preset, user_count });
  const hasMeasuredUtility = Number.isFinite(Number(baseline_metric))
    && Number.isFinite(Number(dp_metric))
    && typeof receipt_hash === 'string'
    && /^[0-9a-f]{64}$/i.test(receipt_hash);
  const utility_delta = hasMeasuredUtility
    ? Number((Number(dp_metric) - Number(baseline_metric)).toFixed(12))
    : null;
  const requirements = [
    { id: 'model_id', ok: typeof model_id === 'string' && model_id.trim() !== '' },
    { id: 'dataset_id', ok: typeof dataset_id === 'string' && dataset_id.trim() !== '' },
    { id: 'user_key', ok: typeof user_key === 'string' && user_key.trim() !== '' },
    { id: 'preset_ready', ok: recommendation.ready_for_default === true },
    { id: 'measured_utility_receipt', ok: hasMeasuredUtility },
  ];
  const blockers = requirements.filter((r) => !r.ok).map((r) => r.id);
  return {
    version: USER_LEVEL_DP_VERSION,
    model_id: model_id || null,
    dataset_id: dataset_id || null,
    user_key,
    preset: recommendation,
    metric_name,
    measured: hasMeasuredUtility,
    claimable_default: blockers.length === 0,
    utility: {
      baseline_metric: baseline_metric == null ? null : Number(baseline_metric),
      dp_metric: dp_metric == null ? null : Number(dp_metric),
      utility_delta,
      receipt_hash: receipt_hash || null,
      report_url: report_url || null,
    },
    requirements,
    blockers,
    claim_scope: 'User-level DP math can be reported locally; regulated default claims require measured utility evidence with a receipt hash.',
  };
}
