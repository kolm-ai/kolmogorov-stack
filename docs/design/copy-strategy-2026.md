# kolm.ai — Commercial Messaging Framework & Voice Guide (2026)

**Status:** Canonical. This governs all customer-facing prose on kolm.ai and audit.kolm.ai.
**Scope:** Rewrite the PROSE — eyebrows, headlines, ledes, body, card copy, CTA labels, meta/og descriptions. Keep all datasheet labels (LATENCY, ARTIFACT, sha256, route paths, code), wiring, links, and SEO structure.
**Why this exists:** Today's copy sells the developers' internal architecture vocabulary back to the buyer. It narrates its own honesty and its own backend, never the customer's outcome. A smart buyer reads it and cannot say what Kolm does *for them*. This doc fixes that.

---

## 0. What Kolm actually is (the ground truth all copy must tell)

Kolm is a **drop-in proxy** for your existing OpenAI- and Anthropic-compatible API calls. You point your traffic at it — no SDK rewrite. It captures the calls, compiles the behavior you actually use into a signed, portable **`.kolm` artifact** (model + recipe + evals + receipt), and runs that artifact on the smallest runtime that fits: laptop, your VPC, edge, or server.

The result: teams stop paying frontier API prices forever to re-run behaviors they've already established. They **own a portable, verifiable model** instead of renting one. Every artifact is **Ed25519-signed and independently verifiable**. No provider lock-in. An **API Control Center** handles capture, policy, eval, compile, deploy, and export.

That is the whole story, and it is enough. Confidence comes from this concrete truth — not from adjectives, not from hedging.

---

## 1. The positioning one-liner

> **Own the AI you're renting.**
> Kolm turns your live OpenAI and Anthropic calls into a signed model you run on your own hardware — drop-in, verifiable, yours.

**Why this wins:** The best line on the entire site today is buried in the index CTA — *"Own the behavior you're renting."* That is the actual value: stop paying per-call forever; own a model that runs on your hardware. It should be the homepage H1 and the spine of every page.

**Hero pattern (category + outcome, Stripe/Cohere school):**
- Hero line: a 3-5 word ownership promise — *Own the AI you're renting.*
- Subhead: one sentence that says *what it is* + *the payoff*, scale-spanning so a solo dev and a platform team both feel home — *"From your first captured call to your billionth, run the behavior you've already paid for — on a laptop, your VPC, or the edge."*

---

## 2. Value pillars (in customer language)

Four pillars. Every page maps to these. Each leads with the outcome the buyer feels, then earns it with the concrete capability.

### Pillar 1 — Cut the bill
**Stop paying frontier prices to re-run behavior you've already established.** Once Kolm has captured how you use the API, it compiles that behavior into a model you run yourself. You pay to run it, not to rent it — every call after that is yours.
- Eyebrow: `STOP RENTING`
- Card line: *"Re-running the same behavior shouldn't cost the same as inventing it. Run it on your hardware and stop paying per call."*

### Pillar 2 — Own the model
**A portable `.kolm` artifact is yours — model, recipe, evals, and receipt in one file.** Not an endpoint you rent, not a weight blob you can't audit. Export it, move it, keep it. No provider lock-in.
- Eyebrow: `IT'S YOURS`
- Card line: *"Your behavior, compiled into one portable file you own and can move anywhere."*

### Pillar 3 — Ships anywhere
**Runs on the smallest runtime that fits — laptop, VPC, edge, or server.** Drop-in proxy on the way in, so there's no SDK rewrite to get here. Pick where it runs based on where it actually fits, with the limits shown.
- Eyebrow: `RUNS WHERE YOU NEED IT`
- Card line: *"Point your existing calls at Kolm — no rewrite — then run the result on the hardware you already have."*

### Pillar 4 — Provable trust
**Every artifact is Ed25519-signed and independently verifiable.** Anyone can check the signature without trusting us. You ship a model with proof of exactly what it is and how it behaves — verification built in, not bolted on.
- Eyebrow: `VERIFY IT YOURSELF`
- Card line: *"Every artifact is signed. Verify it yourself — no trust required."*

