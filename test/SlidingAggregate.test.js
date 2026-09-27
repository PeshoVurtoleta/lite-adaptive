// @zakkster/lite-adaptive -- SlidingAggregate T1 (ctor / doors / getters / helpers / throwers) + T2
// (add / addFrom / advance / advanceFrom). The readers (count/sum/mean/min/max/into) are T3 and are
// NOT exercised here; where a test must observe state it reads the internal typed arrays directly
// (this._store stride 5 = [count, sum, kcomp, min, max], this._paneEnd, this._cur/_mode/_now/_lastNow).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingAggregate } from '../Adaptive.js';

const STRIDE = 5;

// ---- helpers ---------------------------------------------------------------

/** A full snapshot of every internal typed array + scalar field (for the byte-identical-no-op proof). */
function snap(sa) {
    return {
        store: Float64Array.from(sa._store),
        paneEnd: Float64Array.from(sa._paneEnd),
        cur: sa._cur, mode: sa._mode, tick: sa._tick, lastNow: sa._lastNow, now: sa._now,
    };
}

/** Assert two snapshots are byte-identical (Object.is on every slot -- catches a stray -0 / NaN write). */
function assertSame(a, b, msg) {
    assert.equal(a.store.length, b.store.length, msg + ': store length');
    for (let i = 0; i < a.store.length; i++) {
        assert.ok(Object.is(a.store[i], b.store[i]), msg + ': store[' + i + '] ' + a.store[i] + ' != ' + b.store[i]);
    }
    for (let i = 0; i < a.paneEnd.length; i++) {
        assert.ok(Object.is(a.paneEnd[i], b.paneEnd[i]), msg + ': paneEnd[' + i + ']');
    }
    assert.equal(a.cur, b.cur, msg + ': _cur');
    assert.equal(a.mode, b.mode, msg + ': _mode');
    assert.equal(a.tick, b.tick, msg + ': _tick');
    assert.ok(Object.is(a.lastNow, b.lastNow), msg + ': _lastNow');
    assert.ok(Object.is(a.now, b.now), msg + ': _now');
}

/** Assert `fn` throws and leaves `sa` byte-identical (a rejected op is a no-op). */
function rejectsNoOp(sa, fn, re, msg) {
    const before = snap(sa);
    assert.throws(fn, re, msg + ': should throw');
    assertSame(before, snap(sa), msg + ': state after reject');
}

/** Read the current pane's stride slot as [count, sum, kcomp, min, max]. */
function curSlot(sa) {
    const b = sa._cur * STRIDE, s = sa._store;
    return [s[b], s[b + 1], s[b + 2], s[b + 3], s[b + 4]];
}

/** Covered count over the live panes (paneEnd > now - w), skipping count===0 -- the reader contract. */
function coveredCount(sa, w) {
    const eff = w === undefined ? sa._W : w;
    const cut = sa._now - eff;
    let count = 0;
    for (let p = 0; p < sa._ring; p++) {
        if (!(sa._paneEnd[p] > cut)) continue;
        const c = sa._store[p * STRIDE];
        if (c === 0) continue;
        count += c;
    }
    return count;
}

/** Covered plain sum over the live panes (integer test values only -> Kahan comp is exactly 0). */
function coveredSum(sa) {
    const cut = sa._now - sa._W;
    let sum = 0;
    for (let p = 0; p < sa._ring; p++) {
        if (!(sa._paneEnd[p] > cut)) continue;
        if (sa._store[p * STRIDE] === 0) continue;
        sum += sa._store[p * STRIDE + 1];
    }
    return sum;
}

// ============================ T1: ctor / doors ==============================

test('T1 ctor: valid W builds; getters report W / panes / bytes / mode / lastNow', () => {
    const sa = new SlidingAggregate(1000);
    assert.equal(sa.W, 1000);
    assert.equal(sa.panes, 32);              // default
    assert.equal(sa.bytes, 1584);            // (32+1) * 48
    assert.equal(sa.mode, 'unset');
    assert.equal(sa.lastNow, 0);             // 0 before the first add
});

