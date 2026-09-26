# 0002 -- ExponentialHistogram: the reference member (sliding-window count / sum, DGIM/EH)

Status: accepted (v0.1.0)

## Context

ExponentialHistogram (EH) is to lite-adaptive what HyperLogLog is to lite-sketch:
the reference member that defines the substrate (ADR 0001), the windowed witness,
and the recency-honesty contract. It answers the most foundational recency
question -- "how many / how much in the last W" -- in FIXED memory, where an exact
answer needs a ring of the whole window (O(W)). Datar-Gionis-Indyk-Motwani (SODA
2002); DGIM (Datar-Gionis-Indyk-Motwani / Gionis, the 0/1 count stream) is its
`value = 1` special case, NOT a separate member.

## The settled calls

1. **Buckets grouped by LEVEL; a level-L bucket holds exactly `2^L` elements (its
   POPULATION), with `size` = the sum of those elements' values.** `add(now)` /
   `add(now, value)` opens a level-0 bucket (population 1, size = value, default
   value 1). The level -- not the value -- drives the merge structure, so the
   population invariant `pop(level-L) = 2^L` holds for arbitrary positive values.

2. **Merge rule: `k = ceil(1/(2*epsilon)) + 1` buckets per level; when MORE THAN
   `k` share a level, merge the two OLDEST into one bucket of the next level.**
   The merged bucket's `size` is the sum of the two, its `timestamp` is the
   more-recent of the two (its newest element), its `start` is the older's earliest
   element, its population doubles (`2^L -> 2^(L+1)`). The cascade is bounded by the
   number of levels and amortized O(1). Each level below the top stays in
   `[k-1, k+1]` buckets, which is what bounds the error (below).

3. **Expire buckets whose timestamp fell out of `[now - W, now]`.** The globally
   OLDEST bucket is always the oldest bucket of the highest occupied level (higher
   levels are older, since they are built from older merges), so expiry sweeps from
   the top level down, freeing any bucket with `ts <= now - W`.

4. **query() = the sum of live bucket sizes minus HALF the oldest STRADDLING
   bucket.** The estimate subtracts half the oldest bucket ONLY when it genuinely
   straddles the window edge (`start <= now - W < ts`) -- a bucket fully inside the
   window (or any population-1 bucket) is counted in FULL. This is the crucial
   detail: it makes a not-yet-full window (and the whole ramp-up) EXACT, and caps
   the error on every query. `count()` uses population (`sum lcount[L] * 2^L`, an
   O(levels) read); `sum()` walks the buckets for the value sum (O(buckets)).
   Both are COLD -- a disclosed co-headline, NOT a per-add cost. `query()` aliases
   `count()`.

5. **The error bound (COUNT: HARD, `<= epsilon`; SUM: half a bucket, F17-amended).**
   Only the oldest straddling bucket is uncertain; its population is `2^Lmax`, and
   estimating half of it costs at most `2^Lmax / 2 - 1` in count mode (the straddling
   bucket has between 1 and `2^Lmax - 1` in-window elements). Because the lower levels
   each hold `>= k-1` buckets, the window's true count is `>= (k-1) * (2^Lmax - 1)`, so
   the COUNT relative error is `~ 1/(2k) < epsilon`. Measured count error tracks `1/(2k)`
   and stays under `epsilon` on EVERY query across the `W in {64, 1000, 65536} x epsilon
   in {0.5, 0.1, 0.01}` sweep (`test/witness.mjs`); a broken EH that omits the straddle
   correction is REJECTED by the same gate (the negative control).

   The SUM bound is WEAKER and is stated honestly (amended in 1.7.0, F17): levels are
   sized by POPULATION, not value mass, so the straddling bucket's `size` (its value sum)
   is unbounded relative to the window sum. The `sum()` error is bounded ABSOLUTELY by
   `size(oldest straddling bucket) / 2`, which is relative `<= epsilon` ONLY for count
   (value=1) or near-constant values. A heavy-tailed or spiky value distribution can push
   a large value into the straddling bucket and exceed epsilon (measured 15.8% on a heavy
   tail, ~2504% for a lone spike at eps .1). The witness gates the STATED absolute bound
   on 100% of queries over uniform / heavy-tail / spike streams and shows the old
   `sum <= epsilon` claim fail. For a relative sum bound, use `count()` or keep values
   near-constant.

