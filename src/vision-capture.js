// src/vision-capture.js
//
// W771 - Vision-language capture detector + normalizer.
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
// privacy domain - raw image bytes can carry EXIF, biometric features, and
// other persona data that the text-side redactor never touches. Keeping the
// vision-detect path in its own module means the W771 honesty contract
// ("NEVER persist raw image bytes - only URL or hash") is enforced at the
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
//     half-typed content block is honest data - we report
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
//     is pure - it does not read or write state.
//
// W411 defense-in-depth law (cross-reference):
//   Per-row tenant_id filter on any tenant-scoped read of the
//   observations table. Caller passes tenant_id explicitly; the
//   captureVisionMessage row stamps it.
//
// Distinct from src/capture.js (text) and src/multimodal-bakeoff.js (image
// PII redaction is workers/multimodal-redact-image/, W462). The vision-
// capture chokepoint sits BEFORE the redact step - it is the
// "did the request even carry an image" detector.

import crypto from 'node:crypto';

export const VISION_CAPTURE_VERSION = 'w771-v1';
export const VISION_CAPTURE_CONTRACT_VERSION = 'w735-vision-capture-v1';
export const VISION_CAPTURE_LIMITS = Object.freeze({
  max_messages: 128,
  max_message_blocks: 256,
  max_image_blocks: 32,
  max_inline_scan_chars: 4096,
  max_url_chars: 4096,
  max_data_url_chars: 262144,
  max_tenant_id_chars: 160,
  max_namespace_chars: 128,
  max_response_text_chars: 16000,
  max_store_rows_scanned: 5000,
  max_list_limit: 1000,
  max_image_byte_estimate: 50 * 1024 * 1024,
});

// Hard cap on the byte_count_estimate field. 50MB is plenty for any single
// image (4K PNG ~25MB worst case, JPEG photo ~12MB). Capping prevents an
// adversarial caller (or buggy SDK) from blowing up the estimate field
// with a malformed base64 payload that decodes to gigabytes.
export const MAX_IMAGE_BYTE_ESTIMATE = VISION_CAPTURE_LIMITS.max_image_byte_estimate;

export const SUPPORTED_IMAGE_MIMES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
  'image/tiff',
  'image/bmp',
  'image/heic',
  'image/heif',
]);

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

const SAFE_ID_RE = /^[A-Za-z0-9_.:@-]+$/;
const SAFE_NAMESPACE_RE = /^[A-Za-z0-9_.:@/-]+$/;

function _sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function _cleanStrictText(value, maxChars) {
  if (value == null) return null;
  const raw = String(value);
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > maxChars) return null;
  return cleaned;
}

