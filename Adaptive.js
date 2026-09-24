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
 * the rebase branch; values may be any finite real (signed).
 *
 * v0.4.0 adds HeavyKeeper (Gong-Yang-Chen-et al., USENIX ATC 2018): decayed / windowed
 * HEAVY HITTERS (top-k right now), far lower error than Space-Saving on skewed / evolving
 * streams. A d x w SoA table of (fingerprint, count) with PROBABILISTIC exponential decay
 * of a counter on a fingerprint MISS (a seeded xorshift32 PRNG, base b), plus an intrusive
 * top-k min-forest (design-parity with lite-o1 FreqO1, an open-addressed backshift map +
 * a binary min-heap over the k current leaders -- never a dep). WEIGHTED `add(key, weight)`
 * (integer weights, e.g. lite-hud microseconds) with the SETTLED weighted-miss decay rule
 * (decay ONCE with prob b^(-count), then count -= weight clamped at 0). `add` / the ZERO-BOX
 * `addFrom(buf, i)` (large u32 keys read UNBOXED) are 0 B/op incl. the decay draw + the forest
 * sift. This COMPLETES the four-member roster (1.0.0 = the API-freeze milestone, next).
 *
 * v0.4.0 also adds ADWIN.addFrom(buf, i) (a ZERO-BOX sibling of ADWIN.add(x): reads x = buf[i]
 * UNBOXED from a caller-owned Float64Array; ADWIN.add(x)'s hot body stays byte-identical).
 * Prior members (ExponentialHistogram, ForwardDecay) stay BYTE-IDENTICAL; only this header +
 * VERSION change above the append point (plus the additive ADWIN.addFrom inside the ADWIN class).
 *
 * v1.0.0 is the API-FREEZE milestone: the four-member core (ExponentialHistogram, ADWIN,
 * ForwardDecay, HeavyKeeper) is declared STABLE -- signatures, options, and valid-input behavior
 * are frozen (additive post-1.0 members remain possible; the core does not break). No new member,
 * no hot-path byte change. This release only TIGHTENS three previously-invalid-input paths to
 * fail closed (all cold, 0 B/op): ForwardDecay count/sum/mean/rate now validate the query-time
 * argument on an EMPTY summary (they no longer swallow a bad `now` and return 0); HeavyKeeper
 * .estimate(key) throws on a non-safe-integer key (parity with add, no longer a silent 0); and
 * HeavyKeeper.topKInto(buf) rejects a too-small buffer (length must be >= 2*k) instead of
 * truncating silently. Prior VALID calls are byte-for-byte behaviorally identical.
 *
 * v1.1.0 adds SlidingHyperLogLog (ADR 0006; Chabchoub-Hebrail, 2010): windowed DISTINCT-COUNT
 * over the RECENCY axis -- how many distinct keys in the LAST W, in FIXED preallocated space at
 * HLL accuracy (the adaptive sibling of lite-sketch's cumulative HyperLogLog). An `m = 2^p`
 * register bank where each register keeps a small FIXED "List of Future Possible Maxima" ring of
 * `(timestamp, rho)` entries (a per-register monotonic deque); `add(now, key)` / the zero-box
 * `addFrom(buf, i)` drop dominated tail entries and append (0 B/op incl. any windowed eviction),
 * a full ring bumps `overflows` (the honest-degradation signal, `degraded`); `count(w?)` lazily
 * expires `stamp <= now - W`, takes each register's live-max rho, and runs Ertl's improved
 * estimator (design-parity with lite-sketch, inline -- never an import). The FIRST additive
 * post-1.0 member: it is a PURE APPEND -- the four frozen core classes (ExponentialHistogram,
 * ADWIN, ForwardDecay, HeavyKeeper) stay BYTE-IDENTICAL; only this header + VERSION change above
 * the append point plus the appended SlidingHyperLogLog class.
 *
 * v1.2.0 adds DriftDetector (ADR 0007; Page, "Continuous Inspection Schemes", Biometrika 1954;
 * Mouss-Mouss-Linkens-Sellami, 2004): a SCALAR, O(1)-STATE streaming drift detector over a
 * real-valued signal, selected by a mode const -- DRIFT_PH (Page-Hinkley: cumulative deviation
 * of x from its running mean, two-sided) or DRIFT_CUSUM (two-sided CUSUM: two accumulators gP /
 * gN each floored at 0). `add(x) -> boolean` (and the zero-box `addFrom(buf, i)`) updates a
 * running mean, runs the ONE mode branch, and returns true EXACTLY on the detecting item,
 * resetting the accumulators so the NEXT shift is caught -- 0 B/op. It is the item-based, scalar,
 * fixed-scalar-state complement to ADWIN's adaptive window: no pool (pure scalars, like
 * ForwardDecay), no window, just a bounded test statistic. DDM / EDDM (which need a Bernoulli
 * error-bit stream + tri-state output) are deliberately OUT of this class -- a future member.
 * The SECOND additive post-1.0 member: a PURE APPEND -- the five prior classes
 * (ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog) stay
 * BYTE-IDENTICAL; only this header + VERSION change above the append point plus the appended
 * DriftDetector class (and its DRIFT_PH / DRIFT_CUSUM mode consts).
 *
 * v1.3.0 adds SlidingDDSketch (ADR 0008; Masson-Rim-Lee, "DDSketch", VLDB 2019, on a windowed
 * pane ring): WINDOWED relative-error QUANTILES over the LAST W in FIXED preallocated space --
 * the recency sibling of lite-sketch's cumulative DDSketch. A ring of B preallocated DDSketch
 * PANES, each covering W/B of the window; add(now, value) / the zero-box addFrom(buf, i) bin the
 * value on the SAME log scale as DDSketch (gamma = (1+alpha)/(1-alpha), key = ceil(log_gamma v),
 * collapse-lowest default + strict opt-in), writing the current pane; crossing a pane boundary
 * rotates to the next pane and clears it (0 B/op, a bounded while-loop capped at B). quantile /
 * quantileInto / count merge the live panes into an INSTANCE-OWNED preallocated scratch (cold,
 * 0-alloc -- never a per-query allocation). Edge error is up to one pane width W/B, disclosed and
 * WITNESSED (each pane collapses its lowest bins INDEPENDENTLY, so the merged min-key can differ
 * from a single sketch's). The THIRD additive post-1.0 member: a PURE APPEND -- the six prior
 * classes (ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog,
 * DriftDetector) stay BYTE-IDENTICAL; only this header + VERSION change above the append point
 * plus the appended SlidingDDSketch class (and its SLD_* consts).
 *
 * ASCII-only source (no Unicode; the two exceptions the suite allows are unused
 * here). Zero runtime deps; node:test only.
 *
 * @license MIT
 */

/** Package version. One of the three version sites (package.json / VERSION / llms.txt). */
export const VERSION = '1.3.0';

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
 * ADWIN_X_MAX -- the largest |x| whose SQUARE is still finite (sqrt(Number.MAX_VALUE) ~= 1.34e154).
 * A finite |x| above this makes x*x overflow to Infinity, which poisons _sumSq / _wsumSq: variance
 * then reads Inf - Inf = NaN (clamped to 0) while mean stays finite, so every epsCut is Inf/NaN and
 * drift detection freezes to false SILENTLY. |x| > ADWIN_X_MAX is therefore rejected fail-closed via
 * the existing _badValue thrower (one extra comparison on the COLD reject branch -- 0 hot-path bytes).
 * Astronomically above any real telemetry value.
 */
const ADWIN_X_MAX = Math.sqrt(Number.MAX_VALUE);

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
 * allocation; `add(x)` validates `x` (a finite number with |x| <= sqrt(Number.MAX_VALUE), so its
 * square never overflows and poisons the variance) typeof-first, BEFORE any state mutation -- a
 * rejected add is a BYTE-IDENTICAL no-op; the mean / variance getters throw `[lite-adaptive]` if
 * the whole-window accumulator ever reaches a non-finite value (fail-closed, never a silent 0).
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
    /** The mean over the current window (0 on an empty window). O(1). Throws if the accumulator overflowed. */
    get mean() {
        if (this._total <= 0) return 0;
        this._guardFinite();
        return this._wsum / this._total;
    }
    /** The variance over the current window (0 on an empty window, FP-clamped >= 0). O(1). Throws if overflowed. */
    get variance() {
        const n = this._total;
        if (n <= 0) return 0;
        this._guardFinite();
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
     * Fail closed: a non-number / NaN / +-Infinity `x`, or a finite |x| > sqrt(Number.MAX_VALUE)
     * (~1.34e154, whose square would overflow to Infinity and silently poison the variance / drift
     * test), throws [lite-adaptive] (typeof-first, a BYTE-IDENTICAL no-op -- nothing is opened).
     * @param {number} x  a finite real value with |x| <= sqrt(Number.MAX_VALUE).
     * @returns {boolean} true iff a cut fired (drift detected) this add.
     */
    add(x) {
        // typeof guard FIRST, BEFORE any state mutation, so a rejected add is a byte-identical no-op.
        if (typeof x !== 'number' || x !== x || x === Infinity || x === -Infinity ||
            x > ADWIN_X_MAX || x < -ADWIN_X_MAX) {   // reject a finite x whose square would overflow
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
     * Add one value read UNBOXED from a caller-owned Float64Array. HOT, 0 B/op -- the ZERO-BOX
     * sibling of `add(x)` for a caller whose `x` is a FRACTIONAL double (the lite-hud M6 drift
     * driver: a HUD-computed duration). `add(x)` boxes a fractional argument into a ~16 B
     * HeapNumber at a non-inlined call boundary; this reads `x = buf[i]` UNBOXED straight from
     * the array. ADWIN is ITEM-INDEXED (a single value, no `now`), so only `buf[i]` is read.
     * Identical validation, throws, byte-identical-no-op-on-reject, and reshaping (the drift
     * detection + cut-scan + drop-older shrink) as `add(x)`; it differs ONLY in how the scalar
     * crosses the boundary. The body is DUPLICATED from `add` (not delegated) to keep `add`'s
     * hot body byte-identical and avoid re-boxing at an internal call boundary.
     *
     * Fail closed BEFORE any read (typeof-first): a non-Float64Array `buf`, or a non-integer /
     * negative / out-of-range `i` (needs `i < buf.length`) throws [lite-adaptive]. A NaN /
     * +-Infinity `buf[i]`, or a finite |buf[i]| > sqrt(Number.MAX_VALUE) (square would overflow),
     * throws (a byte-identical no-op).
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = the value (|x| <= sqrt(MAX)).
     * @param {number} i the index of the value to read.
     * @returns {boolean} true iff a cut fired (drift detected) this add.
     */
    addFrom(buf, i) {
        // Guard the buffer + index on the COLD branch first (a bad handle is a byte-identical no-op).
        if (!(buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || i >= buf.length) return this._badBuf(buf, i);
        const x = buf[i];   // UNBOXED Float64Array read -- the whole point (no argument box).
        // --- validate x FIRST (mirror add(); a Float64Array read is always a number, so add()'s
        // typeof branch is unreachable here and omitted). BYTE-IDENTICAL no-op on reject. ---
        if (x !== x || x === Infinity || x === -Infinity ||
            x > ADWIN_X_MAX || x < -ADWIN_X_MAX) return this._badValue(x);   // square would overflow
        // running range over ALL x seen (widens monotonically; NOT rolled back on a shrink).
        if (x < this._min) this._min = x;
        if (x > this._max) this._max = x;

        // --- open a fresh level-0 bucket (count 1, sum x, sumSq x*x) at the newest end --
        //     DUPLICATED from add() to keep add()'s hot body byte-identical. ---
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
        this._total += 1;
        this._wsum += x;
        this._wsumSq += x * x;

        // --- the bounded merge cascade (see add() for the full commentary) ---
        const M = this._M;
        let L = 0;
        while (this._lcount[L] > M) {
            const a = this._head[L];
            const b2 = this._next[a];
            const after = this._next[b2];
            this._head[L] = after;
            if (after === -1) this._tail[L] = -1; else this._prev[after] = -1;
            this._lcount[L] -= 2;
            this._sum[a] += this._sum[b2];
            this._sumSq[a] += this._sumSq[b2];
            this._bcount[a] += this._bcount[b2];
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

        // --- the ADWIN2 cut-scan + adaptive shrink (see add() for the full commentary) ---
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
            '[lite-adaptive] ADWIN add x must be a finite number with |x| <= sqrt(Number.MAX_VALUE) ' +
            '(~1.34e154, so x*x stays finite), got ' + String(x));
    }

    /**
     * @private Fail-closed guard for the query getters (mean / variance): a whole-window accumulator
     * that reached a non-finite value (only via an astronomically long stream now the per-value square
     * is bounded) must THROW, never silently read 0 / NaN. Cold path, 0 hot cost. Mirrors ForwardDecay.
     */
    _guardFinite() {
        const s = this._wsum, sq = this._wsumSq;
        if (s !== s || s === Infinity || s === -Infinity ||
            sq !== sq || sq === Infinity || sq === -Infinity) {
            throw new RangeError(
                '[lite-adaptive] ADWIN window accumulator overflowed to a non-finite value; the summary ' +
                'is fail-closed -- call clear() to reuse');
        }
    }

    /** @private Cold thrower for a pool overflow (should be unreachable if CAP is correct). */
    _badOverflow() {
        throw new RangeError(
            '[lite-adaptive] ADWIN bucket pool overflow (cap=' + this._cap +
            '); this is a bug -- please report the delta + stream length used');
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] ADWIN.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index (0 <= i < buf.length), got ' + String(buf) + ', ' + String(i));
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
        const t = this._queryTime(now);   // validate `now` BEFORE the empty early-exit (fail-closed)
        if (this._C === 0) return 0;
        this._guardFinite();
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
        const t = this._queryTime(now);   // validate `now` BEFORE the empty early-exit (fail-closed)
        if (this._C === 0) return 0;
        this._guardFinite();
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
        this._queryTime(now);   // validate `now` BEFORE the empty early-exit (fail-closed)
        if (this._C === 0) return 0;
        this._guardFinite();
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
        const t = this._queryTime(now);   // validate `now` BEFORE the empty early-exit (fail-closed)
        if (this._C === 0) return 0;
        this._guardFinite();
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

// ===========================================================================
// HeavyKeeper (ADR 0005) -- decayed / windowed heavy hitters, top-k (Gong et al., ATC 2018)
// ===========================================================================
//
// HeavyKeeper answers "which keys are the heaviest RIGHT NOW?" -- a top-k over a SKEWED,
// EVOLVING stream, at far lower error than Space-Saving because it PROTECTS heavy counters
// and PROBABILISTICALLY DECAYS light ones instead of blindly evicting the min. A d x w SoA
// table of (fingerprint, count) columns (Uint32, row-major) plus an intrusive top-k
// min-forest: an open-addressed backshift map (key -> heap slot) over a binary MIN-HEAP of
// the k current leaders (design-parity with lite-o1 FreqO1's intrusive index surgery -- a
// COPIED technique, never a dep). Nothing about the table or the forest allocates per op.
//
// HOT add(key, weight): the two-lane murmur (mirrored INLINE from lite-sketch Sketch.js, ADR
// 0001 there) derives a fingerprint fp + d column positions; per row r at cell (r, col_r):
//   (a) count == 0 (empty) -> fp = fpKey, count = weight;
//   (b) fp == fpKey        -> count += weight (clamped at uint32 max);
//   (c) fp != fpKey        -> DECAY: draw the seeded xorshift32 PRNG, and with probability
//       b^(-count) do `count -= weight` clamped at 0, replacing fp = fpKey / count = weight
//       when it hits 0. estimate(key) = the max count over the d cells whose fp == fpKey.
// After the table update the top-k min-forest is maintained (insert / update / evict-the-min),
// an intrusive sift with 0 allocation.
//
// WEIGHTED-MISS DECAY RULE (SETTLED, ADR 0005): decay ONCE with probability b^(-count), THEN
// count -= weight (clamped). The REJECTED alternative -- decay per weight UNIT (a draw per
// microsecond) -- is O(weight), not O(1), and not 0-alloc; recorded in the ADR.
//
// PRNG: a seeded xorshift32 (state kept as a SIGNED int32 so the module never boxes a uint32
// >= 2^31 into a field). The decay probability b^(-count) is a Float64Array LUT for counts in
// [0, HK_LUT_SIZE); above the LUT the probability is astronomically small, so a heavy counter
// effectively never decays (a cheap Math.pow fallback, 0-alloc). No Math.random, no per-op
// Math.pow allocation on the common path.

/** Default decay base b (~1.08; the ATC 2018 paper's small-base regime). b^(-count) in (0,1). */
const HK_DEFAULT_B = 1.08;
/** Default per-instance seed (a uint32, nonzero). Two default-seeded HeavyKeepers behave identically. */
const HK_DEFAULT_SEED = 0x9e3779b1;
/** The decay-probability LUT size: lut[c] = b^(-c) for c in [0, HK_LUT_SIZE). */
const HK_LUT_SIZE = 256;
/** Max simultaneous rows d (a sane ceiling; the paper uses d ~ 4-8). */
const HK_D_MAX = 64;

/** MurmurHash3 mixing constants (SMIs) -- mirrored INLINE from lite-sketch Sketch.js (ADR 0001 there). */
const HK_C1 = 0xcc9e2d51 | 0;
const HK_C2 = 0x1b873593 | 0;
/** MurmurHash3 fmix32 finalizer constants (SMIs). */
const HK_FC1 = 0x85ebca6b | 0;
const HK_FC2 = 0xc2b2ae35 | 0;
/** Lane / row / map decorrelation salts (SMIs). */
const HK_LANE_SALT = 0x85ebca6b | 0;
const HK_ODD = 0x9e3779b1 | 0;
const HK_MAP_SALT = 0x27d4eb2f | 0;
const HK_RNG_SALT = 0x165667b1 | 0;

/** Frozen marker of the known HeavyKeeper ctor option keys -- an unknown key is a throw. */
const HK_KNOWN_OPTS = Object.freeze({ seed: true, b: true });

/**
 * The two hash lanes of the last hkHash call: HK_H1 = fingerprint lane, HK_H2 = position base
 * lane. Written by hkHash, read by the caller on the immediately following synchronous line
 * -- the alloc-free "return two uint32s" trick. Held as SIGNED int32 so a lane >= 2^31 never
 * boxes a HeapNumber into a module slot; readers recover the unsigned value with `>>> 0`.
 */
let HK_H1 = 0;
let HK_H2 = 0;

/** One MurmurHash3 body round (pure int32, zero-alloc). */
function hkRound(h, k) {
    k = Math.imul(k, HK_C1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, HK_C2);
    h = h ^ k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    return h;
}

/** MurmurHash3 fmix32 finalizer -- the avalanche step (pure int32, zero-alloc). */
function hkFinal(h) {
    h = h ^ (h >>> 16);
    h = Math.imul(h, HK_FC1);
    h = h ^ (h >>> 13);
    h = Math.imul(h, HK_FC2);
    h = h ^ (h >>> 16);
    return h;
}

/**
 * Hash a numeric (safe-integer) key with a uint32 seed into HK_H1 (fingerprint lane) and
 * HK_H2 (position base lane): the key's low + high words folded through TWO independently
 * seeded murmur3 bodies. Zero allocation, no BigInt, no ref retained.
 */
function hkHash(key, seed) {
    let a = key, neg = 0;
    if (a < 0) { a = -a; neg = 1; }
    const lo = a >>> 0;                        // low 32 bits (ToUint32)
    const hi = ((a - lo) / 4294967296) >>> 0;  // high word (exact for safe integers)
    const s = seed >>> 0;
    let h = s | 0;
    h = hkRound(h, lo);
    h = hkRound(h, hi ^ neg);
    h = h ^ 8;
    HK_H1 = hkFinal(h) | 0;
    let g = (s ^ HK_LANE_SALT) | 0;
    g = hkRound(g, lo);
    g = hkRound(g, hi ^ neg);
    g = g ^ 8;
    HK_H2 = hkFinal(g) | 0;
}

/** Column position of row r: a per-row salt of the position base lane, mod w. Zero-alloc. */
function hkPos(base, r, w) {
    return (hkFinal((base ^ Math.imul(r, HK_ODD)) | 0) >>> 0) % w;
}

/** A standalone map-index hash of a key (does NOT touch HK_H1 / HK_H2). Zero-alloc uint32. */
function hkMapHash(key, seed) {
    let a = key, neg = 0;
    if (a < 0) { a = -a; neg = 1; }
    const lo = a >>> 0;
    const hi = ((a - lo) / 4294967296) >>> 0;
    let h = (seed ^ HK_MAP_SALT) | 0;
    h = hkRound(h, lo);
    h = hkRound(h, hi ^ neg);
    h = h ^ 8;
    return hkFinal(h) >>> 0;
}

/**
 * HeavyKeeper -- decayed / windowed HEAVY HITTERS (top-k right now), Gong-Yang-Chen et al.,
 * "HeavyKeeper: An Accurate Algorithm for Finding Top-k Elephant Flows" (USENIX ATC 2018).
 * A d x w SoA table of (fingerprint, count) columns with PROBABILISTIC exponential decay on a
 * fingerprint MISS -- heavy counters are protected, light ones fade -- plus an intrusive top-k
 * min-forest (an open-addressed backshift map over a binary min-heap of the k leaders,
 * design-parity with lite-o1 FreqO1). Far lower error than Space-Saving on a skewed / evolving
 * stream because it does not blindly evict the current minimum.
 *
 * Headline (the recency TRIPLE):
 *   - SPACE: a FIXED d x w Uint32 table + a k-slot heap + a 2k-ish map. Never grows.
 *   - ERROR: bounded OVERESTIMATE (a reported count is in [true - err, true] for the current
 *     leaders); recall of the true heavy hitters is high on skew (witnessed vs Space-Saving).
 *   - RECENCY: a DECAY model -- a counter for a key that stops arriving is probabilistically
 *     eroded by other keys' misses, so the top-k tracks the CURRENT distribution.
 *
 * Hot path (`add` / `addFrom`, 0 B/op): the two-lane murmur, d cell touches (empty-fill /
 * fp-hit increment / fp-miss probabilistic decay via the seeded xorshift32 PRNG), and the
 * intrusive forest sift -- every step an index manipulation on preallocated columns.
 *
 * Fail closed: a bad d / w / k / seed / b / option throws `[lite-adaptive]` at the ctor door
 * BEFORE any allocation; `add` / `addFrom` validate the key (a SAFE INTEGER) + weight (a
 * positive integer) typeof-first, BEFORE any state mutation -- a rejected add is a BYTE-
 * IDENTICAL no-op; `estimate` / `forEach` / getters never throw (null is not zero). No `merge`
 * (a consumer does not rotate a HeavyKeeper; noted post-1.0 in ADR 0005).
 */
export class HeavyKeeper {
    /**
     * @param {number} d  table depth (rows / independent hashes); an integer in [1, 64]. d ~ 4-8.
     * @param {number} w  table width (columns per row); an integer >= 1.
     * @param {number} k  the top-k size; an integer >= 1.
     * @param {object} [options] { seed?: uint32 (default 0x9e3779b1; seed=0 is a valid distinct
     *                seed -- guarded as `undefined`, not falsy), b?: decay base (a finite number
     *                > 1, default 1.08) }. An unknown key throws [lite-adaptive].
     */
    constructor(d, w, k, options) {
        // typeof guards FIRST, BEFORE any allocation (a bad param leaves no half-built instance).
        if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > HK_D_MAX) {
            throw new RangeError(
                '[lite-adaptive] HeavyKeeper d must be an integer in [1, ' + HK_D_MAX + '], got ' + String(d));
        }
        if (typeof w !== 'number' || !Number.isInteger(w) || w < 1) {
            throw new RangeError(
                '[lite-adaptive] HeavyKeeper w must be an integer >= 1, got ' + String(w));
        }
        if (typeof k !== 'number' || !Number.isInteger(k) || k < 1) {
            throw new RangeError(
                '[lite-adaptive] HeavyKeeper k must be an integer >= 1, got ' + String(k));
        }
        let seed = HK_DEFAULT_SEED;
        let b = HK_DEFAULT_B;
        if (options !== undefined) {
            if (typeof options !== 'object' || options === null) {
                throw new TypeError('[lite-adaptive] HeavyKeeper options must be an object');
            }
            for (const key in options) {
                if (!(key in HK_KNOWN_OPTS)) {
                    throw new RangeError('[lite-adaptive] HeavyKeeper unknown option "' + key + '"');
                }
            }
            // seed=0 is a VALID distinct seed -- guard `undefined`, not falsy (null is not zero).
            if (options.seed !== undefined) {
                const s = options.seed;
                if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || s > 4294967295) {
                    throw new RangeError(
                        '[lite-adaptive] HeavyKeeper seed must be a uint32 (integer in [0, 2^32-1]), got ' + String(s));
                }
                seed = s;
            }
            if (options.b !== undefined) {
                const bb = options.b;
                if (typeof bb !== 'number' || bb !== bb || bb === Infinity || bb <= 1) {
                    throw new RangeError(
                        '[lite-adaptive] HeavyKeeper b (decay base) must be a finite number > 1, got ' + String(bb));
                }
                b = bb;
            }
        }

        this._d = d;
        this._w = w;
        this._k = k;
        this._seed = seed >>> 0;
        this._b = b;

        // the d x w SoA table (row-major, cell(r,c) = r*w + c): fingerprints + counts.
        this._fp = new Uint32Array(d * w);
        this._cnt = new Uint32Array(d * w);

        // the intrusive top-k min-heap (root = the minimum estimate among the k leaders).
        this._hkKey = new Float64Array(k);   // heap slot -> key
        this._hkEst = new Float64Array(k);   // heap slot -> estimate
        this._hkN = 0;                       // live heap size (<= k)

        // the open-addressed backshift map (key -> heap slot). Power-of-two cap >= 2k (LF <= 0.5).
        let mc = 16;
        while (mc < 2 * k) mc <<= 1;
        this._mapCap = mc;
        this._mapKey = new Float64Array(mc);  // NaN = empty slot (a valid key is a finite integer)
        this._mapPos = new Int32Array(mc);    // key -> heap slot
        this._mapKey.fill(NaN);
        this._mapSize = 0;

        // the decay-probability LUT: lut[c] = b^(-c) in (0, 1] for c in [0, HK_LUT_SIZE).
        this._decayLut = new Float64Array(HK_LUT_SIZE);
        for (let i = 0; i < HK_LUT_SIZE; i++) this._decayLut[i] = Math.pow(b, -i);

        // the seeded xorshift32 state (kept SIGNED int32 so it never boxes). Derived from the
        // seed via a nonzero-forcing mix so seed=0 is a valid distinct, non-degenerate seed.
        this._rng0 = (hkFinal((seed ^ HK_RNG_SALT) | 0) | 1) | 0;
        this._rng = this._rng0;

        // a fixed memory figure (bytes): table + heap + map + LUT.
        this._bytes = (d * w) * 8 + k * 16 + mc * 12 + HK_LUT_SIZE * 8;
    }

    /**
     * Derive a HeavyKeeper from a target top-k size and a target relative error. Sets d = 4
     * (the paper's small-depth sweet spot) and a table width w = max(2k, ceil(1/targetError))
     * so collisions inject at most ~ targetError * N of the stream into any cell. Throws
     * [lite-adaptive] typeof-first on a bad k / targetError / option BEFORE any allocation.
     * @param {number} k  the top-k size; an integer >= 1.
     * @param {number} targetError  the target relative error; a number in (0, 1).
     * @param {object} [options] { seed?, b? } -- as the explicit constructor.
     * @returns {HeavyKeeper}
     */
    static withAccuracy(k, targetError, options) {
        if (typeof k !== 'number' || !Number.isInteger(k) || k < 1) {
            throw new RangeError(
                '[lite-adaptive] HeavyKeeper.withAccuracy k must be an integer >= 1, got ' + String(k));
        }
        if (typeof targetError !== 'number' || targetError !== targetError ||
            targetError <= 0 || targetError >= 1) {
            throw new RangeError(
                '[lite-adaptive] HeavyKeeper.withAccuracy targetError must be a number in (0, 1), got ' +
                String(targetError));
        }
        const d = 4;
        const w = Math.max(2 * k, Math.ceil(1 / targetError));
        return new HeavyKeeper(d, w, k, options);
    }

    /** Table depth d (rows / independent hashes). O(1). */
    get d() { return this._d; }
    /** Table width w (columns per row). O(1). */
    get w() { return this._w; }
    /** The top-k size. O(1). */
    get k() { return this._k; }
    /** The decay base b. O(1). */
    get b() { return this._b; }
    /** The hash / PRNG seed (uint32). O(1). */
    get seed() { return this._seed >>> 0; }
    /** A fixed memory figure in bytes (table + heap + map + LUT). O(1). */
    get bytes() { return this._bytes; }
    /** The number of keys currently in the top-k forest (<= k). O(1). */
    get size() { return this._hkN; }

    /**
     * Add `weight` occurrences of `key` (default 1). HOT, 0 B/op INCLUDING the decay draw and
     * the forest sift. `key` is a SAFE INTEGER; `weight` a positive integer (lite-hud passes
     * integer microseconds so it can rank by total time). Fail closed: a non-safe-integer key,
     * or a non-positive / non-integer / non-finite weight, throws [lite-adaptive] (typeof-first,
     * a BYTE-IDENTICAL no-op -- nothing is touched on a rejected add).
     * @param {number} key    a safe integer.
     * @param {number} [weight] a positive integer (default 1).
     * @returns {HeavyKeeper} this
     */
    add(key, weight) {
        // typeof-first validation, BEFORE any state mutation.
        if (typeof key !== 'number' || !Number.isSafeInteger(key)) return this._badKey(key);
        let wt = weight;
        if (wt === undefined) {
            wt = 1;
        } else if (typeof wt !== 'number' || !Number.isSafeInteger(wt) || wt <= 0) {
            return this._badWeight(wt);
        }

        // --- the accumulate body (DUPLICATED in addFrom to keep this hot body byte-identical). ---
        hkHash(key, this._seed);
        const fp = HK_H1 >>> 0;
        const base = HK_H2;
        const d = this._d, w = this._w;
        const fps = this._fp, cnt = this._cnt;
        const lut = this._decayLut, b = this._b;
        let best = 0;
        for (let r = 0; r < d; r++) {
            const cell = r * w + hkPos(base, r, w);
            const c = cnt[cell];
            if (c === 0) {
                fps[cell] = fp;
                cnt[cell] = wt;
                if (wt > best) best = wt;
            } else if (fps[cell] === fp) {
                let nc = c + wt;
                if (nc > 4294967295) nc = 4294967295;   // clamp at uint32 max (no wrap on store)
                cnt[cell] = nc;
                if (nc > best) best = nc;
            } else {
                // fp MISS -> decay ONCE with probability b^(-count) (the SETTLED weighted rule).
                let x = this._rng | 0;
                x ^= x << 13; x ^= x >>> 17; x ^= x << 5;   // xorshift32 on a signed int32 (no box)
                this._rng = x | 0;
                const thr = c < HK_LUT_SIZE ? lut[c] : Math.pow(b, -c);
                if ((x >>> 0) / 4294967296 < thr) {
                    const dec = c - wt;
                    if (dec <= 0) { fps[cell] = fp; cnt[cell] = wt; if (wt > best) best = wt; }
                    else { cnt[cell] = dec; }
                }
            }
        }
        this._promote(key, best);
        return this;
    }

    /**
     * Add from a caller-owned PACKED `[key, weight]` Float64Array pair. HOT, 0 B/op ZERO-BOX --
     * key = buf[i], weight = buf[i+1] read UNBOXED. A large u32 key (near 2^31 or 2^32-1) boxes
     * as a plain `add` argument (a ~16 B HeapNumber at the non-inlined call boundary); this
     * reads it straight from the Float64Array. Same validation, throws, byte-identical-no-op-on-
     * reject, and accumulate as `add(key, weight)`; the body is DUPLICATED (not delegated) to
     * keep `add`'s hot body byte-identical and avoid re-boxing at an internal call boundary.
     *
     * Fail closed BEFORE any read (typeof-first): a non-Float64Array `buf`, or a non-integer /
     * negative / out-of-range `i` (needs `i + 1 < buf.length`) throws [lite-adaptive]. A
     * non-safe-integer key or a non-positive-integer weight then throws (a byte-identical no-op).
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = key, `buf[i+1]` = weight.
     * @param {number} i the base index of the [key, weight] pair (0, 2, 4, ...).
     * @returns {HeavyKeeper} this
     */
    addFrom(buf, i) {
        if (!(buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || i + 1 >= buf.length) return this._badBuf(buf, i);
        const key = buf[i];         // UNBOXED Float64Array reads -- the whole point (no arg box).
        const wt = buf[i + 1];      // packed [key, weight]
        if (!Number.isSafeInteger(key)) return this._badKey(key);
        if (!Number.isSafeInteger(wt) || wt <= 0) return this._badWeight(wt);

        // --- the accumulate body -- DUPLICATED from add() to keep add()'s hot body byte-identical. ---
        hkHash(key, this._seed);
        const fp = HK_H1 >>> 0;
        const base = HK_H2;
        const d = this._d, w = this._w;
        const fps = this._fp, cnt = this._cnt;
        const lut = this._decayLut, b = this._b;
        let best = 0;
        for (let r = 0; r < d; r++) {
            const cell = r * w + hkPos(base, r, w);
            const c = cnt[cell];
            if (c === 0) {
                fps[cell] = fp;
                cnt[cell] = wt;
                if (wt > best) best = wt;
            } else if (fps[cell] === fp) {
                let nc = c + wt;
                if (nc > 4294967295) nc = 4294967295;
                cnt[cell] = nc;
                if (nc > best) best = nc;
            } else {
                let x = this._rng | 0;
                x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
                this._rng = x | 0;
                const thr = c < HK_LUT_SIZE ? lut[c] : Math.pow(b, -c);
                if ((x >>> 0) / 4294967296 < thr) {
                    const dec = c - wt;
                    if (dec <= 0) { fps[cell] = fp; cnt[cell] = wt; if (wt > best) best = wt; }
                    else { cnt[cell] = dec; }
                }
            }
        }
        this._promote(key, best);
        return this;
    }

    /**
     * The estimated count of `key` -- the max count over the d cells whose fingerprint matches
     * (0 if none match). COLD, O(d). Fail closed: a non-safe-integer key throws [lite-adaptive]
     * (the SAME guard `add` applies -- an invalid key is never silently 0). An unseen but VALID
     * key reads 0 (null is not zero).
     * @param {number} key a safe integer.
     * @returns {number}
     */
    estimate(key) {
        if (typeof key !== 'number' || !Number.isSafeInteger(key)) return this._badKey(key);
        hkHash(key, this._seed);
        const fp = HK_H1 >>> 0;
        const base = HK_H2;
        const d = this._d, w = this._w;
        const fps = this._fp, cnt = this._cnt;
        let best = 0;
        for (let r = 0; r < d; r++) {
            const cell = r * w + hkPos(base, r, w);
            if (fps[cell] === fp) {
                const c = cnt[cell];
                if (c > best) best = c;
            }
        }
        return best;
    }

    /**
     * Iterate the current top-k, calling `fn(key, estimate)` per leader. HOT-SAFE, alloc-free
     * (HeavyKeeper allocates nothing; the order is heap order, NOT sorted). The PRIMARY read for
     * a render loop. NEVER throws (a non-function `fn` is a cold throw before iteration).
     * @param {(key: number, estimate: number) => void} fn
     */
    forEach(fn) {
        if (typeof fn !== 'function') return this._badFn(fn);
        const n = this._hkN, hk = this._hkKey, he = this._hkEst;
        for (let i = 0; i < n; i++) fn(hk[i], he[i]);
    }

    /**
     * Write the current top-k as packed [key, estimate] PAIRS into `buf` (2 Float64 slots per
     * entry: buf[2i] = key, buf[2i+1] = estimate), returning the ENTRY COUNT written (heap order,
     * NOT sorted). 0-alloc. Fail closed: `buf` must be a Float64Array of length >= 2*k (k = the
     * max entries the top-k forest can hold, so a full set never truncates silently) -- a smaller
     * buffer or a non-Float64Array throws [lite-adaptive] (a cold throw before any write).
     * @param {Float64Array} buf a caller-owned Float64Array of length >= 2*k.
     * @returns {number} the number of [key, estimate] entries written (<= k).
     */
    topKInto(buf) {
        if (!(buf instanceof Float64Array) || buf.length < 2 * this._k) return this._badTopKBuf(buf);
        const n = this._hkN;
        const hk = this._hkKey, he = this._hkEst;
        for (let i = 0; i < n; i++) { buf[i * 2] = hk[i]; buf[i * 2 + 1] = he[i]; }
        return n;
    }

    /**
     * The current top-k as an Array of { key, count }, sorted by count DESCENDING. COLD, MAY
     * ALLOCATE (a fresh array + objects) -- the hot / render path uses forEach / topKInto. NEVER
     * throws.
     * @returns {Array<{ key: number, count: number }>}
     */
    topK() {
        const n = this._hkN, hk = this._hkKey, he = this._hkEst;
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = { key: hk[i], count: he[i] };
        out.sort((a, c) => c.count - a.count);
        return out;
    }

    /**
     * Reset to empty; reuse every array (0-alloc), and reset the PRNG to its seeded initial
     * state (a cleared HeavyKeeper replays identically). O(d*w + mapCap).
     * @returns {HeavyKeeper} this
     */
    clear() {
        this._fp.fill(0);
        this._cnt.fill(0);
        this._mapKey.fill(NaN);
        this._mapSize = 0;
        this._hkN = 0;
        this._rng = this._rng0;
        return this;
    }

    /** @private Advance + return the xorshift32 PRNG as a uint32. Kept for tests / determinism. */
    _rand32() {
        let x = this._rng | 0;
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        this._rng = x | 0;
        return x >>> 0;
    }

    /**
     * @private Maintain the top-k min-forest after `key`'s estimate became `est`. If `key` is
     * already a leader, update its estimate + re-heapify; else if the heap has room, insert it;
     * else if `est` beats the current minimum leader, evict the min and insert `key`. 0-alloc.
     */
    _promote(key, est) {
        const pos = this._mapFind(key);
        if (pos >= 0) {
            this._hkEst[pos] = est;
            // est may have risen (fp hit) or fallen (a cell it relied on was decayed by another
            // key between adds) -- siftUp handles a decrease, siftDown the resulting/increase.
            this._siftDown(this._siftUp(pos));
            return;
        }
        // a brand-new key with NO table representation this add (every row an fp-miss with no
        // decay-replacement) is not a leader -- do not pollute the heap with a 0-estimate slot.
        if (est === 0) return;
        const n = this._hkN;
        if (n < this._k) {
            this._hkKey[n] = key;
            this._hkEst[n] = est;
            this._mapSet(key, n);
            this._hkN = n + 1;
            this._siftUp(n);
        } else if (est > this._hkEst[0]) {
            this._mapDel(this._hkKey[0]);
            this._hkKey[0] = key;
            this._hkEst[0] = est;
            this._mapSet(key, 0);
            this._siftDown(0);
        }
    }

    /** @private Swap heap slots a, b and keep the map positions in sync. 0-alloc. */
    _hswap(a, b) {
        const hk = this._hkKey, he = this._hkEst;
        const ka = hk[a], ea = he[a], kb = hk[b], eb = he[b];
        hk[a] = kb; he[a] = eb; hk[b] = ka; he[b] = ea;
        this._mapSet(kb, a);
        this._mapSet(ka, b);
    }

    /** @private Sift heap slot i toward the root while it is smaller than its parent. Returns its final index. */
    _siftUp(i) {
        const he = this._hkEst;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (he[p] <= he[i]) break;
            this._hswap(i, p);
            i = p;
        }
        return i;
    }

    /** @private Sift heap slot i toward the leaves while a child is smaller (min-heap). 0-alloc. */
    _siftDown(i) {
        const n = this._hkN, he = this._hkEst;
        for (;;) {
            const l = 2 * i + 1, r = 2 * i + 2;
            let m = i;
            if (l < n && he[l] < he[m]) m = l;
            if (r < n && he[r] < he[m]) m = r;
            if (m === i) break;
            this._hswap(i, m);
            i = m;
        }
    }

    /** @private Find `key`'s heap slot in the map, or -1. Linear probing. 0-alloc. */
    _mapFind(key) {
        const mask = this._mapCap - 1;
        const mk = this._mapKey, mp = this._mapPos;
        let i = hkMapHash(key, this._seed) & mask;
        while (mk[i] === mk[i]) {           // occupied (a NaN slot fails self-equality)
            if (mk[i] === key) return mp[i];
            i = (i + 1) & mask;
        }
        return -1;
    }

    /** @private Insert `key` -> `pos`, or update its stored pos if already present. 0-alloc. */
    _mapSet(key, pos) {
        const mask = this._mapCap - 1;
        const mk = this._mapKey, mp = this._mapPos;
        let i = hkMapHash(key, this._seed) & mask;
        while (mk[i] === mk[i]) {
            if (mk[i] === key) { mp[i] = pos; return; }
            i = (i + 1) & mask;
        }
        mk[i] = key;
        mp[i] = pos;
        this._mapSize++;
    }

    /** @private Delete `key` with Knuth backward-shift so the probe chains stay contiguous. 0-alloc. */
    _mapDel(key) {
        const mask = this._mapCap - 1;
        const mk = this._mapKey, mp = this._mapPos;
        let i = hkMapHash(key, this._seed) & mask;
        while (mk[i] === mk[i]) {
            if (mk[i] === key) break;
            i = (i + 1) & mask;
        }
        if (mk[i] !== mk[i]) return;   // not found
        this._mapSize--;
        let j = i;
        for (;;) {
            mk[i] = NaN;
            do {
                j = (j + 1) & mask;
                if (mk[j] !== mk[j]) return;         // hit an empty slot -> chain closed
                const home = hkMapHash(mk[j], this._seed) & mask;
                // keep mk[j] iff its home does NOT lie cyclically in (i, j] (it must not shift back).
                if (i <= j ? (home <= i || home > j) : (home <= i && home > j)) break;
            } while (true);
            mk[i] = mk[j]; mp[i] = mp[j]; i = j;
        }
    }

    /** @private Cold thrower for a bad key. */
    _badKey(key) {
        throw new TypeError(
            '[lite-adaptive] HeavyKeeper key must be a safe integer, got ' + String(key));
    }

    /** @private Cold thrower for a bad weight. */
    _badWeight(w) {
        throw new TypeError(
            '[lite-adaptive] HeavyKeeper weight must be a positive integer, got ' + String(w));
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] HeavyKeeper.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i + 1 < buf.length, got ' + String(buf) + ', ' + String(i));
    }

    /** @private Cold thrower for a too-small / non-Float64Array topKInto buffer. */
    _badTopKBuf(buf) {
        throw new TypeError(
            '[lite-adaptive] HeavyKeeper.topKInto(buf) needs a Float64Array of length >= 2*k (k=' +
            this._k + ', so it holds a full top-k as [key, estimate] pairs), got ' + String(buf));
    }

    /** @private Cold thrower for a non-function forEach callback. */
    _badFn(fn) {
        throw new TypeError(
            '[lite-adaptive] HeavyKeeper.forEach(fn) needs a function, got ' + String(fn));
    }
}

// ===========================================================================
// SlidingHyperLogLog (ADR 0006) -- windowed distinct-count (Chabchoub-Hebrail, 2010)
// ===========================================================================
//
// The RECENCY complement of lite-sketch's cumulative HyperLogLog: how many DISTINCT keys
// arrived in the LAST W, in FIXED preallocated space at HLL accuracy. An `m = 2^p` register
// bank where each register, instead of a single rho byte, keeps a small FIXED ring of
// (timestamp, rho) entries -- the LFPM (List of Future Possible Maxima), a per-register
// MONOTONIC DEQUE stored oldest -> newest with STRICTLY DECREASING rho. An entry can be the
// window-max at some future time only if no NEWER entry has a >= rho (a newer, larger-or-equal
// arrival dominates it forever, since it expires later); such dominated entries are dropped.
//
// HOT add(now, key) / addFrom(buf, i): the two-lane murmur (mirrored INLINE from lite-sketch
// Sketch.js, ADR 0001 there -- pure int32 locals, never an import) derives register j + rho;
// pop every tail entry with rho <= the new rho (now dominated), then append (now, rho). A full
// ring drops its OLDEST (head) entry -- it expires soonest -- and bumps `_overflows` (the honest
// degradation signal; `degraded` flips true). 0 B/op incl. that windowed eviction.
//
// COLD count(w?): lazily drop head entries with stamp <= now - W (expired), then take each
// register's windowed max = the rho of the OLDEST non-expired entry (or the first with stamp >
// now - w for a sub-window w <= W), fold the register multiplicity vector through Ertl's improved
// estimator (sigma / tau, alpha_inf; design-parity with lite-sketch, inline). The register value
// equals the HLL register of the in-window DISTINCT key set (a duplicate never lowers a max), so
// accuracy is the standard 1.04 / sqrt(m) standard error (no extra bias) when not degraded.
//
// TIME MODEL: a caller-supplied MONOTONE now (a logical tick or ms), or COUNT mode (auto-tick)
// when now is omitted; the mode LOCKS at the first add and a switch throws -- EXACTLY like
// ExponentialHistogram. addFrom is EXPLICIT-time only. No Math.random, no PRNG: fully
// deterministic given the seed.

/** Lowest legal precision (m = 16 registers). */
const SL_P_MIN = 4;
/** Highest legal precision (m = 65536 registers) -- bounds the ring memory m * ringCap * 9 B. */
const SL_P_MAX = 16;
/** Default precision p = 10 (m = 1024 registers). */
const SL_DEFAULT_P = 10;
/** Default per-register LFPM ring capacity (a power of two; the deque is bounded by ~q+1). */
const SL_DEFAULT_RINGCAP = 8;
/** Max per-register ring capacity (a power of two; ringCap >= q+1 makes overflow impossible). */
const SL_RINGCAP_MAX = 64;
/** Default per-instance seed (a uint32; SAME default as lite-sketch so a key hashes identically). */
const SL_DEFAULT_SEED = 0x9e3779b1;
/** alpha_inf = 1 / (2 * ln 2) -- the asymptotic bias constant of Ertl's improved estimator. */
const SL_ALPHA_INF = 0.5 / Math.LN2;
/** MurmurHash3 lane-decorrelation salt (SMI) -- mirrored INLINE from lite-sketch Sketch.js. */
const SL_LANE_SALT = 0x85ebca6b | 0;
/** Frozen marker of the known ctor option keys -- an unknown key is a throw with a did-you-mean. */
const SL_KNOWN_OPTS = Object.freeze({ p: true, ringCap: true, seed: true });

/** One MurmurHash3 body round (pure int32, zero-alloc) -- design-parity with lite-sketch. */
function slRound(h, k) {
    k = Math.imul(k, HK_C1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, HK_C2);
    h = h ^ k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    return h;
}

/** MurmurHash3 fmix32 finalizer -- the avalanche step (pure int32, zero-alloc). */
function slFinal(h) {
    h = h ^ (h >>> 16);
    h = Math.imul(h, HK_FC1);
    h = h ^ (h >>> 13);
    h = Math.imul(h, HK_FC2);
    h = h ^ (h >>> 16);
    return h;
}

/**
 * sigma -- the small-range correction series of Ertl's improved HyperLogLog estimator
 * (Ertl 2017). x is the fraction of EMPTY registers. Self-terminating (converges to a fixed
 * point), so it is table-free -- no HLL++ empirical bias tables. Cold (once per count()).
 * Reimplemented INLINE (design-parity with lite-sketch, never an import).
 */
function slSigma(x) {
    if (x === 1) return Infinity;
    let y = 1;
    let z = x;
    let prev;
    do {
        x = x * x;
        prev = z;
        z += x * y;
        y += y;
    } while (z !== prev);
    return z;
}

/**
 * tau -- the large-range correction series of Ertl's improved estimator (companion to slSigma).
 * x is 1 minus the fraction of SATURATED registers. Self-terminating fixed point; table-free.
 * Cold (once per count()). Reimplemented INLINE (design-parity with lite-sketch).
 */
function slTau(x) {
    if (x === 0 || x === 1) return 0;
    let y = 1;
    let z = 1 - x;
    let prev;
    do {
        x = Math.sqrt(x);
        prev = z;
        y *= 0.5;
        const d = 1 - x;
        z -= d * d * y;
    } while (z !== prev);
    return z / 3;
}

/**
 * SlidingHyperLogLog -- windowed DISTINCT-COUNT over the LAST W (a hard sliding window) in
 * FIXED space (Chabchoub-Hebrail, "Sliding HyperLogLog", 2010). The RECENCY sibling of
 * lite-sketch's cumulative HyperLogLog: an `m = 2^p` register bank where every register keeps a
 * small FIXED LFPM ring of `(timestamp, rho)` entries (a monotonic deque, strictly decreasing rho
 * head -> tail), so the head always holds the highest in-window rho.
 *
 * Headline (the family TRIPLE):
 *   - SPACE: a FIXED `m * ringCap` ring (Float64 stamp + Uint8 rho) -- `~ m * ringCap * 9 B`;
 *     never grows (p=10, ringCap=8 -> ~72 KB).
 *   - ERROR: STATISTICAL -- the standard `1.04 / sqrt(m)` HLL standard error (gated at ~3 sigma),
 *     since a register's windowed max rho equals the HLL register of the in-window distinct key
 *     set. GUARANTEED only while `degraded === false` (no ring overflowed).
 *   - RECENCY: a HARD last-W window (forgets EXACTLY at the window edge) with element-precise
 *     timestamps -- and a sub-window query `count(w)` for any `w <= W`.
 *
 * Hot path (`add` / `addFrom`, 0 B/op incl. the windowed eviction): the inline two-lane murmur,
 * the LFPM domination drop (pop dominated tail entries), and the append -- pure index
 * manipulation on preallocated columns. A full ring drops its oldest (head) entry and bumps
 * `overflows` (`degraded`) -- honest degradation, never an allocation or a silent wrong answer.
 *
 * Cold path: `count(w?)` is O(m) (a disclosed co-headline, NOT per-add) -- lazily expire, then
 * Ertl's improved estimator (2017), a single table-free formula accurate across the whole range;
 * `clear()` reuses the arrays.
 *
 * Fail closed: a bad W / p / ringCap / seed / option throws `[lite-adaptive]` at the ctor door
 * BEFORE any allocation; `add` / `addFrom` lock the mode at the first call and reject a mode
 * switch, a non-finite / decreasing `now`, or a non-safe-integer `key` -- typeof-first, a
 * BYTE-IDENTICAL no-op; `count` rejects a sub-window `w` outside `(0, W]`; getters never throw.
 * null is not zero (seed=0 is valid, guarded as `=== undefined`).
 */
export class SlidingHyperLogLog {
    /**
     * @param {number} W        window size; a finite number > 0 (items in count mode, or the
     *                          `now`-unit span in explicit mode).
     * @param {object} [options] { p?: precision integer in [4, 16] (default 10; m = 1 << p),
     *                ringCap?: per-register ring capacity, a power of two in [2, 64] (default 8;
     *                set >= q+1 to make overflow impossible), seed?: uint32 (default 0x9e3779b1;
     *                seed=0 is a valid distinct seed -- guarded as `undefined`, not falsy) }.
     *                An unknown key throws [lite-adaptive].
     */
    constructor(W, options) {
        // typeof guard FIRST, BEFORE any allocation (a bad param leaves no half-built instance).
        if (typeof W !== 'number' || W !== W || W === Infinity || W === -Infinity || W <= 0) {
            throw new RangeError(
                '[lite-adaptive] SlidingHyperLogLog W must be a finite number > 0, got ' + String(W));
        }
        let p = SL_DEFAULT_P;
        let ringCap = SL_DEFAULT_RINGCAP;
        let seed = SL_DEFAULT_SEED;
        if (options !== undefined) {
            if (typeof options !== 'object' || options === null) {
                throw new TypeError('[lite-adaptive] SlidingHyperLogLog options must be an object');
            }
            for (const key in options) {
                if (!(key in SL_KNOWN_OPTS)) {
                    throw new RangeError('[lite-adaptive] SlidingHyperLogLog unknown option "' + key + '"');
                }
            }
            if (options.p !== undefined) {
                const pp = options.p;
                if (typeof pp !== 'number' || (pp | 0) !== pp || pp < SL_P_MIN || pp > SL_P_MAX) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingHyperLogLog p must be an integer in [' + SL_P_MIN + ', ' +
                        SL_P_MAX + '], got ' + String(pp));
                }
                p = pp;
            }
            if (options.ringCap !== undefined) {
                const rc = options.ringCap;
                // a power of two in [2, 64] so the ring index is a & (ringCap - 1) mask (hot-path law).
                if (typeof rc !== 'number' || (rc | 0) !== rc || rc < 2 || rc > SL_RINGCAP_MAX ||
                    (rc & (rc - 1)) !== 0) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingHyperLogLog ringCap must be a power of two in [2, ' +
                        SL_RINGCAP_MAX + '], got ' + String(rc));
                }
                ringCap = rc;
            }
            // seed=0 is a VALID distinct seed -- guard `undefined`, not falsy (null is not zero).
            if (options.seed !== undefined) {
                const s = options.seed;
                if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || s > 4294967295) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingHyperLogLog seed must be a uint32 (integer in [0, 2^32-1]), got ' +
                        String(s));
                }
                seed = s;
            }
        }

        this._W = W;
        this._p = p;
        this._m = 1 << p;
        this._ringCap = ringCap;
        this._mask = ringCap - 1;
        this._seed = seed | 0;   // SMI-safe signed int32; the murmur uses it as `s | 0` either way
        // q = 64 - p: the number of hash suffix bits -> rho in [0, q+1]; _hist is the reused
        // Ertl multiplicity vector (scratch for count(), so count() itself allocates nothing).
        this._q = 64 - p;

        const cells = this._m * ringCap;
        // per-register LFPM ring columns (register j occupies cells [j*ringCap, j*ringCap+ringCap)):
        this._stamps = new Float64Array(cells);   // entry timestamp (most-recent element time)
        this._rho = new Uint8Array(cells);        // entry rho (leftmost-1 position of the hash suffix)
        this._head = new Int32Array(this._m);     // per-register ring head offset (oldest entry)
        this._len = new Int32Array(this._m);      // per-register live entry count
        this._hist = new Int32Array(this._q + 2); // Ertl multiplicity vector (reused count() scratch)

        // a fixed memory figure (bytes): stamps + rho + head + len + hist.
        this._bytes = cells * 8 + cells + this._m * 8 + (this._q + 2) * 4;

        this._initState();
    }

    /** @private Reset the ring heads/lengths + time mode + overflow counter. Reused by clear(). 0 alloc. */
    _initState() {
        this._head.fill(0);
        this._len.fill(0);
        this._overflows = 0;         // count of ring overflows (any > 0 -> degraded)
        this._mode = MODE_UNSET;     // time mode, locked at the first add
        this._tick = 0;              // count-mode logical clock
        // monotone guard: 0, NOT -Infinity -- the first explicit add takes the UNSET branch and sets
        // _lastNow to a real timestamp BEFORE the EXPLICIT branch ever compares it, so the init value
        // is never read. Keeping it a plain SMI (not the double -Infinity) means a hot clear() loop
        // with integer timestamps never oscillates the field SMI<->double (no HeapNumber box).
        this._lastNow = 0;           // explicit-mode monotone guard (init value never compared)
        this._now = 0;               // the last applied t (query cutoff = now - W)
    }

    /** Window size W. O(1). */
    get W() { return this._W; }
    /** Precision p. O(1). */
    get p() { return this._p; }
    /** Register count m = 2^p. O(1). */
    get m() { return this._m; }
    /** Per-register LFPM ring capacity. O(1). */
    get ringCap() { return this._ringCap; }
    /** The uint32 hash seed. O(1). */
    get seed() { return this._seed >>> 0; }
    /** The theoretical standard error 1.04 / sqrt(m) (guaranteed only while not degraded). O(1). */
    get standardError() { return 1.04 / Math.sqrt(this._m); }
    /** The last applied time t (0 before the first add). O(1). */
    get lastNow() { return this._now; }
    /** The locked time mode: 'unset' | 'explicit' | 'count'. O(1). */
    get mode() {
        return this._mode === MODE_EXPLICIT ? 'explicit' : this._mode === MODE_COUNT ? 'count' : 'unset';
    }
    /** The number of ring overflows so far (any > 0 -> the accuracy bound is no longer guaranteed). O(1). */
    get overflows() { return this._overflows; }
    /** True once a ring overflowed (the 1.04/sqrt(m) bound is no longer guaranteed). O(1). */
    get degraded() { return this._overflows > 0; }
    /** A fixed memory figure in bytes (stamps + rho + head + len + hist). O(1). */
    get bytes() { return this._bytes; }

    /**
     * Add one element `key` observed at `now`. HOT, 0 B/op INCLUDING the windowed eviction.
     *
     * Time modes (LOCKED at the first add, a switch throws):
     *   - EXPLICIT: add(now, key). `now` is a finite number, strictly NON-DECREASING across calls.
     *   - COUNT: add(undefined, key). The member auto-increments an internal tick per add (the
     *     "last N items" convenience; W is then measured in items).
     *
     * Fail closed: a non-safe-integer key, a mode switch, a non-finite `now`, or a `now` going
     * backwards throws [lite-adaptive] (typeof-first, a BYTE-IDENTICAL no-op -- nothing is
     * touched on a rejected add).
     * @param {number} [now] the monotone time (omit for count mode).
     * @param {number} key   a safe integer.
     * @returns {SlidingHyperLogLog} this
     */
    add(now, key) {
        // validate the key FIRST, before ANY state mutation (typeof-first, no alloc).
        if (typeof key !== 'number' || !Number.isSafeInteger(key)) return this._badKey(key);
        // resolve the timestamp + lock/verify the mode (typeof-first, no alloc).
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

        // --- the inline two-lane murmur (pure int32 locals; lanes never touch a module slot, so a
        //     uint32 >= 2^31 lane never boxes a HeapNumber -- design-parity with lite-sketch HLL). ---
        let a = key, neg = 0;
        if (a < 0) { a = -a; neg = 1; }
        const lo = a >>> 0;
        const hiw = a < 4294967296 ? 0 : (Math.floor(a / 4294967296) >>> 0);
        const seed = this._seed;
        let hh = seed | 0;
        hh = slRound(hh, lo);
        hh = slRound(hh, hiw ^ neg);
        hh = slFinal(hh ^ 8);
        let gg = (seed ^ SL_LANE_SALT) | 0;
        gg = slRound(gg, lo);
        gg = slRound(gg, hiw ^ neg);
        gg = slFinal(gg ^ 8);
        const p = this._p;
        const j = hh >>> (32 - p);
        // hiSuf kept SIGNED (no `>>> 0`): Math.clz32 does its own ToUint32 and `!== 0` is
        // equivalent, so a uint32 >= 2^31 never materializes as a tagged HeapNumber inside this
        // hot body (the box a `>>> 0` would force once the function is large -- proven via torture).
        const hiSuf = hh << p;
        const rho = hiSuf !== 0 ? Math.clz32(hiSuf) + 1 : (32 - p) + Math.clz32(gg) + 1;

        // --- the LFPM ring push: pop every dominated tail entry (rho <= new rho), append (t, rho);
        //     a full ring drops its oldest (head) entry and bumps overflows (honest degradation). ---
        const cap = this._ringCap, mask = this._mask;
        const base = j * cap;
        const stamps = this._stamps, rhos = this._rho;
        const heads = this._head, lens = this._len;
        let head = heads[j];
        let len = lens[j];
        while (len > 0) {
            const tailCell = base + ((head + len - 1) & mask);
            if (rhos[tailCell] <= rho) len--; else break;
        }
        if (len === cap) { head = (head + 1) & mask; len--; this._overflows++; }
        const at = base + ((head + len) & mask);
        stamps[at] = t;
        rhos[at] = rho;
        heads[j] = head;
        lens[j] = len + 1;
        return this;
    }

    /**
     * Add one element from a caller-owned PACKED `[now, key]` Float64Array pair. HOT, 0 B/op --
     * the ZERO-BOX entry: `now = buf[i]` (a fractional / epoch-ms double) and `key = buf[i + 1]`
     * (a safe integer that may exceed 2^31) are read UNBOXED straight from the array, avoiding the
     * ~16 B HeapNumber each would box as a plain argument at a non-inlined call boundary. The
     * caller writes a `Float64Array(2)` scratch and calls `addFrom(scratch, 0)` (a batch steps `i`
     * by 2). Identical validation, throws, byte-identical-no-op-on-reject, and ring reshaping as
     * `add(now, key)`; the body is DUPLICATED (not delegated) to keep `add`'s hot body byte-
     * identical and avoid re-boxing at an internal call boundary.
     *
     * EXPLICIT-time ONLY: addFrom always carries a `now`, so a COUNT-locked instance rejects it and
     * the first addFrom locks EXPLICIT mode. Fail closed BEFORE any read (typeof-first): a
     * non-Float64Array `buf`, or a non-integer / negative / out-of-range `i` (needs
     * `i + 1 < buf.length`) throws [lite-adaptive].
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = now, `buf[i+1]` = key.
     * @param {number} i the base index of the [now, key] pair (0, 2, 4, ...).
     * @returns {SlidingHyperLogLog} this
     */
    addFrom(buf, i) {
        // Guard the buffer + index on the COLD branch first (a bad handle is a byte-identical no-op).
        if (!(buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || i + 1 >= buf.length) return this._badBuf(buf, i);
        const now = buf[i];       // UNBOXED Float64Array reads -- the whole point (no argument box).
        const key = buf[i + 1];   // packed [now, key]
        if (!Number.isSafeInteger(key)) return this._badKey(key);
        // addFrom is an EXPLICIT-time entry: reject a count-locked instance, else lock/verify EXPLICIT.
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

        // --- the inline two-lane murmur -- DUPLICATED from add() to keep add()'s hot body byte-identical. ---
        let a = key, neg = 0;
        if (a < 0) { a = -a; neg = 1; }
        const lo = a >>> 0;
        const hiw = a < 4294967296 ? 0 : (Math.floor(a / 4294967296) >>> 0);
        const seed = this._seed;
        let hh = seed | 0;
        hh = slRound(hh, lo);
        hh = slRound(hh, hiw ^ neg);
        hh = slFinal(hh ^ 8);
        let gg = (seed ^ SL_LANE_SALT) | 0;
        gg = slRound(gg, lo);
        gg = slRound(gg, hiw ^ neg);
        gg = slFinal(gg ^ 8);
        const p = this._p;
        const j = hh >>> (32 - p);
        // hiSuf kept SIGNED (no `>>> 0`) -- see add() for why (avoids a tagged-HeapNumber box).
        const hiSuf = hh << p;
        const rho = hiSuf !== 0 ? Math.clz32(hiSuf) + 1 : (32 - p) + Math.clz32(gg) + 1;

        // --- the LFPM ring push (see add() for the full commentary) ---
        const cap = this._ringCap, mask = this._mask;
        const base = j * cap;
        const stamps = this._stamps, rhos = this._rho;
        const heads = this._head, lens = this._len;
        let head = heads[j];
        let len = lens[j];
        while (len > 0) {
            const tailCell = base + ((head + len - 1) & mask);
            if (rhos[tailCell] <= rho) len--; else break;
        }
        if (len === cap) { head = (head + 1) & mask; len--; this._overflows++; }
        const at = base + ((head + len) & mask);
        stamps[at] = t;
        rhos[at] = rho;
        heads[j] = head;
        lens[j] = len + 1;
        return this;
    }

    /**
     * The windowed DISTINCT-COUNT estimate over the last W (or a sub-window `w <= W`). Lazily
     * expires ring entries with `stamp <= now - W`, takes each register's windowed max rho, and
     * runs Ertl's improved estimator (2017). COLD, O(m + total entries) (a disclosed co-headline,
     * NOT per-add): 0 alloc (the multiplicity vector is the reused `_hist`). Standard error
     * 1.04 / sqrt(m), guaranteed only while `degraded === false`. Returns 0 on an empty window.
     *
     * Fail closed: a sub-window `w` outside `(0, W]` (non-finite, <= 0, or > W) throws
     * [lite-adaptive]; `w` omitted queries the full window W.
     * @param {number} [w] an optional sub-window in `(0, W]` (omit for the full window W).
     * @returns {number}
     */
    count(w) {
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) {
                return this._badWindow(w);
            }
            effW = w;
        }
        if (this._mode === MODE_UNSET) return 0;
        const now = this._now;
        const fullCut = now - this._W;   // permanent expiry cutoff (entries this old can never return)
        const subCut = now - effW;       // sub-window cutoff (>= fullCut)
        const m = this._m, cap = this._ringCap, mask = this._mask;
        const stamps = this._stamps, rhos = this._rho;
        const heads = this._head, lens = this._len;
        const q = this._q;
        const C = this._hist;
        C.fill(0);
        for (let jj = 0; jj < m; jj++) {
            const base = jj * cap;
            let head = heads[jj];
            let len = lens[jj];
            // destructive full-W expiry from the head (oldest first).
            while (len > 0 && stamps[base + (head & mask)] <= fullCut) { head = (head + 1) & mask; len--; }
            heads[jj] = head; lens[jj] = len;
            // non-destructive sub-window scan: the first entry with stamp > subCut is the OLDEST
            // in-window entry, which carries the HIGHEST rho (rho decreases head -> tail).
            let maxRho = 0;
            let idx = head, rem = len;
            while (rem > 0) {
                const cell = base + (idx & mask);
                if (stamps[cell] > subCut) { maxRho = rhos[cell]; break; }
                idx = (idx + 1) & mask; rem--;
            }
            C[maxRho]++;
        }
        // Ertl improved estimator: z accumulates the corrected inverse-sum.
        let z = m * slTau((m - C[q + 1]) / m);   // large-range (saturated) correction
        for (let k = q; k >= 1; k--) z = 0.5 * (z + C[k]);
        z += m * slSigma(C[0] / m);              // small-range (empty) correction
        return Math.round(SL_ALPHA_INF * m * m / z);
    }

    /**
     * The primary windowed estimate -- an alias of count() over the full window W. COLD. Fails
     * closed only on an out-of-range sub-window (never here, no arg). NEVER throws.
     * @returns {number}
     */
    query() { return this.count(); }

    /** Reset to the empty window; reuse every array (0-alloc), unlock the mode. O(m). @returns {SlidingHyperLogLog} this */
    clear() {
        this._initState();
        return this;
    }

    /** @private Cold thrower for a bad key. */
    _badKey(key) {
        throw new TypeError(
            '[lite-adaptive] SlidingHyperLogLog key must be a safe integer, got ' + String(key));
    }

    /** @private Cold thrower for a mode switch after the mode locked. */
    _badMode(locked, attempted) {
        throw new TypeError(
            '[lite-adaptive] SlidingHyperLogLog mode is locked to ' + locked +
            ' at the first add; got a ' + attempted + '-mode add');
    }

    /** @private Cold thrower for a non-finite `now`. */
    _badNow(now) {
        throw new TypeError(
            '[lite-adaptive] SlidingHyperLogLog add now must be a finite number, got ' + String(now));
    }

    /** @private Cold thrower for a non-monotone `now`. */
    _badMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] SlidingHyperLogLog add now must be non-decreasing: got ' + String(now) +
            ' after ' + String(this._lastNow));
    }

    /** @private Cold thrower for a bad sub-window `w`. */
    _badWindow(w) {
        throw new RangeError(
            '[lite-adaptive] SlidingHyperLogLog count sub-window w must be a finite number in (0, W] (W=' +
            this._W + '), got ' + String(w));
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] SlidingHyperLogLog.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i + 1 < buf.length, got ' + String(buf) + ', ' + String(i));
    }
}

