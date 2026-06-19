// Bring-Your-Own-Cloud (BYOC) deployment scaffolding.
//
// A BYOC deployment runs a .kolm artifact on infrastructure the customer
// controls - Fly Machines, AWS Nitro Enclaves, GCP Confidential VMs, Azure
// Confidential Compute, confidential GPU variants, or a generic Docker host they own. kolm.ai never
// touches the runtime; we issue a signed deploy manifest + a deploy script,
// and the customer's CI runs `fly deploy` (or equivalent) themselves.
//
// After deploy, the operator POSTs an attestation report back so the team
// owner can see "this artifact is running at <url>, last-seen <ts>". For
// TEE targets (Nitro, GCP-CVM, Azure-CVM) the attestation includes the
// vendor-signed measurement; for plain Docker/Fly it is just a self-attested
// SHA of the deployed image.

import crypto from 'node:crypto';
import { id, insert, find, findOne, update, all } from './store.js';
import { effectiveReceiptSecret } from './env.js';
import {
  parseAttestation,
  evaluateParsedAttestation,
  HARDWARE_ATTESTATION_TARGETS,
} from '../packages/attestation/src/index.js';
import { verifyAttestation as verifyCcAttestation, KINDS as CC_KINDS, STATES as CC_STATES } from './confidential-compute.js';
import { isValidCidFormat } from './cid.js';
import {
  buildAndSignProvenComputeReceipt,
  verifyProvenComputeReceipt,
} from './proven-compute-receipt.js';

const TARGETS = ['fly', 'aws-nitro', 'gcp-cvm', 'gcp-cvm-gpu', 'azure-cvm', 'azure-cvm-gpu', 'docker'];

// Map a BYOC deploy target to the attestation parser target. `fly` has no
// hardware attestation (Fly Machines is a plain Linux VM), so we route it
// through the docker software-measurement path.
function attestationTargetFor(deployTarget) {
  if (deployTarget === 'fly') return 'docker';
  if (deployTarget === 'gcp-cvm-gpu') return 'gcp-cvm';
  if (deployTarget === 'azure-cvm-gpu') return 'azure-cvm';
  return deployTarget;
}

function isHardwareParserTarget(target) {
  return HARDWARE_ATTESTATION_TARGETS.includes(target);
}

function signManifest(manifest) {
  const secret = effectiveReceiptSecret({ includeLegacyArtifactSecret: true });
  if (!secret) return null;
  const canonical = JSON.stringify(manifest, Object.keys(manifest).sort());
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

export function createDeployment({ tenantId, tenantName, teamId = null, target, artifactId, region = 'iad', name = 'kolm-byoc' }) {
  if (!TARGETS.includes(target)) {
    throw Object.assign(new Error(`unsupported target "${target}"; supported: ${TARGETS.join(', ')}`), { code: 'bad_request' });
  }
  if (!artifactId) throw Object.assign(new Error('artifactId required'), { code: 'bad_request' });
  const cleanName = String(name || 'kolm-byoc').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
  const deployId = id('byoc');
  const enrollToken = crypto.randomBytes(24).toString('base64url');
  const manifest = {
    spec: 'kolm-byoc/1',
    deploy_id: deployId,
    artifact_id: artifactId,
    target,
    region,
    name: cleanName,
    enroll_token: enrollToken,
    issued_at: new Date().toISOString(),
    tenant_id: tenantId,
    team_id: teamId,
  };
  manifest.signature = signManifest({ deploy_id: manifest.deploy_id, artifact_id: manifest.artifact_id, target: manifest.target, region: manifest.region, name: manifest.name, enroll_token: manifest.enroll_token, issued_at: manifest.issued_at });
  const deployment = {
    id: deployId,
    tenant_id: tenantId,
    tenant_name: tenantName,
    team_id: teamId,
    target,
    region,
    name: cleanName,
    artifact_id: artifactId,
    enroll_token: enrollToken,
    status: 'issued',
    public_url: null,
    attestation: null,
    last_attested_at: null,
    created_at: manifest.issued_at,
  };
  insert('byoc_deployments', deployment);
  return { deployment, manifest, deploy_script: deployScriptFor(target, manifest) };
}

export function getDeployment(idOrEnroll) {
  return findOne('byoc_deployments', d => !d._deleted && (d.id === idOrEnroll || d.enroll_token === idOrEnroll));
}

export function listDeploymentsForTenant(tenantId, { teamId = null } = {}) {
  return find('byoc_deployments', d => !d._deleted && (d.tenant_id === tenantId || (teamId && d.team_id === teamId)));
}

// Verify a GPU-TEE (NVIDIA Confidential Compute / NRAS) attestation report and
// return a state object safe to persist on the deployment row alongside the CPU
// docker measurement. Routes the NRAS report through confidential-compute's
// verifyAttestation: shape-only by default (verified:false), flipping
// verified:true only when a tenant has registered a real NRAS crypto verifier.
//
// Returns a compact { kind, shape_ok, verified, verifier, report_hash, state,
// reason } projection. NEVER throws and NEVER claims crypto verification on the
// shape-only path.
export async function verifyGpuAttestation(report, opts = {}) {
  const kind = CC_KINDS.NRAS;
  let state;
  try {
    state = await verifyCcAttestation(kind, report, opts);
  } catch (e) {
    state = { kind, state: CC_STATES.REJECTED, verifier: 'none', verified: false, reason: `verify_threw:${e && e.message}` };
  }
  const shape_ok = state.state !== CC_STATES.REJECTED;
  return {
    kind,
    shape_ok,
    verified: state.verified === true,
    verifier: state.verifier || (shape_ok ? 'shape_v1' : 'none'),
    report_hash: state.report_hash || null,
    state: state.state || null,
    reason: state.reason || null,
    trust_root: state.trust_root || null,
    nonce: state.nonce || state.eat_nonce || null,
    expected_nonce: state.expected_nonce || null,
    nonce_binding_alg: state.nonce_binding_alg || null,
    timestamp: state.timestamp || new Date().toISOString(),
  };
}

function _firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

function _firstArray(...values) {
  for (const v of values) {
    if (Array.isArray(v)) return v;
  }
  return [];
}

export function normalizeGpuAttestationReport(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const raw = b.gpu_attestation || b.gpu_attestation_report || b.nras_report || b.nras_attestation || null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    return {
      gpu_id: _firstString(b.gpu_id, b.nras_gpu_id),
      driver_version: _firstString(b.driver_version, b.nras_driver_version),
      vbios_version: _firstString(b.vbios_version, b.nras_vbios_version),
      attestation_report: raw.trim(),
      cert_chain: _firstArray(b.cert_chain, b.gpu_cert_chain, b.nras_cert_chain),
      nonce: _firstString(b.nonce, b.gpu_nonce, b.eat_nonce),
    };
  }
  return null;
}

