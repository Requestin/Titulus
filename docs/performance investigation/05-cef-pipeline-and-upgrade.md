# CEF/OSR pipeline: redesign options и upgrade strategy (CPU-only)

**Документ:** `docs/performance investigation/05-cef-pipeline-and-upgrade.md`  
**Статус:** living design / decision record  
**Аудитория:** engine, render-plane, perf research  
**Связанные артефакты:**

| Документ / код | Роль |
|---|---|
| `docs/ARCHITECTURE.md` §8–9 | Topology, clock model, channel.html |
| `docs/CASPARRCG_PORTING.md` §3.1, §3.6 | Fixed forks: External BF vs CasparCG pull |
| `docs/development-phases/phase-10-sdi-perf.md` | External BF + damage beacon |
| `docs/development-phases/phase-17-raster-latency.md` | BeginFrame→OnPaint latency |
| `docs/development-phases/phase-18-true-50p-pipeline.md` | Dual BF rejected; Fallback packing |
| `engine/src/engine_app.{h,cpp}` | CefApp, switches, CefInitialize |
| `engine/src/engine_client.{h,cpp}` | CefRenderHandler::OnPaint |
| `engine/src/main.cpp` | Pump, SendExternalBeginFrame, watchdog |
| `engine/src/message_pump.h` | Self-timer path |
| `backend/public/channel.html` | rAF + damage beacon |
| `engine/third_party/fetch-cef.sh` | Binary fetch |

**Non-negotiables (не переоткрывать без GPU Gate / architecture change):**

1. **CPU-only** — CEF OSR, `--disable-gpu*`. GPU только через отдельный gate-doc.
2. **HTML5/DOM** — единственный template runtime.
3. **Frame-accurate SDI** — DeckLink scheduled playback; genlock = master clock для decklink-каналов.
4. **Reimplement by reference** — идеи CasparCG, не copy GPL code.
5. **Scale with hardware** — N каналов × taskset cores; 1 `bg_engine` = 1 channel.

**Снимок фактов (июль 2026):**

- Binary: **CEF 144** (`cef_binary_144.0.29+…+chromium-144.0.7559.256_linux64_minimal`).
- Mode: `external_begin_frame_enabled=1`, `SendExternalBeginFrame` каждый tick.
- `windowless_frame_rate = cfg.fps` (обычно 50).
- Switches: `--enable-begin-frame-scheduling`, `--disable-gpu`, `--disable-gpu-compositing`, `--disable-gpu-vsync=gpu`.
- Delivery: **OnPaint only** (PET_VIEW), full-frame `memcpy` → `FrameRing`.
- Message loop: `multi_threaded_message_loop=false` (default), manual `CefDoMessageLoopWork`.
- Page: perpetual rAF + **damage beacon** 1×1px в `channel.html`.
- Phase 18: dual BeginFrame coalesced (`pctTicksDeltaGe2=0%`) → **Approach A rejected**.

---

## Оглавление

