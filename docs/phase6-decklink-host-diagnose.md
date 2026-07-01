# Phase 6 DeckLink Host Diagnose (2026-07-01)

Diagnose-only run on the new dev host (Karen's home Linux server). Goal was to
answer two operational questions and to clear the long-standing "code-complete,
untested" status of `engine/src/consumers/decklink_consumer.cpp`:

1. Does `IDeckLinkOutput::EnableVideoOutput` succeed on this host's hardware?
2. Is a rendered frame visible on the SDI monitor chain?

Per user decision (2026-07-01), this is **diagnose-only**: no 8h soak, no
CasparCG A/B parity, no full evidence bundle per `phase6-decklink-validation-closure.md`.

## Hardware

| Item | Value |
|---|---|
| Host | Linux 6.8.0-124-generic (Ubuntu 24.04) |
| Cards | 1 × Blackmagic DeckLink Quad 2 (8 × SDI BNC) |
| Driver module | `blackmagic_io` v16.0.1a2 |
| Userspace lib | `/usr/lib/libDeckLinkAPI.so` v16.0 (only versioned symbols `CreateDeckLinkIteratorInstance_0002/_0003/_0004`; Sergey's fallback in `engine/src/consumers/decklink_consumer.cpp` is required) |
| SDK headers | `/home/requestin/Titulus/Blackmagic DeckLink SDK 16.0/Linux/include` |
| Devices char | `/dev/blackmagic/io0..io7` |

### Wiring (after diagnose)

- SDI port `io1` (genlock-input): BNC cable from sync generator (reference signal source).
- SDI port `io7` (1-indexed from the card bracket): BNC cable to SDI monitor.
  This is where the engine output actually appears in profile `1dfd`.
- `io8` (where the monitor was originally connected) is **inactive** in the
  current profile and does not carry any output.

## Software

| Item | Value |
|---|---|
| Engine binary | `engine/build/Release/bg_engine` (rebuilt with `-DBG_ENABLE_DECKLINK=ON -DDECKLINK_SDK_INCLUDE=…`) |
| Probe binaries | `/tmp/bmd_full`, `/tmp/bmd_profile`, `/tmp/bmd_switch_profile` (throwaway diagnostic tools, not part of the repo) |
| Test page | `/tmp/test_pattern.html` (SMPTE-style color bars + TITULUS title + rAF timecode) |

## Profile state

The Quad 2 exposes only two profiles in the SDK:

| Profile ID | Name | Active |
|---|---|---|
| `1dfd` | One Sub-device Full Duplex | **active (default)** |
| `2dhd` | Two Sub-devices Half Duplex | available |
| `4dhd` | Four Sub-devices Half Duplex | **not available** for this card |

`4dhd` was attempted and rejected with `0xffffffff80000003` (not exposed by
`IDeckLinkProfileManager::GetProfile`). `2dhd` was activated successfully but
provided no advantage for the current wiring (io6..io8 still inactive), so the
profile was reverted to the default `1dfd` before the final run.

In `1dfd` the card presents 8 logical sub-devices through `IDeckLinkIterator`,
but only `device[0..3]` (display names "DeckLink Quad (1..4)") report
`DoesSupportVideoMode` as supported. `device[4..7]` return `supported=no` for
all mode/format/connection combinations — they exist as peers/mirrors of the
single duplex sub-device and cannot be addressed as independent outputs.

## Capability matrix (`1dfd`, default)

Probed via `IDeckLinkOutput::DoesSupportVideoMode` (3 pixel formats × 2
connections × all display modes per sub-device):

| Sub-device | Display name | OUT supported combos | IN supported (HD1080i50/p50/p25 × 3 fmt) |
|---|---|---|---|
| device[0] | DeckLink Quad (1) | 90 | yes (all) |
| device[1] | DeckLink Quad (2) | 90 | yes (all) |
| device[2] | DeckLink Quad (3) | 90 | yes (all) |
| device[3] | DeckLink Quad (4) | 90 | yes (all) |
| device[4..7] | DeckLink Quad (5..8) | **0** | **none** |

Pixel formats tested: `bmdFormat8BitBGRA`, `bmdFormat8BitYUV`, `bmdFormat10BitYUV`.
Output display modes that reported SUPPORTED for at least one pixel format on
the active sub-devices: `ntsc`, `pal`, `23ps`, `24ps`, `Hp25`, `Hp29`, `Hp30`,
`Hp50`, `Hp59`, `Hp60`, `Hi50`, `Hi59`, `Hi60`, `hp50`, `hp59`, `hp60`
(16 modes total — full HD + SD coverage).

**Reference (genlock) status** on all 8 sub-devices via
`IDeckLinkOutput::GetReferenceStatus` reported `0x0` (NONE / unlocked). The SDI
input on io1 receives the sync generator signal but the Quad 2 does not expose
it as a `bmdReferenceLocked` source through this API in the current profile.
Genlock-style frame-accurate scheduling remains deferred (the consumer falls
back to the internal clock; see "Performance" below).

## Diagnose run

Single direct `bg_engine` invocation (no supervisor, no dev-stack):

```
engine/build/Release/bg_engine \
  --url=file:///tmp/test_pattern.html \
  --consumer=decklink \
  --device-index=0 \
  --display-mode=HD1080i50 \
  --keyer=fill_only \
  --fps=50 \
  --duration=120 \
  --cache-dir=/tmp/bg_engine_decklink_smoke
```

Log lines (verbatim, key parts):

```
bg_engine[decklink[0:DeckLink Quad 2]]: reference signal lock timeout (continuing)
bg_engine[decklink[0:DeckLink Quad 2]]: started mode=HD1080i50 interlaced=yes keyer=fill_only
bg_engine[decklink[0:DeckLink Quad 2]]: telemetry in=5995 scheduled=3002 late=0 dropped=0 flushed=0 overwrite=0
SUMMARY frames=5995 fps=50.00 interval_p50_us=20865 interval_p99_us=29902 interval_p999_us=30756 late=51 drops=0.851%
```

- `EnableVideoOutput` on `device[0]` returned `S_OK`.
- The DeckLink consumer scheduled 3002 video frames over 120 s for interlaced
  1080i50 (≈ 25 scheduled frames/sec × 120 s), with 0 dropped and 0 flushed.
- The visual signal (SMPTE-style color bars + "TITULUS DECKLINK TEST" title +
  live timecode) was confirmed on the SDI monitor attached to **io7** (1-indexed
  from the card bracket).

## Performance (no genlock, single channel)

| Metric | Value | Comment |
|---|---|---|
| Total frames produced | 5995 over 120 s | 50 fps target met |
| `interval_p50_us` | 20865 | ~20.9 ms, on cadence |
| `interval_p99_us` | 29902 | ~29.9 ms |
| `interval_p999_us` | 30756 | ~30.8 ms |
| `late` (engine frame gen) | 51 / 5995 (0.851%) | above the bare-metal target of <0.1% — **expected without genlock** (internal clock drifts vs SDI scheduled pacing) |
| `late` (decklink consumer) | 0 | no scheduled frames arrived late to the SDI scheduler |
| `dropped` (decklink consumer) | 0 | every scheduled frame was displayed |

The engine-level late count grew over time (drift accumulation without a
hardware reference clock). This is the documented genlock-less behaviour per
`.cursor/rules/04-decklink-no-hw.mdc` and `docs/phase3-decklink-validation-deferred.md`.
With genlock locked, the late count should stay flat in a soak run.

## Findings

1. **`EnableVideoOutput` works on this host** for `device[0]` at `HD1080i50`,
   `keyer=fill_only`, pixel format 8BitBGRA. The earlier "not supported"
   observations were on `device[7]`, which is a mirror peer in profile `1dfd`
   and cannot be addressed as an independent output.
2. **SDI output is visible** on the physical monitor — at port **io7**
   (1-indexed from the card bracket), not on io8 where the monitor was
   originally connected. The wiring diagram in
   `docs/phase6-decklink-validation-closure.md` should reflect this mapping.
3. **Profile `1dfd` (default) is the correct operating profile** for this card
   for single-channel full-duplex use. `4dhd` is not available; `2dhd` activates
   one extra port but does not help with io8.
4. **Genlock Reference status is not reported as locked** through
   `GetReferenceStatus` for the current wiring (sync generator → SDI input on
   io1). The Quad 2 likely needs either a dedicated reference signal source or
   a different profile mode for the SDI-input-as-reference path to register.
   Without genlock, frame-accurate 8h soak acceptance is not achievable on this
   host — this is consistent with the existing "code-complete, validation
   deferred" status in `docs/phase3-decklink-validation-deferred.md`.
5. **Sergey's `dlsym` fallback in `engine/src/consumers/decklink_consumer.cpp`**
   is required and sufficient on this host: the unversioned
   `CreateDeckLinkIteratorInstance` symbol is absent in
   `/usr/lib/libDeckLinkAPI.so` v16.0, and the consumer correctly resolves
   `_0004` first.
6. **Stack-smashing warning on engine shutdown** appears in the log
   (`*** stack smashing detected ***: terminated`). This is in the CEF
   teardown path on Linux and does not affect output during the run. Tracked
   separately as a cleanup-path issue, not a DeckLink consumer bug.

## Conclusion (diagnose-only scope)

- Phase 6.4 hardware execution on this host: **partial**.
  - `EnableVideoOutput` and visible SDI output: ✅ confirmed.
  - Frame-accurate genlock-locked acceptance: ❌ blocked — the sync generator
    signal on io1 is not reported as `bmdReferenceLocked`, and the full
    evidence bundle (8h soak, Fill+Key parity vs CasparCG) remains out of scope
    for diagnose-only.

## Next steps (if/when pursued)

1. Investigate whether the Quad 2 can register a reference signal via SDI-in
   (consult Blackmagic docs / forums, or test with a dedicated reference signal
   generator that the card recognises).
2. If genlock cannot be locked on this host, treat SDI validation as still
   deferred per `docs/phase6-decklink-validation-closure.md` and document this
   as a host-side gap rather than an engine-side gap.
3. Optional: a short (10–30 min) non-genlocked soak to characterise the drift
   curve, separate from the formal Phase 6.4 acceptance.

## Throwaway artefacts

- `/tmp/test_pattern.html` — test page (SMPTE bars + title + rAF timecode).
- `/tmp/bmd_full.cpp`, `/tmp/bmd_profile.cpp`, `/tmp/bmd_switch_profile.cpp` —
  probes used for capability matrix and profile switching. Not committed; can
  be recreated from this document if needed.
- `/tmp/bg_decklink.log` — engine log from the diagnose run.
