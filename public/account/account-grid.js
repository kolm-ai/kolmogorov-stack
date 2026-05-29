/*
 * account-grid.js — dependency-free, no-build-step data-grid layer for the
 * kolm /account cockpit. (W921 Account UI / No-Code, spec 44.)
 *
 * Three composable layers over the existing semantic <table class="ktable">:
 *
 *   LAYER 1 — ROW VIRTUALIZATION (fixed-height windowing). Render only the
 *     rows intersecting the viewport plus an overscan buffer, preserving real
 *     <table>/<thead>/<tbody> semantics and native scrollbar geometry via two
 *     zero-content spacer <tr> (leading height=topPad, trailing height=bottom
 *     Pad). Scroll is rAF-throttled and short-circuits when the window is
 *     unchanged. Node count is O(visibleCount), not O(N).
 *
 *   LAYER 2 — URL-PERSISTED FILTER/SORT/SAVED-VIEWS. q / sort / dir / facet
 *     filters live in location.search namespaced by instanceKey (g_<key>_*),
 *     so views are bookmarkable / shareable / back-button-correct. Debounced
 *     filter typing uses history.replaceState; discrete sort/view changes use
 *     pushState; a popstate listener re-reads + re-renders. Saved views are
 *     named {q,sort,dir,filters} snapshots in localStorage
 *     kolm.grid.views.<instanceKey>.
 *
 *   LAYER 3 — BULK-ACTION TOOLBAR. An id-Set selection model decoupled from
 *     the DOM (so virtualization never loses a checked row that scrolls out)
 *     feeds a toolbar that appears (reduced-motion-gated) only when
 *     selection > 0.
 *
 * Isomorphic, like ks-sparkline.js: the pure helpers (computeWindow,
 * applyFilterSort, readGridState, writeGridState, listViews, saveView,
 * comparatorFor) are attached to window (browser) AND globalThis (Node) and
 * exported via module.exports under a CommonJS shim, so
 * scripts/grid-contract-smoke.mjs can exercise them headlessly.
 *
 * Palette: cool-slate ONLY via design tokens — NO warm/brown/orange/amber hex.
 */