---

## 3. Voice & tone rules

**Voice:** Confident infrastructure. Plain Anglo-Saxon verbs (own, run, ship, capture, verify, cut, keep). Speak to the buyer — AI/platform engineers and their leadership — never to ourselves. Authority comes from concrete truth and specifics, not buzzwords.

**Tone:** Direct, calm, certain. Stripe / Linear / Vercel / Supabase register. Short, scannable, parallel. Headlines are promises that a smart buyer gets in one read.

### The rules

1. **Lead with the customer's outcome, every headline.** Cost saved, model owned, ships anywhere, provable trust. Never lead with the architecture.
2. **Benefit first, feature trailing, same line.** Outcome leads; the spec earns it. Use the "so you can…" payoff clause.
3. **Never describe the website, the backend, or our own honesty on the website.** No meta. State the truth; don't narrate that you're being truthful.
4. **Active voice, concrete nouns, no hedging.** Delete "honest"/"honestly" as a hedge — just say the true thing.
5. **Imperative headlines, 3-5 words, often ending in a period.** Build a scannable spine of promises with parallel rhythm.
6. **Numbers as proof, not adjectives.** A real limit, latency, or count beats "powerful"/"robust"/"comprehensive."
7. **Kill a buyer fear in the differentiator line.** Name the dread (lock-in, opaque cost, unverifiable models) and state it dead.
8. **CTAs are verbs, tiered by intent.** Low-friction self-serve beside high-commit sales. Never "Learn more."
9. **Translate every acronym/spec inline.** Ed25519-signed → "signed so anyone can verify it." VPC → "your private cloud."
10. **No internal jargon as customer copy, ever** (see §5 banned list). Translate each instance into a plain benefit.

### Do / Don't (with 5 live rewrites)

**Rewrite 1 — pricing H1**
- DON'T: *"Price the controlled loop, not generic AI seats."*
- DO: **"Pay to run your model, not to rent someone else's."**

**Rewrite 2 — platform H1**
- DON'T: *"The platform is the behavior-to-artifact control plane."*
- DO: **"Turn your live API calls into a model you can run anywhere."**

**Rewrite 3 — how-it-works H2**
- DON'T: *"Four stages, each producing an object an operator can inspect."*
- DO: **"Four steps from your API traffic to a model on your own hardware."**

**Rewrite 4 — platform/pricing meta lines**
- DON'T: *"The backend standard is stricter than the website copy."* / *"The public plan catalog mirrors the backend."*
- DO: **"Every plan, with real limits — no surprises."**

**Rewrite 5 — compare / how-it-works "honest" hedging**
- DON'T: *"Honest readiness scope."* / *"Choose a runtime honestly."*
- DO: **"Runs where it actually fits — with the limits shown."**

**General do/don't pairs**
- DON'T name internal planes as headlines ("Policy Plane / Evaluation Plane / Compiler Plane"). DO say what each gives the buyer: *"Set the rules. Test the behavior. Compile the model."*
- DON'T brag about missing proof ("8 open readiness gates"). DO state what is true and shipping today.
- DON'T count internal plumbing as a proof strip ("17 capture channels · 5 runtime targets"). DO attach an outcome: *"Capture from the tools you already use. Run on the hardware you already have."*

---

## 4. The honest-confident claim set (say these, plainly and proudly)

These are TRUE. State them as facts, no hedging:
- **Drop-in proxy** — works with your existing OpenAI-/Anthropic-compatible calls, no SDK rewrite.
- **Capture → compile → deploy** — your live behavior becomes a portable `.kolm` artifact (model + recipe + evals + receipt).
- **Runs locally and portably** — laptop, your VPC, edge, or server; the smallest runtime that fits.
- **Ed25519-signed + independently verifiable** — anyone can check the signature without trusting Kolm.
- **No provider lock-in** — export and move your artifact; it's yours.
- **Cost of running locally vs. renting forever** — you stop paying per-call to re-run established behavior.
- **API Control Center** — capture, policy, eval, compile, deploy, export in one place.

