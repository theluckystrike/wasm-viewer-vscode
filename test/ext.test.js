'use strict';
// The extension in a VS Code stand-in: listing rules, quiet activation, the viewer protocol, the free commands and
// the three Pro tools with their free tries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadExtension } = require('./support/vscode-stub');
const { editorHtml, panelHtml } = require('../src/html');
const { parseModule } = require('../src/core/wasm');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function activate(folder) {
  const s = loadExtension();
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  s.api = s.ext.activate(s.context);
  return s;
}
function tmp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-ws-'));
  dirs.push(dir);
  for (const [n, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true }); fs.writeFileSync(path.join(dir, n), t); }
  return dir;
}
function fakePanel() {
  let onMsg;
  const posted = [];
  return {
    posted, viewColumn: 1, active: true,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), reveal() {},
    send: (m) => onMsg(m),
  };
}
async function openViewer(s, file) {
  const prov = s.providers.custom.p;
  const doc = await prov.openCustomDocument(s.vscode.Uri.file(file), {});
  const panel = fakePanel();
  await prov.resolveCustomEditor(doc, panel);
  await panel.send({ type: 'ready' });
  return { prov, doc, panel, last: (type) => panel.posted.filter((m) => !type || m.type === type).at(-1) };
}
const sample = (n) => fs.readFileSync(path.join(ROOT, 'samples', n));

test('listing rules: name, description, 5 tags, engine, no dependencies, Pro titles, Explorer wrappers', () => {
  assert.equal(pkg.name, 'zovo-wasm-viewer');
  assert.equal(pkg.publisher, 'zovo');
  assert.equal(pkg.displayName, 'WebAssembly Viewer (WASM, WAT)');
  assert.ok(pkg.displayName.length <= 30);
  assert.ok(pkg.displayName.toLowerCase().startsWith('webassembly'));
  assert.ok(pkg.description.toLowerCase().startsWith('webassembly'));
  assert.deepEqual(pkg.keywords, ['webassembly', 'wasm', 'wat', 'wasm viewer', 'disassembler']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.ok(!pkg.dependencies);
  assert.deepEqual(pkg.activationEvents, ['onLanguage:wat']);
  for (const id of ['profile', 'compare', 'sourceMap']) assert.match(pkg.contributes.commands.find((c) => c.command === `wasmViewer.${id}`).title, /\(Pro\)$/);
  const ctx = pkg.contributes.menus['explorer/context'].filter((m) => /zovoPro/.test(m.command));
  assert.equal(ctx.length, 3);
  for (const m of ctx) {
    assert.match(pkg.contributes.commands.find((c) => c.command === m.command).title, /^Zovo Pro: /);
    assert.match(m.when, /config\.wasmViewer\.showProTools/);
    assert.ok(pkg.contributes.menus.commandPalette.some((p) => p.command === m.command && p.when === 'false'));
  }
  for (const menu of Object.values(pkg.contributes.menus)) for (const m of menu) assert.ok(!('title' in m));
  for (const k of Object.keys(pkg.contributes.configuration.properties)) assert.ok(k.startsWith('wasmViewer.'), k);
  assert.deepEqual(pkg.contributes.customEditors[0].selector, [{ filenamePattern: '*.wasm' }]);
  assert.equal(pkg.contributes.customEditors[0].priority, 'default');
  assert.deepEqual(pkg.contributes.languages[0].extensions, ['.wat', '.wast']);
  JSON.parse(fs.readFileSync(path.join(ROOT, pkg.contributes.grammars[0].path), 'utf8'));
  JSON.parse(fs.readFileSync(path.join(ROOT, 'language-configuration.json'), 'utf8'));
  const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
  assert.match(ignore, /^test\/\*\*$/m);
  assert.match(fs.readFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8'), /Apache License 2\.0/);
  assert.match(fs.readFileSync(path.join(ROOT, 'vendor', 'wabt', 'LICENSE'), 'utf8'), /Apache License/);
});

test('activation registers every command and shows nothing', () => {
  const s = activate();
  for (const c of pkg.contributes.commands) assert.ok(s.commands.has(c.command), c.command);
  assert.equal(s.providers.custom.id, 'wasmViewer.editor');
  assert.deepEqual([s.log.info, s.log.warn, s.log.error, s.log.opened, s.log.external], [[], [], [], [], []]);
  for (const step of pkg.contributes.walkthroughs[0].steps) for (const f of [step.media && step.media.image, step.media && step.media.markdown].filter(Boolean)) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  s.restore();
});

test('html: the CSP allows no remote origin and only nonce scripts', () => {
  for (const h of [editorHtml({ cspSource: 'vscode-resource:', scriptUri: 's.js', styleUri: 's.css', title: '<x>' }), panelHtml({ cspSource: 'vscode-resource:', scriptUri: 's.js', styleUri: 's.css', title: 't' })]) {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(h)[1];
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /https?:|connect-src|unsafe-inline|unsafe-eval|\*/);
    assert.match(csp, /script-src 'nonce-[\w-]+'/);
  }
  assert.match(editorHtml({ cspSource: 'c', scriptUri: 's', styleUri: 's', title: '<x>' }), /<title>&lt;x&gt;<\/title>/);
  // the webview scripts only talk to the extension (no fetch, no eval)
  for (const f of ['editor.js', 'panel.js']) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'media', f), 'utf8'), /\bfetch\(|XMLHttpRequest|\beval\(|new Function/);
});

