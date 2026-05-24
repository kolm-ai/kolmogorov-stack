// W772 - audio capture primitives.
//
// Closes W772-2 from KOLM_W707_SYSTEM_UPGRADE_PLAN.md (line 630):
//
//   W772-2: "Capture audio inputs (whisper transcript -> teacher response)"
//
// Sister modules:
//   * src/rag-capture.js          (W734 - retrieved-context capture)
//   * src/tool-use-capture.js     (W735 - tool-call capture)
//   * src/audio-bakeoff.js        (W772-3 - audio bakeoff harness)
//   * apps/trainer/audio_distill.py (W772-1 - trainer entrypoint)
//
// Design contract (W411 + W604 + W772 honesty invariants):
//
//   * Multi-vendor: parse OpenAI `content[].type === 'input_audio'`,
//     Anthropic future-shape audio blocks, base64 `data:audio/*;base64,...`
//     data URLs, and pre-transcribed `whisper_transcript` fields. Returns
//     a normalised envelope so downstream consumers never branch on the
//     upstream vendor.
//
//   * HONESTY INVARIANT: captureAudioMessage NEVER persists raw audio
//     bytes. We hash the audio URL/base64 head so the same clip
//     deduplicates across captures, but the raw audio NEVER lands in the
//     observation row. Privacy law: voice fingerprints are PII under
//     GDPR / CPRA, the only durable artefact the capture row keeps is
//     the (transcript_text, audio_urls_hashed) tuple.
//
//   * HONESTY INVARIANT: extractWhisperTranscript NEVER fabricates a
//     transcript. If the message has no whisper_transcript field and no
//     pre-transcribed content block, it returns null. The downstream
//     consumer (audio_distill.py or the W772 bakeoff harness) must
//     synthesise the transcript via openai-whisper at distill time, not
//     here at capture time (we keep capture cheap + pure).
//
//   * Additive: when a message has no audio fields, detectAudioCapture
//     returns {is_audio:false} and the capture row continues down the
//     legacy text-only path. Nothing about W772 breaks existing capture
//     flows.
//
// Public surface:
//
//   AUDIO_CAPTURE_VERSION
//   SUPPORTED_AUDIO_MIMES
//   detectAudioCapture(message)
//   normalizeAudioBlock(block)
//   extractWhisperTranscript(message)
//   captureAudioMessage({tenant_id, namespace, messages, response, opts})

import crypto from 'node:crypto';

export const AUDIO_CAPTURE_VERSION = 'w772-v1';

// Supported audio MIME types. Frozen so a refactor cannot push a new mime
// (e.g. webrtc-opus) and silently pass shape validation without bumping
// AUDIO_CAPTURE_VERSION. The 7 entries cover every audio shape both major
// chat providers accept on the inbound side as of 2026-05.
export const SUPPORTED_AUDIO_MIMES = Object.freeze([
  'audio/wav',
  'audio/mp3',
  'audio/mpeg',
  'audio/flac',
  'audio/ogg',
  'audio/webm',
  'audio/m4a',
]);

// Hard cap on the byte_count we surface in normalizeAudioBlock. Clamping
// at 100 MiB defends downstream UI panels from rendering a 4 GiB
// hex-counter when an operator points the wrapper at a long-form podcast
// capture by accident.
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

// Largest data-URL string we will inspect. Beyond this we still surface
// the block honestly but cap the duration estimate at the conservative
// upper bound so we never claim to have decoded a 10-hour file.
const MAX_DATA_URL_CHARS = 200 * 1024 * 1024;

// Sample rate we assume for the duration estimate when only the byte
// count is known. 16 kHz mono 16-bit PCM = 32 kB/s, which is the worst-
// case bitrate for the formats we accept. Conservative on purpose: we
// would rather under-estimate duration than over-promise.
const FALLBACK_BYTES_PER_SECOND = 32 * 1024;

// Cap on transcript length stamped on the capture row. Longer transcripts
// are truncated with `transcript_truncated:true` so the operator can see
// the harness clipped the text instead of silently passing the full
// 4-million-char blob into the event-store.
const MAX_TRANSCRIPT_CHARS = 128 * 1024;

