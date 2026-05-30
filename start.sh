#!/bin/sh
# Railway start wrapper. Make the mounted data volume writable so the app can persist
# tenants/events/conversations (the volume can mount root-owned, breaking writes). This is
# best-effort: if it's not permitted or already writable, we ignore it and still start.
# node is started via `exec` so this wrapper can never prevent the server from launching.
chmod a+rwX "${KOLM_DATA_DIR:-/app/data}" 2>/dev/null || true
mkdir -p "${KOLM_DATA_DIR:-/app/data}/events" 2>/dev/null || true
chmod a+rwX "${KOLM_DATA_DIR:-/app/data}/events" 2>/dev/null || true
exec node server.js
