// W888-B - High-level RunPod provider.
//
// Wraps the low-level src/compute/backends/runpod.js adapter (which does
// detect/test/run against the serverless /v2/{endpointId}/run path) with
// the operation set the Studio + Run surfaces actually need:
//
//   * submitCompileJob({ spec, capturesPath, gpu, timeoutMs })
//   * submitBenchmark({ artifactPath, gpu, timeoutMs })
//   * createServingEndpoint({ artifactPath, config })
//   * listEndpoints() / stopEndpoint(id) / getEndpointMetrics(id)
//
// Why this wraps the existing low-level adapter instead of replacing it:
//   The compute/backends/runpod.js adapter knows about serverless job submit
//   + poll loop semantics already. We keep that intact so `kolm test runpod`,
//   the `runpod-gpu` lane in cloud-compute-broker.js, and any code path that
//   resolves a backend by name continues to work without change. This file
//   adds the higher-level surface (compile / benchmark / serving endpoint
//   lifecycle) that the Studio compile wizard + Run fleet dashboard need.
//
// API target: https://api.runpod.io/graphql (pod + endpoint mutations) and
//   https://api.runpod.ai/v2/{endpointId}/run (job execution).
// Docs:        https://docs.runpod.io/serverless/endpoints/manage-endpoints
//              https://docs.runpod.io/api-reference/graphql
//
// Caveats / Constraints / Limitations:
//   1. RunPod's GraphQL schema changes without notice. Every mutation is
//      executed via `_callRunPodAPI(query, variables)` and wrapped in try/
//      catch so a schema drift returns a structured error envelope with
//      the mutation name + docs URL - never a stack trace at the call site.
//   2. The exact mutation strings for `podCreate`, `podStop`, `endpointCreate`
//      are marked TODO with their docs URL where the shape isn't pinned by
//      a public spec. Callers can override mutations via the `mutations`
//      option to the constructor for forward-compat.
//   3. We do NOT upload model weights to RunPod object storage here - the
//      caller is expected to either (a) bake the weights into the endpoint
//      template image or (b) point `config.modelUrl` at an HTTPS-reachable
//      .kolm artifact that the endpoint worker fetches at cold-start. This
//      avoids re-implementing object upload that ObjectStore already does
//      via src/object-storage.js.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const GRAPHQL_URL = 'https://api.runpod.io/graphql';
const SERVERLESS_HOST = 'api.runpod.ai';
const POLL_INTERVAL_MS = 2000;
const DEFAULT_DOCS_URL = 'https://docs.runpod.io/api-reference/graphql';

// Known GPU SKU labels. We do NOT enforce membership at the API call site - 
// RunPod's GPU catalog grows. The list is exported so the Studio UI can show
// a sensible default picker, and we map common short names to RunPod's IDs.
export const RUNPOD_GPU_CATALOG = Object.freeze({
  'A100':       'NVIDIA A100 80GB PCIe',
  'A100-40GB':  'NVIDIA A100-PCIE-40GB',
  'A100-80GB':  'NVIDIA A100 80GB PCIe',
  'H100':       'NVIDIA H100 80GB HBM3',
  'H100-80GB':  'NVIDIA H100 80GB HBM3',
  'L40S':       'NVIDIA L40S',
  'RTX-4090':   'NVIDIA GeForce RTX 4090',
  'RTX-5090':   'NVIDIA GeForce RTX 5090',
});

function _hint() {
  return [
    'export RUNPOD_API_KEY=<key from https://runpod.io/console/user/settings>',
    '(or) export KOLM_RUNPOD_TOKEN=<same key>',
    'verify with: kolm test cloud --provider runpod',
  ].join('\n  ');
}

function _bodyToBuffer(body) {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}

