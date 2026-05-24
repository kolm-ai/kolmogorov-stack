# Federated distillation consortium guide

STATUS: ACTIVE, 2026-05-24 (W830)

This guide walks an operator through joining and running a federated distillation consortium with kolm. A consortium is a group of tenants that pool weights or decision rows without exposing raw data to each other.

The HTTP API is consumed both by the CLI (`kolm federated ...`) and by the
UI at `/account/federated/consortium`. Every example in this guide includes
both a CLI form and a direct cURL form so callers can wire the routes from
SDKs without going through the CLI. The W830 base routes:

| Route | Verb | Module |
|-------|------|--------|
| `/v1/federated/consortium/opt-in` | POST | `src/federated-consortium-routes.js` |
| `/v1/federated/consortium/opt-out` | POST | `src/federated-consortium-routes.js` |
| `/v1/federated/consortium/members` | GET | `src/federated-consortium-routes.js` |
| `/v1/federated/consortium/budget` | GET | `src/federated-consortium-routes.js` |
| `/v1/federated/consortium/aggregations` | GET | `src/federated-consortium-routes.js` |
| `/v1/federated/consortium/verify-mia` | POST | `src/federated-mia.js` |

## 1. Why consortium

Single-tenant distillation works when one tenant has enough capture volume to train a student that beats the teacher on the response classes it cares about. Many tenants do not have that volume on day one.

A consortium lets multiple tenants pool the signal in their captures (via shared weights or shared approval-row decisions) without exposing the raw input or output text. Each member trains on their own captures locally; only the aggregated signal crosses tenant boundaries.

The result is a stronger shared student than any single tenant could produce alone, with no member ever seeing another member's raw data. This is the federated learning pattern adapted to the distillation workflow.

## 2. Privacy guarantees

The consortium contract has three layered guarantees:

- Laplace noise with epsilon=1.0 default. Every aggregated count released to consortium members is perturbed with calibrated Laplace noise. Epsilon=1.0 is the default; the consortium administrator MAY tighten to epsilon=0.5 (stronger privacy, more noise) or relax to epsilon=2.0 (weaker privacy, less noise) per consortium policy.
- Per-tenant opt-in. No tenant is automatically enrolled. Each tenant runs an explicit opt-in call per namespace; the opt-in writes a durable receipt. Opt-out is immediate (see section 9).
- No raw text crosses the boundary. Only approval-hash + per-arm count rows are shared. Approval-hashes are sha256(namespace + ':' + sha256(input) + ':' + decision_kind); they are not invertible to the input text.

The privacy guarantees are not unconditional. A tenant that opts in MUST trust the kolm runtime to apply the noise correctly; the runtime is open source and auditable. A consortium administrator that lowers epsilon below 0.5 SHOULD document the rationale in the consortium charter.

## 3. Membership inference attack resistance

The consortium is designed to resist membership inference attacks: an adversary holding the aggregated output should not be able to determine whether a specific input was in a specific tenant's namespace.

The W830-2 verifier runs the standard membership inference attack against a consortium release and reports the attack accuracy. The expected output:

```
kolm federated mia-verify --consortium <consortium_id> --epsilon 1.0
```

Exit codes:

- 0 - attack accuracy at or below random baseline (privacy preserved).
- 2 - attack accuracy above baseline but below the alert threshold (privacy degraded but acceptable; consortium SHOULD consider tightening epsilon).
- 3 - attack accuracy above alert threshold (privacy breached; consortium MUST tighten epsilon or revoke the release).

The verifier is a defensive check, not a guarantee. Consortium administrators SHOULD run it on every release; a non-zero exit code is a stop-the-line event.

## 4. Opt-in flow

A tenant opts in per-namespace. The CLI command:

```
kolm federated opt-in --namespace <ns> --consortium <consortium_id>
```

The wire-level cURL form (POST /v1/federated/consortium/opt-in):

```bash
curl -X POST https://kolm.ai/v1/federated/consortium/opt-in \
  -H "Authorization: Bearer $KOLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "consortium_id": "fintech-q3-2026",
    "scope": ["finance", "support"],
    "epsilon_allocated": 12.5,
    "note": "Q3 fintech consortium with 4 peers"
  }'
```

The command writes a durable opt-in receipt to the local audit log and registers the namespace with the consortium coordinator. The opt-in is immediate; the next aggregation cycle will include the namespace.

To check who is in the consortium (GET /v1/federated/consortium/members):

```bash
curl -H "Authorization: Bearer $KOLM_API_KEY" \
  "https://kolm.ai/v1/federated/consortium/members?consortium_id=fintech-q3-2026"
```

Each row carries `contribution_count` (rounds the peer has submitted to) and
`last_share_at` (most recent hash-only approval share). The `is_self` flag
marks the caller's own row.

Opt-in receipts include: tenant ID, namespace, consortium ID, epsilon, opt-in timestamp, and the signing key fingerprint. The receipt is signed and can be presented to a downstream auditor as proof of the consortium membership scope.

