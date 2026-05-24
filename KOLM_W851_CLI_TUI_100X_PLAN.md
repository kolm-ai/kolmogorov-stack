# KOLM W851 — CLI / TUI 100x Wave Plan

Kicked off 2026-05-25 in response to user mandate:

> "for how our CLI works: i want people to be able to put in language and that language is routed into our functions with copy optimized for that function based on the language that was put in, powered by a model we put into it. does that make sense? i want people to be able to use our CLI to do whatever they want and for all our features to be accessible like this, as well as for us to show all the possible functions to call somewhere too. can you 100x our CLI and TUI UI UX and ensure it is 100% finished? per all these specs and more? document to memory and ensure its a world class experience for all product faces. ensure this saves compacting, tranche it into waves and complete it over as many waves and as many parallel agents as needed. review the whole code base for completion"

## Goal

A world-class CLI + TUI surface where:
1. **Plain English in, real command out.** Every kolm feature is reachable via natural language.
2. **Per-function copy optimization.** The output of every verb is framed by the user's input phrasing — a cost question gets cost framing, an ops question gets ops framing.
3. **Function discoverability.** Every callable function is listed somewhere users can browse — a `/commands` web page, a `kolm catalog` CLI verb, and a TUI inventory view.
4. **100% feature accessibility.** Zero features that are technically implemented but practically unreachable.
5. **World-class UX.** Errors have recovery paths. Help is progressive. The CLI/TUI feels like a designed product, not a function pile.

## Wave decomposition

### W851 — Inventory + baseline (parallel-agent scout pass)

Spawn 4 parallel exploration agents to produce a coverage matrix BEFORE writing any new code:

- **Agent A — CLI surface inventory.** For every CLI verb in `cli/kolm.js`: subject line, help text shape, flags, exit codes, output format (text/json), example invocations, whether `kolm do "<NL>"` resolves to it.
- **Agent B — TUI surface inventory.** For every TUI view in `cli/kolm.js`: key binding, header, status messages, available actions, whether it has an NL search bar.
- **Agent C — Intent classifier audit.** Read `src/intent.js` end-to-end: what is the model? (keyword + phrase match? LLM-backed? hybrid?) What is the verb-coverage rate? Which verbs have zero NL trigger phrases?
- **Agent D — Discoverability audit.** Where are functions listed today? `/commands` page exists? `kolm help all`? TUI inventory view? README sections?

Each agent returns a markdown table + a list of gaps. Outputs feed W852-W858.

### W852 — NL routing model upgrade

If W851/Agent-C finds the classifier is pure keyword matching: wire in real LLM-backed disambiguation for any query under a confidence threshold. Use existing teacher-routing infrastructure (same backend that powers `/v1/intent/ask` already), but elevate to default for low-confidence inputs instead of falling through to "ask" verb.

Atomic items will be enumerated post-W851.

### W853 — Per-function copy optimization

Every CLI verb's success/error/hint output should be framed by what the user typed. Examples:

- User types "show me what cost the most last month" → `kolm spend` output frames as "Your biggest cost line was…"
- User types "show me what API keys are mine" → `kolm account keys` output frames as "Your keys (1 active, 0 revoked):…"
- User types "is anyone using my namespace right now" → `kolm whoami --activity` output frames as "Right now: 3 active proxy calls in namespace foo…"

Implementation pattern: the intent classifier returns `verb` + `verb_args` AND a `framing_hint` describing the user's question. The dispatched handler reads `process.env.KOLM_FRAMING_HINT` (set by `_dispatchVerb`) and re-templates its preamble line. Falls back to generic copy when no hint is present (i.e. user invoked verb directly).

### W854 — 100% feature accessibility via NL

For every verb in W851/Agent-A's inventory, ensure:
- At least one NL trigger phrase registered in `src/intent.js`
- At least three representative user phrasings exist in `tests/intent-coverage.test.js`
- `kolm do "<NL>"` resolves to the right verb ≥80% on the test corpus
- The verb's `--help` shows at least three NL examples (not just flag specs)

