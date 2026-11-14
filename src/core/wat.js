'use strict';
// WAT (WebAssembly text format) printer for the module decoded by wasm.js. The layout follows the usual wasm2wat
// style: flat instructions, 2 spaces per block level, labels written as ";; label = @N" and branch targets as
// "(;@N;)". The module is cut into blocks (prelude, one block per function, data and element segments, the rest), so
// a viewer can print only the functions on screen and a 40 MB module stays fast. printModuleText() writes everything.
const { decodeLocals, sanitize, WasmError } = require('./wasm');

// ---------- numbers ----------

const f32buf = new DataView(new ArrayBuffer(4));
function f32Text(bits) {
  f32buf.setUint32(0, bits >>> 0, true);
  const v = f32buf.getFloat32(0, true);
  const sign = bits >>> 31 ? '-' : '';
  if (Number.isNaN(v)) {
    const payload = bits & 0x7fffff;
    return payload === 0x400000 ? `${sign}nan` : `${sign}nan:0x${payload.toString(16)}`;
  }
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  if (v === 0) return sign ? '-0' : '0';
  for (let p = 1; p <= 9; p++) {
    const s = v.toPrecision(p);
    if (Math.fround(Number(s)) === v) return tidy(s);
  }
  return tidy(String(v));
}
const f64buf = new DataView(new ArrayBuffer(8));
function f64Text(bytes) {
  for (let i = 0; i < 8; i++) f64buf.setUint8(i, bytes[i]);
  const v = f64buf.getFloat64(0, true);
  const hi = f64buf.getUint32(4, true), lo = f64buf.getUint32(0, true);
  const sign = hi >>> 31 ? '-' : '';
  if (Number.isNaN(v)) {
    const payload = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    return payload === 0x8000000000000n ? `${sign}nan` : `${sign}nan:0x${payload.toString(16)}`;
  }
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  if (v === 0) return sign ? '-0' : '0';
  return tidy(String(v));
}
// "1.50e+5" -> "1.50e+5" is fine for WAT; only make sure an integer-looking value keeps a plain form
function tidy(s) { return s.replace(/^(-?\d+)\.?e/, '$1e'); }

function hex(n, w) { return '0x' + (n >>> 0).toString(16).padStart(w, '0'); }
function v128Text(b) {
  const w = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  return `i32x4 ${hex(w(0), 8)} ${hex(w(4), 8)} ${hex(w(8), 8)} ${hex(w(12), 8)}`;
}

// WAT string: printable ASCII as is, everything else as \hh
function watString(bytes, from = 0, to = bytes.length) {
  let s = '"';
  for (let i = from; i < to; i++) {
    const c = bytes[i];
    if (c >= 0x20 && c < 0x7f && c !== 0x22 && c !== 0x5c) s += String.fromCharCode(c);
    else s += '\\' + (c < 16 ? '0' : '') + c.toString(16);
  }
  return s + '"';
}
function quote(str) { return watString(new TextEncoder().encode(str)); }

// ---------- names ----------

function makeCtx(mod, opts = {}) {
  const names = opts.names !== false;
  const ids = mod.ids || {};
  const ref = (map, i) => (names && map && map.has(i) ? '$' + map.get(i) : String(i));
  const def = (map, i) => (names && map && map.has(i) ? '$' + map.get(i) : `(;${i};)`);
  return {
    mod, names,
    func: (i) => ref(ids.funcs, i), funcDef: (i) => def(ids.funcs, i),
    type: (i) => ref(ids.types, i), typeDef: (i) => def(ids.types, i),
    table: (i) => ref(ids.tables, i), tableDef: (i) => def(ids.tables, i),
    memory: (i) => ref(ids.memories, i), memoryDef: (i) => def(ids.memories, i),
    global: (i) => ref(ids.globals, i), globalDef: (i) => def(ids.globals, i),
    elem: (i) => ref(ids.elems, i), elemDef: (i) => def(ids.elems, i),
    data: (i) => ref(ids.datas, i), dataDef: (i) => def(ids.datas, i),
    tag: (i) => ref(ids.tags, i), tagDef: (i) => def(ids.tags, i),
    heap: (h) => (typeof h === 'number' ? ref(ids.types, h) : h),
  };
}

