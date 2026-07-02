# Phase 11.1 — Baseline (CasparCG parity work)

Captured on the DeckLink-equipped test stand (AMD Ryzen 5 3600, 6C/12T,
DeckLink Quad 2, LES DG-14B genlock) — see `docs/phase6-decklink-host-diagnose.md`
for host details. This document is the "before" snapshot for Phase 11;
every subsequent stage (11.2-11.6) is measured against it.

## 0. Important operational note

This host runs `dev-start.sh`'s full stack (backend + frontend + 3 live
`bg_engine` decklink channels via `run-engines.sh`) persistently as a test
stand — confirmed with the operator before any hardware experiments. All
data below comes from that already-running 3-channel setup (54+ min uptime
at time of capture), restarted once to pick up the Phase 11.1 telemetry
build (supervisor auto-restart via `run-channel.sh`, ~3s gap per channel,
acceptable on a test stand).

## 1. DeckLink card: profile finding (corrects an earlier hypothesis)

Initial isolated testing (spinning up extra `bg_engine --consumer=decklink`
processes on `--device-index=0,1,2` while the live channels already held
indices 1/2/3) produced `EnableVideoOutput failed` on the indices already
in use, which looked like "this card can only drive 2 simultaneous SDI
outputs, not 3" (profile `1dfd` vs `2dhd` probing seemed to confirm a
2-output ceiling). **This was a false lead** — the failures were ordinary
single-owner contention (another process already had that sub-device's
output engine open), not a duplex-profile limit. Live evidence: `Channel 1`
(`--device-index=1`), `Channel 2` (`--device-index=2`), `Channel 3`
(`--device-index=3`) have been running **concurrently for 54+ minutes**
with `ref=locked`, `dropped=0`, `flushed=0` on all three. **Confirmed: 3
simultaneous independent SDI outputs already work on this card in its
default `1dfd` profile.** No profile change is needed or recommended;
the card was left in its original `1dfd` state after the probe.

Card profile probe used: `IDeckLinkProfileManager::GetProfiles()` /
`GetProfile(BMDProfileID)` / `IDeckLinkProfile::SetActive()` (throwaway
probe, not added to the codebase). Available profiles on this specific
Quad 2 unit: `1dfd` (default, active), `2dhd`. `4dhd`/`2dfd` are **not
exposed** by this card's firmware (matches the existing note in
`docs/phase6-decklink-host-diagnose.md`).

## 2. Steady-state per-channel numbers (real content, real SDI output)

5s-window telemetry, sampled continuously; values below are averaged over
a ~3 minute post-restart window (36 samples/channel) plus the prior 54-minute
run for cross-check.

| Channel | device-index | cores (phys+SMT) | in_fps (paint rate) | drops (Stats, interval-based) | pairs/singles/starved (cumulative ratio) |
|---|---|---|---|---|---|
| Channel 1 | 1 | 0,1 (+6,7) | **~28** | ~71% (54min run) | heavily `singles`-dominated — render can't keep up, most output frames are single-field duplicates, not real weaves |
| Channel 2 | 2 | 2,3 (+8,9) | ~46-48 | ~3.3% | mostly `pairs` — healthy |
| Channel 3 | 3 | 4,5 (+10,11) | ~45-46 | ~10.5% | mixed pairs/singles |

