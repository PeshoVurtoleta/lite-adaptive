// @zakkster/lite-adaptive -- AllocProbe (repo-only measurement tool; NOT a node:test file).
//
// A direct bytes/op probe for the zero-GC lanes, plus a per-lane child-process runner. It exists
// because the scavenge-to-bytes ratio is not fixed (ROADMAP 7.1 "method corrections"): under a
// pinned semi-space a 16 B/op box reads 6-24 scavenges depending on JIT tier and new-space growth,
// so scavenge counting alone cannot read the SIZE of an allocation. This measures the V8 new-space
// used-size delta over K ops with no GC in the window, minus the probe's own self-overhead.
//
// Run one lane in a pinned child:
//   node --expose-gc --min-semi-space-size=4 --max-semi-space-size=4 test/perf/AllocProbe.mjs eh_addFrom
// or import { bytesPerOp, steadyMin, runLane, warmSiblings } and drive it from a harness.
//
// RULE (ROADMAP R3): the drivers never box. Every fractional clock / key / value lives in a
// Float64Array slot; loop indices are Smi ints; sinks accumulate into a Float64Array.

import v8 from 'node:v8';
import { PerformanceObserver, constants } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog,
    DriftDetector, DRIFT_PH, DRIFT_CUSUM, SlidingDDSketch, SlidingCountMin,
    DecayedReservoir } from '../../Adaptive.js';

const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// fail-closed flag check (task 2): BOTH semi-space flags must be pinned.
// ---------------------------------------------------------------------------
export function assertSemiSpacePinned() {
    const argv = (process.execArgv || []).slice();
    const opts = (process.env && process.env.NODE_OPTIONS) ? String(process.env.NODE_OPTIONS) : '';
    const flat = argv.join(' ') + ' ' + opts;
    const hasMin = /--min[-_]semi[-_]space[-_]size=4\b/.test(flat);
    const hasMax = /--max[-_]semi[-_]space[-_]size=4\b/.test(flat);
    if (!hasMin || !hasMax) {
        throw new Error('[AllocProbe] fail closed: both --min-semi-space-size=4 AND ' +
            '--max-semi-space-size=4 must be pinned; an unpinned semi-space makes B/op unstable ' +
            '(execArgv=' + JSON.stringify(argv) + ', NODE_OPTIONS="' + opts + '").');
    }
}

// ---------------------------------------------------------------------------
// V8 new-space used-size + minor-GC observer
// ---------------------------------------------------------------------------
const MINOR = constants.NODE_PERFORMANCE_GC_MINOR;
const _gc = { minor: 0 };
let _obsOn = false;
const _obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
        const k = e.detail ? e.detail.kind : e.kind;
        if (k === MINOR) _gc.minor++;
    }
});
function obsOn() { if (!_obsOn) { _obs.observe({ entryTypes: ['gc'] }); _obsOn = true; } }

function newSpaceUsed() {
    const sp = v8.getHeapSpaceStatistics();
    for (let j = 0; j < sp.length; j++) if (sp[j].space_name === 'new_space') return sp[j].space_used_size;
    return NaN;
}

// the probe's own self-overhead reference: an empty-body loop over the same K.
const EMPTY_LANE = {
    setup() { return { acc: new Float64Array(1) }; },
    hot(s, n) { const a = s.acc; for (let i = 0; i < n; i++) a[0] += 1; },
};

/**
 * One measurement window: the new-space used-size delta across K ops of lane.hot with NO scavenge
 * inside the window. Returns the delta in bytes, or NaN when the window is spoiled -- a minor GC
 * fired (observer count) OR the used size decreased (a scavenge reset new space mid-window). A
 * spoiled window is discarded and retried by the caller (task 1).
 */
async function oneWindow(lane, s, K) {
    globalThis.gc();
    await sleep(5);
    _gc.minor = 0;
    const u0 = newSpaceUsed();
    lane.hot(s, K);
    const u1 = newSpaceUsed();
    await sleep(2);                 // let the observer flush any in-window 'gc' entry
    if (_gc.minor > 0) return NaN;  // a scavenge fired inside the window: discard + retry
    if (!(u1 >= u0)) return NaN;    // used size dropped: a scavenge slipped in: discard + retry
    return u1 - u0;
}

async function minCleanWindow(lane, s, K, want) {
    const need = want || 5;
    let best = Infinity, got = 0;
    for (let r = 0; r < need * 6 && got < need; r++) {
        const d = await oneWindow(lane, s, K);
        if (d === d && d >= 0) { got++; if (d < best) best = d; }
    }
    if (best === Infinity) throw new Error('[AllocProbe] no clean window (every window took a scavenge)');
    return best;
}

/**
 * bytes/op (task 1): V8 new-space used-size delta over K ops (no GC in the window) minus the
 * probe's own measured self-overhead (an empty-body loop over the same K). Fails closed if the
 * semi-space flags are not pinned or --expose-gc is absent.
 * @param {{setup:()=>any, hot:(s:any,n:number)=>void}} lane
 * @param {number} [K=4000] ops per window
 * @param {any} [state] optional pre-built lane state (else lane.setup())
 * @returns {Promise<number>} bytes per op (rounded to 0.01)
 */
export async function bytesPerOp(lane, K = 4000, state) {
    assertSemiSpacePinned();
    if (typeof globalThis.gc !== 'function') throw new Error('[AllocProbe] bytesPerOp needs --expose-gc');
    obsOn();
    const s = state || lane.setup();
    lane.hot(s, Math.min(20000, K * 2));               // tier up
    const laneDelta = await minCleanWindow(lane, s, K);
    const es = EMPTY_LANE.setup();
    EMPTY_LANE.hot(es, Math.min(20000, K * 2));
    const overhead = await minCleanWindow(EMPTY_LANE, es, K);
    return +(((laneDelta - overhead) / K)).toFixed(2);
}

