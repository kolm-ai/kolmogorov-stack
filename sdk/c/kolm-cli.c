/*
 * sdk/c/kolm-cli.c - tiny CLI driver showing how to use kolm.h.
 *
 * Build (POSIX):   make
 * Build (manual): cc -DKOLM_IMPLEMENTATION -o kolm-cli kolm-cli.c -lcurl
 *
 * Usage:
 *   ./kolm-cli whoami
 *   ./kolm-cli health
 *   ./kolm-cli verify <cid>
 *   ./kolm-cli changelog [limit]
 *   ./kolm-cli ask "<prompt>"
 *   ./kolm-cli account
 *   ./kolm-cli signup <email> [name]
 *   ./kolm-cli rotate-key
 *   ./kolm-cli marketplace [list|get|download] [slug|q]
 *   ./kolm-cli recipes [list|get|stats|run] [id]
 *   ./kolm-cli search "<query>" [k]
 *   ./kolm-cli specialists [list|get|run] [id]
 *
 * Reads KOLM_API_KEY and KOLM_BASE_URL from the environment. The SDK is the
 * same one customers ship in their own apps - this binary just proves the
 * header compiles cleanly and the routes return JSON.
 */

#define KOLM_IMPLEMENTATION
#include "kolm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int print_response(const char *label, kolm_response_t r) {
  if (r.status == 0) {
    fprintf(stderr, "%s: network error (no response)\n", label);
    kolm_response_free(&r);
    return 2;
  }
  printf("%s: status=%ld\n", label, r.status);
  if (r.body) printf("%s\n", r.body);
  int rc = (r.status >= 200 && r.status < 300) ? 0 : 1;
  kolm_response_free(&r);
  return rc;
}

static int print_binary_response(const char *label, kolm_response_t r) {
  /* Marketplace download returns binary .kolm bytes. We dump them to stdout
   * raw so the caller can `kolm-cli marketplace download foo > foo.kolm`. */
  if (r.status == 0) {
    fprintf(stderr, "%s: network error (no response)\n", label);
    kolm_response_free(&r);
    return 2;
  }
  fprintf(stderr, "%s: status=%ld bytes=%zu\n", label, r.status, r.body_len);
  if (r.body && r.body_len > 0) {
    fwrite(r.body, 1, r.body_len, stdout);
  }
  int rc = (r.status >= 200 && r.status < 300) ? 0 : 1;
  kolm_response_free(&r);
  return rc;
}

static int usage(void) {
  fprintf(stderr,
    "kolm-cli (C SDK v%s)\n"
    "  kolm-cli whoami\n"
    "  kolm-cli health\n"
    "  kolm-cli verify <cid>\n"
    "  kolm-cli changelog [limit]\n"
    "  kolm-cli ask \"<prompt>\"\n"
    "  kolm-cli account\n"
    "  kolm-cli signup <email> [name]\n"
    "  kolm-cli rotate-key\n"
    "  kolm-cli marketplace list [q] [category]\n"
    "  kolm-cli marketplace get <slug>\n"
    "  kolm-cli marketplace download <slug>     # binary .kolm to stdout\n"
    "  kolm-cli recipes list [q] [tag]\n"
    "  kolm-cli recipes get <id>\n"
    "  kolm-cli recipes stats <id>\n"
    "  kolm-cli recipes run <id> '<json_input>'\n"
    "  kolm-cli search \"<query>\" [k]\n"
    "  kolm-cli specialists list\n"
    "  kolm-cli specialists get <id>\n"
    "  kolm-cli specialists run <id> '<json_input>'\n"
    "  kolm-cli capture <namespace> '<items_json>'\n"
    "Env: KOLM_BASE_URL (default https://kolm.ai), KOLM_API_KEY\n",
    kolm_sdk_version());
  return 64;
}

static int dispatch_marketplace(kolm_client_t *c, int argc, char **argv) {
  if (argc < 3) {
    /* default: list everything */
    return print_response("marketplace", kolm_marketplace_list(c, NULL, NULL));
  }
  const char *sub = argv[2];
  if (strcmp(sub, "list") == 0) {
    const char *q   = (argc >= 4) ? argv[3] : NULL;
    const char *cat = (argc >= 5) ? argv[4] : NULL;
    return print_response("marketplace.list", kolm_marketplace_list(c, q, cat));
  } else if (strcmp(sub, "get") == 0 && argc >= 4) {
    return print_response("marketplace.get", kolm_marketplace_get(c, argv[3]));
  } else if (strcmp(sub, "download") == 0 && argc >= 4) {
    return print_binary_response("marketplace.download", kolm_marketplace_download(c, argv[3]));
  }
  return usage();
}

