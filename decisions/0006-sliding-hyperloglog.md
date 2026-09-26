# ADR 0006 -- SlidingHyperLogLog (windowed distinct-count over the RECENCY axis)

Status: ACCEPTED (2026-09-24). The FIRST additive post-1.0 member (MINOR 1.1.0). PURE
APPEND: the four frozen core classes (ExponentialHistogram, ADWIN, ForwardDecay,
HeavyKeeper) stay BYTE-IDENTICAL; only the file header + the `VERSION` const change above
the append point.

## Context

The suite already has a CUMULATIVE distinct-count (`@zakkster/lite-sketch` HyperLogLog):
how many DISTINCT keys have I ever seen, in fixed space. lite-adaptive is the RECENCY
complement, so the missing question is: how many distinct keys in the LAST W? (unique
visitors in the last hour, distinct source IPs in the last 60s, distinct error codes in
the last N events). A cumulative HLL cannot forget; a hash-set-of-the-window is O(distinct)
memory and allocates. We want windowed distinct-count in FIXED, preallocated space at HLL
accuracy, 0 B/op on the hot path -- the adaptive sibling of lite-sketch's HyperLogLog.

## Decision -- an LFPM ring over a rotated-pane HLL

Structure: one HyperLogLog register bank of `m = 2^p` registers, but each register holds,
instead of a single `rho` byte, a small FIXED ring of `(timestamp, rho)` entries -- the
**LFPM ring** (List of Future Possible Maxima; Chabchoub-Hebrail, "Sliding HyperLogLog:
Estimating Cardinality in a Data Stream over a Sliding Window", 2010). The LFPM is a
per-register monotonic deque: entries are stored oldest -> newest with STRICTLY DECREASING
`rho`. The rule:

- An entry `(t_i, R_i)` can be the window-max at some future query time ONLY IF there is
  no NEWER entry `(t_j, R_j)` with `t_j > t_i` and `R_j >= R_i` -- because whenever
  `(t_i, R_i)` is in-window, the newer, at-least-as-large `(t_j, R_j)` is also in-window
  (it expires later) and dominates it. Such a dominated entry is useless: DROP it.
- On `add(now, key)` at register `j` with value `R` (the leftmost-1 position of the hash
  suffix): pop every tail (newest) entry with `rho <= R` (now dominated by the newer,
  larger-or-equal arrival), then append `(now, R)` at the tail. This keeps `rho` strictly
  decreasing head -> tail, so the head always holds the highest in-window `rho`.
- `count(w?)`: drop head entries with `stamp <= now - W` (expired), then the register's
  windowed max is the `rho` of the OLDEST non-expired entry (head, or the first entry with
  `stamp > now - w` for a sub-window `w <= W`). Feed the per-register maxima into Ertl's
  improved estimator.

The register value is EXACTLY the HLL register of the in-window distinct key set (a
duplicate key never lowers a max), so accuracy equals a static HLL built from the window --
the standard `1.04 / sqrt(m)` standard error, gated at 3 sigma, with no extra bias.

### Why a ring is honestly zero-GC

The `rho` values are integers in `[1, q+1]`, `q = 64 - p`, and the deque is strictly
decreasing, so its length is bounded by the number of distinct `rho` values (<= q+1 ~= 55
at p=10). In expectation the length is the number of backward records ~ `ln(N/m)`, which is
small (a handful). A FIXED preallocated ring of `ringCap` slots per register therefore
holds the deque with room to spare on any non-adversarial stream, and NOTHING allocates on
`add`. Memory: `m * ringCap * 9 B` (`Float64` stamp + `Uint8` rho) + O(m) head/len. Default
p=10, ringCap=8 -> ~72 KB.

### Ring overflow == honest degradation

An adversarial stream (many distinct decreasing `rho` values live at once) can want more
than `ringCap` entries in one register. Rather than allocate (which would break the zero-GC
contract) or silently corrupt, a full ring DROPS its OLDEST (head) entry -- the one that
expires soonest, so the accuracy loss is the shortest-lived -- and increments `_overflows`.
`degraded` reads `true` once `_overflows > 0`: the caller is TOLD the `1.04/sqrt(m)` bound is
no longer guaranteed (fail-loud, not fail-silent). Size `ringCap` up to `q+1` to make
overflow impossible; the default 8 is ample for ordinary streams.

## Rejected alternatives

- **Plain bucket / pane rotation (store a full HLL per time pane).** Keep C rotating HLL
  panes (e.g. one per W/C sub-interval); a query merges the live panes. This is simple but
  (a) costs `C x m` bytes -- C full register banks -- vs one bank + tiny rings, and (b) has
  a HARD granularity error: a key that arrived at the very edge of the oldest pane is counted
  for up to `W/C` too long (or dropped `W/C` too early). The LFPM ring is exact to the element
  timestamp with far less memory. REJECTED on both memory and edge-accuracy.
- **Store full HLL panes + a big backing array (the "timestamp per register-update"
  variant).** Keeping every register update with its timestamp is O(stream) memory -- not
  sublinear, not fixed. REJECTED: violates the fixed-space headline.
- **Expire on the hot `add` (walk the head each add).** Would add a stamp comparison + a
  loop to the hot body for a benefit (reclaimed slots) that the strictly-decreasing bound
  already makes rare. Expiry is LAZY / cold in `count()` (which always expires before it
  estimates, so the estimate is correct as of `now`). Hot `add` stays minimal. REJECTED for
  the hot path; adopted for `count`.

## The estimator (Ertl 2017, design-parity with lite-sketch)

Ertl's improved estimator -- a single TABLE-FREE formula (self-terminating `sigma` / `tau`
corrections, `alpha_inf = 1/(2 ln 2)`) accurate across the whole cardinality range, no
range-switching, no HLL++ empirical bias tables. Reimplemented INLINE (never an import):
`m` registers, `q = 64 - p`, the register multiplicity vector folded through
`z = m*tau(...) ; for k=q..1: z = 0.5*(z + C[k]) ; z += m*sigma(C[0]/m)`, then
`round(alpha_inf * m^2 / z)`. The `_hist` multiplicity vector is a reused `Int32Array(q+2)`
scratch, so `count()` allocates nothing (a cold O(m) co-headline, NOT a per-add cost).

