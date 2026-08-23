// runtime/src/index.ts
//
// Public barrel for @titulus/runtime. Re-exports the Phase 1 modules as they
// land. The IIFE bundle (window.BG) is assembled by build.mjs.

export * from './schema.js';
export * from './capabilities.js';
export * from './normalizeTemplate.js';
export * from './easing.js';
export * from './transform.js';
export * from './stackOrder.js';
export * from './timeline.js';
export * from './crawlSchedule.js';
export * from './directorMachine.js';
export * from './clock.js';
export * from './fonts.js';
export * from './stats.js';
export * from './maskScopes.js';
export * from './maskGeometry.js';
export * from './layerPromote.js';
export * from './graphProtocol.js';
export * from './graphPublisher.js';
export * from './pacingProtocol.js';
export * from './fixedPacing.js';
export * from './renderGraphFrame.js';
export * from './rectGradient.js';
export * from './domRenderer.js';
export * from './channelClient.js';