function _cleanLooseText(value, maxChars) {
  if (value == null) return null;
  const cleaned = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

function _normalizeTenantId(value) {
  const cleaned = _cleanStrictText(value, VISION_CAPTURE_LIMITS.max_tenant_id_chars);
  return cleaned && SAFE_ID_RE.test(cleaned) ? cleaned : null;
}

function _normalizeNamespace(value) {
  const cleaned = _cleanStrictText(
    value == null || value === '' ? 'default' : value,
    VISION_CAPTURE_LIMITS.max_namespace_chars,
  );
  return cleaned && SAFE_NAMESPACE_RE.test(cleaned) ? cleaned : null;
}

function _normalizeMimeType(value) {
  const mime = _cleanStrictText(value, 96);
  return mime ? mime.toLowerCase() : null;
}

function _isSupportedImageMime(mime) {
  return typeof mime === 'string' && SUPPORTED_IMAGE_MIMES.includes(mime.toLowerCase());
}

function _errorEnvelope(error, detail, extra = {}) {
  return {
    ok: false,
    error,
    version: VISION_CAPTURE_VERSION,
    contract_version: VISION_CAPTURE_CONTRACT_VERSION,
    error_sha256: _sha256Hex(detail || error),
    ...extra,
  };
}

function _mimeFromUrl(url) {
  if (typeof url !== 'string') return null;
  let lower = url.toLowerCase();
  try { lower = new URL(url).pathname.toLowerCase(); } catch { /* best effort */ }
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.avif')) return 'image/avif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.heif')) return 'image/heif';
  return null;
}

// Parse data URL of the form "data:<mime>;base64,<payload>" - returns
// {mime_type, base64_payload, byte_count_estimate} or null on bad shape.
// Base64 payload size * 3/4 gives the actual decoded byte count.
function _parseDataUrl(url) {
  const safe = _cleanStrictText(url, VISION_CAPTURE_LIMITS.max_data_url_chars);
  if (!safe || !safe.startsWith('data:')) return null;
  const m = safe.match(/^data:([^;,]+)?(?:;([^,]+))?,(.*)$/);
  if (!m) return null;
  const mime = _normalizeMimeType(m[1] || 'application/octet-stream');
  if (!_isSupportedImageMime(mime)) return null;
  const params = m[2] || '';
  const payload = m[3] || '';
  const isBase64 = /(?:^|;)\s*base64\s*$/i.test(params);
  // Decoded byte count = base64 length * 3/4 (minus padding). We don't decode
  // the actual bytes - that would defeat the "never persist raw image bytes"
  // honesty rule. The estimate is good to within +/- 2 bytes.
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
    content_sha256: _sha256Hex(payload),
    url_sha256: _sha256Hex(safe),
  };
}

// SHA-256 the URL into a stable full-length digest so distill can recognize
// the same image across captures without storing the byte content.
function _hashUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  return _sha256Hex(url);
}

function _safeUrlForEnvelope(rawUrl, mimeType = null) {
  const raw = String(rawUrl || '');
  const maxChars = raw.startsWith('data:')
    ? VISION_CAPTURE_LIMITS.max_data_url_chars
    : VISION_CAPTURE_LIMITS.max_url_chars;
  const url = _cleanStrictText(rawUrl, maxChars);
  if (!url) return null;

  if (url.startsWith('data:')) {
    const parsed = _parseDataUrl(url);
    if (!parsed) return null;
    return {
      url: null,
      url_sha256: parsed.url_sha256,
      content_sha256: parsed.content_sha256,
      mime_type: parsed.mime_type,
      byte_count_estimate: parsed.byte_count_estimate,
      source: 'base64',
    };
  }

  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!['http:', 'https:', 'gs:'].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol === 'gs:' && !parsed.hostname) return null;
  const safeUrl = parsed.protocol === 'gs:'
    ? `gs://${parsed.hostname}${parsed.pathname}`
    : parsed.origin + parsed.pathname;
  const explicitMime = _normalizeMimeType(mimeType);
  const inferredMime = explicitMime || _mimeFromUrl(safeUrl);
  if (explicitMime && !_isSupportedImageMime(explicitMime)) return null;
  return {
    url: safeUrl,
    url_sha256: _hashUrl(url),
    mime_type: inferredMime,
    byte_count_estimate: 0,
    source: parsed.protocol === 'gs:' ? 'gcs' : 'url',
  };
}

function _normalizeBase64Image(mimeValue, payloadValue) {
  const mime = _normalizeMimeType(mimeValue || 'application/octet-stream');
  if (!_isSupportedImageMime(mime)) return null;
  if (typeof payloadValue !== 'string') return null;
  const payload = payloadValue;
  if (/[\u0000-\u001f\u007f]/.test(payload)) return null;
  const padding = (payload.match(/=+$/) || [''])[0].length;
  const byteEst = Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
  return {
    url: null,
    mime_type: mime,
    byte_count_estimate: Math.min(byteEst, MAX_IMAGE_BYTE_ESTIMATE),
    source: 'base64',
    content_sha256: _sha256Hex(payload),
  };
}

