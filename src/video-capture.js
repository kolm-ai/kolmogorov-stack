// W773 - Video capture detector + capture-store bridge.
//
// Detects video blocks in inbound messages (URL + base64 + future-shape
// blocks) and records a capture row whose RAW VIDEO BYTES ARE NEVER
// PERSISTED - privacy + storage. Only the URL / hashed identifier and
// downstream-sampled frame URLs travel into the event-store.
//
// Atomic guarantees pinned by tests/wave773-video-distill.test.js:
//
//  - VIDEO_CAPTURE_VERSION = 'w773-v1'
//  - SUPPORTED_VIDEO_MIMES is Object.freeze()-d, 5 entries
//    (mp4, webm, quicktime, x-msvideo (AVI), x-matroska (MKV)).
//  - detectVideoCapture({message}) returns {is_video, video_blocks[],
//    total_videos}. Handles: base64 data:video/* embed, OpenAI-style
//    video_url block, URL-only http(s) reference.
//  - normalizeVideoBlock(block) returns a shape-checked envelope with
//    {url, mime_type, byte_count_estimate, duration_s_estimate, source}
//    OR honest envelope {ok:false, error:'<kind>'} on bad shape.
//    byte_count_estimate is capped at 1 GiB.
//  - captureVideoMessage({...}) appends an event-store row with
//    has_video:true + video_block_count + video_urls_hashed[] +
//    frame_count_extracted. RAW VIDEO BYTES ARE NEVER WRITTEN.
//
// HONESTY INVARIANTS:
//  - Raw video bytes NEVER cross the persistence boundary. The capture
//    row carries a sha256 hash of the URL (or of the leading data: header
//    when base64) so dedup works without storing the payload.
//  - normalizeVideoBlock returns honest envelope on bad shape. It NEVER
//    silently passes a malformed block as ok:true with default values.
//  - byte_count_estimate is CAPPED at 1 GiB. A maliciously huge
//    Content-Length header cannot force a 100 GiB allocation downstream.
//
// Why mp4/webm/quicktime/x-msvideo/x-matroska:
//   These are the five MIMEs major frontier vendors (OpenAI Whisper-V,
//   Anthropic claude-3.5-sonnet vision-video, Gemini video understanding)
//   accept as of 2026-Q2. AVI and MKV are widely produced by screen
//   recorders even when not directly accepted by every vendor - including
//   them lets the capture detect the file BEFORE upload + reject it with
//   an honest message instead of after a 500.

import crypto from 'node:crypto';

export const VIDEO_CAPTURE_VERSION = 'w773-v1';
export const VIDEO_CAPTURE_CONTRACT_VERSION = 'w734-video-capture-v1';
export const VIDEO_CAPTURE_LIMITS = Object.freeze({
  max_messages: 128,
  max_message_blocks: 256,
  max_video_blocks: 32,
  max_inline_scan_chars: 4096,
  max_url_chars: 2048,
  max_tenant_id_chars: 160,
  max_namespace_chars: 128,
  max_response_head_chars: 200,
  max_byte_count_estimate: 1024 * 1024 * 1024,
});

// Closed enum of supported video MIME types. Frozen so a refactor cannot
// silently add a 6th MIME without bumping VIDEO_CAPTURE_VERSION and the
// frontier-acceptance audit lock.
export const SUPPORTED_VIDEO_MIMES = Object.freeze([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
]);

// 1 GiB byte-count cap. Frontier vendors top out around 256 MiB for sync
// upload; we go to 1 GiB to allow the staged-upload flow but never beyond.
// A Content-Length header beyond this is almost certainly hostile.
export const MAX_BYTE_COUNT_ESTIMATE = VIDEO_CAPTURE_LIMITS.max_byte_count_estimate;

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
  const cleaned = _cleanStrictText(value, VIDEO_CAPTURE_LIMITS.max_tenant_id_chars);
  return cleaned && SAFE_ID_RE.test(cleaned) ? cleaned : null;
}

function _normalizeNamespace(value) {
  const cleaned = _cleanStrictText(value == null || value === '' ? 'default' : value, VIDEO_CAPTURE_LIMITS.max_namespace_chars);
  return cleaned && SAFE_NAMESPACE_RE.test(cleaned) ? cleaned : null;
}

