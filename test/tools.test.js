'use strict';
// The viewer model, WAT text helpers, WAT to WASM, and the cores of the three Pro tools (profile, compare, DWARF and
// source maps), without VS Code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseModule } = require('../src/core/wasm');
const { WasmModel, CHUNK } = require('../src/model');
const T = require('../src/core/watText');
const { watToWasm, validateWasm, validateInWorker, parseErrors } = require('../src/convert');
const P = require('../src/core/profile');
const C = require('../src/core/compare');
const D = require('../src/core/dwarf');

const ROOT = path.join(__dirname, '..');
const hello = () => fs.readFileSync(path.join(ROOT, 'samples', 'hello.wasm'));
const REAL = process.env.WASM_REAL_SAMPLES || '/Users/mike/plugin-market-intel-work/newb7-work/wasm/samples/real';

async function build(wat) { const r = await watToWasm(wat, 't.wat'); assert.ok(r.ok, JSON.stringify(r.errors)); return r.bytes; }

test('model: small modules open unfolded with line counts; large ones folded; long export runs are chunked', () => {
  const m = new WasmModel(new Uint8Array(hello()));
  assert.equal(m.eager, true);
  const blocks = m.webviewBlocks();
  const fns = blocks.filter((b) => b.k === 'func');
  assert.equal(fns.length, 7);
  assert.ok(fns.every((b) => b.fold === 0 && b.n > 1 && b.lazy));
  const fac = fns.find((b) => b.ex === 'factorial');
  assert.equal(m.lines(m.funcBlock.get(fac.i)).lines[0], '  (func $factorial (type 1) (param $n i64) (result i64)');
  assert.equal(m.sigs()[1], ' (type 1) (param i64) (result i64)');
  assert.equal(m.funcIds()[2], '$fib');
  const big = new WasmModel(new Uint8Array(hello()), { eagerBytes: 0 });
  assert.ok(big.webviewBlocks().filter((b) => b.k === 'func').every((b) => b.fold === 1 && b.n === undefined));
  // 1200 exports become chunks of CHUNK lines, sent on demand
  const many = ['(module'];
  for (let i = 0; i < 1200; i++) many.push(`(func (export "f${i}") (result i32) (i32.const ${i}))`);
  return build(many.join('\n') + ')').then((bytes) => {
    const mm = new WasmModel(new Uint8Array(bytes), { eagerBytes: 0 });
    const ex = mm.webviewBlocks().filter((b) => b.k === 'export');
    assert.equal(ex.length, Math.ceil(1200 / CHUNK));
    assert.ok(ex.every((b) => (b.lines ? b.lines.length <= 300 : b.n === CHUNK)));
    assert.equal(ex.filter((b) => !b.lines).length, 2);
    assert.equal(mm.lines(mm.blocks.indexOf(mm.blocks.find((b) => b.kind === 'export'))).lines.length, CHUNK);
    const ov = mm.overview('many.wasm');
    assert.equal(ov.exportsTotal, 1200);
    assert.equal(mm.filterList('exports', 'f119').total, 11); // f119, f1190..f1199
  });
});

test('model: overview lists sections, imports, exports, memories, globals, names and features', () => {
  const ov = new WasmModel(new Uint8Array(hello())).overview('hello.wasm');
  assert.equal(ov.counts.funcs, 7);
  assert.equal(ov.counts.importFuncs, 1);
  assert.deepEqual(ov.imports[0], { module: 'env', field: 'log', kind: 'func', index: 0, desc: '(type 0) (param i32 i32)' });
  assert.ok(ov.exports.some((e) => e.name === 'fib' && e.kind === 'func' && e.index === 2));
  assert.equal(ov.memories[0].min, 1);
  assert.deepEqual(ov.memories[0].exports, ['memory']);
  assert.equal(ov.globals[0].init, '(i32.const 0)');
  assert.equal(ov.globals[0].mutable, true);
  assert.equal(ov.names.module, 'hello');
  assert.equal(ov.names.funcs, 8);
  assert.ok(ov.sections.some((s) => s.name === 'custom "name"'));
  assert.ok(ov.features.includes('SIMD'));
});

