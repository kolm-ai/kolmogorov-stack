// CONVERSATIONS - tenant-scoped chat backup over the existing event-store.
//
// No new table, no schema migration: every conversation is one row in the
// canonical event-store (src/event-store.js), keyed on the conversation_id as
// the event_id. INSERT OR REPLACE semantics in appendEvent make save() an
// idempotent upsert (exactly like capture-store's bridge path).
//
// The event schema (src/event-schema.js) drops unknown keys in canonicalize(),
// so we map the conversation onto fields the schema preserves rather than a
// free-form blob: the full {conversation_id,title,messages,...} payload is
// JSON-serialized into `media_extracted_text` (preserved up to 1 MiB - exactly
// our body cap) with media_kind='transcript' + media_mime='application/json',
// and the title is mirrored into `feedback` (cheap to read without parsing the
// whole payload). The columns we set (namespace/provider/model/status/
// created_at) let list/get fence + sort without deserializing every row.
//
// Isolation: provider tag 'kolm-chat' + namespace 'chat.conversation' keep
// these rows out of every gateway/capture surface (lake, dataset workbench,
// optimizer, label queue) - those read their own namespaces/providers and
// never ingest chat backups.
//
// Tenant fence: every read passes {namespace, tenant_id} to listEvents so the
// SQL/JSONL layer only returns the caller's rows; get/delete additionally
// re-check row.tenant_id in-process (defense in depth, since getEvent is not
// tenant-filtered). The HTTP layer (src/router.js) enforces auth before any
// of these run.

import crypto from 'node:crypto';
import { appendEvent, listEvents, getEvent } from './event-store.js';

export const CHAT_NAMESPACE = 'chat.conversation';
export const CHAT_PROVIDER = 'kolm-chat';

// Server-side caps (mirror the spec): keep a single conversation row bounded so
// one tenant cannot blow up the event-store with a runaway backup.
export const MAX_MESSAGES = 2000;
export const MAX_CONTENT_BYTES = 32 * 1024;   // per-message content
export const MAX_BODY_BYTES = 1024 * 1024;    // whole conversation body

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function byteLen(s) {
  return Buffer.byteLength(typeof s === 'string' ? s : String(s ?? ''), 'utf8');
}

// Custom error so the route layer can map to the right HTTP status without
// string-sniffing. `.status` is the HTTP code; `.code` is a stable token.
export class ConversationError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'ConversationError';
    this.status = status;
    this.code = code;
  }
}

function newConversationId() {
  return 'cv_' + crypto.randomBytes(8).toString('hex');
}

// Normalize + validate the messages array. Throws ConversationError(413/400).
function normalizeMessages(raw) {
  if (!Array.isArray(raw)) {
    throw new ConversationError(400, 'invalid_messages', 'messages must be an array');
  }
  if (raw.length > MAX_MESSAGES) {
    throw new ConversationError(413, 'too_many_messages', `messages exceeds cap of ${MAX_MESSAGES}`);
  }
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') {
      throw new ConversationError(400, 'invalid_message', 'each message must be an object');
    }
    const role = ROLES.has(m.role) ? m.role : 'user';
    const content = m.content == null ? '' : String(m.content);
    if (byteLen(content) > MAX_CONTENT_BYTES) {
      throw new ConversationError(413, 'message_too_large', `a message content exceeds ${MAX_CONTENT_BYTES} bytes`);
    }
    const msg = { role, content };
    if (m.ts != null) msg.ts = String(m.ts);
    out.push(msg);
  }
  return out;
}

function firstUserText(messages) {
  const u = messages.find((m) => m.role === 'user' && m.content);
  return u ? String(u.content) : '';
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].content) return String(messages[i].content);
  }
  return '';
}

