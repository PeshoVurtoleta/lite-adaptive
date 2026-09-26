// @zakkster/lite-adaptive -- SlidingDDSketch behavioral + fail-closed suite (node:test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingDDSketch, VERSION } from '../Adaptive.js';

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
test('VERSION is 1.7.0 (DecayedReservoir milestone)', () => {
    assert.equal(VERSION, '1.7.0');
});

// ---------------------------------------------------------------------------
// ctor: fail-closed domain (typeof-first, before any allocation)
// ---------------------------------------------------------------------------
test('ctor rejects a non-number / non-positive / non-finite W', () => {
    assert.throws(() => new SlidingDDSketch('1000'), /lite-adaptive/);
    assert.throws(() => new SlidingDDSketch(0), /finite number > 0/);
    assert.throws(() => new SlidingDDSketch(-1), /finite number > 0/);
    assert.throws(() => new SlidingDDSketch(NaN), /finite number > 0/);
    assert.throws(() => new SlidingDDSketch(Infinity), /finite number > 0/);
});
test('ctor rejects a non-object options', () => {
    assert.throws(() => new SlidingDDSketch(1000, 5), /options must be an object/);
    assert.throws(() => new SlidingDDSketch(1000, null), /options must be an object/);
});
test('ctor rejects an unknown option key with a hint', () => {
    assert.throws(() => new SlidingDDSketch(1000, { bins: 10 }), /unknown option "bins"/);
});
test('ctor rejects alpha outside (0, 1)', () => {
    assert.throws(() => new SlidingDDSketch(1000, { alpha: 0 }), /alpha must be a number in \(0, 1\)/);
    assert.throws(() => new SlidingDDSketch(1000, { alpha: 1 }), /alpha must be a number in \(0, 1\)/);
    assert.throws(() => new SlidingDDSketch(1000, { alpha: -0.1 }), /alpha must be a number in \(0, 1\)/);
    assert.throws(() => new SlidingDDSketch(1000, { alpha: '0.01' }), /alpha must be a number in \(0, 1\)/);
});
test('ctor rejects a non-boolean strict (null is not false)', () => {
    assert.throws(() => new SlidingDDSketch(1000, { strict: 1 }), /strict must be a boolean/);
    assert.throws(() => new SlidingDDSketch(1000, { strict: null }), /strict must be a boolean/);
    assert.throws(() => new SlidingDDSketch(1000, { strict: 'yes' }), /strict must be a boolean/);
});
test('ctor rejects panes outside [2, 1024] / non-integer', () => {
    assert.throws(() => new SlidingDDSketch(1000, { panes: 1 }), /panes must be an integer/);
    assert.throws(() => new SlidingDDSketch(1000, { panes: 2000 }), /panes must be an integer/);
    assert.throws(() => new SlidingDDSketch(1000, { panes: 8.5 }), /panes must be an integer/);
    assert.throws(() => new SlidingDDSketch(1000, { panes: '32' }), /panes must be an integer/);
});

test('ctor FAILS CLOSED on a subnormal W (W / panes underflows to 0) -- no silent window', () => {
    // A subnormal W would underflow the per-pane width to 0 -> non-finite pane boundaries -> a silently
    // empty window. The ctor guards the derived pane width and throws instead (fail-closed Law).
    assert.throws(() => new SlidingDDSketch(Number.MIN_VALUE, { panes: 2 }),
        /\[lite-adaptive\] SlidingDDSketch W is too small/);
    // a representable small W keeps a positive pane width and constructs normally:
    const ok = new SlidingDDSketch(1e-6, { panes: 2 });
    assert.ok(ok.W === 1e-6);
});

// ---------------------------------------------------------------------------
// getters + defaults
// ---------------------------------------------------------------------------
test('getters reflect the defaults (alpha=0.01, strict=false, panes=32)', () => {
    const s = new SlidingDDSketch(1000);
    assert.equal(s.alpha, 0.01);
    assert.equal(s.strict, false);
    assert.equal(s.panes, 32);
    assert.equal(s.W, 1000);
    assert.equal(s.mode, 'unset');
    assert.equal(s.lastNow, 0);
    assert.equal(s.collapsed, false);
    // F7: the ring holds B+1 = 33 panes at defaults (panes=32). Exact byte figure:
    //   bins 33*2048*4 + 4*Int32(33) + Uint8(33) + 3*Float64(33) + scratch Float64(2048) + cut Float64(1)
    //   = 270336 + 132*3 + 33 + 264*3 + 16384 + 8 = 287949 (was 279712 at the 1.6.0 B-pane ring).
    assert.equal(s.bytes, 287949);
    assert.ok(s.bytes > 0);
    // indexable band matches lite-sketch DDSketch at alpha=0.01 (~2.2e-308, ~8.9e307).
    assert.ok(s.minIndexable > 0 && s.minIndexable < 1e-300);
    assert.ok(s.maxIndexable > 1e300 && Number.isFinite(s.maxIndexable));
});
test('empty quantile() is NaN and count() is 0 (never throws)', () => {
    const s = new SlidingDDSketch(1000);
    assert.ok(Number.isNaN(s.quantile(0.5)));
    assert.equal(s.count(), 0);
});

