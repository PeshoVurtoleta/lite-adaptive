// @zakkster/lite-adaptive -- SlidingHyperLogLog behavioral + fail-closed suite (node:test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingHyperLogLog, VERSION } from '../Adaptive.js';

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
// version pin
// ---------------------------------------------------------------------------
test('VERSION is 1.5.0 (SlidingCountMin milestone)', () => {
    assert.equal(VERSION, '1.5.0');
});

// ---------------------------------------------------------------------------
// ctor: fail-closed domain (typeof-first, before any allocation)
// ---------------------------------------------------------------------------
test('ctor rejects a non-number W', () => {
    assert.throws(() => new SlidingHyperLogLog('1000'), /lite-adaptive/);
});
test('ctor rejects W = 0 / negative / NaN / Infinity', () => {
    assert.throws(() => new SlidingHyperLogLog(0), /finite number > 0/);
    assert.throws(() => new SlidingHyperLogLog(-1), /finite number > 0/);
    assert.throws(() => new SlidingHyperLogLog(NaN), /finite number > 0/);
    assert.throws(() => new SlidingHyperLogLog(Infinity), /finite number > 0/);
});
test('ctor rejects a non-object options', () => {
    assert.throws(() => new SlidingHyperLogLog(1000, 5), /options must be an object/);
    assert.throws(() => new SlidingHyperLogLog(1000, null), /options must be an object/);
});
test('ctor rejects an unknown option key with a hint', () => {
    assert.throws(() => new SlidingHyperLogLog(1000, { precision: 10 }), /unknown option "precision"/);
});
test('ctor rejects p out of [4, 16] and non-integer p', () => {
    assert.throws(() => new SlidingHyperLogLog(1000, { p: 3 }), /p must be an integer/);
    assert.throws(() => new SlidingHyperLogLog(1000, { p: 17 }), /p must be an integer/);
    assert.throws(() => new SlidingHyperLogLog(1000, { p: 10.5 }), /p must be an integer/);
    assert.throws(() => new SlidingHyperLogLog(1000, { p: '10' }), /p must be an integer/);
});
test('ctor rejects ringCap that is not a power of two in [2, 64]', () => {
    assert.throws(() => new SlidingHyperLogLog(1000, { ringCap: 1 }), /power of two/);
    assert.throws(() => new SlidingHyperLogLog(1000, { ringCap: 6 }), /power of two/);
    assert.throws(() => new SlidingHyperLogLog(1000, { ringCap: 128 }), /power of two/);
    assert.throws(() => new SlidingHyperLogLog(1000, { ringCap: 8.5 }), /power of two/);
});
test('ctor accepts power-of-two ringCaps 2..64', () => {
    for (const rc of [2, 4, 8, 16, 32, 64]) {
        const s = new SlidingHyperLogLog(1000, { ringCap: rc });
        assert.equal(s.ringCap, rc);
    }
});
test('ctor rejects a non-uint32 seed but ACCEPTS seed = 0 (null is not zero)', () => {
    assert.throws(() => new SlidingHyperLogLog(1000, { seed: -1 }), /seed must be a uint32/);
    assert.throws(() => new SlidingHyperLogLog(1000, { seed: 4294967296 }), /seed must be a uint32/);
    assert.throws(() => new SlidingHyperLogLog(1000, { seed: 1.5 }), /seed must be a uint32/);
    const s = new SlidingHyperLogLog(1000, { seed: 0 });
    assert.equal(s.seed, 0);
});

// ---------------------------------------------------------------------------
// getters + defaults
// ---------------------------------------------------------------------------
test('getters reflect the defaults (p=10, ringCap=8, seed=0x9e3779b1)', () => {
    const s = new SlidingHyperLogLog(1000);
    assert.equal(s.W, 1000);
    assert.equal(s.p, 10);
    assert.equal(s.m, 1024);
    assert.equal(s.ringCap, 8);
    assert.equal(s.seed, 0x9e3779b1);
    assert.equal(s.mode, 'unset');
    assert.equal(s.overflows, 0);
    assert.equal(s.degraded, false);
    assert.equal(s.lastNow, 0);
    assert.ok(s.bytes > 0);
    assert.ok(Math.abs(s.standardError - 1.04 / Math.sqrt(1024)) < 1e-12);
});
test('m follows p (m = 1 << p)', () => {
    assert.equal(new SlidingHyperLogLog(1000, { p: 4 }).m, 16);
    assert.equal(new SlidingHyperLogLog(1000, { p: 12 }).m, 4096);
    assert.equal(new SlidingHyperLogLog(1000, { p: 16 }).m, 65536);
});
test('empty count() is 0 and never throws', () => {
    const s = new SlidingHyperLogLog(1000);
    assert.equal(s.count(), 0);
    assert.equal(s.query(), 0);
});

