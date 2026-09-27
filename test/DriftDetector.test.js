// @zakkster/lite-adaptive -- DriftDetector behavioral + drift + fail-closed suite (node:test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriftDetector, DRIFT_PH, DRIFT_CUSUM, VERSION } from '../Adaptive.js';

/** A deterministic mulberry32 PRNG so every drift/false-alarm assertion is reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const MODES = [['PH', DRIFT_PH], ['CUSUM', DRIFT_CUSUM]];

/**
 * Build a DriftDetector for a mode-agnostic test: CUSUM REQUIRES a fixed target, so inject
 * `target: 0` (the in-control mean of the noise-around-0 streams these tests use) unless the
 * caller already set one. PH forbids `target`, so it is only added for CUSUM.
 */
function newDD(mode, opts) {
    const o = Object.assign({}, opts);
    if (mode === DRIFT_CUSUM && o.target === undefined) o.target = 0;
    return new DriftDetector(mode, o);
}

test('VERSION is the expected string', () => {
    assert.equal(VERSION, '1.9.0');
});

test('the mode consts are the documented numeric values', () => {
    assert.equal(DRIFT_PH, 0);
    assert.equal(DRIFT_CUSUM, 1);
});

test('constructor validates mode fail-closed BEFORE field init', () => {
    for (const bad of [2, -1, 0.5, NaN, Infinity, 'ph', null, undefined, {}, 10n]) {
        assert.throws(() => new DriftDetector(bad), /\[lite-adaptive\]/, 'mode=' + String(bad));
    }
    assert.doesNotThrow(() => new DriftDetector(DRIFT_PH));
    assert.doesNotThrow(() => new DriftDetector(DRIFT_CUSUM, { target: 0 }));
});

test('constructor rejects an unknown option / non-object options', () => {
    assert.throws(() => new DriftDetector(DRIFT_PH, { nope: 1 }), /\[lite-adaptive\].*nope/);
    assert.throws(() => new DriftDetector(DRIFT_PH, 42), /\[lite-adaptive\]/);
    assert.throws(() => new DriftDetector(DRIFT_PH, null), /\[lite-adaptive\]/);
    assert.doesNotThrow(() => new DriftDetector(DRIFT_PH, {}));
    assert.doesNotThrow(() => new DriftDetector(DRIFT_PH, undefined));
});

test('constructor validates delta (>= 0) and threshold (> 0) fail-closed', () => {
    for (const bad of [-0.1, NaN, Infinity, -Infinity, '0.1', null, {}, 1n, 1e151]) {
        assert.throws(() => new DriftDetector(DRIFT_CUSUM, { target: 0, delta: bad }), /\[lite-adaptive\]/, 'delta=' + String(bad));
    }
    for (const bad of [0, -1, NaN, Infinity, -Infinity, '5', null, {}, 1n]) {
        assert.throws(() => new DriftDetector(DRIFT_CUSUM, { target: 0, threshold: bad }), /\[lite-adaptive\]/, 'threshold=' + String(bad));
    }
    // delta = 0 is a VALID, meaningful setting (null is not zero -- it must NOT be treated as falsy).
    assert.doesNotThrow(() => new DriftDetector(DRIFT_PH, { delta: 0 }));
    assert.equal(new DriftDetector(DRIFT_PH, { delta: 0 }).delta, 0);
    assert.doesNotThrow(() => new DriftDetector(DRIFT_CUSUM, { target: 0, delta: 0, threshold: 10 }));
});

test('DRIFT_CUSUM REQUIRES a finite target (fail-closed, no silent default)', () => {
    assert.throws(() => new DriftDetector(DRIFT_CUSUM), /\[lite-adaptive\].*target/, 'CUSUM without options throws');
    assert.throws(() => new DriftDetector(DRIFT_CUSUM, {}), /\[lite-adaptive\].*target/, 'CUSUM without target throws');
    assert.throws(() => new DriftDetector(DRIFT_CUSUM, { threshold: 5 }), /\[lite-adaptive\].*target/);
    // a non-finite / out-of-domain target is rejected.
    for (const bad of [NaN, Infinity, -Infinity, '0', null, {}, 1n, 1e151, -1e151]) {
        assert.throws(() => new DriftDetector(DRIFT_CUSUM, { target: bad }), /\[lite-adaptive\]/, 'target=' + String(bad));
    }
    // a finite target of ANY sign is accepted; target = 0 is VALID (null is not zero).
    assert.doesNotThrow(() => new DriftDetector(DRIFT_CUSUM, { target: 0 }));
    assert.equal(new DriftDetector(DRIFT_CUSUM, { target: 0 }).target, 0);
    assert.equal(new DriftDetector(DRIFT_CUSUM, { target: -12.5 }).target, -12.5);
    assert.equal(new DriftDetector(DRIFT_CUSUM, { target: 1e150 }).target, 1e150);
});

