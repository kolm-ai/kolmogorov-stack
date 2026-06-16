# kolm.ai Stack Innovation Memo

## Where the stack stands

kolm is two surfaces on one cryptographic spine. Surface A is Agent Security Evidence: a free Scan funnels to a $750 Signed Readiness Report, then Continuous monitoring at $299 and $999 a month, then a $25,000 Reviewed Attestation with an optional Deep Red-Team at plus $10,000. Surface B is the model platform: compile, distil, train, quantize, serve, and registry. The spine is Ed25519 signatures with SHA-256 Merkle transparency (RFC 6962 and 9162), offline browser, Python, and Go verifiers, and a canonical signed envelope. No blockchain is in the trust path and none is proposed.

The stack is mature and shippable. The work ahead is hardening the trust path and unifying the evidence format, not rebuilding.

## The single biggest leverage truth

For a company whose entire promise is verifiable evidence, integrity bugs in the trust path are existential. Three are confirmed in the live tree and are surgical to fix.

1. src/sigstore.js lines 467 and 468 wrap both the computed root and the claimed root in Buffer.alloc(32, 0).fill(value.slice(0, 32)) before comparing. This truncates and zero-pads, producing a false-accepting Merkle inclusion check that is live on the report path via binder.js. An attacker who controls a prefix could forge a passing report. The fix is to delegate to src/merkle.js verifyInclusion, which already compares full-length roots correctly.

2. src/keys.js lines 208 and 239 emit a field named honest_scope. This violates the hard constraint against the forbidden word and it leaks to customers through cli/kolm.js keys rotate --json. Rename the field to scope_note. The verbatim contractual scope sentence elsewhere is untouched.

3. src/store-backup.js runs VACUUM INTO with no PRAGMA integrity_check, so a corrupt snapshot of the signing database can silently become the disaster-recovery source. Add an integrity check and fail the backup if it does not return ok.

## Highest-value invention

Converge every artifact onto one signed, Merkle-anchored receipt format verified by a single offline tool. Scan, report, distilled checkpoint, quantized weights, training run, registry entry, and backup would all carry the same envelope and anchor in the existing transparency log. This turns per-component crypto into a category-defining product spine: every Surface B output ships with Surface A evidence, and anyone can verify any kolm artifact with no kolm service in the path.

## Ship-now wins

- Fix the false-accepting root compare in src/sigstore.js by routing through src/merkle.js verifyInclusion.
- Rename honest_scope to scope_note in src/keys.js.
- Add PRAGMA integrity_check to src/store-backup.js before a snapshot is reported ok.
- Thread amount_cents and currency through scheduleDunning in src/dunning.js and the call site in src/router.js line 13455 so dunning emails stop showing a null amount.
- Replace any inline root comparison in the binder and report path with the single audited merkle.verifyInclusion.

## Rejected during verification

Several proposals were dropped as false premises after reading the code. The dunning sweep and resignPendingReports are already wired in-process in server.js (lines 521 and 528), so the orphaned-sweep proposals are not real. Runtime placement claims are correctly not over-asserted, so the placement-enforcement proposal was rejected. HTTP verify parity already exists. These are excluded from the backlog.

## Constraints honored

No blockchain. Ed25519 and SHA-256 Merkle only. Dark site backdrop untouched; only inline graphics may improve. No new fonts or CDNs. Pricing is flag-only and unchanged. The verbatim scope sentence and dev@kolm.ai as the only contact are preserved. The honest_scope rename is itself a constraint fix. ASCII-safe punctuation throughout. No git push.