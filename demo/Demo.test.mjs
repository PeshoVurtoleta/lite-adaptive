// @zakkster/lite-adaptive -- demo honesty proof, ALL FOUR scenes (repo-only, node:test).
//
//   node --test demo/Demo.test.mjs             (faithfulness + witness + version-trinity + boundary)
//   node --expose-gc --test demo/Demo.test.mjs (adds the 0-B/op hot-kernel gate; the `demo` script)
//
// Dev-only: NOT part of the shipped test/ suite that `npm test` runs (demo/ never ships -- Section 8
// of DEMO.md). Proves the demo cannot lie (DEMO.md Section 7), for EVERY scene:
//   Scene 01 ExponentialHistogram (sliding-window count) -- windowed relerr <= epsilon (HARD).
//   Scene 02 ADWIN                (drift + adaptive window) -- false-alarm <= delta; adapted mean.
//   Scene 03 ForwardDecay         (time-decayed aggregate) -- EXACT modulo FP (relerr <= 1e-9).
//   Scene 04 HeavyKeeper          (heavy hitters / top-k)   -- recall 1.0, never overestimates,
//                                 marquee mean rel-error BELOW a faithful Space-Saving baseline.
//   1. FAITHFULNESS   -- every displayed number is re-derived from the ACTUAL Adaptive.js classes.
//   2. WITNESS        -- the measured error satisfies the SAME thresholds test/witness.mjs gates
//                        each member against (EH: rel <= epsilon; ADWIN: false-alarm <= delta +
//                        |mean - mu| < 0.05; ForwardDecay: rel <= 1e-9; HeavyKeeper: recall 1.0 +
//                        never overestimates + beats Space-Saving on drift).
//   3. VERSION TRINITY -- kernels.mjs VERSION === Adaptive.js VERSION === package.json version.
//   4. ZERO-ALLOC GATE -- every scene's stepX + renderXPrep measure 0 B/op and trigger 0 major GC.
//   5. RETENTION       -- 50 clear()/refill cycles: hk.size returns to 0, eh.bucketCount <= capacity.
//   6. BOUNDARY/MUTATION -- fail-closed ctors, live-mutation bites, re-entrant render idempotence.
// ASCII-only per suite law.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper,
    SlidingHyperLogLog, DriftDetector, SlidingDDSketch, SlidingCountMin, DecayedReservoir,
    VERSION as ADAPTIVE_VERSION,
} from '../Adaptive.js';
import {
    VERSION as KERNEL_VERSION, createAllocState,
    // Scene 01 -- ExponentialHistogram
    createEhWorld, stepEh, stepEhOracle, renderEhPrep,
    EH_DEFAULT_W, EH_DEFAULT_EPS, EH_STREAM_LEN, EH_BUCKET_BYTES,
    E_COUNT, E_TRUE, E_RELERR, E_EPS, E_FRAC, E_W, E_BUCKETS, E_CAP, E_SKETCH_ALLOC, E_ORACLE_ALLOC,
    // Scene 02 -- ADWIN
    createAdWorld, stepAd, stepAdOracle, renderAdPrep,
    AD_DEFAULT_DELTA, AD_MEAN_BAND, AD_MEAN_LO, AD_MEAN_HI, AD_REGIME,
    A_MEAN, A_TRUEMEAN, A_CUMMEAN, A_WIDTH, A_DELTA, A_MEANERR, A_CUTS, A_N, A_SKETCH_ALLOC, A_ORACLE_ALLOC,
    // Scene 03 -- ForwardDecay
    createFdWorld, stepFd, stepFdOracle, renderFdPrep, fdOracle,
    FD_DEFAULT_HALFLIFE, FD_TOL, FD_MAX_HALFLIFE, FD_ORACLE_LEN,
    D_COUNT, D_SUM, D_MEAN, D_RELERR, D_TOL, D_LANDMARK, D_REBASED, D_N, D_SKETCH_ALLOC, D_ORACLE_ALLOC,
    // Scene 04 -- HeavyKeeper
    createHkWorld, stepHk, stepHkOracle, renderHkPrep,
    HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, HK_DRIFT_OFFSET, HK_SS_MULT,
    H_RECALL, H_TRUEHH, H_MAXOVER, H_BRACKETOK, H_HKERR, H_SSERR, H_MARQUEEOK, H_SIZE, H_N,
    H_SKETCH_ALLOC, H_ORACLE_ALLOC,
    // Scene 05 -- SlidingHyperLogLog
    createShllWorld, stepShll, stepShllOracle, renderShllPrep,
    SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, SHLL_KEYS_PER_FRAME, SHLL_SIGMA_MULT,
    S_EST, S_TRUE, S_RELERR, S_GATE, S_FRAC, S_M, S_DEGRADED, S_N, S_SKETCH_ALLOC, S_ORACLE_ALLOC,
    // Scene 06 -- DriftDetector
    createDdWorld, stepDd, stepDdOracle, renderDdPrep,
    DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD,
    G_PH_STAT, G_PH_THRESH, G_CU_STAT, G_CU_THRESH, G_PH_FIRES, G_CU_FIRES, G_CP, G_N,
    G_SKETCH_ALLOC, G_ORACLE_ALLOC,
    // Scene 07 -- SlidingDDSketch
    createSldWorld, stepSld, stepSldOracle, renderSldPrep,
    SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, SLD_VALUES_PER_FRAME,
    Q_P50, Q_P90, Q_P99, Q_MAXREL, Q_ALPHA, Q_COUNT, Q_LIVE, Q_EDGE, Q_N, Q_SKETCH_ALLOC, Q_ORACLE_ALLOC,
    // Scene 08 -- SlidingCountMin
    createScmWorld, stepScm, stepScmOracle, renderScmPrep,
    SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, SCM_KEYS_PER_FRAME, SCM_TRACKED, SCM_STRIDE,
    C_BOUNDOK, C_NLIVE, C_SATURATED, C_N, C_SKETCH_ALLOC, C_ORACLE_ALLOC,
    // Scene 09 -- DecayedReservoir
    createDrWorld, stepDr, stepDrOracle, renderDrPrep,
    DR_DEFAULT_K, DR_DEFAULT_HALFLIFE, DR_ADDS_PER_FRAME,
    R_SIZE, R_K, R_MEANAGE, R_RECENCYFRAC, R_N, R_SKETCH_ALLOC, R_ORACLE_ALLOC,
} from './kernels.mjs';

// Dev-only peer (already a devDependency -- the same tool test/torture.mjs uses). Used ONLY by the
// 0-B/op assertions below; each such test skips cleanly (t.skip) without --expose-gc.
import { GcProfiler, checkNoGc, measureAllocs } from '@zakkster/lite-gc-profiler';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PKG = require('../package.json');

// `demo:check` (fast) sets LITE_DEMO_FAST=1: run trinity + faithfulness + boundary + seed + ONE alloc
// batch per scene, and skip the SLOWEST lanes -- the 200k-frame GC gates and the DR inclusion-slope
// sweep (the two multi-second lanes). The witness faithfulness sweeps + the HK marquee still run under
// demo:check (fast enough, and they re-prove the demo kernels' accuracy in the verify tail). The full
// `demo` script leaves LITE_DEMO_FAST unset and runs everything, incl. the 200k-frame GC lanes.
const FAST = process.env.LITE_DEMO_FAST === '1';
const ALLOC_BATCHES = FAST ? 1 : 8;

/** A deterministic mulberry32 PRNG (matches test/witness.mjs mulberry32) -- reused for the
 *  stationary false-alarm run + the drift marquee, so every number here is reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* ============================ version trinity ============================== */

test('version trinity: kernels re-export === Adaptive.js VERSION === package.json version (dynamic, no literal)', () => {
    assert.equal(KERNEL_VERSION, ADAPTIVE_VERSION, 'kernels.mjs must re-export the shipped VERSION');
    assert.equal(ADAPTIVE_VERSION, PKG.version, 'Adaptive.js VERSION must equal package.json version');
    assert.match(ADAPTIVE_VERSION, /^\d+\.\d+\.\d+$/, 'VERSION must be a clean semver string');
});

test('index.html displays VERSION via the kernels import, never a hardcoded version literal', () => {
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    assert.match(html, /import\s*\{[^}]*\bVERSION\b[^}]*\}\s*from\s*'\.\/kernels\.mjs'/,
        'index.html must import VERSION from ./kernels.mjs');
    assert.match(html, /brand-version'\)\.textContent\s*=\s*'v'\s*\+\s*VERSION/,
        'index.html must render the brand version from the imported VERSION');
    assert.ok(!html.includes("'v" + ADAPTIVE_VERSION + "'"),
        'index.html must not hardcode the literal version string (would slip a /release)');
});

/* =============================================================================================
 * SCENE 01 -- ExponentialHistogram (sliding-window count)
 * ============================================================================================= */

