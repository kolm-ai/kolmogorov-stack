//! `wasm32-unknown-unknown` bindings, gated behind the `wasm` cargo feature.
//!
//! Build with:
//!
//! ```text
//! cargo build --release --target wasm32-unknown-unknown --features wasm
//! ```
//!
//! Then run `wasm-bindgen` over the output to generate JS glue:
//!
//! ```text
//! wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/kolm_runtime.wasm
//! ```
//!
//! The browser side then consumes it as:
//!
//! ```js
//! import init, { verify_bytes } from "./pkg/kolm_runtime.js";
//! await init();
//! const report = JSON.parse(verify_bytes(new Uint8Array(kolmFileBytes), secret));
//! if (report.ok) console.log("verified");
//! ```

use crate::{Artifact, VerifyReport};
use wasm_bindgen::prelude::*;

/// Verify a `.kolm` byte buffer against `secret` and return the structured
/// [`VerifyReport`] as JSON text. Errors during load are converted into a
/// failing report so the JS caller only needs to branch on `ok`.
#[wasm_bindgen]
pub fn verify_bytes(bytes: &[u8], secret: &str) -> String {
    match Artifact::load_from_bytes(bytes) {
        Ok(a) => a.verify_report(secret).to_json_pretty(),
        Err(e) => {
            let mut r = VerifyReport::new(String::new(), String::new());
            r.ok = false;
            r.cid = crate::verify::CheckOutcome::failed(format!("load failed: {}", e));
            r.to_json_pretty()
        }
    }
}

/// Return the artifact's CID without verifying. Useful for UI previews.
#[wasm_bindgen]
pub fn cid_of(bytes: &[u8]) -> Result<String, JsError> {
    let a = Artifact::load_from_bytes(bytes).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(a.cid().to_string())
}

/// Return the crate version string.
#[wasm_bindgen]
pub fn runtime_version() -> String {
    crate::version().to_string()
}
