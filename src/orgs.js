// W918 P5.1 — Multi-user organisations with RBAC.
//
// Storage shape (single JSON document at data/orgs.json):
//   { orgs: { [org_id]: Org },
//     members: { [org_id]: { [user_id]: Member } },
//     invites: { [invite_id]: Invite } }
//
// Append-only audit ledger at data/orgs-audit.jsonl. One JSON object per line.
//
// File writes are sync read-modify-write. Atomicity is guaranteed by writing
// the new document to a sibling tmp file then renaming over the target — the
// rename is atomic on POSIX and best-effort-retried on Windows.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { isValidRole, requireRole, ROLES } from './rbac.js';

const STORE_FILENAME = 'orgs.json';
const AUDIT_FILENAME = 'orgs-audit.jsonl';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function dataDir() {
  return process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.resolve('data');
}

function storePath() {
  return path.join(dataDir(), STORE_FILENAME);
}

function auditPath() {
  return path.join(dataDir(), AUDIT_FILENAME);
}

function ensureDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
}

function emptyDoc() {
  return { orgs: {}, members: {}, invites: {} };
}

function loadDoc() {
  ensureDir();
  const p = storePath();
  if (!fs.existsSync(p)) return emptyDoc();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyDoc();
    return {
      orgs: parsed.orgs && typeof parsed.orgs === 'object' ? parsed.orgs : {},
      members: parsed.members && typeof parsed.members === 'object' ? parsed.members : {},
      invites: parsed.invites && typeof parsed.invites === 'object' ? parsed.invites : {},
    };
  } catch {
    return emptyDoc();
  }
}

function renameWithRetry(tmp, file) {
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err && err.code)) throw err;
      const wait = 5 * (2 ** attempt);
      const until = Date.now() + wait;
      while (Date.now() < until) { /* short busy-wait — file lock contention */ }
    }
  }
  try {
    fs.copyFileSync(tmp, file);
    try { fs.rmSync(tmp, { force: true }); } catch { /* deliberate: cleanup */ }
    return;
  } catch {
    throw lastErr;
  }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameWithRetry(tmp, file);
}

