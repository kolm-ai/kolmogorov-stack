# Angle Health x kolm.ai — 15-minute live demo script

Audience: Angle CTO + Head of Engineering + (optional) compliance officer.
Format: live walkthrough; share screen; one operator (you), one Angle technical contact in the room.
Outcome: Angle has seen, end to end, that PHI never leaves their VPC and that every model decision produces a signed receipt their auditor can verify offline.

Prereqs (verify the night before):
- Sandbox AWS account with kolm BYOC bundle deployed (gateway, redactor, S3 lake, KMS key, GPU runner, Postgres receipt store). See `hipaa-onepager.html` section 1.
- 50 synthetic member-prior-auth tickets pre-loaded in `s3://angle-kolm-sandbox/seed/`.
- `kolm` CLI v0.41+ on the demo laptop, logged into the sandbox tenant.
- Hand-out: printed `hipaa-onepager.html` and `architecture.svg`.

Per-segment timings below are in `mm:ss`. The clock starts when you screen-share.

---

## 00:00 — 01:00  | Open the room (1 min)

Say:
> "Fifteen minutes. Three things. First, watch a member request hit the kolm gateway and produce a signed receipt. Second, watch a distill turn yesterday's captured tickets into a 1.9 GB specialist model and refuse to ship it until the K-score clears the floor. Third, hand the artifact to a verifier on an air-gapped laptop and prove the chain. PHI never leaves your VPC at any step. Ready?"

Open three terminals:
1. Operator console for the gateway (left).
2. Compile runner (middle).
3. Verifier on the air-gap laptop (right; or VM with no internet).

---

## 01:00 — 04:00  | Segment 1 — Route a member request and get a signed receipt (3 min)

Terminal 1, talk while you type:

```bash
kolm doctor --tenant angle-sandbox
```

Expected: `blockers: 0` and `data_plane: angle_aws_acct_xxxx`. Read aloud:
> "Doctor says zero blockers, data plane in Angle. The kolm control plane never sees PHI."

Send one synthetic prior-auth ticket through the gateway:

```bash
kolm capture send --tenant angle-sandbox --file seed/ticket-0042.json
```

Expected: a request id, a redaction summary (`identifiers stripped: 6`), and a per-call receipt id.

Pull the receipt:

```bash
kolm receipt show --rid r_01J3...
```

Expected JSON includes:
```
{
  "artifact_cid": "bafkreieq...4f7c",
  "input_hash": "sha256:c4f1...8a21",
  "output_hash": "sha256:9b02...11de",
  "k_axes": { "faithfulness": 0.92, "coverage": 0.88, "calibration": 0.86, "groundedness": 0.94, "cost": 0.86 },
  "signed_at": "2026-05-28T19:14:02Z",
  "signature": "ed25519:9c4f...e801"
}
```

Read aloud:
> "Every member call gets a receipt. The input is hashed in canonical form, the output is hashed in canonical form, the K-axes are recorded, the whole thing is signed with the Ed25519 key you control in your KMS. Notice the receipt did not include any cleartext PHI; it cannot, because the redactor ran first."

---

## 04:00 — 09:00  | Segment 2 — Compile a specialist from yesterday's captures (5 min)

Switch to terminal 2 (compile runner).

```bash
kolm capture status --tenant angle-sandbox --since 24h
```

Expected: `pairs: 2,400 · cleared: 2,376 · dropped (pii flag): 24`. Read aloud:
> "Twenty-four pairs were dropped because the redactor was not certain they were clean. We drop on uncertainty. The compile only sees the cleared pool."

Start the compile:

```bash
kolm compile spec.yaml \
  --teacher claude-opus-4-7 \
  --student qwen2.5-7b-instruct \
  --quantize nf4-double \
  --gate 0.85
```

You will see (allow about 90 seconds for these to scroll):
- 3 distill passes with K-scores: `0.71 -> 0.84 -> 0.91`
- Quantize step: `14.2 GB -> 1.9 GB in 29.2s`
- Sign step: `Ed25519 ok`
- Final line: `K-Score 0.91 >= 0.85 · ship`

Read aloud during the climb:
> "Three passes. Each pass widens the spec the student tries to match. The K-score has to clear 0.85 or the build does not ship; we abort before signing if the gate fails. Notice it is 0.85, not 0.85 'on average over the test set'. It is 0.85 on the held-out eval pack that the receipt names."

