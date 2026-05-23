// W731-3 — "Distill my coding assistant" command for VS Code.
//
// Registered as `kolm.distillCodingAssistant` in package.json contributes.
// Calls POST /v1/distill/from-captures with {namespace:'vscode-codegen'} and
// surfaces a status-bar progress indicator + honest error envelope.
//
// Honest contract:
//   - 401 → "kolm: set kolm.apiKey" (no error dump that confuses the user).
//   - 503 → show the server-provided message ("kolm: server says <msg>").
//   - any other error → surface the parsed envelope to the output channel,
//     then a generic "kolm: distill request failed (see Kolm output)" toast.
//   - Never throws into the extension host — every failure mode is caught.
//
// Status bar item `kolm.distillStatus` is owned by this module and is
// reused across invocations (so the bar position is stable).

const KOLM_VSCODE_DISTILL_COMMAND_VERSION = 'w731-v1';

function _classifyError(err, parsed) {
  const msg = (err && err.message) || (parsed && parsed.error) || '';
  const m = msg.toLowerCase();
  if (m.includes('401') || m.includes('unauthorized') || m.includes('invalid_api_key')) {
    return { kind: 'unauthenticated', userMessage: 'kolm: set kolm.apiKey' };
  }
  if (m.includes('503') || m.includes('module_missing') || m.includes('service_unavailable')) {
    const serverMsg = (parsed && (parsed.message || parsed.error)) || msg;
    return { kind: 'unavailable', userMessage: `kolm: server says ${serverMsg}` };
  }
  return { kind: 'unknown', userMessage: 'kolm: distill request failed (see Kolm output)' };
}

async function runDistill(deps) {
  if (!deps) throw new Error('runDistill: deps required');
  const cfg = deps.cfg || (() => ({}));
  const request = deps.request;
  const vscode = deps.vscode || null;
  const logChannel = deps.logChannel || null;
  const statusBar = deps.statusBar || null;

  const c = cfg();
  const baseUrl = (c.baseUrl || 'https://kolm.ai').replace(/\/$/, '');
  const apiKey = c.apiKey || process.env.KOLM_API_KEY || '';
  const namespace = c.namespace || 'vscode-codegen';

  if (!apiKey) {
    const env = { ok: false, error: 'no_api_key', userMessage: 'kolm: set kolm.apiKey' };
    if (vscode && vscode.window && typeof vscode.window.showWarningMessage === 'function') {
      try { vscode.window.showWarningMessage(env.userMessage); } catch {}
    }
    return env;
  }

  if (statusBar && typeof statusBar.show === 'function') {
    try {
      statusBar.text = `kolm: distilling ${namespace}...`;
      statusBar.show();
    } catch {}
  }

  let parsed = null;
  try {
    parsed = await request('POST', baseUrl + '/v1/distill/from-captures', {
      apiKey,
      body: { namespace },
    });
    if (statusBar && typeof statusBar.text === 'string') {
      try {
        const n = (parsed && (parsed.capture_count || parsed.count)) || '?';
        statusBar.text = `kolm: distilled ${n} captures`;
      } catch {}
    }
    return { ok: true, parsed };
  } catch (err) {
    const klass = _classifyError(err, null);
    if (logChannel && typeof logChannel.appendLine === 'function') {
      try { logChannel.appendLine(`[kolm distill] ${klass.kind}: ${err && err.message}`); } catch {}
    }
    if (vscode && vscode.window) {
      const fn = klass.kind === 'unauthenticated'
        ? vscode.window.showWarningMessage
        : vscode.window.showErrorMessage;
      if (typeof fn === 'function') {
        try { fn.call(vscode.window, klass.userMessage); } catch {}
      }
    }
    if (statusBar && typeof statusBar.text === 'string') {
      try { statusBar.text = `kolm: distill failed`; } catch {}
    }
    return { ok: false, error: klass.kind, userMessage: klass.userMessage, detail: (err && err.message) || String(err) };
  }
}

function createStatusBar(vscode) {
  if (!vscode || !vscode.window || typeof vscode.window.createStatusBarItem !== 'function') {
    return { show() {}, hide() {}, dispose() {}, text: '' };
  }
  const align = (vscode.StatusBarAlignment && vscode.StatusBarAlignment.Right) || 2;
  const item = vscode.window.createStatusBarItem(align, 99);
  item.command = 'kolm.distillCodingAssistant';
  item.text = 'kolm: ready';
  item.tooltip = 'Click to distill captures into a kolm artifact';
  return item;
}

module.exports = {
  KOLM_VSCODE_DISTILL_COMMAND_VERSION,
  runDistill,
  createStatusBar,
  _classifyError,
};
