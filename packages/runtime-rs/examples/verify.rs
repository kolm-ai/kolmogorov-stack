//! Example: load a `.kolm` file and verify it against a tenant receipt secret.
//!
//! Usage:
//!
//! ```text
//! KOLM_SECRET=kolm-public-fixture-v0-1-0 \
//!   cargo run --example verify -- path/to/foo.kolm --json
//! ```
//!
//! This is intentionally close to the production verifier contract: it avoids
//! literal secrets in argv, bounds the artifact before reading, uses explicit
//! zip extraction limits, and emits structured per-check results.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use kolm_runtime::zip_reader::ZipReadLimits;
use kolm_runtime::Artifact;

const VERIFY_EXAMPLE_CONTRACT_VERSION: &str = "w928-runtime-rs-example-v1";
const DEFAULT_SECRET_ENV: &str = "KOLM_SECRET";
const FIXTURE_SECRET: &str = "kolm-public-fixture-v0-1-0";
const DEFAULT_MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SECRET_BYTES: usize = 4096;
const MAX_ZIP_ENTRIES: usize = 64;

#[derive(Debug)]
struct Config {
    path: PathBuf,
    secret_env: String,
    json: bool,
    max_bytes: u64,
}

fn main() -> ExitCode {
    let config = match parse_args() {
        Ok(Some(config)) => config,
        Ok(None) => return ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{}", message);
            print_usage();
            return ExitCode::from(2);
        }
    };

    let secret = match read_secret(&config.secret_env) {
        Ok(secret) => secret,
        Err(message) => {
            eprintln!("{}", message);
            return ExitCode::from(2);
        }
    };

    let bytes = match read_bounded(&config.path, config.max_bytes) {
        Ok(bytes) => bytes,
        Err(message) => {
            emit_load_failure(config.json, &config, "read_failed", &message);
            return ExitCode::from(1);
        }
    };

    let limits = ZipReadLimits {
        max_entries: MAX_ZIP_ENTRIES,
        max_entry_bytes: config.max_bytes.min(DEFAULT_MAX_ARTIFACT_BYTES),
        max_total_bytes: config.max_bytes,
    };
    let artifact = match Artifact::load_from_bytes_with_limits(&bytes, limits) {
        Ok(artifact) => artifact,
        Err(error) => {
            emit_load_failure(config.json, &config, classify_load_error(&error), "");
            return ExitCode::from(1);
        }
    };

    let report = artifact.verify_report(&secret);
    if config.json {
        let mut value = serde_json::to_value(&report).unwrap_or(serde_json::Value::Null);
        if let Some(obj) = value.as_object_mut() {
            obj.insert("path".into(), serde_json::Value::String(display_path(&config.path)));
            obj.insert(
                "contract_version".into(),
                serde_json::Value::String(VERIFY_EXAMPLE_CONTRACT_VERSION.to_string()),
            );
            obj.insert(
                "max_artifact_bytes".into(),
                serde_json::Value::Number(config.max_bytes.into()),
            );
        }
        println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default());
    } else {
        println!("contract: {}", VERIFY_EXAMPLE_CONTRACT_VERSION);
        println!("path:     {}", display_path(&config.path));
        println!("cid:      {}", artifact.cid());
        println!("job_id:   {}", artifact.manifest().job_id);
        println!("tier:     {}", artifact.manifest().tier);
        if let Some(k) = &artifact.manifest().k_score {
            println!("k-score:  {:.4}  ships={}", k.composite, k.ships);
        }
        println!();
        println!("verification report:");
        println!("  cid                  {}", fmt(report.cid.ok, &report.cid.reason));
        println!(
            "  body_hashes          {}",
            fmt(report.body_hashes.ok, &report.body_hashes.reason)
        );
        println!(
            "  manifest_signature   {}",
            fmt(
                report.manifest_signature.ok,
                &report.manifest_signature.reason
            )
        );
        println!(
            "  receipt_chain        {}",
            fmt(report.receipt_chain.ok, &report.receipt_chain.reason)
        );
        println!(
            "  receipt_body         {}",
            fmt(report.receipt_body.ok, &report.receipt_body.reason)
        );
        println!(
            "  tofu_pin             {}",
            fmt(report.tofu_pin.ok, &report.tofu_pin.reason)
        );
        println!();
        println!("overall: {}", if report.ok { "OK" } else { "FAILED" });
    }

    if report.ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn parse_args() -> Result<Option<Config>, String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_usage();
        return Ok(None);
    }
    if args.is_empty() {
        return Err("missing path argument".to_string());
    }

    let mut path: Option<PathBuf> = None;
    let mut secret_env = DEFAULT_SECRET_ENV.to_string();
    let mut json = false;
    let mut max_bytes = DEFAULT_MAX_ARTIFACT_BYTES;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json = true,
            "--secret-env" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "--secret-env requires a value".to_string())?;
                if !valid_env_name(value) {
                    return Err("--secret-env must be a bounded environment variable name".to_string());
                }
                secret_env = value.clone();
            }
            "--max-bytes" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "--max-bytes requires a value".to_string())?;
                max_bytes = parse_max_bytes(value)?;
            }
            other => {
                if other.starts_with("--") {
                    return Err(format!("unknown flag: {}", other));
                }
                if path.is_some() {
                    return Err("only one path argument is supported".to_string());
                }
                path = Some(PathBuf::from(other));
            }
        }
        i += 1;
    }

    Ok(Some(Config {
        path: path.ok_or_else(|| "missing path argument".to_string())?,
        secret_env,
        json,
        max_bytes,
    }))
}

