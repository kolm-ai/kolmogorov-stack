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

k = Kolm(api_key="k_live_...")  # or KOLM_API_KEY env var

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

| Env var          | Default              | Purpose                              |
|------------------|----------------------|--------------------------------------|
| `KOLM_API_KEY`   | _(none)_             | Bearer token for the compile/run API |
| `KOLM_BASE`      | `https://kolm.ai`    | Override base URL (self-hosted)      |
| `RECIPE_API_KEY` | _(none)_             | Bearer token for the recipe API      |

## Honest envelope

The Python client never sugars away non-2xx responses - `KolmError(status, body)` is raised verbatim so you can log the upstream response and decide how to react.

## License

Apache-2.0.
