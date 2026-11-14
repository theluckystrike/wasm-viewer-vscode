'use strict';
// Size profile of a WebAssembly module (own code): sizes by section, function, data segment, import module and name
// group; the call graph with its roots (exports, start, element segments, ref.func); retained size of each function
// from the dominator tree (the bytes that would go away if nothing kept that function alive); and the shortest path
// from a root to any function ("what keeps it alive"). No vscode import, so tests run it directly.
const { Reader, decodeLocals, funcLabel, WasmError } = require('./wasm');

const CALLS = new Set(['call', 'return_call']);

/**
 * Scans every defined function body once. Returns { callees: Array<Int32Array>, refs: Set (ref.func targets),
 * indirect: count of call_indirect / call_ref per function, errors: [{func, message}] }.
 * onProgress(done, total) is called every 500 functions.
 */
function scanCalls(mod, onProgress) {
  const n = mod.funcs.length;
  const callees = new Array(n);
  const indirect = new Uint32Array(n);
  const refs = new Set();
  const errors = [];
  const first = mod.importCounts.func;
  for (let i = 0; i < n; i++) {
    if (i < first || !mod.funcs[i].body) { callees[i] = new Int32Array(0); continue; }
    const out = new Set();
    try {
      const { reader } = decodeLocals(mod, i);
      while (!reader.eof()) {
        const ins = reader.instr();
        const name = ins.op.name;
        if (CALLS.has(name)) out.add(ins.a);
        else if (name === 'ref.func') { out.add(ins.a); refs.add(ins.a); }
        else if (name === 'call_indirect' || name === 'return_call_indirect' || name === 'call_ref' || name === 'return_call_ref') indirect[i]++;
      }
    } catch (e) {
      if (!(e instanceof WasmError)) throw e;
      errors.push({ func: i, message: e.message });
    }
    callees[i] = Int32Array.from([...out].filter((x) => x >= 0 && x < n));
    if (onProgress && i % 500 === 0) onProgress(i, n);
  }
  // ref.func in globals and element segment expressions
  const constRefs = (list) => { for (const ins of list || []) if (ins.op.name === 'ref.func') refs.add(ins.a); };
  for (const g of mod.globals) constRefs(g.init);
  for (const e of mod.elems) if (e.exprs) for (const x of e.exprs) constRefs(x);
  return { callees, indirect, refs, errors };
}

/** Roots: what the host can reach directly. Map funcIndex -> [reason]. */
function roots(mod, refs) {
  const r = new Map();
  const add = (i, why) => { if (i === undefined || i < 0 || i >= mod.funcs.length) return; if (!r.has(i)) r.set(i, []); if (r.get(i).length < 3) r.get(i).push(why); };
  for (const e of mod.exports) if (e.kind === 'func') add(e.index, `export "${e.name}"`);
  if (mod.start !== undefined) add(mod.start, 'start function');
  mod.elems.forEach((e, k) => {
    if (e.mode === 'declarative') return;
    const why = `table element (elem ${k})`;
    if (e.funcs) for (const f of e.funcs) add(f, why);
    if (e.exprs) for (const x of e.exprs) for (const ins of x) if (ins.op.name === 'ref.func') add(ins.a, why);
  });
  for (const g of mod.globals) for (const ins of g.init || []) if (ins.op.name === 'ref.func') add(ins.a, 'ref.func in a global');
  void refs;
  return r;
}

/**
 * Dominator tree over the call graph with a virtual root (index n) that calls every root (Cooper, Harvey, Kennedy:
 * "A Simple, Fast Dominance Algorithm"). Returns { idom: Int32Array (-1 = unreachable, n = virtual root), order }.
 */