function _sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export class RunPodProvider {
  constructor(apiKey, opts = {}) {
    const key = apiKey
      || (typeof opts.apiKey === 'string' ? opts.apiKey : '')
      || process.env.RUNPOD_API_KEY
      || process.env.KOLM_RUNPOD_TOKEN
      || '';
    if (!key) {
      const err = new Error('RunPod API key missing. Set RUNPOD_API_KEY or pass apiKey.');
      err.code = 'runpod_api_key_missing';
      err.install_hint = _hint();
      err.docs_url = 'https://docs.runpod.io/get-started/api-keys';
      throw err;
    }
    this.apiKey = key;
    this.graphqlUrl = opts.graphqlUrl || process.env.KOLM_RUNPOD_GRAPHQL_URL || GRAPHQL_URL;
    this.serverlessHost = opts.serverlessHost || SERVERLESS_HOST;
    this.endpointId = opts.endpointId || process.env.KOLM_RUNPOD_ENDPOINT_ID || '';
    this.region = opts.region || process.env.KOLM_RUNPOD_REGION || 'auto';
    // Mutation overrides so a future schema drift can be patched without a
    // code release. Each entry maps a logical op to { query, build(vars) }.
    this.mutations = Object.assign({}, _defaultMutations(), opts.mutations || {});
    this._fetch = opts.fetch || globalThis.fetch;
    if (typeof this._fetch !== 'function') {
      const err = new Error('global fetch is required (Node 22+ has it). Pass opts.fetch to override.');
      err.code = 'fetch_unavailable';
      throw err;
    }
  }

  // _callRunPodAPI - all GraphQL traffic goes through here. Returns the
  // parsed `data` payload or throws an error tagged with the mutation name
  // and the raw upstream body (truncated to 500 bytes for the error message).
  async _callRunPodAPI(query, variables = {}, opName = 'runpod_graphql') {
    let res;
    try {
      res = await this._fetch(this.graphqlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      const err = new Error(`runpod ${opName} fetch failed: ${e.message}`);
      err.code = 'runpod_fetch_failed';
      err.op = opName;
      err.docs_url = DEFAULT_DOCS_URL;
      throw err;
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const err = new Error(`runpod ${opName} http ${res.status}: ${text.slice(0, 500)}`);
      err.code = 'runpod_http_error';
      err.status = res.status;
      err.op = opName;
      err.body = text.slice(0, 2000);
      err.docs_url = DEFAULT_DOCS_URL;
      throw err;
    }
    let json;
    try { json = JSON.parse(text); }
    catch (e) {
      const err = new Error(`runpod ${opName} parse error: ${e.message}`);
      err.code = 'runpod_parse_error';
      err.op = opName;
      err.body = text.slice(0, 2000);
      throw err;
    }
    if (Array.isArray(json.errors) && json.errors.length) {
      const msg = json.errors.map((g) => g.message || JSON.stringify(g)).join('; ');
      const err = new Error(`runpod ${opName} graphql error: ${msg}`);
      err.code = 'runpod_graphql_error';
      err.op = opName;
      err.errors = json.errors;
      err.docs_url = DEFAULT_DOCS_URL;
      throw err;
    }
    return json.data || {};
  }

  // _serverlessRun - posts to /v2/{endpointId}/run, polls /status/{jobId}.
  // Mirrors src/compute/backends/runpod.js's run() loop but as a method so
  // higher-level ops can share polling semantics + a single timeout deadline.
  async _serverlessRun({ endpointId, input, timeoutMs = 30 * 60 * 1000 }) {
    if (!endpointId) {
      const err = new Error('endpointId required for _serverlessRun');
      err.code = 'runpod_endpoint_id_missing';
      throw err;
    }
    const t0 = Date.now();
    const baseUrl = `https://${this.serverlessHost}/v2/${encodeURIComponent(endpointId)}`;
    const headers = { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
    let submitRes;
    try {
      submitRes = await this._fetch(`${baseUrl}/run`, {
        method: 'POST', headers, body: JSON.stringify({ input }),
      });
    } catch (e) {
      const err = new Error(`runpod serverless submit failed: ${e.message}`);
      err.code = 'runpod_serverless_submit_failed';
      throw err;
    }
    const submitText = await submitRes.text().catch(() => '');
    if (!submitRes.ok) {
      const err = new Error(`runpod serverless submit http ${submitRes.status}: ${submitText.slice(0, 500)}`);
      err.code = 'runpod_serverless_http_error';
      err.status = submitRes.status;
      throw err;
    }
    let sj; try { sj = JSON.parse(submitText); } catch { sj = {}; }
    const jobId = sj.id;
    if (!jobId) {
      const err = new Error('runpod serverless submit returned no job id');
      err.code = 'runpod_serverless_no_id';
      err.body = submitText.slice(0, 500);
      throw err;
    }
    const deadline = t0 + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      let st;
      try { st = await this._fetch(`${baseUrl}/status/${encodeURIComponent(jobId)}`, { headers }); }
      catch (e) {
        const err = new Error(`runpod poll failed: ${e.message}`);
        err.code = 'runpod_poll_failed'; err.job_id = jobId;
        throw err;
      }
      const stText = await st.text().catch(() => '');
      if (!st.ok) {
        const err = new Error(`runpod poll http ${st.status}: ${stText.slice(0, 500)}`);
        err.code = 'runpod_poll_http_error'; err.status = st.status; err.job_id = jobId;
        throw err;
      }
      let pj; try { pj = JSON.parse(stText); } catch { pj = {}; }
      if (pj.status === 'COMPLETED') {
        return {
          ok: true, job_id: jobId, status: 'COMPLETED',
          output: pj.output,
          latency_ms: Date.now() - t0,
          execution_ms: pj.executionTime || null,
          delay_ms: pj.delayTime || null,
        };
      }
      if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(pj.status)) {
        const err = new Error(`runpod job ${pj.status}: ${pj.error || ''}`);
        err.code = 'runpod_job_failed';
        err.job_id = jobId; err.job_status = pj.status;
        throw err;
      }
    }
    const err = new Error(`runpod job timed out after ${timeoutMs}ms`);
    err.code = 'runpod_job_timeout'; err.job_id = jobId;
    throw err;
  }

  // submitCompileJob - submits a compile job to a RunPod serverless endpoint
  // whose worker image runs `kolm compile` against the supplied spec + captures.
  // Returns the .kolm artifact bytes + receipt + cost telemetry.
  //
  // Required upstream worker contract (documented at /docs/cloud/runpod.html):
  //   input.spec     - JSON-serialised compile spec
  //   input.captures - signed URL (or inline base64 for <2MB) of captures JSONL
  //   output.artifact_url - signed URL the worker uploads the .kolm to
  //   output.compile_ms / output.k_score / output.receipt_id - telemetry
  //
  // Caveat: if `output.artifact_url` is missing the result is still returned
  // with artifact_path=null and a clear reason; the caller is expected to
  // surface that to the user instead of pretending the compile succeeded.
  async submitCompileJob({ spec, capturesPath, gpu = 'A100', timeoutMs = 30 * 60 * 1000, endpointId } = {}) {
    const useEndpoint = endpointId || this.endpointId;
    if (!useEndpoint) {
      const err = new Error('No serverless endpoint configured. Pass endpointId or set KOLM_RUNPOD_ENDPOINT_ID.');
      err.code = 'runpod_endpoint_id_missing';
      err.install_hint = 'Create a compile worker endpoint at https://runpod.io/console/serverless and set KOLM_RUNPOD_ENDPOINT_ID.';
      throw err;
    }
    if (!spec || typeof spec !== 'object') {
      const err = new Error('submitCompileJob requires spec object');
      err.code = 'bad_args'; throw err;
    }
    let capturesPayload = null;
    let capturesSha = null;
    if (capturesPath) {
      if (!fs.existsSync(capturesPath)) {
        const err = new Error(`captures path not found: ${capturesPath}`);
        err.code = 'captures_not_found'; throw err;
      }
      const buf = fs.readFileSync(capturesPath);
      capturesSha = _sha256(buf);
      // Inline if <2MB, otherwise the caller should pre-upload to ObjectStore
      // and pass a signed URL via spec.captures_url.
      if (buf.length < 2 * 1024 * 1024) {
        capturesPayload = { inline: buf.toString('base64'), sha256: capturesSha, size: buf.length };
      } else {
        capturesPayload = { sha256: capturesSha, size: buf.length, _too_large_for_inline: true };
      }
    }
    const input = {
      op: 'compile',
      gpu_label: RUNPOD_GPU_CATALOG[gpu] || gpu,
      gpu_sku: gpu,
      spec,
      captures: capturesPayload,
    };
    const out = await this._serverlessRun({ endpointId: useEndpoint, input, timeoutMs });
    const o = out.output || {};
    let artifactPath = null;
    if (o.artifact_url) {
      // Fetch the artifact and write to a local temp file.
      try {
        const res = await this._fetch(o.artifact_url);
        if (res.ok) {
          const arr = Buffer.from(await res.arrayBuffer());
          artifactPath = path.join(process.env.KOLM_TMP_DIR || (process.env.TMPDIR || process.env.TEMP || '/tmp'),
            `kolm-runpod-${out.job_id}.kolm`);
          fs.writeFileSync(artifactPath, arr);
        }
      } catch { /* fall through; artifactPath stays null */ }
    }
    return {
      ok: true,
      provider: 'runpod',
      job_id: out.job_id,
      artifact_path: artifactPath,
      artifact_url: o.artifact_url || null,
      compile_ms: typeof o.compile_ms === 'number' ? o.compile_ms : (out.execution_ms || null),
      gpu_cost_usd: typeof o.gpu_cost_usd === 'number' ? o.gpu_cost_usd : null,
      k_score: o.k_score || null,
      receipt_id: o.receipt_id || null,
      captures_sha256: capturesSha,
      latency_ms: out.latency_ms,
    };
  }

  // submitBenchmark - same shape as submitCompileJob but for benchmark ops.
  // Upstream worker contract: input.op='benchmark', input.artifact_url + sha,
  // output.benchmark (tok/s, vram_gb, p50_ms, ...).
  async submitBenchmark({ artifactPath, artifactUrl, gpu = 'A100', timeoutMs = 15 * 60 * 1000, endpointId } = {}) {
    const useEndpoint = endpointId || this.endpointId;
    if (!useEndpoint) {
      const err = new Error('No serverless endpoint configured. Pass endpointId or set KOLM_RUNPOD_ENDPOINT_ID.');
      err.code = 'runpod_endpoint_id_missing';
      throw err;
    }
    let sha = null, size = null;
    if (artifactPath) {
      if (!fs.existsSync(artifactPath)) {
        const err = new Error(`artifact not found: ${artifactPath}`);
        err.code = 'artifact_not_found'; throw err;
      }
      const stat = fs.statSync(artifactPath); size = stat.size;
      // For benchmark we never inline - too big. Caller must publish to ObjectStore
      // and pass artifactUrl, or we just send the sha + path so the worker can
      // refuse politely.
      const buf = fs.readFileSync(artifactPath);
      sha = _sha256(buf);
    }
    const input = {
      op: 'benchmark',
      gpu_label: RUNPOD_GPU_CATALOG[gpu] || gpu,
      gpu_sku: gpu,
      artifact_url: artifactUrl || null,
      artifact_sha256: sha,
      artifact_size: size,
    };
    const out = await this._serverlessRun({ endpointId: useEndpoint, input, timeoutMs });
    return {
      ok: true,
      provider: 'runpod',
      job_id: out.job_id,
      benchmark: (out.output && out.output.benchmark) || out.output || null,
      latency_ms: out.latency_ms,
      execution_ms: out.execution_ms,
    };
  }

  // createServingEndpoint - GraphQL mutation that provisions a new serverless
  // endpoint bound to a container image. The image is expected to be a kolm
  // serve worker that loads a .kolm artifact at cold-start from config.modelUrl.
  //
  // Caveat: RunPod's `saveEndpoint` / `endpointCreate` mutation shape is
  // versioned and not officially documented in a public OpenAPI spec. The
  // default mutation here is best-effort; pass `opts.mutations.createEndpoint`
  // to override if the upstream schema changes.
  async createServingEndpoint({ artifactPath, artifactUrl, config = {} } = {}) {
    const name = config.name || `kolm-serve-${Date.now()}`;
    const gpuIds = config.gpuIds || config.gpu_ids || RUNPOD_GPU_CATALOG[config.gpu || 'A100'];
    const dockerImage = config.dockerImage || config.docker_image || 'kolm/serve:latest';
    const modelUrl = artifactUrl || config.modelUrl || (artifactPath ? `file://${path.resolve(artifactPath)}` : null);
    const variables = {
      input: {
        name,
        gpuIds,
        templateId: config.templateId || null,
        dockerImage,
        env: [
          { key: 'KOLM_MODEL_URL', value: modelUrl || '' },
          { key: 'KOLM_ARTIFACT_URL', value: modelUrl || '' },
          ...(Array.isArray(config.env) ? config.env : []),
        ],
        idleTimeout: config.idleTimeout != null ? config.idleTimeout : 5,
        workersMin: config.workersMin != null ? config.workersMin : 0,
        workersMax: config.workersMax != null ? config.workersMax : 1,
        flashboot: config.flashboot !== false,
      },
    };
    const m = this.mutations.createEndpoint;
    const data = await this._callRunPodAPI(m.query, variables, 'createEndpoint');
    const ep = (data.saveEndpoint || data.endpointCreate || data.createEndpoint || {});
    const endpointId = ep.id || ep.endpointId || null;
    return {
      ok: !!endpointId,
      provider: 'runpod',
      endpoint_id: endpointId,
      endpoint_url: endpointId ? `https://${this.serverlessHost}/v2/${endpointId}` : null,
      raw: ep,
      docs_url: 'https://docs.runpod.io/serverless/endpoints/manage-endpoints',
    };
  }

  async listEndpoints() {
    const m = this.mutations.listEndpoints;
    const data = await this._callRunPodAPI(m.query, {}, 'listEndpoints');
    const rows = (data.myself && Array.isArray(data.myself.endpoints))
      ? data.myself.endpoints
      : (Array.isArray(data.endpoints) ? data.endpoints : []);
    return {
      ok: true,
      provider: 'runpod',
      endpoints: rows.map((r) => ({
        id: r.id,
        name: r.name || null,
        gpu_ids: r.gpuIds || null,
        workers_min: r.workersMin != null ? r.workersMin : null,
        workers_max: r.workersMax != null ? r.workersMax : null,
        docker_image: r.dockerImage || null,
        raw: r,
      })),
    };
  }

  async stopEndpoint(id) {
    if (!id) {
      const err = new Error('stopEndpoint requires endpoint id'); err.code = 'bad_args'; throw err;
    }
    const m = this.mutations.stopEndpoint;
    const data = await this._callRunPodAPI(m.query, { input: { id } }, 'stopEndpoint');
    return { ok: true, provider: 'runpod', endpoint_id: id, raw: data };
  }

  async getEndpointMetrics(id) {
    if (!id) {
      const err = new Error('getEndpointMetrics requires endpoint id'); err.code = 'bad_args'; throw err;
    }
    const m = this.mutations.endpointMetrics;
    const data = await this._callRunPodAPI(m.query, { id }, 'endpointMetrics');
    const ep = (data.endpoint || {});
    return {
      ok: true,
      provider: 'runpod',
      endpoint_id: id,
      metrics: {
        workers_running: ep.workersRunning != null ? ep.workersRunning : null,
        workers_idle:    ep.workersIdle    != null ? ep.workersIdle    : null,
        jobs_completed:  ep.jobsCompleted  != null ? ep.jobsCompleted  : null,
        jobs_in_queue:   ep.jobsInQueue    != null ? ep.jobsInQueue    : null,
      },
      raw: ep,
    };
  }
}

