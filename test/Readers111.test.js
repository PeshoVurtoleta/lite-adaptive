// @zakkster/lite-adaptive -- v1.11.0 zero-alloc READERS contract (RED-FIRST; run:
//   node --test test/Readers111.test.js).
//
// Batch 1 lands this file with EVERY case `todo` -- the two readers it pins do not exist yet:
//   - SlidingHyperLogLog.countInto(out, w?) -> 1   (batch 2)
//   - DriftDetector.into(out) -> 5                 (batch 3)
// Each case throws today (the method is absent) and is reported `not ok ... # TODO`, so the suite
// stays GREEN. Batches 2 / 3 drop the `todo` on the rows they implement; the assertions are the
// contract those batches must satisfy (ROADMAP 12.1 S1 / S2 / S4). ASCII-only; node:test only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingHyperLogLog, DriftDetector, DRIFT_PH, DRIFT_CUSUM } from '../Adaptive.js';

const B2 = {};                              // batch 2 SHIPPED countInto -- SHLL rows are LIVE now
const B3 = {};                              // batch 3 SHIPPED into -- DD rows are LIVE now

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------
function makeSHLL() {
    const sl = new SlidingHyperLogLog(100000, { p: 12, ringCap: 8, seed: 3 });
    let clk = 1.75e12;
    for (let k = 0; k < 20000; k++) { clk += 1.5; sl.add(clk, (k * 2654435761 >>> 0)); }
    return sl;
}
// a DD driven into a real (non-empty, non-fired) statistic; a PH square wave that has fired at least once.
function makeDDfired() {
    const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 });
    for (let k = 0; k < 4000; k++) dd.add((k < 2000 ? 0 : 10) + (k % 3) * 0.01);
    return dd;
}
// a lying-length Float64Array subclass over a VALID backing: its `length` getter returns NaN, but the
// intrinsic TA_LEN read sees the true length -> S2 ACCEPTS it. A flag records whether the OWN getter ran.
function lyingLenView(len) {
    const flag = { touched: false };
    class Lie extends Float64Array {
        get length() { flag.touched = true; return NaN; }
    }
    const v = new Lie(len);
    return { v, flag };
}

// ===========================================================================
// SlidingHyperLogLog.countInto(out, w?) -> 1   (BATCH 2)
// ===========================================================================
test('SHLL countInto: out[0] Object.is count(w) over 10k queries (unset / empty / in-range / bad w / NaN)', B2, () => {
    // unset sketch -> 0
    const unset = new SlidingHyperLogLog(1000, { p: 8 });
    const o = new Float64Array(1);
    assert.equal(unset.countInto(o), 1);
    assert.ok(Object.is(o[0], unset.count()), 'unset: out[0] !== count()');
    assert.ok(Object.is(o[0], 0), 'unset must read 0');

    const sl = makeSHLL();
    const W = 100000;
    let seed = 0x2545f491 >>> 0;
    const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 10000; i++) {
        const r = rnd();
        let w;
        if (r < 0.15) w = undefined;               // full window
        else if (r < 0.30) w = -rnd() * W;         // <= 0 -> NaN
        else if (r < 0.45) w = W * (1 + rnd());    // > W -> NaN
        else if (r < 0.50) w = NaN;                // NaN -> NaN
        else w = rnd() * W;                         // in range
        const expect = w === undefined ? sl.count() : sl.count(w);
        const ret = w === undefined ? sl.countInto(o) : sl.countInto(o, w);
        assert.equal(ret, 1, 'countInto must return 1');
        assert.ok(Object.is(o[0], expect), 'out[0] (' + o[0] + ') !== count(' + w + ') (' + expect + ')');
    }
});

