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
    const { ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog,
        DriftDetector, DRIFT_PH, DRIFT_CUSUM } = await import('../Adaptive.js');

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

            const hk = new HeavyKeeper(4, 512, 8, { seed: 1 });
            // a skewed stream over large u32 keys -> exercise fp-hit + fp-miss decay + the forest.
            for (let k = 0; k < 4096; k++) hk.add(4000000000 + ((k * 2654435761) % 3000), (k & 7) + 1);
            hk.estimate(4000000001); hk.forEach(noop); hk.topK();   // cold reads (topK may alloc, cold)
            hk.clear();
            tracker.track(hk, noop, 'heavykeeper', { audit: true });

            const sl = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 2 });
            // a rolling distinct set over a full, churning window -> expire + LFPM domination drop.
            let st = 0;
            for (let k = 0; k < 4096; k++) sl.add(st++, (k * 2654435761) % 3000);
            sl.count(); sl.count(500);                   // exercise the cold estimator + sub-window (0 alloc)
            sl.clear();
            tracker.track(sl, noop, 'slidinghyperloglog', { audit: true });

            const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 });
            // a drifting stream -> exercise the running mean + the PH branch + the reset on a fire.
            for (let k = 0; k < 4096; k++) dd.add(((k >> 9) & 1) ? 1000 : 0);
            dd.mean; dd.statistic; dd.count;             // exercise the cold getters (0 alloc)
            dd.clear();
            tracker.track(dd, noop, 'driftdetector', { audit: true });
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

    // ---- phase 2a-ter: HeavyKeeper -- add (fp-hit / fp-miss decay draw + forest sift) + the
    // ZERO-BOX addFrom on FRACTIONAL-buffer LARGE u32 keys (near 2^31, 2^32-1) + ADWIN.addFrom. ----
    // HeavyKeeper add: a churning skewed stream over integer keys (Smi -> no key box on the plain
    // add), so every measured add touches the d cells (hit + miss decay draw via the PRNG) and
    // re-heaps the forest. Primed first so the table + forest are hot.
    const hkAdd = new HeavyKeeper(4, 512, 16, { seed: 3 });
    let hkI = 0;
    for (let k = 0; k < 40000; k++) { hkAdd.add((hkI * 2654435761) % 4000, (hkI & 7) + 1); hkI++; }
    let hkSink = 0;
    const hkStep = () => {
        hkAdd.add((hkI * 2654435761) % 4000, (hkI & 7) + 1);
        hkI = (hkI + 1) | 0;
        hkSink = (hkSink + hkAdd.size) | 0;   // observe state (defeat DCE)
    };
    const hkRes = measureAllocs(hkStep, { iterations: 100000, batches: 8 });
    const hkBpc = hkRes.bytesPerCall === null ? 0 : hkRes.bytesPerCall;
    const hkBytes = Math.max(0, Math.round(hkBpc));
    const hkOk = hkBytes === 0;

    // HeavyKeeper addFrom: LARGE u32 keys (near 2^31 / 2^32-1) read UNBOXED from a packed
    // [key, weight] Float64Array -- the case where a plain-arg add() would box the key. This is
    // the gated zero-box floor for the lite-hud tag-id driver.
    const hkFrom = new HeavyKeeper(4, 512, 16, { seed: 4 });
    const HKBUF = new Float64Array(2);
    let hkfI = 0;
    for (let k = 0; k < 40000; k++) {
        HKBUF[0] = 4294967295 - ((hkfI * 2654435761) % 4000);   // near 2^32-1
        HKBUF[1] = (hkfI & 7) + 1;
        hkFrom.addFrom(HKBUF, 0);
        hkfI++;
    }
    let hkFromSink = 0;
    const hkFromStep = () => {
        // alternate two large-u32 bands (near 2^31 and near 2^32-1) so both boxing regimes run.
        HKBUF[0] = (hkfI & 1) ? (4294967295 - ((hkfI * 2654435761) % 4000))
                             : ((2 ** 31) + ((hkfI * 40503) % 4000));
        HKBUF[1] = (hkfI & 7) + 1;
        hkFrom.addFrom(HKBUF, 0);
        hkfI = (hkfI + 1) | 0;
        hkFromSink = (hkFromSink + hkFrom.size) | 0;   // observe state (defeat DCE)
    };
    const hkFromRes = measureAllocs(hkFromStep, { iterations: 100000, batches: 8 });
    const hkFromBpc = hkFromRes.bytesPerCall === null ? 0 : hkFromRes.bytesPerCall;
    const hkFromBytes = Math.max(0, Math.round(hkFromBpc));
    const hkFromOk = hkFromBytes === 0;

    // HeavyKeeper add DIAGNOSTIC (LARGE u32 key as a BOXED plain arg) -- printed, NOT a gate.
    const hkBoxed = new HeavyKeeper(4, 512, 16, { seed: 5 });
    let hkbI = 0;
    for (let k = 0; k < 40000; k++) { hkBoxed.add(4294967295 - ((hkbI * 2654435761) % 4000), (hkbI & 7) + 1); hkbI++; }
    let hkBoxedSink = 0;
    const hkBoxedStep = () => {
        hkBoxed.add(4294967295 - ((hkbI * 2654435761) % 4000), (hkbI & 7) + 1);
        hkbI = (hkbI + 1) | 0;
        hkBoxedSink = (hkBoxedSink + hkBoxed.size) | 0;
    };
    const hkBoxedBytes = Math.max(0, Math.round(
        (r => r.bytesPerCall === null ? 0 : r.bytesPerCall)(measureAllocs(hkBoxedStep, { iterations: 100000, batches: 8 }))));

    // ADWIN addFrom: a drifting FRACTIONAL stream read UNBOXED from a Float64Array(1) scratch --
    // the zero-box sibling of add(x). Primed to a churning window first.
    const adFrom = new ADWIN(0.1);
    const ADBUF = new Float64Array(1);
    let adfI = 0;
    for (let k = 0; k < 40000; k++) { ADBUF[0] = ((adfI >> 9) & 1) ? 1000.5 : 0.25; adFrom.addFrom(ADBUF, 0); adfI++; }
    let adFromSink = 0;
    const adFromStep = () => {
        ADBUF[0] = ((adfI >> 9) & 1) ? 1000.5 : 0.25;   // fractional drifting value
        const cut = adFrom.addFrom(ADBUF, 0);
        adfI = (adfI + 1) | 0;
        adFromSink = (adFromSink + (cut ? 1 : 0) + adFrom.bucketCount) | 0;   // observe (defeat DCE)
    };
    const adFromRes = measureAllocs(adFromStep, { iterations: 100000, batches: 8 });
    const adFromBpc = adFromRes.bytesPerCall === null ? 0 : adFromRes.bytesPerCall;
    const adFromBytes = Math.max(0, Math.round(adFromBpc));
    const adFromOk = adFromBytes === 0;

    // ---- phase 2a-quater: HeavyKeeper.clear() zero-alloc (planner assertion: clear() 0-alloc) ----
    // Re-fill between clears so every measured clear() actually resets non-trivial live state
    // (fps/cnt/mapKey fills + heap/map reset), not a no-op on an already-empty instance.
    const hkClear = new HeavyKeeper(4, 512, 16, { seed: 11 });
    for (let k = 0; k < 20000; k++) hkClear.add((k * 2654435761) % 4000, (k & 7) + 1);
    let hkClearSink = 0, hkClearI = 0;
    const hkClearStep = () => {
        hkClear.clear();
        hkClear.add((hkClearI * 2654435761) % 4000, (hkClearI & 7) + 1);   // re-seed live state
        hkClearI = (hkClearI + 1) | 0;
        hkClearSink = (hkClearSink + hkClear.size) | 0;   // observe state (defeat DCE)
    };
    const hkClearRes = measureAllocs(hkClearStep, { iterations: 100000, batches: 8 });
    const hkClearBpc = hkClearRes.bytesPerCall === null ? 0 : hkClearRes.bytesPerCall;
    const hkClearBytes = Math.max(0, Math.round(hkClearBpc));
    const hkClearOk = hkClearBytes === 0;

    // ---- phase 2a-quinquies: SlidingHyperLogLog -- add (SMI now + key: two-lane hash + LFPM
    // domination drop + append) + the ZERO-BOX addFrom on epoch-ms `now` + LARGE keys + clear. ----
    // SlidingHLL add: an explicit-time SMI `now` + SMI key (both Smi so the plain-arg add never
    // boxes), so every measured add runs the inline murmur + the LFPM ring push. Primed to a full,
    // churning window first (so the domination drop is exercised each add).
    const slAdd = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 2 });
    let slT = 0;
    for (let k = 0; k < 4000; k++) slAdd.add(slT++, (k * 2654435761) % 3000);
    let slSink = 0;
    const slStep = () => {
        slAdd.add(slT, (slT * 2654435761) % 3000);
        slT = (slT + 1) | 0;
        slSink = (slSink + slAdd.overflows) | 0;   // observe state (defeat DCE)
    };
    const slRes = measureAllocs(slStep, { iterations: 100000, batches: 8 });
    const slBpc = slRes.bytesPerCall === null ? 0 : slRes.bytesPerCall;
    const slBytes = Math.max(0, Math.round(slBpc));
    const slOk = slBytes === 0;

    // SlidingHLL addFrom: epoch-ms `now` (a non-Smi double) + LARGE keys (2^53-1 band and -2^31)
    // read UNBOXED from a packed [now, key] Float64Array -- the case where a plain-arg add() would
    // box both the fractional `now` and the large key. This is the gated zero-box floor.
    const slFrom = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 3 });
    const SLBUF = new Float64Array(2);
    let slfNow = 1.75e12;   // epoch-ms base (well above 2^31 -> a non-Smi double)
    for (let k = 0; k < 4000; k++) {
        slfNow += 1;
        SLBUF[0] = slfNow;
        SLBUF[1] = 9007199254740000 - ((k * 2654435761) % 3000);   // near 2^53-1
        slFrom.addFrom(SLBUF, 0);
    }
    let slFromSink = 0, slfI = 0;
    const slFromStep = () => {
        slfNow += 1;
        SLBUF[0] = slfNow;
        // alternate a near-2^53 band and a -2^31 band so both large-magnitude regimes run.
        SLBUF[1] = (slfI & 1) ? (9007199254740000 - ((slfI * 2654435761) % 3000))
                             : (-(2 ** 31) + ((slfI * 40503) % 3000));
        slFrom.addFrom(SLBUF, 0);
        slfI = (slfI + 1) | 0;
        slFromSink = (slFromSink + slFrom.overflows) | 0;   // observe state (defeat DCE)
    };
    const slFromRes = measureAllocs(slFromStep, { iterations: 100000, batches: 8 });
    const slFromBpc = slFromRes.bytesPerCall === null ? 0 : slFromRes.bytesPerCall;
    const slFromBytes = Math.max(0, Math.round(slFromBpc));
    const slFromOk = slFromBytes === 0;

    // SlidingHLL clear(): re-fill between clears so every measured clear() resets non-trivial live
    // state (head/len fills + mode/overflow reset), not a no-op on an already-empty instance.
    const slClear = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 4 });
    for (let k = 0; k < 4000; k++) slClear.add(k, (k * 2654435761) % 3000);
    let slClearSink = 0, slClearI = 0;
    const slClearStep = () => {
        slClear.clear();
        slClear.add(slClearI, (slClearI * 2654435761) % 3000);   // re-seed live state
        slClearI = (slClearI + 1) | 0;
        slClearSink = (slClearSink + (slClear.mode === 'explicit' ? 1 : 0)) | 0;   // observe (defeat DCE)
    };
    const slClearRes = measureAllocs(slClearStep, { iterations: 100000, batches: 8 });
    const slClearBpc = slClearRes.bytesPerCall === null ? 0 : slClearRes.bytesPerCall;
    const slClearBytes = Math.max(0, Math.round(slClearBpc));
    const slClearOk = slClearBytes === 0;

    // ---- phase 2a-sexies: DriftDetector -- add (PH + CUSUM, both mode branches, incl. the reset
    // on a fire) + the ZERO-BOX addFrom on a FRACTIONAL value + clear. Pure scalars, no pool. ----
    // DriftDetector add PH: a drifting stream (mean alternates every 512 items) so every measured add
    // updates the running mean, runs the PH branch, and periodically FIRES (the reset path). Integer
    // means keep the plain-arg add off the boxing boundary. Primed first.
    const ddPh = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 });
    let ddPhI = 0;
    for (let k = 0; k < 40000; k++) { ddPh.add(((ddPhI >> 9) & 1) ? 1000 : 0); ddPhI++; }
    let ddPhSink = 0;
    const ddPhStep = () => {
        const cut = ddPh.add(((ddPhI >> 9) & 1) ? 1000 : 0);
        ddPhI = (ddPhI + 1) | 0;
        ddPhSink = (ddPhSink + (cut ? 1 : 0) + (ddPh.count & 255)) | 0;   // observe state (defeat DCE)
    };
    const ddPhRes = measureAllocs(ddPhStep, { iterations: 100000, batches: 8 });
    const ddPhBpc = ddPhRes.bytesPerCall === null ? 0 : ddPhRes.bytesPerCall;
    const ddPhBytes = Math.max(0, Math.round(ddPhBpc));
    const ddPhOk = ddPhBytes === 0;

    // DriftDetector add CUSUM: the other mode branch (two floored accumulators vs a FIXED target),
    // same drifting stream. target=500 sits between the two regimes so both directions depart + fire.
    const ddCu = new DriftDetector(DRIFT_CUSUM, { delta: 0.005, threshold: 5, target: 500 });
    let ddCuI = 0;
    for (let k = 0; k < 40000; k++) { ddCu.add(((ddCuI >> 9) & 1) ? 1000 : 0); ddCuI++; }
    let ddCuSink = 0;
    const ddCuStep = () => {
        const cut = ddCu.add(((ddCuI >> 9) & 1) ? 1000 : 0);
        ddCuI = (ddCuI + 1) | 0;
        ddCuSink = (ddCuSink + (cut ? 1 : 0) + (ddCu.count & 255)) | 0;   // observe state (defeat DCE)
    };
    const ddCuRes = measureAllocs(ddCuStep, { iterations: 100000, batches: 8 });
    const ddCuBpc = ddCuRes.bytesPerCall === null ? 0 : ddCuRes.bytesPerCall;
    const ddCuBytes = Math.max(0, Math.round(ddCuBpc));
    const ddCuOk = ddCuBytes === 0;

    // DriftDetector addFrom: a drifting FRACTIONAL stream read UNBOXED from a Float64Array(1) scratch
    // -- the zero-box sibling of add(x). Primed first.
    const ddFrom = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 });
    const DDBUF = new Float64Array(1);
    let ddfI = 0;
    for (let k = 0; k < 40000; k++) { DDBUF[0] = ((ddfI >> 9) & 1) ? 1000.5 : 0.25; ddFrom.addFrom(DDBUF, 0); ddfI++; }
    let ddFromSink = 0;
    const ddFromStep = () => {
        DDBUF[0] = ((ddfI >> 9) & 1) ? 1000.5 : 0.25;   // fractional drifting value
        const cut = ddFrom.addFrom(DDBUF, 0);
        ddfI = (ddfI + 1) | 0;
        ddFromSink = (ddFromSink + (cut ? 1 : 0) + (ddFrom.count & 255)) | 0;   // observe (defeat DCE)
    };
    const ddFromRes = measureAllocs(ddFromStep, { iterations: 100000, batches: 8 });
    const ddFromBpc = ddFromRes.bytesPerCall === null ? 0 : ddFromRes.bytesPerCall;
    const ddFromBytes = Math.max(0, Math.round(ddFromBpc));
    const ddFromOk = ddFromBytes === 0;

    // DriftDetector clear(): re-add between clears so every measured clear() resets non-trivial live
    // state (the six scalars), not a no-op on an already-empty instance.
    const ddClear = new DriftDetector(DRIFT_CUSUM, { delta: 0.005, threshold: 5, target: 500 });
    for (let k = 0; k < 2000; k++) ddClear.add((k & 511) ? 1 : 1000);
    let ddClearSink = 0, ddClearI = 0;
    const ddClearStep = () => {
        ddClear.clear();
        ddClear.add((ddClearI & 511) ? 1 : 1000);   // re-seed live state
        ddClearI = (ddClearI + 1) | 0;
        ddClearSink = (ddClearSink + ddClear.count) | 0;   // observe state (defeat DCE)
    };
    const ddClearRes = measureAllocs(ddClearStep, { iterations: 100000, batches: 8 });
    const ddClearBpc = ddClearRes.bytesPerCall === null ? 0 : ddClearRes.bytesPerCall;
    const ddClearBytes = Math.max(0, Math.round(ddClearBpc));
    const ddClearOk = ddClearBytes === 0;

    // ---- phase 2b: GC budget over a long hot run (millions of add + reshaping ops) ----
    const gc = new GcProfiler().start();
    const HOT = 4000000;
    let SINK = 0;
    for (let i = 0; i < HOT; i++) {
        addStep(); addTStep(); adStep(); fdStep(); fdRebStep(); ehFromStep(); fdFromStep();
        hkStep(); hkFromStep(); adFromStep(); hkClearStep();
        slStep(); slFromStep(); slClearStep();
        ddPhStep(); ddCuStep(); ddFromStep(); ddClearStep();
    }
    SINK += addSink + addTSink + adSink + fpSink + frSink + ehFromSink + fdFromSink + ehBoxedSink + fdBoxedSink +
        hkSink + hkFromSink + hkBoxedSink + adFromSink + hkClearSink + slSink + slFromSink + slClearSink +
        ddPhSink + ddCuSink + ddFromSink + ddClearSink;
    await sleep(50);
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });

    // ---- phase 2c: arrayBuffers growth (the fixed pool grows no store across reuse) ----
    const abBefore = process.memoryUsage().arrayBuffers;
    const reuse = new ExponentialHistogram(2048, 0.01);
    const reuseAd = new ADWIN(0.1);
    const reuseHk = new HeavyKeeper(4, 512, 16, { seed: 9 });
    const reuseSl = new SlidingHyperLogLog(2048, { p: 10, ringCap: 8, seed: 10 });
    let reuseSlT = 0;
    for (let c = 0; c < 500; c++) {
        for (let k = 0; k < 8192; k++) reuse.add();     // full window -> expire + cascade
        reuse.count();
        reuse.sum();
        reuse.clear();                                  // reuse the pool, no new store
        for (let k = 0; k < 8192; k++) reuseAd.add(((k >> 9) & 1) ? 1000 : 0);  // drift -> shrink
        reuseAd.mean; reuseAd.variance;
        reuseAd.clear();                                // reuse the pool, no new store
        for (let k = 0; k < 8192; k++) reuseHk.add((k * 2654435761) % 3000, (k & 7) + 1);  // skew + decay
        reuseHk.forEach(noop);
        reuseHk.clear();                                // reuse the arrays, no new store
        for (let k = 0; k < 8192; k++) reuseSl.add(reuseSlT++, (k * 2654435761) % 3000);  // window churn + LFPM
        reuseSl.count();
        reuseSl.clear();                                // reuse the arrays, no new store
    }
    globalThis.gc();
    const abAfter = process.memoryUsage().arrayBuffers;
    const abDelta = abAfter - abBefore;
    const abOk = abDelta <= 0;

    // ---- verdict + GATE line ----
    const ok = trackedOk && live === 0 && findings.length === 0 &&
        addOk && addTOk && adOk && fdOk && fdRebOk && ehFromOk && fdFromOk &&
        hkOk && hkFromOk && adFromOk && hkClearOk && slOk && slFromOk && slClearOk &&
        ddPhOk && ddCuOk && ddFromOk && ddClearOk && report.ok && abOk;
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
        fdFromBytes + ' B/op (ForwardDecay addFrom fractional) ' +
        hkBytes + ' B/op (HeavyKeeper add + decay + forest) ' +
        hkFromBytes + ' B/op (HeavyKeeper addFrom large-u32) ' +
        adFromBytes + ' B/op (ADWIN addFrom fractional) ' +
        hkClearBytes + ' B/op (HeavyKeeper clear) ' +
        slBytes + ' B/op (SlidingHyperLogLog add + LFPM drop) ' +
        slFromBytes + ' B/op (SlidingHyperLogLog addFrom epoch-ms + large key) ' +
        slClearBytes + ' B/op (SlidingHyperLogLog clear) ' +
        ddPhBytes + ' B/op (DriftDetector add PH) ' +
        ddCuBytes + ' B/op (DriftDetector add CUSUM) ' +
        ddFromBytes + ' B/op (DriftDetector addFrom fractional) ' +
        ddClearBytes + ' B/op (DriftDetector clear)' +
        ' | ' + (ok ? 'ok' : 'FAIL') +
        ' (tracked=' + trackedMid + ' sink=' + SINK + ' abGrowth=' + abDelta +
        ' diag: add-boxed-fractional EH=' + ehBoxedBytes + ' B/op FD=' + fdBoxedBytes +
        ' B/op HeavyKeeper add-boxed-large-u32=' + hkBoxedBytes + ' B/op)');

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
        if (!hkOk) console.error('  alloc ' + hkBytes + ' B/op HeavyKeeper add (raw ' + hkBpc + ')');
        if (!hkFromOk) console.error('  alloc ' + hkFromBytes + ' B/op HeavyKeeper addFrom (raw ' + hkFromBpc + ')');
        if (!adFromOk) console.error('  alloc ' + adFromBytes + ' B/op ADWIN addFrom (raw ' + adFromBpc + ')');
        if (!hkClearOk) console.error('  alloc ' + hkClearBytes + ' B/op HeavyKeeper clear (raw ' + hkClearBpc + ')');
        if (!slOk) console.error('  alloc ' + slBytes + ' B/op SlidingHyperLogLog add (raw ' + slBpc + ')');
        if (!slFromOk) console.error('  alloc ' + slFromBytes + ' B/op SlidingHyperLogLog addFrom (raw ' + slFromBpc + ')');
        if (!slClearOk) console.error('  alloc ' + slClearBytes + ' B/op SlidingHyperLogLog clear (raw ' + slClearBpc + ')');
        if (!ddPhOk) console.error('  alloc ' + ddPhBytes + ' B/op DriftDetector add PH (raw ' + ddPhBpc + ')');
        if (!ddCuOk) console.error('  alloc ' + ddCuBytes + ' B/op DriftDetector add CUSUM (raw ' + ddCuBpc + ')');
        if (!ddFromOk) console.error('  alloc ' + ddFromBytes + ' B/op DriftDetector addFrom (raw ' + ddFromBpc + ')');
        if (!ddClearOk) console.error('  alloc ' + ddClearBytes + ' B/op DriftDetector clear (raw ' + ddClearBpc + ')');
        if (!report.ok) console.error('  gc ' + JSON.stringify(report.violations));
        if (!abOk) console.error('  arrayBuffers growth ' + abDelta + ' (expected <= 0)');
        process.exitCode = 1;
    }
}

main();
