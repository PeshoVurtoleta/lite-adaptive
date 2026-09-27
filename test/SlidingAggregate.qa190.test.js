// @zakkster/lite-adaptive -- QA 1.9.0: SlidingAggregate boundary matrix + adversarial cases.
//
// Every oracle is independent of the implementation: a brute-force (t, v) list, BigInt sums over
// values quantized to 2^-20, and the grid pane end pe = (floor(t / pw) + 1) * pw (live iff
// pe > now - w) for the covered span, or the TRUE window (now - W, now] for containment.
// Tests marked `todo` are QA FINDINGS (they fail on the current code; the suite still exits 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingAggregate } from '../Adaptive.js';   // SA_* consts are module-private (family convention)

const Q = 2 ** 20;
const QB = 1n << 20n;

// ---------------------------------------------------------------------------------------------
// helpers (independent oracle; snapshot for byte-identical no-ops)
// ---------------------------------------------------------------------------------------------
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function qz(x) { return Math.round(x * Q) / Q; }
function big(v) {
    const s = v * Q;
    assert.ok(Number.isInteger(s), 'oracle fail-closed: value not a multiple of 2^-20: ' + v);
    return BigInt(s);
}
function nextUp(x) {
    const f = new Float64Array(1); const u = new BigUint64Array(f.buffer);
    f[0] = x; u[0] += 1n; return f[0];
}
/** x = M * 2^e exactly (BigInt M, integer e). */
function frac(x) {
    const f = new Float64Array(1); const u = new BigUint64Array(f.buffer);
    f[0] = x; const bits = u[0];
    const neg = (bits >> 63n) === 1n; const ex = Number((bits >> 52n) & 0x7FFn);
    let m = bits & ((1n << 52n) - 1n); let e;
    if (ex === 0) e = -1074; else { m |= 1n << 52n; e = ex - 1075; }
    return [neg ? -m : m, e];
}
function babs(x) { return x < 0n ? -x : x; }

/** Covered-span oracle over a brute-force (t, v) list: live iff grid pe > now - w. */
function covered(ev, pw, now, w) {
    const cut = now - w;
    let n = 0, S = 0n, S1 = 0n, mn = Infinity, mx = -Infinity;
    for (let k = 0; k < ev.length; k++) {
        const t = ev[k][0], v = ev[k][1];
        const pe = (Math.floor(t / pw) + 1) * pw;
        if (!(pe > cut)) continue;
        n++; const b = big(v); S += b; S1 += babs(b);
        if (v < mn) mn = v; if (v > mx) mx = v;
    }
    return { n, S, S1, mn, mx };
}
/** TRUE window oracle: items with t in (now - W, now]. */
function trueCount(ev, now, W) { let n = 0; for (const [t] of ev) if (t > now - W && t <= now) n++; return n; }

