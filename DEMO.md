# DEMO.md -- lite-adaptive interactive demo blueprint

The build spec for lite-adaptive's interactive demo. This document is the contract
the demo is built against; `demo/Demo.test.mjs` gates the build against the
assertions here. It mirrors `../LiteSketch/DEMO.md` verbatim in spine (header /
tabs / canvas stage + panel / 10Hz Truth Panel off a flat buffer) and diverges only
where the family story differs: lite-sketch proves ACCURACY-vs-bound + SPACE-vs-exact
on a CUMULATIVE stream; lite-adaptive proves the WINDOWED / DECAYED / DRIFT recency
witness against an O(W)/O(N) exact foil. Section 9 marks exactly what is
package-agnostic template (inherited) versus lite-adaptive-specific.

Repo-only. `demo/` is NOT added to package.json `files[]`; the npm tarball stays
7 files (the 6 `files[]` entries + package.json). Precedent: lite-o1, lite-sketch,
lite-filter all ship demos repo-only. ASCII-only source per suite law (`->`, `<=`,
`x` -- never Unicode, in code AND in the demo HTML text).

---

## 0. The two non-negotiables

lite-adaptive makes TWO honest claims, so the demo has TWO load-bearing proofs:

1. **The hot path is zero-GC** (the lite-o1 discipline). Therefore the demo MUST
   ITSELF be zero-GC on every animation frame, or its own Truth Panel is a lie. A
   demo that allocates per frame while claiming its subject does not is the single
   worst outcome; `demo/Demo.test.mjs` (Section 7) makes that impossible to ship
   silently. Corollary: the exact-oracle "vs" path is ALLOWED (indeed required) to
   allocate / retain -- that is the contrast.
2. **The estimate is honest against its recency bound.** lite-adaptive's identity is
   the RECENCY WITNESS: measured WINDOWED / DECAYED / DRIFT error vs the paper's
   theoretical guarantee, next to the memory saved. Every accuracy and space number
   the demo displays MUST be re-derived live from the SHIPPED `Adaptive.js` against a
   REAL exact oracle running in the same tab (a ring / a Map / a brute-force decayed
   recompute), never hardcoded and never faked. The witness runs in the browser
   exactly as `test/witness.mjs` runs headless. If the demo can ever draw a member
   inside its bound while the real error is outside it, the demo is a lie -- Section 7
   gates against that.

---

## 1. The template it mirrors

Model exactly on `../LiteSketch/demo/index.html` (itself modeled on `../LiteO1`).
Reuse the spine verbatim in shape: brand header + live VERSION; tab nav with a
`.scene-num`; one active `<section class="scene">` at a time = a `<canvas>` stage +
an `<aside class="panel">` (vs-oracle toggle, action, topology sliders, the Truth
Panel block). Canvas = brute-force high-DPI rAF hot loop; SVG/DOM Truth Panel =
declarative, updated at ~10Hz off a shared flat buffer, decoupled from the canvas.
A built-once rgba cache, reused scratch typed arrays, no per-tick allocating timer.

Accent swap: lite-adaptive uses **recency violet** (`#8b7cf6`), distinct from
lite-sketch's teal and lite-o1's, so the family reads as one chassis with a member
identity.

---

## 2. Roster -> scene map (all 9 shipped members demoed)

One scene per member. Each scene streams a pre-generated stream (a reused typed
array, no per-frame RNG alloc) into BOTH the member and a live exact oracle, and
shows: the member's fixed memory as a canvas render, the live recency answer vs the
oracle's exact answer, the measured error inside its witnessed bound, and the SPACE
gap (member fixed vs oracle growing).

