// @zakkster/lite-adaptive -- the torture gate (repo-only; run: `node --expose-gc test/torture.mjs`).
//
// Proves the ZERO-GC claim the family sells: the ExponentialHistogram hot path -- add,
// INCLUDING the amortized bucket merge cascade AND the expire sweep over MANY pool
// wraps -- allocates 0 B/op after construction, retains nothing, and triggers no major
// GC over a long run. Uses:
//   - @zakkster/lite-gc-profiler -- measureAllocs (bytes/op) + GcProfiler + checkNoGc
//   - @zakkster/lite-leak        -- retention: do instances outlive their scope?
// No gate output is a FAIL. ASCII-only.

async function main() {
    if (typeof globalThis.gc !== 'function') {
        console.error('FAIL: run with --expose-gc  (node --expose-gc test/torture.mjs)');
        process.exitCode = 1;
        return;
    }
    for (const pkg of ['@zakkster/lite-gc-profiler', '@zakkster/lite-leak']) {
        try { await import(pkg); }
        catch { console.error('FAIL: missing devDep ' + pkg + ' (npm install)'); process.exitCode = 1; return; }
    }
    const { GcProfiler, checkNoGc, measureAllocs } = await import('@zakkster/lite-gc-profiler');
    const { createLeakTracker } = await import('@zakkster/lite-leak');
    const { ExponentialHistogram } = await import('../Adaptive.js');

    const noop = () => {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---- phase 1: retention (do build/fill/query/clear cycles reclaim fully?) ----
    const tracker = createLeakTracker();
    function fillTracker() {
        for (let i = 0; i < 256; i++) {
            const eh = new ExponentialHistogram(1000, 0.01);
            for (let k = 0; k < 4096; k++) eh.add();     // full window -> expire + merge cascade
            eh.count();                                  // exercise the cold estimator (0 alloc)
            eh.sum();                                    // exercise the cold O(buckets) walk
            eh.clear();
            tracker.track(eh, noop, 'exponentialhistogram', { audit: true });
        }
        return tracker.size();
    }
    const trackedMid = fillTracker();
    const trackedOk = trackedMid > 0;   // non-vacuous: the tracker really holds instances
    let live = tracker.size();
    for (let g = 0; g < 20 && live > 0; g++) { globalThis.gc(); await sleep(25); live = tracker.size(); }
    const findings = tracker.audit();

    // ---- phase 2a: 0 B/op on the hot path (add incl. merge cascade + expire) ----
    // Steady-state FULL window: primed OUTSIDE the measured window so every measured add
    // expires the oldest bucket(s) AND runs the merge cascade -- the important 0-B/op case
    // (the amortized reshaping must not allocate). Count mode auto-ticks the clock.
    const W = 1000;
    const ehCount = new ExponentialHistogram(W, 0.01);
    for (let k = 0; k < 4 * W; k++) ehCount.add();       // fill to a full, churning window
    let addSink = 0;
    const addStep = () => {
        ehCount.add();
        addSink = (addSink + ehCount.bucketCount) | 0;   // observe state (defeat DCE)
    };
    const addRes = measureAllocs(addStep, { iterations: 100000, batches: 8 });
    const addBpc = addRes.bytesPerCall === null ? 0 : addRes.bytesPerCall;
    const addBytes = Math.max(0, Math.round(addBpc));
    const addOk = addBytes === 0;

    // explicit-time add: a walking MONOTONE now (the other hot entry) -- also full-window.
    const ehTime = new ExponentialHistogram(W, 0.01);
    let tNow = 0;
    for (let k = 0; k < 4 * W; k++) { tNow += 1; ehTime.add(tNow); }
    let addTSink = 0;
    const addTStep = () => {
        tNow += 1;
        ehTime.add(tNow, 1);
        addTSink = (addTSink + ehTime.bucketCount) | 0;
    };
    const addTRes = measureAllocs(addTStep, { iterations: 100000, batches: 8 });
    const addTBpc = addTRes.bytesPerCall === null ? 0 : addTRes.bytesPerCall;
    const addTBytes = Math.max(0, Math.round(addTBpc));
    const addTOk = addTBytes === 0;

    // ---- phase 2b: GC budget over a long hot run (millions of add + reshaping ops) ----
    const gc = new GcProfiler().start();
    const HOT = 4000000;
    let SINK = 0;
    for (let i = 0; i < HOT; i++) { addStep(); addTStep(); }
    SINK += addSink + addTSink;
    await sleep(50);
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });

    // ---- phase 2c: arrayBuffers growth (the fixed pool grows no store across reuse) ----
    const abBefore = process.memoryUsage().arrayBuffers;
    const reuse = new ExponentialHistogram(2048, 0.01);
    for (let c = 0; c < 500; c++) {
        for (let k = 0; k < 8192; k++) reuse.add();     // full window -> expire + cascade
        reuse.count();
        reuse.sum();
        reuse.clear();                                  // reuse the pool, no new store
    }
    globalThis.gc();
    const abAfter = process.memoryUsage().arrayBuffers;
    const abDelta = abAfter - abBefore;
    const abOk = abDelta <= 0;

    // ---- verdict + GATE line ----
    const ok = trackedOk && live === 0 && findings.length === 0 &&
        addOk && addTOk && report.ok && abOk;
    console.log(
        'GATE leak=size ' + live + '/0 findings=' + findings.length +
        ' warnings=0' +
        ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) +
        ' | alloc=' + addBytes + ' B/op (ExponentialHistogram add count-mode) ' +
        addTBytes + ' B/op (ExponentialHistogram add explicit-time)' +
        ' | ' + (ok ? 'ok' : 'FAIL') +
        ' (tracked=' + trackedMid + ' sink=' + SINK + ' abGrowth=' + abDelta + ')');

    if (!ok) {
        if (!trackedOk) console.error('  vacuous: tracker held ' + trackedMid + ' (expected > 0)');
        if (live !== 0) console.error('  retain: ' + live + ' ExponentialHistogram instances survived');
        for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
        if (!addOk) console.error('  alloc ' + addBytes + ' B/op add count-mode (raw ' + addBpc + ')');
        if (!addTOk) console.error('  alloc ' + addTBytes + ' B/op add explicit-time (raw ' + addTBpc + ')');
        if (!report.ok) console.error('  gc ' + JSON.stringify(report.violations));
        if (!abOk) console.error('  arrayBuffers growth ' + abDelta + ' (expected <= 0)');
        process.exitCode = 1;
    }
}

main();
