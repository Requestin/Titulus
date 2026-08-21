# Документы ветки `sergey-v1`

Эти материалы подготовлены Сергеем и описывают UX и product semantics его
ветки. Они используются как reference input для
[Phase 21](../development-phases/phase-21-new-designer-merge.md), но не
разрешают прямой merge ветки и не заменяют engine/performance gates.

## Содержание

- [Новый интерфейс — иллюстрированное описание](new-interface.md)
  с [извлечёнными изображениями](new-interface-assets/media/).
- [Template Editor → Data](template-editor-data.md) — sources, parse, select,
  map, variables, media tokens и TAKE/UPDATE semantics.
- [Crawl — параметры и анимация](crawl-parameters.md) — ticker/carousel,
  speed, pause, separator, duration и file/data integration.

## Приоритет источников

1. `.cursor/rules/phase-21-engine-protection.mdc`;
2. `docs/development-phases/phase-21-new-designer-merge.md`;
3. current `main` architecture/runtime contracts;
4. документы в этой папке как описание желаемого UX.

Если описание здесь конфликтует с current engine safety или измерениями,
интеграция останавливается до отдельного решения.

## Статус документов

Source-документы зафиксированы как read-only reference и больше не
редактируются. Иллюстрированное описание хранится только в diff-friendly
Markdown; 36 PNG сохраняют все изображения исходного документа.