function dominators(n, callees, rootSet) {
  const N = n + 1;
  const succ = (v) => (v === n ? rootSet : callees[v]);
  // iterative DFS for reverse postorder
  const post = new Int32Array(N).fill(-1);
  const order = [];
  const seen = new Uint8Array(N);
  const stack = [n];
  const iter = new Int32Array(N);
  seen[n] = 1;
  while (stack.length) {
    const v = stack[stack.length - 1];
    const s = succ(v);
    if (iter[v] < s.length) {
      const w = s[iter[v]++];
      if (!seen[w]) { seen[w] = 1; stack.push(w); }
    } else { stack.pop(); post[v] = order.length; order.push(v); }
  }
  const preds = new Array(N);
  for (let v = 0; v < N; v++) preds[v] = [];
  for (const v of order) for (const w of succ(v)) if (seen[w]) preds[w].push(v);
  const idom = new Int32Array(N).fill(-1);
  idom[n] = n;
  const rpo = order.slice().reverse();
  const intersect = (a, b) => {
    while (a !== b) {
      while (post[a] < post[b]) a = idom[a];
      while (post[b] < post[a]) b = idom[b];
    }
    return a;
  };
  let changed = true;
  let rounds = 0;
  while (changed && rounds++ < 1000) {
    changed = false;
    for (const v of rpo) {
      if (v === n) continue;
      let nd = -1;
      for (const p of preds[v]) {
        if (idom[p] === -1) continue;
        nd = nd === -1 ? p : intersect(p, nd);
      }
      if (nd !== -1 && idom[v] !== nd) { idom[v] = nd; changed = true; }
    }
  }
  return { idom, order };
}

