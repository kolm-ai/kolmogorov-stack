# @kolm/llamaindex

First-party LlamaIndex adapter for kolm.ai compiled artifacts. Drop a `.kolm` into any LlamaIndex agent in 3 lines.

## Install

```bash
git clone https://github.com/kolm-ai/kolm-stack
cd your-app
npm install ../kolm-stack/packages/llamaindex-kolm llamaindex
```

The `@kolm/llamaindex` package name is the local package name. It is not published under Kolm control on npm yet, so install it from a checkout until a registry release is verified.

## Usage (3 lines)

```js
import { KolmLLM } from '@kolm/llamaindex';
const llm = new KolmLLM({ artifactPath: './phi-redactor.kolm' });
const out = await llm.complete('Redact: My SSN is 123-45-6789.');
```

## Chat

```js
const r = await llm.chat({ messages: [{ role: 'user', content: 'Classify: shipped late.' }] });
console.log(r.message.content);
```

## HTTP mode

```js
const llm = new KolmLLM({
  baseUrl: 'https://kolm.example.internal',
  artifactPath: 'support-triage',
  apiKey: process.env.KOLM_API_KEY,
});
```

## Receipt chain

Every call records the receipt on `llm.lastReceipt`. Use `invokeWithReceipt(prompt)` to receive it inline.

## Peer dependencies

`llamaindex` is a peer dep. The adapter ships with zero runtime dependencies.
