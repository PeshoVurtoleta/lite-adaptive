// @zakkster/lite-adaptive -- SlidingAggregate T3 readers (count / sum / mean / min / max / into) vs an
// in-test BigInt oracle. The oracle is built ONLY from the driver's own (t, v) list -- it never reads
// the implementation's output. Values are quantized to 2^-20 so the exact sum is a BigInt.
//
// Covered-span rule (ROADMAP 9.1): a value added at time t lands in the grid pane with end
// pe = (floor(t / pw) + 1) * pw; it is covered by a query at `now` with sub-window `w` iff pe > now - w.
//
// TEETH (A1): lane K proves the PER-PANE Kahan sum (one pane [2^53, 1000 x 1.0, -2^53] -> 1000, not 0);
// lane N proves the CROSS-PANE Neumaier merge (+2^53, thirty +1, -2^53 over 32 panes -> 30, not 0); the
// empty-pane lane proves identity sentinels (a gap > pw, all-positive keeps min > 0, all-negative keeps
// max < 0). The scratch-mutant proofs (Kahan removed / Neumaier removed / fill(0) sentinels go RED) are
// run out-of-band by the coder; these lanes are the assertions those mutants must fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingAggregate } from '../Adaptive.js';

const STRIDE = 5;
const Q = 2 ** 20;            // quantization: every value is an exact multiple of 2^-20
const U = 2 ** -53;

/** The grid pane end containing time t (absolute alignment, matches _anchor / _advance). */
function paneEnd(t, pw) { return (Math.floor(t / pw) + 1) * pw; }

/**
 * Oracle over the driver's (t, v) list at query time `now` with sub-window `w`. Returns the exact
 * count / min / max (Number, exact) and the exact sum as a BigInt of v*2^20 (fail closed if any v is
 * not an exact multiple of 2^-20). S1 = sum|v| over covered values.
 */
function oracle(events, pw, now, w) {
    const cut = now - w;
    let count = 0, mn = Infinity, mx = -Infinity;
    let sumK = 0n, s1 = 0;
    for (const [t, v] of events) {
        if (!(paneEnd(t, pw) > cut)) continue;
        const k = Math.round(v * Q);
        assert.ok(Math.abs(k / Q - v) < 1e-12, 'value ' + v + ' is not a clean 2^-20 multiple');
        count += 1;
        sumK += BigInt(k);
        s1 += Math.abs(v);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
    }
    return { count, mn, mx, sumK, s1, exactSum: Number(sumK) / Q };
}

/** Assert every reader + into agrees with the oracle at (now, w). */
function assertReaders(sa, o, w, label) {
    assert.equal(sa.count(w), o.count, label + ' count');
    if (o.count === 0) {
        assert.equal(sa.sum(w), 0, label + ' empty sum');
        assert.ok(Number.isNaN(sa.mean(w)), label + ' empty mean NaN');
        assert.ok(Number.isNaN(sa.min(w)), label + ' empty min NaN');
        assert.ok(Number.isNaN(sa.max(w)), label + ' empty max NaN');
    } else {
        assert.ok(Object.is(sa.min(w), o.mn), label + ' min ' + sa.min(w) + ' != ' + o.mn);
        assert.ok(Object.is(sa.max(w), o.mx), label + ' max ' + sa.max(w) + ' != ' + o.mx);
        const bound = 4 * U * o.s1 * (1 + 2 ** -20);   // the ADR 0012 sum bound; no floor (S1 > 0 when count > 0)
        assert.ok(Math.abs(sa.sum(w) - o.exactSum) <= bound,
            label + ' sum ' + sa.sum(w) + ' vs exact ' + o.exactSum + ' bound ' + bound);
        const meanBound = bound / o.count + U * Math.abs(o.exactSum / o.count) * 2;
        assert.ok(Math.abs(sa.mean(w) - o.exactSum / o.count) <= meanBound, label + ' mean');
    }
    // into() slot-for-slot vs each scalar reader
    const out = new Float64Array(5);
    assert.equal(sa.into(out, w), 5, label + ' into returns 5');
    assert.ok(Object.is(out[0], sa.count(w)), label + ' into[0]=count');
    assert.ok(Object.is(out[1], sa.sum(w)), label + ' into[1]=sum');
    assert.ok(Object.is(out[2], sa.mean(w)), label + ' into[2]=mean');
    assert.ok(Object.is(out[3], sa.min(w)), label + ' into[3]=min');
    assert.ok(Object.is(out[4], sa.max(w)), label + ' into[4]=max');
}

