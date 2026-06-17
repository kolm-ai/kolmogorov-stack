// W670 - direct contract for packages/attestation/src/tdx.js.
//
// Exercises Intel TDX quote parsing at the package boundary: corrected TD10
// report-body offsets, bounded input decoding, non-zero MR_TD enforcement, and
// normalized dispatcher behavior.

import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import {
  parseTdxAttestation,
  TDX_BODY_LEN,
  TDX_HEADER_LEN,
  TDX_MIN_QUOTE_LEN,
} from '../packages/attestation/src/tdx.js';
import { parseAttestation } from '../packages/attestation/src/index.js';

const BODY_OFFSETS = Object.freeze({
  mr_seam: 16,
  mr_td: 136,
  mr_config_id: 184,
  mr_owner: 232,
  rt_mr0: 328,
  rt_mr1: 376,
  rt_mr2: 424,
  rt_mr3: 472,
  report_data: 520,
});

function fill(buf, bodyOffset, byte, len = 48) {
  const abs = TDX_HEADER_LEN + bodyOffset;
  for (let i = 0; i < len; i++) buf[abs + i] = byte;
}

function makeQuote({ signatureBytes = 32 } = {}) {
  const buf = Buffer.alloc(TDX_MIN_QUOTE_LEN + signatureBytes);
  buf.writeUInt16LE(4, 0);
  buf.writeUInt16LE(2, 2);
  buf.writeUInt32LE(0x81, 4);
  buf.writeUInt16LE(7, 8);
  buf.writeUInt16LE(11, 10);
  fill(buf, BODY_OFFSETS.mr_seam, 0xcc);
  fill(buf, BODY_OFFSETS.mr_td, 0xdd);
  fill(buf, BODY_OFFSETS.mr_config_id, 0xee);
  fill(buf, BODY_OFFSETS.mr_owner, 0x77);
  fill(buf, BODY_OFFSETS.rt_mr0, 0x31);
  fill(buf, BODY_OFFSETS.rt_mr1, 0x32);
  fill(buf, BODY_OFFSETS.rt_mr2, 0x33);
  fill(buf, BODY_OFFSETS.rt_mr3, 0x34);
  fill(buf, BODY_OFFSETS.report_data, 0xab, 64);
  for (let i = TDX_MIN_QUOTE_LEN; i < buf.length; i++) buf[i] = 0x5a;
  return buf;
}

test('W670 TDX parser extracts MR_TD and RTMRs from corrected TD10 body offsets', () => {
  const quote = makeQuote();
  const parsed = parseTdxAttestation(quote);

  assert.equal(TDX_HEADER_LEN, 48);
  assert.equal(TDX_BODY_LEN, 584);
  assert.equal(TDX_MIN_QUOTE_LEN, 632);
  assert.equal(parsed.vendor, 'intel');
  assert.equal(parsed.measurement, `mrtd:sha384:${'dd'.repeat(48)}`);
  assert.equal(parsed.claims.mr_seam, 'cc'.repeat(48));
  assert.equal(parsed.claims.mr_config_id, 'ee'.repeat(48));
  assert.equal(parsed.claims.mr_owner, '77'.repeat(48));
  assert.deepEqual(parsed.claims.rt_mrs, [
    '31'.repeat(48),
    '32'.repeat(48),
    '33'.repeat(48),
    '34'.repeat(48),
  ]);
  assert.equal(parsed.claims.report_data, 'ab'.repeat(64));
  assert.equal(parsed.claims.quote_signature_data_len, 32);
  assert.equal(parsed.claims.evidence_tier, 'shape_only');
  assert.equal(parsed.signing_cert_chain, null);
});

test('W670 TDX parser accepts hex strings and object-wrapped base64url quotes', () => {
  const quote = makeQuote({ signatureBytes: 0 });

  const fromHex = parseTdxAttestation(quote.toString('hex'));
  assert.equal(fromHex.measurement, `mrtd:sha384:${'dd'.repeat(48)}`);

  const fromObject = parseTdxAttestation({ quote: quote.toString('base64url') });
  assert.equal(fromObject.measurement, fromHex.measurement);
  assert.equal(fromObject.claims.quote_size, TDX_MIN_QUOTE_LEN);
});

test('W670 TDX parser fails closed on malformed, zero, unsupported, and oversized quotes', () => {
  assert.throws(() => parseTdxAttestation(Buffer.alloc(TDX_MIN_QUOTE_LEN - 1)), /too short/);
  assert.throws(() => parseTdxAttestation('not a quote!'), /hex, base64, or base64url/);

  const zeroMeasurement = makeQuote();
  fill(zeroMeasurement, BODY_OFFSETS.mr_td, 0x00);
  assert.throws(() => parseTdxAttestation(zeroMeasurement), /non-zero MR_TD/);

  const badVersion = makeQuote();
  badVersion.writeUInt16LE(3, 0);
  assert.throws(() => parseTdxAttestation(badVersion), /unsupported tdx quote version/);

  process.env.KOLM_ATTESTATION_MAX_TDX_QUOTE_BYTES = String(TDX_MIN_QUOTE_LEN - 1);
  try {
    assert.throws(() => parseTdxAttestation(makeQuote({ signatureBytes: 0 })), /too large/);
  } finally {
    delete process.env.KOLM_ATTESTATION_MAX_TDX_QUOTE_BYTES;
  }
});

test('W670 TDX dispatcher preserves normalized attestation shape', () => {
  const parsed = parseAttestation('tdx', makeQuote({ signatureBytes: 0 }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.target, 'tdx');
  assert.equal(parsed.vendor, 'intel');
  assert.equal(parsed.measurement, `mrtd:sha384:${'dd'.repeat(48)}`);
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.parsed_at);
  assert.equal(parsed.claims.evidence_tier, 'shape_only');
});
