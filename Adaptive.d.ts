/**
 * @zakkster/lite-adaptive -- ambient type surface.
 *
 * Hand-written to mirror EXACTLY the runtime exports of Adaptive.js. The three-place
 * version sync (package.json / Adaptive.js VERSION / llms.txt) is enforced in review;
 * this file only declares that `VERSION` exists. ASCII-only.
 *
 * @license MIT
 */

/** Package version string. */
export const VERSION: string;

/** The locked time mode of an ExponentialHistogram. */
export type ExponentialHistogramMode = 'unset' | 'explicit' | 'count';

/** Reserved constructor options for ExponentialHistogram (no keys yet; an unknown key throws). */
export interface ExponentialHistogramOptions {}

/**
 * ExponentialHistogram -- a zero-GC sliding-window COUNT / SUM summary (Datar-Gionis-
 * Indyk-Motwani, SODA 2002) over a preallocated pool of (timestamp, size) buckets grouped
 * by level, driven by a caller-supplied MONOTONE time source (the member never reads the
 * wall clock). `add` opens a bucket + runs the amortized merge cascade + expires the
 * window edge (0 B/op); `count()` / `sum()` return the windowed estimate within a HARD
 * relative error <= epsilon. DGIM (the 0/1 stream) is the value=1 special case.
 */
export class ExponentialHistogram {
    /**
     * @param W       window size; a finite number > 0 (items in count mode, or the
     *                `now`-unit span in explicit mode).
     * @param epsilon relative-error knob in (0, 1); smaller -> more buckets -> tighter error.
     * @param options reserved; an unknown key throws [lite-adaptive].
     * Throws [lite-adaptive] on a bad W / epsilon / option BEFORE the pool is allocated.
     */
    constructor(W: number, epsilon: number, options?: ExponentialHistogramOptions);

    /** The window size W. O(1). */
    readonly windowSize: number;

    /** The relative-error knob epsilon. O(1). */
    readonly epsilon: number;

    /** The live bucket count (<= capacity). O(1). */
    readonly bucketCount: number;

    /** The fixed pool capacity in buckets. O(1). */
    readonly capacity: number;

    /** The buckets-per-level bound k = ceil(1/(2*epsilon)) + 1. O(1). */
    readonly k: number;

    /** The number of size-class levels the pool can occupy. O(1). */
    readonly levels: number;

    /** The locked time mode: 'unset' before the first add, then 'explicit' or 'count'. O(1). */
    readonly mode: ExponentialHistogramMode;

    /**
     * Add one element. HOT, 0 B/op incl. the merge cascade + expire. The mode LOCKS at
     * the first call: pass `now` (a finite, non-decreasing number) for EXPLICIT mode, or
     * omit it for COUNT mode (the member auto-ticks). `value` defaults to 1 (the DGIM count
     * case) and must be a finite number > 0. Throws [lite-adaptive] on a mode switch, a
     * non-finite / decreasing `now`, or a non-positive value (a byte-identical no-op).
     */
    add(now?: number, value?: number): this;

    /**
     * Add one element from a caller-owned PACKED `[now, value]` Float64Array pair
     * (`buf[i]` = now, `buf[i+1]` = value). HOT, 0 B/op -- the ZERO-BOX entry for a caller
     * whose `now` AND `value` are both FRACTIONAL doubles (reads them UNBOXED, avoiding the
     * ~16 B HeapNumber per boxed argument at a non-inlined call boundary). EXPLICIT-time
     * only: a count-locked instance throws, the first addFrom locks EXPLICIT mode. Same
     * validation / throws / byte-identical-no-op-on-reject as `add(now, value)`. Throws
     * [lite-adaptive] on a non-Float64Array `buf` or a non-integer / out-of-range `i`.
     */
    addFrom(buf: Float64Array, i: number): this;

    /** The windowed COUNT (population) estimate over the last W. COLD, O(levels). Never throws. */
    count(): number;

    /** The windowed SUM (of values) estimate over the last W. COLD, O(buckets). Never throws. */
    sum(): number;

    /** The primary windowed estimate -- an alias of count(). COLD. Never throws. */
    query(): number;

    /** Reset to the empty window; reuse the pool (also unlocks the mode). */
    clear(): this;
}

/** Reserved constructor options for ADWIN (no keys yet; an unknown key throws). */
export interface ADWINOptions {}

