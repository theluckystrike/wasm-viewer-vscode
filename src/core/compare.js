'use strict';
// Compares two WebAssembly builds (own code): file and section sizes, functions added, removed, grown and shrunk,
// data, imports and exports. Functions are matched by name (name section, then export name). Rust and C++ hash
// suffixes (::h0123456789abcdef) are ignored, so a rebuilt crate still matches. When neither build has names, the
// functions are matched by index and the result says so. Writes a Markdown size table for a pull request.
const { funcLabel } = require('./wasm');
const { fmtBytes } = require('./profile');

function keyName(raw) { return String(raw).replace(/::h[0-9a-f]{16}(E)?$/, '$1').replace(/17h[0-9a-f]{16}E$/, 'E'); }

/** Map key -> { index, name, size } for the defined functions of a module, and how they were matched. */
function functionKeys(mod) {
  const first = mod.importCounts.func;
  const map = new Map();
  let named = 0;
  let exported = 0;
  for (let i = first; i < mod.funcs.length; i++) {
    const f = mod.funcs[i];
    if (!f.body) continue;
    const nm = mod.names.funcs.get(i);
    const ex = mod.exportOf && mod.exportOf.get(`func:${i}`);
    let key;
    if (nm) { key = 'n:' + keyName(nm); named++; } else if (ex) { key = 'e:' + ex[0]; exported++; } else key = `i:${i}`;
    let k = key;
    let dup = 1;
    while (map.has(k)) k = `${key}#${++dup}`; // same name twice (generic instances): keep them apart in order
    map.set(k, { index: i, name: funcLabel(mod, i), size: f.body.size });
  }
  return { map, named, exported, total: map.size };
}

function sectionSizes(mod) {
  const out = new Map();
  for (const s of mod.sections) {
    const k = s.id === 0 ? `custom "${s.customName || ''}"` : s.kind;
    out.set(k, (out.get(k) || 0) + (s.end - s.offset));
  }
  return out;
}

function compare(a, b) {
  const ka = functionKeys(a);
  const kb = functionKeys(b);
  const byName = ka.named + kb.named > 0;
  const funcs = [];
  for (const [k, x] of ka.map) {
    const y = kb.map.get(k);
    if (!y) funcs.push({ kind: 'removed', key: k, name: x.name, old: x.size, new: 0, delta: -x.size, oldIndex: x.index });
    else if (y.size !== x.size) funcs.push({ kind: y.size > x.size ? 'grown' : 'shrunk', key: k, name: y.name, old: x.size, new: y.size, delta: y.size - x.size, oldIndex: x.index, newIndex: y.index });
  }
  for (const [k, y] of kb.map) if (!ka.map.has(k)) funcs.push({ kind: 'added', key: k, name: y.name, old: 0, new: y.size, delta: y.size, newIndex: y.index });
  funcs.sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta) || p.name.localeCompare(q.name));
  const count = (kind) => funcs.filter((f) => f.kind === kind).length;
  const sum = (kind) => funcs.filter((f) => f.kind === kind).reduce((s, f) => s + f.delta, 0);
  const sa = sectionSizes(a);
  const sb = sectionSizes(b);
  const sections = [...new Set([...sa.keys(), ...sb.keys()])].map((k) => ({ name: k, old: sa.get(k) || 0, new: sb.get(k) || 0 }))
    .map((s) => ({ ...s, delta: s.new - s.old })).sort((p, q) => Math.max(q.old, q.new) - Math.max(p.old, p.new));
  const setOf = (list, f) => new Set(list.map(f));
  const impA = setOf(a.imports, (i) => `${i.module}.${i.field} (${i.kind})`);
  const impB = setOf(b.imports, (i) => `${i.module}.${i.field} (${i.kind})`);
  const expA = setOf(a.exports, (e) => `${e.name} (${e.kind})`);
  const expB = setOf(b.exports, (e) => `${e.name} (${e.kind})`);
  const diffSet = (x, y) => [...x].filter((v) => !y.has(v));
  const dataA = a.datas.reduce((s, d) => s + d.size, 0);
  const dataB = b.datas.reduce((s, d) => s + d.size, 0);
  return {
    match: byName ? 'name' : 'index',
    matchNote: byName ? (ka.named && kb.named ? 'Functions matched by name (name section), hash suffixes ignored.' : 'Only one build has a name section: functions without a name are matched by export name, the rest by index.')
      : 'Neither build has a name section: functions are matched by export name, then by index. Index matches are reliable only for builds made with the same settings.',
    total: { old: a.size, new: b.size, delta: b.size - a.size },
    code: { old: ka.total, new: kb.total },
    counts: { added: count('added'), removed: count('removed'), grown: count('grown'), shrunk: count('shrunk'), same: ka.total - count('removed') - count('grown') - count('shrunk') },
    sums: { added: sum('added'), removed: sum('removed'), grown: sum('grown'), shrunk: sum('shrunk') },
    sections,
    data: { old: dataA, new: dataB, delta: dataB - dataA, oldCount: a.datas.length, newCount: b.datas.length },
    imports: { added: diffSet(impB, impA), removed: diffSet(impA, impB) },
    exports: { added: diffSet(expB, expA), removed: diffSet(expA, expB) },
    funcs,
  };
}