export function gpuAttestationVerifyOptions(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return {
    input_digest: _firstString(b.input_digest, b.inputDigest, b.input_hash, b.inputHash),
    output_digest: _firstString(b.output_digest, b.outputDigest, b.output_hash, b.outputHash),
  };
}

function _sha256FromPrefixed(value) {
  const raw = _firstString(value);
  if (!raw) return null;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(raw);
  if (m) return m[1].toLowerCase();
  if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
  return null;
}

function _artifactIdentityForProvenCompute(deployment, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const artifact_hash = _sha256FromPrefixed(
    b.artifact_hash,
    b.artifactHash,
    b.artifact_sha256,
    b.artifactSha256,
    b.kolm_artifact_hash,
  );
  const cidCandidate = _firstString(
    b.cid,
    b.artifact_cid,
    b.artifactCid,
    b.kolm_cid,
    deployment && deployment.artifact_id,
  );
  return {
    artifact_hash,
    cid: cidCandidate && isValidCidFormat(cidCandidate) ? cidCandidate : null,
  };
}

// Build a signed Proven-Compute Receipt for a BYOC attestation callback. This
// is intentionally fail-closed and additive: callers get { ok:false, reason }
// unless the GPU state is cryptographically verified, input/output digests are
// present, and the callback supplies an explicit artifact hash or CID. Shape-only
// BYOC callbacks still persist gpu state but do not get a proof receipt.
export function buildProvenComputeReceiptForAttestation(enrollToken, { body = {}, gpu = null, signer = null, transparencyLog = null } = {}) {
  const d = getDeployment(enrollToken);
  if (!d) return { ok: false, reason: 'deployment_not_found' };
  if (!gpu || gpu.verified !== true) return { ok: false, reason: 'gpu_attestation_not_verified' };
  const digests = gpuAttestationVerifyOptions(body);
  if (!digests.input_digest || !digests.output_digest) {
    return { ok: false, reason: 'missing_input_or_output_digest' };
  }
  const artifact = _artifactIdentityForProvenCompute(d, body);
  if (!artifact.artifact_hash && !artifact.cid) {
    return { ok: false, reason: 'missing_artifact_hash_or_cid' };
  }
  let receipt;
  try {
    receipt = buildAndSignProvenComputeReceipt({
      artifact_hash: artifact.artifact_hash,
      cid: artifact.cid,
      model_weight_artifact_manifest_hash: _sha256FromPrefixed(body.model_weight_artifact_manifest_hash || body.modelWeightArtifactManifestHash),
      signature_key_fingerprint: _firstString(body.signature_key_fingerprint, body.signatureKeyFingerprint),
      input_digest: digests.input_digest,
      output_digest: digests.output_digest,
      attestation_state: gpu,
      runtime_target: _firstString(body.runtime_target, body.runtimeTarget, d.target),
    }, { signer: signer || undefined, transparencyLog: transparencyLog || undefined });
  } catch (e) {
    return { ok: false, reason: `receipt_build_failed:${e && e.message ? e.message : 'unknown'}` };
  }
  const verified = verifyProvenComputeReceipt(receipt, { requireProvenCompute: true });
  if (!verified.ok) return { ok: false, reason: `receipt_verify_failed:${verified.reason}` };
  return { ok: true, receipt, receipt_digest: verified.receipt_digest };
}

