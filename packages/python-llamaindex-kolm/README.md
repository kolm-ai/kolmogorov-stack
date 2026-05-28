# kolm-llamaindex

First-party LlamaIndex adapter for kolm.ai compiled artifacts. Drop a `.kolm` into any LlamaIndex agent in 3 lines.

## Install

```bash
git clone https://github.com/kolm-ai/kolmogorov-stack
pip install -e ./kolm-stack/packages/python-llamaindex-kolm[llamaindex]
```

The `kolm-llamaindex` package name is the local package name. It is not published under Kolm control on PyPI yet, so install it from a checkout until a registry release is verified.

## Usage (3 lines)

```python
from kolm_llamaindex import KolmLLM
llm = KolmLLM(artifact_path="./phi-redactor.kolm")
out = llm.complete("Redact: My SSN is 123-45-6789.")
```

## Chat

```python
r = llm.chat([{"role": "user", "content": "Classify: shipped late."}])
print(r["message"]["content"])
```

## HTTP mode

```python
llm = KolmLLM(
    base_url="https://kolm.example.internal",
    artifact_path="support-triage",
    api_key=os.environ["KOLM_API_KEY"],
)
```

## Receipt chain

Every call records the receipt on `llm.last_receipt`. Use `invoke_with_receipt(prompt)` to receive both inline.

## Python support

Python 3.10+. `llama-index-core` is an optional install.
