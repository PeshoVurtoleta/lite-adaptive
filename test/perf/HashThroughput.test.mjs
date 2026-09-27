// @zakkster/lite-adaptive -- the F19 HASH-THROUGHPUT regression guard (repo-only; run via
//   node --expose-gc --test test/perf/HashThroughput.test.mjs
// or `npm run test:perf:matrix` / `npm run gates:red`).
//
// WHY THIS EXISTS. F19 moved the shared murmur off boxed hash-path ARGUMENTS. The first cut
// (F19v1) parked every round in an Int32Array scratch that V8 could not scalar-replace; the
// per-round memory round-trip cost ~59% on the SCM hot path and ~55% on SHLL while leaving
// HeavyKeeper (whose hash is a small fraction of addFrom) only ~16% slower. The AllocMatrix
// gate is BLIND to that: those paths were 0 B/op the whole time -- a throughput regression, not
// an allocation one. F19v2 reverted the round-trip to register-resident int32 LOCALS. This gate
// pins the ratio so a future edit that reintroduces a hot-path round-trip (or any hash-path
// slowdown) fails RED instead of shipping.
//
// HOW. An in-process A/B: for HeavyKeeper / SlidingCountMin / SlidingHyperLogLog we time the
// SHIPPED addFrom against the FROZEN 1.7.0 baseline (HashThroughputRef.mjs -- the pre-F19v2
// argument-passing murmur, the fast "old path"). Both run in the SAME process, so JIT tier and
// thermal state are shared; trials are INTERLEAVED (ref, shipped, ref, shipped ...) and we take
// the MEDIAN of N so a scheduling blip on one trial cannot bias the ratio. Cross-process timing
// of the ~13 ns SHLL scale is far too noisy for a 1.15 gate; interleaved in-process is stable
// (shipped/ref lands ~0.95-1.05 for all three). Gate: median(shipped)/median(ref) <= 1.15 per
// class. addFrom is 0-alloc on every one of these paths, so the pinned tiny semi-space of the
// matrix run drives no scavenge inside the loop -- the clock measures compute, not GC.
//
// TEETH. Set LITE_HT_SHIPPED to the slow F19v1 copy (the Int32Array round-trip): SCM reads ~1.44
// and SHLL ~1.54, both blow past 1.15 and the gate goes RED. (HK's hash is too small a slice of
// its addFrom for the round-trip to cross 1.15 -- ~1.14 -- so HK is not the teeth lane; SCM/SHLL
// are. That is by construction, not a gap in the gate.)  Proven in scratch before shipping.
// ===========================================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Shipped module under test. LITE_HT_SHIPPED overrides it (teeth: point at the slow F19v1 copy).
const SHIPPED_URL = process.env.LITE_HT_SHIPPED || new URL('../../Adaptive.js', import.meta.url).href;
const REF = await import(new URL('./HashThroughputRef.mjs', import.meta.url).href);
const SH = await import(SHIPPED_URL);

const RATIO_MAX = 1.15;                                   // SCM / SHLL: shipped may be at most 15% slower than 1.7.0
// Per-class bound: HK's hash is a small slice of its addFrom, so a +17% hash regression (F19v1) reads
// only ~1.12 there -- 1.15 would pass it. HK's measured spread is ~0.3% (0.993-0.996), so 1.08 has
// ample margin and still catches F19v1 (review, 2026-09-26).
const RATIO_MAX_BY = { HeavyKeeper: 1.08, SlidingCountMin: 1.15, SlidingHyperLogLog: 1.15 };
const OPS = Number(process.env.LITE_HT_OPS) || 400000;   // ~5 ms/trial at the SHLL 13 ns scale
const TRIALS = Number(process.env.LITE_HT_TRIALS) || 21; // odd -> a true median element
const WARM = 6;                                           // warmup rounds before the timed trials
const ATTEMPTS = 3;                                       // per class: take the MIN ratio (blip-proof)

// A fixed key mix that exercises the boxed-word classes: large (bit 31 set), 2^53-scale, negative.
const keys = new Float64Array(4096);
for (let i = 0; i < 4096; i++) keys[i] = (i & 1) ? 2147483648 + i * 977 : -(i * 65537);
const b2 = new Float64Array(2), b3 = new Float64Array(3);

// Persistent monotone clocks: a reused windowed instance needs a strictly non-decreasing `now`
// across trials. Slot 0 = ref lane, slot 1 = shipped lane (kept apart so neither rewinds).
const CLK = new Float64Array(2);
function resetClk() { CLK[0] = 1.7e12; CLK[1] = 1.7e12; }

