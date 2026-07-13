# 04 — OS scheduling, CPU pinning, DeckLink latency и genlock

> **Серия:** `docs/performance investigation/`  
> **Аудитория:** engine / platform / broadcast ops  
> **Хост-референс:** AMD Ryzen 5 3600 (6C/12T), DeckLink Quad 2, LES DG-14B  
> **Цель продукта:** 3×1080i50 CPU-only HTML5 graphics без frame drops, с масштабированием pinning на 16/32-core серверы  
> **Связанные документы:** `docs/ARCHITECTURE.md`, `docs/CASPARRCG_PORTING.md`, Phase 11/17, `06-microfreeze-thp-khugepaged.md` (THP)  
> **Статус:** investigation / ops design — не копировать CasparCG GPL-код; reimplement by reference

---

## 0. Executive summary

Titulus держит **один `bg_engine` = один channel**. На домашнем стенде (Ryzen 5 3600) три live DeckLink-канала 1080i50 укладываются в **ровно шесть physical cores**: по два phys core (+ SMT siblings) на канал. Это работает только если:

1. **CPU topology** понятна (CCX / L3 / SMT), а не «просто taskset 0-3».
2. **OS noise** (IRQ, RCU, timers, desktop, backend) не съедает budget поля (~20 ms на field, ~40 ms на interlaced frame).
3. **DeckLink scheduled playback** + **genlock reference** дают master clock; render pump блокируется на `WaitForTick()`, а не на свободном self-timer.
4. **Pinning масштабируется** через discovery (`lscpu -p`), а не hardcode «3600 = cores 0..5».

Этот документ разбирает OS scheduling и hardware clock end-to-end: от Zen2 CCX до `ref=locked` в telemetry, с Ubuntu config, rollback, measurement и soak gates.

### 0.1 Non-negotiables (повтор из architecture)

| Правило | Следствие для scheduling |
|---|---|
| CPU-only CEF OSR (`--disable-gpu`) | Вся стоимость кадра на CPU; pinning критичен |
| HTML5/DOM — единственный template runtime | Blink/compositor/raster threads живут внутри pin-mask |
| Frame-accurate SDI | DeckLink `ScheduledFrameCompleted` = master clock |
| Per-channel output | Не смешивать decklink RT path с browser self-timer |
| Не трогать browser/stream path при decklink RT-экспериментах | `SCHED_FIFO` только при `HasExternalClock()` |
| Scalable pinning | Auto-detect topology; 2 phys cores/ch — baseline, не dogma |

### 0.2 Бюджет времени 1080i50

```
Field period (1080i50):     ~20.0 ms
Output frame (pair):        ~40.0 ms
Target drop rate:           < 0.1%
Stage budget (copy+weave+schedule):  желательно < 15% от 40 ms  (~6 ms)
CEF BeginFrame + OnPaint:   остаток budget; jitter убивает late frames (d_late)
```

Любой OS preempt, IRQ storm, THP collapse или неправильный pin через CCX boundary съедает именно **CEF/raster** часть, не weave.

### 0.3 Карта документа

| § | Тема |
|---|---|
| 1 | Topology Ryzen 5 3600 |
| 2 | Текущий Titulus pinning |
| 3 | Ideal packing A/B/C для 3ch |
| 4 | isolcpus / nohz_full / rcu_nocbs / cpuset |
| 5 | SCHED_FIFO / capabilities / starvation |
| 6 | IRQ affinity DeckLink / NIC |
| 7 | Governor / C-states / turbostat |
| 8 | THP / khugepaged → doc 06 |
| 9 | DeckLink preroll / latency / clock |
| 10 | Genlock LES DG-14B / sync groups |
| 11 | Auto-detect topology script |
| 12 | Measurement toolkit |
| 13 | Gates / soak |
| 14 | Appendices |

---

## 1. Topology AMD Ryzen 5 3600: CCX, SMT, NUMA-less

### 1.1 Что видно на живом хосте Titulus

Реальный `lscpu` (июль 2026, стенд):

```
Model name:          AMD Ryzen 5 3600 6-Core Processor
CPU(s):              12
Thread(s) per core:  2
Core(s) per socket:  6
Socket(s):           1
L3 cache:            32 MiB (2 instances)
NUMA node(s):        1
NUMA node0 CPU(s):   0-11
```

Parsable topology (`lscpu -p=CPU,CORE,SOCKET,NODE`):

```
# CPU,Core,Socket,Node
0,0,0,0
1,1,0,0
2,2,0,0
3,3,0,0
4,4,0,0
5,5,0,0
6,0,0,0
7,1,0,0
8,2,0,0
9,3,0,0
10,4,0,0
11,5,0,0
```

Интерпретация:

| Physical core | Logical CPUs (SMT pair) |
|---|---|
| 0 | 0, 6 |
| 1 | 1, 7 |
| 2 | 2, 8 |
| 3 | 3, 9 |
| 4 | 4, 10 |
| 5 | 5, 11 |

Это **не** «CPU 0–5 = физика, 6–11 = SMT» как отдельный NUMA — это классическая AMD SMT numbering: sibling = `cpu + n_cores` при `n_cores=6`.

### 1.2 Zen 2 CCX: два острова L3

Ryzen 5 3600 (Zen 2, Matisse) = **два CCX** (Core Complex), по **3 cores** в каждом:

```
┌──────────────── CCX0 (L3 ≈ 16 MiB) ────────────────┐
│  Core0 (CPU 0/6)  Core1 (CPU 1/7)  Core2 (CPU 2/8) │
└─────────────────────────┬──────────────────────────┘
                          │ Infinity Fabric (медленнее, чем L3 hit)
┌──────────────── CCX1 (L3 ≈ 16 MiB) ────────────────┐
│  Core3 (CPU 3/9)  Core4 (CPU 4/10) Core5 (CPU 5/11)│
└────────────────────────────────────────────────────┘
```

Ключевые свойства:

- **L3 shared внутри CCX**, не между CCX.
- Cross-CCX cache line bounce идёт через **Infinity Fabric** → выше latency, ниже effective bandwidth для hot working set.
- **NUMA node = 1** → Linux видит UMA; scheduler **не** штрафует cross-CCX автоматически как NUMA miss. Это ловушка: «NUMA-aware» tooling молчит, а L3 reuse уже мёртв.

### 1.3 Почему bad pinning убивает L3 reuse

CEF OSR hot path (упрощённо):

```
UI / Blink main → compositor → raster threads → OnPaint(BGRA)
→ FrameRing → DecklinkConsumer (copy / weave / ScheduleVideoFrame)
```

Working set одного канала на 1080p BGRA:

| Буфер | Размер порядка |
|---|---|
| Full frame BGRA 1920×1080×4 | ~8.3 MiB |
| Два field buffer (interlace path) | ~8.3 MiB × N pooled |
| CEF/Skia tiles + glyph caches | непредсказуемо, часто > L3 share |
| Weave scratch / aligned pools | ещё несколько MiB |

Если канал A pinned на cores **0+3** (CCX0 + CCX1), то:

1. Raster thread пишет tile в L3 CCX0.
2. Compositor/main на CCX1 читает → **L3 miss + Fabric hop**.
3. SMT sibling на том же core делит execution resources, но **не спасает** cross-CCX.
4. Под нагрузкой 3 каналов Fabric становится shared bottleneck → рост paint latency p95 → `d_late` / singles вместо pairs.

**Правило:** один channel = **как можно больше cores внутри одного CCX**. На 3600 идеал: 2 phys cores **внутри одного CCX** (на CCX0 доступны только 3 cores → один канал «съедает» 2, остаётся 1 core spare или OS).

### 1.4 SMT: друг и враг

SMT (Simultaneous Multithreading) даёт второй logical CPU на том же physical core.

| Когда SMT помогает | Когда мешает |
|---|---|
| CEF имеет много runnable threads (raster + compositor + IO) | Два heavy AVX2 weave на одном core → contention |
| Один thread ждёт memory | Hyperthread steal у RT pump |
| `BG_NUM_RASTER_THREADS = N-1` оставляет room для main | `N = все logical` → SMT fight (Phase 17 P2) |

Phase 17 A/B на `taskset -c 0,6,1,7` показал: **`BG_NUM_RASTER_THREADS = (pinned logical) - 1`** лучше, чем Chromium default (=2) и не хуже, чем `N` (все). Интерпретация: main/compositor нужен «свободный» logical slot; полный N конкурирует с SMT sibling.

### 1.5 Что `taskset -c 0-1` делает неправильно

Старый (до исправления в `run-engines.sh`) подход с range `0-1` закреплял **только** logical 0 и 1 — то есть **два physical cores, но без SMT siblings 6 и 7**. CEF multi-thread path голодал: наблюдались ~20–25 fps вместо ~50. Правильная маска канала 1: `0,6,1,7`.

### 1.6 Как увидеть CCX на Linux без vendor tools

Linux не всегда экспортирует «CCX id» явно. Практические эвристики:

