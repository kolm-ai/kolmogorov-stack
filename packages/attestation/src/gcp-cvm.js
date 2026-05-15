// Google Cloud Confidential VM attestation parser.
//
// GCP CVMs use either AMD SEV-SNP or Intel TDX under the hood. The
// attestation surface is the underlying vendor format wrapped in a JSON
// envelope from the GCP instance metadata service:
//
//   GET metadata.google.internal/computeMetadata/v1/instance/attributes/attestation
//
// returns either:
//   { provider: 'gcp', technology: 'sev-snp', report: '<base64>' }
//   { provider: 'gcp', technology: 'tdx',     quote:  '<base64>' }
//
// We dispatch to the underlying parser and tag vendor as 'gcp' so callers
// can distinguish a GCP CVM measurement from a bare-metal SEV-SNP one.

import { parseSevSnpAttestation } from './sev-snp.js';
import { parseTdxAttestation } from './tdx.js';

export function parseGcpCvmAttestation(payload) {
  const env = normalizeEnvelope(payload);
  if (env.technology === 'sev-snp' && env.report) {
    const inner = parseSevSnpAttestation(env.report);
    return { ...inner, vendor: 'gcp', claims: { ...inner.claims, technology: 'sev-snp', csp: 'gcp' } };
  }
  if (env.technology === 'tdx' && env.quote) {
    const inner = parseTdxAttestation(env.quote);
    return { ...inner, vendor: 'gcp', claims: { ...inner.claims, technology: 'tdx', csp: 'gcp' } };
  }
  throw new Error('gcp-cvm payload missing technology=sev-snp|tdx + report|quote');
}

function normalizeEnvelope(payload) {
  if (typeof payload === 'object' && payload && payload.technology) {
    return payload;
  }
  if (typeof payload === 'string') {
    try {
      const obj = JSON.parse(payload);
      if (obj && obj.technology) return obj;
    } catch {
      // not JSON
    }
  }
  throw new Error('gcp-cvm payload must be {technology, report|quote, ...}');
}