/** |sum - exact| <= 4u * S1 * (1 + 2^-20), all in exact BigInt (units of 2^-20). */
function sumOk(sum, o) {
    const [M, e] = frac(sum);
    // sum * 2^20 * 2^73 compared against S * 2^73 and bound 4 * S1 * (2^20 + 1), scaled by 2^-e if e < 0.
    const sh = e + 20;
    let lhsNum, sc;
    if (sh >= 0) { lhsNum = M << BigInt(sh); sc = 1n; } else { lhsNum = M; sc = 1n << BigInt(-sh); }
    const err = babs(lhsNum - o.S * sc) << 73n;
    return err <= 4n * o.S1 * sc * (QB + 1n);
}
/** |mean - S/n| <= (4u * S1 / n + u |mean|) * (1 + 2^-20), exact. */
function meanOk(mean, o) {
    const [M, e] = frac(mean); const n = BigInt(o.n);
    // m = M 2^e. Multiply by n * 2^20 * 2^73 (and 2^-e if e < 0).
    const sh = e;
    let mS, sc;
    if (sh >= 0) { mS = M << BigInt(sh); sc = 1n; } else { mS = M; sc = 1n << BigInt(-sh); }
    const lhs = babs(mS * n * QB - o.S * sc) << 73n;
    const rhs = (4n * o.S1 * sc + babs(mS) * n * QB) * (QB + 1n);
    return lhs <= rhs;
}
function checkAll(sa, o, w, label, out) {
    const wa = w;   // pass the literal w (undefined = full window)
    assert.equal(sa.count(wa), o.n, label + ' count');
    if (o.n === 0) {
        assert.ok(Object.is(sa.sum(wa), 0), label + ' empty sum is +0');
        assert.ok(Number.isNaN(sa.mean(wa)) && Number.isNaN(sa.min(wa)) && Number.isNaN(sa.max(wa)), label + ' empty NaN');
    } else {
        const s = sa.sum(wa);
        assert.ok(sumOk(s, o), label + ' sum ' + s + ' outside 4u bound');
        assert.ok(meanOk(sa.mean(wa), o), label + ' mean outside bound');
        assert.ok(sa.min(wa) === o.mn, label + ' min ' + sa.min(wa) + ' vs ' + o.mn);
        assert.ok(sa.max(wa) === o.mx, label + ' max ' + sa.max(wa) + ' vs ' + o.mx);
    }
    assert.equal(sa.into(out, wa), 5);
    assert.ok(Object.is(out[0], sa.count(wa)) && Object.is(out[1], sa.sum(wa)) && Object.is(out[2], sa.mean(wa)) &&
        Object.is(out[3], sa.min(wa)) && Object.is(out[4], sa.max(wa)), label + ' into === scalars');
}
function snap(sa) {
    return {
        store: Array.from(sa._store), pe: Array.from(sa._paneEnd), cur: sa._cur, mode: sa._mode,
        tick: sa._tick, last: sa._lastNow, now: sa._now,
    };
}
function sameSnap(a, b, msg) {
    assert.equal(a.store.length, b.store.length, msg);
    for (let i = 0; i < a.store.length; i++) assert.ok(Object.is(a.store[i], b.store[i]), msg + ' store[' + i + ']');
    for (let i = 0; i < a.pe.length; i++) assert.ok(Object.is(a.pe[i], b.pe[i]), msg + ' paneEnd[' + i + ']');
    for (const k of ['cur', 'mode', 'tick', 'last', 'now']) assert.ok(Object.is(a[k], b[k]), msg + ' ' + k);
}
function rejectNoOp(sa, fn, errType, msg) {
    const a = snap(sa);
    assert.throws(fn, (e) => e instanceof errType && /\[lite-adaptive\]/.test(e.message), msg);
    sameSnap(a, snap(sa), msg);
}
function readAll(sa, w, out) {
    sa.into(out, w);
    return [sa.count(w), sa.sum(w), sa.mean(w), sa.min(w), sa.max(w), out[0], out[1], out[2], out[3], out[4]];
}
function bitSame(a, b, msg) { for (let i = 0; i < a.length; i++) assert.ok(Object.is(a[i], b[i]), msg + ' [' + i + '] ' + a[i] + ' vs ' + b[i]); }

// ---------------------------------------------------------------------------------------------
// 1. empty window (null is not zero)
// ---------------------------------------------------------------------------------------------
test('QA empty: unset / after +1e12 advance / after clear -> count 0, sum +0, mean/min/max NaN (every w)', () => {
    const out = new Float64Array(5);
    const sa = new SlidingAggregate(1000);
    const ws = [undefined, 1000, 500, 31.25, 5e-324];
    const chk = (label) => {
        for (const w of ws) checkAll(sa, { n: 0, S: 0n, S1: 0n }, w, label + ' w=' + w, out);
        out.fill(7); sa.into(out);
        assert.deepEqual(Array.from(out), [0, 0, NaN, NaN, NaN], label + ' into');
    };
    chk('unset');
    sa.add(5, 3).add(700, -2);
    sa.advance(700 + 1e12);
    chk('after +1e12 advance');
    sa.add(1e12 + 800, 4);
    sa.clear(); sa.clear();   // duplicate dispose is idempotent
    chk('after double clear');
    assert.equal(sa.mode, 'unset'); assert.equal(sa.lastNow, 0);
});

// ---------------------------------------------------------------------------------------------
// 2. one item; exactly B-1 / B / B+1 / B+2 items one per pane; W-1 / W / W+1 in count mode
// ---------------------------------------------------------------------------------------------
test('QA one item: every reader reads the single value exactly (explicit + count mode, incl. -1e150)', () => {
    const out = new Float64Array(5);
    for (const v of [0.5, -3.25, 1e150, -1e150, 0]) {
        for (const mode of ['explicit', 'count']) {
            const sa = new SlidingAggregate(1000);
            if (mode === 'count') sa.add(undefined, v); else sa.add(17.5, v);
            const t = mode === 'count' ? 1 : 17.5;
            checkAll(sa, covered([[t, v]], 1000 / 32, t, 1000), undefined, mode + ' v=' + v, out);
            assert.equal(sa.count(), 1); assert.ok(sa.sum() === v && sa.mean() === v && sa.min() === v && sa.max() === v);
        }
    }
});

test('QA N-1 / N / N+1 / N+2 panes filled (one item per pane, explicit, W=1000 B=32) vs covered + true oracle', () => {
    const out = new Float64Array(5); const pw = 1000 / 32;
    for (const k of [31, 32, 33, 34, 35]) {
        const sa = new SlidingAggregate(1000); const ev = [];
        for (let i = 0; i < k; i++) { const t = i * pw + 3.5; const v = qz((i + 1) * 1.125); sa.add(t, v); ev.push([t, v]); }
        const now = ev[ev.length - 1][0];
        checkAll(sa, covered(ev, pw, now, 1000), undefined, 'k=' + k, out);
        assert.ok(sa.count() >= trueCount(ev, now, 1000), 'k=' + k + ' contains the true window');
        assert.ok(sa.count() <= 33, 'never more than B+1 panes');
    }
});