function localIds(mod, fi, count, enabled) {
  const out = new Map();
  if (!enabled) return out;
  const m = mod.names.locals.get(fi);
  if (!m) return out;
  const used = new Set();
  for (const [i, raw] of [...m.entries()].sort((a, b) => a[0] - b[0])) {
    if (i >= count) continue;
    let id = sanitize(raw);
    if (!id) continue;
    if (used.has(id)) { let k = 1; while (used.has(`${id}.${k}`)) k++; id = `${id}.${k}`; }
    used.add(id);
    out.set(i, id);
  }
  return out;
}

// ---------- types ----------

function refTypeText(t, ctx) {
  // valType() already returns text; a (ref N) with a type index gets the type's $name when there is one
  if (!ctx.names) return t;
  return t.replace(/^\(ref (null )?(\d+)\)$/, (m, n, i) => `(ref ${n || ''}${ctx.type(Number(i))})`);
}
function vt(t, ctx) { return t.startsWith('(ref') ? refTypeText(t, ctx) : t; }
function vts(list, ctx) { return list.map((t) => vt(t, ctx)).join(' '); }
function fieldText(f, ctx) { return f.mut ? `(mut ${vt(f.type, ctx)})` : vt(f.type, ctx); }

function compTypeText(t, ctx) {
  let body;
  if (t.kind === 'func') {
    body = '(func' + (t.params.length ? ` (param ${vts(t.params, ctx)})` : '') + (t.results.length ? ` (result ${vts(t.results, ctx)})` : '') + ')';
  } else if (t.kind === 'struct') {
    body = '(struct' + t.fields.map((f) => ` (field ${fieldText(f, ctx)})`).join('') + ')';
  } else body = `(array ${fieldText(t.field, ctx)})`;
  if (t.sub) body = `(sub ${t.final ? 'final ' : ''}${t.supers.map((s) => ctx.type(s) + ' ').join('')}${body})`;
  return body;
}
function typeLine(mod, i, ctx) { return `(type ${ctx.typeDef(i)} ${compTypeText(mod.types[i], ctx)})`; }

/** " (type 3) (param i32) (result i32)" for a function type index, with param names when given. */
function sigText(mod, typeIdx, ctx, paramIds) {
  let s = ` (type ${ctx.type(typeIdx)})`;
  const t = mod.types[typeIdx];
  if (!t || t.kind !== 'func') return s;
  if (t.params.length) {
    if (paramIds && paramIds.size && t.params.some((_, i) => paramIds.has(i))) {
      s += t.params.map((p, i) => (paramIds.has(i) ? ` (param $${paramIds.get(i)} ${vt(p, ctx)})` : ` (param ${vt(p, ctx)})`)).join('');
    } else s += ` (param ${vts(t.params, ctx)})`;
  }
  if (t.results.length) s += ` (result ${vts(t.results, ctx)})`;
  return s;
}

function limitsText(l) {
  return `${l.is64 ? 'i64 ' : ''}${l.min}${l.max !== undefined ? ' ' + l.max : ''}${l.shared ? ' shared' : ''}`;
}

// ---------- instructions ----------

function blockTypeText(bt, ctx) {
  if (!bt) return '';
  if (bt.val) return ` (result ${vt(bt.val, ctx)})`;
  return ` (type ${ctx.type(bt.type)})`;
}
function memargText(m) {
  let s = m.mem ? ` ${m.mem}` : '';
  if (m.offset) s += ` offset=${m.offset}`;
  if (m.align !== m.natural) s += ` align=${m.align > 40 ? `2**${m.align}` : 2 ** m.align}`;
  return s;
}
function heapText(h, ctx) { return typeof h === 'number' ? ctx.type(h) : h; }
function castType(h, nullable, ctx) { return `(ref ${nullable ? 'null ' : ''}${heapText(h, ctx)})`; }

/**
 * Text of one instruction. `labels` is the stack of open block label numbers (for branch comments), `local` names
 * locals. Returns the text without indentation.
 */