// ---------------------------------------------------------------------------
// add: fail-closed key + time model
// ---------------------------------------------------------------------------
test('add rejects a non-safe-integer key (typeof-first)', () => {
    const s = new SlidingHyperLogLog(1000);
    assert.throws(() => s.add(1, 'x'), /key must be a safe integer/);
    assert.throws(() => s.add(1, 1.5), /key must be a safe integer/);
    assert.throws(() => s.add(1, NaN), /key must be a safe integer/);
    assert.throws(() => s.add(1, Number.MAX_SAFE_INTEGER + 2), /key must be a safe integer/);
});
test('a rejected add is a byte-identical no-op (no mode lock, no state)', () => {
    const s = new SlidingHyperLogLog(1000);
    assert.throws(() => s.add(1, 'x'));
    assert.equal(s.mode, 'unset');
    assert.equal(s.count(), 0);
    assert.equal(s.lastNow, 0);
});
test('the first add(now, key) locks EXPLICIT mode; a count-mode add then throws', () => {
    const s = new SlidingHyperLogLog(1000);
    s.add(5, 1);
    assert.equal(s.mode, 'explicit');
    assert.equal(s.lastNow, 5);
    assert.throws(() => s.add(undefined, 2), /locked to explicit/);
});
test('the first add(undefined, key) locks COUNT mode; an explicit add then throws', () => {
    const s = new SlidingHyperLogLog(1000);
    s.add(undefined, 1);
    assert.equal(s.mode, 'count');
    assert.throws(() => s.add(5, 2), /locked to count/);
});
test('explicit add rejects a non-finite now', () => {
    const s = new SlidingHyperLogLog(1000);
    s.add(1, 1);
    assert.throws(() => s.add(NaN, 2), /now must be a finite number/);
    assert.throws(() => s.add(Infinity, 2), /now must be a finite number/);
});
test('explicit add rejects a decreasing now (monotone guard); equal is OK', () => {
    const s = new SlidingHyperLogLog(1000);
    s.add(10, 1);
    assert.throws(() => s.add(9, 2), /non-decreasing/);
    s.add(10, 2);   // equal timestamp allowed
    s.add(11, 3);
    assert.equal(s.lastNow, 11);
});
test('add returns this (chainable)', () => {
    const s = new SlidingHyperLogLog(1000);
    assert.equal(s.add(1, 1), s);
    assert.equal(s.add(2, 2).add(3, 3), s);
});

// ---------------------------------------------------------------------------
// addFrom: zero-box packed [now, key]
// ---------------------------------------------------------------------------
test('addFrom rejects a non-Float64Array buf', () => {
    const s = new SlidingHyperLogLog(1000);
    assert.throws(() => s.addFrom([1, 2], 0), /needs a Float64Array/);
    assert.throws(() => s.addFrom(new Float32Array(2), 0), /needs a Float64Array/);
});
test('addFrom rejects a bad index (non-integer / negative / out of range)', () => {
    const s = new SlidingHyperLogLog(1000);
    const buf = new Float64Array([1, 2]);
    assert.throws(() => s.addFrom(buf, 'x'), /in-bounds/);
    assert.throws(() => s.addFrom(buf, -1), /in-bounds/);
    assert.throws(() => s.addFrom(buf, 1.5), /in-bounds/);
    assert.throws(() => s.addFrom(buf, 1), /in-bounds/);   // needs i + 1 < length
});
test('addFrom rejects a non-safe-integer key at buf[i+1]', () => {
    const s = new SlidingHyperLogLog(1000);
    const buf = new Float64Array([1, 1.5]);
    assert.throws(() => s.addFrom(buf, 0), /key must be a safe integer/);
});
test('addFrom is EXPLICIT-time only: a count-locked instance rejects it', () => {
    const s = new SlidingHyperLogLog(1000);
    s.add(undefined, 1);
    const buf = new Float64Array([1, 2]);
    assert.throws(() => s.addFrom(buf, 0), /locked to count/);
});
test('the first addFrom locks EXPLICIT mode and enforces monotone now', () => {
    const s = new SlidingHyperLogLog(1000);
    const buf = new Float64Array([10, 1]);
    s.addFrom(buf, 0);
    assert.equal(s.mode, 'explicit');
    assert.equal(s.lastNow, 10);
    const back = new Float64Array([9, 2]);
    assert.throws(() => s.addFrom(back, 0), /non-decreasing/);
});
test('add and addFrom agree on the same [now, key] (byte-identical body)', () => {
    const a = new SlidingHyperLogLog(4096, { p: 12, seed: 7 });
    const b = new SlidingHyperLogLog(4096, { p: 12, seed: 7 });
    const buf = new Float64Array(2);
    for (let i = 0; i < 3000; i++) {
        a.add(i, (i * 2654435761) % 5000);
        buf[0] = i; buf[1] = (i * 2654435761) % 5000;
        b.addFrom(buf, 0);
    }
    assert.equal(a.count(), b.count());
});
test('addFrom carries large safe-integer keys (> 2^31) unboxed', () => {
    const s = new SlidingHyperLogLog(10000, { p: 12 });
    const buf = new Float64Array(2);
    for (let i = 0; i < 5000; i++) {
        buf[0] = i; buf[1] = 4294967295 - i;   // near 2^32-1, exceeds 2^31
        s.addFrom(buf, 0);
    }
    // ~5000 distinct large keys, window >= 5000 -> estimate within a few sigma of 5000.
    const est = s.count();
    assert.ok(est > 5000 * 0.85 && est < 5000 * 1.15, 'large-key est=' + est);
});