test('DRIFT_PH FORBIDS target (fail-closed, no silent ignore)', () => {
    for (const t of [0, 5, -3.2, 1e150]) {
        assert.throws(() => new DriftDetector(DRIFT_PH, { target: t }), /\[lite-adaptive\].*target/, 'PH target=' + String(t));
    }
    // PH's target getter is undefined (it has no fixed reference).
    assert.equal(new DriftDetector(DRIFT_PH).target, undefined);
});

test('getters expose the config + defaults; never throw on empty (return 0)', () => {
    const dd = new DriftDetector(DRIFT_PH);
    assert.equal(dd.mode, DRIFT_PH);
    assert.equal(dd.delta, 0.005);       // documented default
    assert.equal(dd.threshold, 50);      // documented default
    assert.equal(dd.target, undefined);  // PH has no fixed target
    assert.equal(dd.count, 0);
    assert.equal(dd.mean, 0);            // 0 on empty, no throw
    assert.equal(dd.statistic, 0);       // 0 on empty, no throw
    const dc = new DriftDetector(DRIFT_CUSUM, { delta: 0.02, threshold: 7, target: 3 });
    assert.equal(dc.mode, DRIFT_CUSUM);
    assert.equal(dc.delta, 0.02);
    assert.equal(dc.threshold, 7);
    assert.equal(dc.target, 3);
});

test('add rejects a non-finite / out-of-domain x fail-closed (byte-identical no-op)', () => {
    for (const [name, mode] of MODES) {
        const dd = newDD(mode, { threshold: 5 });
        dd.add(1); dd.add(2); dd.add(3);
        const n = dd.count, m = dd.mean, s = dd.statistic;
        for (const bad of [NaN, Infinity, -Infinity, '2', null, undefined, {}, 5n, 1e151, -1e151]) {
            assert.throws(() => dd.add(bad), /\[lite-adaptive\]/, name + ' x=' + String(bad));
        }
        // nothing moved: a rejected add accumulated nothing.
        assert.equal(dd.count, n, name + ' count unchanged after a rejected add');
        assert.equal(dd.mean, m, name + ' mean unchanged after a rejected add');
        assert.equal(dd.statistic, s, name + ' statistic unchanged after a rejected add');
    }
});

test('add accepts the DD_X_MAX boundary (1e150) and rejects just beyond it', () => {
    for (const [name, mode] of MODES) {
        const dd = newDD(mode, { threshold: 1e300 });
        assert.doesNotThrow(() => { dd.add(1e150); dd.add(-1e150); }, name + ' boundary |x| == 1e150 is in-domain');
        assert.throws(() => dd.add(1e150 * 1.001), /\[lite-adaptive\]/, name + ' just beyond DD_X_MAX rejected');
        assert.throws(() => dd.add(-(1e150 * 1.001)), /\[lite-adaptive\]/, name);
    }
});

test('PH detects a known upward AND downward mean shift', () => {
    const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 });
    const r = mulberry32(42);
    let up = -1, down = -1;
    for (let i = 0; i < 3000; i++) {
        const mu = i < 1000 ? 0 : i < 2000 ? 5 : 0;   // up at 1000, down at 2000
        const cut = dd.add(mu + (r() - 0.5) * 0.2);
        if (cut && i >= 1000 && i < 2000 && up < 0) up = i - 1000;
        if (cut && i >= 2000 && down < 0) down = i - 2000;
    }
    assert.ok(up >= 0 && up < 500, 'PH must detect the upward shift with short latency, got ' + up);
    assert.ok(down >= 0 && down < 500, 'PH must detect the downward shift with short latency, got ' + down);
});

