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
