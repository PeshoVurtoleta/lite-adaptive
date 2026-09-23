/**
 * @zakkster/lite-adaptive -- a zero-GC, zero-runtime-dependency, single-file ESM
 * family of APPROXIMATE, sublinear-space streaming SUMMARIES over the TIME / RECENCY
 * axis: one small structure per question you can only answer about the RECENT or
 * CHANGING stream (sliding-window count / sum, drift, decay), never the whole of it.
 * It witnesses its RECENCY -- MEASURED windowed error vs the paper's THEORETICAL
 * bound -- while allocating ZERO bytes on every hot op INCLUDING the amortized
 * bucket merge / expire reshaping (the lite-o1 zero-GC discipline, carried into the
 * time-adaptive world).
 *
 * v0.1.0 ships the reference member -- ExponentialHistogram (Datar-Gionis-Indyk-
 * Motwani, SODA 2002): sliding-window count / sum over the last W in FIXED memory,
 * via a preallocated pool of (timestamp, size) buckets grouped by level, over a
 * caller-supplied MONOTONE time source (the member never reads the wall clock).
 * DGIM (the 0/1 stream) is its value=1 special case.
 *
 * v0.2.0 adds ADWIN (Bifet-Gavalda, SDM 2007): concept-drift detection + adaptive
 * windowing over its OWN variance-carrying (sum, sumSq, count) bucket columns
 * (design-parity with the EH substrate, a SEPARATE pool, not a shared one).
 * `add(x) -> boolean` grows the window while the stream is stable and SHRINKS it on a
 * detected mean shift (the ADWIN2 variance-aware cut), 0 B/op incl. the cut-scan +
 * drop-older shrink.
 *
 * v0.3.0 adds ForwardDecay (Cormode-Shkapenyuk-Srivastava-Xu, ICDE 2009): time-decayed
 * COUNT / SUM / MEAN / RATE where an element's weight halves every `halfLife` time units,
 * measured FORWARD from a fixed landmark (weights computed once at insert, never revised
 * -- the numeric-stability edge over backward decay). O(1) SPACE (two scalar accumulators
 * C, Sv -- no pool), EXACT modulo FP via a periodic alloc-free landmark rebase, and a
 * SMOOTH recency model (data fades, never drops). `add(now?, value?)` is 0 B/op INCLUDING
 * the rebase branch; values may be any finite real (signed). The last roster member
 * (HeavyKeeper, decayed top-k) is PURE-APPENDED below; prior members stay byte-identical,
 * only this header + VERSION change.
 *
 * ASCII-only source (no Unicode; the two exceptions the suite allows are unused
 * here). Zero runtime deps; node:test only.
 *
 * @license MIT
 */

/** Package version. One of the three version sites (package.json / VERSION / llms.txt). */
export const VERSION = '0.3.0';

// ===========================================================================
// The time source + the fixed bucket pool substrate (ADR 0001 -- LOCKED)
// ===========================================================================
//
// TIME SOURCE: a caller-supplied, MONOTONE (strictly non-decreasing) `now` -- a
// logical tick or ms; the member NEVER reads the wall clock (untestable, non-
// deterministic). add(now) / add(now, value) locks EXPLICIT mode at the first add;
// omitting `now` (add() / add(undefined, value)) locks COUNT mode, where the member
// auto-increments an internal tick per add (the "last N items" convenience). The
// mode is fixed at the first add and a later switch throws [lite-adaptive].
//
// BUCKET POOL: a FIXED, preallocated pool of buckets over parallel TypedArray
// columns (SoA) + a free-list, grouped into LEVELS by size. NO per-op allocation:
// add / expire / the merge cascade are pure index manipulations. The pool is sized
// to the theoretical bucket bound at construction and NEVER grows.

/** Mode sentinels: 0 = unlocked (no add yet), 1 = explicit-now, 2 = count. */
const MODE_UNSET = 0;
const MODE_EXPLICIT = 1;
const MODE_COUNT = 2;

/** Frozen marker of the known ctor option keys -- an unknown key is a throw with a did-you-mean. */
const EH_KNOWN_OPTS = Object.freeze(Object.create(null));

// ===========================================================================
// ExponentialHistogram (ADR 0002) -- the reference member (sliding-window count / sum)
// ===========================================================================

/**
 * ExponentialHistogram -- count / sum over the LAST W (a hard sliding window) in
 * FIXED memory. A preallocated pool of (timestamp, size) buckets grouped by LEVEL:
 * a level-L bucket holds exactly `2^L` elements (its POPULATION), and its `size` is
 * the sum of the values of those elements (= population when value=1). `add` opens a
 * level-0 bucket (population 1, size = value); when MORE THAN `k` buckets share a
 * level the two OLDEST merge into one bucket of the next level (a bounded cascade,
 * amortized O(1)); buckets whose timestamp fell out of `[now - W, now]` expire.
 *
 * Headline (space, error, recency model) -- the family TRIPLE:
 *   - SPACE: O((1/epsilon) log(epsilon W)) buckets -- a FIXED pool, never grows.
 *   - ERROR: windowed count/sum relative error <= epsilon (HARD), by the merge rule
 *     `k = ceil(1/(2 epsilon)) + 1`: the oldest (straddling) bucket, the only source
 *     of error, holds at most ~ (1/(2k)) of the window, so estimating half of it is
 *     within epsilon.
 *   - RECENCY: a HARD last-W window (EH forgets EXACTLY at the window edge -- vs
 *     ForwardDecay's smooth decay or ADWIN's adaptive window).
 *
 * Hot path (`add`, 0 B/op incl. reshaping): a monotone-`now` guard, one free-list
 * pop for the new bucket, the bounded merge cascade (each merge frees one slot and
 * reuses one), and the expire sweep (frees the globally-oldest buckets). Every step
 * is an index manipulation on the preallocated columns -- no objects, no closures.
 *
 * Cold path: `query()` / `count()` are O(numLevels), `sum()` is O(buckets) -- the
 * standard EH estimate (all live buckets minus half the oldest straddling one), a
 * disclosed co-headline, NOT a per-add cost. `clear()` reuses the pool.
 *
 * Fail closed: a bad W / epsilon / option throws `[lite-adaptive]` at the ctor door
 * BEFORE any allocation (no half-built instance); `add` locks the mode at the first
 * call and rejects a mode switch, a non-finite `now`, a `now` going backwards, or a
 * non-positive value -- typeof-first, BYTE-IDENTICAL no-op; `query` / `count` / `sum`
 * / getters never throw. null is not zero.
 */
