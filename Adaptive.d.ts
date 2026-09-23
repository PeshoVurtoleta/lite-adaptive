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
