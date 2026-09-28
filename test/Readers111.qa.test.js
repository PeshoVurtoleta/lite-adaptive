// @zakkster/lite-adaptive -- v1.11.0 zero-alloc READERS, QA boundary pass (ROADMAP 12).
//   node --test test/Readers111.qa.test.js
//
// Pins the two new readers against INDEPENDENT oracles:
//   - SlidingHyperLogLog.countInto(out, w?) -> 1  vs  count(w) (Object.is), a brute-force estimator
//     that re-derives every register straight from the ring columns (max rho over the TRUE window
//     (now - w, now]) with the textbook RETURNING Ertl sigma / tau, and the committed 1.10.0 source
//     (`git show dba0116:Adaptive.js`, read-only, imported as a data: URL -- never a file outside the
//     package). The 1.10.0 build is pinned by commit, so this stays meaningful after HEAD moves.
//   - DriftDetector.into(out) -> 5  vs  the five scalar getters (Object.is per slot).
//   - Allocation: the shipped AllocProbe lanes (pinned semi-space child) <= 0.5 B/op; controls >= 12.
//
// Cases marked `todo: 'QA111-...'` are FINDINGS (they fail on the current tree by design and are
// reported, not patched). ASCII only; node:test only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SlidingHyperLogLog, DriftDetector, DRIFT_PH, DRIFT_CUSUM,
    SlidingAggregate, SlidingCountMin, SlidingDDSketch, HeavyKeeper, DecayedReservoir } from '../Adaptive.js';
import { runLane } from './perf/AllocProbe.mjs';

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE_1_10_0 = 'dba0116';   // the committed 1.10.0 (package.json "version": "1.10.0")

let OLD;
async function old110() {
    if (OLD !== undefined) return OLD;
    try {
        const src = execFileSync('git', ['show', BASE_1_10_0 + ':Adaptive.js'], { cwd: PKG, encoding: 'utf8', maxBuffer: 64 << 20 });
        OLD = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
    } catch (e) {
        OLD = null;
    }
    return OLD;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const F = new Float64Array(1);
const U = new BigUint64Array(F.buffer);
function nextUp(x) { if (x === 0) return Number.MIN_VALUE; F[0] = x; U[0] += (x > 0 ? 1n : -1n); return F[0]; }
function nextDown(x) { if (x === 0) return -Number.MIN_VALUE; F[0] = x; U[0] += (x > 0 ? -1n : 1n); return F[0]; }
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const SENT = [7.25, -0, NaN, -3.5e300, Infinity, 1e-310, 42, -Infinity];
function fillSent(a) { for (let i = 0; i < a.length; i++) a[i] = SENT[i % SENT.length]; return a; }
function assertSent(a, from, to, msg) {
    for (let i = from; i < to; i++) {
        assert.ok(Object.is(a[i], SENT[i % SENT.length]), msg + ': slot ' + i + ' was written (' + a[i] + ')');
    }
}
function trapProxy(target, counter) {
    const h = {};
    for (const k of ['get', 'set', 'has', 'getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor', 'defineProperty', 'apply', 'construct']) {
        h[k] = (...a) => { counter.n++; return Reflect[k](...a); };
    }
    return new Proxy(target, h);
}

// ---- SHLL -----------------------------------------------------------------
function shllSnap(sl) {
    return JSON.stringify({
        st: Array.from(sl._stamps), rho: Array.from(sl._rho), h: Array.from(sl._head), l: Array.from(sl._len),
        hist: Array.from(sl._hist), o: sl._overflows, m: sl._mode, t: sl._tick, ln: sl._lastNow, n: sl._now,
    });
}
// Independent brute-force oracle: re-derive every register from the ring columns as the MAX rho over the
// TRUE window (now - w, now] (never the LFPM "oldest entry" shortcut), then the textbook Ertl estimator
// with sigma / tau as plain RETURNING functions (the pre-1.11.0 algebra, rewritten here from the paper).
function sigma(x) { if (x === 1) return Infinity; let y = 1, z = x, prev; do { x = x * x; prev = z; z += x * y; y += y; } while (z !== prev); return z; }
function tau(x) { if (x === 0 || x === 1) return 0; let y = 1, z = 1 - x, prev; do { x = Math.sqrt(x); prev = z; y *= 0.5; const d = 1 - x; z -= d * d * y; } while (z !== prev); return z / 3; }
function bruteCount(sl, w) {
    if (w !== undefined && !(typeof w === 'number' && Number.isFinite(w) && w > 0 && w <= sl.W)) return NaN;
    if (sl.mode === 'unset') return 0;
    const effW = w === undefined ? sl.W : w;
    const cut = sl._now - effW;
    const m = sl.m, cap = sl.ringCap, q = 64 - sl.p;
    const C = new Array(q + 2).fill(0);
    for (let j = 0; j < m; j++) {
        let r = 0;
        for (let e = 0; e < sl._len[j]; e++) {
            const cell = j * cap + ((sl._head[j] + e) & (cap - 1));
            if (sl._stamps[cell] > cut && sl._rho[cell] > r) r = sl._rho[cell];
        }
        C[r]++;
    }
    let z = m * tau((m - C[q + 1]) / m);
    for (let k = q; k >= 1; k--) z = 0.5 * (z + C[k]);
    z += m * sigma(C[0] / m);
    return Math.round((0.5 / Math.LN2) * m * m / z);
}
const KEYS = (r) => {
    const u = r();
    if (u < 0.6) return (r() * 1e6) | 0;
    if (u < 0.8) return Math.floor(r() * 9007199254740991);
    if (u < 0.95) return -Math.floor(r() * 4294967296 * 8);
    return 4294967296 + ((r() * 1000) | 0);
};
function feed(sl, explicit, n, r, clk) {
    for (let i = 0; i < n; i++) {
        if (explicit) { clk.t += r() * 3; sl.add(clk.t, KEYS(r)); } else sl.add(undefined, KEYS(r));
    }
}
function badWs(W, counter) {
    return [0, -0, NaN, Infinity, -Infinity, nextUp(W), W * 2, -1, -Number.MIN_VALUE, '5', null, true, 5n,
        Symbol('w'), { valueOf() { return 5; } }, [5], new Number(5), trapProxy({}, counter), trapProxy(function () {}, counter)];
}
function goodWs(W) {
    return [undefined, W, nextDown(W), W / 2, W / 3, 1, Number.MIN_VALUE, 1e-300, 0.75];
}

// ---- DD -------------------------------------------------------------------
function ddSnap(dd) {
    return JSON.stringify([dd._n, dd._mean, dd._gP, dd._gN, dd._mMin, dd._mMax, dd._lDir, dd._lvl, Array.from(dd._s)].map((v) => (Array.isArray(v) ? v.map(String) : String(v))));
}
function ddGetters(dd) { return [dd.statistic, dd.mean, dd.count, dd.lastDriftIndex, dd.lastDirection]; }
function assertInto(dd, out, off, msg) {
    const g = ddGetters(dd);
    for (let k = 0; k < 5; k++) {
        assert.ok(Object.is(out[off + k], g[k]), msg + ': slot ' + k + ' into=' + out[off + k] + ' getter=' + g[k]);
    }
}
const DD_CFGS = [
    { mode: 'PH', latch: false, make: () => new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 }) },
    { mode: 'PH', latch: true, make: () => new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5, latch: true }) },
    { mode: 'CUSUM', latch: false, make: () => new DriftDetector(DRIFT_CUSUM, { delta: 0.5, threshold: 5, target: 0 }) },
    { mode: 'CUSUM', latch: true, make: () => new DriftDetector(DRIFT_CUSUM, { delta: 0.5, threshold: 5, target: 0, latch: true }) },
];
// regime signal: baseline, up-step, sustained, down-step, return (fractional so getters are doubles)
function ddSignal(i, r) {
    const ph = i % 1200;
    const lvl = ph < 300 ? 0 : ph < 600 ? 8 : ph < 900 ? -6 : 0;
    return lvl + (r() - 0.5) * 0.3;
}

