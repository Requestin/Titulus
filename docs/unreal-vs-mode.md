# Unreal / Virtual Studio mode (ZeroDensity-aligned)

Titulus mirrors the Reality Hub / Lino split:

| ZD concept | Titulus |
|---|---|
| Engine / Channel (host + I/O) | Settings → Channel with `render_backend=unreal` |
| Form / Motion Design template | **UE Templates** (`/ue-templates`) — Blueprint TakeIn/TakeOut |
| Rundown / Playout playlist | Control rundown slots with `kind: 'ue'` |
| RealityKeyer + SDI | `bg_vs_engine` chroma + DeckLink OUT |

HTML graphics stay on `render_backend=html` + `/templates` unchanged.

## Minimal path: see UE (or stub) → keyer → out

Goal: prove pixels reach the mixer and leave on BMD (or pipe/ffplay without HW).

### 1. Build

```bash
cd engine && cmake -B build -DCMAKE_BUILD_TYPE=Release \
  -DBG_ENABLE_DECKLINK=ON \
  -DDECKLINK_SDK_INCLUDE="$PWD/../Blackmagic DeckLink SDK 16.0/Linux/include"
cmake --build build --target bg_vs_engine -j"$(nproc)"
```

### 2a. No hardware (synthetic)

```bash
./bench/run-vs-bench.sh 5 chroma
# or watch frames:
./engine/build/Release/bg_vs_engine --consumer=pipe --pipe-out=/tmp/vs.bgra \
  --duration=10 --stats-interval=2
ffplay -f rawvideo -pixel_format bgra -video_size 1920x1080 -framerate 50 /tmp/vs.bgra
```

### 2b. Settings channel (operator path)

1. Settings → Add channel  
2. **Render backend** = `Unreal engine channel`  
3. **NDI source** = your Unreal NDI name (or leave empty for stub BG)  
4. **Camera DeckLink input #** = camera index, or `-1` for green-screen stub  
5. **Output** = `DeckLink` + output device #, keyer **Fill only**  
6. Remote Control URL — optional for video-only; required later for UE Templates TAKE  
7. Save → `./engine/run-engines.sh` (picks `run-vs-channel.sh` for this channel)

### 3. UE Templates (Blueprint control)

1. Nav → **UE Templates** → create  
2. Set `rcObjectPath` + Take In / Take Out function names (exposed in UE Remote Control)  
3. Test Take In against the Unreal channel  
4. Control (UE channel) → TAKE from panel, or **+** into rundown → rundown TAKE

## Channel fields

| Field | Role |
|---|---|
| `render_backend` | `html` \| `unreal` |
| `unreal_endpoint` | Web Remote Control base (`http://host:30010`) |
| `unreal_ndi_source` | NDI name from UE (empty → stub/file) |
| `vs_input_device` | DeckLink **camera IN** (−1 stub) |
| `device_index` / `display_mode` / `keyer_mode` | DeckLink **program OUT** |
| `vs_bg_file` / `vs_cam_file` | Advanced raw BGRA stubs |

## UE template JSON

```json
{
  "schemaVersion": 1,
  "rcObjectPath": "/Game/.../BP_LowerThird",
  "takeIn": { "functionName": "TakeIn", "parameters": {} },
  "takeOut": { "functionName": "TakeOut", "parameters": {} },
  "actions": [],
  "variables": []
}
```

Play: `POST /api/ue-templates/:id/play` `{ "channelId", "mode": "takeIn"|"takeOut" }`

## Pipeline

```
Camera SDI (DeckLink IN) ──► ChromaKeyer ──┐
                                           ├──► Compositor ──► DeckLink OUT
Unreal (NDI / file stub) ──────────────────┘
```

Hardware `IDeckLinkKeyer` ≠ chroma. GPU Gate: `docs/GPU_GATE_unreal_vs.md`.

## Next (suggested, ZD parity)

- Form variables on UE templates (Jump / Play with params)  
- Preview bus JPEG from `bg_vs_engine` into Control monitor  
- NDI SDK build (`BG_ENABLE_NDI`) on production hosts  
- Hybrid: HTML lower-thirds Fill+Key over VS program  
- Launcher-style “start UE map” (out of scope until product needs it)

## Related

- GPU Gate: `docs/GPU_GATE_unreal_vs.md`  
- Runbook § Unreal VS  
- Bench: `bench/run-vs-bench.sh`
