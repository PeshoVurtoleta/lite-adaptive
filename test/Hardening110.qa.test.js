// @zakkster/lite-adaptive -- 1.10.0 H2 QA BOUNDARY SUITE (ROADMAP 10.1 "QA pass", read-only probe).
//   run: node --test test/Hardening110.qa.test.js
//
// Independent boundary cases for the H2 hardening. Every oracle here is computed from the TRUE
// definition (the true window (now - W, now], the true domain pw * 2^42 computed in-test, the true
// regime structure of a step signal) or from the committed 1.9.0 source (`git show 602d30b:Adaptive.js`,
// imported as a data: URL -- never a file outside this package). Never from the implementation's own
// output.
//
// Rows that assert a claim the working tree does NOT meet are marked `todo: 'QA110 F<n> ...'`: they
// print `not ok ... # TODO` (a recorded finding) and keep `npm test` green. Remove the todo once fixed.
//
// Sections:
//   D  SCM / SDD numeric domain: +-pw*2^42 exactly and +-1 ulp, every entry point x mode; negative
//      clocks; +-1.7e308 with W = 1e308 (nowMax = Infinity); the count-mode tick bound + clear();
//      the subnormal pane-width door; the section 2 legal table vs a brute-force true-window oracle.
//   C  Containers at all 17 H2-4 sites + SlidingAggregate's three: Proxy / NaN-length / long-length /
//      re-entrant length getter / detached / SharedArrayBuffer / subarray-with-byteOffset / index
//      defineProperty.
//   H  H2-6 hostile arguments: toString / valueOf / Symbol.toPrimitive / Proxy get-has-ownKeys-
//      getPrototypeOf-apply traps that re-enter the instance; null / undefined / symbol / bigint.
//   P  DriftDetector latched PH: reversal after a long drift, one fire per regime, latch:false +
//      CUSUM bit-identical to 1.9.0 over 1e5 random items, and (P2, ex-F4, now LIVE) the documented
//      re-centre property -- identical until the first trip, then fire/mean/count/index/direction still
//      identical, statistic within 4*ulp(acc) where the re-arm agrees, latched differs only at a th/2 tie.
//   T  Throughput sanity vs 1.9.0 (print only, no gate).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog,
    DriftDetector, DRIFT_PH, DRIFT_CUSUM, SlidingDDSketch, SlidingCountMin, DecayedReservoir,
    SlidingAggregate,
} from '../Adaptive.js';

const LA = /\[lite-adaptive\]/;
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_1_9_0 = '602d30b';   // the committed 1.9.0 (package.json "version": "1.9.0")
const SPAN = 2 ** 42;
const MIN_NORMAL = 2 ** -1022;

// ---------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------
const F = new Float64Array(1), U = new BigUint64Array(F.buffer);
function nextUp(x) {
    if (x !== x || x === Infinity) return x;
    if (x === 0) return Number.MIN_VALUE;
    F[0] = x; if (x > 0) U[0] += 1n; else U[0] -= 1n; return F[0];
}
function nextDown(x) { return -nextUp(-x); }

/** Full internal snapshot: every own field; typed arrays as raw bytes; -0 distinct; nested arrays walked. */
function snap(o) {
    const parts = [];
    const enc = (v) => {
        if (typeof v === 'function') return 'fn';
        if (ArrayBuffer.isView(v)) return 'x' + Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex');
        if (Array.isArray(v)) return '[' + v.map(enc).join(',') + ']';
        if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => k + ':' + enc(v[k])).join(',') + '}';
        if (typeof v === 'number' && Object.is(v, -0)) return '-0';
        return typeof v + ':' + String(v);
    };
    for (const n of Object.getOwnPropertyNames(o).sort()) parts.push(n + '=' + enc(o[n]));
    return parts.join('|');
}

