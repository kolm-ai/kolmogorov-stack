// W729 — Graceful degradation under load: FIFO queue with priority lanes,
// timeout, capacity, and overflow plumbing to a hosted teacher endpoint.
//
// Closes W729-1 / W729-2 / W729-3 / W729-4 from KOLM_W707_SYSTEM_UPGRADE_PLAN.md
// (lines 359-367):
//
//   W729-1 — FIFO queue with priority lanes and timeout (high-priority for
//            paid tiers; expired requests get clean 429 not silent drop).
//   W729-2 — Overflow to teacher API via W709 routing plumbing (when local
//            capacity saturated, route to hosted teacher).
//   W729-3 — HTTP 429 + Retry-After surfaced to the caller; clients back off.
//   W729-4 — Horizontal scaling doc + scaffold (single-page scaffold in
//            public/docs/runtime/horizontal-scaling.html).
//
// Honesty contract:
//   * KOLM_LOAD_QUEUE_DISABLED=1 → enqueue resolves IMMEDIATELY with
//     {ok:true, queued:false, reason:'disabled'}. Production behavior pre-
//     W729 is preserved bit-for-bit so a stuck queue never adds a latency
//     hop in front of every request.
//   * Timed-out requests resolve to a {code:'queue_timeout'} REJECTION with
//     the retry_after_seconds the middleware will surface as Retry-After.
//     Never silent drop.
//   * Capacity exceeded → if KOLM_TEACHER_OVERFLOW_URL is set, the request
//     is forwarded to the teacher (W709 routing plumbing). Otherwise
//     {code:'queue_full'} REJECTION so the router can emit 429 envelope.
//   * State held in a module-level singleton with _resetForTests() exported
//     so wave729 tests can run hermetically.
//
// Forbidden interactions (per W729 owner spec):
//   * MUST NOT touch sw.js or frontend-version.json (orchestrator only).
//   * MUST NOT change the W709 confidence-routing module. We only READ
//     KOLM_TEACHER_OVERFLOW_URL env so the overflow callback can forward
//     to whatever endpoint W709 already provisioned.
//
// Public surface:
//
//   LOAD_QUEUE_VERSION                           — schema stamp ('w729-v1')
//   PRIORITY_LANES                               — ordered priority names
//   enqueue({req, priority, timeout_ms, onOverflow}) → Promise<{ok, ...}>
//   getQueueStats()                              — {depth, capacity, by_priority}
//   setCapacity(n)                               — admin-only adjust
//   _resetForTests()                             — singleton reset

export const LOAD_QUEUE_VERSION = 'w729-v1';

// Priority lanes ordered highest-first. Enterprise jumps ahead of free.
// This list is the SOURCE OF TRUTH for `by_priority` stats and the
// dequeue rotation order; never duplicate it elsewhere.
export const PRIORITY_LANES = ['enterprise', 'business', 'starter', 'free'];

const DEFAULT_CAPACITY = 16;
const DEFAULT_TIMEOUT_MS = 60_000;

// Module-level singleton. Keep all mutable state behind this object so
// _resetForTests() can blow it away in one assignment.
let _state = _freshState();

function _freshState() {
  const lanes = {};
  for (const p of PRIORITY_LANES) lanes[p] = [];
  return {
    capacity: DEFAULT_CAPACITY,
    in_flight: 0,
    lanes,
  };
}

/**
 * Reset the singleton — TESTS ONLY. Production callers MUST NOT use this.
 * Exported so tests/wave729-load-queue.test.js can guarantee no state leak
 * between assertions.
 */
export function _resetForTests() {
  _state = _freshState();
}

/**
 * Return a snapshot of queue state. Pure read — does NOT mutate.
 *
 * Shape: {depth, capacity, by_priority:{enterprise,business,starter,free}}
 * `depth` is the SUM of all priority lanes plus in-flight slots so an
 * external dashboard sees true backpressure, not just the "waiting" count.
 */
export function getQueueStats() {
  const by_priority = {};
  let waiting = 0;
  for (const p of PRIORITY_LANES) {
    const n = _state.lanes[p].length;
    by_priority[p] = n;
    waiting += n;
  }
  return {
    depth: waiting + _state.in_flight,
    capacity: _state.capacity,
    by_priority,
  };
}

/**
 * Set queue capacity. Admin gate is enforced at the CALLER (router/CLI);
 * this primitive does not know about tenant.role.
 *
 * Returns the new capacity. Throws on non-positive integers.
 */
export function setCapacity(n) {
  const cap = Number(n);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isInteger(cap)) {
    throw new Error('capacity must be a positive integer');
  }
  _state.capacity = cap;
  return cap;
}

