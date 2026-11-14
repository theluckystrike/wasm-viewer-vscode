'use strict';
// Source locations for a WebAssembly module (own code, written from the DWARF 2 to 5 and Source Map v3 specs):
// - DWARF: the .debug_line line programs, with each compile unit's name and directory from .debug_info and
//   .debug_abbrev. In WebAssembly, DWARF addresses are offsets from the start of the code section's contents.
// - Source maps: the "mappings" of a v3 source map, where the generated column is the byte offset in the .wasm file.
// Both give a table of rows (file offset, file, line, column) and lookup(offset). Only line tables: variables, types,
// inlined frames and location lists are not read.
const td = new TextDecoder('utf-8', { fatal: false });

class Buf {
  constructor(b, pos, end) { this.b = b; this.pos = pos; this.end = end; }
  need(n) { if (this.pos + n > this.end) throw new Error('DWARF data ends early'); }
  u8() { this.need(1); return this.b[this.pos++]; }
  u16() { this.need(2); const v = this.b[this.pos] | (this.b[this.pos + 1] << 8); this.pos += 2; return v; }
  u32() { this.need(4); const p = this.pos; this.pos += 4; return (this.b[p] | (this.b[p + 1] << 8) | (this.b[p + 2] << 16)) + this.b[p + 3] * 0x1000000; }
  u64() { const lo = this.u32(); const hi = this.u32(); return hi * 0x100000000 + lo; }
  uN(n) { if (n === 1) return this.u8(); if (n === 2) return this.u16(); if (n === 4) return this.u32(); if (n === 8) return this.u64(); this.pos += n; return 0; }
  uleb() { let r = 0; let s = 0; let b; do { b = this.u8(); r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; }
  sleb() { let r = 0; let s = 0; let b; do { b = this.u8(); r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); if (b & 0x40) r -= 2 ** s; return r; }
  cstr() { const s = this.pos; while (this.pos < this.end && this.b[this.pos] !== 0) this.pos++; const v = td.decode(this.b.subarray(s, this.pos)); this.pos++; return v; }
  skip(n) { this.need(n); this.pos += n; }
}

function sectionView(mod, name) {
  const c = mod.customs.find((x) => x.name === name);
  return c ? { b: mod.bytes, start: c.start, end: c.end } : null;
}
function strAt(sec, off) {
  if (!sec || off < 0 || sec.start + off >= sec.end) return '';
  let e = sec.start + off;
  while (e < sec.end && sec.b[e] !== 0) e++;
  return td.decode(sec.b.subarray(sec.start + off, e));
}

const joinPath = (dir, name) => {
  if (!dir || /^([/\\]|[A-Za-z]:[/\\])/.test(name)) return name;
  return dir.replace(/[/\\]+$/, '') + '/' + name;
};
/** "lib/src/./x.c" -> "lib/src/x.c", "a/b/../c" -> "a/c" (purely textual). */
function normalize(p) {
  const abs = p.startsWith('/');
  const out = [];
  for (const part of p.split(/[/\\]+/)) {
    if (!part || part === '.') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop(); else out.push(part);
  }
  const drive = /^[A-Za-z]:$/.test(out[0] || '');
  return (abs && !drive ? '/' : '') + out.join('/');
}

// ---------- .debug_info: compile unit name, comp_dir and stmt_list ----------

function readAbbrevs(sec, off) {
  const r = new Buf(sec.b, sec.start + off, sec.end);
  const map = new Map();
  for (;;) {
    const code = r.uleb();
    if (!code) break;
    const tag = r.uleb();
    const children = r.u8();
    const attrs = [];
    for (;;) {
      const at = r.uleb(); const form = r.uleb();
      if (!at && !form) break;
      attrs.push({ at, form, implicit: form === 0x21 ? r.sleb() : undefined });
    }
    map.set(code, { tag, children, attrs });
  }
  return map;
}

/** Reads one attribute value; returns a number, a string, or undefined for forms we skip. */
function readForm(r, form, ctx) {
  switch (form) {
    case 0x01: return r.uN(ctx.addrSize);
    case 0x03: r.skip(r.u16()); return undefined;
    case 0x04: r.skip(r.u32()); return undefined;
    case 0x05: return r.u16();
    case 0x06: return r.u32();
    case 0x07: return r.u64();
    case 0x08: return r.cstr();
    case 0x09: case 0x18: r.skip(r.uleb()); return undefined;
    case 0x0a: r.skip(r.u8()); return undefined;
    case 0x0b: return r.u8();
    case 0x0c: return r.u8();
    case 0x0d: return r.sleb();
    case 0x0e: { const o = ctx.offSize === 8 ? r.u64() : r.u32(); return strAt(ctx.str, o); }
    case 0x0f: return r.uleb();
    case 0x10: return ctx.version <= 2 ? r.uN(ctx.addrSize) : (ctx.offSize === 8 ? r.u64() : r.u32());
    case 0x11: return r.u8();
    case 0x12: return r.u16();
    case 0x13: return r.u32();
    case 0x14: return r.u64();
    case 0x15: return r.uleb();
    case 0x16: return readForm(r, r.uleb(), ctx);
    case 0x17: return ctx.offSize === 8 ? r.u64() : r.u32();
    case 0x19: return 1;
    case 0x1a: return { strx: r.uleb() };
    case 0x1b: case 0x22: case 0x23: r.uleb(); return undefined;
    case 0x1c: case 0x1d: r.u32(); return undefined;
    case 0x1e: r.skip(16); return undefined;
    case 0x1f: { const o = ctx.offSize === 8 ? r.u64() : r.u32(); return strAt(ctx.lineStr, o); }
    case 0x20: r.skip(8); return undefined;
    case 0x21: return undefined;
    case 0x25: return { strx: r.u8() };
    case 0x26: return { strx: r.u16() };
    case 0x27: { const a = r.u16(); return { strx: a + r.u8() * 65536 }; }
    case 0x28: return { strx: r.u32() };
    case 0x29: r.skip(1); return undefined;
    case 0x2a: r.skip(2); return undefined;
    case 0x2b: r.skip(3); return undefined;
    case 0x2c: r.skip(4); return undefined;
    default: throw new Error(`unknown DWARF form 0x${form.toString(16)}`);
  }
}

/** Compile units: [{ name, compDir, stmtList, producer, language }]. */
function compileUnits(mod) {
  const info = sectionView(mod, '.debug_info');
  const abbrev = sectionView(mod, '.debug_abbrev');
  if (!info || !abbrev) return [];
  const ctx0 = { str: sectionView(mod, '.debug_str'), lineStr: sectionView(mod, '.debug_line_str'), strOffsets: sectionView(mod, '.debug_str_offsets') };
  const out = [];
  let pos = info.start;
  const cache = new Map();
  while (pos + 11 <= info.end && out.length < 100000) {
    const r = new Buf(info.b, pos, info.end);
    let len = r.u32();
    let offSize = 4;
    if (len === 0xffffffff) { len = r.u64(); offSize = 8; }
    const unitEnd = r.pos + len;
    if (!len || unitEnd > info.end) break;
    try {
      const version = r.u16();
      let abbrOff; let addrSize; let unitType = 1;
      if (version >= 5) { unitType = r.u8(); addrSize = r.u8(); abbrOff = offSize === 8 ? r.u64() : r.u32(); if (unitType === 4 || unitType === 5) r.skip(8); else if (unitType === 2 || unitType === 6) r.skip(8 + offSize); }
      else { abbrOff = offSize === 8 ? r.u64() : r.u32(); addrSize = r.u8(); }
      if (!cache.has(abbrOff)) cache.set(abbrOff, readAbbrevs(abbrev, abbrOff));
      const abbrs = cache.get(abbrOff);
      r.end = unitEnd;
      const code = r.uleb();
      const ab = abbrs.get(code);
      if (ab && (ab.tag === 0x11 || ab.tag === 0x41)) {
        const ctx = { ...ctx0, addrSize, offSize, version };
        const cu = { name: '', compDir: '', stmtList: undefined, producer: '', language: undefined, version };
        const raw = ab.attrs.map((a) => [a.at, a.form === 0x21 ? a.implicit : readForm(r, a.form, ctx)]);
        // DWARF 5 strx forms: index into .debug_str_offsets from DW_AT_str_offsets_base
        const baseAttr = raw.find(([at]) => at === 0x72);
        const offs = ctx0.strOffsets;
        const strx = (i) => {
          if (!offs || !baseAttr || typeof baseAttr[1] !== 'number') return '';
          const p = offs.start + baseAttr[1] + i * offSize;
          if (p + offSize > offs.end) return '';
          const o = new Buf(offs.b, p, offs.end);
          return strAt(ctx0.str, offSize === 8 ? o.u64() : o.u32());
        };
        for (const [at, val] of raw) {
          const v = val && typeof val === 'object' && 'strx' in val ? strx(val.strx) : val;
          const a = { at };
          if (a.at === 0x03 && typeof v === 'string') cu.name = v;
          else if (a.at === 0x1b && typeof v === 'string') cu.compDir = v;
          else if (a.at === 0x10 && typeof v === 'number') cu.stmtList = v;
          else if (a.at === 0x25 && typeof v === 'string') cu.producer = v;
          else if (a.at === 0x13 && typeof v === 'number') cu.language = v;
        }
        out.push(cu);
      }
    } catch (e) { /* a unit we cannot read: skip it */ }
    pos = unitEnd;
  }
  return out;
}

// ---------- .debug_line ----------

/**
 * Runs every line program. Returns { files: [path], rows: { addr: Float64Array, file: Int32Array, line, col,
 * end: Uint8Array (1 = end of a sequence) }, units, version } with addr as DWARF addresses (code section relative).
 */
function lineTable(mod) {
  const sec = sectionView(mod, '.debug_line');
  if (!sec) return null;
  const units = compileUnits(mod);
  const byStmt = new Map();
  for (const u of units) if (u.stmtList !== undefined) byStmt.set(u.stmtList, u);
  const lineStr = sectionView(mod, '.debug_line_str');
  const str = sectionView(mod, '.debug_str');
  const files = [];
  const fileIds = new Map();
  const fileId = (p) => { const k = normalize(p); if (!fileIds.has(k)) { fileIds.set(k, files.length); files.push(k); } return fileIds.get(k); };
  const A = []; const F = []; const L = []; const C = []; const E = [];
  let pos = sec.start;
  const versions = new Set();
  const errors = [];
  while (pos + 4 <= sec.end) {
    const unitOff = pos - sec.start;
    const r = new Buf(sec.b, pos, sec.end);
    let len = r.u32();
    let offSize = 4;
    if (len === 0xffffffff) { len = r.u64(); offSize = 8; }
    const unitEnd = r.pos + len;
    if (!len || unitEnd > sec.end) break;
    try {
      const version = r.u16();
      versions.add(version);
      let addrSize = 4;
      if (version >= 5) { addrSize = r.u8(); r.u8(); }
      const headerLen = offSize === 8 ? r.u64() : r.u32();
      const progStart = r.pos + headerLen;
      const minInst = r.u8();
      const maxOps = version >= 4 ? r.u8() : 1;
      void maxOps;
      const defaultStmt = r.u8();
      const lineBase = (r.u8() << 24) >> 24;
      const lineRange = r.u8();
      const opBase = r.u8();
      const stdLens = [0];
      for (let i = 1; i < opBase; i++) stdLens.push(r.u8());
      const cu = byStmt.get(unitOff) || { compDir: '', name: '' };
      const dirs = [];
      const unitFiles = [];
      if (version >= 5) {
        const ctx = { addrSize, offSize, version, str, lineStr };
        const readEntries = () => {
          const nf = r.u8(); const fmt = [];
          for (let i = 0; i < nf; i++) fmt.push([r.uleb(), r.uleb()]);
          const n = r.uleb(); const out = [];
          for (let i = 0; i < n; i++) {
            const e = {};
            for (const [ct, form] of fmt) { const v = readForm(r, form, ctx); if (ct === 1) e.path = typeof v === 'string' ? v : ''; else if (ct === 2) e.dir = typeof v === 'number' ? v : 0; }
            out.push(e);
          }
          return out;
        };
        for (const d of readEntries()) dirs.push(d.path || '');
        const base = dirs[0] || cu.compDir;
        for (const f of readEntries()) {
          const d = dirs[f.dir || 0] || '';
          unitFiles.push(fileId(joinPath(f.dir ? joinPath(base, d) : base, f.path || '?')));
        }
      } else {
        dirs.push(cu.compDir || '');
        for (;;) { const d = r.cstr(); if (!d) break; dirs.push(joinPath(cu.compDir, d)); }
        unitFiles.push(-1); // file numbers start at 1 before DWARF 5
        for (;;) { const nm = r.cstr(); if (!nm) break; const di = r.uleb(); r.uleb(); r.uleb(); unitFiles.push(fileId(joinPath(dirs[di] || cu.compDir, nm))); }
      }
      r.pos = progStart;
      // state machine
      let addr = 0; let file = 1; let line = 1; let col = 0; let stmt = !!defaultStmt;
      const reset = () => { addr = 0; file = 1; line = 1; col = 0; stmt = !!defaultStmt; };
      const emit = (end) => { A.push(addr); F.push(unitFiles[file] === undefined ? -1 : unitFiles[file]); L.push(line); C.push(col); E.push(end ? 1 : 0); };
      void stmt;
      while (r.pos < unitEnd) {
        const op = r.u8();
        if (op >= opBase) {
          const adj = op - opBase;
          addr += Math.floor(adj / lineRange) * minInst;
          line += lineBase + (adj % lineRange);
          emit(false);
        } else if (op === 0) {
          const n = r.uleb();
          const at = r.pos;
          const sub = r.u8();
          if (sub === 1) { emit(true); reset(); }
          else if (sub === 2) addr = r.uN(n - 1);
          else if (sub === 3) { const nm = r.cstr(); const di = r.uleb(); r.uleb(); r.uleb(); unitFiles.push(fileId(joinPath(dirs[di] || cu.compDir, nm))); }
          r.pos = at + n;
        } else if (op === 1) emit(false);
        else if (op === 2) addr += r.uleb() * minInst;
        else if (op === 3) line += r.sleb();
        else if (op === 4) file = r.uleb();
        else if (op === 5) col = r.uleb();
        else if (op === 6) stmt = !stmt;
        else if (op === 7 || op === 10 || op === 11) { /* basic block, prologue end, epilogue begin */ }
        else if (op === 8) addr += Math.floor((255 - opBase) / lineRange) * minInst;
        else if (op === 9) addr += r.u16();
        else if (op === 12) r.uleb();
        else for (let k = 0; k < stdLens[op]; k++) r.uleb();
      }
    } catch (e) { errors.push(`line program at 0x${unitOff.toString(16)}: ${e.message}`); }
    pos = unitEnd;
  }
  // sort by address, keeping sequence order for equal addresses
  const idx = A.map((_, i) => i).sort((x, y) => A[x] - A[y] || x - y);
  const rows = { addr: new Float64Array(idx.length), file: new Int32Array(idx.length), line: new Int32Array(idx.length), col: new Int32Array(idx.length), end: new Uint8Array(idx.length) };
  idx.forEach((k, i) => { rows.addr[i] = A[k]; rows.file[i] = F[k]; rows.line[i] = L[k]; rows.col[i] = C[k]; rows.end[i] = E[k]; });
  return { files, rows, units, versions: [...versions], errors };
}

// ---------- source maps ----------

const B64 = new Int8Array(128).fill(-1);
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => { B64[c.charCodeAt(0)] = i; });

