#!/bin/sh
# Railway/Docker start wrapper. Runs as root so it can:
#   1. make the mounted data volume writable by the unprivileged `node` user
#      (the volume can mount root-owned, which breaks persistence), then
#   2. DROP PRIVILEGES to `node` via su-exec before running the server, so the
#      server process itself never runs as root (security hardening).
# Non-recursive chown/chmod (instant — a recursive pass on a large volume once
# delayed boot past the healthcheck and crash-looped). Best-effort throughout;
# if anything here fails we still start the server so the app can never be taken
# down by this wrapper.
DATA="${KOLM_DATA_DIR:-/app/data}"
mkdir -p "$DATA/events" 2>/dev/null || true
chown node:node "$DATA" "$DATA/events" 2>/dev/null || true
chmod a+rwX "$DATA" "$DATA/events" 2>/dev/null || true

# Args are the CMD / Railway start command (e.g. `node server.js`). Fall back to
# the canonical command if none were passed.
if [ "$#" -eq 0 ]; then
  set -- node server.js
fi

# Drop root -> node, then exec the server. If su-exec is unavailable for any
# reason, fall back to running as the current user rather than failing to boot.
if command -v su-exec >/dev/null 2>&1; then
  exec su-exec node "$@"
fi
exec "$@"
