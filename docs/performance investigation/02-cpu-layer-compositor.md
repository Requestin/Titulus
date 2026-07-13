# 02 — Own CPU Layer Compositor

> **Статус:** architectural bet / design draft  
> **Дата:** 2026-07-13  
> **Контекст:** после Phase 18 (`test1` потолок ~25 unique fps, content/raster-bound)  
> **Связанные:** `docs/ARCHITECTURE.md`, `docs/CASPARRCG_PORTING.md`, Phase 11/16/17/18  
> **Compliance:** reimplement by reference; **не** копировать код CasparCG (GPLv3+)  
> **Templates:** `test` = `tests/templates/test.json` (простой), `test1` = `tests/templates/test1.json` (сложный, **acceptance target** программы)

---

## 0. Abstract

Этот документ фиксирует **главную архитектурную ставку** Titulus на снижение
стоимости кадра (`frame cost`) до уровня, совместимого с true-50p на сложном
контенте (`test1` и далее): **own CPU layer compositor** — собственный
CPU-only mixer слоёв, вдохновлённый *идеями* progressive mixer / layer tree /
bounded queues CasparCG, но спроектированный **from first principles** под
наш push-based CEF OSR + DeckLink-driven clock.

Суть ставки:

1. Сегодня один `channel.html` = один CEF browser = один monolithic BGRA
   raster **всего** канала на каждый `BeginFrame` / `OnPaint`.
2. Статичные области (фоны, логотипы, неанимированные lower-thirds parts)
   перерисовываются снова и снова, хотя пиксели не меняются.
3. Нужен **layer tree**: static layers → cached bitmaps; dynamic layers →
   CEF (или узкий dirty region); CPU blend (src-over BGRA, AVX2 + parallel
   scanlines/tiles) → `FrameRing` → `decklink_consumer` weave.
4. HTML5 template authoring **сохраняется**: авторы пишут JSON/DOM templates;
   runtime классифицирует слои и общается с engine через layer-tree protocol.

**Non-negotiables (не переоткрывать):**

- CPU-only render (`--disable-gpu`); GPU path forbidden без отдельного gate-doc.
- HTML5/DOM — единственный template runtime.
- DeckLink scheduled playback + genlock; SDI = master clock для decklink-каналов.
- Per-channel process: 1 `bg_engine` = 1 channel.
- Proportional scaling: сложность и RAM растут с N слоёв / каналами, но
  укладываются в budget Ryzen 5 3600 + ~15 GiB usable.

---

## 1. Problem: monolithic CEF page

### 1.1 Текущий pipeline (as-is)

```text
take/update/clear (WS)
  → OnAirManager / ChannelClient
  → TemplateRenderer × N (z-order, transforms, masks)  [все в одном DOM]
  → CEF OSR: Blink layout + Skia CPU raster всего viewport
  → OnPaint(BGRA full frame)
  → FrameRing (SPSC, latest)
  → Consumer: null | pipe | preview | decklink | stream
```

Один `channel.html` держит весь on-air DOM. Damage beacon (1×1 px) и
perpetual `rAF` не дают OSR «заснуть», но **не уменьшают** объём raster:
CEF по-прежнему композитит и растеризует страницу как единое целое.

### 1.2 Что измеряли (Phase 15–18)

| Наблюдение | Источник | Импликация |
|---|---|---|
| `test1` steady ~25 unique fps на 3ch DeckLink | Phase 17/18 | raster/content-bound |
| RasterTask CPU-sum ~13.5 ms/frame (headless test1) | P18 P0.1 | не влезаем в 10 ms/field |
| Dual BeginFrame coalescing (`pctTicksDeltaGe2=0%`) | P18 P0.2 | pump-трюки не дают 2 paint |
| Mojo IPC ≪ RasterTask (~23×) | P18 P0.3 | bottleneck не IPC |
| CSS layer promotion (`will-change`/`contain`) ≈ noise | Phase 16 P1 | внутри-CEF promotion не спасает |
| Empty/cheap content уже ~50 unique fps | Phase 18 | потолок = стоимость контента |

Вывод: **нужно снизить работу на кадр**, а не «разогнать clock». Layer
compositor — способ платить raster только за dirty/dynamic части.

### 1.3 Почему monolithic page дорог

Даже если анимируется один ticker:

- Blink invalidates paint regions; на практике крупные stacks (gradients,
  text churn, masks, image stacks) дают широкий dirty.
- Skia CPU raster проходит слои compositor'а CEF; стоимость растёт с
  площадью и числом paint ops, не только с «видимым изменением».
- Полный BGRA 1920×1080×4 ≈ **8.3 MiB** копируется в `FrameRing` каждый
  успешный paint — даже если 90% пикселей идентичны предыдущему кадру.
- Interlace path: для true-50p нужны **два разных** bitmap на пару полей;
  при ~25 unique fps оба поля часто из одного generation → temporal
  resolution деградирует (см. Phase 10.2 field pairing / Phase 18).

### 1.4 Стоимость кадра — качественная модель

```text
C_frame ≈ C_layout + C_paint + C_raster + C_memcpy + C_mix + C_weave + C_schedule

Сегодня (monolith):
  C_raster доминирует на test1
  C_mix ≈ 0  (compositing внутри CEF)
  C_weave/schedule уже ≤ ~10% 40ms budget (Phase 11)

Цель (layered):
  C_raster → только dirty layers / regions
  C_mix → наш CPU blend (предсказуемый, SIMD)
  C_frame_dyn << C_frame_full  когда static fraction высок
```

### 1.5 Failure modes текущего подхода (связанные с perf)

1. **Full-frame churn:** любой dirty внизу z-order может форсировать
   перерисовку перекрывающих слоёв в CEF.
2. **Gradient/text worst-cases:** Phase 16 — gradients доминируют rasterMs.
3. **Mask Class B:** маски дорогие; изоляция в отдельный layer + cache
   статической mask matte — кандидат на win.
4. **3×1080i50:** три процесса × полный raster конкурируют за 12 threads
   Ryzen 5 3600 (6c/12t); без снижения C_raster true-50p на test1
   недостижим pump-оптимизациями.

### 1.6 Что compositor **не** решает сам по себе

- Плохо написанный dynamic layer всё ещё может стоить полный raster.
- Video decode (future) — отдельный producer path.
- Genlock unlock / DeckLink late — consumer/clock domain.
- Авторский контент с «всё анимировано всегда» — static fraction → 0;
  тогда выигрыш мал (нужен style guide / cost model, Phase 19).

---

## 2. CasparCG patterns to learn (reimplement only)

> **Legal / process:** изучаем паттерны из reference tree `server/` (CasparCG).
> Пишем **свой** код. Не копируем исходники. Имена типов — Titulus-native.
> См. `docs/CASPARRCG_PORTING.md` §0.1 compliance.

### 2.1 Progressive mixer (идея)

В CasparCG channel stage тянет producers и mixer собирает `draw_frame` в
итоговый BGRA. Ключевая **идея** для нас:

- Mixer — отдельный этап между producers и consumers.
- Слои имеют identity и могут кэшировать rasterized representation.
- Composition order = z-order layer tree.
- Выход mixer всегда canonical pixel format (у них и у нас: **BGRA**).