// ---------------------------------------------------------------------------
// boundary matrix: null / undefined / -0 keys and timestamps, duplicate clear(),
// interleaved add()+addFrom() on the SAME instance (an adversarial mixed-entry-point case)
// ---------------------------------------------------------------------------
test('add rejects a null or undefined key (typeof-first, same as any other non-number)', () => {
    const s = new SlidingHyperLogLog(1000);
    assert.throws(() => s.add(1, null), /key must be a safe integer/);
    assert.throws(() => s.add(1, undefined), /key must be a safe integer/);
});
test('addFrom rejects a buf[i+1] of null-like non-numbers the same way', () => {
    const s = new SlidingHyperLogLog(1000);
    const buf = new Float64Array([1, NaN]);
    assert.throws(() => s.addFrom(buf, 0), /key must be a safe integer/);
});
test('key = -0 hashes identically to key = 0 (numeric -0 === 0, no distinct register)', () => {
    const a = new SlidingHyperLogLog(1000, { p: 12, seed: 11 });
    const b = new SlidingHyperLogLog(1000, { p: 12, seed: 11 });
    a.add(1, -0);
    b.add(1, 0);
    assert.equal(a.count(), b.count());
    assert.equal(a.count(), 1);
});
test('now = -0 is accepted and treated as 0 (not less than the initial lastNow 0)', () => {
    const s = new SlidingHyperLogLog(1000);
    s.add(-0, 1);
    assert.equal(s.mode, 'explicit');
    assert.equal(s.lastNow, -0);
    s.add(0, 2);   // -0 and 0 are numerically equal -> monotone guard accepts
    assert.equal(s.count(), 2);
});
test('duplicate clear() (double-dispose): clearing an already-empty instance is a safe no-op', () => {
    const s = new SlidingHyperLogLog(1000, { p: 12 });
    assert.equal(s.clear(), s);
    assert.equal(s.clear(), s);   // second clear on an already-clear instance
    assert.equal(s.count(), 0);
    assert.equal(s.overflows, 0);
    assert.equal(s.mode, 'unset');
});
test('duplicate clear() after fill + drain also stays a clean 0-alloc reusable no-op', () => {
    const s = new SlidingHyperLogLog(1000, { p: 12 });
    for (let i = 0; i < 500; i++) s.add(i, i);
    s.clear();
    s.clear();   // second consecutive clear -- must not throw or corrupt state
    assert.equal(s.count(), 0);
    s.add(undefined, 1);
    assert.equal(s.mode, 'count');
});
test('ADVERSARIAL: interleaving add() and addFrom() on the SAME instance agrees with a ' +
     'single-entry-point reference (mixed hot paths must share identical hashing + ring state)', () => {
    const mixed = new SlidingHyperLogLog(4096, { p: 12, seed: 42 });
    const reference = new SlidingHyperLogLog(4096, { p: 12, seed: 42 });
    const buf = new Float64Array(2);
    for (let i = 0; i < 3000; i++) {
        const key = (i * 2654435761) % 5000;
        if (i % 2 === 0) {
            mixed.add(i, key);
        } else {
            buf[0] = i; buf[1] = key;
            mixed.addFrom(buf, 0);
        }
        reference.add(i, key);
    }
    assert.equal(mixed.count(), reference.count());
});