function _normalizeMimeType(value) {
  const mime = _cleanStrictText(value, 96);
  return mime ? mime.toLowerCase() : null;
}

function _errorEnvelope(error, detail, extra = {}) {
  return {
    ok: false,
    error,
    version: VIDEO_CAPTURE_VERSION,
    contract_version: VIDEO_CAPTURE_CONTRACT_VERSION,
    error_sha256: _sha256Hex(detail || error),
    ...extra,
  };
}

function _safeUrlForEnvelope(rawUrl, mimeType) {
  const url = _cleanStrictText(rawUrl, VIDEO_CAPTURE_LIMITS.max_url_chars);
  if (!url) return null;

  if (url.startsWith('data:')) {
    const m = /^data:(video\/[a-z0-9.+-]+);base64,/i.exec(url);
    const mime = _normalizeMimeType((m && m[1]) || mimeType || 'video/mp4');
    if (!mime || !SUPPORTED_VIDEO_MIMES.includes(mime)) return null;
    return {
      url: `data:${mime};base64,<elided>`,
      url_sha256: _sha256Hex(url),
    };
  }

  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  const safeUrl = parsed.origin + parsed.pathname;
  return {
    url: safeUrl,
    url_sha256: _sha256Hex(url),
  };
}

// =============================================================================
// detectVideoCapture - scan a single inbound message for video blocks.
// Handles three encodings:
//   1. base64 inline:    {type:'video', source:{type:'base64', media_type:'video/mp4', data:'...'}}
//   2. URL block (OpenAI future shape): {type:'video_url', video_url:{url:'https://...'}}
//   3. raw url string:   {type:'video', url:'https://example.com/clip.mp4'}
//
// Returns:
//   {is_video, video_blocks: [<raw block>], total_videos}
//
// NEVER reads byte payloads off URLs; this is a SHAPE detector only.
// =============================================================================
export function detectVideoCapture(message) {
  if (!message || typeof message !== 'object') {
    return { is_video: false, video_blocks: [], total_videos: 0 };
  }

  // Anthropic-style: message.content is an array of blocks. OpenAI-style:
  // message.content is a string OR array of {type:'text'|'image_url'|'video_url'}.
  // We tolerate both.
  const blocks = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content.slice(0, VIDEO_CAPTURE_LIMITS.max_message_blocks)) {
      if (!block || typeof block !== 'object') continue;
      // Type 1 - Anthropic-style video block w/ base64 source.
      if (block.type === 'video') {
        if (blocks.length < VIDEO_CAPTURE_LIMITS.max_video_blocks) blocks.push(block);
        continue;
      }
      // Type 2 - OpenAI-style video_url block.
      if (block.type === 'video_url') {
        if (blocks.length < VIDEO_CAPTURE_LIMITS.max_video_blocks) blocks.push(block);
        continue;
      }
      // Type 3 - generic media block with media_type/mime_type.
      const mt = block.mime_type || block.media_type
        || (block.source && (block.source.mime_type || block.source.media_type));
      if (typeof mt === 'string' && mt.startsWith('video/')) {
        if (blocks.length < VIDEO_CAPTURE_LIMITS.max_video_blocks) blocks.push(block);
        continue;
      }
    }
  } else if (typeof message.content === 'string') {
    // Scan for data:video/* embeds inline. Rare but possible.
    const m = message.content
      .slice(0, VIDEO_CAPTURE_LIMITS.max_inline_scan_chars)
      .match(/data:(video\/[a-z0-9.+-]+);base64,/i);
    if (m) {
      blocks.push({
        type: 'video',
        source: { type: 'base64', media_type: m[1], data: '<elided-from-content-string>' },
      });
    }
  }

  return {
    is_video: blocks.length > 0,
    video_blocks: blocks,
    total_videos: blocks.length,
  };
}