**Наша реинтерпретация:** producers = (a) cached static bitmaps,
(b) CEF dynamic browsers / regions, (c) future video frames. Mixer =
`CpuLayerMixer` в `bg_engine`. Consumers без изменения контракта: принимают
готовый BGRA frame.

### 2.2 Layer tree

Паттерн: дерево (или упорядоченный список) слоёв с transform, opacity,
blend mode, visibility. CasparCG CG layers / mixer layers — semantic
ancestor. У нас уже есть template layer schema (`rectangle`, `text`, …) в
`shared/template.schema.json` — это **authoring** tree. Engine layer tree —
**runtime/engine** projection с другими type-ами (`static_image`,
`dynamic_html`, …).

Mapping authoring → engine layers — ответственность `@titulus/runtime`
+ control plane policy (promotion rules).

### 2.3 Bounded queues

CasparCG: backpressure между stage/mixer/consumer. У нас уже:

- `FrameRing` SPSC latest-frame (перезапись stale OK для graphics).
- `decklink_consumer` `kMaxQueuedFrames` (сейчас 3 после Phase 18).

Для compositor добавим:

- Per-layer paint queue depth 1 (latest wins) для dynamic CEF.
- Mix-input snapshot: immutable set of layer buffer refs на один mix
  generation (избежать tearing между слоями).
- Hard caps на число cached bitmaps (см. §6 RAM).

### 2.4 Pull model vs наш push CEF

CasparCG producers часто **pull**: stage запрашивает frame на channel tick.
CEF OSR у нас **push**: `SendExternalBeginFrame` → позже `OnPaint`.

Phase 11 зафиксировал развилку: DeckLink `WaitForTick()` + BeginFrame
bridge даёт тот же эффект (SDI master), другой механизм.

**Для layered design:**

- Mixer loop **pull-driven** от DeckLink tick (или self-timer для non-SDI).
- Dynamic CEF layers остаются push: tick → RequestTicks/BeginFrame →
  OnPaint updates layer cache → mixer читает latest.
- Static layers: pull = просто взять cached bitmap (no BeginFrame).

### 2.5 Consumers weave (уже у нас)

Weave 1080i UFF — consumer-side (Phase 3/10/11). Compositor **не** должен
сам weave'ить interlace: mixer выдаёт progressive field-frames (или
progressive frames) в `FrameRing`; `decklink_consumer` как сейчас
line-interleave пару.

**Критично:** оба поля пары должны происходить из **согласованных** mix
generations (см. §12 risks — interlaced pairs from different mix gens).

### 2.6 Что сознательно **не** берём из CasparCG

| CasparCG | Почему не берём as-is |
|---|---|
| AMCP / CG proxy | У нас WS take/update/clear |
| Native flash/HTML dual producers model | Только HTML5 |
| GPL mixer pixel kernels | Пишем свои SIMD kernels |
| Multi-channel in one process | 1 process = 1 channel |
| GPU/OpenGL paths (если есть в ветках) | Forbidden |
| Дословные структуры `draw_frame` | Свои `LayerFrame`/`MixFrame` |

### 2.7 Pattern → Titulus mapping table

| Pattern (idea) | Titulus component | Notes |
|---|---|---|
| Progressive mixer | `CpuLayerMixer` | New |
| Layer tree | `LayerTree` + WS protocol | New |
| Producer frame | `LayerBuffer` (BGRA + meta) | New |
| Bounded queue | per-layer latest + FrameRing | Extend |
| Channel clock | `WaitForTick` / MessagePump | Existing |
| Consumer weave | `decklink_consumer` | Existing, unchanged contract |
| Stage | mixer tick orchestration in `main.cpp` | Adapt |

---

## 3. Target architecture

### 3.1 High-level diagram