/**
 * Acquire a queue slot. Resolves when a slot is granted, REJECTS with a
 * structured envelope when the queue times out or fills.
 *
 * Options:
 *   req            — opaque request handle passed through to overflow cb
 *   priority       — one of PRIORITY_LANES; defaults to 'free'
 *   timeout_ms     — how long to wait before queue_timeout (default 60_000)
 *   onOverflow     — async callback (req) → result. Invoked when queue is
 *                    full AND KOLM_TEACHER_OVERFLOW_URL is set. Returns
 *                    {ok:true, overflowed:true, ...result}. If unset,
 *                    enqueue rejects with {code:'queue_full'}.
 *
 * Disabled-mode (KOLM_LOAD_QUEUE_DISABLED=1):
 *   Resolves immediately with {ok:true, queued:false, reason:'disabled'}.
 *   This preserves the pre-W729 production hot path so flipping the env
 *   var off is a complete no-op.
 *
 * Returns a Promise. The caller MUST call release() (the second tuple item)
 * when the request finishes so the in-flight counter goes back down. The
 * disabled-mode and overflow-mode responses include release as a no-op so
 * callers do not have to branch.
 */
export async function enqueue(opts) {
  const o = opts || {};
  const priority = PRIORITY_LANES.includes(o.priority) ? o.priority : 'free';
  const timeout_ms = Number.isFinite(o.timeout_ms) && o.timeout_ms > 0
    ? o.timeout_ms : DEFAULT_TIMEOUT_MS;

  // Honesty contract #1: env-disabled mode is a complete no-op. The
  // production hot path pre-W729 returned immediately, so wiring W729
  // behind a kill-switch lets ops disable it without a redeploy.
  if (String(process.env.KOLM_LOAD_QUEUE_DISABLED || '') === '1') {
    return {
      ok: true,
      queued: false,
      reason: 'disabled',
      priority,
      release: () => {},
    };
  }

  // Capacity-fast-path: slot available immediately, no queueing. Note:
  // this lets a free-tier request hit a free slot without waiting for a
  // higher-priority lane to drain, which matches the spec ("FIFO + priority"
  // means priority only matters under contention).
  if (_state.in_flight < _state.capacity) {
    _state.in_flight += 1;
    return _grantedEnvelope(priority);
  }

  // Capacity saturated. Try overflow before queueing. W729-2 says the
  // overflow path is invoked when "local capacity saturated, route to
  // hosted teacher" — meaning the W709 teacher endpoint absorbs the
  // request and the caller gets a real response instead of a 429.
  const overflowUrl = String(process.env.KOLM_TEACHER_OVERFLOW_URL || '');
  if (overflowUrl && typeof o.onOverflow === 'function') {
    try {
      const r = await o.onOverflow(o.req);
      return {
        ok: true,
        queued: false,
        overflowed: true,
        priority,
        teacher_url: overflowUrl,
        result: r,
        release: () => {},
      };
    } catch (e) {
      // Teacher failed. Fall through to queue-or-reject so the caller
      // sees a clean queue_full envelope instead of an opaque proxy error.
    }
  }

  // No overflow path available. Queue the request.
  return new Promise((resolve, reject) => {
    const lane = _state.lanes[priority];
    const ticket = {
      priority,
      created_at: Date.now(),
      resolve,
      reject,
      timer: null,
    };
    // Reject if queue depth would exceed 4x capacity. This is the
    // backstop against unbounded memory growth under a sustained
    // overload — the caller gets queue_full instead of OOM.
    const stats = getQueueStats();
    if (stats.depth >= _state.capacity * 4) {
      return reject({
        code: 'queue_full',
        retry_after_seconds: 60,
        queue_depth: stats.depth,
        capacity: _state.capacity,
      });
    }
    ticket.timer = setTimeout(() => {
      // Remove from lane on timeout. The dequeue loop also skips
      // already-rejected tickets but we want depth to drop right away.
      const idx = lane.indexOf(ticket);
      if (idx !== -1) lane.splice(idx, 1);
      reject({
        code: 'queue_timeout',
        retry_after_seconds: Math.max(1, Math.ceil(timeout_ms / 1000)),
        waited_ms: Date.now() - ticket.created_at,
      });
    }, timeout_ms);
    lane.push(ticket);
  });
}

function _grantedEnvelope(priority) {
  return {
    ok: true,
    queued: true,
    priority,
    release: _releaseSlot,
  };
}

function _releaseSlot() {
  if (_state.in_flight > 0) _state.in_flight -= 1;
  _drainNext();
}

function _drainNext() {
  if (_state.in_flight >= _state.capacity) return;
  // Walk lanes in priority order. Enterprise drains first, then business,
  // then starter, then free. Within a lane, FIFO.
  for (const p of PRIORITY_LANES) {
    const lane = _state.lanes[p];
    while (lane.length > 0) {
      const ticket = lane.shift();
      if (ticket.timer) clearTimeout(ticket.timer);
      _state.in_flight += 1;
      ticket.resolve(_grantedEnvelope(ticket.priority));
      if (_state.in_flight >= _state.capacity) return;
    }
  }
}