test('CUSUM (fixed target = in-control mean) detects a known upward AND downward mean shift', () => {
    // target = 0 = the in-control mean. A DEPARTURE from mu0 in EITHER direction fires; returning to
    // mu0 is "in control" (no fire -- correct SPC semantics). So the stream departs UP (+5) then DOWN
    // (-5) relative to the fixed target.
    const dd = new DriftDetector(DRIFT_CUSUM, { delta: 0.005, threshold: 5, target: 0 });
    const r = mulberry32(43);
    let up = -1, down = -1;
    for (let i = 0; i < 3000; i++) {
        const mu = i < 1000 ? 0 : i < 2000 ? 5 : -5;   // in-control, +departure, -departure
        const cut = dd.add(mu + (r() - 0.5) * 0.2);
        if (cut && i >= 1000 && i < 2000 && up < 0) up = i - 1000;
        if (cut && i >= 2000 && down < 0) down = i - 2000;
    }
    assert.ok(up >= 0 && up < 500, 'CUSUM must detect the upward departure from mu0 with short latency, got ' + up);
    assert.ok(down >= 0 && down < 500, 'CUSUM must detect the downward departure from mu0 with short latency, got ' + down);
});

test('modes DIVERGE on a slow ramp (PH adaptive stays quiet; CUSUM vs fixed mu0 accumulates + fires)', () => {
    // A slow linear ramp of the mean from 0 upward. PH's ONLINE reference tracks the ramp and stays
    // (mostly) quiet; CUSUM's FIXED target mu0 = 0 sees an ever-growing departure and fires constantly.
    // If the modes were the identical statistic (the qa defect), these counts would match -- they must not.
    const ph = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 });
    const cu = new DriftDetector(DRIFT_CUSUM, { delta: 0.005, threshold: 5, target: 0 });
    const rp = mulberry32(1), rc = mulberry32(1);   // identical stream
    let phFires = 0, cuFires = 0;
    for (let i = 0; i < 20000; i++) {
        const base = i * 0.002;   // ramp 0 -> 40 over 20k items
        if (ph.add(base + (rp() - 0.5) * 0.1)) phFires++;
        if (cu.add(base + (rc() - 0.5) * 0.1)) cuFires++;
    }
    assert.notEqual(phFires, cuFires, 'PH and CUSUM must fire differently (the mode is load-bearing)');
    assert.ok(cuFires > phFires * 5,
        'CUSUM (fixed mu0) must fire far more than PH (adaptive) on a ramp: PH=' + phFires + ' CUSUM=' + cuFires);
});

test('a stationary stream does not false-alarm excessively', () => {
    for (const [name, mode] of MODES) {
        const dd = newDD(mode, { delta: 0.01, threshold: 5 });   // CUSUM target = 0 = the noise mean
        const r = mulberry32(7);
        let fa = 0;
        const N = 50000;
        for (let i = 0; i < N; i++) if (dd.add((r() - 0.5) * 0.5)) fa++;
        assert.ok(fa / N < 0.001, name + ' stationary false-alarm rate too high: ' + (fa / N));
    }
});

test('detection RESETS so a SECOND shift is caught', () => {
    for (const [name, mode] of MODES) {
        const dd = newDD(mode, { delta: 0.005, threshold: 5 });   // CUSUM target = 0
        const r = mulberry32(99);
        let first = -1, second = -1;
        // depart UP (+8) then DOWN (-8) -- two genuine departures from mu0 (works for CUSUM's fixed
        // reference too); the second detection requires a working reset after the first.
        for (let i = 0; i < 3000; i++) {
            const mu = i < 1000 ? 0 : i < 2000 ? 8 : -8;
            const cut = dd.add(mu + (r() - 0.5) * 0.2);
            if (cut && i >= 1000 && i < 2000 && first < 0) first = i;
            if (cut && i >= 2000 && second < 0) second = i;
        }
        assert.ok(first >= 1000, name + ' first shift detected');
        assert.ok(second >= 2000, name + ' second shift detected -> reset works, got ' + second);
        assert.ok(dd.count < 3000, name + ' a reset restarted the item count, got ' + dd.count);
    }
});

test('count / mean / statistic track the current (post-reset) segment', () => {
    for (const [name, mode] of MODES) {
        // CUSUM target = 10 = the constant, so the constant stream is exactly in-control (no drift).
        const dd = newDD(mode, { delta: 0.005, threshold: 50, target: mode === DRIFT_CUSUM ? 10 : undefined });
        for (let i = 0; i < 500; i++) dd.add(10);   // constant, no drift
        assert.equal(dd.count, 500, name + ' count == items seen');
        assert.ok(Math.abs(dd.mean - 10) < 1e-9, name + ' mean of a constant stream is the constant, got ' + dd.mean);
        assert.ok(dd.statistic >= 0, name + ' statistic is non-negative');
        assert.ok(dd.statistic < dd.threshold, name + ' a constant stream stays below threshold');
    }
});

