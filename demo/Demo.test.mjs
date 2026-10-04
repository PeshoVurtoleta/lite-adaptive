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
    createEhWorld, stepEh, stepEhGuarded, stepEhOracle, renderEhPrep, ehStraddleInto,
    EH_DEFAULT_W, EH_DEFAULT_EPS, EH_STREAM_LEN, EH_BUCKET_BYTES, EH_DENSE_W,
    E_COUNT, E_TRUE, E_RELERR, E_EPS, E_FRAC, E_W, E_BUCKETS, E_CAP, E_RING_BYTES, E_SKETCH_ALLOC, E_ORACLE_ALLOC,
    E_MAXCOUNT, E_CEIL, E_POP, E_SUM, E_TRUESUM, E_STRADDLE, E_SUMFRAC, E_SUMRELEPS, E_FAILED,
    // Scene 02 -- ADWIN
    createAdWorld, stepAd, stepAdGhost, stepAdOracle, renderAdPrep,
    AD_DEFAULT_DELTA, AD_MEAN_BAND, AD_MEAN_LO, AD_MEAN_HI, AD_REGIME,
    AD_JUMP, AD_JUMP_AT, AD_PLUS1_AT, AD_VALUES_PER_FRAME, AD_PRESET_JITTER, AD_LIVER_SCAN,
    A_MEAN, A_TRUEMEAN, A_CUMMEAN, A_WIDTH, A_DELTA, A_MEANERR, A_CUTS, A_N, A_SKETCH_ALLOC, A_ORACLE_ALLOC,
    A_OFFSET, A_LIVER, A_GHOSTR, A_LASTCUT,
    // Scene 03 -- ForwardDecay
    createFdWorld, stepFd, stepFdOracle, renderFdPrep, fdOracle,
    FD_DEFAULT_HALFLIFE, FD_TOL, FD_MAX_HALFLIFE, FD_ORACLE_LEN,
    D_COUNT, D_SUM, D_MEAN, D_RELERR, D_TOL, D_LANDMARK, D_REBASED, D_N, D_SKETCH_ALLOC, D_ORACLE_ALLOC,
    // Scene 04 -- HeavyKeeper
    createHkWorld, stepHk, stepHkOracle, renderHkPrep,
    HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, HK_DRIFT_OFFSET, HK_SS_MULT,
    HK_KEY_SMALL, HK_KEY_BIG, HK_KEY_NEG, HK_BIG_OFFSET, HK_WEIGHT_MAX,
    H_RECALL, H_TRUEHH, H_FOUND, H_MAXOVER, H_BRACKETOK, H_HKERR, H_SSERR, H_MARQUEEOK, H_SIZE, H_N,
    H_MAXCOUNT, H_KEYMODE, H_WEIGHT, H_SAT, H_SKETCH_ALLOC, H_ORACLE_ALLOC, H_THRESH, H_ERRBOUND,
    // Scene 05 -- SlidingHyperLogLog
    createShllWorld, stepShll, stepShllOracle, renderShllPrep,
    SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, SHLL_KEYS_PER_FRAME, SHLL_SIGMA_MULT, SHLL_QEVERY_MAX,
    S_EST, S_TRUE, S_RELERR, S_GATE, S_FRAC, S_M, S_DEGRADED, S_N, S_SKETCH_ALLOC, S_ORACLE_ALLOC,
    S_OVF_A, S_OVF_B, S_QEVERY,
    // Scene 06 -- DriftDetector
    createDdWorld, stepDd, stepDdOracle, renderDdPrep,
    DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD, DD_REGIME,
    G_PH_STAT, G_PH_THRESH, G_CU_STAT, G_CU_THRESH, G_PH_FIRES, G_CU_FIRES, G_CP, G_N,
    G_SKETCH_ALLOC, G_ORACLE_ALLOC,
    G_PHL_STAT, G_CUL_STAT, G_PH_MEAN, G_CU_MEAN, G_PHL_FIRES, G_CUL_FIRES, G_PHL_FIRED, G_CUL_FIRED, G_PHL_LASTIDX, G_PHL_LASTDIR,
    G_CUL_LASTIDX, G_CUL_LASTDIR, G_PHL_LATCHED, G_CUL_LATCHED, G_LATCH_ON,
    // Scene 07 -- SlidingDDSketch
    createSldWorld, stepSld, stepSldOracle, renderSldPrep,
    SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, SLD_VALUES_PER_FRAME,
    SLD_MODE_DEFAULT, SLD_MODE_STRICT, SLD_MODE_RANGE, SLD_RANGE_MIN, SLD_RANGE_MAX,
    Q_P50, Q_P90, Q_P99, Q_P50T, Q_P90T, Q_P99T, Q_MAXREL, Q_FRAC, Q_ALPHA, Q_COUNT, Q_LIVE, Q_EDGE, Q_N, Q_SKETCH_ALLOC, Q_ORACLE_ALLOC,
    Q_TRUEW, Q_CNT_CURSOR, Q_COVMIN, Q_COVMAX, Q_STRICT, Q_RANGEMIN, Q_RANGEMAX, Q_REJECTED, Q_MODE,
    // Scene 08 -- SlidingCountMin
    createScmWorld, stepScm, stepScmOracle, renderScmPrep,
    SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, SCM_KEYS_PER_FRAME, SCM_TRACKED, SCM_STRIDE,
    C_BOUNDOK, C_NLIVE, C_SATURATED, C_N, C_SKETCH_ALLOC, C_ORACLE_ALLOC,
    C_TOTAL, C_TOTALOK, C_HEAVY, C_ORACLE_BYTES, SCM_HEAVY_COUNT, scmContracts,
    // Scene 09 -- DecayedReservoir
    createDrWorld, stepDr, stepDrOracle, renderDrPrep,
    DR_DEFAULT_K, DR_DEFAULT_HALFLIFE, DR_ADDS_PER_FRAME,
    R_SIZE, R_K, R_MEANAGE, R_RECENCYFRAC, R_N, R_SKETCH_ALLOC, R_ORACLE_ALLOC,
    // Scene 10 -- SlidingAggregate
    createSaWorld, stepSa, stepSaOracle, renderSaPrep, renderSaEhPrep, SA_DEFAULT_W, SA_DEFAULT_PANES, SA_DT, SA_EVENTS_PER_FRAME,
    SA_SPIKE_MULT, SA_EH_EPS, L_COUNT, L_SUM, L_MEAN, L_MIN, L_MAX, L_TCOUNT, L_TSUM, L_TMEAN, L_TMIN, L_TMAX,
    L_EXACT, L_TSUMW, L_EHSUM, L_EHMEAN, L_EHREL, L_EHRELMAX,
    // S11 (D8) -- the Chromium-only key-magnitude lane
    runKeyMagLane, keyMagText, kmAggregate, KM_CONTROL_MIN, KM_MIN_CLEAN, KM_MEMBERS, KM_CLASSES, KM_WINDOW_W,
    keyMagClass, KM_CLEAN_MAX, kmDidWork, KM_NEG_BASE,
} from './kernels.mjs';

// Dev-only peer (already a devDependency -- the same tool test/torture.mjs uses). Used ONLY by the
// 0-B/op assertions below; each such test skips cleanly (t.skip) without --expose-gc.
import { measureAllocs } from '@zakkster/lite-gc-profiler';
// The shared STEADY-STATE probe (D3/D4 blocker 2): a pinned-semi-space child-process lane runner that
// SEES a transient box measureAllocs cannot. Demo tests may import package-internal test helpers.
import { runDemoLane } from './DemoProbe.mjs';
// The per-scene 0-major-GC lanes run one per FRESH child process (see gcGate below).
import { runGcLane } from './DemoGcLane.mjs';

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

test('HK recall is NaN ("n/a"), NOT a false 1.0, when there are NO true heavy hitters yet (null is not zero)', () => {
    // A fresh world before any oracle mass: N == 0, the Map is empty, so recallTrue == 0. Recall is
    // UNDEFINED (0/0), not a perfect 1.0. renderHkPrep must write NaN -> hkTick / hkWitDraw render "n/a".
    const world = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x1357);
    const a = createAllocState();
    renderHkPrep(world, a);   // no stepHkOracle: the exact Map has no heavy hitters
    assert.equal(world.flat[H_TRUEHH], 0, 'precondition: zero true heavy hitters');
    assert.ok(Number.isNaN(world.flat[H_RECALL]), 'recall must be NaN (n/a) with no true HH, not a false 1.0');
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
    assert.equal(world.flat[S_EST], world.slD.count(), 'displayed estimate must be the shipped display-twin count()');
    assert.equal(world.slD.count(), world.sl.count(), 'the display twin and slA agree on the identical stream (F8 non-destructive count)');
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

test('DD into faithfulness (1.11.0): every slot renderDdPrep reads through dd.into(row) is Object.is the shipped getter -- fresh (lastDriftIndex / lastDirection NaN) and after fires, all four detectors', () => {
    const world = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD, true);
    const a = createAllocState();
    const check = (label) => {
        renderDdPrep(world, a);
        const f = world.flat, ph = world.ph, cu = world.cu, phL = world.phL, cuL = world.cuL;
        const pairs = [
            [G_PH_STAT, ph.statistic, 'ph.statistic'], [G_CU_STAT, cu.statistic, 'cu.statistic'],
            [G_PH_MEAN, ph.mean, 'ph.mean'], [G_CU_MEAN, cu.mean, 'cu.mean'],
            [G_PHL_STAT, phL.statistic, 'phL.statistic'], [G_CUL_STAT, cuL.statistic, 'cuL.statistic'],
            [G_PHL_LASTIDX, phL.lastDriftIndex, 'phL.lastDriftIndex'], [G_PHL_LASTDIR, phL.lastDirection, 'phL.lastDirection'],
            [G_CUL_LASTIDX, cuL.lastDriftIndex, 'cuL.lastDriftIndex'], [G_CUL_LASTDIR, cuL.lastDirection, 'cuL.lastDirection'],
        ];
        for (const [slot, want, name] of pairs) assert.ok(Object.is(f[slot], want), label + ': slot ' + slot + ' = ' + f[slot] + ' must be Object.is ' + name + ' = ' + want);
    };
    check('fresh');
    assert.ok(Number.isNaN(world.flat[G_PHL_LASTIDX]), 'fresh latched PH: lastDriftIndex must render NaN (null is not zero)');
    for (let f = 0; f < 1600; f++) { stepDd(world); stepDdOracle(world, a); }
    assert.ok(world.phLFires > 0 && world.cuLFires > 0, 'non-vacuous: both latched detectors must have fired');
    check('after fires');
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
 * D5 (1.8.0) -- DriftDetector latch: latched PH/CUSUM twins beside the unlatched ones on ONE signal.
 * The oracle is INDEPENDENT: the injected changepoints + a from-spec known-answer latch reference (fire
 * once per regime, re-arm at threshold/2), never the kernel's own outputs (requirement 7).
 * ============================================================================================= */

test('D5 DD faithfulness: latched-twin readouts equal the shipped latch / lastDriftIndex / lastDirection / latched getters; the twins are DISTINCT instances built with latch:true', () => {
    const world = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD, true);
    const a = createAllocState();
    // drive past several regime boundaries so the latched detectors have fired (non-vacuous)
    for (let f = 0; f < 600; f++) { stepDd(world); stepDdOracle(world, a); }
    renderDdPrep(world, a);
    const f = world.flat;
    // twins-from-one-instance mutant: the latched detectors MUST be separate objects with latch:true.
    assert.ok(world.phL !== world.ph && world.cuL !== world.cu, 'latched twins must be DISTINCT instances');
    assert.equal(world.phL.latch, true, 'phL must be built with latch:true (latch-option-ignored mutant)');
    assert.equal(world.cuL.latch, true, 'cuL must be built with latch:true');
    assert.equal(world.ph.latch, false, 'the unlatched ph must stay latch:false (1.x byte-identical path)');
    // faithfulness: every displayed latched number equals the shipped getter (lastDirection-sign-flip mutant).
    assert.equal(f[G_PHL_LASTDIR], world.phL.lastDirection, 'G_PHL_LASTDIR must be the shipped phL.lastDirection');
    assert.equal(f[G_CUL_LASTDIR], world.cuL.lastDirection, 'G_CUL_LASTDIR must be the shipped cuL.lastDirection');
    assert.equal(f[G_PHL_LASTIDX], world.phL.lastDriftIndex, 'G_PHL_LASTIDX must be the shipped phL.lastDriftIndex');
    assert.equal(f[G_CUL_LASTIDX], world.cuL.lastDriftIndex, 'G_CUL_LASTIDX must be the shipped cuL.lastDriftIndex');
    assert.equal(f[G_PHL_LATCHED], world.phL.latched ? 1 : 0, 'G_PHL_LATCHED must be the shipped phL.latched');
    assert.equal(f[G_PHL_FIRES], world.phLFires, 'G_PHL_FIRES must be the world latched-PH fire count');
    assert.equal(f[G_CUL_FIRES], world.cuLFires, 'G_CUL_FIRES must be the world latched-CUSUM fire count');
});

test('D5 DD witness: the latched twins fire FAR fewer times than the unlatched storm on the sustained regimes (latch-option-ignored mutant goes RED)', () => {
    const world = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD, true);
    const a = createAllocState();
    // run well past several full LO/HI regimes so the unlatched CUSUM storms and the latched fires once each.
    for (let f = 0; f < 1200; f++) { stepDd(world); stepDdOracle(world, a); }
    renderDdPrep(world, a);
    assert.ok(world.cp >= 2, 'the stream must cross >= 2 ground-truth changepoints (non-vacuous), got ' + world.cp);
    assert.ok(world.cuFires > 0 && world.cuLFires > 0, 'both CUSUM channels must have fired');
    // the whole point of latch: ONE fire per regime vs the storm. If phL/cuL were built without latch,
    // cuLFires would EQUAL cuFires (storm) -> this fails.
    assert.ok(world.cuLFires * 5 < world.cuFires, 'latched CUSUM (' + world.cuLFires +
        ') must fire FAR fewer than the unlatched storm (' + world.cuFires + ')');
    assert.ok(world.phLFires <= world.phFires, 'latched PH (' + world.phLFires + ') must not exceed unlatched (' + world.phFires + ')');
});

test('D5 DD from-spec latch reference: a fresh latched CUSUM/PH matches the ADR-0007 known answers (fire once per regime, direction, re-arm at threshold/2) -- catches the re-arm and sign mutants', () => {
    // A from-spec REFERENCE (the settled contract, NOT the kernel's output): sustained +10 -> ONE fire,
    // lastDirection +1, statistic CLAMPED at threshold; up/down -> TWO fires (dir +1 then -1); a re-arm at
    // threshold (mutant) would over-fire the sustained run, and a sign flip changes lastDirection.
    function run(mode, opts, stream) {
        const dd = new DriftDetector(mode, opts);
        let fires = 0, firstDir = NaN, firstIdx = NaN;
        for (let i = 0; i < stream.length; i++) if (dd.add(stream[i])) { if (fires === 0) { firstDir = dd.lastDirection; firstIdx = dd.lastDriftIndex; } fires++; }
        return { fires, firstDir, firstIdx, latched: dd.latched, stat: dd.statistic, li: dd.lastDriftIndex, dir: dd.lastDirection };
    }
    const CU = { delta: 0.5, threshold: 8, target: 0 };
    const up = new Array(5000).fill(10);
    const sus = run(1, { ...CU, latch: true }, up);
    assert.equal(sus.fires, 1, 'sustained +10x5000: latched CUSUM must fire EXACTLY once (re-arm-at-threshold mutant over-fires)');
    assert.equal(sus.firstDir, 1, 'sustained +10: lastDirection must be +1 (upward) -- sign-flip mutant fails');
    assert.equal(sus.stat, 8, 'sustained: the statistic must CLAMP at threshold (bounded latch)');
    assert.equal(sus.latched, true, 'the detector must stay LATCHED on the sustained regime (no re-fire)');
    // the unlatched control storms (proves the latch is load-bearing, not a dead detector)
    assert.equal(run(1, { ...CU, latch: false }, up).fires, 5000, 'unlatched CUSUM must storm (5000 fires) -- the latch control');
    const upDown = Array.from({ length: 5000 }, (_, i) => (i < 2500 ? 10 : -10));
    const ud = run(1, { ...CU, latch: true }, upDown);
    assert.equal(ud.fires, 2, 'up/down: latched CUSUM must fire exactly twice (re-arm at threshold/2 then reverse)');
    assert.equal(ud.dir, -1, 'up/down: the LAST direction must be -1 (downward reversal) -- re-arm + sign proof');
    // RE-ARM LEVEL teeth: fire + CLAMP at threshold, then HOLD the statistic in the (threshold/2, threshold]
    // band with small x=0 decay steps (gP falls from 8 toward 4 but not below), then bump up again. A
    // correct re-arm at threshold/2 stays LATCHED the whole time (1 fire); a mutant that re-arms at
    // threshold re-arms on the first decay step (gP < 8) and re-fires on the bump (2 fires) -> RED.
    const holdInBand = [];
    for (let i = 0; i < 200; i++) holdInBand.push(10);
    for (let i = 0; i < 6; i++) holdInBand.push(0);
    for (let i = 0; i < 200; i++) holdInBand.push(10);
    const hb = run(1, { ...CU, latch: true }, holdInBand);
    assert.equal(hb.fires, 1, 'hold-in-band: a threshold/2 re-arm stays LATCHED through the (threshold/2, threshold] decay -> exactly ONE fire (a re-arm-at-threshold mutant re-fires -> 2)');
});

test('D5 DD latch fail-closed: a non-boolean latch throws a tagged [lite-adaptive] error BEFORE any allocation; true/false/undefined construct', () => {
    for (const bad of [1, 0, 'true', 'yes', NaN, {}]) {
        // note: null falls back to the default (documented), so it is NOT in the bad set.
        let w;
        assert.throws(() => { w = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD, bad); },
            /\[lite-adaptive\]/, 'latch ' + String(bad) + ' must throw the tagged error');
        assert.equal(w, undefined, 'no world is constructed when latch ' + String(bad) + ' is rejected');
    }
    assert.doesNotThrow(() => createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD, true), 'latch true must construct');
    assert.doesNotThrow(() => createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD, false), 'latch false must construct');
    assert.doesNotThrow(() => createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD), 'the 2-arg default (latch off) must construct');
});

test('D5 DD 0-B/op: stepDd (4 detectors) measures 0 B/call (measureAllocs); renderDdPrep re-derives every latched slot', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const w = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD, true);
    measure0(t, 'stepDd 4-detector', 40000, () => stepDd(w));
});

/* from-spec latched-fire references (written from the 1.8.0 _fired spec + decisions/0007, NEVER from
 * kernel outputs): PH online-mean reference reset AT the fire, up/down gaps, fire when a gap > threshold,
 * one fire per latch, re-arm (keeping the mean) when the latched gap < threshold/2, an opposite single-item
 * gap > threshold fires; CUSUM the same over a FIXED target with a full reset on re-arm. */