export function recordAttestation(enrollToken, { public_url, attestation, measurement, gpu = null, proven_compute_receipt = null }) {
  const d = getDeployment(enrollToken);
  if (!d) return { ok: false, error: 'deployment not found' };
  const now = new Date().toISOString();
  // Parse the attestation through the TEE-aware parser. If the parser
  // extracts a vendor-signed measurement it overrides whatever the operator
  // self-reported; otherwise we fall back to the operator's claim.
  let parsed = null;
  let extractedMeasurement = typeof measurement === 'string' ? measurement.slice(0, 256) : null;
  let vendor = null;
  try {
    if (attestation) {
      const parserTarget = attestationTargetFor(d.target);
      const parsedResult = parseAttestation(parserTarget, attestation);
      if (parsedResult.ok) {
        const verification = evaluateParsedAttestation(parserTarget, parsedResult, {
          measurement: parsedResult.measurement,
          vendor: parsedResult.vendor,
        });
        parsed = {
          vendor: parsedResult.vendor,
          measurement: parsedResult.measurement,
          claims: parsedResult.claims,
          parsed_at: parsedResult.parsed_at,
          has_signing_chain: !!(parsedResult.signing_cert_chain && parsedResult.signing_cert_chain.length),
          verification: {
            valid: verification.valid,
            tier: verification.tier,
            cryptographic: verification.cryptographic,
            trust_policy: verification.trust_policy,
            verifier: verification.verifier,
            trust_root: verification.trust_root,
            reasons: verification.reasons,
          },
        };
        if (parsedResult.measurement && (!isHardwareParserTarget(parserTarget) || verification.cryptographic === true)) {
          extractedMeasurement = parsedResult.measurement;
        }
        vendor = parsedResult.vendor;
      }
    }
  } catch { // deliberate: cleanup
    // Parser failures should never block the record - we still capture the
    // raw blob so an operator can debug downstream.
  }
  // GPU-TEE state (NRAS): an already-verified state object the caller obtained
  // via verifyGpuAttestation. CPU-only deployments pass no gpu and the field
  // stays null - we never invent a GPU state from a missing report.
  const gpuState = (gpu && typeof gpu === 'object') ? gpu : null;
  const att = {
    public_url: String(public_url || '').slice(0, 400),
    measurement: extractedMeasurement ? extractedMeasurement.slice(0, 256) : null,
    vendor,
    parsed,
    gpu: gpuState,
    proven_compute_receipt: (proven_compute_receipt && typeof proven_compute_receipt === 'object') ? proven_compute_receipt : null,
    raw: typeof attestation === 'string' ? attestation.slice(0, 8192) : null,
    received_at: now,
  };
  update('byoc_deployments', x => x.id === d.id, {
    status: 'live',
    public_url: att.public_url,
    attestation: att,
    last_attested_at: now,
  });
  return { ok: true, vendor, measurement: att.measurement, gpu: gpuState, proven_compute_receipt: att.proven_compute_receipt };
}

export function teardownDeployment(deployId, byTenantId) {
  const d = getDeployment(deployId);
  if (!d) return false;
  if (d.tenant_id !== byTenantId) throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
  update('byoc_deployments', x => x.id === d.id, { _deleted: true, status: 'torn_down', torn_down_at: new Date().toISOString() });
  return true;
}

// ---------- per-target deploy scripts ----------
// These are *templates* the operator runs themselves. The artifact URL +
// enroll token are baked in so the BYOC host can POST an attestation back
// to kolm.ai after first boot. We never run these scripts ourselves.

function deployScriptFor(target, manifest) {
  switch (target) {
    case 'fly':       return flyDeployScript(manifest);
    case 'aws-nitro': return nitroDeployScript(manifest);
    case 'gcp-cvm':   return gcpCvmDeployScript(manifest);
    case 'gcp-cvm-gpu': return gcpCvmGpuDeployScript(manifest);
    case 'azure-cvm': return azureCvmDeployScript(manifest);
    case 'azure-cvm-gpu': return azureCvmGpuDeployScript(manifest);
    case 'docker':    return dockerDeployScript(manifest);
    default: return '# unsupported target';
  }
}