/** Assert `fn` throws [lite-adaptive] and that every instance in `insts` is byte-identical after. */
function rejectNoOp(fn, insts, msg) {
    const before = insts.map(snap);
    let err = null;
    try { fn(); } catch (e) { err = e; }
    assert.ok(err, msg + ': must throw');
    assert.match(String(err && err.message), LA, msg + ': must be a tagged [lite-adaptive] error, got ' + (err && err.message));
    insts.forEach((o, k) => assert.ok(snap(o) === before[k], msg + ': instance ' + k + ' must be a byte-identical no-op'));
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

let HEAD_MOD;
async function head() {
    if (HEAD_MOD !== undefined) return HEAD_MOD;
    try {
        const src = execFileSync('git', ['show', BASE_1_9_0 + ':Adaptive.js'], { cwd: PKG, encoding: 'utf8', maxBuffer: 64 << 20 });
        HEAD_MOD = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
    } catch (e) {
        HEAD_MOD = null;
    }
    return HEAD_MOD;
}

// The true window (now - W, now], evaluated overflow-free (halving is exact for these normals).
function inWin(t, now, W) { return t <= now && (t / 2 - now / 2) > -W / 2; }

// ---------------------------------------------------------------------------------------------------
// D. SCM / SDD numeric domain
// ---------------------------------------------------------------------------------------------------
// Per-class drivers so every entry point is exercised through the same table.
const TIME = {
    SCM: {
        make: (W, panes) => new SlidingCountMin(W, { panes, w: 64, d: 4, seed: 7 }),
        add: (o, t) => o.add(t, 7, 1),
        addFrom: (o, t) => o.addFrom(Float64Array.of(t, 7, 1), 0),
        advance: (o, t) => o.advance(t),
        advanceFrom: (o, t) => o.advanceFrom(Float64Array.of(t), 0),
        countAdd: (o) => o.add(undefined, 7, 1),
        read: (o, w) => o.total(w),
    },
    SDD: {
        make: (W, panes) => new SlidingDDSketch(W, { alpha: 0.01, panes }),
        add: (o, t) => o.add(t, 5),
        addFrom: (o, t) => o.addFrom(Float64Array.of(t, 5), 0),
        advance: (o, t) => o.advance(t),
        advanceFrom: (o, t) => o.advanceFrom(Float64Array.of(t), 0),
        countAdd: (o) => o.add(undefined, 5),
        read: (o, w) => o.count(w),
    },
};
const ENTRIES = ['add', 'addFrom', 'advance', 'advanceFrom'];
const EDGE_CFGS = [[1000, 32], [1000, 30], [1e4 / 3, 7], [16, 32], [1e6, 1024]];

for (const cls of ['SCM', 'SDD']) {
    const D = TIME[cls];
    test('D1 ' + cls + ': +-pw*2^42 exactly is accepted and +-1 ulp beyond rejects as a byte-identical no-op (unset mode, 4 entries x 5 configs)', () => {
        for (const [W, panes] of EDGE_CFGS) {
            const nm = (W / panes) * SPAN;   // the true bound, computed in-test (scaling by 2^42 is exact)
            for (const e of ENTRIES) {
                for (const edge of [nm, -nm]) {
                    const o = D.make(W, panes);
                    D[e](o, edge);
                    assert.equal(o.mode, 'explicit', cls + ' ' + e + '(' + edge + ') must lock explicit');
                    if (e === 'add' || e === 'addFrom') assert.equal(D.read(o), 1, cls + ' ' + e + ' at the bound reads 1');
                }
                const o1 = D.make(W, panes);
                rejectNoOp(() => D[e](o1, nextUp(nm)), [o1], cls + ' W=' + W + ' ' + e + '(nextUp(+nm))');
                const o2 = D.make(W, panes);
                rejectNoOp(() => D[e](o2, nextDown(-nm)), [o2], cls + ' W=' + W + ' ' + e + '(nextDown(-nm))');
                assert.equal(o1.mode, 'unset', 'a rejected first call must leave the mode unset');
            }
        }
    });

    test('D2 ' + cls + ': explicit mode -- the bound is inclusive, +1 ulp rejects, the negative side is closed; a legal follow-up still works', () => {
        for (const [W, panes] of EDGE_CFGS) {
            const nm = (W / panes) * SPAN;
            for (const e of ENTRIES) {
                const o = D.make(W, panes);
                D.add(o, -nm);                       // lock explicit at the negative bound (legal)
                rejectNoOp(() => D[e](o, nextDown(-nm)), [o], cls + ' ' + e + ' below -nm (locked)');
                rejectNoOp(() => D[e](o, nextUp(nm)), [o], cls + ' ' + e + ' above +nm (locked)');
                rejectNoOp(() => D[e](o, Infinity), [o], cls + ' ' + e + ' +Infinity (locked)');
                D[e](o, nm);                         // exactly the bound: accepted
                if (e === 'add' || e === 'addFrom') assert.equal(D.read(o), 1, cls + ' ' + e + ': only the add at +nm is in the window');
                else assert.equal(D.read(o), 0, cls + ' ' + e + ': the add at -nm expired');
            }
        }
    });

    test('D3 ' + cls + ': count mode rejects every explicit entry; addFrom / advance / advanceFrom stay no-ops', () => {
        const o = D.make(1000, 32);
        D.countAdd(o); D.countAdd(o);
        for (const e of ['addFrom', 'advance', 'advanceFrom']) rejectNoOp(() => D[e](o, 5), [o], cls + ' count-locked ' + e);
        assert.equal(D.read(o), 2);
    });

    test('D4 ' + cls + ': the count-mode tick bound -- tick nm accepted, tick nm+1 rejects (no-op), clear() reopens', () => {
        // nm = 5 ticks: pw = 5 * 2^-42, W = 32 pw (all exact dyadics).
        const W = 32 * 5 * 2 ** -42;
        assert.equal((W / 32) * SPAN, 5, 'precondition: nm is exactly 5');
        const o = D.make(W, 32);
        for (let k = 0; k < 5; k++) D.countAdd(o);
        assert.equal(o._tick, 5, 'tick reached the bound');
        rejectNoOp(() => D.countAdd(o), [o], cls + ' count tick 6 > nm 5');
        rejectNoOp(() => D.countAdd(o), [o], cls + ' count tick 6 again (stays closed)');
        o.clear();
        D.countAdd(o);
        assert.equal(o.mode, 'count');
        assert.equal(D.read(o), 1, 'clear() reopens the tick range');
        // nm < 1: the FIRST count add (unset branch) already rejects and leaves the instance unset.
        const W2 = 32 * 0.5 * 2 ** -42;
        const o2 = D.make(W2, 32);
        rejectNoOp(() => D.countAdd(o2), [o2], cls + ' first count add with nm 0.5');
        assert.equal(o2.mode, 'unset');
    });

    test('D5 ' + cls + ': negative clocks + a zero crossing + -0 match a brute-force true-window oracle', () => {
        for (const [W, panes] of [[1000, 32], [1000, 30], [1e4 / 3, 7]]) {
            const pw = W / panes;
            const rnd = mulberry32(11);
            const o = D.make(W, panes);
            const ts = [];
            let t = -W * 40;
            for (let j = 0; j < 4000; j++) {
                t += rnd() * pw * 0.9;
                if (j === 2000) t = Math.max(t, -0);   // cross zero through -0
                if (j === 2001) t = Math.max(t, 0);
                D.add(o, t); ts.push(t);
                if ((j % 7) === 0) {
                    let lo = 0, hi = 0;
                    for (const s of ts) { if (inWin(s, t, W)) lo++; if (inWin(s, t, W + pw)) hi++; }
                    const got = D.read(o);
                    assert.ok(got >= lo && got <= hi, cls + ' W=' + W + ' now=' + t + ': ' + got + ' not in [' + lo + ', ' + hi + ']');
                }
            }
            assert.ok(t > 0, 'precondition: the stream crossed zero');
        }
    });

    test('D6 ' + cls + ': W = 1e308 (nowMax = Infinity) over +-1.7e308 and up to Number.MAX_VALUE matches the true-window oracle', () => {
        const W = 1e308, panes = 32;
        assert.equal((W / panes) * SPAN, Infinity, 'precondition: nowMax overflows to Infinity');
        const clocks = [-1.7e308, -1.5e308, -1.0e308, -3e307, 0, 3e307, 1.0e308, 1.5e308, 1.7e308, 1.75e308, 1.79e308, Number.MAX_VALUE];
        for (const e of ['add', 'addFrom']) {
            const o = D.make(W, panes);
            const ts = [];
            for (const t of clocks) {
                D[e](o, t); ts.push(t);
                let n = 0; for (const s of ts) if (inWin(s, t, W)) n++;
                let hi = 0; for (const s of ts) if (inWin(s, t, W + W / panes)) hi++;
                const got = D.read(o);
                assert.ok(got >= n && got <= hi, cls + ' ' + e + ' now=' + t + ': read ' + got + ' vs true [' + n + ', ' + hi + ']');
            }
            rejectNoOp(() => D[e](o, Infinity), [o], cls + ' ' + e + ' Infinity at nowMax = Infinity');
        }
        // advance to the top of the double range empties an early window
        const o = D.make(W, panes);
        D.add(o, -1.7e308); D.advance(o, Number.MAX_VALUE);
        assert.equal(D.read(o), 0, cls + ' advance(MAX) expires an add at -1.7e308');
    });

    test('D7 ' + cls + ': the subnormal pane-width door -- W/panes == 2^-1022 builds, one ulp below throws /subnormal/', () => {
        for (const panes of [2, 7, 30, 32, 1024]) {
            const Wok = panes * MIN_NORMAL;               // exact (a normal double times a small integer)
            assert.equal(Wok / panes, MIN_NORMAL, 'precondition');
            const o = D.make(Wok, panes);
            D.add(o, 0); D.add(o, 0);
            assert.equal(D.read(o), 2, cls + ' panes=' + panes + ' at the min-normal pane width');
            const Wbad = panes * nextDown(MIN_NORMAL);    // W/panes lands exactly one ulp below 2^-1022
            assert.ok(Wbad / panes < MIN_NORMAL, 'precondition');
            assert.throws(() => D.make(Wbad, panes), /subnormal/, cls + ' panes=' + panes + ' one ulp below');
            // the door is on the COMPUTED fl(W / panes): any W whose quotient rounds up to 2^-1022 builds.
            const Wtie = nextDown(Wok);
            const q = Wtie / panes;
            if (q >= MIN_NORMAL) D.make(Wtie, panes);
            else assert.throws(() => D.make(Wtie, panes), /subnormal/);
        }
    });

    test('D8 ' + cls + ': the section 2 legal table builds and reads exactly; the listed rejections reject', () => {
        // [clock, W, panes, legal]; the clock is the configuration's documented magnitude.
        const rows = [
            [1.75e12, 1000, 32, true], [1.75e12, 60000, 32, true], [1.75e12, 100, 32, true],
            [1.75e12, 1000, 1024, true], [1.75e12, 16, 32, true], [1.75e12, 12, 32, false],
            [1.75e12, 12.7, 32, false], [1.75e12, 12.8, 32, true],
            [1.75e15, 1e6, 32, true], [1.75e15, 1e5, 32, true], [1.75e15, 1e4, 32, false],
            [1.75e15, 12733, 32, true], [1.75e15, 12732, 32, false],
            [2.2e12 * 0.999, 16, 32, true], [1.374e11 * 0.999, 1, 32, true],
            [4.295e12 * 0.999, 1000, 1024, true],
        ];
        for (const [C, W, panes, legal] of rows) {
            const trueLegal = C <= (W / panes) * SPAN;
            assert.equal(trueLegal, legal, 'table row C=' + C + ' W=' + W + ' @' + panes + ' is ' + (legal ? 'legal' : 'illegal') + ' by the true bound');
            const o = D.make(W, panes);
            const pw = W / panes;
            if (!legal) { rejectNoOp(() => D.add(o, C), [o], cls + ' C=' + C + ' W=' + W); continue; }
            D.add(o, C); D.add(o, C + pw / 3); D.add(o, C + pw / 2);
            assert.equal(D.read(o), 3, cls + ' C=' + C + ' W=' + W + ' @' + panes + ': 3 adds read exactly 3');
            // a brute-force stream at that magnitude: sandwich between the true (now-W, now] and (now-W-pw, now]
            const rnd = mulberry32(C % 1000 | 0);
            const ts = [C, C + pw / 3, C + pw / 2];
            let t = C + pw / 2;
            for (let j = 0; j < 600; j++) {
                t += rnd() * W / 7;
                if (!(t <= (W / panes) * SPAN)) break;
                D.add(o, t); ts.push(t);
                let lo = 0, hi = 0;
                for (const s of ts) { if (inWin(s, t, W)) lo++; if (inWin(s, t, W + pw)) hi++; }
                const got = D.read(o);
                assert.ok(got >= lo && got <= hi, cls + ' C=' + C + ' W=' + W + ': ' + got + ' not in [' + lo + ', ' + hi + ']');
            }
        }
        for (const W of [1000, 32]) {          // count-mode rows: W=1000 and W=32 ticks
            const o = D.make(W, 32);
            for (let k = 0; k < 3; k++) D.countAdd(o);
            assert.equal(D.read(o), 3, cls + ' count W=' + W);
        }
    });

    // D9 is a SANITY row, not a revert gate: inside the legal domain ulp(now) <= pw * 2^-10, so even
    // 1.9.0's accumulated `E += pw` keeps every pane width within an ulp of pw and also passes. The rows
    // with teeth against 1.9.0 are D1 / D2 / D4 / D7 and D8's rejections (1.9.0 accepts every one).
    test('D9 ' + cls + ': near the edge (now in [0.99, 1] * nm) total/count never under-covers the true window (dyadic + non-dyadic pw)', () => {
        for (const [W, panes] of [[736, 32], [1000, 30], [1e4 / 3, 7], [1000, 32]]) {
            const pw = W / panes, nm = pw * SPAN;
            const o = D.make(W, panes);
            const rnd = mulberry32(5);
            const ts = [];
            let t = nm - 30000 * pw, under = 0, over = 0, q = 0;
            assert.ok(t >= nm * 0.99, 'precondition: inside [0.99, 1] * nm');
            while (t <= nm && q < 20000) {
                D.add(o, t); ts.push(t);
                let lo = 0, hi = 0;
                for (let k = ts.length - 1; k >= 0 && inWin(ts[k], t, W + pw); k--) { hi++; if (inWin(ts[k], t, W)) lo++; }
                const got = D.read(o);
                if (got < lo) under++;
                if (got > hi) over++;
                q++;
                t += (0.5 + rnd()) * pw;               // ~1 pane per add: a rotation on most adds, ulp(t) <= pw * 2^-10
            }
            assert.ok(q > 15000, 'precondition: enough queries (' + q + ')');
            assert.equal(under, 0, cls + ' W=' + W + ' @' + panes + ': under-cover count over ' + q + ' queries');
            assert.equal(over, 0, cls + ' W=' + W + ' @' + panes + ': over-cover (beyond W + pw) count over ' + q + ' queries');
        }
    });
}

// ---------------------------------------------------------------------------------------------------
// C. Containers: the 17 H2-4 sites + SlidingAggregate's addFrom / advanceFrom / into.
// ---------------------------------------------------------------------------------------------------
const NOW = 1000;
// kind 'in'  = an (buf, i) input site; data = the valid packed record at i = 0.
// kind 'out' = an out-buffer / array-argument site; call(o, buf) passes buf in the checked slot.
const SITES = [
    { n: 'EH.addFrom', mk: () => new ExponentialHistogram(1000, 0.01), prep: (o) => o.add(NOW, 1), call: (o, b, i) => o.addFrom(b, i), data: [NOW + 5, 1], mut: (o) => o.add(NOW + 1, 1), kind: 'in' },
    { n: 'EH.advanceFrom', mk: () => new ExponentialHistogram(1000, 0.01), prep: (o) => o.add(NOW, 1), call: (o, b, i) => o.advanceFrom(b, i), data: [NOW + 5], mut: (o) => o.add(NOW + 1, 1), kind: 'in' },
    { n: 'ADWIN.addFrom', mk: () => new ADWIN(0.1), prep: (o) => o.add(1), call: (o, b, i) => o.addFrom(b, i), data: [2], mut: (o) => o.add(1), kind: 'in' },
    { n: 'FD.addFrom', mk: () => new ForwardDecay(1e9), prep: (o) => o.add(NOW, 1), call: (o, b, i) => o.addFrom(b, i), data: [NOW + 5, 1], mut: (o) => o.add(NOW + 1, 1), kind: 'in' },
    { n: 'HK.addFrom', mk: () => new HeavyKeeper(4, 512, 16, { seed: 4 }), prep: (o) => o.add(1, 1), call: (o, b, i) => o.addFrom(b, i), data: [7, 1], mut: (o) => o.add(1, 1), kind: 'in' },
    { n: 'HK.topKInto', mk: () => new HeavyKeeper(4, 512, 16, { seed: 4 }), prep: (o) => { for (let k = 1; k <= 20; k++) o.add(k, k); }, call: (o, b) => o.topKInto(b), len: 32, mut: (o) => o.add(1, 1), kind: 'out' },
    { n: 'SHLL.addFrom', mk: () => new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 3 }), prep: (o) => o.add(NOW, 1), call: (o, b, i) => o.addFrom(b, i), data: [NOW + 5, 9], mut: (o) => o.add(NOW + 1, 2), kind: 'in' },
    { n: 'SHLL.advanceFrom', mk: () => new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 3 }), prep: (o) => o.add(NOW, 1), call: (o, b, i) => o.advanceFrom(b, i), data: [NOW + 5], mut: (o) => o.add(NOW + 1, 2), kind: 'in' },
    { n: 'DD.addFrom', mk: () => new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 }), prep: (o) => o.add(1), call: (o, b, i) => o.addFrom(b, i), data: [2], mut: (o) => o.add(1), kind: 'in' },
    { n: 'SDD.addFrom', mk: () => new SlidingDDSketch(1000), prep: (o) => o.add(NOW, 1), call: (o, b, i) => o.addFrom(b, i), data: [NOW + 5, 3], mut: (o) => o.add(NOW + 1, 2), kind: 'in' },
    { n: 'SDD.quantileInto(qs)', mk: () => new SlidingDDSketch(1000), prep: (o) => { o.add(NOW, 1); o.add(NOW, 9); }, call: (o, b) => o.quantileInto(b, new Float64Array(8)), data: [0.5, 0.9], mut: (o) => o.add(NOW + 1, 2), kind: 'arg' },
    { n: 'SDD.quantileInto(out)', mk: () => new SlidingDDSketch(1000), prep: (o) => { o.add(NOW, 1); o.add(NOW, 9); }, call: (o, b) => o.quantileInto(Float64Array.of(0.5, 0.9, 0.1), b), len: 3, mut: (o) => o.add(NOW + 1, 2), kind: 'out' },
    { n: 'SDD.advanceFrom', mk: () => new SlidingDDSketch(1000), prep: (o) => o.add(NOW, 1), call: (o, b, i) => o.advanceFrom(b, i), data: [NOW + 5], mut: (o) => o.add(NOW + 1, 2), kind: 'in' },
    { n: 'SCM.addFrom', mk: () => new SlidingCountMin(1000, { w: 64, d: 4, seed: 7 }), prep: (o) => o.add(NOW, 1), call: (o, b, i) => o.addFrom(b, i), data: [NOW + 5, 7, 1], mut: (o) => o.add(NOW + 1, 2), kind: 'in' },
    { n: 'SCM.estimateInto(keys)', mk: () => new SlidingCountMin(1000, { w: 64, d: 4, seed: 7 }), prep: (o) => { o.add(NOW, 7); o.add(NOW, 7); }, call: (o, b) => o.estimateInto(b, new Float64Array(8)), data: [7, 1], mut: (o) => o.add(NOW + 1, 2), kind: 'arg' },
    { n: 'SCM.estimateInto(out)', mk: () => new SlidingCountMin(1000, { w: 64, d: 4, seed: 7 }), prep: (o) => { o.add(NOW, 7); o.add(NOW, 7); }, call: (o, b) => o.estimateInto(Float64Array.of(7, 1, 7), b), len: 3, mut: (o) => o.add(NOW + 1, 2), kind: 'out' },
    { n: 'SCM.advanceFrom', mk: () => new SlidingCountMin(1000, { w: 64, d: 4, seed: 7 }), prep: (o) => o.add(NOW, 1), call: (o, b, i) => o.advanceFrom(b, i), data: [NOW + 5], mut: (o) => o.add(NOW + 1, 2), kind: 'in' },
    { n: 'DR.addFrom', mk: () => new DecayedReservoir(32, 1e5, { seed: 7 }), prep: (o) => o.add(NOW, 1), call: (o, b, i) => o.addFrom(b, i), data: [NOW + 5, 3], mut: (o) => o.add(NOW + 1, 2), kind: 'in' },
    { n: 'DR.sampleInto', mk: () => new DecayedReservoir(32, 1e5, { seed: 7 }), prep: (o) => { for (let k = 1; k <= 40; k++) o.add(NOW + k, k); }, call: (o, b) => o.sampleInto(b), len: 32, mut: (o) => o.add(NOW + 99, 2), kind: 'out' },
    { n: 'SA.addFrom', mk: () => new SlidingAggregate(1000), prep: (o) => o.add(NOW, 1), call: (o, b, i) => o.addFrom(b, i), data: [NOW + 5, 3], mut: (o) => o.add(NOW + 1, 2), kind: 'in' },
    { n: 'SA.advanceFrom', mk: () => new SlidingAggregate(1000), prep: (o) => o.add(NOW, 1), call: (o, b, i) => o.advanceFrom(b, i), data: [NOW + 5], mut: (o) => o.add(NOW + 1, 2), kind: 'in' },
    { n: 'SA.into', mk: () => new SlidingAggregate(1000), prep: (o) => { o.add(NOW, 1); o.add(NOW, 5); }, call: (o, b) => o.into(b), len: 5, mut: (o) => o.add(NOW + 1, 2), kind: 'out' },
];
function build(s) { const o = s.mk(); s.prep(o); return o; }
function sizeOf(s) { return s.data ? s.data.length : s.len; }
function fillFrom(buf, s) { if (s.data) buf.set(s.data); return buf; }
/** Run the site on a plain Float64Array; returns { ret, out bytes, instance snapshot }. */
function reference(s) {
    const o = build(s);
    const b = fillFrom(new Float64Array(sizeOf(s)), s);
    const ret = s.call(o, b, 0);
    return { ret: ret === o ? 'this' : ret, out: Array.from(b), state: snap(o) };
}