test('SHLL countInto: a bad sub-window writes NaN and returns 1 (never a throw); Object.is count(bad) on a live AND an UNSET sketch', B2, () => {
    const sl = makeSHLL();
    // M10 teeth: on an UNSET sketch a bad w must STILL read NaN (the w check runs BEFORE the unset
    // early-return, exactly as count()). A mutant that returns the unset 0 before validating w would
    // write 0 here while count(bad) is NaN -> Object.is(0, NaN) fails.
    const unset = new SlidingHyperLogLog(1000, { p: 8 });
    const o = new Float64Array(1);
    for (const bad of [0, -1, Infinity, -Infinity, NaN, 1e18, 'x', null]) {
        const ret = sl.countInto(o, bad);
        assert.equal(ret, 1, 'bad w=' + String(bad) + ' must still return 1');
        assert.ok(Number.isNaN(o[0]), 'bad w=' + String(bad) + ' must write NaN, got ' + o[0]);
        const uret = unset.countInto(o, bad);
        assert.equal(uret, 1, 'unset bad w=' + String(bad) + ' must return 1');
        assert.ok(Object.is(o[0], unset.count(bad)), 'unset bad w=' + String(bad) + ': out[0] (' + o[0] + ') !== count(bad) (' + unset.count(bad) + ')');
        assert.ok(Number.isNaN(o[0]), 'unset bad w=' + String(bad) + ' must write NaN (w check precedes unset), got ' + o[0]);
    }
});

test('SHLL countInto: container rejects per S2 (Proxy / non-F64 / short throw; lying-length backing accepted)', B2, () => {
    const sl = makeSHLL();
    // Proxy over a valid Float64Array: ArrayBuffer.isView(proxy) is false -> TypeError.
    const px = new Proxy(new Float64Array(1), {});
    assert.throws(() => sl.countInto(px), TypeError, 'Proxy container must throw TypeError');
    // wrong element type -> TypeError.
    assert.throws(() => sl.countInto(new Float32Array(1)), TypeError, 'Float32Array must throw TypeError');
    assert.throws(() => sl.countInto([0]), TypeError, 'plain array must throw TypeError');
    // too short (< 1) -> RangeError.
    assert.throws(() => sl.countInto(new Float64Array(0)), RangeError, 'length 0 must throw RangeError');
    // lying-length subclass over a length-1 backing: TA_LEN sees 1 -> ACCEPTED, writes slot 0.
    const { v, flag } = lyingLenView(1);
    const ret = sl.countInto(v);
    assert.equal(ret, 1, 'lying-length valid backing must be accepted');
    assert.ok(Object.is(v[0], sl.count()), 'lying-length backing: slot 0 not written with count()');
    assert.equal(flag.touched, false, 're-entrant OWN length getter must never run (TA_LEN intrinsic used)');
});

// ===========================================================================
// DriftDetector.into(out) -> 5   (BATCH 3)
// ===========================================================================
test('DD into: out[0..4] Object.is [statistic, mean, count, lastDriftIndex, lastDirection] over 10k reads -- {PH, CUSUM} x {latch off, on}', B3, () => {
    // The full mode x latch matrix (M3 teeth): CUSUM's statistic getter is max(gP, gN), so an UP-then-DOWN
    // signal makes gN exceed gP for stretches -- a mutant that writes out[0] = this._gP (never gN) then
    // diverges from the getter and this Object.is fails.
    const cfgs = [
        { mode: DRIFT_PH, latch: false }, { mode: DRIFT_PH, latch: true },
        { mode: DRIFT_CUSUM, latch: false }, { mode: DRIFT_CUSUM, latch: true },
    ];
    for (const c of cfgs) {
        const opts = c.mode === DRIFT_CUSUM
            ? { target: 1, delta: 0.5, threshold: 5, latch: c.latch }
            : { delta: 0.005, threshold: 5, latch: c.latch };
        const dd = new DriftDetector(c.mode, opts);
        const o = new Float64Array(5);
        const tag = (c.mode === DRIFT_CUSUM ? 'CUSUM' : 'PH') + ' latch=' + c.latch;
        for (let i = 0; i < 10000; i++) {
            // up for the first half of each 1000-block, down for the second -> both gP and gN accumulate.
            const phase = i % 1000;
            dd.add(1 + (phase < 500 ? 3 : -3) + (i % 7) * 0.001);
            const ret = dd.into(o);
            assert.equal(ret, 5, tag + ': into must return 5');
            assert.ok(Object.is(o[0], dd.statistic), tag + ' slot0 statistic (i=' + i + ')');
            assert.ok(Object.is(o[1], dd.mean), tag + ' slot1 mean');
            assert.ok(Object.is(o[2], dd.count), tag + ' slot2 count');
            assert.ok(Object.is(o[3], dd.lastDriftIndex), tag + ' slot3 lastDriftIndex');
            assert.ok(Object.is(o[4], dd.lastDirection), tag + ' slot4 lastDirection');
        }
    }
});

