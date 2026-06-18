# Kolm RAG for VS Code

Preview extension for passive suggestion-acceptance monitoring, repeated-pattern clustering, and local distill-routing controls inside trusted VS Code workspaces.

## Scope

- Watches document-change shapes that look like accepted AI suggestions.
- Groups repeated captures into lightweight local clusters.
- Surfaces distill-ready clusters through the status bar and commands.
- Can route matching prompts to a registered local `.kolm` artifact after distill.

The extension does not claim access to private provider accept events. It uses local edit-shape heuristics and records unknown providers as `unknown` when it cannot identify the active source.

## Workspace Trust

Kolm RAG requires a trusted, local workspace because it observes accepted editor text and can invoke the local `kolm` CLI. It is disabled for untrusted and virtual workspaces.

## Commands

- `Kolm RAG: Open Distill Dialog`
- `Kolm RAG: View Detected Clusters`
- `Kolm RAG: Toggle Local Routing`

## Release Status

This package is wired into the local package-release readiness audit. Public Marketplace publication remains blocked until signed release artifacts and channel metadata are available.
