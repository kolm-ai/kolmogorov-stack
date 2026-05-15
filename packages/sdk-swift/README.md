# Kolm (Swift)

Embed a `.kolm` artifact in iOS / macOS / iPadOS apps.

```swift
import Kolm

let model = try Kolm.load(named: "phi-redactor")
let out = try model.predict("Patient John Doe, MRN 8847-21.")
print(out.text)  // "Patient [NAME], MRN [ID]."
```

## Install (Swift Package Manager)

```swift
// Package.swift
.package(url: "https://github.com/kolm-ai/kolm-sdk-swift", from: "0.1.0"),
```

Then add `.product(name: "Kolm", package: "kolm-sdk-swift")` to your
target dependencies.

## Bundling artifacts

Drop the `.kolm` file into your app bundle (Xcode → drag into project →
"Copy items if needed"). `Kolm.load(named:)` resolves against the main
bundle by default. To load from a URL:

```swift
let model = try Kolm.load(at: artifactURL)
```

## Backends

| Platform              | Default backend |
| --------------------- | --------------- |
| Apple Silicon Mac     | MLX             |
| iOS 17+ / iPadOS 17+  | Core ML         |
| Older iOS             | llama.cpp       |

The artifact must contain a model file the runtime can read
(`model.mlpackage` for Core ML, `model.mlx` or sharded weights for MLX,
`model.gguf` for llama.cpp). Use `kolm export --backend coreml|mlx|gguf`
on the desktop to produce each.

## Receipt verification

`Kolm.load` verifies the artifact's CID against `manifest.hashes` and
checks the HMAC signature on `receipt.json` if a secret is configured
via `Kolm.Configuration.shared.secret = ...`. Verification is on by
default. Disable for development with `Kolm.Configuration.shared.verify = .off`.

## License

Apache-2.0