// -------------------------------------------------------------------------------------------------
// H34 -- container-length threat model, SETTLED 2026-09-28. Two regimes:
//   COLD render readers (kind 'out' | 'arg': topKInto / quantileInto / estimateInto / sampleInto /
//     into) verify the type with `ArrayBuffer.isView(x) && x instanceof Float64Array` (a benign subclass
//     is ACCEPTED) and read the length through the INTRINSIC %TypedArray%.length getter (TA_LEN, captured
//     once at module init). A length-tampered SUBCLASS or an own-property `length` accessor is read via
//     the true [[ArrayLength]] slot, so its getter is NEVER invoked (0 caller code) and the reader behaves
//     EXACTLY like a plain Float64Array of the same real backing. The pre-H34 code (`x.length`) ran it.
//   HOT entry points (kind 'in': addFrom / advanceFrom) verify the same type but read `x.length` ONCE
//     into the index bound. A caller-defined length getter is the caller's OWN code and may run AT MOST
//     ONCE per call; the call then behaves per the ONE value it returned (a NaN / short lie rejects via
//     the NaN-safe bound !(i+k < n)). The zero-GC hot path is the product; see ROADMAP 10.1.
// -------------------------------------------------------------------------------------------------
// COLD helper: the site behaves like a plain buffer of the same real backing, 0 caller code. `tamper`
// is 'subclass' (a Float64Array subclass with a lying length getter) or 'own' (an own-property length
// accessor on a plain instance). The getter is counted so a pre-H34 read (`x.length`) shows up.
function coldLikePlain(s, size, lieLen, tamper, tag) {
    const oC = build(s), plain = new Float64Array(size);
    if (s.data && size >= s.data.length) plain.set(s.data);
    let cThrew = false, cRet;
    try { cRet = s.call(oC, plain, 0); } catch (e) { cThrew = LA.test(e.message); }
    const cState = snap(oC);
    const o = build(s);
    let calls = 0;
    const g = () => { calls++; try { s.mut(o); } catch { /* keep going */ } return lieLen; };
    let buf;
    if (tamper === 'subclass') { class Evil extends Float64Array { get length() { return g(); } } buf = new Evil(size); }
    else { buf = new Float64Array(size); Object.defineProperty(buf, 'length', { get: g, configurable: true }); }
    if (s.data && size >= s.data.length) buf.set(s.data);
    let hThrew = false, hRet;
    try { hRet = s.call(o, buf, 0); } catch (e) { hThrew = LA.test(e.message); }
    if (calls === 0 && hThrew === cThrew && String(hRet) === String(cRet) && snap(o) === cState) return null;
    return s.n + ' ' + tag + ' calls=' + calls + ' threw=' + hThrew + '/' + cThrew + ' ret=' + String(hRet) + '/' + String(cRet) + ' state=' + (snap(o) === cState);
}
// HOT helper (documented caveat): the caller length getter runs AT MOST ONCE and the call behaves per
// the ONE value it returned (`expectReject` is the outcome for `lieLen`). State is not asserted -- a
// re-entrant getter is caller-owned code the caller chose to run.
function hotCaveat(s, size, lieLen, tamper, expectReject, tag) {
    const o = build(s);
    let calls = 0;
    const g = () => { calls++; try { s.mut(o); } catch { /* keep going */ } return lieLen; };
    let buf;
    if (tamper === 'subclass') { class Evil extends Float64Array { get length() { return g(); } } buf = new Evil(size); }
    else { buf = new Float64Array(size); Object.defineProperty(buf, 'length', { get: g, configurable: true }); }
    if (s.data && size >= s.data.length) buf.set(s.data);
    let threw = false;
    try { s.call(o, buf, 0); } catch (e) { threw = LA.test(e.message); }
    if (calls <= 1 && threw === expectReject) return null;
    return s.n + ' ' + tag + ' calls=' + calls + ' threw=' + threw + ' expectReject=' + expectReject;
}