// ===========================================================================
// 1. SlidingHyperLogLog.countInto vs count(w) vs brute force
// ===========================================================================
test('SHLL 1a: state x geometry matrix -- countInto Object.is count(w) Object.is brute force (p 4/16 x ringCap 2/64 x explicit/count; unset / live / degraded / empty-after-advance / cleared; good + bad w)', () => {
    let checks = 0, degradedSeen = 0, emptySeen = 0;
    for (const p of [4, 16]) for (const rc of [2, 64]) for (const explicit of [true, false]) {
        const W = explicit ? 250.5 : 3000;
        const sl = new SlidingHyperLogLog(W, { p, ringCap: rc, seed: 11 });
        const r = rng(p * 131 + rc * 7 + (explicit ? 1 : 0));
        const clk = { t: 1.7e12 + 0.25 };
        const out = new Float64Array(3);
        const counter = { n: 0 };
        const check = (label) => {
            for (const w of goodWs(W).concat(badWs(W, counter))) {
                fillSent(out);
                const e = sl.count(w);
                const ret = sl.countInto(out, w);
                const b = bruteCount(sl, w);
                const tag = 'p' + p + ' rc' + rc + (explicit ? ' explicit' : ' count') + ' ' + label + ' w=' + (typeof w === 'number' || w === undefined ? String(w) : typeof w);
                assert.equal(ret, 1, tag + ': returns 1');
                assert.ok(Object.is(out[0], e), tag + ': countInto ' + out[0] + ' vs count ' + e);
                assert.ok(Object.is(e, b), tag + ': count ' + e + ' vs brute ' + b);
                assertSent(out, 1, 3, tag);
                checks++;
            }
        };
        check('unset');
        feed(sl, explicit, 40, r, clk); check('small');
        feed(sl, explicit, p === 16 ? 6000 : 2500, r, clk); check('live');
        if (sl.degraded) degradedSeen++;
        if (explicit) {
            sl.advance(clk.t + W * 3); check('empty-after-advance');
            if (sl.count() === 0) emptySeen++;
            clk.t = sl.lastNow; feed(sl, explicit, 30, r, clk); check('after advance + refill');
        }
        sl.clear(); check('cleared');
        sl.clear(); check('cleared twice');
        feed(sl, explicit, 500, r, { t: 1e9 }); check('refilled');
        assert.equal(counter.n, 0, 'a Proxy w must never be touched (typeof only)');
    }
    assert.ok(degradedSeen >= 2, 'precondition: ringCap 2 banks degraded (' + degradedSeen + ')');
    assert.ok(emptySeen === 4, 'precondition: advance emptied every explicit sketch (' + emptySeen + ')');
    assert.ok(checks > 1000, 'checks ' + checks);
});

