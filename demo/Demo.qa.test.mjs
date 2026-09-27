// @zakkster/lite-adaptive -- demo QA boundary suite for P1 (EH D1 + ADWIN D2) and P2 (HK D3 + SHLL D4).
//
// node --expose-gc --test demo/Demo.qa.test.mjs   (LITE_DEMO_FAST=1 skips the probe sweep + the 200k GC lane)
//
// Every oracle here is INDEPENDENT of the kernel under test: the EH pool ceiling is recomputed from the
// paper sizing formula (eps, maxCount), never from eh.k / eh.levels; the ADWIN live range is a brute-force
// max-min over a history array this file keeps itself; the HK inverse transform is the DEMO.md D3
// definition; the SHLL estimate is compared against SHADOW SlidingHyperLogLog instances this file feeds
// with the same (now, key) pairs; the query cadence is counted by a wrapper on sl.count itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HeavyKeeper, SlidingHyperLogLog } from '../Adaptive.js';
import { GcProfiler, checkNoGc, measureAllocs } from '@zakkster/lite-gc-profiler';
import {
    createAllocState,
    // EH
    createEhWorld, stepEh, stepEhGuarded, stepEhOracle, renderEhPrep,
    EH_DEFAULT_W, EH_DEFAULT_EPS, EH_DENSE_W, EH_DENSE_GAP,
    E_COUNT, E_TRUE, E_RELERR, E_FRAC, E_POP, E_TRUESUM, E_SUMFRAC, E_SUMRELEPS, E_RING_BYTES,
    E_CEIL, E_MAXCOUNT, E_FAILED, EH_FLAT_LEN,
    // ADWIN
    createAdWorld, stepAd, stepAdGhost, stepAdOracle, renderAdPrep,
    AD_DEFAULT_DELTA, AD_STREAM_LEN, A_LIVER, A_GHOSTR, A_OFFSET, AD_FLAT_LEN,
    // HK
    createHkWorld, stepHk, stepHkOracle, renderHkPrep,
    HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, HK_NKEYS, HK_KEY_SMALL, HK_KEY_BIG, HK_KEY_NEG,
    HK_BIG_OFFSET, HK_WEIGHT_MAX, HK_STREAM_LEN,
    H_RECALL, H_TRUEHH, H_FOUND, H_N, H_DISTINCT, H_MAXOVER, H_BRACKETOK, H_SAT, HK_FLAT_LEN,
    // SHLL
    createShllWorld, stepShll, stepShllOracle, renderShllPrep,
    SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, SHLL_QEVERY_MAX, SHLL_STREAM_LEN,
    S_EST, S_OVF_A, S_OVF_B, S_OVERFLOWS, SHLL_FLAT_LEN,
} from './kernels.mjs';
import { runDemoLane, LANES } from './DemoProbe.mjs';

const FAST = process.env.LITE_DEMO_FAST === '1';

/** mulberry32 -- the frame picker for the random-frame checks (deterministic). */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Bit-exact Float64Array comparison (NaN == NaN, -0 != 0). Returns the first differing index or -1. */
function firstBitDiff(a, b, skip) {
    const ua = new BigUint64Array(a.buffer, a.byteOffset, a.length);
    const ub = new BigUint64Array(b.buffer, b.byteOffset, b.length);
    for (let i = 0; i < a.length; i++) { if (skip && skip.includes(i)) continue; if (ua[i] !== ub[i]) return i; }
    return -1;
}

/** INDEPENDENT pool-ceiling oracle: the DGIM/EH sizing formula from (eps, maxCount) alone. */
function ehCeiling(eps, maxCount) {
    const k = Math.ceil(1 / (2 * eps)) + 1;
    const levels = Math.max(2, Math.ceil(Math.log2(maxCount / (k + 1))) + 2);
    return k * (2 ** levels - 1);
}

const EH_ORACLE_SLOTS = [E_TRUE, E_RELERR, E_FRAC, E_POP, E_TRUESUM, E_SUMFRAC, E_SUMRELEPS];

/* ============================== EH (D1) ============================== */