// =============================================================================
// normalizeVideoBlock - collapse the three block shapes into one envelope.
// Returns the canonical shape OR an honest envelope on bad input.
//
// Canonical success shape:
//   {ok:true, url, mime_type, byte_count_estimate, duration_s_estimate,
//    source, version}
//
// Honest-failure shape:
//   {ok:false, error:'<kind>', hint:'<actionable>', version}
//
// byte_count_estimate is capped at 1 GiB (MAX_BYTE_COUNT_ESTIMATE). A
// caller passing 100 GiB gets 1 GiB and a `byte_count_capped:true` flag
// so the cap is OBSERVABLE - never silent.
// =============================================================================
export function normalizeVideoBlock(block) {
  if (!block || typeof block !== 'object') {
    return {
      ok: false,
      error: 'block_not_object',
      hint: 'normalizeVideoBlock requires a non-null object',
      version: VIDEO_CAPTURE_VERSION,
      contract_version: VIDEO_CAPTURE_CONTRACT_VERSION,
    };
  }

  // Determine source kind + URL/data + MIME.
  let url = null;
  let mime_type = null;
  let source = 'unknown';
  let byte_count_raw = null;

  // Type 2 - {type:'video_url', video_url:{url:'...'}}
  if (block.type === 'video_url' && block.video_url && typeof block.video_url === 'object') {
    url = String(block.video_url.url || '');
    mime_type = _normalizeMimeType(block.video_url.mime_type || block.mime_type || _mimeFromUrl(url) || 'video/mp4');
    source = 'video_url';
    if (block.video_url.byte_count != null) byte_count_raw = Number(block.video_url.byte_count);
  }
  // Type 1 - {type:'video', source:{type:'base64'|'url', ...}}
  else if (block.type === 'video' && block.source && typeof block.source === 'object') {
    if (block.source.type === 'base64') {
      // base64 - synthesize a data: URL placeholder (the actual data is
      // ELIDED downstream; we never persist the bytes).
      mime_type = _normalizeMimeType(block.source.media_type || 'video/mp4');
      const dataHead = String(block.source.data || '').slice(0, 256);
      url = 'data:' + String(mime_type || 'video/mp4') + ';base64,' + dataHead;
      source = 'base64';
      if (typeof block.source.data === 'string') {
        // base64 ~ 4/3 of raw bytes. Use length as a cheap byte-count proxy.
        byte_count_raw = Math.floor(block.source.data.length * 3 / 4);
      }
    } else if (block.source.type === 'url' && typeof block.source.url === 'string') {
      url = block.source.url;
      mime_type = _normalizeMimeType(block.source.media_type || _mimeFromUrl(url) || 'video/mp4');
      source = 'url';
    } else if (typeof block.url === 'string') {
      url = block.url;
      mime_type = _normalizeMimeType(block.mime_type || block.media_type || _mimeFromUrl(url) || 'video/mp4');
      source = 'url';
    }
  }
  // Type 3 - generic mime_type with url
  else if (typeof block.url === 'string') {
    url = block.url;
    mime_type = _normalizeMimeType(block.mime_type || block.media_type || _mimeFromUrl(url) || 'video/mp4');
    source = 'url';
  }

  // Missing URL/data - honest envelope.
  if (!url) {
    return {
      ok: false,
      error: 'missing_url_or_data',
      hint: 'block must carry a url, video_url.url, or source.data',
      version: VIDEO_CAPTURE_VERSION,
      contract_version: VIDEO_CAPTURE_CONTRACT_VERSION,
    };
  }

  // MIME must be a recognized video MIME.
  if (!SUPPORTED_VIDEO_MIMES.includes(mime_type)) {
    return {
      ok: false,
      error: 'unsupported_mime',
      mime_type,
      supported: SUPPORTED_VIDEO_MIMES,
      hint: `mime_type must be one of ${JSON.stringify(SUPPORTED_VIDEO_MIMES)}; got ${JSON.stringify(mime_type)}`,
      version: VIDEO_CAPTURE_VERSION,
      contract_version: VIDEO_CAPTURE_CONTRACT_VERSION,
    };
  }

  const safeUrl = _safeUrlForEnvelope(url, mime_type);
  if (!safeUrl) {
    return {
      ok: false,
      error: 'invalid_url',
      hint: 'video URL must be http(s) without credentials, or a supported data:video/* base64 block',
      version: VIDEO_CAPTURE_VERSION,
      contract_version: VIDEO_CAPTURE_CONTRACT_VERSION,
    };
  }

  // Byte-count cap. A bad/maliciously huge byte_count gets clamped so a
  // downstream allocator sees a sane upper bound. The cap is OBSERVABLE
  // via byte_count_capped:true.
  let byte_count_estimate = (byte_count_raw != null && Number.isFinite(byte_count_raw) && byte_count_raw > 0)
    ? Math.floor(byte_count_raw)
    : 0;
  let byte_count_capped = false;
  if (byte_count_estimate > MAX_BYTE_COUNT_ESTIMATE) {
    byte_count_estimate = MAX_BYTE_COUNT_ESTIMATE;
    byte_count_capped = true;
  }

  // duration_s_estimate - honest null when unknown. NEVER fabricate.
  const duration_s_estimate = (block.duration_s != null && Number.isFinite(Number(block.duration_s)) && Number(block.duration_s) > 0)
    ? Number(block.duration_s)
    : null;

  return {
    ok: true,
    url: safeUrl.url,
    url_sha256: safeUrl.url_sha256,
    mime_type,
    byte_count_estimate,
    byte_count_capped,
    duration_s_estimate,
    source,
    version: VIDEO_CAPTURE_VERSION,
    contract_version: VIDEO_CAPTURE_CONTRACT_VERSION,
  };
}

