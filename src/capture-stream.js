// Capture SSE fan-out for live capture tail.
//
// W213: powers /v1/capture/stream (browser) and `kolm tail captures` (CLI).
// recordCapture() in router.js calls publishCapture(obs) right after the
// insert succeeds; every subscriber whose tenant matches receives the row as a
// single SSE `data:` event.
//
// Scope rules:
//   - Subscribers are scoped to req.tenant. Cross-tenant fan-out is impossible
//     because delivery still filters on tenant before calling the sink.
//   - When the subscriber's namespace filter is set ('default', 'engineering',
//     '*' = all), rows whose corpus_namespace does not match are suppressed.
//   - Keep-alive lives in router.js; this module only owns fan-out.
//
// Default mode remains in-process. W1029 adds an opt-in file-backed pubsub
// bridge for local multi-process/replica deployments and tests: publishers
// append sanitized capture envelopes to a JSONL bus, while subscribers tail the
// same bus and still apply tenant/namespace filters before delivery.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CAPTURE_STREAM_PUBSUB_VERSION = 'w1029-capture-stream-pubsub-v1';

function _clean(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function _baseDir() {
  return _clean(process.env.KOLM_CAPTURE_PUBSUB_DIR)
    || _clean(process.env.KOLM_DATA_DIR)
    || path.join(os.homedir(), '.kolm');
}

function _defaultDriver() {
  const raw = _clean(process.env.KOLM_CAPTURE_PUBSUB_DRIVER || process.env.KOLM_CAPTURE_STREAM_PUBSUB);
  if (/^(fs|file|jsonl)$/i.test(raw)) return 'fs';
  return 'memory';
}

function _defaultBusPath() {
  return _clean(process.env.KOLM_CAPTURE_PUBSUB_PATH)
    || path.join(_baseDir(), 'capture-stream-pubsub.jsonl');
}

function _safeObs(obs) {
  if (!obs || typeof obs !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(obs)) {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') continue;
    out[key] = value;
  }
  return out;
}

function _ensureDirForFile(file) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
}

function _newPubsubId() {
  return 'cps_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
}