test('EH faithfulness: stepEh-driven count() equals a FRESH ExponentialHistogram fed the same timestamps', () => {
    const world = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 0xC0FFEE01);
    const FRAMES = 300;
    for (let f = 0; f < FRAMES; f++) stepEh(world);

    // Independent reference: a FRESH EH fed the SAME monotone timestamp sequence, recomputed from the
    // pre-generated gap stream (never reading world.eh) -- a genuinely separate path.
    const ref = new ExponentialHistogram(world.W, world.epsilon);
    let now = 0;
    const total = FRAMES * world.arrivalsPerFrame;
    for (let t = 0; t < total; t++) { now += world.gaps[t & (EH_STREAM_LEN - 1)]; ref.add(now); }

    assert.equal(world.eh.count(), ref.count(), 'demo EH.count() must equal an independently-fed EH exactly');
    assert.equal(world.eh.sum(), ref.sum(), 'demo EH.sum() must equal the independent reference exactly');
});

test('EH faithfulness: renderEhPrep displays exactly what the shipped EH.count() and the exact ring report', () => {
    const world = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 0xFEED01);
    const a = createAllocState();
    for (let f = 0; f < 400; f++) { stepEh(world); stepEhOracle(world, a); }
    renderEhPrep(world, a);
    assert.equal(world.flat[E_COUNT], world.eh.count(), 'displayed count must be the shipped EH.count()');
    assert.equal(world.flat[E_BUCKETS], world.eh.bucketCount, 'displayed bucketCount must be the shipped getter');
    assert.equal(world.flat[E_CAP], world.eh.capacity, 'displayed capacity must be the shipped getter');
    const live = world.flat[E_TRUE];
    const wantRel = live > 0 ? Math.abs(world.eh.count() - live) / live : 0;
    assert.equal(world.flat[E_RELERR], wantRel, 'displayed relerr must equal the independently recomputed |count-true|/true');
});

test('EH witness: measured windowed relerr stays <= epsilon (the HARD bound test/witness.mjs gates), through many laps', () => {
    // Reuse the EXACT gate test/witness.mjs applies (measureCount / measureShift: `r.maxRel <= eps`),
    // never a looser multiple invented here.
    const world = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 0x0BADC0DE);
    const a = createAllocState();
    let maxRel = 0, checks = 0;
    const framesPerLap = Math.ceil(world.W / world.arrivalsPerFrame);
    for (let f = 0; f < framesPerLap * 12; f++) {
        stepEh(world); stepEhOracle(world, a);
        if (f > framesPerLap && (f & 7) === 0) {
            renderEhPrep(world, a);
            if (world.flat[E_RELERR] > maxRel) maxRel = world.flat[E_RELERR];
            checks++;
        }
    }
    assert.ok(checks > 40, 'the witness must have sampled a non-trivial number of full-window queries, got ' + checks);
    assert.ok(maxRel <= EH_DEFAULT_EPS,
        'measured windowed relerr ' + maxRel.toFixed(5) + ' must be <= epsilon ' + EH_DEFAULT_EPS + ' (the HARD bound)');
    assert.ok(world.flat[E_FRAC] <= 1.0 + 1e-9, 'the drawn accuracy cursor (relerr/eps) must stay <= 1');
});

test('EH boundary: a bad W / epsilon fails closed at the ctor (createEhWorld surfaces the [lite-adaptive] throw)', () => {
    assert.throws(() => createEhWorld(0, 0.1), /\[lite-adaptive\]/, 'W=0 must fail closed');
    assert.throws(() => createEhWorld(-1, 0.1), /\[lite-adaptive\]/, 'W<0 must fail closed');
    assert.throws(() => createEhWorld(NaN, 0.1), /\[lite-adaptive\]/, 'W=NaN must fail closed');
    assert.throws(() => createEhWorld(1000, 0), /\[lite-adaptive\]/, 'epsilon=0 must fail closed');
    assert.throws(() => createEhWorld(1000, 1), /\[lite-adaptive\]/, 'epsilon=1 must fail closed');
    assert.throws(() => createEhWorld(1000, null), /\[lite-adaptive\]/, 'epsilon=null must fail closed (null is not zero)');
    assert.doesNotThrow(() => createEhWorld(64, 0.5), 'a valid (W, epsilon) must construct');
});

test('EH seed: null/undefined fall back to the default; an explicit 0 is honored (null is not zero)', () => {
    assert.equal(createEhWorld(1000, 0.1, null).seed, 0x5eed1234, 'seed=null falls back to the default');
    assert.equal(createEhWorld(1000, 0.1, undefined).seed, 0x5eed1234, 'seed=undefined falls back to the default');
    assert.equal(createEhWorld(1000, 0.1, 0).seed, 0, 'seed=0 is honored, not aliased to the default');
    assert.equal(createEhWorld(1000, 0.1, 7).seed, 7, 'a genuine nonzero seed passes through');
});

/* =============================================================================================
 * SCENE 02 -- ADWIN (concept-drift detection + adaptive window)
 * ============================================================================================= */

test('ADWIN faithfulness: renderAdPrep displays exactly the shipped mean / width / variance', () => {
    const world = createAdWorld(AD_DEFAULT_DELTA, 0x2222);
    const a = createAllocState();
    for (let f = 0; f < 2000; f++) { stepAd(world); stepAdOracle(world, a); }
    renderAdPrep(world, a);
    assert.equal(world.flat[A_MEAN], world.ad.mean, 'displayed mean must be the shipped ADWIN.mean');
    assert.equal(world.flat[A_WIDTH], world.ad.width, 'displayed width must be the shipped ADWIN.width');
    assert.equal(world.flat[A_DELTA], world.ad.delta, 'displayed delta must be the shipped getter');
});

test('ADWIN witness: false-alarm rate on a STATIONARY Bernoulli(0.5) stream stays <= delta', () => {
    // Reuse test/witness.mjs falseAlarmRate semantics + gate (`worst <= delta`) verbatim.
    for (const delta of [0.05, 0.1, 0.3]) {
        let worst = 0;
        for (const seed of [1, 2, 3]) {
            const ad = new ADWIN(delta);
            const r = mulberry32(seed);
            let flags = 0;
            const N = 60000;
            for (let i = 0; i < N; i++) if (ad.add(r() < 0.5 ? 1 : 0)) flags++;
            const fa = flags / N;
            if (fa > worst) worst = fa;
        }
        assert.ok(worst <= delta,
            'stationary false-alarm rate ' + worst.toFixed(4) + ' must be <= delta ' + delta);
    }
});

test('ADWIN witness: after settling on the new concept, the adaptive mean is within AD_MEAN_BAND of mu (and the foil is NOT)', () => {
    // The demo world drifts AD_MEAN_LO <-> AD_MEAN_HI every AD_REGIME items. Drive one full regime so
    // ADWIN settles, then assert |ad.mean - mu| < 0.05 (the witness's adapted-window gate) while the
    // naive cumulative-mean foil is a BLEND far from mu -- the whole point of the scene.
    const world = createAdWorld(AD_DEFAULT_DELTA, 0x3333);
    const a = createAllocState();
    const framesPerRegime = Math.ceil(AD_REGIME / world.valuesPerFrame);
    // run ~1.8 regimes so the second regime (mu = AD_MEAN_HI) is well settled.
    for (let f = 0; f < Math.floor(framesPerRegime * 1.8); f++) { stepAd(world); stepAdOracle(world, a); }
    renderAdPrep(world, a);
    const mu = world.flat[A_TRUEMEAN];
    assert.ok(Math.abs(world.flat[A_MEAN] - mu) < AD_MEAN_BAND,
        'adapted mean ' + world.flat[A_MEAN].toFixed(3) + ' must be within ' + AD_MEAN_BAND + ' of mu ' + mu);
    assert.ok(world.flat[A_CUTS] > 0, 'a drift must have been detected (>= 1 cut fired)');
    // the cumulative foil should still be a blend (nowhere near the current concept) -- the contrast.
    assert.ok(Math.abs(world.flat[A_CUMMEAN] - mu) > AD_MEAN_BAND,
        'the naive cumulative mean must LAG (a blend far from the current concept -- why adaptivity matters)');
});

test('ADWIN boundary: a bad delta fails closed at the ctor', () => {
    assert.throws(() => createAdWorld(0), /\[lite-adaptive\]/, 'delta=0 must fail closed');
    assert.throws(() => createAdWorld(1), /\[lite-adaptive\]/, 'delta=1 must fail closed');
    assert.throws(() => createAdWorld(NaN), /\[lite-adaptive\]/, 'delta=NaN must fail closed');
    assert.doesNotThrow(() => createAdWorld(0.1), 'a valid delta must construct');
});