test('viewer: init, lines on demand, find in all code, filter, validate, and the file is never written', async () => {
  const dir = tmp({ 'hello.wasm': sample('hello.wasm') });
  const file = path.join(dir, 'hello.wasm');
  const s = activate(dir);
  const v = await openViewer(s, file);
  const init = v.last('init');
  assert.equal(init.file, 'hello.wasm');
  assert.equal(init.eager, true);
  assert.equal(init.overview.counts.funcs, 7);
  const fb = init.blocks.findIndex((b) => b.k === 'func' && b.ex === 'fib');
  assert.ok(fb > 0);
  await v.panel.send({ type: 'getLines', bs: [fb] });
  const lines = v.last('lines').items[0];
  assert.equal(lines.b, fb);
  assert.match(lines.lines[0], /^ {2}\(func \$fib/);
  assert.ok(lines.offs.some((o) => o > 0));
  await v.panel.send({ type: 'search', id: 1, q: 'call $fib' });
  const found = v.last('searchDone');
  assert.equal(found.hits.length, 2);
  await v.panel.send({ type: 'filter', which: 'exports', q: 'fa' });
  assert.deepEqual(v.last('filtered').rows.map((r) => r.name), ['factorial']);
  await v.panel.send({ type: 'validate' });
  assert.equal(v.last('validated').ok, true);
  await v.panel.send({ type: 'rendered', failed: false });
  assert.ok(fs.readFileSync(file).equals(sample('hello.wasm')));
  // reveal from a Pro panel or a symbol
  await s.api.provider.revealFunction(s.vscode.Uri.file(file), 2);
  assert.equal(v.last('reveal').func, 2);
  s.restore();
});

test('viewer: a file that is not WebAssembly shows its error; a large module opens folded', async () => {
  const big = parseModule(sample('hello.wasm'));
  void big;
  const dir = tmp({ 'bad.wasm': 'not wasm at all', 'hello.wasm': sample('hello.wasm') });
  const s = activate(dir);
  s.config.openFunctionsBelowKB = 0;
  const bad = await openViewer(s, path.join(dir, 'bad.wasm'));
  assert.match(bad.last('failed').message, /not a WebAssembly binary/);
  const v = await openViewer(s, path.join(dir, 'hello.wasm'));
  assert.ok(v.last('init').blocks.filter((b) => b.k === 'func').every((b) => b.fold === 1));
  s.restore();
});

test('free: Compile WAT to WASM writes the .wasm next to the file; errors become diagnostics with line numbers', async () => {
  const dir = tmp({ 'ok.wat': sample('hello.wat').toString(), 'bad.wat': '(module\n  (func (result i32)\n    i64.const 1))\n' });
  const s = activate(dir);
  s.config.openAfterCompile = true;
  const out = await s.commands.get('wasmViewer.compileWat')(s.vscode.Uri.file(path.join(dir, 'ok.wat')));
  assert.equal(path.basename(out.fsPath), 'ok.wasm');
  assert.ok(fs.readFileSync(path.join(dir, 'ok.wasm')).equals(sample('hello.wasm')));
  assert.ok(s.log.commands.some(([id, u, vt]) => id === 'vscode.openWith' && u.fsPath.endsWith('ok.wasm') && vt === 'wasmViewer.editor'));
  assert.ok(s.log.status.some((t) => /Compiled ok\.wat to ok\.wasm/.test(t)));
  const r = await s.commands.get('wasmViewer.compileWat')(s.vscode.Uri.file(path.join(dir, 'bad.wat')));
  assert.equal(r, undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'bad.wasm')));
  assert.match(s.log.error.at(-1).text, /bad\.wat was not compiled\. 1 error, the first at line 3, column 5: type mismatch/);
  s.restore();
});