test('C1 all 20 sites: a Proxy over a Float64Array is a tagged no-op and fires ZERO traps', () => {
    for (const s of SITES) {
        const o = build(s);
        let traps = 0;
        const f = fillFrom(new Float64Array(sizeOf(s)), s);
        const h = {};
        for (const k of ['get', 'has', 'ownKeys', 'getPrototypeOf', 'getOwnPropertyDescriptor', 'set', 'defineProperty']) {
            h[k] = (...a) => { traps++; try { s.mut(o); } catch { /* keep going */ } return Reflect[k](...a); };
        }
        const p = new Proxy(f, h);
        rejectNoOp(() => s.call(o, p, 0), [o], s.n + ' proxy');
        assert.equal(traps, 0, s.n + ': the proxy gate must fire 0 traps');
    }
});

test('C2 all 20 sites: a NaN-length container -- cold readers ignore it (0 caller code, like plain); hot entries reject via the NaN-safe bound', () => {
    // COLD: a NaN-length subclass / own-accessor is read via the intrinsic slot (its real backing), so it
    // behaves like a plain Float64Array of the same size and runs 0 caller code. HOT: the NaN-safe bound
    // !(i+k < NaN) rejects (H2-4 kept); the caller getter runs at most once (documented caveat).
    const bad = [];
    for (const s of SITES) {
        const size = Math.max(sizeOf(s), 1);
        if (s.kind === 'in') {
            const a = hotCaveat(s, size, NaN, 'subclass', true, 'hot subclass NaN-length'); if (a) bad.push(a);
            const b = hotCaveat(s, size, NaN, 'own', true, 'hot own NaN-length'); if (b) bad.push(b);
        } else {
            const a = coldLikePlain(s, size, NaN, 'subclass', 'cold subclass NaN-length'); if (a) bad.push(a);
            const b = coldLikePlain(s, size, NaN, 'own', 'cold own NaN-length'); if (b) bad.push(b);
        }
    }
    assert.deepEqual(bad, [], 'NaN-length container ran caller code / diverged:\n  ' + bad.join('\n  '));
});

test('C3 input sites: a long-length subclass read beyond its backing (undefined) is a tagged no-op', () => {
    class LongLen extends Float64Array { get length() { return 1e9; } }
    for (const s of SITES.filter((x) => x.kind === 'in')) {
        const o = build(s);
        const b = fillFrom(new LongLen(8), s);
        rejectNoOp(() => s.call(o, b, 100), [o], s.n + ' long-length i=100');
    }
});

// QA110 F1 (fixed by H34): before the intrinsic-length guard an OUT / ARRAY-ARGUMENT site read the
// caller's `length` getter -- a subclass that lied a LONG length (1e6) over a SHORT (1-slot) backing
// made the site accept, write into the short backing, and over-report the count. H34 reads the true
// [[ArrayLength]] slot: the tampered buffer behaves EXACTLY like a plain 1-slot Float64Array (out sites
// reject the too-small backing; arg sites use n = 1 and never over-report), with 0 caller code.
test('C4 out/arg sites: a long-length subclass over a short backing behaves like the short plain backing (no over-report)', () => {
    const bad = [];
    for (const s of SITES.filter((x) => x.kind === 'out' || x.kind === 'arg')) {
        const a = coldLikePlain(s, 1, 1e6, 'subclass', 'subclass long-length(1e6)/1-slot'); if (a) bad.push(a);
        const b = coldLikePlain(s, 1, 1e6, 'own', 'own long-length(1e6)/1-slot'); if (b) bad.push(b);
    }
    assert.deepEqual(bad, [], 'long-length over short backing diverged / over-reported:\n  ' + bad.join('\n  '));
});

