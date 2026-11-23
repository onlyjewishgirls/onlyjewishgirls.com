/*!
 * Console kit — export.js
 * "Export this section" as TXT, JSON, CSV, DOCX, PDF or HTML, generated in the
 * browser: no network calls, no third-party code. One source of truth:
 * console.js carries a byte-identical copy of this file between its
 * "BEGIN export.js" / "END export.js" markers (tools/sync-export.js keeps them
 * in step and the tests fail if they drift).
 *
 * Standalone use (admin pages that are not the console): include this file and
 * it adds an Export menu to every element marked data-export-section="Title",
 * or to <main> when nothing is marked. See API.md, "Exporting".
 *
 * Safety rule: text collected from the page is only ever written into the DOM
 * through textContent, and every writer escapes for its own format.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && root.document) {
    if (!root.ConsoleExport) root.ConsoleExport = api;
    api._autoStart();
  }
}(typeof window !== 'undefined' ? window : this, function (window) {
  'use strict';
  if (window && window.ConsoleExport && window.ConsoleExport.loaded) return window.ConsoleExport;

  var VERSION = '1.0.0';
  var document = window && window.document;
  var hasOwn = Object.prototype.hasOwnProperty;

  /* ------------------------------------------------------------ helpers -- */

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function each(list, fn) { if (!list) return; for (var i = 0; i < list.length; i++) fn(list[i], i); }
  function map(list, fn) { var out = []; each(list, function (v, i) { out.push(fn(v, i)); }); return out; }
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function norm(s) { return str(s).replace(/[\s\u00a0\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, ' ').replace(/^ +| +$/g, ''); }
  function repeat(ch, n) { var s = ''; for (var i = 0; i < n; i++) s += ch; return s; }
  /** Split into code points (keeps surrogate pairs together). */
  function chars(s) { return str(s).match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) || []; }
  function clen(s) { return str(s).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '_').length; }
  function pad(s, n) { var l = clen(s); return l >= n ? s : s + repeat(' ', n - l); }
  function two(n) { return (n < 10 ? '0' : '') + n; }

  /** Greedy word wrap to `width` units; measure(s) gives a width. Long words are broken. */
  function wrapWith(text, width, measure) {
    var out = [];
    each(str(text).split(/\r\n|\r|\n/), function (para) {
      var words = para.split(/ +/);
      var line = '';
      each(words, function (w) {
        if (w === '') return;
        var cand = line ? line + ' ' + w : w;
        if (measure(cand) <= width) { line = cand; return; }
        if (line) { out.push(line); line = ''; }
        if (measure(w) <= width) { line = w; return; }
        var piece = '';
        each(chars(w), function (c) {
          if (piece && measure(piece + c) > width) { out.push(piece); piece = ''; }
          piece += c;
        });
        line = piece;
      });
      out.push(line);
    });
    return out.length ? out : [''];
  }
  function wrapChars(text, width) { return wrapWith(text, width, clen); }

  /* --------------------------------------------------- slug and filename -- */

  function slug(s, fallback) {
    var t = str(s);
    if (t.normalize) { try { t = t.normalize('NFKD'); } catch (e) { /* ignore */ } }
    t = t.replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (t.length > 60) t = t.slice(0, 60).replace(/-+$/, '');
    return t || fallback || 'export';
  }
  /** YYYY-MM-DD of `date` in `timeZone` (IANA), or local time when not given. */
  function ymd(date, timeZone) {
    var d = date instanceof Date ? date : new Date(date || Date.now());
    if (timeZone && typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      try {
        var parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
        var o = {};
        each(parts, function (p) { o[p.type] = p.value; });
        if (o.year && o.month && o.day) return o.year + '-' + o.month + '-' + o.day;
      } catch (e) { /* fall through */ }
    }
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }
  function filename(site, section, date, ext, timeZone) {
    return slug(site, 'site') + '-' + slug(section, 'section') + '-' + ymd(date, timeZone) + '.' + ext;
  }
  /** A readable "generated" stamp for the documents. */
  function stamp(model) {
    var d = new Date(model.generated_at || Date.now());
    var tz = model.time_zone;
    if (tz && typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      try {
        var p = {};
        each(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d),
          function (x) { p[x.type] = x.value; });
        return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ' (' + tz + ')';
      } catch (e) { /* fall through */ }
    }
    return d.getUTCFullYear() + '-' + two(d.getUTCMonth() + 1) + '-' + two(d.getUTCDate()) + ' ' + two(d.getUTCHours()) + ':' + two(d.getUTCMinutes()) + ' UTC';
  }
  function docTitle(model) {
    return model.site ? str(model.site) + ' \u2014 ' + str(model.section) : str(model.section);
  }
  function rowCount(model) {
    var n = 0;
    each(model.panels, function (p) { each(p.tables, function (t) { n += (t.rows || []).length; }); });
    return n;
  }
  /** Normalise anything model-shaped so writers never trip on missing keys. */
  function tidy(m) {
    m = m || {};
    return {
      site: str(m.site), section: str(m.section), generated_at: str(m.generated_at || new Date().toISOString()),
      time_zone: m.time_zone ? str(m.time_zone) : undefined,
      intro: str(m.intro), notes: map(m.notes || [], str),
      panels: map(m.panels || [], function (p) {
        return {
          title: str(p.title),
          fields: map(p.fields || [], function (f) { return [str(f[0]), str(f[1])]; }),
          tables: map(p.tables || [], function (t) {
            var cols = map(t.columns || [], str);
            return { title: str(t.title), columns: cols, rows: map(t.rows || [], function (r) {
              var row = map(r || [], str);
              while (row.length < cols.length) row.push('');
              return row;
            }), empty: t.empty ? str(t.empty) : undefined };
          }),
          text: str(p.text)
        };
      })
    };
  }

  /* ================================================================ TXT == */

  var TXT_WIDTH = 100;
  var TXT_COL_MAX = 40;

  function toTXT(model) {
    var m = tidy(model);
    var L = [];
    var title = docTitle(m);
    L.push(title);
    L.push(repeat('=', Math.min(TXT_WIDTH, Math.max(4, clen(title)))));
    L.push('Generated: ' + stamp(m));
    if (m.intro) { L.push(''); each(wrapChars(m.intro, TXT_WIDTH), function (l) { L.push(l); }); }
    each(m.notes, function (n) { L.push(''); each(wrapChars('Note: ' + n, TXT_WIDTH), function (l) { L.push(l); }); });
    each(m.panels, function (p) {
      L.push('');
      if (p.title) { L.push(''); L.push(p.title); L.push(repeat('-', Math.min(TXT_WIDTH, Math.max(4, clen(p.title))))); }
      if (p.text) {
        each(p.text.split('\n'), function (line) { each(wrapChars(line, TXT_WIDTH), function (l) { L.push(l); }); });
        if (p.fields.length) L.push('');
      }
      if (p.fields.length) {
        var lw = 0;
        each(p.fields, function (f) { lw = Math.max(lw, Math.min(40, clen(f[0]))); });
        each(p.fields, function (f) {
          var vl = wrapChars(f[1] === '' ? '\u2014' : f[1], Math.max(30, TXT_WIDTH - lw - 3));
          var ll = wrapChars(f[0], lw);
          for (var i = 0; i < Math.max(vl.length, ll.length); i++) {
            L.push(pad(ll[i] || '', lw) + (i === 0 ? ' : ' : '   ') + (vl[i] || ''));
          }
        });
      }
      each(p.tables, function (t) {
        L.push('');
        if (t.title && t.title !== p.title) L.push(t.title);
        each(txtTable(t), function (l) { L.push(l); });
      });
    });
    return L.join('\n').replace(/[ \t]+$/gm, '') + '\n';
  }
  function txtTable(t) {
    var cols = t.columns;
    if (!cols.length) return ['(no columns)'];
    var w = map(cols, function (c) { return Math.min(TXT_COL_MAX, Math.max(1, clen(c))); });
    each(t.rows, function (r) {
      each(cols, function (c, i) {
        var longest = 0;
        each(str(r[i]).split('\n'), function (seg) { longest = Math.max(longest, clen(seg)); });
        w[i] = Math.min(TXT_COL_MAX, Math.max(w[i], longest));
      });
    });
    function line(cells) {
      var wrapped = map(cells, function (c, i) { return wrapChars(c, w[i]); });
      var h = 1;
      each(wrapped, function (x) { h = Math.max(h, x.length); });
      var out = [];
      for (var k = 0; k < h; k++) out.push(map(wrapped, function (x, i) { return pad(x[k] || '', w[i]); }).join(' | '));
      return out;
    }
    var out = line(cols);
    out.push(map(w, function (n) { return repeat('-', n); }).join('-+-'));
    each(t.rows, function (r) { out = out.concat(line(r)); });
    if (!t.rows.length) out.push(t.empty ? '(' + t.empty + ')' : '(no rows)');
    else out.push('(' + t.rows.length + (t.rows.length === 1 ? ' row)' : ' rows)'));
    return out;
  }

  /* =============================================================== JSON == */

  function toJSON(model) {
    var m = tidy(model);
    var out = { site: m.site, section: m.section, generated_at: m.generated_at };
    if (m.time_zone) out.time_zone = m.time_zone;
    if (m.intro) out.intro = m.intro;
    if (m.notes.length) out.notes = m.notes;
    out.panels = map(m.panels, function (p) {
      return { title: p.title, fields: p.fields, tables: map(p.tables, function (t) {
        var o = { title: t.title, columns: t.columns, rows: t.rows };
        if (t.empty) o.empty = t.empty;
        return o;
      }), text: p.text };
    });
    return JSON.stringify(out, null, 2) + '\n';
  }

  /* ================================================================ CSV == */

  /** One CSV cell: formula-injection guard, then RFC 4180 quoting. */
  function csvCell(v) {
    var s = str(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function csvRow(cells) { return map(cells, csvCell).join(','); }
  /**
   * One file. A section with a single table is a plain CSV (header + rows).
   * Anything more becomes one block per table / field list / text, each
   * preceded by a "# <title>" line and separated by a blank line.
   */
  function toCSV(model) {
    var m = tidy(model);
    var blocks = [];
    if (m.notes.length) blocks.push({ title: 'Notes', columns: ['Note'], rows: map(m.notes, function (n) { return [n]; }) });
    each(m.panels, function (p) {
      var name = p.title || m.section;
      if (p.fields.length) blocks.push({ title: name, columns: ['Field', 'Value'], rows: p.fields });
      each(p.tables, function (t) { blocks.push({ title: t.title || name, columns: t.columns, rows: t.rows }); });
      if (p.text) blocks.push({ title: name + ' (text)', columns: ['Text'], rows: map(p.text.split('\n'), function (l) { return [l]; }) });
    });
    if (!blocks.length) blocks.push({ title: m.section, columns: ['Text'], rows: [] });
    var lines = [];
    if (blocks.length === 1) {
      lines.push(csvRow(blocks[0].columns));
      each(blocks[0].rows, function (r) { lines.push(csvRow(r)); });
    } else {
      each(blocks, function (b, i) {
        if (i) lines.push('');
        lines.push(csvCell('# ' + norm(b.title)));
        lines.push(csvRow(b.columns));
        each(b.rows, function (r) { lines.push(csvRow(r)); });
      });
    }
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  /* =============================================================== HTML == */

  function escHTML(s) {
    return cleanXML(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var HTML_CSS = [
    ':root{color-scheme:light dark;--bg:#ffffff;--fg:#182230;--muted:#667085;--line:#e4e7ec;--head:#f2f4f7;--accent:#175cd3;--note:#fff6ed;--note-fg:#b54708}',
    '@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#ededf0;--muted:#a5a5b0;--line:#2e2e38;--head:#191920;--accent:#4d92f5;--note:#2a2010;--note-fg:#d9a441}}',
    '*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}',
    'body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}',
    'main{max-width:1180px;margin:0 auto;padding:28px 16px 56px}',
    '.eyebrow{margin:0 0 4px;color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}',
    'h1{font:700 26px/1.2 Georgia,"Times New Roman",serif;margin:0 0 6px}h2{font:700 18px/1.3 Georgia,"Times New Roman",serif;margin:0 0 10px}',
    'h3{font-size:14px;margin:14px 0 6px}.meta{color:var(--muted);font-size:12.5px;margin:0}.intro{color:var(--muted);max-width:80ch}',
    '.note{background:var(--note);color:var(--note-fg);border-radius:8px;padding:8px 12px;margin:12px 0;font-weight:600}',
    'section{border-top:1px solid var(--line);margin-top:24px;padding-top:16px}',
    'dl{display:grid;grid-template-columns:minmax(140px,max-content) minmax(0,1fr);gap:6px 18px;margin:0 0 14px}',
    'dt{color:var(--muted);font-weight:600}dd{margin:0}dd,p{overflow-wrap:anywhere;white-space:pre-line}',
    'td{overflow-wrap:break-word;white-space:pre-line;min-width:4em}th{white-space:nowrap}',
    '.wrap{overflow-x:auto;margin:0 0 16px;border:1px solid var(--line);border-radius:10px}',
    'table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;vertical-align:top;padding:7px 10px;border-bottom:1px solid var(--line)}',
    'thead th{background:var(--head);font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}tbody tr:last-child td{border-bottom:0}',
    '.count,.empty{color:var(--muted);font-size:12.5px;margin:-8px 0 16px}.text p{margin:0 0 6px}',
    '@media (max-width:640px){dl{grid-template-columns:minmax(0,1fr);gap:2px}dd{margin-bottom:8px}h1{font-size:22px}}',
    '@media print{main{max-width:none;padding:0}.wrap{overflow:visible;border:0}thead{display:table-header-group}tr{break-inside:avoid}}'
  ].join('\n');

  function toHTML(model) {
    var m = tidy(model);
    var H = [];
    H.push('<!doctype html>');
    H.push('<html lang="en">');
    H.push('<head>');
    H.push('<meta charset="utf-8">');
    H.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
    H.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">');
    H.push('<meta name="referrer" content="no-referrer">');
    H.push('<meta name="color-scheme" content="light dark">');
    H.push('<title>' + escHTML(docTitle(m)) + '</title>');
    H.push('<style>\n' + HTML_CSS + '\n</style>');
    H.push('</head>');
    H.push('<body>');
    H.push('<main>');
    H.push('<header>');
    if (m.site) H.push('<p class="eyebrow">' + escHTML(m.site) + '</p>');
    H.push('<h1>' + escHTML(m.section) + '</h1>');
    H.push('<p class="meta">Generated ' + escHTML(stamp(m)) + '</p>');
    if (m.intro) H.push('<p class="intro">' + escHTML(m.intro) + '</p>');
    each(m.notes, function (n) { H.push('<p class="note">' + escHTML(n) + '</p>'); });
    H.push('</header>');
    each(m.panels, function (p) {
      H.push('<section>');
      if (p.title) H.push('<h2>' + escHTML(p.title) + '</h2>');
      if (p.text) {
        H.push('<div class="text">');
        each(p.text.split('\n'), function (l) { H.push('<p>' + escHTML(l) + '</p>'); });
        H.push('</div>');
      }
      if (p.fields.length) {
        H.push('<dl>');
        each(p.fields, function (f) { H.push('<dt>' + escHTML(f[0]) + '</dt><dd>' + escHTML(f[1] === '' ? '\u2014' : f[1]) + '</dd>'); });
        H.push('</dl>');
      }
      each(p.tables, function (t) {
        if (t.title && t.title !== p.title) H.push('<h3>' + escHTML(t.title) + '</h3>');
        H.push('<div class="wrap"><table>');
        H.push('<thead><tr>' + map(t.columns, function (c) { return '<th scope="col">' + escHTML(c) + '</th>'; }).join('') + '</tr></thead>');
        H.push('<tbody>');
        each(t.rows, function (r) { H.push('<tr>' + map(r, function (c) { return '<td>' + escHTML(c) + '</td>'; }).join('') + '</tr>'); });
        H.push('</tbody></table></div>');
        H.push(t.rows.length ? '<p class="count">' + t.rows.length + (t.rows.length === 1 ? ' row' : ' rows') + '</p>'
          : '<p class="empty">' + escHTML(t.empty || 'No rows.') + '</p>');
      });
      H.push('</section>');
    });
    H.push('</main>');
    H.push('</body>');
    H.push('</html>');
    return H.join('\n') + '\n';
  }

  /* ======================================================== UTF-8, CRC32 == */

  /** Drop characters XML 1.0 forbids (and lone surrogates). */
  function cleanXML(s) {
    return str(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\ufffe\uffff]/g, '')
      .replace(/([\uD800-\uDBFF])(?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$2');
  }
  function utf8(s) {
    s = str(s);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; } else c = 0xFFFD;
      } else if (c >= 0xD800 && c <= 0xDFFF) c = 0xFFFD;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
  var CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = [];
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* ========================================================= ZIP (store) == */

  /** files: [{ name, data: Uint8Array|string }] -> Uint8Array. STORE only. */
  function zip(files, date) {
    var d = date instanceof Date ? date : new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var parts = [], central = [], offset = 0;
    function le(n, bytes) { var a = []; for (var i = 0; i < bytes; i++) a.push((n >>> (8 * i)) & 0xFF); return a; }
    each(files, function (f) {
      var name = utf8(f.name);
      var data = typeof f.data === 'string' ? utf8(f.data) : f.data;
      var crc = crc32(data);
      var head = [].concat(le(0x04034b50, 4), le(20, 2), le(0x0800, 2), le(0, 2), le(dosTime, 2), le(dosDate, 2),
        le(crc, 4), le(data.length, 4), le(data.length, 4), le(name.length, 2), le(0, 2));
      parts.push(new Uint8Array(head), name, data);
      central.push([[].concat(le(0x02014b50, 4), le(20, 2), le(20, 2), le(0x0800, 2), le(0, 2), le(dosTime, 2), le(dosDate, 2),
        le(crc, 4), le(data.length, 4), le(data.length, 4), le(name.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(offset, 4)), name]);
      offset += head.length + name.length + data.length;
    });
    var cdStart = offset, cdSize = 0;
    each(central, function (c) {
      var hdr = new Uint8Array(c[0]);
      parts.push(hdr, c[1]);
      cdSize += hdr.length + c[1].length;
    });
    parts.push(new Uint8Array([].concat(le(0x06054b50, 4), le(0, 2), le(0, 2), le(files.length, 2), le(files.length, 2),
      le(cdSize, 4), le(cdStart, 4), le(0, 2))));
    var total = 0;
    each(parts, function (p) { total += p.length; });
    var out = new Uint8Array(total), at = 0;
    each(parts, function (p) { out.set(p, at); at += p.length; });
    return out;
  }

  /* =============================================================== DOCX == */

  function escXML(s) {
    return cleanXML(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  var W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  var XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  function wRuns(text, rPr) {
    var out = [];
    var lines = str(text).split(/\r\n|\r|\n/);
    each(lines, function (line, i) {
      if (i) out.push('<w:r>' + (rPr || '') + '<w:br/></w:r>');
      var segs = line.split('\t');
      each(segs, function (seg, j) {
        if (j) out.push('<w:r>' + (rPr || '') + '<w:tab/></w:r>');
        if (seg !== '') out.push('<w:r>' + (rPr || '') + '<w:t xml:space="preserve">' + escXML(seg) + '</w:t></w:r>');
      });
    });
    return out.join('');
  }
  function wPara(text, style, rPr, pPrExtra) {
    var pPr = (style || pPrExtra) ? '<w:pPr>' + (style ? '<w:pStyle w:val="' + style + '"/>' : '') + (pPrExtra || '') + '</w:pPr>' : '';
    return '<w:p>' + pPr + wRuns(text, rPr) + '</w:p>';
  }
  function colWeights(columns, rows, maxChars) {
    var w = map(columns, function (c) { return Math.min(maxChars, Math.max(4, clen(c))); });
    each(rows, function (r) {
      each(columns, function (c, i) {
        var longest = 0;
        each(str(r[i]).split('\n'), function (seg) { longest = Math.max(longest, clen(seg)); });
        w[i] = Math.min(maxChars, Math.max(w[i], longest));
      });
    });
    return w;
  }
  function wTable(columns, rows, totalTw, opts) {
    opts = opts || {};
    var n = Math.max(1, columns.length);
    var weights = opts.widths || colWeights(columns, rows, 40);
    var sum = 0;
    each(weights, function (x) { sum += x; });
    var minTw = Math.min(700, Math.floor(totalTw / n));
    var widths = map(weights, function (x) { return Math.max(minTw, Math.floor(totalTw * x / (sum || 1))); });
    var over = 0;
    each(widths, function (x) { over += x; });
    if (over > totalTw) widths = map(widths, function (x) { return Math.floor(x * totalTw / over); });
    var border = '<w:top w:val="single" w:sz="4" w:space="0" w:color="D0D5DD"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D0D5DD"/>' +
      '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="D0D5DD"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D0D5DD"/>' +
      '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="E4E7EC"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="E4E7EC"/>';
    var X = ['<w:tbl><w:tblPr><w:tblW w:w="' + totalTw + '" w:type="dxa"/><w:tblBorders>' + border + '</w:tblBorders>' +
      '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>' +
      '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>'];
    X.push('<w:tblGrid>' + map(widths, function (x) { return '<w:gridCol w:w="' + x + '"/>'; }).join('') + '</w:tblGrid>');
    function cell(text, i, head, shade) {
      return '<w:tc><w:tcPr><w:tcW w:w="' + widths[i] + '" w:type="dxa"/>' + (shade ? '<w:shd w:val="clear" w:color="auto" w:fill="' + shade + '"/>' : '') + '</w:tcPr>' +
        wPara(text, 'TableText', head ? '<w:rPr><w:b/></w:rPr>' : null) + '</w:tc>';
    }
    if (!opts.noHeader) {
      X.push('<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>' + map(columns, function (c, i) { return cell(c, i, true, 'F2F4F7'); }).join('') + '</w:tr>');
    }
    each(rows, function (r) {
      X.push('<w:tr><w:trPr><w:cantSplit/></w:trPr>' + map(columns, function (c, i) { return cell(r[i], i, opts.boldFirst && i === 0, opts.boldFirst && i === 0 ? 'F9FAFB' : null); }).join('') + '</w:tr>');
    });
    X.push('</w:tbl>');
    return X.join('');
  }

  var DOCX_STYLES = XML_HEAD +
    '<w:styles xmlns:w="' + W_NS + '">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/><w:color w:val="182230"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/><w:color w:val="182230"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="344054"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Meta"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="667085"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Note"><w:name w:val="Note"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="B54708"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>' +
    '</w:styles>';

  function docxLayout(m) {
    var maxCols = 0;
    each(m.panels, function (p) { each(p.tables, function (t) { maxCols = Math.max(maxCols, t.columns.length); }); });
    return maxCols > 6 ? { w: 15840, h: 12240, landscape: true } : { w: 12240, h: 15840, landscape: false };
  }
  function docxDocument(m) {
    var page = docxLayout(m);
    var margin = 1080;
    var textW = page.w - 2 * margin;
    var B = [];
    if (m.site) B.push(wPara(m.site, 'Meta'));
    B.push(wPara(m.section, 'Title'));
    B.push(wPara('Generated ' + stamp(m), 'Meta'));
    if (m.intro) B.push(wPara(m.intro));
    each(m.notes, function (n) { B.push(wPara(n, 'Note')); });
    each(m.panels, function (p) {
      if (p.title) B.push(wPara(p.title, 'Heading1'));
      if (p.text) each(p.text.split('\n'), function (l) { B.push(wPara(l)); });
      if (p.fields.length) {
        var lw = 0;
        each(p.fields, function (f) { lw = Math.max(lw, Math.min(30, clen(f[0]))); });
        B.push(wTable(['Field', 'Value'], map(p.fields, function (f) { return [f[0], f[1] === '' ? '\u2014' : f[1]]; }), textW,
          { noHeader: true, boldFirst: true, widths: [Math.max(10, lw), Math.max(30, 90 - lw)] }));
        B.push(wPara(''));
      }
      each(p.tables, function (t) {
        if (t.title && t.title !== p.title) B.push(wPara(t.title, 'Heading2'));
        if (t.columns.length) B.push(wTable(t.columns, t.rows, textW));
        B.push(wPara(t.rows.length ? t.rows.length + (t.rows.length === 1 ? ' row' : ' rows') : (t.empty || 'No rows.'), 'Meta'));
      });
    });
    B.push('<w:sectPr><w:pgSz w:w="' + page.w + '" w:h="' + page.h + '"' + (page.landscape ? ' w:orient="landscape"' : '') + '/>' +
      '<w:pgMar w:top="' + margin + '" w:right="' + margin + '" w:bottom="' + margin + '" w:left="' + margin + '" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>');
    return XML_HEAD + '<w:document xmlns:w="' + W_NS + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' + B.join('') + '</w:body></w:document>';
  }
  function toDOCX(model) {
    var m = tidy(model);
    var now = new Date(m.generated_at);
    if (isNaN(now.getTime())) now = new Date();
    var iso = now.toISOString().replace(/\.\d+Z$/, 'Z');
    var ct = XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>';
    var rels = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>';
    var docRels = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';
    var core = XML_HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + escXML(docTitle(m)) + '</dc:title><dc:creator>Console kit export</dc:creator>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:modified>' +
      '</cp:coreProperties>';
    var app = XML_HEAD + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Console kit export.js</Application></Properties>';
    return zip([
      { name: '[Content_Types].xml', data: ct },
      { name: '_rels/.rels', data: rels },
      { name: 'docProps/core.xml', data: core },
      { name: 'docProps/app.xml', data: app },
      { name: 'word/_rels/document.xml.rels', data: docRels },
      { name: 'word/styles.xml', data: DOCX_STYLES },
      { name: 'word/document.xml', data: docxDocument(m) }
    ], now);
  }

  /* ================================================================ PDF == */

  // Adobe core-font advance widths (1/1000 em) for WinAnsiEncoding bytes 32..255.
  var HELV = '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,1000,333,1000,500,333,944,350,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500';
  var HELV_B = '278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,350,556,350,278,556,500,1000,556,556,333,1000,667,333,1000,350,611,350,350,278,278,500,500,350,556,1000,333,1000,556,333,944,350,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556';
  var WIDTHS = { F1: map(HELV.split(','), Number), F2: map(HELV_B.split(','), Number) };
  // Unicode -> WinAnsi bytes 0x80..0x9F.
  var WIN_EXTRA = { 8364: 128, 8218: 130, 402: 131, 8222: 132, 8230: 133, 8224: 134, 8225: 135, 710: 136, 8240: 137, 352: 138, 8249: 139, 338: 140, 381: 142,
    8216: 145, 8217: 146, 8220: 147, 8221: 148, 8226: 149, 8211: 150, 8212: 151, 732: 152, 8482: 153, 353: 154, 8250: 155, 339: 156, 382: 158, 376: 159 };
  // Characters outside WinAnsi that have a sensible ASCII spelling.
  var TRANSLIT = { 8594: '->', 8592: '<-', 8596: '<->', 8658: '=>', 8804: '<=', 8805: '>=', 8800: '!=', 8722: '-', 8208: '-', 8209: '-', 8210: '-', 8213: '-',
    8242: "'", 8243: '"', 10003: 'v', 10004: 'v', 10007: 'x', 10008: 'x', 10005: 'x', 9679: '*', 9675: 'o', 8729: '*', 8943: '...', 8203: '', 8204: '', 8205: '',
    8288: '', 65279: '', 173: '' };

  /** Unicode text -> array of WinAnsi codes. Unmappable characters become '?'. */
  function winAnsi(s) {
    var out = [];
    each(chars(str(s).replace(/[\r\n\t]+/g, ' ')), function (ch) {
      var cp = ch.length === 2 ? ((ch.charCodeAt(0) - 0xD800) * 0x400 + ch.charCodeAt(1) - 0xDC00 + 0x10000) : ch.charCodeAt(0);
      if (cp >= 0xFE00 && cp <= 0xFE0F) return; // variation selectors
      if (cp < 32 || cp === 127) { out.push(32); return; }
      if (cp < 127 || (cp >= 160 && cp <= 255)) { out.push(cp === 160 ? 32 : cp); return; }
      if (hasOwn.call(WIN_EXTRA, cp)) { out.push(WIN_EXTRA[cp]); return; }
      if (hasOwn.call(TRANSLIT, cp)) { var t = TRANSLIT[cp]; for (var i = 0; i < t.length; i++) out.push(t.charCodeAt(i)); return; }
      if (cp >= 0x2000 && cp <= 0x200A) { out.push(32); return; }
      var dec = '';
      if (ch.normalize) { try { dec = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { dec = ''; } }
      if (dec && dec !== ch && /^[\x20-\x7e\xa0-\xff]+$/.test(dec)) { for (var j = 0; j < dec.length; j++) out.push(dec.charCodeAt(j)); return; }
      out.push(63);
    });
    return out;
  }
  function pdfWidth(codes, font, size) {
    var w = WIDTHS[font], t = 0;
    for (var i = 0; i < codes.length; i++) t += codes[i] >= 32 ? (w[codes[i] - 32] || 556) : 278;
    return t * size / 1000;
  }
  function pdfStr(codes) {
    var s = '(';
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i];
      if (c === 40 || c === 41 || c === 92) s += '\\' + String.fromCharCode(c);
      else if (c < 32 || c > 126) s += '\\' + ('00' + c.toString(8)).slice(-3);
      else s += String.fromCharCode(c);
    }
    return s + ')';
  }
  /** Wrap WinAnsi codes to `width` points. Returns arrays of codes. */
  function pdfWrap(text, font, size, width) {
    var lines = [];
    each(str(text).split(/\r\n|\r|\n/), function (para) {
      var codes = winAnsi(para);
      var words = [], cur = [];
      each(codes, function (c) { if (c === 32) { if (cur.length) words.push(cur); cur = []; } else cur.push(c); });
      if (cur.length) words.push(cur);
      var line = [];
      each(words, function (wd) {
        var cand = line.length ? line.concat([32], wd) : wd;
        if (pdfWidth(cand, font, size) <= width) { line = cand; return; }
        if (line.length) { lines.push(line); line = []; }
        if (pdfWidth(wd, font, size) <= width) { line = wd; return; }
        var piece = [];
        each(wd, function (c) {
          if (piece.length && pdfWidth(piece.concat([c]), font, size) > width) { lines.push(piece); piece = []; }
          piece.push(c);
        });
        line = piece;
      });
      lines.push(line);
    });
    return lines;
  }
  function clip(lines, max, font, size, width) {
    if (lines.length <= max) return lines;
    var out = lines.slice(0, max);
    var last = out[max - 1].concat([133]);
    while (last.length > 1 && pdfWidth(last, font, size) > width) last.splice(last.length - 2, 1);
    out[max - 1] = last;
    return out;
  }
  function num(n) { return (Math.round(n * 100) / 100).toString(); }

  var PDF_MAX_CELL_LINES = 8;
  var PDF_MAX_FIELD_LINES = 40;

  function toPDF(model) {
    var m = tidy(model);
    var maxCols = 0;
    each(m.panels, function (p) { each(p.tables, function (t) { maxCols = Math.max(maxCols, t.columns.length); }); });
    var PW = maxCols > 6 ? 792 : 612, PH = maxCols > 6 ? 612 : 792;   // US Letter
    var M = 40, FOOT = 26;
    var W = PW - 2 * M;
    var pages = [], ops = null, y = 0;
    function newPage() { ops = []; pages.push(ops); y = PH - M; }
    function need(h) { if (!ops || y - h < M + FOOT) { newPage(); return true; } return false; }
    function text(x, yy, codes, font, size, grey) {
      ops.push('BT ' + (grey ? grey + ' g ' : '0.09 g ') + '/' + font + ' ' + size + ' Tf ' + num(x) + ' ' + num(yy) + ' Td ' + pdfStr(codes) + ' Tj ET');
    }
    function rule(x1, yy, x2, grey, wd) { ops.push(grey + ' G ' + (wd || 0.5) + ' w ' + num(x1) + ' ' + num(yy) + ' m ' + num(x2) + ' ' + num(yy) + ' l S'); }
    function box(x, yy, w, h, grey) { ops.push(grey + ' g ' + num(x) + ' ' + num(yy) + ' ' + num(w) + ' ' + num(h) + ' re f'); }
    function para(s, font, size, grey, gapAfter, indent) {
      var lh = size * 1.3;
      each(pdfWrap(s, font, size, W - (indent || 0)), function (ln) {
        need(lh);
        y -= lh;
        text(M + (indent || 0), y + size * 0.28, ln, font, size, grey);
      });
      y -= gapAfter || 0;
    }

    newPage();
    if (m.site) para(m.site.toUpperCase(), 'F2', 8, '0.42', 2);
    para(m.section, 'F2', 17, null, 2);
    para('Generated ' + stamp(m), 'F1', 8.5, '0.42', 6);
    if (m.intro) para(m.intro, 'F1', 9, '0.3', 6);
    each(m.notes, function (n) { para('Note: ' + n, 'F2', 9, '0.45', 4); });

    each(m.panels, function (p) {
      if (p.title) {
        need(40);
        y -= 10;
        rule(M, y, M + W, '0.85', 0.6);
        y -= 4;
        para(p.title, 'F2', 12.5, null, 4);
      } else y -= 6;
      if (p.text) { each(p.text.split('\n'), function (l) { para(l, 'F1', 9, null, 2); }); y -= 4; }
      if (p.fields.length) {
        var size = 9, lh = size * 1.3;
        var lw = 0;
        each(p.fields, function (f) { lw = Math.max(lw, pdfWidth(winAnsi(f[0]), 'F2', size)); });
        lw = Math.min(W * 0.36, lw + 12);
        each(p.fields, function (f) {
          var ll = pdfWrap(f[0], 'F2', size, lw - 10);
          var vl = clip(pdfWrap(f[1] === '' ? '\u2014' : f[1], 'F1', size, W - lw), PDF_MAX_FIELD_LINES, 'F1', size, W - lw);
          var rows = Math.max(ll.length, vl.length);
          if (rows * lh > PH - 2 * M - FOOT - 20) rows = Math.floor((PH - 2 * M - FOOT - 20) / lh);
          need(rows * lh + 3);
          for (var i = 0; i < rows; i++) {
            if (ll[i]) text(M, y - lh * (i + 1) + size * 0.28, ll[i], 'F2', size, '0.35');
            if (vl[i]) text(M + lw, y - lh * (i + 1) + size * 0.28, vl[i], 'F1', size);
          }
          y -= rows * lh + 3;
        });
        y -= 4;
      }
      each(p.tables, function (t) {
        if (t.title && t.title !== p.title) { need(30); y -= 4; para(t.title, 'F2', 10, null, 2); }
        drawTable(t);
      });
    });

    function drawTable(t) {
      var size = 8, lh = size * 1.25, padX = 4, padY = 3;
      var n = t.columns.length;
      if (!n) return;
      var nat = [], mins = [];
      each(t.columns, function (c, i) {
        var wHead = pdfWidth(winAnsi(c), 'F2', size);
        var natural = wHead, longestWord = 0;
        each(String(c).split(/\s+/), function (wd) { longestWord = Math.max(longestWord, pdfWidth(winAnsi(wd), 'F2', size)); });
        each(t.rows, function (r) {
          each(str(r[i]).split('\n'), function (seg) { natural = Math.max(natural, pdfWidth(winAnsi(seg), 'F1', size)); });
        });
        nat.push(Math.min(W * 0.45, natural + 2 * padX));
        mins.push(Math.min(nat[i], Math.max(36, Math.min(90, longestWord + 2 * padX))));
      });
      var sumNat = 0, sumMin = 0;
      each(nat, function (x) { sumNat += x; });
      each(mins, function (x) { sumMin += x; });
      var widths;
      if (sumNat <= W) widths = map(nat, function (x) { return x * W / sumNat; });
      else if (sumMin >= W) widths = map(mins, function () { return W / n; });
      else {
        var spare = W - sumMin, want = sumNat - sumMin;
        widths = map(nat, function (x, i) { return mins[i] + (x - mins[i]) * spare / want; });
      }
      function layoutRow(cells, font) {
        var lines = map(cells, function (c, i) {
          return clip(pdfWrap(str(c), font, size, widths[i] - 2 * padX), PDF_MAX_CELL_LINES, font, size, widths[i] - 2 * padX);
        });
        var h = 1;
        each(lines, function (l) { h = Math.max(h, l.length); });
        return { lines: lines, h: h * lh + 2 * padY };
      }
      var head = layoutRow(t.columns, 'F2');
      function drawRow(row, isHead, zebra) {
        var x = M;
        if (isHead) box(M, y - row.h, W, row.h, '0.93');
        else if (zebra) box(M, y - row.h, W, row.h, '0.975');
        each(row.lines, function (ls, i) {
          each(ls, function (ln, k) { text(x + padX, y - padY - lh * (k + 1) + size * 0.3, ln, isHead ? 'F2' : 'F1', size, isHead ? '0.3' : null); });
          x += widths[i];
        });
        y -= row.h;
        rule(M, y, M + W, '0.86', 0.4);
      }
      if (need(head.h + lh * 2 + 4)) { /* fresh page */ }
      drawRow(head, true);
      each(t.rows, function (r, idx) {
        var row = layoutRow(r, 'F1');
        if (need(row.h)) drawRow(head, true);
        drawRow(row, false, idx % 2 === 1);
      });
      var tail = t.rows.length ? t.rows.length + (t.rows.length === 1 ? ' row' : ' rows') : (t.empty || 'No rows.');
      y -= 2;
      para(tail, 'F1', 7.5, '0.45', 6);
    }

    // Footers, now that the page count is known.
    var footL = winAnsi(docTitle(m));
    each(pages, function (pg, i) {
      var right = winAnsi('Page ' + (i + 1) + ' of ' + pages.length);
      var rw = pdfWidth(right, 'F1', 7.5);
      var left = footL;
      while (left.length > 4 && pdfWidth(left, 'F1', 7.5) > W - rw - 20) left = left.slice(0, left.length - 2).concat([133]);
      pg.push('0.85 G 0.4 w ' + M + ' ' + (M + 10) + ' m ' + (M + W) + ' ' + (M + 10) + ' l S');
      pg.push('BT 0.45 g /F1 7.5 Tf ' + M + ' ' + M + ' Td ' + pdfStr(left) + ' Tj ET');
      pg.push('BT 0.45 g /F1 7.5 Tf ' + num(M + W - rw) + ' ' + M + ' Td ' + pdfStr(right) + ' Tj ET');
    });

    // Assemble. Every byte after the header comment is 7-bit ASCII, so string
    // offsets are byte offsets.
    var objs = [];
    function add(body) { objs.push(body); return objs.length; }
    var catalogId = add(null), pagesId = add(null);
    var f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    var f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    var kids = [];
    each(pages, function (pg) {
      var content = pg.join('\n');
      var cid = add('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
      kids.push(add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + PW + ' ' + PH + '] /Resources << /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R >> >> /Contents ' + cid + ' 0 R >>'));
    });
    objs[catalogId - 1] = '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>';
    objs[pagesId - 1] = '<< /Type /Pages /Kids [' + map(kids, function (k) { return k + ' 0 R'; }).join(' ') + '] /Count ' + kids.length + ' >>';
    var d = new Date(m.generated_at);
    if (isNaN(d.getTime())) d = new Date();
    var pdfDate = 'D:' + d.getUTCFullYear() + two(d.getUTCMonth() + 1) + two(d.getUTCDate()) + two(d.getUTCHours()) + two(d.getUTCMinutes()) + two(d.getUTCSeconds()) + 'Z';
    var infoId = add('<< /Title ' + pdfUnicode(docTitle(m)) + ' /Producer (Console kit export.js) /CreationDate (' + pdfDate + ') >>');
    var out = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
    var offsets = [];
    each(objs, function (body, i) { offsets.push(out.length); out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n'; });
    var xref = out.length;
    out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
    each(offsets, function (o) { out += ('0000000000' + o).slice(-10) + ' 00000 n \n'; });
    out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalogId + ' 0 R /Info ' + infoId + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    var bytes = new Uint8Array(out.length);
    for (var i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xFF;
    return bytes;
  }
  /** A PDF text string in UTF-16BE hex, for the document info (full Unicode). */
  function pdfUnicode(s) {
    var hex = '<FEFF';
    s = cleanXML(s);
    for (var i = 0; i < s.length; i++) hex += ('0000' + s.charCodeAt(i).toString(16).toUpperCase()).slice(-4);
    return hex + '>';
  }

  /* ============================================================ formats == */

  var FORMATS = [
    { key: 'txt', label: 'Text', ext: 'txt', mime: 'text/plain;charset=utf-8', build: toTXT },
    { key: 'json', label: 'JSON', ext: 'json', mime: 'application/json;charset=utf-8', build: toJSON },
    { key: 'csv', label: 'CSV', ext: 'csv', mime: 'text/csv;charset=utf-8', build: toCSV },
    { key: 'docx', label: 'Word', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', build: toDOCX },
    { key: 'pdf', label: 'PDF', ext: 'pdf', mime: 'application/pdf', build: toPDF },
    { key: 'html', label: 'HTML', ext: 'html', mime: 'text/html;charset=utf-8', build: toHTML }
  ];
  var FORMAT_BY_KEY = {};
  each(FORMATS, function (f) { FORMAT_BY_KEY[f.key] = f; });

  /** -> { data: string|Uint8Array, mime, ext, filename } */
  function build(model, format, opts) {
    var f = FORMAT_BY_KEY[format];
    if (!f) throw new Error('Unknown export format: ' + format);
    opts = opts || {};
    var m = tidy(model);
    return { data: f.build(m), mime: f.mime, ext: f.ext,
      filename: filename(m.site, m.section, opts.date || m.generated_at, f.ext, opts.timeZone || m.time_zone) };
  }

  function download(data, name, mime) {
    var blob = new window.Blob([data], { type: mime });
    var url = window.URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); try { window.URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 30000);
  }

  /* ========================================================== collector == */

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, BUTTON: 1, SVG: 1, CANVAS: 1, IFRAME: 1, OBJECT: 1, EMBED: 1,
    VIDEO: 1, AUDIO: 1, IMG: 1, PICTURE: 1, META: 1, LINK: 1, DIALOG: 1 };
  var SKIP_ROLES = { tablist: 1, search: 1, menu: 1, menubar: 1, dialog: 1, alertdialog: 1, tooltip: 1, progressbar: 1 };
  var SKIP_CLASS = /(^|\s)(cx-btn|cx-toolbar|cx-table-foot|cx-skel|cx-export|cx-msg|cx-field-error|cx-once|cx-back|cx-x)(\s|$)/;
  var FORM_CLASS = /(^|\s)(cx-field|cx-form-row|cx-form-grid|cx-form-actions)(\s|$)/;
  var SR_CLASS = /(^|\s)(cx-sr|sr-only|visually-hidden|screen-reader-text)(\s|$)/;
  var HINT_CLASS = /(^|\s)(cx-hint|cx-set-desc|cx-opt|cx-field-error)(\s|$)/;
  var CONTAINER_CLASS = /(^|\s)cx-panel(\s|$)/;
  var STRUCT_SEL = 'table,dl,ul,ol,h1,h2,h3,h4,h5,h6,input,select,textarea,section,article,fieldset,[data-export-field],[data-export-panel],[role="tabpanel"],.cx-panel';

  function tag(el) { return el && el.tagName ? String(el.tagName).toUpperCase() : ''; }
  function cls(el) { var c = el.className; return typeof c === 'string' ? c : (c && c.baseVal) || ''; }
  function attr(el, k) { return el.getAttribute ? el.getAttribute(k) : null; }

  function skipped(el, o) {
    if (!el || el.nodeType !== 1) return false;
    var t = tag(el);
    if (SKIP_TAGS[t]) return true;
    if (el.hidden || attr(el, 'aria-hidden') === 'true' || el.hasAttribute('data-export-skip')) return true;
    if (t === 'INPUT' && attr(el, 'type') === 'hidden') return true;
    var role = attr(el, 'role');
    if (role && SKIP_ROLES[role]) return true;
    if (role === 'button' || role === 'status' && !norm(el.textContent)) return true;
    var c = cls(el);
    if (c && SKIP_CLASS.test(c)) return true;
    if (o && o.fields === 'marked' && (t === 'FORM' || (c && FORM_CLASS.test(c))) &&
      !el.hasAttribute('data-export-field') && !el.querySelector('[data-export-field]')) return true;
    if (o && o.fields === 'none' && t === 'FORM') return true;
    return false;
  }
  /** True when `el` or an ancestor up to `root` is skipped. */
  function inSkipped(el, root, o) {
    for (var n = el; n && n !== root; n = n.parentNode) if (n.nodeType === 1 && skipped(n, o)) return true;
    return false;
  }
  function blockish(el) { var d = displayOf(el); return d.indexOf('inline') !== 0 && d !== 'contents'; }
  function displayOf(el) {
    if (SR_CLASS.test(cls(el))) return 'inline';
    try { return window.getComputedStyle(el).display || 'inline'; } catch (e) { /* ignore */ }
    return /^(DIV|P|LI|UL|OL|TABLE|TR|SECTION|ARTICLE|HEADER|FOOTER|H[1-6]|DL|DT|DD|BLOCKQUOTE|PRE|FORM|FIELDSET)$/.test(tag(el)) ? 'block' : 'inline';
  }

  /** Visible text of a node, block boundaries joined with " · ". */
  function flatten(el, o, noSr) {
    if (el.hasAttribute && el.hasAttribute('data-export-text')) return norm(attr(el, 'data-export-text'));
    var parts = [], buf = '';
    function flush() { var s = norm(buf); if (s) parts.push(s); buf = ''; }
    function rec(n) {
      if (n.nodeType === 3) { buf += n.nodeValue; return; }
      if (n.nodeType !== 1 || skipped(n, o)) return;
      if (noSr && SR_CLASS.test(cls(n))) return;
      if (o && o.noHints && (HINT_CLASS.test(cls(n)) || n.hasAttribute('data-export-hint'))) return;
      var t = tag(n);
      if (t === 'BR') { flush(); return; }
      if (n.hasAttribute('data-export-text')) { buf += ' ' + attr(n, 'data-export-text') + ' '; return; }
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') {
        if (attr(n, 'role') === 'switch' || (t === 'INPUT' && n.type === 'checkbox' && o && o.inField)) buf += n.checked ? ' On ' : ' Off ';
        else if (o && o.inField) { var v = controlValue(n); if (v !== null) buf += ' ' + v + ' '; }
        return;
      }
      var block = displayOf(n) !== 'inline' && displayOf(n) !== 'contents';
      if (block) flush();
      for (var c = n.firstChild; c; c = c.nextSibling) rec(c);
      if (block) flush();
    }
    for (var c = el.firstChild; c; c = c.nextSibling) rec(c);
    flush();
    return parts.join(' \u00b7 ');
  }
  function textOfLabel(lab, o) {
    if (!lab) return '';
    return flatten(lab, { fields: o && o.fields, noHints: true });
  }
  function controlValue(c) {
    var t = tag(c);
    if (t === 'SELECT') {
      var sel = [];
      each(c.options, function (op) { if (op.selected) sel.push(norm(op.textContent)); });
      return sel.join(', ');
    }
    if (t === 'TEXTAREA') return str(c.value);
    var type = String(c.type || 'text').toLowerCase();
    if (/^(password|hidden|file|submit|button|reset|image|search)$/.test(type)) return null;
    if (type === 'checkbox') return c.checked ? 'Yes' : 'No';
    if (type === 'radio') return c.checked ? radioLabel(c) : null;
    return str(c.value);
  }
  function radioLabel(r) {
    var lab = (r.labels && r.labels[0]) || (r.closest && r.closest('label'));
    var t = lab ? textOfLabel(lab, {}) : '';
    return t ? t.split(' \u00b7 ')[0] : str(r.value);
  }
  function controlLabel(c, o) {
    var ids = attr(c, 'aria-labelledby');
    if (ids) {
      var bits = [];
      each(ids.split(/\s+/), function (id) { var x = document.getElementById(id); if (x) bits.push(norm(x.textContent)); });
      if (bits.join('')) return bits.join(' ');
    }
    if (attr(c, 'aria-label')) return norm(attr(c, 'aria-label'));
    if (c.labels && c.labels.length) { var l = textOfLabel(c.labels[0], o); if (l) return l; }
    return norm(attr(c, 'placeholder') || attr(c, 'name') || attr(c, 'title') || '');
  }
  /** Value of a [data-export-field] container: control values plus any unit text. */
  function fieldValue(box, labelEl, o) {
    var parts = [];
    var fo = { fields: o.fields, inField: true };
    function rec(n) {
      if (n.nodeType === 3) { var s = norm(n.nodeValue); if (s) parts.push(s); return; }
      if (n.nodeType !== 1 || n === labelEl || skipped(n, fo)) return;
      if (HINT_CLASS.test(cls(n)) || n.hasAttribute('data-export-hint') || n.hasAttribute('data-export-label')) return;
      var t = tag(n), role = attr(n, 'role');
      if (n.hasAttribute('data-export-text')) { parts.push(norm(attr(n, 'data-export-text'))); return; }
      if (role === 'radiogroup') {
        var picked = '';
        each(n.querySelectorAll('input[type="radio"]'), function (r) { if (r.checked) picked = radioLabel(r); });
        parts.push(picked || '\u2014');
        return;
      }
      if (role === 'group' && n.querySelector('input[type="checkbox"]')) {
        var on = [];
        each(n.querySelectorAll('input[type="checkbox"]'), function (b) { if (b.checked) on.push(radioLabel(b)); });
        parts.push(on.length ? on.join(', ') : 'None');
        return;
      }
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') {
        if (attr(n, 'role') === 'switch') { parts.push('\u0001', n.checked ? 'On' : 'Off', '\u0001'); return; }
        var v = controlValue(n);
        if (v !== null) { if (n.type === 'checkbox') parts.push('\u0001', v, '\u0001'); else parts.push(v); }
        return;
      }
      if (t === 'LABEL' && n.control && n.control !== n.querySelector('input,select,textarea')) return;
      var block = displayOf(n) !== 'inline' && displayOf(n) !== 'contents' && !/^(SPAN|LABEL|A|STRONG|EM|B|I|SMALL|CODE|TIME)$/.test(t);
      if (block) parts.push('\u0001');
      for (var c = n.firstChild; c; c = c.nextSibling) rec(c);
      if (block) parts.push('\u0001');
    }
    for (var c = box.firstChild; c; c = c.nextSibling) rec(c);
    var segs = [];
    each(parts.join(' ').split('\u0001'), function (x) { x = norm(x); if (x) segs.push(x); });
    return segs.join(' \u00b7 ');
  }
  function fieldLabelEl(box) {
    var direct = null;
    each(box.children, function (k) { if (!direct && (tag(k) === 'LABEL' || tag(k) === 'LEGEND')) direct = k; });
    return box.querySelector('[data-export-label]') || box.querySelector('.cx-label, .cx-set-label') || direct ||
      box.querySelector('legend') || box.querySelector('label') || box.querySelector('dt') || box.firstElementChild;
  }

  function tableModel(tbl, o) {
    var headRow = null;
    var thead = tbl.tHead;
    if (thead && thead.rows.length) headRow = thead.rows[thead.rows.length - 1];
    var bodyRows = [];
    each(tbl.rows, function (tr) {
      if (thead && tr.parentNode === thead) return;
      if (tr.parentNode && tag(tr.parentNode) === 'TFOOT') return;
      if (tr.closest && tr.closest('table') !== tbl) return;
      bodyRows.push(tr);
    });
    if (!headRow && bodyRows.length) {
      var allTh = true;
      each(bodyRows[0].cells, function (c) { if (tag(c) !== 'TH') allTh = false; });
      if (allTh) headRow = bodyRows.shift();
    }
    var cols = [], colsVisible = [];
    if (headRow) each(headRow.cells, function (c) {
      var span = Math.max(1, Number(attr(c, 'colspan')) || 1);
      var full = flatten(c, o), vis = flatten(c, o, true);
      for (var k = 0; k < span; k++) { cols.push(k ? full + ' ' + (k + 1) : full); colsVisible.push(vis); }
    });
    var rows = [], empty = '';
    each(bodyRows, function (tr) {
      if (skipped(tr, o)) return;
      var cells = [];
      each(tr.cells, function (c) {
        var span = Math.max(1, Number(attr(c, 'colspan')) || 1);
        cells.push(flatten(c, o));
        for (var k = 1; k < span; k++) cells.push('');
      });
      if (tr.cells.length === 1 && (Number(attr(tr.cells[0], 'colspan')) || 1) > 1 && (cols.length > 1 || /cx-empty/.test(cls(tr.cells[0])))) {
        empty = cells[0];
        return;
      }
      rows.push(cells);
    });
    var n = cols.length;
    each(rows, function (r) { n = Math.max(n, r.length); });
    while (cols.length < n) { cols.push(''); colsVisible.push(''); }
    each(rows, function (r) { while (r.length < n) r.push(''); });
    // Drop button-only columns: no visible header and nothing in any cell.
    var keep = [];
    for (var i = 0; i < n; i++) {
      var any = false;
      each(rows, function (r) { if (r[i] !== '') any = true; });
      if (any || colsVisible[i] !== '') keep.push(i);
    }
    return {
      title: norm(attr(tbl, 'aria-label') || (tbl.caption ? tbl.caption.textContent : '')),
      columns: map(keep, function (i) { return cols[i] || 'Column ' + (i + 1); }),
      rows: map(rows, function (r) { return map(keep, function (i) { return r[i]; }); }),
      empty: empty || undefined
    };
  }

  function listHasCols(list) {
    var hit = false;
    each(list.children, function (li) { if (!hit && li.querySelector && li.querySelector('[data-export-col]')) hit = true; });
    return hit;
  }
  function listTable(list, o) {
    var cols = [], rows = [];
    each(list.children, function (li) {
      if (skipped(li, o)) return;
      var row = {}, prev = -1;
      each(li.querySelectorAll('[data-export-col]'), function (cell) {
        if (inSkipped(cell, li, o)) return;
        var k = attr(cell, 'data-export-col');
        var at = cols.indexOf(k);
        if (at === -1) { at = prev + 1; cols.splice(at, 0, k); }
        prev = Math.max(prev, at);
        var v = flatten(cell, o) || (cell.childNodes.length ? '' : norm(cell.textContent));
        if (v === '') return;
        row[k] = row[k] ? row[k] + ', ' + v : v;
      });
      rows.push(row);
    });
    return { title: norm(attr(list, 'aria-label')), columns: cols, rows: map(rows, function (r) { return map(cols, function (k) { return r[k] || ''; }); }) };
  }

  /**
   * Build the export model from what `root` shows now.
   * opts: { site, section, intro, fields: 'marked'|'filled'|'none', timeZone, notes }
   */
  function collect(root, opts) {
    opts = opts || {};
    var o = { fields: opts.fields || 'filled' };
    var panels = [];
    var cur = null;
    var stack = [];   // container titles
    var sectionTitle = norm(opts.section || attr(root, 'data-export-section') || '');
    var h1 = null;
    each(root.querySelectorAll('h1'), function (x) { if (!h1 && !inSkipped(x, root, o)) h1 = x; });
    if (!sectionTitle) sectionTitle = h1 ? flatten(h1, o) : norm(document.title);
    var subs = [];
    each(root.querySelectorAll('[data-export-subtitle], [role="tab"][aria-selected="true"]'), function (x) {
      if (x.hidden || x.closest && x.closest('[hidden],[data-export-skip]')) return;
      var t = norm(x.textContent);
      if (t && subs.indexOf(t) === -1) subs.push(t);
    });
    // Active filters (search boxes, filter selects in a role="search" bar), so a
    // filtered export says it is filtered.
    var filters = [];
    each(root.querySelectorAll('[role="search"]'), function (bar) {
      if (hiddenUp(bar, root)) return;
      each(bar.querySelectorAll('input, select'), function (c) {
        if (c.hidden || c.disabled || c.type === 'password' || c.type === 'hidden') return;
        var v = '';
        if (tag(c) === 'SELECT') { if (c.selectedIndex > 0) v = norm(c.options[c.selectedIndex].textContent); }
        else if (c.type === 'checkbox' || c.type === 'radio') { if (c.checked) v = 'Yes'; }
        else v = norm(c.value);
        if (v) filters.push((controlLabel(c, o) || 'Filter') + ': ' + v);
      });
    });
    var introEl = root.querySelector('[data-export-intro]');
    var intro = opts.intro !== undefined ? str(opts.intro) : (introEl ? flatten(introEl, o) : '');

    function start(title) { cur = { title: title || '', fields: [], tables: [], text: [], body: 0, form: false }; panels.push(cur); return cur; }
    var HEAD_SEL = '.cx-panel-head, header, .cx-page-head';
    function ensure() { if (!cur) start(stack.length ? stack[stack.length - 1].title : ''); return cur; }
    function isEmpty(p) { return !p.fields.length && !p.tables.length && !p.text.length; }
    var lineEl = null;
    function line(s) {
      s = norm(s);
      if (!s) return;
      var p = ensure();
      p.text.push(s);
      if (!(lineEl && lineEl.closest && lineEl.closest(HEAD_SEL))) p.body += 1;
    }
    var tableTitles = {};
    function addTable(t) {
      var p = ensure();
      var base = t.title || p.title || sectionTitle || 'Table';
      var title = base, k = 1;
      while (hasOwn.call(tableTitles, title)) { k += 1; title = base + ' (' + k + ')'; }
      tableTitles[title] = 1;
      t.title = title;
      p.tables.push(t);
    }
    function heading(el) {
      var t = flatten(el, o);
      if (!t) return;
      if (el === h1 && t === sectionTitle) return;
      var top = stack.length ? stack[stack.length - 1] : null;
      if (top && !top.title && cur && cur === top.panel && isEmpty(cur) && !cur.title) {
        top.title = t;
        cur.title = t;
        return;
      }
      start(top && top.title && top.title !== t ? top.title + ' \u2014 ' + t : t);
    }
    function field(label, value) { ensure().fields.push([norm(label), norm(value)]); }

    function walk(el) {
      if (skipped(el, o)) {
        if (o.fields === 'marked' && (tag(el) === 'FORM' || FORM_CLASS.test(cls(el))) && cur) cur.form = true;
        return;
      }
      lineEl = el;
      var t = tag(el);
      if (/^H[1-6]$/.test(t)) { heading(el); return; }
      if (el.hasAttribute('data-export-intro')) return;
      if (t === 'TABLE') { addTable(tableModel(el, o)); return; }
      if (t === 'DL') {
        var label = null, vals = [];
        var flushKV = function () { if (label !== null) field(label, vals.join(' \u00b7 ')); label = null; vals = []; };
        each(el.querySelectorAll('dt, dd'), function (x) {
          if (x.closest('dl') !== el || inSkipped(x, el, o)) return;
          if (tag(x) === 'DT') { flushKV(); label = flatten(x, o); }
          else { if (label === null) label = ''; var v = flatten(x, o); if (v) vals.push(v); }
        });
        flushKV();
        return;
      }
      if (el.hasAttribute('data-export-field')) {
        var le = fieldLabelEl(el);
        var lab = norm(attr(el, 'data-export-field')) || (le ? textOfLabel(le, o) : '');
        field(lab, fieldValue(el, attr(el, 'data-export-field') ? null : le, o));
        return;
      }
      if (t === 'UL' || t === 'OL') {
        if (listHasCols(el)) { addTable(listTable(el, o)); return; }
        each(el.children, function (li) {
          if (skipped(li, o)) return;
          if (li.querySelector && li.querySelector(STRUCT_SEL)) walk(li);
          else line(flatten(li, o));
        });
        return;
      }
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') {
        if (o.fields !== 'filled') return;
        if (t === 'INPUT' && el.type === 'radio') {
          if (!el.checked) return;
          var grp = el.closest('fieldset,[role="radiogroup"]');
          var gl = grp ? (grp.querySelector('legend') ? flatten(grp.querySelector('legend'), o) : norm(attr(grp, 'aria-label'))) : str(el.name);
          field(gl || 'Choice', radioLabel(el));
          return;
        }
        var v = controlValue(el);
        if (v === null || (v === '' && el.type !== 'checkbox')) return;
        field(controlLabel(el, o) || 'Value', v);
        return;
      }
      if (t === 'LABEL') {
        var ctl = el.control || el.querySelector('input,select,textarea');
        if (ctl) {
          if (el.contains(ctl)) walk(ctl);
          return;
        }
      }
      var isContainer = t === 'SECTION' || t === 'ARTICLE' || t === 'FIELDSET' || CONTAINER_CLASS.test(cls(el)) ||
        el.hasAttribute('data-export-panel') || attr(el, 'role') === 'tabpanel';
      if (isContainer) {
        var given = norm(attr(el, 'data-export-panel'));
        var entry = { title: given, panel: start(given) };
        stack.push(entry);
        each(el.childNodes, function (c) { if (c.nodeType === 3) line(c.nodeValue); else if (c.nodeType === 1) walk(c); });
        stack.pop();
        cur = null;
        return;
      }
      if (t === 'LEGEND') { heading(el); return; }
      if (!(el.querySelector && el.querySelector(STRUCT_SEL))) {
        var row = false;
        try { var cs = window.getComputedStyle(el); row = /flex$/.test(cs.display) && cs.flexDirection.indexOf('row') === 0; } catch (e) { row = false; }
        if (row) { line(flatten(el, o)); return; }
        var blockKid = false;
        each(el.children, function (k) { if (!blockKid && !skipped(k, o) && blockish(k)) blockKid = true; });
        if (!blockKid || t === 'P' || t === 'LI' || t === 'DD' || t === 'BLOCKQUOTE' || t === 'PRE') { line(flatten(el, o)); return; }
      }
      each(el.childNodes, function (c) { if (c.nodeType === 3) line(c.nodeValue); else if (c.nodeType === 1) walk(c); });
    }

    each(root.childNodes, function (c) { if (c.nodeType === 1) walk(c); else if (c.nodeType === 3) line(c.nodeValue); });

    var out = [];
    each(panels, function (p) {
      if (isEmpty(p)) return;
      // A panel that only held a form (an action, not data) plus its own description.
      if (p.form && !p.fields.length && !p.tables.length && !p.body) return;
      out.push({ title: p.title, fields: p.fields, tables: p.tables, text: p.text.join('\n') });
    });
    var model = {
      site: str(opts.site), section: subs.length ? sectionTitle + ' \u2014 ' + subs.join(' \u2014 ') : sectionTitle,
      generated_at: new Date().toISOString(), time_zone: opts.timeZone || undefined,
      intro: intro, notes: (filters.length ? ['Filtered by ' + filters.join('; ') + '.'] : []).concat(map(opts.notes || [], str)), panels: out
    };
    return model;
  }

  /**
   * Before collecting: press every "load more" ([data-export-more]) in `root`
   * until each list is complete or the cap is reached. Resolves to notes for
   * the file (one per list that was cut short).
   * opts: { maxRows (default 5000), maxLoads (default 200), timeout (ms per load) }
   */
  function hiddenUp(el, root) {
    for (var n = el; n && n !== root.parentNode; n = n.parentNode) {
      if (n.nodeType === 1 && (n.hidden || attr(n, 'aria-hidden') === 'true' || n.hasAttribute('data-export-skip') && !/cx-export/.test(cls(n)))) return true;
    }
    return false;
  }
  function loadAll(root, opts) {
    opts = opts || {};
    var maxRows = opts.maxRows || 5000, maxLoads = opts.maxLoads || 200, timeout = opts.timeout || 20000;
    var notes = [], done = [], loads = 0;
    function live() {
      var out = [];
      each(root.querySelectorAll('[data-export-more]'), function (b) {
        if (done.indexOf(b) !== -1 || b.disabled || hiddenUp(b, root)) return;
        out.push(b);
      });
      return out;
    }
    function countOf(b) {
      if (typeof b._cxExportCount === 'function') return b._cxExportCount();
      return root.querySelectorAll('tbody tr, li').length;
    }
    function footText(b) {
      var p = b.parentNode;
      if (!p) return '';
      var clone = p.cloneNode(true);
      each(clone.querySelectorAll('button,[data-export-more]'), function (x) { if (x.parentNode) x.parentNode.removeChild(x); });
      return norm(clone.textContent);
    }
    function once(b) {
      if (typeof b._cxExportLoad === 'function') return Promise.resolve(b._cxExportLoad());
      return new Promise(function (resolve, reject) {
        var changed = false, t0 = Date.now();
        var mo = null;
        try { mo = new window.MutationObserver(function () { changed = true; }); mo.observe(root, { childList: true, subtree: true }); } catch (e) { changed = true; }
        b.click();
        (function poll() {
          var busy = b.disabled || attr(b, 'aria-busy') === 'true';
          if (!b.isConnected || b.hidden || (changed && !busy)) { if (mo) mo.disconnect(); resolve(); return; }
          if (Date.now() - t0 > timeout) { if (mo) mo.disconnect(); reject(new Error('timeout')); return; }
          setTimeout(poll, 60);
        })();
      });
    }
    function step() {
      var list = live();
      if (!list.length) return Promise.resolve(notes);
      var b = list[0];
      var n = countOf(b);
      if (n >= maxRows || loads >= maxLoads) {
        done.push(b);
        var ft = footText(b);
        notes.push('Capped: only the first ' + n + ' rows were loaded and exported (the export stops at ' + maxRows + ' rows).' + (ft ? ' The page said: ' + ft + '.' : ''));
        return step();
      }
      loads++;
      return once(b).then(step, function () {
        done.push(b);
        notes.push('Incomplete: loading more rows failed after ' + n + ' rows; the rest were not exported.');
        return step();
      });
    }
    return step();
  }

  /* =============================================================== menu == */

  var menuSeq = 0;
  function el(tagName, props, kids) {
    var e = document.createElement(tagName);
    for (var k in props) if (hasOwn.call(props, k) && props[k] !== null && props[k] !== undefined && props[k] !== false) {
      if (k === 'text') e.textContent = props[k];
      else if (k === 'class') e.className = props[k];
      else e.setAttribute(k, props[k] === true ? '' : String(props[k]));
    }
    each(kids || [], function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function hasKitCSS() {
    try { return !!norm(window.getComputedStyle(document.documentElement).getPropertyValue('--cx-primary')); } catch (e) { return false; }
  }
  /** Inline look for pages that do not load console.css (CSSOM, so CSP-safe). */
  function fallbackStyle(wrap, button, menu, items) {
    var narrow = false;
    try { narrow = window.matchMedia && window.matchMedia('(max-width: 900px)').matches; } catch (e) { narrow = false; }
    wrap.style.position = 'relative'; wrap.style.display = 'inline-flex';
    var bs = button.style;
    bs.display = 'inline-flex'; bs.alignItems = 'center'; bs.gap = '6px'; bs.font = 'inherit'; bs.fontWeight = '700'; bs.fontSize = '13px';
    bs.padding = '8px 14px'; bs.minHeight = narrow ? '44px' : '36px'; bs.borderRadius = '9px'; bs.border = '1px solid #d0d5dd';
    bs.background = 'Canvas'; bs.color = 'CanvasText'; bs.cursor = 'pointer';
    var ms = menu.style;
    ms.position = 'absolute'; ms.top = 'calc(100% + 6px)'; ms.right = '0'; ms.zIndex = '1000'; ms.minWidth = '220px'; ms.maxWidth = 'calc(100vw - 24px)';
    ms.background = 'Canvas'; ms.color = 'CanvasText'; ms.border = '1px solid rgba(128,128,128,.45)'; ms.borderRadius = '10px';
    ms.boxShadow = '0 16px 40px rgba(0,0,0,.25)'; ms.padding = '6px'; ms.flexDirection = 'column'; ms.gap = '2px';
    each(items, function (it) {
      var s = it.style;
      s.display = 'flex'; s.justifyContent = 'space-between'; s.alignItems = 'center'; s.gap = '16px'; s.width = '100%';
      s.minHeight = '44px'; s.padding = '8px 10px'; s.border = '0'; s.borderRadius = '8px'; s.background = 'none'; s.color = 'inherit';
      s.font = 'inherit'; s.fontWeight = '600'; s.fontSize = '14px'; s.textAlign = 'left'; s.cursor = 'pointer';
      it.addEventListener('focus', function () { s.background = 'Highlight'; s.color = 'HighlightText'; });
      it.addEventListener('blur', function () { s.background = 'none'; s.color = 'inherit'; });
    });
  }

  /**
   * The Export menu button.
   * opts: { collect: () => Promise<model>|model, onDone(info), onError(err), label, cls, timeZone, date }
   * info = { format, filename, rows, model }
   */
  function menu(opts) {
    opts = opts || {};
    menuSeq += 1;
    var id = 'cx-export-' + menuSeq;
    var button = el('button', { type: 'button', class: 'cx-btn secondary cx-export-btn' + (opts.cls ? ' ' + opts.cls : ''), id: id + '-btn',
      'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': id + '-menu' },
      [document.createTextNode(opts.label || 'Export'), el('span', { class: 'cx-export-caret', 'aria-hidden': 'true', text: '\u25be' })]);
    var items = map(FORMATS, function (f) {
      return el('button', { type: 'button', role: 'menuitem', tabindex: '-1', class: 'cx-export-item', 'data-format': f.key,
        'aria-label': 'Download as ' + f.label + ' (.' + f.ext + ')' },
        [el('span', { class: 'cx-export-name', text: f.label }), el('span', { class: 'cx-export-ext', text: '.' + f.ext })]);
    });
    var list = el('div', { class: 'cx-export-menu', role: 'menu', id: id + '-menu', 'aria-labelledby': id + '-btn', hidden: true }, items);
    var status = el('span', { class: 'cx-export-status', role: 'status', 'aria-live': 'polite' });
    var ss = status.style;
    ss.position = 'absolute'; ss.width = '1px'; ss.height = '1px'; ss.overflow = 'hidden'; ss.clip = 'rect(0 0 0 0)'; ss.whiteSpace = 'nowrap'; ss.margin = '-1px';
    var wrap = el('div', { class: 'cx-export', 'data-export-skip': true }, [button, list, status]);
    if (!hasKitCSS()) fallbackStyle(wrap, button, list, items);
    var isOpen = false, working = false;

    function place() {
      // Right-aligned under the button; left-aligned when that would leave the
      // screen; then nudged so it never overflows either edge.
      list.style.transform = ''; list.style.left = ''; list.style.right = '';
      var vw = document.documentElement.clientWidth || window.innerWidth;
      var r = list.getBoundingClientRect();
      if (r.left < 8) { list.style.left = '0'; list.style.right = 'auto'; r = list.getBoundingClientRect(); }
      var want = Math.max(8, Math.min(r.left, vw - 8 - r.width));
      if (Math.abs(want - r.left) > 0.5) list.style.transform = 'translateX(' + Math.round(want - r.left) + 'px)';
    }
    function open(focusIdx) {
      if (working) return;
      isOpen = true;
      list.hidden = false;
      if (!hasKitCSS()) list.style.display = 'flex';
      button.setAttribute('aria-expanded', 'true');
      place();
      focusItem(focusIdx === undefined ? 0 : focusIdx);
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('touchstart', outside, true);
    }
    function close(refocus) {
      if (!isOpen) return;
      isOpen = false;
      list.hidden = true;
      if (!hasKitCSS()) list.style.display = 'none';
      button.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('touchstart', outside, true);
      if (refocus) try { button.focus(); } catch (e) { /* ignore */ }
    }
    function outside(e) { if (!wrap.contains(e.target)) close(false); }
    function focusItem(i) {
      var n = items.length;
      var k = ((i % n) + n) % n;
      each(items, function (it, j) { it.setAttribute('tabindex', j === k ? '0' : '-1'); });
      try { items[k].focus(); } catch (e) { /* ignore */ }
    }
    function current() { for (var i = 0; i < items.length; i++) if (items[i] === document.activeElement) return i; return 0; }

    button.addEventListener('click', function () { if (isOpen) close(true); else open(0); });
    button.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); open(0); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); open(items.length - 1); }
      else if (e.key === 'Escape' && isOpen) { e.preventDefault(); close(true); }
    });
    list.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'ArrowDown') { e.preventDefault(); focusItem(current() + 1); }
      else if (k === 'ArrowUp') { e.preventDefault(); focusItem(current() - 1); }
      else if (k === 'Home' || k === 'PageUp') { e.preventDefault(); focusItem(0); }
      else if (k === 'End' || k === 'PageDown') { e.preventDefault(); focusItem(items.length - 1); }
      else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (k === 'Tab') { close(false); }
      else if (k.length === 1 && /\S/.test(k)) {
        var start = current();
        for (var i = 1; i <= items.length; i++) {
          var j = (start + i) % items.length;
          if (norm(items[j].textContent).charAt(0).toLowerCase() === k.toLowerCase()) { focusItem(j); break; }
        }
      }
    });
    wrap.addEventListener('focusout', function (e) {
      if (isOpen && e.relatedTarget && !wrap.contains(e.relatedTarget)) close(false);
    });
    each(items, function (it) {
      it.addEventListener('click', function () { run(it.getAttribute('data-format')); });
    });

    function setBusy(on) {
      working = on;
      button.disabled = on;
      if (on) button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy');
    }
    function run(fmt) {
      var f = FORMAT_BY_KEY[fmt];
      close(true);
      setBusy(true);
      status.textContent = 'Preparing the ' + f.label + ' file\u2026';
      Promise.resolve().then(function () { return opts.collect(); }).then(function (model) {
        var out = build(model, fmt, { timeZone: opts.timeZone || (model && model.time_zone), date: opts.date });
        download(out.data, out.filename, out.mime);
        setBusy(false);
        try { button.focus(); } catch (e) { /* ignore */ }
        status.textContent = 'Downloaded ' + out.filename + '.';
        var info = { format: fmt, filename: out.filename, rows: rowCount(model), model: model };
        if (opts.onDone) { try { opts.onDone(info); } catch (e) { /* ignore */ } }
      }).then(null, function (err) {
        setBusy(false);
        status.textContent = 'The export failed. Nothing was downloaded.';
        if (opts.onError) { try { opts.onError(err); } catch (e) { /* ignore */ } }
      });
    }

    wrap._exportRun = run;
    return wrap;
  }

  /* ========================================================= standalone == */

  /**
   * Add an Export menu to `container` (an admin page that is not the console).
   * Reads data-export-section, data-export-site, data-export-fields
   * (filled|marked|none), data-export-audit-url, data-export-max-rows.
   */
  function attach(container, opts) {
    opts = opts || {};
    if (!container || container._cxExport) return container && container._cxExport;
    var site = opts.site || attr(container, 'data-export-site') ||
      ((document.querySelector('meta[name="export-site"]') || {}).content) || (window.location && window.location.hostname) || '';
    var fields = opts.fields || attr(container, 'data-export-fields') || 'filled';
    var maxRows = Number(opts.maxRows || attr(container, 'data-export-max-rows')) || undefined;
    var auditUrl = opts.auditUrl || attr(container, 'data-export-audit-url');
    var w = menu({
      collect: function () {
        return loadAll(container, { maxRows: maxRows, fields: fields }).then(function (notes) {
          return collect(container, { site: site, fields: fields, notes: notes, timeZone: opts.timeZone });
        });
      },
      onDone: function (info) {
        if (!auditUrl) return;
        try {
          window.fetch(auditUrl, { method: 'POST', credentials: 'same-origin', keepalive: true,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Requested-With': 'console' },
            body: JSON.stringify({ section: info.model.section, format: info.format, rows: info.rows }) }).then(null, function () { /* never blocks */ });
        } catch (e) { /* ignore */ }
      }
    });
    var slot = container.querySelector('[data-export-menu]');
    if (slot) slot.appendChild(w);
    else {
      var bar = el('div', { class: 'cx-export-bar', 'data-export-skip': true }, [w]);
      bar.style.display = 'flex'; bar.style.justifyContent = 'flex-end'; bar.style.margin = '0 0 12px';
      container.insertBefore(bar, container.firstChild);
    }
    container._cxExport = w;
    return w;
  }
  var started = false;
  function autoStart() {
    if (started || !document) return;
    started = true;
    function go() {
      if (document.getElementById('console-root')) return;   // the console adds its own menus
      if (document.documentElement.hasAttribute('data-export-manual')) return;
      var marked = document.querySelectorAll('[data-export-section]');
      if (marked.length) each(marked, function (c) { attach(c); });
      else { var main = document.querySelector('main'); if (main) attach(main); }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
    else go();
  }

  return {
    loaded: true, version: VERSION, FORMATS: FORMATS,
    collect: collect, loadAll: loadAll, build: build, download: download, menu: menu, attach: attach,
    toTXT: toTXT, toJSON: toJSON, toCSV: toCSV, toHTML: toHTML, toDOCX: toDOCX, toPDF: toPDF,
    filename: filename, slug: slug, csvCell: csvCell, escHTML: escHTML, escXML: escXML, winAnsi: winAnsi,
    crc32: crc32, zip: zip, utf8: utf8, rowCount: rowCount, _autoStart: autoStart
  };
}));