export class ExponentialHistogram {
    /**
     * @param {number} W        window size; a finite number > 0 (items in count mode,
     *                          or the `now`-unit span in explicit mode).
     * @param {number} epsilon  relative-error knob; a number in (0, 1). Smaller ->
     *                          more buckets -> tighter windowed error.
     * @param {object} [options] reserved; an unknown key throws [lite-adaptive].
     */
    constructor(W, epsilon, options) {
        // typeof guard FIRST, BEFORE any allocation.
        if (typeof W !== 'number' || W !== W || W === Infinity || W === -Infinity || W <= 0) {
            throw new RangeError(
                '[lite-adaptive] ExponentialHistogram W must be a finite number > 0, got ' + String(W));
        }
        if (typeof epsilon !== 'number' || epsilon !== epsilon || epsilon <= 0 || epsilon >= 1) {
            throw new RangeError(
                '[lite-adaptive] ExponentialHistogram epsilon must be a number in (0, 1), got ' + String(epsilon));
        }
        if (options !== undefined) {
            if (typeof options !== 'object' || options === null) {
                throw new TypeError('[lite-adaptive] ExponentialHistogram options must be an object');
            }
            for (const key in options) {
                if (!(key in EH_KNOWN_OPTS)) {
                    throw new RangeError('[lite-adaptive] ExponentialHistogram unknown option "' + key + '"');
                }
            }
        }
        // k = ceil(1/(2 epsilon)) + 1 -- at most k buckets per level; the two oldest
        // merge on the (k+1)-th, so each level below the top stays in [k-1, k+1].
        const k = Math.ceil(1 / (2 * epsilon)) + 1;
        // LEVELS = ceil(log2(W / (k+1))) + 2 -- the number of size classes the pool can
        // ever occupy (a level-L bucket holds 2^L elements; the top level is reached
        // when the lower levels are full). Floored at 2 so the first cascade always fits.
        const levels = Math.max(2, Math.ceil(Math.log2(W / (k + 1))) + 2);
        // CAP = (k+1)*LEVELS + 2 -- (k+1) per level covers the transient (k+1)-th bucket
        // before its merge; the +2 covers the freshly-opened level-0 bucket during a
        // full cascade plus one slack slot. The pool never grows past CAP.
        const cap = (k + 1) * levels + 2;

        this._W = W;
        this._epsilon = epsilon;
        this._k = k;
        this._levels = levels;
        this._cap = cap;

        // SoA columns (parallel, index 0..cap-1):
        this._ts = new Float64Array(cap);     // bucket timestamp = most-recent element time
        this._start = new Float64Array(cap);  // earliest-element time (to detect straddle exactly)
        this._size = new Float64Array(cap);   // bucket size = sum of the values in the bucket
        this._next = new Int32Array(cap);     // intra-level next (toward newer) OR free-list link
        this._prev = new Int32Array(cap);     // intra-level prev (toward older)
        this._lvl = new Int32Array(cap);      // the level of each bucket (0..levels-1)

        // Per-level intrusive doubly-linked lists (oldest -> newest):
        this._head = new Int32Array(levels);  // oldest bucket index at level L, -1 if empty
        this._tail = new Int32Array(levels);  // newest bucket index at level L, -1 if empty
        this._lcount = new Int32Array(levels); // number of buckets at level L

        // Powers of two per level (cold-path population lookup, precomputed alloc-free).
        this._pow = new Float64Array(levels);
        for (let i = 0; i < levels; i++) this._pow[i] = Math.pow(2, i);

        this._initState();
    }

    /** @private Reset the free-list + list heads to the empty pool. Reused by clear(). 0 alloc. */
    _initState() {
        const cap = this._cap;
        const levels = this._levels;
        // Chain every slot into the free-list: 0 -> 1 -> ... -> cap-1 -> -1.
        const nxt = this._next;
        for (let i = 0; i < cap - 1; i++) nxt[i] = i + 1;
        nxt[cap - 1] = -1;
        this._freeHead = 0;
        for (let L = 0; L < levels; L++) {
            this._head[L] = -1;
            this._tail[L] = -1;
            this._lcount[L] = 0;
        }
        this._maxLevel = -1;    // highest occupied level, -1 when empty
        this._count = 0;        // live bucket count
        this._mode = MODE_UNSET;
        this._tick = 0;         // count-mode logical clock
        this._lastNow = -Infinity; // explicit-mode monotone guard
        this._now = 0;          // the last applied t (for the query cutoff = now - W)
    }

    /** Window size W. O(1). */
    get windowSize() { return this._W; }
    /** The relative-error knob epsilon. O(1). */
    get epsilon() { return this._epsilon; }
    /** Live bucket count (<= capacity). O(1). */
    get bucketCount() { return this._count; }
    /** The fixed pool capacity in buckets. O(1). */
    get capacity() { return this._cap; }
    /** Buckets-per-level bound k = ceil(1/(2 epsilon)) + 1. O(1). */
    get k() { return this._k; }
    /** The number of size-class levels the pool can occupy. O(1). */
    get levels() { return this._levels; }
    /** The locked time mode: 'unset' | 'explicit' | 'count'. O(1). */
    get mode() {
        return this._mode === MODE_EXPLICIT ? 'explicit' : this._mode === MODE_COUNT ? 'count' : 'unset';
    }