test('AD seed: null/undefined fall back to the default; an explicit 0 is honored (null is not zero)', () => {
    assert.equal(createAdWorld(AD_DEFAULT_DELTA, null).seed, 0xadadadad, 'seed=null falls back to the default');
    assert.equal(createAdWorld(AD_DEFAULT_DELTA, undefined).seed, 0xadadadad, 'seed=undefined falls back to the default');
    assert.equal(createAdWorld(AD_DEFAULT_DELTA, 0).seed, 0, 'seed=0 is honored, not aliased to the default');
    assert.equal(createAdWorld(AD_DEFAULT_DELTA, 7).seed, 7, 'a genuine nonzero seed passes through');
});

/* =============================================================================================
 * SCENE 03 -- ForwardDecay (time-decayed count / sum / mean / rate)
 * ============================================================================================= */

test('FD faithfulness: renderFdPrep displays exactly the shipped count / sum / mean at the query time', () => {
    const world = createFdWorld(FD_DEFAULT_HALFLIFE, 0x4444);
    const a = createAllocState();
    for (let f = 0; f < 150; f++) { stepFd(world); stepFdOracle(world, a); }
    renderFdPrep(world, a);
    const now = world.now;
    assert.equal(world.flat[D_COUNT], world.fd.count(now), 'displayed decayed count must be the shipped FD.count(now)');
    assert.equal(world.flat[D_SUM], world.fd.sum(now), 'displayed decayed sum must be the shipped FD.sum(now)');
    assert.equal(world.flat[D_MEAN], world.fd.mean(now), 'displayed decayed mean must be the shipped FD.mean(now)');
});

test('FD witness: measured decayed relerr stays <= 1e-9 (EXACT modulo FP, the test/witness.mjs FD_TOL) across halfLives', () => {
    // Reuse FD_TOL = 1e-9 (test/witness.mjs). Bounded run (< FD_ORACLE_LEN arrivals) so the exact
    // brute-force ring holds EVERY sample -> a genuinely complete oracle, not a truncated one.
    for (const halfLife of [200, FD_DEFAULT_HALFLIFE, FD_MAX_HALFLIFE]) {
        const world = createFdWorld(halfLife, 0x5555);
        const a = createAllocState();
        let maxRel = 0, checks = 0;
        const FRAMES = 200; // 200 * 32 = 6400 arrivals, well under FD_ORACLE_LEN (65536) -> ring never drops
        assert.ok(FRAMES * world.arrivalsPerFrame < FD_ORACLE_LEN, 'sanity: the run must fit the exact ring');
        for (let f = 0; f < FRAMES; f++) {
            stepFd(world); stepFdOracle(world, a);
            if (f > 20 && (f & 7) === 0) { renderFdPrep(world, a); if (world.flat[D_RELERR] > maxRel) maxRel = world.flat[D_RELERR]; checks++; }
        }
        assert.ok(checks > 15, 'must have sampled several decayed queries, got ' + checks);
        assert.ok(maxRel <= FD_TOL,
            'halfLife ' + halfLife + ': measured decayed relerr ' + maxRel.toExponential(2) + ' must be <= ' + FD_TOL);
    }
});

test('FD landmark-rebase invariance: the decayed queries are unchanged across a landmark rebase (exact, not drifting)', () => {
    // Drive a rebase-forcing run (small halfLife, long span) so the landmark moves well past the first
    // add, then confirm the query result STILL matches the brute-force oracle to <= 1e-9 -- i.e. the
    // rebase factored a constant out of both accumulators and changed NOTHING observable.
    const world = createFdWorld(200, 0x6666);
    const a = createAllocState();
    const FRAMES = 300; // 9600 arrivals < FD_ORACLE_LEN -> complete oracle
    for (let f = 0; f < FRAMES; f++) { stepFd(world); stepFdOracle(world, a); }
    renderFdPrep(world, a);
    assert.equal(world.flat[D_REBASED], 1, 'the landmark must have rebased past the first add (the invariance is non-vacuous)');
    assert.ok(world.flat[D_LANDMARK] > 0, 'the landmark must have advanced');
    // independent brute-force check via the exported fdOracle (the witness definition), 0-alloc scratch.
    const out = new Float64Array(2);
    fdOracle(world.oT, world.oV, world.oHead, world.oTail, world.oMask, world.lambda, world.now, out);
    const rel = out[0] > 0 ? Math.abs(world.fd.count(world.now) - out[0]) / out[0] : 0;
    assert.ok(rel <= FD_TOL, 'across the rebase the decayed count still matches the oracle to <= 1e-9, got ' + rel.toExponential(2));
    // the query is also self-consistent under time: count(now + H) == count(now) * exp(-lambda*H).
    const H = 500, cNow = world.fd.count(world.now), cLater = world.fd.count(world.now + H);
    const want = cNow * Math.exp(-world.lambda * H);
    assert.ok(Math.abs(cLater - want) / want <= 1e-12, 'count() must decay consistently across query times');
});

test('FD boundary: a bad halfLife fails closed at the ctor', () => {
    assert.throws(() => createFdWorld(0), /\[lite-adaptive\]/, 'halfLife=0 must fail closed');
    assert.throws(() => createFdWorld(-5), /\[lite-adaptive\]/, 'halfLife<0 must fail closed');
    assert.throws(() => createFdWorld(NaN), /\[lite-adaptive\]/, 'halfLife=NaN must fail closed');
    assert.doesNotThrow(() => createFdWorld(1000), 'a valid halfLife must construct');
});

test('FD seed: null/undefined fall back to the default; an explicit 0 is honored (null is not zero)', () => {
    assert.equal(createFdWorld(FD_DEFAULT_HALFLIFE, null).seed, 0xfdfdfdfd, 'seed=null falls back to the default');
    assert.equal(createFdWorld(FD_DEFAULT_HALFLIFE, undefined).seed, 0xfdfdfdfd, 'seed=undefined falls back to the default');
    assert.equal(createFdWorld(FD_DEFAULT_HALFLIFE, 0).seed, 0, 'seed=0 is honored, not aliased to the default');
    assert.equal(createFdWorld(FD_DEFAULT_HALFLIFE, 7).seed, 7, 'a genuine nonzero seed passes through');
});

/* =============================================================================================
 * SCENE 04 -- HeavyKeeper (heavy hitters / top-k)
 * ============================================================================================= */

test('HK faithfulness: renderHkPrep leaders + estimates are exactly what the shipped HeavyKeeper reports', () => {
    const world = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x7777);
    const a = createAllocState();
    for (let f = 0; f < 2000; f++) { stepHk(world); stepHkOracle(world, a); }
    renderHkPrep(world, a);
    assert.equal(world.flat[H_SIZE], world.hk.size, 'displayed size must be the shipped HeavyKeeper.size');
    // every leader in the display buffer must carry the shipped estimate for its key.
    const rows = world.flat[H_SIZE] | 0;
    for (let r = 0; r < rows; r++) {
        const key = world.topBuf[r * 2], est = world.topBuf[r * 2 + 1];
        assert.equal(est, world.hk.estimate(key), 'leader ' + r + ' estimate must equal the shipped HeavyKeeper.estimate(key)');
    }
});

test('HK witness: recall of the true heavy hitters is 1.0 and HeavyKeeper NEVER overestimates (bracket holds)', () => {
    // Reuse the witness gates: recall >= 1.0, worst overestimate == 0, every leader within
    // [true - ~N/w, true]. Stationary skew -> the cumulative Map top IS the current top.
    const world = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x8888);
    const a = createAllocState();
    for (let f = 0; f < 4000; f++) { stepHk(world); stepHkOracle(world, a); }
    renderHkPrep(world, a);
    assert.ok(world.flat[H_TRUEHH] > 0, 'there must be at least one true heavy hitter above N/k (non-vacuous recall)');
    assert.equal(world.flat[H_RECALL], 1, 'recall of the true heavy hitters above N/k must be exactly 1.0');
    assert.equal(world.flat[H_MAXOVER], 0, 'HeavyKeeper must NEVER overestimate a leader (max overestimate == 0)');
    assert.equal(world.flat[H_BRACKETOK], 1, 'every leader estimate must sit inside [true - ~N/w, true]');
});

