// src/vision-capture.js
//
// W771 — Vision-language capture detector + normalizer.
//
// The capture chokepoint that recognizes (and properly normalizes) vision
// content blocks across the three large-vendor schemas we see in the wild:
//
//   * OpenAI / OpenRouter            content[].type === 'image_url'
//   * Anthropic Messages API         content[].type === 'image'   (with .source.{type,media_type,data,url})
//   * Google Gemini / Vertex         content[].fileData            (with .mimeType + .fileUri)
//   * Inline base64 data URLs        data:<mime>;base64,<payload>  (any of the above schemas)
//
// Why a NEW module instead of grafting onto src/capture.js: src/capture.js
// is the text-side capture chokepoint (`extractPromptForCapture`,
// `extractCompletionText`, `extractReasoningTrace`). Vision is a different
// privacy domain — raw image bytes can carry EXIF, biometric features, and
// other persona data that the text-side redactor never touches. Keeping the
// vision-detect path in its own module means the W771 honesty contract
// ("NEVER persist raw image bytes — only URL or hash") is enforced at the
// chokepoint, not buried in a switch inside the text path.
//
// HONESTY INVARIANTS (NEVER violate):
//
//   * captureVisionMessage MUST NOT persist raw image bytes. Only the URL,
//     a sha256 of the URL (so the same image is recognizable across runs
//     without storing its content), and a byte-count estimate. This is
//     verified by tests/wave771-vlm-distill.test.js #10.
//
//   * detectVisionCapture MUST NEVER throw on malformed input. A
//     half-typed content block is honest data — we report
//     `{is_vision:false}` so the caller can treat it as a normal text
//     message rather than crashing the request.
//
//   * normalizeImageBlock caps byte_count_estimate at 50MB. A buyer-side
//     bug (or an adversarial caller) could embed a 4GB base64 payload in
//     a content block; we will not let an estimate field grow unbounded.
//
//   * W411 defense-in-depth: the per-tenant fence is applied at the
//     persistence boundary by captureVisionMessage's caller (src/router.js
//     /v1/vision/captures), not inside this module. detectVisionCapture
//     is pure — it does not read or write state.
//
// W411 defense-in-depth law (cross-reference):
//   Per-row tenant_id filter on any tenant-scoped read of the
//   observations table. Caller passes tenant_id explicitly; the
//   captureVisionMessage row stamps it.
//
// Distinct from src/capture.js (text) and src/multimodal-bakeoff.js (image
// PII redaction is workers/multimodal-redact-image/, W462). The vision-
// capture chokepoint sits BEFORE the redact step — it is the
// "did the request even carry an image" detector.

import crypto from 'node:crypto';

export const VISION_CAPTURE_VERSION = 'w771-v1';

// Hard cap on the byte_count_estimate field. 50MB is plenty for any single
// image (4K PNG ~25MB worst case, JPEG photo ~12MB). Capping prevents an
// adversarial caller (or buggy SDK) from blowing up the estimate field
// with a malformed base64 payload that decodes to gigabytes.
export const MAX_IMAGE_BYTE_ESTIMATE = 50 * 1024 * 1024; // 50MB

// Sentinel for image-block source classification. Frozen so a downstream
// consumer cannot push a new value and silent-pass schema validation.
export const IMAGE_SOURCE_KINDS = Object.freeze([
  'url',     // external URL (https://, data:, etc.) - OpenAI image_url.url, Anthropic source.url
  'base64',  // inline base64 (Anthropic source.data, data:image/...;base64,...)
  'gcs',     // Google Cloud Storage URI (gs://) - Gemini fileData.fileUri
  'unknown', // shape recognized as image but source field missing
]);

// =============================================================================
// Internal helpers.
// =============================================================================