/** Parses a v3 source map (text) for a .wasm: returns { files, rows } with addr = file offsets. */
function sourceMapTable(text) {
  const map = JSON.parse(text);
  if (!map || typeof map.mappings !== 'string') throw new Error('this is not a source map (no "mappings")');
  const root = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
  const files = (map.sources || []).map((s) => normalize(root ? joinPath(root, String(s)) : String(s)));
  const A = []; const F = []; const L = []; const C = [];
  let gcol = 0; let src = 0; let line = 0; let col = 0;
  const m = map.mappings;
  let i = 0;
  const vlq = () => {
    let r = 0; let s = 0; let d;
    do { const c = m.charCodeAt(i++); d = c < 128 ? B64[c] : -1; if (d < 0) throw new Error('bad character in the source map mappings'); r += (d & 31) * 2 ** s; s += 5; } while (d & 32);
    return r % 2 ? -(r - 1) / 2 : r / 2;
  };
  while (i < m.length) {
    const ch = m[i];
    if (ch === ';') { i++; gcol = 0; continue; } // wasm maps have one line; a new line resets the column
    if (ch === ',') { i++; continue; }
    gcol += vlq();
    let hasSrc = false;
    if (i < m.length && m[i] !== ',' && m[i] !== ';') {
      src += vlq(); line += vlq(); col += vlq(); hasSrc = true;
      if (i < m.length && m[i] !== ',' && m[i] !== ';') vlq(); // name
    }
    A.push(gcol); F.push(hasSrc ? src : -1); L.push(hasSrc ? line + 1 : 0); C.push(hasSrc ? col + 1 : 0);
  }
  const idx = A.map((_, k) => k).sort((x, y) => A[x] - A[y] || x - y);
  const rows = { addr: new Float64Array(idx.length), file: new Int32Array(idx.length), line: new Int32Array(idx.length), col: new Int32Array(idx.length), end: new Uint8Array(idx.length) };
  idx.forEach((k, n) => { rows.addr[n] = A[k]; rows.file[n] = F[k]; rows.line[n] = L[k]; rows.col[n] = C[k]; rows.end[n] = F[k] < 0 ? 1 : 0; });
  return { files, rows, sourcesContent: Array.isArray(map.sourcesContent) ? map.sourcesContent : null };
}