static int dispatch_recipes(kolm_client_t *c, int argc, char **argv) {
  if (argc < 3) return print_response("recipes", kolm_recipe_list(c, NULL, NULL, 0));
  const char *sub = argv[2];
  if (strcmp(sub, "list") == 0) {
    const char *q   = (argc >= 4) ? argv[3] : NULL;
    const char *tag = (argc >= 5) ? argv[4] : NULL;
    return print_response("recipes.list", kolm_recipe_list(c, q, tag, 0));
  } else if (strcmp(sub, "get") == 0 && argc >= 4) {
    return print_response("recipes.get", kolm_recipe_get(c, argv[3]));
  } else if (strcmp(sub, "stats") == 0 && argc >= 4) {
    return print_response("recipes.stats", kolm_recipe_stats(c, argv[3]));
  } else if (strcmp(sub, "run") == 0 && argc >= 4) {
    const char *input = (argc >= 5) ? argv[4] : "{}";
    return print_response("recipes.run", kolm_recipe_run(c, argv[3], input));
  }
  return usage();
}

static int dispatch_specialists(kolm_client_t *c, int argc, char **argv) {
  if (argc < 3) return print_response("specialists", kolm_specialist_list(c));
  const char *sub = argv[2];
  if (strcmp(sub, "list") == 0) {
    return print_response("specialists.list", kolm_specialist_list(c));
  } else if (strcmp(sub, "get") == 0 && argc >= 4) {
    return print_response("specialists.get", kolm_specialist_get(c, argv[3]));
  } else if (strcmp(sub, "run") == 0 && argc >= 4) {
    const char *input = (argc >= 5) ? argv[4] : "{}";
    return print_response("specialists.run", kolm_specialist_run(c, argv[3], input));
  }
  return usage();
}

int main(int argc, char **argv) {
  if (argc < 2) return usage();
  kolm_client_t *c = kolm_client_new(NULL, NULL);
  if (!c) { fprintf(stderr, "client init failed\n"); return 3; }
  int rc = 0;
  const char *cmd = argv[1];
  if (strcmp(cmd, "whoami") == 0) {
    rc = print_response("whoami", kolm_whoami(c));
  } else if (strcmp(cmd, "health") == 0) {
    rc = print_response("health", kolm_health(c));
  } else if (strcmp(cmd, "verify") == 0 && argc >= 3) {
    rc = print_response("verify", kolm_verify(c, argv[2]));
  } else if (strcmp(cmd, "changelog") == 0) {
    int limit = (argc >= 3) ? atoi(argv[2]) : 0;
    rc = print_response("changelog", kolm_changelog(c, limit));
  } else if (strcmp(cmd, "ask") == 0 && argc >= 3) {
    rc = print_response("ask", kolm_intent_ask(c, argv[2]));
  } else if (strcmp(cmd, "account") == 0) {
    rc = print_response("account", kolm_account(c));
  } else if (strcmp(cmd, "signup") == 0 && argc >= 3) {
    const char *name = (argc >= 4) ? argv[3] : NULL;
    rc = print_response("signup", kolm_signup(c, argv[2], name));
  } else if (strcmp(cmd, "rotate-key") == 0) {
    rc = print_response("rotate-key", kolm_rotate_key(c));
  } else if (strcmp(cmd, "marketplace") == 0) {
    rc = dispatch_marketplace(c, argc, argv);
  } else if (strcmp(cmd, "recipes") == 0) {
    rc = dispatch_recipes(c, argc, argv);
  } else if (strcmp(cmd, "specialists") == 0) {
    rc = dispatch_specialists(c, argc, argv);
  } else if (strcmp(cmd, "search") == 0 && argc >= 3) {
    int k = (argc >= 4) ? atoi(argv[3]) : 0;
    rc = print_response("search", kolm_search(c, argv[2], k));
  } else if (strcmp(cmd, "capture") == 0 && argc >= 4) {
    rc = print_response("capture", kolm_capture_log(c, argv[2], argv[3]));
  } else {
    rc = usage();
  }
  kolm_client_free(c);
  return rc;
}