Show the artifact size and verify locally:

```bash
ls -lh ~/.kolm/artifacts/angle-prior-auth.kolm
kolm verify ~/.kolm/artifacts/angle-prior-auth.kolm
```

Expected: `1.9G` and `verify: ok (cid, sig, k-score)`.

---

## 09:00 — 11:30  | Segment 3 — Hand the artifact to the air-gap verifier (2.5 min)

Copy the .kolm to a USB stick (or simulate via a `scp` to the disconnected VM). Walk to the air-gap laptop / switch to terminal 3.

Confirm no network:
```bash
curl -s --max-time 2 https://kolm.ai/health || echo "offline"
```
Expected: `offline`.

Run the verifier:
```bash
kolm verify ./angle-prior-auth.kolm
```

Expected output:
```
artifact_cid    ok (bafkrei...4f7c)
artifact_bytes  sha256 match
receipt body    JCS-canonical
signature       Ed25519 ok (pub fp ed25519:2dba...77c4)
k_score         0.91 (axes embedded; threshold 0.85)
verify: ok
```

Read aloud:
> "Offline laptop. No call to kolm.ai. No call to any registry. The verifier recomputes the artifact hash, re-canonicalizes the receipt, re-checks the signature against the public key embedded in the artifact. Two years from now, your auditor opens this file and runs the same command. Same answer."

---

## 11:30 — 13:30  | Segment 4 — Show the receipt store and an auditor query (2 min)

Back to terminal 1. Show the Postgres receipt table:

```bash
kolm receipt query --tenant angle-sandbox \
  --since "2026-05-28T00:00:00Z" \
  --limit 5
```

Expected: five recent receipts, each one row, all with `artifact_cid`, `input_hash`, `output_hash`, `k_axes`, `signature`.

Then run one auditor-shaped query:

```bash
kolm receipt query --tenant angle-sandbox \
  --where "k_axes.faithfulness < 0.80" --limit 10
```

Read aloud:
> "Anything under-policy is findable by the same query. The audit log is not a separate system. It is the receipt store; it is the model behavior."

---

## 13:30 — 14:30  | Segment 5 — Failure mode: what happens on a key rotation (1 min)

In terminal 2, simulate a key rotation:

```bash
kolm key rotate --tenant angle-sandbox
```

Verifier on the air-gap laptop is then re-run against the old artifact:

```bash
kolm verify ./angle-prior-auth.kolm
```

Expected: `signature: FAIL (public key fingerprint mismatch)`.

Read aloud:
> "Rotation invalidates the old artifact. We do not silently accept old signatures; the verifier sees the public key has moved and refuses. Re-sign the artifact under the new key, or re-compile; both leave a receipt."

Reset the demo state (silently):
```bash
kolm key restore --tenant angle-sandbox --snapshot pre-demo
```

---

## 14:30 — 15:00  | Close (30 sec)

Say:
> "Three things you saw. A member request that produced a signed receipt without PHI leaving your VPC. A compile that refused to ship below the K-score floor. A verifier that worked on a laptop with no network. Two questions: what is the first specialist you would want us to ship inside Angle, and who is the right BAA signatory on your side?"

Hand them the printed one-pager. Schedule the follow-up.

---

## Backup demos (if a segment hangs)

- **If the live compile hangs.** Switch to a pre-compiled `.kolm` in `~/.kolm/artifacts/demo-cache/` and continue with the verifier segment.
- **If the gateway is cold and the first request 502s.** Re-run `kolm wrapper status`; if it is healthy and the call still 502s, fall back to a recorded receipt from the cache and explain what would have happened.
- **If the air-gap laptop is dead.** Show the verifier on the same machine after disabling the network adapter; same outcome.

## Post-demo follow-up checklist

- Send the one-pager PDF (export from `hipaa-onepager.html` via Cmd+P > Save as PDF).
- Send the ROI calculator URL (`roi-calculator.html`) with the Angle defaults pre-loaded.
- Send the BAA template within 24 hours.
- Calendar a 30-minute architecture review with Angle security; bring the SVG.
- If they ask for SOC 2: point at `/soc2`; we are Type II in flight, Type I shipped.