test('SHLL 1b: saturated banks (rho = q+1 corrupted in) -- countInto / count / brute / 1.10.0 agree incl. the Infinity estimate', async () => {
    const H = await old110();
    assert.ok(H, 'the 1.10.0 source (git show ' + BASE_1_10_0 + ':Adaptive.js) must be loadable -- unmeasured is a FAIL');
    let nonTrivialTau = 0;
    for (const p of [4, 16]) for (const rc of [2, 64]) for (const frac of [0.001, 0.3, 0.5, 0.97, 1]) {
        const a = new SlidingHyperLogLog(1000, { p, ringCap: rc });
        const h = new H.SlidingHyperLogLog(1000, { p, ringCap: rc });
        const r1 = rng(9 + p + rc), r2 = rng(9 + p + rc);
        feed(a, true, p === 16 ? 200000 : 3000, r1, { t: 0 }); feed(h, true, p === 16 ? 200000 : 3000, r2, { t: 0 });
        const q = 64 - p, m = 1 << p;
        const lim = Math.floor(m * frac);
        for (const s of [a, h]) {
            for (let j = 0; j < lim; j++) {
                if (s._len[j] === 0) s._len[j] = 1;
                for (let e = 0; e < s._len[j]; e++) { const cell = j * rc + ((s._head[j] + e) & (rc - 1)); s._rho[cell] = q + 1; s._stamps[cell] = s._now; }
            }
        }
        const out = new Float64Array(1);
        for (const w of [undefined, 1000, 500, 1, nextDown(1000)]) {
            const e = a.count(w); a.countInto(out, w);
            const o = h.count(w), b = bruteCount(a, w);
            const tag = 'p' + p + ' rc' + rc + ' sat=' + frac + ' w=' + w;
            assert.ok(Object.is(out[0], e), tag + ': countInto ' + out[0] + ' vs count ' + e);
            assert.ok(Object.is(e, o), tag + ': count ' + e + ' vs 1.10.0 ' + o);
            assert.ok(Object.is(e, b), tag + ': count ' + e + ' vs brute ' + b);
            if (frac > 0 && frac < 1 && w === undefined) nonTrivialTau++;
            if (frac === 1 && w === undefined) assert.equal(e, Infinity, tag + ': a fully saturated bank reads Infinity (S4)');
        }
    }
    assert.ok(nonTrivialTau >= 12, 'precondition: the tau branch ran on 0 < x < 1');
});

test('SHLL 1c: sub-window boundaries -- w = W, W - ulp, tiny, and W + ulp at fractional / huge W', () => {
    for (const W of [1, 0.1, 250.5, 1e15, 2 ** 53, 1.7976931348623157e308]) {
        const sl = new SlidingHyperLogLog(W, { p: 6, ringCap: 8 });
        const r = rng(3);
        const clk = { t: 0 };
        for (let i = 0; i < 400; i++) { clk.t += W / 500; sl.add(clk.t, KEYS(r)); }
        const out = new Float64Array(1);
        for (const w of [W, nextDown(W), Number.MIN_VALUE, W / 2, nextUp(W)]) {
            fillSent(out);
            assert.equal(sl.countInto(out, w), 1);
            const e = sl.count(w);
            assert.ok(Object.is(out[0], e), 'W=' + W + ' w=' + w + ': ' + out[0] + ' vs ' + e);
            assert.ok(Object.is(e, bruteCount(sl, w)), 'W=' + W + ' w=' + w + ': brute');
            if (w === nextUp(W)) assert.ok(Number.isNaN(out[0]), 'W + ulp is out of (0, W] -> NaN');
        }
    }
});

test('SHLL 1d: interleaved across 3 instances -- A.count() between B/C.countInto calls never leaks the shared module scratch', () => {
    const A = new SlidingHyperLogLog(500, { p: 4, ringCap: 2 });
    const B = new SlidingHyperLogLog(800, { p: 12, ringCap: 16 });
    const C = new SlidingHyperLogLog(2000, { p: 8, ringCap: 64 });
    const r = rng(77);
    const cA = { t: 0 }, cB = { t: 1e12 };
    const oB = new Float64Array(1), oB2 = new Float64Array(2), oC = new Float64Array(1);
    let checks = 0;
    for (let round = 0; round < 60; round++) {
        feed(A, true, 50, r, cA); feed(B, true, 300, r, cB); feed(C, false, 200, r, null);
        if (round === 30) B.clear();
        const wB = 800 * r() + 1e-9, wA = 500 * r() + 1e-9, wC = 1 + ((r() * 1999) | 0);
        // independent expectations (brute force reads only the rings -- never the module scratch)
        const eA = bruteCount(A), eAw = bruteCount(A, wA), eB = bruteCount(B), eBw = bruteCount(B, wB), eC = bruteCount(C, wC);
        for (let k = 0; k < 20; k++) {
            B.countInto(oB);
            const a1 = A.count();
            B.countInto(oB2, wB);
            const a2 = A.count(wA);
            C.countInto(oC, wC);
            const b1 = B.count();
            A.countInto(oB2.subarray(1), NaN);    // bad-w write path between the others
            const c1 = C.count(wC);
            assert.ok(Object.is(oB[0], eB), 'B.countInto after A.count: ' + oB[0] + ' vs ' + eB);
            assert.ok(Object.is(a1, eA), 'A.count between B calls: ' + a1 + ' vs ' + eA);
            assert.ok(Object.is(oB2[0], eBw), 'B.countInto(w): ' + oB2[0] + ' vs ' + eBw);
            assert.ok(Number.isNaN(oB2[1]), 'A bad-w NaN write landed in its own view');
            assert.ok(Object.is(a2, eAw), 'A.count(w): ' + a2 + ' vs ' + eAw);
            assert.ok(Object.is(oC[0], eC), 'C.countInto: ' + oC[0] + ' vs ' + eC);
            assert.ok(Object.is(b1, eB), 'B.count after C.countInto: ' + b1 + ' vs ' + eB);
            assert.ok(Object.is(c1, eC), 'C.count: ' + c1 + ' vs ' + eC);
            checks += 8;
        }
    }
    assert.ok(checks >= 9000);
});

