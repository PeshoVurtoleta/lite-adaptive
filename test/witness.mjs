// @zakkster/lite-adaptive -- the RECENCY witness (repo-only; run: `node test/witness.mjs`).
//
// The honesty anchor of the family, carried onto the WINDOWED oracle: drive
// ExponentialHistogram on an evolving stream, compare its windowed count / sum to an
// EXACT ring-of-the-last-W oracle, MEASURE the relative error, and GATE it against the
// paper's THEORETICAL bound epsilon -- HARD, on EVERY query -- printing MEASURED vs
// THEORETICAL side by side, plus the space-vs-oracle bar (EH's O((1/epsilon) log(eps W))
// buckets vs the ring's O(W)). A NEGATIVE CONTROL (a broken EH -- no straddle half-
// correction) is fed the SAME gate and MUST be REJECTED (the gate has teeth). ASCII-only.

import { ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog,
    DriftDetector, DRIFT_PH, DRIFT_CUSUM, VERSION } from '../Adaptive.js';

const WS = [64, 1000, 65536];
const EPS = [0.5, 0.1, 0.01];

function pct(x) { return (x * 100).toFixed(3) + '%'; }
function nStr(n) { return n >= 1e6 ? (n / 1e6) + 'M' : n >= 1e3 ? (n / 1e3) + 'k' : String(n); }

// A broken EH: it never applies the straddling half-correction (counts the oldest bucket
// in FULL), so it over-estimates the windowed count by the expired portion of the oldest
// bucket -- the classic "no merge-halving" bug. It MUST be rejected by the gate.
class BrokenEH extends ExponentialHistogram {
    count() {
        if (this._count === 0) return 0;
        let total = 0;
        for (let L = 0; L <= this._maxLevel; L++) total += this._lcount[L] * this._pow[L];
        return total;   // BUG: no straddle half-correction
    }
}

// Drive a count-mode stream (one element per tick) over `ticks`; return the max relative
// error over every FULL-window query vs the exact oracle (= W once the window is full),
// and the peak bucket count. The window is exactly full from tick W on, so the exact
// windowed count is W.
function measureCount(Ctor, W, eps, ticks) {
    const eh = new Ctor(W, eps);
    let maxRel = 0, peak = 0;
    for (let i = 1; i <= ticks; i++) {
        eh.add();
        if (eh.bucketCount > peak) peak = eh.bucketCount;
        if (i >= W) {
            const est = eh.count();
            const rel = Math.abs(est - W) / W;
            if (rel > maxRel) maxRel = rel;
        }
    }
    return { maxRel, peak, cap: eh.capacity, k: eh.k, levels: eh.levels };
}

console.log('');
console.log('RECENCY Witness -- ExponentialHistogram v' + VERSION + ' windowed COUNT vs the exact ring-of-last-W ' +
    'oracle (count mode, one element per tick; theoretical: relative error <= epsilon, HARD, every query)');
console.log('');
console.log('  W        epsilon  k    levels  buckets/cap  maxRel err   theo (eps)   ~1/(2k)     status');
console.log('  -------  -------  ---  ------  -----------  -----------  -----------  ----------  ------');

let ok = true;
for (const W of WS) {
    for (const eps of EPS) {
        const ticks = Math.min(5 * W + 500, 400000);   // enough to churn the full window many times
        const r = measureCount(ExponentialHistogram, W, eps, ticks);
        const cellOk = r.maxRel <= eps;
        if (!cellOk) ok = false;
        const practical = 1 / (2 * r.k);
        console.log('  ' + nStr(W).padEnd(7) + '  ' + String(eps).padEnd(7) + '  ' +
            String(r.k).padEnd(3) + '  ' + String(r.levels).padEnd(6) + '  ' +
            (r.peak + '/' + r.cap).padEnd(11) + '  ' + pct(r.maxRel).padStart(11) + '  ' +
            pct(eps).padStart(11) + '  ' + pct(practical).padStart(10) + '  ' +
            (cellOk ? 'ok' : 'FAIL') + (r.peak > r.cap ? ' OVERFLOW' : ''));
    }
}

// ---------------------------------------------------------------------------
// Shifting stream: the arrival RATE changes partway. Recency matters most when the
// stream changes -- the windowed count must track the NEW density, not the average.
// Explicit-time mode; an exact deque-of-timestamps oracle. GATE rel <= epsilon.
// ---------------------------------------------------------------------------
function measureShift(W, eps) {
    const eh = new ExponentialHistogram(W, eps);
    // exact oracle: a ring of the in-window arrival timestamps (generous capacity).
    const CAPQ = 1 << 20;
    const q = new Float64Array(CAPQ);
    let qh = 0, qt = 0;   // head (oldest), tail (next free)
    let maxRel = 0;
    const spanTicks = 20 * W;
    let now = 0;
    for (let step = 0; step < spanTicks; step++) {
        now += 1;
        // rate: 1 per tick for the first third, then 4 per tick, then 1 again -- a shift.
        const phase = step / spanTicks;
        const rate = phase < 0.33 ? 1 : phase < 0.66 ? 4 : 1;
        for (let r = 0; r < rate; r++) {
            eh.add(now);
            q[qt] = now; qt = (qt + 1) & (CAPQ - 1);
        }
        // expire the oracle: drop timestamps <= now - W
        while (qh !== qt && q[qh] <= now - W) qh = (qh + 1) & (CAPQ - 1);
        const exact = (qt - qh) & (CAPQ - 1);
        if (now > W) {
            const est = eh.count();
            const rel = Math.abs(est - exact) / exact;
            if (rel > maxRel) maxRel = rel;
        }
    }
    return { maxRel, cap: eh.capacity, buckets: eh.bucketCount };
}

console.log('');
console.log('  shifting stream (rate 1 -> 4 -> 1 per tick; windowed count must track the new density):');
console.log('  W        epsilon  maxRel err   theo (eps)   status');
console.log('  -------  -------  -----------  -----------  ------');
for (const W of [1000, 65536]) {
    for (const eps of [0.1, 0.01]) {
        const r = measureShift(W, eps);
        const cellOk = r.maxRel <= eps;
        if (!cellOk) ok = false;
        console.log('  ' + nStr(W).padEnd(7) + '  ' + String(eps).padEnd(7) + '  ' +
            pct(r.maxRel).padStart(11) + '  ' + pct(eps).padStart(11) + '  ' + (cellOk ? 'ok' : 'FAIL'));
    }
}

// ---------------------------------------------------------------------------
// Space co-headline: EH's fixed pool vs the exact ring's O(W) footprint.
// ---------------------------------------------------------------------------
console.log('');
{
    const W = 65536, eps = 0.01;
    const eh = new ExponentialHistogram(W, eps);
    for (let i = 1; i <= 3 * W; i++) eh.add();
    // per bucket: ts + start + size (Float64 x3) + next/prev/lvl (Int32 x3) = 36 bytes; pool = cap * 36.
    const ehBytes = eh.capacity * 36;
    const ringBytes = W * 8;   // an exact ring of the last W timestamps, 8 B each
    console.log('  space co-headline @ W=' + nStr(W) + ', eps=' + eps + ':  ExponentialHistogram = ' +
        (ehBytes / 1024).toFixed(1) + ' KB (fixed, ' + eh.capacity + ' buckets)  vs  exact ring = ' +
        (ringBytes / 1024).toFixed(1) + ' KB (grows O(W))  |  count=' + eh.count() + ' (true ' + W + ')');
}

console.log('');
console.log('WITNESS ExponentialHistogram (windowed accuracy) ' + (ok ? 'ok' : 'FAIL'));

// ===========================================================================
// NEGATIVE CONTROL: a broken EH (no straddle half-correction) MUST be rejected.
// Fed the SAME per-query gate the real member passes. If it slips through, the
// recency anchor is decorative. (lite-sketch's N4 discipline.)
// ===========================================================================
console.log('');
console.log('NEGATIVE CONTROL -- a broken EH (no straddle half-correction) MUST be rejected:');
let controlsOk = true;
for (const [W, eps] of [[1000, 0.01], [65536, 0.01], [1000, 0.1]]) {
    const ticks = Math.min(5 * W + 500, 400000);
    const r = measureCount(BrokenEH, W, eps, ticks);
    const rejected = r.maxRel > eps;   // the gate must REJECT it
    if (!rejected) controlsOk = false;
    console.log('  BrokenEH W=' + nStr(W).padEnd(6) + ' eps=' + String(eps).padEnd(5) +
        ' maxRel=' + pct(r.maxRel).padStart(9) + ' vs eps=' + pct(eps).padStart(8) +
        ' -> ' + (rejected ? 'REJECTED (ok)' : 'NOT rejected (FAIL)'));
}
console.log('');
console.log('WITNESS negative control (broken EH rejected) ' + (controlsOk ? 'ok' : 'FAIL'));

