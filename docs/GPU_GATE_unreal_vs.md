# GPU Gate — Unreal / Virtual Studio mode

**Feature:** `render_backend=unreal` + `bg_vs_engine` (DeckLink IN + Unreal ingest + chroma key + composite + DeckLink OUT)

**Status:** Gate **APPROVED for Unreal VS profile only**. HTML/`bg_engine` remains CPU-only (§0.2.1).

## 1. Hypothesis

Realtime virtual-studio composite at 1080i50 / 1080p50:

- Unreal Engine scene render (always GPU),
- chroma key of camera Fill against green/blue,
- layered composite of keyed talent over Unreal BG,

cannot meet broadcast cadence on a pure CPU path without unacceptable drops or quality.

## 2. Why CPU path is exhausted (Gate criterion §0.2.1 #1)

| Workload | CPU-only expectation | Notes |
|---|---|---|
| Unreal frame generation | Impossible | UE requires GPU; out of Titulus HTML scope |
| Chroma key 1920×1080 @50 | Marginal | Soft matte + despill is bandwidth-heavy; CPU POC only for demos |
| Composite + genlock SDI out | Feasible | DeckLink scheduled path already CPU BGRA |

Acceptance bar for HTML channels (Phase 0): 3×1080p50, drops &lt;0.1%, p99≈21ms. Adding per-pixel chroma + two live sources on CPU would violate that bar on the same cores as CEF.

**Measured CPU POC (synthetic):** see `bench/run-vs-bench.sh` — CPU chroma path is for functional verification only; production VS profile assumes GPU for Unreal and (recommended) GPU-assisted key.

## 3. CasparCG CPU baseline

CasparCG HTML path is CPU OSR (our parity target). CasparCG does **not** ship a Unreal+chroma VS mixer; VS is out of scope for CasparCG HTML parity. Gate does not claim GPU for HTML templates.

## 4. Scope of GPU approval

| Allowed | Forbidden without new Gate |
|---|---|
| Unreal Engine process (external) | Enabling GPU inside CEF/`bg_engine` HTML path |
| Optional future GPU chroma/composite kernels in `bg_vs_engine` | GPU→CPU readback into HTML templates |
| NDI/GPU capture from UE host | Replacing `@titulus/runtime` DOM with WebGL |

BGRA end-to-end to DeckLink OUT remains the contract for `bg_vs_engine` program frames (same as `bg_engine`).

## 5. Sign-off

- **CPU path exhausted** for Unreal scene + broadcast chroma @50fps: **yes** (architectural).
- **HTML/`bg_engine`:** unchanged, `--disable-gpu` remains mandatory.
- **Unreal VS profile:** GPU permitted for Unreal host + future GPU key/composite inside `bg_vs_engine` only.

Refs: `docs/unreal-vs-mode.md`, DEVELOPMENT_PROMPT §0.2.1.
