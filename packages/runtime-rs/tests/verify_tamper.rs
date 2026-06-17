//! Integration tests that build a synthetic `.kolm` in-memory and exercise
//! every verification path: happy, tampered manifest, tampered adapter,
//! broken chain, wrong secret.
//!
//! No external fixtures required - the helper builds an artifact byte-for-byte
//! identical to what `src/artifact.js` produces on the Node side, so the
//! Rust verifier verifies its own output.

use hmac::{Hmac, Mac};
use kolm_runtime::{canonical_json, Artifact, Error};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Write;

type HmacSha256 = Hmac<Sha256>;

const FIXTURE_SECRET: &str = "kolm-public-fixture-v0-1-0";

fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

fn hmac_hex(secret: &[u8], body: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("hmac key");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

/// Build a synthetic `.kolm` zip with the supplied per-file bytes. The
/// manifest, signature, and receipt are reconstructed to match the byte
/// layout of `src/artifact.js`.
struct BuiltArtifact {
    zip_buf: Vec<u8>,
}

#[derive(Clone, Copy, Default)]
struct BuildKnobs {
    tamper_manifest_post_sign: bool,
    tamper_chain_hmac_index: Option<usize>,
    tamper_chain_step_name: Option<(usize, &'static str)>,
    tamper_receipt_artifact_hash: bool,
}

fn build_synthetic(
    secret: &str,
    model_pointer_bytes: &[u8],
    recipes_bytes: &[u8],
    lora_bytes: &[u8],
    index_bytes: &[u8],
    evals_bytes: &[u8],
    // Knobs the tests use to break things. When `tamper_manifest_post_sign`
    // is true, the manifest text is rewritten AFTER signing so the on-disk
    // hashes block disagrees with what the signature.sig was computed over.
    knobs: BuildKnobs,
) -> BuiltArtifact {
    let secret_bytes = secret.as_bytes();
    let hashes_value = json!({
        "model_pointer": sha256_hex(model_pointer_bytes),
        "recipes_json":  sha256_hex(recipes_bytes),
        "lora_bin":      sha256_hex(lora_bytes),
        "index_bin":     sha256_hex(index_bytes),
        "evals_json":    sha256_hex(evals_bytes),
    });
    // Compute CID over the (possibly tampered) hashes block.
    let cid_input = json!({
        "digest": "sha256",
        "parts": hashes_value.clone(),
    });
    let cid_digest = sha256_hex(canonical_json(&cid_input).as_bytes());
    let cid = format!("cidv1:sha256:{}", cid_digest);

    // Manifest body - order matches src/artifact.js so the JSON.stringify
    // text we serialize is byte-stable.
    let manifest = json!({
        "spec": "kolm-1",
        "job_id": "job_test_synthetic",
        "task": "spam-detect",
        "created_at": "2026-05-14T00:00:00.000Z",
        "runtime": "cloud",
        "base_model": "qwen2.5-coder-7b-instruct-q4_0",
        "tier": "recipe",
        "judge_id": "kolm-pattern-synth-1",
        "eval_score": 0.95,
        "recipes": {
            "n": 1,
            "registry_hash": sha256_hex(canonical_json(&json!([
                { "id": "r_test", "hash": "0".repeat(64) }
            ])).as_bytes()),
        },
        "lora": null,
        "recall": null,
        "training": { "distilled_pairs": 0, "accuracy": null },
        "evals": {
            "n": 0,
            "spec": "rs-1-evals",
            "hash": sha256_hex(evals_bytes),
        },
        "k_score": null,
        "cid": cid,
        "hashes": hashes_value,
    });
    let manifest_text_signed = serde_json::to_string_pretty(&manifest).unwrap();
    let manifest_hash = sha256_hex(manifest_text_signed.as_bytes());
    // Post-sign tampering: corrupt the manifest text on disk by swapping the
    // task field after we have already hashed and signed the original. The
    // signature was computed over manifest_text_signed; the bytes the
    // verifier actually sees are manifest_text_on_disk.
    let manifest_text_on_disk = if knobs.tamper_manifest_post_sign {
        manifest_text_signed.replace("\"task\": \"spam-detect\"", "\"task\": \"different-task\"")
    } else {
        manifest_text_signed.clone()
    };
    let eval_set_hash = sha256_hex(evals_bytes);

    // artifact_hash - mirror of src/artifact.js construction.
    let artifact_hash_canon = canonical_json(&json!({
        "manifest_hash": manifest_hash,
        "model_pointer_hash": manifest["hashes"]["model_pointer"],
        "recipes_json_hash":  manifest["hashes"]["recipes_json"],
        "lora_bin_hash":      manifest["hashes"]["lora_bin"],
        "index_bin_hash":     manifest["hashes"]["index_bin"],
        "evals_json_hash":    eval_set_hash,
    }));
    let artifact_hash = sha256_hex(artifact_hash_canon.as_bytes());

    // 5-step chain.
    let task_hash = sha256_hex(canonical_json(&json!({ "task": "spam-detect" })).as_bytes());
    let seeds_hash = sha256_hex(
        canonical_json(&json!({ "training": { "distilled_pairs": 0, "accuracy": null } }))
            .as_bytes(),
    );
    let recipes_hash = manifest["hashes"]["recipes_json"].as_str().unwrap().to_string();

    let chain_anchors = [
        ("task", sha256_hex(canonical_json(&json!({ "spec": "kolm-1" })).as_bytes()), task_hash.clone()),
        ("seeds", task_hash.clone(), seeds_hash.clone()),
        ("recipes", seeds_hash.clone(), recipes_hash.clone()),
        ("evals", recipes_hash.clone(), eval_set_hash.clone()),
        ("package", eval_set_hash.clone(), artifact_hash.clone()),
    ];
    let chain: Vec<serde_json::Value> = chain_anchors
        .iter()
        .enumerate()
        .map(|(i, (step, input_hash, output_hash))| {
            let step = match knobs.tamper_chain_step_name {
                Some((target, replacement)) if target == i => replacement,
                _ => *step,
            };
            let body = canonical_json(&json!({
                "step": step,
                "input_hash": input_hash,
                "output_hash": output_hash,
            }));
            let mut hmac = hmac_hex(secret_bytes, body.as_bytes());
            if Some(i) == knobs.tamper_chain_hmac_index {
                // Flip a single hex character to break the HMAC.
                let mut bytes = hmac.into_bytes();
                bytes[0] = if bytes[0] == b'a' { b'b' } else { b'a' };
                hmac = String::from_utf8(bytes).unwrap();
            }
            json!({
                "step": step,
                "input_hash": input_hash,
                "output_hash": output_hash,
                "hmac": hmac,
            })
        })
        .collect();

    let receipt_artifact_hash = if knobs.tamper_receipt_artifact_hash {
        "f".repeat(64)
    } else {
        artifact_hash.clone()
    };
    let mut receipt_body = json!({
        "kolm_version": "0.1",
        "receipt_id": "11111111-1111-1111-1111-111111111111",
        "cid": cid,
        "artifact_hash": receipt_artifact_hash,
        "eval_set_hash": eval_set_hash,
        "eval_score": 0.95,
        "judge_id": "kolm-pattern-synth-1",
        "tier": "recipe",
        "chain": chain,
        "anchors": [],
        "signature_alg": "hmac-sha256",
        "signed_at": "2026-05-14T00:00:00.000Z",
        "signed_by": "kolm-dev-hmac-1",
    });
    let body_canon = canonical_json(&receipt_body);
    let body_sig = hmac_hex(secret_bytes, body_canon.as_bytes());
    receipt_body["signature"] = json!(body_sig);
    let receipt_text = serde_json::to_string_pretty(&receipt_body).unwrap();

    // Legacy signature.sig - bare + rich payload supported by the verifier.
    let sig_canon = canonical_json(&json!({
        "spec": "kolm-1",
        "manifest_hash": manifest_hash,
        "job_id": "job_test_synthetic",
        "artifact_hash": artifact_hash,
        "eval_set_hash": eval_set_hash,
        "eval_score": 0.95,
        "judge_id": "kolm-pattern-synth-1",
    }));
    let sig_hmac = hmac_hex(secret_bytes, sig_canon.as_bytes());
    let signature_text = serde_json::to_string_pretty(&json!({
        "spec": "kolm-1",
        "job_id": "job_test_synthetic",
        "manifest_hash": manifest_hash,
        "artifact_hash": artifact_hash,
        "eval_set_hash": eval_set_hash,
        "eval_score": 0.95,
        "judge_id": "kolm-pattern-synth-1",
        "hmac_alg": "HMAC-SHA256",
        "hmac": sig_hmac,
        "issued_at": "2026-05-14T00:00:00.000Z",
    }))
    .unwrap();

    // Zip it up.
    let mut zip_buf = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut zip_buf);
        let mut z = zip::ZipWriter::new(cursor);
        let opts: zip::write::SimpleFileOptions =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in [
            ("manifest.json", manifest_text_on_disk.as_bytes()),
            ("model.gguf", model_pointer_bytes),
            ("recipes.json", recipes_bytes),
            ("lora.bin", lora_bytes),
            ("index.sqlite-vec", index_bytes),
            ("evals.json", evals_bytes),
            ("signature.sig", signature_text.as_bytes()),
            ("receipt.json", receipt_text.as_bytes()),
        ] {
            z.start_file(name, opts).unwrap();
            z.write_all(bytes).unwrap();
        }
        z.finish().unwrap();
    }
    BuiltArtifact { zip_buf }
}