test('SHLL 1e: count() / countInto vs the committed 1.10.0 count() over 1e5 random queries x 5 configs (bad w, advance, clear interleaved)', async () => {
    const H = await old110();
    assert.ok(H, 'the 1.10.0 source must be loadable -- unmeasured is a FAIL');
    const CFGS = [
        { W: 500.25, p: 4, ringCap: 2, explicit: true },
        { W: 3000, p: 6, ringCap: 64, explicit: false },
        { W: 60000, p: 8, ringCap: 8, explicit: true, epoch: true },
        { W: 20000, p: 10, ringCap: 4, explicit: false },
        { W: 1e4, p: 10, ringCap: 64, explicit: true },
    ];
    const Q = 100000;
    let total = 0, mism = 0, bruteChecked = 0, nanQ = 0;
    const first = [];
    for (let ci = 0; ci < CFGS.length; ci++) {
        const c = CFGS[ci];
        const a = new SlidingHyperLogLog(c.W, { p: c.p, ringCap: c.ringCap, seed: 5 + ci });
        const h = new H.SlidingHyperLogLog(c.W, { p: c.p, ringCap: c.ringCap, seed: 5 + ci });
        const r = rng(1000 + ci);
        const out = new Float64Array(1);
        let t = c.epoch ? 1.727e12 + 0.125 : 0.5;
        const bad = badWs(c.W, { n: 0 });
        for (let qi = 0; qi < Q; qi++) {
            const nAdd = (r() * 4) | 0;
            for (let k = 0; k < nAdd; k++) {
                const key = KEYS(r);
                if (c.explicit) { t += r() * (c.W / 400); a.add(t, key); h.add(t, key); } else { a.add(undefined, key); h.add(undefined, key); }
            }
            if (c.explicit && r() < 0.001) { t += c.W * r() * 2; a.advance(t); h.advance(t); }
            if (r() < 0.00005) { a.clear(); h.clear(); t = c.epoch ? 1.727e12 + 0.125 : 0.5; }
            const u = r();
            let w;
            if (u < 0.1) w = undefined;
            else if (u < 0.15) w = c.W;
            else if (u < 0.18) w = nextDown(c.W);
            else if (u < 0.2) w = Number.MIN_VALUE * (1 + ((r() * 9) | 0));
            else if (u < 0.28) { w = bad[(r() * bad.length) | 0]; nanQ++; }
            else w = r() * c.W || c.W;
            const e = a.count(w);
            a.countInto(out, w);
            const o = h.count(w);
            total++;
            if (!Object.is(e, o) || !Object.is(out[0], o)) {
                mism++;
                if (first.length < 5) first.push({ cfg: ci, qi, w: String(w), count: e, into: out[0], v110: o });
            }
            if ((qi & 1023) === 0) {
                bruteChecked++;
                assert.ok(Object.is(e, bruteCount(a, w)), 'cfg ' + ci + ' q ' + qi + ': brute');
            }
        }
    }
    assert.equal(mism, 0, 'mismatches vs 1.10.0: ' + mism + '/' + total + ' ' + JSON.stringify(first));
    assert.equal(total, 5 * Q);
    assert.ok(nanQ > 30000 && bruteChecked > 400);
});

// ===========================================================================
// 2. countInto containers (S2)
// ===========================================================================
function liveShll() {
    const sl = new SlidingHyperLogLog(1000, { p: 8, ringCap: 8 });
    const r = rng(5);
    feed(sl, true, 3000, r, { t: 0 });
    return sl;
}

test('SHLL 2a: a subarray at an offset writes exactly out[0] of the view; N-1 / N / N+1 lengths', () => {
    const sl = liveShll();
    const e = sl.count(), ew = sl.count(333.3);
    const big = fillSent(new Float64Array(16));
    for (const off of [0, 3, 15]) {
        fillSent(big);
        const v = big.subarray(off, off + 1);
        assert.equal(sl.countInto(v), 1);
        assert.ok(Object.is(big[off], e));
        assertSent(big, 0, off, 'before off ' + off); assertSent(big, off + 1, 16, 'after off ' + off);
        fillSent(big);
        sl.countInto(big.subarray(off), 333.3);
        assert.ok(Object.is(big[off], ew));
        assertSent(big, 0, off, 'w before'); assertSent(big, off + 1, 16, 'w after');
    }
    // N-1 (0) rejects; N (1) and N+1 (2) accept and write only slot 0
    assert.throws(() => sl.countInto(big.subarray(16)), (err) => err instanceof RangeError && /^\[lite-adaptive\]/.test(err.message));
    const two = fillSent(new Float64Array(2));
    sl.countInto(two); assert.ok(Object.is(two[0], e)); assertSent(two, 1, 2, 'N+1');
    // bad w on a subarray writes NaN only in the view's slot 0
    fillSent(big); sl.countInto(big.subarray(5, 7), -0);
    assert.ok(Number.isNaN(big[5])); assertSent(big, 0, 5, 'badw'); assertSent(big, 6, 16, 'badw');
});

