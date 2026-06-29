# Phase 6.4 DeckLink Validation Closure (Hardware Handoff)

Phase 6.4 defines the **operational closure pack** for final DeckLink acceptance.
Runtime SDI acceptance is still blocked on a hardware host (DeckLink + genlock),
but all required evidence/checklists are fixed here to avoid ambiguous sign-off.

Related docs:
- `docs/phase3-decklink-validation-deferred.md`
- `.cursor/rules/04-decklink-no-hw.mdc`
- `docs/RUNBOOK.md`

## Preconditions (Hardware Host)

- Linux host with Blackmagic DeckLink board installed
- Matching Desktop Video driver + SDK headers
- External genlock source connected
- SDI monitoring chain that can verify Fill+Key
- Same template set available on both `bg_engine` and CasparCG for A/B

## Validation Matrix

1. **Signal lock**
   - `GetReferenceStatus` indicates `bmdReferenceLocked`
   - No sustained unlock periods during soak

2. **Visual parity**
   - 1080i50 Fill+Key output verified with external keyer
   - Weave/interlace motion smoothness matches CasparCG on same templates
   - Alpha edges/masks look identical on waveform/vector scope

3. **Stability**
   - 8-hour soak per production channel profile
   - No sustained drop streaks
   - Restart contract validated (profile switch path -> supervised restart)

4. **Operations**
   - `run-engines.sh` decklink channels start cleanly with auth-enabled backend
   - Operator flow TAKE/UPDATE/CLEAR remains responsive through soak

## Evidence Format (Mandatory)

For each validation run, store artifacts under dated folder, for example:

`/var/log/titulus/phase6-sdi-YYYYMMDD-HHMM/`

Artifacts:
- `env.txt` (host/kernel/driver/SDK versions)
- `channels.json` (effective channel config)
- `engine.log` (full supervisor + consumer logs)
- `reference-lock.log` (periodic lock status samples)
- `soak-summary.txt` (duration, drops, restarts, anomalies)
- `ab-notes.md` (CasparCG vs `bg_engine` comparison notes)
- Optional: scope/screen captures for key scenes

## Command Skeleton (HW Host)

```bash
# 1) Build engine with DeckLink enabled
cd /root/Titulus/engine
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
  -DBG_ENABLE_DECKLINK=ON \
  -DDECKLINK_SDK_INCLUDE="/opt/Blackmagic DeckLink SDK/Linux/include"
cmake --build build -j"$(nproc)"

# 2) Start backend (auth on)
cd /root/Titulus/backend
PORT=3001 TITULUS_DATA=/var/lib/titulus node src/index.js

# 3) Run supervisors (auth-aware run-engines.sh)
cd /root/Titulus
BACKEND_URL=http://127.0.0.1:3001 \
TITULUS_API_USER=admin \
TITULUS_API_PASSWORD='***' \
./engine/run-engines.sh

# 4) Prepare evidence bundle folder for this run
OUT_ROOT=/var/log/titulus \
BACKEND_URL=http://127.0.0.1:3001 \
TITULUS_API_USER=admin \
TITULUS_API_PASSWORD='***' \
./engine/collect-decklink-evidence.sh
```

## Exit Condition

Phase 6.4 is considered closed when:
- Checklist items are fully checked on hardware host
- Evidence bundle is archived and attached to release milestone
- Remaining risk is only operational, not implementation-level
