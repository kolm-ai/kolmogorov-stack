# Status Deploy Command Center - 2026-06-13

## Sources Rechecked

- Vercel Web Interface Guidelines, checked 2026-06-13: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
- Railway project config in `railway.toml`, checked 2026-06-13.
- Vercel rewrite contract in `vercel.json`, checked 2026-06-13.
- Product readiness closeout in `public/product-readiness-closeout.json`, checked 2026-06-13.

## Gap

The public status page described source-to-proof status, but it did not behave like an infrastructure operator surface. A serious infra site should show what an operator checks before and after deployment, not only static platform prose.

## Product Decision

The status page now renders a deploy command center that reads public contracts live:

- `GET /health` for uptime.
- `GET /ready` for production readiness.
- `GET /v1/product/graph` for route inventory.
- `GET /product-readiness-closeout.json` for external proof gates.

It also publishes the deployment sequence that matches the current architecture:

1. Run local verification gates.
2. Deploy Railway first because Vercel rewrites `/v1/*`, `/health`, and `/ready` to the Railway backend.
3. Deploy Vercel second for the public site shell and static assets.
4. Recheck `/ready` and `/v1/product/graph` after deployment.

## Truth Boundary

The page must not turn green uptime into production-final product claims. Public benchmark data, live certification, package release, standards/foundation acceptance, SDK/mobile/browser package release, and external runtime adoption gates remain open until the readiness ledger promotes them.
