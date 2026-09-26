// @zakkster/lite-adaptive -- the perf gate (repo-only; run:
//   node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs).
//
// The zero-GC allocation gate as a test: the ExponentialHistogram hot path (add + the
// amortized merge cascade + expire sweep) AND the ADWIN hot path (add + the cut-scan +
// the drop-older shrink on a drifting stream) --
// must run N + kN ops with 0 old-gen GC / 0 arrayBuffer growth (the bucket pool is
// fixed at construction, so `grows` -- a pool column's byte length -- shows a 0 delta)
// and flat throughput. A `mustFail` control that allocates per op MUST trip the gate,
// proving teeth.

import { zgcSuite } from '@zakkster/lite-perf-gate';
import { ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog,
    DriftDetector, DRIFT_PH, DRIFT_CUSUM, SlidingDDSketch, SlidingCountMin,
    DecayedReservoir } from '../../Adaptive.js';

const W = 1000;
const EPS = 0.01;

/** Zero-alloc counter: the bucket-timestamp column's byte length -- fixed at construction. */
function grows(s) { return s.eh._ts.buffer.byteLength; }

/** add-stream count mode: auto-tick clock + open a bucket + merge cascade + expire, all in-pool. */
const addCountStream = {
    name: 'ExponentialHistogram add count-mode (open + merge cascade + expire, full window)',
    setup() {
        const eh = new ExponentialHistogram(W, EPS);
        for (let k = 0; k < 4 * W; k++) eh.add();   // prime to a full, churning window
        return { eh, sink: 0 };
    },
    hot(s, n) {
        const eh = s.eh;
        let sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            eh.add();
            sink = (sink + eh.bucketCount) | 0;     // observe state (defeat DCE)
        }
        s.sink = sink | 0;
    },
    statsOf(s) { return { grows: grows(s) }; },
};

/** add-stream explicit-time mode: a walking monotone `now` (the other hot entry). */
const addTimeStream = {
    name: 'ExponentialHistogram add explicit-time (monotone now, full window)',
    setup() {
        const eh = new ExponentialHistogram(W, EPS);
        let t = 0;
        for (let k = 0; k < 4 * W; k++) { t += 1; eh.add(t); }
        return { eh, t, sink: 0 };
    },
    hot(s, n) {
        const eh = s.eh;
        let t = s.t | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            t += 1;
            eh.add(t, 1);
            sink = (sink + eh.bucketCount) | 0;
        }
        s.t = t | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: grows(s) }; },
};

/**
 * EH addFrom on a FRACTIONAL packed [now, value] stream: the zero-box entry -- reads now +
 * value UNBOXED from a Float64Array(2) scratch instead of boxing two fractional arguments at
 * the call boundary. Same open + merge cascade + expire; must stay flat + 0 old-gen.
 */
const addFromStream = {
    name: 'ExponentialHistogram addFrom fractional [now,value] (zero-box open + cascade + expire)',
    setup() {
        const eh = new ExponentialHistogram(W, EPS);
        const buf = new Float64Array(2);
        const clk = new Float64Array(1);   // F4: the fractional clock lives in a slot, never a JS local
        for (let k = 0; k < 4 * W; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = k * 0.5 + 0.25; eh.addFrom(buf, 0); }
        return { eh, buf, clk, i: 4 * W, sink: 0 };
    },
    hot(s, n) {
        const eh = s.eh, buf = s.buf, clk = s.clk;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            clk[0] += 1.5;
            buf[0] = clk[0]; buf[1] = i * 0.5 + 0.25;
            eh.addFrom(buf, 0);
            i = (i + 1) | 0;
            sink = (sink + eh.bucketCount) | 0;      // observe state (defeat DCE)
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: grows(s) }; },
};

/** Zero-alloc counter for ADWIN: the sum column's byte length -- fixed at construction. */
function growsAd(s) { return s.ad._sum.buffer.byteLength; }

/**
 * ADWIN add on a DRIFTING stream: open a bucket + merge cascade + the cut-scan + the
 * drop-older SHRINK, all in-pool. The mean alternates every 512 items (integer levels ->
 * no arg boxing), which forces ADWIN to detect + shrink repeatedly -- the amortized
 * reshaping path that must stay flat + 0 old-gen.
 */
