// W773 - Video frame-sampling SPEC builder.
//
// Pure JS. Builds a PORTABLE JSON sampling SPEC consumed downstream by the
// Python trainer (apps/trainer/video_distill.py) which is where the actual
// frame extraction lives (ffmpeg + cv2). The split keeps the heavy media
// deps out of Node - Node only emits the contract; Python honors it.
//
// Atomic guarantees pinned by tests/wave773-video-distill.test.js:
//
//  - FRAME_SAMPLER_VERSION = 'w773-v1'
//  - SAMPLING_STRATEGIES is Object.freeze()-d, exactly 4 entries
//    ('uniform', 'keyframe', 'scene_change', 'adaptive').
//  - buildSamplingSpec is pure (no I/O, no Date.now() in spec body other
//    than the optional `built_at`).
//  - buildSamplingSpec returns an honest envelope when:
//      * duration_s is <= 0 or non-finite
//      * strategy is not in SAMPLING_STRATEGIES
//      * fps_target is <= 0 or non-finite (when present)
//      * max_frames is <= 0 (when present)
//  - estimateExtractedFrames is a pure cheap counter the trainer dry-run
//    consults so total_frames_estimated never lies about effort.
//
// HONESTY INVARIANTS:
//  - buildSamplingSpec MUST NOT return {ok:true, sampling_indices:[]} on
//    valid input - that would silently report "no frames" while claiming
//    success. The empty-on-success case only arises from bad input and is
//    surfaced as {ok:false, error:'<kind>'}.
//  - estimateExtractedFrames is the SAME math the trainer dry-run uses;
//    if you change one, change the other.
//
// Why 'keyframe' + 'scene_change' are separate strategies:
//   keyframe - extract I-frames per the container's GOP metadata.
//                    Cheap, deterministic, but density varies wildly by
//                    encoder (some screen recorders emit one I-frame per
//                    minute; some hand-cam emits one per second).
//   scene_change - run a pixel-diff threshold across decoded frames
//                    looking for cut points. More accurate for tutorials
//                    and presentations, more expensive than keyframe.
//   uniform - fps_target evenly across the duration. Deterministic
//                    + cheap + good for surveillance / continuous footage.
//   adaptive - start uniform, densify around high-motion regions
//                    using a motion histogram. Most accurate, slowest.

export const FRAME_SAMPLER_VERSION = 'w773-v1';

// Closed enum of strategies. Frozen so a future agent cannot push a 5th
// strategy and silently bypass shape validation downstream.
export const SAMPLING_STRATEGIES = Object.freeze([
  'uniform',
  'keyframe',
  'scene_change',
  'adaptive',
]);

// Sensible defaults. Targeted at tutorials / screencasts / presentations:
// 1 fps captures the slide cadence without exploding storage. 64 frames
// caps a 64-second clip at the cheapest setting; longer clips compress
// to roughly one frame per second of denser content.
const DEFAULT_FPS_TARGET = 1.0;
const DEFAULT_MAX_FRAMES = 64;

// Hard ceiling so a 24-hour surveillance clip + fps_target=30 cannot
// emit 2.5M sampling indices. 1024 covers a 17-minute clip at 1fps with
// room to spare; trainers that genuinely need more should chunk.
const HARD_FRAME_CAP = 1024;
const MAX_DURATION_S = 24 * 60 * 60;
const MAX_FPS_TARGET = 120;

function _normalizeFrameCap(max_frames) {
  const cap = Number(max_frames);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  return Math.max(1, Math.min(HARD_FRAME_CAP, Math.trunc(cap)));
}

// =============================================================================
// estimateExtractedFrames - pure estimator. Trainer dry-run consults this so
// total_frames_estimated never lies about effort.
//
// Math:
//   raw = duration_s * fps_target   (or strategy-specific density)
//   capped = min(raw, max_frames, HARD_FRAME_CAP)
//
// NEVER returns 0 for a valid (>0 duration_s, >0 fps_target) input - the
// floor is 1. A clip exists, so at least one representative frame must
// be sampled.
// =============================================================================
export function estimateExtractedFrames(duration_s, strategy, fps_target, max_frames) {
  const dur = Number(duration_s);
  const fps = Number(fps_target);
  const cap = _normalizeFrameCap(max_frames);
  if (!Number.isFinite(dur) || dur <= 0) return 0;
  if (!Number.isFinite(fps) || fps <= 0 || fps > MAX_FPS_TARGET) return 0;

  // Per-strategy density multiplier. uniform = 1.0 baseline. keyframe is
  // sparser (encoders emit fewer I-frames than fps would suggest). scene
  // change is sparser still on natural footage. adaptive defaults to
  // uniform but densifies around motion peaks (we model it as 1.2x).
  let densityMult = 1.0;
  if (strategy === 'keyframe') densityMult = 0.35;
  else if (strategy === 'scene_change') densityMult = 0.20;
  else if (strategy === 'adaptive') densityMult = 1.2;

  let raw = Math.ceil(dur * fps * densityMult);
  if (raw < 1) raw = 1;
  let final = raw;
  if (cap != null && final > cap) final = cap;
  if (final > HARD_FRAME_CAP) final = HARD_FRAME_CAP;
  return final;
}