/**
 * steady bytes/op (task 2): the MINIMUM bytes/op over >= 4 windows. The first window is returned
 * separately for PRINTING (it may run Maglev code and box where the Turbofan steady state reads 0),
 * and is NEVER used as the floor. Fails closed if both semi-space flags are not pinned.
 * @returns {Promise<{first:number, steady:number, readings:number[]}>}
 */
export async function steadyMin(lane, opts) {
    assertSemiSpacePinned();
    const o = opts || {};
    const windows = (Number.isInteger(o.windows) && o.windows >= 4) ? o.windows : 4;
    const K = o.K || 4000;
    const s = lane.setup();
    lane.hot(s, Math.min(20000, K * 2));               // tier up once before the windows
    const readings = [];
    for (let w = 0; w < windows; w++) readings.push(await bytesPerOp(lane, K, s));
    const first = readings[0];
    let steady = Infinity;
    // S6: window 0 is printed only, NEVER a floor -- steady is the min over windows 1..n-1 (>= 3).
    for (let w = 1; w < windows; w++) if (readings[w] < steady) steady = readings[w];
    return { first, steady, readings };
}

/**
 * Minor-GC (scavenge) count over `ops` ops after a warm-up + a forced collection -- the scavenge
 * lane the shipped zgcSuite gates on, exposed here so a caller can report "N1 forced >= 10
 * scavenges at 8N".
 */
export async function scavengesAt(lane, ops, state) {
    obsOn();
    const s = state || lane.setup();
    lane.hot(s, Math.min(20000, ops));
    globalThis.gc();
    await sleep(50);
    _gc.minor = 0;
    lane.hot(s, ops);
    await sleep(100);
    return _gc.minor;
}

// ---------------------------------------------------------------------------
// key tables (Float64Array: loads are unboxed in optimized code)
// ---------------------------------------------------------------------------
function keyTable(base, sign) {
    const t = new Float64Array(16);
    for (let j = 0; j < 16; j++) t[j] = base + sign * j;
    return t;
}
const KEYS = {
    small: (() => { const t = new Float64Array(1024); for (let j = 0; j < 1024; j++) t[j] = (j % 1000) + 1; return t; })(),
    p30: keyTable(2 ** 30, 1),
    p31: keyTable(2 ** 31, 1),
    p32m1: keyTable(2 ** 32 - 1, -1),
    neg31: keyTable(-(2 ** 31), -1),
    p53m1: keyTable(2 ** 53 - 1, -1),
};
const FRAC = new Float64Array(16);
for (let j = 0; j < 16; j++) FRAC[j] = j * 0.37 + 0.125;

// ---------------------------------------------------------------------------
// probe lanes (all slot clocks / Float64Array keys)
// ---------------------------------------------------------------------------