    /**
     * Add one element to the window. HOT, 0 B/op INCLUDING the merge cascade + expire.
     *
     * Time modes (LOCKED at the first add, a switch throws):
     *   - EXPLICIT: add(now) / add(now, value). `now` is a finite number, strictly
     *     NON-DECREASING across calls (a decrease throws [lite-adaptive]).
     *   - COUNT: add() / add(undefined, value). The member auto-increments an internal
     *     tick per add (the "last N items" convenience).
     *
     * `value` (both modes) defaults to 1 (the DGIM count case); a supplied value must
     * be a finite number > 0 (it is the element's contribution to the windowed SUM).
     *
     * Fail closed: a mode switch, a non-finite `now`, a `now` going backwards, or a
     * non-positive/non-finite value throws [lite-adaptive] (typeof-first, BYTE-
     * IDENTICAL no-op -- nothing is opened on a rejected add).
     * @param {number} [now]   the monotone time (omit for count mode).
     * @param {number} [value] the element's value (default 1).
     * @returns {ExponentialHistogram} this
     */
    add(now, value) {
        // --- resolve + validate the value FIRST, before ANY state mutation, so every
        // rejected add is a BYTE-IDENTICAL no-op (does not lock the mode, consume a count
        // tick, or advance the monotone guard). typeof-first, no alloc. ---
        let v = value;
        if (v === undefined) {
            v = 1;
        } else if (typeof v !== 'number' || v !== v || v === Infinity || v <= 0) {
            return this._badValue(v);
        }
        // --- resolve the timestamp + lock/verify the mode (typeof-first, no alloc) ---
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            if (now !== undefined) return this._badMode('count', 'explicit');
            t = ++this._tick;
        } else if (mode === MODE_EXPLICIT) {
            if (now === undefined) return this._badMode('explicit', 'count');
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badNow(now);
            }
            if (now < this._lastNow) return this._badMonotone(now);
            t = now;
            this._lastNow = now;
        } else {
            // first add: lock the mode
            if (now === undefined) {
                this._mode = MODE_COUNT;
                t = ++this._tick;
            } else {
                if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                    return this._badNow(now);
                }
                this._mode = MODE_EXPLICIT;
                t = now;
                this._lastNow = now;
            }
        }
        this._now = t;

        // --- expire buckets that fell out of [t - W, t] (oldest first) ---
        const cutoff = t - this._W;
        const ts = this._ts;
        while (this._count > 0) {
            const L = this._maxLevel;
            const b = this._head[L];
            if (ts[b] > cutoff) break;   // globally-oldest still in-window -> nothing to expire
            // detach the head of level L
            const after = this._next[b];
            this._head[L] = after;
            if (after === -1) this._tail[L] = -1; else this._prev[after] = -1;
            this._lcount[L]--;
            this._count--;
            // free b
            this._next[b] = this._freeHead;
            this._freeHead = b;
            if (this._head[L] === -1) {
                // level L emptied -> drop maxLevel to the next occupied level
                let m = L;
                while (m >= 0 && this._head[m] === -1) m--;
                this._maxLevel = m;
            }
        }

        // --- open a fresh level-0 bucket (population 1, size v) at the newest end ---
        const node = this._freeHead;
        // free-list exhaustion is impossible if CAP is correct; fail closed if not.
        if (node === -1) return this._badOverflow();
        this._freeHead = this._next[node];
        this._ts[node] = t;
        this._start[node] = t;
        this._size[node] = v;
        this._lvl[node] = 0;
        // append at tail of level 0
        const tail0 = this._tail[0];
        this._prev[node] = tail0;
        this._next[node] = -1;
        if (tail0 === -1) this._head[0] = node; else this._next[tail0] = node;
        this._tail[0] = node;
        this._lcount[0]++;
        this._count++;
        if (this._maxLevel < 0) this._maxLevel = 0;

        // --- the bounded merge cascade: while a level has > k buckets, merge its two
        //     OLDEST into one bucket of the next level (reuse a slot, free the other) ---
        const k = this._k;
        let L = 0;
        while (this._lcount[L] > k) {
            const a = this._head[L];          // oldest at level L
            const b2 = this._next[a];         // second-oldest (newer than a)
            // detach a and b2 (the two oldest) from level L
            const after = this._next[b2];
            this._head[L] = after;
            if (after === -1) this._tail[L] = -1; else this._prev[after] = -1;
            this._lcount[L] -= 2;
            // reuse slot `a` as the merged bucket: size += b2.size, ts = the more-recent one
            this._size[a] += this._size[b2];
            this._ts[a] = this._ts[b2];       // most-recent element of the merged bucket
            const nl = L + 1;
            this._lvl[a] = nl;
            // free b2
            this._next[b2] = this._freeHead;
            this._freeHead = b2;
            this._count--;                    // two out, one back in -> net -1
            // append the merged bucket at the tail (newest) of level L+1
            const tnl = this._tail[nl];
            this._prev[a] = tnl;
            this._next[a] = -1;
            if (tnl === -1) this._head[nl] = a; else this._next[tnl] = a;
            this._tail[nl] = a;
            this._lcount[nl]++;
            if (nl > this._maxLevel) this._maxLevel = nl;
            L = nl;
        }
        return this;
    }

    /**
     * Add one element from a caller-owned PACKED `[now, value]` Float64Array pair. HOT,
     * 0 B/op -- the ZERO-BOX entry for a caller whose `now` AND `value` are both FRACTIONAL
     * doubles (e.g. lite-hud's per-channel time-window sum/mean/rate: `now` is a fractional
     * record time it computes itself, `value` a fractional ms stat). `add(now, value)` boxes
     * each fractional argument into a ~16 B HeapNumber at a non-inlined call boundary; this
     * reads `now = buf[i]` / `value = buf[i + 1]` UNBOXED straight from the array. The caller
     * writes a `Float64Array(2)` scratch and calls `addFrom(scratch, 0)` (a batch steps `i`
     * by 2). Identical validation, throws, byte-identical-no-op-on-reject, and reshaping as
     * `add(now, value)`; it differs ONLY in how the two scalars cross the boundary.
     *
     * EXPLICIT-time ONLY: addFrom always carries a `now`, so a COUNT-locked instance rejects
     * it (the way `add(now)` rejects a count-locked instance) and the first addFrom locks
     * EXPLICIT mode. The value is validated FIRST (mirroring `add`), then the mode, then the
     * monotone `now` -- all BEFORE any state mutation, so a rejected addFrom is a byte-
     * identical no-op. The accumulate body is DUPLICATED from `add` (not delegated) to keep
     * `add`'s hot body byte-identical and avoid re-boxing at an internal call boundary.
     *
     * Fail closed BEFORE any read (typeof-first): a non-Float64Array `buf`, or a non-integer /
     * negative / out-of-range `i` (needs `i + 1 < buf.length`) throws [lite-adaptive].
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = now, `buf[i+1]` = value.
     * @param {number} i the base index of the [now, value] pair (0, 2, 4, ...).
     * @returns {ExponentialHistogram} this
     */
    addFrom(buf, i) {
        // Guard the buffer + index on the COLD branch first (a bad handle is a byte-identical no-op).
        if (!(buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || i + 1 >= buf.length) return this._badBuf(buf, i);
        const now = buf[i];       // UNBOXED Float64Array reads -- the whole point (no argument box).
        const v = buf[i + 1];     // packed [now, value]
        // --- validate the value FIRST (mirror add(); a Float64Array read is always a number,
        // so add()'s typeof branch is unreachable here and omitted). BYTE-IDENTICAL no-op. ---
        if (v !== v || v === Infinity || v <= 0) return this._badValue(v);
        // --- addFrom is an EXPLICIT-time entry: reject a count-locked instance, else lock/verify
        // EXPLICIT + the monotone `now` (typeof-first, no alloc). ---
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (now !== now || now === Infinity || now === -Infinity) return this._badNow(now);
            if (now < this._lastNow) return this._badMonotone(now);
            t = now;
            this._lastNow = now;
        } else {
            if (now !== now || now === Infinity || now === -Infinity) return this._badNow(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
        }
        this._now = t;

        // --- expire buckets that fell out of [t - W, t] (oldest first) -- DUPLICATED from add()
        //     to keep add()'s hot body byte-identical and avoid a boxing call boundary. ---
        const cutoff = t - this._W;
        const ts = this._ts;
        while (this._count > 0) {
            const L = this._maxLevel;
            const b = this._head[L];
            if (ts[b] > cutoff) break;   // globally-oldest still in-window -> nothing to expire
            const after = this._next[b];
            this._head[L] = after;
            if (after === -1) this._tail[L] = -1; else this._prev[after] = -1;
            this._lcount[L]--;
            this._count--;
            this._next[b] = this._freeHead;
            this._freeHead = b;
            if (this._head[L] === -1) {
                let m = L;
                while (m >= 0 && this._head[m] === -1) m--;
                this._maxLevel = m;
            }
        }

        // --- open a fresh level-0 bucket (population 1, size v) at the newest end ---
        const node = this._freeHead;
        if (node === -1) return this._badOverflow();
        this._freeHead = this._next[node];
        this._ts[node] = t;
        this._start[node] = t;
        this._size[node] = v;
        this._lvl[node] = 0;
        const tail0 = this._tail[0];
        this._prev[node] = tail0;
        this._next[node] = -1;
        if (tail0 === -1) this._head[0] = node; else this._next[tail0] = node;
        this._tail[0] = node;
        this._lcount[0]++;
        this._count++;
        if (this._maxLevel < 0) this._maxLevel = 0;

        // --- the bounded merge cascade (see add() for the full commentary) ---
        const k = this._k;
        let L = 0;
        while (this._lcount[L] > k) {
            const a = this._head[L];
            const b2 = this._next[a];
            const after = this._next[b2];
            this._head[L] = after;
            if (after === -1) this._tail[L] = -1; else this._prev[after] = -1;
            this._lcount[L] -= 2;
            this._size[a] += this._size[b2];
            this._ts[a] = this._ts[b2];
            const nl = L + 1;
            this._lvl[a] = nl;
            this._next[b2] = this._freeHead;
            this._freeHead = b2;
            this._count--;
            const tnl = this._tail[nl];
            this._prev[a] = tnl;
            this._next[a] = -1;
            if (tnl === -1) this._head[nl] = a; else this._next[tnl] = a;
            this._tail[nl] = a;
            this._lcount[nl]++;
            if (nl > this._maxLevel) this._maxLevel = nl;
            L = nl;
        }
        return this;
    }

    /**
     * The windowed COUNT (population) estimate: the number of elements in the last W.
     * The standard EH estimate -- every live bucket's population (a level-L bucket
     * holds 2^L) minus HALF the oldest (straddling) bucket, whose in-window portion is
     * unknown. COLD, O(numLevels). Windowed relative error <= epsilon. NEVER throws;
     * returns 0 on an empty window.
     * @returns {number}
     */
    count() {
        if (this._count === 0) return 0;
        const maxL = this._maxLevel;
        const pow = this._pow;
        const lc = this._lcount;
        let total = 0;
        for (let L = 0; L <= maxL; L++) total += lc[L] * pow[L];
        // Subtract half the oldest bucket ONLY when it genuinely STRADDLES the window
        // edge (its earliest element has fallen out but its newest is still in). A bucket
        // fully inside the window (start > cutoff) is counted in full -- so a not-yet-full
        // window (and every population-1 bucket) is estimated EXACTLY. This is what keeps
        // the windowed error <= epsilon on EVERY query, including the ramp-up.
        const oldest = this._head[maxL];
        if (this._start[oldest] <= this._now - this._W) total -= 0.5 * pow[maxL];
        return total;
    }

    /**
     * The windowed SUM estimate: the sum of the VALUES of the elements in the last W
     * (= count() when every add used value=1). Every live bucket's `size` minus HALF
     * the oldest straddling bucket's size. COLD, O(buckets). Windowed relative error
     * <= epsilon. NEVER throws; returns 0 on an empty window.
     * @returns {number}
     */
    sum() {
        if (this._count === 0) return 0;
        const maxL = this._maxLevel;
        const head = this._head;
        const next = this._next;
        const size = this._size;
        let total = 0;
        for (let L = 0; L <= maxL; L++) {
            let node = head[L];
            while (node !== -1) { total += size[node]; node = next[node]; }
        }
        // Half-correct the oldest bucket ONLY when it straddles the window edge (see count()).
        const oldest = head[maxL];
        if (this._start[oldest] <= this._now - this._W) total -= 0.5 * size[oldest];
        return total;
    }

    /**
     * The primary windowed estimate -- an alias of count() (the DGIM count use-case;
     * for value=1 count() === sum()). COLD. NEVER throws.
     * @returns {number}
     */
    query() { return this.count(); }

    /** Reset to the empty window; reuse the pool. O(cap). @returns {ExponentialHistogram} this */
    clear() {
        this._initState();
        return this;
    }

    /** @private Cold thrower for a mode switch after the mode locked. */
    _badMode(locked, attempted) {
        throw new TypeError(
            '[lite-adaptive] ExponentialHistogram mode is locked to ' + locked +
            ' at the first add; got a ' + attempted + '-mode add');
    }

    /** @private Cold thrower for a non-finite `now`. */
    _badNow(now) {
        throw new TypeError(
            '[lite-adaptive] ExponentialHistogram add now must be a finite number, got ' + String(now));
    }

    /** @private Cold thrower for a non-monotone `now`. */
    _badMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] ExponentialHistogram add now must be non-decreasing: got ' + String(now) +
            ' after ' + String(this._lastNow));
    }

    /** @private Cold thrower for a bad value. */
    _badValue(v) {
        throw new TypeError(
            '[lite-adaptive] ExponentialHistogram add value must be a finite number > 0, got ' + String(v));
    }

    /** @private Cold thrower for a pool overflow (should be unreachable if CAP is correct). */
    _badOverflow() {
        throw new RangeError(
            '[lite-adaptive] ExponentialHistogram bucket pool overflow (cap=' + this._cap +
            '); this is a bug -- please report the W/epsilon used');
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] ExponentialHistogram.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i + 1 < buf.length, got ' + String(buf) + ', ' + String(i));
    }
}

