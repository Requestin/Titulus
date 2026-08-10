# Editor transform integrity — TDD evidence

Source plan: `/home/requestin/.cursor/plans/editor-transform-integrity_badffb3e.plan.md`.

## User journeys

- An operator can move or resize every layer without a second position offset after release.
- An operator can edit a keyframed property at the playhead without changing the base value or adjacent keyframes.
- An operator can reset a layer dimension to that layer type's default.
- An operator can reparent a layer or group without a visual world-space jump.

## RED → GREEN

`npm test` in `frontend/` initially failed:

- tracked `x`: expected base `120`, received `480`;
- tracked opacity: expected base `0.42`, received `1`.

After the implementation the same command passes all nine frontend tests.

## Guarantees

| Guarantee | Evidence |
|---|---|
| A tracked transform or opacity edit writes only the current playhead keyframe. | `frontend/src/editor/store.test.ts` |
| Move and all eight resize handles retain the intended edges; rotated resize preserves its opposite geometry. | `frontend/src/editor/transformMath.test.ts` |
| Zoom-independent canvas delta conversion and nested parent matrices are tested. | `frontend/src/editor/transformMath.test.ts` |
| Reparenting preserves translate/rotate/scale world geometry. | `frontend/src/editor/store.test.ts`, `frontend/src/editor/transformMath.test.ts` |
| Rectangle, Text, Image, Video, Clock, and Mask use exported type-specific dimension defaults. | `frontend/src/editor/store.test.ts` |
| Runtime previews use the renderer cache rather than direct editor writes to runtime-owned style properties. | `runtime/src/domRenderer.ts`, frontend/runtime typechecks |

## Commands run

```text
cd frontend && npm test
cd frontend && npm run typecheck
cd frontend && npm run build
cd runtime && npm run typecheck
cd runtime && npm test
```

All commands passed. A browser smoke check on the i7-connected backend confirmed:

- the regular-layer selection rectangle and rendered element had identical DOM bounding boxes;
- Rectangle Width reset changed `123` back to `480`;
- a Rectangle survived Save → reload with its `480×140` geometry and matching selection outline;
- the local Vite build rendered the editor correctly at 45% zoom.

The browser driver could not deliver a native drag gesture to an otherwise non-semantic overlay after temporary test instrumentation; drag behavior is therefore proven by the pure gesture-math regression tests rather than reported as a browser-driver pass. Manual visual confirmation after merge remains the final live verification.

Coverage instrumentation is not configured for the frontend yet. The dedicated
test runner covers the changed state and pure-math paths; React pointer-event
delivery, save/reload, and 2.5D parent transforms remain manual browser checks.
