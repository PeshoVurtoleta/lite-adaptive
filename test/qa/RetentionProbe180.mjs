// @zakkster/lite-adaptive -- 1.8.0 QA retention probe (child of test/Retention.qa180.test.js; needs
// node --expose-gc). 10 cycles x 50 instances EACH of: SlidingCountMin (adds + total(w) + estimateInto
// reads, incl. a Proxy keys array), DriftDetector latch (PH + CUSUM, regime-alternating, add + addFrom),
// and HeavyKeeper (large / negative keys, add + addFrom). Every instance is tracked by lite-leak with a
// cleanup that does NOT close over the target, cleared, then dropped. Prints ONE JSON line:
// { live, findings, heap: [heapUsed after each cycle], spread } -- the parent test gates it.
import { createLeakTracker } from '@zakkster/lite-leak';
import { SlidingCountMin, DriftDetector, DRIFT_PH, DRIFT_CUSUM, HeavyKeeper } from '../../Adaptive.js';

if (typeof globalThis.gc !== 'function') { console.log(JSON.stringify({ error: 'no --expose-gc' })); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tracker = createLeakTracker();
const noop = () => {};
const CYCLES = 10, PER = 50;
const keys = new Float64Array(64), out = new Float64Array(64), buf = new Float64Array(3);
for (let j = 0; j < 64; j++) keys[j] = (j & 1 ? 2 ** 31 + j : -(2 ** 31) - j) + (j % 3 === 0 ? 2 ** 40 : 0);
const sink = new Float64Array(1);

function cycle(c) {
    for (let k = 0; k < PER; k++) {
        const scm = new SlidingCountMin(1000, { panes: 8, w: 256, d: 4, seed: k + 1 });
        for (let i = 0; i < 400; i++) {
            if (i & 1) scm.add(i * 3, keys[i & 63], 1 + (i & 7));
            else { buf[0] = i * 3; buf[1] = keys[(i * 7) & 63]; buf[2] = 2; scm.addFrom(buf, 0); }
        }
        sink[0] += scm.total() + scm.total(250) + scm.estimateInto(keys, out) + out[5];
        scm.estimateInto(keys, out, 500);
        const px = new Proxy(keys, { get(t, p) { const v = Reflect.get(t, p); return typeof v === 'function' ? v.bind(t) : v; } });
        scm.estimateInto(px, out);
        sink[0] += out[1];
        tracker.track(scm, noop, 'scm', { audit: true });
        scm.clear();

        for (const [m, ex] of [[DRIFT_PH, {}], [DRIFT_CUSUM, { target: 0 }]]) {
            const dd = new DriftDetector(m, { ...ex, latch: true, threshold: 20 });
            const b1 = new Float64Array(1);
            for (let i = 0; i < 2000; i++) {
                const x = ((i / 250) | 0) & 1 ? 10.5 : -10.5;
                if (i % 3 === 0) { b1[0] = x; dd.addFrom(b1, 0); } else dd.add(x);
            }
            sink[0] += dd.lastDriftIndex + dd.lastDirection;
            tracker.track(dd, noop, 'dd', { audit: true });
            dd.clear();
        }

        const hk = new HeavyKeeper(4, 128, 16, { seed: c * PER + k + 1 });
        const hb = new Float64Array(2);
        for (let i = 0; i < 1000; i++) {
            const key = keys[i & 63] + (i % 5 === 0 ? 2 ** 52 : 0);
            if (i & 1) hk.add(key, 1 + (i & 3)); else { hb[0] = key; hb[1] = 4294967295; hk.addFrom(hb, 0); }
        }
        sink[0] += hk.estimate(keys[3]);
        tracker.track(hk, noop, 'hk', { audit: true });
        hk.clear();
    }
}

const heap = [];
for (let c = 0; c < CYCLES; c++) {
    cycle(c);
    for (let g = 0; g < 4; g++) { globalThis.gc(); await sleep(10); }
    heap.push(process.memoryUsage().heapUsed);
}
let live = tracker.size();
for (let g = 0; g < 20 && live > 0; g++) { globalThis.gc(); await sleep(25); live = tracker.size(); }
const findings = tracker.audit().length;
const steady = heap.slice(1);   // cycle 0 = warm-up (JIT code, lazily-built shared tables)
const spread = Math.max(...steady) - Math.min(...steady);
console.log(JSON.stringify({ live, findings, tracked: CYCLES * PER * 4, heap, spread, sinkFinite: Number.isFinite(sink[0]) }));