test('T1 bytes: 1584 at defaults, 144 at panes 2, (B+1)*48 in general', () => {
    assert.equal(new SlidingAggregate(1000).bytes, 1584);
    assert.equal(new SlidingAggregate(1000, { panes: 2 }).bytes, 144);   // 3 * 48
    assert.equal(new SlidingAggregate(1000, { panes: 1024 }).bytes, 1025 * 48);
});

test('T1 _initState: every pane starts at identity sentinels (count/sum/kcomp 0, min +Inf, max -Inf)', () => {
    const sa = new SlidingAggregate(100, { panes: 4 });
    for (let p = 0; p < sa._ring; p++) {
        const b = p * STRIDE;
        assert.equal(sa._store[b], 0, 'count');
        assert.equal(sa._store[b + 1], 0, 'sum');
        assert.equal(sa._store[b + 2], 0, 'kcomp');
        assert.equal(sa._store[b + 3], Infinity, 'min identity');
        assert.equal(sa._store[b + 4], -Infinity, 'max identity');
    }
    assert.equal(sa._paneEnd.every((x) => x === 0), true);
});

test('T1 ctor rejects a bad W (RangeError), byte 0 before alloc', () => {
    for (const W of [0, -1, NaN, Infinity, -Infinity, '5', undefined, null]) {
        assert.throws(() => new SlidingAggregate(W), /W must be a finite number > 0/, 'W=' + String(W));
    }
});

test('T1 ctor rejects a bad panes (RangeError, integer in [2, 1024])', () => {
    for (const p of [1, 0, -3, 1025, 2.5, NaN, Infinity, '32']) {
        assert.throws(() => new SlidingAggregate(1000, { panes: p }),
            /panes must be an integer in \[2, 1024\]/, 'panes=' + String(p));
    }
});

test('T1 option door: unknown key throws with a did-you-mean; non-plain bag throws', () => {
    assert.throws(() => new SlidingAggregate(1000, { pnaes: 32 }),
        /unknown option "pnaes" -- did you mean "panes"\?/);
    assert.throws(() => new SlidingAggregate(1000, [1, 2]), /options must be an object/);
    assert.throws(() => new SlidingAggregate(1000, Object.assign(Object.create({ x: 1 }), { panes: 4 })),
        /plain object/);
});

test('T1 subnormal W: 5e-324 underflows to 0 (/underflowed/); a subnormal-but-positive pane width throws /subnormal/', () => {
    assert.throws(() => new SlidingAggregate(5e-324), /W \/ panes underflowed/);
    assert.throws(() => new SlidingAggregate(5e-324, { panes: 1024 }), /underflowed/);
    // 1e-320 / 1024 rounds to a representable SUBNORMAL > 0; the grid cannot hold W exactly, so it now
    // throws /subnormal/ fail-closed (QA190 F3) rather than building a ring that under-covers W.
    assert.throws(() => new SlidingAggregate(1e-320, { panes: 1024 }),
        (e) => e instanceof RangeError && /subnormal/.test(e.message) && /\[lite-adaptive\]/.test(e.message));
    // the smallest normal pane width still builds: W = SA_MIN_NORMAL * panes lands exactly on the boundary.
    const ok = new SlidingAggregate(2.2250738585072014e-308 * 32, { panes: 32 });
    assert.ok(Number.isFinite(ok._paneW) && ok._paneW >= 2.2250738585072014e-308);
});

// ============================ T2: add ======================================

test('T2 add: first explicit add locks mode, anchors, folds count/sum/min/max into the current pane', () => {
    const sa = new SlidingAggregate(1000, { panes: 4 });
    sa.add(10, 5);
    assert.equal(sa.mode, 'explicit');
    assert.equal(sa.lastNow, 10);
    assert.equal(sa._now, 10);
    const [count, sum, kcomp, mn, mx] = curSlot(sa);
    assert.equal(count, 1);
    assert.equal(sum, 5);
    assert.equal(kcomp, 0);
    assert.equal(mn, 5);
    assert.equal(mx, 5);
});

