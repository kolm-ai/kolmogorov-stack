const TARGETS = [
  {
    id: 'docker',
    label: 'Docker self-host',
    category: 'self_hosted',
    command: 'kolm cloud deploy --target docker --artifact <artifact>',
    secret_refs: ['env:KOLM_API_KEY'],
    strengths: ['runs anywhere', 'offline capable', 'simple rollback'],
    evidence: ['src/byoc.js', 'public/self-host.html'],
  },
  {
    id: 'ssh',
    label: 'Remote SSH GPU/CPU host',
    category: 'self_hosted',
    command: 'kolm cloud deploy-plan --target ssh --artifact <artifact>',
    secret_refs: ['env:KOLM_REMOTE_SSH_HOST', 'env:KOLM_REMOTE_SSH_USER'],
    strengths: ['bring your own GPU', 'airgap friendly', 'no provider lock-in'],
    evidence: ['src/platform-capabilities.js', 'cli/kolm.js'],
  },
  {
    id: 'fly',
    label: 'Fly Machines',
    category: 'managed_vm',
    command: 'kolm cloud deploy --target fly --artifact <artifact>',
    secret_refs: ['env:FLY_API_TOKEN'],
    strengths: ['global edge VM', 'fast preview deploy', 'simple public URL'],
    evidence: ['src/byoc.js', 'public/byoc.html'],
  },
  {
    id: 'aws-nitro',
    label: 'AWS Nitro Enclave',
    category: 'confidential_compute',
    command: 'kolm cloud deploy --target aws-nitro --artifact <artifact>',
    secret_refs: ['env:AWS_ACCESS_KEY_ID', 'env:AWS_SECRET_ACCESS_KEY'],
    strengths: ['confidential compute', 'enterprise IAM', 'private VPC'],
    evidence: ['src/byoc.js', 'public/research/byoc-deploy-modes.html'],
  },
  {
    id: 'gcp-cvm',
    label: 'GCP Confidential VM',
    category: 'confidential_compute',
    command: 'kolm cloud deploy --target gcp-cvm --artifact <artifact>',
    secret_refs: ['env:GOOGLE_APPLICATION_CREDENTIALS'],
    strengths: ['confidential VM', 'GCP IAM', 'regional private deploy'],
    evidence: ['src/byoc.js', 'public/research/byoc-deploy-modes.html'],
  },
  {
    id: 'azure-cvm',
    label: 'Azure Confidential VM',
    category: 'confidential_compute',
    command: 'kolm cloud deploy --target azure-cvm --artifact <artifact>',
    secret_refs: ['env:AZURE_TENANT_ID', 'env:AZURE_CLIENT_ID', 'env:AZURE_CLIENT_SECRET'],
    strengths: ['confidential VM', 'managed identity', 'enterprise procurement'],
    evidence: ['src/byoc.js', 'public/research/byoc-deploy-modes.html'],
  },
  {
    id: 'cloudflare-workers',
    label: 'Cloudflare Workers + R2',
    category: 'edge',
    command: 'kolm cloud deploy-plan --target cloudflare-workers --artifact <artifact>',
    secret_refs: ['env:CLOUDFLARE_ACCOUNT_ID', 'env:CLOUDFLARE_API_TOKEN', 'env:R2_BUCKET'],
    strengths: ['global edge', 'R2 artifact storage', 'browser/API gateway close to users'],
    evidence: ['src/platform-capabilities.js', 'public/compute.html'],
  },
  {
    id: 'vercel-edge',
    label: 'Vercel Edge',
    category: 'edge',
    command: 'kolm cloud deploy-plan --target vercel-edge --artifact <artifact>',
    secret_refs: ['env:VERCEL_TOKEN', 'env:KOLM_ARTIFACT_URL'],
    strengths: ['frontend-native deploy', 'preview URLs', 'CI hooks'],
    evidence: ['src/platform-capabilities.js', 'public/research/compute-backend-selection.html'],
  },
  {
    id: 'deno-deploy',
    label: 'Deno Deploy',
    category: 'edge',
    command: 'kolm cloud deploy-plan --target deno-deploy --artifact <artifact>',
    secret_refs: ['env:DENO_DEPLOY_TOKEN', 'env:KOLM_ARTIFACT_URL'],
    strengths: ['standards-first runtime', 'low-friction TypeScript edge', 'global points of presence'],
    evidence: ['packages/sdk-ts', 'public/runtimes.html'],
  },
  {
    id: 'runpod-gpu',
    label: 'RunPod GPU train/serve',
    category: 'gpu_cloud',
    command: 'kolm cloud train <name> --backend runpod --seeds seeds.jsonl --confirm',
    secret_refs: ['env:KOLM_RUNPOD_TOKEN'],
    strengths: ['rented GPU', 'large LoRA jobs', 'serve adapters after train'],
    evidence: ['src/platform-capabilities.js', 'cli/kolm.js'],
  },
  {
    id: 'lambda-gpu',
    label: 'Lambda Labs GPU',
    category: 'gpu_cloud',
    command: 'kolm cloud train <name> --backend lambda --seeds seeds.jsonl --confirm',
    secret_refs: ['env:KOLM_LAMBDA_API_KEY', 'env:KOLM_LAMBDA_SSH_KEY_NAME'],
    strengths: ['dedicated GPU VM', 'SSH control', 'research workloads'],
    evidence: ['src/platform-capabilities.js', 'cli/kolm.js'],
  },
  {
    id: 'together-finetune',
    label: 'Together managed fine-tune',
    category: 'managed_training',
    command: 'kolm cloud train <name> --backend together --seeds seeds.jsonl --confirm',
    secret_refs: ['env:KOLM_TOGETHER_TOKEN'],
    strengths: ['managed LoRA', 'fast launch', 'no GPU ownership'],
    evidence: ['src/platform-capabilities.js', 'cli/kolm.js'],
  },
  {
    id: 'cerebras-inference',
    label: 'Cerebras Cloud Inference (CS-3 wafer-scale)',
    category: 'managed_inference',
    command: 'kolm cloud cerebras bind --namespace <ns> --model llama3.1-8b',
    secret_refs: ['env:CEREBRAS_API_KEY'],
    strengths: ['~2,200 tok/s on 8B and ~450 tok/s on 70B', 'wafer-scale CS-3', 'OpenAI-compatible /v1/chat/completions'],
    evidence: ['src/cloud-providers/cerebras.js', 'src/device-adapters/cerebras-adapter.js'],
  },
];

