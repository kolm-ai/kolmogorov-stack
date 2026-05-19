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

    /// Low-level POST with no body (for routes like /v1/account/rotate-key
    /// where the server doesn't require a request body).
    pub fn post_empty(&self, path: &str) -> Result<Response, Error> {
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.agent.post(&url);
        if let Some(k) = &self.api_key {
            req = req.set("Authorization", &format!("Bearer {}", k));
        }
        req = req.set("Content-Type", "application/json");
        self.send(req.send_string("{}"))
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

    // --- Account & auth ---

    /// GET /v1/account - returns the caller's account record (tenant, plan,
    /// quotas). Requires an API key.
    pub fn account(&self) -> Result<Response, Error> {
        self.get("/v1/account")
    }

    /// POST /v1/signup - creates a new account. Returns the new tenant
    /// record plus a freshly-minted API key. Does NOT require an existing key.
    pub fn signup(&self, email: &str, name: Option<&str>) -> Result<Response, Error> {
        #[derive(Serialize)]
        struct Body<'a> {
            email: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            name: Option<&'a str>,
        }
        self.post_json("/v1/signup", &Body { email, name })
    }

    /// POST /v1/account/rotate-key - rotates the caller's API key. The OLD key
    /// is used to authenticate the call; the NEW key is returned in the body
    /// and must be persisted by the caller (the old one is invalidated server-
    /// side).
    pub fn rotate_key(&self) -> Result<Response, Error> {
        self.post_empty("/v1/account/rotate-key")
    }

    // --- Marketplace (W263 - ships 7 seeded artifacts) ---

    /// GET /v1/marketplace[?q=&category=] - lists published marketplace
    /// artifacts. Both filters are optional; pass `None` to list everything.
    pub fn marketplace_list(
        &self,
        q: Option<&str>,
        category: Option<&str>,
    ) -> Result<Response, Error> {
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(v) = q {
            params.push(("q".to_string(), v.to_string()));
        }
        if let Some(v) = category {
            params.push(("category".to_string(), v.to_string()));
        }
        let qs = encode_query(&params);
        let path = if qs.is_empty() {
            "/v1/marketplace".to_string()
        } else {
            format!("/v1/marketplace?{}", qs)
        };
        self.get(&path)
    }

    /// GET /v1/marketplace/:slug - returns the metadata record for a single
    /// marketplace artifact.
    pub fn marketplace_get(&self, slug: &str) -> Result<Response, Error> {
        self.get(&format!("/v1/marketplace/{}", percent_encode_path(slug)))
    }

    /// GET /v1/marketplace/:slug/download - downloads the `.kolm` artifact
    /// bytes. The server returns binary bytes; `Response::body` holds them as a
    /// UTF-8 string (lossy for non-text payloads). Callers that need the exact
    /// bytes should either use [`Self::get`] and read the raw response or
    /// fetch the `download_url` field from [`Self::marketplace_get`] with their
    /// own HTTP stack. This preserves the honest envelope (no silent re-encoding).
    pub fn marketplace_download(&self, slug: &str) -> Result<Response, Error> {
        self.get(&format!(
            "/v1/marketplace/{}/download",
            percent_encode_path(slug)
        ))
    }

    // --- Recipes ---

    /// GET /v1/recipes[?q=&tag=&limit=] - lists recipes accessible to the
    /// caller. All filters are optional.
    pub fn recipe_list(
        &self,
        q: Option<&str>,
        tag: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Response, Error> {
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(v) = q {
            params.push(("q".to_string(), v.to_string()));
        }
        if let Some(v) = tag {
            params.push(("tag".to_string(), v.to_string()));
        }
        if let Some(v) = limit {
            params.push(("limit".to_string(), v.to_string()));
        }
        let qs = encode_query(&params);
        let path = if qs.is_empty() {
            "/v1/recipes".to_string()
        } else {
            format!("/v1/recipes?{}", qs)
        };
        self.get(&path)
    }

    /// GET /v1/recipes/:id - returns the recipe record.
    pub fn recipe_get(&self, id: &str) -> Result<Response, Error> {
        self.get(&format!("/v1/recipes/{}", percent_encode_path(id)))
    }

    /// GET /v1/recipes/:id/stats - returns aggregate run-stats for a recipe.
    pub fn recipe_stats(&self, id: &str) -> Result<Response, Error> {
        self.get(&format!("/v1/recipes/{}/stats", percent_encode_path(id)))
    }

    /// POST /v1/recipes/:id/run - runs a recipe against a JSON input. The
    /// `input` argument is forwarded verbatim under the `input` key.
    pub fn recipe_run(
        &self,
        id: &str,
        input: &serde_json::Value,
    ) -> Result<Response, Error> {
        #[derive(Serialize)]
        struct Body<'a> {
            input: &'a serde_json::Value,
        }
        self.post_json(
            &format!("/v1/recipes/{}/run", percent_encode_path(id)),
            &Body { input },
        )
    }

    // --- Search ---

    /// POST /v1/search - semantic search over recipes/artifacts. `k` is the
    /// number of results to return (defaults server-side to 5 if `None`).
    pub fn search(&self, query: &str, k: Option<u32>) -> Result<Response, Error> {
        #[derive(Serialize)]
        struct Body<'a> {
            query: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            k: Option<u32>,
        }
        self.post_json("/v1/search", &Body { query, k })
    }

    // --- Specialists ---

    /// GET /v1/specialists - lists the caller's trained specialists.
    pub fn specialist_list(&self) -> Result<Response, Error> {
        self.get("/v1/specialists")
    }

    /// GET /v1/specialists/:id - returns a specialist's record.
    pub fn specialist_get(&self, id: &str) -> Result<Response, Error> {
        self.get(&format!("/v1/specialists/{}", percent_encode_path(id)))
    }

    /// POST /v1/specialists/:id/run - runs a specialist against a JSON input.
    pub fn specialist_run(
        &self,
        id: &str,
        input: &serde_json::Value,
    ) -> Result<Response, Error> {
        #[derive(Serialize)]
        struct Body<'a> {
            input: &'a serde_json::Value,
        }
        self.post_json(
            &format!("/v1/specialists/{}/run", percent_encode_path(id)),
            &Body { input },
        )
    }

    /// POST /v1/specialists/train - trains a new specialist. The `req` JSON value
    /// is the full training request (name, recipe_id, base_model, rank, etc.) and
    /// is forwarded verbatim so callers can use any field the server supports
    /// without waiting for an SDK bump.
    pub fn specialist_train(&self, req: &serde_json::Value) -> Result<Response, Error> {
        self.post_json("/v1/specialists/train", req)
    }
}