// N1: boxes EXACTLY one 16 B HeapNumber per op (x.5 slot clock -> PACKED_ELEMENTS store).
const N1_BOXARR = [{}, 0];
const n1 = {
    setup() { const v = new Float64Array(1); v[0] = 0.5; return { v, acc: new Float64Array(1) }; },
    hot(s, n) { const v = s.v, acc = s.acc; for (let i = 0; i < n; i++) { v[0] += 1.0; N1_BOXARR[1] = v[0]; acc[0] += 1; } },
};
// negative control: a slot clock stepped, nothing boxed.
const noop = {
    setup() { const buf = new Float64Array(2); buf[0] = 1.75e12; return { buf, acc: new Float64Array(1) }; },
    hot(s, n) { const buf = s.buf, acc = s.acc; for (let i = 0; i < n; i++) { buf[0] += 1.5; buf[1] = FRAC[i & 15]; acc[0] += buf[1]; } },
};
const eh_addFrom = {
    setup() { const eh = new ExponentialHistogram(1000, 0.01); const buf = new Float64Array(2); const clk = new Float64Array(1);
        return { eh, buf, clk, acc: new Float64Array(1) }; },
    hot(s, n) { const eh = s.eh, buf = s.buf, clk = s.clk, acc = s.acc;
        for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15]; eh.addFrom(buf, 0); acc[0] += eh.bucketCount; } },
};
const fd_addFrom = {
    setup() { const buf = new Float64Array(2); const clk = new Float64Array(1); return { fd: new ForwardDecay(1e9), buf, clk, acc: new Float64Array(1) }; },
    hot(s, n) { const fd = s.fd, buf = s.buf, clk = s.clk, acc = s.acc;
        for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15]; fd.addFrom(buf, 0); acc[0] += (fd.mode === 'explicit' ? 1 : 0); } },
};
// seed: a Smi seed (default 4) OR null for the LIBRARY default seed 0x9e3779b1 -- a uint32 >= 2^31
// held in a plain field (a HeapNumber). The default-seed lanes exercise the seed-boxing path a Smi
// seed=4 would hide (F3): the fix routes the seed through the HK_KIN slot, so both must read 0 B/op.
function hkAddFrom(kc, weight, seed = 4) {
    const opts = seed === null ? undefined : { seed };
    return {
        setup() { const hk = new HeavyKeeper(4, 512, 16, opts); const buf = new Float64Array(2);
            return { hk, buf, keys: KEYS[kc], w: weight, acc: new Float64Array(1) }; },
        hot(s, n) { const hk = s.hk, buf = s.buf, keys = s.keys, wt = s.w, acc = s.acc;
            for (let i = 0; i < n; i++) { buf[0] = keys[i & 15]; buf[1] = wt; hk.addFrom(buf, 0); acc[0] += hk.size; } },
    };
}
const shll_addFrom = {
    setup() { const sl = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 3 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = 1.75e12;
        return { sl, buf, clk, acc: new Float64Array(1) }; },
    hot(s, n) { const sl = s.sl, buf = s.buf, clk = s.clk, acc = s.acc, keys = KEYS.small;
        for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = keys[i & 1023]; sl.addFrom(buf, 0); acc[0] += sl.overflows; } },
};
const sd_addFrom = {
    setup() { const sd = new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = 1.75e12;
        return { sd, buf, clk, acc: new Float64Array(1) }; },
    hot(s, n) { const sd = s.sd, buf = s.buf, clk = s.clk, acc = s.acc;
        for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((i * 40503) % 9973) + 0.5; sd.addFrom(buf, 0); acc[0] += (sd.collapsed ? 1 : 0); } },
};
const scm_addFrom = {
    setup() { const scm = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }); const buf = new Float64Array(3); const clk = new Float64Array(1); clk[0] = 1.75e12;
        return { scm, buf, clk, acc: new Float64Array(1) }; },
    hot(s, n) { const scm = s.scm, buf = s.buf, clk = s.clk, acc = s.acc;
        for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((i * 2654435761) >>> 0) % 5000; buf[2] = (i & 7) + 1; scm.addFrom(buf, 0); acc[0] += scm.saturated; } },
};
const dr_addFrom = {
    setup() { const dr = new DecayedReservoir(32, 100000, { seed: 7 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = 1.75e12;
        return { dr, buf, clk, acc: new Float64Array(1) }; },
    hot(s, n) { const dr = s.dr, buf = s.buf, clk = s.clk, acc = s.acc;
        for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = i & 63; dr.addFrom(buf, 0); acc[0] += dr.size; } },
};

// ===========================================================================
// TASK 8-10 lane extensions (repo 1.7.0 STEP 1, second pass): N2 shared call site, N3 addFrom
// matrix, N4 query lanes. Same R3 discipline -- every fractional clock / key / value lives in a
// Float64Array slot, loop indices are Smi ints, sinks accumulate into a Float64Array. These extend
// the LANES table (they do NOT duplicate the probe): each is a { setup, hot } pair the same
// bytesPerOp / steadyMin / runLane machinery drives.
// ===========================================================================

const CLK_NOW = 1e3;        // performance.now-scale fractional clock start (~1e3-1e7 over a run)
const CLK_EPOCH = 1.75e12;  // epoch-ms fractional clock start
function clkStart(kind) { return kind === 'epoch' ? CLK_EPOCH : CLK_NOW; }

// --- N2 (task 8): the shared, megamorphic call site. A consumer's `o.add(a, b)` fed >= 5 receiver
//     classes cannot inline, so a fractional argument boxes a ~16 B HeapNumber at the call boundary
//     regardless of what the callee does with it. This is a CONTROL: it MUST show >= one box/op. ---
function callAdd(o, a, b) { return o.add(a, b); }

/** Drive callAdd across 7 receiver maps (> the 4-map megamorphic threshold) so the `o.add` IC goes
 *  to a dictionary and STAYS there for the process. Each receiver is fed args it accepts (no throw
 *  churn); the box is at the CALL boundary, before the callee validates. */
function megamorphizeCallAdd() {
    const eh = new ExponentialHistogram(1000, 0.01);
    const fd = new ForwardDecay(1e9);
    const dr = new DecayedReservoir(32, 100000, { seed: 5 });
    const sdd = new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 });
    const shll = new SlidingHyperLogLog(1000, { p: 10, seed: 5 });
    const scm = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 5 });
    const dd = new DriftDetector(DRIFT_PH);
    let t = 1e3, sink = 0;
    for (let i = 0; i < 3000; i++) {
        t += 1.5;
        callAdd(eh, t, FRAC[i & 15]);
        callAdd(fd, t, FRAC[i & 15]);
        callAdd(dr, t, FRAC[i & 15]);
        callAdd(sdd, t, FRAC[i & 15] + 1);       // SDD value must be > 0 / indexable
        callAdd(shll, t, (i & 1023) + 1);        // SHLL key: a safe integer
        callAdd(scm, t, (i & 1023) + 1);         // SCM key: integer; count defaults to 1
        callAdd(dd, FRAC[i & 15], 0);            // DD.add(x): first arg only
        sink += eh.bucketCount;
    }
    return sink + fd.mode.length + dr.size;
}

/** kind: 'fd'/'eh'/'sdd' feed BOTH args fractional (2 boxes, ~32 B/op); 'dd' feeds a fractional +
 *  b Smi (1 box, ~16 B/op). The site is megamorphic (megamorphizeCallAdd in setup), so inlining
 *  cannot hide the box even though the hot loop calls one receiver. */
function sharedLane(kind) {
    return {
        setup() {
            megamorphizeCallAdd();
            let target;
            if (kind === 'fd') target = new ForwardDecay(1e9);
            else if (kind === 'dd') target = new DriftDetector(DRIFT_PH);
            else if (kind === 'eh') target = new ExponentialHistogram(1000, 0.01);
            else target = new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 });   // sdd
            const clk = new Float64Array(1); clk[0] = 1e6;
            return { target, kind, clk, acc: new Float64Array(1) };
        },
        hot(s, n) {
            const t = s.target, clk = s.clk, acc = s.acc, k = s.kind;
            if (k === 'dd') {
                for (let i = 0; i < n; i++) { const a = FRAC[i & 15]; callAdd(t, a, i & 7); acc[0] += (t.count & 255); }
            } else {
                const bump = (k === 'sdd') ? 1 : 0;   // SDD value > 0
                for (let i = 0; i < n; i++) { clk[0] += 1.5; const a = clk[0]; const b = FRAC[i & 15] + bump; callAdd(t, a, b); acc[0] += 1; }
            }
        },
    };
}