// =============================================================================
// detectAudioCapture
// =============================================================================

/**
 * Inspect a chat message for audio inputs.
 *
 * Returns:
 *
 *   {
 *     is_audio:            Boolean,   // any audio detected?
 *     audio_blocks:        Array,     // normalized {url|base64,mime,...}
 *     transcript_present:  Boolean,   // pre-transcribed whisper field?
 *     total_audio:         Number,    // length of audio_blocks
 *   }
 *
 * The shape priority (first match wins per block):
 *
 *   1) OpenAI `content[].type === 'input_audio'` with
 *      `input_audio: {data: <base64>, format: 'wav'|'mp3'|...}`.
 *
 *   2) Anthropic future audio block:
 *      `content[].type === 'audio'` with `source: {type:'base64'|'url', ...}`.
 *
 *   3) Any string content with a leading `data:audio/<subtype>;base64,...`
 *      data URL. We treat the data URL itself as the block.
 *
 *   4) A `whisper_transcript` field on the message - flagged via
 *      `transcript_present:true` even when no audio block is present
 *      (live transcription already happened upstream).
 *
 * Never throws; pathological inputs return the empty envelope. The
 * downstream consumer is the wrapper-mode capture path which folds the
 * detection result onto the capture row.
 */
export function detectAudioCapture(message) {
  const empty = { is_audio: false, audio_blocks: [], transcript_present: false, total_audio: 0 };
  if (!message || typeof message !== 'object') return empty;

  const blocks = [];
  const content = message.content;

  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;

      // ----- 1) OpenAI input_audio shape -----
      if (item.type === 'input_audio' && item.input_audio && typeof item.input_audio === 'object') {
        const fmt = String(item.input_audio.format || '').toLowerCase();
        const data = String(item.input_audio.data || '');
        if (data) {
          blocks.push({
            kind: 'openai_input_audio',
            mime: _mimeFromFormat(fmt),
            base64: data,
            format: fmt || null,
          });
        }
        continue;
      }

      // ----- 2) Anthropic future audio block -----
      if (item.type === 'audio' && item.source && typeof item.source === 'object') {
        const src = item.source;
        if (src.type === 'base64' && src.data) {
          blocks.push({
            kind: 'anthropic_audio_base64',
            mime: String(src.media_type || src.mime_type || '').toLowerCase() || 'audio/wav',
            base64: String(src.data),
            format: null,
          });
        } else if (src.type === 'url' && src.url) {
          blocks.push({
            kind: 'anthropic_audio_url',
            mime: String(src.media_type || src.mime_type || '').toLowerCase() || _mimeFromUrl(String(src.url)),
            url: String(src.url),
            format: null,
          });
        }
        continue;
      }

      // ----- 3) data:audio/...;base64,... in a text content block -----
      if (typeof item.text === 'string' && /^data:audio\//i.test(item.text.trim())) {
        const dataUrl = item.text.trim();
        const mime = _mimeFromDataUrl(dataUrl);
        if (mime) {
          blocks.push({
            kind: 'data_url',
            mime,
            data_url: dataUrl.slice(0, MAX_DATA_URL_CHARS),
            format: null,
          });
        }
      }
    }
  }

  // ----- 3b) data URL in a top-level string content (shorthand) -----
  if (typeof content === 'string' && /^data:audio\//i.test(content.trim())) {
    const dataUrl = content.trim();
    const mime = _mimeFromDataUrl(dataUrl);
    if (mime) {
      blocks.push({
        kind: 'data_url',
        mime,
        data_url: dataUrl.slice(0, MAX_DATA_URL_CHARS),
        format: null,
      });
    }
  }

  // ----- 4) whisper_transcript field on the message -----
  const transcript = extractWhisperTranscript(message);
  const transcript_present = transcript != null && String(transcript).trim() !== '';

  return {
    is_audio: blocks.length > 0 || transcript_present,
    audio_blocks: blocks,
    transcript_present,
    total_audio: blocks.length,
  };
}

// =============================================================================
// normalizeAudioBlock
// =============================================================================