test('statistic / mean throw fail-closed on a poisoned (non-finite) accumulator', () => {
    // DD_X_MAX makes overflow unreachable via the public API, so poison a field directly to prove
    // the defense-in-depth guard (mirrors ADWIN / ForwardDecay _guardFinite).
    for (const field of ['_gP', '_gN', '_mMin', '_mMax', '_mean']) {
        const dd = new DriftDetector(DRIFT_PH, { threshold: 5 });
        dd.add(1); dd.add(2);
        dd[field] = Infinity;
        assert.throws(() => dd.statistic, /\[lite-adaptive\]/, 'statistic throws on poisoned ' + field);
        assert.throws(() => dd.mean, /\[lite-adaptive\]/, 'mean throws on poisoned ' + field);
    }
    // NaN poison too.
    const dd = new DriftDetector(DRIFT_CUSUM, { threshold: 5, target: 0 });
    dd.add(1);
    dd._gP = NaN;
    assert.throws(() => dd.statistic, /\[lite-adaptive\]/);
});

test('clear resets all scalar state (but keeps target); instance reused and usable again', () => {
    for (const [name, mode] of MODES) {
        const dd = newDD(mode, { delta: 0.005, threshold: 5 });   // CUSUM target = 0
        const r = mulberry32(5);
        for (let i = 0; i < 2000; i++) dd.add((i < 1000 ? 0 : 10) + r());
        const ret = dd.clear();
        assert.equal(ret, dd, name + ' clear is chainable (returns this)');
        assert.equal(dd.count, 0);
        assert.equal(dd.mean, 0);
        assert.equal(dd.statistic, 0);
        // usable again + config (incl. target) preserved
        assert.equal(dd.delta, 0.005);
        assert.equal(dd.threshold, 5);
        assert.equal(dd.target, mode === DRIFT_CUSUM ? 0 : undefined, name + ' clear keeps the target (config)');
        dd.add(1); dd.add(2);
        assert.equal(dd.count, 2);
    }
});

test('addFrom is exact parity with add (same detections, same running state)', () => {
    for (const [name, mode] of MODES) {
        const a = newDD(mode, { delta: 0.005, threshold: 5 });
        const b = newDD(mode, { delta: 0.005, threshold: 5 });
        const buf = new Float64Array(1);
        const r1 = mulberry32(2024), r2 = mulberry32(2024);   // identical streams
        for (let i = 0; i < 3000; i++) {
            const mu = i < 1000 ? 0 : i < 2000 ? 5 : 0;
            const x1 = mu + (r1() - 0.5) * 0.2;
            const x2 = mu + (r2() - 0.5) * 0.2;
            const ca = a.add(x1);
            buf[0] = x2;
            const cb = b.addFrom(buf, 0);
            assert.equal(cb, ca, name + ' addFrom drift flag matches add at i=' + i);
        }
        assert.equal(b.count, a.count, name + ' addFrom count matches add');
        assert.equal(b.mean, a.mean, name + ' addFrom mean matches add');
        assert.equal(b.statistic, a.statistic, name + ' addFrom statistic matches add');
    }
});

test('addFrom rejects a bad buffer / index fail-closed (byte-identical no-op)', () => {
    const dd = new DriftDetector(DRIFT_PH, { threshold: 5 });
    dd.add(1);
    const n = dd.count, m = dd.mean;
    const buf = new Float64Array([3.14]);
    for (const badBuf of [[3.14], null, undefined, {}, new Int32Array([1])]) {
        assert.throws(() => dd.addFrom(badBuf, 0), /\[lite-adaptive\]/, 'buf=' + String(badBuf));
    }
    for (const badI of [-1, 1, 1.5, NaN, '0', null, undefined, {}]) {
        assert.throws(() => dd.addFrom(buf, badI), /\[lite-adaptive\]/, 'i=' + String(badI));
    }
    // a NaN / out-of-domain value in the buffer is also rejected (byte-identical no-op).
    assert.throws(() => dd.addFrom(new Float64Array([NaN]), 0), /\[lite-adaptive\]/);
    assert.throws(() => dd.addFrom(new Float64Array([1e151]), 0), /\[lite-adaptive\]/);
    assert.equal(dd.count, n, 'count unchanged after a rejected addFrom');
    assert.equal(dd.mean, m, 'mean unchanged after a rejected addFrom');
});