test('QA count mode W-1 / W / W+1 items (W=32, B=32 -> pw=1) and W=1000 default panes', () => {
    const out = new Float64Array(5);
    for (const [W, B] of [[32, 32], [1000, 32], [7, 2]]) {
        for (const n of [W - 1, W, W + 1, 2 * W + 3]) {
            const sa = new SlidingAggregate(W, { panes: B }); const ev = [];
            for (let i = 1; i <= n; i++) { const v = qz(Math.sin(i) * 100); sa.add(undefined, v); ev.push([i, v]); }
            checkAll(sa, covered(ev, W / B, n, W), undefined, 'W=' + W + ' n=' + n, out);
            assert.ok(sa.count() >= Math.min(n, W), 'contains true(W)');
            assert.equal(sa.lastNow, n);
        }
    }
});

// ---------------------------------------------------------------------------------------------
// 3. pane edges, first add alignment, t = 0, negative clocks
// ---------------------------------------------------------------------------------------------
test('QA pane edge: now exactly on an edge, first add at t=0 / non-aligned / negative, every w', () => {
    const out = new Float64Array(5); const W = 1000, pw = W / 32;
    for (const t0 of [0, 17.3125, -0, -1e6 + 0.5, pw, 1.75e12]) {
        const sa = new SlidingAggregate(W); const ev = [];
        const steps = [0, pw - t0 % pw || pw, pw, 0, 2 * pw, 0.5, pw - 0.5, 10 * pw, 31 * pw, 33 * pw];
        let t = t0, i = 0;
        for (const d of steps) {
            t += d; const v = qz(((i++ * 37) % 11) - 5.5);
            sa.add(t, v); ev.push([t, v]);
            for (const w of [undefined, W, W / 2, pw, 5e-324]) {
                checkAll(sa, covered(ev, pw, t, w === undefined ? W : w), w, 't0=' + t0 + ' t=' + t + ' w=' + w, out);
            }
        }
    }
});

// ---------------------------------------------------------------------------------------------
// 4. +1e12 jump, sub-pane tiny steps, panes 2 and 1024
// ---------------------------------------------------------------------------------------------
test('QA +1e12 jump then query: add-jump keeps only the new item; advance-jump empties; grid re-anchored', () => {
    const out = new Float64Array(5); const pw = 1000 / 32;
    const sa = new SlidingAggregate(1000);
    for (let i = 0; i < 100; i++) sa.add(i * 7.25, i);
    const T = 99 * 7.25 + 1e12;
    sa.add(T, -8.5);
    checkAll(sa, covered([[T, -8.5]], pw, T, 1000), undefined, 'add jump', out);
    assert.equal(sa._paneEnd[sa._cur], (Math.floor(T / pw) + 1) * pw, 'grid aligned after jump');
    sa.advance(T + 2e12);
    checkAll(sa, { n: 0, S: 0n, S1: 0n }, undefined, 'advance jump', out);
});

test('QA many tiny jumps: a sub-pane step sequence (steps in (0, pw/8]) with occasional gaps, 3000 checks', () => {
    const out = new Float64Array(5);
    for (const [W, B, seed] of [[1000, 32, 1], [64, 2, 2], [1024, 1024, 3], [1000, 32, 4]]) {
        const pw = W / B; const rnd = mulberry32(seed);
        const sa = new SlidingAggregate(W, { panes: B }); const ev = [];
        let t = qz(rnd() * 1e4);
        for (let i = 0; i < 750; i++) {
            const r = rnd();
            t += r < 0.97 ? Math.max(2 ** -10, qz(rnd() * pw / 8)) : qz(rnd() * 3 * W);
            const v = qz((rnd() - 0.5) * 2000);
            sa.add(t, v); ev.push([t, v]);
            while (ev.length && ev[0][0] < t - 3 * W) ev.shift();
            const w = [undefined, W / 2, W / 4, pw][i & 3];
            checkAll(sa, covered(ev, pw, t, w === undefined ? W : w), w, 'W=' + W + ' B=' + B + ' i=' + i, out);
            assert.ok(sa.count() >= trueCount(ev, t, W), 'contains true(W)');
        }
    }
});