// ===========================================================================
// ADWIN (ADR 0003) -- concept-drift detection + adaptive windowing (Bifet-Gavalda 2007)
// ===========================================================================
//
// ADWIN keeps a window of the most-recent values in an EXPONENTIAL-HISTOGRAM bucket
// list (DESIGN-PARITY with the M1 substrate -- its OWN variance-carrying columns, a
// SEPARATE pool, the EH class is never touched). Each bucket carries (sum, sumSq,
// count); a level-L bucket holds exactly 2^L items. On every add the window GROWS
// while the stream is stationary and SHRINKS from the OLD end the moment a mean shift
// is statistically significant -- so the window is DATA-DRIVEN, there is no magic W.
//
// The cut test is ADWIN2's VARIANCE-AWARE (Bernstein) bound. For every boundary split
// of the window into W0 (older) | W1 (newer), with counts n0 / n1 and the whole-window
// variance sigmaHat^2 and running range R = max - min (over ALL x seen), a cut fires when
//   |mean(W0) - mean(W1)| > epsCut
//   m       = 1 / (1/n0 + 1/n1)                 -- the harmonic-mean of the sub-window counts
//   deltaP  = delta / ln(width)                 -- Bifet-Gavalda multiple-testing correction
//   epsCut  = sqrt( (2/m) * sigmaHat^2 * ln(2/deltaP) ) + (2/3) * (R/m) * ln(2/deltaP)
// On a cut, DROP the oldest bucket(s) (shrink W0 away) and RE-scan until none remains.

/** Frozen marker of the known ADWIN ctor option keys -- an unknown key is a throw. */
const ADWIN_KNOWN_OPTS = Object.freeze(Object.create(null));

/** M -- max buckets per level (ADWIN2 default 5); the two oldest merge on the (M+1)-th. */
const ADWIN_M = 5;
/** LEVELS -- the fixed number of size classes (a level-L bucket holds 2^L items). */
const ADWIN_LEVELS = 64;

/**
 * ADWIN -- ADaptive WINdowing (Bifet-Gavalda, SDM 2007): concept-drift detection with NO
 * fixed window size. It maintains the most-recent values in an EH-style bucket list (its
 * OWN (sum, sumSq, count) columns -- design-parity with M1, a SEPARATE pool), grows the
 * window while the stream is stationary, and SHRINKS it from the OLD end when a mean shift
 * is statistically significant. ITEM-INDEXED: `add(x)` per item (no `now` -- the adaptive
 * window is measured in items), returns `true` iff a cut fired (drift detected) this add.
 *
 * Headline (the recency TRIPLE):
 *   - SPACE: a FIXED pool of CAP = (M+1)*LEVELS + 2 = 386 buckets (M = 5, LEVELS = 64),
 *     never grows -- O(M log width) live buckets.
 *   - ERROR: false-alarm rate <= delta on a stationary stream (the ADWIN2 confidence knob);
 *     detection latency scales with the shift magnitude (small shifts take longer -- disclosed).
 *   - RECENCY: an ADAPTIVE, data-driven window (vs EH's HARD last-W or ForwardDecay's smooth
 *     decay) -- the boundary is chosen by the cut test, not by the caller.
 *
 * Hot path (`add`, 0 B/op incl. the cut-scan + the drop-older shrink): open a size-1 bucket,
 * run the bounded merge cascade, scan every boundary split with the ADWIN2 variance-aware
 * epsCut, and drop the oldest bucket(s) while a cut remains -- every step an index
 * manipulation on the preallocated columns (no objects, no closures, no array literals).
 *
 * Fail closed: a bad delta / option throws `[lite-adaptive]` at the ctor door BEFORE any
 * allocation; `add(x)` validates `x` (a finite number) typeof-first, BEFORE any state
 * mutation -- a rejected add is a BYTE-IDENTICAL no-op; getters never throw (null is not zero).
 */