// Parse data URL of the form "data:<mime>;base64,<payload>" - returns
// {mime_type, base64_payload, byte_count_estimate} or null on bad shape.
// Base64 payload size * 3/4 gives the actual decoded byte count.
function _parseDataUrl(url) {
  if (typeof url !== 'string') return null;
  if (!url.startsWith('data:')) return null;
  const m = url.match(/^data:([^;,]+)?(?:;([^,]+))?,(.+)$/);
  if (!m) return null;
  const mime = (m[1] || 'application/octet-stream').toLowerCase();
  const params = m[2] || '';
  const payload = m[3] || '';
  const isBase64 = /(?:^|;)\s*base64\s*$/i.test(params);
  // Decoded byte count = base64 length * 3/4 (minus padding). We don't decode
  // the actual bytes - that would defeat the "never persist raw image bytes"
  // honesty rule. The estimate is good to within ±2 bytes.
  let byteEst;
  if (isBase64) {
    const padding = (payload.match(/=+$/) || [''])[0].length;
    byteEst = Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
  } else {
    // URL-encoded payload - decoded length is opaque without actually decoding.
    // Approximate as the raw payload length; this can over-estimate by 2-3x
    // but for the cap-check it is the conservative direction.
    byteEst = payload.length;
  }
  return {
    mime_type: mime,
    is_base64: isBase64,
    byte_count_estimate: Math.min(byteEst, MAX_IMAGE_BYTE_ESTIMATE),
  };
}

// SHA-256 the URL into a stable hex digest so distill can recognize the
// same image across captures without ever storing the byte content. Slice
// to 24 hex chars - 96 bits is enough collision resistance for image
// dedup; full 64 hex is overkill in a row stamp.
function _hashUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  return crypto.createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 24);
}

// Classify the image MIME into a coarse "kind" bucket used by the bakeoff
// rollup. Photo vs screenshot vs diagram is impossible from MIME alone —
// the bakeoff caller can refine via classifier later. Default 'other'.
function _kindFromMime(mime) {
  if (typeof mime !== 'string' || mime.length === 0) return 'other';
  const m = mime.toLowerCase();
  if (m.includes('png') || m.includes('jpeg') || m.includes('jpg')) return 'photo';
  if (m.includes('webp') || m.includes('avif')) return 'photo';
  if (m.includes('gif')) return 'photo';
  if (m.includes('svg')) return 'diagram';
  if (m.includes('tiff') || m.includes('bmp')) return 'photo';
  if (m.includes('heic') || m.includes('heif')) return 'photo';
  return 'other';
}

// =============================================================================
// detectVisionCapture — pure detector. Handles OpenAI, Anthropic, Google
// content blocks; returns honest envelope on unknown shapes.
// =============================================================================
//
// Input: an OpenAI / Anthropic / generic chat message object. Shape:
//   { role: 'user'|'assistant'|'system', content: [...] }
//   OR
//   { role: '...', content: 'plain text' }
//
// Output:
//   {
//     is_vision: boolean,
//     image_url_blocks: [...],     // raw blocks of type:image_url (OpenAI)
//                                  //   + type:image with url-source (Anthropic)
//                                  //   + fileData blocks (Google)
//     base64_blocks: [...],        // blocks where the image is inlined as base64
//     total_images: number,
//   }
export function detectVisionCapture(message) {
  const empty = {
    is_vision: false,
    image_url_blocks: [],
    base64_blocks: [],
    total_images: 0,
  };
  if (!message || typeof message !== 'object') return empty;
  const content = message.content;
  // Text-only message - either a plain string or no content field at all.
  // We don't need to dig further; report honestly.
  if (content == null) return empty;
  if (typeof content === 'string') return empty;
  if (!Array.isArray(content)) return empty;

  const urlBlocks = [];
  const base64Blocks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;

    // OpenAI / OpenRouter shape: { type: 'image_url', image_url: { url: '...', detail: '...' } }
    // We accept the url field as either a plain HTTPS URL or a data: URL.
    if (block.type === 'image_url') {
      const url = (block.image_url && typeof block.image_url === 'object')
        ? (typeof block.image_url.url === 'string' ? block.image_url.url : null)
        : (typeof block.image_url === 'string' ? block.image_url : null);
      if (url) {
        if (url.startsWith('data:')) {
          base64Blocks.push(block);
        } else {
          urlBlocks.push(block);
        }
      } else {
        // type:image_url but missing url field - honest data, just report it.
        urlBlocks.push(block);
      }
      continue;
    }

    // Anthropic shape: { type: 'image', source: { type: 'base64'|'url', media_type, data|url } }
    if (block.type === 'image') {
      const source = (block.source && typeof block.source === 'object') ? block.source : null;
      const srcType = source ? source.type : null;
      if (srcType === 'base64') {
        base64Blocks.push(block);
      } else if (srcType === 'url') {
        urlBlocks.push(block);
      } else {
        // Unknown source type - default to url bucket so it's still surfaced.
        urlBlocks.push(block);
      }
      continue;
    }

    // Google Gemini / Vertex shape: { fileData: { mimeType, fileUri } }
    // or { inlineData: { mimeType, data: '<base64>' } }
    if (block.fileData && typeof block.fileData === 'object') {
      urlBlocks.push(block);
      continue;
    }
    if (block.inlineData && typeof block.inlineData === 'object') {
      base64Blocks.push(block);
      continue;
    }
  }

  const total = urlBlocks.length + base64Blocks.length;
  return {
    is_vision: total > 0,
    image_url_blocks: urlBlocks,
    base64_blocks: base64Blocks,
    total_images: total,
  };
}