// Classify the image MIME into a coarse "kind" bucket used by the bakeoff
// rollup. Photo vs screenshot vs diagram is impossible from MIME alone - 
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
// detectVisionCapture - pure detector. Handles OpenAI, Anthropic, Google
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
    total_image_blocks_detected: 0,
    contract_version: VISION_CAPTURE_CONTRACT_VERSION,
  };
  if (!message || typeof message !== 'object') return empty;
  const content = message.content;
  // Text-only message - either a plain string or no content field at all.
  // We don't need to dig further; report honestly.
  if (content == null) return empty;
  if (typeof content === 'string') {
    const m = content
      .slice(0, VISION_CAPTURE_LIMITS.max_inline_scan_chars)
      .match(/data:(image\/[a-z0-9.+-]+);base64,/i);
    if (!m) return empty;
    return {
      is_vision: true,
      image_url_blocks: [],
      base64_blocks: [{
        type: 'image_url',
        image_url: { url: `data:${m[1].toLowerCase()};base64,` },
      }],
      total_images: 1,
      total_image_blocks_detected: 1,
      contract_version: VISION_CAPTURE_CONTRACT_VERSION,
    };
  }
  if (!Array.isArray(content)) return empty;

  const urlBlocks = [];
  const base64Blocks = [];
  let totalDetected = 0;
  for (const block of content.slice(0, VISION_CAPTURE_LIMITS.max_message_blocks)) {
    if (!block || typeof block !== 'object') continue;
    const pushUrl = () => {
      totalDetected += 1;
      if ((urlBlocks.length + base64Blocks.length) < VISION_CAPTURE_LIMITS.max_image_blocks) {
        urlBlocks.push(block);
      }
    };
    const pushBase64 = () => {
      totalDetected += 1;
      if ((urlBlocks.length + base64Blocks.length) < VISION_CAPTURE_LIMITS.max_image_blocks) {
        base64Blocks.push(block);
      }
    };

    // OpenAI / OpenRouter shape: { type: 'image_url', image_url: { url: '...', detail: '...' } }
    // We accept the url field as either a plain HTTPS URL or a data: URL.
    if (block.type === 'image_url') {
      const url = (block.image_url && typeof block.image_url === 'object')
        ? (typeof block.image_url.url === 'string' ? block.image_url.url : null)
        : (typeof block.image_url === 'string' ? block.image_url : null);
      if (url) {
        if (url.startsWith('data:')) {
          pushBase64();
        } else {
          pushUrl();
        }
      } else {
        // type:image_url but missing url field - honest data, just report it.
        pushUrl();
      }
      continue;
    }

    // Anthropic shape: { type: 'image', source: { type: 'base64'|'url', media_type, data|url } }
    if (block.type === 'image') {
      const source = (block.source && typeof block.source === 'object') ? block.source : null;
      const srcType = source ? source.type : null;
      if (srcType === 'base64') {
        pushBase64();
      } else if (srcType === 'url') {
        pushUrl();
      } else {
        // Unknown source type - default to url bucket so it's still surfaced.
        pushUrl();
      }
      continue;
    }

    // Google Gemini / Vertex shape: { fileData: { mimeType, fileUri } }
    // or { inlineData: { mimeType, data: '<base64>' } }
    if (block.fileData && typeof block.fileData === 'object') {
      pushUrl();
      continue;
    }
    if (block.inlineData && typeof block.inlineData === 'object') {
      pushBase64();
      continue;
    }
  }

  const total = urlBlocks.length + base64Blocks.length;
  return {
    is_vision: total > 0,
    image_url_blocks: urlBlocks,
    base64_blocks: base64Blocks,
    total_images: total,
    total_image_blocks_detected: totalDetected,
    contract_version: VISION_CAPTURE_CONTRACT_VERSION,
  };
}