// ---------------------------------------------------------------------------
// windowed distinct-count contract
// ---------------------------------------------------------------------------
test('count() approximates the number of distinct keys in the window (all in-window)', () => {
    const s = new SlidingHyperLogLog(100000, { p: 12 });
    const D = 20000;
    for (let i = 0; i < D; i++) s.add(i, i);           // D distinct keys, all within W
    const est = s.count();
    const rel = Math.abs(est - D) / D;
    assert.ok(rel <= 3 * s.standardError, 'rel=' + rel + ' > 3sigma=' + (3 * s.standardError));
});
test('duplicates do not inflate the distinct count', () => {
    const s = new SlidingHyperLogLog(100000, { p: 12 });
    for (let rep = 0; rep < 50; rep++) for (let k = 0; k < 5000; k++) s.add(rep * 5000 + k, k);
    // only 5000 distinct keys, each seen 50x
    const est = s.count();
    const rel = Math.abs(est - 5000) / 5000;
    assert.ok(rel <= 3 * s.standardError, 'rel=' + rel);
});
test('count() forgets keys that fell out of the window', () => {
    const s = new SlidingHyperLogLog(1000, { p: 12 });
    // first 1000 distinct keys at t 0..999, then 1000 fresh keys at t 2000..2999.
    for (let i = 0; i < 1000; i++) s.add(i, i);
    for (let i = 0; i < 1000; i++) s.add(2000 + i, 100000 + i);
    // now = 2999; window [2000, 2999] holds only the 1000 fresh keys, the old ones expired.
    const est = s.count();
    const rel = Math.abs(est - 1000) / 1000;
    assert.ok(rel <= 3 * s.standardError, 'post-shift est=' + est + ' rel=' + rel);
});
test('a sub-window count(w) tracks a smaller recent slice', () => {
    const s = new SlidingHyperLogLog(10000, { p: 12 });
    for (let i = 0; i < 10000; i++) s.add(i, i);   // 10000 distinct across the full window
    const full = s.count();
    const half = s.count(5000);   // only the last ~5000 distinct
    assert.ok(Math.abs(full - 10000) / 10000 <= 3 * s.standardError, 'full=' + full);
    assert.ok(Math.abs(half - 5000) / 5000 <= 3 * s.standardError, 'half=' + half);
    assert.ok(half < full);
});
test('count rejects a sub-window w outside (0, W]', () => {
    const s = new SlidingHyperLogLog(1000);
    s.add(1, 1);
    assert.throws(() => s.count(0), /w must be a finite number in \(0, W\]/);
    assert.throws(() => s.count(-5), /w must be a finite number in \(0, W\]/);
    assert.throws(() => s.count(1001), /w must be a finite number in \(0, W\]/);
    assert.throws(() => s.count(NaN), /w must be a finite number in \(0, W\]/);
    assert.throws(() => s.count('500'), /w must be a finite number in \(0, W\]/);
});
test('count(W) equals count() (the full window)', () => {
    const s = new SlidingHyperLogLog(5000, { p: 12 });
    for (let i = 0; i < 5000; i++) s.add(i, i * 7);
    assert.equal(s.count(5000), s.count());
});
test('count mode: window is the last N items', () => {
    const s = new SlidingHyperLogLog(1000, { p: 12 });
    for (let i = 0; i < 3000; i++) s.add(undefined, i);   // count mode, auto-tick
    assert.equal(s.mode, 'count');
    // last 1000 items are keys 2000..2999 -> ~1000 distinct
    const est = s.count();
    assert.ok(Math.abs(est - 1000) / 1000 <= 3 * s.standardError, 'count-mode est=' + est);
});