test('free: Save as WAT writes the text; Open as Text shows a read-only WAT document; WAT outline works', async () => {
  const dir = tmp({ 'hello.wasm': sample('hello.wasm') });
  const s = activate(dir);
  const uri = s.vscode.Uri.file(path.join(dir, 'hello.wasm'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'out.wat')));
  await s.commands.get('wasmViewer.saveAsWat')(uri);
  const text = fs.readFileSync(path.join(dir, 'out.wat'), 'utf8');
  assert.match(text, /^\(module \$hello\n/);
  assert.match(text, /\(func \$fib \(type 2\) \(param \$n i32\) \(result i32\)/);
  await s.commands.get('wasmViewer.openAsText')(uri);
  const doc = s.log.opened.at(-1).document || s.log.opened.at(-1);
  assert.equal(doc.uri.scheme, 'wasm-wat');
  assert.equal(doc.languageId, 'wat');
  assert.equal(doc.getText(), text);
  const syms = s.providers.symbols[0].provideDocumentSymbols({ getText: () => text });
  assert.ok(syms.some((x) => x.name === '$fib'));
  assert.ok(s.providers.folding[0].provideFoldingRanges({ getText: () => text }).length > 5);
  s.restore();
});

test('Pro size profiler: panel data, why kept, 3 tries, then the Zovo Pro panel', async () => {
  const dir = tmp({ 'hello.wasm': sample('hello.wasm') });
  const s = activate(dir);
  const uri = s.vscode.Uri.file(path.join(dir, 'hello.wasm'));
  await s.commands.get('wasmViewer.zovoPro.profile')(uri);
  await tick(20);
  await s.log.panel.send({ type: 'shown' });
  const data = s.log.panel.posted.find((m) => m.type === 'data').data;
  assert.equal(data.kind, 'profile');
  assert.equal(data.graph, undefined);
  assert.equal(data.file.funcs, 7);
  assert.ok(data.functions.some((f) => f.name === 'factorial'));
  assert.equal(s.state.get('wasmViewer.proTrial').profile, 1);
  const fib = data.functions.find((f) => f.name === 'fib').index;
  await s.log.panel.send({ type: 'action', id: 'keep', index: fib });
  const keep = s.log.panel.posted.filter((m) => m.type === 'keep').at(-1).data;
  assert.deepEqual(keep.root, ['export "fib"']);
  await s.log.panel.send({ type: 'action', id: 'copyMd' });
  assert.match(s.log.clipboard, /^# WebAssembly size profile: hello\.wasm/);
  for (let k = 0; k < 2; k++) { await s.commands.get('wasmViewer.profile')(uri); await tick(20); await s.log.panel.send({ type: 'shown' }); }
  assert.equal(s.state.get('wasmViewer.proTrial').profile, 3);
  const before = s.log.panel.posted.length;
  await s.commands.get('wasmViewer.profile')(uri);
  assert.equal(s.log.panel.posted.length, before);
  assert.ok([...s.log.info, ...s.log.warn].some((m) => /Size profiler is part of Zovo Pro/.test(m.text)) || s.log.opened.length > 0 || s.log.lastPick);
  s.restore();
});

test('Pro compare: two Explorer files, a workspace pick, git HEAD; Escape uses no try', async () => {
  const W = require('../src/convert');
  const newer = (await W.watToWasm(sample('hello.wat').toString().replace('(func $greet (export "greet")', '(func $extra (export "extra") (drop (i32.const 1)))\n  (func $greet (export "greet")'), 'n.wat')).bytes;
  const dir = tmp({ 'old.wasm': sample('hello.wasm'), 'new.wasm': newer });
  const s = activate(dir);
  const U = (n) => s.vscode.Uri.file(path.join(dir, n));
  await s.commands.get('wasmViewer.zovoPro.compare')(U('old.wasm'), [U('old.wasm'), U('new.wasm')]);
  await tick(20);
  await s.log.panel.send({ type: 'shown' });
  const d = s.log.panel.posted.find((m) => m.type === 'data').data;
  assert.equal(d.kind, 'compare');
  assert.equal(d.counts.added, 1);
  assert.ok(d.funcs.some((f) => f.kind === 'added' && f.name === 'extra'));
  assert.match(d.markdown, /\| Section \| Old \| New \| Change \|/);
  assert.equal(s.state.get('wasmViewer.proTrial').compare, 1);
  // Escape at the pick: no try
  s.ui.quick.push(undefined);
  await s.commands.get('wasmViewer.compare')(U('new.wasm'));
  assert.equal(s.state.get('wasmViewer.proTrial').compare, 1);
  // git HEAD
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'old.wasm'), newer);
  s.ui.quick.push((items) => items.find((i) => i.v === 'head'));
  await s.commands.get('wasmViewer.compare')(U('old.wasm'));
  await tick(20);
  await s.log.panel.send({ type: 'shown' });
  const d2 = s.log.panel.posted.filter((m) => m.type === 'data').at(-1).data;
  assert.match(d2.old, /git HEAD/);
  assert.equal(d2.counts.added, 1);
  assert.equal(s.state.get('wasmViewer.proTrial').compare, 2);
  s.restore();
});