test('T2 add: count mode auto-ticks; a mode switch throws both ways as a no-op', () => {
    const cm = new SlidingAggregate(100, { panes: 4 });
    cm.add(undefined, 2);
    assert.equal(cm.mode, 'count');
    assert.equal(cm._now, 1);          // tick 1
    cm.add(undefined, 3);
    assert.equal(cm._now, 2);          // tick 2
    rejectsNoOp(cm, () => cm.add(50, 1), /mode is locked to count/, 'count->explicit');

    const em = new SlidingAggregate(100, { panes: 4 });
    em.add(50, 1);
    rejectsNoOp(em, () => em.add(undefined, 1), /mode is locked to explicit/, 'explicit->count');
});

test('T2 add: value is REQUIRED and fail-closed (non-number / NaN / +-Infinity / over-cap), all no-ops', () => {
    const sa = new SlidingAggregate(1000, { panes: 4 });
    for (const v of [undefined, null, '5', NaN, Infinity, -Infinity, 1e151, -1e151]) {
        rejectsNoOp(sa, () => sa.add(10, v), /add value must be a finite number/, 'value=' + String(v));
    }
    // the cap boundary itself is accepted
    sa.add(10, 1e150);
    assert.equal(curSlot(sa)[1], 1e150);
});

test('T2 add: monotone now enforced; a decrease throws as a byte-identical no-op', () => {
    const sa = new SlidingAggregate(1000, { panes: 4 });
    sa.add(10, 1);
    sa.add(20, 1);
    rejectsNoOp(sa, () => sa.add(19, 1), /add now must be non-decreasing/, 'decrease');
    rejectsNoOp(sa, () => sa.add(NaN, 1), /add now must be a finite number/, 'NaN now');
    rejectsNoOp(sa, () => sa.add(Infinity, 1), /add now must be a finite number/, 'Inf now');
});

test('T2 add: min/max ties keep the first value; sum accumulates over a pane', () => {
    const sa = new SlidingAggregate(1000, { panes: 4 });
    sa.add(10, 3);
    sa.add(10, 3);          // same pane, tie on min and max
    sa.add(10, 7);
    sa.add(10, -2);
    const [count, sum, , mn, mx] = curSlot(sa);
    assert.equal(count, 4);
    assert.equal(sum, 11);
    assert.equal(mn, -2);
    assert.equal(mx, 7);
});

test('T2 add: crossing a pane boundary rotates + clears; covered sum/count merge live panes', () => {
    const sa = new SlidingAggregate(4, { panes: 4 });   // paneW = 1
    sa.add(0.5, 10);
    sa.add(1.5, 20);       // new pane
    sa.add(2.5, 30);       // new pane
    assert.equal(coveredCount(sa), 3);
    assert.equal(coveredSum(sa), 60);
    // slide past everything: now = 100 expires all old panes -> covered count 0 (mean would be NaN)
    sa.add(100, 1);
    assert.equal(coveredCount(sa), 1);   // only the fresh add is live
    assert.equal(coveredSum(sa), 1);
});

// ============================ T2: addFrom ==================================

test('T2 addFrom: unboxed [now, value]; explicit-only; count-locked rejects; byte-identical to add', () => {
    const fromSa = new SlidingAggregate(1000, { panes: 4 });
    const plainSa = new SlidingAggregate(1000, { panes: 4 });
    const buf = Float64Array.from([10, 5, 20, 8, 30, -3]);
    for (let i = 0; i < buf.length; i += 2) fromSa.addFrom(buf, i);
    plainSa.add(10, 5); plainSa.add(20, 8); plainSa.add(30, -3);
    assertSame(snap(plainSa), snap(fromSa), 'addFrom vs add parity');

    const cm = new SlidingAggregate(100, { panes: 4 });
    cm.add(undefined, 1);
    rejectsNoOp(cm, () => cm.addFrom(buf, 0), /mode is locked to count/, 'count-locked addFrom');
});

