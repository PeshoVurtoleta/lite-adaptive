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
    SlidingDDSketch, SlidingCountMin, DecayedReservoir, SlidingAggregate,
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
/** D1 `dense10k` preset: a tight window with a sub-unit arrival gap so the in-window population
 *  (~W/gap = 10240) blows past a W-sized pool -> the tagged overflow throw the demo catches. */
export const EH_DENSE_W = 1024;
export const EH_DENSE_GAP = 0.1;
/** D1 F17 `spike` values: an INTEGER spike train (exact sum), a big value every EH_SPIKE_PERIOD ticks. */
export const EH_SPIKE_PERIOD = 1500;
export const EH_SPIKE_VALUE = 1e6;

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
// --- 1.8.0 (D1) APPEND-ONLY slots (never renumber 0..13; golden-flat.json pins those bits) ---
export const E_MAXCOUNT = 14;     // eh.maxCount (the declared population bound, PUBLIC getter)
export const E_CEIL = 15;         // the EXACT pool ceiling k*(2^levels-1) from eh.k / eh.levels
export const E_POP = 16;          // exact live window population (the exact-ring occupancy)
export const E_SUM = 17;          // eh.sum() -- the windowed sum estimate
export const E_TRUESUM = 18;      // exact windowed sum over the ring VALUE column
export const E_STRADDLE = 19;     // straddling (oldest) bucket size, via the EhProbe (render only)
export const E_SUMFRAC = 20;      // |sum - truesum| / (straddle/2) -- the STATED sum bound cursor (<= 1)
export const E_SUMRELEPS = 21;    // relerr(sum)/eps -- the OLD "sum <= eps" claim (visibly > 1 on spikes)
export const E_FAILED = 22;       // 1 once the pool overflowed and the tagged throw was caught
export const EH_FLAT_LEN = 23;

/**
 * Demo-local EhProbe (D1): a subclass that reads the PRIVATE straddling (oldest) bucket size EXACTLY as
 * test/witness.mjs's EhProbe does -- the ONLY source of sum() error, so the demo can draw sum()'s error
 * against its STATED bound size(straddling bucket)/2. `straddleInto` writes the size into a caller-owned
 * slot and NEVER returns the double (zero-box law). count() / sum() / addFrom() inherit UNCHANGED, so
 * world.eh stays byte-identical to a plain ExponentialHistogram on every hot call (the golden proves it).
 * Called ONLY from renderEhPrep (~10Hz), never the frame path.
 */
class EhProbe extends ExponentialHistogram {
    straddleInto(flat, idx) {
        if (this._count === 0) { flat[idx] = 0; return; }
        const oldest = this._head[this._maxLevel];
        flat[idx] = this._start[oldest] <= this._now - this._W ? this._size[oldest] : 0;
    }
}

/** Write world.eh's straddling-bucket size into flat[idx] via the EhProbe (never a returned double). */
export function ehStraddleInto(world, flat, idx) { world.eh.straddleInto(flat, idx); }

/** Fill the world's reused GAP + VALUE streams (warmup / topology only). Two shapes:
 *  - default: a dense -> sparse -> dense rate schedule (the measureShift shape) so the windowed count
 *    visibly fills and expires; the `dense10k` preset overrides it with a constant sub-unit gap.
 *  - values 'uniform' (default): every value 1 -> sum == count (golden-identical). 'spike': an INTEGER
 *    spike train (exact sum) that makes sum()'s error track the straddle mass, NOT epsilon (F17). */
function fillGapStream(world) {
    const gaps = world.gaps, vals = world.vals, len = gaps.length;
    const rng = makeRng(world.seed);
    const dense = world.preset === 'dense10k', spike = world.values === 'spike';
    for (let i = 0; i < len; i++) {
        if (dense) {
            gaps[i] = EH_DENSE_GAP;   // constant sub-unit arrival gap (~10240 in-window at W=1024)
        } else {
            const phase = i / len;
            // dense (gap ~1) for the outer thirds, sparse (gap ~4) for the middle third -- a rate shift.
            const base = (phase < 0.34 || phase > 0.66) ? 1 : 4;
            gaps[i] = base + (rng() < 0.15 ? 1 : 0);   // a touch of jitter, still strictly positive
        }
        // INTEGER values so the exact-sum oracle is exact; uniform (1) keeps sum == count at defaults.
        vals[i] = spike ? ((i % EH_SPIKE_PERIOD === 0) ? EH_SPIKE_VALUE : 1) : 1;
    }
}

/**
 * Demo-local option-door guard (fail closed, cold path only): reject anything but a PLAIN object, then
 * reject any own key not in `allowed` with a did-you-mean hint. Mirrors the shipped lite-law option door
 * -- an unknown key / a Symbol key / an array / a prototype-bearing object is an ERROR, never a silent
 * ignore. Never called on a hot loop.
 * @param {object} opts    the caller options (already known non-null/undefined).
 * @param {string[]} allowed  the permitted own-key whitelist.
 * @param {string} label   the scene tag for the thrown message.
 */
