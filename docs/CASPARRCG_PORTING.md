# CASPARRCG_PORTING.md — CasparCG → Titulus `bg_engine` porting map

> Источник истины для портирования render plane из CasparCG в наш proprietary
> `bg_engine`. Обновлять по мере реализации каждого модуля (Phase 0 → Phase 5).
>
> **Стратегия коммпланса (§0.1):** *reimplement by reference*. Изучаем алгоритмы
> CasparCG (GPLv3+), пишем свой код. Прямое дословное копирование GPL-кода в
> закрытый продукт avoided; исключения отмечены в `THIRD_PARTY_NOTICES.md` с
> legal-review пометкой. Имена функций/структур адаптированы под Titulus.

**CasparCG reference checkout:**
- Path: `/root/Titulus/CasparCG/server`
- `git describe`: `v2.3.3-lts-stable-436-gd603ee91f` (trunk toward **2.6.0 Dev**)
- CMake project version: `2.6.0 Dev` (last shipped release: 2.5.0 Stable)
- C++ standard: **C++20** (enforced centrally in `CMakeModules/CasparCG_Util.cmake`)
- CMake min: 3.16
- Release .deb on dev server: `CasparCG/casparcg-server-2.5_*.deb` + `casparcg-cef-142_*.deb` (Ubuntu Noble 24.04)

---

## 1. Принципиальная модель

Titulus `bg_engine` = **reimplementation of one CasparCG channel** (HTML producer +
consumers), а не новой парадигмы рендера. Model кадра та же:

```
Producer (CEF HTML) → [channel-paced pull] → Consumer (decklink / ffmpeg / null / pipe / preview)
        OnPaint → BGRA frame → ring → consumer schedules output
```

Отличия от CasparCG (не рендер-существенные):
- Control protocol: наш **WebSocket** `take/update/clear` вместо AMCP (TCP 5250)
- Templates: наш **JSON schema → DOM** вместо raw `.html` файлов
- Process model: **1 `bg_engine` = 1 channel** (CasparCG = one server, many channels)

---

## 2. Porting map: CasparCG file → Titulus target → статус

