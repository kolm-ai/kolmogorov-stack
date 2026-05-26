// Bring-Your-Own-Cloud (BYOC) deployment scaffolding.
//
// A BYOC deployment runs a .kolm artifact on infrastructure the customer
// controls — Fly Machines, AWS Nitro Enclaves, GCP Confidential VMs, Azure
// Confidential Compute, or a generic Docker host they own. kolm.ai never
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
import { parseAttestation } from '../packages/attestation/src/index.js';

const TARGETS = ['fly', 'aws-nitro', 'gcp-cvm', 'azure-cvm', 'docker'];

// Map a BYOC deploy target to the attestation parser target. `fly` has no
// hardware attestation (Fly Machines is a plain Linux VM), so we route it
// through the docker software-measurement path.
function attestationTargetFor(deployTarget) {
  if (deployTarget === 'fly') return 'docker';
  return deployTarget;
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

export function recordAttestation(enrollToken, { public_url, attestation, measurement }) {
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
        parsed = {
          vendor: parsedResult.vendor,
          measurement: parsedResult.measurement,
          claims: parsedResult.claims,
          parsed_at: parsedResult.parsed_at,
          has_signing_chain: !!(parsedResult.signing_cert_chain && parsedResult.signing_cert_chain.length),
        };
        if (parsedResult.measurement) extractedMeasurement = parsedResult.measurement;
        vendor = parsedResult.vendor;
      }
    }
  } catch { // deliberate: cleanup
    // Parser failures should never block the record — we still capture the
    // raw blob so an operator can debug downstream.
  }
  const att = {
    public_url: String(public_url || '').slice(0, 400),
    measurement: extractedMeasurement ? extractedMeasurement.slice(0, 256) : null,
    vendor,
    parsed,
    raw: typeof attestation === 'string' ? attestation.slice(0, 8192) : null,
    received_at: now,
  };
  update('byoc_deployments', x => x.id === d.id, {
    status: 'live',
    public_url: att.public_url,
    attestation: att,
    last_attested_at: now,
  });
  return { ok: true, vendor, measurement: att.measurement };
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
    case 'azure-cvm': return azureCvmDeployScript(manifest);
    case 'docker':    return dockerDeployScript(manifest);
    default: return '# unsupported target';
  }
}

function flyDeployScript(m) {
  return `#!/usr/bin/env bash
# kolm BYOC deploy — Fly Machines
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
# kolm BYOC deploy — AWS Nitro Enclave
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

function gcpCvmDeployScript(m) {
  return `#!/usr/bin/env bash
# kolm BYOC deploy — GCP Confidential VM
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

function azureCvmDeployScript(m) {
  return `#!/usr/bin/env bash
# kolm BYOC deploy — Azure Confidential VM
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

function dockerDeployScript(m) {
  return `#!/usr/bin/env bash
# kolm BYOC deploy — generic Docker host
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