const sign = (n) => (n > 0 ? `+${fmtBytes(n)}` : n < 0 ? `-${fmtBytes(-n)}` : '0');
const pctChange = (o, n) => (o ? `${n >= o ? '+' : ''}${(((n - o) / o) * 100).toFixed(1)}%` : n ? 'new' : '');
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Markdown for a pull request: totals, the section table and the top function changes. */
function markdown(r, oldLabel, newLabel, topN = 20) {
  const L = [];
  L.push(`### WebAssembly size: ${cell(newLabel)}`, '');
  L.push(`Compared with ${cell(oldLabel)}: **${sign(r.total.delta)}** (${pctChange(r.total.old, r.total.new)}), ${fmtBytes(r.total.old)} to ${fmtBytes(r.total.new)}.`, '');
  L.push('| Section | Old | New | Change |', '|---|---:|---:|---:|');
  for (const s of r.sections) if (s.old || s.new) L.push(`| ${cell(s.name)} | ${fmtBytes(s.old)} | ${fmtBytes(s.new)} | ${sign(s.delta)} |`);
  L.push(`| **Total** | **${fmtBytes(r.total.old)}** | **${fmtBytes(r.total.new)}** | **${sign(r.total.delta)}** |`, '');
  L.push(`Functions: ${r.counts.added} added (${sign(r.sums.added)}), ${r.counts.removed} removed (${sign(r.sums.removed)}), ${r.counts.grown} grown (${sign(r.sums.grown)}), ${r.counts.shrunk} shrunk (${sign(r.sums.shrunk)}), ${r.counts.same} unchanged. ${r.matchNote}`, '');
  const top = r.funcs.slice(0, topN);
  if (top.length) {
    L.push('| Function | Change | Old | New | Delta |', '|---|---|---:|---:|---:|');
    for (const f of top) L.push(`| \`${cell(f.name.replace(/`/g, "'"))}\` | ${f.kind} | ${f.old ? fmtBytes(f.old) : ''} | ${f.new ? fmtBytes(f.new) : ''} | ${sign(f.delta)} |`);
    if (r.funcs.length > topN) L.push('', `${r.funcs.length - topN} more function changes are not listed.`);
    L.push('');
  }
  const list = (title, xs) => { if (xs.length) L.push(`${title}: ${xs.slice(0, 15).map((x) => `\`${cell(x)}\``).join(', ')}${xs.length > 15 ? ` and ${xs.length - 15} more` : ''}`, ''); };
  list('Imports added', r.imports.added); list('Imports removed', r.imports.removed);
  list('Exports added', r.exports.added); list('Exports removed', r.exports.removed);
  return L.join('\n');
}

module.exports = { compare, markdown, functionKeys, keyName, sign };
