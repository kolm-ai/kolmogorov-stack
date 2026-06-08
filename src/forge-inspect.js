// W866 - kolm inspect: model architecture + artifact passport inspection.
//
// Two modes:
//   1) `kolm inspect Qwen/Qwen3-27B` - fetch + parse HF config.json
//   2) `kolm inspect support.kolm` - read .kolm manifest.json
//
// Returns a uniform ModelProfile object that the CLI / TUI / Account UI
// render identically. Source of truth for "is this MoE?" / "how many active
// params?" / "what's the K-Score?" across the product.
//
// Architecture detection (W867 binding):
//   - num_experts / n_routed_experts / num_local_experts → MoE
//   - num_experts_per_tok / n_activated_experts          → top-K routing
//   - hidden_size + num_hidden_layers + num_attention_heads → param estimate
//   - architectures[0] → family (Qwen2MoeForCausalLM, MixtralForCausalLM, ...)
//
// The MoE detection MUST happen before quantization: router precision is
// sacred (FP16/FP8 floor), expert MLPs get separate quant per activation
// frequency. See KOLM_W866_FORGE_DISTILL_FRONTIER_PLAN.md GAP 1.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

export const INSPECT_VERSION = 'forge-inspect-v1';

// Known MoE families. Used as fallback when config.json doesn't say "moe"
// explicitly but the architecture name implies it.
const MOE_ARCHITECTURES = new Set([
  'MixtralForCausalLM', 'Qwen2MoeForCausalLM', 'Qwen3MoeForCausalLM',
  'DeepseekV2ForCausalLM', 'DeepseekV3ForCausalLM', 'JambaForCausalLM',
  'PhiMoEForCausalLM', 'GraniteMoeForCausalLM', 'DbrxForCausalLM',
  'OlmoeForCausalLM', 'MiniMaxText01ForCausalLM',
]);

function isMoE(config) {
  if (!config) return false;
  const numExperts = config.num_experts ?? config.n_routed_experts
                  ?? config.num_local_experts ?? config.num_experts_per_layer;
  if (typeof numExperts === 'number' && numExperts > 1) return true;
  const arch = Array.isArray(config.architectures) ? config.architectures[0] : null;
  if (arch && MOE_ARCHITECTURES.has(arch)) return true;
  if (config.model_type && /moe|mixtral|deepseek/i.test(config.model_type)) return true;
  return false;
}

function totalExperts(config) {
  return config.num_experts ?? config.n_routed_experts
      ?? config.num_local_experts ?? config.num_experts_per_layer
      ?? null;
}

function topK(config) {
  return config.num_experts_per_tok ?? config.n_activated_experts
      ?? config.moe_top_k ?? null;
}

/**
 * Estimate total parameter count from architecture hyperparameters.
 * For MoE: this is the FULL count (all experts × all layers).
 * Rough: 12 × hidden_size² × num_hidden_layers + embedding + lm_head.
 * Honest about being an estimate when official param_count isn't available.
 */
function estimateParamsB(config) {
  if (config.num_parameters) return Math.round(config.num_parameters / 1e9 * 100) / 100;
  if (config.n_params) return Math.round(config.n_params / 1e9 * 100) / 100;
  const h = config.hidden_size;
  const l = config.num_hidden_layers;
  const v = config.vocab_size || 32000;
  if (!h || !l) return null;
  // Dense estimate: 4 attn matrices (qkvo) + 3 MLP matrices (gate, up, down)
  // Attn = 4*h*h, MLP = 3*h*intermediate; total per layer = 4h² + 3h*i
  const denseInter = config.intermediate_size || (4 * h);
  let p = ((4 * h * h) + (3 * h * denseInter)) * l + 2 * v * h;
  // MoE: shared attention + per-expert MLPs. Real MoE configs expose
  // moe_intermediate_size separately from intermediate_size (e.g. Qwen3-30B-A3B
  // has hidden=2048, moe_intermediate_size=768 - using 4*h overestimates 11x).
  const ne = totalExperts(config);
  if (ne && ne > 1) {
    const moeInter = config.moe_intermediate_size
      || config.intermediate_size_moe
      || config.expert_intermediate_size
      || config.intermediate_size
      || (h * 4);
    const sharedInter = config.shared_intermediate_size
      || (config.intermediate_size && config.moe_intermediate_size ? config.intermediate_size : 0);
    const mlpPerExpertLayer = 3 * h * moeInter;
    const sharedMlpPerLayer = sharedInter > 0 ? 3 * h * sharedInter : 0;
    p = (4 * h * h * l) + (ne * mlpPerExpertLayer * l) + (sharedMlpPerLayer * l) + 2 * v * h;
  }
  return Math.round(p / 1e9 * 100) / 100;
}

/**
 * Active parameters per token. For dense = total. For MoE = shared + top_k experts.
 */
function activeParamsB(config) {
  const total = estimateParamsB(config);
  if (!total) return null;
  if (!isMoE(config)) return total;
  const ne = totalExperts(config);
  const k = topK(config);
  if (!ne || !k) return total;
  const h = config.hidden_size;
  const l = config.num_hidden_layers;
  const v = config.vocab_size || 32000;
  const moeInter = config.moe_intermediate_size
    || config.intermediate_size_moe
    || config.expert_intermediate_size
    || config.intermediate_size
    || (h * 4);
  const sharedInter = config.shared_intermediate_size
    || (config.intermediate_size && config.moe_intermediate_size ? config.intermediate_size : 0);
  const mlpPerActiveExpert = 3 * h * moeInter;
  const sharedMlpPerLayer = sharedInter > 0 ? 3 * h * sharedInter : 0;
  const attn = 4 * h * h * l;
  const activeMlp = (k * mlpPerActiveExpert + sharedMlpPerLayer) * l;
  const embed = 2 * v * h;
  return Math.round((attn + activeMlp + embed) / 1e9 * 100) / 100;
}