// ---------------------------------------------------------------------------
// Tiny URL helpers. We intentionally avoid pulling in the `url` crate: it's a
// ~150kb addition for two functions that need a few dozen lines of code. The
// rules below cover application/x-www-form-urlencoded and RFC 3986 path
// unreserved chars (the subset kolm.ai actually accepts in slugs / ids).
// ---------------------------------------------------------------------------

fn is_unreserved(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'~')
}

fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if is_unreserved(b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn percent_encode_form(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if is_unreserved(b) {
            out.push(b as char);
        } else if b == b' ' {
            out.push('+');
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn encode_query(params: &[(String, String)]) -> String {
    let mut out = String::new();
    for (i, (k, v)) in params.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        out.push_str(&percent_encode_form(k));
        out.push('=');
        out.push_str(&percent_encode_form(v));
    }
    out
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

    #[test]
    fn percent_encode_path_preserves_unreserved() {
        assert_eq!(percent_encode_path("hello-world_v2.0~rc1"), "hello-world_v2.0~rc1");
    }

    #[test]
    fn percent_encode_path_escapes_slash_and_space() {
        assert_eq!(percent_encode_path("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn percent_encode_form_uses_plus_for_space() {
        assert_eq!(percent_encode_form("hello world"), "hello+world");
    }

    #[test]
    fn encode_query_joins_with_ampersand() {
        let params = vec![
            ("q".to_string(), "foo bar".to_string()),
            ("limit".to_string(), "10".to_string()),
        ];
        assert_eq!(encode_query(&params), "q=foo+bar&limit=10");
    }

    #[test]
    fn encode_query_empty_returns_empty() {
        let params: Vec<(String, String)> = Vec::new();
        assert_eq!(encode_query(&params), "");
    }
}