test('T2 addFrom: bad handle throws as a no-op (non-F64 / non-int / negative / out-of-range i)', () => {
    const sa = new SlidingAggregate(1000, { panes: 4 });
    const buf = Float64Array.from([10, 5]);
    for (const [b, i] of [[[10, 5], 0], [buf, -1], [buf, 1.5], [buf, 1], [buf, 2]]) {
        rejectsNoOp(sa, () => sa.addFrom(b, i),
            /addFrom\(buf, i\) needs a Float64Array/, 'buf=' + JSON.stringify(b) + ' i=' + i);
    }
});

test('T2 addFrom: over-cap / NaN value throws as a no-op', () => {
    const sa = new SlidingAggregate(1000, { panes: 4 });
    const bad = Float64Array.from([10, 1e151, 10, NaN]);
    rejectsNoOp(sa, () => sa.addFrom(bad, 0), /add value must be a finite number/, 'over-cap');
    rejectsNoOp(sa, () => sa.addFrom(bad, 2), /add value must be a finite number/, 'NaN value');
});

test('T2 addFrom: a fractional-cancelling stream [2^53, 1000 x 1.0, -2^53] is byte-identical to add (Kahan comp incl.)', () => {
    // Integer parity streams hide a dropped Kahan comp; this stream needs the copied fold in addFrom.
    const N = 1000;
    const buf = new Float64Array((N + 2) * 2);
    buf[0] = 0; buf[1] = 2 ** 53;
    for (let j = 0; j < N; j++) { buf[(j + 1) * 2] = 0; buf[(j + 1) * 2 + 1] = 1.0; }
    buf[(N + 1) * 2] = 0; buf[(N + 1) * 2 + 1] = -(2 ** 53);
    const fromSa = new SlidingAggregate(1e9, { panes: 4 });   // huge pw -> everything shares pane 0
    for (let i = 0; i < buf.length; i += 2) fromSa.addFrom(buf, i);
    const addSa = new SlidingAggregate(1e9, { panes: 4 });
    addSa.add(0, 2 ** 53);
    for (let j = 0; j < N; j++) addSa.add(0, 1.0);
    addSa.add(0, -(2 ** 53));
    assertSame(snap(addSa), snap(fromSa), 'addFrom vs add on a fractional-cancelling stream (kcomp slot included)');
    // The copied Kahan fold recovers 1000; a dropped comp (store[base+2]=0 in addFrom) yields 0.
    assert.equal(curSlot(fromSa)[1], 1000, 'addFrom pane sum is 1000 via the Kahan comp, not 0');
});

test('T2 addFrom: decreasing / non-finite now throws as a byte-identical no-op (explicit + unset branches)', () => {
    // explicit-locked instance -> the EXPLICIT-branch monotone + NaN checks
    const sa = new SlidingAggregate(1000, { panes: 4 });
    sa.addFrom(Float64Array.from([10, 1]), 0);                    // locks explicit at now=10
    rejectsNoOp(sa, () => sa.addFrom(Float64Array.from([9, 1]), 0), /add now must be non-decreasing/, 'addFrom decrease');
    rejectsNoOp(sa, () => sa.addFrom(Float64Array.from([NaN, 1]), 0), /add now must be a finite number/, 'addFrom NaN now (explicit)');
    rejectsNoOp(sa, () => sa.addFrom(Float64Array.from([Infinity, 1]), 0), /add now must be a finite number/, 'addFrom Inf now (explicit)');
    // unset instance -> the UNSET-branch NaN check (the second copy)
    const un = new SlidingAggregate(1000, { panes: 4 });
    rejectsNoOp(un, () => un.addFrom(Float64Array.from([NaN, 1]), 0), /add now must be a finite number/, 'addFrom NaN now (unset)');
    rejectsNoOp(un, () => un.addFrom(Float64Array.from([-Infinity, 1]), 0), /add now must be a finite number/, 'addFrom -Inf now (unset)');
    assert.equal(un.mode, 'unset', 'a rejected first addFrom leaves the mode unset');
});

