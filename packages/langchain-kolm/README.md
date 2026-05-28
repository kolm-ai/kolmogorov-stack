# @kolm/langchain

First-party LangChain adapter for kolm.ai compiled artifacts. Drop a `.kolm` into any LangChain agent in 3 lines.

## Install

```bash
git clone https://github.com/kolm-ai/kolmogorov-stack
cd your-app
npm install ../kolm-stack/packages/langchain-kolm langchain @langchain/core
```

The `@kolm/langchain` package name is the local package name. It is not published under Kolm control on npm yet, so install it from a checkout until a registry release is verified.

## Usage (3 lines)

```js
import { KolmLLM } from '@kolm/langchain';
const llm = new KolmLLM({ artifactPath: './phi-redactor.kolm' });
const out = await llm.invoke('Redact: My SSN is 123-45-6789.');
```

The `.kolm` artifact runs as a local subprocess via the `kolm` CLI. Zero outbound calls. The receipt chain (cid, k_score, audit_id) is preserved on `llm.lastReceipt` after every call.

## HTTP mode

```js
const llm = new KolmLLM({
  baseUrl: 'https://kolm.example.internal',
  artifactPath: 'phi-redactor',
  apiKey: process.env.KOLM_API_KEY,
});
```

## Receipt chain

```js
const { text, receipt } = await llm.invokeWithReceipt(prompt);
console.log(receipt.cid, receipt.k_score);
```

## Peer dependencies

`langchain` and `@langchain/core` are peer deps. The adapter ships with zero runtime dependencies.