test('QA D1 EH ceiling N-1/N/N+1: E_CEIL equals the formula k*(2^levels-1) from (eps, maxCount); the C-th arrival fits, the (C+1)-th trips the tagged overflow via stepEhGuarded', () => {
    // dense10k: gap 0.1 at W = 1024 -> no expiry before 10240 arrivals, so population == arrivals.
    for (const [eps, mc] of [[0.05, 100], [0.1, 50], [0.25, 1], [0.05, 1], [0.5, 7], [0.02, 1000]]) {
        const C = ehCeiling(eps, mc);
        assert.ok(C < EH_DENSE_W / EH_DENSE_GAP, 'config must be reachable inside one window (C=' + C + ')');
        const w = createEhWorld(EH_DENSE_W, eps, 1, { preset: 'dense10k', maxCount: mc });
        w.arrivalsPerFrame = 1;   // one arrival per frame -> the throw lands on an exact population
        const a = createAllocState();
        renderEhPrep(w, a);
        assert.equal(w.flat[E_CEIL], C, 'E_CEIL (eps=' + eps + ', maxCount=' + mc + ') must equal the formula ceiling ' + C);
        assert.equal(w.flat[E_MAXCOUNT], mc, 'E_MAXCOUNT must be the declared maxCount');
        for (let i = 1; i <= C - 1; i++) stepEhGuarded(w);
        assert.equal(w.failed, 0, 'C-1 = ' + (C - 1) + ' arrivals must not overflow');
        stepEhGuarded(w);
        assert.equal(w.failed, 0, 'exactly C = ' + C + ' arrivals (the ceiling) must not overflow');
        assert.equal(w.eh.count(), C, 'at the ceiling the whole window is held: count() == C (no expiry yet)');
        const nowAtC = w.now;
        stepEhGuarded(w);
        assert.equal(w.failed, 1, 'the (C+1)-th arrival must trip the fail-closed overflow');
        assert.match(w.failMsg, /^\[lite-adaptive\] ExponentialHistogram bucket pool overflow/, 'banner carries the library tag');
        assert.ok(w.failMsg.includes('k*(2^levels-1)=' + C + ' '), 'the library message names the SAME ceiling ' + C + ': ' + w.failMsg);
        assert.ok(w.failMsg.includes('maxCount=' + mc + ','), 'the library message names maxCount');
        // the reject is a no-op on the sketch: count() still C; a later guarded frame short-circuits.
        assert.equal(w.eh.count(), C, 'the rejected add must not mutate the window (count stays C)');
        const nowAtFail = w.now;
        assert.equal(stepEhGuarded(w), 0, 'post-failure frames short-circuit to 0');
        assert.equal(w.now, nowAtFail, 'post-failure frames must not advance the clock');
        assert.ok(nowAtC < nowAtFail || nowAtC === nowAtFail, 'clock monotone');
        renderEhPrep(w, a);
        assert.equal(w.flat[E_FAILED], 1, 'E_FAILED must read 1 after the overflow');
    }
    // teeth: a ceiling ABOVE the max in-window population (10240) never overflows on dense10k.
    const big = ehCeiling(0.1, 3000);
    assert.ok(big > EH_DENSE_W / EH_DENSE_GAP);
    const w2 = createEhWorld(EH_DENSE_W, 0.1, 1, { preset: 'dense10k', maxCount: 3000 });
    for (let f = 0; f < 400; f++) stepEhGuarded(w2);
    assert.equal(w2.failed, 0, 'ceiling ' + big + ' > 10240 in-window: must never overflow');
});

test('QA D1 EH E_CEIL at the DEFAULT maxCount (2^32) and several eps equals the independent formula', () => {
    for (const eps of [0.5, 0.25, 0.1, EH_DEFAULT_EPS, 0.01]) {
        const w = createEhWorld(EH_DEFAULT_W, eps, 7);
        renderEhPrep(w, createAllocState());
        assert.equal(w.flat[E_MAXCOUNT], 4294967296, 'default maxCount is 2^32');
        assert.equal(w.flat[E_CEIL], ehCeiling(eps, 4294967296), 'E_CEIL at eps=' + eps);
        assert.ok(w.flat[E_CEIL] >= 4294967296, 'the exact ceiling is >= maxCount (the guarantee)');
    }
});

test('QA D1 EH oracle toggle round trip x4 (off -> on -> hold -> finite): all 7 oracle slots NaN while off and until now - resumeNow >= W, finite on EXACTLY the first frame past it, and then equal to a brute-force window count', () => {
    const W = 600;
    const w = createEhWorld(W, 0.05, 0xabc);
    const a = createAllocState();
    // independent timestamp history (the arrival times the stream defines: now += gaps[j])
    const ts = [], vs = [];
    let myNow = 0, j = 0;
    const frame = (oracle) => {
        stepEhGuarded(w);
        for (let i = 0; i < w.arrivalsPerFrame; i++) { myNow += w.gaps[j & (w.gaps.length - 1)]; ts.push(myNow); vs.push(w.vals[j & (w.vals.length - 1)]); j++; }
        if (oracle) stepEhOracle(w, a);   // the UI runs the ring ONLY while the toggle is on
        renderEhPrep(w, a);
        assert.equal(w.now, myNow, 'kernel clock must match the stream definition');
    };
    const brute = () => { let c = 0, s = 0; for (let i = ts.length - 1; i >= 0 && ts[i] > myNow - W; i--) { c++; s += vs[i]; } return [c, s]; };
    for (let f = 0; f < 40; f++) frame(true);
    for (const s of EH_ORACLE_SLOTS) assert.ok(Number.isFinite(w.flat[s]), 'baseline slot ' + s + ' finite');
    for (const offFrames of [1, 7, 0, 30]) {
        w.oracleOn = false;                                        // UI toggle off
        for (let f = 0; f < offFrames; f++) {
            frame(false);
            for (const s of EH_ORACLE_SLOTS) assert.ok(Number.isNaN(w.flat[s]), 'off: slot ' + s + ' must be NaN');
            assert.ok(Number.isFinite(w.flat[E_RING_BYTES]) && Number.isFinite(w.flat[E_COUNT]), 'off: ring bytes + estimate stay live');
        }
        if (offFrames === 0) { renderEhPrep(w, a); for (const s of EH_ORACLE_SLOTS) assert.ok(Number.isNaN(w.flat[s]), 'off (0 frames): NaN'); }
        w.oracleOn = true; w.resumeNow = w.now;                    // UI toggle on (stamps resumeNow)
        const resumeAt = w.now;
        let prevHeld = true, finiteFrames = 0;
        for (let f = 0; f < 60; f++) {
            frame(true);
            const held = w.now - resumeAt < W;
            for (const s of EH_ORACLE_SLOTS) {
                assert.equal(Number.isNaN(w.flat[s]), held, 'slot ' + s + ' NaN must track the hold (now-resume=' + (w.now - resumeAt) + ')');
            }
            if (!held) {
                assert.ok(!prevHeld || f > 0, 'finite never on the resume frame itself');
                const [c, sm] = brute();
                assert.equal(w.flat[E_TRUE], c, 'after the hold, E_TRUE equals the brute-force (now-W, now] count');
                assert.equal(w.flat[E_POP], c, 'E_POP equals the brute-force count');
                assert.equal(w.flat[E_TRUESUM], sm, 'E_TRUESUM equals the brute-force value sum');
                finiteFrames++;
            }
            prevHeld = held;
        }
        assert.ok(finiteFrames > 0, 'the hold must END within 60 frames (no stuck NaN)');
    }
});

