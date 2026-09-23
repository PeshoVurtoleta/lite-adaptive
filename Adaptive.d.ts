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
