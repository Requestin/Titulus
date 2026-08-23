# Phase 21 schema fixtures

P21.0 фиксирует только layout и golden policy. JSON fixtures в этом шаге
намеренно не добавляются; конкретные cases появятся вместе со schema/migration
contract.

## Intended layout

```text
tests/fixtures/p21/
  old/
    <case-id>.json
  draft/
    <case-id>.json
  expected/
    <case-id>.normalized.json
    <case-id>.capabilities.json
```

- `old/` — неизменённые legacy inputs, принятые current `main`.
- `draft/` — входы предлагаемого schema contract до его фиксации.
- `expected/*.normalized.json` — reviewable canonical output после
  parse/migration/normalization.
- `expected/*.capabilities.json` — ожидаемая capability classification и
  air-compatibility verdict.
- Связанные input и expected используют одинаковый `<case-id>`; case может
  иметь input в `old/` или `draft/`, когда второй вариант неприменим.

## Naming

`<case-id>` записывается в lowercase kebab-case и описывает capability и
вариант, например `lower-third-basic`. Не использовать номера PR, даты, SHA,
имена авторов или детали реализации. Один файл представляет один логический
case.

## Golden policy

- `old/` никогда не переписывается миграцией: это source evidence.
- `draft/` меняется только при явном изменении draft contract.
- `expected/` — checked-in golden. Его обновление требует осознанного review
  schema/migration diff; автоматическое массовое обновление не принимается.
- По умолчанию тесты сравнивают нормализованные JSON values, а не whitespace;
  byte-for-byte comparison допустим только для отдельного serializer contract.
- JSON: UTF-8, LF, два пробела, финальный newline, стабильный порядок ключей.
- Не включать volatile timestamps, случайные IDs и host-specific paths.
- Любой новый case должен назвать исходный contract, ожидаемое преобразование
  и причину golden change в соответствующем PR.