function flyDeployScript(m) {
  return `#!/usr/bin/env bash
# kolm BYOC deploy - Fly Machines
# deploy_id: ${m.deploy_id}
# artifact: ${m.artifact_id}
# region:   ${m.region}
set -euo pipefail

APP="${m.name}"
REGION="${m.region}"
ENROLL="${m.enroll_token}"
ARTIFACT_URL="https://kolm.ai/v1/artifacts/${m.artifact_id}/download"

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl not found. Install: https://fly.io/docs/hands-on/install-flyctl/"; exit 2
fi

# 1. Create app (idempotent)
flyctl apps create "$APP" --org personal 2>/dev/null || true

# 2. Pull the .kolm artifact into a build context
mkdir -p .kolm-build && cd .kolm-build
curl -fSL -o artifact.kolm "$ARTIFACT_URL"

# 3. Generate fly.toml + Dockerfile
cat > fly.toml <<EOF
app = "$APP"
primary_region = "$REGION"
[build]
[env]
  KOLM_ENROLL_TOKEN = "$ENROLL"
  KOLM_REPORT_URL = "https://kolm.ai/v1/byoc/attestation"
[[services]]
  internal_port = 8080
  protocol = "tcp"
  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
EOF

cat > Dockerfile <<'EOF'
FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --omit=dev kolm-runtime@latest 2>/dev/null || npm install --omit=dev express@4
COPY artifact.kolm /app/artifact.kolm
COPY boot.sh /app/boot.sh
RUN chmod +x /app/boot.sh
EXPOSE 8080
CMD ["/app/boot.sh"]
EOF

cat > boot.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SHA=$(sha256sum /app/artifact.kolm | cut -d' ' -f1)
APP_URL="https://$FLY_APP_NAME.fly.dev"
if [ -n "\${KOLM_ENROLL_TOKEN:-}" ] && [ -n "\${KOLM_REPORT_URL:-}" ]; then
  curl -fsS -X POST "$KOLM_REPORT_URL" \\
    -H 'content-type: application/json' \\
    -d "{\\"enroll_token\\":\\"$KOLM_ENROLL_TOKEN\\",\\"public_url\\":\\"$APP_URL\\",\\"measurement\\":\\"sha256:$SHA\\",\\"target\\":\\"fly\\"}" \\
    >/dev/null 2>&1 || true
fi
# Replace with: npx kolm-runtime serve /app/artifact.kolm --port 8080
node -e "const http=require('http'); http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,artifact:'$SHA',msg:'kolm BYOC live'}));}).listen(8080)"
EOF

# 4. Deploy
flyctl deploy --remote-only
echo
echo "Deployment complete. kolm.ai will receive an attestation on first boot."
echo "Public URL: https://$APP.fly.dev"
`;
}

function nitroDeployScript(m) {
  return `#!/usr/bin/env bash
# kolm BYOC deploy - AWS Nitro Enclave
# deploy_id: ${m.deploy_id}
# artifact: ${m.artifact_id}
set -euo pipefail

if ! command -v nitro-cli >/dev/null 2>&1; then
  echo "nitro-cli not found. Install on an EC2 host with Nitro Enclaves enabled."
  echo "See: https://docs.aws.amazon.com/enclaves/latest/user/getting-started.html"; exit 2
fi

ENROLL="${m.enroll_token}"
ARTIFACT_URL="https://kolm.ai/v1/artifacts/${m.artifact_id}/download"

# Build a minimal EIF (enclave image) that boots the kolm runtime + the artifact.
mkdir -p .kolm-enclave && cd .kolm-enclave
curl -fSL -o artifact.kolm "$ARTIFACT_URL"

cat > Dockerfile <<'EOF'
FROM amazonlinux:2
RUN yum install -y curl tar gzip
COPY artifact.kolm /opt/kolm/artifact.kolm
COPY entrypoint.sh /opt/kolm/entrypoint.sh
RUN chmod +x /opt/kolm/entrypoint.sh
CMD ["/opt/kolm/entrypoint.sh"]
EOF

cat > entrypoint.sh <<EOF_INNER
#!/usr/bin/env bash
set -euo pipefail
# Nitro attestation document
ATTEST=\$(nitro-cli describe-enclaves 2>/dev/null | head -c 2048 || echo "{}")
SHA=\$(sha256sum /opt/kolm/artifact.kolm | cut -d' ' -f1)
# Note: this curl runs OUTSIDE the enclave from the parent. Inside, use a vsock proxy.
curl -fsS -X POST https://kolm.ai/v1/byoc/attestation \\\\
  -H 'content-type: application/json' \\\\
  -d "{\\"enroll_token\\":\\"${m.enroll_token}\\",\\"measurement\\":\\"sha256:\$SHA\\",\\"target\\":\\"aws-nitro\\",\\"attestation\\":\$ATTEST}" || true
# kolm runtime listens on 8080 inside the enclave; parent proxies via vsock.
exec /usr/bin/env true
EOF_INNER

# Build → EIF → run
docker build -t kolm-byoc-enclave .
nitro-cli build-enclave --docker-uri kolm-byoc-enclave:latest --output-file kolm.eif
nitro-cli run-enclave --eif-path kolm.eif --memory 2048 --cpu-count 2 --enclave-cid 16

echo "Enclave running. Use socat to forward 8080 ↔ vsock://16:8080 for incoming traffic."
`;
}