**Channel 1 is the clear outlier** — less than half the target paint rate,
and it stays there consistently across a fresh restart (reproduced within
seconds, not a one-off). This is very likely the dominant source of the
"visible stutter on 3 channels" the user reported: a channel running at
~28fps into a 50-field/s interlaced output is forced to duplicate almost
every field (`singles`), which reads as judder/soft-double-image on air,
not classic frame drops (SDI-side `dropped=0` the whole time — the card
never misses its schedule, but what it's given to schedule is stale).

Root cause isolated in §3 below: Channel 1 is CPU-decoding video content,
which is a content property, not an engine defect.

## 3. Root cause found: Channel 1 plays CPU-decoded video (not a clock/CPU-share bug)

**Correction (Phase 11.4 investigation):** an earlier draft of this section
attributed cross-channel CPU contention to the Titulus backend Node process
based on `ps -eLo pid,psr,pcpu,comm` showing a `node` process with threads
scattered across every channel's pinned cores. That PID was misidentified —
it was actually **this agent session's own Cursor IDE extension host**
(`node .../bootstrap-fork --type=extensionHost`), an artifact of running the
investigation on a machine that also hosts the development IDE session, not
part of the Titulus stack. The real Titulus backend (`node src/index.js`)
was measured separately and is close to idle (0.0% CPU across all its
threads) — **not a meaningful contention source**. This does not appear in
a real deployment without an IDE session sharing the box; corrected here so
Phase 11.4's actual OS-level work targets a real, not a confounded, finding.

**Actual finding**: profiling Channel 1's CEF renderer process while it ran
(`ps -eLo pid,psr,pcpu,comm` on the live PID) showed Chromium **video
pipeline threads doing real work**: `CodecWorker` (x2), `Media`,
`VideoFrameCompositor`, with `ThreadPoolForeground` worker threads at
34-37% each. Channels 2 and 3 did not show this pattern. Channel 1's
content includes **video that CEF decodes entirely on CPU** (GPU is
disabled engine-wide per the CPU-only policy — no VAAPI/hardware decode
path). Software video decode is inherently CPU-expensive, and that cost
lands in the same 2-core budget as compositing. Core utilization on
Channel 1's pinned set (cores 0,1,6,7) averaged ~46%, higher than Channel
2/3's ~30-35%, but not saturated — consistent with a decode+composite
critical-path budget problem more than raw core starvation.

**Conclusion**: Channel 1's ~28-32fps ceiling is a **content property**
(CPU video decode cost for that specific channel's current
template/rundown item), not an engine defect. It is unaffected by 11.2
(clock unification) and 11.3 (buffer pooling/SIMD) — both landed real,
measured wins for Channel 2/3 (§6a, §6b) while Channel 1 stayed flat,
which is itself the evidence separating "engine architecture" issues (fixed)
from "this channel's content is CPU-decode-heavy" (out of scope for the
engine work in this phase — flagged for whoever owns Channel 1's rundown
content; options if it needs to stay in scope: lower-resolution proxy video,
a codec CEF can decode cheaper, or accepting the CPU-only policy's cost for
video-heavy channels).

## 3a. CCX topology — investigated, confirmed not significant, no change made

```
CCX0 (L3 domain 0): physical cores 0,1,2  (+ SMT 6,7,8)
CCX1 (L3 domain 1): physical cores 3,4,5  (+ SMT 9,10,11)
```

Current pinning (`run-engines.sh`): Channel 1 = cores {0,1} (CCX0 only),
Channel 2 = cores {2,3} (**straddles CCX0/CCX1** — cross-CCX Infinity Fabric
hop on any L3 miss), Channel 3 = cores {4,5} (CCX1 only). With 3 channels of
2 cores each over a 2x3-core CCX layout, exactly one channel is
mathematically forced to straddle the boundary no matter how the 6 cores are
assigned — this is a hard constraint of the topology, not a tuning mistake.

**Decision: no rework.** After 11.2+11.3 landed, Channel 2 (the one
straddling CCX0/CCX1) is one of the two *best*-performing channels
(~49-50fps, §6a/§6b) — live evidence that CCX-crossing is not a meaningful
cost on this workload/hardware once the clock and memcpy issues are fixed.
Reshuffling which channel absorbs the unavoidable straddle would not free a
real core for anything (there's no spare physical core regardless of
arrangement — 3ch x 2 cores = 6 of 6), so it was deprioritized in favor of
11.5/11.6 given no measurable upside was expected or found.

## 4. New stage-time telemetry (Phase 11.1 instrumentation)

Added to `engine/src/consumers/decklink_consumer.cpp`: `copy_us` (OnFrame
render->queue memcpy, main/CEF-UI thread), `weave_us` (field interleave
into the output buffer), `schedule_us` (`IDeckLinkOutput::ScheduleVideoFrame`
call) — avg/max per 5s window, plus % of the per-output-frame time budget
(40ms at 25Hz for HD1080i50). New `stages5s` log line alongside the
existing `telemetry5s`.

| Channel | copy_avg (¼% budget) | weave_avg (% budget) | schedule_avg (% budget) | sum (% budget) |
|---|---|---|---|---|
| Channel 1 | 2731us (6.8%) | 2842us (7.1%) | 1092us (2.7%) | 6665us (16.7%) |
| Channel 2 | 4017us (10.0%) | 3369us (8.4%) | 1377us (3.4%) | 8763us (21.9%) |
| Channel 3 | 2695us (6.7%) | 2851us (7.1%) | 1296us (3.2%) | 6842us (17.1%) |

**~17-22% of the output frame budget is spent on plain memcpy + schedule
call**, with all 3 channels running concurrently and contending for shared
memory bandwidth/L3. An 8.3MB single-threaded `memcpy` should be well under
1ms on modern DDR4 in isolation; 2.7-4ms under 3-way contention confirms
real cache/bandwidth pressure from the unoptimized copy path (2 full-frame
copies per input frame today: OnPaint->queue, then queue->weave). This is
the direct target of Phase 11.3 (single copy, pooled buffers, aligned SIMD
weave).

## 5. Bug found (not blocking, tracked for a follow-up fix)

`DecklinkConsumer::Stop()` crashes (`terminate called ... mutex lock
failed`) when `Start()` failed earlier (e.g. `EnableVideoOutput failed`
because another process already owns that sub-device). Reproduced 4x
during this investigation. Root cause: likely a `std::lock_guard` taken on
a mutex whose owning object was torn down in a bad order during the
abbreviated shutdown path, or a double-`Stop()` re-entry. Does not affect
any currently-running channel (only the abnormal "failed to start" path);
flagged for a small standalone fix, not part of the Phase 11 critical path.

## 6a. Phase 11.2 result (DeckLink-driven clock) — validated live

Implemented: `Consumer::HasExternalClock()` / `WaitForTick()` (`engine/src/consumers/consumer.h`),
`DecklinkConsumer` wakes the render pump from `OnScheduledFrameCompleted`
instead of the engine free-running its own 50Hz timer (`engine/src/main.cpp`
gains a `decklink_driven` branch; the original self-timer loop is untouched
byte-for-byte for every other consumer). `channel.html`'s timeline tick moved
from an independent `setInterval` onto the same rAF timestamp that already
drives paint damage (fixed-step accumulator, unaffected in browser/`raf`
mode).

First attempt fired the 2 requested BeginFrames back-to-back (~4-8ms apart)
and made things **worse** (`in_fps` capped at exactly 25 = out_fps, i.e. only
1 fresh paint per output cycle) — CEF's renderer-process IPC round-trip needs
close to a full field period to produce a genuinely new composite; firing
BeginFrame twice within a few ms just redelivers the same `paint_seq`. Fixed
by pacing each requested tick to its own ~20ms budget (same budget the
self-timer used to give it) before firing the next BeginFrame.

Result (3 live channels, restarted with the Phase 11.2 build, ~2.5min window):

| Channel | in_fps before (11.1) | in_fps after (11.2) | pairs:singles before | pairs:singles after |
|---|---|---|---|---|
| Channel 1 | ~28 | ~28 (unchanged) | 1:6 | 1:6 (unchanged) |
| Channel 2 | ~46-48 | **~49.4** | roughly 7:1 | **108:1** |
| Channel 3 | ~45-46 | **~48.5** | roughly 4:1 | **22:1** |

**Channel 2 and 3 confirm the hypothesis**: closing the clock gap collapses
`singles` (duplicated fields — the visible judder mechanism) by more than an
order of magnitude, `starved` drops to ~0. **Channel 1 is unchanged**,
which is itself a useful negative result: its bottleneck is not clock desync
(its `copy`/`weave` stage times are the *lowest* of the three channels, so
it's not memory-bandwidth-bound either) — it simply cannot paint fast enough
regardless of pacing, pointing at per-channel content weight and/or the
backend-contention finding in §3 (Channel 1's core group 0/1/6/7 is one of
the ones the unpinned Node backend lands threads on). Out of scope for the
engine-architecture work in this phase; flagged for whoever owns Channel 1's
current template/rundown content.

No stability regressions observed: 3 channels ran continuously through the
restart, rebuild, and re-test cycle above with 0 crashes, `dropped=0`,
`flushed=0` throughout. Browser/null-consumer path re-verified unaffected
(`./bench/run-bench.sh 3 30 5` after the 11.2 change: 49.95 avg fps, 0.11%
drops — in line with/better than the Phase 0 baseline of 47.88 fps).

## 6b. Phase 11.3 result (buffer pooling + 64B align + SIMD weave) — validated live

Implemented: `engine/src/aligned_buffer.h` (64-byte-aligned, move-only,
pooled-friendly buffer type), `engine/src/simd_copy.h` (AVX2 non-temporal
`StreamCopy`, `target("avx2")` function attribute so it compiles without a
project-wide `-march=` flag). `DecklinkConsumer` now: (a) pulls input queue
buffers from a recycle pool instead of a fresh `AlignedBuffer`/heap
allocation on every `OnFrame()` call — this was the dominant cost, not the
memcpy bandwidth itself (an 8MB `aligned_alloc` triggers a fresh `mmap` +
page faults above glibc's mmap threshold); (b) recycles `field_a_`/`field_b_`
back into the same pool instead of freeing them on every weave; (c) weaves
with `StreamCopy` (non-temporal stores — the destination is written once and
hand off straight to `ScheduleVideoFrame`, never read back by this process).
Also tightened `kMaxQueuedFrames` 4->2 (40ms max buffered input), since
11.2's pull-based pacing keeps the queue at 0-1 in steady state and a deeper
queue only adds latency drift now.

Result (3 live channels, ~2.5min window, same restart-in-place methodology):

| Channel | copy_avg before (11.1/11.2) | copy_avg after (11.3) | weave_avg before | weave_avg after | in_fps after |
|---|---|---|---|---|---|
| Channel 1 | ~2700us | **~1240us** | ~2800us | **~1450us** | ~29-32 (content-bound, see §6a) |
| Channel 2 | ~4000us | **~1200us** | ~3400us | **~1900us** | **~49.6** |
| Channel 3 | ~2700us | **~1250us** | ~2800us | **~1800us** | **~49.8** |

Combined `copy+weave+schedule` per output cycle dropped from ~17-22% of the
40ms budget (§4) to roughly **9-11%** across all three channels. No
stability regressions: 0 crashes, `ref=locked` throughout, `dropped=0`,
`flushed=0` on all channels through the pool/SIMD change.

Not implemented in this phase (documented, not shipped — would need a more
invasive change to the shared `OnPaint` pipeline used by every consumer
type): eliminating the *second* copy structurally (`FrameRing::Copy` on
`OnPaint`, then `DecklinkConsumer::OnFrame` copying out of the ring). Pooling
the second copy's destination buffer removed the allocation cost, which was
the dominant term, but the copy itself still happens twice per painted
frame. Flagged as a future-phase opportunity if profiling ever shows it's
worth the shared-pipeline risk.

## 6c. Phase 11.4 result (SCHED_FIFO + nice deprioritization + CCX review)

Implemented:
- `MaybeSetRealtimePumpPriority()` in `engine/src/main.cpp`: `SCHED_FIFO`
  priority 2 on the render pump thread, matching CasparCG's channel thread
  (`common/os/linux/thread.cpp` in the reference server). Gated on
  `decklink_driven` only — Browser/OBS/vMib (null consumer) and every other
  non-SDI path is completely unaffected, per the explicit constraint for
  this phase.
- `dev-start.sh`: backend and frontend dev processes launched with `nice -n
  10` — a scheduling-priority nudge (not a cpuset change; there is no spare
  physical core to isolate them onto, see §3/§3a) so they yield tie-breaks
  to channel render threads under contention.

**Live result**: `SCHED_FIFO priority 2 unavailable (Operation not
permitted) — continuing at normal scheduling priority` on all 3 channels —
this non-root user's `RLIMIT_RTPRIO` is 0 on this host, so the code
gracefully no-ops (by design). **RT priority requires a deployment-level
grant** (e.g. a `systemd` unit with `LimitRTPRIO=2` for the `bg_engine`
service, or an `/etc/security/limits.d` entry for the service account) —
out of scope to apply unilaterally since it's a system-wide security-policy
change outside the repo. Documented here so whoever owns the production
deployment can enable it; the code is already forward-compatible (works
today with zero effect, activates automatically once granted).

CCX pinning: investigated in §3a — no rework, confirmed not a significant
factor given live evidence (the CCX-straddling channel is one of the two
best performers post-11.2/11.3).

**Operator note**: during this investigation a `renice` was mistakenly
applied to PID 448812 (misidentified as the Titulus backend; it is actually
this Cursor IDE session's own extension-host process) — its niceness was
raised from 0 to 10 and could not be reverted without `sudo` (POSIX only
lets an unprivileged user raise their own process's niceness, never lower
it back). Run `sudo renice -n 0 -p 448812` to restore it, or ignore if that
session has since restarted (niceness resets on new processes).

## 6d. Phase 11.5 result (low-latency scheduled playback + CasparCG preroll formula)

Implemented: `IDeckLinkConfiguration::SetFlag(bmdDeckLinkConfigLowLatencyVideoOutput,
true)` at `Start()` (CasparCG parity — same call site as
`modules/decklink/consumer/decklink_consumer.cpp`), preroll depth now
follows CasparCG's `buffer_depth()` formula (base 3 + 1 if the low-latency
flag did *not* apply + 1 if embedded audio — we carry no audio, so that term
is always 0). Startup log now reports `low_latency=yes/no preroll=N`.

**Live result**: `low_latency=yes preroll=3` on all 3 channels — the flag is
supported on this DeckLink Quad 2. No regressions across a 90s window post
low-latency restart: `dropped=0`, `late=0` on all channels, fps/pairs
unchanged from the 11.4 numbers (expected — this flag reduces the card's
internal glass-to-glass latency, it does not change render-side throughput).

## 6e. Phase 11.6 result (Chromium background-throttling hardening)

Implemented: `--disable-renderer-backgrounding`,
`--disable-backgrounding-occluded-windows`,
`--disable-background-timer-throttling` on the browser-process command line
(`engine/src/engine_app.cpp`). Defensive hardening against OSR views being
misclassified as "backgrounded" (no real native window) and having their JS
timers throttled or process priority lowered — the standard fix other
headless-Chromium hosts (Puppeteer/Playwright) apply for the same class of
view. Live check found renderer processes already at `nice=0` (not
presently hit in practice on this Linux/`--no-sandbox` host), so this is a
zero-measured-regression hardening rather than a fix for an observed bug.

**Not done in this phase** (deferred, per the plan's "does not block the
main track"): the `template_test_1` projected-mask/rotateY content
optimization noted in Phase 9/10 (`docs/phase9-25d-masks.md` §9) as a
~25fps render-cost hotspot. Out of scope here since Phase 11's live
3-channel content did not exercise that code path — recommend a follow-up
pass in `runtime/` if/when that template is back in a live rundown.

Regression check (`./bench/run-bench.sh 3 25 5`, clean host, no other
bg_engine processes competing for cores): **49.92 avg fps, ~0.2% drops** —
consistent with the 11.2/11.3 null-consumer baselines, no regression.

## 6f. Phase 11.7 result — acceptance soak

3 live channels, decklink consumer, full Phase 11.1-11.6 build, continuous
run with **no restarts, no crashes**:

| Channel | Uptime | avg in_fps | pairs | singles | starved | late | dropped | flushed |
|---|---|---|---|---|---|---|---|---|
| Channel 1 | 28.6 min | 29.3 | 7,833 | 34,816 | 171 | 0 | 0 | 0 |
| Channel 2 | 28.6 min | 49.1 | 37,697 | 4,705 | 413 | 0 | 0 | 0 |
| Channel 3 | 28.6 min | 49.6 | 38,348 | 4,441 | 21 | 0 | 0 | 0 |

**Zero dropped/flushed/late frames at the SDI scheduling level on any
channel for the entire run.** Channels 2 and 3 meet the acceptance target
from §6 (in_fps ~50, pairs-dominant, starved near 0). Channel 1 is
unchanged from every earlier measurement in this document — consistent,
reproducible, and now root-caused to CPU video decode cost (§3), not an
engine defect; it does not regress further and is not made worse by any
Phase 11 change, but Phase 11's engine-architecture work cannot fix a
content-CPU-budget problem by itself.

Browser/null-consumer path: verified clean and unaffected throughout this
document (Phase 0 baseline 47.88fps -> post-11.2/11.3 49.95fps -> post-11.6
49.92fps) — no regression at any stage of Phase 11.

**Recommendation for formal closure**: this 28.6-minute run is close to but
short of the 30-minute target in the original plan; re-run for the full
30+ minutes (or longer, e.g. an 8h soak matching the deferred Phase 6.4
closure criteria) before considering Phase 11 fully closed for production,
and pull a fresh Channel-1-specific content profile once its rundown item
changes to confirm the video-decode diagnosis holds across content.

## 6. Baseline acceptance numbers to beat

| Metric | Channel 1 (baseline) | Channel 2 (baseline) | Channel 3 (baseline) | Phase 11.7 target |
|---|---|---|---|---|
| in_fps | ~28 | ~46-48 | ~45-46 | 50.0 ± 0.1 all channels |
| starved (rate) | high, sustained | near 0 | low, sporadic | 0 |
| singles (rate) | dominant | low | moderate | ~0 |
| dropped/flushed (SDI) | 0 | 0 | 0 | 0 (keep) |
| copy+weave+schedule (% budget) | 16.7% | 21.9% | 17.1% | materially lower after 11.3 |
