'use strict';
// WAT text helpers for the text editor (own code): the module fields as outline symbols and fold ranges from the
// parentheses. One pass that skips strings, ";;" line comments and nested "(; ;)" block comments.

const FIELDS = { func: 'Function', global: 'Variable', memory: 'Array', table: 'Array', type: 'Struct', import: 'Interface', export: 'Key', data: 'Constant', elem: 'Constant', tag: 'Event', start: 'Method', rec: 'Struct' };

/** Walks the parentheses. onOpen(depth, line, offset), onClose(depth, line). */
function walk(text, onOpen, onClose) {
  let line = 0; let depth = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) { line++; continue; }
    if (c === 59 && text.charCodeAt(i + 1) === 59) { while (i < n && text.charCodeAt(i) !== 10) i++; line++; continue; } // ;;
    if (c === 34) { // string
      i++;
      while (i < n && text.charCodeAt(i) !== 34) { if (text.charCodeAt(i) === 92) i++; else if (text.charCodeAt(i) === 10) line++; i++; }
      continue;
    }
    if (c === 40 && text.charCodeAt(i + 1) === 59) { // (; block comment, nested
      let d = 1; i += 2;
      while (i < n && d) {
        const x = text.charCodeAt(i);
        if (x === 10) line++;
        if (x === 40 && text.charCodeAt(i + 1) === 59) { d++; i += 2; continue; }
        if (x === 59 && text.charCodeAt(i + 1) === 41) { d--; i += 2; continue; }
        i++;
      }
      i--;
      continue;
    }
    if (c === 40) { depth++; onOpen(depth, line, i); } else if (c === 41) { onClose(depth, line); if (depth > 0) depth--; }
  }
}

/** Fold ranges [startLine, endLine] for every parenthesis that spans more than one line. */
function foldingRanges(text, max = 50000) {
  const out = [];
  const stack = [];
  walk(text, (d, line) => { stack.push(line); }, (d, line) => {
    const s = stack.pop();
    if (s !== undefined && line > s && out.length < max) out.push([s, line]);
  });
  // wasm2wat style text has flat instructions inside a function: fold "block/loop/if ... end" by indentation too
  const lines = text.split('\n');
  const open = [];
  for (let k = 0; k < lines.length && out.length < max; k++) {
    const t = lines[k].trim();
    const ind = lines[k].length - lines[k].trimStart().length;
    if (/^(block|loop|if|try|try_table)\b/.test(t)) open.push({ k, ind });
    else if (/^(end|delegate)\b/.test(t)) { while (open.length && open[open.length - 1].ind > ind) open.pop(); const o = open.pop(); if (o && k > o.k) out.push([o.k, k]); }
  }
  return out;
}

/** Module fields as symbols: [{ name, detail, kind, line, endLine }]. */
function symbols(text) {
  const out = [];
  const counters = {};
  let moduleDepth = 0;
  const open = [];
  walk(text, (depth, line, off) => {
    const m = /^\(\s*([a-z]+)(?:\s+(\$[^\s()";]+))?/.exec(text.slice(off, off + 300));
    const kw = m && m[1];
    if (kw === 'module' && !moduleDepth && depth <= 1) { moduleDepth = depth; return; }
    const top = moduleDepth ? depth === moduleDepth + 1 : depth === 1;
    if (!top || !kw || !FIELDS[kw]) return;
    const idx = counters[kw] = (counters[kw] || 0) + 1;
    let name = m[2] || '';
    let detail = '';
    const head = text.slice(off, off + 400).split('\n')[0];
    if (kw === 'import' || kw === 'export') {
      const q = /^\(\s*\w+\s+("(?:[^"\\]|\\.)*")(?:\s+("(?:[^"\\]|\\.)*"))?(?:\s*\(\s*(\w+)(?:\s+(\$[^\s()";]+))?)?/.exec(head);
      if (q) { name = kw === 'import' ? `${q[1].slice(1, -1)}.${(q[2] || '""').slice(1, -1)}` : q[1].slice(1, -1); detail = `${kw} ${q[3] || ''}${q[4] ? ' ' + q[4] : ''}`.trim(); }
    } else {
      if (!name) name = `${kw} ${idx - 1}`;
      detail = kw;
      if (kw === 'func') { const ex = /\(export\s+("(?:[^"\\]|\\.)*")/.exec(head); if (ex) detail += ` export ${ex[1]}`; }
    }
    open.push({ depth, sym: { name, detail, kind: FIELDS[kw], line, endLine: line } });
    out.push(open[open.length - 1].sym);
  }, (depth, line) => {
    if (open.length && open[open.length - 1].depth === depth) open.pop().sym.endLine = line;
  });
  return out;
}

module.exports = { symbols, foldingRanges, walk };