test('HK MARQUEE: on a Zipfian + DRIFTING stream, HeavyKeeper mean rel-error is BELOW a faithful Space-Saving baseline', () => {
    // Mirror test/witness.mjs driftStream + the Metwally-Agrawal-El Abbadi (ICDT 2005) Space-Saving
    // baseline, both sized to k*4 counters, driven on the IDENTICAL stream. HeavyKeeper must win.
    const K = 12, seed = 909, D = 5, W = 4096, CAP = K * HK_SS_MULT, N = 400000, U = 8000;
    const hk = new HeavyKeeper(D, W, K, { seed });
    // inline faithful Space-Saving (min-replacement) -- NOT a lite-sketch import.
    const ssKey = new Float64Array(CAP), ssCnt = new Float64Array(CAP), ssErr = new Float64Array(CAP);
    let ssN = 0;
    const ssAdd = (key) => {
        for (let i = 0; i < ssN; i++) { if (ssKey[i] === key) { ssCnt[i] += 1; return; } }
        if (ssN < CAP) { ssKey[ssN] = key; ssCnt[ssN] = 1; ssErr[ssN] = 0; ssN++; return; }
        let mi = 0, mc = ssCnt[0];
        for (let i = 1; i < ssN; i++) if (ssCnt[i] < mc) { mc = ssCnt[i]; mi = i; }
        ssKey[mi] = key; ssErr[mi] = mc; ssCnt[mi] = mc + 1;
    };
    const ssEst = (key) => { for (let i = 0; i < ssN; i++) if (ssKey[i] === key) return ssCnt[i]; return 0; };

    const truth = new Map();
    const r = mulberry32(seed);
    // shared Zipfian CDF
    const cdf = new Float64Array(U); let s = 0;
    for (let i = 0; i < U; i++) { s += 1 / Math.pow(i + 1, 1.1); cdf[i] = s; }
    for (let i = 0; i < U; i++) cdf[i] /= s;
    for (let i = 0; i < N; i++) {
        const u = r(); let lo = 0, hi = U - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
        const key = (i < N / 2 ? 0 : HK_DRIFT_OFFSET) + lo;   // the popular set shifts at the midpoint
        hk.add(key, 1); ssAdd(key);
        truth.set(key, (truth.get(key) || 0) + 1);
    }
    const trueTop = [...truth.entries()].sort((x, y) => y[1] - x[1]).slice(0, K);
    let hkSum = 0, ssSum = 0;
    for (const [key, t] of trueTop) {
        hkSum += Math.abs(hk.estimate(key) - t) / t;
        ssSum += Math.abs(ssEst(key) - t) / t;
    }
    const hkErr = hkSum / trueTop.length, ssErrMean = ssSum / trueTop.length;
    process.stdout.write('  HK marquee: HeavyKeeper mean rel-error=' + (hkErr * 100).toFixed(3) +
        '%  vs  faithful Space-Saving=' + (ssErrMean * 100).toFixed(3) + '%\n');
    assert.ok(hkErr < ssErrMean,
        'HeavyKeeper mean rel-error ' + (hkErr * 100).toFixed(3) + '% must be below Space-Saving ' + (ssErrMean * 100).toFixed(3) + '%');
});

test('HK boundary: a bad d / w / k fails closed at the ctor', () => {
    assert.throws(() => createHkWorld(0, 1024, 12), /\[lite-adaptive\]/, 'd=0 must fail closed');
    assert.throws(() => createHkWorld(4, 0, 12), /\[lite-adaptive\]/, 'w=0 must fail closed');
    assert.throws(() => createHkWorld(4, 1024, 0), /\[lite-adaptive\]/, 'k=0 must fail closed');
    assert.throws(() => createHkWorld(4, 1024, 1.5), /\[lite-adaptive\]/, 'k non-integer must fail closed');
    assert.doesNotThrow(() => createHkWorld(4, 1024, 12), 'a valid (d, w, k) must construct');
});

test('HK seed: null/undefined fall back to the default; an explicit 0 is honored (null is not zero)', () => {
    assert.equal(createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, null).seed, 0x243f6a88, 'seed=null falls back to the default');
    assert.equal(createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, undefined).seed, 0x243f6a88, 'seed=undefined falls back to the default');
    assert.equal(createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0).seed, 0, 'seed=0 is honored, not aliased to the default');
    assert.equal(createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 7).seed, 7, 'a genuine nonzero seed passes through');
});

/* =============================================================================================
 * SCENE 05 -- SlidingHyperLogLog (windowed distinct-count)
 * ============================================================================================= */

test('SHLL faithfulness: renderShllPrep displays exactly the shipped count() and the exact-Map distinct', () => {
    const world = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0xAB01);
    const a = createAllocState();
    for (let f = 0; f < 400; f++) { stepShll(world); stepShllOracle(world, a); }
    renderShllPrep(world, a);
    assert.equal(world.flat[S_EST], world.sl.count(), 'displayed estimate must be the shipped SlidingHyperLogLog.count()');
    assert.equal(world.flat[S_TRUE], world.oMap.size, 'displayed true distinct must be the exact in-window Map size');
    assert.equal(world.flat[S_M], world.sl.m, 'displayed m must be the shipped getter');
    assert.equal(world.flat[S_DEGRADED], world.sl.degraded ? 1 : 0, 'displayed degraded flag must be the shipped getter');
});

test('SHLL witness: measured windowed distinct relerr stays <= 3*standardError, NOT degraded, over >= 2000 queries', () => {
    const world = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x0BAD5EED);
    const a = createAllocState();
    const fpl = Math.ceil(SHLL_DEFAULT_W / SHLL_KEYS_PER_FRAME);
    let maxRel = 0, checks = 0, gate = 0;
    for (let f = 0; f < fpl * 40; f++) {
        stepShll(world); stepShllOracle(world, a);
        if (f > fpl) { renderShllPrep(world, a); if (world.flat[S_RELERR] > maxRel) maxRel = world.flat[S_RELERR]; gate = world.flat[S_GATE]; checks++; }
    }
    assert.ok(checks >= 2000, 'the witness must sample >= 2000 windowed-distinct queries, got ' + checks);
    assert.equal(gate, SHLL_SIGMA_MULT * world.sl.standardError, 'the gate must be 3 * standardError (the theoretical band)');
    assert.ok(maxRel <= gate, 'measured relerr ' + maxRel.toFixed(5) + ' must be <= 3*standardError ' + gate.toFixed(5));
    assert.equal(world.sl.degraded, false, 'the sketch must never degrade on this workload (the bound is guaranteed)');
});

test('SHLL boundary: a bad W / p / ringCap fails closed at the ctor', () => {
    assert.throws(() => createShllWorld(0, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP), /\[lite-adaptive\]/, 'W=0 must fail closed');
    assert.throws(() => createShllWorld(-1, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP), /\[lite-adaptive\]/, 'W<0 must fail closed');
    assert.throws(() => createShllWorld(NaN, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP), /\[lite-adaptive\]/, 'W=NaN must fail closed');
    assert.throws(() => createShllWorld(SHLL_DEFAULT_W, 0, SHLL_DEFAULT_RINGCAP), /\[lite-adaptive\]/, 'p=0 must fail closed');
    assert.doesNotThrow(() => createShllWorld(1024, 10, 8), 'a valid (W, p, ringCap) must construct');
});

test('SHLL seed: null/undefined fall back to the default; an explicit 0 is honored (null is not zero)', () => {
    assert.equal(createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, null).seed, 0x51ec1a11, 'seed=null falls back');
    assert.equal(createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, undefined).seed, 0x51ec1a11, 'seed=undefined falls back');
    assert.equal(createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0).seed, 0, 'seed=0 is honored, not aliased');
    assert.equal(createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 7).seed, 7, 'a genuine nonzero seed passes through');
});

/* =============================================================================================
 * SCENE 06 -- DriftDetector (Page-Hinkley vs CUSUM)
 * ============================================================================================= */

test('DD faithfulness: renderDdPrep displays exactly both shipped detectors statistic / threshold / mean', () => {
    const world = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD);
    const a = createAllocState();
    for (let f = 0; f < 1000; f++) { stepDd(world); stepDdOracle(world, a); }
    renderDdPrep(world, a);
    assert.equal(world.flat[G_PH_STAT], world.ph.statistic, 'displayed PH statistic must be the shipped getter');
    assert.equal(world.flat[G_PH_THRESH], world.ph.threshold, 'displayed PH threshold must be the shipped getter');
    assert.equal(world.flat[G_CU_STAT], world.cu.statistic, 'displayed CUSUM statistic must be the shipped getter');
    assert.equal(world.flat[G_CU_THRESH], world.cu.threshold, 'displayed CUSUM threshold must be the shipped getter');
});

