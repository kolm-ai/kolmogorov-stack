# kolm extension

`gh`/`kubectl`-style user command extensions. An extension is an executable
named `kolm-<name>` placed under `~/.kolm/extensions/` or anywhere on your
`PATH`. When you run `kolm <name>` and `<name>` is not a built-in verb, kolm
forwards to the extension with `KOLM_EXTENSION=1`, `KOLM_VERSION`, and
`KOLM_EXT_NAME` set in its environment.

Core verbs can **never** be shadowed by an extension. `KOLM_API_KEY` is injected
into an extension only when its manifest sets `wants_api_key: true`. This is
distinct from `kolm plugin`, which loads in-process capability hooks rather than
forwarding to a separate binary.

## Usage

```
kolm extension list [--json]                         enumerate managed + PATH extensions
kolm extension install --bin <path> [--name <n>] [--yes]   install a local binary
kolm extension remove <name>                         delete a managed extension
kolm extension exec <name> [args...]                 run even a core-shadowing extension
kolm extension dir                                   print the extensions directory
```

`kolm ext` is an alias for `kolm extension`.

## Flags

- `--bin <path>` path to the executable to install (`install`).
- `--name <n>` override the extension name (defaults to the binary's basename).
- `--yes` skip the confirmation prompt on `install`.
- `--json` machine-readable output for `list` / `dir`.

## Examples

```
# Install a local binary as `kolm hello`
kolm extension install --bin ./kolm-hello --yes

# List everything kolm can forward to
kolm extension list --json

# Run an extension that happens to share a name with planning, explicitly
kolm extension exec hello --flag value

# Where do managed extensions live?
kolm extension dir
```

## Caveats

- Built-in verbs always win; `kolm <core-verb>` never forwards to an extension.
- An extension only receives your API key when it opts in via its manifest.
