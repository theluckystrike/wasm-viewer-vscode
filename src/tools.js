'use strict';
// The three Pro tools: size profiler, compare two builds, source mapping. Each opens one result panel beside the
// viewer. A free try counts only after the panel showed the result.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { parseModule } = require('./core/wasm');
const { WasmModel } = require('./model');
const P = require('./core/profile');
const C = require('./core/compare');
const D = require('./core/dwarf');
const { panelHtml } = require('./html');

const PREFIX = 'wasmViewer';
const baseName = (uri) => path.posix.basename(uri.path);
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const tick = () => new Promise((r) => setImmediate(r));

function createTools({ context, provider, pro, reach }) {
  const panels = {};

  // ---------- helpers ----------
  function targetUri(arg) {
    if (arg && arg.scheme) return arg;
    if (provider.active) return provider.active.uri;
    return null;
  }
  async function wasmFiles(except) {
    const found = await vscode.workspace.findFiles('**/*.wasm', '**/{node_modules,.git}/**', 300).then(undefined, () => []);
    return found.filter((u) => !except || u.toString() !== except.toString());
  }
  async function pickWasm(title, except) {
    const files = await wasmFiles(except);
    const rel = (u) => (vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(u) : u.fsPath);
    const items = files.slice(0, 200).map((u) => ({ label: `$(file-binary) ${baseName(u)}`, description: rel(u), uri: u }));
    items.push({ label: '$(folder-opened) Browse...', description: 'Choose a .wasm file on disk', browse: true });
    const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: title, matchOnDescription: true });
    if (!pick) return null;
    if (pick.uri) return pick.uri;
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Choose', title, filters: { WebAssembly: ['wasm'], 'All files': ['*'] } });
    return r && r[0];
  }
  async function modelFor(uri) {
    const doc = provider.docFor(uri);
    if (doc && doc.model) return { model: doc.model, doc };
    if (doc && doc.failed) throw new Error(doc.failed);
    return { model: new WasmModel(new Uint8Array(await vscode.workspace.fs.readFile(uri)), { names: setting('useNames', true) !== false, eagerBytes: 0 }), doc: null };
  }
  function git(args, cwd) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim() || 'git failed')); else resolve(stdout);
      });
    });
  }
  async function gitHead(uri) {
    if (uri.scheme !== 'file' || !vscode.workspace.isTrusted) return null;
    let real;
    try { real = fs.realpathSync.native(uri.fsPath); } catch (e) { return null; }
    const dir = path.dirname(real);
    let top;
    try { top = (await git(['rev-parse', '--show-toplevel'], dir)).toString('utf8').trim(); } catch (e) { return null; }
    const rel = path.relative(fs.realpathSync.native(top), real).split(path.sep).join('/');
    try { return await git(['show', `HEAD:${rel}`], top); } catch (e) { return null; }
  }

  function openPanel(kind, title) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    let p = panels[kind];
    if (p) { p.panel.title = title; p.panel.reveal(vscode.ViewColumn.Beside, false); return p; }
    const support = require('./support');
    const panel = vscode.window.createWebviewPanel(`${PREFIX}.${kind}`, title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
      enableCommandUris: reach ? reach.commandIds().concat(support.commandUris(PREFIX)) : support.commandUris(PREFIX),
    });
    panel.webview.html = panelHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css')).toString(),
      title, head: reach ? (n) => reach.headHtml(n) : undefined, showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    p = { panel, ready: false, queue: null, onAction: null, onShown: null };
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m) return;
      try {
        if (m.type === 'ready') { p.ready = true; if (p.queue) panel.webview.postMessage(p.queue); }
        else if (m.type === 'shown') { const f = p.onShown; p.onShown = null; if (f) await f(); }
        else if (m.type === 'action' && p.onAction) await p.onAction(m.id, m);
      } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); }
    });
    panel.onDidDispose(() => { delete panels[kind]; });
    panels[kind] = p;
    return p;
  }
  function show(p, data, onShown) {
    const msg = { type: 'data', data };
    p.onShown = onShown;
    if (p.ready) p.panel.webview.postMessage(msg); else p.queue = msg;
  }
  async function saveMarkdown(text, suggested, near) {
    const dir = near && near.scheme === 'file' ? vscode.Uri.joinPath(near, '..') : (vscode.workspace.workspaceFolders || [])[0]?.uri;
    const dest = await vscode.window.showSaveDialog({ defaultUri: dir ? vscode.Uri.joinPath(dir, suggested) : undefined, filters: { Markdown: ['md'] }, saveLabel: 'Save report' });
    if (!dest) return;
    await vscode.workspace.fs.writeFile(dest, Buffer.from(text, 'utf8'));
    vscode.window.setStatusBarMessage(`Saved ${baseName(dest)}.`, 4000);
  }
  async function copyText(text, what) {
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`Copied ${what}.`, 4000);
  }

  // ---------- Pro 1: size profiler ----------
  async function profile(arg) {
    if (!(await pro.allowed('profile', arg))) return;
    let uri = targetUri(arg);
    if (!uri) uri = await pickWasm('Choose the .wasm file to profile');
    if (!uri) return;
    let model;
    try { ({ model } = await modelFor(uri)); } catch (e) { vscode.window.showErrorMessage(`${baseName(uri)} could not be read: ${e.message}`); return; }
    let prof;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Profiling ${baseName(uri)}` }, async () => { await tick(); prof = P.profile(model.mod); });
    const { graph, ...data } = prof;
    const p = openPanel('profile', `Size: ${baseName(uri)}`);
    p.onAction = async (id, m) => {
      if (id === 'saveMd') await saveMarkdown(P.markdown(prof, baseName(uri)), `${baseName(uri).replace(/\.wasm$/i, '')}-size.md`, uri);
      else if (id === 'copyMd') await copyText(P.markdown(prof, baseName(uri)), 'the size report as Markdown');
      else if (id === 'keep' && Number.isInteger(m.index)) p.panel.webview.postMessage({ type: 'keep', data: P.keepAlive(model.mod, graph, m.index) });
      else if (id === 'open' && Number.isInteger(m.index)) await provider.revealFunction(uri, m.index);
    };
    show(p, { kind: 'profile', title: `Size profile: ${baseName(uri)}`, file: baseName(uri), ...data }, () => pro.produced('profile'));
  }

  // ---------- Pro 2: compare two builds ----------
  async function compare(arg, uris) {
    if (!(await pro.allowed('compare', arg))) return;
    let left; let right;
    const read = async (u) => parseModule(new Uint8Array(await vscode.workspace.fs.readFile(u)));
    try {
      if (Array.isArray(uris) && uris.length === 2 && uris.every((u) => u && u.scheme)) {
        left = { label: baseName(uris[0]), uri: uris[0], mod: await read(uris[0]) };
        right = { label: baseName(uris[1]), uri: uris[1], mod: await read(uris[1]) };
      } else {
        let uri = targetUri(arg);
        if (!uri) uri = await pickWasm('Choose the newer build');
        if (!uri) return;
        const head = await gitHead(uri);
        const files = await wasmFiles(uri);
        const items = [];
        if (head) items.push({ label: '$(git-commit) Git HEAD version', description: 'the last committed build of this file', v: 'head' });
        for (const f of files.slice(0, 200)) items.push({ label: `$(file-binary) ${baseName(f)}`, description: vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(f) : f.fsPath, uri: f });
        items.push({ label: '$(folder-opened) Browse...', description: 'Choose another .wasm file on disk', v: 'browse' });
        const pick = await vscode.window.showQuickPick(items, { placeHolder: `Compare ${baseName(uri)} with the older build...`, matchOnDescription: true });
        if (!pick) return;
        right = { label: baseName(uri), uri, mod: await read(uri) };
        if (pick.v === 'head') left = { label: `${baseName(uri)} (git HEAD)`, uri, mod: parseModule(new Uint8Array(head)) };
        else {
          let other = pick.uri;
          if (!other) { const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', filters: { WebAssembly: ['wasm'], 'All files': ['*'] } }); other = r && r[0]; }
          if (!other) return;
          left = { label: baseName(other), uri: other, mod: await read(other) };
        }
      }
    } catch (e) { vscode.window.showErrorMessage(`A build could not be read: ${e.message}`); return; }
    let swapped = false;
    let result;
    const run = () => {
      const [a, b] = swapped ? [right, left] : [left, right];
      result = C.compare(a.mod, b.mod);
      return { kind: 'compare', title: `Compare builds: ${a.label} to ${b.label}`, old: a.label, new: b.label, ...result, funcs: result.funcs.slice(0, 2000), funcCount: result.funcs.length, markdown: C.markdown(result, a.label, b.label) };
    };
    const p = openPanel('compare', `Compare ${right.label}`);
    let data = run();
    p.onAction = async (id, m) => {
      if (id === 'swap') { swapped = !swapped; data = run(); show(p, data); }
      else if (id === 'copyMd') await copyText(data.markdown, 'the size table as Markdown');
      else if (id === 'saveMd') await saveMarkdown(data.markdown + '\n', `${right.label.replace(/\.wasm$/i, '')}-size-change.md`, right.uri);
      else if (id === 'open' && Number.isInteger(m.index)) { const side = m.side === 'old' ? (swapped ? right : left) : (swapped ? left : right); if (side.uri && !/git HEAD/.test(side.label)) await provider.revealFunction(side.uri, m.index); }
    };
    show(p, data, () => pro.produced('compare'));
  }

  // ---------- Pro 3: source mapping ----------
  async function findIndex(uri, model) {
    const m = model.mod;
    if (m.customs.some((c) => c.name === '.debug_line')) {
      const ix = D.dwarfIndex(m);
      if (ix) return { ix, from: 'DWARF in the module' };
    }
    const tryRead = async (u) => { try { return Buffer.from(await vscode.workspace.fs.readFile(u)); } catch (e) { return null; } };
    // a separate DWARF file (emcc -gseparate-dwarf)
    if (m.externalDebugInfo && !/^[a-z]+:\/\//i.test(m.externalDebugInfo)) {
      const u = vscode.Uri.joinPath(uri, '..', m.externalDebugInfo);
      const b = await tryRead(u);
      if (b) {
        try {
          const dm = parseModule(new Uint8Array(b));
          const t = D.lineTable(dm);
          const code = m.sections.find((s) => s.id === 10);
          if (t && t.rows.addr.length) { const ix = D.makeIndex(t, code ? code.start : 0, 'dwarf'); ix.units = t.units; return { ix, from: `DWARF in ${m.externalDebugInfo}` }; }
        } catch (e) { /* not a module */ }
      }
    }
    // a source map: the sourceMappingURL custom section (local path only), then <file>.map
    const names = [];
    if (m.sourceMappingURL && !/^[a-z]+:\/\//i.test(m.sourceMappingURL)) names.push(m.sourceMappingURL);
    names.push(`${baseName(uri)}.map`);
    for (const n of names) {
      const b = await tryRead(vscode.Uri.joinPath(uri, '..', n));
      if (!b) continue;
      try { return { ix: D.sourceMapIndex(b.toString('utf8')), from: `source map ${n}` }; } catch (e) { return { error: `${n} could not be read as a source map: ${e.message}` }; }
    }
    return { error: m.sourceMappingURL && /^[a-z]+:\/\//i.test(m.sourceMappingURL) ? `The module points to a source map on the web (${m.sourceMappingURL}). This extension makes no network requests: save the map next to the .wasm as ${baseName(uri)}.map.` : '' };
  }

  async function resolveSource(file, near) {
    const tries = [];
    if (/^([/\\]|[A-Za-z]:[/\\])/.test(file)) tries.push(vscode.Uri.file(file));
    else if (near && near.scheme === 'file') tries.push(vscode.Uri.joinPath(near, '..', file));
    for (const u of tries) { try { await vscode.workspace.fs.stat(u); return u; } catch (e) { /* next */ } }
    // search the workspace by file name and keep the one whose path ends with the most of `file`
    const base = file.split('/').pop();
    if (!base) return null;
    const found = await vscode.workspace.findFiles(`**/${base}`, '**/{node_modules,.git}/**', 20).then(undefined, () => []);
    let best = null; let bestLen = -1;
    for (const u of found) {
      const a = u.path.split('/').reverse(); const b = file.split('/').reverse();
      let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++;
      if (k > bestLen) { best = u; bestLen = k; }
    }
    return best;
  }
  async function openSource(uri, file, line) {
    const u = await resolveSource(file, uri);
    if (!u) { vscode.window.showInformationMessage(`${file} is not in this workspace. Open the folder with the sources to jump to it.`); return; }
    const doc = await vscode.workspace.openTextDocument(u);
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
    const pos = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  async function sourceMap(arg) {
    if (!(await pro.allowed('sourcemap', arg))) return;
    let uri = targetUri(arg);
    if (!uri) uri = await pickWasm('Choose the .wasm file');
    if (!uri) return;
    let model; let doc;
    try { ({ model, doc } = await modelFor(uri)); } catch (e) { vscode.window.showErrorMessage(`${baseName(uri)} could not be read: ${e.message}`); return; }
    const found = await findIndex(uri, model);
    if (!found.ix) {
      const msg = found.error || `${baseName(uri)} has no DWARF line table (.debug_line), no separate debug file and no source map next to it, so there is nothing to map. Build with debug info (clang or emcc -g, Rust debug = true, or emcc -gsource-map) and open that build. No free try was used.`;
      vscode.window.showInformationMessage(msg);
      return;
    }
    const ix = found.ix;
    const m = model.mod;
    const funcs = [];
    const files = new Map();
    for (let i = m.importCounts.func; i < m.funcs.length; i++) {
      const b = m.funcs[i].body;
      if (!b) continue;
      const r = ix.range(b.start, b.end);
      const name = require('./core/wasm').funcLabel(m, i);
      if (!r.first) { funcs.push({ index: i, name, size: b.size, file: '', line: 0, endLine: 0 }); continue; }
      const span = r.span.get(r.first.file) || { min: r.first.line, max: r.first.line };
      funcs.push({ index: i, name, size: b.size, file: r.first.file, line: span.min, endLine: span.max });
      const f = files.get(r.first.file) || { file: r.first.file, funcs: 0, size: 0 };
      f.funcs++; f.size += b.size;
      files.set(r.first.file, f);
    }
    const mapped = funcs.filter((f) => f.file).length;
    model.setSource(ix);
    if (doc) provider.refreshSource(doc);
    const data = {
      kind: 'sourcemap', title: `Source mapping: ${baseName(uri)}`, file: baseName(uri), from: found.from, rows: ix.rows,
      units: (ix.units || []).length, producer: ((ix.units || [])[0] || {}).producer || '',
      mapped, total: funcs.length, files: [...files.values()].sort((a, b) => b.size - a.size).slice(0, 2000),
      funcs: funcs.sort((a, b) => (a.file || '￿').localeCompare(b.file || '￿') || a.line - b.line).slice(0, 20000),
    };
    const p = openPanel('sourcemap', `Sources: ${baseName(uri)}`);
    p.onAction = async (id, msg) => {
      if (id === 'open' && Number.isInteger(msg.index)) await provider.revealFunction(uri, msg.index);
      else if (id === 'source' && typeof msg.file === 'string') await openSource(uri, msg.file, msg.line);
      else if (id === 'saveMd') await saveMarkdown(sourceMarkdown(data), `${baseName(uri).replace(/\.wasm$/i, '')}-sources.md`, uri);
    };
    show(p, data, () => pro.produced('sourcemap'));
  }

  return { profile, compare, sourceMap, openSource, resolveSource, findIndex, pickWasm };
}

function sourceMarkdown(d) {
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  const L = [`# Source files of ${d.file}`, '', `From ${d.from}: ${d.mapped} of ${d.total} functions have a source line.`, '', '| Source file | Functions | Code size |', '|---|---:|---:|'];
  for (const f of d.files) L.push(`| ${cell(f.file)} | ${f.funcs} | ${P.fmtBytes(f.size)} |`);
  return L.join('\n') + '\n';
}

module.exports = { createTools };