fn parse_max_bytes(value: &str) -> Result<u64, String> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| "--max-bytes must be an integer byte count".to_string())?;
    if parsed == 0 || parsed > MAX_ARTIFACT_BYTES {
        return Err(format!(
            "--max-bytes must be between 1 and {}",
            MAX_ARTIFACT_BYTES
        ));
    }
    Ok(parsed)
}

fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn read_secret(env_name: &str) -> Result<String, String> {
    match env::var(env_name) {
        Ok(secret) if secret.is_empty() => Err(format!("env var {} is empty", env_name)),
        Ok(secret) if secret.len() > MAX_SECRET_BYTES => {
            Err(format!("env var {} exceeds secret size limit", env_name))
        }
        Ok(secret) => Ok(secret),
        Err(_) if env_name == DEFAULT_SECRET_ENV => Ok(FIXTURE_SECRET.to_string()),
        Err(_) => Err(format!("env var {} is not set", env_name)),
    }
}

fn read_bounded(path: &PathBuf, max_bytes: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|_| "artifact path is not readable".to_string())?;
    if !metadata.is_file() {
        return Err("artifact path is not a file".to_string());
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "artifact size {} exceeds configured limit {}",
            metadata.len(),
            max_bytes
        ));
    }
    fs::read(path).map_err(|_| "artifact read failed".to_string())
}

fn emit_load_failure(json: bool, config: &Config, code: &str, detail: &str) {
    if json {
        println!(
            "{}",
            serde_json::json!({
                "ok": false,
                "stage": "load",
                "code": code,
                "path": display_path(&config.path),
                "contract_version": VERIFY_EXAMPLE_CONTRACT_VERSION,
                "max_artifact_bytes": config.max_bytes,
            })
        );
    } else if detail.is_empty() {
        eprintln!("load failed: {}", code);
    } else {
        eprintln!("load failed: {} ({})", code, detail);
    }
}

fn classify_load_error(error: &kolm_runtime::Error) -> &'static str {
    match error {
        kolm_runtime::Error::Io(_) => "artifact_io_error",
        kolm_runtime::Error::Zip(_) => "artifact_zip_parse_failed",
        kolm_runtime::Error::MissingFile(_) => "artifact_missing_required_file",
        kolm_runtime::Error::Json(_) => "artifact_json_parse_failed",
        kolm_runtime::Error::Utf8(_) => "artifact_utf8_decode_failed",
        kolm_runtime::Error::MalformedManifest(reason) if reason.contains("limit") => {
            "artifact_resource_limit_exceeded"
        }
        kolm_runtime::Error::MalformedManifest(reason) if reason.contains("duplicate zip entry") => {
            "artifact_duplicate_zip_entry"
        }
        kolm_runtime::Error::MalformedManifest(reason) if reason.contains("unsafe zip entry") => {
            "artifact_unsafe_zip_entry"
        }
        kolm_runtime::Error::MalformedManifest(_) => "artifact_malformed_manifest",
        kolm_runtime::Error::HashMismatch(_) => "artifact_hash_mismatch",
        kolm_runtime::Error::ReceiptChainBroken(_) => "artifact_receipt_chain_broken",
        kolm_runtime::Error::SignatureMismatch(_) => "artifact_signature_mismatch",
        kolm_runtime::Error::CidMismatch(_) => "artifact_cid_mismatch",
        kolm_runtime::Error::TofuPinMismatch(_) => "artifact_tofu_pin_mismatch",
        kolm_runtime::Error::VerificationFailed(_) => "artifact_verification_failed",
    }
}

fn display_path(path: &PathBuf) -> String {
    let mut out = String::new();
    for ch in path.display().to_string().chars() {
        if out.len() >= 180 {
            out.push_str("...");
            break;
        }
        if ch.is_control() {
            out.push('?');
        } else {
            out.push(ch);
        }
    }
    out
}

fn fmt(ok: bool, reason: &str) -> String {
    if ok {
        "ok".to_string()
    } else {
        format!("FAIL ({})", reason)
    }
}

fn print_usage() {
    eprintln!(
        "verify example {}\n\
         \n\
         USAGE:\n\
         \x20   cargo run --example verify -- <path-to-.kolm> [OPTIONS]\n\
         \n\
         OPTIONS:\n\
         \x20   --secret-env <VAR>   read HMAC secret from environment variable VAR\n\
         \x20   --max-bytes <N>      maximum artifact bytes to read (default: 67108864)\n\
         \x20   --json               emit the VerifyReport as JSON\n\
         \x20   -h, --help           print this help\n\
         \n\
         ENV:\n\
         \x20   KOLM_SECRET          fallback secret when --secret-env is omitted\n\
         \n\
         EXIT CODES:\n\
         \x20   0   every check passed\n\
         \x20   1   one or more checks failed, or artifact load failed\n\
         \x20   2   usage/configuration error\n",
        VERIFY_EXAMPLE_CONTRACT_VERSION
    );
}
