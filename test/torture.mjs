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
        DriftDetector, DRIFT_PH, DRIFT_CUSUM, SlidingDDSketch, SlidingCountMin,
        DecayedReservoir } = await import('../Adaptive.js');

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

            const sd = new SlidingDDSketch(1000, { alpha: 0.01, panes: 16 });
            // a rolling explicit-time stream over a full, churning window -> rotate + clear + collapse.
            let sdt = 0;
            for (let k = 0; k < 4096; k++) sd.add(sdt++, ((k * 2654435761) % 9973) + 1);
            sd.quantile(0.5); sd.quantile(0.99); sd.count();   // cold queries (0 alloc via scratch)
            sd.clear();
            tracker.track(sd, noop, 'slidingddsketch', { audit: true });

            const scm = new SlidingCountMin(1000, { panes: 16, w: 128, d: 4, seed: 1 });
            // a rolling explicit-time key stream over a full, churning window -> pane rotate + clear + conservative.
            let scmt = 0;
            for (let k = 0; k < 4096; k++) scm.add(scmt++, ((k * 2654435761) >>> 0) % 5000);
            scm.estimate(1234); scm.estimate(1234, 500);   // cold sum-then-min queries (0 alloc)
            scm.clear();
            tracker.track(scm, noop, 'slidingcountmin', { audit: true });

            const dr = new DecayedReservoir(16, 1000, { seed: 1 });
            // a full, churning explicit-time stream with big steps -> exercise the A-Res draw + the
            // min-forest sift + the periodic order-preserving landmark rebase.
            let drt = 0;
            for (let k = 0; k < 4096; k++) { drt += 700; dr.add(drt, k & 15); }
            const drbuf = new Float64Array(16);
            dr.sampleInto(drbuf); dr.forEach(noop);   // cold reads (0 alloc)
            dr.clear();
            tracker.track(dr, noop, 'decayedreservoir', { audit: true });
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

    // ---- phase 2a-septies: SlidingDDSketch -- add (log-bucket key + pane rotate/clear + collapse) +
    // the ZERO-BOX addFrom on FRACTIONAL [now, value] + quantile + quantileInto + clear. ----
    // SlidingDDSketch add: an explicit-time SMI `now` + positive value over a full, churning window so
    // every measured add crosses pane boundaries periodically (rotate + clear must be 0-alloc). Primed.
    const sdAdd = new SlidingDDSketch(1000, { alpha: 0.01, panes: 32 });
    let sdT = 0;
    for (let k = 0; k < 4000; k++) sdAdd.add(sdT++, ((k * 2654435761) % 9973) + 1);
    let sdSink = 0;
    const sdStep = () => {
        sdAdd.add(sdT, ((sdT * 2654435761) % 9973) + 1);
        sdT = (sdT + 1) | 0;
        sdSink = (sdSink + (sdAdd.collapsed ? 1 : 0)) | 0;   // observe state (defeat DCE)
    };
    const sdRes = measureAllocs(sdStep, { iterations: 100000, batches: 8 });
    const sdBpc = sdRes.bytesPerCall === null ? 0 : sdRes.bytesPerCall;
    const sdBytes = Math.max(0, Math.round(sdBpc));
    const sdOk = sdBytes === 0;

    // SlidingDDSketch addFrom: epoch-ms `now` (non-Smi double) + FRACTIONAL value read UNBOXED from a
    // packed [now, value] Float64Array -- the gated zero-box floor (a plain-arg add would box both).
    const sdFrom = new SlidingDDSketch(1000, { alpha: 0.01, panes: 32 });
    const SDBUF = new Float64Array(2);
    let sdfNow = 1.75e12;
    for (let k = 0; k < 4000; k++) {
        sdfNow += 1.5; SDBUF[0] = sdfNow; SDBUF[1] = ((k * 40503) % 9973) + 0.5; sdFrom.addFrom(SDBUF, 0);
    }
    let sdFromSink = 0, sdfI = 0;
    const sdFromStep = () => {
        sdfNow += 1.5;
        SDBUF[0] = sdfNow; SDBUF[1] = ((sdfI * 40503) % 9973) + 0.5;
        sdFrom.addFrom(SDBUF, 0);
        sdfI = (sdfI + 1) | 0;
        sdFromSink = (sdFromSink + (sdFrom.collapsed ? 1 : 0)) | 0;   // observe state (defeat DCE)
    };
    const sdFromRes = measureAllocs(sdFromStep, { iterations: 100000, batches: 8 });
    const sdFromBpc = sdFromRes.bytesPerCall === null ? 0 : sdFromRes.bytesPerCall;
    const sdFromBytes = Math.max(0, Math.round(sdFromBpc));
    const sdFromOk = sdFromBytes === 0;

    // SlidingDDSketch quantile: the cold merge-into-scratch + walk must be 0-alloc (never a per-query
    // allocation). Query a full, churning window repeatedly.
    let sdQSink = 0;
    const sdQStep = () => {
        const p = sdAdd.quantile(0.99);
        sdQSink = (sdQSink + (p > 0 ? 1 : 0)) | 0;   // observe (defeat DCE)
    };
    const sdQRes = measureAllocs(sdQStep, { iterations: 20000, batches: 8 });
    const sdQBpc = sdQRes.bytesPerCall === null ? 0 : sdQRes.bytesPerCall;
    const sdQBytes = Math.max(0, Math.round(sdQBpc));
    const sdQOk = sdQBytes === 0;

    // SlidingDDSketch quantileInto: the 0-alloc multi-quantile render (one merge, several walks).
    const SDQS = Float64Array.of(0.5, 0.9, 0.99);
    const SDOUT = new Float64Array(3);
    let sdIntoSink = 0;
    const sdIntoStep = () => {
        sdAdd.quantileInto(SDQS, SDOUT);
        sdIntoSink = (sdIntoSink + (SDOUT[2] > 0 ? 1 : 0)) | 0;   // observe (defeat DCE)
    };
    const sdIntoRes = measureAllocs(sdIntoStep, { iterations: 20000, batches: 8 });
    const sdIntoBpc = sdIntoRes.bytesPerCall === null ? 0 : sdIntoRes.bytesPerCall;
    const sdIntoBytes = Math.max(0, Math.round(sdIntoBpc));
    const sdIntoOk = sdIntoBytes === 0;

    // SlidingDDSketch clear(): re-fill between clears so every measured clear() resets non-trivial live
    // state (all pane columns + scratch), not a no-op on an already-empty instance.
    const sdClear = new SlidingDDSketch(1000, { alpha: 0.01, panes: 32 });
    for (let k = 0; k < 4000; k++) sdClear.add(k, ((k * 2654435761) % 9973) + 1);
    let sdClearSink = 0, sdClearI = 0;
    const sdClearStep = () => {
        sdClear.clear();
        sdClear.add(sdClearI, ((sdClearI * 2654435761) % 9973) + 1);   // re-seed live state
        sdClearI = (sdClearI + 1) | 0;
        sdClearSink = (sdClearSink + (sdClear.mode === 'explicit' ? 1 : 0)) | 0;   // observe (defeat DCE)
    };
    const sdClearRes = measureAllocs(sdClearStep, { iterations: 20000, batches: 8 });
    const sdClearBpc = sdClearRes.bytesPerCall === null ? 0 : sdClearRes.bytesPerCall;
    const sdClearBytes = Math.max(0, Math.round(sdClearBpc));
    const sdClearOk = sdClearBytes === 0;

    // SlidingDDSketch retention: bytes constant + count() returns to baseline over 10 clear/refill cycles.
    const sdRet = new SlidingDDSketch(1000, { alpha: 0.01, panes: 16 });
    const sdRetBytes0 = sdRet.bytes;
    let sdRetBase = -1, sdRetOk = true;
    for (let cyc = 0; cyc < 10; cyc++) {
        sdRet.clear();
        for (let k = 0; k < 2000; k++) sdRet.add(k, ((k * 2654435761) % 9973) + 1);
        const cnt = sdRet.count();
        if (sdRetBase < 0) sdRetBase = cnt;
        else if (cnt !== sdRetBase) sdRetOk = false;
        if (sdRet.bytes !== sdRetBytes0) sdRetOk = false;
    }

    // ---- phase 2a-octies: advance() / advanceFrom() -- the R11 idle slide (ADR 0009). Each
    // measured step RE-PRIMES with one add (monotone-safe, independently gated 0 B/op above) and
    // then runs the advance under test, so the expire (EH) / rotate (SlidingDDSketch) / clock bump
    // (SlidingHyperLogLog) body executes on every call. A 0-B/op combined lane proves advance
    // itself allocates nothing (add is 0 B/op above, so the delta is advance). ----
    // EH advance: keep content to expire, then slide the window forward.
    const ehAdv = new ExponentialHistogram(1000, 0.01);
    let ehAdvT = 0;
    for (let k = 0; k < 4000; k++) ehAdv.add(ehAdvT++, 1);
    let ehAdvSink = 0;
    const ehAdvStep = () => {
        ehAdv.add(ehAdvT, 1);            // re-prime one bucket (keeps live content to expire)
        ehAdvT += 3;
        ehAdv.advance(ehAdvT);           // slide the window forward -> expire the now-stale buckets
        ehAdvSink = (ehAdvSink + ehAdv.bucketCount) | 0;   // observe (defeat DCE)
    };
    const ehAdvRes = measureAllocs(ehAdvStep, { iterations: 100000, batches: 8 });
    const ehAdvBpc = ehAdvRes.bytesPerCall === null ? 0 : ehAdvRes.bytesPerCall;
    const ehAdvBytes = Math.max(0, Math.round(ehAdvBpc));
    const ehAdvOk = ehAdvBytes === 0;

    // EH advanceFrom: the ZERO-BOX slide -- now = buf[0] read UNBOXED, fractional epoch-ms clock.
    const ehAdvF = new ExponentialHistogram(1000, 0.01);
    const EHAVBUF = new Float64Array(2);
    let ehAvfT = 1.75e12;
    for (let k = 0; k < 4000; k++) { EHAVBUF[0] = ehAvfT; EHAVBUF[1] = 1; ehAdvF.addFrom(EHAVBUF, 0); ehAvfT += 1.5; }
    let ehAvfSink = 0;
    const ehAvfStep = () => {
        EHAVBUF[0] = ehAvfT; EHAVBUF[1] = 1; ehAdvF.addFrom(EHAVBUF, 0);   // re-prime
        ehAvfT += 4.5; EHAVBUF[0] = ehAvfT;
        ehAdvF.advanceFrom(EHAVBUF, 0);          // slide under test (reads buf[0] UNBOXED)
        ehAvfSink = (ehAvfSink + ehAdvF.bucketCount) | 0;
    };
    const ehAvfRes = measureAllocs(ehAvfStep, { iterations: 100000, batches: 8 });
    const ehAvfBpc = ehAvfRes.bytesPerCall === null ? 0 : ehAvfRes.bytesPerCall;
    const ehAvfBytes = Math.max(0, Math.round(ehAvfBpc));
    const ehAvfOk = ehAvfBytes === 0;

    // SlidingHyperLogLog advance: clock-only bump (count() lazily expires off _now).
    const slAdv = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 12 });
    let slAdvT = 0;
    for (let k = 0; k < 4000; k++) slAdv.add(slAdvT++, (k * 2654435761) % 3000);
    let slAdvSink = 0;
    const slAdvStep = () => {
        slAdv.add(slAdvT, (slAdvT * 2654435761) % 3000);   // re-prime
        slAdvT += 3;
        slAdv.advance(slAdvT);                              // clock-only slide
        slAdvSink = (slAdvSink + slAdv.overflows) | 0;
    };
    const slAdvRes = measureAllocs(slAdvStep, { iterations: 100000, batches: 8 });
    const slAdvBpc = slAdvRes.bytesPerCall === null ? 0 : slAdvRes.bytesPerCall;
    const slAdvBytes = Math.max(0, Math.round(slAdvBpc));
    const slAdvOk = slAdvBytes === 0;

    // SlidingHyperLogLog advanceFrom: ZERO-BOX epoch-ms clock bump + large key re-prime.
    const slAdvF = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 13 });
    const SLAVBUF = new Float64Array(2);
    let slAvfNow = 1.75e12;
    for (let k = 0; k < 4000; k++) { SLAVBUF[0] = slAvfNow; SLAVBUF[1] = 9007199254740000 - ((k * 2654435761) % 3000); slAdvF.addFrom(SLAVBUF, 0); slAvfNow += 1; }
    let slAvfSink = 0;
    const slAvfStep = () => {
        SLAVBUF[0] = slAvfNow; SLAVBUF[1] = 9007199254740000 - ((slAvfNow | 0) % 3000); slAdvF.addFrom(SLAVBUF, 0);
        slAvfNow += 3.5; SLAVBUF[0] = slAvfNow;
        slAdvF.advanceFrom(SLAVBUF, 0);
        slAvfSink = (slAvfSink + slAdvF.overflows) | 0;
    };
    const slAvfRes = measureAllocs(slAvfStep, { iterations: 100000, batches: 8 });
    const slAvfBpc = slAvfRes.bytesPerCall === null ? 0 : slAvfRes.bytesPerCall;
    const slAvfBytes = Math.max(0, Math.round(slAvfBpc));
    const slAvfOk = slAvfBytes === 0;

    // SlidingDDSketch advance: slide the pane ring forward (rotate + clear stale panes).
    const sdAdv = new SlidingDDSketch(1000, { alpha: 0.01, panes: 32 });
    let sdAdvT = 0;
    for (let k = 0; k < 4000; k++) sdAdv.add(sdAdvT++, ((k * 2654435761) % 9973) + 1);
    let sdAdvSink = 0;
    const sdAdvStep = () => {
        sdAdv.add(sdAdvT, ((sdAdvT * 2654435761) % 9973) + 1);   // re-prime
        sdAdvT += 3;
        sdAdv.advance(sdAdvT);                                   // pane-ring slide
        sdAdvSink = (sdAdvSink + (sdAdv.collapsed ? 1 : 0)) | 0;
    };
    const sdAdvRes = measureAllocs(sdAdvStep, { iterations: 100000, batches: 8 });
    const sdAdvBpc = sdAdvRes.bytesPerCall === null ? 0 : sdAdvRes.bytesPerCall;
    const sdAdvBytes = Math.max(0, Math.round(sdAdvBpc));
    const sdAdvOk = sdAdvBytes === 0;

    // SlidingDDSketch advanceFrom: ZERO-BOX epoch-ms clock + fractional value re-prime, pane slide.
    const sdAdvF = new SlidingDDSketch(1000, { alpha: 0.01, panes: 32 });
    const SDAVBUF = new Float64Array(2);
    let sdAvfNow = 1.75e12;
    for (let k = 0; k < 4000; k++) { SDAVBUF[0] = sdAvfNow; SDAVBUF[1] = ((k * 40503) % 9973) + 0.5; sdAdvF.addFrom(SDAVBUF, 0); sdAvfNow += 1.5; }
    let sdAvfSink = 0, sdAvfI = 0;
    const sdAvfStep = () => {
        SDAVBUF[0] = sdAvfNow; SDAVBUF[1] = ((sdAvfI * 40503) % 9973) + 0.5; sdAdvF.addFrom(SDAVBUF, 0);
        sdAvfNow += 4.5; SDAVBUF[0] = sdAvfNow; sdAvfI = (sdAvfI + 1) | 0;
        sdAdvF.advanceFrom(SDAVBUF, 0);
        sdAvfSink = (sdAvfSink + (sdAdvF.collapsed ? 1 : 0)) | 0;
    };
    const sdAvfRes = measureAllocs(sdAvfStep, { iterations: 100000, batches: 8 });
    const sdAvfBpc = sdAvfRes.bytesPerCall === null ? 0 : sdAvfRes.bytesPerCall;
    const sdAvfBytes = Math.max(0, Math.round(sdAvfBpc));
    const sdAvfOk = sdAvfBytes === 0;

    // advance retention: construct -> fill -> advance(idle, empties the window) -> clear cycles;
    // fixed store bytes constant + windowed count returns to baseline over 10 cycles.
    let advRetOk = true, advRetBase = -1;
    const arEh = new ExponentialHistogram(1000, 0.01);
    const arSl = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 11 });
    const arSd = new SlidingDDSketch(1000, { alpha: 0.01, panes: 16 });
    const arEhCap0 = arEh.capacity, arSlB0 = arSl.bytes, arSdB0 = arSd.bytes;
    let arT = 0;
    for (let cyc = 0; cyc < 10; cyc++) {
        arEh.clear(); arSl.clear(); arSd.clear();
        for (let k = 0; k < 500; k++) { arEh.add(arT, 1); arSl.add(arT, arT); arSd.add(arT, (arT % 100) + 1); arT++; }
        const ehC = arEh.count();
        const j = arT + 2 * 1000;
        arEh.advance(j); arSl.advance(j); arSd.advance(j);        // idle slide past the window
        if (arEh.count() !== 0 || arSl.count() !== 0 || arSd.count() !== 0) advRetOk = false;
        if (!Number.isNaN(arSd.quantile(0.5))) advRetOk = false;   // drained sketch -> NaN
        if (arEh.capacity !== arEhCap0 || arSl.bytes !== arSlB0 || arSd.bytes !== arSdB0) advRetOk = false;
        if (advRetBase < 0) advRetBase = ehC; else if (ehC !== advRetBase) advRetOk = false;
        arT += 2 * 1000;   // keep the clock monotone across cycles (clear unlocks the mode anyway)
    }

    // ---- phase 2a-novies: BIG-JUMP advance lanes (closes the reviewer's coverage nit). The three
    // lanes above only step the clock by +3 / +4.5 per call, so they exercise the 0-1-bucket EH
    // expire and the 0-1-pane SlidingDDSketch rotate. Neither the EH "expire many buckets in one
    // call" path nor the SlidingDDSketch "jump >= panes widths -> grid-re-anchor" branch (the
    // awkward-to-reach path the reviewer flagged) is touched by those lanes. Each step here
    // re-fills the window near CAPACITY, then advances by many window-widths in ONE call so the
    // bounded hot loop runs to its full bound on every measured call. ----

    // EH big-jump: refill toward capacity (~300 buckets spread across W), then jump 50*W in one
    // advance -> the expire loop drains up to ~300 live buckets in a single call (vs. 0-1 above).
    const ehBig = new ExponentialHistogram(1000, 0.01);
    let ehBigT = 0;
    for (let k = 0; k < 300; k++) { ehBig.add(ehBigT, 1); ehBigT += 1000 / 300; }
    let ehBigSink = 0;
    const ehBigStep = () => {
        for (let k = 0; k < 300; k++) { ehBig.add(ehBigT, 1); ehBigT += 1000 / 300; }   // re-fill near capacity
        ehBigT += 50 * 1000;                 // BIG jump: 50 window-widths at once
        ehBig.advance(ehBigT);               // the full-cap expire loop runs to completion
        ehBigSink = (ehBigSink + ehBig.bucketCount) | 0;
    };
    const ehBigRes = measureAllocs(ehBigStep, { iterations: 5000, batches: 4 });
    const ehBigBpc = ehBigRes.bytesPerCall === null ? 0 : ehBigRes.bytesPerCall;
    const ehBigBytes = Math.max(0, Math.round(ehBigBpc));
    const ehBigOk = ehBigBytes === 0 && ehBig.bucketCount === 0;   // the big jump must ALSO empty it

    // SlidingHyperLogLog big-jump: advance is CLOCK-ONLY (O(1) regardless of jump size), but gate
    // a many-window jump anyway -- proves the clock-bump body is 0 B/op at ANY magnitude, not just
    // the small +3 step above.
    const slBig = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 14 });
    let slBigT = 0;
    let slBigK = 0;
    for (let k = 0; k < 300; k++) { slBig.add(slBigT, k); slBigT += 1000 / 300; }
    let slBigSink = 0;
    const slBigStep = () => {
        slBig.add(slBigT, (slBigK = (slBigK + 1) % 3000)); slBigT += 1000 / 300;
        slBigT += 50 * 1000;
        slBig.advance(slBigT);
        slBigSink = (slBigSink + slBig.overflows) | 0;
    };
    const slBigRes = measureAllocs(slBigStep, { iterations: 5000, batches: 4 });
    const slBigBpc = slBigRes.bytesPerCall === null ? 0 : slBigRes.bytesPerCall;
    const slBigBytes = Math.max(0, Math.round(slBigBpc));
    const slBigOk = slBigBytes === 0 && slBig.count() === 0;

    // SlidingDDSketch big-jump: refill EVERY pane (panes=32), then jump 50*W in one advance -- far
    // beyond the `rot < B` bounded-rotation cap, forcing the grid-RE-ANCHOR branch (the path that
    // clears all B panes via the loop, then re-anchors) on every measured call.
    const sdBig = new SlidingDDSketch(1000, { alpha: 0.01, panes: 32 });
    let sdBigT = 0;
    for (let k = 0; k < 300; k++) { sdBig.add(sdBigT, ((k * 40503) % 9973) + 1); sdBigT += 1000 / 300; }
    let sdBigSink = 0;
    const sdBigStep = () => {
        for (let k = 0; k < 300; k++) { sdBig.add(sdBigT, ((k * 40503) % 9973) + 1); sdBigT += 1000 / 300; }
        sdBigT += 50 * 1000;                 // BIG jump: forces the grid-re-anchor branch in _advance
        sdBig.advance(sdBigT);
        sdBigSink = (sdBigSink + (sdBig.collapsed ? 1 : 0)) | 0;
    };
    const sdBigRes = measureAllocs(sdBigStep, { iterations: 5000, batches: 4 });
    const sdBigBpc = sdBigRes.bytesPerCall === null ? 0 : sdBigRes.bytesPerCall;
    const sdBigBytes = Math.max(0, Math.round(sdBigBpc));
    const sdBigOk = sdBigBytes === 0 && sdBig.count() === 0;   // the big jump must ALSO empty it

    // ---- phase 2a-decies: an ASTRONOMICAL (1e15-scale) single-call jump -- correctness + speed,
    // not just allocation. Fresh, freshly-filled instances; one advance() each; must complete fast
    // and land on the CORRECT drained state (proves the bounded loops do not degrade into an
    // unbounded scan when `now - lastNow` is huge). ----
    let hugeOk = true;
    {
        const ehH = new ExponentialHistogram(1000, 0.01);
        for (let t = 0; t < 4000; t++) ehH.add(t, 1);
        const t0 = performance.now();
        ehH.advance(1e15);
        const dt = performance.now() - t0;
        if (ehH.count() !== 0 || ehH.bucketCount !== 0 || dt >= 50) hugeOk = false;

        const slH = new SlidingHyperLogLog(1000, { p: 10 });
        for (let t = 0; t < 4000; t++) slH.add(t, t);
        const t1 = performance.now();
        slH.advance(1e15);
        const dt1 = performance.now() - t1;
        if (slH.count() !== 0 || dt1 >= 50) hugeOk = false;

        const sdH = new SlidingDDSketch(1000, { alpha: 0.01, panes: 32 });
        for (let t = 0; t < 4000; t++) sdH.add(t, (t % 100) + 1);
        const t2 = performance.now();
        sdH.advance(1e15);
        const dt2 = performance.now() - t2;
        if (sdH.count() !== 0 || !Number.isNaN(sdH.quantile(0.5)) || dt2 >= 50) hugeOk = false;
    }

    // ---- phase 2a-undecies: SlidingCountMin -- add (two-lane hash + pane rotate/clear + per-pane
    // conservative update) + a ROTATION-EVERY-ADD lane + the ZERO-BOX stride-3 addFrom + estimate +
    // advance / advanceFrom + a BIG-JUMP (1e12) advance + clear + retention. All 0 B/op. ----
    // SlidingCountMin add: explicit-time SMI now + SMI key over a full, churning window so every measured
    // add periodically crosses a pane boundary (rotate + clear + conservative write must be 0-alloc). Primed.
    const scmAdd = new SlidingCountMin(1000, { panes: 32, w: 128, d: 4, seed: 3 });
    let scmT = 0;
    for (let k = 0; k < 4000; k++) scmAdd.add(scmT++, ((k * 2654435761) >>> 0) % 5000);
    let scmSink = 0;
    const scmStep = () => {
        scmAdd.add(scmT, ((scmT * 2654435761) >>> 0) % 5000);
        scmT = (scmT + 1) | 0;
        scmSink = (scmSink + scmAdd.saturated) | 0;   // observe state (defeat DCE)
    };
    const scmRes = measureAllocs(scmStep, { iterations: 100000, batches: 8 });
    const scmBpc = scmRes.bytesPerCall === null ? 0 : scmRes.bytesPerCall;
    const scmBytes = Math.max(0, Math.round(scmBpc));
    const scmOk = scmBytes === 0;

    // SlidingCountMin PLAIN (conservative: false) add: every other SCM add lane above uses the
    // DEFAULT conservative=true update; this is the ONLY lane measuring the plain-add branch (the
    // `else` half of add()'s per-pane write) -- same churning-window / rotate-every-so-often shape.
    const scmPlain = new SlidingCountMin(1000, { panes: 32, w: 128, d: 4, seed: 15, conservative: false });
    let scmPlainT = 0;
    for (let k = 0; k < 4000; k++) scmPlain.add(scmPlainT++, ((k * 2654435761) >>> 0) % 5000);
    let scmPlainSink = 0;
    const scmPlainStep = () => {
        scmPlain.add(scmPlainT, ((scmPlainT * 2654435761) >>> 0) % 5000);
        scmPlainT = (scmPlainT + 1) | 0;
        scmPlainSink = (scmPlainSink + scmPlain.saturated) | 0;   // observe state (defeat DCE)
    };
    const scmPlainRes = measureAllocs(scmPlainStep, { iterations: 100000, batches: 8 });
    const scmPlainBpc = scmPlainRes.bytesPerCall === null ? 0 : scmPlainRes.bytesPerCall;
    const scmPlainBytes = Math.max(0, Math.round(scmPlainBpc));
    const scmPlainOk = scmPlainBytes === 0;

    // SlidingCountMin ROTATION-EVERY-ADD: paneW = 64/64 = 1 and now += 1 per add, so EVERY measured add
    // crosses a boundary -> _advance rotates + clears a pane (the amortized fill(0) spike) on every call.
    const scmRot = new SlidingCountMin(64, { panes: 64, w: 64, d: 3, seed: 5 });
    let scmRotT = 0;
    for (let k = 0; k < 400; k++) scmRot.add(scmRotT++, ((k * 2654435761) >>> 0) % 2000);
    let scmRotSink = 0;
    const scmRotStep = () => {
        scmRot.add(scmRotT, ((scmRotT * 2654435761) >>> 0) % 2000);   // now += 1 -> rotate every add
        scmRotT = (scmRotT + 1) | 0;
        scmRotSink = (scmRotSink + scmRot.saturated) | 0;
    };
    const scmRotRes = measureAllocs(scmRotStep, { iterations: 100000, batches: 8 });
    const scmRotBpc = scmRotRes.bytesPerCall === null ? 0 : scmRotRes.bytesPerCall;
    const scmRotBytes = Math.max(0, Math.round(scmRotBpc));
    const scmRotOk = scmRotBytes === 0;

    // SlidingCountMin addFrom: epoch-ms now (non-Smi double) + key + count read UNBOXED from a packed
    // stride-3 [now, key, count] Float64Array -- the gated zero-box floor (a plain-arg add would box all).
    const scmFrom = new SlidingCountMin(1000, { panes: 32, w: 128, d: 4, seed: 7 });
    const SCMBUF = new Float64Array(3);
    let scmfNow = 1.75e12;
    for (let k = 0; k < 4000; k++) {
        scmfNow += 1.5; SCMBUF[0] = scmfNow; SCMBUF[1] = ((k * 2654435761) >>> 0) % 5000; SCMBUF[2] = (k & 7) + 1;
        scmFrom.addFrom(SCMBUF, 0);
    }
    let scmFromSink = 0, scmfI = 0;
    const scmFromStep = () => {
        scmfNow += 1.5;
        SCMBUF[0] = scmfNow; SCMBUF[1] = ((scmfI * 2654435761) >>> 0) % 5000; SCMBUF[2] = (scmfI & 7) + 1;
        scmFrom.addFrom(SCMBUF, 0);
        scmfI = (scmfI + 1) | 0;
        scmFromSink = (scmFromSink + scmFrom.saturated) | 0;
    };
    const scmFromRes = measureAllocs(scmFromStep, { iterations: 100000, batches: 8 });
    const scmFromBpc = scmFromRes.bytesPerCall === null ? 0 : scmFromRes.bytesPerCall;
    const scmFromBytes = Math.max(0, Math.round(scmFromBpc));
    const scmFromOk = scmFromBytes === 0;

    // SlidingCountMin estimate: sum-then-min over the live panes must be 0-alloc (never a per-query alloc).
    let scmEstSink = 0;
    const scmEstStep = () => {
        scmEstSink = (scmEstSink + (scmAdd.estimate(1234) > 0 ? 1 : 0)) | 0;   // observe (defeat DCE)
    };
    const scmEstRes = measureAllocs(scmEstStep, { iterations: 50000, batches: 8 });
    const scmEstBpc = scmEstRes.bytesPerCall === null ? 0 : scmEstRes.bytesPerCall;
    const scmEstBytes = Math.max(0, Math.round(scmEstBpc));
    const scmEstOk = scmEstBytes === 0;

    // SlidingCountMin advance: slide the pane ring forward (rotate + clear stale panes), re-primed each call.
    const scmAdv = new SlidingCountMin(1000, { panes: 32, w: 128, d: 4, seed: 9 });
    let scmAdvT = 0;
    for (let k = 0; k < 4000; k++) scmAdv.add(scmAdvT++, ((k * 2654435761) >>> 0) % 5000);
    let scmAdvSink = 0;
    const scmAdvStep = () => {
        scmAdv.add(scmAdvT, ((scmAdvT * 2654435761) >>> 0) % 5000);   // re-prime
        scmAdvT += 3;
        scmAdv.advance(scmAdvT);                                      // pane-ring slide
        scmAdvSink = (scmAdvSink + scmAdv.saturated) | 0;
    };
    const scmAdvRes = measureAllocs(scmAdvStep, { iterations: 100000, batches: 8 });
    const scmAdvBpc = scmAdvRes.bytesPerCall === null ? 0 : scmAdvRes.bytesPerCall;
    const scmAdvBytes = Math.max(0, Math.round(scmAdvBpc));
    const scmAdvOk = scmAdvBytes === 0;

    // SlidingCountMin advanceFrom: ZERO-BOX epoch-ms clock + stride-3 re-prime, pane slide.
    const scmAvf = new SlidingCountMin(1000, { panes: 32, w: 128, d: 4, seed: 10 });
    const SCMAVBUF = new Float64Array(3);
    let scmAvfNow = 1.75e12;
    for (let k = 0; k < 4000; k++) { SCMAVBUF[0] = scmAvfNow; SCMAVBUF[1] = ((k * 2654435761) >>> 0) % 5000; SCMAVBUF[2] = 1; scmAvf.addFrom(SCMAVBUF, 0); scmAvfNow += 1.5; }
    let scmAvfSink = 0, scmAvfI = 0;
    const scmAvfStep = () => {
        SCMAVBUF[0] = scmAvfNow; SCMAVBUF[1] = ((scmAvfI * 2654435761) >>> 0) % 5000; SCMAVBUF[2] = 1; scmAvf.addFrom(SCMAVBUF, 0);
        scmAvfNow += 4.5; SCMAVBUF[0] = scmAvfNow; scmAvfI = (scmAvfI + 1) | 0;
        scmAvf.advanceFrom(SCMAVBUF, 0);
        scmAvfSink = (scmAvfSink + scmAvf.saturated) | 0;
    };
    const scmAvfRes = measureAllocs(scmAvfStep, { iterations: 100000, batches: 8 });
    const scmAvfBpc = scmAvfRes.bytesPerCall === null ? 0 : scmAvfRes.bytesPerCall;
    const scmAvfBytes = Math.max(0, Math.round(scmAvfBpc));
    const scmAvfOk = scmAvfBytes === 0;

    // SlidingCountMin clear(): re-fill between clears so every measured clear() resets non-trivial live state.
    const scmClear = new SlidingCountMin(1000, { panes: 32, w: 128, d: 4, seed: 11 });
    for (let k = 0; k < 4000; k++) scmClear.add(k, ((k * 2654435761) >>> 0) % 5000);
    let scmClearSink = 0, scmClearI = 0;
    const scmClearStep = () => {
        scmClear.clear();
        scmClear.add(scmClearI, ((scmClearI * 2654435761) >>> 0) % 5000);   // re-seed live state
        scmClearI = (scmClearI + 1) | 0;
        scmClearSink = (scmClearSink + (scmClear.mode === 'explicit' ? 1 : 0)) | 0;
    };
    const scmClearRes = measureAllocs(scmClearStep, { iterations: 20000, batches: 8 });
    const scmClearBpc = scmClearRes.bytesPerCall === null ? 0 : scmClearRes.bytesPerCall;
    const scmClearBytes = Math.max(0, Math.round(scmClearBpc));
    const scmClearOk = scmClearBytes === 0;

    // SlidingCountMin BIG-JUMP advance: refill near capacity, then jump 1e12 in ONE advance -> the
    // grid-re-anchor branch (clears all B+1 panes via the bounded loop, then re-anchors) each call.
    const scmBig = new SlidingCountMin(1000, { panes: 32, w: 128, d: 4, seed: 12 });
    let scmBigT = 0;
    for (let k = 0; k < 300; k++) { scmBig.add(scmBigT, ((k * 40503) >>> 0) % 5000); scmBigT += 1000 / 300; }
    let scmBigSink = 0;
    const scmBigStep = () => {
        for (let k = 0; k < 300; k++) { scmBig.add(scmBigT, ((k * 40503) >>> 0) % 5000); scmBigT += 1000 / 300; }
        scmBigT += 1e12;                       // ASTRONOMICAL jump: forces the grid-re-anchor branch
        scmBig.advance(scmBigT);
        scmBigSink = (scmBigSink + scmBig.saturated) | 0;
    };
    const scmBigRes = measureAllocs(scmBigStep, { iterations: 5000, batches: 4 });
    const scmBigBpc = scmBigRes.bytesPerCall === null ? 0 : scmBigRes.bytesPerCall;
    const scmBigBytes = Math.max(0, Math.round(scmBigBpc));
    const scmBigOk = scmBigBytes === 0 && scmBig.estimate(((0 * 40503) >>> 0) % 5000) === 0;   // the jump must ALSO empty it

    // SlidingCountMin retention: bytes constant + estimate returns to baseline over 10 clear/refill cycles.
    const scmRet = new SlidingCountMin(1000, { panes: 16, w: 128, d: 4, seed: 13 });
    const scmRetBytes0 = scmRet.bytes;
    let scmRetBase = -1, scmRetOk = true;
    for (let cyc = 0; cyc < 10; cyc++) {
        scmRet.clear();
        for (let k = 0; k < 2000; k++) scmRet.add(k, ((k * 2654435761) >>> 0) % 5000);
        const e = scmRet.estimate(1234);
        if (scmRetBase < 0) scmRetBase = e;
        else if (e !== scmRetBase) scmRetOk = false;
        if (scmRet.bytes !== scmRetBytes0) scmRetOk = false;
    }

    // ---- phase 2a-duodecies: DecayedReservoir -- add (A-Res draw + min-forest sift) + a REBASE-HEAVY
    // lane (big step per add crosses DR_EXP_CAP -> the order-preserving landmark rescale every add) +
    // the ZERO-BOX stride-2 addFrom + sampleInto + clear. All 0 B/op. ----
    // DecayedReservoir add: explicit-time SMI now + value over a full, churning sample so every measured
    // add draws the PRNG, computes the log-space key, and sifts the min-forest (admit-or-drop). Primed.
    const drAdd = new DecayedReservoir(32, 100000, { seed: 3 });
    let drT = 0;
    for (let k = 0; k < 4000; k++) drAdd.add(drT++, k & 63);
    let drSink = 0;
    const drStep = () => {
        drAdd.add(drT, drT & 63);
        drT = (drT + 1) | 0;
        drSink = (drSink + drAdd.size) | 0;   // observe state (defeat DCE)
    };
    const drRes = measureAllocs(drStep, { iterations: 100000, batches: 8 });
    const drBpc = drRes.bytesPerCall === null ? 0 : drRes.bytesPerCall;
    const drBytes = Math.max(0, Math.round(drBpc));
    const drOk = drBytes === 0;

    // DecayedReservoir REBASE-HEAVY add: a big step per add so lambda*(t - L) crosses DR_EXP_CAP on
    // EVERY add -> the cold, order-preserving landmark rebase (a common-factor rescale of the <= k
    // live keys) fires every call and MUST stay 0-alloc.
    const drReb = new DecayedReservoir(32, 10, { seed: 4 });
    let drRebT = 0;
    for (let k = 0; k < 4000; k++) { drRebT += 700; drReb.add(drRebT, k & 63); }
    let drRebSink = 0;
    const drRebStep = () => {
        drRebT += 700;                         // one step > DR_EXP_CAP/lambda -> rebase every add
        drReb.add(drRebT, drRebT & 63);
        drRebSink = (drRebSink + drReb.size) | 0;
    };
    const drRebRes = measureAllocs(drRebStep, { iterations: 100000, batches: 8 });
    const drRebBpc = drRebRes.bytesPerCall === null ? 0 : drRebRes.bytesPerCall;
    const drRebBytes = Math.max(0, Math.round(drRebBpc));
    const drRebOk = drRebBytes === 0;

    // DecayedReservoir addFrom: epoch-ms now (non-Smi double) + value read UNBOXED from a packed
    // stride-2 [now, value] Float64Array -- the gated zero-box floor (a plain-arg add would box both).
    const drFrom = new DecayedReservoir(32, 100000, { seed: 7 });
    const DRBUF = new Float64Array(2);
    let drfNow = 1.75e12;
    for (let k = 0; k < 4000; k++) { drfNow += 1.5; DRBUF[0] = drfNow; DRBUF[1] = k & 63; drFrom.addFrom(DRBUF, 0); }
    let drFromSink = 0, drfI = 0;
    const drFromStep = () => {
        drfNow += 1.5;
        DRBUF[0] = drfNow; DRBUF[1] = drfI & 63;
        drFrom.addFrom(DRBUF, 0);
        drfI = (drfI + 1) | 0;
        drFromSink = (drFromSink + drFrom.size) | 0;
    };
    const drFromRes = measureAllocs(drFromStep, { iterations: 100000, batches: 8 });
    const drFromBpc = drFromRes.bytesPerCall === null ? 0 : drFromRes.bytesPerCall;
    const drFromBytes = Math.max(0, Math.round(drFromBpc));
    const drFromOk = drFromBytes === 0;

    // DecayedReservoir add BOXED-DIAG: the SAME fractional stream via add(now, value) -- diagnostic only
    // (add boxes each fractional arg; addFrom above is the gated 0-B/op floor). NOT gated.
    const drBoxed = new DecayedReservoir(32, 100000, { seed: 8 });
    let drbNow = 1.75e12;
    for (let k = 0; k < 4000; k++) { drbNow += 1.5; drBoxed.add(drbNow, k & 63); }
    let drBoxedSink = 0, drbI = 0;
    const drBoxedStep = () => {
        drbNow += 1.5;
        drBoxed.add(drbNow, drbI & 63);
        drbI = (drbI + 1) | 0;
        drBoxedSink = (drBoxedSink + drBoxed.size) | 0;
    };
    const drBoxedRes = measureAllocs(drBoxedStep, { iterations: 100000, batches: 8 });
    const drBoxedBpc = drBoxedRes.bytesPerCall === null ? 0 : drBoxedRes.bytesPerCall;
    const drBoxedBytes = Math.max(0, Math.round(drBoxedBpc));

    // DecayedReservoir sampleInto: 0-alloc copy of the current sample values (never a per-read alloc).
    const DRSAMP = new Float64Array(32);
    let drSampSink = 0;
    const drSampStep = () => {
        drSampSink = (drSampSink + drAdd.sampleInto(DRSAMP)) | 0;   // observe (defeat DCE)
    };
    const drSampRes = measureAllocs(drSampStep, { iterations: 50000, batches: 8 });
    const drSampBpc = drSampRes.bytesPerCall === null ? 0 : drSampRes.bytesPerCall;
    const drSampBytes = Math.max(0, Math.round(drSampBpc));
    const drSampOk = drSampBytes === 0;

    // DecayedReservoir clear(): re-fill between clears so every measured clear() resets non-trivial state.
    const drClear = new DecayedReservoir(32, 100000, { seed: 11 });
    for (let k = 0; k < 4000; k++) drClear.add(k, k & 63);
    let drClearSink = 0, drClearI = 0;
    const drClearStep = () => {
        drClear.clear();
        drClear.add(drClearI, drClearI & 63);   // re-seed live state
        drClearI = (drClearI + 1) | 0;
        drClearSink = (drClearSink + (drClear.mode === 'explicit' ? 1 : 0)) | 0;
    };
    const drClearRes = measureAllocs(drClearStep, { iterations: 20000, batches: 8 });
    const drClearBpc = drClearRes.bytesPerCall === null ? 0 : drClearRes.bytesPerCall;
    const drClearBytes = Math.max(0, Math.round(drClearBpc));
    const drClearOk = drClearBytes === 0;

    // DecayedReservoir retention: bytes constant + sample re-fills over 10 clear/refill cycles.
    const drRet = new DecayedReservoir(16, 100000, { seed: 13 });
    const drRetBytes0 = drRet.bytes;
    let drRetOk = true;
    for (let cyc = 0; cyc < 10; cyc++) {
        drRet.clear();
        for (let k = 0; k < 2000; k++) drRet.add(k, k & 63);
        if (drRet.size !== 16) drRetOk = false;
        if (drRet.bytes !== drRetBytes0) drRetOk = false;
    }

    // ---- phase 2b: GC budget over a long hot run (millions of add + reshaping ops) ----
    const gc = new GcProfiler().start();
    const HOT = 4000000;
    let SINK = 0;
    for (let i = 0; i < HOT; i++) {
        addStep(); addTStep(); adStep(); fdStep(); fdRebStep(); ehFromStep(); fdFromStep();
        hkStep(); hkFromStep(); adFromStep(); hkClearStep();
        slStep(); slFromStep(); slClearStep();
        ddPhStep(); ddCuStep(); ddFromStep(); ddClearStep();
        sdStep(); sdFromStep();
        ehAdvStep(); ehAvfStep(); slAdvStep(); slAvfStep(); sdAdvStep(); sdAvfStep();
        scmStep(); scmPlainStep(); scmRotStep(); scmFromStep(); scmEstStep(); scmAdvStep(); scmAvfStep();
        drStep(); drRebStep(); drFromStep(); drSampStep();
    }
    // big-jump lanes are heavier per call (a window-refill inside the step) -- run them separately,
    // outside the 4M-iteration HOT loop, at their own (already-measured) iteration count above; fold
    // their sinks into the same anti-DCE accumulator.
    SINK += addSink + addTSink + adSink + fpSink + frSink + ehFromSink + fdFromSink + ehBoxedSink + fdBoxedSink +
        hkSink + hkFromSink + hkBoxedSink + adFromSink + hkClearSink + slSink + slFromSink + slClearSink +
        ddPhSink + ddCuSink + ddFromSink + ddClearSink +
        sdSink + sdFromSink + sdQSink + sdIntoSink + sdClearSink +
        ehAdvSink + ehAvfSink + slAdvSink + slAvfSink + sdAdvSink + sdAvfSink +
        ehBigSink + slBigSink + sdBigSink +
        scmSink + scmPlainSink + scmRotSink + scmFromSink + scmEstSink + scmAdvSink + scmAvfSink +
        scmClearSink + scmBigSink +
        drSink + drRebSink + drFromSink + drBoxedSink + drSampSink + drClearSink;
    await sleep(50);
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });

    // ---- phase 2c: arrayBuffers growth (the fixed pool grows no store across reuse) ----
    // Construct the reuse instances FIRST (a one-time, expected store allocation), THEN capture the
    // baseline: the loop below must add / query / clear over 500 cycles WITHOUT growing the store.
    const reuse = new ExponentialHistogram(2048, 0.01);
    const reuseAd = new ADWIN(0.1);
    const reuseHk = new HeavyKeeper(4, 512, 16, { seed: 9 });
    const reuseSl = new SlidingHyperLogLog(2048, { p: 10, ringCap: 8, seed: 10 });
    const reuseSd = new SlidingDDSketch(2048, { alpha: 0.01, panes: 16 });
    const reuseScm = new SlidingCountMin(2048, { panes: 16, w: 128, d: 4, seed: 14 });
    const reuseDr = new DecayedReservoir(32, 100000, { seed: 16 });
    globalThis.gc();
    const abBefore = process.memoryUsage().arrayBuffers;
    let reuseSlT = 0, reuseSdT = 0, reuseScmT = 0, reuseDrT = 0;
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
        for (let k = 0; k < 8192; k++) reuseSd.add(reuseSdT++, ((k * 2654435761) % 9973) + 1);  // pane rotate + collapse
        reuseSd.quantile(0.99);
        reuseSd.clear();                                // reuse the arrays, no new store
        for (let k = 0; k < 8192; k++) reuseScm.add(reuseScmT++, ((k * 2654435761) >>> 0) % 5000);  // pane rotate + conservative
        reuseScm.estimate(1234);
        reuseScm.clear();                               // reuse the arrays, no new store
        for (let k = 0; k < 8192; k++) reuseDr.add(reuseDrT++, (k * 2654435761) % 3000);  // A-Res draw + forest sift + rebase
        reuseDr.sampleInto(DRSAMP);
        reuseDr.clear();                                // reuse the columns, no new store
    }
    globalThis.gc();
    const abAfter = process.memoryUsage().arrayBuffers;
    const abDelta = abAfter - abBefore;
    const abOk = abDelta <= 0;

    // ---- verdict + GATE line ----
    const ok = trackedOk && live === 0 && findings.length === 0 &&
        addOk && addTOk && adOk && fdOk && fdRebOk && ehFromOk && fdFromOk &&
        hkOk && hkFromOk && adFromOk && hkClearOk && slOk && slFromOk && slClearOk &&
        ddPhOk && ddCuOk && ddFromOk && ddClearOk &&
        sdOk && sdFromOk && sdQOk && sdIntoOk && sdClearOk && sdRetOk &&
        ehAdvOk && ehAvfOk && slAdvOk && slAvfOk && sdAdvOk && sdAvfOk && advRetOk &&
        ehBigOk && slBigOk && sdBigOk && hugeOk &&
        scmOk && scmPlainOk && scmRotOk && scmFromOk && scmEstOk && scmAdvOk && scmAvfOk && scmClearOk && scmBigOk && scmRetOk &&
        drOk && drRebOk && drFromOk && drSampOk && drClearOk && drRetOk &&
        report.ok && abOk;
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
        ddClearBytes + ' B/op (DriftDetector clear) ' +
        sdBytes + ' B/op (SlidingDDSketch add + pane rotate + collapse) ' +
        sdFromBytes + ' B/op (SlidingDDSketch addFrom fractional) ' +
        sdQBytes + ' B/op (SlidingDDSketch quantile merge) ' +
        sdIntoBytes + ' B/op (SlidingDDSketch quantileInto) ' +
        sdClearBytes + ' B/op (SlidingDDSketch clear) ' +
        ehAdvBytes + ' B/op (ExponentialHistogram advance) ' +
        ehAvfBytes + ' B/op (ExponentialHistogram advanceFrom) ' +
        slAdvBytes + ' B/op (SlidingHyperLogLog advance) ' +
        slAvfBytes + ' B/op (SlidingHyperLogLog advanceFrom) ' +
        sdAdvBytes + ' B/op (SlidingDDSketch advance) ' +
        sdAvfBytes + ' B/op (SlidingDDSketch advanceFrom) ' +
        scmBytes + ' B/op (SlidingCountMin add + pane rotate + conservative) ' +
        scmPlainBytes + ' B/op (SlidingCountMin add conservative:false) ' +
        scmRotBytes + ' B/op (SlidingCountMin rotate-every-add) ' +
        scmFromBytes + ' B/op (SlidingCountMin addFrom stride-3) ' +
        scmEstBytes + ' B/op (SlidingCountMin estimate sum-then-min) ' +
        scmAdvBytes + ' B/op (SlidingCountMin advance) ' +
        scmAvfBytes + ' B/op (SlidingCountMin advanceFrom) ' +
        scmClearBytes + ' B/op (SlidingCountMin clear) ' +
        scmBigBytes + ' B/op (SlidingCountMin big-jump advance) ' +
        drBytes + ' B/op (DecayedReservoir add + A-Res draw + forest sift) ' +
        drRebBytes + ' B/op (DecayedReservoir add rebase-heavy) ' +
        drFromBytes + ' B/op (DecayedReservoir addFrom fractional) ' +
        drSampBytes + ' B/op (DecayedReservoir sampleInto) ' +
        drClearBytes + ' B/op (DecayedReservoir clear)' +
        ' | ' + (ok ? 'ok' : 'FAIL') +
        ' (tracked=' + trackedMid + ' sink=' + SINK + ' abGrowth=' + abDelta +
        ' diag: add-boxed-fractional EH=' + ehBoxedBytes + ' B/op FD=' + fdBoxedBytes +
        ' B/op HeavyKeeper add-boxed-large-u32=' + hkBoxedBytes +
        ' B/op DecayedReservoir add-boxed-fractional=' + drBoxedBytes + ' B/op)');

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
        if (!sdOk) console.error('  alloc ' + sdBytes + ' B/op SlidingDDSketch add (raw ' + sdBpc + ')');
        if (!sdFromOk) console.error('  alloc ' + sdFromBytes + ' B/op SlidingDDSketch addFrom (raw ' + sdFromBpc + ')');
        if (!sdQOk) console.error('  alloc ' + sdQBytes + ' B/op SlidingDDSketch quantile (raw ' + sdQBpc + ')');
        if (!sdIntoOk) console.error('  alloc ' + sdIntoBytes + ' B/op SlidingDDSketch quantileInto (raw ' + sdIntoBpc + ')');
        if (!sdClearOk) console.error('  alloc ' + sdClearBytes + ' B/op SlidingDDSketch clear (raw ' + sdClearBpc + ')');
        if (!sdRetOk) console.error('  retention: SlidingDDSketch bytes/count drifted over clear/refill cycles');
        if (!ehAdvOk) console.error('  alloc ' + ehAdvBytes + ' B/op ExponentialHistogram advance (raw ' + ehAdvBpc + ')');
        if (!ehAvfOk) console.error('  alloc ' + ehAvfBytes + ' B/op ExponentialHistogram advanceFrom (raw ' + ehAvfBpc + ')');
        if (!slAdvOk) console.error('  alloc ' + slAdvBytes + ' B/op SlidingHyperLogLog advance (raw ' + slAdvBpc + ')');
        if (!slAvfOk) console.error('  alloc ' + slAvfBytes + ' B/op SlidingHyperLogLog advanceFrom (raw ' + slAvfBpc + ')');
        if (!sdAdvOk) console.error('  alloc ' + sdAdvBytes + ' B/op SlidingDDSketch advance (raw ' + sdAdvBpc + ')');
        if (!sdAvfOk) console.error('  alloc ' + sdAvfBytes + ' B/op SlidingDDSketch advanceFrom (raw ' + sdAvfBpc + ')');
        if (!advRetOk) console.error('  retention: advance idle-slide bytes/count drifted over cycles');
        if (!scmOk) console.error('  alloc ' + scmBytes + ' B/op SlidingCountMin add (raw ' + scmBpc + ')');
        if (!scmPlainOk) console.error('  alloc ' + scmPlainBytes + ' B/op SlidingCountMin add conservative:false (raw ' + scmPlainBpc + ')');
        if (!scmRotOk) console.error('  alloc ' + scmRotBytes + ' B/op SlidingCountMin rotate-every-add (raw ' + scmRotBpc + ')');
        if (!scmFromOk) console.error('  alloc ' + scmFromBytes + ' B/op SlidingCountMin addFrom (raw ' + scmFromBpc + ')');
        if (!scmEstOk) console.error('  alloc ' + scmEstBytes + ' B/op SlidingCountMin estimate (raw ' + scmEstBpc + ')');
        if (!scmAdvOk) console.error('  alloc ' + scmAdvBytes + ' B/op SlidingCountMin advance (raw ' + scmAdvBpc + ')');
        if (!scmAvfOk) console.error('  alloc ' + scmAvfBytes + ' B/op SlidingCountMin advanceFrom (raw ' + scmAvfBpc + ')');
        if (!scmClearOk) console.error('  alloc ' + scmClearBytes + ' B/op SlidingCountMin clear (raw ' + scmClearBpc + ')');
        if (!scmBigOk) console.error('  alloc ' + scmBigBytes + ' B/op SlidingCountMin big-jump advance (raw ' + scmBigBpc + ') or not emptied');
        if (!scmRetOk) console.error('  retention: SlidingCountMin bytes/estimate drifted over clear/refill cycles');
        if (!drOk) console.error('  alloc ' + drBytes + ' B/op DecayedReservoir add (raw ' + drBpc + ')');
        if (!drRebOk) console.error('  alloc ' + drRebBytes + ' B/op DecayedReservoir add rebase-heavy (raw ' + drRebBpc + ')');
        if (!drFromOk) console.error('  alloc ' + drFromBytes + ' B/op DecayedReservoir addFrom (raw ' + drFromBpc + ')');
        if (!drSampOk) console.error('  alloc ' + drSampBytes + ' B/op DecayedReservoir sampleInto (raw ' + drSampBpc + ')');
        if (!drClearOk) console.error('  alloc ' + drClearBytes + ' B/op DecayedReservoir clear (raw ' + drClearBpc + ')');
        if (!drRetOk) console.error('  retention: DecayedReservoir bytes/size drifted over clear/refill cycles');
        if (!report.ok) console.error('  gc ' + JSON.stringify(report.violations));
        if (!abOk) console.error('  arrayBuffers growth ' + abDelta + ' (expected <= 0)');
        process.exitCode = 1;
    }
}

main();