// SimpleFileOptions API: zip 2.1 renamed FileOptions to SimpleFileOptions.
// Field name above mirrors the zip 2.1 surface.

fn fresh_inputs() -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
    let model_pointer = serde_json::to_string_pretty(&json!({
        "spec": "kolm-1",
        "base_model": "qwen2.5-coder-7b-instruct-q4_0",
        "runtime": "cloud",
        "note": "pointer-only artifact; weights resolved on `kolm run` first launch.",
    }))
    .unwrap()
    .into_bytes();
    let recipes = serde_json::to_string_pretty(&json!({
        "spec": "rs-1",
        "n": 1,
        "recipes": [
            { "id": "r_test", "name": "echo", "source": "() => null",
              "source_hash": "0".repeat(64), "version_id": "v1", "tags": [], "schema": null }
        ],
    }))
    .unwrap()
    .into_bytes();
    let lora = vec![]; // recipe-tier: empty
    let index = vec![]; // recipe-tier: empty
    let evals = serde_json::to_string_pretty(&json!({
        "spec": "rs-1-evals",
        "n": 0,
        "cases": [],
        "notes": "synthetic test fixture",
    }))
    .unwrap()
    .into_bytes();
    (model_pointer, recipes, lora, index, evals)
}

#[test]
fn happy_path_verifies() {
    let (mp, r, l, i, e) = fresh_inputs();
    let built = build_synthetic(FIXTURE_SECRET, &mp, &r, &l, &i, &e, BuildKnobs::default());
    let artifact = Artifact::load_from_bytes(&built.zip_buf).expect("load");
    let report = artifact.verify_report(FIXTURE_SECRET);
    assert!(report.ok, "expected ok, got {:?}", report);
    assert!(report.cid.ok);
    assert!(report.manifest_signature.ok);
    assert!(report.receipt_chain.ok);
    assert!(report.receipt_body.ok);
}