// ---------- the combined view ----------

/**
 * A source location index for a module. kind 'dwarf' (base = code section contents start) or 'sourcemap' (base 0).
 * lookup(fileOffset) -> { file, line, col } or null.
 */
function makeIndex(table, base, kind) {
  const { rows, files } = table;
  const n = rows.addr.length;
  function find(off) {
    const a = off - base;
    let lo = 0; let hi = n - 1; let k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows.addr[mid] <= a) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    return k;
  }
  function lookup(off) {
    const k = find(off);
    if (k < 0 || rows.end[k] || rows.file[k] < 0 || !rows.line[k]) return null;
    return { file: files[rows.file[k]], line: rows.line[k], col: rows.col[k] };
  }
  /** Rows of a byte range [from, to): first location, line span per file. */
  function range(from, to) {
    let k = find(from);
    if (k < 0) k = 0;
    let first = null; const span = new Map();
    for (; k < n && rows.addr[k] + base < to; k++) {
      if (rows.end[k] || rows.file[k] < 0 || !rows.line[k]) continue;
      const f = files[rows.file[k]];
      if (!first) first = { file: f, line: rows.line[k], col: rows.col[k] };
      const s = span.get(f) || { min: Infinity, max: 0, rows: 0 };
      s.min = Math.min(s.min, rows.line[k]); s.max = Math.max(s.max, rows.line[k]); s.rows++;
      span.set(f, s);
    }
    return { first, span };
  }
  return { kind, files, rows: n, lookup, range };
}

/** Source index for a module from its DWARF, or null when it has no .debug_line. */
function dwarfIndex(mod) {
  const t = lineTable(mod);
  if (!t || !t.rows.addr.length) return null;
  const code = mod.sections.find((s) => s.id === 10);
  const ix = makeIndex(t, code ? code.start : 0, 'dwarf');
  ix.units = t.units; ix.versions = t.versions; ix.errors = t.errors;
  return ix;
}
function sourceMapIndex(text) {
  const t = sourceMapTable(text);
  const ix = makeIndex(t, 0, 'sourcemap');
  ix.sourcesContent = t.sourcesContent;
  return ix;
}

module.exports = { lineTable, compileUnits, sourceMapTable, dwarfIndex, sourceMapIndex, makeIndex, normalize, joinPath };