```text
┌─────────────────────────────────────────────────────────────┐
│ runtime (@titulus/runtime) in control / thin hosts          │
│  - authoring DOM / template state                           │
│  - classify layers: static vs dynamic                       │
│  - emit LayerTree protocol (WS)                             │
└───────────────────────────┬─────────────────────────────────┘
                            │ JSON/WS layer.* messages
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ bg_engine (1 process / channel)                             │
│                                                             │
│  LayerTreeStore                                             │
│    ├─ Layer[0] static_image    → BitmapCache (immutable)    │
│    ├─ Layer[1] static_html     → snapshot CEF → cache       │
│    ├─ Layer[2] dynamic_html    → live CEF OSR (small/full)  │
│    ├─ Layer[3] solid_color     → fill kernel                │
│    └─ Layer[N] video (future)  → decode producer            │
│                                                             │
│  CpuLayerMixer  (AVX2 + parallel_for tiles/scanlines)       │
│       │                                                     │
│       ▼                                                     │
│  MixFrame (BGRA) → FrameRing → Consumers                    │
│                                  └─ decklink: weave+sched   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Design principles

1. **Pay for change:** static → 0 raster/frame; dynamic → proportional to
   layer pixel area (and CEF cost), not full channel.
2. **Deterministic blend:** src-over BGRA, fixed point/float policy
   documented; bit-exact golden tests where feasible.
3. **Clock unchanged:** DeckLink still drives `WaitForTick`; mixer runs in
   tick budget; browser/stream paths не ломаем.
4. **Fail soft on cache pressure:** evict cold static layers → temporary
   re-raster; never OOM-kill channel silently.
5. **Protocol-versioned:** runtime и engine договариваются о `protocolVersion`.
6. **Proportional scaling:** N layers и M channels — явные caps.

### 3.3 Roles of CEF after migration

| Role | When | CEF count (target MVP→N) |
|---|---|---|
| Dynamic HTML layer host | animated/updating content | 1…K small browsers |
| Static HTML snapshotter | one-shot raster then destroy/hibernate | transient |
| Legacy monolith fallback | feature flag / unsupported templates | 1 full-page |

MVP допускает **один** shared CEF browser с clipped viewports *или*
отдельные browsers per dynamic layer — trade-off memory vs isolation
(см. §13 affinity / §6 RAM). Рекомендация MVP: **1 CEF + layer rects**
с dirty regions; Phase N: multi-browser если isolation того стоит.

### 3.4 Output contract (unchanged for consumers)

```text
MixFrame {
  width, height,
  format: BGRA8,
  stride: width*4 (64B-aligned buffer),
  pts / tick_id / mix_generation,
  pixels: uint8_t*
}
→ FrameRing::Push
→ Consumer::OnFrame / queue
```

Consumers не знают о layer tree. Это упрощает rollback: feature flag
`BG_LAYER_MIXER=0` → legacy OnPaint→FrameRing path.

### 3.5 Threading model (target)

| Thread | Work | Notes |
|---|---|---|
| CEF UI / main | browser lifecycle, BeginFrame | existing |
| Render pump | WaitForTick → request paints → mix | decklink: SCHED_FIFO prio 2 |
| Mixer workers | TBB/`parallel_for` blend tiles | pool sized to remaining cores |
| DeckLink callback | ScheduledFrameCompleted → signal tick | existing |
| WS I/O | layer protocol | non-RT |

Affinity: не отбирать у CEF все cores; mixer workers = subset
(см. §13 pseudocode).

---

## 4. Layer tree protocol (runtime ↔ engine)

### 4.1 Transport

- Existing renderer WS (`/ws/renderer`) **или** dedicated `/ws/layers`
  subprotocol на том же connection с message `type` namespacing.
- Рекомендация: **namespaced messages** на текущем WS, чтобы не плодить
  sockets per channel.
- Encoding: JSON text frames для control; optional binary frames later для
  raw bitmap upload (`static_image` pixels) — MVP может грузить image via URL.

### 4.2 Versioning

```json
{
  "type": "layer.hello",
  "protocolVersion": 1,
  "runtimeVersion": "x.y.z",
  "caps": {
    "maxLayers": 16,
    "blendModes": ["src_over"],
    "layerTypes": ["solid", "static_image", "static_html", "dynamic_html"]
  }
}
```

Engine отвечает:

```json
{
  "type": "layer.hello_ack",
  "protocolVersion": 1,
  "engineCaps": {
    "maxLayers": 12,
    "maxCacheBytes": 805306368,
    "simd": "avx2",
    "regionDirty": false
  }
}
```

Несовместимость major → engine шлёт `layer.error` и остаётся в legacy
monolith mode.

### 4.3 Message catalog (v1)

| type | Direction | Purpose |
|---|---|---|
| `layer.hello` / `layer.hello_ack` | R↔E | version + caps |
| `layer.tree_set` | R→E | replace entire tree (take) |
| `layer.upsert` | R→E | add/update one layer |
| `layer.remove` | R→E | remove by id |
| `layer.clear` | R→E | clear all (clear graphic) |
| `layer.invalidate` | R→E | mark dirty (cache drop) |
| `layer.set_props` | R→E | opacity/transform/visible/z |
| `layer.paint_request` | E→R | (optional) ask runtime for HTML snapshot input |
| `layer.stats` | E→R | mix_us, cache hits, evictions |
| `layer.error` | E→R | protocol/capacity errors |

### 4.4 `layer.tree_set` schema

```json
{
  "type": "layer.tree_set",
  "protocolVersion": 1,
  "channelId": "ch-1",
  "treeRevision": 42,
  "canvas": { "width": 1920, "height": 1080 },
  "layers": [
    {
      "id": "bg",
      "z": 0,
      "type": "static_image",
      "rect": { "x": 0, "y": 0, "w": 1920, "h": 1080 },
      "opacity": 1.0,
      "visible": true,
      "blend": "src_over",
      "src": { "kind": "url", "url": "http://127.0.0.1:3002/media/bg.png" },
      "cacheKey": "bg:v3"
    },
    {
      "id": "lt",
      "z": 10,
      "type": "dynamic_html",
      "rect": { "x": 80, "y": 820, "w": 1760, "h": 200 },
      "opacity": 1.0,
      "visible": true,
      "blend": "src_over",
      "html": {
        "templateId": "lower-third-42",
        "documentUrl": "http://127.0.0.1:3002/renderer/layer-host.html?layer=lt",
        "vars": { "name": "Ivan", "title": "Host" }
      },
      "dirty": true
    }
  ]
}
```

### 4.5 `layer.set_props` (hot path, cheap)

Для анимации opacity/position **без** invalidation bitmap:

```json
{
  "type": "layer.set_props",
  "treeRevision": 43,
  "id": "lt",
  "props": {
    "opacity": 0.85,
    "rect": { "x": 80, "y": 800, "w": 1760, "h": 200 },
    "transform": { "tx": 0, "ty": -20, "rot": 0, "sx": 1, "sy": 1 }
  }
}
```

Если `type==static_*` и меняется только transform/opacity — **bitmap
reuse**; mixer применяет transform при blend (MVP: axis-aligned rect
+ opacity; rotation может форсировать invalidate до Phase N).

### 4.6 Ordering and revisions

- `treeRevision` монотонно растёт; engine игнорирует stale revisions.
- `layer.tree_set` атомарна относительно последующих upsert.
- Mix generation `mix_generation` инкрементируется каждый успешный mix;
  попадает в telemetry и в FrameRing meta для field pairing.

### 4.7 Compatibility with take/update/clear

| Legacy WS | Layer protocol mapping |
|---|---|
| `take` | `layer.tree_set` (full) или upsert set |
| `update` | `layer.set_props` + optional invalidate dynamic |
| `clear` | `layer.clear` |

На время миграции runtime может слать **оба** мира: legacy DOM updates в
monolith browser **и** layer messages — engine выбирает path по flag.

---

## 5. Layer types

### 5.1 `solid` / color

- Самый дешёвый: fill rect BGRA.
- Используется для mattes, backgrounds, letterbox bars.
- Нет CEF, нет cache bitmap (или 1×1 color expanded).

### 5.2 `static_image`

- PNG/JPEG/WebP decoded once → BGRA cache.
- `cacheKey` для identity across takes.
- Decode off RT path; upload complete → layer ready.
- Alpha preserved.

### 5.3 `static_html` (snapshot)

- HTML template растеризуется CEF **один раз** (или при invalidate).
- Результат → BitmapCache; CEF browser для слоя hibernate/destroy.
- Подходит для: сложный текст/градиент фона, который не анимируется.
- Invalidate rules: change of vars that affect visuals; theme switch.

### 5.4 `dynamic_html`

- Live CEF OSR для области `rect` (или full canvas с clip).
- Получает BeginFrame на каждый tick **если** `dirty` или `alwaysAnimate`.
- OnPaint пишет в layer buffer (не сразу в FrameRing).
- Цель MVP: 1 dynamic layer (lower-third / ticker).

### 5.5 `video` (future)

- Не в MVP.
- Producer: decoded BGRA/YUV→BGRA frames, paced by tick.
- Отдельный capacity budget (RAM + decode CPU).
- Не ломать CPU-only: software decode first.

### 5.6 Type comparison

| Type | Raster cost/frame | RAM | CEF | Alpha | MVP |
|---|---|---|---|---|---|
| solid | fill only | ~0 | no | opaque/alpha | yes |
| static_image | 0 after load | w×h×4 | no | yes | yes |
| static_html | 0 after snapshot | w×h×4 | transient | yes | yes |
| dynamic_html | CEF(layer) | w×h×4 + CEF | yes | yes | yes |
| video | decode+copy | frames×N | no | yes | no |

### 5.7 Authoring mapping (template schema → engine type)

Heuristic (policy в runtime / Phase 19 cost model):

```text
if layer never animates and is image asset → static_image
else if layer never animates but HTML/text/gradient → static_html snapshot
else if only opacity/transform animates on frozen pixels → static_* + set_props
else → dynamic_html
solid rectangle with flat color → solid
mask: bake into sibling static or dynamic depending on motion
```

Авторы **не** обязаны знать engine types: editor/runtime promotion.

---

## 6. Cache invalidation, dirty flags, RAM caps (Ryzen 5 3600 ~15 GiB)

### 6.1 Dirty flags

Per layer:

| Flag | Meaning |
|---|---|
| `content_dirty` | pixels must be re-rasterized / redecoded |
| `props_dirty` | opacity/transform/z/visible changed (mix only) |
| `tree_dirty` | membership/order changed |
| `evicted` | cache dropped under pressure |

Mixer fast path: если нет `content_dirty` ни у кого и только props —
re-blend from caches (всё ещё CPU mix cost, но без CEF).

### 6.2 Invalidation rules

1. `vars` change affecting text/image bindings → `content_dirty` на
   dynamic/static_html.
2. Asset URL / `cacheKey` change → drop old bitmap, load new.
3. Rect size change → `content_dirty` (rescale policy: reraster preferred
   over stretch for HTML).
4. Theme / style guide token change → bulk invalidate static_html.
5. Mask geometry animate → dynamic or invalidate baked mask each change.
6. Take new template → `tree_set` (implicit full invalidate of removed ids).

### 6.3 RAM model (per channel, 1080p)

```text
Frame 1920×1080×4 = 8 294 400 ≈ 7.91 MiB

