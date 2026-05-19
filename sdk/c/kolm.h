/*
 * sdk/c/kolm.h — kolm C SDK (single header, libcurl-backed).
 *
 * Drop this file into your project, link against libcurl, and you have a
 * working client for the kolm HTTP surface — account, marketplace, recipes,
 * specialists, search, capture, intent, verify, changelog, health, whoami.
 *
 * Build (POSIX):
 *   cc -DKOLM_IMPLEMENTATION -o kolm-cli kolm-cli.c -lcurl
 *
 * Build (Windows + vcpkg curl):
 *   cl /DKOLM_IMPLEMENTATION kolm-cli.c /I<curl-include> /link curl.lib
 *
 * Quick start:
 *
 *   #define KOLM_IMPLEMENTATION
 *   #include "kolm.h"
 *
 *   int main(void) {
 *     kolm_client_t *c = kolm_client_new("https://kolm.ai", getenv("KOLM_API_KEY"));
 *     kolm_response_t r = kolm_whoami(c);
 *     if (r.status == 200) printf("whoami: %s\n", r.body);
 *     kolm_response_free(&r);
 *     kolm_client_free(c);
 *   }
 *
 * Honesty contract:
 *   - kolm_response_t.status is the literal HTTP status integer.
 *   - kolm_response_t.body is a NUL-terminated C string (the raw response
 *     bytes followed by a sentinel NUL). Free with kolm_response_free.
 *   - kolm_response_t.body_len is the true byte count of the response. For
 *     binary payloads (marketplace .kolm downloads) you MUST iterate with
 *     body_len because the bytes can contain embedded NULs.
 *   - On network failure status is 0 and body is NULL.
 *   - 4xx and 5xx are NOT errors — they are returned in the envelope so the
 *     caller can inspect status before parsing. The SDK never retries silently.
 *   - JSON is returned RAW — no parser is bundled. Pair with cJSON / jansson
 *     / json-c if you need structured access.
 */

#ifndef KOLM_H
#define KOLM_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct kolm_client_s kolm_client_t;

typedef struct {
  long   status;   /* HTTP status code; 0 on network error */
  char  *body;     /* NUL-terminated response body (owned), or NULL */
  size_t body_len; /* bytes in body excluding the NUL terminator */
} kolm_response_t;

/* Create a client. base_url and api_key may both be NULL — base_url defaults
 * to "https://kolm.ai" and api_key falls back to env KOLM_API_KEY. */
kolm_client_t *kolm_client_new(const char *base_url, const char *api_key);
void           kolm_client_free(kolm_client_t *c);

/* Optional: override request timeout (default 30s). */
void kolm_client_set_timeout_ms(kolm_client_t *c, long ms);

/* Low-level. body_json may be NULL for GET; for POST it's a NUL-terminated
 * JSON string the SDK does NOT validate. */
kolm_response_t kolm_get (kolm_client_t *c, const char *path);
kolm_response_t kolm_post(kolm_client_t *c, const char *path, const char *body_json);

/* High-level helpers. Each returns the raw response envelope — callers parse
 * JSON with their preferred library. These exist so the SDK self-documents
 * which routes are intentional vs incidental. */
kolm_response_t kolm_whoami  (kolm_client_t *c);
kolm_response_t kolm_health  (kolm_client_t *c);
kolm_response_t kolm_verify  (kolm_client_t *c, const char *cid);
kolm_response_t kolm_changelog(kolm_client_t *c, int limit);
kolm_response_t kolm_intent_ask(kolm_client_t *c, const char *prompt);
/* items_json: a JSON array string like [{"input":"...","output":"..."}].
 * namespace may be NULL (server defaults to "default"). */
kolm_response_t kolm_capture_log(kolm_client_t *c, const char *namespace_, const char *items_json);

/* Account & auth.
 * kolm_signup is wired to /v1/signup (the live route). The Node + Rust SDKs
 * agree; an /v1/auth/signup alias does not exist on the server. name may be
 * NULL. */
kolm_response_t kolm_account   (kolm_client_t *c);
kolm_response_t kolm_signup    (kolm_client_t *c, const char *email, const char *name);
kolm_response_t kolm_rotate_key(kolm_client_t *c);

