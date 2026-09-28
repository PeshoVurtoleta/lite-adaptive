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
 * expired heads (`stamp <= now - W`) are dropped in add (1.7.0 F8) and a full ring of IN-WINDOW
 * entries bumps `overflows` (the honest-degradation signal, `degraded`); `count(w?)` is PURE --
 * it skips expired entries while reading, takes each register's live-max rho, and runs Ertl's improved
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
 * resetting the accumulators so the NEXT shift is caught (the `latch: false` default; `latch: true`
 * fires ONCE per regime and re-arms on hysteresis instead) -- 0 B/op. It is the item-based, scalar,
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
 * v1.4.0 adds advance(now) / advanceFrom(buf, i) to the THREE time-windowed members
 * (ExponentialHistogram, SlidingHyperLogLog, SlidingDDSketch) -- the R11 idle-slide sweep (ADR
 * 0009). advance() moves the window's reference time forward and applies the SAME expiry / pane
 * rotation an add would, but inserts NO value, so an IDLE stream (no traffic) still forgets at
 * the window edge and count() / sum() / quantile() keep sliding to empty. EXPLICIT-time only
 * (parity with addFrom): a COUNT-locked instance throws, an UNSET instance locks EXPLICIT +
 * anchors, monotone `now` >= lastNow; a rejected advance is a byte-identical no-op; 0 B/op.
 * EH runs add()'s expire loop VERBATIM (opens no bucket); SlidingHyperLogLog is CLOCK-ONLY (count
 * skips entries expired off `now` without mutating; the next add drops them -- 1.7.0 F8);
 * SlidingDDSketch rotates+clears stale panes via the private _advance. ForwardDecay / ADWIN /
 * HeavyKeeper / DriftDetector are EXCLUDED (FD satisfies R11 via its existing now? query args;
 * ADWIN/HeavyKeeper/DriftDetector are item-indexed, not time-windowed). A PURE method ADD: every
 * existing method + hot body of the three touched classes stays BYTE-IDENTICAL; only this header +
 * VERSION change plus the two new methods (and their cold throwers) per touched class.
 *
 * v1.5.0 adds SlidingCountMin (ADR 0010; Cormode-Muthukrishnan, "Count-Min Sketch", 2005, on a
 * windowed pane ring): WINDOWED per-label FREQUENCY over the LAST W in FIXED preallocated space --
 * the recency sibling of lite-sketch's cumulative CountMinSketch and the frequency complement of
 * SlidingHyperLogLog / SlidingDDSketch. A ring of B+1 panes, each a full d x w CountMin matrix
 * covering W/B of the window; add(now, key, count?) / the zero-box stride-3 addFrom(buf, i) write the
 * current pane's d cells (conservative-update per pane by default) over the SAME two-lane murmur3 as
 * lite-sketch CMS (base = hi ^ lo, row column = mix(base ^ i*ODD_CONST) & (w-1)); crossing a pane
 * boundary rotates to the next pane and clears it (0 B/op, a bounded while-loop capped at B+1).
 * estimate(key, w?) SUMS each row's cell across the live panes then MINs over rows (sum-then-min) --
 * COLD, 0 alloc, returns a DOUBLE, never throws. The query covers the live panes so the span is
 * [W, W+W/B]: the straddling oldest pane is KEPT (never dropped), giving a ONE-SIDED upper bound
 * true(W) <= est <= true(W+W/B) + epsilon*N. Counters saturate at 2^32-1 (the `saturated` honesty
 * flag). advance() / advanceFrom() slide an idle window. The FOURTH additive post-1.0 member: a PURE
 * APPEND -- the seven prior classes (ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper,
 * SlidingHyperLogLog, DriftDetector, SlidingDDSketch) stay BYTE-IDENTICAL; only this header + VERSION
 * change above the append point plus the appended SlidingCountMin class (and its SCM_* consts).
 *
 * v1.6.0 adds DecayedReservoir (ADR 0011; Efraimidis-Spirakis "Weighted random sampling with a
 * reservoir", IPL 2006, over FORWARD-DECAY weights): a fixed-size-k SAMPLE of ACTUAL recent stream
 * VALUES biased toward the recent -- the "give me k real recent items" member the family lacked
 * (every prior member returns a summary; this hands back raw values the caller computes anything
 * over). A-Res assigns each accepted add a random key in LOG SPACE, key = log(u) * exp(-lambda*(t -
 * L)) * scale (u ~ Uniform(0,1) from ONE seeded xorshift32 draw -- the EXACT HeavyKeeper PRNG;
 * lambda = ln2/halfLife), and keeps the k HIGHEST keys in an INLINE size-k min-forest (design-parity
 * with HeavyKeeper / lite-o1 FreqO1, never a dep); an item's retention probability decays as
 * exp(-lambda*age). The landmark rebase is an ORDER-PRESERVING common-factor multiply (proven not to
 * disturb membership) capped (DR_EXP_CAP=40 / DR_F_CAP=700) so a key never underflows to -0 within a
 * single rebase; across MULTIPLE back-to-back capped rebases (epoch-long idle gaps) a stored key CAN
 * reach -Infinity, which is HARMLESS -- the common factor preserves order, the value column stays
 * finite, there is no NaN, and those keys sink and evict first (ADR 0011). Raw-sample-only surface: add(now?, value?) / the zero-box
 * addFrom(buf, i) (0 B/op incl. the rebase), sampleInto(buf) / forEach(fn) / clear / getters -- NO
 * mean()/quantile() aggregates, NO advance() (a sample, not a hard window). The FIFTH additive
 * post-1.0 member: a PURE APPEND -- the eight prior classes (ExponentialHistogram, ADWIN,
 * ForwardDecay, HeavyKeeper, SlidingHyperLogLog, DriftDetector, SlidingDDSketch, SlidingCountMin) stay
 * BYTE-IDENTICAL; only this header + VERSION change above the append point plus the appended
 * DecayedReservoir class (and its DR_* consts).
 *
 * v1.7.0 is the H1 HARDENING release (ROADMAP section 7): NOT a pure append -- it fixes the 1.6.0
 * final-sweep findings in place across the members (EH maxCount sizing + overflow pre-check; HK
 * zero-box hot path + weight bound; SDD declared range, B+1 pane ring, 0-alloc quantileInto; ADWIN
 * centred sums + live-window range; SHLL pure count; ctor memory caps; one NaN query contract; one
 * shared option door). Every change is listed per class in CHANGELOG 1.7.0.
 *
 * v1.8.0 is the additive-API release (ROADMAP section 8). SlidingCountMin gains two cold readers:
 * total(w?) -- the EXACT windowed item count N (the eps x N denominator) from a NEW per-pane Float64
 * total (this._paneTotal, +(panes+1)*8 B; default B=32 -> +264 B), summed over the SAME live panes as
 * estimate (straddling oldest pane included), NaN on a bad w, 0 when unset; and estimateInto(keys,
 * out, w?) -- a 0-alloc batch reader over caller-owned Float64Arrays (F6/R7), each slot exactly what
 * estimate(keys[j], w) returns, no computed double crossing a non-inlined call. The hot bodies of
 * add / addFrom gain ONE line (this._paneTotal[this._cur] += count, AFTER the pane rotation); the
 * cell writes otherwise stay in place.
 *
 * v1.8.0 also lands F19, a REPRESENTATION change to the shared hash paths so a key word >= 2^31
 * never boxes a 31-bit-Smi HeapNumber at an un-inlined call. HeavyKeeper routes the key through the
 * ARGUMENT-FREE helpers hkHash / hkMapHash (key + seed in Float64Array slots, int32 lanes in
 * Int32Array slots -- no number crosses that boundary; hkPos(r, w) passes only Smi-range ints, which
 * never box); SlidingHyperLogLog and SlidingCountMin
 * HAND-INLINE the two-lane murmur in the hot body. Either way every murmur round + fmix runs in
 * register-resident int32 LOCALS (F19v2 -- the earlier per-round Int32Array round-trip that V8 could
 * not scalar-replace cost ~59% on the SCM hot path and was reverted to locals; the throughput-
 * regression guard test/perf/HashThroughput.test.mjs now pins that ratio vs an embedded replica).
 * An Int32Array store applies ToInt32, identical to `| 0` and to Math.imul's own ToInt32, so
 * the OUTPUT is BIT-IDENTICAL: HeavyKeeper, SlidingHyperLogLog and SlidingCountMin produce the same
 * hashes, column positions and estimates as pre-F19. This is PROVEN by the differential parity suites
 * (HKParity incl. the _cnt/_fp column-layout pin, SHLLParity, SCMParity incl. the column-shift
 * teeth), not merely asserted.
 *
 * v1.8.0 also adds the DriftDetector `latch` option (S9, default false): a latched detector fires
 * ONCE per regime and re-arms when the latched gap falls below threshold / 2; `lastDriftIndex` /
 * `lastDirection` record the last fire. `latch: false` is OUTPUT-IDENTICAL to 1.7.0 (DDParity).
 * The remaining classes (ExponentialHistogram, ForwardDecay, ADWIN, DecayedReservoir,
 * SlidingDDSketch) stay BYTE-IDENTICAL.
 *
 * v1.9.0 adds SlidingAggregate (ADR 0012): EXACT windowed count / sum / mean / min / max over the
 * COVERED span [w, w + W/B] (which always CONTAINS the last w) in FIXED preallocated space -- the
 * exact-aggregate member the family lacked (ExponentialHistogram's
 * sum() error is bounded by half the straddling bucket, not epsilon, so it fails on a skewed stream;
 * SlidingDDSketch answers quantiles, SlidingCountMin per-key counts). A ring of B+1 panes of width W/B
 * (the SlidingCountMin ring, COPIED verbatim so SCM's bytes cannot move), each a stride-5 Float64 slot
 * [count, sum, kcomp, min, max]; add(now, value) / the zero-box stride-2 addFrom(buf, i) fold the value
 * into the current pane (count += 1, a branch-free Kahan compensated sum, min / max by comparison), and
 * crossing a pane boundary rotates + clears it to IDENTITY sentinels (count/sum/kcomp 0, min +Infinity,
 * max -Infinity -- never fill(0), 0 B/op). count / sum / mean / min / max (w?) and the 0-alloc into(out, w?)
 * merge the live, NON-EMPTY panes (the straddling oldest pane kept) with Neumaier over {s_p, -c_p}: count /
 * min / max are bit-exact and |sum - exact| <= (4u + O(N u^2)) * sum|v|, u = 2^-53. An empty covered window
 * reads count 0, sum 0, mean / min / max NaN. value is REQUIRED (|value| <= 1e150); the rotate / anchor
 * helpers take NO argument (read this._now, the zero-box law -- no epoch-ms double crosses a non-inlined
 * call). advance() / advanceFrom() slide an idle window. The SIXTH additive post-1.0 member: a PURE
 * APPEND -- the nine prior classes (ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper,
 * SlidingHyperLogLog, DriftDetector, SlidingDDSketch, SlidingCountMin, DecayedReservoir) stay
 * BYTE-IDENTICAL; only this header + VERSION change above the append point plus the appended
 * SlidingAggregate class (and its SA_* consts).
 *
 * ASCII-only source (no Unicode; the two exceptions the suite allows are unused
 * here). Zero runtime deps; node:test only.
 *
 * @license MIT
 */

/** Package version. One of the three version sites (package.json / VERSION / llms.txt). */
export const VERSION = '1.10.0';

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

/**
 * The INTRINSIC %TypedArray%.prototype.length getter, captured ONCE at module init (H34). Used by
 * the COLD render readers only (into / estimateInto / quantileInto / topKInto / sampleInto). A
 * Float64Array SUBCLASS with an own `length` getter -- or an instance with a `length` accessor
 * installed via Object.defineProperty -- still passes `ArrayBuffer.isView && instanceof`, so a cold
 * reader that read `x.length` through the prototype chain would run CALLER CODE, and a re-entrant or
 * lying getter could make an output site report more slots than exist. `TA_LEN.call(x)` reads the
 * internal [[ArrayLength]] slot directly, runs NO user code, and returns 0 for a detached view (fail
 * closed). Each cold reader reads the length ONCE through this getter into a local and uses only that
 * local for bounds, loops and messages; a benign subclass is ACCEPTED with correct results.
 *
 * The HOT entry points (addFrom / advanceFrom) deliberately do NOT use TA_LEN: they read `x.length`
 * ONCE into the bound (a caller-defined subclass getter may run at most once per call -- the caller's
 * own code, documented). The zero-GC hot path is the product; the container guard verifies STATE, and
 * a subclass getter is caller code the caller chose to run. See ROADMAP 10.1 (container-length threat
 * model, SETTLED 2026-09-28).
 */
const TA_LEN = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Float64Array.prototype), 'length').get;

/**
 * The smallest halfLife that yields a FINITE decay rate lambda = ln2 / halfLife (F14).
 * A subnormal halfLife (e.g. 1e-320) makes lambda overflow to Infinity, which then poisons
 * every weight to NaN -- ForwardDecay / DecayedReservoir must fail closed at construction,
 * BEFORE allocation, rather than fail open (NaN priorities) or fail late (a misleading query
 * error). halfLife >= this floor keeps lambda < Infinity.
 */
const LAMBDA_HALFLIFE_MIN = Math.LN2 / Number.MAX_VALUE;

/**
 * A module-level scratch row for the option-door Levenshtein distance (F13). One preallocated
 * Int32Array reused across every did-you-mean probe -- the door is COLD (ctor path only), never hot,
 * and it fully drains this row before it returns, so no two calls observe each other's scratch.
 * Sized 64: known option keys and the probed key are both bounded at 63 chars (longer keys skip the
 * hint entirely), so `lb + 1 <= 64` always.
 */
const OPT_LEV_ROW = new Int32Array(64);

/**
 * @private Levenshtein edit distance between two <= 63-char strings, via a single preallocated row
 * (OPT_LEV_ROW). COLD -- only reached for an unknown option key on a throwing ctor path.
 */
function optLev(a, b) {
    const la = a.length, lb = b.length;
    const row = OPT_LEV_ROW;
    for (let j = 0; j <= lb; j++) row[j] = j;
    for (let i = 1; i <= la; i++) {
        let prev = row[0];
        row[0] = i;
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= lb; j++) {
            const tmp = row[j];
            const sub = prev + (ca === b.charCodeAt(j - 1) ? 0 : 1);
            const del = row[j] + 1;
            const ins = row[j - 1] + 1;
            let m = sub;
            if (del < m) m = del;
            if (ins < m) m = ins;
            row[j] = m;
            prev = tmp;
        }
    }
    return row[lb];
}

/**
 * The shared COLD option door (F13). `undefined` is OK (no options). null, a non-object, an Array, or
 * an ArrayBuffer view (typed array / DataView) is a hard TypeError -- none is a valid options bag.
 * Each OWN enumerable key must be present in the null-proto `known` set (a plain-literal set would
 * inherit `constructor` / `toString`, so `{constructor: 1}` would slip through -- the F13 bug). An
 * unknown key throws a tagged RangeError with a Levenshtein <= 2 did-you-mean hint (skipped for keys
 * over 63 chars). Never allocates on the accept path; the reject path is a throw, so its allocation
 * is irrelevant. Called by all 10 ctors and the two `withAccuracy` factories (R6: every door is the
 * same door).
 * @param {object|undefined} options
 * @param {object} known    a null-proto set of the legal keys (`key in known`).
 * @param {string} label    the class or factory label, e.g. 'HeavyKeeper' or 'HeavyKeeper.withAccuracy'.
 */
function optDoor(options, known, label) {
    if (options === undefined) return;
    if (options === null || typeof options !== 'object' ||
        Array.isArray(options) || ArrayBuffer.isView(options)) {
        throw new TypeError('[lite-adaptive] ' + label + ' options must be an object');
    }
    // A PLAIN object only: the ctors read `options.X` through the prototype chain, so an inherited
    // key would skip this door yet still configure the instance (fail-open). Symbol keys can never
    // name an option -- reject them rather than silently ignore (review 4b).
    const proto = Object.getPrototypeOf(options);
    if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(options).length !== 0) {
        throw new TypeError('[lite-adaptive] ' + label + ' options must be a plain object (no prototype keys, no Symbol keys)');
    }
    for (const key in options) {
        if (!Object.prototype.hasOwnProperty.call(options, key)) continue;
        if (!(key in known)) {
            let msg = '[lite-adaptive] ' + label + ' unknown option "' + key + '"';
            if (key.length <= 63) {
                let best = null, bestD = 3;   // accept only a distance <= 2 (bestD starts at 3)
                for (const k in known) {
                    const dst = optLev(key, k);
                    if (dst < bestD) { bestD = dst; best = k; }
                }
                if (best !== null) msg += ' -- did you mean "' + best + '"?';
            }
            throw new RangeError(msg);
        }
    }
}

/**
 * COLD trap-free stringifier for throw messages (H2-6). `String(x)` on an object runs the caller's
 * toString / valueOf / Symbol.toPrimitive -- and on a Proxy, ANY property access -- AFTER a guard has
 * already decided to reject, so a re-entrant trap can mutate the same instance and the "no-op" reject
 * is no longer a no-op (fail-open). `typeof` and `ArrayBuffer.isView` never fire a Proxy trap, and
 * `String()` on a primitive (number / string / boolean / bigint / symbol / undefined) runs no user
 * code, so a number message stays byte-identical while an object / function / view is named inertly.
 */
function describeArg(x) {
    const t = typeof x;
    if (x === null) return 'null';
    if (t === 'object') return ArrayBuffer.isView(x) ? 'a typed-array view' : 'an object';
    if (t === 'function') return 'a function';
    return String(x);
}

/** Frozen marker of the known ctor option keys -- an unknown key is a throw with a did-you-mean. */
const EH_KNOWN_OPTS = Object.freeze(Object.assign(Object.create(null), { maxCount: true }));

/** The default `maxCount` (max window population): 2^32. Declares the pool sizing when omitted. */
const EH_DEFAULT_MAXCOUNT = 4294967296;
/** The largest safe-integer `maxCount` (2^53 - 1). Above this, integer counts stop being exact. */
const EH_MAXCOUNT_MAX = 9007199254740991;
/**
 * Hard ceiling on the bucket-pool capacity `cap = (k+1)*levels + 2` (F11). 2^22 buckets x 36 B
 * (6 SoA columns) = ~150 MB, the memory ceiling; above it the ctor throws a tagged RangeError BEFORE
 * allocation instead of aborting the process on a V8 fatal (e.g. `EH(10, 1e-12)` in 1.6.0).
 */
const EH_CAP_MAX = 2 ** 22;

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
 *   - ERROR: windowed COUNT relative error <= epsilon (HARD), by the merge rule
 *     `k = ceil(1/(2 epsilon)) + 1`: the oldest (straddling) bucket, the only source
 *     of error, holds at most ~ (1/(2k)) of the window POPULATION, so estimating half
 *     of it is within epsilon. The windowed SUM error is bounded in ABSOLUTE terms by
 *     `size(oldest straddling bucket) / 2` (half the value-mass of the one uncertain
 *     bucket); that is relative `<= epsilon` for COUNT or near-constant values, but a
 *     heavy-tailed or spiky value distribution can exceed epsilon (levels are sized by
 *     POPULATION, not value mass -- measured 15.8% heavy-tail, 2504% for a lone spike
 *     at eps .1). See sum() for the exact bound (F17).
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
     * @param {object} [options] `{ maxCount }`; an unknown key throws [lite-adaptive].
     * @param {number} [options.maxCount] the window population the pool is GUARANTEED to
     *   hold, in EITHER mode -- a positive integer <= 2^53-1 (default 2^32). It sizes the fixed
     *   pool; the exact ceiling is `k * (2^levels - 1)` elements (>= maxCount, ~3-6x it): the
     *   add past it (its merge cascade would pass the top level) throws a tagged RangeError. Pass
     *   `maxCount: W` in count mode to keep the pre-1.7.0 W-sized pool.
     */
    constructor(W, epsilon, options) {
        // typeof guard FIRST, BEFORE any allocation.
        if (typeof W !== 'number' || W !== W || W === Infinity || W === -Infinity || W <= 0) {
            throw new RangeError(
                '[lite-adaptive] ExponentialHistogram W must be a finite number > 0, got ' + describeArg(W));
        }
        if (typeof epsilon !== 'number' || epsilon !== epsilon || epsilon <= 0 || epsilon >= 1) {
            throw new RangeError(
                '[lite-adaptive] ExponentialHistogram epsilon must be a number in (0, 1), got ' + describeArg(epsilon));
        }
        if (options !== undefined) {
            optDoor(options, EH_KNOWN_OPTS, 'ExponentialHistogram');
        }
        // maxCount -- typeof-first, BEFORE any allocation. `undefined` (not null) takes the
        // 2^32 default; a supplied value must be a finite integer in [1, 2^53-1]. null is NOT
        // a default -- it fails typeof, fail-closed. The pool is sized from maxCount, before
        // the mode locks, so a count-mode instance ALSO gets the default sizing.
        let maxCount = EH_DEFAULT_MAXCOUNT;
        if (options !== undefined && options.maxCount !== undefined) {
            const mc = options.maxCount;
            if (typeof mc !== 'number' || mc !== mc || mc === Infinity || !Number.isInteger(mc) ||
                mc <= 0 || mc > EH_MAXCOUNT_MAX) {
                throw new RangeError(
                    '[lite-adaptive] ExponentialHistogram maxCount must be an integer in [1, 2^53-1], got ' +
                    describeArg(mc));
            }
            maxCount = mc;
        }
        // k = ceil(1/(2 epsilon)) + 1 -- at most k buckets per level; the two oldest
        // merge on the (k+1)-th, so each level below the top stays in [k-1, k+1].
        const k = Math.ceil(1 / (2 * epsilon)) + 1;
        // LEVELS = ceil(log2(maxCount / (k+1))) + 2 -- the number of size classes the pool
        // can ever occupy for a window of up to `maxCount` elements (a level-L bucket holds
        // 2^L elements; the top level is reached when the lower levels are full). Floored at
        // 2 so the first cascade always fits.
        const levels = Math.max(2, Math.ceil(Math.log2(maxCount / (k + 1))) + 2);
        // CAP = (k+1)*LEVELS + 2 -- (k+1) per level covers the transient (k+1)-th bucket
        // before its merge; the +2 covers the freshly-opened level-0 bucket during a
        // full cascade plus one slack slot. The pool never grows past CAP.
        const cap = (k + 1) * levels + 2;
        // Cells cap BEFORE allocation (F11): a tiny epsilon (huge k) or huge maxCount (huge levels)
        // pushes cap past 2^22 and aborted the process on a V8 fatal in 1.6.0 (e.g. EH(10, 1e-12)).
        if (!(cap <= EH_CAP_MAX)) {           // NaN-safe: a non-finite cap lands on the rejecting side
            throw new RangeError(
                '[lite-adaptive] ExponentialHistogram bucket pool cap=' + cap + ' exceeds cap ' +
                EH_CAP_MAX + ' (epsilon=' + epsilon + ', maxCount=' + maxCount + ')');
        }

        this._W = W;
        this._epsilon = epsilon;
        this._k = k;
        this._levels = levels;
        this._cap = cap;
        this._maxCount = maxCount;
        // _guard = k * levels -- the post-expiry total bucket count an overflowing insert
        // requires (every level at exactly k). Since _count (pre-expiry) >= post-expiry
        // total, `_count >= _guard` is a NECESSARY condition for overflow: the hot body
        // pays one integer compare and only the rare true branch runs the cold read-only scan.
        this._guard = k * levels;

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
    /** The declared maximum window population that sized the pool. O(1). */
    get maxCount() { return this._maxCount; }
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
            t = this._tick + 1;
            // OVERFLOW PRE-CHECK -- hot body: ONE integer compare; the read-only scan is cold
            // + rare. Placed BEFORE any state write (_tick, _now, the expiry loop) so an
            // overflow throw is a BYTE-IDENTICAL no-op.
            if (this._count >= this._guard && this._wouldOverflow(t)) return this._badOverflow();
            this._tick = t;
        } else if (mode === MODE_EXPLICIT) {
            if (now === undefined) return this._badMode('explicit', 'count');
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badNow(now);
            }
            if (now < this._lastNow) return this._badMonotone(now);
            t = now;
            if (this._count >= this._guard && this._wouldOverflow(t)) return this._badOverflow();
            this._lastNow = now;
        } else {
            // first add: the pool is empty, so the insert cannot overflow -- lock the mode.
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
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i + 1 < buf.length)) return this._badBuf(buf, i);
        const now = buf[i];       // UNBOXED Float64Array reads -- the whole point (no argument box).
        const v = buf[i + 1];     // packed [now, value]
        // --- validate the value FIRST (mirror add(); a Float64Array read is always a number,
        // so add()'s typeof branch is unreachable here and omitted). BYTE-IDENTICAL no-op. ---
        if (!(v > 0 && v < Infinity)) return this._badValue(v);
        // --- addFrom is an EXPLICIT-time entry: reject a count-locked instance, else lock/verify
        // EXPLICIT + the monotone `now` (typeof-first, no alloc). ---
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (!(now > -Infinity && now < Infinity)) return this._badNow(now);
            if (now < this._lastNow) return this._badMonotone(now);
            t = now;
            // OVERFLOW PRE-CHECK -- one hot integer compare, cold read-only scan; BEFORE any
            // state write so the throw is a BYTE-IDENTICAL no-op (see add()).
            if (this._count >= this._guard && this._wouldOverflow(t)) return this._badOverflow();
            this._lastNow = now;
        } else {
            // first addFrom: the pool is empty, so the insert cannot overflow -- lock EXPLICIT.
            if (!(now > -Infinity && now < Infinity)) return this._badNow(now);
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
     * unknown. COLD, O(numLevels). Windowed relative error <= epsilon (HARD -- the
     * merge rule bounds the straddling bucket's population). NEVER throws; returns 0
     * on an empty window.
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
     * the oldest straddling bucket's size. COLD, O(buckets). NEVER throws; returns 0 on
     * an empty window.
     *
     * ERROR (F17): the absolute error is bounded by `size(oldest straddling bucket) / 2`
     * -- half the value-mass of the single uncertain bucket. That is relative <= epsilon
     * ONLY for COUNT (value=1) or near-constant values. Levels are sized by POPULATION,
     * not by value mass, so a heavy-tailed or spiky value distribution can push a large
     * value into the straddling bucket and the relative sum error can EXCEED epsilon
     * (measured 15.8% on a heavy tail, 2504% for a lone spike, at eps .1). For a relative
     * SUM bound, keep values near-constant or use count(). count()'s bound is unaffected.
     *
     * OVERFLOW (F15): sum() is an IEEE double. It overflows to +Infinity ONLY if the windowed
     * value sum exceeds Number.MAX_VALUE (~1.8e308) -- e.g. two adds of 1e308. This is the honest
     * IEEE result, not a bug: it is a query on a VALUE, so it returns the representable answer
     * (+Infinity) rather than throwing, consistent with the package's query contract (a query
     * never throws on a bad value). count()'s bound is a POPULATION bound, so count() is unaffected.
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
            '[lite-adaptive] ExponentialHistogram add now must be a finite number, got ' + describeArg(now));
    }

    /** @private Cold thrower for a non-monotone `now`. */
    _badMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] ExponentialHistogram add now must be non-decreasing: got ' + describeArg(now) +
            ' after ' + describeArg(this._lastNow));
    }

    /** @private Cold thrower for a bad value. */
    _badValue(v) {
        throw new TypeError(
            '[lite-adaptive] ExponentialHistogram add value must be a finite number > 0, got ' + describeArg(v));
    }

    /**
     * @private COLD. Would the pending insert at time `t` overflow the fixed pool? Simulates
     * the expiry sweep for `t` READ-ONLY (no writes), then reports true iff EVERY level
     * 0..levels-1 would hold exactly k buckets post-expiry -- the one configuration in which
     * the level-0 insert cascades all the way past the top level. Called only on the rare
     * `_count >= _guard` branch (a necessary condition, since _count pre-expiry >= the
     * post-expiry total). O(levels) reads, no allocation, no mutation.
     * @param {number} t the would-be timestamp (explicit `now` or the next count tick).
     * @returns {boolean}
     */
    _wouldOverflow(t) {
        const levels = this._levels;
        const maxL = this._maxLevel;
        // Overflow needs all `levels` levels at exactly k; if the top level is unoccupied the
        // structure cannot be saturated, so no cascade can reach it.
        if (maxL !== levels - 1) return false;
        const k = this._k;
        const cutoff = t - this._W;
        const ts = this._ts;
        const next = this._next;
        const head = this._head;
        const lcount = this._lcount;
        // The expiry sweep drops the age-ordered oldest prefix: from the top (oldest) level
        // downward, stopping at the first bucket still inside the window. Walk each level's
        // list read-only, subtracting the buckets it would expire, and require every level to
        // survive at exactly k.
        let expiring = true;
        for (let L = maxL; L >= 0; L--) {
            let surviving = lcount[L];
            if (expiring) {
                let node = head[L];
                while (node !== -1 && ts[node] <= cutoff) { surviving--; node = next[node]; }
                if (node !== -1) expiring = false; // hit an in-window bucket -> nothing older-than survives to expire below
            }
            if (surviving !== k) return false;
        }
        return true;
    }

    /** @private Cold thrower for a pool overflow: the window would pass the pool's exact ceiling. */
    _badOverflow() {
        throw new RangeError(
            '[lite-adaptive] ExponentialHistogram bucket pool overflow: the window would exceed ' +
            'the pool ceiling k*(2^levels-1)=' + (this._k * (this._pow[this._levels - 1] * 2 - 1)) +
            ' elements (sized from maxCount=' + this._maxCount + ', capacity=' + this._cap + ' buckets). ' +
            'Raise maxCount to size the pool for a larger window population.');
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] ExponentialHistogram.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i + 1 < buf.length, got ' + describeArg(buf) + ', ' + describeArg(i));
    }

    /**
     * Advance the window's reference time to `now` WITHOUT inserting a value (the R11 idle
     * slide). It runs the SAME expiry sweep `add(now)` would (dropping buckets whose timestamp
     * fell out of `[now - W, now]`), but opens NO bucket -- so an idle stream still forgets at
     * the window edge and `count()` / `sum()` keep sliding to 0 with no traffic. HOT, 0 B/op.
     *
     * EXPLICIT-time ONLY (parity with addFrom): a COUNT-locked instance throws; an UNSET instance
     * locks EXPLICIT (and sets the reference time). Monotone: `now` finite and >= lastNow (a
     * decrease throws). Queries stay pure -- advance is the only op that moves the clock without
     * a value. A rejected advance is a BYTE-IDENTICAL no-op (nothing is expired, the mode is not
     * locked, the monotone guard does not advance).
     * @param {number} now the monotone time (finite, >= the last now).
     * @returns {ExponentialHistogram} this
     */
    advance(now) {
        // resolve + lock/verify the mode (typeof-first, no alloc); EXPLICIT-only.
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badAdvanceMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badAdvanceNow(now);
            }
            if (now < this._lastNow) return this._badAdvanceMonotone(now);
            t = now;
            this._lastNow = now;
        } else {
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badAdvanceNow(now);
            }
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
        }
        this._now = t;
        // --- expire buckets that fell out of [t - W, t] (oldest first) -- VERBATIM from add(),
        //     but open NO bucket (idle slide: move the window forward without inserting). ---
        const cutoff = t - this._W;
        const ts = this._ts;
        while (this._count > 0) {
            const L = this._maxLevel;
            const b = this._head[L];
            if (ts[b] > cutoff) break;
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
        return this;
    }

    /**
     * Advance the window's reference time from a caller-owned Float64Array (`now = buf[i]`, read
     * UNBOXED). The ZERO-BOX sibling of advance(now) -- identical mode / monotone / expiry body,
     * EXPLICIT-time only. Fail closed BEFORE any read (typeof-first): a non-Float64Array `buf`, or
     * a non-integer / negative / out-of-range `i` (needs `i < buf.length`) throws [lite-adaptive].
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = now.
     * @param {number} i the index of the `now` scalar.
     * @returns {ExponentialHistogram} this
     */
    advanceFrom(buf, i) {
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i < buf.length)) return this._badAdvanceBuf(buf, i);
        const now = buf[i];   // UNBOXED Float64Array read (always a number -> no typeof branch).
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badAdvanceMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (!(now > -Infinity && now < Infinity)) return this._badAdvanceNow(now);
            if (now < this._lastNow) return this._badAdvanceMonotone(now);
            t = now;
            this._lastNow = now;
        } else {
            if (!(now > -Infinity && now < Infinity)) return this._badAdvanceNow(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
        }
        this._now = t;
        const cutoff = t - this._W;
        const ts = this._ts;
        while (this._count > 0) {
            const L = this._maxLevel;
            const b = this._head[L];
            if (ts[b] > cutoff) break;
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
        return this;
    }

    /** @private Cold thrower for an advance mode switch (advance is EXPLICIT-only). */
    _badAdvanceMode(locked, attempted) {
        throw new TypeError(
            '[lite-adaptive] ExponentialHistogram mode is locked to ' + locked +
            '; advance() is an ' + attempted + '-time op');
    }

    /** @private Cold thrower for a non-finite advance `now`. */
    _badAdvanceNow(now) {
        throw new TypeError(
            '[lite-adaptive] ExponentialHistogram advance now must be a finite number, got ' + describeArg(now));
    }

    /** @private Cold thrower for a non-monotone advance `now`. */
    _badAdvanceMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] ExponentialHistogram advance now must be non-decreasing: got ' + describeArg(now) +
            ' after ' + describeArg(this._lastNow));
    }

    /** @private Cold thrower for a bad advanceFrom buffer/index. */
    _badAdvanceBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] ExponentialHistogram.advanceFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i < buf.length, got ' + describeArg(buf) + ', ' + describeArg(i));
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
// variance sigmaHat^2 and window range R = max - min (over the LIVE buckets, excluding the oldest -- 1.7.0 F18), a cut fires when
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
 * ADWIN_X_MAX -- the largest |x| whose CENTRED square is still finite. Since 1.7.0 (F9) every
 * sum / sum-of-squares accumulates the CENTRED value xc = x - c (c = the window's first value; see
 * `add`), so the quantity that must not overflow is xc*xc, not x*x. With |x| <= ADWIN_X_MAX AND
 * |c| <= ADWIN_X_MAX (c is always a value that passed this gate), |xc| <= 2*ADWIN_X_MAX, so xc*xc
 * stays finite iff 2*ADWIN_X_MAX <= sqrt(Number.MAX_VALUE) -- i.e. ADWIN_X_MAX = sqrt(MAX)/2 ~=
 * 6.7e153 (HALVED from the pre-F9 sqrt(MAX) ~= 1.34e154 exactly to keep the centred square finite).
 * A finite |x| above this makes xc*xc overflow to Infinity, which poisons _sumSq / _wsumSq:
 * variance then reads Inf - Inf = NaN (clamped to 0) while mean stays finite, so every epsCut is
 * Inf/NaN and drift detection freezes to false SILENTLY. |x| > ADWIN_X_MAX is therefore rejected
 * fail-closed via the existing _badValue thrower (one extra comparison on the COLD reject branch --
 * 0 hot-path bytes). Astronomically above any real telemetry value.
 */