// QA110 F2 (H34, SETTLED 2026-09-28): COLD render readers read the length through the intrinsic slot, so
// a subclass / own-property `length` getter is NEVER invoked (calls=0) and the operation is byte-identical
// to a plain Float64Array of the same real backing. HOT entries read `x.length` once into the bound -- a
// caller getter is caller-owned code that runs at most once, and a NaN lie rejects via the NaN-safe bound.
test('C5 all 20 sites: a re-entrant length getter -- cold readers run 0 caller code; hot entries run it at most once (documented)', () => {
    const bad = [];
    for (const s of SITES) {
        const size = Math.max(sizeOf(s), 1);
        if (s.kind === 'in') {
            // HOT: the caller getter runs at most once; a NaN lie rejects via the NaN-safe bound.
            const a = hotCaveat(s, size, NaN, 'subclass', true, 'hot re-entrant subclass'); if (a) bad.push(a);
            const b = hotCaveat(s, size, NaN, 'own', true, 'hot re-entrant own'); if (b) bad.push(b);
        } else {
            // COLD: read via the intrinsic slot, behaves like plain, 0 caller code (both backings + shapes).
            const a1 = coldLikePlain(s, size, NaN, 'subclass', 'cold re-entrant subclass (valid backing)'); if (a1) bad.push(a1);
            const a2 = coldLikePlain(s, 1, 1e6, 'subclass', 'cold re-entrant subclass (1-slot backing)'); if (a2) bad.push(a2);
            const b1 = coldLikePlain(s, size, NaN, 'own', 'cold re-entrant own (valid backing)'); if (b1) bad.push(b1);
            const b2 = coldLikePlain(s, 1, 1e6, 'own', 'cold re-entrant own (1-slot backing)'); if (b2) bad.push(b2);
        }
    }
    assert.deepEqual(bad, [], 're-entrant length getter ran caller code / diverged:\n  ' + bad.join('\n  '));
});

// QA110 F3 (fixed by H34): SCM.estimateInto and SA.into built their RangeError text with a SECOND
// `out.length` read -- message building ran caller code AFTER the guard decided to reject. H34 reads
// the intrinsic length ONCE into a local and the message uses only that local, so a re-entrant getter
// on a too-small `out` is never invoked (calls=0), the reject is tagged, and it is a byte-identical no-op.
test('C6 SCM.estimateInto / SA.into: the out.length reject message reads no caller getter', () => {
    for (const s of SITES.filter((x) => x.n === 'SCM.estimateInto(out)' || x.n === 'SA.into')) {
        let calls = 0;
        const o = build(s);
        const before = snap(o);
        // a genuinely too-small (1-slot) `out` whose re-entrant getter would fire twice pre-H34
        // (guard + message re-read) and mutate the instance; H34 must invoke it 0 times.
        class Short extends Float64Array { get length() { calls++; try { s.mut(o); } catch { /* keep going */ } return 1; } }
        assert.throws(() => s.call(o, new Short(1), 0), LA, s.n + ' must reject a 1-slot out');
        assert.equal(calls, 0, s.n + ': neither the guard nor the message may read a caller length getter (calls=' + calls + ')');
        assert.equal(snap(o), before, s.n + ': the reject must be a byte-identical no-op');
    }
});

test('C7 all 20 sites: a DETACHED view (structuredClone transfer) is rejected as a tagged no-op, or is an empty accepted no-op', () => {
    for (const s of SITES) {
        const o = build(s);
        const b = fillFrom(new Float64Array(sizeOf(s)), s);
        structuredClone(b.buffer, { transfer: [b.buffer] });
        assert.equal(b.length, 0, 'precondition: detached');
        if (s.kind === 'arg') {
            // an empty keys / qs array: n = 0 -> writes nothing, returns 0 (a correct empty answer)
            // (a reader may refresh its private merge scratch; the public answer is what must hold)
            assert.equal(s.call(o, b, 0), 0, s.n + ' detached (empty) arg returns 0');
            const ref = reference(s);
            const good = fillFrom(new Float64Array(sizeOf(s)), s);
            assert.deepEqual(s.call(o, good, 0), ref.ret, s.n + ': the instance still answers normally after the detached call');
        } else {
            rejectNoOp(() => s.call(o, b, 0), [o], s.n + ' detached');
        }
    }
});

test('C8 all 20 sites: a SharedArrayBuffer view and a subarray with a byteOffset are accepted and byte-identical to a plain Float64Array', () => {
    for (const s of SITES) {
        const ref = reference(s);
        const n = sizeOf(s);
        // SharedArrayBuffer
        {
            const o = build(s);
            const b = fillFrom(new Float64Array(new SharedArrayBuffer(8 * n)), s);
            const ret = s.call(o, b, 0);
            assert.deepEqual({ ret: ret === o ? 'this' : ret, out: Array.from(b), state: snap(o) }, ref, s.n + ' SAB');
        }
        // subarray at byteOffset 24 inside a larger poisoned buffer (NaN around it)
        {
            const o = build(s);
            const big = new Float64Array(n + 6).fill(NaN);
            const b = big.subarray(3, 3 + n);
            assert.equal(b.byteOffset, 24);
            fillFrom(b, s);
            const ret = s.call(o, b, 0);
            assert.deepEqual({ ret: ret === o ? 'this' : ret, out: Array.from(b), state: snap(o) }, ref, s.n + ' subarray');
            for (const k of [0, 1, 2, n + 3, n + 4, n + 5]) assert.ok(Number.isNaN(big[k]), s.n + ': no write outside the subarray');
        }
    }
});

test('C9 an index getter cannot be installed on a Float64Array (subclass or plain) -- the element read cannot re-enter', () => {
    class Sub extends Float64Array {}
    for (const b of [new Float64Array(4), new Sub(4)]) {
        assert.throws(() => Object.defineProperty(b, '0', { get() { return 1; } }), TypeError);
        assert.throws(() => Object.defineProperty(b, 0, { get() { return 1; } }), TypeError);
    }
    // an out-of-range numeric key is not installable either (integer-indexed exotic object)
    assert.equal(Reflect.defineProperty(new Sub(4), '100', { get() { return 1; }, configurable: true }), false);
    // H34 (SETTLED 2026-09-28): a BENIGN Float64Array subclass (no own length getter) is ACCEPTED at every
    // hot input site -- the guard is `ArrayBuffer.isView(x) && x instanceof Float64Array`, which walks the
    // chain, and the intrinsic default length reports the true backing. The result is byte-identical to a
    // plain Float64Array of the same data. (MUTANT: restoring the proto-identity check rejects it -> RED.)
    for (const s of SITES.filter((x) => x.kind === 'in')) {
        const ref = reference(s);
        const o = build(s);
        const b = fillFrom(new Sub(sizeOf(s)), s);
        const ret = s.call(o, b, 0);
        assert.deepEqual({ ret: ret === o ? 'this' : ret, state: snap(o) }, { ret: ref.ret, state: ref.state },
            s.n + ': a benign subclass must be accepted, byte-identical to a plain Float64Array');
    }
});