test('SHLL 2b: a length-lying / throwing / re-entrant length subclass over a valid backing is accepted and the getter never runs', () => {
    const sl = liveShll();
    const e = sl.count();
    let ran = 0;
    class Lie0 extends Float64Array { get length() { ran++; return 0; } }
    class LieNaN extends Float64Array { get length() { ran++; return NaN; } }
    class Throw extends Float64Array { get length() { ran++; throw new Error('length ran'); } }
    class Reenter extends Float64Array { get length() { ran++; sl.add(sl.lastNow + 1, 424242); sl.clear(); return 1; } }
    const before = shllSnap(sl);
    for (const K of [Lie0, LieNaN, Throw, Reenter]) {
        const o = new K(1);
        assert.equal(sl.countInto(o), 1, K.name);
        assert.ok(Object.is(o[0], e), K.name + ': ' + o[0] + ' vs ' + e);
        const o2 = new K(0);
        assert.throws(() => sl.countInto(o2), RangeError, K.name + ' length 0 rejects on the TRUE length');
    }
    class Lie99 extends Float64Array { get length() { ran++; return 99; } }
    assert.throws(() => sl.countInto(new Lie99(0)), RangeError, 'a lie cannot widen an empty backing');
    assert.equal(ran, 0, 'a subclass length getter ran ' + ran + ' time(s)');
    assert.equal(shllSnap(sl), before, 're-entrant getter never ran: state unchanged');
});

test('SHLL 2c: Proxy / Float32Array / Array / DataView / length 0 / detached / out-of-bounds / primitives rejected as a byte-identical no-op (container + sketch + untouched Proxy)', () => {
    const sl = liveShll();
    const e = sl.count();
    const before = shllSnap(sl);
    const counter = { n: 0 };
    const f32 = new Float32Array([1.5, 2.5]);
    const arr = [1.5, 2.5];
    const dv = new DataView(new ArrayBuffer(16)); dv.setFloat64(0, 1.5);
    const det = new Float64Array(new ArrayBuffer(16)); det[0] = 9; structuredClone(det.buffer, { transfer: [det.buffer] });
    const rab = new ArrayBuffer(16, { maxByteLength: 64 }); const oob = new Float64Array(rab, 8, 1); rab.resize(0);
    const cases = [
        ['Proxy(F64)', trapProxy(new Float64Array(2), counter), TypeError],
        ['Float32Array', f32, TypeError], ['Array', arr, TypeError], ['DataView', dv, TypeError],
        ['BigUint64Array', new BigUint64Array(2), TypeError], ['Uint8Array', new Uint8Array(8), TypeError],
        ['F64 length 0', new Float64Array(0), RangeError], ['detached view', det, RangeError], ['out-of-bounds view', oob, RangeError],
        ['null', null, TypeError], ['undefined', undefined, TypeError], ['NaN', NaN, TypeError], ['-0', -0, TypeError],
        ['{length:1}', { length: 1, 0: 0 }, TypeError], ['Object.create(F64.prototype)', Object.create(Float64Array.prototype), TypeError],
    ];
    for (const [name, o, E] of cases) {
        for (const w of [undefined, NaN, 5]) {   // container is checked FIRST: a bad w never reaches the NaN write
            assert.throws(() => sl.countInto(o, w), (err) => err instanceof E && /^\[lite-adaptive\] SlidingHyperLogLog\.countInto out must/.test(err.message), name + ' w=' + w);
        }
    }
    assert.equal(counter.n, 0, 'a Proxy out fired ' + counter.n + ' trap(s)');
    assert.deepEqual(Array.from(f32), [1.5, 2.5]); assert.deepEqual(arr, [1.5, 2.5]); assert.equal(dv.getFloat64(0), 1.5);
    assert.equal(shllSnap(sl), before, 'rejected container changed sketch state');
    assert.ok(Object.is(sl.count(), e));
    // a resizable, length-tracking view that GREW from 0 is a valid Float64Array
    const rab2 = new ArrayBuffer(0, { maxByteLength: 64 }); const grow = new Float64Array(rab2); rab2.resize(8);
    assert.equal(sl.countInto(grow), 1); assert.ok(Object.is(grow[0], e));
});

test('SHLL 2d: adversarial -- out aliasing the sketch\'s OWN ring column writes the pre-call estimate (the write lands after the scan)', () => {
    const sl = liveShll();
    const e = sl.count();
    const view = sl._stamps.subarray(0, 1);
    sl.countInto(view);
    assert.ok(Object.is(sl._stamps[0], e), 'aliased write ' + sl._stamps[0] + ' vs ' + e);
});

// QA111-R1 (RESOLVED, S2 RE-SETTLED): the OLD guard `ArrayBuffer.isView(out) && out instanceof
// Float64Array` was satisfied by a NON-Float64 typed array whose prototype was swapped to
// Float64Array.prototype; TA_LEN read its (Uint8) length and the reader wrote a silently TRUNCATED
// value (count 990 -> 222). The intrinsic @@toStringTag check (TA_TAG.call(x) === 'Float64Array')
// reads [[TypedArrayName]] and rejects it (TypeError, byte-identical no-op).
test('SHLL 2e: a prototype-swapped Uint8Array is not a Float64Array -- must reject (TypeError), not truncate', () => {
    const sl = liveShll();
    const u8 = new Uint8Array(4); Object.setPrototypeOf(u8, Float64Array.prototype);
    assert.throws(() => sl.countInto(u8), (err) => err instanceof TypeError && /^\[lite-adaptive\]/.test(err.message));
});
// QA111-R2 (RESOLVED, S2 RE-SETTLED): a prototype-swapped DataView used to pass isView + instanceof and
// then hit the TA_LEN intrinsic's NATIVE TypeError ("Method get TypedArray.prototype.length called on
// incompatible receiver") -- a no-op, but not the S2 `[lite-adaptive] ... describeArg` message. TA_TAG
// returns undefined for a DataView, so the S2 type guard now throws the tagged message.
test('SHLL 2f: a prototype-swapped DataView rejects with the [lite-adaptive] message', () => {
    const sl = liveShll();
    const dv = new DataView(new ArrayBuffer(16)); Object.setPrototypeOf(dv, Float64Array.prototype);
    assert.throws(() => sl.countInto(dv), (err) => err instanceof TypeError && /^\[lite-adaptive\]/.test(err.message));
});

