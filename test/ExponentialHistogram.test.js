// @zakkster/lite-adaptive -- ExponentialHistogram behavioral + fail-closed suite (node:test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ExponentialHistogram, VERSION } from '../Adaptive.js';

test('VERSION is the expected string', () => {
    assert.equal(VERSION, '1.7.0');
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

test('CAP / k / levels match the settled formulas (maxCount: W reproduces the pre-1.7.0 W-sized pool)', () => {
    // levels = max(2, ceil(log2(maxCount/(k+1))) + 2); cap = (k+1)*levels + 2. With
    // maxCount = W these reproduce the exact pre-1.7.0 numbers (23/44/158/35/72/366/53/114/678).
    const cases = [
        [64, 0.5, 2, 7, 23], [64, 0.1, 6, 6, 44], [64, 0.01, 51, 3, 158],
        [1000, 0.5, 2, 11, 35], [1000, 0.1, 6, 10, 72], [1000, 0.01, 51, 7, 366],
        [65536, 0.5, 2, 17, 53], [65536, 0.1, 6, 16, 114], [65536, 0.01, 51, 13, 678],
    ];
    for (const [W, eps, k, levels, cap] of cases) {
        const eh = new ExponentialHistogram(W, eps, { maxCount: W });
        assert.equal(eh.k, k, 'k for W=' + W + ' eps=' + eps);
        assert.equal(eh.levels, levels, 'levels for W=' + W + ' eps=' + eps);
        assert.equal(eh.capacity, cap, 'cap for W=' + W + ' eps=' + eps);
        assert.equal(eh.maxCount, W, 'maxCount for W=' + W + ' eps=' + eps);
    }
});

test('default maxCount (2^32) sizes the pool by epsilon alone (W-independent)', () => {
    // maxCount defaults to 2^32, so levels/cap depend only on k (= epsilon), not on W.
    const cases = [
        [0.5, 2, 33, 101], [0.1, 6, 32, 226], [0.05, 11, 31, 374], [0.01, 51, 29, 1510],
    ];
    for (const [eps, k, levels, cap] of cases) {
        for (const W of [64, 1000, 65536]) {
            const eh = new ExponentialHistogram(W, eps);
            assert.equal(eh.maxCount, 4294967296, 'default maxCount');
            assert.equal(eh.k, k, 'k for eps=' + eps);
            assert.equal(eh.levels, levels, 'default levels for eps=' + eps + ' W=' + W);
            assert.equal(eh.capacity, cap, 'default cap for eps=' + eps + ' W=' + W);
        }
    }
    // eps 0.01 default pool: 1510 buckets x 36 B = 54,360 B (the CHANGELOG figure).
    assert.equal(new ExponentialHistogram(1000, 0.01).capacity * 36, 54360);
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

test('F15: sum() overflows to +Infinity (honest IEEE) for values near Double.MAX; count() unaffected', () => {
    // sum() is an IEEE double. It never throws on a big value; it returns the representable
    // answer (+Infinity) when the windowed value sum exceeds Number.MAX_VALUE. This pins that
    // decision (query contract: a query never throws on a bad VALUE). count() is a POPULATION
    // bound, so it stays exact.
    const eh = new ExponentialHistogram(1000, 0.1);
    eh.add(0, 1e308);
    eh.add(0, 1e308);   // 2e308 > Number.MAX_VALUE ~ 1.8e308
    assert.equal(eh.sum(), Infinity);
    assert.equal(eh.count(), 2);
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

// --- advance() / advanceFrom() -- the R11 idle slide (ADR 0009) -----------------

test('advance(now) slides the window to empty on an idle stream', () => {
    const W = 100;
    const eh = new ExponentialHistogram(W, 0.01);
    for (let t = 0; t < 1000; t++) eh.add(t, 1);
    assert.ok(eh.count() > 0, 'has content before idle');
    eh.advance(1000 + 2 * W);            // idle jump well past the window
    assert.equal(eh.count(), 0, 'idle slide empties the window');
    assert.equal(eh.sum(), 0);
});

test('advance(now) partial slide expires only the out-of-window buckets', () => {
    const eh = new ExponentialHistogram(100, 0.01);
    for (let t = 0; t < 200; t++) eh.add(t, 1);
    const before = eh.count();
    eh.advance(250);                     // window is now (150, 250]; ~half expires
    const after = eh.count();
    assert.ok(after < before && after > 0, 'partial idle slide: ' + before + ' -> ' + after);
});

test('advance() returns this (chainable)', () => {
    const eh = new ExponentialHistogram(100, 0.01);
    eh.add(0, 1);
    assert.equal(eh.advance(10), eh);
});

test('advance() locks EXPLICIT on an UNSET instance', () => {
    const eh = new ExponentialHistogram(100, 0.01);
    eh.advance(50);
    assert.equal(eh.mode, 'explicit');
    eh.add(60, 1);
    assert.equal(eh.count(), 1);
    assert.throws(() => eh.add(), /\[lite-adaptive\]/);   // count add now rejected
});

test('advance() on a COUNT-locked instance throws (EXPLICIT-only)', () => {
    const eh = new ExponentialHistogram(100, 0.01);
    eh.add();                            // locks COUNT
    assert.throws(() => eh.advance(5), /\[lite-adaptive\]/);
});

test('advance() rejects a non-finite / decreasing now as a BYTE-IDENTICAL no-op', () => {
    const eh = new ExponentialHistogram(100, 0.01);
    eh.add(100, 1);
    const snap = eh.count();
    for (const bad of [NaN, Infinity, -Infinity, '10', null, undefined, {}]) {
        assert.throws(() => eh.advance(bad), /\[lite-adaptive\]/, 'now=' + String(bad));
    }
    assert.throws(() => eh.advance(50), /\[lite-adaptive\]/);   // decreasing
    assert.equal(eh.count(), snap, 'no-op: count unchanged');
    // the monotone guard did not advance on reject: a later add at the original now still works.
    eh.add(100, 1);
    assert.equal(eh.count(), snap + 1);
});

test('advanceFrom(buf, i) matches advance(now) and reads now UNBOXED', () => {
    const a = new ExponentialHistogram(100, 0.01);
    const b = new ExponentialHistogram(100, 0.01);
    for (let t = 0; t < 500; t++) { a.add(t, 1); b.add(t, 1); }
    a.advance(700);
    const buf = new Float64Array([0, 700, 0]);
    b.advanceFrom(buf, 1);
    assert.equal(a.count(), b.count());
    assert.equal(a.sum(), b.sum());
    assert.equal(b.advanceFrom(new Float64Array([800]), 0), b);   // chainable, i=last valid
});

test('advanceFrom rejects a bad buffer / index typeof-first (no-op)', () => {
    const eh = new ExponentialHistogram(100, 0.01);
    eh.add(0, 1);
    const snap = eh.count();
    for (const bad of [[0], 'x', null, undefined, {}, new Uint32Array([1])]) {
        assert.throws(() => eh.advanceFrom(bad, 0), /\[lite-adaptive\]/);
    }
    const buf = new Float64Array([10]);
    for (const badI of [-1, 1, 1.5, '0', NaN]) {
        assert.throws(() => eh.advanceFrom(buf, badI), /\[lite-adaptive\]/, 'i=' + String(badI));
    }
    assert.equal(eh.count(), snap, 'no-op on reject');
});

test('advanceFrom on a COUNT-locked instance throws', () => {
    const eh = new ExponentialHistogram(100, 0.01);
    eh.add();
    assert.throws(() => eh.advanceFrom(new Float64Array([5]), 0), /\[lite-adaptive\]/);
});

// --- 1.7.0 S3: maxCount sizing + overflow pre-check (F1) ----------------------

test('maxCount is validated typeof-first, BEFORE any allocation', () => {
    for (const bad of [0, -1, 1.5, 9007199254740992 /* 2^53 */, NaN, Infinity, '10', null, {}, 10n]) {
        assert.throws(() => new ExponentialHistogram(1000, 0.1, { maxCount: bad }),
            /\[lite-adaptive\].*maxCount/, 'maxCount=' + String(bad));
    }
    // valid values do not throw; undefined (not null) takes the 2^32 default.
    assert.doesNotThrow(() => new ExponentialHistogram(1000, 0.1, { maxCount: 1 }));
    assert.doesNotThrow(() => new ExponentialHistogram(1000, 0.1, { maxCount: 9007199254740991 }));
    assert.equal(new ExponentialHistogram(1000, 0.1, { maxCount: undefined }).maxCount, 4294967296);
});

test('maxCount getter reads back the declared population', () => {
    assert.equal(new ExponentialHistogram(1000, 0.1).maxCount, 4294967296);
    assert.equal(new ExponentialHistogram(1000, 0.1, { maxCount: 5000 }).maxCount, 5000);
    assert.equal(new ExponentialHistogram(1000, 0.01, { maxCount: 1000 }).maxCount, 1000);
});

// Snapshot every internal field the overflow throw must leave byte-identical.
function ehSnapshot(eh) {
    return {
        ts: Array.from(eh._ts), start: Array.from(eh._start), size: Array.from(eh._size),
        next: Array.from(eh._next), prev: Array.from(eh._prev), lvl: Array.from(eh._lvl),
        head: Array.from(eh._head), tail: Array.from(eh._tail), lcount: Array.from(eh._lcount),
        freeHead: eh._freeHead, count: eh._count, maxLevel: eh._maxLevel,
        now: eh._now, lastNow: eh._lastNow, tick: eh._tick, mode: eh._mode,
    };
}

test('overflow throws a tagged RangeError, BYTE-IDENTICAL no-op (add, explicit)', () => {
    // small maxCount, W large so nothing expires -> a growing window overflows the pool.
    const eh = new ExponentialHistogram(1e9, 0.1, { maxCount: 8 });
    let threw = false;
    for (let i = 1; i <= 100000; i++) {
        const before = ehSnapshot(eh);
        try {
            eh.add(i, 1);
        } catch (e) {
            threw = true;
            assert.ok(e instanceof RangeError, 'RangeError');
            assert.match(e.message, /\[lite-adaptive\].*maxCount/);
            assert.doesNotMatch(e.message, /this is a bug/);
            assert.deepEqual(ehSnapshot(eh), before, 'state byte-identical after throw');
            break;
        }
    }
    assert.ok(threw, 'expected an overflow throw');
});

test('overflow throws BYTE-IDENTICAL (add, count mode)', () => {
    const eh = new ExponentialHistogram(1e9, 0.1, { maxCount: 8 });
    let threw = false;
    for (let i = 1; i <= 100000; i++) {
        const before = ehSnapshot(eh);
        try {
            eh.add();   // count mode
        } catch (e) {
            threw = true;
            assert.match(e.message, /\[lite-adaptive\].*maxCount/);
            assert.deepEqual(ehSnapshot(eh), before, 'state byte-identical after throw');
            break;
        }
    }
    assert.ok(threw, 'expected an overflow throw');
});

test('overflow throws BYTE-IDENTICAL (addFrom, explicit)', () => {
    const eh = new ExponentialHistogram(1e9, 0.1, { maxCount: 8 });
    const buf = new Float64Array(2);
    let threw = false;
    for (let i = 1; i <= 100000; i++) {
        buf[0] = i; buf[1] = 1;
        const before = ehSnapshot(eh);
        try {
            eh.addFrom(buf, 0);
        } catch (e) {
            threw = true;
            assert.match(e.message, /\[lite-adaptive\].*maxCount/);
            assert.deepEqual(ehSnapshot(eh), before, 'state byte-identical after throw');
            break;
        }
    }
    assert.ok(threw, 'expected an overflow throw');
});

test('advance / advanceFrom never throw overflow (they insert nothing)', () => {
    // Fill toward capacity, then advance far past the window -- an idle slide only expires.
    const eh = new ExponentialHistogram(1000, 0.1);
    for (let i = 1; i <= 5000; i++) eh.add(i, 1);
    assert.doesNotThrow(() => eh.advance(1e15));
    assert.equal(eh.count(), 0, 'idle slide empties the window');
    const eh2 = new ExponentialHistogram(1000, 0.1);
    for (let i = 1; i <= 5000; i++) eh2.add(i, 1);
    assert.doesNotThrow(() => eh2.advanceFrom(new Float64Array([1e15]), 0));
    assert.equal(eh2.count(), 0);
});

// Independent oracle: does the pending insert at `t` really cascade past the top level?
// Simulates the expiry sweep + the insert cascade on a COPY of the per-level counts.
function refWouldOverflow(eh, t) {
    const levels = eh._levels, k = eh._k, maxL = eh._maxLevel;
    const cutoff = t - eh._W, ts = eh._ts, next = eh._next, head = eh._head, lcount = eh._lcount;
    const lc = new Array(levels);
    for (let L = 0; L < levels; L++) lc[L] = lcount[L];
    let expiring = true;
    for (let L = maxL; L >= 0 && expiring; L--) {
        let node = head[L];
        while (node !== -1 && ts[node] <= cutoff) { lc[L]--; node = next[node]; }
        if (node !== -1) expiring = false;
    }
    lc[0]++;
    let L = 0;
    while (lc[L] > k) {
        lc[L] -= 2;
        const nl = L + 1;
        if (nl >= levels) return true;   // cascade passes the top -> real overflow
        lc[nl]++;
        L = nl;
    }
    return false;
}

test('_wouldOverflow soundness: true <=> the cascade would really pass the top (eps .5)', () => {
    // A tiny deterministic LCG so the random streams are reproducible.
    let seed = 0x9e3779b9 >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    let overflows = 0, falsePositives = 0, checks = 0;
    for (const maxCount of [16, 40]) {
        for (let stream = 0; stream < 40; stream++) {
            const eh = new ExponentialHistogram(100, 0.5, { maxCount });
            let t = 0;
            for (let step = 0; step < 4000; step++) {
                t += rnd() * 2;                       // fractional, sometimes expires
                const ref = refWouldOverflow(eh, t);
                const got = eh._wouldOverflow(t);
                checks++;
                // no false negatives: the real cascade overflowing MUST be predicted.
                assert.equal(got, ref, 'mismatch maxCount=' + maxCount + ' step=' + step +
                    ' ref=' + ref + ' got=' + got);
                if (got) { falsePositives += ref ? 0 : 1; }
                if (ref) {
                    overflows++;
                    assert.throws(() => eh.add(t, 1), /\[lite-adaptive\].*maxCount/);
                    eh.clear();
                    t = 0;
                } else {
                    eh.add(t, 1);   // the real add must NOT throw when ref says no overflow
                }
            }
        }
    }
    assert.equal(falsePositives, 0, 'no false positives');
    assert.ok(overflows > 0, 'the true branch was exercised (' + overflows + ' overflows / ' + checks + ' checks)');
});

// --- 1.7.0 step-2 QA boundary cases (promoted from the QA reproduction scripts) ---

test('maxCount -0 is rejected (not a positive integer) before allocation', () => {
    assert.throws(() => new ExponentialHistogram(10, 0.1, { maxCount: -0 }), /\[lite-adaptive\]/);
});

test('exact pool ceiling k*(2^levels-1): holds exactly that many, the next add throws byte-identically (add + addFrom)', () => {
    const pairs = [[0.01, 5000], [0.5, 16], [0.1, 40], [0.5, 1], [0.01, 1]];
    for (const [eps, mc] of pairs) {
        for (const viaFrom of [false, true]) {
            const eh = new ExponentialHistogram(1e12, eps, { maxCount: mc });
            const ceil = eh.k * (2 ** eh.levels - 1);
            assert.ok(ceil >= mc, 'ceiling ' + ceil + ' >= maxCount ' + mc);
            const buf = new Float64Array([0, 1]);
            for (let i = 0; i < ceil; i++) { if (viaFrom) eh.addFrom(buf, 0); else eh.add(0); }
            assert.equal(eh.count(), ceil, 'eps ' + eps + ' maxCount ' + mc + ' holds exactly ' + ceil);
            const before = ehSnapshot(eh);
            assert.throws(() => (viaFrom ? eh.addFrom(buf, 0) : eh.add(0)),
                (e) => e instanceof RangeError && /^\[lite-adaptive\]/.test(e.message));
            assert.deepEqual(ehSnapshot(eh), before, 'byte-identical across the overflow throw');
        }
    }
});

test('exact pool ceiling in COUNT mode (auto-tick, nothing expires)', () => {
    const eh = new ExponentialHistogram(1e12, 0.1, { maxCount: 40 });
    const ceil = eh.k * (2 ** eh.levels - 1);
    for (let i = 0; i < ceil; i++) eh.add();
    const before = ehSnapshot(eh);
    assert.throws(() => eh.add(), /\[lite-adaptive\]/);
    assert.deepEqual(ehSnapshot(eh), before);
});

test('adversarial: overflow at the ceiling, then the window slides and the pool recovers', () => {
    const eh = new ExponentialHistogram(10, 0.5, { maxCount: 1 });   // k 2, levels 2, ceiling 6
    const ceil = eh.k * (2 ** eh.levels - 1);
    for (let i = 0; i < ceil; i++) eh.add(0);
    assert.throws(() => eh.add(0), /\[lite-adaptive\]/);
    eh.advance(11);                                                   // the whole burst expires
    assert.equal(eh.count(), 0);
    for (let i = 0; i < ceil; i++) eh.add(11);                        // a fresh burst fits again
    assert.equal(eh.count(), ceil);
    assert.throws(() => eh.add(11), /\[lite-adaptive\]/);
});

// --- F11: the ctor bucket-pool cap throws a tagged RangeError in-process (1.6.0 aborted with exit
//     133 via a V8 fatal). Verified in a SUBPROCESS: the child catches the throw and exits 0. ---
test('F11 ExponentialHistogram(10, 1e-12) throws tagged in a subprocess (no process abort)', () => {
    const src =
        "import('" + new URL('../Adaptive.js', import.meta.url).href + "').then(m=>{" +
        "try{new m.ExponentialHistogram(10, 1e-12);console.log('NO_THROW');}" +
        "catch(e){console.log(/\\[lite-adaptive\\]/.test(e.message)&&e instanceof RangeError?'TAGGED':'WRONG:'+e.message);}});";
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'child exits 0, stderr=' + r.stderr);
    assert.match(r.stdout, /TAGGED/, 'child caught a tagged RangeError, got ' + r.stdout);
});
