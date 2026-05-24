# Air-gapped / classified deployment guide

STATUS: ACTIVE, 2026-05-24

This guide walks an operator through deploying kolm in an environment with no internet access. The pattern applies equally to defense-classified enclaves, regulated healthcare zones, and any other deployment where outbound network traffic is prohibited by policy.

The kolm compiler and runtimes are designed for this pattern by default. Every component runs without network access; the only data exchange is via sneakernet (sealed media moved by a human between physically separated networks).

## 1. Threat model assumptions

The guide assumes:

- No internet access. The deployment network has no route to the public internet. Outbound DNS, HTTP, HTTPS, and any other internet egress is blocked at the boundary.
- No DNS resolution to public IPs. The local resolver, if present, MUST NOT return public IP addresses for any query. The compiler and runtimes are configured to treat any non-loopback non-RFC1918 address as an error.
- Full audit trail required. Every action the operator takes MUST be reconstructible from the local event log. The audit trail is the durable record an inspector can review months or years after the fact.

Under these assumptions, the threats kolm defends against are: silent egress of captures or weights via misconfigured proxy; replay of stale artifacts after a key rotation; tampering with the audit trail by a malicious or coerced operator.

The threats kolm does NOT defend against (out of scope, handled by the enclave): physical exfiltration of disk media; coerced operators with full root; supply-chain attack on the kolm binaries themselves (covered by the signed-release pipeline in the public network, not by the deployment).

## 2. Network verification

Before any compile or distill step, the operator MUST verify that the network shape matches the threat model. Run:

```
kolm doctor airgap
```

The expected output:

```
no_internet_egress       PASS
loopback_only_hosts      PASS
dns_no_public            PASS
teacher_endpoint_local   PASS  (127.0.0.1:8000)
data_dir_local           PASS  (/var/lib/kolm)
```

Any FAIL row aborts the deployment. The doctor command exits non-zero on any FAIL; wire it into your boot-time validation if you want the enclave to refuse to come up with the wrong network shape.

## 3. Local teacher requirement

Kolm distill needs a teacher model. In the air-gapped pattern, the teacher MUST be a local inference server bound to a loopback address. Two supported runtimes:

- Ollama bound to 127.0.0.1:11434. Configure with `OLLAMA_HOST=127.0.0.1:11434` and start under systemd with a bind override.
- vLLM bound to 127.0.0.1:8000. Start with `python -m vllm.entrypoints.openai.api_server --host 127.0.0.1 --port 8000 --model <local-model-path>`.

The teacher MUST NOT be reachable from any non-loopback address. The doctor command validates this by attempting to connect from the deployment network gateway; the connection MUST fail.

Set `KOLM_TEACHER_ENDPOINT=http://127.0.0.1:8000/v1` (or the Ollama equivalent) and `KOLM_TEACHER_PROVIDER=local`. The compiler refuses to use any teacher endpoint that resolves to a non-loopback non-RFC1918 address.

## 4. Capture pipeline

Captures are the raw prompts and responses the deployment logs for downstream distillation. In the air-gapped pattern, all captures land in `~/.kolm/captures/` (or wherever `KOLM_DATA_DIR` points) only. There is no proxy egress; no remote capture sink is configured.

The capture writer is fail-loud. If the data directory is unwritable, the capture path returns an error envelope (`{"ok":false,"error":"capture_dir_unwritable"}`) rather than silently dropping the capture or falling back to a remote sink. This is the honesty contract: a missing capture MUST surface as a visible error so the operator can fix the disk before more traffic flows.

Per-namespace retention is set with `kolm namespace set-retention <ns> --days N`. The local rotator runs nightly and removes captures older than the retention window. Receipts that reference removed captures remain verifiable because receipts embed only sha256 hashes, not the raw text.

## 5. Sneakernet transfer protocol

To move artifacts, calibration packs, or audit exports between the air-gapped network and another zone, kolm uses USTAR tar archives with HMAC-SHA256 authentication. The protocol:

- The sender packs the payload into a tar archive (USTAR format for maximum portability).
- The sender computes HMAC-SHA256 over the canonical tar stream using a pre-shared key.
- The HMAC is written into a sidecar file inside the tar (`.kolm-sneakernet-hmac`).
- The receiver verifies the HMAC against the same pre-shared key before extracting any entry.

The HMAC key is exchanged out-of-band (typically printed and hand-carried during initial enclave setup). Compromise of the HMAC key requires a key rotation and a fresh exchange.

Verification is fail-closed: if the HMAC does not match, the receiver MUST NOT extract any entry. The receiver SHOULD log the failure to the local audit trail and surface it to the operator.

## 6. Verification command examples

Pack on the sender:

```
kolm sneakernet pack --out artifact.tar --hmac-key /etc/kolm/sneakernet.key /var/lib/kolm/artifacts/myartifact.kolm
```

The command writes `artifact.tar` containing the .kolm payload and the HMAC sidecar. The hmac-key file is the pre-shared key (32 bytes minimum, hex or base64).

Verify on the receiver:

```
kolm sneakernet verify --in artifact.tar --hmac-key /etc/kolm/sneakernet.key
```

The command exits 0 on a verified archive and prints the per-entry size and sha256. It exits non-zero on HMAC mismatch and prints the failure detail without extracting any entry.

Extract on the receiver (only after a successful verify):

```
kolm sneakernet extract --in artifact.tar --hmac-key /etc/kolm/sneakernet.key --to /var/lib/kolm/incoming/
```

The extract step re-verifies the HMAC before writing any file; the verify command above is a dry run, and the extract is the authoritative gate.

## 7. Audit trail

The audit trail is an append-only JSONL event log at `~/.kolm/audit.log`. Every operator action (login, capture write, distill run, compile run, key rotation, sneakernet pack, sneakernet verify, sneakernet extract) writes one row.

Each row includes a `prev_hash` field that is the sha256 of the previous row. This creates a tamper-evident hash chain: editing any row invalidates every subsequent row's prev_hash. The chain head is published at `~/.kolm/audit-head.json` and SHOULD be backed up to a separate medium nightly.

To verify the chain:

```
kolm audit verify ~/.kolm/audit.log
```

The command walks the chain from the first row, recomputes each prev_hash, and exits non-zero on any mismatch. It prints the row number of the first invalid row so the operator can investigate.

The audit log is the durable record an inspector reviews. Configure your enclave's backup process to capture the audit log and the chain head together.

## 8. Decommission

When an enclave is decommissioned, the operator MUST rotate keys and destroy receipts. The full sequence:

- Rotate the local signing key: `kolm keys rotate --reason decommission`. The rotation writes a final receipt linking the old fingerprint to the rotation event.
- Rotate the sneakernet HMAC key: generate a new key on a clean medium and arrange out-of-band exchange with any peer enclaves that hold the old key. The old key MUST be destroyed (overwritten and the medium physically destroyed if classified policy requires).
- Export the final audit log via sneakernet to the compliance archive: `kolm sneakernet pack --out final-audit.tar --hmac-key /etc/kolm/sneakernet.key ~/.kolm/audit.log`.
- Destroy receipts: `kolm receipts destroy --confirm-irreversible --all`. The command overwrites the receipt store with zeros and then unlinks it. The destruction event is the last row in the audit log.
- Physically destroy storage media per classified policy.

The destruction certificate (final audit log + a hash of the destruction event row) is the artifact the compliance team retains. The destroyed receipts are not recoverable; this is intentional.
