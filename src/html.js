'use strict';
// Webview HTML for the viewer and the Pro result panels. No vscode import, so tests can check the CSP: no remote
// origin, no connect-src, scripts only with the page nonce.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const PREFIX = 'wasmViewer';
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function csp(cspSource, n) {
  return ["default-src 'none'", `style-src ${cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`, `img-src ${cspSource} data:`, `font-src ${cspSource}`].join('; ');
}

/** p: { cspSource, scriptUri, styleUri, title, showSupportLinks, head?(nonce) } */
function editorHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>
</head>
<body>
<div id="toolbar" role="toolbar" aria-label="WebAssembly viewer">
  <span class="tabs" role="tablist">
    <button class="tab on" data-tab="wat" role="tab" aria-selected="true" title="The module as WebAssembly text (WAT)">WAT</button>
    <button class="tab" data-tab="overview" role="tab" aria-selected="false" title="Sections, imports, exports, memories, tables, globals and custom sections">Overview</button>
  </span>
  <input id="search" type="search" placeholder="Find in all code (Enter)" aria-label="Find in all code">
  <button class="tb" data-cmd="foldAll" title="Fold every function to its header line">Fold all</button>
  <button class="tb" data-cmd="unfoldAll" title="Open every function">Unfold all</button>
  <label class="chk" title="Show the byte offset of each instruction in the file"><input type="checkbox" id="offsets"> Offsets</label>
  <button class="tb" data-cmd="validate" title="Check the whole module with wabt: types, stack and indices">Validate</button>
  <button class="tb" data-cmd="saveWat" title="Save the module as a .wat text file">Save as WAT...</button>
  <button class="tb" data-cmd="openText" title="Open the WAT text in a text editor (read-only)">Open as Text</button>
</div>
<div id="info" aria-live="polite"></div>
<div id="err" role="alert" hidden></div>
<div id="wat" class="pane">
  <div id="scroll"><div id="spacer"></div></div>
  <div id="lines" tabindex="0" aria-label="WebAssembly text"></div>
</div>
<div id="overview" class="pane" hidden></div>
<div id="results" hidden><div id="results-head"><span id="results-title"></span><button class="tb" id="results-close" title="Close the results">Close</button></div><div id="results-list"></div></div>
<div id="failed" hidden><h2>This file could not be read as a WebAssembly module</h2><p id="failmsg"></p></div>
<div id="footer"></div>
<template id="zovo-footer">${footer}</template>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

/** Result panel of a Pro tool. p: { cspSource, scriptUri, styleUri, title, head?(nonce), showSupportLinks } */
function panelHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>
</head>
<body>
<div id="toolbar" role="toolbar"><strong id="title"></strong><span id="actions"></span></div>
<div id="app"><p class="muted">Working...</p></div>
<div id="footer">${footer}</div>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { editorHtml, panelHtml, csp };