## 5. Share flow

Once opted in, the local kolm runtime computes approval-row shares on each capture cycle. The share rows have the shape:

```
{
  "approval_hash": "<sha256>",
  "per_arm_count": <integer>,
  "namespace_id": "<ns>",
  "shared_at": "<iso8601>"
}
```

Critically, the shares do NOT include the raw input text, the raw output text, or any decoded variant. Only the approval-hash and the per-arm count cross the consortium boundary.

The share is triggered by the cycle timer (default: hourly) or explicitly:

```
kolm federated share --namespace <ns> --consortium <consortium_id>
```

The CLI prints the share count and the byte size of the outbound payload.

## 6. Aggregate flow

The consortium coordinator aggregates per-arm counts across all opted-in tenants and applies Laplace noise at the configured epsilon before distributing the aggregate back.

Pull the latest aggregate:

```
kolm federated aggregate --consortium <consortium_id>
```

To see active + recent aggregation runs (GET /v1/federated/consortium/aggregations):

```bash
curl -H "Authorization: Bearer $KOLM_API_KEY" \
  "https://kolm.ai/v1/federated/consortium/aggregations?consortium_id=fintech-q3-2026&limit=20"
```

Returns rows like:

```json
{
  "ok": true,
  "consortium_id": "fintech-q3-2026",
  "total": 1,
  "aggregations": [
    {
      "aggregation_id": "agg_abc",
      "round_id": "round_42",
      "status": "completed",
      "started_at": "2026-05-22T12:00:00.000Z",
      "completed_at": "2026-05-22T12:14:33.000Z",
      "epsilon_spent": 0.5,
      "n_participants": 4,
      "participant_in_round": true
    }
  ]
}
```

To see the consortium-wide privacy budget (GET /v1/federated/consortium/budget):

```bash
curl -H "Authorization: Bearer $KOLM_API_KEY" \
  "https://kolm.ai/v1/federated/consortium/budget?consortium_id=fintech-q3-2026"
```

The response includes `epsilon_allocated`, `epsilon_spent` (basic-composition
sum across all rounds), `epsilon_spent_by_self` (this tenant's share),
`epsilon_remaining`, and `pct_spent`. When `pct_spent >= 0.95` the consortium
SHOULD be retired before the next round.

The aggregate response includes the per-arm counts with noise applied, the epsilon used, the number of contributing tenants (no per-tenant breakdown), and the aggregation timestamp.

The aggregate is signed by the coordinator key; the local runtime verifies the signature before consuming the aggregate. A signature failure rejects the aggregate and is logged to the audit trail.

## 7. Honest contract

The consortium runtime carries an explicit honesty contract in the response envelope:

- Every aggregate response includes a `noise_applied` field with the Laplace scale used.
- When a release has zero noise (rare; only happens during diagnostics or test mode), the response envelope MUST include `raw_present:true`. This flag is the operator-visible signal that the privacy mechanism is bypassed; production consortiums MUST NOT consume a release with `raw_present:true`.
- The envelope NEVER omits the noise field. A missing noise field is a parser error; the runtime refuses to interpret the response.

The contract makes the privacy mechanism inspectable. An auditor reading any aggregate response can confirm the noise scale that produced it without trusting an out-of-band claim.

## 8. Audit

Every consortium event (opt-in, share, aggregate, opt-out) writes a row to the local audit log. To review the consortium activity for a namespace:

```
kolm federated audit --namespace <ns>
```

The command prints the chronological event list with timestamps, consortium IDs, and operation kinds. The audit trail is the durable evidence an inspector reviews to confirm the consortium scope and the noise parameters in effect.

The audit trail is append-only and hash-chained (see the air-gapped guide for the chain semantics). Tampering with a consortium row invalidates every subsequent row's prev_hash.

## 9. Withdrawal

Opt-out is immediate and irreversible for the current epoch. To leave a consortium:

```
kolm federated opt-out --namespace <ns> --consortium <consortium_id>
```

The cURL form (POST /v1/federated/consortium/opt-out):

```bash
curl -X POST https://kolm.ai/v1/federated/consortium/opt-out \
  -H "Authorization: Bearer $KOLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"consortium_id": "fintech-q3-2026", "reason": "team policy change"}'
```

The command writes an opt-out receipt to the local audit log and notifies the consortium coordinator. The next aggregation cycle does NOT include the namespace.

Important: opt-out does NOT retroactively withdraw past shares. Approval-hashes already shared remain in the consortium's aggregate; only future shares are stopped. If a tenant needs retroactive withdrawal, the consortium administrator MUST run a fresh aggregation cycle excluding the tenant's contributions (consortiums SHOULD document whether they offer this).

A tenant MAY re-opt-in to the same consortium at any time. The re-opt-in is a fresh receipt; it does not restore the prior session.
