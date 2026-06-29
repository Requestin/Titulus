# `runtime/` - shared TypeScript render logic (source of truth)

`@titulus/runtime` converts JSON template payloads into deterministic DOM output.
It is reused by:

- engine runtime page (`channel.html` in CEF),
- frontend editor preview (WYSIWYG),
- monitoring/auxiliary rendering paths.

## Key modules

- `schema.ts`
- `timeline.ts`
- `domRenderer.ts`
- `channelClient.ts`
- `easing.ts`, `transform.ts`, `stackOrder.ts`, `clock.ts`, `fonts.ts`

## Build

```bash
cd runtime
npm run build
```

Output:

- `backend/public/bg-runtime.js` (IIFE, `window.BG`)
