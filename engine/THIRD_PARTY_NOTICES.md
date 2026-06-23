# THIRD_PARTY_NOTICES — `engine/` (Titulus render plane)

Titulus `bg_engine` is proprietary software. The render plane is developed
**by reference** to CasparCG Server (GPLv3+) per DEVELOPMENT_PROMPT §0.1: we
study CasparCG algorithms and reimplement them in original code. Direct
verbatim copying of GPLv3 source into this proprietary product is avoided;
when unavoidable it is flagged below for legal review before commercial release.

This file tracks every third-party dependency and reference used by `engine/`.

---

## Reference implementations (studied, not linked, not shipped)

| Reference | License | Path (dev server) | Usage |
|---|---|---|---|
| **CasparCG Server** | GPLv3+ | `/root/Titulus/CasparCG/server` (`v2.3.3-lts-stable-436-gd603ee91f`, trunk toward 2.6.0) | Primary render-engine reference. Studied for CEF OSR patterns, DeckLink scheduled playback, weave interlace, ffmpeg consumer. **Reimplemented by reference** — see `CASPARRCG_PORTING.md`. Not linked, not shipped, not a runtime dependency. |

Per §0.1 legal strategy: direct paste of GPLv3 code into proprietary product
**may impose copyleft**. Acceptable strategies for Titulus:
1. **Reimplement by reference** (preferred) — study algorithm, write original code.
2. **Port with compliance** — only with legal review; flagged `GPL-PORT:` below.

---

## Linked third-party libraries (bundled or system)

| Library | License | Source | Purpose |
|---|---|---|---|
| **CEF** (Chromium Embedded Framework) | BSD-3-Clause (+ Chromium deps) | downloaded to `engine/third_party/cef/` (gitignored) | HTML5 template runtime — OSR rendering, external begin frame |
| **stb_image_write** | Public Domain / MIT | `engine/third_party/stb_image_write.h` (single header) | JPEG encoding for preview consumer |
| **Blackmagic DeckLink SDK** | Proprietary (Blackmagic) | `Blackmagic DeckLink SDK 16.0/Linux/include/DeckLinkAPI.h` (gitignored, dev-server local) | DeckLink SDI consumer (Phase 3) — compile-time header only; runtime `libDeckLinkAPI.so` from system driver |
| **ffmpeg** (libavformat/avfilter/avcodec) | LGPL-2.1+ (default) / GPL (if --enable-gpl) | system binary / libav* dev packages | Stream consumer (Phase 5) + media transcode (backend) |
| C++ Standard Library | GPL+runtime exception | system (libstdc++) | standard |

---

## GPL-PORT log (verbatim ports requiring legal review)

*None yet.* If a function must be ported near-verbatim from CasparCG (e.g. the
weave line-interleave or `ScheduledFrameCompleted` scheduling, where the
algorithm is simple enough that an independent rewrite would converge), it will
be recorded here with: source file:line → our file:line → justification →
legal-review status.

---

## Maintenance

- Update this file whenever a new third-party dependency is introduced or a
  CasparCG module is ported.
- `CASPARRCG_PORTING.md` tracks the per-file porting status; this file tracks
  licensing/compliance.
- **Before any commercial release**: legal review of all `GPL-PORT:` entries
  and confirmation that reimplement-by-reference entries are sufficiently
  original (not mechanical translations).