// ---------------------------------------------------------------------------
// determinism + seeds
// ---------------------------------------------------------------------------
test('same seed + same stream -> identical estimate (deterministic, no PRNG)', () => {
    const mk = () => new SlidingHyperLogLog(100000, { p: 12, seed: 123 });
    const a = mk(), b = mk();
    const r = mulberry32(9);
    for (let i = 0; i < 20000; i++) {
        const key = (r() * 1e9) | 0;
        a.add(i, key); b.add(i, key);
    }
    assert.equal(a.count(), b.count());
});
test('different seeds decorrelate (estimates differ but both near truth)', () => {
    const a = new SlidingHyperLogLog(100000, { p: 12, seed: 1 });
    const b = new SlidingHyperLogLog(100000, { p: 12, seed: 2 });
    for (let i = 0; i < 20000; i++) { a.add(i, i); b.add(i, i); }
    const ea = a.count(), eb = b.count();
    assert.notEqual(ea, eb);
    assert.ok(Math.abs(ea - 20000) / 20000 <= 3 * a.standardError);
    assert.ok(Math.abs(eb - 20000) / 20000 <= 3 * b.standardError);
});
test('negative keys hash distinctly from their positive counterparts', () => {
    const s = new SlidingHyperLogLog(100000, { p: 12 });
    for (let i = 1; i <= 5000; i++) { s.add(2 * i, i); s.add(2 * i + 1, -i); }
    // 10000 distinct keys (+i and -i are different)
    const est = s.count();
    assert.ok(Math.abs(est - 10000) / 10000 <= 3 * s.standardError, 'signed est=' + est);
});

// ---------------------------------------------------------------------------
// degraded / overflows
// ---------------------------------------------------------------------------
test('a benign stream does not degrade (overflows stay 0)', () => {
    const s = new SlidingHyperLogLog(100000, { p: 12, ringCap: 32 });
    for (let i = 0; i < 50000; i++) s.add(i, i);
    assert.equal(s.overflows, 0);
    assert.equal(s.degraded, false);
});
test('an adversarial descending-rho stream on a tiny ring overflows and flags degraded', () => {
    // ringCap=2, single register (p=4 but force one register via constant hash preimage is hard;
    // instead: with a tiny ring, a long run of strictly-decreasing-rho arrivals to SOME register
    // eventually overflows). Use many distinct keys + ringCap 2 to provoke at least one overflow.
    const s = new SlidingHyperLogLog(1e9, { p: 4, ringCap: 2 });
    let t = 0;
    for (let i = 0; i < 200000; i++) s.add(t++, i);
    assert.ok(s.overflows > 0, 'expected overflow with ringCap=2 over 200k keys');
    assert.equal(s.degraded, true);
});

// ---------------------------------------------------------------------------
// clear / retention
// ---------------------------------------------------------------------------
test('clear() resets to empty, unlocks the mode, and is chainable + 0-alloc-reusable', () => {
    const s = new SlidingHyperLogLog(1000, { p: 12 });
    for (let i = 0; i < 2000; i++) s.add(i, i);
    assert.ok(s.count() > 0);
    assert.equal(s.clear(), s);
    assert.equal(s.mode, 'unset');
    assert.equal(s.overflows, 0);
    assert.equal(s.degraded, false);
    assert.equal(s.lastNow, 0);
    assert.equal(s.count(), 0);
    // reusable in the OTHER mode after clear
    s.add(undefined, 1);
    assert.equal(s.mode, 'count');
});
test('clear() then re-fill reproduces the same estimate (deterministic reuse)', () => {
    const s = new SlidingHyperLogLog(100000, { p: 12, seed: 5 });
    for (let i = 0; i < 10000; i++) s.add(i, i);
    const first = s.count();
    s.clear();
    for (let i = 0; i < 10000; i++) s.add(i, i);
    assert.equal(s.count(), first);
});

// ---------------------------------------------------------------------------
// design-parity with a static HLL over the in-window distinct set
// ---------------------------------------------------------------------------
test('windowed estimate matches an exact distinct-set oracle within 3 sigma across a W-sweep', () => {
    for (const W of [500, 2000, 8000]) {
        const s = new SlidingHyperLogLog(W, { p: 12, ringCap: 16 });
        const inWindow = [];   // FIFO of (t, key)
        let head = 0;
        const N = 4 * W;
        for (let t = 0; t < N; t++) {
            const key = (t * 2654435761) % (2 * W);   // a rolling distinct set
            s.add(t, key);
            inWindow.push(t, key);
            if (t >= W) {
                // exact distinct in (t - W, t]
                const set = new Set();
                for (let p = head; p < inWindow.length; p += 2) {
                    if (inWindow[p] > t - W) set.add(inWindow[p + 1]);
                    else head = p + 2;
                }
                const exact = set.size;
                const est = s.count();
                const rel = Math.abs(est - exact) / exact;
                assert.ok(rel <= 3 * s.standardError,
                    'W=' + W + ' t=' + t + ' est=' + est + ' exact=' + exact + ' rel=' + rel);
            }
        }
        assert.equal(s.degraded, false, 'W=' + W + ' should not degrade with ringCap 16');
    }
});