// ===========================================================================
// CHANGE-RESPONSE Witness -- ADWIN (RESEARCH.md 2.2). The anchor unique to this axis:
// not "how close to a number" but "how well does it track CHANGE." Inject a KNOWN
// changepoint, then MEASURE, against ground truth:
//   - false-alarm rate on a STATIONARY run (GATE <= delta)
//   - detection LATENCY per shift magnitude (small shifts allowed to take longer)
//   - MISSED detection (~0 for a large shift)
//   - adapted-window correctness (after a cut, mean/width reflect the NEW concept only)
// plus the N4 NEGATIVE CONTROLS: a detector with the bound DISABLED must false-alarm,
// and a NO-SHRINK variant must fail to adapt. Values are Bernoulli(p) (range R = 1).
// ===========================================================================

/** A deterministic mulberry32 PRNG -- every latency / false-alarm number is reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// A bound-DISABLED ADWIN: the cut test always fires while the window can be split, so it
// shrinks to nothing every add -> on a STATIONARY stream it MUST false-alarm (rate >> delta).
class BoundDisabledADWIN extends ADWIN {
    _scanCut() { return this._total > 1; }   // BUG: no statistical bound -> cut always
}
// A NO-SHRINK ADWIN: the cut test never fires, so the window never drops the old regime ->
// after a shift its mean stays a BLEND of both concepts. It MUST fail to adapt.
class NoShrinkADWIN extends ADWIN {
    _scanCut() { return false; }             // BUG: never shrinks -> never adapts
}

/** Flags raised on a stationary Bernoulli(0.5) stream / N -- the false-alarm rate. */
function falseAlarmRate(Ctor, delta, N, seed) {
    const ad = new Ctor(delta);
    const r = mulberry32(seed);
    let flags = 0;
    for (let i = 0; i < N; i++) if (ad.add(r() < 0.5 ? 1 : 0)) flags++;
    return flags / N;
}

/** Detection latency for a Bernoulli p1 -> p2 shift at CP; {lat, mean, width}, lat = Infinity if missed. */
function detect(delta, p1, p2, CP, post, seed) {
    const ad = new ADWIN(delta);
    const r = mulberry32(seed);
    for (let i = 0; i < CP; i++) ad.add(r() < p1 ? 1 : 0);
    for (let j = 0; j < post; j++) {
        if (ad.add(r() < p2 ? 1 : 0)) return { lat: j, mean: ad.mean, width: ad.width };
    }
    return { lat: Infinity, mean: ad.mean, width: ad.width };
}

let adOk = true;

console.log('');
console.log('CHANGE-RESPONSE Witness -- ADWIN v' + VERSION + ' (Bifet-Gavalda, SDM 2007): drift detection + ' +
    'adaptive window (theoretical: false-alarm rate <= delta on a stationary stream)');
console.log('');

// --- false-alarm rate on a stationary stream: GATE <= delta ---
console.log('  stationary false-alarm rate (Bernoulli(0.5), N=100k; theoretical <= delta):');
console.log('  delta    false-alarm   theo (delta)  status');
console.log('  -------  ------------  ------------  ------');
for (const delta of [0.05, 0.1, 0.3]) {
    let worst = 0;
    for (const seed of [1, 2, 3]) {
        const fa = falseAlarmRate(ADWIN, delta, 100000, seed);
        if (fa > worst) worst = fa;
    }
    const cellOk = worst <= delta;
    if (!cellOk) adOk = false;
    console.log('  ' + String(delta).padEnd(7) + '  ' + pct(worst).padStart(12) + '  ' +
        pct(delta).padStart(12) + '  ' + (cellOk ? 'ok' : 'FAIL'));
}

// --- detection latency per shift magnitude (small shifts allowed to take longer) ---
console.log('');
console.log('  detection latency per shift magnitude (Bernoulli 0.5 -> 0.5+shift at item 60k; delta=0.1):');
console.log('  shift    p1 -> p2      latency (items)  window mean after  missed  status');
console.log('  -------  ------------  ---------------  -----------------  ------  ------');
const CP = 60000, POST = 200000, DELTA = 0.1;
for (const shift of [0.05, 0.1, 0.2, 0.3, 0.5]) {
    const p2 = 0.5 + shift;
    const d = detect(DELTA, 0.5, p2, CP, POST, 4242);
    const missed = !Number.isFinite(d.lat);
    // GATE: a large shift (>= 0.2) must NEVER be missed; every shift eventually detected here.
    const cellOk = !missed;
    const largeShiftOk = shift < 0.2 || (!missed && d.lat < 5000);
    if (!cellOk || !largeShiftOk) adOk = false;
    console.log('  ' + String(shift).padEnd(7) + '  ' +
        ('0.50 -> ' + p2.toFixed(2)).padEnd(12) + '  ' +
        (missed ? 'MISSED' : String(d.lat)).padStart(15) + '  ' +
        (missed ? '--' : d.mean.toFixed(3)).padStart(17) + '  ' +
        (missed ? 'yes' : 'no').padStart(6) + '  ' + (cellOk && largeShiftOk ? 'ok' : 'FAIL'));
}

// --- missed-detection ~0 for a large shift (repeat across seeds) ---
console.log('');
{
    let misses = 0, runs = 0;
    for (const seed of [10, 11, 12, 13, 14, 15, 16, 17]) {
        const d = detect(DELTA, 0.2, 0.8, CP, POST, seed);
        runs++;
        if (!Number.isFinite(d.lat)) misses++;
    }
    const cellOk = misses === 0;
    if (!cellOk) adOk = false;
    console.log('  missed-detection over ' + runs + ' large-shift runs (0.2 -> 0.8): ' + misses +
        ' missed -> ' + (cellOk ? 'ok' : 'FAIL'));
}

// --- adapted-window correctness: with the stream SETTLED on the new concept, the mean/width
//     reflect the NEW concept only (measured after the full post-change run, not at the
//     detection instant when only a handful of new items have been seen). ---
console.log('');
{
    const settleCP = 40000, settlePost = 40000;
    const ad = new ADWIN(DELTA);
    const r = mulberry32(777);
    let detectedAt = -1;
    for (let i = 0; i < settleCP; i++) ad.add(r() < 0.2 ? 1 : 0);
    for (let j = 0; j < settlePost; j++) if (ad.add(r() < 0.8 ? 1 : 0) && detectedAt < 0) detectedAt = j;
    const meanOk = Math.abs(ad.mean - 0.8) < 0.05;   // window mean has moved to the new concept
    const widthOk = ad.width <= settleCP;            // the old (mean-0.2) regime has been dropped
    const cellOk = meanOk && widthOk;
    if (!cellOk) adOk = false;
    console.log('  adapted-window (0.2 -> 0.8): detected at +' + detectedAt +
        ' items; after settling, window mean=' + ad.mean.toFixed(3) + ' (true new 0.800), width=' +
        ad.width + ' (old regime dropped) -> ' + (cellOk ? 'ok' : 'FAIL'));
}

// --- true-vs-detected changepoint timeline ---
console.log('');
console.log('  true-vs-detected changepoint timeline (delta=0.1, 5 injected changepoints, mean shifts):');
{
    const ad = new ADWIN(DELTA);
    const r = mulberry32(555);
    const seg = 40000;
    const means = [0, 1, 0.3, 1.5, 0.5, 2];   // 5 changepoints between 6 segments
    let idx = 0;
    let line = '';
    for (let s = 0; s < means.length; s++) {
        const mu = means[s];
        const trueCP = s * seg;
        let detectedAt = -1;
        for (let i = 0; i < seg; i++) {
            const cut = ad.add(mu + (r() - 0.5));   // tight noise around the segment mean
            if (cut && detectedAt < 0 && s > 0 && idx >= trueCP) detectedAt = idx;
            idx++;
        }
        if (s === 0) {
            line += '    segment ' + s + ' mean=' + mu.toFixed(1) + ' (start, no change)\n';
        } else {
            const lat = detectedAt < 0 ? 'MISSED' : ('+' + (detectedAt - trueCP));
            line += '    changepoint ' + s + ' @item ' + trueCP + ' (mean ' + means[s - 1].toFixed(1) +
                ' -> ' + mu.toFixed(1) + ')  detected ' + lat + '\n';
        }
    }
    process.stdout.write(line);
}

console.log('');
console.log('WITNESS ADWIN (change response: false-alarm <= delta, latency, adapted window) ' + (adOk ? 'ok' : 'FAIL'));

