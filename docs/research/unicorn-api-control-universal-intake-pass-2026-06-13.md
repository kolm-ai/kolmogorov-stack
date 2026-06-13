# Unicorn API Control Universal Intake Pass - 2026-06-13

Scope: turn the unicorn/competitor research into an implementation requirement for the account API Control Center. This is an internal quality bar, not a public claim that Kolm is objectively better than every company.

## Current-source pressure

- Pioneer Agent: the frontier loop is not "train a model"; it is data acquisition, failure diagnosis, evaluation-set construction, regression avoidance, retraining, and verification from production feedback. Source: https://arxiv.org/abs/2604.09791
- Vercel AI Gateway: the gateway baseline is one endpoint across models with provider routing, model fallbacks, provider options, observability, usage/billing, authentication, BYOK, zero-data-retention controls, and ecosystem integrations. Source: https://vercel.com/docs/ai-gateway
- LiteLLM: the open gateway baseline includes 100+ LLM/provider access, OpenAI-compatible endpoints, virtual keys, budgets, rate limits, load balancing, routing, fallbacks, logging, alerts, metrics, guardrails, policies, secret managers, and spend tracking. Source: https://docs.litellm.ai/docs/proxy/quick_start
- Portkey: the advanced control baseline is a unified interface for 250+ AI models with control, visibility, security, observability, gateway, guardrails, prompt studio, MCP gateway, agent gateway, enterprise deployment options, and explicit no-body-storage/private-cloud options. Source: https://portkey.ai/docs/introduction/what-is-portkey
- Langfuse: the AI engineering baseline is traces across LLM and non-LLM calls, sessions, user tracking, agent graphs, cost/latency dashboards, prompt management, evaluations, production health, development testing, API-first exports, and enterprise administration. Source: https://langfuse.com/docs
- Braintrust: the eval/ops baseline is instrument, observe, annotate, evaluate, deploy, and administer: traces, logs, human review, datasets, experiments, online scoring, gateway, monitoring, projects, providers, and access control. Source: https://www.braintrust.dev/docs
- Airbyte: the data movement baseline is hundreds of connectors, no-code connector builder, UI, API, SDKs, Terraform, PyAirbyte, ELT/reverse ETL, self-managed, managed, and hybrid enterprise deployment. Source: https://docs.airbyte.com/platform
- Confluent: the event/data-streaming baseline is stream, connect, govern, and process: Kafka, connectors, schema registry, stream governance, Flink processing, and cloud/on-prem modes. Source: https://docs.confluent.io/platform/current/overview.html
- Kong/MuleSoft: mature API management expects hybrid/multi-cloud gateways, control planes, data planes, plugins, authentication, rate limits, observability, security, catalogs, portals, governance, and tooling like Terraform/declarative config. Sources: https://developer.konghq.com/gateway/ and https://docs.mulesoft.com/api-manager/latest/

## Product requirement

Kolm must not be a weaker clone of any single category. The winning control-center shape is:

1. Accept every credible API data shape as a governed event: prompt/response tuples, input/output tuples, payload, event, data, request, webhook, trace, batch row, stream chunk, file/blob metadata, queue message, CDC row, SIEM log, package/runtime release receipt.
2. Return a canonical event envelope on intake: event id, tenant id, source id, channel family, direction, observed time, schema confidence, payload policy, redaction result, retention class, policy decision, receipt id, and optional links.
3. Treat unknown vendor payloads honestly: opaque storage is allowed only when tenant policy, size, retention, and redaction checks pass; semantic dashboards require schema hints, adapter manifests, native connectors, or verified runtime target evidence.
4. Preserve the Pioneer-style improvement loop: observed failures must connect to taxonomy, curriculum/dataset, regression replay, compile artifact, target-fit gate, receipt, and export.
5. Keep egress stricter than ingress: outbound payloads require destination declaration, signature/receipt policy, processor identity, retry/dead-letter behavior, and redaction/retention class.
6. Make the UI prove this in the first screen of the account control center, before long channel matrices.

## Implementation lock from this pass

- `POST /v1/account/api-control-center/events` now accepts account-authenticated universal control events.
- `/v1/bridges/observe` keeps backward compatibility with prompt/response observation while sharing the same universal handler.
- The response now includes `control_event_envelope.version = kolm-control-event-envelope-1`, `required_field_status.missing = []`, `receipt_id`, `policy_decision_id`, `adapter_state`, and `secret_values_included: false`.
- Generic payload/event/data/request bodies are redacted before persistence, are stored as governed observations, and return prompt excerpts only after redaction.
- `GET /v1/account/api-control-center` is now `kolm-api-control-center-6` and advertises the universal intake route and rule.
- `/account/api-control-center` now uses the image-2 light paper design, with a dark terminal artifact for the live intake receipt.

## Non-negotiable quality bar

- Never claim every possible vendor schema is semantically understood without evidence.
- Never expose raw secrets in public/control-center envelopes.
- Never hide readiness gaps behind marketing phrasing.
- The account UI must remain dense enough for enterprise operators, but visually aligned with the image-2 site system.
- Any future connector claim must map to one of: source, sink, control verdict, evidence object, runtime target, export receipt, or governance packet.