## The hash + the PRNG/seed

The two-lane MurmurHash3 (design-parity with lite-sketch `Sketch.js` HyperLogLog, ADR 0001
there) is reimplemented INLINE in `add` / `addFrom` (pure int32 locals -> TurboFan keeps the
lanes in registers, so a uint32 >= 2^31 lane never boxes a HeapNumber). Register `j` = the
top `p` bits of lane H; `rho` = leftmost-1 of the `32 - p` bit suffix, falling back to lane
G for the low 32 bits (a full 64 - p bit suffix). Default seed `0x9e3779b1` (the SAME default
as lite-sketch, so the two members hash a key identically); `seed = 0` is a VALID distinct
seed, guarded as `=== undefined`, never falsy (null is not zero). No `Math.random`, no PRNG
-- SlidingHyperLogLog is fully deterministic given its seed.

## Time model + fail-closed domain

Caller-supplied MONOTONE `now` (a logical tick or ms; the member never reads the wall clock),
or COUNT mode (auto-tick, "last N items") when `now` is omitted -- the mode LOCKS at the
first add and a switch throws, EXACTLY like ExponentialHistogram. `addFrom(buf, i)` is
EXPLICIT-time only (it always carries a `now`). Fail closed, typeof-first, BEFORE any
mutation/alloc (the M1 EH lesson): `W` (finite > 0), `p` (int in `[4, 16]`), `ringCap` (a
power of two in `[2, 64]`, so the ring index is a `& (ringCap - 1)` mask -- the hot-path
law), `seed` (uint32), `key` (a safe integer), `now` (finite, non-decreasing,
mode-consistent), `count`'s sub-window `w` (finite, `0 < w <= W`). A rejected op is a
BYTE-IDENTICAL no-op.

## Memory model + sizing

- stamps: `Float64Array(m * ringCap)` = `8 * m * ringCap` B
- rho: `Uint8Array(m * ringCap)` = `m * ringCap` B
- head + len: `Int32Array(m)` x2 = `8 * m` B
- `_hist`: `Int32Array(q + 2)` = `4 * (q + 2)` B (reused count() scratch)

Total ~= `m * ringCap * 9 + 8 * m` B. p=10, ringCap=8 -> ~73 KB. To eliminate overflow set
`ringCap >= q + 1`.

## Honest degradation disclosure

`degraded` (true once any ring overflowed) and `overflows` (the count) are getters, so a
caller can assert the sketch stayed within its accuracy contract. The witness gates
`degraded === false` on the measured workload; a caller sizing `ringCap` too small for an
adversarial stream will see `degraded` flip and must widen `ringCap` (never a silent wrong
answer).

## Amendment (1.7.0, F8) -- queries are PURE; expiry moved into `add`

1.6.0 `count()` was DESTRUCTIVE: it dropped expired ring heads (`stamp <= now - W`) and wrote
the new head/len back. So `overflows` / `degraded` depended on HOW OFTEN you queried -- a
never-queried instance and an every-add-queried instance saw DIFFERENT overflow counts on the
SAME stream (measured 6556 vs 6562; the audit's adversarial case 2694 vs 162). llms.txt and
this ADR promised queries are pure (R7), so this was a contract violation.

FIX -- expire in the WRITE, read-only in the query:
- `add` / `addFrom`: after popping dominated tail entries and BEFORE the ring-full check, drop
  expired heads off THIS add's clock (`stamp <= t - W`). A ring that is STILL full after that
  expiry means a genuine IN-WINDOW eviction -> `_overflows++`. Amortized O(1): each entry is
  dropped exactly once, in the write path. `_overflows` now counts only real capacity pressure
  and is independent of query cadence.
- `count(w?)` is PURE -- it NEVER mutates the rings. Its read scan already skipped every
  `stamp <= subCut`, and `subCut = now - w >= now - W`, so an expired-by-W entry is skipped
  anyway. The estimate is therefore BIT-IDENTICAL to the 1.6.0 destructive path on any stream
  (the dead `fullCut` and both write-backs were removed).
- `advance` / `advanceFrom` stay CLOCK-ONLY and must NOT expire the rings. Leaving them
  untouched keeps `overflows` independent of advance frequency too (an entry that only leaves
  because time moved on, with no new add competing for its slot, is not capacity pressure). The
  pure `count()` self-filters by `_now`, so a bare clock bump still slides an idle stream to 0.

GATE (HARD, `test/witness.mjs` F8 purity lane + `test/differential/SHLLParity.test.mjs`): two
twins fed the same 200k-op stream (p4/ringCap2 so overflows fire), one queried after every add
and one never -- `overflows` EQUAL (measured 17294 == 17294) and `_stamps`/`_rho`/`_head`/`_len`
BYTE-IDENTICAL; a ring snapshot byte-identical across 100 consecutive `count()` calls;
`count()` bit-identical to the frozen 1.6.0 golden at every query point on a non-overflowing
stream (full + sub-window). The windowed-distinct witness still passes.