Per cached layer bitmap ≈ ceil(w*h*4 / align) + header
CEF browser RSS (empirical ballpark) ≈ 150–400 MiB depending on site
FrameRing slots ≈ 2–3 × 8 MiB
DeckLink queue ≈ 3 × 8 MiB + weave out
Mixer dst double-buffer ≈ 2 × 8 MiB
```

### 6.4 System budget (~15 GiB usable example)

Assume host: 16 GiB RAM, ~15 GiB usable after OS.

| Consumer | Budget (guideline) |
|---|---|
| OS + desktop + agents | ~2.0 GiB |
| backend + frontend + sqlite | ~0.5 GiB |
| 3 × bg_engine base+CEF | ~3 × 0.6 GiB = 1.8 GiB |
| Layer bitmap caches (all ch) | **≤ 1.5 GiB** hard soft-cap |
| Headroom / spikes / ffmpeg | rest |

Per-channel `maxCacheBytes` default: **512 MiB** (engineCaps).
Global supervisor may lower under memory pressure.

### 6.5 Capacity limits

| Limit | Default MVP | Rationale |
|---|---|---|
| `maxLayers` | 12 / channel | blend cost + bookkeeping |
| `maxDynamicHtml` | 2 / channel | CEF cost |
| `maxCacheBytes` | 512 MiB / channel | 15 GiB host, 3ch |
| `maxLayerPixels` | 1920×1080 | no supersize layers MVP |
| FrameRing depth | 1 latest (+meta) | existing semantics |

### 6.6 Eviction policy

1. Prefer evict `static_html` cold (large, rebuildable).
2. Prefer keep `static_image` with high hit rate.
3. Never evict currently visible dynamic front-buffer mid-mix;
   mark `content_dirty` for next tick.
4. Telemetry: `cache_evictions`, `cache_bytes`, `cache_hit_ratio`.

### 6.7 Fragmentation / alignment

- Reuse `aligned_buffer` 64B pools (Phase 11.3 style).
- Pool sizes: full-HD, half-HD, and free-size slabs for small layers.
- Avoid per-frame `malloc` on RT path.

---

## 7. Blend algorithms

### 7.1 Canonical: src-over BGRA

Premultiplied vs straight: **решение MVP — straight alpha src-over**
(совместимо с CEF OSR BGRA output as observed), с явной документацией.
Если golden tests покажут mismatch с CEF composite — рассмотреть
premultiplied path as Phase N switch (`blendFormat` cap).

Per pixel (straight):

```text
out_a = src_a + dst_a * (1 - src_a)
out_c = (src_c * src_a + dst_c * dst_a * (1 - src_a)) / out_a   // if out_a>0
```

Integer variant with `a` in 0..255:

```text
inv = 255 - src_a
out_a = src_a + (dst_a * inv + 127) / 255
out_c = (src_c * src_a + dst_c * dst_a * inv / 255 + 127) / 255  // careful order
// implement with widening to u16/u32; document rounding
```

Opaque src (`a==255`): memcpy / blend skip (fast path).
Zero src (`a==0`): keep dst.

### 7.2 SIMD outline (AVX2)

```text
For each 8 pixels (32 bytes BGRA):
  load src, dst
  extract alpha lanes (shuffle / mask)
  widen to 16-bit
  compute inv_alpha
  madd-style blend
  pack back to u8
  store
Tail: scalar for width%8
```

Non-temporal stores — только для final MixFrame если dst write-once
(как weave). Для intermediate layer accumulate — обычные stores
(данные скоро читаются).

### 7.3 Parallelism: scanlines / tiles

```text
parallel_for over tile_rows:
  tile = 64..256 scanlines (tune)
  for layer in z-order:
    intersect(layer.rect, tile_rect)
    if empty: continue
    blend_span_avx2(...)
```

TBB-style: `oneapi::tbb::parallel_for` или собственный pool — dependency
policy: prefer existing engine patterns; не тянуть GPL.

### 7.4 Transform at mix (MVP subset)

| Transform | MVP | Notes |
|---|---|---|
| Translation (integer px) | yes | adjust rect |
| Opacity | yes | modulate src alpha |
| Scale | optional | may invalidate / CPU resize |
| Rotation | no (invalidate→reraster) | correctness first |
| Affine full | later | |

### 7.5 Clip / mask

MVP: clip to axis-aligned `rect`. Alpha mask layer as separate
`static_image` grayscale-in-A optional Phase N (`blend: dst_in`).

---

## 8. Integration: FrameRing, decklink weave, RequestTicks

### 8.1 FrameRing

Контракт сохраняем: SPSC latest frame. Mixer `Push(MixFrame)`.
Добавить meta: `mix_generation`, `tick_id`, `content_hash` (optional) для
telemetry и field pairing diagnostics.

### 8.2 RequestTicks / BeginFrame bridge

Сегодня pump: tick → BeginFrame → wait paint → copy to ring.

Target:

```text
tick:
  for each dynamic_html layer where needs_paint(tick):
      RequestBeginFrame(layer.browser)
  wait: all requested paints OR timeout budget
  CpuLayerMixer::Mix(layer_buffers) → MixFrame
  FrameRing.Push(MixFrame)
  // decklink consumer pulls / already queued via existing path
```

Static layers: skip BeginFrame entirely.

### 8.3 decklink_consumer weave

Без изменений алгоритма weave (UFF line-interleave). Важно:

- Подавать в queue frames с монотонными `tick_id`.
- Field pairing policy (Phase 10.2) использовать `mix_generation` чтобы
  не склеивать field A gen=10 с field B gen=12 если это даёт temporal
  inversion — или наоборот осознанно разрешать для motion (true-50p).
- Telemetry stages: добавить `mix_us` рядом с `copy_us`/`weave_us`/
  `schedule_us`.

### 8.4 Budget inside 40 ms (1080i50 pair) / 20 ms field

```text
Field budget ~20 ms:
  WaitForTick wake
  + dynamic BeginFrame+OnPaint (dominates if any)
  + mix_us (target p95 ≪ weave)
  + push ring
