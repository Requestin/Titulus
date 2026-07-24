# `engine/` — `bg_engine` native render host (DEVELOPMENT_PROMPT §9)

C++20 + CEF off-screen rendering host. One `bg_engine` process = one CasparCG
channel (HTML producer + consumers). CPU-only software rasterization, BGRA
end-to-end. **Reimplemented by reference from CasparCG Server** — see
[`CASPARRCG_PORTING.md`](./CASPARRCG_PORTING.md) for the porting map and
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for GPL compliance.

## Architecture (per DEVELOPMENT_PROMPT §4.2)

```
channel.html + bg-runtime.js  →  CEF HTML Producer (OSR)
   → CefRenderHandler::OnPaint(BGRA)
   → frame ring
   → Consumer: decklink (scheduled) | ffmpeg | preview (JPEG) | pipe | null
```

## Status

**Phase 0-6 code path is implemented** (DeckLink runtime acceptance still
depends on HW/genlock host execution):

| Component | Status |
|---|---|
| `CMakeLists.txt`, CEF download | ✅ |
| `src/main.cpp`, `engine_app.*`, `engine_client.*` (CEF OSR host) | ✅ |
| `src/config.*` (CLI), `src/stats.*` (interval/fps/drops), `src/frame_ring.h`, `src/message_pump.h` | ✅ |
| `consumers/null_consumer.h` | ✅ |
| `consumers/pipe_consumer.*`, `consumers/preview_writer.*` | ✅ |
| `consumers/decklink_consumer.*` | ✅ code-complete (HW validation deferred) |
| `consumers/ffmpeg_consumer.*` | ✅ done (raw BGRA -> ffmpeg stream child) |
| `bg_vs_engine` (`src/vs/*`) Unreal VS compositor | ✅ foundation — see `docs/unreal-vs-mode.md` |
| `run-engines.sh`, `run-channel.sh`, `run-vs-channel.sh`, `systemd/bg-engine@.service` | ✅ |
| `collect-decklink-evidence.sh` (Phase 6.4 handoff) | ✅ |

## CLI (target, per §9.5)

```
bg_engine --url=URL --width=1920 --height=1080 --fps=50 \
          --consumer=null|pipe|preview|decklink|stream \
          --cache-dir=DIR --name=STR --duration=SEC --stats-interval=SEC \
          [--device-index=N --display-mode=HD1080i50 --keyer=external] \
          [--preview-out=PATH --preview-fps=10] [--stream-url=URL] [--out=FILE]
```

## Build (target)

```bash
cd engine && mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j
./bg_engine --consumer=null --url=http://localhost:3001/channel.html --duration=60
```

CEF distribution is downloaded into `third_party/cef/` by a bootstrap script
(gitignored). DeckLink SDK header is read from `../../Blackmagic DeckLink SDK 16.0/`
on the dev server (gitignored, conditional compile in Phase 3).

## Operational notes

- `run-engines.sh` is auth-aware (backend token or login credentials required).
- Final SDI hardware closure uses `collect-decklink-evidence.sh` +
  `docs/phase6-decklink-validation-closure.md`.
