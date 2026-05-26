# Winget manifests for kolm

Ship the kolm CLI through `winget` on Windows 10+ / Server 2019+.

## Install once the manifest is in winget-pkgs

```powershell
winget install kolm.kolm
```

Or, before the manifest lands in the public registry, install locally from this
directory:

```powershell
winget install --manifest packages/winget --accept-package-agreements
```

## Files

- `kolm.kolm.yaml` &mdash; version manifest (points at the locale + installer).
- `kolm.kolm.installer.yaml` &mdash; per-architecture installer manifest. Pulls a
  zipped portable Node bundle from a tagged GitHub release.
- `kolm.kolm.locale.en-US.yaml` &mdash; metadata: publisher, license, tags.

## Submitting to the public registry

1. Tag a release on `kolm-ai/kolm-stack` (`v0.2.x`) with portable
   zips for x64 + arm64 attached.
2. Compute SHA-256 of each zip:
   ```powershell
   Get-FileHash kolm-0.2.6-win-x64.zip -Algorithm SHA256
   ```
3. Update the two `InstallerSha256` fields in `kolm.kolm.installer.yaml`.
4. Validate locally:
   ```powershell
   winget validate --manifest packages/winget
   ```
5. Fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs),
   drop these three files under `manifests/k/kolm/kolm/0.2.6/`, open a PR.

## Notes

- We depend on `OpenJS.NodeJS.LTS >= 20.0.0`. Winget will install Node first
  if the user does not already have it.
- The package installs as a portable, not an MSI. No registry writes, no
  Add/Remove Programs entry. `winget uninstall kolm.kolm` simply deletes the
  unpacked directory.
- The CLI shim is `cli\kolm.cmd` which calls `node cli\kolm.js`. The shim is
  symlinked into the user's WinGet portable path so `kolm` works from any
  shell.