/**
 * ADWIN -- ADaptive WINdowing (Bifet-Gavalda, SDM 2007): a zero-GC concept-drift detector
 * with NO fixed window size. It keeps the most-recent values in an exponential-histogram
 * bucket list (its OWN (sum, sumSq, count) columns -- design-parity with ExponentialHistogram,
 * a SEPARATE pool), grows the window while the stream is stationary, and SHRINKS it from the
 * old end when a mean shift is statistically significant (the ADWIN2 variance-aware cut).
 * ITEM-INDEXED: `add(x)` per item (no `now`); returns true iff a cut fired this add. The
 * false-alarm rate on a stationary stream is bounded by `delta`. `add` is 0 B/op INCLUDING
 * the cut-scan + the drop-older shrink; `mean` / `variance` / `width` are O(1) getters.
 */
export class ADWIN {
    /**
     * @param delta   confidence knob in (0, 1); the stationary false-alarm rate is bounded by
     *                delta. Smaller -> fewer false alarms, longer detection latency.
     * @param options reserved; an unknown key throws [lite-adaptive].
     * Throws [lite-adaptive] on a bad delta / option BEFORE the pool is allocated.
     */
    constructor(delta: number, options?: ADWINOptions);

    /** The confidence knob delta. O(1). */
    readonly delta: number;

    /** The current adaptive window size in items. O(1). */
    readonly width: number;

    /** The live bucket count (<= capacity). O(1). */
    readonly bucketCount: number;

    /** The fixed pool capacity in buckets. O(1). */
    readonly capacity: number;

    /** The mean over the current window (0 on an empty window). O(1). Never throws. */
    readonly mean: number;

    /** The variance over the current window (0 on an empty window, FP-clamped >= 0). O(1). Never throws. */
    readonly variance: number;

    /**
     * Add one finite value to the window. HOT, 0 B/op incl. the merge cascade, the cut-scan,
     * and the drop-older shrink. Returns true iff a cut fired (drift detected) this add.
     * Throws [lite-adaptive] on a non-number / NaN / +-Infinity x (a byte-identical no-op).
     */
    add(x: number): boolean;

    /**
     * Add one finite value read UNBOXED from a caller-owned Float64Array (`x = buf[i]`). HOT,
     * 0 B/op -- the ZERO-BOX sibling of `add(x)` for a caller whose fractional `x` (e.g. a
     * HUD-computed duration) would box as a plain argument at a non-inlined call boundary.
     * Runs the identical drift-detection logic and returns the same boolean drift flag. Throws
     * [lite-adaptive] on a non-Float64Array `buf` or a non-integer / out-of-range `i`; a
     * non-finite `x` at `buf[i]` is a byte-identical no-op.
     */
    addFrom(buf: Float64Array, i: number): boolean;

    /** Reset to the empty window; reuse the pool. */
    clear(): this;
}

/** The locked time mode of a ForwardDecay. */
export type ForwardDecayMode = 'unset' | 'explicit' | 'count';

/** Reserved constructor options for ForwardDecay (no keys yet; an unknown key throws). */
export interface ForwardDecayOptions {}

/**
 * ForwardDecay -- a zero-GC, O(1)-space time-decayed COUNT / SUM / MEAN / RATE summary
 * (Cormode-Shkapenyuk-Srivastava-Xu, ICDE 2009). Each element's weight decays exponentially
 * with its age (halves every `halfLife` time units), measured FORWARD from a fixed landmark,
 * so weights are computed once at insert and never revised. Two scalar accumulators are
 * maintained incrementally; a periodic alloc-free landmark rebase keeps them finite while
 * the decayed aggregate stays EXACT modulo floating point. Driven by a caller-supplied
 * MONOTONE `now` (or count mode when omitted); accepts ANY finite real value (signed). `add`
 * is 0 B/op INCLUDING the rebase branch; `count` / `sum` / `mean` / `rate` are O(1) queries.
 */
export class ForwardDecay {
    /**
     * @param halfLife the decay half-life; a finite number > 0 (weight halves over this span).
     * @param options  reserved; an unknown key throws [lite-adaptive].
     * Throws [lite-adaptive] on a bad halfLife / option BEFORE any field init.
     */
    constructor(halfLife: number, options?: ForwardDecayOptions);