#[test]
fn wrong_secret_fails_signature_and_chain() {
    let (mp, r, l, i, e) = fresh_inputs();
    let built = build_synthetic(FIXTURE_SECRET, &mp, &r, &l, &i, &e, BuildKnobs::default());
    let artifact = Artifact::load_from_bytes(&built.zip_buf).expect("load");
    let report = artifact.verify_report("not-the-secret");
    assert!(!report.ok);
    assert!(!report.manifest_signature.ok);
    assert!(!report.receipt_chain.ok);
    assert!(!report.receipt_body.ok);
}

#[test]
fn tampered_adapter_bytes_break_body_hash_check() {
    // Build a fully valid artifact, then re-zip it with `recipes.json`
    // payload bytes flipped. The manifest's hashes.recipes_json still
    // reflects the original sha256; the in-zip bytes now hash differently.
    // The body_hashes check must catch this.
    let (mp, r, l, i, e) = fresh_inputs();
    let built = build_synthetic(FIXTURE_SECRET, &mp, &r, &l, &i, &e, BuildKnobs::default());
    let tampered_recipes = b"{\"spec\":\"rs-1\",\"n\":0,\"recipes\":[]}".to_vec();
    let tampered_zip = repack_with_replacement(
        &built.zip_buf,
        "recipes.json",
        &tampered_recipes,
    );
    let artifact = Artifact::load_from_bytes(&tampered_zip).expect("load tampered zip");
    let report = artifact.verify_report(FIXTURE_SECRET);
    assert!(!report.ok, "expected overall fail; got {:?}", report);
    assert!(!report.body_hashes.ok,
            "body_hashes check should catch tampered recipes; got {:?}", report.body_hashes);
    assert!(
        report.body_hashes.reason.contains("recipes_json"),
        "expected recipes_json failure, got: {}",
        report.body_hashes.reason
    );
    // Independently: artifact_hash on the loaded artifact will diverge from
    // the receipt's artifact_hash because compute_artifact_hash reads from
    // the manifest's hashes block (not the on-disk bytes), so this remains
    // equal to receipt.artifact_hash - the body_hashes check is the
    // authoritative tamper detector.
}