// ===========================================================================
// 3. DriftDetector.into vs the getters
// ===========================================================================
test('DD 3a: into Object.is the 5 getters every item -- PH / CUSUM x latch on / off; empty, fired, latched, after clear, clear -> quiet', () => {
    for (const c of DD_CFGS) {
        const dd = c.make();
        const out = fillSent(new Float64Array(7));
        const tag = c.mode + ' latch=' + c.latch;
        assert.equal(dd.into(out), 5);
        assertInto(dd, out, 0, tag + ' empty');
        assert.ok(Object.is(out[0], 0) && Object.is(out[1], 0) && Object.is(out[2], 0) && Number.isNaN(out[3]) && Number.isNaN(out[4]), tag + ' empty reads [0,0,0,NaN,NaN]');
        assertSent(out, 5, 7, tag + ' N+1');
        const r = rng(c.mode.length * 3 + (c.latch ? 1 : 0));
        let fires = 0, latchedItems = 0, zeroCountAfterFire = 0;
        for (let i = 0; i < 6000; i++) {
            const f = dd.add(ddSignal(i, r));
            if (f) fires++;
            if (dd.latched) latchedItems++;
            if (f && dd.count === 0) zeroCountAfterFire++;
            dd.into(out);
            assertInto(dd, out, 0, tag + ' item ' + i);
        }
        assert.ok(fires >= 8, tag + ' precondition fires ' + fires);
        if (c.latch) assert.ok(latchedItems > 500, tag + ' precondition latched ' + latchedItems);
        // clear -> quiet: no fire, lastDriftIndex / lastDirection back to NaN (clear drops the fire log)
        dd.clear(); dd.into(out); assertInto(dd, out, 0, tag + ' after clear');
        assert.ok(Number.isNaN(out[3]) && Number.isNaN(out[4]));
        dd.clear(); dd.into(out); assertInto(dd, out, 0, tag + ' clear twice');
        for (let i = 0; i < 500; i++) {
            assert.equal(dd.add(0.01 * (i % 3)), false);
            dd.into(out); assertInto(dd, out, 0, tag + ' quiet ' + i);
        }
        assert.ok(Number.isNaN(out[3]), tag + ' quiet after clear keeps NaN index');
        assertSent(out, 5, 7, tag + ' tail');
    }
});

test('DD 3b: into across the latched-PH re-centre trip (ramp, th = 0.01) -- every item Object.is the getters', () => {
    const TH = 0.01;
    const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: TH, latch: true });
    const out = new Float64Array(5);
    let rc = 0, prevMax = 0;
    for (let i = 0; i < 300000; i++) {
        dd.add(i);
        if (dd._mMax === 0 && prevMax > TH * 1048576 * 0.5) rc++;
        prevMax = dd._mMax;
        dd.into(out);
        const g0 = dd.statistic, g1 = dd.mean, g2 = dd.count, g3 = dd.lastDriftIndex, g4 = dd.lastDirection;
        if (!(Object.is(out[0], g0) && Object.is(out[1], g1) && Object.is(out[2], g2) && Object.is(out[3], g3) && Object.is(out[4], g4))) {
            assert.fail('item ' + i + ': into [' + Array.from(out) + '] vs getters [' + [g0, g1, g2, g3, g4] + ']');
        }
    }
    for (let i = 0; i < 3000; i++) { dd.add(-1e6); dd.into(out); assertInto(dd, out, 0, 'reversal ' + i); }
    assert.ok(rc > 0, 'precondition: the re-centre tripped (' + rc + ')');
});

test('DD 3c: a non-finite accumulator throws the getter RangeError; out (sentinel-filled) untouched; _n = 0 reads the empty row without throwing', () => {
    for (const c of DD_CFGS) {
        for (const field of ['_mean', '_gP', '_gN', '_mMin', '_mMax']) {
            for (const bad of [NaN, Infinity, -Infinity]) {
                const dd = c.make();
                for (let i = 0; i < 6; i++) dd.add(0.1 * (i % 3));
                assert.ok(dd.count > 0);
                dd[field] = bad;
                let gErr = null;
                try { void dd.statistic; } catch (e) { gErr = e; }
                assert.ok(gErr instanceof RangeError);
                let mErr = null;
                try { void dd.mean; } catch (e) { mErr = e; }
                const out = fillSent(new Float64Array(6));
                const before = ddSnap(dd);
                assert.throws(() => dd.into(out), (e) => e instanceof RangeError && e.message === gErr.message && e.message === mErr.message,
                    c.mode + ' ' + field + '=' + bad);
                assertSent(out, 0, 6, c.mode + ' ' + field + '=' + bad);
                assert.equal(ddSnap(dd), before, 'a throwing into mutated state');
                // _n = 0 (after a latch:false / PH fire): the getters do not guard, so neither may into
                dd._n = 0;
                dd.into(out); assertInto(dd, out, 0, c.mode + ' ' + field + ' n=0');
            }
        }
        // _n corrupted to NaN with finite accumulators: getters read (count NaN); into must match
        const dd = c.make(); for (let i = 0; i < 20; i++) dd.add(0.1 * i);
        dd._n = NaN; const out = new Float64Array(5);
        dd.into(out); assertInto(dd, out, 0, c.mode + ' n=NaN');
    }
});

