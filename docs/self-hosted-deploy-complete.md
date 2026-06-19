# kolm self-hosted deployment — complete guide

Persona D (Enterprise / regulated). Self-host kolm on your own infrastructure
with **no telemetry, no cloud round-trip, no dependency on kolm.ai**. This
guide covers every environment variable, every secret, every cert, and every
verification step needed to land a production deployment.

The same binary that runs at kolm.ai runs here — there's no separate
self-hosted SKU, no feature gating. Open-source MIT licensed.

---

## 1. System requirements

### Single-node (small team, <100 RPS)

| Resource | Minimum | Recommended |
|---|---|---|
| OS | Linux x86_64 / arm64, macOS, Windows | Ubuntu 22.04 LTS or RHEL 9 |
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GiB | 8 GiB |
| Disk | 20 GiB SSD | 100 GiB NVMe |
| Node.js | 20.x LTS | 22.x LTS |
| Python | 3.10+ (for ML/proof workers: distill, quantize, import/export, runtime adapters) | 3.12 |
| GPU | optional | NVIDIA L4 / A10G / RTX 4090 for local compile |
| Network | egress to HF Hub for base-model downloads (or use air-gap mode) | + ingress 443 for users |

### Multi-node (HA, ≥1k RPS)

- Web tier: 2+ Node.js processes behind a load balancer (Nginx / HAProxy / Cloud LB).
- API tier: same binary, separated for autoscaling. Stateless once `KOLM_DATA_DIR` points at shared storage.
- Storage: PostgreSQL 15+ OR shared filesystem (NFS / EFS / FSx) — see §5.
- Object storage: S3-compatible bucket for artifacts (≥100 GiB initial).
- GPU pool: dedicated nodes for `kolm compile` jobs (auto-rented from Modal/RunPod via §10 if you don't want bare-metal GPUs).

---

## 2. Install

### Option A — npm (recommended)

```bash
npm install -g kolm@latest
kolm --version
kolm doctor          # probes Node, Python, GPU, signing keys
```

### Option B — git clone (air-gap or custom build)

```bash
git clone https://github.com/kolm-ai/kolm.git
cd kolmogorov-stack
npm install --omit=dev
node cli/kolm.js --version
# add cli/kolm.js to PATH or alias
```

### Option C — Docker

```bash
docker pull ghcr.io/kolm-ai/kolm:latest
docker run --rm -p 8080:8080 \
  -e KOLM_DATA_DIR=/var/kolm \
  -v kolm-data:/var/kolm \
  ghcr.io/kolm-ai/kolm:latest
```

### Option D — Helm chart (Kubernetes)

```bash
kolm serve --helm --out ./kolm-chart
helm install kolm ./kolm-chart \
  --namespace kolm --create-namespace \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=kolm.internal.corp
```

The chart is rendered by `kolm serve --helm` so it always matches the binary
in use. See `docs/Run/helm.md` for the full values reference.

---

## 3. The environment matrix

Every env var read by the kolm binary, grouped by purpose. **`*` = required for that capability; everything else is optional with a sensible default.**

### 3.1 Core paths + identity

| Var | Default | Purpose |
|---|---|---|
| `KOLM_HOME` | `$HOME/.kolm` | Per-user config + cache root. Holds `config.json` (artifact signing secret), local artifacts, hub mirror. |
| `KOLM_DATA_DIR`* | `$KOLM_HOME/data` (single-node) | Server-side tenant data root. Event store, captures, jobs, audit log. Point at shared FS for HA. |
| `KOLM_ARTIFACT_DIR` | `$KOLM_HOME/artifacts` | Compiled `.kolm` artifact directory. Point at S3-mounted FS or object store via `KOLM_STORE_DRIVER`. |
| `KOLM_MODELS_DIR` | `$KOLM_HOME/models` | Base model weights cache (HF format). Multi-GiB; pre-populate in air-gap. |
| `KOLM_MEDIA_DIR` | `$KOLM_DATA_DIR/media` | User-uploaded multimodal blobs (images, audio, video). |
| `KOLM_JOBS_DIR` | `$KOLM_DATA_DIR/jobs` | Long-running job state + logs. |
| `KOLM_PLUGINS_DIR` | `$KOLM_HOME/plugins` | Discovered plugin packages. |
| `KOLM_TENANT_ID` | — | (Optional) Pin the default tenant id for single-tenant deploys. Otherwise derived from API key. |

### 3.2 Auth + signing (security-critical)

| Var | Required? | Purpose |
|---|---|---|
| `KOLM_ARTIFACT_SECRET` | yes | HMAC secret for the receipt chain (32+ random bytes). Same value must be on every node that signs / verifies. Rotate via §11.4. |
| `RECIPE_RECEIPT_SECRET` | — | Alias for `KOLM_ARTIFACT_SECRET`. |
| `KOLM_SIGNING_KEY` | recommended | Path to a PEM file holding the deploy's ed25519 private key (sigstore ring 04). Generate with `kolm sigstore generate-key`. |
| `KOLM_ED` | recommended | Inline ed25519 keypair (base64). Set when you can't ship a file (e.g. systemd `Environment=` lines). |
| `KOLM_REQUIRE_ED` | no (default `false`) | Refuse to verify any artifact without an ed25519 sig. Set `true` in regulated environments. |
| `KOLM_REQUIRE_REKOR` | no (default `false`) | Refuse to verify any artifact without a Rekor transparency log entry. Set `true` for supply-chain attestation. |
| `KOLM_REKOR_REQUIRE` | no | Alias for `KOLM_REQUIRE_REKOR`. |
| `KOLM_AUDITOR_ED` | — | Independent auditor's public ed25519 key. When set, artifacts require co-signing by this auditor to pass verify. |
| `KOLM_SETUP_SECRET` | — | Secret seed for one-time email signup tokens (when you self-host signup). |
| `KOLM_SETUP_TOKEN_TTL_SEC` | `1800` | TTL for signup tokens. |

**Generate the signing trio in one shot:**

```bash
kolm sigstore generate-key --out /etc/kolm/signing.pem
echo "KOLM_ARTIFACT_SECRET=$(openssl rand -hex 32)" >> /etc/kolm/.env
echo "KOLM_SIGNING_KEY=/etc/kolm/signing.pem" >> /etc/kolm/.env
chmod 600 /etc/kolm/signing.pem /etc/kolm/.env
```

### 3.3 Storage drivers

| Var | Values | Default | Purpose |
|---|---|---|---|
| `KOLM_STORE_DRIVER` | `fs` / `sqlite` / `pg` | `fs` (single-node) | Tenant data backing store. `pg` for HA. |
| `KOLM_CAPTURE_DRIVER` | `fs` / `sqlite` | `fs` | Capture event store. |
| `KOLM_EVENT_STORE_DRIVER` | `jsonl` / `sqlite` / `pg` | `jsonl` | Append-only event log. `sqlite` for >10k events/day. |
| `KOLM_EVENT_STORE_PATH` | — | `$KOLM_DATA_DIR/events.jsonl` | Override path for the JSONL driver. |
| `KOLM_DB_PATH` | — | `$KOLM_DATA_DIR/kolm.sqlite` | Path for the SQLite driver. |
| `KOLM_ALLOW_JSON_STORE` | `true` / `false` | `true` | Fail-closed switch — set `false` in prod to require the SQLite/PG driver. |
| `DATABASE_URL` | postgres URL | — | When `KOLM_STORE_DRIVER=pg`. |

### 3.4 Teacher / LLM providers (for `kolm compile`)

`kolm compile` distills from a teacher LLM. Configure **at least one** of:

| Var | Provider | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude | Default teacher when `KOLM_DISTILL_TEACHER=anthropic`. |
| `ANTHROPIC_MODEL` | Claude | Default `claude-opus-4-7`. |
| `KOLM_ANTHROPIC_API_KEY` | Claude | Alias. |
| `OPENAI_API_KEY` | GPT | Default teacher when `KOLM_DISTILL_TEACHER=openai`. |
| `OPENAI_BASE_URL` | OpenAI-compatible | Point at any OpenAI-compatible endpoint (Together, Groq, vLLM). |
| `KOLM_DISTILL_TEACHER` | `anthropic` / `openai` / `local` / `council` | Selects teacher. `council` calls all configured providers for ensemble distill. |
| `KOLM_TEACHER_COUNCIL` | comma-separated providers | When teacher is `council`. e.g. `anthropic,openai,deepseek`. |
| `KOLM_TEACHER_SOURCE` | string | Free-form provenance tag stamped into the artifact's distill receipt. |
| `KOLM_DISTILL_FULL` | `1` | Opt-in to full-weight retraining (vs LoRA adapter). |
| `KOLM_DISTILL_WORKER_CMD` | command | Override the local distill worker binary (advanced). |
| `KOLM_DISTILL_TMP_DIR` | path | Scratch dir for distill (default $TMPDIR/kolm-distill). |

### 3.5 GPU partners (optional cloud compile)

When the local machine doesn't have enough VRAM (`kolm fit` says no), the
binary can rent GPU time from one of these partners via `kolm compile --cloud
<partner>`:

| Var | Partner | Required for `--cloud <partner>` |
|---|---|---|
| `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` | Modal | `--cloud modal` |
| `KOLM_MODAL_TOKEN` | Modal | Alias |
| `KOLM_MODAL_REGION` | Modal | Default `us-east` |
| `RUNPOD_API_KEY` | RunPod | `--cloud runpod` |
| `KOLM_RUNPOD_TOKEN` | RunPod | Alias |
| `KOLM_RUNPOD_ENDPOINT_ID` | RunPod | Required when using RunPod serverless. |
| `KOLM_VAST_TOKEN` | Vast.ai | `--cloud vast` |
| `KOLM_VAST_SSH_KEY` | Vast.ai | Path to ssh key for the rented box. |
| `KOLM_LAMBDA_TOKEN` | Lambda Labs | `--cloud lambda` |
| `TOGETHER_API_KEY` | Together | `--cloud together` (managed fine-tune) |
| `KOLM_TOGETHER_TOKEN` | Together | Alias |
| `KOLM_REPLICATE_TOKEN` | Replicate | `--cloud replicate` |
| `KOLM_FAL_TOKEN` | fal.ai | `--cloud fal` |
| `KOLM_REMOTE_HOST` + `KOLM_REMOTE_SSH_KEY` | bring-your-own SSH box | `--cloud ssh` |

Enterprise-grade deploys typically pin one GPU partner with a private rate
agreement and disable the others by leaving their env vars unset.

### 3.6 Air-gap mode

| Var | Values | Purpose |
|---|---|---|
| `KOLM_AIRGAP` | `1` | Refuse all outbound HTTPS. Fail loudly if any code path attempts egress. |
| `KOLM_LOCAL_TEACHER_URL` | URL | OpenAI-compatible URL of your local vLLM / Ollama / TGI teacher. |
| `KOLM_LOCAL_TEACHER_MODEL` | string | Model name on the local teacher. |
| `HF_DATASETS_OFFLINE` | `1` | Auto-set when `KOLM_AIRGAP=1`. |
| `HF_HUB_OFFLINE` | `1` | Auto-set when `KOLM_AIRGAP=1`. |
| `KOLM_AIRGAP_SIGNING_KEY` | path | Override signing key path in air-gap (often the deploy's HSM-backed key). |

Pre-populate `$KOLM_MODELS_DIR` before going dark — see §10.

### 3.7 Serving

| Var | Default | Purpose |
|---|---|---|
| `KOLM_GATEWAY_MODE` | `live` | `live` / `mock` / `shadow`. `mock` returns canned responses; `shadow` mirrors traffic to a backup without serving from it. |
| `KOLM_OLLAMA_URL` | `http://localhost:11434` | Local Ollama for gateway mode. |
| `KOLM_VLLM_URL` | — | Local vLLM endpoint. |
| `KOLM_DEVICE` | auto | `cuda:0` / `mps` / `cpu`. Pinning is rarely needed. |
| `KOLM_BASE_MODEL` | — | Default base model for serve when artifact doesn't specify. |
| `KOLM_SPEC_DECODE_BACKEND` | — | `eagle` / `medusa` / `none`. Speculative decoding driver. |

### 3.8 Observability + audit

| Var | Default | Purpose |
|---|---|---|
| `KOLM_OTEL` | `0` | Enable OpenTelemetry traces. |
| `KOLM_OTEL_DEBUG` | `0` | Verbose OTel logging. |
| `KOLM_LOG_STRUCTURED` | `0` | Emit JSON-structured logs instead of human-readable. |
| `KOLM_AUDIT_DEBUG` | `0` | Verbose audit-log diagnostics. |
| `KOLM_AUDIT_RETENTION_DAYS` | `365` | Audit log retention. |
| `KOLM_WEBHOOK_URL` | — | Outbound webhook for approval queue notifications. |
| `KOLM_EMAIL_NOTIFY_CMD` | — | Shell command for email notifications (e.g. `aws ses send-email …`). |

### 3.9 Misc tunables

| Var | Default | Purpose |
|---|---|---|
| `KOLM_DOMAIN` | `kolm.ai` | Public domain (for OG tags + email From: address). |
| `KOLM_BILLING_URL` | — | Self-hosted billing endpoint (Stripe / Recurly proxy). Leave empty to disable billing UI. |
| `KOLM_PUBLIC_BASE` | `https://kolm.ai` | Public origin for absolute URLs in emails / receipts. |
| `KOLM_ENABLE_MOE` | `0` | Enable MoE expert-routing analysis (requires extra RAM). |
| `KOLM_PRIVACY_POLICY` | `default` | `default` / `strict` / `permissive`. Affects capture redaction defaults. |
| `KOLM_LOAD_QUEUE_DISABLED` | `0` | Disable the back-pressure queue (not recommended). |
| `KOLM_K_GATE` | `0.85` | Default K-Score gate threshold. |

---

## 4. Production .env template

Copy this to `/etc/kolm/.env`, fill in the secrets, then `chmod 600`. Mount as
`EnvironmentFile=` in your systemd unit (or use a secrets manager).

```bash
# ---- core paths
KOLM_HOME=/var/lib/kolm
KOLM_DATA_DIR=/var/lib/kolm/data
KOLM_ARTIFACT_DIR=/var/lib/kolm/artifacts
KOLM_MODELS_DIR=/var/lib/kolm/models

# ---- identity + signing
KOLM_ARTIFACT_SECRET=                # `openssl rand -hex 32`
KOLM_SIGNING_KEY=/etc/kolm/signing.pem
KOLM_REQUIRE_ED=true
KOLM_REQUIRE_REKOR=false             # set true for supply-chain attestation

# ---- storage
KOLM_STORE_DRIVER=pg
DATABASE_URL=postgres://kolm:CHANGEME@db.internal:5432/kolm
KOLM_EVENT_STORE_DRIVER=sqlite
KOLM_DB_PATH=/var/lib/kolm/data/kolm.sqlite

# ---- teacher
KOLM_DISTILL_TEACHER=local           # use local vLLM in air-gap, else "anthropic"/"openai"
KOLM_LOCAL_TEACHER_URL=http://teacher.internal:8000/v1
KOLM_LOCAL_TEACHER_MODEL=qwen2.5-72b-instruct

# ---- serve
KOLM_VLLM_URL=http://vllm.internal:8000
KOLM_PUBLIC_BASE=https://kolm.corp.internal
KOLM_DOMAIN=corp.internal

# ---- observability
KOLM_OTEL=1
KOLM_LOG_STRUCTURED=1
KOLM_AUDIT_RETENTION_DAYS=2555       # 7 years (HIPAA)
```

---

## 5. Storage layout

### Single-node

```
/var/lib/kolm/
  config.json            # KOLM_HOME — per-deploy config + signing secret cache
  artifacts/             # KOLM_ARTIFACT_DIR — compiled .kolm files
  models/                # KOLM_MODELS_DIR — HF base-model cache
  data/                  # KOLM_DATA_DIR — tenant state
    events.jsonl         # append-only event log (when driver=jsonl)
    kolm.sqlite          # SQLite event store (when driver=sqlite)
    jobs/                # long-running job state
    media/               # multimodal blobs
    audit/               # audit log
```

### Multi-node (HA)

- `KOLM_DATA_DIR` → shared NFS / EFS / FSx mount
- `KOLM_ARTIFACT_DIR` → s3:// bucket via `KOLM_STORE_DRIVER=s3` (planned v0.6) OR shared mount
- `DATABASE_URL` → managed Postgres (RDS, CloudSQL, AlloyDB)
- `KOLM_MODELS_DIR` → per-node local SSD (HF base models are read-heavy + bulky — local is faster + cheaper than shared)

---

## 6. Database setup (Postgres)

```sql
CREATE DATABASE kolm;
CREATE USER kolm WITH PASSWORD 'CHANGEME';
GRANT ALL PRIVILEGES ON DATABASE kolm TO kolm;
\c kolm
GRANT ALL ON SCHEMA public TO kolm;
```

Migrations auto-run on first boot. To pre-apply:

```bash
kolm migrate --check       # dry-run
kolm migrate --apply       # apply pending
kolm migrate --status      # list applied migrations
```

Backup with stock `pg_dump`; restore with `psql`. Daily encrypted backups
recommended; test restore monthly (see §11.3).

---

## 7. TLS / reverse proxy

The binary serves plaintext HTTP on `KOLM_PORT` (default 8080). Front with
Nginx / Caddy / Traefik / your cloud LB for TLS.

### Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name kolm.corp.internal;
  ssl_certificate     /etc/ssl/kolm.corp.internal.pem;
  ssl_certificate_key /etc/ssl/kolm.corp.internal.key;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_ciphers ECDHE-RSA-AES256-GCM-SHA384;

  client_max_body_size 200M;          # multimodal uploads
  proxy_read_timeout 3600s;           # long-running compile

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection        "";
  }
}
```

### Caddy

```caddyfile
kolm.corp.internal {
  reverse_proxy 127.0.0.1:8080 {
    transport http {
      read_timeout 3600s
    }
  }
}
```

---

## 8. systemd unit

```ini
# /etc/systemd/system/kolm.service
[Unit]
Description=kolm — distillation + serving
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=kolm
Group=kolm
EnvironmentFile=/etc/kolm/.env
ExecStart=/usr/bin/node /opt/kolm/cli/kolm.js daemon --port 8080
Restart=on-failure
RestartSec=5s
LimitNOFILE=65535
ProtectSystem=strict
ReadWritePaths=/var/lib/kolm /var/log/kolm
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
useradd -r -s /bin/false kolm
mkdir -p /var/lib/kolm /var/log/kolm
chown -R kolm:kolm /var/lib/kolm /var/log/kolm
systemctl daemon-reload
systemctl enable --now kolm
systemctl status kolm
```

---

## 9. SSO / SAML / SCIM

Enterprise tier ships SAML 2.0 + SCIM endpoints out of the box.

| Endpoint | Purpose |
|---|---|
| `GET /v1/sso/saml/metadata` | SP metadata XML (paste into your IdP) |
| `POST /v1/sso/saml/acs` | Assertion Consumer Service |
| `POST /v1/sso/saml/slo` | Single Logout |
| `GET /v1/scim/v2/ServiceProviderConfig` | RFC 7644 SP config |
| `GET /v1/scim/v2/Users` | User provisioning |
| `GET /v1/scim/v2/Groups` | Group provisioning |

Configure via:

```bash
KOLM_SAML_IDP_METADATA_URL=https://idp.corp.internal/metadata
KOLM_SAML_SP_ENTITY_ID=https://kolm.corp.internal
KOLM_SAML_SP_CERT=/etc/kolm/saml-sp.pem
KOLM_SAML_SP_KEY=/etc/kolm/saml-sp.key
KOLM_SCIM_BEARER_TOKEN=                # `openssl rand -hex 32` — give to your IdP
```

Tested with Okta, Azure AD, Google Workspace, OneLogin, Auth0.

---

## 10. Air-gap mode

For environments with no outbound internet (gov, finance, healthcare):

### 10.1 Pre-populate the model cache (on an internet-connected box)

```bash
export KOLM_MODELS_DIR=/tmp/airgap-cache
kolm models pull qwen2.5-3b-instruct
kolm models pull qwen2.5-7b-instruct
kolm models pull deepseek-r1-distill-qwen-32b
tar -czf airgap-models.tgz -C /tmp airgap-cache
# transfer airgap-models.tgz to the air-gapped host
```

### 10.2 On the air-gapped host

```bash
mkdir -p /var/lib/kolm/models
tar -xzf airgap-models.tgz -C /var/lib/kolm/models --strip-components=1
echo "KOLM_AIRGAP=1" >> /etc/kolm/.env
echo "KOLM_MODELS_DIR=/var/lib/kolm/models" >> /etc/kolm/.env
echo "KOLM_LOCAL_TEACHER_URL=http://vllm.local:8000/v1" >> /etc/kolm/.env
echo "KOLM_LOCAL_TEACHER_MODEL=qwen2.5-72b-instruct" >> /etc/kolm/.env
systemctl restart kolm
```

### 10.3 Build the air-gap bundle from this repo

```bash
kolm bundle airgap --out /tmp/kolm-airgap.tar.gz
```

Produces a single tarball with:
- Node.js runtime (matching the build target)
- Pinned `node_modules`
- `cli/kolm.js` + `src/`
- All required Python wheels for distill workers (CUDA + CPU variants)
- Default model weights (Qwen 2.5 3B + 7B)
- This deploy guide + offline `docs/` mirror

Bundle is reproducible — same git SHA produces byte-identical tarballs.

---

## 11. Operations

### 11.1 Health checks

```bash
curl -fsS http://localhost:8080/health
# {"ok":true,"uptime_s":42,"version":"v0.5.2"}