/// Re-pack `zip_bytes`, replacing one entry's contents with `new_bytes`. Used
/// by the tampering tests so we don't have to reconstruct the whole bundle.
fn repack_with_replacement(zip_bytes: &[u8], target: &str, new_bytes: &[u8]) -> Vec<u8> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).expect("open zip");
    let mut out = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut out);
        let mut z = zip::ZipWriter::new(cursor);
        let opts: zip::write::SimpleFileOptions =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("entry");
            let name = entry.name().to_string();
            let mut body = Vec::new();
            use std::io::Read;
            entry.read_to_end(&mut body).expect("read");
            z.start_file(&name, opts).unwrap();
            if name == target {
                z.write_all(new_bytes).unwrap();
            } else {
                z.write_all(&body).unwrap();
            }
        }
        z.finish().expect("finish");
    }
    out
}

/// Re-pack `zip_bytes`, then append a second file with the same `target`
/// name. The loader must reject the duplicate instead of letting either copy
/// win by insertion order.
fn repack_with_duplicate_entry(zip_bytes: &[u8], target: &str) -> Vec<u8> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).expect("open zip");
    let mut out = Vec::new();
    let mut duplicate_body = None;
    {
        let cursor = std::io::Cursor::new(&mut out);
        let mut z = zip::ZipWriter::new(cursor);
        let opts: zip::write::SimpleFileOptions =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("entry");
            let name = entry.name().to_string();
            let mut body = Vec::new();
            use std::io::Read;
            entry.read_to_end(&mut body).expect("read");
            if name == target {
                duplicate_body = Some(body.clone());
            }
            z.start_file(&name, opts).unwrap();
            z.write_all(&body).unwrap();
        }
        z.start_file(target, opts).unwrap();
        z.write_all(&duplicate_body.expect("target entry present")).unwrap();
        z.finish().expect("finish");
    }
    out
}

#[test]
fn tampered_manifest_breaks_signature() {
    // Build a valid artifact then rewrite the manifest body (changing
    // `task`) post-sign. signature.sig was computed over the original text
    // so the manifest_hash recorded inside signature.sig no longer matches
    // the in-zip manifest.json bytes - manifest_signature check must fail.
    let (mp, r, l, i, e) = fresh_inputs();
    let built = build_synthetic(
        FIXTURE_SECRET,
        &mp,
        &r,
        &l,
        &i,
        &e,
        BuildKnobs {
            tamper_manifest_post_sign: true,
            ..BuildKnobs::default()
        },
    );
    let artifact = Artifact::load_from_bytes(&built.zip_buf).expect("load");
    let report = artifact.verify_report(FIXTURE_SECRET);
    assert!(!report.ok, "expected verification to fail; got {:?}", report);
    assert!(!report.manifest_signature.ok,
            "manifest_signature must fail; got {:?}", report.manifest_signature);
}