test('QA D1 EH option door boundary matrix: null/undefined/{}/null-proto accepted golden-identical; maxCount null/NaN/-0/0/1.5/"8"/2^53 and [] / Symbol key / typo reject tagged', () => {
    const run = (opts) => { const w = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 0x1234, opts); const a = createAllocState(); for (let f = 0; f < 120; f++) { stepEh(w); stepEhOracle(w, a); } renderEhPrep(w, a); return w.flat; };
    const base = run(undefined);
    for (const o of [null, {}, Object.create(null), { preset: undefined, values: undefined, maxCount: undefined }]) {
        assert.equal(firstBitDiff(run(o), base), -1, 'option ' + JSON.stringify(o) + ' must be bit-identical to the 3-arg world');
    }
    for (const mc of [null, NaN, -0, 0, 1.5, '8', 2 ** 53, Infinity, -1]) {
        assert.throws(() => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 1, { maxCount: mc }), /\[lite-adaptive\]/, 'maxCount ' + String(mc) + ' must reject');
    }
    assert.doesNotThrow(() => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 1, { maxCount: 1 }), 'maxCount 1 (N=1) is valid');
    assert.throws(() => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 1, []), /plain object/);
    assert.throws(() => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 1, { [Symbol('x')]: 1 }), /Symbol/);
    assert.throws(() => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 1, { maxcount: 5 }), /did you mean "maxCount"/);
    assert.throws(() => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 1, { values: null }), /\[lite-adaptive\]/, 'values null is not the default');
    assert.throws(() => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 1, { preset: 'Dense10k' }), /\[lite-adaptive\]/);
    // seed -0 is seed 0 (bit-identical worlds)
    const s0 = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 0), sm0 = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, -0);
    assert.equal(firstBitDiff(s0.gaps, sm0.gaps), -1, 'seed -0 == seed 0');
});

test('QA D1 EH re-entrant render + empty world: two renderEhPrep calls with no step are bit-identical; a fresh world renders finite zeros', () => {
    const w = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 3, { values: 'spike' });
    const a = createAllocState();
    renderEhPrep(w, a);
    for (let i = 0; i < EH_FLAT_LEN; i++) assert.ok(Number.isFinite(w.flat[i]), 'empty world slot ' + i + ' finite');
    assert.equal(w.flat[E_COUNT], 0); assert.equal(w.flat[E_TRUE], 0);
    for (let f = 0; f < 200; f++) { stepEhGuarded(w); stepEhOracle(w, a); }
    renderEhPrep(w, a); const first = Float64Array.from(w.flat);
    renderEhPrep(w, a);
    assert.equal(firstBitDiff(first, w.flat), -1, 'renderEhPrep must be idempotent (no hidden state)');
});

/* ============================== ADWIN (D2) ============================== */

test('QA D2 ADWIN A_LIVER equals a brute-force max-min over the last ad.width fed values at random frames (6 configs, 5 frames each, across the stream wrap); A_GHOSTR is monotone and equals an independent running range', () => {
    const configs = [[AD_DEFAULT_DELTA, 0, null], [0.1, 1e3, null], [0.05, 1e6, null], [0.002, 1e9, null], [0.002, 1.7e12, null],
        [0.002, 0, 'bigJumpThenPlus1'], [0.002, 1.7e12, 'bigJumpThenPlus1']];
    const rng = mulberry32(0xC0FFEE);
    for (const [delta, off, pre] of configs) {
        const w = createAdWorld(delta, 0x77, off, pre);
        const a = createAllocState();
        const FR = 2600;   // 2600 * 32 = 83200 values > AD_STREAM_LEN (exercise the wrap)
        const picks = new Set(); while (picks.size < 5) picks.add(1 + Math.floor(rng() * FR));
        const hist = new Float64Array(FR * 32);
        let n = 0, gmin = Infinity, gmax = -Infinity, prevG = -1, checked = 0;
        for (let f = 1; f <= FR; f++) {
            stepAd(w); stepAdGhost(w); stepAdOracle(w, a);
            for (let i = 0; i < 32; i++) { const v = w.stream[n & (AD_STREAM_LEN - 1)]; hist[n++] = v; if (v < gmin) gmin = v; if (v > gmax) gmax = v; }
            if (picks.has(f) || (f % 97) === 0) {
                renderAdPrep(w, a);
                const g = w.flat[A_GHOSTR];
                assert.equal(g, gmax - gmin, 'A_GHOSTR must equal the independent running global range (frame ' + f + ')');
                assert.ok(g >= prevG, 'A_GHOSTR must be non-decreasing (frame ' + f + ': ' + g + ' < ' + prevG + ')');
                prevG = g;
                if (picks.has(f)) {
                    const width = w.ad.width;
                    assert.ok(width >= 1 && width <= n, 'width in [1, n]');
                    let mn = Infinity, mx = -Infinity;
                    for (let i = n - width; i < n; i++) { if (hist[i] < mn) mn = hist[i]; if (hist[i] > mx) mx = hist[i]; }
                    assert.equal(w.flat[A_LIVER], mx - mn, 'A_LIVER (delta=' + delta + ', off=' + off + ', ' + pre + ', frame ' + f + ', width ' + width + ') must equal brute force');
                    checked++;
                }
            }
        }
        assert.equal(checked, 5, 'five random frames checked per config');
    }
});

