// W746-4 - Teacher version tagging on every capture.
//
// Why this matters: teacher upgrades (Anthropic Opus 4.6 → 4.7, OpenAI gpt-4o
// → gpt-4o-2024-08, etc.) move the conditional distribution P(output | input)
// the student is trying to learn. A capture row that's silent about WHICH
// teacher answered is impossible to reweight when the teacher changes.
// Without this tag, a student trained on a mixed-vintage corpus inherits the
// average - and you discover the drift only when production accuracy drops.
//
// Design contract:
//   - Always returns a string. Never null. Falls back to `unknown_teacher_v0`
//     when nothing is known so the row is still queryable (vs `null` which
//     scatters across SQL-join semantics).
//   - Idempotent: tagging a row that's already tagged is a no-op (preserves
//     the existing teacher_version + teacher_provider - we trust the value
//     that was written closest to the actual teacher round-trip).
//   - Env-var driven so an op can pin a specific teacher version per-deploy
//     without code changes:
//        KOLM_TEACHER_VERSION_ANTHROPIC=claude-opus-4-7
//        KOLM_TEACHER_VERSION_OPENAI=gpt-4o-2024-11
//        KOLM_DISTILL_TEACHER (generic fallback, existing env from repo)
//
// Public surface:
//   - TEACHER_VERSION_TAG_VERSION
//   - currentTeacherVersion(provider)
//   - tagCaptureWithTeacherVersion(captureRow)
//   - groupByTeacherVersion(captures)

export const TEACHER_VERSION_TAG_VERSION = 'w746-v1';

// Documented per-provider defaults. When neither the provider-specific env nor
// the generic KOLM_DISTILL_TEACHER env is set, we fall back to the model the
// repo is currently shipping a tested integration for. Bumping the default
// here is a no-op for rows already tagged (idempotent guarantee above).
//
// Per repo MEMORY.md (W604+): Anthropic Opus 4.7 is the shipped distill teacher.
const PROVIDER_DEFAULTS = Object.freeze({
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-4o',
  // No default for other providers - they fall through to 'unknown_teacher_v0'
  // so we don't lie about a model we haven't validated against.
});

const FALLBACK = 'unknown_teacher_v0';

function _normProvider(p) {
  if (p == null) return '';
  return String(p).trim().toLowerCase();
}

// =============================================================================
// currentTeacherVersion(provider) - resolve the teacher version string.
//
// Resolution order:
//   1. Provider-specific env: KOLM_TEACHER_VERSION_<UPPER(provider)>
//   2. Generic env: KOLM_DISTILL_TEACHER (existing repo env)
//   3. Documented per-provider default (PROVIDER_DEFAULTS above)
//   4. FALLBACK ('unknown_teacher_v0')
//
// Returns a string. Never null. Never throws.
// =============================================================================
export function currentTeacherVersion(provider) {
  const p = _normProvider(provider);
  // 1. Provider-specific env. Underscores survive uppercasing; dashes get
  //    normalised to underscores so KOLM_TEACHER_VERSION_LOCAL-OLLAMA works
  //    even though dashes aren't valid in shell env-var names.
  if (p) {
    const envKey = 'KOLM_TEACHER_VERSION_' + p.toUpperCase().replace(/-/g, '_');
    const envVal = process.env[envKey];
    if (envVal && typeof envVal === 'string' && envVal.trim()) {
      return envVal.trim();
    }
  }
  // 2. Generic env (existing repo env from MEMORY.md trap).
  const generic = process.env.KOLM_DISTILL_TEACHER;
  if (generic && typeof generic === 'string' && generic.trim()) {
    return generic.trim();
  }
  // 3. Per-provider default.
  if (p && Object.prototype.hasOwnProperty.call(PROVIDER_DEFAULTS, p)) {
    return PROVIDER_DEFAULTS[p];
  }
  // 4. Honest fallback - we have no idea who answered, but still queryable.
  return FALLBACK;
}

// =============================================================================
// tagCaptureWithTeacherVersion(captureRow) - stamp the row with teacher info.
//
// MUTATES + RETURNS the row (callers can chain). If the row already carries
// a non-empty `teacher_version`, this is a no-op - we trust the closer-to-source
// value over the inferred one.
//
// Adds:
//   teacher_version - string (never null)
//   teacher_provider - normalised lowercase provider name (e.g. 'anthropic')
//
// Honest absence: when row.provider is empty/missing, teacher_provider is
// '' (empty string, not null) and teacher_version falls through to either
// the generic env or FALLBACK.
// =============================================================================
export function tagCaptureWithTeacherVersion(captureRow) {
  if (!captureRow || typeof captureRow !== 'object') return captureRow;
  // Idempotent: existing tag wins. We test for non-empty string so a row that
  // somehow got persisted with teacher_version='' gets re-tagged.
  if (typeof captureRow.teacher_version === 'string' && captureRow.teacher_version.trim()) {
    // Backfill teacher_provider if missing but version exists (cosmetic).
    if (captureRow.teacher_provider == null) {
      captureRow.teacher_provider = _normProvider(captureRow.provider) || '';
    }
    return captureRow;
  }
  const provider = _normProvider(captureRow.provider);
  captureRow.teacher_version = currentTeacherVersion(provider);
  captureRow.teacher_provider = provider;
  return captureRow;
}

// =============================================================================
// groupByTeacherVersion(captures) - count rows per teacher_version string.
//
// Returns an object { [teacher_version]: count }. Rows without a teacher_version
// field get bucketed under FALLBACK so the count is honest about how many
// rows were captured BEFORE the W746 tagging was enabled.
// =============================================================================
export function groupByTeacherVersion(captures) {
  const out = {};
  if (!Array.isArray(captures)) return out;
  for (const cap of captures) {
    const v = (cap && typeof cap.teacher_version === 'string' && cap.teacher_version.trim())
      ? cap.teacher_version.trim()
      : FALLBACK;
    out[v] = (out[v] || 0) + 1;
  }
  return out;
}