function checkDemoOptions(opts, allowed, label) {
    if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
        throw new TypeError('[lite-adaptive] ' + label + ' options must be a plain object, got ' +
            (Array.isArray(opts) ? 'an array' : (opts === null ? 'null' : typeof opts)));
    }
    const proto = Object.getPrototypeOf(opts);
    if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('[lite-adaptive] ' + label + ' options must be a plain object (no prototype keys)');
    }
    if (Object.getOwnPropertySymbols(opts).length !== 0) {
        throw new TypeError('[lite-adaptive] ' + label + ' options must not carry Symbol keys');
    }
    for (const key of Object.keys(opts)) {
        if (allowed.indexOf(key) === -1) {
            let hint = '';
            for (let i = 0; i < allowed.length; i++) {
                const a = allowed[i];
                if (a.toLowerCase() === key.toLowerCase() || a[0] === key[0]) { hint = ' (did you mean "' + a + '"?)'; break; }
            }
            throw new TypeError('[lite-adaptive] ' + label + ' unknown option "' + key + '"' + hint +
                '; allowed: ' + allowed.join(', '));
        }
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
export function createEhWorld(W, epsilon, seed, options) {
    // null is not zero: fall back ONLY on undefined/null so an explicit seed=0 is honored.
    // Fail closed (suite law): reject a non-number / non-finite seed BEFORE allocation -- never coerce
    // NaN / a string to 0 via >>> 0. -0 and any finite value (incl. >= 2^31, which >>> 0 folds) pass.
    if (seed !== undefined && seed !== null && (typeof seed !== 'number' || !Number.isFinite(seed))) {
        throw new TypeError('[lite-adaptive] EH seed must be a finite number, got ' +
            (typeof seed === 'string' ? JSON.stringify(seed) : String(seed)));
    }
    const s = (seed === undefined || seed === null) ? EH_DEFAULT_SEED : (seed >>> 0);
    // Options (D1): a PLAIN object door -- { maxCount, preset, values }. An absent object is the default
    // (maxCount 2^32, no preset, uniform values) so a 3-arg call stays golden-identical.
    const opts = (options === undefined || options === null) ? null : options;
    if (opts !== null) checkDemoOptions(opts, ['maxCount', 'preset', 'values'], 'EH');
    const preset = opts && opts.preset !== undefined ? opts.preset : null;
    if (preset !== null && preset !== 'dense10k') {
        throw new TypeError('[lite-adaptive] EH preset must be null or "dense10k", got ' + JSON.stringify(preset));
    }
    const values = opts && opts.values !== undefined ? opts.values : 'uniform';
    if (values !== 'uniform' && values !== 'spike') {
        throw new TypeError('[lite-adaptive] EH values must be "uniform" or "spike", got ' + JSON.stringify(values));
    }
    // The `dense10k` preset forces the tight window (its constant sub-unit gap is what overflows a
    // W-sized pool); an explicit W is honored otherwise.
    const w = preset === 'dense10k' ? EH_DENSE_W : W;
    // maxCount rides the EH ctor's PLAIN-object option door untouched (typeof-checked, did-you-mean).
    const eh = (opts && opts.maxCount !== undefined)
        ? new EhProbe(w, epsilon, { maxCount: opts.maxCount })   // throws [lite-adaptive] on a bad arg
        : new EhProbe(w, epsilon);
    const world = {
        eh, W: w, epsilon, seed: s, preset, values, paused: false,
        // oracle gate (D1 blocker 2): the exact-ring oracle can be toggled off. When off, the oracle-derived
        // slots fail closed to NaN in renderEhPrep (cold branch) instead of showing a frozen stale bound as
        // live. resumeNow marks the `now` at which it was last re-enabled: the ring is stale for a full
        // window W after resume, so the sum/accuracy gauges hold NaN until now - resumeNow >= W.
        oracleOn: true, resumeNow: -Infinity,
        failed: 0, failMsg: '',                        // fail-closed banner state (set ONCE, cold path)
        gaps: new Float64Array(EH_STREAM_LEN),
        vals: new Float64Array(EH_STREAM_LEN),         // per-arrival VALUE column (exact-sum oracle)
        streamMask: EH_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, frameNowStart: 0, now: 0, sink: 0,
        arrivalsPerFrame: EH_ARRIVALS_PER_FRAME,
        packed: new Float64Array(2),                   // [now, value] scratch for addFrom (reused)
        ring: new Float64Array(EH_RING_LEN),           // exact in-window timestamps
        ringV: new Float64Array(EH_RING_LEN),          // exact in-window VALUES (parallel to ring)
        ringMask: EH_RING_LEN - 1, ringHead: 0, ringTail: 0, trueSum: 0,
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
    const gaps = world.gaps, vals = world.vals, mask = world.streamMask;
    const eh = world.eh, apf = world.arrivalsPerFrame, packed = world.packed;
    let pos = world.cursor, now = world.now;
    world.frameStart = pos & mask;
    world.frameNowStart = now;
    let sink = 0;
    for (let i = 0; i < apf; i++) {
        const idx = pos & mask;
        now = now + gaps[idx];
        packed[0] = now; packed[1] = vals[idx];   // value rides a Float64 slot (uniform 1 or integer spike)
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
 * D1 fail-closed wrapper: run one SKETCH frame inside a try/catch. On the tagged pool-overflow throw
 * (the `dense10k` preset against a W-sized maxCount) set world.failed and store the LIBRARY's own
 * message ONCE -- the honesty signal the demo renders instead of a silent NaN. The catch is a COLD
 * path: once failed, subsequent frames short-circuit, so the normal frame path stays 0 B/op and
 * branch-light (stepEh itself is unchanged; the guard lives here, not in the hot body).
 * @param {object} world
 * @returns {number} the stepEh fold (0 once failed).
 */
export function stepEhGuarded(world) {
    if (world.failed === 1) return 0;   // already overflowed: do not re-enter the throwing add
    try {
        return stepEh(world);
    } catch (e) {
        world.failed = 1;
        world.failMsg = (e && e.message) ? e.message : String(e);   // the library's own words, stored ONCE
        return 0;
    }
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
    const gaps = world.gaps, vals = world.vals, mask = world.streamMask;
    const start = world.frameStart, count = world.frameCount, W = world.W;
    const ring = world.ring, ringV = world.ringV, rmask = world.ringMask;
    let now = world.frameNowStart, tail = world.ringTail, head = world.ringHead;
    let trueSum = world.trueSum;
    for (let i = 0; i < count; i++) {
        const idx = (start + i) & mask;
        now = now + gaps[idx];
        const v = vals[idx];
        ring[tail] = now; ringV[tail] = v; tail = (tail + 1) & rmask; trueSum += v;
        if (tail === head) { trueSum -= ringV[head]; head = (head + 1) & rmask; }   // ring full -> drop oldest
        allocState.oracleCount++;                        // a retained arrival the sketch refuses
    }
    const cutoff = now - W;
    while (head !== tail && ring[head] <= cutoff) { trueSum -= ringV[head]; head = (head + 1) & rmask; }
    world.ringHead = head; world.ringTail = tail; world.trueSum = trueSum;
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
    // --- 1.8.0 (D1) APPEND-ONLY: the pool gauge, the exact-sum vs straddle bound, the fail-closed flag ---
    const sum = eh.sum(), truesum = world.trueSum, sumErr = Math.abs(sum - truesum);
    flat[E_MAXCOUNT] = eh.maxCount;                             // PUBLIC declared population bound
    flat[E_CEIL] = eh.k * (Math.pow(2, eh.levels) - 1);        // EXACT pool ceiling from the shipped getters
    flat[E_POP] = live;                                         // exact live window population
    flat[E_SUM] = sum;
    flat[E_TRUESUM] = truesum;
    ehStraddleInto(world, flat, E_STRADDLE);                    // straddle size into the slot (no double return)
    // STATED bound: |sum_est - sum_true| <= size(straddling bucket)/2 (the witness bound + its FP slack).
    const bound = flat[E_STRADDLE] / 2 + 1e-6 * Math.max(1, Math.abs(truesum));
    flat[E_SUMFRAC] = sumErr / bound;                          // the drawn cursor (<= 1 when the bound holds)
    // the OLD "sum() <= eps" claim: relerr(sum)/eps -- VISIBLY > 1 on a spike stream (sum is NOT eps-bounded).
    const relSum = Math.abs(truesum) > 0 ? sumErr / Math.abs(truesum) : 0;
    flat[E_SUMRELEPS] = eps > 0 ? relSum / eps : 0;
    flat[E_FAILED] = world.failed;
    // Oracle gate (D1 blocker 2), COLD branch: every displayed number that derives from the exact ring
    // (E_TRUE, E_RELERR, E_FRAC, E_POP, E_TRUESUM, E_SUMFRAC, E_SUMRELEPS) is meaningless when the ring is
    // not a faithful (now - W, now] snapshot. Fail closed to NaN (rendered "n/a", gauge skipped) on ALL
    // seven rather than deriving them from a frozen/half-refilled ring and showing them as live. Two cold
    // branches, both NaN the same seven slots: (1) oracle off -> the ring is frozen stale; (2) resume hold
    // -> the ring is refilling and is not a full window valid until now - resumeNow >= W (no false red
    // gauge from a stale ring). E_RING_BYTES stays a live memory readout (the ring still occupies bytes).
    // At defaults (oracleOn true, resumeNow -Infinity) neither branch fires, so the golden stays
    // bit-identical.
    if (!world.oracleOn) {
        flat[E_TRUE] = NaN; flat[E_RELERR] = NaN; flat[E_FRAC] = NaN;
        flat[E_POP] = NaN; flat[E_TRUESUM] = NaN; flat[E_SUMFRAC] = NaN; flat[E_SUMRELEPS] = NaN;
    } else if (world.now - world.resumeNow < world.W) {
        flat[E_TRUE] = NaN; flat[E_RELERR] = NaN; flat[E_FRAC] = NaN;
        flat[E_POP] = NaN; flat[E_TRUESUM] = NaN; flat[E_SUMFRAC] = NaN; flat[E_SUMRELEPS] = NaN;
    }
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
/** D2 `bigJumpThenPlus1` preset: mean 0, then a large level shift J, then a later +1 shift (F18 -- a
 *  1.6.0 instance goes deaf to the +1 because its inflated GLOBAL range term dominates). Small jitter
 *  (AD_PRESET_JITTER) so the snapped live-window range R stays <= 1+jitter (one straddling oldest bucket
 *  of pre-shift values) while the ghost global range spans >= J. */
export const AD_JUMP = 1e4;
export const AD_JUMP_AT = 20000;
export const AD_PLUS1_AT = 40000;
export const AD_PRESET_JITTER = 0.6;
/** D2 OLD (pre-1.8.0) render scan cap, RETAINED ONLY as a test anchor: renderAdPrep no longer caps the
 *  live-window-range recompute at 256 -- it now scans the WHOLE retained window (the last `ad.width` fed
 *  values, bounded by AD_STREAM_LEN = 65536, past which it fails closed to NaN). The D2 faithfulness test
 *  asserts width > AD_LIVER_SCAN so a re-introduced 256 cap visibly disagrees with the exact range. */
export const AD_LIVER_SCAN = 256;

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
// --- 1.8.0 (D2) APPEND-ONLY slots (never renumber 0..16; golden-flat.json pins those bits) ---
export const A_OFFSET = 17;     // the absolute offset added to every stream value (F9 -- behavior invariant)
export const A_LIVER = 18;      // exact max-min over the last ad.width fed values (the live-window range R oracle)
export const A_GHOSTR = 19;     // the GHOST 1.6.0 running-GLOBAL range max-min (never shrinks -> deafness)
export const A_LASTCUT = 20;    // item index of the most recent cut (the detection marker)
export const AD_FLAT_LEN = 21;

/** The regime mean for a buffer index: alternates AD_MEAN_LO / AD_MEAN_HI every AD_REGIME items. */
function adRegimeMean(bufIdx) {
    return ((((bufIdx / AD_REGIME) | 0) & 1) ? AD_MEAN_HI : AD_MEAN_LO);
}

/** The `bigJumpThenPlus1` preset's concept mean for a buffer index: 0, then J, then J+1. */
function adPresetMean(bufIdx) {
    if (bufIdx < AD_JUMP_AT) return 0;
    if (bufIdx < AD_PLUS1_AT) return AD_JUMP;
    return AD_JUMP + 1;
}

/** The current concept mean for a world at a buffer index (offset included) -- default drift or preset. */
function adConceptMean(world, bufIdx) {
    return (world.preset === 'bigJumpThenPlus1' ? adPresetMean(bufIdx) : adRegimeMean(bufIdx)) + world.offset;
}

/** Fill the reused value stream (warmup / topology only). Default: drift regime + tight noise. Preset
 *  `bigJumpThenPlus1`: 0 -> J -> J+1 with small jitter. Every value carries world.offset (F9: an additive
 *  offset shifts the mean, NOT the variance -> ADWIN behavior is offset-invariant). */
function fillAdStream(world) {
    const stream = world.stream, len = stream.length, off = world.offset;
    const rng = makeRng(world.seed);
    const preset = world.preset === 'bigJumpThenPlus1';
    for (let i = 0; i < len; i++) {
        if (preset) {
            stream[i] = adPresetMean(i) + (rng() - 0.5) * AD_PRESET_JITTER + off;
        } else {
            stream[i] = adRegimeMean(i) + (rng() - 0.5) * 0.1 + off;   // fractional -> zero-box addFrom
        }
    }
}

/**
 * Build the Scene-02 world ONCE. The REAL ADWIN, the reused value stream (a drifting Bernoulli-like
 * signal), and the flat buffer. Fails closed on a bad delta via the ADWIN ctor guard.
 * @param {number} delta  confidence knob in (0, 1).
 * @param {number} [seed] uint32 value seed.
 */
export function createAdWorld(delta, seed, offset, preset) {
    // Fail closed (suite law): reject a non-number / non-finite seed BEFORE allocation -- never coerce
    // NaN / a string to 0 via >>> 0. -0 and any finite value (incl. >= 2^31, which >>> 0 folds) pass.
    if (seed !== undefined && seed !== null && (typeof seed !== 'number' || !Number.isFinite(seed))) {
        throw new TypeError('[lite-adaptive] ADWIN seed must be a finite number, got ' +
            (typeof seed === 'string' ? JSON.stringify(seed) : String(seed)));
    }
    const s = (seed === undefined || seed === null) ? AD_DEFAULT_SEED : (seed >>> 0);
    // null is not zero: fall back on undefined/null only, so an explicit offset 0 is honored.
    // Fail closed on the two D2 knobs (throw BEFORE any state write): offset a finite number, preset the
    // one known tag. An unknown preset / a non-finite offset is an error with a did-you-mean hint.
    if (offset !== undefined && offset !== null && !Number.isFinite(offset)) {
        throw new TypeError('[lite-adaptive] ADWIN offset must be a finite number, got ' + String(offset));
    }
    if (preset !== undefined && preset !== null && preset !== 'bigJumpThenPlus1') {
        throw new TypeError('[lite-adaptive] ADWIN preset must be null or "bigJumpThenPlus1", got ' + JSON.stringify(preset));
    }
    const off = (offset === undefined || offset === null) ? 0 : offset;
    const pre = (preset === undefined || preset === null) ? null : preset;
    const ad = new ADWIN(delta);   // throws [lite-adaptive] on a bad delta
    const world = {
        ad, delta, seed: s, offset: off, preset: pre,
        stream: new Float64Array(AD_STREAM_LEN),
        streamMask: AD_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, sink: 0,
        valuesPerFrame: AD_VALUES_PER_FRAME,
        n: 0, cuts: 0, driftThisFrame: 0, curMu: 0,    // curMu seeded below from the concept at index 0
        stepN: 0, lastCut: 0,                          // item counter + the last cut's item index
        cumSum: 0, cumN: 0,                            // the naive cumulative-mean foil
        ghostMin: Infinity, ghostMax: -Infinity,       // the GHOST 1.6.0 running-GLOBAL range (never shrinks)
        flat: new Float64Array(AD_FLAT_LEN),
    };
    // Seed curMu from the concept mean at index 0 (a Double, offset included) so A_TRUEMEAN reads right
    // before the first step -- not the bare offset (which was wrong for the default drift regime).
    world.curMu = adConceptMean(world, 0);
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
    let pos = world.cursor, stepN = world.stepN, lastCut = world.lastCut;
    world.frameStart = pos & mask;
    let sink = 0, drift = 0;
    for (let i = 0; i < vpf; i++) {
        const idx = pos & mask;
        const cut = ad.addFrom(stream, idx);   // reads stream[idx] UNBOXED -- zero-box even at 1.7e12
        stepN = (stepN + 1) | 0;
        if (cut) { drift = 1; world.cuts = (world.cuts + 1) | 0; lastCut = stepN; }
        sink = (sink + (cut ? 1 : 0) + ad.bucketCount) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.stepN = stepN; world.lastCut = lastCut;
    world.curMu = adConceptMean(world, (pos - 1) & mask);   // the concept the last consumed value belongs to
    world.driftThisFrame = drift;
    world.frameCount = vpf;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One ALWAYS-RUN ghost-range frame: fold this frame's values into the GHOST 1.6.0 running-GLOBAL range
 * (min/max over ALL values ever fed -- never shrinks). It is the D2 deafness demonstration, NOT the
 * naive-mean foil, so it must stay LIVE even when the foil (stepAdOracle) is paused -- otherwise A_GHOSTR
 * freezes stale. stepAdGhost is the SOLE owner of ghostMin / ghostMax (stepAdOracle no longer touches
 * them -- it is purely the naive-mean foil now), and the golden driver runs stepAd + stepAdGhost. 0 B/op.
 * @param {object} world
 * @returns {number} the frame's value count (folded, defeats DCE).
 */
export function stepAdGhost(world) {
    const stream = world.stream, mask = world.streamMask;
    const start = world.frameStart, count = world.frameCount;
    let gmin = world.ghostMin, gmax = world.ghostMax;
    for (let i = 0; i < count; i++) {
        const v = stream[(start + i) & mask];
        if (v < gmin) gmin = v;
        if (v > gmax) gmax = v;
    }
    world.ghostMin = gmin; world.ghostMax = gmax;
    return count;
}

/**
 * One EXACT-ORACLE frame (the allowed-to-allocate-in-spirit contrast): replay the frame's values
 * into a naive cumulative mean (never forgets -> the foil that lags after a shift) and bump the
 * owned counter once per value (exact drift detection must retain O(N) values). Does NOT touch the
 * ghost global range (stepAdGhost owns that, always-run) nor any live-window ring (renderAdPrep
 * recomputes A_LIVER straight from the stream suffix): it is purely the naive-mean foil now. Returns
 * an int32 fold, never a boxed double (zero-box law: never RETURN a double from a non-inlined helper).
 * 0 B/op (scalars).
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the frame's value count (int32 fold, defeats DCE).
 */
export function stepAdOracle(world, allocState) {
    const stream = world.stream, mask = world.streamMask;
    const start = world.frameStart, count = world.frameCount;
    let cumSum = world.cumSum, cumN = world.cumN;
    for (let i = 0; i < count; i++) {
        const v = stream[(start + i) & mask];
        cumSum += v;
        cumN += 1;
        allocState.oracleCount++;   // a retained value exact drift-tracking would keep
    }
    world.cumSum = cumSum; world.cumN = cumN;
    world.n = (world.n + count) | 0;
    return count | 0;
}

/**
 * Render-prep (~10Hz): re-derive every displayed ADWIN number LIVE from the shipped instance vs the
 * current regime mean + the cumulative foil. ad.mean / variance / width are O(1) 0-alloc getters, and
 * every value stays in a Float64Array slot end to end -- this returns an int32 fold, never a boxed
 * double. Measured 0 B/op in the optimized steady state (DemoProbe ad_render_* lanes, gated <= 0.5): V8
 * elides the getter returns because they never escape. The ad.mean / ad.variance returns DO box 16 B,
 * but only when they escape into a retaining slot -- proven by the ad_mean_sink / ad_variance_sink
 * controls, which sink the return and MUST fail the 0 gate. HEAD's `return mean` boxed 48 B/call: it
 * sank a fractional double across the render boundary. The per-frame step path (stepAd + stepAdGhost +
 * stepAdOracle) stays 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} an int32 fold of the item count (defeats DCE; never a boxed double).
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
    // --- 1.8.0 (D2) APPEND-ONLY: offset, the live-window range R vs the 1.6.0 ghost global range ---
    flat[A_OFFSET] = world.offset;
    // A_LIVER: exact value range (max-min) of the RETAINED window -- the last ad.width fed values read
    // straight from the stream suffix stream[(cursor-width .. cursor-1) & mask], i.e. EXACTLY ADWIN's
    // window INCLUDING the straddling oldest bucket (the library's internal F18 R excludes that oldest
    // bucket). Fails closed to NaN when the width exceeds the stream ring -- an exact range over values
    // we no longer hold cannot be recomputed (null is not zero).
    const width = ad.width | 0;
    if (width > AD_STREAM_LEN) {
        flat[A_LIVER] = NaN;
    } else {
        const stream = world.stream, mask = world.streamMask, cur = world.cursor;
        let mn = Infinity, mx = -Infinity;
        for (let i = 1; i <= width; i++) { const v = stream[(cur - i) & mask]; if (v < mn) mn = v; if (v > mx) mx = v; }
        flat[A_LIVER] = width > 0 ? (mx - mn) : 0;
    }
    // A_GHOSTR: the 1.6.0 running-GLOBAL range (never shrinks) -- why 1.6.0 went deaf to a later +1.
    flat[A_GHOSTR] = (world.ghostMax >= world.ghostMin) ? (world.ghostMax - world.ghostMin) : 0;
    flat[A_LASTCUT] = world.lastCut;
    return world.n | 0;   // int32 fold (defeats DCE); mean lives in flat[A_MEAN], never RETURNED (would box)
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
 * @returns {number} an int32 fold of the add count (defeats DCE; never a boxed double).
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
    return world.n | 0;   // int32 fold (defeats DCE); count lives in flat[D_COUNT], never RETURNED (boxed 16 B/call)
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
/** D3 key-magnitude classes (F3): the transform applied to each drawn Zipf index AT FILL TIME (cold),
 *  so `addFrom` streams keys of that class through a Float64 slot -- a large / negative key NEVER boxes.
 *  small = k; big = k + 2^31 (a HeapNumber as a plain `add` arg); neg = -(k + 1). */
export const HK_KEY_SMALL = 0;
export const HK_KEY_BIG = 1;
export const HK_KEY_NEG = 2;
export const HK_BIG_OFFSET = 2147483648;   // 2^31 -- the >= 2^31 key-class offset (still a safe integer)
/** D3 weight ceiling (F10): a single weight up to 2^32-1; the accumulated uint32 cell SATURATES here. */
export const HK_WEIGHT_MAX = 4294967295;   // 2^32-1

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
// --- 1.8.0 (D3) APPEND-ONLY slots (never renumber 0..20; golden-flat.json pins those bits) ---
export const H_KEYMODE = 21;      // the key-magnitude class fed through addFrom (0 small, 1 >= 2^31, 2 neg)
export const H_WEIGHT = 22;       // the per-add weight (up to 2^32-1; rides a Float64 slot, never boxed)
export const H_SAT = 23;          // 1 when the top estimate saturates the uint32 cell (== 4294967295)
export const HK_FLAT_LEN = 24;

/** Fill the reused stream with a STATIONARY Zipfian skew (cached CDF), each drawn index TRANSFORMED to
 *  the world's key-magnitude class (D3). Warmup / topology only -- the transform is cold, never per frame,
 *  so the hot `addFrom` path only ever reads a ready transformed key from a Float64 slot (zero-box, F3). */
function fillZipfStream(world) {
    const stream = world.stream, raw = world.rawStream, len = stream.length, nKeys = world.nKeys, skew = world.skew;
    const km = world.keyMode;
    const rng = makeRng(world.seed);
    const cdf = new Float64Array(nKeys);
    let sum = 0;
    for (let i = 0; i < nKeys; i++) { sum += 1 / Math.pow(i + 1, skew); cdf[i] = sum; }
    for (let i = 0; i < nKeys; i++) cdf[i] /= sum;
    for (let n = 0; n < len; n++) {
        const u = rng();
        let lo = 0, hi = nKeys - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
        // The UNTRANSFORMED Zipf index (always a Smi, 0..nKeys-1) is the oracle Map / Space-Saving key --
        // a large / negative TRANSFORMED key would box once per Map.get on the render path (D3 blocker 1).
        raw[n] = lo;
        // small = k; big = k + 2^31 (>= 2^31, a HeapNumber as a plain arg); neg = -(k + 1). All safe integers.
        stream[n] = km === HK_KEY_BIG ? lo + HK_BIG_OFFSET : (km === HK_KEY_NEG ? -(lo + 1) : lo);
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

/** Build the per-world recall callback ONCE (never per frame) -- 0-alloc when Map.forEach calls it.
 *  D3: membership is read from a topBuf scan (the top-k leaders, [key, estimate] pairs) -- NEVER scalar
 *  hk.estimate(key) on the render path, which boxes a key >= 2^31 / negative at the non-inlined call
 *  boundary. The topBuf keys ride Float64 slots (0 B/op), so the render stays allocation-free. */
function makeHkRecallCb(world) {
    // `key` is the oracle Map key -- the UNTRANSFORMED Zipf INDEX (a Smi), never the large / negative
    // transformed key. Membership is scanned against world.topIdx, the leaders' indices recovered by the
    // inverse transform once per render (D3 blocker 1) -- so every comparison here is Smi === Smi, 0-box.
    return function recallCb(count, key) {
        const thr = world.n / world.k;
        if (count > thr) {
            world.recallTrue++;
            const topIdx = world.topIdx, rows = world.topRows;
            for (let r = 0; r < rows; r++) { if (topIdx[r] === key) { world.recallFound++; break; } }
        }
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
 * @param {number} [keyMode] D3 key-magnitude class (HK_KEY_SMALL / HK_KEY_BIG / HK_KEY_NEG). Default small.
 * @param {number} [weight]  D3 per-add weight, a positive integer up to 2^32-1. Default 1.
 */
export function createHkWorld(d, w, k, seed, keyMode, weight) {
    // Fail closed (suite law): reject a non-number / non-finite seed BEFORE allocation -- never coerce
    // NaN / a string to 0 via >>> 0. -0 and any finite value (incl. >= 2^31, which >>> 0 folds) pass.
    if (seed !== undefined && seed !== null && (typeof seed !== 'number' || !Number.isFinite(seed))) {
        throw new TypeError('[lite-adaptive] HK seed must be a finite number, got ' +
            (typeof seed === 'string' ? JSON.stringify(seed) : String(seed)));
    }
    const s = (seed === undefined || seed === null) ? HK_DEFAULT_SEED : (seed >>> 0);
    // null is not zero: fall back on undefined/null only, so an explicit keyMode 0 / weight is honored.
    const km = (keyMode === undefined || keyMode === null) ? HK_KEY_SMALL : keyMode;
    const wt = (weight === undefined || weight === null) ? 1 : weight;
    // D3 blocker 4: fail closed BEFORE any allocation (a bad keyMode / weight must never build a world
    // that then bombs inside rAF). keyMode is one of {0, 1, 2}; weight is an integer in [1, 2^32-1].
    if (km !== HK_KEY_SMALL && km !== HK_KEY_BIG && km !== HK_KEY_NEG) {
        let hint = '';
        if (km === 'small') hint = ' (did you mean 0?)';
        else if (km === 'big') hint = ' (did you mean 1?)';
        else if (km === 'neg' || km === 'negative') hint = ' (did you mean 2?)';
        throw new TypeError('[lite-adaptive] HK keyMode must be 0 (small), 1 (>= 2^31), or 2 (negative), got ' +
            (typeof keyMode === 'string' ? JSON.stringify(keyMode) : String(keyMode)) + hint);
    }
    // Cold create-time TYPE guard (demo-authored): fail closed BEFORE any allocation on a non-number /
    // non-integer / < 1 weight, so a world never builds on rubbish and never bombs inside rAF.
    if (typeof wt !== 'number' || !Number.isInteger(wt) || wt < 1) {
        throw new RangeError('[lite-adaptive] HK weight must be an integer >= 1, got ' +
            (typeof weight === 'string' ? JSON.stringify(weight) : String(weight)));
    }
    // Upper bound (F10) is DELEGATED to the library so the banner shows the library's OWN tagged message,
    // not a demo paraphrase: a tiny throwaway HeavyKeeper.add(0, wt) fires the library's weight guard
    // ([1, 4294967295]) at CREATE time (never inside rAF). For a valid weight this is a silent no-op, so
    // the world + the golden are unaffected. (D3 blocker 4: the check still precedes the real build.)
    new HeavyKeeper(1, 1, 1).add(0, wt);
    const hk = new HeavyKeeper(d, w, k, { seed: s });   // throws [lite-adaptive] on a bad d/w/k
    const world = {
        hk, d, w, k, seed: s, nKeys: HK_NKEYS, skew: HK_SKEW, keyMode: km, weight: wt, oracleOn: true,
        oracle: new Map(),
        ss: makeSpaceSaving(k * HK_SS_MULT),
        stream: new Float64Array(HK_STREAM_LEN),        // transformed keys (may be >= 2^31 or negative)
        rawStream: new Uint32Array(HK_STREAM_LEN),      // UNTRANSFORMED Zipf index (Smi) -- the oracle key
        streamMask: HK_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, sink: 0,
        keysPerFrame: HK_KEYS_PER_FRAME,
        keyBuf: new Float64Array(2),                    // [key, weight] scratch for addFrom (reused)
        topBuf: new Float64Array(2 * k),                // topKInto target ([key, estimate] pairs)
        topIdx: new Float64Array(k),                    // leaders' UNTRANSFORMED indices (Smi Map lookups)
        lbTrue: new Float64Array(k),                    // per-leader true count (for the bracket)
        n: 0, recallTrue: 0, recallFound: 0, topRows: 0,
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
    const buf = world.keyBuf, weight = world.weight;   // weight into a Float64 slot -> never boxed (F3/F10)
    let pos = world.cursor;
    world.frameStart = pos & mask;
    let sink = 0;
    for (let i = 0; i < kpf; i++) {
        buf[0] = stream[pos & mask]; buf[1] = weight;   // key + weight ride Float64 slots (zero-box addFrom)
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
    const raw = world.rawStream, mask = world.streamMask, map = world.oracle, ss = world.ss;
    const start = world.frameStart, count = world.frameCount, weight = world.weight;
    for (let i = 0; i < count; i++) {
        const key = raw[(start + i) & mask];   // UNTRANSFORMED Zipf index (a Smi) -- never boxes on Map.get
        const c = map.get(key);
        if (c === undefined) { map.set(key, weight); allocState.oracleCount++; }   // a new entry allocates
        else map.set(key, c + weight);
        ssAdd(ss, key, weight);
    }
    // n is the TOTAL MASS (sum of weights), so the N/k threshold + the Map counts share one unit; a
    // Float accumulator (no `| 0`) keeps it exact past 2^31 when a large weight is engaged.
    world.n = world.n + count * weight;
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
    const k = world.k, w = world.w, N = world.n, km = world.keyMode;
    const topBuf = world.topBuf, topIdx = world.topIdx, lbTrue = world.lbTrue;
    const rows = hk.topKInto(topBuf);   // [key, estimate] pairs, heap order; returns entry count
    world.topRows = rows;               // published for recallCb's membership scan (no scalar estimate)

    // per-leader bracket + never-overestimate + marquee (HeavyKeeper vs Space-Saving) -- all 0-alloc.
    const errBound = w > 0 ? N / w : 0;
    let bracketOk = 1, maxOver = 0, maxCount = 0;
    let hkErrSum = 0, ssErrSum = 0, errN = 0;
    for (let r = 0; r < rows; r++) {
        const key = topBuf[r * 2];
        const est = topBuf[r * 2 + 1];
        // Recover the UNTRANSFORMED index (a Smi) from the transformed leader key BEFORE any Map lookup:
        // a large / negative double would box once per Map.get here (D3 blocker 1). The subtraction /
        // negation is an inlined float op; the result is a small integer the Map canonicalizes to a Smi.
        const idx = km === HK_KEY_BIG ? key - HK_BIG_OFFSET : (km === HK_KEY_NEG ? -key - 1 : key);
        topIdx[r] = idx;   // published for recallCb's Smi membership scan
        const tc = map.get(idx);
        const t = tc === undefined ? 0 : tc;
        lbTrue[r] = t;
        if (est > t) { const over = est - t; if (over > maxOver) maxOver = over; bracketOk = 0; }
        if (t - est > errBound + 1e-9) bracketOk = 0;
        if (est > maxCount) maxCount = est;
        if (t > 0) {
            hkErrSum += Math.abs(est - t) / t;
            ssErrSum += Math.abs(ssEstimate(ss, idx) - t) / t;
            errN++;
        }
    }
    const hkErr = errN > 0 ? hkErrSum / errN : 0;
    const ssErr = errN > 0 ? ssErrSum / errN : 0;

    // recall of the true heavy hitters above N/k (the headline) -- Map.forEach, hoisted cb, 0-alloc.
    world.recallTrue = 0; world.recallFound = 0;
    map.forEach(world.recallCb);
    // null is not zero: with NO true heavy hitters yet (recallTrue 0), recall is UNDEFINED, not a
    // perfect 1 -- write NaN so hkTick / hkWitDraw render "n/a" (neutral), never a false 100%. At the
    // golden's 300 frames there ARE heavy hitters (recallTrue > 0), so this branch never fires there.
    const recall = world.recallTrue === 0 ? NaN : world.recallFound / world.recallTrue;

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
    // --- 1.8.0 (D3) APPEND-ONLY: the key-magnitude class, the per-add weight, the saturation flag ---
    flat[H_KEYMODE] = world.keyMode;
    flat[H_WEIGHT] = world.weight;
    flat[H_SAT] = maxCount === HK_WEIGHT_MAX ? 1 : 0;   // top estimate pinned at the uint32 ceiling (F10)
    // Oracle gate (blocker 2, COLD branch): with the oracle toggle OFF the exact Map + Space-Saving foil
    // are FROZEN while the sketch keeps counting, so every oracle-derived number (recall, the [true-N/w]
    // bracket, max-overestimate, the HK-vs-SS marquee) plus the per-leader true counts, the N/k threshold
    // and the ~N/w error bound would read STALE against a frozen Map and n. Fail closed to NaN -> rendered
    // "n/a", markers skipped in hkDraw, never a false "recall 100%". At the default (oracleOn true) the
    // branch never fires, so the golden stays bit-identical. This write lives in the kernel a test drives.
    if (!world.oracleOn) {
        flat[H_RECALL] = NaN; flat[H_FOUND] = NaN; flat[H_TRUEHH] = NaN; flat[H_MAXOVER] = NaN; flat[H_BRACKETOK] = NaN;
        flat[H_HKERR] = NaN; flat[H_SSERR] = NaN; flat[H_MARQUEEOK] = NaN;
        flat[H_THRESH] = NaN; flat[H_ERRBOUND] = NaN;
        for (let r = 0; r < rows; r++) lbTrue[r] = NaN;   // per-leader true-count markers -> hkDraw skips them
    }
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
/** D4 query-cadence cap (in 10Hz TICKS): queryEvery is Infinity ("never") or an integer in [1, cap].
 *  Anything else (0, fractional, NaN, a string, 1e300) fails closed -- never a silent "never" default. */
export const SHLL_QEVERY_MAX = 1 << 16;   // 65536 ticks -- covers the {1, 8, 64} select with head-room

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
// --- 1.8.0 (D4) APPEND-ONLY slots (never renumber 0..14; golden-flat.json pins those bits) ---
export const S_OVF_A = 15;        // twin A overflows (the count()-queried instance)
export const S_OVF_B = 16;        // twin B overflows (the never-queried instance) -- ALWAYS == S_OVF_A (F8)
export const S_QEVERY = 17;       // query cadence in 10Hz ticks (Infinity = never queried)
export const SHLL_FLAT_LEN = 18;

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
 * @param {number} [queryEvery] D4 query cadence in 10Hz TICKS -- slA is count()-queried (folded into
 *                              sink2) every `queryEvery` ticks (Infinity = never queried at all). The
 *                              DISPLAY estimate comes from the separate slD twin (queried every tick);
 *                              the twin slB is NEVER queried. F8 makes all three `overflows` EQUAL.
 */
export function createShllWorld(W, p, ringCap, seed, queryEvery) {
    // Fail closed (suite law): reject a non-number / non-finite seed BEFORE allocation -- never coerce
    // NaN / a string to 0 via >>> 0. -0 and any finite value (incl. >= 2^31, which >>> 0 folds) pass.
    if (seed !== undefined && seed !== null && (typeof seed !== 'number' || !Number.isFinite(seed))) {
        throw new TypeError('[lite-adaptive] SHLL seed must be a finite number, got ' +
            (typeof seed === 'string' ? JSON.stringify(seed) : String(seed)));
    }
    const s = (seed === undefined || seed === null) ? SHLL_DEFAULT_SEED : (seed >>> 0);
    const qe = (queryEvery === undefined || queryEvery === null) ? Infinity : queryEvery;
    // D4 blocker 5: fail closed BEFORE any allocation. queryEvery counts 10Hz TICKS -- Infinity ("never")
    // or an integer in [1, SHLL_QEVERY_MAX]. 0 / -3 / 2.5 / NaN / '8' / -Infinity / 1e300 are all errors
    // (never a silent "never" with a bogus stored cadence). Number.isInteger(Infinity) is false, so the
    // Infinity sentinel is matched first.
    if (qe !== Infinity && (typeof qe !== 'number' || !Number.isInteger(qe) || qe < 1 || qe > SHLL_QEVERY_MAX)) {
        throw new RangeError('[lite-adaptive] SHLL queryEvery must be Infinity or an integer in [1, ' +
            SHLL_QEVERY_MAX + '] ticks, got ' + (typeof queryEvery === 'string' ? JSON.stringify(queryEvery) : String(queryEvery)));
    }
    const sl = new SlidingHyperLogLog(W, { p, ringCap, seed: s });   // slA: cadence-queried (count() on cadence)
    const slB = new SlidingHyperLogLog(W, { p, ringCap, seed: s });  // the twin: same stream, NEVER queried
    const slD = new SlidingHyperLogLog(W, { p, ringCap, seed: s });  // display-only twin: count() EVERY 10Hz tick
    const world = {
        sl, slB, slD, W, p, ringCap, seed: s, paused: false, oracleOn: true,
        queryEvery: qe, queryOn: qe !== Infinity, qcountdown: qe !== Infinity ? qe : 0, sink2: 0, slaQueryCount: 0,
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
        world.slB.advanceFrom(world.packed, 0);   // the twin idle-slides in lockstep
        world.slD.advanceFrom(world.packed, 0);   // the display twin idle-slides too
        world.now = now; world.frameNowStart = now; world.frameCount = 0;
        return 0;
    }
    const stream = world.stream, mask = world.streamMask, sl = world.sl, slB = world.slB, slD = world.slD, kpf = world.keysPerFrame;
    const packed = world.packed;
    let pos = world.cursor, now = world.now;
    world.frameStart = pos & mask;
    world.frameNowStart = now;
    let sink = 0;
    for (let i = 0; i < kpf; i++) {
        now = now + 1;
        packed[0] = now; packed[1] = stream[pos & mask];
        sl.addFrom(packed, 0);
        slB.addFrom(packed, 0);   // the IDENTICAL add into the twin (expiry lives in add, not count -- F8)
        slD.addFrom(packed, 0);   // the IDENTICAL add into the display twin (count()-queried every 10Hz tick)
        sink = (sink + (now | 0)) | 0;
        pos = pos + 1;
    }
    // D4 blocker 2: the cadence query lives on the 10Hz TICK (renderShllPrep), NOT here. sl.count() boxes
    // its 16 B double return once per call (the documented one-boxed-return, not a library bug), which the
    // measureAllocs lane cannot see -- so the per-frame path stays honestly 0 B/op by never calling it.
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

// 1.11.0 render slot for SlidingHyperLogLog.countInto(out) (module scope, reused every tick).
const SHLL_ROW = new Float64Array(1);

/**
 * Render-prep (~10Hz): re-derive every displayed SlidingHyperLogLog number LIVE from the shipped
 * instances vs the exact windowed-distinct Map. The DISPLAY estimate is slD.countInto(SHLL_ROW) (the
 * display-only twin, queried EVERY tick through the 1.11.0 render reader; O(m), 0 B/call). slA is
 * count()-queried ONLY when the cadence countdown fires (0 queries when queryEvery is Infinity /
 * "never"), so the query-rate control has teeth. map.size is O(1). No per-frame count().
 *
 * MEASURED COST: 0 B per tick (DemoProbe shll_render, gated <= 0.5 in 10 fresh children). From 1.8.0 to
 * 1.10.0 the scalar count() cost 16-32 B per tick depending on the V8 tier (an estimator-tail box plus
 * the returned double); 1.11.0 moved the estimator tail into module scratch slots (ROADMAP 12).
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the windowed distinct estimate (folded).
 */
export function renderShllPrep(world, allocState) {
    const sl = world.sl, flat = world.flat, map = world.oMap;
    world.slD.countInto(SHLL_ROW);   // the display twin through the 1.11.0 render reader (0 B/call)
    const est = SHLL_ROW[0];
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
    // --- 1.8.0 (D4) APPEND-ONLY: both twins' overflows (ALWAYS EQUAL, F8) + the query cadence ---
    flat[S_OVF_A] = sl.overflows;
    flat[S_OVF_B] = world.slB.overflows;
    flat[S_QEVERY] = world.queryEvery;
    // D4 blocker 1/2: the query cadence counts 10Hz TICKS. slA (world.sl) is count()-queried ONLY when the
    // countdown fires -- so "never" (queryOn false) queries slA ZERO times; the DISPLAY estimate came from
    // slD above, independent of the cadence. Each firing folds slA's estimate into sink2 and bumps the
    // slaQueryCount (the control's teeth: it changes how OFTEN slA.count() actually runs). slB is NEVER
    // queried -- yet all three overflows stay EQUAL (F8: count() is non-destructive). Integer countdown.
    if (world.queryOn) {
        const qc = world.qcountdown - 1;
        if (qc <= 0) {
            world.qcountdown = world.queryEvery;
            world.sink2 = (world.sink2 + (sl.count() | 0)) | 0;   // the ONLY slA query -- on cadence
            world.slaQueryCount = (world.slaQueryCount + 1) | 0;
        } else world.qcountdown = qc;
    }
    // Oracle gate (blocker 2, COLD branch): with the exact windowed-distinct Map frozen (oracle toggle off)
    // the oracle-derived true distinct / rel-error / accuracy cursor are meaningless -> fail closed to NaN
    // (rendered "n/a", gauge skipped) rather than a frozen stale number shown as live. At the default
    // (oracleOn true) the branch never fires, so the golden stays bit-identical.
    if (!world.oracleOn) { flat[S_TRUE] = NaN; flat[S_RELERR] = NaN; flat[S_FRAC] = NaN; }
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
// --- 1.8.0 (D5) APPEND-ONLY: the LATCHED twins of PH and CUSUM (S9). Same signal, latch:true, so each
// fires ONCE per regime + re-arms only when its statistic falls back below threshold/2 (the library's
// hysteresis; the demo only READS the shipped latch / lastDriftIndex / lastDirection getters). ---
export const G_PHL_STAT = 19;     // phL.statistic (latched PH)
export const G_PHL_FRAC = 20;     // phL.statistic / threshold (latched fire cursor)
export const G_CUL_STAT = 21;     // cuL.statistic (latched CUSUM)
export const G_CUL_FRAC = 22;     // cuL.statistic / threshold
export const G_PHL_FIRES = 23;    // latched PH total fires (ONE per regime, vs the unlatched storm)
export const G_CUL_FIRES = 24;    // latched CUSUM total fires
export const G_PHL_FIRED = 25;    // latched PH fired this frame (one marker per regime)
export const G_CUL_FIRED = 26;    // latched CUSUM fired this frame
export const G_PHL_LASTIDX = 27;  // phL.lastDriftIndex (item index of the last fire; NaN before any)
export const G_PHL_LASTDIR = 28;  // phL.lastDirection (+1 / -1; NaN before any fire)
export const G_CUL_LASTIDX = 29;  // cuL.lastDriftIndex
export const G_CUL_LASTDIR = 30;  // cuL.lastDirection
export const G_PHL_LATCHED = 31;  // phL.latched (1 while latched and not yet re-armed)
export const G_CUL_LATCHED = 32;  // cuL.latched
export const G_LATCH_ON = 33;     // the latch DISPLAY toggle state (1/0) -- draws the latched channels
export const DD_FLAT_LEN = 34;

/** Fixed scalar footprint of the two detectors (both share the tiny O(1)-state class). */
export const DD_SKETCH_BYTES = 128;

// 1.11.0 render row: dd.into(out) writes [statistic, mean, count, lastDriftIndex, lastDirection] into a
// caller Float64Array in ONE call (0 B/call). One module-scope row, reused for all four detectors in turn.
const DD_ROW = new Float64Array(5);

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
 * @param {boolean} [latch]   D5 latch DISPLAY toggle (default false, so a 2-arg call stays golden-
 *                            identical). typeof-first: a non-boolean throws BEFORE any allocation.
 */
export function createDdWorld(delta, threshold, latch) {
    // null is not zero: fall back to false only on undefined/null, so an explicit `false` is honored.
    const lt = (latch === undefined || latch === null) ? false : latch;
    // D5 blocker (fail-closed option): validate the toggle state BEFORE constructing any detector -- a
    // non-boolean latch must never build a world that then draws a bogus channel (no truthy coercion).
    if (typeof lt !== 'boolean') {
        throw new TypeError('[lite-adaptive] DD latch must be a boolean (true / false), got ' +
            (typeof latch === 'string' ? JSON.stringify(latch) : String(latch)));
    }
    const ph = new DriftDetector(DRIFT_PH, { delta, threshold });                 // throws on bad args
    const cu = new DriftDetector(DRIFT_CUSUM, { delta, threshold, target: DD_TARGET });
    // The LATCHED twins (S9): same delta / threshold / target, latch: true -- fire ONCE per regime and
    // re-arm only when the statistic falls back below threshold/2 (the shipped hysteresis). Fed the SAME
    // signal as the unlatched pair; the demo reads their latch / lastDriftIndex / lastDirection getters.
    const phL = new DriftDetector(DRIFT_PH, { delta, threshold, latch: true });
    const cuL = new DriftDetector(DRIFT_CUSUM, { delta, threshold, target: DD_TARGET, latch: true });
    const world = {
        ph, cu, phL, cuL, delta, threshold, latchOn: lt,
        stream: new Float64Array(DD_STREAM_LEN),
        streamMask: DD_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, sink: 0,
        valuesPerFrame: DD_VALUES_PER_FRAME,
        n: 0, phFires: 0, cuFires: 0, phFired: 0, cuFired: 0, cp: 0, curMu: DD_MEAN_LO,
        phLFires: 0, cuLFires: 0, phLFired: 0, cuLFired: 0,
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
    const phL = world.phL, cuL = world.cuL;
    const vpf = world.valuesPerFrame;
    let pos = world.cursor;
    world.frameStart = pos & mask;
    let sink = 0, phF = 0, cuF = 0, phLF = 0, cuLF = 0, cp = 0, prevReg = ((world.n / DD_REGIME) | 0);
    for (let i = 0; i < vpf; i++) {
        const idx = pos & mask;
        const reg = (((world.n + i) / DD_REGIME) | 0);
        if (reg !== prevReg) { cp = 1; prevReg = reg; }
        const pf = ph.addFrom(stream, idx);
        const cf = cu.addFrom(stream, idx);
        // the LATCHED twins ride the IDENTICAL signal (S9): each fires ONCE per regime + re-arms at
        // threshold/2 in the library, so the unlatched re-firing storm above dwarfs these counts.
        const pLf = phL.addFrom(stream, idx);
        const cLf = cuL.addFrom(stream, idx);
        if (pf) { phF = 1; world.phFires = (world.phFires + 1) | 0; }
        if (cf) { cuF = 1; world.cuFires = (world.cuFires + 1) | 0; }
        if (pLf) { phLF = 1; world.phLFires = (world.phLFires + 1) | 0; }
        if (cLf) { cuLF = 1; world.cuLFires = (world.cuLFires + 1) | 0; }
        sink = (sink + (pf ? 1 : 0) + (cf ? 1 : 0) + (pLf ? 1 : 0) + (cLf ? 1 : 0)) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.n = (world.n + vpf) | 0;
    world.curMu = ddRegimeMean((pos - 1) & mask);
    world.phFired = phF; world.cuFired = cuF;
    world.phLFired = phLF; world.cuLFired = cuLF;
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
 * Render-prep (~10Hz): re-derive every displayed DriftDetector number LIVE from ALL FOUR shipped
 * detectors (the unlatched PH/CUSUM plus the D5 latched twins). Each detector is read through
 * dd.into(DD_ROW) (1.11.0; [statistic, mean, count, lastDriftIndex, lastDirection] in one call) and the
 * function returns an int32 fold: 0 B/tick (DemoProbe dd_render, gated <= 0.5). The six scalar statistic /
 * mean getters this replaced boxed ~48 B/tick (V8's cumulative inlining budget) -- the dd_getter_box
 * MUST-BOX control keeps that shape and measures 48, so the 0 has teeth.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} an int32 fold of the fire counts (defeats DCE; never a boxed double).
 */
export function renderDdPrep(world, allocState) {
    const ph = world.ph, cu = world.cu, flat = world.flat, row = DD_ROW;
    const pt = ph.threshold, ct = cu.threshold;
    // Every detector is read through dd.into(row) (1.11.0): the whole row in one call, 0 B/tick. The six
    // scalar statistic / mean getters this replaced boxed ~48 B/tick (V8's cumulative inlining budget).
    ph.into(row);
    const ps = row[0], pm = row[1];
    cu.into(row);
    const cs = row[0], cm = row[1];
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
    flat[G_PH_MEAN] = pm;
    flat[G_CU_MEAN] = cm;
    flat[G_N] = world.n;
    flat[G_CP] = world.cp;
    flat[G_SKETCH_BYTES] = DD_SKETCH_BYTES;
    flat[G_ORACLE_BYTES] = world.n * BYTES_PER_F64;
    flat[G_SKETCH_ALLOC] = allocState.sketchCount;
    flat[G_ORACLE_ALLOC] = allocState.oracleCount;
    // --- 1.8.0 (D5) APPEND-ONLY: the LATCHED twins (S9), also read through into(row).
    // lastDriftIndex / lastDirection (row[3] / row[4]) are NaN before any fire (null is not zero -- the UI
    // tick renders "n/a", never String(NaN) -> "NaN"). 0 B/op steady (DemoProbe dd_render lane, gated;
    // the dd_getter_box control proves the probe still sees the old getter boxes).
    const phL = world.phL, cuL = world.cuL;
    phL.into(row);
    const pls = row[0], plIdx = row[3], plDir = row[4];
    cuL.into(row);
    const cls = row[0], clIdx = row[3], clDir = row[4];
    flat[G_PHL_STAT] = pls;
    flat[G_PHL_FRAC] = pt > 0 ? pls / pt : 0;
    flat[G_CUL_STAT] = cls;
    flat[G_CUL_FRAC] = ct > 0 ? cls / ct : 0;
    flat[G_PHL_FIRES] = world.phLFires;
    flat[G_CUL_FIRES] = world.cuLFires;
    flat[G_PHL_FIRED] = world.phLFired;
    flat[G_CUL_FIRED] = world.cuLFired;
    flat[G_PHL_LASTIDX] = plIdx;
    flat[G_PHL_LASTDIR] = plDir;
    flat[G_CUL_LASTIDX] = clIdx;
    flat[G_CUL_LASTDIR] = clDir;
    flat[G_PHL_LATCHED] = phL.latched ? 1 : 0;
    flat[G_CUL_LATCHED] = cuL.latched ? 1 : 0;
    flat[G_LATCH_ON] = world.latchOn ? 1 : 0;
    return (world.phFires + world.cuFires + world.phLFires + world.cuLFires) | 0;
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

/** D6 mode selector (locked at ctor, drives strict / range). 0 = default (strict off, collapse-lowest);
 *  1 = strict (span-based, no declared range); 2 = declared range [SLD_RANGE_MIN, SLD_RANGE_MAX]. */
export const SLD_MODE_DEFAULT = 0;
export const SLD_MODE_STRICT = 1;
export const SLD_MODE_RANGE = 2;
/** The declared strict range band [1, 20] (F2): a value outside it is PRE-CHECKED out (counted rejected),
 *  never added -- so a consumer pre-checks the accepted band instead of catching a "would collapse" throw. */
export const SLD_RANGE_MIN = 1;
export const SLD_RANGE_MAX = 20;

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
// --- 1.8.0 (D6) APPEND-ONLY: the B+1 covered span vs the TRUE (now-W, now] window, and the 3-way
// strict / range toggle (F2, F7). ---
export const Q_TRUEW = 21;       // true(W) count over the TRUE (now-W, now] window (independent oracle)
export const Q_CNT_CURSOR = 22;  // sd.count() / true(W) -- the F7 lower-bound cursor (never < 1)
export const Q_COVMIN = 23;      // covered-span min = W (the FULL window is always covered)
export const Q_COVMAX = 24;      // covered-span max = W + W/panes (over-covered by <= one pane)
export const Q_STRICT = 25;      // sd.strict (0/1)
export const Q_RANGEMIN = 26;    // sd.rangeMin (NaN when no range is declared)
export const Q_RANGEMAX = 27;    // sd.rangeMax (NaN when no range is declared)
export const Q_REJECTED = 28;    // out-of-declared-range values pre-checked out (range mode only)
export const Q_MODE = 29;        // the demo mode selector (0 default / 1 strict / 2 range)
export const SLD_FLAT_LEN = 30;

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
 * @param {number} [mode]  D6 mode selector 0 (default / strict off) / 1 (strict span-based) / 2
 *                         (declared range [1, 20]). Default 0 -> a 3-arg call stays golden-identical.
 *                         A bad mode throws [lite-adaptive] BEFORE any allocation (fail-closed knob).
 */
export function createSldWorld(W, alpha, panes, mode) {
    // null is not zero: fall back to the default mode only on undefined/null (an explicit 0 is honored).
    const md = (mode === undefined || mode === null) ? SLD_MODE_DEFAULT : mode;
    // D6 blocker (fail-closed option): validate the mode BEFORE any allocation. 0 / 1 / 2 only; a
    // non-integer / out-of-set / string mode is a tagged throw, never a silent fall-through to default.
    if (md !== SLD_MODE_DEFAULT && md !== SLD_MODE_STRICT && md !== SLD_MODE_RANGE) {
        throw new TypeError('[lite-adaptive] SLD mode must be 0 (default), 1 (strict), or 2 (range [' +
            SLD_RANGE_MIN + ', ' + SLD_RANGE_MAX + ']), got ' +
            (typeof mode === 'string' ? JSON.stringify(mode) : String(mode)));
    }
    // Build the sketch through the shipped option door: default (strict off), strict (span-based, no
    // range), or a declared range (strict derived, rangeMin / rangeMax populated). Each throws on a bad arg.
    const sd = md === SLD_MODE_STRICT ? new SlidingDDSketch(W, { alpha, panes, strict: true })
        : md === SLD_MODE_RANGE ? new SlidingDDSketch(W, { alpha, panes, range: [SLD_RANGE_MIN, SLD_RANGE_MAX] })
            : new SlidingDDSketch(W, { alpha, panes });   // throws [lite-adaptive] on bad args
    // Range-mode PRE-CHECK bounds read ONCE from the shipped getters (NaN when no range) -- a hot-path
    // read of the getter per value would box; these plain-number locals ride the step loop unboxed.
    const rMin = sd.rangeMin, rMax = sd.rangeMax;
    const world = {
        sd, W, alpha, panes, pw: W / panes, paused: false, mode: md,
        // oracle gate (D6 blocker 7): the exact-ring oracles (quantile true values + true(W) count) can be
        // toggled off. When off, every oracle-derived slot fails closed to NaN in renderSldPrep's cold
        // branch instead of showing a frozen stale bound as live. resumeNow marks the `now` at which the
        // oracle was last re-enabled: the ring is stale for a full window W after resume, so the accuracy /
        // count gauges hold NaN until now - resumeNow >= W (mirrors EH's oracleOn / resumeNow).
        oracleOn: true, resumeNow: -Infinity,
        rMin, rMax, rejected: 0,
        vals: new Float64Array(SLD_STREAM_LEN),
        streamMask: SLD_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, frameNowStart: 0, now: 0, n: 0, sink: 0,
        valuesPerFrame: SLD_VALUES_PER_FRAME,
        packed: new Float64Array(2),                   // [now, value] scratch for addFrom (reused)
        qs: new Float64Array([0.5, 0.9, 0.99]),        // the render's quantile probes (F5 quantileInto)
        qout: new Float64Array(3),                     // quantileInto output (0 B/call reader)
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
    // D6 range mode: PRE-CHECK each value against the declared band [rMin, rMax] read once at build. An
    // out-of-band value is NOT added (counted rejected) but the clock still slides via advanceFrom, so a
    // consumer pre-checks the accepted band (F2) instead of catching a throw -- 0 B/op, no try/catch.
    // `!(v >= rMin && v <= rMax)` rejects NaN too (fail closed). rangeOn is false for modes 0/1 (the
    // default hot body is byte-identical to pre-D6: a straight addFrom, no per-value branch cost there).
    const rangeOn = world.mode === SLD_MODE_RANGE, rMin = world.rMin, rMax = world.rMax;
    let pos = world.cursor, now = world.now;
    world.frameStart = pos & mask;
    world.frameNowStart = now;
    let sink = 0, rej = 0;
    for (let i = 0; i < vpf; i++) {
        const idx = pos & mask;
        const v = vals[idx];
        now = now + 1;
        if (rangeOn && !(v >= rMin && v <= rMax)) {
            packed[0] = now; sd.advanceFrom(packed, 0);   // slide the clock past the rejected tick (0 B/op)
            rej = (rej + 1) | 0;
        } else {
            packed[0] = now; packed[1] = v;
            sd.addFrom(packed, 0);
        }
        sink = (sink + (now | 0)) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.now = now; world.frameCount = vpf;
    world.rejected = (world.rejected + rej) | 0;
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
    // Mirror the step's D6 range pre-check EXACTLY: only accepted values enter the oracle ring, so the
    // oracle content matches the sketch's physically-retained content (rel-error is purely bucket error).
    const rangeOn = world.mode === SLD_MODE_RANGE, rMin = world.rMin, rMax = world.rMax;
    let now = world.frameNowStart, head = world.oHead, tail = world.oTail;
    for (let i = 0; i < count; i++) {
        now = now + 1;
        const v = vals[(start + i) & mask];
        if (rangeOn && !(v >= rMin && v <= rMax)) continue;   // pre-checked out -> not retained (matches step)
        oT[tail] = now; oV[tail] = v; tail = (tail + 1) & omask;
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
 * vs TWO independent exact oracles. (a) The QUANTILE oracle: the exact multiset of the COVERED span
 * [W, W+W/B] (the geometry the sketch physically retains), insertion-sorted into the PREALLOCATED sortBuf
 * (0 alloc, NO .sort()); the p50/p90/p99 rel-error is then purely DDSketch bucket error (rel <= alpha).
 * (b) The COUNT oracle: true(W) over the TRUE (now - W, now] window -- a DIFFERENT window than the sketch's
 * geometry, so the F7 lower-bound cursor `count() / true(W)` is honest (>= 1, never < 1) and an oracle that
 * shared the sketch's covered span would agree with an under-coverage bug. The render reads quantiles
 * through `quantileInto` (F5, 0 B/call; the scalar `quantile()` keeps its one boxed return). 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} an int32 fold (defeats DCE; never a boxed double).
 */
export function renderSldPrep(world, allocState) {
    const sd = world.sd, flat = world.flat, pw = world.pw, W = world.W;
    const oT = world.oT, oV = world.oV, omask = world.oMask, sortBuf = world.sortBuf;
    const liveCut = sldPaneEnd(world.now, pw) - W - pw;   // B+1 covered span (F7)
    const trueCut = world.now - W;                        // the TRUE (now - W, now] window (count oracle)
    // one ring pass: insertion-sort the COVERED-span content into sortBuf AND count the TRUE-window items.
    let m = 0, trueW = 0, i = world.oHead;
    const tail = world.oTail;
    while (i !== tail) {
        const t = oT[i];
        if (t > trueCut) trueW++;                         // exact true(W) over (now - W, now]
        if (sldPaneEnd(t, pw) > liveCut) {
            const v = oV[i];
            let j = m - 1;
            while (j >= 0 && sortBuf[j] > v) { sortBuf[j + 1] = sortBuf[j]; j--; }
            sortBuf[j + 1] = v; m++;
        }
        i = (i + 1) & omask;
    }
    // F5: merge the live panes ONCE via quantileInto (0 B/call) -- byte-identical to three scalar
    // quantile() calls but without their three boxed returns.
    sd.quantileInto(world.qs, world.qout);
    const qout = world.qout, p50e = qout[0], p90e = qout[1], p99e = qout[2];
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
    // --- 1.8.0 (D6) APPEND-ONLY: the B+1 covered span vs the TRUE window, and the strict / range readouts.
    // rangeMin / rangeMax are read into locals (NaN when undeclared) then stored into slots (elided). The
    // count cursor uses the TRUE-window trueW (never the covered span m), so it exposes under-coverage. ---
    const rmin = sd.rangeMin, rmax = sd.rangeMax;
    flat[Q_TRUEW] = trueW;
    // Empty window (null is not zero): with no items in the TRUE (now - W, now] window the F7 cursor is
    // UNDEFINED, not 1 -- an empty window reading "1.00x in green" is a false pass. Fail closed to NaN
    // (rendered "n/a", neutral class) so the cursor never claims coverage over nothing.
    flat[Q_CNT_CURSOR] = trueW > 0 ? cnt / trueW : NaN;
    flat[Q_COVMIN] = W;
    flat[Q_COVMAX] = W + pw;
    flat[Q_STRICT] = sd.strict ? 1 : 0;
    flat[Q_RANGEMIN] = rmin;
    flat[Q_RANGEMAX] = rmax;
    flat[Q_REJECTED] = world.rejected;
    flat[Q_MODE] = world.mode;
    // Oracle gate (D6 blocker 7), COLD branch: every displayed number derived from the exact ring (the
    // quantile true values Q_P*T, the accuracy cursor Q_MAXREL / Q_FRAC, the live/edge counts Q_LIVE /
    // Q_EDGE, and the true(W) count Q_TRUEW + its cursor Q_CNT_CURSOR) is meaningless when the ring is not
    // a faithful (now - W, now] snapshot. Fail closed to NaN (rendered "n/a", gauge skipped) rather than
    // derive from a frozen / half-refilled ring and show it as live. Two cold branches, both NaN the same
    // slots: (1) oracle off -> the ring is frozen stale; (2) resume hold -> the ring is refilling and is
    // not a full valid window until now - resumeNow >= W. At defaults (oracleOn true, resumeNow -Infinity)
    // neither branch fires, so the golden stays bit-identical. Q_COUNT / Q_ORACLE_BYTES stay live readouts.
    if (!world.oracleOn || world.now - world.resumeNow < W) {
        flat[Q_P50T] = NaN; flat[Q_P90T] = NaN; flat[Q_P99T] = NaN;
        flat[Q_MAXREL] = NaN; flat[Q_FRAC] = NaN;
        flat[Q_LIVE] = NaN; flat[Q_EDGE] = NaN;
        flat[Q_TRUEW] = NaN; flat[Q_CNT_CURSOR] = NaN;
    }
    // HEAD returned `p50e` (a fractional quantile) and boxed 16 B/call across the render boundary; return
    // an int32 fold instead (lite-law) so the whole render measures 0 B/op (DemoProbe sld_render lane).
    return (world.n + world.rejected) | 0;
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
// --- 1.8.0 (D7) APPEND-ONLY: total(w) beside the ORACLE N, and the heavy-count mode (F6). ---
export const C_TOTAL = C_BOUNDOK + 12;                 // scm.total() -- the library's exact windowed N
export const C_TOTALOK = C_BOUNDOK + 13;               // 1 iff scm.total() === the ORACLE N (faithfulness)
export const C_HEAVY = C_BOUNDOK + 14;                 // heavy-count mode on (1/0)
export const SCM_FLAT_LEN = C_BOUNDOK + 15;

/**
 * Heavy-count mode (D7 / F6): once per frame, tracked key 0 also gets ONE add of this count, so its
 * windowed estimate exceeds 2^31 within a few panes (the scalar estimate() return would box; the render
 * reads through estimateInto). One add per frame keeps every pane cell far below the 2^32-1 saturation
 * (<= 2 frames per pane at the widest slider W -> <= 2^31 + the stream share per cell).
 */
export const SCM_HEAVY_COUNT = 1 << 30;
/** Heavy-add oracle ring (pow2) -- MUST exceed the live heavy adds (one per frame; <= 66 at W = 4096). */
export const SCM_HEAVY_RING = 256;

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
        // D7: the render reads every tracked key in ONE estimateInto call (0 B/call, F6) into estOut.
        estOut: new Float64Array(SCM_TRACKED),
        // D7 heavy-count mode: a display toggle read by stepScm (no rebuild). The heavy adds live in their
        // OWN small oracle ring (times only; the count is SCM_HEAVY_COUNT), so with heavy off every
        // pre-existing flat slot stays bit-identical (golden).
        heavy: false, frameHeavy: 0,
        // B9: the oracle toggle state (stepScmOracle is skipped while off -> the ring goes stale; after a
        // resume it is incomplete until a full covered span W + W/B refills). renderScmPrep NaNs every
        // oracle-derived slot in either state -- never a verdict on an unchecked state.
        oracleOn: true, resumeNow: -Infinity,
        hT: new Float64Array(SCM_HEAVY_RING), hMask: SCM_HEAVY_RING - 1, hHead: 0, hTail: 0,
    };
    fillScmStream(world);
    return world;
}

/**
 * D8 contracts line: two library contracts, observed LIVE from the shipped SlidingCountMin (cold, once at
 * boot -- never per frame). A bad sub-window reads NaN (F12: never a fail-open 0), and a typo'd option key
 * throws with the library's own did-you-mean hint. The message is the library's, never demo text.
 * @param {object} world
 * @returns {{ badW: number, typoMsg: string }}
 */
export function scmContracts(world) {
    const badW = world.scm.estimate(0, -1);
    let typoMsg = 'no throw (contract broken)';
    try { new SlidingCountMin(world.W, { sede: 1 }); } catch (e) { typoMsg = e.message; }
    return { badW, typoMsg };
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
        world.now = now; world.frameNowStart = now; world.frameCount = 0; world.frameHeavy = 0;
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
    // D7 heavy-count mode: ONE extra [now, key 0, 2^30] add per frame (same now -> non-decreasing).
    if (world.heavy) {
        packed[0] = now; packed[1] = 0; packed[2] = SCM_HEAVY_COUNT;
        scm.addFrom(packed, 0);
        world.frameHeavy = 1;
    } else {
        world.frameHeavy = 0;
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
    // An entry is LIVE iff paneEnd(t) >= paneEnd(now) - W (== the library's paneEnd > now - W, and the
    // render's liveThresh). Expire strictly BELOW the cut: until 2026-10-04 this was `<= liveCut`, which
    // dropped the oldest LIVE pane, so the oracle N ran one pane short of scm.total() (993 vs 1025 at
    // W=1024) and the one-sided band was too tight -- caught by the D7 total(w) faithfulness readout.
    const liveCut = scmPaneEnd(now, pw) - W;
    while (head !== tail && scmPaneEnd(oT[head], pw) < liveCut) head = (head + 1) & omask;
    world.oHead = head; world.oTail = tail;
    // D7: the frame's heavy add (if any) at the frame's end time, then the same grid-pane expiry.
    const hT = world.hT, hmask = world.hMask;
    let hh = world.hHead, ht = world.hTail;
    if (world.frameHeavy === 1 && count > 0) {
        hT[ht] = now; ht = (ht + 1) & hmask;
        allocState.oracleCount++;
    }
    while (hh !== ht && scmPaneEnd(hT[hh], pw) < liveCut) hh = (hh + 1) & hmask;
    world.hHead = hh; world.hTail = ht;
    world.n = (world.n + count) | 0;
    return (tail - head) & omask;
}

/**
 * Render-prep (~10Hz): re-derive every tracked key's shipped SlidingCountMin.estimate vs the EXACT
 * one-sided band [true(W), true(W+W/B) + eps*N] computed from the (t, key) ring in ONE scan. Verifies
 * the bound per tracked key. scm.estimate is COLD 0-alloc; the ring scan is 0-alloc. 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} an int32 fold (1 iff the bound holds) -- never a boxed double.
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
    // D7 heavy adds: weighted SCM_HEAVY_COUNT into N and into tracked key 0's true(W) / trueLive.
    let nW = nLive, hLive = 0;
    const hT = world.hT, hmask = world.hMask, htail = world.hTail;
    for (let h = world.hHead; h !== htail; h = (h + 1) & hmask) {
        if (scmPaneEnd(hT[h], pw) >= liveThresh) {
            hLive++;
            nW += SCM_HEAVY_COUNT;
            for (let k = 0; k < nt; k++) {
                if (tracked[k] === 0) {
                    if (hT[h] > idealCut) flat[k * SCM_STRIDE + 1] += SCM_HEAVY_COUNT;
                    flat[k * SCM_STRIDE + 2] += SCM_HEAVY_COUNT;
                    break;
                }
            }
        }
    }
    // D7: every tracked estimate in ONE estimateInto call (0 B/call even for a count >= 2^31, F6).
    const estOut = world.estOut;
    scm.estimateInto(tracked, estOut);
    let boundOk = 1;
    for (let k = 0; k < nt; k++) {
        const est = estOut[k];
        const trueW = flat[k * SCM_STRIDE + 1];
        const trueLive = flat[k * SCM_STRIDE + 2];
        const upper = trueLive + eps * nW;   // the eps x N band from the ORACLE's N, never scm.total()
        if (est < trueW - 1e-9 || est > upper + 1e-9) boundOk = 0;
        flat[k * SCM_STRIDE] = est;
        flat[k * SCM_STRIDE + 1] = trueW;
        flat[k * SCM_STRIDE + 2] = upper;
    }
    flat[C_BOUNDOK] = boundOk;
    flat[C_SATURATED] = scm.saturated;
    flat[C_NLIVE] = nW;
    flat[C_N] = world.n;
    flat[C_EPS] = eps;
    flat[C_PANES] = scm.panes;
    flat[C_W] = scm.W;
    flat[C_NOW] = now;
    flat[C_SKETCH_BYTES] = scm.bytes;
    flat[C_ORACLE_BYTES] = (nLive + hLive) * (BYTES_PER_F64 * 2);
    flat[C_SKETCH_ALLOC] = allocState.sketchCount;
    flat[C_ORACLE_ALLOC] = allocState.oracleCount;
    // D7: the library's own exact windowed N, displayed BESIDE the oracle N as its own faithfulness check.
    const tot = scm.total();
    flat[C_TOTAL] = tot;
    flat[C_TOTALOK] = tot === nW ? 1 : 0;
    flat[C_HEAVY] = world.heavy ? 1 : 0;
    // Oracle off / refilling after a resume: NaN every oracle-derived slot (the estimates, total(),
    // saturated and the bytes stay live). At defaults (oracleOn true, resumeNow -Infinity) this never
    // fires, so the golden is unchanged.
    if (!world.oracleOn || now - world.resumeNow < W + pw) {
        for (let k = 0; k < nt; k++) { flat[k * SCM_STRIDE + 1] = NaN; flat[k * SCM_STRIDE + 2] = NaN; }
        flat[C_BOUNDOK] = NaN; flat[C_NLIVE] = NaN; flat[C_TOTALOK] = NaN;
        return 0;
    }
    // an int32 fold, never flat[0]: in heavy mode the tracked estimate exceeds 2^31 and a returned large
    // double boxes 16 B/call at the call boundary (DemoProbe scm_render_heavy).
    return boundOk | 0;
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

// =======================================================================================
// Scene 10 -- SlidingAggregate (exact windowed count / sum / mean / min / max; 1.9.0, ADR 0012)
// =======================================================================================
// A lite-hud-shaped latency panel: integer-ms lognormal latencies (+ an optional 1% x50 spike mode) fly in
// via addFrom([now, value]); the canvas plots the windowed MEAN from SlidingAggregate (exact over the covered
// span [W, W + W/B]) beside an exact oracle and beside ExponentialHistogram's sum()-derived mean on the SAME
// stream -- the F17 failure: EH's sum() error is bounded by the straddling bucket's POPULATION, not its value
// mass, so a skewed (spiky) stream breaks EH's <= epsilon intuition while SlidingAggregate stays exact.
//
// Numeric domain (ROADMAP 11.1 D-S7): a sim clock in ms from 0, SA_DT = 1000/60 per frame, SA_EVENTS_PER_FRAME
// events per frame at frameNow + (j+1) * SA_DT / K (computed by multiplication, never accumulated). W = 1000,
// B = 32 -> pw = 31.25 (a normal double); the library's clock bound pw * 2^42 = 1.37e14 ms is never near.
// Values are WHOLE milliseconds (round(lognormal), min 1; spikes x50 stay integers, max ~5.5e4), so every
// windowed sum is an exactly representable integer (<< 2^53): SlidingAggregate's count / sum / min / max are
// gated EXACTLY EQUAL to an independent recount, and EH's integer-valued sum() returns a Smi (no render box).

/** Pre-generated latency stream length (pow2). */
export const SA_STREAM_LEN = 1 << 16;
/** Latency events per rAF frame. */
export const SA_EVENTS_PER_FRAME = 32;
/** Sim milliseconds per frame (60 Hz). */
export const SA_DT = 1000 / 60;
/** Default window (ms) and pane count B. */
export const SA_DEFAULT_W = 1000;
export const SA_DEFAULT_PANES = 32;
/** Lognormal latency model: median e^3 ~ 20 ms, mean e^3.5 ~ 33 ms. */
export const SA_MU = 3;
export const SA_SIGMA = 1;
/** Spike mode: 1% of events x50 (the skew that breaks EH's sum()). */
export const SA_SPIKE_RATE = 0.01;
export const SA_SPIKE_MULT = 50;
export const SA_STREAM_SEED = 0x5a17e4c9;
/** The EH contrast: epsilon and a pool sized for the window population (~1.9k events per W = 1000 ms). */
export const SA_EH_EPS = 0.05;
export const SA_EH_MAXCOUNT = 8192;
/** Exact-oracle ring (pow2) -- MUST exceed the events in the covered span at the widest slider W (4000 ms:
 *  (4000 + 125) / SA_DT * 32 ~ 7.9k). */
export const SA_RING_LEN = 1 << 14;

// flat slots -- the sketch row (through sa.into), the oracle row, the EH contrast, bookkeeping.
export const L_COUNT = 0;          // sa: covered-span count (exact)
export const L_SUM = 1;            // sa: covered-span sum
export const L_MEAN = 2;           // sa: sum / count (NaN on empty)
export const L_MIN = 3;            // sa: min (NaN on empty)
export const L_MAX = 4;            // sa: max (NaN on empty)
export const L_TCOUNT = 5;         // oracle: covered-span count (NaN when the oracle is off / resuming)
export const L_TSUM = 6;           // oracle: covered-span sum
export const L_TMEAN = 7;          // oracle: covered-span mean
export const L_TMIN = 8;           // oracle: covered-span min
export const L_TMAX = 9;           // oracle: covered-span max
export const L_EXACT = 10;         // 1 iff count / sum / min / max equal the oracle exactly (NaN when off)
export const L_TSUMW = 11;         // oracle: TRUE-window (now - W, now] sum -- what EH's sum() estimates
export const L_TCOUNTW = 12;       // oracle: TRUE-window count
export const L_EHSUM = 13;         // eh.sum() over the last W
export const L_EHMEAN = 14;        // eh.sum() / eh.count() (NaN on empty)
export const L_EHREL = 15;         // |eh.sum() - trueSum(W)| / trueSum(W) (NaN when off / empty)
export const L_EHEPS = 16;         // the EH epsilon (the "<= epsilon" intuition F17 breaks)
export const L_SPIKES = 17;        // spike mode on (1/0)
export const L_N = 18;             // events fed
export const L_NOW = 19;           // sim clock (ms)
export const L_SKETCH_BYTES = 20;  // sa.bytes (fixed)
export const L_ORACLE_BYTES = 21;  // live ring entries * 16 ((t, v) pairs, O(W))
export const L_SKETCH_ALLOC = 22;
export const L_ORACLE_ALLOC = 23;
export const L_EHRELMAX = 24;      // running max of L_EHREL while the oracle is valid (spikes are rare)
export const SA_FLAT_LEN = 25;

/** SlidingAggregate render row: sa.into(out) writes [count, sum, mean, min, max] (0 B/call). */
const SA_ROW = new Float64Array(5);

/** Fill the reused integer-ms latency stream + the 1% spike mask (Box-Muller lognormal). Warmup only. */
function fillSaStream(world) {
    const vals = world.vals, spike = world.spike, len = vals.length;
    const rng = makeRng(world.seed);
    for (let i = 0; i < len; i++) {
        let u1 = rng(); if (u1 < 1e-12) u1 = 1e-12;
        const u2 = rng();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const ms = Math.round(Math.exp(SA_MU + SA_SIGMA * z));
        vals[i] = ms < 1 ? 1 : ms;                   // whole ms, >= 1 (EH requires a positive value)
        spike[i] = rng() < SA_SPIKE_RATE ? 1 : 0;
    }
}

/** The grid-pane end covering time `t` for pane width `pw` (the SlidingAggregate pane math, ADR 0012). */
function saPaneEnd(t, pw) { return (Math.floor(t / pw) + 1) * pw; }

/**
 * Build the Scene-10 world ONCE: the REAL SlidingAggregate, the ExponentialHistogram contrast on the same
 * stream, an exact (t, v) ring oracle, the reused latency stream, and the flat buffer. Fails closed on a bad
 * W / panes via the library's ctor guards.
 * @param {number} W       window span in ms (finite > 0).
 * @param {number} panes   pane count B in [2, 1024].
 * @param {number} [seed]  uint32 stream seed.
 */
export function createSaWorld(W, panes, seed) {
    const s = (seed === undefined || seed === null) ? SA_STREAM_SEED : (seed >>> 0);
    const sa = new SlidingAggregate(W, { panes });               // throws [lite-adaptive] on bad args
    const eh = new ExponentialHistogram(W, SA_EH_EPS, { maxCount: SA_EH_MAXCOUNT });
    const world = {
        sa, eh, W, panes, pw: W / panes, seed: s,
        paused: false, spikes: false, oracleOn: true, resumeNow: -Infinity,
        ehAcc: new Float64Array(3),                              // [eh.count(), eh.sum(), running max rel err]
        vals: new Float64Array(SA_STREAM_LEN), spike: new Uint8Array(SA_STREAM_LEN), streamMask: SA_STREAM_LEN - 1,
        cursor: 0, frameStart: 0, frameCount: 0, frameNowStart: 0, frameSpikes: 0, now: 0, n: 0, sink: 0,
        packed: new Float64Array(2),                             // [now, value] scratch for addFrom (reused)
        oT: new Float64Array(SA_RING_LEN), oV: new Float64Array(SA_RING_LEN),
        oMask: SA_RING_LEN - 1, oHead: 0, oTail: 0,
        flat: new Float64Array(SA_FLAT_LEN),
    };
    fillSaStream(world);
    return world;
}

/**
 * One SKETCH-path frame: SA_EVENTS_PER_FRAME [now, latency] pairs UNBOXED into SlidingAggregate.addFrom AND
 * ExponentialHistogram.addFrom (the F17 contrast on the same stream). While paused, idle-slides both via
 * advanceFrom (R11, NO add) so the window empties. 0 B/op.
 * @param {object} world
 * @returns {number} an int32 fold (defeats DCE).
 */
export function stepSa(world) {
    const packed = world.packed, frameNow = world.now;
    if (world.paused) {
        const now = frameNow + SA_DT;
        packed[0] = now;
        world.sa.advanceFrom(packed, 0);
        world.eh.advanceFrom(packed, 0);
        world.now = now; world.frameNowStart = now; world.frameCount = 0;
        return 0;
    }
    const vals = world.vals, spike = world.spike, mask = world.streamMask, sa = world.sa, eh = world.eh;
    const K = SA_EVENTS_PER_FRAME, step = SA_DT / K, spikesOn = world.spikes;
    let pos = world.cursor, t = frameNow, sink = 0;
    world.frameStart = pos & mask;
    world.frameNowStart = frameNow;
    world.frameSpikes = spikesOn ? 1 : 0;
    for (let j = 0; j < K; j++) {
        t = frameNow + (j + 1) * step;
        const i = pos & mask;
        const v = (spikesOn && spike[i] === 1) ? vals[i] * SA_SPIKE_MULT : vals[i];
        packed[0] = t; packed[1] = v;
        sa.addFrom(packed, 0);
        eh.addFrom(packed, 0);
        sink = (sink + (v | 0)) | 0;
        pos = pos + 1;
    }
    world.cursor = pos & 0x3fffffff;
    world.now = t; world.frameCount = K;
    world.n = world.n + K;
    world.sink = (world.sink + sink) | 0;
    return sink;
}

/**
 * One EXACT-ORACLE frame: replay the frame's events (same times / values, recomputed from the stream) into
 * the preallocated (t, v) ring and expire every entry whose grid pane has left the covered span (LIVE iff
 * paneEnd(t) > now - W, the library's rule). 0 B/op.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} the live ring size.
 */
export function stepSaOracle(world, allocState) {
    const vals = world.vals, spike = world.spike, mask = world.streamMask;
    const start = world.frameStart, count = world.frameCount, spikesOn = world.frameSpikes === 1;
    const oT = world.oT, oV = world.oV, omask = world.oMask, pw = world.pw;
    const frameNow = world.frameNowStart, step = SA_DT / SA_EVENTS_PER_FRAME;
    let head = world.oHead, tail = world.oTail;
    for (let j = 0; j < count; j++) {
        const i = (start + j) & mask;
        oT[tail] = frameNow + (j + 1) * step;
        oV[tail] = (spikesOn && spike[i] === 1) ? vals[i] * SA_SPIKE_MULT : vals[i];
        tail = (tail + 1) & omask;
        allocState.oracleCount++;                        // a retained (t, v) pair the sketch refuses
    }
    const cut = world.now - world.W;
    while (head !== tail && !(saPaneEnd(oT[head], pw) > cut)) head = (head + 1) & omask;
    world.oHead = head; world.oTail = tail;
    return (tail - head) & omask;
}

/**
 * Render-prep (~10Hz): the SlidingAggregate row through sa.into(SA_ROW) (0 B/call) and the exact oracle over
 * the covered span (count / sum / min / max, one ring scan) plus the TRUE window (now - W, now] sum that the
 * EH contrast is judged against. Oracle-derived slots fail CLOSED to NaN while the oracle is off or refilling
 * after a resume (never a stale "exact"). Every fractional result is stored straight into its slot from an
 * if / else -- a `cond ? x / y : NaN` ternary merges a computed double with the NaN constant and boxes the
 * phi (16 B each, DemoProbe sa_render). 0 B/tick. Returns an int32 fold.
 * @param {object} world
 * @param {object} allocState
 * @returns {number} 1 iff the sketch row equals the oracle exactly (0 otherwise / when off).
 */
export function renderSaPrep(world, allocState) {
    const sa = world.sa, flat = world.flat, row = SA_ROW;
    sa.into(row);
    const c = row[0], s = row[1], mn = row[3], mx = row[4];
    flat[L_COUNT] = c; flat[L_SUM] = s; flat[L_MEAN] = row[2]; flat[L_MIN] = mn; flat[L_MAX] = mx;
    flat[L_EHEPS] = SA_EH_EPS;
    flat[L_SPIKES] = world.spikes ? 1 : 0;
    flat[L_N] = world.n;
    flat[L_NOW] = world.now;
    flat[L_SKETCH_BYTES] = sa.bytes;
    flat[L_ORACLE_BYTES] = ((world.oTail - world.oHead) & world.oMask) * (BYTES_PER_F64 * 2);
    flat[L_SKETCH_ALLOC] = allocState.sketchCount;
    flat[L_ORACLE_ALLOC] = allocState.oracleCount;
    // Oracle off, or refilling after a resume (a full covered span W + W/B must pass): NaN every oracle slot.
    if (!world.oracleOn || world.now - world.resumeNow < world.W + world.pw) {
        flat[L_TCOUNT] = NaN; flat[L_TSUM] = NaN; flat[L_TMEAN] = NaN; flat[L_TMIN] = NaN; flat[L_TMAX] = NaN;
        flat[L_EXACT] = NaN; flat[L_TSUMW] = NaN; flat[L_TCOUNTW] = NaN;
        return 0;
    }
    const oT = world.oT, oV = world.oV, omask = world.oMask, pw = world.pw;
    const cut = world.now - world.W, tail = world.oTail;
    let tc = 0, ts = 0, tmin = Infinity, tmax = -Infinity, tcw = 0, tsw = 0;
    for (let i = world.oHead; i !== tail; i = (i + 1) & omask) {
        const t = oT[i], v = oV[i];
        if (saPaneEnd(t, pw) > cut) {
            tc++; ts += v;                                // whole-ms integers: exact (<< 2^53)
            if (v < tmin) tmin = v;
            if (v > tmax) tmax = v;
            if (t > cut) { tcw++; tsw += v; }
        }
    }
    flat[L_TCOUNT] = tc; flat[L_TSUM] = ts; flat[L_TSUMW] = tsw; flat[L_TCOUNTW] = tcw;
    if (tc > 0) {
        flat[L_TMEAN] = ts / tc; flat[L_TMIN] = tmin; flat[L_TMAX] = tmax;
    } else {
        flat[L_TMEAN] = NaN; flat[L_TMIN] = NaN; flat[L_TMAX] = NaN;
    }
    // exact equality; an empty window is exact when both sides are empty (sketch min / max are NaN)
    let exact = 0;
    if (c === tc && s === ts) {
        if (tc === 0) exact = (mn !== mn && mx !== mx) ? 1 : 0;
        else exact = (mn === tmin && mx === tmax) ? 1 : 0;
    }
    flat[L_EXACT] = exact;
    return exact;
}

/**
 * EH contrast (~10Hz, after renderSaPrep): eh.sum() / eh.count() on the same stream and the relative error
 * of eh.sum() against the oracle's TRUE-window sum (L_TSUMW), plus its running max. eh.count() / eh.sum()
 * return a half-bucket estimate (x.5); each return is stored straight into a world.ehAcc Float64Array slot,
 * so V8 elides the box: 0 B/tick (DemoProbe sa_eh_render). NaN while the oracle is off / resuming.
 * @param {object} world
 */
export function renderSaEhPrep(world) {
    const eh = world.eh, flat = world.flat, acc = world.ehAcc;
    acc[0] = eh.count();
    acc[1] = eh.sum();
    flat[L_EHSUM] = acc[1];
    if (acc[0] > 0) flat[L_EHMEAN] = acc[1] / acc[0]; else flat[L_EHMEAN] = NaN;
    const tsw = flat[L_TSUMW];
    if (tsw > 0) {
        flat[L_EHREL] = Math.abs(acc[1] - tsw) / tsw;
        if (!(flat[L_EHREL] <= acc[2])) acc[2] = flat[L_EHREL];   // running max (acc[2] starts at 0)
        flat[L_EHRELMAX] = acc[2];
    } else {
        flat[L_EHREL] = NaN; flat[L_EHRELMAX] = NaN;           // oracle off / resuming / empty
    }
}

// =======================================================================================
// S11 (D8) -- the Chromium-only key-magnitude allocation lane (N6: 31-bit Smis)
// =======================================================================================
// On a 31-bit-Smi build (Chromium with pointer compression) an integer key in [2^30, 2^31) is a HeapNumber,
// not a Smi; on this Node (arm64, 32-bit Smis) it is a Smi, so every Node 0 B/op says nothing about Chrome
// (ROADMAP 7.1 N6). The lane covers every member that hashes an integer KEY (ROADMAP 13 N-S3): HeavyKeeper
// ([key, weight]), SlidingHyperLogLog ([now, key]) and SlidingCountMin ([now, key, count]), each through its
// zero-box addFrom, over four key classes: small, [2^30, 2^31), >= 2^31 and negative <= -(2^30 + 1) (a
// HeapNumber on a 31-bit-Smi build, like the [2^30, 2^31) class). The explicit-time
// members get a running-counter `now` and W = KM_WINDOW_W, so the pane ring never rotates inside a
// measurement (a rotation's bounded clear is not the per-key cost). It measures IN the browser, on demand
// (a button -- never the frame path), from
// the deltas of a caller-supplied heap meter (performance.memory.usedJSHeapSize). The meter is coarse, so
// the result is SELF-TESTED: a control lane that boxes one HeapNumber per op must read >= KM_CONTROL_MIN
// B/op, else the lane reports 'blind' -- a blind meter NEVER reads as a clean 0 (null is not zero). No
// meter at all (non-Chromium) -> 'absent'.

/** Ops per measured window, the SAME for every lane (16 B/op x 12.5k = 0.2 MB: most windows fit between
 *  scavenges; a precise-info meter resolves it). */
export const KM_OPS = 12500;
/** The control must read at least this many B/op, else the meter is blind. */
export const KM_CONTROL_MIN = 8;
/** Keys in [2^30, 2^31): Smi on a 32-bit-Smi build, HeapNumber on a 31-bit-Smi build. */
export const KM_BIG31_BASE = 1073741824;
/** Keys >= 2^31: a HeapNumber on every build (beyond any Smi range). */
export const KM_BIG32_BASE = 2147483648;
/** The members the lane measures (runKeyMagLane's `member`). */
export const KM_MEMBERS = ['hk', 'shll', 'scm'];
/** The four key classes, in lane order (lane 1..4; lane 0 is the boxing control). */
export const KM_CLASSES = ['small', 'big31', 'big32', 'neg'];
/** Negative keys start here and go DOWN: -(2^30 + 1) .. -(2^30 + 1024), below the 31-bit Smi minimum -2^30. */
export const KM_NEG_BASE = -1073741825;
/** The explicit-time members' W: far beyond the run's running-counter `now` (~6e5), so no pane rotates. */
export const KM_WINDOW_W = 1e9;
const KM_ROUNDS = 8;
const KM_BOX = [{}, 0];
// key = KM_KEY_BASE[c] + KM_KEY_SIGN[c] * (i & 1023): small 0.., big31 2^30.., big32 2^31.., neg -(2^30 + 1)..
// (read from a Float64Array inside the window -- an unboxed double local, never a boxed argument)
const KM_KEY_BASE = Float64Array.of(0, KM_BIG31_BASE, KM_BIG32_BASE, KM_NEG_BASE);
const KM_KEY_SIGN = Float64Array.of(1, 1, 1, -1);

// The boxing control: one HeapNumber per op (a double stored into a generic array).
function kmControlWindow(meter, v, n) {
    const a = meter();
    for (let i = 0; i < n; i++) { v[0] += 1; KM_BOX[1] = v[0]; }
    return (meter() - a) / n;
}

// One key window per member: a SEPARATE function each, so every addFrom call site is MONOMORPHIC, the way a
// consumer calls it (one shared site would be polymorphic -- not the shape being measured). `c` = class 0..3.
function kmWindowHk(meter, c, hk, buf, n) {
    const base = KM_KEY_BASE[c], sg = KM_KEY_SIGN[c];
    const a = meter();
    for (let i = 0; i < n; i++) { buf[0] = base + sg * (i & 1023); hk.addFrom(buf, 0); }        // [key, 1]
    return (meter() - a) / n;
}

function kmWindowShll(meter, c, sl, buf, n) {
    const base = KM_KEY_BASE[c], sg = KM_KEY_SIGN[c];
    const a = meter();
    for (let i = 0; i < n; i++) { buf[0] += 1; buf[1] = base + sg * (i & 1023); sl.addFrom(buf, 0); }   // [now, key]
    return (meter() - a) / n;
}

function kmWindowScm(meter, c, scm, buf, n) {
    const base = KM_KEY_BASE[c], sg = KM_KEY_SIGN[c];
    const a = meter();
    for (let i = 0; i < n; i++) { buf[0] += 1; buf[1] = base + sg * (i & 1023); scm.addFrom(buf, 0); }  // [now, key, 1]
    return (meter() - a) / n;
}

/** Clean windows a lane needs (of KM_ROUNDS) before its reading is reported at all. */
export const KM_MIN_CLEAN = 3;

/**
 * Aggregate one lane's per-window readings (B/op). A NEGATIVE window means a scavenge ran inside it -- it is
 * not a measurement, so it is DROPPED (never clamped to 0). A scavenge can only LOWER a reading, so the
 * value is taken from the TOP of the clean windows: the SECOND-largest, which discards exactly one outlier
 * window (a JIT tier-up landing in one window: measured 0.9 B/op once, 0.0 in the other 7) while a real box
 * -- present in EVERY clean window -- still shows in full. Fewer than KM_MIN_CLEAN clean windows -> NaN
 * (the caller reports 'blind').
 * @param {Float64Array} readings
 * @returns {number}
 */
export function kmAggregate(readings) {
    let clean = 0, top = -Infinity, second = -Infinity;
    for (let i = 0; i < readings.length; i++) {
        const r = readings[i];
        if (!(r >= 0 && r < Infinity)) continue;      // a scavenged (negative), NaN or infinite window (QA-2)
        clean++;
        if (r > top) { second = top; top = r; } else if (r > second) second = r;
    }
    return clean >= KM_MIN_CLEAN ? second : NaN;
}

/**
 * Run the S11 lane for one member: the four key-class lanes FIRST (after unmeasured warm-up of every lane for the
 * JIT tiers, then KM_ROUNDS windows each) and the boxing control LAST (so its garbage is never collected inside a
 * key-lane window). EVERY window has the SAME size (KM_OPS), so a meter that resolves the control resolves the
 * key lanes too. Each lane is kmAggregate'd (scavenged windows dropped, the second-largest clean reading); any
 * lane with fewer than KM_MIN_CLEAN clean windows, or a control below KM_CONTROL_MIN, makes the whole result
 * 'blind' -- never a 0 from a meter that cannot see. COLD -- allocates its sketch, scratch and result; never
 * per frame. Never throws on a meter fault (the click handler renders whatever comes back); an unknown
 * `member` is a programming error and throws.
 * @param {(() => number) | undefined} meter  e.g. () => performance.memory.usedJSHeapSize
 * @param {number} [ops]
 * @param {'hk' | 'shll' | 'scm'} [member]  default 'hk'
 * @returns {{ state: 'ok' | 'blind' | 'absent' | 'nowork', member: string, control: number,
 *             small: number, big31: number, big32: number, neg: number,
 *             raw: { control: Float64Array, small: Float64Array, big31: Float64Array,
 *                    big32: Float64Array, neg: Float64Array } | null }}
 */
export function runKeyMagLane(meter, ops, member) {
    const m = member === undefined ? 'hk' : member;
    if (m !== 'hk' && m !== 'shll' && m !== 'scm') {
        throw new RangeError('[demo] runKeyMagLane member must be one of ' + KM_MEMBERS.join(' / ') + ', got ' + String(member));
    }
    const n = ops === undefined ? KM_OPS : ops;
    // fail closed: a bad window size (QA-3: 0 / null divided by zero into an 'ok' Infinity) is never measured
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return kmFail('blind', m, NaN, null);
    let probe;
    try { probe = typeof meter === 'function' ? meter() : undefined; } catch (e) { probe = undefined; }
    if (typeof probe !== 'number' || probe !== probe) return kmFail('absent', m, NaN, null);
    // a meter that THROWS mid-run (QA-1) is a blind meter: the result is 'blind', never a thrown click
    // handler that leaves a stale earlier reading on screen
    try {
        return kmRun(meter, n, m);
    } catch (e) {
        return kmFail('blind', m, NaN, null);
    }
}

/**
 * Proof that the last key window did addFrom WORK (review N4: a window that skips addFrom reads a perfect 0).
 * shll / scm: the sketch's lastNow equals the running-counter `now` the window ended on (a skipped window
 * leaves it stale). hk (no clock): SOME key of class `c` has an estimate >= 1 -- a class that never reaches
 * addFrom reads 0 on all 1024 (its keys are disjoint from every other class). Not "the LAST key": HeavyKeeper
 * may decay any one light key to 0 (measured: a false 'nowork' at 4x KM_OPS). The scan exits on the first
 * hit. COLD: once per window, outside the meter reads.
 * @returns {boolean}
 */
export function kmDidWork(member, sk, buf, c) {
    if (member === 'hk') {
        const base = KM_KEY_BASE[c], sg = KM_KEY_SIGN[c];
        for (let j = 0; j < 1024; j++) if (sk.estimate(base + sg * j) >= 1) return true;
        return false;
    }
    return sk.lastNow === buf[0] && buf[0] > 0;
}

/** A non-ok result: every key lane NaN (null is not zero). */
function kmFail(state, member, control, raw) {
    return { state, member, control, small: NaN, big31: NaN, big32: NaN, neg: NaN, raw };
}

function kmRun(meter, n, member) {
    // the member, its packed addFrom scratch, and its (monomorphic) key window
    let sk, buf, win;
    if (member === 'hk') {
        sk = new HeavyKeeper(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K);
        buf = new Float64Array(2); buf[1] = 1;                              // [key, weight 1]
        win = kmWindowHk;
    } else if (member === 'shll') {
        sk = new SlidingHyperLogLog(KM_WINDOW_W, { p: SHLL_DEFAULT_P, ringCap: SHLL_DEFAULT_RINGCAP, seed: SHLL_DEFAULT_SEED });
        buf = new Float64Array(2);                                          // [now, key]
        win = kmWindowShll;
    } else {
        sk = new SlidingCountMin(KM_WINDOW_W, { epsilon: SCM_DEFAULT_EPS, panes: SCM_DEFAULT_PANES, seed: SCM_DEFAULT_SEED });
        buf = new Float64Array(3); buf[2] = 1;                              // [now, key, count 1]
        win = kmWindowScm;
    }
    const v = new Float64Array(1); v[0] = 0.5;
    // warm-up (unmeasured): the control path first, then 4 rounds of every key lane -- the first windows of a
    // fresh process carry JIT tier-up allocation (measured: 1.2 / 0.8 / 0.3 B/op on small keys, 43.7 on the
    // control), which is not the steady-state cost
    for (let r = 0; r < 2; r++) kmControlWindow(meter, v, n);
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            win(meter, c, sk, buf, n);
            if (!kmDidWork(member, sk, buf, c)) return kmFail('nowork', member, NaN, null);
        }
    }
    const lanes = [new Float64Array(KM_ROUNDS), new Float64Array(KM_ROUNDS), new Float64Array(KM_ROUNDS), new Float64Array(KM_ROUNDS)];
    for (let r = 0; r < KM_ROUNDS; r++) {
        for (let c = 0; c < 4; c++) {
            lanes[c][r] = win(meter, c, sk, buf, n);
            if (!kmDidWork(member, sk, buf, c)) return kmFail('nowork', member, NaN, null);
        }
    }
    const cs = new Float64Array(KM_ROUNDS);
    for (let r = 0; r < KM_ROUNDS; r++) cs[r] = kmControlWindow(meter, v, n);
    const raw = { control: cs, small: lanes[0], big31: lanes[1], big32: lanes[2], neg: lanes[3] };
    const control = kmAggregate(cs);
    const small = kmAggregate(lanes[0]), big31 = kmAggregate(lanes[1]), big32 = kmAggregate(lanes[2]), neg = kmAggregate(lanes[3]);
    if (!(control >= KM_CONTROL_MIN) || small !== small || big31 !== big31 || big32 !== big32 || neg !== neg) {
        return kmFail('blind', member, control, raw);
    }
    return { state: 'ok', member, control, small, big31, big32, neg, raw };
}

/** A key class reading above this (B/op) is a box: the control floor KM_CONTROL_MIN is 8, a HeapNumber 12-16. */
export const KM_CLEAN_MAX = 2;

/** The S11 readout class: 'v inband' ONLY when the result is ok AND every key class reads <= KM_CLEAN_MAX; an
 *  ok result with a boxing class is 'v outband' (a box is never shown green); absent / blind is neutral 'v'. */
export function keyMagClass(r) {
    if (r.state !== 'ok') return 'v';
    for (let c = 0; c < KM_CLASSES.length; c++) if (!(r[KM_CLASSES[c]] <= KM_CLEAN_MAX)) return 'v outband';
    return 'v inband';
}

/** The S11 readout text: "n/a (...)" for absent / blind -- never a bare 0 from a meter that cannot see. */
export function keyMagText(r) {
    if (r.state === 'absent') return 'n/a (no performance.memory: non-Chromium)';
    if (r.state === 'nowork') return 'n/a (a key window did no addFrom work: nothing was measured)';
    if (r.state === 'blind') {
        if (!(r.control >= KM_CONTROL_MIN)) return 'n/a (meter blind: the boxing control read ' + (r.control === r.control ? r.control.toFixed(1) : 'too few clean windows') + (r.control === r.control ? ' B/op < ' + KM_CONTROL_MIN : '') + ')';
        return 'n/a (meter blind: too few scavenge-free key-lane windows)';
    }
    // ok: every value is the second-largest of >= KM_MIN_CLEAN clean (non-negative) windows -- never clamped
    return 'small keys ' + r.small.toFixed(1) + ' B/op | [2^30, 2^31) keys ' + r.big31.toFixed(1)
        + ' B/op | >= 2^31 keys ' + r.big32.toFixed(1) + ' B/op | negative keys ' + r.neg.toFixed(1)
        + ' B/op (control ' + r.control.toFixed(1) + ')';
}
