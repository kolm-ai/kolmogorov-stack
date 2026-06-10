# SYMPHONY-SCORE-2026 - the kolm.ai page composition score (BINDING)

Status: BINDING for the symphony cohesion wave (2026-06-11). This document sits
on top of docs/UNICORN-DESIGN-2026.md and docs/GRAPHICS-SPEC-2026.md; where they
conflict, THIS file wins on composition and cadence, they win on device anatomy.
The verdict it answers: individual elements are good, but the site must read as
ONE orchestrated composition, not a collection of devices.

All hard constraints apply verbatim and are not restated in full: ASCII
punctuation only (no em or en dashes; middot ok), never the word that means
"truthfulness" in any form (use Caveats / Constraints / Limitations),
dev@kolm.ai as the only contact, locked pricing values, the exact scope line,
evidence-locked string counts (x04), forbidden substrings, hero h1 <= 68px,
exactly one .eyebrow per page, the preserved structural surfaces
(.reveal/js-reveal, cine classes, verify widget mounts, sig__ok), seam hidden
state stays on ::before, max 3 .field mounts per page.

LOCKED LINES WARNING for every page agent: the x04 gate counts EXACT appearances
of the evidence-locked strings (controls count phrases, frameworks count
phrases, the sample hash fragments, the tools-granted line, the findings tally).
Punch-list fixes NEVER touch a sentence containing one of those strings. When a
fix below would graze one, edit around it or skip that clause.

---

## 1. THE THESIS - ONE SCORE, SIX MOVEMENTS

Every page is a performance of the same score. A visitor who has read one kolm
page already knows how the next one moves: the room lights up the same way, the
seams arrive on the same beats, the one phosphor accent lands in the same
places. Devices stop being decorations a page happens to own and become
instruments that enter on cue.

The canonical movement structure (marketing pages):

```
I    OVERTURE      .hero (section--flush). Eyebrow, h1, lede, two CTAs,
                   hero__proof, the artifact/instrument right column.
                   Evidence Field mount per the W8 intensity map.
II   STATEMENT     First body section, default density, rail 01. The reader's
                   situation in the reader's words. A .seam follows the
                   section__head (the first beat of quantized light below
                   the fold).
III  CHAMBER       THE single .section--ink of the page. The mechanism demo
                   or proof object. field--band 0.10 inside it, dither-edge
                   at its bottom, ghost ordinal behind its head.
IV   DEVELOPMENT   One to three sections alternating sect--dense / default.
                   Tables, registers, FAQ. The second .seam opens the LAST
                   development section (the breath before resolution).
V    RESOLUTION    One quiet beat: a sect--air moment OR a closing
                   .hero__claim line at the end of the last body section.
                   The page never falls off a table edge into the CTA.
VI   CODA          .cta-final. Bars mark, h2, lede, two CTAs, badges,
                   dither-edge top, field--band 0.12.
```

### Per page type

- FLAGSHIP (index): the full score, six movements, both permitted sparks,
  glyph cards in the chamber.
- PROOF CORE (how-it-works, platform, checks, report, spec): full score;
  spec and checks may run register-dense and skip the air beat; the chamber
  carries the page's one diagram or the artifact plinth.
- INSTRUMENT (verify, transparency-log, status, badge, report-viewer,
  signup, dashboard, account-billing, trust-center): the instrument IS the
  page. Sanctioned short form: OVERTURE -> CHAMBER -> CODA. Status, signup,
  dashboard, account-billing and report-viewer stay still (no field, no
  seams, no ghosts); verify, badge, transparency-log and trust-center play
  the reduced score.
- COMMERCIAL (pricing, roi, compare, enterprise, both solutions pages):
  full score; the tier grid or comparison table is the development
  centerpiece; confidence through plainness, locked values verbatim.
- KNOWLEDGE / COMPANY (docs, research, glossary, changelog, careers,
  contact): the reading room. Seams yes, ghosts optional (research yes,
  docs/glossary/changelog no), ledger-index voices, quietest group that
  still closes with the standard coda.