test('Pro source mapping: DWARF build maps functions; the viewer gets source lines; no debug info uses no try', async () => {
  const dir = tmp({ 'dw.wasm': fs.readFileSync(path.join(__dirname, 'fixtures', 'dwarf4.wasm')), 'src/demo/dw.c': fs.readFileSync(path.join(__dirname, 'fixtures', 'dw.c')), 'hello.wasm': sample('hello.wasm') });
  const s = activate(dir);
  const none = await s.commands.get('wasmViewer.sourceMap')(s.vscode.Uri.file(path.join(dir, 'hello.wasm')));
  void none;
  assert.match(s.log.info.at(-1).text, /no DWARF line table .* No free try was used/);
  assert.equal((s.state.get('wasmViewer.proTrial') || {}).sourcemap, undefined);
  const v = await openViewer(s, path.join(dir, 'dw.wasm'));
  await s.commands.get('wasmViewer.zovoPro.sourcemap')(s.vscode.Uri.file(path.join(dir, 'dw.wasm')));
  await tick(20);
  await s.log.panel.send({ type: 'shown' });
  const d = s.log.panel.posted.find((m) => m.type === 'data').data;
  assert.equal(d.kind, 'sourcemap');
  assert.equal(d.from, 'DWARF in the module');
  assert.deepEqual(d.files.map((f) => f.file), ['/src/demo/dw.c']);
  assert.ok(d.funcs.some((f) => f.name === 'sum' && f.line === 2 && f.endLine === 9));
  assert.equal(s.state.get('wasmViewer.proTrial').sourcemap, 1);
  assert.equal(v.last('srcChanged').src, true);
  const sum = d.funcs.find((f) => f.name === 'sum');
  const b = v.last('init').blocks.findIndex((x) => x.k === 'func' && x.i === sum.index);
  await v.panel.send({ type: 'getLines', bs: [b] });
  assert.ok(v.last('lines').items[0].src.includes('dw.c:7'));
  // the source file is found in the workspace by its path suffix
  await s.log.panel.send({ type: 'action', id: 'source', file: '/src/demo/dw.c', line: 7 });
  const opened = s.log.opened.at(-1);
  assert.ok((opened.document || opened).uri.fsPath.endsWith(path.join('src', 'demo', 'dw.c')));
  s.restore();
});

test('Pro panel gets the click surface: ctx from the Explorer wrapper, toolbar from the viewer row, none from the palette', async () => {
  const s = loadExtension();
  const { createPro } = require('../src/pro');
  const { runAs } = require('../src/reach');
  const seen = [];
  const lic = { isPro: () => false, requirePro: async (title, o) => { seen.push({ title, surface: o.surface }); return false; }, ready: Promise.resolve(), onDidChange: () => ({ dispose() {} }) };
  const pro = createPro({ vscode: s.vscode, context: s.context, license: lic });
  await s.context.globalState.update('wasmViewer.proTrial', { profile: 3, compare: 3, sourcemap: 3 });
  assert.equal(await runAs('ctx', () => pro.allowed('profile')), false);
  assert.equal(await runAs('toolbar', () => pro.allowed('compare')), false);
  assert.equal(await pro.allowed('sourcemap'), false);
  assert.deepEqual(seen, [{ title: 'Size profiler', surface: 'ctx' }, { title: 'Compare two builds', surface: 'toolbar' }, { title: 'Source mapping', surface: undefined }]);
  s.restore();
});

test('Pro tries never go down within a session, even when globalState returns an older value', async () => {
  const s = loadExtension();
  const { createPro } = require('../src/pro');
  const lic = { isPro: () => false, requirePro: async () => false, ready: Promise.resolve(), onDidChange: () => ({ dispose() {} }) };
  const pro = createPro({ vscode: s.vscode, context: s.context, license: lic });
  await pro.produced('profile');
  await pro.produced('profile');
  await s.context.globalState.update('wasmViewer.proTrial', { profile: 1 });
  assert.equal(pro.left('profile'), 1);
  await pro.produced('profile');
  assert.equal(pro.left('profile'), 0);
  assert.equal(await pro.allowed('profile'), false);
  s.restore();
});
