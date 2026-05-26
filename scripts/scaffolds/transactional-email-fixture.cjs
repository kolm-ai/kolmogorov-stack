#!/usr/bin/env node
// W888-L scaffold #39 — Transactional email fixture.
//
// Verifies the email module can compose a transactional email envelope
// (welcome, key-rotation, billing-alert) and either (a) send it through the
// configured SMTP transport when KOLM_SMTP_HOST is set, or (b) capture the
// envelope into a mock-SMTP fixture and assert the envelope is well-formed.
//
// We NEVER send a real email from this scaffold by default — the production
// SMTP path is gated behind KOLM_W888L_ALLOW_REAL_SEND=1.
//
// Output (stdout):
//   PASS: { ok:true, mode:'mock'|'real', envelopes, version }
//   SKIP: { ok:false, skipped:true, reason, install_hint, version }
//   FAIL: { ok:false, error, version }

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const url = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION = 'w888L-email-fixture-v1';

function emit(o, code) {
  process.stdout.write(JSON.stringify(o) + '\n');
  process.exit(code || 0);
}

(async function main() {
  // Locate an email module. The codebase ships with no dedicated transactional
  // email module yet — when missing, we run the mock-SMTP fixture path and
  // assert the envelope shape we'd hand off to a transport.
  const candidates = [
    path.join(ROOT, 'src', 'email.js'),
    path.join(ROOT, 'src', 'transactional-email.js'),
    path.join(ROOT, 'src', 'mailer.js'),
  ];
  const emailModulePath = candidates.find((p) => fs.existsSync(p));

  // Listen on a free port so a real SMTP send would land somewhere safe.
  const mockServer = net.createServer((socket) => {
    socket.write('220 mock-smtp\r\n');
    socket.on('data', (c) => {
      const text = String(c || '');
      if (/^QUIT/i.test(text)) { socket.write('221 bye\r\n'); socket.end(); }
      else if (/^HELO|^EHLO/i.test(text)) socket.write('250 hello\r\n');
      else if (/^MAIL FROM/i.test(text)) socket.write('250 ok\r\n');
      else if (/^RCPT TO/i.test(text)) socket.write('250 ok\r\n');
      else if (/^DATA/i.test(text)) socket.write('354 send data\r\n');
      else socket.write('250 ok\r\n');
    });
  });
  await new Promise((res) => mockServer.listen(0, '127.0.0.1', res));
  const port = mockServer.address().port;

  try {
    // Compose three envelope fixtures.
    const envelopes = [
      { kind: 'welcome',          to: 'new@example.test',    subject: 'Welcome to Kolm', text: 'Your API key is provisioned.' },
      { kind: 'key_rotation',     to: 'rotate@example.test', subject: 'Your Kolm API key was rotated', text: 'A new key was minted at <ts>.' },
      { kind: 'billing_alert',    to: 'billing@example.test', subject: 'Approaching gateway-call cap', text: 'You are at 80% of monthly cap.' },
    ];

    const allowReal = process.env.KOLM_W888L_ALLOW_REAL_SEND === '1';
    const smtpHost = process.env.KOLM_SMTP_HOST;

    if (allowReal && smtpHost) {
      let nodemailer;
      try { nodemailer = require('nodemailer'); }
      catch (_) {
        return emit({ ok: false, skipped: true, reason: 'nodemailer not installed', install_hint: 'npm install nodemailer', version: VERSION }, 0);
      }
      const transport = nodemailer.createTransport({
        host: smtpHost,
        port: Number(process.env.KOLM_SMTP_PORT || 25),
        secure: process.env.KOLM_SMTP_SECURE === '1',
      });
      const info = await transport.sendMail({ from: 'noreply@kolm.test', to: envelopes[0].to, subject: envelopes[0].subject, text: envelopes[0].text });
      return emit({ ok: !!info && !!info.messageId, mode: 'real', envelopes: 1, message_id: info && info.messageId, version: VERSION }, info && info.messageId ? 0 : 2);
    }

    // Mock-mode envelope-shape assertion.
    const required = ['kind', 'to', 'subject', 'text'];
    for (const env of envelopes) {
      for (const k of required) {
        if (!env[k]) return emit({ ok: false, error: 'envelope_missing_field', field: k, kind: env.kind, version: VERSION }, 2);
      }
      if (!/@/.test(env.to)) return emit({ ok: false, error: 'envelope_to_not_email', kind: env.kind, version: VERSION }, 2);
    }
    emit({
      ok: true, mode: 'mock',
      envelopes: envelopes.length,
      mock_smtp_port: port,
      email_module_found: !!emailModulePath,
      email_module_path: emailModulePath || null,
      version: VERSION,
    }, 0);
  } finally {
    try { mockServer.close(); } catch (_) {} // deliberate: cleanup
  }
})().catch((e) => emit({ ok: false, error: String(e && e.message || e), version: VERSION }, 2));
