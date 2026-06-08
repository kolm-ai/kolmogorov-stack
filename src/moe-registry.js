// S-7 - Known Mixture-of-Experts model families + their topology defaults.
//
// The registry encodes the canonical sparse-MoE topology numbers that ship in
// each family's published config.json so callers (detectMoE in moe-support.js,
// recommendQuantPolicy, the `kolm experts inspect` CLI verb) can fall back to
// vendor-blessed defaults when:
//
//   - the user passes only a family id (e.g. `kolm experts inspect mixtral-8x7b`)
//     instead of a config.json on disk,
//   - the config.json is missing one of the topology fields (older HF mirrors
//     sometimes omit `num_experts_per_tok` even though the architecture
//     hard-codes top-2), or
//   - we are estimating VRAM / DRAM footprint before download.
//
// Caveats:
//   - `expert_size_b` is the per-expert MLP parameter count expressed in
//     billions, NOT the model's total parameter count. For dense-MoE hybrids
//     like Llama 4 Maverick the published "total" includes the dense
//     attention path and is therefore larger than `experts * expert_size_b`.
//   - These are vendor defaults; downstream code MUST trust the artifact's
//     own config.json when one is present, and treat the registry as a
//     hint-only fallback.
//
// To add a family: append to MOE_FAMILIES (alphabetized within vendor) and
// add at least one matching `architectures[]` entry in ARCH_TO_FAMILY so
// detectMoE() can find the family from a downloaded checkpoint.

export const MOE_REGISTRY_VERSION = 'moe-registry-v1';

// Canonical family table. Frozen so consumers can rely on shape.
export const MOE_FAMILIES = Object.freeze({
  'mixtral-8x7b': Object.freeze({
    id: 'mixtral-8x7b',
    vendor: 'mistralai',
    display_name: 'Mixtral 8x7B',
    experts: 8,
    top_k: 2,
    expert_size_b: 7,
    shared_size_b: 0,
    router_dim: 4096,
    hidden_size: 4096,
    architectures: ['MixtralForCausalLM'],
    license: 'apache-2.0',
    notes: 'First widely-deployed sparse MoE; 47B total / 13B active per token.',
  }),
  'mixtral-8x22b': Object.freeze({
    id: 'mixtral-8x22b',
    vendor: 'mistralai',
    display_name: 'Mixtral 8x22B',
    experts: 8,
    top_k: 2,
    expert_size_b: 22,
    shared_size_b: 0,
    router_dim: 6144,
    hidden_size: 6144,
    architectures: ['MixtralForCausalLM'],
    license: 'apache-2.0',
    notes: '141B total / 39B active. Same top-2 routing as 8x7B, larger experts.',
  }),
  'qwen2-moe-a14b': Object.freeze({
    id: 'qwen2-moe-a14b',
    vendor: 'qwen',
    display_name: 'Qwen2-MoE A14B',
    experts: 64,
    top_k: 8,
    expert_size_b: 14,
    shared_size_b: 2,
    router_dim: 3584,
    hidden_size: 3584,
    architectures: ['Qwen2MoeForCausalLM'],
    license: 'apache-2.0',
    notes: 'Fine-grained MoE: 64 small experts, top-8 active + shared expert layer.',
  }),
  'qwen3-moe-a3b': Object.freeze({
    id: 'qwen3-moe-a3b',
    vendor: 'qwen',
    display_name: 'Qwen3-MoE A3B',
    experts: 128,
    top_k: 8,
    expert_size_b: 3,
    shared_size_b: 0,
    router_dim: 2048,
    hidden_size: 2048,
    architectures: ['Qwen3MoeForCausalLM'],
    license: 'apache-2.0',
    notes: '30B total / ~3B active. moe_intermediate_size=768 (much smaller than dense).',
  }),
  'deepseek-v2-lite': Object.freeze({
    id: 'deepseek-v2-lite',
    vendor: 'deepseek',
    display_name: 'DeepSeek-V2-Lite',
    experts: 64,
    top_k: 6,
    expert_size_b: 16,
    shared_size_b: 2,
    router_dim: 2048,
    hidden_size: 2048,
    architectures: ['DeepseekV2ForCausalLM'],
    license: 'deepseek',
    notes: '15.7B total / 2.4B active. DeepSeekMoE topology with shared + routed experts.',
  }),
  'deepseek-v3': Object.freeze({
    id: 'deepseek-v3',
    vendor: 'deepseek',
    display_name: 'DeepSeek-V3',
    experts: 256,
    top_k: 8,
    expert_size_b: 671,
    shared_size_b: 13,
    router_dim: 7168,
    hidden_size: 7168,
    architectures: ['DeepseekV3ForCausalLM'],
    license: 'deepseek',
    notes: '671B total / 37B active. expert_size_b here means the total-params budget the family targets, not per-expert.',
  }),
  'llama4-maverick': Object.freeze({
    id: 'llama4-maverick',
    vendor: 'meta',
    display_name: 'Llama 4 Maverick',
    experts: 16,
    top_k: 4,
    expert_size_b: 109,
    shared_size_b: 17,
    router_dim: 5120,
    hidden_size: 5120,
    architectures: ['Llama4ForCausalLM', 'Llama4ForConditionalGeneration'],
    license: 'llama-4',
    notes: 'Dense-MoE hybrid: 17B dense path always-on + 16 experts top-4 routed.',
  }),
});

// Architecture -> family id lookup. detectMoE uses this when reading a
// downloaded checkpoint's config.architectures[0].
//
// Multiple families can share an architecture string (Mixtral 8x7B and
// Mixtral 8x22B both report `MixtralForCausalLM`). The mapping prefers the
// SMALLER / more-common variant as the fallback - callers who care about
// the exact size will read `num_experts` / `hidden_size` from config.json
// and pin the precise family themselves. This default behavior matches
// what most users mean by "I have a Mixtral".
const _ARCH_PRIORITY = Object.freeze({
  MixtralForCausalLM: 'mixtral-8x7b',
});

export const ARCH_TO_FAMILY = Object.freeze((() => {
  const out = {};
  for (const [fid, fam] of Object.entries(MOE_FAMILIES)) {
    for (const a of (fam.architectures || [])) {
      // First-write-wins, but the priority table forces specific defaults.
      if (_ARCH_PRIORITY[a]) {
        out[a] = _ARCH_PRIORITY[a];
      } else if (!(a in out)) {
        out[a] = fid;
      }
    }
  }
  return out;
})());

/**
 * Resolve a family by id. Returns the frozen family record, or null if unknown.
 * @param {string} id e.g. 'mixtral-8x7b'
 */
export function getFamily(id) {
  if (!id || typeof id !== 'string') return null;
  const key = id.trim().toLowerCase();
  return MOE_FAMILIES[key] || null;
}

/**
 * List every known family. Returns a plain array (not the frozen object) so
 * callers can sort/filter without mutating the registry.
 */
export function listFamilies() {
  return Object.values(MOE_FAMILIES).map((f) => ({ ...f }));
}

/**
 * Look up a family from a HF architecture string (e.g. 'MixtralForCausalLM').
 * Returns the family record or null. Useful inside detectMoE when only the
 * architectures[] field is available.
 */
export function familyForArchitecture(arch) {
  if (!arch || typeof arch !== 'string') return null;
  const fid = ARCH_TO_FAMILY[arch];
  return fid ? MOE_FAMILIES[fid] : null;
}

export default {
  MOE_REGISTRY_VERSION,
  MOE_FAMILIES,
  ARCH_TO_FAMILY,
  getFamily,
  listFamilies,
  familyForArchitecture,
};