// --- N3 (task 9): the addFrom matrix. Every member's zero-box addFrom over clock x key x count. All
//     read UNBOXED from a Float64Array slot -- the gate is steady B/op <= 0.5 (== the no-op floor). ---
function ehAF(ck) {
    return { setup() { const eh = new ExponentialHistogram(1000, 0.01); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = clkStart(ck);
        for (let k = 0; k < 2000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[k & 15]; eh.addFrom(buf, 0); } return { eh, buf, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const eh = s.eh, buf = s.buf, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15]; eh.addFrom(buf, 0); acc[0] += eh.bucketCount; } } };
}
function fdAF(ck) {
    return { setup() { const fd = new ForwardDecay(1e9); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = clkStart(ck);
        for (let k = 0; k < 2000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[k & 15]; fd.addFrom(buf, 0); } return { fd, buf, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const fd = s.fd, buf = s.buf, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15]; fd.addFrom(buf, 0); acc[0] += (fd.mode === 'explicit' ? 1 : 0); } } };
}
function sdAF(ck) {
    return { setup() { const sd = new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = clkStart(ck);
        for (let k = 0; k < 2000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[k & 15] + 1; sd.addFrom(buf, 0); } return { sd, buf, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const sd = s.sd, buf = s.buf, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15] + 1; sd.addFrom(buf, 0); acc[0] += (sd.collapsed ? 1 : 0); } } };
}
function drAF(ck) {
    return { setup() { const dr = new DecayedReservoir(32, 100000, { seed: 7 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = clkStart(ck);
        for (let k = 0; k < 2000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[k & 15]; dr.addFrom(buf, 0); } return { dr, buf, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const dr = s.dr, buf = s.buf, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15]; dr.addFrom(buf, 0); acc[0] += dr.size; } } };
}
function shllAF(ck, kc) {
    return { setup() { const sl = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 3 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = clkStart(ck); const keys = KEYS[kc];
        for (let k = 0; k < 2000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = keys[k & 15]; sl.addFrom(buf, 0); } return { sl, buf, clk, keys, acc: new Float64Array(1) }; },
        hot(s, n) { const sl = s.sl, buf = s.buf, clk = s.clk, keys = s.keys, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = keys[i & 15]; sl.addFrom(buf, 0); acc[0] += sl.overflows; } } };
}
function scmAF(ck, kc, wt) {
    return { setup() { const scm = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }); const buf = new Float64Array(3); const clk = new Float64Array(1); clk[0] = clkStart(ck); const keys = KEYS[kc];
        for (let k = 0; k < 2000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = keys[k & 15]; buf[2] = wt; scm.addFrom(buf, 0); } return { scm, buf, clk, keys, w: wt, acc: new Float64Array(1) }; },
        hot(s, n) { const scm = s.scm, buf = s.buf, clk = s.clk, keys = s.keys, wt = s.w, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = keys[i & 15]; buf[2] = wt; scm.addFrom(buf, 0); acc[0] += scm.saturated; } } };
}
function adwinAF() {
    return { setup() { const ad = new ADWIN(0.1); const buf = new Float64Array(1); for (let k = 0; k < 4000; k++) { buf[0] = FRAC[k & 15] + ((k >> 9) & 1) * 10; ad.addFrom(buf, 0); } return { ad, buf, acc: new Float64Array(1) }; },
        hot(s, n) { const ad = s.ad, buf = s.buf, acc = s.acc; for (let i = 0; i < n; i++) { buf[0] = FRAC[i & 15] + ((i >> 9) & 1) * 10; acc[0] += (ad.addFrom(buf, 0) ? 1 : 0); } } };
}
function ddAF() {
    return { setup() { const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 }); const buf = new Float64Array(1); for (let k = 0; k < 4000; k++) { buf[0] = FRAC[k & 15] + ((k >> 9) & 1) * 10; dd.addFrom(buf, 0); } return { dd, buf, acc: new Float64Array(1) }; },
        hot(s, n) { const dd = s.dd, buf = s.buf, acc = s.acc; for (let i = 0; i < n; i++) { buf[0] = FRAC[i & 15] + ((i >> 9) & 1) * 10; acc[0] += (dd.addFrom(buf, 0) ? 1 : 0); } } };
}
// DriftDetector LATCH steady-state, addFrom, FRACTIONAL threshold (5.5). A CUSUM regime stream with a
// GRADUAL return (1000.5 up, 499.999 just under target 500) drives the FULL latch cold path every
// window -- arm+latch, sustained clamp, AND the re-arm _reset() branch -- while _lvl = -Infinity routes
// every item into cold _fired(). Proof the latched cold path (incl. the F-latch-rearm fix and a
// fractional threshold / half) is 0 B/op on the unboxed read path. The index persists across windows in
// a Float64Array slot so the pattern keeps advancing (never a boxed local counter).
function ddLatchAF() {
    const PAT_N = 1024;
    const PAT = new Float64Array(PAT_N);
    for (let p = 0; p < PAT_N; p++) PAT[p] = p < 256 ? 1000.5 : 499.999;
    return { setup() { const dd = new DriftDetector(DRIFT_CUSUM, { delta: 0.005, threshold: 5.5, target: 500, latch: true }); const buf = new Float64Array(1); const ix = new Float64Array(1);
        for (let k = 0; k < 4000; k++) { buf[0] = PAT[k & (PAT_N - 1)]; dd.addFrom(buf, 0); } ix[0] = 4000; return { dd, buf, ix, pat: PAT, acc: new Float64Array(1) }; },
        hot(s, n) { const dd = s.dd, buf = s.buf, pat = s.pat, acc = s.acc; let idx = s.ix[0] | 0; for (let i = 0; i < n; i++) { buf[0] = pat[idx & (PAT_N - 1)]; idx = (idx + 1) | 0; acc[0] += (dd.addFrom(buf, 0) ? 1 : 0) + (dd.latched ? 1 : 0); } s.ix[0] = idx; } };
}

