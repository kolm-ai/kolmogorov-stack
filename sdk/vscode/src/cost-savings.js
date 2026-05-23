// W731-5 — real-time cost-savings status bar.
//
// Pull capture count from /v1/capture/list (or local watcher counter) and
// multiply by configured cost-per-call to surface "kolm: saved $X.XX today".
//
// Honest contract:
//   - When capture count is 0 → show "kolm: saved $0.00" (NEVER fabricate).
//   - Cost-per-call defaults to $0.003 (rough Claude Sonnet ballpark for a
//     ~1k token prompt+completion). Override via setting `kolm.costPerCall`.
//   - Refresh every 30s (configurable). On API error, freeze the last-known
//     savings figure but log to the output channel.
//   - "today" boundary is midnight LOCAL time; we don't try to guess server
//     timezone since this is a per-developer display.

const KOLM_VSCODE_COST_SAVINGS_VERSION = 'w731-v1';

const DEFAULT_COST_PER_CALL_USD = 0.003;
const DEFAULT_REFRESH_MS = 30 * 1000;

function startOfTodayMs(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Compute saved dollars given a capture count and per-call cost. Returns
// formatted "$X.XX" string. Never fabricates — count=0 always renders $0.00.
function computeSavings(captureCount, costPerCall) {
  const n = Number.isFinite(captureCount) && captureCount > 0 ? captureCount : 0;
  const rate = Number.isFinite(costPerCall) && costPerCall > 0 ? costPerCall : 0;
  const dollars = n * rate;
  return {
    captureCount: n,
    costPerCall: rate,
    savedUsd: dollars,
    savedFormatted: `$${dollars.toFixed(2)}`,
  };
}

// Pull today's capture count from /v1/capture/list. The endpoint returns
// {captures:[{ts,namespace,input,output,source}, ...]} — we filter by
// ts >= startOfTodayMs locally.
//
// Honest contract: ANY network error returns ok:false with the count from
// the in-extension fallback counter (passed in via opts.localFallbackCount).
async function fetchTodaysCaptureCount(deps) {
  const cfg = deps.cfg || (() => ({}));
  const request = deps.request;
  const c = cfg();
  const baseUrl = (c.baseUrl || 'https://kolm.ai').replace(/\/$/, '');
  const apiKey = c.apiKey || process.env.KOLM_API_KEY || '';
  const namespace = c.namespace || 'vscode-codegen';
  const cutoff = startOfTodayMs(Date.now());

  if (!apiKey) {
    return { ok: false, error: 'no_api_key', count: deps.localFallbackCount || 0 };
  }
  try {
    const parsed = await request('GET',
      baseUrl + `/v1/capture/list?namespace=${encodeURIComponent(namespace)}&limit=1000`,
      { apiKey });
    const list = (parsed && (parsed.captures || parsed.items || parsed)) || [];
    if (!Array.isArray(list)) {
      return { ok: false, error: 'unexpected_shape', count: deps.localFallbackCount || 0 };
    }
    const todays = list.filter((row) => {
      const ts = (row && (row.ts || row.created_at || row.timestamp)) || 0;
      const n = typeof ts === 'string' ? Date.parse(ts) : Number(ts);
      return Number.isFinite(n) && n >= cutoff;
    });
    return { ok: true, count: todays.length };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err), count: deps.localFallbackCount || 0 };
  }
}

// Wire a status-bar item that refreshes on a timer. Returns dispose handle.
function activate(deps) {
  if (!deps) throw new Error('cost-savings.activate: deps required');
  const vscode = deps.vscode;
  const cfg = deps.cfg || (() => ({}));
  const logChannel = deps.logChannel || null;
  const refreshMs = (deps && deps.refreshMs) || DEFAULT_REFRESH_MS;
  let lastCount = 0;
  let timer = null;

  let item = null;
  if (vscode && vscode.window && typeof vscode.window.createStatusBarItem === 'function') {
    const align = (vscode.StatusBarAlignment && vscode.StatusBarAlignment.Right) || 2;
    item = vscode.window.createStatusBarItem(align, 98);
    item.command = 'kolm.viewCostSavings';
    item.tooltip = 'kolm: estimated $ saved today by replacing teacher calls with the local distilled model';
    item.text = 'kolm: saved $0.00';
    item.show();
  }

  async function refresh() {
    const c = cfg();
    const rate = Number.isFinite(c.costPerCall) ? c.costPerCall : DEFAULT_COST_PER_CALL_USD;
    const fetched = await fetchTodaysCaptureCount({ ...deps, localFallbackCount: lastCount });
    lastCount = fetched.count;
    const s = computeSavings(fetched.count, rate);
    if (item) {
      try { item.text = `kolm: saved ${s.savedFormatted}`; } catch {}
    }
    if (logChannel && !fetched.ok && typeof logChannel.appendLine === 'function') {
      try { logChannel.appendLine(`[kolm cost] ${fetched.error}`); } catch {}
    }
    return s;
  }

  // Kick off an initial refresh (don't block activation on it).
  // Timer not started in tests (refreshMs<=0 disables).
  if (refreshMs > 0) {
    timer = setInterval(() => { refresh().catch(() => {}); }, refreshMs);
    // Best-effort — don't keep Node alive in a test/host that exits early.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return {
    dispose: () => {
      if (timer) { try { clearInterval(timer); } catch {} timer = null; }
      if (item && typeof item.dispose === 'function') { try { item.dispose(); } catch {} }
    },
    refresh,
    _item: () => item,
    _lastCount: () => lastCount,
  };
}

module.exports = {
  KOLM_VSCODE_COST_SAVINGS_VERSION,
  DEFAULT_COST_PER_CALL_USD,
  computeSavings,
  fetchTodaysCaptureCount,
  startOfTodayMs,
  activate,
};