| Scene | Member | Recency question | Canvas render | Oracle foil | Bound band | Space co-headline |
|-------|--------|------------------|---------------|-------------|------------|-------------------|
| 01 | **ExponentialHistogram** | how many in the last W? | live buckets on the [now-W, now] timeline | exact ring of in-window timestamps | HARD windowed `relerr <= epsilon` | cap*36 B fixed vs ring O(in-window) |
| 02 | **ADWIN** | has the stream CHANGED? | mean-over-time plot; window grows then SNAPS on drift | naive cumulative mean (never forgets) | false-alarm `<= delta`; adapted `|mean-mu| < 0.05` | cap*32 B fixed vs O(N) retained |
| 03 | **ForwardDecay** | what is happening RECENTLY? | decay kernel curve; decayed vs cumulative mean | brute-force decayed recompute over recent (t,v) | EXACT `relerr <= 1e-9` (modulo FP) | two scalars fixed vs samples O(W) |
| 04 | **HeavyKeeper** | which few keys dominate NOW? | k-counter top-k leaderboard | exact `Map` + faithful Space-Saving | recall 100% > N/k; `[true - N/w, true]` | hk.bytes fixed vs Map O(distinct) |
| 05 | **SlidingHyperLogLog** | how many DISTINCT in the last W? | windowed distinct-over-time (est vs exact) line | exact in-window `Map<key,count>` + (t,key) ring | `relerr <= 3 * 1.04/sqrt(m)`; not degraded | sl.bytes fixed vs Map O(distinct) |
| 06 | **DriftDetector** | has this SIGNAL shifted? | ONE signal, TWO channels (PH vs CUSUM) + fire markers | injected changepoints (ground truth); O(N) retained foil | mode load-bearing: PH fires << CUSUM on a ramp | two scalars fixed vs O(N) retained |
| 07 | **SlidingDDSketch** | what are the last-W QUANTILES? | log-bin p50/p90/p99 bars + alpha band | exact sorted-array over live pane content (PREALLOCATED buffer, no `.sort()`) | `relerr <= alpha`; edge `<= W/panes` | sd.bytes fixed vs samples O(W) |
| 08 | **SlidingCountMin** | how OFTEN did key k occur in the last W? | tracked-key est bars inside the one-sided band | exact per-key windowed (t,key) ring | `true(W) <= est <= true(W+W/B) + eps*N` | scm.bytes fixed vs ring O(W) |
| 09 | **DecayedReservoir** | give me k RECENT items | the k-sample by AGE (recent = left) | brute-force decayed sampler (retains O(N)) | inclusion rate by age `~ exp(-lambda*age)` | dr.bytes fixed vs O(N) retained |

---

## 3. Per-scene specification

### Scene 01 -- ExponentialHistogram (sliding-window count)
- A pre-generated dense -> sparse -> dense arrival stream (the `measureShift` shape)
  flies in via `addFrom([now, value])`; the live buckets are drawn on the
  `[now - W, now]` timeline (block height = `2^level` population), the oldest
  (straddling) bucket highlighted -- the only source of error. Window fills, buckets
  merge, old buckets expire off the left edge.
- **Bound band**: the HARD windowed `relerr <= epsilon` (reuse the `test/witness.mjs`
  measureCount / measureShift gate); the cursor is `relerr / epsilon`, must stay `<= 1`.
- Sliders: window `W`, error knob `epsilon`.

### Scene 02 -- ADWIN (drift + adaptive window)
- A stream drifting between two concept means. `ADWIN.addFrom` GROWS the window
  while stationary and SHRINKS it (the snap) the moment a mean shift is significant.
  Canvas plots `ad.mean` (violet, tracks the concept) vs a naive cumulative mean
  (dim, lags), red flashes at each cut, a window-width bar.
- **Bound band**: false-alarm rate `<= delta` on a stationary run (gated in the test);
  the on-screen witness is the adapted-mean band `|mean - mu| / 0.05` (the witness's
  adapted-window gate), cursor `<= 1` once settled.
- Slider: confidence `delta`.

### Scene 03 -- ForwardDecay (time-decayed aggregate)
- A stream whose value distribution shifts; `ForwardDecay.addFrom` keeps TWO scalars
  and folds age at query time (0 B/op incl. the landmark rebase). Canvas draws the
  exponential decay kernel and the decayed mean (recent-weighted) vs the cumulative
  mean (all-time) -- recent data dominates.
- **Bound band**: EXACT modulo FP -- `relerr <= 1e-9` (the `test/witness.mjs` FD_TOL);
  the cursor sits pinned at the far left. The landmark ticks up on each rebase and the
  queries are UNCHANGED across it (the invariance).
- Slider: `halfLife` (capped so the exact-oracle ring keeps the band exact).

