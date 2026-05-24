# Classified / air-gapped deployment guide

STATUS: ACTIVE, last revised 2026-05-24 under wave W831.

This guide walks an operator through deploying kolm in an environment with zero internet access. The pattern applies equally to defense-classified enclaves, regulated healthcare zones, and any other deployment where outbound network traffic is prohibited by policy. Every component of kolm has been designed to run without network access; the only data exchange is via sneakernet (sealed media moved by a human between physically separated networks).

## 1. Threat model

The guide assumes:

- No internet access. The deployment network has no route to the public internet. Outbound DNS, HTTP, HTTPS, and any other internet egress is blocked at the boundary.
- No DNS resolution to public IPs. The local resolver, if present, MUST NOT return public IP addresses for any query. The compiler and runtimes treat any non-loopback non-RFC1918 address as an error.
- Full audit trail required. Every action the operator takes MUST be reconstructible from the local event log. The audit trail is the durable record an inspector can review months or years after the fact.

Under these assumptions, kolm defends against silent egress of captures or weights via misconfigured proxy, replay of stale artifacts after a key rotation, and tampering with the audit trail by a malicious or coerced operator. The threats kolm does NOT defend against (out of scope, handled by the enclave) are: physical exfiltration of disk media, coerced operators with full root, and supply-chain attack on the kolm binaries themselves (covered by the signed-release pipeline in the public network, not by this deployment).

## 2. Hardware requirements

Two hardware-isolation patterns are supported. Either one is sufficient on its own; deployments that combine both are stronger but not required.

- No NIC. The deployment host is physically de-NIC'd. The motherboard's onboard NIC is jumper-disabled or physically removed; no PCIe network card is present; no USB-Ethernet adapter is permitted in the enclosure. This is the canonical "air gap" — there is no electrical path between the host and the outside world.
- Firewall-blocked. The deployment host has a NIC for LAN management, but a host-local firewall (Windows Defender Firewall or `iptables -P OUTPUT DROP`) and an upstream perimeter firewall both deny all egress except to explicitly whitelisted loopback / RFC1918 hosts. This is the more common pattern in real-world classified deployments and matches the assumption embedded in `src/airgap-distill.js`'s dial-failure guard.

Storage MUST be local (no SAN, no NFS over the LAN to a remote share). GPU is optional but recommended for distillation runs over 1B parameters; the bundled `apps/runtime/backends/local_cpu.py`, `local_cuda.py`, `local_mlx.py`, `local_mps.py`, `local_rocm.py` cover CPU and every major accelerator.

## 3. Provisioning workflow

The provisioning workflow is sneakernet-only. There is no `pip install`, no `npm install`, no `git clone` from the deployment host — every byte that lands on the air-gapped host arrives on physical media that was first verified on a trusted clean-network host.

Provisioning steps:

- On a trusted clean host outside the enclave: assemble the kolm bundle (`kolm bundle --offline --out kolm-airgap-bundle.tar`). The bundle contains the kolm binaries, the node_modules tree, the worker scripts, the local-runtime Python packages, and any teacher snapshots the operator needs.
- Sign the bundle on the clean host using the operator's Ed25519 signing key. The bundle and signature together are written to a freshly-formatted USB drive (FAT32 or exFAT for portability).
- Walk the USB drive into the enclave. On the air-gapped host, run `kolm sneakernet verify --bundle /media/usb/kolm-airgap-bundle.tar --pubkey /etc/kolm/trusted-pubkey.pem`. The verifier exits non-zero on any signature or recipient mismatch; refuse to install if it does.
- Extract on the air-gapped host. Run `kolm sneakernet extract --bundle /media/usb/kolm-airgap-bundle.tar --pubkey /etc/kolm/trusted-pubkey.pem --to /opt/kolm`. The extract command re-verifies before writing any byte; the `verify` step above is a dry-run check.
- Validate the network shape. Run `kolm doctor airgap`. All rows MUST pass. Any FAIL row aborts the provisioning. The doctor command exits non-zero on any FAIL; wire it into your boot-time validation if you want the enclave to refuse to come up with the wrong network shape.

Before the first distill run, verify the local teacher endpoint is loopback-only (`kolm airgap teacher-doctor`); refuse to distill if the teacher URL resolves to anything other than 127.0.0.1 / localhost / ::1 / unix socket.

## 4. Key rotation

Kolm uses two separate key chains in the air-gapped pattern:

- The signing key (Ed25519) that signs sneakernet bundles. Rotate this annually or immediately on suspected compromise. Run `kolm keys rotate --kind signing --reason scheduled-annual-2026`. The old key's fingerprint MUST be retained in `/etc/kolm/key-history.json` so old bundles remain verifiable for audit.
- The receipt secret (`RECIPE_RECEIPT_SECRET`) that HMACs in-host receipts. Rotate this quarterly. The rotation is a single config change followed by `kolm receipts reseal` to re-sign existing receipts with the new secret.