test('DD witness: the mode is LOAD-BEARING -- on a slow mean ramp CUSUM (fixed mu0) fires FAR more than PH (adaptive)', () => {
    // Reuse test/witness.mjs ddRampFires semantics verbatim: PH's ONLINE reference tracks the ramp and
    // stays quiet, while CUSUM's FIXED mu0=0 sees an ever-growing departure. GATE: PH fires < CUSUM.
    function ramp(mode) {
        const opts = mode === 1 ? { delta: 0.005, threshold: 5, target: 0 } : { delta: 0.005, threshold: 5 };
        const dd = new DriftDetector(mode, opts);
        const r = mulberry32(1);
        let fires = 0;
        for (let i = 0; i < 20000; i++) if (dd.add(i * 0.002 + (r() - 0.5) * 0.1)) fires++;
        return fires;
    }
    const phFires = ramp(0), cuFires = ramp(1);
    assert.ok(phFires < cuFires && cuFires > phFires * 5,
        'PH fires ' + phFires + ' must be far below CUSUM ' + cuFires + ' (mode is load-bearing)');
    // and the live scene actually detects the injected changepoints (non-vacuous).
    const world = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD);
    const a = createAllocState();
    for (let f = 0; f < 800; f++) { stepDd(world); stepDdOracle(world, a); }
    renderDdPrep(world, a);
    assert.ok(world.flat[G_CP] > 0, 'the stream must have crossed >= 1 ground-truth changepoint');
    assert.ok(world.flat[G_PH_FIRES] > 0 && world.flat[G_CU_FIRES] > 0, 'both detectors must have fired on the regime shifts');
});

test('DD boundary: a bad threshold / delta fails closed at the ctor', () => {
    assert.throws(() => createDdWorld(DD_DEFAULT_DELTA, 0), /\[lite-adaptive\]/, 'threshold=0 must fail closed');
    assert.throws(() => createDdWorld(DD_DEFAULT_DELTA, -1), /\[lite-adaptive\]/, 'threshold<0 must fail closed');
    assert.throws(() => createDdWorld(DD_DEFAULT_DELTA, NaN), /\[lite-adaptive\]/, 'threshold=NaN must fail closed');
    assert.throws(() => createDdWorld(-1, DD_DEFAULT_THRESHOLD), /\[lite-adaptive\]/, 'delta<0 must fail closed');
    assert.doesNotThrow(() => createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD), 'valid (delta, threshold) must construct');
});

/* =============================================================================================
 * SCENE 07 -- SlidingDDSketch (windowed relative-error quantiles)
 * ============================================================================================= */

test('SLD faithfulness: renderSldPrep displays exactly the shipped quantile() and count()', () => {
    const world = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES);
    const a = createAllocState();
    for (let f = 0; f < 300; f++) { stepSld(world); stepSldOracle(world, a); }
    renderSldPrep(world, a);
    assert.equal(world.flat[Q_P50], world.sd.quantile(0.5), 'displayed p50 must be the shipped SlidingDDSketch.quantile(0.5)');
    assert.equal(world.flat[Q_P90], world.sd.quantile(0.9), 'displayed p90 must be the shipped quantile(0.9)');
    assert.equal(world.flat[Q_P99], world.sd.quantile(0.99), 'displayed p99 must be the shipped quantile(0.99)');
    assert.equal(world.flat[Q_COUNT], world.sd.count(), 'displayed count must be the shipped count()');
});

test('SLD witness: measured quantile relerr <= alpha and window-edge error <= one pane width, over >= 2000 queries', () => {
    const world = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES);
    const a = createAllocState();
    const fpl = Math.ceil(SLD_DEFAULT_W / SLD_VALUES_PER_FRAME);
    const paneW = SLD_DEFAULT_W / SLD_DEFAULT_PANES;
    let maxRel = 0, maxEdge = 0, checks = 0;
    for (let f = 0; f < fpl * 40; f++) {
        stepSld(world); stepSldOracle(world, a);
        if (f > fpl) {
            renderSldPrep(world, a);
            if (world.flat[Q_MAXREL] > maxRel) maxRel = world.flat[Q_MAXREL];
            if (world.flat[Q_EDGE] > maxEdge) maxEdge = world.flat[Q_EDGE];
            checks += 3;   // three quantiles gated per render
        }
    }
    assert.ok(checks >= 2000, 'the witness must sample >= 2000 windowed-quantile queries, got ' + checks);
    assert.ok(maxRel <= SLD_DEFAULT_ALPHA + 1e-9, 'measured quantile relerr ' + maxRel.toFixed(5) + ' must be <= alpha ' + SLD_DEFAULT_ALPHA);
    assert.ok(maxEdge <= paneW, 'window-edge error ' + maxEdge + ' must be <= one pane width ' + paneW);
});

test('SLD boundary: a bad W / alpha / panes fails closed at the ctor', () => {
    assert.throws(() => createSldWorld(0, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES), /\[lite-adaptive\]/, 'W=0 must fail closed');
    assert.throws(() => createSldWorld(SLD_DEFAULT_W, 0, SLD_DEFAULT_PANES), /\[lite-adaptive\]/, 'alpha=0 must fail closed');
    assert.throws(() => createSldWorld(SLD_DEFAULT_W, 1, SLD_DEFAULT_PANES), /\[lite-adaptive\]/, 'alpha=1 must fail closed');
    assert.throws(() => createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, 1), /\[lite-adaptive\]/, 'panes<2 must fail closed');
    assert.doesNotThrow(() => createSldWorld(1024, 0.05, 16), 'a valid (W, alpha, panes) must construct');
});

/* =============================================================================================
 * SCENE 08 -- SlidingCountMin (windowed per-label frequency)
 * ============================================================================================= */

test('SCM faithfulness: renderScmPrep leader estimates are exactly the shipped SlidingCountMin.estimate', () => {
    const world = createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 0xC001);
    const a = createAllocState();
    for (let f = 0; f < 300; f++) { stepScm(world); stepScmOracle(world, a); }
    renderScmPrep(world, a);
    for (let k = 0; k < SCM_TRACKED; k++) {
        assert.equal(world.flat[k * SCM_STRIDE], world.scm.estimate(world.tracked[k]),
            'tracked key ' + k + ' estimate must equal the shipped SlidingCountMin.estimate(key)');
    }
    assert.equal(world.flat[C_SATURATED], world.scm.saturated, 'displayed saturated flag must be the shipped getter');
});

test('SCM witness: the one-sided bound true(W) <= est <= true(W+W/B) + eps*N holds on 100% of >= 2000 queries', () => {
    const world = createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 0x5C1);
    const a = createAllocState();
    const fpl = Math.ceil(SCM_DEFAULT_W / SCM_KEYS_PER_FRAME);
    let viol = 0, checks = 0;
    for (let f = 0; f < fpl * 40; f++) {
        stepScm(world); stepScmOracle(world, a);
        if (f > fpl) {
            renderScmPrep(world, a);
            if (world.flat[C_BOUNDOK] !== 1) viol++;
            checks += SCM_TRACKED;   // one bound check per tracked key
        }
    }
    assert.ok(checks >= 2000, 'the witness must sample >= 2000 per-key windowed-frequency queries, got ' + checks);
    assert.equal(viol, 0, 'the one-sided bound must hold on 100% of renders (violating renders: ' + viol + ')');
});

test('SCM boundary: a bad W / epsilon / panes fails closed at the ctor', () => {
    assert.throws(() => createScmWorld(0, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES), /\[lite-adaptive\]/, 'W=0 must fail closed');
    assert.throws(() => createScmWorld(SCM_DEFAULT_W, 0, SCM_DEFAULT_PANES), /\[lite-adaptive\]/, 'epsilon=0 must fail closed');
    assert.throws(() => createScmWorld(SCM_DEFAULT_W, 1, SCM_DEFAULT_PANES), /\[lite-adaptive\]/, 'epsilon=1 must fail closed');
    assert.throws(() => createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, 1), /\[lite-adaptive\]/, 'panes<2 must fail closed');
    assert.doesNotThrow(() => createScmWorld(1024, 0.05, 16), 'a valid (W, epsilon, panes) must construct');
});

test('SCM seed: null/undefined fall back to the default; an explicit 0 is honored (null is not zero)', () => {
    assert.equal(createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, null).seed, 0x9e3779b1, 'seed=null falls back');
    assert.equal(createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, undefined).seed, 0x9e3779b1, 'seed=undefined falls back');
    assert.equal(createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 0).seed, 0, 'seed=0 is honored, not aliased');
    assert.equal(createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 7).seed, 7, 'a genuine nonzero seed passes through');
});

/* =============================================================================================
 * SCENE 09 -- DecayedReservoir (recency-biased fixed-k sample)
 * ============================================================================================= */

test('DR faithfulness: renderDrPrep displays exactly the shipped size / k and a sample read via sampleInto', () => {
    const world = createDrWorld(DR_DEFAULT_K, DR_DEFAULT_HALFLIFE, 0xD901);
    const a = createAllocState();
    for (let f = 0; f < 400; f++) { stepDr(world); stepDrOracle(world, a); }
    renderDrPrep(world, a);
    assert.equal(world.flat[R_SIZE], world.dr.size, 'displayed size must be the shipped DecayedReservoir.size');
    assert.equal(world.flat[R_K], world.dr.k, 'displayed k must be the shipped getter');
    // independent sampleInto: the displayed size must equal what the shipped instance returns.
    const buf = new Float64Array(world.dr.k);
    assert.equal(world.dr.sampleInto(buf), world.dr.size, 'sampleInto count must equal size');
    assert.ok(world.flat[R_RECENCYFRAC] >= 0 && world.flat[R_RECENCYFRAC] <= 1, 'recency fraction must be a valid probability');
});

