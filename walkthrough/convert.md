# WAT to WASM and back

- In a `.wat` file, errors show in the Problems view while you type, with their line and column.
- Compile WAT to WASM (the button in the editor title bar, or a right-click on the file) writes `name.wasm` next to the `.wat` and opens it in the viewer.
- In the viewer, Save as WAT writes the text of the module to a `.wat` file, and Open as WAT Text shows it in a read-only text editor.

wabt does the work inside the extension. There is nothing to install and nothing goes over the network.