/**
 * Normalize a detectAudioCapture block into a shape consumable by the
 * W772 capture wrappers and trainer harness.
 *
 * Returns one of:
 *
 *   {
 *     url:                  String | null,
 *     mime_type:            String,
 *     byte_count_estimate:  Number,    // capped at MAX_AUDIO_BYTES (100 MiB)
 *     duration_s_estimate:  Number,    // conservative upper bound
 *     source:               'url' | 'base64' | 'unknown',
 *     transcript:           String | null,
 *   }
 *
 * or, on a bad input shape:
 *
 *   { ok: false, error: 'invalid_audio_block', hint: '...' }
 *
 * NEVER throws. The 100 MiB cap is enforced even when the operator
 * supplies a larger block (we surface the cap + a `truncated_estimate`
 * flag so the operator sees the harness limited the reported size).
 */
export function normalizeAudioBlock(block) {
  if (!block || typeof block !== 'object') {
    return {
      ok: false,
      error: 'invalid_audio_block',
      hint: 'block must be an object returned by detectAudioCapture()',
    };
  }
  const mime = String(block.mime || block.mime_type || '').toLowerCase();
  if (!mime || !SUPPORTED_AUDIO_MIMES.includes(mime)) {
    return {
      ok: false,
      error: 'invalid_audio_block',
      hint: `mime ${JSON.stringify(mime)} not in SUPPORTED_AUDIO_MIMES (${SUPPORTED_AUDIO_MIMES.join(',')})`,
    };
  }

  let url = null;
  let source = 'unknown';
  let raw_bytes = 0;

  if (typeof block.url === 'string' && block.url) {
    url = block.url;
    source = 'url';
    // We do not fetch the URL here - byte_count_estimate stays 0 for the
    // url branch. The downstream trainer is responsible for HEAD-probing
    // the URL (W772-1 audio_distill.py).
    raw_bytes = 0;
  } else if (typeof block.base64 === 'string' && block.base64) {
    source = 'base64';
    // Base64 expands ~4 chars -> 3 bytes; the trailing padding is at most
    // 2 chars so the byte count is floor(len * 3 / 4).
    const raw = block.base64.replace(/=+$/, '');
    raw_bytes = Math.floor((raw.length * 3) / 4);
  } else if (typeof block.data_url === 'string' && block.data_url) {
    source = 'base64';
    const idx = block.data_url.indexOf('base64,');
    if (idx >= 0) {
      const tail = block.data_url.slice(idx + 'base64,'.length).replace(/=+$/, '');
      raw_bytes = Math.floor((tail.length * 3) / 4);
    }
  }

  // Apply the 100 MiB cap. Stamp a `truncated_estimate` flag so the
  // operator can see the harness clamped the byte count.
  let byte_count_estimate = raw_bytes;
  let truncated_estimate = false;
  if (byte_count_estimate > MAX_AUDIO_BYTES) {
    byte_count_estimate = MAX_AUDIO_BYTES;
    truncated_estimate = true;
  }

  const duration_s_estimate = byte_count_estimate > 0
    ? Math.round((byte_count_estimate / FALLBACK_BYTES_PER_SECOND) * 100) / 100
    : 0;

  return {
    url,
    mime_type: mime,
    byte_count_estimate,
    duration_s_estimate,
    source,
    transcript: typeof block.transcript === 'string' ? block.transcript : null,
    truncated_estimate,
  };
}

// =============================================================================
// extractWhisperTranscript
// =============================================================================

/**
 * Pull a pre-transcribed transcript off a message.
 *
 * Priority order (first match wins):
 *
 *   1) `message.whisper_transcript` field (most explicit)
 *   2) `message.transcript` field
 *   3) `content[].type === 'transcript'` block with `text` payload
 *
 * Returns the transcript string when present + non-empty; returns `null`
 * when no transcript is found. NEVER fabricates a transcript - the W772
 * trainer is the only place where openai-whisper actually runs.
 */