// --- N4 (task 10): query lanes. Each hot op is one READ call on a pre-populated instance. ---
function qSddQuantileInto() {
    return { setup() { const sd = new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        for (let k = 0; k < 4000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((k * 40503) % 9973) + 0.5; sd.addFrom(buf, 0); }
        const qs = new Float64Array(3); qs[0] = 0.5; qs[1] = 0.9; qs[2] = 0.99; const out = new Float64Array(3); return { sd, qs, out, acc: new Float64Array(1) }; },
        hot(s, n) { const sd = s.sd, qs = s.qs, out = s.out, acc = s.acc; for (let i = 0; i < n; i++) { sd.quantileInto(qs, out); acc[0] += out[0]; } } };
}
function qSddQuantile99() {
    return { setup() { const sd = new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        for (let k = 0; k < 4000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((k * 40503) % 9973) + 0.5; sd.addFrom(buf, 0); } return { sd, acc: new Float64Array(1) }; },
        hot(s, n) { const sd = s.sd, acc = s.acc; for (let i = 0; i < n; i++) acc[0] += sd.quantile(0.99); } };
}
function qSddCount() {
    return { setup() { const sd = new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        for (let k = 0; k < 4000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((k * 40503) % 9973) + 0.5; sd.addFrom(buf, 0); } return { sd, acc: new Float64Array(1) }; },
        hot(s, n) { const sd = s.sd, acc = s.acc; for (let i = 0; i < n; i++) acc[0] += sd.count(); } };
}
function qScmEstimateIntoBig() {
    // SCM batch reader (1.8.0): estimateInto over 16 preallocated keys, ONE with a windowed count
    // >= 2^31. estimateInto writes each result into an out slot (no boxed double crosses a
    // non-inlined call), so the whole lane is 0 B/op even though estimate(bigKey) boxes its return.
    return { setup() { const scm = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }); const buf = new Float64Array(3); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        clk[0] += 1.5; buf[0] = clk[0]; buf[1] = 12345; buf[2] = 2 ** 31; scm.addFrom(buf, 0);   // one add, count 2^31 (<= SCM_SAT)
        const keys = new Float64Array(16); for (let k = 0; k < 16; k++) keys[k] = (k * 733) + 1; keys[0] = 12345;   // key 0 -> the big count
        keys[1] = 9007199254740991; keys[2] = -2147483648;   // key axis: 2^53-1 and -2^31 through the hot hash
        const out = new Float64Array(16);
        if (!(scm.estimate(12345) >= 2 ** 31)) throw new Error('q_scm_estimateInto_big setup: the big key must read >= 2^31');   // fail closed
        return { scm, keys, out, acc: new Float64Array(1) }; },
        hot(s, n) { const scm = s.scm, keys = s.keys, out = s.out, acc = s.acc; for (let i = 0; i < n; i++) { scm.estimateInto(keys, out); acc[0] += out[0]; } } };
}
function qScmEstimateBig() {
    // CONTROL (must BOX): the PLAIN estimate() returns a windowed count >= 2^31 as a boxed ~16 B
    // HeapNumber every call -- the must-box sibling of estimateInto (which lands the same double in an
    // out slot at 0 B/op). If this lane ever reads 0, the box detector has gone blind. Measured 16 B/op.
    return { setup() { const scm = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }); const buf = new Float64Array(3); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        clk[0] += 1.5; buf[0] = clk[0]; buf[1] = 12345; buf[2] = 2 ** 31; scm.addFrom(buf, 0);   // count 2^31 -> estimate boxes a big double
        return { scm, key: 12345, acc: new Float64Array(1) }; },
        hot(s, n) { const scm = s.scm, key = s.key, acc = s.acc; for (let i = 0; i < n; i++) acc[0] += scm.estimate(key); } };
}
function qScmTotal() {
    // SCM total(w) (1.8.0): the exact windowed N. A cold reader a consumer calls per frame for the
    // eps x N band; 0 B/op (it returns a small integer double here, but the lane asserts the path).
    return { setup() { const scm = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }); const buf = new Float64Array(3); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        for (let k = 0; k < 4000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = (k & 511) + 1; buf[2] = (k & 7) + 1; scm.addFrom(buf, 0); }
        return { scm, acc: new Float64Array(1) }; },
        hot(s, n) { const scm = s.scm, acc = s.acc; for (let i = 0; i < n; i++) acc[0] += scm.total(); } };
}
function qEhSum() {
    return { setup() { const eh = new ExponentialHistogram(1000, 0.01); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        for (let k = 0; k < 4000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[k & 15]; eh.addFrom(buf, 0); } return { eh, acc: new Float64Array(1) }; },
        hot(s, n) { const eh = s.eh, acc = s.acc; for (let i = 0; i < n; i++) acc[0] += eh.sum(); } };
}
function qHkEstimate() {
    return { setup() { const hk = new HeavyKeeper(4, 512, 16, { seed: 4 }); for (let k = 0; k < 4000; k++) hk.add((k % 500) + 1, 1); return { hk, key: 7, acc: new Float64Array(1) }; },
        hot(s, n) { const hk = s.hk, key = s.key, acc = s.acc; for (let i = 0; i < n; i++) acc[0] += hk.estimate(key); } };
}
function qHkForEach() {
    return { setup() { const hk = new HeavyKeeper(4, 128, 8, { seed: 4 }); for (let k = 0; k < 4000; k++) hk.add((k % 200) + 1, (k & 7) + 1); const sl = new Float64Array(1); const fn = (key, est) => { sl[0] += est - key; }; return { hk, fn, sl, acc: new Float64Array(1) }; },
        hot(s, n) { const hk = s.hk, fn = s.fn, sl = s.sl, acc = s.acc; for (let i = 0; i < n; i++) { hk.forEach(fn); acc[0] += sl[0]; } } };
}
function qDrSampleInto() {
    return { setup() { const dr = new DecayedReservoir(32, 100000, { seed: 7 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        for (let k = 0; k < 4000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[k & 15]; dr.addFrom(buf, 0); } const out = new Float64Array(32); return { dr, out, acc: new Float64Array(1) }; },
        hot(s, n) { const dr = s.dr, out = s.out, acc = s.acc; for (let i = 0; i < n; i++) { const m = dr.sampleInto(out); acc[0] += out[0] + m; } } };
}
// SHLL count() on a NON-degenerate sketch (thousands of distinct keys across a wide window). Finding
// (A): count() keeps its Ertl scratch (no ARRAY alloc) but RETURNS a rounded double -- a stable 16 B in
// the estimator tail (slTau / the k-loop / slSigma / Math.round), +16 B when the caller is not yet
// optimized. No library alloc gate measured count() before 1.8.0. Documented band [12, 40] B/op: the
// lower bound proves the probe SEES the cost; the upper bound fails on a third box (the estimator tail
// stays ONE box). Fed unboxed from a Float64Array key table so the DRIVER never boxes (R3).
function qShllCount() {
    return { setup() { const sl = new SlidingHyperLogLog(100000, { p: 12, ringCap: 8, seed: 3 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        for (let k = 0; k < 20000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((k * 2654435761) >>> 0); sl.addFrom(buf, 0); }
        if (!(sl.count() > 1000)) throw new Error('q_shll_count setup: sketch is degenerate (count=' + sl.count() + '); need thousands of distinct keys');   // fail closed
        return { sl, acc: new Float64Array(1) }; },
        hot(s, n) { const sl = s.sl, acc = s.acc; for (let i = 0; i < n; i++) acc[0] += sl.count(); } };
}
// DriftDetector latch:true PH on a fire-heavy square wave (low 0 / high HI, HALF each). Finding (B): a
// latched PH fire can box one ~16 B HeapNumber; the effect is TIER-DEPENDENT (Maglev boxes, steady
// Turbofan holds the value in a slot). No bit-identical source change removes it (25+ variants). The
// index persists across windows in a Float64Array slot (never a boxed local counter). Gated as a
// documented CEILING (<= 4 B/op) so the current code passes deterministically while a regression to a
// per-add box (>= 16 B/op) fails -- see AllocMatrix.
function ddLatchPhFireheavy() {
    const PAT_N = 64;
    const PAT = new Float64Array(PAT_N);
    for (let p = 0; p < PAT_N; p++) PAT[p] = (p < 32) ? 0 : 10;
    return { setup() { const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5, latch: true }); const buf = new Float64Array(1); const ix = new Float64Array(1);
        for (let k = 0; k < 4000; k++) { buf[0] = PAT[k & (PAT_N - 1)]; dd.addFrom(buf, 0); } ix[0] = 4000; return { dd, buf, ix, pat: PAT, acc: new Float64Array(1) }; },
        hot(s, n) { const dd = s.dd, buf = s.buf, pat = s.pat, acc = s.acc; let idx = s.ix[0] | 0; for (let i = 0; i < n; i++) { buf[0] = pat[idx & (PAT_N - 1)]; idx = (idx + 1) | 0; acc[0] += (dd.addFrom(buf, 0) ? 1 : 0) + (dd.latched ? 1 : 0); } s.ix[0] = idx; } };
}

export const LANES = {
    n1, noop,
    eh_addFrom, fd_addFrom, shll_addFrom, sd_addFrom, scm_addFrom, dr_addFrom,
    hk_addFrom_small: hkAddFrom('small', 1),
    hk_addFrom_p31: hkAddFrom('p31', 1),
    hk_addFrom_p32m1: hkAddFrom('p32m1', 1),
    hk_addFrom_p53m1: hkAddFrom('p53m1', 1),
    hk_addFrom_large: hkAddFrom('p32m1', 1),   // the shipped gate's F3 lane (key near 2^32-1)

    // N2 (task 8) shared megamorphic call site: FD/DD are the asserted CONTROLS (must box).
    shared_fd: sharedLane('fd'),
    shared_dd: sharedLane('dd'),
    shared_eh: sharedLane('eh'),
    shared_sdd: sharedLane('sdd'),

    // N3 (task 9) addFrom matrix. HK (key x weight); SHLL/SCM (clock x key [x count]); the scalar
    // members (clock only, or value only for ADWIN/DD).
    hk_af_small_w1: hkAddFrom('small', 1),
    hk_af_p30_w1: hkAddFrom('p30', 1),
    hk_af_p31_w1: hkAddFrom('p31', 1),
    hk_af_p32m1_w1: hkAddFrom('p32m1', 1),
    hk_af_neg31_w1: hkAddFrom('neg31', 1),
    hk_af_p53m1_w1: hkAddFrom('p53m1', 1),
    hk_af_small_wp30: hkAddFrom('small', 2 ** 30),
    hk_af_p31_wp30: hkAddFrom('p31', 2 ** 30),
    // default-seed (0x9e3779b1) variants -- the seed is a HeapNumber field, not a Smi seed=4.
    hk_af_p31_w1_defseed: hkAddFrom('p31', 1, null),
    hk_af_p31_wp30_defseed: hkAddFrom('p31', 2 ** 30, null),

    shll_af_now_p31: shllAF('now', 'p31'),
    shll_af_now_p53m1: shllAF('now', 'p53m1'),
    shll_af_epoch_p31: shllAF('epoch', 'p31'),
    shll_af_epoch_p53m1: shllAF('epoch', 'p53m1'),

    scm_af_epoch_small_c1: scmAF('epoch', 'small', 1),
    scm_af_epoch_p31_c1: scmAF('epoch', 'p31', 1),
    scm_af_epoch_p32m1_c1: scmAF('epoch', 'p32m1', 1),
    scm_af_epoch_p31_cp30: scmAF('epoch', 'p31', 2 ** 30),

    eh_af_now: ehAF('now'),
    eh_af_epoch: ehAF('epoch'),
    fd_af_now: fdAF('now'),
    fd_af_epoch: fdAF('epoch'),
    sd_af_epoch: sdAF('epoch'),
    dr_af_epoch: drAF('epoch'),
    adwin_af: adwinAF(),
    dd_af: ddAF(),
    dd_latch_af: ddLatchAF(),

    // N4 (task 10) query lanes.
    q_sdd_quantileInto: qSddQuantileInto(),
    q_sdd_quantile99: qSddQuantile99(),
    q_sdd_count: qSddCount(),
    q_scm_estimateInto_big: qScmEstimateIntoBig(),
    q_scm_estimate_big: qScmEstimateBig(),
    q_scm_total: qScmTotal(),
    q_eh_sum: qEhSum(),
    q_hk_estimate: qHkEstimate(),
    q_hk_foreach: qHkForEach(),
    q_dr_sampleInto: qDrSampleInto(),

    // 1.8.0 doc-truth lanes: the two measured findings no library alloc gate saw before (SHLL count()
    // boxes; latched-PH fire boxes in Maglev).
    q_shll_count: qShllCount(),
    dd_latch_ph_fireheavy: ddLatchPhFireheavy(),
};

// ---------------------------------------------------------------------------
// warm-up (task 3): ~50k ops through differently-configured instances of every member so the
// hot-path call sites go polymorphic (R3). All clocks / keys / values live in Float64Array slots.
// ---------------------------------------------------------------------------
export function warmSiblings() {
    const buf = new Float64Array(3);
    const clk = new Float64Array(1);
    const acc = new Float64Array(1);
    const nOps = 6000;
    const kcs = Object.keys(KEYS);

    // HeavyKeeper: other d / w / k / b configs, all key classes, add + addFrom + estimate.
    const hks = [new HeavyKeeper(2, 64, 8, { seed: 9 }), new HeavyKeeper(3, 256, 32, { seed: 11, b: 1.05 }), new HeavyKeeper(5, 1024, 4)];
    for (const hk of hks) {
        for (let i = 0; i < nOps; i++) {
            const kt = KEYS[kcs[i % kcs.length]];
            buf[0] = kt[i & 15]; buf[1] = (i & 3) + 1;
            hk.addFrom(buf, 0);
            hk.add(kt[(i + 3) & 15], (i & 1) + 1);
            if ((i & 63) === 0) acc[0] += hk.estimate(kt[i & 15]);
        }
    }
    // ExponentialHistogram: count + explicit, other W / eps.
    const ehs = [new ExponentialHistogram(50, 0.2), new ExponentialHistogram(500, 0.05)];
    const ehc = new ExponentialHistogram(100, 0.1);
    clk[0] = 0;
    for (let i = 0; i < nOps; i++) {
        clk[0] += 0.75; buf[0] = clk[0]; buf[1] = FRAC[i & 15];
        ehs[i & 1].addFrom(buf, 0); ehs[i & 1].add(clk[0] + 0.1, 2);
        ehc.add();
        if ((i & 63) === 0) acc[0] += ehs[i & 1].sum() + ehc.count();
    }
    // ForwardDecay.
    const fds = [new ForwardDecay(10), new ForwardDecay(0.5), new ForwardDecay(5000)];
    clk[0] = 0;
    for (let i = 0; i < nOps; i++) {
        clk[0] += 1.25; buf[0] = clk[0]; buf[1] = FRAC[i & 15];
        const fd = fds[i % 3]; fd.addFrom(buf, 0); fd.add(clk[0] + 0.5, i & 7);
    }
    // SlidingHyperLogLog.
    const shs = [new SlidingHyperLogLog(200, { p: 8, seed: 5 }), new SlidingHyperLogLog(5000, { p: 12, seed: 6 })];
    clk[0] = 1.7e12;
    for (let i = 0; i < nOps; i++) {
        clk[0] += 1.5; buf[0] = clk[0]; buf[1] = KEYS[kcs[i % kcs.length]][i & 15];
        shs[i & 1].addFrom(buf, 0);
        if ((i & 255) === 0) acc[0] += shs[i & 1].count();
    }
    // SlidingCountMin.
    const scms = [new SlidingCountMin(300, { panes: 4, w: 64, d: 3, seed: 7 }), new SlidingCountMin(2000, { panes: 16, w: 256, d: 5, seed: 8 })];
    clk[0] = 1.7e12;
    for (let i = 0; i < nOps; i++) {
        clk[0] += 1.5; buf[0] = clk[0]; buf[1] = KEYS[kcs[i % kcs.length]][i & 15]; buf[2] = (i & 7) + 1;
        scms[i & 1].addFrom(buf, 0);
        if ((i & 63) === 0) acc[0] += scms[i & 1].estimate(buf[1]);
    }
    // SlidingDDSketch.
    const sds = [new SlidingDDSketch(200, { alpha: 0.02, panes: 4 }), new SlidingDDSketch(5000, { alpha: 0.005 })];
    const qs = new Float64Array(2); qs[0] = 0.25; qs[1] = 0.75; const out = new Float64Array(2);
    clk[0] = 1.7e12;
    for (let i = 0; i < nOps; i++) {
        clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15] * 100 + 1;
        sds[i & 1].addFrom(buf, 0);
        if ((i & 63) === 0) { sds[i & 1].quantileInto(qs, out); acc[0] += out[0] + sds[i & 1].quantile(0.5); }
    }
    // DriftDetector (both modes) + ADWIN.
    const dds = [new DriftDetector(DRIFT_PH), new DriftDetector(DRIFT_CUSUM, { target: 1 }), new DriftDetector(DRIFT_PH, { delta: 0.01, threshold: 20 })];
    const ad = new ADWIN(0.05);
    for (let i = 0; i < nOps; i++) {
        buf[0] = FRAC[i & 15] + ((i >> 9) & 1) * 10;
        dds[i % 3].addFrom(buf, 0); dds[i % 3].add(i & 7);
        ad.addFrom(buf, 0);
    }
    // DecayedReservoir.
    const drs = [new DecayedReservoir(8, 50, { seed: 1 }), new DecayedReservoir(64, 1e4, { seed: 2 })];
    clk[0] = 1.7e12;
    for (let i = 0; i < nOps; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15]; drs[i & 1].addFrom(buf, 0); }
    return acc[0];
}