test('QA D2 ADWIN A_LIVER at the stream-ring boundary: width N-1 / N (= AD_STREAM_LEN) finite and exact; N+1 fails closed to NaN; width 0 and 1 read 0', () => {
    const w = createAdWorld(0.1, 1, 0, null);
    const a = createAllocState();
    renderAdPrep(w, a);
    assert.equal(w.flat[A_LIVER], 0, 'empty window: range 0');
    assert.equal(w.flat[A_GHOSTR], 0, 'empty ghost: range 0 (never -Infinity - Infinity)');
    // a stationary stream (tiny deterministic jitter) so ADWIN never cuts and width == items fed.
    for (let i = 0; i < AD_STREAM_LEN; i++) w.stream[i] = 0.5 + ((i * 7919) % 13) * 1e-3;
    w.valuesPerFrame = 1;
    stepAd(w); renderAdPrep(w, a);
    assert.equal(w.ad.width, 1); assert.equal(w.flat[A_LIVER], 0, 'width 1: range 0');
    let mn = w.stream[0], mx = w.stream[0];
    for (let n = 2; n <= AD_STREAM_LEN + 1; n++) {
        stepAd(w);
        const v = w.stream[(n - 1) & (AD_STREAM_LEN - 1)];
        if (n <= AD_STREAM_LEN) { if (v < mn) mn = v; if (v > mx) mx = v; }
        if (n >= AD_STREAM_LEN - 1) {
            renderAdPrep(w, a);
            assert.equal(w.ad.width, n, 'no cut on the stationary stream (width == n)');
            if (n <= AD_STREAM_LEN) assert.equal(w.flat[A_LIVER], mx - mn, 'width ' + n + ' must be exact');
            else assert.ok(Number.isNaN(w.flat[A_LIVER]), 'width ' + n + ' > AD_STREAM_LEN must fail closed to NaN, got ' + w.flat[A_LIVER]);
        }
    }
});

test('QA D2 ADWIN offset door: -0 behaves bit-identically to 0 (every slot but the offset label); NaN / +-Infinity / "5" / 1n / unknown preset reject tagged', () => {
    const run = (off) => { const w = createAdWorld(AD_DEFAULT_DELTA, 9, off, null); const a = createAllocState(); for (let f = 0; f < 300; f++) { stepAd(w); stepAdGhost(w); stepAdOracle(w, a); } renderAdPrep(w, a); return w.flat; };
    const z = run(0), mz = run(-0), u = run(undefined), nl = run(null);
    assert.equal(firstBitDiff(z, mz, [A_OFFSET]), -1, 'offset -0 must not change behavior');
    assert.equal(firstBitDiff(z, u), -1, 'offset undefined == 0');
    assert.equal(firstBitDiff(z, nl), -1, 'offset null == 0 (explicit null takes the default)');
    for (const bad of [NaN, Infinity, -Infinity, '5', 1n]) {
        assert.throws(() => createAdWorld(AD_DEFAULT_DELTA, 9, bad, null), /\[lite-adaptive\]|Cannot convert/, 'offset ' + String(bad) + ' must reject');
    }
    assert.throws(() => createAdWorld(AD_DEFAULT_DELTA, 9, 0, 'bigjumpthenplus1'), /\[lite-adaptive\]/);
    assert.equal(AD_FLAT_LEN, 21);
});

test('QA D2 ADWIN re-entrant render: two renderAdPrep calls with no step are bit-identical', () => {
    const w = createAdWorld(0.002, 5, 1.7e12, 'bigJumpThenPlus1'); const a = createAllocState();
    for (let f = 0; f < 1500; f++) { stepAd(w); stepAdGhost(w); stepAdOracle(w, a); }
    renderAdPrep(w, a); const first = Float64Array.from(w.flat);
    renderAdPrep(w, a);
    assert.equal(firstBitDiff(first, w.flat), -1);
});

/* ============================== HK (D3) ============================== */

/** DEMO.md D3 key transform (the spec's definition, NOT the kernel's code). */
const hkFwd = (km, idx) => km === HK_KEY_BIG ? idx + 2147483648 : (km === HK_KEY_NEG ? -(idx + 1) : idx);
const hkInv = (km, key) => km === HK_KEY_BIG ? key - 2147483648 : (km === HK_KEY_NEG ? -key - 1 : key);

test('QA D3 HK key transform: every stream slot in every key mode is the spec transform of its raw index and round-trips through the spec inverse', () => {
    assert.equal(HK_BIG_OFFSET, 2 ** 31);
    for (const km of [HK_KEY_SMALL, HK_KEY_BIG, HK_KEY_NEG]) {
        const w = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x31, km, 1);
        let maxRaw = 0;
        for (let n = 0; n < HK_STREAM_LEN; n++) {
            const raw = w.rawStream[n], key = w.stream[n];
            if (raw > maxRaw) maxRaw = raw;
            assert.ok(raw >= 0 && raw < HK_NKEYS, 'raw index in [0, nKeys)');
            if (key !== hkFwd(km, raw) || hkInv(km, key) !== raw) assert.fail('mode ' + km + ' slot ' + n + ': key ' + key + ' raw ' + raw);
            if (km === HK_KEY_BIG) assert.ok(key >= 2 ** 31);
            if (km === HK_KEY_NEG) assert.ok(key < 0);
        }
        assert.ok(maxRaw > 1000, 'the Zipf tail is exercised (max raw ' + maxRaw + ')');
    }
});

