# kolm install

Install a `.kolm` artifact into the local runtime registry so other
verbs (`kolm run`, `kolm serve`, `kolm replay`) can resolve it by name.

## Usage

```
kolm install <artifact.kolm>
kolm install <artifact.kolm> --alias <name>     # name for local lookup
kolm install <artifact.kolm> --force            # overwrite existing alias
kolm install --list                             # list installed artifacts
kolm install --remove <name>                    # uninstall by alias
```

## Where things live

Artifacts are installed to `~/.kolm/registry/<alias>/` with the
manifest, receipts, and weights laid out side by side. A small JSON
index at `~/.kolm/registry/index.json` maps aliases to paths.

## See also

- `kolm run <name>` to invoke an installed artifact.
- `kolm serve <name>` to expose it over HTTP.
- `kolm verify` to re-check signatures before install.
- `kolm install-device` for sideload to a connected edge device.