// ---------------------------------------------------------------------------
// runLane (task 3): one lane per child process, pinned flags + --expose-gc, lane via LITE_LANE.
// ---------------------------------------------------------------------------
/**
 * @param {string} laneName key into LANES
 * @param {'fresh'|'warmed'} [mode='fresh'] warmed runs warmSiblings() first (polymorphic call sites)
 * @param {number} [N=200000]
 * @param {string[]} [flags=[]] extra node flags for the child (F19: e.g. ['--no-turbo-inlining'] to
 *   force the large-key hash lanes to expose an argument box deterministically). Inserted BEFORE the
 *   pinned --min/--max-semi-space-size=4 flags so, under V8's last-wins rule, the semi-space PINS
 *   always win (extra flags cannot un-pin new space and drift B/op). A semi-space flag in `flags` is
 *   REJECTED (fail closed) so the pin can never be silently overridden.
 * @returns {Promise<{first:number, steady:number, readings:number[], execArgv:string[]}>}
 */
export function runLane(laneName, mode = 'fresh', N = 200000, flags = []) {
    for (const f of flags) {
        if (/semi[-_]space[-_]size/.test(String(f))) {
            throw new Error('[AllocProbe] runLane fail closed: a semi-space flag in `flags` (' + f +
                ') would override the pinned --min/--max-semi-space-size=4; not allowed.');
        }
    }
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath,
            ['--expose-gc', ...flags, '--min-semi-space-size=4', '--max-semi-space-size=4', SELF],
            { env: Object.assign({}, process.env, { LITE_LANE: laneName, LITE_MODE: mode, LITE_N: String(N) }),
                stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) return reject(new Error('[AllocProbe] lane ' + laneName + ' exited ' + code));
            const line = out.trim().split('\n').filter(Boolean).pop();
            try { resolve(JSON.parse(line)); }
            catch (e) { reject(new Error('[AllocProbe] bad lane output for ' + laneName + ': ' + out)); }
        });
    });
}

