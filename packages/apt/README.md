# Debian / Ubuntu .deb for kolm

Ship a `.deb` so kolm installs via `apt`.

## Install (once the package server is published)

```sh
curl -fsSL https://kolm.ai/apt/kolm.gpg | sudo gpg --dearmor -o /etc/apt/keyrings/kolm.gpg
echo "deb [signed-by=/etc/apt/keyrings/kolm.gpg] https://kolm.ai/apt stable main" | \
  sudo tee /etc/apt/sources.list.d/kolm.list
sudo apt update
sudo apt install kolm
kolm --version
```

## Files

- `kolm.control` &mdash; the Debian control stanza. Package metadata, deps,
  description. Depends on Node 20+; recommends Python 3.10+ for the
  optional trainer.

## Building the .deb

The local package builder lives at `scripts/build-deb.mjs`.

Dry-run the package plan without writing files:

```sh
node scripts/build-deb.mjs --dry-run --json
```

Build or stage the package layout:

```sh
node scripts/build-deb.mjs --out=build/deb
```

Where `build/kolm_0.2.6_all/` contains:

```
DEBIAN/control     (this file)
usr/lib/kolm/cli/  (the Node entry point and src/)
usr/bin/kolm       (shim: exec node /usr/lib/kolm/cli/kolm.js "$@")
usr/share/doc/kolm/  (LICENSE, README, changelog.Debian.gz)
```

If `dpkg-deb` is available, the builder also emits
`build/deb/kolm_<version>_all.deb`. If it is not available, the staged
layout is still produced so CI or a Debian-capable release host can package
the exact same tree.

## Why we keep this minimal

The kolm runtime trainer is Python and lives in `apps/trainer/`. Packaging it
as system Python is a support nightmare on Debian (PEP 668, externally
managed env, etc.). The recommended path is `kolm doctor` after install &mdash;
that prompts the user to install the trainer in a venv they control.

## License

Apache-2.0.
