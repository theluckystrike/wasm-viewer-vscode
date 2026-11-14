'use strict';
// WebAssembly binary decoder (own code, written from the specification). parseModule() reads the module structure
// (types, imports, functions, tables, memories, tags, globals, exports, start, elements, data, custom sections and
// the name section) without decoding function bodies, so a 40 MB module opens in well under a second. Function
// bodies are decoded on demand by decodeBody() / Reader.instr(). No dependency, no network, no vscode.
const { ONE, PREFIX, VALTYPE, HEAPTYPE, REF_SHORT, SECTION, EXTERN_KIND } = require('./ops');

class WasmError extends Error {
  constructor(message, offset) { super(message); this.offset = offset; }
}

const td = new TextDecoder('utf-8', { fatal: false });

class Reader {
  constructor(bytes, pos = 0, end = bytes.length) {
    this.b = bytes; this.pos = pos; this.end = end;
  }
  fail(msg, at) { throw new WasmError(msg, at === undefined ? this.pos : at); }
  eof() { return this.pos >= this.end; }
  u8() { if (this.pos >= this.end) this.fail('unexpected end of data'); return this.b[this.pos++]; }
  peek() { if (this.pos >= this.end) this.fail('unexpected end of data'); return this.b[this.pos]; }
  u32() {
    let result = 0, shift = 0, byte;
    const start = this.pos;
    do {
      if (this.pos >= this.end) this.fail('unexpected end of data in a LEB128 number', start);
      byte = this.b[this.pos++];
      if (shift === 28 && (byte & 0x70) !== 0) this.fail('LEB128 number does not fit in 32 bits', start);
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 35) this.fail('LEB128 number is too long', start);
    } while (byte & 0x80);
    return result;
  }
  s32() {
    let result = 0, shift = 0, byte;
    const start = this.pos;
    do {
      if (this.pos >= this.end) this.fail('unexpected end of data in a LEB128 number', start);
      byte = this.b[this.pos++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if (shift > 35) this.fail('LEB128 number is too long', start);
    } while (byte & 0x80);
    if (shift < 32 && (byte & 0x40)) result |= (-1 << shift);
    return result | 0;
  }
  s33() { // block types and heap types: a signed 33-bit number; the non-negative ones are type indices
    let result = 0n, shift = 0n, byte;
    const start = this.pos;
    do {
      if (this.pos >= this.end) this.fail('unexpected end of data in a LEB128 number', start);
      byte = this.b[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if (shift > 35n) this.fail('LEB128 number is too long', start);
    } while (byte & 0x80);
    if (byte & 0x40) result -= 1n << shift;
    return Number(result);
  }
  s64() {
    let result = 0n, shift = 0n, byte;
    const start = this.pos;
    do {
      if (this.pos >= this.end) this.fail('unexpected end of data in a LEB128 number', start);
      byte = this.b[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if (shift > 70n) this.fail('LEB128 number is too long', start);
    } while (byte & 0x80);
    if (byte & 0x40) result -= 1n << shift;
    return BigInt.asIntN(64, result);
  }
  u64() { // as a Number when it fits, otherwise a BigInt
    let result = 0n, shift = 0n, byte;
    const start = this.pos;
    do {
      if (this.pos >= this.end) this.fail('unexpected end of data in a LEB128 number', start);
      byte = this.b[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if (shift > 70n) this.fail('LEB128 number is too long', start);
    } while (byte & 0x80);
    result = BigInt.asUintN(64, result);
    return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result;
  }
  bytes(n) {
    if (n > this.end - this.pos) this.fail(`a length of ${n} bytes runs past the end of the section`);
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  name() { const n = this.u32(); return td.decode(this.bytes(n)); }
  f32bits() { const v = this.bytes(4); return (v[0] | (v[1] << 8) | (v[2] << 16) | (v[3] << 24)) >>> 0; }
  f64bits() { const v = this.bytes(8); return new Uint8Array(v); }

  heapType() {
    const b = this.peek();
    if (HEAPTYPE[b]) { this.pos++; return HEAPTYPE[b]; }
    const v = this.s33();
    if (v < 0) this.fail(`unknown heap type ${v}`);
    return v;
  }
  /** A value type as WAT text: i32, funcref, (ref null 3), (ref func) ... */
  valType() {
    const at = this.pos;
    const b = this.u8();
    if (VALTYPE[b]) return VALTYPE[b];
    if (HEAPTYPE[b]) return REF_SHORT[HEAPTYPE[b]];
    if (b === 0x63 || b === 0x64) return refText(this.heapType(), b === 0x63);
    return this.fail(`unknown value type 0x${b.toString(16)}`, at);
  }
  storageType() {
    const b = this.peek();
    if (b === 0x78) { this.pos++; return 'i8'; }
    if (b === 0x77) { this.pos++; return 'i16'; }
    return this.valType();
  }
  blockType() {
    const b = this.peek();
    if (b === 0x40) { this.pos++; return null; }
    if (VALTYPE[b] || HEAPTYPE[b] || b === 0x63 || b === 0x64) return { val: this.valType() };
    const v = this.s33();
    if (v < 0) this.fail(`unknown block type ${v}`);
    return { type: v };
  }
  limits(kind) {
    const at = this.pos;
    const flags = this.u8();
    if (flags > 7) this.fail(`unknown ${kind} limits flag 0x${flags.toString(16)}`, at);
    const is64 = !!(flags & 4);
    const min = is64 ? this.u64() : this.u32();
    const max = flags & 1 ? (is64 ? this.u64() : this.u32()) : undefined;
    return { min, max, shared: !!(flags & 2), is64 };
  }
  memarg(natural) {
    let align = this.u32();
    let mem = 0;
    if (align & 0x40) { align &= ~0x40; mem = this.u32(); }
    const offset = this.u64();
    return { align, offset, mem, natural };
  }
  /** Reads one instruction. Returns { o (offset), op (def), a (immediates) }. */
  instr() {
    const o = this.pos;
    const b = this.u8();
    let def;
    if (PREFIX[b]) {
      const sub = this.u32();
      def = PREFIX[b][sub];
      if (!def) this.fail(`unknown instruction 0x${b.toString(16)} ${sub}`, o);
    } else {
      def = ONE[b];
      if (!def) this.fail(`unknown instruction 0x${b.toString(16).padStart(2, '0')}`, o);
    }
    let a;
    switch (def.imm) {
      case '': break;
      case 'bt': a = this.blockType(); break;
      case 'l': case 'f': case 't': case 'lo': case 'g': case 'tb': case 'tag': case 'd': case 'e': a = this.u32(); break;
      case 'brt': { const n = this.u32(); if (n > this.end - this.pos) this.fail('br_table is longer than its function'); const ls = new Array(n + 1); for (let i = 0; i <= n; i++) ls[i] = this.u32(); a = ls; break; }
      case 'ci': a = [this.u32(), this.u32()]; break;
      case 'm': a = this.memarg(def.align); break;
      case 'mi': a = this.u32(); break;
      case 'i32': a = this.s32(); break;
      case 'i64': a = this.s64(); break;
      case 'f32': a = this.f32bits(); break;
      case 'f64': a = this.f64bits(); break;
      case 'ht': case 'rt': case 'rtn': a = this.heapType(); break;
      case 'sel': { const n = this.u32(); a = []; for (let i = 0; i < n; i++) a.push(this.valType()); break; }
      case 'tt': {
        const bt = this.blockType();
        const n = this.u32();
        const catches = [];
        for (let i = 0; i < n; i++) {
          const k = this.u8();
          if (k > 3) this.fail(`unknown catch kind ${k}`);
          const tag = k < 2 ? this.u32() : undefined;
          catches.push({ k, tag, l: this.u32() });
        }
        a = { bt, catches };
        break;
      }
      case 'v128': case 'shuf': a = new Uint8Array(this.bytes(16)); break;
      case 'lane': a = this.u8(); break;
      case 'ml': a = this.memarg(def.align); a.lane = this.u8(); break;
      case 'md': a = [this.u32(), this.u32()]; break; // data, memory
      case 'mm': a = [this.u32(), this.u32()]; break;
      case 'et': a = [this.u32(), this.u32()]; break; // elem, table
      case 'tt2': a = [this.u32(), this.u32()]; break;
      case 'fence': a = this.u8(); break;
      case 'tf': case 'tn': case 'td': case 'te': case 't2': a = [this.u32(), this.u32()]; break;
      case 'boc': { const flags = this.u8(); const l = this.u32(); a = { flags, l, h1: this.heapType(), h2: this.heapType() }; break; }
      default: this.fail(`internal: immediate kind ${def.imm}`, o);
    }
    return { o, op: def, a };
  }
  /** A constant expression (global init, segment offset, element item) up to and including its end. */
  constExpr() {
    const out = [];
    for (;;) {
      const ins = this.instr();
      if (ins.op.name === 'end') return out;
      out.push(ins);
      if (out.length > 100000) this.fail('constant expression is too long');
    }
  }
}

function refText(ht, nullable) {
  if (typeof ht === 'string' && nullable) return REF_SHORT[ht];
  return `(ref ${nullable ? 'null ' : ''}${ht})`;
}

function readType(r) {
  const at = r.pos;
  const form = r.u8();
  if (form === 0x60) {
    const np = r.u32(); const params = []; for (let i = 0; i < np; i++) params.push(r.valType());
    const nr = r.u32(); const results = []; for (let i = 0; i < nr; i++) results.push(r.valType());
    return { kind: 'func', params, results };
  }
  if (form === 0x5f) {
    const n = r.u32(); const fields = [];
    for (let i = 0; i < n; i++) { const t = r.storageType(); const m = r.u8(); fields.push({ type: t, mut: m === 1 }); }
    return { kind: 'struct', fields };
  }
  if (form === 0x5e) { const t = r.storageType(); const m = r.u8(); return { kind: 'array', field: { type: t, mut: m === 1 } }; }
  if (form === 0x50 || form === 0x4f) {
    const n = r.u32(); const supers = []; for (let i = 0; i < n; i++) supers.push(r.u32());
    const t = readType(r);
    if (t.sub) r.fail('nested sub type', at);
    return Object.assign(t, { sub: true, final: form === 0x4f, supers });
  }
  return r.fail(`unknown type form 0x${form.toString(16)}`, at);
}

const SECTION_ORDER = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 13: 6, 6: 7, 7: 8, 8: 9, 9: 10, 12: 11, 10: 12, 11: 13 };

/**
 * Parses a module. Never throws for damaged input past the header: problems go to mod.errors with their offset, and
 * the rest of the file is still read where the section sizes allow it.
 */
function parseModule(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const mod = {
    size: bytes.length, bytes, version: 0, sections: [], types: [], recGroups: [], imports: [], funcs: [], tables: [],
    memories: [], globals: [], exports: [], start: undefined, elems: [], datas: [], tags: [], customs: [],
    dataCount: undefined, names: emptyNames(), errors: [], producers: null, targetFeatures: null, sourceMappingURL: '',
    importCounts: { func: 0, table: 0, memory: 0, global: 0, tag: 0 }, codeCount: 0,
  };
  if (bytes.length < 8) throw new WasmError('This file is too short to be a WebAssembly module (fewer than 8 bytes).', 0);
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new WasmError('This is not a WebAssembly binary: it does not start with the bytes 00 61 73 6D ("\\0asm").', 0);
  }
  const ver = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  mod.version = ver >>> 0;
  if (mod.version !== 1) {
    if ((mod.version & 0xffff) === 0x0d && (mod.version >>> 16) === 1) {
      throw new WasmError('This is a WebAssembly component (component model, layer 1), not a core module. Components are not supported yet.', 4);
    }
    throw new WasmError(`Unknown WebAssembly version ${mod.version}. Version 1 is the one in use.`, 4);
  }
  const r = new Reader(bytes, 8);
  let lastOrder = 0;
  const funcTypes = [];
  while (!r.eof()) {
    const at = r.pos;
    let id, size;
    try { id = r.u8(); size = r.u32(); } catch (e) { mod.errors.push({ offset: at, message: 'damaged section header: ' + e.message }); break; }
    const start = r.pos;
    const end = start + size;
    const sec = { id, kind: SECTION[id] || `unknown (${id})`, offset: at, start, end: Math.min(end, bytes.length), size, headerSize: start - at };
    mod.sections.push(sec);
    if (end > bytes.length) { mod.errors.push({ offset: at, message: `the ${sec.kind} section says it is ${size} bytes long, but the file ends ${end - bytes.length} bytes earlier (truncated file?)` }); }
    if (id !== 0) {
      const ord = SECTION_ORDER[id];
      if (!ord) mod.errors.push({ offset: at, message: `unknown section id ${id}` });
      else if (ord <= lastOrder) mod.errors.push({ offset: at, message: `the ${sec.kind} section is out of order or appears twice` });
      else lastOrder = ord;
    }
    const sr = new Reader(bytes, start, Math.min(end, bytes.length));
    try {
      readSection(mod, sec, sr, funcTypes);
      if (id !== 0 && sr.pos !== sr.end && SECTION[id]) mod.errors.push({ offset: sr.pos, message: `the ${sec.kind} section has ${sr.end - sr.pos} unread bytes at its end` });
    } catch (e) {
      if (!(e instanceof WasmError)) throw e;
      mod.errors.push({ offset: e.offset, message: `${sec.kind} section: ${e.message}` });
    }
    r.pos = Math.min(end, bytes.length);
  }
  // functions: imported first, then defined
  const defined = funcTypes.length;
  if (mod.codeCount !== defined && !(defined === 0 && mod.codeCount === 0)) {
    mod.errors.push({ offset: 0, message: `the function section declares ${defined} functions but the code section has ${mod.codeCount} bodies` });
  }
  for (let i = 0; i < mod.funcs.length; i++) mod.funcs[i].index = i;
  finishNames(mod);
  return mod;
}

function emptyNames() {
  return { module: '', funcs: new Map(), locals: new Map(), labels: new Map(), types: new Map(), tables: new Map(), memories: new Map(), globals: new Map(), elems: new Map(), datas: new Map(), fields: new Map(), tags: new Map() };
}

function readSection(mod, sec, r, funcTypes) {
  switch (sec.id) {
    case 0: return readCustom(mod, sec, r);
    case 1: {
      const n = r.u32();
      for (let i = 0; i < n; i++) {
        if (r.peek() === 0x4e) {
          r.u8();
          const m = r.u32();
          const group = { first: mod.types.length, count: m };
          mod.recGroups.push(group);
          for (let j = 0; j < m; j++) mod.types.push(Object.assign(readType(r), { rec: group }));
        } else mod.types.push(readType(r));
      }
      return undefined;
    }
    case 2: {
      const n = r.u32();
      for (let i = 0; i < n; i++) {
        const at = r.pos;
        const module = r.name(); const field = r.name(); const kind = r.u8();
        const imp = { module, field, kind: EXTERN_KIND[kind], offset: at };
        if (kind === 0) { imp.type = r.u32(); imp.index = mod.funcs.length; mod.funcs.push({ imported: imp, type: imp.type }); }
        else if (kind === 1) { imp.reftype = r.valType(); imp.limits = r.limits('table'); imp.index = mod.tables.length; mod.tables.push({ imported: imp, reftype: imp.reftype, limits: imp.limits }); }
        else if (kind === 2) { imp.limits = r.limits('memory'); imp.index = mod.memories.length; mod.memories.push({ imported: imp, limits: imp.limits }); }
        else if (kind === 3) { imp.valtype = r.valType(); imp.mutable = r.u8() === 1; imp.index = mod.globals.length; mod.globals.push({ imported: imp, type: imp.valtype, mutable: imp.mutable }); }
        else if (kind === 4) { r.u8(); imp.type = r.u32(); imp.index = mod.tags.length; mod.tags.push({ imported: imp, type: imp.type }); }
        else r.fail(`unknown import kind ${kind}`, at);
        mod.importCounts[imp.kind]++;
        mod.imports.push(imp);
      }
      return undefined;
    }
    case 3: {
      const n = r.u32();
      for (let i = 0; i < n; i++) { const t = r.u32(); funcTypes.push(t); mod.funcs.push({ type: t, body: null }); }
      return undefined;
    }
    case 4: {
      const n = r.u32();
      for (let i = 0; i < n; i++) {
        let init = null;
        if (r.peek() === 0x40) { r.u8(); if (r.u8() !== 0) r.fail('table with an init expression: reserved byte is not 0'); const reftype = r.valType(); const limits = r.limits('table'); init = r.constExpr(); mod.tables.push({ reftype, limits, init }); continue; }
        const reftype = r.valType();
        mod.tables.push({ reftype, limits: r.limits('table'), init });
      }
      return undefined;
    }
    case 5: { const n = r.u32(); for (let i = 0; i < n; i++) mod.memories.push({ limits: r.limits('memory') }); return undefined; }
    case 13: { const n = r.u32(); for (let i = 0; i < n; i++) { r.u8(); mod.tags.push({ type: r.u32() }); } return undefined; }
    case 6: {
      const n = r.u32();
      for (let i = 0; i < n; i++) { const type = r.valType(); const mutable = r.u8() === 1; mod.globals.push({ type, mutable, init: r.constExpr() }); }
      return undefined;
    }
    case 7: {
      const n = r.u32();
      for (let i = 0; i < n; i++) {
        const at = r.pos;
        const name = r.name(); const k = r.u8();
        if (!EXTERN_KIND[k]) r.fail(`unknown export kind ${k}`, at);
        mod.exports.push({ name, kind: EXTERN_KIND[k], index: r.u32(), offset: at });
      }
      return undefined;
    }
    case 8: mod.start = r.u32(); return undefined;
    case 9: {
      const n = r.u32();
      for (let i = 0; i < n; i++) mod.elems.push(readElem(r));
      return undefined;
    }
    case 12: mod.dataCount = r.u32(); return undefined;
    case 10: {
      const n = r.u32();
      const first = mod.importCounts.func;
      mod.codeCount = n;
      for (let i = 0; i < n; i++) {
        const at = r.pos;
        const size = r.u32();
        const start = r.pos;
        if (size > r.end - start) r.fail(`function body ${i} is ${size} bytes but only ${r.end - start} remain`, at);
        const f = mod.funcs[first + i];
        if (f) f.body = { offset: at, start, end: start + size, size: start + size - at };
        else mod.errors.push({ offset: at, message: `code section body ${i} has no matching entry in the function section` });
        r.pos = start + size;
      }
      return undefined;
    }
    case 11: {
      const n = r.u32();
      for (let i = 0; i < n; i++) {
        const at = r.pos;
        const flags = r.u32();
        const d = { offset: at, mode: 'active', memory: 0, offsetExpr: null };
        if (flags === 1) d.mode = 'passive';
        else if (flags === 0 || flags === 2) { if (flags === 2) d.memory = r.u32(); d.offsetExpr = r.constExpr(); }
        else r.fail(`unknown data segment flags ${flags}`, at);
        const len = r.u32();
        d.start = r.pos; d.size = len;
        r.bytes(len);
        d.end = r.pos;
        mod.datas.push(d);
      }
      return undefined;
    }
    default: return undefined;
  }
}

function readElem(r) {
  const at = r.pos;
  const flags = r.u32();
  if (flags > 7) r.fail(`unknown element segment flags ${flags}`, at);
  const e = { offset: at, flags, mode: 'active', table: 0, offsetExpr: null, type: 'funcref', funcs: null, exprs: null };
  if (flags & 1) e.mode = flags & 2 ? 'declarative' : 'passive';
  else { if (flags & 2) e.table = r.u32(); e.offsetExpr = r.constExpr(); }
  const exprs = !!(flags & 4);
  if (flags & 3) { if (exprs) e.type = r.valType(); else { const k = r.u8(); if (k !== 0) r.fail(`unknown element kind ${k}`); } }
  const n = r.u32();
  if (n > r.end - r.pos) r.fail('element segment is longer than its section');
  if (exprs) { e.exprs = []; for (let i = 0; i < n; i++) e.exprs.push(r.constExpr()); }
  else { e.funcs = new Array(n); for (let i = 0; i < n; i++) e.funcs[i] = r.u32(); }
  e.end = r.pos;
  return e;
}

function readCustom(mod, sec, r) {
  const name = r.name();
  const c = { name, offset: sec.offset, start: r.pos, end: sec.end, size: sec.end - sec.offset };
  sec.customName = name;
  mod.customs.push(c);
  try {
    if (name === 'name') readNames(mod, r);
    else if (name === 'producers') {
      const n = r.u32(); const out = {};
      for (let i = 0; i < n; i++) { const field = r.name(); const m = r.u32(); out[field] = []; for (let j = 0; j < m; j++) out[field].push({ name: r.name(), version: r.name() }); }
      mod.producers = out;
    } else if (name === 'target_features') {
      const n = r.u32(); const out = [];
      for (let i = 0; i < n; i++) { const p = String.fromCharCode(r.u8()); out.push({ prefix: p, name: r.name() }); }
      mod.targetFeatures = out;
    } else if (name === 'sourceMappingURL') mod.sourceMappingURL = r.name();
    else if (name === 'external_debug_info') mod.externalDebugInfo = r.name();
  } catch (e) {
    if (!(e instanceof WasmError)) throw e;
    mod.errors.push({ offset: e.offset, message: `custom section "${name}" is damaged: ${e.message}`, soft: true });
  }
  r.pos = r.end;
}

function readNameMap(r, map) {
  const n = r.u32();
  for (let i = 0; i < n; i++) { const idx = r.u32(); map.set(idx, r.name()); }
}
function readIndirect(r, map) {
  const n = r.u32();
  for (let i = 0; i < n; i++) { const idx = r.u32(); const m = new Map(); readNameMap(r, m); map.set(idx, m); }
}

function readNames(mod, r) {
  const N = mod.names;
  while (!r.eof()) {
    const id = r.u8(); const size = r.u32();
    const sub = new Reader(r.b, r.pos, Math.min(r.pos + size, r.end));
    switch (id) {
      case 0: N.module = sub.name(); break;
      case 1: readNameMap(sub, N.funcs); break;
      case 2: readIndirect(sub, N.locals); break;
      case 3: readIndirect(sub, N.labels); break;
      case 4: readNameMap(sub, N.types); break;
      case 5: readNameMap(sub, N.tables); break;
      case 6: readNameMap(sub, N.memories); break;
      case 7: readNameMap(sub, N.globals); break;
      case 8: readNameMap(sub, N.elems); break;
      case 9: readNameMap(sub, N.datas); break;
      case 10: readIndirect(sub, N.fields); break;
      case 11: readNameMap(sub, N.tags); break;
      default: break;
    }
    r.pos += size;
  }
}

// WAT identifiers: $ followed by idchars. Other characters become "_" (as wabt does), and repeats get .1, .2 ...
const IDCHAR = /[^0-9A-Za-z!#$%&'*+\-./:<=>?@\\^_`|~]/g;
function sanitize(name) { return name.replace(IDCHAR, '_'); }
function uniqueIds(map, count) {
  const out = new Map();
  const used = new Set();
  for (const [i, raw] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
    if (i >= count) continue;
    let id = sanitize(raw);
    if (!id) continue;
    if (used.has(id)) { let k = 1; while (used.has(`${id}.${k}`)) k++; id = `${id}.${k}`; }
    used.add(id);
    out.set(i, id);
  }
  return out;
}

function finishNames(mod) {
  const N = mod.names;
  mod.ids = {
    funcs: uniqueIds(N.funcs, mod.funcs.length), types: uniqueIds(N.types, mod.types.length),
    tables: uniqueIds(N.tables, mod.tables.length), memories: uniqueIds(N.memories, mod.memories.length),
    globals: uniqueIds(N.globals, mod.globals.length), elems: uniqueIds(N.elems, mod.elems.length),
    datas: uniqueIds(N.datas, mod.datas.length), tags: uniqueIds(N.tags, mod.tags.length),
  };
  // export names help to name functions that have no name section entry (shown in the overview, not in the WAT)
  mod.exportOf = new Map();
  for (const e of mod.exports) {
    const k = `${e.kind}:${e.index}`;
    if (!mod.exportOf.has(k)) mod.exportOf.set(k, []);
    mod.exportOf.get(k).push(e.name);
  }
}

/** Display name for a function: name section, else first export name, else func[i]. */
function funcLabel(mod, i) {
  const n = mod.names.funcs.get(i);
  if (n) return n;
  const ex = mod.exportOf.get(`func:${i}`);
  if (ex) return ex[0];
  const f = mod.funcs[i];
  if (f && f.imported) return `${f.imported.module}.${f.imported.field}`;
  return `func[${i}]`;
}

function funcType(mod, i) {
  const f = mod.funcs[i];
  const t = f ? mod.types[f.type] : null;
  return t && t.kind === 'func' ? t : null;
}

/** Decodes a function body: { locals: [{count, type}], localCount, start (first instruction offset) }. */
function decodeLocals(mod, i) {
  const f = mod.funcs[i];
  if (!f || !f.body) throw new WasmError(`function ${i} has no body`, 0);
  const r = new Reader(mod.bytes, f.body.start, f.body.end);
  const n = r.u32();
  const locals = [];
  let total = 0;
  for (let k = 0; k < n; k++) {
    const count = r.u32(); const type = r.valType();
    total += count;
    if (total > 50000) r.fail(`function ${i} declares more than 50,000 locals`);
    locals.push({ count, type });
  }
  return { locals, localCount: total, start: r.pos, reader: r };
}

/** Iterates every instruction of a function body (up to and including the final end). */
function* instructions(mod, i) {
  const { reader } = decodeLocals(mod, i);
  while (!reader.eof()) yield reader.instr();
}

module.exports = { parseModule, Reader, WasmError, decodeLocals, instructions, funcLabel, funcType, sanitize, refText };