    /** The decay half-life (weight halves every halfLife time units). O(1). */
    readonly halfLife: number;

    /** The decay rate lambda = ln2 / halfLife. O(1). */
    readonly lambda: number;

    /** The current landmark time L (weights are measured forward from here). O(1). */
    readonly landmark: number;

    /** The locked time mode: 'unset' before the first add, then 'explicit' or 'count'. O(1). */
    readonly mode: ForwardDecayMode;

    /**
     * Add one element. HOT, 0 B/op incl. the landmark rebase. The mode LOCKS at the first
     * call: pass `now` (a finite, non-decreasing number) for EXPLICIT mode, or omit it for
     * COUNT mode (the member auto-ticks). `value` defaults to 1 and may be ANY finite real
     * (signed: it contributes to the decayed sum / mean but counts as one decayed event).
     * Throws [lite-adaptive] on a mode switch, a non-finite / decreasing `now`, or a
     * non-finite / non-number value (a byte-identical no-op).
     */
    add(now?: number, value?: number): this;

    /**
     * Add one element from a caller-owned PACKED `[now, value]` Float64Array pair
     * (`buf[i]` = now, `buf[i+1]` = value). HOT, 0 B/op -- the ZERO-BOX entry for a caller
     * whose `now` AND `value` are both FRACTIONAL doubles (reads them UNBOXED, avoiding the
     * ~16 B HeapNumber per boxed argument at a non-inlined call boundary; the lite-hud
     * decayed-stats idiom). EXPLICIT-time only: a count-locked instance throws, the first
     * addFrom locks EXPLICIT mode. Same validation / throws / byte-identical-no-op-on-reject
     * as `add(now, value)`. Throws [lite-adaptive] on a non-Float64Array `buf` or a
     * non-integer / out-of-range `i`.
     */
    addFrom(buf: Float64Array, i: number): this;

    /** The decayed COUNT at `now` (defaults to the last add time). COLD, O(1). Never throws on empty. */
    count(now?: number): number;

    /** The decayed weighted SUM at `now` (defaults to the last add time). COLD, O(1). Never throws on empty. */
    sum(now?: number): number;

    /** The decayed MEAN (Sv / C; landmark- and now-invariant). COLD, O(1). Never throws on empty. */
    mean(now?: number): number;

    /** The decayed RATE at `now` -- decayedCount(now) * lambda (a definition). COLD, O(1). */
    rate(now?: number): number;

    /** Reset to empty; keep halfLife / lambda, unlock the mode. */
    clear(): this;
}

/**
 * Constructor options for HeavyKeeper. `seed=0` is a valid distinct seed (guarded as
 * `undefined`, not falsy); an unknown key throws [lite-adaptive].
 */
export interface HeavyKeeperOptions {
    /** The uint32 seed for the decay PRNG (default 0x9e3779b1). seed=0 is valid. */
    seed?: number;
    /** The decay base b; a finite number > 1 (default 1.08). A fingerprint miss decays with prob b^(-count). */
    b?: number;
}

/** One leader returned by HeavyKeeper.topK(): the key and its estimated total. */
export interface HeavyKeeperEntry {
    key: number;
    count: number;
}

/**
 * HeavyKeeper -- a zero-GC decayed / windowed TOP-K (heavy hitters "right now"; Gong et al.,
 * USENIX ATC 2018). A d x w table of (fingerprint, count) cells (SoA Uint32Array columns) plus
 * an intrusive top-k min-forest (design-parity with lite-o1 FreqO1, never a dependency).
 * `add(key, weight)` hashes the key to one cell per row via an inline two-lane hash: a matching
 * fingerprint adds the weight, a colliding one is probabilistically decayed (prob b^(-count),
 * a seeded xorshift32 draw) and evicted at count 0 -- so cold keys erode and the top-k tracks
 * the CURRENT concept. Amortized O(1), 0 B/op incl. the decay draw + the forest sift. Far lower
 * error than Space-Saving on skewed / evolving streams. No `merge` (it decays natively).
 */
export class HeavyKeeper {
    /**
     * @param d       table depth (rows / independent hashes); an integer in [1, 64]. d ~ 4-8.
     * @param w       table width (cells per row); an integer >= 1. More cells -> fewer collisions.
     * @param k       the top-k size; an integer >= 1.
     * @param options { seed?, b? }; an unknown key throws [lite-adaptive].
     * Throws [lite-adaptive] on a bad d / w / k / seed / b / option BEFORE any allocation.
     */
    constructor(d: number, w: number, k: number, options?: HeavyKeeperOptions);