const ADWIN_X_MAX = Math.sqrt(Number.MAX_VALUE) / 2;

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
 * allocation; `add(x)` validates `x` (a finite number with |x| <= sqrt(Number.MAX_VALUE)/2, so its
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
                '[lite-adaptive] ADWIN delta must be a number in (0, 1), got ' + describeArg(delta));
        }
        if (options !== undefined) {
            optDoor(options, ADWIN_KNOWN_OPTS, 'ADWIN');
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
        this._bmin = new Float64Array(cap);   // F18: min RAW x in the bucket (offset-invariant; window range R)
        this._bmax = new Float64Array(cap);   // F18: max RAW x in the bucket (offset-invariant; window range R)
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
        this._c = -0;           // centring offset (F9): every sum / sumSq holds x - c, not raw x.
                                // -0 (not 0) so the field starts in DOUBLE representation: no
                                // Smi->Double transition on the first fractional add.
        this._wsum = 0;         // running CENTRED sum over the whole window (sum of x - c)
        this._wsumSq = 0;       // running CENTRED sum of squares over the whole window (sum of (x-c)^2)
        // F18: the range R in the ADWIN2 bound is the range of the CURRENT WINDOW (ADWIN reference
        // semantics), NOT a running global min/max over all x ever seen. It is derived on demand in
        // `_scanCut` from the per-bucket _bmin/_bmax columns, EXCLUDING the globally-oldest bucket
        // (see `_scanCut`) -- no whole-window range scalar is carried, so `add`'s hot body is free of
        // any range bookkeeping (the range walk lives in the cut scan that already iterates buckets).
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
        // sums are CENTRED (F9): the true mean re-adds the centring offset c.
        return this._c + this._wsum / this._total;
    }
    /** The variance over the current window (0 on an empty window, FP-clamped >= 0). O(1). Throws if overflowed. */
    get variance() {
        const n = this._total;
        if (n <= 0) return 0;
        this._guardFinite();
        // variance is OFFSET-INVARIANT: on the centred sums it is the same formula, and c cancels
        // (Var[x - c] = Var[x]) -- this is exactly the F9 fix: no E[x^2] - mean^2 cancellation at scale.
        const cmean = this._wsum / n;
        const v = this._wsumSq / n - cmean * cmean;
        return v > 0 ? v : 0;
    }

    /**
     * Add one value to the window. HOT, 0 B/op INCLUDING the merge cascade, the cut-scan, and
     * the drop-older shrink. Opens a size-1 bucket (sum = x, sumSq = x*x, count = 1), runs the
     * bounded merge cascade, then scans every boundary split with the ADWIN2 variance-aware
     * epsCut and drops the oldest bucket(s) while a cut remains.
     *
     * Fail closed: a non-number / NaN / +-Infinity `x`, or a finite |x| > sqrt(Number.MAX_VALUE)/2
     * (~6.7e153, whose CENTRED square would overflow to Infinity and silently poison the variance / drift
     * test), throws [lite-adaptive] (typeof-first, a BYTE-IDENTICAL no-op -- nothing is opened).
     * @param {number} x  a finite real value with |x| <= sqrt(Number.MAX_VALUE)/2.
     * @returns {boolean} true iff a cut fired (drift detected) this add.
     */
    add(x) {
        // typeof guard FIRST, BEFORE any state mutation, so a rejected add is a byte-identical no-op.
        if (typeof x !== 'number' || x !== x || x === Infinity || x === -Infinity ||
            x > ADWIN_X_MAX || x < -ADWIN_X_MAX) {   // reject a finite x whose square would overflow
            return this._badValue(x);
        }
        // CENTRING (F9): anchor c at the first value of a (re)started window, then accumulate the
        // CENTRED xc = x - c into every sum / sum-of-squares. This keeps the variance out of the
        // E[x^2] - mean^2 catastrophic-cancellation regime at a large offset (the whole F9 fix).
        if (this._total === 0) this._c = x;
        const xc = x - this._c;

        // --- open a fresh level-0 bucket (count 1, sum xc, sumSq xc*xc) at the newest end ---
        const node = this._freeHead;
        if (node === -1) return this._badOverflow();
        this._freeHead = this._next[node];
        this._sum[node] = xc;
        this._sumSq[node] = xc * xc;
        this._bmin[node] = x;   // F18: a size-1 bucket's range is [x, x] (RAW)
        this._bmax[node] = x;
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
        // whole-window aggregates (CENTRED)
        this._total += 1;
        this._wsum += xc;
        this._wsumSq += xc * xc;

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
            // F18: the merged bucket's range is the union of the two ranges (window range unchanged).
            if (this._bmin[b2] < this._bmin[a]) this._bmin[a] = this._bmin[b2];
            if (this._bmax[b2] > this._bmax[a]) this._bmax[a] = this._bmax[b2];
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
        // F9: after a cut FIRES (never inside the loop), re-anchor c to the surviving window's mean
        // so centring stays close to the data across a regime change (cold, 0 alloc, O(live buckets)).
        if (changed) this._recentre();
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
     * +-Infinity `buf[i]`, or a finite |buf[i]| > sqrt(Number.MAX_VALUE)/2 (centred square would overflow),
     * throws (a byte-identical no-op).
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = the value (|x| <= sqrt(MAX)/2).
     * @param {number} i the index of the value to read.
     * @returns {boolean} true iff a cut fired (drift detected) this add.
     */
    addFrom(buf, i) {
        // Guard the buffer + index on the COLD branch first (a bad handle is a byte-identical no-op).
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i < buf.length)) return this._badBuf(buf, i);
        const x = buf[i];   // UNBOXED Float64Array read -- the whole point (no argument box).
        // --- validate x FIRST (mirror add(); a Float64Array read is always a number, so add()'s
        // typeof branch is unreachable here and omitted). BYTE-IDENTICAL no-op on reject. ---
        if (!(x <= ADWIN_X_MAX && x >= -ADWIN_X_MAX))
            return this._badValue(x);   // centred square would overflow
        // CENTRING (F9) -- DUPLICATED from add(): anchor c on a (re)started window, accumulate x - c.
        if (this._total === 0) this._c = x;
        const xc = x - this._c;

        // --- open a fresh level-0 bucket (count 1, sum xc, sumSq xc*xc) at the newest end --
        //     DUPLICATED from add() to keep add()'s hot body byte-identical. ---
        const node = this._freeHead;
        if (node === -1) return this._badOverflow();
        this._freeHead = this._next[node];
        this._sum[node] = xc;
        this._sumSq[node] = xc * xc;
        this._bmin[node] = x;   // F18 -- DUPLICATED from add(): a size-1 bucket's range is [x, x] (RAW)
        this._bmax[node] = x;
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
        this._wsum += xc;
        this._wsumSq += xc * xc;

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
            // F18 -- DUPLICATED from add(): the merged bucket's range is the union of both.
            if (this._bmin[b2] < this._bmin[a]) this._bmin[a] = this._bmin[b2];
            if (this._bmax[b2] > this._bmax[a]) this._bmax[a] = this._bmax[b2];
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
        if (changed) this._recentre();   // F9: re-anchor c after a cut (see add()).
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
        const head = this._head;
        const next = this._next;
        const bc = this._bcount;
        const sum = this._sum;
        // F18: R is the range of the CURRENT window, taken over the live buckets' RAW min/max
        // (_bmin/_bmax) but EXCLUDING the globally-oldest bucket (head of the highest level). After a
        // level shift a single "straddling" bucket at the oldest end carries one stale value from the
        // prior regime; a whole-window range would let that lone value pin R at the old shift height
        // forever (the range term (2/3)(R/m)ln(2/deltaP) then dominates and ADWIN goes deaf -- the F18
        // bug). Excluding the oldest bucket is exactly the range of the window ADWIN would RETAIN when
        // it cuts there, so the straddle's stale extreme cannot protect it, yet on a stationary stream
        // the (large, well-sampled) oldest bucket's exclusion barely moves R -> the false-alarm rate
        // stays <= delta. One O(live buckets) pass, 0 alloc (cold relative to add's per-item work).
        const bmin = this._bmin, bmax = this._bmax;
        const oldest = head[this._maxLevel];     // the globally-oldest bucket, excluded from R
        let rlo = Infinity, rhi = -Infinity;
        for (let L = this._maxLevel; L >= 0; L--) {
            let rn = head[L];
            while (rn !== -1) {
                if (rn !== oldest) {
                    if (bmin[rn] < rlo) rlo = bmin[rn];
                    if (bmax[rn] > rhi) rhi = bmax[rn];
                }
                rn = next[rn];
            }
        }
        const R = rhi >= rlo ? rhi - rlo : 0;     // 0 when the window is a single (excluded) bucket
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
        // F18: nothing to do for the range -- it is derived fresh from the live buckets in `_scanCut`
        // (a freed bucket's _bmin/_bmax slot is dead and never read).
    }

    /**
     * @private F9 -- re-anchor the centring offset c to the current window MEAN after a cut has
     * fired (called from `add` / `addFrom` AFTER the cut loop exits, never inside it). Every live
     * bucket's CENTRED sum / sum-of-squares, and the window totals, are shifted from offset c to
     * c' = c + wsum/n (the current window mean) via
     *     sum'   = sum   - n*d
     *     sumSq' = sumSq - 2*d*sum + n*d^2        (d = c' - c = wsum/n; n = bucket count)
     * so the stored quantities keep their meaning (sum of x - c') while c tracks the DATA after a
     * regime change -- otherwise a shift plus a large absolute offset would slowly re-inflate the
     * centred magnitudes. COLD (once per fired cut), 0 alloc, O(live buckets). A slow drift WITHOUT
     * a cut is NOT re-centred here: c then lags the data, but the centred error grows only with the
     * DRIFT magnitude (|mean - c|), never with the absolute offset -- see ADR 0003 amendment.
     */
    _recentre() {
        const n = this._total;
        if (n <= 0) return;               // empty window -> the next add re-anchors c to x (fail-safe)
        const d = this._wsum / n;         // c' - c = the current centred window mean
        if (d === 0) return;              // already centred on the mean -> no work, keeps FP exact
        const sum = this._sum, sumSq = this._sumSq, bc = this._bcount;
        const head = this._head, next = this._next;
        for (let L = this._maxLevel; L >= 0; L--) {
            let node = head[L];
            while (node !== -1) {
                const s = sum[node], nb = bc[node];
                sumSq[node] = sumSq[node] - 2 * d * s + nb * d * d;
                sum[node] = s - nb * d;
                node = next[node];
            }
        }
        this._wsumSq = this._wsumSq - 2 * d * this._wsum + n * d * d;
        this._wsum = this._wsum - n * d;   // ~= 0 (modulo FP): the window is now centred on its mean
        this._c = this._c + d;
    }

    /** Reset to the empty window; reuse the pool. O(cap). @returns {ADWIN} this */
    clear() {
        this._initState();
        return this;
    }

    /** @private Cold thrower for a bad value. */
    _badValue(x) {
        throw new TypeError(
            '[lite-adaptive] ADWIN add x must be a finite number with |x| <= sqrt(Number.MAX_VALUE)/2 ' +
            '(~6.7e153, so the centred square (x - c)*(x - c) stays finite), got ' + describeArg(x));
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
            'integer index (0 <= i < buf.length), got ' + describeArg(buf) + ', ' + describeArg(i));
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
                '[lite-adaptive] ForwardDecay halfLife must be a finite number > 0, got ' + describeArg(halfLife));
        }
        // A subnormal halfLife makes lambda = ln2/halfLife overflow to Infinity, which poisons
        // every weight to NaN. Reject it here, BEFORE any field init, NaN-safe (F14).
        const lambda = Math.LN2 / halfLife;
        if (!(lambda < Infinity)) {
            throw new RangeError(
                '[lite-adaptive] ForwardDecay halfLife ' + describeArg(halfLife) +
                ' is too small: lambda = ln2/halfLife = ' + describeArg(lambda) +
                ' is not finite; halfLife must be >= ' + LAMBDA_HALFLIFE_MIN);
        }
        if (options !== undefined) {
            optDoor(options, FD_KNOWN_OPTS, 'ForwardDecay');
        }
        this._halfLife = halfLife;
        this._lambda = lambda;   // g(x) = exp(lambda * x); halves every halfLife
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
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i + 1 < buf.length)) return this._badBuf(buf, i);
        const now = buf[i];       // UNBOXED Float64Array reads -- the whole point (no argument box).
        const v = buf[i + 1];     // packed [now, value]
        // --- validate the value FIRST (mirror add(); any finite real is legal, signed OK; a
        // Float64Array read is always a number so add()'s typeof branch is omitted). ---
        if (!(v > -Infinity && v < Infinity)) return this._badValue(v);
        // --- addFrom is an EXPLICIT-time entry: reject a count-locked instance, else lock/verify
        // EXPLICIT + the monotone `now` (typeof-first, no alloc). ---
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (!(now > -Infinity && now < Infinity)) return this._badNow(now);
            if (now < this._lastNow) return this._badMonotone(now);
            t = now;
            this._lastNow = now;
        } else {
            if (!(now > -Infinity && now < Infinity)) return this._badNow(now);
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
            '[lite-adaptive] ForwardDecay add now must be a finite number, got ' + describeArg(now));
    }

    /** @private Cold thrower for a non-monotone `now`. */
    _badMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] ForwardDecay add now must be non-decreasing: got ' + describeArg(now) +
            ' after ' + describeArg(this._lastNow));
    }

    /** @private Cold thrower for a bad value. */
    _badValue(v) {
        throw new TypeError(
            '[lite-adaptive] ForwardDecay add value must be a finite number, got ' + describeArg(v));
    }

    /** @private Cold thrower for a query time before the last add (can't un-decay). */
    _badQueryTime(now) {
        throw new RangeError(
            '[lite-adaptive] ForwardDecay query time must be a finite number >= the last add time (' +
            describeArg(this._now) + '), got ' + describeArg(now));
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
            'integer index with i + 1 < buf.length, got ' + describeArg(buf) + ', ' + describeArg(i));
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
/**
 * Hard ceiling on the flat table cell count d*w (F11). 2^27 cells x 8 B (fp + count) = ~1 GB of
 * table, the memory ceiling; above it the ctor throws a tagged RangeError BEFORE allocation instead
 * of aborting the process on a V8 fatal (the pre-1.7.0 failure).
 */
const HK_CELLS_CAP = 2 ** 27;
/** Max table width w (F11): 2^30 keeps `hkPos`'s `% w` in Smi range on a 31-bit-Smi runtime. */
const HK_W_MAX = 2 ** 30;
/** Max top-k size k (F11): 2^24 heap slots x 16 B (key + est) = ~256 MB, the heap memory ceiling. */
const HK_K_MAX = 2 ** 24;

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
const HK_KNOWN_OPTS = Object.freeze(Object.assign(Object.create(null), { seed: true, b: true }));

/**
 * Module scratch for the HeavyKeeper hot path -- the alloc-free "pass values without an argument
 * boundary" trick (ROADMAP N6). A safe-integer KEY or a uint32 SEED >= 2^30 held in a `let` or
 * crossed as a call argument boxes a 31-bit-Smi Chrome HeapNumber; a Float64Array / Int32Array
 * slot never does. So the caller writes the numeric inputs into HK_KIN and each helper reads them
 * from the slot -- no numeric argument crosses hkHash / hkMapHash / _promote / the map ops (hkPos(r, w)
 * takes only Smi-range ints r, w, which never box).
 *
 * HK_KIN (Float64Array(4)) inputs: [0] = key, [1] = seed, [2] = map-key, [3] = estimate.
 * HK_HS  (Int32Array(3)) hash out: [0] = h1 (fingerprint lane), [1] = h2 (position base lane),
 *                                  [2] = map-index hash. Int32 slots so a lane >= 2^31 never boxes
 *                                  a HeapNumber into a module let; readers recover unsigned via `>>> 0`.
 *                                  (SlidingCountMin reuses this pair: it calls hkHash then folds
 *                                  base = (HK_HS[0] ^ HK_HS[1]) | 0, bit-identical to its own two-lane
 *                                  murmur -- proven by SCMParity.)
 *
 * The murmur ROUNDS + fmix run entirely in `let` int32 locals inside each argument-free helper
 * (F19v2): no hash word crosses an inner call boundary, so nothing can box on a 31-bit-Smi build,
 * yet -- unlike the earlier per-round Int32Array round-trip -- the locals stay register-resident so
 * V8 keeps the hot body fast (the round-trip cost ~59% on the SCM hot path). The single Int32Array
 * store of each lane applies ToInt32 exactly as `| 0` would, so every hash output is BIT-IDENTICAL.
 *
 * CONTRACT: a slot is live only between its writes and the hash / helper that reads it, and NO user
 * code runs in that window. Every input is read into a LOCAL first -- a read of a caller's typed array
 * can itself run user code (a Proxy passes `instanceof Float64Array`) -- and the slots are written
 * immediately before the call (forEach callbacks also fire OUTSIDE add). So interleaved instances
 * (HeavyKeeper, SlidingCountMin estimate / estimateInto) never observe each other's scratch.
 */
const HK_KIN = new Float64Array(4);
const HK_HS = new Int32Array(3);

/**
 * Hash the scratch key HK_KIN[0] with the scratch seed HK_KIN[1] into HK_HS[0] (fingerprint lane)
 * and HK_HS[1] (position base lane): the key's low + high words folded through TWO independently
 * seeded murmur3 bodies. NO numeric argument (the key / seed live in Float64Array slots), and every
 * round + fmix runs in `let` int32 LOCALS -- no hash word crosses an inner call boundary either
 * (F19v2: the earlier per-round Int32Array round-trip defeated V8 scalar-replacement and cost
 * ~59% on the SCM hot path; locals are register-resident, and the sole Int32Array store applies
 * ToInt32 exactly as `| 0` would, so the output is BIT-IDENTICAL). Zero allocation, no BigInt.
 */
