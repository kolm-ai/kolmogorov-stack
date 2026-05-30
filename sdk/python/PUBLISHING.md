# Publishing the `kolm` Python SDK to PyPI

This package (`sdk/python`) is published to PyPI by the GitHub Action at
`.github/workflows/publish-pypi.yml`. The action **builds and publishes
automatically when you push a Python-SDK version tag** of the form
`pyv<MAJOR.MINOR.PATCH>` (e.g. `pyv0.2.0`).

There are two authentication paths, tried in order:

1. **Trusted Publishing (OIDC)** — preferred, no long-lived secret to rotate.
2. **API token fallback** — used when the repository secret
   **`PYPI_API_TOKEN`** is set.

You only need to set up **one** of them.

> **Name caveat:** the `kolm` name on PyPI is currently held by an unrelated
> Korean language-modeling toolkit (see `README.md`). Confirm ownership /
> name availability before the first publish, or change `name` in
> `pyproject.toml` (and the URLs below) to an available distribution name.

---

## One-time setup

### Option A — Trusted Publishing (recommended)

1. Create / claim the project on PyPI.
2. On PyPI: open the project → **Publishing** → **Add a new publisher** →
   **GitHub**, and enter:
   - **Owner:** `kolm-ai`
   - **Repository:** `kolm`
   - **Workflow filename:** `publish-pypi.yml`
   - **Environment name:** `pypi`
3. No secret is required. The `publish` job already requests
   `id-token: write` and runs in the `pypi` environment.

### Option B — API token (fallback)

1. On PyPI: **Account settings → API tokens → Add API token**. Scope it to the
   project (or account-wide for the very first publish, then re-scope).
2. In GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**.
   - **Name (exact):** `PYPI_API_TOKEN`
   - **Value:** the token string (starts with `pypi-`).

> **Secret name:** `PYPI_API_TOKEN`

---

## Cutting a release

1. Bump `version` in `sdk/python/pyproject.toml` AND `__version__` in
   `sdk/python/kolm/__init__.py` to match (currently both `0.2.0`). Commit
   that change to the default branch.
2. Tag and push:

   ```bash
   git tag pyv0.2.0 && git push origin pyv0.2.0
   ```

   That single tag push triggers the workflow, which builds the sdist + wheel,
   runs `twine check`, and uploads to PyPI.

3. Verify: the PyPI project page shows the new version, and
   `pip install kolm==0.2.0` succeeds.

You can also run the workflow manually from the Actions tab
(**workflow_dispatch**) to build/publish the current tagged commit.

---

## Local dry-run (optional, no publish)

```bash
cd sdk/python
python -m pip install --upgrade build twine
python -m build            # produces dist/*.whl and dist/*.tar.gz
python -m twine check dist/*
```

This mirrors exactly what the `build` job does in CI.

---

## Notes / things to confirm before the first publish

- **Console entry point.** `pyproject.toml` wires the `recipe` command to
  `recipe.cli:main`. Confirmed: `sdk/python/recipe/cli.py` defines a top-level
  `main(argv)` function (line 55). After install, `recipe --help` works.
- **Two top-level packages.** This distribution ships both `kolm` and
  `recipe` packages; `[tool.setuptools.packages.find]` includes `kolm*` and
  `recipe*` so both are packaged.
- **License.** `pyproject.toml` declares `Apache-2.0`. Ensure a matching
  `LICENSE` file is present at the package root or repo root so it is included
  in the sdist.