test('a larger shift is detected no slower than a smaller one', () => {
    for (const [name, mode] of MODES) {
        function latency(shift, seed) {
            const dd = newDD(mode, { delta: 0.005, threshold: 20 });   // CUSUM target = 0
            const r = mulberry32(seed);
            const CP = 5000;
            for (let i = 0; i < CP; i++) dd.add((r() - 0.5) * 0.2);
            for (let j = 0; j < 100000; j++) if (dd.add(shift + (r() - 0.5) * 0.2)) return j;
            return Infinity;
        }
        const small = latency(0.5, 11);
        const large = latency(5, 11);
        assert.ok(Number.isFinite(small), name + ' a small shift is eventually detected, got ' + small);
        assert.ok(Number.isFinite(large), name + ' a large shift is detected, got ' + large);
        assert.ok(large <= small, name + ' a larger shift should detect no slower: large ' + large + ' vs small ' + small);
    }
});

// ===========================================================================
// S9 -- the `latch` option (1.8.0): fire ONCE per regime + hysteresis re-arm,
// with `lastDriftIndex` / `lastDirection` getters (ADR 0007 amendment).
// ===========================================================================

test('the latch option door rejects a non-boolean (typeof-first, no truthy coercion)', () => {
    for (const bad of [1, 0, 'true', 'false', null, {}, []]) {
        assert.throws(() => new DriftDetector(DRIFT_PH, { latch: bad }), /\[lite-adaptive\]/, 'latch=' + String(bad));
    }
    // undefined -> the false default (no throw), and an explicit boolean is accepted.
    assert.equal(new DriftDetector(DRIFT_PH, { latch: undefined }).latch, false);
    assert.equal(new DriftDetector(DRIFT_PH, { latch: true }).latch, true);
    assert.equal(new DriftDetector(DRIFT_PH, { latch: false }).latch, false);
});

test('latch defaults to false, and latched/lastDriftIndex/lastDirection start unlatched + NaN (null is not zero)', () => {
    for (const [name, mode] of MODES) {
        const dd = newDD(mode);
        assert.equal(dd.latch, false, name + ' latch default');
        assert.equal(dd.latched, false, name + ' not latched before any fire');
        assert.ok(Number.isNaN(dd.lastDriftIndex), name + ' lastDriftIndex NaN before any fire');
        assert.ok(Number.isNaN(dd.lastDirection), name + ' lastDirection NaN before any fire');
        // a non-firing add leaves the getters NaN (a fire is what populates them).
        dd.add(0);
        assert.ok(Number.isNaN(dd.lastDriftIndex), name + ' lastDriftIndex still NaN with no fire');
        assert.ok(Number.isNaN(dd.lastDirection), name + ' lastDirection still NaN with no fire');
    }
});

test('CUSUM latch: a sustained +10 step fires EXACTLY once, latches, and records index 0 / direction +1', () => {
    const dd = new DriftDetector(DRIFT_CUSUM, { target: 0, delta: 0.5, threshold: 8, latch: true });
    let fires = 0;
    for (let i = 0; i < 5000; i++) if (dd.add(10)) fires++;
    assert.equal(fires, 1, 'exactly one fire on a sustained regime');
    assert.equal(dd.lastDriftIndex, 0, 'fired on the first item');
    assert.equal(dd.lastDirection, 1, 'upward direction');
    assert.equal(dd.latched, true, 'stays latched through the sustained regime');
});

test('CUSUM latch:false on the same +10 step re-fires every item (the 1.x discipline is unchanged)', () => {
    const dd = new DriftDetector(DRIFT_CUSUM, { target: 0, delta: 0.5, threshold: 8 });
    let fires = 0;
    for (let i = 0; i < 5000; i++) if (dd.add(10)) fires++;
    assert.equal(fires, 5000, 'unlatched CUSUM re-fires on every sustained item');
});

test('CUSUM latch: an opposite-direction regime re-fires immediately and flips direction', () => {
    const dd = new DriftDetector(DRIFT_CUSUM, { target: 0, delta: 0.5, threshold: 8, latch: true });
    const fires = [];
    for (let i = 0; i < 5000; i++) {
        const x = i < 2500 ? 10 : -10;
        if (dd.add(x)) fires.push({ i, idx: dd.lastDriftIndex, dir: dd.lastDirection });
    }
    assert.equal(fires.length, 2, 'exactly two fires: one per regime');
    assert.deepEqual(fires[0], { i: 0, idx: 0, dir: 1 }, 'first fire: index 0, up');
    assert.deepEqual(fires[1], { i: 2500, idx: 2500, dir: -1 }, 'second fire on the reversal item, down');
    assert.equal(dd.latched, true);
    assert.equal(dd.lastDirection, -1, 'now latched downward');
});