| CasparCG source (relative to `src/`) | Titulus target | Что переносим | Статус | Phase |
|---|---|---|---|---|
| `modules/html/html.cpp:171-211` | `engine/src/engine_app.cpp` (`OnBeforeCommandLineProcessing`) | Switches: `disable-gpu`, `disable-gpu-compositing`, `disable-gpu-vsync=gpu`, `ozone-platform=headless` (no DISPLAY), `enable-begin-frame-scheduling`, `autoplay-policy`, `disable-web-security` | ✅ done | 0.3 |
| `modules/html/html.cpp:227-282` | `engine/src/main.cpp` (`CefInitialize`/`CefRunMessageLoop`/`CefShutdown`) | CEF lifecycle: `CefSettings` (`windowless_rendering_enabled=true`, `no_sandbox=true`), per-channel `cache_path`, `CefExecuteProcess` sub-process guard | ✅ done | 0.3 |
| `modules/html/producer/html_producer.cpp:347-399` | `engine/src/engine_client.cpp` (`OnPaint`) | OSR OnPaint: `PET_VIEW` filter, `pixel_format::bgra`, single `memcpy` BGRA (Linux), bounded frame queue | ✅ done | 0.3 |
| `modules/html/producer/html_producer.cpp:657-668` | `engine/src/engine_client.cpp` (browser create) | `CefWindowInfo.SetAsWindowless`, `windowless_rendering_enabled=true`, `windowless_frame_rate=ceil(fps)`, `CefBrowserHost::CreateBrowser` | ✅ done | 0.3 |
| `modules/html/producer/html_producer.cpp:~220-280` (`try_pop`, field handling) | `engine/src/engine_client.cpp` / consumer | Field-aware frame pull (delays lone field A) — **для 1080i** | ⏳ todo | 0.3/3 |
| `modules/html/producer/html_cg_proxy.cpp` | **n/a** (WS protocol) | CasparCG CG add/update/play/stop → у нас WS `take/update/clear` (другой протокол, semantic equivalence) | n/a | — |
| `modules/decklink/consumer/decklink_consumer.cpp:910-1030` (`ScheduledFrameCompleted`) | `engine/src/consumers/decklink_consumer.cpp` | **Сердце pacing**: callback re-scheduling, `bmdOutputFrameDisplayedLate`→skip-ahead, pop 2 frames for interlace, `schedule_next_video` | ✅ done | 3.1 |
| `modules/decklink/consumer/decklink_consumer.cpp:766-798` (preroll + start) | `engine/src/consumers/decklink_consumer.cpp` | Preroll N black frames + `wait_for_reference_lock`, `StartScheduledPlayback(0, time_scale, 1.0)` | ✅ done | 3.1 |
| `modules/decklink/consumer/decklink_consumer.cpp:152-198` (`set_keyer`) | `engine/src/consumers/decklink_consumer.cpp` | `IDeckLinkKeyer::Enable(external/internal)` + `SetLevel(255)` | ✅ done | 3.1 |
| `modules/decklink/consumer/decklink_consumer.cpp:102-118,163-174` | `engine/src/consumers/decklink_consumer.cpp` | `DoesSupportVideoMode` + keying capability flag (`bmdSupportedVideoModeKeying`) | ✅ done | 3.1 |
| `modules/decklink/consumer/decklink_consumer.cpp:809-849` (`wait_for_reference_lock`) | `engine/src/consumers/decklink_consumer.cpp` | `GetReferenceStatus` → `bmdReferenceLocked` polling | ✅ done | 3.1 |
| `modules/decklink/consumer/sdr_bgra_strategy.cpp:58-91, 94-116` | `engine/src/consumers/decklink_consumer.cpp` (weave) | **Weave 1080i UFF**: line-interleave 2 field-frames, `bmdFormat8BitBGRA` | ✅ done | 3.1 |
| `modules/decklink/consumer/v210_strategies.cpp` | *deferred* | 10-bit v210 (SDR/HDR) — post-MVP; MVP = 8-bit BGRA only | ⏸ deferred | 6+ |
| `modules/decklink/consumer/config.{h,cpp}` | `engine/src/config.cpp` (DeckLink portion) | keyer/display-mode/device-index parse | ✅ done | 3.1 |
| `modules/decklink/util/util.h` (`get_device`, format maps) | `engine/src/consumers/decklink_consumer.cpp` | Device enumeration by index, BMD display-mode mapping | ✅ done | 3.1 |
| `modules/decklink/consumer/monitor.{h,cpp}` | `engine/src/consumers/decklink_consumer.cpp` | State reporting → telemetry counters (completed/late/dropped/flushed/overwrite) | ✅ done | 3.1 |
| `modules/decklink/interop/`, `linux_interop/` | **n/a** (use SDK header directly) | CasparCG bundles BMD COM dispatch headers; мы линкуем системный `DeckLinkAPI.h` (SDK 16.0) | n/a | — |
| `modules/ffmpeg/consumer/ffmpeg_consumer.cpp` (708 lines) | `engine/src/consumers/ffmpeg_consumer.cpp` | BGRA stream consumer semantics (`has_synchronization_clock()=false`): realtime path с bounded latest-frame buffer, non-blocking render thread, ffmpeg lifecycle supervision | ✅ done (adapted) | 5.1 |
| `modules/ffmpeg/util/av_util.{h,cpp}` (`make_av_video_frame`) | `engine/src/consumers/ffmpeg_consumer.cpp` | BGRA frame bridge: rawvideo stdin (`-pix_fmt bgra`, `-video_size`, `-framerate`) into ffmpeg encoder/muxer path | ✅ done (adapted) | 5.1 |
| `core/frame/pixel_format.h` (`pixel_format::bgra`) | `engine/src/consumers/consumer.h` (frame struct) | BGRA canonical: single plane, width*height*4 stride | ⏳ todo | 0.3 |
| `core/frame/frame.{h,cpp}` | `engine/src/consumers/consumer.h` / `frame_ring.h` | Flat BGRA buffer + (future) audio | ⏳ partial | 0.3 |
| `core/frame/draw_frame.{h,cpp}` (`over`/`mask`) | **n/a** (DOM compositing) | CasparCG native C++ mixer; у нас composition в DOM (`runtime/domRenderer`), CEF compositor = mixer | n/a | — |
| `core/mixer/mixer.cpp:89-90` | **n/a** | Mixer всегда outputs BGRA — у нас OSR OnPaint уже BGRA, не нужен отдельный mixer | n/a | — |
| `core/video_format.h` (`video_field {progressive,a,b}`, `field_count`) | `engine/src/config.cpp` (format metadata) | Interlaced field model metadata for weave | ⏳ todo | 3.1 |
| `shell/CMakeLists.txt` / top `src/CMakeLists.txt` | `engine/CMakeLists.txt` | Build config reference (C++20, CEF linkage, module structure) | ⏳ todo | 0.3 |
| `core/consumer/output.cpp:206-227` (`has_synchronization_clock`) | `engine/src/consumers/consumer.h` (`HasExternalClock`/`WaitForTick`), `engine/src/main.cpp` (`decklink_driven` branch) | Consumer-driven pacing: DeckLink (hardware clock) drives the render pump directly instead of a free-running self-timer. **Reimplemented, not copied**: CasparCG's channel thread never sleeps and pushes into a backpressured queue; our pump *blocks* on a condvar the DeckLink callback signals, since our render step (CEF BeginFrame) is push-based, not pull-based like CasparCG's `stage`/`mixer`. Same effect (SDI is the master clock), different mechanism because the underlying producer models differ | ✅ done | 11.2 |
| `common/os/linux/thread.cpp:10-18` (`set_thread_realtime_priority`) | `engine/src/main.cpp` (`MaybeSetRealtimePumpPriority`) | `SCHED_FIFO` priority 2 on the render pump thread, gated to DeckLink-driven channels only (CasparCG applies it unconditionally to its single channel thread) | ✅ done | 11.4 |
| `modules/decklink/consumer/decklink_consumer.cpp:67-72` (`bmdDeckLinkConfigLowLatencyVideoOutput`) | `engine/src/consumers/decklink_consumer.cpp` (`Start`) | Low-latency scheduled playback flag | ✅ done | 11.5 |
| `modules/decklink/consumer/config.h:126-130` (`buffer_depth()`) | `engine/src/consumers/decklink_consumer.cpp` (`Start`, preroll) | Preroll depth formula: base 3 + 1 if not low-latency + 1 if embedded audio (we have no audio term) | ✅ done | 11.5 |
| `common/memory.h`, `common/memshfl.h` (aligned pools, SIMD shuffle) | `engine/src/aligned_buffer.h`, `engine/src/simd_copy.h` | **Reimplemented, not copied**: 64-byte-aligned pooled buffers for the DeckLink input queue + weave output; AVX2 non-temporal (`_mm256_stream_si256`) bulk copy for the weave destination (CasparCG uses SSSE3 `aligned_memshfl` for a different purpose — alpha/key channel shuffle; we use streaming stores for plain line-copy bandwidth, since our weave destination is write-once/never-read-back) | ✅ done | 11.3 |

