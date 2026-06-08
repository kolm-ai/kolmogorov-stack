import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------------
 * HeroLoop - a dependency-free, ~15-second CSS/SVG loop that tells the kolm
 * story in three scenes:
 *
 *   01  The deal stalls in security review   (a deal token rolls into a REVIEW
 *       gate that blocks it)
 *   02  Your buyer verifies the signed report offline   (an Ed25519 wax seal
 *       flips to a green VERIFIED state, no server in the path)
 *   03  The deal closes   (the gate opens, the deal advances to WON)
 *
 * Pure inline SVG + CSS @keyframes - no <video>, no animation library, no JS.
 * Everything is driven off a single 15s master timeline so the scenes stay
 * phase-locked. All motion is gated behind `prefers-reduced-motion:
 * no-preference`; the static base state is the resolved payoff frame (deal at
 * WON, seal VERIFIED, gate open) plus a static three-beat caption list, so the
 * story still reads with motion turned off. Signal green (--accent) is the one
 * hue that ever means VERIFIED; the blocked gate uses the desaturated --void,
 * never an alarm red.
 * ------------------------------------------------------------------------- */

const STYLE = `
.hl { --hl-ease: cubic-bezier(0.65, 0, 0.35, 1); }
.hl svg { display: block; width: 100%; height: auto; }

/* ---- resolved (static / reduced-motion) base states ---- */
.hl-deal   { transform: translateX(544px); }
.hl-gate   { transform: scaleY(0); transform-box: view-box; transform-origin: 320px 140px; }
.hl-review { opacity: 0; transform-box: fill-box; transform-origin: center; }
.hl-report { opacity: 1; }
.hl-seal   { fill: var(--accent); transform-box: fill-box; transform-origin: center; }
.hl-check  { stroke-dasharray: 26; stroke-dashoffset: 0; }
.hl-closed { opacity: 1; transform-box: fill-box; transform-origin: center; }
.hl-seg-fill { transform: scaleX(1); transform-origin: left center; }

/* captions: static list by default, animated stack when motion is allowed */
.hl-cap-static { display: grid; }
.hl-cap-anim   { display: none; }

@media (prefers-reduced-motion: no-preference) {
  .hl-cap-static { display: none; }
  .hl-cap-anim   { display: grid; }
  .hl-cap-anim .hl-cap { grid-area: 1 / 1; opacity: 0; }

  .hl-deal   { animation: hl-deal 15s var(--hl-ease) infinite; }
  .hl-gate   { animation: hl-gate 15s var(--hl-ease) infinite; }
  .hl-review { animation: hl-review 15s var(--hl-ease) infinite; }
  .hl-report { animation: hl-report 15s var(--hl-ease) infinite; }
  .hl-seal   { animation: hl-seal 15s var(--hl-ease) infinite, hl-flip 15s var(--hl-ease) infinite; }
  .hl-check  { animation: hl-check 15s var(--hl-ease) infinite; }
  .hl-closed { animation: hl-closed 15s var(--hl-ease) infinite; }
  .hl-cap--a { animation: hl-capA 15s var(--hl-ease) infinite; }
  .hl-cap--b { animation: hl-capB 15s var(--hl-ease) infinite; }
  .hl-cap--c { animation: hl-capC 15s var(--hl-ease) infinite; }
  .hl-seg-fill--a { animation: hl-segA 15s var(--hl-ease) infinite; }
  .hl-seg-fill--b { animation: hl-segB 15s var(--hl-ease) infinite; }
  .hl-seg-fill--c { animation: hl-segC 15s var(--hl-ease) infinite; }
}

@keyframes hl-deal {
  0%   { transform: translateX(96px);  opacity: 0; }
  3%   { transform: translateX(96px);  opacity: 1; }
  20%  { transform: translateX(250px); opacity: 1; }
  24%  { transform: translateX(242px); opacity: 1; }
  28%  { transform: translateX(250px); opacity: 1; }
  66%  { transform: translateX(250px); opacity: 1; }
  72%  { transform: translateX(250px); opacity: 1; }
  90%  { transform: translateX(544px); opacity: 1; }
  96%  { transform: translateX(544px); opacity: 1; }
  98%  { transform: translateX(544px); opacity: 0; }
  100% { transform: translateX(96px);  opacity: 0; }
}
@keyframes hl-gate {
  0%, 66%   { transform: scaleY(1); }
  72%, 96%  { transform: scaleY(0); }
  98%, 100% { transform: scaleY(1); }
}
@keyframes hl-review {
  0%   { opacity: 0; transform: translateY(2px) scale(0.96); }
  6%   { opacity: 1; transform: translateY(0) scale(1); }
  14%  { opacity: 0.5; transform: scale(0.97); }
  22%  { opacity: 1; transform: scale(1.03); }
  30%  { opacity: 0.7; transform: scale(1); }
  60%  { opacity: 0.7; }
  66%  { opacity: 0; transform: scale(0.96); }
  100% { opacity: 0; }
}
@keyframes hl-report {
  0%, 34%  { opacity: 0; transform: translateY(8px); }
  38%, 64% { opacity: 1; transform: translateY(0); }
  68%      { opacity: 0; transform: translateY(-6px); }
  100%     { opacity: 0; transform: translateY(-6px); }
}
@keyframes hl-seal {
  0%, 48%   { fill: var(--ink-3); }
  53%, 100% { fill: var(--accent); }
}
@keyframes hl-flip {
  0%, 46%   { transform: scaleX(1); }
  50%       { transform: scaleX(0.08); }
  54%, 100% { transform: scaleX(1); }
}
@keyframes hl-check {
  0%, 50%   { stroke-dashoffset: 26; opacity: 0; }
  54%       { opacity: 1; }
  60%, 100% { stroke-dashoffset: 0; opacity: 1; }
}
@keyframes hl-closed {
  0%, 84%   { opacity: 0; transform: scale(0.8); }
  89%       { opacity: 1; transform: scale(1.06); }
  93%       { transform: scale(1); }
  96%       { opacity: 1; transform: scale(1); }
  98%, 100% { opacity: 0; transform: scale(1); }
}
@keyframes hl-capA { 0% { opacity: 0; } 3% { opacity: 1; } 30% { opacity: 1; } 34% { opacity: 0; } 100% { opacity: 0; } }
@keyframes hl-capB { 0%, 34% { opacity: 0; } 38% { opacity: 1; } 64% { opacity: 1; } 68% { opacity: 0; } 100% { opacity: 0; } }
@keyframes hl-capC { 0%, 68% { opacity: 0; } 72% { opacity: 1; } 96% { opacity: 1; } 99% { opacity: 0; } 100% { opacity: 0; } }
@keyframes hl-segA { 0%, 4% { transform: scaleX(0); } 30% { transform: scaleX(1); } 100% { transform: scaleX(1); } }
@keyframes hl-segB { 0%, 36% { transform: scaleX(0); } 64% { transform: scaleX(1); } 100% { transform: scaleX(1); } }
@keyframes hl-segC { 0%, 70% { transform: scaleX(0); } 96% { transform: scaleX(1); } 100% { transform: scaleX(1); } }
`;

