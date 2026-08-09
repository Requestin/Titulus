import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../../..', import.meta.url);
const analyzer = new URL('../lib/analyze-frame-log.mjs', import.meta.url);

test('analyze-frame-log reads the FrameLog v2 deadline column', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titulus-frame-log-v2-'));
  const input = join(dir, 'frame.csv');
  const output = join(dir, 'report.json');
  writeFileSync(input, [
    'schema_version,unix_us,mono_us,interval_us,begin_frame_token,batch_id,batch_index,batch_size,cef_paint_before,cef_paint_after,publish_seq_before,publish_seq_after,delivery_kind,pump_active_us,paint_latency_us,deadline_miss,inflight_depth,paint_seq_delta,runtime_event_seq,runtime_event_age_us,raf_seq,raf_delta_us,ticks_per_raf,logical_frame_before,logical_frame_after,graph_rev,state_rev,compose_seq,live_update_generation',
    '2,1725000000000000,100,0,1,1,0,1,4,4,7,7,none,100,200,1,1,0,0,0,0,0,0,0,0,0,0,0,0',
    '2,1725000000020000,20100,20000,2,2,0,1,4,5,7,8,cef_forward,110,250,0,1,1,0,0,0,0,0,0,0,0,0,0',
    '',
  ].join('\n'));

  execFileSync('node', [analyzer.pathname, `--in=${input}`, `--out=${output}`], {
    cwd: repoRoot.pathname,
    stdio: 'pipe',
  });

  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.totalRows, 2);
  assert.equal(report.deliveredFrames, 1);
  assert.equal(report.timedOutTicks, 1);
  assert.equal(report.ticksWithDeltaGe1, 1);
});