function cleanArtifactId(artifactId) {
  return String(artifactId || '<artifact>').replace(/[^a-zA-Z0-9_.:/@-]/g, '-').slice(0, 180);
}

function cleanName(name) {
  return String(name || 'kolm-app').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'kolm-app';
}

function targetById(id) {
  return TARGETS.find((t) => t.id === id);
}

function artifactUrl(baseUrl, artifactId) {
  const base = String(baseUrl || 'https://kolm.ai').replace(/\/+$/, '');
  return `${base}/v1/artifacts/${encodeURIComponent(cleanArtifactId(artifactId))}/download`;
}

export function deploymentTargets() {
  return TARGETS.map((t) => ({ ...t, secret_values_included: false }));
}

export function deployButtons({ artifactId = '<artifact>', baseUrl = 'https://kolm.ai' } = {}) {
  const artifact = cleanArtifactId(artifactId);
  return TARGETS.map((t) => ({
    id: `deploy-${t.id}`,
    target: t.id,
    label: `Deploy to ${t.label}`,
    category: t.category,
    href: `${String(baseUrl).replace(/\/+$/, '')}/byoc?target=${encodeURIComponent(t.id)}&artifact=${encodeURIComponent(artifact)}`,
    command: t.command.replace('<artifact>', artifact),
    required_secret_refs: t.secret_refs.slice(),
    secret_values_included: false,
  }));
}

