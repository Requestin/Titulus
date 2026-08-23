# P21.8 — Video timeline ADR

**Status:** Accepted  
**Date:** 2026-08-23  
**Base:** current `origin/main` after P21.7/P21.9  
**Blocking tests:** `runtime/tests/videoPlayback.test.ts`, current WebP ingest / `backend/tests/media.test.mjs`

## Decision

Air playback stays on the current animated-WebP path. The timeline may show
and hide a video layer and may keep a start/end visibility window. The air
path does **not** grow `videoProgress`, arbitrary scrub, trim handles, or a
second decoder.

PR-81 is **not** opened. Any other derivative needs a new ADR plus null and
DeckLink 1ch/3ch evidence, alpha/opaque parity, and editor=air proof.

## Options considered

| Option | Verdict |
|---|---|
| A. Current WebP air. Timeline only gates visibility / in-out window. | **Accepted.** Same ingest, same image-element playback, no new hot path. |
| B. Add `videoProgress` and scrub/seek on the WebP image element. | Rejected for Phase 21. No DeckLink proof that seeking an animated WebP stays in lockstep with `one_tick` and does not introduce `(2,0)` or late/drop. |
| C. Native `<video>` + arbitrary currentTime on air. | Rejected. The current validated opaque/alpha profiles are WebP. A media-element clock fights the DeckLink master clock. |
| D. Roll back to VP8/VP9 WebM on air. | **Forbidden.** Phase 21 engine-first rule and this ADR both ban it. |

## Why A

- Ingest already produces a ready WebP derivative. Opaque 50p sources stay on
  the validated 25p WebP profile. Alpha sources keep the alpha profile.
- Playback already uses an image element for animated WebP and a video
  element only for non-WebP derivatives. Those contracts are locked by
  `videoPlayback.test.ts`.
- Phase 21 must not change the engine/runtime hot path without a before/after
  measurement. Video seek is a hot-path change.
- Editor can still display a filmstrip or in/out marks later without sending
  a seek command to air.

## Invariants

- Do not add `videoProgress` to `AnimatableProp` or the renderer.
- Do not promise frame-accurate scrub, trim, or reverse play on air.
- Do not convert live uploads or ready derivatives in place.
- Do not allowlist video layers into the render graph.
- Keep MediaJobs / `media_assets` as the only ingest authority.

## Follow-up (out of Phase 21)

If a later phase wants seek/scrub, it must:

1. Keep WebP as the air derivative. No WebM rollback.
2. Prove editor preview, browser preview, and DeckLink show the same frame
   at the same template clock.
3. Run null 1ch/3ch and DeckLink 1ch/3ch cells of at most 5 minutes with
   zero late/drop/flush/unlock and no directional `single`/`overwrite`
   regression versus the P21.0 envelope.
4. Keep `videoPlayback.test.ts` green.

Until that evidence exists, Control TAKE of a video layer continues to play
the current WebP loop from its natural start, gated only by layer visibility
and the existing timeline.
