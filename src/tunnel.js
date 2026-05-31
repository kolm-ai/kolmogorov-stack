// Remote-access tunnel — broker between a public URL and a user-run .kolm
// runtime on the operator's hardware.
//
// Honest framing: kolm.ai is the relay. Requests land here at /r/<token>/...,
// are queued for the agent (the user's local `kolm tunnel` process), the agent
// pulls them over an authenticated SSE stream, runs the artifact locally, and
// posts the response back. The model + data live on the operator's machine.
// The relay sees request/response bytes in transit (no TLS termination
// inside the user's machine), so privacy of the request payload depends on
// trusting kolm.ai during transit. For full payload-blind operation, use the
// BYOC TEE deployment instead.
//
// State is in-memory (Map) plus a `tunnels` table for durable identity. If
// the broker restarts, agents reconnect on their next poll cycle and the
// queue drains over a fresh process.

import crypto from 'node:crypto';
import { id, insert, find, findOne, update, all } from './store.js';

const TUNNEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;        // 7 days idle TTL
const REQUEST_TIMEOUT_MS = 30 * 1000;                  // public-URL waiter timeout
const AGENT_IDLE_PING_MS = 25 * 1000;                  // SSE keepalive
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;             // 2MB request body cap

// tunnelToken → { agent: SSE res, pending: Map<requestId, {resolve, reject, expiresAt}> }
const live = new Map();

function newToken() { return 'tnl_' + crypto.randomBytes(18).toString('base64url'); }
function newRequestId() { return 'req_' + crypto.randomBytes(8).toString('hex'); }

function sanitizeName(s) {
  return String(s || '').replace(/[<>"']/g, '').slice(0, 60).trim();
}

export function registerTunnel({ tenantId, tenantName, teamId = null, name = 'tunnel', publicBase = 'https://kolm.ai', stable = false }) {
  if (!tenantId) throw new Error('tenantId required');
  const token = newToken();
  const now = new Date();
  // W936 — a `stable` team-model endpoint must not expire on the 7-day idle TTL
  // (members share one persistent URL). Use a 100-year expiry so every existing
  // expires_at check and purgeExpired() naturally treats it as live.
  const STABLE_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
  const tunnel = {
    id: id('tnl'),
    token,
    tenant_id: tenantId,
    tenant_name: tenantName,
    team_id: teamId || null,
    stable: !!stable,
    name: sanitizeName(name),
    public_url: `${publicBase.replace(/\/+$/, '')}/r/${token}`,
    status: 'pending',           // pending → active when agent first connects
    created_at: now.toISOString(),
    last_seen_at: null,
    expires_at: new Date(now.getTime() + (stable ? STABLE_TTL_MS : TUNNEL_TTL_MS)).toISOString(),
    requests_count: 0,
    bytes_in: 0,
    bytes_out: 0,
  };
  insert('tunnels', tunnel);
  return tunnel;
}

export function getTunnelByToken(token) {
  if (!token) return null;
  return findOne('tunnels', t => t.token === token && !t._deleted);
}

export function listTunnelsForTenant(tenantId, { teamId = null } = {}) {
  return find('tunnels', t => !t._deleted && (t.tenant_id === tenantId || (teamId && t.team_id === teamId)))
    .map(t => ({ ...t, live: live.has(t.token) }));
}

export function closeTunnel(token, byTenantId) {
  const t = getTunnelByToken(token);
  if (!t) return false;
  if (t.tenant_id !== byTenantId) throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
  const ent = live.get(token);
  if (ent) {
    try { ent.agent.end(); } catch {} // deliberate: cleanup
    for (const p of ent.pending.values()) p.reject(new Error('tunnel closed'));
    live.delete(token);
  }
  update('tunnels', x => x.token === token, { status: 'closed', closed_at: new Date().toISOString() });
  return true;
}

export function attachAgent(token, res) {
  const t = getTunnelByToken(token);
  if (!t) return { ok: false, status: 404, error: 'tunnel not found' };
  if (new Date(t.expires_at) < new Date()) return { ok: false, status: 410, error: 'tunnel expired' };
  // If an agent already attached, knock the old one off (last-write wins).
  const prev = live.get(token);
  if (prev) {
    try { prev.agent.end(); } catch {} // deliberate: cleanup
    for (const p of prev.pending.values()) p.reject(new Error('agent replaced'));
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(`event: hello\ndata: ${JSON.stringify({ token, tunnel_id: t.id, server_time: new Date().toISOString() })}\n\n`);
  const ent = { agent: res, pending: new Map(), pingTimer: null };
  ent.pingTimer = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); }
    catch {} // deliberate: cleanup
  }, AGENT_IDLE_PING_MS);
  if (ent.pingTimer.unref) ent.pingTimer.unref();
  live.set(token, ent);
  update('tunnels', x => x.token === token, { status: 'active', last_seen_at: new Date().toISOString() });
  res.on('close', () => {
    clearInterval(ent.pingTimer);
    if (live.get(token) === ent) live.delete(token);
    update('tunnels', x => x.token === token, { status: 'pending', disconnected_at: new Date().toISOString() });
    for (const p of ent.pending.values()) p.reject(new Error('agent disconnected'));
  });
  return { ok: true };
}