test('CUSUM latch: a stationary stream never fires and leaves the getters NaN, latched false', () => {
    for (const latch of [false, true]) {
        const dd = new DriftDetector(DRIFT_CUSUM, { target: 0, delta: 0.5, threshold: 8, latch });
        let fires = 0;
        for (let i = 0; i < 5000; i++) if (dd.add(0)) fires++;
        assert.equal(fires, 0, 'latch=' + latch + ' no false alarm on x=0');
        assert.ok(Number.isNaN(dd.lastDriftIndex), 'latch=' + latch + ' lastDriftIndex NaN');
        assert.equal(dd.latched, false, 'latch=' + latch + ' not latched');
    }
});

test('latch: clear() re-arms and resets both getters to NaN', () => {
    const dd = new DriftDetector(DRIFT_CUSUM, { target: 0, delta: 0.5, threshold: 8, latch: true });
    dd.add(10);
    assert.equal(dd.latched, true);
    assert.equal(dd.lastDriftIndex, 0);
    assert.equal(dd.lastDirection, 1);
    const ret = dd.clear();
    assert.equal(ret, dd, 'clear() returns this');
    assert.equal(dd.latched, false, 're-armed after clear()');
    assert.ok(Number.isNaN(dd.lastDriftIndex), 'lastDriftIndex NaN after clear()');
    assert.ok(Number.isNaN(dd.lastDirection), 'lastDirection NaN after clear()');
    // and it fires cleanly again from a fresh regime.
    let fires = 0;
    for (let i = 0; i < 100; i++) if (dd.add(10)) fires++;
    assert.equal(fires, 1, 'fires once again after clear()');
    assert.equal(dd.lastDriftIndex, 0, 'the item index restarts from 0 after clear()');
});

test('latch: the threshold/2 hysteresis boundary -- just above stays latched, just below re-arms', () => {
    // threshold 8 -> half 4; delta 0, target 0 so the CUSUM gap tracks gP exactly (clamped to 8 on latch).
    function afterLatch(erode) {
        const dd = new DriftDetector(DRIFT_CUSUM, { target: 0, delta: 0, threshold: 8, latch: true });
        dd.add(10);            // fire + latch, gP clamped to 8
        dd.add(erode);         // gP := 8 + erode; erode is negative so the latched gap shrinks toward half
        return dd.latched;
    }
    assert.equal(afterLatch(-3.9), true, 'gap 4.1 (> half 4) stays latched');
    assert.equal(afterLatch(-4.0), true, 'gap 4.0 (== half) is NOT below half -> stays latched');
    assert.equal(afterLatch(-4.1), false, 'gap 3.9 (< half 4) re-arms');
});

test('latch: a genuinely NEW same-direction shift after a re-arm fires again', () => {
    // delta 3 keeps the opposite accumulator floored while gP is eroded, so the re-arm is clean
    // (no spurious opposite fire) and the second + shift is a fresh arming->latched fire.
    const dd = new DriftDetector(DRIFT_CUSUM, { target: 0, delta: 3, threshold: 8, latch: true });
    const fires = [];
    // idx 0: +20 fires up + latches. idx 1: -2 erodes gP to 3 (< half 4) -> re-arm, no fire.
    // idx 2..4: 0 keeps it armed. idx 5: +20 is a fresh same-direction shift -> fires up again.
    const stream = [20, -2, 0, 0, 0, 20];
    for (let i = 0; i < stream.length; i++) if (dd.add(stream[i])) fires.push({ idx: dd.lastDriftIndex, dir: dd.lastDirection });
    assert.equal(fires.length, 2, 'two fires: the original and the post-re-arm same-direction shift');
    assert.deepEqual(fires[0], { idx: 0, dir: 1 });
    assert.deepEqual(fires[1], { idx: 5, dir: 1 }, 'the second fire is a genuinely new + shift after re-arm');
});