// ===========================================================================
// DriftDetector (ADR 0007) -- scalar, O(1)-state streaming drift detection
// (Page, Biometrika 1954; Mouss et al. 2004)
// ===========================================================================
//
// DriftDetector is the SCALAR, item-based, fixed-scalar-state complement to ADWIN: it
// detects a shift in the MEAN of a real-valued signal in O(1) STATE (a handful of scalars,
// no pool, no window -- like ForwardDecay) and returns true EXACTLY on the detecting item.
// A single class selects one of two classical tests via a mode const:
//
//   DRIFT_PH    -- Page-Hinkley (Page 1954; Mouss-Mouss-Linkens-Sellami 2004). It accumulates
//                  the deviation of each x from the RUNNING MEAN and watches the gap between the
//                  cumulative sum and its running extreme; a persistent one-directional drift
//                  makes the gap exceed the threshold lambda. Two-sided: an upward accumulator
//                  gP (with a -delta magnitude allowance) tracked against its running MIN, and a
//                  downward accumulator gN (+delta) tracked against its running MAX.
//   DRIFT_CUSUM -- two-sided CUSUM (Page 1954). Two accumulators gP (upward) / gN (downward),
//                  each FLOORED at 0 (reset to 0 whenever it would go negative), grow only while
//                  the signal drifts past the slack delta; either exceeding the decision interval
//                  (threshold) fires.
//
// On a POSITIVE detection the accumulators + running mean are RESET (the standard PH / CUSUM
// discipline) so the detector recalibrates to the new concept and catches the NEXT shift.
//
// DDM / EDDM are deliberately OUT of this class: they consume a Bernoulli ERROR-BIT stream
// (a classifier's 0/1 correctness) and emit a TRI-STATE (stable / warning / drift) output, a
// different contract from a real-valued add(x) -> boolean. They belong in a future member.