**Phase 19 doc03 memory decision:** Titulus independently added `memory5s` counters and
singles aliasing (one progressive buffer supplies both fields, no clone). Experimental
`--decklink-direct-paint` synchronously copies the CEF pointer into owned DeckLink queue
storage and eliminates the intermediate FrameRing copy; it remains **OFF by default** because
the 3ch A/B did not show a reliable throughput improvement. No CasparCG memory/allocator code
was copied or linked. Evidence: `docs/performance investigation/reports/p19-03-memory-pipeline.md`.

**Легенда статуса:** ⏳ todo · 🔨 in progress · ✅ done · ⏸ deferred · n/a (не применимо)

---

## 3. Зафиксированные развилки (spec vs CasparCG)

Эти решения приняты на основе аудита и фиксируются здесь, чтобы избежать
переоткрытия:

### 3.1 Frame pacing: `SendExternalBeginFrame` (spec §9.3) vs `enable-begin-frame-scheduling` (CasparCG)

- **Spec §9.3** предписывает explicit `SendExternalBeginFrame(browser)` push в
  main loop.
- **CasparCG** (`html.cpp:197`, `html_producer.cpp:666`) использует switch
  `enable-begin-frame-scheduling` + `windowless_frame_rate=ceil(fps)` и pacing
  через **consumer-driven pull** (`receive_impl(field)` → `try_pop`). Явного
  `SendExternalBeginFrame()` в коде нет.