function hkHash() {
    let a = HK_KIN[0], neg = 0;
    if (a < 0) { a = -a; neg = 1; }
    const lo = a >>> 0;                        // low 32 bits (ToUint32)
    const hi = ((a - lo) / 4294967296) >>> 0;  // high word (exact for safe integers)
    const w1 = (hi ^ neg) | 0;
    const s = HK_KIN[1] >>> 0;
    // fingerprint lane
    let h = s | 0, k;
    k = Math.imul(lo, HK_C1); k = (k << 15) | (k >>> 17); k = Math.imul(k, HK_C2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    k = Math.imul(w1, HK_C1); k = (k << 15) | (k >>> 17); k = Math.imul(k, HK_C2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    h ^= 8; h ^= h >>> 16; h = Math.imul(h, HK_FC1); h ^= h >>> 13; h = Math.imul(h, HK_FC2); h ^= h >>> 16;
    HK_HS[0] = h;
    // position base lane
    let g = (s ^ HK_LANE_SALT) | 0;
    k = Math.imul(lo, HK_C1); k = (k << 15) | (k >>> 17); k = Math.imul(k, HK_C2);
    g ^= k; g = (g << 13) | (g >>> 19); g = (Math.imul(g, 5) + 0xe6546b64) | 0;
    k = Math.imul(w1, HK_C1); k = (k << 15) | (k >>> 17); k = Math.imul(k, HK_C2);
    g ^= k; g = (g << 13) | (g >>> 19); g = (Math.imul(g, 5) + 0xe6546b64) | 0;
    g ^= 8; g ^= g >>> 16; g = Math.imul(g, HK_FC1); g ^= g >>> 13; g = Math.imul(g, HK_FC2); g ^= g >>> 16;
    HK_HS[1] = g;
}

/**
 * Column position of row r: a per-row salt of the position base lane HK_HS[1], mod w. Zero-alloc.
 * KEEP `>>> 0` before `% w`: a negative `int|0 % w` would change positions. `(...>>> 0) % w` is an
 * int in [0, w) (a Smi for any legal w), so the return never boxes.
 */
function hkPos(r, w) {
    let h = (HK_HS[1] ^ Math.imul(r, HK_ODD)) | 0;
    h ^= h >>> 16; h = Math.imul(h, HK_FC1); h ^= h >>> 13; h = Math.imul(h, HK_FC2); h ^= h >>> 16;
    return (h >>> 0) % w;
}

/**
 * A standalone map-index hash of the scratch map-key HK_KIN[2] with seed HK_KIN[1], written to
 * HK_HS[2] (does NOT touch HK_HS[0] / HK_HS[1]). Returns void. The caller masks HK_HS[2]: index
 * bit-identical because `(x >>> 0) & mask === (x | 0) & mask` for any power-of-two mask < 2^31.
 */
function hkMapHash() {
    let a = HK_KIN[2], neg = 0;
    if (a < 0) { a = -a; neg = 1; }
    const lo = a >>> 0;
    const hi = ((a - lo) / 4294967296) >>> 0;
    const w1 = (hi ^ neg) | 0;
    let h = ((HK_KIN[1] | 0) ^ HK_MAP_SALT) | 0, k;
    k = Math.imul(lo, HK_C1); k = (k << 15) | (k >>> 17); k = Math.imul(k, HK_C2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    k = Math.imul(w1, HK_C1); k = (k << 15) | (k >>> 17); k = Math.imul(k, HK_C2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    h ^= 8; h ^= h >>> 16; h = Math.imul(h, HK_FC1); h ^= h >>> 13; h = Math.imul(h, HK_FC2); h ^= h >>> 16;
    HK_HS[2] = h;
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
 *   - ERROR: a bounded, ONE-SIDED estimate that NEVER overestimates -- a reported count is in
 *     [true - err, true] for the current leaders (ADR 0005; the witness gates worst-overestimate 0);
 *     recall of the true heavy hitters is high on skew (witnessed vs Space-Saving).
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
                '[lite-adaptive] HeavyKeeper d must be an integer in [1, ' + HK_D_MAX + '], got ' + describeArg(d));
        }
        if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > HK_W_MAX) {
            throw new RangeError(
                '[lite-adaptive] HeavyKeeper w must be an integer in [1, ' + HK_W_MAX + '], got ' + describeArg(w));
        }
        if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > HK_K_MAX) {
            throw new RangeError(
                '[lite-adaptive] HeavyKeeper k must be an integer in [1, ' + HK_K_MAX + '], got ' + describeArg(k));
        }
        // Cells cap BEFORE allocation (F11): d*w past 2^27 aborted the process on a V8 fatal in 1.6.0.
        if (d * w > HK_CELLS_CAP) {
            throw new RangeError(
                '[lite-adaptive] HeavyKeeper table d*w=' + (d * w) + ' exceeds cap ' + HK_CELLS_CAP);
        }
        let seed = HK_DEFAULT_SEED;
        let b = HK_DEFAULT_B;
        if (options !== undefined) {
            optDoor(options, HK_KNOWN_OPTS, 'HeavyKeeper');
            // seed=0 is a VALID distinct seed -- guard `undefined`, not falsy (null is not zero).
            if (options.seed !== undefined) {
                const s = options.seed;
                if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || s > 4294967295) {
                    throw new RangeError(
                        '[lite-adaptive] HeavyKeeper seed must be a uint32 (integer in [0, 2^32-1]), got ' + describeArg(s));
                }
                seed = s;
            }
            if (options.b !== undefined) {
                const bb = options.b;
                if (typeof bb !== 'number' || bb !== bb || bb === Infinity || bb <= 1) {
                    throw new RangeError(
                        '[lite-adaptive] HeavyKeeper b (decay base) must be a finite number > 1, got ' + describeArg(bb));
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
        let rs = (seed ^ HK_RNG_SALT) | 0;
        rs ^= rs >>> 16; rs = Math.imul(rs, HK_FC1); rs ^= rs >>> 13; rs = Math.imul(rs, HK_FC2); rs ^= rs >>> 16;
        this._rng0 = (rs | 1) | 0;
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
                '[lite-adaptive] HeavyKeeper.withAccuracy k must be an integer >= 1, got ' + describeArg(k));
        }
        if (typeof targetError !== 'number' || targetError !== targetError ||
            targetError <= 0 || targetError >= 1) {
            throw new RangeError(
                '[lite-adaptive] HeavyKeeper.withAccuracy targetError must be a number in (0, 1), got ' +
                describeArg(targetError));
        }
        // Same door as the ctor (R6), with the factory label, BEFORE forwarding options.
        optDoor(options, HK_KNOWN_OPTS, 'HeavyKeeper.withAccuracy');
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
        } else if (typeof wt !== 'number' || !Number.isSafeInteger(wt) || wt <= 0 || wt > 4294967295) {
            // A single weight above 2^32-1 is REJECTED (an accumulated cell SATURATES at 2^32-1
            // in the body below; the two rules are distinct -- F10). Byte-identical no-op on reject.
            return this._badWeight(wt);
        }

        // --- the accumulate body (DUPLICATED in addFrom to keep this hot body byte-identical). ---
        // key + seed into Float64Array slots so no numeric argument crosses hkHash / _promote (a
        // large key >= 2^31 boxes as a plain `add` argument -- that is F3; here it never boxes).
        HK_KIN[0] = key;
        HK_KIN[1] = this._seed;
        hkHash();
        const fp = HK_HS[0] | 0;                  // signed int32: `(fps[cell]|0) === fp` never boxes
        const d = this._d, w = this._w;
        const fps = this._fp, cnt = this._cnt;
        const lut = this._decayLut, b = this._b;
        let best = 0;
        for (let r = 0; r < d; r++) {
            const cell = r * w + hkPos(r, w);
            const c = cnt[cell];
            if (c === 0) {
                fps[cell] = fp;                   // ToUint32 store: bit-identical to the old fp
                cnt[cell] = wt;
                if (wt > best) best = wt;
            } else if ((fps[cell] | 0) === fp) {
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
        HK_KIN[3] = best;                         // est into a slot: no boxed arg into _promote
        this._promote();
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
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i + 1 < buf.length)) return this._badBuf(buf, i);
        const key = buf[i];         // UNBOXED Float64Array reads -- the whole point (no arg box).
        const wt = buf[i + 1];      // packed [key, weight]
        if (!Number.isSafeInteger(key)) return this._badKey(key);
        if (!Number.isSafeInteger(wt) || wt <= 0 || wt > 4294967295) return this._badWeight(wt);

        // --- the accumulate body -- DUPLICATED from add() to keep add()'s hot body byte-identical. ---
        // key (buf[i]) + seed into slots so no numeric argument crosses hkHash / _promote: the whole
        // point -- a key / weight >= 2^31 read UNBOXED here never boxes (F3 zero-box for addFrom).
        HK_KIN[0] = key;
        HK_KIN[1] = this._seed;
        hkHash();
        const fp = HK_HS[0] | 0;
        const d = this._d, w = this._w;
        const fps = this._fp, cnt = this._cnt;
        const lut = this._decayLut, b = this._b;
        let best = 0;
        for (let r = 0; r < d; r++) {
            const cell = r * w + hkPos(r, w);
            const c = cnt[cell];
            if (c === 0) {
                fps[cell] = fp;
                cnt[cell] = wt;
                if (wt > best) best = wt;
            } else if ((fps[cell] | 0) === fp) {
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
        HK_KIN[3] = best;
        this._promote();
        return this;
    }

    /**
     * The estimated count of `key` -- the max count over the d cells whose fingerprint matches
     * (0 if none match). COLD, O(d). NEVER throws (F12): a non-safe-integer / non-number key reads
     * NaN (an invalid key was never seen 0 times), an unseen but VALID key reads 0. null is not zero.
     * @param {number} key a safe integer.
     * @returns {number}
     */
    estimate(key) {
        // F12: a bad key is NaN, never a throw (one contract -- queries never throw on a bad value).
        // An UNSEEN valid key still reads 0 (null is not zero).
        if (typeof key !== 'number' || !Number.isSafeInteger(key)) return NaN;
        HK_KIN[0] = key;
        HK_KIN[1] = this._seed;
        hkHash();
        const fp = HK_HS[0] | 0;
        const d = this._d, w = this._w;
        const fps = this._fp, cnt = this._cnt;
        let best = 0;
        for (let r = 0; r < d; r++) {
            const cell = r * w + hkPos(r, w);
            if ((fps[cell] | 0) === fp) {
                const c = cnt[cell];
                if (c > best) best = c;
            }
        }
        return best;   // COLD: the single boxed return (a uint32 >= 2^31) is F6, out of scope here.
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
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || !(TA_LEN.call(buf) >= 2 * this._k)) return this._badTopKBuf(buf);
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
    _promote() {
        // key + est read from slots (never a boxed argument): HK_KIN[0] = key, HK_KIN[3] = est.
        const key = HK_KIN[0], est = HK_KIN[3];
        HK_KIN[2] = key;                          // map-key slot for _mapFind
        const pos = this._mapFind();
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
            HK_KIN[2] = key;                      // map-key slot for _mapSet
            this._mapSet(n);
            this._hkN = n + 1;
            this._siftUp(n);
        } else if (est > this._hkEst[0]) {
            HK_KIN[2] = this._hkKey[0];           // map-key slot for _mapDel (the evicted min)
            this._mapDel();
            this._hkKey[0] = key;
            this._hkEst[0] = est;
            HK_KIN[2] = key;                      // map-key slot for _mapSet
            this._mapSet(0);
            this._siftDown(0);
        }
    }

    /**
     * @private Swap heap slots a, b and keep the map positions in sync. 0-alloc. Writes HK_KIN[2]
     * (the map-key) before each _mapSet; NEVER touches HK_KIN[0] / HK_KIN[3], so the key / est that
     * the calling _promote still needs are undisturbed by a sift.
     */
    _hswap(a, b) {
        const hk = this._hkKey, he = this._hkEst;
        const ka = hk[a], ea = he[a], kb = hk[b], eb = he[b];
        hk[a] = kb; he[a] = eb; hk[b] = ka; he[b] = ea;
        HK_KIN[2] = kb; this._mapSet(a);
        HK_KIN[2] = ka; this._mapSet(b);
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

    /** @private Find the map-key HK_KIN[2]'s heap slot, or -1. Linear probing. 0-alloc, no arg. */
    _mapFind() {
        const mask = this._mapCap - 1;
        const mk = this._mapKey, mp = this._mapPos;
        const key = HK_KIN[2];
        hkMapHash();
        let i = HK_HS[2] & mask;
        while (mk[i] === mk[i]) {           // occupied (a NaN slot fails self-equality)
            if (mk[i] === key) return mp[i];
            i = (i + 1) & mask;
        }
        return -1;
    }

    /** @private Insert HK_KIN[2] -> `pos`, or update its stored pos if already present. 0-alloc. */
    _mapSet(pos) {
        const mask = this._mapCap - 1;
        const mk = this._mapKey, mp = this._mapPos;
        const key = HK_KIN[2];
        hkMapHash();
        let i = HK_HS[2] & mask;
        while (mk[i] === mk[i]) {
            if (mk[i] === key) { mp[i] = pos; return; }
            i = (i + 1) & mask;
        }
        mk[i] = key;
        mp[i] = pos;                        // pos is a Smi heap slot
        this._mapSize++;
    }

    /** @private Delete HK_KIN[2] with Knuth backward-shift so the probe chains stay contiguous. 0-alloc. */
    _mapDel() {
        const mask = this._mapCap - 1;
        const mk = this._mapKey, mp = this._mapPos;
        const key = HK_KIN[2];
        hkMapHash();
        let i = HK_HS[2] & mask;
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
                HK_KIN[2] = mk[j];                   // probe key into the slot for its home hash
                hkMapHash();
                const home = HK_HS[2] & mask;
                // keep mk[j] iff its home does NOT lie cyclically in (i, j] (it must not shift back).
                if (i <= j ? (home <= i || home > j) : (home <= i && home > j)) break;
            } while (true);
            mk[i] = mk[j]; mp[i] = mp[j]; i = j;
        }
    }

    /** @private Cold thrower for a bad key. */
    _badKey(key) {
        throw new TypeError(
            '[lite-adaptive] HeavyKeeper key must be a safe integer, got ' + describeArg(key));
    }

    /** @private Cold thrower for a bad weight (closed domain [1, 2^32-1], SCM count parity). */
    _badWeight(w) {
        throw new TypeError(
            '[lite-adaptive] HeavyKeeper weight must be an integer in [1, 4294967295], got ' + describeArg(w));
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] HeavyKeeper.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i + 1 < buf.length, got ' + describeArg(buf) + ', ' + describeArg(i));
    }

    /** @private Cold thrower for a too-small / non-Float64Array topKInto buffer. */
    _badTopKBuf(buf) {
        throw new TypeError(
            '[lite-adaptive] HeavyKeeper.topKInto(buf) needs a Float64Array of length >= 2*k (k=' +
            this._k + ', so it holds a full top-k as [key, estimate] pairs), got ' + describeArg(buf));
    }

    /** @private Cold thrower for a non-function forEach callback. */
    _badFn(fn) {
        throw new TypeError(
            '[lite-adaptive] HeavyKeeper.forEach(fn) needs a function, got ' + describeArg(fn));
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
// pop every tail entry with rho <= the new rho (now dominated), then DROP expired head entries
// (stamp <= now - W) so the ring holds only in-window entries, then append (now, rho). If the ring
// is STILL full after that expiry, the drop is an IN-WINDOW eviction: bump `_overflows` (the honest
// degradation signal; `degraded` flips true). 0 B/op incl. that windowed eviction. Since expiry is
// done here (F8, 1.7.0), `_overflows` counts only genuine capacity pressure -- it is independent of
// how often you query, and each entry is dropped exactly once (amortized O(1)).
//
// COLD count(w?): PURE -- it NEVER mutates the rings (F8). It scans each register for the rho of
// the OLDEST in-window entry (the first with stamp > now - w for a sub-window w <= W, else > now - W),
// folding the register multiplicity vector through Ertl's improved estimator (sigma / tau,
// alpha_inf; design-parity with lite-sketch, inline). Expired-by-W entries are skipped by the same
// stamp test, so the estimate is bit-identical to the old destructive path. The register value
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
const SL_KNOWN_OPTS = Object.freeze(Object.assign(Object.create(null), { p: true, ringCap: true, seed: true }));

// The SlidingHyperLogLog two-lane murmur3 (design-parity with lite-sketch HLL) is HAND-INLINED in
// int32 locals directly in add / addFrom (F19v2): the key word + hash state never leave a register,
// so no >= 2^31 word crosses a call boundary (no 31-bit-Smi HeapNumber box) and there is no per-round
// Int32Array round-trip (that cost throughput). Bit-identical to the golden vectors -- SHLLParity.

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
 * Cold path: `count(w?)` is O(m) (a disclosed co-headline, NOT per-add) and PURE -- skip expired, then
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
                '[lite-adaptive] SlidingHyperLogLog W must be a finite number > 0, got ' + describeArg(W));
        }
        let p = SL_DEFAULT_P;
        let ringCap = SL_DEFAULT_RINGCAP;
        let seed = SL_DEFAULT_SEED;
        if (options !== undefined) {
            optDoor(options, SL_KNOWN_OPTS, 'SlidingHyperLogLog');
            if (options.p !== undefined) {
                const pp = options.p;
                if (typeof pp !== 'number' || (pp | 0) !== pp || pp < SL_P_MIN || pp > SL_P_MAX) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingHyperLogLog p must be an integer in [' + SL_P_MIN + ', ' +
                        SL_P_MAX + '], got ' + describeArg(pp));
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
                        SL_RINGCAP_MAX + '], got ' + describeArg(rc));
                }
                ringCap = rc;
            }
            // seed=0 is a VALID distinct seed -- guard `undefined`, not falsy (null is not zero).
            if (options.seed !== undefined) {
                const s = options.seed;
                if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || s > 4294967295) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingHyperLogLog seed must be a uint32 (integer in [0, 2^32-1]), got ' +
                        describeArg(s));
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
        // Ertl multiplicity vector -- the scratch keeps count() free of ARRAY allocation, but the
        // estimator RETURNS a double: count() boxes 16-32 B per call (16 B steady in the estimator
        // tail, +16 B when the caller is not yet optimized -- see the README F6 alloc table).
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

        // --- the two-lane murmur, HAND-INLINED in int32 locals (F19v2): the key word / hash state
        //     never leaves a register, so nothing crosses a call boundary (no >= 2^31 HeapNumber box)
        //     and there is no per-round Int32Array round-trip (that cost throughput). Output
        //     bit-identical -- design-parity with lite-sketch HLL, proven by SHLLParity. ---
        let a = key, neg = 0;
        if (a < 0) { a = -a; neg = 1; }
        const lo = a >>> 0;
        const w1 = (a < 4294967296 ? 0 : (Math.floor(a / 4294967296) >>> 0)) ^ neg;
        const seed = this._seed;
        let hh = seed | 0, kk;
        kk = Math.imul(lo, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        hh ^= kk; hh = (hh << 13) | (hh >>> 19); hh = (Math.imul(hh, 5) + 0xe6546b64) | 0;
        kk = Math.imul(w1, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        hh ^= kk; hh = (hh << 13) | (hh >>> 19); hh = (Math.imul(hh, 5) + 0xe6546b64) | 0;
        hh ^= 8; hh ^= hh >>> 16; hh = Math.imul(hh, HK_FC1); hh ^= hh >>> 13; hh = Math.imul(hh, HK_FC2); hh ^= hh >>> 16;
        let gg = (seed ^ SL_LANE_SALT) | 0;
        kk = Math.imul(lo, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        gg ^= kk; gg = (gg << 13) | (gg >>> 19); gg = (Math.imul(gg, 5) + 0xe6546b64) | 0;
        kk = Math.imul(w1, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        gg ^= kk; gg = (gg << 13) | (gg >>> 19); gg = (Math.imul(gg, 5) + 0xe6546b64) | 0;
        gg ^= 8; gg ^= gg >>> 16; gg = Math.imul(gg, HK_FC1); gg ^= gg >>> 13; gg = Math.imul(gg, HK_FC2); gg ^= gg >>> 16;
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
        // F8: drop expired heads (stamp <= this add's t - W) BEFORE the ring-full check, so a full
        // ring is a genuine IN-WINDOW drop -> overflows++ that does NOT depend on query cadence.
        // Amortized O(1): every entry is dropped exactly once, here in add(), never in count().
        const exp = t - this._W;
        while (len > 0 && stamps[base + (head & mask)] <= exp) { head = (head + 1) & mask; len--; }
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
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i + 1 < buf.length)) return this._badBuf(buf, i);
        const now = buf[i];       // UNBOXED Float64Array reads -- the whole point (no argument box).
        const key = buf[i + 1];   // packed [now, key]
        if (!Number.isSafeInteger(key)) return this._badKey(key);
        // addFrom is an EXPLICIT-time entry: reject a count-locked instance, else lock/verify EXPLICIT.
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (!(now > -Infinity && now < Infinity)) return this._badNow(now);
            if (now < this._lastNow) return this._badMonotone(now);
            t = now;
            this._lastNow = now;
        } else {
            if (!(now > -Infinity && now < Infinity)) return this._badNow(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
        }
        this._now = t;

        // --- the two-lane murmur, HAND-INLINED in int32 locals -- DUPLICATED from add() (see there). ---
        let a = key, neg = 0;
        if (a < 0) { a = -a; neg = 1; }
        const lo = a >>> 0;
        const w1 = (a < 4294967296 ? 0 : (Math.floor(a / 4294967296) >>> 0)) ^ neg;
        const seed = this._seed;
        let hh = seed | 0, kk;
        kk = Math.imul(lo, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        hh ^= kk; hh = (hh << 13) | (hh >>> 19); hh = (Math.imul(hh, 5) + 0xe6546b64) | 0;
        kk = Math.imul(w1, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        hh ^= kk; hh = (hh << 13) | (hh >>> 19); hh = (Math.imul(hh, 5) + 0xe6546b64) | 0;
        hh ^= 8; hh ^= hh >>> 16; hh = Math.imul(hh, HK_FC1); hh ^= hh >>> 13; hh = Math.imul(hh, HK_FC2); hh ^= hh >>> 16;
        let gg = (seed ^ SL_LANE_SALT) | 0;
        kk = Math.imul(lo, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        gg ^= kk; gg = (gg << 13) | (gg >>> 19); gg = (Math.imul(gg, 5) + 0xe6546b64) | 0;
        kk = Math.imul(w1, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        gg ^= kk; gg = (gg << 13) | (gg >>> 19); gg = (Math.imul(gg, 5) + 0xe6546b64) | 0;
        gg ^= 8; gg ^= gg >>> 16; gg = Math.imul(gg, HK_FC1); gg ^= gg >>> 13; gg = Math.imul(gg, HK_FC2); gg ^= gg >>> 16;
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
        // F8: drop expired heads (stamp <= this add's t - W) BEFORE the ring-full check, so a full
        // ring is a genuine IN-WINDOW drop -> overflows++ that does NOT depend on query cadence.
        // Amortized O(1): every entry is dropped exactly once, here in add(), never in count().
        const exp = t - this._W;
        while (len > 0 && stamps[base + (head & mask)] <= exp) { head = (head + 1) & mask; len--; }
        if (len === cap) { head = (head + 1) & mask; len--; this._overflows++; }
        const at = base + ((head + len) & mask);
        stamps[at] = t;
        rhos[at] = rho;
        heads[j] = head;
        lens[j] = len + 1;
        return this;
    }

    /**
     * The windowed DISTINCT-COUNT estimate over the last W (or a sub-window `w <= W`). PURE (F8):
     * it NEVER mutates the rings -- expiry happens in `add` / `addFrom`, so `overflows` / `degraded`
     * and the ring state are independent of how often you query. It scans each register for the
     * OLDEST entry still inside the window (its highest windowed rho), then runs Ertl's improved
     * estimator (2017). COLD, O(m + total entries) (a disclosed co-headline, NOT per-add): 0 alloc
     * (the multiplicity vector is the reused `_hist`). Standard error 1.04 / sqrt(m), guaranteed
     * only while `degraded === false`. Returns 0 on an empty window.
     *
     * NEVER throws (F12): a sub-window `w` outside `(0, W]` (non-finite, <= 0, or > W) reads NaN,
     * never a throw; `w` omitted queries the full window W. An empty window reads 0. null is not zero.
     * @param {number} [w] an optional sub-window in `(0, W]` (omit for the full window W).
     * @returns {number}
     */
    count(w) {
        let effW = this._W;
        if (w !== undefined) {
            // F12: a bad sub-window is NaN, never a throw (one contract -- queries never throw on a
            // bad value). An unseen/empty window still reads 0. null is not zero.
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) {
                return NaN;
            }
            effW = w;
        }
        if (this._mode === MODE_UNSET) return 0;
        const now = this._now;
        const subCut = now - effW;       // sub-window cutoff (full-W entries with stamp <= now - W
                                         // are already skipped by this scan, since subCut >= now - W)
        const m = this._m, cap = this._ringCap, mask = this._mask;
        const stamps = this._stamps, rhos = this._rho;
        const heads = this._head, lens = this._len;
        const q = this._q;
        const C = this._hist;
        C.fill(0);
        for (let jj = 0; jj < m; jj++) {
            const base = jj * cap;
            // F8: count() is PURE -- it NEVER expires ring entries (that now happens in add()). The
            // read-only sub-window scan skips every stamp <= subCut, and subCut >= now - W, so an
            // expired-by-W entry is skipped here anyway -> the estimate is bit-identical to the old
            // destructive path, but `overflows` / the ring state no longer depend on query cadence.
            const head = heads[jj];
            const len = lens[jj];
            // the first entry with stamp > subCut is the OLDEST in-window entry, which carries the
            // HIGHEST rho (rho decreases head -> tail).
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
            '[lite-adaptive] SlidingHyperLogLog key must be a safe integer, got ' + describeArg(key));
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
            '[lite-adaptive] SlidingHyperLogLog add now must be a finite number, got ' + describeArg(now));
    }

    /** @private Cold thrower for a non-monotone `now`. */
    _badMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] SlidingHyperLogLog add now must be non-decreasing: got ' + describeArg(now) +
            ' after ' + describeArg(this._lastNow));
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] SlidingHyperLogLog.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i + 1 < buf.length, got ' + describeArg(buf) + ', ' + describeArg(i));
    }

    /**
     * Advance the reference clock to `now` WITHOUT adding a key (the R11 idle slide). CLOCK-ONLY:
     * it moves `_now` / `_lastNow` forward and touches NOTHING else -- it must NOT expire the rings.
     * The pure `count()` self-filters by `_now` (it skips `stamp <= now - W` at read time), so a
     * bare clock bump is enough for an idle stream to slide to 0. Leaving the rings untouched keeps
     * `overflows` / `degraded` independent of advance frequency too (F8): an entry that only leaves
     * because time moved on, with no new add competing for its slot, never counted as an overflow.
     * Ring expiry is the sole job of `add` / `addFrom`. O(1), 0 B/op.
     *
     * EXPLICIT-time ONLY (parity with addFrom): a COUNT-locked instance throws; an UNSET instance
     * locks EXPLICIT (and sets the reference time). Monotone: `now` finite and >= lastNow (a
     * decrease throws). A rejected advance is a BYTE-IDENTICAL no-op.
     * @param {number} now the monotone time (finite, >= the last now).
     * @returns {SlidingHyperLogLog} this
     */
    advance(now) {
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badAdvanceMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badAdvanceNow(now);
            }
            if (now < this._lastNow) return this._badAdvanceMonotone(now);
            t = now;
            this._lastNow = now;
        } else {
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badAdvanceNow(now);
            }
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
        }
        this._now = t;   // clock-only: count() skips stamp <= now - W off this (pure read; F8).
        return this;
    }

    /**
     * Advance the reference clock from a caller-owned Float64Array (`now = buf[i]`, read UNBOXED).
     * The ZERO-BOX sibling of advance(now) -- identical mode / monotone / clock-only body,
     * EXPLICIT-time only. Fail closed BEFORE any read (typeof-first): a non-Float64Array `buf`, or
     * a non-integer / negative / out-of-range `i` (needs `i < buf.length`) throws [lite-adaptive].
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = now.
     * @param {number} i the index of the `now` scalar.
     * @returns {SlidingHyperLogLog} this
     */
    advanceFrom(buf, i) {
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i < buf.length)) return this._badAdvanceBuf(buf, i);
        const now = buf[i];   // UNBOXED Float64Array read (always a number -> no typeof branch).
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badAdvanceMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (!(now > -Infinity && now < Infinity)) return this._badAdvanceNow(now);
            if (now < this._lastNow) return this._badAdvanceMonotone(now);
            t = now;
            this._lastNow = now;
        } else {
            if (!(now > -Infinity && now < Infinity)) return this._badAdvanceNow(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
        }
        this._now = t;
        return this;
    }

    /** @private Cold thrower for an advance mode switch (advance is EXPLICIT-only). */
    _badAdvanceMode(locked, attempted) {
        throw new TypeError(
            '[lite-adaptive] SlidingHyperLogLog mode is locked to ' + locked +
            '; advance() is an ' + attempted + '-time op');
    }

    /** @private Cold thrower for a non-finite advance `now`. */
    _badAdvanceNow(now) {
        throw new TypeError(
            '[lite-adaptive] SlidingHyperLogLog advance now must be a finite number, got ' + describeArg(now));
    }

    /** @private Cold thrower for a non-monotone advance `now`. */
    _badAdvanceMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] SlidingHyperLogLog advance now must be non-decreasing: got ' + describeArg(now) +
            ' after ' + describeArg(this._lastNow));
    }

    /** @private Cold thrower for a bad advanceFrom buffer/index. */
    _badAdvanceBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] SlidingHyperLogLog.advanceFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i < buf.length, got ' + describeArg(buf) + ', ' + describeArg(i));
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
// discipline) so the detector recalibrates to the new concept and catches the NEXT shift. That is
// the DEFAULT (`latch: false`, 1.x-identical). With `latch: true` (ADR 0007 amendment, 1.8.0) a
// fire does NOT reset: the detector fires ONCE per regime, LATCHES (re-clamping the firing gap back
// to `threshold` ONLY while it is still ABOVE `threshold`, so a SUSTAINED regime stays bounded while a
// gap already <= `threshold` -- a gradual return to baseline -- is left to decay), and RE-ARMS
// only when the latched-direction gap falls back below `threshold / 2` (hysteresis) or on `clear()`.
// An OPPOSITE-direction crossing (> threshold) while STILL latched fires immediately and flips
// direction -- for CUSUM (fixed target, independent accumulators) a sharp reversal is caught on its
// own item. For PH the reference is reset AT the fire and _rearm() keeps the mean built since (so the
// reference tracks the POST-SHIFT level and the reversal delay does NOT grow with history), so a
// sustained reversal is still REPORTED with the correct direction, but not on its own item: the
// latched gap first collapses below threshold/2 and re-arms, THEN the opposite gap builds against the
// post-shift mean over a few items (measured: a +-10 step reversal fires ~3 items past the true edge,
// a +-30 step ~2). Only a single-item jump whose opposite gap alone exceeds threshold fires at once.
// `lastDriftIndex` (0-based item index of the last fire) and `lastDirection` (+1 / -1) are exposed
// in BOTH modes (NaN before any fire -- null is not zero).
//
// DDM / EDDM are deliberately OUT of this class: they consume a Bernoulli ERROR-BIT stream
// (a classifier's 0/1 correctness) and emit a TRI-STATE (stable / warning / drift) output, a
// different contract from a real-valued add(x) -> boolean. They belong in a future member.

/** The two DriftDetector modes. Numeric consts (parity with the internal mode sentinels). */
export const DRIFT_PH = 0;
export const DRIFT_CUSUM = 1;

/** Frozen marker of the known ctor option keys -- an unknown key is a throw with a did-you-mean. */
const DD_KNOWN_OPTS = Object.freeze(Object.assign(Object.create(null), { delta: true, threshold: true, target: true, latch: true }));

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

