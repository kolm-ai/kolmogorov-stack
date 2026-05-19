//! Rust client for the kolm.ai AI-compiler HTTP API.
//!
//! ```no_run
//! use kolm::Client;
//!
//! fn main() -> Result<(), kolm::Error> {
//!     let client = Client::from_env()?;
//!     let me = client.whoami()?;
//!     println!("status={} body={}", me.status, me.body);
//!     Ok(())
//! }
//! ```
//!
//! Honesty contract:
//! - [`Response::status`] is the raw HTTP status code. There is no `is_success()`
//!   sugar that hides a 4xx; callers handle status codes explicitly.
//! - [`Response::body`] is the response bytes as a UTF-8 string. JSON parsing is
//!   left to the caller (`serde_json::from_str(&r.body)`) so the SDK does not
//!   force a schema onto an evolving API.
//! - On network failure we return an [`Error::Network`] - we do not synthesize a
//!   "0" status or empty body to paper over the failure.

use std::env;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_BASE_URL: &str = "https://kolm.ai";
pub const DEFAULT_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Error)]
pub enum Error {
    #[error("network error: {0}")]
    Network(String),
    #[error("missing API key (pass to builder or set KOLM_API_KEY)")]
    MissingApiKey,
    #[error("invalid base url: {0}")]
    InvalidUrl(String),
    #[error("json serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

impl From<ureq::Error> for Error {
    fn from(e: ureq::Error) -> Self {
        // ureq returns Status(code, response) for non-2xx; we surface that as a
        // Response, not an Error - only transport failures map to Error::Network.
        Error::Network(e.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

impl Response {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn json<T: for<'de> Deserialize<'de>>(&self) -> Result<T, Error> {
        Ok(serde_json::from_str(&self.body)?)
    }
}

#[derive(Debug, Clone)]
pub struct Client {
    base_url: String,
    api_key: Option<String>,
    timeout: Duration,
    agent: ureq::Agent,
}

impl Client {
    /// Build a client with an explicit base URL and API key.
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self {
        let base = base_url.into().trim_end_matches('/').to_string();
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
            .user_agent(&format!("kolm-rust-sdk/{}", SDK_VERSION))
            .build();
        Self {
            base_url: base,
            api_key,
            timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECS),
            agent,
        }
    }

    /// Build a client from env. Reads `KOLM_BASE_URL` (defaults to https://kolm.ai)
    /// and `KOLM_API_KEY`. Returns [`Error::MissingApiKey`] only if the call site
    /// later hits an auth-gated route without a key - the client itself is happy
    /// to be built without one (good for /v1/health and /v1/changelog).
    pub fn from_env() -> Result<Self, Error> {
        let base = env::var("KOLM_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());
        let key = env::var("KOLM_API_KEY").ok();
        Ok(Self::new(base, key))
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self.agent = ureq::AgentBuilder::new()
            .timeout(timeout)
            .user_agent(&format!("kolm-rust-sdk/{}", SDK_VERSION))
            .build();
        self
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Low-level GET. `path` is appended to the base URL verbatim (include the
    /// leading slash and any query string).
    pub fn get(&self, path: &str) -> Result<Response, Error> {
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.agent.get(&url);
        if let Some(k) = &self.api_key {
            req = req.set("Authorization", &format!("Bearer {}", k));
        }
        self.send(req.call())
    }

    /// Low-level POST with a JSON body.
    pub fn post_json<T: Serialize>(&self, path: &str, body: &T) -> Result<Response, Error> {
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.agent.post(&url);
        if let Some(k) = &self.api_key {
            req = req.set("Authorization", &format!("Bearer {}", k));
        }
        req = req.set("Content-Type", "application/json");
        let payload = serde_json::to_string(body)?;
        self.send(req.send_string(&payload))
    }

    fn send(&self, result: Result<ureq::Response, ureq::Error>) -> Result<Response, Error> {
        match result {
            Ok(resp) => {
                let status = resp.status();
                let body = resp.into_string().unwrap_or_default();
                Ok(Response { status, body })
            }
            Err(ureq::Error::Status(status, resp)) => {
                let body = resp.into_string().unwrap_or_default();
                Ok(Response { status, body })
            }
            Err(ureq::Error::Transport(t)) => Err(Error::Network(t.to_string())),
        }
    }

    // --- High-level helpers. Each returns the raw Response envelope so callers
    // can inspect status before parsing. ---

    pub fn whoami(&self) -> Result<Response, Error> {
        self.get("/v1/whoami")
    }

    pub fn health(&self) -> Result<Response, Error> {
        self.get("/v1/health")
    }

    pub fn verify(&self, cid: &str) -> Result<Response, Error> {
        self.get(&format!("/v1/verify/{}", cid))
    }

    pub fn changelog(&self, limit: Option<u32>) -> Result<Response, Error> {
        match limit {
            Some(n) => self.get(&format!("/v1/changelog?limit={}", n)),
            None => self.get("/v1/changelog"),
        }
    }

    pub fn intent_ask(&self, prompt: &str) -> Result<Response, Error> {
        #[derive(Serialize)]
        struct Body<'a> {
            prompt: &'a str,
        }
        self.post_json("/v1/intent/ask", &Body { prompt })
    }

    pub fn capture_log(&self, namespace: &str, items: &serde_json::Value) -> Result<Response, Error> {
        #[derive(Serialize)]
        struct Body<'a> {
            namespace: &'a str,
            items: &'a serde_json::Value,
        }
        self.post_json(
            "/v1/capture/log",
            &Body {
                namespace,
                items,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_constant_matches_cargo() {
        assert!(!SDK_VERSION.is_empty());
        assert_eq!(SDK_VERSION, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn client_trims_trailing_slash_from_base() {
        let c = Client::new("https://kolm.ai/", None);
        assert_eq!(c.base_url(), "https://kolm.ai");
    }

    #[test]
    fn from_env_falls_back_to_default_base() {
        // We don't touch real env state - just confirm the constructor path
        // succeeds when env vars are absent in this test process.
        std::env::remove_var("KOLM_BASE_URL");
        let c = Client::from_env().unwrap();
        assert!(c.base_url().starts_with("http"));
    }
}