test('model: find in all code searches folded functions too, and stops on cancel', async () => {
  const m = new WasmModel(new Uint8Array(hello()), { eagerBytes: 0 });
  const r = await m.search('call $fib');
  assert.equal(r.hits.length, 2);
  assert.ok(r.hits.every((h) => h.func === 2));
  const re = await m.search('i(32|64)\\.mul', { regex: true });
  assert.equal(re.hits.length, 2);
  const stopped = await m.search('local', { token: { cancelled: true } });
  assert.equal(stopped.stopped, true);
  assert.match(m.text(), /^\(module \$hello\n/);
});

test('WAT text: outline symbols and fold ranges skip strings and comments', () => {
  const src = fs.readFileSync(path.join(ROOT, 'samples', 'hello.wat'), 'utf8');
  const sym = T.symbols(src);
  const names = sym.map((s) => s.name);
  for (const n of ['env.log', '$mem', '$calls', '$greeting', '$ops', '$factorial', '$fib', '$apply', '$greet']) assert.ok(names.includes(n), n);
  const fac = sym.find((s) => s.name === '$factorial');
  assert.match(fac.detail, /export "factorial"/);
  assert.ok(fac.endLine > fac.line + 5);
  const folds = T.foldingRanges(src);
  assert.ok(folds.some(([a]) => a === fac.line));
  const tricky = '(module\n  (data "a ) ( ;; b")\n  (; block ( comment ;)\n  (func $x\n    nop))\n';
  assert.deepEqual(T.symbols(tricky).map((s) => [s.name, s.line, s.endLine]), [['data 0', 1, 1], ['$x', 3, 4]]);
  const flat = '(module\n  (func\n    block\n      nop\n    end))';
  assert.ok(T.foldingRanges(flat).some(([a, b]) => a === 2 && b === 4));
});

test('WAT to WASM: errors carry line, column and token length; a valid file compiles with its names', async () => {
  const bad = await watToWasm('(module\n  (func (result i32)\n    i64.const 1))\n', 'bad.wat');
  assert.equal(bad.ok, false);
  assert.equal(bad.stage, 'validate');
  assert.equal(bad.errors[0].line, 3);
  assert.match(bad.errors[0].message, /type mismatch/);
  const syn = await watToWasm('(module\n  (fnc))', 'syn.wat');
  assert.deepEqual([syn.stage, syn.errors[0].line, syn.errors[0].col, syn.errors[0].length], ['parse', 2, 4, 3]);
  const ok = await watToWasm(fs.readFileSync(path.join(ROOT, 'samples', 'hello.wat'), 'utf8'), 'hello.wat');
  assert.ok(ok.ok);
  assert.ok(Buffer.compare(ok.bytes, hello()) === 0, 'samples/hello.wasm is the compiled samples/hello.wat');
  assert.deepEqual(parseErrors('<binary>:0000f19: error: memories may not be shared\n'), [{ offset: 0xf19, line: 0, col: 0, severity: 'error', message: 'memories may not be shared' }]);
});

test('validate: a valid module passes, a broken one names the problem (in a worker thread)', async () => {
  assert.deepEqual(await validateWasm(new Uint8Array(hello())), { ok: true, errors: [] });
  // function body says i32.add on an empty stack
  const bytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 10, 5, 1, 3, 0, 106, 11]);
  const r = await validateInWorker(bytes);
  assert.equal(r.ok, false);
  assert.match(r.errors.map((e) => e.message).join(' '), /type mismatch|expected/);
});