test('DR witness: inclusion rate by item age tracks exp(-lambda*age); the no-decay control is REJECTED', (t) => {
    if (FAST) { t.skip('fast (demo:check skips the many-trial slope fit)'); return; }
    // Reuse test/witness.mjs drReservoirSlope semantics via the PUBLIC surface (addFrom + sampleInto):
    // fit the ln(rate)-vs-age slope over the rare-inclusion tail; it must equal -lambda within +-15%.
    const DR_BAND = 0.15;
    function slope(halfLife, N, k, trials, lo, hi) {
        const incl = new Float64Array(N);
        const buf = new Float64Array(k);
        const packed = new Float64Array(2);
        for (let s = 0; s < trials; s++) {
            const r = new DecayedReservoir(k, halfLife, { seed: (s * 2654435761) >>> 0 });
            for (let tk = 0; tk < N; tk++) { packed[0] = tk; packed[1] = tk; r.addFrom(packed, 0); }
            const c = r.sampleInto(buf);
            for (let i = 0; i < c; i++) incl[buf[i] | 0]++;
        }
        const xs = [], ys = [];
        for (let age = 0; age < N; age++) { const rate = incl[N - 1 - age] / trials; if (rate > lo && rate < hi) { xs.push(age); ys.push(Math.log(rate)); } }
        const n = xs.length;
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
        return { slope: (n * sxy - sx * sy) / (n * sxx - sx * sx), points: n };
    }
    const halfLife = 50, lambda = Math.LN2 / halfLife;
    const r = slope(halfLife, 400, 8, 6000, 0.004, 0.14);
    assert.ok(r.points >= 5, 'the slope fit must have >= 5 measurable points, got ' + r.points);
    const ratio = r.slope / -lambda;
    assert.ok(Math.abs(ratio - 1) <= DR_BAND, 'fitted slope ' + r.slope.toFixed(5) + ' must match -lambda within +-15% (ratio ' + ratio.toFixed(3) + ')');
    // CONTROL (public API, decay load-bearing): a HUGE half-life -> near-flat slope -> OUT of the -lambda band.
    const flat = slope(1e12, 400, 8, 6000, 0.004, 0.14);
    const flatRatio = flat.slope / -lambda;
    assert.ok(!(Math.abs(flatRatio - 1) <= DR_BAND), 'the no-decay (huge half-life) control must be REJECTED by the slope gate (ratio ' + flatRatio.toFixed(3) + ')');
});

test('DR boundary: a bad k / halfLife fails closed at the ctor', () => {
    assert.throws(() => createDrWorld(0, DR_DEFAULT_HALFLIFE), /\[lite-adaptive\]/, 'k=0 must fail closed');
    assert.throws(() => createDrWorld(1.5, DR_DEFAULT_HALFLIFE), /\[lite-adaptive\]/, 'k non-integer must fail closed');
    assert.throws(() => createDrWorld(DR_DEFAULT_K, 0), /\[lite-adaptive\]/, 'halfLife=0 must fail closed');
    assert.throws(() => createDrWorld(DR_DEFAULT_K, -5), /\[lite-adaptive\]/, 'halfLife<0 must fail closed');
    assert.doesNotThrow(() => createDrWorld(16, 1000), 'a valid (k, halfLife) must construct');
});

test('DR seed: null/undefined fall back to the default; an explicit 0 is honored (null is not zero)', () => {
    assert.equal(createDrWorld(DR_DEFAULT_K, DR_DEFAULT_HALFLIFE, null).seed, 0x2545f491, 'seed=null falls back');
    assert.equal(createDrWorld(DR_DEFAULT_K, DR_DEFAULT_HALFLIFE, undefined).seed, 0x2545f491, 'seed=undefined falls back');
    assert.equal(createDrWorld(DR_DEFAULT_K, DR_DEFAULT_HALFLIFE, 0).seed, 0, 'seed=0 is honored, not aliased');
    assert.equal(createDrWorld(DR_DEFAULT_K, DR_DEFAULT_HALFLIFE, 7).seed, 7, 'a genuine nonzero seed passes through');
});

/* ============================ pause-the-stream (idle-slide) lanes =========================== */

// The FOUR time-windowed scenes ship a "pause the stream" toggle: while paused, stepX calls the
// member's advanceFrom (NO add) so the window slides to empty (count/distinct/quantile/estimate -> 0/NaN)
// with 0 B/op. Each lane proves the PAUSED step is 0-B/op AND drives the readout empty + ring to 0.

function pauseLane(t, name, make, step, oracle, isEmpty) {
    const world = make();
    const a = createAllocState();
    for (let f = 0; f < 200; f++) { step(world); oracle(world, a); }
    world.paused = true;
    for (let f = 0; f < 400; f++) { step(world); oracle(world, a); }
    const occ = (world.oTail - world.oHead) & world.oMask;
    assert.equal(occ, 0, name + ' paused: the exact oracle ring occupancy must slide back to 0');
    isEmpty(world);
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc for the paused 0-B/op measure'); return; }
    for (let i = 0; i < 5000; i++) step(world);
    const res = measureAllocs(() => step(world), { iterations: 100000, batches: ALLOC_BATCHES });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  ' + name + ' paused stepX measureAllocs: ' + bpc.toFixed(3) + ' B/call\n');
    assert.equal(Math.max(0, Math.round(bpc)), 0, name + ' paused stepX must measure 0 B/call, got ' + bpc);
}

test('pause EH: paused stepEh idle-slides count() -> 0 with 0 B/op', (t) => {
    pauseLane(t, 'EH', () => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 1), stepEh, stepEhOracle,
        (w) => assert.equal(w.eh.count(), 0, 'EH.count() must slide to 0 while paused'));
});
test('pause SHLL: paused stepShll idle-slides count() -> 0 with 0 B/op', (t) => {
    pauseLane(t, 'SHLL', () => createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 1), stepShll, stepShllOracle,
        (w) => { assert.equal(w.sl.count(), 0, 'SHLL.count() must slide to 0'); assert.equal(w.oMap.size, 0, 'the exact Map must empty'); });
});
test('pause SLD: paused stepSld idle-slides quantile() -> NaN, count() -> 0 with 0 B/op', (t) => {
    pauseLane(t, 'SLD', () => createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES), stepSld, stepSldOracle,
        (w) => { assert.equal(w.sd.count(), 0, 'SLD.count() must slide to 0'); assert.ok(Number.isNaN(w.sd.quantile(0.5)), 'SLD.quantile(0.5) must be NaN on an empty window'); });
});
test('pause SCM: paused stepScm idle-slides estimate() -> 0 with 0 B/op', (t) => {
    pauseLane(t, 'SCM', () => createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 1), stepScm, stepScmOracle,
        (w) => assert.equal(w.scm.estimate(0), 0, 'SCM.estimate(key) must slide to 0 while paused'));
});

test('pause retention: over 5 pause cycles every windowed readout returns to empty and the oracle ring to 0', () => {
    const eh = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 5); const ea = createAllocState();
    const sh = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 5); const sa = createAllocState();
    const sd = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES); const da = createAllocState();
    const sc = createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 5); const ca = createAllocState();
    const occ = (w) => (w.oTail - w.oHead) & w.oMask;
    for (let cycle = 0; cycle < 5; cycle++) {
        for (const w of [eh, sh, sd, sc]) w.paused = false;
        for (let f = 0; f < 120; f++) {
            stepEh(eh); stepEhOracle(eh, ea); stepShll(sh); stepShllOracle(sh, sa);
            stepSld(sd); stepSldOracle(sd, da); stepScm(sc); stepScmOracle(sc, ca);
        }
        for (const w of [eh, sh, sd, sc]) w.paused = true;
        for (let f = 0; f < 400; f++) {
            stepEh(eh); stepEhOracle(eh, ea); stepShll(sh); stepShllOracle(sh, sa);
            stepSld(sd); stepSldOracle(sd, da); stepScm(sc); stepScmOracle(sc, ca);
        }
        assert.equal(eh.eh.count(), 0, 'cycle ' + cycle + ': eh.count() must return to 0');
        assert.equal(sh.sl.count(), 0, 'cycle ' + cycle + ': shll.count() must return to 0');
        assert.equal(sd.sd.count(), 0, 'cycle ' + cycle + ': sld.count() must return to 0');
        assert.ok(Number.isNaN(sd.sd.quantile(0.5)), 'cycle ' + cycle + ': sld.quantile(0.5) must be NaN');
        assert.equal(sc.scm.estimate(0), 0, 'cycle ' + cycle + ': scm.estimate(0) must return to 0');
        for (const w of [eh, sh, sd, sc]) assert.equal(occ(w), 0, 'cycle ' + cycle + ': the oracle ring occupancy must return to 0');
    }
});

