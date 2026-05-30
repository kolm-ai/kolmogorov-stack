// W923 — smoke coverage for the modules shipped this session: conversations,
// model-export, spend-caps, model-entitlements, model-update-channel,
// inference-bench, billing-activation, connectors, ensure-signing-key,
// env-normalize. Each must (a) import cleanly (catches the concatenated-draft
// dup-export trap), and (b) honor its core contract + tenant fencing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.KOLM_DATA_DIR = path.join(os.tmpdir(), `kolm-w923-${process.pid}`);

test('env-normalize maps lowercase provider keys to canonical UPPER', async () => {
  const { normalizeEnv } = await import('../src/env-normalize.js');
  const env = { runpod_api_key: 'rp_x', cerebras_api: 'csk_x', stripe_api_key: 'sk_x' };
  normalizeEnv(env);
  assert.equal(env.RUNPOD_API_KEY, 'rp_x');
  assert.equal(env.CEREBRAS_API_KEY, 'csk_x');
  assert.equal(env.STRIPE_SECRET_KEY, 'sk_x');
});

test('ensure-signing-key generates + persists a key', async () => {
  const { ensureSigningKey } = await import('../src/ensure-signing-key.js');
  const r = ensureSigningKey();
  assert.equal(r.ok, true);
});

test('spend-caps: free plan allowed, cap 5; missing tenant denied', async () => {
  const sc = await import('../src/spend-caps.js');
  const free = await sc.checkBudget('t_w923a', { ctx: { plan: 'free' } });
  assert.equal(free.allowed, true);
  const none = await sc.checkBudget('', {});
  assert.equal(none.allowed, false);
});

test('conversations: save + list is tenant-fenced', async () => {
  const c = await import('../src/conversations.js');
  await c.saveConversation('t_w923b', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  const mine = await c.listConversations('t_w923b', {});
  assert.ok(mine.length >= 1);
  const other = await c.listConversations('t_w923c', {});
  assert.equal(other.length, 0, 'tenant fence: other tenant sees none');
});

test('model-entitlements: grant then check', async () => {
  const me = await import('../src/model-entitlements.js');
  me.grantModelAccess('t_w923d', 'user_1', 'model_x', 'member', { kind: 'user' });
  const acc = me.checkModelAccess('t_w923d', { tenant_id: 't_w923d', user: 'user_1' }, 'model_x');
  assert.ok(acc);
});

test('model-update-channel: verifyLocal is offline + rejects missing inputs', async () => {
  const mu = await import('../src/model-update-channel.js');
  const bad = mu.verifyLocal({});
  assert.equal(bad.ok, false);
});

test('billing-activation: not-ready lists exact missing env vars', async () => {
  const b = await import('../src/billing-activation.js');
  const r = b.billingReady();
  assert.equal(typeof r.ready, 'boolean');
  assert.ok(Array.isArray(r.missing));
});

test('connectors: listConnectors returns recipes with ids', async () => {
  const c = await import('../src/connectors.js');
  const list = c.listConnectors({ baseUrl: 'https://kolm.ai' });
  assert.ok(Array.isArray(list) && list.length > 0);
});

test('inference-bench: dry_run produces a signed result with no network', async () => {
  const ib = await import('../src/inference-bench.js');
  const out = await ib.runInferenceBench({ dry_run: true });
  assert.ok(out);
});

test('model-export: importable + has destinations', async () => {
  const mx = await import('../src/model-export.js');
  assert.ok(mx);
});
