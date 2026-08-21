# Документы ветки `sergey-v1`

Эти материалы подготовлены Сергеем и описывают UX и product semantics его
ветки. Они используются как reference input для
[Phase 21](../development-phases/phase-21-new-designer-merge.md), но не
разрешают прямой merge ветки и не заменяют engine/performance gates.

## Содержание

- [Новый интерфейс — иллюстрированное описание](new-interface.md)
  - [исходный DOCX](new-interface.docx);
  - [извлечённые изображения](new-interface-assets/media/).
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

## Формат DOCX

Оригинал сохранён для редактирования в Word/LibreOffice. Для review в Git
рядом хранится Markdown-копия с относительными ссылками на PNG. При изменении
DOCX Markdown и assets нужно сгенерировать заново и проверить визуально.

```bash
cd docs/sergey-v1
pandoc new-interface.docx \
  --from=docx --to=gfm --wrap=none \
  --extract-media=new-interface-assets \
  --output=new-interface.md
```

После генерации верните в Markdown заголовок и ссылку на Phase 21 из текущей
версии файла: Pandoc переносит содержимое DOCX, но не repository-specific
примечание.
