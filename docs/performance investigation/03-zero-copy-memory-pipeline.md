# 03 — Zero-Copy Memory Pipeline: устранение лишних 8MB-копий кадра

**Статус:** investigation / design (не implementation gate)  
**Целевая платформа:** AMD Ryzen 5 3600, dual-channel DDR4, CPU-only CEF OSR  
**Нагрузка:** 3×1080p50 BGRA → DeckLink (обычно 1080i50 weave)  
**Связанные фазы:** Phase 10 (SDI perf), Phase 11 (CasparCG-parity / pools / StreamCopy), Phase 17 (raster latency), Phase 18 (true 50p)  
**Код-якоря:** `engine/src/frame_ring.h`, `engine/src/aligned_buffer.h`, `engine/src/simd_copy.h`, `engine/src/consumers/decklink_consumer.cpp`, `engine/src/main.cpp`  
**Ограничения архитектуры:** CPU-only render, HTML5/DOM runtime, DeckLink scheduled playback + reference, clean-room reimplement (no GPL copy), scalable multi-channel  
**Тестовые шаблоны:** `tests/templates/test.json` (простой canary), `tests/templates/test1.json` (сложный — **acceptance target** программы; финальная валидация fewer-copy пути делается на нём)  

---

## 0. Executive summary

### 0.1 Проблема одной фразой

На hot path Titulus один progressive BGRA-кадр (~8.29 MB) сегодня может быть **скопирован 2–4 раза** до DMA на DeckLink: CEF paint buffer → `FrameRing` → `OnFrame` queue → (иногда) singles clone → weave `StreamCopy` в output buffer. При 3 каналах × 50 fps это даёт **гигабайты в секунду** чистого memory traffic, конкурирующего с CEF paint, Blink layout и DeckLink completion callbacks на общем L3/DRAM.

### 0.2 Что уже сделано (Phase 11.3)

| Мера | Эффект |
|------|--------|
| `AlignedBuffer` 64B-aligned pool (input + output) | Убрали `aligned_alloc` / page-fault jitter на каждый `OnFrame` |
| AVX2 non-temporal `StreamCopy` в weave | Destination write-combine без RFO (read-for-ownership) |
| Recycle `OwnedDecklinkFrame::TakeBuffer()` | Output buffer живёт между schedule ↔ completed |
| Telemetry `copy_us` / `weave_us` / `schedule_us` | Доля бюджета поля видна в логе |

Доминирующая стоимость до pools была **allocation**, не memcpy. После pools остаётся **structural double/triple copy** — это следующий рычаг bandwidth.

### 0.3 Цель этого документа

Спроектировать **zero-copy / fewer-copy** pipeline, который:

1. Сохраняет lifetime-safety CEF `OnPaint` buffer (он валиден только внутри callback).
2. Не ломает interlaced weave semantics (A older / B newer, singles duplicate без comb).
3. Не регрессирует `late` / `dropped` на 3ch soak.
4. Остаётся CPU-only, BGRA-first, без GPL-заимствований из CasparCG.
5. Масштабируется на N каналов при pinning по CCX.

### 0.4 Рекомендуемый вектор (spoiler)

1. **Краткосрочно:** deepen pools + weave **напрямую** из двух progressive buffers без лишнего Clone на singles (alias / refcount / dual-slot).  
2. **Среднесрочно:** ownership transfer ring ↔ consumer (`swap` / move) вместо `memcpy` в `OnFrame`.  
3. **Осторожно:** double-buffer FrameRing с publish pointer (CEF всё равно требует **хотя бы один** copy из paint buffer).  
4. **Не делать без measure:** BGRA→UYVY/v210 на CPU «чтобы меньше байт на шине» — convert cost часто съедает выигрыш.  
5. **DeckLink `GetBytes`:** уже zero-copy к DMA (наш buffer pointer) — не копировать ещё раз в SDK.

---

## 1. Текущая copy chain (as-is)

### 1.1 Топология процессов и потоков

```
bg_engine (1 process = 1 channel)
├── CEF UI / render thread
│     OnPaint(BGRA*) ──memcpy──► FrameRing::buffer_
├── pump / WaitForTick (decklink-driven)
│     FrameRing::Latest(visit) ──pointer──► DecklinkConsumer::OnFrame
│           OnFrame ──CopyFrom──► AlignedBuffer (input pool) ──queue──► deque
└── DeckLink completion callback thread
      pop 1–2 BufferedFrame
      field_a_ / field_b_ (move, or Clone on singles)
      ScheduleWovenOutput: StreamCopy lines → OwnedDecklinkFrame
      IDeckLinkOutput::ScheduleVideoFrame
      … later GetBytes() → DMA read of same AlignedBuffer
```

Ключевые файлы:

- Producer copy: `FrameRing::Copy` — `engine/src/frame_ring.h`
- Consumer intake copy: `Impl::OnFrame` — `decklink_consumer.cpp`
- Weave copy: `ScheduleWovenOutput` + `StreamCopy` — `simd_copy.h`
- Ownership to HW: `OwnedDecklinkFrame::GetBytes` — возвращает `data_.data()`

### 1.2 Этап A — CEF buffer → FrameRing::Copy

```cpp
// frame_ring.h (упрощённо, фактический код)
void Copy(const uint8_t* bgra, int width, int height) {
    if (width != width_ || height != height_) Resize(width, height);
    {
        std::lock_guard<std::mutex> lock(mu_);
        const size_t bytes = size_t(width) * size_t(height) * 4;
        std::memcpy(buffer_.data(), bgra, bytes);  // COPY #1
    }
    seq_.store(++latest_seq_, std::memory_order_release);
}
```

**Почему copy обязателен на этом этапе (сегодня):** CEF OSR передаёт pointer, валидный **только** на время `OnPaint`. После return buffer может быть переиспользован/освобождён Blink/Skia. Zero-copy «держать CEF pointer» = use-after-free. Любой fewer-copy дизайн **должен** либо скопировать здесь, либо получить от CEF ownership (недоступно в публичном OSR API), либо использовать double-buffer, куда CEF пишет — но OSR пишет в свой backing store, не в наш.

**Размер:** `1920 × 1080 × 4 = 8_294_400` bytes (`frame_bytes_`).

**Потоки:** CEF UI thread держит `mu_` на время memcpy. Consumer `Latest()` тоже берёт `mu_` — contention окно = длительность ~8MB copy.

### 1.3 Этап B — FrameRing → OnFrame AlignedBuffer::CopyFrom

Pump вызывает `ring.Latest([&](const Frame& f){ consumer->OnFrame(f); })`.  
`Frame.bgra` — pointer в `FrameRing::buffer_`, валиден **только** внутри visitor.

```cpp
// decklink_consumer.cpp::OnFrame
BufferedFrame packed;
packed.seq = frame.seq;
packed.bytes = GetInputBuffer();           // pool hit → no alloc
packed.bytes.CopyFrom(frame.bgra, frame_bytes_);  // COPY #2 (memcpy)
frame_queue_.push_back(std::move(packed));
```

**Почему copy #2 существует:** completion callback асинхронно consume queue; `FrameRing` к этому моменту уже может быть перезаписан следующим `OnPaint`. Нужна независимая lifetime ownership на стороне DeckLink path.

**Phase 11.3 уже убрал** стоимость `aligned_alloc` через `input_pool_`. Осталась чистая bandwidth `memcpy`.

### 1.4 Этап C — Weave StreamCopy (line interleave)

```cpp
// ScheduleWovenOutput
for (int y = 0; y < height_; ++y) {
    const uint8_t* src = /* field A or B line */;
    StreamCopy(out + y * row_bytes_, src + y * line_bytes, line_bytes);  // COPY #3
}
StreamCopyFence();
```

Это **не** лишний full-frame memcpy «для удобства» — это необходимая **перестановка строк** progressive A/B → interlaced output с SDK `row_bytes_` stride. Даже при zero-copy intake weave останется, пока output format = interlaced BGRA и input = два progressive.

Для progressive consumer path weave вырождается в line copy A→out (всё равно touch каждого байта из-за возможного stride padding).

