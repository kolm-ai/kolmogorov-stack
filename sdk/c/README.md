# kolm C SDK

A single-header C client for the kolm.ai HTTP surface. Drop `kolm.h` into your project, link against libcurl, and you have full-parity access to the same routes the Node and Rust SDKs cover: account, marketplace, recipes, specialists, search, capture, intent, verify, changelog, health, whoami.

## Install

Vendor `kolm.h` into your tree. It is a stb-style single header: prototypes are always available; the implementation is gated behind `#define KOLM_IMPLEMENTATION` in exactly one translation unit.

```c
#define KOLM_IMPLEMENTATION
#include "kolm.h"
```

You also need libcurl. On Debian/Ubuntu: `apt-get install libcurl4-openssl-dev`. On macOS: `brew install curl`. On Windows: `vcpkg install curl` or use the curl binaries from https://curl.se/windows/.

## Hello, kolm

```c
#define KOLM_IMPLEMENTATION
#include "kolm.h"

int main(void) {
  kolm_client_t *c = kolm_client_new(NULL, NULL); /* base_url + api_key from env */
  kolm_response_t r = kolm_whoami(c);
  if (r.status == 200) printf("whoami: %s\n", r.body);
  kolm_response_free(&r);
  kolm_client_free(c);
}
```

Build:

```
cc -DKOLM_IMPLEMENTATION -o hello hello.c -lcurl
KOLM_API_KEY=ks_... ./hello
```

## CLI demo

`kolm-cli.c` is a driver that exercises every helper. Build with `make`:

```
make            # produces ./kolm-cli
./kolm-cli whoami
./kolm-cli account
./kolm-cli marketplace list                       # whole catalog
./kolm-cli marketplace list "redact" "privacy"    # q + category filter
./kolm-cli marketplace get redactor-v1
./kolm-cli marketplace download redactor-v1 > redactor-v1.kolm
./kolm-cli recipes list
./kolm-cli recipes run rcp_abc123 '{"input":"hello world"}'
./kolm-cli search "spam classifier" 5
./kolm-cli specialists list
./kolm-cli ask "compile a redactor from my last 1000 captures"
```

## API

### Core

```c
kolm_client_t *kolm_client_new(const char *base_url, const char *api_key);
void           kolm_client_free(kolm_client_t *c);
void           kolm_client_set_timeout_ms(kolm_client_t *c, long ms);

kolm_response_t kolm_get (kolm_client_t *c, const char *path);
kolm_response_t kolm_post(kolm_client_t *c, const char *path, const char *body_json);

void        kolm_response_free(kolm_response_t *r);
const char *kolm_sdk_version  (void);
```

### Status, health, verify, changelog, intent, capture

```c
kolm_response_t kolm_whoami     (kolm_client_t *c);
kolm_response_t kolm_health     (kolm_client_t *c);
kolm_response_t kolm_verify     (kolm_client_t *c, const char *cid);
kolm_response_t kolm_changelog  (kolm_client_t *c, int limit);
kolm_response_t kolm_intent_ask (kolm_client_t *c, const char *prompt);
kolm_response_t kolm_capture_log(kolm_client_t *c, const char *namespace_, const char *items_json);
```

`/v1/whoami`, `/v1/health`, and `/v1/changelog` work without an API key. `/v1/verify/:cid` is public. `/v1/intent/ask` and `/v1/capture/log` need a key — set `KOLM_API_KEY` or pass it to `kolm_client_new`.

### Account and auth

```c
kolm_response_t kolm_account   (kolm_client_t *c);                                    /* GET  /v1/account */
kolm_response_t kolm_signup    (kolm_client_t *c, const char *email, const char *n);  /* POST /v1/signup */
kolm_response_t kolm_rotate_key(kolm_client_t *c);                                    /* POST /v1/account/rotate-key */
```

`kolm_signup` returns the freshly-minted `api_key` in the response body — save it. `kolm_rotate_key` revokes the current key and issues a new one (the call itself uses the current key for auth; the response body contains the replacement).

### Marketplace

