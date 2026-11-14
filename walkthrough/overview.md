# See what is inside a module

The Overview tab of the viewer answers the first questions about a `.wasm` file:

- How big is it, and which sections take the space: code, data, names or debug info.
- What it needs from the host: each import with its module, name and type.
- What it gives back: each export. Click a function export to read its code.
- Its memories in pages and bytes (shared ones too), tables, globals with their start values, the start function.
- Custom sections such as `name`, `producers`, `target_features`, `sourceMappingURL` and DWARF `.debug_*`.

Validate checks the whole module with wabt and lists each problem with its byte offset.
