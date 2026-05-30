#!/bin/sh
# Runs as root (the runtime image has no USER directive). Railway mounts the data
# volume root-owned, so the unprivileged `node` user (uid 1000) can't write it ->
# tenants/events/conversations fail to persist. Here, as root, we make the data dir
# node-owned (non-recursive = instant, won't delay boot), then drop privileges and
# exec the server as `node`. The event-store self-heals file ownership via its
# events-app/events-rw fallback once the dir is writable.
DATA="${KOLM_DATA_DIR:-/var/lib/kolm}"
mkdir -p "$DATA/events" 2>/dev/null || true
chown node:node "$DATA" "$DATA/events" 2>/dev/null || true
exec su-exec node "$@"
