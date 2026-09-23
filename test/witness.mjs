// @zakkster/lite-adaptive -- the RECENCY witness (repo-only; run: `node test/witness.mjs`).
//
// The honesty anchor of the family, carried onto the WINDOWED oracle: drive
// ExponentialHistogram on an evolving stream, compare its windowed count / sum to an
// EXACT ring-of-the-last-W oracle, MEASURE the relative error, and GATE it against the
// paper's THEORETICAL bound epsilon -- HARD, on EVERY query -- printing MEASURED vs
// THEORETICAL side by side, plus the space-vs-oracle bar (EH's O((1/epsilon) log(eps W))
// buckets vs the ring's O(W)). A NEGATIVE CONTROL (a broken EH -- no straddle half-
// correction) is fed the SAME gate and MUST be REJECTED (the gate has teeth). ASCII-only.

import { ExponentialHistogram, VERSION } from '../Adaptive.js';

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

const all = ok && controlsOk;
console.log('');
console.log('WITNESS lite-adaptive (ExponentialHistogram) ' + (all ? 'ok' : 'FAIL'));
if (!all) process.exitCode = 1;
