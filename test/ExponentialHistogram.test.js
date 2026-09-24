// @zakkster/lite-adaptive -- ExponentialHistogram behavioral + fail-closed suite (node:test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExponentialHistogram, VERSION } from '../Adaptive.js';

test('VERSION is the expected string', () => {
    assert.equal(VERSION, '1.1.0');
});

test('constructor validates W fail-closed BEFORE allocation', () => {
    for (const bad of [0, -1, -0.5, NaN, Infinity, -Infinity, '10', null, undefined, {}, 10n]) {
        assert.throws(() => new ExponentialHistogram(bad, 0.1), /\[lite-adaptive\]/, 'W=' + String(bad));
    }
    // a valid W does not throw
    assert.doesNotThrow(() => new ExponentialHistogram(1000, 0.1));
    assert.doesNotThrow(() => new ExponentialHistogram(1.5, 0.1)); // fractional ms window is legal
});

test('constructor validates epsilon fail-closed', () => {
    for (const bad of [0, 1, 1.5, -0.1, NaN, Infinity, '0.1', null, undefined, {}]) {
        assert.throws(() => new ExponentialHistogram(1000, bad), /\[lite-adaptive\]/, 'eps=' + String(bad));
    }
    assert.doesNotThrow(() => new ExponentialHistogram(1000, 0.5));
    assert.doesNotThrow(() => new ExponentialHistogram(1000, 0.001));
});

test('constructor rejects an unknown option with a message, non-object options', () => {
    assert.throws(() => new ExponentialHistogram(1000, 0.1, { nope: 1 }), /\[lite-adaptive\].*nope/);
    assert.throws(() => new ExponentialHistogram(1000, 0.1, 42), /\[lite-adaptive\]/);
    assert.throws(() => new ExponentialHistogram(1000, 0.1, null), /\[lite-adaptive\]/);
    assert.doesNotThrow(() => new ExponentialHistogram(1000, 0.1, {}));
    assert.doesNotThrow(() => new ExponentialHistogram(1000, 0.1, undefined));
});

test('CAP / k / levels match the settled formulas', () => {
    const cases = [
        [64, 0.5, 2, 7, 23], [64, 0.1, 6, 6, 44], [64, 0.01, 51, 3, 158],
        [1000, 0.5, 2, 11, 35], [1000, 0.1, 6, 10, 72], [1000, 0.01, 51, 7, 366],
        [65536, 0.5, 2, 17, 53], [65536, 0.1, 6, 16, 114], [65536, 0.01, 51, 13, 678],
    ];
    for (const [W, eps, k, levels, cap] of cases) {
        const eh = new ExponentialHistogram(W, eps);
        assert.equal(eh.k, k, 'k for W=' + W + ' eps=' + eps);
        assert.equal(eh.levels, levels, 'levels for W=' + W + ' eps=' + eps);
        assert.equal(eh.capacity, cap, 'cap for W=' + W + ' eps=' + eps);
    }
});

test('getters read back the shape', () => {
    const eh = new ExponentialHistogram(1000, 0.1);
    assert.equal(eh.windowSize, 1000);
    assert.equal(eh.epsilon, 0.1);
    assert.equal(eh.bucketCount, 0);
    assert.equal(eh.mode, 'unset');
});

test('queries never throw on an empty histogram; return 0', () => {
    const eh = new ExponentialHistogram(1000, 0.1);
    assert.equal(eh.count(), 0);
    assert.equal(eh.sum(), 0);
    assert.equal(eh.query(), 0);
});

test('count mode: not-yet-full window is estimated EXACTLY', () => {
    const eh = new ExponentialHistogram(1000, 0.01);
    for (let i = 0; i < 500; i++) eh.add();       // 500 < W=1000 -> nothing expired -> exact
    assert.equal(eh.mode, 'count');
    assert.equal(eh.count(), 500);
    assert.equal(eh.query(), 500);
});