function indentBlock(text, spaces = 4) {
  const pad = ' '.repeat(spaces);
  return String(text || '').split('\n').map(line => pad + line).join('\n');
}

function gpuNrasBootScript(m, deployTarget) {
  return `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export KOLM_ENROLL_TOKEN="${m.enroll_token}"
export KOLM_ARTIFACT_URL="https://kolm.ai/v1/artifacts/${m.artifact_id}/download"
export KOLM_DEPLOY_TARGET="${deployTarget}"
export KOLM_REPORT_URL="\${KOLM_REPORT_URL:-https://kolm.ai/v1/byoc/attestation}"

apt-get update
apt-get install -y curl ca-certificates python3

mkdir -p /opt/kolm
curl -fSL -o /opt/kolm/artifact.kolm "$KOLM_ARTIFACT_URL"
export KOLM_ARTIFACT_SHA="$(sha256sum /opt/kolm/artifact.kolm | cut -d' ' -f1)"

# If input/output digests are supplied, derive the exact W968/W969 nonce
# binding. Otherwise use artifact hash as a boot-attestation nonce only.
if [ -n "\${KOLM_BYOC_INPUT_DIGEST:-}" ] && [ -n "\${KOLM_BYOC_OUTPUT_DIGEST:-}" ]; then
  KOLM_DERIVED_NONCE="$(python3 -c "import hashlib, os; print(hashlib.sha256(bytes.fromhex(os.environ['KOLM_BYOC_INPUT_DIGEST']) + bytes.fromhex(os.environ['KOLM_BYOC_OUTPUT_DIGEST'])).hexdigest())" 2>/dev/null || true)"
  export KOLM_DERIVED_NONCE
fi
if [ -z "\${KOLM_NRAS_NONCE:-}" ]; then
  export KOLM_NRAS_NONCE="\${KOLM_DERIVED_NONCE:-$KOLM_ARTIFACT_SHA}"
fi

if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi -q -x >/opt/kolm/nvidia-smi.xml 2>/dev/null || true
  nvidia-smi --query-gpu=uuid,driver_version,vbios_version --format=csv,noheader,nounits \\
    | head -n 1 >/opt/kolm/gpu.csv 2>/dev/null || true
fi

collect_nras_report() {
  if [ -n "\${KOLM_NRAS_REPORT_FILE:-}" ] && [ -s "$KOLM_NRAS_REPORT_FILE" ]; then
    cat "$KOLM_NRAS_REPORT_FILE"; return 0
  fi
  if command -v nvidia-attestation >/dev/null 2>&1; then
    nvidia-attestation --nonce "$KOLM_NRAS_NONCE" --format json 2>/dev/null && return 0
    nvidia-attestation report --nonce "$KOLM_NRAS_NONCE" --format json 2>/dev/null && return 0
  fi
  if command -v nvtrust >/dev/null 2>&1; then
    nvtrust attestation --nonce "$KOLM_NRAS_NONCE" --format json 2>/dev/null && return 0
    nvtrust attest --nonce "$KOLM_NRAS_NONCE" --format json 2>/dev/null && return 0
  fi
  return 0
}

collect_nras_report >/opt/kolm/nras-attestation.raw || true
PUB="$(curl -fsS ifconfig.me 2>/dev/null || curl -fsS ipify.org 2>/dev/null || true)"
export KOLM_PUBLIC_URL="\${KOLM_PUBLIC_URL:-http://$PUB}"

python3 - <<'PY' >/tmp/kolm-byoc-attestation.json
import json
import os
import re

def read_text(path):
    try:
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read().strip()
    except Exception:
        return ''

def first(*values):
    for v in values:
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ''

def extract(obj, *names):
    if not isinstance(obj, dict):
        return ''
    for name in names:
        v = obj.get(name)
        if v:
            return v
    return ''

def split_pem_bundle(text):
    if not text:
        return []
    blocks = []
    cur = []
    for line in text.splitlines():
        if 'BEGIN CERTIFICATE' in line:
            cur = [line]
        elif cur:
            cur.append(line)
            if 'END CERTIFICATE' in line:
                blocks.append('\\n'.join(cur))
                cur = []
    return blocks

raw = read_text('/opt/kolm/nras-attestation.raw')
try:
    parsed = json.loads(raw) if raw else {}
except Exception:
    parsed = {}

gpu_csv = [x.strip() for x in read_text('/opt/kolm/gpu.csv').split(',')]
gpu_id = first(os.environ.get('KOLM_NRAS_GPU_ID'), extract(parsed, 'gpu_id', 'gpu_uuid', 'uuid'), gpu_csv[0] if len(gpu_csv) > 0 else '', 'unknown-gpu')
driver = first(os.environ.get('KOLM_NRAS_DRIVER_VERSION'), extract(parsed, 'driver_version'), gpu_csv[1] if len(gpu_csv) > 1 else '', 'unknown-driver')
vbios = first(os.environ.get('KOLM_NRAS_VBIOS_VERSION'), extract(parsed, 'vbios_version'), gpu_csv[2] if len(gpu_csv) > 2 else '', 'unknown-vbios')
token = extract(parsed, 'attestation_report', 'eat', 'eat_token', 'jwt', 'token', 'report')
if not isinstance(token, str):
    token = ''
token = first(token, raw)
nonce = first(os.environ.get('KOLM_NRAS_NONCE'), extract(parsed, 'eat_nonce', 'nonce'))

cert_chain = []
parsed_chain = extract(parsed, 'cert_chain', 'x5c')
if isinstance(parsed_chain, list):
    cert_chain.extend([str(x) for x in parsed_chain if str(x).strip()])
elif isinstance(parsed_chain, str):
    cert_chain.extend(split_pem_bundle(parsed_chain))
cert_chain.extend(split_pem_bundle(os.environ.get('KOLM_NRAS_CERT_CHAIN_PEM', '')))
cert_chain.extend(split_pem_bundle(read_text(os.environ.get('KOLM_NRAS_CERT_CHAIN_FILE', ''))))

payload = {
    'enroll_token': os.environ['KOLM_ENROLL_TOKEN'],
    'public_url': os.environ.get('KOLM_PUBLIC_URL') or '',
    'measurement': 'sha256:' + os.environ['KOLM_ARTIFACT_SHA'],
    'target': os.environ['KOLM_DEPLOY_TARGET'],
    'artifact_hash': os.environ['KOLM_ARTIFACT_SHA'],
    'runtime_target': os.environ['KOLM_DEPLOY_TARGET'],
    'gpu_attestation': {
        'gpu_id': gpu_id,
        'driver_version': driver,
        'vbios_version': vbios,
        'attestation_report': token,
        'cert_chain': cert_chain,
        'nonce': nonce,
    },
}
if re.fullmatch(r'[0-9a-fA-F]{64}', os.environ.get('KOLM_BYOC_INPUT_DIGEST', '') or ''):
    payload['input_digest'] = os.environ['KOLM_BYOC_INPUT_DIGEST'].lower()
if re.fullmatch(r'[0-9a-fA-F]{64}', os.environ.get('KOLM_BYOC_OUTPUT_DIGEST', '') or ''):
    payload['output_digest'] = os.environ['KOLM_BYOC_OUTPUT_DIGEST'].lower()
if (os.environ.get('KOLM_REQUIRE_PROVEN_COMPUTE', '') or '').lower() in ('1', 'true', 'yes'):
    payload['require_proven_compute'] = True
print(json.dumps(payload, separators=(',', ':')))
PY

curl -fsS -X POST "$KOLM_REPORT_URL" \\
  -H 'content-type: application/json' \\
  --data-binary @/tmp/kolm-byoc-attestation.json || true
`;
}