kolm doctor --json
# probes config, signing, storage, teacher, GPU, network
```

Wire into your monitoring as a liveness probe; treat any `ok:false` as
page-worthy.

### 11.2 Backups

```bash
# Database (postgres)
pg_dump -Fc kolm > /backup/kolm-$(date +%F).dump

# Filesystem (data + artifacts + models)
tar -czf /backup/kolm-data-$(date +%F).tar.gz \
  /var/lib/kolm/data \
  /var/lib/kolm/artifacts

# Encrypt
gpg --symmetric --cipher-algo AES256 /backup/kolm-data-$(date +%F).tar.gz
```

Test restore monthly to a staging host.

### 11.3 Restore

```bash
systemctl stop kolm
psql kolm < kolm-2026-05-25.dump
tar -xzf kolm-data-2026-05-25.tar.gz -C /
systemctl start kolm
kolm doctor          # confirm
```

### 11.4 Rotate the artifact secret

```bash
# 1. Generate a new secret
NEW=$(openssl rand -hex 32)

# 2. On every node, add the new secret as a fallback before rotation
echo "KOLM_ARTIFACT_SECRET_NEW=$NEW" >> /etc/kolm/.env
systemctl restart kolm

# 3. Re-sign existing artifacts with the new secret
kolm artifacts resign --secret "$NEW"

