// @zakkster/lite-adaptive -- the RECENCY witness (repo-only; run: `node test/witness.mjs`).
//
// The honesty anchor of the family, carried onto the WINDOWED oracle: drive
// ExponentialHistogram on an evolving stream, compare its windowed count / sum to an
// EXACT ring-of-the-last-W oracle, MEASURE the relative error, and GATE it against the
// paper's THEORETICAL bound epsilon -- HARD, on EVERY query -- printing MEASURED vs
// THEORETICAL side by side, plus the space-vs-oracle bar (EH's O((1/epsilon) log(eps W))
// buckets vs the ring's O(W)). A NEGATIVE CONTROL (a broken EH -- no straddle half-
// correction) is fed the SAME gate and MUST be REJECTED (the gate has teeth). ASCII-only.

import { ExponentialHistogram, ADWIN, ForwardDecay, VERSION } from '../Adaptive.js';

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

const all = ok && controlsOk && adOk && adControlsOk && fdOk && fdTeethOk && fdControlsOk;
console.log('');
console.log('WITNESS lite-adaptive (ExponentialHistogram + ADWIN + ForwardDecay) ' + (all ? 'ok' : 'FAIL'));
if (!all) process.exitCode = 1;