function ddRefPH(stream, mask, n, delta, th) {
    let nn = 0, mean = 0, gP = 0, gN = 0, mMin = 0, mMax = 0, lvl = th, lDir = 0, s0 = 0; const half = th / 2; const fires = [];
    for (let k = 0; k < n; k++) {
        const x = stream[k & mask]; s0++; nn++; mean += (x - mean) / nn;
        const dev = x - mean; gP += dev - delta; gN += dev + delta;
        if (gP < mMin) mMin = gP; if (gN > mMax) mMax = gN;
        if (!((gP - mMin > lvl) || (mMax - gN > lvl))) continue;   // no trip -> no fire this item
        const up = gP - mMin, dn = mMax - gN, dir = up >= dn ? 1 : -1;
        if (lDir === 0) { fires.push([s0 - 1, dir]); lDir = dir; lvl = -Infinity; nn = 0; mean = 0; if (dir === 1) gP = mMin + th; else gN = mMax - th; continue; }
        const lg = lDir === 1 ? up : dn, og = lDir === 1 ? dn : up;
        if (og > th) { const nd = -lDir; fires.push([s0 - 1, nd]); lDir = nd; nn = 0; mean = 0; if (nd === 1) gP = mMin + th; else gN = mMax - th; continue; }
        if (lg < half) { gP = 0; gN = 0; mMin = 0; mMax = 0; lDir = 0; lvl = th; continue; }   // re-arm (keep mean)
        if (lg > th) { if (lDir === 1) gP = mMin + th; else gN = mMax - th; }                    // clamp only if still above
    }
    return fires;
}
function ddRefCU(stream, mask, n, delta, th, target) {
    let gP = 0, gN = 0, lvl = th, lDir = 0, s0 = 0; const half = th / 2; const fires = [];
    for (let k = 0; k < n; k++) {
        const x = stream[k & mask]; s0++;
        gP = Math.max(0, gP + (x - target) - delta); gN = Math.max(0, gN - (x - target) - delta);
        if (!((gP > lvl) || (gN > lvl))) continue;
        const up = gP, dn = gN, dir = up >= dn ? 1 : -1;
        if (lDir === 0) { fires.push([s0 - 1, dir]); lDir = dir; lvl = -Infinity; if (dir === 1) gP = th; else gN = th; continue; }
        const lg = lDir === 1 ? up : dn, og = lDir === 1 ? dn : up;
        if (og > th) { const nd = -lDir; fires.push([s0 - 1, nd]); lDir = nd; if (nd === 1) gP = th; else gN = th; continue; }
        if (lg < half) { gP = 0; gN = 0; lDir = 0; lvl = th; continue; }   // full reset on re-arm (fixed target)
        if (lg > th) { if (lDir === 1) gP = th; else gN = th; }
    }
    return fires;
}
function ddLibFires(mode, opts, stream, mask, n) {
    const d = new DriftDetector(mode, opts); const f = [];
    for (let k = 0; k < n; k++) if (d.addFrom(stream, k & mask)) f.push([k, d.lastDirection]);
    return f;
}
function ddPerRegime(fires, regime, regimes) {
    const cnt = new Int32Array(regimes);
    for (const [k] of fires) { const r = (k / regime) | 0; if (r < regimes) cnt[r]++; }
    return cnt;
}

test('D5 DD latched fires MATCH a from-spec state machine (PH + CUSUM) exactly on the demo stream -- the fire (index, direction) sequence equals the reference written from the spec, never from kernel output', () => {
    const world = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD, true);
    const stream = world.stream, mask = world.streamMask, N = stream.length * 2;   // two laps of the reused stream
    const delta = DD_DEFAULT_DELTA, th = DD_DEFAULT_THRESHOLD, target = 0;
    const phL = ddLibFires(0, { delta, threshold: th, latch: true }, stream, mask, N);
    const cuL = ddLibFires(1, { delta, threshold: th, target, latch: true }, stream, mask, N);
    const refPH = ddRefPH(stream, mask, N, delta, th);
    const refCU = ddRefCU(stream, mask, N, delta, th, target);
    // non-vacuous: the stream actually drives many latched fires.
    assert.ok(phL.length > 20 && cuL.length > 10, 'the demo stream must drive a meaningful number of latched fires, got PH ' + phL.length + ' CU ' + cuL.length);
    // A single-item off-by-one or a wrong direction anywhere -> the join differs -> RED (teeth).
    assert.equal(phL.map((x) => x.join(':')).join(','), refPH.map((x) => x.join(':')).join(','),
        'latched PH fire (index, dir) sequence must equal the from-spec reference');
    assert.equal(cuL.map((x) => x.join(':')).join(','), refCU.map((x) => x.join(':')).join(','),
        'latched CUSUM fire (index, dir) sequence must equal the from-spec reference');
});

test('D5 DD per-regime reality: latched PH fires 1..4 times per regime and latched CUSUM fires 0..4 (0 on the HI->LO steps -- fixed-target property), NOT "one per regime"; both dwarfed by the unlatched CUSUM storm', () => {
    const world = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD, true);
    const stream = world.stream, mask = world.streamMask, N = stream.length * 2;
    const delta = DD_DEFAULT_DELTA, th = DD_DEFAULT_THRESHOLD, target = 0;
    const regimes = (N / DD_REGIME) | 0;
    const phL = ddLibFires(0, { delta, threshold: th, latch: true }, stream, mask, N);
    const cuL = ddLibFires(1, { delta, threshold: th, target, latch: true }, stream, mask, N);
    const cuU = ddLibFires(1, { delta, threshold: th, target }, stream, mask, N);   // the unlatched CUSUM storm
    const phCnt = ddPerRegime(phL, DD_REGIME, regimes), cuCnt = ddPerRegime(cuL, DD_REGIME, regimes);
    // regimes 1..regimes-1 are full (regime 0 is a warmup edge); measure the steady-state per-regime counts.
    let phMax = 0, phMulti = 0, cuMax = 0, cuZero = 0;
    for (let r = 1; r < regimes; r++) {
        if (phCnt[r] > phMax) phMax = phCnt[r];
        if (phCnt[r] > 1) phMulti++;
        if (cuCnt[r] > cuMax) cuMax = cuCnt[r];
        if (cuCnt[r] === 0) cuZero++;
    }
    // the "ONE fire per regime" claim is FALSE: latched PH fires MORE than once in several regimes.
    assert.ok(phMulti > 0, 'latched PH must fire MORE than once in at least one regime (disproves "one per regime"), multi-fire regimes ' + phMulti);
    assert.ok(phMax >= 1 && phMax <= 4, 'latched PH per-regime fires must be bounded in [1, 4], max ' + phMax);
    // latched CUSUM fires 0 times on the HI->LO steps (a fixed-target property) and up to 4 elsewhere.
    assert.ok(cuZero > 0, 'latched CUSUM must fire 0 times in at least one regime (HI->LO fixed-target property), zero-fire regimes ' + cuZero);
    assert.ok(cuMax >= 1 && cuMax <= 4, 'latched CUSUM per-regime fires must be bounded in [1, 4], max ' + cuMax);
    // the storm contrast is real for CUSUM: the unlatched detector fires two orders of magnitude more.
    assert.ok(cuU.length > cuL.length * 100, 'the unlatched CUSUM storm (' + cuU.length + ') must dwarf the latched channel (' + cuL.length + ')');
});

/* =============================================================================================
 * D6 (1.8.0) -- SlidingDDSketch B+1 covered span vs the TRUE window, 3-way strict / range toggle.
 * Two INDEPENDENT oracles: the covered-span sorted multiset (quantile rel <= alpha) and the TRUE
 * (now-W, now] window count (the F7 lower-bound cursor). The render reads through quantileInto.
 * ============================================================================================= */

test('D6 SLD faithfulness: covered span, count cursor, strict / rangeMin / rangeMax / rejected readouts equal the shipped getters; the count oracle is the TRUE window (not the covered span)', () => {
    const world = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, SLD_MODE_RANGE);
    const a = createAllocState();
    for (let f = 0; f < 300; f++) { stepSld(world); stepSldOracle(world, a); }
    renderSldPrep(world, a);
    const f = world.flat, sd = world.sd;
    assert.equal(f[Q_STRICT], sd.strict ? 1 : 0, 'Q_STRICT must be the shipped sd.strict');
    assert.equal(f[Q_RANGEMIN], sd.rangeMin, 'Q_RANGEMIN must be the shipped sd.rangeMin');
    assert.equal(f[Q_RANGEMAX], sd.rangeMax, 'Q_RANGEMAX must be the shipped sd.rangeMax');
    assert.equal(sd.rangeMin, SLD_RANGE_MIN, 'range mode: sd.rangeMin must be the declared floor');
    assert.equal(sd.rangeMax, SLD_RANGE_MAX, 'range mode: sd.rangeMax must be the declared ceiling');
    assert.equal(f[Q_MODE], SLD_MODE_RANGE, 'Q_MODE must be the demo mode selector');
    assert.equal(f[Q_COVMIN], sd.W, 'Q_COVMIN must be W (the full window is always covered)');
    assert.equal(f[Q_COVMAX], sd.W + sd.W / sd.panes, 'Q_COVMAX must be W + W/panes (over-covered by <= one pane)');
    // the count cursor uses the TRUE-window trueW, NOT the covered-span count. A covered-span oracle would
    // make Q_TRUEW == Q_LIVE (the covered count) so the cursor would read ~1 exactly and hide under-coverage.
    assert.ok(f[Q_TRUEW] <= f[Q_LIVE], 'true(W) (' + f[Q_TRUEW] + ') must be <= the covered-span count (' + f[Q_LIVE] +
        ') -- the cursor oracle is the TRUE window, not the covered span');
    assert.equal(f[Q_COUNT], sd.count(), 'Q_COUNT must be the shipped sd.count()');
});

test('D6 SLD F7 cursor: sd.count() >= true(W) on 100% of queries (count() / true(W) never < 1) over a long run', () => {
    const world = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, SLD_MODE_DEFAULT);
    const a = createAllocState();
    const fpl = Math.ceil(SLD_DEFAULT_W / SLD_VALUES_PER_FRAME);
    const paneW = SLD_DEFAULT_W / SLD_DEFAULT_PANES;
    let minCursor = Infinity, maxGap = 0, checks = 0;
    for (let f = 0; f < fpl * 30; f++) {
        stepSld(world); stepSldOracle(world, a);
        if (f > fpl) {
            renderSldPrep(world, a);
            const c = world.flat[Q_CNT_CURSOR];
            if (c < minCursor) minCursor = c;
            const gap = world.flat[Q_COUNT] - world.flat[Q_TRUEW];   // over-coverage in items (count() - true(W))
            if (gap > maxGap) maxGap = gap;
            checks++;
        }
    }
    assert.ok(checks > 500, 'the F7 cursor must be sampled enough times (non-vacuous), got ' + checks);
    assert.ok(minCursor >= 1 - 1e-9, 'count() / true(W) must never fall below 1 (F7 one-sided lower bound), min ' + minCursor);
    // The sketch covers [W, W+W/B], so it OVER-covers the TRUE (now-W, now] window by up to ONE pane width.
    // The over-coverage count() - true(W) must therefore reach a meaningful fraction of a pane (bounded by
    // paneW). An oracle-on-the-covered-span mutant makes true(W) == the covered count, so the gap collapses
    // to ~0 -> this check goes RED (proving the count oracle is the TRUE window, not the covered span).
    assert.ok(maxGap >= 8, 'count() must over-cover the TRUE window by a meaningful margin (F7, TRUE-window oracle), max gap ' + maxGap);
    assert.ok(maxGap <= paneW + 1e-9, 'the over-coverage must not exceed one pane width ' + paneW + ' (F7 upper bound), got ' + maxGap);
});

test('D6 SLD range mode: out-of-[1,20] values are PRE-CHECKED out (rejected counter climbs, sketch never throws), and the oracle mirrors the accepted set', () => {
    const world = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, SLD_MODE_RANGE);
    const a = createAllocState();
    assert.doesNotThrow(() => { for (let f = 0; f < 300; f++) { stepSld(world); stepSldOracle(world, a); } },
        'range mode must never throw on an out-of-range value (pre-checked, not caught)');
    renderSldPrep(world, a);
    assert.ok(world.rejected > 0, 'the lognormal tails must produce >= 1 out-of-[1,20] rejection (non-vacuous), got ' + world.rejected);
    assert.equal(world.flat[Q_REJECTED], world.rejected, 'Q_REJECTED must equal the world rejected counter');
    // every value the sketch retains is inside the declared band (fail-closed pre-check has teeth).
    assert.ok(world.sd.count() > 0, 'accepted in-range values must populate the sketch');
    assert.ok(world.flat[Q_P50] >= SLD_RANGE_MIN * (1 - SLD_DEFAULT_ALPHA) && world.flat[Q_P50] <= SLD_RANGE_MAX * (1 + SLD_DEFAULT_ALPHA),
        'the windowed p50 must sit inside the declared band +- alpha, got ' + world.flat[Q_P50]);
});

test('D6 SLD render uses quantileInto: the displayed p50/p90/p99 equal the shipped scalar quantile() (byte-identical), so a quantileInto->quantile() swap changes nothing but the alloc', () => {
    for (const mode of [SLD_MODE_DEFAULT, SLD_MODE_STRICT, SLD_MODE_RANGE]) {
        const world = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, mode);
        const a = createAllocState();
        for (let f = 0; f < 300; f++) { stepSld(world); stepSldOracle(world, a); }
        renderSldPrep(world, a);
        const f = world.flat, sd = world.sd;
        assert.equal(f[Q_P50], sd.quantile(0.5), 'mode ' + mode + ': displayed p50 must equal the shipped scalar quantile(0.5)');
        assert.equal(f[Q_P90], sd.quantile(0.9), 'mode ' + mode + ': displayed p90 must equal quantile(0.9)');
        assert.equal(f[Q_P99], sd.quantile(0.99), 'mode ' + mode + ': displayed p99 must equal quantile(0.99)');
    }
});

test('D6 SLD mode fail-closed: a bad mode throws a tagged [lite-adaptive] error BEFORE any allocation; 0/1/2 and undefined construct', () => {
    for (const bad of [3, -1, 1.5, NaN, 'range', {}]) {
        let w;
        assert.throws(() => { w = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, bad); },
            /\[lite-adaptive\]/, 'mode ' + String(bad) + ' must throw the tagged error');
        assert.equal(w, undefined, 'no world is constructed when mode ' + String(bad) + ' is rejected');
    }
    for (const ok of [SLD_MODE_DEFAULT, SLD_MODE_STRICT, SLD_MODE_RANGE, undefined]) {
        assert.doesNotThrow(() => createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, ok), 'mode ' + String(ok) + ' must construct');
    }
});

test('D6 SLD 0-B/op: stepSld in range mode (the reject + advanceFrom path engaged) measures 0 B/call', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const w = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, SLD_MODE_RANGE);
    measure0(t, 'stepSld range-mode', 40000, () => stepSld(w));
});

// The nine oracle-derived slots renderSldPrep must fail closed (blocker 7): the three true quantiles, the
// accuracy cursor pair, the live/edge counts, and the true(W) count + its cursor.
const SLD_ORACLE_SLOTS = [Q_P50T, Q_P90T, Q_P99T, Q_MAXREL, Q_FRAC, Q_LIVE, Q_EDGE, Q_TRUEW, Q_CNT_CURSOR];

test('D6 SLD oracle-off fail-closed: renderSldPrep NaNs ALL NINE oracle-derived slots (P50T/P90T/P99T, MAXREL, FRAC, LIVE, EDGE, TRUEW, CNT_CURSOR) when world.oracleOn is false -- a frozen ring is never shown as live', () => {
    const world = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, SLD_MODE_DEFAULT);
    const a = createAllocState();
    for (let f = 0; f < 300; f++) { stepSld(world); stepSldOracle(world, a); }
    // CONTROL (non-vacuous): with the oracle on all nine oracle-derived slots are finite.
    renderSldPrep(world, a);
    const f = world.flat;
    for (const s of SLD_ORACLE_SLOTS) assert.ok(Number.isFinite(f[s]), 'slot ' + s + ' must be finite with the oracle on (control)');
    assert.ok(Number.isFinite(f[Q_COUNT]), 'Q_COUNT stays a live readout (control)');
    // oracle off: fail closed to NaN on EVERY oracle-derived slot. Removing the cold branch leaves them
    // deriving from the frozen ring -> finite -> this FAILS (teeth).
    world.oracleOn = false;
    renderSldPrep(world, a);
    for (const s of SLD_ORACLE_SLOTS) assert.ok(Number.isNaN(f[s]), 'slot ' + s + ' must be NaN with the oracle off');
    assert.ok(Number.isFinite(f[Q_COUNT]), 'Q_COUNT stays the shipped live count() with the oracle off');
});

test('D6 SLD resume-hold: after the oracle is re-enabled, ALL NINE oracle-derived slots hold NaN until a full window W has elapsed (no false gauge from a half-refilled ring)', () => {
    const world = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, SLD_MODE_DEFAULT);
    const a = createAllocState();
    for (let f = 0; f < 300; f++) { stepSld(world); stepSldOracle(world, a); }
    // re-enable at the current now: the exact ring is refilling for a full window W of time units.
    world.oracleOn = true; world.resumeNow = world.now;
    renderSldPrep(world, a);
    const g = world.flat;
    for (const s of SLD_ORACLE_SLOTS) assert.ok(Number.isNaN(g[s]), 'slot ' + s + ' must hold NaN immediately after resume (< W elapsed)');
    // drive a full window past resume; every gauge comes back finite.
    let guard = 0;
    while (world.now - world.resumeNow < world.W && guard++ < 100000) { stepSld(world); stepSldOracle(world, a); }
    renderSldPrep(world, a);
    for (const s of SLD_ORACLE_SLOTS) assert.ok(Number.isFinite(g[s]), 'slot ' + s + ' must be finite once >= W has elapsed since resume');
});

