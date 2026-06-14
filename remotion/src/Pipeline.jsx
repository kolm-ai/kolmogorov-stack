import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  interpolate,
  spring,
  useVideoConfig,
  delayRender,
  continueRender,
} from 'remotion';
import {loadFonts, SANS, MONO} from './fonts.js';

export const FPS = 30;
export const WIDTH = 1600;
export const HEIGHT = 900;
export const PIPELINE_DURATION = 240; // 8.0s seamless loop

const ACCENT = '#3FE5A0';
const BG = '#08090A';
const INK = '#E7ECEA';
const INK_DIM = '#6B746F';
const INK_FAINT = '#3A413D';
const HAIR = 'rgba(231,236,234,0.10)';
const ACCENT_GLOW = 'rgba(63,229,160,0.55)';

// Five stations along the rail. x is the center fraction of the rail span.
const STATIONS = [
  {id: 'API', label: 'LIVE API', sub: 'openai / anthropic'},
  {id: 'CAPTURE', label: 'CAPTURE', sub: 'drop-in proxy / secrets stripped'},
  {id: 'COMPILE', label: 'COMPILE', sub: 'one signed .kolm / 142 MB'},
  {id: 'RUN', label: 'RUN', sub: 'laptop / edge / server / phone'},
  {id: 'VERIFY', label: 'VERIFY', sub: 'ed25519 signature'},
];

// ---- helpers ---------------------------------------------------------------

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// loop-safe value: returns 0..1 progress that returns to start by end.
const useFonts = () => {
  const [handle] = React.useState(() => delayRender('fonts'));
  React.useEffect(() => {
    loadFonts();
    // fonts are font-display:block + bundled; give the browser a tick.
    const t = setTimeout(() => continueRender(handle), 120);
    return () => clearTimeout(t);
  }, [handle]);
};

// ---- atmosphere ------------------------------------------------------------