**Решение (Phase 0):** Начать с **CasparCG-подхода** (proven в продакшене 24/7).
`windowless_frame_rate=50` + `enable-begin-frame-scheduling`. Если фикс по spec
(strict single-clock BeginFrame) понадобится — добавить explicit BeginFrame в
future (REQ-7 stretch, Phase 6+). Зафиксировать в `docs/` что consumer clock =
master для air timing.

### 3.2 DeckLink keyer: `IDeckLinkKeyer` (CasparCG) vs profile `2dfd` (spec §REQ-5)

- **Spec §REQ-5** предписывает profile **2dfd** (2 Sub-Devices Full Duplex) для
  external keying.
- **CasparCG** (`decklink_consumer.cpp:152-198`) **не использует** profile API
  вообще — external/internal keying через `IDeckLinkKeyer::Enable(TRUE/FALSE)` +
  `SetLevel(255)`, fill-only через software `convert_to_key_only()` (byte-shuffle
  alpha в 4 канала). Profile 2dfd API отсутствует в коде CasparCG.

**Решение (Phase 3):** Следовать CasparCG-пути (`IDeckLinkKeyer`). Spec §REQ-5
про 2dfd — **aspirational**; помечено как gap. Если конкретное железо (DeckLink
8K Pro) потребует 2dfd для dual Fill+Key per card — добавить через
`IDeckLinkProfileManager` как future enhancement, не блокер MVP.

### 3.3 Genlock: hardware reference clock (spec REQ-7) vs callback pacing (CasparCG)

- **Spec REQ-7** требует `GetHardwareReferenceClock()` drives scheduled output.
- **CasparCG** (`decklink_consumer.cpp`): `GetHardwareReferenceClock` **не
  вызывается**. Pacing чисто через `ScheduledFrameCompleted` callback — карта
  DeckLink сама тактирует по genlock. Только `GetReferenceStatus`→
  `bmdReferenceLocked` polling для telemetry/ожидание lock перед start.

**Решение (Phase 3):** CasparCG callback-driven pacing **уже frame-accurate при
locked genlock** (карта тактирует). `GetHardwareReferenceClock` — future для
single-master-clock pipeline (Phase 6+ stretch). Для MVP: polling
`GetReferenceStatus` + scheduled playback = достаточно для REQ-7 acceptance.

### 3.4 BGRA conversion: нет BGRA→ARGB (spec §9.6)

Подтверждено: CasparCG на Linux consumer path **не делает** BGRA→ARGB конверсию
(`sdr_bgra_strategy` пишет `bmdFormat8BitBGRA` напрямую). OSR OnPaint = single
BGRA memcpy. Titulus: та же дисциплина, BGRA end-to-end.

### 3.5 Weave interlace: consumer-side (CasparCG), не core

CasparCG core frame — плоский BGRA, не знает про fields. Weave происходит в
**consumer** (`sdr_bgra_strategy.cpp:58-116`): line-interleave 2 field-frames,
UFF (`bmdUpperFieldFirst`). Titulus: тот же подход — weave в decklink_consumer.

### 3.6 Phase 11.2: revisiting §3.1 — DeckLink becomes the pump's clock

§3.1 (Phase 0) deferred an explicit single-clock model per spec §9.3 in
favor of CasparCG's `enable-begin-frame-scheduling` self-timer approach.
Live 3-channel testing (`docs/development-phases/phase-11-casparcg-parity.md`) showed this
self-timer and the DeckLink completion callback drifting against each
other under load — exactly the failure mode §3.1 flagged as a "future" risk.