function instrText(ins, ctx, labels, local) {
  const { op, a } = ins;
  const n = op.name;
  const lab = (l) => { const k = labels.length - 1 - l; return `${l} (;@${k >= 0 ? labels[k] : 0};)`; };
  switch (op.imm) {
    case '': return n;
    case 'bt': return n + blockTypeText(a, ctx);
    case 'l': return n === 'delegate' || n === 'rethrow' ? `${n} ${a}` : `${n} ${lab(a)}`;
    case 'brt': return `${n} ${a.map(lab).join(' ')}`;
    case 'f': return `${n} ${ctx.func(a)}`;
    case 'ci': return `${n}${a[1] ? ' ' + ctx.table(a[1]) : ''} (type ${ctx.type(a[0])})`;
    case 't': return `${n} ${ctx.type(a)}`;
    case 'lo': return `${n} ${local(a)}`;
    case 'g': return `${n} ${ctx.global(a)}`;
    case 'tb': return `${n} ${ctx.table(a)}`;
    case 'tag': return `${n} ${ctx.tag(a)}`;
    case 'd': return `${n} ${ctx.data(a)}`;
    case 'e': return `${n} ${ctx.elem(a)}`;
    case 'm': return n + memargText(a);
    case 'mi': return a ? `${n} ${ctx.memory(a)}` : n;
    case 'i32': return `${n} ${a}`;
    case 'i64': return `${n} ${a.toString()}`;
    case 'f32': return `${n} ${f32Text(a)}`;
    case 'f64': return `${n} ${f64Text(a)}`;
    case 'ht': return `${n} ${heapText(a, ctx)}`;
    case 'sel': return `${n} (result ${vts(a, ctx)})`;
    case 'tt': {
      const k = ['catch', 'catch_ref', 'catch_all', 'catch_all_ref'];
      return n + blockTypeText(a.bt, ctx) + a.catches.map((c) => ` (${k[c.k]}${c.k < 2 ? ' ' + ctx.tag(c.tag) : ''} ${c.l})`).join('');
    }
    case 'v128': return `${n} ${v128Text(a)}`;
    case 'shuf': return `${n} ${Array.from(a).join(' ')}`;
    case 'lane': return `${n} ${a}`;
    case 'ml': return `${n}${memargText(a)} ${a.lane}`;
    case 'md': return a[1] ? `${n} ${ctx.memory(a[1])} ${ctx.data(a[0])}` : `${n} ${ctx.data(a[0])}`;
    case 'mm': return a[0] || a[1] ? `${n} ${ctx.memory(a[0])} ${ctx.memory(a[1])}` : n;
    case 'et': return a[1] ? `${n} ${ctx.table(a[1])} ${ctx.elem(a[0])}` : `${n} ${ctx.elem(a[0])}`;
    case 'tt2': return a[0] || a[1] ? `${n} ${ctx.table(a[0])} ${ctx.table(a[1])}` : n;
    case 'fence': return n;
    case 'tf': return `${n} ${ctx.type(a[0])} ${a[1]}`;
    case 'tn': return `${n} ${ctx.type(a[0])} ${a[1]}`;
    case 'td': return `${n} ${ctx.type(a[0])} ${ctx.data(a[1])}`;
    case 'te': return `${n} ${ctx.type(a[0])} ${ctx.elem(a[1])}`;
    case 't2': return `${n} ${ctx.type(a[0])} ${ctx.type(a[1])}`;
    case 'rt': return `${n} ${castType(a, false, ctx)}`;
    case 'rtn': return `${n} ${castType(a, true, ctx)}`;
    case 'boc': return `${n} ${lab(a.l)} ${castType(a.h1, !!(a.flags & 1), ctx)} ${castType(a.h2, !!(a.flags & 2), ctx)}`;
    default: return n;
  }
}

/** A constant expression: "(i32.const 1)" for one instruction, else the instructions in order. */
function constExprText(list, ctx, wrap = '') {
  const parts = list.map((ins) => instrText(ins, ctx, [], (i) => String(i)));
  if (wrap) return `(${wrap} ${parts.join(' ')})`;
  if (parts.length === 1) return `(${parts[0]})`;
  return parts.join(' ');
}

// ---------- functions ----------

