#!/usr/bin/env node
// workers/multimodal-redact-image/redact-image.mjs
//
// W462 — isolated kolm multimodal IMAGE PII redactor worker.
//
// Closes the audit P1 Multimodal cluster open item: "redactor for
// non-text modalities". W454 already ships a text-extraction-then-redact
// path (OCR via tesseract.js + text route through privacy-membrane).
// W462 ships a DIFFERENT primitive: pixel-space redaction.
//
// W454 reads an image, OCRs it, redacts the *text*, throws away the
// pixels. The output is redacted text.
//
// W462 reads an image, detects faces + license plates IN PIXEL SPACE,
// and emits a NEW IMAGE with those regions blurred/masked. The output
// is a redacted PNG. The two are complementary — for medical photos,
// dashcam footage, ID-card scans, you need BOTH (text-PII via W454
// AND faces/plates via W462).
//
// PIPELINE
//   1. Resolve the image source to bytes (via --path <file> or
//      --uri <file:sha256.ext> through src/media-store.js).
//   2. Decode + measure dimensions via sharp.
//   3. Run ONNX detectors:
//        face       → ~/.kolm/models/yolov8n-face.onnx          (optional)
//        plate      → ~/.kolm/models/license-plate-detector.onnx (optional)
//      Each detector is independently optional. When NEITHER is present
//      the worker emits an honest install_hint envelope.
//   4. For each detection above the score threshold, blur/mask that
//      bounding box on the source image via sharp's composite pipeline.
//   5. Encode the redacted image as PNG and either:
//        - write to --output <path>, OR
//        - emit base64 inline in the envelope (default behavior).
//
// MODES
//   --doctor                print toolchain + model readiness, exit 0.
//   --path <file>           local image file path.
//   --uri <file:sha256.ext> media-store-resolved uri.
//   --output <path>         write redacted PNG to disk (else inline b64).
//   --face-model <path>     override default ~/.kolm/models/yolov8n-face.onnx.
//   --plate-model <path>    override default ~/.kolm/models/license-plate-detector.onnx.
//   --threshold <0-1>       detection score threshold (default 0.35).
//   --max-bytes <N>         cap upstream bytes (default 25 MiB).
//   --mode <blur|mask>      blur (gaussian) or mask (solid black). Default blur.
//   --json                  emit a single JSON envelope (default).
//
// OUTPUT ENVELOPE (always JSON, one line, on stdout)
//   {
//     ok:         bool,
//     kind:       'image',
//     media_uri:  <uri>,
//     detector_face:  'yolov8n-face' | null,
//     detector_plate: 'license-plate-detector' | null,
//     detections: [{ class:'face'|'plate', score, box:[x,y,w,h] }],
//     num_faces:      <int>,
//     num_plates:     <int>,
//     mode:           'blur'|'mask',
//     output_path:    <path> | null,
//     output_b64:     <base64 png> | null,
//     redacted_image_sha256: '...',
//     install_hint?:  <string>          // present iff no detector wired
//   }
//
// EXIT CODES
//   0  ok (redaction applied OR zero detections, but pipeline ran)
//   2  bad args
//   3  no detector installed (install_hint set, redacted_image=null)
//   4  image not found / could not load
//   5  decode/detect failed
//   6  encode/write failed
//
// HEAVY-DEPS BOUNDARY (per standing directive: "Heavy ML deps must live
// in an isolated worker/package/script"). Root kolm install does NOT
// pull onnxruntime-node or sharp. Users opt in by:
//   cd workers/multimodal-redact-image && npm install
// `kolm media doctor` (W454) + `kolm media image-doctor` (this wave)
// summarize which detectors are wired.
//
// HONESTY CONTRACT: when an ONNX model is missing OR onnxruntime-node /
// sharp is missing, the worker returns {ok:false, install_hint,
// redacted_image:null}. It NEVER silently claims it redacted PII it
// could not see. (This is the load-bearing invariant for the
// "no softened claims" directive in the multimodal cluster.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..', '..');

const args = parseArgs(process.argv.slice(2));

if (args.doctor) {
  const r = await doctor();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(0);
}