---

## 5. Banned words & claims

### Banned CLAIMS — CI fails the build on these. NEVER write any of:
- SOC 2 / HIPAA / ISO / FedRAMP / EU AI Act / SLSA compliance or certification claims
- Fake benchmarks or accuracy/performance numbers
- Absolutes: "data never leaves" / "zero egress" / "air-gapped" / "no internet at runtime" / "PHI never leaves"
- On-chain / anchoring claims
- "Mobile SDK" / shipped WASM-runtime claims
- Fake install commands (`install.sh`, `brew/pip/cargo install kolm`)

### Banned JARGON — translate every instance into a plain customer benefit. Never customer-facing:
"behavior-to-artifact" · "control plane" · "controlled loop" / "the loop" · "governed" / "governance" (as a headline) · "operator" / "an object an operator can inspect" · "readiness-gated" · "honest" / "honestly" (as a hedge — delete it) · "data plane / policy plane / evaluation plane" (as headlines) · "category sprawl" · "surface tour" · "operating checklist" · "the meter follows the lifecycle" · "the public catalog mirrors the backend" · "the backend standard is stricter than the website copy" · "egress"

**Rule of thumb:** if a line describes our architecture, our backend, or our own honesty — cut it and replace it with what the buyer gets.

---

## 6. The buyer & their outcome

**Who buys:** AI / platform engineers and their leadership — the team that owns the API bill and the trust story.

**What breaks today:** They're renting behavior they've already established, paying frontier prices per call forever, with no portable, verifiable model to show for it — and the risk of provider lock-in.

**What they get with Kolm:** A signed model they own and run cheaper on their own hardware, reached without an SDK rewrite, with proof anyone can verify. *Stop renting your AI; own a model that runs anywhere — with proof you don't have to be trusted on.*

**CTA pattern:** self-serve verb (e.g. `Run a capture` / `Verify an artifact`) beside high-commit (`Talk to an engineer`), closing with an assumptive question: *"Ready to own what you're renting?"*

---

## 12-LINE SUMMARY

1. Positioning one-liner: **"Own the AI you're renting."** — subhead names what it is (drop-in proxy → signed portable model) + the payoff.
2. Kolm is a drop-in proxy that captures your OpenAI/Anthropic calls, compiles them into a signed `.kolm` artifact, and runs it on the smallest runtime that fits.
3. Pillar 1 — **Cut the bill:** stop paying frontier prices to re-run behavior you already established; run it yourself.
4. Pillar 2 — **Own the model:** a portable `.kolm` file (model + recipe + evals + receipt) is yours; no lock-in.
5. Pillar 3 — **Ships anywhere:** laptop, VPC, edge, or server — drop-in, no SDK rewrite.
6. Pillar 4 — **Provable trust:** every artifact is Ed25519-signed and independently verifiable, no trust required.
7. Voice: confident infrastructure, plain verbs, benefit-first lines, speak to the buyer — outcome leads, spec earns it.
8. Headlines: 3-5 word imperative promises ending in a period; numbers as proof, not adjectives; kill a buyer fear in the differentiator line.
9. Five rewrites shipped (pricing H1, platform H1, how-it-works H2, meta lines, "honest" hedging) as commercial samples.
10. Honest-confident claim set: drop-in, capture→compile→deploy, runs locally/portably, Ed25519-signed + verifiable, no lock-in, run-vs-rent cost, API Control Center.
11. Banned: compliance/cert claims, fake benchmarks, absolutes (data-never-leaves/air-gapped), on-chain, Mobile-SDK/WASM, fake installs; plus jargon (control plane, the loop, governance, operator, readiness-gated, "honest"-as-hedge, egress, meta backend lines).
12. Buyer: AI/platform eng + leadership who own the bill and the trust story — outcome: own a cheaper model they run anywhere with verifiable proof, no rewrite, no lock-in.
