# kolm

> Compile any AI task into a signed `.kolm` file you own. Then run it forever - local, deterministic, no LLM round trip.

Python client for the [kolm.ai](https://kolm.ai) AI compiler. Wraps the public HTTP API. The Node CLI is the canonical interface; this package mirrors its surface for Python users.

Registry status: not published under Kolm control. The `kolm` name on PyPI is an unrelated Korean language-modeling toolkit, so do not install the PyPI `kolm` distribution as this SDK until ownership or a new package name is resolved.

## Install

```bash
cd sdk/python
pip install -e .
```

## 30-second usage

Two surfaces ship in the same package:

### `kolm` - the AI compiler

```python
from kolm import Kolm

k = Kolm(api_key="ks_...")  # or KOLM_API_KEY env var

# Compile a task into a signed .kolm artifact
job = k.compile(
    task="answer support tickets in my voice",
    examples_path="./tickets.jsonl",
    base="qwen2.5-7b-instruct",
)
artifact_path = k.wait(job.id)            # downloads the .kolm

# Run it locally - deterministic, no LLM round trip
out = k.run(artifact_path, input="user can't log in")
print(out.text)
```

### `kolm.audit` - Agent Security-Review + offline evidence verification

Upload agent logs (JSONL) and get back an **Ed25519-signed, offline-verifiable
evidence report** mapped to SOC 2 / ISO 42001 / NIST AI RMF / EU AI Act / OWASP /
MITRE.

```python
from kolm import AuditClient

a = AuditClient(api_key="ks_...")  # or KOLM_API_KEY env var

# One-shot: logs -> signed evidence report
scan = a.scan(open("agent-logs.jsonl").read(), subject="support & billing agents")
print(scan.report_id, scan.summary["readiness_pct"], "%")

a.reports()                      # every report this tenant owns
a.buy_report(scan.id)            # $750 Signed Readiness Report checkout link
a.subscribe("starter")           # Continuous re-attestation checkout link
a.trust("<slug>")                # fetch a public Trust link's signed report (no auth)
```

#### The killer feature: verify a kolm report in pure Python, fully offline

A buyer can confirm a kolm evidence report was signed by the holder of the
embedded key and **has not been altered since** - with **no server, no account,
no shared secret**. The verifier reproduces the exact canonicalization used by
the Node signer and the in-browser verifier **byte-for-byte**, checks the
Ed25519 signature locally (via the `cryptography` library), then checks issuer
provenance against a keyring **bundled inside the package**.

```python
import json
from kolm import verify_report

report = json.load(open("agent-security-report.json"))
result = verify_report(report)          # zero network, runs on an air-gapped box

if result.ok:
    # ok == tier1_signature AND tier2_issuer
    print("trusted:", result.issuer.status, result.key_fingerprint)
else:
    print("NOT trusted:", result.reason)

result.tier1_signature   # signature valid + report untampered
result.tier2_issuer      # signing key is a recognized kolm issuer
result.key_fingerprint   # fingerprint recomputed from the embedded key
```

Tamper with any byte - a downgraded readiness number, a deleted finding, a
flipped tamper-evident flag - and `tier1_signature` becomes `False`. Re-sign a
tampered report with a rogue key and `tier1_signature` passes but `tier2_issuer`
(and therefore `ok`) is `False`: always check `ok`, not just the signature.

A custom keyring (e.g. to pin your own issuer) is accepted as a path, a
`{"issuers": [...]}` mapping, or a list of issuer dicts:

```python
verify_report(report, keyring="my-issuers.json")
```

Offline verification requires the `cryptography` library, which installs
automatically with this package.

### `recipe` - the Skills layer

```python
from recipe import RecipeClient

c = RecipeClient(api_key="ks_...")  # or RECIPE_API_KEY env var

# Show four examples once
r = c.synthesize(
    name="is-spam",
    positives=[
        {"input": "WIN A FREE iPhone NOW",   "expected": True},
        {"input": "CLICK HERE FOR $1000",    "expected": True},
        {"input": "meeting at 3pm tomorrow", "expected": False},
        {"input": "lunch?",                  "expected": False},
    ],
    output_spec={"type": "boolean"},
)

# Run it forever - typically under 50 us, no API key required on public recipes
out = c.run(recipe_id=r["concept_id"], input="BUY CRYPTO NOW")
print(out["output"])     # => True
print(out["latency_us"]) # => typically under 50
```

## Drop-in replacements for repeat LLM-as-judge calls

```python
from recipe import recipe

recipe.is_spam("WIN free Bitcoin")            # => True
recipe.classify_intent("how do I cancel")     # => "support"
recipe.detect_language("c'est la vie")        # => "french"
recipe.classify_issue("the deploy crashed")   # => "bug"
```

These hit the public registry - no API key required.

## CLI

```bash
cd sdk/python
pip install -e .
export RECIPE_API_KEY=ks_...

recipe run is-spam "WIN free Bitcoin"
```

## Configuration

| Env var          | Default              | Purpose                                          |
|------------------|----------------------|--------------------------------------------------|
| `KOLM_API_KEY`   | _(none)_             | Bearer token for the compile/run + audit API     |
| `KOLM_BASE`      | `https://kolm.ai`    | Override base URL (self-hosted)                  |
| `RECIPE_API_KEY` | _(none)_             | Bearer token for the recipe API                  |

`kolm.audit.verify_report` is fully offline and reads **no** env vars or network -
it only needs the signed report and the bundled issuer keyring.

## Status envelope

The Python client never sugars away non-2xx responses - `KolmError(status, body)` is raised verbatim so you can log the upstream response and decide how to react.

## License

Apache-2.0.
