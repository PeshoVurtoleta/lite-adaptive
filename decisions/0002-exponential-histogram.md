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

5. **The error bound (HARD, `<= epsilon`).** Only the oldest straddling bucket is
   uncertain; its population is `2^Lmax`, and estimating half of it costs at most
   `2^Lmax / 2 - 1` in count mode (the straddling bucket has between 1 and
   `2^Lmax - 1` in-window elements). Because the lower levels each hold `>= k-1`
   buckets, the window's true count is `>= (k-1) * (2^Lmax - 1)`, so the relative
   error is `~ 1/(2k) < epsilon`. Measured error tracks `1/(2k)` and stays under
   `epsilon` on EVERY query across the `W in {64, 1000, 65536} x epsilon in
   {0.5, 0.1, 0.01}` sweep (`test/witness.mjs`); a broken EH that omits the
   straddle correction is REJECTED by the same gate (the negative control).

6. **Fail closed.** A bad `W` / `epsilon` / unknown option throws `[lite-adaptive]`
   at the ctor door BEFORE any allocation. `add` locks the mode at the first call
   and rejects a mode switch, a non-finite / decreasing `now`, or a non-positive
   value -- typeof-first, a BYTE-IDENTICAL no-op (nothing is opened on a rejected
   add). `count` / `sum` / `query` / getters NEVER throw; an empty window is 0
   (null is not zero).

## Consequences

- Space: `O((1/epsilon) log(epsilon W))` buckets, a FIXED pool (ADR 0001) -- at
  W=65536, epsilon=0.01 that is 678 buckets (~24 KB) vs an exact ring's 512 KB.
- The recency TRIPLE is stated: SPACE (the fixed pool), ERROR (`<= epsilon`, hard),
  RECENCY MODEL (a HARD last-W window -- EH forgets EXACTLY at the edge, vs
  ForwardDecay's smooth decay or ADWIN's adaptive window).
- 0 B/op on `add` INCLUDING the merge cascade + expire, proven by
  `test/torture.mjs`; flat throughput by `test/perf/PerfGate.test.mjs`.
- The DGIM 0/1 count stream is `value = 1` (the default) -- no separate member.
- ADWIN (M2) will keep an EH-style bucket list over this same substrate and add the
  drift cut test; ExponentialHistogram is the base it builds on.
