import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(repo, 'public');

const exempt = new Set([
  'public/spec/rs-1.html',
  'public/spec/kolm-format-v1.html',
  'public/spec/codebase.html',
  'public/spec/changelog.html',
  'public/spec/spec.html',
  'public/docs/rs-1.html',
  'public/docs/rs-1.md',
  'public/docs/receipt-v0.1.json',
  'public/docs/webhooks.html',
  'public/docs/glossary.html',
  'public/docs/i18n/de.html',
  'public/docs/i18n/es.html',
  'public/docs/i18n/fr.html',
  'public/docs/i18n/ja.html',
  'public/docs/i18n/ko.html',
  'public/docs/i18n/zh.html',
  'public/articles/kolm-file-format.html',
  'public/research/receipt-chains.html',
  'public/research/receipt-chain.html',
  'public/format/v2.html',
  'public/spec.html',
  'public/glossary.html',
  'public/changelog.html',
  'public/device.html'
]);

const replacements = [
  [/HMAC-SHA256 artifact signature/g, 'Ed25519 artifact signature'],
  [/HMAC-SHA256/g, 'Ed25519'],
  [/HMAC-SHA-256/g, 'Ed25519'],
  [/HMAC-SHA256 signature/g, 'Ed25519 signature'],
  [/HMAC-SHA256 verified/g, 'Ed25519 verified'],
  [/HMAC-SHA256 4-ring receipt chain/g, 'Ed25519 public-key receipt chain'],
  [/HMAC-SHA256 receipt chain/g, 'Ed25519 receipt chain'],
  [/HMAC-SHA-256 receipt chain/g, 'Ed25519 receipt chain'],
  [/HMAC-SHA-256 signing/g, 'Ed25519 signing'],
  [/HMAC-signed archive/g, 'Ed25519-signed archive'],
  [/HMAC-signed manifest/g, 'Ed25519-signed manifest'],
  [/HMAC-signed <code>\.kolm<\/code> archive/g, 'Ed25519-signed <code>.kolm</code> archive'],
  [/HMAC receipt chain/g, 'Ed25519 receipt chain'],
  [/HMAC receipt/g, 'Ed25519 receipt'],
  [/HMAC receipts/g, 'Ed25519 receipts'],
  [/HMAC chain/g, 'Ed25519 receipt chain'],
  [/HMAC ledger/g, 'Ed25519 receipt log'],
  [/HMAC secret/g, 'Ed25519 private key'],
  [/HMAC key/g, 'Ed25519 private key'],
  [/HMAC verifier/g, 'Ed25519 verifier'],
  [/\bHMAC\b/g, 'Ed25519'],
  [/hmac\(prev,/g, 'sign(prev,'],
  [/HMAC valid/g, 'signature valid'],
  [/HMAC-valid/g, 'signature-valid'],
  [/hmac-sha256/g, 'ed25519'],
  [/signature_alg&quot;:&quot;ed25519/g, 'signature_alg&quot;:&quot;ed25519'],
  [/signature:  HMAC-SHA256/g, 'signature:  Ed25519'],
  [/signature:  valid \(hmac-local\)/g, 'signature:  valid (ed25519)'],
  [/frontier API bill becomes a deposit account/g, 'frontier calls become reviewed training data'],
  [/frontier API becomes a deposit account/g, 'frontier calls become reviewed training data'],
  [/local LoRA adapter/g, 'local student artifact'],
  [/local LoRA/g, 'local student artifact'],
  [/LoRA fit/g, 'student fit']
];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && /\.(html|md)$/i.test(entry.name)) files.push(full);
  }
  return files;
}

let changed = 0;
for (const file of walk(publicDir)) {
  const rel = 'public/' + path.relative(publicDir, file).split(path.sep).join('/');
  if (exempt.has(rel)) continue;
  let text = fs.readFileSync(file, 'utf8');
  let next = text;
  for (const [pattern, value] of replacements) {
    next = next.replace(pattern, value);
  }
  if (next !== text) {
    fs.writeFileSync(file, next);
    changed += 1;
  }
}

console.log(`copy sweep changed ${changed} files`);