export class ADWIN {
    /**
     * @param {number} delta   confidence knob; a number in (0, 1). The false-alarm rate on a
     *                         stationary stream is bounded by delta. Smaller -> fewer false
     *                         alarms, longer detection latency.
     * @param {object} [options] reserved; an unknown key throws [lite-adaptive].
     */
    constructor(delta, options) {
        // typeof guard FIRST, BEFORE any allocation.
        if (typeof delta !== 'number' || delta !== delta || delta <= 0 || delta >= 1) {
            throw new RangeError(
                '[lite-adaptive] ADWIN delta must be a number in (0, 1), got ' + String(delta));
        }
        if (options !== undefined) {
            if (typeof options !== 'object' || options === null) {
                throw new TypeError('[lite-adaptive] ADWIN options must be an object');
            }
            for (const key in options) {
                if (!(key in ADWIN_KNOWN_OPTS)) {
                    throw new RangeError('[lite-adaptive] ADWIN unknown option "' + key + '"');
                }
            }
        }
        const M = ADWIN_M;
        const levels = ADWIN_LEVELS;
        // CAP = (M+1)*LEVELS + 2 -- (M+1) per level covers the transient (M+1)-th bucket
        // before its merge; the +2 covers the freshly-opened level-0 bucket during a full
        // cascade plus one slack slot. The pool never grows past CAP.
        const cap = (M + 1) * levels + 2;

        this._delta = delta;
        this._M = M;
        this._levels = levels;
        this._cap = cap;

        // ADWIN's OWN variance-carrying SoA columns (design-parity with EH, a SEPARATE pool):
        this._sum = new Float64Array(cap);    // sum of the values in the bucket
        this._sumSq = new Float64Array(cap);  // sum of squares of the values in the bucket
        this._bcount = new Int32Array(cap);   // number of items in the bucket (= 2^level)
        this._next = new Int32Array(cap);     // intra-level next (toward newer) OR free-list link
        this._prev = new Int32Array(cap);     // intra-level prev (toward older)
        this._lvl = new Int32Array(cap);      // the level of each bucket (0..levels-1)

        // Per-level intrusive doubly-linked lists (oldest -> newest):
        this._head = new Int32Array(levels);  // oldest bucket index at level L, -1 if empty
        this._tail = new Int32Array(levels);  // newest bucket index at level L, -1 if empty
        this._lcount = new Int32Array(levels); // number of buckets at level L

        this._initState();
    }

    /** @private Reset the free-list + list heads to the empty pool. Reused by clear(). 0 alloc. */
    _initState() {
        const cap = this._cap;
        const levels = this._levels;
        const nxt = this._next;
        for (let i = 0; i < cap - 1; i++) nxt[i] = i + 1;
        nxt[cap - 1] = -1;
        this._freeHead = 0;
        for (let L = 0; L < levels; L++) {
            this._head[L] = -1;
            this._tail[L] = -1;
            this._lcount[L] = 0;
        }
        this._maxLevel = -1;    // highest occupied level, -1 when empty
        this._count = 0;        // live bucket count
        this._total = 0;        // window item count (= width)
        this._wsum = 0;         // running sum over the whole window
        this._wsumSq = 0;       // running sum of squares over the whole window
        this._min = Infinity;   // running min over ALL x seen (for the range R -- widens only)
        this._max = -Infinity;  // running max over ALL x seen (for the range R -- widens only)
    }

    /** The confidence knob delta. O(1). */
    get delta() { return this._delta; }
    /** The current adaptive window size in items. O(1). */
    get width() { return this._total; }
    /** Live bucket count (<= capacity). O(1). */
    get bucketCount() { return this._count; }
    /** The fixed pool capacity in buckets. O(1). */
    get capacity() { return this._cap; }
    /** The mean over the current window (0 on an empty window). O(1). */
    get mean() { return this._total > 0 ? this._wsum / this._total : 0; }
    /** The variance over the current window (0 on an empty window, FP-clamped >= 0). O(1). */
    get variance() {
        const n = this._total;
        if (n <= 0) return 0;
        const mean = this._wsum / n;
        const v = this._wsumSq / n - mean * mean;
        return v > 0 ? v : 0;
    }

    /**
     * Add one value to the window. HOT, 0 B/op INCLUDING the merge cascade, the cut-scan, and
     * the drop-older shrink. Opens a size-1 bucket (sum = x, sumSq = x*x, count = 1), runs the
     * bounded merge cascade, then scans every boundary split with the ADWIN2 variance-aware
     * epsCut and drops the oldest bucket(s) while a cut remains.
     *
     * Fail closed: a non-number / NaN / +-Infinity `x` throws [lite-adaptive] (typeof-first, a
     * BYTE-IDENTICAL no-op -- nothing is opened on a rejected add).
     * @param {number} x  any finite real value.
     * @returns {boolean} true iff a cut fired (drift detected) this add.
     */
    add(x) {
        // typeof guard FIRST, BEFORE any state mutation, so a rejected add is a byte-identical no-op.
        if (typeof x !== 'number' || x !== x || x === Infinity || x === -Infinity) {
            return this._badValue(x);
        }
        // running range over ALL x seen (widens monotonically; NOT rolled back on a shrink).
        if (x < this._min) this._min = x;
        if (x > this._max) this._max = x;

        // --- open a fresh level-0 bucket (count 1, sum x, sumSq x*x) at the newest end ---
        const node = this._freeHead;
        if (node === -1) return this._badOverflow();
        this._freeHead = this._next[node];
        this._sum[node] = x;
        this._sumSq[node] = x * x;
        this._bcount[node] = 1;
        this._lvl[node] = 0;
        const tail0 = this._tail[0];
        this._prev[node] = tail0;
        this._next[node] = -1;
        if (tail0 === -1) this._head[0] = node; else this._next[tail0] = node;
        this._tail[0] = node;
        this._lcount[0]++;
        this._count++;
        if (this._maxLevel < 0) this._maxLevel = 0;
        // whole-window aggregates
        this._total += 1;
        this._wsum += x;
        this._wsumSq += x * x;

        // --- the bounded merge cascade: while a level has > M buckets, merge its two OLDEST
        //     into one bucket of the next level (reuse a slot, free the other) ---
        const M = this._M;
        let L = 0;
        while (this._lcount[L] > M) {
            const a = this._head[L];          // oldest at level L
            const b2 = this._next[a];         // second-oldest (newer than a)
            const after = this._next[b2];
            this._head[L] = after;
            if (after === -1) this._tail[L] = -1; else this._prev[after] = -1;
            this._lcount[L] -= 2;
            // reuse slot `a` as the merged bucket (a merge preserves the window aggregates).
            this._sum[a] += this._sum[b2];
            this._sumSq[a] += this._sumSq[b2];
            this._bcount[a] += this._bcount[b2];
            const nl = L + 1;
            this._lvl[a] = nl;
            this._next[b2] = this._freeHead;
            this._freeHead = b2;
            this._count--;                    // two out, one back in -> net -1
            const tnl = this._tail[nl];
            this._prev[a] = tnl;
            this._next[a] = -1;
            if (tnl === -1) this._head[nl] = a; else this._next[tnl] = a;
            this._tail[nl] = a;
            this._lcount[nl]++;
            if (nl > this._maxLevel) this._maxLevel = nl;
            L = nl;
        }

        // --- the ADWIN2 cut-scan + adaptive shrink: while some boundary split shows a
        //     significant mean difference, drop the oldest bucket and re-scan (0 alloc) ---
        let changed = false;
        while (this._total > 1 && this._scanCut()) {
            this._dropOldest();
            changed = true;
        }
        return changed;
    }

