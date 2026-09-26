// @zakkster/lite-adaptive -- demo hot kernels, ALL FOUR scenes (repo-only dev artifact, NEVER shipped).
//
// Pure, zero-allocation-after-warmup math driving the four RECENCY scenes, plus a world factory per
// member that wraps the REAL shipped class + an exact in-tab oracle so the demo can never drift from
// the library it demonstrates. Imported by BOTH:
//   - demo/index.html    (the browser rAF loop -- the visualization state IS these classes)
//   - demo/Demo.test.mjs (the honesty gate -- faithfulness + witness + version-trinity + 0-B/op)
//
// The two non-negotiables (DEMO.md section 0):
//   1. The SKETCH path is zero-GC. `stepX` + `renderXPrep` allocate NOTHING after warmup;
//      Demo.test.mjs gates them at 0 B/op. The ONLY code allowed to allocate is `stepXOracle`
//      (the exact O(N) / O(W) foil) -- that is the contrast, and it grows / bumps a counter.
//   2. Every accuracy / space number is re-derived LIVE from the shipped `Adaptive.js` against the
//      in-tab exact oracle (a ring / a Map / a brute-force decayed recompute) -- never hardcoded.
// ASCII-only per suite law ("->", "<=", "x" -- never Unicode).

import {
    ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper,
    SlidingHyperLogLog, DriftDetector, DRIFT_PH, DRIFT_CUSUM,
    SlidingDDSketch, SlidingCountMin, DecayedReservoir,
    VERSION,
} from '../Adaptive.js';

// Re-export the SHIPPED VERSION so index.html and Demo.test.mjs read the one true source
// (never a hardcoded string -- the version-trinity test in Demo.test.mjs gates this).
export { VERSION };

// =======================================================================================
// Shared warmup helpers (allocation is fine here -- warmup / topology change ONLY, never per frame)
// =======================================================================================