// =============================================================================
// normalizeImageBlock — canonicalize a single image block into a stable
// shape regardless of vendor.
// =============================================================================
//
// Returns canonical:
//   {
//     ok: true,
//     url: string|null,             // for URL-source blocks (https:// or gs://)
//     mime_type: string|null,
//     byte_count_estimate: number,  // capped at 50MB
//     source: 'url'|'base64'|'gcs'|'unknown',
//   }
// OR honest envelope on malformed input:
//   { ok: false, error: 'invalid_image_block', hint: '...', version: 'w771-v1' }
export function normalizeImageBlock(block, opts = {}) {
  if (!block || typeof block !== 'object') {
    return {
      ok: false,
      error: 'invalid_image_block',
      hint: 'block must be a non-null object',
      version: VISION_CAPTURE_VERSION,
    };
  }
  const _ = opts; // reserved for future shape options (e.g. strict_mime_validation)

  // OpenAI image_url
  if (block.type === 'image_url') {
    const url = (block.image_url && typeof block.image_url === 'object')
      ? (typeof block.image_url.url === 'string' ? block.image_url.url : null)
      : (typeof block.image_url === 'string' ? block.image_url : null);
    if (!url) {
      return {
        ok: false,
        error: 'invalid_image_block',
        hint: 'image_url block missing url field',
        version: VISION_CAPTURE_VERSION,
      };
    }
    if (url.startsWith('data:')) {
      const parsed = _parseDataUrl(url);
      if (!parsed) {
        return {
          ok: false,
          error: 'invalid_image_block',
          hint: 'data URL did not parse to data:<mime>[;base64],<payload>',
          version: VISION_CAPTURE_VERSION,
        };
      }
      return {
        ok: true,
        url: null,
        mime_type: parsed.mime_type,
        byte_count_estimate: parsed.byte_count_estimate,
        source: 'base64',
      };
    }
    // Plain URL.
    return {
      ok: true,
      url,
      mime_type: null,
      byte_count_estimate: 0,
      source: 'url',
    };
  }

  // Anthropic image
  if (block.type === 'image') {
    const source = (block.source && typeof block.source === 'object') ? block.source : null;
    if (!source) {
      return {
        ok: false,
        error: 'invalid_image_block',
        hint: 'anthropic image block missing source field',
        version: VISION_CAPTURE_VERSION,
      };
    }
    if (source.type === 'base64') {
      // source.data is the raw base64 payload, source.media_type the MIME.
      const mime = (typeof source.media_type === 'string' ? source.media_type : 'application/octet-stream').toLowerCase();
      const payload = typeof source.data === 'string' ? source.data : '';
      const padding = (payload.match(/=+$/) || [''])[0].length;
      const byteEst = Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
      return {
        ok: true,
        url: null,
        mime_type: mime,
        byte_count_estimate: Math.min(byteEst, MAX_IMAGE_BYTE_ESTIMATE),
        source: 'base64',
      };
    }
    if (source.type === 'url') {
      const url = typeof source.url === 'string' ? source.url : null;
      if (!url) {
        return {
          ok: false,
          error: 'invalid_image_block',
          hint: 'anthropic image block source.url missing',
          version: VISION_CAPTURE_VERSION,
        };
      }
      return {
        ok: true,
        url,
        mime_type: (typeof source.media_type === 'string' ? source.media_type.toLowerCase() : null),
        byte_count_estimate: 0,
        source: 'url',
      };
    }
    // Unknown source type.
    return {
      ok: true,
      url: null,
      mime_type: null,
      byte_count_estimate: 0,
      source: 'unknown',
    };
  }

  // Google fileData (URL-pointer, often gs://)
  if (block.fileData && typeof block.fileData === 'object') {
    const uri = typeof block.fileData.fileUri === 'string' ? block.fileData.fileUri : null;
    if (!uri) {
      return {
        ok: false,
        error: 'invalid_image_block',
        hint: 'google fileData block missing fileUri',
        version: VISION_CAPTURE_VERSION,
      };
    }
    const isGcs = uri.startsWith('gs://');
    return {
      ok: true,
      url: uri,
      mime_type: (typeof block.fileData.mimeType === 'string' ? block.fileData.mimeType.toLowerCase() : null),
      byte_count_estimate: 0,
      source: isGcs ? 'gcs' : 'url',
    };
  }

  // Google inlineData (base64)
  if (block.inlineData && typeof block.inlineData === 'object') {
    const mime = (typeof block.inlineData.mimeType === 'string' ? block.inlineData.mimeType : 'application/octet-stream').toLowerCase();
    const payload = typeof block.inlineData.data === 'string' ? block.inlineData.data : '';
    const padding = (payload.match(/=+$/) || [''])[0].length;
    const byteEst = Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
    return {
      ok: true,
      url: null,
      mime_type: mime,
      byte_count_estimate: Math.min(byteEst, MAX_IMAGE_BYTE_ESTIMATE),
      source: 'base64',
    };
  }

  // Honest envelope on any other shape - we recognize image blocks by the
  // exact three shapes above; everything else is "not an image block we know".
  return {
    ok: false,
    error: 'invalid_image_block',
    hint: 'block did not match OpenAI image_url, Anthropic image, or Google fileData/inlineData shape',
    version: VISION_CAPTURE_VERSION,
  };
}

