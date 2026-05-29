/*
 * account-keylist.js — dependency-free, no-build-step keyboard-operable list
 * controller for the kolm /account cockpit. (W921 Account UI / No-Code, spec
 * 48.)
 *
 * Makes every data-bearing list/table keyboard-drivable the way Linear and
 * GitHub are: ArrowDown/ArrowUp (and Vim j/k) move an "active" row, x/Space
 * toggles selection (feeding the host page's bulk-action Set), Shift+Arrow
 * range-selects, Enter opens, Home/End jump, PageUp/Down page, Ctrl/Cmd+A
 * select-all, Escape clears selection or blurs.
 *
 * Focus model: ROVING TABINDEX (not aria-activedescendant). At any moment
 * exactly ONE row carries tabindex=0 (active); all others tabindex=-1; the
 * list is a single composite tab stop. Roving tabindex moves REAL DOM focus,
 * so (a) the browser auto-scrolls the active row into view, (b) :focus-visible
 * works natively, and (c) mobile screen readers honor it (per W3C APG +
 * Sarah Higley). Arrow movement does NOT wrap (APG data-grid rule).
 *
 * The module owns ONLY navigation + key->intent mapping + ARIA roving /
 * aria-selected / live-announce. It delegates selection STATE and open/select
 * EFFECTS back to the host via callbacks (selectionSet, onSelect, onOpen) so
 * existing bulk pipelines (captures state.sel + /v1/capture/bulk) are reused.
 *
 * A typing-field + meta-chord guard means the command palette (Cmd/Ctrl+K),
 * browser shortcuts, and filter inputs are never hijacked.
 *
 * Isomorphic like ks-sparkline.js: attaches mountKeyList/isTypingTarget/
 * renderKeyHintBar to window AND globalThis and exports them under a CommonJS
 * shim so scripts/account-keylist-smoke.mjs can exercise them headlessly.
 *
 * Palette: cool-slate ONLY (NO warm/brown/orange/amber hex).
 */