// mulberry32 (deterministic)
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ======================= A1 covered-span, randomized ========================

test('T3 A1: covered span vs BigInt oracle, signed stream, full W + sub-windows W/2, W/4', () => {
    const W = 1024, panes = 32, pw = W / panes;   // pw = 32 (dyadic)
    const sa = new SlidingAggregate(W, { panes });
    const rnd = mulberry32(0xC0FFEE);
    const events = [];
    let t = 0;
    for (let i = 0; i < 3000; i++) {
        t += 1 + Math.floor(rnd() * 6);                          // strictly increasing integer times
        const k = Math.round((rnd() - 0.5) * 200 * Q);           // v in [-100, 100], exact 2^-20 multiple
        const v = k / Q;
        sa.add(t, v);
        events.push([t, v]);
        if (i % 250 === 249) {
            const now = sa._now;
            for (const w of [W, W / 2, W / 4]) {
                assertReaders(sa, oracle(events, pw, now, w), w, 'i=' + i + ' w=' + w);
            }
        }
    }
});

test('T3 A1: covered span, count mode (tick clock), full W', () => {
    const W = 256, panes = 32, pw = W / panes;
    const sa = new SlidingAggregate(W, { panes });
    const rnd = mulberry32(7);
    const events = [];
    for (let i = 0; i < 2000; i++) {
        const k = Math.round(rnd() * 50 * Q);          // v in [0, 50]
        const v = k / Q;
        sa.add(undefined, v);
        events.push([i + 1, v]);                        // count-mode tick starts at 1
        if (i % 300 === 299) {
            const now = sa._now;
            assertReaders(sa, oracle(events, pw, now, W), W, 'count i=' + i);
        }
    }
});

test('T3 A3: sub-window spikes -- a max spike and min dip in [now-W, now-W/2) are excluded at w=W/2', () => {
    const W = 64, panes = 8, pw = W / panes;   // pw = 8
    const sa = new SlidingAggregate(W, { panes });
    const events = [];
    // plant an extreme early (covered by full W but NOT by W/2), then ordinary values later.
    sa.add(0.5, 500); events.push([0.5, 500]);      // max spike, old
    sa.add(0.5, -500); events.push([0.5, -500]);    // min dip, old
    let t = 40;
    for (let i = 0; i < 20; i++) { t += 1; sa.add(t, (i % 7) - 3); events.push([t, (i % 7) - 3]); }
    const now = sa._now;
    assertReaders(sa, oracle(events, pw, now, W), W, 'A3 full W (spikes covered)');
    assertReaders(sa, oracle(events, pw, now, W / 2), W / 2, 'A3 W/2 (spikes excluded)');
    // sanity: the spikes really are excluded at W/2 but present at W
    assert.equal(sa.max(W), 500);
    assert.ok(sa.max(W / 2) < 500);
    assert.equal(sa.min(W), -500);
    assert.ok(sa.min(W / 2) > -500);
});

// ======================= TEETH: Kahan (lane K) ==============================