/** PH re-centre span: subtract the running min/max off gP/gN once max(|mMin|,|mMax|) > th*this, so a latched PH accumulator stays bounded on an infinite same-direction drift. ulp(th*2^20) stays << th. */
const DD_RECENTRE_SPAN = 1048576; // 2^20

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
 *   - SPACE: O(1) -- six core scalars + the latch runtime (_lDir / _lvl) + one fixed Float64Array(3);
 *     no growable pool, no per-op allocation (0 B/op) (the lightest member).
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
     *   - latch: a boolean (default false). false = the 1.x auto-reset-on-fire discipline. true =
     *     fire ONCE per regime, latch, and re-arm on the threshold/2 hysteresis or clear() (see the
     *     class header + ADR 0007 amendment). typeof-first: a non-boolean throws (no truthy coercion).
     *   An unknown key throws [lite-adaptive].
     */
    constructor(mode, options) {
        // typeof / value guard FIRST, BEFORE any field init (a bad param leaves no half-built instance).
        if (mode !== DRIFT_PH && mode !== DRIFT_CUSUM) {
            throw new RangeError(
                '[lite-adaptive] DriftDetector mode must be DRIFT_PH or DRIFT_CUSUM, got ' + describeArg(mode));
        }
        let delta = DD_DEFAULT_DELTA;
        let threshold = DD_DEFAULT_THRESHOLD;
        let target;   // undefined = no fixed reference (PH); a finite mu0 is REQUIRED for CUSUM.
        let latch = false;   // default: 1.x auto-reset-on-fire behavior (undefined -> false).
        if (options !== undefined) {
            optDoor(options, DD_KNOWN_OPTS, 'DriftDetector');
            // delta = 0 is VALID -- guard `undefined`, not falsy (null is not zero). delta is capped at
            // DD_X_MAX (like x) so the accumulators cannot be driven non-finite by a pathological delta
            // (each add moves gP/gN by ~delta; an uncapped delta near Double.MAX would overflow them in a
            // few adds and add() would silently stop firing -- a fail-open boolean). Fail closed instead.
            if (options.delta !== undefined) {
                const d = options.delta;
                if (typeof d !== 'number' || d !== d || d === Infinity || d === -Infinity ||
                    d < 0 || d > DD_X_MAX) {
                    throw new RangeError(
                        '[lite-adaptive] DriftDetector delta must be a finite number in [0, 1e150], got ' + describeArg(d));
                }
                delta = d;
            }
            if (options.threshold !== undefined) {
                const th = options.threshold;
                if (typeof th !== 'number' || th !== th || th === Infinity || th === -Infinity || th <= 0) {
                    throw new RangeError(
                        '[lite-adaptive] DriftDetector threshold must be a finite number > 0, got ' + describeArg(th));
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
                        describeArg(tg));
                }
                target = tg;
            }
            // latch is a BOOLEAN (typeof-first, no truthy coercion: a 1 / 'true' / null is a THROW,
            // never a silent yes). undefined -> false (the 1.x default). Fail closed (null is not zero).
            if (options.latch !== undefined) {
                const lt = options.latch;
                if (typeof lt !== 'boolean') {
                    throw new TypeError(
                        '[lite-adaptive] DriftDetector latch must be a boolean, got ' + describeArg(lt));
                }
                latch = lt;
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
        // A latch re-arms when the latched gap falls below threshold/2. If that half underflows to 0
        // (threshold = Number.MIN_VALUE) a floored CUSUM gap can never be < 0, so the detector would
        // stay latched forever and silently miss every later regime: fail closed at the door
        // (QA-1.8.0-DD1). NaN-safe form: `!(threshold * 0.5 > 0)`.
        if (latch && !(threshold * 0.5 > 0)) {
            throw new RangeError(
                '[lite-adaptive] DriftDetector latch needs threshold / 2 > 0 (a re-arm level); ' +
                'threshold ' + describeArg(threshold) + ' underflows -- use threshold >= 2 * Number.MIN_VALUE');
        }
        this._mode = mode;
        this._delta = delta;
        this._threshold = threshold;
        this._target = target;   // a finite mu0 for CUSUM; undefined for PH (config, never reset)
        this._latch = latch;     // config, never reset: false = auto-reset-on-fire (1.x), true = latch
        this._half = threshold * 0.5;   // the re-arm hysteresis level (latch mode), precomputed
        // The latched-PH re-centre limit, precomputed once (threshold is set here and NEVER mutated --
        // no setter, clear() does not touch it -- so this needs no recompute). Sign-aware compares in
        // the cold fire path read this slot instead of recomputing threshold * DD_RECENTRE_SPAN and
        // calling Math.abs on every latched item (the fire-heavy throughput fix, v1.10.0 4c-ii).
        this._rcLim = threshold * DD_RECENTRE_SPAN;
        // _s -- an instance Float64Array(3): [0] the lifetime accepted-add counter (0-based item
        // index base; reset only by clear()), [1] lastDriftIndex, [2] lastDirection. A typed-array
        // slot so the hot-path counter store never boxes; allocated ONCE, before _initState().
        this._s = new Float64Array(3);
        this._lvl = -Infinity;   // seed as a Double BEFORE _initState() so the trip-level field is never a Smi
        this._initState();
    }

    /** @private Reset all scalar state to empty (a full clear() -- also drops the latch + fire log). 0 alloc. */
    _initState() {
        this._n = 0;          // items seen since the last reset
        this._mean = 0;       // running mean of the signal
        this._gP = 0;         // upward accumulator (PH cumulative +dev; CUSUM floored +dev)
        this._gN = 0;         // downward accumulator (PH cumulative +dev; CUSUM floored -dev)
        this._mMin = 0;       // PH running MIN of gP
        this._mMax = 0;       // PH running MAX of gN
        this._lDir = 0;       // latched direction: 0 = armed (not latched), +1 / -1 = latched
        this._lvl = this._threshold;   // mutable trip level: threshold when armed, -Infinity when latched
        this._s[0] = 0;       // lifetime accepted-add counter (0-based item index base)
        this._s[1] = NaN;     // lastDriftIndex -- NaN before any fire (null is not zero)
        this._s[2] = NaN;     // lastDirection -- NaN before any fire
    }

    /** The detector mode (DRIFT_PH or DRIFT_CUSUM). O(1). */
    get mode() { return this._mode; }
    /** The magnitude allowance (PH) / slack (CUSUM). O(1). */
    get delta() { return this._delta; }
    /** The decision level (PH lambda / CUSUM decision interval). O(1). */
    get threshold() { return this._threshold; }
    /** The fixed CUSUM target mu0 (the reference the test deviates from); undefined for PH. O(1). */
    get target() { return this._target; }
    /** Whether latch mode is on (fire ONCE per regime + re-arm on hysteresis). O(1). */
    get latch() { return this._latch; }
    /** Whether the detector is currently latched (fired and not yet re-armed). O(1). Always false when latch is off. */
    get latched() { return this._lDir !== 0; }
    /**
     * The 0-based item index of the LAST fire (across the detector's life; reset by clear()), or NaN
     * before any fire (null is not zero). O(1). Reading this boxes the double once per call (F6).
     */
    get lastDriftIndex() { return this._s[1]; }
    /**
     * The direction of the LAST fire: +1 (upward gap won; exact tie -> +1) or -1 (downward), or NaN
     * before any fire. O(1). Reading this boxes the double once per call (F6).
     */
    get lastDirection() { return this._s[2]; }
    /**
     * The number of items seen since the last reset. O(1). With latch:false a fire resets it (the
     * accumulators + count clear on the firing item). With latch:true PH resets it AT the fire (the
     * same 1.x discipline: the running mean is the PH reference, so it must restart from the shifted
     * level), while CUSUM resets it on the RE-ARM item (CUSUM's reference is the fixed target, so it
     * keeps climbing across a sustained latched regime until re-arm).
     */
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
     * max(gP, gN). With latch:false it crosses `threshold` exactly when `add` returns true. With
     * latch:true it crosses on the ONE firing item, then while LATCHED it sits at <= threshold (the
     * gap is clamped at threshold on a sustained shift, and decays toward threshold/2 as the signal
     * returns to baseline) and `add` returns false until the regime re-arms. 0 on empty. O(1).
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
     * and returns true EXACTLY on the item that trips the threshold (drift detected). With latch:false
     * a fire resets the accumulators + running mean so the NEXT shift is caught. With latch:true a fire
     * LATCHES (fires ONCE per regime, stays latched while the shift persists); PH resets its running-mean
     * reference AT the fire (1.x discipline), while the accumulator reset that re-arms happens later, on
     * the item where the gap falls back to threshold/2.
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
        this._s[0]++;   // lifetime accepted-add counter (0-based item index = _s[0] - 1); a typed-array store, never boxes.
        // Welford running mean (O(1), no accumulated sum to overflow -- bounded by the x range). It
        // is the PH reference AND the CUSUM `mean` observability getter (CUSUM's TEST uses target).
        const mean = this._mean + (x - this._mean) / n;
        this._mean = mean;
        const delta = this._delta;
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
            // Trip compares read the mutable _lvl (armed: threshold; latched: -Infinity, so every
            // latched item routes into _fired() -- no new hot branch). latch:false keeps _lvl at
            // threshold, so this is byte-output-identical to 1.x; _fired() takes ZERO args (no box).
            if (gP - this._mMin > this._lvl || this._mMax - gN > this._lvl) return this._fired();
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
        if (gP > this._lvl || gN > this._lvl) return this._fired();
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
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i < buf.length)) return this._badBuf(buf, i);
        const x = buf[i];   // UNBOXED Float64Array read -- the whole point (no argument box).
        // validate x (a Float64Array read is always a number, so add()'s typeof branch is omitted).
        if (!(x <= DD_X_MAX && x >= -DD_X_MAX))
            return this._badValue(x);
        const n = this._n + 1;
        this._n = n;
        this._s[0]++;   // DUPLICATED from add(): lifetime accepted-add counter (a typed-array store, never boxes).
        const mean = this._mean + (x - this._mean) / n;   // DUPLICATED from add()
        this._mean = mean;
        const delta = this._delta;
        if (this._mode === DRIFT_PH) {
            const dev = x - mean;   // PH: deviation from the ONLINE running mean
            const gP = this._gP + (dev - delta);
            const gN = this._gN + (dev + delta);
            this._gP = gP;
            this._gN = gN;
            if (gP < this._mMin) this._mMin = gP;
            if (gN > this._mMax) this._mMax = gN;
            if (gP - this._mMin > this._lvl || this._mMax - gN > this._lvl) return this._fired();
            return false;
        }
        const dev = x - this._target;   // CUSUM: deviation from the FIXED target mu0
        let gP = this._gP + dev - delta;
        if (gP < 0) gP = 0;
        let gN = this._gN - dev - delta;
        if (gN < 0) gN = 0;
        this._gP = gP;
        this._gN = gN;
        if (gP > this._lvl || gN > this._lvl) return this._fired();
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
        this._lDir = 0;                // un-latch (a no-op when latch is off: _lDir is already 0)
        this._lvl = this._threshold;   // re-arm the trip level (a no-op when latch is off: already threshold)
    }

    /**
     * @private Re-arm the PH latch WITHOUT dropping the running-mean reference. Clears only the
     * accumulators + running extremes + the latch, and KEEPS _n / _mean so the online mean built
     * SINCE THE LAST FIRE survives across the re-arm. The PH reference is reset AT the fire (see
     * _fired: `if (ph) { this._n = 0; this._mean = 0; }`), so by re-arm time _n / _mean already track
     * the post-shift level -- exactly the reference a later reversal must deviate from. (F-ph-latch:
     * an earlier attempt reset the reference ONLY at re-arm and kept it across the fire; the PH
     * reference then stayed the mean-since-clear(), so a shift toward that historical mean was never
     * reported and delay grew with history -- a fail-open latch.) CUSUM's reference is the FIXED
     * target, so CUSUM re-arms via the full _reset() -- this method is PH-only. 0 alloc.
     */
    _rearm() {
        this._gP = 0;
        this._gN = 0;
        this._mMin = 0;
        this._mMax = 0;
        this._lDir = 0;                // un-latch
        this._lvl = this._threshold;   // re-arm the trip level
    }

    /**
     * @private COLD -- the fire decision, entered whenever a trip compare passes. It owns ALL latch
     * logic so the hot body carries none of it (the disclosed cost: while latched, _lvl = -Infinity
     * routes EVERY item here, so latch:true throughput is lower -- ADR 0007 amendment). Zero args so
     * no double is boxed at the call boundary. 0 alloc.
     *
     * Direction: the LARGER gap wins (PH: up = gP - mMin vs dn = mMax - gN; CUSUM: gP vs gN); an
     * EXACT tie -> +1. lastDriftIndex = _s[0] - 1 (0-based), lastDirection = the fire direction.
     *
     * latch:false -> _reset(); return true (the 1.x auto-reset discipline, unchanged).
     * latch:true:
     *   - arming -> latched: record the fire, set _lDir, _lvl = -Infinity, CLAMP the firing gap at
     *     threshold, return true (the ONE fire for this regime).
     *   - already latched: an OPPOSITE-direction gap > threshold fires immediately (flip _lDir,
     *     re-clamp, return true) -- checked FIRST so a single-item reversal whose opposite gap alone
     *     exceeds threshold is caught on its own item (CUSUM's independent accumulators hit this on a
     *     step; PH's shared running-mean reference usually re-arms first, then rebuilds the opposite
     *     gap over a few items -- still reported, just delayed a few items past the true edge);
     *     else the latched-direction gap < threshold/2 RE-ARMS (PH via _rearm(), which KEEPS the
     *     running-mean reference; CUSUM via _reset(); return false -- the re-arm moves from fire time
     *     to re-arm time); else a SUSTAINED regime returns false, re-clamping
     *     the gap ONLY when it is still ABOVE threshold. A gap already <= threshold (a gradual return
     *     toward baseline) is LEFT to decay so it can fall to threshold/2 and re-arm -- clamping it
     *     unconditionally re-inflated a shrinking gap and never re-armed (F-latch-rearm).
     * @returns {boolean}
     */
    _fired() {
        const ph = this._mode === DRIFT_PH;
        const th = this._threshold;
        const up = ph ? this._gP - this._mMin : this._gP;   // upward gap
        const dn = ph ? this._mMax - this._gN : this._gN;    // downward gap
        const dir = up >= dn ? 1 : -1;                       // larger gap wins; exact tie -> +1
        if (!this._latch) {
            this._s[1] = this._s[0] - 1;
            this._s[2] = dir;
            this._reset();
            return true;
        }
        if (this._lDir === 0) {
            // arming -> latched: the ONE fire for this regime.
            this._s[1] = this._s[0] - 1;
            this._s[2] = dir;
            this._lDir = dir;
            this._lvl = -Infinity;
            if (ph) { this._n = 0; this._mean = 0; }   // reset the PH reference AT the fire (1.x discipline)
            this._clampGap(dir);
            if (ph && (this._mMin < -this._rcLim || this._mMax > this._rcLim)) { this._gP -= this._mMin; this._mMin = 0; this._gN -= this._mMax; this._mMax = 0; }
            return true;
        }
        // Already latched. A single-item OPPOSITE gap > threshold fires on its own item (checked before
        // the re-arm test so both-conditions-at-once resolves to a fire, not a silent re-arm). A
        // sustained PH reversal instead re-arms below (KEEPING the running mean) then rebuilds here.
        const latchedGap = this._lDir === 1 ? up : dn;
        const oppositeGap = this._lDir === 1 ? dn : up;
        if (oppositeGap > th) {
            const ndir = -this._lDir;
            this._s[1] = this._s[0] - 1;
            this._s[2] = ndir;
            this._lDir = ndir;
            if (ph) { this._n = 0; this._mean = 0; }   // reset the PH reference AT the opposite fire (1.x discipline)
            this._clampGap(ndir);
            if (ph && (this._mMin < -this._rcLim || this._mMax > this._rcLim)) { this._gP -= this._mMin; this._mMin = 0; this._gN -= this._mMax; this._mMax = 0; }
            return true;
        }
        if (latchedGap < this._half) {
            // Re-arm. PH KEEPS the running-mean reference (_n / _mean survive the re-arm); because the
            // reference was already reset AT the fire (above), _n / _mean track the POST-SHIFT level, so
            // a reversal AFTER the re-arm is reported with the correct direction. CUSUM's reference is
            // the FIXED target, so it re-arms via the full _reset(). (F-ph-latch: keeping the reference
            // across the FIRE left it the mean-since-clear() and a shift toward it went unreported.)
            if (ph) this._rearm(); else this._reset();
            return false;
        }
        // SUSTAINED same-direction regime. Clamp the firing gap back to threshold ONLY when it is
        // ABOVE threshold, so the accumulators stay bounded during a sustained shift; when the gap is
        // already <= threshold (a gradual return toward baseline) it is LEFT to decay, so it can reach
        // threshold/2 and re-arm. Clamping unconditionally re-inflated a shrinking gap every item and
        // silently missed every later same-direction regime (F-latch-rearm).
        if (latchedGap > th) this._clampGap(this._lDir);
        if (ph && (this._mMin < -this._rcLim || this._mMax > this._rcLim)) { this._gP -= this._mMin; this._mMin = 0; this._gN -= this._mMax; this._mMax = 0; }
        return false;
    }

    /**
     * @private Clamp the fired-direction accumulator so the firing gap equals exactly `threshold`
     * (PH: gP = mMin + th / gN = mMax - th; CUSUM: gP = th / gN = th). Keeps latched state bounded.
     */
    _clampGap(dir) {
        const ph = this._mode === DRIFT_PH;
        const th = this._threshold;
        if (dir === 1) {
            this._gP = ph ? this._mMin + th : th;
        } else {
            this._gN = ph ? this._mMax - th : th;
        }
    }

    /** Reset all scalar state; keep the mode / delta / threshold. O(1). @returns {DriftDetector} this */
    clear() {
        this._initState();
        return this;
    }

    /** @private Cold thrower for a bad value. */
    _badValue(x) {
        throw new TypeError(
            '[lite-adaptive] DriftDetector add x must be a finite number with |x| <= 1e150, got ' + describeArg(x));
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
            'integer index (0 <= i < buf.length), got ' + describeArg(buf) + ', ' + describeArg(i));
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
// WINDOW MODEL (ADR 0008, model A -- fixed-(B+1) pane ring, F7): B+1 preallocated DDSketch PANES,
// each covering W/B of the window, held in a ring. add() writes the CURRENT pane; when `now` crosses
// a pane boundary the ring rotates to the next pane and CLEARS it (fill(0), 0-alloc). A `now` jump of
// many pane-widths expires multiple panes in a bounded while-loop capped at B+1 iterations (skipping
// >= B+1 panes clears the WHOLE ring, then re-anchors it around `now`). quantile / quantileInto /
// count MERGE the live panes (paneEnd > now - W, INCLUDING the straddling oldest pane) into an
// INSTANCE-OWNED preallocated scratch (cold, 0-alloc -- never a per-query allocation). The window is
// therefore OVER-covered by up to one pane width: the covered span is [W, W + W/B] and the straddling
// oldest pane is KEPT (never dropped), so true(W) is ALWAYS included -- forgetting is at the far edge
// [W, W + W/B], never before W. Dropping the oldest pane would under-count. Each pane collapses its lowest bins
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
const SLD_KNOWN_OPTS = Object.freeze(Object.assign(Object.create(null), { alpha: true, strict: true, panes: true, range: true }));
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
 * SLD_MIN_NORMAL -- the smallest NORMAL double (2^-1022). W / panes must land here or above: a SUBNORMAL
 * pane width loses significand bits, so the grid line (k+1)*pw no longer round-trips and (B+1)*pw can
 * fall below W and the ring under-covers (H2-1 F3). The ctor rejects a subnormal pane width fail-closed
 * BEFORE any allocation.
 */
const SLD_MIN_NORMAL = 2.2250738585072014e-308;
/**
 * SLD_CLOCK_SPAN -- the clock-precision domain (2^42). The pane grid is EXACT only while ulp(now) is far
 * below the pane width: at |now| <= pw * 2^42, ulp(now) <= pw * 2^-10, so round(E / pw) recovers the grid
 * index exactly and (k+1)*pw contains the true window. add / advance throw past this bound (count mode
 * applies the same bound to its integer tick). Precomputed once per instance as this._nowMax = pw * 2^42.
 */
const SLD_CLOCK_SPAN = 4398046511104;   // 2^42

/**
 * SlidingDDSketch -- WINDOWED relative-error QUANTILE estimation over the LAST W (a hard sliding
 * window) in FIXED space (Masson-Rim-Lee, "DDSketch", VLDB 2019, over a fixed-B pane ring). The
 * recency sibling of lite-sketch's cumulative DDSketch and the quantile complement of
 * SlidingHyperLogLog.
 *
 * Headline (the family TRIPLE):
 *   - SPACE: a FIXED ring of B+1 panes, each a dense `Uint32Array(SLD_MAX_BINS)` log-bucket store
 *     (+ per-pane offset / max-key / count bookkeeping) + one instance-owned Float64 merge scratch;
 *     never grows (panes=32 -> ~281 KB at 2048 bins).
 *   - ERROR: a HARD per-query relative bound `|q_est - q_true| <= alpha * q_true` on the merged live
 *     window, PLUS a window over-coverage of up to one pane width W/B (the straddling oldest pane is
 *     KEPT, never dropped) -- the covered span is [W, W + W/B], so true(W) is ALWAYS included.
 *   - RECENCY: a HARD last-W window (forgets in [W, W + W/B], never before W) with a sub-window query
 *     `quantile(q, w)` / `count(w)` for any `w <= W`.
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
 * value-independent; the quantile/count state is intact). F12: `quantile` / `count` NEVER throw on a
 * bad VALUE -- q outside [0, 1] / NaN, or a sub-window `w` outside (0, W] / NaN, returns NaN (null is
 * not zero -- an unrepresentable window is NaN, not an under-count of 0); an empty-window quantile is
 * NaN and count is 0. A wrong CONTAINER type is a programming error, so `quantileInto` still throws on
 * a non-Float64Array `qs`/`out`. null is not zero (strict = false and value = 0 are guarded distinctly).
 */
export class SlidingDDSketch {
    /**
     * @param {number} W        window size; a finite number > 0 (items in count mode, or the
     *                          `now`-unit span in explicit mode).
     * @param {{alpha?: number, strict?: boolean, panes?: number, range?: readonly [number, number]}} [options]
     *   alpha:  relative-error target; a number in (0, 1) (default 0.01).
     *   strict: fail closed on a collapse instead of collapsing-lowest (default false). A declared
     *           `range` DERIVES strict; `strict: false` with a `range` is a contradiction and throws.
     *   panes:  pane-ring size B; an integer in [2, 1024] (default 32). Edge error is W / panes.
     *   range:  a declared band `[rmin, rmax]` with finite `0 < rmin < rmax`, both inside the alpha
     *           indexable band and needing <= SLD_MAX_BINS bins -> STRICT mode with a FIXED bin offset
     *           (lite-sketch DDSketch parity): no first-value anchor, no slide, no collapse; a value
     *           outside the band throws.
     */
    constructor(W, options) {
        // typeof guard FIRST, BEFORE any allocation (a bad param leaves no half-built instance).
        if (typeof W !== 'number' || W !== W || W === Infinity || W === -Infinity || W <= 0) {
            throw new RangeError(
                '[lite-adaptive] SlidingDDSketch W must be a finite number > 0, got ' + describeArg(W));
        }
        let alpha = SLD_DEFAULT_ALPHA;
        let strict = false;
        let strictSet = false;   // whether strict was passed EXPLICITLY (a declared range + strict:false contradicts)
        let panes = SLD_DEFAULT_PANES;
        let range;               // a declared [rmin, rmax] band -> DERIVES strict (lite-sketch DDSketch parity)
        if (options !== undefined) {
            optDoor(options, SLD_KNOWN_OPTS, 'SlidingDDSketch');
            if (options.alpha !== undefined) {
                const a = options.alpha;
                if (typeof a !== 'number' || !(a > 0 && a < 1)) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingDDSketch alpha must be a number in (0, 1), got ' + describeArg(a));
                }
                alpha = a;
            }
            // strict = false is the default; guard `undefined`, and require a real boolean (null is not false).
            if (options.strict !== undefined) {
                const st = options.strict;
                if (typeof st !== 'boolean') {
                    throw new TypeError(
                        '[lite-adaptive] SlidingDDSketch strict must be a boolean, got ' + describeArg(st));
                }
                strict = st;
                strictSet = true;
            }
            if (options.range !== undefined) range = options.range;
            if (options.panes !== undefined) {
                const p = options.panes;
                if (typeof p !== 'number' || (p | 0) !== p || p < SLD_PANES_MIN || p > SLD_PANES_MAX) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingDDSketch panes must be an integer in [' + SLD_PANES_MIN +
                        ', ' + SLD_PANES_MAX + '], got ' + describeArg(p));
                }
                panes = p;
            }
        }

        // A declared `range` DERIVES strict (lite-sketch DDSketch parity); `strict: false` with a
        // declared range is a contradiction -- fail closed BEFORE any allocation.
        if (range !== undefined && strictSet && strict === false) {
            throw new RangeError(
                '[lite-adaptive] SlidingDDSketch range implies strict; strict:false contradicts a declared range');
        }
        strict = strict === true || range !== undefined;

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

        // A declared `range` fixes the strict band to [rmin, rmax] (lite-sketch DDSketch parity): the
        // bin offset is anchored at `_rangeKeyLo = ceil(ln(rmin) * mult)`, nb = keyHi - keyLo + 1 bins,
        // never anchored to a first value, never collapsed. Validate typeof-first, BEFORE any allocation.
        let rangeMin = NaN, rangeMax = NaN, rangeKeyLo = 0, rangeKeyHi = 0;
        // ACCEPTED key band for the hot two-comparison gate = the indexable band, tightened to the
        // declared range when present (an out-of-range value is then rejected by the SAME gate).
        let acceptLo = minKey, acceptHi = maxKey;
        if (range !== undefined) {
            if (!Array.isArray(range) || range.length !== 2) this._badRange(range);
            const rmin = range[0], rmax = range[1];
            if (typeof rmin !== 'number' || typeof rmax !== 'number' ||
                rmin !== rmin || rmax !== rmax ||
                rmin === Infinity || rmin === -Infinity || rmax === Infinity || rmax === -Infinity ||
                !(rmin > 0) || !(rmin < rmax)) {
                this._badRange(range);
            }
            const keyLo = Math.ceil(Math.log(rmin) * multiplier);   // offset = minKey (lite-sketch parity)
            const keyHi = Math.ceil(Math.log(rmax) * multiplier);
            // Both ends must lie inside the alpha indexable band (else the representative over/underflows).
            if (keyLo < minKey || keyHi > maxKey) this._badRange(range);
            const nb = keyHi - keyLo + 1;
            if (nb > SLD_MAX_BINS) {
                throw new RangeError(
                    '[lite-adaptive] SlidingDDSketch range [' + rmin + ', ' + rmax + '] needs ' + nb +
                    ' bins, exceeds SLD_MAX_BINS=' + SLD_MAX_BINS + ' (the widest representable rmax/rmin at ' +
                    'alpha=' + alpha + ' is ' + Math.pow(gamma, SLD_MAX_BINS - 1) + ')');
            }
            rangeMin = rmin; rangeMax = rmax; rangeKeyLo = keyLo; rangeKeyHi = keyHi;
            acceptLo = keyLo; acceptHi = keyHi;
        }

        // Fail closed BEFORE alloc: a SUBNORMAL W underflows W/panes to 0 (or a non-finite value), which
        // would make the pane-boundary arithmetic non-finite -> no pane ever live -> add() never throws yet
        // quantile()/count() silently read empty for a just-added value. Guard the derived pane width.
        const paneW = W / panes;          // per-pane time width (the disclosed edge error)
        if (!(paneW > 0) || !Number.isFinite(paneW)) {
            throw new RangeError(
                '[lite-adaptive] SlidingDDSketch W is too small for panes=' + panes +
                ' (W / panes underflowed to ' + paneW + '); use a larger W or fewer panes');
        }
        // The pane width must be a NORMAL double: a subnormal pw loses significand bits, so the grid line
        // (k+1)*pw no longer round-trips and (B+1)*pw can fall below W -> under-cover (H2-1 F3). Fail closed
        // BEFORE alloc (the `!(>=)` form also rejects a NaN paneW, though the step above caught it).
        if (!(paneW >= SLD_MIN_NORMAL)) {
            throw new RangeError(
                '[lite-adaptive] SlidingDDSketch W / panes (' + paneW + ') is subnormal; the pane grid ' +
                'cannot hold W exactly -- use a larger W or fewer panes');
        }

        // F7: the ring holds B+1 panes so the covered span is [W, W + W/B] -- the straddling oldest
        // pane is INCLUDED (kept, never dropped) and the true window is ALWAYS fully covered. `_panes`
        // stays the user knob B (the getter + edge-error W/B); every per-pane column is allocated at
        // `ring` (one extra pane -- disclosed in `bytes`).
        const ring = panes + 1;

        this._W = W;
        this._alpha = alpha;
        this._strict = strict;
        this._panes = panes;         // B (getter returns this; edge error is W / B); the ring holds B+1 panes
        this._ring = ring;           // B + 1
        this._maxBins = SLD_MAX_BINS;
        this._paneW = paneW;              // per-pane time width (the disclosed edge error); guarded normal above
        this._nowMax = paneW * SLD_CLOCK_SPAN;   // |now| clock-precision bound (pw * 2^42); one field compare on the hot path
        this._gamma = gamma;
        this._multiplier = multiplier;
        // Hot key gate reads the ACCEPTED band (indexable, tightened to any declared range).
        this._maxKey = acceptHi;
        this._minKey = acceptLo;
        // minIndexable / maxIndexable are ALPHA-ONLY (identical strict / non-strict / range) -- keyed off
        // the INDEXABLE band, NOT the accepted band, so the getters mean the same thing in every mode.
        this._minIndexable = Math.pow(gamma, minKey - 1);  // EXCLUSIVE floor: add accepts x > this
        this._maxIndexable = Math.pow(gamma, maxKey);      // INCLUSIVE ceiling: add accepts x <= this
        this._rangeMin = rangeMin;      // declared strict band (NaN when undeclared)
        this._rangeMax = rangeMax;
        this._rangeKeyLo = rangeKeyLo;  // fixed bin offset for a declared range (0 when undeclared)
        this._rangeKeyHi = rangeKeyHi;

        const cells = ring * SLD_MAX_BINS;
        // per-pane dense log-bucket store (pane p occupies cells [p*maxBins, p*maxBins+maxBins)):
        this._bins = new Uint32Array(cells);         // bin counts (saturate at 0xFFFFFFFF)
        this._offset = new Int32Array(ring);         // per-pane key at physical bin 0
        this._maxKeyPop = new Int32Array(ring);      // per-pane highest populated key
        this._binCount = new Int32Array(ring);       // per-pane anchored flag (0 = fresh)
        this._paneCollapsed = new Uint8Array(ring);  // per-pane collapse flag (low-end precision lost)
        this._paneCount = new Float64Array(ring);    // per-pane total adds (incl. zeros), exact to 2^53
        this._paneZero = new Float64Array(ring);     // per-pane zero adds
        this._paneEnd = new Float64Array(ring);      // per-pane EXCLUSIVE upper time bound
        // instance-owned merge scratch (Float64 so B near-saturated panes sum exactly):
        this._scratch = new Float64Array(SLD_MAX_BINS);
        // F5: the merge cutoff lives in a preallocated slot; callers write `_cut[0] = now - effW` and
        // `_merge()` reads `_cut[0]` -- no computed double passed as an argument (0-box query path).
        this._cut = new Float64Array(1);

        this._bytes = this._bins.byteLength + this._offset.byteLength + this._maxKeyPop.byteLength +
            this._binCount.byteLength + this._paneCollapsed.byteLength +
            this._paneCount.byteLength + this._paneZero.byteLength + this._paneEnd.byteLength +
            this._scratch.byteLength + this._cut.byteLength;

        this._initState();
    }

    /** @private Reset all pane state + time mode + scratch. Reused by clear(). 0 alloc. */
    _initState() {
        this._bins.fill(0);
        // Declared range: PRE-ANCHOR every pane's offset at the fixed _rangeKeyLo (0 when undeclared, so
        // byte-identical to the old fill(0)), so _addKeyPane's first-value TOP anchor is never taken and no
        // in-range value can slide or collapse. The fill covers all panes (keyed off length -> F7 B+1 safe).
        this._offset.fill(this._rangeKeyLo);
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
    /** The declared strict range floor rmin (NaN when no range was declared). O(1). null is not zero. */
    get rangeMin() { return this._rangeMin; }
    /** The declared strict range ceiling rmax (NaN when no range was declared). O(1). null is not zero. */
    get rangeMax() { return this._rangeMax; }
    /** Whether any live pane has folded nonzero mass into its collapsed floor. COLD, O(panes). */
    get collapsed() {
        const c = this._paneCollapsed, B = this._ring;
        for (let p = 0; p < B; p++) if (c[p] !== 0) return true;
        return false;
    }
    /** A fixed memory figure in bytes (all B+1 pane columns + the merge scratch + the cut slot). O(1). */
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
            t = this._tick + 1;
            if (!(t <= this._nowMax)) return this._badNowRange(t);   // tick past pw * 2^42 -> fail closed
            this._tick = t;
        } else if (mode === MODE_EXPLICIT) {
            if (now === undefined) return this._badMode('explicit', 'count');
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badNow(now);
            }
            if (now < this._lastNow) return this._badMonotone(now);
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            t = now;
            this._lastNow = now;
        } else {
            if (now === undefined) {
                t = this._tick + 1;
                if (!(t <= this._nowMax)) return this._badNowRange(t);
                this._mode = MODE_COUNT;
                this._tick = t;
                this._now = t;
                this._anchor();
            } else {
                if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                    return this._badNow(now);
                }
                const nm = this._nowMax;
                if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
                this._mode = MODE_EXPLICIT;
                t = now;
                this._lastNow = now;
                this._now = t;
                this._anchor();
            }
        }
        this._now = t;
        // 4. rotate + clear panes if this t crossed the current pane boundary (bounded, 0-alloc).
        if (t >= this._paneEnd[this._cur]) this._advance();
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
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i + 1 < buf.length)) return this._badBuf(buf, i);
        const now = buf[i];         // UNBOXED Float64Array reads -- the whole point (no argument box).
        const value = buf[i + 1];   // packed [now, value]
        // 1. validate the VALUE first (a Float64Array read is always a number, so no typeof branch).
        if (!(value > -Infinity && value < Infinity)) return this._badValue(value);
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
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            t = now;
            this._lastNow = now;
        } else {
            if (now !== now || now === Infinity || now === -Infinity) return this._badNow(now);
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
            this._now = t;
            this._anchor();
        }
        this._now = t;
        // 4. rotate + clear panes if this t crossed the current pane boundary (bounded, 0-alloc).
        if (t >= this._paneEnd[this._cur]) this._advance();
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
     * width each. Argument-free (reads this._now, the zero-box law). Cold (once per lifecycle /
     * clear). 0 alloc.
     */
    _anchor() {
        const B = this._ring, pw = this._paneW, now = this._now;
        const E = (Math.floor(now / pw) + 1) * pw;   // EXCLUSIVE upper bound of the current pane
        this._cur = 0;
        this._paneEnd[0] = E;
        let e = E, idx = 0;
        for (let s = 1; s < B; s++) { idx--; if (idx < 0) idx = B - 1; e -= pw; this._paneEnd[idx] = e; }
    }

    /**
     * @private Rotate the ring forward so the current pane covers this._now, clearing each pane it
     * rotates onto. Capped at B+1 rotations (rotating >= B+1 panes clears the WHOLE ring, then
     * re-anchors it around this._now). Argument-free (reads this._now, the zero-box law). 0 alloc.
     * Called only when this._now crossed the current boundary.
     */
    _advance() {
        const pw = this._paneW, B = this._ring, t = this._now;
        let cur = this._cur;
        // Grid index of the current pane end (E = k*pw exactly for an integer k in the legal clock
        // domain, |now| <= pw * 2^42, where ulp(E) <= pw * 2^-10 so the division round-trips). Each new
        // pane end is (k+1)*pw by MULTIPLICATION -- drift-free and bit-identical to the anchor / oracle's
        // (floor(t/pw)+1)*pw -- rather than an accumulating `E += pw`, whose per-step rounding drifts by
        // up to ~pw near the domain edge and can drop a live pane (H2-1 F2, fail-open).
        let k = Math.round(this._paneEnd[cur] / pw);
        let E = this._paneEnd[cur];
        let rot = 0;
        while (t >= E && rot < B) {
            cur++; if (cur === B) cur = 0;
            this._clearPane(cur);
            k += 1;
            E = k * pw;
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
        this._offset[p] = this._rangeKeyLo;   // pre-anchor (0 when undeclared -> byte-identical to before)
        this._maxKeyPop[p] = 0;
        this._binCount[p] = 0;
        this._paneCollapsed[p] = 0;
        this._paneCount[p] = 0;
        this._paneZero[p] = 0;
    }

    /**
     * @private The cold window math for one pane (out-of-window key). Three regimes, gated so the
     * NON-STRICT path stays BYTE-IDENTICAL to 1.6.0 (top anchor + collapsing-lowest fold):
     *   - DECLARED RANGE (`_rangeMin` finite): the offset is pre-anchored at `_rangeKeyLo` (in
     *     `_initState` / `_clearPane`) and the hot key gate guarantees k in [_rangeKeyLo, _rangeKeyHi],
     *     so the key drops straight into its FIXED cell -- no anchor, no slide, no collapse EVER.
     *   - STRICT WITHOUT a range (span-based): NEVER collapses. The occupied key span plus the new key
     *     must fit maxBins; if it would exceed, fail closed; otherwise RE-ANCHOR the window losslessly by
     *     shifting the occupied bins (up for a below-floor key, down for an above-ceiling key). The high
     *     end is `_maxKeyPop`; the low end is derived LAZILY here by scanning for the first nonzero bin
     *     (cold, O(maxBins) -- the re-anchor already does an O(maxBins) copyWithin). A bottom anchor would
     *     only move the bug to falling values.
     *   - NON-STRICT (default): anchor the first key at the TOP (fill downward), fold a below-floor key
     *     into bin 0, or slide the window up folding the vacated low cells (collapsing-lowest).
     * Uint32 bin counts saturate at 0xFFFFFFFF (never wrap); the per-pane count is gated on the same
     * non-saturation check so the tracked total never exceeds the histogram mass. 0 alloc.
     * @param {number} pane pane index
     * @param {number} k    bucket key
     * @returns {SlidingDDSketch} this
     */
    _addKeyPane(pane, k) {
        const maxBins = this._maxBins;
        const bins = this._bins;
        const base = pane * maxBins;
        // DECLARED RANGE: fixed offset (_rangeKeyLo), k pre-validated in [_rangeKeyLo, _rangeKeyHi] by the
        // hot gate -> idx in [0, nb - 1] always; never anchors / slides / collapses. (_rangeMin is NaN
        // when undeclared, so `_rangeMin === _rangeMin` is FALSE and this whole branch is skipped.)
        if (this._rangeMin === this._rangeMin) {
            const idx = k - this._offset[pane];   // _offset[pane] == _rangeKeyLo
            const c = bins[base + idx];
            if (c !== 4294967295) { bins[base + idx] = c + 1; this._paneCount[pane] += 1; }
            if (this._binCount[pane] === 0) this._binCount[pane] = 1;
            if (k > this._maxKeyPop[pane]) this._maxKeyPop[pane] = k;
            return this;
        }
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
        // STRICT WITHOUT a range: SPAN-BASED, never collapses -- either the extended span fits (lossless
        // re-anchor) or it fails closed. Gated here so the non-strict fold below stays byte-identical.
        if (this._strict) {
            const maxPop = this._maxKeyPop[pane];
            if (idx < 0) {                      // key BELOW the floor: new span [k, maxPop], shift bins UP
                if (maxPop - k + 1 > maxBins) return this._badStrict(k);
                const delta = off - k;          // > 0; new offset = k anchors the new key at bin 0
                bins.copyWithin(base + delta, base, base + maxBins - delta);
                bins.fill(0, base, base + delta);
                bins[base] += 1;                // the new key sits at the bottom (fresh after the shift)
                this._offset[pane] = k;
            } else {                            // idx >= maxBins: key ABOVE the ceiling, shift bins DOWN
                // Derive the low end of the occupied span LAZILY: the first nonzero cell's key
                // (off + firstNonzeroIndex). binCount != 0 here, so strict panes always hold >= 1 cell.
                let lo = 0;
                while (lo < maxBins && bins[base + lo] === 0) lo++;
                const minPop = off + lo;
                if (k - minPop + 1 > maxBins) return this._badStrict(k);
                const newOff = k - (maxBins - 1);
                const delta = newOff - off;     // > 0
                bins.copyWithin(base, base + delta, base + maxBins);
                bins.fill(0, base + maxBins - delta, base + maxBins);
                bins[base + (maxBins - 1)] += 1;   // the new key sits at the top (fresh after the shift)
                this._offset[pane] = newOff;
                this._maxKeyPop[pane] = k;
            }
            this._paneCount[pane] += 1;
            return this;
        }
        if (idx < 0) {                          // below the floor: collapsing-lowest fold
            const c = bins[base];
            if (c !== 4294967295) {             // saturate; gate the count so the total never exceeds the mass
                bins[base] = c + 1;
                this._paneCount[pane] += 1;
            }
            this._paneCollapsed[pane] = 1;
            return this;
        }
        // idx > maxBins - 1: the value sits ABOVE the window ceiling -> a slide-up that collapses the low end.
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
     * merged zero count + total. COLD, O(ring * maxBins), 0 alloc. F5: reads the cutoff from the
     * preallocated `_cut[0]` slot (callers write it) -- no computed double passed as an argument.
     */
    _merge() {
        const cut = this._cut[0];
        const s = this._scratch;
        s.fill(0);
        this._sBinCount = 0;
        this._sOffset = 0;
        this._sMaxKeyPop = 0;
        let zeros = 0, total = 0;
        const B = this._ring, maxBins = this._maxBins, bins = this._bins;
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

    /**
     * @private Walk the merged scratch for quantile q in [0, 1]; NaN for a bad q or an empty merge.
     * Used ONLY by quantile()'s single boxed return (~16 B HeapNumber). The batch render path uses
     * `_walkInto` (writes a Float64Array cell, no boxed return).
     */
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
     * @private F5: walk the merged scratch for qs[j] and WRITE out[j] (returns void -- no boxed
     * return, so the batch render stays 0-alloc). NaN for a bad q or an empty merge. `qs` is a
     * Float64Array so `qs[j]` is always a number (no typeof branch; a NaN q still writes NaN).
     */
    _walkInto(qs, out, j) {
        const q = qs[j];
        if (q !== q || q < 0 || q > 1) { out[j] = NaN; return; }
        const N = this._mTotal;
        if (N === 0) { out[j] = NaN; return; }
        const rank = Math.floor(q * (N - 1));   // 0-indexed target rank
        let cum = this._mZeros;
        if (rank < cum) { out[j] = 0; return; } // the target falls in the zero bucket
        const s = this._scratch, off = this._sOffset, gamma = this._gamma;
        const top = this._sBinCount === 0 ? -1 : this._sMaxKeyPop - off;
        for (let i = 0; i <= top; i++) {
            cum += s[i];
            if (cum > rank) { out[j] = 2 * Math.pow(gamma, i + off) / (gamma + 1); return; }
        }
        out[j] = top >= 0 ? 2 * Math.pow(gamma, this._sMaxKeyPop) / (gamma + 1) : NaN;
    }

    /**
     * Estimate the value at quantile q over the last W (or a sub-window `w <= W`). COLD, 0 alloc
     * (merges the live panes into the instance scratch, never per-query; one ~16 B HeapNumber for the
     * boxed return). NEVER throws (F12): a bad VALUE -- q outside [0, 1] or NaN, or a sub-window `w`
     * outside (0, W] -- returns NaN (null is not zero). An empty window also returns NaN. A wrong
     * argument TYPE is not validated here (q / w are read as numbers); `quantileInto` still throws on a
     * non-Float64Array container (a container is a programming error, a bad number is a data value).
     * @param {number} q a number in [0, 1].
     * @param {number} [w] an optional sub-window in (0, W] (omit for the full window W).
     * @returns {number}
     */
    quantile(q, w) {
        if (typeof q !== 'number' || q !== q || q < 0 || q > 1) return NaN;   // F12: bad VALUE -> NaN
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) {
                return NaN;   // F12: a bad sub-window -> NaN (same contract as count)
            }
            effW = w;
        }
        if (this._mode === MODE_UNSET) return NaN;
        this._cut[0] = this._now - effW;   // F5: write the cutoff slot, no computed double argument
        this._merge();
        return this._walk(q);
    }

    /**
     * Render several quantiles at once into a caller-owned Float64Array, merging the live panes ONCE
     * (0-alloc render path -- no boxed return per q, F5 `_walkInto` writes each cell directly). Each
     * `qs[j]` in [0, 1] is written to `out[j]` (NaN for a q outside [0, 1] / NaN, or an empty window).
     * COLD. Returns the number of quantiles written (= qs.length). Argument-TYPE validation still
     * throws: a non-Float64Array `qs`/`out` (or `out` too short) is a PROGRAMMING error (a wrong
     * container), distinct from a bad VALUE inside `qs` (which is data -> NaN, never a throw).
     * @param {Float64Array} qs the quantiles to render (each in [0, 1]).
     * @param {Float64Array} out the receiving buffer (length must be >= qs.length).
     * @returns {number} the count of quantiles written.
     */
    quantileInto(qs, out) {
        if (!(ArrayBuffer.isView(qs) && qs instanceof Float64Array) || !(ArrayBuffer.isView(out) && out instanceof Float64Array)) {
            return this._badInto(qs, out);   // argument-TYPE guard (a wrong container is a programming error)
        }
        const n = TA_LEN.call(qs);           // H34: intrinsic length, read ONCE (a subclass getter runs no user code)
        if (!(TA_LEN.call(out) >= n)) {
            return this._badInto(qs, out);   // argument-TYPE guard (a wrong container is a programming error)
        }
        if (this._mode === MODE_UNSET) {
            for (let j = 0; j < n; j++) out[j] = NaN;
            return n;
        }
        this._cut[0] = this._now - this._W;   // F5: write the cutoff slot, no computed double argument
        this._merge();
        for (let j = 0; j < n; j++) this._walkInto(qs, out, j);   // F5: void write, no boxed return
        return n;
    }

    /**
     * The number of values in the last W (or a sub-window `w <= W`), including zeros. COLD, O(ring),
     * 0 alloc. Covers the LIVE panes (paneEnd > now - W, INCLUDING the straddling oldest pane), so the
     * covered span is [W, W + W/B]. NEVER throws (F12): a bad sub-window `w` outside (0, W] / NaN
     * returns NaN (null is not zero -- an unrepresentable window is NaN, not an under-count of 0). An
     * empty window returns 0.
     * @param {number} [w] an optional sub-window in (0, W] (omit for the full window W).
     * @returns {number}
     */
    count(w) {
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) {
                return NaN;   // F12: a bad sub-window -> NaN (null is not zero; same contract as quantile)
            }
            effW = w;
        }
        if (this._mode === MODE_UNSET) return 0;
        const cut = this._now - effW;
        const B = this._ring;
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
            '[lite-adaptive] SlidingDDSketch value must be a finite number >= 0, got ' + describeArg(value));
    }

    /**
     * @private Cold thrower for a value the hot key gate rejected. With a declared range the gate is the
     * range band, so name it; otherwise it is the alpha indexable band (representative would over/underflow).
     */
    _badIndexable(value) {
        if (this._rangeMin === this._rangeMin) {   // a range was declared (NaN when not)
            throw new RangeError(
                '[lite-adaptive] SlidingDDSketch value ' + describeArg(value) +
                ' is outside the declared strict range [' + this._rangeMin + ', ' + this._rangeMax + ']');
        }
        throw new RangeError(
            '[lite-adaptive] SlidingDDSketch value ' + describeArg(value) + ' is outside the sketch\'s indexable range');
    }

    /** @private Cold thrower for a malformed `range` option (before any allocation). */
    _badRange(range) {
        throw new RangeError(
            '[lite-adaptive] SlidingDDSketch range must be [rmin, rmax] with finite 0 < rmin < rmax, both ' +
            'inside the alpha indexable band, got ' + describeArg(range));
    }

    /** @private Cold thrower for a strict-mode collapse rejection (below the floor OR above the ceiling). */
    _badStrict(k) {
        throw new RangeError(
            '[lite-adaptive] SlidingDDSketch strict mode: value (bucket key ' + describeArg(k) +
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
            '[lite-adaptive] SlidingDDSketch add now must be a finite number, got ' + describeArg(now));
    }

    /** @private Cold thrower for a non-monotone `now`. */
    _badMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] SlidingDDSketch add now must be non-decreasing: got ' + describeArg(now) +
            ' after ' + describeArg(this._lastNow));
    }

    /** @private Cold thrower for a bad quantileInto(qs, out). */
    _badInto(qs, out) {
        throw new TypeError(
            '[lite-adaptive] SlidingDDSketch.quantileInto(qs, out) needs two Float64Arrays with ' +
            'out.length >= qs.length, got ' + describeArg(qs) + ', ' + describeArg(out));
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] SlidingDDSketch.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i + 1 < buf.length, got ' + describeArg(buf) + ', ' + describeArg(i));
    }

    /**
     * Advance the window's reference time to `now` WITHOUT binning a value (the R11 idle slide).
     * It moves `_now` forward and runs the SAME pane rotate-and-clear `add(now)` would (the
     * private `_advance` -- distinct from this PUBLIC `advance`), so an idle stream still rotates
     * stale panes out and `count()` / `quantile()` keep sliding to empty (NaN) with no traffic.
     * Bounded (<= panes clears), 0 B/op.
     *
     * EXPLICIT-time ONLY (parity with addFrom): a COUNT-locked instance throws; an UNSET instance
     * locks EXPLICIT (and anchors the pane ring around `now`). Monotone: `now` finite and >=
     * lastNow (a decrease throws). A rejected advance is a BYTE-IDENTICAL no-op.
     * @param {number} now the monotone time (finite, >= the last now).
     * @returns {SlidingDDSketch} this
     */
    advance(now) {
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badAdvanceMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badAdvanceNow(now);
            }
            if (now < this._lastNow) return this._badAdvanceMonotone(now);
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            t = now;
            this._lastNow = now;
        } else {
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badAdvanceNow(now);
            }
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
            this._now = t;
            this._anchor();
        }
        this._now = t;
        if (t >= this._paneEnd[this._cur]) this._advance();   // rotate + clear stale panes (bounded).
        return this;
    }

    /**
     * Advance the window's reference time from a caller-owned Float64Array (`now = buf[i]`, read
     * UNBOXED). The ZERO-BOX sibling of advance(now) -- identical mode / monotone / rotate body,
     * EXPLICIT-time only. Fail closed BEFORE any read (typeof-first): a non-Float64Array `buf`, or
     * a non-integer / negative / out-of-range `i` (needs `i < buf.length`) throws [lite-adaptive].
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = now.
     * @param {number} i the index of the `now` scalar.
     * @returns {SlidingDDSketch} this
     */
    advanceFrom(buf, i) {
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i < buf.length)) return this._badAdvanceBuf(buf, i);
        const now = buf[i];   // UNBOXED Float64Array read (always a number -> no typeof branch).
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badAdvanceMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (now !== now || now === Infinity || now === -Infinity) return this._badAdvanceNow(now);
            if (now < this._lastNow) return this._badAdvanceMonotone(now);
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            t = now;
            this._lastNow = now;
        } else {
            if (now !== now || now === Infinity || now === -Infinity) return this._badAdvanceNow(now);
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
            this._now = t;
            this._anchor();
        }
        this._now = t;
        if (t >= this._paneEnd[this._cur]) this._advance();
        return this;
    }

    /**
     * @private Cold thrower for a `now` (or count-mode tick) outside the clock-precision domain
     * |now| <= pw * 2^42. Past it ulp(now) is no longer far below the pane width, so round(E / pw) can
     * miss the grid index and (k+1)*pw drifts off the true window -- the covered span would silently
     * under-count / mis-answer (H2-1 F1/F2). Fail closed BEFORE any state write.
     */
    _badNowRange(now) {
        throw new RangeError(
            '[lite-adaptive] SlidingDDSketch now (' + describeArg(now) + ') is too large for the pane width (' +
            this._paneW + '); |now| must be <= pw * 2^42 (' + this._nowMax +
            ')' + (this._mode === MODE_COUNT ? ', including the count-mode tick,' : '') +
            ' -- rebase the clock (e.g. performance.now()) or use a larger W');
    }

    /** @private Cold thrower for an advance mode switch (advance is EXPLICIT-only). */
    _badAdvanceMode(locked, attempted) {
        throw new TypeError(
            '[lite-adaptive] SlidingDDSketch mode is locked to ' + locked +
            '; advance() is an ' + attempted + '-time op');
    }

    /** @private Cold thrower for a non-finite advance `now`. */
    _badAdvanceNow(now) {
        throw new TypeError(
            '[lite-adaptive] SlidingDDSketch advance now must be a finite number, got ' + describeArg(now));
    }

    /** @private Cold thrower for a non-monotone advance `now`. */
    _badAdvanceMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] SlidingDDSketch advance now must be non-decreasing: got ' + describeArg(now) +
            ' after ' + describeArg(this._lastNow));
    }

    /** @private Cold thrower for a bad advanceFrom buffer/index. */
    _badAdvanceBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] SlidingDDSketch.advanceFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i < buf.length, got ' + describeArg(buf) + ', ' + describeArg(i));
    }
}