Consumer side (async): copy + weave + schedule (Phase 11 ~9–11% of 40ms)
```

Goal: `mix_us` p95 ≤ **1.5 ms** full HD with ≤4 layers opaque/static-heavy;
≤ **3 ms** with alpha-heavy 4 layers (gate §11).

### 8.5 Non-decklink consumers

null/pipe/preview/stream: self-timer pump вызывает тот же mixer.
Не менять HasExternalClock semantics.

---

## 9. Migration path (без ломки HTML5 authoring)

### 9.1 Principles

1. Templates остаются JSON schema + DOM runtime.
2. Editor UX не требует «engine layers» от пользователя на MVP.
3. Feature flag dual-path.
4. Visual parity gates before default-on.

### 9.2 Stages of migration

**M0 — Legacy only** (today): single channel.html.

**M1 — Shadow protocol:** runtime emits layer tree messages, engine logs/
validates, still renders monolith.

**M2 — MVP mixer behind flag:** 2 layers (static_image + dynamic_html);
compare vs monolith screenshot SSIM.

**M3 — Default for allowlisted templates** (style guide compliant).

**M4 — N layers + region dirty.**

**M5 — Deprecate monolith path** for on-air decklink (keep for preview?).

### 9.3 Authoring continuity

```text
Author → Editor → template.schema.json
                 → runtime TemplateRenderer
                      ├─ preview in browser (DOM, unchanged)
                      └─ on-air promotion → layer tree messages
```

Preview может остаться DOM-only; on-air — layered. Parity tests свяжут.

### 9.4 Rollback

```bash
BG_LAYER_MIXER=0   # engine
# runtime: stop sending layer.* or ignore ack
```

`git revert` merge commit — по git-workflow.

---

## 10. Phased implementation steps

### Phase L0 — Scaffolding

- `LayerTreeStore`, message parse, hello/caps.
- Telemetry stubs `mix_us=0`.
- Flag off by default.

### Phase L1 — MVP: 2 layers (static + dynamic)

- `static_image` decode + cache.
- One `dynamic_html` CEF (full canvas clip to rect OR small browser size).
- CpuLayerMixer src-over scalar then AVX2.
- Wire to FrameRing.
- Bench: static bg + moving rect vs monolith equivalent.

### Phase L2 — solid + static_html snapshot

- Snapshot path + hibernate.
- Eviction + maxCacheBytes.

### Phase L3 — N layers (≤12)

- z-order, opacity props hot path.
- parallel_for tiles.
- 3ch DeckLink soak.

### Phase L4 — Region dirty

- Partial OnPaint rects → update subregions of layer buffer.
- Mix dirty tiles only (optional optimize).
- engineCaps.regionDirty=true.

### Phase L5 — Production hardening

- Visual parity suite in CI (null consumer + PNG compare).
- Style guide cost model integration (Phase 19).
- Re-run true-50p gate on test1.

### Dependency order

```text
L0 → L1 → (L2 ∥ AVX2 polish) → L3 → L4 → L5
```

---

## 11. Measurement gates

### 11.1 Primary metrics

| Metric | Gate (MVP L1) | Gate (L3 aspirational) |
|---|---|---|
| `mix_us` p95 | ≤ 2000 µs (2 layers) | ≤ 3000 µs (≤4 layers alpha) |
| unique `in_fps` test1 3ch | ≥ 30 | ≥ 45 (revisit true-50p) |
| `d_late` / `d_dropped` | 0 | 0 |
| Visual SSIM vs monolith | ≥ 0.99 (static) / policy | same |
| RAM cache / channel | ≤ 512 MiB | ≤ 512 MiB |
| drops SUMMARY | < 0.1% | < 0.1% |

### 11.2 Bench suite additions

- `bench/bench-layer-static-dynamic.html` (+ engine side harness).
- `bench/bench-layer-n4-alpha.html`.
- Compare SUMMARY fps/drops vs monolith twin.
- Chrome trace: RasterTask should shrink when static fraction high.

### 11.3 Visual parity tests

1. Freeze dynamic layer; compare full frame to monolith PNG.
2. Opacity 50% over known bg — golden.
3. Edge AA around text — allow small ΔE tolerance.
4. Interlace: capture field pairs; no horizontal tear between layers.

### 11.4 Decision gate template

```text
IF mix_us OK AND late/drop=0 AND SSIM OK AND in_fps improved by ≥15%
  THEN promote flag default for allowlist
ELSE
  keep flag off; document blocker (CEF multi-browser? blend bug? ...)
```

---

## 12. Risks

### 12.1 Complexity

Два мира (monolith + layered) увеличивают maintenance. Mitigation:
feature flag, shared pixel tests, срок deprecation monolith on-air.

### 12.2 Alpha correctness

Mismatch straight vs premultiplied → fringing. Mitigation: golden tests,
single documented policy, dump layer buffers on fail.

### 12.3 Interlaced pairs from different mix generations

Field A from mix_gen=100, field B from mix_gen=101 — желательно для
motion (true-50p), но если **разные слои** обновились несогласованно
(bg old, lt new) возможен tearing **внутри** кадра.

Mitigation:

- Snapshot layer buffer refs **атомарно** перед mix (generation barrier).
- Dynamic paints that miss deadline → reuse previous layer buffer
  (whole layer), не partial without barrier.
- Consumer pairing остаётся на Phase 10.2 policy.

### 12.4 CEF multi-instance RSS

K browsers × 200 MiB может взорвать 15 GiB. Mitigation: MVP 1 browser;
caps `maxDynamicHtml`; snapshot destroy.

### 12.5 Protocol desync runtime/engine

Stale treeRevision → wrong graphic. Mitigation: revision checks;
on gap → full `tree_set` resync.

### 12.6 Thread affinity / SCHED_FIFO

Mixer workers under FIFO pump могут starve. Mitigation: mix on pump
thread for tiny N; workers nice-normal; never FIFO on pool.

### 12.7 Legal

Accidental copy from CasparCG mixer — compliance fail. Mitigation:
clean-room, reviews, THIRD_PARTY_NOTICES only for allowed exceptions.

---

## 13. Pseudocode

### 13.1 Mixer loop (decklink-driven)

```cpp
// Pseudocode — Titulus-native names; not CasparCG
void RenderPumpDeckLink(Engine& eng) {
  MaybeSetRealtimePumpPriority(); // existing, decklink only
  while (eng.running) {
    eng.consumer->WaitForTick();           // ScheduledFrameCompleted
    const TickId tick = eng.NextTickId();
    auto& tree = eng.layer_tree;

    // 1) Request paints for dynamic layers
    vector<PaintWait> waits;
    for (Layer& L : tree.layers_in_z_order()) {
      if (!L.visible) continue;
      if (L.type == DynamicHtml && L.NeedsPaint(tick)) {
        waits.push_back(L.RequestBeginFrame(tick));
      }
    }
    WaitAll(waits, eng.paint_timeout);

    // 2) Snapshot refs (generation barrier)
    MixInput in = tree.SnapshotBuffers(); // shared_ptr / refcounted

    // 3) Mix
    AlignedBuffer* dst = eng.mix_pool.Acquire();
    const auto t0 = SteadyNow();
    CpuLayerMixer::Mix(in, dst, eng.mix_opts);
    const auto mix_us = ElapsedUs(t0);
    eng.stats.NoteMix(mix_us);

    // 4) Publish
    FrameMeta meta{tick, eng.mix_generation++};
    eng.frame_ring.Push(dst, meta);
  }
}
```

### 13.2 CpuLayerMixer::Mix

```cpp
void CpuLayerMixer::Mix(const MixInput& in, AlignedBuffer* dst,
                        const MixOpts& opt) {
  ClearOrFillBackground(dst, in.canvas, opt.clear_color);

  auto tile_range = blocked_range(0, dst->height, opt.tile_rows);
  parallel_for(tile_range, [&](auto& r) {
    for (int y = r.begin(); y < r.end(); ++y) {
      uint8_t* dline = dst->Scanline(y);
      for (const LayerBuf& L : in.layers) {
        if (!L.visible || L.opacity <= 0) continue;
        const Rect hit = Intersect(L.rect, Rect{0,y,dst->width,1});
        if (hit.empty()) continue;
        BlendSrcOverSpanAVX2(dline, L, hit, L.opacity);
      }
    }
  });
}
```

### 13.3 Buffer pools

```cpp
class BufferPool {
  // sizes: FullHD, half, quarter, custom buckets
  AlignedBuffer* Acquire(size_t bytes);
  void Release(AlignedBuffer*);
  // no alloc on hot path if capacity reserved at Start()
};

