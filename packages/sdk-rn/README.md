# kolm-rn (React Native)

Embed a `.kolm` artifact in React Native apps.

```ts
import Kolm from 'kolm-rn';

const model = await Kolm.load(require('./phi-redactor.kolm'));
const out = await model.predict('Patient John Doe, MRN 8847-21.');
console.log(out.text);  // "Patient [NAME], MRN [ID]."
```

## Install

```sh
npm install kolm-rn
# iOS
cd ios && pod install
```

## How it works

`kolm-rn` is a thin TS wrapper around the native Kolm SDKs:

- **iOS / macOS** -> `kolm-sdk-swift` (Core ML / MLX / llama.cpp)
- **Android**     -> `kolm-android` (ExecuTorch / llama.cpp / ONNX)

Same `.kolm` file works on both. The JS layer enforces the same receipt
checks (CID, optional HMAC body sig) by recomputing them in JS - if the
native side later catches a mismatch on its own, both halves agree.

## API

| Call                                       | Returns                  |
| ------------------------------------------ | ------------------------ |
| `Kolm.load(source)`                        | `Promise<KolmModel>`     |
| `model.predict(text, opts?)`               | `Promise<KolmOutput>`    |
| `Kolm.setConfig({ verify, secret })`       | `void`                   |

`source` accepts: a `require(...)` for a bundled `.kolm`, a `file://` URI,
or a remote `https://` URL (cached after first load).

## License

Apache-2.0