test('QA panes = 2 (bytes 144) and panes = 1024 (bytes 49200) on a mixed stream vs oracle', () => {
    const out = new Float64Array(5);
    for (const [B, bytes] of [[2, 144], [1024, 49200]]) {
        const W = 512; const pw = W / B; const rnd = mulberry32(B);
        const sa = new SlidingAggregate(W, { panes: B }); const ev = [];
        assert.equal(sa.bytes, bytes); assert.equal(sa.panes, B);
        let t = 0;
        for (let i = 0; i < 1500; i++) {
            t += qz(rnd() * 3); const v = qz(Math.exp(rnd() * 8));
            sa.add(t, v); ev.push([t, v]);
            if (i % 5 === 0) checkAll(sa, covered(ev, pw, t, W), undefined, 'B=' + B + ' i=' + i, out);
        }
        assert.equal(sa.bytes, bytes, 'bytes never grow');
    }
});

// ---------------------------------------------------------------------------------------------
// 5. modes: count vs explicit, clear() then re-lock in the other mode
// ---------------------------------------------------------------------------------------------
test('QA modes: explicit -> clear -> count -> clear -> explicit (smaller now accepted after clear); explicit-only doors', () => {
    const out = new Float64Array(5); const buf = new Float64Array([5, 1]);
    const sa = new SlidingAggregate(100, { panes: 4 });
    sa.add(1000, 2);
    rejectNoOp(sa, () => sa.add(undefined, 1), TypeError, 'explicit rejects count add');
    sa.clear();
    sa.add(undefined, 3); sa.add(undefined, 4);
    assert.equal(sa.mode, 'count'); assert.equal(sa.lastNow, 2);
    checkAll(sa, covered([[1, 3], [2, 4]], 25, 2, 100), undefined, 'count after clear', out);
    rejectNoOp(sa, () => sa.add(3, 1), TypeError, 'count rejects explicit add');
    rejectNoOp(sa, () => sa.addFrom(buf, 0), TypeError, 'count rejects addFrom');
    rejectNoOp(sa, () => sa.advance(9), TypeError, 'count rejects advance');
    rejectNoOp(sa, () => sa.advanceFrom(buf, 0), TypeError, 'count rejects advanceFrom');
    sa.clear();
    sa.addFrom(buf, 0);   // now 5 < the old explicit 1000: accepted after clear
    assert.equal(sa.mode, 'explicit'); assert.equal(sa.lastNow, 5);
    checkAll(sa, covered([[5, 1]], 25, 5, 100), undefined, 'explicit after clear', out);
});

// ---------------------------------------------------------------------------------------------
// 6. ctor boundaries: panes 1 / 2 / 1024 / 1025, subnormal W
// ---------------------------------------------------------------------------------------------
test('QA ctor: panes 1/1025/2.5/NaN/-0/"32"/null throw; 2/1024/undefined build; consts; subnormal W', () => {
    // the private consts, behaviorally: default panes 32, min 2, max 1024, stride 5, cap 1e150
    const d = new SlidingAggregate(1000);
    assert.equal(d.panes, 32); assert.equal(d._store.length, 33 * 5); assert.equal(d.bytes, 1584);
    for (const p of [1, 0, -0, 1025, 2.5, NaN, Infinity, '32', null, 32n]) {
        assert.throws(() => new SlidingAggregate(1000, { panes: p }), (e) => e instanceof RangeError && /panes must be an integer/.test(e.message), 'panes ' + String(p));
    }
    assert.equal(new SlidingAggregate(1000, { panes: 2 }).panes, 2);
    assert.equal(new SlidingAggregate(1000, { panes: 1024 }).panes, 1024);
    assert.equal(new SlidingAggregate(1000, { panes: undefined }).panes, 32);
    for (const W of [0, -0, -1, NaN, Infinity, -Infinity, '1000', null, undefined, new Number(5), 5n]) {
        assert.throws(() => new SlidingAggregate(W), (e) => e instanceof RangeError && /W must be a finite number > 0/.test(e.message), 'W ' + String(W));
    }
    // subnormal: 1e-320 @ 1024 now THROWS (a subnormal pane width cannot hold the grid -- QA190 F3);
    // 5e-324 underflows W / panes to 0 (default and panes 2), keeping the existing /underflowed/ message.
    assert.throws(() => new SlidingAggregate(1e-320, { panes: 1024 }),
        (e) => e instanceof RangeError && /subnormal/.test(e.message), '1e-320 @ 1024 is subnormal');
    for (const p of [undefined, 2, 1024]) {
        assert.throws(() => new SlidingAggregate(5e-324, p === undefined ? undefined : { panes: p }), /underflowed/, '5e-324 panes ' + p);
    }
    // the largest W builds and stays usable
    const big1 = new SlidingAggregate(Number.MAX_VALUE, { panes: 2 });
    big1.add(1.7e308, 1).add(1.7e308, 2);
    assert.equal(big1.count(), 2);
});