test('T2 addFrom: a Proxy over a Float64Array is rejected as a no-op (instanceof passes, isView does not)', () => {
    const sa = new SlidingAggregate(1000, { panes: 4 });
    const proxy = new Proxy(Float64Array.from([10, 5]), {});
    assert.equal(proxy instanceof Float64Array, true, 'sanity: the proxy fools instanceof');
    // ArrayBuffer.isView rejects it before any state write; it throws a TypeError (fails closed, no-op).
    rejectsNoOp(sa, () => sa.addFrom(proxy, 0), TypeError, 'proxy over Float64Array');
});

// ============================ T2: advance / advanceFrom ====================

test('T2 advance: idle slide rotates stale panes; a +1e12 advance leaves covered count 0 (mean would be NaN)', () => {
    const sa = new SlidingAggregate(4, { panes: 4 });
    sa.add(0.5, 10);
    sa.add(1.5, 20);
    assert.equal(coveredCount(sa), 2);
    sa.advance(0.5 + 1e12);              // jump far past the ring
    assert.equal(sa._now, 0.5 + 1e12);
    assert.equal(coveredCount(sa), 0);   // every live pane empty -> count 0, mean/min/max would be NaN
    assert.equal(coveredSum(sa), 0);
});

test('T2 advance: explicit-only; count-locked throws; unset locks + anchors; monotone enforced; no-op on reject', () => {
    const cm = new SlidingAggregate(100, { panes: 4 });
    cm.add(undefined, 1);
    rejectsNoOp(cm, () => cm.advance(50), /mode is locked to count/, 'count-locked advance');

    const sa = new SlidingAggregate(1000, { panes: 4 });
    sa.advance(100);                     // unset -> locks explicit + anchors
    assert.equal(sa.mode, 'explicit');
    assert.equal(sa._now, 100);
    assert.ok(sa._paneEnd[sa._cur] > 100);   // anchored
    rejectsNoOp(sa, () => sa.advance(50), /advance now must be non-decreasing/, 'decrease');
    rejectsNoOp(sa, () => sa.advance(NaN), /advance now must be a finite number/, 'NaN');
});

test('T2 advanceFrom: unboxed now; byte-identical to advance; bad handle throws as a no-op', () => {
    const a = new SlidingAggregate(1000, { panes: 4 });
    const b = new SlidingAggregate(1000, { panes: 4 });
    a.add(10, 1); b.add(10, 1);
    const buf = Float64Array.from([500]);
    a.advanceFrom(buf, 0);
    b.advance(500);
    assertSame(snap(b), snap(a), 'advanceFrom vs advance parity');

    rejectsNoOp(a, () => a.advanceFrom([500], 0), /advanceFrom\(buf, i\) needs a Float64Array/, 'non-F64');
    rejectsNoOp(a, () => a.advanceFrom(buf, 1), /advanceFrom\(buf, i\) needs a Float64Array/, 'oob i');
    // a Proxy over a Float64Array fools instanceof; ArrayBuffer.isView rejects it (a byte-identical no-op).
    const proxy = new Proxy(buf, {});
    assert.equal(proxy instanceof Float64Array, true, 'sanity: the proxy fools instanceof');
    // ArrayBuffer.isView rejects it before any state write; it throws a TypeError (fails closed, no-op).
    rejectsNoOp(a, () => a.advanceFrom(proxy, 0), TypeError, 'proxy over Float64Array');
});