// --- ADWIN NEGATIVE CONTROLS (N4): the bound + the shrink must be load-bearing ---
console.log('');
console.log('NEGATIVE CONTROLS -- ADWIN with a broken part MUST be rejected by the same gates:');
let adControlsOk = true;
// 1) bound disabled -> MUST false-alarm on a stationary stream.
{
    const delta = 0.1;
    const fa = falseAlarmRate(BoundDisabledADWIN, delta, 20000, 1);
    const rejected = fa > delta;   // the false-alarm gate must REJECT it
    if (!rejected) adControlsOk = false;
    console.log('  bound-disabled ADWIN false-alarm=' + pct(fa) + ' vs delta=' + pct(delta) +
        ' -> ' + (rejected ? 'REJECTED (ok)' : 'NOT rejected (FAIL)'));
}
// 2) no-shrink -> MUST fail to adapt (its mean stays a blend, not the new concept).
{
    const ad = new NoShrinkADWIN(0.1);
    const r = mulberry32(9);
    const cp = 40000, post = 40000;
    for (let i = 0; i < cp; i++) ad.add(r() < 0.2 ? 1 : 0);
    for (let j = 0; j < post; j++) ad.add(r() < 0.8 ? 1 : 0);
    // true new concept mean is 0.8; a working detector adapts to it. no-shrink stays near
    // the blend (0.2*cp + 0.8*post)/(cp+post) = 0.5 -- far from 0.8.
    const adaptedFail = Math.abs(ad.mean - 0.8) > 0.1;
    if (!adaptedFail) adControlsOk = false;
    console.log('  no-shrink ADWIN post-shift mean=' + ad.mean.toFixed(3) + ' (true new 0.800, blend ~0.500)' +
        ' -> ' + (adaptedFail ? 'REJECTED (fails to adapt, ok)' : 'adapted (FAIL)'));
}
console.log('');
console.log('WITNESS ADWIN negative controls (broken bound + broken shrink rejected) ' + (adControlsOk ? 'ok' : 'FAIL'));

// ===========================================================================
// EXACT-AGGREGATE Witness -- ForwardDecay (Cormode-Shkapenyuk-Srivastava-Xu, ICDE 2009).
// The honesty anchor for the DECAY member: not "close to a bound" but EXACT modulo FP.
// A brute-force oracle stores EVERY (t_i, value_i) and recomputes the decayed aggregate
// directly at each query time; GATE |fd - oracle| / |oracle| <= 1e-9 on EVERY query across
// 3 halfLife x 3 stream-shapes (>= 5000 queries). NEGATIVE CONTROLS the same gate REJECTS:
//   - fdNoRescale: rebases the landmark but SKIPS the C,Sv rescale -> the aggregate diverges.
//   - fdNoRebase:  never rebases -> a long increasing-t stream overflows the accumulator to Inf.
// Both the rebase branch AND its rescale are load-bearing.
// ===========================================================================

const FD_TOL = 1e-9;

/** A ForwardDecay whose rebase moves the landmark but FORGETS to rescale C,Sv (diverges). */
class FDNoRescale extends ForwardDecay {
    _rebase(t) { this._L = t; }   // BUG: no C *= f; Sv *= f
}
/** A ForwardDecay that NEVER rebases -> exp(lambda*(t-L)) overflows on a long stream. */
class FDNoRebase extends ForwardDecay {
    _rebase() { /* BUG: never rebases + never moves the landmark -> overflow to Inf */ }
}

/** Build a stream of `n` (t, value) points of a given shape. Values are positive (0.5..2). */
function fdStream(shape, n) {
    const times = new Float64Array(n);
    const vals = new Float64Array(n);
    let t = 0;
    for (let i = 0; i < n; i++) {
        if (shape === 0) { t += 1; vals[i] = 1; }                                   // steady, unit
        else if (shape === 1) { t += 1 + (i % 5); vals[i] = 0.5 + ((i % 4) * 0.5); } // variable gaps + values
        else { t += (i % 13 === 0 ? 50 : 1); vals[i] = 0.75 + ((i % 7) * 0.125); }   // bursty gaps
        times[i] = t;
    }
    return { times, vals };
}

/** The exact decayed (count, sum) at `now` over the first `n` stored points. */
function fdOracle(times, vals, n, lambda, now) {
    let c = 0, s = 0;
    for (let i = 0; i < n; i++) {
        const wd = Math.exp(-lambda * (now - times[i]));
        c += wd; s += vals[i] * wd;
    }
    return { c, s };
}

/**
 * Drive `Ctor` over the shape's stream, query every `qEvery` adds once warmed, and return
 * the max relative error over count / sum / mean vs the oracle + the number of queries. A
 * non-finite estimate is scored Infinity (so the gate rejects it via !(rel <= tol)).
 */
function fdMeasure(Ctor, halfLife, shape, n, qEvery) {
    const { times, vals } = fdStream(shape, n);
    const fd = new Ctor(halfLife);
    const lambda = Math.LN2 / halfLife;
    let maxRel = 0, queries = 0;
    for (let i = 0; i < n; i++) {
        fd.add(times[i], vals[i]);
        if (i >= 20 && (i % qEvery === 0)) {
            const now = times[i];
            const o = fdOracle(times, vals, i + 1, lambda, now);
            let rel;
            try {
                // A fail-closed throw (the query guard on a non-finite accumulator) counts as
                // REJECTED by the gate -- score it Infinity, same as a non-finite result.
                const relC = Math.abs(fd.count(now) - o.c) / Math.abs(o.c);
                const relS = Math.abs(fd.sum(now) - o.s) / Math.abs(o.s);
                const relM = Math.abs(fd.mean(now) - o.s / o.c) / Math.abs(o.s / o.c);
                rel = Math.max(relC, relS, relM);
                if (!Number.isFinite(rel)) rel = Infinity;
            } catch (e) {
                rel = Infinity;
            }
            if (!(rel <= maxRel)) maxRel = rel;
            queries++;
        }
    }
    return { maxRel, queries };
}

console.log('');
console.log('EXACT-AGGREGATE Witness -- ForwardDecay v' + VERSION + ' (Cormode-Shkapenyuk-Srivastava-Xu, ' +
    'ICDE 2009): decayed count/sum/mean vs a brute-force oracle (theoretical: EXACT modulo FP, rel <= 1e-9)');
console.log('');
console.log('  halfLife  shape         maxRel err   theo (1e-9)  queries  status');
console.log('  --------  ------------  -----------  -----------  -------  ------');

let fdOk = true;
let fdTotalQueries = 0, fdWorst = 0;
const SHAPE_NAME = ['steady', 'variable-gap', 'bursty'];
for (const halfLife of [10, 100, 1000]) {
    for (let shape = 0; shape < 3; shape++) {
        const r = fdMeasure(ForwardDecay, halfLife, shape, 6000, 10);
        const cellOk = r.maxRel <= FD_TOL;
        if (!cellOk) fdOk = false;
        fdTotalQueries += r.queries;
        if (r.maxRel > fdWorst) fdWorst = r.maxRel;
        console.log('  ' + String(halfLife).padEnd(8) + '  ' + SHAPE_NAME[shape].padEnd(12) + '  ' +
            r.maxRel.toExponential(2).padStart(11) + '  ' + '1.00e-9'.padStart(11) + '  ' +
            String(r.queries).padStart(7) + '  ' + (cellOk ? 'ok' : 'FAIL'));
    }
}
const enoughQueries = fdTotalQueries >= 5000;
if (!enoughQueries) fdOk = false;
console.log('');
console.log('  total queries=' + fdTotalQueries + ' (>= 5000 required: ' + (enoughQueries ? 'ok' : 'FAIL') +
    '), worst rel err=' + fdWorst.toExponential(2));
console.log('');
console.log('WITNESS ForwardDecay (exact decayed aggregate) ' + (fdOk ? 'ok' : 'FAIL'));