#[test]
fn broken_chain_hmac_breaks_chain() {
    let (mp, r, l, i, e) = fresh_inputs();
    let built = build_synthetic(
        FIXTURE_SECRET,
        &mp,
        &r,
        &l,
        &i,
        &e,
        BuildKnobs {
            tamper_chain_hmac_index: Some(2),
            ..BuildKnobs::default()
        },
    );
    let artifact = Artifact::load_from_bytes(&built.zip_buf).expect("load");
    let report = artifact.verify_report(FIXTURE_SECRET);
    assert!(!report.ok);
    assert!(!report.receipt_chain.ok);
    assert!(
        report.receipt_chain.reason.contains("chain[2]"),
        "expected chain[2] failure, got: {}",
        report.receipt_chain.reason
    );
}

#[test]
fn wrong_chain_step_name_breaks_chain_shape() {
    let (mp, r, l, i, e) = fresh_inputs();
    let built = build_synthetic(
        FIXTURE_SECRET,
        &mp,
        &r,
        &l,
        &i,
        &e,
        BuildKnobs {
            tamper_chain_step_name: Some((2, "weights")),
            ..BuildKnobs::default()
        },
    );
    let artifact = Artifact::load_from_bytes(&built.zip_buf).expect("load");
    let report = artifact.verify_report(FIXTURE_SECRET);
    assert!(!report.ok);
    assert!(!report.receipt_chain.ok);
    assert!(
        report.receipt_chain.reason.contains("expected step recipes"),
        "expected step-shape failure, got: {}",
        report.receipt_chain.reason
    );
}

#[test]
fn receipt_artifact_hash_mismatch_breaks_chain_shape() {
    let (mp, r, l, i, e) = fresh_inputs();
    let built = build_synthetic(
        FIXTURE_SECRET,
        &mp,
        &r,
        &l,
        &i,
        &e,
        BuildKnobs {
            tamper_receipt_artifact_hash: true,
            ..BuildKnobs::default()
        },
    );
    let artifact = Artifact::load_from_bytes(&built.zip_buf).expect("load");
    let report = artifact.verify_report(FIXTURE_SECRET);
    assert!(!report.ok);
    assert!(!report.receipt_chain.ok);
    assert!(
        report.receipt_chain.reason.contains("artifact_hash"),
        "expected artifact_hash failure, got: {}",
        report.receipt_chain.reason
    );
    assert!(report.receipt_body.ok);
}

#[test]
fn verify_method_returns_error_on_failure() {
    let (mp, r, l, i, e) = fresh_inputs();
    let built = build_synthetic(
        FIXTURE_SECRET,
        &mp,
        &r,
        &l,
        &i,
        &e,
        BuildKnobs {
            tamper_chain_hmac_index: Some(0),
            ..BuildKnobs::default()
        },
    );
    let artifact = Artifact::load_from_bytes(&built.zip_buf).expect("load");
    let err = artifact.verify(FIXTURE_SECRET).unwrap_err();
    match err {
        Error::VerificationFailed(reason) => {
            assert!(reason.contains("receipt_chain") || reason.contains("chain"));
        }
        other => panic!("expected VerificationFailed, got {:?}", other),
    }
}

#[test]
fn cid_is_stable_across_loads() {
    let (mp, r, l, i, e) = fresh_inputs();
    let built = build_synthetic(FIXTURE_SECRET, &mp, &r, &l, &i, &e, BuildKnobs::default());
    let a1 = Artifact::load_from_bytes(&built.zip_buf).expect("load");
    let a2 = Artifact::load_from_bytes(&built.zip_buf).expect("load");
    assert_eq!(a1.cid(), a2.cid());
    assert!(a1.cid().starts_with("cidv1:sha256:"));
    assert_eq!(a1.cid().len(), "cidv1:sha256:".len() + 64);
}

