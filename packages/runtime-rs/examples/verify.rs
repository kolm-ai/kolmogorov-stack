//! Example: load a .kolm file and verify it against a tenant receipt secret.
//!
//! Usage:
//!
//! ```text
//! KOLM_SECRET=kolm-public-fixture-v0-1-0 \
//!   cargo run --example verify -- path/to/foo.kolm
//! ```

use std::env;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: verify <path-to-.kolm>");
        return ExitCode::from(2);
    }
    let secret = env::var("KOLM_SECRET").unwrap_or_else(|_| "kolm-public-fixture-v0-1-0".to_string());

    let artifact = match kolm_runtime::Artifact::load_from_path(&args[1]) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("load failed: {}", e);
            return ExitCode::from(2);
        }
    };

    println!("loaded: {}", args[1]);
    println!("cid:     {}", artifact.cid());
    println!("job_id:  {}", artifact.manifest().job_id);
    println!("tier:    {}", artifact.manifest().tier);
    if let Some(k) = &artifact.manifest().k_score {
        println!("k-score: {:.4}  ships={}", k.composite, k.ships);
    }

    match artifact.verify(&secret) {
        Ok(()) => {
            println!("verify:  OK");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("verify:  FAILED: {}", e);
            ExitCode::from(1)
        }
    }
}