class BitmapCache {
  unordered_map<CacheKey, shared_ptr<AlignedBuffer>> map_;
  atomic<size_t> bytes_{0};
  size_t max_bytes_;
  void Insert(...);
  void EvictUntil(size_t under);
};
```

### 13.4 Thread affinity (guideline)

```text
Existing: bg_engine taskset 2 physical cores (+ SMT siblings)
Mixer: prefer run mix on pump thread if mix_us expected < 1ms
Else: 2 worker threads pinned to same cpuset as process
Never expand cpuset without re-benchmarking 3ch contention
CEF threads: leave to OS within cpuset
```

### 13.5 Dirty / NeedsPaint

```cpp
bool Layer::NeedsPaint(TickId tick) const {
  if (type != DynamicHtml) return false;
  if (!visible) return false;
  if (always_animate) return true;
  if (content_dirty) return true;
  if (props_dirty && requires_reraster_for_props_) return true;
  return false; // reuse cached layer pixels
}
```

---

## 14. Comparison table

| Dimension | Current monolith CEF | Layered CPU compositor | Hypothetical GPU compositor |
|---|---|---|---|
| Raster scope | Full page / wide dirty | Dirty layers/regions | GPU layers |
| Mix location | Inside CEF/Skia | `CpuLayerMixer` | GPU forbidden |
| Static cost/frame | High (often re-raster) | ~0 + blend | n/a |
| Dynamic cost | Full CEF page | CEF(layer) + blend | n/a |
| Determinism | CEF-version dependent | Our kernels + tests | n/a |
| RAM | 1 CEF + 1 framebuffer | caches + maybe 1 CEF | VRAM + forbidden |
| DeckLink weave | Unchanged | Unchanged | Unchanged |
| Clock | WaitForTick | WaitForTick | — |
| HTML5 authoring | Yes | Yes (promotion) | Would break non-negotiable |
| Compliance GPU policy | OK (CPU OSR) | OK | **Rejected** |
| Complexity | Lower | Higher | Highest + policy break |
| Path to true-50p test1 | Blocked (P18) | **Main bet** | Out of scope |

GPU column существует только как явный **anti-goal**: не открывать GPU
gate «чтобы быстрее»; ставка — CPU layered.

---

## 15. Appendices

### Appendix A — API sketches (C++)

```cpp
// engine/src/mixer/layer_tree.h
enum class LayerType { Solid, StaticImage, StaticHtml, DynamicHtml, Video };
enum class BlendMode { SrcOver };

struct LayerRect { int x,y,w,h; };

struct LayerDesc {
  std::string id;
  int z = 0;
  LayerType type = LayerType::Solid;
  LayerRect rect{};
  float opacity = 1.f;
  bool visible = true;
  BlendMode blend = BlendMode::SrcOver;
  std::string cache_key;
  // type-specific payload via variant
};

class LayerTreeStore {
public:
  bool ApplyHello(...);
  bool TreeSet(uint64_t rev, std::vector<LayerDesc>);
  bool Upsert(uint64_t rev, LayerDesc);
  bool Remove(uint64_t rev, std::string_view id);
  bool SetProps(uint64_t rev, std::string_view id, LayerProps);
  bool Invalidate(std::string_view id);
  MixInput SnapshotBuffers() const;
};
```

```cpp
// engine/src/mixer/cpu_layer_mixer.h
struct MixOpts {
  int tile_rows = 128;
  bool allow_avx2 = true;
  uint32_t clear_bgra = 0x00000000;
};

class CpuLayerMixer {
public:
  static void Mix(const MixInput&, AlignedBuffer* dst, const MixOpts&);
};
```

### Appendix B — API sketches (TypeScript runtime)

```ts
type LayerProtocolVersion = 1;

type LayerType =
  | 'solid' | 'static_image' | 'static_html' | 'dynamic_html' | 'video';

interface LayerHello {
  type: 'layer.hello';
  protocolVersion: LayerProtocolVersion;
  runtimeVersion: string;
  caps: {
    maxLayers: number;
    blendModes: Array<'src_over'>;
    layerTypes: LayerType[];
  };
}

interface LayerTreeSet {
  type: 'layer.tree_set';
  protocolVersion: 1;
  channelId: string;
  treeRevision: number;
  canvas: { width: number; height: number };
  layers: EngineLayer[];
}

interface EngineLayer {
  id: string;
  z: number;
  type: LayerType;
  rect: { x: number; y: number; w: number; h: number };
  opacity: number;
  visible: boolean;
  blend: 'src_over';
  cacheKey?: string;
  dirty?: boolean;
  src?: { kind: 'url' | 'data'; url?: string };
  html?: { templateId: string; documentUrl: string; vars?: Record<string, unknown> };
  color?: string; // solid
}