test('QA D3 HK boundary indices {0, 1, nKeys-1, 2^30-1, 2^30, 2^31-1} in every key mode: renderHkPrep recovers every leader index, finds its true count, recall 1, no overestimate', () => {
    const IDX = [0, 1, HK_NKEYS - 1, 2 ** 30 - 1, 2 ** 30, 2 ** 31 - 1];
    for (const km of [HK_KEY_SMALL, HK_KEY_BIG, HK_KEY_NEG]) {
        const w = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x55, km, 3);
        for (let n = 0; n < HK_STREAM_LEN; n++) { const idx = IDX[n % IDX.length]; w.rawStream[n] = idx; w.stream[n] = hkFwd(km, idx); }
        const a = createAllocState();
        const mine = new Map();
        let fed = 0;
        for (let f = 0; f < 120; f++) {
            stepHk(w); stepHkOracle(w, a);
            for (let i = 0; i < w.keysPerFrame; i++) { const idx = IDX[fed % IDX.length]; mine.set(idx, (mine.get(idx) || 0) + 3); fed++; }
        }
        renderHkPrep(w, a);
        const rows = w.topRows;
        assert.equal(rows, IDX.length, 'mode ' + km + ': all six boundary keys are leaders');
        for (let r = 0; r < rows; r++) {
            const idx = w.topIdx[r];
            assert.ok(IDX.includes(idx), 'mode ' + km + ': recovered index ' + idx + ' must be a boundary index');
            assert.equal(hkFwd(km, idx), w.topBuf[r * 2], 'round trip idx -> key');
            assert.equal(w.lbTrue[r], mine.get(idx), 'mode ' + km + ' idx ' + idx + ': true count from the independent Map');
            assert.ok(w.topBuf[r * 2 + 1] <= mine.get(idx), 'never overestimates');
        }
        assert.equal(w.flat[H_TRUEHH], IDX.length, 'every boundary key is a true HH');
        assert.equal(w.flat[H_RECALL], 1); assert.equal(w.flat[H_MAXOVER], 0); assert.equal(w.flat[H_BRACKETOK], 1);
    }
});

test('QA D3 HK key magnitude does not change the oracle-side readouts: H_TRUEHH / H_FOUND / H_RECALL / H_N / H_DISTINCT identical across the three modes on one seed, and equal to an independent recall recompute', () => {
    const modes = [HK_KEY_SMALL, HK_KEY_BIG, HK_KEY_NEG];
    const worlds = modes.map((km) => ({ km, w: createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x9e37, km, 1), a: createAllocState(), mine: new Map(), fed: 0 }));
    const top = new Float64Array(2 * HK_DEFAULT_K);
    for (let f = 1; f <= 300; f++) {
        for (const s of worlds) {
            stepHk(s.w); stepHkOracle(s.w, s.a);
            for (let i = 0; i < s.w.keysPerFrame; i++) { const idx = s.w.rawStream[s.fed & (HK_STREAM_LEN - 1)]; s.mine.set(idx, (s.mine.get(idx) || 0) + 1); s.fed++; }
        }
        if (f === 50 || f === 150 || f === 300) {
            const rows = [];
            for (const s of worlds) {
                renderHkPrep(s.w, s.a);
                // independent recall: true HH from my own Map, membership from a direct topKInto read
                const m = s.w.hk.topKInto(top);
                const tracked = new Set(); for (let r = 0; r < m; r++) tracked.add(hkInv(s.km, top[r * 2]));
                const thr = s.fed / HK_DEFAULT_K;
                let tru = 0, fnd = 0;
                for (const [idx, c] of s.mine) if (c > thr) { tru++; if (tracked.has(idx)) fnd++; }
                assert.equal(s.w.flat[H_TRUEHH], tru, 'mode ' + s.km + ' frame ' + f + ': H_TRUEHH vs independent');
                assert.equal(s.w.flat[H_FOUND], fnd, 'mode ' + s.km + ' frame ' + f + ': H_FOUND vs independent');
                assert.equal(s.w.flat[H_N], s.fed);
                assert.equal(s.w.flat[H_DISTINCT], s.mine.size);
                rows.push([s.w.flat[H_TRUEHH], s.w.flat[H_FOUND], s.w.flat[H_RECALL], s.w.flat[H_N], s.w.flat[H_DISTINCT]]);
            }
            assert.ok(rows[0][0] > 0, 'non-vacuous: >= 1 true HH');
            assert.deepEqual(rows[1], rows[0], 'big mode == small mode at frame ' + f);
            assert.deepEqual(rows[2], rows[0], 'neg mode == small mode at frame ' + f);
            assert.equal(rows[0][2], 1, 'recall 1.0');
        }
    }
});

