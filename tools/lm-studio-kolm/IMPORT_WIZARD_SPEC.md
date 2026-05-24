# LM Studio `.kolm` Import Wizard — Specification

STATUS: SPEC DRAFT, 2026-05-24
OWNER: kolm.ai integrations
TARGET: LM Studio >= 0.3.0 (model loader v2 + extension API)
DEPENDS ON: W818-4 (vLLM loader is structural cousin), `src/artifact-runner.js`
(canonical `.kolm` reader)

Open-source AI workbench: this spec defines how an operator can take a `.kolm`
artifact they downloaded from kolm.ai (or built locally with `kolm compile`)
and import it into LM Studio's local model library in a single guided flow.
No CLI required for the end-user; the wizard is the import surface.

## Brand lock-in

The wizard UI uses the kolm brand strings exactly:

- **Eyebrow:** Open-source AI workbench
- **H1 (wizard intro):** Frontier AI on your own infrastructure.

LM Studio's own header chrome is unchanged.

## Goal

End-to-end UX, from the operator's point of view:

```
1. File > Import .kolm artifact...
2. Select support-triage.kolm
3. Wizard:
   - Step 1: Verify signature      (auto, 200ms)
   - Step 2: Inspect manifest      (review K-Score, tier, runtime_target)
   - Step 3: Pick install location (default: LM Studio models dir)
   - Step 4: Confirm + Import
4. Done. support-triage appears in LM Studio's model list, loadable like
   any other GGUF model.
```

## .kolm import semantics

The wizard reads `.kolm` archive entries exactly as documented in
`tools/llama-cpp-kolm-loader/kolm-loader.cpp` and as implemented in
`src/artifact-runner.js`. The full entry layout:

