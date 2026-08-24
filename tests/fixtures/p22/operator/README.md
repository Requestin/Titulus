# Phase 22 operator templates

Канон для **всех новых** тестов производительности: `newtest1` и `newtest2`.
Музейный `test1` / `p20-test1-visual` больше не использовать для новых
null / browser / DeckLink / ABBA замеров.

| Case | Файл | Сцена |
|---|---|---|
| `newtest1` | `newtest1.json` | без видео: картинки, маски, часы, crawl, lower-third |
| `newtest2` | `newtest2.json` | с видео: те же картинки + два looped WebP |

Медиа лежит здесь, в `media/`, со стабильными именами. Host UUID из
editor sandbox в JSON не сохраняются.

## Как посеять медиа

```bash
tests/fixtures/p22/operator/seed-media.sh "$TITULUS_DATA"
```

Это кладёт файлы в `$TITULUS_DATA/uploads/` и
`$TITULUS_DATA/data-files/` под теми путями, которые написаны в JSON.

Air path для видео — только `.webp`. Исходные `.webm` лежат в
`media/source/` как архив и в эфир не копируются.

Дополнительная копия на i7:
`/home/requestin/Titulus-evidence/p22-operator-canon/`.

## Goldens

`tests/fixtures/p22/expected/<case-id>.{normalized,capabilities}.json`.

## Cell recipe

Изолированный backend `:3003`, не трогать живой Phase 21 hands-on
`:3012/:3004`. Перед cell остановить operator sandbox `:3011/:3002`.

```bash
engine/research/p20/run-p20-cell.sh 3ch \
  --template=tests/fixtures/p22/operator/newtest2.json \
  --pacing-mode=one-tick --layered=off --raster-threads=3 \
  --duration=225 --warmup=10 --consumer=decklink --execute --confirm-decklink
```

Живой cell по умолчанию ≤ 5 минут. Более длинный soak — только если
оператор явно попросил.

P22.7 закрыт. Отчёт:
`docs/performance investigation/reports/p22-07-operator-templates.md`.

## Naming / JSON

UTF-8, LF, два пробела, финальный newline. Без секретов, без абсолютных
путей `TITULUS_DATA`, без случайных host upload UUID.