1. **`lscpu -C` / cache topology** — shared L3 CPU lists.
2. **`/sys/devices/system/cpu/cpuN/cache/index3/shared_cpu_list`** — кто делит L3.
3. Для Zen2 6-core: эвристика «первые 3 phys cores = CCX0, следующие 3 = CCX1» обычно верна, но **скрипт должен читать shared_cpu_list**, не hardcode.

Пример:

```bash
for c in /sys/devices/system/cpu/cpu{0..11}/cache/index3/shared_cpu_list; do
  echo "$c: $(cat $c 2>/dev/null)"
done | sort -u
```

Ожидаемо две группы L3 (по 6 logical CPU каждая на 3600).

### 1.7 Масштабирование мышления: 16 / 32 cores

| CPU | Cores / Threads | Типичная L3/CCX картина | 3ch @2c | Запас |
|---|---|---|---|---|
| Ryzen 5 3600 | 6 / 12 | 2×CCX×3 | 6c занято | 0 для OS isolate |
| Ryzen 9 5950X | 16 / 32 | 2×CCD, много CCX | 6c | огромный |
| EPYC / server | 32+ / 64+ | NUMA + CCD | 6c | isolate + IRQ house |
| Dual-socket | 2×N | **NUMA** | pin + numactl | обязательно |

На больших машинах проблема смещается с «влезет ли 3ch» на «как изолировать render от OS/IRQ/NVMe». На 3600 — наоборот: **каждый core на счету**.

### 1.8 Анти-паттерны topology (чеклист)

- [ ] Pin channel across CCX «для fairness» без измерения
- [ ] Считать `nproc` = physical cores
- [ ] `taskset -c 0-3` без SMT siblings
- [ ] Класть DeckLink IRQ на те же cores, что raster
- [ ] Думать, что NUMA=1 ⇒ topology irrelevant
- [ ] Hardcode `0,6,1,7` в production scripts для всех машин

---

## 2. Текущий Titulus pinning: run-engines.sh / run-channel.sh

### 2.1 Process model (напоминание)

```
frontend :3011  ↔  backend :3002
        ↕ /ws/renderer
   bg_engine × N   (1 process = 1 channel)
        ↓
   null | pipe | preview | decklink | stream
```

Supervisor chain:

```
run-engines.sh  →  run-channel.sh × N  →  taskset … bg_engine …
```

### 2.2 Discovery physical cores (`run-engines.sh`)

Скрипт **не** парсит human `lscpu` text (ломался на non-English locale). Использует:

```bash
LC_ALL=C lscpu -p=CPU,CORE
```

Строит `core_map[i]` = comma-list всех logical CPU physical core `i`. На 3600:

```
core_map[0]=0,6
core_map[1]=1,7
...
core_map[5]=5,11
```

Параметры:

| Параметр | Значение |
|---|---|
| `cores_per_channel` | 2 (physical) |
| SMT | включаются автоматически через `core_map` |
| Overflow | если `phys < COUNT*2` → лишние каналы **unpinned** + WARNING |

### 2.3 Фактическая раскладка 3 каналов на 3600 (default sequential)

| Channel index | Physical cores | Logical mask (`taskset -c`) | CCX comment |
|---|---|---|---|
| 0 | 0, 1 | `0,6,1,7` | целиком CCX0 |
| 1 | 2, 3 | `2,8,3,9` | **straddle** CCX0↔CCX1 |
| 2 | 4, 5 | `4,10,5,11` | целиком CCX1 |

Phase 11 зафиксировал: CCX reshuffle исследовали, **не меняли** — channel 2 (straddle) был лучшим performer в том soak. Это не отменяет теорию L3; это значит, что **content/decode load** доминировал над Fabric penalty на том rundown. Документ ниже предлагает packing options A/B/C именно потому, что «случайный sequential» — baseline, не обязательно optimum.

### 2.4 `BG_NUM_RASTER_THREADS = N-1` (`run-channel.sh`)

Логика Phase 17 P3:

```bash
n_cores="$(count_cores "$CORES")"   # логические в mask
if [[ "$n_cores" -ge 2 && "$n_cores" -le 8 ]]; then
  export BG_NUM_RASTER_THREADS=$((n_cores - 1))
fi
```

Для маски `0,6,1,7` → `N=4` → `BG_NUM_RASTER_THREADS=3`.

Прокидывается в CEF через `engine_app.cpp` → `--num-raster-threads`.

| Режим | Raster threads | Заметка |
|---|---|---|
| Pinned 4 logical | 3 | production channel default |
| Pinned 2 logical | 1 | слишком узко; не рекомендуется |
| Unpinned / wide | Chromium heuristic | editor preview |

### 2.5 Что pinning **не** покрывает

| Компонент | Affinity сегодня |
|---|---|
| `bg_engine` | taskset от run-channel |
| backend / frontend | `nice -n 10` в `dev-start.sh`, **без** cpuset |
| DeckLink kernel IRQ | default IRQ balance / irqbalance |
| NIC IRQ | default |
| CEF zygote / utility | наследует mask процесса (важно!) |
| ffmpeg (stream consumer) | отдельный child — проверить отдельно |

### 2.6 Soft realtime: `MaybeSetRealtimePumpPriority`

В `main.cpp` (только decklink-driven):

```
pthread_setschedparam(..., SCHED_FIFO, priority=2)
```

На dev-хосте часто soft-fail: `RLIMIT_RTPRIO=0` / нет `CAP_SYS_NICE` → лог и продолжение на CFS. См. §5.

### 2.7 Операционные pitfalls (из architecture rules)

1. Не запускать backend из subshell `( )` — сброс CWD.
2. Kill по PID слушателя порта (`ss -ltnp`), не `pkill -f PORT=`.
3. Перед DeckLink экспериментами: `pgrep -af "bg_engine|run-channel|run-engines"`.
4. Остановка live: убить supervisor (`run-engines` + `run-channel`), не только `bg_engine`.
5. `renice` без sudo необратим в обратную сторону для чужих процессов — проверять cmdline.

### 2.8 Связь pinning ↔ telemetry

При разборе soak смотреть **вместе**:

- mask канала (`taskset -cp $(pgrep -n bg_engine)`),
- `BG_NUM_RASTER_THREADS` в окружении,
- `in_fps` / `pairs:singles` / `d_late`,
- `ref=` в DeckLink telemetry,
- CPU% per logical (`mpstat -P ALL`).

Без mask telemetry «канал тормозит» — гадание.

---

## 3. Ideal packing для 3×1080i50 на 6C/12T

На 3600 **нет свободных cores** при 3ch × 2c. Любая isolation OS конкурирует с «полным» packing. Ниже три опции.

### 3.1 Option A — Sequential phys cores (текущий default)

```
Ch0: phys 0,1 → CPU 0,6,1,7     (CCX0)
Ch1: phys 2,3 → CPU 2,8,3,9     (straddle)
Ch2: phys 4,5 → CPU 4,10,5,11   (CCX1)
OS / IRQ / backend:  CFS на всех (с конкуренцией)
```

**Плюсы**

- Уже реализовано в `run-engines.sh`.
- Простая математика; масштабируется на большее число cores без CCX-aware logic.
- Phase 11 soak: Ch2/Ch3 ~49–50 in_fps при genlock.

**Минусы**

- Один канал всегда straddle CCX.
- OS noise бьёт по тем же cores, что render.
- Нет house-keeping core для irqbalance / journald / agents.

**Когда выбирать:** dev/home стенд; пока measurement не доказал выгоду isolation.

### 3.2 Option B — CCX-aligned packing + shared OS

```
CCX0: Ch0 на phys 0,1 (CPU 0,6,1,7); phys 2 (CPU 2,8) = shared OS/light
CCX1: Ch1 на phys 3,4 (CPU 3,9,4,10); phys 5 (CPU 5,11) = Ch2? WAIT — не хватает
```

На 6 cores CCX-aligned **строго** для 3×2c невозможно без straddle или без урезания одного канала до 1c.

Реалистичный CCX-aware вариант B1 (2 full + 1 straddle, но straddle выбран явно):

```
Ch0: phys 0,1 (CCX0)           — best L3
Ch1: phys 3,4 (CCX1)           — best L3
Ch2: phys 2,5 (straddle)       — явный «жертвенный» канал / lighter content
OS:  CFS everywhere
```

Или B2 (пожертвовать SMT/cores у OS, не у channels) — см. Option C.

**Плюсы B1**

- Два канала с максимальным L3 reuse.
- Controllable: тяжёлый rundown → Ch0/Ch1; preview/light → Ch2.

**Минусы B1**

- Нужна CCX-aware раскладка в supervisor (сегодня нет).
- Несимметричный ops (люди забывают, какой канал «слабый»).

### 3.3 Option C — Isolate OS на phys 0–1, channels на 2–5

```
House (OS/IRQ/backend/frontend): phys 0,1 → CPU 0,6,1,7
Ch0: phys 2,3 → … (часто straddle)
Ch1: phys 4,5 → …
Ch2: ??? — НЕТ physical cores
```

Чистая изоляция **двух** house cores **ломает** 3×2c на 6c. Варианты компромисса:

