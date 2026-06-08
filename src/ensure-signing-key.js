// Trust-moat bootstrap: guarantee an Ed25519 signing key exists + persists so kolm
// NEVER ships unsigned artifacts/receipts (the live prod instance had signing_key:missing,
// which the SOTA review flagged as existential - provenance is the whole moat).
//
// Strategy: if no explicit key is provided via KOLM_ED25519_PRIVATE_KEY, place the key
// under the durable data volume (KOLM_DATA_DIR/keys) - NOT ~/.kolm which is ephemeral on
// a fresh container - generate one on first boot, and point KOLM_ED25519_KEY_STORE at it so
// the signer, keys.js, and /health all agree. Idempotent; safe at every boot.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPair } from './ed25519.js';

export function ensureSigningKey() {
  if (process.env.KOLM_ED25519_PRIVATE_KEY) return { ok: true, source: 'env' };
  const storeDir = process.env.KOLM_ED25519_KEY_STORE
    || (process.env.KOLM_DATA_DIR ? path.join(process.env.KOLM_DATA_DIR, 'keys') : path.join(os.homedir(), '.kolm'));
  // Make the store visible to the signer + keys.js + /health (all read this env / default).
  process.env.KOLM_ED25519_KEY_STORE = storeDir;
  const keyPath = path.join(storeDir, 'signing-key.pem');
  try {
    if (fs.existsSync(keyPath)) return { ok: true, source: 'disk', path: keyPath };
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const kp = generateKeyPair();
    fs.writeFileSync(keyPath, kp.privateKey, { mode: 0o600 });
    if (kp.publicKey) {
      try { fs.writeFileSync(path.join(storeDir, 'signing-key.pub.pem'), kp.publicKey, { mode: 0o644 }); } catch { /* non-fatal */ }
    }
    return { ok: true, source: 'generated', path: keyPath };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export default ensureSigningKey;