### Scene 04 -- HeavyKeeper (heavy hitters / top-k)
- A Zipfian key stream; the k monitored counters are a live top-k leaderboard read via
  `topKInto` ([key, estimate] PAIRS, buffer `>= 2*k`). Each row: estimate bar, the
  `[true - N/w, true]` bracket, the true count marker (must sit inside), the `N/k`
  threshold line. `HeavyKeeper` never overestimates.
- **Bound band**: the headline is RECALL -- every true hitter above `N/k` is tracked
  (100%). The MARQUEE (proven on a DRIFTING stream in the test): HeavyKeeper's mean
  rel-error is far BELOW a faithful Space-Saving baseline of the same size.
- Slider: top-k `k` (drives the `N/k` threshold).

### Scene 05 -- SlidingHyperLogLog (windowed distinct-count)
- A key stream cycling over a fixed universe flies in via `addFrom([now, key])`; the
  canvas scrolls the windowed DISTINCT estimate (violet) against the exact in-window
  `Map` size (magenta). The register bank is a FIXED `m = 2^p`; the oracle keeps every
  in-window key. Idle-slide toggle -> `advanceFrom` empties the window to 0.
- **Bound band**: `relerr <= 3 sigma = 3 * 1.04/sqrt(m)` (reuse the `test/witness.mjs`
  slDrive gate), and `degraded === false`; the cursor is `relerr / 3-sigma`, `<= 1`.
- Sliders: window `W`, precision `p`. Pause-the-stream toggle (windowed member).

### Scene 06 -- DriftDetector (Page-Hinkley vs CUSUM)
- ONE regime-stepping signal feeds TWO O(1)-state detectors via `addFrom` -- Page-Hinkley
  (references its ONLINE mean, adaptive) and CUSUM (references a FIXED `mu0`). The canvas
  draws the signal, the two fire cursors (`statistic / threshold`), the fire line at 1.0,
  and red fire markers. The injected changepoints are the ground truth.
- **Bound band**: the mode is LOAD-BEARING (reuse the `test/witness.mjs` ddRampFires
  divergence gate): on a slow mean ramp CUSUM fires far more than PH. Two witness gauges
  (PH statistic/threshold, CUSUM statistic/threshold). NO pause toggle (item-indexed).
- Sliders: `threshold`, `delta`.

### Scene 07 -- SlidingDDSketch (windowed relative-error quantiles)
- A positive lognormal stream (its center shifts each lap) flies in via
  `addFrom([now, value])`; the canvas draws p50/p90/p99 as log-scaled bars -- estimate
  (violet), the `+-alpha` band (amber), the exact quantile (magenta) inside it. The exact
  oracle sorts the LIVE pane content into a PREALLOCATED buffer via insertion sort (NEVER
  `.sort()` / never allocates per query -- the one oracle allowed to be alloc-free).
- **Bound band**: `relerr <= alpha` per quantile (reuse the `test/witness.mjs` sldDrive
  gate) and window-edge `<= one pane width W/panes`; cursor `relerr / alpha`, `<= 1`.
- Sliders: window `W`, `alpha`. Pause-the-stream toggle (windowed member).

### Scene 08 -- SlidingCountMin (windowed per-label frequency)
- A Zipfian key stream flies in via `addFrom([now, key, count])`; the canvas draws a few
  tracked (hot) keys, each an estimate bar inside the one-sided band `[true(W), true(W +
  W/B) + eps*N]` (amber), the `true(W)` marker (magenta). The exact oracle keeps a
  per-key windowed `(t, key)` ring.
- **Bound band**: `true(W) <= est <= true(W + W/B) + eps*N` on 100% of tracked-key
  queries (reuse the `test/witness.mjs` scmDrive one-sided gate); the saturated flag is
  the honesty signal.
- Sliders: window `W`, `epsilon`. Pause-the-stream toggle (windowed member).

### Scene 09 -- DecayedReservoir (recency-biased fixed-k sample)
- A stream flies in via `addFrom([now, value])` (value = the arrival timestamp, so age =
  now - value); the canvas draws the k-sample as an AGE histogram (recent = left), its
  mass leaning recent because retention decays `exp(-lambda*age)`. The brute-force oracle
  would retain EVERY value; the sketch keeps only k real recent items.
