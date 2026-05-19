//! Minimal example: prints the response from /v1/whoami.
//!
//! Run with: `KOLM_API_KEY=sk-... cargo run --example whoami`

fn main() -> Result<(), kolm::Error> {
    let client = kolm::Client::from_env()?;
    let r = client.whoami()?;
    println!("status={}", r.status);
    println!("{}", r.body);
    std::process::exit(if r.is_success() { 0 } else { 1 });
}
