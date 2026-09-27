// @zakkster/lite-adaptive -- DriftDetector S9 (latch) differential parity (repo-only; run:
//   node --test test/differential/DDParity.test.mjs).
//
// The 1.8.0 `latch` option is ADDITIVE: with `latch: false` (or omitted) the detector keeps the 1.x
// auto-reset-on-fire discipline EXACTLY. The hot path now reads a mutable `_lvl` (== threshold when
// armed) instead of `_threshold`, stores a lifetime accepted-add counter into a Float64Array slot,
// and routes a fire through a zero-arg `_fired()` -- none of which change the default output. This
// replays two 20k-item seeded streams (a fractional PH stream and a fractional CUSUM stream, each
// with regime shifts) THROUGH BOTH entry points -- `addFrom(buf, i)` and the plain `add(x)` -- and
// asserts that BOTH `latch: false` AND `latch` omitted reproduce the frozen 1.7.0 golden vectors
// BIT-FOR-BIT: the fire sequence, and the statistic / mean / count at EVERY item, compared with
// Object.is (exact, distinguishes +0 from -0). The golden is JSON, which carries neither -0 nor NaN,
// so the streams are constructed to keep every recorded value a plain finite double.
//
// The vectors are a DATA file inside the package (dd-1.7.0-vectors.json), cut from `git show
// HEAD:Adaptive.js` before the latch edit. The STREAM block below is a VERBATIM copy of the
// generator's, so the two stay in lockstep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DriftDetector, DRIFT_PH, DRIFT_CUSUM } from '../../Adaptive.js';

const V = JSON.parse(readFileSync(
    fileURLToPath(new URL('./dd-1.7.0-vectors.json', import.meta.url)), 'utf8'));

// ---- STREAM GENERATOR (verbatim copy of the generator's block) -----------------------------
function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function buildStream(seed, N) {
    const rnd = lcg(seed);
    const buf = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        let base = 0;
        if (i >= 5000 && i < 10000) base = 3.5;
        else if (i >= 10000 && i < 15000) base = -2.25;
        else if (i >= 15000) base = 1.0;
        buf[i] = base + (rnd() - 0.5) * 2.0;
    }
    return buf;
}
// ---- end verbatim block --------------------------------------------------------------------

// `via` selects the entry point: 'addFrom' reads x UNBOXED from a caller Float64Array; 'add' passes
// the plain double argument. Both MUST reproduce the golden bit-for-bit (the fix touches neither).
function replay(mode, stream, opts, gold, label, via) {
    const dd = new DriftDetector(mode, opts);
    const kbuf = new Float64Array(1);
    const fires = [];
    for (let i = 0; i < V.N; i++) {
        let fired;
        if (via === 'add') {
            fired = dd.add(stream[i]);
        } else {
            kbuf[0] = stream[i];
            fired = dd.addFrom(kbuf, 0);
        }
        if (fired) fires.push(i);
        assert.ok(Object.is(dd.statistic, gold.stat[i]), label + ' statistic diverged at item ' + i);
        assert.ok(Object.is(dd.mean, gold.mean[i]), label + ' mean diverged at item ' + i);
        assert.ok(Object.is(dd.count, gold.cnt[i]), label + ' count diverged at item ' + i);
    }
    assert.deepEqual(fires, gold.fires, label + ' fire sequence diverged');
}

for (const via of ['addFrom', 'add']) {
    test('DriftDetector PH latch:false via ' + via + ' is bit-identical to the 1.7.0 golden (fires + statistic/mean/count every item)', () => {
        replay(DRIFT_PH, buildStream(V.PH_SEED, V.N), { ...V.phOpts, latch: false }, V.phDefault, 'PH latch:false ' + via, via);
    });
    test('DriftDetector PH latch OMITTED via ' + via + ' is bit-identical to the 1.7.0 golden', () => {
        replay(DRIFT_PH, buildStream(V.PH_SEED, V.N), { ...V.phOpts }, V.phDefault, 'PH omitted ' + via, via);
    });
    test('DriftDetector CUSUM latch:false via ' + via + ' is bit-identical to the 1.7.0 golden (fires + statistic/mean/count every item)', () => {
        replay(DRIFT_CUSUM, buildStream(V.CU_SEED, V.N), { ...V.cuOpts, latch: false }, V.cuDefault, 'CUSUM latch:false ' + via, via);
    });
    test('DriftDetector CUSUM latch OMITTED via ' + via + ' is bit-identical to the 1.7.0 golden', () => {
        replay(DRIFT_CUSUM, buildStream(V.CU_SEED, V.N), { ...V.cuOpts }, V.cuDefault, 'CUSUM omitted ' + via, via);
    });
}
