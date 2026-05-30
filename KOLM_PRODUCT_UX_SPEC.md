# kolm — Product UX Spec & "Finished Product" Gap Plan
_Map of who uses kolm, for what, through which surface — and the gaps to a fully finished product._
_Created 2026-05-30._

## 0. What kolm is (the value loop)
**An AI compiler + private model runtime.** Point it at a task → it distills a frontier "teacher" into a small open student, quantizes it (INT4/GGUF), signs it (`.kolm` + Ed25519 receipt), and lets you **run it anywhere and reach it from anywhere** — with a verifiable receipt for every step.

```
 DESCRIBE / DATA → DISTILL (teacher council) → QUANTIZE (INT4/GGUF) → .kolm artifact (signed)
                                                                          │
                          ┌───────────────────────────────────────────────┤
                     RUN local (5090) / cloud (RunPod via Vercel key)   EXPORT (R2/GitHub/HF/Ollama)
                          │                                                │
                     SHARE → auth-gated phone link (kolm login)        BACKUP (conversations → account)
```

## 1. Personas (who)
| | Persona | Has GPU? | Wants |
|---|---|---|---|
| A | **Solo dev w/ GPU** (you) | 5090 | best model on my card, reachable from my phone, private |
| B | **Solo dev, no GPU** | — | distill/run in the cloud, cheap, no infra |
| C | **Startup team** | mixed | shared models, per-seat access, export to their stack |
| D | **Enterprise** | on-prem | BYOC, audit/receipts, SSO, data never leaves |
| E | **Hobbyist** | gaming GPU | "make me a tiny model that does X", chat with it |
| F | **ML engineer** | cluster | full recipe control, benchmarks, reproducibility |

## 2. Jobs-to-be-done (what for)
1. **Make a small model that does my task** (distill/finetune) — function-calling, support, reasoning, a vertical.
2. **Run a strong model on my own hardware** (best-on-5090 = Qwen3.5-9B; or a 32B INT4).
3. **Reach my model from anywhere** (phone link, API, teammates) — privately.
4. **Give the model powers** (live web search, tools, system context).
5. **Keep my work** (conversation history, model versions) and **move it** (export to R2/GitHub/HF/Ollama/DB).
6. **Trust it** (signed receipts, eval numbers, attribution).

## 3. End-to-end journeys (happy paths)
**A — Solo dev w/ GPU (today, working):**
`kolm login` → `kolm compile --data mine.jsonl` (or run Qwen3.5-9B) → `kolm share --model X` → **pre-authed phone link** → chat (web search + tools) → conversations auto-back-up to account → `kolm export --to github`.

**B — Solo, no GPU:** `kolm login` → `kolm compile --describe "support bot" --runner runpod` (Vercel-key proxy rents the GPU) → artifact downloads → `kolm serve`/`kolm share`.

**C — Startup team:** owner `kolm login` → trains → `kolm share` (per-seat, account-gated) → teammates open the link, sign in with their own keys (same tenant) → export to the team's HF org.

**D — Enterprise:** BYOC deploy (`kolm serve --k8s`), SSO, every inference carries a signed receipt; data stays in their VPC; export to their internal registry/DB.

**E — Hobbyist:** `kolm signup --email` → `kolm compile --describe` → `kolm share` → chat on phone.

**F — ML engineer:** recipe YAML → multi-teacher council → benchmarks (MixEval/SWE-bench) → published model card + receipt.

## 4. Surface map
- **CLI (primary, terminal-native):** `login/signup` · `compile/distill/quantize` · `serve/share` · `export/push` · `chats` · `whoami/account` · `tunnel`. The spine — auth + everything flows from `kolm login`.
- **Chat UI (served model):** mobile-first, **sign-in gate (or pre-authed via CLI link)**, tool 🔎 pills, system context, conversation history drawer.
- **Account web (`kolm.ai/account`):** **Models** (trained + hosted, with Chat/Export/Share), Conversations (cloud history), Keys, Billing, Usage/receipts.
- **API (`/v1/*`):** OpenAI-compatible gateway, `/v1/conversations`, `/v1/exports`, `/v1/whoami`, `/v1/runpod` (Vercel-key proxy).
- **SDKs:** OpenAI-compatible drop-in.

## 5. Terminal-native auth spine (the fix this round)
`kolm login` / `kolm signup --email` → key in `~/.kolm/config.json`. **`kolm share` reads that session and embeds it in the phone link (`#k=…`)** → phone opens pre-authed, no pasting. Web fallback: the sign-in gate. (Next: `kolm login` device-code/OAuth for zero-key onboarding.)

## 6. Gap analysis → "fully finished product"
**✅ Done:** distill/quantize, signed artifacts + receipts, gateway, local+cloud serving, auth-gated phone access, live web search, system context, terminal-native auth + pre-authed links.

**🟡 Building now (workflow):** conversation cloud-backup (`/v1/conversations`), model export (R2/GitHub/HF/Ollama/DB), `/account/models` page.

**🔴 Gaps to finish (prioritized):**
1. **P0 — Pre-authed link + chat history** (this round): land the `#k=` fragment-auth in the chat UI + the history drawer; deploy.
2. **P0 — `/account/models` as home base:** one place to see/chat/export/share every model; wire to real backend lists.
3. **P1 — `kolm login` device-code/OAuth:** zero-key onboarding (`kolm login` → browser approve → done), so non-devs never touch a key.
4. **P1 — Persistent named tunnel** on `chat.kolm.ai` (CF token) + model-as-service, so links survive reboots (today's quick tunnels are ephemeral).
5. **P1 — Export tokens UX:** store GitHub/HF tokens per-account (encrypted) so export is one click.
6. **P2 — Team/seat sharing:** invite teammates to a tenant; per-seat keys; shared model list.
7. **P2 — Model lifecycle:** versions, rollback, "improve" loop (autopilot), eval badges on each model card.
8. **P2 — Billing/usage clarity:** per-model + per-tenant usage, receipts viewer.
9. **P3 — Mobile polish:** installable PWA for the chat, push notifications on "training done".
10. **P3 — Multimodal + voice** in the chat (Qwen3.5 is multimodal-capable).

**Definition of "finished":** a non-expert can `kolm login`, make or pick a model, and reach it privately from their phone with history + tools — and a team/enterprise can do the same with sharing, export, receipts, and persistence. Items P0–P1 close the everyday-product gap; P2–P3 close the team/enterprise + polish gap.
