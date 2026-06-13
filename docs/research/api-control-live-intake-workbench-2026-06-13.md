# API Control Live Intake Workbench - 2026-06-13

## Sources Rechecked

- Pioneer Agent, arXiv 2604.09791, submitted 2026-04-10: https://arxiv.org/abs/2604.09791
- Data Product MCP, arXiv 2601.08687 v2, revised 2026-05-11: https://arxiv.org/abs/2601.08687
- MuleSoft API Management, checked 2026-06-13: https://www.mulesoft.com/api/management
- Workato Enterprise MCP, checked 2026-06-13: https://www.axios.com/sponsored/workato-delivers-industrys-first-enterprise-mcp-platform-for-ai-agents
- Vercel Web Interface Guidelines, checked 2026-06-13: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md

## Gap

The API Control Center already described universal intake and the backend already accepted arbitrary prompt, response, payload, event, data, and request bodies. The UI still relied on a static curl example, which made the most important enterprise claim feel like documentation rather than a live control plane.

## Product Decision

The account API Control Center now renders a live universal-intake workbench:

- Visible controls for source id, channel family, direction, retention class, and payload JSON.
- A submit path wired to `POST /v1/account/api-control-center/events`.
- An `aria-live` receipt result that surfaces receipt id, schema state, policy, redaction result, direction, and channel family.
- JSON parsing feedback before network submission.
- Secret-safe rendering: submitted sensitive values must not appear in the receipt panel.

## Competitive Reasoning

Pioneer pressures the failure-to-artifact loop, but that loop starts only if production events can be captured and governed. MuleSoft and Workato pressure enterprise API and MCP governance, but Kolm's response should be source-to-proof: an event enters, policy declares how it is handled, receipts prove the transition, and future compile/export steps can link to that receipt.

The workbench makes that contract visible and testable without claiming semantic understanding of unknown vendor payloads. Unknown or generic payloads remain opaque unless schema hints, adapter manifests, native connectors, or runtime target evidence justify stronger claims.

## Verification Requirement

This pass requires both static and live proof:

- Static page tests must assert the workbench hooks and copy.
- Backend tests must continue to assert canonical event envelopes and redaction.
- Browser smoke must create a workspace, load the control center, post a payload with a sensitive email, render a `rcpt_` receipt, and verify the email does not appear in the receipt UI.