test('DD into: fire -> clear() -> into resets count to 0 and slots 3-4 back to NaN (never keeps the last fire)', B3, () => {
    for (const mode of [DRIFT_PH, DRIFT_CUSUM]) {
        const opts = mode === DRIFT_CUSUM ? { target: 0, delta: 0.5, threshold: 5 } : { delta: 0.005, threshold: 5 };
        const dd = new DriftDetector(mode, opts);
        let fired = false;
        for (let k = 0; k < 4000 && !fired; k++) fired = dd.add(k < 2000 ? 0 : 10);
        assert.ok(fired, mode + ': setup must fire at least once');
        assert.ok(!Number.isNaN(dd.lastDriftIndex), mode + ': a fire set lastDriftIndex');
        dd.clear();
        const o = new Float64Array(5); o.fill(-7.5);
        assert.equal(dd.into(o), 5);
        assert.ok(Object.is(o[0], dd.statistic) && Object.is(o[0], 0), mode + ': cleared statistic 0');
        assert.ok(Object.is(o[1], dd.mean) && Object.is(o[1], 0), mode + ': cleared mean 0');
        assert.ok(Object.is(o[2], dd.count) && Object.is(o[2], 0), mode + ': cleared count 0');
        assert.ok(Number.isNaN(o[3]), mode + ': cleared lastDriftIndex NaN (slot 3)');
        assert.ok(Number.isNaN(o[4]), mode + ': cleared lastDirection NaN (slot 4)');
    }
});

test('DD into: an EMPTY detector reads [0, 0, 0, NaN, NaN]', B3, () => {
    for (const mode of [DRIFT_PH, DRIFT_CUSUM]) {
        const dd = mode === DRIFT_CUSUM ? new DriftDetector(mode, { target: 1 }) : new DriftDetector(mode);
        const o = new Float64Array(5);
        assert.equal(dd.into(o), 5);
        assert.ok(Object.is(o[0], 0), 'empty statistic 0');
        assert.ok(Object.is(o[1], 0), 'empty mean 0');
        assert.ok(Object.is(o[2], 0), 'empty count 0');
        assert.ok(Number.isNaN(o[3]), 'empty lastDriftIndex NaN');
        assert.ok(Number.isNaN(o[4]), 'empty lastDirection NaN');
    }
});

test('DD into: a latched-PH detector at the fire (count 0 but accumulators nonzero) reads the getters, not the inline stat', B3, () => {
    // After a latching PH fire the count resets to 0 while _clampGap leaves gP = mMin + threshold (nonzero).
    // The statistic getter special-cases _n <= 0 -> 0, so into() MUST take the empty branch (out[0] = 0),
    // never the inline stat (which would read gP - mMin = threshold). This pins the _n <= 0 empty branch.
    const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5, latch: true });
    let fired = false;
    for (let k = 0; k < 200 && !fired; k++) fired = dd.add(k < 100 ? 0 : 10);
    assert.ok(fired, 'setup: the latched PH detector must have fired');
    assert.equal(dd.count, 0, 'setup: count resets to 0 at the latched fire');
    assert.ok(dd._gP !== 0, 'setup: the accumulator is nonzero at the fire (the empty-branch trap)');
    const o = new Float64Array(5);
    assert.equal(dd.into(o), 5);
    assert.ok(Object.is(o[0], dd.statistic), 'slot0 must match the statistic getter (0), not the inline gP - mMin');
    assert.ok(Object.is(o[0], 0), 'slot0 statistic 0 on a count-0 detector');
    assert.ok(Object.is(o[1], dd.mean), 'slot1 mean');
    assert.ok(Object.is(o[2], dd.count), 'slot2 count 0');
    assert.ok(Object.is(o[3], dd.lastDriftIndex), 'slot3 lastDriftIndex (the fire index, NOT NaN)');
    assert.ok(Object.is(o[4], dd.lastDirection), 'slot4 lastDirection (the fire direction, NOT NaN)');
    assert.ok(!Number.isNaN(o[3]), 'slot3 must be the real fire index (persists across the reset)');
});