function promoteTemplateToLayerTree(state: TemplateState): EngineLayer[] {
  // cost-model heuristics (Phase 19)
  return [];
}
```

### Appendix C — Test plan

#### C.1 Unit (engine)

| Test | Expect |
|---|---|
| src_over opaque over transparent | memcpy equality |
| src_over 50% white over black | mid gray ±1 |
| z-order 3 layers | golden PNG |
| treeRevision stale ignored | no state change |
| eviction under maxCacheBytes | bytes≤cap, dirty set |
| SnapshotBuffers immutability | mid-mix update safe |

#### C.2 Integration

| Test | Expect |
|---|---|
| MVP static+dynamic null consumer | SUMMARY fps↑ vs monolith twin |
| DeckLink 1ch soak 10 min | late=0 drop=0 |
| DeckLink 3ch soak | same + RSS OK |
| Flag off parity | bit-identical path to today |

#### C.3 Visual

| Test | Expect |
|---|---|
| SSIM static scene | ≥ 0.99 |
| Text AA | ΔE tolerance doc'd |
| Opacity ramp | no fringe |
| Field pair consistency | no horizontal layer tear |

#### C.4 Perf gates

See §11. Record under `engine/research/results/layer-mixer/`.

### Appendix D — Failure modes catalog

| ID | Symptom | Likely cause | Mitigation |
|---|---|---|---|
| F1 | Fringing on text | alpha policy mismatch | golden + premult switch |
| F2 | Tearing inside frame | non-atomic snapshot | barrier |
| F3 | OOM kill | too many CEF | caps + eviction |
| F4 | Stale graphic | revision desync | resync tree_set |
| F5 | late frames | mix+paint over budget | reduce dynamic area |
| F6 | Flicker on take | cache cold miss | preraster static before on-air |
| F7 | Wrong z | sort unstable | stable sort by (z,id) |
| F8 | Genlock OK but judder | unique fps low | cost model |
| F9 | Preview ≠ SDI | different paths | parity suite |
| F10 | Weave inversion | pairing bug | Phase 10.2 + mix_gen |

### Appendix E — Telemetry schema extension

```text
stages5s: copy_us=... weave_us=... schedule_us=... mix_us=... mix_p95=...
layer5s: layers=N dyn=D cache_MiB=X hit=0.yy evict=E paint_wait_us=...
SUMMARY ... (unchanged contract keys; additive fields OK if bench updated)
```

### Appendix F — Example timelines

#### F.1 Tick with warm caches (ideal)

```text
t=0.0ms  WaitForTick
t=0.1ms  dynamic NeedsPaint? no
t=0.1ms  Snapshot + Mix 4 layers AVX2 → 0.8ms
t=0.9ms  FrameRing.Push
t=1.0ms  idle until next tick
```

#### F.2 Tick with dynamic paint

```text
t=0.0ms  WaitForTick
t=0.1ms  BeginFrame dynamic layer 800×200
t=4.0ms  OnPaint layer buffer
t=4.1ms  Mix → 1.0ms
t=5.1ms  Push
// vs monolith test1 ~13ms+ raster — headroom for 2nd field
```

### Appendix G — Style guide interaction (Phase 19)

Layer compositor выигрывает, когда **static fraction** высок.
Style guide / cost model должен:

- Запрещать «всё анимировать всегда» без нужды.
- Помечать assets as cacheable.
- Предлагать bake gradients в static_image.
- Ограничивать simultaneous dynamic_html.

Compositor — механизм; style guide — топливо эффективности.

### Appendix H — Open questions (decision log)

| # | Question | Default proposal | Status |
|---|---|---|---|
| Q1 | Premultiplied vs straight | straight MVP | open confirm via golden |
| Q2 | 1 CEF vs N CEF | 1 CEF MVP | proposed |
| Q3 | Rotation in mixer | invalidate+reraster MVP | proposed |
| Q4 | Separate WS path | namespaced on existing | proposed |
| Q5 | Preview uses mixer? | later; DOM preview OK | proposed |
| Q6 | Region dirty priority | after N layers | proposed |
| Q7 | taskset expansion | no until 3ch rebench | proposed |

---

## 16. Extended design notes (depth)

### 16.1 Why this is the MAIN bet

Phase 18 закрыл класс решений «перестроить pump». Bottleneck —
`C_raster` контента. Единственный рычаг без нарушения CPU-only/HTML5 —
не растеризовать неизменное. Layer compositor — прямой рычаг.
Style guide (Phase 19) — complementary, не замена.

### 16.2 Proportional scaling math

```text
Let S = sum(area_static_cached)
Let D = sum(area_dynamic_painted)
Let A = canvas area

Monolith ~ k_cef * A   (often)
Layered ~ k_cef * D + k_mix * A * N_eff

Win when k_cef * (A-D) > k_mix * A * N_eff + overhead
For HD, k_mix with AVX2 is small vs k_cef Skia path on rich DOM
```

### 16.3 Interaction with masks / 2.5D (Phase 9)

Masks: bake static mask to A-channel image; animated mask → dynamic.
2.5D transforms: MVP integer translate; complex → keep in dynamic_html.

### 16.4 Interaction with transform optimization (Phase 15/16)

Composited CSS transforms помогают внутри dynamic_html, но не заменяют
layer split. Promotion heuristics Phase 16 (will-change) не отменяют
этот design — они orthogonal и уже признаны noise для monolith.

### 16.5 Security notes

- `documentUrl` / media URL: only allowlisted origins (backend).
- Binary image upload later: size caps, decode in sandbox thread.
- No `file://` from untrusted clients.

### 16.6 Observability

Per-layer counters: paint_count, reuse_count, last_mix_us contribution
(approx by area). Export via `layer.stats` every 5s.

---

## 17. Worked examples

### 17.1 News lower-third

```text
Layer bg:    static_image station vanity clear (full HD, mostly transparent)
Layer plate: static_html baked gradient plate
Layer text:  dynamic_html name/title (+ optional in/out anim)
Layer bug:   static_image logo top-right
```

Expected: during hold, only text layer may paint if ticker; often
`NeedsPaint=false` after anim → mix-only frames → unique fps↑.

### 17.2 Sports scorebug

```text
Layer chrome: static_image
Layer score:  dynamic_html (digits)
Layer clock:  dynamic_html or CPU text render future
```

### 17.3 Full-screen DVE-like move (not MVP)

Whole frame motion → effectively D≈A → win disappears; stay monolith
or treat as single dynamic.

---

## 18. Implementation checklist (engineering)

- [ ] Branch `feature/phase-19-cpu-layer-mixer` (or dedicated phase id)
- [ ] `engine/src/mixer/` scaffold + CMake
- [ ] WS message handlers
- [ ] BitmapCache + BufferPool
- [ ] Scalar src-over + tests
- [ ] AVX2 path + tests
- [ ] Hook RenderPump behind flag
- [ ] Runtime promoter stub
- [ ] Bench harness + results dir
- [ ] DeckLink soak scripts
- [ ] Docs link from ARCHITECTURE.md
- [ ] PR with gates table filled

---

## 19. Glossary

| Term | Meaning |
|---|---|
| Layer tree | Ordered set of engine layers for a channel |
| Mix generation | Monotonic id of a completed MixFrame |
| Static fraction | Share of pixels from non-painting layers |
| Dirty flag | Layer needs content refresh |
| FrameRing | SPSC latest-frame queue to consumers |
| Weave | Interleave two field frames to 1080i UFF |
| WaitForTick | Block until DeckLink schedule callback |
| BeginFrame / RequestTicks | CEF OSR frame scheduling bridge |
| src-over | Standard Porter-Duff operator |
| clean-room | Reimplement by reference without copying GPL code |

---

## 20. References (internal)

- `docs/ARCHITECTURE.md` — topology, clock table, non-negotiables
- `docs/CASPARRCG_PORTING.md` — compliance + porting map
- `docs/development-phases/phase-11-casparcg-parity.md` — clock, weave SIMD
- `docs/development-phases/phase-16-performance-matrix.md` — layer promotion noise
- `docs/development-phases/phase-17-raster-latency.md` — latency vs pool
- `docs/development-phases/phase-18-true-50p-pipeline.md` — ceiling ~25 fps
- `.cursor/rules/architecture.mdc` — hierarchy of decisions

---

## 21. Document history

| Date | Author | Change |
|---|---|---|
| 2026-07-13 | performance investigation | Initial comprehensive draft — main architectural bet |

---

## Appendix I — Detailed src-over numeric examples

### I.1 Opaque red over blue

```text
dst = (255,0,0,255) BGRA notation careful: B,G,R,A
src = (0,0,255,255)
out = src  // opaque fast path
```

### I.2 50% white over black

```text
src = (255,255,255,128)
dst = (0,0,0,255)
inv = 127
// out_a ≈ 255
// out_rgb ≈ 128
```

### I.3 Transparent over content

