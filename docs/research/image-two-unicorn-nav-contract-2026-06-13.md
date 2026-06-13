# Image-2 Unicorn Nav Contract - 2026-06-13

## Sources Checked

- Workato docs: https://docs.workato.com/
- MuleSoft docs: https://docs.mulesoft.com/general/
- Airbyte platform docs: https://docs.airbyte.com/platform/
- Confluent Platform docs: https://docs.confluent.io/platform/current/overview.html
- Pioneer Agent paper: https://arxiv.org/abs/2604.09791
- Vercel Web Interface Guidelines: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md

## Market Read

Workato and MuleSoft both position around broad enterprise integration/control for AI agents, MCP, APIs, workflow execution, governance, and operations. Airbyte owns connector breadth, extension, sovereignty, and multiple operator surfaces. Confluent owns streaming connect/govern/process language. Pioneer Agent frames the closed loop around data curation, evaluation, retraining, and regression control.

The shared lesson is that the category winner does not make the header explain every capability. The header stays compact and the product body proves the system: object model, route inventory, source-to-proof path, control plane, and exportable evidence.

## Design Decision

Main `kolm.ai` image-2 pages use the local `_audit/test/ev2.png` navigation contract:

- Brand mark plus `kolm`.
- Primary links: `Solutions`, `Developers`, `Pricing`.
- Compact status icon.
- Quiet `sign in`.
- Solid `Get API key ->` CTA.

The API Control Center remains the enterprise product spine, but it should be proven in the hero/body and CTAs, not by adding another crowded primary nav link. Audit remains available as a secondary proof module, but it is not part of the main-site primary header.

## Locked Outcome

`tests/site.test.js` now rejects primary image-2 headers that reintroduce audit links, page-specific actions, or the older crowded labels: `Pipeline`, `Control`, `Integrations`, `Runtimes`, and `Compare`.