# 4. Swap primary
sed -i "s/^KOLM_ARTIFACT_SECRET=.*/KOLM_ARTIFACT_SECRET=$NEW/" /etc/kolm/.env
sed -i "/^KOLM_ARTIFACT_SECRET_NEW=/d" /etc/kolm/.env
systemctl restart kolm
```

### 11.5 Upgrade

```bash
systemctl stop kolm
npm install -g kolm@latest        # or `git pull && npm install`
kolm migrate --apply              # idempotent
systemctl start kolm
kolm doctor
```

Rollback by pinning the prior version: `npm install -g kolm@0.5.1`.

---

## 12. Smoke tests

After install, before letting users in:

```bash
# 1. Sanity
kolm --version
kolm doctor

# 2. Signup + auth (creates the bootstrap tenant)
kolm signup --email admin@corp.internal
kolm whoami

# 3. End-to-end compile
cat > /tmp/smoke.json <<'EOF'
{"job_id":"job_smoke","task":"smoke","recipes":[{"id":"rcp_smoke","name":"smoke","source":"function generate(input,lib){return {ok:true};}"}],"evals":{"spec":"rs-1-evals","cases":[{"id":"c1","input":"hi","expected":{"ok":true}}],"coverage":1.0}}
EOF
kolm compile --spec /tmp/smoke.json
kolm verify ~/.kolm/artifacts/job_smoke.kolm
kolm run ~/.kolm/artifacts/job_smoke.kolm --input "hello"