test('PH latch: a step up fires EXACTLY once, at the same item as the latch:false twin', () => {
    function phStep(latch) {
        const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 50, latch });
        const fires = [];
        for (let i = 0; i < 5000; i++) if (dd.add(i < 2500 ? 0 : 10)) fires.push(i);
        return fires;
    }
    const off = phStep(false);
    const on = phStep(true);
    assert.equal(off.length, 1, 'PH already fires once on a clean step (mean re-tracks after the reset)');
    assert.equal(on.length, 1, 'latch:true fires exactly once');
    const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 50, latch: true });
    for (let i = 0; i < 5000; i++) dd.add(i < 2500 ? 0 : 10);
    assert.equal(dd.lastDriftIndex, off[0], 'latch:true lastDriftIndex equals the latch:false first-fire index');
    assert.equal(dd.lastDirection, 1, 'the step is upward');
});

test('PH latch: a slow ramp fires strictly fewer times than unlatched', () => {
    function phRamp(latch) {
        const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 50, latch });
        let f = 0;
        for (let i = 0; i < 5000; i++) if (dd.add(i * 0.05)) f++;
        return f;
    }
    const off = phRamp(false);
    const on = phRamp(true);
    assert.ok(off > 1, 'the unlatched detector re-fires on the ramp, got ' + off);
    assert.ok(on < off, 'latch:true fires strictly fewer, got ' + on + ' vs ' + off);
});

test('latch: a sustained regime never lets the latched gap dip under threshold/2 (no spurious re-arm)', () => {
    // 20k sustained +items: the clamp holds the gap at threshold each item, so it stays latched
    // and fires exactly once -- proof the clamp keeps state bounded.
    const dd = new DriftDetector(DRIFT_CUSUM, { target: 0, delta: 0.5, threshold: 8, latch: true });
    let fires = 0;
    for (let i = 0; i < 20000; i++) if (dd.add(10)) fires++;
    assert.equal(fires, 1, 'one fire across a long sustained regime');
    assert.equal(dd.latched, true, 'still latched');
    // The clamp pins the sustained gap at EXACTLY threshold -- not merely "finite". A no-clamp variant
    // drives the statistic unbounded (NoClampDD measured 47500 here), so === threshold has teeth.
    assert.equal(dd.statistic, 8, 'the sustained latched statistic sits at exactly threshold (clamped, bounded)');
});

test('latch: a GRADUAL return to baseline re-arms, so a later same-direction regime fires again [0, 5100]', () => {
    // The F-latch-rearm regression guard. +10 x100 (fire + latch at 0), 0 x5000 (a gradual decay of
    // the latched gap toward baseline -> the gap falls under threshold/2 and RE-ARMS), +10 x100 (a
    // genuine NEW same-direction regime -> a second fire at 5100). The pre-fix code re-inflated the
    // shrinking gap to threshold every latched item, so it NEVER re-armed: 1 fire, statistic stuck at 8.
    const dd = new DriftDetector(DRIFT_CUSUM, { target: 0, delta: 0.5, threshold: 8, latch: true });
    const fires = [];
    let i = 0;
    for (let k = 0; k < 100; k++, i++) if (dd.add(10)) fires.push(i);
    for (let k = 0; k < 5000; k++, i++) if (dd.add(0)) fires.push(i);
    for (let k = 0; k < 100; k++, i++) if (dd.add(10)) fires.push(i);
    assert.deepEqual(fires, [0, 5100], 'exactly 2 fires: the first regime and the post-re-arm second one');
    assert.equal(dd.lastDirection, 1, 'both fires are upward');
});