// ---------------------------------------------------------------------------
// child entry: when LITE_LANE is set, run the lane and print one JSON line.
// ---------------------------------------------------------------------------
if (process.env.LITE_LANE) {
    const laneName = process.env.LITE_LANE;
    const mode = process.env.LITE_MODE || 'fresh';
    const N = parseInt(process.env.LITE_N || '200000', 10);
    const lane = LANES[laneName];
    if (!lane) { console.error('[AllocProbe] no lane "' + laneName + '"'); process.exit(2); }
    if (typeof globalThis.gc !== 'function') { console.error('[AllocProbe] child needs --expose-gc'); process.exit(2); }
    if (mode === 'warmed') warmSiblings();
    const K = 4000;
    const r = await steadyMin(lane, { windows: 4, K });
    // LITE_MATRIX=1: skip the 8N scavenge count (the matrix/query lanes gate on steady B/op only, so
    // the expensive scavenge sweep is pure wall-time waste there).
    const scav = process.env.LITE_MATRIX === '1' ? -1 : await scavengesAt(lane, 8 * N, lane.setup());
    // execArgv (F19 blocker 4): echo the node flags this child actually received so the parent can
    // fail closed unless --no-turbo-inlining truly reached the flagged noInlineLargeKey rows.
    process.stdout.write(JSON.stringify({ lane: laneName, mode, N, first: r.first, steady: r.steady, readings: r.readings, scav8N: scav, execArgv: process.execArgv }) + '\n');
    process.exit(0);
}