    /**
     * Derive a HeavyKeeper from a target top-k size and a target relative error (sets d = 4 and
     * w = max(2k, ceil(1/targetError))). Throws [lite-adaptive] typeof-first on a bad k /
     * targetError / option BEFORE any allocation.
     */
    static withAccuracy(k: number, targetError: number, options?: HeavyKeeperOptions): HeavyKeeper;

    /** The table depth d (rows). O(1). */
    readonly d: number;

    /** The table width w (cells per row). O(1). */
    readonly w: number;

    /** The top-k size k. O(1). */
    readonly k: number;

    /** The decay base b. O(1). */
    readonly b: number;

    /** The uint32 PRNG seed. O(1). */
    readonly seed: number;

    /** The fixed memory figure in bytes (table + heap + map + LUT). O(1). */
    readonly bytes: number;

    /** The live top-k size (<= k). O(1). */
    readonly size: number;

    /**
     * Add `weight` occurrences of `key`. HOT, amortized O(1), 0 B/op incl. the decay draw + the
     * forest sift. `key` must be a SAFE INTEGER; `weight` a positive integer (default 1 -- rank
     * by count, or by total time / bytes / any additive weight). Throws [lite-adaptive] on a
     * non-safe-integer key or a non-positive-integer weight (a byte-identical no-op).
     */
    add(key: number, weight?: number): this;

    /**
     * Add one (key, weight) pair read UNBOXED from a caller-owned PACKED Float64Array
     * (`key = buf[i]`, `weight = buf[i+1]`). HOT, 0 B/op -- the ZERO-BOX entry that avoids the
     * ~16 B HeapNumber a large u32 key (>= 2^31) boxes as a plain argument. Same validation /
     * byte-identical-no-op-on-reject as `add`. Throws [lite-adaptive] on a non-Float64Array
     * `buf` or a non-integer / out-of-range `i`.
     */
    addFrom(buf: Float64Array, i: number): this;

    /**
     * The estimated total for `key` (the max matching cell; 0 for an unseen but VALID key). COLD.
     * Fail closed: a non-safe-integer key throws [lite-adaptive] (parity with `add`).
     */
    estimate(key: number): number;

    /** Iterate the current top-k allocation-free: `fn(key, estimate)` per leader. The render path. */
    forEach(fn: (key: number, estimate: number) => void): void;

    /**
     * Write the current top-k into `buf` as packed [key, estimate] PAIRS (2 Float64 slots per
     * entry: buf[2i] = key, buf[2i+1] = estimate) and return the ENTRY COUNT written (<= k),
     * NOT sorted. 0-alloc. `buf` must be a Float64Array of length >= 2*k (a Float64Array is
     * required: estimates and large u32 keys need it) -- a smaller buffer throws [lite-adaptive].
     */
    topKInto(buf: Float64Array): number;

    /** The current top-k as an array of { key, count }. COLD -- MAY allocate (not the render path). */
    topK(): HeavyKeeperEntry[];

    /** Reset to empty; reuse the table + forest arrays (0-alloc). */
    clear(): this;
}

/** The locked time mode of a SlidingHyperLogLog. */
export type SlidingHyperLogLogMode = 'unset' | 'explicit' | 'count';

/**
 * Constructor options for SlidingHyperLogLog. `seed=0` is a valid distinct seed (guarded as
 * `undefined`, not falsy); an unknown key throws [lite-adaptive].
 */
export interface SlidingHyperLogLogOptions {
    /** Precision p; an integer in [4, 16] (default 10). m = 1 << p registers. */
    p?: number;
    /** Per-register LFPM ring capacity; a power of two in [2, 64] (default 8). Set >= q+1 to make overflow impossible. */
    ringCap?: number;
    /** The uint32 hash seed (default 0x9e3779b1). seed=0 is valid. */
    seed?: number;
}