/* ============================ retention (clear/refill) ====================== */

test('retention: over 50 clear()/refill cycles hk.size returns to 0 and eh.bucketCount stays <= capacity', () => {
    const hkWorld = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x9999);
    const ehWorld = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 0xAAAA);
    const ha = createAllocState(), ea = createAllocState();
    for (let cycle = 0; cycle < 50; cycle++) {
        for (let f = 0; f < 40; f++) { stepHk(hkWorld); stepHkOracle(hkWorld, ha); stepEh(ehWorld); stepEhOracle(ehWorld, ea); }
        assert.ok(hkWorld.hk.size > 0, 'cycle ' + cycle + ': the refill must have populated the top-k forest');
        assert.ok(ehWorld.eh.bucketCount <= ehWorld.eh.capacity,
            'cycle ' + cycle + ': eh.bucketCount ' + ehWorld.eh.bucketCount + ' must never exceed capacity ' + ehWorld.eh.capacity);
        hkWorld.hk.clear();
        ehWorld.eh.clear();
        assert.equal(hkWorld.hk.size, 0, 'cycle ' + cycle + ': hk.size must return to 0 after clear()');
        assert.equal(ehWorld.eh.bucketCount, 0, 'cycle ' + cycle + ': eh.bucketCount must return to 0 after clear()');
    }
});

/* ============================ re-entrant render ============================= */

test('re-entrant: renderXPrep called twice with no intervening step is byte-identical for every scene', () => {
    const eh = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 1); const ea = createAllocState();
    const ad = createAdWorld(AD_DEFAULT_DELTA, 2); const aa = createAllocState();
    const fd = createFdWorld(FD_DEFAULT_HALFLIFE, 3); const fa = createAllocState();
    const hk = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 4); const ha = createAllocState();
    const sh = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 5); const sha = createAllocState();
    const dd = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD); const dda = createAllocState();
    const sd = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES); const sda = createAllocState();
    const sc = createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 6); const sca = createAllocState();
    const dr = createDrWorld(DR_DEFAULT_K, DR_DEFAULT_HALFLIFE, 7); const dra = createAllocState();
    for (let f = 0; f < 300; f++) {
        stepEh(eh); stepEhOracle(eh, ea);
        stepAd(ad); stepAdOracle(ad, aa);
        stepFd(fd); stepFdOracle(fd, fa);
        stepHk(hk); stepHkOracle(hk, ha);
        stepShll(sh); stepShllOracle(sh, sha);
        stepDd(dd); stepDdOracle(dd, dda);
        stepSld(sd); stepSldOracle(sd, sda);
        stepScm(sc); stepScmOracle(sc, sca);
        stepDr(dr); stepDrOracle(dr, dra);
    }
    for (const [name, render, world, alloc] of [
        ['EH', renderEhPrep, eh, ea], ['ADWIN', renderAdPrep, ad, aa],
        ['FD', renderFdPrep, fd, fa], ['HK', renderHkPrep, hk, ha],
        ['SHLL', renderShllPrep, sh, sha], ['DD', renderDdPrep, dd, dda],
        ['SLD', renderSldPrep, sd, sda], ['SCM', renderScmPrep, sc, sca],
        ['DR', renderDrPrep, dr, dra],
    ]) {
        render(world, alloc);
        const first = Array.from(world.flat);
        render(world, alloc);
        const second = Array.from(world.flat);
        assert.deepStrictEqual(first, second, name + ' renderPrep must be idempotent when nothing streamed between calls');
    }
});

/* ============================ zero-alloc kernel gates ======================= */

// Each stepX + renderXPrep must measure 0 B/op (measureAllocs) and trigger 0 major GC over a long
// run -- the demo's own zero-GC honesty headline, mirroring test/torture.mjs.

function measure0(t, name, warm, step) {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    for (let i = 0; i < warm; i++) step();
    const res = measureAllocs(step, { iterations: 100000, batches: ALLOC_BATCHES });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  ' + name + ' measureAllocs: ' + bpc.toFixed(3) + ' B/call\n');
    assert.equal(Math.max(0, Math.round(bpc)), 0, name + ' must measure 0 B/call, got ' + bpc);
}

test('0-B/op (measureAllocs): stepEh alone measures 0 bytes/call', (t) => {
    const w = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 0x1234);
    measure0(t, 'stepEh', 20000, () => stepEh(w));
});
test('0-B/op (measureAllocs): renderEhPrep alone measures 0 bytes/call', (t) => {
    const w = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 0x1234); const a = createAllocState();
    for (let i = 0; i < 5000; i++) { stepEh(w); stepEhOracle(w, a); }
    measure0(t, 'renderEhPrep', 2000, () => renderEhPrep(w, a));
});
test('0-B/op (measureAllocs): stepAd alone measures 0 bytes/call', (t) => {
    const w = createAdWorld(AD_DEFAULT_DELTA, 0x1234);
    measure0(t, 'stepAd', 40000, () => stepAd(w));
});
test('0-B/op (measureAllocs): renderAdPrep alone measures 0 bytes/call', (t) => {
    const w = createAdWorld(AD_DEFAULT_DELTA, 0x1234); const a = createAllocState();
    for (let i = 0; i < 5000; i++) { stepAd(w); stepAdOracle(w, a); }
    measure0(t, 'renderAdPrep', 2000, () => renderAdPrep(w, a));
});
test('0-B/op (measureAllocs): stepFd alone measures 0 bytes/call', (t) => {
    const w = createFdWorld(FD_DEFAULT_HALFLIFE, 0x1234);
    measure0(t, 'stepFd', 20000, () => stepFd(w));
});
test('0-B/op (measureAllocs): renderFdPrep alone measures 0 bytes/call', (t) => {
    // warm a BOUNDED number of arrivals so the exact-ring recompute stays cheap in the tight loop.
    const w = createFdWorld(FD_DEFAULT_HALFLIFE, 0x1234); const a = createAllocState();
    for (let i = 0; i < 120; i++) { stepFd(w); stepFdOracle(w, a); }
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    for (let i = 0; i < 500; i++) renderFdPrep(w, a);
    const res = measureAllocs(() => renderFdPrep(w, a), { iterations: 20000, batches: 4 });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  renderFdPrep measureAllocs: ' + bpc.toFixed(3) + ' B/call\n');
    assert.equal(Math.max(0, Math.round(bpc)), 0, 'renderFdPrep must measure 0 B/call, got ' + bpc);
});
test('0-B/op (measureAllocs): stepHk alone measures 0 bytes/call', (t) => {
    const w = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x1234);
    measure0(t, 'stepHk', 40000, () => stepHk(w));
});
test('0-B/op (measureAllocs): renderHkPrep alone measures 0 bytes/call', (t) => {
    const w = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x1234); const a = createAllocState();
    for (let i = 0; i < 40; i++) { stepHk(w); stepHkOracle(w, a); }   // moderate Map so forEach stays cheap
    measure0(t, 'renderHkPrep', 300, () => renderHkPrep(w, a));
});

