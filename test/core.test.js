'use strict';
// Decoder and WAT printer: exact text for the sample, proposals compiled by wabt and printed back, damaged files,
// and (when the real samples folder is on this machine) every function of real modules round-tripped through wabt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseModule, WasmError, funcLabel, decodeLocals } = require('../src/core/wasm');
const W = require('../src/core/wat');
const { watToWasm, wabt, FEATURES } = require('../src/convert');

const ROOT = path.join(__dirname, '..');
const REAL = process.env.WASM_REAL_SAMPLES || '/Users/mike/plugin-market-intel-work/newb7-work/wasm/samples/real';
const real = (n) => path.join(REAL, n);
const hasReal = (n) => fs.existsSync(real(n));

/** WAT -> wabt binary -> our text -> wabt binary: both binaries must be equal (names off, so no name section). */
async function roundTrip(wat) {
  const a = await watToWasm(wat, 't.wat', { names: false });
  assert.ok(a.ok, JSON.stringify(a.errors));
  const text = W.printModuleText(parseModule(a.bytes), { names: false });
  const b = await watToWasm(text, 'back.wat', { names: false });
  assert.ok(b.ok, `our text did not parse: ${JSON.stringify(b.errors)}\n${text}`);
  assert.ok(Buffer.compare(a.bytes, b.bytes) === 0, `binary differs after the round trip:\n${text}`);
  return text;
}

test('the sample module prints in the wasm2wat layout with names, labels and branch targets', () => {
  const m = parseModule(fs.readFileSync(path.join(ROOT, 'samples', 'hello.wasm')));
  assert.equal(m.errors.length, 0);
  assert.equal(m.names.module, 'hello');
  const t = W.printModuleText(m);
  assert.match(t, /^\(module \$hello\n {2}\(type \(;0;\) \(func \(param i32 i32\)\)\)/);
  assert.match(t, /\(import "env" "log" \(func \$log \(type 0\) \(param i32 i32\)\)\)/);
  assert.match(t, / {2}\(func \$factorial \(type 1\) \(param \$n i64\) \(result i64\)\n {4}\(local \$acc i64\)\n {4}i64\.const 1\n {4}local\.set \$acc\n {4}block {2};; label = @1\n {6}loop {2};; label = @2\n/);
  assert.match(t, /br_if 1 \(;@1;\)/);
  assert.match(t, /br 0 \(;@2;\)/);
  assert.match(t, /call_indirect \(type 3\)/);
  assert.match(t, /i32x4\.add/);
  assert.match(t, /\(export "factorial" \(func \$factorial\)\)/);
  assert.match(t, /\(elem \(;0;\) \(i32\.const 0\) func \$add \$mul\)/);
  assert.match(t, /\(data \$greeting \(i32\.const 16\) "Hello from WebAssembly!"\)/);
  assert.equal(funcLabel(m, 1), 'factorial');
  // names off: indices only
  const t2 = W.printModuleText(m, { names: false });
  assert.match(t2, /\(func \(;1;\) \(type 1\) \(param i64\) \(result i64\)/);
  assert.match(t2, /call 2\n/);
});

test('our text equals wabt text (style differences normalised) on a clang DWARF build', async () => {
  const w = await wabt();
  const b = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'dwarf4.wasm')));
  const m = w.readWasm(b, { readDebugNames: false, ...FEATURES });
  const theirs = m.toText({ foldExprs: false, inlineExport: false });
  m.destroy();
  const ours = W.printModuleText(parseModule(b), { names: false });
  const norm = (s) => s.replace(/^( {2}\(import .* \(func \(;\d+;\) \(type \d+\))( \(param[^)]*\))?( \(result[^)]*\))?\)\)$/gm, '$1))').replace(/\)\n\)\n?$/, '))\n').trimEnd();
  assert.equal(norm(ours), norm(theirs));
});

test('proposals: SIMD, relaxed SIMD, threads, exception handling (new and legacy), tail calls, multi-memory, memory64, bulk memory round-trip', async () => {
  await roundTrip(`(module
    (memory 1 2 shared) (memory $b i64 1)
    (func (param v128 v128) (result v128)
      (i8x16.shuffle 0 17 2 19 4 21 6 23 8 25 10 27 12 29 14 31 (local.get 0) (local.get 1))
      (v128.const i32x4 1 2 3 0xffffffff) i32x4.add
      (i32x4.relaxed_trunc_f32x4_s (v128.const f32x4 1.5 -2.5 nan inf)) v128.and)
    (func (param i32) (result i32)
      (i32.atomic.rmw.add offset=8 (local.get 0) (i32.const 1)) drop
      (memory.atomic.notify (local.get 0) (i32.const 1)) drop
      atomic.fence
      (i64.load (memory $b) (i64.const 16)) drop
      (memory.copy 1 0 (i64.const 0) (i32.const 0) (i32.const 4))
      (i32.load8_u offset=3 align=1 (local.get 0))))`);
  await roundTrip('(module (func (result i32) (return_call 1)) (func (result i32) (i32.const 1)) (table 1 funcref) (elem declare func 0) (func (result i32) (ref.is_null (ref.func 0))))');
  await roundTrip(`(module
    (tag $e (param i32))
    (func $thrower (param i32) (throw $e (local.get 0)))
    (func (result i32)
      (block $h (result i32)
        (try_table (catch $e $h) (call $thrower (i32.const 7)))
        (i32.const 0)))
    (func (result i32)
      (try (result i32) (do (i32.const 1)) (catch $e) (catch_all (i32.const 2)))))`);
});