test('count mode: full window count is within epsilon of W on every query', () => {
    const W = 1000, eps = 0.01;
    const eh = new ExponentialHistogram(W, eps);
    const ring = new Float64Array(W);
    let head = 0, live = 0;
    for (let i = 1; i <= 5 * W; i++) {
        eh.add();
        // exact ring oracle of the last W ticks
        if (live === W) { live--; }
        ring[head] = i; head = (head + 1) % W; live++;
        if (i >= W) {
            const exact = W;   // one element per tick, window exactly W
            const est = eh.count();
            const rel = Math.abs(est - exact) / exact;
            assert.ok(rel <= eps, 'rel ' + rel + ' > eps at i=' + i + ' est=' + est);
        }
        assert.ok(eh.bucketCount <= eh.capacity, 'bucket overflow at i=' + i);
    }
});

test('sum mode: windowed sum tracks the exact ring within epsilon', () => {
    const W = 512, eps = 0.05;
    const eh = new ExponentialHistogram(W, eps);
    const ring = new Float64Array(W);
    let idx = 0, filled = 0, ringSum = 0;
    for (let i = 1; i <= 4 * W; i++) {
        const v = 1 + (i % 7);       // values 1..7
        eh.add(i, v);                // explicit-time mode
        if (filled === W) ringSum -= ring[idx]; else filled++;
        ring[idx] = v; idx = (idx + 1) % W; ringSum += v;
        if (i >= W) {
            const est = eh.sum();
            const rel = Math.abs(est - ringSum) / ringSum;
            assert.ok(rel <= eps, 'sum rel ' + rel + ' > eps at i=' + i);
        }
    }
});

test('explicit mode: monotone now is enforced; a decrease throws', () => {
    const eh = new ExponentialHistogram(100, 0.1);
    eh.add(10);
    eh.add(10);        // non-decreasing (equal) is allowed
    eh.add(11);
    assert.throws(() => eh.add(10.5), /\[lite-adaptive\].*non-decreasing/);
    // a non-finite now throws
    assert.throws(() => eh.add(NaN), /\[lite-adaptive\]/);
    assert.throws(() => eh.add(Infinity), /\[lite-adaptive\]/);
});

test('mode LOCKS at first add; a switch throws both ways', () => {
    const a = new ExponentialHistogram(100, 0.1);
    a.add(5);                                  // explicit
    assert.equal(a.mode, 'explicit');
    assert.throws(() => a.add(), /\[lite-adaptive\].*locked to explicit/);

    const b = new ExponentialHistogram(100, 0.1);
    b.add();                                   // count
    assert.equal(b.mode, 'count');
    assert.throws(() => b.add(5), /\[lite-adaptive\].*locked to count/);
});

test('add value must be a finite number > 0 (byte-identical no-op on reject)', () => {
    const eh = new ExponentialHistogram(100, 0.1);
    eh.add(1, 3);
    const before = eh.bucketCount;
    for (const bad of [0, -1, NaN, Infinity, '2', null]) {
        assert.throws(() => eh.add(2, bad), /\[lite-adaptive\]/, 'value=' + String(bad));
    }
    assert.equal(eh.bucketCount, before, 'a rejected add opened no bucket');
});

test('a rejected bad-value FIRST add does not lock the mode (byte-identical no-op)', () => {
    // regression: value must be validated BEFORE the mode/time block mutates state.
    const eh = new ExponentialHistogram(1000, 0.1);
    assert.throws(() => eh.add(undefined, -1), /\[lite-adaptive\]/, 'bad value on the first add throws');
    // the instance must NOT be bricked into count mode -- a legit explicit add still works.
    assert.doesNotThrow(() => eh.add(10), 'mode was not locked by the rejected first add');
    assert.equal(eh.count(), 1);
});

test('a rejected bad-value add does not advance the monotone guard (byte-identical no-op)', () => {
    // regression: value reject must not leave _lastNow advanced.
    const eh = new ExponentialHistogram(1000, 0.1);
    eh.add(5);
    assert.throws(() => eh.add(10, -1), /\[lite-adaptive\]/, 'bad value at now=10 throws');
    // _lastNow must still be 5, so a valid now=7 is accepted (would wrongly throw if 10 stuck).
    assert.doesNotThrow(() => eh.add(7), 'monotone guard was not advanced by the rejected add');
});