test('D6 SLD empty-window fail-closed: with the oracle ON but the TRUE (now-W, now] window empty, the count cursor Q_CNT_CURSOR is NaN ("n/a"), NOT 1.00x -- null is not zero', () => {
    // a fresh world (no adds): the TRUE window is empty, so true(W) = 0. The F7 cursor over an empty
    // window is UNDEFINED. Reverting to the old `(cnt > 0 ? Infinity : 1)` makes it read 1 (finite) -> RED.
    const world = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, SLD_MODE_DEFAULT);
    const a = createAllocState();
    renderSldPrep(world, a);
    const f = world.flat;
    assert.equal(f[Q_TRUEW], 0, 'a fresh world has an empty TRUE window: true(W) = 0');
    assert.ok(Number.isNaN(f[Q_CNT_CURSOR]), 'the count cursor over an empty window must be NaN, not 1.00x');
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

// From-spec SCM truth, recomputed from the DETERMINISTIC stream (item t = 1..now has key stream[t-1]; in heavy
// mode key 0 also gets SCM_HEAVY_COUNT at every streaming frame's end time), never from the kernel's oracle
// rings: N over the covered span (paneEnd(t) > now - W, the library's live rule) and true(W) per tracked key.
function scmSpecTruth(world, heavyEnds) {
    const pw = world.W / world.panes, now = world.now, cut = now - world.W;
    const live = (t) => (Math.floor(t / pw) + 1) * pw > cut;
    let N = 0;
    const trueW = new Float64Array(SCM_TRACKED);
    for (let t = 1; t <= now; t++) {
        const key = world.stream[(t - 1) & world.streamMask];
        if (live(t)) N++;
        if (t > cut) for (let k = 0; k < SCM_TRACKED; k++) if (world.tracked[k] === key) trueW[k]++;
    }
    for (const t of heavyEnds) {
        if (live(t)) N += SCM_HEAVY_COUNT;
        if (t > cut) for (let k = 0; k < SCM_TRACKED; k++) if (world.tracked[k] === 0) trueW[k] += SCM_HEAVY_COUNT;
    }
    return { N, trueW };
}

test('D7 SCM total(W) + oracle N vs the from-spec truth: the oracle N, total(W) and every tracked true(W) equal a recount from the stream on EVERY render (3 W x heavy on/off); C_TOTALOK is 1 -- the pre-2026-10-04 `<=` oracle expiry dropped the oldest LIVE pane (N 1985 vs 2049) and goes RED here', () => {
    for (const W of [1024, 2048, 4096]) {
        for (const heavy of [false, true]) {
            const world = createScmWorld(W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 0xD7);
            world.heavy = heavy;
            const a = createAllocState(), heavyEnds = [];
            let renders = 0;
            for (let f = 0; f < 400; f++) {
                stepScm(world); stepScmOracle(world, a);
                if (heavy) heavyEnds.push(world.now);
                if (f % 9 !== 0) continue;
                renderScmPrep(world, a);
                renders++;
                const spec = scmSpecTruth(world, heavyEnds), fl = world.flat;
                const tag = 'W=' + W + ' heavy=' + heavy + ' frame ' + f;
                assert.equal(fl[C_NLIVE], spec.N, tag + ': the oracle N must equal the from-spec covered-span N');
                assert.equal(fl[C_TOTAL], spec.N, tag + ': scm.total() must equal the from-spec N');
                assert.equal(fl[C_TOTALOK], 1, tag + ': C_TOTALOK must be 1');
                for (let k = 0; k < SCM_TRACKED; k++) {
                    assert.equal(fl[k * SCM_STRIDE + 1], spec.trueW[k], tag + ': tracked ' + k + ' true(W) must equal the from-spec count');
                }
                assert.equal(fl[C_BOUNDOK], 1, tag + ': the one-sided bound must hold');
            }
            assert.ok(renders >= 40, 'non-vacuous render count');
        }
    }
});

test('D7 SCM heavy-count mode: key 0 passes 2^31 without saturating a pane cell; the render reads every tracked key through estimateInto, Object.is the scalar estimate(); C_HEAVY mirrors the flag; pausing slides N and total(W) to 0', () => {
    const world = createScmWorld(4096, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 0x4EA7);
    world.heavy = true;
    const a = createAllocState();
    for (let f = 0; f < 300; f++) { stepScm(world); stepScmOracle(world, a); }
    renderScmPrep(world, a);
    const fl = world.flat;
    assert.ok(fl[0] >= 2 ** 31, 'tracked key 0 estimate must exceed 2^31 in heavy mode, got ' + fl[0]);
    assert.equal(fl[C_SATURATED], 0, 'one heavy add per frame must never saturate a Uint32 pane cell');
    assert.equal(fl[C_HEAVY], 1, 'C_HEAVY mirrors world.heavy');
    for (let k = 0; k < SCM_TRACKED; k++) {
        assert.ok(Object.is(fl[k * SCM_STRIDE], world.scm.estimate(world.tracked[k])), 'tracked ' + k + ': estimateInto slot must be Object.is estimate()');
    }
    world.paused = true;
    for (let f = 0; f < 200; f++) { stepScm(world); stepScmOracle(world, a); }
    renderScmPrep(world, a);
    assert.equal(fl[C_NLIVE], 0, 'paused: the oracle N slides to 0');
    assert.equal(fl[C_TOTAL], 0, 'paused: total(W) slides to 0');
    assert.equal(fl[0], 0, 'paused: the heavy key estimate slides to 0');
});

test('D8 SCM contracts line: scmContracts reads the library LIVE -- a bad sub-window is NaN (never a fail-open 0) and a typo option key throws the library\'s own did-you-mean message', () => {
    const world = createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES);
    const c = scmContracts(world);
    assert.ok(Number.isNaN(c.badW), 'estimate(k, -1) must be NaN, got ' + c.badW);
    let direct = null;
    try { new SlidingCountMin(SCM_DEFAULT_W, { sede: 1 }); } catch (e) { direct = e.message; }
    assert.equal(c.typoMsg, direct, 'the shown typo message must be the library\'s own');
    assert.match(c.typoMsg, /^\[lite-adaptive\].*did you mean "seed"/, 'the library message must carry the did-you-mean hint');
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    assert.match(html, /const c = scmContracts\(scmWorld\);/, 'index.html must render the contracts line from scmContracts');
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

// Per-scene combined 0-major-GC gate: stepX every frame + renderXPrep every 64th over 200k stepX
// ops (the DEMO.md "sketch path stays zero-GC while it runs" claim), mirroring test/torture.mjs's
// `checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 })` and adding `maxMinor: 0`. The oracle steps are NOT in
// the loop -- they are the allowed-to-allocate contrast (the planner's RISK).
// Each lane runs in a FRESH `node --expose-gc` child (demo/DemoGcLane.mjs), never in this process:
// in-process, after ~85 earlier tests, the window measured the test file (discarded optimized code ->
// baseline-tier boxing, a ~740-entry 'gc' perf-entry backlog delivered in the tail, the in-loop
// memoryUsage branch deopting the hot loop), and the 4-file parallel run stretched those minors past
// 4 ms (2026-10-04: EH 15.87 ms, HK 9.57 ms). In a fresh isolate the window holds 0 GC events, so the
// gate is deterministic AND can gate minors: the pre-2026-10-04 gate PASSED a 32 B/frame injected
// allocation (minors were "reported, not gated"); this one fails it.
const GC_RULES_CHECKED = ['maxMajor', 'maxMinor', 'maxPauseMs'];
async function gcGate(t, name) {
    if (FAST) { t.skip('fast (demo:check skips the 200k-frame lanes)'); return; }
    const r = await runGcLane(name);
    process.stdout.write('  ' + name + ' sketch-path gate (fresh child): gc major=' + r.major + ' minor=' + r.minor +
        ' maxMs=' + r.maxMs.toFixed(2) + ' loop=' + r.loopMs.toFixed(0) + 'ms\n');
    assert.equal(r.lane, name, 'the child must report the lane it was asked to run');
    assert.equal(r.hot, 200000, name + ' window must be the full 200k sketch-path frames');
    assert.ok(r.execArgv.includes('--expose-gc'), name + ' child must run with --expose-gc');
    // fail closed: an unobserved GC channel or an undrained observer is NOT a pass.
    assert.equal(r.observed, true, name + ' GC channel must have been observed (else the gate verified nothing)');
    assert.equal(r.settled, true, name + ' GC observer must drain before the verdict (undrained = inconclusive = FAIL)');
    assert.deepEqual(Object.keys(r.checked).sort(), GC_RULES_CHECKED, name + ' checkNoGc must evaluate exactly ' + GC_RULES_CHECKED.join('/'));
    for (const k of GC_RULES_CHECKED) assert.equal(r.checked[k], true, name + ' rule ' + k + ' must be checkable on the gc source');
    assert.ok(r.sinkFinite, 'sink keeps the swept work live');
    assert.equal(r.major, 0, name + ' 200k sketch-path frames must trigger 0 major GC, got ' + r.major);
    assert.equal(r.minor, 0, name + ' 200k sketch-path frames must trigger 0 minor GC in a fresh isolate, got ' + r.minor);
    assert.equal(r.verdict, 'pass', name + ' checkNoGc must report pass: ' + JSON.stringify(r.violations));
    assert.ok(r.ok, name + ' checkNoGc must report ok: ' + JSON.stringify(r.violations));
    assert.equal(r.sketchCount, 0, name + ' sketch-path owned allocation counter must stay pinned at 0');
    assert.equal(r.flatSlot, 0, name + ' flat sketch-alloc slot must read 0');
}

test('0-major-GC: EH sketch path (stepEh + renderEhPrep) over 200k frames', (t) => gcGate(t, 'EH'));
test('0-major-GC: ADWIN sketch path (stepAd + renderAdPrep) over 200k frames', (t) => gcGate(t, 'ADWIN'));
test('0-major-GC: FD sketch path (stepFd + renderFdPrep) over 200k frames', (t) => gcGate(t, 'FD'));
test('0-major-GC: HK sketch path (stepHk + renderHkPrep) over 200k frames', (t) => gcGate(t, 'HK'));
test('0-major-GC: SHLL sketch path (stepShll + renderShllPrep) over 200k frames', (t) => gcGate(t, 'SHLL'));
test('0-major-GC: DD sketch path (stepDd + renderDdPrep) over 200k frames', (t) => gcGate(t, 'DD'));
test('0-major-GC: SLD sketch path (stepSld + renderSldPrep) over 200k frames', (t) => gcGate(t, 'SLD'));
test('0-major-GC: SCM sketch path (stepScm + renderScmPrep) over 200k frames', (t) => gcGate(t, 'SCM'));
test('0-major-GC: DR sketch path (stepDr + renderDrPrep) over 200k frames', (t) => gcGate(t, 'DR'));

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

/* ============================ golden pre-existing flat slots ================ */

// The flat layouts are APPEND-ONLY: as the 1.8.0 demo passes add controls/readouts, a scene's flat
// buffer only ever GROWS, and only AFTER the last existing index -- every pre-existing slot must stay
// bit-identical at defaults. demo/golden-flat.json pins those bits (big-endian Float64 hex, 300 frames
// at defaults, cut from HEAD:kernels on the working-tree 1.8.0 Adaptive.js). This test re-runs the
// CURRENT kernels the same way and compares slot-for-slot, so a later pass that reorders or perturbs a
// pre-existing slot is caught. A DECLARED EXCEPTION LIST carries the (scene, index) slots a pass is
// allowed to change (empty now; P2 adds HK H_RECALL / H_FOUND when the key-magnitude toggle lands).

const GOLDEN_FRAMES = 300;

/** Big-endian Float64 bit pattern of every slot as a 0x-hex string (NaN/-0 preserved exactly). */
function flatBitsHex(f64) {
    const dv = new DataView(new ArrayBuffer(8));
    const out = new Array(f64.length);
    for (let i = 0; i < f64.length; i++) {
        dv.setFloat64(0, f64[i], false);
        out[i] = '0x' + dv.getBigUint64(0, false).toString(16).padStart(16, '0');
    }
    return out;
}

/** Run a scene's world GOLDEN_FRAMES frames at defaults, then one renderPrep; return the flat bits. */
function goldenSceneBits(make, step, oracle, render) {
    const world = make();
    const a = createAllocState();
    for (let f = 0; f < GOLDEN_FRAMES; f++) { step(world); oracle(world, a); }
    render(world, a);
    return flatBitsHex(world.flat);
}

// Same default-topology worlds the golden was cut from (no explicit seed -> the kernels' defaults).
const GOLDEN_SCENES = {
    EH:    () => goldenSceneBits(() => createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS), stepEh, stepEhOracle, renderEhPrep),
    // ADWIN step = stepAd + stepAdGhost: the ghost global range is now owned by stepAdGhost (removed from
    // stepAdOracle), so the golden's A_GHOSTR must be maintained by threading it here. min/max over the same
    // frame values is identical whichever kernel folds it, so A_GHOSTR stays bit-identical.
    ADWIN: () => goldenSceneBits(() => createAdWorld(AD_DEFAULT_DELTA), (w) => { stepAd(w); stepAdGhost(w); }, stepAdOracle, renderAdPrep),
    FD:    () => goldenSceneBits(() => createFdWorld(FD_DEFAULT_HALFLIFE), stepFd, stepFdOracle, renderFdPrep),
    HK:    () => goldenSceneBits(() => createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K), stepHk, stepHkOracle, renderHkPrep),
    SHLL:  () => goldenSceneBits(() => createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP), stepShll, stepShllOracle, renderShllPrep),
    DD:    () => goldenSceneBits(() => createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD), stepDd, stepDdOracle, renderDdPrep),
    SLD:   () => goldenSceneBits(() => createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES), stepSld, stepSldOracle, renderSldPrep),
    SCM:   () => goldenSceneBits(() => createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES), stepScm, stepScmOracle, renderScmPrep),
    DR:    () => goldenSceneBits(() => createDrWorld(DR_DEFAULT_K, DR_DEFAULT_HALFLIFE), stepDr, stepDrOracle, renderDrPrep),
    SA:    () => goldenSceneBits(() => createSaWorld(SA_DEFAULT_W, SA_DEFAULT_PANES), stepSa, stepSaOracle, (w, a) => { renderSaPrep(w, a); renderSaEhPrep(w); }),
};

// (scene -> [allowed-to-differ slot indices]). P2 (D3) declares the ONLY exception: renderHkPrep now
// reads top-k membership / recall from a topBuf scan (topKInto) instead of scalar hk.estimate on the
// render path (which boxes a key >= 2^31 / negative). That re-sources H_RECALL / H_FOUND, so those two
// HK slots are the declared exceptions to the append-only golden. (At defaults the value coincides with
// the old estimate-based recall; the SOURCE of the number changed, so the exception is declared.)
const GOLDEN_EXCEPTIONS = Object.create(null);
GOLDEN_EXCEPTIONS.HK = [H_RECALL, H_FOUND];
// B6 (2026-10-04) declares the SCM exceptions: the oracle expiry was off by one pane (`<=` dropped the
// oldest LIVE pane), so at defaults the oracle-derived slots move -- every tracked true(W) and upper bound,
// C_NLIVE (1985 -> 2049 == scm.total()) and C_ORACLE_BYTES. The library-derived slots (estimates,
// saturated, bytes, ...) stay bit-identical. The D7 from-spec test gates the corrected values.
GOLDEN_EXCEPTIONS.SCM = [1, 2, 4, 5, 7, 8, 10, 11, C_NLIVE, C_ORACLE_BYTES];

/** Compare current bits against golden for the PRE-EXISTING (golden-length) slots, honoring exceptions.
 *  Returns a list of 'SCENE[i]: golden -> current' mismatch strings (empty === bit-identical). */
function goldenMismatches(golden, currentBits, exceptions) {
    const out = [];
    for (const scene of Object.keys(golden)) {
        const g = golden[scene];
        const c = currentBits[scene];
        if (!c) { out.push(scene + ': scene missing from current kernels'); continue; }
        if (c.length < g.length) {
            out.push(scene + ': flat shrank ' + g.length + ' -> ' + c.length + ' (layout is append-only)');
        }
        const skip = exceptions[scene] || [];
        for (let i = 0; i < g.length; i++) {
            if (skip.indexOf(i) !== -1) continue;
            if (c[i] !== g[i]) out.push(scene + '[' + i + ']: ' + g[i] + ' -> ' + c[i]);
        }
    }
    return out;
}

test('golden: pre-existing flat slots are bit-identical at defaults (append-only layout guard)', () => {
    const golden = JSON.parse(readFileSync(join(DEMO_DIR, 'golden-flat.json'), 'utf8')).scenes;
    const currentBits = Object.create(null);
    for (const scene of Object.keys(GOLDEN_SCENES)) currentBits[scene] = GOLDEN_SCENES[scene]();

    // non-vacuous: the golden must actually pin slots for every shipped scene.
    assert.equal(Object.keys(golden).length, Object.keys(GOLDEN_SCENES).length,
        'the golden must pin every demo scene');
    for (const scene of Object.keys(golden)) {
        assert.ok(golden[scene].length > 0, scene + ' golden must pin >= 1 slot');
    }

    const mism = goldenMismatches(golden, currentBits, GOLDEN_EXCEPTIONS);
    assert.deepStrictEqual(mism, [],
        'every pre-existing flat slot must be bit-identical to demo/golden-flat.json at defaults:\n  ' + mism.join('\n  '));

    // MUST-FAIL CONTROL: flip one golden bit in memory -> the comparison MUST report exactly it.
    const tampered = JSON.parse(JSON.stringify(golden));
    const g0 = tampered.EH[0];                                   // EH[0] = E_COUNT (eh.count())
    const flipped = '0x' + (BigInt(g0) ^ 1n).toString(16).padStart(16, '0');
    tampered.EH[0] = flipped;
    const ctrl = goldenMismatches(tampered, currentBits, GOLDEN_EXCEPTIONS);
    assert.ok(ctrl.some((m) => m.startsWith('EH[0]:')),
        'the golden comparison must have TEETH: a single flipped golden bit must be reported, got ' + JSON.stringify(ctrl));
});

/* =============================================================================================
 * D1 / D2 (1.8.0) -- ExponentialHistogram maxCount + F17 sum bound; ADWIN offset + F18 ghost range.
 * Every new displayed number is re-derived from the shipped getters / the exact oracle; each new
 * control is proven 0 B/op on the frame path; the append-only golden (above) pins the old slots.
 * ============================================================================================= */

test('D1 EH faithfulness: pool-gauge + sum() readouts equal the shipped getters and the exact oracle', () => {
    const world = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 0xD1F, { values: 'spike' });
    const a = createAllocState();
    for (let f = 0; f < 600; f++) { stepEh(world); stepEhOracle(world, a); }
    renderEhPrep(world, a);
    const eh = world.eh, f = world.flat;
    assert.equal(f[E_MAXCOUNT], eh.maxCount, 'E_MAXCOUNT must be the shipped eh.maxCount');
    assert.equal(f[E_CEIL], eh.k * (2 ** eh.levels - 1), 'E_CEIL must be k*(2^levels-1) from the shipped getters');
    assert.equal(f[E_CAP], eh.capacity, 'E_CAP must be the shipped eh.capacity');
    assert.equal(f[E_SUM], eh.sum(), 'E_SUM must be the shipped eh.sum()');
    assert.equal(f[E_TRUESUM], world.trueSum, 'E_TRUESUM must be the exact ring-value sum');
    assert.equal(f[E_POP], (world.ringTail - world.ringHead) & world.ringMask, 'E_POP must be the exact ring population');
    const probe = new Float64Array(1); ehStraddleInto(world, probe, 0);
    assert.equal(f[E_STRADDLE], probe[0], 'E_STRADDLE must be the EhProbe straddling-bucket size');
    assert.equal(f[E_FAILED], 0, 'E_FAILED stays 0 on a non-overflowing pool');
});

test('D1 EH oracle-off fail-closed: renderEhPrep NaNs ALL SEVEN oracle-derived slots (E_TRUE / E_RELERR / E_FRAC / E_POP / E_TRUESUM / E_SUMFRAC / E_SUMRELEPS) when world.oracleOn is false', () => {
    const world = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 1);
    const a = createAllocState();
    for (let f = 0; f < 400; f++) { stepEh(world); stepEhOracle(world, a); }
    // CONTROL (non-vacuous): with the oracle on all seven oracle-derived slots are finite.
    renderEhPrep(world, a);
    const f = world.flat;
    assert.ok(Number.isFinite(f[E_TRUE]) && Number.isFinite(f[E_RELERR]) && Number.isFinite(f[E_FRAC]) &&
        Number.isFinite(f[E_POP]) && Number.isFinite(f[E_TRUESUM]) && Number.isFinite(f[E_SUMFRAC]) && Number.isFinite(f[E_SUMRELEPS]),
        'with the oracle on the seven oracle-derived slots must be finite (control)');
    const ringBytesOn = f[E_RING_BYTES];
    assert.ok(Number.isFinite(ringBytesOn) && ringBytesOn > 0, 'E_RING_BYTES must be a live memory readout (control)');
    // oracle off: fail closed to NaN on EVERY oracle-derived slot so a frozen ring is never shown as live.
    // Reverting to the old 4-slot branch (E_TRUE / E_RELERR / E_FRAC left deriving from the frozen ring)
    // makes those three finite -> this assertion FAILS (teeth).
    world.oracleOn = false;
    renderEhPrep(world, a);
    assert.ok(Number.isNaN(f[E_TRUE]), 'E_TRUE must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[E_RELERR]), 'E_RELERR must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[E_FRAC]), 'E_FRAC must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[E_POP]), 'E_POP must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[E_TRUESUM]), 'E_TRUESUM must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[E_SUMFRAC]), 'E_SUMFRAC must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[E_SUMRELEPS]), 'E_SUMRELEPS must be NaN with the oracle off');
    // E_RING_BYTES stays the live memory readout (not NaN'd).
    assert.ok(Number.isFinite(f[E_RING_BYTES]), 'E_RING_BYTES must remain a finite memory readout with the oracle off');
});

test('D1 EH resume-hold: after the oracle is re-enabled, ALL SEVEN oracle-derived slots hold NaN until a full window W has elapsed (no false red gauge from a half-refilled ring)', () => {
    const world = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 1);
    const a = createAllocState();
    for (let f = 0; f < 400; f++) { stepEh(world); stepEhOracle(world, a); }
    // re-enable at the current now: the exact ring is refilling for a full window W of time units.
    world.oracleOn = true; world.resumeNow = world.now;
    renderEhPrep(world, a);
    const g = world.flat;
    // Reverting to the old 2-slot resume branch (only E_FRAC / E_SUMFRAC held) leaves E_TRUE / E_RELERR /
    // E_POP / E_TRUESUM / E_SUMRELEPS showing the half-refilled ring as plain numbers -> these FAIL (teeth).
    assert.ok(Number.isNaN(g[E_TRUE]), 'E_TRUE must hold NaN immediately after resume (< W elapsed)');
    assert.ok(Number.isNaN(g[E_RELERR]), 'E_RELERR must hold NaN immediately after resume (< W elapsed)');
    assert.ok(Number.isNaN(g[E_FRAC]), 'E_FRAC must hold NaN immediately after resume (< W elapsed)');
    assert.ok(Number.isNaN(g[E_POP]), 'E_POP must hold NaN immediately after resume (< W elapsed)');
    assert.ok(Number.isNaN(g[E_TRUESUM]), 'E_TRUESUM must hold NaN immediately after resume (< W elapsed)');
    assert.ok(Number.isNaN(g[E_SUMFRAC]), 'E_SUMFRAC must hold NaN immediately after resume (< W elapsed)');
    assert.ok(Number.isNaN(g[E_SUMRELEPS]), 'E_SUMRELEPS must hold NaN immediately after resume (< W elapsed)');
    assert.ok(Number.isFinite(g[E_RING_BYTES]), 'E_RING_BYTES must remain a finite memory readout during the resume hold');
    // drive a full window past resume; every gauge comes back finite.
    let guard = 0;
    while (world.now - world.resumeNow < world.W && guard++ < 100000) { stepEh(world); stepEhOracle(world, a); }
    renderEhPrep(world, a);
    assert.ok(Number.isFinite(g[E_TRUE]), 'E_TRUE must be finite once >= W has elapsed since resume');
    assert.ok(Number.isFinite(g[E_RELERR]), 'E_RELERR must be finite once >= W has elapsed since resume');
    assert.ok(Number.isFinite(g[E_FRAC]), 'E_FRAC must be finite once >= W has elapsed since resume');
    assert.ok(Number.isFinite(g[E_POP]), 'E_POP must be finite once >= W has elapsed since resume');
    assert.ok(Number.isFinite(g[E_TRUESUM]), 'E_TRUESUM must be finite once >= W has elapsed since resume');
    assert.ok(Number.isFinite(g[E_SUMFRAC]), 'E_SUMFRAC must be finite once >= W has elapsed since resume');
    assert.ok(Number.isFinite(g[E_SUMRELEPS]), 'E_SUMRELEPS must be finite once >= W has elapsed since resume');
});