- LEGAL / UTILITY (privacy, terms, dpa, baa, sla, acceptable-use,
  subprocessors): typeset, not designed. NO seams, NO ghosts, NO field,
  NO dither, NO sparks, NO glyphs. At most ONE quiet ink summary panel
  plus the standard cta-final close. 404 is the one art piece (full-
  intensity field, near-empty page).

---

## 2. DEVICE CADENCE (where each instrument may play)

- .seam: EXACTLY TWO per full-score page - one after the STATEMENT
  section__head, one opening the LAST development section before the
  resolution. Short-form pages (4 or fewer body movements): exactly one.
  Legal and still pages: zero. Seams always sit AFTER a section__head,
  before the body content (never between sections, never two in one
  section). The seam is the only divider voice; hr.rule--ticks is RETIRED
  for new placements (existing none remain).
- .field mounts: hero (intensity per the W8 map: index full, verify 0.20,
  subpages 0.18) + ONE mid-page field--band inside the chamber (0.10-0.11)
  + ONE field--band on .cta-final (0.12). Hard cap 3 mounts per page (WebGL
  budget). Pages with 5 or fewer total sections may drop the chamber band
  (report does). Never a band outside .section--ink/.section--lit/.cta-final.
- .dither-edge: exactly two on full-score pages - bottom of the chamber,
  top of the coda. When the chamber sits DIRECTLY against the coda, the
  junction speaks once: the SYMPHONY v3.3 CSS removes the chamber's strip
  and the coda's hairline automatically (roi, changelog, 404). Legal: zero.
- .num-ghost: MAX TWO per page - one behind the CHAMBER head, one behind
  the principal DEVELOPMENT section (the big table or register). Never on
  the hero-adjacent section (01), never on FAQ, never on the coda, never
  on legal/docs/glossary/spec/changelog/instrument pages. Ghosts are never
  resized or nudged inline: default position, or the single sanctioned
  .num-ghost--deep modifier (chamber heads under a dither-edge + band).
  If an ordinal collides with content, DROP the ghost; do not restyle it.
- .idx rail tags: every body section numbered sequentially from 01 in
  document order; hero and coda unnumbered. The tag text stays a real
  label ("03 / The deal-closer"), mono, one per rail.
- .spark: at most ONE per page, always beside a counted quantity in the
  STATEMENT or DEVELOPMENT, with .on bars matching the counted part.
  Flagship exception: index keeps its two existing sparks. Never beside
  an evidence-locked numeral in a way that adds or moves the locked text.
- Glyphs (.card__art): proof-core chamber and pillar cards only (index,
  checks today; G08-G18 library available when the concept appears).
  Max 6 per viewport region, one per card, never on .pc severity cards,
  never on legal pages.
- Severity colors: findings, tables, .sev__bar only. Never decorative.

## 3. TRANSITION GRAMMAR (which section may follow which)

1. HERO -> default-density STATEMENT. HERO -> CHAMBER directly is allowed
   ONLY on instrument/utility short forms (verify, contact, report,
   changelog, 404) where the artifact must be reached in one scroll.
2. Densities alternate. Never three consecutive sections of the same
   density token; two adjacent sect--dense are allowed only when both are
   registers of the same argument (sla-style contractual runs get re-cut).
3. ONE .section--ink and at most ONE .section--lit per page; they are
   never adjacent to each other. The chamber never opens the page and
   never closes it EXCEPT on short forms, where chamber -> coda hands off
   through the v3.3 junction rule (no doubled hairline, one dot strip).
4. ONE sect--air per page maximum - the thesis moment, the artifact
   plinth, or the resolution. If the page has no air beat, the last body
   section MUST end with a .hero__claim resolution line so the coda is
   announced, never abrupt.
5. The coda is identical sitewide: bars, h2, lede, two CTAs, badge band,
   dither-edge, field--band 0.12, and on commercial pages the mono price
   strip + Caveats line. Legal codas drop the field band and badges.