/** The two DriftDetector modes. Numeric consts (parity with the internal mode sentinels). */
export const DRIFT_PH = 0;
export const DRIFT_CUSUM = 1;

/** Frozen marker of the known ctor option keys -- an unknown key is a throw with a did-you-mean. */
const DD_KNOWN_OPTS = Object.freeze({ delta: true, threshold: true, target: true });

/** Default magnitude allowance (PH) / slack (CUSUM): 0 is a valid, meaningful setting (null is not zero). */
const DD_DEFAULT_DELTA = 0.005;
/** Default threshold (PH lambda / CUSUM decision interval); tune to the signal's scale. */
const DD_DEFAULT_THRESHOLD = 50;
/**
 * DD_X_MAX -- the largest |x| the hot path accepts (1e150). A finite const, far below Double.MAX,
 * so the running accumulators cannot silently overflow to a non-finite value (the ADWIN
 * finite-square-overflow lesson): each add moves gP / gN by at most ~2*DD_X_MAX, and both
 * accumulators are BOUNDED between resets -- CUSUM floors at 0 and fires (then resets) at the
 * finite threshold; PH resets at the finite threshold too. Reaching Double.MAX from a 1e150 step
 * would need ~1e158 un-fired adds -- physically unreachable -- and a single add can never
 * overflow. |x| > DD_X_MAX is rejected fail-closed via the cold _badValue thrower (one extra
 * comparison on the COLD reject branch -- 0 hot-path bytes). Astronomically above any real signal.
 */