const adwinDriftStream = {
    name: 'ADWIN add drifting stream (open + merge cascade + cut-scan + drop-older shrink)',
    setup() {
        const ad = new ADWIN(0.1);
        for (let k = 0; k < 40000; k++) ad.add(((k >> 9) & 1) ? 1000 : 0);   // prime a churning window
        return { ad, i: 40000, sink: 0 };
    },
    hot(s, n) {
        const ad = s.ad;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            const cut = ad.add(((i >> 9) & 1) ? 1000 : 0);
            i = (i + 1) | 0;
            sink = (sink + (cut ? 1 : 0) + ad.bucketCount) | 0;   // observe state (defeat DCE)
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: growsAd(s) }; },
};

/**
 * ForwardDecay add on a REBASE-HEAVY explicit-time stream: lambda*(t-L) crosses FD_EXP_CAP
 * on every add, so the cold rebase branch (C *= f; Sv *= f; L = t) runs each op -- one exp()
 * + a rescale + two accumulations, all on scalars (no pool). The `grows` counter is a constant
 * 0: ForwardDecay allocates no TypedArray store at all. halfLife 0.01 -> lambda ~ 69.3, so a
 * step of just 11 gives arg ~ 762 > FD_EXP_CAP each add while `t` stays a small integer (smi)
 * across the whole run -- the plain-number monotone driver never boxes a HeapNumber (no int32
 * masking on a timestamp: a mask would wrap negative past 2^31 and break monotonicity).
 */
const fdAddStream = {
    name: 'ForwardDecay add rebase-heavy (exp + landmark rebase + two scalar accumulations)',
    setup() {
        const fd = new ForwardDecay(0.01);
        let t = 0;
        for (let k = 0; k < 4000; k++) { t += 11; fd.add(t, k & 7); }   // prime past the first rebase
        return { fd, t, sink: 0 };
    },
    hot(s, n) {
        const fd = s.fd;
        let t = s.t, sink = s.sink | 0;   // plain-number monotone time (stays smi at step 11)
        for (let i = 0; i < n; i++) {
            t += 11;
            fd.add(t, t & 7);
            sink = (sink + (fd.landmark === t ? 1 : 0)) | 0;   // observe the rebase (defeat DCE)
        }
        s.t = t; s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * FD addFrom on a FRACTIONAL packed [now, value] stream: the zero-box entry -- reads now +
 * value UNBOXED from a Float64Array(2) scratch. Large half-life so no rebase fires; one exp()
 * + two scalar accumulations. FD keeps no pool, so `grows` is a constant 0.
 */
const fdAddFromStream = {
    name: 'ForwardDecay addFrom fractional [now,value] (zero-box exp + two scalar accumulations)',
    setup() {
        const fd = new ForwardDecay(1e9);
        const buf = new Float64Array(2);
        const clk = new Float64Array(1);   // F4: the fractional clock lives in a slot, never a JS local
        for (let k = 0; k < 4000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = k * 0.5 + 0.25; fd.addFrom(buf, 0); }
        return { fd, buf, clk, i: 4000, sink: 0 };
    },
    hot(s, n) {
        const fd = s.fd, buf = s.buf, clk = s.clk;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            clk[0] += 1.5;
            buf[0] = clk[0]; buf[1] = i * 0.5 + 0.25;
            fd.addFrom(buf, 0);
            i = (i + 1) | 0;
            // F5: int-derived sink. `fd.landmark` is a double-returning getter that boxes a
            // 16 B HeapNumber per call; `fd.mode` returns a cached string constant (no box).
            sink = (sink + (fd.mode === 'explicit' ? 1 : 0)) | 0;   // observe state (defeat DCE)
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/** Zero-alloc counter for HeavyKeeper: the counts column's byte length -- fixed at construction. */
function growsHk(s) { return s.hk._cnt.buffer.byteLength; }

/**
 * HeavyKeeper add on a skewed integer stream: the two-lane hash + d cell touches (fp-hit
 * increment / fp-miss probabilistic decay via the seeded PRNG) + the intrusive forest sift,
 * all in-pool. Integer keys stay Smi (no key box), so this isolates the hot-body cost.
 */
const hkAddStream = {
    name: 'HeavyKeeper add skewed (two-lane hash + d cells + decay draw + forest sift)',
    setup() {
        const hk = new HeavyKeeper(4, 512, 16, { seed: 3 });
        for (let k = 0; k < 40000; k++) hk.add((k * 2654435761) % 4000, (k & 7) + 1);
        return { hk, i: 40000, sink: 0 };
    },
    hot(s, n) {
        const hk = s.hk;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            hk.add((i * 2654435761) % 4000, (i & 7) + 1);
            i = (i + 1) | 0;
            sink = (sink + hk.size) | 0;   // observe state (defeat DCE)
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: growsHk(s) }; },
};

/**
 * HeavyKeeper addFrom on LARGE u32 keys read UNBOXED from a packed [key, weight] Float64Array
 * -- the zero-box entry (a plain-arg add() would box a key >= 2^31). Same d cell touches +
 * decay + forest; must stay flat + 0 old-gen. F3 FIXED: the numeric inputs route through the
 * HK_KIN slot, so this is a hard gated scenario at maxScavenges 0 (no longer a `todo`).
 */
const hkAddFromStream = {
    name: 'HeavyKeeper addFrom large-u32 [key,weight] (zero-box hash + decay + forest)',
    setup() {
        const hk = new HeavyKeeper(4, 512, 16, { seed: 4 });
        const buf = new Float64Array(2);
        for (let k = 0; k < 40000; k++) { buf[0] = 4294967295 - ((k * 2654435761) % 4000); buf[1] = (k & 7) + 1; hk.addFrom(buf, 0); }
        return { hk, buf, i: 40000, sink: 0 };
    },
    hot(s, n) {
        const hk = s.hk, buf = s.buf;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            buf[0] = 4294967295 - ((i * 2654435761) % 4000);
            buf[1] = (i & 7) + 1;
            hk.addFrom(buf, 0);
            i = (i + 1) | 0;
            sink = (sink + hk.size) | 0;   // observe state (defeat DCE)
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: growsHk(s) }; },
};

/** Zero-alloc counter for SlidingHyperLogLog: the stamps ring column's byte length -- fixed at construction. */
function growsSl(s) { return s.sl._stamps.buffer.byteLength; }

/**
 * SlidingHyperLogLog add on an explicit-time SMI stream: the inline two-lane murmur + the LFPM
 * ring push (pop dominated tail entries, append) over a full, churning window. SMI now + key ->
 * no argument box, so this isolates the hot-body cost.
 */
const slAddStream = {
    name: 'SlidingHyperLogLog add explicit-time (two-lane hash + LFPM domination drop + append)',
    setup() {
        const sl = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 2 });
        let t = 0;
        for (let k = 0; k < 4000; k++) sl.add(t++, (k * 2654435761) % 3000);   // prime a churning window
        return { sl, t, sink: 0 };
    },
    hot(s, n) {
        const sl = s.sl;
        let t = s.t | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            sl.add(t, (t * 2654435761) % 3000);
            t = (t + 1) | 0;
            sink = (sink + sl.overflows) | 0;   // observe state (defeat DCE)
        }
        s.t = t | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: growsSl(s) }; },
};