    /**
     * @private Scan every boundary split of the window into W0 (older) | W1 (newer) for a
     * significant mean difference (the ADWIN2 variance-aware epsCut). Returns true on the
     * first split that cuts. 0 alloc -- indices + scalars only. Cold relative to the whole
     * add only in the stationary case (one full pass, no drop); walked oldest -> newest.
     */
    _scanCut() {
        const total = this._total;
        if (total <= 1) return false;            // width <= 1 -> no split possible; guards ln(width)
        const wsum = this._wsum;
        const lnw = Math.log(total);             // total > 1 -> lnw > 0
        const deltaP = this._delta / lnw;        // Bifet-Gavalda multiple-testing correction
        const ln2dp = Math.log(2 / deltaP);      // deltaP < 2 for delta < 1 -> ln2dp > 0
        const mean = wsum / total;
        let variance = this._wsumSq / total - mean * mean;
        if (variance < 0) variance = 0;          // FP guard (sqrt of a tiny negative)
        const R = this._max - this._min;         // running observed range (widens as data arrives)
        const head = this._head;
        const next = this._next;
        const bc = this._bcount;
        const sum = this._sum;
        // walk oldest -> newest: higher levels are older, head -> tail within each level.
        let n0 = 0, sum0 = 0;
        for (let L = this._maxLevel; L >= 0; L--) {
            let node = head[L];
            while (node !== -1) {
                n0 += bc[node];
                sum0 += sum[node];
                const n1 = total - n0;
                if (n1 > 0) {
                    const m = 1 / (1 / n0 + 1 / n1);     // harmonic-mean of the sub-window counts
                    const mean0 = sum0 / n0;
                    const mean1 = (wsum - sum0) / n1;
                    let diff = mean0 - mean1;
                    if (diff < 0) diff = -diff;
                    const epsCut = Math.sqrt((2 / m) * variance * ln2dp) + (2 / 3) * (R / m) * ln2dp;
                    if (diff > epsCut) return true;
                }
                node = next[node];
            }
        }
        return false;
    }

    /** @private Drop the globally-oldest bucket (head of the highest occupied level); shrink W0. 0 alloc. */
    _dropOldest() {
        const L = this._maxLevel;
        const b = this._head[L];
        // pull the dropped bucket's aggregates out of the window totals.
        this._total -= this._bcount[b];
        this._wsum -= this._sum[b];
        this._wsumSq -= this._sumSq[b];
        const after = this._next[b];
        this._head[L] = after;
        if (after === -1) this._tail[L] = -1; else this._prev[after] = -1;
        this._lcount[L]--;
        this._count--;
        this._next[b] = this._freeHead;
        this._freeHead = b;
        if (this._head[L] === -1) {
            let m = L;
            while (m >= 0 && this._head[m] === -1) m--;
            this._maxLevel = m;
        }
    }

    /** Reset to the empty window; reuse the pool. O(cap). @returns {ADWIN} this */
    clear() {
        this._initState();
        return this;
    }

    /** @private Cold thrower for a bad value. */
    _badValue(x) {
        throw new TypeError(
            '[lite-adaptive] ADWIN add x must be a finite number, got ' + String(x));
    }

    /** @private Cold thrower for a pool overflow (should be unreachable if CAP is correct). */
    _badOverflow() {
        throw new RangeError(
            '[lite-adaptive] ADWIN bucket pool overflow (cap=' + this._cap +
            '); this is a bug -- please report the delta + stream length used');
    }
}

// ===========================================================================
// ForwardDecay (ADR 0004) -- time-decayed aggregates (Cormode-Shkapenyuk-Srivastava-Xu, ICDE 2009)
// ===========================================================================
//
// ForwardDecay weights each element by an increasing function of its OWN age measured
// FORWARD from a fixed landmark L (never backward from "now"), so the weights are
// computed ONCE at insert and never revised -- the source of its numeric stability. For
// exponential decay g(x) = exp(lambda * x), lambda = ln2 / halfLife, two scalar
// accumulators are maintained incrementally from the landmark:
//   C  = sum_i g(t_i - L)               (decayed COUNT / total weight)
//   Sv = sum_i value_i * g(t_i - L)     (decayed weighted value SUM)
// A query at time `now` folds the common factor g(now - L) back in:
//   decayedCount(now) = C  * exp(-lambda * (now - L))
//   decayedSum(now)   = Sv * exp(-lambda * (now - L))
//   mean(now)         = Sv / C          (the g(now - L) factor CANCELS -> landmark/now-invariant)
//   rate(now)         = decayedCount(now) * lambda   (a DEFINITION: decayed events per unit time)
// Because g grows without bound, `add` REBASES the landmark to the current t whenever
// lambda*(t - L) would exceed FD_EXP_CAP (so exp() never overflows): a cold, O(1),
// alloc-free rescale C *= exp(-lambda*(t - L)); Sv *= ...; L = t -- EXACT modulo FP, since
// it factors one constant from every accumulated term. The hot body allocates 0 bytes.

/** Frozen marker of the known ForwardDecay ctor option keys -- an unknown key is a throw. */
const FD_KNOWN_OPTS = Object.freeze(Object.create(null));

/**
 * FD_EXP_CAP -- the exp() argument ceiling that triggers a landmark rebase. Above this the
 * hot path rebases the landmark to t (arg -> 0) BEFORE accumulating. It is deliberately small
 * so the ACCUMULATOR keeps astronomical head-room, not merely a single weight: a single term
 * is at most exp(40) ~= 2.35e17, so C = sum(w) and Sv = sum(value*w) overflow to Infinity only
 * when the running (value-weighted) term count since the last rebase exceeds Double.MAX / exp(40)
 * ~= 7.6e290 -- physically unreachable. (The earlier 700 was WRONG: exp(700) ~= 1.01e304 sits only
 * ~1.77e4x under Double.MAX ~= 1.798e308, so an ordinary value >= 1.798e308 / exp(700) ~= 17725 at
 * arg = 700, or ~17724 same-timestamp adds pinned at arg = 700, overflowed the accumulator silently.)
 * A rebase then fires only every FD_EXP_CAP / ln2 ~= 57.7 half-lives of elapsed time -- an item that
 * old carries weight 2^-57.7 ~= 4e-18, so the rescale discards nothing measurable. The remaining
 * pathological tail (a single value within ~1e17 of Double.MAX) is caught fail-closed by the query
 * guard `_guardFinite`, never returned as Infinity.
 */
const FD_EXP_CAP = 40;