const OPENS = new Set(['block', 'loop', 'if', 'try', 'try_table']);
const MIDDLE = new Set(['else', 'catch', 'catch_all']);

/** The header line of a defined or imported function, without the leading 2-space indent. */
function funcHeader(mod, i, ctx, paramIds) {
  const f = mod.funcs[i];
  return `(func ${ctx.funcDef(i)}${sigText(mod, f.type, ctx, paramIds)}`;
}

/**
 * Prints one defined function. Returns { lines, offsets } where offsets[k] is the byte offset of the instruction on
 * line k (-1 for the header and locals). A decoding error ends the text with a ";; error" line, never a throw.
 */
function printFunction(mod, i, opts = {}) {
  const ctx = opts.ctx || makeCtx(mod, opts);
  const f = mod.funcs[i];
  const lines = [];
  const offsets = [];
  const push = (s, o) => { lines.push(s); offsets.push(o); };
  const t = mod.types[f.type];
  const nParams = t && t.kind === 'func' ? t.params.length : 0;
  let decoded;
  try { decoded = decodeLocals(mod, i); } catch (e) {
    push(`  ${funcHeader(mod, i, ctx)}`, -1);
    push(`    ;; error at 0x${(e.offset || 0).toString(16)}: ${e.message}`, e.offset || -1);
    lines[lines.length - 1] += ')';
    return { lines, offsets, error: e };
  }
  const ids = localIds(mod, i, nParams + decoded.localCount, ctx.names);
  const paramIds = new Map([...ids].filter(([k]) => k < nParams));
  push(`  ${funcHeader(mod, i, ctx, paramIds)}`, f.body.offset);
  if (decoded.locals.length) {
    let k = nParams;
    const flat = [];
    for (const l of decoded.locals) for (let j = 0; j < l.count; j++) flat.push([k++, l.type]);
    if (flat.some(([idx]) => ids.has(idx))) {
      push('    ' + flat.map(([idx, ty]) => (ids.has(idx) ? `(local $${ids.get(idx)} ${vt(ty, ctx)})` : `(local ${vt(ty, ctx)})`)).join(' '), -1);
    } else if (flat.length) {
      push(`    (local ${flat.map(([, ty]) => vt(ty, ctx)).join(' ')})`, -1);
    }
  }
  const local = (x) => (ids.has(x) ? '$' + ids.get(x) : String(x));
  const r = decoded.reader;
  const labels = [];
  let error = null;
  const max = opts.maxLines || Infinity;
  try {
    for (;;) {
      if (r.eof()) throw new WasmError('the function body ends without its final "end"', r.pos);
      const ins = r.instr();
      const name = ins.op.name;
      if (name === 'end' || name === 'delegate') {
        if (!labels.length) {
          if (name === 'delegate') throw new WasmError('"delegate" outside a try block', ins.o);
          if (!r.eof()) throw new WasmError(`${r.end - r.pos} bytes after the final "end" of the function`, r.pos);
          break;
        }
        labels.pop();
        push(' '.repeat(4 + labels.length * 2) + instrText(ins, ctx, labels, local), ins.o);
      } else if (MIDDLE.has(name)) {
        push(' '.repeat(4 + (labels.length - 1) * 2) + instrText(ins, ctx, labels, local), ins.o);
      } else if (OPENS.has(name)) {
        const n = labels.length + 1; // wasm2wat numbers labels by nesting depth
        push(' '.repeat(4 + labels.length * 2) + instrText(ins, ctx, labels, local) + `  ;; label = @${n}`, ins.o);
        labels.push(n);
      } else {
        push(' '.repeat(4 + labels.length * 2) + instrText(ins, ctx, labels, local), ins.o);
      }
      if (lines.length >= max) { push(`    ;; ... the rest of this function is not shown (more than ${max} lines)`, -1); break; }
    }
  } catch (e) {
    if (!(e instanceof WasmError)) throw e;
    error = e;
    push(`    ;; error at 0x${(e.offset || 0).toString(16)}: ${e.message}`, e.offset || -1);
  }
  lines[lines.length - 1] += ')';
  return { lines, offsets, error };
}

// ---------- module layout ----------