const SCENES = [
  { n: "01", t: "The deal stalls in security review." },
  { n: "02", t: "Your buyer verifies the signed report offline. No server." },
  { n: "03", t: "The deal closes." },
];

export function HeroLoop({ className }: { className?: string }) {
  return (
    <figure
      role="img"
      aria-label="Animated loop: a deal stalls in a security-review gate, the buyer verifies the signed Ed25519 report offline with no server, and the deal advances to closed-won."
      className={cn(
        "hl rounded-lg border border-line bg-paper-2 p-4 shadow-[0_18px_50px_-34px_rgba(14,19,16,0.32)] sm:p-5",
        className
      )}
    >
      <style dangerouslySetInnerHTML={{ __html: STYLE }} />

      {/* header strip: register label + 3-segment scene progress */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-ink-3">
          The review, compressed
        </span>
        <div aria-hidden="true" className="flex items-center gap-1.5">
          {["a", "b", "c"].map((s) => (
            <span
              key={s}
              className="inline-block h-[3px] w-7 overflow-hidden rounded-full bg-line"
            >
              <span
                className={`hl-seg-fill hl-seg-fill--${s} block h-full w-full rounded-full bg-[var(--accent)]`}
              />
            </span>
          ))}
        </div>
      </div>

      {/* the stage */}
      <div className="rounded-md bg-[var(--paper-sink)] px-2 py-3 sm:px-4">
        <svg viewBox="0 0 640 300" aria-hidden="true">
          {/* persistent pipeline rail + stations */}
          <line
            x1={48}
            y1={176}
            x2={592}
            y2={176}
            stroke="var(--line-2)"
            strokeWidth={1.5}
            strokeDasharray="2 6"
            strokeLinecap="round"
            opacity={0.7}
          />
          <circle cx={96} cy={176} r={4} fill="var(--ink-faint)" />
          <circle cx={544} cy={176} r={4} fill="var(--accent)" />
          <text
            x={96}
            y={205}
            textAnchor="middle"
            fontFamily="var(--font-mono)"
            fontSize={9}
            letterSpacing="0.14em"
            fill="var(--ink-3)"
          >
            PROSPECT
          </text>
          <text
            x={544}
            y={205}
            textAnchor="middle"
            fontFamily="var(--font-mono)"
            fontSize={9}
            letterSpacing="0.14em"
            fill="var(--ink-3)"
          >
            CLOSED
          </text>

          {/* the review gateway */}
          <g>
            <rect x={296} y={112} width={48} height={8} rx={2} fill="var(--ink-faint)" />
            <rect x={296} y={120} width={6} height={112} rx={2} fill="var(--ink-faint)" />
            <rect x={338} y={120} width={6} height={112} rx={2} fill="var(--ink-faint)" />
          </g>
          <g className="hl-gate">
            <rect x={304} y={140} width={32} height={72} rx={3} fill="var(--void)" />
            <rect x={304} y={156} width={32} height={3} fill="var(--paper-2)" opacity={0.5} />
            <rect x={304} y={182} width={32} height={3} fill="var(--paper-2)" opacity={0.5} />
          </g>

          {/* the deal token (single continuous traveller, riding the rail at
              y=176; only translateX is animated so its children carry the y) */}
          <g className="hl-deal">
            <rect x={-44} y={154} width={92} height={52} rx={9} fill="rgba(14,19,16,0.06)" />
            <rect
              x={-46}
              y={150}
              width={92}
              height={52}
              rx={9}
              fill="var(--paper-2)"
              stroke="var(--line-2)"
              strokeWidth={1.25}
            />
            <text
              x={0}
              y={169}
              textAnchor="middle"
              fontFamily="var(--font-mono)"
              fontSize={8.5}
              letterSpacing="0.12em"
              fill="var(--ink-3)"
            >
              DEAL · ACME
            </text>
            <text
              x={0}
              y={189}
              textAnchor="middle"
              fontFamily="var(--font-sans)"
              fontSize={14}
              fontWeight={700}
              fill="var(--ink)"
            >
              $1.2M ARR
            </text>
          </g>

          {/* scene 01 overlay: the REVIEW block */}
          <g className="hl-review">
            <rect
              x={284}
              y={73}
              width={72}
              height={26}
              rx={13}
              fill="var(--void-soft)"
              stroke="var(--void-edge)"
              strokeWidth={1}
            />
            <circle cx={300} cy={86} r={3} fill="var(--void)" />
            <text
              x={311}
              y={90}
              fontFamily="var(--font-mono)"
              fontSize={11}
              fontWeight={600}
              letterSpacing="0.08em"
              fill="var(--void)"
            >
              REVIEW
            </text>
          </g>

          {/* scene 02 overlay: the signed report verifying offline */}
          <g className="hl-report">
            <rect
              x={250}
              y={38}
              width={140}
              height={106}
              rx={9}
              fill="var(--paper-2)"
              stroke="var(--line-2)"
              strokeWidth={1.25}
            />
            <text
              x={266}
              y={56}
              fontFamily="var(--font-mono)"
              fontSize={8}
              letterSpacing="0.12em"
              fill="var(--ink-3)"
            >
              EVIDENCE REPORT
            </text>
            <rect x={266} y={64} width={92} height={4} rx={2} fill="var(--line-2)" opacity={0.7} />
            <rect x={266} y={74} width={108} height={4} rx={2} fill="var(--line-2)" opacity={0.55} />
            <rect x={266} y={84} width={70} height={4} rx={2} fill="var(--line-2)" opacity={0.7} />
            <text
              x={266}
              y={120}
              fontFamily="var(--font-mono)"
              fontSize={9}
              letterSpacing="0.04em"
              fill="var(--accent-text)"
            >
              Ed25519
            </text>
            <text
              x={266}
              y={132}
              fontFamily="var(--font-mono)"
              fontSize={7.5}
              letterSpacing="0.06em"
              fill="var(--ink-3)"
            >
              offline · no server
            </text>
            <g transform="translate(362,116)">
              <circle className="hl-seal" cx={0} cy={0} r={17} />
              <path
                className="hl-check"
                d="M-8 1 l5 6 l11 -13"
                fill="none"
                stroke="var(--on-accent)"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
            <text
              x={362}
              y={142}
              textAnchor="middle"
              fontFamily="var(--font-mono)"
              fontSize={7.5}
              fontWeight={600}
              letterSpacing="0.1em"
              fill="var(--accent-text)"
            >
              VERIFIED
            </text>
          </g>

          {/* scene 03 overlay: the deal closes (WON) */}
          <g transform="translate(544,138)">
            <g className="hl-closed">
              <rect
                x={-44}
                y={-15}
                width={88}
                height={30}
                rx={15}
                fill="var(--accent-soft)"
                stroke="var(--accent-edge)"
                strokeWidth={1.25}
              />
              <circle cx={-26} cy={0} r={8} fill="var(--accent)" />
              <path
                d="M-30 0 l3 3 l6 -7"
                fill="none"
                stroke="var(--on-accent)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <text
                x={6}
                y={4}
                textAnchor="middle"
                fontFamily="var(--font-mono)"
                fontSize={11.5}
                fontWeight={700}
                letterSpacing="0.08em"
                fill="var(--accent-text)"
              >
                WON
              </text>
            </g>
          </g>
        </svg>
      </div>

      {/* captions: cross-fading line (motion) or a static three-beat list */}
      <figcaption className="mt-3 min-h-[42px] text-[14px] leading-snug">
        <div className="hl-cap-anim">
          {SCENES.map((s) => (
            <p key={s.n} className={`hl-cap hl-cap--${s.n === "01" ? "a" : s.n === "02" ? "b" : "c"} text-ink-2`}>
              <span className="mr-2 font-mono text-[12px] font-medium tracking-[0.06em] text-accent-text">
                {s.n}
              </span>
              {s.t}
            </p>
          ))}
        </div>
        <ol className="hl-cap-static gap-1.5">
          {SCENES.map((s) => (
            <li key={s.n} className="flex gap-2 text-ink-2">
              <span className="font-mono text-[12px] font-medium tracking-[0.06em] text-accent-text">
                {s.n}
              </span>
              <span>{s.t}</span>
            </li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}