`StreamCopy` использует `_mm256_stream_si256` (non-temporal) при 32B alignment — destination не загрязняет L3.

### 1.5 Этап D — Singles path: extra Clone

Когда interlaced и в queue только 1 fresh frame:

```cpp
field_a_ = GetInputBuffer();
field_a_.CopyFrom(f0.bytes.data(), frame_bytes_);  // COPY #4 (Clone)
field_b_ = std::move(f0.bytes);
```

Семантика: duplicate progressive frame в оба поля (progressive-look, без comb).  
Цена: ещё один full 8.29 MB memcpy на path starvation/singles.

Статистика `singles_` в telemetry — индикатор, как часто платим Clone.

### 1.6 Этап E — DeckLink GetBytes (уже zero-copy к DMA)

```cpp
HRESULT GetBytes(void** buffer) override {
    *buffer = data_.data();  // pointer to our AlignedBuffer — NO copy
    return S_OK;
}
```

После `ScheduleVideoFrame` карта читает buffer через DMA. Мы **не** должны копировать в промежуточный SDK buffer. Паттерн совпадает с идеей CasparCG `decklink_frame` (reimplement, не copy GPL): frame object владеет storage, `GetBytes` отдаёт raw pointer.

### 1.7 Сводная таблица копий на один progressive кадр

| # | Где | Когда | Bytes | Можно убрать? |
|---|-----|-------|-------|---------------|
| 1 | `FrameRing::Copy` | каждый OnPaint | 8.29 MB | Нет без смены CEF contract; можно сделать #1 единственным |
| 2 | `OnFrame::CopyFrom` | каждый intake | 8.29 MB | Да — ownership / swap / dual-publish |
| 3 | Weave `StreamCopy` | каждый output frame | ~8.29 MB write (+ reads) | Нет для interlaced geometry; NT stores уже оптимизируют |
| 4 | Singles Clone | fresh==1 | 8.29 MB | Да — alias same buffer для A и B / refcount |

### 1.8 Bytes/sec при 50 fps × 3 channels

Константы:

```
FRAME = 1920 * 1080 * 4 = 8_294_400 bytes
FPS_P = 50                 # progressive render target per channel
CH    = 3
```

**Один full-frame memcpy stage:**

```
BANDWIDTH_1COPY = FRAME * FPS_P * CH
                = 8_294_400 * 50 * 3
                = 1_244_160_000 bytes/s
                ≈ 1.159 GiB/s
                ≈ 1.244 GB/s
```

**As-is hot path (interlaced, типичный fresh==2):**

| Stage | Rate model | Traffic (approx) |
|-------|------------|------------------|
| Copy #1 CEF→ring | 50 fps × 3ch read+write ≈ 2× | ~2.49 GB/s bus ops |
| Copy #2 ring→queue | 50 fps × 3ch R+W | ~2.49 GB/s |
| Weave | 25 out fps × 3ch: read 2F + write 1F | ~1.87 GB/s |
| **Rough sum** | | **~6.8 GB/s** peak theoretical touch |

Уточнение: «bus ops» считает read+write как 2× bytes для memcpy; реальный DRAM traffic зависит от cache hits. На 8MB кадре L3 Ryzen 3600 = 16 MB/CCX — **один** кадр помещается в L3 одного CCX, но **три** канала × несколько буферов легко вытесняют.

**Singles Clone overhead:**

```
EXTRA_SINGLES = FRAME * singles_rate * CH
```

Если `singles` = 10% output cycles @ 25 Hz: `0.1 * 25 * 8.29e6 * 3 ≈ 62 MB/s` — умеренно, но spike latency на completion thread опаснее среднего bandwidth.

### 1.9 Field budget context

Для 1080i50 output:

- Output frame duration ≈ **40 ms** (25 fps interlaced container), но field cadence / tick = **20 ms** на progressive half при 50 Hz pump.
- Phase 11 telemetry budget часто нормализует к **20_000 µs** (field) или к frame_duration DeckLink.

Целевые доли (см. §9 Gates):

- `copy_us + weave_us` ≤ заданный % бюджета
- Phase 11 post-fix: copy+weave+schedule ~9–11% budget (было 17–22% до pools)

Zero-copy цель — **срезать copy_us** почти к нулю (остаётся weave), и снизить DRAM contention для CEF.

---

## 2. Memory math: 8.29 MB кадр и dual-channel DDR4

### 2.1 Геометрия кадра

| Параметр | Значение |
|----------|----------|
| Width | 1920 |
| Height | 1080 |
| bpp | 4 (BGRA8) |
| `frame_bytes_` | 8_294_400 |
| MiB | 8_294_400 / 1_048_576 ≈ **7.910 MiB** |
| Line bytes | 1920×4 = 7680 |
| Typical DeckLink `row_bytes_` | ≥ 7680 (stride padding возможен) |

Для output buffer: `output_bytes = row_bytes_ * height` — может быть **больше** 8.29 MB. Pool ключуется по точному size.

### 2.2 Теоретическая пропускная способность памяти Ryzen 5 3600

Типичный стенд Titulus (ориентир Phase 11 baseline):

| Параметр | Типичное значение |
|----------|-------------------|
| DIMM | Dual-channel DDR4 |
| Data rate | DDR4-3200 (часто) |
| Peak per channel | 25.6 GB/s |
| Peak dual | **51.2 GB/s** |
| Practical sequential | ~35–40 GB/s |
| Latency | ~70–90 ns DRAM |

**Доля нашей copy chain от peak:**

```
6.8 GB/s / 51.2 GB/s ≈ 13% peak
6.8 GB/s / 38 GB/s  ≈ 18% practical
```

Кажется «мало», но:

1. CEF/Blink одновременно читает/пишет textures, GC, raster — **тот же** memory controller.
2. SoftIRQ / PCIe DMA DeckLink тоже конкурирует.
3. Cross-CCX traffic идёт через Infinity Fabric с меньшей эффективной BW.
4. Latency spikes важнее average utilization: один blocked memcpy на completion thread → late frame.

### 2.3 Working set: сколько кадров «живут» одновременно

Per channel (interlaced, pools filled):

| Buffer | Count (order of) | Bytes |
|--------|------------------|-------|
| FrameRing slot | 1 | 8.29 MB |
| `frame_queue_` | ≤ `kMaxQueuedFrames` (обычно small) | N×8.29 |
| `field_a_`, `field_b_` | 2 | 16.6 MB |
| `black_frame_` | 1 | 8.29 MB |
| Output recycle pool | ≤ `kMaxRecycledBuffers` | M×output |
| Input pool idle | ≤ kMax | P×8.29 |

Грубо **40–80+ MB** только graphics buffers на канал → **120–240+ MB** на 3ch, плюс CEF memory. Это уже выходит далеко за L3 (32 MB total на 3600).

**Вывод:** после первого touch кадр почти всегда DRAM-backed. Non-temporal stores на weave — правильный выбор: не засорять L3 write-once destination.

### 2.4 Cache-line и alignment math

```
Cache line = 64 B
frame_bytes_ / 64 = 129_600 lines exactly (8_294_400 % 64 == 0)
```

`AlignedBuffer::kAlign = 64` — хорошо для:

- избежания false sharing с heap metadata;
- AVX2 32B loads/stores (и NT stores);
- потенциальных huge-page mappings (2 MB): `8_294_400 / 2_097_152 ≈ 3.95` → 4 huge pages на кадр.

### 2.5 Bandwidth pressure scenarios

