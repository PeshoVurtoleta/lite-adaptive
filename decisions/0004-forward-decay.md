# 0004 -- ForwardDecay: time-decayed aggregates (the smooth-recency member)

Status: accepted (v0.3.0)

## Context

ForwardDecay (Cormode-Shkapenyuk-Srivastava-Xu, "Forward Decay: A Practical Time
Decay Model for Streaming Systems", ICDE 2009) is the family's SMOOTH-recency member:
where ExponentialHistogram forgets at a HARD window edge and ADWIN forgets at a
DATA-DRIVEN boundary, ForwardDecay forgets GRADUALLY -- every element's influence
shrinks with its age, so recent data dominates without any cutoff. It answers "what is
the decayed count / sum / mean / rate, weighting recent items more?" in O(1) space (two
scalars). It is a PURE APPEND onto the M1/M2 chassis (ADR 0001/0002/0003): the
ExponentialHistogram and ADWIN classes stay byte-identical; only the file header roster
comment + `VERSION` + the appended `ForwardDecay` class change.

## The settled calls

1. **Forward decay, not backward decay.** A decay model weights an element of age
   `now - t_i`. The obvious BACKWARD formulation weights it `h(now - t_i)` for a
   decreasing `h` -- but then EVERY weight changes on every query (the reference moves
   with `now`), which cannot be maintained as a running sum and re-weights the whole
   history each read. FORWARD decay (the paper's insight) instead weights by an
   INCREASING `g` of the age measured FORWARD from a fixed LANDMARK `L`:
   `w_i = g(t_i - L)`. The weight is computed ONCE at insert and never revised, so it
   accumulates into a running scalar; a query folds in the common `now` factor. For
   exponential decay `g(x) = exp(lambda*x)`, `lambda = ln2 / halfLife`, the ratio
   `g(t_i - L) / g(now - L) = exp(-lambda*(now - t_i))` is exactly the intended
   age-decay -- landmark-independent. This is the numeric-stability call: forward decay
   avoids the per-query re-weighting drift of backward decay.

   Two accumulators, maintained incrementally from the landmark `L`:

       C  = sum_i g(t_i - L)               (decayed COUNT / total weight)
       Sv = sum_i value_i * g(t_i - L)     (decayed weighted value SUM)

   Queries at time `now` fold the common age factor back in:

       decayedCount(now) = C  * exp(-lambda * (now - L))
       decayedSum(now)   = Sv * exp(-lambda * (now - L))
       mean(now)         = Sv / C                          (the age factor CANCELS)
       rate(now)         = decayedCount(now) * lambda

2. **The rebase is EXACT (modulo FP).** `g(x) = exp(lambda*x)` grows without bound, so the
   accumulators would overflow on a long increasing-`t` stream. The fix is a LANDMARK
   REBASE: when `lambda*(t - L)` would exceed `FD_EXP_CAP`, move the landmark to `t`:

       f = exp(-lambda*(t - L));  C *= f;  Sv *= f;  L = t;

   PROOF it is exact: every accumulated term is `value_i * exp(lambda*(t_i - L))`.
   Multiplying the whole sum by `f = exp(-lambda*(t - L))` gives, term by term,
   `value_i * exp(lambda*(t_i - L)) * exp(-lambda*(t - L)) = value_i * exp(lambda*(t_i - t))`
   -- which is exactly the same term re-expressed against the NEW landmark `t`. The
   landmark is a free gauge: `C` and `Sv` change representation, the decayed aggregates
   (which always divide by `g(now - L)`) do NOT. It is a single common factor pulled out
   of a sum -- exact in exact arithmetic, and to ~1 ULP in doubles (verified by the
   witness: |rebased - never-rebased-on-a-short-stream| / |value| ~ 1e-16).

3. **FD_EXP_CAP = 40 -- the no-overflow argument (corrected).** Double.MAX ~= 1.7977e308,
   and `exp(709.78) ~= Double.MAX` (beyond it `exp` returns `Infinity`). The cap bounds a
   SINGLE weight `exp(lambda*(t - L))`, but the accumulators hold a SUM of weighted terms,
   so the cap must leave head-room for the whole sum, not one term. The original `700` did
   not: `exp(700) ~= 1.014e304` is only ~1.77e4x below Double.MAX (`1.7977e308 / 1.014e304`),
   so the accumulator overflowed to `Infinity` on ordinary, in-domain input the witness never
   exercised -- e.g. a single `add(700, v)` with `v >= 1.7977e308 / exp(700) ~= 17725` at
   `arg = 700` (which does NOT trip `> 700`), or ~17724 same-timestamp adds pinned at
   `arg = 700` (rebase never fires because `L` only advances when `arg > cap`). Both then made
   `count()/sum()/rate()` return `Infinity` silently -- a fail-OPEN, against suite law.

   We rebase once the argument would exceed **40**: a single weight is then at most
   `exp(40) ~= 2.353e17`, and the accumulator overflows only when the running
   (value-weighted) term count since the last rebase exceeds `Double.MAX / exp(40) ~= 7.6e290`
   -- physically unreachable. A rebase fires only every `40 / ln2 ~= 57.7` half-lives of
   elapsed `t`; an item that old carries weight `2^-57.7 ~= 4e-18`, so the rescale discards
   nothing measurable and the aggregate stays exact (the witness large-value and
   same-timestamp-flood lanes confirm it). The check `lambda*(t - L) > 40` runs in the hot
   body as a single multiply + compare; the rebase itself is cold, O(1), 0 B/op.

   **Belt-and-suspenders (the pathological tail).** No finite cap can defend against a single
   value within a factor of `exp(cap)` of Double.MAX (e.g. `v ~ 1e300`), because one such term
   alone overflows the accumulator. That remainder is caught FAIL-CLOSED, not fail-open: the
   cold query guard `_guardFinite` throws `[lite-adaptive]` when `_C` or `_Sv` is non-finite,
   so `count()/sum()/mean()/rate()` never return `Infinity`/`NaN`. Zero hot-body cost (the
   check lives only on the cold query path).

4. **rate() = decayedCount * lambda is a DEFINITION, not a theorem.** Under the
   exponential kernel a STEADY arrival of `r` events per unit time converges to a decayed
   count `C_dec -> r / lambda` (a geometric series with ratio `exp(-lambda)` summing to
   `~1/lambda` per unit rate). So `decayedCount(now) * lambda -> r` -- the decayed events
   per unit time. We DEFINE `rate()` this way (it is the natural inverse of the kernel's
   time constant); it is not derived from a distributional assumption and is exact only in
   the steady-state limit. Documented as a definition so no caller mistakes it for a
   guaranteed instantaneous rate.

5. **The value domain is any FINITE real (signed OK) -- a deliberate difference from EH.**
   ExponentialHistogram rejects non-positive values (its `size` column is a population-
   weighted sum whose error bound assumes positivity). ForwardDecay keeps `C` (the decayed
   COUNT) and `Sv` (the decayed weighted SUM) as SEPARATE accumulators, so a negative
   value lowers `Sv` (and the mean) while still contributing ONE decayed event to `C` --
   a proper decayed weighted mean over signed data. Only a non-number / `NaN` /
   `+-Infinity` value is rejected (a byte-identical no-op).

6. **The query-now contract.** `count(now?)` / `sum(now?)` / `mean(now?)` / `rate(now?)`
   take an OPTIONAL query time that defaults to the last add time. An explicit query time
   must be a finite number `>= the last add time`: a query in the PAST would ask the
   structure to UN-DECAY (multiply by `exp(+lambda*positive)`, amplifying), which is not a
   meaningful decayed answer -- so it throws `[lite-adaptive]`. In count mode the query
   uses the internal tick (pass no arg). Queries NEVER throw on an empty summary (they
   return 0, null is not zero) or on a valid future `now`.

7. **The time model mirrors EH exactly.** A caller-supplied MONOTONE `now` (explicit
   mode) or an auto-tick (count mode); the mode LOCKS at the first add and a switch, a
   non-finite `now`, or a decreasing `now` throws. The landmark is set to the first
   element's time at the first add. All value + `now` validation happens BEFORE any state
   mutation, so a rejected add is a byte-identical no-op (the M1 reviewer lesson).

## Consequences

- The exact-aggregate witness (`test/witness.mjs`, `fdExactAggregate` mode) GATES:
  `|fd - oracle| / |oracle| <= 1e-9` on EVERY query across 3 `halfLife` x 3 stream-shapes
  (>= 5000 queries), where the oracle brute-forces the decayed aggregate directly from
  every stored `(t_i, value_i)` at each query time. NEGATIVE CONTROLS (the N4 discipline)
  are REJECTED by the same gate: `fdNoRescale` (rebases the landmark but SKIPS the `C, Sv`
  rescale -> the aggregate diverges) and `fdNoRebase` (never rebases -> the accumulator
  overflows to `Infinity` on a long increasing-`t` stream). Both the rebase branch AND its
  rescale are load-bearing.
- O(1) space (two scalars); 0 B/op on `add` INCLUDING the rebase branch, proven by
  `test/torture.mjs` (a dedicated FD lane + a rebase-heavy lane driving `arg > 700`
  repeatedly) and the `test/perf/PerfGate.test.mjs` `fdAdd` scenario (flat throughput,
  0 old-gen) with a must-allocate control that trips the gate.
- The recency TRIPLE for the family is now complete: HARD window (EH) / ADAPTIVE window
  (ADWIN) / SMOOTH decay (ForwardDecay). Only HeavyKeeper (decayed top-k) remains to 1.0.0.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