const DD_X_MAX = 1e150;

/**
 * DriftDetector -- a SCALAR, O(1)-STATE streaming drift detector over a real-valued signal,
 * selected by a mode const (DRIFT_PH or DRIFT_CUSUM). It maintains a running mean plus one or
 * two bounded test accumulators (no pool, no window -- pure scalars, like ForwardDecay) and
 * returns true EXACTLY on the item that trips the threshold, then RESETS so it can catch the
 * next shift.
 *
 * The mode is LOAD-BEARING via the reference the test deviates from (see ADR 0007): under a
 * SHARED reference the two rules collapse to the identical reflected-random-walk statistic
 * (CUSUM's max(0, cumsum) is exactly cumsum minus its running min -- what Page-Hinkley computes),
 * so they must NOT share one. DRIFT_PH deviates from the ONLINE running mean (self-referencing,
 * adaptive -- it tracks a slow ramp and stays quiet); DRIFT_CUSUM deviates from a FIXED `target`
 * mu0 (the classic SPC in-control mean -- it accumulates whenever the signal departs mu0). They
 * genuinely diverge on the same stream.
 *
 * Headline (the recency TRIPLE):
 *   - SPACE: O(1) -- six scalars, no allocation ever (the lightest member).
 *   - ERROR: the threshold trades detection latency against false alarms (larger threshold ->
 *     fewer false alarms, longer latency); delta is the magnitude/slack the test ignores.
 *   - RECENCY: a SCALAR change signal (vs EH's hard window, ADWIN's adaptive window, or
 *     ForwardDecay's smooth decay) -- "did the mean of this signal just shift?"
 *
 * Hot path (`add(x)`, 0 B/op): reject a non-finite / out-of-domain x on the cold branch, update
 * the running mean (Welford, O(1)), run the ONE mode branch (a couple of adds + compares), and
 * on a fire call the O(1) reset. No objects, no closures, no array literals.
 *
 * Fail closed: a bad mode / delta / threshold / option throws `[lite-adaptive]` at the ctor door
 * BEFORE any field init; `add(x)` validates x (a finite number with |x| <= DD_X_MAX) typeof-first,
 * BEFORE any state mutation -- a rejected add is a BYTE-IDENTICAL no-op; the statistic / mean
 * getters throw `[lite-adaptive]` if an accumulator ever reaches a non-finite value (fail-closed,
 * never a silent 0 / NaN); getters never throw on empty (return 0). null is not zero.
 */
