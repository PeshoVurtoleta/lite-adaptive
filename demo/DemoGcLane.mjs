// @zakkster/lite-adaptive -- DemoGcLane (repo-only measurement tool; NOT a node:test file).
//
// The per-scene 0-major-GC sketch-path lane, run ONE lane per FRESH child process. Demo.test.mjs
// spawns it (runGcLane) and asserts on the JSON it prints; it never runs the 200k-frame loop in the
// test-runner process itself.
//
// WHY A CHILD (measured 2026-10-04, see ROADMAP ledger "GC-lane isolation"): run in-process at the end
// of Demo.test.mjs, the lane measured the TEST FILE, not the sketch path --
//   1. JIT tier state: earlier tests' worlds die, V8 throws away the optimized renderEhPrep / count() /
//      sum() code ("embedded weak objects cleared"), and the old 313-render warm-up did not re-tier it,
//      so the window measured baseline-tier code boxing every double (~870 B per renderEhPrep, 2.7 MB
//      per lane; EH / HK / DD / DR saw 2..7 minor GCs that read 0 in isolation).
//   2. Async backlog: ~740 queued 'gc' perf entries from the measureAllocs tests (plus node:test's own
//      async bookkeeping) were delivered INSIDE the window's 50 ms tail, allocating -> more minors.
//   3. The in-loop `process.memoryUsage()` sample branch deopted the OSR'd hot loop every 8192 frames.
// Under the 4-file parallel `npm run demo`, CPU contention then stretched one of those minors past the
// 4 ms pause limit (EH 15.87 ms, HK 9.57 ms). A fresh isolate has none of 1-3: the window holds 0 GC
// events, so no wall-clock stretch can push a pause over the limit -- and the lane can gate maxMinor: 0.
//
// Run one lane by hand:   node --expose-gc demo/DemoGcLane.mjs EH
// RULE: this file allocates freely OUTSIDE the window; inside the window only hotChunk() runs, plus one
// process.memoryUsage() per 8192-frame chunk (~180 B, written into a preallocated Float64Array and
// replayed into the profiler AFTER the window closes).

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';
import {
    createAllocState,
    createEhWorld, stepEh, renderEhPrep, EH_DEFAULT_W, EH_DEFAULT_EPS, E_SKETCH_ALLOC,
    createAdWorld, stepAd, renderAdPrep, AD_DEFAULT_DELTA, A_SKETCH_ALLOC,
    createFdWorld, stepFd, stepFdOracle, renderFdPrep, FD_DEFAULT_HALFLIFE, D_SKETCH_ALLOC,
    createHkWorld, stepHk, stepHkOracle, renderHkPrep, HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, H_SKETCH_ALLOC,
    createShllWorld, stepShll, stepShllOracle, renderShllPrep,
    SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, S_SKETCH_ALLOC,
    createDdWorld, stepDd, renderDdPrep, DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD, G_SKETCH_ALLOC,
    createSldWorld, stepSld, stepSldOracle, renderSldPrep, SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, Q_SKETCH_ALLOC,
    createScmWorld, stepScm, stepScmOracle, renderScmPrep, SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, C_SKETCH_ALLOC,
    createDrWorld, stepDr, renderDrPrep, DR_DEFAULT_K, DR_DEFAULT_HALFLIFE, R_SKETCH_ALLOC,
} from './kernels.mjs';

const SELF = fileURLToPath(import.meta.url);

/** The window: HOT stepX frames, renderXPrep every 64th, one heap sample per CHUNK frames. */
export const GC_LANE_HOT = 200000;
const CHUNK = 8192;
const N_CHUNKS = Math.ceil(GC_LANE_HOT / CHUNK);
/** Warm-up before the window (outside it): same cadence, enough renders to reach the steady tier. */
const WARM_FRAMES = 20000;
const WARM_ROUNDS = 4;

// Each lane builds its world EXACTLY as the pre-2026-10-04 in-process tests did (seed 0x1A2B, the same
// oracle seeding + oracleCount reset); the hot loop never calls an oracle step.
export const GC_LANES = {
    EH() {
        const w = createEhWorld(EH_DEFAULT_W, EH_DEFAULT_EPS, 0x1A2B); const a = createAllocState();
        return { w, a, idx: E_SKETCH_ALLOC, step: () => stepEh(w), render: renderEhPrep };
    },
    ADWIN() {
        const w = createAdWorld(AD_DEFAULT_DELTA, 0x1A2B); const a = createAllocState();
        return { w, a, idx: A_SKETCH_ALLOC, step: () => stepAd(w), render: renderAdPrep };
    },
    FD() {
        const w = createFdWorld(FD_DEFAULT_HALFLIFE, 0x1A2B); const a = createAllocState();
        for (let i = 0; i < 120; i++) stepFdOracle(w, a);   // seed the exact ring once (renderFdPrep reads it)
        a.oracleCount = 0;
        return { w, a, idx: D_SKETCH_ALLOC, step: () => stepFd(w), render: renderFdPrep };
    },
    HK() {
        const w = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x1A2B); const a = createAllocState();
        for (let i = 0; i < 40; i++) stepHkOracle(w, a);   // populate the Map once (read-only in the hot loop)
        a.oracleCount = 0;
        return { w, a, idx: H_SKETCH_ALLOC, step: () => stepHk(w), render: renderHkPrep };
    },
    SHLL() {
        const w = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x1A2B); const a = createAllocState();
        for (let i = 0; i < 40; i++) { stepShll(w); stepShllOracle(w, a); }
        a.oracleCount = 0;
        return { w, a, idx: S_SKETCH_ALLOC, step: () => stepShll(w), render: renderShllPrep };
    },
    DD() {
        const w = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD); const a = createAllocState();
        return { w, a, idx: G_SKETCH_ALLOC, step: () => stepDd(w), render: renderDdPrep };
    },
    SLD() {
        const w = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES); const a = createAllocState();
        for (let i = 0; i < 40; i++) { stepSld(w); stepSldOracle(w, a); }
        a.oracleCount = 0;
        return { w, a, idx: Q_SKETCH_ALLOC, step: () => stepSld(w), render: renderSldPrep };
    },
    SCM() {
        const w = createScmWorld(SCM_DEFAULT_W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, 0x1A2B); const a = createAllocState();
        for (let i = 0; i < 40; i++) { stepScm(w); stepScmOracle(w, a); }
        a.oracleCount = 0;
        return { w, a, idx: C_SKETCH_ALLOC, step: () => stepScm(w), render: renderScmPrep };
    },
    DR() {
        const w = createDrWorld(DR_DEFAULT_K, DR_DEFAULT_HALFLIFE, 0x1A2B); const a = createAllocState();
        return { w, a, idx: R_SKETCH_ALLOC, step: () => stepDr(w), render: renderDrPrep };
    },
};

