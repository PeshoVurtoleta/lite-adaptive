# @zakkster/lite-adaptive

> Zero-GC streaming summaries over the TIME / RECENCY axis that **witness their recency against the paper's bound** -- ExponentialHistogram for sliding-window count / sum, in fixed memory, over a caller-supplied clock.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-adaptive.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-adaptive)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-adaptive?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-adaptive)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-adaptive?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-adaptive)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-adaptive?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-adaptive)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
![Stable](https://img.shields.io/badge/API-stable%201.0-brightgreen?style=flat-square)

## The recency family the ecosystem was missing

Exact analytics over an unbounded, EVOLVING stream cost unbounded memory: to answer "how many events in the last W" exactly you must buffer the whole window (O(W) items). Worse, most summaries are CUMULATIVE -- they fold the whole stream and never forget, so they cannot tell you what is happening *right now*. `lite-adaptive` is a zero-dependency, zero-GC family of streaming summaries over the **time / recency** axis: it answers a recency question in *fixed* memory, and it can **forget**. Its signature is a shipped **recency witness** -- every member proves its MEASURED windowed error against the paper's THEORETICAL bound, next to the memory it saves.

It is the fourth corner of the suite: **[@zakkster/lite-o1](https://www.npmjs.com/package/@zakkster/lite-o1)** is *exact* O(1), **[@zakkster/lite-filter](https://www.npmjs.com/package/@zakkster/lite-filter)** is approximate *membership*, **[@zakkster/lite-sketch](https://www.npmjs.com/package/@zakkster/lite-sketch)** is *cumulative* approximate aggregates, and `lite-adaptive` is the *windowed / decayed / drift* complement. The line is recency: cumulative -> lite-sketch; last-W / decayed / drift -> lite-adaptive.

**Stable at 1.0.0.** The four-member core -- `ExponentialHistogram`, `ADWIN`, `ForwardDecay`, `HeavyKeeper` -- is frozen: signatures, options, and valid-input behavior will not change under 1.x (additive members may still land later; the core does not break). Follows semver from here.

```bash
npm i @zakkster/lite-adaptive
```

```js
import { ExponentialHistogram } from '@zakkster/lite-adaptive';

// count events in the LAST 60_000 ms, within 1% relative error, in a fixed ~24 KB pool
const eh = new ExponentialHistogram(60_000, 0.01);
eh.add(Date.now());                        // caller owns the clock (monotone `now`)
eh.add(Date.now());                        // ... add(now) per event, 0 bytes/op
eh.count();                                // windowed count over the last 60 s (+-1%)

// no clock? omit `now` for the "last N items" window (count mode auto-ticks)
const last1000 = new ExponentialHistogram(1000, 0.01);
for (let i = 0; i < 5000; i++) last1000.add();
last1000.count();                          // ~1000  (an exact ring would hold 1000 timestamps)
```

## Contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [ExponentialHistogram](#exponentialhistogram)
- [ADWIN](#adwin)
- [ForwardDecay](#forwarddecay)
- [HeavyKeeper](#heavykeeper)
- [API reference](#api-reference)
- [Composability](#composability)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

## Why this exists

A recency summary is a promise: "I use `X` bytes and my answer about the last `W` is within `E` of the truth -- and I forget the rest." That promise is only as good as (1) a time source you can control and replay, and (2) whether anyone ever *checks* the windowed error against the theory. `lite-adaptive` takes a **caller-supplied monotone clock** (never reads the wall clock -- so every result is deterministic and testable) and **ships the witness that measures the windowed error and gates it against the bound** on every release. Recency is a co-headline, stated honestly as a TRIPLE: the space it costs, the error it guarantees at that space, and the recency model (a hard window vs decay vs an adaptive window).

## What you get

- **ExponentialHistogram** -- sliding-window count / sum ("how many / how much in the last `W`?") in a fixed pool of `(timestamp, size)` buckets, with a *hard* windowed relative-error bound `<= epsilon`. The reference member; DGIM (the 0/1 count stream) is its `value = 1` special case.
- **ADWIN** -- concept-drift detection with NO fixed window size (Bifet-Gavalda, SDM 2007): `add(x) -> boolean` tells you the moment the stream's mean *changed*, and the adaptive window GROWS while stable and SHRINKS to the new concept on a detected change. `mean` / `variance` / `width` report the current stable window. The marquee member.
- **ForwardDecay** -- time-decayed count / sum / mean / rate (Cormode-Shkapenyuk-Srivastava-Xu, ICDE 2009) in **O(1) space** (two scalar accumulators, no pool): every element's weight halves every `halfLife`, so recent data dominates and old data *fades* smoothly instead of dropping at an edge. `add(now?, value?)` accepts any finite real (signed); `count` / `sum` / `mean` / `rate` are O(1) queries, EXACT modulo floating point.
- **HeavyKeeper** -- decayed / windowed heavy hitters (Gong et al., USENIX ATC 2018): the top-k keys dominating the stream *right now*. A `d x w` fingerprint table with probabilistic exponential decay on collision (cold keys erode) + an intrusive top-k min-forest. `add(key, weight = 1)` ranks by count or any additive weight; `forEach` / `topKInto` read the leaders 0-alloc. Far lower error than Space-Saving on skewed, evolving streams. The final member.
- **A caller-owned time source** -- `add(now)` with a monotone `now` (a logical tick or ms), or `add()` in count mode for the "last N items" window. The member never reads the clock, so witnesses are exactly reproducible.
- **The recency witness** -- measured windowed error vs the theoretical bound, printed side by side, with the exact-ring foil whose memory climbs O(W) while the histogram stays a fixed sliver.
- **Zero runtime dependencies**, ESM, tree-shakeable named exports, TypeScript types, and a **0 bytes/op hot path** -- *including* the amortized bucket merge / expire reshaping -- proven by a leak + GC-profiler torture gate.

## ExponentialHistogram

Count (or sum) the elements in the last `W` of an unbounded, evolving stream using a fixed pool of buckets. Each `add` opens a level-0 bucket at `now`; a level-`L` bucket holds exactly `2^L` elements (its population). When more than `k = ceil(1/(2*epsilon)) + 1` buckets share a level, the two OLDEST merge into one bucket of the next level (a bounded, amortized-O(1) cascade); buckets whose timestamp fell out of `[now - W, now]` expire. The estimate is the sum of live buckets minus half the oldest bucket -- *but only when that bucket genuinely straddles the window edge*, so a not-yet-full window (and every population-1 bucket) is estimated EXACTLY.

<details>
<summary><b>How the bucket pool bounds the error (and the memory)</b></summary>

The only source of error is the oldest bucket, which may straddle the window boundary: some of its elements have expired, some have not, and the structure cannot see inside a bucket. It estimates half of it is still in-window. That bucket's population is `2^Lmax`, so the error is at most `2^Lmax / 2`. Because each level below the top holds `>= k - 1` buckets, the window's true count is `>= (k - 1) * (2^Lmax - 1)`, which makes the *relative* error `~ 1/(2k) < epsilon` -- a HARD bound, held on every query, not a statistical average.

The same invariant fixes the memory: the number of levels is `ceil(log2(W/(k+1))) + 2`, and each level holds at most `k + 1` buckets, so the pool is a fixed
`CAP = (k+1) * (ceil(log2(W/(k+1))) + 2) + 2` buckets -- preallocated at construction, never grown. At `W = 65536, epsilon = 0.01` that is 678 buckets (~24 KB) versus an exact ring of 65536 timestamps (512 KB).

The measured windowed relative error tracks `1/(2k)` and stays under `epsilon` across the whole `W in {64, 1000, 65536} x epsilon in {0.5, 0.1, 0.01}` sweep -- see [Testing](#testing).
</details>

## ADWIN

Detect when an unbounded stream's mean has CHANGED, with no window size to guess. `ADWIN(delta)` maintains a variance-carrying bucket list of recent values; `add(x)` appends `x`, compresses the buckets (at most 5 per level), and scans every bucket-boundary split of the window into an older sub-window `W0` and a newer `W1`. When their means differ by more than a statistically justified threshold it flags a change (`add` returns `true`) and DROPS the older sub-window -- so the window automatically GROWS while the stream is stable and SHRINKS to the new concept on a change. `mean` / `variance` / `width` always describe the current, stable window.

```js
import { ADWIN } from '@zakkster/lite-adaptive';

const adwin = new ADWIN(0.002);            // delta = false-alarm confidence
for (const x of latencies) {
    if (adwin.add(x)) {                     // true the moment the mean shifts
        console.log('drift! new mean', adwin.mean, 'over', adwin.width, 'items');
    }
}
```

<details>
<summary><b>The ADWIN2 variance-aware cut (why the false-alarm rate is bounded)</b></summary>

A split of the window into `W0` (older, `n0` items) and `W1` (newer, `n1` items) is a *change* when `|mean(W0) - mean(W1)| > epsCut`, where

```
m       = 1 / (1/n0 + 1/n1)                 (harmonic mean of the two counts)
deltaP  = delta / ln(width)                 (Bonferroni over the tested splits)
epsCut  = sqrt( (2/m) * sigmaHat^2 * ln(2/deltaP) )   +   (2/3) * (R/m) * ln(2/deltaP)
```

`sigmaHat^2` is the total-window variance and `R` is the running observed range (`max - min`). This is the **ADWIN2 variance-aware bound** (Bifet-Gavalda, SDM 2007): the variance term dominates on low-variance streams, so it detects small, real shifts faster than a range-only Hoeffding bound while keeping the stationary **false-alarm rate `<= delta`** (a Bernstein guarantee). Only bucket boundaries are tested (`O(log width)` splits), and on a detected cut the oldest bucket is dropped and the scan repeats -- so `add` is amortized O(1) and **0 B/op including the cut-scan and the shrink**.

ADWIN is ITEM-INDEXED: `add(x)` per item, no clock -- the adaptive window is measured in items and is data-driven (unlike ExponentialHistogram's caller-supplied `now`). The change-response witness injects a known changepoint and gates the false-alarm rate `<= delta`, a detection latency that scales with shift magnitude, ~0 missed detections on a large shift, and that the adapted window reflects only the new concept -- see [Testing](#testing).
</details>

## ForwardDecay

Weight recent data more, forget old data *smoothly*. `ForwardDecay(halfLife)` maintains a time-decayed count / sum / mean / rate where each element's weight halves every `halfLife` time units -- there is no window edge, old data just fades. Unlike a backward decay (which re-weights the whole history on every query), ForwardDecay measures each element's age FORWARD from a fixed landmark, so its weight is computed ONCE at insert and folded into two running scalars (`C` = decayed count, `Sv` = decayed weighted sum). That is what makes it O(1) space *and* numerically stable.

```js
import { ForwardDecay } from '@zakkster/lite-adaptive';

// a decayed average latency where a 5-minute-old sample counts half as much
const fd = new ForwardDecay(5 * 60_000);   // halfLife = 5 minutes (ms)
fd.add(Date.now(), 42);                     // add(now, value); caller owns the monotone clock
fd.add(Date.now(), 88);                     // ... 0 bytes/op, incl. the periodic landmark rebase
fd.mean();                                  // decayed mean latency (recent samples dominate)
fd.rate();                                  // decayed events per ms (see the rate() note below)

// no clock? omit `now` for a decayed "recent items" summary (count mode auto-ticks)
const recent = new ForwardDecay(1000);
for (let i = 0; i < 5000; i++) recent.add(undefined, Math.random());
recent.mean();                              // mean weighted toward the last ~1000 items
```

<details>
<summary><b>The landmark rebase (why the accumulators stay bounded) + the rate() definition</b></summary>

For exponential decay `g(x) = exp(lambda * x)`, `lambda = ln2 / halfLife`, the accumulators are `C = sum g(t_i - L)` and `Sv = sum value_i * g(t_i - L)` from a landmark `L`. A query at `now` folds the common age factor back in:

```
decayedCount(now) = C  * exp(-lambda * (now - L))
decayedSum(now)   = Sv * exp(-lambda * (now - L))
mean(now)         = Sv / C                          // the age factor CANCELS -> now-invariant, EXACT
rate(now)         = decayedCount(now) * lambda
```

Because `g` grows without bound, `add` REBASES the landmark to `t` whenever `lambda*(t - L)` would exceed `FD_EXP_CAP = 40`: it rescales `C *= exp(-lambda*(t - L))`, `Sv *= ...`, `L = t`. This is EXACT modulo floating point -- it factors one common constant out of every accumulated term -- and 0 B/op. The cap is deliberately small so a single weight stays `<= exp(40) ~ 2.35e17`, leaving the accumulator ~7.6e290x of head-room under `Double.MAX` -- so overflow needs a physically unreachable term count. The one case no cap can cover -- a single value within a factor of `exp(40)` of `Double.MAX` -- is caught **fail-closed**: `count` / `sum` / `mean` / `rate` throw `[lite-adaptive]` on a non-finite accumulator rather than returning `Infinity`.

> **`rate()` is a DEFINITION, not a theorem.** `rate(now) = decayedCount(now) * lambda` is *defined* as the decayed events per unit time under the exponential kernel: a steady arrival of `r` events/unit converges to `decayedCount -> r / lambda`, so `rate() -> r`. It is exact only in that steady-state limit, not a guaranteed instantaneous rate.

**Signed values are allowed** (unlike ExponentialHistogram's positive-only sum): because `C` and `Sv` are separate accumulators, a negative value lowers the decayed sum / mean while still contributing ONE decayed event to the count. The exact-aggregate witness recomputes the decayed aggregate directly from every stored `(t_i, value_i)` and gates `|fd - oracle| / |oracle| <= 1e-9` on every query across 3 `halfLife` x 3 stream-shapes; two broken-rebase controls are rejected by the same gate -- see [Testing](#testing).
</details>

## HeavyKeeper

Find the few keys dominating the stream *right now*, with far lower error than Space-Saving on skewed and evolving traffic. `HeavyKeeper(d, w, k)` keeps a `d x w` table of `(fingerprint, count)` cells and a top-k min-forest. `add(key, weight = 1)` hashes the key to one cell per row: a matching fingerprint adds the weight; a colliding one is *probabilistically decayed* and, at count 0, evicted and replaced. So a key that stops arriving decays away and the live top-k tracks the current concept -- no window to size, no rotation to schedule.

```js
import { HeavyKeeper } from '@zakkster/lite-adaptive';

const hk = new HeavyKeeper(4, 1024, 16, { seed: 1 });   // d rows, w cells/row, k leaders
for (const [tag, us] of spans) hk.add(tag, us);          // rank tags by TOTAL microseconds (weighted)

const topN = new Float64Array(2 * 16);                   // 2*k floats: [key, estimate] pairs
const n = hk.topKInto(topN);                             // 0-alloc: packs n pairs, returns entry count
hk.forEach((key, est) => { /* render key with est */ }); // 0-alloc iteration (topK() allocates)
```

<details>
<summary><b>The probabilistic decay (why it beats Space-Saving on drift) + the weighted-miss rule</b></summary>

On `add(key, weight)`, for each of the `d` rows at the key's cell: an empty cell is claimed `(fp, weight)`; a fingerprint match does `count += weight`; a fingerprint *miss* decays the resident count **once** with probability `b^(-count)` (`b ~ 1.08`, a seeded xorshift32 draw), then `count -= weight` (clamped at 0), replacing the fingerprint when it reaches 0. `estimate(key)` is the largest matching cell. Because a heavy key's count is large, `b^(-count)` is tiny, so it is almost never decayed -- while a cold key's small count erodes quickly. That asymmetry is why HeavyKeeper's error on the true heavy hitters is far below Space-Saving's on a Zipfian + drifting stream (the witness measures **0.001% vs 36.75%** mean relative error over the true top-k).

The weighted-miss rule decays **once** (not once per weight unit): a per-unit decay would draw `weight` random numbers per miss -- with `weight` in microseconds that is thousands of draws, breaking the O(1), 0-alloc hot path. Decaying once then subtracting the weight keeps `add` amortized O(1) and **0 B/op including the decay draw and the forest sift** (see [ADR 0005](./decisions/0005-heavy-keeper.md)).

The PRNG is a seeded `Uint32` xorshift (`seed` option + getter, never `Math.random`), so the decay -- and therefore the top-k and the witness -- is fully reproducible. Keys are safe integers; a bad key / weight / buffer throws `[lite-adaptive]` typeof-first (a byte-identical no-op). There is no `merge`: HeavyKeeper decays natively, so it needs no A/B rotation. The witness gates 100% recall of the true top-k above `N/k` vs an exact `Map` oracle (weighted and unit streams) and a bounded overestimate; a frozen-forest and a decay-disabled variant are rejected by the same gate -- see [Testing](#testing).
</details>

## API reference

```js
new ExponentialHistogram(W, epsilon, options?)

add(now?, value?) -> this   // HOT, 0 B/op incl. merge cascade + expire
addFrom(buf, i) -> this     // HOT, 0 B/op: zero-box packed [now, value] entry (now = buf[i], value = buf[i+1])
count() -> number           // COLD, O(levels): windowed population estimate
sum() -> number             // COLD, O(buckets): windowed value-sum estimate
query() -> number           // COLD: alias of count()
clear() -> this             // reset to empty; reuse the pool (unlocks the mode)

// getters
windowSize   epsilon   bucketCount   capacity   k   levels   mode
```

- **`W`** -- window size; a finite number `> 0` (items in count mode, or the `now`-unit span in explicit mode).
- **`epsilon`** -- relative-error knob in `(0, 1)`; smaller means more buckets and tighter windowed error.
- **`add(now?, value?)`** -- the mode LOCKS at the first call: pass a finite, non-decreasing `now` for EXPLICIT mode, or omit it for COUNT mode (the member auto-ticks). `value` defaults to 1 (the DGIM count case) and must be a finite number `> 0`. Fail closed: a mode switch, a non-finite / decreasing `now`, or a non-positive value throws `[lite-adaptive]` (a byte-identical no-op).
- **`addFrom(buf, i)`** -- the ZERO-BOX entry for a caller whose `now` AND `value` are both FRACTIONAL doubles. Reads `now = buf[i]` and `value = buf[i+1]` UNBOXED from a caller-owned PACKED `[now, value]` `Float64Array` (a batch steps `i` by 2), avoiding the ~16 B HeapNumber that `add(now, value)` boxes per fractional argument at a non-inlined call boundary. The lite-hud idiom: write a per-channel `Float64Array(2)` scratch each tick and call `addFrom(scratch, 0)`. EXPLICIT-time only (a count-locked instance throws; the first `addFrom` locks EXPLICIT mode). Same validation / throws / byte-identical-no-op-on-reject as `add(now, value)`; a non-`Float64Array` `buf` or a non-integer / out-of-range `i` throws `[lite-adaptive]`.
- **`count()` / `sum()` / `query()`** -- COLD windowed estimates; never throw (0 on an empty window).

Constants that shape the pool:

| Symbol | Value | Meaning |
|--------|-------|---------|
| `k` | `ceil(1/(2*epsilon)) + 1` | max buckets per level (the two oldest merge on the `k+1`-th) |
| `levels` | `ceil(log2(W/(k+1))) + 2` | number of size-class levels the pool can occupy |
| `capacity` | `(k+1) * levels + 2` | the fixed bucket-pool size (never grows) |
| error | `~ 1/(2k) <= epsilon` | windowed relative error, HARD, on every query |

```js
new ADWIN(delta, options?)

add(x) -> boolean           // HOT, amortized O(1), 0 B/op incl. cut-scan + shrink; true iff a change was detected on this item
addFrom(buf, i) -> boolean  // HOT, 0 B/op: zero-box entry, reads x = buf[i] unboxed; same drift flag as add(x)
clear() -> this             // reset to empty; reuse the pool

// getters
mean   variance   width   bucketCount   capacity   delta
```

- **`delta`** -- the confidence / false-alarm knob in `(0, 1)`; smaller means fewer false alarms and (disclosed) longer detection latency. Throws `[lite-adaptive]` before allocation on a bad `delta`.
- **`add(x)`** -- append a finite real `x` (item-indexed; no clock; `|x| <= sqrt(Number.MAX_VALUE)` so its square never overflows the variance), run the ADWIN2 variance-aware cut over the bucket boundaries, and on a change DROP the older sub-window. Returns `true` exactly on the item that detects the change. Fail closed: a non-finite / non-number `x`, or a finite `|x|` whose square would overflow, is a byte-identical no-op that throws `[lite-adaptive]`.
- **`addFrom(buf, i)`** -- the ZERO-BOX sibling of `add(x)`: reads `x = buf[i]` UNBOXED from a caller-owned `Float64Array`, for a caller whose fractional `x` (a HUD-computed duration) would box as a plain argument at a non-inlined boundary. Same drift-detection logic and boolean return as `add(x)`; a non-`Float64Array` `buf` or an out-of-range `i` throws `[lite-adaptive]`, and a non-finite / square-overflowing `x` is a byte-identical no-op.
- **`mean` / `variance` / `width`** -- the mean, variance, and item count of the CURRENT adaptive window; `width` shrinks on a detected change, then regrows while stable. Getters never throw (0 on an empty detector).

```js
new ForwardDecay(halfLife, options?)

add(now?, value?) -> this   // HOT, 0 B/op incl. the landmark rebase; value defaults to 1 (any finite real)
addFrom(buf, i) -> this     // HOT, 0 B/op: zero-box packed [now, value] entry (now = buf[i], value = buf[i+1])
count(now?) -> number       // COLD, O(1): decayed count at `now` (default = last add time)
sum(now?) -> number         // COLD, O(1): decayed weighted sum at `now`
mean(now?) -> number        // COLD, O(1): decayed mean (Sv/C); landmark- and now-invariant
rate(now?) -> number        // COLD, O(1): decayedCount(now) * lambda (a definition -- see note)
clear() -> this             // reset to empty; keep halfLife/lambda, unlock the mode

// getters
halfLife   lambda   landmark   mode
```

- **`halfLife`** -- the decay half-life; a finite number `> 0` (an element's weight halves over this span). `lambda = ln2 / halfLife`.
- **`add(now?, value?)`** -- the mode LOCKS at the first call: pass a finite, non-decreasing `now` for EXPLICIT mode, or omit it for COUNT mode (the member auto-ticks). `value` defaults to 1 and may be ANY finite real (signed: it lowers the decayed sum / mean but still counts as one decayed event). Fail closed: a mode switch, a non-finite / decreasing `now`, or a non-finite value throws `[lite-adaptive]` (a byte-identical no-op).
- **`addFrom(buf, i)`** -- the ZERO-BOX entry for a caller whose `now` AND `value` are both FRACTIONAL doubles (the lite-hud decayed-stats idiom: a per-channel fractional record time + a fractional value). Reads `now = buf[i]` and `value = buf[i+1]` UNBOXED from a caller-owned PACKED `[now, value]` `Float64Array` (write a `Float64Array(2)` scratch each tick and call `addFrom(scratch, 0)`; a batch steps `i` by 2), avoiding the ~16 B HeapNumber that `add(now, value)` boxes per fractional argument at a non-inlined call boundary. EXPLICIT-time only (a count-locked instance throws; the first `addFrom` locks EXPLICIT mode and sets the landmark). Same validation / throws / byte-identical-no-op-on-reject as `add(now, value)`; a non-`Float64Array` `buf` or a non-integer / out-of-range `i` throws `[lite-adaptive]`.
- **`count()` / `sum()` / `mean()` / `rate()`** -- COLD O(1) decayed queries at an optional query time (default = the last add time). An explicit query time BEFORE the last add throws `[lite-adaptive]` (can't un-decay); otherwise they never throw (0 on an empty summary).

Constants that shape the decay:

| Symbol | Value | Meaning |
|--------|-------|---------|
| `lambda` | `ln2 / halfLife` | the decay rate; weight `= exp(-lambda * age)` |
| `FD_EXP_CAP` | `40` | the `exp()` argument ceiling that triggers a landmark rebase (keeps the accumulator bounded) |
| space | `O(1)` | two scalar accumulators `C`, `Sv` -- no pool |
| error | EXACT (mod FP) | the decayed aggregate equals the definition; the rebase is exact |

```js
new HeavyKeeper(d, w, k, options?)          // options: { seed, b }
HeavyKeeper.withAccuracy(k, targetError, options?)   // static: derive d, w from k + target error

add(key, weight = 1) -> this   // HOT, amortized O(1), 0 B/op incl. the decay draw + the forest sift
addFrom(buf, i) -> this        // HOT, 0 B/op: zero-box entry, key = buf[i], weight = buf[i+1] (unboxed)
estimate(key) -> number        // COLD: max matching cell count (0 for unseen but VALID key; bad key throws)
forEach(fn) -> void            // ALLOC-FREE iteration over the current top-k: fn(key, estimate)
topKInto(buf) -> number        // pack the top-k into a Float64Array (>= 2*k) as [key, estimate] pairs,
                               // 0-alloc; returns the entry count (a too-small buf throws)
topK() -> Array                // COLD convenience; MAY allocate (not for the render path)
clear() -> this                // 0-alloc reset (reuse the table + forest)

// getters
d   w   k   b   seed   bytes   size
```

- **`d` / `w` / `k`** -- hash rows (`~4-8`), cells per row, and the top-k size. `HeavyKeeper.withAccuracy(k, targetError)` derives `d` / `w` from a target relative error. A bad `d` / `w` / `k` / `seed` / `b` / option throws `[lite-adaptive]` typeof-first, before any allocation.
- **`options.seed`** -- the `Uint32` seed for the decay PRNG (a seeded xorshift32, never `Math.random`); the decay, top-k, and witness are fully reproducible. `seed = 0` is a valid distinct seed. **`options.b`** -- the decay base (default `~1.08`).
- **`add(key, weight = 1)`** -- `key` a SAFE INTEGER; `weight` a positive integer (rank by count when 1, or by total time / bytes / any additive weight). Fail closed: a non-safe-integer key or non-positive-integer weight throws `[lite-adaptive]` (a byte-identical no-op).
- **`addFrom(buf, i)`** -- the ZERO-BOX entry: reads `key = buf[i]` and `weight = buf[i+1]` UNBOXED from a caller-owned packed `Float64Array`, avoiding the HeapNumber that a large `u32` key (`>= 2^31`) boxes as a plain argument. Same validation / byte-identical-no-op-on-reject as `add`; a non-`Float64Array` `buf` or an out-of-range `i` throws `[lite-adaptive]`.
- **`forEach(fn)` / `topKInto(buf)`** -- the ALLOC-FREE reads for a render path; `topK()` is a cold convenience that may allocate. There is no `merge` -- HeavyKeeper decays natively, so it needs no A/B rotation.

Constants that shape the table:

| Symbol | Value | Meaning |
|--------|-------|---------|
| `d` | rows (~4-8) | independent hash rows; `estimate` is the max matching cell over them |
| `w` | cells / row | more cells -> fewer collisions -> lower overestimate (`~ N/w`) |
| `b` | `~1.08` | decay base; a fingerprint miss decays with probability `b^(-count)` |
| space | `O(d * w + k)` | two `Uint32Array` table columns + the min-forest; fixed at construction |

## Composability

An end-to-end recency pipeline -- a request-rate monitor that reports the count over the last minute AND the average latency over the last 10k requests, both in fixed memory:

```js
import { ExponentialHistogram } from '@zakkster/lite-adaptive';

// how many requests in the last 60 seconds? (time-based, hard window, +-1%)
const rpm = new ExponentialHistogram(60_000, 0.01);

// total latency-ms over the last 10_000 requests? (count-based window, sum mode)
const latency = new ExponentialHistogram(10_000, 0.01);

function onRequest(nowMs, latencyMs) {
    rpm.add(nowMs);                 // one event at time nowMs
    latency.add(undefined, latencyMs);  // count-mode window, value = the latency
}

function report(nowMs) {
    const perMinute = rpm.count();               // windowed request count (+-1%)
    const avgLatency = latency.sum() / 10_000;   // windowed mean latency over last 10k
    return { perMinute, avgLatency };
}

// drive it
let t = Date.now();
for (let i = 0; i < 100_000; i++) { t += 1 + (i % 3); onRequest(t, 5 + (i % 20)); }
report(t);   // { perMinute: ~<count in last 60s>, avgLatency: ~14.5 }  -- fixed KB, no history buffered
```

Every `add` is 0 bytes/op; the two histograms together are a few tens of KB regardless of how long the stream runs.

## Zero-GC design notes

<details>
<summary><b>Allocation table + the gated numbers</b></summary>

Everything after construction is a pure index manipulation over preallocated TypedArray columns (Struct-of-Arrays) plus a free-list -- no objects, no closures, no `Map`.

| Operation | Allocation | Notes |
|-----------|-----------|-------|
| `new ExponentialHistogram(W, e)` | one-time | the fixed pool: `capacity` buckets x (3 Float64 + 3 Int32) columns |
| `add(now?, value?)` | **0 B/op** | free-list pop opens a bucket; the merge cascade reuses one slot + frees the other; expiry frees the oldest -- all in-pool |
| `count()` / `query()` | 0 B | O(levels): `sum(lcount[L] * 2^L)` minus the straddle half-correction |
| `sum()` | 0 B | O(buckets): walks the level lists |
| `clear()` | 0 B | rechains the free-list; reuses the pool |

Gated quality numbers (`npm run verify`):

- **Recency**: windowed relative error `<= epsilon` on EVERY query across `W in {64, 1000, 65536} x epsilon in {0.5, 0.1, 0.01}`, plus a shifting-rate stream; a broken EH (no straddle correction) is REJECTED by the same gate.
- **Zero-GC**: `add` (count mode AND explicit-time, including the merge cascade + expire over millions of pool wraps) measures **0 B/op**, gc major 0, retention 0, arrayBuffers delta `<= 0`.
- **Throughput**: flat across the perf gate; a must-allocate control trips it (the gate has teeth).

</details>

## Design decisions worth knowing

- **The caller owns the clock.** `add(now)` takes a monotone `now`; the member NEVER reads the wall clock. This is what makes every result deterministic and every witness reproducible. A `now` that goes backwards throws (fail closed) -- a monotone stream is the contract.
- **The mode locks at the first add.** Explicit-`now` and count mode are mutually exclusive for a histogram's life (until `clear()`); mixing a tick clock with caller timestamps would corrupt the window edge silently, so a switch is a throw, never a silent reinterpretation.
- **The straddle correction is conditional.** Half the oldest bucket is subtracted ONLY when it genuinely straddles the window edge -- so a not-yet-full window and every population-1 bucket are EXACT, and the error bound holds from the very first query.
- **DGIM is not a separate member.** The 0/1 count stream is `value = 1` (the default) -- see ADR 0002.
- **Forward decay, not backward decay.** ForwardDecay measures each element's age FORWARD from a fixed landmark, so its weight is computed once at insert and never revised -- a running scalar, not a per-query re-weighting of the whole history. That is the numeric-stability call (see ADR 0004).
- **ForwardDecay accepts signed values; ExponentialHistogram does not.** Because the decayed count `C` and the decayed sum `Sv` are separate accumulators, a negative value gives a proper decayed weighted mean without corrupting the count. EH's positive-only sum is a deliberate contrast.
- **`rate()` is a definition, not a theorem.** `rate = decayedCount * lambda` is the decayed events per unit time under the exponential kernel, exact only in the steady-state limit -- documented, never oversold.
- **Fail closed, typeof-first, before allocation.** A bad `W` / `epsilon` / `halfLife` / option throws at the constructor door before any allocation; `null` is not zero; a query before the last add time throws (can't un-decay); other queries never throw.

## Testing

- `npm test` -- the `node:test` behavioral + fail-closed suite across all three members (ExponentialHistogram, ADWIN, ForwardDecay): ctor validation before allocation, mode-lock both ways, monotone-`now`, signed values, the landmark rebase, query-now contract, and the M1 no-op regressions (a rejected add is byte-identical).
- `npm run witness` -- the recency witness: the windowed error vs the `epsilon` bound (EH) + the change-response gates (ADWIN) + the exact-aggregate gate `|fd - oracle| / |oracle| <= 1e-9` (ForwardDecay) across 3 `halfLife` x 3 stream-shapes, each with rejected negative controls.
- `npm run torture` -- the 0 B/op leak + GC-profiler gate on `add` including the merge / expire reshaping (`node --expose-gc`).
- `npm run test:perf` -- the flat-throughput perf gate + a must-allocate control.
- `npm run test:types` -- the ambient type-surface compile check.
- `npm run verify` -- all of the above (the release gate).

## What this is not

- **Not an exact windowed aggregator.** For an EXACT sliding-window sum / min / max over a monoid, use `@zakkster/lite-o1` (`WindowFold`, `MonoDeque`, `RingLog`) -- bounded-capacity and exact. `lite-adaptive` is the approximate, unbounded-window complement.
- **Not a cumulative sketch.** For whole-stream distinct-count / frequency / quantiles / top-k with no forgetting, use `@zakkster/lite-sketch`. The line is recency.
- **Not a wall-clock timer.** The member never reads the clock; the caller supplies a monotone `now`.
- **Not exact top-k.** HeavyKeeper estimates the current heavy hitters in sublinear space -- exact top-k over an evolving stream is impossible in fixed memory. The four-member core (ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper) is FROZEN at 1.0.0 (the API-freeze milestone, not a new member); additive members may still land in a later minor without breaking the core.
- **Not a cumulative top-k.** HeavyKeeper decays, so it answers "who dominates *now*"; the whole-stream heavy hitters that never forget are `@zakkster/lite-sketch`'s SpaceSaving.

## Ecosystem

Part of the `@zakkster/*` suite of zero-GC, single-file ESM micro-libraries:

- **[@zakkster/lite-o1](https://www.npmjs.com/package/@zakkster/lite-o1)** -- exact O(1) data structures (incl. exact windowed folds).
- **[@zakkster/lite-sketch](https://www.npmjs.com/package/@zakkster/lite-sketch)** -- cumulative approximate summaries (HyperLogLog, CountMinSketch, DDSketch, SpaceSaving).
- **[@zakkster/lite-filter](https://www.npmjs.com/package/@zakkster/lite-filter)** -- approximate membership (Bloom-family filters).
- **@zakkster/lite-adaptive** -- windowed / decayed / drift summaries over the recency axis (this package).

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