test('D1 EH dense10k overflow: a W-sized pool throws the tagged message; E_CEIL equals the ceiling parsed from it', () => {
    const world = createEhWorld(1024, 0.05, 1, { preset: 'dense10k', maxCount: 1024 });
    const a = createAllocState();
    assert.equal(world.eh.k, 11, 'dense10k @ eps .05: k must be 11');
    assert.equal(world.eh.levels, 9, 'dense10k @ eps .05: levels must be 9');
    assert.equal(world.eh.capacity, 110, 'dense10k @ eps .05: capacity must be 110');
    for (let f = 0; f < 2000 && world.failed === 0; f++) { stepEhGuarded(world); if (world.failed === 0) stepEhOracle(world, a); }
    assert.equal(world.failed, 1, 'the dense10k stream must overflow a W-sized pool');
    assert.match(world.failMsg, /\[lite-adaptive\].*maxCount/, 'the stored message must be the library tagged throw');
    renderEhPrep(world, a);
    const ceil = world.eh.k * (2 ** world.eh.levels - 1);
    assert.equal(ceil, 5621, 'the exact ceiling must be 5621');
    assert.equal(world.flat[E_CEIL], ceil, 'E_CEIL must be the exact ceiling');
    assert.equal(world.flat[E_FAILED], 1, 'E_FAILED must be set after the catch');
    const m = /k\*\(2\^levels-1\)=(\d+)/.exec(world.failMsg);
    assert.ok(m, 'the caught message must carry the ceiling number');
    assert.equal(Number(m[1]), world.flat[E_CEIL], 'the ceiling in the library message must equal E_CEIL');
});

test('D1 EH dense10k with maxCount 2^32: 2000 frames, no throw, relerr <= eps', () => {
    const world = createEhWorld(1024, 0.05, 1, { preset: 'dense10k' });
    const a = createAllocState();
    let maxRel = 0;
    for (let f = 0; f < 2000; f++) {
        stepEhGuarded(world); stepEhOracle(world, a);
        if (f > 50 && (f & 7) === 0) { renderEhPrep(world, a); if (world.flat[E_RELERR] > maxRel) maxRel = world.flat[E_RELERR]; }
    }
    assert.equal(world.failed, 0, 'the default 2^32 pool must never overflow the dense10k stream');
    assert.ok(maxRel <= 0.05, 'measured windowed relerr ' + maxRel.toFixed(5) + ' must be <= eps 0.05');
});

test('D1 EH F17 spike: E_SUMFRAC <= 1 on 100% of >= 2000 queries; E_SUMRELEPS > 1; the straddle=0 control fails', () => {
    const world = createEhWorld(1024, 0.1, 7, { values: 'spike' });
    const a = createAllocState();
    let q = 0, viol = 0, maxRelEps = 0, ctrlFail = 0;
    for (let f = 0; f < 8000; f++) {
        stepEh(world); stepEhOracle(world, a);
        if (f > 20) {
            renderEhPrep(world, a); q++;
            if (!(world.flat[E_SUMFRAC] <= 1)) viol++;
            if (world.flat[E_SUMRELEPS] > maxRelEps) maxRelEps = world.flat[E_SUMRELEPS];
            const sumErr = Math.abs(world.flat[E_SUM] - world.flat[E_TRUESUM]);
            const ctrlBound = 1e-6 * Math.max(1, Math.abs(world.flat[E_TRUESUM]));   // straddle term FORCED to 0
            if (sumErr / ctrlBound > 1) ctrlFail++;
        }
    }
    assert.ok(q >= 2000, 'the F17 lane must sample >= 2000 sum queries, got ' + q);
    assert.equal(viol, 0, 'E_SUMFRAC must stay <= 1 on 100% of queries (sum bounded by straddle/2)');
    assert.ok(maxRelEps > 1, 'the OLD sum() <= eps claim must visibly FAIL on the spike stream (E_SUMRELEPS > 1), got ' + maxRelEps.toFixed(2));
    assert.ok(ctrlFail > 0, 'forcing the straddle term to 0 must break the bound -- the control has teeth');
});

test('D1 EH 0-B/op: the real per-frame path (stepEhGuarded + stepEhOracle) + renderEhPrep on dense10k measure 0 B/call', (t) => {
    const w = createEhWorld(1024, 0.05, 3, { preset: 'dense10k' }); const a = createAllocState();
    measure0(t, 'stepEhGuarded+oracle dense10k', 20000, () => { stepEhGuarded(w); stepEhOracle(w, a); });
    measure0(t, 'renderEhPrep dense10k', 2000, () => renderEhPrep(w, a));
});
test('D1 EH 0-B/op: the real per-frame path (stepEh + stepEhOracle) + renderEhPrep on the F17 spike stream measure 0 B/call', (t) => {
    const w = createEhWorld(1024, 0.1, 4, { values: 'spike' }); const a = createAllocState();
    measure0(t, 'stepEh+oracle spike', 20000, () => { stepEh(w); stepEhOracle(w, a); });
    measure0(t, 'renderEhPrep spike', 2000, () => renderEhPrep(w, a));
});

test('D2 ADWIN faithfulness: offset / live-range / ghost-range / last-cut readouts equal the kernels oracle', () => {
    const world = createAdWorld(0.002, 5, 1e6);
    const a = createAllocState();
    // ghost is owned by stepAdGhost now (removed from stepAdOracle) -- thread it so A_GHOSTR is maintained.
    for (let f = 0; f < 1500; f++) { stepAd(world); stepAdGhost(world); stepAdOracle(world, a); }
    renderAdPrep(world, a);
    const f = world.flat;
    assert.equal(f[A_OFFSET], 1e6, 'A_OFFSET must be the world offset');
    assert.equal(f[A_GHOSTR], world.ghostMax - world.ghostMin, 'A_GHOSTR must be the ghost global range');
    assert.equal(f[A_LASTCUT], world.lastCut, 'A_LASTCUT must be the last cut item index');
    // A_LIVER re-derived independently over an UNCAPPED raw-stream recompute of the WHOLE retained window
    // (the last ad.width fed values straight from the stream suffix). Assert at a point where width > the
    // old 256 scan cap, so a re-introduced cap would visibly disagree with this exact range.
    const width = world.ad.width | 0;
    assert.ok(width > AD_LIVER_SCAN, 'the faithfulness point must have width ' + width + ' > the old scan cap ' + AD_LIVER_SCAN + ' (else the cap bug is invisible)');
    const stream = world.stream, mask = world.streamMask, cur = world.cursor;
    let mn = Infinity, mx = -Infinity;
    for (let i = 1; i <= width; i++) { const v = stream[(cur - i) & mask]; if (v < mn) mn = v; if (v > mx) mx = v; }
    assert.equal(f[A_LIVER], width > 0 ? (mx - mn) : 0, 'A_LIVER must equal the UNCAPPED exact max-min over the last ad.width fed values');
});

test('D2 ADWIN ghost coverage: stepAd + stepAdGhost (foil OFF) alone maintain A_GHOSTR = exact max-min over EVERY fed value', () => {
    // The ghost global range is the D2 deafness demo and must stay live even when the naive-mean foil
    // (stepAdOracle) is paused -- so the demo's adStep() runs stepAdGhost OUTSIDE the adFoilOn branch.
    // Drive ONLY stepAd + stepAdGhost (no stepAdOracle) and prove the ghost equals the true global range.
    const world = createAdWorld(0.002, 5, 0, 'bigJumpThenPlus1');
    const a = createAllocState();
    let gmin = Infinity, gmax = -Infinity;
    const FRAMES = 1400;   // past the +1 at 40000 items (1400*32 = 44800), so the ghost spans >= J
    for (let fr = 0; fr < FRAMES; fr++) {
        const start = world.cursor & world.streamMask;   // stepAd advances world.cursor; capture the frame start first
        stepAd(world); stepAdGhost(world);
        for (let i = 0; i < AD_VALUES_PER_FRAME; i++) { const v = world.stream[(start + i) & world.streamMask]; if (v < gmin) gmin = v; if (v > gmax) gmax = v; }
    }
    renderAdPrep(world, a);
    // non-vacuous: the ghost must actually span the big jump.
    assert.ok(gmax - gmin >= AD_JUMP, 'the driven stream must span the big jump J (non-vacuous), got ' + (gmax - gmin));
    assert.equal(world.ghostMax, gmax, 'stepAdGhost must fold the exact running max over every fed value');
    assert.equal(world.ghostMin, gmin, 'stepAdGhost must fold the exact running min over every fed value');
    assert.equal(world.flat[A_GHOSTR], gmax - gmin, 'A_GHOSTR must equal the exact global max-min -- a no-op stepAdGhost leaves it 0 (FAILS here)');
    assert.equal(a.oracleCount, 0, 'the foil (stepAdOracle) was never run -- ghost is genuinely foil-independent');
});

test('index.html adStep calls stepAdGhost OUTSIDE the adFoilOn branch (the ghost is always-run, foil-independent)', () => {
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    const m = /function\s+adStep\s*\(\s*\)\s*\{([^}]*)\}/.exec(html);
    assert.ok(m, 'index.html must define adStep()');
    const body = m[1];
    assert.ok(/stepAdGhost\s*\(\s*adWorld\s*\)/.test(body), 'adStep must call stepAdGhost(adWorld)');
    // the stepAdGhost call must come BEFORE the adFoilOn guard (i.e. unconditional), never inside it.
    const ghostAt = body.indexOf('stepAdGhost');
    const foilAt = body.indexOf('adFoilOn');
    assert.ok(foilAt !== -1, 'adStep must still gate the foil on adFoilOn');
    assert.ok(ghostAt !== -1 && ghostAt < foilAt, 'stepAdGhost must be called OUTSIDE (before) the adFoilOn branch, not gated by it');
});

// extract a function body by brace-matching (handles nested { } that a [^}]* regex cannot).
function extractFnBody(src, name) {
    const start = src.indexOf('function ' + name);
    if (start === -1) return null;
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
    }
    return null;
}

test('D5 index.html ddDraw draws the LATCHED channels: it reads G_LATCH_ON, G_PHL_FIRED / G_CUL_FIRED and the latched cursors + direction, so the latch toggle changes pixels (was: imported-but-unused)', () => {
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    const body = extractFnBody(html, 'ddDraw');
    assert.ok(body, 'index.html must define ddDraw()');
    // the latch DISPLAY flag gates the latched draw (removing it makes the toggle a no-op -> RED).
    assert.ok(/G_LATCH_ON/.test(body), 'ddDraw must read G_LATCH_ON to gate the latched channels');
    // the per-frame fire flags -> one marker / flash per latched fire (blocker 5: were imported but unused).
    assert.ok(/G_PHL_FIRED/.test(body) && /G_CUL_FIRED/.test(body), 'ddDraw must read G_PHL_FIRED / G_CUL_FIRED (fire markers)');
    // the latched cursors + direction arrows come from the latched history buffers.
    assert.ok(/ddPhLH/.test(body) && /ddCuLH/.test(body), 'ddDraw must draw the latched fire cursors (ddPhLH / ddCuLH)');
    assert.ok(/ddLDirH/.test(body), 'ddDraw must draw the lastDirection arrows (ddLDirH)');
});

test('D6 index.html sldDraw draws the B+1 pane strip: B+1 pane cells, the covered span [W, W+W/B] and the TRUE (now-W, now] window bracket with the straddling oldest pane', () => {
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    const body = extractFnBody(html, 'sldDraw');
    assert.ok(body, 'index.html must define sldDraw()');
    // B+1 pane cells (loop over c <= B) + the covered span and true-window brackets.
    assert.ok(/c\s*<=\s*B/.test(body) || /B\s*\+\s*1/.test(body), 'sldDraw must draw B+1 pane cells');
    assert.ok(/straddl/i.test(body), 'sldDraw must mark the straddling oldest pane');
    assert.ok(/trueLeft/.test(body), 'sldDraw must draw the TRUE (now-W, now] window bracket');
    // Q_TRUEW is displayed next to count() in sldTick.
    const tick = extractFnBody(html, 'sldTick');
    assert.ok(tick && /Q_TRUEW/.test(tick), 'sldTick must display Q_TRUEW (the true(W) count)');
});