// Send a request through the tunnel. Resolves when the agent posts a response,
// rejects on timeout / disconnect. Returns the agent's response object.
export function forwardRequest(token, { method, headers, path, body }) {
  return new Promise((resolve, reject) => {
    const t = getTunnelByToken(token);
    if (!t) return reject(Object.assign(new Error('tunnel not found'), { status: 404 }));
    if (new Date(t.expires_at) < new Date()) {
      return reject(Object.assign(new Error('tunnel expired'), { status: 410 }));
    }
    const ent = live.get(token);
    if (!ent) {
      return reject(Object.assign(new Error('no agent connected — start `kolm tunnel` on your machine'), { status: 502 }));
    }
    const bodyText = body == null ? '' : (Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
    if (Buffer.byteLength(bodyText, 'utf8') > MAX_PAYLOAD_BYTES) {
      return reject(Object.assign(new Error('request body too large (>2MB)'), { status: 413 }));
    }
    const requestId = newRequestId();
    const expiresAt = Date.now() + REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => {
      ent.pending.delete(requestId);
      reject(Object.assign(new Error('tunnel request timed out'), { status: 504 }));
    }, REQUEST_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    ent.pending.set(requestId, {
      resolve: (val) => { clearTimeout(timer); resolve(val); },
      reject: (err) => { clearTimeout(timer); reject(err); },
      expiresAt,
    });
    try {
      const evt = `event: request\ndata: ${JSON.stringify({ request_id: requestId, method, headers, path, body: bodyText })}\n\n`;
      ent.agent.write(evt);
    } catch (err) {
      ent.pending.delete(requestId);
      clearTimeout(timer);
      return reject(Object.assign(new Error('agent write failed: ' + err.message), { status: 502 }));
    }
    update('tunnels', x => x.token === token, {
      requests_count: (t.requests_count || 0) + 1,
      bytes_in: (t.bytes_in || 0) + Buffer.byteLength(bodyText, 'utf8'),
      last_seen_at: new Date().toISOString(),
    });
  });
}

export function agentRespond(token, requestId, { status, headers, body }) {
  const ent = live.get(token);
  if (!ent) return { ok: false, error: 'tunnel not attached' };
  const waiter = ent.pending.get(requestId);
  if (!waiter) return { ok: false, error: 'request not found or already responded' };
  ent.pending.delete(requestId);
  const bodyText = body == null ? '' : String(body);
  update('tunnels', x => x.token === token, {
    bytes_out: (getTunnelByToken(token)?.bytes_out || 0) + Buffer.byteLength(bodyText, 'utf8'),
    last_seen_at: new Date().toISOString(),
  });
  waiter.resolve({ status: status || 200, headers: headers || {}, body: bodyText });
  return { ok: true };
}

export function tunnelStats() {
  const out = [];
  for (const [token, ent] of live) {
    out.push({ token, pending: ent.pending.size });
  }
  return out;
}

export function purgeExpired() {
  const now = Date.now();
  const expired = all('tunnels').filter(t => !t._deleted && new Date(t.expires_at).getTime() < now);
  for (const t of expired) {
    const ent = live.get(t.token);
    if (ent) {
      try { ent.agent.end(); } catch {} // deliberate: cleanup
      live.delete(t.token);
    }
    update('tunnels', x => x.id === t.id, { _deleted: true, status: 'expired' });
  }
  return expired.length;
}
