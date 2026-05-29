# kolm data

Plan the synthetic-data cold-start (AUGMENT) stage of a recipe. `kolm data synth`
validates a generator against the recipe synth vocabulary and prints a plan. It
does not fabricate rows: the Python generators run via the distill pipeline (a
recipe `synth` block), not from this CLI.

## Usage

```
kolm data synth <generator> [flags]   plan a synthetic-data AUGMENT stage
```

Generators: `magpie`, `evol`, `persona-hub`, `glan`, `self-instruct`.

## Flags

- `--recipe <file>` validate this recipe (its `synth` section in particular)
 before printing the plan.
- `--target <N>` target synthetic-row count.
- `--max-share <0..1>` cap the synthetic share so real captures dominate.
- `--namespace <ns>` namespace the plan targets (default `default`).
- `--json` full JSON plan envelope.

## Examples

```
kolm data synth magpie --target 2000 --max-share 0.4
kolm data synth evol --recipe ./trinity.json --json
kolm data synth self-instruct --max-share 0.25
```

## Constraints

Synthetic rows are AUGMENT-stage candidates, not labels. Each row a generator
emits carries `synthesized:true` so the verifier knows it is not ground truth.
Keep the synthetic share bounded with `--max-share` (or `synth.max_share` in the
recipe). Verify before ship: replace candidate rows you do not trust, re-compile,
and confirm the receipt chain with `kolm verify <artifact>.kolm`.

## Flow

1. `kolm data synth <generator> --recipe <file>` to plan and validate.
2. Add a `synth` block to the recipe with the chosen generator + target.
3. `kolm compile --spec <recipe>.json` runs the AUGMENT stage, which invokes the generator.
4. `kolm verify <artifact>.kolm` to confirm the receipt chain.

## See also

- `kolm seeds new "<brief>"` to scaffold the seed corpus the synth stage augments.
- `kolm verify <artifact>.kolm` to confirm the receipt chain.
- `/training/data-sources` for the upstream data-source registry.
- `/spec/rs-1` (RS-1 v2.1) for the seeds.jsonl train/holdout split schema.