if (!args.uri && !args.path) {
  emit({ ok: false, error: 'source_required', hint: 'pass --uri <file:sha256.ext> or --path <local file>' });
  process.exit(2);
}

const MAX_BYTES = Number(args['max-bytes']) || 25 * 1024 * 1024;
const THRESHOLD = clamp(Number(args.threshold) || 0.35, 0, 1);
const MODE = args.mode === 'mask' ? 'mask' : 'blur';

let bytes = null;
try {
  bytes = await loadBytes(args);
} catch (e) {
  if (e && e.code === 'ENOENT') {
    emit({ ok: false, error: 'image_not_found', media_uri: args.uri || args.path });
    process.exit(4);
  }
  emit({ ok: false, error: 'image_load_failed', detail: String(e && e.message || e) });
  process.exit(4);
}
if (bytes.byteLength > MAX_BYTES) {
  emit({ ok: false, error: 'oversize', got_bytes: bytes.byteLength, limit_bytes: MAX_BYTES });
  process.exit(2);
}

// Check deps before doing anything heavy.
const sharpMod = await tryImport('sharp');
const ortMod   = await tryImport('onnxruntime-node');

const faceModelPath  = args['face-model']  || path.join(os.homedir(), '.kolm', 'models', 'yolov8n-face.onnx');
const plateModelPath = args['plate-model'] || path.join(os.homedir(), '.kolm', 'models', 'license-plate-detector.onnx');
const haveFaceModel  = safeExists(faceModelPath);
const havePlateModel = safeExists(plateModelPath);
const anyDetectorWired = sharpMod && ortMod && (haveFaceModel || havePlateModel);

if (!anyDetectorWired) {
  const reasons = [];
  if (!sharpMod) reasons.push('sharp (image decode/blur/encode)');
  if (!ortMod)   reasons.push('onnxruntime-node (model inference)');
  if (!haveFaceModel && !havePlateModel) reasons.push('no ONNX model on disk');
  emit({
    ok: false,
    error: 'no_detector_installed',
    kind: 'image',
    media_uri: args.uri || args.path,
    detector_face: null,
    detector_plate: null,
    install_hint: 'cd workers/multimodal-redact-image && npm install onnxruntime-node sharp; then put yolov8n-face.onnx (and/or license-plate-detector.onnx) in ~/.kolm/models/. Missing: ' + reasons.join(', '),
    redacted_image: null,
  });
  process.exit(3);
}

// Decode + measure.
let meta = null;
let pipeline = null;
try {
  pipeline = sharpMod.default ? sharpMod.default(bytes) : sharpMod(bytes);
  meta = await pipeline.metadata();
} catch (e) {
  emit({ ok: false, error: 'decode_failed', detail: String(e && e.message || e) });
  process.exit(5);
}

// Run detectors.
let detections = [];
let detector_face_used  = null;
let detector_plate_used = null;
try {
  if (haveFaceModel) {
    const faceDets = await runYoloDetector(ortMod, sharpMod, bytes, meta, faceModelPath, 'face', THRESHOLD);
    if (faceDets.length > 0) detector_face_used = 'yolov8n-face';
    else detector_face_used = haveFaceModel ? 'yolov8n-face' : null;
    detections = detections.concat(faceDets);
  }
  if (havePlateModel) {
    const plateDets = await runYoloDetector(ortMod, sharpMod, bytes, meta, plateModelPath, 'plate', THRESHOLD);
    if (plateDets.length > 0) detector_plate_used = 'license-plate-detector';
    else detector_plate_used = havePlateModel ? 'license-plate-detector' : null;
    detections = detections.concat(plateDets);
  }
} catch (e) {
  emit({ ok: false, error: 'detect_failed', detail: String(e && e.message || e) });
  process.exit(5);
}

// Apply redaction.
let outputBuf = null;
try {
  outputBuf = await applyRedaction(sharpMod, bytes, meta, detections, MODE);
} catch (e) {
  emit({ ok: false, error: 'redact_failed', detail: String(e && e.message || e) });
  process.exit(6);
}