test('T3 lane K (per-pane Kahan): one pane [2^53, 1000 x 1.0, -2^53] sums to 1000, not 0', () => {
    const sa = new SlidingAggregate(1e9, { panes: 4 });   // huge pw -> all at t=0 share pane 0
    sa.add(0, 2 ** 53);
    for (let i = 0; i < 1000; i++) sa.add(0, 1.0);
    sa.add(0, -(2 ** 53));
    assert.equal(sa.count(), 1002);
    assert.equal(sa.sum(), 1000, 'Kahan recovers 1000; plain += yields 0');
    assert.equal(sa.mean(), 1000 / 1002, 'mean uses its own Kahan merge (1000/1002, not 0)');
    assert.equal(sa.min(), -(2 ** 53));
    assert.equal(sa.max(), 2 ** 53);
    const out = new Float64Array(5);
    sa.into(out);
    assert.equal(out[1], 1000, 'into sum also 1000');
    assert.equal(out[2], 1000 / 1002, 'into mean also 1000/1002');
});

// ======================= TEETH: Neumaier (lane N) ===========================

test('T3 lane N (cross-pane Neumaier): +2^53, thirty +1, -2^53 over 32 panes sums to 30, not 0', () => {
    const W = 32, panes = 32;   // pw = 1
    const sa = new SlidingAggregate(W, { panes });
    sa.add(0.5, 2 ** 53);                    // pane end 1
    for (let p = 1; p <= 30; p++) sa.add(p + 0.5, 1.0);   // pane ends 2..31
    sa.add(31.5, -(2 ** 53));                // pane end 32
    assert.equal(sa.count(), 32);
    assert.equal(sa.sum(), 30, 'Neumaier merge recovers 30; plain cross-pane += yields 0');
    assert.equal(sa.mean(), 30 / 32, 'mean has its own Neumaier merge (30/32, not 0)');
    const out = new Float64Array(5);
    sa.into(out);
    assert.equal(out[1], 30, 'into sum also 30');
    assert.equal(out[2], 30 / 32, 'into mean also 30/32');
});

// ======================= TEETH: mean's -c_p sign (lane M) ===================

test('T3 lane M (mean Neumaier -c_p sign): a nonzero pane comp makes mean() === sum()/count; a +c_p flip is RED', () => {
    // [2^53, 1.0] leaves a NONZERO Kahan comp in the pane (2^53 + 1 is not representable), unlike lanes
    // K/N whose comp cancels back to 0. mean() reuses the SAME Neumaier merge as sum(); flipping the
    // -c_p sign in mean() alone breaks the mean == sum/count identity here.
    const sa = new SlidingAggregate(1e9, { panes: 4 });   // huge pw -> one pane
    sa.add(0, 2 ** 53);
    sa.add(0, 1.0);
    assert.notEqual(sa._store[sa._cur * STRIDE + 2], 0, 'sanity: the pane Kahan comp is nonzero');
    assert.equal(sa.mean(), sa.sum() / sa.count(), 'mean == sum/count (both merge -c_p with the same sign)');
    const out = new Float64Array(5);
    sa.into(out);
    assert.equal(out[2], sa.sum() / sa.count(), 'into mean also == sum/count');
});

// ======================= TEETH: identity sentinels ==========================

test('T3 empty-pane (gap > pw): all-positive keeps min > 0; all-negative keeps max < 0 (fill(0) is RED)', () => {
    const W = 8, panes = 8;   // pw = 1
    // all-positive with an empty gap of several panes in the middle of the window
    const pos = new SlidingAggregate(W, { panes });
    pos.add(0.5, 3.5);        // pane end 1
    pos.add(5.5, 7.25);       // pane end 6 -- panes ending 2,3,4,5 are empty (a gap > pw)
    assert.equal(pos.count(), 2);
    assert.equal(pos.min(), 3.5, 'min is the smaller positive value, NOT 0 from a fill(0) sentinel');
    assert.equal(pos.max(), 7.25);
    const outP = new Float64Array(5); pos.into(outP);
    assert.equal(outP[3], 3.5, 'into min also 3.5');

    // all-negative mirror
    const neg = new SlidingAggregate(W, { panes });
    neg.add(0.5, -3.5);
    neg.add(5.5, -7.25);
    assert.equal(neg.count(), 2);
    assert.equal(neg.max(), -3.5, 'max is the larger (less negative) value, NOT 0 from a fill(0) sentinel');
    assert.equal(neg.min(), -7.25);
    const outN = new Float64Array(5); neg.into(outN);
    assert.equal(outN[4], -3.5, 'into max also -3.5');
});