test('T2 advanceFrom: count-locked / decreasing / non-finite now throws as a byte-identical no-op', () => {
    // count-locked instance rejects advanceFrom (advance is EXPLICIT-only)
    const cm = new SlidingAggregate(100, { panes: 4 });
    cm.add(undefined, 1);
    rejectsNoOp(cm, () => cm.advanceFrom(Float64Array.from([50]), 0), /mode is locked to count/, 'count-locked advanceFrom');
    // explicit-locked -> the EXPLICIT-branch monotone + NaN checks
    const sa = new SlidingAggregate(1000, { panes: 4 });
    sa.add(10, 1);
    rejectsNoOp(sa, () => sa.advanceFrom(Float64Array.from([9]), 0), /advance now must be non-decreasing/, 'advanceFrom decrease');
    rejectsNoOp(sa, () => sa.advanceFrom(Float64Array.from([NaN]), 0), /advance now must be a finite number/, 'advanceFrom NaN now (explicit)');
    rejectsNoOp(sa, () => sa.advanceFrom(Float64Array.from([Infinity]), 0), /advance now must be a finite number/, 'advanceFrom Inf now (explicit)');
    // unset instance -> the UNSET-branch NaN check
    const un = new SlidingAggregate(1000, { panes: 4 });
    rejectsNoOp(un, () => un.advanceFrom(Float64Array.from([NaN]), 0), /advance now must be a finite number/, 'advanceFrom NaN now (unset)');
    assert.equal(un.mode, 'unset', 'a rejected first advanceFrom leaves the mode unset');
});

test('T2 pane grid: paneEnd[cur] is grid-aligned after a non-aligned first add and after a +1e6 jump; edge query', () => {
    const W = 1000, panes = 32, pw = W / panes;   // pw = 31.25 (non-integer)
    const sa = new SlidingAggregate(W, { panes });
    const t0 = 123.456;
    sa.add(t0, 1);
    // _anchor: current pane end = (floor(t0/pw)+1)*pw. anchor_off_by_one (+2 instead of +1) is RED here.
    assert.equal(sa._paneEnd[sa._cur], (Math.floor(t0 / pw) + 1) * pw, 'first pane end grid-aligned');
    const t1 = t0 + 1e6;   // jump far past the ring -> the _advance re-anchor path
    sa.add(t1, 1);
    // reanchor_off (newE + pw) is RED here; anchor_off_by_one is also caught by the first assertion.
    assert.equal(sa._paneEnd[sa._cur], (Math.floor(t1 / pw) + 1) * pw, 'pane end re-anchored on the grid after a +1e6 jump');

    // Edge query on a dyadic grid: a value straddling a pane boundary is covered/excluded by the exact end.
    const sa2 = new SlidingAggregate(64, { panes: 8 });   // pw = 8
    sa2.add(4, 100);    // pane [0, 8), end 8
    sa2.add(12, 200);   // pane [8, 16), end 16; now = 12
    // w = 4 -> cut = 8; a pane ending exactly at 8 is EXCLUDED (paneEnd > cut is strict) -> only 1 covered.
    assert.equal(coveredCount(sa2, 4), 1, 'edge of the first pane: end==cut excluded (anchor mutants shift this)');
    assert.equal(coveredCount(sa2, 4.5), 2, 'cut just below the boundary keeps both panes');
});

test('T2 clear: resets to empty + unlocks the mode, reusing the arrays', () => {
    const sa = new SlidingAggregate(1000, { panes: 4 });
    const store = sa._store, paneEnd = sa._paneEnd;
    sa.add(10, 5);
    sa.add(20, 7);
    sa.clear();
    assert.equal(sa.mode, 'unset');
    assert.equal(sa._now, 0);
    assert.equal(sa.lastNow, 0);
    assert.equal(sa._cur, 0);
    assert.ok(sa._store === store, 'store reused');
    assert.ok(sa._paneEnd === paneEnd, 'paneEnd reused');
    for (let p = 0; p < sa._ring; p++) {
        assert.equal(sa._store[p * STRIDE + 3], Infinity, 'min identity after clear');
        assert.equal(sa._store[p * STRIDE + 4], -Infinity, 'max identity after clear');
    }
    // usable again in a new mode
    sa.add(undefined, 1);
    assert.equal(sa.mode, 'count');
});
