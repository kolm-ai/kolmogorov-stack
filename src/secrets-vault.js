import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SPEC = 'kolm-secrets-vault/1';
const KEY_BYTES = 32;

const EXTERNAL_REF_PREFIXES = [
  'aws-secrets-manager:',
  'vault:',
  'onepassword:',
  'gcp-secret-manager:',
  'azure-keyvault:',
  'doppler:',
  'infisical:',
];

function home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function rootDir() {
  return process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(home(), '.kolm');
}

function vaultPath() {
  return path.join(rootDir(), 'secrets-vault.json');
}

function keyPath() {
  return path.join(rootDir(), 'secrets-vault.key');
}

function ensureDir() {
  fs.mkdirSync(rootDir(), { recursive: true });
}

function getOrCreateKey() {
  ensureDir();
  const p = keyPath();
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf8').trim();
    const buf = Buffer.from(raw, 'hex');
    if (buf.length === KEY_BYTES) return buf;
  }
  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(p, key.toString('hex'), 'utf8');
  try { fs.chmodSync(p, 0o600); } catch {} // deliberate: cleanup
  return key;
}

function readVault() {
  ensureDir();
  const p = vaultPath();
  if (!fs.existsSync(p)) return { spec: SPEC, secrets: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { spec: SPEC, secrets: {} };
    if (!parsed.secrets || typeof parsed.secrets !== 'object') parsed.secrets = {};
    parsed.spec = parsed.spec || SPEC;
    return parsed;
  } catch {
    return { spec: SPEC, secrets: {} };
  }
}

function writeVault(vault) {
  ensureDir();
  fs.writeFileSync(vaultPath(), JSON.stringify(vault, null, 2), 'utf8');
  try { fs.chmodSync(vaultPath(), 0o600); } catch {} // deliberate: cleanup
}