function saveDoc(doc) {
  atomicWrite(storePath(), JSON.stringify(doc, null, 2));
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function getMembersBucket(doc, orgId) {
  if (!doc.members[orgId]) doc.members[orgId] = {};
  return doc.members[orgId];
}

function actingRole(doc, orgId, actingUserId) {
  const bucket = doc.members[orgId];
  if (!bucket) return null;
  const m = bucket[actingUserId];
  return m && m.role ? m.role : null;
}

function recomputeMemberCount(doc, orgId) {
  const bucket = doc.members[orgId] || {};
  const count = Object.keys(bucket).length;
  if (doc.orgs[orgId]) doc.orgs[orgId].member_count = count;
  return count;
}

function findMemberByEmail(doc, orgId, email) {
  const bucket = doc.members[orgId] || {};
  const needle = String(email || '').trim().toLowerCase();
  if (!needle) return null;
  for (const userId of Object.keys(bucket)) {
    const m = bucket[userId];
    if (m && String(m.email || '').toLowerCase() === needle) return m;
  }
  return null;
}

function appendAudit(row) {
  ensureDir();
  fs.appendFileSync(auditPath(), JSON.stringify(row) + '\n', { encoding: 'utf8' });
}

export function auditEvent(orgId, { actor_user_id, kind, target, payload } = {}) {
  const row = {
    at: nowIso(),
    org_id: orgId || null,
    actor_user_id: actor_user_id || null,
    kind: kind || 'unknown',
    target: target === undefined ? null : target,
    payload: payload === undefined ? null : payload,
  };
  appendAudit(row);
  return row;
}

export function createOrg({ name, ownerUserId, ownerEmail } = {}) {
  if (!name || typeof name !== 'string') throw new Error('createOrg: name is required');
  if (!ownerUserId) throw new Error('createOrg: ownerUserId is required');
  if (!ownerEmail) throw new Error('createOrg: ownerEmail is required');

  const doc = loadDoc();
  const orgId = newId('org');
  const createdAt = nowIso();
  const org = {
    org_id: orgId,
    name,
    created_at: createdAt,
    member_count: 1,
    owner_user_id: ownerUserId,
  };
  doc.orgs[orgId] = org;
  const bucket = getMembersBucket(doc, orgId);
  bucket[ownerUserId] = {
    user_id: ownerUserId,
    email: ownerEmail,
    role: ROLES.OWNER,
    joined_at: createdAt,
  };
  saveDoc(doc);
  auditEvent(orgId, {
    actor_user_id: ownerUserId,
    kind: 'org.create',
    target: orgId,
    payload: { name, owner_user_id: ownerUserId },
  });
  return { ...org };
}

export function getOrg(orgId) {
  const doc = loadDoc();
  const org = doc.orgs[orgId];
  return org ? { ...org } : null;
}

export function listOrgsForUser(userId) {
  if (!userId) return [];
  const doc = loadDoc();
  const out = [];
  for (const orgId of Object.keys(doc.orgs)) {
    const bucket = doc.members[orgId] || {};
    if (bucket[userId]) out.push({ ...doc.orgs[orgId] });
  }
  return out;
}

export function listMembers(orgId) {
  const doc = loadDoc();
  const bucket = doc.members[orgId] || {};
  return Object.values(bucket).map(m => ({
    user_id: m.user_id,
    email: m.email,
    role: m.role,
    joined_at: m.joined_at,
  }));
}

export function addMember(orgId, { user_id, email, role, acting_user_id } = {}) {
  if (!user_id) throw new Error('addMember: user_id is required');
  if (!email) throw new Error('addMember: email is required');
  if (!isValidRole(role)) throw new Error(`addMember: invalid role ${JSON.stringify(role)}`);
  if (role === ROLES.OWNER) throw new Error('addMember: cannot add owner directly — use transferOwnership');
  if (!acting_user_id) throw new Error('addMember: acting_user_id is required');

  const doc = loadDoc();
  if (!doc.orgs[orgId]) throw new Error(`addMember: org ${orgId} not found`);
  const actorRole = actingRole(doc, orgId, acting_user_id);
  if (!actorRole) throw new Error(`forbidden: ${acting_user_id} is not a member of ${orgId}`);
  requireRole(actorRole, 'member:add');

  const bucket = getMembersBucket(doc, orgId);
  if (bucket[user_id]) throw new Error(`addMember: user ${user_id} already in ${orgId}`);
  const member = {
    user_id,
    email,
    role,
    joined_at: nowIso(),
  };
  bucket[user_id] = member;
  recomputeMemberCount(doc, orgId);
  saveDoc(doc);
  auditEvent(orgId, {
    actor_user_id: acting_user_id,
    kind: 'member.add',
    target: user_id,
    payload: { email, role },
  });
  return { ...member };
}

export function removeMember(orgId, userIdOrEmail, actingUserId) {
  if (!actingUserId) throw new Error('removeMember: actingUserId is required');
  const doc = loadDoc();
  const org = doc.orgs[orgId];
  if (!org) throw new Error(`removeMember: org ${orgId} not found`);

  const bucket = doc.members[orgId] || {};
  let target = bucket[userIdOrEmail] || null;
  if (!target) target = findMemberByEmail(doc, orgId, userIdOrEmail);
  if (!target) return false;

  if (target.user_id === org.owner_user_id) {
    throw new Error('removeMember: cannot remove the owner — transfer ownership first');
  }

  const actorRole = actingRole(doc, orgId, actingUserId);
  if (!actorRole) throw new Error(`forbidden: ${actingUserId} is not a member of ${orgId}`);
  // Self-removal is allowed for non-owners regardless of action capability.
  if (target.user_id !== actingUserId) {
    requireRole(actorRole, 'member:remove');
  }

  delete bucket[target.user_id];
  recomputeMemberCount(doc, orgId);
  saveDoc(doc);
  auditEvent(orgId, {
    actor_user_id: actingUserId,
    kind: 'member.remove',
    target: target.user_id,
    payload: { email: target.email, role: target.role },
  });
  return true;
}

export function setRole(orgId, userId, role, actingUserId) {
  if (!actingUserId) throw new Error('setRole: actingUserId is required');
  if (!isValidRole(role)) throw new Error(`setRole: invalid role ${JSON.stringify(role)}`);

  const doc = loadDoc();
  const org = doc.orgs[orgId];
  if (!org) throw new Error(`setRole: org ${orgId} not found`);
  const bucket = doc.members[orgId] || {};
  const target = bucket[userId];
  if (!target) throw new Error(`setRole: user ${userId} not in ${orgId}`);

  const actorRole = actingRole(doc, orgId, actingUserId);
  if (!actorRole) throw new Error(`forbidden: ${actingUserId} is not a member of ${orgId}`);
  requireRole(actorRole, 'member:role:change');

  // Promotion to owner is reserved for transferOwnership.
  if (role === ROLES.OWNER) {
    throw new Error('setRole: cannot promote to owner — use transferOwnership');
  }
  // Admins cannot change the owner's role at all.
  if (target.user_id === org.owner_user_id) {
    throw new Error('setRole: cannot change the owner\'s role — transfer ownership first');
  }
  // Admins cannot change another admin's role (only owner can demote admins).
  if (actorRole === ROLES.ADMIN && target.role === ROLES.ADMIN && actingUserId !== userId) {
    throw new Error('forbidden: admin cannot change another admin\'s role');
  }

  const before = target.role;
  target.role = role;
  saveDoc(doc);
  auditEvent(orgId, {
    actor_user_id: actingUserId,
    kind: 'member.role.change',
    target: userId,
    payload: { from: before, to: role },
  });
  return { ...target };
}

export function transferOwnership(orgId, newOwnerUserId, actingUserId) {
  if (!actingUserId) throw new Error('transferOwnership: actingUserId is required');
  if (!newOwnerUserId) throw new Error('transferOwnership: newOwnerUserId is required');

  const doc = loadDoc();
  const org = doc.orgs[orgId];
  if (!org) throw new Error(`transferOwnership: org ${orgId} not found`);
  if (org.owner_user_id !== actingUserId) {
    throw new Error('forbidden: only the current owner can transfer ownership');
  }

  const actorRole = actingRole(doc, orgId, actingUserId);
  requireRole(actorRole || '', 'owner:transfer');

  const bucket = doc.members[orgId] || {};
  const incoming = bucket[newOwnerUserId];
  if (!incoming) {
    throw new Error(`transferOwnership: incoming owner ${newOwnerUserId} must already be a member`);
  }
  if (newOwnerUserId === actingUserId) {
    throw new Error('transferOwnership: new owner is already the current owner');
  }

  const previousOwnerId = org.owner_user_id;
  incoming.role = ROLES.OWNER;
  if (bucket[previousOwnerId]) bucket[previousOwnerId].role = ROLES.ADMIN;
  org.owner_user_id = newOwnerUserId;
  saveDoc(doc);
  auditEvent(orgId, {
    actor_user_id: actingUserId,
    kind: 'owner.transfer',
    target: newOwnerUserId,
    payload: { previous_owner: previousOwnerId },
  });
  return { ...org };
}

export function inviteMember(orgId, { email, role, actingUserId } = {}) {
  if (!email) throw new Error('inviteMember: email is required');
  if (!isValidRole(role)) throw new Error(`inviteMember: invalid role ${JSON.stringify(role)}`);
  if (role === ROLES.OWNER) throw new Error('inviteMember: cannot invite as owner — use transferOwnership');
  if (!actingUserId) throw new Error('inviteMember: actingUserId is required');

  const doc = loadDoc();
  if (!doc.orgs[orgId]) throw new Error(`inviteMember: org ${orgId} not found`);
  const actorRole = actingRole(doc, orgId, actingUserId);
  if (!actorRole) throw new Error(`forbidden: ${actingUserId} is not a member of ${orgId}`);
  requireRole(actorRole, 'invite:create');

  const inviteId = newId('inv');
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const invite = {
    invite_id: inviteId,
    org_id: orgId,
    email: String(email).trim().toLowerCase(),
    role,
    token,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + INVITE_TTL_MS).toISOString(),
    consumed_at: null,
    consumed_by: null,
    revoked_at: null,
  };
  doc.invites[inviteId] = invite;
  saveDoc(doc);
  auditEvent(orgId, {
    actor_user_id: actingUserId,
    kind: 'invite.create',
    target: inviteId,
    payload: { email: invite.email, role },
  });
  return { ...invite };
}