function importLine(mod, imp, ctx) {
  const head = `(import ${quote(imp.module)} ${quote(imp.field)} `;
  switch (imp.kind) {
    case 'func': return `${head}(func ${ctx.funcDef(imp.index)}${sigText(mod, imp.type, ctx)}))`;
    case 'table': return `${head}(table ${ctx.tableDef(imp.index)} ${limitsText(imp.limits)} ${vt(imp.reftype, ctx)}))`;
    case 'memory': return `${head}(memory ${ctx.memoryDef(imp.index)} ${limitsText(imp.limits)}))`;
    case 'global': return `${head}(global ${ctx.globalDef(imp.index)} ${imp.mutable ? `(mut ${vt(imp.valtype, ctx)})` : vt(imp.valtype, ctx)}))`;
    case 'tag': return `${head}(tag ${ctx.tagDef(imp.index)}${sigText(mod, imp.type, ctx)}))`;
    default: return `;; unknown import kind`;
  }
}

const KIND_REF = { func: 'func', table: 'table', memory: 'memory', global: 'global', tag: 'tag' };
function exportLine(e, ctx) {
  const idx = ({ func: ctx.func, table: ctx.table, memory: ctx.memory, global: ctx.global, tag: ctx.tag }[e.kind] || String)(e.index);
  return `(export ${quote(e.name)} (${KIND_REF[e.kind]} ${idx}))`;
}

function elemLines(mod, i, ctx, perLine = 16) {
  const e = mod.elems[i];
  let head = `(elem ${ctx.elemDef(i)}`;
  if (e.mode === 'declarative') head += ' declare';
  if (e.mode === 'active') {
    if (e.table || (e.flags & 2)) head += ` (table ${ctx.table(e.table)})`;
    head += ' ' + constExprText(e.offsetExpr, ctx, e.offsetExpr.length === 1 ? '' : 'offset');
  }
  const items = e.funcs ? e.funcs.map((f) => ctx.func(f)) : e.exprs.map((x) => constExprText(x, ctx, 'item'));
  head += e.funcs ? ' func' : ` ${vt(e.type, ctx)}`;
  if (items.length <= perLine) return [`  ${head}${items.length ? ' ' + items.join(' ') : ''})`];
  const out = [`  ${head}`];
  for (let k = 0; k < items.length; k += perLine) out.push('    ' + items.slice(k, k + perLine).join(' '));
  out[out.length - 1] += ')';
  return out;
}

function dataHead(mod, i, ctx) {
  const d = mod.datas[i];
  let head = `(data ${ctx.dataDef(i)}`;
  if (d.mode === 'active') {
    if (d.memory) head += ` (memory ${ctx.memory(d.memory)})`;
    head += ' ' + constExprText(d.offsetExpr, ctx, d.offsetExpr.length === 1 ? '' : 'offset');
  }
  return head;
}
function dataLines(mod, i, ctx, perLine = 32, maxBytes = Infinity) {
  const d = mod.datas[i];
  const head = dataHead(mod, i, ctx);
  const b = mod.bytes;
  if (d.size <= perLine) return [`  ${head} ${watString(b, d.start, d.end)})`];
  const out = [`  ${head}`];
  const stop = Math.min(d.end, d.start + maxBytes);
  for (let k = d.start; k < stop; k += perLine) out.push('    ' + watString(b, k, Math.min(stop, k + perLine)));
  if (stop < d.end) out.push(`    ;; ${d.end - stop} more bytes are not shown here`);
  out[out.length - 1] += ')';
  return out;
}

function tableLine(mod, i, ctx) {
  const t = mod.tables[i];
  return `  (table ${ctx.tableDef(i)} ${limitsText(t.limits)} ${vt(t.reftype, ctx)}${t.init ? ' ' + constExprText(t.init, ctx) : ''})`;
}
function globalLine(mod, i, ctx) {
  const g = mod.globals[i];
  const ty = g.mutable ? `(mut ${vt(g.type, ctx)})` : vt(g.type, ctx);
  return `  (global ${ctx.globalDef(i)} ${ty} ${constExprText(g.init, ctx)})`;
}

/**
 * The module as a list of blocks: { kind, index, lines? (fixed), print? () => {lines, offsets} (functions and long
 * data or element segments, printed on demand), size (bytes in the binary), title }.
 */
