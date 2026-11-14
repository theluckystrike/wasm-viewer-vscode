'use strict';
// Free commands around the viewer: Save as WAT, Open as Text (a read-only WAT document), Compile WAT to WASM, and
// the WAT language features (errors with line numbers while you type, outline, folding).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { WasmModel } = require('./model');
const { watToWasm } = require('./convert');
const { symbols, foldingRanges } = require('./core/watText');

const PREFIX = 'wasmViewer';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const baseName = (uri) => path.posix.basename(uri.path);
const isWat = (doc) => doc && (doc.languageId === 'wat' || /\.(wat|wast)$/i.test(doc.uri.path));

function createFree({ context, provider, viewType }) {
  const sub = (d) => context.subscriptions.push(d);

  function wasmTarget(arg) {
    if (arg && arg.scheme) return arg;
    if (provider.active) return provider.active.uri;
    return null;
  }
  async function modelFor(uri) {
    const doc = provider.docFor(uri);
    if (doc && doc.model) return doc.model;
    if (doc && doc.failed) throw new Error(doc.failed);
    return new WasmModel(new Uint8Array(await vscode.workspace.fs.readFile(uri)), { names: setting('useNames', true) !== false, eagerBytes: 0 });
  }

  // ---------- Open as Text ----------
  const textChanged = new vscode.EventEmitter();
  sub(textChanged);
  sub(vscode.workspace.registerTextDocumentContentProvider('wasm-wat', {
    onDidChange: textChanged.event,
    async provideTextDocumentContent(uri) {
      const src = vscode.Uri.parse(uri.query);
      const m = await modelFor(src);
      return m.text();
    },
  }));
  async function openAsText(arg) {
    const uri = wasmTarget(arg);
    if (!uri) { vscode.window.showInformationMessage('Open a .wasm file first.'); return undefined; }
    const max = Number(setting('openAsTextMaxMB', 16)) || 16;
    const st = await vscode.workspace.fs.stat(uri);
    if (st.size > max * 1048576) {
      const pick = await vscode.window.showWarningMessage(`${baseName(uri)} is ${(st.size / 1048576).toFixed(1)} MB. Its WAT text would be many times larger than the ${max} MB set in wasmViewer.openAsTextMaxMB, which is slow in a text editor.`, { modal: true }, 'Save as WAT...', 'Open anyway');
      if (pick === 'Save as WAT...') return saveAsWat(uri);
      if (pick !== 'Open anyway') return undefined;
    }
    const target = vscode.Uri.from({ scheme: 'wasm-wat', path: `${uri.path}.wat`, query: uri.toString() });
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.languages.setTextDocumentLanguage(doc, 'wat').then(undefined, () => doc);
    return vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }

  // ---------- Save as WAT ----------
  async function saveAsWat(arg) {
    const uri = wasmTarget(arg);
    if (!uri) { vscode.window.showInformationMessage('Open a .wasm file first.'); return undefined; }
    let m;
    try { m = await modelFor(uri); } catch (e) { vscode.window.showErrorMessage(`${baseName(uri)} could not be read: ${e.message}`); return undefined; }
    const stem = baseName(uri).replace(/\.wasm$/i, '');
    const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(uri, '..', `${stem}.wat`), filters: { 'WebAssembly text': ['wat'] }, saveLabel: 'Save as WAT' });
    if (!dest) return undefined;
    let bytes = 0;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Writing ${baseName(dest)}` }, async () => {
      if (dest.scheme === 'file') {
        const fd = fs.openSync(dest.fsPath, 'w');
        try { m.write((s) => { const b = Buffer.from(s, 'utf8'); fs.writeSync(fd, b); bytes += b.length; }); } finally { fs.closeSync(fd); }
      } else {
        const b = Buffer.from(m.text(), 'utf8');
        bytes = b.length;
        await vscode.workspace.fs.writeFile(dest, b);
      }
    });
    vscode.window.setStatusBarMessage(`Saved ${baseName(dest)} (${(bytes / 1048576).toFixed(1)} MB of WAT).`, 6000);
    if (bytes <= (Number(setting('openAsTextMaxMB', 16)) || 16) * 1048576 * 8) {
      const doc = await vscode.workspace.openTextDocument(dest);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    }
    return dest;
  }

  // ---------- WAT: errors while typing, compile ----------
  const diags = vscode.languages.createDiagnosticCollection('wat');
  sub(diags);
  const toDiag = (doc, e) => {
    const line = Math.max(0, Math.min(doc.lineCount - 1, (e.line || 1) - 1));
    const col = Math.max(0, (e.col || 1) - 1);
    const range = new vscode.Range(line, col, line, col + Math.max(1, e.length || 1));
    const d = new vscode.Diagnostic(range, e.message, e.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
    d.source = 'wabt';
    return d;
  };
  async function check(doc) {
    if (!isWat(doc) || doc.uri.scheme === 'wasm-wat' || setting('checkWat', true) === false) return null;
    if (doc.getText().length > 8 * 1048576) return null;
    const version = doc.version;
    const r = await watToWasm(doc.getText(), baseName(doc.uri));
    if (doc.version !== version) return null;
    diags.set(doc.uri, r.ok ? [] : r.errors.map((e) => toDiag(doc, e)));
    return r;
  }
  const timers = new Map();
  const later = (doc) => {
    clearTimeout(timers.get(doc.uri.toString()));
    timers.set(doc.uri.toString(), setTimeout(() => { timers.delete(doc.uri.toString()); check(doc).catch(() => {}); }, 500));
  };
  sub(vscode.workspace.onDidOpenTextDocument((d) => { if (isWat(d)) later(d); }));
  sub(vscode.workspace.onDidChangeTextDocument((e) => { if (isWat(e.document)) later(e.document); }));
  sub(vscode.workspace.onDidCloseTextDocument((d) => diags.delete(d.uri)));
  for (const d of vscode.workspace.textDocuments || []) if (isWat(d)) later(d);

  async function compileWat(arg) {
    let doc;
    if (arg && arg.scheme) doc = await vscode.workspace.openTextDocument(arg);
    else if (vscode.window.activeTextEditor && isWat(vscode.window.activeTextEditor.document)) doc = vscode.window.activeTextEditor.document;
    if (!doc) { vscode.window.showInformationMessage('Open a .wat file first.'); return undefined; }
    const r = await watToWasm(doc.getText(), baseName(doc.uri));
    if (!r.ok) {
      diags.set(doc.uri, r.errors.map((e) => toDiag(doc, e)));
      const e = r.errors[0] || { message: 'unknown error' };
      const where = e.line ? `line ${e.line}, column ${e.col}: ` : '';
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      if (e.line) { const p = new vscode.Position(e.line - 1, Math.max(0, e.col - 1)); ed.selection = new vscode.Selection(p, p); ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenterIfOutsideViewport); }
      vscode.window.showErrorMessage(`${baseName(doc.uri)} was not compiled. ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}, the first at ${where}${e.message}`);
      return undefined;
    }
    diags.set(doc.uri, []);
    const stem = baseName(doc.uri).replace(/\.(wat|wast)$/i, '');
    let dest;
    if (doc.uri.scheme === 'file' || doc.uri.scheme === 'vscode-remote') dest = vscode.Uri.joinPath(doc.uri, '..', `${stem}.wasm`);
    else {
      dest = await vscode.window.showSaveDialog({ defaultUri: vscode.workspace.workspaceFolders ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, `${stem}.wasm`) : undefined, filters: { WebAssembly: ['wasm'] }, saveLabel: 'Save .wasm' });
      if (!dest) return undefined;
    }
    await vscode.workspace.fs.writeFile(dest, r.bytes);
    vscode.window.setStatusBarMessage(`Compiled ${baseName(doc.uri)} to ${baseName(dest)} (${r.bytes.length.toLocaleString()} bytes).`, 8000);
    if (setting('openAfterCompile', true) !== false) await vscode.commands.executeCommand('vscode.openWith', dest, viewType, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    return dest;
  }

  // ---------- WAT outline and folding ----------
  const sel = [{ language: 'wat' }];
  sub(vscode.languages.registerDocumentSymbolProvider(sel, {
    provideDocumentSymbols(doc) {
      return symbols(doc.getText()).map((s) => {
        const r = new vscode.Range(s.line, 0, s.endLine, 0);
        return new vscode.DocumentSymbol(s.name, s.detail, vscode.SymbolKind[s.kind] || vscode.SymbolKind.Function, r, new vscode.Range(s.line, 0, s.line, 0));
      });
    },
  }));
  if (vscode.languages.registerFoldingRangeProvider) {
    sub(vscode.languages.registerFoldingRangeProvider(sel, {
      provideFoldingRanges(doc) { return foldingRanges(doc.getText()).map(([a, b]) => new vscode.FoldingRange(a, b)); },
    }));
  }

  return { openAsText, saveAsWat, compileWat, check, diags };
}

module.exports = { createFree, isWat };