/**
 * SlidingHyperLogLog add in COUNT mode (add(undefined, key), auto-tick): the "last N items"
 * windowed-distinct convenience. Same hash + LFPM ring push; must stay flat + 0 old-gen.
 */
const slAddCountStream = {
    name: 'SlidingHyperLogLog add count-mode (auto-tick + hash + LFPM ring push, full window)',
    setup() {
        const sl = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 6 });
        for (let k = 0; k < 4000; k++) sl.add(undefined, (k * 2654435761) % 3000);
        return { sl, i: 4000, sink: 0 };
    },
    hot(s, n) {
        const sl = s.sl;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            sl.add(undefined, (i * 2654435761) % 3000);
            i = (i + 1) | 0;
            sink = (sink + sl.overflows) | 0;   // observe state (defeat DCE)
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: growsSl(s) }; },
};

/**
 * SlidingHyperLogLog addFrom on a packed [now, key] Float64Array with an epoch-ms `now` (a
 * non-Smi double) + LARGE keys (near 2^53-1) read UNBOXED -- the zero-box entry (a plain-arg add()
 * would box both). Same hash + LFPM ring push; must stay flat + 0 old-gen.
 */
const slAddFromStream = {
    name: 'SlidingHyperLogLog addFrom epoch-ms + large key (zero-box hash + LFPM ring push)',
    setup() {
        const sl = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 3 });
        const buf = new Float64Array(2);
        let now = 1.75e12;
        for (let k = 0; k < 4000; k++) { now += 1; buf[0] = now; buf[1] = 9007199254740000 - ((k * 2654435761) % 3000); sl.addFrom(buf, 0); }
        return { sl, buf, now, i: 0, sink: 0 };
    },
    hot(s, n) {
        const sl = s.sl, buf = s.buf;
        let now = s.now, i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            now += 1;
            buf[0] = now;
            buf[1] = (i & 1) ? (9007199254740000 - ((i * 2654435761) % 3000)) : (-(2 ** 31) + ((i * 40503) % 3000));
            sl.addFrom(buf, 0);
            i = (i + 1) | 0;
            sink = (sink + sl.overflows) | 0;   // observe state (defeat DCE)
        }
        s.now = now; s.i = i | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: growsSl(s) }; },
};