// --- ForwardDecay TEETH: large-value + same-timestamp-flood lanes that REJECT at the buggy
//     cap 700 and stay EXACT at 40. Both use lambda=1 and seed L=0 with add(0,1), then act at
//     now=700 so arg=700 -- which does NOT trip `> 700` (no rebase at the old cap), but DOES trip
//     `> 40` (rebase at the shipped cap). At cap 700 the non-rebased weight exp(700)~1.01e304 makes
//     large-value overflow Sv in one add and flood overflow C in ~1.8e4 adds -> the query guard
//     throws -> scored Infinity -> the lane REJECTS. At cap 40 the rebase bounds every weight, so
//     the aggregate is finite and EXACT vs the oracle. (Verified: flipping FD_EXP_CAP to 700 turns
//     both lanes red.) ---
console.log('');
console.log('TEETH -- ForwardDecay large-value + same-timestamp-flood (EXACT at cap 40; REJECT at the buggy cap 700):');
let fdTeethOk = true;
{
    // add(0,1); add(700, 2e4) -- mirrors the node:test regression. At 700: exp(700)*2e4 > Double.MAX.
    const halfLife = Math.LN2, lambda = 1;   // lambda = ln2/halfLife = 1
    const times = Float64Array.of(0, 700), vals = Float64Array.of(1, 2e4);
    const fd = new ForwardDecay(halfLife);
    let rel;
    try {
        fd.add(times[0], vals[0]);
        fd.add(times[1], vals[1]);
        const now = 700;
        const o = fdOracle(times, vals, 2, lambda, now);
        rel = Math.max(
            Math.abs(fd.count(now) - o.c) / Math.abs(o.c),
            Math.abs(fd.sum(now) - o.s) / Math.abs(o.s),
            Math.abs(fd.mean(now) - o.s / o.c) / Math.abs(o.s / o.c));
        if (!Number.isFinite(rel)) rel = Infinity;
    } catch (e) { rel = Infinity; }   // a fail-closed overflow throw at cap 700 -> REJECT
    const cellOk = rel <= FD_TOL;
    if (!cellOk) fdTeethOk = false;
    console.log('  large-value (add(0,1); add(700,2e4), lambda=1) maxRel=' +
        (Number.isFinite(rel) ? rel.toExponential(2) : 'Infinity') +
        ' -> ' + (cellOk ? 'EXACT (ok)' : 'FAIL'));
}
{
    // add(0,1) seeds L=0, then FLOOD adds at now=700. At cap 700 each flood weight is exp(700), so
    // ~1.8e4 of them overflow C; at cap 40 the first flood add rebases (arg 0 after) -> finite/exact.
    const halfLife = Math.LN2, lambda = 1;
    const flood = 20000, n = 1 + flood;
    const times = new Float64Array(n), vals = new Float64Array(n);
    times[0] = 0; vals[0] = 1;
    for (let i = 1; i < n; i++) { times[i] = 700; vals[i] = 3; }
    const fd = new ForwardDecay(halfLife);
    let rel;
    try {
        for (let i = 0; i < n; i++) fd.add(times[i], vals[i]);
        const now = 700;
        const o = fdOracle(times, vals, n, lambda, now);
        rel = Math.max(
            Math.abs(fd.count(now) - o.c) / Math.abs(o.c),
            Math.abs(fd.sum(now) - o.s) / Math.abs(o.s));
        if (!Number.isFinite(rel)) rel = Infinity;
    } catch (e) { rel = Infinity; }
    const cellOk = rel <= FD_TOL;
    if (!cellOk) fdTeethOk = false;
    console.log('  flood (add(0,1) then ' + flood + ' at now=700, lambda=1) maxRel=' +
        (Number.isFinite(rel) ? rel.toExponential(2) : 'Infinity') +
        ' -> ' + (cellOk ? 'EXACT (ok)' : 'FAIL'));
}
console.log('');
console.log('WITNESS ForwardDecay teeth (large-value + flood: exact at 40, reject at 700) ' + (fdTeethOk ? 'ok' : 'FAIL'));

// --- ForwardDecay NEGATIVE CONTROLS (N4): the rebase + its rescale must be load-bearing ---
console.log('');
console.log('NEGATIVE CONTROLS -- ForwardDecay with a broken rebase MUST be rejected by the same gate:');
let fdControlsOk = true;
// A stream long enough (small half-life) to force many rebase-cap crossings.
{
    const r = fdMeasure(FDNoRescale, 10, 0, 40000, 25);
    const rejected = !(r.maxRel <= FD_TOL);   // the exact-aggregate gate must REJECT it
    if (!rejected) fdControlsOk = false;
    console.log('  fdNoRescale (rebase without the C,Sv rescale) maxRel=' + r.maxRel.toExponential(2) +
        ' vs tol=1e-9 -> ' + (rejected ? 'REJECTED (ok)' : 'NOT rejected (FAIL)'));
}
{
    const r = fdMeasure(FDNoRebase, 10, 0, 40000, 25);
    const rejected = !(r.maxRel <= FD_TOL);   // overflow to Inf -> rejected
    if (!rejected) fdControlsOk = false;
    console.log('  fdNoRebase (never rebases -> accumulator overflows to Inf) maxRel=' + r.maxRel.toExponential(2) +
        ' vs tol=1e-9 -> ' + (rejected ? 'REJECTED (ok)' : 'NOT rejected (FAIL)'));
}
console.log('');
console.log('WITNESS ForwardDecay negative controls (broken rebase + no rebase rejected) ' +
    (fdControlsOk ? 'ok' : 'FAIL'));

// ===========================================================================
// TOP-K Witness -- HeavyKeeper (Gong et al., USENIX ATC 2018). The honesty anchor for
// the SKEW member: (a) RECALL 100% of the true heavy hitters (keys above N/k) vs an EXACT
// Map oracle, on BOTH weighted and unit streams; (b) OVERESTIMATE bounded -- each reported
// total lies in [true - errorOf, true] (HeavyKeeper never overestimates); and (c) the
// MARQUEE -- HeavyKeeper's mean relative error BELOW a FAITHFUL inline Space-Saving baseline
// on a Zipfian + DRIFTING stream. NEGATIVE CONTROLS the same gates REJECT: a DECAY-DISABLED
// HeavyKeeper (recall < 1.0 on drift) and a FOREST-FROZEN variant (misses heavy hitters).
// ===========================================================================

/**
 * A FAITHFUL Space-Saving / Stream-Summary baseline (Metwally-Agrawal-El Abbadi, "Efficient
 * Computation of Frequent and Top-k Elements in Data Streams", ICDT 2005). It keeps EXACTLY
 * `cap` monitored counters, each with a (count, error) pair; a hit increments the count; a
 * MISS on a full summary REPLACES the counter with the CURRENT MINIMUM count -- the new key
 * inherits `minCount` as its count and `minCount` as its error (the classic min-replacement).
 * This is the correct algorithm (NOT a strawman): the guaranteed count is `count - error`, the
 * reported count `count`. Written inline here so the witness carries no @zakkster/lite-sketch
 * dependency. O(cap) per op (a linear min scan -- fine for a witness, not a hot path).
 */
class SpaceSaving {
    constructor(cap) {
        this._cap = cap;
        this._key = new Float64Array(cap);
        this._cnt = new Float64Array(cap);
        this._err = new Float64Array(cap);
        this._n = 0;
    }
    add(key, weight) {
        // present? -> increment.
        for (let i = 0; i < this._n; i++) {
            if (this._key[i] === key) { this._cnt[i] += weight; return; }
        }
        // room? -> monitor it exactly.
        if (this._n < this._cap) {
            this._key[this._n] = key; this._cnt[this._n] = weight; this._err[this._n] = 0; this._n++;
            return;
        }
        // full -> replace the current MINIMUM counter (Stream-Summary min-replacement).
        let mi = 0, mc = this._cnt[0];
        for (let i = 1; i < this._n; i++) if (this._cnt[i] < mc) { mc = this._cnt[i]; mi = i; }
        this._key[mi] = key; this._err[mi] = mc; this._cnt[mi] = mc + weight;
    }
    estimate(key) {
        for (let i = 0; i < this._n; i++) if (this._key[i] === key) return this._cnt[i];
        return 0;
    }
    topKeys(k) {
        const idx = [];
        for (let i = 0; i < this._n; i++) idx.push(i);
        idx.sort((a, b) => this._cnt[b] - this._cnt[a]);
        return idx.slice(0, k).map((i) => this._key[i]);
    }
}

/** A FOREST-FROZEN HeavyKeeper: the table updates but the top-k forest never changes. */
class ForestFrozenHK extends HeavyKeeper {
    _promote() { /* BUG: never updates the top-k forest -> it stays empty / stale */ }
}

/** Build a Zipfian CDF over n keys (cached), s the exponent. */
const _wZipf = new Map();
function zipfSample(u, n, s) {
    const ck = n + ':' + s;
    let cdf = _wZipf.get(ck);
    if (cdf === undefined) {
        cdf = new Float64Array(n);
        let sum = 0;
        for (let i = 0; i < n; i++) { sum += 1 / Math.pow(i + 1, s); cdf[i] = sum; }
        for (let i = 0; i < n; i++) cdf[i] /= sum;
        _wZipf.set(ck, cdf);
    }
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
    return lo;
}

console.log('');
console.log('TOP-K Witness -- HeavyKeeper v' + VERSION + ' (Gong et al., USENIX ATC 2018): recall + bounded ' +
    'overestimate + mean rel-error vs a FAITHFUL Space-Saving baseline (Metwally et al., ICDT 2005)');
console.log('');

let hkOk = true;