| Вариант | House | Channels | Комментарий |
|---|---|---|---|
| C0 | 0 cores isolated | 3×2c full | Option A |
| C1 | 1 phys core house | 1×1c + 2×2c или 3×1.something | сложный |
| C2 | house **shares** Ch mask lightly | 3×2c | cgroup soft affinity |
| C3 | upgrade CPU | house + 3×2c | правильный ответ для production |

**Практический вердикт для 3600:** Option C «isolate 0–1» **несовместим** с 3×2c. На 3600 делайте **A или B1**. Isolation (isolcpus) имеет смысл начиная с **≥8 physical cores** (house 2 + 3×2).

### 3.4 Tradeoff matrix

| Критерий | A sequential | B1 CCX-aware | C isolate house |
|---|---|---|---|
| L3 reuse (avg) | medium | high for 2ch | N/A на 6c |
| Ops простота | high | medium | high на больших CPU |
| OS jitter | worse | worse | best (если cores хватает) |
| Реализуемо на 3600×3ch | yes | yes | **no** без урезания |
| Scale to 16c | ok | better | best |

### 3.5 Рекомендация по классам машин

```
6c  (3600):     Option A (default) или B1 после A/B measurement
8c:             house 2c + 3×2c  (Option C становится возможным)
12c–16c:        house 2–4c + isolcpus/nohz на render set
32c+:           house NUMA0 small set; render per-CCD; IRQ NUMA-local
```

### 3.6 Как провести A/B packing на стенде

1. Зафиксировать rundown (одинаковый content на всех каналах).
2. Genlock locked; low-latency on; preroll=3.
3. Прогон A (sequential) 30 min → собрать `in_fps`, `d_late`, `pairs:singles`, paint p95.
4. Прогон B1 (CCX-aware) 30 min — тот же content.
5. Сравнивать **не** average fps alone, а p99 latency / late count / singles ratio.
6. Если разница < measurement noise — оставить A (проще).

### 3.7 Не увеличивать cores/channel «на удачу»

Идея «дать каналу 3 phys cores» на 3600 убивает третий канал. На больших CPU 3c/ch может помочь тяжёлому HTML; это отдельный gate (Phase 19 cost model), не default.

---

## 4. isolcpus, nohz_full, rcu_nocbs, cgroups cpuset (Ubuntu)

> **Предупреждение:** на Ryzen 5 3600 с 3×2c full pin эти тюнинги **в основном для будущего** (8c+). На 6c применение `isolcpus` к render set без house cores сломает OS или каналы. Ниже — полный runbook с rollback.

### 4.1 Цели kernel cmdline тюнинга

| Параметр | Эффект |
|---|---|
| `isolcpus=` | Scheduler не размещает обычные задачи на CPU (кроме явно affinity) |
| `nohz_full=` | Уменьшает timer ticks на idle/isolated CPUs (adaptive-tick) |
| `rcu_nocbs=` | RCU callbacks offloaded с указанных CPU |
| `irqaffinity=` | Default IRQ affinity mask (до per-IRQ override) |

Типичный production шаблон (пример для **16 logical render CPUs** на большой машине):

```
isolcpus=managed_irq,domain,2-15
nohz_full=2-15
rcu_nocbs=2-15
irqaffinity=0-1
```

House = CPU 0–1; render = 2–15.

### 4.2 Step-by-step: Ubuntu GRUB

**4.2.1 Backup**

```bash
sudo cp /etc/default/grub /etc/default/grub.bak.$(date +%Y%m%d)
cat /proc/cmdline | tee ~/cmdline.before
```

**4.2.2 Edit**

```bash
sudo nano /etc/default/grub
# найти GRUB_CMDLINE_LINUX_DEFAULT и добавить параметры внутрь кавычек
```

Пример для **8-core / 16-thread** машины (не 3600!):

```
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash isolcpus=managed_irq,domain,4-15 nohz_full=4-15 rcu_nocbs=4-15 irqaffinity=0-3"
```

**4.2.3 Apply**

```bash
sudo update-grub
sudo reboot
```

**4.2.4 Verify**

```bash
cat /proc/cmdline
cat /sys/devices/system/cpu/isolated
# для nohz:
cat /sys/devices/system/cpu/nohz_full
```

### 4.3 Rollback GRUB

```bash
sudo cp /etc/default/grub.bak.YYYYMMDD /etc/default/grub
sudo update-grub
sudo reboot
# verify: cat /proc/cmdline  == cmdline.before
```

Если система не грузится: recovery / old kernel в GRUB menu → edit cmdline → boot → rollback файла.

### 4.4 cgroups v2 cpuset (без reboot) — предпочтительнее для экспериментов

На Ubuntu с systemd (cgroup v2):

```bash
# создать cgroup для engines
sudo mkdir -p /sys/fs/cgroup/titulus-engines
echo '+cpuset' | sudo tee /sys/fs/cgroup/cgroup.subtree_control

# пример: engines на CPU 4-15, house остальное
echo 4-15 | sudo tee /sys/fs/cgroup/titulus-engines/cpuset.cpus
echo 0 | sudo tee /sys/fs/cgroup/titulus-engines/cpuset.mems

# переместить уже запущенный bg_engine
echo $ENGINE_PID | sudo tee /sys/fs/cgroup/titulus-engines/cgroup.procs
```

Systemd unit способ (предпочтительнее) — см. Appendix A (`CPUAffinity=`).

**Плюсы cpuset vs isolcpus**

- Без reboot; легко rollback (`rmdir` / unit stop).
- Совместимо с desktop/dev машиной.
- Можно комбинировать с `taskset` внутри cgroup.

**Минусы**

- Не убирает timer ticks так агрессивно, как `nohz_full`.
- Нужен root / делегирование cgroup.

### 4.5 Взаимодействие с `taskset`

Порядок:

1. Kernel isolcpus / cgroup задаёт **allowed set**.
2. `taskset` сужает дальше до per-channel mask.
3. Если `taskset` указывает CPU вне cpuset → ошибка / silent truncate (проверять!).

Всегда верифицировать:

```bash
taskset -cp $(pgrep -n -f 'bg_engine.*Ch1')
cat /proc/$(pgrep -n -f 'bg_engine.*Ch1')/status | grep Cpus_allowed_list
```

### 4.6 Что **не** делать на 3600

```
# ПЛОХО на 6c/12t при 3 каналах:
isolcpus=0-11          # убьёте OS
isolcpus=2-11          # house 0-1, но channels некуда
nohz_full=0-11         # известные edge cases + мало смысла без isol
```

Минимально осмысленный эксперимент на 3600: **только** IRQ affinity + governor + THP (§6–8), **без** isolcpus.

### 4.7 `managed_irq` domain flags (современные ядра)

На новых Ubuntu `isolcpus=managed_irq,domain,...` влияет на то, как IRQ subsystem учитывает isolation. Читайте `Documentation/admin-guide/kernel-parameters.txt` вашей версии ядра перед copy-paste. После изменения — проверить `/proc/interrupts` распределение.

### 4.8 Checklist перед reboot

- [ ] Есть console / IPMI / физический доступ
- [ ] Backup grub + `cmdline.before`
- [ ] Записан rollback план
- [ ] Понятно, какие CPU house / render
- [ ] `run-engines` masks пересекаются только с render set
- [ ] irqbalance остановлен или научен не трогать render IRQs (§6)

---

## 5. SCHED_FIFO priority для bg_engine

### 5.1 Зачем

DeckLink-driven pump в `main.cpp` должен просыпаться на `ScheduledFrameCompleted` и успеть BeginFrame до следующего deadline. Под CFS соседний `npm`, IDE agent или `gzip` может дать multi-ms latency spike → late schedule → `d_late`.

CasparCG reference ставит channel thread в `SCHED_FIFO` priority 2. Titulus **reimplement by reference**: тот же класс приоритета, но **только** если `HasExternalClock()` (decklink). Browser/null path не трогаем.

### 5.2 Текущее поведение

```
MaybeSetRealtimePumpPriority():
  sched_priority = 2
  policy = SCHED_FIFO
  soft-fail on error (log + continue CFS)
```

На домашнем стенде часто:

```
bg_engine: SCHED_FIFO priority 2 unavailable (Operation not permitted)
```

Причина: нет capability / `ulimit -r` = 0.

### 5.3 Capabilities и limits

| Механизм | Как |
|---|---|
| Root | работает, нежелательно для сервиса |
| `setcap cap_sys_nice+ep bg_engine` | file capability |
| systemd `AmbientCapabilities=CAP_SYS_NICE` | предпочтительно |
| systemd `LimitRTPRIO=99` | разрешить RT priority ceiling |
| pam limits `/etc/security/limits.d/` | для login sessions |

Минимальный systemd фрагмент:

```ini
[Service]
AmbientCapabilities=CAP_SYS_NICE
CapabilityBoundingSet=CAP_SYS_NICE CAP_SYS_NICE
LimitRTPRIO=10
LimitMEMLOCK=infinity
CPUAffinity=4-15
```

После старта проверить:

```bash
chrt -p $(pgrep -n bg_engine)
# ожидаем: scheduling policy: SCHED_FIFO, priority: 2
```

### 5.4 Риски RT starvation

`SCHED_FIFO` **вытесняет** всех CFS-потоков на тех же CPU, пока RT-поток runnable.

| Риск | Митигация |
|---|---|
| Busy-loop bug в pump | Код должен блокироваться на condvar (`WaitForTick`); code review |
| Слишком высокий priority | Держать priority **2** (низкий RT), не 80 |
| RT на всех cores включая house | Только render cpuset |
| Priority inversion с futex | Избегать долгих locks в RT thread |
| Отладка зависла машина | Сохранить SysRq, SSH на house CPU, `chrt` fallback |

**Никогда** не ставить `SCHED_FIFO` на CEF UI thread «глобально» без gate — только pump, и только decklink.

### 5.5 Взаимодействие с nice backend/frontend

`dev-start.sh` поднимает control plane с `nice -n 10`. Это правильно: при конкуренции за house cores engines важнее UI. На production control plane лучше **cpuset house**, а не надеяться только на nice.

### 5.6 Verification matrix

| Проверка | Команда / сигнал | Pass |
|---|---|---|
| Policy | `chrt -p PID` | SCHED_FIFO prio 2 |
| Soft-fail log absent | engine log | нет «unavailable» |
| Browser path unchanged | null consumer bench | fps regression <1% |
| Starvation canary | `stress-ng` на house only | render fps stable |
| Starvation negative test | `stress-ng` **на render CPU** | ожидаем деградацию — подтверждает pin |

### 5.7 Rollback RT

```bash
# временно опустить процесс на CFS
sudo chrt -o -p 0 $PID
# или убрать AmbientCapabilities из unit и daemon-reload
```

File capability rollback:

```bash
sudo setcap -r /path/to/bg_engine
```

---

## 6. IRQ affinity: DeckLink и NIC в сторону от render cores

### 6.1 Почему это важно

Даже идеальный `taskset` бесполезен, если **hardirq / softirq** DeckLink или NIC выполняются на тех же logical CPU, что raster. Симптомы:

- случайные `d_late` без роста stage times;
- спайки в `/proc/interrupts` на render CPU;
- `perf sched` показывает irq-heavy wakeups.

### 6.2 Найти IRQ DeckLink

```bash
grep -iE 'decklink|blackmagic|DesktopVideo' /proc/interrupts
ls -l /sys/bus/pci/devices/*/irq
# Blackmagic PCI device:
lspci | grep -i blackmagic
```

Запомнить номера IRQ (например `65`, `66`).

### 6.3 Найти NIC IRQ (backend traffic / NFS / etc.)

```bash
grep -iE 'enp|eth|mlx|igb|ixgbe|virtio' /proc/interrupts
```

На домашнем стенде backend localhost → NIC менее критичен; на server с remote control plane — критичен.

### 6.4 Выставить smp_affinity

House CPUs пример `0-1` → mask hex зависит от bit layout.

```bash
# CPU 0-1 only → bitmask 0x3
echo 3 | sudo tee /proc/irq/65/smp_affinity
echo 3 | sudo tee /proc/irq/66/smp_affinity
cat /proc/irq/65/smp_affinity_list
```

Для list-формы (удобнее):

```bash
echo 0-1 | sudo tee /proc/irq/65/smp_affinity_list
```

### 6.5 irqbalance

```bash
systemctl status irqbalance
# на broadcast host часто:
sudo systemctl stop irqbalance
sudo systemctl disable irqbalance
```

Либо `IRQBALANCE_BANNED_CPUS` / `--banirq` чтобы не перетягивал DeckLink IRQ обратно на render.

### 6.6 Persistence: udev + oneshot systemd

См. Appendix A — `titulus-irq-affinity.service`, который после boot:

1. Ждёт появления DeckLink IRQ.
2. Пишет `smp_affinity_list` на house CPUs.
3. Логирует результат.

### 6.7 Проверка

```bash
# до нагрузки
grep -E 'CPU0|CPU1|CPU2' /proc/interrupts | head
# после 10 min soak: deltas по render CPUs для DeckLink IRQ должны быть ~0
```

Скрипт delta — Appendix C.

### 6.8 NUMA note для больших машин

На dual-socket: IRQ NIC и DeckLink должны быть **local** к тому NUMA node, где крутится consumer, иначе remote DMA + remote IRQ = двойной штраф. На 3600 (1 node) достаточно house vs render split.

---

## 7. Governor, C-states, turbo; turbostat

### 7.1 Зачем

Latency-sensitive path ненавидит:

- переход `powersave` → clock ramp delay,
- глубокие C-states (C6) → wake latency,
- непредсказуемый turbo thermal throttling mid-soak.

Для 3×1080i50 на 3600 целевой профиль: **performance governor**, ограниченные idle states, мониторинг thermal.

### 7.2 Governor

```bash
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
```

Persist (Ubuntu `cpufrequtils` / `tuned` / systemd oneshot) — Appendix A.

Проверка:

```bash
grep . /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor | sort | uniq -c
```

### 7.3 C-states

```bash
# посмотреть доступные
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/name
# отключить глубокие (пример: state3+)
for s in /sys/devices/system/cpu/cpu*/cpuidle/state[3-9]/disable; do
  echo 1 | sudo tee "$s"
done
```

Альтернатива kernel cmdline: `processor.max_cstate=1` / `idle=poll` (последнее — extreme, жрёт ватты; только lab).

### 7.4 Turbo / Boost

AMD: `cpb` / boost в sysfs:

```bash
cat /sys/devices/system/cpu/cpufreq/boost
# 1 = on, 0 = off
```

Стратегии:

| Режим | Когда |
|---|---|
| Boost ON | короткий bench, headroom |
| Boost OFF | long soak — меньше thermal wobble |
| Manual max freq | rare; если нужен flat clock |

### 7.5 Measurement: turbostat

```bash
sudo apt-get install -y linux-tools-common linux-tools-$(uname -r)
sudo turbostat --interval 1 --show Core,CPU,Avg_MHz,Busy%,Bzy_MHz,TSC_MHz,PkgWatt,CoreTmp
```

Что смотреть во время 3ch soak:

- **Busy%** на pinned CPUs ~ высокий и ровный;
- **Bzy_MHz** не проваливается волнами;
- **CoreTmp** не упирается в throttle;
- house CPUs не idle-100% если isolcpus забыли (или наоборот).

Сохранить 5–10 минут лога рядом с engine telemetry для корреляции latency spikes.

### 7.6 `cpupower` frequency-info

```bash
sudo cpupower frequency-info
sudo cpupower idle-info
```

### 7.7 Rollback power policy

```bash
echo schedutil | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
# re-enable cpuidle states: write 0 to disable files
sudo systemctl start irqbalance   # если останавливали только для теста
```

---

## 8. Transparent Huge Pages / khugepaged ↔ microfreeze

### 8.1 Связь с scheduling документом

THP не «про pinning», но даёт **latency spikes**, которые выглядят как scheduling/OS problem: внезапный `d_late`, краткий freeze UI, падение `in_fps` на секунды без роста stage times.

Полный разбор — **`06-microfreeze-thp-khugepaged.md`** (серия performance investigation). Здесь — operational minimum.

### 8.2 Быстрый статус

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled
cat /sys/kernel/mm/transparent_hugepage/defrag
cat /sys/kernel/mm/transparent_hugepage/khugepaged/defrag
```

### 8.3 Типичный broadcast-safe профиль (lab)

```bash
echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
echo defer | sudo tee /sys/kernel/mm/transparent_hugepage/defrag
# или never — если 06 подтвердит корреляцию
```

### 8.4 Как отличить THP spike от bad pin

| Признак | Bad pin / IRQ | THP / compaction |
|---|---|---|
| Постоянный low fps | чаще | реже |
| Редкие multi-10ms stalls | возможно IRQ | классика khugepaged |
| `perf` показывает `compaction` / `khugepaged` | нет | да |
| Сдвиг IRQ affinity лечит | да | нет |
| `echo never > thp/enabled` лечит | нет | да |

### 8.5 Правило расследования

1. Сначала измерить pin + IRQ + ref lock (§12).
2. Если остались редкие spikes — идти в doc 06 (THP).
3. Не включать одновременно isolcpus+THP+RT без факторного эксперимента.

---

## 9. DeckLink: preroll, low-latency, master clock, reference

### 9.1 Роль DeckLink в Titulus clock model

Для `consumer=decklink`:

```
ScheduledFrameCompleted  →  tick_cv  →  WaitForTick()  →  pump BeginFrame/OnPaint
```

SDI (карта + genlock) — **master clock**. Self-timer browser path **не используется**.

Это reimplement by reference идеи CasparCG `has_synchronization_clock`, но механизм другой: CasparCG pull/backpressure queue; Titulus push CEF + blocking wait. См. `docs/CASPARRCG_PORTING.md` §3.

### 9.2 Low-latency flag

В `decklink_consumer.cpp`:

```
IDeckLinkConfiguration::SetFlag(bmdDeckLinkConfigLowLatencyVideoOutput, true)
```

Эффект: меньше internal buffering на карте → ниже end-to-end latency, жёстче требования к вовремя приходящим scheduled frames.

Телеметрия старта: `low_latency=yes|no`.

### 9.3 Preroll depth formula

Reimplement by reference CasparCG `buffer_depth()`:

```
preroll_frames = 3
             + (low_latency_applied ? 0 : 1)
             + (embedded_audio ? 1 : 0)   // в Titulus сейчас всегда 0