let output_path = null;
let output_b64 = null;
if (args.output) {
  try {
    fs.writeFileSync(args.output, outputBuf);
    output_path = args.output;
  } catch (e) {
    emit({ ok: false, error: 'write_failed', detail: String(e && e.message || e) });
    process.exit(6);
  }
} else {
  output_b64 = outputBuf.toString('base64');
}

const sha = 'sha256:' + crypto.createHash('sha256').update(outputBuf).digest('hex');

emit({
  ok: true,
  kind: 'image',
  media_uri: args.uri || args.path,
  detector_face: detector_face_used,
  detector_plate: detector_plate_used,
  detections,
  num_faces:  detections.filter(d => d.class === 'face').length,
  num_plates: detections.filter(d => d.class === 'plate').length,
  mode: MODE,
  output_path,
  output_b64,
  redacted_image_sha256: sha,
  width: meta.width,
  height: meta.height,
});
process.exit(0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--doctor' || a === '--json') { out[a.slice(2)] = true; continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      out[k] = v;
    }
  }
  return out;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function safeExists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

async function tryImport(name) {
  try { return await import(name); } catch (_) { return null; }
}

async function loadBytes(args) {
  if (args.path) return fs.readFileSync(args.path);
  if (args.uri) {
    const ms = await import(path.join(ROOT, 'src', 'media-store.js'));
    return await ms.loadBlob(args.uri);
  }
  throw new Error('no source');
}

// YOLO-style ONNX detector. Returns array of {class, score, box:[x,y,w,h]}.
// Accepts any YOLOv5/v8-shaped output (1, N, 5+) or (1, 5+, N). The score
// threshold is applied. For models we don't have full schema docs for, we
// fall back to a best-effort interpretation: if the detector produces no
// detections above threshold, that's an honest zero — we never invent.
async function runYoloDetector(ortMod, sharpMod, srcBytes, meta, modelPath, className, threshold) {
  const ort = ortMod.default || ortMod;
  const sharp = sharpMod.default || sharpMod;
  // Standard YOLO input is 640x640 RGB normalized to [0,1].
  const INPUT_SIZE = 640;
  const resized = await sharp(srcBytes).resize(INPUT_SIZE, INPUT_SIZE, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  // resized is HxWx3 uint8 in row-major. Convert to CHW float32 / 255.
  const chw = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  for (let y = 0; y < INPUT_SIZE; y++) {
    for (let x = 0; x < INPUT_SIZE; x++) {
      const i = (y * INPUT_SIZE + x) * 3;
      const j = y * INPUT_SIZE + x;
      chw[j]             = resized[i]     / 255.0;
      chw[plane + j]     = resized[i + 1] / 255.0;
      chw[2 * plane + j] = resized[i + 2] / 255.0;
    }
  }
  const session = await ort.InferenceSession.create(modelPath);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const tensor = new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const result = await session.run({ [inputName]: tensor });
  const out = result[outputName];
  if (!out || !out.data) return [];

  // Interpret output: support (1, N, 5+) and (1, 5+, N) layouts.
  const dims = out.dims || [];
  const data = out.data;
  let candidates = [];
  if (dims.length >= 3) {
    const d1 = dims[1], d2 = dims[2];
    // YOLOv8 single-class face / plate model: typically (1, 5, 8400) — 4 box + 1 conf, transposed.
    if (d1 <= 16 && d2 > d1) {
      // (1, C, N) layout — class scores follow box 4 vals.
      const C = d1, N = d2;
      for (let n = 0; n < N; n++) {
        const cx = data[0 * N + n];
        const cy = data[1 * N + n];
        const w  = data[2 * N + n];
        const h  = data[3 * N + n];
        let best = 0;
        for (let c = 4; c < C; c++) {
          const s = data[c * N + n];
          if (s > best) best = s;
        }
        if (best >= threshold) {
          candidates.push({ cx, cy, w, h, score: best });
        }
      }
    } else {
      // (1, N, C) layout — each row is [cx, cy, w, h, conf, classes...].
      const N = d1, C = d2;
      for (let n = 0; n < N; n++) {
        const base = n * C;
        const cx = data[base + 0];
        const cy = data[base + 1];
        const w  = data[base + 2];
        const h  = data[base + 3];
        let conf = C > 4 ? data[base + 4] : 1.0;
        let best = conf;
        for (let c = 5; c < C; c++) {
          const s = data[base + c] * conf;
          if (s > best) best = s;
        }
        if (best >= threshold) {
          candidates.push({ cx, cy, w, h, score: best });
        }
      }
    }
  }

  // Scale boxes from INPUT_SIZE back to original.
  const sx = meta.width  / INPUT_SIZE;
  const sy = meta.height / INPUT_SIZE;
  const boxes = candidates.map(c => {
    const w = Math.max(1, Math.round(c.w * sx));
    const h = Math.max(1, Math.round(c.h * sy));
    const x = Math.max(0, Math.round(c.cx * sx - w / 2));
    const y = Math.max(0, Math.round(c.cy * sy - h / 2));
    return {
      class: className,
      score: Number(c.score.toFixed(4)),
      box: [x, y, Math.min(w, meta.width - x), Math.min(h, meta.height - y)],
    };
  });

  return nonMaxSuppress(boxes, 0.45);
}

function nonMaxSuppress(boxes, iouThresh) {
  const sorted = boxes.slice().sort((a, b) => b.score - a.score);
  const keep = [];
  while (sorted.length > 0) {
    const top = sorted.shift();
    keep.push(top);
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (iou(top.box, sorted[i].box) > iouThresh) sorted.splice(i, 1);
    }
  }
  return keep;
}