// ---------------------------------------------------------------------------------------------------
// H. H2-6 hostile arguments
// ---------------------------------------------------------------------------------------------------
function hostiles(state) {
    const hit = () => { state.calls++; try { state.mut(); } catch { /* keep going */ } };
    const prim = () => { hit(); return 1; };
    const traps = {
        get(t, k, r) { hit(); if (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf') return prim; return Reflect.get(t, k, r); },
        has(t, k) { hit(); return Reflect.has(t, k); },
        ownKeys(t) { hit(); return Reflect.ownKeys(t); },
        getPrototypeOf(t) { hit(); return Reflect.getPrototypeOf(t); },
        getOwnPropertyDescriptor(t, k) { hit(); return Reflect.getOwnPropertyDescriptor(t, k); },
        apply(t, th, a) { hit(); return 1; },
        construct() { hit(); return {}; },
    };
    const numObj = new Number(5); numObj.valueOf = prim; numObj.toString = prim;
    return {
        toString: { toString: prim },
        valueOf: { valueOf: prim },
        toPrimitive: { [Symbol.toPrimitive]: prim },
        numberObject: numObj,
        proxyObj: new Proxy({}, traps),
        proxyFn: new Proxy(function () { return 1; }, traps),
        proxyArr: new Proxy([1, 2], traps),
    };
}
// [label, make(), prep(o), call(o, argArray), argTemplate, slot indices, mut(o)]
const EH_ = () => new ExponentialHistogram(1000, 0.01);
const SCM_ = () => new SlidingCountMin(1000, { w: 64, d: 4, seed: 7 });
const CALLS = [
    ['EH.add', EH_, (o) => o.add(10, 1), (o, a) => o.add(...a), [20, 1], [0, 1], (o) => o.add(11, 1)],
    ['EH.advance', EH_, (o) => o.add(10, 1), (o, a) => o.advance(...a), [20], [0], (o) => o.add(11, 1)],
    ['EH.addFrom', EH_, (o) => o.add(10, 1), (o, a) => o.addFrom(...a), [Float64Array.of(20, 1), 0], [0, 1], (o) => o.add(11, 1)],
    ['EH.ctor', null, null, (o, a) => new ExponentialHistogram(...a), [1000, 0.01], [0, 1], null],
    ['ADWIN.add', () => new ADWIN(0.1), (o) => o.add(1), (o, a) => o.add(...a), [1], [0], (o) => o.add(1)],
    ['ADWIN.ctor', null, null, (o, a) => new ADWIN(...a), [0.1], [0], null],
    ['FD.add', () => new ForwardDecay(1e9), (o) => o.add(10, 1), (o, a) => o.add(...a), [20, 1], [0, 1], (o) => o.add(11, 1)],
    ['FD.ctor', null, null, (o, a) => new ForwardDecay(...a), [1e9], [0], null],
    ['HK.add', () => new HeavyKeeper(4, 512, 16, { seed: 4 }), (o) => o.add(1, 1), (o, a) => o.add(...a), [2, 1], [0, 1], (o) => o.add(1, 1)],
    ['HK.topKInto', () => new HeavyKeeper(4, 512, 16, { seed: 4 }), (o) => o.add(1, 1), (o, a) => o.topKInto(...a), [new Float64Array(32)], [0], (o) => o.add(1, 1)],
    ['HK.forEach', () => new HeavyKeeper(4, 512, 16, { seed: 4 }), (o) => o.add(1, 1), (o, a) => o.forEach(...a), [() => {}], [], (o) => o.add(1, 1)],
    ['HK.ctor', null, null, (o, a) => new HeavyKeeper(...a), [4, 512, 16], [0, 1, 2], null],
    ['HK.withAccuracy', null, null, (o, a) => HeavyKeeper.withAccuracy(...a), [8, 0.01], [0, 1], null],
    ['SHLL.add', () => new SlidingHyperLogLog(1000, { p: 10, seed: 3 }), (o) => o.add(10, 1), (o, a) => o.add(...a), [20, 2], [0, 1], (o) => o.add(11, 3)],
    ['SHLL.advance', () => new SlidingHyperLogLog(1000, { p: 10, seed: 3 }), (o) => o.add(10, 1), (o, a) => o.advance(...a), [20], [0], (o) => o.add(11, 3)],
    ['SHLL.ctor', null, null, (o, a) => new SlidingHyperLogLog(...a), [1000], [0], null],
    ['DD.add', () => new DriftDetector(DRIFT_PH), (o) => o.add(1), (o, a) => o.add(...a), [1], [0], (o) => o.add(1)],
    ['DD.addFrom', () => new DriftDetector(DRIFT_PH), (o) => o.add(1), (o, a) => o.addFrom(...a), [Float64Array.of(1), 0], [0, 1], (o) => o.add(1)],
    ['DD.ctor', null, null, (o, a) => new DriftDetector(...a), [DRIFT_PH], [0], null],
    ['SDD.add', () => new SlidingDDSketch(1000), (o) => o.add(10, 1), (o, a) => o.add(...a), [20, 1], [0, 1], (o) => o.add(11, 1)],
    ['SDD.advance', () => new SlidingDDSketch(1000), (o) => o.add(10, 1), (o, a) => o.advance(...a), [20], [0], (o) => o.add(11, 1)],
    ['SDD.quantileInto', () => new SlidingDDSketch(1000), (o) => o.add(10, 1), (o, a) => o.quantileInto(...a), [Float64Array.of(0.5), new Float64Array(1)], [0, 1], (o) => o.add(11, 1)],
    ['SDD.ctor', null, null, (o, a) => new SlidingDDSketch(...a), [1000], [0], null],
    ['SCM.add', SCM_, (o) => o.add(10, 1), (o, a) => o.add(...a), [20, 2, 1], [0, 1, 2], (o) => o.add(11, 1)],
    ['SCM.advance', SCM_, (o) => o.add(10, 1), (o, a) => o.advance(...a), [20], [0], (o) => o.add(11, 1)],
    ['SCM.estimateInto', SCM_, (o) => o.add(10, 1), (o, a) => o.estimateInto(...a), [Float64Array.of(1), new Float64Array(1)], [0, 1], (o) => o.add(11, 1)],
    ['SCM.ctor', null, null, (o, a) => new SlidingCountMin(...a), [1000], [0], null],
    ['SCM.withAccuracy', null, null, (o, a) => SlidingCountMin.withAccuracy(...a), [1000, 0.01, 0.01], [0, 1, 2], null],
    ['DR.add', () => new DecayedReservoir(8, 1e5, { seed: 7 }), (o) => o.add(10, 1), (o, a) => o.add(...a), [20, 1], [0, 1], (o) => o.add(11, 1)],
    ['DR.sampleInto', () => new DecayedReservoir(8, 1e5, { seed: 7 }), (o) => o.add(10, 1), (o, a) => o.sampleInto(...a), [new Float64Array(8)], [0], (o) => o.add(11, 1)],
    ['DR.ctor', null, null, (o, a) => new DecayedReservoir(...a), [8, 1e5], [0, 1], null],
    ['SA.add', () => new SlidingAggregate(1000), (o) => o.add(10, 1), (o, a) => o.add(...a), [20, 1], [0, 1], (o) => o.add(11, 1)],
    ['SA.advance', () => new SlidingAggregate(1000), (o) => o.add(10, 1), (o, a) => o.advance(...a), [20], [0], (o) => o.add(11, 1)],
    ['SA.into', () => new SlidingAggregate(1000), (o) => o.add(10, 1), (o, a) => o.into(...a), [new Float64Array(5)], [0], (o) => o.add(11, 1)],
    ['SA.ctor', null, null, (o, a) => new SlidingAggregate(...a), [1000], [0], null],
];

test('H1 every validated slot x 7 hostile kinds (toString / valueOf / toPrimitive / Number object / Proxy get-has-ownKeys-getPrototypeOf-apply): tagged throw, 0 caller calls, victim + instance unchanged', () => {
    const bad = [];
    let rows = 0;
    for (const [label, mk, prep, call, tmpl, slots, mut] of CALLS) {
        for (const slot of slots) {
            const kinds = Object.keys(hostiles({ calls: 0, mut() {} }));
            for (const kind of kinds) {
                // a victim of the same class is what the hostile re-enters; ctors re-enter a sibling instance.
                const victim = mk ? mk() : SCM_();
                if (prep) prep(victim);
                const inst = mk ? mk() : null;
                if (inst && prep) prep(inst);
                const state = { calls: 0, mut: () => (mut ? mut(victim) : victim.add(11, 1)) };
                const h = hostiles(state)[kind];
                const args = tmpl.slice(); args[slot] = h;
                const insts = inst ? [victim, inst] : [victim];
                const before = insts.map(snap);
                let msg = null;
                try { call(inst, args); } catch (e) { msg = e && e.message; }
                rows++;
                const ok = msg !== null && LA.test(msg) && state.calls === 0 && insts.every((o, k) => snap(o) === before[k]);
                if (!ok) bad.push(label + ' slot ' + slot + ' ' + kind + ': msg=' + JSON.stringify(msg) + ' calls=' + state.calls);
            }
        }
    }
    assert.ok(rows > 300, 'precondition: matrix size ' + rows);
    assert.deepEqual(bad, [], bad.length + ' hostile rows failed:\n  ' + bad.join('\n  '));
});

test('H2 null / symbol / bigint in every validated slot: a clean tagged error (never a native conversion TypeError); undefined, where it throws, is tagged', () => {
    const bad = [];
    for (const [label, mk, prep, call, tmpl, slots] of CALLS) {
        for (const slot of slots) {
            for (const [name, v, mustThrow] of [['null', null, true], ['symbol', Symbol('s'), true], ['bigint', 10n, true], ['bigint0', 0n, true], ['undefined', undefined, false]]) {
                const inst = mk ? mk() : null;
                if (inst && prep) prep(inst);
                const before = inst ? snap(inst) : '';
                const args = tmpl.slice(); args[slot] = v;
                let msg = null;
                try { call(inst, args); } catch (e) { msg = (e && e.message) || String(e); }
                if (msg === null) { if (mustThrow) bad.push(label + ' slot ' + slot + ' ' + name + ': accepted'); continue; }
                if (!LA.test(msg)) bad.push(label + ' slot ' + slot + ' ' + name + ': untagged ' + JSON.stringify(msg));
                else if (inst && snap(inst) !== before) bad.push(label + ' slot ' + slot + ' ' + name + ': state changed on reject');
            }
        }
    }
    assert.deepEqual(bad, [], bad.length + ' rows:\n  ' + bad.join('\n  '));
});

test('H3 a reject message names numbers byte-identically and objects inertly (no user text leaks)', () => {
    const o = new SlidingCountMin(1000);
    assert.throws(() => o.add(NaN, 1), /got NaN$/);
    assert.throws(() => o.add(-Infinity, 1), /got -Infinity$/);
    const secret = { toString() { return 'LEAK'; } };
    assert.throws(() => o.add(secret, 1), (e) => LA.test(e.message) && !/LEAK/.test(e.message));
    assert.throws(() => o.add(1, Symbol('LEAK2')), (e) => LA.test(e.message) && /Symbol\(LEAK2\)/.test(e.message));
});

// ---------------------------------------------------------------------------------------------------
// P. DriftDetector latched PH
// ---------------------------------------------------------------------------------------------------
function ddRow(dd, f) {
    let st, mn;
    try { st = dd.statistic; } catch (e) { st = 'throw'; }
    try { mn = dd.mean; } catch (e) { mn = 'throw'; }
    return [f, st, mn, dd.count, dd.lastDriftIndex, dd.lastDirection, dd.latched];
}
const GETTERS = ['fired', 'statistic', 'mean', 'count', 'lastDriftIndex', 'lastDirection', 'latched'];
function diffRows(a, b) {
    const d = GETTERS.map(() => 0), first = GETTERS.map(() => -1);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < GETTERS.length; j++) {
        if (!Object.is(a[i][j], b[i][j])) { d[j]++; if (first[j] < 0) first[j] = i; }
    }
    return { d, first, total: d.reduce((x, y) => x + y, 0) };
}
function randomStream(seed, N) {
    const r = mulberry32(seed), xs = new Float64Array(N);
    let lvl = 0;
    for (let i = 0; i < N; i++) {
        if (r() < 1 / 2000) lvl = [0, 5, -5, 20, -3][(r() * 5) | 0];
        xs[i] = lvl + (r() - 0.5) * 4 + (r() < 0.001 ? (r() - 0.5) * 1e3 : 0);
    }
    return xs;
}

test('P1 latch:false PH / CUSUM and latch:true CUSUM are BIT-IDENTICAL to 1.9.0 over 1e5 random items (add + addFrom, every getter per item)', async () => {
    const H = await head();
    assert.ok(H, 'the 1.9.0 source (git show ' + BASE_1_9_0 + ':Adaptive.js) must be loadable -- unmeasured is a FAIL');
    const cfgs = [
        [DRIFT_PH, { delta: 0.005, threshold: 50, latch: false }],
        [DRIFT_PH, { delta: 0.05, threshold: 5, latch: false }],
        [DRIFT_CUSUM, { delta: 0.5, threshold: 20, target: 0, latch: false }],
        [DRIFT_CUSUM, { delta: 0.5, threshold: 20, target: 0, latch: true }],
        [DRIFT_CUSUM, { delta: 0.05, threshold: 3, target: 1, latch: true }],
    ];
    for (const [mode, opts] of cfgs) {
        for (const seed of [1, 2]) {
            const xs = randomStream(seed * 97 + (mode === DRIFT_PH ? 0 : 7), 100000);
            const run = (M) => {
                const dd = new M.DriftDetector(mode === DRIFT_PH ? M.DRIFT_PH : M.DRIFT_CUSUM, opts);
                const buf = new Float64Array(1), rows = [];
                for (let i = 0; i < xs.length; i++) {
                    let f;
                    if (i & 1) { buf[0] = xs[i]; f = dd.addFrom(buf, 0); } else f = dd.add(xs[i]);
                    rows.push(ddRow(dd, f));
                    if (i === 60000) dd.clear();
                }
                return rows;
            };
            const a = run({ DriftDetector, DRIFT_PH, DRIFT_CUSUM }), h = run(H);
            const fires = a.filter((r) => r[0]).length;
            assert.ok(fires > 3, 'precondition: the stream fires (' + fires + ')');
            const r = diffRows(a, h);
            assert.equal(r.total, 0, JSON.stringify(opts) + ' seed ' + seed + ': diffs ' + JSON.stringify(r));
        }
    }
});

// ulp(x): the gap to the next double above |x| (exact via the bit-incrementing nextUp). Used to bound the
// 1.9.0-vs-1.10.0 statistic divergence by the rounding of the 1.9.0 accumulator magnitude.
function ulp(x) {
    x = Math.abs(x);
    if (x !== x || x === Infinity) return Infinity;
    if (x === 0) return Number.MIN_VALUE;
    return nextUp(x) - x;
}

function rampRun(M, N, th, reversal) {
    const dd = new M.DriftDetector(M.DRIFT_PH, { delta: 0.005, threshold: th, latch: true });
    const buf = new Float64Array(1), rows = [], accBefore = [];
    let recentres = 0, prevMax = 0, firstRc = -1;
    // the accumulator magnitude BEFORE an add governs that add's cancellation error (1.9.0 zeroes the
    // accumulators on re-arm, so a POST-add read would miss the huge pre-re-arm operands).
    const mag = () => Math.max(Math.abs(dd._gP), Math.abs(dd._gN), Math.abs(dd._mMin), Math.abs(dd._mMax));
    for (let i = 0; i < N; i++) {
        accBefore.push(mag());
        buf[0] = i; const f = dd.addFrom(buf, 0); rows.push(ddRow(dd, f));
        if (dd._mMax === 0 && prevMax > th * 1048576 * 0.5) { recentres++; if (firstRc < 0) firstRc = rows.length - 1; }
        prevMax = dd._mMax;
    }
    for (let i = 0; i < reversal; i++) { accBefore.push(mag()); buf[0] = -1e6; const f = dd.addFrom(buf, 0); rows.push(ddRow(dd, f)); }
    for (let i = 0; i < reversal; i++) { accBefore.push(mag()); buf[0] = 3e6 + (i & 7); const f = dd.addFrom(buf, 0); rows.push(ddRow(dd, f)); }
    return { rows, accBefore, recentres, firstRc };
}

// THE KEY CLAIM (QA110 F4, now LIVE). The latched-PH re-centre (v1.10.0 T8) is NOT bit-output-identical to
// 1.9.0 across a re-centre: 1.9.0 lets the accumulators drift unbounded, so at a large-magnitude reversal
// its `statistic` suffers catastrophic cancellation (accumulated rounding ~= N*ulp(mag)) while the re-centred
// build stays accurate. Documented property (ROADMAP 10.1, ADR 0007 amendment):
//   (a) every public getter is BIT-IDENTICAL to 1.9.0 UNTIL the first re-centre trips;
//   (b) after it, fired / mean / count / lastDriftIndex / lastDirection are STILL bit-identical, and
//       |statistic - 1.9.0| <= 4 * ulp(the 1.9.0 accumulator magnitude) at every item whose re-arm
//       decision did NOT diverge (statistic is MORE accurate here -- no catastrophic cancellation);
//   (c) the only `latched` difference is a re-arm resolved differently at an EXACT th/2 tie -- at such a
//       row the true gap sits within that same rounding bound of th/2 (1.9.0 rounded it below, we did not).
test('P2 latched-PH re-centre vs 1.9.0: identical until the trip; after it fire/mean/count/index/direction identical, statistic within 4*ulp(acc), latched differs only at a th/2 tie', async () => {
    const H = await head();
    assert.ok(H, 'the 1.9.0 source must be loadable -- unmeasured is a FAIL');
    const TH = 0.01;
    const a = rampRun({ DriftDetector, DRIFT_PH }, 300000, TH, 5000);
    const h = rampRun(H, 300000, TH, 5000);
    assert.ok(a.recentres > 0, 'precondition: the re-centre tripped (' + a.recentres + ')');
    assert.ok(a.firstRc >= 0, 'precondition: a first re-centre index was captured');

    // (a) bit-identical for EVERY getter until the first re-centre trips.
    const pre = diffRows(a.rows.slice(0, a.firstRc), h.rows.slice(0, a.firstRc));
    assert.equal(pre.total, 0, 'before the first re-centre (row ' + a.firstRc + ') every getter must equal 1.9.0: ' +
        JSON.stringify({ perGetter: Object.fromEntries(GETTERS.map((g, j) => [g, pre.d[j]])), first: pre.first }));

    // (b) fired / mean / count / lastDriftIndex / lastDirection bit-identical EVERYWHERE (indices 0,2,3,4,5).
    const EXACT = [0, 2, 3, 4, 5];
    const exactDiffs = [];
    for (let i = 0; i < a.rows.length; i++) for (const j of EXACT) {
        if (!Object.is(a.rows[i][j], h.rows[i][j])) exactDiffs.push(GETTERS[j] + '@' + i + ' ' + a.rows[i][j] + ' vs ' + h.rows[i][j]);
    }
    assert.deepEqual(exactDiffs, [], 'fired/mean/count/lastDriftIndex/lastDirection must be bit-identical to 1.9.0');

    // (b)+(c) statistic within 4*ulp(acc) where the re-arm agrees; latched differs ONLY at a th/2 tie.
    const badStat = [], badLatch = [];
    for (let i = 0; i < a.rows.length; i++) {
        const bound = 4 * Math.max(ulp(h.accBefore[i]), ulp(a.accBefore[i]));
        const latchDiff = !Object.is(a.rows[i][6], h.rows[i][6]);
        if (latchDiff) {
            // (c) a th/2 tie: the re-centred (accurate) statistic sits within the rounding bound of th/2,
            // so 1.9.0's cancellation could round the gap to the other side of the re-arm level.
            if (!(Math.abs(a.rows[i][1] - TH / 2) <= bound)) {
                badLatch.push('row ' + i + ' latched ' + a.rows[i][6] + ' vs ' + h.rows[i][6] +
                    ' but |stat-th/2|=' + Math.abs(a.rows[i][1] - TH / 2).toExponential(3) + ' > 4ulp=' + bound.toExponential(3));
            }
        } else if (!(Math.abs(a.rows[i][1] - h.rows[i][1]) <= bound)) {
            // (b) where the re-arm agrees, the statistic gap is pure rounding, bounded by 4*ulp(acc).
            badStat.push('row ' + i + ' |stat a-h|=' + Math.abs(a.rows[i][1] - h.rows[i][1]).toExponential(3) +
                ' > 4ulp(acc=' + h.accBefore[i].toExponential(3) + ')=' + bound.toExponential(3));
        }
    }
    assert.deepEqual(badStat, [], 'statistic must be within 4*ulp(1.9.0 acc magnitude) wherever the re-arm agrees');
    assert.deepEqual(badLatch, [], 'a latched difference must occur only at an exact th/2 tie (stat within 4*ulp of th/2)');

    // and the divergence is REAL (this stream must actually exercise the property, else the oracle is vacuous).
    let latchDiffs = 0, statDiffs = 0;
    for (let i = 0; i < a.rows.length; i++) {
        if (!Object.is(a.rows[i][6], h.rows[i][6])) latchDiffs++;
        if (!Object.is(a.rows[i][1], h.rows[i][1])) statDiffs++;
    }
    assert.ok(statDiffs > 0 && latchDiffs > 0,
        'precondition: this stream must exercise both a statistic and a latched divergence (stat=' + statDiffs + ', latch=' + latchDiffs + ')');
});

test('P3 across the re-centre trip the FIRE EVENTS (index, direction) equal 1.9.0 (the reported drift history)', async () => {
    const H = await head();
    assert.ok(H, 'the 1.9.0 source must be loadable -- unmeasured is a FAIL');
    for (const th of [0.01, 0.05]) {
        const a = rampRun({ DriftDetector, DRIFT_PH }, 300000, th, 5000);
        const h = rampRun(H, 300000, th, 5000);
        assert.ok(a.recentres > 0, 'precondition: the re-centre tripped');
        const ev = (rows) => rows.map((x, i) => (x[0] ? i + ':' + x[5] : '')).filter(Boolean).join(',');
        assert.equal(ev(a.rows), ev(h.rows), 'th ' + th + ': fire history differs from 1.9.0');
    }
});

test('P4 a reversal after a 1e7-item latched drift (re-centre tripped) fires once with direction -1; the accumulators stay under th*2^20 + 30', () => {
    const th = 5, N = 1e7;
    const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: th, latch: true });
    const buf = new Float64Array(1);
    let maxAcc = 0, recentres = 0, prevMax = 0;
    const ups = [];
    for (let i = 0; i < N; i++) {
        buf[0] = i * 1e-3;                   // slow upward ramp: gN / mMax ratchet ~ 5e-4 * i per item
        if (dd.addFrom(buf, 0)) ups.push(dd.lastDirection);
        if ((i & 1023) === 0) {
            const acc = Math.max(Math.abs(dd._gP), Math.abs(dd._gN), Math.abs(dd._mMin), Math.abs(dd._mMax));
            if (acc > maxAcc) maxAcc = acc;
        }
        if (dd._mMax === 0 && prevMax > th * 1048576 * 0.5) recentres++;
        prevMax = dd._mMax;
    }
    assert.ok(recentres > 0, 'precondition: the re-centre tripped during the drift (' + recentres + ')');
    assert.deepEqual(ups, [1], 'one fire for the whole upward drift regime');
    assert.ok(maxAcc <= th * 1048576 + 30, 'accumulators bounded: ' + maxAcc);
    const downs = [];
    for (let i = 0; i < 5000; i++) { buf[0] = -1e4; if (dd.addFrom(buf, 0)) downs.push([i, dd.lastDirection]); }
    assert.equal(downs.length, 1, 'exactly one fire on the sustained reversal: ' + JSON.stringify(downs));
    assert.equal(downs[0][1], -1, 'the reversal is reported downward');
    assert.ok(downs[0][0] < 50, 'the reversal fires promptly (item ' + downs[0][0] + ')');
});