// ---------------------------------------------------------------------------
// add: value domain (DDSketch parity: positive + zero, negatives throw)
// ---------------------------------------------------------------------------
test('add rejects a non-number / NaN / +-Infinity value (typeof-first)', () => {
    const s = new SlidingDDSketch(1000);
    assert.throws(() => s.add(1, 'x'), /value must be a finite number >= 0/);
    assert.throws(() => s.add(1, NaN), /value must be a finite number >= 0/);
    assert.throws(() => s.add(1, Infinity), /value must be a finite number >= 0/);
    assert.throws(() => s.add(1, -Infinity), /value must be a finite number >= 0/);
});
test('add rejects a NEGATIVE value (log is undefined; positive+zero domain)', () => {
    const s = new SlidingDDSketch(1000);
    assert.throws(() => s.add(1, -5), /value must be a finite number >= 0/);
});
test('a rejected add is a byte-identical no-op (no mode lock, no state)', () => {
    const s = new SlidingDDSketch(1000);
    assert.throws(() => s.add(1, -5));
    assert.equal(s.mode, 'unset');
    assert.equal(s.count(), 0);
    assert.equal(s.lastNow, 0);
});
test('value = 0 is accepted (the smallest value) and counted', () => {
    const s = new SlidingDDSketch(1000);
    s.add(1, 0);
    assert.equal(s.count(), 1);
    assert.equal(s.quantile(0), 0);   // the sole value is 0
});
test('a value below minIndexable / above maxIndexable is rejected fail-closed (no-op)', () => {
    const s = new SlidingDDSketch(1000, { alpha: 0.01 });
    s.add(1, 100);
    const before = s.count();
    assert.throws(() => s.add(2, s.maxIndexable * 2), /outside the sketch's indexable range/);
    assert.throws(() => s.add(2, s.minIndexable / 2), /outside the sketch's indexable range/);
    assert.equal(s.count(), before);   // no-op
});

// ---------------------------------------------------------------------------
// mode lock + monotone-now guard
// ---------------------------------------------------------------------------
test('the first add(now, value) locks EXPLICIT mode; a count-mode add then throws', () => {
    const s = new SlidingDDSketch(1000);
    s.add(5, 1);
    assert.equal(s.mode, 'explicit');
    assert.equal(s.lastNow, 5);
    assert.throws(() => s.add(undefined, 2), /locked to explicit/);
});
test('the first add(undefined, value) locks COUNT mode; an explicit add then throws', () => {
    const s = new SlidingDDSketch(1000);
    s.add(undefined, 1);
    assert.equal(s.mode, 'count');
    assert.throws(() => s.add(5, 2), /locked to count/);
});
test('explicit add rejects a non-finite now', () => {
    const s = new SlidingDDSketch(1000);
    s.add(1, 1);
    assert.throws(() => s.add(NaN, 2), /now must be a finite number/);
    assert.throws(() => s.add(Infinity, 2), /now must be a finite number/);
});
test('explicit add rejects a decreasing now (monotone guard); equal is OK', () => {
    const s = new SlidingDDSketch(1000);
    s.add(10, 1);
    assert.throws(() => s.add(9, 2), /non-decreasing/);
    s.add(10, 2);   // equal timestamp allowed
    s.add(11, 3);
    assert.equal(s.lastNow, 11);
});
test('add returns this (chainable)', () => {
    const s = new SlidingDDSketch(1000);
    assert.equal(s.add(1, 1), s);
    assert.equal(s.add(2, 2).add(3, 3), s);
});

// ---------------------------------------------------------------------------
// addFrom: zero-box packed [now, value]
// ---------------------------------------------------------------------------
test('addFrom rejects a non-Float64Array buf', () => {
    const s = new SlidingDDSketch(1000);
    assert.throws(() => s.addFrom([1, 2], 0), /needs a Float64Array/);
    assert.throws(() => s.addFrom(new Float32Array(2), 0), /needs a Float64Array/);
});
test('addFrom rejects a bad index (non-integer / negative / out of range)', () => {
    const s = new SlidingDDSketch(1000);
    const buf = new Float64Array([1, 2]);
    assert.throws(() => s.addFrom(buf, 'x'), /in-bounds/);
    assert.throws(() => s.addFrom(buf, -1), /in-bounds/);
    assert.throws(() => s.addFrom(buf, 1.5), /in-bounds/);
    assert.throws(() => s.addFrom(buf, 1), /in-bounds/);   // needs i + 1 < length
});
test('addFrom rejects a negative value at buf[i+1] (byte-identical no-op)', () => {
    const s = new SlidingDDSketch(1000);
    const buf = new Float64Array([1, -3]);
    assert.throws(() => s.addFrom(buf, 0), /value must be a finite number >= 0/);
    assert.equal(s.mode, 'unset');
    assert.equal(s.count(), 0);
});
test('addFrom is EXPLICIT-time only: a count-locked instance rejects it', () => {
    const s = new SlidingDDSketch(1000);
    s.add(undefined, 1);
    const buf = new Float64Array([1, 2]);
    assert.throws(() => s.addFrom(buf, 0), /locked to count/);
});
test('the first addFrom locks EXPLICIT mode and enforces monotone now', () => {
    const s = new SlidingDDSketch(1000);
    const buf = new Float64Array([10, 1]);
    s.addFrom(buf, 0);
    assert.equal(s.mode, 'explicit');
    assert.equal(s.lastNow, 10);
    const back = new Float64Array([9, 2]);
    assert.throws(() => s.addFrom(back, 0), /non-decreasing/);
});
test('add and addFrom agree on the same [now, value] (byte-identical body)', () => {
    const a = new SlidingDDSketch(4096, { alpha: 0.01, panes: 16 });
    const b = new SlidingDDSketch(4096, { alpha: 0.01, panes: 16 });
    const buf = new Float64Array(2);
    for (let i = 1; i <= 3000; i++) {
        const v = ((i * 2654435761) % 5000) + 1;
        a.add(i, v);
        buf[0] = i; buf[1] = v;
        b.addFrom(buf, 0);
    }
    assert.equal(a.quantile(0.5), b.quantile(0.5));
    assert.equal(a.quantile(0.9), b.quantile(0.9));
    assert.equal(a.count(), b.count());
});

// ---------------------------------------------------------------------------
// windowed quantile contract (relative error + windowing)
// ---------------------------------------------------------------------------
test('quantile is alpha-accurate on the merged window vs a sorted-array oracle', () => {
    const alpha = 0.01;
    const s = new SlidingDDSketch(1e9, { alpha });   // huge W -> everything in window
    const vals = [];
    const r = mulberry32(42);
    for (let i = 0; i < 20000; i++) {
        const v = Math.exp(r() * 12);   // lognormal-ish positive spread
        s.add(i + 1, v);
        vals.push(v);
    }
    vals.sort((x, y) => x - y);
    for (const q of [0.5, 0.9, 0.99]) {
        const trueV = vals[Math.floor(q * (vals.length - 1))];
        const est = s.quantile(q);
        const rel = Math.abs(est - trueV) / trueV;
        assert.ok(rel <= alpha + 1e-9, 'q=' + q + ' est=' + est + ' true=' + trueV + ' rel=' + rel);
    }
});
test('quantile tracks a distribution SHIFT as the old values expire', () => {
    const s = new SlidingDDSketch(1000, { alpha: 0.01 });
    // regime A: values ~100 for the first 2000 ticks; regime B: values ~10000 after.
    for (let t = 1; t <= 2000; t++) s.add(t, 100 + (t % 5));
    const pA = s.quantile(0.5);
    for (let t = 2001; t <= 4000; t++) s.add(t, 10000 + (t % 5));
    const pB = s.quantile(0.5);
    assert.ok(pA > 90 && pA < 110, 'regime A p50=' + pA);
    assert.ok(pB > 9000 && pB < 11000, 'regime B p50=' + pB);   // old regime expired
});
test('count() tracks the windowed item count (edge within one pane width)', () => {
    const W = 1000, panes = 32;
    const s = new SlidingDDSketch(W, { panes });
    for (let t = 1; t <= 5000; t++) s.add(t, (t % 100) + 1);
    const c = s.count();
    const pw = W / panes;
    // one item per tick -> ~W in window, +/- one pane width.
    assert.ok(Math.abs(c - W) <= pw + 1, 'count=' + c + ' vs W=' + W + ' pw=' + pw);
});
test('a sub-window quantile(q, w) queries a smaller recent slice; count(w) too', () => {
    const s = new SlidingDDSketch(10000, { alpha: 0.01 });
    for (let t = 1; t <= 10000; t++) s.add(t, t);   // rising values 1..10000
    const full = s.quantile(0.5);
    const recent = s.quantile(0.5, 2000);   // last ~2000 ticks -> values ~8000..10000
    assert.ok(recent > full, 'recent p50=' + recent + ' full p50=' + full);
    assert.ok(s.count(2000) < s.count(), 'sub-window count < full');
});
// F12: a bad VALUE (q / w / count-window) is DATA, not a programming error -> NaN, never a throw, and
// a BYTE-IDENTICAL no-op (null is not zero: an unrepresentable window is NaN, not an under-count of 0).
const sddSnap = (s) => ({
    bins: Array.from(s._bins), offset: Array.from(s._offset), maxKeyPop: Array.from(s._maxKeyPop),
    binCount: Array.from(s._binCount), paneCollapsed: Array.from(s._paneCollapsed),
    paneCount: Array.from(s._paneCount), paneZero: Array.from(s._paneZero),
    paneEnd: Array.from(s._paneEnd), cur: s._cur, now: s._now,
});
test('F12: quantile(q) for q outside [0, 1] / NaN -> NaN, never throws, byte-identical', () => {
    const s = new SlidingDDSketch(1000);
    s.add(1, 5);
    const before = sddSnap(s);
    for (const bad of [-1, 2, -0.1, 1.1, NaN, '0.5']) {
        assert.ok(Number.isNaN(s.quantile(bad)), 'quantile(' + String(bad) + ') must be NaN');
    }
    assert.deepEqual(sddSnap(s), before, 'quantile bad-q state must be byte-identical');
});
test('F12: a bad sub-window w -> NaN for BOTH quantile and count, byte-identical', () => {
    const s = new SlidingDDSketch(1000);
    s.add(1, 5);
    const before = sddSnap(s);
    for (const bad of [0, -1, 1001, NaN, Infinity, -Infinity]) {
        assert.ok(Number.isNaN(s.quantile(0.5, bad)), 'quantile(0.5, ' + String(bad) + ') must be NaN');
        assert.ok(Number.isNaN(s.count(bad)), 'count(' + String(bad) + ') must be NaN');
    }
    assert.deepEqual(sddSnap(s), before, 'bad-window state must be byte-identical');
});
test('F12: empty-window quantile -> NaN and count() -> 0 (unchanged, never throws)', () => {
    const s = new SlidingDDSketch(1000);
    s.add(1, 5);
    s.advance(1 + 1000 + 1000 / 32);   // slide the whole window past
    assert.ok(Number.isNaN(s.quantile(0.5)), 'empty quantile is NaN');
    assert.equal(s.count(), 0, 'empty count is 0');
});

// ---------------------------------------------------------------------------
// quantileInto: 0-alloc multi-quantile render
// ---------------------------------------------------------------------------
test('quantileInto renders several quantiles into a caller buffer, matching quantile()', () => {
    const s = new SlidingDDSketch(1e9, { alpha: 0.01 });
    for (let i = 1; i <= 5000; i++) s.add(i, (i * 31) % 9973 + 1);
    const qs = Float64Array.of(0.5, 0.9, 0.99);
    const out = new Float64Array(3);
    assert.equal(s.quantileInto(qs, out), 3);
    assert.equal(out[0], s.quantile(0.5));
    assert.equal(out[1], s.quantile(0.9));
    assert.equal(out[2], s.quantile(0.99));
});
test('quantileInto writes NaN on an empty window', () => {
    const s = new SlidingDDSketch(1000);
    const out = new Float64Array(2);
    assert.equal(s.quantileInto(Float64Array.of(0.5, 0.9), out), 2);
    assert.ok(Number.isNaN(out[0]) && Number.isNaN(out[1]));
});
test('quantileInto rejects non-Float64Array args or a too-small out', () => {
    const s = new SlidingDDSketch(1000);
    s.add(1, 5);
    assert.throws(() => s.quantileInto([0.5], new Float64Array(1)), /two Float64Arrays/);
    assert.throws(() => s.quantileInto(Float64Array.of(0.5), [0]), /two Float64Arrays/);
    assert.throws(() => s.quantileInto(Float64Array.of(0.5, 0.9), new Float64Array(1)), /out.length >= qs.length/);
});

// ---------------------------------------------------------------------------
// collapse / strict parity with DDSketch
// ---------------------------------------------------------------------------
test('collapsing-lowest (default): a value range wider than one pane folds the low end, collapsed true', () => {
    // alpha=0.01 -> ~2048 bins span a ~6e17 value ratio; a wider range in one pane collapses the low end.
    const s = new SlidingDDSketch(1e12, { alpha: 0.01, panes: 2 });
    s.add(1, 1e18);         // anchors the pane window high
    s.add(1, 1);            // key ~0 falls far below the floor -> collapses into bin 0
    assert.equal(s.collapsed, true);
    // the UPPER quantile is still finite + sane (collapsing-lowest protects the tail).
    const p99 = s.quantile(0.99);
    assert.ok(Number.isFinite(p99) && p99 > 0, 'p99=' + p99);
});
test('strict mode: a value below the pane window floor throws (no collapse), state intact', () => {
    const s = new SlidingDDSketch(1e12, { alpha: 0.01, strict: true, panes: 4 });
    // anchor a pane high, then a value far below the floor would collapse -> strict throw instead.
    s.add(1, 1e100);
    const before = s.quantile(0.5);
    assert.throws(() => s.add(1, 1e-100), /strict mode/);
    // the earlier data is still queryable (the throw preceded any bin write).
    assert.equal(s.quantile(0.5), before);
});
test('strict mode: a value ABOVE the pane ceiling (slide-up) throws too -- no fail-open collapse', () => {
    // regression: the slide-up branch previously folded low-end mass + set collapsed WITHOUT throwing.
    const s = new SlidingDDSketch(2, { alpha: 0.001, strict: true, panes: 2 });
    s.add(1, 1);                                          // anchors the pane ceiling low
    assert.throws(() => s.add(1, 1000), /strict mode/);   // a slide-up that WOULD collapse must throw
    assert.equal(s.collapsed, false, 'strict must never flip collapsed true');
});
test('strict mode: a value within the pane window does NOT throw (only collapses fail closed)', () => {
    // the first value anchors the pane CEILING (collapse-lowest fills downward), so later values at or
    // BELOW it within the 2048-bucket window are accepted; only a slide (above) or a below-floor collapse throws.
    const s = new SlidingDDSketch(1e12, { alpha: 0.01, strict: true, panes: 4 });
    s.add(1, 1000);   // anchors the ceiling near key(1000)
    s.add(1, 900);    // below the ceiling, within the window -> accepted
    s.add(1, 999);    // below the ceiling, within the window -> accepted
    assert.equal(s.collapsed, false);
    assert.ok(Number.isFinite(s.quantile(0.5)));
});

// ---------------------------------------------------------------------------
// bin-count saturation (Uint32 saturate-never-wrap)
// ---------------------------------------------------------------------------
test('a bin count saturates rather than wrapping (many identical values, count stays exact)', () => {
    // Not 4 billion adds (too slow); instead assert the count() aggregate (Float64) is exact and the
    // quantile is stable over a large repeat of one value -- the saturation guard never corrupts it.
    const s = new SlidingDDSketch(1e9, { alpha: 0.01 });
    for (let i = 1; i <= 100000; i++) s.add(i, 500);   // one bucket, 100k adds
    assert.equal(s.count(), 100000);
    const p50 = s.quantile(0.5);
    assert.ok(Math.abs(p50 - 500) / 500 <= 0.01 + 1e-9, 'p50=' + p50);
});

// ---------------------------------------------------------------------------
// count mode
// ---------------------------------------------------------------------------
test('count mode: the window is the last N items', () => {
    const s = new SlidingDDSketch(1000, { alpha: 0.01, panes: 32 });
    for (let i = 0; i < 3000; i++) s.add(undefined, (i % 500) + 1);
    assert.equal(s.mode, 'count');
    const c = s.count();
    assert.ok(Math.abs(c - 1000) <= 1000 / 32 + 1, 'count-mode count=' + c);
    assert.ok(Number.isFinite(s.quantile(0.5)));
});

// ---------------------------------------------------------------------------
// huge now jump (expire all panes in a bounded loop)
// ---------------------------------------------------------------------------
test('a now jump of many pane-widths expires the whole window (bounded, correct)', () => {
    const s = new SlidingDDSketch(1000, { panes: 32 });
    for (let t = 1; t <= 1000; t++) s.add(t, 100);
    assert.ok(s.count() > 0);
    // jump far beyond W -> every prior pane expires; only the new value remains.
    s.add(1_000_000, 999);
    assert.equal(s.count(), 1);
    assert.ok(Math.abs(s.quantile(0.5) - 999) / 999 <= 0.01 + 1e-9);
});

// ---------------------------------------------------------------------------
// clear / retention / determinism
// ---------------------------------------------------------------------------
test('clear() resets to empty, unlocks the mode, and is chainable + 0-alloc-reusable', () => {
    const s = new SlidingDDSketch(1000, { alpha: 0.01 });
    for (let t = 1; t <= 2000; t++) s.add(t, t);
    assert.ok(s.count() > 0);
    assert.equal(s.clear(), s);
    assert.equal(s.mode, 'unset');
    assert.equal(s.count(), 0);
    assert.ok(Number.isNaN(s.quantile(0.5)));
    // reusable in the OTHER mode after clear
    s.add(undefined, 1);
    assert.equal(s.mode, 'count');
});
test('clear() then re-fill reproduces the same estimate (deterministic reuse)', () => {
    const s = new SlidingDDSketch(1e9, { alpha: 0.01 });
    for (let i = 1; i <= 10000; i++) s.add(i, (i * 13) % 7919 + 1);
    const first = s.quantile(0.9);
    s.clear();
    for (let i = 1; i <= 10000; i++) s.add(i, (i * 13) % 7919 + 1);
    assert.equal(s.quantile(0.9), first);
});
test('duplicate clear() (double-dispose): clearing an already-empty instance is a safe no-op', () => {
    const s = new SlidingDDSketch(1000);
    assert.equal(s.clear(), s);
    assert.equal(s.clear(), s);
    assert.equal(s.count(), 0);
    assert.equal(s.mode, 'unset');
});
test('clear() keeps `bytes` constant across cycles (reuses every array, no reallocation)', () => {
    const s = new SlidingDDSketch(1000, { alpha: 0.01, panes: 16 });
    const bytes0 = s.bytes;
    for (let cyc = 0; cyc < 5; cyc++) {
        for (let t = 1; t <= 500; t++) s.add(t, t + 1);
        assert.equal(s.bytes, bytes0, 'bytes drifted after fill on cycle ' + cyc);
        s.clear();
        assert.equal(s.bytes, bytes0, 'bytes drifted after clear on cycle ' + cyc);
        assert.ok(Number.isNaN(s.quantile(0.5)));
    }
});

// ---------------------------------------------------------------------------
// BOUNDARY MATRIX -- 0 / 1 / N-1 / N / N+1, empty, null, undefined, NaN, -0,
// duplicate dispose, dispose-during-iteration, re-entrant write, adversarial.
// ---------------------------------------------------------------------------

// -- panes: N (min=2) / N (max=1024) exact-boundary ACCEPT; N+1 (1025) exact-boundary REJECT --
test('panes accepts the exact boundary values 2 (min) and 1024 (max)', () => {
    const lo = new SlidingDDSketch(1000, { panes: 2 });
    assert.equal(lo.panes, 2);
    const hi = new SlidingDDSketch(1000, { panes: 1024 });
    assert.equal(hi.panes, 1024);
});
test('panes rejects the exact boundary values 1 (min-1) and 1025 (max+1)', () => {
    assert.throws(() => new SlidingDDSketch(1000, { panes: 1 }), /panes must be an integer/);
    assert.throws(() => new SlidingDDSketch(1000, { panes: 1025 }), /panes must be an integer/);
});

// -- -0: value / now / q are accepted (numeric -0 === 0, not a distinct state); alpha / w reject
//    -0 identically to 0 (>0 / >0 both false for -0) -- "null is not zero", but -0 IS zero here.
test('value = -0 is accepted identically to value = 0 (the smallest value)', () => {
    const s = new SlidingDDSketch(1000);
    s.add(1, -0);
    assert.equal(s.count(), 1);
    assert.equal(s.quantile(0), 0);
});
test('now = -0 is accepted as the anchor time (numeric -0 === 0, no distinct state)', () => {
    const s = new SlidingDDSketch(1000);
    s.add(-0, 5);
    assert.equal(s.mode, 'explicit');
    assert.equal(s.lastNow, -0);
    assert.ok(s.count() === 1);
});
test('q = -0 is accepted identically to q = 0 (a valid quantile query, not a boundary reject)', () => {
    const s = new SlidingDDSketch(1000);
    s.add(1, 5);
    assert.equal(s.quantile(-0), s.quantile(0));
});
test('alpha = -0 is rejected identically to alpha = 0 (-0 > 0 is false)', () => {
    assert.throws(() => new SlidingDDSketch(1000, { alpha: -0 }), /alpha must be a number in \(0, 1\)/);
});
test('a sub-window w = -0 is rejected identically to w = 0 (-0 > 0 is false) -> NaN (F12)', () => {
    const s = new SlidingDDSketch(1000);
    s.add(1, 5);
    assert.ok(Number.isNaN(s.quantile(0.5, -0)));
    assert.ok(Number.isNaN(s.count(-0)));
});

// -- sub-window w exact upper boundary: w === W must behave exactly like the omitted (full) window --
test('a sub-window w === W (the exact upper boundary) matches the full-window query', () => {
    const s = new SlidingDDSketch(2000, { alpha: 0.01 });
    for (let t = 1; t <= 2000; t++) s.add(t, t);
    assert.equal(s.quantile(0.5, 2000), s.quantile(0.5));
    assert.equal(s.count(2000), s.count());
});

// -- q exact boundaries 0 and 1 both accepted (never throw, [0, 1] is INCLUSIVE both ends) --
test('quantile accepts the exact boundary q values 0 and 1 without throwing', () => {
    const s = new SlidingDDSketch(1000, { alpha: 0.01 });
    for (let t = 1; t <= 500; t++) s.add(t, t);
    assert.ok(Number.isFinite(s.quantile(0)));
    assert.ok(Number.isFinite(s.quantile(1)));
});

// -- addFrom: bad buffer / bad index / NaN-in-buf are BYTE-IDENTICAL no-ops (not just "throws") --
test('addFrom bad buffer/index is a byte-identical no-op (mode/count/lastNow untouched)', () => {
    const s = new SlidingDDSketch(1000);
    s.add(5, 1);   // establish real state to prove nothing after this is disturbed
    const modeBefore = s.mode, countBefore = s.count(), lastNowBefore = s.lastNow;
    assert.throws(() => s.addFrom([1, 2], 0));
    assert.throws(() => s.addFrom(new Float32Array(2), 0));
    assert.throws(() => s.addFrom(new Float64Array([1, 2]), 'x'));
    assert.throws(() => s.addFrom(new Float64Array([1, 2]), -1));
    assert.throws(() => s.addFrom(new Float64Array([1, 2]), 1));
    assert.equal(s.mode, modeBefore);
    assert.equal(s.count(), countBefore);
    assert.equal(s.lastNow, lastNowBefore);
});
test('addFrom rejects NaN in either packed slot (byte-identical no-op)', () => {
    const s = new SlidingDDSketch(1000);
    s.add(5, 1);
    const countBefore = s.count(), lastNowBefore = s.lastNow;
    assert.throws(() => s.addFrom(new Float64Array([NaN, 2]), 0), /now must be a finite number/);
    assert.throws(() => s.addFrom(new Float64Array([10, NaN]), 0), /value must be a finite number >= 0/);
    assert.equal(s.count(), countBefore);
    assert.equal(s.lastNow, lastNowBefore);
});

// -- monotone-now decrease: a rejected add is a TRUE byte-identical no-op (time does NOT advance) --
test('a decreasing now is rejected as a byte-identical no-op: lastNow/count/mode never move', () => {
    const s = new SlidingDDSketch(1000);
    s.add(10, 1);
    const countBefore = s.count(), lastNowBefore = s.lastNow, modeBefore = s.mode;
    assert.throws(() => s.add(9, 2), /non-decreasing/);
    assert.equal(s.lastNow, lastNowBefore, 'monotone reject must NOT advance lastNow');
    assert.equal(s.count(), countBefore);
    assert.equal(s.mode, modeBefore);
});

// -- strict collapse: byte-identical quantile/count state on BOTH directions, `collapsed` stays false,
//    and the documented exception (time model DOES advance on a strict reject) is exactly what happens --
test('strict below-floor collapse: quantile/count byte-identical, collapsed stays false, time model DOES advance', () => {
    const s = new SlidingDDSketch(1e12, { alpha: 0.01, strict: true, panes: 4 });
    s.add(1, 1e100);
    const countBefore = s.count(), qBefore = s.quantile(0.5);
    assert.throws(() => s.add(5, 1e-100), /strict mode/);
    assert.equal(s.count(), countBefore, 'count must be untouched by a strict reject');
    assert.equal(s.quantile(0.5), qBefore, 'quantile state must be untouched by a strict reject');
    assert.equal(s.collapsed, false, 'strict must never flip collapsed true');
    // the documented exception: the time model is monotone + value-independent, so it legitimately
    // advances on every add attempt (including a rejected one) -- confirm lastNow moved to the new now.
    assert.equal(s.lastNow, 5, 'a strict reject still advances the time model (documented ADR exception)');
});
test('strict slide-up collapse: quantile/count byte-identical, collapsed stays false', () => {
    const s = new SlidingDDSketch(2, { alpha: 0.001, strict: true, panes: 2 });
    s.add(1, 1);
    const countBefore = s.count(), qBefore = s.quantile(0.5);
    assert.throws(() => s.add(1, 1000), /strict mode/);
    assert.equal(s.count(), countBefore);
    assert.equal(s.quantile(0.5), qBefore);
    assert.equal(s.collapsed, false, 'strict must never flip collapsed true');
});

// -- non-strict collapse sets `collapsed` in BOTH directions (below-floor already covered above by the
//    "collapsing-lowest (default)" test; this adds the SLIDE-UP direction, which was the regression) --
test('non-strict slide-up ALSO collapses the low end and sets collapsed=true (not just below-floor)', () => {
    const s = new SlidingDDSketch(1e12, { alpha: 0.01, panes: 2, strict: false });
    s.add(1, 1);          // anchors the pane ceiling LOW
    assert.equal(s.collapsed, false);
    s.add(1, 1e18);        // far ABOVE the ceiling -> slide-up folds the low end
    assert.equal(s.collapsed, true, 'a non-strict slide-up must fold + flag collapsed, never fail-open silently');
    assert.ok(Number.isFinite(s.quantile(0.99)));
});

// -- SLD_KEY_MAX: at a pathologically small alpha the indexable band is capped well below what the
//    double-overflow bound alone would allow -- proving SLD_KEY_MAX (not just Number.MAX_VALUE) is the
//    active fail-closed cap, and a value beyond it is rejected (byte-identical no-op), never a silent
//    write past the Int32 offset / bin array. --
test('SLD_KEY_MAX caps the indexable band at a pathologically small alpha (not a silent Int32 overflow)', () => {
    const s = new SlidingDDSketch(1000, { alpha: 1e-7 });
    // Without the SLD_KEY_MAX intersection, a double can index up to ~8.9e307-scale magnitudes even at
    // this alpha; WITH the cap the band collapses to a tiny fraction of that -- proving it is load-bearing.
    assert.ok(s.maxIndexable < 1e100, 'maxIndexable=' + s.maxIndexable + ' -- SLD_KEY_MAX cap not active');
    assert.ok(s.maxIndexable > 0 && Number.isFinite(s.maxIndexable));
    const before = s.count();
    assert.throws(() => s.add(1, s.maxIndexable * 10), /outside the sketch's indexable range/);
    assert.equal(s.count(), before, 'a key beyond SLD_KEY_MAX must be a byte-identical no-op');
});

// -- Uint32 saturation (white-box, NIT-1): a bin at 0xFFFFFFFF clamps and never wraps, and paneCount is
//    gated on the SAME saturation check so the tracked total never drifts past the histogram mass. --
test('a bin count at 0xFFFFFFFF saturates without wrapping; paneCount stays gated on the same check', () => {
    const s = new SlidingDDSketch(1e9, { alpha: 0.01, panes: 2 });
    s.add(1, 500);
    const cur = s._cur, maxBins = s._maxBins, base = cur * maxBins;
    const k = Math.ceil(Math.log(500) * s._multiplier);
    const idx = k - s._offset[cur];
    s._bins[base + idx] = 4294967295;             // force the saturation boundary (white-box)
    const countBefore = s._paneCount[cur];
    s.add(1, 500);                                 // same bucket -- would wrap to 0 if the guard regressed
    assert.equal(s._bins[base + idx], 4294967295, 'bin must clamp at 0xFFFFFFFF, never wrap');
    assert.equal(s._paneCount[cur], countBefore, 'paneCount must not drift past the histogram mass');
});

// -- a now-jump of astronomically many pane-widths is BOUNDED (capped at `panes` rotations), not a
//    per-pane-width loop: it must complete near-instantly and clear at most `panes` panes. --
test('an astronomically large now jump is bounded (capped at panes rotations, not O(jump))', () => {
    const s = new SlidingDDSketch(1000, { panes: 32 });
    for (let t = 1; t <= 1000; t++) s.add(t, 100);
    const t0 = performance.now();
    s.add(1e15, 999);   // a jump of ~1e12 pane-widths -- must NOT loop that many times
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 50, 'a bounded rotate must not scale with the jump size, took ' + elapsed + 'ms');
    assert.equal(s.count(), 1, 'only the new value survives an all-panes-expired jump');
    const p50 = s.quantile(0.5);
    assert.ok(Math.abs(p50 - 999) / 999 <= 0.01 + 1e-9, 'p50=' + p50);
});

// -- re-entrant-write-style hazard: quantileInto(qs, out) with qs AND out THE SAME array (the caller
//    aliases the query list with the receiving buffer) must not corrupt results (read-then-write per
//    index, never a cross-index clobber). --
test('quantileInto tolerates qs and out being the SAME aliased array (read-before-write per index)', () => {
    const s = new SlidingDDSketch(1e9, { alpha: 0.01 });
    for (let i = 1; i <= 2000; i++) s.add(i, (i * 13) % 997 + 1);
    const expected = [s.quantile(0.5), s.quantile(0.9), s.quantile(0.99)];
    const buf = Float64Array.of(0.5, 0.9, 0.99);
    const n = s.quantileInto(buf, buf);
    assert.equal(n, 3);
    assert.equal(buf[0], expected[0]);
    assert.equal(buf[1], expected[1]);
    assert.equal(buf[2], expected[2]);
});

// -- ADVERSARIAL (not planner-anticipated): quantile()/count() validate q/w BEFORE the empty-window
//    short-circuit, so a bad w/q resolves to NaN (F12) even on a totally fresh (never-added-to)
//    instance -- distinct from a valid q/w which returns the empty-window NaN/0 answer. --
test('ADVERSARIAL: quantile/count validate q/w BEFORE the empty-window short-circuit (bad args -> NaN, F12)', () => {
    const s = new SlidingDDSketch(1000);   // mode is 'unset', nothing ever added
    assert.ok(Number.isNaN(s.quantile(0.5, -5)));
    assert.ok(Number.isNaN(s.quantile(0.5, 2000)));
    assert.ok(Number.isNaN(s.quantile(1.5)));
    assert.ok(Number.isNaN(s.count(-5)));
    // a VALID q/w on the same empty instance correctly falls through to NaN / 0, never a throw.
    assert.ok(Number.isNaN(s.quantile(0.5)));
    assert.equal(s.count(500), 0);
});

// --- advance() / advanceFrom() -- the R11 idle slide, pane rotate (ADR 0009) ----

test('advance(now) slides the sketch to empty (count 0, quantile NaN) on idle', () => {
    const W = 1000;
    const s = new SlidingDDSketch(W, { alpha: 0.01 });
    for (let t = 0; t < 5000; t++) s.add(t, (t % 100) + 1);
    assert.ok(s.count() > 0 && Number.isFinite(s.quantile(0.5)), 'has content before idle');
    s.advance(5000 + 2 * W);             // idle jump past the window -> all panes rotate out
    assert.equal(s.count(), 0, 'idle slide empties the count');
    assert.ok(Number.isNaN(s.quantile(0.5)), 'idle slide -> NaN quantile');
});

test('advance(now) partial slide rotates only the stale panes', () => {
    const s = new SlidingDDSketch(1000, { alpha: 0.01 });
    for (let t = 0; t < 2000; t++) s.add(t, (t % 100) + 1);
    const before = s.count();
    s.advance(2500);                     // window (1500, 2500]: ~half the panes rotate out
    const after = s.count();
    assert.ok(after < before && after > 0, 'partial idle slide: ' + before + ' -> ' + after);
});

test('advance() returns this + locks EXPLICIT + anchors on UNSET', () => {
    const s = new SlidingDDSketch(1000, { alpha: 0.01 });
    assert.equal(s.advance(50), s);
    assert.equal(s.mode, 'explicit');
    s.add(60, 5);
    assert.equal(s.count(), 1);
    assert.ok(Number.isFinite(s.quantile(0.5)));
    assert.throws(() => s.add(undefined, 5), /\[lite-adaptive\]/);   // count add rejected
});

test('advance() on a COUNT-locked instance throws (EXPLICIT-only)', () => {
    const s = new SlidingDDSketch(1000, { alpha: 0.01 });
    s.add(undefined, 5);                 // locks COUNT
    assert.throws(() => s.advance(5), /\[lite-adaptive\]/);
});

test('advance() rejects non-finite / decreasing now as a byte-identical no-op', () => {
    const s = new SlidingDDSketch(1000, { alpha: 0.01 });
    s.add(100, 5);
    const snap = s.count();
    for (const bad of [NaN, Infinity, -Infinity, '10', null, undefined, {}]) {
        assert.throws(() => s.advance(bad), /\[lite-adaptive\]/, 'now=' + String(bad));
    }
    assert.throws(() => s.advance(50), /\[lite-adaptive\]/);   // decreasing
    assert.equal(s.count(), snap, 'no-op on reject');
    s.add(100, 5);                       // guard did not advance
    assert.equal(s.count(), snap + 1);
});

test('advanceFrom(buf, i) matches advance(now)', () => {
    const a = new SlidingDDSketch(1000, { alpha: 0.01 });
    const b = new SlidingDDSketch(1000, { alpha: 0.01 });
    for (let t = 0; t < 2000; t++) { a.add(t, (t % 100) + 1); b.add(t, (t % 100) + 1); }
    a.advance(2500);
    const buf = new Float64Array([0, 2500]);
    b.advanceFrom(buf, 1);
    assert.equal(a.count(), b.count());
    assert.equal(a.quantile(0.5), b.quantile(0.5));
    assert.equal(b.advanceFrom(new Float64Array([3000]), 0), b);   // chainable
});

test('advanceFrom rejects a bad buffer / index; COUNT-lock throws', () => {
    const s = new SlidingDDSketch(1000, { alpha: 0.01 });
    s.add(0, 5);
    const snap = s.count();
    for (const bad of [[0], 'x', null, undefined, {}, new Uint32Array([1])]) {
        assert.throws(() => s.advanceFrom(bad, 0), /\[lite-adaptive\]/);
    }
    const buf = new Float64Array([10]);
    for (const badI of [-1, 1, 1.5, '0', NaN]) {
        assert.throws(() => s.advanceFrom(buf, badI), /\[lite-adaptive\]/, 'i=' + String(badI));
    }
    assert.equal(s.count(), snap, 'no-op on reject');
    const c = new SlidingDDSketch(1000, { alpha: 0.01 });
    c.add(undefined, 5);
    assert.throws(() => c.advanceFrom(new Float64Array([5]), 0), /\[lite-adaptive\]/);
});

// ---------------------------------------------------------------------------
// F2 (1.7.0): strict span-based re-anchor + declared range (lite-sketch parity)
// ---------------------------------------------------------------------------

// A geometric RAMP inside one pane: strict must NEVER throw and NEVER collapse (the span stays well
// under maxBins), re-anchoring the window up on every rising key. count() == the number of adds.
test('F2 strict ramp: a rising geometric stream never throws / never collapses (span re-anchor up)', () => {
    const s = new SlidingDDSketch(1e6, { alpha: 0.01, strict: true });
    let adds = 0, thrown = 0;
    for (let v = 1; v < 1e3; v *= 1.05) { try { s.add(adds, v); adds++; } catch (e) { thrown++; } }
    s.add(adds, 1e3); adds++;
    assert.equal(thrown, 0, 'no strict throw on a ramp that fits maxBins');
    assert.equal(s.collapsed, false, 'strict never collapses');
    assert.equal(s.count(), adds, 'count() == the number of adds');
});

// A FALLING stream: a bottom anchor would move the bug here (it does not). Strict must not throw --
// the top-anchor first value leaves the whole window below it for the descending keys to fill.
test('F2 strict falling: a descending stream never throws (not a bottom anchor)', () => {
    const s = new SlidingDDSketch(1e6, { alpha: 0.01, strict: true });
    let adds = 0, thrown = 0, t = 0;
    for (let v = 1e3; v > 1; v /= 1.05) { try { s.add(t++, v); adds++; } catch (e) { thrown++; } }
    s.add(t, 1); adds++;
    assert.equal(thrown, 0, 'no strict throw on a falling stream');
    assert.equal(s.collapsed, false, 'strict never collapses');
    assert.equal(s.count(), adds);
});

// The REAL strict collapse: a key whose occupied span (low end derived lazily .. maxKeyPop) would
// exceed maxBins throws tagged, and every column of pane state (+ a quantile) is byte-identical.
test('F2 strict real-collapse: a span > maxBins throws tagged, byte-identical no-op', () => {
    const s = new SlidingDDSketch(1e6, { alpha: 0.01, strict: true });
    // seed a tiny value then a huge value: the key span far exceeds 2048 buckets in one pane.
    s.add(0, 1e-3);
    s.add(1, 5);
    const snap = () => ({
        bins: Array.from(s._bins),
        paneCount: Array.from(s._paneCount),
        paneZero: Array.from(s._paneZero),
        offset: Array.from(s._offset),
        maxKeyPop: Array.from(s._maxKeyPop),
        paneCollapsed: Array.from(s._paneCollapsed),
        q: s.quantile(0.5),
    });
    const before = snap();
    // the tag is anchored at the START of the message (assert.throws matches a RegExp against
    // String(error), which is "RangeError: ..."-prefixed, so assert on error.message directly).
    assert.throws(() => s.add(2, 1e15), (e) => /^\[lite-adaptive\]/.test(e.message),
        'a span-exceeding key fails closed');
    const after = snap();
    assert.deepEqual(after.bins, before.bins, '_bins byte-identical across the throw');
    assert.deepEqual(after.paneCount, before.paneCount, '_paneCount byte-identical');
    assert.deepEqual(after.paneZero, before.paneZero, '_paneZero byte-identical');
    assert.deepEqual(after.offset, before.offset, '_offset byte-identical');
    assert.deepEqual(after.maxKeyPop, before.maxKeyPop, '_maxKeyPop byte-identical');
    assert.deepEqual(after.paneCollapsed, before.paneCollapsed, '_paneCollapsed byte-identical');
    assert.ok(Object.is(after.q, before.q), 'quantile(0.5) byte-identical');
    assert.equal(s.collapsed, false, 'strict never collapses even on the rejected add');
});

// A DECLARED range [1, 1e3] derives strict, fixes the bin band, and rejects out-of-band values. The
// boundary values 0.99 / 1001 share the floor / ceiling LOG-BUCKET with 1 / 1000 (lite-sketch
// key-band parity) and are accepted; a value a full bucket outside is rejected as a byte-identical no-op.
test('F2 declared range: accepts the band, rejects out-of-band, getters exact', () => {
    const s = new SlidingDDSketch(1000, { range: [1, 1e3] });
    assert.equal(s.strict, true, 'a declared range derives strict');
    assert.equal(s.rangeMin, 1);
    assert.equal(s.rangeMax, 1e3);
    assert.equal(s.collapsed, false);
    let t = 0;
    for (const v of [1, 1e3, 2, 500, 999.5, 1.5]) s.add(t++, v);   // in-band accepts
    const n = s.count();
    for (const bad of [0.5, 2000, 0.001, 5000]) {                  // clearly out-of-band rejects
        const before = { count: s.count(), q: s.quantile(0.5), collapsed: s.collapsed };
        assert.throws(() => s.add(t, bad), /outside the declared strict range \[1, 1000\]/, 'value=' + bad);
        assert.equal(s.count(), before.count, 'count byte-identical after reject on ' + bad);
        assert.ok(Object.is(s.quantile(0.5), before.q), 'quantile byte-identical after reject on ' + bad);
        assert.equal(s.collapsed, before.collapsed, 'collapsed byte-identical after reject on ' + bad);
    }
    assert.equal(s.count(), n, 'no rejected add mutated the count');
    assert.equal(s.collapsed, false, 'a declared range never collapses');
});

// range with strict:false is a contradiction; a range NaN-getter parity on a non-range instance.
test('F2 declared range: strict:false contradiction throws; non-range rangeMin/Max are NaN', () => {
    assert.throws(() => new SlidingDDSketch(1000, { range: [1, 1e3], strict: false }),
        /range implies strict/, 'range + strict:false contradicts');
    const ns = new SlidingDDSketch(1000, { alpha: 0.01 });
    assert.ok(Number.isNaN(ns.rangeMin) && Number.isNaN(ns.rangeMax), 'non-range range* is NaN, not 0');
    const st = new SlidingDDSketch(1000, { alpha: 0.01, strict: true });
    assert.ok(Number.isNaN(st.rangeMin) && Number.isNaN(st.rangeMax), 'strict-without-range range* is NaN');
});

// Bad ranges fail closed BEFORE allocation (typeof-first): non-array, wrong length, non-positive min,
// min >= max, NaN / Infinity ends, and a band too wide for maxBins.
test('F2 declared range: malformed ranges throw before allocation', () => {
    const bad = [
        5, 'x', null, [1], [1, 2, 3], [0, 1], [-1, 1], [2, 1], [1, 1],
        [NaN, 1], [1, NaN], [Infinity, 2], [1, Infinity], [1, -Infinity],
        ['1', 2], [1, '2'], [1e-100, 1e100],
    ];
    for (const range of bad) {
        assert.throws(() => new SlidingDDSketch(1000, { range }), /\[lite-adaptive\]/,
            'range=' + JSON.stringify(range));
    }
});

// BAND PARITY: minIndexable / maxIndexable are ALPHA-ONLY -- Object.is-identical across non-strict /
// strict / range, and equal lite-sketch DDSketch's formula. The expected values below are computed
// FROM lite-sketch's Sketch.js formula (~933-940, 976-977; lite-sketch is not installed):
//   gamma=(1+alpha)/(1-alpha); mult=1/ln(gamma); MIN_NORMAL=2**-1022; lnHalf=ln((gamma+1)/2)
//   maxKey=floor((ln(MAX_VALUE)+lnHalf)/ln(gamma)) then tighten while !finite(2*gamma^maxKey/(gamma+1))
//   minKey=ceil((ln(MIN_NORMAL)+lnHalf)/ln(gamma)) then tighten while 2*gamma^minKey/(gamma+1)<MIN_NORMAL
//   minIndexable=gamma^(minKey-1); maxIndexable=gamma^maxKey.
test('F2 band parity: minIndexable/maxIndexable are alpha-only across modes and equal lite-sketch', () => {
    const EXPECTED = {
        0.001: { min: 2.2254797493030344e-308, max: 8.976524795746121e+307, range: [1, 50] },
        0.01:  { min: 2.2091206902522135e-308, max: 8.935331081551161e+307, range: [1, 1000] },
        0.1:   { min: 2.290233232818215e-308,  max: 7.972064703069474e+307, range: [1, 1000] },
    };
    for (const key of Object.keys(EXPECTED)) {
        const alpha = Number(key), e = EXPECTED[key];
        const ns = new SlidingDDSketch(1000, { alpha });
        const st = new SlidingDDSketch(1000, { alpha, strict: true });
        const rg = new SlidingDDSketch(1000, { alpha, range: e.range });
        for (const s of [ns, st, rg]) {
            assert.ok(Object.is(s.minIndexable, e.min), 'minIndexable alpha=' + alpha);
            assert.ok(Object.is(s.maxIndexable, e.max), 'maxIndexable alpha=' + alpha);
        }
        assert.ok(Object.is(ns.minIndexable, st.minIndexable) && Object.is(st.minIndexable, rg.minIndexable),
            'minIndexable identical across modes at alpha=' + alpha);
        assert.ok(Object.is(ns.maxIndexable, st.maxIndexable) && Object.is(st.maxIndexable, rg.maxIndexable),
            'maxIndexable identical across modes at alpha=' + alpha);
    }
});

// --- 1.7.0 step-2 QA boundary case (F2 span-based strict, exact maxBins edge) ---

test('F2 strict span edge: span 2048 accepted (alternating extremes), 2049 throws byte-identically, pane rotation re-admits it', () => {
    const alpha = 0.01, gamma = (1 + alpha) / (1 - alpha);
    const v = (key) => Math.pow(gamma, key - 0.5);       // ceil(log_gamma(v)) === key
    const s = new SlidingDDSketch(100, { alpha, strict: true, panes: 4 });
    const k0 = 10;
    for (let i = 0; i < 50; i++) { s.add(0, v(k0)); s.add(0, v(k0 + 2047)); }   // span exactly 2048
    assert.equal(s.count(), 100);
    assert.equal(s.collapsed, false);
    const snap = () => ({ bins: Array.from(s._bins), paneCount: Array.from(s._paneCount),
        offset: Array.from(s._offset), maxKeyPop: Array.from(s._maxKeyPop), q: s.quantile(0.5) });
    const before = snap();
    assert.throws(() => s.add(0, v(k0 + 2048)), (e) => /^\[lite-adaptive\]/.test(e.message));
    assert.throws(() => s.add(0, v(k0 - 1)), (e) => /^\[lite-adaptive\]/.test(e.message));
    const after = snap();
    assert.deepEqual(after.bins, before.bins);
    assert.deepEqual(after.paneCount, before.paneCount);
    assert.deepEqual(after.offset, before.offset);
    assert.deepEqual(after.maxKeyPop, before.maxKeyPop);
    assert.ok(Object.is(after.q, before.q));
    s.advance(1000);                                     // the old pane rotates out
    s.add(1000, v(k0 + 2048));                           // a fresh pane accepts the same key
    assert.equal(s.count(), 1);
});

// ---------------------------------------------------------------------------
// 1.7.0 QA adversarial (a): W not divisible by panes (W=1000, panes=7) with
// fractional timestamps landing EXACTLY on pane boundaries -- the F7 true-window
// bound (true(W) <= count() <= true(W + W/B)) must hold at every single step,
// not just in aggregate over a long run.
// ---------------------------------------------------------------------------
test('ADVERSARIAL (a): W=1000 panes=7 (non-divisible) + fractional on-boundary timestamps -- ' +
    'count() true-window bound holds at EVERY step', () => {
    const W = 1000, panes = 7, alpha = 0.01;
    const pw = W / panes;                                // 142.857142857... (fractional pane width)
    assert.ok(!Number.isInteger(pw), 'sanity: W/panes must be fractional for this adversarial case');
    const s = new SlidingDDSketch(W, { alpha, panes });
    const rnd = mulberry32(0xA0A0A0A);
    const events = [];                                   // true event log: {t, v}
    let now = 0;
    let steps = 0;
    for (let i = 0; i < 5000; i++) {
        // land exactly on a pane boundary every step (a multiple of the fractional pane width)
        now = i * pw;
        // interleave: some steps add 0, 1, or several events at the SAME boundary instant
        const n = i % 5 === 0 ? 0 : 1 + (i % 3);
        for (let j = 0; j < n; j++) {
            const val = Math.exp(rnd() * 6) + 1e-6;
            s.add(now, val);
            events.push(now);
        }
        if (n === 0) continue;                           // count() only defined meaningfully post-add
        steps++;
        let trueW = 0, trueWB = 0;
        for (const t of events) {
            if (t > now - W && t <= now) trueW++;
            if (t > now - W - pw && t <= now) trueWB++;
        }
        const c = s.count();
        assert.ok(c >= trueW,
            'count() ' + c + ' < true(W) ' + trueW + ' at step ' + i + ' (now=' + now + ')');
        assert.ok(c <= trueWB,
            'count() ' + c + ' > true(W+W/B) ' + trueWB + ' at step ' + i + ' (now=' + now + ')');
    }
    assert.ok(steps > 100, 'sanity: enough steps exercised (' + steps + ')');
});