export function buildDeployPlan({
  target = 'docker',
  artifactId = '<artifact>',
  region = 'iad',
  name = 'kolm-app',
  baseUrl = 'https://kolm.ai',
  storage = 'customer-managed',
} = {}) {
  const row = targetById(target);
  if (!row) {
    const err = new Error(`unsupported deploy target ${JSON.stringify(target)}; choose: ${TARGETS.map((t) => t.id).join(', ')}`);
    err.code = 'bad_target';
    throw err;
  }
  const artifact = cleanArtifactId(artifactId);
  const appName = cleanName(name);
  const url = artifactUrl(baseUrl, artifact);
  const common = [
    { id: 'verify-artifact', label: 'Verify signature and manifest', command: `kolm verify ${artifact}` },
    { id: 'pull-artifact', label: 'Fetch artifact bytes from configured storage', command: `curl -fSL -o artifact.kolm ${url}` },
    { id: 'serve-artifact', label: 'Run the artifact behind the Kolm runtime', command: 'kolm serve artifact.kolm --host 0.0.0.0 --port 8080' },
    { id: 'attest', label: 'Post deploy attestation without exposing secrets', command: 'kolm attest --artifact artifact.kolm --target ' + row.id },
  ];
  const targetSteps = targetSpecificSteps(row.id, { artifact, region, name: appName, baseUrl, artifactUrl: url });
  return {
    ok: true,
    spec: 'kolm-deploy-plan/1',
    target: row,
    artifact_id: artifact,
    artifact_url: url,
    name: appName,
    region,
    storage,
    required_secret_refs: row.secret_refs.slice(),
    secret_values_included: false,
    buttons: deployButtons({ artifactId: artifact, baseUrl }).filter((b) => b.target === row.id),
    steps: [...common.slice(0, 2), ...targetSteps, ...common.slice(2)],
    rollback: [
      { id: 'pin-previous-artifact', command: 'kolm artifacts diff <previous.kolm> artifact.kolm' },
      { id: 'redeploy-previous', command: row.command.replace('<artifact>', '<previous-artifact>') },
    ],
    observability: [
      'emit OTEL spans when KOLM_OTEL=1',
      'write deploy receipt and attestation row',
      'keep secret refs as references; never bake values into artifacts',
    ],
  };
}

