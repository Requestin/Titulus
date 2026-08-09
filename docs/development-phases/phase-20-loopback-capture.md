# Phase 20 — SDI Loopback Capture Protocol

**Статус:** L0 PASS; L1 tooling operational, formal on-wire cadence baseline
pending after evidence-gate hardening.
**Goal:** measure the signal that leaves DeckLink, without substituting
render-side averages for on-wire temporal evidence.

## 1. Why loopback is required

`in_fps`, `d_pairs` and DeckLink completion counters describe different points
of the pipeline. None proves that the monitor received an ordered,
non-duplicated 50-field semantic sequence. A capture must therefore inspect:

- order of semantic IDs in separate fields;
- duplicate, skipped and reversed field IDs;
- timestamps and cadence of captured output;
- field dominance / bob deinterlace interpretation.

JPEG preview is intentionally excluded: it is throttled and is not the SDI
path.

## 2. Hardware facts and constraints

| Item | Current state |
|---|---|
| Output card | DeckLink Quad 2 |
| Format | HD1080i50, BGRA scheduled output |
| Timing | LES DG-14B (or equivalent) remains connected to Reference In |
| Outputs under test | three concurrent DeckLink channels |
| Physical connector map | Reference In = port 1; output device 1 = port 5; device 2 = port 7; device 3 = port 9 |
| Active loopback | output port 5 (`device-index=1`) → input port 6 (`device-index=2`) |
| Free SDI connectors | ports 2, 3, 4 and 8; port 6 is the active capture input |
| Available cable topology | two output→input pairs at once; third can be tested in a second pass |
| Optional independent capture | DeckLink Studio 2 can be installed later |

Reference In is not an SDI I/O connector. Do **not** disconnect it merely to
get another loopback cable: that alters the clock domain being measured.

The current host `ffmpeg` reports no DeckLink input device support. It is not a
capture implementation and must not be used as proof that the card cannot
capture. P20.2 starts with a capability probe in Blackmagic Desktop Video /
Media Express or a small local DeckLink SDK capture probe.

## 3. Safety rules

1. Stop all Titulus engine supervisors before connector/profile discovery:
   `run-engines.sh`, every `run-channel.sh` and every `bg_engine`.
2. Never change a connector’s profile/duplex while output engines run.
   The engine profile callback deliberately requests restart if streams would
   be forced to stop.
3. Leave Reference In attached throughout all acceptance captures.
4. Do not hot-plug the reference and do not remap output `device-index` during
   a measured run.
5. Capture data on tmpfs or a dedicated fast volume. Do not allow a sustained
   full-raster recording to cause the pacing defect being measured.
6. Capture tooling is observer-only: no `ScheduleVideoFrame`, no changes to
   engine affinity, priority, template or global layered flag.

## 4. Preflight and connector discovery

Perform this section with engines stopped and record it in the run manifest:

1. Record Desktop Video version, firmware, SDK version, host kernel and git
   SHA.
2. In Desktop Video Setup / Media Express enumerate persistent device IDs,
   connector labels, configured directions, active profile and supported
   HD1080i50 input mode.
3. Map each Titulus `device-index` to its physical output with a static
   color/label test. The 2026-08-09 map is device 1→port 5, device 2→port 7,
   device 3→port 9; revalidate it after any profile change.
4. Assign one unused Quad 2 SDI connector to input only if the discovered
   active profile supports simultaneous input/output. Save a screenshot or
   textual record of the assignment.
5. Connect one known Titulus output to that input. Do not create an SDI loop.
6. In the capture tool confirm lock and detected `HD1080i50` before starting
   Titulus.

If the Quad 2 profile cannot expose input without stopping/reprofiling the
three outputs, use Media Express only for an offline one-channel smoke or
install DeckLink Studio 2 as the independent capture device. Do not infer
simultaneous-I/O behavior from connector count alone.

## 5. Capture stages

### L0 — offline connector smoke

With one generator/output and one capture input:

- send a static colour/label pattern;
- verify the recorded input identity, geometry and field dominance;
- make a 5–10 s capture and decode it in both TFF and BFF modes;
- record which interpretation preserves the expected field marker order.

No cadence conclusion is valid at L0.