```

Итого на production path с успешным low-latency: **preroll = 3**.

Смысл:

| Компонент | Зачем |
|---|---|
| base 3 | минимальная очередь scheduled frames для стабильного playback |
| +1 if not LL | карта сама буферизует больше — нужно догнать depth |
| +1 audio | если embedded audio path (будущее) |

Слишком маленький preroll → underrun / glitch. Слишком большой → latency.

### 9.4 `WaitForReferenceLock`

После scheduling preroll black frames, перед `StartScheduledPlayback`:

```
poll GetReferenceStatus up to 20 × 100ms
success: bmdReferenceLocked → log "reference signal locked" + 100ms settle
timeout: log + continue (dev hosts without genlock)
```

**Production 3×1080i50:** timeout без lock — **не accept** для gate (см. §13). Dev без платы — OK soft-continue.

Не используем `GetHardwareReferenceClock` как pacing source (осознанная развилка Phase 3/11): карта сама тактирует playback по reference; нам достаточно status polling + callback pacing.

### 9.5 Telemetry: `ref=locked`

В runtime telemetry (stages / periodic logs) ожидается индикатор reference. Ops checklist:

```bash
grep -E 'reference signal|ref=' logs/engine-*.log | tail
```

Pass: все decklink каналы `locked` до начала soak.

### 9.6 `d_late` и buffer relationship

`d_late` (late scheduled frames) растёт когда:

- render не успел к deadline (CPU/pin/THP),
- preroll слишком агрессивен относительно LL flag,
- genlock пропал mid-soak (ref unlock),
- profile switch / device busy.

Разбор: сначала `ref`, потом CPU, потом preroll experiments (менять только в lab).

### 9.7 Display mode и interlace

Default Titulus DeckLink mode: `HD1080i50`.

```
interlaced=yes → weave path (UFF consumer-side)
field period ~20ms; WaitForTick может отдать batch sub-ticks
```

Не путать **in_fps** (input/paint side) с **output field rate**. Phase 18 документировал потолок unique fps на тяжёлом content — scheduling doc не отменяет content cost model.

### 9.8 Keyer / profile notes (кратко)

- Keyer: `IDeckLinkKeyer`, не 2dfd profile API.
- Multi-channel на Quad 2: проверить profile (`1dfd` и т.д.) — Phase 11 опроверг «карта держит только 2».
- Profile switch → `run-channel` exit 42 → restart 6s.

### 9.9 Что не делать

- Не включать audio term в preroll «на будущее» без audio path.
- Не поднимать preroll до 8 «для стабильности» без измерения latency.
- Не драйвить pump от `GetHardwareReferenceClock` без нового design doc.
- Не применять SCHED_FIFO + LL + preroll=3 изменения **одним** коммитом без факторных прогонов.

---

## 10. Genlock: LES DG-14B → Reference In; sync groups

### 10.1 Зачем genlock

Без общего reference три SDI выхода «плывут» друг относительно друга и относительно студийной шины. Для broadcast graphics fill+key:

- frame-accurate switching,
- стабильный keyer edge,
- предсказуемый callback timing.

### 10.2 Типовая схема стенда Titulus

```
LES DG-14B (generator)
    │ Reference Out (blackburst / tri-level — по конфигурации DG-14B)
    ▼
DeckLink Quad 2  Reference In
    │
    ├─ SDI Out port A → Ch0 fill/key …
    ├─ SDI Out port B → Ch1 …
    └─ SDI Out port C → Ch2 …
```

Уточняйте кабели/разъёмы по мануалу Quad 2 и DG-14B; этот документ фиксирует **логический** поток.

### 10.3 Multi-port sync groups

На multi-port картах порты могут группироваться sync group’ами (зависит от профиля устройства). Ops implications:

| Тема | Практика |
|---|---|
| Один reference in | Все outputs в group должны lock к одному ref |
| Profile change | Может временно unlock; supervisor restart 42 |
| Разные display modes | Не смешивать 1080i50 и 1080p50 в одной sync group без проверки |
| Dual card | Отдельный ref cable / daisy-chain generator outputs |

### 10.4 Проверка lock до эфира

1. Физически: DG-14B powered, mode совместим с HD tri-level / нужным стандартом.
2. Desktop Video / Blackmagic firmware актуален.
3. Старт engines → логи `reference signal locked`.
4. Telemetry `ref=locked` на всех каналах.
5. Внешний monitor/waveform: нет горизонтального drift между выходами.

### 10.5 Failure modes

| Симптом | Вероятная причина |
|---|---|
| `reference signal lock timeout` | нет кабеля / неверный уровень / generator off |
| lock есть, но drift между картами | две карты без общего ref |
| периодический unlock | плохой кабель / ground loop / generator glitch |
| lock OK, но d_late | не genlock; CPU/scheduling |

### 10.6 Genlock ≠ замена pinning

Даже идеальный lock не спасёт, если CEF не успевает. Genlock стабилизирует **timeline**; pinning стабилизирует **compute**. Нужны оба.

---

## 11. Auto-detect CPU topology script (scale to 16/32-core)

### 11.1 Требования к дизайну

Скрипт / библиотека (bash+python) должен:

1. Парсить `lscpu -p` locale-independent.
2. Строить map: physical core → SMT logicals.
3. Опционально группировать cores по L3 `shared_cpu_list` (CCX/CCD proxy).
4. Принимать policy: `channels`, `cores_per_channel`, `house_cores`, `pack=sequential|ccx`.
5. Эмитить: per-channel `taskset` masks + recommended `BG_NUM_RASTER_THREADS`.
6. **Не** hardcode 3600.
7. Dry-run mode для `run-engines.sh` integration.

### 11.2 Алгоритм (пошагово)

```
INPUT: N_channels, K_cores_per_ch, house_h, pack_mode
READ logical topology (cpu, core, socket, node)
READ L3 shared_cpu_list → ccx_id per core
BUILD list of physical cores sorted by (node, ccx, core_id)
RESERVE first h physical cores as house (optional)
REMAINING = rest
IF pack_mode == sequential:
  assign chunks of K cores in order
ELSE pack_mode == ccx:
  for each channel:
    try take K cores from same ccx with most free cores
    else allow straddle (mark channel.quality=degraded)
