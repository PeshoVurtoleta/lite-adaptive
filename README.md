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

## The recency family the ecosystem was missing

Exact analytics over an unbounded, EVOLVING stream cost unbounded memory: to answer "how many events in the last W" exactly you must buffer the whole window (O(W) items). Worse, most summaries are CUMULATIVE -- they fold the whole stream and never forget, so they cannot tell you what is happening *right now*. `lite-adaptive` is a zero-dependency, zero-GC family of streaming summaries over the **time / recency** axis: it answers a recency question in *fixed* memory, and it can **forget**. Its signature is a shipped **recency witness** -- every member proves its MEASURED windowed error against the paper's THEORETICAL bound, next to the memory it saves.

It is the fourth corner of the suite: **[@zakkster/lite-o1](https://www.npmjs.com/package/@zakkster/lite-o1)** is *exact* O(1), **[@zakkster/lite-filter](https://www.npmjs.com/package/@zakkster/lite-filter)** is approximate *membership*, **[@zakkster/lite-sketch](https://www.npmjs.com/package/@zakkster/lite-sketch)** is *cumulative* approximate aggregates, and `lite-adaptive` is the *windowed / decayed / drift* complement. The line is recency: cumulative -> lite-sketch; last-W / decayed / drift -> lite-adaptive.

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

## API reference

```js
new ExponentialHistogram(W, epsilon, options?)

add(now?, value?) -> this   // HOT, 0 B/op incl. merge cascade + expire
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
clear() -> this             // reset to empty; reuse the pool

// getters
mean   variance   width   bucketCount   capacity   delta
```

- **`delta`** -- the confidence / false-alarm knob in `(0, 1)`; smaller means fewer false alarms and (disclosed) longer detection latency. Throws `[lite-adaptive]` before allocation on a bad `delta`.
- **`add(x)`** -- append a finite real `x` (item-indexed; no clock), run the ADWIN2 variance-aware cut over the bucket boundaries, and on a change DROP the older sub-window. Returns `true` exactly on the item that detects the change. Fail closed: a non-finite / non-number `x` is a byte-identical no-op.
- **`mean` / `variance` / `width`** -- the mean, variance, and item count of the CURRENT adaptive window; `width` shrinks on a detected change, then regrows while stable. Getters never throw (0 on an empty detector).

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
- **Fail closed, typeof-first, before allocation.** A bad `W` / `epsilon` / option throws at the constructor door before the pool is built; `null` is not zero; queries never throw.

## Testing

- `npm test` -- the `node:test` behavioral + fail-closed suite (17 tests: ctor validation, CAP/k/levels formulas, mode-lock both ways, monotone-`now`, exact ramp-up, full-window error, sum mode, pool-never-overflows).
- `npm run witness` -- the recency witness: measured windowed error vs the `epsilon` bound across the sweep + a shifting stream + the space-vs-oracle bar + a rejected broken-EH negative control.
- `npm run torture` -- the 0 B/op leak + GC-profiler gate on `add` including the merge / expire reshaping (`node --expose-gc`).
- `npm run test:perf` -- the flat-throughput perf gate + a must-allocate control.
- `npm run test:types` -- the ambient type-surface compile check.
- `npm run verify` -- all of the above (the release gate).

## What this is not

- **Not an exact windowed aggregator.** For an EXACT sliding-window sum / min / max over a monoid, use `@zakkster/lite-o1` (`WindowFold`, `MonoDeque`, `RingLog`) -- bounded-capacity and exact. `lite-adaptive` is the approximate, unbounded-window complement.
- **Not a cumulative sketch.** For whole-stream distinct-count / frequency / quantiles / top-k with no forgetting, use `@zakkster/lite-sketch`. The line is recency.
- **Not a wall-clock timer.** The member never reads the clock; the caller supplies a monotone `now`.
- **Not (yet) decay or decayed top-k.** ADWIN (drift + adaptive window) ships as of 0.2.0; ForwardDecay (time-decay) and HeavyKeeper (decayed top-k) are the remaining roadmap to 1.0.0.

## Ecosystem

Part of the `@zakkster/*` suite of zero-GC, single-file ESM micro-libraries:

- **[@zakkster/lite-o1](https://www.npmjs.com/package/@zakkster/lite-o1)** -- exact O(1) data structures (incl. exact windowed folds).
- **[@zakkster/lite-sketch](https://www.npmjs.com/package/@zakkster/lite-sketch)** -- cumulative approximate summaries (HyperLogLog, CountMinSketch, DDSketch, SpaceSaving).
- **[@zakkster/lite-filter](https://www.npmjs.com/package/@zakkster/lite-filter)** -- approximate membership (Bloom-family filters).
- **@zakkster/lite-adaptive** -- windowed / decayed / drift summaries over the recency axis (this package).

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
