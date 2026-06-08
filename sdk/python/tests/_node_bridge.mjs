// Test-only bridge to the REAL Node canonicalization + verifier, so the Python
// SDK's pure-Python reimplementation can be checked byte-for-byte against the
// authoritative source (src/attestation-report-builder.js).
//
// Usage:
//   node _node_bridge.mjs canon        <jsonFile>   -> writes canonicalize(data) bytes
//   node _node_bridge.mjs canonreport  <jsonFile>   -> writes canonicalizeReport(data) bytes
//   node _node_bridge.mjs verify       <jsonFile>   -> writes JSON.stringify(verifyReport(data))
import { canonicalize, canonicalizeReport, verifyReport } from '../../../src/attestation-report-builder.js';
import fs from 'node:fs';

const mode = process.argv[2];
const file = process.argv[3];
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

if (mode === 'canon') {
  process.stdout.write(Buffer.from(canonicalize(data), 'utf8'));
} else if (mode === 'canonreport') {
  process.stdout.write(Buffer.from(canonicalizeReport(data), 'utf8'));
} else if (mode === 'verify') {
  process.stdout.write(JSON.stringify(verifyReport(data)));
} else {
  process.stderr.write(`unknown mode: ${mode}`);
  process.exit(2);
}
