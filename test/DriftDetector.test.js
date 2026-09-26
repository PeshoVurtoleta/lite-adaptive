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
    assert.equal(VERSION, '1.7.0');
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
