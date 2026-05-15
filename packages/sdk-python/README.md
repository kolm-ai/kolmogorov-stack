# kolm-sdk (Python)

The one-line embed for `.kolm` artifacts.

```python
from kolm import load

model = load("phi-redactor.kolm")
out = model.predict("Patient John Doe, DOB 1984-03-12, MRN 8847-21.")
# -> "Patient [NAME], DOB [DATE], MRN [ID]."
```

## Install

```sh
pip install kolm
```

## What it does

`load(path)` opens a `.kolm` artifact, verifies the receipt chain + body
signature against the embedded `manifest.json`, then dispatches inference to
whichever runtime is available on the host:

| Backend       | Trigger                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `gguf`        | `llama-cpp-python` installed and a `model.gguf` file is inside the zip |
| `onnx`        | `onnxruntime` installed and `model.onnx` inside the zip                |
| `transformers`| `transformers` + `peft` installed, falls back to merged HF weights     |
| `remote`      | `KOLM_RUNTIME_URL` is set, hits the OpenAI-shaped /v1/chat endpoint    |

If none of those line up the call returns a clear error string explaining
how to install a runtime — never silent garbage output.

## Receipt verification

```python
m = load("phi-redactor.kolm", verify="strict")
# raises ValueError on any signature, chain, or CID mismatch
```

Verification is **on by default**. Pass `verify="off"` to skip — only do
that for local development; production users should never opt out.

## Provenance

Every prediction returns a `KolmOutput` object with the artifact CID and
the matching credential id:

```python
out = model.predict("...")
print(out.text)        # the redacted string
print(out.cid)         # cidv1:sha256:...
print(out.credential)  # output credential id, links back to artifact
```

## License

Apache-2.0