test('P5 one fire per regime on sustained steps (oracle: the step schedule), fire within 50 items of each edge, correct sign', () => {
    const segs = [[0, 3000], [100, 40000], [0, 40000], [-100, 40000], [-100.5, 1], [50, 40000], [50, 40000], [0, 40000]];
    // expected: an edge is a level change of magnitude >= 50 (the 0.5 wiggle and the 50 -> 50 join are NOT regimes)
    for (const add of ['add', 'addFrom']) {
        const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5, latch: true });
        const buf = new Float64Array(1);
        const fires = [], edges = [];
        let i = 0, prev = segs[0][0];
        for (const [v, n] of segs) {
            if (Math.abs(v - prev) >= 50) edges.push([i, Math.sign(v - prev)]);
            prev = v;
            for (let k = 0; k < n; k++, i++) {
                let f;
                if (add === 'add') f = dd.add(v); else { buf[0] = v; f = dd.addFrom(buf, 0); }
                if (f) fires.push([i, dd.lastDirection, dd.lastDriftIndex]);
            }
        }
        assert.equal(fires.length, edges.length, add + ': one fire per regime; fires ' + JSON.stringify(fires) + ' edges ' + JSON.stringify(edges));
        for (let k = 0; k < edges.length; k++) {
            assert.equal(fires[k][1], edges[k][1], add + ' regime ' + k + ' direction');
            assert.ok(fires[k][0] >= edges[k][0] && fires[k][0] < edges[k][0] + 50, add + ' regime ' + k + ' fires near its edge: ' + fires[k][0] + ' vs ' + edges[k][0]);
            assert.equal(fires[k][2], fires[k][0], 'lastDriftIndex is the firing item index');
        }
    }
});