// ---------------------------------------------------------------------------------------------
// 7. value domain: zeros, caps, rejects as byte-identical no-ops, re-entrancy
// ---------------------------------------------------------------------------------------------
test('QA values: -0 / +0 / +-1e150 accepted; nextUp(1e150), NaN, +-Inf, string, boxed Number, valueOf, null, undefined, bigint rejected as no-ops', () => {
    const sa = new SlidingAggregate(1000);
    sa.add(1, -0).add(2, 0).add(3, 1e150).add(4, -1e150);
    assert.equal(sa.count(), 4); assert.ok(Object.is(sa.sum(), 0) || sa.sum() === 0);
    assert.equal(sa.max(), 1e150); assert.equal(sa.min(), -1e150);
    const z = new SlidingAggregate(1000); z.add(1, -0).add(2, 0);
    assert.ok(z.min() === 0 && z.max() === 0, 'zero extremes (sign unspecified)');
    let calls = 0;
    const vo = { valueOf() { calls++; sa.add(5, 1); return 1; } };   // re-entrant write if ever invoked
    const bad = [nextUp(1e150), -nextUp(1e150), NaN, Infinity, -Infinity, '1', new Number(1), vo, null, undefined, 1n, 1.8e308];
    for (const v of bad) {
        rejectNoOp(sa, () => sa.add(10, v), TypeError, 'add value ' + String(v));
        rejectNoOp(sa, () => sa.add(undefined, v), TypeError, 'count-shaped add value ' + String(v));
        if (typeof v === 'number') rejectNoOp(sa, () => sa.addFrom(new Float64Array([10, v]), 0), TypeError, 'addFrom value ' + v);
    }
    assert.equal(calls, 0, 'valueOf never invoked (no re-entrant write)');
    // value-first: a bad value with a bad now reports the value
    assert.throws(() => sa.add(NaN, NaN), /add value must be/);
    // bad now as no-ops (explicit-locked): NaN, +-Inf, string, boxed, decreasing, null
    for (const n of [NaN, Infinity, -Infinity, '10', new Number(10), null, 3.999999]) {
        rejectNoOp(sa, () => sa.add(n, 1), n === 3.999999 ? RangeError : TypeError, 'add now ' + String(n));
        rejectNoOp(sa, () => sa.advance(n), n === 3.999999 ? RangeError : TypeError, 'advance now ' + String(n));
    }
    // -0 now after 0-lock: equal, accepted
    const m = new SlidingAggregate(10); m.add(0, 1); m.add(-0, 2); assert.equal(m.count(), 2);
});

test('QA sum magnitude: 1e6 adds of 1e150 (and alternating +-1e150) stay finite; sum/mean within the 4u bound (BigInt exact)', () => {
    const out = new Float64Array(5);
    const buf = new Float64Array(2);
    for (const alt of [false, true]) {
        const W = 1024, sa = new SlidingAggregate(W, { panes: 32 });
        const N = 1000000;
        let S = 0n, S1 = 0n;
        const B150 = BigInt(1e150);
        for (let i = 0; i < N; i++) {
            buf[0] = i * (W / N); buf[1] = alt && (i & 1) ? -1e150 : 1e150;
            sa.addFrom(buf, 0);
            S += alt && (i & 1) ? -B150 : B150; S1 += B150;
        }
        const s = sa.sum();
        assert.ok(Number.isFinite(s), 'finite sum ' + s);
        const o = { n: sa.count(), S: S * QB, S1: S1 * QB, mn: alt ? -1e150 : 1e150, mx: 1e150 };
        assert.equal(o.n, N, 'every item still covered');
        checkAll(sa, o, undefined, 'alt=' + alt, out);
        if (!alt) {
            assert.ok(Number.isFinite(sa.mean()));
            assert.ok(Math.abs(sa.mean() - 1e150) <= (4 * 2 ** -53 * 1e150 + 2 ** -53 * 1e150) * (1 + 2 ** -20), 'mean to bound');
        }
    }
});