Both rotations write an event to the audit chain (section 5) so an inspector can reconstruct the rotation schedule. The new key MUST be sneakernet-transferred from the clean network host; do NOT generate the production signing key on the air-gapped host (you cannot publish the matching public key to peer enclaves without a clean-network bootstrap).

## 5. Audit chain

The audit trail is an append-only JSONL event log at `~/.kolm/audit.log`. Every operator action (login, capture write, distill run, compile run, key rotation, sneakernet pack, sneakernet verify, sneakernet extract) writes one row.

Each row includes a `prev_hash` field that is the sha256 of the previous row. This creates a tamper-evident hash chain: editing any row invalidates every subsequent row's `prev_hash`. The chain head is published at `~/.kolm/audit-head.json` and SHOULD be backed up to a separate medium nightly.

To verify the chain:

```
kolm audit verify ~/.kolm/audit.log
```

The command walks the chain from the first row, recomputes each `prev_hash`, and exits non-zero on any mismatch. It prints the row number of the first invalid row so the operator can investigate.

Configure your enclave's backup process to capture the audit log and the chain head together. The audit log is the durable record an inspector reviews.

## 6. Decommissioning

When an enclave is decommissioned, the operator MUST rotate keys, destroy receipts, and physically destroy the storage media per classified policy. The full sequence:

- Rotate the local signing key: `kolm keys rotate --reason decommission`. The rotation writes a final receipt linking the old fingerprint to the rotation event.
- Rotate the sneakernet HMAC key: generate a new key on a clean medium and arrange out-of-band exchange with any peer enclaves that hold the old key. The old key MUST be destroyed (overwritten and the medium physically destroyed if classified policy requires).
- Export the final audit log via sneakernet to the compliance archive: `kolm sneakernet pack --out final-audit.tar --signing-key /etc/kolm/signing.pem ~/.kolm/audit.log`.
- Destroy receipts: `kolm receipts destroy --confirm-irreversible --all`. The command overwrites the receipt store with zeros and then unlinks it. The destruction event is the last row in the audit log.
- Physically destroy storage media per classified policy.

The destruction certificate (final audit log + a hash of the destruction event row) is the artifact the compliance team retains. The destroyed receipts are not recoverable; this is intentional.

## Appendix A. Capture and teacher pipeline

Captures land in `~/.kolm/captures/` (or wherever `KOLM_DATA_DIR` points). There is no remote capture sink. The capture writer is fail-loud — if the data directory is unwritable, the capture path returns `{"ok":false,"error":"capture_dir_unwritable"}` rather than silently dropping the capture or falling back to a remote sink.

Distill needs a teacher model. In the air-gapped pattern the teacher MUST be a local inference server bound to a loopback address:

- Ollama bound to 127.0.0.1:11434. Configure with `OLLAMA_HOST=127.0.0.1:11434`.
- vLLM bound to 127.0.0.1:8000. Start with `python -m vllm.entrypoints.openai.api_server --host 127.0.0.1 --port 8000 --model <local-model-path>`.
- llama.cpp bound to a unix socket: `unix:/var/run/llama.sock`.

Set `KOLM_TEACHER_ENDPOINT=http://127.0.0.1:8000/v1` and `KOLM_TEACHER_PROVIDER=local`. The compiler refuses any teacher endpoint that resolves to a non-loopback non-RFC1918 address (see `src/airgap-teacher.js`).

## Appendix B. W831 command reference

The W831 wave wires three new code paths an operator uses daily:

```
# Offline distillation. The first call enforces no KOLM_TEACHER_API_KEY,
# absolute-local paths, and a 50ms dial-failure probe to https://example.com.
kolm airgap distill run \
  --user-data /var/lib/kolm/data/train.jsonl \
  --teacher /var/lib/kolm/teachers/llama-3-70b-instruct \
  --student /var/lib/kolm/students/qwen-3b \
  --out /var/lib/kolm/artifacts/distilled-2026Q2.kolm

# Pack a .kolm into a sneakernet bundle with an Ed25519 detached signature.
kolm sneakernet pack \
  --artifact /var/lib/kolm/artifacts/distilled-2026Q2.kolm \
  --signing-key /etc/kolm/signing.pem \
  --out /media/usb/distilled-2026Q2.bundle.tar

# Verify on the receiver. Refuses to extract if signature_ok or recipient_ok
# is false.
kolm sneakernet verify \
  --bundle /media/usb/distilled-2026Q2.bundle.tar \
  --pubkey /etc/kolm/trusted-pubkey.pem \
  --extract-to /opt/kolm/incoming/

# Air-gapped bakeoff across multiple artifacts; aborts before any artifact
# invocation if network egress is detected.
kolm airgap bakeoff \
  --dataset /var/lib/kolm/holdouts/eval.jsonl \
  --artifact /opt/kolm/artifacts/v1.kolm \
  --artifact /opt/kolm/artifacts/v2.kolm
```

The full envelope shapes are documented in `src/airgap-distill.js`, `src/airgap-teacher.js`, `src/airgap-sneakernet.js`, and `src/airgap-bakeoff.js`. Every envelope carries `version` matching `/^w831-/` so an automated audit can confirm the wave.