// =============================================================================
// buildSamplingSpec - emits a PORTABLE JSON spec the Python trainer reads.
// Pure function - no I/O. The spec rides into the trainer's --frame-sampler-spec
// arg as a path to a JSON file the JS caller wrote.
//
// Spec shape on success:
//   {
//     ok: true,
//     version: 'w773-v1',
//     strategy: <one of SAMPLING_STRATEGIES>,
//     fps_target: <number>,
//     max_frames: <number>,
//     duration_s: <number>,
//     expected_frame_count: <number>,
//     sampling_indices: [<number>, ...],   // seconds offsets, monotonic
//     hard_cap: HARD_FRAME_CAP,
//     density_mult: <number>,
//     built_at: <ISO-8601>,
//   }
//
// Spec shape on bad input:
//   {ok:false, error:'<kind>', hint:'<actionable text>', version}
// =============================================================================
export function buildSamplingSpec({
  video_duration_s,
  strategy = 'uniform',
  fps_target = DEFAULT_FPS_TARGET,
  max_frames = DEFAULT_MAX_FRAMES,
} = {}) {
  // Duration validation - zero / negative / NaN / Infinity all invalid.
  const dur = Number(video_duration_s);
  if (!Number.isFinite(dur) || dur <= 0 || dur > MAX_DURATION_S) {
    return {
      ok: false,
      error: 'bad_duration',
      hint: `video_duration_s must be a finite positive number <= ${MAX_DURATION_S}; got ${JSON.stringify(video_duration_s)}`,
      version: FRAME_SAMPLER_VERSION,
    };
  }

  // Strategy validation - closed enum.
  if (typeof strategy !== 'string' || !SAMPLING_STRATEGIES.includes(strategy)) {
    return {
      ok: false,
      error: 'bad_strategy',
      hint: `strategy must be one of ${JSON.stringify(SAMPLING_STRATEGIES)}; got ${JSON.stringify(strategy)}`,
      supported: SAMPLING_STRATEGIES,
      version: FRAME_SAMPLER_VERSION,
    };
  }

  // fps_target validation - must be positive finite.
  const fps = Number(fps_target);
  if (!Number.isFinite(fps) || fps <= 0 || fps > MAX_FPS_TARGET) {
    return {
      ok: false,
      error: 'bad_fps_target',
      hint: `fps_target must be a finite positive number <= ${MAX_FPS_TARGET}; got ${JSON.stringify(fps_target)}`,
      version: FRAME_SAMPLER_VERSION,
    };
  }

  // max_frames validation - when present, must be positive integer.
  const cap = _normalizeFrameCap(max_frames);
  if (cap == null) {
    return {
      ok: false,
      error: 'bad_max_frames',
      hint: `max_frames must be a finite positive integer; got ${JSON.stringify(max_frames)}`,
      version: FRAME_SAMPLER_VERSION,
    };
  }

  // Density per strategy. Mirror the estimateExtractedFrames table so the
  // estimator and the spec builder never drift. If they diverged, the
  // trainer dry-run would report a different total than the live run.
  let densityMult = 1.0;
  if (strategy === 'keyframe') densityMult = 0.35;
  else if (strategy === 'scene_change') densityMult = 0.20;
  else if (strategy === 'adaptive') densityMult = 1.2;

  const expected = estimateExtractedFrames(dur, strategy, fps, cap);

  // sampling_indices = the actual time-offset (seconds) list the trainer
  // will use to grab frames. For uniform we emit evenly-spaced offsets;
  // for adaptive we emit uniform offsets as a baseline and let the trainer
  // densify around motion peaks (the trainer SPEC carries the strategy
  // string so it knows to do the densification pass). For keyframe and
  // scene_change the offsets are HINTS - the trainer snaps to the nearest
  // actual keyframe / scene change before extraction.
  const sampling_indices = [];
  if (expected > 0) {
    if (expected === 1) {
      // Single frame - take the midpoint so a thumbnail is representative.
      sampling_indices.push(Number((dur / 2).toFixed(3)));
    } else {
      // Evenly spaced. Step = duration / (n - 1) hits both endpoints; we
      // shift inward by step/2 so a clip with leading/trailing slate
      // doesn't burn the budget on intro/outro cards.
      const step = dur / expected;
      for (let i = 0; i < expected; i++) {
        const t = step * (i + 0.5);
        sampling_indices.push(Number(t.toFixed(3)));
      }
    }
  }

  return {
    ok: true,
    version: FRAME_SAMPLER_VERSION,
    strategy,
    fps_target: fps,
    max_frames: cap,
    duration_s: dur,
    expected_frame_count: expected,
    sampling_indices,
    hard_cap: HARD_FRAME_CAP,
    density_mult: densityMult,
    built_at: new Date().toISOString(),
  };
}

export default {
  FRAME_SAMPLER_VERSION,
  SAMPLING_STRATEGIES,
  buildSamplingSpec,
  estimateExtractedFrames,
};
