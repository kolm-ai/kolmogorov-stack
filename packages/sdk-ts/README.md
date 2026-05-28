# kolm (TypeScript / JavaScript SDK)

One-line embed for `.kolm` artifacts in Node, browsers, and bundlers.

```ts
import { load } from "kolm";

const m = await load("artifact.kolm", { endpoint: "https://kolm.ai", apiKey: process.env.KOLM_API_KEY });
const out = await m.predict("input text");
console.log(out.text);
```

## Install

```sh
npm install kolm
```

Node ≥ 18 is required (uses `node:crypto`, `node:fs/promises`, `node:zlib`, `fetch`). No third-party runtime dependencies.

## What it does

- Reads a `.kolm` ZIP artifact from disk or memory.
- Recomputes `manifest.cid` from the canonical hashes and rejects on mismatch.
- Replays HMAC-SHA256 over the receipt body if you pass a `secret`.
- Verifies the SHA-256 of every entry against `manifest.hashes` (skip with `{ skipHashCheck: true }`).
- Calls `POST /v1/run` on the configured endpoint to actually execute the artifact.

## Public surface

```ts
load(path: string | Uint8Array, options?: LoadOptions): Promise<KolmModel>
loadBuffer(buf: Uint8Array, options?: LoadOptions): Promise<KolmModel>
canonicalJson(obj: unknown): string
VerificationError extends Error
class KolmModel {
  readonly cid?: string;
  readonly manifest: Manifest;
  readonly credential?: Record<string, unknown>;
  predict(input: string): Promise<KolmOutput>;
}
interface KolmOutput { text: string; cid?: string; credential?: string; latency_ms: number; }
interface LoadOptions { secret?: string | Buffer; endpoint?: string; apiKey?: string; skipHashCheck?: boolean; }
```

The surface mirrors the Python SDK (`packages/sdk-python`). If a method exists there and not here, that is a bug. File it at https://github.com/kolm-ai/kolmogorov-stack/issues.

## Browser

```ts
import { loadBuffer } from "kolm";

const buf = new Uint8Array(await (await fetch("/artifact.kolm")).arrayBuffer());
const m = await loadBuffer(buf, { endpoint: "https://kolm.ai", apiKey: KEY });
const out = await m.predict("input");
```

The reader is pure-stdlib (ZIP parse + zlib deflate). No `jszip` / `adm-zip` runtime dependency.

## Verification

By default, `load()` does three checks before returning:

1. `manifest.cid` is recomputed from canonical(`{hashes}`) and must equal the declared value.
2. Every entry listed in `manifest.hashes` is hashed and compared.
3. If `receipt.json` is present and a `secret` is provided, HMAC-SHA256 is replayed over the receipt body.

Any failure throws `VerificationError`. You should treat that as fatal — never trust an unverifiable artifact.

## License

Apache-2.0. See [LICENSE](./LICENSE).

## Status

`v0.2.6` — release-aligned SDK metadata. The remote `predict()` path is stable. A local in-process runtime (matching `packages/sdk-python/kolm/runtimes`) is on the roadmap; until then, run `kolm serve --http` and point `endpoint` at it.