/**
 * DriftDetector add on a DRIFTING stream, PH mode: update the running mean + the Page-Hinkley
 * branch (cumulative deviation vs the running extreme) + the reset on a fire, all on scalars (no
 * pool). The mean alternates every 512 items (integer -> no arg boxing), forcing repeated fires ->
 * the reset path runs and must stay flat + 0 old-gen. `grows` is a constant 0 (no TypedArray store).
 */
const ddPhStream = {
    name: 'DriftDetector add PH drifting stream (running mean + Page-Hinkley branch + reset on fire)',
    setup() {
        const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 });
        for (let k = 0; k < 40000; k++) dd.add(((k >> 9) & 1) ? 1000 : 0);   // prime a drifting stream
        return { dd, i: 40000, sink: 0 };
    },
    hot(s, n) {
        const dd = s.dd;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            const cut = dd.add(((i >> 9) & 1) ? 1000 : 0);
            i = (i + 1) | 0;
            sink = (sink + (cut ? 1 : 0) + (dd.count & 255)) | 0;   // observe state (defeat DCE)
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * DriftDetector add on a DRIFTING stream, CUSUM mode: the other mode branch (two floored
 * accumulators vs a FIXED target) + the reset on a fire. target=500 sits between the two regimes so
 * both directions depart + fire. Same drifting stream; must stay flat + 0 old-gen.
 */
const ddCusumStream = {
    name: 'DriftDetector add CUSUM drifting stream (running mean + two floored accumulators + reset on fire)',
    setup() {
        const dd = new DriftDetector(DRIFT_CUSUM, { delta: 0.005, threshold: 5, target: 500 });
        for (let k = 0; k < 40000; k++) dd.add(((k >> 9) & 1) ? 1000 : 0);
        return { dd, i: 40000, sink: 0 };
    },
    hot(s, n) {
        const dd = s.dd;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            const cut = dd.add(((i >> 9) & 1) ? 1000 : 0);
            i = (i + 1) | 0;
            sink = (sink + (cut ? 1 : 0) + (dd.count & 255)) | 0;   // observe state (defeat DCE)
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/** Zero-alloc counter for SlidingDDSketch: the bins column's byte length -- fixed at construction. */
function growsSd(s) { return s.sd._bins.buffer.byteLength; }

/**
 * SlidingDDSketch add on an explicit-time positive stream: the log-bucket key + pane rotate/clear +
 * the current-pane increment (and the cold collapse tail), over a full, churning window so every
 * measured add periodically crosses a pane boundary (rotate + clear must stay flat + 0 old-gen).
 */
const sdAddStream = {
    name: 'SlidingDDSketch add explicit-time (log-bucket key + pane rotate/clear + increment)',
    setup() {
        const sd = new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 });
        let t = 0;
        for (let k = 0; k < 4000; k++) sd.add(t++, ((k * 2654435761) % 9973) + 1);
        return { sd, t, sink: 0 };
    },
    hot(s, n) {
        const sd = s.sd;
        let t = s.t | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            sd.add(t, ((t * 2654435761) % 9973) + 1);
            t = (t + 1) | 0;
            sink = (sink + (sd.collapsed ? 1 : 0)) | 0;   // observe state (defeat DCE)
        }
        s.t = t | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: growsSd(s) }; },
};

/**
 * SlidingDDSketch addFrom on a packed [now, value] Float64Array with an epoch-ms `now` (a non-Smi
 * double) + a FRACTIONAL value read UNBOXED -- the zero-box entry (a plain-arg add would box both).
 * Same key + pane rotate/clear + increment; must stay flat + 0 old-gen.
 */
