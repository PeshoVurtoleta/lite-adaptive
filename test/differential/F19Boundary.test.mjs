// @zakkster/lite-adaptive -- F19 boundary-key differential parity (QA, 1.8.0; repo-only).
//
// F19 rewrote the HeavyKeeper / SlidingHyperLogLog / SlidingCountMin hash paths so no boxable number
// crosses a call. The existing parity suites pin large keys for HK + SCM, but the SHLL vectors use only
// small keys (`% keyspace`). This suite pins ALL THREE members on the exact int32 / uint32 / safe-integer
// edges (2^31-1, 2^31, 2^32, -(2^31)-1, +-(2^53-1), 0, -0, +-1, 2^30, 2^32-1, -(2^31) and +-1 / +-7
// neighbours), through BOTH add() and addFrom(), against golden outputs generated from the 1.7.0 file
// (`git show 534fab6:Adaptive.js`, read-only) by the SAME stream module (F19BoundaryStream.mjs).
// SCM estimateInto (absent in 1.7.0) is pinned against the 1.7.0 scalar estimate() goldens.
// TEETH: a seed-shifted replay MUST mismatch the goldens (so the vectors are not trivially all-equal).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as mod from '../../Adaptive.js';
import { replay } from './F19BoundaryStream.mjs';

const GOLD = JSON.parse(readFileSync(
    fileURLToPath(new URL('./f19-boundary-1.7.0-vectors.json', import.meta.url)), 'utf8'));

const CUR = replay(mod, true);

// Slot-wise mismatch count over the flattened outputs; a length difference counts every missing slot.
function mismatches(a, b) {
    const fa = [a].flat(Infinity), fb = [b].flat(Infinity);
    const n = Math.max(fa.length, fb.length);
    let bad = 0;
    for (let i = 0; i < n; i++) if (!Object.is(fa[i], fb[i])) bad++;
    return bad;
}

test('F19 boundary: the key table is the one the goldens were generated from', () => {
    assert.deepEqual(CUR.keys, GOLD.keys);
    assert.ok(GOLD.keys.includes(2 ** 31 - 1) && GOLD.keys.includes(2 ** 31) && GOLD.keys.includes(2 ** 32));
    assert.ok(GOLD.keys.includes(-(2 ** 31) - 1) && GOLD.keys.includes(2 ** 53 - 1) && GOLD.keys.includes(-(2 ** 53 - 1)));
});

test('F19 boundary: HeavyKeeper topKInto snapshots + estimates are bit-identical to 1.7.0', () => {
    assert.equal(mismatches(CUR.hk.snaps, GOLD.hk.snaps), 0);
    assert.equal(mismatches(CUR.hk.est, GOLD.hk.est), 0);
    assert.equal(CUR.hk.size, GOLD.hk.size);
    assert.ok(GOLD.hk.est.filter((x) => x > 0).length >= 10, 'goldens carry real signal');
});

test('F19 boundary: SlidingHyperLogLog count(W / W/2 / W/8) is bit-identical to 1.7.0 on edge keys', () => {
    assert.equal(mismatches(CUR.shll.counts, GOLD.shll.counts), 0);
    assert.equal(CUR.shll.overflows, GOLD.shll.overflows);
    assert.ok(new Set(GOLD.shll.counts.flat()).size >= 30, 'SHLL goldens are not degenerate');
});

test('F19 boundary: SlidingCountMin estimate(key, w) is bit-identical to 1.7.0 on edge keys', () => {
    assert.equal(mismatches(CUR.scm.probes, GOLD.scm.probes), 0);
    assert.equal(CUR.scm.saturated, GOLD.scm.saturated);
    assert.ok(new Set(GOLD.scm.probes.flat()).size >= 100, 'SCM goldens are not degenerate');
});

test('F19 boundary: SlidingCountMin estimateInto equals the 1.7.0 scalar estimate goldens slot-for-slot', () => {
    assert.equal(mismatches(CUR.scm.into, GOLD.scm.probes), 0);
});

test('F19 boundary CONTROL: a seed-shifted replay MUST mismatch the goldens (the vectors have teeth)', () => {
    const shift = (C, argIdx) => class extends C {
        constructor(...a) { const o = { ...a[argIdx] }; o.seed = (o.seed | 0) + 1; a[argIdx] = o; super(...a); }
    };
    const bad = replay({
        HeavyKeeper: shift(mod.HeavyKeeper, 3),
        SlidingHyperLogLog: shift(mod.SlidingHyperLogLog, 1),
        SlidingCountMin: shift(mod.SlidingCountMin, 1),
    }, false);
    const hkBad = mismatches(bad.hk.est, GOLD.hk.est) + mismatches(bad.hk.snaps, GOLD.hk.snaps);
    const slBad = mismatches(bad.shll.counts, GOLD.shll.counts);
    const scmBad = mismatches(bad.scm.probes, GOLD.scm.probes);
    assert.ok(hkBad >= 20, 'HK seed control mismatches ' + hkBad);
    assert.ok(slBad >= 10, 'SHLL seed control mismatches ' + slBad);
    assert.ok(scmBad >= 100, 'SCM seed control mismatches ' + scmBad);
});