export class DriftDetector {
    /**
     * @param {number} mode  DRIFT_PH or DRIFT_CUSUM.
     * @param {object} [options] per-mode knobs:
     *   - delta: the magnitude allowance (PH) / slack (CUSUM); a finite number in [0, 1e150]
     *     (default 0.005). delta = 0 is a VALID, meaningful setting.
     *   - threshold: the decision level (PH lambda / CUSUM decision interval); a finite number
     *     > 0 (default 50). Tune to the signal's scale.
     *   - target: the FIXED in-control mean mu0 the CUSUM test deviates from; a finite number,
     *     ANY sign, |target| <= 1e150 (target = 0 is VALID). REQUIRED for DRIFT_CUSUM; FORBIDDEN
     *     for DRIFT_PH (which uses the online running mean -- fail-closed, never a silent ignore).
     *   An unknown key throws [lite-adaptive].
     */
    constructor(mode, options) {
        // typeof / value guard FIRST, BEFORE any field init (a bad param leaves no half-built instance).
        if (mode !== DRIFT_PH && mode !== DRIFT_CUSUM) {
            throw new RangeError(
                '[lite-adaptive] DriftDetector mode must be DRIFT_PH or DRIFT_CUSUM, got ' + String(mode));
        }
        let delta = DD_DEFAULT_DELTA;
        let threshold = DD_DEFAULT_THRESHOLD;
        let target;   // undefined = no fixed reference (PH); a finite mu0 is REQUIRED for CUSUM.
        if (options !== undefined) {
            if (typeof options !== 'object' || options === null) {
                throw new TypeError('[lite-adaptive] DriftDetector options must be an object');
            }
            for (const key in options) {
                if (!(key in DD_KNOWN_OPTS)) {
                    throw new RangeError('[lite-adaptive] DriftDetector unknown option "' + key + '"');
                }
            }
            // delta = 0 is VALID -- guard `undefined`, not falsy (null is not zero). delta is capped at
            // DD_X_MAX (like x) so the accumulators cannot be driven non-finite by a pathological delta
            // (each add moves gP/gN by ~delta; an uncapped delta near Double.MAX would overflow them in a
            // few adds and add() would silently stop firing -- a fail-open boolean). Fail closed instead.
            if (options.delta !== undefined) {
                const d = options.delta;
                if (typeof d !== 'number' || d !== d || d === Infinity || d === -Infinity ||
                    d < 0 || d > DD_X_MAX) {
                    throw new RangeError(
                        '[lite-adaptive] DriftDetector delta must be a finite number in [0, 1e150], got ' + String(d));
                }
                delta = d;
            }
            if (options.threshold !== undefined) {
                const th = options.threshold;
                if (typeof th !== 'number' || th !== th || th === Infinity || th === -Infinity || th <= 0) {
                    throw new RangeError(
                        '[lite-adaptive] DriftDetector threshold must be a finite number > 0, got ' + String(th));
                }
                threshold = th;
            }
            // target = 0 is VALID -- guard `undefined`, not falsy (null is not zero). Capped at DD_X_MAX
            // (symmetry with x) so `x - target` stays finite. Mode coherence is enforced below.
            if (options.target !== undefined) {
                const tg = options.target;
                if (typeof tg !== 'number' || tg !== tg || tg === Infinity || tg === -Infinity ||
                    tg > DD_X_MAX || tg < -DD_X_MAX) {
                    throw new RangeError(
                        '[lite-adaptive] DriftDetector target must be a finite number with |target| <= 1e150, got ' +
                        String(tg));
                }
                target = tg;
            }
        }
        // Mode / target coherence -- fail-closed, no silent ignore (the mode is load-bearing):
        //   DRIFT_CUSUM tests against a FIXED target mu0 -> it is REQUIRED.
        //   DRIFT_PH tests against the ONLINE running mean -> a target is FORBIDDEN (meaningless).
        if (mode === DRIFT_CUSUM) {
            if (target === undefined) {
                throw new RangeError(
                    '[lite-adaptive] DriftDetector DRIFT_CUSUM requires a finite `target` (the in-control mean mu0)');
            }
        } else if (target !== undefined) {
            throw new RangeError(
                '[lite-adaptive] DriftDetector `target` is only valid for DRIFT_CUSUM ' +
                '(DRIFT_PH uses the online running mean)');
        }
        this._mode = mode;
        this._delta = delta;
        this._threshold = threshold;
        this._target = target;   // a finite mu0 for CUSUM; undefined for PH (config, never reset)
        this._initState();
    }