export function extractWhisperTranscript(message) {
  if (!message || typeof message !== 'object') return null;
  // 1) explicit whisper_transcript field
  if (typeof message.whisper_transcript === 'string' && message.whisper_transcript.trim() !== '') {
    return message.whisper_transcript;
  }
  // 2) generic transcript field (some wrappers normalise this name)
  if (typeof message.transcript === 'string' && message.transcript.trim() !== '') {
    return message.transcript;
  }
  // 3) content[].type === 'transcript'
  const content = message.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'transcript') {
        const text = item.text || item.transcript || null;
        if (typeof text === 'string' && text.trim() !== '') return text;
      }
    }
  }
  return null;
}

// =============================================================================
// captureAudioMessage  (P0 chokepoint)
// =============================================================================

/**
 * Capture a chat message with audio inputs into the tenant-fenced
 * observation store.
 *
 * Args:
 *   tenant_id   - canonical tenant id (W411 fence)
 *   namespace   - corpus namespace (sanitized upstream)
 *   messages    - array of OpenAI/Anthropic-shape chat messages
 *   response    - upstream response body (string OR object)
 *   opts        - DI seam: { storeMod, eventStore, now } - test seam
 *
 * Returns the persisted row envelope:
 *
 *   {
 *     ok:                    Boolean,
 *     has_audio:             Boolean,
 *     audio_block_count:     Number,
 *     transcript_chars:      Number,
 *     transcript_present:    Boolean,
 *     audio_urls_hashed:     Array<String>,   // sha256 hex of each URL/data:
 *     row_id:                String | null,
 *     version:               String,
 *   }
 *
 * P0 INVARIANTS:
 *   * NEVER persists raw audio bytes. Only the URL (when remote) +
 *     transcript text + sha256(URL) are stamped on the persisted row.
 *   * Always tenant-fenced via the tenant_id arg (the persisted row
 *     carries tenant=tenant_id; downstream reads must filter on it).
 *   * Honest envelope when no audio is detected
 *     (has_audio:false, audio_block_count:0, row_id:null).
 */
