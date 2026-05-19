# kolm Rust SDK

A small Rust client for the kolm.ai HTTP surface. Covers `/v1/whoami`, `/v1/health`, `/v1/capture/log`, `/v1/intent/ask`, `/v1/verify/:cid`, and `/v1/changelog`.

## Install

```toml
[dependencies]
kolm = "0.1"
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

## API

```rust
pub struct Client { /* ... */ }

impl Client {
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self;
    pub fn from_env() -> Result<Self, Error>;
    pub fn with_timeout(self, timeout: Duration) -> Self;
    pub fn base_url(&self) -> &str;

    pub fn get(&self, path: &str) -> Result<Response, Error>;
    pub fn post_json<T: Serialize>(&self, path: &str, body: &T) -> Result<Response, Error>;

    pub fn whoami(&self)                                            -> Result<Response, Error>;
    pub fn health(&self)                                            -> Result<Response, Error>;
    pub fn verify(&self, cid: &str)                                 -> Result<Response, Error>;
    pub fn changelog(&self, limit: Option<u32>)                     -> Result<Response, Error>;
    pub fn intent_ask(&self, prompt: &str)                          -> Result<Response, Error>;
    pub fn capture_log(&self, namespace: &str, items: &Value)       -> Result<Response, Error>;
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

## Honesty contract

- `Response.status` is the raw HTTP status code. There is no `is_success()` sugar that hides a 4xx; you handle status codes yourself.
- `Response.body` is the raw bytes as a UTF-8 string. JSON parsing is opt-in via `r.json::<T>()` so the SDK never forces a schema on an evolving API.
- A 4xx or 5xx is returned as `Ok(Response { status: 401, .. })`. Only transport-level failures (DNS, TLS, timeout) come back as `Err(Error::Network)`.
- `from_env()` reads `KOLM_BASE_URL` (default `https://kolm.ai`) and `KOLM_API_KEY`. A client without an API key is valid and useful for `/v1/health` and `/v1/changelog`.

## Why a tiny synchronous client

We pick `ureq` over `reqwest` because the kolm SDK is integrated by people writing small CLIs and edge agents who do not want to drag in `tokio`. The whole crate is one source file plus an example. If you want async, wrap the calls in `tokio::task::spawn_blocking`.