/* Marketplace.
 * - kolm_marketplace_list: q and category may both be NULL.
 * - kolm_marketplace_download returns BINARY .kolm bytes in r.body. The buffer
 *   is NUL-terminated by the SDK as a courtesy but the payload itself can
 *   contain embedded zeros — iterate using r.body_len, not strlen. */
kolm_response_t kolm_marketplace_list    (kolm_client_t *c, const char *q, const char *category);
kolm_response_t kolm_marketplace_get     (kolm_client_t *c, const char *slug);
kolm_response_t kolm_marketplace_download(kolm_client_t *c, const char *slug);

/* Recipes.
 * - q, tag may be NULL; limit <= 0 omits the parameter (server picks default).
 * - kolm_recipe_run takes a JSON object string like {"input":"hello"}; the SDK
 *   does NOT validate it. */
kolm_response_t kolm_recipe_list (kolm_client_t *c, const char *q, const char *tag, int limit);
kolm_response_t kolm_recipe_get  (kolm_client_t *c, const char *id);
kolm_response_t kolm_recipe_stats(kolm_client_t *c, const char *id);
kolm_response_t kolm_recipe_run  (kolm_client_t *c, const char *id, const char *json_input);

/* Search.
 * k <= 0 falls back to the server default (currently 10). */
kolm_response_t kolm_search(kolm_client_t *c, const char *query, int k);

/* Specialists.
 * kolm_specialist_train posts to /v1/specialists/train (the working route).
 * json_req is a JSON object string the caller composes verbatim — see
 * SpecialistTrainRequest in the Node SDK for the shape. */
kolm_response_t kolm_specialist_list (kolm_client_t *c);
kolm_response_t kolm_specialist_get  (kolm_client_t *c, const char *id);
kolm_response_t kolm_specialist_run  (kolm_client_t *c, const char *id, const char *json_input);
kolm_response_t kolm_specialist_train(kolm_client_t *c, const char *json_req);

void kolm_response_free(kolm_response_t *r);

const char *kolm_sdk_version(void);

#ifdef __cplusplus
}
#endif

#endif /* KOLM_H */

/* ===================== IMPLEMENTATION ===================== */

#ifdef KOLM_IMPLEMENTATION

#include <curl/curl.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#define KOLM_SDK_VERSION "0.1.0"
#define KOLM_DEFAULT_BASE "https://kolm.ai"
#define KOLM_DEFAULT_TIMEOUT_MS 30000L

struct kolm_client_s {
  char *base_url;
  char *api_key;   /* may be NULL */
  long  timeout_ms;
};

static char *kolm__strdup(const char *s) {
  if (!s) return NULL;
  size_t n = strlen(s);
  char *p = (char*)malloc(n + 1);
  if (!p) return NULL;
  memcpy(p, s, n);
  p[n] = 0;
  return p;
}

static void kolm__strip_trailing_slash(char *s) {
  if (!s) return;
  size_t n = strlen(s);
  while (n > 0 && s[n-1] == '/') { s[n-1] = 0; n--; }
}

const char *kolm_sdk_version(void) { return KOLM_SDK_VERSION; }

kolm_client_t *kolm_client_new(const char *base_url, const char *api_key) {
  static int curl_initialized = 0;
  if (!curl_initialized) {
    curl_global_init(CURL_GLOBAL_DEFAULT);
    curl_initialized = 1;
  }
  kolm_client_t *c = (kolm_client_t*)calloc(1, sizeof(kolm_client_t));
  if (!c) return NULL;
  const char *b = base_url;
  if (!b) b = getenv("KOLM_BASE_URL");
  if (!b) b = KOLM_DEFAULT_BASE;
  c->base_url = kolm__strdup(b);
  kolm__strip_trailing_slash(c->base_url);
  const char *k = api_key;
  if (!k) k = getenv("KOLM_API_KEY");
  c->api_key = k ? kolm__strdup(k) : NULL;
  c->timeout_ms = KOLM_DEFAULT_TIMEOUT_MS;
  return c;
}

void kolm_client_free(kolm_client_t *c) {
  if (!c) return;
  free(c->base_url);
  free(c->api_key);
  free(c);
}

void kolm_client_set_timeout_ms(kolm_client_t *c, long ms) {
  if (c && ms > 0) c->timeout_ms = ms;
}