function targetSpecificSteps(target, ctx) {
  if (target === 'docker') {
    return [
      { id: 'docker-build', label: 'Build local runtime container', command: `docker build -t ${ctx.name}:kolm .` },
      { id: 'docker-run', label: 'Run with env-secret references mounted at runtime', command: `docker run --rm -p 8080:8080 --env-file .env ${ctx.name}:kolm` },
    ];
  }
  if (target === 'ssh') {
    return [
      { id: 'ssh-copy', label: 'Copy artifact to remote host', command: `scp artifact.kolm "$KOLM_REMOTE_SSH_USER@$KOLM_REMOTE_SSH_HOST:~/artifact.kolm"` },
      { id: 'ssh-run', label: 'Start remote runtime', command: 'ssh "$KOLM_REMOTE_SSH_USER@$KOLM_REMOTE_SSH_HOST" "kolm serve ~/artifact.kolm --host 0.0.0.0 --port 8080"' },
    ];
  }
  if (target === 'cloudflare-workers') {
    return [
      { id: 'r2-upload', label: 'Upload artifact to R2', command: `wrangler r2 object put "$R2_BUCKET/${ctx.artifact}.kolm" --file artifact.kolm` },
      { id: 'workers-deploy', label: 'Deploy worker gateway', command: 'wrangler deploy --var KOLM_ARTIFACT_R2_KEY:' + `${ctx.artifact}.kolm` },
    ];
  }
  if (target === 'vercel-edge') {
    return [
      { id: 'vercel-env', label: 'Set artifact URL for preview and production', command: `vercel env add KOLM_ARTIFACT_URL production <<< "${ctx.artifactUrl}"` },
      { id: 'vercel-deploy', label: 'Deploy edge runtime', command: 'vercel deploy --prod' },
    ];
  }
  if (target === 'deno-deploy') {
    return [
      { id: 'deno-secret', label: 'Set artifact URL secret', command: `deployctl secrets put KOLM_ARTIFACT_URL "${ctx.artifactUrl}"` },
      { id: 'deno-deploy', label: 'Deploy Deno runtime', command: 'deployctl deploy --project=kolm-runtime main.ts' },
    ];
  }
  if (target === 'fly') {
    return [
      { id: 'fly-app', label: 'Create Fly app', command: `flyctl apps create ${ctx.name} --org personal || true` },
      { id: 'fly-deploy', label: 'Deploy Fly Machine runtime', command: `kolm cloud deploy --target fly --artifact ${ctx.artifact} --region ${ctx.region} --name ${ctx.name}` },
    ];
  }
  if (target === 'aws-nitro') {
    return [
      { id: 'nitro-build', label: 'Build enclave image', command: 'nitro-cli build-enclave --docker-uri kolm-runtime:latest --output-file kolm.eif' },
      { id: 'nitro-run', label: 'Run enclave', command: 'nitro-cli run-enclave --eif-path kolm.eif --memory 4096 --cpu-count 2' },
    ];
  }
  if (target === 'gcp-cvm') {
    return [
      { id: 'gcloud-image', label: 'Build confidential runtime image', command: 'gcloud builds submit --tag gcr.io/$GCP_PROJECT/kolm-runtime' },
      { id: 'gcloud-vm', label: 'Create confidential VM', command: `gcloud compute instances create ${ctx.name} --confidential-compute --zone=${ctx.region}` },
    ];
  }
  if (target === 'azure-cvm') {
    return [
      { id: 'az-image', label: 'Build runtime image', command: 'az acr build --registry $AZURE_ACR --image kolm-runtime:latest .' },
      { id: 'az-vm', label: 'Create confidential VM', command: `az vm create --name ${ctx.name} --security-type ConfidentialVM --image kolm-runtime:latest` },
    ];
  }
  if (target.endsWith('-gpu') || target === 'together-finetune') {
    return [
      { id: 'quote', label: 'Quote GPU cost before spend', command: rowTrainCommand(target).replace(' --confirm', '') },
      { id: 'train', label: 'Run confirmed GPU job', command: rowTrainCommand(target) },
    ];
  }
  if (target === 'cerebras-inference') {
    return [
      { id: 'cerebras-models', label: 'Probe Cerebras catalog', command: 'kolm cloud cerebras list-models' },
      { id: 'cerebras-bind',   label: 'Bind namespace to a Cerebras model', command: `kolm cloud cerebras bind --namespace ${ctx.name} --model llama3.1-8b --artifact ${ctx.artifact}` },
      { id: 'cerebras-verify', label: 'Verify the route',                 command: `kolm cloud cerebras chat --namespace ${ctx.name} --prompt "ping"` },
    ];
  }
  return [];
}

function rowTrainCommand(target) {
  if (target === 'runpod-gpu') return 'kolm cloud train <name> --backend runpod --seeds seeds.jsonl --confirm';
  if (target === 'lambda-gpu') return 'kolm cloud train <name> --backend lambda --seeds seeds.jsonl --confirm';
  return 'kolm cloud train <name> --backend together --seeds seeds.jsonl --confirm';
}

export function deploymentMatrix() {
  const targets = deploymentTargets();
  const byCategory = {};
  for (const t of targets) {
    if (!byCategory[t.category]) byCategory[t.category] = [];
    byCategory[t.category].push(t.id);
  }
  return {
    ok: true,
    targets,
    by_category: byCategory,
    buttons: deployButtons(),
    secret_values_included: false,
  };
}

export default {
  deploymentTargets,
  deployButtons,
  buildDeployPlan,
  deploymentMatrix,
};
