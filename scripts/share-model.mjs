#!/usr/bin/env node
// kolm share — serve a trained model + expose a public phone link in one command.
//   node scripts/share-model.mjs --base Qwen/Qwen2.5-3B-Instruct --adapter data/fc-qwen3b-adapter [--quant 4bit] [--port 8799]
// Spawns the python OpenAI-compatible chat server (scripts/serve-trained-model.py),
// opens a cloudflared quick tunnel, prints the public https link, and tears both down on exit.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = get('--base', 'Qwen/Qwen2.5-3B-Instruct');
const adapter = get('--adapter', 'none');
const quant = get('--quant', '');
const port = get('--port', '8799');
const name = get('--name', base.split('/').pop());

// Resolve cloudflared (PATH or the winget default install location).
const CF_CANDIDATES = ['cloudflared', 'C:/Program Files (x86)/cloudflared/cloudflared.exe', 'C:/Program Files/cloudflared/cloudflared.exe'];
const cf = CF_CANDIDATES.find((p) => p === 'cloudflared' || fs.existsSync(p)) || 'cloudflared';

const serveArgs = ['scripts/serve-trained-model.py', '--base', base, '--adapter', adapter, '--port', port, '--name', name];
if (quant) serveArgs.push('--quant', quant);
console.log(`[share] starting model server: ${base} (adapter=${adapter}, quant=${quant || 'bf16'}) on :${port}`);
const server = spawn('python', serveArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
let ready = false;
server.stdout.on('data', (d) => { const s = d.toString(); if (s.includes('READY')) { ready = true; console.log('[share] model READY'); startTunnel(); } });
server.stderr.on('data', () => {});

let tunnel = null;
function startTunnel() {
  console.log('[share] opening cloudflared quick tunnel...');
  tunnel = spawn(cf, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (d) => {
    const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      console.log(`\n  ============================================================`);
      console.log(`   📱  PUBLIC LINK (open on your phone): ${m[0]}`);
      console.log(`   model: ${name}`);
      console.log(`  ============================================================\n`);
    }
  };
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
}

function cleanup() {
  try { if (tunnel) tunnel.kill(); } catch {}
  try { server.kill(); } catch {}
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