// ---------------------------------------------------------------------------------------------
// 8. w sub-window extremes and bad w
// ---------------------------------------------------------------------------------------------
test('QA w extremes: w = W, W/B exactly, smallest double, W - ulp; bad w (W+ulp, 0, -0, NaN, null, "5", boxed, -Inf) -> NaN / 5 NaN slots, pure', () => {
    const out = new Float64Array(5); const W = 1000, pw = W / 32;
    const sa = new SlidingAggregate(W); const ev = []; const rnd = mulberry32(9);
    let t = 0;
    for (let i = 0; i < 400; i++) { t += qz(rnd() * 12); const v = qz((rnd() - 0.3) * 50); sa.add(t, v); ev.push([t, v]); }
    // land now exactly on a pane edge, too
    const edge = (Math.floor(t / pw) + 1) * pw; sa.add(edge, 2.5); ev.push([edge, 2.5]);
    for (const w of [W, pw, 5e-324, W - 2 ** -43, nextUp(0) * 2, pw * 2]) {
        checkAll(sa, covered(ev, pw, edge, w), w, 'w=' + w, out);
    }
    // w = smallest double: only the current pane (edge item lives alone there)
    assert.equal(sa.count(5e-324), 1); assert.equal(sa.max(5e-324), 2.5);
    const before = snap(sa);
    for (const w of [nextUp(W), 0, -0, -1, NaN, Infinity, -Infinity, null, '5', new Number(5), 5n, { valueOf() { sa.add(edge + 1, 1); return 5; } }]) {
        for (const r of ['count', 'sum', 'mean', 'min', 'max']) assert.ok(Number.isNaN(sa[r](w)), r + ' w=' + String(w));
        out.fill(1); assert.equal(sa.into(out, w), 5);
        assert.ok(out.every(Number.isNaN), 'into 5 NaN slots w=' + String(w));
    }
    sameSnap(before, snap(sa), 'readers are pure');
});

// ---------------------------------------------------------------------------------------------
// 9. into containers: longer array, subarray view with offset, N-1 / N / N+1 lengths, wrong types
// ---------------------------------------------------------------------------------------------
test('QA into: writes only slots 0..4 of a longer array; a subarray view with an offset is valid; length 4 / NaN length / wrong types throw', () => {
    const sa = new SlidingAggregate(1000);
    sa.add(1, 2).add(2, -4).add(3, 8);
    const long = new Float64Array(9).fill(7);
    assert.equal(sa.into(long), 5);
    assert.deepEqual(Array.from(long), [3, 6, 2, -4, 8, 7, 7, 7, 7]);
    const base = new Float64Array(12).fill(9);
    const view = base.subarray(3, 8);
    assert.equal(view.byteOffset, 24);
    assert.equal(sa.into(view), 5);
    assert.deepEqual(Array.from(base), [9, 9, 9, 3, 6, 2, -4, 8, 9, 9, 9, 9]);
    const view6 = base.subarray(6, 12); sa.into(view6, 1.5);   // w = 1.5 -> panes live after now - 1.5
    assert.deepEqual(Array.from(base.subarray(6, 12)), [3, 6, 2, -4, 8, 9]);
    const four = new Float64Array(8).subarray(2, 6);
    const snapA = Array.from(four);
    assert.throws(() => sa.into(four), (e) => e instanceof RangeError && /out.length \(4\) must be >= 5/.test(e.message));
    assert.deepEqual(Array.from(four), snapA, 'a short container is untouched');
    class NaNLen extends Float64Array { get length() { return NaN; } }
    assert.throws(() => sa.into(new NaNLen(5)), RangeError, 'NaN length fails closed');
    const px = new Proxy(new Float64Array(5), {});
    for (const o of [px, new Float32Array(5), [0, 0, 0, 0, 0], new DataView(new ArrayBuffer(40)), null, undefined, 5, new BigInt64Array(5)]) {
        assert.throws(() => sa.into(o), TypeError, 'into ' + Object.prototype.toString.call(o));
    }
    assert.equal(sa.count(), 3, 'state untouched by throwing into');
});

// ---------------------------------------------------------------------------------------------
// 10. retention + determinism
// ---------------------------------------------------------------------------------------------
test('QA retention: 1000 clear/refill cycles -> same arrays, bytes constant, results bit-identical per cycle', () => {
    const out = new Float64Array(5);
    const sa = new SlidingAggregate(1000, { panes: 32 });
    const store = sa._store, pe = sa._paneEnd, bytes = sa.bytes;
    const buf = new Float64Array(2);
    let ref = null;
    for (let cyc = 0; cyc < 1000; cyc++) {
        sa.clear();
        const rnd = mulberry32(42);
        for (let i = 0; i < 300; i++) { buf[0] = 1.7e12 + i * 7.5; buf[1] = qz((rnd() - 0.5) * 1e3); sa.addFrom(buf, 0); }
        const r = readAll(sa, undefined, out).concat(readAll(sa, 250, out));
        if (ref === null) ref = r; else bitSame(ref, r, 'cycle ' + cyc);
        assert.ok(sa._store === store && sa._paneEnd === pe && sa.bytes === bytes, 'no realloc cycle ' + cyc);
    }
    assert.equal(bytes, 1584);
});