EMIT json + shell exports
WARN if remaining < N*K
```

### 11.3 Пример вывода JSON

```json
{
  "host": "ryzen-5-3600",
  "phys_cores": 6,
  "logical_cpus": 12,
  "house": [],
  "pack": "sequential",
  "channels": [
    {"index": 0, "phys": [0,1], "cpus": "0,6,1,7", "ccx": [0,0], "raster_threads": 3},
    {"index": 1, "phys": [2,3], "cpus": "2,8,3,9", "ccx": [0,1], "raster_threads": 3, "quality": "straddle"},
    {"index": 2, "phys": [4,5], "cpus": "4,10,5,11", "ccx": [1,1], "raster_threads": 3}
  ]
}
```

### 11.4 Интеграция с run-engines

Сегодня discovery уже есть внутри `run-engines.sh`. Эволюция:

1. Вынести в `engine/tools/detect-cpu-pack.py`.
2. `run-engines.sh` вызывает tool, читает JSON.
3. Env overrides: `TITULUS_PACK=ccx`, `TITULUS_HOUSE_CORES=2`, `TITULUS_CORES_PER_CH=2`.
4. Bench scripts используют тот же tool — одна правда.

### 11.5 Pseudo-code ядра (Python)

См. Appendix B — полный скелет скрипта. Ключевые функции:

- `read_lscpu_p()`
- `read_l3_groups()`
- `pack_sequential()`
- `pack_ccx()`
- `emit_run_channel_args()`

### 11.6 Тест-матрица скрипта

| Фикстура topology | Ожидание |
|---|---|
| 3600 6c/12t, 3ch, house0 | 3 masks × 4 logical |
| 3600 3ch house2 | WARNING capacity |
| 16c/32t, 3ch house2 | house 0-1; channels на 2+; no straddle if CCX allows |
| 2 socket NUMA | не пересекать node без флага `--allow-cross-numa` |
| SMT disabled | masks без siblings; raster_threads = phys*K - 1 |

### 11.7 Почему не «просто numactl»

`numactl --physcpubind` полезен на NUMA, но:

- не знает channel packing,
- не выставляет `BG_NUM_RASTER_THREADS`,
- плохо стыкуется с уже принятым `taskset` в run-channel.

Оставить `taskset` как execution primitive; topology tool — как planner.

---

## 12. Measurement: interrupts, perf sched, spikes, in_fps, d_late

### 12.1 Минимальный набор метрик

| Метрика | Источник | Pass hint (3×1080i50) |
|---|---|---|
| `in_fps` | engine telemetry | ~50 (content-bound может ниже — помечать) |
| `pairs:singles` | telemetry | высокий ratio pairs |
| `d_late` / late | telemetry | ~0 на soak |
| `dropped` / `flushed` | telemetry | 0 |
| `ref` | telemetry / log | locked |
| stage `copy+weave+schedule` | stages5s | ≪ 40 ms |
| IRQ deltas | `/proc/interrupts` | DeckLink на house |
| sched latency | `perf sched` | нет multi-10ms outliers на pump |
| CPU freq | turbostat | flat |

### 12.2 `/proc/interrupts` delta

```bash
cp /proc/interrupts /tmp/irq.before
sleep 60
cp /proc/interrupts /tmp/irq.after
# python diff per-CPU for DeckLink IRQs — Appendix C
```

### 12.3 `perf sched`

```bash
sudo perf sched record -p $ENGINE_PID -- sleep 30
sudo perf sched latency
sudo perf sched map
```

Искать:

- долгие `schdelay`,
- миграции с house на чужие CPU (не должны при pin),
- RT throttling (`sched:sched_rt_runtime_exceeded` в `perf script`).

### 12.4 Latency spikes correlation

Параллельно писать:

1. engine `--frame-log` / stages,
2. `turbostat` interval 1s,
3. `mpstat -P ALL 1`,
4. IRQ sampling 5s,
5. optional: `bpftrace`/`offcputime` если доступно.

Склеивать по timestamp. Spike + `khugepaged` → doc 06. Spike + IRQ → §6. Spike + freq drop → §7.

### 12.5 `in_fps` stability

Не смотреть только average. Считать:

- min / p05 / p50 / p95 windowed fps,
- max gap between paints,
- singles bursts.

Content-bound канал (Phase 11 Ch1 ~29 fps из-за video decode) **нельзя** чинить pinning’ом — помечать в отчёте отдельно.

### 12.6 Browser/null regression gate

После любого OS/RT эксперимента:

```bash
./bench/run-bench.sh 3 30 5
```

DeckLink-only «улучшение», сломавшее null path — reject.

### 12.7 Checklist pre-measurement

- [ ] Нет лишних `bg_engine` (`pgrep -af`)
- [ ] Genlock locked
- [ ] Governor performance
- [ ] Masks известны
- [ ] Content зафиксирован
- [ ] Логи per-channel (`ENGINE_LOG_DIR`)
- [ ] Время NTP sync (для корреляции)

---

## 13. Gates и soak protocols

### 13.1 Gate G0 — Topology sanity (5 min)

| Check | Pass |
|---|---|
| `detect-cpu-pack` dry-run | masks disjoint |
| `taskset -cp` matches plan | yes |
| `BG_NUM_RASTER_THREADS` | N-1 |
| SMT siblings included | yes |

### 13.2 Gate G1 — Reference lock (1 min)

| Check | Pass |
|---|---|
| All ch `reference signal locked` | yes |
| Telemetry `ref=locked` | yes |
| No lock timeout in prod profile | yes |

### 13.3 Gate G2 — 30 min functional soak

| Metric | Pass |
|---|---|
| crash | 0 |
| dropped/flushed | 0 |
| d_late | 0 или explainable rare |
| in_fps non-content-bound ch | ≥ 49 |
| browser bench regression | none |

Ориентир: Phase 11.7 (28.6 min) — близкий прецедент.

### 13.4 Gate G3 — OS noise proof (optional)

На машинах с house isolation:

1. `stress-ng` на house CPUs 15 min.
2. Render metrics не деградируют.
3. Negative: stress на render CPUs → деградация (контроль, что pin работает).

### 13.5 Gate G4 — Formal 8h soak (Phase 6.4)

| Metric | Pass |
|---|---|
| duration | ≥ 8h |
| crashes | 0 |
| genlock unlock events | 0 (или documented blips) |
| late/drop budget | < 0.1% |
| thermal throttle | none continuous |

### 13.6 Gate G5 — Scale-up dry (без DeckLink)

На 16/32c CI/lab без карты:

- packing script fixtures,
- cgroup unit loads,
- null consumer multi-ch bench с новыми masks.

### 13.7 Abort criteria mid-soak

Остановить и разбирать, если:

- `ref` unlock > N seconds,
- engine restart loop,
- thermal critical,
- d_late растёт монотонно,
- OS deadlock / SSH loss на RT misconfig.

### 13.8 Report template

```
Host:
Kernel cmdline:
Pack mode / masks:
Governor / THP / irqbalance:
low_latency / preroll:
Genlock:
Duration:
Per-channel table (in_fps, late, drop, ref):
IRQ note:
Verdict: PASS/FAIL
Next action:
```

---

## 14. Appendices

### Appendix A — Example systemd / udev

#### A.1 `titulus-bg-engine@.service` (эскиз)

```ini
[Unit]
Description=Titulus bg_engine channel %i
After=network.target titulus-backend.service
Wants=titulus-backend.service

[Service]
Type=simple
User=titulus
Group=titulus
AmbientCapabilities=CAP_SYS_NICE
LimitRTPRIO=10
# example affinity — REPLACE via drop-in from detect-cpu-pack
CPUAffinity=4 5 6 7
Environment=BG_NUM_RASTER_THREADS=3
Environment=BACKEND_URL=http://127.0.0.1:3002
ExecStart=/opt/titulus/engine/bg_engine --name=%i ...
Restart=on-failure
RestartSec=3
# exit 42 handling may need wrapper (run-channel.sh)

[Install]
WantedBy=multi-user.target
```

#### A.2 `titulus-irq-affinity.service`

```ini
[Unit]
Description=Pin DeckLink IRQs to house CPUs
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/opt/titulus/sbin/titulus-irq-affinity.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

#### A.3 `titulus-irq-affinity.sh` (эскиз)

```bash
#!/usr/bin/env bash
set -euo pipefail
HOUSE="${TITULUS_HOUSE_CPUS:-0-1}"
# Discover IRQ numbers that look like Blackmagic
mapfile -t IRQS < <(awk '/[Bb]lack|[Dd]eck[Ll]ink|DesktopVideo/ {print $1}' /proc/interrupts | tr -d :)
if [[ ${#IRQS[@]} -eq 0 ]]; then
  echo "no DeckLink IRQs found" >&2
  exit 0
fi
for irq in "${IRQS[@]}"; do
  echo "$HOUSE" > "/proc/irq/${irq}/smp_affinity_list"
  echo "irq $irq -> $(cat /proc/irq/${irq}/smp_affinity_list)"
done
```

#### A.4 udev rule (optional)

```
# /etc/udev/rules.d/99-titulus-decklink.rules
ACTION=="add", SUBSYSTEM=="pci", ATTR{vendor}=="0xbdbd", TAG+="systemd", ENV{SYSTEMD_WANTS}="titulus-irq-affinity.service"
```

Vendor id уточнять через `lspci -nn` на конкретной карте.

#### A.5 Governor oneshot

```ini
[Unit]
Description=Set CPU governor performance
[Service]
Type=oneshot
ExecStart=/bin/bash -c 'echo performance | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor'
[Install]
WantedBy=multi-user.target
```

### Appendix B — `detect-cpu-pack.py` skeleton

```python
#!/usr/bin/env python3
"""Titulus CPU pack planner — no hardcoding of Ryzen 3600."""
from __future__ import annotations
import argparse, json, subprocess, collections
from pathlib import Path

def read_lscpu_p():
    out = subprocess.check_output(["lscpu", "-p=CPU,CORE,SOCKET,NODE"], text=True)
    rows = []
    for line in out.splitlines():
        if not line or line.startswith("#"):
            continue
        cpu, core, socket, node = map(int, line.split(","))
        rows.append({"cpu": cpu, "core": core, "socket": socket, "node": node})
    return rows

def core_to_cpus(rows):
    m = collections.defaultdict(list)
    for r in rows:
        m[(r["node"], r["socket"], r["core"])].append(r["cpu"])
    for k in m:
        m[k] = sorted(m[k])
    return m

def read_l3_group(cpu: int) -> str:
    p = Path(f"/sys/devices/system/cpu/cpu{cpu}/cache/index3/shared_cpu_list")
    if not p.exists():
        return "unknown"
    return p.read_text().strip()

def pack_sequential(phys_keys, k, n, house):
    free = [x for x in phys_keys if x not in house]
    channels = []
    for i in range(n):
        chunk = free[i*k:(i+1)*k]
        channels.append(chunk)
    return channels

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--channels", type=int, required=True)
    ap.add_argument("--cores-per-channel", type=int, default=2)
    ap.add_argument("--house-cores", type=int, default=0)
    ap.add_argument("--pack", choices=["sequential", "ccx"], default="sequential")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    rows = read_lscpu_p()
    c2c = core_to_cpus(rows)
    phys_keys = sorted(c2c.keys())
    house = phys_keys[: args.house_cores]
    remain = phys_keys[args.house_cores :]
    need = args.channels * args.cores_per_channel
    warn = len(remain) < need
    assigned = pack_sequential(phys_keys, args.cores_per_channel, args.channels, set(house))
    out = {"house": [list(c2c[k]) for k in house], "channels": [], "warning_capacity": warn}
    for idx, keys in enumerate(assigned):
        cpus = []
        for k in keys:
            cpus.extend(c2c[k])
        cpus = sorted(cpus)
        nlog = len(cpus)
        out["channels"].append({
            "index": idx,
            "cpus": ",".join(map(str, cpus)),
            "raster_threads": max(1, nlog - 1) if 2 <= nlog <= 8 else None,
        })
    print(json.dumps(out, indent=2) if args.json else out)

if __name__ == "__main__":
    main()
```

