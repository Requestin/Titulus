# Фаза 3 — DeckLink SDI consumer

## Мета

| Поле | Значение |
|---|---|
| **Статус** | code-complete |
| **PR** | #27 |
| **Merge** | 2026-06-29 |
| **Validation** | HW-хост (Phase 6.4, 10, 11) |

---

## 1. Цель / зачем

Production **SDI Fill+Key** на Linux с parity CasparCG: scheduled playback, interlaced weave 1080i50, external keyer, genlock-aware output.

Render plane MUST converge к CasparCG — reimplement by reference, не fork.

---

## 2. Исходное состояние

- Phase 0–2: null/pipe/preview consumers, supervisor skeleton
- Нет decklink consumer, нет SDK integration
- Dev-сервер без платы — compile-only path

---

## 3. Scope

| # | Deliverable |
|---|---|
| 3.1 | `decklink_consumer` — scheduled playback, weave, keyer, telemetry |
| 3.2 | CMake conditional DeckLink SDK + `dlopen` |
| 3.3 | systemd unit skeleton + supervisor integration |
| 3.4 | Validation deferred doc (checklist для HW) |

---

## 4. Реализация

### decklink_consumer (clean-room)

- `StartScheduledPlayback` + `ScheduledFrameCompleted` callback
- Late frame: `bmdOutputFrameDisplayedLate` → skip-ahead
- Weave 1080i UFF: line-interleave 2 field-frames
- Keyer: `IDeckLinkKeyer::Enable(external|internal)` + `SetLevel(255)`
- Telemetry: completed/late/dropped/flushed counters
- Profile switch → **exit 42** → supervisor restart

### Build / load

- CMake guard: `BG_ENABLE_DECKLINK`, SDK headers path
- Runtime: `dlopen(libDeckLinkAPI.so)` — no static link to proprietary SDK

### Supervisor

- `run-channel.sh` / `run-engines.sh` → `--consumer=decklink`
- Channel config: `device_index`, `display_mode`, `keyer_mode`

### Зафиксированные развилки (не переоткрывать)

1. Clock: Phase 11.2 — `WaitForTick()` для decklink; browser — self-timer
2. Keyer: `IDeckLinkKeyer`, не 2dfd profile API
3. Genlock: `GetReferenceStatus` polling
4. BGRA end-to-end, без BGRA→ARGB
5. Weave — consumer-side UFF

---

## 5. PR / Git

| # | Title | Ключевые файлы |
|---|---|---|
| 27 | [Phase 3] decklink consumer (code-complete) | `decklink_consumer.{h,cpp}`, `CMakeLists.txt`, `run-engines.sh` |

---

## 6. Проверка

### Dev без платы

```bash
cmake -S engine -B engine/build -DBG_ENABLE_DECKLINK=ON
cmake --build engine/build -j"$(nproc)"
# Runtime без платы — ожидаемый fail (документировано)
```

### HW-хост

- 1080i50, genlock `bmdReferenceLocked`
- Fill+Key на внешнем keyer
- 8h soak — см. Phase 6.4
- Live evidence: Phase 10 (tearing fixes), Phase 11 (perf)

---

## 7. Результаты

| Критерий | Статус |
|---|---|
| Compile/link против SDK 16.0 | ✅ |
| Integrated в supervisor | ✅ |
| Live SDI 3ch (домашний хост) | ✅ Phase 10/11 |
| Formal 8h soak closure | ⏳ Phase 6.4 |

---

## 8. Ограничения / отложено

- `GetHardwareReferenceClock` — future enhancement
- 2dfd profile API — aspirational gap vs spec
- Validation на исходном dev-сервере невозможна (нет HW)

---

## 9. Артефакты

| Путь | Роль |
|---|---|
| `engine/src/consumers/decklink_consumer.{h,cpp}` | SDI consumer |
| `engine/systemd/bg-engine@.service` | systemd skeleton |
| `docs/CASPARRCG_PORTING.md` | DeckLink porting map |
| `engine/collect-decklink-evidence.sh` | HW evidence (Phase 6.4) |