    /** @private Reset all scalar state to empty. Reused by clear(). 0 alloc. */
    _initState() {
        this._n = 0;          // items seen since the last reset
        this._mean = 0;       // running mean of the signal
        this._gP = 0;         // upward accumulator (PH cumulative +dev; CUSUM floored +dev)
        this._gN = 0;         // downward accumulator (PH cumulative +dev; CUSUM floored -dev)
        this._mMin = 0;       // PH running MIN of gP
        this._mMax = 0;       // PH running MAX of gN
    }

    /** The detector mode (DRIFT_PH or DRIFT_CUSUM). O(1). */
    get mode() { return this._mode; }
    /** The magnitude allowance (PH) / slack (CUSUM). O(1). */
    get delta() { return this._delta; }
    /** The decision level (PH lambda / CUSUM decision interval). O(1). */
    get threshold() { return this._threshold; }
    /** The fixed CUSUM target mu0 (the reference the test deviates from); undefined for PH. O(1). */
    get target() { return this._target; }
    /** The number of items seen since the last reset (a fire resets it). O(1). */
    get count() { return this._n; }
    /** The running mean of the signal (0 on empty). O(1). Throws if an accumulator overflowed. */
    get mean() {
        if (this._n <= 0) return 0;
        this._guardFinite();
        return this._mean;
    }
    /**
     * The current test statistic (>= 0): how close the detector is to firing. For PH it is the
     * larger of the up-gap (gP - runningMin) and the down-gap (runningMax - gN); for CUSUM it is
     * max(gP, gN). It crosses `threshold` exactly when `add` returns true. 0 on empty. O(1).
     * Throws [lite-adaptive] if an accumulator overflowed (fail-closed, never a silent NaN).
     */
    get statistic() {
        if (this._n <= 0) return 0;
        this._guardFinite();
        if (this._mode === DRIFT_PH) {
            const up = this._gP - this._mMin;
            const dn = this._mMax - this._gN;
            return up > dn ? up : dn;
        }
        return this._gP > this._gN ? this._gP : this._gN;
    }

    /**
     * Add one value to the signal. HOT, 0 B/op. Updates the running mean, runs the ONE mode branch,
     * and returns true EXACTLY on the item that trips the threshold (drift detected), resetting the
     * accumulators + running mean so the NEXT shift is caught.
     *
     * Fail closed: a non-number / NaN / +-Infinity x, or a finite |x| > DD_X_MAX (1e150, so the
     * running accumulators cannot overflow), throws [lite-adaptive] (typeof-first, a BYTE-IDENTICAL
     * no-op -- nothing is accumulated).
     * @param {number} x  a finite real value with |x| <= DD_X_MAX.
     * @returns {boolean} true iff drift was detected on this item.
     */
    add(x) {
        // typeof guard FIRST, BEFORE any state mutation, so a rejected add is a byte-identical no-op.
        if (typeof x !== 'number' || x !== x || x === Infinity || x === -Infinity ||
            x > DD_X_MAX || x < -DD_X_MAX) {
            return this._badValue(x);
        }
        const n = this._n + 1;
        this._n = n;
        // Welford running mean (O(1), no accumulated sum to overflow -- bounded by the x range). It
        // is the PH reference AND the CUSUM `mean` observability getter (CUSUM's TEST uses target).
        const mean = this._mean + (x - this._mean) / n;
        this._mean = mean;
        const delta = this._delta;
        const th = this._threshold;
        if (this._mode === DRIFT_PH) {
            // Page-Hinkley two-sided: cumulative deviation from the ONLINE running mean, watched
            // against its running extreme (a self-referencing / adaptive reference).
            const dev = x - mean;
            const gP = this._gP + (dev - delta);   // upward cumulative
            const gN = this._gN + (dev + delta);   // downward cumulative
            this._gP = gP;
            this._gN = gN;
            if (gP < this._mMin) this._mMin = gP;   // running MIN (upward reference)
            if (gN > this._mMax) this._mMax = gN;   // running MAX (downward reference)
            if (gP - this._mMin > th || this._mMax - gN > th) { this._reset(); return true; }
            return false;
        }
        // Two-sided CUSUM: deviation from the FIXED target mu0 (the classic SPC in-control mean),
        // two accumulators each floored at 0, fire at the decision interval. The fixed reference is
        // what makes CUSUM genuinely differ from PH (see ADR 0007).
        const dev = x - this._target;
        let gP = this._gP + dev - delta;
        if (gP < 0) gP = 0;
        let gN = this._gN - dev - delta;
        if (gN < 0) gN = 0;
        this._gP = gP;
        this._gN = gN;
        if (gP > th || gN > th) { this._reset(); return true; }
        return false;
    }

    /**
     * Add one value read UNBOXED from a caller-owned Float64Array (`x = buf[i]`). HOT, 0 B/op --
     * the ZERO-BOX sibling of `add(x)` for a caller whose `x` is a FRACTIONAL double: `add(x)` boxes
     * a fractional argument into a ~16 B HeapNumber at a non-inlined call boundary; this reads it
     * UNBOXED straight from the array. Identical validation, throws, byte-identical-no-op-on-reject,
     * and detection as `add(x)`; the body is DUPLICATED from `add` (not delegated) to keep `add`'s
     * hot body byte-identical and avoid re-boxing at an internal call boundary.
     *
     * Fail closed BEFORE any read (typeof-first): a non-Float64Array `buf`, or a non-integer /
     * negative / out-of-range `i` (needs `i < buf.length`) throws [lite-adaptive]. A NaN /
     * +-Infinity `buf[i]`, or a finite |buf[i]| > DD_X_MAX, throws (a byte-identical no-op).
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = the value (|x| <= DD_X_MAX).
     * @param {number} i the index of the value to read.
     * @returns {boolean} true iff drift was detected on this item.
     */
    addFrom(buf, i) {
        // Guard the buffer + index on the COLD branch first (a bad handle is a byte-identical no-op).
        if (!(buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || i >= buf.length) return this._badBuf(buf, i);
        const x = buf[i];   // UNBOXED Float64Array read -- the whole point (no argument box).
        // validate x (a Float64Array read is always a number, so add()'s typeof branch is omitted).
        if (x !== x || x === Infinity || x === -Infinity ||
            x > DD_X_MAX || x < -DD_X_MAX) return this._badValue(x);
        const n = this._n + 1;
        this._n = n;
        const mean = this._mean + (x - this._mean) / n;   // DUPLICATED from add()
        this._mean = mean;
        const delta = this._delta;
        const th = this._threshold;
        if (this._mode === DRIFT_PH) {
            const dev = x - mean;   // PH: deviation from the ONLINE running mean
            const gP = this._gP + (dev - delta);
            const gN = this._gN + (dev + delta);
            this._gP = gP;
            this._gN = gN;
            if (gP < this._mMin) this._mMin = gP;
            if (gN > this._mMax) this._mMax = gN;
            if (gP - this._mMin > th || this._mMax - gN > th) { this._reset(); return true; }
            return false;
        }
        const dev = x - this._target;   // CUSUM: deviation from the FIXED target mu0
        let gP = this._gP + dev - delta;
        if (gP < 0) gP = 0;
        let gN = this._gN - dev - delta;
        if (gN < 0) gN = 0;
        this._gP = gP;
        this._gN = gN;
        if (gP > th || gN > th) { this._reset(); return true; }
        return false;
    }

    /**
     * @private Reset the accumulators + running mean on a positive detection (the standard PH /
     * CUSUM discipline) so the detector recalibrates to the new concept. 0 alloc. A dedicated
     * method (not _initState) so a witness control can disable ONLY the reset without breaking
     * construction / clear().
     */
    _reset() {
        this._n = 0;
        this._mean = 0;
        this._gP = 0;
        this._gN = 0;
        this._mMin = 0;
        this._mMax = 0;
    }

    /** Reset all scalar state; keep the mode / delta / threshold. O(1). @returns {DriftDetector} this */
    clear() {
        this._initState();
        return this;
    }

    /** @private Cold thrower for a bad value. */
    _badValue(x) {
        throw new TypeError(
            '[lite-adaptive] DriftDetector add x must be a finite number with |x| <= 1e150, got ' + String(x));
    }

    /**
     * @private Fail-closed guard for the statistic / mean getters: an accumulator that reached a
     * non-finite value must THROW, never silently read 0 / NaN. Cold path, 0 hot cost. Mirrors
     * ADWIN / ForwardDecay. (Unreachable via the public API given DD_X_MAX; defense-in-depth.)
     */
    _guardFinite() {
        const m = this._mean, gp = this._gP, gn = this._gN, mn = this._mMin, mx = this._mMax;
        if (m !== m || m === Infinity || m === -Infinity ||
            gp !== gp || gp === Infinity || gp === -Infinity ||
            gn !== gn || gn === Infinity || gn === -Infinity ||
            mn !== mn || mn === Infinity || mn === -Infinity ||
            mx !== mx || mx === Infinity || mx === -Infinity) {
            throw new RangeError(
                '[lite-adaptive] DriftDetector accumulator overflowed to a non-finite value; the ' +
                'detector is fail-closed -- call clear() to reuse');
        }
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] DriftDetector.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index (0 <= i < buf.length), got ' + String(buf) + ', ' + String(i));
    }
}

// ===========================================================================
// SlidingDDSketch (ADR 0008) -- windowed relative-error quantiles over the LAST W
// (Masson-Rim-Lee, "DDSketch", VLDB 2019, on a fixed-B pane ring)
// ===========================================================================
//
// SlidingDDSketch answers "what is the p50 / p90 / p99 of the values in the LAST W" in FIXED
// preallocated space with the SAME per-query relative-error guarantee as lite-sketch's cumulative
// DDSketch (|q_est - q_true| <= alpha * q_true), on the RECENCY axis. It is the quantile sibling
// of SlidingHyperLogLog (windowed distinct-count) -- both keep a hard last-W window over a
// caller-supplied MONOTONE `now`, never the wall clock.
//
// WINDOW MODEL (ADR 0008, model A -- fixed-B pane ring): B preallocated DDSketch PANES, each
// covering W/B of the window, held in a ring. add() writes the CURRENT pane; when `now` crosses a
// pane boundary the ring rotates to the next pane and CLEARS it (fill(0), 0-alloc). A `now` jump of
// many pane-widths expires multiple panes in a bounded while-loop capped at B iterations (skipping
// >= B panes clears them ALL, then re-anchors the ring around `now`). quantile / quantileInto /
// count MERGE the live panes into an INSTANCE-OWNED preallocated scratch (cold, 0-alloc -- never a
// per-query allocation). The edge error is up to one pane width (W/B), disclosed: the oldest live
// pane straddles the window boundary and is counted in full. Each pane collapses its lowest bins
// INDEPENDENTLY, so the merged min-key across the B panes can differ from a single sketch's -- the
// accuracy/edge bound is therefore WITNESSED, not assumed.
//
// DDSketch MAPPING (inlined, NOT a dependency -- a consumer pre-checks against this identically to
// lite-sketch DDSketch; any divergence in the accepted band is a breaking surprise): with
// `gamma = (1 + alpha) / (1 - alpha)` a value x > 0 lands in bucket `key(x) = ceil(ln(x) * mult)`
// (mult = 1/ln(gamma)); x === 0 routes to a per-pane zero counter; x < 0 fails closed (log is
// undefined for non-positives). Bins collapse-lowest by default (protects the p90/p99 tail),
// `strict` opts into a fail-closed throw on a collapse instead. Bin counts are `Uint32Array`
// (non-negative frequencies; saturate at 0xFFFFFFFF, NEVER wrap -- the CountMinSketch precedent;
// lite-sketch DDSketch uses Float64 bins, the one recorded deviation -- see ADR 0008); the merge
// scratch is `Float64Array` so summing B near-saturated panes stays exact to 2^53.

/** Frozen marker of the known SlidingDDSketch option keys -- an unknown key throws with a hint. */
const SLD_KNOWN_OPTS = Object.freeze({ alpha: true, strict: true, panes: true });
/** Default relative-error target alpha (a common DDSketch setting; the option is tunable). */
const SLD_DEFAULT_ALPHA = 0.01;
/** Default pane count B (edge error W/32). */
const SLD_DEFAULT_PANES = 32;
/** Fewest panes: at least 2 so the window is meaningfully sub-divided. */
const SLD_PANES_MIN = 2;
/** Most panes: bounds the preallocated store (panes * SLD_MAX_BINS Uint32 bins). */
const SLD_PANES_MAX = 1024;
/**
 * SLD_MAX_BINS -- dense bin-array length PER PANE. Matches lite-sketch DDSketch's default maxBins
 * (2048) so the per-pane accuracy contract is identical: the alpha guarantee holds for the upper
 * quantiles unless a pane's value RANGE exceeds 2048 log-buckets and its low end collapses.
 */
const SLD_MAX_BINS = 2048;
/**
 * SLD_KEY_MAX -- hard cap on |bin key| before a value is rejected fail-closed (the ADWIN /
 * DriftDetector overflow lesson). Per-pane bin offsets live in `Int32Array`; a key beyond this
 * would overflow the offset arithmetic and silently corrupt the merge. 2^30 stays well within the
 * Int32 range. For every practical alpha the per-alpha indexable band (computed at the ctor like
 * DDSketch) is far tighter than SLD_KEY_MAX, so the ACCEPTED VALUE BAND is identical to lite-sketch
 * DDSketch; SLD_KEY_MAX only bites at a pathologically small alpha whose offsets would not fit Int32.
 */
const SLD_KEY_MAX = 1 << 30;