(function (root, factory) {
  var api = factory();
  if (typeof window !== 'undefined') {
    window.KolmKeyList = api;
    window.mountKeyList = api.mountKeyList;
    window.isTypingTarget = api.isTypingTarget;
    window.renderKeyHintBar = api.renderKeyHintBar;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.KolmKeyList = api;
  }
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable === true) return true;
    return false;
  }

  function renderKeyHintBar(opts) {
    opts = opts || {};
    var bits = [
      '<kbd>j</kbd>/<kbd>k</kbd> move',
      (opts.multiselect ? '<kbd>x</kbd> select' : null),
      '<kbd>enter</kbd> open'
    ].filter(Boolean);
    return '<div class="keylist-hint" aria-hidden="true">' + bits.join(' · ') + '</div>';
  }

  /**
   * mountKeyList(containerEl, opts) -> KeyListController
   * opts = { rowSelector, getRowId, multiselect, selectionSet, onSelect,
   *          onOpen, onSelectionChange, liveRegionEl, pageStep, vimKeys, wrap }
   */
  function mountKeyList(containerEl, opts) {
    if (!containerEl) return null;
    opts = opts || {};
    var rowSelector = opts.rowSelector || 'tr[data-id],li[data-id]';
    var getRowId = typeof opts.getRowId === 'function' ? opts.getRowId :
      function (el) { return el && el.getAttribute ? el.getAttribute('data-id') : null; };
    var multiselect = opts.multiselect === true;
    var selectionSet = opts.selectionSet instanceof Set ? opts.selectionSet : new Set();
    var onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : function () {};
    var onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : function () {};
    var onSelectionChange = typeof opts.onSelectionChange === 'function' ? opts.onSelectionChange : function () {};
    var liveRegionEl = opts.liveRegionEl || null;
    var pageStep = Number(opts.pageStep) > 0 ? Number(opts.pageStep) : 10;
    var vimKeys = opts.vimKeys !== false;
    var wrap = opts.wrap === true;

    var activeIdx = -1;
    var anchorIdx = -1; // for shift-range
    var destroyed = false;

    function rows() {
      return Array.prototype.slice.call(containerEl.querySelectorAll(rowSelector));
    }
    function count() { return rows().length; }

    function applyRoving() {
      var rs = rows();
      for (var i = 0; i < rs.length; i++) {
        rs[i].setAttribute('tabindex', i === activeIdx ? '0' : '-1');
        if (multiselect) {
          var id = getRowId(rs[i]);
          rs[i].setAttribute('aria-selected', selectionSet.has(id) ? 'true' : 'false');
        }
      }
    }

    function announce(msg) {
      if (!liveRegionEl) return;
      try { liveRegionEl.hidden = false; liveRegionEl.textContent = msg; } catch (_) {}
    }

    function setActive(idx, doFocus) {
      var n = count();
      if (n === 0) { activeIdx = -1; return; }
      idx = Math.max(0, Math.min(n - 1, idx));
      activeIdx = idx;
      applyRoving();
      var rs = rows();
      var el = rs[idx];
      if (el && doFocus !== false && typeof el.focus === 'function') {
        try { el.focus(); } catch (_) {}
      }
      var selSuffix = '';
      if (multiselect && el) selSuffix = selectionSet.has(getRowId(el)) ? ', selected' : '';
      announce('Row ' + (idx + 1) + ' of ' + n + selSuffix);
    }

    function setActiveById(id) {
      var rs = rows();
      for (var i = 0; i < rs.length; i++) {
        if (getRowId(rs[i]) === id) { setActive(i, true); return; }
      }
    }

    function move(delta) {
      var n = count();
      if (n === 0) return;
      var next;
      if (activeIdx < 0) { next = delta > 0 ? 0 : n - 1; }
      else {
        next = activeIdx + delta;
        if (wrap) { next = ((next % n) + n) % n; }
        else { next = Math.max(0, Math.min(n - 1, next)); }
      }
      setActive(next, true);
    }

    function toggleSelect(idx, range) {
      if (!multiselect) return;
      var rs = rows();
      if (idx < 0 || idx >= rs.length) return;
      function flip(i) {
        var id = getRowId(rs[i]);
        var nowSel;
        if (selectionSet.has(id)) { selectionSet.delete(id); nowSel = false; }
        else { selectionSet.add(id); nowSel = true; }
        rs[i].setAttribute('aria-selected', nowSel ? 'true' : 'false');
        onSelect(id, nowSel, rs[i]);
      }
      if (range && anchorIdx >= 0) {
        var lo = Math.min(anchorIdx, idx), hi = Math.max(anchorIdx, idx);
        // set the whole range to selected (range-select semantics)
        for (var i = lo; i <= hi; i++) {
          var id = getRowId(rs[i]);
          if (!selectionSet.has(id)) {
            selectionSet.add(id);
            rs[i].setAttribute('aria-selected', 'true');
            onSelect(id, true, rs[i]);
          }
        }
      } else {
        flip(idx);
        anchorIdx = idx;
      }
      announce(selectionSet.size + ' selected');
      onSelectionChange(Array.from(selectionSet));
    }

    function open(idx) {
      var rs = rows();
      if (idx < 0 || idx >= rs.length) return;
      onOpen(rs[idx], getRowId(rs[idx]));
    }

    function clearSelection() {
      if (!multiselect) return;
      selectionSet.clear();
      applyRoving();
      announce('0 selected');
      onSelectionChange([]);
    }

    function onKeydown(e) {
      if (isTypingTarget(e.target)) return;
      // never steal meta/ctrl/alt chords EXCEPT Ctrl/Cmd+A select-all
      var key = e.key;
      var isSelectAll = (key === 'a' || key === 'A') && (e.ctrlKey || e.metaKey) && !e.altKey;
      if ((e.ctrlKey || e.metaKey || e.altKey) && !isSelectAll) return;

      switch (key) {
        case 'ArrowDown': e.preventDefault(); move(+1); break;
        case 'ArrowUp': e.preventDefault(); move(-1); break;
        case 'j': if (vimKeys) { e.preventDefault(); move(+1); } break;
        case 'k': if (vimKeys) { e.preventDefault(); move(-1); } break;
        case 'Home': e.preventDefault(); setActive(0, true); break;
        case 'End': e.preventDefault(); setActive(count() - 1, true); break;
        case 'PageDown': e.preventDefault(); move(+pageStep); break;
        case 'PageUp': e.preventDefault(); move(-pageStep); break;
        case 'Enter': e.preventDefault(); if (activeIdx >= 0) open(activeIdx); break;
        case 'x':
        case 'X':
          if (multiselect) { e.preventDefault(); if (activeIdx >= 0) toggleSelect(activeIdx, e.shiftKey); }
          break;
        case ' ': // Space
        case 'Spacebar':
          if (multiselect) { e.preventDefault(); if (activeIdx >= 0) toggleSelect(activeIdx, false); }
          break;
        case 'a':
        case 'A':
          if (isSelectAll && multiselect) {
            e.preventDefault();
            var rs = rows();
            for (var i = 0; i < rs.length; i++) {
              var id = getRowId(rs[i]);
              if (!selectionSet.has(id)) { selectionSet.add(id); rs[i].setAttribute('aria-selected', 'true'); onSelect(id, true, rs[i]); }
            }
            announce(selectionSet.size + ' selected');
            onSelectionChange(Array.from(selectionSet));
          }
          break;
        case 'Escape':
          if (multiselect && selectionSet.size > 0) { e.preventDefault(); clearSelection(); }
          else if (e.target && typeof e.target.blur === 'function') { e.target.blur(); }
          break;
        default: break;
      }

      // shift+arrow range extension
      if (e.shiftKey && (key === 'ArrowDown' || key === 'ArrowUp')) {
        if (multiselect && activeIdx >= 0) {
          if (anchorIdx < 0) anchorIdx = activeIdx;
          toggleSelect(activeIdx, true);
        }
      }
    }

    function onFocusIn(e) {
      // entering the list: if no active row, pick the focused row or row 0
      var rs = rows();
      for (var i = 0; i < rs.length; i++) {
        if (rs[i] === e.target) { activeIdx = i; applyRoving(); return; }
      }
    }
    function onClick(e) {
      var rs = rows();
      var target = e.target;
      for (var i = 0; i < rs.length; i++) {
        if (rs[i] === target || (rs[i].contains && rs[i].contains(target))) {
          activeIdx = i; applyRoving(); return;
        }
      }
    }

    // role=grid + aria-multiselectable only where genuinely multi-select
    if (multiselect) {
      try {
        var tableLike = containerEl.closest ? containerEl.closest('table') : null;
        if (tableLike) { tableLike.setAttribute('role', 'grid'); tableLike.setAttribute('aria-multiselectable', 'true'); }
      } catch (_) {}
    }

    containerEl.addEventListener('keydown', onKeydown);
    containerEl.addEventListener('focusin', onFocusIn);
    containerEl.addEventListener('click', onClick);

    function refresh() {
      var n = count();
      if (n === 0) { activeIdx = -1; return; }
      if (activeIdx >= n) activeIdx = n - 1;
      if (activeIdx < 0) activeIdx = 0;
      applyRoving();
    }

    refresh();

    return {
      refresh: refresh,
      setActive: function (id) { setActiveById(id); },
      setActiveIndex: function (i) { setActive(i, true); },
      getActiveId: function () {
        var rs = rows();
        return (activeIdx >= 0 && activeIdx < rs.length) ? getRowId(rs[activeIdx]) : null;
      },
      getActiveIndex: function () { return activeIdx; },
      clearSelection: clearSelection,
      destroy: function () {
        destroyed = true;
        containerEl.removeEventListener('keydown', onKeydown);
        containerEl.removeEventListener('focusin', onFocusIn);
        containerEl.removeEventListener('click', onClick);
        var rs = rows();
        for (var i = 0; i < rs.length; i++) rs[i].removeAttribute('tabindex');
      },
      // test hooks
      _dispatchKey: function (keyObj) { onKeydown(keyObj); },
      _move: move,
      _toggle: toggleSelect,
      _open: open
    };
  }

  return {
    mountKeyList: mountKeyList,
    isTypingTarget: isTypingTarget,
    renderKeyHintBar: renderKeyHintBar
  };
});