test('a rejected add opens no bucket and does not advance the count tick', () => {
    const eh = new ExponentialHistogram(100, 0.1);
    eh.add();  // count mode, tick 1
    assert.throws(() => eh.add(5), /\[lite-adaptive\]/);   // mode switch rejected
    eh.add();  // tick 2
    // two accepted count adds -> count 2 (window not full)
    assert.equal(eh.count(), 2);
});

test('clear resets the histogram and unlocks the mode; pool reused', () => {
    const eh = new ExponentialHistogram(1000, 0.01);
    for (let i = 0; i < 2000; i++) eh.add();
    assert.ok(eh.bucketCount > 0);
    eh.clear();
    assert.equal(eh.bucketCount, 0);
    assert.equal(eh.count(), 0);
    assert.equal(eh.mode, 'unset');
    // usable again, and can switch mode after clear
    eh.add(50);
    assert.equal(eh.mode, 'explicit');
    assert.equal(eh.count(), 1);
});

test('count() === sum() when every add uses value=1', () => {
    const eh = new ExponentialHistogram(200, 0.05);
    for (let i = 1; i <= 1000; i++) eh.add(i);   // value defaults to 1
    assert.equal(eh.count(), eh.sum());
});

// --- addFrom: the zero-box packed [now, value] entry -------------------------------------

test('addFrom(buf, i) produces state IDENTICAL to add(now, value) across a stream (parity)', () => {
    const W = 512, eps = 0.05;
    const a = new ExponentialHistogram(W, eps);   // driven by add(now, value)
    const b = new ExponentialHistogram(W, eps);   // driven by addFrom(buf, i)
    const buf = new Float64Array(2);
    let now = 0;
    for (let i = 1; i <= 4 * W; i++) {
        now += 1.5;                                // fractional monotone time
        const v = 0.25 + (i % 7) * 0.5;            // fractional value > 0
        a.add(now, v);
        buf[0] = now; buf[1] = v;
        b.addFrom(buf, 0);
        assert.equal(b.bucketCount, a.bucketCount, 'bucketCount parity at i=' + i);
        assert.equal(b.count(), a.count(), 'count parity at i=' + i);
        assert.equal(b.sum(), a.sum(), 'sum parity at i=' + i);
    }
    assert.equal(b.mode, a.mode);
});

test('addFrom reads the pair at an arbitrary in-bounds base index (batch layout)', () => {
    const a = new ExponentialHistogram(100, 0.1);
    const b = new ExponentialHistogram(100, 0.1);
    const buf = new Float64Array([0, 0, 3.5, 2.5, 4.0, 1.5]);   // pairs at i = 2, 4
    a.add(3.5, 2.5); a.add(4.0, 1.5);
    b.addFrom(buf, 2); b.addFrom(buf, 4);
    assert.equal(b.sum(), a.sum());
    assert.equal(b.count(), a.count());
});

test('addFrom rejects a non-Float64Array buf fail-closed', () => {
    const eh = new ExponentialHistogram(100, 0.1);
    for (const bad of [[1, 2], new Float32Array([1, 2]), null, undefined, {}, 'x', new ArrayBuffer(16)]) {
        assert.throws(() => eh.addFrom(bad, 0), /\[lite-adaptive\]/, 'buf=' + String(bad));
    }
    assert.equal(eh.bucketCount, 0, 'a rejected addFrom opened no bucket');
    assert.equal(eh.mode, 'unset', 'a rejected addFrom did not lock the mode');
});

test('addFrom rejects a bad index (negative, non-integer, i+1 >= length) fail-closed', () => {
    const eh = new ExponentialHistogram(100, 0.1);
    const buf = new Float64Array([1, 2]);
    for (const bad of [-1, 1.5, NaN, '0', 1, 2, 100]) {   // i=1 -> i+1=2 == length; i>=length
        assert.throws(() => eh.addFrom(buf, bad), /\[lite-adaptive\]/, 'i=' + String(bad));
    }
    assert.equal(eh.bucketCount, 0);
    assert.equal(eh.mode, 'unset');
});