/** A deterministic mulberry32 PRNG (matches test/witness.mjs mulberry32). Cold, warmup-only. */
function makeRng(seed) {
    let a = seed >>> 0;
    return function rng() {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Fresh owned-allocation state: two counters we increment ourselves (Truth Panel PRIMARY #2). The
 *  SKETCH path never touches `sketchCount` (it stays 0 -- the whole claim); the exact-oracle path
 *  bumps `oracleCount` per retained item (a REAL count of the state the sketch refuses to keep). */
export function createAllocState() {
    return { sketchCount: 0, oracleCount: 0 };
}

// Per-bucket byte figures (parallel SoA columns, matching test/witness.mjs space co-headline).
/** EH bucket: ts + start + size (Float64 x3 = 24) + next/prev/lvl (Int32 x3 = 12) = 36 bytes. */
export const EH_BUCKET_BYTES = 36;
/** ADWIN bucket: sum + sumSq (Float64 x2 = 16) + bcount/next/prev/lvl (Int32 x4 = 16) = 32 bytes. */
export const AD_BUCKET_BYTES = 32;
/** ForwardDecay fixed struct: C + Sv + L + lambda + tick + lastNow + now (~7 Float64) = 56 bytes. */
export const FD_STRUCT_BYTES = 56;
/** Exact-ring / retained-value byte figure: one Float64 per stored item. */
export const BYTES_PER_F64 = 8;
/** Exact Map<key,count> entry lower bound (matches lite-sketch SS_MAP_BYTES_PER_ENTRY). */
export const MAP_BYTES_PER_ENTRY = 16;

// =======================================================================================
// Scene 01 -- ExponentialHistogram (sliding-window count)
// =======================================================================================

/** Pre-generated inter-arrival GAP stream length (pow2 so a `& mask` cursor never allocates). */
export const EH_STREAM_LEN = 1 << 16;
/** Arrivals fed to the window per rAF frame. */
export const EH_ARRIVALS_PER_FRAME = 64;
/** Default window span W (in `now` time units) and error knob epsilon. */
export const EH_DEFAULT_W = 4096;
export const EH_DEFAULT_EPS = 0.05;
/** Default stream seed (only used to vary the tiny gap jitter; the rate schedule is deterministic). */
export const EH_DEFAULT_SEED = 0x5eed1234;
/** Exact-ring capacity (pow2) -- holds the in-window arrival timestamps the sketch refuses to store. */
export const EH_RING_LEN = 1 << 14;

// flat render-prep layout (the Truth Panel reads these at ~10Hz)
export const E_COUNT = 0;         // eh.count() -- the windowed count estimate
export const E_TRUE = 1;          // exact ring occupancy (the true windowed count)
export const E_RELERR = 2;        // |count - true| / true
export const E_EPS = 3;           // the epsilon knob (the HARD windowed bound)
export const E_FRAC = 4;          // relerr / eps -- the accuracy cursor (must stay <= 1)
export const E_W = 5;             // window span W
export const E_BUCKETS = 6;       // eh.bucketCount (live)
export const E_CAP = 7;           // eh.capacity (fixed pool)
export const E_SKETCH_BYTES = 8;  // cap * EH_BUCKET_BYTES (fixed)
export const E_RING_BYTES = 9;    // liveRing * 8 (the exact ring O(in-window))
export const E_NOW = 10;          // the current monotone now
export const E_LEVELS = 11;       // the fixed level count (PUBLIC eh.levels -- canvas annotation)
export const E_SKETCH_ALLOC = 12; // owned allocation counter, SKETCH path (provably 0)
export const E_ORACLE_ALLOC = 13; // owned allocation counter, exact-ring path (climbs O(arrivals))
export const EH_FLAT_LEN = 14;

/** Fill the world's reused GAP stream: a deterministic dense -> sparse -> dense rate schedule (the
 *  measureShift shape), so the windowed count visibly fills and expires. Warmup / topology only. */
function fillGapStream(world) {
    const gaps = world.gaps, len = gaps.length;
    const rng = makeRng(world.seed);
    for (let i = 0; i < len; i++) {
        const phase = i / len;
        // dense (gap ~1) for the outer thirds, sparse (gap ~4) for the middle third -- a rate shift.
        const base = (phase < 0.34 || phase > 0.66) ? 1 : 4;
        gaps[i] = base + (rng() < 0.15 ? 1 : 0);   // a touch of jitter, still strictly positive
    }
}

/**
 * Build the Scene-01 world ONCE (warmup / topology change). Allocates the REAL ExponentialHistogram,
 * the exact-ring oracle (a reused Float64Array), the reused gap stream, and the flat buffer. Fails
 * closed on a bad W / epsilon via the ExponentialHistogram ctor guard.
 * @param {number} W        window span (finite > 0).
 * @param {number} epsilon  relative-error knob in (0, 1).
 * @param {number} [seed]   uint32 gap-jitter seed.
 */
export function createEhWorld(W, epsilon, seed) {
    // null is not zero: fall back ONLY on undefined/null so an explicit seed=0 is honored.
    const s = (seed === undefined || seed === null) ? EH_DEFAULT_SEED : (seed >>> 0);
    const eh = new ExponentialHistogram(W, epsilon);   // throws [lite-adaptive] on a bad W/epsilon
    const world = {
        eh, W, epsilon, seed: s, paused: false,
        gaps: new Float64Array(EH_STREAM_LEN),
        streamMask: EH_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, frameNowStart: 0, now: 0, sink: 0,
        arrivalsPerFrame: EH_ARRIVALS_PER_FRAME,
        packed: new Float64Array(2),                   // [now, value] scratch for addFrom (reused)
        ring: new Float64Array(EH_RING_LEN),           // exact in-window timestamps
        ringMask: EH_RING_LEN - 1, ringHead: 0, ringTail: 0,
        flat: new Float64Array(EH_FLAT_LEN),
    };
    fillGapStream(world);
    return world;
}

/**
 * One SKETCH-path frame: advance the monotone clock over `arrivalsPerFrame` pre-generated gaps and
 * feed each arrival to the REAL ExponentialHistogram.addFrom (0 B/op incl. the merge cascade + the
 * expire sweep). Records the frame's [start, count) gap range + the pre-frame `now` so the oracle
 * can replay EXACTLY the same timestamps. 0 B/op.
 * @param {object} world
 * @returns {number} an int32 fold (so the loop is never dead-code-eliminated).
 */
export function stepEh(world) {
    if (world.paused) {
        // idle-slide: NO add -- advance the clock so the windowed count slides to empty. 0 B/op.
        const now = world.now + world.arrivalsPerFrame;
        world.packed[0] = now;
        world.eh.advanceFrom(world.packed, 0);
        world.now = now; world.frameNowStart = now; world.frameCount = 0;
        return 0;
    }
    const gaps = world.gaps, mask = world.streamMask, eh = world.eh, apf = world.arrivalsPerFrame;
    const packed = world.packed;
    let pos = world.cursor, now = world.now;
    world.frameStart = pos & mask;
    world.frameNowStart = now;
    let sink = 0;
    for (let i = 0; i < apf; i++) {
        now = now + gaps[pos & mask];
        packed[0] = now; packed[1] = 1;
        eh.addFrom(packed, 0);
        sink = (sink + (now | 0)) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;   // wrap inside SMI range; low `mask` bits preserved (pow2)
    world.now = now;
    world.frameCount = apf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One EXACT-ORACLE frame (the allowed-to-allocate-in-spirit contrast): replay the frame's arrivals
 * into the exact ring of in-window timestamps and bump the owned counter once per arrival retained
 * (the 8 bytes the exact windowed-count approach must keep; the sketch keeps NONE). Then expire the
 * ring at `now - W`. 0 B/op (the ring is pre-allocated).
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the exact windowed count (ring occupancy).
 */
export function stepEhOracle(world, allocState) {
    const gaps = world.gaps, mask = world.streamMask;
    const start = world.frameStart, count = world.frameCount, W = world.W;
    const ring = world.ring, rmask = world.ringMask;
    let now = world.frameNowStart, tail = world.ringTail, head = world.ringHead;
    for (let i = 0; i < count; i++) {
        now = now + gaps[(start + i) & mask];
        ring[tail] = now; tail = (tail + 1) & rmask;
        if (tail === head) head = (head + 1) & rmask;   // ring full -> drop oldest (cap the tab)
        allocState.oracleCount++;                        // a retained arrival the sketch refuses
    }
    const cutoff = now - W;
    while (head !== tail && ring[head] <= cutoff) head = (head + 1) & rmask;
    world.ringHead = head; world.ringTail = tail;
    return (tail - head) & rmask;
}

/**
 * Render-prep (~10Hz, NOT per frame): re-derive every displayed number from the SHIPPED
 * ExponentialHistogram against the exact ring and write them into the reused flat Float64Array.
 * eh.count() is O(numLevels) 0-alloc; every write is a typed-array store. 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the windowed count (folded).
 */
export function renderEhPrep(world, allocState) {
    const eh = world.eh, flat = world.flat;
    const est = eh.count();
    const live = (world.ringTail - world.ringHead) & world.ringMask;
    const relerr = live > 0 ? Math.abs(est - live) / live : 0;
    const eps = eh.epsilon;
    flat[E_COUNT] = est;
    flat[E_TRUE] = live;
    flat[E_RELERR] = relerr;
    flat[E_EPS] = eps;
    flat[E_FRAC] = eps > 0 ? relerr / eps : 0;
    flat[E_W] = eh.windowSize;
    flat[E_BUCKETS] = eh.bucketCount;
    flat[E_CAP] = eh.capacity;
    flat[E_SKETCH_BYTES] = eh.capacity * EH_BUCKET_BYTES;
    flat[E_RING_BYTES] = live * BYTES_PER_F64;
    flat[E_NOW] = world.now;
    flat[E_LEVELS] = eh.levels;   // PUBLIC surface -- no private introspection
    flat[E_SKETCH_ALLOC] = allocState.sketchCount;   // provably 0
    flat[E_ORACLE_ALLOC] = allocState.oracleCount;   // climbing
    return est;
}

// =======================================================================================
// Scene 02 -- ADWIN (concept-drift detection + adaptive window)
// =======================================================================================

/** Pre-generated value stream length (pow2). Its regime pattern repeats cleanly on wrap. */
export const AD_STREAM_LEN = 1 << 16;
/** Values fed per rAF frame. */
export const AD_VALUES_PER_FRAME = 32;
/** Default confidence knob delta. */
export const AD_DEFAULT_DELTA = 0.1;
/** Regime length (items per stationary segment). AD_STREAM_LEN must be a multiple of 2*AD_REGIME. */
export const AD_REGIME = 8192;
/** The two regime means the stream alternates between (the drift). */
export const AD_MEAN_LO = 0.2;
export const AD_MEAN_HI = 0.8;
/** Default value seed. */
export const AD_DEFAULT_SEED = 0xadadadad;
/** The adapted-mean band the witness gates against (test/witness.mjs: |mean - mu| < 0.05). */
export const AD_MEAN_BAND = 0.05;

export const A_MEAN = 0;        // ad.mean (the adaptive-window mean)
export const A_TRUEMEAN = 1;    // the current regime mean mu
export const A_CUMMEAN = 2;     // a naive cumulative (never-forget) mean -- the foil that lags
export const A_WIDTH = 3;       // ad.width (the adaptive window size in items)
export const A_DELTA = 4;       // the confidence knob delta
export const A_MEANERR = 5;     // |ad.mean - mu|
export const A_MEANFRAC = 6;    // meanErr / AD_MEAN_BAND (accuracy cursor)
export const A_CUTS = 7;        // total cuts fired since warmup
export const A_DRIFT = 8;       // 1 if a cut fired THIS frame (the snap)
export const A_VARIANCE = 9;    // ad.variance
export const A_N = 10;          // total items seen
export const A_BUCKETS = 11;    // ad.bucketCount
export const A_CAP = 12;        // ad.capacity
export const A_SKETCH_BYTES = 13; // cap * AD_BUCKET_BYTES (fixed)
export const A_ORACLE_BYTES = 14; // n * 8 -- exact drift needs O(N) retained values (climbs)
export const A_SKETCH_ALLOC = 15;
export const A_ORACLE_ALLOC = 16;
export const AD_FLAT_LEN = 17;

/** The regime mean for a buffer index: alternates AD_MEAN_LO / AD_MEAN_HI every AD_REGIME items. */
function adRegimeMean(bufIdx) {
    return ((((bufIdx / AD_REGIME) | 0) & 1) ? AD_MEAN_HI : AD_MEAN_LO);
}

/** Fill the reused value stream: regime mean + tight noise (range R ~ 0.7). Warmup / topology only. */
function fillAdStream(world) {
    const stream = world.stream, len = stream.length;
    const rng = makeRng(world.seed);
    for (let i = 0; i < len; i++) {
        stream[i] = adRegimeMean(i) + (rng() - 0.5) * 0.1;   // fractional -> exercises zero-box addFrom
    }
}

/**
 * Build the Scene-02 world ONCE. The REAL ADWIN, the reused value stream (a drifting Bernoulli-like
 * signal), and the flat buffer. Fails closed on a bad delta via the ADWIN ctor guard.
 * @param {number} delta  confidence knob in (0, 1).
 * @param {number} [seed] uint32 value seed.
 */
export function createAdWorld(delta, seed) {
    const s = (seed === undefined || seed === null) ? AD_DEFAULT_SEED : (seed >>> 0);
    const ad = new ADWIN(delta);   // throws [lite-adaptive] on a bad delta
    const world = {
        ad, delta, seed: s,
        stream: new Float64Array(AD_STREAM_LEN),
        streamMask: AD_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, sink: 0,
        valuesPerFrame: AD_VALUES_PER_FRAME,
        n: 0, cuts: 0, driftThisFrame: 0, curMu: AD_MEAN_LO,
        cumSum: 0, cumN: 0,                            // the naive cumulative-mean foil
        flat: new Float64Array(AD_FLAT_LEN),
    };
    fillAdStream(world);
    return world;
}

/**
 * One SKETCH-path frame: feed `valuesPerFrame` values UNBOXED from the reused stream to the REAL
 * ADWIN.addFrom (0 B/op incl. the cut-scan AND the drop-older shrink). Counts the cuts that fired
 * this frame (the drift snap). 0 B/op.
 * @param {object} world
 * @returns {number} an int32 fold (defeat DCE).
 */
export function stepAd(world) {
    const stream = world.stream, mask = world.streamMask, ad = world.ad, vpf = world.valuesPerFrame;
    let pos = world.cursor;
    world.frameStart = pos & mask;
    let sink = 0, drift = 0;
    for (let i = 0; i < vpf; i++) {
        const idx = pos & mask;
        const cut = ad.addFrom(stream, idx);   // reads stream[idx] UNBOXED -- zero-box
        if (cut) { drift = 1; world.cuts = (world.cuts + 1) | 0; }
        sink = (sink + (cut ? 1 : 0) + ad.bucketCount) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.curMu = adRegimeMean((pos - 1) & mask);   // the regime the last consumed value belongs to
    world.driftThisFrame = drift;
    world.frameCount = vpf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One EXACT-ORACLE frame (the allowed-to-allocate-in-spirit contrast): replay the frame's values
 * into a naive cumulative mean (never forgets -> the foil that lags after a shift) and bump the
 * owned counter once per value (exact drift detection must retain O(N) values). 0 B/op (scalars).
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the running cumulative mean.
 */
export function stepAdOracle(world, allocState) {
    const stream = world.stream, mask = world.streamMask;
    const start = world.frameStart, count = world.frameCount;
    let cumSum = world.cumSum, cumN = world.cumN;
    for (let i = 0; i < count; i++) {
        cumSum += stream[(start + i) & mask];
        cumN += 1;
        allocState.oracleCount++;   // a retained value exact drift-tracking would keep
    }
    world.cumSum = cumSum; world.cumN = cumN;
    world.n = (world.n + count) | 0;
    return cumN > 0 ? cumSum / cumN : 0;
}

/**
 * Render-prep (~10Hz): re-derive every displayed ADWIN number LIVE from the shipped instance vs the
 * current regime mean + the cumulative foil. ad.mean / variance / width are O(1) 0-alloc getters. 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the adaptive-window mean (folded).
 */
export function renderAdPrep(world, allocState) {
    const ad = world.ad, flat = world.flat;
    const mean = ad.mean, mu = world.curMu;
    const meanErr = Math.abs(mean - mu);
    flat[A_MEAN] = mean;
    flat[A_TRUEMEAN] = mu;
    flat[A_CUMMEAN] = world.cumN > 0 ? world.cumSum / world.cumN : 0;
    flat[A_WIDTH] = ad.width;
    flat[A_DELTA] = ad.delta;
    flat[A_MEANERR] = meanErr;
    flat[A_MEANFRAC] = AD_MEAN_BAND > 0 ? meanErr / AD_MEAN_BAND : 0;
    flat[A_CUTS] = world.cuts;
    flat[A_DRIFT] = world.driftThisFrame;
    flat[A_VARIANCE] = ad.variance;
    flat[A_N] = world.n;
    flat[A_BUCKETS] = ad.bucketCount;
    flat[A_CAP] = ad.capacity;
    flat[A_SKETCH_BYTES] = ad.capacity * AD_BUCKET_BYTES;
    flat[A_ORACLE_BYTES] = world.n * BYTES_PER_F64;
    flat[A_SKETCH_ALLOC] = allocState.sketchCount;
    flat[A_ORACLE_ALLOC] = allocState.oracleCount;
    return mean;
}

// =======================================================================================
// Scene 03 -- ForwardDecay (time-decayed count / sum / mean / rate)
// =======================================================================================

/** Pre-generated (gap, value) stream length (pow2). */
export const FD_STREAM_LEN = 1 << 16;
/** Arrivals fed per rAF frame. */
export const FD_ARRIVALS_PER_FRAME = 32;
/** Default half-life (weight halves every FD_DEFAULT_HALFLIFE time units). */
export const FD_DEFAULT_HALFLIFE = 1000;
/** The exact-aggregate tolerance the witness gates against (test/witness.mjs FD_TOL). */
export const FD_TOL = 1e-9;
/** Default value seed. */
export const FD_DEFAULT_SEED = 0xfdfdfdfd;
/**
 * Exact-oracle ring length (pow2). Forward decay means only recent samples carry non-negligible
 * weight: a sample this many arrivals old has weight < ~1e-15, so a bounded ring recomputes the
 * decayed aggregate EXACTLY modulo FP (the sketch keeps ALL of it in two scalars -- O(1)). Sized
 * for ~34 natural log-units of decay head-room at the halfLife slider ceiling (2000) / min gap,
 * so exp(-lambda*age_edge) < ~1e-14 and the on-screen band reads exact indefinitely.
 */
export const FD_ORACLE_LEN = 1 << 16;
/** The halfLife slider ceiling the oracle ring is sized to keep the band exact (see FD_ORACLE_LEN). */
export const FD_MAX_HALFLIFE = 2000;
/** The value stream shifts its mean at the midpoint of each buffer lap (recent-vs-old contrast). */
export const FD_VALUE_LO = 1.0;
export const FD_VALUE_HI = 5.0;

export const D_COUNT = 0;      // fd.count(now) -- decayed count
export const D_TRUECOUNT = 1;  // exact decayed count (brute-force recompute)
export const D_SUM = 2;        // fd.sum(now)
export const D_TRUESUM = 3;    // exact decayed sum
export const D_MEAN = 4;       // fd.mean() -- decayed (recent-weighted) mean
export const D_CUMMEAN = 5;    // naive cumulative (all-time) mean -- the foil
export const D_RATE = 6;       // fd.rate(now)
export const D_RELERR = 7;     // max rel error over count / sum / mean vs the oracle
export const D_TOL = 8;        // FD_TOL
export const D_FRAC = 9;       // relerr / FD_TOL (accuracy cursor -- EXACT sits near 0)
export const D_HALFLIFE = 10;
export const D_LAMBDA = 11;
export const D_LANDMARK = 12;  // the current landmark L (ticks up on each rebase)
export const D_N = 13;         // total adds
export const D_ORACLEN = 14;   // live oracle-ring samples
export const D_SKETCH_BYTES = 15; // FD_STRUCT_BYTES (fixed O(1))
export const D_ARR_BYTES = 16;    // oracle live samples * 16 ((t, value) pairs)
export const D_REBASED = 17;      // 1 once the landmark has moved past the first add (a rebase happened)
export const D_SKETCH_ALLOC = 18;
export const D_ORACLE_ALLOC = 19;
export const FD_FLAT_LEN = 20;

/** The value for a buffer index: LO for the first half of each lap, HI for the second (a shift). */
function fdValue(bufIdx, len) {
    return (bufIdx < (len >> 1)) ? FD_VALUE_LO : FD_VALUE_HI;
}

/** Fill the reused (gap, value) stream. Warmup / topology only. */
function fillFdStream(world) {
    const gaps = world.gaps, vals = world.vals, len = gaps.length;
    const rng = makeRng(world.seed);
    for (let i = 0; i < len; i++) {
        gaps[i] = 1 + (rng() < 0.25 ? (1 + ((i % 3) | 0)) : 0);   // strictly positive, some jitter
        vals[i] = fdValue(i, len) + (rng() - 0.5) * 0.2;
    }
}

/**
 * Build the Scene-03 world ONCE. The REAL ForwardDecay, the reused (gap, value) stream, the exact
 * decayed-oracle ring of the recent (t, value) pairs, and the flat buffer. Fails closed on a bad
 * halfLife via the ForwardDecay ctor guard.
 * @param {number} halfLife  finite > 0.
 * @param {number} [seed]    uint32 value seed.
 */
export function createFdWorld(halfLife, seed) {
    const s = (seed === undefined || seed === null) ? FD_DEFAULT_SEED : (seed >>> 0);
    const fd = new ForwardDecay(halfLife);   // throws [lite-adaptive] on a bad halfLife
    const world = {
        fd, halfLife, lambda: Math.LN2 / halfLife, seed: s,
        gaps: new Float64Array(FD_STREAM_LEN),
        vals: new Float64Array(FD_STREAM_LEN),
        streamMask: FD_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, frameNowStart: 0, now: 0, firstNow: 0, sink: 0,
        arrivalsPerFrame: FD_ARRIVALS_PER_FRAME,
        packed: new Float64Array(2),                   // [now, value] scratch for addFrom (reused)
        oT: new Float64Array(FD_ORACLE_LEN),           // exact oracle: recent arrival times (ring)
        oV: new Float64Array(FD_ORACLE_LEN),           // exact oracle: recent arrival values (ring)
        oMask: FD_ORACLE_LEN - 1, oHead: 0, oTail: 0,
        cumSum: 0, cumN: 0,                            // naive cumulative-mean foil
        n: 0,
        flat: new Float64Array(FD_FLAT_LEN),
    };
    fillFdStream(world);
    return world;
}

/**
 * One SKETCH-path frame: advance the monotone clock and feed `arrivalsPerFrame` (now, value) pairs
 * to the REAL ForwardDecay.addFrom (0 B/op INCLUDING the landmark rebase). Records the frame's
 * [start, count) + pre-frame `now` so the oracle replays EXACTLY the same arrivals. 0 B/op.
 * @param {object} world
 * @returns {number} an int32 fold (defeat DCE).
 */
export function stepFd(world) {
    const gaps = world.gaps, vals = world.vals, mask = world.streamMask;
    const fd = world.fd, apf = world.arrivalsPerFrame, packed = world.packed;
    let pos = world.cursor, now = world.now;
    world.frameStart = pos & mask;
    world.frameNowStart = now;
    let sink = 0;
    for (let i = 0; i < apf; i++) {
        const idx = pos & mask;
        now = now + gaps[idx];
        packed[0] = now; packed[1] = vals[idx];
        fd.addFrom(packed, 0);
        sink = (sink + (now | 0)) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.now = now;
    world.frameCount = apf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One EXACT-ORACLE frame (the allowed-to-allocate-in-spirit contrast): replay the frame's arrivals
 * into the recent-(t, value) ring (the brute-force oracle keeps EVERY still-weighty sample -- O(W)
 * where the sketch keeps two scalars) + the naive cumulative-mean foil, bumping the owned counter
 * per arrival. 0 B/op (rings are pre-allocated).
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the live oracle sample count.
 */
export function stepFdOracle(world, allocState) {
    const gaps = world.gaps, vals = world.vals, mask = world.streamMask;
    const start = world.frameStart, count = world.frameCount;
    const oT = world.oT, oV = world.oV, omask = world.oMask;
    let now = world.frameNowStart, head = world.oHead, tail = world.oTail;
    let cumSum = world.cumSum, cumN = world.cumN;
    for (let i = 0; i < count; i++) {
        const idx = (start + i) & mask;
        now = now + gaps[idx];
        const v = vals[idx];
        oT[tail] = now; oV[tail] = v; tail = (tail + 1) & omask;
        if (tail === head) head = (head + 1) & omask;   // ancient sample (weight ~0) drops off
        cumSum += v; cumN += 1;
        allocState.oracleCount++;                         // a retained sample the sketch refuses
    }
    world.oHead = head; world.oTail = tail;
    world.cumSum = cumSum; world.cumN = cumN;
    world.n = (world.n + count) | 0;
    return (tail - head) & omask;
}

/**
 * The EXACT decayed (count, sum) at `now` over a caller-owned (times, vals) ring segment. Writes
 * out[0] = decayed count, out[1] = decayed sum (a 2-slot Float64Array) -- 0 alloc (no object). This
 * is test/witness.mjs's `fdOracle` in a zero-alloc, ring-aware form; reused by renderFdPrep AND
 * Demo.test.mjs so the on-screen band and the gate share one brute-force definition.
 * @param {Float64Array} times  arrival times.
 * @param {Float64Array} vals   arrival values.
 * @param {number} head         ring head (oldest live index).
 * @param {number} tail         ring tail (next free index).
 * @param {number} mask         ring index mask (len - 1).
 * @param {number} lambda       decay rate ln2 / halfLife.
 * @param {number} now          the query time.
 * @param {Float64Array} out    a 2-slot scratch: out[0] <- count, out[1] <- sum.
 */
export function fdOracle(times, vals, head, tail, mask, lambda, now, out) {
    let c = 0, s = 0;
    let i = head;
    while (i !== tail) {
        const wd = Math.exp(-lambda * (now - times[i]));
        c += wd; s += vals[i] * wd;
        i = (i + 1) & mask;
    }
    out[0] = c; out[1] = s;
}

/**
 * Render-prep (~10Hz): re-derive every displayed ForwardDecay number LIVE from the shipped instance
 * vs the brute-force decayed oracle over the recent-sample ring, plus the cumulative-mean foil. The
 * fd.count / sum / mean / rate queries are O(1) 0-alloc; fdOracle writes into a reused 2-slot scratch. 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the decayed count (folded).
 */
export function renderFdPrep(world, allocState) {
    const fd = world.fd, flat = world.flat, now = world.now, lambda = world.lambda;
    const scratch = world.packed;   // reuse the 2-slot scratch as the oracle out (no per-tick alloc)
    fdOracle(world.oT, world.oV, world.oHead, world.oTail, world.oMask, lambda, now, scratch);
    const oc = scratch[0], os = scratch[1];
    const count = fd.count(now), sum = fd.sum(now), mean = fd.mean(now), rate = fd.rate(now);
    const relC = oc > 0 ? Math.abs(count - oc) / Math.abs(oc) : 0;
    const relS = Math.abs(os) > 0 ? Math.abs(sum - os) / Math.abs(os) : 0;
    const om = oc !== 0 ? os / oc : 0;
    const relM = Math.abs(om) > 0 ? Math.abs(mean - om) / Math.abs(om) : 0;
    let relerr = relC; if (relS > relerr) relerr = relS; if (relM > relerr) relerr = relM;
    const live = (world.oTail - world.oHead) & world.oMask;
    flat[D_COUNT] = count;
    flat[D_TRUECOUNT] = oc;
    flat[D_SUM] = sum;
    flat[D_TRUESUM] = os;
    flat[D_MEAN] = mean;
    flat[D_CUMMEAN] = world.cumN > 0 ? world.cumSum / world.cumN : 0;
    flat[D_RATE] = rate;
    flat[D_RELERR] = relerr;
    flat[D_TOL] = FD_TOL;
    flat[D_FRAC] = FD_TOL > 0 ? relerr / FD_TOL : 0;
    flat[D_HALFLIFE] = fd.halfLife;
    flat[D_LAMBDA] = fd.lambda;
    flat[D_LANDMARK] = fd.landmark;
    flat[D_N] = world.n;
    flat[D_ORACLEN] = live;
    flat[D_SKETCH_BYTES] = FD_STRUCT_BYTES;
    flat[D_ARR_BYTES] = live * (BYTES_PER_F64 * 2);
    flat[D_REBASED] = fd.landmark > world.firstNow ? 1 : 0;
    flat[D_SKETCH_ALLOC] = allocState.sketchCount;
    flat[D_ORACLE_ALLOC] = allocState.oracleCount;
    return count;
}

// =======================================================================================
// Scene 04 -- HeavyKeeper (decayed / windowed heavy hitters, top-k)
// =======================================================================================

/** Pre-generated Zipfian key stream length (pow2). */
export const HK_STREAM_LEN = 1 << 16;
/** Keys fed per rAF frame. */
export const HK_KEYS_PER_FRAME = 128;
/** Default table depth d, width w, and top-k size k. */
export const HK_DEFAULT_D = 4;
export const HK_DEFAULT_W = 1024;
export const HK_DEFAULT_K = 12;
/** Distinct key universe + Zipfian skew for the stream. */
export const HK_NKEYS = 8000;
export const HK_SKEW = 1.1;
/** The popular-set shift offset -- the DRIFT used by the marquee (HeavyKeeper vs Space-Saving). The
 *  LIVE scene streams a STATIONARY skew so recall against the cumulative Map is meaningful (its top
 *  keys ARE the current top keys); the marquee's dramatic win is proven on a drifting stream in
 *  Demo.test.mjs, mirroring test/witness.mjs's driftStream. */
export const HK_DRIFT_OFFSET = 500000;
/** Default stream + hash seed. */
export const HK_DEFAULT_SEED = 0x243f6a88;
/** The faithful inline Space-Saving baseline size (matches the witness marquee CAP = k * 4). */
export const HK_SS_MULT = 4;

export const H_RECALL = 0;      // recall of the true heavy hitters above N/k (target 1.0)
export const H_TRUEHH = 1;      // # of true HH above N/k
export const H_FOUND = 2;       // of those, how many HeavyKeeper still tracks
export const H_N = 3;           // total mass added
export const H_K = 4;           // the top-k size
export const H_W = 5;           // table width
export const H_THRESH = 6;      // N / k (the heavy-hitter threshold)
export const H_ERRBOUND = 7;    // ~N / w (the per-cell error a leader's estimate may sit below true)
export const H_BRACKETOK = 8;   // 1 if every leader estimate in [true - ~N/w, true]
export const H_MAXOVER = 9;     // max overestimate over leaders (must be 0 -- HK never over-reports)
export const H_HKERR = 10;      // HeavyKeeper mean rel-error over its leaders (the marquee)
export const H_SSERR = 11;      // faithful Space-Saving mean rel-error over the SAME leaders
export const H_MARQUEEOK = 12;  // 1 if HeavyKeeper's mean rel-error < Space-Saving's
export const H_SIZE = 13;       // hk.size (leaders in the forest, <= k)
export const H_DISTINCT = 14;   // distinct keys seen (Map size)
export const H_SKETCH_BYTES = 15; // hk.bytes (fixed)
export const H_MAP_BYTES = 16;    // distinct * 16 (exact Map O(distinct))
export const H_ROWS = 17;         // leaderboard rows populated
export const H_MAXCOUNT = 18;     // top leader estimate (leaderboard normalization)
export const H_SKETCH_ALLOC = 19;
export const H_ORACLE_ALLOC = 20;
export const HK_FLAT_LEN = 21;

/** Fill the reused stream with a STATIONARY Zipfian skew (cached CDF). Warmup / topology only. */
function fillZipfStream(world) {
    const stream = world.stream, len = stream.length, nKeys = world.nKeys, skew = world.skew;
    const rng = makeRng(world.seed);
    const cdf = new Float64Array(nKeys);
    let sum = 0;
    for (let i = 0; i < nKeys; i++) { sum += 1 / Math.pow(i + 1, skew); cdf[i] = sum; }
    for (let i = 0; i < nKeys; i++) cdf[i] /= sum;
    for (let n = 0; n < len; n++) {
        const u = rng();
        let lo = 0, hi = nKeys - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
        stream[n] = lo;
    }
}

/** A FAITHFUL inline Space-Saving baseline (Metwally-Agrawal-El Abbadi, ICDT 2005) -- the marquee
 *  foil. NO @zakkster/lite-sketch dependency: the correct min-replacement algorithm, over SoA
 *  Float64 columns. add / estimate are 0-alloc (linear scans -- fine for a k*4 baseline, cold-ish). */
function makeSpaceSaving(cap) {
    return {
        cap,
        key: new Float64Array(cap),
        cnt: new Float64Array(cap),
        err: new Float64Array(cap),
        n: 0,
    };
}
function ssAdd(ss, key, weight) {
    const n = ss.n, kk = ss.key, cc = ss.cnt, ee = ss.err;
    for (let i = 0; i < n; i++) { if (kk[i] === key) { cc[i] += weight; return; } }   // present -> increment
    if (n < ss.cap) { kk[n] = key; cc[n] = weight; ee[n] = 0; ss.n = n + 1; return; } // room -> monitor
    let mi = 0, mc = cc[0];                                                            // full -> replace the min
    for (let i = 1; i < n; i++) if (cc[i] < mc) { mc = cc[i]; mi = i; }
    kk[mi] = key; ee[mi] = mc; cc[mi] = mc + weight;
}
function ssEstimate(ss, key) {
    const n = ss.n, kk = ss.key, cc = ss.cnt;
    for (let i = 0; i < n; i++) if (kk[i] === key) return cc[i];
    return 0;
}

/** Build the per-world recall callback ONCE (never per frame) -- 0-alloc when Map.forEach calls it. */
function makeHkRecallCb(world) {
    return function recallCb(count, key) {
        const hk = world.hk;
        const thr = world.n / world.k;
        if (count > thr) { world.recallTrue++; if (hk.estimate(key) > 0) world.recallFound++; }
    };
}

/**
 * Build the Scene-04 world ONCE. The REAL HeavyKeeper, an exact Map oracle, the faithful inline
 * Space-Saving marquee foil, the reused Zipfian+drift stream, the pre-allocated top-k buffers, and
 * the flat buffer. Fails closed on a bad d / w / k via the HeavyKeeper ctor guard.
 * @param {number} d       depth (rows), [1, 64].
 * @param {number} w       width (cols), >= 1.
 * @param {number} k       top-k size, >= 1.
 * @param {number} [seed]  uint32 stream + hash seed.
 */
export function createHkWorld(d, w, k, seed) {
    const s = (seed === undefined || seed === null) ? HK_DEFAULT_SEED : (seed >>> 0);
    const hk = new HeavyKeeper(d, w, k, { seed: s });   // throws [lite-adaptive] on a bad d/w/k
    const world = {
        hk, d, w, k, seed: s, nKeys: HK_NKEYS, skew: HK_SKEW,
        oracle: new Map(),
        ss: makeSpaceSaving(k * HK_SS_MULT),
        stream: new Uint32Array(HK_STREAM_LEN),
        streamMask: HK_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, sink: 0,
        keysPerFrame: HK_KEYS_PER_FRAME,
        keyBuf: new Float64Array(2),                    // [key, weight] scratch for addFrom (reused)
        topBuf: new Float64Array(2 * k),                // topKInto target ([key, estimate] pairs)
        lbTrue: new Float64Array(k),                    // per-leader true count (for the bracket)
        n: 0, recallTrue: 0, recallFound: 0,
        flat: new Float64Array(HK_FLAT_LEN),
    };
    fillZipfStream(world);
    world.recallCb = makeHkRecallCb(world);
    return world;
}

/**
 * One SKETCH-path frame: feed `keysPerFrame` keys UNBOXED from a packed [key, weight] scratch to the
 * REAL HeavyKeeper.addFrom (0 B/op incl. the fp-miss decay draw + the intrusive forest sift). Records
 * the frame's [start, count) so the oracle replays EXACTLY the same keys. 0 B/op.
 * @param {object} world
 * @returns {number} an int32 fold (defeat DCE).
 */
export function stepHk(world) {
    const stream = world.stream, mask = world.streamMask, hk = world.hk, kpf = world.keysPerFrame;
    const buf = world.keyBuf;
    let pos = world.cursor;
    world.frameStart = pos & mask;
    let sink = 0;
    for (let i = 0; i < kpf; i++) {
        buf[0] = stream[pos & mask]; buf[1] = 1;
        hk.addFrom(buf, 0);
        sink = (sink + hk.size) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.frameCount = kpf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One EXACT-ORACLE frame (the allowed-to-allocate contrast): replay the frame's keys into the exact
 * Map (a new distinct key GENUINELY allocates a Map entry -- the real climbing contrast) AND into the
 * faithful Space-Saving marquee foil. Bumps the owned counter per genuinely-new key.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the Map size after this frame.
 */
export function stepHkOracle(world, allocState) {
    const stream = world.stream, mask = world.streamMask, map = world.oracle, ss = world.ss;
    const start = world.frameStart, count = world.frameCount;
    for (let i = 0; i < count; i++) {
        const key = stream[(start + i) & mask];
        const c = map.get(key);
        if (c === undefined) { map.set(key, 1); allocState.oracleCount++; }   // a new entry allocates
        else map.set(key, c + 1);
        ssAdd(ss, key, 1);
    }
    world.n = (world.n + count) | 0;
    return map.size;
}

/**
 * Render-prep (~10Hz): re-derive every displayed HeavyKeeper number LIVE from the shipped instance
 * vs the exact Map + the Space-Saving foil. Reads the top-k via hk.topKInto (0-alloc, [key, estimate]
 * pairs), verifies the [true - ~N/w, true] bracket + never-overestimate per leader, computes recall
 * of the true HH above N/k via Map.forEach with the hoisted callback (0-alloc), and the marquee mean
 * rel-error HeavyKeeper vs Space-Saving. topK() is NEVER called here (it allocates). 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} recall (folded).
 */
export function renderHkPrep(world, allocState) {
    const hk = world.hk, flat = world.flat, map = world.oracle, ss = world.ss;
    const k = world.k, w = world.w, N = world.n;
    const topBuf = world.topBuf, lbTrue = world.lbTrue;
    const rows = hk.topKInto(topBuf);   // [key, estimate] pairs, heap order; returns entry count

    // per-leader bracket + never-overestimate + marquee (HeavyKeeper vs Space-Saving) -- all 0-alloc.
    const errBound = w > 0 ? N / w : 0;
    let bracketOk = 1, maxOver = 0, maxCount = 0;
    let hkErrSum = 0, ssErrSum = 0, errN = 0;
    for (let r = 0; r < rows; r++) {
        const key = topBuf[r * 2];
        const est = topBuf[r * 2 + 1];
        const tc = map.get(key);
        const t = tc === undefined ? 0 : tc;
        lbTrue[r] = t;
        if (est > t) { const over = est - t; if (over > maxOver) maxOver = over; bracketOk = 0; }
        if (t - est > errBound + 1e-9) bracketOk = 0;
        if (est > maxCount) maxCount = est;
        if (t > 0) {
            hkErrSum += Math.abs(est - t) / t;
            ssErrSum += Math.abs(ssEstimate(ss, key) - t) / t;
            errN++;
        }
    }
    const hkErr = errN > 0 ? hkErrSum / errN : 0;
    const ssErr = errN > 0 ? ssErrSum / errN : 0;

    // recall of the true heavy hitters above N/k (the headline) -- Map.forEach, hoisted cb, 0-alloc.
    world.recallTrue = 0; world.recallFound = 0;
    map.forEach(world.recallCb);
    const recall = world.recallTrue === 0 ? 1 : world.recallFound / world.recallTrue;

    flat[H_RECALL] = recall;
    flat[H_TRUEHH] = world.recallTrue;
    flat[H_FOUND] = world.recallFound;
    flat[H_N] = N;
    flat[H_K] = k;
    flat[H_W] = w;
    flat[H_THRESH] = k > 0 ? N / k : 0;
    flat[H_ERRBOUND] = errBound;
    flat[H_BRACKETOK] = bracketOk;
    flat[H_MAXOVER] = maxOver;
    flat[H_HKERR] = hkErr;
    flat[H_SSERR] = ssErr;
    flat[H_MARQUEEOK] = (errN > 0 && hkErr < ssErr) ? 1 : 0;
    flat[H_SIZE] = hk.size;
    flat[H_DISTINCT] = map.size;
    flat[H_SKETCH_BYTES] = hk.bytes;
    flat[H_MAP_BYTES] = map.size * MAP_BYTES_PER_ENTRY;
    flat[H_ROWS] = rows;
    flat[H_MAXCOUNT] = maxCount;
    flat[H_SKETCH_ALLOC] = allocState.sketchCount;
    flat[H_ORACLE_ALLOC] = allocState.oracleCount;
    return recall;
}

// =======================================================================================
// Scene 05 -- SlidingHyperLogLog (windowed distinct-count)
// =======================================================================================

/** Pre-generated key-stream length (pow2). */
export const SHLL_STREAM_LEN = 1 << 16;
/** Keys fed to the window per rAF frame. */
export const SHLL_KEYS_PER_FRAME = 64;
/** Default window span W (in `now` units), precision p, and per-register ring capacity. */
export const SHLL_DEFAULT_W = 4096;
export const SHLL_DEFAULT_P = 11;         // m = 2^11 = 2048 registers -> standardError ~ 2.3%
export const SHLL_DEFAULT_RINGCAP = 16;
/** Default stream + hash seed. */
export const SHLL_DEFAULT_SEED = 0x51ec1a11;
/** The distinct-key universe the stream cycles over (2*W-ish so the window holds ~W distinct). */
export const SHLL_UNIVERSE = 1 << 13;      // 8192
/** Exact-oracle ring capacity (pow2) -- MUST exceed W so per-frame expiry keeps it un-full. */
export const SHLL_RING_LEN = 1 << 14;      // 16384 > any slider W
/** The 3-sigma gate multiplier the witness applies (rel <= 3 * standardError). */
export const SHLL_SIGMA_MULT = 3;

export const S_EST = 0;          // sl.count() -- the windowed distinct estimate
export const S_TRUE = 1;         // exact in-window distinct (oracle Map size)
export const S_RELERR = 2;       // |est - true| / true
export const S_GATE = 3;         // 3 * standardError (the theoretical band)
export const S_FRAC = 4;         // relerr / gate -- the accuracy cursor (must stay <= 1)
export const S_M = 5;            // register count m
export const S_W = 6;            // window span W
export const S_DEGRADED = 7;     // 1 if a ring overflowed (the accuracy bound no longer guaranteed)
export const S_OVERFLOWS = 8;    // ring-overflow count
export const S_N = 9;            // total adds
export const S_SKETCH_BYTES = 10;// sl.bytes (fixed)
export const S_ORACLE_BYTES = 11;// map.size*MAP_BYTES_PER_ENTRY + ring bytes (O(in-window))
export const S_NOW = 12;         // the current monotone now
export const S_SKETCH_ALLOC = 13;
export const S_ORACLE_ALLOC = 14;
export const SHLL_FLAT_LEN = 15;

/** Fill the reused key stream: a deterministic spread over SHLL_UNIVERSE (one key per tick). */
function fillShllStream(world) {
    const stream = world.stream, len = stream.length, U = SHLL_UNIVERSE;
    const rng = makeRng(world.seed);
    for (let i = 0; i < len; i++) stream[i] = (rng() * U) | 0;
}

/**
 * Build the Scene-05 world ONCE. The REAL SlidingHyperLogLog, an exact windowed-distinct oracle
 * (a Map<key,count> + a preallocated (t, key) ring), the reused key stream, and the flat buffer.
 * Fails closed on a bad W / p / ringCap / seed via the SlidingHyperLogLog ctor guard.
 * @param {number} W        window span (finite > 0).
 * @param {number} p        precision (register count 2^p).
 * @param {number} ringCap  per-register LFPM ring capacity.
 * @param {number} [seed]   uint32 stream + hash seed.
 */
export function createShllWorld(W, p, ringCap, seed) {
    const s = (seed === undefined || seed === null) ? SHLL_DEFAULT_SEED : (seed >>> 0);
    const sl = new SlidingHyperLogLog(W, { p, ringCap, seed: s });   // throws [lite-adaptive] on bad args
    const world = {
        sl, W, p, ringCap, seed: s, paused: false,
        stream: new Uint32Array(SHLL_STREAM_LEN),
        streamMask: SHLL_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, frameNowStart: 0, now: 0, n: 0, sink: 0,
        keysPerFrame: SHLL_KEYS_PER_FRAME,
        packed: new Float64Array(2),                   // [now, key] scratch for addFrom (reused)
        oMap: new Map(),                               // exact in-window distinct (allocates on new keys)
        oT: new Float64Array(SHLL_RING_LEN),           // in-window arrival times (ring)
        oKey: new Float64Array(SHLL_RING_LEN),         // in-window keys (ring)
        oMask: SHLL_RING_LEN - 1, oHead: 0, oTail: 0,
        flat: new Float64Array(SHLL_FLAT_LEN),
    };
    fillShllStream(world);
    return world;
}

/**
 * One SKETCH-path frame: advance the monotone clock and feed `keysPerFrame` keys UNBOXED to the REAL
 * SlidingHyperLogLog.addFrom (0 B/op incl. the windowed LFPM eviction). While paused, idle-slides via
 * advanceFrom (NO add) so the windowed distinct count slides to empty. 0 B/op.
 * @param {object} world
 * @returns {number} an int32 fold (defeat DCE).
 */
export function stepShll(world) {
    if (world.paused) {
        const now = world.now + world.keysPerFrame;
        world.packed[0] = now;
        world.sl.advanceFrom(world.packed, 0);
        world.now = now; world.frameNowStart = now; world.frameCount = 0;
        return 0;
    }
    const stream = world.stream, mask = world.streamMask, sl = world.sl, kpf = world.keysPerFrame;
    const packed = world.packed;
    let pos = world.cursor, now = world.now;
    world.frameStart = pos & mask;
    world.frameNowStart = now;
    let sink = 0;
    for (let i = 0; i < kpf; i++) {
        now = now + 1;
        packed[0] = now; packed[1] = stream[pos & mask];
        sl.addFrom(packed, 0);
        sink = (sink + (now | 0)) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.now = now; world.frameCount = kpf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One EXACT-ORACLE frame: replay the frame's keys into the exact windowed-distinct Map (a genuinely
 * NEW distinct-in-window key allocates a Map entry -- the climbing contrast) + the (t, key) ring, then
 * expire entries older than now - W (decrementing / deleting the Map). Returns the in-window distinct
 * count (Map size). The ring is preallocated (sized > W so it never fills before expiry). 0 B/op
 * except a genuine new-distinct-key Map insert.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the exact in-window distinct count.
 */
export function stepShllOracle(world, allocState) {
    const stream = world.stream, mask = world.streamMask, map = world.oMap;
    const oT = world.oT, oKey = world.oKey, omask = world.oMask, W = world.W;
    const start = world.frameStart, count = world.frameCount;
    let now = world.frameNowStart, head = world.oHead, tail = world.oTail;
    for (let i = 0; i < count; i++) {
        now = now + 1;
        const key = stream[(start + i) & mask];
        oT[tail] = now; oKey[tail] = key; tail = (tail + 1) & omask;
        const c = map.get(key);
        if (c === undefined) { map.set(key, 1); allocState.oracleCount++; }   // a new distinct-in-window entry
        else map.set(key, c + 1);
    }
    const cutoff = now - W;
    while (head !== tail && oT[head] <= cutoff) {
        const k = oKey[head];
        const c = map.get(k);
        if (c === 1) map.delete(k); else map.set(k, c - 1);
        head = (head + 1) & omask;
    }
    world.oHead = head; world.oTail = tail;
    world.n = (world.n + count) | 0;
    return map.size;
}

/**
 * Render-prep (~10Hz): re-derive every displayed SlidingHyperLogLog number LIVE from the shipped
 * instance vs the exact windowed-distinct Map. sl.count() is O(m) 0-alloc; map.size is O(1). 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the windowed distinct estimate (folded).
 */
export function renderShllPrep(world, allocState) {
    const sl = world.sl, flat = world.flat, map = world.oMap;
    const est = sl.count();
    const trueD = map.size;
    const relerr = trueD > 0 ? Math.abs(est - trueD) / trueD : 0;
    const gate = SHLL_SIGMA_MULT * sl.standardError;
    const live = (world.oTail - world.oHead) & world.oMask;
    flat[S_EST] = est;
    flat[S_TRUE] = trueD;
    flat[S_RELERR] = relerr;
    flat[S_GATE] = gate;
    flat[S_FRAC] = gate > 0 ? relerr / gate : 0;
    flat[S_M] = sl.m;
    flat[S_W] = sl.W;
    flat[S_DEGRADED] = sl.degraded ? 1 : 0;
    flat[S_OVERFLOWS] = sl.overflows;
    flat[S_N] = world.n;
    flat[S_SKETCH_BYTES] = sl.bytes;
    flat[S_ORACLE_BYTES] = trueD * MAP_BYTES_PER_ENTRY + live * (BYTES_PER_F64 * 2);
    flat[S_NOW] = world.now;
    flat[S_SKETCH_ALLOC] = allocState.sketchCount;
    flat[S_ORACLE_ALLOC] = allocState.oracleCount;
    return est;
}

// =======================================================================================
// Scene 06 -- DriftDetector (scalar Page-Hinkley vs CUSUM change detection)
// =======================================================================================

/** Pre-generated value-stream length (pow2). */
export const DD_STREAM_LEN = 1 << 16;
/** Values fed per rAF frame. */
export const DD_VALUES_PER_FRAME = 32;
/** Default magnitude allowance (delta) and decision level (threshold). */
export const DD_DEFAULT_DELTA = 0.005;
export const DD_DEFAULT_THRESHOLD = 5;
/** Regime length (items per stationary segment). The stream steps between two means at each boundary. */
export const DD_REGIME = 6000;
/** The two regime means the stream alternates between (the CUSUM target is the LO mean). */
export const DD_MEAN_LO = 0.0;
export const DD_MEAN_HI = 1.0;
/** The fixed CUSUM in-control target mu0 (= the LO baseline). */
export const DD_TARGET = 0.0;
/** Uniform noise half-width (matches the witness ddDetect noise band). */
export const DD_NOISE = 0.2;
/** Internal (non-parameterized) stream seed -- DriftDetector itself has NO seed. */
const DD_STREAM_SEED = 0x0dd15ea5;

export const G_PH_STAT = 0;      // ph.statistic
export const G_PH_THRESH = 1;    // ph.threshold
export const G_PH_FRAC = 2;      // ph.statistic / ph.threshold (fire cursor)
export const G_CU_STAT = 3;      // cu.statistic
export const G_CU_THRESH = 4;    // cu.threshold
export const G_CU_FRAC = 5;      // cu.statistic / cu.threshold
export const G_PH_FIRES = 6;     // total PH fires
export const G_CU_FIRES = 7;     // total CUSUM fires
export const G_PH_FIRED = 8;     // 1 if PH fired this frame
export const G_CU_FIRED = 9;     // 1 if CUSUM fired this frame
export const G_TRUEMEAN = 10;    // current regime mean (ground truth)
export const G_PH_MEAN = 11;     // ph.mean (online running mean)
export const G_CU_MEAN = 12;     // cu.mean
export const G_N = 13;           // items seen
export const G_CP = 14;          // ground-truth changepoints crossed
export const G_SKETCH_BYTES = 15;// both detectors' fixed scalar state
export const G_ORACLE_BYTES = 16;// N*8 -- exact detection retains O(N) values
export const G_SKETCH_ALLOC = 17;
export const G_ORACLE_ALLOC = 18;
export const DD_FLAT_LEN = 19;

/** Fixed scalar footprint of the two detectors (both share the tiny O(1)-state class). */
export const DD_SKETCH_BYTES = 128;

/** The regime mean for a buffer index: alternates LO / HI every DD_REGIME items. */
function ddRegimeMean(bufIdx) {
    return ((((bufIdx / DD_REGIME) | 0) & 1) ? DD_MEAN_HI : DD_MEAN_LO);
}

/** Fill the reused value stream: regime mean + tight uniform noise. Warmup / topology only. */
function fillDdStream(world) {
    const stream = world.stream, len = stream.length;
    const rng = makeRng(DD_STREAM_SEED);
    for (let i = 0; i < len; i++) stream[i] = ddRegimeMean(i) + (rng() - 0.5) * (2 * DD_NOISE);
}

/**
 * Build the Scene-06 world ONCE. TWO REAL DriftDetectors -- Page-Hinkley (adaptive online mean) and
 * CUSUM (fixed target mu0) -- fed the SAME signal, plus a fixed-noise regime-stepping stream (the
 * injected changepoints are the ground truth). Fails closed on a bad delta / threshold via the ctor.
 * @param {number} delta      magnitude allowance (>= 0).
 * @param {number} threshold  decision level (> 0).
 */
export function createDdWorld(delta, threshold) {
    const ph = new DriftDetector(DRIFT_PH, { delta, threshold });                 // throws on bad args
    const cu = new DriftDetector(DRIFT_CUSUM, { delta, threshold, target: DD_TARGET });
    const world = {
        ph, cu, delta, threshold,
        stream: new Float64Array(DD_STREAM_LEN),
        streamMask: DD_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, sink: 0,
        valuesPerFrame: DD_VALUES_PER_FRAME,
        n: 0, phFires: 0, cuFires: 0, phFired: 0, cuFired: 0, cp: 0, curMu: DD_MEAN_LO,
        flat: new Float64Array(DD_FLAT_LEN),
    };
    fillDdStream(world);
    return world;
}

/**
 * One SKETCH-path frame: feed `valuesPerFrame` values UNBOXED to BOTH detectors' addFrom (0 B/op),
 * counting fires per channel + ground-truth changepoints crossed this frame. 0 B/op.
 * @param {object} world
 * @returns {number} an int32 fold (defeat DCE).
 */
export function stepDd(world) {
    const stream = world.stream, mask = world.streamMask, ph = world.ph, cu = world.cu;
    const vpf = world.valuesPerFrame;
    let pos = world.cursor;
    world.frameStart = pos & mask;
    let sink = 0, phF = 0, cuF = 0, cp = 0, prevReg = ((world.n / DD_REGIME) | 0);
    for (let i = 0; i < vpf; i++) {
        const idx = pos & mask;
        const reg = (((world.n + i) / DD_REGIME) | 0);
        if (reg !== prevReg) { cp = 1; prevReg = reg; }
        const pf = ph.addFrom(stream, idx);
        const cf = cu.addFrom(stream, idx);
        if (pf) { phF = 1; world.phFires = (world.phFires + 1) | 0; }
        if (cf) { cuF = 1; world.cuFires = (world.cuFires + 1) | 0; }
        sink = (sink + (pf ? 1 : 0) + (cf ? 1 : 0)) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.n = (world.n + vpf) | 0;
    world.curMu = ddRegimeMean((pos - 1) & mask);
    world.phFired = phF; world.cuFired = cuF;
    if (cp) world.cp = (world.cp + 1) | 0;
    world.frameCount = vpf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One EXACT-ORACLE frame (the allowed-to-allocate-in-spirit contrast): exact drift detection must
 * retain O(N) values to re-test any window; we bump the owned counter per value (the retained-values
 * contrast) without keeping them (the point is that the sketch keeps only O(1) scalars). 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} total items seen.
 */
export function stepDdOracle(world, allocState) {
    const count = world.frameCount;
    for (let i = 0; i < count; i++) allocState.oracleCount++;   // a retained value exact detection keeps
    return world.n;
}

/**
 * Render-prep (~10Hz): re-derive every displayed DriftDetector number LIVE from BOTH shipped detectors.
 * statistic / threshold / mean are O(1) 0-alloc getters. 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the PH statistic (folded).
 */
export function renderDdPrep(world, allocState) {
    const ph = world.ph, cu = world.cu, flat = world.flat;
    const ps = ph.statistic, pt = ph.threshold, cs = cu.statistic, ct = cu.threshold;
    flat[G_PH_STAT] = ps;
    flat[G_PH_THRESH] = pt;
    flat[G_PH_FRAC] = pt > 0 ? ps / pt : 0;
    flat[G_CU_STAT] = cs;
    flat[G_CU_THRESH] = ct;
    flat[G_CU_FRAC] = ct > 0 ? cs / ct : 0;
    flat[G_PH_FIRES] = world.phFires;
    flat[G_CU_FIRES] = world.cuFires;
    flat[G_PH_FIRED] = world.phFired;
    flat[G_CU_FIRED] = world.cuFired;
    flat[G_TRUEMEAN] = world.curMu;
    flat[G_PH_MEAN] = ph.mean;
    flat[G_CU_MEAN] = cu.mean;
    flat[G_N] = world.n;
    flat[G_CP] = world.cp;
    flat[G_SKETCH_BYTES] = DD_SKETCH_BYTES;
    flat[G_ORACLE_BYTES] = world.n * BYTES_PER_F64;
    flat[G_SKETCH_ALLOC] = allocState.sketchCount;
    flat[G_ORACLE_ALLOC] = allocState.oracleCount;
    return ps;
}

// =======================================================================================
// Scene 07 -- SlidingDDSketch (windowed relative-error quantiles)
// =======================================================================================

/** Pre-generated value-stream length (pow2). */
export const SLD_STREAM_LEN = 1 << 16;
/** Values fed per rAF frame. */
export const SLD_VALUES_PER_FRAME = 32;
/** Default window span W, relative-error target alpha, and pane-ring size B. */
export const SLD_DEFAULT_W = 2048;
export const SLD_DEFAULT_ALPHA = 0.02;
export const SLD_DEFAULT_PANES = 32;
/** Exact-oracle ring capacity (pow2) -- MUST exceed W + one pane so per-frame expiry keeps it un-full. */
export const SLD_ORACLE_LEN = 1 << 13;     // 8192 > any slider W
/** Internal (non-parameterized) value seed -- SlidingDDSketch has NO seed (no hash). */
const SLD_STREAM_SEED = 0x5d5d5d5d;
/** The value stream shifts its lognormal center at the midpoint of each buffer lap (recent-vs-old). */
export const SLD_MU_LO = 1.0;
export const SLD_MU_HI = 2.0;
export const SLD_SIGMA = 0.55;

export const Q_P50 = 0;          // sd.quantile(0.5)
export const Q_P50T = 1;         // exact windowed p50 (oracle)
export const Q_P90 = 2;
export const Q_P90T = 3;
export const Q_P99 = 4;
export const Q_P99T = 5;
export const Q_MAXREL = 6;       // max rel error over the three quantiles
export const Q_ALPHA = 7;        // the alpha bound
export const Q_FRAC = 8;         // maxrel / alpha (accuracy cursor, must stay <= 1)
export const Q_COUNT = 9;        // sd.count() -- windowed value count
export const Q_LIVE = 10;        // exact live pane-content count (oracle occupancy)
export const Q_EDGE = 11;        // |live - min(N, W)| -- window-edge error (<= one pane width)
export const Q_COLLAPSED = 12;   // 1 if any live pane folded mass into its collapsed floor
export const Q_PANES = 13;
export const Q_W = 14;
export const Q_NOW = 15;
export const Q_N = 16;
export const Q_SKETCH_BYTES = 17;// sd.bytes (fixed)
export const Q_ORACLE_BYTES = 18;// live * 16 ((t, value) pairs, O(W))
export const Q_SKETCH_ALLOC = 19;
export const Q_ORACLE_ALLOC = 20;
export const SLD_FLAT_LEN = 21;

/** The grid-pane end covering time `t` for pane width `pw` (matches test/witness.mjs sldPaneEnd). */
function sldPaneEnd(t, pw) { return (Math.floor(t / pw) + 1) * pw; }

/** The lognormal center for a buffer index: LO for the first half of each lap, HI for the second. */
function sldMu(bufIdx, len) { return (bufIdx < (len >> 1)) ? SLD_MU_LO : SLD_MU_HI; }

/** Fill the reused positive value stream (lognormal via Box-Muller). Warmup / topology only. */
function fillSldStream(world) {
    const vals = world.vals, len = vals.length;
    const rng = makeRng(SLD_STREAM_SEED);
    for (let i = 0; i < len; i++) {
        let u1 = rng(); if (u1 < 1e-12) u1 = 1e-12;
        const u2 = rng();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        vals[i] = Math.exp(sldMu(i, len) + SLD_SIGMA * z);   // strictly positive
    }
}

/**
 * Build the Scene-07 world ONCE. The REAL SlidingDDSketch, an exact windowed sorted-array oracle over
 * the LIVE pane content (a preallocated (t, value) ring + a PREALLOCATED sort buffer -- insertion-sorted
 * per query, NEVER .sort()/allocated), the reused value stream, and the flat buffer. Fails closed on a
 * bad W / alpha / panes via the ctor guard.
 * @param {number} W       window span (finite > 0).
 * @param {number} alpha   relative-error target in (0, 1).
 * @param {number} panes   pane-ring size B in [2, 1024].
 */
export function createSldWorld(W, alpha, panes) {
    const sd = new SlidingDDSketch(W, { alpha, panes });   // throws [lite-adaptive] on bad args
    const world = {
        sd, W, alpha, panes, pw: W / panes, paused: false,
        vals: new Float64Array(SLD_STREAM_LEN),
        streamMask: SLD_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, frameNowStart: 0, now: 0, n: 0, sink: 0,
        valuesPerFrame: SLD_VALUES_PER_FRAME,
        packed: new Float64Array(2),                   // [now, value] scratch for addFrom (reused)
        oT: new Float64Array(SLD_ORACLE_LEN),          // in-window arrival times (ring)
        oV: new Float64Array(SLD_ORACLE_LEN),          // in-window values (ring)
        oMask: SLD_ORACLE_LEN - 1, oHead: 0, oTail: 0,
        sortBuf: new Float64Array(SLD_ORACLE_LEN),     // preallocated insertion-sort scratch (NO per-query alloc)
        flat: new Float64Array(SLD_FLAT_LEN),
    };
    fillSldStream(world);
    return world;
}

/**
 * One SKETCH-path frame: advance the clock and feed `valuesPerFrame` (now, value) pairs to the REAL
 * SlidingDDSketch.addFrom (0 B/op incl. pane rotation). While paused, idle-slides via advanceFrom (NO
 * add) so the windowed quantiles slide to NaN. 0 B/op.
 * @param {object} world
 * @returns {number} an int32 fold (defeat DCE).
 */
export function stepSld(world) {
    if (world.paused) {
        const now = world.now + world.valuesPerFrame;
        world.packed[0] = now;
        world.sd.advanceFrom(world.packed, 0);
        world.now = now; world.frameNowStart = now; world.frameCount = 0;
        return 0;
    }
    const vals = world.vals, mask = world.streamMask, sd = world.sd, vpf = world.valuesPerFrame;
    const packed = world.packed;
    let pos = world.cursor, now = world.now;
    world.frameStart = pos & mask;
    world.frameNowStart = now;
    let sink = 0;
    for (let i = 0; i < vpf; i++) {
        const idx = pos & mask;
        now = now + 1;
        packed[0] = now; packed[1] = vals[idx];
        sd.addFrom(packed, 0);
        sink = (sink + (now | 0)) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.now = now; world.frameCount = vpf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One EXACT-ORACLE frame: replay the frame's values into the (t, value) ring (bumping the owned
 * retained-samples counter -- the O(W) contrast) and expire entries whose grid pane has fallen out of
 * the window (matching the sketch's physically-retained content EXACTLY, so the render's rel-error is
 * purely bucket error). The ring is preallocated (sized > W). 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the live oracle sample count.
 */
export function stepSldOracle(world, allocState) {
    const vals = world.vals, mask = world.streamMask;
    const start = world.frameStart, count = world.frameCount, W = world.W, pw = world.pw;
    const oT = world.oT, oV = world.oV, omask = world.oMask;
    let now = world.frameNowStart, head = world.oHead, tail = world.oTail;
    for (let i = 0; i < count; i++) {
        now = now + 1;
        oT[tail] = now; oV[tail] = vals[(start + i) & mask]; tail = (tail + 1) & omask;
        allocState.oracleCount++;                       // a retained sample the sketch refuses to keep
    }
    // 1.7.0 F7: the ring holds B+1 panes, so the covered span is (E - W - pw, E] -- [W, W + W/B].
    const liveCut = sldPaneEnd(now, pw) - W - pw;
    while (head !== tail && sldPaneEnd(oT[head], pw) <= liveCut) head = (head + 1) & omask;
    world.oHead = head; world.oTail = tail;
    world.n = (world.n + count) | 0;
    return (tail - head) & omask;
}

/**
 * Render-prep (~10Hz): re-derive every displayed SlidingDDSketch number LIVE from the shipped instance
 * vs an exact sorted-array oracle over the LIVE pane content. The oracle scans the ring, insertion-sorts
 * the live values into the PREALLOCATED sortBuf (0 alloc, NO .sort()), and reads the p50/p90/p99. The
 * sd.quantile queries are COLD 0-alloc. 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the windowed p50 (folded).
 */
export function renderSldPrep(world, allocState) {
    const sd = world.sd, flat = world.flat, pw = world.pw, W = world.W;
    const oT = world.oT, oV = world.oV, omask = world.oMask, sortBuf = world.sortBuf;
    const liveCut = sldPaneEnd(world.now, pw) - W - pw;   // B+1 covered span (F7)
    // insertion-sort the live pane content into the preallocated buffer (0 alloc).
    let m = 0, i = world.oHead;
    const tail = world.oTail;
    while (i !== tail) {
        if (sldPaneEnd(oT[i], pw) > liveCut) {
            const v = oV[i];
            let j = m - 1;
            while (j >= 0 && sortBuf[j] > v) { sortBuf[j + 1] = sortBuf[j]; j--; }
            sortBuf[j + 1] = v; m++;
        }
        i = (i + 1) & omask;
    }
    const p50e = sd.quantile(0.5), p90e = sd.quantile(0.9), p99e = sd.quantile(0.99);
    let p50t = NaN, p90t = NaN, p99t = NaN, maxRel = 0;
    if (m > 0) {
        p50t = sortBuf[(0.5 * (m - 1)) | 0];
        p90t = sortBuf[(0.9 * (m - 1)) | 0];
        p99t = sortBuf[(0.99 * (m - 1)) | 0];
        if (p50t > 0) { const r = Math.abs(p50e - p50t) / p50t; if (r > maxRel) maxRel = r; }
        if (p90t > 0) { const r = Math.abs(p90e - p90t) / p90t; if (r > maxRel) maxRel = r; }
        if (p99t > 0) { const r = Math.abs(p99e - p99t) / p99t; if (r > maxRel) maxRel = r; }
    }
    const cnt = sd.count();
    const exactWin = world.n < W ? world.n : W;
    flat[Q_P50] = p50e; flat[Q_P50T] = p50t;
    flat[Q_P90] = p90e; flat[Q_P90T] = p90t;
    flat[Q_P99] = p99e; flat[Q_P99T] = p99t;
    flat[Q_MAXREL] = maxRel;
    flat[Q_ALPHA] = sd.alpha;
    flat[Q_FRAC] = sd.alpha > 0 ? maxRel / sd.alpha : 0;
    flat[Q_COUNT] = cnt;
    flat[Q_LIVE] = m;
    flat[Q_EDGE] = Math.abs(m - exactWin);
    flat[Q_COLLAPSED] = sd.collapsed ? 1 : 0;
    flat[Q_PANES] = sd.panes;
    flat[Q_W] = sd.W;
    flat[Q_NOW] = world.now;
    flat[Q_N] = world.n;
    flat[Q_SKETCH_BYTES] = sd.bytes;
    flat[Q_ORACLE_BYTES] = m * (BYTES_PER_F64 * 2);
    flat[Q_SKETCH_ALLOC] = allocState.sketchCount;
    flat[Q_ORACLE_ALLOC] = allocState.oracleCount;
    return p50e;
}

// =======================================================================================
// Scene 08 -- SlidingCountMin (windowed per-label frequency)
// =======================================================================================

/** Pre-generated key-stream length (pow2). */
export const SCM_STREAM_LEN = 1 << 16;
/** Keys fed per rAF frame (one now-tick per key). */
export const SCM_KEYS_PER_FRAME = 64;
/** Default window span W, relative-error target epsilon, and pane-ring size B. */
export const SCM_DEFAULT_W = 2048;
export const SCM_DEFAULT_EPS = 0.02;
export const SCM_DEFAULT_PANES = 32;
/** Default hash seed. */
export const SCM_DEFAULT_SEED = 0x9e3779b1;
/** Number of tracked keys drawn on the leaderboard (the hottest keys). */
export const SCM_TRACKED = 4;
/** The Zipfian key universe + skew for the stream. */
export const SCM_UNIVERSE = 512;
export const SCM_SKEW = 1.05;
/** Exact-oracle ring capacity (pow2) -- MUST exceed W + one pane. */
export const SCM_RING_LEN = 1 << 13;       // 8192 > any slider W
/** Flat stride per tracked key: [est, true(W), upperBound]. */
export const SCM_STRIDE = 3;

// per-tracked-key slots occupy [0, SCM_TRACKED*SCM_STRIDE); est at i*3, true(W) at i*3+1, upper at i*3+2.
export const C_BOUNDOK = SCM_TRACKED * SCM_STRIDE;     // 12: 1 if every tracked key's est is inside the one-sided band
export const C_SATURATED = C_BOUNDOK + 1;              // saturated-increment count (honesty flag)
export const C_NLIVE = C_BOUNDOK + 2;                  // live (windowed) item count
export const C_N = C_BOUNDOK + 3;                      // total adds
export const C_EPS = C_BOUNDOK + 4;                    // epsilon
export const C_PANES = C_BOUNDOK + 5;
export const C_W = C_BOUNDOK + 6;
export const C_NOW = C_BOUNDOK + 7;
export const C_SKETCH_BYTES = C_BOUNDOK + 8;           // scm.bytes (fixed)
export const C_ORACLE_BYTES = C_BOUNDOK + 9;           // live * 16 ((t, key) pairs, O(W))
export const C_SKETCH_ALLOC = C_BOUNDOK + 10;
export const C_ORACLE_ALLOC = C_BOUNDOK + 11;
export const SCM_FLAT_LEN = C_BOUNDOK + 12;

/** The grid-pane end covering time `t` for pane width `pw` (matches the SlidingCountMin pane math). */
function scmPaneEnd(t, pw) { return (Math.floor(t / pw) + 1) * pw; }

/** Fill the reused Zipfian key stream (cached CDF). Warmup / topology only. */
function fillScmStream(world) {
    const stream = world.stream, len = stream.length, U = SCM_UNIVERSE, skew = world.skew;
    const rng = makeRng(world.seed);
    const cdf = new Float64Array(U);
    let sum = 0;
    for (let i = 0; i < U; i++) { sum += 1 / Math.pow(i + 1, skew); cdf[i] = sum; }
    for (let i = 0; i < U; i++) cdf[i] /= sum;
    for (let n = 0; n < len; n++) {
        const u = rng();
        let lo = 0, hi = U - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
        stream[n] = lo;
    }
}

/**
 * Build the Scene-08 world ONCE. The REAL SlidingCountMin, an exact per-key windowed (t, key) ring
 * oracle, the reused Zipfian key stream, the tracked-key list (the hottest keys 0..SCM_TRACKED-1), and
 * the flat buffer. Fails closed on a bad W / epsilon / panes / seed via the ctor guard.
 * @param {number} W        window span (finite > 0).
 * @param {number} epsilon  relative-error target in (0, 1).
 * @param {number} panes    pane-ring size B in [2, 1024].
 * @param {number} [seed]   uint32 hash seed.
 */
export function createScmWorld(W, epsilon, panes, seed) {
    const s = (seed === undefined || seed === null) ? SCM_DEFAULT_SEED : (seed >>> 0);
    const scm = new SlidingCountMin(W, { epsilon, panes, seed: s });   // throws [lite-adaptive] on bad args
    const tracked = new Float64Array(SCM_TRACKED);
    for (let i = 0; i < SCM_TRACKED; i++) tracked[i] = i;   // the hottest Zipfian keys
    const world = {
        scm, W, epsilon, panes, seed: s, pw: W / panes, paused: false,
        skew: SCM_SKEW, tracked,
        stream: new Uint32Array(SCM_STREAM_LEN),
        streamMask: SCM_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, frameNowStart: 0, now: 0, n: 0, sink: 0,
        keysPerFrame: SCM_KEYS_PER_FRAME,
        packed: new Float64Array(3),                   // [now, key, count] scratch for addFrom (reused)
        oT: new Float64Array(SCM_RING_LEN),            // in-window arrival times (ring)
        oKey: new Float64Array(SCM_RING_LEN),          // in-window keys (ring)
        oMask: SCM_RING_LEN - 1, oHead: 0, oTail: 0,
        flat: new Float64Array(SCM_FLAT_LEN),
    };
    fillScmStream(world);
    return world;
}

/**
 * One SKETCH-path frame: advance the clock and feed `keysPerFrame` [now, key, 1] triples UNBOXED to
 * the REAL SlidingCountMin.addFrom (amortized 0 B/op incl. pane rotate + clear). While paused,
 * idle-slides via advanceFrom (NO add) so tracked-key estimates slide to 0. 0 B/op.
 * @param {object} world
 * @returns {number} an int32 fold (defeat DCE).
 */
export function stepScm(world) {
    if (world.paused) {
        const now = world.now + world.keysPerFrame;
        world.packed[0] = now;
        world.scm.advanceFrom(world.packed, 0);
        world.now = now; world.frameNowStart = now; world.frameCount = 0;
        return 0;
    }
    const stream = world.stream, mask = world.streamMask, scm = world.scm, kpf = world.keysPerFrame;
    const packed = world.packed;
    let pos = world.cursor, now = world.now;
    world.frameStart = pos & mask;
    world.frameNowStart = now;
    let sink = 0;
    for (let i = 0; i < kpf; i++) {
        now = now + 1;
        packed[0] = now; packed[1] = stream[pos & mask]; packed[2] = 1;
        scm.addFrom(packed, 0);
        sink = (sink + (now | 0)) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.now = now; world.frameCount = kpf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One EXACT-ORACLE frame: replay the frame's keys into the (t, key) ring (bumping the owned counter --
 * the O(W) retained-pairs contrast) and expire entries whose grid pane has fallen out of the window.
 * The ring is preallocated (sized > W). 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the live oracle sample count.
 */
export function stepScmOracle(world, allocState) {
    const stream = world.stream, mask = world.streamMask;
    const start = world.frameStart, count = world.frameCount, W = world.W, pw = world.pw;
    const oT = world.oT, oKey = world.oKey, omask = world.oMask;
    let now = world.frameNowStart, head = world.oHead, tail = world.oTail;
    for (let i = 0; i < count; i++) {
        now = now + 1;
        oT[tail] = now; oKey[tail] = stream[(start + i) & mask]; tail = (tail + 1) & omask;
        allocState.oracleCount++;                       // a retained (t, key) pair the sketch refuses
    }
    const liveCut = scmPaneEnd(now, pw) - W;
    while (head !== tail && scmPaneEnd(oT[head], pw) <= liveCut) head = (head + 1) & omask;
    world.oHead = head; world.oTail = tail;
    world.n = (world.n + count) | 0;
    return (tail - head) & omask;
}

/**
 * Render-prep (~10Hz): re-derive every tracked key's shipped SlidingCountMin.estimate vs the EXACT
 * one-sided band [true(W), true(W+W/B) + eps*N] computed from the (t, key) ring in ONE scan. Verifies
 * the bound per tracked key. scm.estimate is COLD 0-alloc; the ring scan is 0-alloc. 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} tracked key 0's estimate (folded).
 */
export function renderScmPrep(world, allocState) {
    const scm = world.scm, flat = world.flat, pw = world.pw, W = world.W, eps = world.epsilon;
    const oT = world.oT, oKey = world.oKey, omask = world.oMask, tracked = world.tracked;
    const now = world.now;
    const liveThresh = scmPaneEnd(now, pw) - W;   // an add is LIVE iff paneEnd(t) >= this
    const idealCut = now - W;                      // ideal window (now - W, now]
    const nt = SCM_TRACKED;
    // one scan over the live ring, bucketing per tracked key. trueIdeal / trueLive live in the flat slots.
    let nLive = 0;
    for (let k = 0; k < nt; k++) { flat[k * SCM_STRIDE + 1] = 0; flat[k * SCM_STRIDE + 2] = 0; }  // reuse +1/+2 as accumulators
    let i = world.oHead;
    const tail = world.oTail;
    while (i !== tail) {
        const pe = scmPaneEnd(oT[i], pw);
        if (pe >= liveThresh) {
            nLive++;
            const key = oKey[i];
            const ideal = oT[i] > idealCut ? 1 : 0;
            for (let k = 0; k < nt; k++) {
                if (tracked[k] === key) {
                    if (ideal) flat[k * SCM_STRIDE + 1] += 1;   // true(W)
                    flat[k * SCM_STRIDE + 2] += 1;              // trueLive (W + W/B)
                    break;
                }
            }
        }
        i = (i + 1) & omask;
    }
    let boundOk = 1;
    for (let k = 0; k < nt; k++) {
        const est = scm.estimate(tracked[k]);
        const trueW = flat[k * SCM_STRIDE + 1];
        const trueLive = flat[k * SCM_STRIDE + 2];
        const upper = trueLive + eps * nLive;
        if (est < trueW - 1e-9 || est > upper + 1e-9) boundOk = 0;
        flat[k * SCM_STRIDE] = est;
        flat[k * SCM_STRIDE + 1] = trueW;
        flat[k * SCM_STRIDE + 2] = upper;
    }
    flat[C_BOUNDOK] = boundOk;
    flat[C_SATURATED] = scm.saturated;
    flat[C_NLIVE] = nLive;
    flat[C_N] = world.n;
    flat[C_EPS] = eps;
    flat[C_PANES] = scm.panes;
    flat[C_W] = scm.W;
    flat[C_NOW] = now;
    flat[C_SKETCH_BYTES] = scm.bytes;
    flat[C_ORACLE_BYTES] = nLive * (BYTES_PER_F64 * 2);
    flat[C_SKETCH_ALLOC] = allocState.sketchCount;
    flat[C_ORACLE_ALLOC] = allocState.oracleCount;
    return flat[0];
}

// =======================================================================================
// Scene 09 -- DecayedReservoir (recency-biased fixed-k sample)
// =======================================================================================

/** Pre-generated add-stream length (pow2). Values are the arrival timestamps (explicit mode). */
export const DR_STREAM_LEN = 1 << 16;
/** Adds fed per rAF frame (one now-tick per add). */
export const DR_ADDS_PER_FRAME = 32;
/** Default sample size k and decay half-life. */
export const DR_DEFAULT_K = 24;
export const DR_DEFAULT_HALFLIFE = 2048;
/** Default PRNG seed. */
export const DR_DEFAULT_SEED = 0x2545f491;
/** Age-histogram bin count (the inclusion-by-age view). */
export const DR_AGE_BINS = 32;
/** The age span (in now-units) the histogram covers (~ a few half-lives). */
export const DR_AGE_SPAN_MULT = 4;

export const R_SIZE = 0;         // dr.size (retained values, <= k)
export const R_K = 1;            // the sample size k
export const R_MEANAGE = 2;      // mean age of the current sample (in now-units)
export const R_NEWEST = 3;       // newest (smallest) age in the sample
export const R_OLDEST = 4;       // oldest (largest) age in the sample
export const R_RECENCYFRAC = 5;  // fraction of the sample younger than one half-life
export const R_HALFLIFE = 6;     // decay half-life
export const R_LAMBDA = 7;       // decay rate lambda
export const R_N = 8;            // total adds
export const R_SKETCH_BYTES = 9; // dr.bytes (fixed)
export const R_ORACLE_BYTES = 10;// n*8 -- brute-force decayed sampling retains O(N)
export const R_SKETCH_ALLOC = 11;
export const R_ORACLE_ALLOC = 12;
export const DR_FLAT_LEN = 13;

/**
 * Build the Scene-09 world ONCE. The REAL DecayedReservoir (EXPLICIT time; the stored value IS the
 * arrival timestamp so age = now - value), a preallocated sample buffer + age histogram, and the
 * flat buffer. Fails closed on a bad k / halfLife / seed via the ctor guard.
 * @param {number} k         sample size (positive integer).
 * @param {number} halfLife  decay half-life (finite > 0).
 * @param {number} [seed]    uint32 PRNG seed.
 */
export function createDrWorld(k, halfLife, seed) {
    const s = (seed === undefined || seed === null) ? DR_DEFAULT_SEED : (seed >>> 0);
    const dr = new DecayedReservoir(k, halfLife, { seed: s });   // throws [lite-adaptive] on bad args
    const world = {
        dr, k, halfLife, lambda: Math.LN2 / halfLife, seed: s,
        cursor: 0, frameCount: 0, now: 0, n: 0, sink: 0,
        addsPerFrame: DR_ADDS_PER_FRAME,
        packed: new Float64Array(2),                   // [now, value] scratch for addFrom (reused)
        sampleBuf: new Float64Array(k),                // sampleInto target (reused)
        ageHist: new Int32Array(DR_AGE_BINS),          // inclusion-by-age view (reused)
        flat: new Float64Array(DR_FLAT_LEN),
    };
    return world;
}

/**
 * One SKETCH-path frame: advance the clock and offer `addsPerFrame` (now, value=now) pairs to the REAL
 * DecayedReservoir.addFrom (amortized 0 B/op incl. the PRNG draw + min-forest sift + landmark rebase).
 * The stored value is the timestamp so the sample's recency is directly readable. 0 B/op.
 * @param {object} world
 * @returns {number} an int32 fold (defeat DCE).
 */
export function stepDr(world) {
    const dr = world.dr, apf = world.addsPerFrame, packed = world.packed;
    let now = world.now;
    let sink = 0;
    for (let i = 0; i < apf; i++) {
        now = now + 1;
        packed[0] = now; packed[1] = now;   // value = arrival timestamp
        dr.addFrom(packed, 0);
        sink = (sink + dr.size) | 0;
    }
    world.now = now; world.n = (world.n + apf) | 0; world.frameCount = apf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One EXACT-ORACLE frame (the allowed-to-allocate-in-spirit contrast): an unbiased brute-force decayed
 * sample would retain EVERY value and re-draw; we bump the owned counter per add (the O(N) retained
 * contrast) -- the sketch keeps only k. 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} total adds.
 */
export function stepDrOracle(world, allocState) {
    const count = world.frameCount;
    for (let i = 0; i < count; i++) allocState.oracleCount++;   // a retained value brute-force sampling keeps
    return world.n;
}

/**
 * Render-prep (~10Hz): copy the current sample into the preallocated buffer (0 alloc), derive its age
 * distribution (age = now - value) into the reused age histogram, and re-derive every displayed number
 * LIVE from the shipped DecayedReservoir. sampleInto is 0-alloc; the histogram fill is 0-alloc. 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the sample size (folded).
 */
export function renderDrPrep(world, allocState) {
    const dr = world.dr, flat = world.flat, buf = world.sampleBuf, hist = world.ageHist;
    const now = world.now, halfLife = world.halfLife;
    const c = dr.sampleInto(buf);
    const span = DR_AGE_SPAN_MULT * halfLife;
    hist.fill(0);
    let sumAge = 0, newest = Infinity, oldest = 0, recent = 0;
    for (let i = 0; i < c; i++) {
        let age = now - buf[i]; if (age < 0) age = 0;
        sumAge += age;
        if (age < newest) newest = age;
        if (age > oldest) oldest = age;
        if (age < halfLife) recent++;
        let b = span > 0 ? ((age / span) * DR_AGE_BINS) | 0 : 0;
        if (b < 0) b = 0; else if (b >= DR_AGE_BINS) b = DR_AGE_BINS - 1;
        hist[b]++;
    }
    if (c === 0) newest = 0;
    flat[R_SIZE] = c;
    flat[R_K] = dr.k;
    flat[R_MEANAGE] = c > 0 ? sumAge / c : 0;
    flat[R_NEWEST] = newest;
    flat[R_OLDEST] = oldest;
    flat[R_RECENCYFRAC] = c > 0 ? recent / c : 0;
    flat[R_HALFLIFE] = dr.halfLife;
    flat[R_LAMBDA] = dr.lambda;
    flat[R_N] = world.n;
    flat[R_SKETCH_BYTES] = dr.bytes;
    flat[R_ORACLE_BYTES] = world.n * BYTES_PER_F64;
    flat[R_SKETCH_ALLOC] = allocState.sketchCount;
    flat[R_ORACLE_ALLOC] = allocState.oracleCount;
    return c;
}
