// Azure Confidential VM attestation parser.
//
// Azure CVMs use either AMD SEV-SNP or Intel TDX. Attestation flows through
// Microsoft Azure Attestation (MAA), which returns a JWT bearing the
// underlying hardware report claims. JWT verification (against the MAA JWKS
// at https://shareduks.uks.attest.azure.net/certs) is deferred — at parse
// time we extract the embedded measurement directly.
//
// Input shapes accepted:
//   - {token: '<JWT>'}                       — raw MAA JWT
//   - {sevsnp_report: '<base64>'}            — raw SEV-SNP report
//   - {tdx_quote: '<base64>'}                — raw TDX quote
//   - {provider:'azure', technology, ...}    — pre-classified envelope

import { Buffer } from 'node:buffer';
import { parseSevSnpAttestation } from './sev-snp.js';
import { parseTdxAttestation } from './tdx.js';

export function parseAzureCvmAttestation(payload) {
  const env = normalizeEnvelope(payload);
  if (env.sevsnp_report) {
    const inner = parseSevSnpAttestation(env.sevsnp_report);
    return { ...inner, vendor: 'azure', claims: { ...inner.claims, technology: 'sev-snp', csp: 'azure' } };
  }
  if (env.tdx_quote) {
    const inner = parseTdxAttestation(env.tdx_quote);
    return { ...inner, vendor: 'azure', claims: { ...inner.claims, technology: 'tdx', csp: 'azure' } };
  }
  if (env.token) {
    const claims = decodeJwtClaims(env.token);
    const measurement = claims['x-ms-attestation-type'] === 'sevsnpvm'
      ? `mrtd:sha384:${claims['x-ms-sevsnpvm-launchmeasurement'] || ''}`
      : claims['x-ms-attestation-type'] === 'tdxvm'
        ? `mrtd:sha384:${claims['x-ms-tdxvm-mrtd'] || ''}`
        : null;
    if (!measurement || measurement.endsWith('sha384:')) {
      throw new Error('azure MAA JWT did not carry recognised measurement claim');
    }
    return {
      vendor: 'azure',
      measurement,
      claims: {
        technology: claims['x-ms-attestation-type'],
        csp: 'azure',
        signed_at: claims.iat ? new Date(claims.iat * 1000).toISOString() : null,
        jwt_iss: claims.iss || null,
        jwt_aud: claims.aud || null,
      },
      signing_cert_chain: null,
    };
  }
  throw new Error('azure-cvm payload requires token, sevsnp_report, or tdx_quote');
}

function normalizeEnvelope(payload) {
  if (typeof payload === 'object' && payload) return payload;
  if (typeof payload === 'string') {
    try {
      const obj = JSON.parse(payload);
      if (obj && typeof obj === 'object') return obj;
    } catch {
      // Maybe a raw JWT.
      if (payload.split('.').length === 3) return { token: payload };
    }
  }
  throw new Error('azure-cvm payload must be JSON envelope or raw JWT');
}

function decodeJwtClaims(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  const body = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(body);
}
