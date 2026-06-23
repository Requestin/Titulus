// runtime/src/index.ts
//
// Public barrel for @titulus/runtime. Re-exports the Phase 1 modules as they
// land (schema now; domRenderer/timeline/channelClient in tasks 1.2-1.4). The
// IIFE bundle (window.BG) is assembled by build.mjs.

export * from './schema.js';