6. **Fail closed.** A bad `W` / `epsilon` / unknown option throws `[lite-adaptive]`
   at the ctor door BEFORE any allocation. `add` locks the mode at the first call
   and rejects a mode switch, a non-finite / decreasing `now`, or a non-positive
   value -- typeof-first, a BYTE-IDENTICAL no-op (nothing is opened on a rejected
   add). `count` / `sum` / `query` / getters NEVER throw; an empty window is 0
   (null is not zero).

## Consequences

- Space: `O((1/epsilon) log maxCount)` buckets, a FIXED pool (ADR 0001) sized from
  `maxCount` (1.7.0) -- at epsilon=0.01 with the default maxCount=2^32 that is 1510
  buckets (~53 KB), independent of W, vs an exact ring's 512 KB at W=65536.
- The recency TRIPLE is stated: SPACE (the fixed pool), ERROR (`<= epsilon`, hard),
  RECENCY MODEL (a HARD last-W window -- EH forgets EXACTLY at the edge, vs
  ForwardDecay's smooth decay or ADWIN's adaptive window).
- 0 B/op on `add` INCLUDING the merge cascade + expire, proven by
  `test/torture.mjs`; flat throughput by `test/perf/PerfGate.test.mjs`.
- The DGIM 0/1 count stream is `value = 1` (the default) -- no separate member.
- ADWIN (M2) will keep an EH-style bucket list over this same substrate and add the
  drift cut test; ExponentialHistogram is the base it builds on.

## Amendment (1.7.0) -- S3 maxCount sizing + overflow pre-check (F1); F17 sum bound

Two hardening changes from the 1.6.0 final sweep (ROADMAP section 7; settle S3):

- **F1 -- the pool is sized from `maxCount`, not `W`.** The level count is bounded by the
  window POPULATION, not by `W`: a time-based window holds as many items as the rate
  allows. The 1.6.0 pool used `W` as the population proxy, so a dense explicit stream
  (e.g. `EH(1000, .01)` at 10 kHz) grew past the top level and wrote OUT OF BOUNDS on the
  typed columns -- silently orphaning buckets, so `count()` / `sum()` returned NaN. The
  fix declares the population: a `maxCount` ctor option (a positive integer `<= 2^53-1`,
  default 2^32; validated typeof-first before allocation, `null` is not a default) sizes
  `levels = max(2, ceil(log2(maxCount/(k+1))) + 2)`, `CAP = (k+1) * levels + 2`. The pool
  is allocated before the mode locks, so a COUNT-mode instance also gets the default
  sizing (pass `maxCount: W` to keep the pre-1.7.0 size). A flat 53-level pool was
  REJECTED (it charges every instance the physically unreachable worst case and hides the
  domain assumption). This is the one additive API in 1.7.0.

- **The overflow throw is BYTE-IDENTICAL (pre-checked).** An add whose cascade would pass
  the top level throws a tagged `[lite-adaptive]` RangeError naming `maxCount` and the
  capacity -- with NO state written. Because `add` expires (and advances `_now`) before
  inserting, the pre-check `_wouldOverflow(t)` simulates the expiry sweep READ-ONLY and
  reports overflow iff every level would hold exactly `k` buckets post-expiry. The hot
  body pays one integer compare (`_count >= _guard`, `_guard = k * levels`): since
  pre-expiry `_count >= post-expiry total`, that compare is a NECESSARY condition, so the
  O(levels) read-only scan runs only on the rare true branch. `_wouldOverflow` is a
  separate COLD method (no closures/literals on the hot path). The old free-list-exhaustion
  throw ("this is a bug") is now unreachable; a soundness test drives many random streams
  and asserts `_wouldOverflow` true iff the real cascade would pass the top (no false
  negatives, zero false positives measured).

- **F17 -- the sum bound is stated honestly** (see call 5, amended): `count()` keeps its
  hard `<= epsilon`; `sum()` is bounded absolutely by half the oldest straddling bucket's
  value-mass, relative `<= epsilon` only for count or near-constant values.
