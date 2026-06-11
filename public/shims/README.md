# kolm Evidence-Grade Logging Shim

Self-lift your agent logs from evidence tier C (asserted) to tier B
(hash-verified). Drop in one zero-dependency file, record each agent action,
and the output feeds kolm's audit directly. No kolm account is needed to
produce the log, and no network call leaves your runtime.

Tier B is earned, not claimed: each record carries a SHA-256 chain `hash` and a
`prev_hash` referencing the previous record, plus per-agent identity and a
timestamp on every action. kolm verifies the chain and reports what the log
shows. It maps to standards and does not certify behaviour the log never ran.

## Node (ESM) - kolm-logger.js

```js
import { KolmLogger } from './kolm-logger.js';
const log = new KolmLogger({ keyId: 'key_agent_alpha', agent: 'support-agent',
  grants: ['tool:lookup_policy', 'tool:send_email'], model: 'openai/gpt-4o' });
log.record({ tool: 'lookup_policy', args: { topic: 'returns' } });
log.record({ tool: 'send_email', args: { to: 'x@acme.com' }, host: 'api.sendgrid.com' });
fs.writeFileSync('agent-trail.jsonl', log.toJSONL()); // upload this to kolm
```

## Python 3 (stdlib) - kolm_logger.py

```py
from kolm_logger import KolmLogger
log = KolmLogger(key_id="key_agent_alpha", agent="support-agent",
    grants=["tool:lookup_policy", "tool:send_email"], model="openai/gpt-4o")
log.record("lookup_policy", {"topic": "returns"})
log.record("send_email", {"to": "x@acme.com"}, host="api.sendgrid.com")
open("agent-trail.jsonl", "w", encoding="utf-8").write(log.to_jsonl())  # upload to kolm
```

Caveats: the shim records the calls you log, not calls you forget to log.
Questions: dev@kolm.ai