// The ONLY code inside the window. Its own function, so the per-chunk heap read in the caller never
// sits on an OSR'd loop's never-taken branch (the deopt source 3 above). `base` keeps the
// render-every-64th cadence global across chunks. Returns an int32 sink (never a double).
function hotChunk(step, render, world, alloc, base, n) {
    let sink = 0;
    for (let j = 0; j < n; j++) {
        sink = (sink + step()) | 0;
        if (((base + j) & 63) === 0) sink = (sink + (render(world, alloc) | 0)) | 0;
    }
    return sink;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Run one lane in THIS process. Caller must be a fresh `node --expose-gc` child. */
export async function measureGcLane(name) {
    const make = GC_LANES[name];
    if (!make) throw new Error('[DemoGcLane] no lane "' + name + '"');
    if (typeof globalThis.gc !== 'function') throw new Error('[DemoGcLane] needs --expose-gc');
    const { w, a, idx, step, render } = make();
    w.__sketchAllocIdx = idx;
    let sink = 0;
    for (let r = 0; r < WARM_ROUNDS; r++) sink = (sink + hotChunk(step, render, w, a, 0, WARM_FRAMES)) | 0;
    // Drain BEFORE the window: let every queued 'gc' perf entry and timer from warm-up dispatch (their
    // delivery allocates), then collect that garbage, so the window starts on an empty young gen.
    globalThis.gc(); globalThis.gc();
    for (let i = 0; i < 4; i++) await tick();
    globalThis.gc(); globalThis.gc();
    const samples = new Float64Array(2 * N_CHUNKS);   // [t, heapUsed] per chunk, preallocated
    const gc = new GcProfiler().start();
    const t0 = performance.now();
    for (let c = 0; c < N_CHUNKS; c++) {
        const base = c * CHUNK;
        const n = Math.min(CHUNK, GC_LANE_HOT - base);
        sink = (sink + hotChunk(step, render, w, a, base, n)) | 0;
        samples[2 * c] = performance.now();
        samples[2 * c + 1] = process.memoryUsage().heapUsed;
    }
    const t1 = performance.now();
    await new Promise((r) => setTimeout(r, 50));   // GC entries arrive asynchronously
    const settled = await gc.settle({ quietTicks: 3, maxWaitMs: 1000 });
    for (let c = 0; c < N_CHUNKS; c++) gc.sampleHeap(samples[2 * c], samples[2 * c + 1]);
    const s = gc.summary();
    gc.stop();
    const report = checkNoGc(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 4 });
    return {
        lane: name, hot: GC_LANE_HOT, loopMs: t1 - t0, settled: settled.drained,
        major: s.gc.major, minor: s.gc.minor, maxMs: s.gc.maxMs, observed: s.gc.observed,
        verdict: report.verdict, ok: report.ok, violations: report.violations, checked: report.checked,
        sinkFinite: Number.isFinite(sink), sketchCount: a.sketchCount, flatSlot: w.flat[idx],
        execArgv: process.execArgv,
    };
}

/** Parent side: spawn a fresh `node --expose-gc` child for one lane; resolve its JSON result. */
export function runGcLane(name) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--expose-gc', SELF, name],
            { env: Object.assign({}, process.env, { LITE_GC_LANE: name }), stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) return reject(new Error('[DemoGcLane] lane ' + name + ' exited ' + code + ': ' + out));
            const line = out.trim().split('\n').filter(Boolean).pop();
            try { resolve(JSON.parse(line)); }
            catch (e) { reject(new Error('[DemoGcLane] bad lane output for ' + name + ': ' + out)); }
        });
    });
}

// child entry: only when THIS file is the process main module (never when a test imports it).
const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN && (process.env.LITE_GC_LANE || process.argv[2])) {
    const name = process.env.LITE_GC_LANE || process.argv[2];
    if (!GC_LANES[name]) { console.error('[DemoGcLane] no lane "' + name + '"'); process.exit(2); }
    if (typeof globalThis.gc !== 'function') { console.error('[DemoGcLane] child needs --expose-gc'); process.exit(2); }
    const r = await measureGcLane(name);
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(0);
}
