# 0001 -- The time source + the fixed bucket-pool substrate (caller-supplied monotone now; SoA + free-list)

Status: accepted (v0.1.0)

## Context

lite-adaptive answers RECENCY questions -- "how many in the LAST W", "did the
stream drift", "what is the DECAYED rate". Every such member needs two things
before any of them can be written: a notion of "now", and a place to keep the
recent buckets. This is lite-adaptive's load-bearing decision -- the analog of
"which hash" for lite-sketch -- so it is settled before the reference member. It
gates every member (ExponentialHistogram now, ADWIN / ForwardDecay / HeavyKeeper
next), which all reuse this substrate.

Two hard constraints: the member must be DETERMINISTIC and TESTABLE (so it cannot
read the wall clock itself), and every hot op must allocate ZERO bytes INCLUDING
the amortized reshaping (bucket merge / expire), so the bucket store cannot be a
`Map` of objects or a growable array of `{ts, size}` records.

## The settled calls (user-accepted 2026-09-23)

1. **The time source is a caller-supplied MONOTONE `now`.** `add(now)` /
   `add(now, value)`: `now` is a finite number, strictly NON-DECREASING across
   calls (a decrease throws `[lite-adaptive]` fail-closed). The member NEVER reads
   the wall clock -- the caller owns time (a logical tick or ms), which keeps every
   witness reproducible. `now` may be a fractional ms; equal consecutive `now` is
   allowed (non-decreasing, not strictly increasing).
   - REJECTED: reading `Date.now()` / `performance.now()` internally (untestable,
     non-deterministic, and it couples the member to a clock the caller cannot
     control in a replay or a distributed shard).

2. **A COUNT-MODE convenience.** If the caller OMITS `now` (`add()` /
   `add(undefined, value)`), the member auto-increments an internal logical tick
   per add -- the "last N items" window, no clock needed.

3. **The MODE LOCKS at the first add.** The first `add` decides explicit-now vs
   count mode; a later switch throws `[lite-adaptive]` (fail closed). A histogram
   is one or the other for its life (until `clear()`, which unlocks it). Mixing a
   tick clock with caller timestamps would corrupt the window edge silently -- so
   it is a throw, never a silent reinterpretation.

4. **A FIXED bucket pool, preallocated, over a Struct-of-Arrays + a free-list.**
   Buckets live in parallel TypedArray columns indexed `0..CAP-1`:
   `Float64Array` for the bucket timestamp, its earliest-element time (to detect a
   straddle exactly), and its size (value sum); `Int32Array` for the per-level
   intrusive doubly-linked list (`next` / `prev`), the bucket level, and the
   free-list head. NO per-op objects, NO closures. `add` / merge / expire are pure
   index manipulations: a free-list pop opens a bucket, a merge reuses one slot and
   frees the other, expiry frees the globally-oldest. This is the lite-o1
   fixed-capacity, zero-GC discipline, carried onto the recency axis.
   - REJECTED: a `Map<time, bucket>` or an array of `{ts, size}` objects (both
     allocate per op and churn the heap on merge / expire).

5. **The pool is sized from a declared `maxCount` at construction and NEVER grows.**
   For ExponentialHistogram (ADR 0002, amended in 1.7.0) with `k = ceil(1/(2*epsilon))
   + 1` buckets per level, `levels = max(2, ceil(log2(maxCount/(k+1))) + 2)` and the
   pool holds `CAP = (k+1) * levels + 2` buckets: `(k+1)` per level covers the transient
   `(k+1)`-th bucket before its merge, and the `+2` covers the fresh level-0 bucket
   opened during a full cascade plus one slack slot. `maxCount` (default 2^32) is the
   window population the pool is GUARANTEED to hold (a floor; the exact ceiling is
   `k * (2^levels - 1)` elements, ~3-6x it); a time-based window holds as many items as the
   rate allows, so the population bound must be DECLARED, not inferred from `W`.

   An add whose merge cascade would pass the top level throws `_badOverflow`, a
   fail-closed `[lite-adaptive]` RangeError. As of 1.7.0 this is a BYTE-IDENTICAL no-op:
   the overflow is PRE-CHECKED before any state write. Because today's `add` expires
   (and advances `_now`) before inserting, the check `_wouldOverflow(t)` simulates the
   expiry sweep READ-ONLY and reports overflow iff every level would hold exactly `k`
   buckets post-expiry (the one configuration where the level-0 insert cascades past the
   top). The hot body pays only one integer compare (`_count >= _guard`, where
   `_guard = k * levels`): since pre-expiry `_count >= post-expiry total`, that compare
   is a necessary condition, and the O(levels) read-only scan runs only on the rare true
   branch. The free-list-exhaustion throw at the insert site is now unreachable (a
   defensive guard). The earlier "NOT byte-identical, overflow detected after mutation"
   exception no longer holds -- there is no state-mutating overflow path.

## Consequences

- Determinism: with a caller-supplied clock, the windowed witness is exactly
  reproducible and self-contained -- the recency error is a shipped, gated number.
- The SoA + free-list keeps `add` (open + merge cascade + expire) at 0 B/op, proven
  by `test/torture.mjs` over many pool wraps (gc major 0, arrayBuffers delta <= 0).
- Future members append below ExponentialHistogram and reuse this substrate by
  DESIGN-PARITY: ADWIN keeps an EH-style bucket list over the same pool shape;
  ForwardDecay keeps a landmark + O(1) accumulators; each changes only the header
  roster comment + `VERSION`.