## 4. RHYTHM AND SPACING TOKENS

- Section padding: ONLY --rhy-1 (sect--dense), --rhy-2 (default),
  --rhy-3 (sect--air). NO inline padding-block on sections, ever
  (pricing #reviewed's inline 112px becomes sect--air).
- Post-head gap: .section__head owns it; no inline margins on heads.
- Closing claim lines: .hero__claim already carries margin-top var(--s4);
  inline margin-top on it is redundant drift - remove on touch.
- In-card spacing: existing utility vars (--s4..--s9) only; new inline
  px values are a review flag.

## 5. SYMPHONY v3.3 CSS (the only additions, already in kolm-2026.css)

Appended once under the "SYMPHONY v3.3" banner; additive, no device
restyling:

- .num-ghost--deep { top: -0.78em; } - the single sanctioned ghost offset.
- .section--ink + .cta-final, .section--lit + .cta-final { border-top: 0; }
  and .section--ink:has(+ .cta-final) > .dither-edge { display: none; } -
  the chamber-to-coda junction speaks once.

Nothing else may be invented for this wave. If a punch item seems to need
new CSS, it uses an existing class or escalates.

---

## 6. COPY VOICE ADDENDUM (BINDING) - the AI-symptom kill-list

The register is a confident vendor stating facts, not a model narrating its
own virtues. Lead from the reader's SITUATION; concrete nouns; verbs over
adjectives. Title, og/twitter descriptions and JSON-LD count as copy: keep
them in sync with the on-page rewrite, and JSON-LD FAQ text MUST equal the
visible FAQ text.

KILL ON SIGHT:

1. SELF-CONGRATULATION ABOUT TRANSPARENCY. A real company lists prices; it
   does not narrate that it lists them. State the fact (flat fees, listed
   in full), cut the meta-commentary praising the act of stating it. The
   line "Every price is public. No demo wall." lives on ONE surface: the
   pricing hero. Every echo of it elsewhere (index #pricing h2, enterprise
   h2, 404 card, receipt subtitles) is rewritten to lead with the offer.
2. THE TRIPLE-NEGATION TIC ("No X, no Y, no Z"). It appears 25+ times
   sitewide and has become wallpaper. AT MOST ONE per page, kept only
   where it genuinely lands (a verification-mechanics beat). Every other
   instance becomes a positive, concrete statement of the same fact.
3. RHETORICAL-QUESTION FAQ HEADINGS THAT SET UP A BRAG ("Why are the
   prices just listed?"). FAQs answer real buyer questions (cost, scope,
   term, integration). Genuine buyer questions phrased as questions stay.
4. LECTURE-Y SECOND PERSON ("Because you should not sit through a call to
   learn whether you can afford us"). Replace with plain product copy.
5. FILLER INTENSIFIERS: actually, really, genuinely, truly, simply - the
   sentence is stronger without them; delete or replace with the fact.
   "on purpose" survives only where it carries content (research h2).
6. CUTE META HEADINGS that talk about the section instead of the content
   ("Before you ask.") - name the thing ("Common questions").

WORKED EXAMPLES (taken from live copy; these exact rewrites ship):

EXAMPLE 1 - transparency self-congratulation (pricing.html FAQ + JSON-LD)
BEFORE  Q: "Why are the prices just listed?"
        A: "Because you should not sit through a call to learn whether you
            can afford us. Every fee is flat and final. Pick a plan and
            start."
AFTER   Q: "Do prices change with team size or usage?"
        A: "No. Every fee is flat and final: $750 for the signed report,
            $299 or $999 per month for Continuous. There is no per-seat
            meter and no usage tier."
        (Locked values verbatim; the JSON-LD FAQ entry updates to the
        identical text.)

EXAMPLE 2 - triple-negation wallpaper (how-it-works.html, Verify step)
BEFORE  "Offline, in their own browser, against your public key. No
         account, no upload, no kolm server in the trust path."
AFTER   "Offline, in their own browser, against your public key. The
         check needs only the report file; kolm never sees it happen."
        (The canonical triple stays ONCE on the page, in the verification
        movement; the HowTo JSON-LD step syncs to the visible text.)

EXAMPLE 3 - brag echo + lecture (enterprise.html, section 06 head)
BEFORE  h2:   "Every price is public. The paper is the kind your counsel
               knows."
        lede: "Flat fees, listed in full, on a master agreement with a
               scope defined in writing."
AFTER   h2:   "Flat fees, on paper your counsel has seen before."
        lede: "An MSA, a DPA and a named SLA, with scope defined in
               writing. Full Readiness $15,000; Reviewed Attestation
               $25,000."
        (The pricing hero keeps sole ownership of the public-prices line.)

EDITORIAL GATE NOTE: copy cuts shrink pages; that is fine - do NOT pad.
After every page: exactly one .eyebrow, zero em/en dashes, locked strings
untouched, scope line verbatim where it lives, prices verbatim.

---

## 7. PER-PAGE PUNCH LIST (39 pages)

Format: page - the 2-5 cohesion deviations to fix. "Compliant" items are
stated so agents do not invent work.

1. index.html
   - #pricing h2 duplicates the pricing hero h1 verbatim ("Every price is
     public. No demo wall."); rewrite to lead with the offer, e.g. "Start
     free. $750 when the deal needs a signature." (locked values fine).
   - Triple negation twice (step 03 "Your buyer checks it" and the #verify
     "Nothing for us to fake" card): keep the #verify card's stack, rewrite
     the step 03 tail positive.
   - "what the agent actually did" -> "what the agent did".
   - Cadence compliant (seams 2, ghosts 02+04, one chamber, both sparks
     sanctioned). Do NOT touch hero__proof or the how__foot line: locked
     strings live there.

2. pricing.html
   - FAQ Q1 is the brag archetype: apply Worked Example 1, sync JSON-LD.
   - #reviewed inline padding-block:112px -> add sect--air, drop the style;
     num-ghost inline styles (top:-0.78em; the resized 04) -> default ghost
     or .num-ghost--deep; never resize a ghost.
   - Four negation stacks (hero lede tail, hero__proof line, post-diagram
     claim, FAQ close): keep ONE (the hero__proof line), rewrite the others
     positive ("the fee you see is the whole fee").
   - FAQ h2 "Before you ask." -> "Common questions."; rep__sub "Every
     price, on one page" -> "Self-serve price list"; meta/og/twitter
     descriptions trim the negation tail, keep every locked price.

3. how-it-works.html
   - Triple negation three times plus the HowTo JSON-LD step: keep one in
     the Verify act (Worked Example 2), rewrite the rest, sync JSON-LD.
   - "actually did" twice -> "did".
   - Cadence compliant (seams 2, ghosts 02+04, INK chamber, LIT then AIR
     resolution): no structural change.

4. platform.html
   - Confirm both ghosts sit on the chamber (#onramp ink) and the principal
     development; move any that sit on 01.
   - "actually did" -> "did".
   - Last body section ("A report is a photograph") must end with a
     .hero__claim resolution line before the coda; add if missing.

5. checks.html
   - Two adjacent default-density sections after the hero: re-cut the
     second to sect--dense (the control table is the hero object).
   - Two sparks -> keep the pillar-stat spark, drop the other (max 1).
   - "actually uses" -> "uses".
   - Glyphs (6) compliant; never add glyphs to .pc severity cards.

6. report.html
   - ZERO seams: add one after the #register section__head and one opening
     #crosswalk before the table (cadence: 2).
   - Triple negation ("No account, no upload, no kolm server in the path.")
     -> single-clause positive rewrite.
   - Ghost at 02 and the #live plinth (sect--air) compliant; field mounts
     (hero + coda only) compliant for a 5-section page.

7. report-viewer.html
   - "The rendered sheet is the brightest thing in the room on purpose."
     -> drop the tail ("...renders it without editing it.").
   - One cta-final only (the second grep hit is print CSS): no change.
   - App surface: widget mounts, seal/VOID states, sig__ok untouched.

8. spec.html
   - One seam across 8 movements: add a second opening the #verifying
     register block.
   - "the format keeps them separate on purpose" -> "the format keeps them
     separate".
   - Zero ghosts is CORRECT for the machine register; do not add.
   - The three question-form h3s are genuine reader questions: keep.

9. verify.html
   - Triple negation three times including the title/meta: keep the hero
     instance; rewrite the meta description positive with the same facts;
     vary the explainer instance.
   - Short form (HERO -> INK -> CODA) is the sanctioned instrument score:
     no structural change. Field 0.20 hero + coda band compliant.

10. transparency-log.html
    - "No custody" card body ("No tokens, no wallets, no chain...") ->
      positive rewrite: "An append-only Merkle tree served over HTTPS;
      verification needs only the published root." (security.html keeps
      the group's one sanctioned stack).
    - Ghost 1 on the chamber: confirm placement; dense ledger rhythm is
      correct for this instrument page.

11. status.html
    - Two adjacent sect--dense after the hero: re-cut the second to
      default density.
    - "No credentials, no session, no server round-trip." is the page's
      single stack and lands: keep.
    - Still page (no field, no seams) is sanctioned: do not add devices.

12. badge.html
    - The canonical triple appears twice (top claim + FAQ answer): keep
      the FAQ answer's, rewrite the other.
    - "actually prove" twice -> "prove"; "really ASCII-only" -> "ASCII-only".
    - Seams 2, ghosts 2, plinth compliant: no structural change.

13. dashboard.html
    - App chrome: no devices is correct. Parity sweep only (paper primary
      button, mono registers); no copy flourishes added.

14. signup.html
    - Entrance choreography is the page's only flourish (sanctioned).
      No devices, no field. Parity sweep only.

15. compare.html
    - Longest page (9 movements): confirm ghosts sit on #table (chamber)
      and #crosswalk only; drop any third.
    - "genuinely owns / genuinely block" -> "owns / block".
    - End the FAQ with a .hero__claim resolution line so the coda is
      announced after a dense run.

16. roi.html
    - Chamber #basis directly before the coda: the v3.3 junction rule now
      handles the hand-off (no markup move required this wave).
    - "Conservative on purpose." h2 carries content: keep; sweep the body
      for intensifiers.
    - Seam 1 on a 4-movement page: compliant.

17. enterprise.html
    - Section 06 head: apply Worked Example 3 (brag echo + lecture).
    - Ghosts at 03+06: keep 03 (chamber #cosigner); move the 06 ghost to
      the principal development (#clocks) or drop it (max 2 rule).
    - Triple negation ("Offline verification" card): rewrite positive;
      page keeps at most one stack.

18. solutions/ai-vendors.html
    - Adjacent stacks in #pricing (lede "No quote, no per-seat meter, no
      contingency." + prow "No human, no call, no card."): keep the lede's,
      rewrite the prow tail ("Self-serve from the first upload.").
    - Pricing rows keep locked values verbatim.
    - Seams 2, ghosts 2, spark 1: compliant.

19. solutions/enterprise-buyers.html
    - Single stack ("No upload, no portal, no kolm server in the trust
      path.") sits in the verification beat: keep.
    - Confirm ghosts on chamber + principal development; intensifier sweep.

20. trust.html
    - Ghost 05 sits on a standard movement ("Do not take our word...");
      move it to the ink chamber head so ghosts = chamber + principal
      register.
    - "No tokens, no consensus network, no chain in the trust path." ->
      positive rewrite (security.html owns the group's one stack).
    - Seams 2, air resolution: compliant.

21. trust-center.html
    - Missing coda: add the standard .cta-final (bars, h2, lede, CTA,
      dither-edge, field--band 0.12).
    - Missing hero field: mount .field at 0.18 (page is on the W8 list).
    - The one-off .section--band chapter -> .section--ink (canonical
      chamber); keep its band field at 0.10. Total mounts after fix = 3
      (at budget; add nothing else).

22. security.html
    - KEEPS the trust group's one sanctioned stack ("no tokens, no
      wallets, no distributed ledger" sentence) - it answers a real
      crypto-theater question.
    - Seams 2, ghosts 2, air 1: compliant; intensifier sweep only.

23. security/threat-model.html
    - THREE ghosts: drop to two (chamber + principal threat-class table).
    - Audit that severity colors appear only in tables and sev bars.
    - Seams 2, dense alternation: compliant.

24. regulatory-clock.html
    - Confirm mapping language only (kolm MAPS to standards, never
      certifies) across the timeline nodes.
    - Spark 1: confirm it sits beside a non-locked counted stat.
    - Spine + seam cadence: compliant.

25. sla.html
    - Four sect--dense in a run: re-cut the middle pair so densities
      alternate (contractual plainness is not a single drum).
    - Legal group: zero art devices - confirm none crept in.

26. docs.html
    - Reading room compliant (seams 2, zero ghosts, code wells, standard
      coda): no structural change; intensifier sweep only.

27. research.html
    - H1 tail "So we publish ours." is positioning, not meta-commentary:
      keep. Body intensifier sweep.
    - Ledger-index, ghosts 02+04, spark 1: compliant.

28. glossary.html
    - "actually uses" twice -> "uses".
    - Zero ghosts correct for the reading room; seams 2 compliant.

29. changelog.html
    - Chamber directly before coda: v3.3 junction rule handles it; no
      markup change.
    - Short form, seam 1: compliant. Keep the dated ledger voice.

30. careers.html
    - AIR thesis directly after the hero is the sanctioned company
      opening: keep.
    - "actually did / actually done" -> "did / done".
    - Single chamber + seam: compliant.

31. contact.html
    - Step 03 triple negation: rewrite positive; KEEP "The
      four-to-eight-week review compresses to days."
    - Short utility form (HERO -> INK) sanctioned: no structural change.
    - dev@kolm.ai is the only address on the page: confirm.

32. account-billing.html
    - App chrome parity only; no devices, no added copy. Matches
      dashboard chrome.

33. privacy.html
    - Typeset-only compliant (one column, standard coda, zero devices):
      no change beyond an intensifier sweep.

34. terms.html
    - "Questions about these terms?" close is genuine: keep; confirm the
      mailto is dev@kolm.ai.
    - Zero devices: correct.

35. dpa.html
    - The single ink summary panel after the hero is the allowed legal
      exception; confirm no second ink and zero other devices.

36. baa.html
    - MISSING the standard coda: add a quiet cta-final close matching
      dpa's (no field band, no badges on legal); the final ink section
      keeps its content.
    - Zero other devices: confirm.

37. subprocessors.html
    - Hairline table + dense rhythm compliant; "Questions about a
      sub-processor?" close is genuine: keep. Zero devices: confirm.

38. acceptable-use.html
    - Two adjacent sect--dense (mid-page): re-cut one to default density.
    - Single mid ink allowed; zero seams/ghosts correct for legal.

39. 404.html
    - Pricing card "Every price is public and the scan is free. No demo
      wall." -> "Flat fees, from a free scan to the $25,000 Reviewed
      Attestation." (locked values verbatim; the pricing hero owns the
      public-prices line).
    - Art-piece hero at full intensity: keep; chamber-to-coda junction
      now handled by the v3.3 rule.

---

## 8. SELF-CHECK (run after every page touched)

- node scripts/verify-editorial.cjs : dashes=0, exactly one .eyebrow.
- node scripts/render-review.mjs /<page> : no stuck reveals, no errors.
- x04 locked-string counts unchanged; scope line verbatim; prices verbatim;
  forbidden substrings absent; dev@kolm.ai only.
- Seam count per this score; field mounts <= 3; dither <= 2; ghosts <= 2.
- JSON-LD FAQ/HowTo text equals visible text wherever either changed.
