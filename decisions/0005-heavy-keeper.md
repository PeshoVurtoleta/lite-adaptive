# 0005 -- HeavyKeeper: decayed / windowed heavy hitters, top-k (the skew member)

Status: accepted (v0.4.0)

## Context

HeavyKeeper (Gong-Yang-Chen-Miao-Li-Zhang-Uhlig, "HeavyKeeper: An Accurate
Algorithm for Finding Top-k Elephant Flows", USENIX ATC 2018) is the family's
SKEW / TOP-K member and the FOURTH and FINAL roster entry to 1.0.0. Where
ExponentialHistogram forgets at a HARD window edge, ADWIN at a DATA-DRIVEN
boundary, and ForwardDecay by SMOOTH decay of a scalar aggregate, HeavyKeeper
answers a different shape of question entirely: "which KEYS are the heaviest
RIGHT NOW?" over a skewed, evolving stream. Its recency model is PROBABILISTIC
DECAY of a per-key counter -- a key that stops arriving is gradually eroded by
other keys' misses, so the top-k tracks the current distribution.

It is a PURE APPEND onto the M1/M2/M3 chassis (ADR 0001-0004): the
ExponentialHistogram and ForwardDecay classes stay byte-identical, and ADWIN's
`add(x)` hot body stays byte-identical (ADWIN gains only an additive `addFrom`,
below). Only the file header roster comment + `VERSION` + the appended
`HeavyKeeper` class change.

## The algorithm

A d x w SoA table of two Uint32 columns (row-major, `cell(r,c) = r*w + c`):
`_fp` (fingerprints) and `_cnt` (counts). A key is hashed with the two-lane
MurmurHash3 mixer (copied INLINE from lite-sketch `Sketch.js`, ADR 0001 there --
design-parity, NEVER a dep) into a fingerprint `fp` (lane HK_H1) and a position
base (lane HK_H2); row `r`'s column is `hkFinal(base ^ r*ODD) % w`.

HOT `add(key, weight)`, per row r at cell `(r, col_r)`:
- (a) `count == 0` (empty): `fp = fpKey`, `count = weight`.
- (b) `fp == fpKey` (hit): `count += weight` (clamped at uint32 max).
- (c) `fp != fpKey` (miss): DECAY -- draw the seeded PRNG, and with probability
  `b^(-count)` do `count -= weight` clamped at 0, replacing `fp = fpKey` /
  `count = weight` when it reaches 0.

`estimate(key)` = the max `count` over the d cells whose `fp == fpKey` (0 if none).
After the table update the top-k min-forest is maintained (below).

## The settled calls

1. **Weighted-miss decay rule: decay ONCE with prob `b^(-count)`, then
   `count -= weight` (clamped).** lite-hud passes integer MICROSECONDS as the
   weight so it can rank keys by total time. The naive extension of classic
   HeavyKeeper (weight 1, decay once per miss) is to decay PER WEIGHT UNIT -- run
   the probabilistic decrement `weight` times. That is **REJECTED**: a weight of
   thousands of microseconds would mean thousands of PRNG draws per cell per add
   -- O(weight), not O(1), and it defeats the 0-alloc / flat-throughput claim
   (the draw loop's cost scales with the stream's magnitude, not its length).
   The SETTLED rule draws ONCE and applies the whole `weight` as a single
   decrement: O(1) per cell regardless of weight, 0-alloc, and it preserves the
   HeavyKeeper invariant that a heavy counter (high `count`) is almost never
   decayed (`b^(-count)` is astronomically small). Recorded here as the deliberate
   choice; the witness covers BOTH weighted and unit streams.

2. **PRNG: a seeded xorshift32, state kept as a SIGNED int32.** No `Math.random`
   (untestable, non-reproducible). The `seed` option seeds BOTH the hash and the
   PRNG; a `seed` getter exposes it. `seed = 0` is a VALID distinct seed -- the
   ctor guards `options.seed === undefined`, not falsy (null is not zero). Because
   xorshift32 is degenerate at state 0, the PRNG state is DERIVED from the seed via
   a nonzero-forcing mix (`hkFinal(seed ^ RNG_SALT) | 1`), so `seed = 0` yields a
   distinct, non-degenerate stream. The state is stored as a signed int32 (`| 0`)
   so the module never boxes a uint32 >= 2^31 into a field (the lite-sketch lane
   lesson). `clear()` resets the state to its seeded initial, so a cleared
   HeavyKeeper replays IDENTICALLY -- deterministic witness + demo.

3. **`b^(-count)` is a Float64Array LUT, 0-alloc.** The decay probability is a
   precomputed `lut[c] = b^(-c)` for `c` in `[0, 256)`. Above the LUT the
   probability is astronomically small (`1.08^(-256) ~= 3e-9`), so a heavy counter
   effectively never decays; the fallback for `c >= 256` is a plain `Math.pow`
   (0-alloc, and its result is ~0 so the branch is rarely taken). The comparison
   is `(rand >>> 0) / 2^32 < lut[count]` -- a uint32 local divided by a constant,
   no boxing, no per-op `Math.pow` on the common path.

4. **Key domain = SAFE INTEGER; fail-closed, typeof-first.** `add` / `addFrom`
   validate `key` is a `Number.isSafeInteger` and `weight` a positive integer
   BEFORE any state mutation -- a rejected add is a BYTE-IDENTICAL no-op. A
   consumer pre-checks the domain from the documented contract, never by catching
   an error and sniffing its class. `estimate` NEVER throws (a bad / unseen key
   reads 0); `forEach` / `topKInto` / getters never throw. Getters: `d`, `w`, `k`,
   `b`, `seed`, `bytes` (a fixed memory figure), `size` (the current forest count).

5. **ZERO-BOX entry from day one: `addFrom(buf, i)`.** `key = buf[i]`,
   `weight = buf[i+1]` read UNBOXED from a caller-owned Float64Array. A large u32
   tag id (near 2^31 or 2^32-1) boxes as a plain `add` argument (~16 B HeapNumber
   at the non-inlined call boundary); `addFrom` reads it straight from the array.
   The accumulate body is DUPLICATED (not delegated) to keep `add`'s hot body
   byte-identical and avoid re-boxing at an internal call boundary -- exactly as
   EH / ForwardDecay gained `addFrom` in 0.3.0.

6. **The top-k min-forest = an intrusive backshift map + a binary MIN-HEAP
   (design-parity with lite-o1 `FreqO1`).** The k current leaders live in a
   k-slot binary min-heap (`_hkKey` / `_hkEst`, root = the minimum estimate); an
   open-addressed linear-probing map with Knuth BACKWARD-SHIFT deletion
   (`_mapKey` NaN-sentinel / `_mapPos`, cap = a power of two >= 2k, load factor
   <= 0.5) maps a key to its heap slot. After each add: if the key is already a
   leader, update its estimate + re-heapify (siftUp then siftDown -- the estimate
   may rise on a hit or fall if another key decayed a cell it relied on); else if
   the heap has room, insert; else if the new estimate beats the current MINIMUM
   leader, evict the min and insert. Every step is index surgery on preallocated
   arrays -- 0 alloc, the FreqO1 intrusive idiom. A brand-new key with NO table
   representation this add (every row a no-decay miss -> estimate 0) is NOT
   inserted (it is not a leader).

7. **`withAccuracy(k, targetError)` derive.** Sets `d = 4` (the paper's
   small-depth sweet spot) and `w = max(2k, ceil(1/targetError))` so a cell
   absorbs at most ~ `targetError * N` of the stream. The explicit
   `new HeavyKeeper(d, w, k, options)` remains the primary constructor (d ~ 4-8).

8. **NO `merge`.** lite-hud does not rotate a HeavyKeeper (unlike its A/B rotation
   of sliding sketches), so `merge` is omitted from the frozen 1.0.0 surface. A
   fingerprint-table merge with faithful decayed-count reconciliation is a
   post-1.0 item if a consumer ever needs cross-shard top-k.

## Also: `ADWIN.addFrom(buf, i)` (additive)

ADWIN 0.2.0 shipped only `add(x)` with a fractional `x`, which BOXES at a
non-inlined call boundary. lite-hud M6 drift markers feed ADWIN HUD-computed
durations (fractional doubles). `addFrom(buf, i)` reads `x = buf[i]` UNBOXED
(ADWIN is item-indexed -- a single value, no `now`), validates it finite
(byte-identical no-op on reject), and runs the IDENTICAL `add(x)` logic INLINE
(the drift detection + cut-scan + drop-older shrink), returning the boolean drift
flag. `ADWIN.add(x)`'s hot body stays BYTE-IDENTICAL (the body is duplicated, not
delegated). It is additive but belongs in the frozen 1.0.0 surface (ROADMAP M4).