typedef struct {
  char  *buf;
  size_t len;
  size_t cap;
} kolm__sink_t;

static size_t kolm__write_cb(void *ptr, size_t size, size_t nmemb, void *user) {
  kolm__sink_t *s = (kolm__sink_t*)user;
  size_t add = size * nmemb;
  if (s->len + add + 1 > s->cap) {
    size_t newcap = s->cap ? s->cap * 2 : 1024;
    while (newcap < s->len + add + 1) newcap *= 2;
    char *nb = (char*)realloc(s->buf, newcap);
    if (!nb) return 0;
    s->buf = nb; s->cap = newcap;
  }
  memcpy(s->buf + s->len, ptr, add);
  s->len += add;
  s->buf[s->len] = 0;
  return add;
}

static kolm_response_t kolm__request(kolm_client_t *c, const char *method, const char *path, const char *body) {
  kolm_response_t r = { 0, NULL, 0 };
  if (!c || !path) return r;
  CURL *h = curl_easy_init();
  if (!h) return r;
  char *url = (char*)malloc(strlen(c->base_url) + strlen(path) + 1);
  if (!url) { curl_easy_cleanup(h); return r; }
  strcpy(url, c->base_url); strcat(url, path);
  kolm__sink_t sink = { NULL, 0, 0 };
  struct curl_slist *headers = NULL;
  headers = curl_slist_append(headers, "Content-Type: application/json");
  char ua[128];
  snprintf(ua, sizeof(ua), "User-Agent: kolm-c-sdk/%s", KOLM_SDK_VERSION);
  headers = curl_slist_append(headers, ua);
  if (c->api_key) {
    char auth[512];
    snprintf(auth, sizeof(auth), "Authorization: Bearer %s", c->api_key);
    headers = curl_slist_append(headers, auth);
  }
  curl_easy_setopt(h, CURLOPT_URL, url);
  curl_easy_setopt(h, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, kolm__write_cb);
  curl_easy_setopt(h, CURLOPT_WRITEDATA, &sink);
  curl_easy_setopt(h, CURLOPT_TIMEOUT_MS, c->timeout_ms);
  curl_easy_setopt(h, CURLOPT_FOLLOWLOCATION, 1L);
  if (strcmp(method, "POST") == 0) {
    curl_easy_setopt(h, CURLOPT_POST, 1L);
    curl_easy_setopt(h, CURLOPT_POSTFIELDS, body ? body : "");
    curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE, (long)(body ? strlen(body) : 0));
  }
  CURLcode rc = curl_easy_perform(h);
  long status = 0;
  if (rc == CURLE_OK) curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &status);
  curl_slist_free_all(headers);
  curl_easy_cleanup(h);
  free(url);
  if (rc != CURLE_OK) {
    free(sink.buf);
    return r;
  }
  r.status = status;
  r.body = sink.buf;
  r.body_len = sink.len;
  return r;
}

kolm_response_t kolm_get (kolm_client_t *c, const char *path) { return kolm__request(c, "GET",  path, NULL); }
kolm_response_t kolm_post(kolm_client_t *c, const char *path, const char *body) { return kolm__request(c, "POST", path, body); }

kolm_response_t kolm_whoami  (kolm_client_t *c) { return kolm_get(c, "/v1/whoami"); }
kolm_response_t kolm_health  (kolm_client_t *c) { return kolm_get(c, "/v1/health"); }

kolm_response_t kolm_verify(kolm_client_t *c, const char *cid) {
  if (!cid) { kolm_response_t r = {0, NULL, 0}; return r; }
  char path[512];
  snprintf(path, sizeof(path), "/v1/verify/%s", cid);
  return kolm_get(c, path);
}

kolm_response_t kolm_changelog(kolm_client_t *c, int limit) {
  char path[64];
  if (limit > 0) snprintf(path, sizeof(path), "/v1/changelog?limit=%d", limit);
  else           snprintf(path, sizeof(path), "/v1/changelog");
  return kolm_get(c, path);
}

/* Minimal RFC 3986 percent-encoder for URL components (query values + path
 * segments). Unreserved set is [A-Za-z0-9-._~]; everything else is %HH.
 * Returns a malloc'd buffer the caller must free, or NULL on OOM. */