function makeHK(M) { return new M.HeavyKeeper(4, 1024, 32); }
function makeSCM(M) { return new M.SlidingCountMin(1000, { panes: 8, w: 256, d: 4, seed: 7 }); }
function makeSHLL(M) { return new M.SlidingHyperLogLog(1e6, { p: 12, seed: 7 }); }

function runHK(inst) {
    for (let i = 0; i < OPS; i++) { b2[0] = keys[i & 4095]; b2[1] = 1; inst.addFrom(b2, 0); }
}
function runSCM(inst, slot) {
    let t = CLK[slot];
    for (let i = 0; i < OPS; i++) { t += 0.5; b3[0] = t; b3[1] = keys[i & 4095]; b3[2] = 1; inst.addFrom(b3, 0); }
    CLK[slot] = t;
}
function runSHLL(inst, slot) {
    let t = CLK[slot];
    for (let i = 0; i < OPS; i++) { t += 0.5; b2[0] = t; b2[1] = keys[i & 4095]; inst.addFrom(b2, 0); }
    CLK[slot] = t;
}

function median(a) { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }

/** One interleaved A/B measurement of `runFn` over the two module instances -> per-op ns + ratio. */
function measure(makeFn, runFn) {
    resetClk();
    const refInst = makeFn(REF), shInst = makeFn(SH);
    for (let w = 0; w < WARM; w++) { runFn(refInst, 0); runFn(shInst, 1); }   // warm both tiers
    const rr = new Array(TRIALS), sr = new Array(TRIALS);
    for (let k = 0; k < TRIALS; k++) {
        let a = performance.now(); runFn(refInst, 0); rr[k] = performance.now() - a;
        a = performance.now(); runFn(shInst, 1); sr[k] = performance.now() - a;
    }
    globalThis.gc && globalThis.gc();
    const rm = median(rr), sm = median(sr);
    return { refNs: rm * 1e6 / OPS, shNs: sm * 1e6 / OPS, ratio: sm / rm };
}

/** Best (min ratio) over ATTEMPTS: a genuine 1.4x regression survives every retry; a one-off
 *  scheduler blip does not. shipped (~1.0) and the slow copy (~1.44) are both far from 1.15, so
 *  the min neither hides a regression nor trips on noise. */
function bestOf(makeFn, runFn) {
    let best = null;
    for (let a = 0; a < ATTEMPTS; a++) {
        const m = measure(makeFn, runFn);
        if (best === null || m.ratio < best.ratio) best = m;
    }
    return best;
}

const LANES = [
    ['HeavyKeeper', makeHK, runHK],
    ['SlidingCountMin', makeSCM, runSCM],
    ['SlidingHyperLogLog', makeSHLL, runSHLL],
];

test('F19 hash-throughput A/B (shipped addFrom vs frozen 1.7.0 baseline; per-class ratio bound)', async (t) => {
    const rows = [];
    for (const [name, mk, rn] of LANES) rows.push({ name, ...bestOf(mk, rn) });

    const w = Math.max(...rows.map((r) => r.name.length));
    console.log('F19 hash-throughput (in-process interleaved A/B, median of ' + TRIALS +
        ' x ' + OPS + ' ops, best of ' + ATTEMPTS + '; per-class gate: HK <= 1.08, SCM / SHLL <= 1.15):');
    console.log('  shipped: ' + SHIPPED_URL);
    for (const r of rows) {
        console.log('  ' + r.name.padEnd(w) + '  ref ' + r.refNs.toFixed(2) + ' ns/op  shipped ' +
            r.shNs.toFixed(2) + ' ns/op  ratio ' + r.ratio.toFixed(3) +
            (r.ratio <= RATIO_MAX_BY[r.name] ? '  OK' : '  REGRESSION'));
    }

    for (const r of rows) {
        const bound = RATIO_MAX_BY[r.name];
        await t.test(r.name + ' addFrom ratio ' + r.ratio.toFixed(3) + ' <= ' + bound, () => {
            assert.ok(r.ratio <= bound,
                r.name + ' addFrom is ' + r.ratio.toFixed(3) + 'x the frozen 1.7.0 baseline (' +
                r.shNs.toFixed(2) + ' vs ' + r.refNs.toFixed(2) + ' ns/op) -- a hash-path throughput ' +
                'regression (> ' + bound + '). F19v1 round-trip reintroduced?');
        });
    }
});