```c
kolm_response_t kolm_marketplace_list    (kolm_client_t *c, const char *q, const char *category);
kolm_response_t kolm_marketplace_get     (kolm_client_t *c, const char *slug);
kolm_response_t kolm_marketplace_download(kolm_client_t *c, const char *slug);
```

Browse the artifact catalog, inspect a single artifact, or pull the backing `.kolm` bytes. `kolm_marketplace_download` returns the **binary** payload in `r.body`. The SDK writes a sentinel NUL after the body but the artifact itself can contain embedded zeros — iterate using `r.body_len`, never `strlen(r.body)`. Pipe `kolm-cli marketplace download` directly to a file.

### Recipes

```c
kolm_response_t kolm_recipe_list (kolm_client_t *c, const char *q, const char *tag, int limit);
kolm_response_t kolm_recipe_get  (kolm_client_t *c, const char *id);
kolm_response_t kolm_recipe_stats(kolm_client_t *c, const char *id);
kolm_response_t kolm_recipe_run  (kolm_client_t *c, const char *id, const char *json_input);
```

A recipe is a compiled concept (artifact) that can be re-run against new inputs. `kolm_recipe_run` posts to `/v1/recipes/:id/run` — pass the JSON body verbatim (e.g. `{"input":"hello"}`). `kolm_recipe_stats` returns p50/p95/p99 latency and cache-hit rate.

### Search

```c
kolm_response_t kolm_search(kolm_client_t *c, const char *query, int k);
```

Vector / lexical search over the caller's recipes. `k <= 0` falls back to the server default.

### Specialists

```c
kolm_response_t kolm_specialist_list (kolm_client_t *c);
kolm_response_t kolm_specialist_get  (kolm_client_t *c, const char *id);
kolm_response_t kolm_specialist_run  (kolm_client_t *c, const char *id, const char *json_input);
kolm_response_t kolm_specialist_train(kolm_client_t *c, const char *json_req);
```

A specialist is a LoRA / distilled-model wrapper around one or more recipes. `kolm_specialist_train` posts the training request to `/v1/specialists/train` — pass the JSON body verbatim (see `SpecialistTrainRequest` in `sdk/node/index.d.ts` for the canonical shape). The call returns immediately with a job id; poll with `kolm_specialist_get`.

`kolm_response_t` is:

```c
typedef struct {
  long   status;   /* HTTP status code; 0 on network error */
  char  *body;     /* response bytes (owned), NUL-terminated for text */
  size_t body_len; /* true byte count — use this for binary payloads */
} kolm_response_t;
```

## Failure-mode contract

- `status` is the literal HTTP status code. `0` means the request never reached a server (DNS, TLS, timeout).
- `body` is the raw response bytes with a sentinel NUL appended for convenience. The SDK does NOT parse JSON; pair with cJSON, jansson, or json-c if you need structured access. For binary downloads (`kolm_marketplace_download`) use `body_len` to walk the buffer — a `.kolm` artifact can contain embedded zeros.
- 4xx and 5xx responses are NOT errors — they are returned in the envelope so the caller can inspect status before parsing. The SDK never retries silently.
- The base URL defaults to `https://kolm.ai` if both the constructor arg and `KOLM_BASE_URL` env var are unset.
- The API key falls back to `KOLM_API_KEY` if the constructor arg is NULL. Without a key, calls that require auth will return `401`.
- Query strings are RFC-3986 percent-encoded by the SDK. JSON string literals (prompts, namespaces, search queries) are JSON-escaped by the SDK. JSON object bodies you pass to `kolm_recipe_run`, `kolm_specialist_run`, `kolm_specialist_train`, and `kolm_capture_log` are forwarded verbatim — compose them with your JSON library.
- Every `kolm_response_t` you receive must be freed with `kolm_response_free` to release the body buffer.

## Why a header-only SDK

Distributing C code is awkward. Customers integrating into existing build systems (CMake, Meson, Bazel, raw makefiles, MSVC `.sln` files) generally do not want a new dependency tree. `kolm.h` is one file, one external link (`-lcurl`), and works with the C99 compiler you already have.

## Versioning

`KOLM_SDK_VERSION` is the constant exposed in the header and via `kolm_sdk_version()`. Bump the patch when the public API stays compatible, the minor when it grows additively, the major when prototypes change shape.
