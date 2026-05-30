# Frontier copy rubric — apply to EVERY page in the overhaul

Derived from the /proof copy workshop (4 directions → 3-persona judging → synthesis, 2026-05-30). This is the bar. A page is not "done" until its copy passes every rule below. The reference implementation is `public/proof.html`.

## The rules

1. **Lead from the reader's situation and what's at stake, not the mechanism.** Name a concrete moment (the 2am post-mortem, the deal-blocking questionnaire) before you introduce a single technical term — earn the detail later.
2. **Write outcome-first.** State the job the reader gets done ("prove what ran"), then the property that delivers it ("Ed25519 signature"). Never the reverse.
3. **One big idea per section, one claim per sentence.** If a sentence carries two ideas, split it — density reads as evasion to a sharp reader.
4. **Every number is checkable and bounded.** Cite the exact figure, name the task it applies to, and link the underlying data. Volunteer the limit of your own claim — a stated scope buys more trust than the number itself.
5. **Prefer concrete, falsifiable lines over adjectives.** "A tampered field fails the check" beats "tamper-proof." Cut any sentence that survives deletion without losing meaning.
6. **Ban filler and hype:** no "powerful," "seamless," "unlock," "leverage," "robust," "next-generation," "world-class," "proof not promises," "empower," "revolutionize." **Never use the word "honest" or any form of it.**
7. **Subordinate table stakes to the moat.** Name what's merely present (SSO, SCIM, RBAC), frame it as the floor, then point at the one thing nobody else ships (cryptographic signed receipts). Tell the reader what to compare on.
8. **Reserve the brand accent for the receipt and verify;** render hashes and signatures in mono so they read as cryptographic facts, not metadata. Let the artifact carry weight the copy doesn't have to.
9. **Use real contact and real artifacts only.** The only contact is `dev@kolm.ai`. No fabricated traction, logos, customer names, or usage counts — omit anything not real.
10. **Close with an action the reader can take right now** ("Verify a receipt"), not a soft "talk to us." On a trust page, the strongest CTA is the one that lets them test the claim.

## Why this beat the old copy (the lesson)

The first draft led with the cryptography — "a signed receipt for every token," "Ed25519," "lineage / integrity / authenticity." That is what *we* care about building. A user doesn't wake up wanting a receipt, and nobody thinks in "tokens." Frontier copy starts at the reader's moment of stakes and earns the mechanism afterward.

## Page-level voice

- **Stance:** *Don't trust us — verify everything.* On-brand for an own-your-AI, open company, and it's the whitespace no competitor occupies (Grok-validated, 2026-05-30). Every claim on a page should be checkable: quality via reproducible benchmark data, provenance via a signed receipt.
- **H1 test:** does it land in <2 seconds for an indie dev, an eng manager shipping to prod, AND a regulated-enterprise buyer? If it only lands for one, it's a section, not an H1.
