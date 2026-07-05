# Быстрый старт

Точка входа для разработчика или агента после `git clone`.

## 1. Статус проекта

Сводка фаз и следующие задачи — `.cursor/rules/development-plan.mdc`.  
Детали по фазам — `docs/development-phases/`.

## 2. Первые команды

```bash
git clone https://github.com/Requestin/Titulus.git
cd Titulus
git fetch origin && git status && git branch -a

cd runtime && npm install && npm run build && cd ..
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

## 3. Dev-стек

```bash
./dev-start.sh    # frontend :3011, backend :3002, engines supervisor
./dev-stop.sh
```

| Сервис | URL |
|---|---|
| UI | http://127.0.0.1:3011 |
| API | http://127.0.0.1:3002/api/health |
| Логин | `admin` / `admin123` (bootstrap) |

`TITULUS_DATA=/tmp/titulus-dev` (не использовать `./data` в репо для тестов — SQLITE_IOERR).

LAN: по умолчанию `0.0.0.0`. Только localhost: `TITULUS_HOST=127.0.0.1 ./dev-start.sh`.

## 4. Сборка engine (опционально)

```bash
./engine/third_party/fetch-cef.sh   # один раз
cd engine && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j"$(nproc)"
```

Smoke: `./engine/build/Release/bg_engine --consumer=null --fps=50 --duration=3 --url=file://$(pwd)/bench/bench.html`

## 5. Куда смотреть дальше

| Вопрос | Документ |
|---|---|
| Архитектура, правила разработки | `.cursor/rules/architecture.mdc`, `docs/ARCHITECTURE.md` |
| Git workflow | `.cursor/rules/git-workflow.mdc` |
| Операционка, troubleshooting | `docs/RUNBOOK.md` |
| Продукт и UI | `docs/PRODUCT.md`, `docs/DESIGN.md` |
| Engine porting-map | `docs/CASPARRCG_PORTING.md` |

## 6. Session resume

```bash
git fetch origin && git status && git branch -a
gh pr list --state open
```

Перед DeckLink-экспериментами: `pgrep -af "bg_engine|run-channel|run-engines"` — на стенде могут идти live-каналы.