test('D5/D6 index.html rebuilds do NOT force a reflow: ddRebuild / sldRebuild must NOT call ddLayout() / sldLayout() (blocker 8 -- a slider/select must not thrash layout)', () => {
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    const dd = extractFnBody(html, 'ddRebuild'), sld = extractFnBody(html, 'sldRebuild');
    assert.ok(dd && sld, 'index.html must define ddRebuild() and sldRebuild()');
    assert.ok(!/ddLayout\s*\(/.test(dd), 'ddRebuild must NOT call ddLayout() (forced reflow)');
    assert.ok(!/sldLayout\s*\(/.test(sld), 'sldRebuild must NOT call sldLayout() (forced reflow)');
});

test('D6 index.html sldTick fails closed on NaN: renders "n/a" (never "NaN") and guards className writes with a last value (blocker 7 UI)', () => {
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    const tick = extractFnBody(html, 'sldTick');
    assert.ok(tick, 'index.html must define sldTick()');
    // the frac / cursor className is only written when it changes (last-value guard).
    assert.ok(/sldLastFracCls/.test(tick) && /sldLastCurCls/.test(tick), 'sldTick must guard className writes with a last value');
    // NaN renders "n/a" (via sldFmt / sldPct / putFixed / the cursor's Number.isNaN branch), never "NaN".
    // Behavioral, not a page-wide grep (review B5: /n\/a/ over the whole page could never fail).
    assert.deepEqual(sldNaNFailures(html), [], 'every sld NaN path must render "n/a"');
    // CONTROL with teeth: strip each NaN branch from a copy -> the check goes RED.
    const m1 = html.replace("return Number.isNaN(v) ? 'n/a' : v.toFixed(2);", 'return v.toFixed(2);');
    const m2 = html.replace("return Number.isNaN(v) ? 'n/a' : (v * 100).toFixed(2) + '%';", "return (v * 100).toFixed(2) + '%';");
    const m3 = html.replace("setText(sldDom.cursor, Number.isNaN(cur) ? 'n/a' : ", 'setText(sldDom.cursor, ');
    for (const [name, m] of [['sldFmt', m1], ['sldPct', m2], ['cursor', m3]]) {
        assert.notEqual(m, html, 'control ' + name + ': the mutation must apply (the source line moved?)');
        assert.ok(sldNaNFailures(m).length > 0, 'control ' + name + ': a stripped NaN branch must be caught');
    }
});

// The sld NaN contract, checked by RUNNING the shipped helpers (extracted from index.html) on NaN.
function sldNaNFailures(html) {
    const out = [];
    const ro = loadReadoutHelpers(html);
    const fmt = new Function('return function sldFmt' + fnSource(html, 'sldFmt'))();
    const pct = new Function('return function sldPct' + fnSource(html, 'sldPct'))();
    if (fmt(NaN) !== 'n/a') out.push('sldFmt(NaN) = ' + fmt(NaN));
    if (pct(NaN) !== 'n/a') out.push('sldPct(NaN) = ' + pct(NaN));
    const el = fakeEl();
    ro.putFixed(el, 0, new Float64Array([NaN]), 0, 1, 2, 'x');
    if (el.textContent !== 'n/a') out.push('putFixed(NaN) = ' + el.textContent);
    const tick = extractFnBody(html, 'sldTick') || '';
    if (!/putFixed\(sldDom\.frac,/.test(tick)) out.push('sldDom.frac must go through putFixed (NaN-safe)');
    if (!/setText\(sldDom\.cursor, Number\.isNaN\(cur\) \? 'n\/a' : /.test(tick)) out.push('sldDom.cursor must branch on Number.isNaN');
    return out;
}

// `function name(args) { body }` -> "(args) { body }" (for re-evaluating a pure helper in node).
function fnSource(src, name) {
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start !== -1, 'index.html must define ' + name);
    const paren = src.indexOf('(', start);
    return src.slice(paren, src.indexOf('{', paren)) + '{' + extractFnBody(src, name) + '}';
}

// Evaluate index.html's write-on-change readout block (RO_* + put* / setText / setClass) in isolation.
function loadReadoutHelpers(html) {
    const a = html.indexOf('    // ---- write-on-change readouts');
    const b = html.indexOf('    // Compact integer-ish formatter');
    assert.ok(a !== -1 && b > a, 'index.html must hold the write-on-change readout block before fmtNum');
    return new Function(html.slice(a, b) + '\nreturn { RO_N, putFixed, putInt, putNum, putExp, putSmi, setText, setClass };')();
}

function fakeEl() {
    let text = 'placeholder', cls = '';
    return {
        writes: 0,
        get textContent() { return text; }, set textContent(v) { text = v; this.writes++; },
        get className() { return cls; }, set className(v) { cls = v; this.writes++; },
    };
}

// The write-on-change law (D-S4): after EVERY call the shown text equals the format of the CURRENT value
// (a skipped write never leaves a stale number), an unchanged value writes nothing, NaN <-> number both
// rewrite, and a fresh slot writes even when its first key is 0. Returns the failures (empty = pass).
function readoutLawFailures(html) {
    const out = [];
    const ro = loadReadoutHelpers(html);
    const f = new Float64Array(1);
    let seed = 12345;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    const cases = [[1, 0, ''], [1, 2, 'x'], [100, 2, '%'], [1 / 1024, 1, ' KB'], [1, 3, '']];
    for (let c = 0; c < cases.length; c++) {
        const [scale, d, suf] = cases[c];
        const el = fakeEl(), p = Math.pow(10, d);
        let prev = NaN;
        for (let i = 0; i < 2000; i++) {
            const r = rnd();
            // repeats, tiny moves below the shown digits, NaN, 0, and large jumps
            const v = r < 0.1 ? NaN : r < 0.3 ? prev : r < 0.5 ? (prev === prev ? prev + (rnd() - 0.5) * 3 / (p * scale) : 0) : (rnd() - 0.3) * 1e4;
            f[0] = v;
            const before = el.writes;
            ro.putFixed(el, c, f, 0, scale, d, suf);
            const want = v !== v ? 'n/a' : (Math.round(v * scale * p) / p).toFixed(d) + suf;
            if (el.textContent !== want) { out.push('putFixed case ' + c + ' v=' + v + ': shows ' + el.textContent + ', want ' + want); break; }
            if (i > 0 && Object.is(v, prev) && el.writes !== before) { out.push('putFixed case ' + c + ': an unchanged value rewrote'); break; }
            prev = v;
        }
    }
    // putInt: first key 0 writes; NaN <-> number rewrites both ways
    const el = fakeEl();
    for (const [v, want] of [[0, '0'], [0, '0'], [NaN, 'n/a'], [7.9, '7'], [NaN, 'n/a'], [-3, '-3']]) {
        f[0] = v; ro.putInt(el, 40, f, 0);
        if (el.textContent !== want) out.push('putInt(' + v + ') shows ' + el.textContent + ', want ' + want);
    }
    const e2 = fakeEl(); f[0] = 0; ro.putFixed(e2, 41, f, 0, 1, 2, '');
    if (e2.textContent !== '0.00') out.push('a fresh putFixed slot must write even when its first key is 0, shows ' + e2.textContent);
    return out;
}

test('D-S4 index.html write-on-change readouts: the shown text ALWAYS equals the format of the current value (no stale display), unchanged values write nothing, NaN <-> number rewrites, a 0 first key still writes; every put* slot is unique and < RO_N (B4; review B5 MAJOR 5)', () => {
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    assert.deepEqual(readoutLawFailures(html), [], 'write-on-change law');
    const slots = [...html.matchAll(/put(?:Fixed|Int|Num|Exp|Smi)\(\w+\.\w+, (\d+),/g)].map((m) => +m[1]);
    const { RO_N } = loadReadoutHelpers(html);
    assert.ok(slots.length >= 90, 'the ticks must route their numeric readouts through put* (found ' + slots.length + ')');
    assert.equal(new Set(slots).size, slots.length, 'every put* slot must be unique (a shared slot skips a write)');
    assert.ok(Math.max(...slots) < RO_N, 'every put* slot must be < RO_N');
    // CONTROLS with teeth: drop the digit scale from the key (3-decimal values go stale), and seed the
    // seen-flag (a 0 first key never writes) -- both must be caught.
    const m1 = html.replace('let k = Math.round(x * p);', 'let k = Math.round(x);');
    const m2 = html.replace('const RO_SEEN = new Uint8Array(RO_N);', 'const RO_SEEN = new Uint8Array(RO_N).fill(1);');
    for (const [name, m] of [['no-digit-scale key', m1], ['pre-seen slots', m2]]) {
        assert.notEqual(m, html, 'control ' + name + ': the mutation must apply');
        assert.ok(readoutLawFailures(m).length > 0, 'control ' + name + ': must be caught');
    }
});

test('D2 ADWIN offset invariance (F9): offset 1.7e12 cut indices match offset 0 within +-2, count <= off0 + 1', () => {
    function cuts(off) {
        const w = createAdWorld(0.002, 5, off); const idx = []; let pc = 0;
        for (let fr = 0; fr < 1000; fr++) { stepAd(w); if (w.cuts > pc) { idx.push(w.lastCut); pc = w.cuts; } }
        return idx;
    }
    const c0 = cuts(0), c12 = cuts(1.7e12);
    assert.ok(c0.length > 0, 'the drift stream must fire >= 1 cut (non-vacuous)');
    assert.ok(c12.length <= c0.length + 1, 'cuts at 1.7e12 (' + c12.length + ') must be <= off0 (' + c0.length + ') + 1');
    const n = Math.min(c0.length, c12.length);
    for (let i = 0; i < n; i++) assert.ok(Math.abs(c0[i] - c12[i]) <= 2, 'cut ' + i + ' index must be within +-2 of the offset-0 run');
});

// F18 negative control: an ADWIN pinned to the OLD (pre-F18) running-GLOBAL range R = max-min over ALL raw
// x ever seen (test/witness.mjs GlobalRADWIN). Its inflated R makes the split test go deaf to a small +1
// after a large prior jump -- the MUST-FAIL control that gives the recovery gate its teeth.
class GlobalRADWIN extends ADWIN {
    constructor(delta, options) { super(delta, options); this._gmin = Infinity; this._gmax = -Infinity; }
    add(x) { if (typeof x === 'number') { if (x < this._gmin) this._gmin = x; if (x > this._gmax) this._gmax = x; } return super.add(x); }
    _scanCut() {
        const total = this._total; if (total <= 1) return false;
        const wsum = this._wsum, lnw = Math.log(total), deltaP = this._delta / lnw, ln2dp = Math.log(2 / deltaP);
        const mean = wsum / total; let variance = this._wsumSq / total - mean * mean; if (variance < 0) variance = 0;
        const R = this._gmax - this._gmin;                 // OLD BUG: running-global range, never shrunk
        const head = this._head, next = this._next, bc = this._bcount, sum = this._sum;
        let n0 = 0, sum0 = 0;
        for (let L = this._maxLevel; L >= 0; L--) {
            let node = head[L];
            while (node !== -1) {
                n0 += bc[node]; sum0 += sum[node]; const n1 = total - n0;
                if (n1 > 0) {
                    const m = 1 / (1 / n0 + 1 / n1), mean0 = sum0 / n0, mean1 = (wsum - sum0) / n1;
                    let diff = mean0 - mean1; if (diff < 0) diff = -diff;
                    if (diff > Math.sqrt((2 / m) * variance * ln2dp) + (2 / 3) * (R / m) * ln2dp) return true;
                }
                node = next[node];
            }
        }
        return false;
    }
}

test('D2 ADWIN bigJumpThenPlus1 (F18): item-exact first cut after J recovers within 1.5*d0+10 over 100 seeds; the OLD global-R control goes deaf; snapped window R <= 1+jitter while ghost R >= 1e4', () => {
    // d0(seed): item-exact FIRST-cut delay of a plain +1 shift with NO prior jump on the same-jitter noise,
    // matched to the preset's window size at the +1 point (settle AD_PLUS1_AT items at level 0, then +1).
    // The coarse-bucket cut point is noise-realization sensitive, so d0 is the PER-SEED budget anchor.
    function d0(seed) {
        const ad = new ADWIN(0.002), r = mulberry32(seed);
        for (let i = 0; i < AD_PLUS1_AT; i++) ad.add((r() - 0.5) * AD_PRESET_JITTER);
        for (let j = 0; j < 20000; j++) if (ad.add(1 + (r() - 0.5) * AD_PRESET_JITTER)) return j;   // 0-based
        return Infinity;
    }
    // Item-exact FIRST cut after the +1: replay a fresh instance over the preset stream ONE item at a time.
    // world.lastCut is the LAST cut inside a 32-item frame (ADWIN cuts repeatedly while shedding buckets),
    // a different quantity than the true detection latency -- so the gate replays for the first cut. 0-based
    // to match d0 (Ctor === ADWIN reads UNBOXED via addFrom; the control feeds through its add() override).
    function firstCut(Ctor, world) {
        const ad = new Ctor(0.002), len = world.stream.length;
        for (let i = 0; i < len; i++) {
            const cut = (Ctor === ADWIN) ? ad.addFrom(world.stream, i) : ad.add(world.stream[i]);
            if (cut && i >= AD_PLUS1_AT) return i - AD_PLUS1_AT;
        }
        return Infinity;
    }
    const SEEDS = 100, THRESH = 1 + AD_PRESET_JITTER;
    let over = 0, ctrlDeaf = 0, liverFail = 0, ghostFail = 0, detFail = 0, worstDelay = 0, minGhost = Infinity, maxLiver = 0;
    for (let seed = 0; seed < SEEDS; seed++) {
        const world = createAdWorld(0.002, seed, 0, 'bigJumpThenPlus1');
        const a = createAllocState();
        const dd0 = d0(seed);
        assert.ok(Number.isFinite(dd0), 'baseline +1 must be detected for seed ' + seed + ' (non-vacuous)');
        const budget = 1.5 * dd0 + 10;
        const fc = firstCut(ADWIN, world);
        if (!(fc <= budget)) over++;
        if (fc > worstDelay) worstDelay = fc;
        // the OLD running-global R goes deaf: its item-exact first cut after +1 must MISS the same budget.
        const ctrl = firstCut(GlobalRADWIN, world);
        if (!(ctrl <= budget)) ctrlDeaf++;
        // detection FRAME: step the real world to the first post-+1 cut frame; read the snapped range THERE
        // (renderAdPrep only at that frame keeps the 100-seed sweep cheap; ghost is cumulative in the oracle).
        const total = Math.ceil((AD_PLUS1_AT + 6000) / AD_VALUES_PER_FRAME);
        let det = -1, pc = 0, liverAtDet = NaN, ghostAtDet = NaN;
        for (let fr = 0; fr < total && det < 0; fr++) {
            stepAd(world); stepAdGhost(world); stepAdOracle(world, a);   // ghost owned by stepAdGhost now
            if (world.cuts > pc) { pc = world.cuts; if (world.lastCut > AD_PLUS1_AT) { det = world.lastCut; renderAdPrep(world, a); liverAtDet = world.flat[A_LIVER]; ghostAtDet = world.flat[A_GHOSTR]; } }
        }
        if (det < 0) detFail++;
        // ADWIN cuts at bucket granularity, so the live window may still hold ONE straddling oldest bucket of
        // pre-shift values (R ~1.5) for a few frames -> gate at 1+jitter; fail-closed on NaN. Write the gate
        // as !(x <= b) so a NaN A_LIVER (a broken/absent live-range recompute) COUNTS as a failure instead of
        // slipping through -- !(NaN > b) was true (a false pass); !(NaN <= b) is true (a real fail).
        if (!(liverAtDet <= THRESH)) liverFail++;
        if (!(ghostAtDet >= AD_JUMP)) ghostFail++;
        if (ghostAtDet < minGhost) minGhost = ghostAtDet;
        if (!(liverAtDet <= maxLiver)) maxLiver = liverAtDet;   // NaN-safe max: NaN propagates into the report
    }
    assert.equal(detFail, 0, 'the +1 after J = 1e4 must be detected on every seed (F18 -- 1.6.0 went deaf here)');
    assert.equal(over, 0, over + '/' + SEEDS + ' seeds exceeded 1.5*d0+10 (item-exact first-cut delay; worst ' + worstDelay + ')');
    assert.equal(ctrlDeaf, SEEDS, 'the OLD global-R control must MISS the budget on every seed (gate has teeth), missed ' + ctrlDeaf + '/' + SEEDS);
    assert.equal(liverFail, 0, liverFail + ' seeds had a snapped live-window range R > 1+jitter at detection (max ' + maxLiver.toFixed(3) + ')');
    assert.equal(ghostFail, 0, ghostFail + ' seeds had a ghost global range < 1e4 at detection (min ' + minGhost + ')');
});

test('D2 ADWIN 0-B/op: the real per-frame path (stepAd + stepAdGhost + stepAdOracle) with offset 1.7e12 measures 0 B/call (F9 zero-box)', (t) => {
    const w = createAdWorld(0.002, 5, 1.7e12); const a = createAllocState();
    measure0(t, 'stepAd+ghost+oracle offset 1.7e12', 40000, () => { stepAd(w); stepAdGhost(w); stepAdOracle(w, a); });
});
// renderAdPrep 10Hz cost, honestly: ad.mean / ad.variance DO return fractional doubles that box 16 B when
// their return ESCAPES (the DemoProbe ad_mean_sink / ad_variance_sink controls read 16 B/op). HEAD's
// `return mean` sank such a double across the render boundary and boxed 48 B/call. This build keeps every
// value in a Float64Array slot end to end and returns an int32 fold, so V8 elides the getter returns and
// renderAdPrep measures 0 B/call -- verified below by measureAllocs AND by the DemoProbe steady-state
// 'ad_render_offset' lane (the steady-state probe SEES a transient box; the ad_mean_sink control proves it).
test('D2 ADWIN 0-B/op: renderAdPrep with offset 1.7e12 measures 0 B/call (demo-side return-mean box eliminated; getter returns kept in slots -> elided; DemoProbe ad_render_offset + ad_mean_sink control gate it)', (t) => {
    const w = createAdWorld(0.002, 5, 1.7e12); const a = createAllocState();
    for (let f = 0; f < 300; f++) { stepAd(w); stepAdGhost(w); stepAdOracle(w, a); }   // realistic live width (~1400), bounded
    measure0(t, 'renderAdPrep offset 1.7e12', 2000, () => renderAdPrep(w, a));
});
test('D2 ADWIN 0-B/op: the real per-frame path (stepAd + stepAdGhost + stepAdOracle) with the bigJumpThenPlus1 preset measures 0 B/call', (t) => {
    const w = createAdWorld(0.002, 5, 0, 'bigJumpThenPlus1'); const a = createAllocState();
    measure0(t, 'stepAd+ghost+oracle bigJumpThenPlus1', 40000, () => { stepAd(w); stepAdGhost(w); stepAdOracle(w, a); });
});
// As above -- renderAdPrep keeps the ad.mean / ad.variance getter returns in Float64Array slots, so V8
// elides them and the preset render measures 0 B/call (HEAD boxed 48). Gated by DemoProbe ad_render_preset.
test('D2 ADWIN 0-B/op: renderAdPrep with the bigJumpThenPlus1 preset measures 0 B/call (getter returns kept in slots -> elided; DemoProbe ad_render_preset gates it)', (t) => {
    const w = createAdWorld(0.002, 5, 0, 'bigJumpThenPlus1'); const a = createAllocState();
    for (let f = 0; f < 1300; f++) { stepAd(w); stepAdGhost(w); stepAdOracle(w, a); }   // past the +1, snapped width (~1600), bounded
    measure0(t, 'renderAdPrep bigJumpThenPlus1', 2000, () => renderAdPrep(w, a));
});

test('D1 EH options door fails closed: non-plain object, unknown key (did-you-mean), bad preset / values reject', () => {
    // a valid options object still constructs (non-vacuous).
    assert.doesNotThrow(() => createEhWorld(1024, 0.05, 1, { maxCount: 1024, preset: 'dense10k', values: 'spike' }));
    // non-plain-object doors.
    assert.throws(() => createEhWorld(1024, 0.05, 1, 42), /\[lite-adaptive\].*plain object/, 'a number is not an options object');
    assert.throws(() => createEhWorld(1024, 0.05, 1, [1, 2]), /\[lite-adaptive\].*plain object/, 'an array is not an options object');
    assert.throws(() => createEhWorld(1024, 0.05, 1, new Date()), /\[lite-adaptive\].*plain object/, 'a prototype-bearing object is rejected');
    // unknown own key with a did-you-mean hint.
    assert.throws(() => createEhWorld(1024, 0.05, 1, { maxcount: 1024 }), /unknown option "maxcount".*did you mean "maxCount"/, 'a near-miss key must suggest the intended one');
    assert.throws(() => createEhWorld(1024, 0.05, 1, { valeus: 'spike' }), /unknown option "valeus".*did you mean "values"/, 'a typo key must suggest the intended one');
    assert.throws(() => createEhWorld(1024, 0.05, 1, { epsilon: 0.1 }), /unknown option "epsilon"/, 'a stray key is an error, never a silent ignore');
    // bad enumerated values.
    assert.throws(() => createEhWorld(1024, 0.05, 1, { preset: 'dense5k' }), /EH preset must be null or "dense10k"/, 'an unknown preset must reject');
    assert.throws(() => createEhWorld(1024, 0.05, 1, { values: 'skewed' }), /EH values must be "uniform" or "spike"/, 'an unknown values mode must reject');
});

test('D2 ADWIN knobs fail closed: a non-finite offset and an unknown preset reject before any state write', () => {
    // valid knobs still construct (non-vacuous), incl. an explicit offset 0.
    assert.doesNotThrow(() => createAdWorld(0.002, 5, 0, 'bigJumpThenPlus1'));
    assert.doesNotThrow(() => createAdWorld(0.002, 5, 1.7e12, null));
    // non-finite offsets.
    assert.throws(() => createAdWorld(0.002, 5, NaN), /ADWIN offset must be a finite number/, 'NaN offset must reject (null is not zero)');
    assert.throws(() => createAdWorld(0.002, 5, Infinity), /ADWIN offset must be a finite number/, 'an infinite offset must reject');
    assert.throws(() => createAdWorld(0.002, 5, '1e6'), /ADWIN offset must be a finite number/, 'a string offset must reject');
    // unknown preset.
    assert.throws(() => createAdWorld(0.002, 5, 0, 'bigJump'), /ADWIN preset must be null or "bigJumpThenPlus1"/, 'a near-miss preset must reject');
    assert.throws(() => createAdWorld(0.002, 5, 0, 'drift'), /ADWIN preset must be null or "bigJumpThenPlus1"/, 'an unknown preset must reject');
});

test('D1/D2 retention: 50 rebuild cycles with the new controls stay bounded and rebuild clean', () => {
    for (let cycle = 0; cycle < 50; cycle++) {
        const eh = createEhWorld(1024, 0.05, cycle, { preset: 'dense10k', values: (cycle & 1) ? 'spike' : 'uniform' });
        const ea = createAllocState();
        for (let f = 0; f < 30; f++) { stepEhGuarded(eh); if (eh.failed === 0) stepEhOracle(eh, ea); }
        assert.ok(eh.eh.bucketCount <= eh.eh.capacity, 'cycle ' + cycle + ': EH bucketCount must stay <= capacity');
        const ad = createAdWorld(0.002, cycle, (cycle & 1) ? 1.7e12 : 0, (cycle & 2) ? 'bigJumpThenPlus1' : null);
        const aa = createAllocState();
        for (let f = 0; f < 30; f++) { stepAd(ad); stepAdOracle(ad, aa); }
        assert.ok(ad.ad.bucketCount <= ad.ad.capacity, 'cycle ' + cycle + ': ADWIN bucketCount must stay <= capacity');
    }
});

/* =============================================================================================
 * D3 / D4 (1.8.0) -- HeavyKeeper key-magnitude + weight (F3 / F10); SlidingHyperLogLog twin overflows (F8).
 * Every new displayed number is re-derived from the shipped getters; each new control is proven 0 B/op on
 * the frame path; the append-only golden pins the old slots (HK H_RECALL / H_FOUND declared exceptions).
 * ============================================================================================= */

const HK_KEY_CLASSES = [HK_KEY_SMALL, HK_KEY_BIG, HK_KEY_NEG];

test('D3 HK faithfulness: keymode / weight readouts equal the world; topBuf leaders carry the transformed key class and the shipped estimate', () => {
    for (const km of HK_KEY_CLASSES) {
        const world = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0xD3A, km, 1);
        const a = createAllocState();
        for (let f = 0; f < 2000; f++) { stepHk(world); stepHkOracle(world, a); }
        renderHkPrep(world, a);
        const f = world.flat;
        assert.equal(f[H_KEYMODE], km, 'H_KEYMODE must be the world key mode');
        assert.equal(f[H_WEIGHT], 1, 'H_WEIGHT must be 1');
        const rows = f[H_SIZE] | 0;
        assert.ok(rows > 0, km + ': the top-k forest must have leaders (non-vacuous)');
        for (let r = 0; r < rows; r++) {
            const key = world.topBuf[r * 2];
            assert.ok(Number.isSafeInteger(key), 'every leader key must be a safe integer, got ' + key);
            if (km === HK_KEY_BIG) assert.ok(key >= HK_BIG_OFFSET, 'big-mode leader key must be >= 2^31, got ' + key);
            else if (km === HK_KEY_NEG) assert.ok(key < 0, 'neg-mode leader key must be negative, got ' + key);
            else assert.ok(key >= 0 && key < HK_BIG_OFFSET, 'small-mode leader key must be small, got ' + key);
            assert.equal(world.topBuf[r * 2 + 1], world.hk.estimate(key),
                'leader ' + r + ' estimate must equal the shipped HeavyKeeper.estimate(key)');
        }
    }
});

test('D3 HK recall: topBuf-scan membership recall is 1.0 at weight 1 in every key magnitude class', () => {
    for (const km of HK_KEY_CLASSES) {
        const world = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x8888, km, 1);
        const a = createAllocState();
        for (let f = 0; f < 4000; f++) { stepHk(world); stepHkOracle(world, a); }
        renderHkPrep(world, a);
        assert.ok(world.flat[H_TRUEHH] > 0, km + ': there must be >= 1 true HH above N/k (non-vacuous recall)');
        assert.equal(world.flat[H_RECALL], 1, km + ': recall of true hitters > N/k must be exactly 1.0');
    }
});

test('D3 HK weight 2^32-1: the top estimate == 4294967295, H_SAT == 1, and every topBuf key is the transformed big class', () => {
    const world = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x5A7, HK_KEY_BIG, HK_WEIGHT_MAX);
    const a = createAllocState();
    for (let f = 0; f < 300; f++) { stepHk(world); stepHkOracle(world, a); }
    renderHkPrep(world, a);
    const f = world.flat;
    assert.equal(f[H_WEIGHT], HK_WEIGHT_MAX, 'H_WEIGHT must be 2^32-1');
    assert.equal(f[H_MAXCOUNT], 4294967295, 'the top estimate must saturate at the uint32 ceiling 4294967295');
    assert.equal(f[H_SAT], 1, 'H_SAT must be 1 when the top estimate saturates');
    const rows = f[H_SIZE] | 0;
    assert.ok(rows > 0, 'the forest must have leaders (non-vacuous)');
    for (let r = 0; r < rows; r++) {
        const key = world.topBuf[r * 2];
        assert.ok(Number.isSafeInteger(key) && key >= HK_BIG_OFFSET, 'topBuf key must be a transformed big key (>= 2^31), got ' + key);
        assert.equal(world.topBuf[r * 2 + 1], world.hk.estimate(key), 'leader ' + r + ' estimate must equal the shipped estimate');
    }
    // the H_SAT control: a weight-1 world of the SAME key class must NOT saturate (the flag has teeth).
    const w1 = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x5A7, HK_KEY_BIG, 1);
    const a1 = createAllocState();
    for (let fr = 0; fr < 300; fr++) { stepHk(w1); stepHkOracle(w1, a1); }
    renderHkPrep(w1, a1);
    assert.equal(w1.flat[H_SAT], 0, 'a weight-1 run must NOT saturate -- H_SAT is not always-on');
});

