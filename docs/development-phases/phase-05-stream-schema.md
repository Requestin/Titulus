# Фаза 5 — Stream output + schema + docs

## Мета

| Поле | Значение |
|---|---|
| **Статус** | DONE |
| **PR** | #32–#34 |
| **Merge** | 2026-06-29 |

---

## 1. Цель / зачем

**Cloud output path** (SRT/RTMP), финализация **AI-ready** template schema, первая операционная документация (Architecture + Runbook).

REQ-9: schema готова для AI-assisted template generation.

---

## 2. Исходное состояние

- Consumers: null, pipe, preview, decklink (code-complete)
- Schema — базовая, без AI metadata
- Нет ARCHITECTURE.md / RUNBOOK.md v1

---

## 3. Scope

| # | Deliverable |
|---|---|
| 5.1 | `ffmpeg_consumer` в bg_engine |
| 5.2 | `shared/template.schema.json` — полная спецификация |
| 5.3 | Architecture + Runbook documentation |

---

## 4. Реализация

### 5.1 ffmpeg consumer (PR #32)

- Raw BGRA `OnFrame` → stdin ffmpeg child (`fork/exec`)
- Worker thread — запись на channel cadence
- CLI: `--consumer=stream --stream-url=srt://...`
- `run-channel.sh` валидирует обязательный `--stream-url` для stream mode

### 5.2 Schema (PR #33)

- `schemaVersion`, `description`, `tags`, `metadata`
- Variable constraints (type-aware `defaultValue`)
- Stricter `animatableValues`, timeline action rules
- `runtime/src/schema.ts` синхронизирован

### 5.3 Docs (PR #34)

- `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md` v1
- Fresh Ubuntu bootstrap, engine build, channel config
- Stream/decklink operational notes

---

## 5. PR / Git

| # | Title | Ключевые файлы |
|---|---|---|
| 32 | [Phase 5.1] ffmpeg stream consumer for bg_engine | `ffmpeg_consumer.{h,cpp}`, `main.cpp` |
| 33 | [Phase 5.2] finalize shared template schema (AI-ready) | `shared/template.schema.json`, `schema.ts` |
| 34 | [Phase 5.3] architecture and runbook documentation | `docs/ARCHITECTURE.md`, `RUNBOOK.md` |

---

## 6. Проверка

```bash
bg_engine --consumer=stream --stream-url=udp://127.0.0.1:5000 --duration=3
# SUMMARY stable

curl -X POST /api/templates/validate -H "Authorization: Bearer ..." -d @valid.json → 200
```

---

## 7. Результаты

| Критерий | Статус |
|---|---|
| Stream first-class consumer | ✅ |
| AI-ready schema | ✅ |
| Operational docs v1 | ✅ (переписаны Phase 13) |

---

## 8. Ограничения / отложено

- Multi-bitrate adaptive stream — future
- AI template generation UI — stretch

---

## 9. Артефакты

| Путь | Роль |
|---|---|
| `engine/src/consumers/ffmpeg_consumer.*` | Stream output |
| `shared/template.schema.json` | Canonical schema |
| `docs/RUNBOOK.md` | Operations |
