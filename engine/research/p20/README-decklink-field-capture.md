# P20 DeckLink field capture

`decklink_field_capture` is an L1 observer-only SDI input probe. It captures
only `HD1080i50` as 8-bit UYVY, decodes the P20 green marker in the DeckLink
input callback, and writes field metadata. It does not link into `bg_engine`,
does not schedule output frames, change connector profiles or write raw video.

Before using it, follow the connector and Reference In safety rules in
[Phase 20 loopback capture](../../../docs/development-phases/phase-20-loopback-capture.md):
stop Titulus engine supervisors before input/profile discovery, leave Reference
In connected, and use a one-way output-to-input cable rather than an SDI loop.

## Build and test

The standalone CMake project leaves `engine/CMakeLists.txt` unchanged.

```bash
cmake -S engine/research/p20 -B engine/research/p20/build \
  -DDECKLINK_SDK_INCLUDE="/home/requestin/Загрузки/Blackmagic DeckLink SDK 16.0/Linux/include" \
  -DDECKLINK_API_LIBRARY=/lib/libDeckLinkAPI.so \
  -DCMAKE_BUILD_TYPE=Release
cmake --build engine/research/p20/build --parallel
ctest --test-dir engine/research/p20/build --output-on-failure
```

The unit test is synthetic and does not enumerate or open DeckLink hardware.

For an existing SDK Capture raw UYVY artifact, the offline fallback reads one
frame at a time (it does not allocate the whole multi-gigabyte file):

```bash
node engine/research/p20/decode-uyvy-fields.mjs \
  --in=/path/to/capture.uyvy \
  --out=/path/to/capture-fields.csv \
  --output-channel=ch1 \
  --capture-input=quad2-sdi6 \
  --start-unix-us=1725000000000000 \
  --tff
```

`--start-unix-us` is the capture's known first-field timestamp. Do not use the
default zero origin for joins with engine or operator evidence.

## Controlled L1 invocation

`--csv` is required and the probe refuses to overwrite an existing file.
`--duration-sec` is bounded to `1..3600` seconds; use 20–30 seconds for L1.
All labels are restricted to safe CSV tokens (`A-Z`, `a-z`, `0-9`, `.`, `_`,
`-`, `:`), so captured rows cannot inject a comma, quote or newline.

```bash
engine/research/p20/build/decklink_field_capture \
  --device-index=2 \
  --duration-sec=30 \
  --field-order=tff \
  --output-channel=ch1 \
  --capture-input=quad2-sdi6 \
  --csv=/mnt/titulus-tmpfs/p20-loopback/L1-YYYYMMDDTHHMMSSZ/capture-fields.csv
```

The tool starts input streams only after the selected device reports
`HD1080i50` UYVY support without conversion. Do not run it while output engines
or connector/profile setup are active. It has no raw-frame output path.

## CSV contract

The header and every record use exactly:

```text
unix_us,output_channel,capture_input,field_index,semantic_id,field_parity,expected_parity,frame_hash
```

- `unix_us` is `system_clock` Unix epoch microseconds sampled inside
  `VideoInputFrameArrived`; both fields from one container receive that callback
  timestamp.
- `field_index` is the emitted capture-order index, beginning at zero.
- `field_parity` is the container scanline parity (`even`/`odd`).
- `expected_parity` records the configured order: `tff` emits even then odd;
  `bff` emits odd then even. Test both configurations against the marker; the
  tool does not infer dominance from visual appearance.
- `semantic_id` is blank if the P20 green bar is undecodable. Otherwise it is
  a locally unwrapped residue from
  `x = 144 + 24 * (semantic_id mod 64)`. The unwrap preserves normal
  duplicates, reversals and skips up to 32 residues from the expected next
  field; larger loss is intrinsically ambiguous with a 64-state marker.
- `frame_hash` is a fixed 16-character lowercase FNV-1a 64-bit hash over the
  visible UYVY bytes of that parity only. It is not a raw-frame artifact.

Analyse the resulting CSV with the existing
`engine/research/p20/lib/analyze-semantic-fields.mjs`; undecodable IDs,
duplicates, skipped IDs, reversed IDs and parity mismatches are failures for
the L1 smoke, not healthy output.

Use strict mode for a gate:

```bash
node engine/research/p20/lib/analyze-semantic-fields.mjs \
  --in=/path/to/capture-fields.csv \
  --strict \
  --min-fields=14900 \
  --out=/path/to/semantic-analysis.json
```

For a completed canonical cell, combine semantic output with the frame and
DeckLink event logs:

```bash
node engine/research/p20/lib/analyze-p20-evidence.mjs \
  --run-dir=/path/to/p20-cell \
  --capture=/path/to/capture-fields.csv \
  --channel=1 \
  --min-fields=14900 \
  --out=/path/to/joint-evidence.json
```

The joint verifier fails unless logger integrity, render liveness, DeckLink
delivery/cadence, frame-sequence progress and semantic-field acceptance all
pass. A clean completion result with a frozen producer is not healthy output.
