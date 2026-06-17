// W658 - direct contract/security tests for src/forge-inspect.js.
//
// forge-inspect is a local artifact/model-profile boundary plus a small
// HuggingFace network fetcher. Remote model ids must be constrained before
// network use, redirects must stay on trusted HF hosts, config bodies must be
// capped, and offline cache fallback must match the advertised contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectModel, _internal } from '../src/forge-inspect.js';

const TARGET = 'src/forge-inspect.js';

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-forge-inspect-w658-'));
}

function moeConfig(extra = {}) {
  return {
    model_type: 'qwen3_moe',
    architectures: ['Qwen3MoeForCausalLM'],
    hidden_size: 2048,
    num_hidden_layers: 4,
    num_attention_heads: 16,
    vocab_size: 32000,
    intermediate_size: 6144,
    moe_intermediate_size: 768,
    num_experts: 8,
    num_experts_per_tok: 2,
    max_position_embeddings: 32768,
    chat_template: '{{ messages }}',
    ...extra,
  };
}

function fakeHttpsGet(responses, calls = []) {
  let index = 0;
  return (url, _opts, cb) => {
    calls.push(url);
    const req = new EventEmitter();
    req.destroy = (err) => {
      if (err) process.nextTick(() => req.emit('error', err));
    };
    process.nextTick(() => {
      const entry = responses[index++];
      if (!entry) {
        req.emit('error', new Error('unexpected_https_get'));
        return;
      }
      const res = new PassThrough();
      res.statusCode = entry.statusCode;
      res.headers = entry.headers || {};
      cb(res);
      if (entry.body != null) res.end(entry.body);
      else res.end();
    });
    return req;
  };
}

test('W658 inspectModel profiles local MoE config without network', async () => {
  assert.equal(TARGET, 'src/forge-inspect.js');
  const tmp = freshDir();
  const cfg = path.join(tmp, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify(moeConfig(), null, 2));

  const profile = await inspectModel(cfg);
  assert.equal(profile.source, 'local_config');
  assert.equal(profile.is_moe, true);
  assert.equal(profile.num_experts, 8);
  assert.equal(profile.num_experts_per_tok, 2);
  assert.equal(profile.context_length, 32768);
  assert.equal(profile.chat_template_present, true);
  assert.ok(profile.total_params_b > profile.active_params_b);
  assert.ok(/^forge-inspect-/.test(profile.forge_inspect_version));
});

test('W658 remote model ids are validated before injected fetch', async () => {
  await assert.rejects(
    () => inspectModel('https://evil.example/model', { fetchConfig: async () => moeConfig() }),
    /hf_model_id_must_not_be_url/,
  );
  await assert.rejects(
    () => inspectModel('../secrets/config', { fetchConfig: async () => moeConfig() }),
    /hf_model_id_unsafe_path/,
  );

  let seen = null;
  const profile = await inspectModel('Qwen/Qwen3-30B-A3B', {
    fetchConfig: async (modelId) => {
      seen = modelId;
      return moeConfig({ num_parameters: 30_500_000_000 });
    },
  });
  assert.equal(seen, 'Qwen/Qwen3-30B-A3B');
  assert.equal(profile.source, 'huggingface');
  assert.equal(profile.total_params_b, 30.5);
});

test('W658 inspectModel falls back to HuggingFace cache when remote fetch fails', async () => {
  const tmp = freshDir();
  const cacheDir = path.join(tmp, 'hf-cache');
  const cfg = path.join(cacheDir, 'models--Qwen--Qwen3', 'snapshots', 'abc123', 'config.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify(moeConfig({ num_experts: 4, num_experts_per_tok: 1 }), null, 2));

  const profile = await inspectModel('Qwen/Qwen3', {
    cacheDir,
    fetchConfig: async () => { throw new Error('offline'); },
  });
  assert.equal(profile.source, 'huggingface_cache');
  assert.equal(profile.num_experts, 4);
  assert.equal(profile.num_experts_per_tok, 1);
});

test('W658 fetchHfConfig enforces trusted HTTPS redirects and byte cap', async () => {
  await assert.rejects(
    () => _internal.fetchHfConfig('Qwen/Qwen3', {
      httpsGet: fakeHttpsGet([
        { statusCode: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } },
      ]),
    }),
    /hf_redirect_must_be_https/,
  );

  await assert.rejects(
    () => _internal.fetchHfConfig('Qwen/Qwen3', {
      httpsGet: fakeHttpsGet([
        { statusCode: 302, headers: { location: 'https://example.com/config.json' } },
      ]),
    }),
    /hf_untrusted_redirect_host/,
  );

  const calls = [];
  const cfg = await _internal.fetchHfConfig('Qwen/Qwen3', {
    httpsGet: fakeHttpsGet([
      { statusCode: 307, headers: { location: 'https://cdn-lfs.huggingface.co/repo/config.json' } },
      { statusCode: 200, body: JSON.stringify({ model_type: 'qwen3' }) },
    ], calls),
  });
  assert.equal(cfg.model_type, 'qwen3');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^https:\/\/huggingface\.co\/Qwen\/Qwen3\/resolve\/main\/config\.json$/);

  await assert.rejects(
    () => _internal.fetchHfConfig('Qwen/Qwen3', {
      maxBytes: 10,
      httpsGet: fakeHttpsGet([
        { statusCode: 200, body: '{"too_large":"xxxxxxxxxxxxxxxx"}' },
      ]),
    }),
    /hf_config_too_large/,
  );
});