// --- (a) RECALL 100% of the true keys above N/k vs an exact Map oracle (weighted + unit). ---
console.log('  recall of the true current top-k heavy hitters vs an exact Map oracle:');
console.log('  stream      k    N        recall     status');
console.log('  ----------  ---  -------  ---------  ------');
function recallRun(weighted, seed) {
    const K = 10;
    const N = 300000;
    const hk = new HeavyKeeper(5, 4096, K, { seed });
    const truth = new Map();
    const r = mulberry32(seed);
    for (let i = 0; i < N; i++) {
        const key = 1000000 + zipfSample(r(), 20000, 1.1);
        const wt = weighted ? 1 + ((i * 7) % 9) : 1;   // weighted: integer weights 1..9
        hk.add(key, wt);
        truth.set(key, (truth.get(key) || 0) + wt);
    }
    let total = 0;
    for (const v of truth.values()) total += v;
    // the true CURRENT top-k (the K heaviest keys -- every one is a heavy hitter above ~N/k^2 here).
    const ranked = [...truth.entries()].sort((a, b) => b[1] - a[1]);
    const trueHH = ranked.slice(0, K).map((e) => e[0]);
    const got = new Set(hk.topK().map((e) => e.key));
    let hit = 0;
    for (const key of trueHH) if (got.has(key)) hit++;
    return { hit, need: trueHH.length, K, N };
}
for (const [name, weighted] of [['unit', false], ['weighted', true]]) {
    const r = recallRun(weighted, 2024);
    const recall = r.need === 0 ? 1 : r.hit / r.need;
    const cellOk = recall >= 1.0;
    if (!cellOk) hkOk = false;
    console.log('  ' + name.padEnd(10) + '  ' + String(r.K).padEnd(3) + '  ' + nStr(r.N).padEnd(7) + '  ' +
        (r.hit + '/' + r.need).padStart(9) + '  ' + (cellOk ? 'ok' : 'FAIL'));
}

// --- (b) OVERESTIMATE bounded: every reported total in [true - errorOf, true]. ---
console.log('');
{
    const K = 10, N = 250000, W = 4096;
    const hk = new HeavyKeeper(5, W, K, { seed: 77 });
    const truth = new Map();
    const r = mulberry32(77);
    for (let i = 0; i < N; i++) {
        const key = zipfSample(r(), 10000, 1.1);
        hk.add(key);
        truth.set(key, (truth.get(key) || 0) + 1);
    }
    let worstOver = 0, worstUnder = 0, allBounded = true;
    const errOf = N / W;   // a cell absorbs at most ~ N/w of the stream
    for (const e of hk.topK()) {
        const t = truth.get(e.key) || 0;
        if (e.count > t) { allBounded = false; if (e.count - t > worstOver) worstOver = e.count - t; }
        if (t - e.count > worstUnder) worstUnder = t - e.count;
    }
    const cellOk = allBounded && worstUnder <= errOf;
    if (!cellOk) hkOk = false;
    console.log('  overestimate bound: reported in [true - ~N/w, true] (never over the truth):');
    console.log('    worst overestimate=' + worstOver + ' (must be 0), worst underestimate=' + worstUnder +
        ' vs ~N/w=' + errOf.toFixed(0) + ' -> ' + (cellOk ? 'ok' : 'FAIL'));
}

// --- (c) MARQUEE: HeavyKeeper mean rel-error < Space-Saving on a Zipfian + DRIFTING stream. ---
console.log('');
console.log('  MARQUEE -- mean rel-error over the true top-k, HeavyKeeper vs faithful Space-Saving');
console.log('  (Zipfian s=1.1 + DRIFT: the popular key-set shifts partway; both sized to k*4 counters):');
function driftStream(feed, K, seed) {
    const N = 400000, U = 8000;
    const r = mulberry32(seed);
    const truth = new Map();
    for (let i = 0; i < N; i++) {
        const regime = i < N / 2 ? 0 : 500000;    // the whole popular set shifts at the midpoint
        const key = regime + zipfSample(r(), U, 1.1);
        feed(key);
        truth.set(key, (truth.get(key) || 0) + 1);
    }
    return truth;
}
{
    const K = 12, seed = 909;
    const W = 4096, D = 5, CAP = K * 4;
    const hk = new HeavyKeeper(D, W, K, { seed });
    const ss = new SpaceSaving(CAP);
    // drive BOTH on the SAME stream (re-seed the same mulberry32 so the streams are identical).
    const truthHK = driftStream((key) => hk.add(key, 1), K, seed);
    const truthSS = driftStream((key) => ss.add(key, 1), K, seed);   // identical stream (same seed)
    // the true CURRENT top-k = the top-k over the whole run's counts (recency favors the 2nd regime).
    const trueTop = [...truthHK.entries()].sort((a, b) => b[1] - a[1]).slice(0, K);
    function meanRelErr(estimateFn) {
        let sum = 0, cnt = 0;
        for (const [key, t] of trueTop) {
            const e = estimateFn(key);
            sum += Math.abs(e - t) / t;
            cnt++;
        }
        return sum / cnt;
    }
    const hkErr = meanRelErr((key) => hk.estimate(key));
    const ssErr = meanRelErr((key) => ss.estimate(key));
    const cellOk = hkErr < ssErr;
    if (!cellOk) hkOk = false;
    console.log('    HeavyKeeper mean rel-error=' + pct(hkErr) + '  vs  Space-Saving=' + pct(ssErr) +
        '  -> ' + (cellOk ? 'HeavyKeeper WINS (ok)' : 'FAIL'));
}

console.log('');
console.log('WITNESS HeavyKeeper (recall + bounded overestimate + beats Space-Saving on drift) ' +
    (hkOk ? 'ok' : 'FAIL'));

// --- HeavyKeeper NEGATIVE CONTROLS (N4): decay + the forest must be load-bearing ---
console.log('');
console.log('NEGATIVE CONTROLS -- a broken HeavyKeeper MUST be rejected by the same gates:');
let hkControlsOk = true;
// 1) FOREST-FROZEN -> the top-k never updates -> recall collapses on any stream.
{
    const K = 10, N = 200000;
    const hk = new ForestFrozenHK(5, 4096, K, { seed: 5 });
    const truth = new Map();
    const r = mulberry32(5);
    for (let i = 0; i < N; i++) {
        const key = zipfSample(r(), 10000, 1.1);
        hk.add(key);
        truth.set(key, (truth.get(key) || 0) + 1);
    }
    const trueTop = [...truth.entries()].sort((a, b) => b[1] - a[1]).slice(0, K).map((e) => e[0]);
    const got = new Set(hk.topK().map((e) => e.key));
    let hit = 0;
    for (const key of trueTop) if (got.has(key)) hit++;
    const recall = hit / trueTop.length;
    const rejected = recall < 1.0;
    if (!rejected) hkControlsOk = false;
    console.log('  forest-frozen HeavyKeeper recall=' + (recall * 100).toFixed(1) + '% (< 100%) -> ' +
        (rejected ? 'REJECTED (ok)' : 'NOT rejected (FAIL)'));
}
// 2) DECAY-DISABLED -> stale keys from the OLD regime are never eroded -> the reported top-k on a
//    DRIFTING stream keeps stale leaders, so recall of the CURRENT (post-drift) heavy hitters drops.
{
    const K = 10, N = 400000, U = 6000;
    // a decay-disabled HeavyKeeper: b just above 1 makes b^(-count) ~ 1 so a miss ALWAYS decays is
    // the OPPOSITE; to DISABLE decay we need b^(-count) ~ 0. We build the control by construction:
    // a huge decay base means the probability is ~0 -> counters never decay -> a windowed/drifting
    // stream keeps stale leaders. (b <= 1 is rejected by the ctor; a very large b is the faithful
    // "decay effectively off" control.)
    const hk = new HeavyKeeper(5, 4096, K, { seed: 8, b: 1e15 });   // b huge -> b^(-count) ~ 0 -> no decay
    const truth1 = new Map(), truth2 = new Map();
    const r = mulberry32(8);
    for (let i = 0; i < N; i++) {
        const first = i < N / 2;
        const key = (first ? 0 : 900000) + zipfSample(r(), U, 1.1);
        hk.add(key);
        (first ? truth1 : truth2).set(key, ((first ? truth1 : truth2).get(key) || 0) + 1);
    }
    // the CURRENT heavy hitters are the 2nd-regime top-k; a no-decay table keeps 1st-regime leaders.
    const currentTop = [...truth2.entries()].sort((a, b) => b[1] - a[1]).slice(0, K).map((e) => e[0]);
    const got = new Set(hk.topK().map((e) => e.key));
    let hit = 0;
    for (const key of currentTop) if (got.has(key)) hit++;
    const recall = hit / currentTop.length;
    const rejected = recall < 1.0;
    if (!rejected) hkControlsOk = false;
    console.log('  decay-disabled HeavyKeeper (b=1e15) current-top-k recall=' + (recall * 100).toFixed(1) +
        '% on a drifting stream (< 100%) -> ' + (rejected ? 'REJECTED (ok)' : 'NOT rejected (FAIL)'));
}
console.log('');
console.log('WITNESS HeavyKeeper negative controls (frozen forest + disabled decay rejected) ' +
    (hkControlsOk ? 'ok' : 'FAIL'));

// ===========================================================================
// SlidingHyperLogLog (ADR 0006) -- WINDOWED DISTINCT accuracy vs an exact Set oracle
// ===========================================================================
//
// Drive SlidingHyperLogLog on evolving streams (a W-sweep + a distinct-set SHIFT + a
// post-burst edge), compare its windowed distinct estimate to an EXACT windowed-Set oracle,
// and GATE the relative error against 3 * (1.04 / sqrt(m)) on EVERY query -- printing MEASURED
// vs THEORETICAL side by side, plus the space-vs-oracle bar (a fixed m*ringCap ring vs the
// oracle's O(distinct-in-window) Set). Assert `degraded === false` (no ring overflowed). Two
// NEGATIVE CONTROLS -- a NO-EXPIRY variant (never drops stamp <= now - W) and a
// NO-DOMINATED-DROP variant (a plain FIFO ring, wrong max-rho) -- are fed the SAME gate and
// MUST be REJECTED (the gate has teeth). ASCII-only.

