//! Minimal example: walks /v1/whoami, /v1/account, and /v1/marketplace so a
//! freshly-installed SDK can verify auth, billing, and the public catalog in
//! one shot.
//!
//! Run with: `KOLM_API_KEY=sk-... cargo run --example whoami`

fn main() -> Result<(), kolm::Error> {
    let client = kolm::Client::from_env()?;

    println!("== whoami ==");
    let r = client.whoami()?;
    println!("status={}", r.status);
    println!("{}", r.body);

    println!();
    println!("== account ==");
    let r2 = client.account()?;
    println!("status={}", r2.status);
    println!("{}", r2.body);

    println!();
    println!("== marketplace (top 5) ==");
    // marketplace_list takes (q, category); pass None for both to list all.
    let r3 = client.marketplace_list(None, None)?;
    println!("status={}", r3.status);
    println!("{}", r3.body);

    // We exit 0 only if whoami succeeded - the other calls may legitimately
    // fail (e.g. free-tier account without billing) and we still want to print
    // their bodies for diagnosis.
    std::process::exit(if r.is_success() { 0 } else { 1 });
}