| zip entry            | wizard behaviour                                                    |
| -------------------- | -------------------------------------------------------------------- |
| `manifest.json`      | parsed; surfaced in step 2 (K-Score / tier / runtime_target / license)|
| `recipes.json`       | parsed; not surfaced (LM Studio doesn't run kolm recipes)            |
| `signature.sig`      | verified in step 1; failure aborts the wizard with a clear error     |
| `receipt.json`       | preserved verbatim in the sidecar so `kolm verify` round-trips       |
| `evals.json`         | preserved verbatim; surfaced as "X eval cases bundled" badge         |
| `model.gguf`         | extracted to LM Studio's model dir as the active weights file        |
| `weights/`           | sharded weights — concatenated by manifest order during extraction   |
| `lora.bin`           | KOLMPACK marker = behaviour pack (preserved as sidecar);             |
|                      | real LoRA delta = surfaced for optional load via LM Studio's LoRA UI |
| `index.sqlite-vec`   | preserved verbatim in sidecar (LM Studio has no RAG hook yet)        |
| `runtime-policy.json`| preserved verbatim; surfaced as "advanced settings" panel link       |
| `attestation.json`   | preserved verbatim; surfaced as "confidential compute" pill if valid |

The wizard refuses to import a `.kolm` whose `manifest.runtime_target` is
not `gguf` — LM Studio cannot run rule-tier artifacts. The refusal message
links to `kolm run` as the alternative path.

## LM Studio local model directory contract

LM Studio's model library is a flat directory tree:

```
~/.cache/lm-studio/models/
  <publisher>/
    <model-name>/
      <quant>.gguf
      config.json          (optional, HF-style)
      tokenizer.json       (optional)
      generation_config.json (optional)
```

The wizard projects the kolm artifact into this layout deterministically:

```
~/.cache/lm-studio/models/
  kolm/
    <manifest.task>-<manifest.cid_short>/
      <quant>.gguf                       (from model.gguf, or concatenated shards)
      config.json                        (translated from manifest.json — same
                                          mapping table as tools/vllm-kolm)
      tokenizer.json                     (from manifest.tokenizer or bundled file)
      generation_config.json             (from manifest.generation block)
      kolm_metadata.json                 (sidecar — full manifest + receipt +
                                          signature_mode, parallel to W818-2)
      kolm_attestation.json              (optional — present iff the .kolm
                                          shipped an attestation.json entry)
      kolm_runtime_policy.json           (optional — same)
      kolm_evals.json                    (optional — same)
```

`kolm_metadata.json` is the load-time hook the kolm CLI uses to round-trip:
`kolm verify ~/.cache/lm-studio/models/kolm/<name>/` reads the sidecar and
re-verifies against the original `.kolm` bytes (which the wizard keeps under
`~/.cache/lm-studio/models/kolm/<name>/.original.kolm` for that exact purpose).

## UI flow (step by step)

### Step 0 — Entry point

LM Studio's top menu gains:

```
File > Import .kolm artifact...
```

Keyboard shortcut: `Cmd/Ctrl+Shift+K`.

Drag-and-drop a `.kolm` onto the model library pane is the alternative entry
point. The drop target uses the same wizard.

### Step 1 — Verify signature

Auto-runs on entry. UX:

```
+---------------------------------------------------+
|  Verifying signature...                            |
|  [  spinner  ]                                     |
+---------------------------------------------------+
```

Backed by the kolm Python SDK's `inspect_artifact` (same code path as W818-3).

On success: green check, "Signature OK (ed25519-public-key)" + continue.
On failure: red X, "Signature invalid: <reason>" + only options are
"Show details" + "Cancel". Never silent passthrough — the wizard NEVER
proceeds to step 2 without a valid signature unless the operator
explicitly clicks an "Import anyway (unsigned)" link that is wrapped in
a confirm dialog and writes a warning into the sidecar.

### Step 2 — Inspect manifest

Card layout summarising the manifest contents:

```
+---------------------------------------------------+
| support-triage                                     |
| K-Score: 0.94    Tier: distilled_model             |
| Runtime: gguf    License: Apache-2.0               |
| Base: meta-llama/Llama-3.2-3B-Instruct             |
| Quant: bitsandbytes / NF4 / double                 |
| Size: 1.9 GB   Captures: 12,847                    |
+---------------------------------------------------+
| Sustainability badge:  A- (W786 — 0.034 kg CO2)    |
| Confidential compute:  attested (snp-report)       |
+---------------------------------------------------+
[ Back ]                              [ Next > ]
```

### Step 3 — Pick install location

Default: LM Studio's resolved models dir. Operator can override.

Shows the resolved target path so the operator can see exactly where bytes
will land. The "kolm_metadata.json sidecar will be preserved" line is
required so the contract is visible.

### Step 4 — Confirm + Import

Final confirm dialog with:

```
Importing support-triage into LM Studio...

Source:        ~/Downloads/support-triage.kolm  (1.9 GB)
Target:        ~/.cache/lm-studio/models/kolm/support-triage-abc123/
Disk needed:   ~2.0 GB (includes sidecar)
```

[ Cancel ]  [ Import ]

Progress bar during extraction; on completion, the model is added to the
LM Studio library and the wizard closes with a "Loaded" toast.

## Failure modes (all loud, never silent)

| Condition                                      | Wizard behaviour                                          |
| ---------------------------------------------- | --------------------------------------------------------- |
| Signature verify fails                         | Step 1 stops; only "Show details" + "Cancel"              |
| `manifest.runtime_target != "gguf"`            | Step 2 refuses with link to `kolm run` docs               |
| Disk full at install location                  | Step 3 surfaces required-vs-available + suggests alt dir  |
| Existing model with same `<task>-<cid>` dir    | Step 4 confirm dialog asks: overwrite / rename / cancel   |
| Attestation block present but verifier missing | Step 2 surfaces "attestation unverified" pill, NOT a stop |
| Original `.kolm` checksum mismatch on re-verify| Sidecar is marked stale; next `kolm verify` re-checks    |

## Extension hooks for kolm CLI

The wizard exposes two stable hook points the kolm CLI can call:

- `lm-studio-kolm://import?path=<absolute-path-to.kolm>` — deep link that
  opens LM Studio (or focuses it) and starts the wizard pre-populated.
- `lm-studio-kolm://verify?path=<absolute-path-to.kolm>` — same but jumps
  straight to step 1 with no UI between verify and result.

The kolm CLI's `kolm install --target lm-studio <artifact.kolm>` command
shells out to whichever deep link is registered on the host OS.

## Tests

Once the wizard is implemented, the contract above is locked in via:

- `tests/wave818-ecosystem-loaders.test.js` (this PR) — proves the spec
  file exists, contains the required sections, and references the
  canonical `.kolm` reader.
- (Future) `apps/lm-studio-kolm/tests/wizard-flow.spec.ts` — Playwright
  end-to-end against an LM Studio dev build. Out of scope for W818.

## Open questions

1. LM Studio's extension API: does the import wizard ship as a built-in
   menu item (requires upstream PR) or as a side-loaded extension
   (works on current builds)? Side-loaded extension is the faster path;
   built-in is the long-term goal.
2. Should the wizard write the `.original.kolm` into the model directory
   itself (current spec) or into a sibling dir (`~/.cache/lm-studio/kolm-originals/`)
   to avoid bloating the LM Studio model list with a non-loadable file?
3. Where to surface kolm's "verify on every load" gate — automatically
   on every model-load event, or only when the operator triggers it via
   the model's context-menu?

## Honest status

- Wizard NOT yet implemented. This is the spec doc only.
- LM Studio team has not been consulted on the deep-link scheme.
- The extension-vs-built-in path is TBD pending the conversation above.
- kolm CLI's `kolm install --target lm-studio` is tracked under W824.