const sdAddFromStream = {
    name: 'SlidingDDSketch addFrom epoch-ms + fractional value (zero-box key + pane rotate/clear)',
    setup() {
        const sd = new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 });
        const buf = new Float64Array(2);
        const clk = new Float64Array(1); clk[0] = 1.75e12;   // F4: epoch-ms clock in a slot, never a JS local
        for (let k = 0; k < 4000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((k * 40503) % 9973) + 0.5; sd.addFrom(buf, 0); }
        return { sd, buf, clk, i: 0, sink: 0 };
    },
    hot(s, n) {
        const sd = s.sd, buf = s.buf, clk = s.clk;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            clk[0] += 1.5;
            buf[0] = clk[0]; buf[1] = ((i * 40503) % 9973) + 0.5;
            sd.addFrom(buf, 0);
            i = (i + 1) | 0;
            sink = (sink + (sd.collapsed ? 1 : 0)) | 0;   // observe state (defeat DCE)
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: growsSd(s) }; },
};

/**
 * The teeth for the SlidingDDSketch lane: add + a fresh escaping array per op -- it MUST trip the
 * gate, proving the SlidingDDSketch scenarios' flat result is a real 0-alloc measurement.
 */
const sdMustFailAlloc = {
    name: 'SlidingDDSketch add + a fresh escaping array per op (MUST allocate)',
    setup() {
        const sd = new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 });
        let t = 0;
        for (let k = 0; k < 4000; k++) sd.add(t++, ((k * 2654435761) % 9973) + 1);
        return { sd, t, leak: null, sink: 0 };
    },
    hot(s, n) {
        const sd = s.sd;
        let t = s.t | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            sd.add(t, ((t * 2654435761) % 9973) + 1);
            t = (t + 1) | 0;
            const arr = new Array(64);
            arr[0] = t;
            s.leak = arr;
            sink = (sink + arr[0]) | 0;
        }
        s.t = t | 0; s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The teeth for the DriftDetector lane: add + a fresh escaping array per op -- it MUST trip the
 * gate, proving the DriftDetector scenarios' flat result is a real 0-alloc measurement.
 */
const ddMustFailAlloc = {
    name: 'DriftDetector add + a fresh escaping array per op (MUST allocate)',
    setup() {
        const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 });
        for (let k = 0; k < 40000; k++) dd.add(((k >> 9) & 1) ? 1000 : 0);
        return { dd, i: 40000, leak: null, sink: 0 };
    },
    hot(s, n) {
        const dd = s.dd;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            dd.add(((i >> 9) & 1) ? 1000 : 0);
            i = (i + 1) | 0;
            const arr = new Array(64);
            arr[0] = i;
            s.leak = arr;
            sink = (sink + arr[0]) | 0;
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The teeth for the SlidingHyperLogLog lane: add + a fresh escaping array per op -- it MUST trip
 * the gate, proving the SlidingHyperLogLog scenarios' flat result is a real 0-alloc measurement.
 */
const slMustFailAlloc = {
    name: 'SlidingHyperLogLog add + a fresh escaping array per op (MUST allocate)',
    setup() {
        const sl = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 2 });
        let t = 0;
        for (let k = 0; k < 4000; k++) sl.add(t++, (k * 2654435761) % 3000);
        return { sl, t, leak: null, sink: 0 };
    },
    hot(s, n) {
        const sl = s.sl;
        let t = s.t | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            sl.add(t, (t * 2654435761) % 3000);
            t = (t + 1) | 0;
            const arr = new Array(64);
            arr[0] = t;
            s.leak = arr;
            sink = (sink + arr[0]) | 0;
        }
        s.t = t | 0; s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * CONTROL (the F3 argument boundary, expected-boxing): HeavyKeeper.add with a LARGE u32 key (>=
 * 2^31) passed as a PLAIN argument. Unlike addFrom -- which reads the key UNBOXED from a
 * Float64Array slot (0 B/op) -- a large key crosses the non-inlined add() call boundary as a ~16 B
 * HeapNumber EACH op. This is exactly why addFrom exists; it MUST trip the gate at maxScavenges 0,
 * documenting that the argument-boundary box is real (and is NOT what the F3 fix addresses -- the
 * fix removes the box on addFrom + on every internal call, never on the public add(largeKey) arg).
 */
