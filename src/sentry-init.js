// Server-side Sentry init shim.
//
// Opt-in via SENTRY_DSN. If the env var is absent OR @sentry/node is not
// installed in this deployment, this module is a safe no-op and returns
// null without throwing. The intent is that an operator who wants crash
// visibility runs `npm install @sentry/node` and sets SENTRY_DSN; everyone
// else boots exactly as before.
//
// Why dynamic import: @sentry/node is intentionally NOT in package.json so
// the default install footprint stays small. Sites that need it opt in.
//
// Caveats: tracesSampleRate is held at 0.1 — adjust per traffic. Release
// tagging requires KOLM_RELEASE (commit SHA / semver) to be set at boot;
// without it Sentry groups crashes under "unknown".

export async function initSentry({
  dsn = process.env.SENTRY_DSN,
  environment = process.env.NODE_ENV || 'production',
  release = process.env.KOLM_RELEASE,
  tracesSampleRate = 0.1,
} = {}) {
  if (!dsn) return null;
  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({ dsn, environment, release, tracesSampleRate });
    return Sentry;
  } catch (_err) {
    // @sentry/node not installed in this deploy. Boot continues silently.
    return null;
  }
}

export default initSentry;
