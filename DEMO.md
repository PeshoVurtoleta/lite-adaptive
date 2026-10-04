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

## 2. Roster -> scene map (all 10 shipped members demoed)

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
| 10 | **SlidingAggregate** | what is the latency MEAN / min / max over the last W? | windowed mean over time: SA vs oracle vs EH's sum()-derived mean | exact (t, v) ring over the covered span | count / sum / min / max EXACT (equality); EH `sum()` breaks `<= epsilon` on spikes (F17) | sa.bytes fixed vs ring O(W) |

### 1.8.0 additions (D1-D8) -- what each scene grows to demonstrate the 1.7.0 / 1.8.0 work

The nine scenes above stay; 1.8.0 adds controls + readouts so every 1.7.0 hardening fix and every
1.8.0 additive-API surface is VISIBLE and re-derived live (DEMO.md section 0). Each is proven by a D10
faithfulness test + a frame-path 0 B/op test with the control engaged (section 7). The flat layout is
APPEND-ONLY: a new readout is a NEW slot after the last existing index; `demo/golden-flat.json` +
`demo/Demo.test.mjs` pin the pre-existing slots bit-identical (section 7).

| D-step | Scene | New control(s) | New readout(s) | Fix / API demonstrated | Re-derived against |
|--------|-------|----------------|----------------|------------------------|--------------------|
| D1 | 01 EH | `maxCount` select; `dense10k` preset (W=1024, gap 0.1); F17 skewed/spike-value toggle | pool gauge (live pop vs EXACT ceiling `k*(2^levels-1)` vs capacity/bytes); fail-closed overflow banner; `sum()` error cursor vs the STATED `straddle/2` bound next to the old `<= eps` line failing | F1/F11 (`maxCount` + capped pool, tagged overflow throw), F17 (`sum()` is NOT `<= eps`) | a demo-local `EhProbe` reads the straddle size (like `test/witness.mjs`); the exact ring |
| D2 | 02 ADWIN | absolute-offset slider {0, 1e3, 1e6, 1e9, 1.7e12}; `bigJumpThenPlus1` preset | live-window range R vs a GHOST of the 1.6.0 global (never-shrinking) range | F9 (offset-invariant false-alarm via centred sums), F18 (R is the retained window's value range, incl. the straddling oldest bucket -- NOT the library's internal R, which excludes it) | the exact regime mean; the ghost is the demo's own running global min/max |
| D3 | 04 HK | key-magnitude toggle {small, `>= 2^31`, negative}; log2 weight slider whose `2^32` notch is REJECTED | the PRIMARY allocation counter pinned at 0 through `addFrom` AND `renderHkPrep` across all key classes; a SAT badge at the `2^32-1` ceiling; a fail banner on the `2^32` rejection | F3 (`addFrom` boxes no large/negative key; the render Map is keyed by the untransformed Smi index so `renderHkPrep` boxes none either), F10 (weight `> 2^32-1` is a tagged throw) | the shipped `hk.estimate` / top-k; the allocation counter itself |
| D4 | 05 SHLL | query-rate select {1, 8, 64, never} (10Hz ticks): `slA` is `count()`-queried only on the cadence ("never" = 0 queries), `slB` never, a display twin `slD` every tick for the estimate | the `slA` / `slB` `overflows` shown side by side, always EQUAL; the live estimate (from `slD`) | F8 (`count()` is non-destructive: overflows independent of query rate) | the shipped `sl.overflows` getters directly; the display estimate is the shipped `slD.count()` |
| D5 | 06 DD | 1.8.0 `latch` toggle (latched vs unlatched twins) | a FEW fire markers per regime (latched PH 1-4, latched CUSUM 0-4; 0 on the HI->LO steps) with `lastDirection` arrows + `lastDriftIndex`, vs the unlatched CUSUM storm (~10.9k fires over 21 regimes) | S9 (`latch` + `lastDriftIndex` + `lastDirection`) | a from-spec PH/CUSUM state machine (fire index+direction, per regime); the shipped latched/unlatched detectors on the same signal |
| D6 | 07 SLD | 3-way strict / `range` toggle (declared range `[1, 20]`) | B+1 pane strip: covered span `[W, W+W/B]` vs the TRUE window bracket; a rejected-value counter + `rangeMin` / `rangeMax` | F7 (B+1 panes cover the full W), F2 (declared `range` strict), F5 (`quantileInto` at 0 B/call) | TWO oracles: the quantile oracle on the covered span `[W, W+W/B]` (matching `test/witness.mjs`); the count oracle `true(W)` on `(now-W, now]`; the render reads through `quantileInto` |
| D7 | 08 SCM | heavy-count mode (`count >= 2^31`) | `total(w)` readout + the `eps x N` band computed from the ORACLE N; the render reads through `estimateInto` | S2 (`total(w?)`), F6 (`estimateInto` 0-alloc reader) | the exact windowed oracle N (NEVER the library's own `total`); the shipped `estimateInto` |
| D8 | Truth Panel | -- | a "contracts" line + a Chromium-only key-magnitude allocation lane (see section 4 items 5-6) | F12 / F13 query + option contracts, S11 (31-bit-Smi browser) | the shipped throws / NaN returns; `usedJSHeapSize` deltas |

D9 (SlidingAggregate scene) is MOVED to v1.9.0 with the member -- excluded here.

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
- **1.8.0 (D1)**:
  - A `maxCount` select (the declared population bound, F1/F11/S3). A **pool gauge** shows the live
    population against the EXACT ceiling `k * (2^levels - 1)` and the fixed `capacity` / `bytes`
    (all PUBLIC getters -- `eh.levels`, `eh.capacity`, `eh.bytes`), so a consumer reads headroom
    without a size-vs-capacity heuristic.
  - A `dense10k` preset: `W = 1024`, gap `0.1`, pool sized with `maxCount = W`. Its merge cascade
    overflows the pool; the shipped code throws a TAGGED `[lite-adaptive]` RangeError (1.6.0 went to
    `count() = NaN` here). The demo wraps the add in a try/catch and renders a **fail-closed banner
    carrying the library's own message** -- the honesty signal, not a silent NaN.
  - An **F17 toggle** (skewed / integer-spike values). With it on, the `sum()` error cursor is drawn
    against the STATED bound `straddle / 2` (a demo-local `EhProbe` reads the straddling bucket's size
    exactly as `test/witness.mjs` does), NEXT TO the old `sum() <= eps` line VISIBLY failing -- the
    scene's proof that `sum()` is bounded by the straddle mass, never by `epsilon`.
  - **Oracle-off fail-closed** (in `renderEhPrep`, behind `world.oracleOn`, a COLD branch): with the
    exact ring toggled off, ALL SEVEN oracle-derived slots (`E_TRUE`, `E_RELERR`, `E_FRAC`, `E_POP`,
    `E_TRUESUM`, `E_SUMFRAC`, `E_SUMRELEPS`) are set to `NaN` -- rendered "n/a", gauge skipped -- rather
    than a frozen stale ring shown as live (null is not zero). `E_RING_BYTES` stays a live memory readout.
    The write lives in the kernel, not the untested UI tick, so a test drives it. On RE-ENABLE the exact
    ring is refilling for a full window: the SAME seven slots hold `NaN` until `now - resumeNow >= W`, so
    a half-refilled ring never paints a false red gauge for the ticks after resume. At defaults (`oracleOn`
    true, `resumeNow = -Infinity`) neither branch fires, so the golden stays bit-identical. The pool gauge
    draws only the ceiling hairline (the right-edge marker), so its label reads "population vs exact
    ceiling", not "vs capacity".
  - **10Hz render cost, honestly**: `renderEhPrep` measures 0 B/op in the optimized steady state
    (`eh.count()` / `eh.sum()` return Smi-range integer doubles at these configs). On the F17 spike world
    it boxes ~32 B/call before V8 fully optimizes it, settling to 0 by ~200k warm-up calls -- the
    `eh_render_spike` probe lane warms past that point, so the gate reads the optimized steady state.

### Scene 02 -- ADWIN (drift + adaptive window)
- A stream drifting between two concept means. `ADWIN.addFrom` GROWS the window
  while stationary and SHRINKS it (the snap) the moment a mean shift is significant.
  Canvas plots `ad.mean` (violet, tracks the concept) vs a naive cumulative mean
  (dim, lags), red flashes at each cut, a window-width bar.
- **Bound band**: false-alarm rate `<= delta` on a stationary run (gated in the test);
  the on-screen witness is the adapted-mean band `|mean - mu| / 0.05` (the witness's
  adapted-window gate), cursor `<= 1` once settled.
- Slider: confidence `delta`.
- **1.8.0 (D2)**:
  - An **absolute-offset slider** {0, 1e3, 1e6, 1e9, 1.7e12} added to every value. Behavior is
    IDENTICAL across offsets (F9: centred/Welford variance, not `E[x^2] - mean^2`) -- the false-alarm
    count and the step-detection delay stay within a couple of items of the offset-0 run.
  - A `bigJumpThenPlus1` preset: a large level shift, then a later `+1` shift. The later shift IS
    detected (F18) -- the honesty test measures the ITEM-EXACT first cut after the shift (a fresh replay,
    not `world.lastCut`, which is the LAST cut inside a 32-item frame while ADWIN sheds buckets) and gates
    it within `1.5*d0 + 10` items per seed over 100 seeds, with the old running-GLOBAL-R variant as a
    MUST-FAIL control (it stays deaf). The scene draws the **live-window range R** -- the exact value range
    (max-min) of the RETAINED window (the last `ad.width` fed values read straight from the stream suffix),
    INCLUDING the straddling oldest bucket; this is NOT the library's internal F18 R, which EXCLUDES that
    oldest bucket -- against a GHOST of the 1.6.0 behavior -- a demo-maintained running GLOBAL min/max that
    never shrinks -- to show why 1.6.0 went deaf (an inflated Bernstein range term). ADWIN cuts at bucket
    granularity, so right after a cut the live window may still carry ONE straddling oldest bucket of
    pre-shift values (R ~1.5) for a few frames before it is shed. The GHOST global range is folded by a
    dedicated always-run kernel (`stepAdGhost`), OUTSIDE the vs-oracle (naive-mean foil) branch, so
    pausing the foil never freezes it stale. The live-window range is recomputed each render from the
    stream suffix over the WHOLE retained window (the last `ad.width` values, bounded by the stream ring
    `AD_STREAM_LEN = 65536`, past which it fails closed to `NaN`) -- there is no 256-value scan cap
    (`AD_LIVER_SCAN = 256` survives only as the OLD-cap anchor a faithfulness test asserts `width >`).
  - **10Hz render cost, honestly**: the per-frame path (`stepAd` + `stepAdGhost` + `stepAdOracle`) is
    0 B/op. `renderAdPrep` is ALSO 0 B/op in the optimized steady state: `ad.mean` / `ad.variance`
    return fractional doubles that box ~16 B each when their return ESCAPES (proven by the DemoProbe
    `ad_mean_sink` / `ad_variance_sink` controls, which read 16 B/op), but the render keeps every value
    in a `Float64Array` slot end to end and returns an int32 fold, so V8 ELIDES the getter returns.
    (HEAD's `return mean` sank such a double across the render boundary and boxed 48 B/call.)

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
- **1.8.0 (D3)**:
  - A **key-magnitude toggle** {small, `>= 2^31`, negative} that feeds keys of that class through
    `addFrom`. The Truth Panel PRIMARY allocation counter stays PINNED at 0 across ALL classes (F3:
    the key rides Float64 slots, `hkMapHash` returns `| 0`) -- the box the plain `add` path shows is the
    control. Never call `topK()` in the render (it allocates); use `topKInto`.
  - A **log2 weight slider** whose notches are `2^s`: `s in [0,31]` -> `2^s`; `s == 32` -> the ceiling
    `2^32-1`, where the top uint32 cell SATURATES and the **SAT badge** lights; `s == 33` -> `2^32`,
    which the library's **F10 guard REJECTS** (a tagged `[lite-adaptive]` throw, not a silent
    `estimate = 0`). The rejection is caught into a **fail banner** showing the library's own message,
    and the last valid world keeps running (never a dead rAF loop).
  - With the **exact-Map oracle toggle OFF** the recall / bracket / max-overestimate / HK-vs-SS marquee
    read **`n/a`** (the Map + Space-Saving foil are frozen while the sketch keeps counting -- fail closed
    to NaN rather than show a stale "recall 100%").

### Scene 05 -- SlidingHyperLogLog (windowed distinct-count)
- A key stream cycling over a fixed universe flies in via `addFrom([now, key])`; the
  canvas scrolls the windowed DISTINCT estimate (violet) against the exact in-window
  `Map` size (magenta). The register bank is a FIXED `m = 2^p`; the oracle keeps every
  in-window key. Idle-slide toggle -> `advanceFrom` empties the window to 0.
- The "sketch bytes (fixed, per instance)" readout is ONE instance's `sl.bytes`. The scene holds
  three identical instances (slA queried on the cadence, slB never queried, slD display-only), so
  the scene's total fixed sketch memory is 3x that figure -- still independent of the stream.
- **Bound band**: `relerr <= 3 sigma = 3 * 1.04/sqrt(m)` (reuse the `test/witness.mjs`
  slDrive gate), and `degraded === false`; the cursor is `relerr / 3-sigma`, `<= 1`.
- Sliders: window `W`, precision `p`. Pause-the-stream toggle (windowed member).
- **1.8.0 (D4)**:
  - A **query-rate select** {1, 8, 64, never} (in 10Hz TICKS) driving THREE instances fed the IDENTICAL
    stream: `slA` is `count()`-queried ONLY when the tick countdown fires (so **"never" queries `slA`
    ZERO times** -- the control has teeth, proven by a counting wrapper), the twin `slB` is NEVER queried,
    and a display-only twin `slD` is `count()`-queried EVERY tick for the on-screen estimate (always live,
    independent of the cadence). All three `overflows` getters are ALWAYS EQUAL (F8: `count()` is
    non-destructive -- expiry moved into the add push, so `overflows` / `degraded` no longer depend on
    query frequency). `slA` and `slB` are shown side by side.
  - The display `count()` (on `slD`) runs once per 10Hz tick; the per-frame `stepShll` calls NO
    `count()`, so it is 0 B/op. A shared steady-state probe (`demo/DemoProbe.mjs`, pinned semi-space)
    measures the render in the `shll_render` lane (built at cadence "never" to isolate the render), where
    the demo's `measureAllocs` gate cannot see a transient box. **Since 1.11.0 the render is 0 B per
    tick**: the library moved the estimator tail into module scratch slots, so `count()` no longer boxes
    (output bit-identical). From 1.8.0 to 1.10.0 it cost 16-32 B per tick depending on the V8 tier (a
    stable 16 B in the estimator tail, plus 16 B for the returned double when the render was not
    Turbofan-optimized) -- the ROADMAP 8 finding that 1.11.0 closed. The `shll_render` gate is `<= 0.5`
    B/op in EVERY one of 10 fresh pinned children (so a tier-dependent box cannot hide), and the
    `mustbox` control (>= 12) proves the probe still sees a box.
  - **Oracle-off fail-closed**: with the exact-`Map` oracle toggle off, `renderShllPrep` NaNs `S_TRUE` /
    `S_RELERR` / `S_FRAC` in its cold branch (rendered "n/a", gauge skipped), never a frozen stale number.

### Scene 06 -- DriftDetector (Page-Hinkley vs CUSUM)
- ONE regime-stepping signal feeds TWO O(1)-state detectors via `addFrom` -- Page-Hinkley
  (references its ONLINE mean, adaptive) and CUSUM (references a FIXED `mu0`). The canvas
  draws the signal, the two fire cursors (`statistic / threshold`), the fire line at 1.0,
  and red fire markers. The injected changepoints are the ground truth.
- **Bound band**: the mode is LOAD-BEARING (reuse the `test/witness.mjs` ddRampFires
  divergence gate): on a slow mean ramp CUSUM fires far more than PH. Two witness gauges
  (PH statistic/threshold, CUSUM statistic/threshold). NO pause toggle (item-indexed).
- Sliders: `threshold`, `delta`.
- **1.8.0 (D5)**:
  - A **`latch` toggle** (S9) driving LATCHED twins of PH and CUSUM beside their UNLATCHED selves on
    the same signal. The latched channels re-arm only when the statistic falls back below `threshold / 2`,
    so they draw a FEW markers per regime -- MEASURED on the demo stream (21 regimes, two stream laps):
    latched PH fires 1-4 times per regime, latched CUSUM fires 0-4 (exactly **0 on every HI->LO step** --
    a fixed-target property, since a CUSUM referenced to the LO baseline `mu0=0` accumulates no evidence
    when the mean drops back TO its target; explained on-canvas). This is NOT "one fire per regime"; the
    win is the CONTRAST with the unlatched CUSUM storm (~10.9k fires over the same 21 regimes; unlatched
    PH is adaptive and barely fires, ~50). Each latched marker carries a `lastDirection` (+1 / -1) arrow
    and `lastDriftIndex`. All read the shipped `latch` / `lastDriftIndex` / `lastDirection` getters; the
    `latch:false` path is byte-identical to 1.x. The fire (index, direction) sequence of both latched
    channels is asserted EQUAL to an in-test **from-spec state machine** (PH online-mean reset at the fire;
    CUSUM fixed target; re-arm at `threshold/2`; opposite single-item gap `> threshold` fires) written from
    the spec + decisions/0007, never from kernel output; a per-regime gate bounds the counts. `createDdWorld`
    builds FOUR detectors (unlatched PH/CUSUM + the `latch:true` twins) and feeds all four the SAME signal
    in `stepDd`; the toggle only sets the display-emphasis flag `G_LATCH_ON` (no rebuild, no forced reflow).
    A non-boolean `latch` is a tagged `[lite-adaptive]` throw BEFORE any allocation (fail-closed knob).
    `lastDriftIndex` / `lastDirection` are `NaN` before any fire (null is not zero) -- the tick renders
    "n/a", never `String(NaN)`.
  - **Cost, honestly**: `stepDd` (32 values x 4 detectors' `addFrom`) is **0 B/op** in the steady state
    under DEFAULT flags (DemoProbe `dd_frame` + `dd_frame_nolatch` lanes, pinned semi-space, gated
    `<= 0.5 B/op` -- the library holds every value in a `Float64Array` slot end to end, so the frame path
    never boxes; no `--no-maglev` exemption). The ~10Hz `renderDdPrep` reads all four detectors through
    the 1.11.0 render reader `dd.into(row)` -- `[statistic, mean, count, lastDriftIndex, lastDirection]`
    into one module-scope `Float64Array(5)`, reused per detector -- so the render is **0 B/tick** (DemoProbe
    `dd_render` lane, gated `<= 0.5`). Every displayed slot is `Object.is` its scalar getter (fresh and
    after fires). Before 1.11.0 the render read SIX fractional `statistic` / `mean` getters in one unit;
    each calls `_guardFinite()`, six exhaust V8's cumulative inlining budget, and three returns boxed
    -> ~48 B/tick. That shape is kept as the MUST-BOX control `dd_getter_box` (>= 12, measures 48), so the
    render's 0 is the reader, not a blind probe.

### Scene 07 -- SlidingDDSketch (windowed relative-error quantiles)
- A positive lognormal stream (its center shifts each lap) flies in via
  `addFrom([now, value])`; the canvas draws p50/p90/p99 as log-scaled bars -- estimate
  (violet), the `+-alpha` band (amber), the exact quantile (magenta) inside it. The exact
  oracle sorts the LIVE pane content into a PREALLOCATED buffer via insertion sort (NEVER
  `.sort()` / never allocates per query -- the one oracle allowed to be alloc-free).
- **Bound band**: `relerr <= alpha` per quantile (reuse the `test/witness.mjs` sldDrive
  gate) and window-edge `<= one pane width W/panes`; cursor `relerr / alpha`, `<= 1`.
- Sliders: window `W`, `alpha`. Pause-the-stream toggle (windowed member).
- **1.8.0 (D6)**:
  - A **B+1 pane strip** drawing the covered span `[W, W + W/B]` against the TRUE `(now-W, now]` window
    bracket, with the straddling oldest pane sticking out past the true edge (F7: the sketch keeps B+1
    panes so the span ALWAYS covers the full W). There are TWO oracles on TWO windows (see below): the
    quantile oracle stays on the COVERED span `[W, W+W/B]`; a SEPARATE count oracle `true(W)` is added on
    the TRUE `(now-W, now]` window, and a `count() >= true(W)` cursor is drawn from it (never `< 1`).
  - A **3-way strict / `range` toggle** (`createSldWorld` mode 0 default / 1 strict span-based / 2
    declared range `[1, 20]`, locked at the ctor, fail-closed on a bad mode) with a rejected-value
    counter and the `rangeMin` / `rangeMax` getters, so a consumer PRE-CHECKS the accepted band instead
    of catching a "would collapse" throw. In range mode `stepSld` pre-checks each value against
    `[rangeMin, rangeMax]` read ONCE at build (`!(v >= rMin && v <= rMax)` rejects NaN too): an
    out-of-band value is NOT added (the rejected counter climbs) but the clock slides via `advanceFrom`
    -- 0 B/op, no try/catch, no throw on the hot path. The exact oracle applies the identical pre-check,
    so its content mirrors the accepted set.
  - **Two INDEPENDENT oracles**: the quantile oracle is the exact sorted multiset of the COVERED span
    `[W, W + W/B]` (rel-error is purely DDSketch bucket error, `<= alpha`); the count cursor
    `count() / true(W)` uses a SEPARATE `true(W)` over the TRUE `(now - W, now]` window (a covered-span
    count would read ~1 always and hide under-coverage). The cursor never drops below 1 (F7).
  - The render path reads through **`quantileInto`** (F5: 0 B/call; byte-identical to three scalar
    `quantile()` calls, so the pre-existing golden slots stay bit-identical). `renderSldPrep` returns an
    int32 fold (HEAD returned `p50e` and boxed 16 B). **Cost, honestly**: `stepSld` (both modes) and
    `renderSldPrep` are 0 B/op in the steady state (DemoProbe `sld_frame_range` / `sld_frame_strict` /
    `sld_render` lanes); the scalar `quantile()` keeps its one boxed return (~16 B/call, the `sld_quantile_box`
    control lane), documented -- the render never calls it.

### Scene 08 -- SlidingCountMin (windowed per-label frequency)
- A Zipfian key stream flies in via `addFrom([now, key, count])`; the canvas draws a few
  tracked (hot) keys, each an estimate bar inside the one-sided band `[true(W), true(W +
  W/B) + eps*N]` (amber), the `true(W)` marker (magenta). The exact oracle keeps a
  per-key windowed `(t, key)` ring.
- **Bound band**: `true(W) <= est <= true(W + W/B) + eps*N` on 100% of tracked-key
  queries (reuse the `test/witness.mjs` scmDrive one-sided gate); the saturated flag is
  the honesty signal.
- Sliders: window `W`, `epsilon`. Pause-the-stream toggle (windowed member).
- **1.8.0 (D7)**:
  - A **`total(w)` readout** (S2: an exact windowed N from a Float64 total per pane, +8 B/pane) and the
    `eps x N` band. CRITICAL: the band on screen is computed from the ORACLE's exact N over the covered
    span, NEVER from the library's own `total()` -- an oracle that shares the design's geometry would
    agree with a bug. `total(w)` is displayed BESIDE the oracle N as its own faithfulness check.
  - A **heavy-count mode** (`count >= 2^31`) so the `estimate` of a large windowed count is exercised
    (F6: the large-count return boxes once per call; the render reads through **`estimateInto`**, a
    batch 0-alloc reader over Float64Arrays).
  - Same `w` semantics as `estimate`: a bad sub-window reads NaN (F12), never a fail-open 0.
  - **As built (demo session, 2026-10-04)**: the truth panel prints `total(W)` beside the oracle N (green
    when they are equal). The heavy-count toggle adds tracked key 0 ONCE per frame with count 2^30
    (`SCM_HEAVY_COUNT`), so its windowed count passes 2^31 within a few panes while every Uint32 pane cell
    stays below 2^32-1 (never saturated); the heavy adds live in their own small oracle ring, so with the
    toggle off every pre-existing golden slot is unchanged by the toggle. The render reads all tracked keys in ONE
    `estimateInto` call and returns an int32 fold: `scm_render_heavy` and `scm_frame_heavy` read 0 B/op,
    while the `scm_estimate_box` control (the scalar `estimate()` of the > 2^31 key) boxes 16.
  - **Oracle fix found by `total(W)`**: the oracle's ring expiry used `paneEnd(t) <= paneEnd(now) - W`,
    which dropped the oldest LIVE pane -- its N ran one pane short of `total()` (1985 vs 2049 at defaults)
    and, since that pane overlaps `(now - W, now]`, every tracked `true(W)` was under-counted too (so the
    lower side of the bound gate was weaker than claimed). Now `<`: the D7 from-spec test recomputes N and
    `true(W)` from the deterministic stream on every render (3 W x heavy on/off) and both the oracle and
    `total()` match exactly. The 10 oracle-derived SCM golden slots are declared exceptions.
- **D8 contracts line** (SCM truth panel, written once at boot from `scmContracts`): `estimate(k, w=-1)`
  reads NaN (F12, never a fail-open 0) and a typo'd option (`sede`) throws the library's own
  did-you-mean message -- both observed LIVE from the shipped class, never demo text.

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

### Scene 10 -- SlidingAggregate (exact windowed count / sum / mean / min / max)
- The lite-hud latency panel (F17, ADR 0012). Whole-millisecond lognormal latencies (median ~20 ms, mean
  ~33 ms; `round(exp(3 + z))`, min 1) fly in via `addFrom([now, value])`, 32 per frame on a sim clock
  (`SA_DT = 1000/60` ms per frame, event j at `frameNow + (j+1) * SA_DT / 32`, by multiplication). The SAME
  stream feeds an ExponentialHistogram (epsilon 0.05, `maxCount` 8192) as the contrast.
- **Numeric domain**: W = 1000 ms, B = 32 -> pw = 31.25 (normal); the library's clock bound pw * 2^42 =
  1.37e14 ms is never near. Whole-ms values (spikes x50 stay integers, max ~5.5e4) keep every windowed sum an
  exactly representable integer, so the gate is EQUALITY, not a tolerance: count / sum / min / max equal an
  independent recount from the stream on every render (W 1000 / 4000 x spikes off / on, toggled mid-run).
  Kahan's fractional-sum guarantee is gated in the library's own tests (ADR 0012), not here.
- **The F17 contrast**: a spike toggle multiplies 1% of events by 50. EH's `sum()` error is bounded by the
  straddling bucket's POPULATION, not its value mass, so its relative error vs the true window (now - W, now]
  breaks its `<= epsilon` intuition (measured max ~14.6% vs epsilon 5% at W = 1000) while SlidingAggregate
  stays exact; with spikes off EH stays within epsilon. The panel shows the live EH error and its running max.
- **Render path**: `renderSaPrep` reads the row through `sa.into(out)` (`[count, sum, mean, min, max]`, 0 B),
  then one exact oracle scan; `renderSaEhPrep` stores `eh.count()` / `eh.sum()` straight into Float64Array
  slots. All three lanes (`sa_frame`, `sa_render`, `sa_eh_render`) read 0 B/op; the `sa_mean_box` control (the
  scalar fractional `sa.mean()`) boxes 16. Found while building it: a `cond ? x / y : NaN` ternary merges a
  computed double with the NaN constant and boxes the phi (16 B each) -- every fractional result is stored
  from an if / else instead.
- **Fail-closed**: oracle off -> every oracle slot is NaN ("n/a"); turning it back on HOLDS NaN until a full
  covered span (W + W/B) has refilled (never a stale "exact"). Pause -> `advanceFrom` idle-slides both members:
  count / sum read 0, mean / min / max read NaN (null is not zero).

### Pause the stream (idle-slide) -- the FIVE windowed scenes only
Scenes 01 / 05 / 07 / 08 / 10 (ExponentialHistogram, SlidingHyperLogLog, SlidingDDSketch,
SlidingCountMin, SlidingAggregate) carry a per-scene "pause the stream" toggle that sets `world.paused`.
While paused, `stepX` performs NO add: it advances the clock once per frame via the
member's `advanceFrom([now], 0)` (R11 idle-slide, 0 B/op), so the readout slides to empty
with no traffic -- count/distinct -> 0, quantile -> NaN, estimate -> 0, SA mean/min/max -> NaN. This is the
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
5. **CONTRACTS (1.8.0, D8).** A cold "contracts" line driven by a demo probe that exercises the
   shipped fail-closed surface once (NOT per frame): a bad sub-window `w` reads NaN (SCM/SDD/SHLL,
   F12), a bad quantile `q` reads NaN (SDD), a bad key reads NaN, and a typo'd option key
   (`{maxCuont: 5}`) surfaces the shipped **did-you-mean** message (F13). The line shows the actual
   returned NaN / thrown message from `Adaptive.js`, never a hardcoded string -- fail-closed proven,
   not asserted.
6. **KEY-MAGNITUDE ALLOCATION (1.8.0, D8, S11) -- labeled secondary, Chromium-only, coarse.** A
   HeavyKeeper `addFrom` burst readout contrasting small keys against keys in `[2^30, 2^31)` via
   `performance.memory.usedJSHeapSize` deltas, exposing that `[2^30, 2^31)` keys are HeapNumbers on a
   31-bit-Smi build (N6). It is a labeled SECONDARY overlay like the heap readout (item 3), gated
   behind a **meter self-test control**: a lane KNOWN to box `>= 8 B/op` must read `>= 8`, else the
   readout shows **"n/a (meter blind)"** -- NEVER 0 (null is not zero; a blind meter must not read as a
   clean pass). Absent `performance.memory` (non-Chromium) the whole lane reads "n/a".
   **As built (demo session, 2026-10-04)**: `runKeyMagLane(meter)` in kernels.mjs, run ON CLICK from the
   HeavyKeeper truth panel (never the frame path). Method (hardened after review B9, which caught a
   fail-open clamp of negative readings to "0.0"): every lane is warmed (the control first, then 4 rounds of
   both key lanes), then the two key lanes run first and the boxing control LAST (8 windows each, all of the
   SAME 12.5k-op size), so the control's garbage is never collected inside a key-lane window. A negative
   window is a scavenge and is DROPPED (never clamped); each lane reports the SECOND-largest clean window
   (one JIT tier-up outlier discarded; a real box shows in every clean window); fewer than 3 clean windows,
   or a control below 8 B/op, makes the whole result "n/a (meter blind)". **Measured (headless Chrome,
   `--enable-precise-memory-info`, 4 runs x 8 windows, raw)**: control 12.00 B/op in every clean window (a
   pointer-compressed HeapNumber; scavenged windows read -66 .. -74 and were dropped); keys in [2^30, 2^31)
   0.00 in all 32 windows; small keys 0.00 except two single-window tier-up outliers (0.22, 0.50) -> the
   lane prints 0.0 / 0.0. The 1.8.0 F19 register-local hash path holds on a 31-bit-Smi build: N6 is closed
   for HK addFrom. Default Chrome (quantized `performance.memory`) reads "n/a (meter blind)" (control 0.00 in
   every window), exactly as designed.
   **Extended to every hashed-key member (ROADMAP 13, 2026-10-04)**: `runKeyMagLane(meter, ops, member)`,
   member in `KM_MEMBERS` = hk / shll / scm, each driven through its zero-box `addFrom` (`[key, 1]`,
   `[now, key]`, `[now, key, 1]`) from its own window function (a monomorphic call site, as a consumer calls
   it) over four key classes: small (`i & 1023`), [2^30, 2^31), >= 2^31 and large negative (-(2^30 + 1) and
   down -- below the 31-bit Smi minimum, so a HeapNumber in Chrome like the [2^30, 2^31) class). The
   explicit-time members get a running-counter `now` and W = 1e9, so no pane rotates inside a run. After
   every key window `kmDidWork` proves the window reached `addFrom` (shll / scm: `lastNow` equals the
   counter; hk: some key of the class has an estimate >= 1), else the row reads "n/a (a key window did no
   addFrom work)" -- review N4 showed a window that skips `addFrom` reads a perfect 0. The button is now
   "measure all": one row per member, green ONLY when every class reads <= 2 B/op (`keyMagClass`; an ok
   result with a boxing class is red). **Measured (headless Chrome 154, `--enable-precise-memory-info`,
   raw)**: 4 runs x 3 members x 4 classes x 8 windows of 12.5k ops = 384 key windows. Control 12.00 B/op in
   every clean window (scavenged windows -66.3 .. -94.0, dropped). Every row printed 0.0 for all four classes
   in 4/4 runs. Raw key windows: HeavyKeeper 0.0032, SlidingHyperLogLog 0.0013 - 0.0051, SlidingCountMin
   0.0022 - 0.0051 B/op, identical across classes within a run; 3 of 384 were single-window outliers (0.10,
   0.22, 0.33) that the second-largest aggregate drops. The residue is per WINDOW, not per op: at 4x the
   window size (50k ops, 2 runs) it falls 4x (HK 0.0008, SHLL / SCM 0.0013) -- a constant 40 - 64 B per
   window (the meter reads), while a per-key box would read 12 in every window. One 50k HK window read 8.78
   (every other window of that run 0.0008): a single-window event, dropped like the others. **N6 is closed
   for every hashed-key member.**
   Default Chrome: all three rows read "n/a (meter blind: the boxing control read 0.0 B/op < 8)".

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

### The DEMO AUDIT law (1.8.0, enforced by a static test over `index.html`, section 7 D10)

These are LAW, not style, and `demo/Demo.test.mjs` reads `index.html` as text and FAILS the build on
a violation (with an injected-violation control per rule, so the audit itself has teeth):
- **No layout read in a hot body.** No `getElementById` / `querySelector` / `getBoundingClientRect` /
  `.offsetWidth` / `.clientWidth` / `getComputedStyle` inside any `*Tick` / `*Draw` / loop / rAF-callback
  body. Every DOM handle is cached ONCE at init in a `$`-prefixed const; a forced reflow in the frame
  path is a defect.
- **Pointer events only for low-level interaction.** No `mousedown` / `mousemove` / `mouseup` /
  `touchstart` / `touchmove` / `touchend` listeners. `pointer*` for dragging; `click` stays for
  accessible button activation.
- **Hex before oklch.** Every CSS color declares a hex fallback BEFORE any `oklch()` on the same
  property, so a browser that ignores oklch takes the hex.
- **`:hover` inside `@media (hover: hover)`.** No bare `:hover` rule.
- **Telemetry text under the frame mask.** `textContent` / `innerText` writes happen only under the
  ~10Hz frame-counter mask, never every frame; no `toFixed` / `toLocaleString` in a per-frame loop.

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
  (`measureAllocs`) and trigger 0 GC over 200k ops (`GcProfiler` + `checkNoGc`,
  `maxMajor: 0, maxMinor: 0, maxPauseMs: 4`), mirroring `test/torture.mjs`. Each 200k-frame lane
  runs in its own fresh `node --expose-gc` child (`demo/DemoGcLane.mjs`), so earlier tests' garbage,
  JIT state and queued GC entries cannot land in the window. A PAUSED `stepX` (the idle-slide
  `advanceFrom` branch) is also measured at 0 B/op. The oracle steps are the
  allowed-to-allocate contrast and are kept OUT of the measured loop.
- **Retention + idle-slide**: 50 clear()/refill cycles -- `hk.size` returns to 0,
  `eh.bucketCount` stays `<= capacity`; and after pause cycles on the four windowed
  scenes the readout slides to empty (`eh.count()` / `shll.count()` / `scm.estimate(k)`
  -> 0, `sld.quantile(0.5)` -> NaN).
- **D10 (1.8.0) -- every new control/readout is gated**:
  - **Append-only golden**: `demo/golden-flat.json` pins each scene's flat buffer (big-endian Float64
    hex, 300 frames at defaults). A test re-runs the CURRENT kernels the same way and asserts every
    PRE-EXISTING slot is bit-identical; layouts are APPEND-ONLY (new slots only after the last existing
    index). A declared exception list carries any slot a pass legitimately changes (empty at P0; P2
    adds HK `H_RECALL` / `H_FOUND`). A must-fail control flips one golden bit and confirms the
    comparison reports it.
  - **Faithfulness per new readout**: every new displayed number equals the shipped getter / reader
    (`eh.levels` / `eh.capacity` / `eh.bytes`, the `maxCount` overflow throw's message, `ad` live
    range, `hk.estimate` under each key class, twin `sl.overflows`, `dd.lastDriftIndex` /
    `lastDirection`, `sd.rangeMin` / `rangeMax` / `quantileInto`, `scm.total(w)` / `estimateInto`),
    never hardcoded.
  - **Frame-path 0 B/op with the control ENGAGED**: the `dense10k` add-in-try/catch, the F17 sum
    lane, each key-magnitude class through `addFrom`, the query-rate twins, the latched twins, the
    B+1 render through `quantileInto`, and the `estimateInto` render path each measure 0 B/op and 0
    major GC over the long run (mirroring `test/torture.mjs`), plus the idle-slide/retention proof for
    each windowed scene.
  - **Contracts + S11 probes**: the D8 contracts probe asserts a bad `w` / `q` / key reads NaN
    (F12) and `{maxCuont: 5}` yields the shipped did-you-mean (F13); the S11 meter self-test asserts
    the "n/a (meter blind)" fallback fires when the known-boxing control reads `< 8 B/op` (never 0).
  - **The DEMO AUDIT** static test over `index.html` (sections 5-6) with a per-rule injected-violation
    control.
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
  `demo/` absent. `Adaptive.js` is NOT touched (the demo imports it, read-only); a demo update
  never bumps the library VERSION -- the demo TRACKS the working tree (whatever VERSION
  `Adaptive.js` currently carries; `/release` owns the bump), and the version-trinity test asserts
  kernels === `Adaptive.js` === `package.json` with NO hardcoded semver, so the demo can never pin a
  stale version. (`demo/golden-flat.json` is likewise repo-only, absent from `files[]`.)
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