test('QA D3 HK weight notch: 2^32-1 constructs and saturates (H_SAT 1); 2^32 is rejected tagged, builds NO world, and the previous world keeps running bit-identical to an untouched twin', () => {
    const A = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x5A7, HK_KEY_NEG, HK_WEIGHT_MAX);
    const B = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x5A7, HK_KEY_NEG, HK_WEIGHT_MAX);
    const aA = createAllocState(), aB = createAllocState();
    for (let f = 0; f < 150; f++) { stepHk(A); stepHkOracle(A, aA); stepHk(B); stepHkOracle(B, aB); }
    let nw;
    assert.throws(() => { nw = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x5A7, HK_KEY_NEG, HK_WEIGHT_MAX + 1); }, /^RangeError: \[lite-adaptive\]|\[lite-adaptive\]/);
    assert.equal(nw, undefined);
    for (const bad of [-0, 0, 2 ** 32, 2 ** 53, NaN, 4294967295.5]) {
        assert.throws(() => createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 1, HK_KEY_SMALL, bad), /\[lite-adaptive\]/, 'weight ' + bad);
    }
    for (let f = 0; f < 150; f++) { stepHk(A); stepHkOracle(A, aA); stepHk(B); stepHkOracle(B, aB); }
    renderHkPrep(A, aA); renderHkPrep(B, aB);
    assert.equal(firstBitDiff(A.flat, B.flat), -1, 'the kept world is bit-identical to its untouched twin');
    assert.equal(A.flat[H_SAT], 1, 'weight 2^32-1 saturates the top cell (neg keys)');
});

test('QA D3 HK weight 2^32 banner text is the SHIPPED library F10 message (DEMO.md D3: "the library\'s F10 guard REJECTS ... showing the library\'s own message")', () => {
    let lib = '';
    try { new HeavyKeeper(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K).add(1, 2 ** 32); } catch (e) { lib = e.name + ': ' + e.message; }
    assert.match(lib, /^TypeError: \[lite-adaptive\] HeavyKeeper weight must be/, 'library F10 message shape');
    let demo = '';
    try { createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x243f6a88, HK_KEY_SMALL, 2 ** 32); } catch (e) { demo = e.name + ': ' + e.message; }
    assert.equal(demo, lib, 'the fail banner must carry the library\'s own F10 message');
});

/* ============================== SHLL (D4) ============================== */

/** Count every slA.count() call with an instance-level wrapper (the counting wrapper DEMO.md D4 names). */
function wrapCount(sl) { const box = { n: 0 }; const orig = sl.count; sl.count = function () { box.n++; return orig.call(this); }; return box; }

test('QA D4 SHLL cadence: slA.count() runs EXACTLY floor(ticks / queryEvery) times for queryEvery in {1, 2, 7, 64} and 0 for never; slD estimate is bit-identical to an independent every-tick shadow; all overflows equal (non-vacuous)', () => {
    const W = 512, P = 6, RC = 2;   // ringCap 2 forces overflows so the F8 equality is not 0 == 0
    for (const qe of [1, 2, 7, 64, Infinity]) {
        const w = createShllWorld(W, P, RC, 0x77, qe);
        const a = createAllocState();
        const qa = wrapCount(w.sl);
        const shQ = new SlidingHyperLogLog(W, { p: P, ringCap: RC, seed: 0x77 });   // queried every tick
        const shN = new SlidingHyperLogLog(W, { p: P, ringCap: RC, seed: 0x77 });   // never queried until the end
        let now = 0, j = 0;
        const T = 260;
        for (let tick = 1; tick <= T; tick++) {
            stepShll(w); stepShllOracle(w, a);
            for (let i = 0; i < w.keysPerFrame; i++) { now++; const key = w.stream[j & (SHLL_STREAM_LEN - 1)]; j++; shQ.add(now, key); shN.add(now, key); }
            renderShllPrep(w, a);
            const expect = qe === Infinity ? 0 : Math.floor(tick / qe);
            assert.equal(qa.n, expect, 'qe=' + qe + ' tick ' + tick + ': slA.count() calls');
            assert.equal(w.slaQueryCount, expect, 'slaQueryCount mirrors the wrapper');
            const sq = shQ.count();
            assert.ok(Object.is(w.flat[S_EST], sq), 'qe=' + qe + ' tick ' + tick + ': S_EST (slD) ' + w.flat[S_EST] + ' vs shadow ' + sq);
            const o = shN.overflows;
            assert.equal(w.flat[S_OVF_A], o); assert.equal(w.flat[S_OVF_B], o); assert.equal(w.flat[S_OVERFLOWS], o);
            assert.equal(w.slD.overflows, o); assert.equal(shQ.overflows, o, 'the queried shadow agrees too (F8)');
        }
        assert.ok(shN.overflows > 0, 'non-vacuous: overflows > 0 (got ' + shN.overflows + ')');
        const finalN = shN.count();
        assert.ok(Object.is(w.slB.count(), finalN), 'slB (never queried) final estimate == never-queried shadow');
        assert.ok(Object.is(w.sl.count(), finalN), 'slA final estimate == shadow (count() non-destructive)');
    }
});

test('QA D4 SHLL queryEvery = SHLL_QEVERY_MAX is accepted: 0 queries through tick MAX-1, exactly 1 at tick MAX; MAX+1 / -0 / 1.5 reject; null and undefined mean never', () => {
    const w = createShllWorld(64, 4, 2, 1, SHLL_QEVERY_MAX);
    const a = createAllocState();
    const q = wrapCount(w.sl);
    stepShll(w); stepShllOracle(w, a);
    for (let t = 1; t < SHLL_QEVERY_MAX; t++) renderShllPrep(w, a);
    assert.equal(q.n, 0, 'no query before tick MAX');
    renderShllPrep(w, a);
    assert.equal(q.n, 1, 'exactly one query AT tick MAX');
    for (const bad of [SHLL_QEVERY_MAX + 1, -0, 1.5, NaN]) assert.throws(() => createShllWorld(64, 4, 2, 1, bad), /\[lite-adaptive\]/, 'qe ' + bad);
    for (const nv of [null, undefined]) {
        const v = createShllWorld(64, 4, 2, 1, nv); const qq = wrapCount(v.sl);
        for (let t = 0; t < 50; t++) { stepShll(v); renderShllPrep(v, a); }
        assert.equal(qq.n, 0, String(nv) + ' queryEvery means never'); assert.equal(v.queryEvery, Infinity);
    }
});