- **Bound band**: the inclusion rate by item age tracks `exp(-lambda*age)` -- the fitted
  ln(rate)-vs-age slope equals `-lambda` within +-15% (reuse the `test/witness.mjs`
  drReservoirSlope gate); the no-decay (huge half-life) control is REJECTED. NO pause
  toggle (a sample, not a hard window -- it correctly holds its last decayed sample).
- Sliders: sample size `k`, `halfLife`.

### Pause the stream (idle-slide) -- the FOUR windowed scenes only
Scenes 01 / 05 / 07 / 08 (ExponentialHistogram, SlidingHyperLogLog, SlidingDDSketch,
SlidingCountMin) carry a per-scene "pause the stream" toggle that sets `world.paused`.
While paused, `stepX` performs NO add: it advances the clock once per frame via the
member's `advanceFrom([now], 0)` (R11 idle-slide, 0 B/op), so the readout slides to empty
with no traffic -- count/distinct -> 0, quantile -> NaN, estimate -> 0. This is the
demo's proof of the idle-slide contract. ADWIN / ForwardDecay / HeavyKeeper /
DriftDetector / DecayedReservoir get NO such toggle (they are item-indexed or decay-based,
not hard windows).

### Contrast (a cross-scene footer line)
Nine recency questions, nine fixed-memory members, one theme: each trades a bounded,
witnessed WINDOWED / DECAYED / DRIFT error for O(1)/O(k) space where the exact oracle
grows without bound.

---

## 4. The Truth Panel -- the two proofs

Stacked readouts, always visible, updated at ~10Hz from a shared flat buffer (NOT
rebuilt per frame). Items 1-3 are the package-agnostic zero-GC proof (inherited from
lite-sketch verbatim); item 4 is the lite-adaptive family witness.

1. **PRIMARY -- jank detector.** dt between rAF frames as a rolling bar strip; red past
   ~16.7ms. GC pauses ARE dropped frames, visible in every browser.
2. **PRIMARY -- owned allocation counter.** The sketch path's counter is provably pinned
   at 0 after warmup; the exact-oracle path's counter climbs (retained timestamps /
   values / Map entries). Headline: "sketch allocations since warmup: 0".
3. **SECONDARY -- retained heap (labeled Chromium-only, coarse).** `usedJSHeapSize`, a
   labeled secondary overlay, never the primary claim.
4. **FAMILY WITNESS (lite-adaptive-specific).** Two live signals re-derived from the
   shipped `Adaptive.js` against the in-tab exact oracle:
   - **Recency error vs bound**: the measured windowed / decayed / drift error as a
     fraction of the member's guarantee (Section 3), drawn as a cursor inside a band
     that must contain it.
   - **Space vs exact**: the member's FIXED bytes (flat) vs the exact oracle's bytes
     climbing O(N)/O(W)/O(distinct). Both in KB with the live N.

---

## 5-6. Layout, interaction, zero-GC guardrails

Verbatim from `../LiteSketch/DEMO.md` sections 5-6: header / tab nav / active scene /
footer; number keys 1-9 switch scenes, space pauses; high-DPI canvas sized once on
load + resize (the ONLY place canvas buffers reallocate). Pre-allocate all canvas /
scratch buffers AND the pre-generated stream at warmup; the ONLY reallocation is on an
explicit resize or a topology change (a new W / epsilon / delta / halfLife / k
rebuilds the member). No `ctx.save`/`restore`, no object/array literals, no closures,
no allocating `Array` methods, no string concat in the hot draw path. `topK()`
ALLOCATES by contract -- the render path uses `topKInto` / `forEach` only. ASCII-only.

---

## 7. Honesty proof -- `demo/Demo.test.mjs` (node:test)

- **Faithfulness**: every value the demo displays as a library result is re-derived
  from the ACTUAL imported classes (`import { ExponentialHistogram, ADWIN,
  ForwardDecay, HeavyKeeper, SlidingHyperLogLog, DriftDetector, SlidingDDSketch,
  SlidingCountMin, DecayedReservoir, VERSION } from '../Adaptive.js'`), not hardcoded.
  The displayed count / mean / estimate / quantile / sample equal the library's on the
  same stream.