// =============================================================================
// captureVisionMessage — chokepoint for vision capture rows.
//
// HONESTY INVARIANT: never persists raw image bytes. Only the URL, a
// sha256 of the URL (so deduplication is possible across runs), and a
// byte_count_estimate so the storage layer can budget without surprises.
//
// DI: opts.storeMod (default ./capture-store.js), opts.eventStore (default
// ./event-store.js). Tests can inject in-memory fakes.
// =============================================================================
export async function captureVisionMessage({
  tenant_id,
  namespace = 'default',
  messages = [],
  response = null,
  opts = {},
} = {}) {
  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'pass {tenant_id: "<id>"}. Vision capture is tenant-scoped.',
      version: VISION_CAPTURE_VERSION,
    };
  }
  if (!Array.isArray(messages)) {
    return {
      ok: false,
      error: 'messages_must_be_array',
      hint: 'pass {messages: [...]}; one chat message per array entry',
      version: VISION_CAPTURE_VERSION,
    };
  }
  // Walk every message; aggregate the vision blocks across the whole turn.
  // The last assistant turn may carry its own image-output too (rare today,
  // but Anthropic's vision-out roadmap supports it) — we treat assistant
  // turns the same as user turns for the detect path.
  let totalImages = 0;
  const allUrls = [];
  const allBase64 = [];
  for (const msg of messages) {
    const det = detectVisionCapture(msg);
    if (!det.is_vision) continue;
    totalImages += det.total_images;
    for (const b of det.image_url_blocks) allUrls.push(b);
    for (const b of det.base64_blocks) allBase64.push(b);
  }

  // Hash each URL block; for base64 blocks, hash a stable token derived
  // from (mime, byte_count_estimate) so the row is still dedupable across
  // runs without ever ingesting the raw payload bytes.
  const hashed = [];
  for (const block of allUrls) {
    const norm = normalizeImageBlock(block);
    if (!norm.ok) continue;
    if (norm.url) hashed.push(_hashUrl(norm.url));
  }
  for (const block of allBase64) {
    const norm = normalizeImageBlock(block);
    if (!norm.ok) continue;
    // For base64 we hash a stable descriptor so dedup still works without
    // touching the payload. The dedup token is (mime + estimate + source).
    hashed.push(_hashUrl(
      'b64:' + (norm.mime_type || 'unknown') + ':' + String(norm.byte_count_estimate)
    ));
  }

  // Build the canonical capture row. NEVER include raw image bytes —
  // only the URL strings (if URL-sourced) and the hash digests. The
  // tests verify the persisted row to confirm this invariant holds.
  const captureRow = {
    id: 'vcap_' + crypto.randomBytes(8).toString('hex'),
    tenant: tenant_id,
    tenant_id, // both keys so W411 defense-in-depth fences fire either way
    corpus_namespace: namespace,
    has_vision: true,
    vision_block_count: totalImages,
    vision_block_count_url: allUrls.length,
    vision_block_count_base64: allBase64.length,
    // Only URL strings + hashes go on the row. Raw image bytes are
    // EXPLICITLY DROPPED here. See the test at #10.
    image_urls: allUrls.map((b) => {
      const n = normalizeImageBlock(b);
      return (n.ok && n.url) ? n.url : null;
    }).filter((u) => u != null),
    image_urls_hashed: hashed.filter((h) => h != null),
    image_kinds: allUrls.concat(allBase64).map((b) => {
      const n = normalizeImageBlock(b);
      return n.ok ? _kindFromMime(n.mime_type) : 'other';
    }),
    response_text: (response && typeof response.text === 'string')
      ? response.text.slice(0, 16000)
      : null,
    created_at: new Date().toISOString(),
    version: VISION_CAPTURE_VERSION,
  };

  // Persist via injected storeMod when present, fall back to capture-store.
  // We DO NOT eagerly import capture-store at module top because the
  // module pulls in the SQLite driver - tests want a thin in-memory fake.
  const storeMod = (opts && opts.storeMod) || null;
  if (storeMod && typeof storeMod.insertCapture === 'function') {
    try {
      await storeMod.insertCapture(captureRow);
    } catch (e) {
      return {
        ok: false,
        error: 'persist_failed',
        hint: String(e && e.message || e),
        version: VISION_CAPTURE_VERSION,
      };
    }
  }
  // When opts.storeMod is absent we deliberately do NOT silently auto-bind
  // capture-store - callers wanting persistence must opt in. This keeps
  // detectVisionCapture-only callers (the /v1/vision/capture-detect route)
  // free of side effects.

  return {
    ok: true,
    captured: true,
    capture_id: captureRow.id,
    has_vision: true,
    vision_block_count: totalImages,
    image_urls_hashed: captureRow.image_urls_hashed,
    persisted_row: captureRow,
    version: VISION_CAPTURE_VERSION,
  };
}