Доработать: `pack=ccx` через `read_l3_group`, NUMA guard, integration tests на fixture tables.

### Appendix C — IRQ delta helper

```python
#!/usr/bin/env python3
import sys
from collections import defaultdict

def parse(path):
    cpus = None
    data = {}
    with open(path) as f:
        for line in f:
            parts = line.split()
            if parts[0] == "CPU0":
                # header alternative formats vary; keep simple
                continue
            if not parts[0].endswith(":"):
                continue
            irq = parts[0][:-1]
            # counts until first non-int
            counts = []
            for p in parts[1:]:
                if p.isdigit():
                    counts.append(int(p))
                else:
                    break
            name = parts[len(counts)+1:]
            data[irq] = (counts, " ".join(name))
    return data

b, a = parse(sys.argv[1]), parse(sys.argv[2])
for irq, (ca, name) in a.items():
    if "deck" not in name.lower() and "black" not in name.lower():
        continue
    cb = b.get(irq, ( [0]*len(ca), name))[0]
    deltas = [x-y for x,y in zip(ca, cb)]
    print(irq, name, deltas)
```

### Appendix D — Operator checklist (laminate)

**Before air**

- [ ] `pgrep -af bg_engine` clean start
- [ ] Pack masks disjoint
- [ ] Genlock cable / DG-14B OK
- [ ] `reference signal locked` × N
- [ ] Governor performance
- [ ] irqbalance policy known
- [ ] THP policy known (doc 06)
- [ ] low_latency=yes, preroll=3
- [ ] Logs per channel rotating/disk OK

**During soak**

- [ ] Watch `d_late`, `in_fps`, temps
- [ ] No unlock spam
- [ ] No unexpected renice/taskset drift

**After**

- [ ] Save logs + turbostat + irq deltas
- [ ] Fill report template §13.8
- [ ] Rollback experimental cmdline if any

### Appendix E — Quick command sheet

```bash
# topology
LC_ALL=C lscpu -p=CPU,CORE,SOCKET,NODE
cat /sys/devices/system/cpu/cpu0/cache/index3/shared_cpu_list

# engines
pgrep -af 'bg_engine|run-channel|run-engines'
taskset -cp $(pgrep -n bg_engine)
chrt -p $(pgrep -n bg_engine)

# genlock / start logs
grep -E 'reference signal|low_latency|preroll' logs/engine-*.log

# power
grep . /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor | uniq -c
sudo turbostat --interval 1

# irq
grep -iE 'black|deck' /proc/interrupts
systemctl status irqbalance

# bench regression
./bench/run-bench.sh 3 30 5
```

### Appendix F — Mapping to Titulus phases

| Phase | Что дал для этой темы |
|---|---|
| 3 | DeckLink scheduled playback, reference poll |
| 6 | HW стенд Quad 2 + DG-14B; 6.4 8h soak |
| 10 | Beacon / BeginFrame — без этого pinning бесполезен |
| 11 | WaitForTick, SCHED_FIFO soft, preroll, LL flag |
| 17 | BG_NUM_RASTER_THREADS = N-1 |
| 18 | true-50p ceiling — content/cost, не OS |
| 19 (next) | style guide + cost model кадра |

### Appendix G — Glossary

| Term | Meaning |
|---|---|
| CCX | Core Complex — группа cores с общим L3 (Zen) |
| SMT | Simultaneous Multithreading (2 logical / phys core) |
| isolcpus | Kernel param: isolate CPUs from CFS balancing |
| nohz_full | Adaptive-tick CPUs |
| rcu_nocbs | Offload RCU callbacks |
| cpuset | cgroup controller for CPU set |
| SCHED_FIFO | Real-time FIFO scheduling class |
| WaitForTick | Titulus consumer API: block until DeckLink tick |
| preroll | Black frames queued before StartScheduledPlayback |
| genlock | External reference sync |
| d_late | Late frame counter in DeckLink telemetry |
| house CPUs | CPUs reserved for OS/IRQ/control plane |

### Appendix H — Decision log (не переоткрывать без measurement)

1. DeckLink clock через `WaitForTick` / callback — не self-timer.
2. `GetReferenceStatus` polling — не `GetHardwareReferenceClock` pacing.
3. `SCHED_FIFO` только decklink-driven, priority 2, soft-fail OK.
4. Pin = 2 phys cores + SMT siblings / channel — baseline.
5. `BG_NUM_RASTER_THREADS = N-1` для channel-sized masks.
6. На 3600 не требовать isolcpus для 3ch acceptance.
7. CasparCG — reference only; no GPL copy into Titulus tree.

### Appendix I — Escalation path

```
Symptom → check ref lock → check masks/SMT → check IRQ → check governor
       → check THP (doc 06) → check content cost (Phase 18/19)
       → only then consider isolcpus / RT capabilities / packing B1
```

### Appendix J — Worked example: 3600 home rack

**Hardware:** Ryzen 5 3600, 32 GiB RAM, DeckLink Quad 2, LES DG-14B, Ubuntu LTS.

**Chosen pack:** Option A sequential (default `run-engines.sh`).

**OS extras enabled:** governor performance; irqbalance stopped during soak; THP `madvise`; **no** isolcpus.

**RT:** soft-fail acceptable on lab; production unit gets `CAP_SYS_NICE`.

**Expected:** Ch non-content-bound ≈ 49–50 in_fps; ref locked; d_late ≈ 0 on 30 min.

**Not expected:** miracle 3× heavy video decode @50 without cost model work.

### Appendix K — Worked example: 16-core server sketch

```
phys 0-1:   house (OS, IRQ, backend, ssh)
phys 2-3:   Ch0
phys 4-5:   Ch1
phys 6-7:   Ch2
phys 8-15:  spare / future ch / agents banned via cpuset
cmdline:    isolcpus=managed_irq,domain,2-7 nohz_full=2-7 rcu_nocbs=2-7 irqaffinity=0-1
```

Validate with G0–G4 before declaring production.

### Appendix L — File index (Titulus tree)

| Path | Role |
|---|---|
| `engine/run-engines.sh` | multi-ch supervisor + core_map |
| `engine/run-channel.sh` | taskset + BG_NUM_RASTER_THREADS |
| `engine/src/main.cpp` | decklink_driven + SCHED_FIFO |
| `engine/src/consumers/decklink_consumer.cpp` | LL, preroll, WaitForReferenceLock |
| `engine/src/engine_app.cpp` | raster threads env |
| `dev-start.sh` | nice control plane |
| `docs/CASPARRCG_PORTING.md` | compliance / forks |
| `docs/development-phases/phase-11-*.md` | soak precedent |

### Appendix M — Open questions (track)

1. Стоит ли внедрять `pack=ccx` в `run-engines` default на Zen?
2. Нужен ли audio term preroll до audio ship?
3. Formal `CAP_SYS_NICE` в packaging — когда?
4. Автоматический IRQ discover для всех BM devices?
5. Связка Phase 19 cost model ↔ cores_per_channel dynamic?

### Appendix N — Document history

| Date | Note |
|---|---|
| 2026-07-13 | Initial comprehensive investigation doc (scheduling / OS / genlock) |

---

## 15. Заключение

На Ryzen 5 3600 путь к стабильным 3×1080i50 — это не один «magic sysctl», а **сшивка**:

1. Правильные SMT-aware masks (уже в `run-engines.sh`),
2. Raster threads N-1 (Phase 17),
3. DeckLink master clock + preroll=3 + low-latency (Phase 11),
4. Genlock locked (DG-14B → Ref In),
5. Измеряемый OS noise (IRQ/governor/THP),
6. RT priority как opt-in с capabilities,
7. Topology planner, который переживёт апгрейд на 16/32 cores.

Isolation (`isolcpus`/`nohz_full`) — мощный инструмент **больших** машин; на 6c он конкурирует с channel packing и не является gate для текущего home acceptance. Любое изменение OS/RT проверяйте browser/null regression и factorable soaks; не смешивайте пять тюнингов в одном эксперименте.



---

## 16. Расширенный разбор: CFS vs RT на render CPU

### 16.1 Как CFS мешает field deadline

Completely Fair Scheduler делит CPU пропорционально nice/weight. На logical CPU, где одновременно:

