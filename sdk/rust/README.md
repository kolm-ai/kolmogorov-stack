# kolm Rust SDK

A small Rust client for the kolm.ai HTTP surface. Covers whoami, account, auth/signup, key rotation, the marketplace catalog, recipes, search, specialists, capture, intent, verify, changelog, and health.

## Install

```toml
[dependencies]
kolm = "0.2"
```

The crate depends only on `ureq`, `serde`, `serde_json`, and `thiserror`. No async runtime needed.

## Hello, kolm

```rust
use kolm::Client;

fn main() -> Result<(), kolm::Error> {
    let client = Client::from_env()?;     // reads KOLM_BASE_URL + KOLM_API_KEY
    let me = client.whoami()?;
    println!("status={} body={}", me.status, me.body);
    Ok(())
}
```

Run the bundled example:

```
KOLM_API_KEY=sk-... cargo run --example whoami
```

The example walks `whoami`, `account`, and `marketplace_list` in one shot so a freshly-installed SDK can verify auth, billing, and the public catalog from a single binary.

## API

```rust
pub struct Client { /* ... */ }

impl Client {
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self;
    pub fn from_env() -> Result<Self, Error>;
    pub fn with_timeout(self, timeout: Duration) -> Self;
    pub fn base_url(&self) -> &str;

    // ---------- low-level ----------
    pub fn get(&self, path: &str) -> Result<Response, Error>;
    pub fn post_json<T: Serialize>(&self, path: &str, body: &T) -> Result<Response, Error>;
    pub fn post_empty(&self, path: &str) -> Result<Response, Error>;

    // ---------- core ----------
    pub fn whoami(&self)                                            -> Result<Response, Error>;
    pub fn health(&self)                                            -> Result<Response, Error>;
    pub fn verify(&self, cid: &str)                                 -> Result<Response, Error>;
    pub fn changelog(&self, limit: Option<u32>)                     -> Result<Response, Error>;
    pub fn intent_ask(&self, prompt: &str)                          -> Result<Response, Error>;
    pub fn capture_log(&self, namespace: &str, items: &Value)       -> Result<Response, Error>;

    // ---------- account + auth ----------
    pub fn account(&self)                                           -> Result<Response, Error>;
    pub fn signup(&self, email: &str, name: Option<&str>)           -> Result<Response, Error>;
    pub fn rotate_key(&self)                                        -> Result<Response, Error>;

    // ---------- marketplace ----------
    pub fn marketplace_list(&self, q: Option<&str>, category: Option<&str>) -> Result<Response, Error>;
    pub fn marketplace_get(&self, slug: &str)                       -> Result<Response, Error>;
    pub fn marketplace_download(&self, slug: &str)                  -> Result<Response, Error>;

    // ---------- recipes ----------
    pub fn recipe_list(&self, q: Option<&str>, tag: Option<&str>, limit: Option<u32>) -> Result<Response, Error>;
    pub fn recipe_get(&self, id: &str)                              -> Result<Response, Error>;
    pub fn recipe_stats(&self, id: &str)                            -> Result<Response, Error>;
    pub fn recipe_run(&self, id: &str, input: &Value)               -> Result<Response, Error>;

    // ---------- search ----------
    pub fn search(&self, query: &str, k: Option<u32>)               -> Result<Response, Error>;

    // ---------- specialists ----------
    pub fn specialist_list(&self)                                   -> Result<Response, Error>;
    pub fn specialist_get(&self, id: &str)                          -> Result<Response, Error>;
    pub fn specialist_run(&self, id: &str, input: &Value)           -> Result<Response, Error>;
    pub fn specialist_train(&self, req: &Value)                     -> Result<Response, Error>;
}

pub struct Response {
    pub status: u16,
    pub body:   String,
}

impl Response {
    pub fn is_success(&self) -> bool;                  // 200..=299
    pub fn json<T: Deserialize>(&self) -> Result<T, Error>;
}
```

### Account & auth

`account()` GETs `/v1/account` and returns the caller's tenant record, plan, and quotas. `signup(email, name)` POSTs `/v1/auth/signup` and returns a new tenant plus a freshly minted API key (no existing key required). `rotate_key()` POSTs `/v1/account/rotate-key`; the OLD key is used to authenticate, the NEW key is returned in the body and must be persisted by the caller (the old one is invalidated server-side).

### Marketplace

`marketplace_list(q, category)` GETs `/v1/marketplace` with optional query and category filters and returns the public catalog (W263 seeds 7 artifacts). `marketplace_get(slug)` GETs `/v1/marketplace/:slug` for a single record. `marketplace_download(slug)` GETs `/v1/marketplace/:slug/download`; the server returns binary bytes, which the `Response` exposes as a UTF-8 string. If you need the exact bytes for a non-text payload, use the `download_url` field from `marketplace_get` with your own HTTP stack so nothing is silently re-encoded.

### Recipes

`recipe_list(q, tag, limit)` GETs `/v1/recipes` with optional filters. `recipe_get(id)` and `recipe_stats(id)` GET the single recipe and its aggregate run stats. `recipe_run(id, input)` POSTs to `/v1/recipes/:id/run` and forwards the JSON `input` verbatim.

### Search

`search(query, k)` POSTs `/v1/search` with a query string and an optional result count `k` (server default 5 when `None`).

### Specialists

`specialist_list()` and `specialist_get(id)` GET the caller's trained specialists. `specialist_run(id, input)` POSTs `/v1/specialists/:id/run` with the JSON input. `specialist_train(req)` POSTs `/v1/specialists` with the full training request as a JSON value; we don't enforce a typed shape so callers can use any field the server supports without waiting for an SDK bump.

All methods return a raw `Response` whose `status` and `body` are surfaced verbatim - no method papers over a 4xx, and JSON parsing stays opt-in via `r.json::<T>()`.

## Honesty contract

- `Response.status` is the raw HTTP status code. There is no `is_success()` sugar that hides a 4xx; you handle status codes yourself.
- `Response.body` is the raw bytes as a UTF-8 string. JSON parsing is opt-in via `r.json::<T>()` so the SDK never forces a schema on an evolving API.
- A 4xx or 5xx is returned as `Ok(Response { status: 401, .. })`. Only transport-level failures (DNS, TLS, timeout) come back as `Err(Error::Network)`.
- `from_env()` reads `KOLM_BASE_URL` (default `https://kolm.ai`) and `KOLM_API_KEY`. A client without an API key is valid and useful for `/v1/health`, `/v1/changelog`, and the public `/v1/marketplace` catalog.
- Binary endpoints like `/v1/marketplace/:slug/download` return the raw bytes in `Response.body` as a UTF-8 string (lossy for non-text payloads). Callers that need the exact bytes should pull the `download_url` from `marketplace_get` and fetch it with their own HTTP stack.

## Why a tiny synchronous client

We pick `ureq` over `reqwest` because the kolm SDK is integrated by people writing small CLIs and edge agents who do not want to drag in `tokio`. The whole crate is one source file plus an example. If you want async, wrap the calls in `tokio::task::spawn_blocking`.