const hkPlainAddLargeKeyControl = {
    name: 'HeavyKeeper add large-u32 key as a plain argument (CONTROL: MUST box ~16 B at the arg boundary)',
    setup() {
        const hk = new HeavyKeeper(4, 512, 16, { seed: 5 });
        for (let k = 0; k < 40000; k++) hk.add((2 ** 31) + ((k * 2654435761) % 4000), (k & 7) + 1);
        return { hk, i: 40000, sink: 0 };
    },
    hot(s, n) {
        const hk = s.hk;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            hk.add((2 ** 31) + ((i * 2654435761) % 4000), (i & 7) + 1);   // large key -> boxed arg
            i = (i + 1) | 0;
            sink = (sink + hk.size) | 0;   // observe state (defeat DCE)
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The teeth for the HeavyKeeper lane: add + a fresh escaping array per op -- it MUST trip the
 * gate, proving the HeavyKeeper scenarios' flat result is a real 0-alloc measurement.
 */
const hkMustFailAlloc = {
    name: 'HeavyKeeper add + a fresh escaping array per op (MUST allocate)',
    setup() {
        const hk = new HeavyKeeper(4, 512, 16, { seed: 3 });
        for (let k = 0; k < 40000; k++) hk.add((k * 2654435761) % 4000, 1);
        return { hk, i: 40000, leak: null, sink: 0 };
    },
    hot(s, n) {
        const hk = s.hk;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            hk.add((i * 2654435761) % 4000, 1);
            i = (i + 1) | 0;
            const arr = new Array(64);
            arr[0] = i;
            s.leak = arr;
            sink = (sink + arr[0]) | 0;
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The teeth: a per-op call that builds a FRESH array each op -- it MUST trip the gate
 * (scavenges scale with n), proving the instrument catches a real allocation.
 */
const mustFailAlloc = {
    name: 'ExponentialHistogram add + a fresh escaping array per op (MUST allocate)',
    setup() {
        const eh = new ExponentialHistogram(W, EPS);
        for (let k = 0; k < 4 * W; k++) eh.add();
        return { eh, leak: null, sink: 0 };
    },
    hot(s, n) {
        const eh = s.eh;
        let sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            eh.add();
            const arr = new Array(64);
            arr[0] = i;
            s.leak = arr;
            sink = (sink + arr[0]) | 0;
        }
        s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The teeth for the ForwardDecay lane: add + a fresh escaping array per op -- it MUST trip
 * the gate, proving the FD scenario's flat result is a real 0-alloc measurement.
 */
const fdMustFailAlloc = {
    name: 'ForwardDecay add + a fresh escaping array per op (MUST allocate)',
    setup() {
        const fd = new ForwardDecay(1e9);
        let t = 0;
        for (let k = 0; k < 4000; k++) { t += 1; fd.add(t, 1); }
        return { fd, t, leak: null, sink: 0 };
    },
    hot(s, n) {
        const fd = s.fd;
        let t = s.t, sink = s.sink | 0;   // plain-number monotone time
        for (let i = 0; i < n; i++) {
            t += 1;
            fd.add(t, 1);
            const arr = new Array(64);
            arr[0] = i;
            s.leak = arr;
            sink = (sink + arr[0]) | 0;
        }
        s.t = t; s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/** Zero-alloc counter for SlidingCountMin: the cells column's byte length -- fixed at construction. */
function growsScm(s) { return s.scm._cells.buffer.byteLength; }

/**
 * SlidingCountMin add on an explicit-time key stream: the two-lane hash + pane rotate/clear + the
 * per-pane conservative update, over a full, churning window so every measured add periodically crosses
 * a pane boundary (rotate + clear must stay flat + 0 old-gen).
 */
const scmAddStream = {
    name: 'SlidingCountMin add explicit-time (two-lane hash + pane rotate/clear + conservative update)',
    setup() {
        const scm = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 3 });
        let t = 0;
        for (let k = 0; k < 4000; k++) scm.add(t++, ((k * 2654435761) >>> 0) % 5000);
        return { scm, t, sink: 0 };
    },
    hot(s, n) {
        const scm = s.scm;
        let t = s.t | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            scm.add(t, ((t * 2654435761) >>> 0) % 5000);
            t = (t + 1) | 0;
            sink = (sink + scm.saturated) | 0;   // observe state (defeat DCE)
        }
        s.t = t | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: growsScm(s) }; },
};

/**
 * SlidingCountMin addFrom on a packed stride-3 [now, key, count] Float64Array with an epoch-ms `now` (a
 * non-Smi double) read UNBOXED -- the zero-box entry (a plain-arg add would box all three). Same hash +
 * pane rotate/clear + conservative update; must stay flat + 0 old-gen.
 */
const scmAddFromStream = {
    name: 'SlidingCountMin addFrom epoch-ms stride-3 [now,key,count] (zero-box + pane rotate/clear)',
    setup() {
        const scm = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 });
        const buf = new Float64Array(3);
        const clk = new Float64Array(1); clk[0] = 1.75e12;   // F4: epoch-ms clock in a slot, never a JS local
        for (let k = 0; k < 4000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((k * 2654435761) >>> 0) % 5000; buf[2] = (k & 7) + 1; scm.addFrom(buf, 0); }
        return { scm, buf, clk, i: 0, sink: 0 };
    },
    hot(s, n) {
        const scm = s.scm, buf = s.buf, clk = s.clk;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            clk[0] += 1.5;
            buf[0] = clk[0]; buf[1] = ((i * 2654435761) >>> 0) % 5000; buf[2] = (i & 7) + 1;
            scm.addFrom(buf, 0);
            i = (i + 1) | 0;
            sink = (sink + scm.saturated) | 0;
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: growsScm(s) }; },
};