test('profile: sizes, roots, retained size from the dominator tree, unreachable code, keep-alive chain', async () => {
  const bytes = await build(`(module
    (func $main (export "main") (call $a) (call $b))
    (func $a (call $shared) (call $onlyA))
    (func $b (call $shared))
    (func $shared nop)
    (func $onlyA (call $deep))
    (func $deep (drop (i32.add (i32.const 1) (i32.const 2))) (drop (i32.const 3)))
    (func $dead (call $deep))
    (func $viaTable nop)
    (table 1 funcref) (elem (i32.const 0) $viaTable))`);
  const m = parseModule(bytes);
  const p = P.profile(m);
  const byName = (n) => [...p.functions, ...p.unreachable.top].find((f) => f.name === n);
  assert.equal(p.file.roots, 2);
  assert.equal(p.unreachable.count, 1);
  assert.equal(p.unreachable.top[0].name, 'dead');
  const a = byName('a'); const onlyA = byName('onlyA'); const deep = byName('deep'); const shared = byName('shared');
  assert.equal(a.retained, a.size + onlyA.size + deep.size, 'a keeps onlyA and deep alive, but not shared');
  assert.equal(byName('main').retained, ['main', 'a', 'b', 'shared', 'onlyA', 'deep'].reduce((s, n) => s + byName(n).size, 0));
  assert.equal(shared.callers, 2);
  const k = P.keepAlive(m, p.graph, deep.index);
  assert.deepEqual(k.chain.map((c) => c.name), ['main', 'a', 'onlyA', 'deep']);
  assert.deepEqual(k.chainRoot, ['export "main"']);
  assert.equal(k.dominator.name, 'onlyA');
  assert.ok(k.callers.some((c) => c.name === 'dead'));
  assert.deepEqual(P.keepAlive(m, p.graph, byName('viaTable').index).root, ['table element (elem 0)']);
  const md = P.markdown(p, 't.wasm');
  assert.match(md, /^# WebAssembly size profile: t\.wasm/);
  assert.match(md, /\| Section \| Size \| Share \|/);
  assert.match(md, /1 functions \(\d+ B\) are not reachable/);
});

test('profile: groups by crate, namespace and Go package', () => {
  assert.equal(P.groupOf('core::fmt::write::h0123456789abcdef'), 'core');
  assert.equal(P.groupOf('_ZN4core3fmt5write17h0123456789abcdefE'), 'core');
  assert.equal(P.groupOf('orig$_ZN6duckdb6Binder4BindERNS_9StatementE'), 'duckdb');
  assert.equal(P.groupOf('_ZNK5arrow6Scalar6CastToEv'), 'arrow');
  assert.equal(P.groupOf('github.com/acme/tool/internal/pdf.render'), 'github.com/acme/tool/internal/pdf');
  assert.equal(P.groupOf('(*encoding/json.Decoder).Decode'), 'encoding/json');
  assert.equal(P.groupOf('runtime.alloc'), 'runtime');
  assert.equal(P.groupOf('sqlite3_open'), '(no namespace)');
});

test('compare: added, removed, grown and shrunk by name, hash suffixes ignored, Markdown table', async () => {
  const oldB = await build('(module (func $_ZN3app4main17h0000000000000001E (export "main") (call $grow)) (func $grow nop) (func $gone nop) (func $same (drop (i32.const 1))))');
  const newB = await build('(module (func $_ZN3app4main17h00000000000000ffE (export "main") (call $grow)) (func $grow (drop (i32.const 1)) (drop (i32.const 2))) (func $same (drop (i32.const 1))) (func $added (drop (i32.const 9))) (memory 1))');
  const r = C.compare(parseModule(oldB), parseModule(newB));
  assert.equal(r.match, 'name');
  assert.deepEqual(r.counts, { added: 1, removed: 1, grown: 1, shrunk: 0, same: 2 });
  assert.ok(r.funcs.some((f) => f.kind === 'added' && f.name === 'added'));
  assert.ok(r.funcs.some((f) => f.kind === 'removed' && f.name === 'gone'));
  assert.ok(!r.funcs.some((f) => /main/.test(f.name)), 'main matched across the hash change');
  assert.equal(r.total.delta, newB.length - oldB.length);
  assert.ok(r.sections.some((s) => s.name === 'memory' && s.old === 0 && s.new > 0));
  const md = C.markdown(r, 'main', 'pr');
  assert.match(md, /^### WebAssembly size: pr/);
  assert.match(md, /\| Section \| Old \| New \| Change \|/);
  assert.match(md, /\| \*\*Total\*\* \|/);
  assert.match(md, /1 added .*1 removed .*1 grown/);
  // no names: by export, then index, and the note says so
  const a = parseModule(await build('(module (func (export "x") nop) (func nop))'));
  const b = parseModule(await build('(module (func (export "x") nop nop) (func nop))'));
  const r2 = C.compare(a, b);
  assert.equal(r2.match, 'index');
  assert.match(r2.matchNote, /export name, then by index/);
  assert.equal(r2.counts.grown, 1);
});

test('DWARF: line tables of clang builds (DWARF 4 and 5) map each function to its source line', () => {
  for (const v of [4, 5]) {
    const m = parseModule(fs.readFileSync(path.join(__dirname, 'fixtures', `dwarf${v}.wasm`)));
    const t = D.lineTable(m);
    assert.deepEqual(t.versions, [v]);
    assert.deepEqual(t.files, ['/src/demo/dw.c']);
    assert.equal(t.units[0].compDir, '/src/demo');
    assert.equal(t.units[0].name, 'dw.c');
    assert.equal(t.rows.addr.length, 15); // llvm-dwarfdump --debug-line lists 15 rows
    const ix = D.dwarfIndex(m);
    const at = (name) => { const i = [...m.exportOf.entries()].find(([, n]) => n.includes(name))[0].split(':')[1]; const b = m.funcs[Number(i)].body; return ix.range(b.start, b.end); };
    assert.deepEqual(at('add').first, { file: '/src/demo/dw.c', line: 2, col: 12 });
    assert.deepEqual(at('sum').first, { file: '/src/demo/dw.c', line: 7, col: 21 });
    assert.deepEqual([at('sum').span.get('/src/demo/dw.c').min, at('sum').span.get('/src/demo/dw.c').max], [2, 9]);
  }
});

test('DWARF: a large Emscripten debug build matches llvm-dwarfdump row for row (skipped without the sample)', { skip: !fs.existsSync(path.join(REAL, 'web-tree-sitter-debug.wasm')) && 'real samples not on this machine' }, () => {
  const m = parseModule(fs.readFileSync(path.join(REAL, 'web-tree-sitter-debug.wasm')));
  const t = D.lineTable(m);
  assert.equal(t.rows.addr.length, 20792);
  assert.equal(t.units.length, 74);
  assert.ok(t.files.includes('/src/lib/src/subtree.c'));
  const ix = D.dwarfIndex(m);
  const i = [...m.names.funcs.entries()].find(([, n]) => n === 'ts_subtree_external_scanner_state')[0];
  assert.deepEqual(ix.range(m.funcs[i].body.start, m.funcs[i].body.end).first, { file: '/src/lib/src/subtree.c', line: 1074, col: 0 });
});

test('source maps: v3 mappings with byte offsets as columns', () => {
  // offsets 10 -> a.c:3:1, 20 -> a.c:4:5, 30 -> b.c:1:1, 40 -> no source
  const vlq = (n) => { let v = n < 0 ? (-n << 1) | 1 : n << 1; let s = ''; do { let d = v & 31; v >>>= 5; if (v) d |= 32; s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[d]; } while (v); return s; };
  const seg = (...xs) => xs.map(vlq).join('');
  const mappings = [seg(10, 0, 2, 0), seg(10, 0, 1, 4), seg(10, 1, -3, -4), seg(10)].join(',');
  const ix = D.sourceMapIndex(JSON.stringify({ version: 3, sources: ['src/a.c', 'src/b.c'], sourceRoot: '/work', mappings }));
  assert.deepEqual(ix.lookup(12), { file: '/work/src/a.c', line: 3, col: 1 });
  assert.deepEqual(ix.lookup(25), { file: '/work/src/a.c', line: 4, col: 5 });
  assert.deepEqual(ix.lookup(30), { file: '/work/src/b.c', line: 1, col: 1 });
  assert.equal(ix.lookup(41), null);
  assert.equal(ix.lookup(5), null);
  assert.throws(() => D.sourceMapIndex('{"version":3}'), /not a source map/);
});

test('model: source lines show where they change once a source index is set', () => {
  const m = new WasmModel(new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'dwarf4.wasm'))));
  m.setSource(D.dwarfIndex(m.mod));
  const b = [...m.funcBlock.entries()].find(([i]) => m.mod.exportOf.get(`func:${i}`)?.includes('sum'))[1];
  const r = m.lines(b);
  assert.ok(r.src.includes('dw.c:7'));
  assert.ok(r.src.includes('dw.c:8'));
  assert.equal(r.src.filter((s) => s === 'dw.c:7').length >= 1, true);
});
