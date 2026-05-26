# Sentry setup (operator runbook)

Crash reporting on both the gateway and the frontend is **opt-in**. With no
configuration the system boots and renders exactly as before — no network
calls are made to Sentry, no SDK is loaded.

## What you get when you turn it on

- Gateway (`server.js`): uncaught exceptions, unhandled rejections, and
  Express middleware errors are reported to your Sentry project with the
  release tag from `KOLM_RELEASE`.
- Frontend (`public/index.html`): browser exceptions, promise rejections,
  and slow page loads are reported with the same release tag.

Both paths sample traces at **10%** by default. Adjust in
`src/sentry-init.js` (server) and `public/sentry-init.js` (client) if
your traffic profile needs more or less.

## Step 1 — create the Sentry project

Create two projects in your Sentry org:

- `kolm-gateway` (platform: Node.js)
- `kolm-frontend` (platform: Browser JavaScript)

Copy the DSN for each.

## Step 2 — install the SDKs in production

These packages are deliberately **not** in `package.json` so deploys that
do not want crash reporting do not pay the install cost. Install them at
the deployment layer:

```
npm install @sentry/node
```

The frontend SDK is loaded lazily from a CDN on first page view *only if*
a DSN is configured — no install step is required for the browser.

## Step 3 — set the two environment variables

Set these on the gateway host (Vercel / Railway / your VM):

| Env var          | Value                                                         |
|------------------|---------------------------------------------------------------|
| `SENTRY_DSN`     | DSN from the `kolm-gateway` project                           |
| `KOLM_RELEASE`   | git SHA or semver, e.g. `0.2.6+a5c44b29`                      |

`KOLM_RELEASE` is optional but strongly recommended — without it, Sentry
groups every crash under a single "unknown" release and regressions become
much harder to attribute.

`NODE_ENV` (already set in production deploys) is used as the `environment`
tag so dev/staging/prod crashes are partitioned automatically.

## Step 4 — wire the frontend DSN

The frontend reads its DSN from one of three places, in order:

1. `window.__KOLM_SENTRY_DSN__` — set inline before the script tag runs
2. `<meta name="sentry-dsn" content="...">` — added to the head at build time
3. (no DSN found) — the script no-ops

Option 2 is recommended. Add the meta tag to `public/index.html` head as
part of your deploy step, or use a Vercel build-time substitution.

Optional companion meta tags:

```html
<meta name="sentry-release" content="0.2.6+a5c44b29">
<meta name="sentry-environment" content="production">
```

## Step 5 — verify

After deploy, trigger a known error and confirm it lands in Sentry:

```
# server
curl -X POST https://kolm.ai/v1/_debug/throw    # if you wire a debug route
# client
window.Sentry?.captureMessage('manual probe')   # in browser devtools
```

Then `Settings → Releases` in Sentry should show the `KOLM_RELEASE` tag.

## Caveats / Constraints

- The gateway shim catches the `ImportError` for `@sentry/node`. If you
  forget to `npm install @sentry/node`, the server still boots — no crash
  reports will flow until the install is complete.
- The frontend shim loads `@sentry/browser` from jsDelivr. If your CSP
  blocks third-party scripts you must either self-host the bundle or add
  `cdn.jsdelivr.net` to `script-src`.
- PII scrubbing is the operator's responsibility. Configure
  `beforeSend` in either init file if you handle regulated data.

## Turning it off

Unset `SENTRY_DSN` on the gateway and remove the `meta[name=sentry-dsn]`
tag (or unset `window.__KOLM_SENTRY_DSN__`) on the frontend. No code
change required.
