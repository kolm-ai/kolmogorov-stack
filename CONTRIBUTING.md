# Contributing to kolm

Thanks for the interest. This file describes the three ways to contribute and what we expect from each.

## 1. Submit a recipe to the public registry

Recipes are the small composable building blocks at https://kolm.ai/registry. They're the easiest way to contribute. To submit one:

1. Read the [registry submission guide](https://kolm.ai/registry/submit) for the field-by-field intake.
2. Write a single-task recipe (classifier, redactor, extractor, etc.) targeting a frontier base. Compile it locally:
   ```
   kolm compile --task "your task" --base llama-3.1-8b --out my-recipe.kolm
   ```
3. Confirm it gates: `kolm inspect my-recipe.kolm` should show `K >= 0.85`.
4. Open a pull request on this repo against `main` that adds a row to `data/registry/community/<your-slug>.json`. Use an existing entry as the template. Include a manifest CID, a one-line description, and your handle.

We review weekly. First merge counts as a contribution.

## 2. File a bug or feature request

Open an issue at https://github.com/sneaky-hippo/kolm-stack/issues with:

- A minimal reproduction (one command, expected vs actual output, kolm version)
- The kolm version (`kolm --version`) and platform
- For verifier or compile bugs, paste the receipt or CID so we can replay

Bounty-eligible security findings should follow https://kolm.ai/bounty instead. The disclosure path matters and we'd rather pay than read about it on Twitter.

## 3. Submit code

This is the highest-friction path because the surface is wide. Before opening a PR:

- Discuss the change in an issue first if it touches the CLI, RS-1 spec, the verifier, or the compute layer.
- Spec changes go through https://kolm.ai/spec/rs-1 with a versioned proposal.
- The verifier DANGEROUS list is intentionally strict. Weakening it requires a memo, not a PR.

Style:

- No em-dashes in load-bearing copy. Plain hyphen.
- No new external runtime deps without an Architecture note in the PR.
- Tests in `tests/` (Node) or `apps/runtime/tests/` (Python). Aim for the test to fail without your change.

## Code of conduct

We follow the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Be useful, be specific, be patient with reviewers, and don't make it weird. Direct any concerns to dev@kolm.ai.

## License

By contributing, you agree your work is licensed under Apache-2.0 (same as the rest of the repo) and that you have the right to license it.
