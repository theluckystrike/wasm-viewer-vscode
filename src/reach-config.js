'use strict';
// REACH1: this listing's Pro tools for the viewer toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  prefix: 'wasmViewer',
  triesKey: 'wasmViewer.proTrial',
  slot: '#toolbar',
  tools: [
    { id: 'profile', title: 'Size profiler', command: 'wasmViewer.profile' },
    { id: 'compare', title: 'Compare two builds', command: 'wasmViewer.compare' },
    { id: 'sourcemap', title: 'Source mapping', command: 'wasmViewer.sourceMap' },
  ],
};
