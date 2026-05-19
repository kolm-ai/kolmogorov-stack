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

static int usage(void) {
  fprintf(stderr,
    "kolm-cli (C SDK v%s)\n"
    "  kolm-cli whoami\n"
    "  kolm-cli health\n"
    "  kolm-cli verify <cid>\n"
    "  kolm-cli changelog [limit]\n"
    "  kolm-cli ask \"<prompt>\"\n"
    "Env: KOLM_BASE_URL (default https://kolm.ai), KOLM_API_KEY\n",
    kolm_sdk_version());
  return 64;
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
  } else {
    rc = usage();
  }
  kolm_client_free(c);
  return rc;
}
