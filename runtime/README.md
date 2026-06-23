# `runtime/` — shared TypeScript render-logic package (SOURCE OF TRUTH)

JSON template schema → DOM renderer. Loaded inside the CEF engine page, the
editor preview, and thumbnails — one implementation everywhere (DEVELOPMENT_PROMPT §6).

Built by `build.mjs` (esbuild → IIFE) into `backend/public/bg-runtime.js`,
exposed as `window.BG`.

Populated in **Phase 1** (`feature/phase-1-runtime-*`). Not yet implemented.