test('DD 3d: 50-channel subarray packing with guard slots, a clear() mid-sweep, and a re-used view', () => {
    const CH = 50;
    const big = fillSent(new Float64Array(CH * 5 + 6));
    const views = [], dds = [], rs = [];
    for (let i = 0; i < CH; i++) {
        views.push(big.subarray(3 + i * 5, 3 + i * 5 + 5));
        dds.push(DD_CFGS[i % 4].make());
        rs.push(rng(500 + i));
    }
    let fires = 0;
    for (let step = 0; step < 1500; step++) {
        for (let i = 0; i < CH; i++) {
            if (dds[i].add(ddSignal(step + i * 37, rs[i]))) fires++;
            if (step % 250 === 0 && i === (step / 250) % CH) dds[(i + 1) % CH].clear();   // dispose-during-iteration
            dds[i].into(views[i]);
        }
        for (let i = 0; i < CH; i++) assertInto(dds[i], big, 3 + i * 5, 'ch ' + i + ' step ' + step);
        assertSent(big, 0, 3, 'guard head'); assertSent(big, CH * 5 + 3, CH * 5 + 6, 'guard tail');
    }
    assert.ok(fires > 200, 'precondition fires ' + fires);
});

test('DD 3e: containers -- N-1 / N / N+1; Proxy / non-F64 / detached / primitives reject as a byte-identical no-op; lying / re-entrant length never runs', () => {
    const dd = DD_CFGS[1].make();
    const r = rng(8);
    for (let i = 0; i < 700; i++) dd.add(ddSignal(i, r));
    const before = ddSnap(dd);
    const counter = { n: 0 };
    const det = new Float64Array(new ArrayBuffer(40)); structuredClone(det.buffer, { transfer: [det.buffer] });
    const f32 = new Float32Array(5).fill(1.5);
    const cases = [
        ['F64 length 4 (N-1)', new Float64Array(4), RangeError], ['F64 length 0', new Float64Array(0), RangeError],
        ['detached', det, RangeError], ['Proxy(F64 5)', trapProxy(new Float64Array(5), counter), TypeError],
        ['Float32Array', f32, TypeError], ['Array(5)', [0, 0, 0, 0, 0], TypeError], ['DataView', new DataView(new ArrayBuffer(40)), TypeError],
        ['null', null, TypeError], ['undefined', undefined, TypeError], ['NaN', NaN, TypeError], ['-0', -0, TypeError],
    ];
    for (const [name, o, E] of cases) {
        assert.throws(() => dd.into(o), (err) => err instanceof E && /^\[lite-adaptive\] DriftDetector\.into/.test(err.message), name);
    }
    assert.equal(counter.n, 0, 'Proxy traps fired');
    assert.ok(f32.every((v) => v === 1.5));
    assert.equal(ddSnap(dd), before);
    let ran = 0;
    class Lie0 extends Float64Array { get length() { ran++; return 0; } }
    class Lie99 extends Float64Array { get length() { ran++; return 99; } }
    class Reenter extends Float64Array { get length() { ran++; dd.add(1e6); dd.clear(); return 5; } }
    const l0 = new Lie0(5); assert.equal(dd.into(l0), 5); assertInto(dd, l0, 0, 'Lie0');
    const re = new Reenter(5); assert.equal(dd.into(re), 5); assertInto(dd, re, 0, 'Reenter');
    assert.throws(() => dd.into(new Lie99(4)), RangeError);
    assert.equal(ran, 0, 'length getter ran');
    assert.equal(ddSnap(dd), before);
    const six = fillSent(new Float64Array(6)); dd.into(six); assertInto(dd, six, 0, 'N+1'); assertSent(six, 5, 6, 'N+1 tail');
    // re-entrant write: the SAME out shared by two detectors -> last writer wins, each Object.is its own getters
    const other = DD_CFGS[2].make(); for (let i = 0; i < 50; i++) other.add(i * 0.2);
    const shared = new Float64Array(5);
    dd.into(shared); other.into(shared); assertInto(other, shared, 0, 'shared out, second writer');
    dd.into(shared); assertInto(dd, shared, 0, 'shared out, back');
});

test('DD 3f: a prototype-swapped Uint8Array / DataView is not a Float64Array -- must reject with the tagged message', () => {
    const dd = new DriftDetector(DRIFT_PH, { threshold: 5 });
    for (let i = 0; i < 50; i++) dd.add(i * 0.37);
    const u8 = new Uint8Array(8); Object.setPrototypeOf(u8, Float64Array.prototype);
    assert.throws(() => dd.into(u8), (err) => err instanceof TypeError && /^\[lite-adaptive\]/.test(err.message));
    const dv = new DataView(new ArrayBuffer(40)); Object.setPrototypeOf(dv, Float64Array.prototype);
    assert.throws(() => dd.into(dv), (err) => err instanceof TypeError && /^\[lite-adaptive\]/.test(err.message));
});