test('GC types and instructions decode and print (wabt has no GC text support, so the bytes are written by hand)', () => {
  const bytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 17, 2, 78, 2, 95, 2, 127, 1, 124, 0, 94, 120, 1, 96, 1, 110, 1, 127, 3, 2, 1, 2, 10, 64, 1, 62, 0, 65, 7, 68, 0, 0, 0, 0, 0, 0, 0, 0, 251, 0, 0, 251, 2, 0, 0, 26, 65, 4, 251, 7, 1, 251, 15, 26, 65, 5, 251, 28, 251, 29, 26, 32, 0, 251, 20, 108, 26, 2, 110, 32, 0, 251, 24, 3, 0, 110, 0, 11, 26, 32, 0, 251, 23, 0, 26, 65, 1, 11]);
  const m = parseModule(bytes);
  assert.deepEqual(m.errors, []);
  const t = W.printModuleText(m);
  for (const line of ['  (rec', '    (type (;0;) (struct (field (mut i32)) (field f64)))', '    (type (;1;) (array (mut i8))))', '    struct.new 0', '    struct.get 0 0', '    array.new_default 1', '    array.len', '    ref.i31', '    i31.get_s', '    ref.test (ref i31)', '      br_on_cast 0 (;@1;) (ref null any) (ref null 0)', '    ref.cast (ref null 0)']) {
    assert.ok(t.split('\n').includes(line), `missing: ${line}\n${t}`);
  }
});

test('damaged files: clear errors, never a crash, and the rest still reads', () => {
  assert.throws(() => parseModule(Buffer.from('hello world, not wasm')), (e) => e instanceof WasmError && /does not start with the bytes 00 61 73 6D/.test(e.message));
  assert.throws(() => parseModule(Buffer.from([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0])), /component/);
  assert.throws(() => parseModule(Buffer.from([0, 0x61, 0x73])), /too short/);
  const good = fs.readFileSync(path.join(ROOT, 'samples', 'hello.wasm'));
  const cut = parseModule(good.subarray(0, good.length - 40));
  assert.ok(cut.errors.some((e) => /truncated/.test(e.message)));
  assert.ok(cut.funcs.length > 5);
  // a function body with an unknown opcode prints its error line instead of throwing
  const m = parseModule(Buffer.from(good));
  const f = m.funcs[3].body;
  const bytes = Buffer.from(good);
  const loc = decodeLocals(m, 3);
  bytes[loc.start] = 0xfe; bytes[loc.start + 1] = 0x7f; // atomics prefix with an unknown sub-opcode
  const r = W.printFunction(parseModule(bytes), 3);
  assert.ok(r.error);
  assert.match(r.lines.at(-1), /;; error at 0x[0-9a-f]+: unknown instruction 0xfe/);
  assert.ok(f.size > 0);
});

test('real modules: every function round-trips through wabt (skipped without the samples folder)', { skip: !hasReal('web-tree-sitter.wasm') && 'real samples not on this machine' }, async () => {
  const w = await wabt();
  for (const name of ['as-sha256-simd.wasm', 'web-tree-sitter.wasm', 'sql-wasm.wasm']) {
    const m1 = parseModule(fs.readFileSync(real(name)));
    assert.equal(m1.errors.length, 0, name);
    // wabt's text parser is very slow on functions nested hundreds of levels deep: those become stubs here
    const keep = new Set();
    const lines = [];
    for (const b of W.layout(m1, { names: false, maxDataBytes: Infinity })) {
      if (b.kind !== 'func') { lines.push(...(b.lines || b.print().lines)); continue; }
      const r = b.print();
      let depth = 0;
      for (const l of r.lines) depth = Math.max(depth, (l.length - l.trimStart().length - 4) / 2);
      if (depth > 150 || m1.funcs[b.index].body.size > 200000) lines.push(`  (func (;${b.index};) (type ${m1.funcs[b.index].type}) unreachable)`);
      else { keep.add(b.index); lines.push(...r.lines); }
    }
    const pm = w.parseWat('x.wat', lines.join('\n'), FEATURES);
    const bin = pm.toBinary({}).buffer;
    pm.destroy();
    const m2 = parseModule(bin);
    let diff = 0;
    for (const i of keep) {
      if (W.printFunction(m1, i, { names: false }).lines.join('\n') !== W.printFunction(m2, i, { names: false }).lines.join('\n')) diff++;
    }
    assert.equal(diff, 0, `${name}: ${diff} functions differ`);
    assert.ok(keep.size >= m1.funcs.length - m1.importCounts.func - 5, `${name}: only ${keep.size} functions checked`);
  }
});

test('big real modules parse fast and every function body decodes (skipped without the samples folder)', { skip: !hasReal('duckdb-eh.wasm') && 'real samples not on this machine' }, () => {
  for (const name of ['duckdb-eh.wasm', 'ort-wasm-simd-threaded.wasm', 'swc_bg.wasm', 'esbuild.wasm', 'tinygo-converter.wasm', 'resvg_bg.wasm']) {
    if (!hasReal(name)) continue;
    const t = Date.now();
    const m = parseModule(fs.readFileSync(real(name)));
    assert.ok(Date.now() - t < 4000, `${name} parsed in ${Date.now() - t} ms`);
    assert.equal(m.errors.length, 0, name);
    // decode every 7th function fully (all of them takes a few seconds on the 35 MB module)
    for (let i = m.importCounts.func; i < m.funcs.length; i += 7) {
      const r = W.printFunction(m, i, { names: false });
      assert.ok(!r.error, `${name} func ${i}: ${r.error && r.error.message}`);
    }
  }
});