/* ============================== cross-scene ============================== */

test('QA cross-scene: every option-door rejection leaves a live world intact -- EH / ADWIN / HK / SHLL keep running bit-identical to an untouched twin after each rejected rebuild', () => {
    const scenes = [
        { mk: () => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 5, { values: 'spike' }), step: (w, a) => { stepEhGuarded(w); stepEhOracle(w, a); }, render: renderEhPrep,
          bad: [() => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 5, { maxCuont: 5 }), () => createEhWorld(EH_DEFAULT_W, 0, 5), () => createEhWorld(-1, 0.1, 5),
                () => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 5, { maxCount: 0 }), () => createEhWorld(EH_DEFAULT_W, 1e-9, 5, { maxCount: 2 ** 53 - 1 }), () => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 5, { preset: 'x' })] },
        { mk: () => createAdWorld(0.002, 5, 1.7e12, 'bigJumpThenPlus1'), step: (w, a) => { stepAd(w); stepAdGhost(w); stepAdOracle(w, a); }, render: renderAdPrep,
          bad: [() => createAdWorld(0, 5), () => createAdWorld(1, 5), () => createAdWorld(0.1, 5, NaN), () => createAdWorld(0.1, 5, 0, 'x')] },
        { mk: () => createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 7, HK_KEY_BIG, 256), step: (w, a) => { stepHk(w); stepHkOracle(w, a); }, render: renderHkPrep,
          bad: [() => createHkWorld(0, 1, 1), () => createHkWorld(4, 0, 1), () => createHkWorld(4, 64, 0), () => createHkWorld(4, 64, 4, 7, 3), () => createHkWorld(4, 64, 4, 7, 'neg'), () => createHkWorld(4, 64, 4, 7, 0, 2 ** 32)] },
        { mk: () => createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 7, 8), step: (w, a) => { stepShll(w); stepShllOracle(w, a); }, render: renderShllPrep,
          bad: [() => createShllWorld(0, 11, 16), () => createShllWorld(64, 3, 16), () => createShllWorld(64, 17, 16), () => createShllWorld(64, 11, 3), () => createShllWorld(64, 11, 16, 1, 0)] },
    ];
    for (const sc of scenes) {
        const A = sc.mk(), B = sc.mk(), aA = createAllocState(), aB = createAllocState();
        for (let f = 0; f < 100; f++) { sc.step(A, aA); sc.step(B, aB); if ((f & 7) === 0) { sc.render(A, aA); sc.render(B, aB); } }
        for (const b of sc.bad) {
            assert.throws(b, /\[lite-adaptive\]/, 'rejection must be tagged: ' + b.toString());
            sc.step(A, aA); sc.step(B, aB); sc.render(A, aA); sc.render(B, aB);
            assert.equal(firstBitDiff(A.flat, B.flat), -1, 'world intact after ' + b.toString());
        }
    }
});

/* ============================== probe + GC (full run only) ============================== */

// Every DemoProbe lane is classified here; an unclassified new lane defaults to 'zero' (<= 0.5 B/op under
// DEFAULT flags). dd_render is a DOCUMENTED band [44, 52] (six _guardFinite getters, three box).
// sld_quantile_box is a MUST-BOX control (the scalar quantile() return). dd_frame / dd_frame_nolatch are
// 'todo' -- the library finding ROADMAP 8 (latched PH Maglev-tier fire box) makes both read ~2 B/op; the
// demo fix lands in a later session. NOTE dd_frame_nolatch does NOT disable the latched detectors (the
// `latch` arg is only a display toggle; createDdWorld always builds all four and stepDd feeds them), so it
// reads the SAME ~2 B/op as dd_frame.
const LANE_CLASS = {
    mustbox: 'box', ad_mean_sink: 'box', ad_variance_sink: 'box', shll_render: 'box',
    sld_quantile_box: 'box', dd_render: 'band', noop: 'zero',
    dd_frame: 'todo', dd_frame_nolatch: 'todo',
};
const LANE_BAND = { dd_render: [44, 52] };
const LANE_TODO = 'library finding ROADMAP 8 (latched PH Maglev-tier fire box) -- demo session';
test('QA probe sweep: every DemoProbe lane is classified; box controls >= 12 B/op, dd_render in its documented band, noop + every gated lane <= 0.5 B/op', async (t) => {
    if (FAST) { t.skip('fast (demo:check: the lanes run in Demo.test.mjs)'); return; }
    for (const name of Object.keys(LANES)) {
        const cls = LANE_CLASS[name] || 'zero';
        const r = await runDemoLane(name);
        process.stdout.write('  qa lane ' + name + ' [' + cls + '] steady ' + r.steady + ' B/op (first ' + r.first + ')\n');
        assert.ok(r.execArgv.includes('--min-semi-space-size=4') && r.execArgv.includes('--max-semi-space-size=4'), 'pinned semi-space');
        if (cls === 'todo') {
            await t.test('lane ' + name + ' <= 0.5 B/op', { todo: LANE_TODO }, () => {
                assert.ok(r.steady <= 0.5, name + ' must read <= 0.5, got ' + r.steady);
            });
        } else if (cls === 'box') assert.ok(r.steady >= 12, name + ' control must read >= 12, got ' + r.steady);
        else if (cls === 'band') { const b = LANE_BAND[name]; assert.ok(r.steady >= b[0] && r.steady <= b[1], name + ' must read in [' + b[0] + ', ' + b[1] + '], got ' + r.steady); }
        else assert.ok(r.steady <= 0.5, name + ' must read <= 0.5, got ' + r.steady);
    }
});