test('D3 HK 0-B/op: stepHk measures 0 B/call in every key magnitude class (F3 zero-box addFrom)', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    for (const [name, km] of [['small', HK_KEY_SMALL], ['>=2^31', HK_KEY_BIG], ['negative', HK_KEY_NEG]]) {
        const w = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x1234, km, 1);
        measure0(t, 'stepHk ' + name, 40000, () => stepHk(w));
    }
});

test('D3 HK 0-B/op: stepHk AND renderHkPrep measure 0 B/call at weight 2^32-1 (big keys)', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const w = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x99, HK_KEY_BIG, HK_WEIGHT_MAX);
    measure0(t, 'stepHk weight 2^32-1', 40000, () => stepHk(w));
    const a = createAllocState();
    for (let i = 0; i < 40; i++) { stepHk(w); stepHkOracle(w, a); }
    measure0(t, 'renderHkPrep weight 2^32-1', 300, () => renderHkPrep(w, a));
});

test('D3 HK control: routing scalar hk.estimate (>= 2^31 keys) through a RETAINING consumer reads > 0 B/call (the render topBuf scan reads 0)', (t) => {
    if (typeof global.gc !== 'function') { t.skip('needs --expose-gc'); return; }
    const w = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x99, HK_KEY_BIG, HK_WEIGHT_MAX);
    const a = createAllocState();
    for (let i = 0; i < 200; i++) { stepHk(w); stepHkOracle(w, a); }
    // renderHkPrep (topBuf scan, NO scalar estimate) is 0-alloc even at big keys -- proven above. The
    // CONTROL below calls scalar hk.estimate on each big-class leader and RETAINS the returned large
    // uint32 (a real consumer collecting per-key counts): the return boxes at the non-inlined call
    // boundary, so the collected path allocates -- the teeth the topBuf-scan render removed.
    const sink = [];
    const variant = () => { const rows = w.hk.topKInto(w.topBuf); for (let r = 0; r < rows; r++) sink.push(w.hk.estimate(w.topBuf[r * 2])); return sink.length; };
    const res = measureAllocs(variant, { iterations: 2000, batches: 3 });
    const bpc = res.bytesPerCall === null ? 0 : res.bytesPerCall;
    process.stdout.write('  scalar-estimate retaining control: ' + bpc.toFixed(3) + ' B/call\n');
    assert.ok(bpc > 0, 'the scalar hk.estimate consumer must allocate (> 0 B/call) -- the render topBuf scan does not');
});

test('D3 HK retention: 40 rebuild cycles across every key class + weight stay bounded and rebuild clean', () => {
    let cy = 0;
    for (const km of HK_KEY_CLASSES) {
        for (const wt of [1, 256, HK_WEIGHT_MAX]) {
            const world = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x700 + cy, km, wt);
            const a = createAllocState();
            for (let f = 0; f < 40; f++) { stepHk(world); stepHkOracle(world, a); }
            assert.ok(world.hk.size > 0 && world.hk.size <= HK_DEFAULT_K, 'cy ' + cy + ': forest must populate within k');
            world.hk.clear();
            assert.equal(world.hk.size, 0, 'cy ' + cy + ': hk.size must return to 0 after clear()');
            cy++;
        }
    }
});

test('D4 SHLL twin overflows (F8) + cadence teeth: renderShllPrep at cadence 1 queries slA once per tick; overflowsA === overflowsB > 0; slaQueryCount == ticks', () => {
    const world = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, 2, 0xF8, 1);   // ringCap 2 forces overflow
    const a = createAllocState();
    // Drive the world's OWN renderShllPrep ticks (NO test-side count()): at cadence 1 the render queries
    // slA once per tick -- that is the query the demo's control governs. Against a PRE-F8 build (m2) where
    // expiry lives in a DESTRUCTIVE count() (not in the add push), those per-tick slA queries evict slA's
    // LFPM rings on a cadence the never-queried slB never sees, so overflowsA diverges from overflowsB.
    // F8 (expiry in add, count() non-destructive) keeps them EQUAL. The reviewer's m2 mutant makes this
    // FAIL -- that is the control.
    let ticks = 0;
    for (let f = 0; f < 2000; f++) { stepShll(world); stepShllOracle(world, a); renderShllPrep(world, a); ticks++; }
    const ovfA = world.flat[S_OVF_A], ovfB = world.flat[S_OVF_B];
    assert.ok(ovfA > 0, 'ringCap 2 must force overflows (non-vacuous), got ' + ovfA);
    assert.equal(ovfA, ovfB, 'F8: the count()-queried twin and the never-queried twin must have EQUAL overflows');
    assert.equal(ovfA, world.sl.overflows, 'S_OVF_A must be the shipped slA.overflows');
    assert.equal(ovfB, world.slB.overflows, 'S_OVF_B must be the shipped slB.overflows');
    assert.equal(world.flat[S_QEVERY], 1, 'S_QEVERY must be the query cadence');
    // the WORLD counted a real slA query per tick (cadence 1): the query-rate control has teeth.
    assert.equal(world.slaQueryCount, ticks, 'at cadence 1 slA must be count()-queried once per render tick, got ' + world.slaQueryCount + ' over ' + ticks);
    // the queried instance's estimate is still honest (non-destructive count()): equal to the never-queried twin.
    assert.equal(world.sl.count(), world.slB.count(), 'count() is non-destructive: both twins report the identical estimate');
});

test('D4 SHLL cadence "never" queries slA ZERO times (blocker 1 teeth): the display comes from slD, so re-adding an unconditional slA.count() to renderShllPrep goes RED here', () => {
    const world = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x4EE, Infinity);
    const a = createAllocState();
    // instrument slA.count() ITSELF with a counting wrapper -- catches ANY query of slA, cadence-fired or a
    // stray unconditional one. The DISPLAY estimate is world.slD.count() (a different instance), so a correct
    // "never" render queries slA zero times. If renderShllPrep is reverted to call the display's estimate
    // off world.sl.count() every tick (the cosmetic-cadence bug), this wrapper fires and the assert is RED.
    const realCount = world.sl.count.bind(world.sl);
    let slaCalls = 0;
    world.sl.count = () => { slaCalls++; return realCount(); };
    for (let f = 0; f < 800; f++) { stepShll(world); stepShllOracle(world, a); renderShllPrep(world, a); }
    assert.equal(world.flat[S_QEVERY], Infinity, 'the cadence must be Infinity ("never")');
    assert.equal(slaCalls, 0, 'at cadence "never" slA.count() must run ZERO times, got ' + slaCalls);
    assert.equal(world.slaQueryCount, 0, 'the world query counter must be 0 at cadence "never"');
    world.sl.count = realCount;   // restore the shipped method before the faithfulness read
    assert.equal(world.flat[S_EST], world.slD.count(), 'the display estimate stays live (from slD) under "never"');
});

test('D4 SHLL 0-B/op: stepShll with the query-every-frame cadence engaged measures 0 B/call (the boxing count() moved OFF the frame path onto the 10Hz tick)', (t) => {
    const w = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x1234, 1);
    measure0(t, 'stepShll query-every-frame', 40000, () => stepShll(w));
});

test('D4 SHLL 0-B/op: stepShll with the twin fed and ringCap 2 (heavy overflow) + query every frame measures 0 B/call', (t) => {
    const w = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, 2, 0x1234, 1);
    measure0(t, 'stepShll ringCap2 query-every', 40000, () => stepShll(w));
});

test('D4 SHLL faithfulness: a cadence-1 world (renderShllPrep queries slA per tick) and a "never" world track EQUAL overflows on the identical stream (F8)', () => {
    // Independent proof: two worlds on the IDENTICAL stream + seed, each driven by its OWN renderShllPrep
    // ticks. `queried` queries slA every tick (cadence 1); `never` queries slA zero times. Against a pre-F8
    // mutant (destructive count()) the per-tick slA queries in `queried` diverge its overflows; F8 keeps
    // them equal -- the query cadence changes nothing observable but the query counter itself.
    const queried = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, 4, 0xEE, 1);
    const never = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, 4, 0xEE, Infinity);
    const qa = createAllocState(), na = createAllocState();
    let ticks = 0;
    for (let f = 0; f < 1500; f++) {
        stepShll(queried); stepShllOracle(queried, qa); renderShllPrep(queried, qa);
        stepShll(never); stepShllOracle(never, na); renderShllPrep(never, na);
        ticks++;
    }
    assert.equal(queried.flat[S_QEVERY], 1, 'the queried world cadence must be 1');
    assert.equal(never.flat[S_QEVERY], Infinity, 'the never world cadence must be Infinity');
    assert.equal(queried.slaQueryCount, ticks, 'the cadence-1 world must have queried slA once per tick, got ' + queried.slaQueryCount);
    assert.equal(never.slaQueryCount, 0, 'the never world must have queried slA zero times, got ' + never.slaQueryCount);
    assert.ok(queried.sl.overflows > 0, 'ringCap 4 must force some overflow (non-vacuous)');
    assert.equal(queried.sl.overflows, never.sl.overflows, 'a per-tick-queried and a never-queried instance must have equal overflows (F8)');
});

/* =============================================================================================
 * D3 / D4 ORACLE-OFF FAIL-CLOSED (blocker 2): with the exact-oracle toggle OFF the oracle-derived
 * readouts must fail closed to NaN inside the KERNEL render-prep (behind world.oracleOn), so a test can
 * drive them -- never in the untested UI tick. Removing the cold branch makes these finite -> RED.
 * ============================================================================================= */

test('D3 HK oracle-off fail-closed: renderHkPrep NaNs recall / true-HH / max-over / bracket / marquee / errs AND the N/k threshold, ~N/w error bound and per-leader true counts when world.oracleOn is false', () => {
    const world = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0xC01D);
    const a = createAllocState();
    for (let f = 0; f < 400; f++) { stepHk(world); stepHkOracle(world, a); }
    // CONTROL (non-vacuous): with the oracle ON every oracle-derived slot is finite.
    renderHkPrep(world, a);
    const f = world.flat;
    assert.ok(Number.isFinite(f[H_RECALL]) && Number.isFinite(f[H_THRESH]) && Number.isFinite(f[H_ERRBOUND]),
        'with the oracle on the oracle-derived slots must be finite (control)');
    assert.ok(Number.isFinite(world.lbTrue[0]), 'a leader true-count must be finite with the oracle on (control)');
    // oracle OFF: fail closed to NaN so a frozen stale Map is never shown as live. Removing the renderHkPrep
    // cold branch (the mutation "HK NaN writes removed") makes these finite -> every assertion below FAILS.
    world.oracleOn = false;
    renderHkPrep(world, a);
    assert.ok(Number.isNaN(f[H_RECALL]), 'H_RECALL must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[H_FOUND]), 'H_FOUND must be NaN with the oracle off (agrees with H_RECALL)');
    assert.ok(Number.isNaN(f[H_TRUEHH]), 'H_TRUEHH must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[H_MAXOVER]), 'H_MAXOVER must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[H_BRACKETOK]), 'H_BRACKETOK must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[H_HKERR]) && Number.isNaN(f[H_SSERR]), 'H_HKERR / H_SSERR must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[H_MARQUEEOK]), 'H_MARQUEEOK must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[H_THRESH]), 'H_THRESH (N/k) must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[H_ERRBOUND]), 'H_ERRBOUND (~N/w) must be NaN with the oracle off');
    const rows = f[H_SIZE] | 0;
    assert.ok(rows > 0, 'there must be leaders to check (non-vacuous)');
    for (let r = 0; r < rows; r++) assert.ok(Number.isNaN(world.lbTrue[r]), 'per-leader true count ' + r + ' must be NaN with the oracle off');
});

test('D4 SHLL oracle-off fail-closed: renderShllPrep NaNs S_TRUE / S_RELERR / S_FRAC when world.oracleOn is false', () => {
    const world = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x0FF);
    const a = createAllocState();
    for (let f = 0; f < 400; f++) { stepShll(world); stepShllOracle(world, a); }
    // CONTROL (non-vacuous): with the oracle on the three oracle-derived slots are finite.
    renderShllPrep(world, a);
    const f = world.flat;
    assert.ok(Number.isFinite(f[S_TRUE]) && Number.isFinite(f[S_RELERR]) && Number.isFinite(f[S_FRAC]),
        'with the oracle on the oracle-derived slots must be finite (control)');
    // oracle OFF: fail closed to NaN. Removing the renderShllPrep cold branch makes these finite -> FAIL.
    world.oracleOn = false;
    renderShllPrep(world, a);
    assert.ok(Number.isNaN(f[S_TRUE]), 'S_TRUE must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[S_RELERR]), 'S_RELERR must be NaN with the oracle off');
    assert.ok(Number.isNaN(f[S_FRAC]), 'S_FRAC must be NaN with the oracle off');
    // the sketch's OWN estimate is still live (the display twin is independent of the oracle).
    assert.ok(Number.isFinite(f[S_EST]), 'S_EST (the sketch display estimate) must stay finite with the oracle off');
});

/* =============================================================================================
 * D3 / D4 FAIL-CLOSED PARAMETERS (blocker 3): a bad keyMode / weight / queryEvery is a tagged throw that
 * fires BEFORE any sketch is constructed (no world returned), with a did-you-mean hint. Reverting the
 * ctor guards removes the throw -> these assert.throws go RED.
 * ============================================================================================= */

test('D3 HK keyMode fail-closed: 5 / -1 / "big" / NaN / 1.5 throw a tagged [lite-adaptive] error and construct NO world; "big" carries the did-you-mean hint', () => {
    for (const km of [5, -1, NaN, 1.5]) {
        let w;
        assert.throws(() => { w = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x1, km); },
            /\[lite-adaptive\]/, 'keyMode ' + String(km) + ' must throw the tagged error');
        assert.equal(w, undefined, 'no world is constructed when keyMode ' + String(km) + ' is rejected (throw before the sketch ctor)');
    }
    assert.throws(() => createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x1, 'big'),
        /did you mean 1\?/, 'a string keyMode "big" must carry the did-you-mean hint');
});

test('D3 HK weight fail-closed: 0 / -1 / 1.5 / NaN / Infinity / "8" / 2^32 throw a tagged [lite-adaptive] error and construct NO world', () => {
    for (const wt of [0, -1, 1.5, NaN, Infinity, '8', 4294967296]) {
        let w;
        assert.throws(() => { w = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x1, HK_KEY_SMALL, wt); },
            /\[lite-adaptive\]/, 'weight ' + String(wt) + ' must throw the tagged error');
        assert.equal(w, undefined, 'no world is constructed when weight ' + String(wt) + ' is rejected');
    }
    // teeth: the saturating ceiling 2^32-1 is VALID (the boundary the 2^32 case is one past).
    assert.doesNotThrow(() => createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x1, HK_KEY_BIG, HK_WEIGHT_MAX),
        'weight 2^32-1 (the ceiling) must construct');
});

test('D4 SHLL queryEvery fail-closed: 0 / -3 / 2.5 / NaN / "8" / -Infinity / 1e300 / QEVERY_MAX+1 throw a tagged [lite-adaptive] error and construct NO world; Infinity and [1, MAX] are valid', () => {
    for (const qe of [0, -3, 2.5, NaN, '8', -Infinity, 1e300, SHLL_QEVERY_MAX + 1]) {
        let w;
        assert.throws(() => { w = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x1, qe); },
            /\[lite-adaptive\]/, 'queryEvery ' + String(qe) + ' must throw the tagged error');
        assert.equal(w, undefined, 'no world is constructed when queryEvery ' + String(qe) + ' is rejected');
    }
    // teeth: Infinity ("never") and the cap are valid; MAX+1 above is the one-past boundary.
    assert.doesNotThrow(() => createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x1, Infinity),
        'queryEvery Infinity ("never") must construct');
    assert.doesNotThrow(() => createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x1, SHLL_QEVERY_MAX),
        'queryEvery == SHLL_QEVERY_MAX (the cap) must construct');
});

/* =============================================================================================
 * D3 / D4 STEADY-STATE PROBE (blocker 2): the demo's measureAllocs gates cannot see a TRANSIENT box.
 * These lanes measure the V8 new-space used-size delta over K ops in a pinned-semi-space child (BOTH
 * --min/--max-semi-space-size=4, asserted inside steadyMin), minus an empty-loop baseline, steady = the
 * MIN over windows 1..n-1. The MUST-BOX control reads ~16 B/op (teeth); every gated per-frame lane reads
 * <= 0.5 B/op steady. Proof the blocker-1 render fix (was 192 B/call) and the blocker-2 stepShll move
 * (was 16 B/frame) are real -- not artifacts measureAllocs was blind to.
 * ============================================================================================= */

test('D3/D4 steady-state probe: the MUST-BOX control reads ~16 B/op and the empty lane ~0 (the probe has teeth)', async () => {
    const box = await runDemoLane('mustbox');
    process.stdout.write('  mustbox steady: ' + box.steady + ' B/op (readings ' + box.readings.join(',') + ')\n');
    assert.ok(box.steady >= 12, 'the must-box control must read >= 12 B/op (a live ~16 B HeapNumber/op), got ' + box.steady);
    const empty = await runDemoLane('noop');
    process.stdout.write('  noop steady: ' + empty.steady + ' B/op\n');
    assert.ok(empty.steady <= 0.5, 'the empty lane must read <= 0.5 B/op, got ' + empty.steady);
});

test('D3 steady-state probe: renderHkPrep + stepHk on BIG (>= 2^31) keys read <= 0.5 B/op (blocker 1: Map.get keyed by the untransformed Smi index, was 192 B/call)', async () => {
    for (const lane of ['hk_render_big', 'hk_step_big', 'hk_render_small']) {
        const r = await runDemoLane(lane);
        process.stdout.write('  ' + lane + ' steady: ' + r.steady + ' B/op (readings ' + r.readings.join(',') + ')\n');
        assert.ok(r.steady <= 0.5, lane + ' must read <= 0.5 B/op steady, got ' + r.steady);
    }
});

test('D4 steady-state probe: stepShll (query-every-frame and never) AND renderShllPrep read <= 0.5 B/op (blocker 2: the count() query moved OFF the frame path; v1.11.0: count() no longer boxes -- estimator tail is argument-free)', async () => {
    for (const lane of ['shll_step_q1', 'shll_step_never']) {
        const r = await runDemoLane(lane);
        process.stdout.write('  ' + lane + ' steady: ' + r.steady + ' B/op (readings ' + r.readings.join(',') + ')\n');
        assert.ok(r.steady <= 0.5, lane + ' must read <= 0.5 B/op steady, got ' + r.steady);
    }
    // renderShllPrep is the 10Hz tick; it reads the display twin through slD.countInto(SHLL_ROW) once per
    // tick (B2; the scalar count() is itself 0-box since 1.11.0, so both shapes read 0 here). Before
    // v1.11.0 this read a documented 16-32 B/op: a stable 16 B inside count()'s estimator tail (the
    // slSigmaInto / slTauInto helpers took the empty / saturated fraction as a computed-double ARGUMENT,
    // which boxes whenever V8 does not inline the helper), plus count()'s returned double at the call
    // boundary. v1.11.0 hands the fraction through the SL_SIG_S / SL_TAU_S slots (argument-free helpers)
    // and keeps every render value in a Float64Array slot, so count() is box-free and this reads 0.
    // Teeth for the 0 live in the SEPARATE mustbox control test (>= 12 B/op), which still holds.
    const rr = await runDemoLane('shll_render');
    process.stdout.write('  shll_render steady: ' + rr.steady + ' B/op (v1.11.0: count() is box-free)\n');
    assert.ok(rr.steady <= 0.5, 'renderShllPrep must read <= 0.5 B/op steady (v1.11.0 count() no longer boxes), got ' + rr.steady);
});

