const express = require('express');
const path = require('path');
const { build } = require(path.resolve(__dirname, '..', 'src', 'router.js'));
const app = express();
app.use(express.json());
app.use((req,res,next) => { req.tenant_record = { id:'tenant_test', name:'test', plan:'pro' }; next(); });
const r = build({ tenants: { findByKey: () => null }, events: {}, opts: {} });
app.use(r);
const server = app.listen(0, async () => {
  const port = server.address().port;
  const cases = [
    ['vendor=missing',   { model:'x', messages:[{role:'user',content:'hi'}] }],
    ['vendor=bogus',     { vendor:'made-up', model:'x', messages:[{role:'user',content:'hi'}] }],
    ['model=missing',    { vendor:'anthropic', messages:[{role:'user',content:'hi'}] }],
    ['key=missing',      { vendor:'anthropic', model:'claude-sonnet-4-5', messages:[{role:'user',content:'hi'}] }],
    ['msgs=too-large',   { vendor:'anthropic', model:'claude-sonnet-4-5', messages:[{role:'user',content:'x'.repeat(50000)}] }],
  ];
  for (const [tag, body] of cases) {
    const resp = await fetch('http://127.0.0.1:' + port + '/v1/teacher/chat', {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body),
    });
    const j = await resp.json();
    console.log(tag.padEnd(18), resp.status, JSON.stringify(j).slice(0, 220));
  }
  const h = await fetch('http://127.0.0.1:' + port + '/v1/teacher/chat/health');
  console.log('health'.padEnd(18), h.status, JSON.stringify(await h.json()).slice(0, 220));
  server.close();
});