// ---------------------------------------------------------------------------------------------------
// T. Throughput sanity vs 1.9.0 (print only; no gate).
// ---------------------------------------------------------------------------------------------------
test('T1 throughput: SCM / SDD / DD addFrom vs 1.9.0, median of 5 (INFO, not gated)', async () => {
    const H = await head();
    assert.ok(H, 'the 1.9.0 source must be loadable -- unmeasured is a FAIL');
    const N = 200000;
    const bench = (mk, fill, stride) => {
        const o = mk(), buf = new Float64Array(N * stride);
        for (let j = 0; j < N; j++) fill(buf, j * stride, j);
        const t0 = process.hrtime.bigint();
        for (let j = 0; j < N; j++) o.addFrom(buf, j * stride);
        return Number(process.hrtime.bigint() - t0) / N;
    };
    const cases = [
        ['SCM.addFrom', (M) => () => new M.SlidingCountMin(1000, { w: 256, d: 4, seed: 7 }), (b, k, j) => { b[k] = 1.75e12 + j * 1.5; b[k + 1] = (j * 733) % 97; b[k + 2] = 1; }, 3],
        ['SDD.addFrom', (M) => () => new M.SlidingDDSketch(1000, { alpha: 0.01 }), (b, k, j) => { b[k] = 1.75e12 + j * 1.5; b[k + 1] = ((j * 40503) % 9973) + 0.5; }, 2],
        ['DD.addFrom PH latch', (M) => () => new M.DriftDetector(M.DRIFT_PH, { delta: 0.005, threshold: 5, latch: true }), (b, k, j) => { b[k] = ((j & 63) < 32) ? 0 : 10; }, 1],
        ['DD.addFrom PH', (M) => () => new M.DriftDetector(M.DRIFT_PH, { delta: 0.005, threshold: 5 }), (b, k, j) => { b[k] = ((j & 63) < 32) ? 0 : 10; }, 1],
    ];
    const cur = { SlidingCountMin, SlidingDDSketch, DriftDetector, DRIFT_PH };
    for (const [name, mkf, fill, stride] of cases) {
        const tn = [], th = [];
        for (let r = 0; r < 5; r++) { th.push(bench(mkf(H), fill, stride)); tn.push(bench(mkf(cur), fill, stride)); }
        tn.sort((x, y) => x - y); th.sort((x, y) => x - y);
        console.log('    [throughput] ' + name.padEnd(20) + ' 1.10 ' + tn[2].toFixed(1) + ' ns/op  1.9.0 ' + th[2].toFixed(1) +
            ' ns/op  ratio(new/old time) ' + (tn[2] / th[2]).toFixed(3));
    }
});