#[test]
fn missing_zip_entry_is_error() {
    // Build a zip that lacks signature.sig.
    let (mp, r, l, i, e) = fresh_inputs();
    let _ok = build_synthetic(FIXTURE_SECRET, &mp, &r, &l, &i, &e, BuildKnobs::default());
    let mut zip_buf = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut zip_buf);
        let mut z = zip::ZipWriter::new(cursor);
        let opts: zip::write::SimpleFileOptions =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        // Only ship manifest.json so load fails on missing signature.sig.
        z.start_file("manifest.json", opts).unwrap();
        z.write_all(b"{}").unwrap();
        z.finish().unwrap();
    }
    let err = Artifact::load_from_bytes(&zip_buf).unwrap_err();
    assert!(matches!(err, Error::Json(_) | Error::MissingFile(_) | Error::MalformedManifest(_)));
}

#[test]
fn duplicate_zip_entry_is_error() {
    let (mp, r, l, i, e) = fresh_inputs();
    let built = build_synthetic(FIXTURE_SECRET, &mp, &r, &l, &i, &e, BuildKnobs::default());
    let dup = repack_with_duplicate_entry(&built.zip_buf, "manifest.json");
    let err = Artifact::load_from_bytes(&dup).unwrap_err();
    match err {
        Error::MalformedManifest(reason) => {
            assert!(
                reason.contains("duplicate zip entry name"),
                "expected duplicate entry reason, got: {}",
                reason
            );
        }
        other => panic!("expected MalformedManifest, got {:?}", other),
    }
}

#[test]
fn invalid_zip_bytes_is_error() {
    let err = Artifact::load_from_bytes(b"not-a-zip").unwrap_err();
    match err {
        Error::Zip(_) => {}
        other => panic!("expected Zip error, got {:?}", other),
    }
}

#[test]
fn tofu_pin_then_reuse_is_ok() {
    use kolm_runtime::TrustStore;
    let (mp, r, l, i, e) = fresh_inputs();
    let built = build_synthetic(FIXTURE_SECRET, &mp, &r, &l, &i, &e, BuildKnobs::default());
    let artifact = Artifact::load_from_bytes(&built.zip_buf).expect("load");
    let mut store = TrustStore::new();
    let r1 = artifact.verify_with_store(FIXTURE_SECRET, &mut store);
    assert!(r1.ok);
    // Second verification under the same store: still ok.
    let r2 = artifact.verify_with_store(FIXTURE_SECRET, &mut store);
    assert!(r2.ok);
    assert_eq!(store.get_pinned_namespace(artifact.cid()), Some("kolm-dev-hmac-1"));
}

#[test]
fn tofu_pin_mismatch_fails() {
    use kolm_runtime::TrustStore;
    let (mp, r, l, i, e) = fresh_inputs();
    let built = build_synthetic(FIXTURE_SECRET, &mp, &r, &l, &i, &e, BuildKnobs::default());
    let artifact = Artifact::load_from_bytes(&built.zip_buf).expect("load");
    let mut store = TrustStore::new();
    // Pre-pin a different namespace.
    store.force_pin(artifact.cid(), "different-namespace");
    let report = artifact.verify_with_store(FIXTURE_SECRET, &mut store);
    assert!(!report.ok);
    assert!(!report.tofu_pin.ok);
    assert!(
        report.tofu_pin.reason.contains("tofu pin mismatch"),
        "expected tofu mismatch reason, got: {}",
        report.tofu_pin.reason
    );
}

#[test]
fn verify_report_is_json_serializable() {
    let (mp, r, l, i, e) = fresh_inputs();
    let built = build_synthetic(FIXTURE_SECRET, &mp, &r, &l, &i, &e, BuildKnobs::default());
    let artifact = Artifact::load_from_bytes(&built.zip_buf).expect("load");
    let report = artifact.verify_report(FIXTURE_SECRET);
    let j = report.to_json_pretty();
    let parsed: serde_json::Value = serde_json::from_str(&j).expect("round-trip");
    assert_eq!(parsed.get("ok"), Some(&serde_json::Value::Bool(true)));
    assert!(parsed.get("cid_value").is_some());
}