test('PH latch: a sharp REVERSAL after a re-arm is reported with the correct direction (F-ph-latch-rearm)', () => {
    // The re-arm KEEPS the running-mean reference (_n / _mean survive), so the reversal accumulates
    // against the true online mean and fires with the correct direction. The pre-fix re-arm called
    // _reset(), which zeroed _n / _mean; the new post-shift level silently became the reference and the
    // reversal was NEVER reported (a fail-open latch). Ground truth from the true step edges:
    //   0x2000 / +10x2000 / -10x2000 -> up-fire on entering +10 (edge 2000), down-fire on the reversal
    //   into -10 (edge 4000): EXACTLY 2 fires, dirs +1 then -1.
    const L = 2000;
    function runPH(stream) {
        const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 50, latch: true });
        const fires = [];
        for (let i = 0; i < stream.length; i++) if (dd.add(stream[i])) fires.push({ i, dir: dd.lastDirection });
        return fires;
    }
    const seg = (v, n) => Array(n).fill(v);
    // (a) 0 / +10 / -10 : up then down reversal.
    const upDown = runPH([...seg(0, L), ...seg(10, L), ...seg(-10, L)]);
    assert.equal(upDown.length, 2, 'up then a reversal: exactly 2 fires (the reversal is reported)');
    assert.equal(upDown[0].dir, 1, 'fire#1 is upward');
    assert.ok(upDown[0].i >= 2000 && upDown[0].i < 2020, 'fire#1 lands on the +10 edge [2000,2020), got ' + upDown[0].i);
    assert.equal(upDown[1].dir, -1, 'fire#2 (the reversal) is downward');
    assert.ok(upDown[1].i >= 4000 && upDown[1].i < 4020, 'fire#2 lands on the -10 edge [4000,4020), got ' + upDown[1].i);
    // (b) 0 / +10 / -30 : a sharper reversal still fires down (edge 4000).
    const upDownBig = runPH([...seg(0, L), ...seg(10, L), ...seg(-30, L)]);
    assert.equal(upDownBig.length, 2, '0/10/-30: 2 fires');
    assert.deepEqual([upDownBig[0].dir, upDownBig[1].dir], [1, -1], '0/10/-30 dirs are +1 then -1');
    assert.ok(upDownBig[1].i >= 4000 && upDownBig[1].i < 4020, '0/10/-30 reversal on the -30 edge, got ' + upDownBig[1].i);
    // (c) 0 / -10 / +10 : the mirror -- down then an up reversal.
    const downUp = runPH([...seg(0, L), ...seg(-10, L), ...seg(10, L)]);
    assert.equal(downUp.length, 2, '0/-10/+10: 2 fires');
    assert.deepEqual([downUp[0].dir, downUp[1].dir], [-1, 1], '0/-10/+10 dirs are -1 then +1');
    assert.ok(downUp[0].i >= 2000 && downUp[0].i < 2020, '0/-10/+10 fire#1 on the -10 edge, got ' + downUp[0].i);
    assert.ok(downUp[1].i >= 4000 && downUp[1].i < 4020, '0/-10/+10 reversal on the +10 edge, got ' + downUp[1].i);
});

test('PH latch: a reversal TOWARD the running mean fires, and the delay does NOT grow with history (F-ph-latch)', () => {
    // The PH reference is reset AT the fire (1.x discipline), so after the up-fire the reference restarts
    // from the shifted level (10). A shift TOWARD a level (5) near the mean-since-clear() is therefore a
    // reportable down-move -- the pre-fix code (which kept the reference across the fire) left the PH
    // reference at the whole-history mean, so a shift toward it was swallowed and the delay grew without
    // bound with history. Ground truth from the true step edges.
    function runPH(stream) {
        const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 50, latch: true });
        const fires = [];
        for (let i = 0; i < stream.length; i++) if (dd.add(stream[i])) fires.push({ i, dir: dd.lastDirection });
        return fires;
    }
    const seg = (v, n) => Array(n).fill(v);
    // (a) 0 / +10 / +5 (L=2000): up-fire on the +10 edge (2000), down-fire on the 10->5 reversal (4000).
    const shortR = runPH([...seg(0, 2000), ...seg(10, 2000), ...seg(5, 2000)]);
    assert.equal(shortR.length, 2, '0/10/5: 2 fires (the shift toward the mean is reported)');
    assert.deepEqual([shortR[0].dir, shortR[1].dir], [1, -1], '0/10/5 dirs are +1 then -1');
    assert.ok(shortR[0].i >= 2000 && shortR[0].i < 2020, '0/10/5 fire#1 on the +10 edge, got ' + shortR[0].i);
    assert.ok(shortR[1].i >= 4000 && shortR[1].i < 4020, '0/10/5 reversal on the 10->5 edge [4000,4020), got ' + shortR[1].i);
    // (b) 0 / +10 / +5 with L=100000: the down-fire STILL lands on the true reversal edge (200000), proving
    // the delay is bounded by the step geometry, NOT by how long the up-regime ran.
    const HL = 100000;
    const longR = runPH([...seg(0, HL), ...seg(10, HL), ...seg(5, HL)]);
    assert.equal(longR.length, 2, '0x100k/10x100k/5x100k: 2 fires even after a long up-regime');
    assert.deepEqual([longR[0].dir, longR[1].dir], [1, -1], 'long-history dirs are +1 then -1');
    assert.ok(longR[0].i >= 100000 && longR[0].i < 100020, 'long-history fire#1 on the +10 edge, got ' + longR[0].i);
    assert.ok(longR[1].i >= 200000 && longR[1].i < 200020, 'long-history reversal on the true edge [200000,200020), got ' + longR[1].i);
});