export function createCaptureBroker(opts = {}) {
  const driver = opts.driver === 'fs' || opts.driver === 'file' || opts.driver === 'jsonl'
    ? 'fs'
    : 'memory';
  const busPath = _clean(opts.bus_path || opts.busPath) || _defaultBusPath();
  const pollIntervalMs = Number.isFinite(Number(opts.poll_interval_ms))
    ? Math.max(0, Math.trunc(Number(opts.poll_interval_ms)))
    : 250;
  const subscribers = new Map(); // tenant -> Set<{namespace, sink, id}>
  const seenPubsubIds = new Set();
  let nextSubId = 1;
  let pollTimer = null;
  let readOffset = null;
  let partialLine = '';

  function _primeOffset() {
    if (driver !== 'fs' || readOffset != null) return;
    try {
      readOffset = fs.existsSync(busPath) ? fs.statSync(busPath).size : 0;
    } catch (_) {
      readOffset = 0;
    }
  }

  function _deliverLocal(obs) {
    if (!obs || !obs.tenant) return 0;
    const set = subscribers.get(obs.tenant);
    if (!set || set.size === 0) return 0;
    const rowNs = obs.corpus_namespace || 'default';
    let delivered = 0;
    for (const sub of Array.from(set)) {
      if (sub.namespace !== '*' && sub.namespace !== rowNs) continue;
      try {
        sub.sink(obs);
        delivered++;
      } catch (_) {
        // Subscriber sink threw - most likely the underlying socket closed
        // between publish and write. Drop it before the next capture.
        set.delete(sub);
      }
    }
    if (set.size === 0) subscribers.delete(obs.tenant);
    return delivered;
  }

  function _startPolling() {
    if (driver !== 'fs' || pollIntervalMs <= 0 || pollTimer) return;
    _primeOffset();
    pollTimer = setInterval(() => {
      pollOnce().catch(() => {});
    }, pollIntervalMs);
    try { pollTimer.unref?.(); } catch (_) {}
  }

  function _stopPollingIfIdle() {
    if (subscriberCount() > 0) return;
    if (pollTimer) {
      try { clearInterval(pollTimer); } catch (_) {}
      pollTimer = null;
    }
  }

  function subscribe(tenant, namespace, sink) {
    if (!tenant) throw new Error('subscribe: tenant required');
    if (typeof sink !== 'function') throw new Error('subscribe: sink function required');
    const ns = namespace || '*';
    const id = nextSubId++;
    const entry = { id, namespace: ns, sink };
    if (!subscribers.has(tenant)) subscribers.set(tenant, new Set());
    subscribers.get(tenant).add(entry);
    _primeOffset();
    _startPolling();
    return () => {
      const set = subscribers.get(tenant);
      if (!set) return;
      set.delete(entry);
      if (set.size === 0) subscribers.delete(tenant);
      _stopPollingIfIdle();
    };
  }

  function publishCapture(obs) {
    const safe = _safeObs(obs);
    if (!safe || !safe.tenant) return 0;
    const delivered = _deliverLocal(safe);
    if (driver === 'fs') {
      const envelope = {
        version: CAPTURE_STREAM_PUBSUB_VERSION,
        pubsub_id: _newPubsubId(),
        published_at: new Date().toISOString(),
        obs: safe,
      };
      seenPubsubIds.add(envelope.pubsub_id);
      try {
        _ensureDirForFile(busPath);
        fs.appendFileSync(busPath, JSON.stringify(envelope) + '\n', 'utf8');
      } catch (_) {
        // File pubsub is a live-tail accelerator. Durable replay remains the
        // correctness fallback, so publish failures must not block capture.
      }
    }
    return delivered;
  }

  async function pollOnce() {
    if (driver !== 'fs') return { ok: true, driver, delivered: 0, read: 0 };
    _primeOffset();
    let stat;
    try { stat = fs.statSync(busPath); } catch (_) { return { ok: true, driver, delivered: 0, read: 0 }; }
    if (stat.size < readOffset) {
      readOffset = 0;
      partialLine = '';
    }
    if (stat.size === readOffset) return { ok: true, driver, delivered: 0, read: 0 };
    let chunk = '';
    try {
      const fd = fs.openSync(busPath, 'r');
      try {
        const len = stat.size - readOffset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, readOffset);
        chunk = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      readOffset = stat.size;
    } catch (_) {
      return { ok: false, driver, error: 'capture_pubsub_read_failed', delivered: 0, read: 0 };
    }
    const text = partialLine + chunk;
    const lines = text.split(/\n/);
    partialLine = lines.pop() || '';
    let delivered = 0;
    let read = 0;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let env;
      try { env = JSON.parse(t); } catch (_) { continue; }
      const id = _clean(env.pubsub_id);
      if (id && seenPubsubIds.has(id)) continue;
      if (id) seenPubsubIds.add(id);
      if (seenPubsubIds.size > 10000) {
        const keep = Array.from(seenPubsubIds).slice(-5000);
        seenPubsubIds.clear();
        for (const x of keep) seenPubsubIds.add(x);
      }
      read++;
      delivered += _deliverLocal(env.obs);
    }
    return { ok: true, driver, delivered, read };
  }

  function subscriberCount(tenant) {
    if (tenant) return (subscribers.get(tenant) || new Set()).size;
    let n = 0;
    for (const set of subscribers.values()) n += set.size;
    return n;
  }

  function close() {
    subscribers.clear();
    if (pollTimer) {
      try { clearInterval(pollTimer); } catch (_) {}
      pollTimer = null;
    }
  }

  return Object.freeze({
    version: CAPTURE_STREAM_PUBSUB_VERSION,
    driver,
    bus_path: driver === 'fs' ? busPath : null,
    subscribe,
    publishCapture,
    subscriberCount,
    pollOnce,
    close,
  });
}

let defaultBrokerSignature = null;
let defaultBroker = null;

function _defaultBrokerConfig() {
  return {
    driver: _defaultDriver(),
    bus_path: _defaultBusPath(),
  };
}

function _getDefaultBroker() {
  const cfg = _defaultBrokerConfig();
  const sig = `${cfg.driver}:${cfg.bus_path}`;
  if (!defaultBroker || defaultBrokerSignature !== sig) {
    try { defaultBroker?.close?.(); } catch (_) {}
    defaultBroker = createCaptureBroker(cfg);
    defaultBrokerSignature = sig;
  }
  return defaultBroker;
}

export function subscribe(tenant, namespace, sink) {
  return _getDefaultBroker().subscribe(tenant, namespace, sink);
}

export function publishCapture(obs) {
  return _getDefaultBroker().publishCapture(obs);
}

export async function pollCapturePubsubOnce() {
  return await _getDefaultBroker().pollOnce();
}

export function subscriberCount(tenant) {
  return _getDefaultBroker().subscriberCount(tenant);
}

// Used by tests so subscriber maps and env-driven broker selection do not leak.
export function _resetSubscribers() {
  try { defaultBroker?.close?.(); } catch (_) {}
  defaultBroker = null;
  defaultBrokerSignature = null;
}