/**
 * ForwardDecay -- time-decayed COUNT / SUM / MEAN / RATE where every element's weight
 * decays with its AGE (Cormode-Shkapenyuk-Srivastava-Xu, ICDE 2009). Unlike
 * ExponentialHistogram's HARD last-W window or ADWIN's adaptive window, ForwardDecay
 * FORGETS SMOOTHLY: an element's influence shrinks by half every `halfLife` time units,
 * so recent data dominates without any hard cutoff. Exponential decay g(x) = exp(lambda*x),
 * lambda = ln2 / halfLife, is measured FORWARD from a fixed landmark -- so each weight is
 * computed once at insert and never revised (the source of the method's numeric stability
 * vs backward decay, whose per-query re-weighting drifts). Two scalar accumulators (C, Sv)
 * are maintained incrementally; the query folds in the age at `now`.
 *
 * Headline (the recency TRIPLE):
 *   - SPACE: O(1) -- TWO scalars (C, Sv) plus the landmark + the time-mode state. No pool.
 *   - ERROR: EXACT modulo floating point -- the decayed aggregate equals the definition;
 *     the periodic landmark rebase factors a constant from every term (no approximation).
 *   - RECENCY: SMOOTH exponential decay (a soft "effective window" ~ halfLife / ln2, vs
 *     EH's hard edge or ADWIN's data-driven boundary) -- old data fades, never drops.
 *
 * Time model (mirrors ExponentialHistogram): a caller-supplied MONOTONE `now`, or count
 * mode (auto-tick) when `now` is omitted; the mode LOCKS at the first add and a switch
 * throws. Value domain: ANY finite real (signed OK) -- because C and Sv are separate, a
 * negative value lowers the decayed SUM / MEAN without corrupting the decayed COUNT (a
 * deliberate, documented difference from EH's positive-only sum).
 *
 * Hot path (`add`, 0 B/op incl. the rebase branch): a typeof value guard, the mode
 * resolve + monotone-`now` guard, one exp(), and two scalar accumulations -- with a cold
 * O(1) landmark rebase when the exp argument would exceed FD_EXP_CAP. No objects, no
 * closures, no arrays.
 *
 * Fail closed: a bad `halfLife` / option throws `[lite-adaptive]` at the ctor door BEFORE
 * any field init; `add` validates the value + resolves/validates `now` BEFORE any state
 * mutation (a rejected add is a BYTE-IDENTICAL no-op); a query at a time BEFORE the last
 * add throws (can't un-decay) -- otherwise queries never throw and an empty summary reads
 * 0 (null is not zero).
 */
export class ForwardDecay {
    /**
     * @param {number} halfLife  the decay half-life; a finite number > 0 (the time span
     *                           over which an element's weight halves). lambda = ln2/halfLife.
     * @param {object} [options] reserved; an unknown key throws [lite-adaptive].
     */
    constructor(halfLife, options) {
        // typeof guard FIRST, BEFORE any field init.
        if (typeof halfLife !== 'number' || halfLife !== halfLife || halfLife === Infinity || halfLife <= 0) {
            throw new RangeError(
                '[lite-adaptive] ForwardDecay halfLife must be a finite number > 0, got ' + String(halfLife));
        }
        if (options !== undefined) {
            if (typeof options !== 'object' || options === null) {
                throw new TypeError('[lite-adaptive] ForwardDecay options must be an object');
            }
            for (const key in options) {
                if (!(key in FD_KNOWN_OPTS)) {
                    throw new RangeError('[lite-adaptive] ForwardDecay unknown option "' + key + '"');
                }
            }
        }
        this._halfLife = halfLife;
        this._lambda = Math.LN2 / halfLife;   // g(x) = exp(lambda * x); halves every halfLife
        this._initState();
    }

    /** @private Reset the accumulators + landmark + time mode to empty. Reused by clear(). 0 alloc. */
    _initState() {
        this._C = 0;             // decayed count  = sum g(t_i - L)
        this._Sv = 0;            // decayed sum    = sum value_i * g(t_i - L)
        this._L = 0;             // the landmark time (weights are measured forward from here)
        this._mode = MODE_UNSET; // time mode, locked at the first add
        this._tick = 0;          // count-mode logical clock
        this._lastNow = -Infinity; // explicit-mode monotone guard
        this._now = 0;           // the last applied t (the default query time)
    }

    /** The decay half-life (weight halves every halfLife time units). O(1). */
    get halfLife() { return this._halfLife; }
    /** The decay rate lambda = ln2 / halfLife. O(1). */
    get lambda() { return this._lambda; }
    /** The current landmark time L (weights are measured forward from here). O(1). */
    get landmark() { return this._L; }
    /** The locked time mode: 'unset' | 'explicit' | 'count'. O(1). */
    get mode() {
        return this._mode === MODE_EXPLICIT ? 'explicit' : this._mode === MODE_COUNT ? 'count' : 'unset';
    }

