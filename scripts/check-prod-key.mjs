import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fpFromPrivatePem(pem) {
  const priv = crypto.createPrivateKey(pem);
  if (priv.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519: ' + priv.asymmetricKeyType);
  const pub = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
  const der = crypto.createPublicKey(pub).export({ type: 'spki', format: 'der' });
  const fp = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  return { fp, pub };
}

const home = os.homedir();
const prodPem = fs.readFileSync(path.join(home, '.kolm', 'prod-signing-key.pem'), 'utf8');
const demoPem = fs.readFileSync(path.join(home, '.kolm', 'signing-key.pem'), 'utf8');
const prod = fpFromPrivatePem(prodPem);
const demo = fpFromPrivatePem(demoPem);

const keyring = JSON.parse(fs.readFileSync(path.resolve('public/keys/kolm-issuers.json'), 'utf8'));
const issuers = (keyring.issuers || []).map((i) => ({ kid: i.kid, status: i.status, fp: i.key_fingerprint }));

console.log('prod-signing-key.pem  fp =', prod.fp);
console.log('signing-key.pem(demo) fp =', demo.fp);
console.log('keyring issuers:', JSON.stringify(issuers, null, 2));

const prodIssuer = issuers.find((i) => i.status === 'production' || i.kid === 'kolm-prod-2026');
const demoIssuer = issuers.find((i) => i.status === 'demo' || i.kid === 'kolm-demo-2026');
console.log('\nprod key matches published production issuer:', prodIssuer && prodIssuer.fp === prod.fp, '(' + (prodIssuer && prodIssuer.fp) + ')');
console.log('demo key matches published demo issuer      :', demoIssuer && demoIssuer.fp === demo.fp, '(' + (demoIssuer && demoIssuer.fp) + ')');
