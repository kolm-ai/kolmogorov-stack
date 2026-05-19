# kolm install-device

Sideload a `.kolm` artifact onto a connected edge device (laptop,
DGX Spark, Jetson, phone over USB). Reads device capability from
`kolm doctor --detect-hw` and selects the right quant tier before
copying.

## Usage

```
kolm install-device <artifact.kolm>                       # auto-detect
kolm install-device <artifact.kolm> --target <id>         # explicit device id
kolm install-device <artifact.kolm> --tier <preset>       # 3090/5090/spark/m3-ultra-512
kolm install-device --list                                # connected devices
```

## What runs on the device

The artifact, the receipt chain, the bundled runtime binary, and a
device-side verifier. Verification happens on-device before the model
is loaded; if the chain breaks, the runtime refuses to start.

## See also

- `kolm doctor --detect-hw` to enumerate device capabilities.
- `kolm runtime build-from-source` to compile the runtime for the target arch.
- `kolm install` for host install.
- `/docs/cli/runtime` for the runtime build matrix.