function gcpCvmDeployScript(m) {
  return `#!/usr/bin/env bash
# kolm BYOC deploy - GCP Confidential VM
# deploy_id: ${m.deploy_id}
# artifact: ${m.artifact_id}
set -euo pipefail
if ! command -v gcloud >/dev/null 2>&1; then echo "gcloud CLI required"; exit 2; fi

PROJECT="\${PROJECT:?set PROJECT=<gcp-project-id>}"
NAME="${m.name}"
ZONE="\${ZONE:-us-central1-a}"
ENROLL="${m.enroll_token}"
ARTIFACT_URL="https://kolm.ai/v1/artifacts/${m.artifact_id}/download"

cat > startup.sh <<EOF_STARTUP
#!/bin/bash
set -e
apt-get update && apt-get install -y curl
mkdir -p /opt/kolm
curl -fSL -o /opt/kolm/artifact.kolm "\${ARTIFACT_URL}"
SHA=\$(sha256sum /opt/kolm/artifact.kolm | cut -d' ' -f1)
ATTEST=\$(curl -sS metadata.google.internal/computeMetadata/v1/instance/attributes/attestation?recursive=true -H "Metadata-Flavor: Google" 2>/dev/null || echo "{}")
curl -fsS -X POST https://kolm.ai/v1/byoc/attestation \\\\
  -H 'content-type: application/json' \\\\
  -d "{\\"enroll_token\\":\\"\${ENROLL}\\",\\"public_url\\":\\"http://\$(curl -s ipify.org)\\",\\"measurement\\":\\"sha256:\${SHA}\\",\\"target\\":\\"gcp-cvm\\",\\"attestation\\":\${ATTEST}}" || true
EOF_STARTUP

gcloud compute instances create "$NAME" \\
  --project "$PROJECT" --zone "$ZONE" \\
  --machine-type n2d-standard-2 \\
  --confidential-compute \\
  --maintenance-policy TERMINATE \\
  --image-family ubuntu-2204-lts --image-project ubuntu-os-cloud \\
  --metadata-from-file=startup-script=startup.sh \\
  --tags http-server

gcloud compute firewall-rules create kolm-byoc-allow-80 --project "$PROJECT" \\
  --allow tcp:80 --target-tags http-server 2>/dev/null || true

echo "Confidential VM \\\"$NAME\\\" created in $ZONE. Boot will POST attestation to kolm.ai."
`;
}