// ===========================================================================
// SlidingCountMin (ADR 0010) -- windowed per-label frequency over the LAST W
// (Cormode-Muthukrishnan, "Count-Min Sketch", 2005, on a fixed-(B+1) pane ring)
// ===========================================================================
//
// SlidingCountMin answers "how many times did KEY occur in the LAST W" in FIXED preallocated space
// with the SAME one-sided over-estimate guarantee as lite-sketch's cumulative CountMinSketch
// (est >= true, est - true <= epsilon*N w.p. >= 1 - delta), on the RECENCY axis. It is the frequency
// sibling of SlidingHyperLogLog (windowed distinct-count) and SlidingDDSketch (windowed quantiles) --
// all keep a hard last-W window over a caller-supplied MONOTONE `now`, never the wall clock.
//
// WINDOW MODEL (ADR 0010): B+1 panes, each a full d x w CountMin counter matrix covering W/B of the
// window. add() writes the CURRENT pane; when `now` crosses a pane boundary the ring rotates to the
// next pane and CLEARS it (fill(0), 0-alloc). The query covers the LIVE panes (paneEnd > now - W),
// so the covered span is [W, W+W/B] -- ALWAYS covers the full W with at most one extra (straddling)
// pane. The partially-expired oldest pane is KEPT, NEVER dropped, so the estimate is a ONE-SIDED
// UPPER bound: true(W) <= est <= true(W+W/B) + epsilon*N(W+W/B). Dropping the oldest pane would
// under-count and silently break the lower side of that contract.
//
// COUNTMIN MAPPING (inlined, NOT a dependency -- a consumer pre-checks / swaps in lite-sketch CMS
// identically; any divergence would be a breaking surprise): the two-lane 64-bit murmur3 (hi, lo)
// over the key's low + high words + sign, base = (hi ^ lo) | 0, and each of the d rows derives its
// column from ONE base lane via `mix(base ^ i*ODD_CONST) & (w-1)` (w a power of two) -- byte-identical
// to lite-sketch CountMinSketch (ADR 0003 there); seed default shared, seed=0 valid (guarded via
// `=== undefined`, null is not zero). QUERY estimate(key, w?): for each row SUM the key's cell across
// the live panes, THEN MIN over rows (sum-then-min, NOT min-then-sum -- a windowed CMS must sum a row
// across time before taking the row-min, else the min is over unrelated per-pane cells). Counters are
// per-pane `Uint32Array`, SATURATING at 2^32-1 (never wrap); conservative update (default) runs PER
// PANE (min over the current pane's d cells), NOT over window sums. estimate returns a DOUBLE (a window
// sum can exceed 2^32) and NEVER throws (0 for an unseen / out-of-domain key or an empty window) --
// parity with lite-sketch CMS.

/** Frozen marker of the known SlidingCountMin option keys -- an unknown key throws with a hint. */
const SCM_KNOWN_OPTS = Object.freeze(Object.assign(Object.create(null), {
    epsilon: true, delta: true, w: true, d: true, panes: true, seed: true, conservative: true }));
/** Default pane count B (edge error W/32); the ring holds B+1 panes. */
const SCM_DEFAULT_PANES = 32;
/** Fewest panes: at least 2 so the window is meaningfully sub-divided. */
const SCM_PANES_MIN = 2;
/** Most panes: bounds the preallocated store ((panes+1) * d * w Uint32 cells). */
const SCM_PANES_MAX = 1024;
/** Highest legal depth d (hash rows) -- matches lite-sketch CountMinSketch's CMS_D_MAX. */
const SCM_D_MAX = 32;
/**
 * SCM_W_MAX -- highest legal WIDTH w (cells/row) BEFORE the power-of-two round-up. A TIGHTER cap than
 * lite-sketch CountMinSketch's 1<<25: the windowed store is (panes+1) FULL matrices, so per-instance
 * memory is (B+1)x a single CMS -- 1<<16 keeps the max store bounded. The WINDOW span W is NOT capped
 * (parity with SlidingDDSketch / SlidingHyperLogLog -- a finite number > 0); the cell array
 * (panes+1)*d*w is INDEPENDENT of W, so W needs no small cap (ADR 0010).
 */
const SCM_W_MAX = 1 << 16;
/** Counter saturation: a Uint32Array cell tops out here (saturating add, never wraps). */
const SCM_SAT = 4294967295;
/** Hard ceiling on the flat cell count so every index (panes+1)*d*w stays a SMI (else it boxes / deopts). */
const SCM_CELLS_CAP = 2 ** 31;
/** Default per-instance seed (shared with HeavyKeeper / SlidingHyperLogLog so all hash identically). */
const SCM_DEFAULT_SEED = 0x9e3779b1;
/** Default relative error target (derives the default width w = ceil(e/epsilon) rounded to a power of two). */
const SCM_DEFAULT_EPSILON = 0.01;
/** Default failure probability (derives the default depth d = ceil(ln(1/delta))). */
const SCM_DEFAULT_DELTA = 0.01;
/**
 * SCM_MIN_NORMAL -- the smallest NORMAL double (2^-1022). W / panes must land here or above: a SUBNORMAL
 * pane width loses significand bits, so (B+1)*pw can fall below W and the ring under-covers (H2-1 F3).
 * The ctor rejects a subnormal pane width fail-closed BEFORE any allocation.
 */
const SCM_MIN_NORMAL = 2.2250738585072014e-308;
/**
 * SCM_CLOCK_SPAN -- the clock-precision domain (2^42). The pane grid is EXACT only while ulp(now) is far
 * below the pane width: at |now| <= pw * 2^42, ulp(now) <= pw * 2^-10, so round(E / pw) recovers the grid
 * index exactly and (k+1)*pw contains the true window. add / advance throw past this bound (count mode
 * applies the same bound to its integer tick). Precomputed once per instance as this._nowMax = pw * 2^42.
 */
const SCM_CLOCK_SPAN = 4398046511104;   // 2^42

/**
 * SlidingCountMin -- WINDOWED per-label FREQUENCY estimation over the LAST W (a hard sliding window)
 * in FIXED space (Cormode-Muthukrishnan, "Count-Min Sketch", 2005, over a fixed-(B+1) pane ring). The
 * recency sibling of lite-sketch's cumulative CountMinSketch and the frequency complement of
 * SlidingHyperLogLog / SlidingDDSketch.
 *
 * Headline (the family TRIPLE):
 *   - SPACE: a FIXED ring of B+1 panes, each a dense `Uint32Array(d * w)` CountMin matrix; never grows
 *     (defaults ~epsilon=delta=0.01 -> d=5, w=512, panes=32 -> ~338 KB).
 *   - ERROR: a ONE-SIDED over-estimate `true(W) <= est <= true(W+W/B) + epsilon*N` on the merged live
 *     window (epsilon = e/w, delta = e^-d), PLUS a window-edge error of up to one pane width W/B (the
 *     straddling oldest pane, kept -- never dropped).
 *   - RECENCY: a HARD last-W window (forgets at the window edge, + up to one pane width) with a
 *     sub-window query `estimate(key, w)` for any `w <= W`.
 *
 * Hot path (`add` / `addFrom`, 0 B/op INCLUDING pane rotation): validate key + count, lock/verify the
 * time mode, rotate + clear panes if `now` crossed a boundary (a bounded, alloc-free while-loop capped
 * at B+1 -- one rotation is an O(d*w) fill(0) spike, disclosed as amortized), run the two-lane murmur
 * through the ARGUMENT-FREE hkHash helper (F19v2: key + seed via HK_KIN slots, lanes via HK_HS, all
 * rounds + fmix in register-resident int32 locals; base = (HK_HS[0] ^ HK_HS[1])) so a uint32 >= 2^31
 * lane never boxes; output bit-identical to lite-sketch CMS, proven by SCMParity), and write
 * the d cells of the CURRENT pane (conservative-update per pane by default, plain add otherwise),
 * saturating at 2^32-1.
 *
 * Cold path: `estimate(key, w?)` sums each row's cell across the live panes then MINs over rows
 * (O(d x (B+1)), 0 alloc) -- a disclosed co-headline, NOT a per-add cost. `clear()` reuses every array.
 *
 * Fail closed: a bad W / epsilon / delta / w / d / panes / seed / conservative / option throws
 * `[lite-adaptive]` at the ctor door BEFORE any allocation; `add` / `addFrom` reject a non-number / NaN
 * / +-Infinity / non-safe-integer key, a non-positive-integer count, a mode switch, a non-finite /
 * decreasing `now` -- typeof-first, every rejection a BYTE-IDENTICAL no-op (validated before any state
 * write). `estimate` NEVER throws (0 for an unseen / out-of-domain key or an empty window -- parity with
 * lite-sketch CMS so a consumer can swap it in). Key domain: every SAFE INTEGER |key| <= 2^53 - 1 (so a
 * composite key channelIdx*2^32 + tag works for a single shared instance). The `saturated` getter is the
 * honesty flag (count of adds that hit the 2^32-1 ceiling). null is not zero. No `merge` in 1.5.0.
 */