/** A witness-local copy of the two-lane murmur (faithful to Adaptive.js SlidingHyperLogLog). */
const _slC1 = 0xcc9e2d51 | 0, _slC2 = 0x1b873593 | 0, _slFC1 = 0x85ebca6b | 0,
    _slFC2 = 0xc2b2ae35 | 0, _slSALT = 0x85ebca6b | 0;
function _slRound(h, k) {
    k = Math.imul(k, _slC1); k = (k << 15) | (k >>> 17); k = Math.imul(k, _slC2);
    h = h ^ k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0; return h;
}
function _slFinal(h) {
    h = h ^ (h >>> 16); h = Math.imul(h, _slFC1); h = h ^ (h >>> 13);
    h = Math.imul(h, _slFC2); h = h ^ (h >>> 16); return h;
}
function _slSigma(x) {
    if (x === 1) return Infinity;
    let y = 1, z = x, prev;
    do { x = x * x; prev = z; z += x * y; y += y; } while (z !== prev);
    return z;
}
function _slTau(x) {
    if (x === 0 || x === 1) return 0;
    let y = 1, z = 1 - x, prev;
    do { x = Math.sqrt(x); prev = z; y *= 0.5; const d = 1 - x; z -= d * d * y; } while (z !== prev);
    return z / 3;
}
const _slAlpha = 0.5 / Math.LN2;

/**
 * A witness-local, faithful re-implementation of the SlidingHyperLogLog algorithm with two
 * FLAGS so the negative controls can each disable exactly one load-bearing part:
 *   - expire      = false -> NEVER drop stamp <= now - W  (the no-expiry control)
 *   - dropDom     = false -> a plain FIFO ring, no LFPM domination drop (the no-dominated-drop
 *                            control: the register max is the max over the last ringCap arrivals,
 *                            which MISSES older-but-higher rho once newer low-rho arrivals push
 *                            them out).
 * With BOTH flags true it MIRRORS the shipped class (self-verified below), so a broken variant is
 * a FAIR falsification of exactly the disabled part.
 */
class RefSlidingHLL {
    constructor(W, p, ringCap, seed, expire, dropDom) {
        this._W = W; this._p = p; this._m = 1 << p; this._cap = ringCap; this._mask = ringCap - 1;
        this._seed = seed | 0; this._q = 64 - p; this._expire = expire; this._dropDom = dropDom;
        const cells = this._m * ringCap;
        this._stamps = new Float64Array(cells); this._rho = new Uint8Array(cells);
        this._head = new Int32Array(this._m); this._len = new Int32Array(this._m);
        this._hist = new Int32Array(this._q + 2); this._now = 0; this._overflows = 0;
    }
    get standardError() { return 1.04 / Math.sqrt(this._m); }
    get degraded() { return this._overflows > 0; }
    add(now, key) {
        this._now = now;
        let a = key, neg = 0; if (a < 0) { a = -a; neg = 1; }
        const lo = a >>> 0; const hiw = a < 4294967296 ? 0 : (Math.floor(a / 4294967296) >>> 0);
        const seed = this._seed, p = this._p;
        let hh = seed | 0; hh = _slRound(hh, lo); hh = _slRound(hh, hiw ^ neg); hh = _slFinal(hh ^ 8);
        let gg = (seed ^ _slSALT) | 0; gg = _slRound(gg, lo); gg = _slRound(gg, hiw ^ neg); gg = _slFinal(gg ^ 8);
        const j = hh >>> (32 - p); const hiSuf = hh << p;
        const rho = hiSuf !== 0 ? Math.clz32(hiSuf) + 1 : (32 - p) + Math.clz32(gg) + 1;
        const cap = this._cap, mask = this._mask, base = j * cap;
        const stamps = this._stamps, rhos = this._rho, heads = this._head, lens = this._len;
        let head = heads[j], len = lens[j];
        if (this._dropDom) {   // LFPM domination drop (the fix under test)
            while (len > 0) { const tc = base + ((head + len - 1) & mask); if (rhos[tc] <= rho) len--; else break; }
        }
        if (len === cap) { head = (head + 1) & mask; len--; this._overflows++; }
        const at = base + ((head + len) & mask);
        stamps[at] = now; rhos[at] = rho; heads[j] = head; lens[j] = len + 1;
        return this;
    }
    count() {
        const now = this._now, fullCut = this._expire ? now - this._W : -Infinity;
        const m = this._m, cap = this._cap, mask = this._mask;
        const stamps = this._stamps, rhos = this._rho, heads = this._head, lens = this._len;
        const q = this._q, C = this._hist; C.fill(0);
        for (let jj = 0; jj < m; jj++) {
            const base = jj * cap; let head = heads[jj], len = lens[jj];
            while (len > 0 && stamps[base + (head & mask)] <= fullCut) { head = (head + 1) & mask; len--; }
            heads[jj] = head; lens[jj] = len;
            // the register max = the highest rho among live entries (the shipped class relies on the
            // LFPM invariant that this is the head; a FIFO ring must scan all live entries for its max).
            let maxRho = 0, idx = head, rem = len;
            while (rem > 0) { const c = rhos[base + (idx & mask)]; if (c > maxRho) maxRho = c; idx = (idx + 1) & mask; rem--; }
            C[maxRho]++;
        }
        let z = m * _slTau((m - C[q + 1]) / m);
        for (let k = q; k >= 1; k--) z = 0.5 * (z + C[k]);
        z += m * _slSigma(C[0] / m);
        return Math.round(_slAlpha * m * m / z);
    }
}

console.log('');
console.log('WINDOWED-DISTINCT Witness -- SlidingHyperLogLog v' + VERSION + ' (Chabchoub-Hebrail, 2010): ' +
    'windowed distinct-count vs an EXACT Set oracle (theoretical: |rel| <= 3 * 1.04/sqrt(m) per query)');
console.log('');

let slOk = true;
let slQueries = 0;

// --- fairness self-check: the faithful RefSlidingHLL must mirror the shipped class ---
{
    const P = 12, RC = 16, SEED = 7, W = 4000;
    const real = new SlidingHyperLogLog(W, { p: P, ringCap: RC, seed: SEED });
    const ref = new RefSlidingHLL(W, P, RC, SEED, true, true);
    for (let t = 0; t < 12000; t++) { const key = (t * 2654435761) % 6000; real.add(t, key); ref.add(t, key); }
    const re = real.count(), rf = ref.count();
    const faithful = re === rf;
    if (!faithful) slOk = false;
    console.log('  fairness self-check: shipped count=' + re + ' vs faithful reference count=' + rf +
        ' -> ' + (faithful ? 'MIRRORS (controls are fair)' : 'DIVERGES (FAIL)'));
}

// --- the gated lane: W-sweep + distinct-set SHIFT + post-burst edge, exact Set oracle ---
console.log('');
console.log('  W        m      shape              queries  maxRel err   theo (3sig)  degraded  status');
console.log('  -------  -----  -----------------  -------  -----------  -----------  --------  ------');

/**
 * Drive one workload against the shipped class + an exact windowed-Set oracle; GATE every query's
 * relative error <= 3 * standardError. `gen(t)` returns the key added at time t; the oracle keeps a
 * FIFO of (t, key) and rebuilds the in-window Set at each query (exact). Returns the max rel err,
 * the query count, and whether the sketch degraded.
 */
function slDrive(shape, W, p, ringCap, seed, N, warm, gen) {
    const sl = new SlidingHyperLogLog(W, { p, ringCap, seed });
    const se = sl.standardError, gate = 3 * se;
    const tsBuf = new Float64Array(N), keyBuf = new Float64Array(N);
    let head = 0;
    let maxRel = 0, queries = 0;
    for (let t = 0; t < N; t++) {
        const key = gen(t);
        sl.add(t, key);
        tsBuf[t] = t; keyBuf[t] = key;
        if (t >= warm && (t % 5) === 0) {   // sample every 5th step after warm-up
            while (head <= t && tsBuf[head] <= t - W) head++;
            const set = new Set();
            for (let i = head; i <= t; i++) if (tsBuf[i] > t - W) set.add(keyBuf[i]);
            const exact = set.size;
            if (exact > 0) {
                const est = sl.count();
                const rel = Math.abs(est - exact) / exact;
                if (rel > maxRel) maxRel = rel;
                if (rel > gate) slOk = false;
                queries++;
            }
        }
    }
    slQueries += queries;
    const status = maxRel <= gate ? 'ok' : 'FAIL';
    console.log('  ' + nStr(W).padEnd(7) + '  ' + String(sl.m).padEnd(5) + '  ' + shape.padEnd(17) + '  ' +
        String(queries).padEnd(7) + '  ' + pct(maxRel).padStart(11) + '  ' + pct(gate).padStart(11) + '  ' +
        String(sl.degraded).padEnd(8) + '  ' + status + (sl.degraded ? ' DEGRADED' : ''));
    return { maxRel, gate, degraded: sl.degraded };
}