/** Rust and C++ names: strip the hash suffix and split into path parts. Go names: package path and the rest. */
function nameParts(name) {
  let s = String(name || '');
  s = s.replace(/^[A-Za-z_]\w*\$(?=_?_Z)/, ''); // "orig$_ZN..." (Emscripten renamed exports)
  const m = /^_?_ZN[rVKRO]*/.exec(s);
  if (m) { // Itanium (C++) or legacy Rust nested name: length-prefixed parts up to the first non-digit
    const parts = [];
    let r = s.slice(m[0].length);
    for (;;) {
      const k = /^(\d+)/.exec(r);
      if (!k) break;
      const len = Number(k[1]);
      parts.push(r.slice(k[1].length, k[1].length + len));
      r = r.slice(k[1].length + len);
    }
    if (parts.length) s = parts.join('::');
  }
  s = s.replace(/::h[0-9a-f]{16}$/, '');
  s = s.replace(/^[<(&*]+/, '');
  if (s.includes('::')) return s.split('::').map((x) => x.replace(/^[<&]+/, '').replace(/\s+as\s+.*$/, ''));
  const go = /^((?:[\w.-]+\/)*[\w-]+)\.[\w(*$]/.exec(s);
  if (go && (go[1].includes('/') || /^[a-z]/.test(go[1]))) return [go[1], s.slice(go[1].length + 1)];
  return [s];
}
/** The group of a function name: crate, namespace or package (1 or 2 levels), or "(no name)". */
function groupOf(name, depth = 1) {
  if (!name) return '(no name)';
  const p = nameParts(name);
  if (p.length <= 1) return '(no namespace)';
  return p.slice(0, Math.min(depth, p.length - 1)).join('::');
}

/**
 * The full profile. Heavy part is scanCalls (one pass over the code). Returns plain JSON-able data plus `graph` for
 * keepAlive(). opts: { onProgress, top (default 200) }.
 */
function profile(mod, opts = {}) {
  const top = opts.top || 200;
  const n = mod.funcs.length;
  const first = mod.importCounts.func;
  const scan = scanCalls(mod, opts.onProgress);
  const rootMap = roots(mod, scan.refs);
  const rootList = Int32Array.from([...rootMap.keys()]);
  const { idom } = dominators(n, scan.callees, rootList);
  const size = new Float64Array(n + 1);
  for (let i = first; i < n; i++) size[i] = mod.funcs[i].body ? mod.funcs[i].body.size : 0;
  // retained: sum over the dominator subtree. Children before parents: sort reachable nodes by depth, deepest first.
  const depth = new Int32Array(n + 1).fill(-1);
  depth[n] = 0;
  const getDepth = (v) => {
    const path = [];
    while (depth[v] === -1) { path.push(v); v = idom[v]; if (v === -1) break; }
    let d = v === -1 ? -1 : depth[v];
    for (let k = path.length - 1; k >= 0; k--) { d = d === -1 ? -1 : d + 1; depth[path[k]] = d; }
    return d;
  };
  for (let i = 0; i < n; i++) if (idom[i] !== -1) getDepth(i);
  const reach = [];
  for (let i = 0; i < n; i++) if (idom[i] !== -1) reach.push(i);
  reach.sort((a, b) => depth[b] - depth[a]);
  const retained = Float64Array.from(size);
  for (const v of reach) { const p = idom[v]; if (p !== n && p >= 0) retained[p] += retained[v]; }
  const callers = new Uint32Array(n);
  for (let i = 0; i < n; i++) for (const c of scan.callees[i]) callers[c]++;

  const codeSec = mod.sections.find((s) => s.id === 10);
  const dataSec = mod.sections.find((s) => s.id === 11);
  const codeSize = codeSec ? codeSec.end - codeSec.offset : 0;
  const label = (i) => funcLabel(mod, i);
  const fnRow = (i) => ({
    index: i, name: label(i), size: size[i], retained: retained[i], pct: codeSize ? size[i] / codeSize : 0,
    calls: scan.callees[i].length, callers: callers[i], indirect: scan.indirect[i], root: rootMap.has(i), reachable: idom[i] !== -1,
  });
  const defined = [];
  for (let i = first; i < n; i++) if (mod.funcs[i].body) defined.push(i);
  const bySize = defined.slice().sort((a, b) => size[b] - size[a]);
  const byRetained = defined.filter((i) => idom[i] !== -1).sort((a, b) => retained[b] - retained[a]);
  const unreachable = defined.filter((i) => idom[i] === -1);
  const deadBytes = unreachable.reduce((s, i) => s + size[i], 0);

  const sections = mod.sections.map((s) => ({ name: s.id === 0 ? `custom "${s.customName || ''}"` : s.kind, id: s.id, size: s.end - s.offset, offset: s.offset, pct: (s.end - s.offset) / mod.size }));
  const datas = mod.datas.map((d, i) => ({ index: i, size: d.size, mode: d.mode, offset: d.start, preview: previewBytes(mod.bytes, d.start, Math.min(d.end, d.start + 48)) }))
    .sort((a, b) => b.size - a.size);
  // imports by module, with how many defined functions call into each module
  const impMods = new Map();
  for (const imp of mod.imports) {
    if (!impMods.has(imp.module)) impMods.set(imp.module, { module: imp.module, funcs: 0, other: 0, callers: 0, names: [] });
    const m = impMods.get(imp.module);
    if (imp.kind === 'func') m.funcs++; else m.other++;
    if (m.names.length < 8) m.names.push(imp.field);
  }
  const callerOfModule = new Map();
  for (const i of defined) {
    const seenMods = new Set();
    for (const c of scan.callees[i]) if (c < first) { const imp = mod.funcs[c].imported; if (imp) seenMods.add(imp.module); }
    for (const mname of seenMods) callerOfModule.set(mname, (callerOfModule.get(mname) || 0) + 1);
  }
  for (const m of impMods.values()) m.callers = callerOfModule.get(m.module) || 0;
  // groups by name
  const named = mod.names.funcs.size > 0;
  const groups = new Map();
  for (const i of defined) {
    const ex = mod.exportOf.get(`func:${i}`);
    const g = groupOf(mod.names.funcs.get(i) || (ex && ex[0]) || '', 1);
    if (!groups.has(g)) groups.set(g, { group: g, funcs: 0, size: 0 });
    const x = groups.get(g);
    x.funcs++; x.size += size[i];
  }
  const groupRows = [...groups.values()].sort((a, b) => b.size - a.size).slice(0, top).map((x) => ({ ...x, pct: codeSize ? x.size / codeSize : 0 }));

  return {
    file: { size: mod.size, codeSize, dataSize: dataSec ? dataSec.end - dataSec.offset : 0, funcs: defined.length, imports: mod.imports.length, exports: mod.exports.length, named, roots: rootMap.size },
    sections: sections.sort((a, b) => b.size - a.size),
    functions: bySize.slice(0, top).map(fnRow),
    retainedTop: byRetained.slice(0, top).map(fnRow),
    datas: datas.slice(0, Math.min(top, 100)),
    dataCount: mod.datas.length,
    importModules: [...impMods.values()].sort((a, b) => b.funcs - a.funcs),
    groups: groupRows,
    unreachable: { count: unreachable.length, bytes: deadBytes, top: unreachable.sort((a, b) => size[b] - size[a]).slice(0, 50).map(fnRow) },
    scanErrors: scan.errors.slice(0, 20),
    graph: { callees: scan.callees, idom, roots: rootMap, size, retained },
  };
}

function previewBytes(b, from, to) {
  let s = '';
  for (let i = from; i < to; i++) { const c = b[i]; s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.'; }
  return s;
}

/**
 * What keeps function `target` alive: the shortest call chain from a root, its direct callers, and its immediate
 * dominator (the one function every chain goes through). graph from profile().
 */
function keepAlive(mod, graph, target, maxCallers = 50) {
  const n = mod.funcs.length;
  const { callees, roots: rootMap, idom } = graph;
  const label = (i) => funcLabel(mod, i);
  const callersOf = [];
  for (let i = 0; i < n && callersOf.length < maxCallers; i++) if (callees[i].includes(target)) callersOf.push({ index: i, name: label(i) });
  // BFS from all roots
  const prev = new Int32Array(n).fill(-2);
  const q = [];
  for (const r of rootMap.keys()) { prev[r] = -1; q.push(r); }
  let found = prev[target] !== -2;
  for (let h = 0; h < q.length && !found; h++) {
    const v = q[h];
    for (const w of callees[v]) {
      if (prev[w] !== -2) continue;
      prev[w] = v;
      if (w === target) { found = true; break; }
      q.push(w);
    }
  }
  const chain = [];
  if (found) { for (let v = target; v !== -1; v = prev[v]) chain.unshift({ index: v, name: label(v) }); }
  const root = chain.length ? rootMap.get(chain[0].index) : null;
  const d = idom[target];
  return {
    index: target, name: label(target), root: rootMap.has(target) ? rootMap.get(target) : null,
    chain, chainRoot: root, callers: callersOf,
    dominator: d === -1 ? null : d === n ? 'root' : { index: d, name: label(d) },
    reachable: idom[target] !== -1,
    size: graph.size[target], retained: graph.retained[target],
  };
}

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function markdown(p, fileName, topN = 30) {
  const L = [];
  L.push(`# WebAssembly size profile: ${fileName}`, '');
  L.push(`- File: ${fmtBytes(p.file.size)}, code ${fmtBytes(p.file.codeSize)}, data ${fmtBytes(p.file.dataSize)}`);
  L.push(`- ${p.file.funcs} functions, ${p.file.imports} imports, ${p.file.exports} exports, ${p.file.roots} roots (exports, start, table)`);
  if (p.unreachable.count) L.push(`- ${p.unreachable.count} functions (${fmtBytes(p.unreachable.bytes)}) are not reachable from any export, the start function or a table`);
  L.push('', '## Sections', '', '| Section | Size | Share |', '|---|---:|---:|');
  for (const s of p.sections) L.push(`| ${cell(s.name)} | ${fmtBytes(s.size)} | ${pct(s.pct)} |`);
  L.push('', `## Biggest functions (top ${Math.min(topN, p.functions.length)})`, '', '| # | Function | Size | Retained | Share of code |', '|---:|---|---:|---:|---:|');
  p.functions.slice(0, topN).forEach((f) => L.push(`| ${f.index} | ${cell(f.name)} | ${fmtBytes(f.size)} | ${fmtBytes(f.retained)} | ${pct(f.pct)} |`));
  if (p.groups.length > 1) {
    L.push('', '## Size by name group', '', '| Group | Functions | Size | Share of code |', '|---|---:|---:|---:|');
    p.groups.slice(0, topN).forEach((g) => L.push(`| ${cell(g.group)} | ${g.funcs} | ${fmtBytes(g.size)} | ${pct(g.pct)} |`));
  }
  if (p.datas.length) {
    L.push('', '## Biggest data segments', '', '| # | Size | Mode | Starts with |', '|---:|---:|---|---|');
    p.datas.slice(0, 10).forEach((d) => L.push(`| ${d.index} | ${fmtBytes(d.size)} | ${d.mode} | \`${cell(d.preview.replace(/`/g, "'"))}\` |`));
  }
  if (p.importModules.length) {
    L.push('', '## Imports by module', '', '| Module | Functions | Other | Functions that call it |', '|---|---:|---:|---:|');
    p.importModules.forEach((m) => L.push(`| ${cell(m.module)} | ${m.funcs} | ${m.other} | ${m.callers} |`));
  }
  return L.join('\n') + '\n';
}

module.exports = { profile, keepAlive, scanCalls, roots, dominators, nameParts, groupOf, markdown, fmtBytes };
