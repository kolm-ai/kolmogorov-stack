#!/usr/bin/env node
// scripts/cloud-runpod-train.mjs
//
// Burst a training run onto a RunPod GPU pod. End-to-end:
//   1. POST to RunPod GraphQL to spin up a pod (default 1× H100-80GB).
//   2. Wait for SSH to come up (60–120s typical).
//   3. rsync the run dir up (spec.json, seeds.jsonl, training-pairs.jsonl).
//   4. SSH-run a bootstrap (clone kolmogorov-stack workers/distill, pip install,
//      then train_lora.py with the spec's hyperparams).
//   5. rsync the artifact back into the local run dir.
//   6. Terminate the pod.
//
// Requires: RUNPOD_API_KEY in env (free to create at runpod.io).
// Optional: RUNPOD_SSH_KEY (path to private key; default ~/.ssh/id_ed25519).
// Optional: RUNPOD_GPU_TYPE (default NVIDIA H100 80GB HBM3).
// Optional: RUNPOD_IMAGE (default runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04).
//
// Usage:
//   node scripts/cloud-runpod-train.mjs \
//     --run-dir=~/.kolm/distill-runs/trinity-2000-v2-2026-05-28 \
//     --student-base=Qwen/Qwen2.5-7B-Instruct \
//     --gpu=H100 \
//     --dry-run        # plan only, do not create a pod
//
// On exit: prints a JSON receipt with pod_id, gpu_seconds, cost_usd_est,
// artifact_local_path. On crash: leaves the pod running so an operator can
// SSH in and rescue; use --teardown=force to kill on error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}

function fail(msg, extra) {
  console.error('[runpod] ' + msg);
  if (extra) console.error(JSON.stringify(extra, null, 2));
  process.exit(1);
}

const RUN_DIR = args['run-dir'] && args['run-dir'].replace(/^~/, os.homedir());
if (!RUN_DIR) fail('--run-dir required (e.g. ~/.kolm/distill-runs/trinity-2000-v2-2026-05-28)');
if (!fs.existsSync(RUN_DIR)) fail(`run dir not found: ${RUN_DIR}`);

const KEY = process.env.RUNPOD_API_KEY || '';
const DRY = !!args['dry-run'];
if (!KEY && !DRY) fail('RUNPOD_API_KEY not set — get one at runpod.io/console/user/settings');