**Decision (Phase 11.2):** implement the REQ-7-aligned single-clock model,
but via a mechanism that fits our push-based CEF pipeline rather than
copying CasparCG's pull-based `stage`/`mixer` architecture: `WaitForTick()`
blocks the render pump until DeckLink's `ScheduledFrameCompleted` callback
requests more fields, paced ~1 field period apart (CEF's renderer-process
IPC needs close to a full field period per composite — firing BeginFrames
faster just redelivers a stale `paint_seq`, discovered empirically during
this phase). Gated to DeckLink-driven channels only; the Browser/OBS/vMix
(null) consumer keeps the original CasparCG-style self-timer path from §3.1
completely unchanged. Validated live: Channel 2/3 `pairs:singles` ratio
improved from ~4-7:1 to ~8-100:1 (phase-11-casparcg-parity.md).

### 3.7 Phase 11.4: RT priority is opt-in, not automatic

CasparCG applies `SCHED_FIFO` unconditionally to its one channel thread
(§common/os/linux/thread.cpp). Titulus gates this to DeckLink-driven
channels only (constraint: must not affect the Browser/OBS/vMix path) and
the call is a soft-fail: on hosts without `RLIMIT_RTPRIO` granted (the
default for an unprivileged service account), it logs once and continues
at normal priority. Production deployments that want the RT benefit must
grant it explicitly (systemd `LimitRTPRIO=` or `/etc/security/limits.d`) —
intentionally not done automatically by this codebase, since it's a
system-wide security-policy change outside the repo.

---

## 4. Что НЕ переносим (out of scope / не применимо)

| CasparCG | Почему не нужно |
|---|---|
| `modules/oal/`, `modules/screen/`, `modules/newtek/`, `modules/artnet/` | Не наши consumers |
| `modules/image/`, `modules/flash/`, `modules/bluefish/` | Image via DOM `<img>`; flash deprecated; bluefish Windows-only |
| `accelerator/` (vulkan/d3d GPU mixer) | CPU-only principle §0.2.1; composition в DOM/CEF |
| `protocol/` (AMCP) | Наш WS protocol |
| `modules/decklink/producer/` (capture/input) | MVP = output only; input future |
| `modules/decklink/consumer/v210_strategies.cpp` | 10-bit post-MVP |
| `modules/decklink/consumer/vanc*` | Ancillary data (OP47/SCTE-104) — future |
| `core/mixer/` native C++ | DOM compositor = наш mixer; не нужен native |

---

## 5. Статус фаз

| Phase | Модули | Статус |
|---|---|---|
| 0 | engine skeleton (CEF host + null consumer + stats) | ✅ done (PR #3) |
| 0 | pipe + preview consumers | ✅ done (PR #4) |
| 0 | bench harness + mask/alpha scene | ✅ done (PR #5) |
| 0 | CasparCG baseline driver | ✅ done (PR #6) — formal baseline deferred (OSC/SDI) |
| 0 | **steady-state soak report** | ✅ done (PR #7) — 3ch 60s: avg 47.88fps **0 drops**, mask/alpha 0.7% overhead |
| 0 | **Phase 0 exit** | ✅ **render plane proven** — see docs/PHASE0_BENCH.md |
| 1 | runtime TS (JSON→DOM) — **new design**, не port (CasparCG = raw HTML) | ⏳ todo |
| 2 | backend + frontend control plane — new (cherry-pick sandbox optional) | ⏳ todo |
| 3 | decklink_consumer port | ✅ code-complete, validation deferred — no HW |
| 4 | backend hardening | ⏳ todo |
| 5 | ffmpeg_consumer port + docs | ⏳ todo |
| 6+ | NDI, GPU (Gate), single-master-clock, SaaS | ⏸ future |
| 11 | CasparCG-parity perf pass: stage-time telemetry (11.1), DeckLink-driven clock (11.2), pooled/aligned/SIMD buffers (11.3), SCHED_FIFO + backend nice deprioritization (11.4), low-latency + preroll formula (11.5), Chromium background-throttling hardening (11.6) | ✅ done — see `docs/development-phases/phase-11-casparcg-parity.md` |

---

## 6. THIRD_PARTY / GPL compliance log

Каждый ported/дословно-заимствованный фрагмент фиксируется здесь + в
`THIRD_PARTY_NOTICES.md`. По умолчанию — *reimplement by reference* (не требует
legal review). Дословные ports (если unavoidable) — с `GPL-PORT:` префиксом и
нуждаются в legal review перед commercial release.

*(пока пусто — заполняется по мере реализации)*
