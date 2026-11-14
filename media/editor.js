// WebAssembly viewer webview: a virtual list of WAT lines (only the rows on screen exist in the page), one fold per
// function, links from calls and exports to their function, find in all code, and the module overview. Text from the
// module is always escaped, so nothing in a .wasm file can run here.
(function () {
  'use strict';
  const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const RH = 18; // row height in px, also in editor.css
  const MAX_PX = 15000000; // above this the scroll bar is scaled
  const scroll = $('scroll'); const spacer = $('spacer'); const linesEl = $('lines');

  let S = null; // { blocks, sigs, funcIds, overview, file }
  let starts = null; let total = 0; let dirty = true;
  let showOffsets = false; let showSrc = false;
  let pending = new Set(); let flash = -1; let selected = -1;
  let searchId = 0; let tab = 'wat';
  const funcBlock = new Map(); const idToFunc = new Map();

  // ---------- rows ----------
  function rowsOf(b) {
    if (b.lazy && b.fold) return 1;
    if (b.lines) return b.lines.length;
    return b.n || 1;
  }
  function layout() {
    if (!dirty) return;
    const n = S.blocks.length;
    starts = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) starts[i + 1] = starts[i] + rowsOf(S.blocks[i]);
    total = starts[n];
    dirty = false;
    const h = total * RH;
    spacer.style.height = Math.min(h, MAX_PX) + 'px';
  }
  const scale = () => (total * RH > MAX_PX ? (total * RH - scroll.clientHeight) / Math.max(1, MAX_PX - scroll.clientHeight) : 1);
  function topRow() { return Math.floor((scroll.scrollTop * scale()) / RH); }
  function blockAt(row) {
    let lo = 0; let hi = S.blocks.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= row) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function funcRef(i) { return S.funcIds[i] || String(i); }
  function funcDef(i) { return S.funcIds[i] || `(;${i};)`; }
  function header(b) {
    if (b.h) return b.h;
    if (b.k === 'func') return `  (func ${funcDef(b.i)}${S.sigs[b.t] || ''}`;
    return '';
  }

  // ---------- WAT highlighting ----------
  const TYPES = new Set('i32 i64 f32 f64 v128 i8 i16 funcref externref anyref eqref i31ref structref arrayref nullref nullfuncref nullexternref exnref nullexnref func extern any eq i31 struct array none noextern nofunc exn noexn'.split(' '));
  const KW = new Set('module func param result local type import export memory table global elem data start mut offset item declare rec sub final field tag then shared ref null'.split(' '));
  const FLOW = new Set('block loop if else end try catch catch_all delegate try_table br br_if br_table return call call_indirect return_call return_call_indirect call_ref return_call_ref unreachable throw throw_ref rethrow'.split(' '));
  const CALLERS = new Set(['call', 'return_call', 'ref.func', 'start']);
  const TOK = /(;;.*$)|(\(;[\s\S]*?;\))|("(?:[^"\\]|\\.)*")|(\$[^\s()";]+)|(\b(?:offset|align)=\S+)|([a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)*)|(-?(?:0x[0-9a-fA-F][0-9a-fA-F_.pP+-]*|\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|nan(?::0x[0-9a-f]+)?|inf))|(\()|(\))/g;
  function highlight(line, ctx) {
    let out = ''; let last = 0; let prev = ''; let m;
    TOK.lastIndex = 0;
    while ((m = TOK.exec(line))) {
      if (m.index > last) out += esc(line.slice(last, m.index));
      const t = m[0];
      if (m[1] || m[2]) out += `<span class="c">${esc(t)}</span>`;
      else if (m[3]) out += `<span class="s">${esc(t)}</span>`;
      else if (m[4]) {
        const f = (CALLERS.has(prev) || (prev === 'func' && ctx.ref) || ctx.elem) ? idToFunc.get(t) : undefined;
        out += f !== undefined ? `<span class="id ref" data-f="${f}" title="Go to the function">${esc(t)}</span>` : `<span class="id">${esc(t)}</span>`;
      } else if (m[5]) out += `<span class="a">${esc(t)}</span>`;
      else if (m[6]) {
        const cls = TYPES.has(t) ? 't' : KW.has(t) ? 'k' : FLOW.has(t) ? 'fl' : 'i';
        out += `<span class="${cls}">${esc(t)}</span>`;
        prev = t; last = TOK.lastIndex; continue;
      } else if (m[7]) {
        const n = Number(t);
        const linkable = /^\d+$/.test(t) && (CALLERS.has(prev) || (prev === 'func' && ctx.ref) || ctx.elem) && n < S.overview.counts.funcs + S.overview.counts.importFuncs;
        out += linkable ? `<span class="n ref" data-f="${n}" title="Go to the function">${esc(t)}</span>` : `<span class="n">${esc(t)}</span>`;
      } else out += `<span class="p">${t}</span>`;
      if (!m[8] && !m[9]) prev = m[6] ? t : prev;
      last = TOK.lastIndex;
    }
    if (last < line.length) out += esc(line.slice(last));
    return out;
  }

  // ---------- render ----------
  let raf = 0;
  function render() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }
  function draw() {
    if (!S) return;
    layout();
    const view = Math.ceil(scroll.clientHeight / RH) + 1;
    const v = scroll.scrollTop * scale();
    const first = Math.max(0, Math.min(Math.floor(v / RH), Math.max(0, total - view + 1)));
    const last = Math.min(total, first + view + 1);
    linesEl.style.transform = `translateY(${-Math.max(0, Math.min(RH * 2, v - first * RH))}px)`;
    linesEl.style.right = (scroll.offsetWidth - scroll.clientWidth) + 'px';
    const need = [];
    let html = '';
    let b = blockAt(first);
    for (let r = first; r < last; r++) {
      while (b + 1 < S.blocks.length && starts[b + 1] <= r) b++;
      const blk = S.blocks[b];
      const k = r - starts[b];
      html += rowHtml(blk, b, k, need);
    }
    linesEl.innerHTML = html;
    if (need.length) requestLines(need);
  }
  function rowHtml(blk, b, k, need) {
    const isFold = blk.lazy && k === 0;
    const cls = `row${b === flash ? ' flash' : ''}${b === selected && k === 0 ? ' sel' : ''}${blk.k === 'func' && k === 0 ? ' fhead' : ''}`;
    const tog = isFold ? `<span class="fold" data-b="${b}" title="${blk.fold ? 'Open' : 'Fold'} this ${blk.k === 'func' ? 'function' : 'segment'}">${blk.fold ? '&#9656;' : '&#9662;'}</span>` : '<span class="fold"></span>';
    let off = '';
    let src = '';
    let text;
    let note = '';
    const ctx = { ref: blk.k === 'export' || blk.k === 'start', elem: blk.k === 'elem' && k > 0 };
    if (blk.lazy && blk.fold) {
      text = header(blk);
      note = ` <span class="c">;; ${fmtBytes(blk.sz)}${blk.k === 'func' ? '' : ', folded'}</span>`;
    } else if (blk.lines) {
      text = blk.lines[k] || '';
      if (blk.offs && blk.offs[k] >= 0) off = blk.offs[k].toString(16).padStart(7, '0');
      if (blk.src && blk.src[k]) src = blk.src[k];
    } else {
      need.push(b);
      text = k === 0 && blk.lazy ? header(blk) : '';
      if (k === 0) note = ' <span class="c">;; loading...</span>';
    }
    if (blk.k === 'func' && k === 0) {
      const extra = [];
      if (blk.ex) extra.push(`export "${blk.ex}"${blk.exn > 1 ? ` and ${blk.exn - 1} more` : ''}`);
      if (blk.nm) extra.push(blk.nm);
      if (extra.length) note += ` <span class="c xn">;; ${esc(extra.join(', '))}</span>`;
    }
    const line = highlight(text, ctx);
    const close = blk.lazy && blk.fold ? '<span class="p">)</span>' : '';
    return `<div class="${cls}" data-b="${b}" data-k="${k}">${showOffsets ? `<span class="off">${off}</span>` : ''}${tog}<span class="code">${line}${close}${note}</span>${showSrc && src ? `<span class="src" title="Source location">${esc(src)}</span>` : ''}</div>`;
  }
  function fmtBytes(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} bytes`; }
  function requestLines(bs) {
    const want = [...new Set(bs)].filter((b) => !pending.has(b));
    if (!want.length) return;
    want.forEach((b) => pending.add(b));
    vscode.postMessage({ type: 'getLines', bs: want });
  }

  // ---------- folding, reveal ----------
  function setFold(b, fold) {
    const blk = S.blocks[b];
    if (!blk || !blk.lazy || !!blk.fold === fold) return;
    blk.fold = fold ? 1 : 0;
    dirty = true;
    if (!fold && !blk.lines) requestLines([b]);
  }
  function scrollToRow(row, center) {
    layout();
    const view = Math.floor(scroll.clientHeight / RH);
    const r = Math.max(0, center ? row - Math.floor(view / 3) : row);
    scroll.scrollTop = (r * RH) / scale();
    render();
  }
  function revealBlock(b, line = 0, open = true) {
    if (b === undefined || !S.blocks[b]) return;
    if (tab !== 'wat') showTab('wat');
    if (open) setFold(b, false);
    layout();
    flash = b; selected = b;
    scrollToRow(starts[b] + line, true);
    setTimeout(() => { if (flash === b) { flash = -1; render(); } }, 1600);
  }
  function revealFunc(f) {
    const b = funcBlock.get(f);
    if (b !== undefined) { revealBlock(b); return true; }
    // an imported function: its import line
    for (let i = 0; i < S.blocks.length; i++) if (S.blocks[i].k === 'import') { revealBlock(i, 0, false); return true; }
    return false;
  }

  // ---------- overview ----------
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  function table(head, rows) { return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`; }
  function renderOverview() {
    const o = S.overview;
    const c = o.counts;
    let h = '<div class="cards">';
    const card = (label, v, sub) => `<div class="card"><div class="v">${esc(v)}</div><div class="l">${esc(label)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
    h += card('file size', fmtBytes(o.size), `version ${o.version}`);
    h += card('functions', c.funcs.toLocaleString(), `code ${fmtBytes(c.codeSize)}`);
    h += card('imports', c.imports.toLocaleString(), `${c.importFuncs} functions`);
    h += card('exports', c.exports.toLocaleString());
    h += card('memories', c.memories, o.memories.map((x) => `${fmtBytes(x.min * 65536)}${x.shared ? ' shared' : ''}`).join(', '));
    h += card('data', fmtBytes(c.dataSize), `${c.datas} segments`);
    h += card('names', o.names.source, o.names.present ? `${o.names.funcs} functions, ${o.names.locals} locals` : 'no name section');
    h += '</div>';
    if (o.errors.length) h += `<h3>Problems</h3><ul class="errs">${o.errors.map((e) => `<li class="${e.soft ? 'warn' : 'error'}"><span class="mono">0x${e.offset.toString(16)}</span> ${esc(e.message)}</li>`).join('')}</ul>`;
    h += '<div id="valres"></div>';
    if (o.features.length) h += `<p class="muted">Features: ${o.features.map(esc).join(', ')}</p>`;
    if (o.producers) h += `<p class="muted">Built with: ${Object.entries(o.producers).map(([k, v]) => `${esc(k)} ${v.map((x) => esc(`${x.name} ${x.version}`.trim())).join(', ')}`).join('; ')}</p>`;
    // sections
    const maxS = Math.max(1, ...o.sections.map((s) => s.size));
    h += '<h3>Sections</h3>' + table(['Section', 'Offset', 'Size', 'Share', ''], o.sections.map((s) => `<tr><td>${esc(s.name)}</td><td class="mono">0x${s.offset.toString(16)}</td><td class="num">${fmtBytes(s.size)}</td><td class="num">${pct(s.size / o.size)}</td><td class="barc"><span class="bar" data-w="${Math.max(1, Math.round((s.size / maxS) * 100))}"></span></td></tr>`));
    // exports
    h += `<h3>Exports <span class="muted">${c.exports}</span></h3>`;
    if (c.exports > 20) h += '<input class="filter" data-which="exports" placeholder="Filter exports" type="search">';
    h += `<div id="list-exports">${exportsTable(o.exports, o.exportsTotal)}</div>`;
    h += `<h3>Imports <span class="muted">${c.imports}</span></h3>`;
    if (c.imports > 20) h += '<input class="filter" data-which="imports" placeholder="Filter imports" type="search">';
    h += `<div id="list-imports">${importsTable(o.imports, o.importsTotal)}</div>`;
    if (o.memories.length) h += '<h3>Memories</h3>' + table(['#', 'Pages (min max)', 'Size', 'Kind', 'Import', 'Export'], o.memories.map((x) => `<tr><td>${x.index}</td><td class="mono">${esc(x.limits)}</td><td class="num">${fmtBytes(x.min * 65536)}${x.max !== null ? ` to ${fmtBytes(x.max * 65536)}` : ''}</td><td>${x.shared ? 'shared' : ''}${x.is64 ? ' 64-bit' : ''}</td><td class="mono">${esc(x.imported)}</td><td class="mono">${esc(x.exports.join(', '))}</td></tr>`));
    if (o.tables.length) h += '<h3>Tables</h3>' + table(['#', 'Limits', 'Type', 'Import', 'Export'], o.tables.map((x) => `<tr><td>${x.index}</td><td class="mono">${esc(x.limits)}</td><td class="mono">${esc(x.type)}</td><td class="mono">${esc(x.imported)}</td><td class="mono">${esc(x.exports.join(', '))}</td></tr>`));
    if (o.globals.length) h += `<h3>Globals <span class="muted">${o.globals.length}</span></h3>` + table(['#', 'Name', 'Type', 'Value', 'Import', 'Export'], o.globals.slice(0, 2000).map((x) => `<tr><td>${x.index}</td><td class="mono">${esc(x.name)}</td><td class="mono">${x.mutable ? 'mut ' : ''}${esc(x.type)}</td><td class="mono">${esc(x.init)}</td><td class="mono">${esc(x.imported)}</td><td class="mono">${esc(x.exports.join(', '))}</td></tr>`));
    if (o.start) h += `<h3>Start function</h3><p><a href="#" class="go mono" data-f="${o.start.index}">${esc(o.start.name)}</a></p>`;
    h += `<h3>Custom sections <span class="muted">${o.customs.length}</span></h3>`;
    h += o.customs.length ? table(['Name', 'Offset', 'Size', 'What it is'], o.customs.map((x) => `<tr><td class="mono">${esc(x.name)}</td><td class="mono">0x${x.offset.toString(16)}</td><td class="num">${fmtBytes(x.size)}</td><td>${esc(customNote(x.name, o))}</td></tr>`)) : '<p class="muted">None.</p>';
    const n = o.names;
    h += '<h3>Name section</h3>';
    h += n.present ? table(['Kind', 'Names'], [['module', n.module || ''], ['functions', n.funcs], ['locals', n.locals], ['globals', n.globals], ['types', n.types], ['tables', n.tables], ['memories', n.memories], ['data segments', n.datas], ['labels', n.labels]].filter(([, v]) => v !== '' && v !== 0).map(([k, v]) => `<tr><td>${k}</td><td class="mono">${esc(v)}</td></tr>`))
      : `<p class="muted">This module has no name section. Functions are shown by ${n.source === 'export names' ? 'index, and exported ones by their export name' : 'index'}.</p>`;
    if (o.sourceMappingURL || o.dwarf) h += `<p class="muted">Debug info: ${o.dwarf ? 'DWARF (.debug_line)' : ''}${o.dwarf && o.sourceMappingURL ? ', ' : ''}${o.sourceMappingURL ? `source map ${esc(o.sourceMappingURL)}` : ''}. <a href="#" data-cmd="sourceMap">Source mapping (Zovo Pro)</a></p>`;
    $('overview').innerHTML = h;
    sizeBars($('overview'));
  }
  // the CSP allows no inline style attributes: bar widths are set through the DOM
  function sizeBars(root) { root.querySelectorAll('.bar[data-w]').forEach((b) => { b.style.width = `${b.dataset.w}%`; }); }
  function customNote(name, o) {
    const known = { name: 'function, local and other names', producers: 'the tools that built the module', target_features: 'features the compiler used', sourceMappingURL: `source map: ${o.sourceMappingURL}`, external_debug_info: 'path of a separate debug file', 'dylink.0': 'dynamic linking (Emscripten side module)', dylink: 'dynamic linking (old format)', linking: 'object file linking data', 'metadata.code.branch_hint': 'branch hints' };
    if (known[name]) return known[name];
    if (/^\.debug_/.test(name)) return 'DWARF debug info';
    if (/^reloc\./.test(name)) return 'relocations (object file)';
    if (/^component-type/.test(name)) return 'component model type info';
    return '';
  }
  function exportsTable(rows, totalRows) {
    const shown = rows.slice(0, 2000);
    let h = table(['Name', 'Kind', 'Index', 'Function'], shown.map((e) => `<tr><td class="mono">${e.kind === 'func' ? `<a href="#" class="go" data-f="${e.index}" title="Go to the function">${esc(e.name)}</a>` : esc(e.name)}</td><td>${e.kind}</td><td class="num">${e.index}</td><td class="mono">${esc(e.target)}</td></tr>`));
    if (totalRows > shown.length) h += `<p class="muted">${(totalRows - shown.length).toLocaleString()} more. Type in the filter to find one.</p>`;
    return h;
  }
  function importsTable(rows, totalRows) {
    const shown = rows.slice(0, 2000);
    let h = table(['Module', 'Name', 'Kind', 'Type'], shown.map((x) => `<tr><td class="mono">${esc(x.module)}</td><td class="mono">${esc(x.field)}</td><td>${x.kind}</td><td class="mono">${esc(x.desc)}</td></tr>`));
    if (totalRows > shown.length) h += `<p class="muted">${(totalRows - shown.length).toLocaleString()} more. Type in the filter to find one.</p>`;
    return h;
  }

  function showTab(t) {
    tab = t;
    document.querySelectorAll('.tab').forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    $('wat').hidden = t !== 'wat';
    $('overview').hidden = t !== 'overview';
    if (t === 'wat') render();
  }

  function info() {
    const o = S.overview;
    const folded = S.blocks.filter((b) => b.lazy && b.fold && b.k === 'func').length;
    $('info').textContent = `${o.file} · ${fmtBytes(o.size)} · ${o.counts.funcs.toLocaleString()} functions${folded ? ` (${folded.toLocaleString()} folded)` : ''} · names: ${o.names.source}${S.src ? ` · source lines: ${S.srcKind === 'dwarf' ? 'DWARF' : 'source map'}` : ''}`;
  }

  // ---------- search ----------
  function runSearch(q) {
    searchId++;
    $('results').hidden = false;
    $('results-title').textContent = `Searching for "${q}"...`;
    $('results-list').innerHTML = '';
    vscode.postMessage({ type: 'search', id: searchId, q });
  }
  function showResults(m) {
    const title = m.error ? `Search error: ${m.error}` : `${m.hits.length.toLocaleString()}${m.more ? '+' : ''} lines with "${m.q}"`;
    $('results-title').textContent = title;
    $('results-list').innerHTML = m.hits.map((h, i) => {
      const blk = S.blocks[h.b];
      const where = blk && blk.k === 'func' ? (blk.nm || blk.ex || funcRef(blk.i)) : blk ? blk.k : '';
      return `<div class="hit" data-i="${i}"><span class="where">${esc(where)}</span> <span class="mono">${esc(h.text)}</span></div>`;
    }).join('') || '<p class="muted">No match.</p>';
    lastHits = m.hits;
  }
  let lastHits = [];

  // ---------- events ----------
  scroll.addEventListener('scroll', render);
  window.addEventListener('resize', render);
  linesEl.addEventListener('click', (e) => {
    const r = e.target.closest('.ref');
    if (r) { revealFunc(Number(r.dataset.f)); return; }
    const f = e.target.closest('.fold[data-b]');
    if (f) { const b = Number(f.dataset.b); setFold(b, !S.blocks[b].fold); render(); info(); return; }
    const row = e.target.closest('.row');
    if (row && e.detail === 2) { const b = Number(row.dataset.b); if (S.blocks[b].lazy && Number(row.dataset.k) === 0) { setFold(b, !S.blocks[b].fold); render(); info(); } }
  });
  linesEl.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) { scroll.scrollTop += e.deltaMode === 1 ? e.deltaY * RH : e.deltaY; e.preventDefault(); }
  }, { passive: false });
  linesEl.addEventListener('keydown', (e) => {
    const page = Math.floor(scroll.clientHeight / RH) - 1;
    const by = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[e.key];
    if (by) { scroll.scrollTop += (by * RH) / scale(); e.preventDefault(); }
    if (e.key === 'Home') { scroll.scrollTop = 0; e.preventDefault(); }
    if (e.key === 'End') { scroll.scrollTop = scroll.scrollHeight; e.preventDefault(); }
  });
  document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) showTab(b.dataset.tab); });
  $('toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (!b) return;
    const c = b.dataset.cmd;
    if (c === 'foldAll' || c === 'unfoldAll') {
      const fold = c === 'foldAll';
      const lazy = S.blocks.filter((x) => x.lazy);
      if (!fold && lazy.length > 20000) { $('err').hidden = false; $('err').textContent = `This module has ${lazy.length.toLocaleString()} functions and segments. Open them one at a time, or use Open as Text or Save as WAT for the whole text.`; return; }
      lazy.forEach((x) => { x.fold = fold ? 1 : 0; });
      dirty = true;
      render(); info();
      return;
    }
    if (c === 'validate') { vscode.postMessage({ type: 'validate' }); return; }
    vscode.postMessage({ type: 'command', id: c });
  });
  $('offsets').addEventListener('change', (e) => { showOffsets = e.target.checked; document.body.classList.toggle('offsets', showOffsets); vscode.postMessage({ type: 'offsets', on: showOffsets }); render(); });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const q = e.target.value; if (q.trim()) runSearch(q); }
    if (e.key === 'Escape') { e.target.value = ''; vscode.postMessage({ type: 'cancelSearch' }); $('results').hidden = true; linesEl.focus(); }
  });
  $('results-close').addEventListener('click', () => { vscode.postMessage({ type: 'cancelSearch' }); $('results').hidden = true; });
  $('results-list').addEventListener('click', (e) => {
    const h = e.target.closest('.hit');
    if (!h) return;
    const hit = lastHits[Number(h.dataset.i)];
    document.querySelectorAll('.hit.on').forEach((x) => x.classList.remove('on'));
    h.classList.add('on');
    revealBlock(hit.b, hit.l, true);
  });
  $('overview').addEventListener('click', (e) => {
    const a = e.target.closest('a.go');
    if (a) { e.preventDefault(); revealFunc(Number(a.dataset.f)); return; }
    const c = e.target.closest('a[data-cmd]');
    if (c) { e.preventDefault(); vscode.postMessage({ type: 'command', id: c.dataset.cmd }); }
  });
  let filterTimer = 0;
  $('overview').addEventListener('input', (e) => {
    const f = e.target.closest('.filter');
    if (!f) return;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => vscode.postMessage({ type: 'filter', which: f.dataset.which, q: f.value }), 200);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') {
      S = { blocks: m.blocks, sigs: m.sigs, funcIds: m.funcIds, overview: m.overview, file: m.file, src: m.src, srcKind: m.srcKind };
      funcBlock.clear(); idToFunc.clear();
      S.blocks.forEach((b, i) => { if (b.k === 'func') funcBlock.set(b.i, i); });
      for (const [i, id] of Object.entries(S.funcIds)) idToFunc.set(id, Number(i));
      pending = new Set(); dirty = true;
      showOffsets = !!m.offsets; $('offsets').checked = showOffsets; document.body.classList.toggle('offsets', showOffsets);
      showSrc = !!m.src;
      $('failed').hidden = true; $('toolbar').hidden = false;
      renderOverview(); info(); showTab(tab);
      vscode.postMessage({ type: 'rendered', failed: false });
    } else if (m.type === 'failed') {
      $('failed').hidden = false; $('failmsg').textContent = m.message;
      $('wat').hidden = true; $('overview').hidden = true;
      document.querySelectorAll('#toolbar [data-cmd], #search, .chk').forEach((x) => { x.disabled = true; });
      vscode.postMessage({ type: 'rendered', failed: true });
    } else if (m.type === 'lines' && S) {
      for (const it of m.items) {
        const blk = S.blocks[it.b];
        pending.delete(it.b);
        if (!blk) continue;
        if (blk.n !== it.lines.length) dirty = true;
        blk.lines = it.lines; blk.offs = it.offs; blk.src = it.src; blk.n = it.lines.length;
      }
      render();
    } else if (m.type === 'reveal' && S) { revealFunc(m.func); }
    else if (m.type === 'focusSearch') { $('search').focus(); $('search').select(); }
    else if (m.type === 'searchProgress' && m.id === searchId) { $('results-title').textContent = `Searching... ${Math.round((m.done / Math.max(1, m.total)) * 100)}%, ${m.hits} lines so far`; }
    else if (m.type === 'searchDone' && m.id === searchId) showResults(m);
    else if (m.type === 'filtered' && S) {
      const el = $(`list-${m.which}`);
      if (el) el.innerHTML = m.which === 'exports' ? exportsTable(m.rows, m.total) : importsTable(m.rows, m.total);
    } else if (m.type === 'validating') { const v = $('valres'); if (v) v.innerHTML = '<p class="muted">Validating with wabt...</p>'; if (tab !== 'overview') showTab('overview'); }
    else if (m.type === 'validated') {
      const v = $('valres');
      if (!v) return;
      if (m.ok) v.innerHTML = `<p class="ok">Valid: wabt found no problem (${(m.ms / 1000).toFixed(1)} s).</p>`;
      else {
        const items = (m.errors || []).map((x) => `<li class="error">${x.offset !== undefined ? `<span class="mono">0x${x.offset.toString(16)}</span> ` : ''}${esc(x.message)}</li>`)
          .concat((m.bodyErrors || []).map((x) => `<li class="error"><a href="#" class="go mono" data-f="${x.func}">${esc(x.name)}</a> <span class="mono">0x${(x.offset || 0).toString(16)}</span> ${esc(x.message)}</li>`));
        v.innerHTML = `<h3>Validation</h3><ul class="errs">${items.join('') || '<li class="error">The module is not valid.</li>'}</ul>`;
      }
      if (tab !== 'overview') showTab('overview');
    } else if (m.type === 'srcChanged' && S) {
      S.src = m.src; S.srcKind = m.srcKind; showSrc = !!m.src;
      S.blocks.forEach((b) => { if (b.lazy) { b.lines = null; b.offs = null; b.src = null; } });
      pending = new Set(); dirty = true; render(); info();
    } else if (m.type === 'error') { $('err').hidden = false; $('err').textContent = m.message; setTimeout(() => { $('err').hidden = true; }, 8000); }
  });

  // footer (support links), moved out of the template so it is not inside the scroller
  const tpl = $('zovo-footer');
  if (tpl && tpl.innerHTML.trim()) $('footer').appendChild(tpl.content.cloneNode(true));
  vscode.postMessage({ type: 'ready' });
})();
