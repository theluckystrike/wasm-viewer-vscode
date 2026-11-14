'use strict';
// The opened module as the viewer sees it (no vscode import, so tests use it directly): the decoded module, the WAT
// layout cut into blocks (fixed lines, or functions and long segments printed on demand), the overview data, the
// search over all code, and source locations once the source mapping tool has run.
const { parseModule, funcLabel, WasmError } = require('./core/wasm');
const W = require('./core/wat');

const ZERO = { lines: [], offsets: [] };
const INLINE = 300; // fixed blocks up to this many lines go to the webview at once
const CHUNK = 500;
const LIST_MAX = 3000; // imports and exports sent with the overview; the filter asks for the rest

class WasmModel {
  /** opts: { names (default true), eagerBytes (print every function up front at or below this file size) } */
  constructor(bytes, opts = {}) {
    this.opts = opts;
    this.mod = parseModule(bytes);
    this.ctx = W.makeCtx(this.mod, { names: opts.names !== false });
    this.raw = W.layout(this.mod, { ctx: this.ctx, maxDataBytes: 64 * 1024 });
    this.blocks = mergeFixed(this.raw);
    this.cache = new Map();
    this.src = null; // source index (dwarf or source map), set by the source mapping tool
    this.funcBlock = new Map();
    this.blocks.forEach((b, i) => { if (b.kind === 'func') this.funcBlock.set(b.index, i); });
  }
  get eager() { return this.mod.size <= (this.opts.eagerBytes === undefined ? 1536 * 1024 : this.opts.eagerBytes); }

