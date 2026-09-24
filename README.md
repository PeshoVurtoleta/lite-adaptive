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
- [SlidingHyperLogLog](#slidinghyperloglog)
- [DriftDetector](#driftdetector)
- [SlidingDDSketch](#slidingddsketch)
- [SlidingCountMin](#slidingcountmin)
- [DecayedReservoir](#decayedreservoir)
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
- **HeavyKeeper** -- decayed / windowed heavy hitters (Gong et al., USENIX ATC 2018): the top-k keys dominating the stream *right now*. A `d x w` fingerprint table with probabilistic exponential decay on collision (cold keys erode) + an intrusive top-k min-forest. `add(key, weight = 1)` ranks by count or any additive weight; `forEach` / `topKInto` read the leaders 0-alloc. Far lower error than Space-Saving on skewed, evolving streams. The final member of the frozen 1.0.0 core.
- **SlidingHyperLogLog** -- windowed distinct-count (Chabchoub-Hebrail, "Sliding HyperLogLog", 2010): "how many *distinct* keys in the last `W`?" in fixed preallocated space at HLL accuracy (the recency sibling of `@zakkster/lite-sketch`'s cumulative HyperLogLog). An `m = 2^p` register bank where each register keeps a small fixed LFPM ring of `(timestamp, rho)` maxima; `add(now, key)` / `addFrom` are 0-alloc incl. the windowed eviction, `count(w?)` runs Ertl's estimator over the live window with a `1.04 / sqrt(m)` standard error. The first additive post-1.0 member (1.1.0).
- **DriftDetector** -- scalar change detection (Page, *Biometrika* 1954): "did the mean of *this* signal just shift?" in `O(1)` state -- six scalars, no pool, no window (the lightest member). One class selects **Page-Hinkley** or two-sided **CUSUM** via a mode const; `add(x) -> boolean` returns `true` exactly on the detecting item, then resets to catch the next shift. The cheap per-channel companion to ADWIN -- run one per stream when you have many. The second additive post-1.0 member (1.2.0).
- **SlidingDDSketch** -- windowed relative-error quantiles (Masson-Rim-Lee, "DDSketch", *VLDB* 2019): "what's p50 / p99 over the last `W`?" in fixed preallocated space at DDSketch accuracy (the recency sibling of `@zakkster/lite-sketch`'s cumulative DDSketch). A ring of `panes` preallocated DDSketch panes (default 32), each covering `W / panes`; `add(now, value)` / `addFrom` are 0-alloc incl. the pane rotate + clear, and `quantile(q, w?)` / `quantileInto` merge the live panes into an instance-owned scratch with a relative error `<= alpha`. The window is soft to within one pane width `W / panes`. The third additive post-1.0 member (1.3.0).
- **SlidingCountMin** -- windowed per-label frequency (Cormode-Muthukrishnan Count-Min over a B+1 pane ring): "how many times did key `k` occur in the last `W`?" in fixed memory (the recency sibling of `@zakkster/lite-sketch`'s cumulative CountMinSketch). A ring of `B+1` panes (default `panes` B = 32), each a `d x w` `Uint32` grid; `add(now, key, count?)` / `addFrom` are amortized 0-alloc incl. the pane rotate, and `estimate(key, w?)` sums the key's cells across the live panes then mins over rows -- a **one-sided upper bound**, never an under-count. Ships `advance(now)` (R11 idle-slide). The fourth additive post-1.0 member (1.5.0).
- **DecayedReservoir** -- a recency-biased fixed-`k` *sample* of actual stream values (Efraimidis-Spirakis A-Res weighted reservoir over ForwardDecay weights): the "give me `k` real recent items" member -- the sampling complement to ForwardDecay (which gives decayed *aggregates* exactly, this gives a decayed *sample* you compute anything over). Each `add(now?, value?)` / `addFrom` draws one seeded xorshift32 uniform, forms an A-Res key in log space, and sifts it into a size-`k` min-forest; amortized 0-alloc incl. the order-preserving landmark rebase. Read the raw sample with `sampleInto(buf)` / `forEach(fn)`. A sample, not a hard window, so (like ForwardDecay) it has no `advance()`. The fifth additive post-1.0 member (1.6.0).
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

The measured windowed relative error tracks `1/(2k)` and stays under `epsilon` across the whole `W in {64, 1000, 65536} x epsilon in {0.5, 0.1, 0.01}` sweep -- see [Testing](#testing). For an idle stream, `advance(now)` (and the zero-box `advanceFrom(buf, i)`) expires the window edge with no value added, so `count()` an hour later reflects the empty window instead of the last burst (R11 idle-slide, 0 B/op).
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

## SlidingHyperLogLog

Count the *distinct* keys in the last `W` -- "how many distinct phases / sources / signatures in the recent window?" -- in fixed preallocated space at HyperLogLog accuracy. `SlidingHyperLogLog` is the recency sibling of `@zakkster/lite-sketch`'s cumulative HyperLogLog: an `m = 2^p` register bank where each register, instead of a single `rho` byte, keeps a small fixed **LFPM ring** (List of Future Possible Maxima) of `(timestamp, rho)` entries -- a per-register monotonic deque with strictly decreasing `rho`. A register's windowed max `rho` equals the HLL register of the in-window distinct key set, so accuracy is the standard `1.04 / sqrt(m)` standard error, no extra bias.

```js
import { SlidingHyperLogLog } from '@zakkster/lite-adaptive';

const shll = new SlidingHyperLogLog(60000, { p: 10 });   // distinct keys in the last 60s (m = 1024)
shll.add(now, userId);                                    // monotone now (ms), safe-integer key
// ... a stream of (now, key) ...
shll.count();                 // windowed distinct estimate over the last W
shll.count(5000);             // distinct over the last 5s (a sub-window w in (0, W])
shll.standardError;           // 1.04 / sqrt(m), guaranteed while !degraded
shll.degraded;                // false while every register ring held every windowed maximum
```

On `add(now, key)`, an inline two-lane murmur hash (design-parity with lite-sketch's HyperLogLog, never a dep) maps the key to a register and a `rho`; the entry is appended to that register's ring after dropping every dominated tail entry (a newer arrival with `>= rho` outlives an older one, so the older can never be a future window-max). `count(w?)` lazily expires entries with `stamp <= now - W`, takes each register's live max `rho`, and runs Ertl's improved estimator (`sigma` / `tau`) -- all 0-alloc on the hot path, incl. the windowed eviction.

<details>
<summary>The honest-degradation signal</summary>

The per-register ring is a fixed `ringCap` (default 8). If a register receives more than `ringCap` still-in-window maxima at once, the ring drops its oldest entry and bumps `overflows`, after which that register's windowed max can be understated -- so the `1.04 / sqrt(m)` bound is no longer guaranteed. `degraded` (true once `overflows > 0`) reports this honestly rather than silently returning a wrong count; raise `ringCap` (or lower `p`) to make overflow impossible for your rho-churn. The windowed-distinct witness gates the relative error vs an exact windowed `Set` oracle at `3 * 1.04/sqrt(m)` on 100% of >= 2000 queries across a `W`-sweep + a distinct-set shift + a post-burst edge, AND asserts `degraded === false`; a no-expiry variant (stale keys counted forever) and a no-dominated-drop variant (a plain FIFO ring) are rejected by the same gate -- see [Testing](#testing). `advance(now)` moves the lazy-expiry clock forward with no key added (O(1), 0 B/op, the ring untouched so `overflows` / `degraded` are unaffected), so an idle window's `count()` slides to empty (R11 idle-slide).
</details>

Driven by a caller-supplied monotone `now` (or count mode when `now` is omitted); the mode locks at the first add. Keys are safe integers; a bad `W` / `p` / `ringCap` / `seed` / key / `now` throws `[lite-adaptive]` typeof-first, before any allocation. `addFrom(buf, i)` is the zero-box entry (`now = buf[i]`, `key = buf[i+1]` read unboxed from a `Float64Array`) for fractional / epoch-ms timestamps and large safe-integer keys.

## DriftDetector

Answer one question -- "did the mean of *this* signal just shift?" -- in `O(1)` state: six scalars, no pool, no window (the lightest member). `DriftDetector` is the scalar, item-based companion to ADWIN: where ADWIN keeps a variance-carrying bucket window and auto-adapts its size, `DriftDetector` keeps only a running mean and one or two bounded test accumulators and returns `true` the moment the mean shifts. Run one per channel when you have many streams and only need a change flag, not the adapted window. A single class selects one of two classical tests via a **mode const** -- and the two differ in their *reference*, which is what makes the flag load-bearing:

```js
import { DriftDetector, DRIFT_PH, DRIFT_CUSUM } from '@zakkster/lite-adaptive';

// Page-Hinkley: no known baseline -- it learns the reference online (the running mean).
const ph = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 50 });
for (const x of latencies) if (ph.add(x)) markRegimeChange();   // true EXACTLY on the shift

// CUSUM: you KNOW the in-control mean -- alarm on departure from a fixed target mu0.
const cs = new DriftDetector(DRIFT_CUSUM, { target: 200, delta: 0.5, threshold: 8 });
cs.add(x);          // two accumulators floored at 0; either crossing `threshold` fires
cs.statistic;       // how close to firing (>= 0); crosses `threshold` when add() returns true
cs.mean;            // the running mean of the signal (observability; CUSUM tests vs `target`)
```

- **`DRIFT_PH`** (Page-Hinkley; Page 1954, Mouss et al. 2004) -- references the **online running mean**: it accumulates the deviation of each `x` from the mean it has learned so far and watches the gap between the cumulative sum and its running extreme; a persistent one-directional drift makes the gap exceed the threshold `lambda`. Two-sided (an upward accumulator against its running min, a downward one against its running max). Use it when you have **no known baseline** -- it tracks a slow ramp and stays quiet.
- **`DRIFT_CUSUM`** (two-sided CUSUM; Page 1954) -- references a **fixed target `mu0`** (the classic SPC in-control mean, a required option): two accumulators, each floored at 0, grow only while the signal departs `mu0` past the slack `delta`; either exceeding the decision interval `threshold` fires. Use it when you **know the target** -- a *sustained* departure from `mu0` keeps alarming, and it goes quiet only when the signal returns to `mu0`.

> Why the reference matters: under a *shared* running-mean reference the two rules compute a mathematically identical statistic (CUSUM's floor-at-0 recursion is exactly Page-Hinkley's cumulative-sum-minus-running-min). PH's adaptive reference and CUSUM's fixed `mu0` are what make the modes genuinely diverge -- on a slow mean ramp PH fires a handful of times while CUSUM (vs a fixed `mu0`) fires on nearly every item. See ADR 0007.

On a positive detection the accumulators + running mean are **reset** (the standard PH / CUSUM discipline; the fixed `target` is preserved) so the detector recalibrates and catches the *next* transient shift. Both `add(x)` and the zero-box `addFrom(buf, i)` (reads `x = buf[i]` unboxed from a `Float64Array` for fractional signals) are 0 B/op -- no pool to reshape, just a Welford mean update and one mode branch.

<details>
<summary>Fail-closed domain (the ADWIN finite-overflow lesson)</summary>

`add(x)` rejects a non-finite `x` and any finite `|x| > DD_X_MAX` (`1e150`) as a byte-identical no-op, so the running accumulators can never be driven to a non-finite value (each add moves them by `~2 * DD_X_MAX`, and both are bounded between resets -- reaching `Double.MAX` would need `~1e158` un-fired adds). `delta` is capped at the same bound at the ctor door, because each add also moves the accumulators by `~delta` -- an uncapped pathological `delta` would overflow them in a few adds and `add()` would silently stop firing (a fail-open boolean). As defense-in-depth, the `mean` / `statistic` getters throw `[lite-adaptive]` if any accumulator is ever non-finite, never a silent `0` / `NaN`. `delta = 0` is a valid, meaningful setting (no dead-band), guarded as `!== undefined` -- null is not zero.
</details>

Item-indexed (no clock). `delta` is the magnitude the test ignores (widens the dead-band -> fewer detections, higher latency); `threshold` trades detection latency against false alarms. A bad `mode` / `delta` / `threshold` / option throws `[lite-adaptive]` at the ctor door, before any field init. `DDM` / `EDDM` are deliberately out of this class -- they consume a Bernoulli *error-bit* stream and emit a tri-state (stable / warning / drift) output, a different contract from `add(x) -> boolean`, and belong in a future member.

## SlidingDDSketch

Answer "what's p50 / p99 *over the last `W`*?" in fixed preallocated space at DDSketch accuracy. `SlidingDDSketch` is the recency sibling of `@zakkster/lite-sketch`'s cumulative DDSketch: it keeps a ring of `panes` preallocated DDSketch panes (default 32), each covering `W / panes` of the window. Every pane maps a value to the same DDSketch bin -- `key = ceil(log_gamma(value))` with `gamma = (1 + alpha) / (1 - alpha)` -- so a merge across panes is just an element-wise bin sum, and the relative error of any reported quantile stays `<= alpha` (identical mapping, collapse and getters to lite-sketch, so a consumer pre-checks a value's indexable range exactly as it does there).

```js
import { SlidingDDSketch } from '@zakkster/lite-adaptive';

const q = new SlidingDDSketch(60000, { alpha: 0.01, panes: 32 });   // p50/p99 over the last 60s, 1% rel-error
for (const [t, ms] of latencySamples) q.add(t, ms);                  // HOT, 0 B/op incl. pane rotate + clear

q.quantile(0.99);            // COLD; the windowed p99 within 1% relative error (NaN on an empty window)
const out = new Float64Array(2);
q.quantileInto([0.5, 0.99], out);   // 0-alloc render path: out = [p50, p99]
q.count();                   // the windowed population (0 on empty)
```

`add(now, value)` writes the current pane; when `now` crosses a pane boundary it rotates to the next pane and clears it with a `fill(0)` (0-alloc). A `now` jump of many pane-widths (an idle gap, an epoch-ms clock) clears at most `panes` panes -- the rotation is bounded, never a loop over the skipped span. `quantile` / `quantileInto` / `count` are cold reads that merge the live panes into an **instance-owned preallocated scratch** (never allocated per query); an empty window reads `NaN` with `count() === 0`, never a misleading `0`.

<details>
<summary>The pane ring, the edge error, and the counters</summary>

The window is **soft to within one pane width** `W / panes`: a value can survive up to `W / panes` past the strict window edge, in the pane that has not yet rotated out. That is the disclosed price of a fixed-memory sliding window over an exact `O(W)` sort; the default 32 panes puts the edge at ~3% of `W`, and it is the caller's knob (more panes -> tighter edge, linearly more memory). Per-pane bin counts are a `Uint32Array` that **saturates at `2^32 - 1`** (never wraps); the merge scratch sums the panes in `Float64`, so a merged window count stays exact well past `2^32`. Each pane collapses its lowest bins independently (the DDSketch `maxBins = 2048` bound), so the merged min-key can differ from a single sketch's -- the accuracy bound is therefore **witnessed**, not assumed. A value whose bin key would exceed `SLD_KEY_MAX` (`1 << 30`) is rejected fail-closed, so the bin index can never overflow.
</details>

`SlidingDDSketch` locks EXPLICIT vs COUNT mode at the first add (a switch throws), and `alpha` / `strict` / `panes` / `W` are validated typeof-first before any allocation. The windowed-quantile witness gates the relative error `<= alpha` vs an exact windowed-sorted-array oracle on 100% of `>= 2000` queries across a `W` x `alpha` sweep, a distribution shift, and a post-burst edge, and asserts the edge stays within one pane width; a no-expiry variant (stale out-of-window values counted) and a coarse `panes = 2` variant (the edge bound blows past `W / 32`) are rejected by the same gate -- see [Testing](#testing). `advance(now)` rotates + clears stale panes with no value added (0 B/op), so an idle window's `quantile` reads `NaN` (and `count()` reads 0) instead of freezing on the last burst (R11 idle-slide).

## SlidingCountMin

Answer "how many times did key `k` occur *over the last `W`*?" in fixed memory at Count-Min accuracy. `SlidingCountMin` is the recency sibling of `@zakkster/lite-sketch`'s cumulative CountMinSketch: a ring of `B+1` panes (default `panes` B = 32), each a `d x w` `Uint32` counter grid, every pane aligned to absolute time (`pane = floor(now / (W/B))`). A key hashes to one cell per row in the *current* pane; a query sums the key's cell across the live panes per row and takes the min over rows.

```js
import { SlidingCountMin } from '@zakkster/lite-adaptive';

// per-label event rate over the last 60s, ~1% relative error. One SHARED instance across channels:
const cm = new SlidingCountMin(60000, { epsilon: 0.01, delta: 0.01 });
const key = channelIdx * 2 ** 32 + tag;          // a composite SAFE-INTEGER key (channelIdx < 2^21)
for (const [t, k] of events) cm.add(t, k);       // HOT, amortized 0 B/op incl. the pane rotate

cm.estimate(key);            // COLD; the windowed count for this label (a double; 0 if unseen -- never throws)
cm.advance(latestTime);      // at render: slide the window so an idle label decays to 0 (R11)
```

The live panes cover a span in `[W, W + W/B]` -- always the full window, plus at most one extra pane -- and the partially-expired oldest pane is **kept, never dropped**. That is what keeps the estimate a **one-sided upper bound**: `true(W) <= estimate <= true(W + W/B) + epsilon * N`. Dropping the oldest pane would under-count and silently break the Count-Min contract (an estimate is supposed to never be *below* the truth). The edge is the `W/B` of extra span the newest-plus-oldest panes admit -- disclosed, the price of a fixed-memory window.

<details>
<summary>The pane ring, saturation, and conservative update</summary>

Counters are a `Uint32Array` per pane that **saturates at `2^32 - 1`** (never wraps); a `saturated` getter counts saturated increments (the honesty flag, like `SlidingHyperLogLog`'s `degraded`). Because a *windowed* sum across panes can exceed `2^32`, `estimate` returns a **double**. `add` rotates + `fill(0)`-clears stale panes as `now` crosses pane boundaries -- amortized 0 B/op, bounded to `B+1` clears even on a huge `now` jump (an idle gap or epoch-ms clock never loops over the skipped span). **Conservative update** (`conservative`, default `true`) is applied *per pane* (min-increment over the current pane's `d` cells) -- a sum of per-pane overestimates is still an overestimate and stays `O(d)`, so it never runs over window sums. The hash, seed, `epsilon`/`delta` sizing and saturation are design-parity with lite-sketch's CountMinSketch (inlined, not a dependency), so a consumer pre-checks and swaps between them identically. Memory is `(B+1) * d * w * 4 B`, fixed at construction.
</details>

`SlidingCountMin` locks EXPLICIT vs COUNT mode at the first add (a switch throws); `W` / `epsilon` / `delta` / `w` / `d` / `panes` / `seed` are validated typeof-first before any allocation. Keys are safe integers (a non-safe-integer key throws on `add`/`addFrom` but `estimate` never throws -- it returns 0, so a render path can query freely). The windowed-frequency witness gates the one-sided bound `true(W) <= est <= true(W + W/B) + epsilon * N` on 100% of `>= 2000` queries across a `W` x `epsilon` sweep and a churny key stream; a drop-oldest-pane variant (under-counts, breaking the lower bound) and a min-then-sum variant (mis-estimates) are rejected by the same gate -- see [Testing](#testing). `advance(now)` rotates out stale panes with no increment, so an idle key's `estimate` slides to 0 instead of freezing (R11 idle-slide).

## DecayedReservoir

Every other member answers *one* pre-decided question. `DecayedReservoir` hands you `k` **actual retained values** biased toward the recent, and you compute *anything* over them -- any quantile, any custom function -- approximately. It is the sampling complement to `ForwardDecay`: FD gives decayed *aggregates* exactly (two scalars), this gives a decayed *sample* (`k` slots). An item's probability of being retained decays exponentially with its age (halves every `halfLife`), so at any moment the sample is a decay-weighted draw of the recent stream.

```js
import { DecayedReservoir } from '@zakkster/lite-adaptive';

// a 64-value recency-biased sample; items age out over a ~30s half-life
const r = new DecayedReservoir(64, 30000, { seed: 1 });
for (const [t, latencyMs] of events) r.add(t, latencyMs);   // HOT, amortized 0 B/op

const buf = new Float64Array(64);
const n = r.sampleInto(buf);            // 0-alloc: copy the retained values out, returns the count
// ...now compute whatever you like over buf.subarray(0, n): a custom percentile, a trimmed mean, a histogram
r.forEach((v) => accumulate(v));        // or iterate the sample alloc-free
```

Under the hood it is an Efraimidis-Spirakis **A-Res** weighted reservoir over ForwardDecay weights. Each accepted item draws one seeded xorshift32 uniform `u` and forms an A-Res key **in log space** -- `log(u) * exp(-lambda * (t - L))` -- which is numerically stable (it underflows toward 0 as an item ages, instead of `exp(+...)` overflowing to `Infinity`). The `k` highest keys are held in an intrusive size-`k` **min-forest** (design-parity with `HeavyKeeper` / lite-o1 `FreqO1`, inlined -- never a dependency): a new item that beats the forest root replaces it and sifts down. Recent items get keys nearer the top, so they win -- that is the decay bias.

<details>
<summary>The order-preserving rebase, and why there is no <code>advance()</code></summary>

As `now` advances from the landmark `L`, `exp(-lambda * (t - L))` shrinks toward 0. When `lambda * (t - L)` exceeds `DR_EXP_CAP` the landmark rebases and a single scalar factor is folded into every stored key at once -- a **monotone** transform, so the retained-set membership and the forest order are **unchanged**. That means the rebase is `O(1)` scalar work, not an `O(k)` sweep, and it is 0 B/op. A very large idle gap then a resume caps the rebase factor argument (`DR_F_CAP`) so a single rebase stays finite; back-to-back capped rebases while the heap is not yet full can drive an ancient stored key to `-Infinity`, which is benign by design -- no `NaN`, the sampled *values* stay finite, and those ancient items simply sink and evict first, deterministically. Because decay is applied **at insert** and membership is fixed thereafter, an idle stream correctly *holds* its last decayed sample -- there is nothing to slide to empty, so (exactly like `ForwardDecay`) `DecayedReservoir` has **no `advance()`**. Memory is `k * 16 + 64` bytes (two `Float64Array(k)` columns + scalars), fixed at construction.
</details>

`DecayedReservoir` locks EXPLICIT vs COUNT mode at the first add (a switch throws); `k` / `halfLife` / `seed` are validated typeof-first before any allocation. `value` is any finite real (signed OK; default 1); a mode switch, a non-finite / decreasing `now`, or a non-finite value is a byte-identical no-op that does **not** advance the PRNG or the landmark. The recency-sample witness gates the empirical inclusion rate by item age against the `exp(-lambda * age)` expectation over many seeds; a no-decay (uniform) reservoir (rejected by the slope fit) and a no-forest ("keep the first `k`") reservoir (rejected because its newest-age inclusion rate is ~0) are both rejected by the witness, and a long-idle-then-resume lane asserts the sample stays well-defined -- see [Testing](#testing). `add` / `addFrom` / `sampleInto` / `clear` are torture-gated at 0 B/op (incl. a rebase-heavy lane).

## API reference

```js
new ExponentialHistogram(W, epsilon, options?)

add(now?, value?) -> this   // HOT, 0 B/op incl. merge cascade + expire
addFrom(buf, i) -> this     // HOT, 0 B/op: zero-box packed [now, value] entry (now = buf[i], value = buf[i+1])
advance(now) -> this        // HOT, 0 B/op; move time to `now` with NO add -- expire the window edge (idle-slide, R11)
advanceFrom(buf, i) -> this // HOT, 0 B/op ZERO-BOX: now = buf[i] (explicit-time)
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

// SlidingHyperLogLog -- windowed distinct-count (fixed-space HLL over the last W)
new SlidingHyperLogLog(W, options?)         // options: { p, ringCap, seed }
add(now, key) -> this          // HOT, 0 B/op incl. windowed eviction; monotone now, safe-int key
addFrom(buf, i) -> this        // HOT, 0 B/op ZERO-BOX: now = buf[i], key = buf[i+1] (explicit-time)
advance(now) -> this           // HOT, O(1), 0 B/op; move time to `now` with NO add (clock-only; count() slides, idle-slide R11)
advanceFrom(buf, i) -> this    // HOT, 0 B/op ZERO-BOX: now = buf[i] (explicit-time)
count(w?) -> number            // COLD, O(m); windowed distinct via Ertl's estimator; w in (0, W]
query() -> number              // COLD; alias of count() over the full window W
clear() -> this                // 0-alloc reset (reuse the rings; unlocks the mode)

// getters
W   p   m   ringCap   seed   standardError   lastNow   mode   overflows   degraded   bytes

// DriftDetector -- scalar change detection (Page-Hinkley / two-sided CUSUM) in O(1) state
new DriftDetector(mode, options?)           // mode: DRIFT_PH | DRIFT_CUSUM; options: { delta, threshold, target }
                                            //   target: REQUIRED for CUSUM (fixed mu0), FORBIDDEN for PH
add(x) -> boolean              // HOT, 0 B/op; true EXACTLY on the detecting item, then resets
addFrom(buf, i) -> boolean     // HOT, 0 B/op ZERO-BOX: x = buf[i] read unboxed (fractional signals)
clear() -> this                // 0-alloc reset of all scalar state (keeps mode / delta / threshold / target)

// getters
mode   delta   threshold   target   count   mean   statistic

// SlidingDDSketch -- windowed relative-error quantiles (fixed-space DDSketch over the last W)
new SlidingDDSketch(W, options?)            // options: { alpha, strict, panes }
add(now, value) -> this        // HOT, 0 B/op incl. pane rotate + clear; monotone now, DDSketch-domain value
addFrom(buf, i) -> this        // HOT, 0 B/op ZERO-BOX: now = buf[i], value = buf[i+1] (explicit-time)
advance(now) -> this           // HOT, 0 B/op; move time to `now` with NO add -- rotate/clear panes (idle-slide, R11)
advanceFrom(buf, i) -> this    // HOT, 0 B/op ZERO-BOX: now = buf[i] (explicit-time)
quantile(q, w?) -> number      // COLD; windowed quantile for q in [0,1]; NaN on empty; w in (0, W]
quantileInto(qs, out) -> number// COLD, 0-alloc; write each qs[j]'s quantile into out; returns the count
count(w?) -> number            // COLD; windowed population (0 on empty); w in (0, W]
clear() -> this                // 0-alloc reset (reuse the panes; unlocks the mode)

// getters
W   panes   alpha   strict   minIndexable   maxIndexable   collapsed   mode   lastNow   bytes

// SlidingCountMin -- windowed per-label frequency (fixed-space Count-Min over the last W, B+1 pane ring)
new SlidingCountMin(W, options?)            // options: { epsilon, delta, w, d, panes, seed, conservative }
add(now, key, count=1) -> this // HOT, amortized 0 B/op incl. pane rotate; safe-int key, count saturates at 2^32-1
addFrom(buf, i) -> this        // HOT, 0 B/op ZERO-BOX: stride-3 [now, key, count] (explicit-time)
advance(now) -> this           // HOT, amortized 0 B/op; move time to `now` with NO add -- rotate stale panes (idle-slide, R11)
advanceFrom(buf, i) -> this    // HOT, 0 B/op ZERO-BOX: now = buf[i] (explicit-time)
estimate(key, w?) -> number    // COLD, O(d*(B+1)); sum-then-min over live panes; a DOUBLE; NEVER throws (0 if unseen); w in (0, W]
clear() -> this                // reset; reuse the arrays (unlocks the mode)

// getters
d   w   panes   W   seed   conservative   saturated   epsilon   delta   mode   lastNow   bytes

// DecayedReservoir -- recency-biased fixed-k sample of actual values (A-Res weighted reservoir over forward-decay weights)
new DecayedReservoir(k, halfLife, options?) // options: { seed }; k a positive int; halfLife finite > 0
add(now, value=1) -> this      // HOT, amortized 0 B/op incl. PRNG draw + forest sift + rebase; any finite real value (signed OK)
addFrom(buf, i) -> this        // HOT, 0 B/op ZERO-BOX: stride-2 [now, value] (explicit-time)
sampleInto(buf) -> number      // COLD, 0-alloc; copy the retained VALUES into buf (Float64Array, length >= k); returns the count
forEach(fn) -> void            // alloc-free; fn(value) per retained value (heap order, not sorted)
clear() -> this                // reset; reuse the columns (unlocks the mode; replays the PRNG)
// no advance() -- a sample, not a hard window (like ForwardDecay)

// getters
k   halfLife   lambda   seed   size   mode   bytes
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

- **`SlidingHyperLogLog(W, { p, ringCap, seed })`** -- `W` the window (items in count mode, or the `now`-unit span in explicit mode); `p` the precision (int `[4, 16]`, default 10, `m = 1 << p`); `ringCap` the per-register LFPM ring capacity (a power of two `[2, 64]`, default 8). A bad `W` / `p` / `ringCap` / `seed` / option throws `[lite-adaptive]` typeof-first, before any allocation.
- **`options.seed`** -- the `Uint32` hash seed (default `0x9e3779b1`); `seed = 0` is a valid distinct seed (guarded as `undefined`, not falsy). There is NO PRNG -- the estimate is fully deterministic given the seed.
- **`add(now, key)`** -- `now` a finite, non-decreasing number (a decrease throws); `key` a SAFE INTEGER. Count mode (`add(undefined, key)`) auto-ticks. The mode locks at the first add (a switch throws); a bad `now` / key is a byte-identical no-op.
- **`count(w?)`** -- the windowed distinct estimate; `w` an optional sub-window in `(0, W]` (outside that range throws). `standardError` is `1.04 / sqrt(m)`, guaranteed while `degraded === false`.
- **`degraded` / `overflows`** -- the honest-accuracy signal: `overflows > 0` (a ring dropped a still-in-window maximum) sets `degraded`, after which the bound is no longer guaranteed. Raise `ringCap` to make overflow impossible for your rho-churn.

Constants that shape the register bank:

| Symbol | Value | Meaning |
|--------|-------|---------|
| `p` | precision (`[4, 16]`, default 10) | `m = 2^p` registers; standard error `1.04 / sqrt(m)` |
| `ringCap` | ring size (`[2, 64]`, default 8) | per-register LFPM maxima kept in-window; overflow -> `degraded` |
| space | `~ m * ringCap * 9 B` | `Float64` stamp + `Uint8` rho per ring slot + O(m) head/len; fixed (p=10 -> ~72 KB) |

- **`DriftDetector(mode, { delta, threshold, target })`** -- `mode` is `DRIFT_PH` or `DRIFT_CUSUM` (the two named-export mode consts); any other value throws `[lite-adaptive]` at the ctor door. `delta` (default `0.005`) a finite number in `[0, 1e150]`, `threshold` (default `50`) a finite number `> 0`; a bad `delta` / `threshold` / unknown option throws typeof-first, before any field init.
- **`target`** -- the fixed reference `mu0` for CUSUM: a finite number of any sign with `|target| <= 1e150`. **REQUIRED for `DRIFT_CUSUM`** (a CUSUM with no in-control mean is meaningless) and **FORBIDDEN for `DRIFT_PH`** (which self-references the running mean) -- a mismatch throws `[lite-adaptive]`, never a silent default or ignore. `target = 0` is valid (guarded `!== undefined`, not falsy).
- **`delta` / `threshold`** -- `delta` is the magnitude allowance (PH) / slack (CUSUM) the test ignores: `delta = 0` is a valid, meaningful setting (no dead-band), guarded as `!== undefined`, never falsy. `threshold` is the decision level (PH `lambda` / CUSUM decision interval) -- larger -> fewer false alarms, longer latency; tune it to the signal's scale.
- **`add(x)` / `addFrom(buf, i)`** -- `x` a finite number with `|x| <= 1e150`; both return `true` EXACTLY on the detecting item and reset the detector (the `target` is preserved). A non-finite / out-of-domain `x` (or, for `addFrom`, a non-`Float64Array` `buf` / out-of-range `i`) throws `[lite-adaptive]` as a byte-identical no-op.
- **`statistic` / `mean` / `target` / `count`** -- `statistic` (`>= 0`) is how close the detector is to firing (it crosses `threshold` when `add` returns true); `mean` is the running mean of the signal (the PH reference; an observability value for CUSUM, which tests vs `target`); `target` is the fixed CUSUM `mu0` (`undefined` for PH); `count` the items seen since the last reset. `statistic` / `mean` throw `[lite-adaptive]` if an accumulator ever went non-finite (fail-closed); both return `0` on empty.

Constants that shape the detector:

| Symbol | Value | Meaning |
|--------|-------|---------|
| `mode` | `DRIFT_PH` \| `DRIFT_CUSUM` | Page-Hinkley (adaptive running-mean reference) or two-sided CUSUM (fixed-target reference) |
| `target` | CUSUM: required, any finite real; PH: forbidden | the fixed in-control mean `mu0` CUSUM tests departure from |
| `delta` | default `0.005`, `[0, 1e150]` | magnitude allowance / slack the test ignores (widens the dead-band) |
| `threshold` | default `50`, `> 0` | decision level; latency vs false-alarm trade-off |
| space | `O(1)` (six scalars) | no pool, no window; 0 B/op on `add` / `addFrom` / `clear` |

- **`SlidingDDSketch(W, { alpha, strict, panes })`** -- `W` the window (items in count mode, or the `now`-unit span in explicit mode), a finite number `> 0`; `alpha` the relative-error knob in `(0, 1)` (default `0.01`); `panes` the ring size, an integer `>= 2` (default 32; the window is soft to within `W / panes`). A bad `W` / `alpha` / `strict` / `panes` / option throws `[lite-adaptive]` typeof-first, before any allocation. `alpha` is an option here (the `(W, options)` convention), where lite-sketch's cumulative `DDSketch` takes it as the leading positional -- the mapping and accuracy contract are otherwise identical.
- **`add(now, value)`** -- `now` a finite, non-decreasing number (a decrease throws); `value` in the DDSketch domain (the same zero / `-0` / negative policy as lite-sketch `DDSketch`). Count mode (`add(undefined, value)`) auto-ticks. The mode locks at the first add (a switch throws); a bad `now` / `value`, or a `value` whose bin key would exceed `SLD_KEY_MAX` (`1 << 30`), is a byte-identical no-op.
- **`quantile(q, w?)` / `quantileInto(qs, out)`** -- `q` in `[0, 1]` (outside throws); an empty window returns `NaN` (never `0`). `w` an optional sub-window in `(0, W]` (outside throws). `quantileInto` is the 0-alloc render path -- it writes each `qs[j]`'s quantile into the caller's `out` and returns the count written. Both merge the live panes into an instance-owned scratch (cold, 0-alloc).
- **`minIndexable` / `maxIndexable` / `collapsed` / `strict`** -- the DDSketch accuracy-range getters, identical in name and meaning to lite-sketch: `[minIndexable, maxIndexable]` is the value range the sketch can represent within `alpha`, `collapsed` reports whether any pane collapsed its lowest bins, and `strict` (default `false`) opts out of collapse (fail-closed on an out-of-range value instead). A consumer pre-checks a value against `[minIndexable, maxIndexable]` exactly as it does for lite-sketch `DDSketch`.

Constants that shape the pane ring:

| Symbol | Value | Meaning |
|--------|-------|---------|
| `alpha` | default `0.01`, `(0, 1)` | relative-error knob; `gamma = (1 + alpha) / (1 - alpha)`, `key = ceil(log_gamma(value))` |
| `panes` | default 32, `>= 2` | ring size; the window is soft to within one pane width `W / panes` (~3% at 32) |
| `maxBins` | 2048 (`SLD_MAX_BINS`) | per-pane bin bound (matches lite-sketch's default); lowest bins collapse past it |
| space | `panes * maxBins * 4 B` + scratch | `Uint32` bin counts per pane (saturating at `2^32-1`) + a `Float64` merge scratch |

- **`DecayedReservoir(k, halfLife, { seed })`** -- `k` the sample size, a positive integer; `halfLife` a finite number `> 0` (`lambda = ln2 / halfLife`); `seed` a `Uint32` for the A-Res PRNG (default `0x9e3779b1`; `seed = 0` valid, guarded `!== undefined`). A bad `k` / `halfLife` / `seed` / option throws `[lite-adaptive]` typeof-first, before any allocation. There is no `advance()` -- a reservoir is a sample, not a hard window (like `ForwardDecay`).
- **`add(now, value)` / `addFrom(buf, i)`** -- `now` a finite, non-decreasing number (a decrease throws); count mode (`add(undefined, value)`) auto-ticks. The mode locks at the first add (a switch throws). `value` is ANY finite real (signed OK; default 1). A mode switch, a bad `now`, or a non-finite value is a byte-identical no-op that does NOT advance the PRNG or the landmark; `addFrom` reads a packed stride-2 `[now, value]` unboxed (explicit-time only).
- **`sampleInto(buf)` / `forEach(fn)`** -- `sampleInto` copies the retained sample VALUES into a caller `Float64Array` of length `>= k` (0-alloc) and returns the count written (`size`, `<= k`); `forEach(fn)` calls `fn(value)` per retained value, alloc-free. Both read in heap order, NOT sorted -- the caller computes any statistic over the sample itself.

Constants that shape the reservoir:

| Symbol | Value | Meaning |
|--------|-------|---------|
| `k` | sample size, `>= 1` | the number of values retained; the min-forest has `k` slots |
| `halfLife` | finite `> 0` | a retained item's weight halves over this span; `lambda = ln2 / halfLife` |
| `DR_EXP_CAP` | 40 | the `exp()` argument ceiling that triggers the order-preserving landmark rebase |
| space | `k * 16 + 64 B` | two `Float64Array(k)` columns (value + A-Res key) + scalars; fixed at construction |

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
- **The DriftDetector mode is the *reference*, and it is load-bearing.** Page-Hinkley and CUSUM share the contract -- a real-valued `add(x) -> boolean` -- so they live behind one mode flag with a single hot body (a Welford mean + one branch). But under a *shared* reference the two rules are the identical statistic (CUSUM's floor-at-0 recursion is exactly PH's cumulative-sum-minus-running-min), so the modes differ by what they reference: PH the **online running mean** (no baseline needed), CUSUM a **fixed target `mu0`** (the SPC in-control mean). That is what makes the flag meaningful, and the witness gates the divergence so a regression back to one statistic is rejected (see ADR 0007). DDM / EDDM take a Bernoulli error bit and emit a tri-state signal -- an incompatible contract -- so they were deliberately deferred to a future member. The `delta` (and `target`) caps mirror the `x` cap so a pathological config can never turn `add` into a fail-open boolean.
- **SlidingDDSketch is a pane ring, not an EH-of-sketches, and that is a zero-GC decision.** A windowed quantile wants to expire old values without an `O(W)` sort. The exact-edge option -- a DGIM / exponential-histogram *of DDSketches* -- has to *merge* sketches on `add`, which allocates; and Arasu-Manku true windowed quantiles keep unbounded per-item state. Both fail the 0-B/op contract. A fixed ring of `panes` preallocated sketches keeps `add` allocation-free (rotate + `fill(0)`, bounded even on a huge `now` jump) and merges only at query, into an instance-owned scratch. The cost is an honest, disclosed edge -- the window is soft to within one pane width `W / panes` -- and because each pane collapses its lowest bins independently, the merged accuracy is *witnessed* against an exact oracle rather than assumed (see ADR 0008).
- **Idle streams still slide (`advance`, R11).** A windowed query is anchored to the last applied time, so a stream that goes quiet would keep reporting its last burst forever. `advance(now)` (and the zero-box `advanceFrom(buf, i)`) move that reference time forward with NO value added -- expiring the window edge (`ExponentialHistogram`), sliding the lazy-expiry clock (`SlidingHyperLogLog`), or rotating out stale panes (`SlidingDDSketch`) -- so an idle channel's readout empties instead of lying. It keeps queries pure (they never mutate); the sliding is an explicit, 0-B/op step the consumer calls at render. `ADWIN` / `DriftDetector` are item-indexed (no clock, so no `advance`), and `ForwardDecay` already takes an optional `now` on its pure queries -- the two sanctioned ways to satisfy R11 (see ADR 0009).
- **SlidingCountMin keeps the oldest pane on purpose -- the one-sided bound is the point.** A Count-Min estimate must never be *below* the truth (that is the guarantee consumers rely on). So the windowed version uses `B+1` panes and INCLUDES the partially-expired oldest one, covering a span in `[W, W + W/B]` -- it may count a little *extra* (bounded by one pane width), but it never under-counts. Dropping the oldest pane to make the window exact would silently break that lower bound. The query is sum-then-min (sum a key's cells across panes per row, then min over rows), and conservative update is applied per pane so it stays `O(d)` and still an overestimate. The per-cell-EH alternative (the ECM-sketch) is rejected in ADR 0010 for its ~6 MB footprint -- a fixed pane ring is the zero-GC choice, same as SlidingDDSketch.

## Testing

- `npm test` -- the `node:test` behavioral + fail-closed suite across every member (ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog, DriftDetector, SlidingDDSketch, SlidingCountMin, DecayedReservoir): ctor validation before allocation, mode-lock both ways, monotone-`now`, signed values, the landmark rebase, query-now contract, drift detection + reset, windowed-quantile / windowed-frequency / recency-sample / empty-window contracts, and the no-op regressions (a rejected add is byte-identical, and does not advance the reservoir PRNG or landmark).
- `npm run witness` -- the recency witness: the windowed error vs the `epsilon` bound (EH) + the change-response gates (ADWIN) + the exact-aggregate gate `|fd - oracle| / |oracle| <= 1e-9` (ForwardDecay) + the top-k recall / marquee (HeavyKeeper) + the windowed-distinct error vs a `Set` oracle (SlidingHyperLogLog) + the detection-latency / false-alarm gates (DriftDetector) + the windowed-quantile error `<= alpha` vs a sorted-array oracle with the edge bounded by one pane width (SlidingDDSketch) + the one-sided windowed-frequency bound `true(W) <= est <= true(W + W/B) + epsilon * N` vs an exact windowed oracle (SlidingCountMin) + the recency-sample inclusion rate by age matching `exp(-lambda * age)` over many seeds (DecayedReservoir), each with rejected negative controls (for DecayedReservoir: a no-decay uniform reservoir and a no-forest "keep the first k" reservoir).
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
- **Not a cumulative distinct-count.** SlidingHyperLogLog counts distinct keys in the last `W` and forgets older ones; for a whole-stream distinct-count that never forgets, use `@zakkster/lite-sketch`'s HyperLogLog. `SlidingHyperLogLog` is the first additive post-1.0 member (1.1.0), landing without breaking the frozen core.
- **Not an error-rate / classifier-drift detector.** `DriftDetector` (Page-Hinkley / CUSUM) watches the mean of a *real-valued* signal and returns a boolean; the DDM / EDDM family that consumes a Bernoulli *error-bit* stream and emits a tri-state (stable / warning / drift) output is a different contract and belongs in a future member. `DriftDetector` is also not an *adaptive-window* detector -- for the auto-grown / auto-shrunk window (and the current mean / variance / width of it), use ADWIN; `DriftDetector` is the cheaper `O(1)`-state per-channel change flag (the second additive post-1.0 member, 1.2.0).
- **Not a cumulative or an exact quantile.** `SlidingDDSketch` answers quantiles over the last `W` and forgets older values; for a whole-stream quantile that never forgets, use `@zakkster/lite-sketch`'s DDSketch. It *estimates* within `alpha` relative error (not an exact percentile -- that needs an `O(W)` sort you can hold), and its window is soft to within one pane width `W / panes` (the disclosed edge). It is the third additive post-1.0 member (1.3.0), landing without breaking the frozen core.
- **Not a cumulative or an exact frequency counter.** `SlidingCountMin` answers per-label counts over the last `W` and forgets older ones; for a whole-stream frequency that never forgets, use `@zakkster/lite-sketch`'s CountMinSketch. It is an *overestimate* (a one-sided upper bound, tight to `~epsilon * N`), never exact; and it counts by key, not by rank -- for the *top-k heavy hitters* use HeavyKeeper. It is the fourth additive post-1.0 member (1.5.0).
- **Not a decayed aggregate, and not a hard-window sample.** `DecayedReservoir` gives you `k` actual retained values (a recency-biased *sample*) to compute anything over; for decayed *aggregates* exactly (count / sum / mean / rate), use `ForwardDecay` -- the reservoir approximates any function, FD computes a fixed few exactly. It is a *sample*, not a hard window: it has no `advance()` and an idle stream holds its last decayed sample (rather than sliding to empty). The inclusion probability is proportional to a decay weight, so it is a *weighted* sample, not a uniform one. It is the fifth additive post-1.0 member (1.6.0), completing the confirmed post-1.0 roadmap.

## Ecosystem

Part of the `@zakkster/*` suite of zero-GC, single-file ESM micro-libraries:

- **[@zakkster/lite-o1](https://www.npmjs.com/package/@zakkster/lite-o1)** -- exact O(1) data structures (incl. exact windowed folds).
- **[@zakkster/lite-sketch](https://www.npmjs.com/package/@zakkster/lite-sketch)** -- cumulative approximate summaries (HyperLogLog, CountMinSketch, DDSketch, SpaceSaving).
- **[@zakkster/lite-filter](https://www.npmjs.com/package/@zakkster/lite-filter)** -- approximate membership (Bloom-family filters).
- **@zakkster/lite-adaptive** -- windowed / decayed / drift summaries over the recency axis (this package).

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
