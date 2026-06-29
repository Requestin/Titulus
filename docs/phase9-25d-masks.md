# Phase 9 — 2.5D transforms + stack-scoped masks

Phase 9 delivers broadcast-style 2.5D (CSS 3D tilt) and functional stack-scoped masks in `@titulus/runtime`, with editor support and bench scenes for regression.

## Deliverables (PRs 9.1–9.7)

| PR | Scope | Status |
|---|---|---|
| 9.1 | `RenderStats` + dirty-check style writes in `TemplateRenderer` | Merged |
| 9.2 | Compiled timeline tracks + binary search sampling | Merged |
| 9.3 | Stack-scoped masks 2D + mask UI (`маска.txt`) | Merged |
| 9.4 | `rotationX`/`rotationY` in editor + anchor pivot fix | Merged |
| 9.5 | `preserve-3d` + group perspective inheritance | Merged |
| 9.6 | Projected `clip-path` for rotated/tilted masks | Merged |
| 9.7 | Bench scenes + this document | Merged |

## Mask semantics (stack-scoped)

A **mask layer** clips only siblings **below** it in the same stack (`rootStack` or `groupStacks[groupId]`):

- Objects above the mask are unaffected.
- Scope is limited to the stack container (group-local masks do not leak outside the group).
- Nested groups below the mask are included; siblings outside the branch are not.
- **Normal** mode: show content inside the mask bounds (rounded rect or ellipse).
- **Inverted** mode: hide content inside the mask bounds (evenodd polygon hole).
- Animated `x`/`y`/`width`/`height`/rotations on the mask update clipping each frame.

Implementation: `runtime/src/maskScopes.ts`, `runtime/src/maskGeometry.ts`, mount/clip in `domRenderer.ts`.

## 2.5D transforms

- Schema already includes `rotationX`, `rotationY`, `perspective`, `anchorX`, `anchorY`.
- **Pivot model:** `x`/`y` store the anchor position in parent space; DOM `left`/`top` are derived (`transform.ts`).
- Groups set CSS `perspective` and `transform-style: preserve-3d` when the subtree uses 3D.
- Editor: **Tilt X** / **Tilt Y** in the Transform section.

## Bench / regression

Build runtime before mask-stack bench:

```bash
cd runtime && npm run build
```

### 2.5D compositor stress

```bash
engine/build/Release/bg_engine \
  --consumer=null \
  --url="file://$PWD/bench/bench-25d.html" \
  --fps=50 --duration=60 --width=1920 --height=1080
```

### Stack-scoped masks (runtime path)

```bash
engine/build/Release/bg_engine \
  --consumer=null \
  --url="file://$PWD/bench/bench-mask-stack.html" \
  --fps=50 --duration=60 --width=1920 --height=1080
```

Parse the `SUMMARY` line: compare **p50/p99 frame time** and **drops%** to Phase 0 baseline (`docs/PHASE0_BENCH.md`). Phase 9 target: no new sustained drop class vs Phase 0 null consumer at comparable scene complexity.

### Editor HUD stats

On `channel.html`, append `&hud=1` to see per-frame `styleWrites` / `skippedWrites` from Phase 9.1.

## Known limits (MVP)

- 3D mask projection uses a simplified perspective model (`maskGeometry.ts`); extreme perspective may differ slightly from browser compositor ground truth.
- `clip-path: polygon()` on animated masks is more expensive than axis-aligned `overflow:hidden`; prefer axis-aligned masks for dense scenes when possible (§6.5).
- Full CasparCG SDI parity for 2.5D on SDI remains subject to Phase 3 hardware validation.

## References

- Product spec: `docs/new feature/маска.txt` (editor copy; not shipped in repo tarball by default)
- Architecture: `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT_PROMPT.md` §6.5
- Phase 0 bench: `docs/PHASE0_BENCH.md`, `bench/run-bench.sh`