/**
 * The teeth for the SlidingCountMin lane: add + a fresh escaping array per op -- it MUST trip the gate,
 * proving the SlidingCountMin scenarios' flat result is a real 0-alloc measurement.
 */
const scmMustFailAlloc = {
    name: 'SlidingCountMin add + a fresh escaping array per op (MUST allocate)',
    setup() {
        const scm = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 3 });
        let t = 0;
        for (let k = 0; k < 4000; k++) scm.add(t++, ((k * 2654435761) >>> 0) % 5000);
        return { scm, t, leak: null, sink: 0 };
    },
    hot(s, n) {
        const scm = s.scm;
        let t = s.t | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            scm.add(t, ((t * 2654435761) >>> 0) % 5000);
            t = (t + 1) | 0;
            const arr = new Array(64);
            arr[0] = t;
            s.leak = arr;
            sink = (sink + arr[0]) | 0;
        }
        s.t = t | 0; s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/** Zero-alloc counter for DecayedReservoir: the value column's byte length -- fixed at construction. */
function growsDr(s) { return s.dr._val.buffer.byteLength; }

/**
 * DecayedReservoir add on an explicit-time value stream: the A-Res xorshift32 draw + the log-space key
 * + the size-k min-forest sift + the periodic order-preserving landmark rebase, over a full sample so
 * every measured add draws, keys, and sifts (admit-or-drop). Must stay flat + 0 old-gen.
 */
const drAddStream = {
    name: 'DecayedReservoir add explicit-time (A-Res draw + log-space key + min-forest sift)',
    setup() {
        const dr = new DecayedReservoir(32, 100000, { seed: 3 });
        let t = 0;
        for (let k = 0; k < 4000; k++) dr.add(t++, k & 63);
        return { dr, t, sink: 0 };
    },
    hot(s, n) {
        const dr = s.dr;
        let t = s.t | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            dr.add(t, t & 63);
            t = (t + 1) | 0;
            sink = (sink + dr.size) | 0;   // observe state (defeat DCE)
        }
        s.t = t | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: growsDr(s) }; },
};

/**
 * DecayedReservoir addFrom on a packed stride-2 [now, value] Float64Array with an epoch-ms `now` (a
 * non-Smi double) read UNBOXED -- the zero-box entry (a plain-arg add would box both). Same A-Res draw
 * + key + forest sift + rebase; must stay flat + 0 old-gen.
 */
const drAddFromStream = {
    name: 'DecayedReservoir addFrom epoch-ms stride-2 [now,value] (zero-box + A-Res draw + forest sift)',
    setup() {
        const dr = new DecayedReservoir(32, 100000, { seed: 7 });
        const buf = new Float64Array(2);
        const clk = new Float64Array(1); clk[0] = 1.75e12;   // F4: epoch-ms clock in a slot, never a JS local
        for (let k = 0; k < 4000; k++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = k & 63; dr.addFrom(buf, 0); }
        return { dr, buf, clk, i: 0, sink: 0 };
    },
    hot(s, n) {
        const dr = s.dr, buf = s.buf, clk = s.clk;
        let i = s.i | 0, sink = s.sink | 0;
        for (let j = 0; j < n; j++) {
            clk[0] += 1.5;
            buf[0] = clk[0]; buf[1] = i & 63;
            dr.addFrom(buf, 0);
            i = (i + 1) | 0;
            sink = (sink + dr.size) | 0;
        }
        s.i = i | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: growsDr(s) }; },
};

