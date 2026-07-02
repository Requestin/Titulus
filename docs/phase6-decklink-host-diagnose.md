# Phase 6 DeckLink Host Diagnose

Diagnose-only runs on the home Linux dev host (Karen). Goal: confirm that
`engine/src/consumers/decklink_consumer.cpp` can drive real SDI output and that
the LES DG-14B sync generator is recognised as a hardware reference clock.

**Status (2026-07-02):** partial Phase 6.4 closure — visual SDI output and
genlock lock confirmed on this host. Full acceptance (8h soak, Fill+Key,
CasparCG parity) remains out of scope per `docs/phase6-decklink-validation-closure.md`.

---

## Canonical Quad 2 connector numbering (accepted 2026-07-02)

Physical layout on the **DeckLink Quad 2 (W-DLK-30)** bracket, counting from
the **motherboard side** (closest to the PCIe slot) outward:

| Position from MB | Label | Role on this host |
|---|---|---|
| 1 (closest to MB) | **Reference In** | LES DG-14B Black Burst PAL (CCIR-624 / SMPTE-170M) |
| 2 | **SDI #0** | adjacent to Reference In |
| 3 | **SDI #1** | |
| 4 | **SDI #2** | |
| 5 | **SDI #3** | **SDI monitor chain** (SDI→HDMI converter → HDMI monitor) |
| 6 | **SDI #4** | |
| 7 | **SDI #5** | |
| 8 | **SDI #6** | |
| 9 (farthest from MB) | **SDI #7** | |

Connectors are **mini-DIN** (not full-size BNC). The card exposes eight SDI
ports plus one dedicated Reference In — nine connectors total.

```
Motherboard ──► [Ref In][SDI#0][SDI#1][SDI#2][SDI#3][SDI#4][SDI#5][SDI#6][SDI#7]
                  ^sync     ^adjacent              ^monitor (verified output)
```

### SDK mapping (empirical, profile `1dfd`)

| SDK `--device-index` | SDK display name | Physical SDI | Verified output? |
|---|---|---|---|
| 0 | DeckLink Quad (1) | unknown / no physical signal observed | API success only — no visible output on any SDI #0..#7 |
| **1** | **DeckLink Quad (2)** | **SDI #3** | **yes** — colorbars + title + timecode (3× operator-confirmed) |
| 2 | DeckLink Quad (3) | not scanned | — |
| 3 | DeckLink Quad (4) | not scanned | — |
| 4..7 | DeckLink Quad (5..8) | inactive mirrors in `1dfd` | 0 supported output combos |

`/dev/blackmagic/io0..io7` exist as kernel device nodes; the correspondence
between `ioN` and physical SDI #N has **not** been verified on this host —
always use the **empirical SDK `device_index` → physical SDI** table above
for routing decisions.

### Operational command (this host)

```bash
cd /home/requestin/Titulus/engine
./build/Release/bg_engine \
  --url=file:///tmp/test_pattern.html \
  --consumer=decklink \
  --device-index=1 \
  --display-mode=HD1080i50 \
  --keyer=fill_only \
  --fps=50 \
  --duration=60 \
  --cache-dir=/tmp/bg_engine_decklink_smoke
```

Monitor chain must be on **physical SDI #3**. Reference In must carry the
DG-14B Black Burst PAL signal.

---

## Hardware and software

| Item | Value |
|---|---|
| Host | Linux 6.8.0-124-generic (Ubuntu 22.04/24.04) |
| Card | 1 × Blackmagic DeckLink Quad 2 (W-DLK-30) |
| Driver | `blackmagic_io` v16.0.1a2 |
| Userspace | `/usr/lib/libDeckLinkAPI.so` v16.0 — versioned symbols only (`_0002/_0003/_0004`; Sergey `dlsym` fallback in `decklink_consumer.cpp` required) |
| SDK headers | `Blackmagic DeckLink SDK 16.0/Linux/include` |
| Kernel nodes | `/dev/blackmagic/io0..io7` |
| Sync generator | LES DG-14B — Black Burst PAL |
| Monitor chain | SDI #3 → Blackmagic SDI/HDMI converter → HDMI monitor |
| Engine | `engine/build/Release/bg_engine` (`-DBG_ENABLE_DECKLINK=ON`) |
| Profile | `1dfd` (One Sub-device Full Duplex) — default, not changed for final runs |
| Test page | `/tmp/test_pattern.html` — SMPTE color bars + "TITULUS DECKLINK TEST" + rAF timecode |

---

## What was done (chronology)

### Session 2026-07-01 (initial diagnose, superseded wiring)

- Built `bg_engine` with DeckLink enabled on the new home host.
- Ran capability probes; confirmed `EnableVideoOutput` on `device[0]`.
- Sync generator was incorrectly wired to an SDI input (not Reference In).
- `GetReferenceStatus` reported `NONE` on all sub-devices.
- Operator reported signal on an SDI port counted as "7th from bracket" under
  ambiguous BNC numbering — mapping was unreliable.
- **Superseded** by 2026-07-02 sessions below (correct Reference In wiring and
  canonical mini-DIN numbering).

### Session 2026-07-02 (genlock + port mapping)