## Consequences

- The recall / overestimate / vs-Space-Saving witness (`test/witness.mjs`,
  HeavyKeeper mode) GATES: 100% recall of the true keys above `N/k` vs an exact
  Map oracle (weighted AND unit streams); a bounded overestimate (each reported
  total in `[true - errorOf, true]`); and the MARQUEE -- HeavyKeeper's mean
  relative error BELOW a faithful, inline hand-rolled Space-Saving baseline
  (Metwally-Agrawal-El Abbadi, "Efficient Computation of Frequent and Top-k
  Elements in Data Streams", ICDT 2005 -- correct min-replacement Stream-Summary
  with `(count, error)` tracking, cited in the witness so it is verifiably NOT a
  strawman) on a Zipfian (s ~ 1.1) + DRIFTING stream. NEGATIVE CONTROLS (the N4
  discipline) the same gate REJECTS: a DECAY-DISABLED HeavyKeeper (recall < 1.0
  on drift -- stale keys never erode) and a FOREST-FROZEN variant (misses true
  heavy hitters -- the top-k never updates).
- 0 B/op on `add` / `addFrom` INCLUDING the decay draw and the forest sift, proven
  by `test/torture.mjs` (a HeavyKeeper lane: add + decay + forest + PRNG, addFrom
  on FRACTIONAL-buffer LARGE u32 keys near 2^31 / 2^32-1) and
  `test/perf/PerfGate.test.mjs` (flat throughput + a must-allocate control).
- The four-member roster is COMPLETE: HARD window (EH) / ADAPTIVE window (ADWIN) /
  SMOOTH decay (ForwardDecay) / DECAYED TOP-K (HeavyKeeper). 1.0.0 (the API-freeze
  milestone, no new member) is next.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