test('0-B/op (measureAllocs): stepShll alone measures 0 bytes/call', (t) => {
    const w = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x1234);
    measure0(t, 'stepShll', 40000, () => stepShll(w));
});
test('0-B/op (measureAllocs): renderShllPrep alone measures 0 bytes/call', (t) => {
    const w = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x1234); const a = createAllocState();
    for (let i = 0; i < 2000; i++) { stepShll(w); stepShllOracle(w, a); }
    measure0(t, 'renderShllPrep', 500, () => renderShllPrep(w, a));
});
test('0-B/op (measureAllocs): stepDd alone measures 0 bytes/call', (t) => {
    const w = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD);
    measure0(t, 'stepDd', 40000, () => stepDd(w));
});
test('0-B/op (measureAllocs): renderDdPrep alone measures 0 bytes/call', (t) => {
    const w = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD); const a = createAllocState();
    for (let i = 0; i < 2000; i++) { stepDd(w); stepDdOracle(w, a); }
    measure0(t, 'renderDdPrep', 500, () => renderDdPrep(w, a));
});
test('0-B/op (measureAllocs): stepSld alone measures 0 bytes/call', (t) => {
    const w = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES);
    measure0(t, 'stepSld', 40000, () => stepSld(w));
});
test('0-B/op (measureAllocs): renderSldPrep alone measures 0 bytes/call', (t) => {
    // warm a BOUNDED number of arrivals so the insertion-sort-into-preallocated-buffer stays cheap
    // (the sort is O(live^2); the live-demo render path is 10Hz so this only bounds the tight measure loop).
    const w = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES); const a = createAllocState();
    for (let i = 0; i < 8; i++) { stepSld(w); stepSldOracle(w, a); }
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    for (let i = 0; i < 500; i++) renderSldPrep(w, a);
    const res = measureAllocs(() => renderSldPrep(w, a), { iterations: 10000, batches: FAST ? 1 : 3 });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  renderSldPrep measureAllocs: ' + bpc.toFixed(3) + ' B/call\n');
    assert.equal(Math.max(0, Math.round(bpc)), 0, 'renderSldPrep must measure 0 B/call, got ' + bpc);
});
test('0-B/op (measureAllocs): stepScm alone measures 0 bytes/call', (t) => {
    const w = createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 0x1234);
    measure0(t, 'stepScm', 40000, () => stepScm(w));
});
test('0-B/op (measureAllocs): renderScmPrep alone measures 0 bytes/call', (t) => {
    const w = createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 0x1234); const a = createAllocState();
    for (let i = 0; i < 40; i++) { stepScm(w); stepScmOracle(w, a); }   // bounded ring so the per-key scan stays cheap
    measure0(t, 'renderScmPrep', 500, () => renderScmPrep(w, a));
});
test('0-B/op (measureAllocs): stepDr alone measures 0 bytes/call', (t) => {
    const w = createDrWorld(DR_DEFAULT_K, DR_DEFAULT_HALFLIFE, 0x1234);
    measure0(t, 'stepDr', 40000, () => stepDr(w));
});
test('0-B/op (measureAllocs): renderDrPrep alone measures 0 bytes/call', (t) => {
    const w = createDrWorld(DR_DEFAULT_K, DR_DEFAULT_HALFLIFE, 0x1234); const a = createAllocState();
    for (let i = 0; i < 2000; i++) { stepDr(w); stepDrOracle(w, a); }
    measure0(t, 'renderDrPrep', 500, () => renderDrPrep(w, a));
});

// Per-scene combined 0-major-GC gate: stepX every frame + renderXPrep every 64th over ~200k stepX
// ops (the DEMO.md "sketch path stays zero-GC while it runs" claim), mirroring test/torture.mjs's
// `checkNoGc(s, { maxMajor: 0 })`. The oracle steps are NOT in this loop -- they are the
// allowed-to-allocate contrast, and including them would poison the measurement (the planner's RISK).
async function gcGate(t, name, world, alloc, step, render) {
    if (FAST) { t.skip('fast (demo:check skips the 200k-frame lanes)'); return; }
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    for (let i = 0; i < 20000; i++) { step(); if ((i & 63) === 0) render(world, alloc); }
    global.gc(); global.gc();
    const gc = new GcProfiler().start();
    const HOT = 200000;
    let sink = 0;
    for (let i = 0; i < HOT; i++) {
        sink = (sink + step()) | 0;
        if ((i & 63) === 0) sink = (sink + (render(world, alloc) | 0)) | 0;
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(Number.isFinite(sink), 'sink keeps the swept work live');
    await new Promise((r) => setTimeout(r, 50));   // GC entries arrive asynchronously
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
    gc.stop();
    process.stdout.write('  ' + name + ' sketch-path gate: gc major=' + s.gc.major + ' minor=' + s.gc.minor +
        ' (reported, not gated) maxMs=' + s.gc.maxMs.toFixed(2) + '\n');
    assert.equal(s.gc.major, 0, name + ' 200k sketch-path frames must trigger 0 major GC, got ' + s.gc.major);
    assert.ok(report.ok, name + ' checkNoGc must report ok: ' + JSON.stringify(report.violations));
    assert.equal(alloc.sketchCount, 0, name + ' sketch-path owned allocation counter must stay pinned at 0');
    assert.equal(world.flat[world.__sketchAllocIdx], 0, name + ' flat sketch-alloc slot must read 0');
}

test('0-major-GC: EH sketch path (stepEh + renderEhPrep) over 200k frames', async (t) => {
    const w = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 0x1A2B); const a = createAllocState();
    w.__sketchAllocIdx = E_SKETCH_ALLOC;
    await gcGate(t, 'EH', w, a, () => stepEh(w), renderEhPrep);
});
test('0-major-GC: ADWIN sketch path (stepAd + renderAdPrep) over 200k frames', async (t) => {
    const w = createAdWorld(AD_DEFAULT_DELTA, 0x1A2B); const a = createAllocState();
    w.__sketchAllocIdx = A_SKETCH_ALLOC;
    await gcGate(t, 'ADWIN', w, a, () => stepAd(w), renderAdPrep);
});
test('0-major-GC: FD sketch path (stepFd + renderFdPrep) over 200k frames', async (t) => {
    const w = createFdWorld(FD_DEFAULT_HALFLIFE, 0x1A2B); const a = createAllocState();
    // seed the exact ring once so renderFdPrep has samples; the hot loop never calls the oracle step.
    for (let i = 0; i < 120; i++) stepFdOracle(w, a);
    a.oracleCount = 0;   // reset the contrast counter after seeding (sketchCount stays 0)
    w.__sketchAllocIdx = D_SKETCH_ALLOC;
    await gcGate(t, 'FD', w, a, () => stepFd(w), renderFdPrep);
});
test('0-major-GC: HK sketch path (stepHk + renderHkPrep) over 200k frames', async (t) => {
    const w = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x1A2B); const a = createAllocState();
    for (let i = 0; i < 40; i++) stepHkOracle(w, a);   // populate the Map once (read-only in the hot loop)
    a.oracleCount = 0;
    w.__sketchAllocIdx = H_SKETCH_ALLOC;
    await gcGate(t, 'HK', w, a, () => stepHk(w), renderHkPrep);
});

test('0-major-GC: SHLL sketch path (stepShll + renderShllPrep) over 200k frames', async (t) => {
    const w = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x1A2B); const a = createAllocState();
    for (let i = 0; i < 40; i++) { stepShll(w); stepShllOracle(w, a); }
    a.oracleCount = 0;
    w.__sketchAllocIdx = S_SKETCH_ALLOC;
    await gcGate(t, 'SHLL', w, a, () => stepShll(w), renderShllPrep);
});
test('0-major-GC: DD sketch path (stepDd + renderDdPrep) over 200k frames', async (t) => {
    const w = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD); const a = createAllocState();
    w.__sketchAllocIdx = G_SKETCH_ALLOC;
    await gcGate(t, 'DD', w, a, () => stepDd(w), renderDdPrep);
});
test('0-major-GC: SLD sketch path (stepSld + renderSldPrep) over 200k frames', async (t) => {
    const w = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES); const a = createAllocState();
    for (let i = 0; i < 40; i++) { stepSld(w); stepSldOracle(w, a); }
    a.oracleCount = 0;
    w.__sketchAllocIdx = Q_SKETCH_ALLOC;
    await gcGate(t, 'SLD', w, a, () => stepSld(w), renderSldPrep);
});
test('0-major-GC: SCM sketch path (stepScm + renderScmPrep) over 200k frames', async (t) => {
    const w = createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 0x1A2B); const a = createAllocState();
    for (let i = 0; i < 40; i++) { stepScm(w); stepScmOracle(w, a); }
    a.oracleCount = 0;
    w.__sketchAllocIdx = C_SKETCH_ALLOC;
    await gcGate(t, 'SCM', w, a, () => stepScm(w), renderScmPrep);
});
test('0-major-GC: DR sketch path (stepDr + renderDrPrep) over 200k frames', async (t) => {
    const w = createDrWorld(DR_DEFAULT_K, DR_DEFAULT_HALFLIFE, 0x1A2B); const a = createAllocState();
    w.__sketchAllocIdx = R_SKETCH_ALLOC;
    await gcGate(t, 'DR', w, a, () => stepDr(w), renderDrPrep);
});

/* ============================ non-vacuous contrast ========================== */

test('contrast: the HeavyKeeper exact-Map oracle DOES allocate -- proving the 0-B/op sketch gates are not vacuous', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const w = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x5F5F);
    const a = createAllocState();
    for (let f = 0; f < 20; f++) { stepHk(w); stepHkOracle(w, a); }   // warm
    global.gc(); global.gc();
    const before = process.memoryUsage().heapUsed;
    const oracleBefore = a.oracleCount;
    for (let f = 0; f < 400; f++) { stepHk(w); stepHkOracle(w, a); }
    global.gc();
    const after = process.memoryUsage().heapUsed;
    process.stdout.write('  contrast stepHkOracle: alloc=' + ((after - before) / 400).toFixed(1) +
        ' B/op (oracleCount delta=' + (a.oracleCount - oracleBefore) + ')\n');
    assert.ok(a.oracleCount > oracleBefore, 'the exact-Map oracle must have recorded real distinct-key allocations');
});