// =============================================================================
// Introspection helper for /v1/vision/captures + CLI.
// Reads the observations table via the injected storeMod (defaults to the
// real capture-store), filters tenant + has_vision, returns a list.
//
// W411 defense-in-depth: explicit per-row tenant_id filter even after the
// store.all() read. Audit-export uses the same pattern - we copy it here
// so future schema changes can't silently flip "no leak" to "all leak".
// =============================================================================
export function listVisionCaptures({
  tenant_id,
  namespace = null,
  limit = 100,
  opts = {},
} = {}) {
  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      version: VISION_CAPTURE_VERSION,
    };
  }
  const storeMod = (opts && opts.storeMod) || null;
  const all = (storeMod && typeof storeMod.all === 'function') ? storeMod.all : null;
  if (!all) {
    return {
      ok: true,
      tenant_id,
      namespace,
      count: 0,
      captures: [],
      version: VISION_CAPTURE_VERSION,
      hint: 'no storeMod wired; pass opts.storeMod to read persisted captures',
    };
  }
  const rawRows = all('observations') || [];
  // W411: per-row tenant filter even after the all() read. We tolerate
  // tenant being on either `tenant` or `tenant_id` because the canonical
  // observations table uses `tenant` (see daemon-connector.js:675) while
  // the vision capture row stamps both for fence resilience.
  const tenantRows = rawRows.filter((r) =>
    r && (r.tenant === tenant_id || r.tenant_id === tenant_id));
  const visionRows = tenantRows.filter((r) => r && r.has_vision === true);
  const nsFiltered = namespace
    ? visionRows.filter((r) => r && r.corpus_namespace === namespace)
    : visionRows;
  // Most-recent-first by created_at (string ISO compare is fine for our
  // 24-hex-char-prefix timestamps; the stamp guarantees lexicographic order).
  const sorted = nsFiltered.slice().sort((a, b) => {
    const ta = String(a.created_at || '');
    const tb = String(b.created_at || '');
    return tb.localeCompare(ta);
  });
  const cap = Math.max(1, Math.min(Number(limit) || 100, 1000));
  return {
    ok: true,
    tenant_id,
    namespace,
    count: sorted.length,
    captures: sorted.slice(0, cap),
    limit: cap,
    version: VISION_CAPTURE_VERSION,
  };
}
