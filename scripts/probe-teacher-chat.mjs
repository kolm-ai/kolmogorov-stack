import express from 'express';
import path from 'node:path';
import url from 'node:url';
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { buildRouter } = await import(url.pathToFileURL(path.resolve(__dirname, '..', 'src', 'router.js')).href);
const FAKE_KEY = 'ks_smoke_test';
const tenants = {
  findByKey: (k) => k === FAKE_KEY ? { id:'tenant_test', name:'test', plan:'pro', api_key: k } : null,
  findById:  (id) => id === 'tenant_test' ? { id:'tenant_test', name:'test', plan:'pro' } : null,
  resolveKey: (k) => k === FAKE_KEY ? { id:'tenant_test', name:'test', plan:'pro', api_key: k } : null,
};
const app = express();
app.use(express.json());
const r = buildRouter({ tenants, events: { append: () => {}, findByTenant: () => [] }, opts: {} });
app.use(r);
const server = app.listen(0, async () => {
  const port = server.address().port;
  const H = { 'content-type':'application/json', authorization: 'Bearer ' + FAKE_KEY };
  const cases = [
    ['no-vendor',       { model:'x', messages:[{role:'user',content:'hi'}] }],
    ['bogus-vendor',    { vendor:'made-up', model:'x', messages:[{role:'user',content:'hi'}] }],
    ['no-model',        { vendor:'anthropic', messages:[{role:'user',content:'hi'}] }],
    ['no-key-on-host',  { vendor:'anthropic', model:'claude-sonnet-4-5', messages:[{role:'user',content:'hi'}] }],
    ['msgs-too-large',  { vendor:'anthropic', model:'claude-sonnet-4-5', messages:[{role:'user',content:'x'.repeat(50000)}] }],
  ];
  for (const [tag, body] of cases) {
    const resp = await fetch('http://127.0.0.1:' + port + '/v1/teacher/chat', {
      method:'POST', headers: H, body: JSON.stringify(body),
    });
    const j = await resp.json();
    console.log(tag.padEnd(18), resp.status, JSON.stringify(j).slice(0, 220));
  }
  const h = await fetch('http://127.0.0.1:' + port + '/v1/teacher/chat/health');
  console.log('health'.padEnd(18), h.status, JSON.stringify(await h.json()).slice(0, 220));
  server.close();
});