export class SlidingCountMin {
    /**
     * @param {number} W        window size; a finite number > 0 (items in count mode, or the
     *                          `now`-unit span in explicit mode). NOT capped.
     * @param {{epsilon?: number, delta?: number, w?: number, d?: number, panes?: number, seed?: number, conservative?: boolean}} [options]
     *   epsilon: relative error in (0, 1) (default 0.01) -> w = ceil(e/epsilon) rounded up to a power of two.
     *   delta:   failure probability in (0, 1) (default 0.01) -> d = ceil(ln(1/delta)).
     *   w:       explicit width (cells/row) in [1, 2^16], rounded UP to a power of two (overrides epsilon).
     *   d:       explicit depth (hash rows) in [1, 32] (overrides delta).
     *   panes:   pane count B; an integer in [2, 1024] (default 32). Edge error is W / panes; ring is B+1.
     *   seed:    uint32 hash seed (any integer, coerced with `| 0`); default shared with the hashing members.
     *   conservative: conservative-update (per pane) instead of plain add; default true (lite-sketch CMS parity).
     */
    constructor(W, options) {
        // typeof guard FIRST, BEFORE any allocation (a bad param leaves no half-built instance).
        if (typeof W !== 'number' || W !== W || W === Infinity || W === -Infinity || W <= 0) {
            throw new RangeError(
                '[lite-adaptive] SlidingCountMin W must be a finite number > 0, got ' + describeArg(W));
        }
        let epsilon, delta, wOpt, dOpt;
        let panes = SCM_DEFAULT_PANES;
        let seed = SCM_DEFAULT_SEED;
        let conservative = true;
        if (options !== undefined) {
            optDoor(options, SCM_KNOWN_OPTS, 'SlidingCountMin');
            if (options.epsilon !== undefined) {
                epsilon = options.epsilon;
                if (typeof epsilon !== 'number' || !(epsilon > 0 && epsilon < 1)) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingCountMin epsilon must be a number in (0, 1), got ' + describeArg(epsilon));
                }
            }
            if (options.delta !== undefined) {
                delta = options.delta;
                if (typeof delta !== 'number' || !(delta > 0 && delta < 1)) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingCountMin delta must be a number in (0, 1), got ' + describeArg(delta));
                }
            }
            if (options.w !== undefined) {
                wOpt = options.w;
                if (typeof wOpt !== 'number' || (wOpt | 0) !== wOpt || wOpt < 1 || wOpt > SCM_W_MAX) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingCountMin w must be an integer in [1, ' + SCM_W_MAX + '], got ' + describeArg(wOpt));
                }
            }
            if (options.d !== undefined) {
                dOpt = options.d;
                if (typeof dOpt !== 'number' || (dOpt | 0) !== dOpt || dOpt < 1 || dOpt > SCM_D_MAX) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingCountMin d must be an integer in [1, ' + SCM_D_MAX + '], got ' + describeArg(dOpt));
                }
            }
            if (options.panes !== undefined) {
                const p = options.panes;
                if (typeof p !== 'number' || (p | 0) !== p || p < SCM_PANES_MIN || p > SCM_PANES_MAX) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingCountMin panes must be an integer in [' + SCM_PANES_MIN +
                        ', ' + SCM_PANES_MAX + '], got ' + describeArg(p));
                }
                panes = p;
            }
            if (options.seed !== undefined) {
                seed = options.seed;
                if (typeof seed !== 'number' || !Number.isInteger(seed)) {
                    throw new RangeError(
                        '[lite-adaptive] SlidingCountMin seed must be an integer, got ' + describeArg(seed));
                }
            }
            // conservative = true is the default; guard `undefined`, and require a real boolean (null is not true).
            if (options.conservative !== undefined) {
                conservative = options.conservative;
                if (typeof conservative !== 'boolean') {
                    throw new TypeError(
                        '[lite-adaptive] SlidingCountMin conservative must be a boolean, got ' + describeArg(conservative));
                }
            }
        }
        // Derive width w: explicit `w` overrides `epsilon`; else w = ceil(e/epsilon) (lite-sketch CMS
        // derivation), clamped to SCM_W_MAX BEFORE the power-of-two round-up so `<<= 1` never overflows.
        let w;
        if (wOpt !== undefined) {
            w = wOpt;
        } else {
            const eps = epsilon !== undefined ? epsilon : SCM_DEFAULT_EPSILON;
            w = Math.ceil(Math.E / eps);
            if (w > SCM_W_MAX) w = SCM_W_MAX;
        }
        let cw = 1;
        while (cw < w) cw <<= 1;
        if (cw > SCM_W_MAX) {
            throw new RangeError(
                '[lite-adaptive] SlidingCountMin w rounded up to ' + cw + ' exceeds max ' + SCM_W_MAX);
        }
        w = cw;
        // Derive depth d: explicit `d` overrides `delta`; else d = ceil(ln(1/delta)) clamped to [1, 32].
        let d;
        if (dOpt !== undefined) {
            d = dOpt;
        } else {
            const del = delta !== undefined ? delta : SCM_DEFAULT_DELTA;
            d = Math.ceil(Math.log(1 / del));
            if (d < 1) d = 1;
            if (d > SCM_D_MAX) d = SCM_D_MAX;
        }
        const ring = panes + 1;
        // SMI cap: keep every flat cell index a SMI (else _cells[id] boxes / deopts on a pathological size).
        if (ring * d * w > SCM_CELLS_CAP) {
            throw new RangeError(
                '[lite-adaptive] SlidingCountMin store (panes+1)*d*w=' + (ring * d * w) +
                ' exceeds cap ' + SCM_CELLS_CAP);
        }
        // Fail closed BEFORE alloc: a SUBNORMAL W underflows W/panes to 0 (or a non-finite value), which
        // would make floor(now / paneW) == NaN -> no pane ever live -> add() never throws yet estimate()
        // silently returns 0 for a just-added key (a violation of the one-sided lower bound true(W) <= est).
        const paneW = W / panes;     // per-pane time width (the disclosed edge error)
        if (!(paneW > 0) || !Number.isFinite(paneW)) {
            throw new RangeError(
                '[lite-adaptive] SlidingCountMin W is too small for panes=' + panes +
                ' (W / panes underflowed to ' + paneW + '); use a larger W or fewer panes');
        }
        // The pane width must be a NORMAL double: a subnormal pw loses significand bits, so the grid line
        // (k+1)*pw no longer round-trips and (B+1)*pw can fall below W -> under-cover (H2-1 F3). Fail closed
        // BEFORE alloc (the `!(>=)` form also rejects a NaN paneW, though the step above caught it).
        if (!(paneW >= SCM_MIN_NORMAL)) {
            throw new RangeError(
                '[lite-adaptive] SlidingCountMin W / panes (' + paneW + ') is subnormal; the pane grid ' +
                'cannot hold W exactly -- use a larger W or fewer panes');
        }

        this._W = W;
        this._panes = panes;         // B (getter returns this); the ring holds B+1 panes
        this._ring = ring;           // B + 1
        this._d = d;
        this._w = w;
        this._mask = w - 1;          // w is a power of two -> column = hash & mask
        this._dw = d * w;            // cells per pane
        this._seed = seed | 0;       // SMI-safe (signed int32); the murmur uses it as `s | 0` either way
        this._conservative = conservative;
        this._paneW = paneW;         // per-pane time width (the disclosed edge error); guarded normal above
        this._nowMax = paneW * SCM_CLOCK_SPAN;   // |now| clock-precision bound (pw * 2^42); one field compare on the hot path
        this._epsilon = Math.E / w;  // theoretical relative error e/w
        this._delta = Math.exp(-d);  // theoretical failure probability e^-d
        this._cells = new Uint32Array(ring * d * w);   // (B+1) dense d x w matrices (saturate at 2^32-1)
        this._paneEnd = new Float64Array(ring);        // per-pane EXCLUSIVE upper time bound
        this._paneTotal = new Float64Array(ring);      // per-pane EXACT count total (the eps x N denominator; 1.8.0)
        this._idx = new Int32Array(d);                 // per-row flat-index scratch (0-alloc conservative update)
        this._bytes = this._cells.byteLength + this._paneEnd.byteLength +
            this._paneTotal.byteLength + this._idx.byteLength;

        this._initState();
    }

    /**
     * Build a windowed sketch sized to a target accuracy -- the lite-sketch CountMinSketch.withAccuracy
     * convenience, one axis over: `w = ceil(e/epsilon)` (rounded up to a power of two), `d = ceil(ln(1/delta))`.
     * A COLD one-time path; it merges `epsilon` / `delta` into the options bag and delegates ALL sizing +
     * validation (incl. the power-of-two round-up, the caps, and the SMI check) to the ctor. Any `panes` /
     * `seed` / `conservative` in `options` pass through; an explicit `w` / `d` there overrides the derived value.
     * @param {number} W       window size; a finite number > 0.
     * @param {number} epsilon relative error, in (0, 1).
     * @param {number} delta   failure probability, in (0, 1).
     * @param {{panes?: number, seed?: number, conservative?: boolean, w?: number, d?: number}} [options]
     * @returns {SlidingCountMin}
     */
    static withAccuracy(W, epsilon, delta, options) {
        if (typeof epsilon !== 'number' || !(epsilon > 0 && epsilon < 1)) {
            throw new RangeError(
                '[lite-adaptive] SlidingCountMin.withAccuracy epsilon must be a number in (0, 1), got ' + describeArg(epsilon));
        }
        if (typeof delta !== 'number' || !(delta > 0 && delta < 1)) {
            throw new RangeError(
                '[lite-adaptive] SlidingCountMin.withAccuracy delta must be a number in (0, 1), got ' + describeArg(delta));
        }
        // Same door as the ctor (R6), with the factory label, BEFORE copying options.
        optDoor(options, SCM_KNOWN_OPTS, 'SlidingCountMin.withAccuracy');
        const opts = {};
        if (options !== undefined) for (const key in options) opts[key] = options[key];
        opts.epsilon = epsilon;
        opts.delta = delta;
        return new SlidingCountMin(W, opts);
    }

    /** @private Reset all pane state + time mode. Reused by clear(). 0 alloc. */
    _initState() {
        this._cells.fill(0);
        this._paneEnd.fill(0);
        this._paneTotal.fill(0);     // per-pane exact count total (1.8.0)
        this._cur = 0;               // current (newest) pane index in the ring
        this._mode = MODE_UNSET;     // time mode, locked at the first add
        this._tick = 0;              // count-mode logical clock
        this._lastNow = 0;           // explicit-mode monotone guard (init value never compared)
        this._now = 0;               // the last applied t (query cutoff = now - W)
        this._saturated = 0;         // count of adds that hit the 2^32-1 ceiling (the honesty flag)
    }

    /** Depth d (hash rows). O(1). */
    get d() { return this._d; }
    /** Width w (columns/row, a power of two). O(1). */
    get w() { return this._w; }
    /** The pane count B (edge error is W / panes; the ring holds B+1 panes). O(1). */
    get panes() { return this._panes; }
    /** Window size W. O(1). */
    get W() { return this._W; }
    /** The uint32 hash seed. O(1). */
    get seed() { return this._seed >>> 0; }
    /** Whether conservative update (per pane) is on. O(1). */
    get conservative() { return this._conservative; }
    /** How many adds hit the 2^32-1 saturation ceiling (the honesty flag; 0 in normal use). O(1). */
    get saturated() { return this._saturated; }
    /** The theoretical relative error e / w. O(1). */
    get epsilon() { return this._epsilon; }
    /** The theoretical failure probability e^-d. O(1). */
    get delta() { return this._delta; }
    /** The last applied time t (0 before the first add). O(1). */
    get lastNow() { return this._now; }
    /** The locked time mode: 'unset' | 'explicit' | 'count'. O(1). */
    get mode() {
        return this._mode === MODE_EXPLICIT ? 'explicit' : this._mode === MODE_COUNT ? 'count' : 'unset';
    }
    /** A fixed memory figure in bytes (all pane matrices + paneEnd + paneTotal + scratch). O(1). */
    get bytes() { return this._bytes; }

    /**
     * Add `count` (default 1) occurrences of `key` observed at `now`. HOT, 0 B/op INCLUDING pane
     * rotation + clear (one rotation is an amortized O(d*w) fill(0) spike, disclosed).
     *
     * Time modes (LOCKED at the first add, a switch throws):
     *   - EXPLICIT: add(now, key, count?). `now` is a finite number, strictly NON-DECREASING across calls.
     *   - COUNT: add(undefined, key, count?). The member auto-increments an internal tick per add (W in items).
     *
     * Key domain: every SAFE INTEGER |key| <= 2^53 - 1 (the hot body folds the low word + high word + sign);
     * `count` a positive integer in [1, 2^32-1].
     *
     * Fail closed: a non-number / NaN / +-Infinity / non-safe-integer key, a non-positive-integer count, a
     * mode switch, or a non-finite / decreasing `now` throws [lite-adaptive] (typeof-first, a BYTE-IDENTICAL
     * no-op -- ALL validation precedes any state write).
     * @param {number} [now]  the monotone time (omit for count mode).
     * @param {number} key    a safe integer, |key| <= 2^53 - 1.
     * @param {number} [count=1] a positive integer in [1, 2^32-1].
     * @returns {SlidingCountMin} this
     */
    add(now, key, count = 1) {
        // 1. validate key + count FIRST (typeof-first), before ANY state mutation.
        if (typeof key !== 'number' || key !== key || !Number.isInteger(key) ||
            key > 9007199254740991 || key < -9007199254740991) return this._badKey(key);
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > SCM_SAT) {
            return this._badCount(count);
        }
        // 2. resolve + lock the time mode (no mutation until every key + count + time check has passed).
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            if (now !== undefined) return this._badMode('count', 'explicit');
            t = this._tick + 1;
            if (!(t <= this._nowMax)) return this._badNowRange(t);   // tick past pw * 2^42 -> fail closed
            this._tick = t;
        } else if (mode === MODE_EXPLICIT) {
            if (now === undefined) return this._badMode('explicit', 'count');
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badNow(now);
            }
            if (now < this._lastNow) return this._badMonotone(now);
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            t = now;
            this._lastNow = now;
        } else {
            if (now === undefined) {
                t = this._tick + 1;
                if (!(t <= this._nowMax)) return this._badNowRange(t);
                this._mode = MODE_COUNT;
                this._tick = t;
                this._now = t;
                this._anchor();
            } else {
                if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                    return this._badNow(now);
                }
                const nm = this._nowMax;
                if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
                this._mode = MODE_EXPLICIT;
                t = now;
                this._lastNow = now;
                this._now = t;
                this._anchor();
            }
        }
        this._now = t;
        // 3. rotate + clear panes if this t crossed the current pane boundary (bounded, 0-alloc).
        if (t >= this._paneEnd[this._cur]) this._advance();
        this._paneTotal[this._cur] += count;   // exact per-pane N (AFTER rotation: lands in the target pane; 1.8.0)
        // 4. two-lane murmur, HAND-INLINED in int32 locals (F19v2): the key word / hash state never
        //    leaves a register -- nothing crosses a call boundary (no >= 2^31 HeapNumber box) and
        //    there is no per-round Int32Array round-trip (that cost ~59% on this hot path). Output
        //    bit-identical to lite-sketch CMS (base = hi ^ lo), proven by SCMParity.
        let a = key, neg = 0;
        if (a < 0) { a = -a; neg = 1; }
        const lo = a >>> 0;
        const w1 = (a < 4294967296 ? 0 : (Math.floor(a / 4294967296) >>> 0)) ^ neg;
        const s = this._seed;
        let h = s, kk;
        kk = Math.imul(lo, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        h ^= kk; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
        kk = Math.imul(w1, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        h ^= kk; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
        h ^= 8; h ^= h >>> 16; h = Math.imul(h, HK_FC1); h ^= h >>> 13; h = Math.imul(h, HK_FC2); h ^= h >>> 16;
        let g = s ^ HK_LANE_SALT;
        kk = Math.imul(lo, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        g ^= kk; g = (g << 13) | (g >>> 19); g = (Math.imul(g, 5) + 0xe6546b64) | 0;
        kk = Math.imul(w1, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        g ^= kk; g = (g << 13) | (g >>> 19); g = (Math.imul(g, 5) + 0xe6546b64) | 0;
        g ^= 8; g ^= g >>> 16; g = Math.imul(g, HK_FC1); g ^= g >>> 13; g = Math.imul(g, HK_FC2); g ^= g >>> 16;
        const base = (h ^ g) | 0;
        // 5. write the d cells of the CURRENT pane (conservative per pane, or plain add).
        const cur = this._cur, d = this._d, w = this._w, mask = this._mask, cells = this._cells, idx = this._idx;
        const paneBase = cur * this._dw;
        if (this._conservative) {
            let mn = 0xffffffff;
            for (let i = 0; i < d; i++) {
                let m = (base ^ Math.imul(i, HK_ODD)) | 0;   // per-row fmix32 in int32 locals
                m ^= m >>> 16; m = Math.imul(m, HK_FC1); m ^= m >>> 13; m = Math.imul(m, HK_FC2); m ^= m >>> 16;
                const col = m & mask;
                const id = paneBase + i * w + col;
                idx[i] = id;
                const v = cells[id];
                if (v < mn) mn = v;
            }
            let target = mn + count;
            if (target > SCM_SAT) { target = SCM_SAT; this._saturated++; }   // saturate, never wrap
            for (let i = 0; i < d; i++) {
                const id = idx[i];
                if (cells[id] < target) cells[id] = target;
            }
        } else {
            let sat = 0;
            for (let i = 0; i < d; i++) {
                let m = (base ^ Math.imul(i, HK_ODD)) | 0;   // per-row fmix32 in int32 locals
                m ^= m >>> 16; m = Math.imul(m, HK_FC1); m ^= m >>> 13; m = Math.imul(m, HK_FC2); m ^= m >>> 16;
                const col = m & mask;
                const id = paneBase + i * w + col;
                let v = cells[id] + count;
                if (v > SCM_SAT) { v = SCM_SAT; sat = 1; }                   // saturate, never wrap
                cells[id] = v;
            }
            if (sat) this._saturated++;
        }
        return this;
    }

    /**
     * Add from a caller-owned PACKED stride-3 `[now, key, count]` Float64Array entry. HOT, 0 B/op -- the
     * ZERO-BOX entry: `now = buf[i]`, `key = buf[i+1]`, `count = buf[i+2]` are read UNBOXED, avoiding the
     * ~16 B HeapNumber each would box as a plain argument at a non-inlined call boundary. EXPLICIT-time
     * ONLY (addFrom always carries a `now`): a COUNT-locked instance rejects it and the first addFrom
     * locks EXPLICIT mode. Identical validation, throws, byte-identical-no-op-on-reject, and cell writes
     * as `add(now, key, count)`; the body is DUPLICATED (not delegated) to keep `add`'s hot body
     * byte-identical and avoid re-boxing at an internal boundary.
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = now, `buf[i+1]` = key, `buf[i+2]` = count.
     * @param {number} i the base index of the [now, key, count] triple (0, 3, 6, ...).
     * @returns {SlidingCountMin} this
     */
    addFrom(buf, i) {
        // Guard the buffer + index on the COLD branch first (a bad handle is a byte-identical no-op).
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i + 2 < buf.length)) return this._badBuf(buf, i);
        const now = buf[i];         // UNBOXED Float64Array reads -- the whole point (no argument box).
        const key = buf[i + 1];     // packed [now, key, count]
        const count = buf[i + 2];
        // 1. validate key + count FIRST (a Float64Array read is always a number, so no typeof branch).
        if (key !== key || !Number.isInteger(key) ||
            key > 9007199254740991 || key < -9007199254740991) return this._badKey(key);
        if (!Number.isInteger(count) || count < 1 || count > SCM_SAT) return this._badCount(count);
        // 2. addFrom is an EXPLICIT-time entry: reject a count-locked instance, else lock/verify EXPLICIT.
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (now !== now || now === Infinity || now === -Infinity) return this._badNow(now);
            if (now < this._lastNow) return this._badMonotone(now);
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            t = now;
            this._lastNow = now;
        } else {
            if (now !== now || now === Infinity || now === -Infinity) return this._badNow(now);
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
            this._now = t;
            this._anchor();
        }
        this._now = t;
        // 3. rotate + clear panes if this t crossed the current pane boundary (bounded, 0-alloc).
        if (t >= this._paneEnd[this._cur]) this._advance();
        this._paneTotal[this._cur] += count;   // exact per-pane N (AFTER rotation: lands in the target pane; 1.8.0)
        // 4. two-lane murmur, HAND-INLINED in int32 locals (F19v2; DUPLICATED from add() --
        //    byte-identical body; base = hi ^ lo).
        let a = key, neg = 0;
        if (a < 0) { a = -a; neg = 1; }
        const lo = a >>> 0;
        const w1 = (a < 4294967296 ? 0 : (Math.floor(a / 4294967296) >>> 0)) ^ neg;
        const s = this._seed;
        let h = s, kk;
        kk = Math.imul(lo, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        h ^= kk; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
        kk = Math.imul(w1, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        h ^= kk; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
        h ^= 8; h ^= h >>> 16; h = Math.imul(h, HK_FC1); h ^= h >>> 13; h = Math.imul(h, HK_FC2); h ^= h >>> 16;
        let g = s ^ HK_LANE_SALT;
        kk = Math.imul(lo, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        g ^= kk; g = (g << 13) | (g >>> 19); g = (Math.imul(g, 5) + 0xe6546b64) | 0;
        kk = Math.imul(w1, HK_C1); kk = (kk << 15) | (kk >>> 17); kk = Math.imul(kk, HK_C2);
        g ^= kk; g = (g << 13) | (g >>> 19); g = (Math.imul(g, 5) + 0xe6546b64) | 0;
        g ^= 8; g ^= g >>> 16; g = Math.imul(g, HK_FC1); g ^= g >>> 13; g = Math.imul(g, HK_FC2); g ^= g >>> 16;
        const base = (h ^ g) | 0;
        // 5. write the d cells of the CURRENT pane (DUPLICATED from add()).
        const cur = this._cur, d = this._d, w = this._w, mask = this._mask, cells = this._cells, idx = this._idx;
        const paneBase = cur * this._dw;
        if (this._conservative) {
            let mn = 0xffffffff;
            for (let ii = 0; ii < d; ii++) {
                let m = (base ^ Math.imul(ii, HK_ODD)) | 0;   // per-row fmix32 in int32 locals
                m ^= m >>> 16; m = Math.imul(m, HK_FC1); m ^= m >>> 13; m = Math.imul(m, HK_FC2); m ^= m >>> 16;
                const col = m & mask;
                const id = paneBase + ii * w + col;
                idx[ii] = id;
                const v = cells[id];
                if (v < mn) mn = v;
            }
            let target = mn + count;
            if (target > SCM_SAT) { target = SCM_SAT; this._saturated++; }
            for (let ii = 0; ii < d; ii++) {
                const id = idx[ii];
                if (cells[id] < target) cells[id] = target;
            }
        } else {
            let sat = 0;
            for (let ii = 0; ii < d; ii++) {
                let m = (base ^ Math.imul(ii, HK_ODD)) | 0;   // per-row fmix32 in int32 locals
                m ^= m >>> 16; m = Math.imul(m, HK_FC1); m ^= m >>> 13; m = Math.imul(m, HK_FC2); m ^= m >>> 16;
                const col = m & mask;
                const id = paneBase + ii * w + col;
                let v = cells[id] + count;
                if (v > SCM_SAT) { v = SCM_SAT; sat = 1; }
                cells[id] = v;
            }
            if (sat) this._saturated++;
        }
        return this;
    }

    /**
     * @private Anchor the pane ring around the first `now` (grid-aligned to W/panes -- ABSOLUTE alignment
     * so two same-(W, panes) instances would align, forward-compat for a future merge). The current pane
     * (index 0) covers the grid cell containing `now`; predecessors go backward by one pane width each.
     * Cold (once per lifecycle / clear). 0 alloc.
     */
    _anchor() {
        const B = this._ring, pw = this._paneW, now = this._now;
        const E = (Math.floor(now / pw) + 1) * pw;   // EXCLUSIVE upper bound of the current pane
        this._cur = 0;
        this._paneEnd[0] = E;
        let e = E, idx = 0;
        for (let s = 1; s < B; s++) { idx--; if (idx < 0) idx = B - 1; e -= pw; this._paneEnd[idx] = e; }
    }

    /**
     * @private Rotate the ring forward so the current pane covers this._now, clearing each pane it rotates
     * onto. Capped at B+1 rotations (a now-jump of k panes clears min(k, B+1) panes, NEVER loops k --
     * skipping >= B+1 panes clears them ALL, then re-anchors the ring around this._now). Argument-free
     * (reads this._now, the zero-box law). 0 alloc. Called only when this._now crossed the current boundary.
     */
    _advance() {
        const pw = this._paneW, B = this._ring, t = this._now;
        let cur = this._cur;
        // Grid index of the current pane end (E = k*pw exactly for an integer k in the legal clock
        // domain, |now| <= pw * 2^42, where ulp(E) <= pw * 2^-10 so the division round-trips). Each new
        // pane end is (k+1)*pw by MULTIPLICATION -- drift-free and bit-identical to the anchor / oracle's
        // (floor(t/pw)+1)*pw -- rather than an accumulating `E += pw`, whose per-step rounding drifts by
        // up to ~pw near the domain edge and can drop a live pane (H2-1 F2, fail-open).
        let k = Math.round(this._paneEnd[cur] / pw);
        let E = this._paneEnd[cur];
        let rot = 0;
        while (t >= E && rot < B) {
            cur++; if (cur === B) cur = 0;
            this._clearPane(cur);
            k += 1;
            E = k * pw;
            this._paneEnd[cur] = E;
            rot++;
        }
        if (t >= E) {
            // jumped >= B+1 pane widths: every pane cleared above -> grid-re-anchor around t.
            // No _paneTotal reset needed here: the <= B+1 _clearPane calls above already zeroed
            // every pane's total (the ring has B+1 panes, all cleared on a full-ring jump). (1.8.0)
            const newE = (Math.floor(t / pw) + 1) * pw;
            this._paneEnd[cur] = newE;
            let e = newE, idx = cur;
            for (let s = 1; s < B; s++) { idx--; if (idx < 0) idx = B - 1; e -= pw; this._paneEnd[idx] = e; }
        }
        this._cur = cur;
    }

    /** @private Clear one pane's d x w counter matrix + its exact total (0 alloc). */
    _clearPane(p) {
        const base = p * this._dw;
        this._cells.fill(0, base, base + this._dw);
        this._paneTotal[p] = 0;      // reset the pane's exact count total (1.8.0)
    }

    /**
     * Estimate `key`'s frequency over the last W (or a sub-window `w <= W`): for each row SUM the key's
     * cell across the LIVE panes (paneEnd > now - W, INCLUDING the straddling oldest pane -- the one-sided
     * upper bound), then take the MINIMUM over rows (sum-then-min). COLD, O(d x (B+1)), 0 alloc. Returns a
     * DOUBLE (a window sum can exceed 2^32). NEVER throws (F12): an UNSEEN valid key or an empty window
     * returns 0, but an OUT-OF-DOMAIN key or a bad sub-window `w` returns NaN (an invalid key was never
     * "seen 0 times", and 0 is indistinguishable from a legitimate miss). null is not zero.
     * @param {number} key
     * @param {number} [w] an optional sub-window in (0, W] (omit for the full window W).
     * @returns {number} the estimated windowed frequency (>= the true windowed count).
     */
    estimate(key, w) {
        // F12: an out-of-domain KEY or a bad sub-window `w` is NaN, never a throw and never a silent 0
        // (an invalid key was never "seen 0 times", and 0 is indistinguishable from a legitimate miss
        // for an upper-bound sketch). An UNSEEN valid key / empty window still reads 0. null is not zero.
        if (typeof key !== 'number' || key !== key || !Number.isInteger(key) ||
            key > 9007199254740991 || key < -9007199254740991) return NaN;
        // Validate `w` BEFORE the unset return: an unset instance with a bad `w` still fails closed (NaN),
        // so estimate() == estimateInto() slot-for-slot INCLUDING the unset + bad-w case (1.8.0).
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) {
                return NaN;
            }
            effW = w;
        }
        if (this._mode === MODE_UNSET) return 0;
        HK_KIN[0] = key;
        HK_KIN[1] = this._seed;
        hkHash();
        const base = (HK_HS[0] ^ HK_HS[1]) | 0;
        const d = this._d, wid = this._w, mask = this._mask, cells = this._cells, dw = this._dw, B = this._ring;
        const cut = this._now - effW;
        const paneEnd = this._paneEnd;
        let mn = Infinity;
        for (let i = 0; i < d; i++) {
            let m = (base ^ Math.imul(i, HK_ODD)) | 0;   // per-row fmix32 in int32 locals
            m ^= m >>> 16; m = Math.imul(m, HK_FC1); m ^= m >>> 13; m = Math.imul(m, HK_FC2); m ^= m >>> 16;
            const cellOff = i * wid + (m & mask);
            let sum = 0;
            for (let p = 0; p < B; p++) {
                if (paneEnd[p] > cut) sum += cells[p * dw + cellOff];   // sum this row across LIVE panes
            }
            if (sum < mn) mn = sum;                                     // then MIN over rows (sum-then-min)
        }
        return mn === Infinity ? 0 : mn;
    }

    /**
     * The EXACT total number of items N observed over the covered window (the last W, or a sub-window
     * `w <= W`) -- the eps x N denominator a consumer needs for the additive error term. COLD,
     * O(B+1), 0 alloc; NEVER throws. Summed from a per-pane Float64 total over the SAME live panes as
     * `estimate` (paneEnd > now - effW, INCLUDING the straddling oldest pane), so it is N over exactly
     * the span `estimate` covers ([W, W + W/B]).
     *
     * EXACT, not saturated: the d x w CELLS saturate at 2^32-1, but this Float64 total sums the
     * VALIDATED per-add `count` (each <= 2^32-1) and the windowed sum across panes loses no unit until
     * it passes 2^53. So `total()` is the exact N of the covered span even when individual cells clip.
     *
     * Fail closed (F12 parity with `estimate`): a bad sub-window `w` (non-number / NaN / +-Infinity /
     * <= 0 / > W) returns NaN; an UNSET instance (no add yet) returns 0. null is not zero.
     * @param {number} [w] an optional sub-window in (0, W] (omit for the full window W).
     * @returns {number} the exact windowed item total N (>= 0), or NaN for a bad `w`.
     */
    total(w) {
        // Validate `w` BEFORE the unset return: an unset instance with a bad `w` fails closed (NaN),
        // not fail-open 0 -- byte-parity with estimate()/estimateInto()'s bad-w NaN (1.8.0).
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) {
                return NaN;
            }
            effW = w;
        }
        if (this._mode === MODE_UNSET) return 0;
        const B = this._ring, paneEnd = this._paneEnd, paneTotal = this._paneTotal;
        const cut = this._now - effW;
        let sum = 0;
        for (let p = 0; p < B; p++) {
            if (paneEnd[p] > cut) sum += paneTotal[p];   // same live-pane rule as estimate (straddling pane kept)
        }
        return sum;
    }

    /**
     * Batch reader: estimate a whole ARRAY of `keys` into a caller-owned `out` Float64Array over the
     * last W (or a sub-window `w <= W`), 0 B/op -- the render-loop sibling of `estimate` (F6/R7). For
     * each key j in [0, keys.length), `out[j]` gets exactly what `estimate(keys[j], w)` would return:
     * NaN for an out-of-domain key, 0 for an unseen valid key / empty window, else the sum-then-min
     * windowed frequency. A bad sub-window `w` fills `out[0..n)` with NaN (matching `estimate`). COLD.
     *
     * No computed double is returned from, or passed across, a non-inlined call (F3/F5): the per-row
     * window sum lives in a LOCAL and lands directly in the `out` slot.
     *
     * Fail closed BEFORE any read (typeof-first): `keys` / `out` must be Float64Arrays and
     * `out.length >= keys.length`, else a tagged TypeError/RangeError (a byte-identical no-op).
     *
     * `keys` and `out` MAY be the SAME array (each slot j is read then written before j+1), but they must
     * NOT PARTIALLY OVERLAP (aliased with a non-zero offset) -- a partial overlap clobbers not-yet-read
     * keys and yields wrong results.
     * @param {Float64Array} keys a caller-owned Float64Array of safe-integer keys.
     * @param {Float64Array} out  a caller-owned Float64Array, `out.length >= keys.length` (may be `keys`
     *   itself, but must not partially overlap it).
     * @param {number} [w] an optional sub-window in (0, W] (omit for the full window W).
     * @returns {number} n = keys.length (the number of slots written).
     */
    estimateInto(keys, out, w) {
        if (!(ArrayBuffer.isView(keys) && keys instanceof Float64Array)) {
            throw new TypeError(
                '[lite-adaptive] SlidingCountMin.estimateInto(keys, out, w?) keys must be a Float64Array, got ' + describeArg(keys));
        }
        if (!(ArrayBuffer.isView(out) && out instanceof Float64Array)) {
            throw new TypeError(
                '[lite-adaptive] SlidingCountMin.estimateInto(keys, out, w?) out must be a Float64Array, got ' + describeArg(out));
        }
        const n = TA_LEN.call(keys);         // H34: intrinsic length, read ONCE (a subclass getter runs no user code)
        const outN = TA_LEN.call(out);       // H34: read ONCE; the message uses this local, never re-reads out.length
        if (!(outN >= n)) {
            throw new RangeError(
                '[lite-adaptive] SlidingCountMin.estimateInto out.length (' + outN +
                ') must be >= keys.length (' + n + ')');
        }
        // A bad sub-window `w` -> every out slot NaN (parity with estimate's bad-w NaN), then return n.
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) {
                for (let j = 0; j < n; j++) out[j] = NaN;
                return n;
            }
            effW = w;
        }
        const unset = this._mode === MODE_UNSET;
        const d = this._d, wid = this._w, mask = this._mask, cells = this._cells, dw = this._dw, B = this._ring;
        const cut = this._now - effW;
        const paneEnd = this._paneEnd;
        const seed = this._seed;  // a LOCAL: the shared HK_KIN slots are written only right before hkHash()
        for (let j = 0; j < n; j++) {
            const key = keys[j];     // may run user code (a Proxy typed array) -- so NO slot is live here
            // out-of-domain key -> NaN (parity with estimate); unset instance -> 0.
            if (key !== key || !Number.isInteger(key) || key > 9007199254740991 || key < -9007199254740991) {
                out[j] = NaN;
                continue;
            }
            if (unset) { out[j] = 0; continue; }
            HK_KIN[0] = key;         // write BOTH slots after the (possibly user-code) key read,
            HK_KIN[1] = seed;        // immediately before the hash -- no user code in between
            hkHash();
            const base = (HK_HS[0] ^ HK_HS[1]) | 0;
            let mn = Infinity;
            for (let i = 0; i < d; i++) {
                let m = (base ^ Math.imul(i, HK_ODD)) | 0;   // per-row fmix32 in int32 locals
                m ^= m >>> 16; m = Math.imul(m, HK_FC1); m ^= m >>> 13; m = Math.imul(m, HK_FC2); m ^= m >>> 16;
                const cellOff = i * wid + (m & mask);
                let sum = 0;                                            // row sum stays a LOCAL (F3/F5)
                for (let p = 0; p < B; p++) {
                    if (paneEnd[p] > cut) sum += cells[p * dw + cellOff];
                }
                if (sum < mn) mn = sum;
            }
            out[j] = mn === Infinity ? 0 : mn;                         // land the double directly in the out slot
        }
        return n;
    }

    /**
     * Advance the window's reference time to `now` WITHOUT adding a value (the R11 idle slide). It moves
     * `_now` forward and runs the SAME bounded pane rotate-and-clear an add would (the private `_advance`
     * -- distinct from this PUBLIC `advance`), so an idle stream still rotates stale panes out and
     * `estimate()` keeps sliding to empty (0) with no traffic. Bounded (<= B+1 clears), 0 B/op.
     *
     * EXPLICIT-time ONLY (parity with addFrom): a COUNT-locked instance throws; an UNSET instance locks
     * EXPLICIT (and anchors the pane ring around `now`). Monotone: `now` finite and >= lastNow (a decrease
     * throws). A rejected advance is a BYTE-IDENTICAL no-op.
     * @param {number} now the monotone time (finite, >= the last now).
     * @returns {SlidingCountMin} this
     */
    advance(now) {
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badAdvanceMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badAdvanceNow(now);
            }
            if (now < this._lastNow) return this._badAdvanceMonotone(now);
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            t = now;
            this._lastNow = now;
        } else {
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badAdvanceNow(now);
            }
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
            this._now = t;
            this._anchor();
        }
        this._now = t;
        if (t >= this._paneEnd[this._cur]) this._advance();   // rotate + clear stale panes (bounded).
        return this;
    }

    /**
     * Advance the window's reference time from a caller-owned Float64Array (`now = buf[i]`, read UNBOXED).
     * The ZERO-BOX sibling of advance(now) -- identical mode / monotone / rotate body, EXPLICIT-time only.
     * Fail closed BEFORE any read (typeof-first): a non-Float64Array `buf`, or a non-integer / negative /
     * out-of-range `i` (needs `i < buf.length`) throws [lite-adaptive].
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = now.
     * @param {number} i the index of the `now` scalar.
     * @returns {SlidingCountMin} this
     */
    advanceFrom(buf, i) {
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i < buf.length)) return this._badAdvanceBuf(buf, i);
        const now = buf[i];   // UNBOXED Float64Array read (always a number -> no typeof branch).
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badAdvanceMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (now !== now || now === Infinity || now === -Infinity) return this._badAdvanceNow(now);
            if (now < this._lastNow) return this._badAdvanceMonotone(now);
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            t = now;
            this._lastNow = now;
        } else {
            if (now !== now || now === Infinity || now === -Infinity) return this._badAdvanceNow(now);
            const nm = this._nowMax;
            if (!(now <= nm && now >= -nm)) return this._badNowRange(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
            this._now = t;
            this._anchor();
        }
        this._now = t;
        if (t >= this._paneEnd[this._cur]) this._advance();
        return this;
    }

    /** Reset to the empty window; reuse every array (also unlocks the mode). O((panes+1)*d*w). @returns {SlidingCountMin} this */
    clear() {
        this._initState();
        return this;
    }

    /** @private Cold thrower for a bad key (non-safe-integer). */
    _badKey(key) {
        throw new TypeError(
            '[lite-adaptive] SlidingCountMin key must be a safe integer (|key| <= 2^53 - 1), got ' + describeArg(key));
    }

    /** @private Cold thrower for a bad count. */
    _badCount(count) {
        throw new RangeError(
            '[lite-adaptive] SlidingCountMin count must be an integer in [1, ' + SCM_SAT + '], got ' + describeArg(count));
    }

    /** @private Cold thrower for a mode switch after the mode locked. */
    _badMode(locked, attempted) {
        throw new TypeError(
            '[lite-adaptive] SlidingCountMin mode is locked to ' + locked +
            ' at the first add; got a ' + attempted + '-mode add');
    }

    /** @private Cold thrower for a non-finite `now`. */
    _badNow(now) {
        throw new TypeError(
            '[lite-adaptive] SlidingCountMin add now must be a finite number, got ' + describeArg(now));
    }

    /** @private Cold thrower for a non-monotone `now`. */
    _badMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] SlidingCountMin add now must be non-decreasing: got ' + describeArg(now) +
            ' after ' + describeArg(this._lastNow));
    }

    /**
     * @private Cold thrower for a `now` (or count-mode tick) outside the clock-precision domain
     * (|now| > pw * 2^42). Fail closed BEFORE any state write -- past this bound the double clock cannot
     * represent the pane grid, so the covered span would silently under-cover the true window (H2-1 F1/F2).
     */
    _badNowRange(now) {
        throw new RangeError(
            '[lite-adaptive] SlidingCountMin now (' + describeArg(now) + ') is too large for the pane width (' +
            this._paneW + '); |now| must be <= pw * 2^42 (' + this._nowMax +
            ')' + (this._mode === MODE_COUNT ? ', including the count-mode tick,' : '') +
            ' -- rebase the clock (e.g. performance.now()) or use a larger W');
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] SlidingCountMin.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i + 2 < buf.length, got ' + describeArg(buf) + ', ' + describeArg(i));
    }

    /** @private Cold thrower for an advance mode switch (advance is EXPLICIT-only). */
    _badAdvanceMode(locked, attempted) {
        throw new TypeError(
            '[lite-adaptive] SlidingCountMin mode is locked to ' + locked +
            '; advance() is an ' + attempted + '-time op');
    }

    /** @private Cold thrower for a non-finite advance `now`. */
    _badAdvanceNow(now) {
        throw new TypeError(
            '[lite-adaptive] SlidingCountMin advance now must be a finite number, got ' + describeArg(now));
    }

    /** @private Cold thrower for a non-monotone advance `now`. */
    _badAdvanceMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] SlidingCountMin advance now must be non-decreasing: got ' + describeArg(now) +
            ' after ' + describeArg(this._lastNow));
    }

    /** @private Cold thrower for a bad advanceFrom buffer/index. */
    _badAdvanceBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] SlidingCountMin.advanceFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i < buf.length, got ' + describeArg(buf) + ', ' + describeArg(i));
    }
}

