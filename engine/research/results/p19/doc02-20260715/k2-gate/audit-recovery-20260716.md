# Doc02 audit recovery evidence — 2026-07-16

## Build under test

- Branch: `fix/phase-19-doc02-audit-recovery`
- Binary: `engine/build/Release/bg_engine`
- Runtime bundle rebuilt from `runtime/src`
- Host: Ryzen 5 3600, DeckLink Quad 2, genlock locked
- Template: `tests/templates/test1.json`
- Output: HD1080i50, fill-only
- Pins: ch0 `0-3`, ch1 `4-7`, ch2 `8-11`

Raw process/DeckLink logs remain outside git. This file records the redacted
decision evidence and reproducible commands.

## Verification

```text
runtime: 25/25 PASS
engine ASan/UBSan CTest: 4/4 PASS
production CEF/DeckLink build: PASS
dynamic null probe: 700 frames, 50.03 fps, late=0
dynamic compose p95: 1.181 ms
dynamic fallback/capture failures: 0/0
live dirty copy: 3,625,024 bytes
equivalent full live copy: 151,191,040 bytes
```

Static frozen-frame off/on parity:

```text
resolution=1920x1080
MAE RGB=0.029825/0.030230/0.032442
max channel delta=31
SSIM All=0.999062
in-memory scalar/SIMD and incremental/full goldens=byte exact
```

## K2 command

```bash
TOKEN="$(curl .../api/auth/login | ...)"
OUT_ROOT=/tmp/titulus-doc02-k2-pr8 WARMUP=10 \
  engine/research/p19/run_doc02_k2_abba.sh 1ch 30
OUT_ROOT=/tmp/titulus-doc02-k2-pr8 WARMUP=10 \
  engine/research/p19/run_doc02_k2_abba.sh 3ch 30
```

Each cell contains six complete 5-second measurement windows after warmup.
Treatment proof requires `mode=composing`, `capture_failures=0`, `fallback=0`,
`capture_ready>=8` and positive composed frame count.

## 1ch ABBA

```text
A1 off median=49.9
B1 on  median=50.0 uplift=1.0020
B2 on  median=50.0 uplift=1.0020
A2 off median=49.9
verdict=SMOKE_PASS
late/drop/flush/unlock=0
```

## 3ch ABBA

```text
A1 off medians=29.6/29.8/31.75
B1 on  medians=50.0/50.0/50.0
uplifts=1.6892/1.6779/1.5748

B2 on  medians=50.0/50.0/50.0
A2 off medians=30.0/28.2/29.1
uplifts=1.6667/1.7730/1.7182

worst paired channel uplift=1.5748
required PASS threshold=1.5
verdict=PASS
late/drop/flush/unlock=0
```

## Allowlist proof

Canonical template id:
`6104dc7e-45c4-48b1-a382-db3b3b34091f`.

Wrong allowlist:

```text
mode=fallback
reason=template_not_allowlisted:<canonical-id>
legacy monolith continues
state-only animation does not retry capture
```

Canonical allowlist:

```text
mode=composing
capture_ready=8
capture_failures=0
fallback=0
~50 fps null probe
```

## Soaks

The strict harness waits for the actual `WINDOWS+1` telemetry record count on
every channel, discards the first boundary record and parses exactly the
requested number of complete windows. It fails on any late/drop/flush/unlock.

```bash
BG_LAYERED_COMPOSITOR_ALLOWLIST=<canonical-id> \
  engine/research/p19/run_doc02_k2_gate.sh 1ch on 900

BG_LAYERED_COMPOSITOR_ALLOWLIST=<canonical-id> \
  engine/research/p19/run_doc02_k2_gate.sh 3ch on 3600
```

Final exact-build results:

```text
1ch / 15 min:
  windows=180
  median=50.0 avg=50.0 min=50.0 max=50.0
  late=0 drop=0 flush=0 unlock=0

3ch / 60 min:
  ch0 windows=720 median=50.0 avg=50.0 min=50.0 max=50.2
  ch1 windows=720 median=50.0 avg=50.0 min=50.0 max=50.0
  ch2 windows=720 median=50.0 avg=50.0 min=50.0 max=50.2
  all channels: late=0 drop=0 flush=0 unlock=0
```

Soak verdict: **PASS**.