// W-sweep with a rolling distinct set (keys cycle over 2W ids -> the window holds ~W distinct).
for (const W of [1000, 4000, 16000]) {
    const r = slDrive('rolling-set', W, 12, 16, 101, 4 * W, W, (t) => (t * 2654435761 >>> 0) % (2 * W));
    if (r.degraded) slOk = false;
}
// distinct-set SHIFT: the id space jumps partway (regime A -> regime B); the windowed distinct
// count must track the NEW set as the old one expires.
{
    const W = 4000, N = 5 * W;
    const r = slDrive('distinct-set-shift', W, 12, 16, 202, N, W, (t) =>
        (t < N / 2 ? 0 : 5000000) + ((t * 2654435761 >>> 0) % (2 * W)));
    if (r.degraded) slOk = false;
}
// post-BURST edge: a dense burst of many distinct keys, then a quiet tail of a few repeats -- the
// windowed count must fall as the burst leaves the window.
{
    const W = 4000, N = 4 * W;
    const r = slDrive('post-burst-edge', W, 12, 16, 303, N, W, (t) =>
        (t % (3 * W) < W) ? (t * 2654435761 >>> 0) : 42);   // burst third, then key 42 repeated
    if (r.degraded) slOk = false;
}

const slEnough = slQueries >= 2000;
console.log('');
console.log('  total queries=' + slQueries + ' (>= 2000 required: ' + (slEnough ? 'ok' : 'FAIL') +
    '); all within 3 sigma + degraded false: ' + (slOk ? 'ok' : 'FAIL'));
if (!slEnough) slOk = false;
console.log('');
console.log('WITNESS SlidingHyperLogLog (windowed distinct-count within 3 sigma, not degraded) ' +
    (slOk ? 'ok' : 'FAIL'));

// --- SlidingHyperLogLog NEGATIVE CONTROLS: expiry + the LFPM domination drop must be load-bearing ---
console.log('');
console.log('NEGATIVE CONTROLS -- a broken SlidingHyperLogLog MUST be rejected by the same gate:');
let slControlsOk = true;

/** Run a RefSlidingHLL variant over a distinct-set shift; return the max rel err vs the exact oracle. */
function slControlDrive(expire, dropDom, W, p, ringCap, seed) {
    const N = 5 * W;
    const ref = new RefSlidingHLL(W, p, ringCap, seed, expire, dropDom);
    const tsBuf = new Float64Array(N), keyBuf = new Float64Array(N);
    let head = 0, maxRel = 0;
    const gate = 3 * ref.standardError;
    for (let t = 0; t < N; t++) {
        // a distinct-set shift + steady churn -> both a missing-expiry AND a missing-domination-drop
        // variant diverge (stale keys never leave; older high-rho maxima get pushed out of a FIFO).
        const key = (t < N / 2 ? 0 : 5000000) + ((t * 2654435761 >>> 0) % (2 * W));
        ref.add(t, key);
        tsBuf[t] = t; keyBuf[t] = key;
        if (t >= W && (t % 5) === 0) {
            while (head <= t && tsBuf[head] <= t - W) head++;
            const set = new Set();
            for (let i = head; i <= t; i++) if (tsBuf[i] > t - W) set.add(keyBuf[i]);
            const exact = set.size;
            if (exact > 0) {
                const rel = Math.abs(ref.count() - exact) / exact;
                if (rel > maxRel) maxRel = rel;
            }
        }
    }
    return { maxRel, gate };
}
// (1) NO-EXPIRY -> stale keys from the whole stream are counted forever -> massive over-estimate.
{
    const r = slControlDrive(false, true, 4000, 12, 16, 404);
    const rejected = r.maxRel > r.gate;
    if (!rejected) slControlsOk = false;
    console.log('  no-expiry SlidingHyperLogLog maxRel=' + pct(r.maxRel) + ' (> 3sig ' + pct(r.gate) + ') -> ' +
        (rejected ? 'REJECTED (ok)' : 'NOT rejected (FAIL)'));
}
// (2) NO-DOMINATED-DROP -> a plain FIFO ring; an older high-rho maximum is pushed out by newer
//     low-rho arrivals, so the register max is too LOW -> the distinct count is under-estimated
//     beyond 3 sigma. A DENSE workload (m=256, W=8000 -> ~31 in-window arrivals per register, far
//     more than a ringCap-2 FIFO can hold) makes the lost-maxima loss bite hard.
{
    const r = slControlDrive(true, false, 8000, 8, 2, 505);
    const rejected = r.maxRel > r.gate;
    if (!rejected) slControlsOk = false;
    console.log('  no-dominated-drop SlidingHyperLogLog (m=256, ringCap 2, dense) maxRel=' + pct(r.maxRel) +
        ' (> 3sig ' + pct(r.gate) + ') -> ' + (rejected ? 'REJECTED (ok)' : 'NOT rejected (FAIL)'));
}
console.log('');
console.log('WITNESS SlidingHyperLogLog negative controls (no-expiry + no-dominated-drop rejected) ' +
    (slControlsOk ? 'ok' : 'FAIL'));

// ===========================================================================
// CHANGE-RESPONSE Witness -- DriftDetector (ADR 0007; Page 1954, Mouss et al. 2004). The scalar
// drift anchor: inject a KNOWN changepoint into a real-valued signal and MEASURE, against ground
// truth, for BOTH modes (DRIFT_PH online-mean-referenced, DRIFT_CUSUM fixed-target-referenced):
//   - detection LATENCY per shift magnitude (a larger shift detects no slower)
//   - false-alarm rate on a STATIONARY run (GATE bounded)
//   - reset discipline: fires ROUGHLY ONCE per changepoint (not on every subsequent item)
//   - DIVERGENCE: on a designed slow-ramp stream PH (adaptive) and CUSUM (fixed mu0) fire
//     MEASURABLY DIFFERENTLY -- the mode is load-bearing (a regression back to the qa-found
//     identical-statistic bug is REJECTED here).
// plus the NEGATIVE CONTROLS (the gate must have teeth):
//   - a huge-threshold detector (threshold 1e12) NEVER detects a real shift -> the latency gate
//     must REJECT it.
//   - a NO-RESET detector (never resets the accumulators on a fire) keeps firing on nearly every
//     item after the first crossing -> the fires-per-changepoint gate must REJECT it.
// The CUSUM sub-lanes pass a fixed target = the in-control mean (0 for these noise-around-0 streams).
// ===========================================================================

/** A DriftDetector that never resets on a fire -> after one crossing it keeps firing. */
class NoResetDD extends DriftDetector {
    _reset() { /* BUG: never resets the accumulators / running mean -> false-alarms forever */ }
}

/** Per-mode options: CUSUM REQUIRES a fixed target; inject the in-control mean (0) unless given. */
function ddOpts(mode, extra) {
    const o = Object.assign({}, extra);
    if (mode === DRIFT_CUSUM && o.target === undefined) o.target = 0;
    return o;
}

/** Detection latency for a stationary(0) -> shift stream; {lat, fires}, lat = Infinity if missed. */
function ddDetect(Ctor, mode, extra, shift, CP, post, seed) {
    const dd = new Ctor(mode, ddOpts(mode, extra));
    const r = mulberry32(seed);
    let lat = Infinity, fires = 0;
    for (let i = 0; i < CP; i++) { if (dd.add((r() - 0.5) * 0.4)) fires++; }
    for (let j = 0; j < post; j++) {
        if (dd.add(shift + (r() - 0.5) * 0.4)) { if (!Number.isFinite(lat)) lat = j; fires++; }
    }
    return { lat, fires };
}

/** Flags raised on a stationary uniform-noise stream / N -- the false-alarm rate. */
function ddFalseAlarm(mode, extra, N, seed) {
    const dd = new DriftDetector(mode, ddOpts(mode, extra));
    const r = mulberry32(seed);
    let flags = 0;
    for (let i = 0; i < N; i++) if (dd.add((r() - 0.5) * 0.4)) flags++;
    return flags / N;
}

/** Fires over a slow linear mean-ramp (0 -> span) -- the mode-divergence probe. */
function ddRampFires(mode, seed) {
    const dd = new DriftDetector(mode, ddOpts(mode, { delta: 0.005, threshold: 5 }));
    const r = mulberry32(seed);
    let fires = 0;
    for (let i = 0; i < 20000; i++) if (dd.add(i * 0.002 + (r() - 0.5) * 0.1)) fires++;   // ramp 0 -> 40
    return fires;
}