static char *kolm__url_escape(const char *s) {
  if (!s) return kolm__strdup("");
  static const char hex[] = "0123456789ABCDEF";
  size_t n = strlen(s);
  char *out = (char*)malloc(n * 3 + 1);
  if (!out) return NULL;
  size_t j = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    int safe = (c >= 'A' && c <= 'Z')
            || (c >= 'a' && c <= 'z')
            || (c >= '0' && c <= '9')
            || c == '-' || c == '_' || c == '.' || c == '~';
    if (safe) {
      out[j++] = (char)c;
    } else {
      out[j++] = '%';
      out[j++] = hex[(c >> 4) & 0xF];
      out[j++] = hex[c & 0xF];
    }
  }
  out[j] = 0;
  return out;
}

/* Minimal JSON string escaper — just enough for prompt + namespace literals.
 * Returns a malloc'd buffer the caller must free. */
static char *kolm__json_escape(const char *s) {
  if (!s) return kolm__strdup("");
  size_t n = strlen(s);
  char *out = (char*)malloc(n * 6 + 1);
  if (!out) return NULL;
  size_t j = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    switch (c) {
      case '"':  out[j++]='\\'; out[j++]='"';  break;
      case '\\': out[j++]='\\'; out[j++]='\\'; break;
      case '\b': out[j++]='\\'; out[j++]='b';  break;
      case '\f': out[j++]='\\'; out[j++]='f';  break;
      case '\n': out[j++]='\\'; out[j++]='n';  break;
      case '\r': out[j++]='\\'; out[j++]='r';  break;
      case '\t': out[j++]='\\'; out[j++]='t';  break;
      default:
        if (c < 0x20) { j += sprintf(out + j, "\\u%04x", c); }
        else { out[j++] = (char)c; }
    }
  }
  out[j] = 0;
  return out;
}

kolm_response_t kolm_intent_ask(kolm_client_t *c, const char *prompt) {
  kolm_response_t r = { 0, NULL, 0 };
  char *esc = kolm__json_escape(prompt);
  if (!esc) return r;
  size_t need = strlen(esc) + 32;
  char *body = (char*)malloc(need);
  if (!body) { free(esc); return r; }
  snprintf(body, need, "{\"prompt\":\"%s\"}", esc);
  r = kolm_post(c, "/v1/intent/ask", body);
  free(esc); free(body);
  return r;
}

kolm_response_t kolm_capture_log(kolm_client_t *c, const char *namespace_, const char *items_json) {
  kolm_response_t r = { 0, NULL, 0 };
  const char *ns = namespace_ ? namespace_ : "default";
  char *esc_ns = kolm__json_escape(ns);
  if (!esc_ns) return r;
  const char *items = items_json ? items_json : "[]";
  size_t need = strlen(esc_ns) + strlen(items) + 64;
  char *body = (char*)malloc(need);
  if (!body) { free(esc_ns); return r; }
  snprintf(body, need, "{\"namespace\":\"%s\",\"items\":%s}", esc_ns, items);
  r = kolm_post(c, "/v1/capture/log", body);
  free(esc_ns); free(body);
  return r;
}

/* ---------- Account & auth ---------- */

kolm_response_t kolm_account(kolm_client_t *c) {
  return kolm_get(c, "/v1/account");
}

kolm_response_t kolm_signup(kolm_client_t *c, const char *email, const char *name) {
  kolm_response_t r = { 0, NULL, 0 };
  char *esc_email = kolm__json_escape(email ? email : "");
  if (!esc_email) return r;
  char *esc_name = kolm__json_escape(name ? name : "");
  if (!esc_name) { free(esc_email); return r; }
  /* Always send both keys; "name" as "" is fine — server treats it as optional. */
  size_t need = strlen(esc_email) + strlen(esc_name) + 64;
  char *body = (char*)malloc(need);
  if (!body) { free(esc_email); free(esc_name); return r; }
  if (name) {
    snprintf(body, need, "{\"email\":\"%s\",\"name\":\"%s\"}", esc_email, esc_name);
  } else {
    snprintf(body, need, "{\"email\":\"%s\"}", esc_email);
  }
  r = kolm_post(c, "/v1/signup", body);
  free(esc_email); free(esc_name); free(body);
  return r;
}

kolm_response_t kolm_rotate_key(kolm_client_t *c) {
  /* The server treats rotate-key as a no-body POST (an empty {} works too). */
  return kolm_post(c, "/v1/account/rotate-key", "{}");
}