/**
 * SlidingDDSketch -- WINDOWED relative-error QUANTILE estimation over the LAST W (a hard sliding
 * window) in FIXED space (Masson-Rim-Lee, "DDSketch", VLDB 2019, over a fixed-B pane ring). The
 * recency sibling of lite-sketch's cumulative DDSketch and the quantile complement of
 * SlidingHyperLogLog.
 *
 * Headline (the family TRIPLE):
 *   - SPACE: a FIXED ring of B panes, each a dense `Uint32Array(SLD_MAX_BINS)` log-bucket store
 *     (+ per-pane offset / max-key / count bookkeeping) + one instance-owned Float64 merge scratch;
 *     never grows (panes=32 -> ~256 KB at 2048 bins).
 *   - ERROR: a HARD per-query relative bound `|q_est - q_true| <= alpha * q_true` on the merged live
 *     window, PLUS a window-edge error of up to one pane width W/B (the straddling oldest pane).
 *   - RECENCY: a HARD last-W window (forgets at the window edge, +/- one pane width) with a
 *     sub-window query `quantile(q, w)` / `count(w)` for any `w <= W`.
 *
 * Hot path (`add` / `addFrom`, 0 B/op INCLUDING pane rotation): validate value + time, compute the
 * ONE log-bucket key, rotate + clear panes if `now` crossed a boundary (a bounded, alloc-free
 * while-loop), and in the steady state increment ONE Uint32 cell of the current pane. The window
 * slide + collapse (`_addKeyPane`) is a cold tail-call off the hot body.
 *
 * Cold path: `quantile(q, w?)` / `quantileInto(qs, out)` / `count(w?)` MERGE the live panes into the
 * preallocated scratch (0 alloc, never per-query) then walk it -- a disclosed co-headline, NOT a
 * per-add cost. `clear()` reuses every array.
 *
 * Fail closed: a bad W / alpha / strict / panes / option throws `[lite-adaptive]` at the ctor door
 * BEFORE any allocation; `add` / `addFrom` reject a non-number / NaN / +-Infinity / NEGATIVE value,
 * a value whose key is out of the indexable range (or would exceed SLD_KEY_MAX), a mode switch, a
 * non-finite / decreasing `now` -- typeof-first, and every value-domain / indexable / time rejection
 * is a BYTE-IDENTICAL no-op (validated before any state write); a STRICT collapse rejection throws
 * before any bin write (the time model has legitimately advanced -- time is monotone and
 * value-independent; the quantile/count state is intact). `quantile` throws on q outside [0, 1] or a
 * sub-window outside (0, W], and returns NaN on an empty window; `count` returns 0 on empty. null is
 * not zero (strict = false and value = 0 are guarded distinctly).
 */