**2026-08-09 result:** Quad 2 Full Duplex exposed `HD1080i50` input on
`device-index=2`; SDK TestPattern from output port 5 to input port 6 produced
250/250 valid captured frames. This is L0 PASS. Static content could not prove
dominance, so TFF/BFF was decided later by the semantic marker.

### L1 — semantic-field smoke

Run one Titulus channel with the P20 moving-bar/frame-ID pattern for 20–30 s.
The capture analysis must extract an ID from each field, report sequence
delta/order and retain a small image window around any anomaly.

Pass:

- lock is continuous;
- all fields decode;
- expected marker and dominance are identified;
- tooling detects injected synthetic duplicate/reverse fixtures offline.

**2026-08-09 checkpoint:** streaming field capture decodes the marker after
acquiring the DeckLink input buffer with `StartAccess`. TFF preserves temporal
order; the BFF control produces systematic reverse/skip and is rejected.
Short TFF captures can be clean, but the five-minute one-tick/1-ms-slice run
contained 71 duplicate, one skipped and one reversed field among 14,998
decoded fields. L1 therefore remains FAIL/pending, not a short-smoke PASS.
The unbounded serial-recovery experiment also froze the producer and has been
reverted.

### L2 — one-channel A/B

For each candidate cadence variant:

1. baseline warm-up;
2. capture 10–15 min plus engine frame-log, completion log and manifest;
3. collect independent operator marks without watching logs;
4. analyze field IDs and join operator marks to engine events.

Compare only one factor per run. The capture output is the deciding evidence,
not average FPS.

### L3 — three-channel validation

Use two available loopback pairs to capture two outputs in one 15-min run.
Capture the third output in a second identically configured run. Retain all
three output channels for every run; do not reduce rendering to one channel
when making the 3ch claim.

The final 60-min validation may sample loopback channels in rotating pairs if
the capture hardware remains a non-invasive observer. Report exactly which
channels were captured and which were only telemetry-observed.

## 6. Capture format and analysis

The P20 marker uses a large, high-contrast semantic ID and bar position in
both field parities. It must survive normal SDI transport and must not rely on
sub-pixel alpha or timestamp OCR.

For every captured field produce:

```text
unix_us,output_channel,capture_input,field_index,semantic_id,
field_parity,expected_parity,frame_hash
```

`semantic_delta` and `order_ok` are derived by the offline analyser from
consecutive `semantic_id` values; they are deliberately not callback CSV
columns. The L1 probe contract and its safe-label rules are documented in
[`engine/research/p20/README-decklink-field-capture.md`](../../engine/research/p20/README-decklink-field-capture.md).

Classify:

| Condition | Meaning |
|---|---|
| `semantic_delta=+1` | expected next temporal pose |
| `semantic_delta=0` | duplicate / hold |
| `semantic_delta>+1` | skipped pose |
| `semantic_delta<0` | reversed temporal order |
| marker undecodable | capture/tooling failure; not a healthy field |

Render captured source as bob 50 fields/s for inspection. Test TFF and BFF
only against the marker; never choose dominance from which video “looks
nicer.” Preserve field-interleaved source as the primary artifact.

## 7. Artifact layout

```text
/mnt/titulus-tmpfs/p20-loopback/<run-id>/
  manifest.json
  connector-map.md
  engine-ch1.log
  frame-ch1.csv
  completion-ch1.csv
  operator-marks.csv
  capture-fields.csv
  anomalies/
  analysis.json
  operator-notes.md
```

`manifest.json` includes git SHA, runtime bundle SHA, Desktop Video/SDK,
firmware, exact connector map, template, flag values, pinning, reference
status and capture software version.

## 8. Acceptance and rollback

P20.2 passes only when all decoded post-warm-up fields have strictly monotonic
semantic IDs with delta `+1`, no reversed pair and continuous reference lock.
Duplicates, skips or undecodable fields are failures requiring attribution
before changing defaults.

The verdict is conjunctive: logger integrity, render liveness, DeckLink
delivery, schedule cadence and semantic-field acceptance must all pass.
`late/drop/flush=0` alone is explicitly insufficient because scheduled output
can complete normally while the producer is frozen and the consumer repeats
stale fields.

Rollback is operational: stop engines cleanly, remove loopback cable, restore
the saved Desktop Video connector/profile assignment, reconnect monitors, then
restart the dev stack. No engine source or database migration is part of
loopback setup.
