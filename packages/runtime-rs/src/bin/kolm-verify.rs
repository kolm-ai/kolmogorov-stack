//! `kolm-verify` — offline verifier binary.
//!
//! Usage:
//!
//! ```text
//! kolm-verify <path-to-.kolm> [--secret KEY | --secret-env VAR] [--json]
//! ```
//!
//! Exits 0 when every verification check passes; 1 when any check fails;
//! 2 on usage error.

use std::env;
use std::process::ExitCode;

use kolm_runtime::Artifact;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 || args.iter().any(|a| a == "--help" || a == "-h") {
        print_usage();
        return ExitCode::from(if args.iter().any(|a| a == "--help" || a == "-h") {
            0
        } else {
            2
        });
    }

    let mut path: Option<String> = None;
    let mut secret_arg: Option<String> = None;
    let mut secret_env: Option<String> = None;
    let mut as_json = false;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--secret" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("--secret requires a value");
                    return ExitCode::from(2);
                }
                secret_arg = Some(args[i].clone());
            }
            "--secret-env" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("--secret-env requires a value");
                    return ExitCode::from(2);
                }
                secret_env = Some(args[i].clone());
            }
            "--json" => {
                as_json = true;
            }
            other => {
                if other.starts_with("--") {
                    eprintln!("unknown flag: {}", other);
                    return ExitCode::from(2);
                }
                if path.is_some() {
                    eprintln!("only one path argument is supported");
                    return ExitCode::from(2);
                }
                path = Some(other.to_string());
            }
        }
        i += 1;
    }

    let path = match path {
        Some(p) => p,
        None => {
            print_usage();
            return ExitCode::from(2);
        }
    };

    let secret = match (secret_arg, secret_env) {
        (Some(s), _) => s,
        (None, Some(var)) => match env::var(&var) {
            Ok(s) => s,
            Err(_) => {
                eprintln!("env var {} is not set", var);
                return ExitCode::from(2);
            }
        },
        (None, None) => env::var("KOLM_SECRET").unwrap_or_else(|_| {
            // Fall back to the public fixture secret so the binary remains
            // useful on the bundled fixtures without configuration.
            "kolm-public-fixture-v0-1-0".to_string()
        }),
    };

    let artifact = match Artifact::load_from_path(&path) {
        Ok(a) => a,
        Err(e) => {
            if as_json {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "stage": "load",
                        "error": e.to_string(),
                        "path": path,
                    })
                );
            } else {
                eprintln!("load failed: {}", e);
            }
            return ExitCode::from(1);
        }
    };

    let report = artifact.verify_report(&secret);
    if as_json {
        // Augment the report with the file path so callers piping to jq
        // can correlate multiple runs.
        let mut v = serde_json::to_value(&report).unwrap_or(serde_json::Value::Null);
        if let Some(obj) = v.as_object_mut() {
            obj.insert("path".into(), serde_json::Value::String(path.clone()));
        }
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
    } else {
        println!("path:    {}", path);
        println!("cid:     {}", artifact.cid());
        println!("job_id:  {}", artifact.manifest().job_id);
        println!("tier:    {}", artifact.manifest().tier);
        if let Some(k) = &artifact.manifest().k_score {
            println!("k-score: {:.4}  ships={}", k.composite, k.ships);
        }
        println!();
        println!("verification report:");
        println!("  cid                  {}", fmt(&report.cid.ok, &report.cid.reason));
        println!("  body_hashes          {}", fmt(&report.body_hashes.ok, &report.body_hashes.reason));
        println!("  manifest_signature   {}", fmt(&report.manifest_signature.ok, &report.manifest_signature.reason));
        println!("  receipt_chain        {}", fmt(&report.receipt_chain.ok, &report.receipt_chain.reason));
        println!("  receipt_body         {}", fmt(&report.receipt_body.ok, &report.receipt_body.reason));
        println!("  tofu_pin             {}", fmt(&report.tofu_pin.ok, &report.tofu_pin.reason));
        println!();
        println!("overall: {}", if report.ok { "OK" } else { "FAILED" });
    }

    if report.ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn fmt(ok: &bool, reason: &str) -> String {
    if *ok {
        "ok".to_string()
    } else {
        format!("FAIL ({})", reason)
    }
}

fn print_usage() {
    eprintln!(
        "kolm-verify {}\n\
         \n\
         USAGE:\n\
         \x20   kolm-verify <path-to-.kolm> [OPTIONS]\n\
         \n\
         OPTIONS:\n\
         \x20   --secret <KEY>       HMAC secret literal (insecure; prefer --secret-env)\n\
         \x20   --secret-env <VAR>   read HMAC secret from environment variable VAR\n\
         \x20   --json               emit the VerifyReport as JSON\n\
         \x20   -h, --help           print this help\n\
         \n\
         ENV:\n\
         \x20   KOLM_SECRET          fallback secret when no flag is given\n\
         \n\
         EXIT CODES:\n\
         \x20   0   every check passed\n\
         \x20   1   one or more checks failed (or load failed)\n\
         \x20   2   usage error\n",
        kolm_runtime::version()
    );
}