const SSH_KEY = (args['ssh-key'] || process.env.RUNPOD_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_ed25519')).replace(/^~/, os.homedir());
const GPU_TYPE = args['gpu-type'] || process.env.RUNPOD_GPU_TYPE || 'NVIDIA H100 80GB HBM3';
const IMAGE = args['image'] || process.env.RUNPOD_IMAGE || 'runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04';
const GPU_COUNT = Math.max(1, Number(args['gpu-count'] || 1));
const CONTAINER_DISK_GB = Math.max(40, Number(args['container-disk-gb'] || 80));
const VOLUME_DISK_GB = Math.max(0, Number(args['volume-disk-gb'] || 0));
const STUDENT_BASE = args['student-base'] || null;
const REPO_URL = args['repo-url'] || 'https://github.com/Kolm-ai/kolm.git';
const REPO_BRANCH = args['repo-branch'] || 'main';

const POD_NAME = args['pod-name'] || ('kolm-burst-' + Date.now().toString(36));

function gql(query, variables) {
  const body = JSON.stringify({ query, variables });
  if (DRY) {
    console.log('[runpod][dry-run] GQL:', query.replace(/\s+/g, ' ').slice(0, 200));
    return { data: { __dry: true } };
  }
  const t0 = Date.now();
  const r = spawnSync('curl', [
    '-s', '-X', 'POST',
    `https://api.runpod.io/graphql?api_key=${KEY}`,
    '-H', 'content-type: application/json',
    '-d', body,
  ], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  const dt = Date.now() - t0;
  if (r.status !== 0) fail(`curl exit ${r.status}: ${r.stderr || ''}`);
  let j;
  try { j = JSON.parse(r.stdout); } catch { fail(`GQL non-JSON response (${dt}ms): ${r.stdout.slice(0, 400)}`); }
  if (j.errors) fail(`GQL errors`, j.errors);
  return j;
}

console.log(`[runpod] plan: ${POD_NAME} ${GPU_COUNT}× ${GPU_TYPE} ${CONTAINER_DISK_GB}GB container / ${VOLUME_DISK_GB}GB volume`);
console.log(`[runpod] run dir: ${RUN_DIR}`);
console.log(`[runpod] image: ${IMAGE}`);
console.log(`[runpod] repo: ${REPO_URL}@${REPO_BRANCH}`);

const CREATE = `
mutation CreatePod($input: PodFindAndDeployOnDemandInput!) {
  podFindAndDeployOnDemand(input: $input) {
    id
    name
    machineId
    runtime { uptimeInSeconds ports { ip publicPort privatePort type } gpus { id gpuUtilPercent } }
    machine { podHostId gpuTypeId secureCloud }
  }
}
`;

const createInput = {
  cloudType: 'SECURE',
  gpuCount: GPU_COUNT,
  gpuTypeId: GPU_TYPE,
  imageName: IMAGE,
  name: POD_NAME,
  containerDiskInGb: CONTAINER_DISK_GB,
  volumeInGb: VOLUME_DISK_GB,
  ports: '22/tcp',
  startSsh: true,
  startJupyter: false,
  // Bootstrap runs as the container entrypoint args. We chain:
  // apt install rsync openssh-server, prep ssh, then idle so we can rsync in.
  dockerArgs: 'bash -lc "apt-get update && apt-get install -y rsync openssh-server git curl && service ssh start && tail -f /dev/null"',
};

if (DRY) {
  console.log('[runpod][dry-run] would create pod with input:');
  console.log(JSON.stringify(createInput, null, 2));
  process.exit(0);
}

console.log('[runpod] creating pod…');
const created = gql(CREATE, { input: createInput });
const pod = created.data.podFindAndDeployOnDemand;
if (!pod || !pod.id) fail('pod create returned no id', created);
console.log(`[runpod] pod_id=${pod.id} machine=${pod.machineId}`);

function getPod(id) {
  return gql(`
    query Pod($id: String!) {
      pod(input: { podId: $id }) {
        id name desiredStatus
        runtime { uptimeInSeconds ports { ip publicPort privatePort type isIpPublic } }
      }
    }
  `, { id });
}

console.log('[runpod] waiting for SSH (up to 5 min)…');
let sshHost = null, sshPort = null;
const t0Wait = Date.now();
while (Date.now() - t0Wait < 5 * 60 * 1000) {
  const p = getPod(pod.id);
  const ports = (p.data && p.data.pod && p.data.pod.runtime && p.data.pod.runtime.ports) || [];
  const sshPortRow = ports.find((r) => r.privatePort === 22 && r.isIpPublic);
  if (sshPortRow) {
    sshHost = sshPortRow.ip;
    sshPort = sshPortRow.publicPort;
    break;
  }
  process.stderr.write('.');
  const wait = spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { stdio: 'ignore' });
  if (wait.status !== 0) break;
}
if (!sshHost) fail('SSH port did not come up; pod may need teardown manually');
console.log(`\n[runpod] ssh ready: ${sshHost}:${sshPort}`);

function ssh(cmd, opts) {
  const o = opts || {};
  const args = [
    '-i', SSH_KEY,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=15',
    '-p', String(sshPort),
    `root@${sshHost}`,
    cmd,
  ];
  const r = spawnSync('ssh', args, { stdio: o.silent ? 'pipe' : 'inherit', encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  return r;
}

function rsync(src, dst, up) {
  const args = [
    '-az', '--progress',
    '-e', `ssh -i ${SSH_KEY} -p ${sshPort} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`,
  ];
  if (up) args.push(src, `root@${sshHost}:${dst}`);
  else args.push(`root@${sshHost}:${src}`, dst);
  const r = spawnSync('rsync', args, { stdio: 'inherit' });
  if (r.status !== 0) fail(`rsync ${up ? 'up' : 'down'} failed (status ${r.status})`);
}

// Step 1 — clone repo on pod, install deps.
console.log('[runpod] bootstrapping repo + python deps on pod…');
const setup = ssh(`set -euo pipefail
  mkdir -p /workspace
  cd /workspace
  if [ ! -d kolm ]; then git clone --depth 1 -b ${REPO_BRANCH} ${REPO_URL} kolm; fi
  cd kolm/workers/distill
  pip install -U pip setuptools wheel
  pip install -r requirements.txt || pip install torch transformers peft bitsandbytes accelerate datasets sentencepiece
  echo READY
`);
if (setup.status !== 0) fail('pod setup failed; pod is still running, teardown manually');

// Step 2 — rsync the run dir up.
const REMOTE_RUN = `/workspace/run/${path.basename(RUN_DIR)}`;
ssh(`mkdir -p ${REMOTE_RUN}`, { silent: true });
rsync(RUN_DIR.replace(/[\\/]+$/, '') + '/', REMOTE_RUN, true);

// Step 3 — drive train_lora.py via the existing distill.mjs (it picks up
// spec hyperparams + chooses multi-gpu launcher automatically).
console.log('[runpod] starting training (this is the long part)…');
const seedsFile = fs.existsSync(path.join(RUN_DIR, 'merged', 'training-pairs.jsonl'))
  ? `${REMOTE_RUN}/merged/training-pairs.jsonl`
  : `${REMOTE_RUN}/seeds.jsonl`;
const train = ssh(`set -euo pipefail
  cd /workspace/kolm
  export CUDA_VISIBLE_DEVICES=$(seq -s, 0 $((${GPU_COUNT}-1)))
  python workers/distill/scripts/train_lora.py \\
    --pairs ${seedsFile} \\
    --out ${REMOTE_RUN}/student \\
    --student-base ${STUDENT_BASE || 'Qwen/Qwen2.5-7B-Instruct'} \\
    --qlora
`);
if (train.status !== 0) fail(`training failed on pod ${pod.id}; SSH still open at ${sshHost}:${sshPort}`);

// Step 4 — rsync artifact back.
console.log('[runpod] pulling artifact back…');
rsync(`${REMOTE_RUN}/student/`, path.join(RUN_DIR, 'student-runpod') + '/', false);

// Step 5 — teardown.
console.log('[runpod] terminating pod…');
const KILL = `
mutation Terminate($input: PodTerminateInput!) {
  podTerminate(input: $input)
}
`;
gql(KILL, { input: { podId: pod.id } });

const elapsedSec = (Date.now() - t0Wait) / 1000;
const RATE_HR = {
  'NVIDIA H100 80GB HBM3': 1.99,
  'NVIDIA A100 80GB PCIe': 1.65,
  'NVIDIA RTX 4090': 0.40,
  'NVIDIA RTX 5090': 0.55,
}[GPU_TYPE] || 1.99;
const cost_est = (elapsedSec / 3600) * RATE_HR * GPU_COUNT;
const receipt = {
  pod_id: pod.id,
  pod_name: POD_NAME,
  gpu_type: GPU_TYPE,
  gpu_count: GPU_COUNT,
  elapsed_seconds: elapsedSec,
  cost_usd_est: Number(cost_est.toFixed(2)),
  artifact_local_path: path.join(RUN_DIR, 'student-runpod'),
  run_dir: RUN_DIR,
};
console.log(JSON.stringify(receipt, null, 2));
fs.writeFileSync(path.join(RUN_DIR, 'runpod-receipt.json'), JSON.stringify(receipt, null, 2));
console.log(`[runpod] done. receipt -> ${path.join(RUN_DIR, 'runpod-receipt.json')}`);
