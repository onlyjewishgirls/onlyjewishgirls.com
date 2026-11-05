/*!
 * Console kit — console.js
 * The one admin/security console every site ships. Vanilla, no dependencies,
 * no build step, ES5 syntax in one IIFE. Renders into <div id="console-root">
 * and talks only to the /api/console/* contract in API.md.
 *
 * Safety rule for anyone editing this file: data from the server is never put
 * through innerHTML. Every string reaches the page through textContent or an
 * attribute set with setAttribute, via h() below.
 */
(function (window, document) {
  'use strict';
  if (window.ConsoleKit && window.ConsoleKit.loaded) return;

  var VERSION = '1.0.0';
  var CFG = {};
  var BOOT = null;
  var PERMS = {};
  var FEAT = {};
  var ROOT = null;
  var VIEW = null;
  var APP = null;
  var STATE = { section: null, route: null, ctx: null, loadedAt: 0, navigated: false };
  var uidSeq = 0;

  /* ------------------------------------------------------------ utilities -- */

  var hasOwn = Object.prototype.hasOwnProperty;
  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function each(list, fn) { if (!list) return; for (var i = 0; i < list.length; i++) fn(list[i], i); }
  function map(list, fn) { var out = []; each(list, function (v, i) { out.push(fn(v, i)); }); return out; }
  function filter(list, fn) { var out = []; each(list, function (v, i) { if (fn(v, i)) out.push(v); }); return out; }
  function find(list, fn) { if (!list) return null; for (var i = 0; i < list.length; i++) if (fn(list[i], i)) return list[i]; return null; }
  function contains(list, v) { return !!list && list.indexOf(v) !== -1; }
  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (s) for (var k in s) if (hasOwn.call(s, k)) t[k] = s[k];
    }
    return t;
  }
  function str(v, d) { return (v === null || v === undefined || v === '') ? (d === undefined ? '' : d) : String(v); }
  function num(v, d) { var n = Number(v); return (v === null || v === undefined || v === '' || !isFinite(n)) ? d : n; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function enc(v) { return encodeURIComponent(String(v)); }
  function dec(v) { try { return decodeURIComponent(v); } catch (e) { return v; } }
  function uid(p) { uidSeq += 1; return (p || 'cx') + '-' + uidSeq; }
  function has(cap) { return !!(PERMS['*'] || PERMS[cap]); }
  function feat(k) { return !!(FEAT && FEAT[k] === true); }
  function me() { return (BOOT && BOOT.me) || {}; }
  function isMe(id) { return id !== null && id !== undefined && String(id) === String(me().id); }
  function site() { return (BOOT && BOOT.site) || {}; }
  function noun(plural_) {
    var s = site();
    return plural_ ? str(s.people_noun, 'people') : str(s.person_noun, 'person');
  }
  function cap1(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function initials(name) {
    var parts = String(name || '?').replace(/[^A-Za-z0-9À-￿ ]+/g, ' ').trim().split(/\s+/);
    var a = (parts[0] || '?').charAt(0);
    var b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : (parts[0] || '').charAt(1);
    return (a + (b || '')).toUpperCase();
  }
  function debounce(fn, ms) {
    var t = null;
    return function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); };
  }
  function then(p, ok, bad) { return Promise.resolve(p).then(ok, bad); }

  /* A link from the server may only go somewhere harmless: a console hash, a
     same-site path, or an http(s) URL. Anything else (javascript:, data:) is
     dropped. Console hashes to sections this viewer cannot open are dropped too. */
  function safeHref(href) {
    var s = str(href).trim();
    if (!s) return '';
    if (s.charAt(0) === '#') {
      var key = s.slice(1).split(/[\/?]/)[0];
      return sectionAvailable(SEC_BY_KEY[key]) ? s : '';
    }
    if (/^\/(?!\/)/.test(s) || /^https?:\/\//i.test(s)) return s;
    if (/^[^:\/?#]+(?:[\/?#]|$)/.test(s) && !/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
    return '';
  }

  /* ---------------------------------------------------------------- DOM -- */

  function append(el, c) {
    if (c === null || c === undefined || c === false || c === true) return;
    if (isArr(c)) { each(c, function (x) { append(el, x); }); return; }
    if (typeof c === 'string' || typeof c === 'number') { el.appendChild(document.createTextNode(String(c))); return; }
    el.appendChild(c);
  }
  var PROP_BOOL = { checked: 1, disabled: 1, selected: 1, hidden: 1, required: 1, multiple: 1, readOnly: 1, open: 1 };
  /** h('div', {class, text, onClick, ...attrs}, ...children) — text only, never HTML. */
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (!hasOwn.call(props, k)) continue;
        var v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = isArr(v) ? filter(v, Boolean).join(' ') : String(v);
        else if (k === 'text') el.textContent = String(v);
        else if (k.length > 2 && k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else if (PROP_BOOL[k]) el[k] = true;
        else if (k === 'style' && typeof v === 'object') assign(el.style, v);
        else if (k === 'href') { var safe = safeHref(v); if (safe) el.setAttribute('href', safe); }
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function clear(el) { if (el) while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function replace(el) { clear(el); for (var i = 1; i < arguments.length; i++) append(el, arguments[i]); return el; }
  function remove(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }
  function txt(v, d) { return document.createTextNode(str(v, d === undefined ? '' : d)); }

  /* ------------------------------------------------------------ the API -- */

  function ApiError(status, payload) {
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload || {};
    this.code = this.payload.code || (status ? 'http_' + status : 'network');
    this.message = this.payload.error || defaultError(status);
    this.field = this.payload.field || null;
    this.fields = this.payload.fields || null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function defaultError(status) {
    if (!status) return 'Could not reach the server. Check your connection and try again.';
    if (status === 401) return 'Your session has ended. Sign in again.';
    if (status === 403) return 'Your account is not allowed to do that.';
    if (status === 404) return 'That no longer exists.';
    if (status === 429) return 'Too many requests. Wait a moment and try again.';
    if (status >= 500) return 'The server failed while doing that (HTTP ' + status + '). Nothing was changed by this page.';
    return 'The request failed (HTTP ' + status + ').';
  }
  function errText(err) {
    if (err instanceof ApiError) return err.message;
    if (window.console) window.console.error('console-kit:', err);
    return 'Something in this page broke while doing that. Reload and try again.';
  }
  function isStepUp(err) { return err instanceof ApiError && err.code === 'step_up_required'; }

  function qs(params) {
    var parts = [];
    for (var k in params) {
      if (!hasOwn.call(params, k)) continue;
      var v = params[k];
      if (v === null || v === undefined || v === '' || v === false) continue;
      parts.push(enc(k) + '=' + enc(v === true ? '1' : v));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }
  function apiUrl(path) { return CFG.apiBase + path; }

  function api(method, path, body) {
    var verb = String(method || 'GET').toUpperCase();
    var headers = { 'Accept': 'application/json', 'X-Requested-With': 'console' };
    if (verb !== 'GET' && BOOT && BOOT.csrf_token) headers['X-CSRF-Token'] = String(BOOT.csrf_token);
    var init = { method: verb, credentials: 'same-origin', cache: 'no-store', headers: headers };
    if (body !== undefined && body !== null && verb !== 'GET' && verb !== 'DELETE') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(apiUrl(path), init).then(function (res) {
      return res.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : {}; } catch (e) { data = null; }
        if (res.status === 401) { goLogin(); throw new ApiError(401, data); }
        if (!res.ok || !data || data.ok === false) {
          var err = new ApiError(res.status, data);
          if (err.code === 'csrf') showBanner('danger', 'This page lost its security token. Reload the page before doing anything else.');
          throw err;
        }
        return data;
      });
    }, function () { throw new ApiError(0, null); });
  }

  function goLogin() {
    var s = site();
    var dest = s.login_url || CFG.loginUrl || CFG.signOutUrl || '/';
    var next = location.pathname + location.search + location.hash;
    try { location.assign(dest + (dest.indexOf('?') === -1 ? '?' : '&') + 'next=' + enc(next)); } catch (e) { /* ignore */ }
  }

  /* --------------------------------------------------------------- time -- */

  var fmtCache = {};
  function tz() { return str(site().timezone, 'America/New_York'); }
  function parseTime(v) {
    if (v === null || v === undefined || v === '') return null;
    var t = typeof v === 'number' ? v : Date.parse(v);
    return isFinite(t) ? t : null;
  }
  function dtf(opts) {
    var key = JSON.stringify(opts);
    if (!fmtCache[key]) {
      try { fmtCache[key] = new Intl.DateTimeFormat(undefined, assign({ timeZone: tz() }, opts)); }
      catch (e) { fmtCache[key] = new Intl.DateTimeFormat(undefined, opts); }
    }
    return fmtCache[key];
  }
  function fmtFull(v) {
    var t = parseTime(v);
    if (t === null) return '—';
    return dtf({ year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(t));
  }
  function fmtDay(v) {
    var t = parseTime(v);
    if (t === null) return '—';
    return dtf({ year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(t));
  }
  function fmtAgo(v) {
    var t = parseTime(v);
    if (t === null) return '—';
    var diff = Math.round((Date.now() - t) / 1000);
    var future = diff < 0;
    var s = Math.abs(diff);
    var out;
    if (s < 45) return future ? 'in a moment' : 'just now';
    if (s < 3600) out = Math.max(1, Math.round(s / 60)) + ' min';
    else if (s < 86400) out = Math.round(s / 3600) + 'h';
    else if (s < 7 * 86400) out = Math.round(s / 86400) + 'd';
    else return fmtDay(v);
    return future ? 'in ' + out : out + ' ago';
  }
  function when(v, style) {
    var t = parseTime(v);
    if (t === null) return h('span', { class: 'cx-faint', text: '—' });
    var shown = style === 'full' ? fmtFull(v) : style === 'day' ? fmtDay(v) : fmtAgo(v);
    return h('time', { datetime: new Date(t).toISOString(), title: fmtFull(v) + ' (' + tz() + ')', text: shown });
  }
  function isoDate(v) {
    var t = parseTime(v);
    if (t === null) return '';
    var parts = dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts
      ? dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t)) : null;
    if (!parts) return new Date(t).toISOString().slice(0, 10);
    var o = {};
    each(parts, function (p) { o[p.type] = p.value; });
    return o.year + '-' + o.month + '-' + o.day;
  }

  /* ------------------------------------------------------- small widgets -- */

  var STATUS = {
    active: ['Active', 'ok'], invited: ['Invited', 'warn'], suspended: ['Suspended', 'danger'],
    locked: ['Locked', 'danger'], disabled: ['Disabled', 'muted'], banned: ['Banned', 'danger'],
    deleted: ['Deleted', 'muted'], pending: ['Pending', 'warn'], approved: ['Approved', 'ok'],
    blocked: ['Blocked', 'danger'], revoked: ['Revoked', 'muted'], expired: ['Expired', 'muted'],
    accepted: ['Accepted', 'ok'], sent: ['Sent', 'ok'], throttled: ['Throttled', 'warn'],
    failed: ['Failed', 'danger'], queued: ['Queued', 'info'], ended: ['Ended', 'muted'],
    denied: ['Denied', 'warn'], success: ['Success', 'ok'], failure: ['Failure', 'danger'],
    info: ['Info', 'muted'], notice: ['Notice', 'info'], warning: ['Warning', 'warn'], critical: ['Critical', 'danger'],
    allow: ['Allow', 'ok'], challenge: ['Challenge', 'warn'], block: ['Block', 'danger']
  };
  function statusInfo(s) {
    var key = str(s, 'unknown');
    var custom = BOOT && BOOT.enums && find(BOOT.enums.statuses, function (e) { return String(e.value) === key; });
    if (custom) return [str(custom.label, key), custom.tone || 'muted'];
    return STATUS[key] || [cap1(key.replace(/_/g, ' ')), 'muted'];
  }
  function badge(text, tone, extra) {
    return h('span', { class: ['cx-badge', tone && tone !== 'muted' ? 't-' + tone : null, extra], text: text });
  }
  function statusBadge(s) { var i = statusInfo(s); return badge(i[0], i[1]); }
  function roleBadge(role) {
    if (!role) return badge('No role', 'muted');
    if (typeof role === 'string') return badge(role, 'muted');
    return badge(str(role.label || role.name || role.value, 'No role'), role.tone || 'info');
  }

  var BANDS = { quiet: 'Quiet', watch: 'Watch', suspicious: 'Suspicious', hostile: 'Hostile' };
  function bandOf(v) {
    if (v && BANDS[v.band]) return v.band;
    var s = num(v && v.score, 0);
    return s >= 80 ? 'hostile' : s >= 50 ? 'suspicious' : s >= 20 ? 'watch' : 'quiet';
  }
  function bandBadge(v) {
    var b = bandOf(v);
    return h('span', { class: 'cx-badge cx-band b-' + b, title: 'Score ' + num(v.score, 0) + ' out of 100',
      text: BANDS[b] + ' · ' + num(v.score, 0) });
  }
  function meter(v) {
    var b = bandOf(v);
    return h('span', { class: 'cx-meter b-' + b, 'aria-hidden': 'true' },
      h('span', { style: { width: Math.max(4, Math.min(100, num(v.score, 0))) + '%' } }));
  }
  function tierTone(t) { return ({ 1: 'ok', 2: 'info', 3: 'warn', 4: 'danger' })[num(t, 0)] || 'muted'; }
  function mono(v, cls) { return h('span', { class: ['cx-mono', cls], text: str(v, '—') }); }
  function faint(v) { return h('span', { class: 'cx-faint', text: v }); }
  function cellSub(main, sub) {
    return h('span', null, typeof main === 'string' || typeof main === 'number' ? txt(main) : main,
      sub ? h('span', { class: 'cx-cell-sub', text: sub }) : null);
  }
  function placeText(o) {
    if (!o) return '';
    return filter([str(o.city), str(o.region), str(o.country)], Boolean).join(', ');
  }
  function personLink(p) {
    if (!p) return faint('—');
    var name = str(p.name || p.username || p.email, p.id ? noun() + ' #' + p.id : '—');
    if (p.id && sectionAvailable(SEC_BY_KEY.people)) return h('a', { href: '#people/' + enc(p.id), text: name });
    return txt(name);
  }
  function flame(s) {
    if (!s || (!num(s.current, 0) && !num(s.longest, 0))) return null;
    var cur = num(s.current, 0);
    return h('span', { class: ['cx-flame', cur && s.alive !== false ? null : 'cold'],
      title: cur ? cur + '-day streak' : 'Streak lapsed, best ' + num(s.longest, 0),
      text: '🔥 ' + cur });
  }

  function btn(label, o) {
    o = o || {};
    return h('button', {
      type: o.type || 'button', class: ['cx-btn', o.kind, o.sm ? 'sm' : null, o.cls],
      onClick: o.onClick, disabled: o.disabled, title: o.title, 'aria-label': o.aria, id: o.id
    }, label);
  }
  function busy(b, on) {
    if (!b) return;
    b.disabled = !!on;
    if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
  }
  function linkBtn(label, hash, kind) {
    var href = safeHref(hash);
    if (!href) return null;
    return h('a', { class: ['cx-btn', kind || 'secondary', 'sm'], href: href, text: label });
  }

  /* --------------------------------------------------------- messaging -- */

  var toastHost = null;
  function toast(text, kind, silent) {
    if (!text) return;
    if (!toastHost) return;
    var t = h('div', { class: ['cx-toast', kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : null],
      role: silent ? null : (kind === 'err' ? 'alert' : 'status'), 'aria-hidden': silent ? 'true' : null, text: text });
    toastHost.appendChild(t);
    setTimeout(function () { remove(t); }, kind === 'err' ? 6500 : 3600);
  }
  function msgNode() { return h('p', { class: 'cx-msg', role: 'status', 'aria-live': 'polite' }); }
  function say(node, text, kind) {
    if (!node) { if (text) toast(text, kind); return; }
    node.className = 'cx-msg' + (kind ? ' ' + kind : '');
    clear(node);
    if (text) node.textContent = text;
  }
  function fail(node, err) {
    var m = errText(err);
    if (isStepUp(err)) {
      var href = str(err.payload.reverify_url) || (site().login_url ? site().login_url + '?reverify=1&next=' + enc(location.pathname + location.hash) : '');
      if (node) {
        say(node, m + ' ', 'warn');
        if (href) node.appendChild(h('a', { class: 'cx-btn sm secondary', href: href, text: 'Re-verify' }));
      } else toast(m, 'warn');
      return;
    }
    if (node) { say(node, m, 'err'); toast(m, 'err', true); }
    else toast(m, 'err');
  }
  function showBanner(tone, text) {
    var b = ROOT && ROOT.querySelector('.cx-banner');
    if (!b) return;
    b.className = 'cx-banner' + (tone && tone !== 'danger' ? ' t-' + tone : '');
    b.textContent = text;
    b.hidden = !text;
  }

  /* --------------------------------------------------- panels and tables -- */

  function panel(o) {
    var titleId = o.title ? uid('cx-p') : null;
    var head = (o.title || o.actions) ? h('div', { class: 'cx-panel-head' },
      h('div', null,
        o.title ? h('h2', { class: 'cx-panel-title', id: titleId }, o.title) : null,
        o.sub ? h('p', { class: 'cx-panel-sub' }, o.sub) : null),
      o.actions ? h('div', { class: 'cx-btn-row' }, o.actions) : null) : null;
    var body = o.flush ? o.body : (o.body === undefined || o.body === null ? null : h('div', { class: 'cx-panel-body' }, o.body));
    return h('section', { class: ['cx-panel', o.cls], 'aria-labelledby': titleId, id: o.id, 'data-group': o.group },
      head, body, o.foot ? h('div', { class: 'cx-panel-foot' }, o.foot) : null);
  }

  function statCard(s) {
    var value = s.value;
    var shown;
    if (value === null || value === undefined || value === '') shown = '—';
    else if (s.format === 'percent') { var p = num(value, 0); p = p > 0 && p <= 1 ? p * 100 : p; shown = Math.round(p) + '%'; }
    else shown = String(value);
    var href = s.href ? safeHref(s.href) : '';
    return h(href ? 'a' : 'div', { class: ['cx-stat', s.tone ? 't-' + s.tone : null], href: href || null },
      h('div', { class: 'cx-stat-label', text: str(s.label) }),
      h('div', { class: 'cx-stat-value', text: shown }),
      s.sub ? h('div', { class: 'cx-stat-sub', text: str(s.sub) }) : null);
  }
  function statGrid(list) {
    if (!list || !list.length) return null;
    return h('div', { class: 'cx-stats' }, map(list, statCard));
  }

  /**
   * cols: [{label, cls, lead}] ; items ; rowFn(item) -> {cells:[...], onOpen, dim, label}
   * Cells carry data-label so phones can show them as stacked cards.
   */
  function table(cols, items, rowFn, emptyText) {
    var thead = h('thead', null, h('tr', null, map(cols, function (c) {
      return h('th', { scope: 'col', class: c.cls }, c.label ? c.label : h('span', { class: 'cx-sr', text: c.sr || 'Actions' }));
    })));
    var tbody = h('tbody');
    if (!items || !items.length) {
      tbody.appendChild(h('tr', null, h('td', { class: 'cx-empty', colspan: cols.length }, emptyText || 'Nothing here yet.')));
    }
    each(items, function (it) {
      var r = rowFn(it);
      var tr = h('tr', { class: [r.onOpen ? 'cx-click' : null, r.dim ? 'cx-dim' : null], tabindex: r.onOpen ? '0' : null,
        'aria-label': r.onOpen && r.label ? r.label : null });
      each(cols, function (c, i) {
        var cell = r.cells[i];
        var isLead = !!c.lead;
        var tag = isLead ? 'th' : 'td';
        var td = h(tag, { scope: isLead ? 'row' : null, class: [c.cls, isLead ? 'cx-lead' : null], 'data-label': c.label || '' });
        if (c.cls === 'cx-actions') append(td, cell);
        else td.appendChild(h('span', { class: 'cx-cellbox' }, cell === null || cell === undefined || cell === '' ? faint('—') : cell));
        tr.appendChild(td);
      });
      if (r.onOpen) {
        tr.addEventListener('click', function (e) {
          if (e.target.closest && e.target.closest('button, a, input, select, textarea, label')) return;
          r.onOpen();
        });
        tr.addEventListener('keydown', function (e) {
          if (e.target !== tr) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); r.onOpen(); }
        });
      }
      tbody.appendChild(tr);
    });
    return h('div', { class: 'cx-table-wrap' }, h('table', { class: 'cx-table' }, thead, tbody));
  }

  function kv(pairs) {
    var dl = h('dl', { class: 'cx-kv' });
    each(pairs, function (p) {
      if (!p) return;
      var v = p[1];
      if (v === undefined || v === null || v === '') return;
      dl.appendChild(h('div', null, h('dt', { text: p[0] }),
        h('dd', null, typeof v === 'string' || typeof v === 'number' ? txt(v) : v)));
    });
    return dl;
  }
  function valueText(v) {
    if (v === null || v === undefined || v === '') return '—';
    if (v === true) return 'Yes';
    if (v === false) return 'No';
    if (isArr(v)) return v.length ? map(v, function (x) { return typeof x === 'object' ? JSON.stringify(x) : String(x); }).join(', ') : '—';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    return String(v);
  }
  function sectionsBlock(sections) {
    if (!sections || !sections.length) return null;
    return h('div', null, map(sections, function (s) {
      return h('div', { class: 'cx-kv-section' }, h('h4', { text: str(s.title) }),
        kv(map(s.rows || [], function (r) { return [str(r[0]), h('span', { class: 'cx-break', text: valueText(r[1]) })]; })));
    }));
  }

  function loading(n) {
    var w = h('div', { 'aria-busy': 'true', 'aria-label': 'Loading' });
    for (var i = 0; i < (n || 3); i++) w.appendChild(h('div', { class: ['cx-skel', i === 0 ? 'block' : null] }));
    return w;
  }
  function errorBlock(err, retry) {
    var m = msgNode();
    var box = panel({ body: [m, retry ? h('div', { class: 'cx-form-actions' }, btn('Try again', { kind: 'secondary', sm: true, onClick: retry })) : null] });
    fail(m, err);
    return box;
  }
  function empty(title, body) {
    return h('div', { class: 'cx-empty' }, h('strong', { text: title }), body ? txt(body) : null);
  }
  function callout(tone, title, body, action) {
    return h('div', { class: ['cx-callout', tone ? 't-' + tone : null] },
      h('div', null, title ? h('span', { class: 'cx-callout-title', text: title }) : null, body ? h('p', null, body) : null),
      action || null);
  }
  function oneTime(title, value, note) {
    var code = h('code', { text: value });
    var m = h('span', { class: 'cx-small cx-muted', role: 'status', 'aria-live': 'polite' });
    var copy = btn('Copy', { kind: 'secondary', sm: true, onClick: function () {
      var done = function () { m.textContent = 'Copied.'; };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(done, function () { m.textContent = 'Select it and copy by hand.'; });
        else m.textContent = 'Select it and copy by hand.';
      } catch (e) { m.textContent = 'Select it and copy by hand.'; }
    } });
    return h('div', { class: 'cx-once', role: 'region', 'aria-label': title },
      h('strong', { text: title }),
      h('div', { class: 'cx-once-value' }, code, copy, m),
      h('p', { class: 'cx-hint', text: note || 'Shown once. It cannot be read back after you leave this page.' }));
  }
  function downloadLink(label, path) {
    return h('a', { class: 'cx-btn secondary sm', href: apiUrl(path), download: '', text: label });
  }

  /* ------------------------------------------------------- form fields -- */

  /**
   * One typed control for a Field / settings item:
   * { key, label, type, value, options, description, placeholder, min, max, step, unit, editable, optional }
   * Returns { node, input, get(), set(v), error(msg) }.
   */
  function control(f, o) {
    o = o || {};
    var id = uid('cx-f');
    var type = str(f.type, 'text');
    var editable = f.editable !== false && !o.readonly;
    var hintId = f.description ? id + '-h' : null;
    var errNode = h('p', { class: 'cx-field-error', id: id + '-e', hidden: true });
    var input, get, set, wrapClass = 'cx-field';
    var describedBy = filter([hintId, id + '-e'], Boolean).join(' ');

    if (type === 'bool') {
      input = h('input', { type: 'checkbox', id: id, role: 'switch', disabled: !editable, 'aria-describedby': describedBy });
      get = function () { return !!input.checked; };
      set = function (v) { input.checked = v === true || v === 1 || v === '1' || v === 'true'; };
    } else if (type === 'select' || type === 'timezone' && f.options) {
      input = h('select', { id: id, disabled: !editable, 'aria-describedby': describedBy },
        map(f.options || [], function (op) { return h('option', { value: str(op.value), text: str(op.label, op.value) }); }));
      get = function () {
        var op = find(f.options || [], function (x) { return str(x.value) === input.value; });
        return op ? op.value : input.value;
      };
      set = function (v) { input.value = str(v); };
    } else if (type === 'radio') {
      input = h('div', { class: 'cx-check-list', role: 'radiogroup', id: id, 'aria-describedby': describedBy });
      var radios = [];
      each(f.options || [], function (op) {
        var r = h('input', { type: 'radio', name: id, value: str(op.value), disabled: !editable });
        radios.push(r);
        input.appendChild(h('label', { class: 'cx-check' }, r,
          h('span', null, h('strong', { text: str(op.label, op.value) }),
            op.description ? h('span', { class: 'cx-cell-sub', text: op.description }) : null)));
      });
      get = function () { var r = find(radios, function (x) { return x.checked; }); if (!r) return null; var op = find(f.options, function (x) { return str(x.value) === r.value; }); return op ? op.value : r.value; };
      set = function (v) { each(radios, function (r) { r.checked = r.value === str(v); }); };
      wrapClass += ' cx-span';
    } else if (type === 'multiselect') {
      input = h('div', { class: 'cx-check-list', role: 'group', id: id, 'aria-describedby': describedBy });
      var boxes = [];
      each(f.options || [], function (op) {
        var c = h('input', { type: 'checkbox', value: str(op.value), disabled: !editable });
        boxes.push([c, op.value]);
        input.appendChild(h('label', { class: 'cx-check' }, c, h('span', { text: str(op.label, op.value) })));
      });
      get = function () { return map(filter(boxes, function (b) { return b[0].checked; }), function (b) { return b[1]; }); };
      set = function (v) { var vs = map(isArr(v) ? v : [], String); each(boxes, function (b) { b[0].checked = contains(vs, String(b[1])); }); };
      wrapClass += ' cx-span';
    } else if (type === 'textarea' || type === 'text' && f.multiline) {
      input = h('textarea', { id: id, disabled: !editable, placeholder: f.placeholder, maxlength: f.maxlength, 'aria-describedby': describedBy });
      get = function () { return input.value; };
      set = function (v) { input.value = str(v); };
      wrapClass += ' cx-span';
    } else if (type === 'countries') {
      input = h('input', { type: 'text', id: id, disabled: !editable, placeholder: f.placeholder || 'US, CA', autocapitalize: 'characters', spellcheck: 'false', 'aria-describedby': describedBy });
      get = function () { return countryList(input.value); };
      set = function (v) { input.value = (isArr(v) ? v : countryList(v)).join(', '); };
    } else if (type === 'readonly') {
      input = h('span', { class: 'cx-mono', id: id });
      get = function () { return f.value; };
      set = function (v) { input.textContent = valueText(v); };
    } else {
      var itype = type === 'int' || type === 'number' || type === 'duration' ? 'number'
        : type === 'email' ? 'email' : type === 'tel' ? 'tel' : type === 'password' ? 'password'
        : type === 'date' ? 'date' : 'text';
      input = h('input', {
        type: itype, id: id, disabled: !editable, placeholder: f.placeholder, maxlength: f.maxlength,
        min: f.min, max: f.max, step: f.step || (type === 'int' || type === 'duration' ? 1 : null),
        inputmode: type === 'int' ? 'numeric' : null, autocomplete: f.autocomplete || 'off',
        spellcheck: itype === 'text' ? null : 'false', 'aria-describedby': describedBy, required: o.required && !f.optional
      });
      get = function () {
        if (itype === 'number') { var s = input.value.trim(); return s === '' ? null : Number(s); }
        if (itype === 'date') return input.value || null;
        return input.value;
      };
      set = function (v) { input.value = itype === 'date' ? (v ? (String(v).length > 10 ? isoDate(v) : String(v)) : '') : str(v); };
    }
    set(f.value);

    var label = h('label', { for: type === 'radio' || type === 'multiselect' || type === 'readonly' ? null : id },
      str(f.label, f.key), f.optional ? h('span', { class: 'cx-opt', text: ' (optional)' }) : null);
    if (type === 'radio' || type === 'multiselect') { label = h('span', { class: 'cx-label', id: id + '-l', text: str(f.label, f.key) }); input.setAttribute('aria-labelledby', id + '-l'); }
    var hint = f.description && !o.noHint ? h('p', { class: 'cx-hint', id: hintId, text: f.description }) : null;
    var node;
    if (type === 'bool' && !o.bare) {
      node = h('div', { class: 'cx-field' },
        h('label', { class: 'cx-check', for: id }, input, h('span', null, h('strong', { text: str(f.label, f.key) }))),
        hint, errNode);
    } else {
      node = h('div', { class: wrapClass }, label, input, f.unit ? h('span', { class: 'cx-hint', text: f.unit }) : null, hint, errNode);
    }
    return {
      node: node, input: input, get: get, set: set, field: f,
      error: function (msg) {
        errNode.textContent = msg || '';
        errNode.hidden = !msg;
        if (input.setAttribute) { if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
      }
    };
  }
  function countryList(v) {
    if (isArr(v)) return map(v, function (x) { return String(x).toUpperCase(); });
    return filter(map(String(v || '').toUpperCase().split(/[^A-Z]+/), function (s) { return s; }), function (s) { return /^[A-Z]{2}$/.test(s); });
  }
  function sameValue(a, b) {
    if (isArr(a) || isArr(b)) return JSON.stringify(a || []) === JSON.stringify(b || []);
    if (typeof a === 'boolean' || typeof b === 'boolean') return !!a === !!b;
    return str(a) === str(b);
  }
  function showErrors(ctrls, err, msg) {
    each(ctrls, function (c) { c.error(''); });
    var hit = false;
    if (err && err.fields) {
      for (var k in err.fields) {
        var c = find(ctrls, function (x) { return x.field.key === k; });
        if (c) { c.error(str(err.fields[k])); hit = true; }
      }
    }
    if (err && err.field) {
      var c1 = find(ctrls, function (x) { return x.field.key === err.field; });
      if (c1) { c1.error(err.message); hit = true; try { c1.input.focus(); } catch (e) { /* ignore */ } }
    }
    if (msg !== false) fail(msg, err);
    return hit;
  }

  /* ----------------------------------------------------- modals/drawers -- */

  var layers = [];
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function layer(o) {
    var prev = document.activeElement;
    var titleId = uid('cx-dlg');
    var titleEl = h('h2', { id: titleId, tabindex: '-1', text: str(o.title) });
    var L;
    var closeBtn = h('button', { type: 'button', class: 'cx-x', 'aria-label': 'Close', onClick: function () { L.close(null); } }, '×');
    var body = h('div', { class: 'cx-modal-body' });
    var foot = h('div', { class: 'cx-modal-foot', hidden: !!o.noFoot });
    var box = h('div', { class: ['cx-modal', o.wide ? 'wide' : null], role: o.alert ? 'alertdialog' : 'dialog',
      'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'cx-modal-head' }, titleEl, closeBtn), body, foot);
    var ov = h('div', { class: ['cx-overlay', o.drawer ? 'drawer' : null] }, box);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) L.close(null); });
    ov.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); L.close(null); return; }
      if (e.key !== 'Tab') return;
      var f = box.querySelectorAll(FOCUSABLE);
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    L = {
      el: box, body: body, foot: foot, closed: false,
      setTitle: function (t) { titleEl.textContent = t; },
      close: function (result) {
        if (L.closed) return;
        L.closed = true;
        remove(ov);
        layers.splice(layers.indexOf(L), 1);
        if (!layers.length) document.documentElement.style.overflow = '';
        if (o.onClose) o.onClose(result);
        try { if (prev && prev.focus && document.body.contains(prev)) prev.focus(); } catch (e) { /* ignore */ }
      }
    };
    ROOT.appendChild(ov);
    layers.push(L);
    document.documentElement.style.overflow = 'hidden';
    setTimeout(function () {
      var f = box.querySelector('[data-autofocus]') || titleEl;
      try { f.focus(); } catch (e) { /* ignore */ }
    }, 0);
    return L;
  }
  function closeAllLayers() { while (layers.length) layers[layers.length - 1].close(null); }

  /**
   * Every destructive action goes through here.
   * o: {title, body, confirmLabel, danger, input:{label, placeholder, value, required, type, options, description},
   *     check:{label, checked}, typeToConfirm}
   * Resolves null when cancelled, else {value, checked}.
   */
  function confirmDialog(o) {
    return new Promise(function (resolve) {
      var answered = false;
      var L = layer({ title: o.title, alert: true, onClose: function (r) { if (!answered) resolve(null); } });
      if (o.body) L.body.appendChild(typeof o.body === 'string' ? h('p', { text: o.body }) : o.body);
      var ctrl = null, check = null, typed = null;
      if (o.input) {
        ctrl = control(assign({ key: 'value', type: 'text' }, o.input), { required: o.input.required });
        L.body.appendChild(h('div', { style: { marginTop: '12px' } }, ctrl.node));
        if (ctrl.input.setAttribute) ctrl.input.setAttribute('data-autofocus', '1');
      }
      if (o.check) {
        check = h('input', { type: 'checkbox', checked: !!o.check.checked });
        L.body.appendChild(h('label', { class: 'cx-check', style: { marginTop: '12px' } }, check, h('span', { text: o.check.label })));
      }
      if (o.typeToConfirm) {
        typed = control({ key: 'typed', type: 'text', label: 'Type ' + o.typeToConfirm + ' to confirm' });
        L.body.appendChild(h('div', { style: { marginTop: '12px' } }, typed.node));
      }
      var cancel = btn('Cancel', { kind: 'secondary', onClick: function () { L.close(null); } });
      var ok = btn(o.confirmLabel || 'Confirm', { kind: o.danger ? 'danger' : null, onClick: function () {
        if (typed && String(typed.get()).trim() !== String(o.typeToConfirm)) { typed.error('That does not match.'); return; }
        if (ctrl && o.input.required) {
          var v = ctrl.get();
          if (v === null || String(v).trim() === '') { ctrl.error('This is required.'); return; }
        }
        answered = true;
        resolve({ value: ctrl ? ctrl.get() : null, checked: check ? check.checked : null });
        L.close(true);
      } });
      if (!ctrl && !typed) ok.setAttribute('data-autofocus', '1');
      L.foot.appendChild(cancel);
      L.foot.appendChild(ok);
    });
  }

  /**
   * A form in a modal. fields: [Field]; submit(values) -> Promise; resolves with its result.
   * The modal stays open on error and shows the server's sentence under the field it names.
   */
  function formDialog(o) {
    return new Promise(function (resolve) {
      var done = false;
      var L = layer({ title: o.title, wide: o.wide, onClose: function () { if (!done) resolve(null); } });
      if (o.intro) L.body.appendChild(h('p', { class: 'cx-muted', text: o.intro }));
      var ctrls = map(filter(o.fields, Boolean), function (f) { return control(f, { required: !f.optional }); });
      var form = h('form', { class: 'cx-form-grid', novalidate: true }, map(ctrls, function (c) { return c.node; }));
      if (o.extra) form.appendChild(h('div', { class: 'cx-span' }, o.extra));
      var msg = msgNode();
      L.body.appendChild(form);
      L.body.appendChild(msg);
      if (ctrls[0] && ctrls[0].input.setAttribute) ctrls[0].input.setAttribute('data-autofocus', '1');
      var submit = btn(o.submitLabel || 'Save', { kind: o.danger ? 'danger' : null });
      var cancel = btn('Cancel', { kind: 'secondary', onClick: function () { L.close(null); } });
      function go(e) {
        if (e) e.preventDefault();
        var values = {};
        var bad = false;
        each(ctrls, function (c) {
          c.error('');
          var v = c.get();
          if (!c.field.optional && c.field.type !== 'bool' && c.field.type !== 'multiselect' && c.field.required !== false &&
              (v === null || v === undefined || String(v).trim() === '')) { c.error('This is required.'); bad = true; }
          values[c.field.key] = v;
        });
        if (bad) { say(msg, 'Fill in the fields marked above.', 'err'); return; }
        busy(submit, true);
        say(msg, 'Saving…', 'muted');
        then(o.submit(values), function (res) {
          done = true;
          L.close(true);
          resolve(res === undefined ? true : res);
        }, function (err) {
          busy(submit, false);
          showErrors(ctrls, err, msg);
        });
      }
      form.addEventListener('submit', go);
      submit.addEventListener('click', go);
      L.foot.appendChild(cancel);
      L.foot.appendChild(submit);
    });
  }

  /** Show a one-time secret in its own modal. */
  function showOnce(title, value, note) {
    var L = layer({ title: title });
    L.body.appendChild(oneTime(title, value, note));
    L.foot.appendChild(btn('I have saved it', { onClick: function () { L.close(true); } }));
  }

  /**
   * A button that runs one action: optional confirm, busy state, the server's
   * sentence on failure, a message on success, then `after`.
   * o: {kind, sm, confirm: {...}|fn, run(answer) -> Promise, done: string|fn(res, answer), after(res), msg}
   */
  function act(label, o) {
    var b = btn(label, { kind: o.kind || 'secondary', sm: o.sm !== false, title: o.title, aria: o.aria });
    b.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      var c = o.confirm;
      if (typeof c === 'function') { c = c(); if (!c) return; }
      var p = c ? confirmDialog(assign({ danger: o.kind === 'danger' || o.kind === 'ghost-danger' }, c)) : Promise.resolve({});
      p.then(function (ans) {
        if (!ans) return null;
        busy(b, true);
        if (o.msg) say(o.msg, 'Working on it…', 'muted');
        return then(o.run(ans), function (res) {
          var t = typeof o.done === 'function' ? o.done(res, ans) : (o.done || 'Done.');
          if (o.msg) { say(o.msg, t, 'ok'); toast(t, 'ok', true); } else toast(t, 'ok');
          busy(b, false);
          if (o.after) return o.after(res, ans);
          return null;
        }, function (err) {
          busy(b, false);
          fail(o.msg, err);
        });
      });
    });
    return b;
  }

  /** A switch that saves itself (WAMV toggles). */
  function liveSwitch(o) {
    var input = h('input', { type: 'checkbox', role: 'switch', checked: !!o.value, disabled: !!o.disabled, 'aria-label': o.label });
    var wrap = h('span', { class: ['cx-switch', o.danger ? 'danger' : null] }, input, h('span', { class: 'cx-slider', 'aria-hidden': 'true' }));
    input.addEventListener('change', function () {
      var next = input.checked;
      var c = o.confirm ? o.confirm(next) : null;
      var p = c ? confirmDialog(c) : Promise.resolve({});
      p.then(function (ans) {
        if (!ans) { input.checked = !next; return; }
        input.disabled = true;
        then(o.run(next), function (res) {
          input.disabled = false;
          var t = typeof o.done === 'function' ? o.done(next, res) : (o.done || 'Saved.');
          if (o.msg) { say(o.msg, t, 'ok'); toast(t, 'ok', true); } else toast(t, 'ok');
          if (o.after) o.after(next, res);
        }, function (err) {
          input.disabled = false;
          input.checked = !next;
          fail(o.msg, err);
        });
      });
    });
    return wrap;
  }

  /** Paged list loader: keeps items + cursor; `more` button appears while there is more. */
  function pager(fetchPage, onItems) {
    var P = { items: [], next: null, total: null, loading: false, extra: null };
    var moreBtn = btn('Load more', { kind: 'secondary', sm: true });
    var count = h('span');
    var foot = h('div', { class: 'cx-table-foot' }, count, moreBtn);
    function paint() {
      moreBtn.hidden = !P.next;
      count.textContent = P.total !== null && P.total !== undefined && P.total !== P.items.length
        ? 'Showing ' + P.items.length + ' of ' + P.total : (P.items.length ? 'Showing ' + P.items.length : '');
    }
    function load(appendMode) {
      if (P.loading) return Promise.resolve();
      P.loading = true;
      busy(moreBtn, true);
      return then(fetchPage(appendMode ? P.next : null), function (res) {
        P.loading = false;
        busy(moreBtn, false);
        var items = res.items || [];
        P.items = appendMode ? P.items.concat(items) : items;
        P.next = res.next_cursor || null;
        P.total = res.total === undefined ? null : res.total;
        P.extra = res;
        paint();
        onItems(P.items, res, appendMode);
      }, function (err) {
        P.loading = false;
        busy(moreBtn, false);
        throw err;
      });
    }
    moreBtn.addEventListener('click', function () { load(true).then(null, function (e) { fail(null, e); }); });
    P.load = load;
    P.foot = foot;
    paint();
    return P;
  }

  /* ============================================================ sections == */

  var SECTIONS = [
    { key: 'overview', group: 'Overview', label: 'Overview', feature: 'overview', perm: 'overview.view',
      title: 'Overview',
      intro: 'Where things stand right now: who is on the books, what is waiting for you, and anything in the security set-up that wants attention. Every number links to the page that explains it.' },
    { key: 'people', group: 'Management', label: 'People', feature: 'people', perm: 'people.view',
      title: 'People',
      intro: function () { return 'Everyone with an account' + (feat('invitations') ? ', including people who have not accepted their invitation yet' : '') + '. Pick someone to see their whole record — identity, access, sign-in methods, sessions, devices and streak — and the buttons that change it. Every change is written to the audit log under your name.'; } },
    { key: 'roles', group: 'Management', label: 'Roles & permissions', feature: 'roles', perm: 'roles.view',
      title: 'Roles & permissions',
      intro: 'A role is a named set of permissions. Give people a role instead of ticking boxes one by one; editing a role changes everyone who holds it at once.' },
    { key: 'invitations', group: 'Management', label: 'Invitations', feature: 'invitations', perm: 'invites.view',
      title: 'Invitations',
      intro: 'An invitation is a single-use link that lets someone set their own password. The link is shown once, when it is created — the server keeps only a hash of it, so nobody, including you, can read it back later.' },
    { key: 'streaks', group: 'Management', label: 'Streaks', feature: 'streaks', perm: 'streaks.view',
      title: 'Streaks',
      intro: 'How many days in a row each person has signed in. You can set someone’s streak or give them extra courtesy restores for this month; neither uses up the restores they get on their own. Every change is audited and sends a security alert.' },
    { key: 'settings', group: 'Management', label: 'Settings', feature: 'settings', perm: 'settings.view',
      title: 'Settings',
      intro: 'The rules this site runs on. Nothing changes until you save it, every change is written to the audit log, and every change sends a security alert.' },
    { key: 'security', group: 'Access control', label: 'Security', feature: 'security', perm: 'security.view',
      title: 'Security',
      intro: 'Every address that has reached the site, refused or allowed, grouped and scored, worst first. A score is a hint for you; an address is blocked on its own only by the auto-blacklist rules, and those entries appear on the Deny list with their evidence.' },
    { key: 'ips', group: 'Access control', label: 'IP allowlist', feature: 'ip_allowlist', perm: 'ips.view',
      title: 'IP allowlist',
      intro: 'Addresses and ranges that may reach the sign-in page. Being on this list does not exempt an address from detection: one that misbehaves is taken off it and blocked automatically. The server refuses any change that would cut off the address you are using now.' },
    { key: 'deny', group: 'Access control', label: 'Deny list', feature: 'deny_list', perm: 'ips.view',
      title: 'Deny list',
      intro: 'Addresses refused outright. Entries you add are marked Manual; entries the system added after suspicious activity are marked Auto and carry the evidence that triggered them. Unblocking an auto entry can put it straight back on the allowlist.' },
    { key: 'country', group: 'Access control', label: 'Country rule', feature: 'country_rule', perm: 'ips.view',
      title: 'Country rule',
      intro: 'Which countries may reach the site. It never overrides the IP allowlist, it never blocks an address whose country could not be determined, and an empty list means no rule at all — not “allow nobody”.' },
    { key: 'devices', group: 'Access control', label: 'Devices', feature: 'devices', perm: 'devices.view',
      title: 'Devices',
      intro: 'Every browser that has carried this site’s device cookie. Approving one is a promise that you know whose machine it is; blocking one turns it away before the password box.' },
    { key: 'sessions', group: 'Access control', label: 'Sessions', feature: 'sessions', perm: 'sessions.view',
      title: 'Sessions',
      intro: 'Who is signed in right now, where from, and on what. Revoking a session ends it on its next request — there is no grace period.' },
    { key: 'audit', group: 'Records', label: 'Audit log', feature: 'audit', perm: 'audit.view',
      title: 'Audit log',
      intro: 'Every change anyone made, and every sign-in, refusal and failure. Open an entry to see exactly what changed; entries that can be undone carry a Revert button.' },
    { key: 'alerts', group: 'Records', label: 'Security alerts', feature: 'alerts', perm: 'alerts.view',
      title: 'Security alerts',
      intro: 'Every security alert email this site has tried to send: what happened, who it went to, and whether it was delivered, failed, or folded into a later email by the throttle.' }
  ];
  var SEC_BY_KEY = {};
  each(SECTIONS, function (s) { SEC_BY_KEY[s.key] = s; });

  function sectionAvailable(s) {
    if (!s || !BOOT) return false;
    if (!feat(s.feature)) return false;
    if (s.key === 'overview') return has('overview.view') || keysOf(PERMS).length > 0;
    return has(s.perm);
  }
  function keysOf(o) { var out = []; for (var k in o) if (hasOwn.call(o, k)) out.push(k); return out; }
  function firstAvailable() { return find(SECTIONS, sectionAvailable); }
  function brandName() {
    var b = CFG.brand;
    if (b && typeof b === 'object') b = b.name;
    return str(b, str(site().name, 'Admin') + ' Console');
  }

  /* ================================================================ shell == */

  var NAV_LINKS = {};
  function buildShell() {
    clear(ROOT);
    if (ROOT.className.indexOf('cx') === -1) ROOT.className = (ROOT.className ? ROOT.className + ' ' : '') + 'cx';
    var banner = h('div', { class: 'cx-banner', role: 'status', hidden: true });
    ROOT.appendChild(banner);

    var nav = h('nav', { class: 'cx-nav', 'aria-label': 'Console sections' });
    var lastGroup = null;
    each(SECTIONS, function (s) {
      if (!sectionAvailable(s)) return;
      if (s.group !== lastGroup) {
        lastGroup = s.group;
        nav.appendChild(h('div', { class: 'cx-nav-group', 'aria-hidden': 'true', text: s.group }));
      }
      var count = BOOT.counts && num(BOOT.counts[s.key], 0) ? h('span', { class: 'cx-nav-count', text: String(num(BOOT.counts[s.key], 0)), 'aria-label': num(BOOT.counts[s.key], 0) + ' waiting' }) : null;
      var a = h('a', { href: '#' + s.key, 'data-section': s.key }, h('span', { text: s.label }), count);
      NAV_LINKS[s.key] = a;
      nav.appendChild(a);
    });
    var outs = [];
    var home = CFG.homeUrl || site().home_url;
    each(BOOT.links || [], function (l) {
      var href = safeHref(l.href);
      if (href) outs.push(h('a', { class: 'cx-out', href: href }, h('span', { text: str(l.label, href) })));
    });
    if (home && safeHref(home)) outs.push(h('a', { class: 'cx-out', href: home }, h('span', { text: 'Back to the site' })));
    if (outs.length) {
      nav.appendChild(h('div', { class: 'cx-nav-group', 'aria-hidden': 'true', text: 'Go to' }));
      append(nav, outs);
    }

    var m = me();
    var signout = h('button', { type: 'button', class: 'cx-signout', onClick: signOut }, 'Sign out');
    var side = h('aside', { class: 'cx-side', id: 'cx-side', 'aria-label': 'Console navigation' },
      h('a', { class: 'cx-brand', href: '#' + ((firstAvailable() || {}).key || '') },
        txt(brandName()), site().domain ? h('small', { text: site().domain }) : null),
      h('div', { class: 'cx-account' },
        h('span', { class: ['cx-avatar', BOOT.is_owner ? 't-danger' : 't-info'], 'aria-hidden': 'true', text: initials(m.name || m.username) }),
        h('div', { class: 'cx-account-who' },
          h('div', { class: 'cx-account-name', text: str(m.name || m.username || m.email, 'Signed in') }),
          h('div', { class: 'cx-account-role', text: str(m.role_label || m.role, BOOT.is_owner ? 'Owner' : 'Admin') })),
        signout),
      nav,
      h('div', { class: 'cx-side-foot', text: 'Console kit ' + VERSION }));

    var menuBtn = h('button', { type: 'button', class: 'cx-menu-btn', 'aria-label': 'Open the menu', 'aria-controls': 'cx-side',
      'aria-expanded': 'false', onClick: function () { setMenu(!APP.classList.contains('menu-open')); } }, '☰');
    var stamp = h('span', { class: 'cx-stamp', id: 'cx-stamp', 'aria-live': 'off' });
    var refresh = btn('Refresh', { kind: 'secondary', sm: true, id: 'cx-refresh', onClick: refreshNow });
    VIEW = h('div', { id: 'cx-view' });
    var main = h('main', { class: 'cx-main', id: 'cx-main' },
      h('div', { class: 'cx-topbar' },
        h('div', { class: 'cx-topbar-left' }, menuBtn,
          h('div', { class: 'cx-eyebrow', text: str(site().name, brandName()) + (site().domain ? ' · ' + site().domain : '') })),
        h('div', { class: 'cx-refresh' }, stamp, refresh)),
      VIEW);
    var backdrop = h('div', { class: 'cx-backdrop', onClick: function () { setMenu(false); } });
    APP = h('div', { class: 'cx-app' }, side, backdrop, main);
    ROOT.appendChild(APP);
    toastHost = h('div', { class: 'cx-toast-host', 'aria-live': 'polite' });
    ROOT.appendChild(toastHost);

    side.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a')) setMenu(false); });
    side.addEventListener('keydown', function (e) { if (e.key === 'Escape') { setMenu(false); menuBtn.focus(); } });
    if (BOOT.banner && BOOT.banner.text) showBanner(BOOT.banner.tone || 'danger', BOOT.banner.text);
    APP._menuBtn = menuBtn;
    setInterval(paintStamp, 1000);
  }

  function setMenu(open) {
    if (!APP) return;
    APP.classList.toggle('menu-open', !!open);
    var b = APP._menuBtn;
    if (b) { b.setAttribute('aria-expanded', open ? 'true' : 'false'); b.setAttribute('aria-label', open ? 'Close the menu' : 'Open the menu'); }
    if (open) { var first = ROOT.querySelector('.cx-side a'); if (first) try { first.focus(); } catch (e) { /* ignore */ } }
  }

  function signOut() {
    var s = site();
    var dest = CFG.signOutUrl || s.login_url || '/';
    if (!s.sign_out_url) { location.assign(dest); return; }
    var headers = { 'X-Requested-With': 'console', 'Accept': 'application/json' };
    if (BOOT && BOOT.csrf_token) headers['X-CSRF-Token'] = String(BOOT.csrf_token);
    fetch(s.sign_out_url, { method: 'POST', credentials: 'same-origin', headers: headers })
      .then(function () { location.assign(dest); }, function () { location.assign(dest); });
  }

  function paintStamp() {
    var el = document.getElementById('cx-stamp');
    if (!el) return;
    el.textContent = STATE.loadedAt ? 'Updated ' + fmtAgo(STATE.loadedAt) : '';
  }
  function refreshNow() {
    var s = SEC_BY_KEY[STATE.section];
    if (!s) return;
    var b = document.getElementById('cx-refresh');
    busy(b, true);
    renderSection(s, STATE.route, false);
    setTimeout(function () { busy(b, false); }, 400);
  }

  /* =============================================================== router == */

  function parseHash() {
    var raw = String(location.hash || '').replace(/^#\/?/, '');
    var q = '';
    var i = raw.indexOf('?');
    if (i >= 0) { q = raw.slice(i + 1); raw = raw.slice(0, i); }
    var parts = map(filter(raw.split('/'), Boolean), dec);
    var params = {};
    each(q.split('&'), function (kvp) {
      if (!kvp) return;
      var j = kvp.indexOf('=');
      params[dec(j < 0 ? kvp : kvp.slice(0, j))] = j < 0 ? '' : dec(kvp.slice(j + 1).replace(/\+/g, ' '));
    });
    return { section: parts[0] || '', parts: parts.slice(1), params: params };
  }
  function hashFor(section, parts, params) {
    var p = filter(parts || [], function (x) { return x !== null && x !== undefined && x !== ''; });
    return '#' + section + (p.length ? '/' + map(p, enc).join('/') : '') + qs(params || {});
  }
  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }
  function quietHash(hash) {
    try { history.replaceState(null, '', hash); } catch (e) { /* ignore */ }
    STATE.route = parseHash();
  }

  function route() {
    var r = parseHash();
    var s = SEC_BY_KEY[r.section];
    if (!sectionAvailable(s)) {
      s = firstAvailable();
      if (!s) { renderNoAccess(); return; }
      r = { section: s.key, parts: [], params: {} };
      quietHash('#' + s.key);
    }
    setMenu(false);
    closeAllLayers();
    for (var k in NAV_LINKS) {
      if (!hasOwn.call(NAV_LINKS, k)) continue;
      if (k === s.key) NAV_LINKS[k].setAttribute('aria-current', 'page'); else NAV_LINKS[k].removeAttribute('aria-current');
    }
    var same = STATE.section === s.key && STATE.ctx && s.update;
    STATE.route = r;
    if (same) { s.update(STATE.ctx, r); return; }
    STATE.section = s.key;
    renderSection(s, r, STATE.navigated);
    STATE.navigated = true;
  }

  function renderSection(s, r, focusTitle) {
    clear(VIEW);
    STATE.loadedAt = 0;
    paintStamp();
    var title = h('h1', { tabindex: '-1', text: s.title });
    var intro = h('p', { text: typeof s.intro === 'function' ? s.intro() : s.intro });
    var actions = h('div', { class: 'cx-page-actions' });
    var body = h('div', { class: 'cx-page-body' });
    var page = h('div', { class: 'cx-page', 'data-section': s.key },
      h('div', { class: 'cx-page-head' }, h('div', null, title, intro), actions), body);
    VIEW.appendChild(page);
    document.title = s.title + ' — ' + brandName();
    var ctx = {
      key: s.key, page: page, body: body, actions: actions, intro: intro, route: r,
      ready: function () { STATE.loadedAt = Date.now(); paintStamp(); page.setAttribute('data-ready', '1'); },
      alive: function () { return STATE.ctx === ctx; }
    };
    STATE.ctx = ctx;
    if (focusTitle) { try { title.focus({ preventScroll: false }); } catch (e) { title.focus(); } }
    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    try { s.render(ctx, r); }
    catch (err) { replace(body, errorBlock(err, refreshNow)); }
  }

  function renderNoAccess() {
    clear(VIEW);
    VIEW.appendChild(h('div', { class: 'cx-page' },
      h('div', { class: 'cx-page-head' }, h('div', null, h('h1', { text: 'Nothing to show' }),
        h('p', { text: 'Your account is signed in but holds no permission that opens a section of this console. Ask an administrator for the access you need.' })))));
  }

  /** Standard load: skeleton, fetch, render or error-with-retry. */
  function load(ctx, promise, render) {
    var host = ctx.body;
    replace(host, loading(4));
    return then(promise, function (res) {
      if (!ctx.alive()) return;
      clear(host);
      render(res);
      ctx.ready();
    }, function (err) {
      if (!ctx.alive()) return;
      replace(host, errorBlock(err, refreshNow));
      ctx.ready();
    });
  }

  /* ============================================================ overview == */

  SEC_BY_KEY.overview.render = function (ctx) {
    load(ctx, api('GET', '/overview'), function (d) {
      append(ctx.body, statGrid(d.stats));
      var queue = filter(d.queue || [], function (q) { return num(q.count, 0) > 0; });
      if (queue.length) {
        ctx.body.appendChild(h('div', { style: { marginBottom: '18px' } }, map(queue, function (q) {
          var href = safeHref(q.href);
          return callout(q.tone || 'warn', num(q.count, 0) + ' · ' + str(q.label), q.detail || null,
            href ? h('a', { class: 'cx-btn secondary sm', href: href, text: 'Work the queue' }) : null);
        })));
      }
      var posture = (d.posture || []).slice();
      var rank = { danger: 0, warn: 1, ok: 2 };
      posture.sort(function (a, b) { return (rank[a.severity] === undefined ? 1 : rank[a.severity]) - (rank[b.severity] === undefined ? 1 : rank[b.severity]); });
      var problems = filter(posture, function (p) { return p.severity !== 'ok'; }).length;
      var pBody = posture.length ? h('ul', { class: 'cx-posture' }, map(posture, function (p) {
        var sev = p.severity === 'danger' ? 'danger' : p.severity === 'ok' ? 'ok' : 'warn';
        var href = safeHref(p.href);
        return h('li', null,
          h('span', { class: ['cx-posture-icon', sev !== 'ok' ? 't-' + sev : null], 'aria-hidden': 'true', text: sev === 'ok' ? '✓' : sev === 'danger' ? '×' : '!' }),
          h('div', { class: 'cx-posture-text' },
            h('strong', null, h('span', { class: 'cx-sr', text: sev === 'ok' ? 'Fine: ' : sev === 'danger' ? 'Problem: ' : 'Warning: ' }), txt(p.title)),
            p.detail ? h('span', { text: p.detail }) : null),
          href ? h('a', { class: 'cx-btn secondary sm', href: href, text: 'Take me there' }) : null);
      })) : h('p', { class: 'cx-muted', text: 'The server did not report any posture checks.' });
      var postureP = panel({ title: 'Security posture', sub: problems ? plural(problems, 'thing') + ' to look at' : 'All clear', body: pBody });

      var eventsHost = h('div');
      var eventsP = panel({ title: 'Recent security events', sub: 'Failures, refusals and warnings only. Successes live in the audit log.', flush: true, body: eventsHost,
        actions: sectionAvailable(SEC_BY_KEY.audit) ? [linkBtn('Open the audit log', '#audit')] : null });
      function paintEvents(list) {
        replace(eventsHost, list && list.length ? h('ul', { class: 'cx-feed' }, map(list.slice(0, 15), auditLine))
          : h('div', { class: 'cx-empty', text: 'No refusals, failures or warnings on record. Quiet is the correct state.' }));
      }
      if (d.events) paintEvents(d.events);
      else if (sectionAvailable(SEC_BY_KEY.audit)) {
        replace(eventsHost, loading(2));
        then(api('GET', '/events' + qs({ limit: 15 })), function (r) { paintEvents(r.items || []); }, function () { paintEvents([]); });
      } else paintEvents([]);
      ctx.body.appendChild(h('div', { class: 'cx-grid-2' }, postureP, eventsP));
    });
  };

  /** One audit entry as a feed line (overview, record activity, audit log). */
  function auditLine(e, opts) {
    opts = opts || {};
    var actor = e.actor ? str(e.actor.name || e.actor.username, '#' + e.actor.id) : 'System';
    var target = e.target ? str(e.target.label || e.target.id) : '';
    var li = h('li', { class: [e.reverted_at ? 'cx-reverted' : null, opts.onOpen ? 'cx-click' : null], tabindex: opts.onOpen ? '0' : null },
      h('div', { class: 'cx-feed-main' },
        h('div', { class: 'cx-chips' },
          e.severity && e.severity !== 'info' ? statusBadge(e.severity) : null,
          e.outcome && e.outcome !== 'success' ? statusBadge(e.outcome) : null,
          h('strong', { class: 'cx-mono', text: str(e.action, 'event') }),
          e.reverted_at ? badge('Reverted', 'muted') : null),
        e.detail ? h('div', { text: e.detail, style: { marginTop: '3px' } }) : null,
        h('div', { class: 'cx-feed-meta', text: filter([actor + (target ? ' → ' + target : ''), e.ip ? str(e.ip) : '', e.country ? str(e.country) : ''], Boolean).join(' · ') })),
      h('div', { class: 'cx-feed-side' }, opts.side || null, h('span', { class: 'cx-feed-time' }, when(e.ts))));
    if (opts.onOpen) {
      li.addEventListener('click', function (ev) { if (ev.target.closest && ev.target.closest('button, a')) return; opts.onOpen(e); });
      li.addEventListener('keydown', function (ev) { if (ev.target === li && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); opts.onOpen(e); } });
    }
    return li;
  }

  /* ============================================================== people == */

  var PEOPLE = { filters: { q: '', status: '', role: '', group: '', flag: '' }, meta: null, pager: null,
    listEl: null, countEl: null, dirEl: null, recordEl: null, recordId: null, record: null, tab: 'profile', seq: 0 };
  var MFA_ORDER = ['passkey', 'totp', 'email', 'sms', 'recovery'];
  var MFA_LABEL = { passkey: 'Passkey', totp: 'Authenticator app', email: 'Email code', sms: 'Text message', recovery: 'Recovery codes' };
  var FLAG_OPTIONS = [
    { value: '', label: 'Any flag' }, { value: 'mfa_missing', label: 'No second factor' },
    { value: 'locked', label: 'Locked' }, { value: 'must_change', label: 'Must change password' },
    { value: 'online', label: 'Signed in now' }
  ];

  function allowed(d, key) { return !!(d && d.actions && d.actions[key] && d.actions[key].allowed); }
  function reasonFor(d, key) { return d && d.actions && d.actions[key] && !d.actions[key].allowed ? str(d.actions[key].reason) : ''; }
  function personName(p) { return str(p && (p.name || p.username || p.email), p && p.id ? noun() + ' #' + p.id : 'Unknown'); }
  function avatar(p, big) {
    var tone = p && p.role && p.role.tone ? p.role.tone : 'muted';
    return h('span', { class: ['cx-avatar', big ? 'lg' : null, tone !== 'muted' ? 't-' + tone : null], 'aria-hidden': 'true', text: initials(personName(p)) });
  }
  function mfaMark(p) {
    if (!p || !isArr(p.mfa)) return null;
    if (!p.mfa.length) return h('span', { class: 'cx-badge t-warn', title: 'No second factor', text: 'No MFA' });
    var first = find(MFA_ORDER, function (k) { return contains(p.mfa, k); }) || p.mfa[0];
    return h('span', { class: 'cx-badge', title: 'Second factors: ' + map(p.mfa, function (k) { return MFA_LABEL[k] || k; }).join(', '), text: first === 'passkey' ? 'Passkey' : first === 'totp' ? 'App' : MFA_LABEL[first] || first });
  }

  SEC_BY_KEY.people.render = function (ctx, r) {
    var P = PEOPLE;
    P.filters.q = str(r.params.q); P.filters.status = str(r.params.status); P.filters.role = str(r.params.role);
    P.filters.group = str(r.params.group); P.filters.flag = str(r.params.flag);
    P.record = null; P.recordId = null;

    if (feat('people_create') && has('people.create')) ctx.actions.appendChild(btn('Add ' + noun(), { onClick: addPerson }));
    if (sectionAvailable(SEC_BY_KEY.invitations) && has('invites.manage')) ctx.actions.appendChild(linkBtn('Invite someone', '#invitations?new=1'));

    var search = h('input', { type: 'search', class: 'cx-search', placeholder: 'Search name, username, email, phone…', 'aria-label': 'Search ' + noun(true), value: P.filters.q, autocomplete: 'off', spellcheck: 'false', maxlength: '120' });
    var statusSel = h('select', { 'aria-label': 'Filter by status' }, h('option', { value: '', text: 'Any status' }));
    var roleSel = h('select', { 'aria-label': 'Filter by role' }, h('option', { value: '', text: 'Any role' }));
    var groupSel = h('select', { 'aria-label': 'Filter by group', hidden: true }, h('option', { value: '', text: 'Any group' }));
    var flagSel = h('select', { 'aria-label': 'Filter by flag' }, map(FLAG_OPTIONS, function (o) { return h('option', { value: o.value, text: o.label }); }));
    flagSel.value = P.filters.flag;
    var toolbar = h('div', { class: 'cx-toolbar', role: 'search' }, search, statusSel, roleSel, groupSel, flagSel);

    P.countEl = h('span', { text: cap1(noun(true)) });
    P.listEl = h('ul', { class: 'cx-people-list', 'aria-label': cap1(noun(true)) });
    var listMsg = msgNode();
    P.pager = pager(function (cursor) {
      return api('GET', '/people' + qs(assign({ limit: 50, cursor: cursor }, P.filters)));
    }, function (items, res) {
      if (res.filters && !P.meta) fillFilters(res.filters);
      paintList(items);
    });
    var listPane = h('aside', { class: 'cx-people', 'aria-label': cap1(noun(true)) + ' list' },
      h('div', { class: 'cx-people-head' }, P.countEl, h('span', { class: 'cx-sr', role: 'status', 'aria-live': 'polite' })),
      P.listEl, h('div', { class: 'cx-people-more' }, P.pager.foot), listMsg);
    P.recordEl = h('div', { class: 'cx-record', 'aria-live': 'off' });
    P.dirEl = h('div', { class: 'cx-dir' }, listPane, P.recordEl);
    P.toolbarEl = toolbar;
    ctx.body.appendChild(toolbar);
    ctx.body.appendChild(P.dirEl);

    function fillFilters(f) {
      P.meta = f;
      each(f.statuses || [], function (o) { statusSel.appendChild(h('option', { value: str(o.value), text: str(o.label, o.value) })); });
      each(f.roles || [], function (o) { roleSel.appendChild(h('option', { value: str(o.value), text: str(o.label, o.value) })); });
      // No roles on this site (or none sent): a filter with only "Any role" is a dead control.
      roleSel.hidden = !(f.roles && f.roles.length);
      if (f.group && f.group.options && f.group.options.length) {
        groupSel.hidden = false;
        groupSel.options[0].textContent = 'Any ' + str(f.group.label, 'group').toLowerCase();
        groupSel.setAttribute('aria-label', 'Filter by ' + str(f.group.label, 'group').toLowerCase());
        each(f.group.options, function (o) { groupSel.appendChild(h('option', { value: str(o.value), text: str(o.label, o.value) })); });
      }
      statusSel.value = P.filters.status; roleSel.value = P.filters.role; groupSel.value = P.filters.group;
    }
    function reload() {
      replace(P.listEl, h('li', null, loading(3)));
      P.pager.load(false).then(function () { ctx.ready(); }, function (err) {
        replace(P.listEl, h('li', null, errorBlock(err, reload)));
        ctx.ready();
      });
    }
    P.reloadList = reload;
    var refilter = function () {
      P.filters.q = search.value.trim(); P.filters.status = statusSel.value; P.filters.role = roleSel.value;
      P.filters.group = groupSel.value; P.filters.flag = flagSel.value;
      quietHash(hashFor('people', P.recordId ? [P.recordId] : [], P.filters));
      reload();
    };
    search.addEventListener('input', debounce(refilter, 250));
    each([statusSel, roleSel, groupSel, flagSel], function (s) { s.addEventListener('change', refilter); });
    reload();
    SEC_BY_KEY.people.update(ctx, r);
  };

  function paintList(items) {
    var P = PEOPLE;
    var total = P.pager.total;
    P.countEl.textContent = total !== null && total !== undefined ? plural(total, noun(), noun(true)) : plural(items.length, noun(), noun(true));
    if (!items.length) {
      replace(P.listEl, h('li', null, empty('Nobody matches that.', 'Clear the search and filters to see everyone.')));
      return;
    }
    replace(P.listEl, map(items, function (p) {
      var st = statusInfo(p.status);
      var sub = filter([p.username && p.username !== p.name ? '@' + p.username : '', p.email || '', p.group || ''], Boolean)[0] || st[0];
      var a = h('a', { class: 'cx-person-row', href: '#people/' + enc(p.id), 'aria-current': String(p.id) === String(P.recordId) ? 'true' : null, 'data-id': String(p.id) },
        avatar(p),
        h('div', { class: 'cx-who' },
          h('div', { class: 'cx-nm', text: personName(p) }),
          h('div', { class: 'cx-sub' },
            h('span', { class: ['cx-dot', p.online ? 't-ok' : (st[1] === 'danger' ? 't-danger' : st[1] === 'warn' ? 't-warn' : null)], 'aria-hidden': 'true' }),
            h('span', { class: 'cx-sr', text: p.online ? 'Signed in now. ' : '' }),
            h('span', { text: p.status && p.status !== 'active' ? st[0] + ' · ' + sub : sub }))),
        h('div', { class: 'cx-marks' }, flame(p.streak), mfaMark(p)));
      var li = h('li', null, a);
      return li;
    }));
  }
  function markSelected() {
    var rows = PEOPLE.listEl ? PEOPLE.listEl.querySelectorAll('.cx-person-row') : [];
    each(rows, function (a) {
      if (a.getAttribute('data-id') === String(PEOPLE.recordId)) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    });
  }

  SEC_BY_KEY.people.update = function (ctx, r) {
    var P = PEOPLE;
    var id = r.parts[0] || null;
    var tab = r.parts[1] || null;
    if (!id) {
      P.recordId = null; P.record = null;
      P.dirEl.classList.remove('has-record');
      P.toolbarEl.classList.remove('cx-hide-narrow');
      replace(P.recordEl, h('div', { class: 'cx-record-empty' }, 'Pick ' + (/^[aeiou]/i.test(noun()) ? 'an ' : 'a ') + noun() + ' on the left to see their whole record.'));
      markSelected();
      return;
    }
    if (tab) P.tab = tab;
    P.dirEl.classList.add('has-record');
    P.toolbarEl.classList.add('cx-hide-narrow');
    if (String(id) === String(P.recordId) && P.record) { renderRecord(P.record); return; }
    openRecord(id);
  };

  function openRecord(id, keepScroll) {
    var P = PEOPLE;
    P.recordId = id;
    var seq = ++P.seq;
    markSelected();
    if (!keepScroll) replace(P.recordEl, loading(5));
    return then(api('GET', '/people/' + enc(id)), function (d) {
      if (seq !== P.seq) return;
      P.record = d;
      renderRecord(d);
      if (!keepScroll && window.innerWidth <= 1180) { try { P.recordEl.scrollIntoView({ block: 'start' }); } catch (e) { /* ignore */ } }
    }, function (err) {
      if (seq !== P.seq) return;
      replace(P.recordEl, h('div', null, backLink(), errorBlock(err, function () { openRecord(id); })));
    });
  }
  function reloadRecord() {
    var p1 = PEOPLE.recordId ? openRecord(PEOPLE.recordId, true) : Promise.resolve();
    if (PEOPLE.reloadList) PEOPLE.pager.load(false).then(null, function () { /* list error shows on next reload */ });
    return p1;
  }
  function backLink() {
    return h('a', { class: 'cx-btn secondary sm cx-back', href: hashFor('people', [], PEOPLE.filters) }, '← All ' + noun(true));
  }

  /* --------------------------------------------------------- the record -- */

  var RECORD_TABS = [
    { key: 'profile', label: 'Profile', show: function () { return true; }, build: tabProfile },
    { key: 'access', label: 'Access', show: function (d) { return !!(d.access || d.permissions); }, build: tabAccess },
    { key: 'signin', label: 'Sign-in & MFA', show: function () { return true; }, build: tabSignin },
    { key: 'sessions', label: 'Sessions & devices', show: function (d) { return !!(d.sessions || d.devices); }, build: tabSessions },
    { key: 'addresses', label: 'Addresses', show: function (d) { return !!(d.ips || allowed(d, 'ip_allow') || allowed(d, 'ip_block')); }, build: tabAddresses },
    { key: 'streak', label: 'Streak', show: function (d) { return feat('streaks') && !!d.streak; }, build: tabStreak },
    { key: 'activity', label: 'Activity', show: function (d) { return !!d.activity; }, build: tabActivity }
  ];

  function renderRecord(d) {
    var P = PEOPLE;
    var p = d.person || {};
    var tabs = filter(RECORD_TABS, function (t) { return t.show(d); });
    if (!find(tabs, function (t) { return t.key === P.tab; })) P.tab = 'profile';
    var msg = msgNode();
    var chips = h('div', { class: 'cx-chips' },
      roleBadge(p.role), statusBadge(p.status),
      p.online ? badge('Signed in now', 'ok') : null,
      p.must_change_password ? badge('Must change password', 'warn') : null,
      p.locked_until ? badge('Locked until ' + fmtFull(p.locked_until), 'danger') : null,
      isMe(p.id) ? badge('You', 'info') : null);
    var subBits = filter([p.username ? '@' + p.username : '', p.email || '', p.staff_id ? str(site().staff_id_label, 'ID') + ' ' + p.staff_id : '',
      p.created_at ? 'since ' + fmtDay(p.created_at) : ''], Boolean);
    var hero = h('div', { class: 'cx-hero' },
      avatar(p, true),
      h('div', { class: 'cx-grow' }, h('h2', { text: personName(p), tabindex: '-1', id: 'cx-record-name' }),
        h('div', { class: 'cx-sub', text: subBits.join(' · ') })),
      chips);

    var tablist = h('div', { class: 'cx-tabs', role: 'tablist', 'aria-label': 'Record sections' });
    var panes = h('div');
    var buttons = [];
    var ctx = { d: d, p: p, msg: msg, reload: reloadRecord };
    each(tabs, function (t) {
      var tid = 'cx-tab-' + t.key, pid = 'cx-pane-' + t.key;
      var b = h('button', { type: 'button', class: 'cx-tab', role: 'tab', id: tid, 'aria-controls': pid,
        'aria-selected': t.key === P.tab ? 'true' : 'false', tabindex: t.key === P.tab ? '0' : '-1', text: t.label });
      var pane = h('div', { role: 'tabpanel', id: pid, 'aria-labelledby': tid, hidden: t.key !== P.tab, tabindex: '-1' });
      var built = false;
      function build() { if (built) return; built = true; try { append(pane, t.build(ctx)); } catch (e) { pane.appendChild(errorBlock(e)); } }
      if (t.key === P.tab) build();
      b.addEventListener('click', function () { select(t.key); });
      b.addEventListener('keydown', function (e) {
        var i = indexOfTab(t.key);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          var n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
          select(n.key); document.getElementById('cx-tab-' + n.key).focus();
        }
      });
      buttons.push({ key: t.key, b: b, pane: pane, build: build });
      tablist.appendChild(b);
      panes.appendChild(pane);
    });
    function indexOfTab(k) { for (var i = 0; i < tabs.length; i++) if (tabs[i].key === k) return i; return 0; }
    function select(k) {
      P.tab = k;
      each(buttons, function (x) {
        var on = x.key === k;
        x.b.setAttribute('aria-selected', on ? 'true' : 'false');
        x.b.setAttribute('tabindex', on ? '0' : '-1');
        x.pane.hidden = !on;
        if (on) x.build();
      });
      quietHash(hashFor('people', [P.recordId, k === 'profile' ? null : k], PEOPLE.filters));
    }
    replace(P.recordEl, backLink(), hero, msg, tablist, panes);
  }

  /* --- Profile ------------------------------------------------------------ */
  function tabProfile(c) {
    var d = c.d, p = c.p;
    var out = [];
    out.push(panel({ title: 'Identity', body: kv([
      ['Name', str(p.name)], ['Username', str(p.username)], ['Email', str(p.email)], ['Phone', str(p.phone)],
      [str(site().staff_id_label, 'Staff ID'), str(p.staff_id)],
      ['Role', p.role ? roleBadge(p.role) : null], ['Status', h('span', null, statusBadge(p.status), p.status_reason ? h('span', { class: 'cx-cell-sub', text: p.status_reason }) : null)],
      [str(d.group_label || (PEOPLE.meta && PEOPLE.meta.group && PEOPLE.meta.group.label), 'Group'), str(p.group)],
      ['Account since', p.created_at ? fmtFull(p.created_at) : null],
      ['Last seen', p.last_seen_at ? when(p.last_seen_at) : null],
      ['Last sign-in', p.last_login_at ? h('span', null, when(p.last_login_at), p.last_login_ip ? h('span', { class: 'cx-cell-sub cx-mono', text: p.last_login_ip }) : null) : 'never'],
      ['Password changed', p.password_changed_at ? fmtFull(p.password_changed_at) : null],
      ['Failed sign-ins', p.failed_logins !== undefined && p.failed_logins !== null ? String(p.failed_logins) : null],
      ['Locked until', p.locked_until ? fmtFull(p.locked_until) : null],
      ['Notes', str(p.notes)]
    ]) }));

    if (d.fields && d.fields.length && allowed(d, 'edit')) {
      var ctrls = map(d.fields, function (f) { return control(f); });
      var m = msgNode();
      var save = btn('Save details', { onClick: function () {
        var patch = {}, n = 0;
        each(ctrls, function (ct) {
          if (ct.field.editable === false) return;
          var v = ct.get();
          if (!sameValue(v, ct.field.value)) { patch[ct.field.key] = v; n += 1; }
          ct.error('');
        });
        if (!n) { say(m, 'Nothing has changed.', 'muted'); return; }
        busy(save, true);
        then(api('PATCH', '/people/' + enc(p.id), patch), function () {
          busy(save, false); say(m, 'Saved ' + plural(n, 'change') + '.', 'ok'); toast('Details saved.', 'ok', true); c.reload();
        }, function (err) { busy(save, false); showErrors(ctrls, err, m); });
      } });
      out.push(panel({ title: 'Edit details', sub: 'Only the fields you change are sent. Each change is audited.',
        body: [h('div', { class: 'cx-form-grid' }, map(ctrls, function (x) { return x.node; })), h('div', { class: 'cx-form-actions' }, save), m] }));
    } else if (reasonFor(d, 'edit')) out.push(callout('info', null, reasonFor(d, 'edit')));

    if (feat('people_email') && allowed(d, 'email')) {
      var subj = control({ key: 'subject', label: 'Subject', type: 'text', maxlength: 200 });
      var body = control({ key: 'body', label: 'Message', type: 'textarea', description: 'Plain text. It goes from the site’s normal mail sender and is recorded in the audit log.' });
      var em = msgNode();
      var send = act('Send email', {
        kind: null, sm: false, msg: em,
        confirm: function () {
          if (!String(subj.get()).trim() || !String(body.get()).trim()) { say(em, 'Write a subject and a message first.', 'err'); return null; }
          return { title: 'Send this email to ' + personName(p) + '?', body: 'It goes to ' + str(p.email, 'their address on file') + '.', confirmLabel: 'Send it' };
        },
        run: function () { return api('POST', '/people/' + enc(p.id) + '/email', { subject: subj.get(), body: body.get() }); },
        done: function (res) { subj.set(''); body.set(''); return res && res.delivery === 'queued' ? 'Queued for delivery.' : 'Sent.'; }
      });
      out.push(panel({ title: 'Send an email', sub: p.email ? 'To ' + p.email : null,
        body: [h('div', { class: 'cx-form-grid' }, subj.node, body.node), h('div', { class: 'cx-form-actions' }, send), em] }));
    }
    return out;
  }

  /* --- Access ------------------------------------------------------------- */
  function tabAccess(c) {
    var d = c.d, p = c.p, a = d.access || {}, out = [];
    var at = a.account_type;
    if (feat('people_account_type') && at) {
      if (at.editable && allowed(d, 'account_type') && at.options && at.options.length) {
        var sel = control({ key: 'account_type', label: 'Account type', type: 'select', value: at.value, options: at.options });
        var desc = h('ul', { class: 'cx-evidence' }, map(at.options, function (o) {
          return o.description ? h('li', null, h('strong', { text: str(o.label, o.value) + ': ' }), txt(o.description)) : null;
        }));
        var m1 = msgNode();
        out.push(panel({ title: 'Account type', sub: a.note || null, body: [
          h('div', { class: 'cx-form-row' }, sel.node,
            act('Change account type', { kind: null, sm: false, msg: m1,
              confirm: function () {
                var v = sel.get();
                if (sameValue(v, at.value)) { say(m1, 'That is already their account type.', 'muted'); return null; }
                var op = find(at.options, function (o) { return str(o.value) === str(v); }) || {};
                return { title: 'Change ' + personName(p) + ' to ' + str(op.label, v) + '?', body: str(op.description, 'What they can reach changes immediately.'), confirmLabel: 'Change it' };
              },
              run: function () { return api('POST', '/people/' + enc(p.id) + '/account-type', { value: sel.get() }); },
              done: 'Account type changed.', after: c.reload })),
          desc, m1] }));
      } else {
        out.push(panel({ title: 'Account type', body: [h('p', null, badge(str(at.label, at.value), 'info')), reasonFor(d, 'account_type') ? h('p', { class: 'cx-hint', text: reasonFor(d, 'account_type') }) : null] }));
      }
    }

    if (a.role_options) {
      var current = map(a.roles || [], function (x) { return str(x.id); });
      var editable = a.editable !== false && allowed(d, 'role');
      var ctrl = a.multi || feat('people_multi_role')
        ? control({ key: 'roles', label: 'Roles', type: 'multiselect', value: current, editable: editable,
          options: map(a.role_options, function (o) { return { value: str(o.id), label: str(o.name) + (o.rank !== undefined && o.rank !== null ? ' · rank ' + o.rank : '') }; }) })
        : control({ key: 'roles', label: 'Role', type: 'select', value: current[0] || '', editable: editable,
          options: [{ value: '', label: '— No role —' }].concat(map(a.role_options, function (o) { return { value: str(o.id), label: str(o.name) + (o.rank !== undefined && o.rank !== null ? ' · rank ' + o.rank : '') }; })) });
      var m2 = msgNode();
      var body = [ctrl.node];
      var expC = null;
      if (feat('people_role_expiry') && editable) {
        expC = control({ key: 'role_expires_at', label: 'Roles added now expire on', type: 'date', optional: true,
          hint: 'For an acting or temporary role. Leave blank to make it permanent. Roles already held keep their own date.' });
        body.push(expC.node);
      }
      var dated = filter(a.roles || [], function (x) { return x.expires_at; });
      if (dated.length) body.push(h('ul', { class: 'cx-evidence' }, map(dated, function (x) { return h('li', { text: str(x.name, x.id) + ' — until ' + fmtDay(x.expires_at) }); })));
      if (editable) {
        body.push(h('div', { class: 'cx-form-actions' }, act('Save role', { kind: null, sm: false, msg: m2,
          confirm: function () {
            var v = ctrl.get();
            var ids = isArr(v) ? v : (v ? [v] : []);
            if (sameValue(ids.slice().sort(), current.slice().sort())) { say(m2, 'Nothing has changed.', 'muted'); return null; }
            var names = map(ids, function (id) { var o = find(a.role_options, function (x) { return str(x.id) === id; }); return o ? o.name : id; });
            return { title: 'Change the role' + (a.multi ? 's' : '') + ' for ' + personName(p) + '?',
              body: names.length ? 'They will hold: ' + names.join(', ') + '. What they can reach changes immediately.' : 'They will hold no role, and only keep what is granted to them individually.',
              confirmLabel: 'Save' };
          },
          run: function () { var v = ctrl.get(); var b = { role_ids: isArr(v) ? v : (v ? [v] : []) };
            if (expC && expC.get()) b.expires_at = expC.get();
            return api('POST', '/people/' + enc(p.id) + '/roles', b); },
          done: 'Role saved.', after: c.reload })));
      } else if (reasonFor(d, 'role')) body.push(h('p', { class: 'cx-hint', text: reasonFor(d, 'role') }));
      body.push(m2);
      out.push(panel({ title: a.multi ? 'Roles' : 'Role', sub: a.note || 'While a role is set it decides most of what this ' + noun() + ' may do; editing the role moves everyone holding it.', body: body }));
    }

    if (feat('people_permissions') && d.permissions) out.push(permissionsPanel(c));
    if (!out.length) out.push(panel({ body: h('p', { class: 'cx-muted', text: 'This site does not manage access per ' + noun() + '.' }) }));
    return out;
  }

  var SRC_LABEL = { role: 'by role', grant: 'granted here', flag: 'by flag', account: 'by account type', deny: 'denied here' };
  function permissionsPanel(c) {
    var d = c.d, p = c.p, P = d.permissions;
    var mode = P.mode === 'flags' ? 'flags' : 'grants';
    var editable = P.editable !== false && allowed(d, 'permissions');
    var eff = {};
    each(P.effective || [], function (e) { eff[e.key] = e; });
    var grants = map(P.grants || [], String), denies = map(P.denies || [], String);
    var state = {};
    var groups = [];
    var byGroup = {};
    each(P.catalog || [], function (cat) {
      var g = str(cat.group, 'General');
      if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
      byGroup[g].push(cat);
      var e = eff[cat.key] || {};
      state[cat.key] = { on: !!e.granted, src: e.source || null, inRole: e.source === 'role' || e.source === 'deny' };
    });
    var granted = filter(P.catalog || [], function (x) { return state[x.key].on; }).length;
    var dirty = false;
    var m = msgNode();
    function srcNode(k) {
      var s = state[k];
      if (!s.on) return h('span', { class: 'cx-faint cx-small', text: s.src === 'deny' ? 'denied here' : 'not granted' });
      return badge(SRC_LABEL[s.src] || (s.src ? s.src : 'granted'), s.src === 'grant' || s.src === 'flag' ? 'info' : s.src === 'account' ? 'danger' : 'ok');
    }
    var body = h('div', null, map(groups, function (g) {
      return h('div', { class: 'cx-perm-group', role: 'group', 'aria-label': g },
        h('h4', { text: g }),
        h('div', { class: 'cx-perm-grid' }, map(byGroup[g], function (cat) {
          var s = state[cat.key];
          var locked = !editable || s.src === 'account';
          var box = h('input', { type: 'checkbox', checked: s.on, disabled: locked });
          var srcHost = h('div', { class: 'cx-perm-src' }, srcNode(cat.key));
          box.addEventListener('change', function () {
            dirty = true;
            s.on = box.checked;
            if (mode === 'grants') {
              if (box.checked) { denies = filter(denies, function (k) { return k !== cat.key; }); if (!s.inRole && !contains(grants, cat.key)) grants.push(cat.key); s.src = s.inRole ? 'role' : 'grant'; }
              else { grants = filter(grants, function (k) { return k !== cat.key; }); if (s.inRole && !contains(denies, cat.key)) denies.push(cat.key); s.src = s.inRole ? 'deny' : null; }
            } else s.src = box.checked ? 'flag' : null;
            replace(srcHost, srcNode(cat.key));
          });
          return h('label', { class: ['cx-perm', locked ? 'locked' : null] }, box,
            h('span', { class: 'cx-perm-text' }, h('strong', null, txt(str(cat.label, cat.key)), cat.danger ? txt(' ') : null, cat.danger ? badge('high risk', 'danger') : null),
              h('span', { class: 'cx-mono', text: cat.key }), srcHost));
        })));
    }));
    var actions = [];
    if (editable) {
      actions.push(act('Save permissions', { kind: null, sm: false, msg: m,
        confirm: function () {
          if (!dirty) { say(m, 'No permission changed.', 'muted'); return null; }
          return { title: 'Save permissions for ' + personName(p) + '?', body: mode === 'grants'
            ? grants.length + ' granted and ' + denies.length + ' denied on top of their role.'
            : 'They will hold exactly the ' + filter(P.catalog, function (x) { return state[x.key].on; }).length + ' ticked permission(s).', confirmLabel: 'Save' };
        },
        run: function () {
          return api('POST', '/people/' + enc(p.id) + '/permissions', mode === 'grants' ? { grants: grants, denies: denies }
            : { permissions: map(filter(P.catalog, function (x) { return state[x.key].on; }), function (x) { return x.key; }) });
        },
        done: 'Permissions saved.', after: c.reload }));
      if (mode === 'grants' && (grants.length || denies.length)) {
        actions.push(act('Back to the role alone', { msg: m,
          confirm: { title: 'Clear every individual grant and deny?', body: 'They fall back to exactly what their role carries.', confirmLabel: 'Clear them' },
          run: function () { return api('POST', '/people/' + enc(p.id) + '/permissions', { grants: [], denies: [] }); },
          done: 'Back to the role alone.', after: c.reload }));
      }
    }
    return panel({ title: 'Permissions · ' + granted + ' of ' + (P.catalog || []).length,
      sub: P.note || (editable ? (mode === 'grants' ? 'On top of the role, or carved out of it. Anything you do not hold yourself is refused by the server.' : 'Tick what this ' + noun() + ' may do.') : (reasonFor(d, 'permissions') || 'Read only.')),
      body: [body, actions.length ? h('div', { class: 'cx-form-actions' }, actions) : null, m] });
  }

  /* --- Sign-in & MFA ------------------------------------------------------ */
  function tabSignin(c) {
    var d = c.d, p = c.p, id = enc(p.id), out = [];
    var base = '/people/' + id;
    var m = c.msg;
    var stateMsg = msgNode();

    // Account state and lifecycle
    var acts = [];
    var st = str(p.status);
    if (st !== 'active' && allowed(d, 'activate')) acts.push(act(st === 'invited' ? 'Activate' : 'Reinstate', { kind: null, msg: stateMsg,
      confirm: { title: 'Reinstate ' + personName(p) + '?', body: 'They get their account back as it was, including their role and second factors.', confirmLabel: 'Reinstate' },
      run: function () { return api('POST', base + '/status', { status: 'active' }); }, done: 'Reinstated. They can sign in again.', after: c.reload }));
    if (st !== 'suspended' && allowed(d, 'suspend')) acts.push(act('Suspend', { kind: 'ghost-danger', msg: stateMsg,
      confirm: { title: 'Suspend ' + personName(p) + '?', body: 'Every session ends and the password stops working. The record, devices and audit trail stay.', confirmLabel: 'Suspend', danger: true,
        input: { label: 'Reason', type: 'text', placeholder: 'Shown to them at sign-in and kept in the audit log', optional: true } },
      run: function (ans) { return api('POST', base + '/status', { status: 'suspended', reason: ans.value || '' }); }, done: 'Suspended. Their sessions are gone.', after: c.reload }));
    if (feat('people_lock') && !p.locked_until && allowed(d, 'lock')) acts.push(act('Lock', { kind: 'ghost-danger', msg: stateMsg,
      confirm: { title: 'Lock ' + personName(p) + '?', body: 'Sign-in is refused until the lock runs out or someone unlocks it.', confirmLabel: 'Lock', danger: true,
        input: { label: 'For how long', type: 'select', value: '60', options: [{ value: '15', label: '15 minutes' }, { value: '60', label: '1 hour' }, { value: '1440', label: '24 hours' }, { value: '', label: 'Until unlocked' }] } },
      run: function (ans) { return api('POST', base + '/lock', { minutes: ans.value ? Number(ans.value) : null }); }, done: 'Locked.', after: c.reload }));
    if ((p.locked_until || st === 'locked' || num(p.failed_logins, 0) > 0) && allowed(d, 'unlock')) acts.push(act('Unlock', { msg: stateMsg,
      confirm: { title: 'Unlock ' + personName(p) + '?', body: 'Clears the lock and sets the failed sign-in count back to zero.', confirmLabel: 'Unlock' },
      run: function () { return api('POST', base + '/unlock', {}); }, done: 'Unlocked.', after: c.reload }));
    if (feat('people_disable') && st !== 'disabled' && allowed(d, 'disable')) acts.push(act('Disable', { kind: 'ghost-danger', msg: stateMsg,
      confirm: { title: 'Disable ' + personName(p) + '?', body: 'A disabled account is kept for the record but can never sign in until reinstated.', confirmLabel: 'Disable', danger: true,
        input: { label: 'Reason', type: 'text', optional: true } },
      run: function (ans) { return api('POST', base + '/status', { status: 'disabled', reason: ans.value || '' }); }, done: 'Disabled.', after: c.reload }));
    if (feat('people_delete') && allowed(d, 'delete')) acts.push(act('Delete', { kind: 'danger', msg: stateMsg,
      confirm: { title: 'Delete ' + personName(p) + '?', body: 'The account, its sign-in methods and sessions go. The audit log keeps what they did. Suspending is almost always the better answer.', confirmLabel: 'Delete for good', danger: true,
        typeToConfirm: str(p.username || p.email || p.name) },
      run: function () { return api('DELETE', base); }, done: 'Deleted.',
      after: function () { PEOPLE.record = null; PEOPLE.recordId = null; go(hashFor('people', [], PEOPLE.filters)); PEOPLE.reloadList && PEOPLE.reloadList(); } }));
    var notes = filter(map(['suspend', 'delete', 'activate'], function (k) { return reasonFor(d, k); }), Boolean);
    var mfaList = isArr(p.mfa) ? p.mfa : [];
    out.push(panel({ title: 'Account state', body: [
      h('div', { class: 'cx-chips', style: { marginBottom: '12px' } }, statusBadge(p.status),
        p.online ? badge('Signed in now', 'ok') : badge('Offline', 'muted'),
        d.sessions ? badge(plural(filter(d.sessions, function (s) { return s.active !== false; }).length, 'live session'), 'muted') : null,
        d.devices ? badge(plural(d.devices.length, 'trusted device'), 'muted') : null,
        mfaList.length ? badge('MFA: ' + map(filter(MFA_ORDER, function (k) { return contains(mfaList, k); }), function (k) { return MFA_LABEL[k]; }).join(', '), 'ok') : badge('No second factor', 'warn'),
        p.status_reason ? badge('Reason: ' + p.status_reason, 'muted') : null),
      acts.length ? h('div', { class: 'cx-btn-row' }, acts) : h('p', { class: 'cx-muted', text: 'You cannot change this account’s state.' }),
      notes.length ? h('ul', { class: 'cx-evidence cx-muted' }, map(notes, function (n) { return h('li', { text: n }); })) : null,
      stateMsg] }));

    // Password
    if (allowed(d, 'reset_password') || allowed(d, 'force_change')) {
      var pm = msgNode();
      var once = h('div');
      var pb = [once];
      if (allowed(d, 'reset_password')) {
        // A site with no e-mailed reset links sets features.password_link:false.
        var linkOk = !(FEAT && FEAT.password_link === false);
        var modeCtl = control({ key: 'mode', label: 'How to hand it over', type: 'radio', value: linkOk ? 'link' : 'temporary', options: [
          linkOk ? { value: 'link', label: 'Email them a one-time reset link', description: 'Nothing secret passes through you.' } : null,
          { value: 'temporary', label: 'Give me a temporary password', description: 'Shown to you once, to read to them.' }].filter(Boolean) });
        var force = h('input', { type: 'checkbox', checked: true });
        pb.push(modeCtl.node);
        pb.push(h('label', { class: 'cx-check', style: { marginTop: '10px' } }, force, h('span', { text: 'Make them choose a new password at their next sign-in' })));
        pb.push(h('div', { class: 'cx-form-actions' }, act('Reset password', { kind: 'ghost-danger', sm: false, msg: pm,
          confirm: { title: 'Reset the password for ' + personName(p) + '?', body: 'Their current password stops working immediately and their sessions end.', confirmLabel: 'Reset it', danger: true },
          run: function () { return api('POST', base + '/password', { mode: modeCtl.get() || 'link', force_change: force.checked }); },
          done: function (res) {
            if (res && res.temporary_password) { replace(once, oneTime('Temporary password', String(res.temporary_password), 'Read it to them; do not email it. It works once.')); return 'Password reset. The temporary password is above.'; }
            if (res && res.link) { replace(once, oneTime('One-time reset link', String(res.link), 'Send it over a channel you trust. It works once.')); return 'Password reset. The link is above.'; }
            return 'Password reset. They have been emailed a link.';
          } })));
      }
      if (allowed(d, 'force_change')) {
        pb.push(h('div', { class: 'cx-set-row', style: { padding: '14px 0 0', marginTop: '14px', borderTop: '1px solid var(--cx-line)' } },
          h('div', null, h('div', { class: 'cx-set-label', text: 'Require a new password at next sign-in' }),
            h('div', { class: 'cx-set-desc', text: 'They keep signing in with the current one until then.' })),
          liveSwitch({ value: !!p.must_change_password, label: 'Require a new password at next sign-in', msg: pm,
            confirm: function (on) { return on ? null : { title: 'Stop requiring a password change?', confirmLabel: 'Stop requiring it' }; },
            run: function (on) { return api('POST', base + '/force-change', { on: on }); },
            done: function (on) { return on ? 'They must change it at next sign-in.' : 'No longer required.'; }, after: function () { c.reload(); } })));
      }
      pb.push(pm);
      out.push(panel({ title: 'Password', sub: p.password_changed_at ? 'Last changed ' + fmtFull(p.password_changed_at) + '.' : null, body: pb }));
    }

    // MFA, canonical order: passkey, totp, email (then anything else)
    var mfa = d.mfa || { methods: [] };
    var mm = msgNode();
    var methods = (mfa.methods || []).slice();
    if (!find(methods, function (x) { return x.kind === 'passkey'; })) methods.push({ kind: 'passkey', enrolled: false, items: [] });
    methods.sort(function (a, b) {
      var ia = MFA_ORDER.indexOf(a.kind), ib = MFA_ORDER.indexOf(b.kind);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    var rows = map(methods, function (meth, i) {
      var label = str(meth.label, MFA_LABEL[meth.kind] || meth.kind);
      var enrolled = !!meth.enrolled || (meth.items && meth.items.length > 0);
      var right = [];
      var stateBadge = meth.kind === 'email' && meth.enabled !== undefined
        ? badge(meth.enabled ? 'On' : 'Off', meth.enabled ? 'ok' : 'muted')
        : badge(enrolled ? 'Set up' : 'Not set up', enrolled ? 'ok' : 'muted');
      if (meth.kind === 'totp' && enrolled && allowed(d, 'totp_reset')) right.push(act('Reset', { kind: 'ghost-danger', msg: mm,
        confirm: { title: 'Reset the authenticator app for ' + personName(p) + '?', body: 'Their current app codes stop working. They set it up again at next sign-in.', confirmLabel: 'Reset it', danger: true },
        run: function () { return api('POST', base + '/mfa/totp/reset', {}); }, done: 'Authenticator app reset.', after: c.reload }));
      if (meth.kind === 'email' && meth.toggle !== false && feat('mfa_email_toggle') && allowed(d, 'email_otp_toggle')) right.push(liveSwitch({
        value: !!meth.enabled, label: 'Email codes for ' + personName(p), msg: mm,
        confirm: function (on) { return on ? null : { title: 'Turn off email codes for ' + personName(p) + '?', body: 'They will need a passkey or authenticator app to finish signing in.', confirmLabel: 'Turn off', danger: true }; },
        run: function (on) { return api('POST', base + '/mfa/email', { enabled: on }); }, done: function (on) { return on ? 'Email codes on.' : 'Email codes off.'; }, after: function () { c.reload(); } }));
      var items = meth.items && meth.items.length ? h('ul', { class: 'cx-mfa-items' }, map(meth.items, function (it) {
        return h('li', null,
          h('span', null, h('strong', { text: str(it.label, 'Unnamed ' + label.toLowerCase()) }),
            h('span', { class: 'cx-cell-sub', text: filter(['added ' + fmtDay(it.created_at), it.last_used_at ? 'last used ' + fmtAgo(it.last_used_at) : 'never used'], Boolean).join(' · ') })),
          meth.kind === 'passkey' && allowed(d, 'passkey_remove') ? act('Remove', { kind: 'ghost-danger', msg: mm,
            confirm: { title: 'Remove the passkey “' + str(it.label, 'unnamed') + '”?', body: 'That device can no longer sign in as ' + personName(p) + '.', confirmLabel: 'Remove it', danger: true },
            run: function () { return api('DELETE', base + '/mfa/passkeys/' + enc(it.id)); }, done: 'Passkey removed.', after: c.reload }) : null);
      })) : null;
      var sub = meth.kind === 'passkey' && !enrolled ? 'Passkey — none set up. Passkey is the default method once they add one.'
        : filter([meth.created_at ? 'set up ' + fmtDay(meth.created_at) : '', meth.detail || ''], Boolean).join(' · ');
      return h('div', { class: 'cx-mfa-row' },
        h('span', { class: 'cx-mfa-order', 'aria-hidden': 'true', text: String(i + 1) }),
        h('div', { class: 'cx-grow' }, h('div', { class: 'cx-chips' }, h('strong', { text: label }), stateBadge, i === 0 ? badge('Default', 'info') : null),
          sub ? h('div', { class: 'cx-cell-sub', text: sub }) : null, items),
        right.length ? h('div', { class: 'cx-btn-row' }, right) : null);
    });
    var mfaBody = [h('div', null, rows)];
    if (feat('mfa_require') && mfa.require_editable !== false && allowed(d, 'mfa_require')) {
      var reqVal = mfa.required_source === 'person' ? (mfa.required ? 'true' : 'false') : 'null';
      var req = control({ key: 'required', label: 'Second factor for this ' + noun(), type: 'select', value: reqVal, options: [
        { value: 'null', label: 'Follow the site policy' + (mfa.required_source !== 'person' ? (mfa.required ? ' (required)' : ' (not required)') : '') },
        { value: 'true', label: 'Always require it' }, { value: 'false', label: 'Do not require it' }] });
      mfaBody.unshift(h('div', { class: 'cx-form-row', style: { marginBottom: '16px' } }, req.node,
        act('Save', { kind: null, sm: false, msg: mm,
          confirm: function () {
            if (req.get() === reqVal) { say(mm, 'Nothing has changed.', 'muted'); return null; }
            return req.get() === 'false' ? { title: 'Stop requiring a second factor for ' + personName(p) + '?', body: 'A password alone will be enough to sign in as them.', confirmLabel: 'Stop requiring it', danger: true } : { title: 'Change the second-factor rule for ' + personName(p) + '?', confirmLabel: 'Save' };
          },
          run: function () { var v = req.get(); return api('POST', base + '/mfa/required', { required: v === 'null' ? null : v === 'true' }); },
          done: 'Second-factor rule saved.', after: c.reload })));
    }
    if (mfa.grace && mfa.grace.length) {
      mfaBody.push(h('div', { style: { marginTop: '14px' } }, h('h4', { text: 'Where they currently skip the code' }),
        h('ul', { class: 'cx-evidence' }, map(mfa.grace, function (g) { return h('li', { text: str(g.label, 'Device') + ' — until ' + fmtFull(g.expires_at) }); }))));
    }
    if (allowed(d, 'mfa_reset')) {
      mfaBody.push(h('div', { class: 'cx-form-actions' }, act('Reset every second factor', { kind: 'danger', sm: false, msg: mm,
        confirm: { title: 'Wipe every second factor for ' + personName(p) + '?', body: 'Passkeys, the authenticator app and recovery codes all go. Only do this when you have spoken to them and know who you are speaking to.', confirmLabel: 'Wipe them', danger: true },
        run: function () { return api('POST', base + '/mfa/reset', {}); },
        done: function (res) { return 'Every factor is gone.' + (res && res.falls_back_to ? ' Codes now go to ' + res.falls_back_to + '.' : ''); }, after: c.reload })));
    }
    mfaBody.push(mm);
    out.push(panel({ title: 'Second factor', sub: 'In the order the sign-in page offers them: passkey, then authenticator app, then email.' + (mfa.required !== undefined ? (mfa.required ? ' Required for this ' + noun() + '.' : ' Not required for this ' + noun() + '.') : ''), body: mfaBody }));

    // Phone numbers for SMS codes
    if (feat('people_phones') && d.phones) out.push(phonesPanel(c));
    return out;
  }

  function phonesPanel(c) {
    var d = c.d, p = c.p, base = '/people/' + enc(p.id) + '/phones';
    var m = msgNode();
    var can_ = allowed(d, 'phones');
    var list = d.phones.length ? h('div', { class: 'cx-check-list' }, map(d.phones, function (ph) {
      return h('div', { class: 'cx-mfa-items' }, h('li', null,
        h('span', null, h('span', { class: 'cx-mono', text: ph.phone }), txt(' '), ph.is_primary ? badge('Primary', 'ok') : null, txt(' '), ph.label ? badge(ph.label, 'muted') : null),
        can_ ? h('span', { class: 'cx-btn-row' },
          ph.is_primary ? null : act('Make primary', { msg: m, run: function () { return api('PATCH', base + '/' + enc(ph.id), { is_primary: true }); }, done: 'Primary number changed.', after: c.reload }),
          act('Remove', { kind: 'ghost-danger', msg: m,
            confirm: { title: 'Remove ' + ph.phone + '?', body: d.phones.length === 1 ? 'It is their only number. They will need a passkey or authenticator to sign in.' : 'Codes will no longer be sent to it.', confirmLabel: 'Remove', danger: true },
            run: function () { return api('DELETE', base + '/' + enc(ph.id)); }, done: 'Number removed.', after: c.reload })) : null));
    })) : h('p', { class: 'cx-muted', text: 'No numbers on file — this account cannot receive a text code.' });
    var add = null;
    if (can_ && d.phones.length < num(d.max_phones, 5)) {
      var num_ = control({ key: 'phone', label: 'Add a number', type: 'tel', placeholder: '+12125551234' });
      var lab = control({ key: 'label', label: 'Label', type: 'text', placeholder: 'Cell, Office', optional: true });
      add = h('div', { class: 'cx-form-row', style: { marginTop: '12px' } }, num_.node, lab.node,
        act('Add', { kind: null, sm: false, msg: m,
          confirm: function () { if (!String(num_.get()).trim()) { num_.error('Enter a number first.'); return null; } return { title: 'Add ' + num_.get() + ' for ' + personName(p) + '?', body: 'Sign-in codes may be sent to it.', confirmLabel: 'Add it' }; },
          run: function () { return api('POST', base, { phone: num_.get(), label: lab.get() }); }, done: 'Number added.', after: c.reload }));
    }
    return panel({ title: 'Numbers for text codes', sub: 'Each one is a place a sign-in code can land.', body: [list, add, m] });
  }

  /* --- Sessions & devices ------------------------------------------------- */
  function tabSessions(c) {
    var d = c.d, p = c.p, out = [];
    var m = msgNode();
    if (d.sessions) {
      var live = filter(d.sessions, function (s) { return s.active !== false; });
      out.push(panel({ title: 'Sessions', sub: plural(live.length, 'live session'), flush: true,
        actions: live.length && allowed(d, 'sessions_revoke') ? [act('Sign out everywhere', { kind: 'ghost-danger', msg: m,
          confirm: { title: 'End every session for ' + personName(p) + '?', body: 'Every browser and phone they are signed in on is signed out on its next request' + (isMe(p.id) ? ', except the one you are using now' : '') + '.', confirmLabel: 'Sign them out', danger: true },
          run: function () { return api('POST', '/people/' + enc(p.id) + '/sessions/revoke', {}); }, done: function (r) { return 'Ended ' + plural(num(r && r.ended, live.length), 'session') + '.'; }, after: c.reload })] : null,
        body: sessionsTable(d.sessions, false, m, c.reload) }));
    }
    if (d.devices) {
      out.push(panel({ title: 'Trusted devices', flush: true,
        actions: d.devices.length && allowed(d, 'devices_revoke') ? [act('Revoke all devices', { kind: 'ghost-danger', msg: m,
          confirm: { title: 'Revoke every device for ' + personName(p) + '?', body: 'Each one goes back behind the allowlist and must be approved again.', confirmLabel: 'Revoke them', danger: true },
          run: function () { return api('POST', '/people/' + enc(p.id) + '/devices/revoke', {}); }, done: function (r) { return 'Revoked ' + plural(num(r && r.revoked, d.devices.length), 'device') + '.'; }, after: c.reload })] : null,
        body: table([{ label: 'Device', lead: true }, { label: 'Status' }, { label: 'Address' }, { label: 'Last seen' }, { label: '', cls: 'cx-actions' }], d.devices, function (dv) {
          return { cells: [cellSub(str(dv.label, 'Unnamed device'), filter([str(dv.browser), str(dv.os)], Boolean).join(' on ')), statusBadge(dv.status || 'approved'),
            dv.ip ? mono(dv.ip) : null, when(dv.last_seen),
            has('devices.manage') && allowed(d, 'devices_revoke') ? act('Revoke', { kind: 'ghost-danger', msg: m,
              confirm: { title: 'Revoke ' + str(dv.label, 'this device') + '?', body: 'It goes back behind the allowlist immediately.', confirmLabel: 'Revoke', danger: true },
              run: function () { return api('DELETE', '/devices/' + enc(dv.id)); }, done: 'Device revoked.', after: c.reload }) : null] };
        }, 'No trusted devices.') }));
    }
    out.push(m);
    return out;
  }

  function sessionsTable(list, withPerson, m, after) {
    var cols = [];
    if (withPerson) cols.push({ label: noun() === 'person' ? 'Person' : cap1(noun()), lead: true });
    cols.push({ label: 'Where', lead: !withPerson }, { label: 'Device' }, { label: 'Started' }, { label: 'Last seen' }, { label: 'Status' }, { label: '', cls: 'cx-actions' });
    return table(cols, list, function (s) {
      var cells = [];
      if (withPerson) cells.push(personLink(s.person));
      cells.push(cellSub(s.ip ? mono(s.ip) : faint('—'), placeText(s)));
      cells.push(cellSub(str(s.device && s.device.label, s.user_agent ? shortUa(s.user_agent) : '—'), s.mfa ? 'via ' + str(MFA_LABEL[s.mfa], s.mfa) : ''));
      cells.push(when(s.created_at));
      cells.push(when(s.last_seen_at));
      cells.push(s.current ? badge('This session', 'info') : s.active === false ? badge('Ended', 'muted') : badge('Live', 'ok'));
      cells.push(s.active !== false && has('sessions.revoke') ? act('Revoke', { kind: 'ghost-danger', msg: m,
        confirm: { title: s.current ? 'End your own session?' : 'End this session?', body: s.current ? 'You will be signed out of this console straight away.' : 'It ends on its next request.', confirmLabel: 'End it', danger: true },
        run: function () { return api('DELETE', '/sessions/' + enc(s.id)); }, done: 'Session ended.', after: s.current ? goLogin : after }) : null);
      return { cells: cells, dim: s.active === false };
    }, 'No sessions.');
  }
  function shortUa(ua) {
    var s = String(ua || '');
    var b = /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : /curl|python|Go-http|wget/i.test(s) ? 'Script' : 'Browser';
    var o = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'macOS' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : '';
    return b + (o ? ' on ' + o : '');
  }

  /* --- Addresses ---------------------------------------------------------- */
  function tabAddresses(c) {
    var d = c.d, p = c.p, out = [];
    var m = msgNode();
    var ips = d.ips || [];
    out.push(panel({ title: 'Allowlist entries for this ' + noun(), sub: 'Entries granted for them. Deleting the account removes these too.', flush: true,
      body: table([{ label: 'Address', lead: true }, { label: 'Tier' }, { label: 'Label' }, { label: 'Expires' }, { label: 'Status' }, { label: '', cls: 'cx-actions' }], ips, function (e) {
        return { dim: e.status && e.status !== 'active', cells: [mono(e.ip_or_cidr), e.tier ? badge('Tier ' + e.tier, tierTone(e.tier)) : null, str(e.label), e.expires_at ? fmtDay(e.expires_at) : 'Never',
          statusBadge(e.status || 'active'),
          has('ips.manage') ? act('Remove', { kind: 'ghost-danger', msg: m,
            confirm: { title: 'Remove ' + e.ip_or_cidr + ' from the allowlist?', body: 'Requests from it are refused from now on unless another entry covers it.', confirmLabel: 'Remove', danger: true },
            run: function () { return api('DELETE', '/ips/' + enc(e.id)); }, done: 'Entry removed.', after: c.reload }) : null] };
      }, 'No addresses linked to this ' + noun() + '.') }));

    if (allowed(d, 'ip_allow')) {
      var ipC = control({ key: 'ip_or_cidr', label: 'Address or range', type: 'text', placeholder: '203.0.113.7 or 203.0.113.0/24' });
      var labC = control({ key: 'label', label: 'Label', type: 'text', placeholder: 'Home, Office, Cell', optional: true });
      var expC = control({ key: 'expires_at', label: 'Expires', type: 'date', optional: true });
      out.push(panel({ title: 'Allow an address for ' + personName(p), body: [h('div', { class: 'cx-form-row' }, ipC.node, labC.node, expC.node,
        act('Allow it', { kind: null, sm: false, msg: m,
          confirm: function () { if (!String(ipC.get()).trim()) { ipC.error('Enter an address or range.'); return null; } return { title: 'Allow ' + ipC.get() + ' for ' + personName(p) + '?', confirmLabel: 'Allow' }; },
          run: function () { return api('POST', '/ips', { ip_or_cidr: String(ipC.get()).trim(), label: labC.get(), expires_at: expC.get(), person_id: p.id }); },
          done: 'Added to the allowlist.', after: c.reload }))] }));
    }

    var seen = {}, list = [];
    function addSeen(ip, where, at) {
      if (!ip || seen[ip]) return;
      seen[ip] = 1;
      list.push({ ip: ip, where: where, at: at });
    }
    addSeen(p.last_login_ip, 'last sign-in', p.last_login_at);
    each(d.sessions || [], function (s) { addSeen(s.ip, placeText(s) || 'session', s.last_seen_at || s.created_at); });
    each(d.activity || [], function (e) { addSeen(e.ip, str(e.action), e.ts); });
    if (list.length && (allowed(d, 'ip_allow') || allowed(d, 'ip_block'))) {
      out.push(panel({ title: 'Addresses they have used', sub: 'From their sign-ins, sessions and recent activity.', flush: true,
        body: table([{ label: 'Address', lead: true }, { label: 'Seen' }, { label: 'When' }, { label: '', cls: 'cx-actions' }], list, function (x) {
          return { cells: [mono(x.ip), str(x.where), when(x.at), h('span', null,
            allowed(d, 'ip_allow') ? act('Allow', { msg: m,
              confirm: { title: 'Allow ' + x.ip + ' for ' + personName(p) + '?', confirmLabel: 'Allow', input: { label: 'Label', type: 'text', optional: true, placeholder: 'Home, Office' } },
              run: function (ans) { return api('POST', '/ips', { ip_or_cidr: x.ip, label: ans.value || '', person_id: p.id }); }, done: 'Added to the allowlist.', after: c.reload }) : null,
            allowed(d, 'ip_block') ? act('Block', { kind: 'ghost-danger', msg: m,
              confirm: { title: 'Block ' + x.ip + '?', body: 'Every request from it is refused, for everyone, and its sessions end.', confirmLabel: 'Block it', danger: true,
                input: { label: 'Reason', type: 'text', optional: true } },
              run: function (ans) { return api('POST', '/deny', { ip_or_cidr: x.ip, reason: ans.value || ('Blocked from the record of ' + personName(p)) }); }, done: 'Blocked.', after: c.reload }) : null)] };
        }) }));
    }
    out.push(m);
    return out;
  }

  /* --- Streak ------------------------------------------------------------- */
  function tabStreak(c) {
    var d = c.d, p = c.p, s = d.streak || {}, out = [];
    var m = msgNode();
    var cur = num(s.current, 0);
    out.push(h('div', { class: 'cx-streak-hero' },
      statCard({ label: 'Current streak', value: cur ? '🔥 ' + cur : '0', sub: cur ? (s.alive === false ? 'lapsed' : plural(cur, 'day')) : 'no streak', tone: cur && s.alive !== false ? 'warn' : null }),
      statCard({ label: 'Longest', value: num(s.longest, 0), sub: 'days' }),
      statCard({ label: 'Window', value: s.hours_left !== undefined && s.hours_left !== null && cur ? Math.max(0, Math.round(num(s.hours_left, 0))) + 'h' : '—', sub: s.expires_at ? 'until ' + fmtFull(s.expires_at) : 'left to sign in' }),
      feat('streak_restores') ? statCard({ label: 'Courtesy restores', value: num(s.restores_left, 0) + ' of ' + num(s.restores_per_month, 0), sub: 'left this month' }) : null));
    if (s.restore_to) out.push(callout('info', null, 'A courtesy restore would bring their streak back to ' + s.restore_to + ' days. They can do it themselves from their account page.'));
    if (s.leeway_for && s.leeway_for.length) out.push(callout('ok', null, 'The window is stretched for: ' + s.leeway_for.join(', ') + '.'));

    if (allowed(d, 'streak_set')) {
      var n = control({ key: 'current', label: 'Set streak to (days)', type: 'int', value: cur, min: 0, max: 10000 });
      out.push(panel({ title: 'Set streak', sub: 'Counts today as day N and restarts their window from now. It does not use their own restores, it is audited, and it emails a security alert. 0 clears it.',
        body: [h('div', { class: 'cx-form-row' }, n.node, act('Set streak', { kind: null, sm: false, msg: m,
          confirm: function () {
            var v = n.get();
            if (v === null || !isFinite(v) || v < 0 || v > 10000 || Math.floor(v) !== v) { n.error('A whole number from 0 to 10000.'); return null; }
            n.error('');
            return { title: 'Set ' + (isMe(p.id) ? 'your own' : personName(p) + '’s') + ' streak to ' + v + '?', body: 'It is ' + cur + ' now. This is recorded and alerts the security inbox.', confirmLabel: 'Set it' };
          },
          run: function () { return api('POST', '/people/' + enc(p.id) + '/streak', { current: n.get() }); },
          done: function () { return 'Streak set to ' + n.get() + '.'; }, after: c.reload }))] }));
    } else if (reasonFor(d, 'streak_set')) out.push(callout('info', 'Setting this streak', reasonFor(d, 'streak_set')));

    if (feat('streak_restores') && allowed(d, 'streak_grant')) {
      var g = control({ key: 'extra', label: 'Extra restores this month', type: 'int', value: 1, min: 1, max: 31 });
      out.push(panel({ title: 'Grant courtesy restores', sub: 'Adds to what they can use this month only. Next month they are back to the normal allowance.',
        body: [h('div', { class: 'cx-form-row' }, g.node, act('Grant', { kind: null, sm: false, msg: m,
          confirm: function () { var v = g.get(); if (!v || v < 1 || v > 31) { g.error('From 1 to 31.'); return null; } g.error(''); return { title: 'Give ' + personName(p) + ' ' + plural(v, 'extra restore') + ' this month?', confirmLabel: 'Grant' }; },
          run: function () { return api('POST', '/people/' + enc(p.id) + '/streak/restores', { extra: g.get() }); }, done: 'Restores granted.', after: c.reload }))] }));
    }
    out.push(m);
    return out;
  }

  /* --- Activity ----------------------------------------------------------- */
  function tabActivity(c) {
    var d = c.d, p = c.p;
    var list = d.activity || [];
    return panel({ title: 'Recent activity', sub: 'Their sign-ins and refusals, and the administrative actions they took or that were taken on them.', flush: true,
      actions: sectionAvailable(SEC_BY_KEY.audit) ? [linkBtn('Full audit trail', hashFor('audit', [], { person: p.id }))] : null,
      body: list.length ? h('ul', { class: 'cx-feed' }, map(list, function (e) { return auditLine(e); })) : h('div', { class: 'cx-empty', text: 'No recorded activity.' }) });
  }

  /* --- Add a person ------------------------------------------------------- */
  function addPerson() {
    var roles = (PEOPLE.meta && PEOPLE.meta.roles) || [];
    then(api('GET', '/people/schema'), function (s) { return s.create_fields; }, function () { return null; }).then(function (fields) {
      if (!fields || !fields.length) {
        fields = [
          { key: 'name', label: 'Full name', type: 'text' },
          { key: 'username', label: 'Username', type: 'text', optional: true },
          { key: 'email', label: 'Email', type: 'email', optional: true },
          { key: 'phone', label: 'Phone', type: 'tel', optional: true, placeholder: '+12125551234' },
          site().staff_id_label ? { key: 'staff_id', label: site().staff_id_label, type: 'text', optional: true } : null,
          roles.length ? { key: 'role', label: 'Role', type: 'select', value: roles[0].value, options: roles } : null,
          { key: 'password', label: 'Temporary password', type: 'password', optional: true, description: 'Leave blank and the server makes one up and shows it to you once.' },
          { key: 'must_change_password', label: 'Make them choose their own at first sign-in', type: 'bool', value: true }
        ];
      }
      return formDialog({ title: 'Add ' + noun(), wide: true, fields: fields, submitLabel: 'Create account',
        intro: 'This creates the account straight away. To let them set their own password instead, send an invitation.',
        submit: function (v) { return api('POST', '/people', v); } });
    }).then(function (res) {
      if (!res) return;
      toast('Account created.', 'ok');
      if (res.temporary_password) showOnce('Temporary password', String(res.temporary_password), 'Read it to them. They choose their own at first sign-in.');
      if (PEOPLE.reloadList) PEOPLE.reloadList();
      if (res.person && res.person.id) go(hashFor('people', [res.person.id], PEOPLE.filters));
    }, function (e) { fail(null, e); });
  }

  /* =============================================================== roles == */

  SEC_BY_KEY.roles.render = function (ctx) {
    var m = msgNode();
    load(ctx, api('GET', '/roles'), function (d) {
      var canManage = d.can_manage !== false && has('roles.manage');
      if (canManage) ctx.actions.appendChild(btn('New role', { onClick: function () { roleEditor(null, d); } }));
      if (d.note) ctx.body.appendChild(callout('info', null, d.note));
      ctx.body.appendChild(m);
      var groupsOf = function (perms) {
        var g = {}, order = [];
        each(d.catalog || [], function (c) {
          if (!contains(perms, c.key)) return;
          var k = str(c.group, 'General');
          if (!g[k]) { g[k] = []; order.push(k); }
          g[k].push(c);
        });
        return { g: g, order: order };
      };
      if (!(d.items || []).length) { ctx.body.appendChild(panel({ body: empty('No roles yet.', canManage ? 'Create one with New role.' : '') })); return; }
      each(d.items, function (role) {
        var gs = groupsOf(role.permissions || []);
        var chips = role.all
          ? callout('danger', 'Holds everything.', 'Every permission in the catalog, including any added later. It cannot be edited or deleted here.')
          : (gs.order.length ? h('div', null, map(gs.order, function (k) {
            return h('div', { class: 'cx-perm-group' }, h('h4', { text: k }), h('div', { class: 'cx-chips' }, map(gs.g[k], function (c) {
              var b = badge(c.key, c.danger ? 'danger' : 'ok', 'cx-mono');
              b.title = c.label + (c.danger ? ' (high risk)' : '');
              return b;
            })));
          })) : h('p', { class: 'cx-muted', text: 'Holds no permissions.' }));
        var acts = [];
        if (canManage && role.editable !== false && !role.all) acts.push(btn('Edit', { kind: 'secondary', sm: true, onClick: function () { roleEditor(role, d); } }));
        if (canManage && role.deletable !== false && !role.system && !role.all) acts.push(act('Delete', { kind: 'ghost-danger', msg: m,
          confirm: { title: 'Delete the ' + role.name + ' role?', danger: true, confirmLabel: 'Delete the role',
            body: num(role.members, 0) ? plural(num(role.members, 0), 'account') + ' hold this role and lose what it gives them.' : 'Nobody holds it, so nothing changes for anyone.' },
          run: function () { return api('DELETE', '/roles/' + enc(role.id)); }, done: 'Role deleted.', after: refreshNow }));
        ctx.body.appendChild(panel({
          title: h('span', null, txt(str(role.name, role.key)), txt(' '), role.key && role.key !== role.name ? h('code', { class: 'cx-faint', text: role.key }) : null),
          sub: str(role.description, 'No description.'),
          actions: [h('span', { class: 'cx-chips' },
            role.rank !== undefined && role.rank !== null && feat('roles_rank') ? badge('rank ' + role.rank, 'info') : null,
            badge(plural(num(role.members, 0), 'member'), num(role.members, 0) ? 'ok' : 'muted'),
            role.system ? badge('built in', 'muted') : null)].concat(acts),
          body: chips }));
      });
    });
  };

  function roleEditor(role, d) {
    var creating = !role;
    var held = role ? (role.permissions || []) : [];
    var fields = [
      { key: 'name', label: 'Name', type: 'text', value: role ? role.name : '', maxlength: 60, placeholder: 'Dispatcher, Network admin…' },
      { key: 'description', label: 'What it is for', type: 'text', value: role ? role.description : '', optional: true, maxlength: 200 },
      feat('roles_rank') ? { key: 'rank', label: 'Rank', type: 'int', value: role ? role.rank : 10, min: 0, max: 100, description: 'People may only act on someone ranked below them.' } : null
    ];
    var boxes = [];
    var groups = {}, order = [];
    each(d.catalog || [], function (c) { var k = str(c.group, 'General'); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(c); });
    var extra = h('div', null, h('span', { class: 'cx-label', text: 'Permissions' }), map(order, function (k) {
      return h('div', { class: 'cx-perm-group', style: { marginTop: '10px' } }, h('h4', { text: k }), h('div', { class: 'cx-perm-grid' }, map(groups[k], function (c) {
        var b = h('input', { type: 'checkbox', checked: contains(held, c.key) });
        boxes.push([b, c.key]);
        return h('label', { class: 'cx-perm' }, b, h('span', { class: 'cx-perm-text' },
          h('strong', null, txt(str(c.label, c.key)), c.danger ? txt(' ') : null, c.danger ? badge('high risk', 'danger') : null),
          h('span', { class: 'cx-mono', text: c.key })));
      })));
    }));
    formDialog({ title: creating ? 'New role' : 'Edit ' + role.name, wide: true, fields: fields, extra: extra,
      intro: creating ? null : (num(role.members, 0) ? 'Saving changes what ' + plural(num(role.members, 0), 'account') + ' can do, immediately.' : null),
      submitLabel: creating ? 'Create role' : 'Save role',
      submit: function (v) {
        v.permissions = map(filter(boxes, function (b) { return b[0].checked; }), function (b) { return b[1]; });
        return creating ? api('POST', '/roles', v) : api('PATCH', '/roles/' + enc(role.id), v);
      } }).then(function (res) { if (res) { toast(creating ? 'Role created.' : 'Role saved.', 'ok'); refreshNow(); } });
  }

  /* ========================================================= invitations == */

  SEC_BY_KEY.invitations.render = function (ctx, r) {
    var m = msgNode();
    var f = { status: str(r.params.status), q: str(r.params.q) };
    var reqHost = h('div');
    var listHost = h('div');
    var meta = { roles: [], create_fields: null };
    var statusSel = h('select', { 'aria-label': 'Filter invitations by state' }, map([['', 'Every invitation'], ['pending', 'Pending'], ['accepted', 'Accepted'], ['expired', 'Expired'], ['revoked', 'Revoked']], function (o) { return h('option', { value: o[0], text: o[1] }); }));
    statusSel.value = f.status;
    var search = h('input', { type: 'search', class: 'cx-search', placeholder: 'Email or name…', 'aria-label': 'Search invitations', value: f.q, maxlength: '120' });
    if (has('invites.manage')) ctx.actions.appendChild(btn('Invite someone', { onClick: function () { invite(); } }));

    var pg = pager(function (cursor) { return api('GET', '/invitations' + qs({ status: f.status, q: f.q, limit: 50, cursor: cursor })); }, function (items, res) {
      meta.roles = res.roles || meta.roles;
      meta.create_fields = res.create_fields || meta.create_fields;
      replace(listHost, panel({ flush: true, body: table([
        { label: 'Invited', lead: true }, { label: 'Role' }, { label: 'State' }, { label: 'Created' }, { label: 'Expires' }, { label: 'Sent by' }, { label: '', cls: 'cx-actions' }
      ], items, function (inv) {
        var acts = [];
        if (has('invites.manage') && inv.status === 'pending') acts.push(act('Resend', { msg: m,
          confirm: { title: 'Send a fresh invitation to ' + inv.email + '?', body: 'A new single-use link is issued and the old one stops working.', confirmLabel: 'Issue a new link' },
          run: function () { return api('POST', '/invitations/' + enc(inv.id) + '/resend', {}); },
          done: function (res2) { if (res2 && res2.link) showOnce('New invitation link', String(res2.link)); return 'A new invitation has gone out.'; }, after: reload }));
        if (has('invites.manage') && (inv.status === 'pending' || inv.status === 'expired')) acts.push(act('Revoke', { kind: 'ghost-danger', msg: m,
          confirm: { title: 'Revoke the invitation for ' + inv.email + '?', body: 'The link stops working immediately. Nothing else about them changes.', confirmLabel: 'Revoke it', danger: true },
          run: function () { return api('DELETE', '/invitations/' + enc(inv.id)); }, done: 'Revoked.', after: reload }));
        return { dim: inv.status === 'revoked' || inv.status === 'expired', cells: [
          cellSub(str(inv.email), str(inv.name)), inv.role ? roleBadge(inv.role) : null,
          h('span', null, statusBadge(inv.status), inv.delivery === 'failed' ? h('span', { class: 'cx-cell-sub', text: 'email failed' }) : null),
          when(inv.created_at), inv.status === 'pending' ? when(inv.expires_at) : faint('—'),
          inv.invited_by ? personLink(inv.invited_by) : null, acts] };
      }, f.status || f.q ? 'No invitation matches that.' : 'No invitations on record.') }), pg.foot);
      ctx.ready();
    });
    function reload() {
      replace(listHost, loading(3));
      pg.load(false).then(null, function (err) { replace(listHost, errorBlock(err, reload)); ctx.ready(); });
      if (feat('access_requests')) loadRequests();
    }
    function loadRequests() {
      then(api('GET', '/access-requests' + qs({ status: 'pending' })), function (res) {
        var items = filter(res.items || [], function (x) { return str(x.status, 'pending') === 'pending'; });
        if (!items.length) { clear(reqHost); return; }
        replace(reqHost, panel({ title: 'Requests to join', sub: plural(items.length, 'request') + ' waiting. Approving one sends an invitation.', flush: true,
          body: table([{ label: 'Who', lead: true }, { label: 'Note' }, { label: 'From' }, { label: 'When' }, { label: '', cls: 'cx-actions' }], items, function (q) {
            return { cells: [cellSub(str(q.email), str(q.name)), str(q.note), q.ip ? mono(q.ip) : null, when(q.created_at),
              has('invites.manage') ? [act('Approve', { kind: null, msg: m,
                confirm: { title: 'Approve ' + q.email + '?', body: 'This issues an invitation to that address. Only approve someone you can name.', confirmLabel: 'Approve and invite' },
                run: function () { return api('POST', '/access-requests/' + enc(q.id) + '/approve', {}); },
                done: function (res2) { if (res2 && res2.link) showOnce('Invitation link', String(res2.link)); return 'Approved. An invitation is on its way.'; }, after: reload }),
              act('Deny', { kind: 'ghost-danger', msg: m,
                confirm: { title: 'Deny ' + q.email + '?', body: 'They are told nothing. The request is closed and stays on record.', confirmLabel: 'Deny it', danger: true },
                run: function () { return api('POST', '/access-requests/' + enc(q.id) + '/deny', {}); }, done: 'Denied.', after: reload })] : null] };
          }) }));
      }, function () { clear(reqHost); });
    }
    function invite() {
      var roleOpts = map(meta.roles || [], function (o) { return { value: o.value !== undefined ? o.value : o.id, label: str(o.label || o.name) }; });
      var fields = [
        { key: 'email', label: 'Email', type: 'email' },
        { key: 'name', label: 'Full name', type: 'text', optional: true },
        roleOpts.length ? { key: 'role', label: 'Role', type: 'select', value: roleOpts[0].value, options: roleOpts } : null,
        { key: 'expires_days', label: 'Link valid for (days)', type: 'int', value: 7, min: 1, max: 30 },
        { key: 'send_email', label: 'Email the link to them', type: 'bool', value: true }
      ].concat(meta.create_fields || []);
      formDialog({ title: 'Invite someone', wide: true, fields: fields, submitLabel: 'Create invitation',
        intro: 'They get a single-use link to set their own password. You see the link once, now.',
        submit: function (v) { return api('POST', '/invitations', v); } }).then(function (res) {
        if (!res) return;
        if (res.link) showOnce('Invitation link', String(res.link), 'Send it to them over a channel you trust. It works once.');
        else toast('Invitation sent.', 'ok');
        reload();
      });
    }
    var refilter = function () { f.status = statusSel.value; f.q = search.value.trim(); quietHash(hashFor('invitations', [], f)); reload(); };
    statusSel.addEventListener('change', refilter);
    search.addEventListener('input', debounce(refilter, 250));
    ctx.body.appendChild(reqHost);
    ctx.body.appendChild(h('div', { class: 'cx-toolbar', role: 'search' }, statusSel, search));
    ctx.body.appendChild(m);
    ctx.body.appendChild(listHost);
    reload();
    if (r.params['new'] && has('invites.manage')) {
      quietHash('#invitations');
      setTimeout(function () { invite(); }, 300);
    }
  };

  /* ============================================================= streaks == */

  SEC_BY_KEY.streaks.render = function (ctx) {
    var m = msgNode();
    var settingsP = has('settings.view') && feat('settings') ? then(api('GET', '/settings'), null, function () { return null; }) : Promise.resolve(null);
    load(ctx, Promise.all([api('GET', '/streaks'), settingsP]), function (both) {
      var d = both[0], s = both[1];
      var items = d.items || [];
      var alive = filter(items, function (x) { return num(x.current, 0) > 0 && x.alive !== false; });
      var top = items.length ? Math.max.apply(null, map(items, function (x) { return num(x.current, 0); })) : 0;
      ctx.body.appendChild(statGrid([
        { label: 'On a streak', value: alive.length, sub: 'of ' + plural(items.length, noun(), noun(true)) },
        { label: 'Longest running', value: top ? '🔥 ' + top : '0', sub: 'days' },
        feat('streak_restores') ? { label: 'Courtesy restores', value: num(d.restores_per_month, 0), sub: num(d.restores_per_month, 0) ? 'per person per month' : 'switched off' } : null,
        { label: 'Month', value: str(d.month, '—'), sub: str(d.timezone, tz()) }
      ].filter(Boolean)));
      ctx.body.appendChild(m);
      var canManage = has('streaks.manage');
      ctx.body.appendChild(panel({ title: 'Leaderboard', sub: 'Ties share a rank. A grey flame means the streak has lapsed.', flush: true,
        body: table([{ label: '#', cls: 'num' }, { label: cap1(noun()), lead: true }, { label: 'Current' }, { label: 'Longest', cls: 'num' }, { label: 'Window' },
          feat('streak_restores') ? { label: 'Restores left' } : { label: '' }, { label: '', cls: 'cx-actions' }], items, function (x) {
          var self = x.person && isMe(x.person.id);
          var canSet = canManage && (!self || BOOT.is_owner || d.can_set_self);
          var acts = [];
          if (canSet) acts.push(act('Set', { msg: m,
            confirm: { title: 'Set ' + (self ? 'your own' : personName(x.person) + '’s') + ' streak', body: 'Counts today as day N. It does not use their restores, it is audited, and it emails a security alert.', confirmLabel: 'Set it',
              input: { label: 'Days (0–10000)', type: 'int', value: num(x.current, 0), min: 0, max: 10000, required: true } },
            run: function (ans) {
              var v = Number(ans.value);
              if (!isFinite(v) || v < 0 || v > 10000 || Math.floor(v) !== v) return Promise.reject(new ApiError(400, { code: 'validation', error: 'A streak is a whole number from 0 to 10000.' }));
              return api('POST', '/people/' + enc(x.person.id) + '/streak', { current: v });
            }, done: 'Streak set.', after: refreshNow }));
          if (canManage && feat('streak_restores')) acts.push(act('Grant restores', { msg: m,
            confirm: { title: 'Grant extra restores to ' + personName(x.person), body: 'For this month only.', confirmLabel: 'Grant', input: { label: 'How many (1–31)', type: 'int', value: 1, min: 1, max: 31, required: true } },
            run: function (ans) { return api('POST', '/people/' + enc(x.person.id) + '/streak/restores', { extra: Number(ans.value) }); }, done: 'Restores granted.', after: refreshNow }));
          var cur = num(x.current, 0);
          return { cells: [String(num(x.rank, '')), personLink(x.person),
            cur ? flame(x) : faint('0'), String(num(x.longest, 0)),
            cur ? (x.alive === false ? badge('lapsed', 'muted') : (x.hours_left !== undefined && x.hours_left !== null ? badge(Math.max(0, Math.round(num(x.hours_left, 0))) + 'h left', num(x.hours_left, 99) < 6 ? 'warn' : 'ok') : badge('alive', 'ok'))) : faint('—'),
            feat('streak_restores') ? (x.restores_left !== undefined ? num(x.restores_left, 0) + ' of ' + num(d.restores_per_month, 0) : null) : '',
            acts] };
        }, 'Nobody has a streak yet.') }));
      if (s && d.settings_group) {
        var grp = find(s.groups || [], function (g) { return g.key === d.settings_group; }) || { key: d.settings_group, label: 'Streak settings' };
        var its = filter(s.items || [], function (i) { return i.group === d.settings_group; });
        if (its.length) ctx.body.appendChild(settingsGroup(grp, its, s.save, refreshNow));
      }
      if (feat('streak_restores')) {
        var host = h('div');
        ctx.body.appendChild(host);
        var pg = pager(function (cursor) { return api('GET', '/streaks/restores' + qs({ limit: 25, cursor: cursor })); }, function (list) {
          replace(host, panel({ title: 'Restores and changes', sub: 'Every courtesy restore a person used, and every streak an admin set or topped up.', flush: true,
            body: table([{ label: 'When', lead: true }, { label: cap1(noun()) }, { label: 'Kind' }, { label: 'Change' }, { label: 'By' }], list, function (x) {
              return { cells: [when(x.created_at), personLink(x.person), badge(x.kind === 'self' ? 'Courtesy restore' : x.kind === 'grant' ? 'Restores granted' : 'Set by admin', x.kind === 'self' ? 'ok' : 'info'),
                x.kind === 'grant' ? '+' + num(x.to_count, 0) + ' restores' : num(x.from_count, 0) + ' → ' + num(x.to_count, 0), x.by ? personLink(x.by) : faint('themselves')] };
            }, 'No restores this month.') }), pg.foot);
        });
        pg.load(false).then(null, function (err) { replace(host, errorBlock(err)); });
      }
    });
  };

  /* ============================================================ settings == */

  SEC_BY_KEY.settings.render = function (ctx, r) {
    load(ctx, api('GET', '/settings'), function (d) {
      if (feat('alerts_test') && has('alerts.test')) ctx.actions.appendChild(act('Send test alert', { kind: 'secondary', sm: false,
        confirm: { title: 'Send a test security alert?', body: 'It goes to the security inbox through the normal mail path and shows up in Security alerts.', confirmLabel: 'Send it' },
        run: function () { return api('POST', '/alerts/test', {}); }, done: function (res) { return res && res.alert && res.alert.to ? 'Test alert sent to ' + res.alert.to + '.' : 'Test alert sent.'; } }));
      var groups = (d.groups || []).slice();
      var items = d.items || [];
      if (find(items, function (i) { return !i.group || !find(groups, function (g) { return g.key === i.group; }); })) groups.push({ key: '', label: 'General' });
      if (d.save === 'item') ctx.intro.textContent = 'The rules this site runs on. Switches save the moment you flip them; other values save with the button beside them. Every change is audited and sends a security alert.';
      var jump = h('div', { class: 'cx-chips', style: { marginBottom: '14px' } });
      each(groups, function (g) {
        var its = filter(items, function (i) { return g.key ? i.group === g.key : (!i.group || !find(groups, function (x) { return x.key && x.key === i.group; })); });
        if (!its.length) return;
        jump.appendChild(h('a', { class: 'cx-btn secondary sm', href: '#settings/' + enc(g.key || 'general'), text: str(g.label, g.key) }));
        ctx.body.appendChild(settingsGroup(g, its, d.save, refreshNow));
      });
      if (groups.length > 2) ctx.body.insertBefore(jump, ctx.body.firstChild);
      if (r.parts[0]) setTimeout(function () { scrollToGroup(r.parts[0]); }, 30);
    });
  };
  SEC_BY_KEY.settings.update = function (ctx, r) { if (r.parts[0]) scrollToGroup(r.parts[0]); else refreshNow(); };
  function scrollToGroup(key) {
    var el = VIEW.querySelector('[data-group="' + String(key).replace(/[^A-Za-z0-9_-]/g, '') + '"]');
    if (el) { try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); } }
  }

  /** One settings group as a panel of rows. save: 'group' | 'item'. */
  function settingsGroup(g, items, save, after) {
    var m = msgNode();
    var canEdit = has('settings.manage');
    var ctrls = [];
    var rows = map(items, function (it) {
      var editable = canEdit && it.editable !== false && it.type !== 'readonly';
      var f = assign({}, it, { editable: editable });
      var wide = it.type === 'text' || it.type === 'radio' || it.type === 'multiselect';
      var c, controlNode;
      if (it.type === 'bool') {
        if (save === 'item') {
          controlNode = liveSwitch({ value: !!it.value, label: it.label, disabled: !editable, danger: it.danger, msg: m,
            confirm: function (on) { return it.confirm ? { title: str(it.confirm), body: it.description || null, confirmLabel: on ? 'Turn on' : 'Turn off', danger: !!it.danger } : null; },
            run: function (on) { var v = {}; v[it.key] = on; return api('PATCH', '/settings', { values: v }); },
            done: function (on) { return it.label + (on ? ' on.' : ' off.'); }, after: function () { it.value = !it.value; } });
          c = null;
        } else {
          c = control(f, { bare: true, noHint: true });
          c.input.setAttribute('aria-label', it.label);
          controlNode = h('span', { class: ['cx-switch', it.danger ? 'danger' : null] }, c.input, h('span', { class: 'cx-slider', 'aria-hidden': 'true' }));
        }
      } else {
        c = control(f, { noHint: true });
        c.input.setAttribute && c.input.setAttribute('aria-label', it.label);
        controlNode = h('span', { style: { display: 'contents' } }, c.input, it.unit ? h('span', { class: 'cx-unit', text: it.unit }) : null);
        if (save === 'item' && editable) {
          var b = btn('Save', { kind: 'secondary', sm: true });
          (function (cc, item, bb) {
            bb.addEventListener('click', function () {
              var v = cc.get();
              if (sameValue(v, item.value)) { say(m, 'Nothing has changed.', 'muted'); return; }
              var conf = item.confirm ? confirmDialog({ title: str(item.confirm), body: item.description || null, confirmLabel: 'Save', danger: !!item.danger }) : Promise.resolve({});
              conf.then(function (ans) {
                if (!ans) return;
                busy(bb, true);
                var body = {}; body[item.key] = v;
                then(api('PATCH', '/settings', { values: body }), function (r) { busy(bb, false); item.value = v; cc.error(''); if (!settingsWarn(m, r)) { say(m, item.label + ' saved.', 'ok'); toast(item.label + ' saved.', 'ok', true); } },
                  function (err) { busy(bb, false); showErrors([cc], err, m); });
              });
            });
          })(c, it, b);
          controlNode.appendChild(b);
        }
      }
      if (c) ctrls.push(c);
      var errHost = c ? c.node.querySelector('.cx-field-error') : null;
      return h('div', { class: ['cx-set-row', wide ? 'wide' : null, it.danger ? 'danger' : null] },
        h('div', null,
          h('div', { class: 'cx-set-label', text: str(it.label, it.key) }),
          it.description ? h('div', { class: 'cx-set-desc', text: it.description }) : null,
          it['default'] !== undefined && it['default'] !== null && it.type !== 'bool' ? h('div', { class: 'cx-set-desc', text: 'Default: ' + valueText(it['default']) + (it.unit ? ' ' + it.unit : '') }) : null,
          errHost),
        h('div', { class: 'cx-set-control' }, controlNode));
    });
    var foot = null;
    if (save !== 'item' && canEdit && find(items, function (i) { return i.editable !== false && i.type !== 'readonly'; })) {
      var saveBtn = btn('Save ' + str(g.label, 'settings').toLowerCase(), {});
      saveBtn.addEventListener('click', function () {
        var values = {}, changed = [];
        each(ctrls, function (c) {
          if (c.field.editable === false) return;
          var v = c.get();
          c.error('');
          if (!sameValue(v, c.field.value)) { values[c.field.key] = v; changed.push(c.field); }
        });
        if (!changed.length) { say(m, 'Nothing has changed.', 'muted'); return; }
        var risky = filter(changed, function (f) { return f.confirm || f.danger; });
        var conf = risky.length ? confirmDialog({ title: risky.length === 1 && risky[0].confirm ? str(risky[0].confirm) : 'Save ' + plural(changed.length, 'change') + '?',
          body: h('ul', { class: 'cx-evidence' }, map(changed, function (f) { return h('li', { text: str(f.label, f.key) + ': ' + valueText(f.value) + ' → ' + valueText(values[f.key]) }); })),
          confirmLabel: 'Save', danger: !!find(risky, function (f) { return f.danger; }) }) : Promise.resolve({});
        conf.then(function (ans) {
          if (!ans) return;
          busy(saveBtn, true);
          say(m, 'Saving…', 'muted');
          then(api('PATCH', '/settings', { values: values }), function (r) {
            busy(saveBtn, false);
            each(changed, function (f) { f.value = values[f.key]; });
            if (settingsWarn(m, r)) return;
            say(m, 'Saved ' + plural(changed.length, 'change') + '.', 'ok');
            toast('Settings saved.', 'ok', true);
          }, function (err) { busy(saveBtn, false); showErrors(ctrls, err, m); });
        });
      });
      foot = [m, saveBtn];
    }
    return panel({ title: str(g.label, 'General'), sub: g.description || null, group: g.key || 'general', flush: true,
      body: h('div', null, rows, foot ? null : h('div', { style: { padding: '0 18px' } }, m)), foot: foot });
  }

  // Saved, but the server has something to say about it (e.g. "nobody can
  // reach sign-in from outside the allowlist now"). Returns true when shown.
  function settingsWarn(m, r) {
    var w = r && isArr(r.warnings) ? filter(map(r.warnings, function (x) { return str(x && x.message !== undefined ? x.message : x); }), Boolean) : [];
    if (!w.length) return false;
    say(m, 'Saved, with ' + plural(w.length, 'warning') + ': ' + w.join(' '), 'warn');
    toast('Saved — ' + w[0], 'warn');
    return true;
  }

  /* ============================================================ security == */

  var NETWORK_LABEL = { residential: 'Home broadband', mobile: 'Mobile network', business: 'Business network', hosting: 'Hosting / datacenter',
    vpn: 'VPN', tor: 'Tor exit', relay: 'Privacy relay', unknown: 'Unknown network' };

  SEC_BY_KEY.security.render = function (ctx, r) {
    var f = { days: str(r.params.days, '7'), band: str(r.params.band), country: str(r.params.country), q: str(r.params.q) };
    var m = msgNode();
    var statsHost = h('div'), listHost = h('div');
    var seg = h('div', { class: 'cx-seg', role: 'group', 'aria-label': 'Time window' });
    var bandSel = h('select', { 'aria-label': 'Minimum rating' }, map([['', 'Any rating'], ['watch', 'Watch and up'], ['suspicious', 'Suspicious and up'], ['hostile', 'Hostile only']], function (o) { return h('option', { value: o[0], text: o[1] }); }));
    bandSel.value = f.band;
    var country = h('input', { type: 'text', placeholder: 'Country (US)', 'aria-label': 'Country code', maxlength: '2', size: '8', value: f.country, autocapitalize: 'characters' });
    var search = h('input', { type: 'search', class: 'cx-search', placeholder: 'Address, network, city, user agent…', 'aria-label': 'Search visitors', value: f.q, maxlength: '120' });
    if (feat('visitors_export')) ctx.actions.appendChild(downloadLink('Export CSV', '/security/visitors/export' + qs(assign({ format: 'csv' }, f))));
    ctx.body.appendChild(statsHost);
    ctx.body.appendChild(h('div', { class: 'cx-toolbar', role: 'search' }, seg, bandSel, country, search));
    ctx.body.appendChild(m);
    ctx.body.appendChild(listHost);

    function paintSeg(windows) {
      replace(seg, map(windows || [1, 7, 14, 30], function (w) {
        var b = h('button', { type: 'button', 'aria-pressed': String(w) === f.days ? 'true' : 'false', text: String(w) === '1' ? 'Today' : String(w) === 'all' ? 'All time' : w + ' days' });
        b.addEventListener('click', function () { f.days = String(w); refilter(); });
        return b;
      }));
    }
    var pg = pager(function (cursor) { return api('GET', '/security/visitors' + qs(assign({ limit: 100, cursor: cursor }, f))); }, function (items, res) {
      paintSeg(res.windows);
      var t = res.totals || {};
      var look = filter(items, function (v) { var b = bandOf(v); return b === 'hostile' || b === 'suspicious'; }).length;
      replace(statsHost, statGrid([
        { label: 'Addresses seen', value: num(t.ips, items.length), sub: f.days === '1' ? 'today' : 'in ' + f.days + ' days' },
        { label: 'Refused requests', value: num(t.refused, 0), sub: 'turned away at the gate' },
        { label: 'Worth a look', value: look, sub: look ? 'suspicious or hostile' : 'nothing standing out', tone: look ? 'warn' : null },
        { label: 'Hostile', value: num(t.hostile, filter(items, function (v) { return bandOf(v) === 'hostile'; }).length), tone: num(t.hostile, 0) ? 'danger' : null },
        { label: 'Countries', value: num(t.countries, 0), sub: 'distinct origins' }
      ]));
      var manage = has('ips.manage') && feat('deny_list');
      replace(listHost, panel({ title: 'Who has been knocking', sub: 'Grouped by address, worst first. Open a row for the evidence behind its score.', flush: true,
        body: table([{ label: 'Rating' }, { label: 'Address', lead: true }, { label: 'Where from' }, { label: 'Network' }, { label: 'Requests', cls: 'num' }, { label: 'Why' }, { label: 'Last seen' }, { label: '', cls: 'cx-actions' }], items, function (v) {
          var reasons = v.reasons || [];
          var tags = h('span', { class: 'cx-chips', style: { marginTop: '4px' } },
            v.on_allowlist ? badge('allowlisted', 'ok') : null, v.signed_in ? badge('signed in', 'info') : null, v.denied ? badge('blocked', 'danger') : null);
          return { label: 'Open ' + v.ip, onOpen: function () { openVisitor(v, refilter); }, cells: [
            h('span', { class: 'cx-nowrap' }, meter(v), bandBadge(v)),
            h('span', null, mono(v.ip), tags.childNodes.length ? h('span', { style: { display: 'block' } }, tags) : null),
            placeText(v) || faint('Unknown'),
            cellSub(str(NETWORK_LABEL[v.network], v.network ? cap1(v.network) : '—'), str(v.as_org)),
            h('span', null, String(num(v.hits, 0)), num(v.refused, 0) ? h('span', { class: 'cx-cell-sub', text: num(v.refused, 0) + ' refused' }) : null),
            reasons.length ? h('span', null, txt(reasons[0]), reasons.length > 1 ? h('span', { class: 'cx-faint', text: ' +' + (reasons.length - 1) + ' more' }) : null) : faint('nothing of note'),
            when(v.last_seen),
            manage ? (v.denied && v.deny_id ? act('Unblock', { msg: m, confirm: { title: 'Stop blocking ' + v.ip + '?', confirmLabel: 'Unblock' },
              run: function () { return api('POST', '/deny/' + enc(v.deny_id) + '/unblock', {}); }, done: 'Unblocked.', after: refilter })
              : (!v.on_allowlist && !v.denied ? blockBtn(v.ip, m, refilter) : null)) : null] };
        }, 'Nobody has reached the site in this window.') }), pg.foot);
      ctx.ready();
    });
    function refilter() {
      f.band = bandSel.value; f.country = countryList(country.value)[0] || ''; f.q = search.value.trim();
      quietHash(hashFor('security', [], f));
      replace(listHost, loading(4));
      pg.load(false).then(null, function (err) { replace(listHost, errorBlock(err, refilter)); ctx.ready(); });
    }
    bandSel.addEventListener('change', refilter);
    country.addEventListener('change', refilter);
    search.addEventListener('input', debounce(refilter, 300));
    paintSeg(null);
    refilter();
  };

  function blockBtn(ip, m, after) {
    return act('Block', { kind: 'ghost-danger', msg: m,
      confirm: { title: 'Block ' + ip + '?', body: 'Every request from it is refused and any session from it ends.', confirmLabel: 'Block it', danger: true,
        input: { label: 'Reason, for your own records', type: 'text', optional: true, placeholder: 'Walking .env paths' } },
      run: function (ans) { return api('POST', '/deny', { ip_or_cidr: ip, reason: ans.value || '' }); }, done: 'Blocked ' + ip + '.', after: after });
  }

  function openVisitor(v, after) {
    var L = layer({ title: v.ip, drawer: true });
    var m = msgNode();
    function paint(detail) {
      var vv = assign({}, v, (detail && detail.visitor) || {});
      var ev = (detail && detail.evidence) || {};
      var reasons = ev.reasons || vv.reasons || [];
      var paths = ev.paths || vv.paths || [];
      replace(L.body,
        h('div', { class: 'cx-chips', style: { marginBottom: '12px' } }, bandBadge(vv), vv.on_allowlist ? badge('allowlisted', 'ok') : null, vv.denied ? badge('blocked', 'danger') : null,
          vv.signed_in ? badge('signed in' + (vv.person ? ' as ' + personName(vv.person) : ''), 'info') : null),
        m,
        h('h4', { text: 'Why it scored ' + num(vv.score, 0) }),
        reasons.length ? h('ul', { class: 'cx-evidence' }, map(reasons, function (x) { return h('li', { text: x }); })) : h('p', { class: 'cx-muted', text: 'Nothing scored against this address.' }),
        h('h4', { text: 'Requests', style: { marginTop: '16px' } }),
        h('p', { text: num(vv.hits, 0) + ' in total — ' + num(vv.allowed, 0) + ' allowed, ' + num(vv.refused, 0) + ' refused' + (num(vv.probe_hits, 0) ? ', ' + num(vv.probe_hits, 0) + ' of them known scanner paths' : '') + '.' }),
        h('h4', { text: 'Paths tried', style: { marginTop: '16px' } }),
        paths.length ? h('div', { class: 'cx-chips' }, map(paths, function (p) { return badge(p, 'muted', 'cx-mono'); })) : h('p', { class: 'cx-muted', text: 'No paths recorded.' }),
        h('div', { class: 'cx-kv-section', style: { marginTop: '18px' } }, kv([
          ['Where', placeText(vv) || 'Unknown'], ['Network', str(NETWORK_LABEL[vv.network], vv.network)], ['Organisation', str(vv.as_org)],
          ['ASN', vv.asn ? 'AS' + String(vv.asn).replace(/^AS/i, '') : ''], ['First seen', vv.first_seen ? fmtFull(vv.first_seen) : ''],
          ['Last seen', vv.last_seen ? fmtFull(vv.last_seen) : ''], ['Days in window', vv.days ? String(vv.days) : ''],
          ['Last decision', vv.decision ? statusBadge(vv.decision) : null]
        ])),
        vv.user_agent ? h('div', { class: 'cx-kv-section' }, h('h4', { text: 'Browser said' }), h('p', { class: 'cx-mono cx-break', text: vv.user_agent })) : null,
        sectionsBlock(detail && detail.sections));
      clear(L.foot);
      if (has('ips.manage') && feat('deny_list') && !vv.on_allowlist && !vv.denied) L.foot.appendChild(blockBtn(vv.ip, m, function () { L.close(); if (after) after(); }));
      if (sectionAvailable(SEC_BY_KEY.deny) && vv.denied) L.foot.appendChild(linkBtn('Open the deny list', '#deny'));
      L.foot.appendChild(btn('Close', { kind: 'secondary', onClick: function () { L.close(); } }));
    }
    paint(null);
    if (feat('visitors_detail')) {
      L.body.appendChild(loading(2));
      then(api('GET', '/security/visitors/' + enc(v.id || v.ip)), paint, function (err) { paint(null); fail(m, err); });
    }
  }

  /* ========================================================= allowlist == */

  SEC_BY_KEY.ips.render = function (ctx) {
    var m = msgNode();
    load(ctx, api('GET', '/ips'), function (d) {
      var items = d.items || [];
      var now = Date.now();
      var live = filter(items, function (e) { return str(e.status, 'active') === 'active' && (!e.expires_at || parseTime(e.expires_at) > now); });
      var soon = filter(live, function (e) { var t = parseTime(e.expires_at); return t && t - now < 30 * 86400000; });
      var mine = find(items, function (e) { return d.your_entry_id !== undefined && d.your_entry_id !== null && String(e.id) === String(d.your_entry_id); });
      ctx.body.appendChild(statGrid([
        { label: 'Active entries', value: live.length },
        { label: 'Total', value: items.length },
        { label: 'Expiring in 30 days', value: soon.length, tone: soon.length ? 'warn' : null },
        { label: 'Your address', value: str(d.your_ip, '—'), sub: mine ? 'covered by ' + mine.ip_or_cidr + (mine.tier ? ' (tier ' + mine.tier + ')' : '') : 'not on the allowlist', tone: mine ? 'ok' : 'warn' }
      ]));
      if (d.note) ctx.body.appendChild(callout('info', null, d.note));
      var canManage = d.can_manage !== false && has('ips.manage');
      var editing = null;
      var tiers = feat('ip_tiers') ? (d.tiers || []) : [];
      var people = feat('ip_link_person') ? (d.people || []) : [];
      var cIp = control({ key: 'ip_or_cidr', label: 'IP or prefix', type: 'text', placeholder: '203.0.113.7 or 203.0.113.0/24' });
      var cTier = tiers.length ? control({ key: 'tier', label: 'Tier — how often a code is required', type: 'select', value: tiers[0].value, options: map(tiers, function (t) { return { value: t.value, label: str(t.label) + (t.description ? ' · ' + t.description : '') }; }) }) : null;
      var cPerson = people.length ? control({ key: 'person_id', label: cap1(noun()), type: 'select', value: '', options: [{ value: '', label: '— not linked —' }].concat(map(people, function (p) { return { value: str(p.id), label: personName(p) }; })) }) : null;
      var cLabel = control({ key: 'label', label: 'Label', type: 'text', placeholder: 'Home, Office, Cell…', optional: true });
      var cExp = control({ key: 'expires_at', label: 'Expires', type: 'date', optional: true });
      var ctrls = filter([cIp, cTier, cPerson, cLabel, cExp], Boolean);
      var formTitle = h('span', { text: 'Add an address' });
      var cancel = btn('Cancel edit', { kind: 'secondary', onClick: function () { setEdit(null); } });
      cancel.hidden = true;
      var save = btn('Save entry', {});
      var mineBtn = d.your_ip ? btn('Use my current address', { kind: 'secondary', onClick: function () { cIp.set(d.your_ip); cIp.input.focus(); } }) : null;
      function setEdit(e) {
        editing = e;
        formTitle.textContent = e ? 'Edit ' + e.ip_or_cidr : 'Add an address';
        cIp.set(e ? e.ip_or_cidr : ''); if (cTier) cTier.set(e ? e.tier : tiers[0].value);
        if (cPerson) cPerson.set(e && e.person ? str(e.person.id) : ''); cLabel.set(e ? e.label : ''); cExp.set(e ? e.expires_at : '');
        save.textContent = e ? 'Update entry' : 'Save entry';
        cancel.hidden = !e;
        each(ctrls, function (c) { c.error(''); });
        if (e) { try { formPanel.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (x) { /* ignore */ } cIp.input.focus(); }
      }
      save.addEventListener('click', function () {
        var body = {};
        each(ctrls, function (c) { body[c.field.key] = c.get(); });
        if (!String(body.ip_or_cidr || '').trim()) { cIp.error('Enter an address or range.'); return; }
        body.ip_or_cidr = String(body.ip_or_cidr).trim();
        if (body.person_id === '') body.person_id = null;
        var go_ = function () {
          busy(save, true);
          then(editing ? api('PATCH', '/ips/' + enc(editing.id), body) : api('POST', '/ips', body), function () {
            busy(save, false); toast(editing ? 'Entry updated.' : 'Entry added.', 'ok'); refreshNow();
          }, function (err) { busy(save, false); showErrors(ctrls, err, m); });
        };
        if (editing) confirmDialog({ title: 'Update ' + editing.ip_or_cidr + '?', body: 'Changes are audited and can be reverted from the audit log.', confirmLabel: 'Update' }).then(function (a) { if (a) go_(); });
        else go_();
      });
      var formPanel = canManage ? panel({ title: formTitle, sub: 'A single address or a CIDR range. IPv4 and IPv6 both work.',
        body: [h('div', { class: 'cx-form-row' }, map(ctrls, function (c) { return c.node; })), h('div', { class: 'cx-form-actions' }, save, mineBtn, cancel)] }) : null;
      append(ctx.body, formPanel);
      ctx.body.appendChild(m);
      ctx.body.appendChild(panel({ title: 'Allowlist', flush: true,
        body: table([{ label: 'Address', lead: true }, tiers.length ? { label: 'Tier' } : { label: '' }, { label: cap1(noun()) }, { label: 'Label' }, { label: 'Status' }, { label: 'Expires' }, { label: 'Added' }, { label: '', cls: 'cx-actions' }], items, function (e) {
          var st = str(e.status, 'active');
          var expired = st === 'active' && e.expires_at && parseTime(e.expires_at) <= now;
          return { dim: st !== 'active' || expired, cells: [
            h('span', null, mono(e.ip_or_cidr), mine === e ? h('span', { style: { display: 'block', marginTop: '3px' } }, badge('you are here', 'info')) : null),
            tiers.length ? (e.tier ? h('span', { title: str((find(tiers, function (t) { return String(t.value) === String(e.tier); }) || {}).label) }, badge('Tier ' + e.tier, tierTone(e.tier))) : null) : '',
            e.person ? personLink(e.person) : (e.owner ? txt(e.owner) : null), str(e.label),
            h('span', null, statusBadge(expired ? 'expired' : st), e.revoked_reason ? h('span', { class: 'cx-cell-sub', text: e.revoked_reason }) : null),
            e.expires_at ? fmtDay(e.expires_at) : 'Never', when(e.created_at, 'day'),
            canManage ? [btn('Edit', { kind: 'secondary', sm: true, onClick: function () { setEdit(e); } }),
              act('Remove', { kind: 'ghost-danger', msg: m,
                confirm: { title: 'Remove ' + e.ip_or_cidr + '?', body: (mine === e ? 'This is the entry covering your own address. The server will refuse unless another entry covers you. ' : '') + 'Requests from it are refused from now on.', confirmLabel: 'Remove', danger: true },
                run: function () { return api('DELETE', '/ips/' + enc(e.id)); }, done: 'Entry removed.', after: refreshNow })] : null] };
        }, 'No entries yet.') }));
    });
  };

  /* =========================================================== deny list == */

  var TRIGGER_LABEL = { failed_logins: 'Failed passwords', failed_mfa: 'Failed MFA codes', multi_account: 'Several accounts tried', hostile_score: 'Hostile score',
    decoy: 'Decoy / scanner path', admin_denied: 'Admin API without permission', injection: 'Injection signature', rate_limit: 'Repeated rate limits' };

  SEC_BY_KEY.deny.render = function (ctx, r) {
    var m = msgNode();
    var src = str(r.params.source);
    load(ctx, api('GET', '/deny'), function (d) {
      var all = d.items || [];
      var auto = filter(all, function (e) { return e.source === 'auto'; });
      ctx.body.appendChild(statGrid([
        { label: 'Blocked entries', value: all.length },
        feat('deny_auto') ? { label: 'Added automatically', value: auto.length, tone: auto.length ? 'danger' : null, sub: 'by the auto-blacklist' } : null,
        { label: 'Added by hand', value: all.length - auto.length },
        { label: 'Permanent', value: filter(all, function (e) { return !e.expires_at; }).length }
      ].filter(Boolean)));
      var owner = filter(auto, function (e) { return e.owner_session; });
      if (owner.length) ctx.body.appendChild(callout('danger', 'An owner session was caught by the auto-blacklist.', plural(owner.length, 'entry', 'entries') + ' below blocked an address the owner was signed in from. The alert email said so. Unblock it only if you are sure it was you.'));
      var canManage = d.can_manage !== false && has('ips.manage');
      if (canManage) {
        var cIp = control({ key: 'ip_or_cidr', label: 'Address or range', type: 'text', placeholder: '198.51.100.7 or 198.51.100.0/24' });
        var cReason = control({ key: 'reason', label: 'Reason — for your own records', type: 'text', placeholder: 'Walking .env paths', optional: true });
        var cExp = feat('deny_expiry') ? control({ key: 'expires_at', label: 'Expires', type: 'date', optional: true, description: 'Leave blank for permanent.' }) : null;
        var ctrls = filter([cIp, cReason, cExp], Boolean);
        var add = act('Block it', { kind: 'danger', sm: false, msg: m,
          confirm: function () {
            var v = String(cIp.get()).trim();
            if (!v) { cIp.error('Enter an address or range.'); return null; }
            cIp.error('');
            return { title: 'Block ' + v + '?', body: 'Every request from it is refused and any session from it ends.', confirmLabel: 'Block it', danger: true };
          },
          run: function () { var b = {}; each(ctrls, function (c) { b[c.field.key] = c.get(); }); b.ip_or_cidr = String(b.ip_or_cidr).trim(); return api('POST', '/deny', b).then(null, function (err) { showErrors(ctrls, err, false); throw err; }); },
          done: 'Blocked.', after: refreshNow });
        ctx.body.appendChild(panel({ title: 'Block an address', sub: 'The server refuses a block that covers the address you are using now (' + str(d.your_ip, 'unknown') + ').',
          body: h('div', { class: 'cx-form-row' }, map(ctrls, function (c) { return c.node; }), add) }));
      }
      ctx.body.appendChild(m);
      var listHost = h('div');
      var seg = feat('deny_auto') ? h('div', { class: 'cx-seg', role: 'group', 'aria-label': 'Source' }) : null;
      function paint() {
        if (seg) replace(seg, map([['', 'All'], ['auto', 'Auto'], ['manual', 'Manual']], function (o) {
          return h('button', { type: 'button', 'aria-pressed': o[0] === src ? 'true' : 'false', text: o[1], onClick: function () { src = o[0]; quietHash(hashFor('deny', [], { source: src })); paint(); } });
        }));
        var items = src ? filter(all, function (e) { return e.source === src; }) : all;
        replace(listHost, panel({ title: 'Deny list', flush: true, actions: seg ? [seg] : null,
          body: table([{ label: 'Entry', lead: true }, { label: 'Source' }, { label: 'Reason and evidence' }, { label: 'By' }, { label: 'When' }, { label: 'Expires' }, { label: '', cls: 'cx-actions' }], items, function (e) {
            var evidence = e.evidence || [];
            var evNode = evidence.length ? h('details', { class: 'cx-details' }, h('summary', { text: 'Evidence (' + evidence.length + ')' }),
              h('ul', { class: 'cx-evidence' }, map(evidence, function (x) {
                return typeof x === 'object' && x ? h('li', null, h('strong', { text: str(x.label) + ': ' }), txt(valueText(x.value))) : h('li', { text: String(x) });
              }))) : null;
            return { cells: [
              h('span', null, mono(e.ip_or_cidr), h('span', { class: 'cx-chips', style: { marginTop: '4px' } },
                e.was_allowlisted ? badge('was allowlisted', 'warn') : null, e.owner_session ? badge('owner session', 'danger') : null,
                num(e.sessions_killed, 0) ? badge(plural(num(e.sessions_killed, 0), 'session') + ' ended', 'muted') : null)),
              e.source === 'auto' ? h('span', null, badge('Auto', 'danger'), e.trigger ? h('span', { class: 'cx-cell-sub', text: str(TRIGGER_LABEL[e.trigger], e.trigger) }) : null) : badge('Manual', 'muted'),
              h('span', null, e.reason ? txt(e.reason) : faint('—'), evNode),
              e.created_by ? personLink(e.created_by) : faint(e.source === 'auto' ? 'System' : '—'),
              when(e.created_at), e.expires_at ? when(e.expires_at, 'day') : 'Permanent',
              canManage ? [act('Unblock', { msg: m,
                confirm: { title: 'Stop blocking ' + e.ip_or_cidr + '?', body: e.source === 'auto' ? 'It was blocked automatically. Check the evidence first.' : null, confirmLabel: 'Unblock',
                  check: e.was_allowlisted ? { label: 'Put it back on the allowlist', checked: true } : null },
                run: function (ans) { return api('POST', '/deny/' + enc(e.id) + '/unblock', { readd_allowlist: !!ans.checked }); },
                done: function (res) { return res && res.readded ? 'Unblocked and back on the allowlist.' : 'Unblocked.'; }, after: refreshNow }),
              btn('Edit', { kind: 'secondary', sm: true, onClick: function () {
                formDialog({ title: 'Edit ' + e.ip_or_cidr, fields: [{ key: 'reason', label: 'Reason', type: 'text', value: e.reason, optional: true },
                  feat('deny_expiry') ? { key: 'expires_at', label: 'Expires', type: 'date', value: e.expires_at, optional: true, description: 'Blank means permanent.' } : null],
                  submit: function (v) { return api('PATCH', '/deny/' + enc(e.id), v); } }).then(function (x) { if (x) { toast('Saved.', 'ok'); refreshNow(); } });
              } })] : null] };
          }, src ? 'No ' + src + ' entries.' : 'Nothing is blocked.') }));
      }
      ctx.body.appendChild(listHost);
      paint();
    });
  };

  /* ======================================================== country rule == */

  SEC_BY_KEY.country.render = function (ctx) {
    var m = msgNode();
    load(ctx, api('GET', '/country-rule'), function (d) {
      var canManage = d.can_manage !== false && has('ips.manage');
      var modes = d.modes || ['off', 'allow'];
      if (!feat('country_deny_mode')) modes = filter(modes, function (x) { return x !== 'deny'; });
      var MODE = { off: ['No rule', 'Every country may reach the site.'], allow: ['Allow only the countries listed', 'Everyone else is refused, unless the allowlist covers them.'], deny: ['Block the countries listed', 'Everyone else may reach the site.'] };
      var modeC = control({ key: 'mode', label: 'Rule', type: 'radio', value: d.mode || 'off', editable: canManage,
        options: map(modes, function (k) { return { value: k, label: MODE[k] ? MODE[k][0] : k, description: MODE[k] ? MODE[k][1] : '' }; }) });
      var listC = control({ key: 'countries', label: 'Countries — two-letter codes, comma separated', type: 'countries', value: d.countries || [], editable: canManage });
      var preview = h('div', { class: 'cx-chips', style: { marginTop: '8px' } });
      function paintPreview() {
        var list = listC.get();
        replace(preview, list.length ? map(list, function (c) { return badge(c, c === d.your_country ? 'info' : 'muted', 'cx-mono'); }) : faint('No countries listed.'));
      }
      listC.input.addEventListener('input', paintPreview);
      paintPreview();
      var state = d.mode === 'allow' && (d.countries || []).length ? 'In force: only ' + d.countries.join(', ') + ' may reach the site from an address that is not on the allowlist.'
        : d.mode === 'deny' && (d.countries || []).length ? 'In force: ' + d.countries.join(', ') + ' are refused unless the allowlist covers them.'
        : 'No country rule is in force.';
      var presets = canManage && d.presets && d.presets.length ? h('div', { class: 'cx-btn-row', style: { marginTop: '12px' } }, map(d.presets, function (p) {
        return btn(str(p.label), { kind: 'secondary', sm: true, onClick: function () { modeC.set(p.mode || 'allow'); listC.set(p.countries || []); paintPreview(); } });
      })) : null;
      var saveB = canManage ? act('Save rule', { kind: null, sm: false, msg: m,
        confirm: function () {
          var mode = modeC.get(), list = listC.get();
          var refused = mode === 'allow' && list.length && d.your_country && !contains(list, d.your_country) || mode === 'deny' && contains(list, d.your_country);
          return { title: 'Save the country rule?', danger: !!refused, confirmLabel: 'Save rule',
            body: (mode === 'off' || !list.length ? 'There will be no country rule.' : (mode === 'allow' ? 'Only ' : 'Refused: ') + list.join(', ') + '.') +
              (refused ? ' Your own country (' + d.your_country + ') would be refused; the server will refuse this unless the allowlist covers you.' : '') };
        },
        run: function () { return api('PUT', '/country-rule', { mode: modeC.get(), countries: listC.get() }); }, done: 'Country rule saved.', after: refreshNow }) : null;
      ctx.body.appendChild(callout(d.mode !== 'off' && (d.countries || []).length ? 'ok' : 'info', null, state + (d.your_country ? ' You are connecting from ' + d.your_country + '.' : '')));
      ctx.body.appendChild(panel({ title: 'The rule', sub: canManage ? null : 'You can read this rule but not change it.',
        body: [modeC.node, h('div', { style: { marginTop: '14px' } }, listC.node), preview, presets, saveB ? h('div', { class: 'cx-form-actions' }, saveB) : null, m] }));
      if (d.notes && d.notes.length) ctx.body.appendChild(panel({ title: 'What this rule never does', body: h('ul', { class: 'cx-evidence' }, map(d.notes, function (n) { return h('li', { text: n }); })) }));
    });
  };

  /* ============================================================= devices == */

  SEC_BY_KEY.devices.render = function (ctx, r) {
    var m = msgNode();
    var f = { status: str(r.params.status), q: str(r.params.q) };
    var pendingHost = h('div'), listHost = h('div'), statsHost = h('div');
    var statusSel = h('select', { 'aria-label': 'Filter devices by status' }, map([['', 'Every device'], ['approved', 'Approved'], ['pending', 'Pending'], ['blocked', 'Blocked'], ['revoked', 'Revoked']], function (o) { return h('option', { value: o[0], text: o[1] }); }));
    statusSel.value = f.status;
    var search = h('input', { type: 'search', class: 'cx-search', placeholder: 'Label, owner, city, address, device id…', 'aria-label': 'Search devices', value: f.q, maxlength: '120' });
    var manage = has('devices.manage');
    function whatItIs(dv) { return cellSub(filter([str(dv.browser), str(dv.os)], Boolean).join(' on ') || '—', filter([str(dv.model), str(dv.form_factor)], Boolean).join(' · ')); }
    function deviceActions(dv) {
      var out = [];
      if (!manage) return out;
      if (dv.status === 'pending' && feat('device_approval')) out.push(approveBtn(dv));
      if (dv.status === 'approved') out.push(btn('Rename', { kind: 'secondary', sm: true, onClick: function (e) { e.stopPropagation(); formDialog({ title: 'Rename device', fields: [{ key: 'label', label: 'Name', type: 'text', value: dv.label, maxlength: 60 }], submit: function (v) { return api('PATCH', '/devices/' + enc(dv.id), v); } }).then(function (x) { if (x) { toast('Renamed.', 'ok'); reload(); } }); } }));
      if (feat('device_block') && dv.status !== 'blocked') out.push(act('Block', { kind: 'ghost-danger', msg: m,
        confirm: { title: 'Block ' + str(dv.label, 'this device') + '?', body: 'It is turned away before the password box, on any network.', confirmLabel: 'Block it', danger: true, input: { label: 'Reason', type: 'text', optional: true } },
        run: function (ans) { return api('POST', '/devices/' + enc(dv.id) + '/block', { reason: ans.value || '' }); }, done: 'Device blocked.', after: reload }));
      if (feat('device_block') && dv.status === 'blocked') out.push(act('Unblock', { msg: m, confirm: { title: 'Unblock ' + str(dv.label, 'this device') + '?', confirmLabel: 'Unblock' },
        run: function () { return api('POST', '/devices/' + enc(dv.id) + '/unblock', {}); }, done: 'Device unblocked.', after: reload }));
      out.push(act(dv.status === 'pending' ? 'Dismiss' : 'Revoke', { kind: 'ghost-danger', msg: m,
        confirm: { title: (dv.status === 'pending' ? 'Dismiss ' : 'Revoke ') + str(dv.label, 'this device') + '?', body: dv.current ? 'This is the device you are using now.' : 'It goes back behind the allowlist immediately.', confirmLabel: dv.status === 'pending' ? 'Dismiss' : 'Revoke', danger: true },
        run: function () { return api('DELETE', '/devices/' + enc(dv.id)); }, done: 'Done.', after: reload }));
      return out;
    }
    var deviceTiers = null;
    function approveBtn(dv) {
      return btn('Approve', { sm: true, onClick: function (e) {
        e.stopPropagation();
        formDialog({ title: 'Approve this device', intro: 'Approving says you know whose machine it is. It can then reach sign-in from any network; it still needs a password and a code.',
          fields: [{ key: 'label', label: 'Name it', type: 'text', value: dv.label || '', placeholder: 'Mo’s laptop', maxlength: 60 }]
            .concat(isArr(deviceTiers) && deviceTiers.length ? [{ key: 'tier', label: 'Trust level', type: 'select', value: str(deviceTiers[0].value),
              options: map(deviceTiers, function (t) { return { value: str(t.value), label: str(t.label, 'Tier ' + t.value), description: t.description || null }; }) }] : [])
            .concat(feat('device_expiry') ? [{ key: 'expires_at', label: 'Approved until', type: 'date', optional: true, hint: 'Leave blank to keep it approved until revoked.' }] : []),
          submitLabel: 'Approve', submit: function (v) {
            var body = { label: v.label, person_id: dv.person ? dv.person.id : null };
            if (v.tier !== undefined && v.tier !== '') body.tier = isNaN(Number(v.tier)) ? v.tier : Number(v.tier);
            if (v.expires_at) body.expires_at = v.expires_at;
            return api('POST', '/devices/' + enc(dv.id) + '/approve', body); } })
          .then(function (x) { if (x) { toast('Device approved.', 'ok'); reload(); } });
      } });
    }
    var cols = [{ label: 'Device', lead: true }, { label: cap1(noun()) }, { label: 'What it is' }, { label: 'Status' }, { label: 'Where' }, { label: 'Last seen' }, { label: '', cls: 'cx-actions' }];
    function rowOf(dv) {
      return { label: 'Open ' + str(dv.label, dv.id), onOpen: function () { openDevice(dv, reload); }, dim: dv.status === 'revoked', cells: [
        cellSub(h('span', null, txt(str(dv.label, 'Unnamed device')), dv.current ? txt(' ') : null, dv.current ? badge('this device', 'info') : null), String(dv.id).slice(0, 12) + (String(dv.id).length > 12 ? '…' : '')),
        personLink(dv.person), whatItIs(dv), h('span', null, statusBadge(dv.status), dv.reason ? h('span', { class: 'cx-cell-sub', text: dv.reason }) : null),
        cellSub(dv.ip ? mono(dv.ip) : faint('—'), placeText(dv)), when(dv.last_seen), deviceActions(dv)] };
    }
    var pg = pager(function (cursor) { return api('GET', '/devices' + qs({ status: f.status, q: f.q, limit: 50, cursor: cursor })); }, function (items, res) {
      var c = res.counts || {};
      if (isArr(res.tiers)) deviceTiers = res.tiers;
      replace(statsHost, statGrid([{ label: 'Approved', value: num(c.approved, '—') }, feat('device_approval') ? { label: 'Waiting for approval', value: num(c.pending, 0), tone: num(c.pending, 0) ? 'warn' : null } : null,
        feat('device_block') ? { label: 'Blocked', value: num(c.blocked, 0) } : null].filter(Boolean)));
      if (res.gating !== undefined) statsHost.appendChild(callout(res.gating ? 'ok' : 'info', 'Device gating is ' + (res.gating ? 'on' : 'off') + '.', res.gating ? 'Only approved devices can reach sign-in, on top of the allowlist.' : 'Any device on an allowed network can reach sign-in. Turn it on in Settings.'));
      replace(listHost, panel({ title: f.status ? cap1(statusInfo(f.status)[0]) + ' devices' : 'All devices', flush: true, body: table(cols, items, rowOf, 'No devices match that.') }), pg.foot);
      ctx.ready();
    });
    function loadPending() {
      if (!feat('device_approval') || f.status) { clear(pendingHost); return; }
      then(api('GET', '/devices' + qs({ status: 'pending', limit: 50 })), function (res) {
        var items = res.items || [];
        if (!items.length) { clear(pendingHost); return; }
        replace(pendingHost, panel({ title: 'Waiting for approval', sub: plural(items.length, 'device') + '. Nobody on an unapproved device gets past the password box while device approval is on.', flush: true,
          body: table(cols, items, rowOf) }));
      }, function () { clear(pendingHost); });
    }
    function reload() {
      replace(listHost, loading(3));
      loadPending();
      pg.load(false).then(null, function (err) { replace(listHost, errorBlock(err, reload)); ctx.ready(); });
    }
    var refilter = function () { f.status = statusSel.value; f.q = search.value.trim(); quietHash(hashFor('devices', [], f)); reload(); };
    statusSel.addEventListener('change', refilter);
    search.addEventListener('input', debounce(refilter, 250));
    ctx.body.appendChild(statsHost);
    ctx.body.appendChild(pendingHost);
    ctx.body.appendChild(h('div', { class: 'cx-toolbar', role: 'search' }, statusSel, search));
    ctx.body.appendChild(m);
    ctx.body.appendChild(listHost);
    reload();
  };

  function openDevice(dv, after) {
    var L = layer({ title: str(dv.label, 'Device'), drawer: true });
    L.body.appendChild(loading(3));
    L.foot.appendChild(btn('Close', { kind: 'secondary', onClick: function () { L.close(); } }));
    then(api('GET', '/devices/' + enc(dv.id)), function (d) {
      var x = assign({}, dv, d.device || {});
      replace(L.body,
        h('div', { class: 'cx-chips', style: { marginBottom: '12px' } }, statusBadge(x.status), x.current ? badge('this device', 'info') : null),
        kv([['Device id', mono(x.id, 'cx-break')], [cap1(noun()), x.person ? personLink(x.person) : null], ['Browser', filter([str(x.browser), str(x.os)], Boolean).join(' on ')],
          ['Model', str(x.model)], ['Form factor', str(x.form_factor)], ['Address', x.ip ? mono(x.ip) : null], ['Where', placeText(x)],
          ['First seen', x.first_seen ? fmtFull(x.first_seen) : ''], ['Last seen', x.last_seen ? fmtFull(x.last_seen) : ''],
          ['Approved by', x.approved_by ? personLink(x.approved_by) : null], ['Sign-ins', x.sign_ins !== undefined ? String(x.sign_ins) : '']]),
        d.users && d.users.length ? h('div', { class: 'cx-kv-section' }, h('h4', { text: 'Who has signed in on it' }),
          table([{ label: cap1(noun()), lead: true }, { label: 'Sign-ins', cls: 'num' }, { label: 'Last seen' }], d.users, function (u) { return { cells: [personLink(u), String(num(u.sign_ins, 0)), when(u.last_seen)] }; })) : null,
        sectionsBlock(d.sections),
        d.unavailable && d.unavailable.length ? h('p', { class: 'cx-hint', style: { marginTop: '14px' }, text: 'A browser cannot see: ' + d.unavailable.join(', ') + '.' }) : null);
    }, function (err) { replace(L.body, errorBlock(err)); });
  }

  /* ============================================================ sessions == */

  SEC_BY_KEY.sessions.render = function (ctx, r) {
    var m = msgNode();
    var f = { q: str(r.params.q), person: str(r.params.person), include_ended: r.params.include_ended === '1' };
    var search = h('input', { type: 'search', class: 'cx-search', placeholder: 'Name, address, city, device…', 'aria-label': 'Search sessions', value: f.q, maxlength: '120' });
    var ended = h('input', { type: 'checkbox', checked: f.include_ended });
    var listHost = h('div');
    var pg = pager(function (cursor) { return api('GET', '/sessions' + qs(assign({ limit: 50, cursor: cursor }, f))); }, function (items) {
      var live = filter(items, function (s) { return s.active !== false; }).length;
      replace(listHost, panel({ title: plural(live, 'live session'), sub: f.include_ended ? 'Ended sessions are shown greyed out.' : null, flush: true, body: sessionsTable(items, true, m, reload) }), pg.foot);
      ctx.ready();
    });
    function reload() {
      replace(listHost, loading(3));
      pg.load(false).then(null, function (err) { replace(listHost, errorBlock(err, reload)); ctx.ready(); });
    }
    var refilter = function () { f.q = search.value.trim(); f.include_ended = ended.checked; quietHash(hashFor('sessions', [], f)); reload(); };
    search.addEventListener('input', debounce(refilter, 250));
    ended.addEventListener('change', refilter);
    ctx.body.appendChild(h('div', { class: 'cx-toolbar', role: 'search' }, search, h('label', { class: 'cx-check' }, ended, h('span', { text: 'Include ended sessions' }))));
    ctx.body.appendChild(m);
    ctx.body.appendChild(listHost);
    reload();
  };

  /* =============================================================== audit == */

  var AUDIT_CATS = [['', 'Every category'], ['auth', 'Sign-in'], ['people', 'People'], ['roles', 'Roles'], ['devices', 'Devices'], ['security', 'Security'],
    ['sessions', 'Sessions'], ['settings', 'Settings'], ['streaks', 'Streaks'], ['audit', 'Audit'], ['system', 'System']];

  SEC_BY_KEY.audit.render = function (ctx, r) {
    var m = msgNode();
    var f = { q: str(r.params.q), category: str(r.params.category), severity: str(r.params.severity), outcome: str(r.params.outcome),
      from: str(r.params.from), to: str(r.params.to), person: str(r.params.person), actor: str(r.params.actor), action: str(r.params.action) };
    var search = h('input', { type: 'search', class: 'cx-search', placeholder: 'Action, detail, actor, address…', 'aria-label': 'Search the audit log', value: f.q, maxlength: '120' });
    var cat = h('select', { 'aria-label': 'Category' }, map(AUDIT_CATS, function (o) { return h('option', { value: o[0], text: o[1] }); }));
    var sev = h('select', { 'aria-label': 'Severity' }, map([['', 'Any severity'], ['info', 'Info'], ['notice', 'Notice'], ['warning', 'Warning'], ['critical', 'Critical']], function (o) { return h('option', { value: o[0], text: o[1] }); }));
    var out = h('select', { 'aria-label': 'Outcome' }, map([['', 'Any outcome'], ['success', 'Success'], ['failure', 'Failure'], ['denied', 'Denied']], function (o) { return h('option', { value: o[0], text: o[1] }); }));
    var from = h('input', { type: 'date', 'aria-label': 'From date', value: f.from });
    var to = h('input', { type: 'date', 'aria-label': 'To date', value: f.to });
    cat.value = f.category; sev.value = f.severity; out.value = f.outcome;
    var verifyHost = h('div');
    if (feat('audit_verify')) ctx.actions.appendChild(act('Verify integrity', { kind: 'secondary', sm: false,
      run: function () { return api('GET', '/audit/verify'); },
      done: function (res) {
        replace(verifyHost, callout(res.intact ? 'ok' : 'danger', res.intact ? 'The chain is intact.' : 'The chain is broken' + (res.break_at ? ' at entry #' + res.break_at : '') + '.',
          str(res.message, 'Checked ' + plural(num(res.checked, 0), 'entry', 'entries') + '.')));
        return res.intact ? 'Audit chain verified.' : 'Audit chain broken.';
      } }));
    if (feat('audit_export') && has('audit.export')) ctx.actions.appendChild(downloadLink('Export CSV', '/audit/export' + qs(assign({ format: 'csv' }, f))));
    var listHost = h('div');
    var canRevert = false;
    var pg = pager(function (cursor) { return api('GET', '/audit' + qs(assign({ limit: 50, cursor: cursor }, f))); }, function (items, res) {
      canRevert = feat('audit_revert') && has('audit.revert') && res.can_revert !== false;
      if (res.filters && res.filters.categories && cat.options.length <= AUDIT_CATS.length && !cat._custom) {
        cat._custom = true;
        replace(cat, h('option', { value: '', text: 'Every category' }), map(res.filters.categories, function (o) { return h('option', { value: str(o.value), text: str(o.label, o.value) }); }));
        cat.value = f.category;
      }
      replace(listHost, panel({ title: f.person ? 'Entries about ' + noun() + ' #' + f.person : 'Entries', sub: res.chained ? 'Hash-chained: an edited or deleted row shows up as a break when you verify.' : null, flush: true,
        actions: f.person ? [btn('Show everyone', { kind: 'secondary', sm: true, onClick: function () { f.person = ''; refilter(); } })] : null,
        body: items.length ? h('ul', { class: 'cx-feed' }, map(items, function (e) {
          return auditLine(e, { onOpen: function (x) { quietHash(hashFor('audit', [x.id], f)); openAudit(x, canRevert, reload); },
            side: canRevert && e.revertible && !e.reverted_at ? revertBtn(e, m, reload) : null });
        })) : h('div', { class: 'cx-empty', text: 'No entries match that.' }) }), pg.foot);
      ctx.ready();
      if (r.parts[0]) { var hit = find(items, function (x) { return String(x.id) === String(r.parts[0]); }); openAuditById(r.parts[0], hit, canRevert, reload); r = { parts: [], params: r.params }; }
    });
    function reload() {
      replace(listHost, loading(4));
      pg.load(false).then(null, function (err) { replace(listHost, errorBlock(err, reload)); ctx.ready(); });
    }
    var refilter = function () {
      f.q = search.value.trim(); f.category = cat.value; f.severity = sev.value; f.outcome = out.value; f.from = from.value; f.to = to.value;
      quietHash(hashFor('audit', [], f));
      reload();
    };
    search.addEventListener('input', debounce(refilter, 300));
    each([cat, sev, out, from, to], function (x) { x.addEventListener('change', refilter); });
    ctx.body.appendChild(h('div', { class: 'cx-toolbar', role: 'search' }, search, cat, sev, out,
      h('span', { class: 'cx-tool-label', 'aria-hidden': 'true', text: 'From' }), from, h('span', { class: 'cx-tool-label', 'aria-hidden': 'true', text: 'to' }), to));
    ctx.body.appendChild(verifyHost);
    ctx.body.appendChild(m);
    ctx.body.appendChild(listHost);
    reload();
  };
  SEC_BY_KEY.audit.update = function (ctx, r) {
    if (r.parts[0]) openAuditById(r.parts[0], null, feat('audit_revert') && has('audit.revert'), refreshNow);
    else refreshNow();
  };

  function revertBtn(e, m, after) {
    return act('Revert', { kind: 'ghost-danger', msg: m,
      confirm: { title: 'Revert “' + str(e.detail || e.action) + '”?', body: 'The change is undone and the revert is itself written to the log.', confirmLabel: 'Revert it', danger: true },
      run: function () { return api('POST', '/audit/' + enc(e.id) + '/revert', {}); },
      done: function (res) { return 'Reverted' + (res && res.note ? ': ' + res.note : '.'); }, after: after });
  }
  function openAuditById(id, entry, canRevert, after) {
    if (entry) { openAudit(entry, canRevert, after); return; }
    then(api('GET', '/audit/' + enc(id)), function (res) { openAudit(res.entry || res, canRevert, after); }, function (err) { fail(null, err); });
  }
  function openAudit(e, canRevert, after) {
    var L = layer({ title: str(e.action, 'Audit entry'), drawer: true, onClose: function () { if (STATE.section === 'audit') quietHash('#audit'); } });
    var m = msgNode();
    var changes = e.changes || [];
    L.body.appendChild(h('div', { class: 'cx-chips', style: { marginBottom: '12px' } }, statusBadge(e.severity || 'info'), statusBadge(e.outcome || 'success'), e.reverted_at ? badge('Reverted ' + fmtAgo(e.reverted_at), 'muted') : null));
    if (e.detail) L.body.appendChild(h('p', { text: e.detail }));
    L.body.appendChild(m);
    L.body.appendChild(kv([['Entry', '#' + e.id], ['When', fmtFull(e.ts)], ['Who', e.actor ? personLink(e.actor) : 'System'],
      ['Target', e.target ? (e.target.type === 'person' && e.target.id ? personLink({ id: e.target.id, name: e.target.label }) : txt(str(e.target.label || e.target.id))) : null],
      ['Category', str(e.category)], ['Address', e.ip ? mono(e.ip) : null], ['Country', str(e.country)],
      ['Reverted by', e.reverted_by ? personLink(e.reverted_by) : null]]));
    if (e.user_agent) L.body.appendChild(h('div', { class: 'cx-kv-section' }, h('h4', { text: 'User agent' }), h('p', { class: 'cx-mono cx-break', text: e.user_agent })));
    if (changes.length) {
      L.body.appendChild(h('div', { class: 'cx-kv-section' }, h('h4', { text: 'What changed' }),
        h('table', { class: 'cx-diff' }, h('thead', null, h('tr', null, h('th', { text: 'Field' }), h('th', { text: 'Before' }), h('th', { text: 'After' }))),
          h('tbody', null, map(changes, function (c) {
            return h('tr', null, h('td', { class: 'cx-mono', text: str(c.field) }), h('td', { class: 'before cx-break', text: valueText(c.before) }), h('td', { class: 'after cx-break', text: valueText(c.after) }));
          })))));
    }
    if (canRevert && e.revertible && !e.reverted_at) L.foot.appendChild(revertBtn(e, m, function () { L.close(); if (after) after(); }));
    if (e.alert_id && sectionAvailable(SEC_BY_KEY.alerts)) L.foot.appendChild(linkBtn('The alert it sent', hashFor('alerts', [], { q: e.alert_id })));
    L.foot.appendChild(btn('Close', { kind: 'secondary', onClick: function () { L.close(); } }));
  }

  /* ============================================================== alerts == */

  SEC_BY_KEY.alerts.render = function (ctx, r) {
    var m = msgNode();
    var f = { status: str(r.params.status), q: str(r.params.q) };
    var statusSel = h('select', { 'aria-label': 'Delivery status' }, map([['', 'Any status'], ['sent', 'Sent'], ['throttled', 'Throttled'], ['failed', 'Failed'], ['queued', 'Queued']], function (o) { return h('option', { value: o[0], text: o[1] }); }));
    statusSel.value = f.status;
    var search = h('input', { type: 'search', class: 'cx-search', placeholder: 'Event, subject, address…', 'aria-label': 'Search alerts', value: f.q, maxlength: '120' });
    var routeHost = h('div'), listHost = h('div');
    if (feat('alerts_test') && has('alerts.test')) ctx.actions.appendChild(act('Send test alert', { kind: 'secondary', sm: false,
      confirm: { title: 'Send a test security alert?', body: 'It goes through the normal mail path and appears in this list.', confirmLabel: 'Send it' },
      run: function () { return api('POST', '/alerts/test', {}); }, done: 'Test alert sent.', after: function () { reload(); } }));
    var pg = pager(function (cursor) { return api('GET', '/alerts' + qs(assign({ limit: 50, cursor: cursor }, f))); }, function (items, res) {
      var rt = res.routing;
      if (rt) replace(routeHost, panel({ title: 'Where alerts go', body: kv([
        ['From', h('span', null, mono(rt.from), h('span', { class: 'cx-cell-sub', text: rt.from_source === 'env' ? 'set by ALERTS_EMAIL_FROM' : 'default for this domain' }))],
        ['To', h('span', null, mono(rt.to), h('span', { class: 'cx-cell-sub', text: rt.to_source === 'env' ? 'set by ALERTS_EMAIL_TO' : 'default for this domain' }))],
        ['Throttle', str(rt.throttle, 'one email per event and key per 10 minutes')]]) }));
      replace(listHost, panel({ flush: true, title: 'Alerts', body: table([{ label: 'When' }, { label: 'Event', lead: true }, { label: 'Subject' }, { label: 'To' }, { label: 'Status' }, { label: '', cls: 'cx-actions' }], items, function (a) {
        return { cells: [when(a.ts),
          h('span', null, mono(a.event), a.owner_lockout ? h('span', { style: { display: 'block', marginTop: '3px' } }, badge('owner locked out', 'danger')) : null),
          cellSub(str(a.subject), filter([a.ip ? str(a.ip) : '', a.person ? personName(a.person) : ''], Boolean).join(' · ')),
          a.to ? mono(a.to) : null,
          h('span', null, statusBadge(a.status), num(a.suppressed, 0) ? h('span', { class: 'cx-cell-sub', text: '+' + num(a.suppressed, 0) + ' more folded in' }) : null,
            a.error ? h('span', { class: 'cx-cell-sub', style: { color: 'var(--cx-danger)' }, text: a.error }) : null,
            a.provider ? h('span', { class: 'cx-cell-sub', text: 'via ' + a.provider }) : null),
          a.audit_id && sectionAvailable(SEC_BY_KEY.audit) ? linkBtn('Audit entry', '#audit/' + enc(a.audit_id)) : null] };
      }, 'No alerts match that.') }), pg.foot);
      ctx.ready();
    });
    function reload() {
      replace(listHost, loading(3));
      pg.load(false).then(null, function (err) { replace(listHost, errorBlock(err, reload)); ctx.ready(); });
    }
    var refilter = function () { f.status = statusSel.value; f.q = search.value.trim(); quietHash(hashFor('alerts', [], f)); reload(); };
    statusSel.addEventListener('change', refilter);
    search.addEventListener('input', debounce(refilter, 250));
    ctx.body.appendChild(routeHost);
    ctx.body.appendChild(h('div', { class: 'cx-toolbar', role: 'search' }, statusSel, search));
    ctx.body.appendChild(m);
    ctx.body.appendChild(listHost);
    reload();
  };

  /* ================================================================ boot == */

  function readConfig(root) {
    var c = assign({}, window.CONSOLE_CONFIG || {});
    var ds = root.dataset || {};
    if (ds.config) { try { assign(c, JSON.parse(ds.config)); } catch (e) { /* ignore a bad attribute */ } }
    each(['apiBase', 'signOutUrl', 'homeUrl', 'brand', 'loginUrl'], function (k) { if (ds[k]) c[k] = ds[k]; });
    c.apiBase = String(c.apiBase || '/api/console').replace(/\/+$/, '');
    return c;
  }

  function fatal(err, retry) {
    clear(ROOT);
    if (ROOT.className.indexOf('cx') === -1) ROOT.className += ' cx';
    var m = msgNode();
    ROOT.appendChild(h('div', { class: 'cx-fatal' }, panel({ title: 'The console could not start', body: [m,
      h('div', { class: 'cx-form-actions' }, btn('Try again', { onClick: retry }), CFG.signOutUrl ? h('a', { class: 'cx-btn secondary', href: CFG.signOutUrl, text: 'Sign in again' }) : null)] })));
    toastHost = null;
    fail(m, err);
  }

  function start() {
    ROOT = document.getElementById('console-root');
    if (!ROOT) return;
    CFG = readConfig(ROOT);
    if (ROOT.className.indexOf('cx') === -1) ROOT.className = (ROOT.className ? ROOT.className + ' ' : '') + 'cx';
    replace(ROOT, h('div', { class: 'cx-fatal' }, loading(3)));
    then(api('GET', '/bootstrap'), function (b) {
      BOOT = b;
      PERMS = {};
      each(b.perms || [], function (k) { PERMS[k] = true; });
      FEAT = b.features || {};
      buildShell();
      window.addEventListener('hashchange', route);
      route();
    }, function (err) { fatal(err, start); });
  }

  window.ConsoleKit = {
    loaded: true, version: VERSION,
    refresh: function () { refreshNow(); },
    go: function (hash) { go(String(hash).charAt(0) === '#' ? String(hash) : '#' + hash); },
    restart: start
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(window, document);