  /** Lines of block i: { lines, offsets, src? }. Printed functions are cached (LRU of 400). */
  lines(i) {
    const b = this.blocks[i];
    if (!b) return ZERO;
    if (b.lines) return { lines: b.lines, offsets: b.offsets || [] };
    let r = this.cache.get(i);
    if (r) { this.cache.delete(i); this.cache.set(i, r); return r; }
    r = b.print();
    if (this.src && r.offsets) r.src = sourceColumn(this.src, r.offsets);
    this.cache.set(i, r);
    if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value);
    return r;
  }
  setSource(ix) { this.src = ix; this.cache.clear(); }

  /**
   * Block list for the webview. Small fixed blocks carry their lines. Long fixed runs (thousands of exports) and
   * functions carry only a line count or a header; the webview asks for their lines when they scroll into view.
   * In a small module (eager) every function is open and its line count is known; in a large one they start folded.
   */
  webviewBlocks() {
    const m = this.mod;
    const eager = this.eager;
    return this.blocks.map((b, i) => {
      if (b.lines) return b.lines.length <= INLINE ? { k: b.kind, lines: b.lines } : { k: b.kind, n: b.lines.length };
      const o = { k: b.kind, i: b.index, sz: b.size, lazy: 1, fold: eager ? 0 : 1 };
      if (b.kind === 'func') {
        o.t = m.funcs[b.index].type; // the webview builds the header from sigs[t]
        const ex = m.exportOf.get(`func:${b.index}`);
        if (ex) o.ex = ex[0].length > 100 ? ex[0].slice(0, 100) + '...' : ex[0];
        if (ex && ex.length > 1) o.exn = ex.length;
        if (!this.ctx.names || !m.ids.funcs.has(b.index)) { const nm = m.names.funcs.get(b.index); if (nm) o.nm = nm; }
      }
      else o.h = b.header;
      if (eager) o.n = this.lines(i).lines.length;
      return o;
    });
  }

  /** Signature text of each type, " (type 3) (param i32) (result i32)", for folded function headers. */
  sigs() { return this.mod.types.map((t, i) => W.sigText(this.mod, i, this.ctx)); }

  /** Function names used in the WAT text (index -> "$name"), only for functions that have one. */
  funcIds() {
    const out = {};
    for (const [i, id] of this.ctx.names ? this.mod.ids.funcs : []) out[i] = '$' + id;
    return out;
  }

  overview(fileName) {
    const m = this.mod;
    const sec = m.sections.map((s) => ({ id: s.id, name: s.id === 0 ? `custom "${s.customName || ''}"` : s.kind, offset: s.offset, size: s.end - s.offset, payload: s.size }));
    const lim = (l) => W.limitsText(l);
    const exportsOf = (kind, i) => m.exportOf.get(`${kind}:${i}`) || [];
    const imports = this.importRows(m.imports.slice(0, LIST_MAX));
    const exports = this.exportRows(m.exports.slice(0, LIST_MAX));
    return this._overview(fileName, sec, imports, exports, lim, exportsOf);
  }

  importRows(list) {
    const m = this.mod;
    const sig = (t) => W.sigText(m, t, this.ctx).trim();
    const lim = (l) => W.limitsText(l);
    return list.map((x) => ({
      module: x.module, field: x.field, kind: x.kind, index: x.index,
      desc: x.kind === 'func' || x.kind === 'tag' ? sig(x.type) : x.kind === 'memory' ? lim(x.limits) : x.kind === 'table' ? `${lim(x.limits)} ${x.reftype}` : `${x.mutable ? 'mut ' : ''}${x.valtype}`,
    }));
  }
  exportRows(list) {
    const m = this.mod;
    return list.map((e) => { const t = e.kind === 'func' ? funcLabel(m, e.index) : ''; return { name: e.name, kind: e.kind, index: e.index, target: t === e.name ? '' : t }; });
  }
  /** Imports or exports whose text contains q (the overview filter on long lists). */
  filterList(which, q, max = 2000) {
    const m = this.mod;
    const s = String(q || '').toLowerCase();
    if (which === 'imports') {
      const hit = m.imports.filter((x) => `${x.module}.${x.field} ${x.kind}`.toLowerCase().includes(s));
      return { rows: this.importRows(hit.slice(0, max)), total: hit.length };
    }
    const hit = m.exports.filter((e) => `${e.name} ${e.kind}`.toLowerCase().includes(s) || (e.kind === 'func' && funcLabel(m, e.index).toLowerCase().includes(s)));
    return { rows: this.exportRows(hit.slice(0, max)), total: hit.length };
  }

  _overview(fileName, sec, imports, exports, lim, exportsOf) {
    const m = this.mod;
    const memories = m.memories.map((x, i) => ({ index: i, limits: lim(x.limits), min: Number(x.limits.min), max: x.limits.max === undefined ? null : Number(x.limits.max), shared: x.limits.shared, is64: x.limits.is64, imported: x.imported ? `${x.imported.module}.${x.imported.field}` : '', exports: exportsOf('memory', i) }));
    const tables = m.tables.map((x, i) => ({ index: i, limits: lim(x.limits), type: x.reftype, imported: x.imported ? `${x.imported.module}.${x.imported.field}` : '', exports: exportsOf('table', i) }));
    const globals = m.globals.map((g, i) => ({ index: i, type: g.type, mutable: g.mutable, init: g.init ? W.constExprText(g.init, this.ctx) : '', imported: g.imported ? `${g.imported.module}.${g.imported.field}` : '', exports: exportsOf('global', i), name: m.names.globals.get(i) || '' }));
    const customs = m.customs.map((c) => ({ name: c.name, size: c.size, offset: c.offset }));
    const N = m.names;
    let localNames = 0;
    for (const mp of N.locals.values()) localNames += mp.size;
    const code = m.sections.find((s) => s.id === 10);
    const data = m.sections.find((s) => s.id === 11);
    const defined = m.funcs.length - m.importCounts.func;
    return {
      file: fileName, size: m.size, version: m.version,
      counts: {
        types: m.types.length, imports: m.imports.length, importFuncs: m.importCounts.func, funcs: defined, tables: m.tables.length,
        memories: m.memories.length, globals: m.globals.length, exports: m.exports.length, elems: m.elems.length, datas: m.datas.length,
        tags: m.tags.length, codeSize: code ? code.end - code.offset : 0, dataSize: data ? data.end - data.offset : 0,
      },
      sections: sec, imports, exports, importsTotal: m.imports.length, exportsTotal: m.exports.length, memories, tables, globals, customs,
      start: m.start === undefined ? null : { index: m.start, name: funcLabel(m, m.start) },
      names: {
        present: m.customs.some((c) => c.name === 'name'), module: N.module, funcs: N.funcs.size, locals: localNames, globals: N.globals.size,
        types: N.types.size, datas: N.datas.size, tables: N.tables.size, memories: N.memories.size, labels: N.labels.size,
        source: N.funcs.size ? 'name section' : m.exports.length ? 'export names' : 'indices',
      },
      producers: m.producers, targetFeatures: m.targetFeatures, sourceMappingURL: m.sourceMappingURL || '',
      externalDebugInfo: m.externalDebugInfo || '',
      dwarf: m.customs.some((c) => c.name === '.debug_line'),
      features: detectFeatures(m),
      errors: m.errors.map((e) => ({ offset: e.offset, message: e.message, soft: !!e.soft })),
    };
  }

  /**
   * Searches every line of the module (functions are printed on the fly). Calls onHit(hit) for each match and
   * yields to the event loop between chunks. Returns { hits, scanned, stopped }. token: { cancelled }.
   */
  async search(query, { max = 500, token = {}, onProgress, regex = false, caseSensitive = false } = {}) {
    let re;
    if (regex) re = new RegExp(query, caseSensitive ? '' : 'i');
    const q = caseSensitive ? query : query.toLowerCase();
    const test = re ? (s) => re.test(s) : caseSensitive ? (s) => s.includes(q) : (s) => s.toLowerCase().includes(q);
    const hits = [];
    let scanned = 0;
    let since = Date.now();
    for (let i = 0; i < this.blocks.length; i++) {
      if (token.cancelled) return { hits, scanned, stopped: true };
      const b = this.blocks[i];
      const ls = b.lines || (this.cache.get(i) || b.print()).lines;
      for (let l = 0; l < ls.length; l++) {
        if (test(ls[l])) { hits.push({ b: i, l, text: ls[l].trim().slice(0, 200), func: b.kind === 'func' ? b.index : undefined }); if (hits.length >= max) return { hits, scanned: scanned + 1, stopped: true, more: true }; }
      }
      scanned++;
      if (Date.now() - since > 40) { since = Date.now(); if (onProgress) onProgress(i, this.blocks.length, hits.length); await new Promise((r) => setImmediate(r)); }
    }
    return { hits, scanned, stopped: false };
  }

  /** The whole WAT text, written in chunks (Save as WAT, Open as Text). */
  write(writeChunk) {
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      const ls = b.lines || b.print().lines;
      writeChunk(ls.join('\n') + '\n');
    }
  }
  text() { const parts = []; this.write((s) => parts.push(s)); return parts.join(''); }

  /** Decoding problems inside function bodies (the overview lists them). Prints each function once. */
  bodyErrors(limit = 50) {
    const out = [];
    for (const b of this.raw) {
      if (b.kind !== 'func') continue;
      const r = b.print();
      if (r.error) { out.push({ func: b.index, name: funcLabel(this.mod, b.index), offset: r.error.offset, message: r.error.message }); if (out.length >= limit) break; }
    }
    return out;
  }
}

