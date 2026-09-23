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
import { ExponentialHistogram, ADWIN } from '../../Adaptive.js';

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

// maxScavenges: the AUTHORITATIVE 0-B/op proof is test/torture.mjs (measureAllocs = 0 B/op on
// add count-mode AND explicit-time, gc major 0). This perf gate proves the other invariants
// strictly -- NO old-gen GC, NO arrayBuffer growth (grows delta 0: the fixed bucket pool never
// resizes), flat throughput, and the mustFail teeth catch a real allocator -- and allows a small
// scavenge floor. The EH hot body keeps every quantity a double in a preallocated Float64/Int32
// column (no boxing), so the floor is comfortably low; a regression trips the teeth immediately.
zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 16,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    // the ExponentialHistogram(1000, 0.01) pool is cap=366 buckets x (3 Float64 + 3 Int32) ~= 13 KB;
    // setup builds each scenario's state twice + harness overhead. grows delta 0 is the leak invariant.
    maxRetainedKB: 512,
    scenarios: [addCountStream, addTimeStream, adwinDriftStream],
    mustFail: [mustFailAlloc],
});