    /**
     * Add one element with the given value. HOT, 0 B/op INCLUDING the landmark rebase.
     *
     * Time modes (LOCKED at the first add, a switch throws):
     *   - EXPLICIT: add(now) / add(now, value). `now` is a finite number, strictly
     *     NON-DECREASING across calls (a decrease throws [lite-adaptive]).
     *   - COUNT: add() / add(undefined, value). The member auto-increments an internal
     *     tick per add (the "last N items" convenience).
     *
     * `value` (both modes) defaults to 1; a supplied value must be a FINITE real (signed
     * is allowed -- it contributes to the decayed SUM / MEAN but still counts as ONE
     * decayed event in the decayed COUNT).
     *
     * Fail closed: a mode switch, a non-finite `now`, a `now` going backwards, or a
     * non-finite / non-number value throws [lite-adaptive] (typeof-first, BYTE-IDENTICAL
     * no-op -- nothing is accumulated on a rejected add).
     * @param {number} [now]   the monotone time (omit for count mode).
     * @param {number} [value] the element's value (default 1; any finite real).
     * @returns {ForwardDecay} this
     */
    add(now, value) {
        // --- resolve + validate the value FIRST, before ANY state mutation, so every
        // rejected add is a BYTE-IDENTICAL no-op. Any finite real is legal (signed OK);
        // only a non-number / NaN / +-Infinity is rejected. typeof-first, no alloc. ---
        let v = value;
        if (v === undefined) {
            v = 1;
        } else if (typeof v !== 'number' || v !== v || v === Infinity || v === -Infinity) {
            return this._badValue(v);
        }
        // --- resolve the timestamp + lock/verify the mode (typeof-first, no alloc) ---
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            if (now !== undefined) return this._badMode('count', 'explicit');
            t = ++this._tick;
        } else if (mode === MODE_EXPLICIT) {
            if (now === undefined) return this._badMode('explicit', 'count');
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badNow(now);
            }
            if (now < this._lastNow) return this._badMonotone(now);
            t = now;
            this._lastNow = now;
        } else {
            // first add: lock the mode + set the landmark to the first element's time.
            if (now === undefined) {
                this._mode = MODE_COUNT;
                t = ++this._tick;
            } else {
                if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                    return this._badNow(now);
                }
                this._mode = MODE_EXPLICIT;
                t = now;
                this._lastNow = now;
            }
            this._L = t;
        }
        this._now = t;

        // --- accumulate the forward-decayed weight (rebase the landmark if exp() would
        //     approach overflow -- a cold, O(1), EXACT rescale that factors a constant out) ---
        const lambda = this._lambda;
        if (lambda * (t - this._L) > FD_EXP_CAP) this._rebase(t);
        const w = Math.exp(lambda * (t - this._L));
        this._C += w;
        this._Sv += v * w;
        return this;
    }

    /**
     * Add one element from a caller-owned PACKED `[now, value]` Float64Array pair. HOT,
     * 0 B/op -- the ZERO-BOX entry for a caller whose `now` AND `value` are both FRACTIONAL
     * doubles (the lite-hud decayed-stats idiom: a per-channel fractional record time + a
     * fractional value). `add(now, value)` boxes each fractional argument into a ~16 B
     * HeapNumber at a non-inlined call boundary; this reads `now = buf[i]` / `value = buf[i + 1]`
     * UNBOXED straight from the array. The caller writes a `Float64Array(2)` scratch and calls
     * `addFrom(scratch, 0)` (a batch steps `i` by 2). Identical validation, throws, byte-
     * identical-no-op-on-reject, and accumulation (incl. the landmark rebase) as `add(now,
     * value)`; it differs ONLY in how the two scalars cross the boundary.
     *
     * EXPLICIT-time ONLY: addFrom always carries a `now`, so a COUNT-locked instance rejects
     * it (the way `add(now)` rejects a count-locked instance) and the first addFrom locks
     * EXPLICIT mode (setting the landmark to the first element's time). The value is validated
     * FIRST (mirroring `add`), then the mode, then the monotone `now` -- all BEFORE any state
     * mutation, so a rejected addFrom is a byte-identical no-op. The accumulate body is
     * DUPLICATED from `add` (not delegated) to keep `add`'s hot body byte-identical and avoid
     * re-boxing at an internal call boundary.
     *
     * Fail closed BEFORE any read (typeof-first): a non-Float64Array `buf`, or a non-integer /
     * negative / out-of-range `i` (needs `i + 1 < buf.length`) throws [lite-adaptive].
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = now, `buf[i+1]` = value.
     * @param {number} i the base index of the [now, value] pair (0, 2, 4, ...).
     * @returns {ForwardDecay} this
     */
    addFrom(buf, i) {
        // Guard the buffer + index on the COLD branch first (a bad handle is a byte-identical no-op).
        if (!(buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || i + 1 >= buf.length) return this._badBuf(buf, i);
        const now = buf[i];       // UNBOXED Float64Array reads -- the whole point (no argument box).
        const v = buf[i + 1];     // packed [now, value]
        // --- validate the value FIRST (mirror add(); any finite real is legal, signed OK; a
        // Float64Array read is always a number so add()'s typeof branch is omitted). ---
        if (v !== v || v === Infinity || v === -Infinity) return this._badValue(v);
        // --- addFrom is an EXPLICIT-time entry: reject a count-locked instance, else lock/verify
        // EXPLICIT + the monotone `now` (typeof-first, no alloc). ---
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (now !== now || now === Infinity || now === -Infinity) return this._badNow(now);
            if (now < this._lastNow) return this._badMonotone(now);
            t = now;
            this._lastNow = now;
        } else {
            if (now !== now || now === Infinity || now === -Infinity) return this._badNow(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
            this._L = t;   // first add: set the landmark to the first element's time
        }
        this._now = t;

        // --- accumulate the forward-decayed weight -- DUPLICATED from add() to keep add()'s
        //     hot body byte-identical and avoid a boxing call boundary. ---
        const lambda = this._lambda;
        if (lambda * (t - this._L) > FD_EXP_CAP) this._rebase(t);
        const w = Math.exp(lambda * (t - this._L));
        this._C += w;
        this._Sv += v * w;
        return this;
    }

    /**
     * @private Rebase the landmark to `t`. Cold, O(1), 0 B/op. Multiplies both accumulators
     * by exp(-lambda*(t - L)) and moves the landmark to `t` -- factoring one common constant
     * out of every accumulated term, so the decayed aggregates are UNCHANGED modulo FP.
     */
    _rebase(t) {
        const f = Math.exp(-this._lambda * (t - this._L));
        this._C *= f;
        this._Sv *= f;
        this._L = t;
    }

    /**
     * @private Resolve + validate the query time. `undefined` -> the last add time (the
     * default). An explicit query time must be a finite number >= the last add time (a query
     * in the past can't un-decay -> throw). 0 alloc.
     */
    _queryTime(now) {
        if (now === undefined) return this._now;
        if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity || now < this._now) {
            return this._badQueryTime(now);
        }
        return now;
    }

    /**
     * The decayed COUNT (total decayed weight) at `now`. C * exp(-lambda*(now - L)). COLD,
     * O(1). `now` defaults to the last add time; a query before it throws. Returns 0 when
     * empty (null is not zero).
     * @param {number} [now] the query time (>= the last add time).
     * @returns {number}
     */
    count(now) {
        if (this._C === 0) return 0;
        this._guardFinite();
        const t = this._queryTime(now);
        return this._C * Math.exp(-this._lambda * (t - this._L));
    }

    /**
     * The decayed weighted SUM of the values at `now`. Sv * exp(-lambda*(now - L)). COLD,
     * O(1). `now` defaults to the last add time; a query before it throws. Returns 0 when
     * empty.
     * @param {number} [now] the query time (>= the last add time).
     * @returns {number}
     */
    sum(now) {
        if (this._C === 0) return 0;
        this._guardFinite();
        const t = this._queryTime(now);
        return this._Sv * Math.exp(-this._lambda * (t - this._L));
    }

    /**
     * The decayed MEAN (Sv / C). The age factor exp(-lambda*(now - L)) is common to the
     * numerator and denominator, so it CANCELS -- the decayed mean is landmark- AND
     * now-invariant (EXACT). COLD, O(1). Returns 0 when empty.
     * @param {number} [now] the query time (validated for contract uniformity; the result
     *                       does not depend on it).
     * @returns {number}
     */
    mean(now) {
        if (this._C === 0) return 0;
        this._guardFinite();
        this._queryTime(now);
        return this._Sv / this._C;
    }

    /**
     * The decayed RATE at `now` -- decayedCount(now) * lambda. This is a DEFINITION (decayed
     * events per unit time under the exponential kernel), NOT a theorem: with lambda = ln2 /
     * halfLife, a steady arrival of `r` events/unit converges to decayedCount -> r / lambda,
     * so rate() -> r. COLD, O(1). Returns 0 when empty.
     * @param {number} [now] the query time (>= the last add time).
     * @returns {number}
     */
    rate(now) {
        if (this._C === 0) return 0;
        this._guardFinite();
        const t = this._queryTime(now);
        return this._C * Math.exp(-this._lambda * (t - this._L)) * this._lambda;
    }

    /** Reset to empty; keep halfLife / lambda, unlock the mode. O(1). @returns {ForwardDecay} this */
    clear() {
        this._initState();
        return this;
    }

    /** @private Cold thrower for a mode switch after the mode locked. */
    _badMode(locked, attempted) {
        throw new TypeError(
            '[lite-adaptive] ForwardDecay mode is locked to ' + locked +
            ' at the first add; got a ' + attempted + '-mode add');
    }

    /** @private Cold thrower for a non-finite `now`. */
    _badNow(now) {
        throw new TypeError(
            '[lite-adaptive] ForwardDecay add now must be a finite number, got ' + String(now));
    }

    /** @private Cold thrower for a non-monotone `now`. */
    _badMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] ForwardDecay add now must be non-decreasing: got ' + String(now) +
            ' after ' + String(this._lastNow));
    }

    /** @private Cold thrower for a bad value. */
    _badValue(v) {
        throw new TypeError(
            '[lite-adaptive] ForwardDecay add value must be a finite number, got ' + String(v));
    }

    /** @private Cold thrower for a query time before the last add (can't un-decay). */
    _badQueryTime(now) {
        throw new RangeError(
            '[lite-adaptive] ForwardDecay query time must be a finite number >= the last add time (' +
            String(this._now) + '), got ' + String(now));
    }

    /**
     * @private Fail-closed guard for the query path: an accumulator that overflowed to a
     * non-finite value (only reachable from a value within ~1e17 of Double.MAX -- see
     * FD_EXP_CAP) must THROW, never silently return Infinity / NaN. Cold path, 0 hot cost.
     */
    _guardFinite() {
        const c = this._C, s = this._Sv;
        if (c !== c || c === Infinity || c === -Infinity ||
            s !== s || s === Infinity || s === -Infinity) {
            throw new RangeError(
                '[lite-adaptive] ForwardDecay accumulator overflowed to a non-finite value ' +
                '(a value near Double.MAX was added); the summary is fail-closed -- call clear() to reuse');
        }
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] ForwardDecay.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i + 1 < buf.length, got ' + String(buf) + ', ' + String(i));
    }
}
