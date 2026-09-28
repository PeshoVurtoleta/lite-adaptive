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
import { createHash } from 'node:crypto';
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

// ===========================================================================
// 1.10.0 LATCHED-PH parity (T0d, ROADMAP 10.1). The 1.7.0 blocks above are UNTOUCHED. The v1.10.0 T8
// gated PH re-centre only subtracts the running min/max once max(|mMin|,|mMax|) > th*2^20 -- a bound
// no series here (20k / 6k items, th 5) comes within ~three orders of magnitude of reaching, so the
// re-centre NEVER fires on these streams and every public getter stays BIT-IDENTICAL to the 1.9.0
// (HEAD) golden here, so NO re-pin is needed for these vectors. NOTE the re-centre is NOT globally
// output-identical: output is identical to 1.9.0 only UNTIL the first re-centre (past ~th*2^20
// accumulator magnitude); after it, `statistic` is MORE accurate (no catastrophic cancellation of the
// unbounded 1.9.0 accumulators) and a re-arm at an exact th/2 tie may resolve differently -- proven and
// bounded live in test/Hardening110.qa.test.js P2. latch:false + CUSUM stay
// bit-identical too (proven above + by cuLatch here). All LIVE. Per item: fired, statistic, mean,
// count, lastDriftIndex, lastDirection,
// encoded as IEEE-bit hex (NaN- and -0-exact). The STREAM block is a VERBATIM copy of the generator's.
// SIZE: each per-item series is stored as a sha256 digest of the full series plus a SPARSE sample
// (first 20, every 100th, last 20; `fired` is 1 char/item, the hex getters 16), not the whole 20k
// stream (5.83 MB -> ~0.12 MB). The test recomputes the full series live, compares the digest, and on
// a mismatch reports the first diverging sampled index.
// ===========================================================================
const LV = JSON.parse(readFileSync(
    fileURLToPath(new URL('./dd-1.9.0-latch-vectors.json', import.meta.url)), 'utf8'));

const _dv = new DataView(new ArrayBuffer(8));
function _hx(x) { _dv.setFloat64(0, x); return _dv.getBigUint64(0).toString(16).padStart(16, '0'); }

