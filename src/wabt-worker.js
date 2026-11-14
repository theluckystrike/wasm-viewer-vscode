'use strict';
// Worker thread for a full wabt check of a .wasm (src/convert.js validateInWorker). Ends after one answer.
const { parentPort, workerData } = require('worker_threads');
const { validateWasm } = require('./convert');

validateWasm(workerData.bytes).then((r) => parentPort.postMessage(r), (e) => parentPort.postMessage({ ok: false, errors: [{ line: 0, col: 0, message: String((e && e.message) || e) }] }));
