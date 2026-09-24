// @zakkster/lite-adaptive -- SlidingCountMin behavioral + fail-closed suite (node:test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingCountMin, VERSION } from '../Adaptive.js';

const SAT = 4294967295;   // SCM_SAT (2^32 - 1)

/** A deterministic mulberry32 PRNG so every assertion is reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------------------
// version pin (the 8th pin -> 8 VERSION pins total)
// ---------------------------------------------------------------------------
test('VERSION is 1.5.0 (SlidingCountMin milestone)', () => {
    assert.equal(VERSION, '1.5.0');
});

// ---------------------------------------------------------------------------
// ctor: fail-closed domain (typeof-first, before any allocation)
// ---------------------------------------------------------------------------
test('ctor rejects a non-number / non-positive / non-finite W', () => {
    assert.throws(() => new SlidingCountMin('1000'), /lite-adaptive/);
    assert.throws(() => new SlidingCountMin(0), /finite number > 0/);
    assert.throws(() => new SlidingCountMin(-1), /finite number > 0/);
    assert.throws(() => new SlidingCountMin(NaN), /finite number > 0/);
    assert.throws(() => new SlidingCountMin(Infinity), /finite number > 0/);
});

test('ctor rejects bad epsilon / delta / w / d / panes / seed / conservative / unknown option', () => {
    assert.throws(() => new SlidingCountMin(1000, { epsilon: 0 }), /epsilon/);
    assert.throws(() => new SlidingCountMin(1000, { epsilon: 1 }), /epsilon/);
    assert.throws(() => new SlidingCountMin(1000, { epsilon: 'x' }), /epsilon/);
    assert.throws(() => new SlidingCountMin(1000, { delta: 0 }), /delta/);
    assert.throws(() => new SlidingCountMin(1000, { delta: 1 }), /delta/);
    assert.throws(() => new SlidingCountMin(1000, { w: 0 }), /w must be an integer/);
    assert.throws(() => new SlidingCountMin(1000, { w: 1.5 }), /w must be an integer/);
    assert.throws(() => new SlidingCountMin(1000, { w: (1 << 16) + 1 }), /w must be an integer/);
    assert.throws(() => new SlidingCountMin(1000, { d: 0 }), /d must be an integer/);
    assert.throws(() => new SlidingCountMin(1000, { d: 33 }), /d must be an integer/);
    assert.throws(() => new SlidingCountMin(1000, { panes: 1 }), /panes/);
    assert.throws(() => new SlidingCountMin(1000, { panes: 1025 }), /panes/);
    assert.throws(() => new SlidingCountMin(1000, { panes: 3.5 }), /panes/);
    assert.throws(() => new SlidingCountMin(1000, { seed: 1.5 }), /seed/);
    assert.throws(() => new SlidingCountMin(1000, { conservative: 1 }), /conservative/);
    assert.throws(() => new SlidingCountMin(1000, { bogus: 1 }), /unknown option/);
    assert.throws(() => new SlidingCountMin(1000, 42), /options must be an object/);
    assert.throws(() => new SlidingCountMin(1000, null), /options must be an object/);
});

test('ctor rejects a store that would exceed the SMI cap (fail closed before alloc)', () => {
    // panes=1024 -> ring 1025; d=32, w=1<<16 -> 1025*32*65536 > 2^31.
    assert.throws(() => new SlidingCountMin(1000, { panes: 1024, d: 32, w: 1 << 16 }), /exceeds cap/);
});

test('ctor accepts seed=0 and conservative=false (null is not zero / not false)', () => {
    const s = new SlidingCountMin(1000, { seed: 0, conservative: false });
    assert.equal(s.seed, 0);
    assert.equal(s.conservative, false);
});

// ---------------------------------------------------------------------------
// withAccuracy derivation (lite-sketch CMS parity)
// ---------------------------------------------------------------------------
test('withAccuracy derives w = ceil(e/epsilon) rounded to pow2, d = ceil(ln(1/delta))', () => {
    const s = SlidingCountMin.withAccuracy(1000, 0.01, 0.01, { panes: 8 });
    assert.equal(s.w, 512);        // ceil(e/0.01)=272 -> pow2 512
    assert.equal(s.d, 5);          // ceil(ln(100))=5
    assert.equal(s.panes, 8);
    const c = new SlidingCountMin(1000, { epsilon: 0.01, delta: 0.01 });
    assert.equal(c.w, s.w);        // the ctor {epsilon,delta} path reaches the identical sizing
    assert.equal(c.d, s.d);
});

test('withAccuracy rejects a bad epsilon / delta / options', () => {
    assert.throws(() => SlidingCountMin.withAccuracy(1000, 0, 0.01), /epsilon/);
    assert.throws(() => SlidingCountMin.withAccuracy(1000, 0.01, 1), /delta/);
    assert.throws(() => SlidingCountMin.withAccuracy(1000, 0.01, 0.01, 5), /options must be an object/);
});

// ---------------------------------------------------------------------------
// getters + defaults
// ---------------------------------------------------------------------------
test('getters report the shape / knobs / mode / theoretical error', () => {
    const s = new SlidingCountMin(2000, { panes: 16, w: 256, d: 4, seed: 7 });
    assert.equal(s.W, 2000);
    assert.equal(s.panes, 16);
    assert.equal(s.w, 256);
    assert.equal(s.d, 4);
    assert.equal(s.seed, 7);
    assert.equal(s.conservative, true);
    assert.equal(s.saturated, 0);
    assert.equal(s.mode, 'unset');
    assert.equal(s.lastNow, 0);
    assert.ok(Math.abs(s.epsilon - Math.E / 256) < 1e-12);
    assert.ok(Math.abs(s.delta - Math.exp(-4)) < 1e-12);
    // bytes = (panes+1)*d*w*4 + paneEnd + idx
    assert.equal(s.bytes, 17 * 4 * 256 * 4 + 17 * 8 + 4 * 4);
});

// ---------------------------------------------------------------------------
// mode-lock EXPLICIT <-> COUNT (a switch throws)
// ---------------------------------------------------------------------------
test('mode locks EXPLICIT at the first add(now, key); a count-mode add then throws', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(10, 42);
    assert.equal(s.mode, 'explicit');
    assert.throws(() => s.add(undefined, 42), /mode is locked to explicit/);
});

test('mode locks COUNT at the first add(undefined, key); an explicit add then throws', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(undefined, 42);
    assert.equal(s.mode, 'count');
    assert.throws(() => s.add(5, 42), /mode is locked to count/);
});

// ---------------------------------------------------------------------------
// monotone now (a decrease throws, byte-identical no-op)
// ---------------------------------------------------------------------------
test('add rejects a decreasing now and leaves the estimate unchanged (byte-identical no-op)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(100, 7);
    s.add(150, 7);
    const before = s.estimate(7);
    assert.throws(() => s.add(140, 7), /non-decreasing/);
    assert.equal(s.estimate(7), before);
    assert.equal(s.lastNow, 150);
});

test('add rejects a non-finite now', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(1, 7);
    assert.throws(() => s.add(NaN, 7), /finite number/);
    assert.throws(() => s.add(Infinity, 7), /finite number/);
});

// ---------------------------------------------------------------------------
// add / addFrom parity on [now, key, count]
// ---------------------------------------------------------------------------
test('addFrom(buf, i) is byte-identical to add(now, key, count)', () => {
    const rng = mulberry32(0xC0FFEE);
    const a = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 3 });
    const b = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 3 });
    const buf = new Float64Array(3);
    let t = 0;
    for (let i = 0; i < 4000; i++) {
        t += 1;
        const key = (rng() * 5000) | 0;
        const count = 1 + ((rng() * 7) | 0);
        a.add(t, key, count);
        buf[0] = t; buf[1] = key; buf[2] = count;
        b.addFrom(buf, 0);
    }
    // the two counter matrices + paneEnd must be bit-identical
    assert.deepEqual(Array.from(a._cells), Array.from(b._cells));
    assert.deepEqual(Array.from(a._paneEnd), Array.from(b._paneEnd));
    for (const k of [0, 1, 42, 2500, 4999]) assert.equal(a.estimate(k), b.estimate(k));
});

test('addFrom reads a stride-3 packed triple at a non-zero base index', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    const buf = new Float64Array([0, 0, 0, 5, 42, 3]);   // triple at i=3
    s.addFrom(buf, 3);
    assert.equal(s.estimate(42), 3);
    assert.equal(s.mode, 'explicit');
});

// ---------------------------------------------------------------------------
// addFrom bad buffer / index / packed NaN or bad count (byte-identical no-op)
// ---------------------------------------------------------------------------
test('addFrom rejects a bad buffer / index and is a no-op', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(1, 7);
    const before = s.estimate(7);
    assert.throws(() => s.addFrom([1, 2, 3], 0), /Float64Array/);
    assert.throws(() => s.addFrom(new Float64Array([1, 2, 3]), 1), /in-bounds/);  // i+2 = 3 >= length 3
    assert.throws(() => s.addFrom(new Float64Array([1, 2, 3, 4, 5]), -1), /in-bounds/);
    assert.throws(() => s.addFrom(new Float64Array([1, 2, 3, 4, 5]), 1.5), /in-bounds/);
    assert.equal(s.estimate(7), before);
});

test('addFrom rejects a packed NaN / non-integer key or a bad count (no-op)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(1, 7);
    const before = s.estimate(7);
    assert.throws(() => s.addFrom(new Float64Array([2, NaN, 1]), 0), /safe integer/);
    assert.throws(() => s.addFrom(new Float64Array([2, 3.5, 1]), 0), /safe integer/);
    assert.throws(() => s.addFrom(new Float64Array([2, 5, 0]), 0), /count/);
    assert.throws(() => s.addFrom(new Float64Array([2, 5, -1]), 0), /count/);
    assert.throws(() => s.addFrom(new Float64Array([2, 5, 1.5]), 0), /count/);
    assert.equal(s.estimate(7), before);
    assert.equal(s.lastNow, 1);   // time did NOT advance on a rejected addFrom
});

// ---------------------------------------------------------------------------
// key domain: safe-integer THROWS on add, but estimate NEVER throws
// ---------------------------------------------------------------------------
test('add rejects a non-safe-integer key; count must be a positive integer', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    assert.throws(() => s.add(1, 1.5), /safe integer/);
    assert.throws(() => s.add(1, NaN), /safe integer/);
    assert.throws(() => s.add(1, Infinity), /safe integer/);
    assert.throws(() => s.add(1, '7'), /safe integer/);
    assert.throws(() => s.add(1, 2 ** 53), /safe integer/);        // > 2^53 - 1
    assert.throws(() => s.add(1, -(2 ** 53)), /safe integer/);
    assert.throws(() => s.add(1, 7, 0), /count/);
    assert.throws(() => s.add(1, 7, 1.5), /count/);
    assert.throws(() => s.add(1, 7, SAT + 1), /count/);
});

test('a large safe composite key (channelIdx*2^32 + tag) is accepted and estimated exactly', () => {
    const s = new SlidingCountMin(1e12, { panes: 4 });
    const key = 3 * 4294967296 + 12345;   // ~1.3e10, a safe integer
    s.add(1, key, 4);
    assert.equal(s.estimate(key), 4);
    assert.equal(s.estimate(-key), 0);    // a different (unseen) key
});

test('estimate NEVER throws: unseen key = 0, empty window = 0, out-of-domain key = 0', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    assert.equal(s.estimate(42), 0);        // empty window (mode unset)
    s.add(1, 7, 2);
    assert.equal(s.estimate(999), 0);       // unseen key
    assert.equal(s.estimate(1.5), 0);       // out-of-domain (non-integer)
    assert.equal(s.estimate('7'), 0);       // out-of-domain (non-number)
    assert.equal(s.estimate(NaN), 0);
    assert.equal(s.estimate(Infinity), 0);
    assert.equal(s.estimate(2 ** 53), 0);   // out-of-safe-range
    assert.equal(s.estimate(7), 2);
});

// ---------------------------------------------------------------------------
// one-sided over-estimate + returns a DOUBLE
// ---------------------------------------------------------------------------
test('estimate never under-counts a key in the window (one-sided over-estimate)', () => {
    const rng = mulberry32(99);
    const s = new SlidingCountMin(1e12, { panes: 4, w: 512, d: 5, seed: 1 });   // huge W: all live
    const truth = new Map();
    let t = 0;
    for (let i = 0; i < 6000; i++) {
        t += 1;
        const key = (rng() * 2000) | 0;
        s.add(t, key);
        truth.set(key, (truth.get(key) || 0) + 1);
    }
    for (const [key, c] of truth) assert.ok(s.estimate(key) >= c, 'est >= true for ' + key);
});

test('estimate returns a DOUBLE that can exceed 2^32 across panes', () => {
    // two panes each with a near-2^32 count of the same key -> window sum > 2^32.
    const s = new SlidingCountMin(1000, { panes: 2, w: 16, d: 2, seed: 5 });
    const pw = 1000 / 2;   // 500
    s.add(10, 7, SAT);           // pane holding t=10
    s.add(pw + 10, 7, SAT);      // next pane
    const est = s.estimate(7);
    assert.ok(est > 4294967295, 'window sum exceeds 2^32: ' + est);
    assert.equal(est, 2 * SAT);
});

// ---------------------------------------------------------------------------
// saturating count at 2^32 - 1 (never wraps) + the `saturated` honesty flag
// ---------------------------------------------------------------------------
test('a per-pane cell saturates at 2^32 - 1 (never wraps) and sets `saturated`', () => {
    const s = new SlidingCountMin(1e9, { panes: 2, w: 16, d: 2, conservative: true });
    s.add(undefined, 7, SAT);   // count mode; tick 1
    assert.equal(s.saturated, 0);
    s.add(undefined, 7, 100);   // tick 2, same pane -> clamps at SAT
    assert.equal(s.estimate(7), SAT);   // clamped, did NOT wrap to a small number
    assert.ok(s.saturated >= 1);
});

test('plain (non-conservative) add also saturates, never wraps', () => {
    const s = new SlidingCountMin(1e9, { panes: 2, w: 16, d: 2, conservative: false });
    s.add(undefined, 7, SAT);
    s.add(undefined, 7, 100);
    assert.equal(s.estimate(7), SAT);
    assert.ok(s.saturated >= 1);
});

// ---------------------------------------------------------------------------
// conservative update (per pane): never worse than plain, heavy key over-estimated
// ---------------------------------------------------------------------------
test('conservative update is never worse than plain add for any key', () => {
    const rng = mulberry32(0xBADF00D);
    const cons = new SlidingCountMin(1e12, { panes: 2, w: 64, d: 3, conservative: true, seed: 2 });
    const plain = new SlidingCountMin(1e12, { panes: 2, w: 64, d: 3, conservative: false, seed: 2 });
    let t = 0, heavy = 0;
    for (let i = 0; i < 5000; i++) {
        t += 1;
        const key = (i % 50 === 0) ? 1 : (1000 + i);   // key 1 is the heavy hitter
        if (key === 1) heavy++;
        cons.add(t, key);
        plain.add(t, key);
    }
    assert.ok(cons.estimate(1) >= heavy);                 // one-sided (over-estimate)
    assert.ok(plain.estimate(1) >= heavy);
    for (const k of [1000, 1234, 1500, 2222, 3333]) {
        assert.ok(cons.estimate(k) <= plain.estimate(k), 'conservative <= plain for ' + k);
    }
});

// ---------------------------------------------------------------------------
// sub-window w in (0, W]; a bad w returns 0 (estimate never throws)
// ---------------------------------------------------------------------------
test('a sub-window w narrows the counted span; recent keys still show', () => {
    const s = new SlidingCountMin(1000, { panes: 10 });
    // key 7 only in the OLD half, key 9 only in the RECENT half.
    for (let t = 1; t <= 400; t++) s.add(t, 7);
    for (let t = 601; t <= 1000; t++) s.add(t, 9);
    assert.ok(s.estimate(9) >= 400);          // full window sees the recent key
    assert.equal(s.estimate(9, 200), s.estimate(9, 200));   // stable
    // a small recent sub-window sees key 9 but not the long-gone key 7.
    assert.ok(s.estimate(9, 300) > 0);
    assert.equal(s.estimate(7, 100), 0);      // key 7 is far outside a 100-wide recent window
});

test('estimate returns 0 (never throws) for a sub-window outside (0, W]', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(1, 7, 3);
    assert.equal(s.estimate(7, 0), 0);
    assert.equal(s.estimate(7, -5), 0);
    assert.equal(s.estimate(7, 1001), 0);
    assert.equal(s.estimate(7, NaN), 0);
    assert.equal(s.estimate(7, Infinity), 0);
    assert.equal(s.estimate(7, 1000), 3);     // w === W is valid
});

// ---------------------------------------------------------------------------
// advance(now) idle-slide empties the estimate
// ---------------------------------------------------------------------------
test('advance(now) slides an idle window to empty (estimate -> 0)', () => {
    const s = new SlidingCountMin(1000, { panes: 8 });
    for (let t = 1; t <= 900; t++) s.add(t, 7);
    assert.ok(s.estimate(7) > 0);
    s.advance(900 + 2 * 1000);   // idle-slide well past the window
    assert.equal(s.estimate(7), 0);
    assert.equal(s.mode, 'explicit');
});

test('advance rejects a mode switch (count-locked) and a decreasing / non-finite now', () => {
    const count = new SlidingCountMin(1000, { panes: 4 });
    count.add(undefined, 7);
    assert.throws(() => count.advance(500), /advance\(\) is an explicit-time op/);

    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(100, 7);
    s.advance(200);
    assert.throws(() => s.advance(150), /non-decreasing/);
    assert.throws(() => s.advance(NaN), /finite number/);
    assert.equal(s.lastNow, 200);
});

test('advance on an UNSET instance locks EXPLICIT and anchors the ring', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.advance(500);
    assert.equal(s.mode, 'explicit');
    assert.equal(s.estimate(7), 0);
    s.add(500, 7, 2);
    assert.equal(s.estimate(7), 2);
});

test('advanceFrom(buf, i) parity with advance(now) + bad-buffer no-op', () => {
    const a = new SlidingCountMin(1000, { panes: 4 });
    const b = new SlidingCountMin(1000, { panes: 4 });
    for (let t = 1; t <= 500; t++) { a.add(t, 7); b.add(t, 7); }
    a.advance(2500);
    b.advanceFrom(new Float64Array([2500]), 0);
    assert.deepEqual(Array.from(a._paneEnd), Array.from(b._paneEnd));
    assert.equal(a.estimate(7), b.estimate(7));
    // bad buffer / index -> throw, no-op
    assert.throws(() => b.advanceFrom([1], 0), /Float64Array/);
    assert.throws(() => b.advanceFrom(new Float64Array([1]), 1), /in-bounds/);
});

// ---------------------------------------------------------------------------
// clear() reuse
// ---------------------------------------------------------------------------
test('clear() empties the window, unlocks the mode, and keeps bytes constant', () => {
    const s = new SlidingCountMin(1000, { panes: 8 });
    const bytes0 = s.bytes;
    for (let t = 1; t <= 900; t++) s.add(t, 7, 2);
    assert.ok(s.estimate(7) > 0);
    s.clear();
    assert.equal(s.mode, 'unset');
    assert.equal(s.estimate(7), 0);
    assert.equal(s.saturated, 0);
    assert.equal(s.bytes, bytes0);
    // reusable in a fresh mode after clear
    s.add(undefined, 7, 5);
    assert.equal(s.mode, 'count');
    assert.equal(s.estimate(7), 5);
});