/* =============================================================================================
 * P1 (D1 / D2) STEADY-STATE PROBE (blocker 5): the pinned-semi-space bytes/op probe for the EH / ADWIN
 * hot kernels. Frame lanes (guarded step + oracle; stepAd + stepAdGhost + stepAdOracle) and both render
 * paths must read <= 0.5 B/op steady. renderAdPrep is the honest headline: HEAD's `return mean` boxed 48
 * B/call, and ad.mean / ad.variance DO box 16 B each when their return escapes (ad_mean_sink / ad_variance_
 * sink controls) -- but this build keeps every value in a Float64Array slot, so V8 elides the getter
 * returns and renderAdPrep reads 0. The controls give the 0 its teeth.
 * ============================================================================================= */

test('P1 EH steady-state probe: the per-frame path (stepEhGuarded + stepEhOracle) reads <= 0.5 B/op on default / dense10k / spike, and renderEhPrep (Smi-range getter returns) reads <= 0.5 on spike / dense10k', async () => {
    for (const lane of ['eh_frame_default', 'eh_frame_dense10k', 'eh_frame_spike', 'eh_render_spike', 'eh_render_dense10k']) {
        const r = await runDemoLane(lane);
        process.stdout.write('  ' + lane + ' steady: ' + r.steady + ' B/op (readings ' + r.readings.join(',') + ')\n');
        assert.ok(r.steady <= 0.5, lane + ' must read <= 0.5 B/op steady, got ' + r.steady);
    }
});

test('P1 ADWIN steady-state probe: the per-frame path (stepAd + stepAdGhost + stepAdOracle) reads <= 0.5 B/op on default / offset 1.7e12 / preset', async () => {
    for (const lane of ['ad_frame_default', 'ad_frame_offset', 'ad_frame_preset']) {
        const r = await runDemoLane(lane);
        process.stdout.write('  ' + lane + ' steady: ' + r.steady + ' B/op (readings ' + r.readings.join(',') + ')\n');
        assert.ok(r.steady <= 0.5, lane + ' must read <= 0.5 B/op steady, got ' + r.steady);
    }
});

test('P1 ADWIN renderAdPrep steady-state probe: reads <= 0.5 B/op (default / offset / preset) because the ad.mean / ad.variance getter returns stay in Float64Array slots -- while the ad_mean_sink / ad_variance_sink controls box 16 B (the box is real; renderAdPrep\'s 0 is elision, not a blind probe)', async () => {
    // CONTROLS with teeth: sinking a getter return boxes ~16 B/op -- proof the probe SEES the getter box.
    for (const lane of ['ad_mean_sink', 'ad_variance_sink']) {
        const c = await runDemoLane(lane);
        process.stdout.write('  ' + lane + ' steady: ' + c.steady + ' B/op (the getter-return box)\n');
        assert.ok(c.steady >= 12, lane + ' must box >= 12 B/op (a fractional getter return escaping), got ' + c.steady);
    }
    // GATED: renderAdPrep keeps every value in a slot, so V8 elides the returns -> <= 0.5 B/op.
    for (const lane of ['ad_render_default', 'ad_render_offset', 'ad_render_preset']) {
        const r = await runDemoLane(lane);
        process.stdout.write('  ' + lane + ' steady: ' + r.steady + ' B/op (readings ' + r.readings.join(',') + ')\n');
        assert.ok(r.steady <= 0.5, lane + ' must read <= 0.5 B/op steady (getter returns elided into slots), got ' + r.steady);
    }
});

/* =============================================================================================
 * P3 (D5 / D6) STEADY-STATE PROBE: the pinned-semi-space bytes/op probe for the DD / SLD hot kernels.
 * Frame lanes must read <= 0.5 B/op steady; the SLD render (through quantileInto, F5) and the DD render
 * (through dd.into, 1.11.0) read 0. The MUST-BOX controls sld_quantile_box (the scalar quantile()) and
 * dd_getter_box (the six scalar statistic / mean getters, the pre-1.11.0 render) give each 0 its teeth.
 * ============================================================================================= */

test('P3 DD steady-state probe: stepDd (4 detectors, latched twins engaged) reads <= 0.5 B/op under DEFAULT flags -- the library holds every value in a Float64Array slot end to end, so the frame path is 0 B/op (no --no-maglev exemption)',
    async () => {
    const r = await runDemoLane('dd_frame', 4000, 6);
    process.stdout.write('  dd_frame steady: ' + r.steady + ' B/op (readings ' + r.readings.join(',') + ')\n');
    assert.ok(r.steady <= 0.5, 'dd_frame must read <= 0.5 B/op steady under default flags, got ' + r.steady);
    // NOTE: dd_frame_nolatch does NOT actually disable the latched detectors -- createDdWorld always
    // builds all four and stepDd always feeds them, so the `latch` arg here is only a DISPLAY toggle.
    // Both lanes run the latched-PH twin. Before 1.10.0 both read ~2 B/op in the Maglev tier (the latched-PH
    // fire box, ROADMAP 8); 1.10.0 made a latched PH fire 0 B/op, so this is a real gate, not a todo.
    const c = await runDemoLane('dd_frame_nolatch', 4000, 6);
    process.stdout.write('  dd_frame_nolatch steady: ' + c.steady + ' B/op\n');
    assert.ok(c.steady <= 0.5, 'dd_frame_nolatch must read <= 0.5 B/op steady under default flags, got ' + c.steady);
});

test('P4 SCM heavy-count probe: stepScm + stepScmOracle (one 2^30 heavy addFrom per frame) and renderScmPrep (estimateInto + total(), tracked key 0 > 2^31) each read <= 0.5 B/op, while the scalar estimate() of that key (scm_estimate_box control) boxes >= 12 -- the render 0 is estimateInto, not a blind probe', async () => {
    for (const lane of ['scm_frame_heavy', 'scm_render_heavy']) {
        const r = await runDemoLane(lane);
        process.stdout.write('  ' + lane + ' steady: ' + r.steady + ' B/op (readings ' + r.readings.join(',') + ')\n');
        assert.ok(r.steady <= 0.5, lane + ' must read <= 0.5 B/op steady, got ' + r.steady);
    }
    const c = await runDemoLane('scm_estimate_box');
    process.stdout.write('  scm_estimate_box steady: ' + c.steady + ' B/op (the F6 scalar estimate() box)\n');
    assert.ok(c.steady >= 12, 'scm_estimate_box control must box >= 12 B/op, got ' + c.steady);
});

test('P4 SCM render probe under --no-turbo-inlining: renderScmPrep reads <= 0.5 B/op even when NO callee is inlined -- C_TOTAL is summed in the render body, never a scm.total() call whose > 2^31 return boxes 16 B at a non-inlined boundary (the 2026-10-04 1-in-5 flake: readings 16,16,16,16,16); the scm_estimate_box control boxes >= 12 under the same flag', async () => {
    const NOINLINE = ['--no-turbo-inlining'];
    const r = await runDemoLane('scm_render_heavy', 4000, 5, NOINLINE);
    process.stdout.write('  scm_render_heavy (--no-turbo-inlining) steady: ' + r.steady + ' B/op (readings ' + r.readings.join(',') + ')\n');
    // FAIL CLOSED: the flag must have reached the child, or this is the default-flags gate run twice.
    assert.ok(Array.isArray(r.execArgv) && r.execArgv.includes('--no-turbo-inlining'),
        'child did NOT receive --no-turbo-inlining (execArgv=' + JSON.stringify(r.execArgv) + ')');
    assert.ok(r.steady <= 0.5, 'scm_render_heavy must read <= 0.5 B/op steady under --no-turbo-inlining, got ' + r.steady);
    const c = await runDemoLane('scm_estimate_box', 4000, 5, NOINLINE);
    process.stdout.write('  scm_estimate_box (--no-turbo-inlining) steady: ' + c.steady + ' B/op\n');
    assert.ok(c.execArgv.includes('--no-turbo-inlining'), 'control child did NOT receive --no-turbo-inlining');
    assert.ok(c.steady >= 12, 'scm_estimate_box control must box >= 12 B/op under --no-turbo-inlining, got ' + c.steady);
});

test('P3 DD render probe: renderDdPrep reads all four detectors through dd.into(row) (1.11.0) at <= 0.5 B/op, while the old six-getter render shape (dd_getter_box control) still boxes >= 12 B/op -- the 0 is the reader, not a blind probe', async () => {
    const r = await runDemoLane('dd_render');
    process.stdout.write('  dd_render steady: ' + r.steady + ' B/op (dd.into row)\n');
    assert.ok(r.steady <= 0.5, 'renderDdPrep must read <= 0.5 B/op through dd.into, got ' + r.steady);
    const c = await runDemoLane('dd_getter_box');
    process.stdout.write('  dd_getter_box steady: ' + c.steady + ' B/op (six scalar getters; the pre-1.11.0 render)\n');
    assert.ok(c.steady >= 12, 'dd_getter_box control must box >= 12 B/op, got ' + c.steady);
});

test('P3 SLD steady-state probe: stepSld (range + strict modes) reads <= 0.5 B/op, and renderSldPrep through quantileInto (F5) reads <= 0.5 -- while the scalar quantile() control boxes ~16 B (the render 0 is genuine elision)', async () => {
    for (const lane of ['sld_frame_range', 'sld_frame_strict', 'sld_render']) {
        const r = await runDemoLane(lane);
        process.stdout.write('  ' + lane + ' steady: ' + r.steady + ' B/op (readings ' + r.readings.join(',') + ')\n');
        assert.ok(r.steady <= 0.5, lane + ' must read <= 0.5 B/op steady, got ' + r.steady);
    }
    // CONTROL with teeth: the scalar sd.quantile() keeps its documented one boxed return (~16 B/call).
    const c = await runDemoLane('sld_quantile_box');
    process.stdout.write('  sld_quantile_box steady: ' + c.steady + ' B/op (the documented scalar quantile() box)\n');
    assert.ok(c.steady >= 12, 'sld_quantile_box must box >= 12 B/op (the scalar quantile return), got ' + c.steady);
});

/* =============================================================================================
 * SCENE 10 -- SlidingAggregate (exact windowed count / sum / mean / min / max; D9 -> demo session B7a)
 * ============================================================================================= */

// From-spec SA truth, recomputed from the DETERMINISTIC stream (event j of frame f sits at
// f * SA_DT + (j + 1) * SA_DT / K with value vals[pos] (x SA_SPIKE_MULT when that frame had spikes on and
// spike[pos])), never from the kernel's oracle ring. Covered span: paneEnd(t) > now - W (ADR 0012).
function saSpecTruth(world, frameSpikes) {
    const K = SA_EVENTS_PER_FRAME, step = SA_DT / K, pw = world.W / world.panes, cut = world.now - world.W;
    let c = 0, s = 0, mn = Infinity, mx = -Infinity, cw = 0, sw = 0, pos = 0;
    for (let f = 0; f < frameSpikes.length; f++) {
        const frameNow = frameSpikes[f][0];
        for (let j = 0; j < K; j++, pos++) {
            const i = pos & world.streamMask;
            const t = frameNow + (j + 1) * step;
            const v = (frameSpikes[f][1] && world.spike[i] === 1) ? world.vals[i] * SA_SPIKE_MULT : world.vals[i];
            if ((Math.floor(t / pw) + 1) * pw > cut) {
                c++; s += v; if (v < mn) mn = v; if (v > mx) mx = v;
                if (t > cut) { cw++; sw += v; }
            }
        }
    }
    return { c, s, mn: c ? mn : NaN, mx: c ? mx : NaN, cw, sw };
}

test('SA exactness vs the from-spec truth: on EVERY render (W 1000 / 4000 x spikes off / on, spikes toggled mid-run) the SlidingAggregate row equals a recount from the stream exactly (count / sum / min / max; mean = sum / count), the oracle row agrees, and L_EXACT is 1', () => {
    for (const W of [1000, 4000]) {
        for (const spikes of [false, true]) {
            const world = createSaWorld(W, SA_DEFAULT_PANES);
            const a = createAllocState(), frames = [];
            let renders = 0;
            for (let f = 0; f < 700; f++) {
                world.spikes = spikes && f > 150;                 // toggled mid-run
                frames.push([world.now, world.spikes]);
                stepSa(world); stepSaOracle(world, a);
                if (f % 11 !== 0 || f < 120) continue;
                renderSaPrep(world, a); renderSaEhPrep(world);
                renders++;
                const t = saSpecTruth(world, frames), fl = world.flat, tag = 'W=' + W + ' spikes=' + spikes + ' frame ' + f;
                assert.equal(fl[L_COUNT], t.c, tag + ': count'); assert.equal(fl[L_SUM], t.s, tag + ': sum');
                assert.equal(fl[L_MIN], t.mn, tag + ': min'); assert.equal(fl[L_MAX], t.mx, tag + ': max');
                assert.equal(fl[L_MEAN], t.s / t.c, tag + ': mean');
                assert.equal(fl[L_TCOUNT], t.c, tag + ': oracle count'); assert.equal(fl[L_TSUM], t.s, tag + ': oracle sum');
                assert.equal(fl[L_TSUMW], t.sw, tag + ': oracle true-window sum');
                assert.equal(fl[L_EXACT], 1, tag + ': L_EXACT');
            }
            assert.ok(renders >= 50, 'non-vacuous');
        }
    }
});

test('SA faithfulness: every row slot read through sa.into is Object.is the scalar getter (count / sum / mean / min / max); the EH contrast slots are eh.sum() and eh.sum() / eh.count()', () => {
    const world = createSaWorld(SA_DEFAULT_W, SA_DEFAULT_PANES);
    world.spikes = true;
    const a = createAllocState();
    for (let f = 0; f < 400; f++) { stepSa(world); stepSaOracle(world, a); }
    renderSaPrep(world, a); renderSaEhPrep(world);
    const fl = world.flat, sa = world.sa, eh = world.eh;
    for (const [slot, want, name] of [[L_COUNT, sa.count(), 'count'], [L_SUM, sa.sum(), 'sum'], [L_MEAN, sa.mean(), 'mean'], [L_MIN, sa.min(), 'min'], [L_MAX, sa.max(), 'max'], [L_EHSUM, eh.sum(), 'eh.sum']]) {
        assert.ok(Object.is(fl[slot], want), name + ': slot ' + fl[slot] + ' must be Object.is ' + want);
    }
    assert.equal(fl[L_EHMEAN], eh.sum() / eh.count(), 'EH mean = eh.sum() / eh.count()');
});

test('SA vs EH (F17): with spikes ON, EH sum() relative error vs the true window exceeds its epsilon on some renders while SlidingAggregate stays exact on all; with spikes OFF EH stays within epsilon -- the scene shows a real failure, not a staged one', () => {
    for (const spikes of [true, false]) {
        const world = createSaWorld(SA_DEFAULT_W, SA_DEFAULT_PANES);
        world.spikes = spikes;
        const a = createAllocState();
        let over = 0, exact = 0, renders = 0;
        for (let f = 0; f < 1200; f++) {
            stepSa(world); stepSaOracle(world, a);
            if (f % 6 !== 0 || f < 120) continue;
            renderSaPrep(world, a); renderSaEhPrep(world); renders++;
            if (world.flat[L_EHREL] > SA_EH_EPS) over++;
            if (world.flat[L_EXACT] === 1) exact++;
        }
        assert.equal(exact, renders, 'SlidingAggregate exact on every render (spikes=' + spikes + ')');
        if (spikes) {
            assert.ok(over > 0, 'spikes on: EH sum() must exceed epsilon on some render (F17), got ' + over);
            assert.ok(world.flat[L_EHRELMAX] > SA_EH_EPS, 'the running max shows the breach, got ' + world.flat[L_EHRELMAX]);
        } else {
            assert.equal(over, 0, 'spikes off: EH stays within epsilon (got ' + over + ' breaches)');
        }
    }
});

test('SA idle-slide + fail-closed: pausing slides count / sum to 0 and mean / min / max to NaN (null is not zero); oracle OFF NaNs every oracle slot; turning it back on HOLDS NaN until a full covered span (W + W/B) refills', () => {
    const world = createSaWorld(SA_DEFAULT_W, SA_DEFAULT_PANES);
    const a = createAllocState();
    for (let f = 0; f < 200; f++) { stepSa(world); stepSaOracle(world, a); }
    world.oracleOn = false;
    for (let f = 0; f < 30; f++) stepSa(world);                       // the UI skips the oracle step while off
    renderSaPrep(world, a); renderSaEhPrep(world);
    for (const s of [L_TCOUNT, L_TSUM, L_TMEAN, L_TMIN, L_TMAX, L_EXACT, L_TSUMW, L_EHREL, L_EHRELMAX]) assert.ok(Number.isNaN(world.flat[s]), 'oracle off: slot ' + s + ' must be NaN');
    assert.ok(world.flat[L_COUNT] > 0, 'the sketch row stays live with the oracle off');
    world.oracleOn = true; world.resumeNow = world.now;
    stepSa(world); stepSaOracle(world, a); renderSaPrep(world, a); renderSaEhPrep(world);
    assert.ok(Number.isNaN(world.flat[L_EXACT]), 'resume hold: the half-refilled ring must not claim exactness');
    const framesToRefill = Math.ceil((SA_DEFAULT_W + SA_DEFAULT_W / SA_DEFAULT_PANES) / SA_DT) + 1;
    for (let f = 0; f < framesToRefill; f++) { stepSa(world); stepSaOracle(world, a); }
    renderSaPrep(world, a); renderSaEhPrep(world);
    assert.equal(world.flat[L_EXACT], 1, 'after a full covered span the oracle is valid and exact again');
    world.paused = true;
    for (let f = 0; f < 120; f++) { stepSa(world); stepSaOracle(world, a); }
    renderSaPrep(world, a); renderSaEhPrep(world);
    assert.equal(world.flat[L_COUNT], 0, 'paused: count slides to 0'); assert.equal(world.flat[L_SUM], 0, 'paused: sum slides to 0');
    for (const s of [L_MEAN, L_MIN, L_MAX]) assert.ok(Number.isNaN(world.flat[s]), 'paused: slot ' + s + ' must be NaN on an empty window');
    assert.equal(world.flat[L_EXACT], 1, 'empty window: sketch and oracle agree (both empty)');
});

test('SA boundary: a bad W / panes fails closed at the library ctor; a W / panes that makes a subnormal pane width is rejected', () => {
    assert.throws(() => createSaWorld(0, SA_DEFAULT_PANES), /\[lite-adaptive\]/, 'W=0');
    assert.throws(() => createSaWorld(SA_DEFAULT_W, 1), /\[lite-adaptive\]/, 'panes<2');
    assert.throws(() => createSaWorld(1e-320, 32), /\[lite-adaptive\]/, 'subnormal pane width');
    assert.doesNotThrow(() => createSaWorld(4000, 32), 'the widest slider W constructs');
});

test('P5 SA probe: stepSa + stepSaOracle (spikes on), renderSaPrep (sa.into + the exact oracle scan) and renderSaEhPrep (the EH contrast) each read <= 0.5 B/op, while the scalar sa.mean() (sa_mean_box control) boxes >= 12 -- the render 0 is sa.into, not a blind probe', async () => {
    for (const lane of ['sa_frame', 'sa_render']) {
        const r = await runDemoLane(lane);
        process.stdout.write('  ' + lane + ' steady: ' + r.steady + ' B/op (readings ' + r.readings.join(',') + ')\n');
        assert.ok(r.steady <= 0.5, lane + ' must read <= 0.5 B/op steady, got ' + r.steady);
    }
    const c = await runDemoLane('sa_mean_box');
    process.stdout.write('  sa_mean_box steady: ' + c.steady + ' B/op (the scalar fractional mean() box)\n');
    assert.ok(c.steady >= 12, 'sa_mean_box control must box >= 12 B/op, got ' + c.steady);
    // The EH contrast (eh.count() / eh.sum() return half-bucket x.5 doubles) also reads 0: each return is
    // stored straight into a Float64Array slot (world.ehAcc), so V8 elides the box.
    const e = await runDemoLane('sa_eh_render');
    process.stdout.write('  sa_eh_render steady: ' + e.steady + ' B/op (EH contrast)\n');
    assert.ok(e.steady <= 0.5, 'renderSaEhPrep must read <= 0.5 B/op steady, got ' + e.steady);
});

