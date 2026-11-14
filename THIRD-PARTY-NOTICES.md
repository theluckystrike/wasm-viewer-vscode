# Third-party notices

WebAssembly Viewer by Zovo includes the following third-party software, unchanged.

## wabt.js 1.0.39

- Files: `vendor/wabt/index.js` (the WebAssembly Binary Toolkit compiled to WebAssembly and JavaScript)
- Source: https://github.com/AssemblyScript/wabt.js, built from https://github.com/WebAssembly/wabt
- License: Apache License 2.0, full text in `vendor/wabt/LICENSE`
- Used for: WAT to WASM, the errors in `.wat` files and Validate. It runs inside the extension and makes no network requests.

Everything else (the binary decoder, the WAT printer, the DWARF and source map readers, the size profiler and the build compare) is our own code under the MIT license in `LICENSE`.