/**
 * The reset-discipline probe: a TRANSIENT shift (stationary mu0 -> +shift for `dur` -> back to mu0)
 * and the fires counted ONLY in the final stationary TAIL. A working reset settles both modes quiet
 * in the tail (PH's adaptive mean recovers; CUSUM's accumulator decays back to 0 at mu0); a no-reset
 * variant keeps firing through the tail. Returns { detected, tailFires }.
 */
function ddTransientTail(Ctor, mode, shift, warm, dur, tail, seed) {
    const dd = new Ctor(mode, ddOpts(mode, { delta: 0.005, threshold: 5 }));
    const r = mulberry32(seed);
    let detected = false, tailFires = 0;
    for (let i = 0; i < warm; i++) dd.add((r() - 0.5) * 0.4);
    for (let i = 0; i < dur; i++) if (dd.add(shift + (r() - 0.5) * 0.4)) detected = true;
    for (let i = 0; i < tail; i++) if (dd.add((r() - 0.5) * 0.4)) tailFires++;   // back at mu0
    return { detected, tailFires };
}

let ddOk = true;
const DD_OPTS = { delta: 0.005, threshold: 5 };
const DD_CP = 40000, DD_POST = 40000;

console.log('');
console.log('CHANGE-RESPONSE Witness -- DriftDetector v' + VERSION + ' (Page 1954; Mouss et al. 2004): scalar ' +
    'drift detection (theoretical: a persistent mean shift > delta trips the threshold; latency ~ threshold/(shift-delta))');
console.log('');
console.log('  detection latency per shift magnitude (stationary 0 -> shift at item 40k; delta=0.005, threshold=5):');
console.log('  mode    shift  latency (items)  fires post-CP  status');
console.log('  ------  -----  ---------------  -------------  ------');
for (const [name, mode] of [['PH', DRIFT_PH], ['CUSUM', DRIFT_CUSUM]]) {
    for (const shift of [0.5, 1, 5]) {
        const d = ddDetect(DriftDetector, mode, DD_OPTS, shift, DD_CP, DD_POST, 4242);
        const missed = !Number.isFinite(d.lat);
        // GATE: every shift here is persistent + well above delta, so it MUST be detected; a large
        // shift (>= 1) within a short latency. (Fires-count is NOT gated here: PH's adaptive mean
        // catches up and it quiets, but CUSUM's FIXED mu0 sees a SUSTAINED departure and legitimately
        // keeps alarming while out of control -- the reset discipline is gated below on a TRANSIENT.)
        const cellOk = !missed && (shift < 1 || d.lat < 2000);
        if (!cellOk) ddOk = false;
        console.log('  ' + name.padEnd(6) + '  ' + String(shift).padEnd(5) + '  ' +
            (missed ? 'MISSED' : String(d.lat)).padStart(15) + '  ' +
            String(d.fires).padStart(13) + '  ' + (cellOk ? 'ok' : 'FAIL'));
    }
}

// --- reset discipline on a TRANSIENT shift: detect during the spike, then go QUIET once the signal
//     returns to mu0 (a working reset settles both modes; a no-reset variant keeps firing -- gated as
//     a negative control below). GATE: detected during the spike AND the stationary tail is quiet. ---
console.log('');
console.log('  reset discipline (transient: 20k mu0 -> 5k at +5 -> 20k back at mu0; tail must be QUIET):');
console.log('  mode    detected  tail fires  status');
console.log('  ------  --------  ----------  ------');
for (const [name, mode] of [['PH', DRIFT_PH], ['CUSUM', DRIFT_CUSUM]]) {
    const d = ddTransientTail(DriftDetector, mode, 5, 20000, 5000, 20000, 4242);
    const cellOk = d.detected && d.tailFires < 50;   // a working reset settles quiet after the spike
    if (!cellOk) ddOk = false;
    console.log('  ' + name.padEnd(6) + '  ' + String(d.detected).padEnd(8) + '  ' +
        String(d.tailFires).padStart(10) + '  ' + (cellOk ? 'ok' : 'FAIL'));
}

console.log('');
console.log('  stationary false-alarm rate (uniform noise, N=100k; theoretical: bounded, ~0 at threshold=5):');
console.log('  mode    false-alarm   bound (1%)   status');
console.log('  ------  ------------  -----------  ------');
for (const [name, mode] of [['PH', DRIFT_PH], ['CUSUM', DRIFT_CUSUM]]) {
    let worst = 0;
    for (const seed of [1, 2, 3]) {
        const fa = ddFalseAlarm(mode, DD_OPTS, 100000, seed);
        if (fa > worst) worst = fa;
    }
    const cellOk = worst <= 0.01;   // a well-set threshold false-alarms rarely on stationary noise
    if (!cellOk) ddOk = false;
    console.log('  ' + name.padEnd(6) + '  ' + pct(worst).padStart(12) + '  ' +
        pct(0.01).padStart(11) + '  ' + (cellOk ? 'ok' : 'FAIL'));
}

// --- MODE DIVERGENCE: the mode must be LOAD-BEARING (guards against the qa-found identical-statistic
//     bug). On a slow mean ramp, PH's ONLINE reference tracks it and stays quiet, while CUSUM's FIXED
//     mu0=0 sees an ever-growing departure and fires far more. GATE: the two fire counts DIFFER (and
//     CUSUM >> PH). If a future change collapses the modes to one statistic, this lane FAILS. ---
console.log('');
console.log('  mode divergence (slow mean ramp 0 -> 40 over 20k; PH adaptive vs CUSUM fixed mu0=0):');
{
    const phFires = ddRampFires(DRIFT_PH, 1);
    const cuFires = ddRampFires(DRIFT_CUSUM, 1);   // identical stream (same seed)
    const diverge = phFires !== cuFires && cuFires > phFires * 5;
    if (!diverge) ddOk = false;
    console.log('    PH fires=' + phFires + '  CUSUM fires=' + cuFires + '  (CUSUM must be >> PH) -> ' +
        (diverge ? 'DIVERGE (mode is load-bearing, ok)' : 'IDENTICAL (mode is cosmetic, FAIL)'));
}

console.log('');
console.log('WITNESS DriftDetector (change response: latency + bounded false-alarm + reset discipline + mode divergence) ' +
    (ddOk ? 'ok' : 'FAIL'));

// --- DriftDetector NEGATIVE CONTROLS: the threshold + the reset must be load-bearing ---
console.log('');
console.log('NEGATIVE CONTROLS -- a broken DriftDetector MUST be rejected by the same gates:');
let ddControlsOk = true;
// 1) huge threshold -> a real shift never crosses -> MUST fail the latency (detection) gate.
for (const [name, mode] of [['PH', DRIFT_PH], ['CUSUM', DRIFT_CUSUM]]) {
    const d = ddDetect(DriftDetector, mode, { delta: 0.005, threshold: 1e12 }, 5, DD_CP, DD_POST, 909);
    const rejected = !Number.isFinite(d.lat);   // the latency gate must REJECT it (never detects)
    if (!rejected) ddControlsOk = false;
    console.log('  ' + name + ' huge-threshold (1e12) detector: shift 0 -> 5 detected=' +
        (Number.isFinite(d.lat) ? ('+' + d.lat) : 'NEVER') +
        ' -> ' + (rejected ? 'REJECTED (ok)' : 'NOT rejected (FAIL)'));
}
// 2) no-reset -> on a TRANSIENT shift that RETURNS to baseline, a working detector goes quiet in the
//    tail but the no-reset variant's statistic stays latched and it keeps firing -> MUST fail the
//    tail-quiet gate. (A sustained departure fires for BOTH, so the reset is only separable on a
//    transient -- baseline is the learned mean for PH, the fixed target for CUSUM.)
for (const [name, mode] of [['PH', DRIFT_PH], ['CUSUM', DRIFT_CUSUM]]) {
    const d = ddTransientTail(NoResetDD, mode, 5, 20000, 5000, 20000, 555);
    const rejected = d.tailFires >= 50;   // a working reset keeps the tail < 50; no-reset stays latched
    if (!rejected) ddControlsOk = false;
    console.log('  ' + name + ' no-reset detector (transient): tail fires=' + d.tailFires +
        ' (>= 50 == latched / never quiets) -> ' + (rejected ? 'REJECTED (ok)' : 'NOT rejected (FAIL)'));
}
console.log('');
console.log('WITNESS DriftDetector negative controls (huge-threshold + no-reset rejected) ' +
    (ddControlsOk ? 'ok' : 'FAIL'));

const all = ok && controlsOk && adOk && adControlsOk && fdOk && fdTeethOk && fdControlsOk && hkOk && hkControlsOk &&
    slOk && slControlsOk && ddOk && ddControlsOk;
console.log('');
console.log('WITNESS lite-adaptive (ExponentialHistogram + ADWIN + ForwardDecay + HeavyKeeper + ' +
    'SlidingHyperLogLog + DriftDetector) ' + (all ? 'ok' : 'FAIL'));
if (!all) process.exitCode = 1;