test('QA determinism: two instances (add vs addFrom) fed the same stream give bit-identical readers at every step', () => {
    const o1 = new Float64Array(5), o2 = new Float64Array(5), buf = new Float64Array(2);
    const a = new SlidingAggregate(1000, { panes: 30 }), b = new SlidingAggregate(1000, { panes: 30 });
    const rnd = mulberry32(7);
    let t = 1.75e12;
    for (let i = 0; i < 4000; i++) {
        t += rnd() < 0.99 ? rnd() * 20 : rnd() * 5000;
        const v = (rnd() - 0.5) * Math.exp(rnd() * 40);
        a.add(t, v); buf[0] = t; buf[1] = v; b.addFrom(buf, 0);
        if ((i & 7) === 0) { a.advance(t); buf[0] = t; b.advanceFrom(buf, 0); }
        const w = [undefined, 500, 1000 / 3, 1][i & 3];
        bitSame(readAll(a, w, o1), readAll(b, w, o2), 'i=' + i);
    }
    sameSnap(snap(a), snap(b), 'final state');
});

// ---------------------------------------------------------------------------------------------
// 11. adversarial: re-entrancy + clear mid-stream + a lying container
// ---------------------------------------------------------------------------------------------
test('QA adversarial: re-entrant add from an into() length getter is applied before the merge; clear mid-iteration over instances', () => {
    const sa = new SlidingAggregate(100);
    sa.add(1, 1);
    class ReLen extends Float64Array { get length() { sa.add(2, 10); return super.length; } }
    const o = new ReLen(5);
    sa.into(o);
    assert.deepEqual(Array.from(o), [2, 11, 5.5, 1, 10], 'the merge sees the re-entrant write, consistently');
    // clear during iteration over a set of instances: others unaffected, the cleared one re-locks
    const insts = [new SlidingAggregate(100), new SlidingAggregate(100), new SlidingAggregate(100)];
    for (let i = 0; i < 30; i++) for (let k = 0; k < 3; k++) { insts[k].add(i, k + 1); if (i === 15 && k === 1) insts[1].clear(); }
    assert.equal(insts[0].count(), 30); assert.equal(insts[2].count(), 30);
    assert.equal(insts[1].count(), 14); assert.equal(insts[1].sum(), 28);
});

// ---------------------------------------------------------------------------------------------
// 12. QA FINDINGS (now FIXED, fail-closed). ADR 0012 claims "the covered span ... always CONTAINS the
//     true window" (count >= true(W)). Three configs used to break it SILENTLY (fail open); each now
//     throws [lite-adaptive] BEFORE any state write, a byte-identical no-op. The clock-precision domain
//     is |now| <= pw * 2^42 and the pane width must be a NORMAL double (SA_CLOCK_SPAN / SA_MIN_NORMAL).
// ---------------------------------------------------------------------------------------------
test('QA FINDING F-QA190-1 FIXED: W/B below ulp(now) is out of the clock-precision domain -> throws, no-op', () => {
    const sa = new SlidingAggregate(1e-3);          // pw = 3.125e-5, nowMax = pw * 2^42 = 1.374e8
    const t = 1.75e12;                              // 1.75e12 >> 1.374e8 -> fail closed
    rejectNoOp(sa, () => sa.add(t, 1), RangeError, 'F1 add at |now| > pw*2^42');
    assert.equal(sa.mode, 'unset', 'F1 rejected first add leaves the instance unset');
    // a legal small clock in the same instance still works (the domain is a real bound, not a wall).
    sa.add(1, 1).add(1, 2).add(1, 3);
    assert.equal(sa.count(), 3, 'three items at the same legal now are all inside (now - W, now]');
});

test('QA FINDING F-QA190-2 FIXED: a large clock (ulp(now) > pw) is rejected fail-closed before any write', () => {
    const W = 736, sa = new SlidingAggregate(W, { panes: 32 });   // pw = 23, nowMax = 23 * 2^42 = 1.011e14
    rejectNoOp(sa, () => sa.add(1e17, 1), RangeError, 'F2 add at 1e17 >> nowMax');
    assert.equal(sa.mode, 'unset', 'F2 rejected first add is a no-op');
    // and via addFrom / advance / advanceFrom: same bound, same no-op.
    rejectNoOp(sa, () => sa.addFrom(new Float64Array([1e17, 1]), 0), RangeError, 'F2 addFrom');
    rejectNoOp(sa, () => sa.advance(1e17), RangeError, 'F2 advance');
    rejectNoOp(sa, () => sa.advanceFrom(new Float64Array([1e17]), 0), RangeError, 'F2 advanceFrom');
});

test('QA FINDING F-QA190-3 FIXED: a subnormal W / panes is rejected at the ctor door (BUILD throws)', () => {
    const q = 2 ** -1074, W = 1500 * q;
    assert.throws(() => new SlidingAggregate(W, { panes: 1024 }),      // pw rounds to a subnormal ~1.46q
        (e) => e instanceof RangeError && /subnormal/.test(e.message) && /\[lite-adaptive\]/.test(e.message),
        'F3 subnormal pane width fails closed at build');
});