// ===========================================================================
// DecayedReservoir (ADR 0011) -- a recency-biased sample of real stream values
// ===========================================================================
//
// Efraimidis-Spirakis A-Res weighted reservoir sampling (IPL 2006) over FORWARD-DECAY
// weights (design-parity with ForwardDecay): a fixed-size-k SAMPLE of ACTUAL recent
// stream VALUES, biased toward the recent. Every prior member returns a SUMMARY; this
// hands back RAW values the caller computes anything they like over (custom percentile,
// histogram, spark-line, bootstrap CI). One SEEDED xorshift32 draw u ~ Uniform(0,1) per
// accepted add (the EXACT HeavyKeeper PRNG), an A-Res key in LOG SPACE
//   key = log(u) * exp(-lambda*(t - L)) * scale,   lambda = ln2 / halfLife
// and the k HIGHEST keys kept in an INLINE size-k binary MIN-HEAP (root = smallest key =
// the eviction candidate; design-parity with HeavyKeeper / lite-o1 FreqO1, never a dep).
// The landmark rebase is an ORDER-PRESERVING common-factor multiply (proven not to disturb
// membership), capped so a key never underflows to -0 within a single rebase; across multiple
// back-to-back capped rebases a stored key CAN reach -Infinity, which is HARMLESS (order preserved,
// values finite, no NaN, oldest items evict first -- ADR 0011). Raw-sample-only:
// sampleInto / forEach / clear / getters -- NO aggregates, NO advance (a sample, not a window).

/** Frozen marker of the known DecayedReservoir ctor option keys -- an unknown key is a throw. */
const DR_KNOWN_OPTS = Object.freeze(Object.assign(Object.create(null), { seed: true }));
/** Default per-instance seed (a uint32, nonzero). Two default-seeded reservoirs behave identically. */
const DR_DEFAULT_SEED = 0x9e3779b1;
/**
 * Max reservoir size k (F11): 2^24 slots x 16 B (value + priority) = ~256 MB, the memory ceiling.
 * Above it the ctor throws a tagged RangeError BEFORE allocation instead of a lazy multi-GB
 * over-commit (e.g. `DR(2^31, 1)` reported ~34 GB of `bytes` in 1.6.0).
 */
const DR_K_MAX = 2 ** 24;
/**
 * DR_EXP_CAP -- the exp() argument ceiling that triggers a landmark rebase (mirrors FD_EXP_CAP=40).
 * The hot path rebases the landmark to `t` BEFORE lambda*(t - L) exceeds this, so a freshly computed
 * key never sees exp(-lambda*(t - L)) fall below exp(-40) ~= 4.2e-18 (astronomically above the
 * smallest normal double ~2.2e-308) -- a new key never underflows to -0. A rebase then fires only
 * every DR_EXP_CAP / ln2 ~= 57.7 half-lives of elapsed time.
 */
const DR_EXP_CAP = 40;
/**
 * DR_F_CAP -- the ceiling on the rebase FACTOR argument. A huge idle gap then a resume (t - L
 * enormous in ONE add) would make F = exp(lambda*(t - L)) overflow to Infinity, and key * Infinity
 * -> -Infinity would tie every retained slot. Capping the argument at 700 keeps F <= exp(700) ~=
 * 1.01e304, so F * the worst-case |key| ~= 22.18 stays ~2.2e305 < Double.MAX ~= 1.798e308 -- finite.
 * A common capped factor still multiplies every stored key by the SAME value, so the order (and the
 * retained set) is still preserved; the ancient items simply sink and are evicted deterministically.
 */
const DR_F_CAP = 700;

/**
 * DecayedReservoir -- a fixed-size-k SAMPLE of ACTUAL recent stream VALUES, biased toward the
 * recent (Efraimidis-Spirakis A-Res weighted reservoir sampling, IPL 2006, over ForwardDecay
 * weights). Unlike every other family member -- which returns a count / sum / quantile / frequency
 * / drift bit / top-k SUMMARY -- DecayedReservoir returns RAW values: the caller reads the sample
 * and computes whatever they want over it (a custom percentile, a histogram, a spark-line). An
 * item's retention probability decays as exp(-lambda*age), lambda = ln2 / halfLife, so a recent
 * item is exponentially more likely to be in the sample.
 *
 * Headline (the recency TRIPLE):
 *   - SPACE: O(k) -- two Float64Array(k) columns (values + A-Res keys). bytes = k*16 + 64.
 *   - ERROR: the retained set is a correct WEIGHTED reservoir (A-Res): P(item in sample) is
 *     proportional to its forward-decay weight exp(-lambda*age), verified in the witness.
 *   - RECENCY: SMOOTH exponential bias (a soft "effective window" ~ halfLife / ln2), no hard edge.
 *
 * The A-Res key is computed in LOG SPACE, key = log(u) * exp(-lambda*(t - L)) * scale, from ONE
 * seeded xorshift32 draw u ~ Uniform(0,1) per accepted add (the EXACT HeavyKeeper PRNG). The k
 * HIGHEST keys live in an INLINE size-k binary MIN-HEAP (root = the smallest key = the eviction
 * candidate). The landmark rebase (fires when lambda*(t - L) > DR_EXP_CAP) is an ORDER-PRESERVING
 * common-factor multiply of the <= k live keys -- COLD, RARE, 0-alloc -- capped (DR_F_CAP) so a key
 * never underflows to -0 nor overflows to -Inf across a long idle gap.
 *
 * Time model (mirrors ExponentialHistogram / ForwardDecay): a caller-supplied MONOTONE `now`, or
 * count mode (auto-tick) when `now` is omitted; the mode LOCKS at the first add and a switch throws.
 * Value domain: ANY finite real (signed OK) -- the sample stores values verbatim.
 *
 * Hot path (`add` / `addFrom`, 0 B/op INCLUDING the rebase branch): a typeof value guard, the mode
 * resolve + monotone-`now` guard, ONE xorshift32 draw, one log() + one exp(), and a bounded
 * min-heap sift. No objects, no closures, no arrays.
 *
 * Fail closed: a bad `k` / `halfLife` / `seed` / option throws `[lite-adaptive]` at the ctor door
 * BEFORE any allocation; `add` validates the value + resolves/validates `now` + the mode BEFORE any
 * state mutation (a rejected add is a BYTE-IDENTICAL no-op -- it does NOT advance the PRNG or the
 * landmark); `sampleInto` / `forEach` reject a bad buffer / callback. null is not zero.
 */
export class DecayedReservoir {
    /**
     * @param {number} k         the reservoir size (sample capacity); a positive integer.
     * @param {number} halfLife  the decay half-life; a finite number > 0 (the time span over which
     *                           an item's retention weight halves). lambda = ln2 / halfLife.
     * @param {object} [options] { seed?: uint32 (default 0x9e3779b1; seed=0 is a valid distinct
     *                seed -- guarded as `undefined`, not falsy) }. An unknown key throws.
     */
    constructor(k, halfLife, options) {
        // typeof guards FIRST, BEFORE any allocation (a bad param leaves no half-built instance).
        if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > DR_K_MAX) {
            throw new RangeError(
                '[lite-adaptive] DecayedReservoir k must be an integer in [1, ' + DR_K_MAX + '], got ' + describeArg(k));
        }
        if (typeof halfLife !== 'number' || halfLife !== halfLife || halfLife === Infinity || halfLife <= 0) {
            throw new RangeError(
                '[lite-adaptive] DecayedReservoir halfLife must be a finite number > 0, got ' + describeArg(halfLife));
        }
        // A subnormal halfLife makes lambda = ln2/halfLife overflow to Infinity, which poisons
        // the A-Res priorities to NaN and freezes the sample at the first k values. Reject it here,
        // BEFORE any allocation, NaN-safe (F14).
        const lambda = Math.LN2 / halfLife;
        if (!(lambda < Infinity)) {
            throw new RangeError(
                '[lite-adaptive] DecayedReservoir halfLife ' + describeArg(halfLife) +
                ' is too small: lambda = ln2/halfLife = ' + describeArg(lambda) +
                ' is not finite; halfLife must be >= ' + LAMBDA_HALFLIFE_MIN);
        }
        let seed = DR_DEFAULT_SEED;
        if (options !== undefined) {
            optDoor(options, DR_KNOWN_OPTS, 'DecayedReservoir');
            // seed=0 is a VALID distinct seed -- guard `undefined`, not falsy (null is not zero).
            if (options.seed !== undefined) {
                const s = options.seed;
                if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || s > 4294967295) {
                    throw new RangeError(
                        '[lite-adaptive] DecayedReservoir seed must be a uint32 (integer in [0, 2^32-1]), got ' + describeArg(s));
                }
                seed = s;
            }
        }

        this._k = k;
        this._halfLife = halfLife;
        this._lambda = lambda;   // g(x) = exp(lambda * x); retention halves every halfLife
        this._seed = seed >>> 0;

        // the k-slot min-forest columns (heap slot -> value / A-Res key). SoA, parallel.
        this._val = new Float64Array(k);   // the stored sample value
        this._pri = new Float64Array(k);   // the stored A-Res log-space priority key

        // the seeded xorshift32 state (kept SIGNED int32 so it never boxes; the EXACT HeavyKeeper
        // derivation, so a nonzero-forcing mix makes seed=0 a valid distinct, non-degenerate seed).
        let rs = (seed ^ HK_RNG_SALT) | 0;
        rs ^= rs >>> 16; rs = Math.imul(rs, HK_FC1); rs ^= rs >>> 13; rs = Math.imul(rs, HK_FC2); rs ^= rs >>> 16;
        this._rng0 = (rs | 1) | 0;

        // a fixed memory figure (bytes): two Float64Array(k) columns + scalar overhead.
        this._bytes = k * 16 + 64;

        this._initState();
    }

    /** @private Reset the heap + landmark + PRNG + time mode to empty. Reused by clear(). 0 alloc. */
    _initState() {
        this._n = 0;               // live heap size (<= k)
        this._L = 0;               // the landmark time (keys are measured forward from here)
        this._scale = 1;           // the locked key formula's global scale (see ADR 0011; held at 1)
        this._mode = MODE_UNSET;   // time mode, locked at the first add
        this._tick = 0;            // count-mode logical clock
        this._lastNow = -Infinity; // explicit-mode monotone guard
        this._now = 0;             // the last applied t
        this._rng = this._rng0;    // replay the PRNG from its seeded initial state
    }

    /** The reservoir size (sample capacity). O(1). */
    get k() { return this._k; }
    /** The decay half-life (retention weight halves every halfLife time units). O(1). */
    get halfLife() { return this._halfLife; }
    /** The decay rate lambda = ln2 / halfLife. O(1). */
    get lambda() { return this._lambda; }
    /** The hash / PRNG seed (uint32). O(1). */
    get seed() { return this._seed >>> 0; }
    /** The number of values currently in the sample (<= k). O(1). */
    get size() { return this._n; }
    /** The locked time mode: 'unset' | 'explicit' | 'count'. O(1). */
    get mode() {
        return this._mode === MODE_EXPLICIT ? 'explicit' : this._mode === MODE_COUNT ? 'count' : 'unset';
    }
    /** A fixed memory figure in bytes (the two Float64Array(k) columns + scalar overhead). O(1). */
    get bytes() { return this._bytes; }

    /**
     * Record one value into the recency-biased sample. HOT, 0 B/op INCLUDING the landmark rebase and
     * the min-heap sift. Draws ONE seeded xorshift32 u ~ Uniform(0,1), computes the A-Res log-space
     * key = log(u) * exp(-lambda*(t - L)) * scale, and offers it to the size-k min-forest (admitted
     * iff it beats the current minimum key once the sample is full).
     *
     * Time modes (LOCKED at the first add, a switch throws):
     *   - EXPLICIT: add(now) / add(now, value). `now` is a finite number, strictly NON-DECREASING.
     *   - COUNT: add() / add(undefined, value). The member auto-increments an internal tick per add.
     *
     * `value` (both modes) defaults to 1; a supplied value must be a FINITE real (signed OK) -- it is
     * stored verbatim and read back by sampleInto / forEach.
     *
     * Fail closed: a mode switch, a non-finite `now`, a `now` going backwards, or a non-finite /
     * non-number value throws [lite-adaptive] (typeof-first, a BYTE-IDENTICAL no-op -- a rejected add
     * does NOT advance the PRNG, the landmark, or the count tick).
     * @param {number} [now]   the monotone time (omit for count mode).
     * @param {number} [value] the value to sample (default 1; any finite real).
     * @returns {DecayedReservoir} this
     */
    add(now, value) {
        // --- resolve + validate the value FIRST, before ANY state mutation (incl. the PRNG), so
        // every rejected add is a BYTE-IDENTICAL no-op. Any finite real is legal (signed OK). ---
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

        // --- ONE seeded xorshift32 draw (advanced EXACTLY once per ACCEPTED add, never on reject).
        //     The state never yields 0, so u is strictly in (0, 1) -> log(u) finite < 0. No box. ---
        let x = this._rng | 0;
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        this._rng = x | 0;
        const u = (x >>> 0) / 4294967296;

        // --- the A-Res log-space key (rebase the landmark if exp() would approach underflow -- a
        //     cold, rare, 0-alloc, ORDER-PRESERVING common-factor rescale of the live keys) ---
        const lambda = this._lambda;
        if (lambda * (t - this._L) > DR_EXP_CAP) this._rebase(t);
        const key = Math.log(u) * Math.exp(-lambda * (t - this._L)) * this._scale;
        this._offer(v, key);
        return this;
    }

    /**
     * Record one value from a caller-owned PACKED `[now, value]` Float64Array pair. HOT, 0 B/op --
     * the ZERO-BOX entry for a caller whose `now` AND `value` are both FRACTIONAL doubles: `add(now,
     * value)` boxes each fractional argument into a ~16 B HeapNumber at a non-inlined call boundary;
     * this reads `now = buf[i]` / `value = buf[i + 1]` UNBOXED straight from the array. The caller
     * writes a `Float64Array(2)` scratch and calls `addFrom(scratch, 0)` (a batch steps `i` by 2).
     * Identical draw, key, byte-identical-no-op-on-reject, and offer as `add(now, value)`; the body is
     * DUPLICATED (not delegated) to keep `add`'s hot body byte-identical and avoid re-boxing.
     *
     * EXPLICIT-time ONLY: addFrom always carries a `now`, so a COUNT-locked instance rejects it and
     * the first addFrom locks EXPLICIT (setting the landmark to the first element's time). The value
     * is validated FIRST, then the mode, then the monotone `now` -- all BEFORE any state mutation
     * (incl. the PRNG), so a rejected addFrom is a byte-identical no-op.
     *
     * Fail closed BEFORE any read (typeof-first): a non-Float64Array `buf`, or a non-integer /
     * negative / out-of-range `i` (needs `i + 1 < buf.length`) throws [lite-adaptive].
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = now, `buf[i+1]` = value.
     * @param {number} i the base index of the [now, value] pair (0, 2, 4, ...).
     * @returns {DecayedReservoir} this
     */
    addFrom(buf, i) {
        // Guard the buffer + index on the COLD branch first (a bad handle is a byte-identical no-op).
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i + 1 < buf.length)) return this._badBuf(buf, i);
        const now = buf[i];       // UNBOXED Float64Array reads -- the whole point (no argument box).
        const v = buf[i + 1];     // packed [now, value]
        // --- validate the value FIRST (mirror add(); any finite real is legal, signed OK; a
        // Float64Array read is always a number so add()'s typeof branch is omitted). ---
        if (!(v > -Infinity && v < Infinity)) return this._badValue(v);
        // --- addFrom is an EXPLICIT-time entry: reject a count-locked instance, else lock/verify
        // EXPLICIT + the monotone `now` (typeof-first, no alloc). ---
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (!(now > -Infinity && now < Infinity)) return this._badNow(now);
            if (now < this._lastNow) return this._badMonotone(now);
            t = now;
            this._lastNow = now;
        } else {
            if (!(now > -Infinity && now < Infinity)) return this._badNow(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
            this._L = t;   // first add: set the landmark to the first element's time
        }
        this._now = t;

        // --- ONE seeded xorshift32 draw -- DUPLICATED from add() to keep add()'s hot body
        //     byte-identical and avoid a boxing call boundary. ---
        let x = this._rng | 0;
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        this._rng = x | 0;
        const u = (x >>> 0) / 4294967296;
        const lambda = this._lambda;
        if (lambda * (t - this._L) > DR_EXP_CAP) this._rebase(t);
        const key = Math.log(u) * Math.exp(-lambda * (t - this._L)) * this._scale;
        this._offer(v, key);
        return this;
    }

    /**
     * @private Rebase the landmark to `t`. Cold, RARE (~every 57.7 half-lives), 0 B/op. Multiplies
     * every live A-Res key by the common factor F = exp(min(lambda*(t - L), DR_F_CAP)) and moves the
     * landmark to `t`. Because F is COMMON to every stored key, the multiply is a monotone transform
     * -> the `<` order among the keys, and therefore the retained set, is UNCHANGED (ADR 0011). The
     * DR_F_CAP cap keeps F finite across a huge idle gap so a key never overflows to -Inf.
     */
    _rebase(t) {
        let arg = this._lambda * (t - this._L);
        if (arg > DR_F_CAP) arg = DR_F_CAP;
        const F = Math.exp(arg);
        const n = this._n, pri = this._pri;
        for (let i = 0; i < n; i++) pri[i] *= F;
        this._L = t;
    }

    /**
     * @private Offer (value, key) to the size-k min-forest. If the sample has room, insert + siftUp;
     * else admit the item iff `key` beats the current minimum key (the heap root), replacing the root
     * + siftDown. 0-alloc.
     */
    _offer(value, key) {
        const n = this._n;
        if (n < this._k) {
            this._val[n] = value;
            this._pri[n] = key;
            this._n = n + 1;
            this._siftUp(n);
        } else if (key > this._pri[0]) {
            this._val[0] = value;
            this._pri[0] = key;
            this._siftDown(0);
        }
    }

    /** @private Sift heap slot i toward the root while its key is smaller than its parent's. 0-alloc. */
    _siftUp(i) {
        const pri = this._pri, val = this._val;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (pri[p] <= pri[i]) break;
            const vp = val[i], kp = pri[i];   // swap i, p
            val[i] = val[p]; pri[i] = pri[p];
            val[p] = vp; pri[p] = kp;
            i = p;
        }
    }

    /** @private Sift heap slot i toward the leaves while a child's key is smaller (min-heap). 0-alloc. */
    _siftDown(i) {
        const n = this._n, pri = this._pri, val = this._val;
        for (;;) {
            const l = 2 * i + 1, r = 2 * i + 2;
            let m = i;
            if (l < n && pri[l] < pri[m]) m = l;
            if (r < n && pri[r] < pri[m]) m = r;
            if (m === i) break;
            const vi = val[i], ki = pri[i];   // swap i, m
            val[i] = val[m]; pri[i] = pri[m];
            val[m] = vi; pri[m] = ki;
            i = m;
        }
    }

    /**
     * Copy the current sample VALUES into `buf`, returning the count written (heap order, NOT sorted).
     * 0-alloc -- the PRIMARY read. Fail closed: `buf` must be a Float64Array of length >= k (the max
     * sample size, so a full sample never truncates silently); a smaller buffer or a non-Float64Array
     * throws [lite-adaptive] (a cold throw before any write).
     * @param {Float64Array} buf a caller-owned Float64Array of length >= k.
     * @returns {number} the number of values written (<= k).
     */
    sampleInto(buf) {
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || !(TA_LEN.call(buf) >= this._k)) return this._badSampleBuf(buf);
        const n = this._n, val = this._val;
        for (let i = 0; i < n; i++) buf[i] = val[i];
        return n;
    }

    /**
     * Iterate the current sample, calling `fn(value)` per sampled value. HOT-SAFE, alloc-free (the
     * order is heap order, NOT sorted). NEVER throws (a non-function `fn` is a cold throw before
     * iteration).
     * @param {(value: number) => void} fn
     */
    forEach(fn) {
        if (typeof fn !== 'function') return this._badFn(fn);
        const n = this._n, val = this._val;
        for (let i = 0; i < n; i++) fn(val[i]);
    }

    /**
     * Reset to the empty sample; reuse both columns (0-alloc), unlock the mode, and replay the PRNG
     * from its seeded initial state (a cleared reservoir replays identically). O(1).
     * @returns {DecayedReservoir} this
     */
    clear() {
        this._initState();
        return this;
    }

    /** @private Cold thrower for a mode switch after the mode locked. */
    _badMode(locked, attempted) {
        throw new TypeError(
            '[lite-adaptive] DecayedReservoir mode is locked to ' + locked +
            ' at the first add; got a ' + attempted + '-mode add');
    }

    /** @private Cold thrower for a non-finite `now`. */
    _badNow(now) {
        throw new TypeError(
            '[lite-adaptive] DecayedReservoir add now must be a finite number, got ' + describeArg(now));
    }

    /** @private Cold thrower for a non-monotone `now`. */
    _badMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] DecayedReservoir add now must be non-decreasing: got ' + describeArg(now) +
            ' after ' + describeArg(this._lastNow));
    }

    /** @private Cold thrower for a bad value. */
    _badValue(v) {
        throw new TypeError(
            '[lite-adaptive] DecayedReservoir add value must be a finite number, got ' + describeArg(v));
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] DecayedReservoir.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i + 1 < buf.length, got ' + describeArg(buf) + ', ' + describeArg(i));
    }

    /** @private Cold thrower for a too-small / non-Float64Array sampleInto buffer. */
    _badSampleBuf(buf) {
        throw new TypeError(
            '[lite-adaptive] DecayedReservoir.sampleInto(buf) needs a Float64Array of length >= k (' +
            this._k + '), got ' + describeArg(buf));
    }

    /** @private Cold thrower for a non-function forEach callback. */
    _badFn(fn) {
        throw new TypeError(
            '[lite-adaptive] DecayedReservoir.forEach(fn) needs a function, got ' + describeArg(fn));
    }
}

// ===========================================================================
// SlidingAggregate (ADR 0012) -- exact windowed count / sum / mean / min / max
// ===========================================================================
//
// The EXACT windowed aggregate the family lacked: over the COVERED span [w, w + W/B]
// (which always CONTAINS the last w), count / sum / mean / min / max in FIXED memory.
// A ring of B+1 preallocated panes of width W/B
// (the SlidingCountMin ring, COPIED verbatim -- never a shared helper, so SCM's bytes
// and behavior cannot move). Per-pane state is stride 5 in one Float64Array:
// [count, sum, kcomp, min, max]. Hot: count += 1; a branch-free Kahan compensated sum
// (y = v - c; t = s + y; c = (t - s) - y; s = t); min / max by < / >. A query merges the
// LIVE, NON-EMPTY panes (paneEnd > now - w) with Neumaier over the terms {s_p, -c_p}, so
// the covered span [w, w + W/B] always CONTAINS the true window (the straddling oldest
// pane is KEPT). count / min / max are bit-exact; the sum error is bounded by
// |sum - exact| <= (4u + O(N u^2)) * sum|v|, u = 2^-53 (ADR 0012). A cleared pane holds
// the IDENTITY sentinels count 0, sum 0, kcomp 0, min +Infinity, max -Infinity (never
// fill(0) over the stride), and every merge skips count === 0; a covered count of 0
// returns NaN from mean / min / max (null is not zero) and 0 from count / sum.
//
// Time model: EXPLICIT (a monotone `now`) or COUNT mode (add(undefined, v)); the mode
// locks at the first add and a switch throws. addFrom / advance / advanceFrom are
// EXPLICIT-only (ADR 0009). The rotate / anchor helpers take NO argument and read
// this._now (the zero-box law -- no epoch-ms double crosses a non-inlined call). value
// is REQUIRED (no default of 1); a finite real with |value| <= 1e150 (SA_X_MAX). The
// SIXTH additive post-1.0 member: a PURE APPEND -- the nine prior classes stay
// BYTE-IDENTICAL; only this append plus (per /release) the header + VERSION change.

/** Frozen marker of the known SlidingAggregate ctor option keys -- an unknown key is a throw. */
const SA_KNOWN_OPTS = Object.freeze(Object.assign(Object.create(null), { panes: true }));
/** Default pane count B (the ring holds B+1 panes; edge error is W / panes). */
const SA_DEFAULT_PANES = 32;
/** Smallest pane count B (a 2-pane ring still keeps a straddling oldest pane). */
const SA_PANES_MIN = 2;
/** Largest pane count B (bytes = (B+1)*48; at 1024 -> 49,200 B, the memory ceiling). */
const SA_PANES_MAX = 1024;
/** Per-pane stride in the Float64 store: [count, sum, kcomp, min, max]. */
const SA_STRIDE = 5;
/**
 * SA_X_MAX -- the value magnitude cap (the same cap as DD_X_MAX). |value| <= 1e150 keeps
 * |sum| <= n * 1e150 finite for any physically reachable n and every Kahan / Neumaier
 * intermediate finite. Without it two adds of 1e308 would poison a pane to Infinity / NaN
 * silently until it rotated out (fail-open). An over-cap value throws, a byte-identical no-op.
 */
const SA_X_MAX = 1e150;
/**
 * SA_MIN_NORMAL -- the smallest NORMAL double (2^-1022). W / panes must land here or above: a SUBNORMAL
 * pane width has fewer than 52 significand bits, so the grid line (k+1)*pw no longer round-trips and
 * (B+1)*pw can fall BELOW W -- the ring then under-covers the true window (fail-open, QA190 F3). The
 * ctor rejects a subnormal pane width fail-closed BEFORE any allocation.
 */
const SA_MIN_NORMAL = 2.2250738585072014e-308;
/**
 * SA_CLOCK_SPAN -- the clock-precision domain (2^42). The pane grid is EXACT only while ulp(now) is far
 * below the pane width: at |now| = pw * 2^42, ulp(now) <= pw * 2^-10, so a grid line resolves to <=
 * pw/1024 and (floor(now/pw)+1)*pw still CONTAINS the true window. Past it the double clock cannot
 * represent the grid (QA190 F1/F2: the window collapses or under-covers, fail-open). add / addFrom /
 * advance / advanceFrom reject |now| > pw * 2^42 fail-closed BEFORE any state write; count mode applies
 * the same bound to its integer tick. Precomputed once per instance as this._nowMax = pw * 2^42.
 */
const SA_CLOCK_SPAN = 4398046511104;   // 2^42