function layout(mod, opts = {}) {
  const ctx = opts.ctx || makeCtx(mod, opts);
  const blocks = [];
  const fixed = (kind, lines, extra = {}) => blocks.push({ kind, lines, ...extra });
  fixed('module', [`(module${ctx.names && mod.ids && mod.names.module ? ' $' + sanitize(mod.names.module) : ''}`]);
  // types, with rec groups
  const inRec = new Set();
  for (let i = 0; i < mod.types.length; i++) {
    const t = mod.types[i];
    if (t.rec) {
      if (inRec.has(t.rec)) continue;
      inRec.add(t.rec);
      const ls = ['  (rec'];
      for (let k = 0; k < t.rec.count; k++) ls.push('    ' + typeLine(mod, t.rec.first + k, ctx));
      ls[ls.length - 1] += ')';
      fixed('type', ls, { index: i });
    } else fixed('type', ['  ' + typeLine(mod, i, ctx)], { index: i });
  }
  for (const imp of mod.imports) fixed('import', ['  ' + importLine(mod, imp, ctx)], { index: imp.index, importKind: imp.kind });
  for (let i = mod.importCounts.func; i < mod.funcs.length; i++) {
    const f = mod.funcs[i];
    if (!f.body) continue;
    blocks.push({ kind: 'func', index: i, size: f.body.size, offset: f.body.offset, header: '  ' + funcHeader(mod, i, ctx), print: () => printFunction(mod, i, { ctx, maxLines: opts.maxLines }) });
  }
  for (let i = mod.importCounts.table; i < mod.tables.length; i++) fixed('table', [tableLine(mod, i, ctx)], { index: i });
  for (let i = mod.importCounts.memory; i < mod.memories.length; i++) fixed('memory', [`  (memory ${ctx.memoryDef(i)} ${limitsText(mod.memories[i].limits)})`], { index: i });
  for (let i = mod.importCounts.tag; i < mod.tags.length; i++) fixed('tag', [`  (tag ${ctx.tagDef(i)}${sigText(mod, mod.tags[i].type, ctx)})`], { index: i });
  for (let i = mod.importCounts.global; i < mod.globals.length; i++) fixed('global', [globalLine(mod, i, ctx)], { index: i });
  for (const e of mod.exports) fixed('export', ['  ' + exportLine(e, ctx)], { index: e.index, exportKind: e.kind, name: e.name });
  if (mod.start !== undefined) fixed('start', [`  (start ${ctx.func(mod.start)})`]);
  for (let i = 0; i < mod.elems.length; i++) {
    const ls = elemLines(mod, i, ctx);
    if (ls.length > 4) blocks.push({ kind: 'elem', index: i, size: mod.elems[i].end - mod.elems[i].offset, header: ls[0], print: () => ({ lines: elemLines(mod, i, ctx), offsets: [] }) });
    else fixed('elem', ls, { index: i });
  }
  for (let i = 0; i < mod.datas.length; i++) {
    const d = mod.datas[i];
    if (d.size > 64) blocks.push({ kind: 'data', index: i, size: d.size, header: '  ' + dataHead(mod, i, ctx), print: () => ({ lines: dataLines(mod, i, ctx, 32, opts.maxDataBytes || Infinity), offsets: [] }) });
    else fixed('data', dataLines(mod, i, ctx), { index: i });
  }
  fixed('end', [')']);
  return blocks;
}

/** The whole module as WAT text, written through write(chunk) one block at a time (for large modules). */
function writeModuleText(mod, write, opts = {}) {
  const blocks = layout(mod, opts);
  for (const b of blocks) {
    const ls = b.lines || b.print().lines;
    write(ls.join('\n') + '\n');
  }
}
function printModuleText(mod, opts = {}) {
  const parts = [];
  writeModuleText(mod, (s) => parts.push(s), opts);
  return parts.join('');
}

module.exports = {
  makeCtx, printFunction, layout, printModuleText, writeModuleText, instrText, f32Text, f64Text, watString, quote,
  compTypeText, sigText, funcHeader, limitsText, constExprText, v128Text,
};