/* ---------- Marketplace ---------- */

kolm_response_t kolm_marketplace_list(kolm_client_t *c, const char *q, const char *category) {
  kolm_response_t r = { 0, NULL, 0 };
  char *esc_q = NULL, *esc_cat = NULL;
  if (q) { esc_q = kolm__url_escape(q); if (!esc_q) return r; }
  if (category) {
    esc_cat = kolm__url_escape(category);
    if (!esc_cat) { free(esc_q); return r; }
  }
  size_t need = 32
              + (esc_q ? strlen(esc_q) + 4 : 0)
              + (esc_cat ? strlen(esc_cat) + 12 : 0);
  char *path = (char*)malloc(need);
  if (!path) { free(esc_q); free(esc_cat); return r; }
  size_t p = 0;
  p += (size_t)snprintf(path + p, need - p, "/v1/marketplace");
  int first = 1;
  if (esc_q) {
    p += (size_t)snprintf(path + p, need - p, "%cq=%s", first ? '?' : '&', esc_q);
    first = 0;
  }
  if (esc_cat) {
    p += (size_t)snprintf(path + p, need - p, "%ccategory=%s", first ? '?' : '&', esc_cat);
    first = 0;
  }
  r = kolm_get(c, path);
  free(esc_q); free(esc_cat); free(path);
  return r;
}

kolm_response_t kolm_marketplace_get(kolm_client_t *c, const char *slug) {
  kolm_response_t r = { 0, NULL, 0 };
  if (!slug) return r;
  char *esc = kolm__url_escape(slug);
  if (!esc) return r;
  size_t need = strlen(esc) + 24;
  char *path = (char*)malloc(need);
  if (!path) { free(esc); return r; }
  snprintf(path, need, "/v1/marketplace/%s", esc);
  r = kolm_get(c, path);
  free(esc); free(path);
  return r;
}

kolm_response_t kolm_marketplace_download(kolm_client_t *c, const char *slug) {
  kolm_response_t r = { 0, NULL, 0 };
  if (!slug) return r;
  char *esc = kolm__url_escape(slug);
  if (!esc) return r;
  size_t need = strlen(esc) + 40;
  char *path = (char*)malloc(need);
  if (!path) { free(esc); return r; }
  snprintf(path, need, "/v1/marketplace/%s/download", esc);
  /* The response body is binary .kolm bytes — caller MUST use r.body_len. */
  r = kolm_get(c, path);
  free(esc); free(path);
  return r;
}

/* ---------- Recipes ---------- */

kolm_response_t kolm_recipe_list(kolm_client_t *c, const char *q, const char *tag, int limit) {
  kolm_response_t r = { 0, NULL, 0 };
  char *esc_q = NULL, *esc_tag = NULL;
  if (q) { esc_q = kolm__url_escape(q); if (!esc_q) return r; }
  if (tag) {
    esc_tag = kolm__url_escape(tag);
    if (!esc_tag) { free(esc_q); return r; }
  }
  size_t need = 32
              + (esc_q ? strlen(esc_q) + 4 : 0)
              + (esc_tag ? strlen(esc_tag) + 8 : 0)
              + (limit > 0 ? 32 : 0);
  char *path = (char*)malloc(need);
  if (!path) { free(esc_q); free(esc_tag); return r; }
  size_t p = 0;
  p += (size_t)snprintf(path + p, need - p, "/v1/recipes");
  int first = 1;
  if (esc_q) {
    p += (size_t)snprintf(path + p, need - p, "%cq=%s", first ? '?' : '&', esc_q);
    first = 0;
  }
  if (esc_tag) {
    p += (size_t)snprintf(path + p, need - p, "%ctag=%s", first ? '?' : '&', esc_tag);
    first = 0;
  }
  if (limit > 0) {
    p += (size_t)snprintf(path + p, need - p, "%climit=%d", first ? '?' : '&', limit);
    first = 0;
  }
  r = kolm_get(c, path);
  free(esc_q); free(esc_tag); free(path);
  return r;
}