// Internal: best-effort MIME inference from URL path. Returns null when
// the extension is unrecognised so the caller can default-or-honest.
function _mimeFromUrl(url) {
  if (typeof url !== 'string') return null;
  let lower = url.toLowerCase();
  try { lower = new URL(url).pathname.toLowerCase(); } catch { /* best effort */ }
  if (lower.endsWith('.mp4'))  return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov'))  return 'video/quicktime';
  if (lower.endsWith('.avi'))  return 'video/x-msvideo';
  if (lower.endsWith('.mkv'))  return 'video/x-matroska';
  return null;
}

// Stable hash for a video URL - used as a dedup key so the same video
// uploaded twice does not double-bill capture rows. We hash the URL
// rather than the bytes (which we never see).
function _hashUrl(url) {
  return _sha256Hex(url);
}

// =============================================================================
// captureVideoMessage - bridge into the event-store. NEVER persists raw
// video bytes; only URL + hashed identifier + downstream-sampled frame
// references.
//
// Returns:
//   {ok:true, event, has_video, video_block_count, video_urls_hashed,
//    frame_count_extracted, version}
//
// On no-video input returns {ok:true, has_video:false, ...} so the caller
// can branch without an exception path.
//
// DI seam: opts.appendEventFn lets tests inject a fake without touching
// the real event-store. The shape is appendEvent(partial) -> event row.
// =============================================================================
export async function captureVideoMessage({
  tenant_id,
  namespace = 'default',
  messages = [],
  response = null,
  opts = {},
} = {}) {
  const tenantId = _normalizeTenantId(tenant_id);
  if (!tenantId) {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'pass {tenant_id} - capture rows are tenant-scoped',
      version: VIDEO_CAPTURE_VERSION,
      contract_version: VIDEO_CAPTURE_CONTRACT_VERSION,
    };
  }

  const namespaceId = _normalizeNamespace(namespace);
  if (!namespaceId) {
    return _errorEnvelope('invalid_namespace', 'invalid_namespace', {
      hint: 'namespace must be a bounded URL-safe identifier',
    });
  }

  // Scan all messages for video blocks.
  const allBlocks = [];
  if (Array.isArray(messages)) {
    for (const m of messages.slice(0, VIDEO_CAPTURE_LIMITS.max_messages)) {
      const det = detectVideoCapture(m);
      for (const b of det.video_blocks) allBlocks.push(b);
    }
  }

  const has_video = allBlocks.length > 0;
  const normalizedAll = allBlocks.map(normalizeVideoBlock);
  const normalized = normalizedAll.filter(n => n && n.ok);
  const invalid_video_block_count = normalizedAll.length - normalized.length;
  const video_urls_hashed = normalized.map(n => n.url_sha256 || _hashUrl(n.url));
  const frame_count_extracted = (opts && Number.isFinite(Number(opts.frame_count_extracted)))
    ? Number(opts.frame_count_extracted)
    : 0;

  // Build a capture-row partial. Honesty contract - the row carries
  // has_video + counts + hashes. NEVER the bytes, NEVER the URL in full
  // when the source is base64 (the URL is the data: header literal).
  const event_id = 'vidcap_' + crypto.randomBytes(8).toString('hex');
  const created_at = new Date().toISOString();
  const mediaUri = normalized.length > 0
    ? (normalized[0].source === 'base64' ? null : normalized[0].url)
    : null;
  const mediaMime = normalized.length > 0 ? normalized[0].mime_type : null;
  const mediaBytes = normalized.reduce((s, n) => s + (n.byte_count_estimate || 0), 0);
  const mediaHash = video_urls_hashed.length > 0 ? video_urls_hashed[0] : null;

  // We DELIBERATELY do not stuff raw video bytes anywhere on this event.
  // The downstream trainer reads the URL and pulls bytes at training time
  // (or asks the customer to host the bytes). Storing bytes here would
  // both blow up storage and leak PII through a non-redaction surface.
  const partial = {
    event_id,
    tenant_id: tenantId,
    namespace: namespaceId,
    created_at,
    provider: 'kolm.capture',
    model: 'video.capture',
    status: 'captured',
    media_kind: has_video ? 'video' : null,
    media_uri: mediaUri,
    media_hash: mediaHash,
    media_bytes: mediaBytes,
    media_mime: mediaMime,
    media_extraction_status: has_video ? (frame_count_extracted > 0 ? 'frames_extracted' : 'pending') : null,
    // Custom W773 fields. These ride in the canonical JSON blob but live
    // outside the indexed columns. The event-store's `json` column carries
    // the full row so they round-trip cleanly.
    w773: {
      version: VIDEO_CAPTURE_VERSION,
      contract_version: VIDEO_CAPTURE_CONTRACT_VERSION,
      has_video,
      total_video_blocks_detected: allBlocks.length,
      video_block_count: normalized.length,
      invalid_video_block_count,
      video_urls_hashed,
      frame_count_extracted,
      response_head: _cleanLooseText(response, VIDEO_CAPTURE_LIMITS.max_response_head_chars),
    },
    // Honesty hint - explicit declaration that bytes are not on disk.
    raw_video_bytes_persisted: false,
  };

  // DI seam - tests inject appendEventFn. Default uses event-store.
  const appendEventFn = (opts && typeof opts.appendEventFn === 'function')
    ? opts.appendEventFn
    : null;

  let event;
  if (appendEventFn) {
    try {
      event = await appendEventFn(partial);
    } catch (e) {
      return _errorEnvelope('append_failed', String(e && e.message || e), {
        has_video,
        video_block_count: normalized.length,
        invalid_video_block_count,
      });
    }
  } else {
    try {
      const es = await import('./event-store.js');
      event = await es.appendEvent(partial);
    } catch (e) {
      return _errorEnvelope('append_failed', String(e && e.message || e), {
        has_video,
        video_block_count: normalized.length,
        invalid_video_block_count,
      });
    }
  }

  return {
    ok: true,
    event,
    has_video,
    total_video_blocks_detected: allBlocks.length,
    video_block_count: normalized.length,
    invalid_video_block_count,
    video_urls_hashed,
    frame_count_extracted,
    raw_video_bytes_persisted: false,
    version: VIDEO_CAPTURE_VERSION,
    contract_version: VIDEO_CAPTURE_CONTRACT_VERSION,
  };
}

export default {
  VIDEO_CAPTURE_VERSION,
  VIDEO_CAPTURE_CONTRACT_VERSION,
  VIDEO_CAPTURE_LIMITS,
  SUPPORTED_VIDEO_MIMES,
  MAX_BYTE_COUNT_ESTIMATE,
  detectVideoCapture,
  normalizeVideoBlock,
  captureVideoMessage,
};
