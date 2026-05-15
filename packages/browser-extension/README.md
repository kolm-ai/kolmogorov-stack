# kolm Verify (browser extension)

A Chrome / Chromium-compatible extension that wraps the browser-side `.kolm`
verifier (the same code path as <https://kolm.ai/verify-prod>) and surfaces
it on every right-click of a `.kolm` link.

## What it does

- Adds a context-menu item: **Verify with kolm** on any `*.kolm` link.
- Watches `chrome.downloads` and remembers the most recent `.kolm` file you
  downloaded.
- Opens a verifier tab that re-runs the same 6 checks the public verifier
  does:
  1. parse `manifest.json`
  2. recompute the CID
  3. walk the HMAC receipt chain
  4. recompute the K-score against the gate
  5. confirm provenance
  6. verify the issuer signature

Everything runs in the extension sandbox. No upload, no telemetry. The
only network call is a one-shot fetch of the kolm issuer pubkey from
`https://kolm.ai/.well-known/kolm-issuer-pubkey.json`, cached for 24h.

## Install (developer mode, until store listing lands)

1. Clone this repo.
2. Run `npm run build` from `packages/browser-extension` (no build step
   needed today; this is a pure ES module + MV3 manifest).
3. Open `chrome://extensions`.
4. Toggle **Developer mode** on.
5. Click **Load unpacked**, point it at `packages/browser-extension/`.

## Files

```
manifest.json     MV3 manifest, requests "downloads" + "contextMenus" + "storage"
background.js     service worker: context menu + downloads hook + issuer key cache
popup.html/.js    toolbar popup (status + link to /verify-prod)
verifier.html/.js verification tab opened from the context menu
icons/            16/48/128 PNGs (TODO: drop the kolm mark in here pre-store-listing)
```

## Why a separate package

The CLI verifier (`kolm verify`) is for compilers, CI, and operators. The
browser verifier is for the auditor, the procurement reviewer, the
underwriter, the regulator &mdash; people who want a one-click answer
without installing a CLI. The extension makes the browser verifier
ambient: any `.kolm` link on any page becomes verifiable.

## License

Apache-2.0. Same as the rest of the kolm stack.
