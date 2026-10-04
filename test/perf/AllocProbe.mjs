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
    DecayedReservoir, SlidingAggregate } from '../../Adaptive.js';

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
    const sa = new SlidingAggregate(1000, { panes: 8 });
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
        callAdd(sa, t, FRAC[i & 15]);            // SA.add(now, value): both fractional
        sink += eh.bucketCount;
    }
    return sink + fd.mode.length + dr.size + sa.panes;
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
// 1.12.0 totalInto: an SCM whose windowed total N is >= 2^31 (one add of count 2^31 plus a small stream),
// so total() RETURNS a non-Smi double. Shared by the totalInto gate lane and the total() must-box control.
function buildScmBigTotal() {
    const scm = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }); const buf = new Float64Array(3); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
    clk[0] += 1.5; buf[0] = clk[0]; buf[1] = 12345; buf[2] = 2 ** 31; scm.addFrom(buf, 0);
    for (let k = 0; k < 400; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = (k & 511) + 1; buf[2] = (k & 7) + 1; scm.addFrom(buf, 0); }
    if (!(scm.total() >= 2 ** 31)) throw new Error('q_scm_total*_big setup: total() must read >= 2^31');   // fail closed
    return scm;
}
function qScmTotalIntoBig() {
    // SCM totalInto(out) (1.12.0) with N >= 2^31: the sum lands in out[0], nothing is returned as a double
    // (returns 1, a Smi) -> 0 B/op at every inlining state (the noInlineLargeKey row re-runs it with
    // --no-turbo-inlining).
    return { setup() { const scm = buildScmBigTotal(); const out = new Float64Array(1); return { scm, out, acc: new Float64Array(1) }; },
        hot(s, n) { const scm = s.scm, out = s.out, acc = s.acc; for (let i = 0; i < n; i++) { scm.totalInto(out); acc[0] += out[0]; } } };
}
function qScmTotalBig() {
    // CONTROL (must BOX under --no-turbo-inlining): total() RETURNING N >= 2^31 boxes a ~16 B HeapNumber
    // per call when the call is not inlined -- the demo's 2026-10-04 heavy-count flake, and the box
    // totalInto exists to avoid. If this reads 0 under the flag, the probe has gone blind.
    return { setup() { const scm = buildScmBigTotal(); return { scm, acc: new Float64Array(1) }; },
        hot(s, n) { const scm = s.scm, acc = s.acc; for (let i = 0; i < n; i++) acc[0] += scm.total(); } };
}
function qScmTotalIntoWfrac() {
    // DOCUMENTED BOX (must box under --no-turbo-inlining): a FRACTIONAL sub-window w (62.5) is itself a
    // non-Smi ARGUMENT, so totalInto(out, 62.5) boxes 16 B/call at a non-inlined site even though nothing is
    // returned (the README / llms.txt "w omitted or integral" qualifier; review N4). Integral w reads 0.
    return { setup() { const scm = buildScmBigTotal(); return { scm, out: new Float64Array(1), wb: Float64Array.of(62.5), acc: new Float64Array(1) }; },
        hot(s, n) { const scm = s.scm, out = s.out, wb = s.wb, acc = s.acc; for (let i = 0; i < n; i++) { scm.totalInto(out, wb[0]); acc[0] += out[0]; } } };
}
function qScmTotalIntoWint() {
    // the integral sub-window (500) through the same slot: 0 B/op even with inlining off.
    return { setup() { const scm = buildScmBigTotal(); return { scm, out: new Float64Array(1), wb: Float64Array.of(500), acc: new Float64Array(1) }; },
        hot(s, n) { const scm = s.scm, out = s.out, wb = s.wb, acc = s.acc; for (let i = 0; i < n; i++) { scm.totalInto(out, wb[0]); acc[0] += out[0]; } } };
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
// SHLL count() on a NON-degenerate sketch (thousands of distinct keys across a wide window). v1.11.0
// (S3-a + review B1): count()'s estimator tail is now box-free. The slSigmaInto / slTauInto helpers are
// VOID (they write the converged value into SL_EST, never return it) AND argument-free (the empty /
// saturated fraction is handed through the SL_SIG_S / SL_TAU_S slots, never a computed-double argument
// that boxes when V8 does not inline the helper), and count() writes the rounded estimate straight into a
// Float64Array slot via _writeCount. At an inlinable monomorphic call site (this lane) count() reads <=
// 0.5 B/op steady -- fed unboxed from a Float64Array key table so the DRIVER never boxes (R3). The
// must-box teeth now live in the demo mustbox control and the DD six-getter lane.
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

// ===========================================================================
// SlidingAggregate (1.9.0, ADR 0012) probe lanes. clk {now, epoch} x value {small int, fraction,
// -1e149, 1e150} for addFrom; the event-heavy rotate-every-add epoch lanes; advance/advanceFrom/clear;
// the scalar readers + into at monomorphic / polymorphic / megamorphic sites; and the two must-box
// megamorphic controls (q_sa_mean_mega, sa_add_mega_rot). Every clock / value lives in a Float64Array
// slot; sinks accumulate into a slot. ---
// ===========================================================================

// value tables: small int, fraction, -1e149, 1e150 (the SA_X_MAX cap boundary). All exact doubles.
const SAVAL = {
    small: (() => { const t = new Float64Array(16); for (let j = 0; j < 16; j++) t[j] = (j % 100) - 50; return t; })(),
    frac: FRAC,
    neg149: (() => { const t = new Float64Array(16); t.fill(-1e149); return t; })(),
    max150: (() => { const t = new Float64Array(16); t.fill(1e150); return t; })(),
};

// SA addFrom over clock x value. Read UNBOXED from a Float64Array slot -> steady B/op <= 0.5.
function saAF(ck, vk) {
    return { setup() { const sa = new SlidingAggregate(1000, { panes: 8 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = clkStart(ck); const vals = SAVAL[vk];
        for (let k = 0; k < 2000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = vals[k & 15]; sa.addFrom(buf, 0); } return { sa, buf, clk, vals, acc: new Float64Array(1) }; },
        hot(s, n) { const sa = s.sa, buf = s.buf, clk = s.clk, vals = s.vals, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = vals[i & 15]; sa.addFrom(buf, 0); acc[0] += sa.lastNow; } } };
}

// EVENT-HEAVY: SA(32, {panes: 32}) -> pw = 1, epoch clock stepping +1.5, so EVERY addFrom rotates with a
// NON-Smi now. The argument-free _advance() reads this._now, so no epoch double crosses a non-inlined
// call -> steady B/op <= 0.5 (the 1.8.0 event-heavy lesson: a per-rotation box cannot hide here).
function saAfEpochRot() {
    return { setup() { const sa = new SlidingAggregate(32, { panes: 32 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        for (let k = 0; k < 400; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[k & 15]; sa.addFrom(buf, 0); } return { sa, buf, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const sa = s.sa, buf = s.buf, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15]; sa.addFrom(buf, 0); acc[0] += sa.lastNow; } } };
}
// EVENT-HEAVY: same pw=1 epoch rotate-every-op via advanceFrom (idle slide).
function saAdvEpochRot() {
    return { setup() { const sa = new SlidingAggregate(32, { panes: 32 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        buf[0] = clk[0]; buf[1] = 1; sa.addFrom(buf, 0);   // lock EXPLICIT + anchor
        for (let k = 0; k < 400; k++) { clk[0] += 1.5; buf[0] = clk[0]; sa.advanceFrom(buf, 0); } return { sa, buf, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const sa = s.sa, buf = s.buf, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; sa.advanceFrom(buf, 0); acc[0] += sa.lastNow; } } };
}
// advance(now) at a monomorphic site: the fractional now is inlined (no box) -> 0. clk += 40 (pw=31.25) rotates.
function saAdvance() {
    return { setup() { const sa = new SlidingAggregate(1000, { panes: 32 }); const clk = new Float64Array(1); clk[0] = CLK_EPOCH; sa.add(clk[0], 1);
        for (let k = 0; k < 400; k++) { clk[0] += 40; sa.advance(clk[0]); } return { sa, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const sa = s.sa, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 40; sa.advance(clk[0]); acc[0] += sa.lastNow; } } };
}
// advanceFrom: zero-box slot clock.
function saAdvanceFrom() {
    return { setup() { const sa = new SlidingAggregate(1000, { panes: 32 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH; buf[0] = clk[0]; buf[1] = 1; sa.addFrom(buf, 0);
        for (let k = 0; k < 400; k++) { clk[0] += 40; buf[0] = clk[0]; sa.advanceFrom(buf, 0); } return { sa, buf, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const sa = s.sa, buf = s.buf, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 40; buf[0] = clk[0]; sa.advanceFrom(buf, 0); acc[0] += sa.lastNow; } } };
}
// clear(): reset + one re-seed add per op.
function saClear() {
    return { setup() { const sa = new SlidingAggregate(1000, { panes: 32 }); for (let k = 0; k < 400; k++) sa.add(k, (k % 100) - 50); return { sa, ix: new Float64Array(1), acc: new Float64Array(1) }; },
        hot(s, n) { const sa = s.sa, ix = s.ix, acc = s.acc; let i = ix[0] | 0; for (let j = 0; j < n; j++) { sa.clear(); sa.add(i, (i % 100) - 50); i = (i + 1) | 0; acc[0] += (sa.mode === 'explicit' ? 1 : 0); } ix[0] = i; } };
}

// --- SA readers: scalar (monomorphic) + into (mono / poly4 / mega5) + must-box (mean-mega / add-mega-rot).
// Populate an SA (or subclass) with fractional values so the readers return non-integral doubles.
function mkSa(K) {
    const s = new K(1000, { panes: 8 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
    for (let k = 0; k < 4000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = (k % 1000) * 0.5 - 250; s.addFrom(buf, 0); }
    return s;
}
// empty SlidingAggregate subclasses: distinct maps for the polymorphic / megamorphic call sites.
class SASubA extends SlidingAggregate {}
class SASubB extends SlidingAggregate {}
class SASubC extends SlidingAggregate {}
class SASubD extends SlidingAggregate {}
const SA_SHAPES4 = [SlidingAggregate, SASubA, SASubB, SASubC];        // <= 4 maps -> polymorphic
const SA_SHAPES5 = [SlidingAggregate, SASubA, SASubB, SASubC, SASubD]; // 5 maps -> megamorphic
// distinct call sites: callIntoP stays polymorphic (<=4 shapes ever); callIntoM / callMeanM go megamorphic.
function callIntoP(o, out) { return o.into(out); }
function callIntoM(o, out) { return o.into(out); }
function callMeanM(o) { return o.mean(); }
function megamorphizeInto(fn) { const out = new Float64Array(5); const insts = SA_SHAPES5.map(mkSa); let s = 0; for (let i = 0; i < 4000; i++) s += fn(insts[i % 5], out); return s; }
function megamorphizeMean() { const insts = SA_SHAPES5.map(mkSa); let s = 0; for (let i = 0; i < 4000; i++) s += callMeanM(insts[i % 5]); return s; }

// scalar reader (monomorphic site). count() returns a Smi-ish integer (~0 B); sum/mean/min/max return a
// double (~16 B). Gated in the band [0, 16.5] (docs: "up to 16 B/call; use into()").
function qSaScalar(kind) {
    return { setup() { return { sa: mkSa(SlidingAggregate), acc: new Float64Array(1) }; },
        hot(s, n) { const sa = s.sa, acc = s.acc;
            if (kind === 'count') { for (let i = 0; i < n; i++) acc[0] += sa.count(); }
            else if (kind === 'sum') { for (let i = 0; i < n; i++) acc[0] += sa.sum(); }
            else if (kind === 'mean') { for (let i = 0; i < n; i++) acc[0] += sa.mean(); }
            else if (kind === 'min') { for (let i = 0; i < n; i++) acc[0] += sa.min(); }
            else { for (let i = 0; i < n; i++) acc[0] += sa.max(); } } };
}
// into at a MONOMORPHIC site: nothing is returned as a double (returns 5, a Smi) -> 0 B/op.
function saIntoMono() {
    return { setup() { const sa = mkSa(SlidingAggregate); const out = new Float64Array(5); return { sa, out, acc: new Float64Array(1) }; },
        hot(s, n) { const sa = s.sa, out = s.out, acc = s.acc; for (let i = 0; i < n; i++) { sa.into(out); acc[0] += out[0]; } } };
}
// into at a POLYMORPHIC site (4 subclass shapes): still inline-cacheable -> 0 B/op.
function saIntoPoly4() {
    return { setup() { const insts = SA_SHAPES4.map(mkSa); const out = new Float64Array(5); for (let i = 0; i < 4000; i++) callIntoP(insts[i & 3], out); return { insts, out, acc: new Float64Array(1) }; },
        hot(s, n) { const insts = s.insts, out = s.out, acc = s.acc; for (let i = 0; i < n; i++) { callIntoP(insts[i & 3], out); acc[0] += out[0]; } } };
}
// into at a MEGAMORPHIC site (5 subclass shapes): the this._now double-field read boxes ~16 B/op
// (a family-wide V8 property, RE-SETTLED / logged for 1.10.0). INFORMATIONAL, gated in the band [12, 20].
function saIntoMega5() {
    return { setup() { megamorphizeInto(callIntoM); const insts = SA_SHAPES5.map(mkSa); const out = new Float64Array(5); return { insts, out, acc: new Float64Array(1) }; },
        hot(s, n) { const insts = s.insts, out = s.out, acc = s.acc; for (let i = 0; i < n; i++) { callIntoM(insts[i % 5], out); acc[0] += out[0]; } } };
}
// MUST-BOX control: mean() over 5 subclass maps boxes its fractional return AND the this._now read
// (measured ~32 B). Gated >= 12 -- proves the probe sees the megamorphic box.
function qSaMeanMega() {
    return { setup() { megamorphizeMean(); const insts = SA_SHAPES5.map(mkSa); return { insts, acc: new Float64Array(1) }; },
        hot(s, n) { const insts = s.insts, acc = s.acc; for (let i = 0; i < n; i++) acc[0] += callMeanM(insts[i % 5]); } };
}
// MUST-BOX control: fractional now + value through the megamorphic callAdd site on the rotate-every-add
// (pw=1) SA shape. Both fractional args box at the megamorphic boundary (~32 B). Gated >= 12.
function saAddMegaRot() {
    return { setup() { megamorphizeCallAdd(); const sa = new SlidingAggregate(64, { panes: 64 }); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        for (let k = 0; k < 400; k++) { clk[0] += 1.5; callAdd(sa, clk[0], FRAC[k & 15]); } return { sa, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const sa = s.sa, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; callAdd(sa, clk[0], FRAC[i & 15]); acc[0] += sa.lastNow; } } };
}

// ===========================================================================
// 1.10.0 H2 hardening probe lanes (batch 1, T1). Event-heavy pw=1 rotate-every-op lanes for SCM/SDD
// (the H2-2 argument-tagging measurement: SCM/SDD pass `t` to _advance(t)/_anchor(t), so a rotation
// may tag an epoch double), a must-box SCM copy of saAddMegaRot, and mega5_<cls>_af for all ten
// classes (H2-5 megamorphic double-field boxing, INFO). Every clock/key/value lives in a Float64Array
// slot; sinks accumulate into a slot; each setup throws if its rotate-every-op precondition fails.
// ===========================================================================

// SCM(32, {panes:32, w:128, d:4, seed:7}) -> pw = 1; epoch clock +1.5 rotates EVERY add. The setup
// asserts _cur advances on each of a handful of warm ops (fail closed if it does not rotate).
function scmAfEpochRot() {
    return { setup() { const scm = new SlidingCountMin(32, { panes: 32, w: 128, d: 4, seed: 7 }); const buf = new Float64Array(3); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        buf[0] = clk[0]; buf[1] = 1; buf[2] = 1; scm.addFrom(buf, 0);   // lock explicit + anchor
        let moved = 0; for (let k = 0; k < 8; k++) { const before = scm._cur; clk[0] += 1.5; buf[0] = clk[0]; buf[1] = (k & 1023) + 1; buf[2] = 1; scm.addFrom(buf, 0); if (scm._cur !== before) moved++; }
        if (moved < 8) throw new Error('scm_af_epoch_rot setup: expected a rotation every op (pw=1), only ' + moved + '/8 moved');
        return { scm, buf, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const scm = s.scm, buf = s.buf, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = (i & 1023) + 1; buf[2] = 1; scm.addFrom(buf, 0); acc[0] += scm.saturated; } } };
}
// SCM pw=1 rotate-every-op via advanceFrom (idle slide).
function scmAdvEpochRot() {
    return { setup() { const scm = new SlidingCountMin(32, { panes: 32, w: 128, d: 4, seed: 7 }); const buf = new Float64Array(3); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        buf[0] = clk[0]; buf[1] = 1; buf[2] = 1; scm.addFrom(buf, 0);   // lock explicit + anchor
        const ab = new Float64Array(1); let moved = 0; for (let k = 0; k < 8; k++) { const before = scm._cur; clk[0] += 1.5; ab[0] = clk[0]; scm.advanceFrom(ab, 0); if (scm._cur !== before) moved++; }
        if (moved < 8) throw new Error('scm_adv_epoch_rot setup: expected a rotation every op (pw=1), only ' + moved + '/8 moved');
        return { scm, ab, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const scm = s.scm, ab = s.ab, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; ab[0] = clk[0]; scm.advanceFrom(ab, 0); acc[0] += scm.lastNow; } } };
}
// SDD(32, {alpha:.01, panes:32}) -> pw = 1; epoch clock +1.5 rotates EVERY add. value FRAC[i&15]+1.
function sddAfEpochRot() {
    return { setup() { const sd = new SlidingDDSketch(32, { alpha: 0.01, panes: 32 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        buf[0] = clk[0]; buf[1] = 1; sd.addFrom(buf, 0);   // lock explicit + anchor
        let moved = 0; for (let k = 0; k < 8; k++) { const before = sd._cur; clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[k & 15] + 1; sd.addFrom(buf, 0); if (sd._cur !== before) moved++; }
        if (moved < 8) throw new Error('sdd_af_epoch_rot setup: expected a rotation every op (pw=1), only ' + moved + '/8 moved');
        return { sd, buf, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const sd = s.sd, buf = s.buf, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15] + 1; sd.addFrom(buf, 0); acc[0] += (sd.collapsed ? 1 : 0); } } };
}
// SDD pw=1 rotate-every-op via advanceFrom (idle slide).
function sddAdvEpochRot() {
    return { setup() { const sd = new SlidingDDSketch(32, { alpha: 0.01, panes: 32 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        buf[0] = clk[0]; buf[1] = 1; sd.addFrom(buf, 0);   // lock explicit + anchor
        const ab = new Float64Array(1); let moved = 0; for (let k = 0; k < 8; k++) { const before = sd._cur; clk[0] += 1.5; ab[0] = clk[0]; sd.advanceFrom(ab, 0); if (sd._cur !== before) moved++; }
        if (moved < 8) throw new Error('sdd_adv_epoch_rot setup: expected a rotation every op (pw=1), only ' + moved + '/8 moved');
        return { sd, ab, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const sd = s.sd, ab = s.ab, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; ab[0] = clk[0]; sd.advanceFrom(ab, 0); acc[0] += sd.lastNow; } } };
}
// MUST-BOX (>= 12): the pw=1 SCM copy of saAddMegaRot. A fractional now through the megamorphic
// callAdd site boxes at the boundary; the key is a Smi. Proves the SCM event-heavy lanes have teeth.
function scmAddMegaRot() {
    return { setup() { megamorphizeCallAdd(); const scm = new SlidingCountMin(32, { panes: 32, w: 128, d: 4, seed: 7 }); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
        for (let k = 0; k < 400; k++) { clk[0] += 1.5; callAdd(scm, clk[0], (k & 1023) + 1); } return { scm, clk, acc: new Float64Array(1) }; },
        hot(s, n) { const scm = s.scm, clk = s.clk, acc = s.acc; for (let i = 0; i < n; i++) { clk[0] += 1.5; callAdd(scm, clk[0], (i & 1023) + 1); acc[0] += scm.saturated; } } };
}

// --- H2-5 mega5: 5 distinct receiver maps (base + 4 empty subclasses) at ONE shared addFrom site.
// A megamorphic `o.addFrom(buf, i)` cannot inline; the callee's `this._now` (or first-field) double
// read then boxes ~16 B/op (a V8 property, family-wide). INFORMATIONAL -- band [m-4, m+4] around the
// measured HEAD value m. `callAFM` is the single shared site; each config fills buf per its layout. ---
function callAFM(o, buf, i) { return o.addFrom(buf, i); }
/** 5 distinct constructors (Base + 4 fresh empty subclasses) -> 5 maps -> the site goes megamorphic. */
function shapes5(Base) { class MA extends Base {} class MB extends Base {} class MC extends Base {} class MD extends Base {} return [Base, MA, MB, MC, MD]; }
// per-class mega5 addFrom config: make(Ctor)->instance; fill(buf, clk, i)->writes the op's slots.
const MEGA5_CFG = {
    eh: { base: ExponentialHistogram, make: (C) => new C(1000, 0.01), width: 2, clk: CLK_EPOCH, fill(buf, clk, i) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15] + 1; } },
    adwin: { base: ADWIN, make: (C) => new C(0.1), width: 1, clk: 0, fill(buf, clk, i) { buf[0] = FRAC[i & 15] + ((i >> 9) & 1) * 10; } },
    fd: { base: ForwardDecay, make: (C) => new C(1e9), width: 2, clk: CLK_EPOCH, fill(buf, clk, i) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15]; } },
    hk: { base: HeavyKeeper, make: (C) => new C(4, 512, 16, { seed: 4 }), width: 2, clk: 0, fill(buf, clk, i) { buf[0] = (i & 1023) + 1; buf[1] = (i & 7) + 1; } },
    shll: { base: SlidingHyperLogLog, make: (C) => new C(1000, { p: 10, ringCap: 8, seed: 3 }), width: 2, clk: CLK_EPOCH, fill(buf, clk, i) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((i * 2654435761) >>> 0) % 5000; } },
    dd: { base: DriftDetector, make: (C) => new C(DRIFT_PH, { delta: 0.005, threshold: 5 }), width: 1, clk: 0, fill(buf, clk, i) { buf[0] = FRAC[i & 15] + ((i >> 9) & 1) * 10; } },
    sdd: { base: SlidingDDSketch, make: (C) => new C(1000, { alpha: 0.01, panes: 8 }), width: 2, clk: CLK_EPOCH, fill(buf, clk, i) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15] + 1; } },
    scm: { base: SlidingCountMin, make: (C) => new C(1000, { panes: 8, w: 128, d: 4, seed: 7 }), width: 3, clk: CLK_EPOCH, fill(buf, clk, i) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = (i & 1023) + 1; buf[2] = 1; } },
    dr: { base: DecayedReservoir, make: (C) => new C(32, 1e5, { seed: 7 }), width: 2, clk: CLK_EPOCH, fill(buf, clk, i) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15]; } },
    sa: { base: SlidingAggregate, make: (C) => new C(1000, { panes: 8 }), width: 2, clk: CLK_EPOCH, fill(buf, clk, i) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15]; } },
};
function mega5AF(kind) {
    const cfg = MEGA5_CFG[kind];
    return {
        setup() {
            const ctors = shapes5(cfg.base);
            const insts = ctors.map((C) => cfg.make(C));
            const buf = new Float64Array(cfg.width);
            const clk = new Float64Array(1); clk[0] = cfg.clk;
            // megamorphize the callAFM site across all 5 maps (drive each with its own monotone clock).
            for (let i = 0; i < 4000; i++) { cfg.fill(buf, clk, i); callAFM(insts[i % 5], buf, 0); }
            return { insts, buf, clk, acc: new Float64Array(1) };
        },
        hot(s, n) { const insts = s.insts, buf = s.buf, clk = s.clk, acc = s.acc, fill = cfg.fill;
            for (let i = 0; i < n; i++) { fill(buf, clk, i); callAFM(insts[i % 5], buf, 0); acc[0] += 1; } },
    };
}