1. Clarified connector layout: 8 × 3G-SDI mini-DIN + 1 × Reference In mini-DIN
   (W-DLK-30 spec).
2. Rewired sync generator to **Reference In** (closest to MB).
3. Ran `/tmp/bmd_full` capability probe — `bmdReferenceLocked` on device[0]
   and device[4]; devices 0..3 active for output (14 mode/format combos each).
4. Systematic SDI scan while running `bg_engine --device-index=N`:
   - `device_index=0`: API success, **no physical output** on any SDI #0..#7.
   - `device_index=1`: **signal confirmed on SDI #3** (colorbars + title).
5. 60 s genlock run on `device_index=1`: 2995 frames, consumer 0 dropped,
   engine drops 0.334% (vs 0.851% without genlock on 2026-07-01).

### Session 2026-07-02 (operator re-verification)

- Operator confirmed canonical numbering (Ref In + SDI #0..#7 from MB side).
- Repeat 90 s run on `device_index=1` → SDI #3.
- **Operator confirmed: signal visible on SDI #3 again — test successful.**

Log (verbatim, key lines):

```
bg_engine[decklink[1:DeckLink Quad 2]]: reference signal locked
bg_engine[decklink[1:DeckLink Quad 2]]: started mode=HD1080i50 interlaced=yes keyer=fill_only
bg_engine[decklink[1:DeckLink Quad 2]]: telemetry in=4496 scheduled=2253 late=0 dropped=0 flushed=0 overwrite=0
SUMMARY frames=4496 fps=50.00 interval_p50_us=20966 interval_p99_us=27283 interval_p999_us=28387 late=1 drops=0.022%
```

---

## Reference (genlock) status

With DG-14B on Reference In, `IDeckLinkOutput::GetReferenceStatus` reports
`bmdReferenceLocked` (`0x2`) on device[0] and device[4] (mirror peers in
`1dfd`). The consumer log shows `reference signal locked` after ≈5 s warm-up.

Probe snapshot (2026-07-02):

```
device[0] display='DeckLink Quad (1)'  REF status: LOCKED (0x2)
device[1] display='DeckLink Quad (2)'  REF status: NONE/unlocked (0x0)
device[2] display='DeckLink Quad (3)'  REF status: NONE/unlocked (0x0)
device[3] display='DeckLink Quad (4)'  REF status: NONE/unlocked (0x0)
device[4] display='DeckLink Quad (5)'  REF status: LOCKED (0x2)
device[5..7]                            REF status: NONE/unlocked (0x0)
```

---

## Performance summary (genlock locked, `device_index=1`)

| Run | Duration | Frames | Engine drops | Consumer dropped | Consumer late | p50 / p99 / p999 (μs) |
|---|---|---|---|---|---|---|
| 2026-07-01, no Ref In, `device_index=0` | 120 s | 5995 | 0.851% | 0 | 0 | 20865 / 29902 / 30756 |
| 2026-07-02, Ref In, `device_index=1` | 60 s | 2995 | 0.334% | 0 | 0 | 20917 / 28848 / 30526 |
| 2026-07-02, Ref In, `device_index=1` (re-verify) | 90 s | 4496 | **0.022%** | 0 | 0 | 20966 / 27283 / 28387 |

Genlock reduces engine-level late frames versus the no-reference baseline.
DeckLink consumer scheduling shows **0 dropped / 0 flushed / 0 late** on all
2026-07-02 runs.

---

## Confirmed findings

1. **Visual SDI output works** on this host at **physical SDI #3** via
   `--device-index=1`, `HD1080i50`, `fill_only` — operator-confirmed three times
   (initial mapping scan, 60 s run, 90 s re-verification).
2. **Genlock works** with DG-14B Black Burst PAL on Reference In —
   `bmdReferenceLocked` and consumer `reference signal locked`.
3. **Canonical connector numbering** fixed (see top of this document).
4. **Sergey `dlsym` fallback** required on `libDeckLinkAPI.so` v16.0.
5. **Profile `1dfd`** is the correct default; `4dhd` not exposed; `2dhd` tested
   earlier with no benefit for this wiring.

## Open issues

1. **`device_index=0`**: every DeckLink API call succeeds and scheduling
   counters increment, but **no physical output** appears on any SDI #0..#7.
   Not a consumer scheduling bug — separate SDK/profile routing investigation.
   **Workaround:** use empirically verified `device_index=1` for SDI #3.
2. **Stack-smashing on CEF shutdown** (`*** stack smashing detected ***`) —
   teardown-path issue, does not affect output during the run.
3. **Fill+Key (external keyer)** not exercised — only `fill_only`.
4. **Formal Phase 6.4 closure** still requires 8h soak + CasparCG parity per
   `docs/phase6-decklink-validation-closure.md`.

---

## Throwaway artefacts (not in repo)

| Path | Purpose |
|---|---|
| `/tmp/test_pattern.html` | SMPTE bars test page |
| `/tmp/bmd_full.cpp`, `/tmp/bmd_ref.cpp` | Capability + reference probes |
| `/tmp/bg_scan.log` | 60 s mapping run (`device_index=1`) |
| `/tmp/bg_verify.log` | 90 s re-verification run (`device_index=1`) |

Recreate probes from the 2026-07-02 session notes if `/tmp` was cleared.
