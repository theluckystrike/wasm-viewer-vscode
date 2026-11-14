'use strict';
// WAT to WASM and validation, through wabt (the WebAssembly Binary Toolkit, Apache 2.0, vendored unchanged in
// vendor/wabt; see THIRD-PARTY-NOTICES.md). wabt runs as WebAssembly inside the extension host: no install, no
// process, no network. WASM to WAT uses our own printer (src/core/wat.js), which is faster on large modules.
// No vscode import, so tests run it directly.
const path = require('path');

const FEATURES = {
  exceptions: true, mutable_globals: true, sat_float_to_int: true, sign_extension: true, simd: true, threads: true,
  function_references: true, multi_value: true, tail_call: true, bulk_memory: true, reference_types: true,
  code_metadata: true, gc: true, memory64: true, extended_const: true, relaxed_simd: true, multi_memory: true,
};

let wabtPromise = null;
/** The wabt module, loaded once on first use (about 0.1 s). */
function wabt() {
  if (!wabtPromise) {
    const init = require(path.join(__dirname, '..', 'vendor', 'wabt', 'index.js'));
    wabtPromise = init().catch((e) => { wabtPromise = null; throw e; });
  }
  return wabtPromise;
}

/**
 * wabt error text -> [{ line, col, message, source }] (1-based line and column; line 0 when wabt gave none).
 * "x.wat:3:5: error: unexpected token" and "<binary>:0000f19: error: ..." are both understood.
 */
function parseErrors(text, fileName) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    let m = /^(.*?):(\d+):(\d+): (error|warning): (.*)$/.exec(l);
    if (m && (!fileName || m[1] === fileName || m[1].endsWith(fileName))) {
      const e = { line: Number(m[2]), col: Number(m[3]), severity: m[4], message: m[5] };
      // wabt prints the source line and a ^^^ marker under it: the marker length is the token length
      const marker = lines[k + 2] && /^\s*(\^+)\s*$/.exec(lines[k + 2]);
      if (marker) e.length = marker[1].length;
      out.push(e);
      continue;
    }
    m = /^<binary>:([0-9a-f]+): (error|warning): (.*)$/.exec(l);
    if (m) out.push({ offset: parseInt(m[1], 16), line: 0, col: 0, severity: m[2], message: m[3] });
  }
  if (!out.length && String(text || '').trim()) out.push({ line: 0, col: 0, severity: 'error', message: String(text).replace(/^(parseWat|readWasm|validate) failed:\s*/, '').trim().split('\n')[0] });
  return out;
}

/**
 * Compiles WAT (or the folded s-expression form) to a binary. Returns { ok: true, bytes } or
 * { ok: false, stage: 'parse' | 'validate', errors }. Names ($f) are written to the name section when names is true.
 */
async function watToWasm(text, fileName = 'module.wat', opts = {}) {
  const w = await wabt();
  let mod;
  try { mod = w.parseWat(fileName, text, FEATURES); } catch (e) {
    return { ok: false, stage: 'parse', errors: parseErrors(e.message, fileName) };
  }
  try {
    try { mod.resolveNames(); mod.validate(FEATURES); } catch (e) {
      return { ok: false, stage: 'validate', errors: parseErrors(e.message, fileName) };
    }
    const r = mod.toBinary({ log: false, write_debug_names: opts.names !== false, canonicalize_lebs: true, relocatable: false });
    return { ok: true, bytes: Buffer.from(r.buffer) };
  } finally { mod.destroy(); }
}

/** Full wabt validation of a binary (types, stack, indices). Returns { ok, errors: [{ offset, message }] }. */
async function validateWasm(bytes) {
  const w = await wabt();
  // wabt.js copies view.buffer from its start, not the view: hand it an exact Uint8Array
  if (!(bytes instanceof Uint8Array) || bytes.byteOffset !== 0 || bytes.buffer.byteLength !== bytes.byteLength) bytes = Uint8Array.from(bytes);
  let mod;
  try { mod = w.readWasm(bytes, { readDebugNames: false, check: true, ...FEATURES }); } catch (e) {
    return { ok: false, stage: 'read', errors: parseErrors(e.message) };
  }
  try {
    try { mod.validate(FEATURES); } catch (e) { return { ok: false, stage: 'validate', errors: parseErrors(e.message) }; }
    return { ok: true, errors: [] };
  } finally { mod.destroy(); }
}

/**
 * validateWasm in a worker thread: wabt's memory grows to several times the module size and WebAssembly memory never
 * shrinks, so a worker that ends after the check gives that memory back. Falls back to this thread without workers.
 */
function validateInWorker(bytes, timeoutMs = 300000) {
  let Worker;
  try { ({ Worker } = require('worker_threads')); } catch (e) { return validateWasm(bytes); }
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { w.terminate(); } catch (e) { /* ended */ } resolve(r); };
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const w = new Worker(path.join(__dirname, 'wabt-worker.js'), { workerData: { bytes: copy } });
    const timer = setTimeout(() => finish({ ok: false, errors: [{ line: 0, col: 0, message: `the check took more than ${Math.round(timeoutMs / 1000)} s and was stopped` }] }), timeoutMs);
    w.on('message', finish);
    w.on('error', (e) => finish({ ok: false, errors: [{ line: 0, col: 0, message: String((e && e.message) || e) }] }));
    w.on('exit', () => finish({ ok: false, errors: [{ line: 0, col: 0, message: 'the check stopped without a result' }] }));
  });
}

module.exports = { watToWasm, validateWasm, validateInWorker, parseErrors, wabt, FEATURES };
