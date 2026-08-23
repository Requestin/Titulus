# Phase 22 operator templates

Сюда кладутся **новые** тестовые шаблоны, которые оператор нарисует
в editor после P22.6. Это финальный exam Phase 22, не стартовый набор.

Пока каталог пустой намеренно: подставлять музейный `test1` или
p21 draft fixtures сюда нельзя.

## Когда появятся файлы

1. Оператор создаёт шаблоны (песочница `:3012` или согласованная копия).
2. JSON без секретов копируется сюда как `<case-id>.json`.
3. Медиа — отдельным оговорённым набором, не в этом каталоге.
4. Фиксируются goldens capabilities/normalize в
   `tests/fixtures/p22/expected/`.
5. Повторяется T0 + null 1ch/3ch + DeckLink 1ch/3ch **только на них**.
6. Пишется `docs/performance investigation/reports/p22-07-operator-templates.md`.

## Naming

`<case-id>` — lowercase kebab-case, описывает сцену, не SHA и не имя автора.

JSON: UTF-8, LF, два пробела, финальный newline. Не включать volatile
timestamps, случайные host paths, пароли, абсолютные пути `TITULUS_DATA`.