| Scenario | Copy stages | Est. DRAM touch | Risk |
|----------|-------------|-----------------|------|
| Ideal fewer-copy (only #1 + weave) | 2 | ~3.5–4 GB/s | Healthy headroom |
| Current (#1+#2+weave) | 3 | ~5–7 GB/s | Contends with CEF |
| Current + high singles | 3+Clone | spikes | late on completion |
| Naive + UYVY convert | copy+convert+weave | CPU-bound | usually worse |

### 2.6 1080p50 progressive vs 1080i50 weave bandwidth

**True progressive 50p out** (Phase 18 context): weave может исчезнуть как geometry transform, но остаётся full-frame schedule copy если stride ≠ packed.  
**Interlaced 25 out from 50 progressive:** weave обязателен; fewer-copy выигрыш = убрать #2 и #4.

Документ фокусируется на **3×1080p50 BGRA render** feeding DeckLink (i или p) — memory math от progressive frame size.

---

## 3. CCX / L3 topology Ryzen 5 3600 и pinning

### 3.1 Железная топология Zen 2

```
Ryzen 5 3600 (Zen 2 Matisse)
├── CCD (один)
│   ├── CCX0: cores 0-1-2 + SMT siblings | L3 = 16 MB
│   └── CCX1: cores 3-4-5 + SMT siblings | L3 = 16 MB
│         └── Infinity Fabric между CCX
└── Memory controllers (dual-channel) — chip-level
```

Linux часто нумерует:

```
physical cores: 0,1,2 (CCX0), 3,4,5 (CCX1)
SMT:            6,7,8          9,10,11
```

Проверка на хосте:

```bash
lscpu -e
cat /sys/devices/system/cpu/cpu0/cache/index3/shared_cpu_list
# ожидаем два домена L3
```

### 3.2 Почему это важно для frame buffers

1. **L3 private per CCX:** кадр, написанный CEF на ядрах CCX0, при чтении completion thread на CCX1 идёт через IF — выше latency, ниже hit rate.
2. **False sharing:** mutex `FrameRing::mu_` + buffer на одной линии с чужими данными — pinning не спасёт, alignment помогает.
3. **3 channels on 6 cores:** Titulus pin `taskset` 2 physical cores (+ SMT) на `bg_engine`. Phase 11: CCX reshuffle исследовали; Ch2 straddling CCX был лучшим performer — **не догма**, но сигнал что topology experiments нужны с telemetry, не «по учебнику».

### 3.3 Pinning implications для zero-copy

| Подход | Pinning guidance |
|--------|------------------|
| Keep memcpy #1+#2 | Копии «переносят» данные ближе к consumer CCX — иногда скрывает remote L3 |
| Ownership move без #2 | Buffer остаётся на NUMA/CCX где был написан CEF — **pin CEF+callback same CCX** критичнее |
| Weave NT stores | Destination cold в L3 — хорошо; source lines должны быть local read |
| Multi-channel | Избегать трёх engine на одном CCX (16 MB L3 thrash) |

### 3.4 Рекомендуемая дисциплина экспериментов

1. Зафиксировать `taskset` map в runbook эксперимента.  
2. Менять **один** фактор: либо copy design, либо pin map — не оба сразу.  
3. Смотреть `copy_us`, `weave_us`, `late`, `in_fps` per channel.  
4. `perf stat -e mem_load_retired.l3_miss` (или аналог Zen) per process.

### 3.5 Пример pin map (иллюстрация, не production default)

```
Ch1 bg_engine: cores 0,6   (CCX0 phys+SMT)
Ch2 bg_engine: cores 3,9   (CCX1)
Ch3 bg_engine: cores 1,7   (CCX0)  # contention risk with Ch1 — measure
```

Альтернатива «один канал = один CCX» не масштабируется на 3ch / 2 CCX без sharing — отсюда ценность fewer copies: меньше bytes × shared L3.

### 3.6 Infinity Fabric и remote read cost (качественно)

Перенос 8.29 MB remote:

```
Time ≈ size / effective_IF_BW + latency_tax
```

Даже если IF BW высок, **latency tax** на line-by-line weave (1080 iterations с мелкими 7680 B copies) чувствительнее, чем один большой memcpy. Поэтому:

- крупные `StreamCopy`/`memcpy` иногда выгоднее remote, чем мелкий strided access;
- но NT line weave уже измерен Phase 11 — менять микропаттерн только с A/B bench.

---

## 4. Step-by-step: zero-copy / fewer-copy designs

### 4.0 Принципы дизайна

1. **CEF paint buffer никогда не escaping OnPaint** без явной копии или документированного CEF API ownership (которого нет).  
2. **Один writer / один logical owner** на buffer slot; completion thread не free'ит то, что CEF ещё пишет.  
3. **Interlaced semantics** Phase 10: не mix fresh A со stale B.  
4. **Move > memcpy > alloc.**  
5. **Instrument before/after** (`copy_us`, custom counters).  
6. **Rollback** одним flag / compile switch.

### 4.1 Design A — Weave напрямую из ring / queue buffers (two latest progressive)

**Идея:** `field_a_` / `field_b_` — не отдельные копии, а **views/ownership** двух последних progressive `AlignedBuffer` из queue. Weave читает их напрямую.

**As-is уже близко:** при `fresh==2` код делает `field_a_ = move(f0); field_b_ = move(f1)` — **без** memcpy. Лишний copy — только на intake (#2) и singles (#4).

**Улучшение A1 — убрать singles Clone:**

Вариант A1a — **alias**:

```cpp
// Эскиз (Titulus-style). Не production без refcount.
// Если field_a_ и field_b_ могут указывать на один AlignedBuffer —
// нужен shared ownership (см. Design B refcount).

if (fresh == 1) {
  RecycleInputBuffer(std::move(field_a_));
  RecycleInputBuffer(std::move(field_b_));
  field_b_ = std::move(f0.bytes);
  field_a_alias_ = true;  // weave reads B for both fields
}
```

В `ScheduleWovenOutput`:

```cpp
const AlignedBuffer& a = field_a_alias_ ? field_b_ : field_a_;
const AlignedBuffer& b = field_b_;
```

**Плюсы:** −8.29 MB на singles; простая семантика.  
**Минусы:** ветвление в hot weave; нельзя recycle A отдельно от B пока alias.

Вариант A1b — **refcount SharedFrame** (чище):

```cpp
struct SharedFrame {
  std::shared_ptr<AlignedBuffer> bytes; // или intrusive refcount
  uint64_t seq = 0;
};
```

Тогда singles: `field_a_ = field_b_ = shared`. Weave holds shared_ptr until Schedule done… но Schedule move'ит только output. Input fields живут до следующего completion — OK.

**Gate:** `singles` path latency; no increase in tearing.

### 4.2 Design B — Move ownership / swap вместо memcpy в OnFrame

**Идея:** `FrameRing` хранит не `vector` + memcpy из CEF, а **пул слотов**:

```
OnPaint:
  slot = ring.AcquireWriteSlot();      // empty AlignedBuffer from pool
  memcpy(slot, cef_bgra, FRAME);       // COPY #1 only (inevitable)
  ring.Publish(slot);                  // atomic swap published pointer

OnFrame / Latest:
  published = ring.TakeLatest();       // move ownership to consumer
  queue.push(published);               // NO CopyFrom
```

Эскиз API:

```cpp
class FrameRing2 {
 public:
  void PublishFromCef(const uint8_t* bgra, int w, int h) {
    AlignedBuffer buf = pool_.Get();
    buf.Reset(size_t(w) * size_t(h) * 4);
    // optionally StreamCopy if buf not read later by CEF — here consumer reads
    std::memcpy(buf.data(), bgra, buf.size());
    {
      std::lock_guard<std::mutex> lock(mu_);
      if (!published_.empty()) pool_.Put(std::move(published_));
      published_ = std::move(buf);
      width_ = w; height_ = h;
    }
    seq_.fetch_add(1, std::memory_order_release);
  }

  bool TakeLatest(BufferedFrame& out) {
    std::lock_guard<std::mutex> lock(mu_);
    if (published_.empty()) return false;
    out.bytes = std::move(published_);
    out.seq = seq_.load(std::memory_order_relaxed);
    return true;
  }
 private:
  std::mutex mu_;
  AlignedBuffer published_;
  BufferPool pool_;
  std::atomic<uint64_t> seq_{0};
  int width_ = 0, height_ = 0;
};
```

**Плюсы:** убирает Copy #2; `copy_us` в OnFrame → ~0 (только queue push).  
**Минусы:**

- `Latest(visit)` pointer model в `main.cpp` / null/pipe/preview consumers ломается — нужен dual API или adapter.
- Если TakeLatest вызывается реже, чем Publish, предыдущий published recycle в pool — OK (latest-only semantics сохранены).
- Browser/null path тоже должен либо Take, либо копировать для своих нужд — **не трогать** browser path поведение без bench (architecture rule).

**Мягкий rollout:** flag `--ring-ownership=1` только для decklink consumer; FrameRing legacy остаётся для pipe/preview.

### 4.3 Design C — Double-slot FrameRing (producer/consumer без mutex на memcpy)

Классика SPSC:

```
slots[2]: AlignedBuffer
write_idx / read_idx atomics
```

Producer пишет в inactive slot, atomic publish index.  
Consumer читает published slot **без** копирования, но **не должен** удерживать pointer через следующий publish — либо копирует (#2), либо Take (Design B).

Double-slot без Take **не** убирает #2 для async DeckLink queue — только снижает lock hold time (memcpy вне shared lock с consumer read).

Оптимизация lock:

```cpp
void Copy(...) {
  // memcpy WITHOUT holding mu_ into staging_, then lock+swap pointers
}
```

Это уменьшает contention CEF↔pump, но не DRAM bytes.

### 4.4 Design D — Pool deepening, 64B align, huge pages

#### 4.4.1 Pool deepening

Сейчас `kMaxRecycledBuffers` ограничивает pool. Underflow → `AlignedBuffer(frame_bytes_)` → `aligned_alloc` + soft page faults → spike `copy_us` (Phase 11 lesson).

Рекомендации:

| Pool | Deepening heuristic |
|------|---------------------|
| input_pool_ | ≥ `kMaxQueuedFrames + 2 fields + 2` per channel |
| recycle_pool_ (output) | ≥ preroll depth + 2 |
| ring pool (Design B) | ≥ 3 (write, published, in-flight take) |

Telemetry counters:

- `pool_input_hit` / `pool_input_miss`
- `pool_output_hit` / `pool_output_miss`

Miss rate > 0.1% на soak → deepen или leak detection.

#### 4.4.2 Alignment 64B

Уже есть. Проверить:

- `StreamCopy` fast path требует **32B** src/dst; 64B ≥ 32B.
- После `aligned_alloc(64, rounded)` OK.
- Осторожно с `vector<uint8_t>` в текущем FrameRing — **не** гарантирует 64B align → Design B должен использовать `AlignedBuffer` в ring.

#### 4.4.3 Huge pages (2 MB) tradeoffs

```bash
# transparent hugepage (system-wide)
cat /sys/kernel/mm/transparent_hugepage/enabled
# madvise
madvise(ptr, size, MADV_HUGEPAGE);
# explicit hugetlbfs — operationally heavier
```

| Pros | Cons |
|------|------|
| Fewer TLB misses на 8MB scan | Compaction latency; allocation failure |
| Стабильнее large memcpy | Не portable на всех deploy |
| | THP khugepaged может сюрпризить latency |

**Рекомендация:** optional `MADV_HUGEPAGE` на pooled buffers после Reset; измерить `copy_us` p99 / TLB metrics. Не делать hard dependency.

### 4.5 Design E — Non-temporal stores (существующий `simd_copy.h`)

Уже применено к **weave destination**. Кандидаты расширения:

| Path | NT store? | Почему |
|------|-----------|--------|
| Weave dst | ✅ yes | write-once → DMA |
| FrameRing Copy dst | ⚠️ maybe | consumer скоро читает — NT может **вредить** (bypass L3, next read = DRAM) |
| OnFrame CopyFrom dst | ⚠️ maybe | completion скоро читает для weave — если сразу weave, NT вреден; если queue delay, спорно |
| Singles Clone | ❌ probably no | immediate read in weave |

**Правило:** non-temporal только если buffer **не читается CPU** после записи до «забывания». Weave out — да. Ring buffer — обычно нет.

Микрооптимизация `StreamCopy`:

- сейчас 32B NT loop; можно 64B (`_mm256_stream` ×2) — marginal;
- prefetch src (`_mm_prefetch`) на line weave — bench required;
- остаток memcpy хвоста — OK.

### 4.6 Design F — In-place weave into DeckLink buffer from field pointers

Идея: `GetBytes` buffer заполняется weave'ом — **уже так**.  
Дальнейший zero-copy: если progressive out и `row_bytes_ == width*4`, **schedule field buffer напрямую** без weave copy:

```cpp
if (!interlaced_ && row_bytes_ == width_*4) {
  auto* frame = new OwnedDecklinkFrame(w, h, row_bytes_, std::move(field_a_));
  // field_a_ emptied — must GetInputBuffer next time
  ScheduleVideoFrame(frame, ...);
}
```

**Плюсы:** −weave bandwidth на progressive.  
**Минусы:** нельзя recycle тот же buffer пока карта DMA читает — уже решено TakeBuffer на completion; field_a_ must not be reused until then — move в OwnedDecklinkFrame делает именно это.

Это сильный win для true-50p progressive path (Phase 18), слабый для interlaced.

### 4.7 Порядок внедрения (рекомендуемый)

```
Step 0  Instrument pool hit/miss + ring_copy_us (отдельно от onframe_copy_us)
Step 1  Singles alias / shared (Design A1) — low risk, local to decklink_consumer.cpp
Step 2  Deepen pools + MADV_HUGEPAGE experiment
Step 3  FrameRing ownership Take for decklink only (Design B) — touches frame_ring.h, main.cpp glue
Step 4  Progressive direct-schedule (Design F) behind flag
Step 5  Revisit pixel format (§6) only if Step 3–4 недостаточны
```

---

## 5. DeckLink GetBytes zero-copy pattern

### 5.1 Контракт IDeckLinkVideoFrame / IDeckLinkVideoBuffer

Карта при schedule удерживает frame COM object, вызывает `GetBytes` / buffer access, DMA из user memory. Требования:

1. Pointer стабилен до completion callback (или EndAccess — по SDK version).  
2. Memory не relocating (не `vector` reallocation).  
3. Alignment/stride соответствуют `GetRowBytes` / pixel format.

### 5.2 Titulus OwnedDecklinkFrame (факт)

Реализует `IDeckLinkVideoFrame` + `IDeckLinkVideoBuffer`:

- storage = `AlignedBuffer` (move-only);
- `GetBytes` → `data_.data()`;
- `TakeBuffer` на completion → recycle pool.

Это и есть **zero-copy handoff to hardware**.

### 5.3 Reimplement idea from CasparCG decklink_frame (без копирования кода)

Идеи (clean-room):

| Idea | Titulus mapping |
|------|-----------------|
| Frame owns contiguous allocation | `AlignedBuffer` |
| GetBytes returns owned pointer | already |
| Pool frames to avoid alloc | `recycle_pool_` |
| Pixel format constant | `bmdFormat8BitBGRA` |
| Refcount COM | `AddRef`/`Release` atomics |

Не переносить: GPL-файлы, SSSE3 memshfl для alpha shuffle (у нас другая цель — NT copy), CasparCG allocator internals.

### 5.4 Антипаттерны (запретить)

```cpp
// BAD: copy into temporary for GetBytes
HRESULT GetBytes(void** buffer) override {
  tmp_.resize(size_);
  memcpy(tmp_.data(), data_.data(), size_);  // destroys zero-copy
  *buffer = tmp_.data();
}
```

```cpp
// BAD: return pointer into FrameRing while schedule in flight
*buffer = ring_ptr; // UAF / race with OnPaint
```

```cpp
// BAD: stack buffer
uint8_t stack[8294400]; // NL; also huge stack
```

### 5.5 Synergy with fewer-copy intake

После Design B+F:

```
CEF → (memcpy #1) → AlignedBuffer slot
     → queue (move)
     → field (move)
     → OwnedDecklinkFrame (move)  // progressive direct
     → GetBytes → DMA
```

Interlaced:

```
… → field_a_/field_b_ (move)
  → weave NT into output AlignedBuffer
  → OwnedDecklinkFrame
  → GetBytes → DMA
```

Минимальное число CPU copies: **1 (CEF) + 1 (weave)** или **1 (CEF)** для progressive packed stride.

---

## 6. BGRA vs UYVY vs v210 — tradeoff analysis

### 6.1 Размеры кадра

| Format | bpp (approx) | 1920×1080 bytes | vs BGRA |
|--------|--------------|-----------------|---------|
| BGRA8 | 4.0 | 8_294_400 | 1.00× |
| UYVY (4:2:2 8-bit) | 2.0 | 4_147_200 | 0.50× |
| v210 (4:2:2 10-bit packed) | 2.6875 | ~5_529_600 | ~0.67× |

### 6.2 Где экономия

Меньше bytes на:

- weave/copy stages;
- DRAM ↔ CPU;
- PCIe DMA (карта читает меньше).

### 6.3 Где цена

CEF OSR выдаёт **BGRA**. Convert CPU:

```
cost_convert ≈ c * width * height  // often > memcpy
```

Типичный BGRA→UYVY: read 4 bytes, chroma subsample, write 2 bytes — arithmetic + gather/scatter. На Zen2 без GPU это легко **дольше**, чем memcpy 8MB.

CasparCG porting map: `v210_strategies` — **deferred** post-MVP; MVP = 8-bit BGRA (`docs/CASPARRCG_PORTING.md`).

Architecture non-negotiable: **BGRA end-to-end** unless measured gate doc.

### 6.4 Keyer / alpha

External key / `IDeckLinkKeyer` path опирается на alpha в BGRA. UYVY/v210 **без alpha** ломают keyer model или требуют отдельный key plane → ещё трафик.

### 6.5 Recommendation

**Держать BGRA**, пока:

1. Fewer-copy (убрать #2/#4) не исчерпан.  
2. Нет измерения, что convert_us + smaller DMA < current copy+weave на 3ch.  
3. Keyer requirements не изменились.

Если когда-либо gate:

```
Hypothesis: UYVY wins if convert_avx2 < 0.5 * memcpy_8MB and keyer unused
Experiment: single channel microbench → 3ch soak → visual QA
Rollback: format flag default BGRA
```

---

## 7. Instrumentation

### 7.1 Существующее (Phase 11)

В `decklink_consumer.cpp`:

- `copy_us_sum_/max_/count_` — OnFrame path (pool get + CopyFrom + queue)
- `weave_us_*` — ScheduleWovenOutput StreamCopy loop
- `schedule_us_*` — ScheduleVideoFrame call
- Лог каждые ~5s: `weave_avg_us`, `weave_pct` of budget, etc.

### 7.2 Рекомендуемые доп. counters

| Counter | Meaning |
|---------|---------|
| `ring_copy_us` | время `FrameRing::Copy` / PublishFromCef |
| `onframe_copy_us` | только memcpy в OnFrame (без pool lock) |
| `pool_input_miss` | GetInputBuffer alloc path |
| `pool_output_miss` | GetOutputBuffer alloc path |
| `singles_clone_us` | время Clone #4 |
| `bytes_copied` | сумма байт CPU copy / window |
| `ownership_takes` | Design B takes |
| `alias_singles` | сколько раз A aliased to B |

### 7.3 Разделение copy_us

Сейчас `copy_us` смешивает pool pop + memcpy + lock. Для zero-copy gate нужно:

```cpp
t0 = now();
buf = GetInputBuffer();
Record(pool_us);
t1 = now();
buf.CopyFrom(...);
Record(memcpy_us);
```

После Design B `memcpy_us` → 0; `pool_us` может остаться маленьким.

### 7.4 perf / OS tools

```bash
# per-process memory bandwidth proxies (Zen / generic)
perf stat -p $(pgrep -n bg_engine) -e cycles,instructions,cache-misses \
  -e mem_load_retired.l3_miss  # name may vary; use perf list | grep mem

# sampling
perf record -p PID -e mem_load_l3_miss_retired.all_loads -g -- sleep 30
perf report

# TLB
perf stat -e dTLB-load-misses,iTLB-load-misses -p PID -- sleep 20
```

Сопоставлять с окном telemetry Titulus (5s log).

### 7.5 Custom Userspace markers

Опционально:

```cpp
// lightweight; disabled by default
BG_TRACE_SCOPE("weave");
```

Или `BPF` USDT probes — только если операционно готовы.

### 7.6 Bench harness

```bash
./bench/run-bench.sh 3 30 5   # browser/null regression обязателен
# DeckLink soak: existing run-engines + telemetry grep copy_avg weave_avg late dropped
```

Не регрессировать browser path при ring redesign.

---

## 8. Implementation checklist (engine files)

### 8.1 `engine/src/frame_ring.h`

- [ ] Решить: legacy `Copy`+`Latest(visit)` сохранить для pipe/preview.
- [ ] Добавить `FrameRingOwnership` или режим Publish/Take с `AlignedBuffer`.
- [ ] Убрать `std::vector` backing для decklink mode (alignment).
- [ ] Sequence semantics: latest-only сохранить.
- [ ] Документировать lifetime: Take empties published slot.
- [ ] Stress test: OnPaint storm + slow consumer.

### 8.2 `engine/src/aligned_buffer.h`

- [ ] Рассмотреть `Swap(AlignedBuffer&)` helper.
- [ ] Optional `AdviseHugePage()` post-Reset.
- [ ] Optional intrusive refcount wrapper `SharedAlignedBuffer` для singles alias.
- [ ] `CopyFrom` оставить; добавить `CopyFromStream` только если bench за NT (скорее нет).
- [ ] Запретить copy ctor (уже delete) — хорошо для ownership.

### 8.3 `engine/src/simd_copy.h`

- [ ] Оставить NT для weave dst.
- [ ] Не включать NT в ring publish без bench.
- [ ] Рассмотреть prefetch API `StreamCopyLine`.
- [ ] Сохранить `StreamCopyFence` перед ScheduleVideoFrame.
- [ ] Unit/microbench vs memcpy на 7680 и 8294400.

### 8.4 `engine/src/consumers/decklink_consumer.cpp`

- [ ] Split telemetry copy stages (§7.3).
- [ ] Singles alias path (Design A1).
- [ ] OnFrame: move from ownership ring when enabled.
- [ ] Progressive direct-schedule flag (Design F).
- [ ] Pool deepen + miss counters.
- [ ] Assert `GetBytes` never clones.
- [ ] Preserve Phase 10 queue semantics (no A/B time invert).
- [ ] Keep browser/stream consumers untouched.

### 8.5 `engine/src/main.cpp`

- [ ] Wiring: если decklink + ownership ring → Take path вместо Latest visitor memcpy assumptions.
- [ ] External clock `WaitForTick` loop: не увеличивать hold time.
- [ ] CLI flag / env `TITULUS_RING_OWNERSHIP=1`.
- [ ] Log mode at startup.

### 8.6 `engine/src/engine_client.cpp` / OnPaint

- [ ] Вызов `ring.PublishFromCef` vs `ring.Copy`.
- [ ] Не держать CEF pointer после OnPaint.
- [ ] PET_VIEW filter / scale factor без изменений.

### 8.7 Docs / porting

- [ ] Обновить `docs/CASPARRCG_PORTING.md` строкой decision (clean-room).
- [ ] Phase note в development-phases при реализации.
- [ ] Rollback § Appendix C.

### 8.8 Verification commands

```bash
# build
cmake --build engine/build -j$(nproc)

# 3ch soak — смотреть telemetry
# grep copy_avg / weave_avg / late / dropped / pool_miss

# regression
./bench/run-bench.sh 3 30 5
```

---

## 9. Gates (acceptance)

### 9.1 Primary gates

| Gate | Criterion | Notes |
|------|-----------|-------|
| G1 Copy+weave budget | `copy_avg_us + weave_avg_us` ≤ **X%** field budget | X предложить: **≤ 8%** @ 20ms (≤1600 µs sum) после ownership; калибровать от Phase 11 baseline |
| G2 Late/drop | no increase vs baseline soak | `late`, `dropped`, `flushed` |
| G3 3ch soak | ≥ 30 min (prefer formal 8h in Phase 6.4 style) | all channels |
| G4 in_fps | decklink-driven channels hold ~50 progressive in | exclude known content decode limits |
| G5 Browser/null | bench within Phase 0 noise | must not regress |

### 9.2 Как выбрать X

Phase 11 post-pool: sum copy+weave+schedule ~9–11% budget.  
Ownership aim:

```
copy_avg → < 100 µs (queue only) or < 50 µs
weave_avg → same or better (less DRAM contention)
schedule_avg → unchanged
```

Если budget_us = 20000:

```
X = 8% → 1600 µs for copy+weave
```

Зафиксировать X в PR test plan после одного baseline capture на том же host/content.

### 9.3 Secondary gates

| Gate | Criterion |
|------|-----------|
| S1 pool_miss | < 0.1% Get* calls |
| S2 singles_clone | 0 memcpy when alias enabled |
| S3 bytes_copied/s | ≥ 40% reduction vs as-is for stages #2+#4 |
| S4 visual | no comb/tear on known interlaced patterns |
| S5 CPU | process CPU% not up (convert traps) |

### 9.4 Fail → actions

| Failure | Action |
|---------|--------|
| late up, copy down | lock contention / ownership race — fix lifetime |
| weave up | CCX remote reads — revisit pin |
| pool_miss up | deepen pool; check leaks |
| browser fps down | ring API shared incorrectly — isolate flag |

---

## 10. Risks

### 10.1 Lifetime / use-after-free CEF paint buffer

**Риск:** сохранить `const uint8_t*` из OnPaint в queue.  
**Симптом:** random corruption, CEF crashes, «иногда» glitches.  
**Mitigation:** только memcpy или CEF-documented ownership (нет); ASAN/TSAN builds на dev; assert no cef pointer stored.

### 10.2 Use-after-free / double-free pooled AlignedBuffer

**Риск:** move в OwnedDecklinkFrame + ещё один hold в field_*.  
**Mitigation:** move-only discipline; never copy AlignedBuffer; TSAN; recycle only via TakeBuffer.

### 10.3 Tearing / torn read

FrameRing сегодня: seq before/after — torn read «acceptable» for latest.  
Ownership Take: publish atomicity must be pointer swap **after** full memcpy complete.

### 10.4 Interlaced time inversion (Phase 10)

Mixing new A with old B → comb/flicker.  
Fewer-copy не меняет queue pop policy — **не упрощать** starvation logic.

### 10.5 Lock contention

`queue_mu_`, `input_pool_mu_`, `recycle_mu_`, ring `mu_`.  
Ownership может увеличить critical section complexity. Prefer short locks; memcpy outside.

### 10.6 DMA still in flight

Recycling output buffer before completion → flicker/tearing on air.  
Только `OnScheduledFrameCompleted` → `TakeBuffer` → pool.

### 10.7 Singles alias hazards

Если weave и recycle неправильно: free while alias.  
Alias flag clear only when both fields replaced.

### 10.8 Huge pages latency

THP compaction stalls.  
Mitigation: MADV optional; measure p99.

### 10.9 GPL contamination

Читать CasparCG как reference OK; не переносить код. Clean-room notes в PR.

### 10.10 Scalability cliff

Design OK on 3ch может сломаться на 4+ без pin/BW headroom. Document assumed N=3 MVP.

---

## 11. Appendices

### Appendix A — Diagrams

#### A.1 As-is data plane

```
OnPaint (CEF)
    │ 8.29MB memcpy (#1)
    ▼
FrameRing.buffer_  ◄── mutex ──► Latest(visitor)
    │                              │ pointer (short)
    │                              ▼
    │                         OnFrame CopyFrom (#2)
    │                              ▼
    │                         frame_queue_ (AlignedBuffer)
    │                              │ move
    │                              ▼
    │                         field_a_ / field_b_
    │                         (#4 Clone if singles)
    │                              │
    │                              ▼
    │                         StreamCopy weave (#3 NT)
    │                              ▼
    │                         OwnedDecklinkFrame
    │                              │ GetBytes pointer
    ▼                              ▼
   (next paint)               DeckLink DMA
```

#### A.2 Target fewer-copy (ownership + alias)

```
OnPaint
    │ memcpy (#1) into pooled AlignedBuffer
    ▼
Ring published slot ──Take/move──► frame_queue_
                                      │ move
                                      ▼
                                 field_a_/field_b_
                                 (alias if singles: no #4)
                                      │
                    interlaced ───────┼──────── progressive packed
                         │            │              │
                         ▼            │              ▼
                  StreamCopy (#3)     │     move buffer to OwnedFrame
                         ▼            │              │
                  OwnedDecklinkFrame ◄─┘              │
                         │ GetBytes                  │
                         ▼                           ▼
                    DeckLink DMA ◄────────────────────┘
```

#### A.3 CCX sketch

```
          [ DRAM dual-channel ]
                  |
        +---------+---------+
        |                   |
     CCX0 L3 16MB        CCX1 L3 16MB
     cores 0-2           cores 3-5
        |                   |
     Ch1 engine?         Ch2 engine?
     Ch3?                (measure)
```

#### A.4 Sequence: ownership publish

```
CEF thread              Pump / OnFrame           Completion thread
    |                        |                         |
    | Acquire buf            |                         |
    | memcpy CEF→buf         |                         |
    | Publish(buf)           |                         |
    |                        | TakeLatest              |
    |                        | push queue              |
    |                        |                         | pop 2 frames
    |                        |                         | weave NT
    |                        |                         | Schedule
    |                        |                         | ... DMA ...
    |                        |                         | TakeBuffer→pool
```

### Appendix B — Code sketches (original Titulus-style C++)

#### B.1 Singles alias without refcount

```cpp
// decklink_consumer.cpp (sketch)
bool field_alias_ = false;

// in OnScheduledFrameCompleted, interlaced branch:
if (fresh == 2 && f0.bytes.size() == frame_bytes_ && f1.bytes.size() == frame_bytes_) {
    RecycleInputBuffer(std::move(field_a_));
    RecycleInputBuffer(std::move(field_b_));
    field_a_ = std::move(f0.bytes);
    field_b_ = std::move(f1.bytes);
    field_alias_ = false;
    pairs_.fetch_add(1, std::memory_order_relaxed);
} else if (fresh >= 1 && f0.bytes.size() == frame_bytes_) {
    RecycleInputBuffer(std::move(field_a_));
    RecycleInputBuffer(std::move(field_b_));
    field_b_ = std::move(f0.bytes);
    field_a_ = AlignedBuffer{}; // empty; alias uses B
    field_alias_ = true;
    singles_.fetch_add(1, std::memory_order_relaxed);
} else {
    starved_.fetch_add(1, std::memory_order_relaxed);
}

// ScheduleWovenOutput:
const AlignedBuffer& a = (field_alias_ || field_a_.size() != frame_bytes_)
    ? ((field_b_.size() == frame_bytes_) ? field_b_ : black_frame_)
    : field_a_;
const AlignedBuffer& b = (field_b_.size() == frame_bytes_) ? field_b_ : black_frame_;
```

#### B.2 Pool miss counter

```cpp
AlignedBuffer GetInputBuffer() {
    {
        std::lock_guard<std::mutex> lock(input_pool_mu_);
        if (!input_pool_.empty()) {
            AlignedBuffer buf = std::move(input_pool_.back());
            input_pool_.pop_back();
            pool_input_hit_.fetch_add(1, std::memory_order_relaxed);
            return buf;
        }
    }
    pool_input_miss_.fetch_add(1, std::memory_order_relaxed);
    return AlignedBuffer(frame_bytes_);
}
```

#### B.3 Ownership ring publish (sketch)

```cpp
#pragma once
#include "aligned_buffer.h"
#include <atomic>
#include <mutex>

namespace bg {

class OwnershipRing {
 public:
  void PublishFromCef(const uint8_t* bgra, int width, int height) {
    const size_t bytes = size_t(width) * size_t(height) * 4;
    AlignedBuffer buf = Obtain(bytes);
    std::memcpy(buf.data(), bgra, bytes); // inevitable copy #1
    AlignedBuffer old;
    {
      std::lock_guard<std::mutex> lock(mu_);
      old = std::move(slot_);
      slot_ = std::move(buf);
      width_ = width;
      height_ = height;
    }
    if (!old.empty()) Recycle(std::move(old));
    seq_.fetch_add(1, std::memory_order_release);
  }

  bool Take(AlignedBuffer& out, uint64_t& seq, int& w, int& h) {
    std::lock_guard<std::mutex> lock(mu_);
    if (slot_.empty()) return false;
    out = std::move(slot_);
    seq = seq_.load(std::memory_order_relaxed);
    w = width_;
    h = height_;
    return true;
  }

 private:
  AlignedBuffer Obtain(size_t bytes) {
    std::lock_guard<std::mutex> lock(pool_mu_);
    if (!pool_.empty() && pool_.back().size() == bytes) {
      AlignedBuffer b = std::move(pool_.back());
      pool_.pop_back();
      return b;
    }
    return AlignedBuffer(bytes);
  }
  void Recycle(AlignedBuffer&& b) {
    std::lock_guard<std::mutex> lock(pool_mu_);
    if (pool_.size() < 8) pool_.push_back(std::move(b));
  }

  std::mutex mu_;
  AlignedBuffer slot_;
  std::mutex pool_mu_;
  std::vector<AlignedBuffer> pool_;
  std::atomic<uint64_t> seq_{0};
  int width_ = 0;
  int height_ = 0;
};

}  // namespace bg
```

#### B.4 Progressive direct schedule (sketch)

```cpp
bool ScheduleProgressiveDirect(BMDTimeValue display_time) {
    if (interlaced_) return false;
    if (row_bytes_ != width_ * 4) return false;
    if (field_a_.size() != frame_bytes_) return false;

    const auto t0 = std::chrono::steady_clock::now();
    AlignedBuffer out = std::move(field_a_);
    // weave_us ~ 0
    RecordStageTime(weave_us_sum_, weave_us_max_, weave_us_count_, t0);

    auto* frame = new OwnedDecklinkFrame(width_, height_, row_bytes_, std::move(out));
    const HRESULT hr = output_->ScheduleVideoFrame(
        frame, display_time, frame_duration_, time_scale_);
    frame->Release();
    return hr == S_OK;
}
```

#### B.5 Safe GetBytes (reference shape — already in tree)

```cpp
HRESULT GetBytes(void** buffer) override {
    if (!buffer) return E_INVALIDARG;
    if (!data_.data()) return E_FAIL;
    *buffer = data_.data();
    return S_OK;
}
```

#### B.6 Measuring ring copy separately

```cpp
// engine_client OnPaint path sketch
const auto t0 = std::chrono::steady_clock::now();
ring.Copy(buffer, width, height);
const auto us = std::chrono::duration_cast<std::chrono::microseconds>(
    std::chrono::steady_clock::now() - t0).count();
ring_copy_us_max.fetch_max(us); // C++26; or CAS loop like RecordStageTime
```

### Appendix C — Rollback plan

1. **Feature flags**  
   - `TITULUS_RING_OWNERSHIP=0` (default during rollout)  
   - `TITULUS_SINGLES_ALIAS=0`  
   - `TITULUS_PROGRESSIVE_DIRECT=0`

2. **Git**  
   - Один PR = одна логическая ступень (A1 → B → F).  
   - Rollback: `git revert <merge-commit>` на main.

3. **Runtime abort**  
   - Если `late` превышает порог за 60s window — log fatal advice; optional auto-disable flag file.

4. **Data safety**  
   - Нет DB миграций; только engine.  
   - Rebuild `bg_engine`; restart channels via `run-engines.sh` full stop.

5. **Verification after rollback**  
   - Confirm telemetry back to baseline band.  
   - `./bench/run-bench.sh 3 30 5`.

### Appendix D — Bandwidth worksheet (fill on host)

```
FRAME_BYTES = 8294400
CHANNELS    = 3
FPS_IN      = 50
FPS_OUT     = 25   # interlaced container

copy1_GBs = FRAME_BYTES * FPS_IN * CHANNELS / 1e9
copy2_GBs = FRAME_BYTES * FPS_IN * CHANNELS / 1e9
weave_GBs = FRAME_BYTES * (2+1) * FPS_OUT * CHANNELS / 1e9

# Measured:
# copy_avg_us Ch1/2/3 =
# weave_avg_us =
# DRAM model peak_GBs = 51.2
# utilization_est = (copy1+copy2+weave)/peak
```

### Appendix E — Glossary

| Term | Meaning |
|------|---------|
| OSR | Off-Screen Rendering (CEF) |
| BGRA | Byte order B,G,R,A — CEF/DeckLink 8-bit |
| FrameRing | latest-frame SPSC holder |
| Weave | line-interleave two progressive frames → interlaced |
| UFF | Upper Field First |
| NT stores | non-temporal SIMD stores |
| RFO | Read-For-Ownership cache protocol |
| CCX | Core Complex (Zen L3 domain) |
| Soak | long run stability test |
| clean-room | reimplement by reference, no GPL copy |

### Appendix F — Related documents

| Doc | Relation |
|-----|----------|
| `docs/ARCHITECTURE.md` | topology, non-negotiables |
| `docs/CASPARRCG_PORTING.md` | BGRA, weave, memory reimplement notes |
| `docs/development-phases/phase-10-sdi-perf.md` | interlaced semantics |
| `docs/development-phases/phase-11-casparcg-parity.md` | pools, StreamCopy, telemetry baselines |
| `docs/development-phases/phase-17-raster-latency.md` | latency vs pool tradeoffs |
| `docs/development-phases/phase-18-true-50p-pipeline.md` | progressive path context |
| `.cursor/rules/architecture.mdc` | CPU-only, pinning pitfalls |

### Appendix G — Worked numeric examples

#### G.1 Single memcpy duration at 20 GB/s effective

```
t = 8.2944e6 / 20e9 = 414.7 µs
```

Три канала сериализованные на одном memory controller:

```
3 * 415 ≈ 1.25 ms
```

Близко к Phase 11 pre-fix copy_avg порядка миллисекунд (тогда ещё alloc). Пост-pool memcpy-only должен стремиться к ~0.4–0.8 ms under contention — ownership removes this stage from OnFrame.

#### G.2 Field budget fractions

```
budget = 20000 µs
copy = 500 µs → 2.5%
weave = 900 µs → 4.5%
sum = 7.0%  → pass if X=8%
```

#### G.3 3ch × copy#1+#2 only (no weave)

```
2 * 1.244 GB/s = 2.488 GB/s payload
≈ 5 GB/s R+W
```

### Appendix H — Test plan template (for future PR)

```markdown
## Test plan
- [ ] Capture baseline telemetry 5×5s windows on 3ch decklink
- [ ] Enable singles alias; confirm singles_clone_us=0; visual QA
- [ ] Enable ownership ring; confirm onframe memcpy≈0; late/drop flat
- [ ] 30 min soak; record late/drop/in_fps
- [ ] browser/null `./bench/run-bench.sh 3 30 5`
- [ ] perf L3 miss spot check
- [ ] Rollback flags verified
```

### Appendix I — FAQ

**Q: Можно ли совсем без memcpy из CEF?**  
A: Нет, при публичном OSR API. Paint buffer ephemeral.

**Q: Почему не GPU convert?**  
A: Architecture gate: CPU-only until separate GPU decision doc.

**Q: Почему не shared memory CEF?**  
A: CEF OSR не отдаёт наш buffer для paint в текущей модели; слом контракта / fork CEF — out of scope.

**Q: Pipe/preview consumers?**  
A: Оставить legacy FrameRing Latest(); ownership только decklink path.

**Q: Нужен ли SCHED_FIFO для memory work?**  
A: Нет напрямую; FIFO снижает scheduling jitter completion path, косвенно помогает late. Soft-fail without cap.

### Appendix J — Decision log (to fill during implementation)

| Date | Decision | Evidence | Revert path |
|------|----------|----------|-------------|
| YYYY-MM-DD | e.g. ship singles alias | soak link | flag off |
| 2026-07-14 | PR #68: add `memory5s` accounting (C1, C2, clone, weave, pools) before changing ownership | `engine/research/results/p19/doc03-20260714/memory-summary.json`; fresh 1ch/3ch baselines | revert merge commit #68 |
| 2026-07-14 | PR #69: ship singles alias as production behavior | clone bytes/count=0; `alias_singles=d_singles`; 15min 3ch soak, no late/drop/flush | revert merge commit #69 |
| 2026-07-14 | PR #70: retain direct OnPaint delivery as OFF-by-default experiment | C1 eliminated and 30min soak safe, but OFF/ON crossover showed no reliable 3ch fps uplift | omit flag; revert merge commit #70 |
| 2026-07-14 | Do not deepen pools or attempt MADV_HUGEPAGE | input/output miss rate <0.1% after warmup; no evidence of allocation bottleneck | no change |
| 2026-07-14 | Defer ownership ring / progressive direct schedule | direct delivery removes C1 but does not improve G2 throughput; target is interlaced 1080i50, weave remains required | revisit only after doc04 evidence |

### Appendix K — Extended risk matrix

| ID | Risk | Likelihood | Impact | Detection | Mitigation |
|----|------|------------|--------|-----------|------------|
| R1 | CEF UAF | Med if buggy | Critical | ASAN, visual trash | never store CEF ptr |
| R2 | DMA UAF | Med | Critical | tearing, decklink err | recycle only on completion |
| R3 | Lock convoying | Med | High late | copy_us spikes | shorten CS |
| R4 | CCX remote | Med | weave_us up | perf + pin map | co-locate threads |
| R5 | Pool shrink leak | Low | alloc spikes | miss counter | deepen; fix leak |
| R6 | Alias free | Med | crash | TSAN | clear alias carefully |
| R7 | Browser regress | Med | MVP fail | bench | isolate flags |
| R8 | Format experiment | Low | CPU blowup | convert_us | keep BGRA |
| R9 | THP stall | Low | p99 late | soak p99 | disable madvise |
| R10 | GPL mistake | Low | legal | review | clean-room only |

### Appendix L — Pseudocode: bytes accounting telemetry

```cpp
std::atomic<uint64_t> bytes_copied_{0};

void AccountCopy(size_t n) {
  bytes_copied_.fetch_add(n, std::memory_order_relaxed);
}

// in MaybeLogTelemetry:
const uint64_t bytes = bytes_copied_.exchange(0);
const double gbs = (bytes / 5.0) / 1e9; // 5s window
// log bytes_GBs=...
```

### Appendix M — Alignment proofs

```
8294400 % 64 == 0  → full-frame fits integer cache lines
8294400 % 32 == 0  → AVX2 NT loop covers all; no remainder if aligned ptr
7680 % 32 == 0     → each line exact 240× 32B stores
7680 % 64 == 0     → each line exact 120× 64B
```

Remainder path in StreamCopy should rarely run for full lines if pointers aligned.

### Appendix N — Interaction with Phase 17 raster pool vs latency

Phase 17 изучала raster pool vs latency. Memory pipeline doc **не** предлагает увеличить buffering без меры: ownership Take latest-only **уменьшает** copies without adding depth. Queue depth `kMaxQueuedFrames` — отдельный latency knob; zero-copy не требует deeper queue.

### Appendix O — Interaction with Phase 18 true 50p

Если output progressive 50p:

- Design F (direct schedule) становится primary win;
- weave NT path реже;
- CEF must sustain unique 50 fps (Phase 18 ceiling notes).

Fewer-copy intake (#2 removal) полезен **и** i, **и** p.

### Appendix P — Operator checklist before experiments

```bash
pgrep -af "bg_engine|run-channel|run-engines"
# stop supervisors fully if needed
# confirm taskset map
# confirm TITULUS_DATA / channels
# start engines; wait lock reference if genlock
# collect 5s telemetry lines
```

### Appendix Q — Suggested PR slicing

| PR | Scope | Risk |
|----|-------|------|
| PR1 | telemetry split + pool miss | very low |
| PR2 | singles alias | low |
| PR3 | pool deepen + madvise opt | low |
| PR4 | ownership ring decklink-only | medium |
| PR5 | progressive direct schedule | medium |

Один PR = одна логическая задача (git-workflow).

### Appendix R — Non-goals

- GPU path / VAAPI / CUDA  
- Changing template runtime away from HTML5  
- AMCP / CasparCG client  
- Copying GPL sources  
- Formal 8h soak closure (belongs Phase 6.4) as dependency to start coding  
- Microfreeze Phase 14 (skipped)

### Appendix S — Success narrative

После полного rollout на 3×1080p50 DeckLink:

1. CEF→engine: ровно **один** full-frame memcpy на paint.  
2. OnFrame: **move-only**, `onframe_copy_us≈0`.  
3. Singles: **zero** Clone.  
4. Interlaced: один NT weave в DMA buffer.  
5. Progressive packed: **zero** weave copy.  
6. GetBytes: pointer, zero copy.  
7. Gates G1–G5 зелёные; rollback flags не нужны в production default.

### Appendix T — Line-oriented review cues for reviewers

Reviewer checklist:

- [ ] No CEF pointer stored past OnPaint  
- [ ] AlignedBuffer moved, never shallow-copied  
- [ ] StreamCopyFence before ScheduleVideoFrame  
- [ ] Interlaced pop policy intact  
- [ ] Browser path unchanged or bench'd  
- [ ] Telemetry fields documented  
- [ ] No GPL paste  
- [ ] taskset notes if topology claimed  

### Appendix U — Memory bandwidth vs CPU compute (qualitative)

На Ryzen 3600 memcpy 8MB ~ memory-bound. CEF style/layout — compute/cache bound. Уменьшение copies освобождает BW для CEF, что может поднять **in_fps** даже если `copy_us` уже «мал» в абсолютных µs — системный эффект важнее локального.

### Appendix V — Alternative rejected designs

| Design | Why rejected (for now) |
|--------|------------------------|
| Map DeckLink buffer into CEF | CEF OSR won't paint into foreign buffer safely |
| Cross-process shared mem frames | complexity; still need CEF copy |
| Compress frames in ring | CPU disaster for live |
| 16-bit half float | size up; no decklink win |
| Wait-free 8-slot FIFO | latest-only enough; latency↑ |

### Appendix W — Open questions

1. Exact `kMaxQueuedFrames` / pool caps in current tree — verify before deepen.  
2. Host DDR speed (2933 vs 3200) — fill Appendix D.  
3. Does any channel run progressive display mode today?  
4. Should `ring_copy_us` export via backend WS or stderr only?  
5. ASAN CEF interaction cost — can we run ASAN engine on CI subset?

### Appendix X — Change impact matrix

| Component | PR1 | PR2 | PR3 | PR4 | PR5 |
|-----------|-----|-----|-----|-----|-----|
| frame_ring.h | | | | X | |
| aligned_buffer.h | | ~ | X | X | |
| simd_copy.h | | | | | ~ |
| decklink_consumer.cpp | X | X | X | X | X |
| main.cpp | | | | X | X |
| engine_client.cpp | | | | X | |
| browser consumer | | | | | |
| docs | X | X | X | X | X |

### Appendix Y — Minimal metric dashboard (text)

```
ch | in_fps | copy_us | weave_us | late | drop | pool_miss | bytes_GBs
1  |        |         |          |      |      |           |
2  |        |         |          |      |      |           |
3  |        |         |          |      |      |           |
```

### Appendix Z — Document history

| Ver | Date | Authoring context | Notes |
|-----|------|-------------------|-------|
| 0.1 | 2026-07-13 | performance investigation | Initial comprehensive design |
| 0.2 | 2026-07-14 | Phase 19 doc03 execution | PR #68 instrumentation, #69 singles alias shipped, #70 direct-paint kept experimental; results in `reports/p19-03-memory-pipeline.md` |

---

## 12. Closing recommendations

1. **Не начинать с pixel format** — сначала убрать Copy #2 и Clone #4.  
2. **Instrument split** обязателен до ownership merge.  
3. **DeckLink GetBytes уже zero-copy** — не ломать.  
4. **CCX pinning** измерять заново после ownership (remote L3 проявляется сильнее).  
5. **BGRA keep** unless hard measurement says otherwise.  
6. **Scalable path:** ownership ring + pooled AlignedBuffer + NT weave — без GPU, без GPL, совместимо с HTML5/CEF и frame-accurate DeckLink clock.

---

*Конец документа. При реализации — обновлять Appendix J Decision log и gates X% из живого baseline.*