// ===========================================================================
// v1.11.0 READERS (ROADMAP 12.2 T3). The zero-alloc reader lanes for the two new members:
//   - SlidingHyperLogLog.countInto(out, w?)  -- q_shll_countInto (mono) + _poly4 (4-shape site)
//   - DriftDetector.into(out)                -- q_dd_into (mono) + _poly4 (4-shape site)
// Gate: steady B/op <= 0.5 fresh + warmed. TODO until batches 2 / 3 (the methods do not exist yet, so
// the AllocMatrix rows measure these INSIDE their todo subtest -- a missing method fails as todo, not
// hard). Plus mega5 INFO reader lanes and the DD six-getter MUST-BOX render control (~48 B). Every
// clock / key / value lives in a Float64Array slot; sinks accumulate into a slot (R3).
// ===========================================================================

// non-degenerate SHLL (thousands of distinct keys over a wide window) shared by the countInto lanes.
function buildShllNonDegenerate() {
    const sl = new SlidingHyperLogLog(100000, { p: 12, ringCap: 8, seed: 3 });
    const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
    for (let k = 0; k < 20000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((k * 2654435761) >>> 0); sl.addFrom(buf, 0); }
    if (!(sl.count() > 1000)) throw new Error('q_shll_countInto setup: sketch is degenerate (count=' + sl.count() + ')');
    return sl;
}
// SHLL countInto at a MONOMORPHIC site: nothing returned as a double (returns 1, a Smi) -> 0 B/op.
function qShllCountInto() {
    return { setup() { const sl = buildShllNonDegenerate(); const out = new Float64Array(1); return { sl, out, acc: new Float64Array(1) }; },
        hot(s, n) { const sl = s.sl, out = s.out, acc = s.acc; for (let i = 0; i < n; i++) { sl.countInto(out); acc[0] += out[0]; } } };
}
class SHLLSubA extends SlidingHyperLogLog {}
class SHLLSubB extends SlidingHyperLogLog {}
class SHLLSubC extends SlidingHyperLogLog {}
const SHLL_SHAPES4 = [SlidingHyperLogLog, SHLLSubA, SHLLSubB, SHLLSubC];
function callCountIntoP(o, out) { return o.countInto(out); }
// SHLL countInto at a POLYMORPHIC-4 site (4 subclass shapes): still inline-cacheable -> 0 B/op.
function qShllCountIntoPoly4() {
    return { setup() {
            const insts = SHLL_SHAPES4.map((C) => { const sl = new C(100000, { p: 12, ringCap: 8, seed: 3 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
                for (let k = 0; k < 20000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((k * 2654435761) >>> 0); sl.addFrom(buf, 0); } return sl; });
            const out = new Float64Array(1);
            for (let i = 0; i < 4000; i++) callCountIntoP(insts[i & 3], out);
            return { insts, out, acc: new Float64Array(1) }; },
        hot(s, n) { const insts = s.insts, out = s.out, acc = s.acc; for (let i = 0; i < n; i++) { callCountIntoP(insts[i & 3], out); acc[0] += out[0]; } } };
}

// a DD driven into a real, non-empty, fired PH statistic (fractional signal so the getters are doubles).
function buildDdFired(K) {
    const dd = new K(DRIFT_PH, { delta: 0.005, threshold: 5 });
    const buf = new Float64Array(1);
    for (let k = 0; k < 4000; k++) { buf[0] = (k % 1000 < 500 ? 0 : 10) + (k % 7) * 0.01; dd.addFrom(buf, 0); }
    return dd;
}
// DD into at a MONOMORPHIC site: returns 5 (a Smi), all five channels land in out slots -> 0 B/op.
function qDdInto() {
    return { setup() { const dd = buildDdFired(DriftDetector); const out = new Float64Array(5); return { dd, out, acc: new Float64Array(1) }; },
        hot(s, n) { const dd = s.dd, out = s.out, acc = s.acc; for (let i = 0; i < n; i++) { dd.into(out); acc[0] += out[0]; } } };
}
class DDSubA extends DriftDetector {}
class DDSubB extends DriftDetector {}
class DDSubC extends DriftDetector {}
const DD_SHAPES4 = [DriftDetector, DDSubA, DDSubB, DDSubC];
function callIntoDdP(o, out) { return o.into(out); }
// DD into at a POLYMORPHIC-4 site (4 subclass shapes): still inline-cacheable -> 0 B/op.
function qDdIntoPoly4() {
    return { setup() { const insts = DD_SHAPES4.map(buildDdFired); const out = new Float64Array(5);
            for (let i = 0; i < 4000; i++) callIntoDdP(insts[i & 3], out);
            return { insts, out, acc: new Float64Array(1) }; },
        hot(s, n) { const insts = s.insts, out = s.out, acc = s.acc; for (let i = 0; i < n; i++) { callIntoDdP(insts[i & 3], out); acc[0] += out[0]; } } };
}
// MUST-BOX render control: a demo-shaped render reading the DD scalar getters one by one and PACKING
// each into a TAGGED (non-typed) sink array -- the exact pattern the into() reader replaces (a panel
// materializes each value before formatting it). The ~48 B/op (3 boxes) comes from STORING the doubles
// INTO the tagged sink array, not from the getters themselves: a fractional double (statistic / mean /
// delta) boxes a ~16 B HeapNumber when it lands in a tagged-array slot, while the Smi-ish ones (count /
// lastDirection / a small lastDriftIndex) store unboxed. This is the into() foil -- it proves
// the reader probe SEES the per-store box into() avoids (into writes to a Float64Array, 0 B). Gated
// >= 12 (teeth). The SINK is a plain array (PACKED_ELEMENTS), so a double store boxes.
// A TAGGED (PACKED_ELEMENTS) sink -- seeding it with strings keeps the elements kind tagged (like
// N1_BOXARR), so a double store boxes a HeapNumber (a PACKED_DOUBLE array would store f64 unboxed).
const DD_RENDER_SINK = ['', '', '', '', '', ''];
function qDdSixGetter() {
    return { setup() { const dd = buildDdFired(DriftDetector); return { dd, acc: new Float64Array(1) }; },
        hot(s, n) { const dd = s.dd, acc = s.acc, R = DD_RENDER_SINK; for (let i = 0; i < n; i++) {
            R[0] = dd.statistic; R[1] = dd.mean; R[2] = dd.delta; R[3] = dd.lastDirection; R[4] = dd.lastDriftIndex; R[5] = dd.count;
            acc[0] += R[0] + R[3] + R[5]; } } };
}
// mega5 INFO reader lanes: countInto / into at a 5-map (megamorphic) site. A megamorphic reader call
// cannot inline; the callee's first double-field read boxes ~16 B/op (family-wide V8 property). INFO.
function shllShapes5() { class MA extends SlidingHyperLogLog {} class MB extends SlidingHyperLogLog {} class MC extends SlidingHyperLogLog {} class MD extends SlidingHyperLogLog {} return [SlidingHyperLogLog, MA, MB, MC, MD]; }
function callCountIntoM(o, out) { return o.countInto(out); }
function mega5ShllCountInto() {
    return { setup() { const insts = shllShapes5().map((C) => { const sl = new C(100000, { p: 12, ringCap: 8, seed: 3 }); const buf = new Float64Array(2); const clk = new Float64Array(1); clk[0] = CLK_EPOCH;
                for (let k = 0; k < 20000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((k * 2654435761) >>> 0); sl.addFrom(buf, 0); } return sl; });
            const out = new Float64Array(1); for (let i = 0; i < 4000; i++) callCountIntoM(insts[i % 5], out);
            return { insts, out, acc: new Float64Array(1) }; },
        hot(s, n) { const insts = s.insts, out = s.out, acc = s.acc; for (let i = 0; i < n; i++) { callCountIntoM(insts[i % 5], out); acc[0] += out[0]; } } };
}
function ddShapes5() { class MA extends DriftDetector {} class MB extends DriftDetector {} class MC extends DriftDetector {} class MD extends DriftDetector {} return [DriftDetector, MA, MB, MC, MD]; }
function callIntoDdM(o, out) { return o.into(out); }
function mega5DdInto() {
    return { setup() { const insts = ddShapes5().map(buildDdFired); const out = new Float64Array(5); for (let i = 0; i < 4000; i++) callIntoDdM(insts[i % 5], out);
            return { insts, out, acc: new Float64Array(1) }; },
        hot(s, n) { const insts = s.insts, out = s.out, acc = s.acc; for (let i = 0; i < n; i++) { callIntoDdM(insts[i % 5], out); acc[0] += out[0]; } } };
}

export const LANES = {
    n1, noop,
    // v1.11.0 readers (T3): countInto / into at mono + poly4 sites; mega5 INFO; the DD six-getter must-box.
    q_shll_countInto: qShllCountInto(),
    q_shll_countInto_poly4: qShllCountIntoPoly4(),
    q_dd_into: qDdInto(),
    q_dd_into_poly4: qDdIntoPoly4(),
    q_dd_sixgetter: qDdSixGetter(),
    mega5_shll_countInto: mega5ShllCountInto(),
    mega5_dd_into: mega5DdInto(),

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
    q_scm_totalInto_big: qScmTotalIntoBig(),
    q_scm_total_big: qScmTotalBig(),
    q_scm_totalInto_wint: qScmTotalIntoWint(),
    q_scm_totalInto_wfrac: qScmTotalIntoWfrac(),
    q_eh_sum: qEhSum(),
    q_hk_estimate: qHkEstimate(),
    q_hk_foreach: qHkForEach(),
    q_dr_sampleInto: qDrSampleInto(),

    // 1.8.0 doc-truth lanes: the two measured findings no library alloc gate saw before (SHLL count()
    // boxes; latched-PH fire boxes in Maglev).
    q_shll_count: qShllCount(),
    dd_latch_ph_fireheavy: ddLatchPhFireheavy(),

    // 1.9.0 SlidingAggregate (ADR 0012). addFrom matrix: clock x value, fresh + warmed.
    sa_af_now_small: saAF('now', 'small'),
    sa_af_now_frac: saAF('now', 'frac'),
    sa_af_now_neg149: saAF('now', 'neg149'),
    sa_af_now_max150: saAF('now', 'max150'),
    sa_af_epoch_small: saAF('epoch', 'small'),
    sa_af_epoch_frac: saAF('epoch', 'frac'),
    sa_af_epoch_neg149: saAF('epoch', 'neg149'),
    sa_af_epoch_max150: saAF('epoch', 'max150'),
    // event-heavy rotate-every-add epoch lanes (pw=1): the zero-box-per-rotation floor.
    sa_af_epoch_rot: saAfEpochRot(),
    sa_adv_epoch_rot: saAdvEpochRot(),
    // advance / advanceFrom / clear: 0 B/op.
    sa_advance: saAdvance(),
    sa_advanceFrom: saAdvanceFrom(),
    sa_clear: saClear(),
    // scalar readers (monomorphic site), band [0, 16.5].
    q_sa_count: qSaScalar('count'),
    q_sa_sum: qSaScalar('sum'),
    q_sa_mean: qSaScalar('mean'),
    q_sa_min: qSaScalar('min'),
    q_sa_max: qSaScalar('max'),
    // into: monomorphic + polymorphic-4 (<=0.5); megamorphic-5 (informational, band [12,20]).
    sa_into_mono: saIntoMono(),
    sa_into_poly4: saIntoPoly4(),
    sa_into_mega5: saIntoMega5(),
    // must-box controls (>= 12): mean over 5 maps; fractional add through the megamorphic callAdd site.
    q_sa_mean_mega: qSaMeanMega(),
    sa_add_mega_rot: saAddMegaRot(),

    // 1.10.0 H2 hardening (batch 1, T1). SCM/SDD event-heavy pw=1 rotate-every-op (H2-2 measurement);
    // the must-box SCM copy of saAddMegaRot; mega5_<cls>_af for all ten classes (H2-5, INFO).
    scm_af_epoch_rot: scmAfEpochRot(),
    scm_adv_epoch_rot: scmAdvEpochRot(),
    sdd_af_epoch_rot: sddAfEpochRot(),
    sdd_adv_epoch_rot: sddAdvEpochRot(),
    scm_add_mega_rot: scmAddMegaRot(),
    mega5_eh_af: mega5AF('eh'),
    mega5_adwin_af: mega5AF('adwin'),
    mega5_fd_af: mega5AF('fd'),
    mega5_hk_af: mega5AF('hk'),
    mega5_shll_af: mega5AF('shll'),
    mega5_dd_af: mega5AF('dd'),
    mega5_sdd_af: mega5AF('sdd'),
    mega5_scm_af: mega5AF('scm'),
    mega5_dr_af: mega5AF('dr'),
    mega5_sa_af: mega5AF('sa'),
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
    // SlidingAggregate: other W / panes, addFrom + add + advance + a reader.
    const sas = [new SlidingAggregate(200, { panes: 4 }), new SlidingAggregate(5000, { panes: 64 })];
    const saOut = new Float64Array(5);
    clk[0] = 1.7e12;
    for (let i = 0; i < nOps; i++) {
        clk[0] += 1.5; buf[0] = clk[0]; buf[1] = FRAC[i & 15];
        sas[i & 1].addFrom(buf, 0); sas[i & 1].add(clk[0] + 0.5, FRAC[i & 15] - 0.5);
        if ((i & 63) === 0) { sas[i & 1].into(saOut); acc[0] += saOut[0] + sas[i & 1].mean(); }
    }
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