1. [Current Titulus CEF integration — deep dive](#1-current-titulus-cef-integration--deep-dive)
2. [Comparison table: Titulus vs CasparCG HTML pacing](#2-comparison-table-titulus-vs-casparcg-html-pacing)
3. [Option A: keep External BeginFrame, fix packing](#3-option-a-keep-external-beginframe-fix-packing)
4. [Option B: pull model (CasparCG-like free-running CEF)](#4-option-b-pull-model-casparcg-like-free-running-cef)
5. [Dirty rects in OnPaint](#5-dirty-rects-in-onpaint)
6. [Shared memory OSR / zero-copy mapping](#6-shared-memory-osr--zero-copy-mapping)
7. [CEF upgrade policy](#7-cef-upgrade-policy)
8. [Custom Chromium/CEF + Skia CPU tunables](#8-custom-chromiumcef--skia-cpu-tunables)
9. [Field-rate vs frame-rate BeginFrame (1080i50)](#9-field-rate-vs-frame-rate-beginframe-1080i50)
10. [Subprocess model, cache_path, sandbox](#10-subprocess-model-cache_path-sandbox)
11. [Measurement protocols](#11-measurement-protocols)
12. [Decision tree](#12-decision-tree)
13. [Risks catalog](#13-risks-catalog)
14. [Appendices](#14-appendices)

---

## 1. Current Titulus CEF integration — deep dive

### 1.1 Process topology

```
backend :3002  ←→  frontend :3011
       ↕ /ws/renderer
 bg_engine × N   (1 process = 1 channel)
       ↓
 null | pipe | preview | decklink | stream
```

Каждый `bg_engine`:

1. `CefExecuteProcess` — subprocess guard **до** собственного arg-parse.
2. `cfg.Parse` → `EngineInit` → consumer `Start`.
3. `CreateBrowser(channel.html?engine=1&…)` windowless OSR.
4. Main loop: BeginFrame → pump → OnPaint → FrameRing → Consumer::OnFrame.
5. Shutdown: `set_closing` → consumer Stop → `EngineShutdown` → SUMMARY line.

### 1.2 `engine_app` — CefApp + CefSettings

**Файлы:** `engine/src/engine_app.h`, `engine/src/engine_app.cpp`.

#### 1.2.1 Роль

`EngineApp` реализует `CefApp` + `CefBrowserProcessHandler`. Единственная публичная работа до `CefInitialize` — закрепить command-line switches так, чтобы **browser и renderer subprocesses** унаследовали CPU-only OSR политику.

#### 1.2.2 Switches (все process types, если не указано иное)

| Switch | Scope | Зачем |
|---|---|---|
| `enable-begin-frame-scheduling` | all | Compositor слушает begin-frame schedule (нужен и для External BF, и для CasparCG-like WFR) |
| `autoplay-policy=no-user-gesture-required` | all | Media в templates без gesture |
| `disable-web-security` | all | Dev: http media с backend origin |
| `num-raster-threads=<N>` | all | Opt-in через `BG_NUM_RASTER_THREADS` (Phase 17) |
| `ozone-platform=headless` | Linux, no DISPLAY | Headless host без X |
| `disable-gpu` | browser | CPU-only |
| `disable-gpu-compositing` | browser | CPU-only |
| `disable-gpu-vsync=gpu` | browser | CPU-only |
| `disable-renderer-backgrounding` | browser | Phase 11.6: no throttle as “background tab” |
| `disable-backgrounding-occluded-windows` | browser | Phase 11.6 |
| `disable-background-timer-throttling` | browser | Phase 11.6 |
| `trace-startup*` | browser, research | Blink/cc traces в `cache_dir/blink-trace.json` |
| `enable-blink-features=PaintUnderInvalidationChecking` | browser, blink_research≥2 | Dev-only |

#### 1.2.3 CefSettings

```text
windowless_rendering_enabled = true
no_sandbox                   = true
command_line_args_disabled   = false
cache_path                   = <unique per channel>   // MANDATORY
remote_debugging_port        = optional (research)
```

**Явно:** `multi_threaded_message_loop` не включается → CEF UI thread = наш main thread; мы сами зовём `CefDoMessageLoopWork()`.

#### 1.2.4 Init/shutdown API

```cpp
bool EngineInit(CefMainArgs&, const std::string& cache_dir,
                int remote_debugging_port = 0, int blink_research = 0);
void EngineShutdown();  // CefShutdown()
```

`cache_dir` пустой допустим только для одноканального smoke; multi-channel **обязан** иметь unique path (Chromium user-data singleton).

### 1.3 `engine_client` — CefRenderHandler

**Файлы:** `engine/src/engine_client.h`, `engine/src/engine_client.cpp`.

#### 1.3.1 Interfaces

| Interface | Methods used |
|---|---|
| `CefClient` | GetRenderHandler / LifeSpan / Load |
| `CefRenderHandler` | GetViewRect, GetScreenInfo, OnPaint |
| `CefLifeSpanHandler` | OnAfterCreated, OnBeforeClose |
| `CefLoadHandler` | OnLoadingStateChange, OnLoadError |

#### 1.3.2 Geometry contract

- `GetViewRect` → `(0,0,width,height)` из CLI (`--width/--height`, default 1920×1080).
- `GetScreenInfo.device_scale_factor = 1.0f` — устраняет артефакт 1919×1079 на hi-DPI hosts (CasparCG pattern).
- Stride = `width * 4` (BGRA).

#### 1.3.3 OnPaint path (критично)

```text
OnPaint(browser, type, dirty_rects, buffer, width, height)
  if closing → return
  if type != PET_VIEW → return
  on_paint_(buffer, width, height)   // → FrameRing::Copy (memcpy)
  // dirty_rects: ПЕРЕДАЮТСЯ CEF, но сейчас ИГНОРИРУЮТСЯ (см. §5)
```

**Инвариант:** CEF buffer valid **только** внутри OnPaint. После return — invalidated. Поэтому `FrameRing::Copy` делает full-frame `memcpy` (~8.3 MiB @1080p BGRA).

**Нет:** AcceleratedPaint / shared texture / GPU path (запрещено CPU-only policy).

### 1.4 `main.cpp` — browser create + dual pump

**Файл:** `engine/src/main.cpp`.

#### 1.4.1 Subprocess guard

```cpp
CefMainArgs main_args(argc, argv);
{
  CefRefPtr<CefApp> app;
  int exit_code = CefExecuteProcess(main_args, app, nullptr);
  if (exit_code >= 0) return exit_code;
}
```

Chromium re-executes **тот же binary** с `--type=renderer|zygote|utility|…`. Guard **обязан** стоять до `cfg.Parse`, иначе helper упадёт на неизвестных флагах.

#### 1.4.2 Windowless + External BeginFrame

```cpp
window_info.SetAsWindowless(0);
window_info.external_begin_frame_enabled = 1;
browser_settings.windowless_frame_rate = cfg.fps;  // обычно 50
CefBrowserHost::CreateBrowser(...);
```

Семантика (Phase 10.5b):

- Без External BF damage-driven painting coalesces ~25–30 fps даже при `windowless_frame_rate=50`.
- С External BF каждый `SendExternalBeginFrame()` → один compositor frame (если есть damage + pump).
- rAF / CSS / video следуют channel cadence.

#### 1.4.3 DeckLink-driven pump (`HasExternalClock()==true`)

```text
while true:
  requested = consumer->WaitForTick(2 * field_period)
  for each sub-tick in batch (обычно 2 fields / ~40ms @1080i50):
    SendExternalBeginFrame()
    pump CefDoMessageLoopWork in ≤4ms slices until paint_seq moves OR field deadline
    if new paint: FrameRing.Latest → consumer.OnFrame; stats
    watchdog: if no paint >200ms → ONE Invalidate(PET_VIEW)
    if more sub-ticks remain: CefDoMessageLoopWork() once  // Phase 18 Fallback: no sleep-to-deadline
```

Ключевые свойства:

- **SDI = master clock** через `ScheduledFrameCompleted` → `WaitForTick`.
- `SCHED_FIFO` priority 2 — soft-fail, только decklink path.
- Phase 18 Fallback: sequential packing двух raster в окне ~40 мс output frame; **не** dual in-flight.
- Комментарий в коде: never fire second BF until `paint_seq` moves (coalesce lesson from P0.2).

#### 1.4.4 Self-timer pump (`null` / `pipe` / `preview` / `stream`)

```text
while true:
  SendExternalBeginFrame()  [optional 2nd if BG_P18_PIPELINE_PROBE=1]
  pump.Tick()  // CefDoMessageLoopWork + deadline sleep calc
  deliver if paint_seq advanced
  watchdog Invalidate if stall >200ms
  sleep remaining interval in ≤4ms slices + CefDoMessageLoopWork each slice
```

Probe env `BG_P18_PIPELINE_PROBE=1` — research only; production unset.

#### 1.4.5 Paint sequence & delivery dedup

```cpp
std::atomic<uint64_t> paint_seq{0};
// on_paint: ring.Copy; paint_seq++
// main: deliver only when cur_seq != last_delivered_seq
```

Это предотвращает double-counting stale frames и корректно работает с FrameRing “latest-only”.

#### 1.4.6 Watchdog (Invalidate)

- Порог: **>200 ms** без OnPaint.
- Действие: **ровно один** `Invalidate(PET_VIEW)`, затем reset timer.
- **Запрещено:** per-tick Invalidate flood (Phase 10.5 regression: CEF 14x OSR capturer отдаёт blank buffers → black flicker on air).

### 1.5 `message_pump.h` — self-timer pacing

**Файл:** `engine/src/message_pump.h`.

Исторический комментарий в файле говорит “CasparCG consumer-driven pull, not SendExternalBeginFrame” — это **устаревший Phase 0 intent**. Фактическая модель после Phase 10.5b / 11.2:

| Path | Clock | BeginFrame |
|---|---|---|
| DeckLink | hardware via WaitForTick | explicit SendExternalBeginFrame |
| Self-timer | MessagePump absolute deadline | explicit SendExternalBeginFrame |

`MessagePump::Tick`:

1. `CefDoMessageLoopWork()`.
2. Advance absolute `next_deadline_` на `1e6/fps` µs.
3. Если late → re-anchor (не копить debt).
4. Return sleep_us до deadline.

Main loop дополнительно режет sleep на ≤4 ms slices — иначе renderer IPC latency растёт и video decode голодает.

### 1.6 `channel.html` — page-side compositor damage

**Файл:** `backend/public/channel.html`.

#### 1.6.1 Modes

| Query | Behavior |
|---|---|
| `engine=1` (без `preview=1`) | fixed-step `ChannelClient.tick()` на rAF accumulator |
| browser / OBS / preview | `playbackMode: 'raf'` |

#### 1.6.2 Why damage beacon exists

CEF OSR + External BeginFrame paints **только при real compositor damage**.

Старые подходы и почему они мертвы:

| Approach | Failure |
|---|---|
| Sub-pixel opacity nudge (0.9995↔1.0) | Quantizes away; static take stops OnPaint |
| Host `Invalidate` every tick | Blank buffers / black flicker (Phase 10.5) |
| Rely on template animation alone | Static lower-thirds die after first paint |

**Damage beacon:** 1×1 fixed pixel, alpha `1/255` ↔ `2/255` каждый rAF.

- Invisible on keyed air (alpha < 3/255 не несёт смысла).
- Real damage → full compositor pass → OnPaint at channel rate.
- Coupled with perpetual `requestAnimationFrame(heartbeat)`.

#### 1.6.3 Unified JS clock (Phase 11.2)

Timeline tick и paint heartbeat — **один** rAF timestamp:

```text
tickAccumMs += dt
while tickAccumMs >= tickStepMs:
  client.tick()
  tickAccumMs -= tickStepMs
max debt = 4 * tickStepMs
```

Раньше: `setInterval` + независимый rAF → drift → judder даже при “on time” обоих clocks.

### 1.7 FrameRing — latest-only SPSC

**Файл:** `engine/src/frame_ring.h`.

- Producer: OnPaint (CEF UI / main thread).
- Consumer: main pump → Consumer::OnFrame.
- Semantics: **latest frame only**, sequence counter, mutex around buffer.
- Cost: full 1080p BGRA memcpy per paint (~8.3 MiB). Phase 11 noted second structural copy (ring → consumer queue) as invasive leftover.

### 1.8 End-to-end latency budget (1080i50 field)

Nominal field period: **20 000 µs**.

| Stage | Typical (empty) | Typical (test1) | Notes |
|---|---:|---:|---|
| SendExternalBeginFrame → IPC | small | small | Mojo ≪ RasterTask (Phase 18 P0.3) |
| Blink/Skia raster + composite | few ms | ≥ ~13–20 ms CPU-sum | content-bound |
| OnPaint + memcpy | ~0.5–2 ms | ~0.5–2 ms | bandwidth |
| Pump wait / idle | remainder | often 0 headroom | Phase 17 latency-bound |
| DeckLink schedule / weave | µs–ms | µs–ms | AVX2 weave Phase 11.3 |

**Вывод Phase 17–18:** на сложном `test1` потолок ~25 unique fps — **стоимость кадра**, не “мало BeginFrame”.

### 1.9 File map (quick reference)

| File | Responsibility |
|---|---|
| `engine_app.cpp` | Switches, CefInitialize settings |
| `engine_client.cpp` | GetViewRect / OnPaint / lifespan |
| `main.cpp` | CreateBrowser, dual pumps, BF, watchdog, probe |
| `message_pump.h` | Self-timer deadlines |
| `frame_ring.h` | Latest BGRA holder |
| `frame_log.*` | CSV: pump_active, paint_latency, inflight, paint_seq_delta |
| `channel.html` | rAF, beacon, fixed tick |
| `fetch-cef.sh` | Download stable linux64 minimal |

---

## 2. Comparison table: Titulus vs CasparCG HTML pacing

> **Compliance:** ниже — алгоритмическое сравнение *by reference*. Titulus **не** линкует и **не** subprocess’ит CasparCG.

### 2.1 High-level models

| Aspect | Titulus (current) | CasparCG HTML producer (reference pattern) |
|---|---|---|
| CEF version (example hosts) | **144** | Often bundled CEF ~142 in .deb trees; varies by release |
| Windowless | yes | yes |
| GPU | disabled | typically disabled for OSR HTML |
| `external_begin_frame_enabled` | **1 (ON)** | **OFF** (no External BF) |
| `SendExternalBeginFrame` | **yes, every tick** | **NO** |
| `windowless_frame_rate` | `cfg.fps` (50) | `ceil(fps)` → **50 for i50** |
| `enable-begin-frame-scheduling` | yes | yes |
| Who paces compositor | Engine push (BF) + pump | CEF free-runs ~WFR; consumer **pulls** |
| Frame queue | FrameRing latest-only (1 slot) | Producer queue, **pull max 4** |
| Late policy | still deliver last / skip schedule logic in DeckLink | **late → still** (reuse last good) |
| Interlace quirk | DeckLink weave UFF of 2 field bitmaps | **Delay lone field A** until B arrives (or timeout policy) |
| Message loop | Manual `CefDoMessageLoopWork` | CasparCG host pumps CEF similarly (UI thread owned) |
| Damage beacon | Required for External BF static takes | Less critical if free-running WFR + continuous schedule |
| SDI master clock | WaitForTick ← ScheduledFrameCompleted | Channel thread / consumer backpressure (different mechanism) |
| Process model | 1 process / channel | 1 server / many channels |

### 2.2 Pacing diagrams

**Titulus (push):**

```text
DeckLink field tick
  → SendExternalBeginFrame
  → CefDoMessageLoopWork slices
  → OnPaint? → copy → OnFrame → schedule
  → (Phase 18) next sub-tick ASAP if batch remains
```

**CasparCG-like (pull):**

```text
CEF paints into producer queue at ~windowless_frame_rate (50)
Channel/consumer clock
  → try_pop (max depth 4)
  → if empty/late: still (last frame)
  → if interlaced and only field A: delay quirk
  → mixer/consumer output
```

### 2.3 Semantic equivalence vs divergence

| Goal | Equivalence? | Notes |
|---|---|---|
| CPU OSR BGRA | yes | same pixel format end-to-end |
| 50 Hz cadence target | yes | different mechanism |
| Genlock-aligned SDI | partial | Titulus: BF gated by WaitForTick; CasparCG: free CEF + pull alignment |
| True unique 50 bitmaps under heavy DOM | neither guarantees | content/raster bound |
| Static graphic keeps painting | Titulus needs beacon; CasparCG relies on WFR schedule + damage | different failure modes |

### 2.4 Why Titulus chose External BF (history)

| Phase | Decision | Reason |
|---|---|---|
| 0 / CASPARRCG §3.1 | Prefer CasparCG WFR+pull first | Proven 24/7 |
| 10.5b | Adopt `SendExternalBeginFrame` | Damage-driven coalescing stuck ~25–30 fps without it |
| 11.2 | DeckLink drives pump | Self-timer vs HW clock drift → judder |
| 18 | Reject dual in-flight BF | `pctTicksDeltaGe2=0%` |

Итог: Titulus сейчас — **hybrid**: CasparCG-like switches + Titulus-specific External BF push aligned to DeckLink.

### 2.5 Implications for redesign

Любой переход к Option B (pull) должен:

1. Сохранить DeckLink `WaitForTick` как **output** master (не возвращать free-running schedule onto SDI).
2. Развести “CEF paint rate” и “SDI field rate” явно.
3. Добавить bounded queue + late→still + field-A delay quirk (reimplement).
4. Повторить Phase 10/11/18 measurement matrix — не апеллировать к CasparCG anecdotal fps.

---

## 3. Option A: keep External BeginFrame, fix packing

### 3.1 Definition

**Option A (broad):** остаёмся на `external_begin_frame_enabled=1` + `SendExternalBeginFrame`, улучшаем packing / pipeline / wait policy.

**Option A (Phase 18 narrow — rejected):** dual in-flight BeginFrames per tick to pipeline two composites.

### 3.2 What is already done

| Item | Status | Evidence |
|---|---|---|
| External BF every tick | done | `main.cpp` |
| ≤4 ms pump slices | done | decklink + self-timer |
| Wait for paint_seq or field deadline | done | decklink path |
| Phase 18 Fallback: no post-paint sleep between sub-ticks | done | PR #61 |
| `kMaxQueuedFrames` 2→3 | done | decklink_consumer |
| Dual BF pipeline probe | research-only | `BG_P18_PIPELINE_PROBE` |
| Dual BF as production strategy | **REJECTED** | `pctTicksDeltaGe2=0%` |

### 3.3 Remaining headroom inside Option A

Реалистичные рычаги (без смены pacing model):

1. **Content cost** (Phase 19 Style Guide / cost model) — главный рычаг для true 50p на `test1`.
2. **Partial updates / dirty rects** (§5) — снизить memcpy + downstream work.
3. **Zero-copy / SHM** (§6) — снизить bandwidth tax (~8 MiB/paint).
4. **Raster pool / Skia flags** — только с A/B; Phase 17 показал threads ≠ cure latency.
5. **CEF bump** (§7) — повтор P0.2: вдруг coalesce behavior изменится.
6. **Field-rate BF strategy** (§9) — яснее маппить fields vs frames.

Нереалистичные рычаги внутри Option A:

- “Ещё один pump trick” без снижения cost of frame.
- Invalidate floods.
- GPU compositor without GPU Gate.

### 3.4 Limits of Option A (documented)

```text
empty/cheap content  → in_fps≈50, d_pairs high   → true 50p-as-50i ALREADY works
test1 complex DOM    → in_fps≈25, d_pairs ~0–3   → one unique paint ≈ one field budget
```

External BF **уже** даёт правильный clock. Packing Fallback **уже** убрал idle sleep. Оставшийся gap — **Blink/Skia cost**, не absence of BeginFrame.

### 3.5 Pros / cons

| Pros | Cons |
|---|---|
| Minimal architectural risk | Cannot invent free raster time |
| DeckLink alignment natural (BF on tick) | Coalesce blocks pipeline BF |
| Known failure modes documented | Full-frame OnPaint tax remains |
| Browser/null path stable | True 50p on heavy templates needs content work |

### 3.6 When Option A is the right answer

- Genlock SDI health already green (`d_late=d_dropped=0`).
- Need incremental wins without pacing rewrite.
- Headless `test1` still <45 fps — prioritize cost model before Option B.

---

## 4. Option B: pull model (CasparCG-like free-running CEF)

### 4.1 Definition

Reimplement (not copy):

1. `external_begin_frame_enabled = 0` (или не выставлять).
2. **No** `SendExternalBeginFrame` in pump.
3. `windowless_frame_rate = ceil(fps)` → **50** for 1080i50.
4. Keep `--enable-begin-frame-scheduling`.
5. CEF free-runs paints into a **bounded queue** (max depth **4**).
6. Consumer/pump **pulls** latest / next frame:
   - if late or empty → **still** (hold last good bitmap);
   - interlaced: **delay lone field A** until field B (quirk).
7. DeckLink path: `WaitForTick` still masters **when** frames are scheduled to SDI; pull happens on tick.

### 4.2 Why consider it

Hypothesis (to be proven, not assumed):

- Free-running CEF @50 may produce more unique bitmaps under some loads than push-BF waiting.
- Separates “producer fps” from “output field cadence”.
- Matches a production-proven pattern (CasparCG) at the *algorithm* level.

Counter-hypothesis (Phase 10 history):

- Without External BF, Titulus historically coalesced to ~25–30 fps on damage-driven path.
- Beacon + WFR alone may not restore 50 unique paints if compositor coalesces.

**Gate:** любой Option B spike обязан измерить unique `paint_seq`/s on `test1` vs control Option A.

### 4.3 Genlock alignment — pros/cons

| Topic | Pro | Con / risk |
|---|---|---|
| SDI master clock | WaitForTick can still gate schedule | CEF paint timestamps drift vs genlock |
| Jitter | Queue absorbs CEF jitter | Deep queue → latency (+N frames) |
| Late frames | still policy keeps picture up | Motion becomes 25p-as-50i more often |
| Field pairing | Explicit A-delay quirk | Easy to get wrong → weave artifacts |
| Multi-channel | Independent CEF free-run per process | CPU contention less gated by BF; may oversubscribe |
| Browser/OBS path | Can keep External BF for preview | Two pacing modes to maintain |
| Debugging | CasparCG mental model familiar | Titulus docs/tools assume BF latency metrics |

### 4.4 Sketch of queue API (reimplement)

```text
struct PaintQueue {
  capacity = 4
  push(OnPaint bitmap)  // drop oldest or coalesce-to-latest policy — choose & measure
  try_pop() -> optional<Frame>
  peek_latest()
}

DeckLink tick:
  f = try_pop() or still
  if interlaced:
    if have only A: delay / wait next tick for B (quirk)
    weave(A,B) → schedule
```

**Policy choices to decide in spike:**

1. Drop-oldest vs drop-newest vs coalesce-latest on overflow.
2. Still = last scheduled vs last painted.
3. A-delay timeout (1 field? 2?) before forcing pair with duplicate.

### 4.5 Interaction with damage beacon

Under pull/WFR:

- Beacon may still be required for static takes (OSR sleep remains a Chromium reality).
- Or WFR schedule alone may suffice — **must A/B with beacon on/off**.

Do **not** assume CasparCG templates’ continuous animation; Titulus static lower-thirds are common.

### 4.6 Migration strategy (if Option B wins gate)

1. Feature flag `BG_CEF_PACING=external|pull` (default external).
2. Null consumer matrix first (no SDI risk).
3. Single DeckLink channel soak.
4. 3ch soak + visual.
5. Only then flip default for decklink; keep browser path on External BF unless proven.

### 4.7 Effort estimate

| Work | Effort | Risk |
|---|---|---|
| Disable External BF + queue | M | High behavioral change |
| Late→still + field A delay | M | Weave correctness |
| Telemetry rewrite (paint_latency meaning changes) | S–M | Metric continuity |
| Dual-path maintenance | ongoing | Drift between modes |
| Full regression matrix (§11) | L | Schedule cost |

---

## 5. Dirty rects in OnPaint

### 5.1 Current behavior

Signature:

```cpp
void OnPaint(..., const RectList& dirty_rects, const void* buffer, int w, int h);
```

В `engine_client.cpp` параметр `dirty_rects` **не используется** (anonymous / ignored). Всегда:

```text
memcpy(full_frame)
```

### 5.2 What CEF provides

`dirty_rects` — список прямоугольников, которые compositor считает изменёнными относительно предыдущего paint. Buffer всё равно содержит **полный** view (типичное поведение CEF OSR CPU path): dirty list — hint, не sparse buffer.

### 5.3 How to use (research → product)

#### Path 1: Optimize memcpy only

```text
for rect in dirty_rects:
  copy scanlines for rect into FrameRing
```

**Gain:** CPU bandwidth on small damage (beacon 1×1 + HUD).  
**Limitation:** beacon alone dirties tiny rect, но многие templates dirty large areas; worst case ≈ full copy. Also need correct stride math; must handle empty list as full update.

#### Path 2: Layered compositor (doc 02)

Если документ `02-*` описывает multi-layer composition (template layers / mask layers / key):

```text
OnPaint dirty → update only changed layer tiles
Compositor merges layers → output frame
DeckLink schedules merged frame
```

**Gain:** skip re-merge of static layers; align with Phase 19 cost model.  
**Cost:** new compositor state machine; correctness on alpha edges; interaction with weave.

#### Path 3: Telemetry first

Before optimizing:

```text
log: dirty_count, dirty_area_px, dirty_area / (w*h), paint_seq
```

Classify templates: beacon-only vs full-frame vs medium.

### 5.4 Pitfalls

| Pitfall | Why |
|---|---|
| Assume buffer is sparse | It is not — full buffer always |
| Ignore empty dirty list | Treat as full damage |
| Partial copy without seq fence | Torn frames across threads |
| Optimize only memcpy | May be <5% of test1 budget (raster dominates) |
| Break still-frame policy | Partial update into stale ring without clear |

### 5.5 Recommended sequence

1. Instrument dirty stats (null + decklink).
2. If median dirty fraction ≪ 1.0 on air templates → implement partial memcpy.
3. If layered compositor (doc 02) is on roadmap → design dirty → layer invalidate protocol.
4. Re-bench: do not ship on theory.

### 5.6 Relation to damage beacon

Beacon guarantees **non-zero dirty every frame**. That is good for keeping OSR awake, bad for dirty-rect bandwidth savings (always ≥1×1, often more if HUD/rAF side effects). For partial-update research, add `?beacon=0` bench pages (`bench-static-beacon.html`) carefully — risk OSR sleep.

---

## 6. Shared memory OSR / zero-copy mapping

### 6.1 Problem

Each OnPaint:

```text
CEF internal buffer → memcpy → FrameRing → (often) memcpy → DeckLink/ffmpeg buffer
```

@1080p50: ~8.3 MiB × 50 ≈ **415 MiB/s** per channel per hop. ×3 channels ×2 hops → multi-GB/s pressure.

Phase 11: second structural copy marked invasive leftover.

### 6.2 Research directions (CPU-only)

| Direction | Idea | Feasibility |
|---|---|---|
| CEF `OnAcceleratedPaint` | Shared texture / dma-buf | Usually GPU — **out of policy** without Gate |
| Map CEF buffer longer | Keep pointer after OnPaint | Unsafe: CEF invalidates |
| CEF shared memory OSR patches | Custom CEF build exposes SHM fd | High effort (§8) |
| Double-buffer pool swap | OnPaint writes into pre-allocated pool slot; publish pointer | Avoids one memcpy if CEF can paint into our memory — **needs CEF API support** |
| `posix_memalign` + SIMD copy | Already partially done (AVX2 NT stores for weave) | Incremental |
| `mmap` ring across processes | N/A — same process today | Future multi-proc |

### 6.3 Practical CPU-only near-term

Without custom Chromium:

1. **Pool of aligned frames** (Phase 11 style) — reduce alloc churn.
2. **SIMD / NT memcpy** for ring publish (measure; may already be memory-bound).
3. **Dirty-rect copy** (§5) — reduce bytes moved.
4. **Consumer pull by reference** under mutex with clear lifetime — careful with DeckLink async.

### 6.4 Custom CEF research path

If gates fail and memcpy shows in profiles as top hotspot:

1. Audit Chromium `viz` / `osr` capturer: can host provide `SharedMemory` destination?
2. Prototype branch CEF with hook in `OnPaint` path to write into client-owned SHM.
3. Keep `--disable-gpu*`.
4. Legal/build cost: treat as §8 custom build.

### 6.5 Success metrics

| Metric | Target |
|---|---|
| Bytes copied / paint | ↓ measurable on `perf stat` |
| `stages5s` copy µs | ↓ without raising late/drop |
| Unique fps test1 | only if copy was bottleneck (often not) |

**Honesty:** Phase 18 shows raster ≫ Mojo; zero-copy may not unlock true 50p on `test1`, but helps multi-channel scale and CPU thermal headroom.

---

## 7. CEF upgrade policy

### 7.1 Current pin

On-disk example:

```text
engine/third_party/cef/cef_binary_144.0.29+g0b1a012+chromium-144.0.7559.256_linux64_minimal
```

`fetch-cef.sh` resolves **latest stable** linux64 **minimal** from Spotify CDN index — operators must treat upgrades as deliberate, not silent.

### 7.2 When to bump

| Trigger | Action |
|---|---|
| Security CVE in Chromium/CEF affecting OSR host | Plan bump within agreed SLA |
| CEF 144 EOL / build unavailable | Bump |
| P0.2 retest desire (coalesce behavior) | Candidate bump + probe |
| ABI break in `libcef_dll_wrapper` | Budget full rebuild |
| “Just because latest” | **No** — needs regression matrix |

### 7.3 fetch-cef.sh contract

Script: `engine/third_party/fetch-cef.sh`

```text
INDEX_URL=https://cef-builds.spotifycdn.com/index.json
select linux64 / channel=stable / type=minimal
download + sha1 verify
extract to engine/third_party/cef/cef_binary_*_linux64_minimal/
stamp .cef_fetched with tarball name
```

**Hardening recommendations (policy):**

1. Allow `CEF_VERSION_PIN=<exact name>` env to lock version in CI/prod.
2. Commit `.cef_fetched` or a `CEF_PIN.txt` in repo for reproducible builds.
3. Never commit extracted binary tree (gitignore).
4. Document Chromium version alongside CEF in phase notes.

### 7.4 Regression matrix (minimum before merging bump)

| # | Test | Pass criteria |
|---|---|---|
| R1 | Build `bg_engine` | compile + link |
| R2 | Null 60s empty page | fps≈50, drops≈0 |
| R3 | Null 60s `test1` | record fps; no crash |
| R4 | Beacon on/off | on→steady paints; off documents sleep |
| R5 | `BG_P18_PIPELINE_PROBE` 3×60s | record `pctTicksDeltaGe2` |
| R6 | Single DeckLink 60s | `d_late=0`, `d_dropped=0` |
| R7 | 3ch DeckLink soak ≥10 min | late/drop 0; no black flash |
| R8 | Watchdog path | kill beacon briefly → one Invalidate, no flood |
| R9 | Browser/OBS preview | visual OK; no timer throttle |
| R10 | SUMMARY contract | `bench/run-bench.sh` parses |

### 7.5 Rollback

```bash
# restore previous tarball name in pin
./engine/third_party/fetch-cef.sh   # or manual extract of pinned archive
cmake --build engine/build -j
# redeploy channels
```

Keep previous `cef_binary_*` directory until soak passes.

### 7.6 API / behavior watchlist on bump

| Area | What to re-verify |
|---|---|
| External BeginFrame | Still required for 50 fps? |
| Invalidate blank frames | Flood still dangerous? |
| Ozone headless | Still needed without DISPLAY? |
| `device_scale_factor` | 1919×1079 regression? |
| OSR sleep without damage | Beacon still mandatory? |
| `CefDoMessageLoopWork` cadence | 4 ms slices still enough? |

---

## 8. Custom Chromium/CEF + Skia CPU tunables

### 8.1 When allowed

**Only if gates fail** after:

1. Phase 19 cost model / template budgets.
2. Option A packing exhausted.
3. Option B spike measured (accept or reject).
4. Stock CEF bump + P0.2 retest.
5. Dirty-rect / copy optimizations measured.

Custom build is **last resort** — months of maintenance.

### 8.2 Possible tunables (research list)

| Tunable | Intent | Risk |
|---|---|---|
| Skia CPU tile size | Better cache locality | Visual seams / perf cliffs |
| Raster thread defaults | Match taskset topology | Oversubscription |
| Disable unused features | Smaller binary / less wakeups | Subtle web-compat |
| OSR capturer → client SHM | Zero-copy (§6) | Deep fork from upstream |
| BeginFrame coalesce policy | Allow dual in-flight paints | Correctness / memory |
| Partial damage buffer | True sparse OSR | Huge patch surface |

### 8.3 Effort / risk / reward

| Dimension | Assessment |
|---|---|
| Effort | **XL** — automate CEF build, patches, CI artifacts, versioning |
| Risk | **High** — silent OSR bugs, security lag, merge hell each Chromium release |
| Reward | Possibly unlock true 50p or zero-copy — **unproven** until gated |
| Ops | Every host must run matching custom `libcef.so` |

### 8.4 Decision rule

```text
IF headless test1 >= 45 fps on stock CEF AND SDI pairs still fail
  → look at consumer/weave/queue, not custom CEF
IF headless test1 << 25–30 fps after cost model
  → content / DOM, not custom CEF
IF profiling proves OSR capturer/coalesce inside Chromium is the wall
  AND business accepts maintenance
  → spike custom patch with kill criteria (2 weeks)
ELSE
  → do not start custom Chromium
```

---

## 9. Field-rate vs frame-rate BeginFrame strategies for 1080i50

### 9.1 Terminology

| Term | Meaning @1080i50 |
|---|---|
| Output frame | 1 interlaced frame = 2 fields, 40 ms, 25 fps output frames |
| Field | 20 ms; DeckLink schedules fields |
| Unique bitmap | Distinct OnPaint content |
| True 50p-as-50i | Two different bitmaps woven into one output frame |
| 25p-as-50i | Same bitmap on both fields (`d_pairs≈0`) |

### 9.2 Strategy F1 — Frame-rate BF (25 BeginFrames / s)

Send BF once per output frame (40 ms), duplicate bitmap across fields.

| Pros | Cons |
|---|---|
| Half CEF load | Caps motion at 25 |
| Simple | Contradicts true 50p goal |

Use only as **explicit load-shed mode**, never as silent default for air sports graphics.

### 9.3 Strategy F2 — Field-rate BF (50 BeginFrames / s) — current

One BF per field tick / per self-timer 20 ms.

| Pros | Cons |
|---|---|
| Enables true 50 when raster fits | Wastes BF if paint cannot complete |
| Aligns with WaitForTick fields | Coalesce if dual BF attempted |

**Current Titulus default** for decklink + null@50.

### 9.4 Strategy F3 — Adaptive BF

```text
if last paint_latency < 0.6 * field_budget:
  attempt 2 sequential BF in 40ms window (Phase 18 Fallback already)
else:
  1 BF / field, accept 25p-as-50i
```

Telemetry-driven; must not oscillate (hysteresis).

### 9.5 Strategy F4 — Free-run 50 + field pull (Option B)

CEF aims 50 paints/s; DeckLink pulls per field with still/A-delay.

See §4.

### 9.6 Interlace producer quirk (CasparCG idea → reimplement)

When consumer needs field pair (A,B):

```text
pop A
if B not ready:
  delay (do not schedule A alone)  // lone field A quirk
  on timeout: duplicate A as B OR skip
```

Titulus weave already expects 2 bitmaps when `fresh==2`. Align queue policy so lone A does not produce wrong temporal order.

### 9.7 Measurement mapping

| Strategy | Primary metric |
|---|---|
| F1 | CPU↓, d_pairs≈0 expected |
| F2 | in_fps, d_pairs, paint_latency_us |
| F3 | mode switches / hysteresis log |
| F4 | queue depth, still rate, unique paint/s |

---

## 10. Subprocess model, cache_path, sandbox

### 10.1 Subprocess guard

Mandatory order in `main`:

```text
1) CefExecuteProcess
2) cfg.Parse
3) EngineInit
4) CreateBrowser
```

Helpers share the same argv0 binary. Do not insert wrappers that break `--type=` dispatch.

### 10.2 Multi-process vs single-process

Comments mention Alloy/single-process defaults and optional `--multi-process`. Policy:

| Mode | Use |
|---|---|
| Default (as built) | Prefer lower overhead per channel |
| Multi-process | Isolate renderer crashes; higher RAM |

Whatever chosen: **one channel ⇒ one `bg_engine` OS process** remains the product model.

### 10.3 cache_path per channel

```text
CefString(&settings.cache_path) = cache_dir;  // unique!
```

Failure mode if shared: Chromium process singleton → second channel fails to start or fights locks.

Ops checklist:

- Derive cache from channel id / name.
- Clean stale caches on upgrade if schema changes.
- Traces land in `cache_dir/blink-trace.json` when enabled.

### 10.4 Sandbox off

```text
settings.no_sandbox = true
```

Rationale (engine_app): dedicated channel, pinned cores, own cache; sandbox overhead without isolation benefit for single-template host.

Security note: host OS isolation (containers/VMs/user perms) must compensate. Do not expose remote debugging ports on air networks.

### 10.5 Background throttling hardening (Phase 11.6)

Even with sandbox off, OSR can look “occluded”:

```text
--disable-renderer-backgrounding
--disable-backgrounding-occluded-windows
--disable-background-timer-throttling
```

Keep these on browser process unconditionally.

### 10.6 Core pinning / RT

Out of CEF proper but coupled:

- `taskset` 2 physical cores (+ SMT siblings) per channel.
- `SCHED_FIFO` 2 only if `HasExternalClock()` and caps allow.
- Backend deprioritization (Phase 11.4) so CEF wins CPU.

---

## 11. Measurement protocols for CEF changes

### 11.1 Golden rule

No CEF pacing / flag / upgrade merge without:

1. Null numbers,
2. DeckLink health (if touching clock),
3. Written comparison to previous baseline in `engine/research/results/`.

### 11.2 Protocol M1 — Null fps baseline

```bash
# example shape — adapt to run-channel / bench scripts
cd /home/requestin/Titulus
# start backend with TITULUS_DATA=/tmp/...
# run bg_engine --consumer=null --fps=50 --duration=60 --url=...
# parse SUMMARY fps / drops / p50 / p99
```

Record: content id (`empty` / `test` / `test1`), CEF version, flags, commit SHA.

### 11.3 Protocol M2 — Frame-log latency

Enable `--frame-log=/tmp/flog.csv` (Phase 17):

| Column | Meaning |
|---|---|
| `pump_active_us` | time inside CefDoMessageLoopWork |
| `paint_latency_us` | BF → deliver |
| `paint_seq` | monotonic paints |
| `inflight_depth` | probe |
| `paint_seq_delta` | unique paints per tick |

Discriminators:

- High `pump_active/interval` → throughput-bound raster pool.
- Low ratio + high `paint_latency` → latency-bound IPC/raster wait.

### 11.4 Protocol M3 — Dual BF probe (P0.2)

```bash
BG_P18_PIPELINE_PROBE=1 ... --consumer=null --duration=60
# compute pctTicksDeltaGe2
```

Pass for “pipeline possible”: **>0%** ticks with delta≥2 sustained.  
Phase 18 on CEF 144: **0%** → A rejected.

Re-run on every CEF bump.

### 11.5 Protocol M4 — Chrome startup trace

```bash
BG_TRACE_SECONDS=15 BG_TRACE_CATEGORIES='blink,cc,...' \
  ... --remote-debugging-port=... 
# read cache_dir/blink-trace.json
```

Compare RasterTask vs Mojo durations (Phase 18 P0.3 method).

### 11.6 Protocol M5 — DeckLink soak

| Setup | Duration | Pass |
|---|---|---|
| 1ch test1 | ≥60 s | late=0 drop=0; log in_fps/d_pairs |
| 3ch test1 | ≥10–18 min | late=0 drop=0; no black flash |
| empty control | ≥60 s | in_fps≈50; d_pairs high |

Visual: TV Logic / reference monitor — motion smoothness (Phase 18 P3.3 lesson: metrics + eyes).

### 11.7 Protocol M6 — Watchdog / blank-frame stress

1. Run with beacon.
2. Inject script to stop rAF for 500 ms.
3. Expect ≤1 Invalidate; **no** sustained blanks.
4. Negative test: artificially Invalidate every tick in a debug build — must show blanks (documents the ban).

### 11.8 Protocol M7 — Multi-channel CPU scale

Scale N=1..max while recording:

- unique fps per channel,
- CPU%,
- late/drop,
- thermal throttling.

CEF changes that raise per-channel CPU may pass 1ch and fail 3ch.

### 11.9 Report template

```markdown
## CEF change report
- Commit / CEF version / flags
- Hypothesis
- Protocols run (M1–M7)
- Tables vs baseline
- Decision: ship / abort / more data
- Rollback plan
```

---

## 12. Decision tree

```text
START: Need better CEF/OSR behavior?
│
├─ Is SDI unhealthy (late/drop/black)?
│   ├─ YES → fix DeckLink/watchdog/beacon FIRST (not Option B)
│   └─ NO  ↓
│
├─ Is unique fps content-bound (headless test1 << 45)?
│   ├─ YES → Phase 19 cost model / templates (Option A limits)
│   │         dirty-rect telemetry optional
│   └─ NO  ↓
│
├─ Need true 50p and headless already ≥45–50?
│   ├─ YES → re-open packing / queue / weave pairing gates
│   └─ maybe Option B spike if push-BF still misaligned
│
├─ Suspect CEF coalesce / External BF ceiling?
│   → Run M3 on current CEF
│      ├─ delta≥2 possible → reconsider pipeline A carefully
│      └─ still 0% → bump CEF (M3 again) OR Option B spike
│
├─ Option B spike result?
│   ├─ unique fps↑ AND late/drop=0 AND visual OK → feature-flag roll out
│   └─ else keep Option A
│
├─ Profiling shows memcpy dominant?
│   → dirty-rect + pool + SIMD; SHM only if still hot
│
└─ All stock options fail AND business accepts XL maintenance?
    → §8 custom CEF spike with kill date
    ELSE document ceiling (Phase 18 style honesty)
```

### 12.1 Short policy table

| Situation | Choose |
|---|---|
| Normal evolution | Option A + content cost |
| CEF bump due | §7 matrix |
| Push-BF mis-paced vs free CEF hypothesis | Option B spike |
| Security CVE | Bump stock CEF |
| GPU vendor pressure | Refuse without GPU Gate |
| Custom Skia urge | Only after gates fail |

---

## 13. Risks catalog

### 13.1 Blank frames / black flicker

| Cause | Mitigation |
|---|---|
| Invalidate flood | Ban; only >200 ms single Invalidate |
| Capturer refresh bug (seen CEF 14x) | Regression test M6 on bumps |
| Torn partial copy | Full-frame or careful dirty + seq |
| Consumer schedule without pixels | still policy / black preroll only at start |

### 13.2 Watchdog Invalidate floods

Symptoms: intermittent black on SDI, capturer spam in logs.  
Root: treating Invalidate as pacing substitute.  
Fix: damage beacon + External BF; watchdog is **failsafe only**.

### 13.3 OSR sleep without beacon

Symptoms: after static take, OnPaint stops; fps→0; watchdog fires every 200 ms → possible blanks if misused.  
Fix: keep beacon; never ship `beacon=0` on air engine URLs.

### 13.4 Dual BeginFrame coalesce

Symptoms: `inflight_depth=2` but `paint_seq_delta≤1`.  
Impact: false hope of pipeline; wasted BF.  
Status: **proven on CEF 144** (Phase 18).

### 13.5 Genlock misalignment (Option B)

Symptoms: judder with healthy late counters; temporal breath.  
Mitigation: WaitForTick remains master; limit queue depth; measure still rate.

### 13.6 Shared cache_path

Symptoms: second channel fails; mysterious singleton errors.  
Fix: unique cache always.

### 13.7 CefExecuteProcess order bug

Symptoms: renderer subprocess dies on unknown `--consumer` flags.  
Fix: guard first.

### 13.8 Message loop starvation

Symptoms: video judder; high paint latency; CEF tasks delayed.  
Fix: ≤4 ms pump slices; do not sleep 20 ms monolithic.

### 13.9 RT priority / nice mistakes

Symptoms: whole system lockup or irreversible renice.  
Fix: soft-fail SCHED_FIFO; never blind `pkill -f PORT=`; check cmdline before kill.

### 13.10 Upgrade skew

Symptoms: works on build host, fails on air (old libcef).  
Fix: pin + deploy matching binary tree.

### 13.11 Legal / GPL

CasparCG reference only. Reimplement algorithms. Log any unavoidable verbatim port in `THIRD_PARTY_NOTICES.md`.

### 13.12 GPU temptation

Symptoms: “just enable GPU for Skia”.  
Policy: blocked without GPU Gate doc + architecture amendment.

---

## 14. Appendices

### Appendix A — Flag dictionary (Titulus)

| Flag / setting | Value | Source |
|---|---|---|
| `windowless_rendering_enabled` | true | EngineInit |
| `no_sandbox` | true | EngineInit |
| `cache_path` | per-channel | EngineInit |
| `external_begin_frame_enabled` | 1 | main CreateBrowser |
| `windowless_frame_rate` | cfg.fps | main |
| `--enable-begin-frame-scheduling` | on | EngineApp |
| `--disable-gpu` | on | EngineApp |
| `--disable-gpu-compositing` | on | EngineApp |
| `--disable-gpu-vsync=gpu` | on | EngineApp |
| `--disable-renderer-backgrounding` | on | EngineApp |
| `--disable-backgrounding-occluded-windows` | on | EngineApp |
| `--disable-background-timer-throttling` | on | EngineApp |
| `--autoplay-policy=no-user-gesture-required` | on | EngineApp |
| `--disable-web-security` | on | EngineApp |
| `--ozone-platform=headless` | if no DISPLAY | EngineApp |
| `--num-raster-threads` | opt-in env | EngineApp |
| `SendExternalBeginFrame` | each tick | main |
| `CefDoMessageLoopWork` | manual | main / MessagePump |
| `Invalidate(PET_VIEW)` | stall >200 ms only | main |
| Damage beacon | 1×1 alpha toggle | channel.html |

### Appendix B — Environment variables

| Env | Effect |
|---|---|
| `BG_P18_PIPELINE_PROBE=1` | Dual BF in-flight probe (self-timer path) |
| `BG_NUM_RASTER_THREADS` | Chromium raster pool size |
| `BG_TRACE_SECONDS` | Startup trace duration |
| `BG_TRACE_CATEGORIES` | Trace category override |
| `TITULUS_DATA` | Backend data root (tests → `/tmp/...`) |
| `DISPLAY` | If unset → ozone headless |
| Proposed: `BG_CEF_PACING=external\|pull` | Option B flag (not shipped) |
| Proposed: `CEF_VERSION_PIN` | Lock fetch-cef version |

### Appendix C — Command lines (operators)

#### C.1 Fetch CEF

```bash
cd /home/requestin/Titulus
./engine/third_party/fetch-cef.sh
ls -d engine/third_party/cef/cef_binary_*_linux64_minimal
```

#### C.2 Build engine

```bash
cmake -S engine -B engine/build -DCMAKE_BUILD_TYPE=Release
cmake --build engine/build -j"$(nproc)"
```

#### C.3 Null bench shape

```bash
# Ensure backend serves channel.html + bg-runtime.js
# Example conceptual invocation — use project run-channel scripts in practice:
./engine/build/bg_engine \
  --name=ch1 \
  --url='http://127.0.0.1:3002/channel.html?engine=1&engine_fps=50&w=1920&h=1080&channel=...' \
  --width=1920 --height=1080 --fps=50 \
  --consumer=null \
  --duration=60 \
  --stats-interval=5
```

#### C.4 Frame-log capture

```bash
./engine/build/bg_engine ... --frame-log=/tmp/ch1-frame.csv --duration=60
```

#### C.5 Dual BF probe

```bash
BG_P18_PIPELINE_PROBE=1 ./engine/build/bg_engine ... --consumer=null --duration=60
```

#### C.6 Trace capture

```bash
BG_TRACE_SECONDS=15 \
./engine/build/bg_engine ... --remote-debugging-port=9222
# inspect <cache_dir>/blink-trace.json
```

#### C.7 Kill discipline reminder

```bash
# Find listener PID — do NOT pkill -f 'PORT='
ss -ltnp | grep ':3002'
# Stop live channel: kill run-engines.sh + run-channel.sh supervisors, not only bg_engine
pgrep -af 'bg_engine|run-channel|run-engines'
```

### Appendix D — Experiment sheet: Option A packing (baseline)

| Field | Value |
|---|---|
| Date | |
| Commit | |
| CEF | 144.x |
| Content | empty / test / test1 |
| Consumer | null / decklink |
| Channels | 1 / 3 |
| Duration | |
| SUMMARY fps | |
| drops% | |
| paint_latency p50/p95 | |
| pump_active ratio | |
| in_fps / d_pairs / d_late / d_dropped | |
| Visual notes | |
| Verdict | |

### Appendix E — Experiment sheet: Option B pull spike

| Field | Value |
|---|---|
| Date | |
| Branch | |
| Flag | `BG_CEF_PACING=pull` |
| WFR | 50 |
| External BF | off |
| Queue depth | 4 |
| Late policy | still |
| Field A delay | on/off + timeout |
| Beacon | on/off |
| Null unique paint/s | |
| DeckLink late/drop | |
| Still rate % | |
| Queue overflow count | |
| Visual judder? | |
| vs Option A delta | |
| Ship? | yes / no / more data |

### Appendix F — Experiment sheet: CEF bump

| Field | Value |
|---|---|
| From version | 144.x |
| To version | |
| fetch-cef stamp | |
| R1–R10 results | attach |
| P0.2 pctTicksDeltaGe2 | |
| New flags required? | |
| Rollback tested? | |
| Merged? | |

### Appendix G — Experiment sheet: dirty-rect telemetry

| Field | Value |
|---|---|
| Content | |
| dirty_count p50/p95 | |
| dirty_area fraction p50/p95 | |
| full-frame paints % | |
| memcpy µs before/after opt | |
| fps delta | |
| Worth implementing partial copy? | |

### Appendix H — Experiment sheet: SHM / zero-copy

| Field | Value |
|---|---|
| Approach | pool swap / SIMD / custom CEF |
| bytes/s before | |
| bytes/s after | |
| CPU% delta | |
| fps delta | |
| Stability soak | |
| Continue / abort | |

### Appendix I — CasparCG pattern checklist (reimplement)

Use as design review checklist — **not** as license to paste code:

- [ ] No `SendExternalBeginFrame` in pull mode
- [ ] `windowless_frame_rate = ceil(fps)` (=50 for i50)
- [ ] `--enable-begin-frame-scheduling`
- [ ] Bounded queue depth 4
- [ ] Pull on consumer clock
- [ ] Late → still
- [ ] Lone field A delay quirk
- [ ] BGRA end-to-end, no BGRA→ARGB
- [ ] Weave on consumer side
- [ ] Unique cache_path
- [ ] `no_sandbox` decision documented
- [ ] PET_VIEW only
- [ ] `device_scale_factor=1.0`

### Appendix J — Phase 18 facts (must not rewrite history)

| Claim | Status |
|---|---|
| Dual BF in-flight yields ≥2 unique OnPaint/tick | **FALSE** on CEF 144 (`pctTicksDeltaGe2=0%`) |
| Approach A (pipeline pump) | **Rejected** |
| Classic Approach B (2 raster / 20 ms) | **Not justified** (budget) |
| Fallback eager sequential packing | **Shipped**; safe; did not lift test1 to true 50p |
| Empty content true 50p | **Works today** |
| test1 ceiling ~25 unique fps | **Confirmed** |
| Next lever | Cost model / templates; not another BF trick |

### Appendix K — Code anchors (line-level reading guide)

When reviewing PRs, open:

1. `engine/src/main.cpp` — CreateBrowser External BF; decklink loop; probe; watchdog.
2. `engine/src/engine_client.cpp` — OnPaint ignore dirty_rects today.
3. `engine/src/engine_app.cpp` — GPU disable + begin-frame-scheduling.
4. `engine/src/message_pump.h` — self-timer deadlines (comment drift vs reality).
5. `backend/public/channel.html` — beacon + unified rAF tick.
6. `engine/src/frame_ring.h` — mandatory memcpy lifetime note.
7. `docs/CASPARRCG_PORTING.md` §3.1 / §3.6 — historical forks.
8. `docs/development-phases/phase-18-true-50p-pipeline.md` — Decision Gate.

### Appendix L — Glossary

| Term | Definition |
|---|---|
| OSR | Off-Screen Rendering (windowless CEF) |
| External BeginFrame | Host-driven compositor clock via `SendExternalBeginFrame` |
| WFR | `windowless_frame_rate` |
| paint_seq | Titulus monotonic OnPaint counter |
| still | Re-output last good frame when producer late |
| weave | Line-interleave two field bitmaps → interlaced frame (UFF) |
| damage beacon | 1×1 px alpha toggle keeping OSR awake |
| Fallback packing | Phase 18 sequential BF in 40 ms window |
| Approach A | Dual in-flight BF pipeline (rejected) |
| GPU Gate | Separate architecture doc required to enable GPU |
| Reimplement by reference | Study CasparCG algorithms; write original code |

### Appendix M — Open questions (track explicitly)

1. Does CEF >144 change BeginFrame coalesce? (re-run M3)
2. Can pull mode beat External BF unique fps on `test1` without raising late?
3. What is median dirty-area fraction on production templates?
4. Is second ring→consumer memcpy worth removing before SHM research?
5. Should browser preview stay on External BF if decklink moves to pull?
6. Field-A delay timeout: 1 field or 2?
7. Pin policy for `fetch-cef.sh` in CI — exact version file?
8. Doc 02 layered compositor readiness for dirty-rect integration?

### Appendix N — Non-goals

- Enabling GPU compositing “to get 50p”.
- Running `casparcg-server` as a dependency.
- Copying GPL sources into `engine/`.
- Per-tick Invalidate as pacing.
- Silent CEF auto-upgrade on air hosts.
- Claiming true 50p on `test1` without metrics + visual proof.

### Appendix O — Related phase reading order

1. Phase 10 — External BF + beacon (why push exists)
2. Phase 11 — DeckLink clock + RT + background flags
3. Phase 12 — Blink pipeline research
4. Phase 15 — Transform cost
5. Phase 16 — Performance matrix / layer promotion
6. Phase 17 — Raster vs latency
7. Phase 18 — True 50p gate (this doc’s factual backbone)
8. Phase 19 (planned) — Style Guide + cost model

### Appendix P — Minimal architecture invariants checklist

Before merging any CEF PR:

- [ ] CPU-only switches still present
- [ ] Browser/null path unchanged unless explicitly tested
- [ ] DeckLink WaitForTick still master for SDI
- [ ] Beacon still in channel.html engine mode
- [ ] No Invalidate flood introduced
- [ ] Unique cache_path still enforced
- [ ] CefExecuteProcess still first
- [ ] SUMMARY line format intact
- [ ] Research env flags default off
- [ ] Docs updated if pacing model changes
- [ ] Measurement report attached

### Appendix Q — Example decision log entry

```text
YYYY-MM-DD
Change: <title>
Hypothesis: <one sentence>
Option: A / B / bump / dirty / SHM / custom
Protocols: M1,M3,M5
Result: <numbers>
Decision: ship | abort | defer
Follow-up: <ticket/phase>
```

### Appendix R — Capacity planning sketch

Assumptions (illustrative — replace with measured):

| Channels | Unique fps target | Approx BGRA copy GB/s (1 hop) | Notes |
|---|---:|---:|---|
| 1 | 50 | ~0.4 | |
| 3 | 50 | ~1.2 | MVP target ≥3×1080i50 |
| 3 | 25 | ~0.6 | current test1 reality |

If Option B free-runs CEF hotter than BF-gated path, CPU headroom for 3ch may shrink — measure before default flip.

### Appendix S — Failure injection ideas

| Injection | Expect |
|---|---|
| Stop beacon | paints stall; watchdog ≤1 Invalidate/200 ms |
| `BG_P18_PIPELINE_PROBE=1` | delta≥2 still ~0% on CEF 144 |
| Starve CPU (stress -c) | late may rise; still policy / drops behavior documented |
| Wrong shared cache | channel 2 fails start |
| Block DISPLAY unset incorrectly | ozone/headless issues |

### Appendix T — Document maintenance

| Event | Update this doc |
|---|---|
| CEF bump | Appendix F results + version pin |
| Option B ships | §4 → “current”; §1 rewrite pump |
| Phase 19 lands | link cost model; refresh decision tree |
| Dirty-rect implemented | §5 status → done + numbers |
| GPU Gate opened | new section; rewrite non-negotiables carefully |

---

## Closing summary

Titulus today runs **CEF 144 CPU-only OSR** with **External BeginFrame** paced by DeckLink `WaitForTick` (or self-timer), **manual `CefDoMessageLoopWork`**, **OnPaint→memcpy→FrameRing**, and a **damage beacon** in `channel.html`. Phase 18 proved dual in-flight BeginFrames **coalesce** (`pctTicksDeltaGe2=0%`) and rejected Approach A; packing Fallback is shipped but does not lift complex `test1` past ~25 unique fps.

**Default path forward:** Option A limits + content cost model; measure dirty rects; pin CEF upgrades behind a regression matrix. **Option B (pull)** is a legitimate spike for genlock-aligned still/queue semantics — not a free lunch. **Custom Chromium** only if gates fail. Keep CasparCG as reference algorithms only; keep SDI frame-accurate; keep HTML5; keep CPU-only until a written GPU Gate says otherwise.

---

*End of document.*