- **Witness faithfulness (reuse `test/witness.mjs` thresholds)**: EH `relerr <=
  epsilon`; ADWIN false-alarm `<= delta` + adapted `|mean - mu| < 0.05`; ForwardDecay
  `relerr <= 1e-9`; HeavyKeeper recall `1.0` + never overestimates + beats
  Space-Saving on drift; SlidingHyperLogLog `relerr <= 3 * 1.04/sqrt(m)` + not
  degraded; DriftDetector mode-divergence (PH fires << CUSUM on a ramp); SlidingDDSketch
  `relerr <= alpha` + edge `<= W/panes`; SlidingCountMin `true(W) <= est <= true(W+W/B)
  + eps*N`; DecayedReservoir inclusion rate by age `~ exp(-lambda*age)`. The thresholds
  are mirrored with a citation, never loosened.
- **Version trinity (dynamic)**: kernels.mjs VERSION re-export === `Adaptive.js` VERSION
  === `package.json` version, asserted as a three-way equality with NO hardcoded semver
  literal (so a release bump can never leave the demo pinned to a stale version -- the
  1.0.0-pin rot this update fixed).
- **Zero-alloc gate**: every scene's `stepX` + `renderXPrep` measure 0 B/op
  (`measureAllocs`) and trigger 0 major GC over ~200k ops (`GcProfiler` + `checkNoGc`,
  `maxMajor: 0`), mirroring `test/torture.mjs`. A PAUSED `stepX` (the idle-slide
  `advanceFrom` branch) is also measured at 0 B/op. The oracle steps are the
  allowed-to-allocate contrast and are kept OUT of the measured loop.
- **Retention + idle-slide**: 50 clear()/refill cycles -- `hk.size` returns to 0,
  `eh.bucketCount` stays `<= capacity`; and after pause cycles on the four windowed
  scenes the readout slides to empty (`eh.count()` / `shll.count()` / `scm.estimate(k)`
  -> 0, `sld.quantile(0.5)` -> NaN).
- **`demo:check` in `verify`**: a fast lane (trinity + faithfulness + one alloc batch
  per scene, skipping the 200k-frame GC lanes) runs as the last step of `npm run verify`,
  so the demo can never silently rot behind a library release again. The full
  `npm run demo` (with the GC lanes) stays a separate script.

`demo/serve.mjs` provides `npm run demo:serve` (a static file server, no deps);
`npm run demo` headless-runs the honesty suite. `files[]` UNCHANGED.

---

## 8. Packaging & pipeline

- **Files** (all repo-only), the settled four-file `demo/` split identical to
  `../LiteSketch/demo/`: `index.html`, `kernels.mjs`, `Demo.test.mjs`, `serve.mjs`,
  plus this `DEMO.md`.
- **package.json**: three demo scripts --
  `"demo": "node --expose-gc --test demo/Demo.test.mjs"` (the full suite incl. the
  200k-frame GC lanes), `"demo:check": "LITE_DEMO_FAST=1 node --expose-gc --test
  demo/Demo.test.mjs"` (a fast lane -- trinity + faithfulness + one alloc batch per
  scene, skipping the GC lanes), and `"demo:serve": "node demo/serve.mjs"`. `demo:check`
  is appended to the `verify` chain so the demo can never silently rot behind a release.
  `files[]` UNCHANGED (6 entries); `npm pack --dry-run` still shows exactly 7 files with
  `demo/` absent. `Adaptive.js` is NOT touched (the demo imports it, read-only); the
  library VERSION stays 1.6.0 (a demo update never bumps the library).
- **Pipeline**: coder builds -> reviewer audits the diff for per-frame allocation AND
  fail-open metric lies (a band that can't be exceeded, a hardcoded error) -> qa
  proves faithfulness + witness + version-trinity + 0-B/op + non-vacuous. USER
  commits / publishes; the assistant never does.

---

## 9. Sibling-demo foundation

This demo inherits the lite-sketch chassis wholesale (Section 1 spine, Section 4 items
1-3, Section 6 guardrails, Section 7 honesty-proof shape, Section 8 packaging) and
rewrites ONLY the roster->scene map (Sections 2-3) and the Truth Panel item-4 WITNESS:
lite-sketch shows ACCURACY-vs-bound + SPACE-vs-exact (cumulative); lite-adaptive shows
the WINDOWED / DECAYED / DRIFT recency witness + the O(W)/O(N) exact-foil contrast.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