kolm_response_t kolm_recipe_get(kolm_client_t *c, const char *id) {
  kolm_response_t r = { 0, NULL, 0 };
  if (!id) return r;
  char *esc = kolm__url_escape(id);
  if (!esc) return r;
  size_t need = strlen(esc) + 24;
  char *path = (char*)malloc(need);
  if (!path) { free(esc); return r; }
  snprintf(path, need, "/v1/recipes/%s", esc);
  r = kolm_get(c, path);
  free(esc); free(path);
  return r;
}

kolm_response_t kolm_recipe_stats(kolm_client_t *c, const char *id) {
  kolm_response_t r = { 0, NULL, 0 };
  if (!id) return r;
  char *esc = kolm__url_escape(id);
  if (!esc) return r;
  size_t need = strlen(esc) + 32;
  char *path = (char*)malloc(need);
  if (!path) { free(esc); return r; }
  snprintf(path, need, "/v1/recipes/%s/stats", esc);
  r = kolm_get(c, path);
  free(esc); free(path);
  return r;
}

kolm_response_t kolm_recipe_run(kolm_client_t *c, const char *id, const char *json_input) {
  kolm_response_t r = { 0, NULL, 0 };
  if (!id) return r;
  char *esc = kolm__url_escape(id);
  if (!esc) return r;
  size_t need = strlen(esc) + 32;
  char *path = (char*)malloc(need);
  if (!path) { free(esc); return r; }
  snprintf(path, need, "/v1/recipes/%s/run", esc);
  const char *body = (json_input && *json_input) ? json_input : "{}";
  r = kolm_post(c, path, body);
  free(esc); free(path);
  return r;
}

/* ---------- Search ---------- */

kolm_response_t kolm_search(kolm_client_t *c, const char *query, int k) {
  kolm_response_t r = { 0, NULL, 0 };
  char *esc_q = kolm__json_escape(query ? query : "");
  if (!esc_q) return r;
  size_t need = strlen(esc_q) + 64;
  char *body = (char*)malloc(need);
  if (!body) { free(esc_q); return r; }
  if (k > 0) {
    snprintf(body, need, "{\"query\":\"%s\",\"k\":%d}", esc_q, k);
  } else {
    snprintf(body, need, "{\"query\":\"%s\"}", esc_q);
  }
  r = kolm_post(c, "/v1/search", body);
  free(esc_q); free(body);
  return r;
}

/* ---------- Specialists ---------- */

kolm_response_t kolm_specialist_list(kolm_client_t *c) {
  return kolm_get(c, "/v1/specialists");
}

kolm_response_t kolm_specialist_get(kolm_client_t *c, const char *id) {
  kolm_response_t r = { 0, NULL, 0 };
  if (!id) return r;
  char *esc = kolm__url_escape(id);
  if (!esc) return r;
  size_t need = strlen(esc) + 24;
  char *path = (char*)malloc(need);
  if (!path) { free(esc); return r; }
  snprintf(path, need, "/v1/specialists/%s", esc);
  r = kolm_get(c, path);
  free(esc); free(path);
  return r;
}

kolm_response_t kolm_specialist_run(kolm_client_t *c, const char *id, const char *json_input) {
  kolm_response_t r = { 0, NULL, 0 };
  if (!id) return r;
  char *esc = kolm__url_escape(id);
  if (!esc) return r;
  size_t need = strlen(esc) + 32;
  char *path = (char*)malloc(need);
  if (!path) { free(esc); return r; }
  snprintf(path, need, "/v1/specialists/%s/run", esc);
  /* The Node SDK posts {input: ...}; we accept the caller's JSON object
   * verbatim. If they want the {"input":...} wrapper they include it. An
   * empty input ({}) is rejected by the server with a 400 — honest envelope. */
  const char *body = (json_input && *json_input) ? json_input : "{}";
  r = kolm_post(c, path, body);
  free(esc); free(path);
  return r;
}

kolm_response_t kolm_specialist_train(kolm_client_t *c, const char *json_req) {
  /* Server route is /v1/specialists/train (not /v1/specialists for POST). */
  const char *body = (json_req && *json_req) ? json_req : "{}";
  return kolm_post(c, "/v1/specialists/train", body);
}

void kolm_response_free(kolm_response_t *r) {
  if (!r) return;
  free(r->body);
  r->body = NULL;
  r->body_len = 0;
  r->status = 0;
}

#endif /* KOLM_IMPLEMENTATION */