/**
 * SlidingAggregate -- EXACT windowed count / sum / mean / min / max over the COVERED span
 * [w, w + W/B] (which always CONTAINS the last w) in
 * FIXED preallocated space (ADR 0012). A ring of B+1 panes of width W/B (the SlidingCountMin
 * ring, copied), each a stride-5 slot [count, sum, kcomp, min, max]. add(now, value) folds the
 * value into the current pane (count += 1, branch-free Kahan sum, min / max by comparison);
 * crossing a pane boundary rotates to the next pane and clears it to identity sentinels (0 B/op,
 * a bounded while-loop capped at B+1). A reader merges the live, non-empty panes with Neumaier.
 *
 * Guarantee over the covered span [w, w + W/B] (the straddling oldest pane is KEPT), u = 2^-53:
 *   - count, min and max are bit-exact (the sign of a zero extreme is unspecified);
 *   - |sum - exact| <= (4u + O(N u^2)) * sum|v|; mean = sum / count (one more rounding).
 *
 * Time model: EXPLICIT (monotone `now`) or COUNT (add(undefined, value)); the mode locks at the
 * first add and a switch throws. addFrom / advance / advanceFrom are EXPLICIT-only. The rotate /
 * anchor helpers take NO argument (read this._now) -- the zero-box law.
 *
 * Precision domain (ADR 0012): exact containment needs the double clock to RESOLVE the pane grid,
 * i.e. ulp(now) << pw. Two rules enforce it fail-closed. (1) W / panes must be a NORMAL double: a
 * subnormal pane width loses significand bits, so (B+1)*pw can fall below W and the ring under-covers
 * -- the ctor throws. (2) |now| (and the count-mode tick) must be <= pw * 2^42 (SA_CLOCK_SPAN); at
 * the bound ulp(now) <= pw * 2^-10, so the grid line (floor(now/pw)+1)*pw still CONTAINS the true
 * window. add / addFrom / advance / advanceFrom reject a larger clock BEFORE any state write (rebase
 * the clock, e.g. performance.now(), or use a larger W).
 *
 * Fail closed: a bad W / panes / option, or a subnormal W / panes, throws [lite-adaptive] at the ctor
 * door BEFORE any allocation; add rejects a non-number / NaN / +-Infinity / over-cap value, a mode
 * switch, a non-finite / decreasing `now`, or a `now` outside the clock-precision domain -- value-first,
 * a BYTE-IDENTICAL no-op (all validation precedes any state write); the readers never throw. null is
 * not zero.
 */
export class SlidingAggregate {
    /**
     * @param {number} W the window size; a finite number > 0.
     * @param {{panes?: number}} [options] panes = B, an integer in [2, 1024] (default 32).
     */
    constructor(W, options) {
        // 1. W: a finite number > 0, BEFORE any allocation or option read.
        if (typeof W !== 'number' || !(W > 0) || !Number.isFinite(W)) {
            throw new RangeError(
                '[lite-adaptive] SlidingAggregate W must be a finite number > 0, got ' + describeArg(W));
        }
        // 2. the shared cold option door (R6), with the class label.
        optDoor(options, SA_KNOWN_OPTS, 'SlidingAggregate');
        // 3. panes: an integer in [2, 1024].
        const panes = (options !== undefined && options.panes !== undefined) ? options.panes : SA_DEFAULT_PANES;
        if (typeof panes !== 'number' || !Number.isInteger(panes) || panes < SA_PANES_MIN || panes > SA_PANES_MAX) {
            throw new RangeError(
                '[lite-adaptive] SlidingAggregate panes must be an integer in [2, 1024], got ' + describeArg(panes));
        }
        // 4. W / panes must stay a finite positive pane width (a subnormal W underflows to 0 -> no
        //    pane ever live; fail closed BEFORE alloc rather than fail open on a NaN grid).
        const paneW = W / panes;
        if (!(paneW > 0) || !Number.isFinite(paneW)) {
            throw new RangeError(
                '[lite-adaptive] SlidingAggregate W is too small for panes=' + panes +
                ' (W / panes underflowed to ' + paneW + '); use a larger W or fewer panes');
        }
        // 5. the pane width must be a NORMAL double: a subnormal pw loses significand bits, so the grid
        //    line (k+1)*pw no longer round-trips and (B+1)*pw can fall below W -> under-cover (QA190 F3).
        //    Fail closed BEFORE alloc (the `!(>=)` form also rejects a NaN paneW, though step 4 caught it).
        if (!(paneW >= SA_MIN_NORMAL)) {
            throw new RangeError(
                '[lite-adaptive] SlidingAggregate W / panes (' + paneW + ') is subnormal; the pane grid ' +
                'cannot hold W exactly -- use a larger W or fewer panes');
        }

        this._W = W;
        this._panes = panes;         // B (getter returns this); the ring holds B+1 panes
        this._ring = panes + 1;      // B + 1
        this._paneW = paneW;         // per-pane time width (the disclosed edge error); guarded normal above
        this._nowMax = paneW * SA_CLOCK_SPAN;   // |now| clock-precision bound (pw * 2^42); one field compare on the hot path
        this._store = new Float64Array(this._ring * SA_STRIDE);   // (B+1) x [count, sum, kcomp, min, max]
        this._paneEnd = new Float64Array(this._ring);             // per-pane EXCLUSIVE upper time bound
        this._bytes = this._store.byteLength + this._paneEnd.byteLength;   // (B+1) * 48

        this._initState();
    }

    /** @private Reset all pane state + time mode to the empty window. Reused by clear(). 0 alloc. */
    _initState() {
        this._store.fill(0);
        this._paneEnd.fill(0);
        // Identity sentinels per pane: count / sum / kcomp already 0; min = +Infinity, max = -Infinity
        // (never fill(0) over the stride -- an all-positive window would then read min 0).
        const store = this._store, ring = this._ring;
        for (let p = 0; p < ring; p++) {
            const base = p * SA_STRIDE;
            store[base + 3] = Infinity;    // min identity
            store[base + 4] = -Infinity;   // max identity
        }
        this._cur = 0;               // current (newest) pane index in the ring
        this._mode = MODE_UNSET;     // time mode, locked at the first add
        this._tick = 0;              // count-mode logical clock
        this._lastNow = 0;           // explicit-mode monotone guard (init value never compared)
        this._now = 0;               // the last applied t (query cutoff = now - W)
    }

    /** Window size W. O(1). */
    get W() { return this._W; }
    /** The pane count B (edge error is W / panes; the ring holds B+1 panes). O(1). */
    get panes() { return this._panes; }
    /** The locked time mode: 'unset' | 'explicit' | 'count'. O(1). */
    get mode() {
        return this._mode === MODE_EXPLICIT ? 'explicit' : this._mode === MODE_COUNT ? 'count' : 'unset';
    }
    /** The last applied time t (0 before the first add). O(1). */
    get lastNow() { return this._now; }
    /** A fixed memory figure in bytes ((B+1) * 48: the stride store + paneEnd). O(1). */
    get bytes() { return this._bytes; }

    /**
     * Add one observation of `value` at `now`. HOT, 0 B/op INCLUDING pane rotation + clear.
     *
     * Time modes (LOCKED at the first add, a switch throws):
     *   - EXPLICIT: add(now, value). `now` a finite number, strictly NON-DECREASING across calls.
     *   - COUNT: add(undefined, value). The member auto-increments an internal tick per add.
     *
     * `value` is REQUIRED (no default): a finite real with |value| <= 1e150 (SA_X_MAX). A non-number,
     * NaN, +-Infinity or over-cap value throws [lite-adaptive] (value-first, a BYTE-IDENTICAL no-op).
     * `now` (and the count-mode tick) must be within the clock-precision domain, |now| <= pw * 2^42
     * (SA_CLOCK_SPAN); a larger clock throws [lite-adaptive] BEFORE any state write (rebase or use a larger W).
     * @param {number} [now]  the monotone time (omit for count mode).
     * @param {number} value  a finite real, |value| <= 1e150.
     * @returns {SlidingAggregate} this
     */
    add(now, value) {
        // 1. validate value FIRST (value-first), before ANY state mutation. The `!(<=&&>=)` form fails
        //    closed on NaN and +-Infinity by construction.
        if (typeof value !== 'number' || !(value <= SA_X_MAX && value >= -SA_X_MAX)) return this._badValue(value);
        // 2. resolve + lock the time mode (no mutation until every value + time check has passed).
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            if (now !== undefined) return this._badMode('count', 'explicit');
            t = this._tick + 1;
            if (!(t <= this._nowMax)) return this._badNowRange(t);   // tick past pw * 2^42 -> fail closed
            this._tick = t;
        } else if (mode === MODE_EXPLICIT) {
            if (now === undefined) return this._badMode('explicit', 'count');
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badNow(now);
            }
            if (now < this._lastNow) return this._badMonotone(now);
            if (!(now <= this._nowMax && now >= -this._nowMax)) return this._badNowRange(now);
            t = now;
            this._lastNow = now;
        } else {
            if (now === undefined) {
                t = this._tick + 1;
                if (!(t <= this._nowMax)) return this._badNowRange(t);
                this._mode = MODE_COUNT;
                this._tick = t;
                this._now = t;
                this._anchor();
            } else {
                if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                    return this._badNow(now);
                }
                if (!(now <= this._nowMax && now >= -this._nowMax)) return this._badNowRange(now);
                this._mode = MODE_EXPLICIT;
                t = now;
                this._lastNow = now;
                this._now = t;
                this._anchor();
            }
        }
        this._now = t;
        // 3. rotate + clear panes if this t crossed the current pane boundary (bounded, 0-alloc).
        if (t >= this._paneEnd[this._cur]) this._advance();
        // 4. fold the value into the current pane's stride slot: count, branch-free Kahan sum, min, max.
        const base = this._cur * SA_STRIDE, store = this._store;
        store[base] += 1;
        const s = store[base + 1], c = store[base + 2];
        const y = value - c;
        const tt = s + y;
        store[base + 2] = (tt - s) - y;
        store[base + 1] = tt;
        if (value < store[base + 3]) store[base + 3] = value;   // min (identity +Infinity; ties keep first)
        if (value > store[base + 4]) store[base + 4] = value;   // max (identity -Infinity; ties keep first)
        return this;
    }

    /**
     * Add from a caller-owned PACKED stride-2 `[now, value]` Float64Array entry. HOT, 0 B/op -- the
     * ZERO-BOX entry: `now = buf[i]`, `value = buf[i+1]` are read UNBOXED, avoiding the ~16 B HeapNumber
     * each would box as a plain argument at a non-inlined call boundary. EXPLICIT-time ONLY (addFrom
     * always carries a `now`): a COUNT-locked instance rejects it and the first addFrom locks EXPLICIT.
     * Identical validation, throws, byte-identical-no-op-on-reject and stride writes as add(now, value);
     * the body is DUPLICATED (not delegated) to keep add's hot body byte-identical.
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = now, `buf[i+1]` = value.
     * @param {number} i the base index of the [now, value] pair (0, 2, 4, ...).
     * @returns {SlidingAggregate} this
     */
    addFrom(buf, i) {
        // Guard the buffer + index on the COLD branch first (a bad handle is a byte-identical no-op).
        // ArrayBuffer.isView rejects a Proxy that forwards instanceof; the bound is NaN-safe (!(i+1<len)).
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i + 1 < buf.length)) return this._badBuf(buf, i);
        const now = buf[i];         // UNBOXED Float64Array reads -- the whole point (no argument box).
        const value = buf[i + 1];   // packed [now, value]
        // 1. validate value FIRST (a Float64Array read is always a number, so no typeof branch).
        if (!(value <= SA_X_MAX && value >= -SA_X_MAX)) return this._badValue(value);
        // 2. addFrom is an EXPLICIT-time entry: reject a count-locked instance, else lock/verify EXPLICIT.
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (now !== now || now === Infinity || now === -Infinity) return this._badNow(now);
            if (now < this._lastNow) return this._badMonotone(now);
            if (!(now <= this._nowMax && now >= -this._nowMax)) return this._badNowRange(now);
            t = now;
            this._lastNow = now;
        } else {
            if (now !== now || now === Infinity || now === -Infinity) return this._badNow(now);
            if (!(now <= this._nowMax && now >= -this._nowMax)) return this._badNowRange(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
            this._now = t;
            this._anchor();
        }
        this._now = t;
        // 3. rotate + clear panes if this t crossed the current pane boundary (bounded, 0-alloc).
        if (t >= this._paneEnd[this._cur]) this._advance();
        // 4. fold the value into the current pane (DUPLICATED from add()).
        const base = this._cur * SA_STRIDE, store = this._store;
        store[base] += 1;
        const s = store[base + 1], c = store[base + 2];
        const y = value - c;
        const tt = s + y;
        store[base + 2] = (tt - s) - y;
        store[base + 1] = tt;
        if (value < store[base + 3]) store[base + 3] = value;
        if (value > store[base + 4]) store[base + 4] = value;
        return this;
    }

    /**
     * Advance the window's reference time to `now` WITHOUT adding a value (the R11 idle slide). It moves
     * `_now` forward and runs the SAME bounded pane rotate-and-clear an add would (the private `_advance`),
     * so an idle stream still rotates stale panes out and the readers keep sliding to empty with no traffic.
     * EXPLICIT-time ONLY (parity with addFrom): a COUNT-locked instance throws; an UNSET instance locks
     * EXPLICIT (and anchors the pane ring around `now`). Monotone: `now` finite and >= lastNow. A rejected
     * advance is a BYTE-IDENTICAL no-op. Bounded (<= B+1 clears), 0 B/op.
     * @param {number} now the monotone time (finite, >= the last now).
     * @returns {SlidingAggregate} this
     */
    advance(now) {
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badAdvanceMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badAdvanceNow(now);
            }
            if (now < this._lastNow) return this._badAdvanceMonotone(now);
            if (!(now <= this._nowMax && now >= -this._nowMax)) return this._badNowRange(now);
            t = now;
            this._lastNow = now;
        } else {
            if (typeof now !== 'number' || now !== now || now === Infinity || now === -Infinity) {
                return this._badAdvanceNow(now);
            }
            if (!(now <= this._nowMax && now >= -this._nowMax)) return this._badNowRange(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
            this._now = t;
            this._anchor();
        }
        this._now = t;
        if (t >= this._paneEnd[this._cur]) this._advance();   // rotate + clear stale panes (bounded).
        return this;
    }

    /**
     * Advance the window's reference time from a caller-owned Float64Array (`now = buf[i]`, read UNBOXED).
     * The ZERO-BOX sibling of advance(now) -- identical mode / monotone / rotate body, EXPLICIT-time only.
     * Fail closed BEFORE any read (typeof-first): a non-Float64Array `buf`, or a non-integer / negative /
     * out-of-range `i` (needs `i < buf.length`) throws [lite-adaptive].
     * @param {Float64Array} buf a caller-owned Float64Array; `buf[i]` = now.
     * @param {number} i the index of the `now` scalar.
     * @returns {SlidingAggregate} this
     */
    advanceFrom(buf, i) {
        // ArrayBuffer.isView rejects a Proxy that forwards instanceof; the bound is NaN-safe (!(i<len)).
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' ||
            !Number.isInteger(i) || i < 0 || !(i < buf.length)) return this._badAdvanceBuf(buf, i);
        const now = buf[i];   // UNBOXED Float64Array read (always a number -> no typeof branch).
        let t;
        const mode = this._mode;
        if (mode === MODE_COUNT) {
            return this._badAdvanceMode('count', 'explicit');
        } else if (mode === MODE_EXPLICIT) {
            if (now !== now || now === Infinity || now === -Infinity) return this._badAdvanceNow(now);
            if (now < this._lastNow) return this._badAdvanceMonotone(now);
            if (!(now <= this._nowMax && now >= -this._nowMax)) return this._badNowRange(now);
            t = now;
            this._lastNow = now;
        } else {
            if (now !== now || now === Infinity || now === -Infinity) return this._badAdvanceNow(now);
            if (!(now <= this._nowMax && now >= -this._nowMax)) return this._badNowRange(now);
            this._mode = MODE_EXPLICIT;
            t = now;
            this._lastNow = now;
            this._now = t;
            this._anchor();
        }
        this._now = t;
        if (t >= this._paneEnd[this._cur]) this._advance();
        return this;
    }

    /** Reset to the empty window; reuse every array (also unlocks the mode). 0 alloc. @returns {SlidingAggregate} this */
    clear() {
        this._initState();
        return this;
    }

    /**
     * The EXACT number of observations over the COVERED span [w, w + W/B] (which always CONTAINS the
     * last w; the default is the full window W). COLD, O(B+1); NEVER throws. Summed over the LIVE panes
     * (paneEnd > now - effW, the straddling oldest pane included), skipping empty (count === 0) panes. A
     * bad `w` (non-number / NaN / +-Infinity / <= 0 / > W) returns NaN, checked BEFORE the empty return;
     * unset or a covered count of 0 returns 0 (the empty count is exactly 0). null is not zero. Boxes its
     * return once at a monomorphic / polymorphic site (up to 16 B/call; up to 32 B at a megamorphic site
     * -- use into() on a render path).
     * @param {number} [w] an optional sub-window in (0, W] (omit for the full window W).
     * @returns {number}
     */
    count(w) {
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) return NaN;
            effW = w;
        }
        const B = this._ring, store = this._store, paneEnd = this._paneEnd;
        const cut = this._now - effW;
        let count = 0;
        for (let p = 0; p < B; p++) {
            if (!(paneEnd[p] > cut)) continue;
            const pc = store[p * SA_STRIDE];
            if (pc === 0) continue;
            count += pc;
        }
        return count;
    }

    /**
     * The windowed SUM over the covered window, Neumaier-merged over the live, non-empty panes' terms
     * {s_p, -c_p} (each pane carries a Kahan-compensated (sum, kcomp)). COLD, O(B+1); NEVER throws.
     * |sum - exact| <= (4u + O(N u^2)) * sum|v|, u = 2^-53. A bad `w` returns NaN (before the empty
     * return); unset or a covered count of 0 returns 0 (the empty sum is exactly 0). Boxes once (up to
     * 16 B/call; up to 32 B at a megamorphic site).
     * @param {number} [w] an optional sub-window in (0, W].
     * @returns {number}
     */
    sum(w) {
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) return NaN;
            effW = w;
        }
        const B = this._ring, store = this._store, paneEnd = this._paneEnd;
        const cut = this._now - effW;
        let s = 0, c = 0;
        for (let p = 0; p < B; p++) {
            if (!(paneEnd[p] > cut)) continue;
            const base = p * SA_STRIDE;
            if (store[base] === 0) continue;
            let t1 = store[base + 1], y = s + t1;             // Neumaier add of s_p
            if (Math.abs(s) >= Math.abs(t1)) c += (s - y) + t1; else c += (t1 - y) + s;
            s = y;
            t1 = -store[base + 2]; y = s + t1;                // Neumaier add of -c_p
            if (Math.abs(s) >= Math.abs(t1)) c += (s - y) + t1; else c += (t1 - y) + s;
            s = y;
        }
        return s + c;
    }

    /**
     * The windowed MEAN = sum / count over the covered window (one more rounding on top of sum's bound).
     * COLD, O(B+1); NEVER throws. A bad `w` returns NaN; unset or a covered count of 0 returns NaN
     * (the mean of nothing is undefined -- null is not zero). Boxes once (up to 16 B/call; up to 32 B at
     * a megamorphic site).
     * @param {number} [w] an optional sub-window in (0, W].
     * @returns {number}
     */
    mean(w) {
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) return NaN;
            effW = w;
        }
        const B = this._ring, store = this._store, paneEnd = this._paneEnd;
        const cut = this._now - effW;
        let count = 0, s = 0, c = 0;
        for (let p = 0; p < B; p++) {
            if (!(paneEnd[p] > cut)) continue;
            const base = p * SA_STRIDE;
            const pc = store[base];
            if (pc === 0) continue;
            count += pc;
            let t1 = store[base + 1], y = s + t1;
            if (Math.abs(s) >= Math.abs(t1)) c += (s - y) + t1; else c += (t1 - y) + s;
            s = y;
            t1 = -store[base + 2]; y = s + t1;
            if (Math.abs(s) >= Math.abs(t1)) c += (s - y) + t1; else c += (t1 - y) + s;
            s = y;
        }
        return count === 0 ? NaN : (s + c) / count;
    }

    /**
     * The windowed MIN over the covered window (bit-exact; the sign of a zero extreme is unspecified). COLD,
     * O(B+1); NEVER throws. A bad `w` returns NaN; unset or a covered count of 0 returns NaN. Boxes once
     * (up to 16 B/call; up to 32 B at a megamorphic site).
     * @param {number} [w] an optional sub-window in (0, W].
     * @returns {number}
     */
    min(w) {
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) return NaN;
            effW = w;
        }
        const B = this._ring, store = this._store, paneEnd = this._paneEnd;
        const cut = this._now - effW;
        let count = 0, mn = Infinity;
        for (let p = 0; p < B; p++) {
            if (!(paneEnd[p] > cut)) continue;
            const base = p * SA_STRIDE;
            if (store[base] === 0) continue;
            count += store[base];
            const pmn = store[base + 3];
            if (pmn < mn) mn = pmn;
        }
        return count === 0 ? NaN : mn;
    }

    /**
     * The windowed MAX over the covered window (bit-exact; the sign of a zero extreme is unspecified). COLD,
     * O(B+1); NEVER throws. A bad `w` returns NaN; unset or a covered count of 0 returns NaN. Boxes once
     * (up to 16 B/call; up to 32 B at a megamorphic site).
     * @param {number} [w] an optional sub-window in (0, W].
     * @returns {number}
     */
    max(w) {
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) return NaN;
            effW = w;
        }
        const B = this._ring, store = this._store, paneEnd = this._paneEnd;
        const cut = this._now - effW;
        let count = 0, mx = -Infinity;
        for (let p = 0; p < B; p++) {
            if (!(paneEnd[p] > cut)) continue;
            const base = p * SA_STRIDE;
            if (store[base] === 0) continue;
            count += store[base];
            const pmx = store[base + 4];
            if (pmx > mx) mx = pmx;
        }
        return count === 0 ? NaN : mx;
    }

    /**
     * Batch reader: write [count, sum, mean, min, max] over the covered window into a caller-owned
     * Float64Array -- the render-loop sibling of the scalar readers (no computed double is RETURNED). It
     * is 0 B/call at a monomorphic / polymorphic site (<= 4 receiver shapes); at a MEGAMORPHIC site (5+
     * SlidingAggregate subclass shapes) the `this._now` clock-field read boxes, measured 16 B/call for
     * into (32 B for the scalar readers) -- a family-wide V8 property, logged for 1.10.0. Merges the live,
     * non-empty panes into LOCALS (count + a Neumaier
     * (s, c) + min + max) and writes out[0..4] only at the very end. Returns 5 (the slot count, a Smi).
     *
     * Fail closed BEFORE any read (typeof-first): a non-Float64Array `out` -> TypeError; out.length < 5
     * -> RangeError. A bad `w` writes 5 NaN slots (checked BEFORE the empty return, parity with the
     * scalar readers). Unset or a covered count of 0 writes count 0, sum 0, mean / min / max NaN.
     * @param {Float64Array} out a caller-owned Float64Array, out.length >= 5.
     * @param {number} [w] an optional sub-window in (0, W].
     * @returns {number} 5
     */
    into(out, w) {
        // ArrayBuffer.isView rejects a Proxy that forwards instanceof; the length check is NaN-safe.
        if (!(ArrayBuffer.isView(out) && out instanceof Float64Array)) {
            throw new TypeError(
                '[lite-adaptive] SlidingAggregate.into(out, w?) out must be a Float64Array, got ' + describeArg(out));
        }
        const outN = TA_LEN.call(out);       // H34: intrinsic length, read ONCE; the message uses this local, never re-reads out.length
        if (!(outN >= 5)) {
            throw new RangeError(
                '[lite-adaptive] SlidingAggregate.into out.length (' + outN + ') must be >= 5');
        }
        let effW = this._W;
        if (w !== undefined) {
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w <= 0 || w > this._W) {
                out[0] = NaN; out[1] = NaN; out[2] = NaN; out[3] = NaN; out[4] = NaN;
                return 5;
            }
            effW = w;
        }
        const B = this._ring, store = this._store, paneEnd = this._paneEnd;
        const cut = this._now - effW;
        let count = 0, s = 0, c = 0, mn = Infinity, mx = -Infinity;
        for (let p = 0; p < B; p++) {
            if (!(paneEnd[p] > cut)) continue;
            const base = p * SA_STRIDE;
            const pc = store[base];
            if (pc === 0) continue;
            count += pc;
            let t1 = store[base + 1], y = s + t1;             // Neumaier add of s_p
            if (Math.abs(s) >= Math.abs(t1)) c += (s - y) + t1; else c += (t1 - y) + s;
            s = y;
            t1 = -store[base + 2]; y = s + t1;                // Neumaier add of -c_p
            if (Math.abs(s) >= Math.abs(t1)) c += (s - y) + t1; else c += (t1 - y) + s;
            s = y;
            const pmn = store[base + 3];
            if (pmn < mn) mn = pmn;
            const pmx = store[base + 4];
            if (pmx > mx) mx = pmx;
        }
        if (count === 0) {
            out[0] = 0; out[1] = 0; out[2] = NaN; out[3] = NaN; out[4] = NaN;
            return 5;
        }
        const sum = s + c;
        out[0] = count;
        out[1] = sum;
        out[2] = sum / count;
        out[3] = mn;
        out[4] = mx;
        return 5;
    }

    /**
     * @private Anchor the pane ring around the first `now` (this._now; grid-aligned to W/panes -- ABSOLUTE
     * alignment). The current pane (index 0) covers the grid cell containing `now`; predecessors go backward
     * by one pane width each. Argument-free (reads this._now, the zero-box law). Cold, 0 alloc.
     */
    _anchor() {
        const B = this._ring, pw = this._paneW, now = this._now;
        const E = (Math.floor(now / pw) + 1) * pw;   // EXCLUSIVE upper bound of the current pane
        this._cur = 0;
        this._paneEnd[0] = E;
        let e = E, idx = 0;
        for (let s = 1; s < B; s++) { idx--; if (idx < 0) idx = B - 1; e -= pw; this._paneEnd[idx] = e; }
    }

    /**
     * @private Rotate the ring forward so the current pane covers this._now, clearing each pane it rotates
     * onto (to identity sentinels). Capped at B+1 rotations (a now-jump of k panes clears min(k, B+1) panes,
     * NEVER loops k -- skipping >= B+1 panes clears them ALL, then re-anchors around this._now). Argument-free
     * (reads this._now, the zero-box law). 0 alloc. Called only when this._now crossed the current boundary.
     */
    _advance() {
        const pw = this._paneW, B = this._ring, t = this._now;
        let cur = this._cur;
        // Grid index of the current pane end (E = k*pw exactly for an integer k in the legal clock
        // domain, |now| <= pw * 2^42, where ulp(E) <= pw * 2^-10 so the division round-trips). Each new
        // pane end is (k+1)*pw by MULTIPLICATION -- drift-free and bit-identical to the anchor / oracle's
        // (floor(t/pw)+1)*pw -- rather than an accumulating `E += pw`, whose per-step rounding drifts by
        // up to ~pw near the domain edge and can drop a live pane (QA190 F2, fail-open).
        let k = Math.round(this._paneEnd[cur] / pw);
        let E = this._paneEnd[cur];
        let rot = 0;
        while (t >= E && rot < B) {
            cur++; if (cur === B) cur = 0;
            this._clearPane(cur);
            k += 1;
            E = k * pw;
            this._paneEnd[cur] = E;
            rot++;
        }
        if (t >= E) {
            // jumped >= B+1 pane widths: every pane cleared above -> grid-re-anchor around t.
            const newE = (Math.floor(t / pw) + 1) * pw;
            this._paneEnd[cur] = newE;
            let e = newE, idx = cur;
            for (let s = 1; s < B; s++) { idx--; if (idx < 0) idx = B - 1; e -= pw; this._paneEnd[idx] = e; }
        }
        this._cur = cur;
    }

    /** @private Clear one pane's stride-5 slot to the identity sentinels (count/sum/kcomp 0, min +Inf, max -Inf). 0 alloc. */
    _clearPane(p) {
        const base = p * SA_STRIDE, store = this._store;
        store[base] = 0;             // count
        store[base + 1] = 0;         // sum
        store[base + 2] = 0;         // kcomp (Kahan compensation)
        store[base + 3] = Infinity;  // min identity
        store[base + 4] = -Infinity; // max identity
    }

    /** @private Cold thrower for a bad value (non-number / NaN / +-Infinity / over-cap). */
    _badValue(v) {
        throw new TypeError(
            '[lite-adaptive] SlidingAggregate add value must be a finite number with |value| <= 1e150, got ' + describeArg(v));
    }

    /** @private Cold thrower for a mode switch after the mode locked. */
    _badMode(locked, attempted) {
        throw new TypeError(
            '[lite-adaptive] SlidingAggregate mode is locked to ' + locked +
            ' at the first add; got a ' + attempted + '-mode add');
    }

    /** @private Cold thrower for a non-finite `now`. */
    _badNow(now) {
        throw new TypeError(
            '[lite-adaptive] SlidingAggregate add now must be a finite number, got ' + describeArg(now));
    }

    /** @private Cold thrower for a non-monotone `now`. */
    _badMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] SlidingAggregate add now must be non-decreasing: got ' + describeArg(now) +
            ' after ' + describeArg(this._lastNow));
    }

    /**
     * @private Cold thrower for a `now` (or count-mode tick) outside the clock-precision domain
     * (|now| > pw * 2^42). Fail closed BEFORE any state write -- past this bound the double clock cannot
     * represent the pane grid, so the covered span would silently under-cover the true window (QA190 F1/F2).
     */
    _badNowRange(now) {
        throw new RangeError(
            '[lite-adaptive] SlidingAggregate now (' + describeArg(now) + ') is too large for the pane width (' +
            this._paneW + '); |now| must be <= pw * 2^42 (' + this._nowMax +
            ')' + (this._mode === MODE_COUNT ? ', including the count-mode tick,' : '') +
            ' -- rebase the clock (e.g. performance.now()) or use a larger W');
    }

    /** @private Cold thrower for a bad addFrom buffer/index. */
    _badBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] SlidingAggregate.addFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i + 1 < buf.length, got ' + describeArg(buf) + ', ' + describeArg(i));
    }

    /** @private Cold thrower for an advance mode switch (advance is EXPLICIT-only). */
    _badAdvanceMode(locked, attempted) {
        throw new TypeError(
            '[lite-adaptive] SlidingAggregate mode is locked to ' + locked +
            '; advance() is an ' + attempted + '-time op');
    }

    /** @private Cold thrower for a non-finite advance `now`. */
    _badAdvanceNow(now) {
        throw new TypeError(
            '[lite-adaptive] SlidingAggregate advance now must be a finite number, got ' + describeArg(now));
    }

    /** @private Cold thrower for a non-monotone advance `now`. */
    _badAdvanceMonotone(now) {
        throw new RangeError(
            '[lite-adaptive] SlidingAggregate advance now must be non-decreasing: got ' + describeArg(now) +
            ' after ' + describeArg(this._lastNow));
    }

    /** @private Cold thrower for a bad advanceFrom buffer/index. */
    _badAdvanceBuf(buf, i) {
        throw new TypeError(
            '[lite-adaptive] SlidingAggregate.advanceFrom(buf, i) needs a Float64Array and an in-bounds ' +
            'integer index with i < buf.length, got ' + describeArg(buf) + ', ' + describeArg(i));
    }
}