- CEF raster thread,
- compositor,
- `bg_engine` pump,
- случайный `node`/IDE agent,

latency wake-to-run может прыгнуть с десятков микросекунд до единиц миллисекунд. Для 20 ms field это «ещё терпимо» по среднему, но **хвост распределения** (p99) убивает late frames.

RT `SCHED_FIFO` priority 2 ставит pump выше CFS, но **не** выше других RT с priority ≥2 и не защищает, если pump сам ждёт CEF на CFS-потоках внутри того же process. Поэтому pinning + raster threads важнее «голой» RT метки.

### 16.2 Модель потоков внутри bg_engine (упрощённо)

```
[main / pump thread]     — WaitForTick / BeginFrame orchestration; RT candidate
[CEF UI / Blink]         — HTML/CSS/layout; обычно CFS
[Compositor]             — layerize; CFS
[Raster × N-1]           — tile raster; CFS, pinned together
[DeckLink callback]      — ScheduledFrameCompleted; should be short; IRQ context → softirq/thread
```

Вывод: `SCHED_FIFO` на pump — necessary but not sufficient. Affinity всего process mask критична, потому что CEF threads наследуют affinity.

### 16.3 `RLIMIT_RTTIME` и runaway protection

На hardening hosts рассмотрите:

```
LimitRTTIME=...
```

чтобы runaway RT thread убили по CPU time в RT class. Для Titulus pump (blocking) обычно не нужно; для safety на multi-tenant — обсудить.

### 16.4 `chrt` smoke test без capabilities на binary

```bash
sudo chrt -f -p 2 $PID
# измерить 5–10 min
sudo chrt -o -p 0 $PID
```

Если sudo-chrt даёт метрики лучше soft-fail baseline — есть justification для packaging capabilities.

---

## 17. Расширенный разбор: SMT contention patterns

### 17.1 Паттерн «weave vs raster»

AVX2 weave (Phase 11) любит execution units. Если SMT sibling в этот момент rastersкaет Skia — оба замедляются. Mitigation уже в N-1: один logical оставлен под non-raster.

### 17.2 Паттерн «callback vs pump»

DeckLink completion callback должен быть коротким (signal condvar). Если callback affinity уехала на busy SMT sibling с тяжёлым raster — возможна задержка tick. Проверять `/proc/interrupts` + softirq CPU.

### 17.3 Отключение SMT (lab only)

```
nosmt
```

в cmdline — радикальный эксперимент. На 3600 получите 6 logical = 6 phys; 3×2c packing всё ещё заполняет машину, но без SMT helpers CEF может просесть. Не production default.

---

## 18. Расширенный разбор: memory locality и hugepages кратко

Frame buffers ~8 MiB выравниваются в pools (`aligned_buffer.h`). Page faults на росте pool в mid-soak дают spikes. Связь:

- pool warm-up на старте,
- THP merge во время warm-up vs mid-soak (doc 06),
- pinning не лечит page fault; только снижает cache miss.

Рекомендация: на soak стартовать каналы, прогреть take/clear несколько минут, **потом** начинать formal timing window.

---

## 19. Расширенный runbook: «машина тормозит в эфире»

### Шаг 1 — Safety

```bash
pgrep -af 'bg_engine|run-engines|run-channel'
# не убивать чужой эфир; подтвердить channel names
```

### Шаг 2 — Lock

```bash
grep -n 'reference' logs/engine-*.log | tail -20
```

### Шаг 3 — Affinity drift

```bash
for p in $(pgrep bg_engine); do echo PID=$p; taskset -cp $p; chrt -p $p; done
```

### Шаг 4 — CPU pressure

```bash
mpstat -P ALL 1 5
# кто ест house? кто ест render?
```

### Шаг 5 — IRQ

```bash
grep -iE 'black|deck|enp' /proc/interrupts
```

### Шаг 6 — Content

Сравнить с known-good rundown. Если только один канал плох — скорее content/decode, не OS.

### Шаг 7 — Escalate

Если 1–6 чисто — THP (06), затем cost model (Phase 19), затем hardware.

---

## 20. Таблицы масштабирования packing

### 20.1 cores_per_channel = 2

| Phys cores | House | Max channels @2c | Notes |
|---|---|---|---|
| 4 | 0 | 2 | 3600-class too small for 3 |
| 6 | 0 | 3 | home reference |
| 6 | 2 | 2 | house sacrifices a channel |
| 8 | 2 | 3 | first comfortable isolate |
| 12 | 2 | 5 | spare |
| 16 | 4 | 6 | server |
| 32 | 4 | 14 | multi-tenant careful |

### 20.2 cores_per_channel = 3 (heavy HTML)

| Phys cores | House | Max ch @3c |
|---|---|---|
| 6 | 0 | 2 |
| 12 | 2 | 3 |
| 16 | 4 | 4 |

Не включать 3c/ch на 3600 для 3 каналов.

---

## 21. Security / multi-tenant notes

На shared server:

- cgroup + CPUAffinity обязательны,
- `CAP_SYS_NICE` ограничить CapabilityBoundingSet,
- не давать пользователям произвольный `chrt`,
- логи RT fail не должны содержать secrets,
- DeckLink device node permissions — отдельный hardening (не в scope pinning, но блокирует prod).

---

## 22. Связь с Phase 19 cost model (preview)

Scheduling гарантирует **доступность CPU**. Cost model отвечает: **хватает ли** CPU на конкретный template (video decode, blur, masks). Документ 04 не заменяет 19: можно идеально запинить канал и всё равно получить 29 in_fps на тяжёлом content (Phase 11 Ch1).

Gate формулировка:

```
IF ref=locked AND d_late=0 AND stage<<budget AND in_fps<<50
THEN suspect content cost / Blink, not OS scheduling
```

---

## 23. Учебный сценарий: один неправильный pin

**Симптом:** Ch0 стабилен 50, Ch1 35–40, stage times OK.

**Плохой pin:** Ch1 = `0,3,6,9` (два CCX + странные siblings).

**Диагноз:** L3 miss + возможный overlap с Ch0 cores.

**Fix:** вернуть disjoint sequential или CCX pack; проверить `Cpus_allowed_list`.

**Урок:** telemetry fps alone не показывает overlap — нужен `taskset -cp` audit.

---

## 24. Учебный сценарий: IRQ на render

**Симптом:** редкие late раз в минуту; stage avg хороший.

**Находка:** DeckLink IRQ counts растут на CPU 7 (SMT sibling Ch0).

**Fix:** smp_affinity_list → 0-1; stop irqbalance; rerun 30 min.

**Урок:** average turbostat Busy% может выглядеть «нормально».

---

## 25. Учебный сценарий: SCHED_FIFO без cpuset

**Симптом:** после setcap машина «подлагивает» в SSH иногда.

**Причина:** RT pump + CEF runnable без isol; desktop на тех же CPU.

**Fix:** либо убрать RT на lab desktop, либо house/render split на большом CPU.

**Урок:** RT усиливает необходимость isolation на interactive hosts.

---

## 26. Подробности WaitForTick semantics (ops view)

`WaitForTick(timeout_us)`:

- возвращает число ticks (иногда batch),
- 0 при timeout → pump всё равно делает работу (fallback),
- при shutdown condvar notify, чтобы не ждать timeout.

Ops: рост timeout path в логах = карта не callback’ает вовремя или consumer stuck — смотреть device/ref, не governor первым.

---

## 27. Взаимодействие с preview / browser channels

Если на той же машине крутятся browser/null каналы рядом с decklink:

- они тоже берут cores через тот же `run-engines` allocator,
- RT на них **не** ставится,
- всё равно отъедают L3/CCX.

Для HW soak лучше **только** decklink channels на машине; editor — на другом host или house cores с отдельным limit.

---

## 28. Logging hygiene для scheduling investigation

Per-channel logs (`ENGINE_LOG_DIR`) обязательны: Phase 10.1. При OS experiments добавляйте:

```
[pack] ch=... cpus=... raster=... governor=... thp=...
```

в стартовый banner (future improvement), чтобы soak артефакты были самоописываемыми.

---

## 29. CI considerations

CI обычно без DeckLink. Для scheduling:

- unit/dry-run `detect-cpu-pack` на fixture topologies,
- shellcheck `run-engines` / `run-channel`,
- **не** включать isolcpus в CI agents.

Hardware lab — единственное место G1–G4.

---

## 30. Final operator one-pager (Russian)

1. Три канала = шесть physical cores на 3600; SMT siblings в mask обязательны.  
2. Не жди isolcpus на 6c — некуда.  
3. Genlock must lock; иначе не начинай soak.  
4. `SCHED_FIFO` — бонус, не фундамент.  
5. IRQ DeckLink держи на house.  
6. Governor performance на эфире.  
7. Spikes без late stage → смотри THP doc 06.  
8. Низкий fps при чистом OS → cost model / content.  
9. Любой тюнинг → bench null regression.  
10. Большие серверы: house + isol + auto pack script.

---

*Конец документа 04 — OS scheduling, CPU pinning, DeckLink latency и genlock.*
