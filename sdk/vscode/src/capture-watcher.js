// W731-1 — capture watcher for VS Code Copilot/Claude Code completions.
//
// Watches `vscode.workspace.onDidChangeTextDocument` for inline completion-like
// insertions and POSTs them to /v1/capture/log so the kolm runtime can later
// re-distill against them.
//
// Honest contract:
//   - If no KOLM_API_KEY env var AND no `kolm.apiKey` setting → ONE-TIME toast
//     "kolm: set kolm.apiKey to enable capture monitoring" and never log.
//   - Throttle: at most 1 capture per 5s PER FILE — large multi-line edits
//     (paste, snippet expansion) coalesce into a single event.
//   - All network errors are swallowed and surfaced to the output channel,
//     never to the user as a modal. Capture must NEVER block the editor.
//
// Designed so the module can be imported under `node --test` without a live
// VS Code extension host — the activate() entry takes its `vscode` and `cfg`
// dependencies via parameters, so tests pass stubs.
//
// W731-2 hook: every successful capture also fires a callback into the
// pattern detector (passed in) so dedup/repetition logic runs on the same
// edits the watcher saw.

const DEFAULT_THROTTLE_MS = 5000;
const DEFAULT_MIN_CHARS = 24; // Below this we consider it a normal keystroke.
const KOLM_VSCODE_WATCHER_VERSION = 'w731-v1';

const _state = new WeakMap();

// Heuristic: an "AI completion-like" change is a single contentChange whose
// inserted text spans multiple lines OR is >=24 chars. Single-character key
// strokes never qualify. This matches the shape of Copilot ghost-text accept
// and Claude Code multi-line insertions; backspace/cut don't qualify because
// .text is empty.
function isCompletionShaped(change, minChars) {
  if (!change || typeof change.text !== 'string') return false;
  if (change.text.length === 0) return false;
  const nl = change.text.indexOf('\n') !== -1;
  if (nl) return true;
  return change.text.length >= minChars;
}

// Pull a small window of surrounding context as the "prompt" so dedup +
// re-distill can match the original LLM call site. Keep it bounded — full
// file dumps blow out event-store rows.
function extractPromptWindow(document, change, windowLines) {
  if (!document || typeof document.lineCount !== 'number') return '';
  const startLine = Math.max(0, change.range.start.line - windowLines);
  const endLine = Math.max(0, change.range.start.line - 1);
  if (endLine < startLine) return '';
  const lines = [];
  for (let i = startLine; i <= endLine; i++) {
    try { lines.push(document.lineAt(i).text); } catch { /* doc closed */ }
  }
  return lines.join('\n');
}

function postCapture(opts) {
  const { request, baseUrl, apiKey, namespace, prompt, completion, source } = opts;
  const body = { namespace, input: prompt, output: completion, source };
  return request('POST', baseUrl + '/v1/capture/log', { body, apiKey })
    .then((parsed) => ({ ok: true, parsed }))
    .catch((err) => ({ ok: false, error: (err && err.message) || String(err) }));
}

// Public entry: wire the watcher onto a vscode-like API. Returns a disposable
// the caller registers with `context.subscriptions.push`.
//
// `deps` is { vscode, cfg, request, logChannel, patternDetector } — all
// injectable so tests can pass stubs.
function activate(deps) {
  if (!deps || !deps.vscode) {
    throw new Error('capture-watcher.activate: deps.vscode required');
  }
  const vscode = deps.vscode;
  const cfg = deps.cfg || (() => ({}));
  const request = deps.request;
  const logChannel = deps.logChannel || null;
  const patternDetector = deps.patternDetector || null;
  const onCaptureSuccess = deps.onCaptureSuccess || null;

  const ctx = {
    lastByFile: new Map(),
    toastShown: false,
    captureCount: 0,
  };
  _state.set(deps, ctx);

  const handler = async (e) => {
    const c = cfg();
    const baseUrl = (c.baseUrl || 'https://kolm.ai').replace(/\/$/, '');
    const apiKey = c.apiKey || process.env.KOLM_API_KEY || '';
    const namespace = c.namespace || 'vscode-codegen';
    const throttle = Number.isFinite(c.throttleMs) ? c.throttleMs : DEFAULT_THROTTLE_MS;
    const minChars = Number.isFinite(c.minChars) ? c.minChars : DEFAULT_MIN_CHARS;
    const windowLines = Number.isFinite(c.promptWindowLines) ? c.promptWindowLines : 6;

    if (!apiKey) {
      // Honest no-op: one-time toast, then go silent for the session.
      if (!ctx.toastShown && vscode.window && typeof vscode.window.showInformationMessage === 'function') {
        ctx.toastShown = true;
        try {
          vscode.window.showInformationMessage(
            'kolm: set kolm.apiKey to enable capture monitoring'
          );
        } catch { /* test stubs may not honor */ }
      }
      return;
    }

    if (!e || !e.document || !Array.isArray(e.contentChanges)) return;
    const fileKey = (e.document.uri && e.document.uri.toString && e.document.uri.toString()) || e.document.fileName || '<unknown>';
    const now = Date.now();
    const last = ctx.lastByFile.get(fileKey) || 0;
    if (now - last < throttle) return;

    for (const change of e.contentChanges) {
      if (!isCompletionShaped(change, minChars)) continue;
      ctx.lastByFile.set(fileKey, now);
      const prompt = extractPromptWindow(e.document, change, windowLines);
      const completion = change.text;
      const result = await postCapture({
        request, baseUrl, apiKey, namespace, prompt, completion,
        source: 'vscode-watcher',
      });
      if (result.ok) {
        ctx.captureCount += 1;
        if (logChannel && typeof logChannel.appendLine === 'function') {
          try { logChannel.appendLine(`[kolm capture] ${namespace} +1 (${completion.length} chars)`); } catch {}
        }
        if (patternDetector && typeof patternDetector.observe === 'function') {
          try { patternDetector.observe({ prompt, completion, ts: now }); } catch {}
        }
        if (typeof onCaptureSuccess === 'function') {
          try { onCaptureSuccess({ namespace, prompt, completion, ts: now }); } catch {}
        }
      } else if (logChannel && typeof logChannel.appendLine === 'function') {
        try { logChannel.appendLine(`[kolm capture] failed: ${result.error}`); } catch {}
      }
      break; // throttle is per-file-per-window — one capture per change event
    }
  };

  const sub = (vscode.workspace && typeof vscode.workspace.onDidChangeTextDocument === 'function')
    ? vscode.workspace.onDidChangeTextDocument(handler)
    : { dispose() {} };

  return {
    dispose: () => { try { sub.dispose && sub.dispose(); } catch {} },
    // Test seam — expose internal counters.
    _ctx: () => ctx,
    _handler: handler,
  };
}

module.exports = {
  KOLM_VSCODE_WATCHER_VERSION,
  activate,
  // Exported for unit tests:
  isCompletionShaped,
  extractPromptWindow,
  postCapture,
};