This wave is mechanical: enumerate gaps from W851, add phrases + examples + tests.

### W855 — Discoverable function inventory

Three surfaces, same source of truth:
- **Web:** `/commands` page that renders every callable function in plain English, grouped by surface (capture / distill / compile / runtime / govern / account / billing / dev). Each entry shows the verb, what it does in one line, an NL trigger phrase, and a "try in the homepage chat" link that prefills the chat input.
- **CLI:** `kolm catalog [--json]` verb that prints the same inventory. Pipe-friendly. JSON shape matches `/v1/catalog` (new public endpoint).
- **TUI:** new TUI view (key `?` or `C`) that shows the searchable inventory. Hitting Enter on a row pre-fills the NL input bar with the trigger phrase.

Source of truth: a generated `src/catalog.js` that walks `cli/kolm.js` for HELP entries + `src/intent.js` for NL phrases + `src/router.js` for backing endpoints. Single file ships in the API too.

### W856 — TUI 100x

Audit each of the ~20 TUI views for:
- NL search bar at top (single binding: `/` to focus, type, Enter to route)
- Discoverable shortcuts (key map overlay on `?`)
- Plain-English status messages (no `EXIT.BAD_ARGS=64` jargon)
- Context-aware actions (the captures view shows "→ distill" / "→ bake-off" actions instead of forcing the user back to the CLI)
- Cool slate cosmetics (no warm pixels post-W850)

### W857 — CLI 100x

- Every error message includes a recovery path (what to type next).
- Progressive help: `kolm` → NL prompt. `kolm <verb>` → quick usage. `kolm <verb> --help` → full reference.
- Color/icon discipline (zero emojis per user preference; thin ASCII bullets only).
- `kolm <unknown>` → friendly suggestion via classifier, not a hard wall.
- `kolm history` → recent NL inputs + verbs they resolved to (great for "what did I just do" debugging).

### W858 — Whole-codebase completion sweep

Per user "review the whole code base for completion":
- Audit every TODO / FIXME / stub / 501 / `coming soon` / `production_ready: false`.
- Drive to zero or mark as intentional honesty contract (with a lock-in test pinning the contract).
- Re-run audit-static-refs + audit-href + full `node --test`.
- Report a final coverage matrix.

## Parallel-agent strategy

W851 (inventory) is the only wave that must run before everything else — its outputs feed W852-W858. Inside W851, all four exploration agents run in parallel.

W852-W857 can also run partially in parallel (W853 and W856 are independent of each other; W854 depends on W851 only).

W858 runs last — it's the verification gate.

## Definition of done (per wave)

- Every change committed to a wave-specific branch (or to main with a wave prefix in the commit subject).
- Project memory entry written the moment the wave lands (so progress survives compaction).
- `node scripts/release-verify.cjs` green on every wave that touches code under `src/` or `cli/`.
- A short "what landed" entry appended to this plan file under the wave heading.

## Standing constraints (carried into every wave)

- NEVER commit unless the user explicitly asks (carries from session-wide directive).
- Never `--no-verify` hooks; never bypass signing.
- Never force-push (except to `public/main` on kolmogorov-stack, which is the Vercel mirror).
- Never stage `.env*` / `*.pem` / `*.key` / `secrets/` / `%TEMP%tid.txt`. Delete `.env.prod` after use.
- "Skip lock-in tests entirely" — per user directive 2026-05-25. Existing lock-in tests stay; do not add new ones.
- "implement exhaustively. atomically. surgically." (verbatim).
- Cool slate aesthetic remains binding (zero warm chroma per W850 redline).
- Family-scan rule: when fixing one instance of a UI/UX issue, fix the whole family.

## Status log

- **2026-05-25** — W851+ plan file created. Project memory written. CLI/TUI 100x execution paused pending user push of in-flight W850 redline frontend.