function encrypt(value) {
  const key = getOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'AES-256-GCM',
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

function decrypt(record) {
  const key = getOrCreateKey();
  const iv = Buffer.from(record.iv, 'base64url');
  const tag = Buffer.from(record.tag, 'base64url');
  const ciphertext = Buffer.from(record.ciphertext, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function cleanId(id) {
  const out = String(id || '').trim().replace(/[^a-zA-Z0-9_.:/#-]/g, '-').slice(0, 160);
  if (!out) throw Object.assign(new Error('secret id required'), { code: 'bad_secret_id' });
  return out;
}

export function isExternalSecretRef(ref) {
  const s = String(ref || '');
  return EXTERNAL_REF_PREFIXES.some((p) => s.startsWith(p));
}

export function isSecretRef(ref) {
  const s = String(ref || '');
  return s.startsWith('env:') || s.startsWith('local:') || isExternalSecretRef(s);
}

export function putSecret({ id, value, scope = 'tenant', labels = {}, note = '' } = {}) {
  const secretId = cleanId(id);
  if (value == null || value === '') {
    throw Object.assign(new Error('secret value required'), { code: 'bad_secret_value' });
  }
  const vault = readVault();
  const now = new Date().toISOString();
  const enc = encrypt(value);
  vault.secrets[secretId] = {
    id: secretId,
    ref: `local:${secretId}`,
    scope,
    labels,
    note: String(note || '').slice(0, 240),
    created_at: vault.secrets[secretId]?.created_at || now,
    updated_at: now,
    alg: enc.alg,
    iv: enc.iv,
    tag: enc.tag,
    ciphertext: enc.ciphertext,
    value_sha256: crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'),
  };
  writeVault(vault);
  return redactSecretEnvelope(vault.secrets[secretId]);
}

export function getSecret(idOrRef) {
  const ref = String(idOrRef || '');
  const id = cleanId(ref.startsWith('local:') ? ref.slice('local:'.length) : ref);
  const vault = readVault();
  const row = vault.secrets[id];
  if (!row) return null;
  return { ...redactSecretEnvelope(row), value: decrypt(row) };
}

export function listSecretRefs({ includeLocal = true, includeEnv = false } = {}) {
  const refs = [];
  if (includeLocal) {
    const vault = readVault();
    for (const row of Object.values(vault.secrets || {})) refs.push(redactSecretEnvelope(row));
  }
  if (includeEnv) {
    for (const [k, v] of Object.entries(process.env)) {
      if (!v) continue;
      if (/(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_KEY)$/i.test(k)) {
        refs.push({ ref: `env:${k}`, type: 'env', configured: true, value_included: false });
      }
    }
  }
  return refs.sort((a, b) => String(a.ref).localeCompare(String(b.ref)));
}

export function deleteSecret(idOrRef) {
  const ref = String(idOrRef || '');
  const id = cleanId(ref.startsWith('local:') ? ref.slice('local:'.length) : ref);
  const vault = readVault();
  const existed = !!vault.secrets[id];
  delete vault.secrets[id];
  writeVault(vault);
  return { ok: true, deleted: existed, ref: `local:${id}` };
}

export function buildExternalSecretIntent(ref) {
  const s = String(ref || '').trim();
  if (!isExternalSecretRef(s)) {
    throw Object.assign(new Error(`not an external secret ref: ${s}`), { code: 'bad_secret_ref' });
  }
  const [kind] = s.split(':', 1);
  return {
    ok: true,
    ref: s,
    type: 'external',
    provider: kind,
    value_included: false,
    resolution: 'runtime-provider-integration',
    install_hint: providerHint(kind),
  };
}

function providerHint(kind) {
  if (kind === 'aws-secrets-manager') return 'Grant the Kolm runtime IAM permission secretsmanager:GetSecretValue for this ARN.';
  if (kind === 'vault') return 'Set VAULT_ADDR and mount a token/role on the runtime host; the artifact stores only the vault path.';
  if (kind === 'onepassword') return 'Install 1Password service account credentials on the runtime host; the artifact stores only vault/item/field.';
  if (kind === 'gcp-secret-manager') return 'Grant secretmanager.versions.access to the runtime service account.';
  if (kind === 'azure-keyvault') return 'Grant Key Vault get permission to the runtime managed identity.';
  return 'Resolve this secret in the runtime environment; Kolm stores only the reference.';
}

export function resolveSecretRef(ref, { allowEnv = true, allowLocal = true, includeValue = true } = {}) {
  const s = String(ref || '').trim();
  if (s.startsWith('env:')) {
    const key = s.slice(4);
    const configured = allowEnv && Object.prototype.hasOwnProperty.call(process.env, key);
    return {
      ok: configured,
      ref: s,
      type: 'env',
      configured,
      value_included: configured && includeValue,
      value: configured && includeValue ? process.env[key] : undefined,
      reason: configured ? null : 'env_var_not_set',
    };
  }
  if (s.startsWith('local:')) {
    if (!allowLocal) return { ok: false, ref: s, type: 'local', configured: false, value_included: false, reason: 'local_secret_resolution_disabled' };
    const row = getSecret(s);
    return row
      ? { ok: true, ref: s, type: 'local', configured: true, value_included: includeValue, value: includeValue ? row.value : undefined, metadata: { ...row, value: undefined } }
      : { ok: false, ref: s, type: 'local', configured: false, value_included: false, reason: 'local_secret_not_found' };
  }
  if (isExternalSecretRef(s)) return buildExternalSecretIntent(s);
  return { ok: false, ref: s, type: 'unknown', configured: false, value_included: false, reason: 'unsupported_secret_ref' };
}

export function redactSecretEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const {
    value,
    ciphertext,
    iv,
    tag,
    ...rest
  } = envelope;
  void value; void ciphertext; void iv; void tag;
  return {
    ...rest,
    ref: rest.ref || (rest.id ? `local:${rest.id}` : undefined),
    value_included: false,
    encrypted_at_rest: !!envelope.ciphertext,
  };
}

export function secretVaultStatus() {
  const vault = readVault();
  return {
    ok: true,
    spec: vault.spec,
    local_secret_count: Object.keys(vault.secrets || {}).length,
    vault_path: vaultPath(),
    key_path: keyPath(),
    external_ref_prefixes: EXTERNAL_REF_PREFIXES.slice(),
    value_included: false,
  };
}

export default {
  putSecret,
  getSecret,
  listSecretRefs,
  deleteSecret,
  resolveSecretRef,
  buildExternalSecretIntent,
  isSecretRef,
  isExternalSecretRef,
  redactSecretEnvelope,
  secretVaultStatus,
};
