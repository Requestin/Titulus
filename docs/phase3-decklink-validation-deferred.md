# Phase 3 DeckLink Validation (Deferred Without HW)

Phase 3 in this environment is **code-complete + compile/link verified** only.
Runtime SDI validation is deferred until a host with:

- Blackmagic DeckLink output board
- external genlock source
- SDI monitoring chain (Fill+Key capable)

This follows `.cursor/rules/04-decklink-no-hw.mdc`.

## What Is Verified On Dev Host

- `engine/src/consumers/decklink_consumer.{h,cpp}` compiles with SDK 16.0 headers; DeckLink runtime is resolved via `dlopen(libDeckLinkAPI.so)`.
- `run-engines.sh` / `run-channel.sh` map `output_mode=decklink` to `--consumer=decklink`.
- Engine restart contract is wired: consumer can request `exit 42` for supervisor restart.

## Hardware Validation Checklist (Deferred)

- [ ] 1080i50 external keyer Fill+Key output confirmed on SDI monitor.
- [ ] `GetReferenceStatus` reports `bmdReferenceLocked` with connected genlock.
- [ ] Interlaced weave motion is smooth (50 fields) and parity matches CasparCG.
- [ ] 8h soak with no sustained drops under locked reference.
- [ ] A/B check: same template on CasparCG vs `bg_engine` is visually indistinguishable.
- [ ] Jitter-budget notes documented for best-effort operation without genlock.

## Suggested Bring-Up Commands (HW Host)

```bash
cd /root/Titulus/engine
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
  -DBG_ENABLE_DECKLINK=ON \
  -DDECKLINK_SDK_INCLUDE="/path/to/Blackmagic DeckLink SDK 16.0/Linux/include"
cmake --build build -j"$(nproc)"
```

Then run channel supervisor with a channel configured as `output_mode=decklink` and
non-negative `device_index`.