# 4. Serve
kolm serve ~/.kolm/artifacts/job_smoke.kolm --runtime auto --port 8765 &
curl http://localhost:8765/v1/models

# 5. Run the production verification suite (51 tests)
kolm verify-deploy --json | jq '.summary'
```

Expected: every step exits 0, `verify-deploy` reports `passed:51, failed:0`.

---

## 13. Compliance + procurement

| Artifact | Where |
|---|---|
| SIG Lite + CAIQ v4 pre-answered | `kolm procurement all --format markdown --out kolm-vendor-pack.md` |
| Per-artifact compliance bundle | `kolm passport export <artifact.kolm> --format compliance` |
| SBOM (CycloneDX 1.5) | `kolm sbom <artifact.kolm>` |
| EU AI Act Annex IV technical doc | `kolm passport export <artifact.kolm> --format compliance` (bundled) |
| Carbon estimate | `kolm passport export <artifact.kolm>` (bundled) |
| Pen test report (Q2 2026) | `/trust/pentest` (under NDA) |
| SOC 2 Type I | `/trust/soc2` (under NDA — Type II Q1 2027) |

Send `kolm-vendor-pack.md` to your security team; it covers the top 70+
questions from typical enterprise procurement reviews.

---

## 14. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `KOLM_E_SPEC_INVALID` on compile | Spec missing field | `kolm spec validate <file>` for the exact field |
| `signature_verification_failed` | Mismatched `KOLM_ARTIFACT_SECRET` between signer and verifier | Re-sign artifact (§11.4) or pin the same secret on all nodes |
| `out_of_memory` on compile | Spec too large for GPU | `kolm fit <spec>` to see required VRAM; use `--cloud modal` if local hardware insufficient |
| `teacher_unreachable` | `KOLM_LOCAL_TEACHER_URL` unset or wrong | `curl $KOLM_LOCAL_TEACHER_URL/models` to confirm |
| `port_in_use` | Daemon already running | `lsof -i:8080` then `kill -TERM <pid>` |
| `disk_full` on `KOLM_MODELS_DIR` | HF cache grew | `kolm models prune --keep-recent 3` |
| Air-gap host attempts egress | Misconfigured `KOLM_AIRGAP` | Confirm `kolm doctor` shows `airgap:true`; check for missing `KOLM_LOCAL_TEACHER_URL` |
| Slow compile | CPU fallback (no GPU) | `nvidia-smi` to confirm GPU visible; `kolm hardware` to confirm detection |
| SAML login loops | Clock drift > 5min between SP and IdP | `ntpdate` both sides |

See also: `kolm doctor --json` for an automated diagnostic dump you can paste
into a support ticket.

---

## 15. Support

- **Issues:** https://github.com/kolm-ai/kolm/issues
- **Security:** security@kolm.ai (PGP key at `/.well-known/security.txt`)
- **Enterprise support:** support@kolm.ai (response within 4 business hours)
- **Status:** https://status.kolm.ai (managed cloud only — self-hosted is your status)

For dedicated deployment engineering, see [`/pricing`](https://kolm.ai/pricing) Enterprise tier (includes deploy-day pairing + first-year SLA).