test('addFrom with NaN / Infinity in buf[i] or buf[i+1] is a byte-identical no-op', () => {
    const eh = new ExponentialHistogram(100, 0.1);
    const buf = new Float64Array([5, 2]);
    eh.addFrom(buf, 0);                     // one good add -> explicit mode, _lastNow = 5
    const bc = eh.bucketCount, before = eh.count(), lastNow = 5;
    // bad value (buf[i+1])
    buf[0] = 6; buf[1] = NaN;
    assert.throws(() => eh.addFrom(buf, 0), /\[lite-adaptive\]/);
    buf[1] = Infinity;
    assert.throws(() => eh.addFrom(buf, 0), /\[lite-adaptive\]/);
    buf[1] = 0;                             // non-positive rejected too
    assert.throws(() => eh.addFrom(buf, 0), /\[lite-adaptive\]/);
    // bad now (buf[i])
    buf[0] = NaN; buf[1] = 2;
    assert.throws(() => eh.addFrom(buf, 0), /\[lite-adaptive\]/);
    buf[0] = Infinity;
    assert.throws(() => eh.addFrom(buf, 0), /\[lite-adaptive\]/);
    assert.equal(eh.bucketCount, bc, 'bucketCount unchanged');
    assert.equal(eh.count(), before, 'count unchanged');
    // _lastNow not advanced: a valid now just above the last good one is still accepted
    buf[0] = lastNow; buf[1] = 1;
    assert.doesNotThrow(() => eh.addFrom(buf, 0), 'monotone guard not advanced by a rejected addFrom');
});

test('addFrom enforces monotone now: a decreasing buf[i] throws', () => {
    const eh = new ExponentialHistogram(100, 0.1);
    const buf = new Float64Array([10, 1]);
    eh.addFrom(buf, 0);
    buf[0] = 10; eh.addFrom(buf, 0);        // equal is allowed
    buf[0] = 9.5;
    assert.throws(() => eh.addFrom(buf, 0), /\[lite-adaptive\].*non-decreasing/);
});

test('a rejected FIRST addFrom does not lock the mode', () => {
    const eh = new ExponentialHistogram(100, 0.1);
    const buf = new Float64Array([5, -1]);   // bad value on the very first addFrom
    assert.throws(() => eh.addFrom(buf, 0), /\[lite-adaptive\]/);
    assert.equal(eh.mode, 'unset', 'a rejected first addFrom must not lock the mode');
    // still free to choose EITHER mode
    assert.doesNotThrow(() => eh.add());
    assert.equal(eh.mode, 'count');
});

test('addFrom is explicit-time only: a count-locked instance rejects it, an addFrom-locked instance rejects count add()', () => {
    const counted = new ExponentialHistogram(100, 0.1);
    counted.add();                           // locks COUNT mode
    const buf = new Float64Array([5, 1]);
    assert.throws(() => counted.addFrom(buf, 0), /\[lite-adaptive\].*locked to count/);

    const explicit = new ExponentialHistogram(100, 0.1);
    explicit.addFrom(buf, 0);                // locks EXPLICIT mode via addFrom
    assert.equal(explicit.mode, 'explicit');
    assert.throws(() => explicit.add(), /\[lite-adaptive\].*locked to explicit/);
    // and a normal explicit add() interleaves fine with addFrom
    buf[0] = 6;
    assert.doesNotThrow(() => explicit.add(7));
    buf[0] = 8;
    assert.doesNotThrow(() => explicit.addFrom(buf, 0));
});

test('addFrom returns this (chainable)', () => {
    const eh = new ExponentialHistogram(100, 0.1);
    const buf = new Float64Array([1, 2]);
    assert.equal(eh.addFrom(buf, 0), eh);
});

test('bucket pool never overflows across a long shifting stream (all sweep cells)', () => {
    for (const W of [64, 1000, 4096]) {
        for (const eps of [0.5, 0.1, 0.01]) {
            const eh = new ExponentialHistogram(W, eps);
            for (let i = 1; i <= 6 * W; i++) {
                eh.add();
                assert.ok(eh.bucketCount <= eh.capacity,
                    'overflow W=' + W + ' eps=' + eps + ' at i=' + i + ' (' + eh.bucketCount + '/' + eh.capacity + ')');
            }
        }
    }
});
