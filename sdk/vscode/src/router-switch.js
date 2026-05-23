// W731-4 — W709 confidence-routing bridge for VS Code.
//
// For each completion request, POST /v1/route/chat/completions (the W709
// router endpoint — see src/router.js:4213, src/confidence-router.js, and
// src/runtime-confidence-router.js) and surface the routing decision as an
// inline status badge.
//
// Honest contract:
//   - If /v1/route/chat/completions returns 503 with module_missing, surface
//     an env that says routing isn't available — DON'T pretend the call went
//     to cloud or local. The badge stays unset.
//   - Badge values are exactly "[local]" or "[cloud]" (text — fallback for
//     terminals/screen-readers that drop the emoji prefix) prepended with a
//     glyph: house for local, cloud for cloud. We render BOTH the glyph and
//     the bare word so the meaning is unambiguous.
//   - If the API key is missing, we DON'T call the endpoint — we return
//     ok:false with error:'no_api_key' and the caller hides the badge.

const KOLM_VSCODE_ROUTER_SWITCH_VERSION = 'w731-v1';

const ROUTE_ENDPOINT = '/v1/route/chat/completions';

function formatBadge(decision) {
  if (decision === 'student' || decision === 'local') {
    return { glyph: 'home', text: 'local', label: 'kolm: local' };
  }
  if (decision === 'teacher' || decision === 'cloud') {
    return { glyph: 'cloud', text: 'cloud', label: 'kolm: cloud' };
  }
  return { glyph: 'circle-slash', text: 'unknown', label: 'kolm: ?' };
}

async function routeOnce(deps, payload) {
  if (!deps) throw new Error('routeOnce: deps required');
  const cfg = deps.cfg || (() => ({}));
  const request = deps.request;
  const c = cfg();
  const baseUrl = (c.baseUrl || 'https://kolm.ai').replace(/\/$/, '');
  const apiKey = c.apiKey || process.env.KOLM_API_KEY || '';

  if (!apiKey) {
    return { ok: false, error: 'no_api_key', badge: null, decision: null };
  }
  try {
    const parsed = await request('POST', baseUrl + ROUTE_ENDPOINT, {
      apiKey,
      body: payload || { messages: [], model: 'auto' },
    });
    // W709 response shape: { ..., kolm_routing: { decision: 'student'|'teacher', ... } }
    const routing = parsed && parsed.kolm_routing;
    const decision = routing && routing.decision;
    if (!decision) {
      return { ok: false, error: 'no_routing_decision', badge: null, parsed };
    }
    return { ok: true, decision, badge: formatBadge(decision), parsed };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (msg.includes('503') || msg.toLowerCase().includes('module_missing')) {
      return { ok: false, error: 'module_missing', badge: null, detail: msg };
    }
    return { ok: false, error: 'request_failed', badge: null, detail: msg };
  }
}

// Set up a per-window status bar item that reflects the LAST routing
// decision. Caller is responsible for calling .update(decision) after each
// completion event.
function createBadgeItem(vscode) {
  if (!vscode || !vscode.window || typeof vscode.window.createStatusBarItem !== 'function') {
    return { show() {}, hide() {}, dispose() {}, text: '', tooltip: '', update() {} };
  }
  const align = (vscode.StatusBarAlignment && vscode.StatusBarAlignment.Right) || 2;
  const item = vscode.window.createStatusBarItem(align, 97);
  item.text = 'kolm: routing';
  item.tooltip = 'Last completion was routed by the kolm W709 confidence router';
  item.command = 'kolm.openConsole';
  item.show();
  item.update = (decision) => {
    const b = formatBadge(decision);
    try { item.text = b.label; } catch {}
  };
  return item;
}

module.exports = {
  KOLM_VSCODE_ROUTER_SWITCH_VERSION,
  ROUTE_ENDPOINT,
  formatBadge,
  routeOnce,
  createBadgeItem,
};