// =============================================================================
// normalizeImageBlock - canonicalize a single image block into a stable
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
    return _errorEnvelope('invalid_image_block', 'block_not_object', {
      hint: 'block must be a non-null object',
    });
  }
  const _ = opts; // reserved for future shape options (e.g. strict_mime_validation)

  // OpenAI image_url
  if (block.type === 'image_url') {
    const url = (block.image_url && typeof block.image_url === 'object')
      ? (typeof block.image_url.url === 'string' ? block.image_url.url : null)
      : (typeof block.image_url === 'string' ? block.image_url : null);
    if (!url) {
      return _errorEnvelope('invalid_image_block', 'missing_image_url', {
        hint: 'image_url block missing url field',
      });
    }
    const safeUrl = _safeUrlForEnvelope(url);
    if (!safeUrl) {
      return _errorEnvelope('invalid_image_url', 'unsafe_or_unsupported_image_url', {
        hint: 'image URL must be http(s), gs://, or supported data:image/* without credentials or control characters',
      });
    }
    return {
      ok: true,
      url: safeUrl.url,
      url_sha256: safeUrl.url_sha256,
      content_sha256: safeUrl.content_sha256 || null,
      mime_type: safeUrl.mime_type,
      byte_count_estimate: safeUrl.byte_count_estimate,
      source: safeUrl.source,
      version: VISION_CAPTURE_VERSION,
      contract_version: VISION_CAPTURE_CONTRACT_VERSION,
    };
  }

  // Anthropic image
  if (block.type === 'image') {
    const source = (block.source && typeof block.source === 'object') ? block.source : null;
    if (!source) {
      return _errorEnvelope('invalid_image_block', 'missing_anthropic_source', {
        hint: 'anthropic image block missing source field',
      });
    }
    if (source.type === 'base64') {
      const normalized = _normalizeBase64Image(source.media_type, source.data);
      if (!normalized) {
        return _errorEnvelope('invalid_image_block', 'unsupported_or_missing_base64_image', {
          hint: 'base64 image blocks require a supported image MIME and string data',
        });
      }
      return {
        ok: true,
        ...normalized,
        url_sha256: null,
        version: VISION_CAPTURE_VERSION,
        contract_version: VISION_CAPTURE_CONTRACT_VERSION,
      };
    }
    if (source.type === 'url') {
      const url = typeof source.url === 'string' ? source.url : null;
      if (!url) {
        return _errorEnvelope('invalid_image_block', 'missing_anthropic_source_url', {
          hint: 'anthropic image block source.url missing',
        });
      }
      const safeUrl = _safeUrlForEnvelope(url, source.media_type);
      if (!safeUrl) {
        return _errorEnvelope('invalid_image_url', 'unsafe_or_unsupported_anthropic_url', {
          hint: 'anthropic source.url must be http(s) or gs:// without credentials and with a supported image MIME when provided',
        });
      }
      return {
        ok: true,
        url: safeUrl.url,
        url_sha256: safeUrl.url_sha256,
        content_sha256: null,
        mime_type: safeUrl.mime_type,
        byte_count_estimate: safeUrl.byte_count_estimate,
        source: safeUrl.source,
        version: VISION_CAPTURE_VERSION,
        contract_version: VISION_CAPTURE_CONTRACT_VERSION,
      };
    }
    // Unknown source type.
    return {
      ok: true,
      url: null,
      url_sha256: null,
      content_sha256: null,
      mime_type: null,
      byte_count_estimate: 0,
      source: 'unknown',
      version: VISION_CAPTURE_VERSION,
      contract_version: VISION_CAPTURE_CONTRACT_VERSION,
    };
  }

  // Google fileData (URL-pointer, often gs://)
  if (block.fileData && typeof block.fileData === 'object') {
    const uri = typeof block.fileData.fileUri === 'string' ? block.fileData.fileUri : null;
    if (!uri) {
      return _errorEnvelope('invalid_image_block', 'missing_google_file_uri', {
        hint: 'google fileData block missing fileUri',
      });
    }
    const safeUrl = _safeUrlForEnvelope(uri, block.fileData.mimeType);
    if (!safeUrl) {
      return _errorEnvelope('invalid_image_url', 'unsafe_or_unsupported_google_file_uri', {
        hint: 'google fileData.fileUri must be http(s) or gs:// without credentials and with a supported image MIME when provided',
      });
    }
    return {
      ok: true,
      url: safeUrl.url,
      url_sha256: safeUrl.url_sha256,
      content_sha256: null,
      mime_type: safeUrl.mime_type,
      byte_count_estimate: safeUrl.byte_count_estimate,
      source: safeUrl.source,
      version: VISION_CAPTURE_VERSION,
      contract_version: VISION_CAPTURE_CONTRACT_VERSION,
    };
  }

  // Google inlineData (base64)
  if (block.inlineData && typeof block.inlineData === 'object') {
    const normalized = _normalizeBase64Image(block.inlineData.mimeType, block.inlineData.data);
    if (!normalized) {
      return _errorEnvelope('invalid_image_block', 'unsupported_or_missing_inline_image', {
        hint: 'google inlineData requires a supported image MIME and string data',
      });
    }
    return {
      ok: true,
      ...normalized,
      url_sha256: null,
      version: VISION_CAPTURE_VERSION,
      contract_version: VISION_CAPTURE_CONTRACT_VERSION,
    };
  }

  // Honest envelope on any other shape - we recognize image blocks by the
  // exact three shapes above; everything else is "not an image block we know".
  return _errorEnvelope('invalid_image_block', 'unknown_image_block_shape', {
    hint: 'block did not match OpenAI image_url, Anthropic image, or Google fileData/inlineData shape',
  });
}

