// One-shot harness: exercise the exact two-tier path the hero verifier runs in
// the browser, against the shipped sample report + keyring. Confirms the seal
// reads "Verified · demo" (tier-1 PASS + tier-2 recognized/demo), and that a
// rogue-key re-sign (the Forge control) clears tier-1 but fails tier-2.
import { readFileSync } from 'node:fs';
import {
  verifyAuditReport,
  issuerProvenance,
  canonicalizeReport,
  keyFingerprintFromPem,
} from '../public/kolm-audit-verify.js';

const base = new URL('../public/', import.meta.url);
const report = JSON.parse(readFileSync(new URL('sample-audit-report.json', base)));
const keyring = JSON.parse(readFileSync(new URL('keys/kolm-issuers.json', base)));

function seal(label, t1, prov) {
  const ok = t1.ok;
  let line;
  if (!ok) line = 'VOID';
  else if (prov.recognized && prov.status === 'production') line = 'Verified';
  else if (prov.recognized && prov.status === 'demo') line = 'Verified · demo';
  else if (prov.recognized) line = `Verified · ${prov.status}`;
  else line = 'Signed · issuer unknown';
  console.log(`\n[${label}] seal => ${line}`);
  console.log(`  tier1 ok=${ok}${ok ? '' : '  reason=' + t1.reason}`);
  console.log(`  tier2 recognized=${prov.recognized} kid=${prov.kid || '-'} status=${prov.status || '-'}`);
  return line;
}

// ---- genuine path ----
const t1 = await verifyAuditReport(report);
const prov = issuerProvenance(report, keyring);
const genuine = seal('GENUINE', t1, prov);
for (const c of t1.checks) console.log(`    ${c.ok ? 'PASS' : 'FAIL'}  ${c.name} :: ${c.detail}`);

// ---- forge with a rogue key (mirrors widget._buildForgedReport) ----
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
let bin = '';
for (const b of spki) bin += String.fromCharCode(b);
const b64 = btoa(bin).match(/.{1,64}/g).join('\n');
const pem = `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
const forged = JSON.parse(JSON.stringify(report));
forged.signature_ed25519.public_key = pem;
forged.signature_ed25519.key_fingerprint = await keyFingerprintFromPem(pem);
forged.signature_ed25519.signed_at = forged.generated_at;
const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', kp.privateKey,
  new TextEncoder().encode(canonicalizeReport(forged))));
let sbin = '';
for (const b of sig) sbin += String.fromCharCode(b);
forged.signature_ed25519.signature = btoa(sbin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ft1 = await verifyAuditReport(forged);
const fprov = issuerProvenance(forged, keyring);
const forgedSeal = seal('FORGED (rogue key)', ft1, fprov);

// ---- inflate the score (tamper) ----
const tampered = JSON.parse(JSON.stringify(report));
tampered.summary.readiness_pct = 100;
const tt1 = await verifyAuditReport(tampered);
const tprov = issuerProvenance(tampered, keyring);
const tamperSeal = seal('TAMPERED (readiness 0->100)', tt1, tprov);

console.log('\n==== STOP-TEST ASSERTIONS ====');
const a1 = genuine === 'Verified · demo';
const a2 = ft1.ok === true && fprov.recognized === false; // tier1 clears, tier2 fails
const a3 = tt1.ok === false; // inflate breaks tier1
console.log(`  genuine == "Verified · demo"            : ${a1 ? 'PASS' : 'FAIL (' + genuine + ')'}`);
console.log(`  forge clears tier1 + fails tier2        : ${a2 ? 'PASS' : 'FAIL'}`);
console.log(`  inflate breaks tier1 (VOID)             : ${a3 ? 'PASS' : 'FAIL'}`);
console.log(`\n  ALL: ${a1 && a2 && a3 ? 'PASS' : 'FAIL'}`);
process.exit(a1 && a2 && a3 ? 0 : 1);