// ======================= into() contract ====================================

test('T3 into: wrong container throws (TypeError), short throws (RangeError), bad w -> 5 NaN slots', () => {
    const sa = new SlidingAggregate(1000, { panes: 4 });
    sa.add(10, 5);
    assert.throws(() => sa.into([0, 0, 0, 0, 0]), /into\(out, w\?\) out must be a Float64Array/);
    assert.throws(() => sa.into(new Float64Array(4)), /into out\.length \(4\) must be >= 5/);
    // a Proxy over a Float64Array passes `instanceof` but not ArrayBuffer.isView -> TypeError.
    const proxy = new Proxy(new Float64Array(5), {});
    assert.equal(proxy instanceof Float64Array, true, 'sanity: the proxy fools instanceof');
    assert.throws(() => sa.into(proxy), TypeError, 'proxy out rejected (isView fails closed)');
    // H34 (container-length threat model, SETTLED 2026-09-28): into() is a COLD reader -- it reads the
    // length through the intrinsic %TypedArray%.length getter (TA_LEN), so a benign NaN-length subclass
    // over a valid 8-slot backing is ACCEPTED (TA_LEN reads 8, not NaN) and its own length getter is
    // NEVER invoked. The result is byte-identical to a plain 8-slot Float64Array.
    let getterCalls = 0;
    class NaNLen extends Float64Array { get length() { getterCalls++; return NaN; } }
    const nanLen = new NaNLen(8);
    assert.ok(Number.isNaN(nanLen.length), 'sanity: subclass length reads NaN');
    getterCalls = 0;
    assert.equal(sa.into(nanLen), 5, 'NaN-length subclass out ACCEPTED (cold reader reads TA_LEN=8)');
    assert.equal(getterCalls, 0, 'the subclass length getter is never invoked (intrinsic TA_LEN)');
    assert.equal(nanLen[0], 1, 'count landed in slot 0'); assert.equal(nanLen[1], 5, 'sum landed in slot 1');
    const out = new Float64Array(5);
    assert.equal(sa.into(out, -1), 5, 'bad w still returns 5');
    for (let i = 0; i < 5; i++) assert.ok(Number.isNaN(out[i]), 'bad w -> NaN slot ' + i);
    // out.length > 5 is fine; only [0..4] are written
    const big = new Float64Array(8).fill(42);
    sa.into(big);
    assert.equal(big[0], 1); assert.equal(big[5], 42, 'slots past 5 untouched');
});

test('T3 readers never throw on a bad w (return NaN), and unset reads count 0 / sum 0 / NaN', () => {
    const sa = new SlidingAggregate(1000, { panes: 4 });
    // unset
    assert.equal(sa.count(), 0);
    assert.equal(sa.sum(), 0);
    assert.ok(Number.isNaN(sa.mean()));
    assert.ok(Number.isNaN(sa.min()));
    assert.ok(Number.isNaN(sa.max()));
    // bad w on every reader -> NaN, even while unset (w checked before the empty return)
    for (const bad of [-1, 0, NaN, Infinity, -Infinity, 1e9, 'x']) {
        assert.ok(Number.isNaN(sa.count(bad)), 'count bad w ' + bad);
        assert.ok(Number.isNaN(sa.sum(bad)), 'sum bad w ' + bad);
        assert.ok(Number.isNaN(sa.mean(bad)), 'mean bad w ' + bad);
        assert.ok(Number.isNaN(sa.min(bad)), 'min bad w ' + bad);
        assert.ok(Number.isNaN(sa.max(bad)), 'max bad w ' + bad);
    }
});