export async function captureAudioMessage(args) {
  const a = args || {};
  const tenant_id = a.tenant_id;
  const namespace = a.namespace || 'default';
  const messages = Array.isArray(a.messages) ? a.messages : [];
  const response = a.response;
  const opts = a.opts || {};

  if (!tenant_id) {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'pass {tenant_id: req.tenant_record.id, ...}',
      has_audio: false,
      audio_block_count: 0,
      transcript_chars: 0,
      transcript_present: false,
      audio_urls_hashed: [],
      row_id: null,
      version: AUDIO_CAPTURE_VERSION,
    };
  }

  let audio_blocks = [];
  let transcript_present = false;
  let transcript = '';
  let audio_urls_hashed = [];

  for (const msg of messages) {
    const det = detectAudioCapture(msg);
    if (!det.is_audio) continue;
    for (const block of det.audio_blocks) {
      const norm = normalizeAudioBlock(block);
      if (!norm || norm.ok === false) continue;
      audio_blocks.push(norm);
      // Privacy: hash the URL (or data-URL head) so the same clip
      // deduplicates across captures WITHOUT persisting the raw bytes.
      const hash_seed = norm.url
        || (typeof block.data_url === 'string' ? block.data_url.slice(0, 256) : null)
        || (typeof block.base64 === 'string' ? block.base64.slice(0, 256) : '');
      const h = crypto.createHash('sha256').update(String(hash_seed)).digest('hex');
      audio_urls_hashed.push(h);
    }
    if (det.transcript_present) {
      transcript_present = true;
      const t = extractWhisperTranscript(msg);
      if (t) {
        transcript += (transcript ? '\n' : '') + String(t);
      }
    }
  }

  // Apply the transcript char cap. Stamp transcript_truncated when we
  // clipped so the consumer can tell the harness limited the persisted
  // text.
  let transcript_truncated = false;
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
    transcript_truncated = true;
  }

  const has_audio = audio_blocks.length > 0 || transcript_present;
  if (!has_audio) {
    return {
      ok: true,
      has_audio: false,
      audio_block_count: 0,
      transcript_chars: 0,
      transcript_present: false,
      audio_urls_hashed: [],
      row_id: null,
      version: AUDIO_CAPTURE_VERSION,
    };
  }

  // Persist via DI store seam. We default to the canonical event-store
  // so the row participates in the same lake the rest of the wrapper
  // captures land in. Pure additive - the bridge is best-effort and
  // failure NEVER throws (we surface it on the envelope).
  let row_id = null;
  let persist_error = null;
  try {
    const eventStoreMod = opts.eventStore
      || (opts.storeMod && opts.storeMod.eventStore)
      || (await import('./event-store.js'));
    if (eventStoreMod && typeof eventStoreMod.appendEvent === 'function') {
      const ev = await eventStoreMod.appendEvent({
        tenant_id,
        namespace,
        provider: 'audio-capture',
        model: 'whisper-transcribed',
        status: 'ok',
        media_kind: 'audio',
        // PRIVACY P0: never persist raw audio bytes. Only the transcript
        // text + the URL hash. media_uri intentionally null - we hash
        // the URL into the payload instead.
        media_uri: null,
        media_hash: audio_urls_hashed[0] || null,
        media_bytes: audio_blocks.reduce((s, b) => s + (b.byte_count_estimate || 0), 0),
        media_mime: audio_blocks[0] && audio_blocks[0].mime_type || null,
        prompt_head: transcript.slice(0, 400),
        response_head: _extractResponseHead(response),
        // Audio-specific structured payload. The trainer + bakeoff
        // harness key on these field names.
        audio_block_count: audio_blocks.length,
        transcript_chars: transcript.length,
        transcript_present,
        transcript_truncated,
        audio_urls_hashed,
        audio_capture_version: AUDIO_CAPTURE_VERSION,
      });
      row_id = (ev && ev.event_id) || null;
    }
  } catch (e) {
    persist_error = String(e && e.message || e);
  }

  return {
    ok: persist_error == null,
    has_audio: true,
    audio_block_count: audio_blocks.length,
    transcript_chars: transcript.length,
    transcript_present,
    transcript_truncated,
    audio_urls_hashed,
    row_id,
    persist_error,
    version: AUDIO_CAPTURE_VERSION,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

function _mimeFromFormat(fmt) {
  switch (String(fmt || '').toLowerCase()) {
    case 'wav': return 'audio/wav';
    case 'mp3': return 'audio/mp3';
    case 'mpeg': return 'audio/mpeg';
    case 'flac': return 'audio/flac';
    case 'ogg': return 'audio/ogg';
    case 'webm': return 'audio/webm';
    case 'm4a': return 'audio/m4a';
    default: return 'audio/wav';
  }
}

function _mimeFromUrl(url) {
  const u = String(url || '').toLowerCase();
  if (u.endsWith('.wav')) return 'audio/wav';
  if (u.endsWith('.mp3')) return 'audio/mp3';
  if (u.endsWith('.flac')) return 'audio/flac';
  if (u.endsWith('.ogg')) return 'audio/ogg';
  if (u.endsWith('.webm')) return 'audio/webm';
  if (u.endsWith('.m4a')) return 'audio/m4a';
  return 'audio/wav';
}

function _mimeFromDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(audio\/[a-z0-9.+-]+);base64,/i);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  return SUPPORTED_AUDIO_MIMES.includes(mime) ? mime : null;
}

function _extractResponseHead(response) {
  if (response == null) return '';
  if (typeof response === 'string') return response.slice(0, 400);
  try {
    // Try OpenAI shape first.
    if (response.choices && Array.isArray(response.choices) && response.choices[0]) {
      const msg = response.choices[0].message;
      if (msg && typeof msg.content === 'string') return msg.content.slice(0, 400);
    }
    // Anthropic shape.
    if (Array.isArray(response.content)) {
      const text = response.content
        .map((b) => (b && b.text) || '')
        .join('');
      if (text) return text.slice(0, 400);
    }
    return JSON.stringify(response).slice(0, 400);
  } catch {
    return '';
  }
}

export default {
  AUDIO_CAPTURE_VERSION,
  SUPPORTED_AUDIO_MIMES,
  detectAudioCapture,
  normalizeAudioBlock,
  extractWhisperTranscript,
  captureAudioMessage,
};
