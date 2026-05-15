import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const DEV_RECEIPT_SECRET = 'ks_receipt_dev_secret_change_in_prod';

export function isProductionRuntime() {
  return process.env.NODE_ENV === 'production' ||
    !!process.env.RAILWAY_ENVIRONMENT ||
    !!process.env.VERCEL ||
    !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

export function effectiveReceiptSecret({ includeLegacyArtifactSecret = false } = {}) {
  const secret = process.env.RECIPE_RECEIPT_SECRET ||
    (includeLegacyArtifactSecret ? process.env.KOLM_ARTIFACT_SECRET : '');
  if (secret) {
    if (isProductionRuntime() && !receiptSecretLooksProductionSafe(secret)) return null;
    return secret;
  }
  return isProductionRuntime() ? null : DEV_RECEIPT_SECRET;
}

// Per-tenant receipt secret. If the tenant carries its own receipt_secret +
// receipt_key_id, return those. Otherwise fall back to the global secret with
// the implicit key_id "global". Callers should persist the key_id alongside
// every signed row so future verification can dispatch on it after a tenant
// rotates their key.
//
// Schema (tenants table): tenant.receipt_secret (string), tenant.receipt_key_id
// (string, e.g. "tk_<tenant>_<short-hex>"), tenant.receipt_rotated_at (iso).
// Rotation appends to tenant.previous_receipt_secrets[] so receipts signed
// with the previous key still verify until the operator chooses to drop them.
export function effectiveReceiptSecretForTenant(tenant, { includeLegacyArtifactSecret = false } = {}) {
  if (tenant && typeof tenant.receipt_secret === 'string' && tenant.receipt_secret.length >= 32) {
    return { secret: tenant.receipt_secret, key_id: tenant.receipt_key_id || `tk_${tenant.id || 'unknown'}_1` };
  }
  const globalSecret = effectiveReceiptSecret({ includeLegacyArtifactSecret });
  return { secret: globalSecret, key_id: 'global' };
}

// All known verification keys for a tenant — current + previous (for rotation).
// Verifiers walk this list and accept the first match.
export function tenantReceiptVerificationKeys(tenant) {
  const out = [];
  if (tenant && typeof tenant.receipt_secret === 'string' && tenant.receipt_secret.length >= 32) {
    out.push({ secret: tenant.receipt_secret, key_id: tenant.receipt_key_id || `tk_${tenant.id || 'unknown'}_1` });
  }
  if (tenant && Array.isArray(tenant.previous_receipt_secrets)) {
    for (const prev of tenant.previous_receipt_secrets) {
      if (prev && typeof prev.secret === 'string' && prev.secret.length >= 32) {
        out.push({ secret: prev.secret, key_id: prev.key_id || 'previous' });
      }
    }
  }
  const globalSecret = effectiveReceiptSecret({ includeLegacyArtifactSecret: true });
  if (globalSecret) out.push({ secret: globalSecret, key_id: 'global' });
  return out;
}

export function runtimeReadiness() {
  const productionLike = isProductionRuntime();
  const receiptSecret = process.env.RECIPE_RECEIPT_SECRET || '';
  const receiptSecretStrong = receiptSecretLooksProductionSafe(receiptSecret);
  const receiptSecretOk = !productionLike ||
    (!!receiptSecret && receiptSecretStrong);
  const dataDir = process.env.KOLM_DATA_DIR || '';
  const artifactDir = process.env.KOLM_ARTIFACT_DIR || '';
  const storeDriver = configuredStoreDriver();
  const dataDirOk = !productionLike || directoryWritable(dataDir);
  const artifactDirOk = !productionLike || directoryWritable(artifactDir);
  const sqliteDir = path.dirname(path.resolve(process.env.KOLM_DB_PATH || path.join(dataDir || '.', 'kolm.sqlite')));
  const sqliteAvailable = storeDriver !== 'sqlite' || nodeSqliteAvailable();
  const sqlitePathOk = storeDriver !== 'sqlite' || directoryWritable(sqliteDir);
  const storeDriverOk = !productionLike ||
    (storeDriver === 'sqlite' && sqliteAvailable && sqlitePathOk) ||
    process.env.KOLM_ALLOW_JSON_STORE === 'true';

  const checks = [
    {
      name: 'receipt_secret',
      ok: receiptSecretOk,
      required: productionLike,
      public: 'receipt signing secret configured',
      hint: productionLike
        ? 'set RECIPE_RECEIPT_SECRET to a stable production-only value of at least 32 characters'
        : 'development uses an in-process fallback receipt secret',
    },
    {
      name: 'admin_key',
      ok: !productionLike || !!process.env.ADMIN_KEY,
      required: false,
      public: 'admin key configured',
      hint: productionLike
        ? 'set ADMIN_KEY if staff-only admin endpoints are needed'
        : 'development may use the fallback admin key',
    },
    {
      name: 'model_provider',
      ok: !!process.env.ANTHROPIC_API_KEY,
      required: false,
      public: 'frontier model provider configured',
      hint: 'set ANTHROPIC_API_KEY for verified inference and cloud teacher calls',
    },
    {
      name: 'store_driver',
      ok: storeDriverOk,
      required: productionLike,
      public: 'database-backed store configured',
      hint: productionLike
        ? 'set KOLM_STORE_DRIVER=sqlite and KOLM_DB_PATH, or explicitly set KOLM_ALLOW_JSON_STORE=true for a temporary single-node deployment'
        : `using ${storeDriver} store driver`,
    },
    {
      name: 'data_dir',
      ok: dataDirOk,
      required: productionLike,
      public: 'data directory writable',
      hint: productionLike
        ? 'set KOLM_DATA_DIR to an existing writable durable mounted volume or database-backed path'
        : (process.env.KOLM_DATA_DIR ? 'KOLM_DATA_DIR is set' : 'using the default ./data directory'),
    },
    {
      name: 'artifact_dir',
      ok: artifactDirOk,
      required: productionLike,
      public: 'artifact directory writable',
      hint: productionLike
        ? 'set KOLM_ARTIFACT_DIR to an existing writable durable storage path for compiled .kolm downloads'
        : (process.env.KOLM_ARTIFACT_DIR ? 'KOLM_ARTIFACT_DIR is set' : 'using temporary artifact output by default'),
    },
  ];

  const blocking = checks.filter(check => check.required && !check.ok);
  return {
    status: blocking.length ? 'not_ready' : 'ready',
    production_like: productionLike,
    checks,
  };
}

function configuredStoreDriver() {
  if (process.env.KOLM_STORE_DRIVER) {
    return process.env.KOLM_STORE_DRIVER.toLowerCase();
  }
  // Mirror src/store.js auto-detection: in production-like environments
  // SQLite is the default whenever node:sqlite is available.
  if (isProductionRuntime() && nodeSqliteAvailable()) return 'sqlite';
  return 'json';
}

function nodeSqliteAvailable() {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

function directoryWritable(dir) {
  if (!dir) return false;
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return false;
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function receiptSecretLooksProductionSafe(secret) {
  return typeof secret === 'string' &&
    secret.length >= 32 &&
    secret !== DEV_RECEIPT_SECRET &&
    !/^ks_receipt_(live|test|dev|change)/i.test(secret);
}
