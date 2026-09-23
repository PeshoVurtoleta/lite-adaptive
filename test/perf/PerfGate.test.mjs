// @zakkster/lite-adaptive -- the perf gate (repo-only; run:
//   node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs).
//
// The zero-GC allocation gate as a test: the ExponentialHistogram hot path -- add,
// INCLUDING the amortized merge cascade + expire sweep at a full, churning window --
// must run N + kN ops with 0 old-gen GC / 0 arrayBuffer growth (the bucket pool is
// fixed at construction, so `grows` -- a pool column's byte length -- shows a 0 delta)
// and flat throughput. A `mustFail` control that allocates per op MUST trip the gate,
// proving teeth.

import { zgcSuite } from '@zakkster/lite-perf-gate';
import { ExponentialHistogram } from '../../Adaptive.js';

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
    scenarios: [addCountStream, addTimeStream],
    mustFail: [mustFailAlloc],
});
