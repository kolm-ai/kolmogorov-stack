// W818-1 — llama.cpp .kolm loader. Draft skeleton, not yet upstream.
//
// .KOLM ARCHIVE LAYOUT
// --------------------
// A .kolm is a deterministic zip archive with the following well-known
// entries. Bytes are produced by src/artifact.js packageArtifact() in the
// kolm.ai repo and read here in reverse:
//
//   manifest.json       — task descriptor, hashes, training stats, tier,
//                         runtime_target, base-model pointer, K-Score.
//                         Required. UTF-8 JSON object.
//   recipes.json        — deterministic recipe pack executed in a vm
//                         sandbox at runtime. Required. UTF-8 JSON object.
//   signature.sig       — HMAC chain bound to the artifact receipt OR an
//                         Ed25519 signature over the canonical receipt body.
//                         Required.
//   receipt.json        — 5-step HMAC chain, body sig, anchor list. Optional
//                         pre-W149; required for Ed25519-signed artifacts
//                         because the verifier reads the public key from
//                         receipt.json.
//   evals.json          — eval cases that ship inside the artifact. Optional.
//   model.gguf          — for the `distilled_model` artifact class, the
//                         inner GGUF byte range we hand to llama.cpp. For
//                         `rule` / `compiled_rule` classes this is a JSON
//                         pointer record only (metadata, not weights), and
//                         this loader refuses with a clear error message.
//   weights/            — sharded weights directory (kolm v1.1+). Each
//                         shard is `weights/shard_<rank>_of_<tp>.gguf`. The
//                         loader concatenates by manifest order when present.
//   lora.bin            — KOLMPACK\x01 magic + length-prefixed UTF-8 JSON
//                         behaviour pack (v0.1 'rule' artifacts) OR a real
//                         LoRA delta for the distilled_model tier. We surface
//                         the LoRA path to llama.cpp via the existing
//                         lora_adapter parameter when present.
//   index.sqlite-vec    — KOLMIDX\x01 magic + length-prefixed UTF-8 JSON
//                         lookup index (v0.1) OR a real sqlite-vec database
//                         for the retrieval tier (v0.3+). Pass-through; this
//                         loader does NOT crack open the index.
//   runtime-policy.json — declarative routing + execution policy (W709
//                         confidence-routing thresholds, W736 guardrails,
//                         W746 staleness gates). Optional. The loader
//                         surfaces the JSON to a caller-supplied callback;
//                         llama.cpp itself doesn't enforce policy.
//   attestation.json    — confidential-compute attestation report (PCCS /
//                         SNP-report / Nitro / NRAS) plus the verifier
//                         identity. Optional. The default verify hook
//                         refuses any unrecognised attestation_kind; callers
//                         that need real TEE enforcement install their own
//                         verify_attestation_cb.
//
// LOAD ORDER
// ----------
//   1. Detect: is the path a .kolm (extension OR PK\x03\x04 prefix)?
//   2. Open the zip with the already-vendored miniz.c — no new dependency.
//   3. Read manifest.json, recipes.json, signature.sig.
//   4. Call verify_signature_cb. Default implementation refuses any cert
//      not in the compile-time KOLM_TRUSTED_CERTS list. kolm-cli builds
//      override this callback with their own trust store.
//   5. If model.gguf is present, mmap its byte range and feed it to the
//      existing llama_model_load_from_file_internal.
//   6. If weights/shard_*.gguf shards are present, concatenate by manifest
//      order into a single virtual byte range and feed that.
//   7. If lora.bin holds a real LoRA delta (manifest.tier == 'lora'),
//      surface it to llama.cpp's existing lora-adapter path.
//   8. Surface manifest.runtime_target as a load-time hint; refuse loud
//      if it is not `gguf` and there is no model.gguf entry (this means
//      the artifact is a rule-tier or wasm-tier artifact and llama.cpp
//      cannot run it — caller should fall back to the kolm runtime).
//
// FAILURE MODES (all loud, never silent)
// --------------------------------------
//   - Missing manifest.json / recipes.json / signature.sig → return nullptr,
//     log "malformed .kolm: missing <entry>" to stderr.
//   - Signature verification fails → return nullptr, log the failure reason
//     from verify_signature_cb. NEVER mmap the weights.
//   - Tampered byte in weights.bin → signature chain breaks at manifest_hash
//     binding; same path as above.
//   - manifest.runtime_target != "gguf" → return nullptr, log "this artifact
//     targets <target>; use the kolm runtime (`kolm run`) instead".
//   - Attestation block present but no verify hook installed → return
//     nullptr unless KOLM_ALLOW_UNVERIFIED_ATTESTATION=1 in env.
//
// This file is the SKELETON. The full implementation lives under the
// upstream patch series; the bodies below are intentionally stubs that
// document the contract without taking on the miniz / mmap dependency in
// a draft directory.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace kolm {

// Magic prefixes inside the inner buffers. Match src/artifact.js.
static constexpr const char * PACK_MAGIC  = "KOLMPACK\x01";
static constexpr const char * INDEX_MAGIC = "KOLMIDX\x01";

// .kolm zip-archive signature (same as standard zip).
static constexpr uint8_t ZIP_MAGIC[4] = {'P', 'K', 0x03, 0x04};

// Forward decls — full bodies land with the upstream PR.
struct kolm_artifact;

// Detect whether `path` points at a .kolm. Cheap: checks extension first,
// then falls back to sniffing the first 4 bytes for the zip magic. Returns
// true even for paths that DON'T end in .kolm if the magic matches, so the
// loader works for files renamed in transit.
bool is_kolm_artifact(const char * path);

// Pluggable signature verification. Default implementation (set at link
// time inside llama.cpp) refuses unrecognised certs.
//
// Returns:
//   0 on valid signature
//  -1 on invalid signature (caller MUST refuse to load the weights)
//  -2 on "verifier not available" (no trust store; caller should refuse
//     unless KOLM_ALLOW_UNVERIFIED_SIGNATURE=1)
typedef int (*verify_signature_cb)(const std::string & manifest_json,
                                   const std::string & signature,
                                   const std::string & receipt_json);

// Pluggable attestation verification. Same return-code contract as
// verify_signature_cb. Default implementation refuses everything.
typedef int (*verify_attestation_cb)(const std::string & attestation_json,
                                     const std::string & expected_artifact_hash);

void set_verify_signature_cb(verify_signature_cb cb);
void set_verify_attestation_cb(verify_attestation_cb cb);

// Open the .kolm, verify, and return a handle. Caller frees with
// free_kolm_artifact.
kolm_artifact * open_kolm_artifact(const char * path);
void free_kolm_artifact(kolm_artifact * art);

// Read an entry by name. Returns a pointer + size into the artifact's
// in-memory zip buffer. NULL when the entry is missing.
const uint8_t * get_entry(kolm_artifact * art,
                          const char * entry_name,
                          size_t * out_size);

// Top-level entrypoint that mirrors llama_model_load_from_file's signature.
// Caller is the standard llama.cpp loader path; this function will:
//   1. open + verify the artifact,
//   2. locate model.gguf (or concatenate weights/shard_*.gguf),
//   3. re-enter llama_model_load_from_file_internal on the inner byte range.
//
// Returns nullptr on any of the failure modes documented above.
// Pseudo-declared here without llama.cpp's actual struct types so this file
// compiles standalone in the draft directory.
void * load_from_kolm(const char * path, const void * llama_model_params);

} // namespace kolm
