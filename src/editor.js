'use strict';
// The read-only custom editor for .wasm files: the module as WAT text with one fold per function, and an overview of
// its sections, imports, exports, memories, tables, globals and custom sections. A large module opens folded and
// prints a function only when it is opened, so a 35 MB module opens in about a second. Nothing is ever written to
// the .wasm file.
const vscode = require('vscode');
const path = require('path');
const { WasmModel } = require('./model');
const { WasmError } = require('./core/wasm');
const { validateInWorker } = require('./convert');
const { editorHtml } = require('./html');
const { commandUris } = require('./support');

const VIEW_TYPE = 'wasmViewer.editor';
const PREFIX = 'wasmViewer';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const baseName = (uri) => path.posix.basename(uri.path);

class WasmDocument {
  constructor(uri) {
    this.uri = uri;
    this.model = null;
    this.failed = '';
    this.panels = new Set();
    this.searches = new Map();
    this._onDispose = new vscode.EventEmitter();
    this.onDidDispose = this._onDispose.event;
  }
  load(bytes) {
    this.failed = '';
    this.model = null;
    try {
      this.model = new WasmModel(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), { names: setting('useNames', true) !== false, eagerBytes: Number(setting('openFunctionsBelowKB', 1536)) * 1024 });
    } catch (e) {
      if (!(e instanceof WasmError) && !(e instanceof RangeError)) this.failed = `The module could not be decoded: ${(e && e.message) || e}`;
      else this.failed = String(e.message);
    }
  }
  dispose() { this._onDispose.fire(); this._onDispose.dispose(); }
}

class WasmEditorProvider {
  constructor(context, hooks) {
    this.context = context;
    this.hooks = hooks || {};
    this.docs = new Set();
    this.active = null;
  }

  async openCustomDocument(uri) {
    const doc = new WasmDocument(uri);
    this.docs.add(doc);
    doc.onDidDispose(() => { this.docs.delete(doc); if (this.active === doc) this.active = null; });
    await this.read(doc);
    this.watch(doc);
    return doc;
  }

  async read(doc) {
    try {
      const st = await vscode.workspace.fs.stat(doc.uri);
      const max = Number(setting('maxFileSizeMB', 512)) || 512;
      if (st.size > max * 1048576) {
        doc.failed = `The file is ${(st.size / 1048576).toFixed(1)} MB, more than the ${max} MB set in wasmViewer.maxFileSizeMB. Raise the setting to open it.`;
        return;
      }
      doc.load(Buffer.from(await vscode.workspace.fs.readFile(doc.uri)));
    } catch (e) {
      doc.failed = `The file could not be read: ${(e && e.message) || e}`;
    }
  }