function gcpCvmGpuDeployScript(m) {
  return `#!/usr/bin/env bash
# kolm BYOC deploy - GCP Confidential VM with NVIDIA Confidential Computing GPU
# deploy_id: ${m.deploy_id}
# artifact: ${m.artifact_id}
#
# Defaults follow Google Cloud's current Confidential VM GPU docs:
#   a3-highgpu-1g + TDX + SPOT + ubuntu-2204-lts for NVIDIA H100.
# Operators can override MACHINE_TYPE/CONFIDENTIAL_COMPUTE_TYPE/IMAGE_FAMILY
# for G4 SEV preview targets.
set -euo pipefail
if ! command -v gcloud >/dev/null 2>&1; then echo "gcloud CLI required"; exit 2; fi

PROJECT="\${PROJECT:?set PROJECT=<gcp-project-id>}"
NAME="${m.name}"
ZONE="\${ZONE:-us-central1-a}"
MACHINE_TYPE="\${MACHINE_TYPE:-a3-highgpu-1g}"
CONFIDENTIAL_COMPUTE_TYPE="\${CONFIDENTIAL_COMPUTE_TYPE:-TDX}"
PROVISIONING_MODEL="\${PROVISIONING_MODEL:-SPOT}"
IMAGE_PROJECT="\${IMAGE_PROJECT:-ubuntu-os-cloud}"
IMAGE_FAMILY="\${IMAGE_FAMILY:-ubuntu-2204-lts}"

cat > startup.sh <<'EOF_STARTUP'
${gpuNrasBootScript(m, 'gcp-cvm-gpu')}
EOF_STARTUP

gcloud compute instances create "$NAME" \\
  --project "$PROJECT" --zone "$ZONE" \\
  --provisioning-model="$PROVISIONING_MODEL" \\
  --confidential-compute-type="$CONFIDENTIAL_COMPUTE_TYPE" \\
  --machine-type="$MACHINE_TYPE" \\
  --maintenance-policy=TERMINATE \\
  --image-project="$IMAGE_PROJECT" --image-family="$IMAGE_FAMILY" \\
  --boot-disk-size=200G \\
  --metadata-from-file=startup-script=startup.sh \\
  --shielded-secure-boot \\
  --tags http-server

gcloud compute firewall-rules create kolm-byoc-allow-80 --project "$PROJECT" \\
  --allow tcp:80 --target-tags http-server 2>/dev/null || true

echo "Confidential GPU VM \\\"$NAME\\\" created in $ZONE. Boot will capture NVIDIA GPU evidence and POST to kolm.ai."
`;
}

