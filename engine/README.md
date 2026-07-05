# engine/ — bg_engine

C++20 + CEF OSR render host. Один процесс = один канал. CPU-only, BGRA end-to-end.

Документация: `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md`.  
Porting-map: `../docs/CASPARRCG_PORTING.md`. Consumers: null, pipe, preview, decklink, stream.

## Сборка

```bash
./third_party/fetch-cef.sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j"$(nproc)"
```

Smoke: `./build/Release/bg_engine --consumer=null --fps=50 --duration=3 --url=file://$(pwd)/../bench/bench.html`

## Supervisor

`run-engines.sh`, `run-channel.sh` — см. `docs/RUNBOOK.md`.