test('Scene 10 index.html wiring: a tab + section + keyboard "0"; the loop steps / draws it; saTick renders through renderSaPrep THEN renderSaEhPrep and writes every readout via put* / setText; layoutActive sizes it; the oracle toggle sets resumeNow (the refill hold); a rebuild never calls saLayout()', () => {
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    assert.match(html, /<button data-tab="sa">/, 'a Scene 10 tab button');
    assert.match(html, /<section class="scene" data-scene="sa">/, 'a Scene 10 section');
    assert.match(html, /e\.key === '0'\) activate\('sa'\)/, 'keyboard 0 -> sa');
    const loop = extractFnBody(html, 'loop');
    assert.match(loop, /activeScene === 'sa'\) \{\s*if \(!paused\) saStep\(\);\s*saDraw\(\);/, 'the frame loop steps sa under the global pause (space bar) and draws it');
    assert.match(loop, /activeScene === 'sa'\) saTick\(\);/, 'the 10Hz mask ticks sa');
    const tick = extractFnBody(html, 'saTick');
    assert.ok(tick.indexOf('renderSaPrep(') !== -1 && tick.indexOf('renderSaEhPrep(') > tick.indexOf('renderSaPrep('), 'saTick: renderSaPrep then renderSaEhPrep (the EH error needs the oracle true-window sum)');
    assert.ok(!/\.textContent =|\.className =/.test(tick), 'saTick writes only through put* / setText / setClass');
    assert.match(extractFnBody(html, 'layoutActive'), /tab === 'sa'\) \{\s*saLayout\(\);\s*saPanels\(\);/, 'layoutActive sizes sa');
    assert.ok(!/saLayout\s*\(/.test(extractFnBody(html, 'saRebuild')), 'saRebuild must NOT call saLayout() (forced reflow)');
    assert.match(html, /if \(on && !saWorld\.oracleOn\) saWorld\.resumeNow = saWorld\.now;/, 'turning the oracle back on starts the refill hold');
});

test('S11 key-magnitude lane self-test: no meter -> "absent"; a meter that cannot see the boxing control -> "blind" (never a 0 reading); every non-ok text starts with "n/a" and claims no B/op number for the key lanes', () => {
    for (const m of [undefined, null, 42, () => NaN, () => 'x']) {
        const r = runKeyMagLane(m, 2000);
        assert.equal(r.state, 'absent', 'meter ' + String(m) + ' -> absent');
        assert.match(keyMagText(r), /^n\/a \(no performance\.memory/, 'absent text');
    }
    // A BLIND meter (constant, or quantized coarser than the control) must never produce an "ok" 0.
    for (const blind of [() => 1e6, () => 4096 * Math.floor(process.memoryUsage().heapUsed / 4096 / 1e6)]) {
        const r = runKeyMagLane(blind, 5000);
        assert.equal(r.state, 'blind', 'a blind meter must be detected, got ' + r.state);
        assert.ok(Number.isNaN(r.small) && Number.isNaN(r.big31), 'blind: the key lanes are NaN, never 0');
        const t = keyMagText(r);
        assert.match(t, /^n\/a \(meter blind/, 'blind text');
        assert.ok(!/keys \d/.test(t), 'blind text must not print a key-lane number: ' + t);
    }
    assert.equal(KM_CONTROL_MIN, 8, 'the control floor (DEMO.md item 6)');
});

test('S11 key-magnitude lane with a real heap meter (node heapUsed): the control is SEEN (>= 8 B/op) and HeavyKeeper.addFrom reads ~0 for small AND [2^30, 2^31) keys (this Node has 32-bit Smis -- the Chromium number comes from the page)', () => {
    let r = null;
    for (let attempt = 0; attempt < 4 && (!r || r.state !== 'ok'); attempt++) r = runKeyMagLane(() => process.memoryUsage().heapUsed);
    assert.equal(r.state, 'ok', 'the node heap meter must see the boxing control in >= 1 of 4 attempts (control read ' + r.control + ')');
    assert.ok(r.control >= KM_CONTROL_MIN, 'control >= 8 B/op, got ' + r.control);
    assert.ok(r.small >= 0 && r.small <= 2 && r.big31 >= 0 && r.big31 <= 2, 'addFrom must read ~0 B/op (two-sided: a negative reading is a scavenge, never a value) for both key classes here, got ' + r.small + ' / ' + r.big31);
    for (const lane of ['small', 'big31', 'control']) assert.equal(r.raw[lane].length, 8, 'raw windows are returned for the record');
    // ROADMAP 13 N1: the ok text prints all four key classes (the one deliberate S11 text change)
    assert.match(keyMagText(r), /^small keys \d+\.\d B\/op \| \[2\^30, 2\^31\) keys \d+\.\d B\/op \| >= 2\^31 keys \d+\.\d B\/op \| negative keys \d+\.\d B\/op \(control \d+\.\d\)$/, 'ok text format');
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    assert.match(html, /\$\('hk-smi31-run'\)\.addEventListener\('click', \(\) => \{[\s\S]*?runKeyMagLane\([\s\S]*?keyMagText\(r\)/, 'index.html runs the lane ON CLICK only and renders keyMagText');
    assert.ok(!/runKeyMagLane/.test(extractFnBody(html, 'loop')), 'never on the frame path');
});

test('S11 N1 (ROADMAP 13): runKeyMagLane(meter, ops, member) measures every hashed-key member (hk / shll / scm) over four key classes; with the node heap meter the control is SEEN and every class reads ~0 B/op (two-sided) for every member; the default member is hk', () => {
    assert.deepEqual(KM_MEMBERS, ['hk', 'shll', 'scm']);
    assert.deepEqual(KM_CLASSES, ['small', 'big31', 'big32', 'neg']);
    assert.ok(KM_WINDOW_W >= 1e9, 'the explicit-time members never rotate a pane inside a run');
    for (const member of KM_MEMBERS) {
        let r = null;
        for (let attempt = 0; attempt < 4 && (!r || r.state !== 'ok'); attempt++) r = runKeyMagLane(() => process.memoryUsage().heapUsed, undefined, member);
        assert.equal(r.state, 'ok', member + ': the node heap meter must see the control in >= 1 of 4 attempts (control read ' + r.control + ')');
        assert.equal(r.member, member);
        assert.ok(r.control >= KM_CONTROL_MIN, member + ': control >= 8 B/op, got ' + r.control);
        for (const c of KM_CLASSES) {
            assert.ok(r[c] >= 0 && r[c] <= 2, member + ' ' + c + ' keys: addFrom must read ~0 B/op (two-sided), got ' + r[c]);
            assert.equal(r.raw[c].length, 8, member + ' ' + c + ': raw windows are returned for the record');
        }
    }
    assert.equal(runKeyMagLane(undefined, 100).member, 'hk', 'default member');
    for (const bad of ['HK', 'sld', null, 0]) assert.throws(() => runKeyMagLane(() => 1, 100, bad), /\[demo\] runKeyMagLane member/, 'unknown member ' + String(bad) + ' throws');
});

test('S11 N1 self-test per member: no meter -> "absent", a constant (blind) meter -> "blind", a meter whose every window is scavenged -> "blind"; every non-ok result NaNs all four key classes (null is not zero) and its text prints no key-lane number', () => {
    for (const member of KM_MEMBERS) {
        const a = runKeyMagLane(undefined, 300, member);
        assert.equal(a.state, 'absent', member + ' absent');
        let calls = 0, heap = 1e8;
        const meters = [() => 1e6, () => { calls++; heap += (calls % 2 === 0) ? -50000 : 0; return heap; }];
        const rs = [a];
        for (const m of meters) rs.push(runKeyMagLane(m, 1000, member));
        for (let i = 1; i < rs.length; i++) assert.equal(rs[i].state, 'blind', member + ' meter #' + i + ' -> ' + rs[i].state + ' ' + keyMagText(rs[i]));
        for (const r of rs) {
            for (const c of KM_CLASSES) assert.ok(Number.isNaN(r[c]), member + ' ' + r.state + ': ' + c + ' must be NaN, got ' + r[c]);
            const t = keyMagText(r);
            assert.match(t, /^n\/a \(/);
            assert.ok(!/keys -?\d/.test(t), member + ': non-ok text prints a key-lane number: ' + t);
        }
    }
});

test('S11 N2 (ROADMAP 13): the "measure all" button renders one row per member in KM_MEMBERS order, ON CLICK only, each through keyMagText + keyMagClass; keyMagClass is green ONLY for an ok result whose every key class is <= KM_CLEAN_MAX (a box is never green, absent / blind is neutral)', () => {
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    assert.match(html, /const \$KM_ROWS = \[\$\('hk-smi31'\), \$\('hk-smi31-shll'\), \$\('hk-smi31-scm'\)\];/, 'rows cached at init, in KM_MEMBERS order');
    for (const id of ['hk-smi31', 'hk-smi31-shll', 'hk-smi31-scm']) assert.equal(html.split('id="' + id + '"').length, 2, id + ': exactly one element');
    assert.match(html, /\$\('hk-smi31-run'\)\.addEventListener\('click', \(\) => \{[\s\S]*?runKeyMagLane\(meter, undefined, KM_MEMBERS\[i\]\)[\s\S]*?\$KM_ROWS\[i\]\.textContent = keyMagText\(r\);\s*\$KM_ROWS\[i\]\.className = keyMagClass\(r\);/, 'one runKeyMagLane per member, rendered per row');
    assert.match(html, />measure all</);
    assert.equal(KM_CLEAN_MAX, 2);
    const ok = { state: 'ok', control: 12, small: 0, big31: 0, big32: 0, neg: 0 };
    assert.equal(keyMagClass(ok), 'v inband');
    for (const c of KM_CLASSES) {
        assert.equal(keyMagClass({ ...ok, [c]: 12 }), 'v outband', c + ' boxing (12 B/op) must be outband');
        assert.equal(keyMagClass({ ...ok, [c]: NaN }), 'v outband', c + ' NaN in an ok result is never green');
    }
    assert.equal(keyMagClass({ state: 'blind', control: 0, small: NaN, big31: NaN, big32: NaN, neg: NaN }), 'v');
    assert.equal(keyMagClass({ state: 'absent', control: NaN, small: NaN, big31: NaN, big32: NaN, neg: NaN }), 'v');
});

test('S11 N4 (review): kmDidWork proves a key window reached addFrom (a skipped window would read a perfect 0) -- false on a fresh sketch, true after one addFrom; a "nowork" result is non-ok, NaN in every class, and its text is n/a; the negative class is below the 31-bit Smi minimum', () => {
    assert.equal(KM_NEG_BASE, -(2 ** 30) - 1, 'negative keys start at -(2^30 + 1): a HeapNumber on a 31-bit-Smi build');
    const hk = new HeavyKeeper(4, 1024, 12), b2 = new Float64Array(2);
    b2[0] = KM_NEG_BASE; b2[1] = 1;
    assert.equal(kmDidWork('hk', hk, b2, 3), false, 'hk: no addFrom yet');
    hk.addFrom(b2, 0);
    assert.equal(kmDidWork('hk', hk, b2, 3), true, 'hk: after one addFrom in the negative class');
    assert.equal(kmDidWork('hk', hk, b2, 1), false, 'hk: the [2^30, 2^31) class is disjoint -- still no work there');
    const sl = new SlidingHyperLogLog(KM_WINDOW_W, { p: 11 }), s2 = new Float64Array(2);
    s2[0] = 5; s2[1] = 7;
    assert.equal(kmDidWork('shll', sl, s2, 0), false, 'shll: no addFrom yet');
    sl.addFrom(s2, 0);
    assert.equal(kmDidWork('shll', sl, s2, 0), true, 'shll: after addFrom');
    s2[0] = 6;
    assert.equal(kmDidWork('shll', sl, s2, 0), false, 'shll: a window that advanced now but skipped addFrom');
    const scm = new SlidingCountMin(KM_WINDOW_W, { epsilon: 0.02, panes: 32 }), c3 = Float64Array.of(5, 7, 1);
    assert.equal(kmDidWork('scm', scm, c3, 0), false, 'scm: no addFrom yet');
    scm.addFrom(c3, 0);
    assert.equal(kmDidWork('scm', scm, c3, 0), true, 'scm: after addFrom');
    const nw = { state: 'nowork', control: NaN, small: NaN, big31: NaN, big32: NaN, neg: NaN, raw: null };
    assert.match(keyMagText(nw), /^n\/a \(a key window did no addFrom work/);
    assert.equal(keyMagClass(nw), 'v');
});

test('S11 kmAggregate (review B9 BLOCKER 1): a NEGATIVE window is a scavenge -- dropped, never clamped to 0; fewer than KM_MIN_CLEAN clean windows -> NaN (blind); a box present in every clean window shows in full; ONE outlier window is discarded', () => {
    assert.equal(KM_MIN_CLEAN, 3);
    // the reviewer's fail-open: a lane that boxes 16 B/op but has a scavenge in EVERY window must be blind, never "0.0"
    assert.ok(Number.isNaN(kmAggregate(Float64Array.of(-48.7, -16.8, -64.7, -9.1, -3.0))), 'all windows scavenged -> NaN');
    assert.ok(Number.isNaN(kmAggregate(Float64Array.of(16, -50, 16, -40, -30))), '2 clean windows < KM_MIN_CLEAN -> NaN');
    assert.equal(kmAggregate(Float64Array.of(16, -50, 16, -40, 16)), 16, 'a box in every clean window shows in full');
    assert.equal(kmAggregate(Float64Array.of(0.9, 0, 0, 0, 0, 0, 0, 0)), 0, 'one JIT tier-up outlier is discarded');
    assert.equal(kmAggregate(Float64Array.of(12, 12, -66.5, 12, 12)), 12, 'the measured Chrome control shape -> 12');
    assert.ok(Number.isNaN(kmAggregate(Float64Array.of(NaN, NaN, NaN, 1))), 'NaN windows are not clean');
    // end to end: a meter that UNDER-reads every key window (a scavenge per window) -> blind, never an ok 0
    let calls = 0, heap = 1e8;
    const scavengingMeter = () => { calls++; heap += (calls % 2 === 0) ? -50000 : 0; return heap; };   // every window reads negative
    const r = runKeyMagLane(scavengingMeter, 1000);
    assert.equal(r.state, 'blind', 'a meter whose every window is scavenged must be blind, got ' + r.state + ' ' + keyMagText(r));
    assert.match(keyMagText(r), /^n\/a \(meter blind/);
});

test('SCM oracle off / resume hold (review B9 BLOCKER 5): with the exact ring skipped, renderScmPrep NaNs C_BOUNDOK / C_NLIVE / C_TOTALOK and every tracked true(W) / upper (never a false "VIOLATED"); the estimates and total() stay live; back on, the NaNs HOLD until a full covered span refills, then the bound and total() check pass again', () => {
    const world = createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 0x0FF);
    const a = createAllocState();
    for (let f = 0; f < 200; f++) { stepScm(world); stepScmOracle(world, a); }
    world.oracleOn = false;
    for (let f = 0; f < 10; f++) stepScm(world);                         // the UI skips the oracle step while off
    renderScmPrep(world, a);
    const fl = world.flat;
    for (const s of [C_BOUNDOK, C_NLIVE, C_TOTALOK]) assert.ok(Number.isNaN(fl[s]), 'oracle off: slot ' + s + ' must be NaN');
    for (let k = 0; k < SCM_TRACKED; k++) {
        assert.ok(Number.isNaN(fl[k * SCM_STRIDE + 1]) && Number.isNaN(fl[k * SCM_STRIDE + 2]), 'oracle off: tracked ' + k + ' true(W) / upper must be NaN');
        assert.ok(Object.is(fl[k * SCM_STRIDE], world.scm.estimate(world.tracked[k])), 'oracle off: the estimate stays live');
    }
    assert.equal(fl[C_TOTAL], world.scm.total(), 'oracle off: total() stays live');
    world.oracleOn = true; world.resumeNow = world.now;
    for (let f = 0; f < 5; f++) { stepScm(world); stepScmOracle(world, a); }
    renderScmPrep(world, a);
    assert.ok(Number.isNaN(fl[C_BOUNDOK]) && Number.isNaN(fl[C_TOTALOK]), 'resume hold: a half-refilled ring must not give a verdict');
    const refill = Math.ceil((SCM_DEFAULT_W + SCM_DEFAULT_W / SCM_DEFAULT_PANES) / SCM_KEYS_PER_FRAME) + 1;
    for (let f = 0; f < refill; f++) { stepScm(world); stepScmOracle(world, a); }
    renderScmPrep(world, a);
    assert.equal(fl[C_BOUNDOK], 1, 'after a full covered span the bound is checked again and holds');
    assert.equal(fl[C_TOTALOK], 1, 'after a full covered span total() equals the oracle N again');
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    assert.match(html, /if \(on && !scmWorld\.oracleOn\) scmWorld\.resumeNow = scmWorld\.now;/, 'the SCM oracle toggle starts the refill hold');
    assert.match(extractFnBody(html, 'scmTick'), /bk !== bk \? 'n\/a'/, 'scmTick renders a NaN verdict as "n/a"');
});

test('SCM C_TOTAL source (ROADMAP 14 D1): renderScmPrep reads N through the 1.12.0 render reader scm.totalInto (never the boxing scm.total() call), the demo reads NO private library field, and C_TOTAL is Object.is-identical to scm.total() on every render -- unset, heavy (> 2^31), oracle off / resume, paused to empty, after clear(), across W / panes', () => {
    let heavySeen = 0;
    for (const [W, P] of [[SCM_DEFAULT_W, SCM_DEFAULT_PANES], [4096, 32], [1000, 3], [333.5, 64], [16, 2]]) {
        const world = createScmWorld(W, SCM_DEFAULT_EPS, P, 0x5C40);
        const a = createAllocState(), fl = world.flat, tag = 'W=' + W + ' P=' + P;
        renderScmPrep(world, a);
        assert.ok(Object.is(fl[C_TOTAL], 0) && Object.is(world.scm.total(), 0), tag + ': unset -> +0 both');
        for (let f = 0; f < 600; f++) {
            world.heavy = f >= 50 && f < 300;
            world.paused = f >= 400 && f < 480;
            const on = !(f >= 120 && f < 200);
            if (on && !world.oracleOn) world.resumeNow = world.now;
            world.oracleOn = on;
            if (f === 520) world.scm.clear();
            stepScm(world);
            if (world.oracleOn) stepScmOracle(world, a);
            renderScmPrep(world, a);
            const t = world.scm.total();
            assert.ok(Object.is(fl[C_TOTAL], t), tag + ' f=' + f + ': C_TOTAL ' + fl[C_TOTAL] + ' must be Object.is scm.total() ' + t);
            if (t > 2 ** 31) heavySeen++;
        }
    }
    assert.ok(heavySeen > 0, 'the heavy (> 2^31) regime must be exercised');
    // the source: the render calls totalInto and never total(); no file in the demo reads a private
    // (underscore) field of a library instance -- the coupling D1 removed (comments excluded)
    const body = extractFnBody(readFileSync(join(DEMO_DIR, 'kernels.mjs'), 'utf8'), 'renderScmPrep');
    assert.match(body, /scm\.totalInto\(SCM_TOT_ROW\);\s*flat\[C_TOTAL\] = SCM_TOT_ROW\[0\];/, 'renderScmPrep reads N through totalInto into its slot');
    const code0 = body.replace(/\/\/[^\n]*/g, '');   // comments name total() in prose; only code counts
    assert.ok(!/scm\.total\(/.test(code0), 'renderScmPrep must not call the boxing scm.total()');
    for (const f of ['kernels.mjs', 'index.html', 'DemoProbe.mjs']) {
        const code = readFileSync(join(DEMO_DIR, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
        const hits = code.match(/\b(scm|sl|slA|slB|slD|hk|eh|ad|fd|dd|sd|sld|dr|sa|world\.[a-zA-Z]+)\._[a-zA-Z]\w*/g);
        assert.equal(hits, null, f + ' reads a private library field: ' + hits);
    }
});