/**
 * The teeth for the DecayedReservoir lane: add + a fresh escaping array per op -- it MUST trip the gate,
 * proving the DecayedReservoir scenarios' flat result is a real 0-alloc measurement.
 */
const drMustFailAlloc = {
    name: 'DecayedReservoir add + a fresh escaping array per op (MUST allocate)',
    setup() {
        const dr = new DecayedReservoir(32, 100000, { seed: 3 });
        let t = 0;
        for (let k = 0; k < 4000; k++) dr.add(t++, k & 63);
        return { dr, t, leak: null, sink: 0 };
    },
    hot(s, n) {
        const dr = s.dr;
        let t = s.t | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            dr.add(t, t & 63);
            t = (t + 1) | 0;
            const arr = new Array(64);
            arr[0] = t;
            s.leak = arr;
            sink = (sink + arr[0]) | 0;
        }
        s.t = t | 0; s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * N1 (ROADMAP 7 N1): the calibrated must-fail control -- boxes EXACTLY ONE 16 B HeapNumber per op.
 * A Float64Array-slot clock steps by 1.0 from 0.5, so every value is x.5 (never integral, never a
 * Smi), and storing it into a PACKED_ELEMENTS array allocates one HeapNumber each op. AllocProbe
 * reads it at ~16.0 B/op and >= 10 scavenges at 8N; it MUST FAIL the gate at maxScavenges 0. This
 * replaces the `new Array(64)` teeth as the primary control: at ~16 B/op it is the same order of
 * magnitude as a single library box (F3), not ~30x it, so the gate's teeth match the signal.
 */
const N1_BOXARR = [{}, 0];   // PACKED_ELEMENTS: storing a non-integral double allocates a 16 B HeapNumber
const n1OneBoxControl = {
    name: 'N1 one 16 B HeapNumber per op (x.5 slot clock -> PACKED_ELEMENTS store, MUST allocate)',
    setup() { const v = new Float64Array(1); v[0] = 0.5; return { v, sink: 0 }; },
    hot(s, n) {
        const v = s.v;
        let sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            v[0] += 1.0;               // x.5 every op -> a HeapNumber, never a Smi
            N1_BOXARR[1] = v[0];       // the one box: a double store into a PACKED_ELEMENTS array
            sink = (sink + (N1_BOXARR[0] === null ? 0 : 1)) | 0;
        }
        s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

// maxScavenges: SETTLE S6 (ROADMAP 7.2) -- gate a TRUE 0 B/op at steady state (the minimum over
// >= 4 windows) with BOTH semi-space flags pinned (--min-semi-space-size=4 AND
// --max-semi-space-size=4, wired in package.json test:perf). The first window after warm-up may run
// Maglev code and box where the Turbofan steady state reads 0; it is printed, never a floor. The
// AUTHORITATIVE 0-B/op proof remains test/torture.mjs (measureAllocs = 0 B/op, gc major 0). This
// perf gate proves the other invariants strictly -- NO old-gen GC, NO arrayBuffer growth (grows
// delta 0: the fixed bucket pool never resizes), flat throughput -- and the mustFail teeth (N1 +
// per-member + the HK plain-add large-key argument-boundary control) catch a real allocator at
// maxScavenges 0. hkAddFromStream (HK addFrom large-u32) was F3; the fix routes its numeric inputs
// through the HK_KIN slot, so it is now a HARD gated scenario here at maxScavenges 0.
zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 0,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    // the ExponentialHistogram(1000, 0.01) pool is cap=366 buckets x (3 Float64 + 3 Int32) ~= 13 KB;
    // setup builds each scenario's state twice + harness overhead. grows delta 0 is the leak invariant.
    maxRetainedKB: 512,
    scenarios: [
        addCountStream, addTimeStream, adwinDriftStream, fdAddStream, addFromStream, fdAddFromStream,
        hkAddStream, hkAddFromStream, slAddStream, slAddCountStream, slAddFromStream,
        ddPhStream, ddCusumStream, sdAddStream, sdAddFromStream, scmAddStream, scmAddFromStream,
        drAddStream, drAddFromStream,
    ],
    mustFail: [n1OneBoxControl, hkPlainAddLargeKeyControl, mustFailAlloc, fdMustFailAlloc,
        hkMustFailAlloc, slMustFailAlloc, ddMustFailAlloc, sdMustFailAlloc, scmMustFailAlloc,
        drMustFailAlloc],
});