test('QA shll_render documented cost: DEMO.md D4 says 16-32 B/tick (V8-inlining dependent) -- sampled over 10 fresh pinned children, every reading is in the banded [12, 40] and a THIRD box (48) would fail the upper bound', async (t) => {
    if (FAST) { t.skip('fast (10 child processes)'); return; }
    const seen = [];
    for (let i = 0; i < 10; i++) { const r = await runDemoLane('shll_render'); seen.push(r.steady); }
    // report the distribution (the box is BIMODAL: 16 when the render inlines to Turbofan, 32 when it
    // stays a Maglev standalone and the library's own count() boxes a second fractional temporary).
    const at16 = seen.filter((v) => v === 16).length, at32 = seen.filter((v) => v === 32).length;
    process.stdout.write('  qa shll_render x10: ' + seen.join(',') + ' B/op (16x' + at16 + ' 32x' + at32 + ')\n');
    for (const v of seen) assert.ok(v >= 12, 'the display box must stay visible (>= 12 B/op), got ' + v);
    assert.ok(Math.max(...seen) <= 40, 'documented 16-32 B/op (ceiling 32 + slack); a third box at 48 must fail, measured ' + seen.join(','));
});

test('QA 0-B/op + 0-major-GC over 200k ops with every P1/P2 control ENGAGED at once (failed dense10k EH, ADWIN 1.7e12 preset, HK neg keys at 2^32-1, SHLL cadence 7)', async (t) => {
    if (FAST) { t.skip('fast (demo:check skips the 200k-frame lanes)'); return; }
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const eh = createEhWorld(EH_DENSE_W, 0.05, 3, { preset: 'dense10k', maxCount: EH_DENSE_W });
    for (let f = 0; f < 400 && eh.failed === 0; f++) stepEhGuarded(eh);
    assert.equal(eh.failed, 1, 'the dense10k maxCount=W world must have overflowed (engaged)');
    const ad = createAdWorld(0.002, 5, 1.7e12, 'bigJumpThenPlus1');
    const hk = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x99, HK_KEY_NEG, HK_WEIGHT_MAX);
    const sh = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x44, 7);
    const step = () => (stepEhGuarded(eh) + stepAd(ad) + stepAdGhost(ad) + stepHk(hk) + stepShll(sh)) | 0;
    for (let i = 0; i < 20000; i++) step();
    const res = measureAllocs(step, { iterations: 100000, batches: 4 });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  qa engaged combo measureAllocs: ' + bpc.toFixed(3) + ' B/call\n');
    assert.equal(Math.max(0, Math.round(bpc)), 0, 'engaged combo must be 0 B/call, got ' + bpc);
    global.gc(); global.gc();
    const gc = new GcProfiler().start();
    let sink = 0;
    for (let i = 0; i < 200000; i++) { sink = (sink + step()) | 0; if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed); }
    await new Promise((r) => setTimeout(r, 50));
    const s = gc.summary(); const rep = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 }); gc.stop();
    process.stdout.write('  qa engaged combo gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) + '\n');
    assert.ok(Number.isFinite(sink));
    assert.equal(s.gc.major, 0, 'engaged combo: 0 major GC');
    assert.ok(rep.ok, JSON.stringify(rep.violations));
});

test('QA fail-closed seed: all four create*World REJECT a non-number / non-finite seed (never coerce it to 0 via >>> 0); -0 and a >= 2^31 seed still construct identically', () => {
    // one builder per scene, each parameterized by seed only.
    const mk = {
        EH: (seed) => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, seed),
        ADWIN: (seed) => createAdWorld(AD_DEFAULT_DELTA, seed),
        HK: (seed) => createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, seed),
        SHLL: (seed) => createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, seed),
    };
    for (const [label, build] of Object.entries(mk)) {
        for (const bad of [NaN, Infinity, -Infinity, '7', {}]) {
            assert.throws(() => build(bad), (e) => /^\[lite-adaptive\] /.test(e.message) && e instanceof TypeError,
                label + ' seed ' + String(bad) + ' must fail closed with a tagged TypeError');
        }
        // -0 is 0 (fail-closed law: -0 == 0): it must construct and behave like seed 0.
        const zNeg = build(-0), zPos = build(0);
        assert.equal(zNeg.seed, 0, label + ' seed -0 folds to 0');
        assert.equal(zNeg.seed, zPos.seed, label + ' seed -0 == 0');
        // a >= 2^31 seed is a valid uint32 once >>> 0 folds it -- must construct (no throw).
        assert.doesNotThrow(() => build(0x80000000), label + ' seed >= 2^31 must construct via >>> 0');
        assert.doesNotThrow(() => build(0xffffffff), label + ' seed 2^32-1 must construct via >>> 0');
    }
    // constant seeds already in the demo (all < 2^31 or exactly the ceiling) keep working -- sanity.
    assert.doesNotThrow(() => createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x51ec1a11));
});

test('QA sanity: flat lengths are the append-only values this suite was written against', () => {
    assert.equal(EH_FLAT_LEN, 23); assert.equal(HK_FLAT_LEN, 24); assert.equal(SHLL_FLAT_LEN, 18);
});