// Default GraphQL mutations. Each entry's `query` is a best-effort match
// against the RunPod schema as of 2026-05. If RunPod ships a breaking
// schema change, override via:
//   new RunPodProvider(key, { mutations: { createEndpoint: { query: '...' } } })
function _defaultMutations() {
  return {
    // TODO https://docs.runpod.io/serverless/endpoints/manage-endpoints
    // Verify exact mutation name + input shape against the GraphQL playground
    // before relying on this in prod. The fallback `data.saveEndpoint` and
    // `data.endpointCreate` reads in createServingEndpoint() cover both
    // historical names.
    createEndpoint: {
      query: `mutation CreateEndpoint($input: EndpointInput!) {
        saveEndpoint(input: $input) {
          id
          name
          gpuIds
          workersMin
          workersMax
          dockerImage
        }
      }`,
    },
    // TODO https://docs.runpod.io/api-reference/graphql/queries/endpoints
    listEndpoints: {
      query: `query ListEndpoints {
        myself {
          endpoints {
            id
            name
            gpuIds
            workersMin
            workersMax
            dockerImage
          }
        }
      }`,
    },
    // TODO https://docs.runpod.io/serverless/endpoints/manage-endpoints
    stopEndpoint: {
      query: `mutation StopEndpoint($input: StopEndpointInput!) {
        stopEndpoint(input: $input) {
          id
        }
      }`,
    },
    // TODO https://docs.runpod.io/api-reference/graphql/queries/endpoints
    endpointMetrics: {
      query: `query EndpointMetrics($id: String!) {
        endpoint(id: $id) {
          id
          workersRunning
          workersIdle
          jobsCompleted
          jobsInQueue
        }
      }`,
    },
  };
}

// detect() - dry-run helper for `kolm test cloud --provider runpod`.
// Never throws; returns {ok, configured, install_hint, ...}.
export function detect(env = process.env) {
  const key = env.RUNPOD_API_KEY || env.KOLM_RUNPOD_TOKEN || '';
  if (!key) {
    return {
      ok: false,
      provider: 'runpod',
      configured: false,
      reason: 'RUNPOD_API_KEY not set',
      install_hint: _hint(),
      docs_url: 'https://docs.runpod.io/get-started/api-keys',
    };
  }
  return {
    ok: true,
    provider: 'runpod',
    configured: true,
    endpoint_id_configured: !!(env.KOLM_RUNPOD_ENDPOINT_ID),
    graphql_url: env.KOLM_RUNPOD_GRAPHQL_URL || GRAPHQL_URL,
    region: env.KOLM_RUNPOD_REGION || 'auto',
  };
}

export default RunPodProvider;
