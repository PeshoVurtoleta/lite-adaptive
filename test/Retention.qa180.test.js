// @zakkster/lite-adaptive -- 1.8.0 QA retention gate (node:test). Spawns test/qa/RetentionProbe180.mjs
// under --expose-gc (fail closed if the flag does not reach the child) and gates: every tracked
// SlidingCountMin (total / estimateInto reads), DriftDetector latch (PH + CUSUM) and large-key
// HeavyKeeper instance is collected after clear() + drop (lite-leak tracker.size() === 0, 0 audit
// findings) AND heapUsed across cycles 1..9 stays within a 1 MB spread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('retention: 10 cycles x 50 instances each of SCM / DD latch / HK large-key -> tracker.size() 0 and heap spread < 1 MB', () => {
    const probe = fileURLToPath(new URL('./qa/RetentionProbe180.mjs', import.meta.url));
    const r = spawnSync(process.execPath, ['--expose-gc', probe], { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, 'probe exit ' + r.status + ' ' + r.stderr);
    const res = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(res.error, undefined, 'probe: ' + res.error);
    assert.equal(res.tracked, 2000);
    assert.equal(res.live, 0, 'lite-leak live handles ' + res.live + ' / ' + res.tracked);
    assert.equal(res.findings, 0, 'lite-leak audit findings');
    assert.ok(res.spread < 1024 * 1024, 'heapUsed spread ' + res.spread + ' B over cycles 1..9');
    // 1.10.0 H2-4: every cycle x instance rejected its Proxy-keys estimateInto at the door (tagged throw).
    assert.equal(res.expectRejects, 500, 'expected reject count = cycles x instances');
    assert.equal(res.rejects, res.expectRejects, 'tagged Proxy rejections ' + res.rejects + ' / ' + res.expectRejects);
    assert.ok(res.sinkFinite);
});