// save/upsert. tenantId is required (the route fences before calling). Returns
// { ok, conversation_id, updated_at, message_count }.
export async function saveConversation(tenantId, body = {}) {
  if (!tenantId) throw new ConversationError(401, 'auth_required', 'tenant required');
  if (!body || typeof body !== 'object') {
    throw new ConversationError(400, 'invalid_body', 'request body must be an object');
  }
  // Whole-body byte cap. Measured on the caller-supplied shape so a single
  // huge backup is rejected before it touches the store.
  if (byteLen(JSON.stringify(body)) > MAX_BODY_BYTES) {
    throw new ConversationError(413, 'body_too_large', `conversation body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const model = body.model == null ? '' : String(body.model);
  if (!model) throw new ConversationError(400, 'model_required', 'model is required');

  const conversation_id = body.conversation_id ? String(body.conversation_id) : newConversationId();
  const messages = normalizeMessages(body.messages || []);
  const message_count = messages.length;
  const title = body.title
    ? String(body.title).slice(0, 80)
    : (firstUserText(messages).slice(0, 80) || 'Untitled conversation');
  const device = body.device != null ? String(body.device) : null;
  const client_updated_at = body.updated_at != null ? String(body.updated_at) : null;
  const created_at = new Date().toISOString();

  const payload = {
    conversation_id,
    title,
    model,
    messages,
    message_count,
    device,
    client_updated_at,
  };

  await appendEvent({
    event_id: conversation_id,
    tenant_id: tenantId,
    namespace: CHAT_NAMESPACE,
    provider: CHAT_PROVIDER,
    model,
    status: 'ok',
    source_type: 'real',
    created_at,
    // Conversation payload rides in media_extracted_text (preserved up to 1
    // MiB by canonicalize); media_kind/mime tag it as a JSON transcript.
    media_kind: 'transcript',
    media_mime: 'application/json',
    media_extracted_text: JSON.stringify(payload),
    // Title mirror so list() can show it without parsing the full payload.
    feedback: title,
  });

  return { ok: true, conversation_id, updated_at: created_at, message_count };
}

// Pull the per-conversation payload out of an event row. The payload was
// JSON-serialized into media_extracted_text; fall back to the column mirrors if
// it is ever missing/corrupt so reads never throw.
function conversationFromEvent(ev) {
  if (!ev) return null;
  let c = {};
  if (ev.media_extracted_text) {
    try { c = JSON.parse(ev.media_extracted_text) || {}; } catch { c = {}; }
  }
  const messages = Array.isArray(c.messages) ? c.messages : [];
  return {
    conversation_id: c.conversation_id || ev.event_id,
    title: c.title || ev.feedback || 'Untitled conversation',
    model: c.model || ev.model || null,
    messages,
    message_count: typeof c.message_count === 'number' ? c.message_count : messages.length,
    updated_at: ev.created_at,
    device: c.device != null ? c.device : null,
    client_updated_at: c.client_updated_at != null ? c.client_updated_at : null,
    deleted: ev.status === 'blocked' || !!c.deleted,
  };
}

// list - metadata only (never full messages). Newest first.
export async function listConversations(tenantId, opts = {}) {
  if (!tenantId) throw new ConversationError(401, 'auth_required', 'tenant required');
  let limit = Number(opts.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  limit = Math.min(200, Math.trunc(limit));
  const query = {
    namespace: CHAT_NAMESPACE,
    tenant_id: tenantId,
    // Over-fetch a little so soft-deleted rows we filter out don't shrink the
    // page below `limit`. Capped so we never scan unboundedly.
    limit: Math.min(400, limit * 2),
  };
  if (opts.model) query.model = String(opts.model);
  if (opts.since) query.since = String(opts.since);
  const rows = await listEvents(query); // newest first (listEvents default desc)
  const conversations = [];
  for (const ev of rows) {
    if (ev.tenant_id !== tenantId) continue; // defense in depth
    const c = conversationFromEvent(ev);
    if (c.deleted) continue;
    conversations.push({
      conversation_id: c.conversation_id,
      title: c.title,
      model: c.model,
      message_count: c.message_count,
      updated_at: c.updated_at,
      preview: lastUserText(c.messages).slice(0, 120),
    });
    if (conversations.length >= limit) break;
  }
  return { ok: true, conversations, count: conversations.length };
}

// get - full conversation. 404 (via ConversationError) on miss / tenant
// mismatch / soft-deleted.
export async function getConversation(tenantId, id) {
  if (!tenantId) throw new ConversationError(401, 'auth_required', 'tenant required');
  const ev = await getEvent(String(id || ''));
  if (!ev || ev.tenant_id !== tenantId || ev.namespace !== CHAT_NAMESPACE) {
    throw new ConversationError(404, 'not_found', 'conversation not found');
  }
  const c = conversationFromEvent(ev);
  if (c.deleted) throw new ConversationError(404, 'not_found', 'conversation not found');
  return {
    ok: true,
    conversation: {
      conversation_id: c.conversation_id,
      title: c.title,
      model: c.model,
      messages: c.messages,
      message_count: c.message_count,
      updated_at: c.updated_at,
    },
  };
}

// delete - soft delete. purgeEvents only supports before/namespace (not a
// single event_id), so the honest minimal path is a tombstone upsert on the
// same event_id with status='blocked' + json.deleted:true; list/get filter it
// out. 404 on miss / tenant mismatch.
export async function deleteConversation(tenantId, id) {
  if (!tenantId) throw new ConversationError(401, 'auth_required', 'tenant required');
  const eventId = String(id || '');
  const ev = await getEvent(eventId);
  if (!ev || ev.tenant_id !== tenantId || ev.namespace !== CHAT_NAMESPACE) {
    throw new ConversationError(404, 'not_found', 'conversation not found');
  }
  if (ev.status === 'blocked') {
    // Already gone - idempotent success rather than a confusing 404.
    return { ok: true, deleted: true };
  }
  let prior = {};
  if (ev.media_extracted_text) { try { prior = JSON.parse(ev.media_extracted_text) || {}; } catch { prior = {}; } }
  const deleted_at = new Date().toISOString();
  await appendEvent({
    event_id: eventId,
    tenant_id: tenantId,
    namespace: CHAT_NAMESPACE,
    provider: CHAT_PROVIDER,
    model: prior.model || ev.model || '',
    status: 'blocked', // tombstone marker - list/get filter status==='blocked'
    source_type: 'real',
    created_at: ev.created_at, // preserve original timestamp; tombstone is a state, not a new event
    media_kind: 'transcript',
    media_mime: 'application/json',
    media_extracted_text: JSON.stringify({ ...prior, conversation_id: eventId, deleted: true, deleted_at }),
    feedback: prior.title || ev.feedback || null,
  });
  return { ok: true, deleted: true };
}