function iou(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

async function applyRedaction(sharpMod, srcBytes, meta, detections, mode) {
  const sharp = sharpMod.default || sharpMod;
  if (detections.length === 0) {
    return await sharp(srcBytes).png().toBuffer();
  }
  // Build a composite array: for each detection, extract that region,
  // blur or mask it, and overlay back on the source.
  const overlays = [];
  for (const det of detections) {
    const [x, y, w, h] = det.box;
    if (w <= 0 || h <= 0) continue;
    let regionBuf = null;
    if (mode === 'blur') {
      regionBuf = await sharp(srcBytes)
        .extract({ left: x, top: y, width: w, height: h })
        .blur(Math.max(8, Math.round(Math.min(w, h) / 4)))
        .png()
        .toBuffer();
    } else {
      // Solid black mask.
      regionBuf = await sharp({
        create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
      }).png().toBuffer();
    }
    overlays.push({ input: regionBuf, left: x, top: y });
  }
  return await sharp(srcBytes).composite(overlays).png().toBuffer();
}

async function doctor() {
  const out = {
    spec: 'kolm-multimodal-redact-image-worker-doctor',
    version: '0.1.0',
    node_version: process.version,
    detectors: {},
  };
  const sharpMod = await tryImport('sharp');
  const ortMod   = await tryImport('onnxruntime-node');
  out.runtime = {
    sharp:            sharpMod ? { ok: true } : { ok: false, install_hint: 'cd workers/multimodal-redact-image && npm install sharp' },
    onnxruntime_node: ortMod   ? { ok: true } : { ok: false, install_hint: 'cd workers/multimodal-redact-image && npm install onnxruntime-node' },
  };
  const facePath  = path.join(os.homedir(), '.kolm', 'models', 'yolov8n-face.onnx');
  const platePath = path.join(os.homedir(), '.kolm', 'models', 'license-plate-detector.onnx');
  out.detectors.face = safeExists(facePath)
    ? { ok: true, model: facePath }
    : { ok: false, install_hint: 'place yolov8n-face.onnx at ' + facePath + ' (download from https://github.com/derronqi/yolov8-face or any YOLOv8 face variant)' };
  out.detectors.plate = safeExists(platePath)
    ? { ok: true, model: platePath }
    : { ok: false, install_hint: 'place license-plate-detector.onnx at ' + platePath + ' (any YOLO-format license-plate model)' };
  out.ready = !!(sharpMod && ortMod && (out.detectors.face.ok || out.detectors.plate.ok));
  return out;
}