  watch(doc) {
    if (doc.uri.scheme !== 'file' || !vscode.workspace.createFileSystemWatcher) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(doc.uri, '..'), baseName(doc.uri)));
    let timer = null;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => { await this.read(doc); for (const p of doc.panels) this.sendInit(doc, p); }, 400);
    };
    const subs = [w, w.onDidChange(changed), w.onDidCreate(changed)];
    doc.onDidDispose(() => { clearTimeout(timer); subs.forEach((s) => s.dispose()); });
  }

  async resolveCustomEditor(doc, panel) {
    doc.panels.add(panel);
    this.active = doc;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const reach = this.hooks.reach && this.hooks.reach();
    panel.webview.options = {
      enableScripts: true,
      enableCommandUris: [...new Set([...commandUris(PREFIX), ...(reach ? reach.commandIds() : [])])],
      localResourceRoots: [media],
    };
    panel.webview.html = editorHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.css')).toString(),
      title: baseName(doc.uri),
      showSupportLinks: setting('showSupportLinks', true) !== false,
      head: reach ? (n) => reach.headHtml(n) : undefined,
    });
    if (reach) reach.attach(panel.webview, panel);
    panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) this.active = doc; });
    panel.onDidDispose(() => { doc.panels.delete(panel); for (const t of doc.searches.values()) t.cancelled = true; });
    let counted = false;
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      try {
        if (m.type === 'ready') this.sendInit(doc, panel);
        else if (m.type === 'rendered') {
          if (counted) return;
          counted = true;
          if (m.failed) { if (this.hooks.onFailure) this.hooks.onFailure(doc); } else if (this.hooks.onSuccess) this.hooks.onSuccess(doc);
        } else if (m.type === 'getLines') this.sendLines(doc, panel, m.bs);
        else if (m.type === 'search') await this.search(doc, panel, m);
        else if (m.type === 'cancelSearch') { const t = doc.searches.get(panel); if (t) t.cancelled = true; }
        else if (m.type === 'filter') { if (doc.model) panel.webview.postMessage({ type: 'filtered', which: m.which, q: m.q, ...doc.model.filterList(m.which, m.q) }); }
        else if (m.type === 'validate') await this.validate(doc, panel);
        else if (m.type === 'offsets') await vscode.workspace.getConfiguration(PREFIX).update('showOffsets', !!m.on, vscode.ConfigurationTarget.Global);
        else if (m.type === 'command') {
          this.active = doc;
          const map = { saveWat: 'saveAsWat', openText: 'openAsText', profile: 'profile', compare: 'compare', sourceMap: 'sourceMap' };
          if (map[m.id]) await vscode.commands.executeCommand(`${PREFIX}.${map[m.id]}`, doc.uri);
        } else if (m.type === 'copy') {
          await vscode.env.clipboard.writeText(String(m.text || ''));
          vscode.window.setStatusBarMessage(m.what ? `Copied ${m.what}.` : 'Copied.', 3000);
        } else if (m.type === 'openSource' && this.hooks.openSource) await this.hooks.openSource(doc, m.file, m.line);
      } catch (e) {
        panel.webview.postMessage({ type: 'error', message: String((e && e.message) || e) });
      }
    });
  }

  sendInit(doc, panel) {
    if (doc.failed || !doc.model) { panel.webview.postMessage({ type: 'failed', message: doc.failed || 'The module could not be read.' }); return; }
    const m = doc.model;
    panel.webview.postMessage({
      type: 'init', file: baseName(doc.uri), overview: m.overview(baseName(doc.uri)), blocks: m.webviewBlocks(), sigs: m.sigs(), funcIds: m.funcIds(),
      eager: m.eager, offsets: setting('showOffsets', false) === true, src: !!m.src, srcKind: m.src ? m.src.kind : '',
    });
  }

  sendLines(doc, panel, bs) {
    if (!doc.model || !Array.isArray(bs)) return;
    const items = [];
    for (const b of bs.slice(0, 200)) {
      if (typeof b !== 'number' || !doc.model.blocks[b]) continue;
      const r = doc.model.lines(b);
      items.push({ b, lines: r.lines, offs: r.offsets, src: r.src });
    }
    panel.webview.postMessage({ type: 'lines', items });
  }

  async search(doc, panel, m) {
    if (!doc.model) return;
    const old = doc.searches.get(panel);
    if (old) old.cancelled = true;
    const token = { cancelled: false };
    doc.searches.set(panel, token);
    const q = String(m.q || '');
    if (!q.trim()) { panel.webview.postMessage({ type: 'searchDone', id: m.id, q, hits: [], scanned: 0 }); return; }
    let r;
    try {
      r = await doc.model.search(q, {
        max: 1000, token, regex: !!m.regex, caseSensitive: !!m.caseSensitive,
        onProgress: (i, n, h) => panel.webview.postMessage({ type: 'searchProgress', id: m.id, done: i, total: n, hits: h }),
      });
    } catch (e) { panel.webview.postMessage({ type: 'searchDone', id: m.id, q, hits: [], error: String(e.message) }); return; }
    if (token.cancelled && !r.more) return;
    panel.webview.postMessage({ type: 'searchDone', id: m.id, q, hits: r.hits, more: !!r.more, total: doc.model.blocks.length });
  }

  async validate(doc, panel) {
    if (!doc.model) return;
    panel.webview.postMessage({ type: 'validating' });
    const t = Date.now();
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Validating ${baseName(doc.uri)}` }, () => validateInWorker(doc.model.mod.bytes));
    const body = doc.model.mod.size <= 64 * 1048576 ? doc.model.bodyErrors(20) : [];
    panel.webview.postMessage({ type: 'validated', ok: r.ok && !body.length, errors: r.errors, bodyErrors: body, ms: Date.now() - t });
  }

  /** Shows a function in the viewer (from a Pro panel, a search or a symbol). */
  async revealFunction(uri, func) {
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
    const doc = this.docFor(uri);
    if (!doc) return;
    const send = () => { for (const p of doc.panels) p.webview.postMessage({ type: 'reveal', func }); };
    send();
    setTimeout(send, 600); // a panel that was just created gets it after its init
  }

  /** Re-sends the lines with source locations after the source mapping tool ran. */
  refreshSource(doc) {
    for (const p of doc.panels) p.webview.postMessage({ type: 'srcChanged', src: !!(doc.model && doc.model.src), srcKind: doc.model && doc.model.src ? doc.model.src.kind : '' });
  }

  docFor(uri) {
    if (uri) for (const d of this.docs) if (d.uri.toString() === uri.toString()) return d;
    return uri ? null : this.active;
  }
}

module.exports = { WasmEditorProvider, WasmDocument, VIEW_TYPE };