// =============================================================================
// captureVisionMessage - chokepoint for vision capture rows.
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
  const normalizedTenantId = _normalizeTenantId(tenant_id);
  if (!normalizedTenantId) {
    return _errorEnvelope('tenant_id_required', 'invalid_tenant_id', {
      hint: 'pass a bounded tenant_id. Vision capture is tenant-scoped.',
    });
  }
  const normalizedNamespace = _normalizeNamespace(namespace);
  if (!normalizedNamespace) {
    return _errorEnvelope('invalid_namespace', 'invalid_namespace', {
      hint: 'namespace may contain letters, numbers, dot, underscore, dash, colon, at, and slash only',
    });
  }
  if (!Array.isArray(messages)) {
    return _errorEnvelope('messages_must_be_array', 'messages_must_be_array', {
      hint: 'pass {messages: [...]}; one chat message per array entry',
    });
  }
  // Walk every message; aggregate the vision blocks across the whole turn.
  // The last assistant turn may carry its own image-output too (rare today,
  // but Anthropic's vision-out roadmap supports it) - we treat assistant
  // turns the same as user turns for the detect path.
  let totalImageBlocksDetected = 0;
  const allBlocks = [];
  for (const msg of messages.slice(0, VISION_CAPTURE_LIMITS.max_messages)) {
    const det = detectVisionCapture(msg);
    if (!det.is_vision) continue;
    totalImageBlocksDetected += Number(det.total_image_blocks_detected || det.total_images || 0);
    for (const b of det.image_url_blocks) {
      if (allBlocks.length < VISION_CAPTURE_LIMITS.max_image_blocks) allBlocks.push(b);
    }
    for (const b of det.base64_blocks) {
      if (allBlocks.length < VISION_CAPTURE_LIMITS.max_image_blocks) allBlocks.push(b);
    }
  }

  if (allBlocks.length === 0) {
    return {
      ok: true,
      captured: false,
      has_vision: false,
      vision_block_count: 0,
      total_image_blocks_detected: totalImageBlocksDetected,
      version: VISION_CAPTURE_VERSION,
      contract_version: VISION_CAPTURE_CONTRACT_VERSION,
    };
  }

  const normalizedBlocks = [];
  let invalidImageBlockCount = 0;
  for (const block of allBlocks) {
    const norm = normalizeImageBlock(block);
    if (!norm.ok) {
      invalidImageBlockCount += 1;
      continue;
    }
    normalizedBlocks.push(norm);
  }

  if (normalizedBlocks.length === 0) {
    return _errorEnvelope('no_valid_image_blocks', 'no_valid_image_blocks', {
      total_image_blocks_detected: totalImageBlocksDetected,
      invalid_image_block_count: invalidImageBlockCount,
    });
  }

  // Build the canonical capture row. NEVER include raw image bytes - 
  // only the URL strings (if URL-sourced) and the hash digests. The
  // tests verify the persisted row to confirm this invariant holds.
  const responseText = typeof response === 'string'
    ? response
    : ((response && typeof response.text === 'string') ? response.text : null);
  const imageUrls = normalizedBlocks.map((n) => n.url).filter((u) => u != null);
  const imageHashes = normalizedBlocks
    .map((n) => n.url_sha256 || n.content_sha256 || null)
    .filter((h) => h != null);
  const captureRow = {
    id: 'vcap_' + crypto.randomBytes(8).toString('hex'),
    tenant: normalizedTenantId,
    tenant_id: normalizedTenantId, // both keys so W411 defense-in-depth fences fire either way
    corpus_namespace: normalizedNamespace,
    has_vision: true,
    vision_block_count: normalizedBlocks.length,
    total_image_blocks_detected: totalImageBlocksDetected,
    invalid_image_block_count: invalidImageBlockCount,
    truncated_image_block_count: Math.max(0, totalImageBlocksDetected - allBlocks.length),
    vision_block_count_url: normalizedBlocks.filter((n) => n.url).length,
    vision_block_count_base64: normalizedBlocks.filter((n) => n.source === 'base64').length,
    // Only URL strings + hashes go on the row. Raw image bytes are
    // EXPLICITLY DROPPED here. See the test at #10.
    image_urls: imageUrls,
    image_urls_hashed: imageHashes,
    image_kinds: normalizedBlocks.map((n) => _kindFromMime(n.mime_type)),
    response_text: _cleanLooseText(responseText, VISION_CAPTURE_LIMITS.max_response_text_chars),
    created_at: new Date().toISOString(),
    version: VISION_CAPTURE_VERSION,
    contract_version: VISION_CAPTURE_CONTRACT_VERSION,
  };

  // Persist via injected storeMod when present, fall back to capture-store.
  // We DO NOT eagerly import capture-store at module top because the
  // module pulls in the SQLite driver - tests want a thin in-memory fake.
  const storeMod = (opts && opts.storeMod) || null;
  if (storeMod && typeof storeMod.insertCapture === 'function') {
    try {
      await storeMod.insertCapture(captureRow);
    } catch (e) {
      return _errorEnvelope('persist_failed', String(e && e.message || e || 'persist_failed'), {
        hint: 'capture store insert failed',
      });
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
    vision_block_count: captureRow.vision_block_count,
    total_image_blocks_detected: totalImageBlocksDetected,
    invalid_image_block_count: invalidImageBlockCount,
    image_urls_hashed: captureRow.image_urls_hashed,
    persisted_row: captureRow,
    version: VISION_CAPTURE_VERSION,
    contract_version: VISION_CAPTURE_CONTRACT_VERSION,
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
function _sanitizeCaptureRowForList(row) {
  const safeUrls = Array.isArray(row.image_urls)
    ? row.image_urls.map((u) => _safeUrlForEnvelope(u)).filter((u) => u && u.url).map((u) => u.url)
    : [];
  const hashes = Array.isArray(row.image_urls_hashed)
    ? row.image_urls_hashed.filter((h) => typeof h === 'string' && /^[a-f0-9]{24,64}$/i.test(h))
    : [];
  return {
    id: _cleanStrictText(row.id, 96),
    tenant_id: _normalizeTenantId(row.tenant_id || row.tenant),
    corpus_namespace: _normalizeNamespace(row.corpus_namespace),
    has_vision: row.has_vision === true,
    vision_block_count: Math.max(0, Math.min(Number(row.vision_block_count) || 0, VISION_CAPTURE_LIMITS.max_image_blocks)),
    vision_block_count_url: Math.max(0, Math.min(Number(row.vision_block_count_url) || safeUrls.length, VISION_CAPTURE_LIMITS.max_image_blocks)),
    vision_block_count_base64: Math.max(0, Math.min(Number(row.vision_block_count_base64) || 0, VISION_CAPTURE_LIMITS.max_image_blocks)),
    image_urls: safeUrls,
    image_urls_hashed: hashes,
    image_kinds: Array.isArray(row.image_kinds)
      ? row.image_kinds.slice(0, VISION_CAPTURE_LIMITS.max_image_blocks).map((k) => (
        ['photo', 'screenshot', 'diagram', 'chart', 'other'].includes(k) ? k : _kindFromMime(k)
      ))
      : [],
    response_text: _cleanLooseText(row.response_text, VISION_CAPTURE_LIMITS.max_response_text_chars),
    created_at: _cleanStrictText(row.created_at, 64),
    version: _cleanStrictText(row.version, 32) || VISION_CAPTURE_VERSION,
    contract_version: _cleanStrictText(row.contract_version, 64) || VISION_CAPTURE_CONTRACT_VERSION,
  };
}

export function listVisionCaptures({
  tenant_id,
  namespace = null,
  limit = 100,
  opts = {},
} = {}) {
  const normalizedTenantId = _normalizeTenantId(tenant_id);
  if (!normalizedTenantId) {
    return _errorEnvelope('tenant_id_required', 'invalid_tenant_id');
  }
  const normalizedNamespace = namespace == null || namespace === ''
    ? null
    : _normalizeNamespace(namespace);
  if (namespace != null && namespace !== '' && !normalizedNamespace) {
    return _errorEnvelope('invalid_namespace', 'invalid_namespace');
  }
  const storeMod = (opts && opts.storeMod) || null;
  const all = (storeMod && typeof storeMod.all === 'function') ? storeMod.all : null;
  if (!all) {
    return {
      ok: true,
      tenant_id: normalizedTenantId,
      namespace: normalizedNamespace,
      count: 0,
      captures: [],
      version: VISION_CAPTURE_VERSION,
      contract_version: VISION_CAPTURE_CONTRACT_VERSION,
      hint: 'no storeMod wired; pass opts.storeMod to read persisted captures',
    };
  }
  const rawRows = (all('observations') || []).slice(0, VISION_CAPTURE_LIMITS.max_store_rows_scanned);
  // W411: per-row tenant filter even after the all() read. We tolerate
  // tenant being on either `tenant` or `tenant_id` because the canonical
  // observations table uses `tenant` (see daemon-connector.js:675) while
  // the vision capture row stamps both for fence resilience.
  const tenantRows = rawRows.filter((r) =>
    r && (r.tenant === normalizedTenantId || r.tenant_id === normalizedTenantId));
  const visionRows = tenantRows.filter((r) => r && r.has_vision === true);
  const nsFiltered = normalizedNamespace
    ? visionRows.filter((r) => r && r.corpus_namespace === normalizedNamespace)
    : visionRows;
  // Most-recent-first by created_at (string ISO compare is fine for our
  // 24-hex-char-prefix timestamps; the stamp guarantees lexicographic order).
  const sorted = nsFiltered.slice().sort((a, b) => {
    const ta = String(a.created_at || '');
    const tb = String(b.created_at || '');
    return tb.localeCompare(ta);
  });
  const cap = Math.max(1, Math.min(Number(limit) || 100, VISION_CAPTURE_LIMITS.max_list_limit));
  return {
    ok: true,
    tenant_id: normalizedTenantId,
    namespace: normalizedNamespace,
    count: sorted.length,
    captures: sorted.slice(0, cap).map((row) => _sanitizeCaptureRowForList(row)),
    limit: cap,
    version: VISION_CAPTURE_VERSION,
    contract_version: VISION_CAPTURE_CONTRACT_VERSION,
  };
}