// ---- STREAM (VERBATIM copy of the generator's block) ----
const N_LONG = 20000;
function _lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function buildStreamL(seed, N) {
    const rnd = _lcg(seed);
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
function buildSquare() { const b = new Float64Array(N_LONG); for (let i = 0; i < N_LONG; i++) b[i] = ((i & 63) < 32) ? 0 : 10; return b; }
function buildStep(hiLo) { const b = new Float64Array(6000); for (let i = 0; i < 6000; i++) b[i] = i < 2000 ? 0 : (i < 4000 ? 10 : hiLo); return b; }
function replayL(mode, opts, stream) {
    const dd = new DriftDetector(mode, opts);
    const kbuf = new Float64Array(1);
    const fired = [], stat = [], mean = [], cnt = [], lidx = [], ldir = [];
    for (let i = 0; i < stream.length; i++) {
        kbuf[0] = stream[i];
        fired.push(dd.addFrom(kbuf, 0) ? '1' : '0');
        stat.push(_hx(dd.statistic)); mean.push(_hx(dd.mean)); cnt.push(_hx(dd.count));
        lidx.push(_hx(dd.lastDriftIndex)); ldir.push(_hx(dd.lastDirection));
    }
    return { fired: fired.join(''), stat: stat.join(''), mean: mean.join(''), cnt: cnt.join(''), lidx: lidx.join(''), ldir: ldir.join('') };
}
// ---- END STREAM ----

function _sha256(s) { return createHash('sha256').update(s).digest('hex'); }
// Compare a live concatenated series against a golden {len, sha, idx, hex}: digest-first (the true
// bit-for-bit gate); on a mismatch, walk the sparse sample and fail at the FIRST diverging sampled
// index. `width` is the per-entry char width (fired 1, hex getters 16).
function cmpSeries(liveStr, gold, width, label) {
    const n = liveStr.length / width;
    assert.equal(n, gold.len, label + ' length drifted (' + n + ' vs ' + gold.len + ')');
    if (_sha256(liveStr) === gold.sha) return;
    for (let k = 0; k < gold.idx.length; k++) {
        const i = gold.idx[k];
        const got = liveStr.slice(i * width, i * width + width);
        if (got !== gold.hex[k]) {
            assert.fail(label + ' series digest drifted; first diverging sampled index ' + i +
                ' (got ' + got + ' want ' + gold.hex[k] + ')');
        }
    }
    assert.fail(label + ' series digest drifted but every sampled index agrees -- divergence lies between samples');
}
function assertLatch(got, gold, label) {
    cmpSeries(got.fired, gold.fired, 1, label + ' fired');
    cmpSeries(got.stat, gold.stat, 16, label + ' statistic');
    cmpSeries(got.mean, gold.mean, 16, label + ' mean');
    cmpSeries(got.cnt, gold.cnt, 16, label + ' count');
    cmpSeries(got.lidx, gold.lidx, 16, label + ' lastDriftIndex');
    cmpSeries(got.ldir, gold.ldir, 16, label + ' lastDirection');
}

test('DDParity latch: CUSUM latch:true (cuLatch) is bit-identical to the 1.9.0 golden', () => {
    assertLatch(replayL(DRIFT_CUSUM, LV.meta.cuOpts, buildStreamL(LV.meta.CU_SEED, N_LONG)), LV.cuLatch, 'cuLatch');
});
test('DDParity latch: PH latch:true (phLatch) is bit-identical to the 1.9.0 golden', () => {
    assertLatch(replayL(DRIFT_PH, LV.meta.phOpts, buildStreamL(LV.meta.PH_SEED, N_LONG)), LV.phLatch, 'phLatch');
});
test('DDParity latch: PH latch:true square wave (phSquare) is bit-identical to the 1.9.0 golden', () => {
    assertLatch(replayL(DRIFT_PH, LV.meta.phSquareOpts, buildSquare()), LV.phSquare, 'phSquare');
});
test('DDParity latch: PH latch:true 0/+10/-10 step (phStep1) is bit-identical to the 1.9.0 golden', () => {
    assertLatch(replayL(DRIFT_PH, LV.meta.phStepOpts, buildStep(-10)), LV.phStep1, 'phStep1');
});
test('DDParity latch: PH latch:true 0/+10/-30 step (phStep2) is bit-identical to the 1.9.0 golden', () => {
    assertLatch(replayL(DRIFT_PH, LV.meta.phStepOpts, buildStep(-30)), LV.phStep2, 'phStep2');
});
test('DDParity latch: phDemo is recorded skipped with a reason (demo generator not importable as a pure fn)', () => {
    assert.equal(LV.phDemo.status, 'skipped');
    assert.ok(typeof LV.phDemo.reason === 'string' && LV.phDemo.reason.length > 0, 'phDemo skip needs a reason');
});

// TEETH: the latch gate is a full-series sha256, so ONE flipped hex digit in a 20k-item series must
// change the digest and go RED. Prove it on the phStep1 statistic series: the live digest matches the
// golden, and a single-nibble flip of that live series yields a DIFFERENT digest.
test('DDParity latch CONTROL: a one-hex-digit flip changes the series digest (gate has teeth)', () => {
    const got = replayL(DRIFT_PH, LV.meta.phStepOpts, buildStep(-10));
    const series = got.stat;
    assert.equal(_sha256(series), LV.phStep1.stat.sha, 'sanity: the live replay digest matches the golden');
    const pos = 48;   // some mid-series nibble
    const flip = (parseInt(series[pos], 16) ^ 0x1).toString(16);
    const mutated = series.slice(0, pos) + flip + series.slice(pos + 1);
    assert.notEqual(mutated, series, 'sanity: the flip changed the series string');
    assert.notEqual(_sha256(mutated), LV.phStep1.stat.sha, 'a one-hex-digit flip must change the digest (gate is toothless)');
});