```text
src_a=0 → out=dst
```

---

## Appendix J — Message sequence diagrams

### J.1 Take

```text
Runtime                Engine
   |-- layer.hello ------->|
   |<- layer.hello_ack ----|
   |-- layer.tree_set ---->|  rev=1
   |                 load static caches
   |                 prepare dynamic browser
   |<- layer.stats --------|  (optional ready)
   |                      mix on ticks...
```

### J.2 Update vars

```text
Runtime                Engine
   |-- layer.invalidate -->| id=lt
   |-- layer.set_props --->| vars via side channel / upsert html.vars
   |                      content_dirty=true
   |                      next tick BeginFrame
```

### J.3 Clear

```text
Runtime                Engine
   |-- layer.clear ------->|
   |                      tree empty; push clear frame / black
```

---

## Appendix K — SIMD implementation notes (non-normative)

Use intrinsics in `engine/src/simd_blend.h` (new), mirror style of
`simd_copy.h` (weave). Keep scalar reference implementation always
compiled for correctness tests (`BG_BLEND_SCALAR=1`).

Checksum path: hash MixFrame for CI golden.

Avoid GPL memshfl patterns; our blend is different problem.

---

## Appendix L — RAM spreadsheet (example 3 channels)

```text
Per channel:
  CEF baseline           300 MiB
  4 × full-HD cache      32 MiB
  dynamic buffer         8 MiB
  mix dst ×2             16 MiB
  ring+decklink queues   40 MiB
  misc                   50 MiB
  ------------------------------
  ≈ 450 MiB / channel

×3 = 1.35 GiB engines graphics
+ backend/frontend/OS   ≈ 3 GiB
Total ≈ 4.5 GiB → fits 15 GiB with headroom
If maxDynamicHtml=2 with separate browsers: +300–600 MiB risk → watch caps
```

---

## Appendix M — Rejected alternatives

| Alternative | Why rejected |
|---|---|
| GPU compositor | Violates CPU-only non-negotiable |
| Copy CasparCG mixer.cpp | GPL compliance |
| More BeginFrame pump tricks | Phase 18 falsified |
| CSS will-change only | Phase 16 noise |
| Single giant atlas without protocol | Uncontrollable invalidation |
| Subprocess per layer | Process explosion on 3ch |

---

## Appendix N — Operator runbook snippets

```bash
# Enable mixer (future)
export BG_LAYER_MIXER=1
export BG_LAYER_MAX_CACHE_MB=512
export BG_LAYER_MAX_DYNAMIC=2

# Debug blend
export BG_BLEND_SCALAR=1
export BG_LAYER_DUMP_DIR=/tmp/layer-dumps

# Verify no stray engines before DeckLink
pgrep -af 'bg_engine|run-channel|run-engines'
```

---

## Appendix O — Parity with CasparCG *ideas* only

We reimplement:

1. Separation of producers / mixer / consumers
2. Layered composition to BGRA
3. Bounded queues / latest-frame under pressure
4. Consumer-side interlace weave
5. External clock ownership by SDI output

We do **not** reimplement:

1. AMCP
2. CasparCG flash pipeline
3. CasparCG exact frame graph types
4. CasparCG thread topology as code

---

## Appendix P — Future region-dirty algorithm

```text
OnPaint(dirtyRects):
  for r in dirtyRects:
    copy pixels into layer_buffer at r
  mark layer region_dirty_union |= r

Mix:
  if global_force: full mix
  else:
    tiles = tiles_touching(union of layer region_dirty_union and prop moves)
    for tile in tiles: blend only tile
    clear region_dirty_union
```

Caveat: moving opaque layer exposes old pixels → must include uncovered
tiles in dirty union (damage amplification).

---

## Appendix Q — Contract tests for Field pairing + mix_generation

```text
Scenario A: dyn paint every tick → mix_gen increases every field
  Expect: d_pairs high, motion smooth

Scenario B: dyn paint every other tick
  Expect: reuse layer buffer; mix may still run for clock; unique content 25

Scenario C: bg static, lt updates
  Expect: no tear between bg and lt (same SnapshotBuffers)
```

---

## Appendix R — Code ownership / module boundaries

```text
engine/src/mixer/          — NEW (tree, mix, cache, blend)
engine/src/simd_blend.h    — NEW
engine/src/main.cpp        — hook pump
engine/src/engine_client.cpp — OnPaint → layer buffer when flagged
runtime/src/layerPromote.ts — NEW
shared/layer-protocol.md   — optional extract of §4
consumers/*                — telemetry only; no weave logic change
```

---

## Appendix S — Risk register (extended)

| Risk | Prob | Impact | Score | Owner |
|---|---|---|---|---|
| Alpha fringe | M | H | H | engine |
| RAM overshoot 3ch | M | H | H | engine+ops |
| Protocol churn | H | M | H | runtime |
| No fps win on test1 | M | H | H | research |
| Schedule slip complexity | H | M | H | pm |
| Accidental GPL | L | Crit | H | legal+eng |

---

## Appendix T — Definition of Done (architectural bet validation)

Bet считается **подтверждённой**, если:

1. L3 gates зелёные на allowlisted templates.
2. `test1` unique fps ≥ 30 на 3ch при late/drop=0 (промежуточный),
   и план к ≥45–50 после style guide.
3. Visual parity accepted by operator sign-off.
4. Monolith path still works behind flag.
5. Docs merged; ARCHITECTURE updated.

Bet считается **опровергнутой**, если после L3:

1. Static fraction на реальном test1 < 20% и не поднимается style guide.
2. CEF-per-layer memory делает 3ch невозможным.
3. mix+paint всё ещё ≥ monolith cost.

Тогда — новый research spike (не GPU by default).

---

## Appendix U — FAQ

**Q: Авторы шаблонов должны знать про mixer?**  
A: Нет. Runtime promotion + style guide.

**Q: Можно ли частично включить на одном канале?**  
A: Да, per-process env flag.

**Q: Почему не PIXI/WebGL?**  
A: Non-negotiable HTML5/DOM + CPU-only.

**Q: Зачем weave тогда в consumer?**  
A: Interlace — output domain; mixer остаётся progressive field frames.

**Q: Это порт CasparCG mixer?**  
A: Нет. Reimplementation of ideas; clean-room.

---

## Appendix V — Change impact matrix

| Area | Impact |
|---|---|
| engine pump | High |
| CEF OnPaint routing | High |
| runtime WS | High |
| decklink weave algo | Low (meta only) |
| template schema | Low–Med (optional hints) |
| frontend editor | Low MVP |
| bench scripts | Med |
| docs | High (this file) |

---

## Appendix W — Minimal MVP acceptance story

```text
Given BG_LAYER_MIXER=1
And a template promoted to static_image background + dynamic_html bug
When on-air on DeckLink genlocked
Then late=0 drop=0
And mix_us p95 ≤ 2ms
And unique fps ≥ monolith + 15% on same template
And screenshot SSIM ≥ 0.99 on frozen dynamic frame
```

---

## Appendix X — End matter

Этот документ — **source of truth** для ставки CPU layer compositor до
появления phase-doc с номером фазы и PR. Любые отклонения от
non-negotiables требуют обновления `architecture.mdc` + gate-doc.

END OF DOCUMENT.

