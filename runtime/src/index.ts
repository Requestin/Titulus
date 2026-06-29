// runtime/src/index.ts
//
// Public barrel for @titulus/runtime. Re-exports the Phase 1 modules as they
// land. The IIFE bundle (window.BG) is assembled by build.mjs.

export * from './schema.js';
export * from './easing.js';
export * from './transform.js';
export * from './stackOrder.js';
export * from './timeline.js';
export * from './clock.js';
export * from './fonts.js';
export * from './stats.js';
export * from './domRenderer.js';
export * from './channelClient.js';