// --- advance() / advanceFrom() -- the R11 idle slide, CLOCK-ONLY (ADR 0009) -----

test('advance(now) slides the windowed distinct-count to 0 on an idle stream', () => {
    const W = 1000;
    const s = new SlidingHyperLogLog(W, { p: 8 });
    for (let t = 0; t < 5000; t++) s.add(t, t);
    assert.ok(s.count() > 0, 'has distinct content before idle');
    s.advance(5000 + 2 * W);             // idle jump past the window
    assert.equal(s.count(), 0, 'idle slide (clock-only) empties the count');
});

test('advance() is CLOCK-ONLY: count reads correctly after advance with no add', () => {
    const W = 1000;
    const s = new SlidingHyperLogLog(W, { p: 8 });
    for (let t = 0; t < 500; t++) s.add(t, t);
    const before = s.count();
    s.advance(600);                      // window (- ,600] with W=1000 still holds everything
    assert.equal(s.count(), before, 'a within-window advance does not drop live keys');
    s.advance(1200);                     // now (200, 1200]: the first 200 keys expire
    assert.ok(s.count() < before && s.count() > 0, 'partial idle slide: ' + before + ' -> ' + s.count());
});

test('advance() does not perturb overflows / degraded (eager expiry avoided)', () => {
    const s = new SlidingHyperLogLog(1000, { p: 8 });
    for (let t = 0; t < 500; t++) s.add(t, t);
    const ov = s.overflows;
    s.advance(100000);
    assert.equal(s.overflows, ov, 'idle slide leaves the degradation signal untouched');
});

test('advance() returns this + locks EXPLICIT on UNSET', () => {
    const s = new SlidingHyperLogLog(1000, { p: 8 });
    assert.equal(s.advance(50), s);
    assert.equal(s.mode, 'explicit');
    s.add(60, 7);
    assert.equal(s.count(), 1);
    assert.throws(() => s.add(undefined, 8), /\[lite-adaptive\]/);
});

test('advance() on a COUNT-locked instance throws (EXPLICIT-only)', () => {
    const s = new SlidingHyperLogLog(1000, { p: 8 });
    s.add(undefined, 1);                 // locks COUNT
    assert.throws(() => s.advance(5), /\[lite-adaptive\]/);
});

test('advance() rejects non-finite / decreasing now as a byte-identical no-op', () => {
    const s = new SlidingHyperLogLog(1000, { p: 8 });
    s.add(100, 1);
    const snap = s.count();
    for (const bad of [NaN, Infinity, -Infinity, '10', null, undefined, {}]) {
        assert.throws(() => s.advance(bad), /\[lite-adaptive\]/, 'now=' + String(bad));
    }
    assert.throws(() => s.advance(50), /\[lite-adaptive\]/);   // decreasing
    assert.equal(s.count(), snap, 'no-op on reject');
    s.add(100, 2);                       // guard did not advance: same-now add still works
    assert.equal(s.count(), 2);
});

test('advanceFrom(buf, i) matches advance(now)', () => {
    const a = new SlidingHyperLogLog(1000, { p: 8 });
    const b = new SlidingHyperLogLog(1000, { p: 8 });
    for (let t = 0; t < 2000; t++) { a.add(t, t); b.add(t, t); }
    a.advance(2500);
    const buf = new Float64Array([0, 2500]);
    b.advanceFrom(buf, 1);
    assert.equal(a.count(), b.count());
    assert.equal(b.advanceFrom(new Float64Array([3000]), 0), b);   // chainable
});

test('advanceFrom rejects a bad buffer / index; COUNT-lock throws', () => {
    const s = new SlidingHyperLogLog(1000, { p: 8 });
    s.add(0, 1);
    const snap = s.count();
    for (const bad of [[0], 'x', null, undefined, {}, new Uint32Array([1])]) {
        assert.throws(() => s.advanceFrom(bad, 0), /\[lite-adaptive\]/);
    }
    const buf = new Float64Array([10]);
    for (const badI of [-1, 1, 1.5, '0', NaN]) {
        assert.throws(() => s.advanceFrom(buf, badI), /\[lite-adaptive\]/, 'i=' + String(badI));
    }
    assert.equal(s.count(), snap, 'no-op on reject');
    const c = new SlidingHyperLogLog(1000, { p: 8 });
    c.add(undefined, 1);
    assert.throws(() => c.advanceFrom(new Float64Array([5]), 0), /\[lite-adaptive\]/);
});
