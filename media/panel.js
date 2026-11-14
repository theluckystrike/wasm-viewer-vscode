// Result panel of the Pro tools (size profiler, compare two builds, source mapping). Data arrives by postMessage and
// is drawn as escaped text, so nothing from a module can run here.
(function () {
  'use strict';
  const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : acquireVsCodeApi();
  const app = document.getElementById('app');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : '0');
  let data = null;
  let view = { sort: 'size', show: { added: true, removed: true, grown: true, shrunk: true }, filter: '' };
  const post = (id, extra) => vscode.postMessage({ type: 'action', id, ...(extra || {}) });

  function actions(list) {
    document.getElementById('actions').innerHTML = list.map(([id, label]) => `<button class="tb" data-a="${id}">${esc(label)}</button>`).join('');
  }
  document.getElementById('actions').addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) post(b.dataset.a); });
  const table = (head, rows, cls) => `<table class="${cls || ''}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  const card = (label, v, sub) => `<div class="card"><div class="v">${esc(v)}</div><div class="l">${esc(label)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
  const fn = (i, name) => `<a href="#" data-open="${i}" class="mono" title="Show in the viewer">${esc(name)}</a>`;
  const bar = (x) => `<span class="bar" data-w="${Math.max(1, Math.round(x * 100))}"></span>`;
  // the CSP allows no inline style attributes: bar widths are set through the DOM
  const sizeBars = () => app.querySelectorAll('.bar[data-w]').forEach((b) => { b.style.width = `${b.dataset.w}%`; });

  // ---------- size profiler ----------
  function renderProfile(d) {
    document.getElementById('title').textContent = d.title;
    actions([['copyMd', 'Copy as Markdown'], ['saveMd', 'Save as Markdown']]);
    const f = d.file;
    let h = '<div class="cards">';
    h += card('file', fmt(f.size)) + card('code', fmt(f.codeSize), pct(f.codeSize / f.size)) + card('data', fmt(f.dataSize), pct(f.dataSize / f.size));
    h += card('functions', f.funcs.toLocaleString(), f.named ? 'names from the name section' : 'no name section') + card('roots', f.roots.toLocaleString(), 'exports, start, tables');
    if (d.unreachable.count) h += card('never called', d.unreachable.count.toLocaleString(), fmt(d.unreachable.bytes));
    h += '</div>';
    h += '<div id="keep" class="keep" hidden></div>';
    const list = view.sort === 'size' ? d.functions : d.retainedTop;
    h += `<h3>Functions <span class="seg"><button class="tb ${view.sort === 'size' ? 'on' : ''}" data-sort="size">Biggest</button><button class="tb ${view.sort === 'retained' ? 'on' : ''}" data-sort="retained" title="The bytes that would go away with this function: its own size plus every function only it keeps alive">Keeps alive the most</button></span></h3>`;
    const max = Math.max(1, ...list.map((x) => (view.sort === 'size' ? x.size : x.retained)));
    h += table(['Function', 'Size', 'Retained', 'Share of code', 'Calls', 'Called by', '', ''], list.slice(0, 200).map((x) => `<tr><td>${fn(x.index, x.name)}</td><td class="num">${fmt(x.size)}</td><td class="num">${fmt(x.retained)}</td><td class="num">${pct(x.pct)}</td><td class="num">${x.calls}${x.indirect ? ` +${x.indirect} indirect` : ''}</td><td class="num">${x.callers}</td><td class="barc">${bar((view.sort === 'size' ? x.size : x.retained) / max)}</td><td><a href="#" data-keep="${x.index}" title="Show the call chain that keeps this function in the build">why kept?</a></td></tr>`));
    const smax = Math.max(1, ...d.sections.map((s) => s.size));
    h += '<h3>Size by section</h3>' + table(['Section', 'Size', 'Share', ''], d.sections.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${fmt(s.size)}</td><td class="num">${pct(s.pct)}</td><td class="barc">${bar(s.size / smax)}</td></tr>`));
    if (d.groups.length > 1 || (d.groups[0] && d.groups[0].group !== '(no name)')) {
      const gmax = Math.max(1, ...d.groups.map((g) => g.size));
      h += '<h3>Size by crate, namespace or package</h3>' + table(['Group', 'Functions', 'Size', 'Share of code', ''], d.groups.slice(0, 100).map((g) => `<tr><td class="mono">${esc(g.group)}</td><td class="num">${g.funcs}</td><td class="num">${fmt(g.size)}</td><td class="num">${pct(g.pct)}</td><td class="barc">${bar(g.size / gmax)}</td></tr>`));
    } else h += '<p class="muted">No function names, so there is no size by crate or namespace. Build with a name section (wasm-opt --debuginfo, cargo profile debug = 1, emcc --profiling-funcs) to see it.</p>';
    if (d.datas.length) h += `<h3>Biggest data segments <span class="muted">${d.dataCount}</span></h3>` + table(['#', 'Size', 'Mode', 'Starts with'], d.datas.slice(0, 50).map((x) => `<tr><td>${x.index}</td><td class="num">${fmt(x.size)}</td><td>${x.mode}</td><td class="mono">${esc(x.preview)}</td></tr>`));
    if (d.importModules.length) h += '<h3>Imports by module</h3>' + table(['Module', 'Functions', 'Other', 'Functions that call it', 'Some names'], d.importModules.map((m) => `<tr><td class="mono">${esc(m.module)}</td><td class="num">${m.funcs}</td><td class="num">${m.other}</td><td class="num">${m.callers}</td><td class="mono small">${esc(m.names.join(', '))}</td></tr>`));
    if (d.unreachable.count) h += `<h3>Never called <span class="muted">${d.unreachable.count} functions, ${fmt(d.unreachable.bytes)}</span></h3><p class="muted">Not reachable from an export, the start function or a table. A linker or wasm-opt can usually remove them.</p>` + table(['Function', 'Size'], d.unreachable.top.map((x) => `<tr><td>${fn(x.index, x.name)}</td><td class="num">${fmt(x.size)}</td></tr>`));
    if (d.scanErrors.length) h += `<p class="muted">${d.scanErrors.length} function bodies could not be decoded; their calls are missing from the graph.</p>`;
    app.innerHTML = h;
  }
  function renderKeep(k) {
    const el = document.getElementById('keep');
    if (!el) return;
    let h = `<h3>Why ${esc(k.name)} is in the build</h3><p>${fmt(k.size)} itself, ${fmt(k.retained)} with everything only it keeps alive.</p>`;
    if (k.root) h += `<p>It is a root: ${esc(k.root.join(', '))}.</p>`;
    if (k.chain.length > 1) h += `<p>Shortest call chain from a root (${esc((k.chainRoot || []).join(', '))}):</p><ol class="chain">${k.chain.map((c) => `<li>${fn(c.index, c.name)}</li>`).join('')}</ol>`;
    else if (!k.root) h += `<p>${k.reachable ? 'Reached only through a table or ref.func.' : 'No export, start function or table reaches it: nothing calls it.'}</p>`;
    if (k.dominator && k.dominator !== 'root') h += `<p>Every chain goes through ${fn(k.dominator.index, k.dominator.name)}: removing that function removes this one too.</p>`;
    if (k.callers.length) h += `<p>Called by ${k.callers.length}${k.callers.length >= 50 ? '+' : ''}: ${k.callers.slice(0, 20).map((c) => fn(c.index, c.name)).join(', ')}</p>`;
    h += '<p><a href="#" data-closekeep="1">Close</a></p>';
    el.innerHTML = h;
    el.hidden = false;
    el.scrollIntoView({ block: 'nearest' });
  }

  // ---------- compare ----------
  function renderCompare(d) {
    document.getElementById('title').textContent = d.title;
    actions([['copyMd', 'Copy as Markdown'], ['saveMd', 'Save as Markdown'], ['swap', 'Swap sides']]);
    const t = d.total;
    let h = `<p class="files"><span class="old">Old</span> ${esc(d.old)}<br><span class="new">New</span> ${esc(d.new)}</p>`;
    h += `<p class="big ${t.delta > 0 ? 'grew' : t.delta < 0 ? 'shrank' : ''}">${signed(t.delta)} <span class="muted">${fmt(t.old)} to ${fmt(t.new)}${t.old ? `, ${t.delta >= 0 ? '+' : ''}${((t.delta / t.old) * 100).toFixed(2)}%` : ''}</span></p>`;
    h += table(['Section', 'Old', 'New', 'Change'], d.sections.filter((s) => s.old || s.new).map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${fmt(s.old)}</td><td class="num">${fmt(s.new)}</td><td class="num ${s.delta > 0 ? 'grew' : s.delta < 0 ? 'shrank' : ''}">${signed(s.delta)}</td></tr>`));
    const c = d.counts;
    const chip = (k, label) => `<label class="chip ${k}"><input type="checkbox" data-k="${k}" ${view.show[k] ? 'checked' : ''}> ${label} <b>${c[k]}</b> <span class="muted">${signed(d.sums[k])}</span></label>`;
    h += `<h3>Functions <span class="muted">${c.same.toLocaleString()} unchanged</span></h3><div class="chips">${chip('added', 'Added')}${chip('removed', 'Removed')}${chip('grown', 'Grown')}${chip('shrunk', 'Shrunk')}</div><p class="muted">${esc(d.matchNote)}</p>`;
    const rows = d.funcs.filter((x) => view.show[x.kind]).slice(0, 500);
    h += rows.length ? table(['Function', 'Change', 'Old', 'New', 'Delta'], rows.map((x) => `<tr><td>${x.newIndex !== undefined ? `<a href="#" data-open="${x.newIndex}" data-side="new" class="mono">${esc(x.name)}</a>` : `<span class="mono">${esc(x.name)}</span>`}</td><td><span class="tag ${x.kind}">${x.kind}</span></td><td class="num">${x.old ? fmt(x.old) : ''}</td><td class="num">${x.new ? fmt(x.new) : ''}</td><td class="num ${x.delta > 0 ? 'grew' : 'shrank'}">${signed(x.delta)}</td></tr>`)) : '<p class="same">No function changed size.</p>';
    if (d.funcCount > d.funcs.length) h += `<p class="muted">${d.funcCount - d.funcs.length} smaller changes are not listed.</p>`;
    const lst = (title, xs) => (xs.length ? `<h3>${title} <span class="muted">${xs.length}</span></h3><p class="mono small">${xs.slice(0, 100).map(esc).join(', ')}${xs.length > 100 ? ' ...' : ''}</p>` : '');
    h += lst('Imports added', d.imports.added) + lst('Imports removed', d.imports.removed) + lst('Exports added', d.exports.added) + lst('Exports removed', d.exports.removed);
    h += `<h3>Markdown for a pull request</h3><pre class="md">${esc(d.markdown)}</pre>`;
    app.innerHTML = h;
  }

  // ---------- source mapping ----------
  function renderSources(d) {
    document.getElementById('title').textContent = d.title;
    actions([['saveMd', 'Save as Markdown']]);
    let h = `<p class="muted">From ${esc(d.from)}: ${d.rows.toLocaleString()} line table rows${d.units ? `, ${d.units} compile units` : ''}${d.producer ? `, built with ${esc(d.producer.split(' (')[0])}` : ''}.</p>`;
    h += `<div class="cards">${card('functions with a source line', `${d.mapped.toLocaleString()} of ${d.total.toLocaleString()}`)}${card('source files', d.files.length.toLocaleString())}</div>`;
    h += '<p class="muted">The WAT view of this module now shows the source line next to each instruction.</p>';
    const fmax = Math.max(1, ...d.files.map((f) => f.size));
    h += '<h3>Code size by source file</h3>' + table(['Source file', 'Functions', 'Code size', ''], d.files.slice(0, 300).map((f) => `<tr><td><a href="#" data-src="${esc(f.file)}" data-line="1" class="mono">${esc(f.file)}</a></td><td class="num">${f.funcs}</td><td class="num">${fmt(f.size)}</td><td class="barc">${bar(f.size / fmax)}</td></tr>`));
    h += `<h3>Functions</h3><input id="ffilter" class="filter" type="search" placeholder="Filter by function or file" value="${esc(view.filter)}">`;
    h += '<div id="flist"></div>';
    app.innerHTML = h;
    drawFuncs();
  }
  function drawFuncs() {
    const el = document.getElementById('flist');
    if (!el || !data) return;
    const q = view.filter.toLowerCase();
    const rows = data.funcs.filter((f) => !q || f.name.toLowerCase().includes(q) || f.file.toLowerCase().includes(q));
    el.innerHTML = table(['Function', 'Source', 'Size'], rows.slice(0, 1000).map((f) => `<tr><td>${fn(f.index, f.name)}</td><td>${f.file ? `<a href="#" data-src="${esc(f.file)}" data-line="${f.line}" class="mono">${esc(f.file.split('/').slice(-2).join('/'))}:${f.line}${f.endLine > f.line ? `-${f.endLine}` : ''}</a>` : '<span class="muted">no line</span>'}</td><td class="num">${fmt(f.size)}</td></tr>`))
      + (rows.length > 1000 ? `<p class="muted">${rows.length - 1000} more. Filter to find one.</p>` : '');
  }

  function render() {
    if (!data) return;
    if (data.kind === 'profile') renderProfile(data);
    else if (data.kind === 'compare') renderCompare(data);
    else renderSources(data);
    sizeBars();
  }
  app.addEventListener('change', (e) => { const k = e.target.dataset && e.target.dataset.k; if (k) { view.show[k] = e.target.checked; render(); } });
  app.addEventListener('input', (e) => { if (e.target.id === 'ffilter') { view.filter = e.target.value; drawFuncs(); } });
  app.addEventListener('click', (e) => {
    const t = e.target.closest('a, button');
    if (!t) return;
    if (t.dataset.open !== undefined) { e.preventDefault(); post('open', { index: Number(t.dataset.open), side: t.dataset.side || 'new' }); }
    else if (t.dataset.keep !== undefined) { e.preventDefault(); post('keep', { index: Number(t.dataset.keep) }); }
    else if (t.dataset.src !== undefined) { e.preventDefault(); post('source', { file: t.dataset.src, line: Number(t.dataset.line) || 1 }); }
    else if (t.dataset.sort) { view.sort = t.dataset.sort; render(); }
    else if (t.dataset.closekeep) { e.preventDefault(); const k = document.getElementById('keep'); if (k) k.hidden = true; }
  });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'data') { data = m.data; render(); vscode.postMessage({ type: 'shown' }); }
    else if (m.type === 'keep') renderKeep(m.data);
  });
  vscode.postMessage({ type: 'ready' });
})();