const Atmosphere = () => {
  const frame = useCurrentFrame();
  // very slow top-light breathing for a "lit room" feel
  const breathe = 0.5 + 0.5 * Math.sin((frame / PIPELINE_DURATION) * Math.PI * 2);
  return (
    <AbsoluteFill>
      {/* base */}
      <AbsoluteFill style={{backgroundColor: BG}} />
      {/* top light */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 90% at 50% -25%, rgba(63,229,160,${0.05 + 0.025 * breathe}) 0%, rgba(8,9,10,0) 55%)`,
        }}
      />
      {/* floor vignette */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(120% 120% at 50% 120%, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 50%)',
        }}
      />
      {/* engraved grid */}
      <AbsoluteFill style={{opacity: 0.5}}>
        <svg width={WIDTH} height={HEIGHT}>
          <defs>
            <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
              <path d="M48 0H0V48" fill="none" stroke="rgba(231,236,234,0.022)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width={WIDTH} height={HEIGHT} fill="url(#grid)" />
        </svg>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ---- glyphs for the RUN devices -------------------------------------------

const DeviceGlyph = ({type, lit}) => {
  const stroke = lit ? ACCENT : INK_FAINT;
  const sw = 1.6;
  const common = {fill: 'none', stroke, strokeWidth: sw, strokeLinejoin: 'round', strokeLinecap: 'round'};
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" style={{display: 'block'}}>
      {type === 'laptop' && (
        <>
          <rect x="6" y="7" width="22" height="14" rx="1.5" {...common} />
          <path d="M3 25 H31" {...common} />
          <path d="M13 21 H21" {...common} />
        </>
      )}
      {type === 'edge' && (
        <>
          {/* compact edge box with antenna + status leds */}
          <rect x="7" y="14" width="20" height="12" rx="1.6" {...common} />
          <path d="M17 14 V7 M14 8 L17 5 L20 8" {...common} />
          <circle cx="11.5" cy="20" r="1.1" fill={stroke} stroke="none" />
          <circle cx="15" cy="20" r="1.1" fill={stroke} stroke="none" />
        </>
      )}
      {type === 'server' && (
        <>
          <rect x="7" y="6" width="20" height="8" rx="1.2" {...common} />
          <rect x="7" y="18" width="20" height="8" rx="1.2" {...common} />
          <circle cx="11" cy="10" r="1.1" fill={stroke} stroke="none" />
          <circle cx="11" cy="22" r="1.1" fill={stroke} stroke="none" />
        </>
      )}
      {type === 'phone' && (
        <>
          <rect x="11" y="5" width="12" height="24" rx="2.4" {...common} />
          <path d="M15 26 H19" {...common} />
        </>
      )}
    </svg>
  );
};

// ---- the .kolm artifact chip ----------------------------------------------

const KolmChip = ({progress, sealed}) => {
  // progress 0..1 = formation; sealed adds the accent edge
  const scale = interpolate(progress, [0, 1], [0.6, 1], {extrapolateRight: 'clamp'});
  const op = interpolate(progress, [0, 0.4, 1], [0, 1, 1], {extrapolateRight: 'clamp'});
  const edge = sealed ? ACCENT : INK_DIM;
  return (
    <div style={{transform: `scale(${scale})`, opacity: op}}>
      <svg width="84" height="84" viewBox="0 0 84 84">
        {/* outer engraved chip */}
        <rect x="10" y="10" width="64" height="64" rx="8" fill="rgba(63,229,160,0.04)" stroke={edge} strokeWidth="1.4" />
        {/* corner pins */}
        {[18, 66].map((cx) =>
          [18, 66].map((cy) => (
            <rect key={`${cx}-${cy}`} x={cx - 2} y={cy - 2} width="4" height="4" rx="1" fill={INK_FAINT} />
          ))
        )}
        {/* internal traces */}
        <path d="M28 30 H56 M28 42 H50 M28 54 H56" stroke={sealed ? ACCENT : INK_DIM} strokeWidth="1.3" strokeLinecap="round" opacity={interpolate(progress, [0.3, 1], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})} />
      </svg>
    </div>
  );
};

// ---- a station node --------------------------------------------------------

const StationNode = ({station, x, y, active, settle}) => {
  // active 0..1 = light intensity as the pulse hits it; settle = persistent dim-lit after pass
  const lit = Math.max(active, settle * 0.42);
  const ringColor = `rgba(63,229,160,${0.18 + 0.55 * lit})`;
  const dotGlow = 6 + 22 * active;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: 'translate(-50%,-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: 220,
      }}
    >
      {/* node ring */}
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 12,
          border: `1.5px solid ${ringColor}`,
          background: `rgba(63,229,160,${0.03 + 0.10 * lit})`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: active > 0.02 ? `0 0 ${dotGlow}px ${ACCENT_GLOW}` : 'none',
        }}
      >
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: 3,
            background: lit > 0.05 ? ACCENT : INK_FAINT,
            boxShadow: active > 0.05 ? `0 0 ${8 + 14 * active}px ${ACCENT}` : 'none',
          }}
        />
      </div>
      {/* label */}
      <div
        style={{
          marginTop: 16,
          fontFamily: MONO,
          fontSize: 13,
          letterSpacing: 2.5,
          color: lit > 0.1 ? INK : INK_DIM,
          fontWeight: 600,
        }}
      >
        {station.label}
      </div>
      <div
        style={{
          marginTop: 6,
          fontFamily: MONO,
          fontSize: 10,
          letterSpacing: 0.3,
          color: lit > 0.2 ? INK_DIM : INK_FAINT,
          textAlign: 'center',
          lineHeight: 1.4,
          maxWidth: 200,
        }}
      >
        {station.sub}
      </div>
    </div>
  );
};

// ---- main ------------------------------------------------------------------

export const Pipeline = () => {
  useFonts();
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();

  // rail geometry
  const railY = HEIGHT * 0.42;
  const railLeft = WIDTH * 0.10;
  const railRight = WIDTH * 0.90;
  const railSpan = railRight - railLeft;
  const stationX = STATIONS.map((_, i) => railLeft + (railSpan * i) / (STATIONS.length - 1));

  // ---- timeline (seamless loop) ----
  // The pulse sweeps left->right over the "active" window, then a hold on VERIFY,
  // then a short fade that returns the scene to the start state for a clean loop.
  const sweepStart = 18;
  const sweepEnd = 168; // pulse reaches VERIFY
  const holdEnd = 210; // verified hold
  // loop reset fade 210..240 dims settle back so frame 0 == frame 240

  const sweep = interpolate(frame, [sweepStart, sweepEnd], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const pulsePos = easeInOut(sweep); // 0..1 along rail

  // loop reset: fade global settle near the end so it matches frame 0
  const outroFade = interpolate(frame, [holdEnd, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // intro fade mirrors the outro so frame 0 == frame (durationInFrames) == quiet dark rail.
  const introFade = interpolate(frame, [0, sweepStart], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // single global envelope applied to every lit element for a seamless cut.
  const resetFade = Math.min(introFade, outroFade);

  // per-station activation: a gaussian bump as the pulse passes its position
  const activations = STATIONS.map((_, i) => {
    const sx = i / (STATIONS.length - 1);
    const d = Math.abs(pulsePos - sx);
    const bump = Math.exp(-(d * d) / (2 * 0.030)); // sharp light as pulse passes
    // settle: once the pulse has passed, keep it dim-lit (and obey resetFade for the loop)
    const passed = pulsePos > sx - 0.02 ? 1 : 0;
    const settle = passed * resetFade;
    return {active: bump * resetFade, settle};
  });

  // pulse pixel position
  const pulseX = railLeft + railSpan * pulsePos;

  // COMPILE chip formation tied to station index 2 passing
  const compileProg = interpolate(pulsePos, [0.42, 0.55], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  }) * resetFade;

  // RUN devices light when pulse passes index 3 (0.75)
  const runLit = interpolate(pulsePos, [0.70, 0.80], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // VERIFY seal pops at the end
  const verifyProg = spring({
    frame: frame - sweepEnd,
    fps: FPS,
    config: {damping: 14, stiffness: 120, mass: 0.7},
    durationInFrames: 30,
  }) * resetFade;

  // bottom status line
  const verified = pulsePos > 0.985 ? 'VERIFIED' : 'PROCESSING';

  return (
    <AbsoluteFill style={{backgroundColor: BG, fontFamily: SANS}}>
      <Atmosphere />

      {/* running head */}
      <div
        style={{
          position: 'absolute',
          top: 54,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: MONO,
          fontSize: 12,
          letterSpacing: 6,
          color: INK_DIM,
        }}
      >
        kolm &nbsp;/&nbsp; CAPTURE &middot; COMPILE &middot; RUN &middot; VERIFY
      </div>

      {/* the rail */}
      <svg
        width={WIDTH}
        height={HEIGHT}
        style={{position: 'absolute', inset: 0}}
      >
        {/* base rail */}
        <line x1={railLeft} y1={railY} x2={railRight} y2={railY} stroke={HAIR} strokeWidth="2" />
        {/* lit portion up to pulse */}
        <line
          x1={railLeft}
          y1={railY}
          x2={pulseX}
          y2={railY}
          stroke={ACCENT}
          strokeWidth="2"
          strokeOpacity={0.85 * resetFade}
          style={{filter: 'drop-shadow(0 0 6px rgba(63,229,160,0.6))'}}
        />
        {/* tick marks under each station */}
        {stationX.map((sx, i) => (
          <line key={i} x1={sx} y1={railY - 7} x2={sx} y2={railY + 7} stroke={INK_FAINT} strokeWidth="1.4" />
        ))}
        {/* traveling pulse head */}
        {resetFade > 0.02 && pulsePos < 0.999 && (
          <>
            <circle cx={pulseX} cy={railY} r="6" fill={ACCENT} opacity={resetFade} style={{filter: 'drop-shadow(0 0 12px rgba(63,229,160,0.9))'}} />
            <circle cx={pulseX} cy={railY} r="14" fill="none" stroke={ACCENT} strokeWidth="1.2" opacity={0.35 * resetFade} />
          </>
        )}
      </svg>

      {/* stations */}
      {STATIONS.map((st, i) => (
        <StationNode
          key={st.id}
          station={st}
          x={stationX[i]}
          y={railY}
          active={activations[i].active}
          settle={activations[i].settle}
        />
      ))}

      {/* COMPILE artifact (the .kolm chip) below COMPILE node */}
      <div
        style={{
          position: 'absolute',
          left: stationX[2],
          top: railY + 170,
          transform: 'translate(-50%,-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <KolmChip progress={compileProg} sealed={verifyProg > 0.4} />
        <div
          style={{
            marginTop: 8,
            fontFamily: MONO,
            fontSize: 11,
            letterSpacing: 1.5,
            color: compileProg > 0.3 ? INK : INK_FAINT,
            opacity: compileProg,
          }}
        >
          claims-redactor.kolm
        </div>
      </div>

      {/* RUN devices below RUN node */}
      <div
        style={{
          position: 'absolute',
          left: stationX[3],
          top: railY + 162,
          transform: 'translate(-50%,-50%)',
          display: 'flex',
          gap: 22,
          alignItems: 'center',
        }}
      >
        {['laptop', 'edge', 'server', 'phone'].map((t, i) => {
          const stagger = interpolate(runLit, [i * 0.12, i * 0.12 + 0.3], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }) * resetFade;
          return (
            <div key={t} style={{opacity: 0.35 + 0.65 * stagger, transform: `translateY(${(1 - stagger) * 6}px)`}}>
              <DeviceGlyph type={t} lit={stagger > 0.5} />
            </div>
          );
        })}
      </div>

      {/* VERIFY seal below VERIFY node */}
      <div
        style={{
          position: 'absolute',
          left: stationX[4],
          top: railY + 170,
          transform: `translate(-50%,-50%) scale(${0.7 + 0.3 * verifyProg})`,
          opacity: verifyProg,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <svg width="64" height="64" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="26" fill="rgba(63,229,160,0.06)" stroke={ACCENT} strokeWidth="1.6" />
          <path
            d="M21 33 L29 41 L44 24"
            fill="none"
            stroke={ACCENT}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="40"
            strokeDashoffset={interpolate(verifyProg, [0, 1], [40, 0])}
            style={{filter: 'drop-shadow(0 0 6px rgba(63,229,160,0.7))'}}
          />
        </svg>
        <div style={{marginTop: 8, fontFamily: MONO, fontSize: 11, letterSpacing: 1.5, color: ACCENT}}>
          signature valid
        </div>
      </div>

      {/* bottom status bar */}
      <div
        style={{
          position: 'absolute',
          bottom: 56,
          left: WIDTH * 0.10,
          right: WIDTH * 0.10,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontFamily: MONO,
          fontSize: 12,
          letterSpacing: 1.2,
          color: INK_DIM,
          borderTop: `1px solid ${HAIR}`,
          paddingTop: 16,
        }}
      >
        <span>one model &middot; runs anywhere</span>
        <span style={{display: 'flex', alignItems: 'center', gap: 10}}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 2,
              background: verified === 'VERIFIED' ? ACCENT : INK_DIM,
              boxShadow: verified === 'VERIFIED' ? `0 0 8px ${ACCENT}` : 'none',
            }}
          />
          <span style={{color: verified === 'VERIFIED' ? ACCENT : INK_DIM}}>{verified}</span>
        </span>
      </div>
    </AbsoluteFill>
  );
};