/**
 * SlidingHyperLogLog -- a zero-GC WINDOWED distinct-count (Chabchoub-Hebrail, 2010): how many
 * DISTINCT keys arrived in the LAST W, in FIXED preallocated space at HLL accuracy (the RECENCY
 * sibling of lite-sketch's cumulative HyperLogLog). An `m = 2^p` register bank where each register
 * keeps a small FIXED LFPM ring of `(timestamp, rho)` entries (a monotonic deque, strictly
 * decreasing rho). `add(now, key)` / the zero-box `addFrom(buf, i)` drop dominated tail entries and
 * append (0 B/op incl. the windowed eviction); a full ring bumps `overflows` (the honest-
 * degradation signal `degraded`). `count(w?)` lazily expires the window edge and runs Ertl's
 * improved estimator; the standard error is 1.04 / sqrt(m), guaranteed while `degraded === false`.
 * Driven by a caller-supplied MONOTONE `now` (or count mode when omitted); the mode locks at the
 * first add. Fully deterministic given the seed (no PRNG).
 */
export class SlidingHyperLogLog {
    /**
     * @param W       window size; a finite number > 0 (items in count mode, or the `now`-unit span
     *                in explicit mode).
     * @param options { p?, ringCap?, seed? }; an unknown key throws [lite-adaptive].
     * Throws [lite-adaptive] on a bad W / p / ringCap / seed / option BEFORE any allocation.
     */
    constructor(W: number, options?: SlidingHyperLogLogOptions);

    /** The window size W. O(1). */
    readonly W: number;

    /** The precision p. O(1). */
    readonly p: number;

    /** The register count m = 2^p. O(1). */
    readonly m: number;

    /** The per-register LFPM ring capacity. O(1). */
    readonly ringCap: number;

    /** The uint32 hash seed. O(1). */
    readonly seed: number;

    /** The theoretical standard error 1.04 / sqrt(m) (guaranteed only while not degraded). O(1). */
    readonly standardError: number;

    /** The last applied time t (0 before the first add). O(1). */
    readonly lastNow: number;

    /** The locked time mode: 'unset' before the first add, then 'explicit' or 'count'. O(1). */
    readonly mode: SlidingHyperLogLogMode;

    /** The number of ring overflows so far (any > 0 -> the accuracy bound is no longer guaranteed). O(1). */
    readonly overflows: number;

    /** True once a ring overflowed (the 1.04/sqrt(m) bound is no longer guaranteed). O(1). */
    readonly degraded: boolean;

    /** A fixed memory figure in bytes (stamps + rho + head + len + hist). O(1). */
    readonly bytes: number;

    /**
     * Add one element `key` observed at `now`. HOT, 0 B/op incl. the windowed eviction. The mode
     * LOCKS at the first call: pass `now` (a finite, non-decreasing number) for EXPLICIT mode, or
     * omit it (`add(undefined, key)`) for COUNT mode (the member auto-ticks; W is then in items).
     * `key` must be a SAFE INTEGER. Throws [lite-adaptive] on a non-safe-integer key, a mode
     * switch, or a non-finite / decreasing `now` (a byte-identical no-op).
     */
    add(now: number | undefined, key: number): this;

    /**
     * Add one element from a caller-owned PACKED `[now, key]` Float64Array pair (`buf[i]` = now,
     * `buf[i+1]` = key). HOT, 0 B/op -- the ZERO-BOX entry for a caller whose `now` is a fractional
     * / epoch-ms double and whose `key` may exceed 2^31 (reads them UNBOXED, avoiding the ~16 B
     * HeapNumber per boxed argument at a non-inlined call boundary). EXPLICIT-time only: a
     * count-locked instance throws, the first addFrom locks EXPLICIT mode. Same validation /
     * byte-identical-no-op-on-reject as `add`. Throws [lite-adaptive] on a non-Float64Array `buf`
     * or a non-integer / out-of-range `i`.
     */
    addFrom(buf: Float64Array, i: number): this;

    /**
     * The windowed DISTINCT-COUNT estimate over the last W (or a sub-window `w <= W`). COLD, O(m).
     * Standard error 1.04 / sqrt(m) (guaranteed while not degraded). Returns 0 on an empty window.
     * Throws [lite-adaptive] on a sub-window `w` outside `(0, W]`.
     */
    count(w?: number): number;

    /** The primary windowed estimate -- an alias of count() over the full window W. COLD. Never throws. */
    query(): number;

    /** Reset to the empty window; reuse the arrays (also unlocks the mode). */
    clear(): this;
}