export class SlidingDDSketch {
    /**
     * @param {number} W        window size; a finite number > 0 (items in count mode, or the
     *                          `now`-unit span in explicit mode).
     * @param {{alpha?: number, strict?: boolean, panes?: number}} [options]
     *   alpha:  relative-error target; a number in (0, 1) (default 0.01).
     *   strict: fail closed on a collapse instead of collapsing-lowest (default false).
     *   panes:  pane-ring size B; an integer in [2, 1024] (default 32). Edge error is W / panes.
     */
    constructor(W, options) {
        // typeof guard FIRST, BEFORE any allocation (a bad param leaves no half-built instance).
        if (typeof W !== 'number' || W !== W || W === Infinity || W === -Infinity || W <= 0) {
            throw new RangeError(
                '[lite-adaptive] SlidingDDSketch W must be a finite number > 0, got ' + String(W));
        }
        let alpha = SLD_DEFAULT_ALPHA;
        let strict = false;
        let panes = SLD_DEFAULT_PANES;
        if (options !== undefined) {
            if (typeof options !== 'object' || options === null) {
                throw new TypeError('[lite-adaptive] SlidingDDSketch options must be an object');
            }
            for (const key in options) {
                if (!(key in SLD_KNOWN_OPTS)) {
                    throw new RangeError('[lite-adaptive] SlidingDDSketch unknown option "' + key + '"');
                }
            }
            if (options.alpha !== undefined) {
                const a = options.alpha;
                if (typeof a !== 'number' || !(a > 0 && a < 1)) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingDDSketch alpha must be a number in (0, 1), got ' + String(a));
                }
                alpha = a;
            }
            // strict = false is the default; guard `undefined`, and require a real boolean (null is not false).
            if (options.strict !== undefined) {
                const st = options.strict;
                if (typeof st !== 'boolean') {
                    throw new TypeError(
                        '[lite-adaptive] SlidingDDSketch strict must be a boolean, got ' + String(st));
                }
                strict = st;
            }
            if (options.panes !== undefined) {
                const p = options.panes;
                if (typeof p !== 'number' || (p | 0) !== p || p < SLD_PANES_MIN || p > SLD_PANES_MAX) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingDDSketch panes must be an integer in [' + SLD_PANES_MIN +
                        ', ' + SLD_PANES_MAX + '], got ' + String(p));
                }
                panes = p;
            }
        }

        const gamma = (1 + alpha) / (1 - alpha);
        const multiplier = 1 / Math.log(gamma);
        const lnGamma = Math.log(gamma);
        // Indexable KEY bounds for which the representative `2*gamma^K/(gamma+1)` stays a finite,
        // NORMAL double (the DDSketch fail-closed door, computed identically -- a sum of logs so the
        // `MAX_VALUE*(gamma+1)/2` term never overflows, then a cold verification tightening).
        const MIN_NORMAL = 2 ** -1022;
        const lnHalfGammaPlus1 = Math.log((gamma + 1) / 2);
        let maxKey = Math.floor((Math.log(Number.MAX_VALUE) + lnHalfGammaPlus1) / lnGamma);
        while (maxKey > 0 && !Number.isFinite(2 * Math.pow(gamma, maxKey) / (gamma + 1))) maxKey--;
        let minKey = Math.ceil((Math.log(MIN_NORMAL) + lnHalfGammaPlus1) / lnGamma);
        while (minKey < 0 && 2 * Math.pow(gamma, minKey) / (gamma + 1) < MIN_NORMAL) minKey++;
        // Intersect with SLD_KEY_MAX so per-pane Int32 offsets never overflow (fail-closed cap).
        if (maxKey > SLD_KEY_MAX) maxKey = SLD_KEY_MAX;
        if (minKey < -SLD_KEY_MAX) minKey = -SLD_KEY_MAX;

        this._W = W;
        this._alpha = alpha;
        this._strict = strict;
        this._panes = panes;
        this._maxBins = SLD_MAX_BINS;
        this._paneW = W / panes;          // per-pane time width (the disclosed edge error)
        this._gamma = gamma;
        this._multiplier = multiplier;
        this._maxKey = maxKey;
        this._minKey = minKey;
        this._minIndexable = Math.pow(gamma, minKey - 1);  // EXCLUSIVE floor: add accepts x > this
        this._maxIndexable = Math.pow(gamma, maxKey);      // INCLUSIVE ceiling: add accepts x <= this

        const cells = panes * SLD_MAX_BINS;
        // per-pane dense log-bucket store (pane p occupies cells [p*maxBins, p*maxBins+maxBins)):
        this._bins = new Uint32Array(cells);         // bin counts (saturate at 0xFFFFFFFF)
        this._offset = new Int32Array(panes);        // per-pane key at physical bin 0
        this._maxKeyPop = new Int32Array(panes);     // per-pane highest populated key
        this._binCount = new Int32Array(panes);      // per-pane anchored flag (0 = fresh)
        this._paneCollapsed = new Uint8Array(panes); // per-pane collapse flag (low-end precision lost)
        this._paneCount = new Float64Array(panes);   // per-pane total adds (incl. zeros), exact to 2^53
        this._paneZero = new Float64Array(panes);    // per-pane zero adds
        this._paneEnd = new Float64Array(panes);     // per-pane EXCLUSIVE upper time bound
        // instance-owned merge scratch (Float64 so B near-saturated panes sum exactly):
        this._scratch = new Float64Array(SLD_MAX_BINS);

        this._bytes = this._bins.byteLength + this._offset.byteLength + this._maxKeyPop.byteLength +
            this._binCount.byteLength + this._paneCollapsed.byteLength + this._paneCount.byteLength +
            this._paneZero.byteLength + this._paneEnd.byteLength + this._scratch.byteLength;

        this._initState();
    }

    /** @private Reset all pane state + time mode + scratch. Reused by clear(). 0 alloc. */
    _initState() {
        this._bins.fill(0);
        this._offset.fill(0);
        this._maxKeyPop.fill(0);
        this._binCount.fill(0);
        this._paneCollapsed.fill(0);
        this._paneCount.fill(0);
        this._paneZero.fill(0);
        this._paneEnd.fill(0);
        this._cur = 0;               // current (newest) pane index in the ring
        this._mode = MODE_UNSET;     // time mode, locked at the first add
        this._tick = 0;              // count-mode logical clock
        this._lastNow = 0;           // explicit-mode monotone guard (init value never compared)
        this._now = 0;               // the last applied t (query cutoff = now - W)
        // scratch (merged) state -- rebuilt each query, reset here for a clean empty read.
        this._sOffset = 0;
        this._sMaxKeyPop = 0;
        this._sBinCount = 0;
        this._mZeros = 0;
        this._mTotal = 0;
    }

    /** The relative-error target alpha. O(1). */
    get alpha() { return this._alpha; }
    /** Whether strict mode is on (a collapse throws instead of folding). O(1). */
    get strict() { return this._strict; }
    /** The pane-ring size B (edge error is W / panes). O(1). */
    get panes() { return this._panes; }
    /** Window size W. O(1). */
    get W() { return this._W; }
    /** The last applied time t (0 before the first add). O(1). */
    get lastNow() { return this._now; }
    /** The locked time mode: 'unset' | 'explicit' | 'count'. O(1). */
    get mode() {
        return this._mode === MODE_EXPLICIT ? 'explicit' : this._mode === MODE_COUNT ? 'count' : 'unset';
    }
    /**
     * The smallest x > 0 that `add` accepts at this alpha (the EXCLUSIVE lower floor; below it the
     * bucket representative falls denormal and loses the alpha guarantee). O(1), 0 B/op. null is not zero.
     */
    get minIndexable() { return this._minIndexable; }
    /** The largest x that `add` accepts at this alpha (INCLUSIVE; above it the representative overflows). O(1). */
    get maxIndexable() { return this._maxIndexable; }
    /** Whether any live pane has folded nonzero mass into its collapsed floor. COLD, O(panes). */
    get collapsed() {
        const c = this._paneCollapsed, B = this._panes;
        for (let p = 0; p < B; p++) if (c[p] !== 0) return true;
        return false;
    }
    /** A fixed memory figure in bytes (all pane columns + the merge scratch). O(1). */
    get bytes() { return this._bytes; }

    /**
     * Add one value `value` observed at `now`. HOT, 0 B/op INCLUDING pane rotation + clear.
     *
     * Time modes (LOCKED at the first add, a switch throws):
     *   - EXPLICIT: add(now, value). `now` is a finite number, strictly NON-DECREASING across calls.
     *   - COUNT: add(undefined, value). The member auto-increments an internal tick per add (W in items).
     *
     * Value domain (DDSketch parity): x > 0 is binned on the log scale; x === 0 is counted separately
     * (the smallest value); x < 0 fails closed (log is undefined). A value whose bucket key is outside
     * the indexable range (or would exceed SLD_KEY_MAX) fails closed.
     *
     * Fail closed: a non-number / NaN / +-Infinity / negative value, an out-of-indexable value, a mode
     * switch, or a non-finite / decreasing `now` throws [lite-adaptive] (typeof-first, a BYTE-IDENTICAL
     * no-op). In `strict` mode a value whose bucket would COLLAPSE -- fall outside the pane's representable
     * window in EITHER direction (below the floor OR above the ceiling, forcing a slide) -- throws before
     * any bin write; non-strict collapses silently and sets `collapsed`.
     * @param {number} [now]  the monotone time (omit for count mode).
     * @param {number} value  a finite number >= 0 (negatives throw).
     * @returns {SlidingDDSketch} this
     */
    add(now, value) {
        // 1. validate the VALUE first (typeof-first), before ANY state mutation.
        if (typeof value !== 'number' || value !== value ||
            value === Infinity || value === -Infinity) return this._badValue(value);
        if (value < 0) return this._badValue(value);
        // 2. compute the log-bucket key + indexable check for x > 0 (0 needs no key).
        let k = 0;
        if (value !== 0) {
            k = Math.ceil(Math.log(value) * this._multiplier);
            if (k > this._maxKey || k < this._minKey) return this._badIndexable(value);
        }
        // 3. resolve + lock the time mode (no mutation until every value+time check has passed).
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
            if (now === undefined) {
                this._mode = MODE_COUNT;
                t = ++this._tick;
                this._anchor(t);
            } else {
                if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                    return this._badNow(now);
                }
                this._mode = MODE_EXPLICIT;
                t = now;
                this._lastNow = now;
                this._anchor(t);
            }
        }
        this._now = t;
        // 4. rotate + clear panes if this t crossed the current pane boundary (bounded, 0-alloc).
        if (t >= this._paneEnd[this._cur]) this._advance(t);
        // 5. write the value into the current pane.
        const cur = this._cur;
        if (value === 0) { this._paneZero[cur] += 1; this._paneCount[cur] += 1; return this; }
        const maxBins = this._maxBins, bins = this._bins, base = cur * maxBins;
        const idx = k - this._offset[cur];
        if (this._binCount[cur] !== 0 && idx >= 0 && idx < maxBins) {
            const c = bins[base + idx];
            if (c !== 4294967295) {                           // saturate, never wrap
                bins[base + idx] = c + 1;
                this._paneCount[cur] += 1;                     // gate the count on the SAME check (no drift)
            }
            if (k > this._maxKeyPop[cur]) this._maxKeyPop[cur] = k;
            return this;
        }
        return this._addKeyPane(cur, k);   // cold: first value / slide / collapse
    }

    /**
     * Add one value from a caller-owned PACKED `[now, value]` Float64Array pair. HOT, 0 B/op -- the
     * ZERO-BOX entry: `now = buf[i]` (a fractional / epoch-ms double) and `value = buf[i + 1]` are
     * read UNBOXED, avoiding the ~16 B HeapNumber each would box as a plain argument at a non-inlined
     * call boundary. EXPLICIT-time ONLY (addFrom always carries a `now`): a COUNT-locked instance
     * rejects it and the first addFrom locks EXPLICIT mode. Identical validation, throws,
     * byte-identical-no-op-on-reject, and binning as `add(now, value)`; the body is DUPLICATED (not
     * delegated) to keep `add`'s hot body byte-identical and avoid re-boxing at an internal boundary.
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = now, `buf[i+1]` = value.
     * @param {number} i the base index of the [now, value] pair (0, 2, 4, ...).
     * @returns {SlidingDDSketch} this
     */
    addFrom(buf, i) {
        // Guard the buffer + index on the COLD branch first (a bad handle is a byte-identical no-op).
        if (!(buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || i + 1 >= buf.length) return this._badBuf(buf, i);
        const now = buf[i];         // UNBOXED Float64Array reads -- the whole point (no argument box).
        const value = buf[i + 1];   // packed [now, value]
        // 1. validate the VALUE first (a Float64Array read is always a number, so no typeof branch).
        if (value !== value || value === Infinity || value === -Infinity) return this._badValue(value);
        if (value < 0) return this._badValue(value);
        // 2. compute the log-bucket key + indexable check for x > 0.
        let k = 0;
        if (value !== 0) {
            k = Math.ceil(Math.log(value) * this._multiplier);
            if (k > this._maxKey || k < this._minKey) return this._badIndexable(value);
        }
        // 3. addFrom is an EXPLICIT-time entry: reject a count-locked instance, else lock/verify EXPLICIT.
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
            this._anchor(t);
        }
        this._now = t;
        // 4. rotate + clear panes if this t crossed the current pane boundary (bounded, 0-alloc).
        if (t >= this._paneEnd[this._cur]) this._advance(t);
        // 5. write the value into the current pane (DUPLICATED from add() -- byte-identical body).
        const cur = this._cur;
        if (value === 0) { this._paneZero[cur] += 1; this._paneCount[cur] += 1; return this; }
        const maxBins = this._maxBins, bins = this._bins, base = cur * maxBins;
        const idx = k - this._offset[cur];
        if (this._binCount[cur] !== 0 && idx >= 0 && idx < maxBins) {
            const c = bins[base + idx];
            if (c !== 4294967295) {                           // saturate, never wrap
                bins[base + idx] = c + 1;
                this._paneCount[cur] += 1;                     // gate the count on the SAME check (no drift)
            }
            if (k > this._maxKeyPop[cur]) this._maxKeyPop[cur] = k;
            return this;
        }
        return this._addKeyPane(cur, k);   // cold: first value / slide / collapse
    }

    /**
     * @private Anchor the pane ring around the first `now` (grid-aligned to W/panes). The current
     * pane (index 0) covers the grid cell containing `now`; predecessors go backward by one pane
     * width each. Cold (once per lifecycle / clear). 0 alloc.
     */
    _anchor(now) {
        const B = this._panes, pw = this._paneW;
        const E = (Math.floor(now / pw) + 1) * pw;   // EXCLUSIVE upper bound of the current pane
        this._cur = 0;
        this._paneEnd[0] = E;
        let e = E, idx = 0;
        for (let s = 1; s < B; s++) { idx--; if (idx < 0) idx = B - 1; e -= pw; this._paneEnd[idx] = e; }
    }

    /**
     * @private Rotate the ring forward so the current pane covers time `t`, clearing each pane it
     * rotates onto. Capped at B rotations (rotating >= B panes clears them ALL, then re-anchors the
     * ring around `t`). 0 alloc. Called only when `t` crossed the current pane boundary.
     */
    _advance(t) {
        const pw = this._paneW, B = this._panes;
        let cur = this._cur;
        let E = this._paneEnd[cur];
        let rot = 0;
        while (t >= E && rot < B) {
            cur++; if (cur === B) cur = 0;
            this._clearPane(cur);
            E += pw;
            this._paneEnd[cur] = E;
            rot++;
        }
        if (t >= E) {
            // jumped >= B pane widths: every pane cleared above -> grid-re-anchor around t.
            const newE = (Math.floor(t / pw) + 1) * pw;
            this._paneEnd[cur] = newE;
            let e = newE, idx = cur;
            for (let s = 1; s < B; s++) { idx--; if (idx < 0) idx = B - 1; e -= pw; this._paneEnd[idx] = e; }
        }
        this._cur = cur;
    }

    /** @private Clear one pane's store + bookkeeping (0 alloc). */
    _clearPane(p) {
        const base = p * this._maxBins;
        this._bins.fill(0, base, base + this._maxBins);
        this._offset[p] = 0;
        this._maxKeyPop[p] = 0;
        this._binCount[p] = 0;
        this._paneCollapsed[p] = 0;
        this._paneCount[p] = 0;
        this._paneZero[p] = 0;
    }

    /**
     * @private The cold window math for one pane (out-of-window key), mirroring lite-sketch DDSketch's
     * collapsing-lowest _addKey on a Uint32 store: anchor the first key at the TOP (fill downward), fold a
     * below-floor key into bin 0, or slide the window up folding the vacated low cells. STRICT mode throws
     * on ANY collapse (below-floor OR slide-up) at the HEAD of that branch, before any bin mutation. Uint32
     * bin counts saturate at 0xFFFFFFFF (never wrap); the per-pane count is gated on the same
     * non-saturation check so the tracked total never exceeds the histogram mass. 0 alloc.
     * @param {number} pane pane index
     * @param {number} k    bucket key
     * @returns {SlidingDDSketch} this
     */
    _addKeyPane(pane, k) {
        const maxBins = this._maxBins;
        const bins = this._bins;
        const base = pane * maxBins;
        if (this._binCount[pane] === 0) {
            const off = k - (maxBins - 1);      // anchor at the TOP, fill downward
            this._offset[pane] = off;
            bins[base + (maxBins - 1)] += 1;    // fresh cell (0 -> 1, no saturation concern)
            this._maxKeyPop[pane] = k;
            this._binCount[pane] = 1;
            this._paneCount[pane] += 1;
            return this;
        }
        const off = this._offset[pane];
        const idx = k - off;
        if (idx >= 0 && idx < maxBins) {        // in-window (rare fall-through from the hot body)
            const c = bins[base + idx];
            if (c !== 4294967295) {             // saturate, never wrap; gate the count on the SAME check
                bins[base + idx] = c + 1;
                this._paneCount[pane] += 1;
            }
            if (k > this._maxKeyPop[pane]) this._maxKeyPop[pane] = k;
            return this;
        }
        if (idx < 0) {                          // below the floor: collapsing-lowest fold (or strict throw)
            if (this._strict) return this._badStrict(k);   // strict: NO collapse ever -- throw before any write
            const c = bins[base];
            if (c !== 4294967295) {             // saturate; gate the count so the total never exceeds the mass
                bins[base] = c + 1;
                this._paneCount[pane] += 1;
            }
            this._paneCollapsed[pane] = 1;
            return this;
        }
        // idx > maxBins - 1: the value sits ABOVE the window ceiling -> a slide-up that WOULD collapse the
        // low end. STRICT: no collapse ever -- throw at the HEAD, before any bin mutation (symmetric with
        // the below-floor strict throw; both too-small and too-large fail closed, DDSketch-strict parity).
        if (this._strict) return this._badStrict(k);
        const newOff = k - (maxBins - 1);
        const delta = newOff - off;             // > 0
        if (delta >= maxBins) {                 // everything folds into bin 0
            let m = 0;
            for (let i = 0; i < maxBins; i++) { m += bins[base + i]; bins[base + i] = 0; }
            if (m !== 0) this._paneCollapsed[pane] = 1;
            bins[base] = m > 4294967295 ? 4294967295 : m;
        } else {                                // fold the delta lowest cells into bin 0
            let m = 0;
            for (let i = 0; i < delta; i++) m += bins[base + i];
            bins.copyWithin(base, base + delta, base + maxBins);      // shift counts DOWN by delta
            bins.fill(0, base + maxBins - delta, base + maxBins);     // zero the vacated top
            const c0 = bins[base] + m;
            bins[base] = c0 > 4294967295 ? 4294967295 : c0;
            if (m !== 0) this._paneCollapsed[pane] = 1;
        }
        this._offset[pane] = newOff;
        bins[base + (maxBins - 1)] += 1;        // the new key sits at the top (fresh after the slide)
        this._maxKeyPop[pane] = k;
        this._paneCount[pane] += 1;
        return this;
    }

    /**
     * @private Merge the live panes (paneEnd > cut) into the instance-owned Float64 scratch. Each pane
     * collapses INDEPENDENTLY, so keys are re-folded through the same collapsing-lowest logic on the
     * scratch (the merged min-key may differ from a single pane's -- ADR 0008). Also accumulates the
     * merged zero count + total. COLD, O(panes * maxBins), 0 alloc.
     */
    _merge(cut) {
        const s = this._scratch;
        s.fill(0);
        this._sBinCount = 0;
        this._sOffset = 0;
        this._sMaxKeyPop = 0;
        let zeros = 0, total = 0;
        const B = this._panes, maxBins = this._maxBins, bins = this._bins;
        for (let p = 0; p < B; p++) {
            if (!(this._paneEnd[p] > cut)) continue;   // pane fully expired (its newest edge <= cut)
            zeros += this._paneZero[p];
            total += this._paneCount[p];
            if (this._binCount[p] === 0) continue;     // no bucketed value in this pane
            const base = p * maxBins;
            const off = this._offset[p];
            const top = this._maxKeyPop[p] - off;
            for (let ii = 0; ii <= top; ii++) {
                const mass = bins[base + ii];
                if (mass !== 0) this._scratchAddKey(ii + off, mass);
            }
        }
        this._mZeros = zeros;
        this._mTotal = total;
    }

    /** @private Fold a (key, mass) pair into the Float64 merge scratch (collapsing-lowest). 0 alloc. */
    _scratchAddKey(k, mass) {
        const maxBins = this._maxBins, s = this._scratch;
        if (this._sBinCount === 0) {
            const off = k - (maxBins - 1);
            this._sOffset = off;
            s[maxBins - 1] += mass;
            this._sMaxKeyPop = k;
            this._sBinCount = 1;
            return;
        }
        const off = this._sOffset;
        const idx = k - off;
        if (idx >= 0 && idx < maxBins) {
            s[idx] += mass;
            if (k > this._sMaxKeyPop) this._sMaxKeyPop = k;
            return;
        }
        if (idx < 0) { s[0] += mass; return; }
        const newOff = k - (maxBins - 1);
        const delta = newOff - off;
        if (delta >= maxBins) {
            let m = 0;
            for (let i = 0; i < maxBins; i++) { m += s[i]; s[i] = 0; }
            s[0] = m;
        } else {
            let m = 0;
            for (let i = 0; i < delta; i++) m += s[i];
            s.copyWithin(0, delta, maxBins);
            s.fill(0, maxBins - delta, maxBins);
            s[0] += m;
        }
        this._sOffset = newOff;
        s[maxBins - 1] += mass;
        this._sMaxKeyPop = k;
    }

    /** @private Walk the merged scratch for quantile q in [0, 1]; NaN for a bad q or an empty merge. */
    _walk(q) {
        if (typeof q !== 'number' || q !== q || q < 0 || q > 1) return NaN;
        const N = this._mTotal;
        if (N === 0) return NaN;
        const rank = Math.floor(q * (N - 1));   // 0-indexed target rank
        let cum = this._mZeros;
        if (rank < cum) return 0;               // the target falls in the zero bucket
        const s = this._scratch, off = this._sOffset, gamma = this._gamma;
        const top = this._sBinCount === 0 ? -1 : this._sMaxKeyPop - off;
        for (let i = 0; i <= top; i++) {
            cum += s[i];
            if (cum > rank) {
                const K = i + off;
                return 2 * Math.pow(gamma, K) / (gamma + 1);
            }
        }
        if (top >= 0) return 2 * Math.pow(gamma, this._sMaxKeyPop) / (gamma + 1);
        return NaN;
    }

    /**
     * Estimate the value at quantile q over the last W (or a sub-window `w <= W`). COLD, 0 alloc
     * (merges the live panes into the instance scratch, never per-query). Returns NaN on an empty
     * window. Throws [lite-adaptive] on q outside [0, 1] or a sub-window `w` outside (0, W].
     * @param {number} q a number in [0, 1].
     * @param {number} [w] an optional sub-window in (0, W] (omit for the full window W).
     * @returns {number}
     */
    quantile(q, w) {
        if (typeof q !== 'number' || q !== q || q < 0 || q > 1) return this._badQ(q);
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) {
                return this._badWindow(w);
            }
            effW = w;
        }
        if (this._mode === MODE_UNSET) return NaN;
        this._merge(this._now - effW);
        return this._walk(q);
    }

    /**
     * Render several quantiles at once into a caller-owned Float64Array, merging the live panes ONCE
     * (0-alloc render path). Each `qs[j]` in [0, 1] is written to `out[j]` (NaN for a q outside [0, 1]
     * or an empty window). COLD. Returns the number of quantiles written (= qs.length).
     * @param {Float64Array} qs the quantiles to render (each in [0, 1]).
     * @param {Float64Array} out the receiving buffer (length must be >= qs.length).
     * @returns {number} the count of quantiles written.
     */
    quantileInto(qs, out) {
        if (!(qs instanceof Float64Array) || !(out instanceof Float64Array) || out.length < qs.length) {
            return this._badInto(qs, out);
        }
        const n = qs.length;
        if (this._mode === MODE_UNSET) {
            for (let j = 0; j < n; j++) out[j] = NaN;
            return n;
        }
        this._merge(this._now - this._W);
        for (let j = 0; j < n; j++) out[j] = this._walk(qs[j]);
        return n;
    }

    /**
     * The number of values in the last W (or a sub-window `w <= W`), including zeros. COLD, O(panes),
     * 0 alloc. Returns 0 on an empty window. Throws [lite-adaptive] on a sub-window `w` outside (0, W].
     * @param {number} [w] an optional sub-window in (0, W] (omit for the full window W).
     * @returns {number}
     */
    count(w) {
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) {
                return this._badWindow(w);
            }
            effW = w;
        }
        if (this._mode === MODE_UNSET) return 0;
        const cut = this._now - effW;
        const B = this._panes;
        let total = 0;
        for (let p = 0; p < B; p++) if (this._paneEnd[p] > cut) total += this._paneCount[p];
        return total;
    }

    /** Reset to the empty window; reuse every array (also unlocks the mode). O(panes*maxBins). @returns {SlidingDDSketch} this */
    clear() {
        this._initState();
        return this;
    }

    /** @private Cold thrower for a bad value (non-finite / negative). */
    _badValue(value) {
        throw new TypeError(
            '[lite-adaptive] SlidingDDSketch value must be a finite number >= 0, got ' + String(value));
    }

    /** @private Cold thrower for a value outside the indexable range (representative would over/underflow). */
    _badIndexable(value) {
        throw new RangeError(
            '[lite-adaptive] SlidingDDSketch value ' + String(value) + ' is outside the sketch\'s indexable range');
    }

    /** @private Cold thrower for a strict-mode collapse rejection (below the floor OR above the ceiling). */
    _badStrict(k) {
        throw new RangeError(
            '[lite-adaptive] SlidingDDSketch strict mode: value (bucket key ' + String(k) +
            ') falls outside the pane\'s representable window and would collapse');
    }

    /** @private Cold thrower for a mode switch after the mode locked. */
    _badMode(locked, attempted) {
        throw new TypeError(
            '[lite-adaptive] SlidingDDSketch mode is locked to ' + locked +
            ' at the first add; got a ' + attempted + '-mode add');
    }

    /** @private Cold thrower for a non-finite `now`. */
    _badNow(now) {
        throw new TypeError(
            '[lite-adaptive] SlidingDDSketch add now must be a finite number, got ' + String(now));
    }

    /** @private Cold thrower for a non-monotone `now`. */
    _badMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] SlidingDDSketch add now must be non-decreasing: got ' + String(now) +
            ' after ' + String(this._lastNow));
    }

    /** @private Cold thrower for a bad quantile q. */
    _badQ(q) {
        throw new RangeError(
            '[lite-adaptive] SlidingDDSketch quantile q must be a number in [0, 1], got ' + String(q));
    }

    /** @private Cold thrower for a bad sub-window `w`. */
    _badWindow(w) {
        throw new RangeError(
            '[lite-adaptive] SlidingDDSketch sub-window w must be a finite number in (0, W] (W=' +
            this._W + '), got ' + String(w));
    }

    /** @private Cold thrower for a bad quantileInto(qs, out). */
    _badInto(qs, out) {
        throw new TypeError(
            '[lite-adaptive] SlidingDDSketch.quantileInto(qs, out) needs two Float64Arrays with ' +
            'out.length >= qs.length, got ' + String(qs) + ', ' + String(out));
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] SlidingDDSketch.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i + 1 < buf.length, got ' + String(buf) + ', ' + String(i));
    }
}