// QA111-R1 / R2 for the 5 older cold readers (S2 RE-SETTLED extends the intrinsic-tag guard to every cold
// reader): a prototype-swapped Uint8Array and a prototype-swapped DataView must each REJECT with the
// tagged [lite-adaptive] TypeError, never truncate to uint8 and never hit a native TA_LEN throw. Plus a
// verification that TA_TAG (the %TypedArray%.prototype[@@toStringTag] getter) returns undefined for a
// Proxy / DataView / plain object / primitive without throwing and without running any user trap.
test('OLD-READERS 5: prototype-swapped Uint8Array + DataView reject with the tagged message on SA / SCM / SDD / HK / DR', () => {
    const swapU8 = (n) => { const u = new Uint8Array(n); Object.setPrototypeOf(u, Float64Array.prototype); return u; };
    const swapDV = (n) => { const d = new DataView(new ArrayBuffer(n * 8)); Object.setPrototypeOf(d, Float64Array.prototype); return d; };
    const tagged = (err) => err instanceof TypeError && /^\[lite-adaptive\]/.test(err.message);

    const sa = new SlidingAggregate(1000); for (let t = 0; t < 200; t++) sa.add(t, t * 0.5);
    assert.throws(() => sa.into(swapU8(5)), tagged, 'SA into swapped Uint8Array');
    assert.throws(() => sa.into(swapDV(5)), tagged, 'SA into swapped DataView');

    const scm = new SlidingCountMin(1000); for (let t = 0; t < 200; t++) scm.add(t, t % 17);
    const keys = new Float64Array([1, 2, 3]);
    assert.throws(() => scm.estimateInto(swapU8(3), new Float64Array(3)), tagged, 'SCM estimateInto swapped keys Uint8Array');
    assert.throws(() => scm.estimateInto(swapDV(3), new Float64Array(3)), tagged, 'SCM estimateInto swapped keys DataView');
    assert.throws(() => scm.estimateInto(keys, swapU8(3)), tagged, 'SCM estimateInto swapped out Uint8Array');
    assert.throws(() => scm.estimateInto(keys, swapDV(3)), tagged, 'SCM estimateInto swapped out DataView');

    const sdd = new SlidingDDSketch(1000); for (let t = 0; t < 200; t++) sdd.add(t, t * 0.5 + 1);
    const qs = new Float64Array([0.5]);
    assert.throws(() => sdd.quantileInto(swapU8(1), new Float64Array(1)), tagged, 'SDD quantileInto swapped qs Uint8Array');
    assert.throws(() => sdd.quantileInto(swapDV(1), new Float64Array(1)), tagged, 'SDD quantileInto swapped qs DataView');
    assert.throws(() => sdd.quantileInto(qs, swapU8(1)), tagged, 'SDD quantileInto swapped out Uint8Array');
    assert.throws(() => sdd.quantileInto(qs, swapDV(1)), tagged, 'SDD quantileInto swapped out DataView');

    const hk = new HeavyKeeper(4, 128, 8, { seed: 4 }); for (let k = 0; k < 400; k++) hk.add((k % 40) + 1, 1);
    assert.throws(() => hk.topKInto(swapU8(8)), tagged, 'HK topKInto swapped Uint8Array');
    assert.throws(() => hk.topKInto(swapDV(8)), tagged, 'HK topKInto swapped DataView');

    const dr = new DecayedReservoir(8, 100000, { seed: 7 }); for (let k = 0; k < 400; k++) dr.add(k, k * 1.5);
    assert.throws(() => dr.sampleInto(swapU8(8)), tagged, 'DR sampleInto swapped Uint8Array');
    assert.throws(() => dr.sampleInto(swapDV(8)), tagged, 'DR sampleInto swapped DataView');
});

test('TA_TAG 6: the intrinsic @@toStringTag guard returns undefined (never throws, never runs user code) for a Proxy / DataView / plain object / primitive', () => {
    const TA_TAG = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Float64Array.prototype), Symbol.toStringTag).get;
    let trap = 0;
    const px = new Proxy(new Float64Array(2), { get() { trap++; return undefined; }, has() { trap++; return false; }, getPrototypeOf() { trap++; return Float64Array.prototype; } });
    assert.equal(TA_TAG.call(px), undefined, 'Proxy -> undefined');
    assert.equal(TA_TAG.call(new DataView(new ArrayBuffer(8))), undefined, 'DataView -> undefined');
    assert.equal(TA_TAG.call({}), undefined, 'plain object -> undefined');
    assert.equal(TA_TAG.call(5), undefined, 'primitive number -> undefined');
    assert.equal(TA_TAG.call('x'), undefined, 'primitive string -> undefined');
    assert.equal(TA_TAG.call(null), undefined, 'null -> undefined');
    assert.equal(trap, 0, 'TA_TAG ran user code (trap counter ' + trap + ')');
    assert.equal(TA_TAG.call(new Float64Array(1)), 'Float64Array', 'a real Float64Array -> Float64Array');
});

// ===========================================================================
// 4. Allocation sanity via the shipped AllocProbe lanes (pinned semi-space child)
// ===========================================================================
test('ALLOC 4: count / countInto / into lanes <= 0.5 B/op (mono + poly4, fresh + warmed); controls n1 + DD six-getter >= 12', async (t) => {
    process.env.LITE_MATRIX = '1';   // skip the 8N scavenge sweep (steady B/op only)
    const zero = ['q_shll_count', 'q_shll_countInto', 'q_shll_countInto_poly4', 'q_dd_into', 'q_dd_into_poly4'];
    for (const lane of zero) for (const mode of ['fresh', 'warmed']) {
        await t.test(lane + ' ' + mode, async () => {
            const r = await runLane(lane, mode, 200000);
            assert.ok(r.steady <= 0.5, lane + ' ' + mode + ' steady ' + r.steady + ' B/op > 0.5 (first=' + r.first + ' readings=' + r.readings + ')');
        });
    }
    for (const lane of ['n1', 'q_dd_sixgetter']) {
        await t.test(lane + ' control', async () => {
            const r = await runLane(lane, 'fresh', 200000);
            assert.ok(r.steady >= 12, lane + ' control steady ' + r.steady + ' B/op < 12 -- the probe has no teeth');
        });
    }
});