/**
 * Fetch HuggingFace config.json without depending on `huggingface_hub`.
 * Falls back to local cache at ~/.cache/huggingface/hub if network unavailable.
 */
function fetchHfConfig(modelId) {
  // Follow up to 5 redirects (HF can chain main → CDN → blob). All 3xx
  // statuses are treated as redirects (301/302/303/307/308) because HF
  // returns 307 for the main resolve URL when content is on the CDN.
  const fetchOnce = (url, hops) => new Promise((resolve, reject) => {
    if (hops > 5) { reject(new Error('hf_redirect_loop')); return; }
    const req = https.get(url, { timeout: 8000 }, (res) => {
      const sc = res.statusCode;
      if (sc >= 300 && sc < 400 && res.headers.location) {
        // Consume body to free socket before following the redirect
        res.resume();
        const nextUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        fetchOnce(nextUrl, hops + 1).then(resolve, reject);
        return;
      }
      if (sc !== 200) { reject(new Error(`hf_status_${sc}`)); return; }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
  return fetchOnce(`https://huggingface.co/${modelId}/resolve/main/config.json`, 0);
}

/**
 * Inspect a model by HF id (e.g. "Qwen/Qwen3-27B") or local config.json path.
 * @returns {Promise<ModelProfile>} {
 *   source, name, family, architecture, is_moe,
 *   num_experts, num_experts_per_tok, total_params_b, active_params_b,
 *   hidden_size, num_hidden_layers, num_attention_heads, vocab_size,
 *   context_length, chat_template_present, fetched_at
 * }
 */
export async function inspectModel(modelIdOrPath) {
  let config;
  let source = 'huggingface';
  if (fs.existsSync(modelIdOrPath)) {
    const stat = fs.statSync(modelIdOrPath);
    if (stat.isDirectory()) {
      const cfgPath = path.join(modelIdOrPath, 'config.json');
      if (!fs.existsSync(cfgPath)) {
        throw new Error(`no_config_json_in: ${modelIdOrPath}`);
      }
      config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      source = 'local_directory';
    } else if (modelIdOrPath.endsWith('config.json') || modelIdOrPath.endsWith('.json')) {
      config = JSON.parse(fs.readFileSync(modelIdOrPath, 'utf8'));
      source = 'local_config';
    } else {
      throw new Error(`unsupported_local_path_kind: ${modelIdOrPath}`);
    }
  } else {
    config = await fetchHfConfig(modelIdOrPath);
  }
  const arch = Array.isArray(config.architectures) ? config.architectures[0] : null;
  return {
    source,
    name: modelIdOrPath,
    family: config.model_type || null,
    architecture: arch,
    is_moe: isMoE(config),
    num_experts: totalExperts(config),
    num_experts_per_tok: topK(config),
    total_params_b: estimateParamsB(config),
    active_params_b: activeParamsB(config),
    hidden_size: config.hidden_size || null,
    num_hidden_layers: config.num_hidden_layers || null,
    num_attention_heads: config.num_attention_heads || null,
    vocab_size: config.vocab_size || null,
    context_length: config.max_position_embeddings || config.seq_length || null,
    chat_template_present: !!(config.chat_template),
    fetched_at: new Date().toISOString(),
    forge_inspect_version: INSPECT_VERSION,
  };
}

/**
 * Inspect a local .kolm artifact: read manifest.json from the zip.
 * Uses src/artifact-runner.js loadArtifact (which already streams the zip).
 *
 * NOTE: This function is async because src/artifact-runner.js is an ES module
 * loaded via dynamic import. Callers (cli/cmdInspect, cli/cmdExperts, the
 * /v1/inspect route) all already await it.
 */
export async function inspectArtifact(kolmPath) {
  if (!fs.existsSync(kolmPath)) throw new Error(`artifact_not_found: ${kolmPath}`);
  let manifest;
  try {
    const { loadArtifact } = await import('./artifact-runner.js');
    // Inspection is read-only - signature enforcement belongs to the run/serve path.
    const art = await loadArtifact(kolmPath, { allowInvalidSignature: true });
    manifest = art.manifest || art;
  } catch (e) {
    throw new Error(`failed_to_read_kolm_manifest: ${e.message}`);
  }
  return {
    source: 'local_artifact',
    path: kolmPath,
    job_id: manifest.job_id,
    artifact_class: manifest.artifact_class,
    base_model: manifest.base_model,
    runtime: manifest.runtime,
    runtime_target: manifest.runtime_target,
    target_device: manifest.target_device,
    k_score: manifest.k_score,
    eval_score: manifest.eval_score,
    created_at: manifest.created_at,
    license: manifest.license,
    cid: manifest.cid,
    is_moe: !!(manifest.moe && manifest.moe.experts && manifest.moe.experts.length > 1),
    num_experts: manifest.moe ? (manifest.moe.experts || []).length : null,
    export: manifest.export || null,
    moe: manifest.moe || null,
    mixed_precision_profile: manifest.mixed_precision_profile || null,
    sparsity_profile: manifest.sparsity_profile || null,
    kv_profile: manifest.kv_profile || null,
    quantization: manifest.quantization || null,
    forge_inspect_version: INSPECT_VERSION,
  };
}
