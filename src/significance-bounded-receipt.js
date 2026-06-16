// src/significance-bounded-receipt.js
//
// FINALIZED-C6 - bind the significance-bounded gate verdict into a signed,
// tamper-evident receipt.
//
// The gate's eval_summary (test family + alpha + correction method + corrected
// p-values, produced by src/significance-bounded-gate.js
// buildSignificanceEvalSummary) is hashed canonically and that digest is carried
// inside the Ed25519-signed kolm-audit-1 receipt's `output_hash` slot - exactly
// the binding compile-eval-gate.js uses for the point-delta eval_summary, so the
// significance basis of a promotion is verifiable offline with the SAME
// verifier. Tampering with either the summary OR the receipt fails
// verifySignificanceReceipt().
//
// This is a SEPARATE file (not edited into compile-eval-gate.js, which the
// integrator owns) that delegates to compile-eval-gate.js's existing
// embedEvalSummaryReceipt / verifyEvalSummaryReceipt. It keeps the statistics
// engine (significance-bounded-gate.js) pure and IO-free while still giving the
// caller a one-call "gate -> signed receipt" path.

import {
  embedEvalSummaryReceipt,
  verifyEvalSummaryReceipt,
  hashEvalSummary,
} from './compile-eval-gate.js';
import { buildSignificanceEvalSummary } from './significance-bounded-gate.js';

// embedSignificanceReceipt({ gate, candidate_artifact_id, baseline_artifact_id,
//                            namespace_id, signer, ... })
//   -> { receipt, eval_summary, eval_summary_hash, key_fingerprint, signed_at }
//
// Builds the eval_summary from the gate verdict, then binds + signs it. The
// eval_summary is returned alongside the receipt so the caller can persist both
// for offline verification.
export function embedSignificanceReceipt({
  gate,
  candidate_artifact_id,
  baseline_artifact_id,
  namespace_id,
  signer,
  signing_key_id,
  verify_url_base,
} = {}) {
  const eval_summary = buildSignificanceEvalSummary({
    gate,
    candidate_artifact_id,
    baseline_artifact_id,
  });
  const bound = embedEvalSummaryReceipt({
    eval_summary,
    namespace_id: namespace_id || 'sig-bounded-gate',
    candidate_artifact_id: candidate_artifact_id || null,
    signer,
    signing_key_id,
    verify_url_base,
  });
  return {
    receipt: bound.receipt,
    eval_summary,
    eval_summary_hash: bound.eval_summary_hash,
    key_fingerprint: bound.key_fingerprint,
    signed_at: bound.signed_at,
  };
}

// verifySignificanceReceipt(receipt, eval_summary) -> { ok, reason? }
// Confirms the Ed25519 signature AND that the receipt's output_hash still equals
// the canonical hash of the supplied eval_summary (the significance contract).
export function verifySignificanceReceipt(receipt, eval_summary) {
  return verifyEvalSummaryReceipt(receipt, eval_summary);
}

export { hashEvalSummary };

export default {
  embedSignificanceReceipt,
  verifySignificanceReceipt,
  hashEvalSummary,
};
