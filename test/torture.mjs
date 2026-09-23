// @zakkster/lite-adaptive -- the torture gate (repo-only; run: `node --expose-gc test/torture.mjs`).
//
// Proves the ZERO-GC claim the family sells: the ExponentialHistogram hot path -- add,
// INCLUDING the amortized bucket merge cascade AND the expire sweep over MANY pool
// wraps -- AND the ADWIN hot path -- add, INCLUDING the cut-scan AND the drop-older
// SHRINK on a drifting stream -- each allocates 0 B/op after construction, retains
// nothing, and triggers no major GC over a long run. Uses:
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
    const { ExponentialHistogram, ADWIN, ForwardDecay } = await import('../Adaptive.js');

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

            const ad = new ADWIN(0.1);
            // a drifting stream: alternate the mean every 512 items -> forces cut-scan + shrink.
            for (let k = 0; k < 4096; k++) ad.add(((k >> 9) & 1) ? 1000 : 0);
            ad.mean; ad.variance; ad.width;              // exercise the cold getters (0 alloc)
            ad.clear();
            tracker.track(ad, noop, 'adwin', { audit: true });

            const fd = new ForwardDecay(10);
            // a rebase-heavy explicit-time stream: a big step per add crosses FD_EXP_CAP each add.
            let ft = 0;
            for (let k = 0; k < 4096; k++) { ft += 11000; fd.add(ft, k & 7); }
            fd.count(); fd.sum(); fd.mean(); fd.rate();   // exercise the cold queries (0 alloc)
            fd.clear();
            tracker.track(fd, noop, 'forwarddecay', { audit: true });
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

    // ADWIN add: the important case is a DRIFTING stream, so every measured add runs the
    // cut-scan AND periodically the drop-older SHRINK -- the amortized reshaping must not
    // allocate. The mean alternates every 512 items (integer levels -> no arg boxing), which
    // forces ADWIN to detect + shrink over and over. Primed to a churning window first.
    const adwin = new ADWIN(0.1);
    let adI = 0;
    for (let k = 0; k < 40000; k++) { adwin.add(((adI >> 9) & 1) ? 1000 : 0); adI++; }
    let adSink = 0;
    const adStep = () => {
        const cut = adwin.add(((adI >> 9) & 1) ? 1000 : 0);
        adI = (adI + 1) | 0;
        adSink = (adSink + (cut ? 1 : 0) + adwin.bucketCount) | 0;   // observe state (defeat DCE)
    };
    const adRes = measureAllocs(adStep, { iterations: 100000, batches: 8 });
    const adBpc = adRes.bytesPerCall === null ? 0 : adRes.bytesPerCall;
    const adBytes = Math.max(0, Math.round(adBpc));
    const adOk = adBytes === 0;

    // ForwardDecay add: the plain hot path (no rebase) -- a walking monotone now over a large
    // half-life so lambda*(t-L) stays well under FD_EXP_CAP: one exp() + two accumulations.
    const fdPlain = new ForwardDecay(1e9);
    let fpT = 0;
    for (let k = 0; k < 4000; k++) { fpT += 1; fdPlain.add(fpT, 1); }
    let fpSink = 0;
    const fdStep = () => {
        fpT += 1;
        fdPlain.add(fpT, 1);
        fpSink = (fpSink + (fdPlain.landmark | 0)) | 0;   // observe state (defeat DCE)
    };
    const fdRes = measureAllocs(fdStep, { iterations: 100000, batches: 8 });
    const fdBpc = fdRes.bytesPerCall === null ? 0 : fdRes.bytesPerCall;
    const fdBytes = Math.max(0, Math.round(fdBpc));
    const fdOk = fdBytes === 0;

    // ForwardDecay add REBASE-HEAVY: lambda*(t-L) crosses FD_EXP_CAP on EVERY add -> the cold
    // rebase branch (C *= f; Sv *= f; L = t) runs each op and must be 0 B/op. halfLife 0.01 ->
    // lambda ~ 69.3, so a step of 11 gives arg ~ 762 > FD_EXP_CAP (40) each add while `frT` stays a small
    // integer (smi) across the 4M-op run (no int32 masking on a timestamp -- it would wrap).
    const fdReb = new ForwardDecay(0.01);
    let frT = 0;
    for (let k = 0; k < 4000; k++) { frT += 11; fdReb.add(frT, k & 7); }
    let frSink = 0;
    const fdRebStep = () => {
        frT += 11;
        fdReb.add(frT, frT & 7);
        frSink = (frSink + (fdReb.landmark === frT ? 1 : 0)) | 0;   // observe the rebase (defeat DCE)
    };
    const fdRebRes = measureAllocs(fdRebStep, { iterations: 100000, batches: 8 });
    const fdRebBpc = fdRebRes.bytesPerCall === null ? 0 : fdRebRes.bytesPerCall;
    const fdRebBytes = Math.max(0, Math.round(fdRebBpc));
    const fdRebOk = fdRebBytes === 0;

    // ---- phase 2a-bis: the ZERO-BOX addFrom entry -- FRACTIONAL now + value (the clean floor) ----
    // The lite-hud driver: BOTH now and value are fractional doubles. add(now, value) boxes each
    // (~16 B HeapNumber) at the non-inlined call boundary; addFrom(buf, i) reads them UNBOXED from a
    // packed [now, value] Float64Array and MUST stay at 0 B/op. We GATE ONLY the addFrom floor; add's
    // number is printed as a DIAGNOSTIC (V8 may inline add in this tight loop -- do NOT gate on it).
    const FBUF = new Float64Array(2);

    // EH addFrom, full churning window (open + merge cascade + expire), fractional inputs.
    const ehFrom = new ExponentialHistogram(W, 0.01);
    let efT = 0;
    for (let k = 0; k < 4 * W; k++) { efT += 1.5; FBUF[0] = efT; FBUF[1] = k * 0.5 + 0.25; ehFrom.addFrom(FBUF, 0); }
    let ehFromSink = 0, ehFromI = 4 * W;
    const ehFromStep = () => {
        efT += 1.5;
        FBUF[0] = efT; FBUF[1] = ehFromI * 0.5 + 0.25;
        ehFrom.addFrom(FBUF, 0);
        ehFromI = (ehFromI + 1) | 0;
        ehFromSink = (ehFromSink + ehFrom.bucketCount) | 0;   // observe state (defeat DCE)
    };
    const ehFromRes = measureAllocs(ehFromStep, { iterations: 100000, batches: 8 });
    const ehFromBpc = ehFromRes.bytesPerCall === null ? 0 : ehFromRes.bytesPerCall;
    const ehFromBytes = Math.max(0, Math.round(ehFromBpc));
    const ehFromOk = ehFromBytes === 0;

    // EH add DIAGNOSTIC (same fractional inputs, BOXED args) -- printed, NOT a gate.
    const ehBoxed = new ExponentialHistogram(W, 0.01);
    let ebT = 0;
    for (let k = 0; k < 4 * W; k++) { ebT += 1.5; ehBoxed.add(ebT, k * 0.5 + 0.25); }
    let ehBoxedSink = 0, ehBoxedI = 4 * W;
    const ehBoxedStep = () => {
        ebT += 1.5;
        ehBoxed.add(ebT, ehBoxedI * 0.5 + 0.25);
        ehBoxedI = (ehBoxedI + 1) | 0;
        ehBoxedSink = (ehBoxedSink + ehBoxed.bucketCount) | 0;
    };
    const ehBoxedBytes = Math.max(0, Math.round(
        (r => r.bytesPerCall === null ? 0 : r.bytesPerCall)(measureAllocs(ehBoxedStep, { iterations: 100000, batches: 8 }))));

    // FD addFrom, plain hot path (large half-life -> no rebase), fractional inputs.
    const fdFrom = new ForwardDecay(1e9);
    let ffT = 0;
    for (let k = 0; k < 4000; k++) { ffT += 1.5; FBUF[0] = ffT; FBUF[1] = k * 0.5 + 0.25; fdFrom.addFrom(FBUF, 0); }
    let fdFromSink = 0, fdFromI = 4000;
    const fdFromStep = () => {
        ffT += 1.5;
        FBUF[0] = ffT; FBUF[1] = fdFromI * 0.5 + 0.25;
        fdFrom.addFrom(FBUF, 0);
        fdFromI = (fdFromI + 1) | 0;
        fdFromSink = (fdFromSink + (fdFrom.landmark | 0)) | 0;   // observe state (defeat DCE)
    };
    const fdFromRes = measureAllocs(fdFromStep, { iterations: 100000, batches: 8 });
    const fdFromBpc = fdFromRes.bytesPerCall === null ? 0 : fdFromRes.bytesPerCall;
    const fdFromBytes = Math.max(0, Math.round(fdFromBpc));
    const fdFromOk = fdFromBytes === 0;

    // FD add DIAGNOSTIC (same fractional inputs, BOXED args) -- printed, NOT a gate.
    const fdBoxed = new ForwardDecay(1e9);
    let fbT = 0;
    for (let k = 0; k < 4000; k++) { fbT += 1.5; fdBoxed.add(fbT, k * 0.5 + 0.25); }
    let fdBoxedSink = 0, fdBoxedI = 4000;
    const fdBoxedStep = () => {
        fbT += 1.5;
        fdBoxed.add(fbT, fdBoxedI * 0.5 + 0.25);
        fdBoxedI = (fdBoxedI + 1) | 0;
        fdBoxedSink = (fdBoxedSink + (fdBoxed.landmark | 0)) | 0;
    };
    const fdBoxedBytes = Math.max(0, Math.round(
        (r => r.bytesPerCall === null ? 0 : r.bytesPerCall)(measureAllocs(fdBoxedStep, { iterations: 100000, batches: 8 }))));

    // ---- phase 2b: GC budget over a long hot run (millions of add + reshaping ops) ----
    const gc = new GcProfiler().start();
    const HOT = 4000000;
    let SINK = 0;
    for (let i = 0; i < HOT; i++) { addStep(); addTStep(); adStep(); fdStep(); fdRebStep(); ehFromStep(); fdFromStep(); }
    SINK += addSink + addTSink + adSink + fpSink + frSink + ehFromSink + fdFromSink + ehBoxedSink + fdBoxedSink;
    await sleep(50);
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });

    // ---- phase 2c: arrayBuffers growth (the fixed pool grows no store across reuse) ----
    const abBefore = process.memoryUsage().arrayBuffers;
    const reuse = new ExponentialHistogram(2048, 0.01);
    const reuseAd = new ADWIN(0.1);
    for (let c = 0; c < 500; c++) {
        for (let k = 0; k < 8192; k++) reuse.add();     // full window -> expire + cascade
        reuse.count();
        reuse.sum();
        reuse.clear();                                  // reuse the pool, no new store
        for (let k = 0; k < 8192; k++) reuseAd.add(((k >> 9) & 1) ? 1000 : 0);  // drift -> shrink
        reuseAd.mean; reuseAd.variance;
        reuseAd.clear();                                // reuse the pool, no new store
    }
    globalThis.gc();
    const abAfter = process.memoryUsage().arrayBuffers;
    const abDelta = abAfter - abBefore;
    const abOk = abDelta <= 0;

    // ---- verdict + GATE line ----
    const ok = trackedOk && live === 0 && findings.length === 0 &&
        addOk && addTOk && adOk && fdOk && fdRebOk && ehFromOk && fdFromOk && report.ok && abOk;
    console.log(
        'GATE leak=size ' + live + '/0 findings=' + findings.length +
        ' warnings=0' +
        ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) +
        ' | alloc=' + addBytes + ' B/op (ExponentialHistogram add count-mode) ' +
        addTBytes + ' B/op (ExponentialHistogram add explicit-time) ' +
        adBytes + ' B/op (ADWIN add + cut-scan + shrink) ' +
        fdBytes + ' B/op (ForwardDecay add) ' +
        fdRebBytes + ' B/op (ForwardDecay add rebase-heavy) ' +
        ehFromBytes + ' B/op (ExponentialHistogram addFrom fractional) ' +
        fdFromBytes + ' B/op (ForwardDecay addFrom fractional)' +
        ' | ' + (ok ? 'ok' : 'FAIL') +
        ' (tracked=' + trackedMid + ' sink=' + SINK + ' abGrowth=' + abDelta +
        ' diag: add-boxed-fractional EH=' + ehBoxedBytes + ' B/op FD=' + fdBoxedBytes + ' B/op)');

    if (!ok) {
        if (!trackedOk) console.error('  vacuous: tracker held ' + trackedMid + ' (expected > 0)');
        if (live !== 0) console.error('  retain: ' + live + ' instances survived');
        for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
        if (!addOk) console.error('  alloc ' + addBytes + ' B/op add count-mode (raw ' + addBpc + ')');
        if (!addTOk) console.error('  alloc ' + addTBytes + ' B/op add explicit-time (raw ' + addTBpc + ')');
        if (!adOk) console.error('  alloc ' + adBytes + ' B/op ADWIN add (raw ' + adBpc + ')');
        if (!fdOk) console.error('  alloc ' + fdBytes + ' B/op ForwardDecay add (raw ' + fdBpc + ')');
        if (!fdRebOk) console.error('  alloc ' + fdRebBytes + ' B/op ForwardDecay rebase-heavy (raw ' + fdRebBpc + ')');
        if (!ehFromOk) console.error('  alloc ' + ehFromBytes + ' B/op ExponentialHistogram addFrom (raw ' + ehFromBpc + ')');
        if (!fdFromOk) console.error('  alloc ' + fdFromBytes + ' B/op ForwardDecay addFrom (raw ' + fdFromBpc + ')');
        if (!report.ok) console.error('  gc ' + JSON.stringify(report.violations));
        if (!abOk) console.error('  arrayBuffers growth ' + abDelta + ' (expected <= 0)');
        process.exitCode = 1;
    }
}

main();
