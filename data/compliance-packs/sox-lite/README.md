# SOX-lite pack

Compile a model that classifies financial disclosure text, flags MD&A
inconsistencies, or extracts structured fields from filings — under a
lightweight SOX 404 / COSO control framework.

This is the "lite" pack because SOX 404 itself does not regulate AI
models. What it does regulate is **the controls** around any system that
materially affects financial reporting. This pack ships the artifacts
auditors expect when AI sits inside an in-scope control:

- Reproducible compile (CID + receipt chain = "can we recompute it?")
- Held-out eval (= "did we validate it works?")
- Change control (= "do we know what changed and when?")
- Access controls (= "who can run / retrain it?")

## What this pack outputs

A `.kolm` artifact for one of three common SOX-lite use cases:

1. **Disclosure-language classifier** — tags MD&A paragraphs as
   forward-looking, historical, or risk-factor.
2. **10-K / 10-Q field extractor** — pulls structured values (revenue,
   COGS, OpEx, debt covenants) from filings.
3. **Issue-tracker triage** — categorizes finance-system tickets so
   incidents that touch close-of-books get priority routing.

The default recipe targets use case 1. Swap `task` and `verifier.params`
for the other two.

## Quickstart

```sh
kolm compile \
  --recipe data/compliance-packs/sox-lite/recipe.json \
  --examples data/compliance-packs/sox-lite/examples/ \
  --k 0.88
```

See `controls.md` for the auditor-facing control documentation template.