/** Joins runs of fixed blocks of the same kind (all exports, all imports ...) and cuts long runs into chunks of
 *  CHUNK lines, so the webview gets few blocks and loads long runs only when they are on screen. */
function mergeFixed(raw) {
  const out = [];
  for (const b of raw) {
    const last = out[out.length - 1];
    if (b.lines && last && last.lines && last.kind === b.kind && last.lines.length < CHUNK) { last.lines.push(...b.lines); continue; }
    out.push(b.lines ? { ...b, lines: b.lines.slice() } : b);
  }
  return out;
}

/** "file.c:12" for each line where the source location changes, '' elsewhere. */
function sourceColumn(ix, offsets) {
  const out = new Array(offsets.length).fill('');
  let last = '';
  for (let k = 0; k < offsets.length; k++) {
    const o = offsets[k];
    if (o < 0) continue;
    const loc = ix.lookup(o);
    if (!loc) continue;
    const base = loc.file.split('/').pop();
    const s = `${base}:${loc.line}`;
    if (s !== last) { out[k] = s; last = s; }
  }
  return out;
}

/** Proposals the module uses, from its types, imports and limits, plus target_features when present. */
function detectFeatures(m) {
  const f = new Set();
  for (const x of m.targetFeatures || []) if (x.prefix === '+' || x.prefix === '=') f.add(x.name);
  for (const mem of m.memories) { if (mem.limits.shared) f.add('threads (shared memory)'); if (mem.limits.is64) f.add('memory64'); }
  if (m.memories.length > 1) f.add('multi-memory');
  if (m.tags.length) f.add('exception handling');
  if (m.types.some((t) => t.kind !== 'func' || t.sub || t.rec)) f.add('GC types');
  if (m.types.some((t) => t.kind === 'func' && t.results.length > 1)) f.add('multi-value');
  const vt = (s) => /v128/.test(s);
  if (m.types.some((t) => t.kind === 'func' && (t.params.some(vt) || t.results.some(vt)))) f.add('SIMD');
  return [...f];
}

module.exports = { WasmModel, mergeFixed, INLINE, CHUNK, sourceColumn, detectFeatures, WasmError };
