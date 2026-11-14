'use strict';
// WebAssembly Viewer by Zovo: .wasm files as WAT text with folding per function, a module overview, WAT to WASM and
// WASM to WAT. No network, no telemetry. Activation shows nothing: no message, no popup. The viewer opens only for
// files the user opens.
const vscode = require('vscode');
const { WasmEditorProvider, VIEW_TYPE } = require('./editor');
const { createFree } = require('./free');
const { createTools } = require('./tools');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');

const PREFIX = 'wasmViewer';
const EXT_ID = 'zovo.zovo-wasm-viewer';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

function activate(context) {
  const sub = (d) => context.subscriptions.push(d);
  let rating = { success() {}, failure() {} };
  try { rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'WebAssembly Viewer' }); } catch (e) { /* rating is optional */ }
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  const pro = createPro({ vscode, context });
  const reach = createReach({ vscode, ...reachConfig, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  sub(pro.onDidChange(() => reach.refresh()));

  let tools = null;
  const provider = new WasmEditorProvider(context, {
    reach: () => reach,
    onSuccess: (doc) => rating.success(doc.uri),
    onFailure: () => rating.failure(),
    openSource: (doc, file, line) => tools && tools.openSource(doc.uri, file, line),
  });
  sub(vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }));
  const free = createFree({ context, provider, viewType: VIEW_TYPE });
  tools = createTools({ context, provider, pro, reach });

  const reg = (id, fn) => sub(vscode.commands.registerCommand(id, fn));
  const uriOf = (u) => (u && u.scheme ? u : undefined);
  reg(`${PREFIX}.openAsText`, (uri) => free.openAsText(uriOf(uri)));
  reg(`${PREFIX}.saveAsWat`, (uri) => free.saveAsWat(uriOf(uri)));
  reg(`${PREFIX}.compileWat`, (uri) => free.compileWat(uriOf(uri)));
  reg(`${PREFIX}.openWithViewer`, (uri) => {
    const u = uriOf(uri) || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
    if (!u) { vscode.window.showInformationMessage('Select a .wasm file first.'); return undefined; }
    return vscode.commands.executeCommand('vscode.openWith', u, VIEW_TYPE);
  });
  reg(`${PREFIX}.find`, () => { const d = provider.active; if (d) for (const p of d.panels) p.webview.postMessage({ type: 'focusSearch' }); });
  reg(`${PREFIX}.openSample`, () => vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(context.extensionUri, 'samples', 'hello.wasm'), VIEW_TYPE));
  reg(`${PREFIX}.openWatSample`, async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(context.extensionUri, 'samples', 'hello.wat'));
    return vscode.window.showTextDocument(doc, { preview: false });
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
  reg(`${PREFIX}.profile`, reach.wrap((uri) => tools.profile(uriOf(uri))));
  reg(`${PREFIX}.compare`, reach.wrap((uri, uris) => tools.compare(uriOf(uri), uris)));
  reg(`${PREFIX}.sourceMap`, reach.wrap((uri) => tools.sourceMap(uriOf(uri))));
  sub(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) reach.refresh(); }));
  sub(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  return { provider, tools, free, pro };
}

function deactivate() {}

module.exports = { activate, deactivate };