export function acceptInvite(token, { user_id, email } = {}) {
  if (!token) throw new Error('acceptInvite: token is required');
  if (!user_id) throw new Error('acceptInvite: user_id is required');
  if (!email) throw new Error('acceptInvite: email is required');

  const doc = loadDoc();
  let invite = null;
  for (const id of Object.keys(doc.invites)) {
    if (doc.invites[id].token === token) { invite = doc.invites[id]; break; }
  }
  if (!invite) throw new Error('acceptInvite: invite not found');
  if (invite.consumed_at) throw new Error('acceptInvite: invite already consumed');
  if (invite.revoked_at) throw new Error('acceptInvite: invite revoked');
  if (Date.parse(invite.expires_at) < Date.now()) throw new Error('acceptInvite: invite expired');

  const requestedEmail = String(email).trim().toLowerCase();
  if (requestedEmail !== invite.email) {
    throw new Error('acceptInvite: email does not match the invite');
  }

  const orgId = invite.org_id;
  if (!doc.orgs[orgId]) throw new Error(`acceptInvite: org ${orgId} no longer exists`);
  const bucket = getMembersBucket(doc, orgId);
  if (bucket[user_id]) {
    invite.consumed_at = nowIso();
    invite.consumed_by = user_id;
    saveDoc(doc);
    auditEvent(orgId, {
      actor_user_id: user_id,
      kind: 'invite.accept',
      target: invite.invite_id,
      payload: { already_member: true, email: requestedEmail, role: invite.role },
    });
    return { ...bucket[user_id] };
  }

  const member = {
    user_id,
    email: requestedEmail,
    role: invite.role,
    joined_at: nowIso(),
  };
  bucket[user_id] = member;
  invite.consumed_at = nowIso();
  invite.consumed_by = user_id;
  recomputeMemberCount(doc, orgId);
  saveDoc(doc);
  auditEvent(orgId, {
    actor_user_id: user_id,
    kind: 'invite.accept',
    target: invite.invite_id,
    payload: { email: requestedEmail, role: invite.role },
  });
  return { ...member };
}
