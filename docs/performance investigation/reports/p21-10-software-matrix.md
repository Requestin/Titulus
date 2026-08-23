# P21.10 PR-101 — software / fixture / migration matrix

**Дата:** 2026-08-23  
**Хост:** i7-14700KF (`100.73.71.86`)  
**HEAD:** `d97f2da` (origin/main after PR #140)  
**Статус:** PASS

## T0

Полный software gate на current `main` до hardware cells:

| Gate | Результат |
|---|---|
| Runtime test + typecheck + build | PASS |
| Frontend test + typecheck + build | PASS |
| Backend `tests/*.test.mjs` | 131/131 |
| Root `tests/*.mjs` | 6/6 |
| CPU planner | 6/6 |

Engine CTest не гонялся: `engine/**` в этом PR не менялся. Бинарник
`bg_engine` тот же, что в P21.0 (`c9056983…`).

## Fixtures

Все `tests/fixtures/p21/old/*` остаются byte-identical canonical templates,
schema-valid, normalize identity, `airCompatible=true`.

Все `tests/fixtures/p21/draft/*` schema-valid, normalize identity,
`supported=[]`, `airCompatible=false`. Production/air validator отклоняет
каждый draft, включая Crawl и action cues.

Editor persist: old templates create/update/load. Draft create остаётся 422.
Prepare endpoint и media recovery покрыты существующими backend tests.

Browser-path проверяется unit-тестами `@titulus/runtime` (один renderer,
без отдельного live Chrome). Live null/DeckLink — PR-102.

## Copied DB

- Синтетический pre-migration `legacy.db`: `backend/tests/migrations.test.mjs` PASS.
- Копия P21.0 evidence `/home/requestin/Titulus-evidence/p21-baseline-data/app.db`:
  каналы `p21-baseline-ch1/ch2/ch3` сохранились; накатились
  `001_data_files`…`006_rbac_groups`; повторный `openDb` идемпотентен.
  Боевой файл не открывался.

## Security / Unreal

- Files API: traversal/symlink/binary/oversize/unauth; 403 без утечки корней.
- `TITULUS_FILE_ROOTS` default empty.
- Product trees `engine/`, `backend/src/`, `frontend/src/`, `runtime/src/`,
  `shared/` не содержат `bg_vs_engine`, `run-vs-channel`,
  `render_backend=unreal`. `kind:ue` остаётся явным reject.

## Fresh install + restart

Изолированный `TITULUS_DATA=/tmp/titulus-p21-fresh-install`, `PORT=3013`:

1. Первый boot создал `app.db`, `uploads/`, `data-files/`, `thumbnails/`.
2. Bootstrap login `admin` / `admin123` успешен.
3. Controlled kill + restart на той же data dir: health и login снова OK,
   шесть migrations на месте.

Это не systemd rollout `/var/lib/titulus`; пути и restart semantics те же,
что в deployment guide.

## Docs

Runbook, DeckLink deployment и Phase 10–12 upgrade теперь описывают
`data-files`, `thumbnails` и пустой `TITULUS_FILE_ROOTS`. Nginx получает
`/thumbnails/` рядом с `/uploads/`.