test('DD into: a non-finite accumulator throws the _guardFinite RangeError BEFORE any slot is written', B3, () => {
    const dd = new DriftDetector(DRIFT_PH);
    for (let k = 0; k < 32; k++) dd.add((k < 16 ? 0 : 10) + k * 0.001);   // _n > 0 (a real, fired run)
    // The public API caps |x| <= DD_X_MAX and resets on a fire, so it CANNOT drive an accumulator
    // non-finite -- _guardFinite is defense-in-depth (Adaptive.js: "Unreachable via the public API").
    // Corrupt an accumulator directly to exercise the SAME guard the statistic / mean getters throw on.
    dd._gP = Infinity;
    assert.throws(() => dd.statistic, RangeError, 'sanity: the statistic getter throws on the same state');
    // sentinel out: fail closed means NONE of the 5 slots is written on the throw.
    const SENT = -123456.5;
    const o = new Float64Array(5); o.fill(SENT);
    let threw = false;
    try { dd.into(o); } catch (e) { threw = true; assert.ok(e instanceof RangeError, 'must be a RangeError'); }
    assert.ok(threw, 'into must throw on a non-finite accumulator');
    for (let s = 0; s < 5; s++) assert.ok(Object.is(o[s], SENT), 'slot ' + s + ' was written before the throw (not fail-closed)');
});

test('DD into: container rejects per S2 (Proxy / non-F64 / short throw; lying-length >=5 backing accepted; getter never runs)', B3, () => {
    const dd = makeDDfired();
    assert.throws(() => dd.into(new Proxy(new Float64Array(5), {})), TypeError, 'Proxy -> TypeError');
    assert.throws(() => dd.into(new Float32Array(5)), TypeError, 'Float32Array -> TypeError');
    assert.throws(() => dd.into([0, 0, 0, 0, 0]), TypeError, 'plain array -> TypeError');
    assert.throws(() => dd.into(new Float64Array(4)), RangeError, 'length 4 < 5 -> RangeError');
    const { v, flag } = lyingLenView(5);
    assert.equal(dd.into(v), 5, 'lying-length length-5 backing must be accepted');
    assert.ok(Object.is(v[0], dd.statistic), 'lying-length backing: slot0 written');
    assert.equal(flag.touched, false, 're-entrant OWN length getter must never run');
});

test('DD into: subarray-view packing of 50 channels (one call per channel, Object.is per slot)', B3, () => {
    const N = 50;
    const backing = new Float64Array(N * 5);
    const views = [];
    for (let c = 0; c < N; c++) views.push(backing.subarray(c * 5, c * 5 + 5));
    const dds = [];
    for (let c = 0; c < N; c++) { const dd = makeDDfired(); for (let k = 0; k < c; k++) dd.add(k * 0.1); dds.push(dd); }
    for (let c = 0; c < N; c++) assert.equal(dds[c].into(views[c]), 5);
    for (let c = 0; c < N; c++) {
        assert.ok(Object.is(backing[c * 5 + 0], dds[c].statistic), 'ch ' + c + ' statistic');
        assert.ok(Object.is(backing[c * 5 + 1], dds[c].mean), 'ch ' + c + ' mean');
        assert.ok(Object.is(backing[c * 5 + 2], dds[c].count), 'ch ' + c + ' count');
        assert.ok(Object.is(backing[c * 5 + 3], dds[c].lastDriftIndex), 'ch ' + c + ' lastDriftIndex');
        assert.ok(Object.is(backing[c * 5 + 4], dds[c].lastDirection), 'ch ' + c + ' lastDirection');
    }
});