function azureCvmDeployScript(m) {
  return `#!/usr/bin/env bash
# kolm BYOC deploy - Azure Confidential VM
# deploy_id: ${m.deploy_id}
# artifact: ${m.artifact_id}
set -euo pipefail
if ! command -v az >/dev/null 2>&1; then echo "az CLI required"; exit 2; fi

RG="\${RG:?set RG=<resource-group>}"
NAME="${m.name}"
LOC="\${LOC:-eastus}"
ENROLL="${m.enroll_token}"
ARTIFACT_URL="https://kolm.ai/v1/artifacts/${m.artifact_id}/download"

cat > cloud-init.yaml <<EOF
#cloud-config
write_files:
- path: /opt/kolm/boot.sh
  permissions: '0755'
  content: |
    #!/bin/bash
    set -e
    apt-get update && apt-get install -y curl
    mkdir -p /opt/kolm
    curl -fSL -o /opt/kolm/artifact.kolm "${'$'}{ARTIFACT_URL}"
    SHA=\$(sha256sum /opt/kolm/artifact.kolm | cut -d' ' -f1)
    PUB=\$(curl -s ifconfig.me)
    curl -fsS -X POST https://kolm.ai/v1/byoc/attestation \\
      -H 'content-type: application/json' \\
      -d "{\\"enroll_token\\":\\"${'$'}{ENROLL}\\",\\"public_url\\":\\"http://\${PUB}\\",\\"measurement\\":\\"sha256:\${SHA}\\",\\"target\\":\\"azure-cvm\\"}" || true
runcmd:
- ARTIFACT_URL="${'$'}{ARTIFACT_URL}" ENROLL="${'$'}{ENROLL}" /opt/kolm/boot.sh
EOF

az vm create -g "$RG" -n "$NAME" -l "$LOC" \\
  --image Canonical:0001-com-ubuntu-confidential-vm-jammy:22_04-lts-cvm:latest \\
  --size Standard_DC2as_v5 \\
  --security-type ConfidentialVM \\
  --enable-secure-boot true \\
  --enable-vtpm true \\
  --os-disk-security-encryption-type VMGuestStateOnly \\
  --custom-data cloud-init.yaml \\
  --admin-username kolmadmin --generate-ssh-keys

echo "Confidential VM \\\"$NAME\\\" created in $RG/$LOC. Boot will POST attestation to kolm.ai."
`;
}

function azureCvmGpuDeployScript(m) {
  return `#!/usr/bin/env bash
# kolm BYOC deploy - Azure Confidential VM with NVIDIA H100 Confidential GPU
# deploy_id: ${m.deploy_id}
# artifact: ${m.artifact_id}
#
# Azure documents the NCCadsH100v5-series as AMD SEV-SNP + NVIDIA H100 CVM
# with Confidential GPU. Check regional quota with: az vm list-skus --all.
set -euo pipefail
if ! command -v az >/dev/null 2>&1; then echo "az CLI required"; exit 2; fi

RG="\${RG:?set RG=<resource-group>}"
NAME="${m.name}"
LOC="\${LOC:-eastus}"
SIZE="\${AZURE_CONFIDENTIAL_GPU_SIZE:-Standard_NCC40ads_H100_v5}"

cat > cloud-init.yaml <<'EOF'
#cloud-config
write_files:
- path: /opt/kolm/boot.sh
  permissions: '0755'
  content: |
${indentBlock(gpuNrasBootScript(m, 'azure-cvm-gpu'), 4)}
runcmd:
- /opt/kolm/boot.sh
EOF

az vm create -g "$RG" -n "$NAME" -l "$LOC" \\
  --image Canonical:0001-com-ubuntu-confidential-vm-jammy:22_04-lts-cvm:latest \\
  --size "$SIZE" \\
  --security-type ConfidentialVM \\
  --enable-secure-boot true \\
  --enable-vtpm true \\
  --os-disk-security-encryption-type VMGuestStateOnly \\
  --custom-data cloud-init.yaml \\
  --admin-username kolmadmin --generate-ssh-keys

echo "Confidential GPU VM \\\"$NAME\\\" created in $RG/$LOC. Boot will capture NVIDIA GPU evidence and POST to kolm.ai."
`;
}

function dockerDeployScript(m) {
  return `#!/usr/bin/env bash
# kolm BYOC deploy - generic Docker host
# deploy_id: ${m.deploy_id}
# artifact: ${m.artifact_id}
set -euo pipefail

ENROLL="${m.enroll_token}"
ARTIFACT_URL="https://kolm.ai/v1/artifacts/${m.artifact_id}/download"

mkdir -p /opt/kolm
curl -fSL -o /opt/kolm/artifact.kolm "$ARTIFACT_URL"
SHA=$(sha256sum /opt/kolm/artifact.kolm | cut -d' ' -f1)

cat > /opt/kolm/Dockerfile <<EOF
FROM node:20-alpine
WORKDIR /app
COPY artifact.kolm /app/artifact.kolm
RUN apk add --no-cache curl
EXPOSE 8080
CMD ["node","-e","require('http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,artifact:'$SHA'}))}).listen(8080)"]
EOF

docker build -t kolm-byoc:${m.deploy_id.slice(-8)} /opt/kolm
docker run -d --restart=unless-stopped -p 8080:8080 --name ${m.name} kolm-byoc:${m.deploy_id.slice(-8)}

PUB=$(curl -s ifconfig.me || echo "127.0.0.1")
curl -fsS -X POST https://kolm.ai/v1/byoc/attestation \\
  -H 'content-type: application/json' \\
  -d "{\\"enroll_token\\":\\"$ENROLL\\",\\"public_url\\":\\"http://$PUB:8080\\",\\"measurement\\":\\"sha256:$SHA\\",\\"target\\":\\"docker\\"}" || true

echo "Container running on port 8080. SHA: $SHA"
`;
}

export { TARGETS };