// The containment guarantee INSIDE the legal domain, right at its edge: |now| just under pw * 2^42.
test('QA F-QA190 domain edge: at |now| just under pw * 2^42, count >= true(W) on 100% of 500 queries', () => {
    const W = 1024, B = 32, pw = W / B, sa = new SlidingAggregate(W, { panes: B });
    const nowMax = pw * 2 ** 42;                    // 32 * 2^42 = 1.407e14
    const ev = []; const step = pw / 4;             // sub-pane steps so panes fill densely
    let t = nowMax - 600 * step, bad = 0, q = 0;    // walk up toward the edge, staying under nowMax
    for (let i = 0; i < 500; i++) {
        t += step; assert.ok(t <= nowMax, 'stay inside the domain');
        sa.add(t, 1); ev.push([t, 1]);
        while (ev.length && ev[0][0] < t - 2 * W) ev.shift();
        if (sa.count() < trueCount(ev, t, W)) bad++;
        q++;
    }
    assert.equal(q, 500);
    assert.equal(bad, 0, bad + '/500 queries under-count the true window at the domain edge');
});

// Typical clock configs stay legal (the bound is generous for real epoch / performance.now clocks).
test('QA F-QA190 typical configs stay legal: epoch-ms, epoch-us, performance.now all add + read exactly', () => {
    const out = new Float64Array(5);
    // epoch-ms 1.75e12, W = 1000, panes 32 -> nowMax = 31.25 * 2^42 = 1.374e14 (>> 1.75e12).
    const ms = new SlidingAggregate(1000, { panes: 32 }); const pwMs = 1000 / 32; const evMs = [];
    for (let i = 0; i < 200; i++) { const t = 1.75e12 + i * 7.5; const v = qz(Math.sin(i) * 10); ms.add(t, v); evMs.push([t, v]); }
    checkAll(ms, covered(evMs, pwMs, 1.75e12 + 199 * 7.5, 1000), undefined, 'epoch-ms', out);
    // epoch-us 1.75e15, W = 1e6, panes 32 -> nowMax = 31250 * 2^42 = 1.374e17 (>> 1.75e15).
    const us = new SlidingAggregate(1e6, { panes: 32 }); const pwUs = 1e6 / 32; const evUs = [];
    for (let i = 0; i < 200; i++) { const t = 1.75e15 + i * 3200; const v = qz(Math.cos(i) * 10); us.add(t, v); evUs.push([t, v]); }
    checkAll(us, covered(evUs, pwUs, 1.75e15 + 199 * 3200, 1e6), undefined, 'epoch-us', out);
    // performance.now() W = 16, panes 32 -> nowMax = 0.5 * 2^42 = 2.199e12 ms (~25k days uptime).
    const pn = new SlidingAggregate(16, { panes: 32 }); const pwPn = 16 / 32; const evPn = [];
    for (let i = 0; i < 200; i++) { const t = 123456.75 + i * 0.125; const v = qz((i % 7) - 3); pn.add(t, v); evPn.push([t, v]); }
    checkAll(pn, covered(evPn, pwPn, 123456.75 + 199 * 0.125, 16), undefined, 'perf.now', out);
});

// ---------------------------------------------------------------------------------------------
// 13. A1 at the literal volume: >= 2000 queries PER (W, B) x shape cell (12 cells), 100% exact.
// ---------------------------------------------------------------------------------------------
test('QA A1 volume: >= 2000 queries per cell x 4 (W, B) x {lognormal, signed, count}; count/min/max exact, sum/mean in bound, into === scalars', () => {
    const out = new Float64Array(5);
    let cells = 0;
    for (const [W, B] of [[1024, 32], [1000, 32], [2000, 40], [512, 16]]) {
        for (const shape of ['lognormal', 'signed', 'count']) {
            const pw = W / B, rnd = mulberry32(W * 7 + B + shape.length);
            const sa = new SlidingAggregate(W, { panes: B }); const ev = [];
            let t = shape === 'count' ? 0 : qz(1.75e3 + rnd() * 100), q = 0;
            for (let i = 0; i < 2100; i++) {
                let v;
                if (shape === 'lognormal') v = qz(Math.exp(Math.log(4) + 1.5 * (rnd() + rnd() + rnd() - 1.5)));
                else v = qz((rnd() - 0.5) * 2 ** (rnd() * 40 - 10));
                if (shape === 'count') { t += 1; sa.add(undefined, v); }
                else { t += rnd() < 0.98 ? qz(rnd() * W / 200) : qz(rnd() * W / 3); sa.add(t, v); }
                ev.push([t, v]);
                while (ev.length && ev[0][0] < t - 2 * W) ev.shift();
                checkAll(sa, covered(ev, pw, t, W), undefined, W + '/' + B + '/' + shape + ' i=' + i, out);
                q++;
            }
            assert.ok(q >= 2000, 'queries per cell ' + q);
            cells++;
        }
    }
    assert.equal(cells, 12);
});