(function (root, factory) {
  var api = factory();
  if (typeof window !== 'undefined') {
    window.KolmGrid = api;
    window.mountGrid = api.mountGrid;
    window.computeWindow = api.computeWindow;
    window.applyFilterSort = api.applyFilterSort;
    window.readGridState = api.readGridState;
    window.writeGridState = api.writeGridState;
    window.listViews = api.listViews;
    window.saveView = api.saveView;
    window.comparatorFor = api.comparatorFor;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.KolmGrid = api;
  }
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- defaults ----------------------------------------------------------
  var DEFAULT_OVERSCAN = 6;
  var DEFAULT_ROW_HEIGHT = 34;
  var DEFAULT_MAX_HEIGHT = 560;
  var FILTER_DEBOUNCE_MS = 250;
  var VIEW_NS = 'kolm.grid.views.';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // =====================================================================
  // LAYER 1 — windowing math (pure)
  // =====================================================================
  /**
   * computeWindow(scrollTop, rowHeight, viewportH, total, overscan)
   *   -> { startIndex, endIndex, topPad, bottomPad }
   *
   * Fixed-height windowing. startIndex/endIndex are inclusive row indices to
   * materialize; topPad/bottomPad are the spacer-row heights in px that
   * preserve native scrollbar geometry. Safe for total === 0 (empty grid).
   */
  function computeWindow(scrollTop, rowHeight, viewportH, total, overscan) {
    var H = Number(rowHeight) > 0 ? Number(rowHeight) : DEFAULT_ROW_HEIGHT;
    var C = Number(viewportH) > 0 ? Number(viewportH) : 0;
    var N = Math.max(0, Math.floor(Number(total) || 0));
    var O = Math.max(0, Math.floor(Number(overscan) == null ? DEFAULT_OVERSCAN : Number(overscan)));
    var st = Math.max(0, Number(scrollTop) || 0);

    if (N === 0) {
      return { startIndex: 0, endIndex: -1, topPad: 0, bottomPad: 0 };
    }
    var visibleCount = Math.max(1, Math.ceil(C / H));
    var startIndex = Math.max(0, Math.floor(st / H) - O);
    var endIndex = Math.min(N - 1, startIndex + visibleCount + 2 * O);
    if (endIndex < startIndex) endIndex = startIndex;
    var topPad = startIndex * H;
    var bottomPad = (N - 1 - endIndex) * H;
    if (bottomPad < 0) bottomPad = 0;
    return { startIndex: startIndex, endIndex: endIndex, topPad: topPad, bottomPad: bottomPad };
  }

  // =====================================================================
  // comparators (pure)
  // =====================================================================
  function comparatorFor(kind) {
    if (kind === 'numeric') {
      return function (a, b) {
        var na = Number(a), nb = Number(b);
        if (!Number.isFinite(na) && !Number.isFinite(nb)) return 0;
        if (!Number.isFinite(na)) return 1; // NaN sorts last
        if (!Number.isFinite(nb)) return -1;
        return na - nb;
      };
    }
    if (kind === 'date') {
      return function (a, b) {
        var ta = a == null ? NaN : Date.parse(a);
        var tb = b == null ? NaN : Date.parse(b);
        if (isNaN(ta) && isNaN(tb)) return 0;
        if (isNaN(ta)) return 1;
        if (isNaN(tb)) return -1;
        return ta - tb;
      };
    }
    // string (natural — IDs like art_2 < art_10)
    return function (a, b) {
      return String(a == null ? '' : a).localeCompare(
        String(b == null ? '' : b), undefined, { numeric: true, sensitivity: 'base' });
    };
  }

  function fieldValue(row, key) {
    if (row == null) return undefined;
    if (key.indexOf('.') === -1) return row[key];
    var parts = key.split('.');
    var cur = row;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  // =====================================================================
  // filter + sort pipeline (pure)
  // =====================================================================
  /**
   * applyFilterSort(rows, { q, searchable, sort, dir, columns, filters }) -> rows[]
   *  - q: lowercased substring scan over `searchable` fields (AND across terms? no — single substring)
   *  - filters: facet object; each non-empty value AND-combines as an exact
   *    (case-insensitive) match OR membership for array filter values.
   *  - sort/dir: typed comparator from the column kind.
   * Never mutates the input array.
   */
  function applyFilterSort(rows, opts) {
    opts = opts || {};
    var out = Array.isArray(rows) ? rows.slice() : [];
    var q = (opts.q || '').toString().toLowerCase().trim();
    var searchable = Array.isArray(opts.searchable) ? opts.searchable : [];
    var filters = opts.filters || {};
    var columns = Array.isArray(opts.columns) ? opts.columns : [];

    // free-text search
    if (q && searchable.length) {
      out = out.filter(function (row) {
        for (var i = 0; i < searchable.length; i++) {
          var v = fieldValue(row, searchable[i]);
          if (v != null && String(v).toLowerCase().indexOf(q) !== -1) return true;
        }
        return false;
      });
    }

    // facet filters (AND-combine)
    var fkeys = Object.keys(filters);
    if (fkeys.length) {
      out = out.filter(function (row) {
        for (var i = 0; i < fkeys.length; i++) {
          var fk = fkeys[i];
          var want = filters[fk];
          if (want == null || want === '') continue;
          var have = fieldValue(row, fk);
          if (Array.isArray(want)) {
            if (want.length === 0) continue;
            var hv = String(have == null ? '' : have).toLowerCase();
            var ok = false;
            for (var j = 0; j < want.length; j++) {
              if (String(want[j]).toLowerCase() === hv) { ok = true; break; }
            }
            if (!ok) return false;
          } else {
            if (String(have == null ? '' : have).toLowerCase() !==
                String(want).toLowerCase()) return false;
          }
        }
        return true;
      });
    }

    // sort
    if (opts.sort) {
      var col = null;
      for (var c = 0; c < columns.length; c++) {
        if (columns[c].key === opts.sort) { col = columns[c]; break; }
      }
      var kind = col && col.kind ? col.kind : 'string';
      var cmp = comparatorFor(kind);
      var sortKey = opts.sort;
      var sign = opts.dir === 'desc' ? -1 : 1;
      out.sort(function (a, b) {
        return sign * cmp(fieldValue(a, sortKey), fieldValue(b, sortKey));
      });
    }
    return out;
  }

  // =====================================================================
  // LAYER 2 — URL-persisted grid state (pure-ish; reads location/history)
  // =====================================================================
  // Keys are namespaced g_<instanceKey>_q / _sort / _dir and arbitrary
  // facets as g_<instanceKey>_f_<name>. A facet with a comma is parsed as a
  // multi-value array on read.
  function prefixFor(instanceKey) { return 'g_' + instanceKey + '_'; }

  function readGridState(instanceKey, search) {
    var pfx = prefixFor(instanceKey);
    var raw = search != null ? search :
      (typeof location !== 'undefined' ? location.search : '');
    var sp;
    try { sp = new URLSearchParams(raw); } catch (_) { sp = new URLSearchParams(''); }
    var state = { q: '', sort: null, dir: 'asc', filters: {} };
    sp.forEach(function (val, key) {
      if (key.indexOf(pfx) !== 0) return;
      var sub = key.slice(pfx.length);
      if (sub === 'q') state.q = val;
      else if (sub === 'sort') state.sort = val || null;
      else if (sub === 'dir') state.dir = (val === 'desc' ? 'desc' : 'asc');
      else if (sub.indexOf('f_') === 0) {
        var fname = sub.slice(2);
        state.filters[fname] = val.indexOf(',') !== -1 ? val.split(',') : val;
      } else if (sub === 'view') {
        state.view = val;
      }
    });
    return state;
  }

  function buildSearch(instanceKey, state, existingSearch) {
    var pfx = prefixFor(instanceKey);
    var sp;
    try {
      sp = new URLSearchParams(existingSearch != null ? existingSearch :
        (typeof location !== 'undefined' ? location.search : ''));
    } catch (_) { sp = new URLSearchParams(''); }
    // drop all of OUR keys first so removed filters disappear
    var toDelete = [];
    sp.forEach(function (_v, key) { if (key.indexOf(pfx) === 0) toDelete.push(key); });
    toDelete.forEach(function (k) { sp['delete'](k); });
    if (state.q) sp.set(pfx + 'q', state.q);
    if (state.sort) sp.set(pfx + 'sort', state.sort);
    if (state.dir && state.dir !== 'asc') sp.set(pfx + 'dir', state.dir);
    if (state.view) sp.set(pfx + 'view', state.view);
    var filters = state.filters || {};
    Object.keys(filters).forEach(function (fk) {
      var fv = filters[fk];
      if (fv == null || fv === '') return;
      if (Array.isArray(fv)) { if (fv.length) sp.set(pfx + 'f_' + fk, fv.join(',')); }
      else sp.set(pfx + 'f_' + fk, String(fv));
    });
    var s = sp.toString();
    return s ? ('?' + s) : '';
  }

  function writeGridState(instanceKey, state, opts) {
    opts = opts || {};
    var replace = opts.replace !== false; // default true
    if (typeof history === 'undefined' || typeof location === 'undefined') return;
    var search = buildSearch(instanceKey, state, location.search);
    var url = location.pathname + search + location.hash;
    try {
      if (replace) history.replaceState(history.state, '', url);
      else history.pushState(history.state, '', url);
    } catch (_) { /* SecurityError in sandboxed contexts: ignore */ }
  }

  // =====================================================================
  // saved views (localStorage)
  // =====================================================================
  function lsGet(key) {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; }
    catch (_) { return null; }
  }
  function lsSet(key, val) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val); }
    catch (_) { /* quota / disabled: ignore */ }
  }

  function listViews(instanceKey) {
    var raw = lsGet(VIEW_NS + instanceKey);
    if (!raw) return [];
    try {
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function saveView(instanceKey, name, state) {
    var views = listViews(instanceKey);
    var id = 'v_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
    var view = {
      id: id,
      name: String(name || 'Untitled view').slice(0, 80),
      state: {
        q: state && state.q || '',
        sort: state && state.sort || null,
        dir: state && state.dir || 'asc',
        filters: state && state.filters || {}
      }
    };
    views.push(view);
    lsSet(VIEW_NS + instanceKey, JSON.stringify(views));
    return view;
  }

  function deleteView(instanceKey, viewId) {
    var views = listViews(instanceKey).filter(function (v) { return v.id !== viewId; });
    lsSet(VIEW_NS + instanceKey, JSON.stringify(views));
    return views;
  }

  // =====================================================================
  // browser-only: mountGrid + GridHandle
  // =====================================================================
  function reducedMotion() {
    try {
      return typeof matchMedia !== 'undefined' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) { return false; }
  }

  function mountGrid(tableEl, opts) {
    if (typeof document === 'undefined' || !tableEl) return null;
    opts = opts || {};
    var instanceKey = opts.instanceKey || 'grid';
    var mode = opts.mode === 'server' ? 'server' : 'client';
    var columns = Array.isArray(opts.columns) ? opts.columns : [];
    var searchable = Array.isArray(opts.searchable) ? opts.searchable : [];
    var rowHeight = Number(opts.rowHeight) > 0 ? Number(opts.rowHeight) : DEFAULT_ROW_HEIGHT;
    var overscan = opts.overscan == null ? DEFAULT_OVERSCAN : Number(opts.overscan);
    var maxHeight = Number(opts.maxHeight) > 0 ? Number(opts.maxHeight) : DEFAULT_MAX_HEIGHT;
    var rowId = typeof opts.rowId === 'function' ? opts.rowId :
      function (r) { return String(r && (r.id != null ? r.id : '')); };
    var bulkActions = Array.isArray(opts.bulkActions) ? opts.bulkActions : [];
    var onBulk = typeof opts.onBulk === 'function' ? opts.onBulk : null;
    var onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null;
    var savedViews = opts.savedViews !== false;
    var colCount = columns.length + (bulkActions.length ? 1 : 0);

    var thead = tableEl.querySelector('thead');
    var tbody = tableEl.querySelector('tbody');
    if (!tbody) { tbody = document.createElement('tbody'); tableEl.appendChild(tbody); }

    // scroll container: wrap the table once
    var scroller = tableEl.parentNode;
    if (!scroller || !scroller.classList || !scroller.classList.contains('kgrid-scroll')) {
      scroller = document.createElement('div');
      scroller.className = 'kgrid-scroll';
      scroller.style.maxHeight = maxHeight + 'px';
      scroller.style.overflowY = 'auto';
      scroller.style.position = 'relative';
      tableEl.parentNode.insertBefore(scroller, tableEl);
      scroller.appendChild(tableEl);
    }
    tableEl.setAttribute('role', 'grid');

    var handle = {
      _all: Array.isArray(opts.rows) ? opts.rows.slice() : [],
      _view: [],            // filtered+sorted rows (client) / sparse total (server)
      _total: 0,
      _sel: opts.selectionSet instanceof Set ? opts.selectionSet : new Set(),
      _state: null,
      _lastWindow: null,
      _rafPending: false,
      _serverCache: {},     // index -> row (server mode sparse)
      _destroyed: false
    };

    // --- toolbar + views chrome -----------------------------------------
    var chrome = document.createElement('div');
    chrome.className = 'kgrid-chrome';
    var viewsRow = document.createElement('div');
    viewsRow.className = 'kgrid-views';
    viewsRow.setAttribute('role', 'group');
    viewsRow.setAttribute('aria-label', 'Saved views');
    var bulkbar = document.createElement('div');
    bulkbar.className = 'kgrid-bulkbar';
    bulkbar.setAttribute('role', 'group');
    bulkbar.setAttribute('aria-label', 'Bulk actions');
    bulkbar.hidden = true;
    chrome.appendChild(viewsRow);
    chrome.appendChild(bulkbar);
    scroller.parentNode.insertBefore(chrome, scroller);

    function currentState() {
      return readGridState(instanceKey);
    }

    function renderViewsChips() {
      if (!savedViews) { viewsRow.hidden = true; return; }
      var st = currentState();
      var views = listViews(instanceKey);
      var html = '';
      var activeAll = !st.view && !st.q && !st.sort && Object.keys(st.filters).length === 0;
      html += '<button type="button" class="kgrid-chip' + (activeAll ? ' active' : '') +
        '" data-view-all="1" aria-pressed="' + (activeAll ? 'true' : 'false') + '">All</button>';
      views.forEach(function (v) {
        var active = st.view === v.id;
        html += '<button type="button" class="kgrid-chip' + (active ? ' active' : '') +
          '" data-view-id="' + esc(v.id) + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
          esc(v.name) + '<span class="kgrid-chip-x" data-view-del="' + esc(v.id) +
          '" role="button" tabindex="0" aria-label="Delete view ' + esc(v.name) + '">&times;</span></button>';
      });
      html += '<button type="button" class="kgrid-chip kgrid-chip-add" data-view-save="1" ' +
        'aria-label="Save current view">+ Save view</button>';
      viewsRow.innerHTML = html;
    }

    function renderBulkbar() {
      if (!bulkActions.length) { bulkbar.hidden = true; return; }
      var n = handle._sel.size;
      if (n === 0) { bulkbar.hidden = true; return; }
      bulkbar.hidden = false;
      if (!reducedMotion()) bulkbar.classList.add('kgrid-bulkbar--in');
      var html = '<span class="kgrid-selcount" aria-live="polite">' + n + ' selected</span>';
      html += '<button type="button" class="kgrid-bulk-clear" data-bulk-clear="1">Clear</button>';
      if (handle._total > n && mode === 'client' && handle._view.length > n) {
        html += '<button type="button" class="kgrid-bulk-all" data-bulk-allmatch="1">Select all ' +
          handle._view.length + ' matching</button>';
      }
      bulkActions.forEach(function (a) {
        var cls = a.kind === 'bad' ? ' kgrid-bulk-bad' : '';
        html += '<button type="button" class="kgrid-bulk-act' + cls + '" data-bulk-act="' +
          esc(a.id) + '">' + esc(a.label) + '</button>';
      });
      bulkbar.innerHTML = html;
    }

    // --- selection (id-Set, decoupled from DOM) -------------------------
    function isSelected(id) { return handle._sel.has(id); }
    function toggleSelect(id) {
      if (handle._sel.has(id)) handle._sel.delete(id); else handle._sel.add(id);
      afterSelectionChange();
    }
    function selectAllOnPage() {
      var w = handle._lastWindow;
      if (!w) return;
      for (var i = w.startIndex; i <= w.endIndex; i++) {
        var r = rowAt(i);
        if (r) handle._sel.add(rowId(r));
      }
      afterSelectionChange();
    }
    function selectAllMatching() {
      handle._view.forEach(function (r) { handle._sel.add(rowId(r)); });
      afterSelectionChange();
    }
    function clearSelection() { handle._sel.clear(); afterSelectionChange(); }
    function afterSelectionChange() {
      renderBulkbar();
      renderWindow();
      if (typeof opts.onSelectionChange === 'function') {
        opts.onSelectionChange(Array.from(handle._sel));
      }
    }

    function rowAt(i) {
      if (mode === 'client') return handle._view[i];
      return handle._serverCache[i];
    }

    // --- render -----------------------------------------------------------
    function rowToTr(row, idx) {
      var id = rowId(row);
      var sel = isSelected(id);
      var cells = '';
      if (bulkActions.length) {
        cells += '<td class="kgrid-check"><input type="checkbox" class="checkbox kgrid-rowcheck" ' +
          'data-grid-id="' + esc(id) + '"' + (sel ? ' checked' : '') +
          ' aria-label="Select row ' + esc(id) + '"></td>';
      }
      for (var c = 0; c < columns.length; c++) {
        var col = columns[c];
        var inner;
        if (typeof col.render === 'function') inner = col.render(row);
        else inner = esc(fieldValue(row, col.key));
        cells += '<td' + (col.kind === 'numeric' ? ' style="text-align:right;font-variant-numeric:tabular-nums"' : '') +
          '>' + inner + '</td>';
      }
      return '<tr class="kgrid-row" role="row" data-grid-id="' + esc(id) +
        '" data-grid-idx="' + idx + '" aria-selected="' + (sel ? 'true' : 'false') +
        '" tabindex="-1">' + cells + '</tr>';
    }

    function spacer(height) {
      return '<tr aria-hidden="true" class="kgrid-spacer"><td colspan="' + colCount +
        '" style="height:' + Math.max(0, Math.round(height)) + 'px;padding:0;border:0"></td></tr>';
    }

    function renderWindow() {
      var w = computeWindow(scroller.scrollTop, rowHeight,
        scroller.clientHeight || maxHeight, handle._total, overscan);
      handle._lastWindow = w;
      if (handle._total === 0) {
        tbody.innerHTML = '';
        tableEl.setAttribute('aria-rowcount', '0');
        return;
      }
      // server mode: ensure the visible window is loaded
      if (mode === 'server') ensureServerWindow(w);
      var html = spacer(w.topPad);
      for (var i = w.startIndex; i <= w.endIndex; i++) {
        var r = rowAt(i);
        if (r) html += rowToTr(r, i);
        else html += '<tr class="kgrid-row kgrid-row--loading" role="row" tabindex="-1"><td colspan="' +
          colCount + '"><span class="kgrid-skel"></span></td></tr>';
      }
      html += spacer(w.bottomPad);
      tbody.innerHTML = html;
      tableEl.setAttribute('aria-rowcount', String(handle._total));
    }

    function onScroll() {
      if (handle._rafPending) return;
      handle._rafPending = true;
      var raf = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame :
        function (cb) { return setTimeout(cb, 16); };
      raf(function () {
        handle._rafPending = false;
        var w = computeWindow(scroller.scrollTop, rowHeight,
          scroller.clientHeight || maxHeight, handle._total, overscan);
        var prev = handle._lastWindow;
        if (prev && prev.startIndex === w.startIndex && prev.endIndex === w.endIndex) return;
        renderWindow();
      });
    }

    // --- server-mode sparse fetch ---------------------------------------
    var serverLimit = Number(opts.pageSize) > 0 ? Number(opts.pageSize) : 50;
    var inflight = {};
    function ensureServerWindow(w) {
      if (typeof opts.fetchPage !== 'function') return;
      // load any page-aligned block missing in the window
      var firstPage = Math.floor(w.startIndex / serverLimit);
      var lastPage = Math.floor(w.endIndex / serverLimit);
      for (var p = firstPage; p <= lastPage; p++) {
        var off = p * serverLimit;
        if (handle._serverCache[off] !== undefined || inflight[off]) continue;
        // mark whole page as "requested" via the first slot sentinel? use inflight
        (function (offset) {
          inflight[offset] = true;
          var st = currentState();
          Promise.resolve(opts.fetchPage({
            offset: offset, limit: serverLimit,
            filters: st.filters, sort: st.sort, dir: st.dir, q: st.q
          })).then(function (res) {
            inflight[offset] = false;
            res = res || {};
            var prows = res.rows || [];
            if (typeof res.total === 'number') handle._total = res.total;
            for (var k = 0; k < prows.length; k++) handle._serverCache[offset + k] = prows[k];
            renderWindow();
          }).catch(function () { inflight[offset] = false; });
        })(off);
      }
    }

    // --- sort header wiring ---------------------------------------------
    function wireHeaders() {
      if (!thead) return;
      var ths = thead.querySelectorAll('th[data-sort]');
      ths.forEach(function (th) {
        th.setAttribute('role', 'columnheader');
        if (!th.hasAttribute('tabindex')) th.setAttribute('tabindex', '0');
        var apply = function () {
          var key = th.getAttribute('data-sort');
          var st = currentState();
          var dir = 'asc';
          if (st.sort === key) dir = st.dir === 'asc' ? 'desc' : (st.dir === 'desc' ? 'none' : 'asc');
          var newState = currentState();
          if (dir === 'none') { newState.sort = null; newState.dir = 'asc'; }
          else { newState.sort = key; newState.dir = dir; }
          newState.view = null;
          writeGridState(instanceKey, newState, { replace: false }); // pushState for sort
          syncHeaderAria();
          refreshData();
        };
        th.addEventListener('click', apply);
        th.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); }
        });
      });
      syncHeaderAria();
    }
    function syncHeaderAria() {
      if (!thead) return;
      var st = currentState();
      thead.querySelectorAll('th[data-sort]').forEach(function (th) {
        var key = th.getAttribute('data-sort');
        if (st.sort === key) th.setAttribute('aria-sort', st.dir === 'desc' ? 'descending' : 'ascending');
        else th.setAttribute('aria-sort', 'none');
      });
    }

    // --- data refresh (client recompute / server reset) ------------------
    function refreshData() {
      var st = currentState();
      handle._state = st;
      if (mode === 'client') {
        handle._view = applyFilterSort(handle._all, {
          q: st.q, searchable: searchable, sort: st.sort, dir: st.dir,
          columns: columns, filters: st.filters
        });
        handle._total = handle._view.length;
      } else {
        // server: reset sparse cache, total unknown until first page
        handle._serverCache = {};
        if (typeof opts.total === 'number') handle._total = opts.total;
      }
      scroller.scrollTop = 0;
      renderWindow();
      renderViewsChips();
      // empty state
      if (opts.emptyEl) opts.emptyEl.hidden = handle._total !== 0;
    }

    // --- events ----------------------------------------------------------
    scroller.addEventListener('scroll', onScroll, { passive: true });

    tbody.addEventListener('change', function (e) {
      var cb = e.target;
      if (cb && cb.classList && cb.classList.contains('kgrid-rowcheck')) {
        var id = cb.getAttribute('data-grid-id');
        toggleSelect(id);
      }
    });
    tbody.addEventListener('click', function (e) {
      var tr = e.target.closest ? e.target.closest('tr.kgrid-row') : null;
      if (!tr) return;
      if (e.target.classList && e.target.classList.contains('kgrid-rowcheck')) return;
      // open on row click only if onOpen and not clicking interactive child
      if (onOpen && (e.target.tagName === 'TD' || e.target === tr)) {
        onOpen(tr.getAttribute('data-grid-id'));
      }
    });

    viewsRow.addEventListener('click', function (e) {
      var t = e.target;
      if (t.getAttribute('data-view-del')) {
        e.stopPropagation();
        deleteView(instanceKey, t.getAttribute('data-view-del'));
        renderViewsChips();
        return;
      }
      if (t.getAttribute('data-view-all')) {
        writeGridState(instanceKey, { q: '', sort: null, dir: 'asc', filters: {}, view: null }, { replace: false });
        syncHeaderAria(); refreshData(); return;
      }
      if (t.getAttribute('data-view-id')) {
        applyViewById(t.getAttribute('data-view-id'));
        return;
      }
      if (t.getAttribute('data-view-save')) {
        var name = (typeof prompt !== 'undefined') ? prompt('Name this view') : null;
        if (name) {
          var st = currentState();
          var v = saveView(instanceKey, name, st);
          st.view = v.id;
          writeGridState(instanceKey, st, { replace: false });
          renderViewsChips();
        }
        return;
      }
    });

    bulkbar.addEventListener('click', function (e) {
      var t = e.target;
      if (t.getAttribute('data-bulk-clear')) { clearSelection(); return; }
      if (t.getAttribute('data-bulk-allmatch')) { selectAllMatching(); return; }
      var act = t.getAttribute('data-bulk-act');
      if (act && onBulk) {
        var spec = null;
        for (var i = 0; i < bulkActions.length; i++) if (bulkActions[i].id === act) spec = bulkActions[i];
        if (spec && spec.confirm && typeof confirm !== 'undefined' && !confirm(spec.confirm)) return;
        Promise.resolve(onBulk(act, Array.from(handle._sel))).then(function () {
          clearSelection();
        }).catch(function () { /* page owns error UX */ });
      }
    });

    function applyViewById(viewId) {
      var views = listViews(instanceKey);
      var v = null;
      for (var i = 0; i < views.length; i++) if (views[i].id === viewId) v = views[i];
      if (!v) return;
      var st = {
        q: v.state.q || '', sort: v.state.sort || null,
        dir: v.state.dir || 'asc', filters: v.state.filters || {}, view: viewId
      };
      writeGridState(instanceKey, st, { replace: false });
      syncHeaderAria();
      refreshData();
    }

    function onPopstate() { syncHeaderAria(); refreshData(); }
    window.addEventListener('popstate', onPopstate);

    // debounced filter setter (for filterUI inputs the page wires via setFilter)
    var debTimer = null;
    function setFilter(name, value, immediate) {
      var st = currentState();
      if (value == null || value === '' || (Array.isArray(value) && !value.length)) {
        delete st.filters[name];
        if (name === '__q') st.q = '';
      } else if (name === '__q') {
        st.q = value;
      } else {
        st.filters[name] = value;
      }
      st.view = null;
      if (immediate) {
        writeGridState(instanceKey, st, { replace: false });
        syncHeaderAria(); refreshData();
      } else {
        if (debTimer) clearTimeout(debTimer);
        debTimer = setTimeout(function () {
          writeGridState(instanceKey, st, { replace: true }); // replaceState for typing
          refreshData();
        }, FILTER_DEBOUNCE_MS);
      }
    }

    // --- public handle ---------------------------------------------------
    var gridHandle = {
      reload: function () {
        if (mode === 'client') refreshData();
        else { handle._serverCache = {}; refreshData(); }
      },
      setRows: function (rows) {
        handle._all = Array.isArray(rows) ? rows.slice() : [];
        refreshData();
      },
      setTotal: function (t) { handle._total = Number(t) || 0; renderWindow(); },
      getState: function () { return currentState(); },
      setState: function (s) {
        writeGridState(instanceKey, s, { replace: false });
        syncHeaderAria(); refreshData();
      },
      setFilter: setFilter,
      getSelection: function () { return Array.from(handle._sel); },
      clearSelection: clearSelection,
      selectAllOnPage: selectAllOnPage,
      selectAllMatching: selectAllMatching,
      destroy: function () {
        handle._destroyed = true;
        scroller.removeEventListener('scroll', onScroll);
        window.removeEventListener('popstate', onPopstate);
        if (chrome.parentNode) chrome.parentNode.removeChild(chrome);
      },
      _internal: handle
    };

    // --- boot ------------------------------------------------------------
    wireHeaders();
    refreshData();
    return gridHandle;
  }

  return {
    mountGrid: mountGrid,
    computeWindow: computeWindow,
    applyFilterSort: applyFilterSort,
    comparatorFor: comparatorFor,
    readGridState: readGridState,
    writeGridState: writeGridState,
    buildSearch: buildSearch,
    listViews: listViews,
    saveView: saveView,
    deleteView: deleteView,
    fieldValue: fieldValue
  };
});
