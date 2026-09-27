// @zakkster/lite-adaptive -- DemoProbe (repo-only measurement tool; NOT a node:test file).
//
// A steady-state bytes/op probe for the DEMO hot kernels. It exists because the demo's measureAllocs
// gates CANNOT see a TRANSIENT box -- a HeapNumber that dies young (D3/D4 blocker 2): renderHkPrep with
// big (>= 2^31) keys boxed 192 B/call into Map.get, and a per-frame sl.count() boxed 16 B/frame, yet
// both read 0.000 under measureAllocs. This measures the V8 new-space used-size delta over K ops with no
// GC in the window, minus an empty-loop baseline -- so a transient box is visible.
//
// It REUSES the proven measurement primitives from test/perf/AllocProbe.mjs (steadyMin does the
// window minimum + the pinned-semi-space fail-closed check); it only adds DEMO lanes and a child runner
// so the demo tests can import package-internal test helpers (DEMO.md: demo tests may). The P1 (EH /
// ADWIN) lanes can adopt this same runner later -- add a { setup, hot } pair to LANES and gate it.
//
// Run one lane in a pinned child:
//   node --expose-gc --min-semi-space-size=4 --max-semi-space-size=4 demo/DemoProbe.mjs hk_render_big
// or import { runDemoLane } and drive it from Demo.test.mjs.
//
// RULE (AllocProbe R3): the drivers never box. Every fractional value lives in a Float64Array slot;
// loop indices are Smi ints; sinks accumulate into a Float64Array; a getter return that is an int32
// (hk.size, sl.overflows, a flat[] slot) is the ONLY thing sunk -- never a fractional double return.

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { steadyMin } from '../test/perf/AllocProbe.mjs';
import {
    createAllocState,
    createHkWorld, stepHk, stepHkOracle, renderHkPrep,
    HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, HK_KEY_SMALL, HK_KEY_BIG, HK_WEIGHT_MAX, H_SIZE,
    createShllWorld, stepShll, stepShllOracle, renderShllPrep,
    SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, S_OVF_A,
    // P1 (EH / ADWIN) lanes
    createEhWorld, stepEhGuarded, stepEhOracle, renderEhPrep, EH_DEFAULT_W, EH_DEFAULT_EPS,
    createAdWorld, stepAd, stepAdGhost, stepAdOracle, renderAdPrep, AD_DEFAULT_DELTA,
    // P3 (DD / SLD) lanes
    createDdWorld, stepDd, stepDdOracle, renderDdPrep, DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD, G_PH_FIRES,
    createSldWorld, stepSld, stepSldOracle, renderSldPrep,
    SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, SLD_MODE_STRICT, SLD_MODE_RANGE, Q_COUNT,
} from './kernels.mjs';

const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// controls (teeth): a lane that MUST box, and an empty lane that must read ~0.
// ---------------------------------------------------------------------------

// MUST-BOX control: box EXACTLY one ~16 B HeapNumber per op (a fractional slot value stored into a
// PACKED_ELEMENTS array element crosses a boundary V8 does not elide). If this ever reads 0, the probe
// has gone blind and every 0-B/op gate below is vacuous.
const MUSTBOX_ARR = [{}, 0];
const mustbox = {
    setup() { const v = new Float64Array(1); v[0] = 0.5; return { v, acc: new Float64Array(1) }; },
    hot(s, n) { const v = s.v, acc = s.acc; for (let i = 0; i < n; i++) { v[0] += 1.0; MUSTBOX_ARR[1] = v[0]; acc[0] += 1; } },
};
const noop = {
    setup() { const acc = new Float64Array(1); return { acc }; },
    hot(s, n) { const acc = s.acc; for (let i = 0; i < n; i++) acc[0] += 1; },
};

// ---------------------------------------------------------------------------
// demo lanes. Each hot op is one real demo-kernel call; the sink is an int32 getter / flat slot only.
// ---------------------------------------------------------------------------

function hkWorldBuilt(km, wt) {
    const w = createHkWorld(HK_DEFAULT_D, HK_DEFAULT_W, HK_DEFAULT_K, 0x99, km, wt);
    const a = createAllocState();
    for (let i = 0; i < 400; i++) { stepHk(w); stepHkOracle(w, a); }
    return { w, a, acc: new Float64Array(1) };
}

// GATED lane: renderHkPrep on BIG (>= 2^31) keys at the saturating weight -- the render path blocker 1
// fixed (Map.get keyed by the untransformed Smi index). Must read <= 0.5 B/op steady.
const hk_render_big = {
    setup() { return hkWorldBuilt(HK_KEY_BIG, HK_WEIGHT_MAX); },
    hot(s, n) { const w = s.w, a = s.a, acc = s.acc, flat = w.flat; for (let i = 0; i < n; i++) { renderHkPrep(w, a); acc[0] += flat[H_SIZE]; } },
};
// GATED lane: stepHk on BIG keys -- the per-frame add path (zero-box F3). Must read <= 0.5 B/op steady.
const hk_step_big = {
    setup() { return hkWorldBuilt(HK_KEY_BIG, HK_WEIGHT_MAX); },
    hot(s, n) { const w = s.w, acc = s.acc; for (let i = 0; i < n; i++) { stepHk(w); acc[0] += w.hk.size; } },
};
// GATED lane: renderHkPrep on the small-key baseline (the render was already 0; proves the fix did not
// regress the common path). Must read <= 0.5 B/op steady.
const hk_render_small = {
    setup() { return hkWorldBuilt(HK_KEY_SMALL, 1); },
    hot(s, n) { const w = s.w, a = s.a, acc = s.acc, flat = w.flat; for (let i = 0; i < n; i++) { renderHkPrep(w, a); acc[0] += flat[H_SIZE]; } },
};

function shllWorldBuilt(qe) {
    const w = createShllWorld(SHLL_DEFAULT_W, SHLL_DEFAULT_P, SHLL_DEFAULT_RINGCAP, 0x1234, qe);
    const a = createAllocState();
    for (let i = 0; i < 400; i++) { stepShll(w); stepShllOracle(w, a); }
    return { w, a, acc: new Float64Array(1) };
}

// GATED lane: stepShll with the query-every-frame cadence "engaged" -- blocker 2 moved the boxing
// count() OFF the per-frame path onto the 10Hz tick, so this is now HONESTLY 0. Must read <= 0.5 B/op.
const shll_step_q1 = {
    setup() { return shllWorldBuilt(1); },
    hot(s, n) { const w = s.w, acc = s.acc; for (let i = 0; i < n; i++) { stepShll(w); acc[0] += (w.sink | 0); } },
};
// GATED lane: stepShll never queried. Must read <= 0.5 B/op steady.
const shll_step_never = {
    setup() { return shllWorldBuilt(Infinity); },
    hot(s, n) { const w = s.w, acc = s.acc; for (let i = 0; i < n; i++) { stepShll(w); acc[0] += (w.sink | 0); } },
};
// DOCUMENTED-COST lane (NOT gated at 0): renderShllPrep queries the display twin slD.count() EVERY tick
// for the display estimate, whose double return boxes ~16 B once per call -- the documented one-boxed-
// return (lite-law: a query read at 10-15 Hz boxes once; say so). Built with cadence Infinity ("never")
// so slA is NOT also queried here -- this lane isolates the ONE display-count() box (~16 B), matching the
// DEMO.md D4 line. It proves the probe SEES that 16 B the measureAllocs gate reads as a false 0.
const shll_render = {
    setup() { return shllWorldBuilt(Infinity); },
    hot(s, n) { const w = s.w, a = s.a, acc = s.acc, flat = w.flat; for (let i = 0; i < n; i++) { renderShllPrep(w, a); acc[0] += flat[S_OVF_A]; } },
};

// ---------------------------------------------------------------------------
// P1 (EH / ADWIN) lanes. Same discipline: each hot op is one real demo-kernel call, the sink is an int32
// getter (bucketCount, always Smi). The per-frame lanes are GATED at <= 0.5 B/op (unboxed addFrom + int
// folds). renderEhPrep is ALSO gated <= 0.5: eh.count() / eh.sum() return INTEGER (Smi-range) doubles at
// these configs, so nothing boxes. renderAdPrep is gated <= 0.5 TOO: ad.mean / ad.variance return
// fractional doubles, but renderAdPrep keeps every value in a Float64Array slot end to end and returns an
// int32 fold, so V8 elides those getter returns in the optimized steady state (see the adRenderLane
// comment). The 16 B box appears ONLY when a getter return escapes -- isolated by the ad_mean_sink /
// ad_variance_sink controls below, which MUST fail the 0 gate (teeth: the probe genuinely sees the box).
// ---------------------------------------------------------------------------

function ehFrameBuilt(W, eps, seed, opts) {
    const w = createEhWorld(W, eps, seed, opts);
    const a = createAllocState();
    for (let i = 0; i < 400; i++) { stepEhGuarded(w); stepEhOracle(w, a); }
    return { w, a, acc: new Float64Array(1) };
}
// GATED per-frame lane: stepEhGuarded (guarded add path) + stepEhOracle (exact ring). <= 0.5 B/op steady.
function ehFrameLane(W, eps, seed, opts) {
    return {
        setup() { return ehFrameBuilt(W, eps, seed, opts); },
        hot(s, n) { const w = s.w, a = s.a, acc = s.acc; for (let i = 0; i < n; i++) { stepEhGuarded(w); stepEhOracle(w, a); acc[0] += w.eh.bucketCount; } },
    };
}
// GATED render lane: renderEhPrep (~10Hz). Smi-range getter returns -> <= 0.5 B/op steady.
function ehRenderLane(W, eps, seed, opts) {
    return {
        setup() { return ehFrameBuilt(W, eps, seed, opts); },
        hot(s, n) { const w = s.w, a = s.a, acc = s.acc; for (let i = 0; i < n; i++) { renderEhPrep(w, a); acc[0] += w.eh.bucketCount; } },
    };
}

const eh_frame_default = ehFrameLane(EH_DEFAULT_W, EH_DEFAULT_EPS, 1);
const eh_frame_dense10k = ehFrameLane(1024, 0.05, 3, { preset: 'dense10k' });
const eh_frame_spike = ehFrameLane(1024, 0.1, 4, { values: 'spike' });
const eh_render_spike = ehRenderLane(1024, 0.1, 4, { values: 'spike' });
const eh_render_dense10k = ehRenderLane(1024, 0.05, 3, { preset: 'dense10k' });

function adFrameBuilt(delta, seed, offset, preset, warm) {
    const w = createAdWorld(delta, seed, offset, preset);
    const a = createAllocState();
    for (let i = 0; i < warm; i++) { stepAd(w); stepAdGhost(w); stepAdOracle(w, a); }
    return { w, a, acc: new Float64Array(1) };
}
// GATED per-frame lane: stepAd + stepAdGhost + stepAdOracle (all unboxed, int folds). <= 0.5 B/op steady.
function adFrameLane(delta, seed, offset, preset) {
    return {
        setup() { return adFrameBuilt(delta, seed, offset, preset, 0); },
        hot(s, n) { const w = s.w, a = s.a, acc = s.acc; for (let i = 0; i < n; i++) { stepAd(w); stepAdGhost(w); stepAdOracle(w, a); acc[0] += w.ad.bucketCount; } },
    };
}
// GATED render lane: renderAdPrep on the 10Hz path. ad.mean / ad.variance DO return fractional doubles
// that box 16 B when their return ESCAPES (see the ad_mean_sink / ad_variance_sink controls below), but
// renderAdPrep keeps every value in a Float64Array slot end to end (lite-law) and returns an int32 fold,
// so V8 elides the getter returns and the whole render measures <= 0.5 B/op steady. (HEAD boxed 48 B/call:
// its `return mean` sank a fractional double across the render boundary.) Pre-stepped to a realistic width.
function adRenderLane(delta, seed, offset, preset, warm) {
    return {
        setup() { return adFrameBuilt(delta, seed, offset, preset, warm); },
        hot(s, n) { const w = s.w, a = s.a, acc = s.acc; for (let i = 0; i < n; i++) { acc[0] += renderAdPrep(w, a); } },
    };
}
// MUST-BOX controls (teeth): sink ad.mean / ad.variance -- a FRACTIONAL double return escaping into a
// retaining PACKED_ELEMENTS slot boxes exactly one ~16 B HeapNumber per op. These prove the probe SEES the
// getter box, so renderAdPrep's <= 0.5 reading above is genuine elision, not a blind probe.
const AD_SINK = [{}, 0];
const ad_mean_sink = {
    setup() { return adFrameBuilt(0.002, 5, 1.7e12, null, 300); },
    hot(s, n) { const w = s.w, acc = s.acc; for (let i = 0; i < n; i++) { AD_SINK[1] = w.ad.mean; acc[0] += 1; } },
};
const ad_variance_sink = {
    setup() { return adFrameBuilt(0.002, 5, 1.7e12, null, 300); },
    hot(s, n) { const w = s.w, acc = s.acc; for (let i = 0; i < n; i++) { AD_SINK[1] = w.ad.variance; acc[0] += 1; } },
};

const ad_frame_default = adFrameLane(AD_DEFAULT_DELTA, 7, 0, null);
const ad_frame_offset = adFrameLane(0.002, 5, 1.7e12, null);
const ad_frame_preset = adFrameLane(0.002, 5, 0, 'bigJumpThenPlus1');
const ad_render_default = adRenderLane(AD_DEFAULT_DELTA, 7, 0, null, 300);
const ad_render_offset = adRenderLane(0.002, 5, 1.7e12, null, 300);
const ad_render_preset = adRenderLane(0.002, 5, 0, 'bigJumpThenPlus1', 1300);

// ---------------------------------------------------------------------------
// P3 (DD / SLD) lanes. DD frame = stepDd feeding the UNLATCHED + LATCHED twins (4 detectors, addFrom
// unboxed); DD render = renderDdPrep (six fractional statistic / mean getters, each behind a
// _guardFinite() branch V8 will not fully inline -- a DOCUMENTED ~48 B/tick box, see dd_render's band).
// SLD frame = stepSld in RANGE mode (the rejected-value advanceFrom path engaged); SLD render =
// renderSldPrep through quantileInto (F5, 0 B/call). The MUST-BOX control sld_quantile_box sinks the
// scalar sd.quantile() return (its documented one boxed 16 B), proving the render's 0 is genuine
// quantileInto elision, not a blind probe.
// ---------------------------------------------------------------------------

function ddWorldBuilt(latch) {
    const w = createDdWorld(DD_DEFAULT_DELTA, DD_DEFAULT_THRESHOLD, latch);
    const a = createAllocState();
    for (let i = 0; i < 400; i++) { stepDd(w); stepDdOracle(w, a); }
    return { w, a, acc: new Float64Array(1) };
}
// GATED per-frame lane: stepDd (4 detectors' unboxed addFrom + int folds) with the LATCHED twins engaged.
// 0 B/op steady under DEFAULT flags (the library holds every value in a Float64Array slot end to end).
const dd_frame = {
    setup() { return ddWorldBuilt(true); },
    hot(s, n) { const w = s.w, acc = s.acc; for (let i = 0; i < n; i++) { stepDd(w); acc[0] += (w.sink | 0); } },
};
// GATED per-frame CONTROL: stepDd with the latch DISPLAY flag off (latchOn:false). createDdWorld always
// builds all FOUR detectors and stepDd always feeds them, so this measures the SAME hot path as dd_frame
// -- it proves the frame allocation does NOT depend on the latch display toggle (both read identically and
// go to 0 together once the latched-PH per-fire box lands). <= 0.5 B/op steady under DEFAULT flags.
const dd_frame_nolatch = {
    setup() { return ddWorldBuilt(false); },
    hot(s, n) { const w = s.w, acc = s.acc; for (let i = 0; i < n; i++) { stepDd(w); acc[0] += (w.sink | 0); } },
};
// DOCUMENTED-COST render lane (NOT gated at 0): renderDdPrep (~10Hz) reads six fractional statistic / mean
// getters in one unit. Each calls _guardFinite() (Adaptive.js); six of them in one function exhaust V8's
// cumulative inlining budget, so three run out of line and their fractional returns box -- ~48 B/tick, a
// documented cost (dd_render band [44, 52] in the P3 test).
const dd_render = {
    setup() { return ddWorldBuilt(true); },
    hot(s, n) { const w = s.w, a = s.a, acc = s.acc, flat = w.flat; for (let i = 0; i < n; i++) { renderDdPrep(w, a); acc[0] += (flat[G_PH_FIRES] | 0); } },
};

function sldWorldBuilt(mode) {
    const w = createSldWorld(SLD_DEFAULT_W, SLD_DEFAULT_ALPHA, SLD_DEFAULT_PANES, mode);
    const a = createAllocState();
    for (let i = 0; i < 400; i++) { stepSld(w); stepSldOracle(w, a); }
    return { w, a, acc: new Float64Array(1) };
}
// GATED per-frame lane: stepSld in RANGE mode -- the rejected-value pre-check + advanceFrom path engaged
// (the lognormal stream's tails fall outside [1, 20]). <= 0.5 B/op steady.
const sld_frame_range = {
    setup() { return sldWorldBuilt(SLD_MODE_RANGE); },
    hot(s, n) { const w = s.w, acc = s.acc; for (let i = 0; i < n; i++) { stepSld(w); acc[0] += (w.sink | 0); } },
};
// GATED per-frame lane: stepSld in STRICT (span-based) mode. <= 0.5 B/op steady.
const sld_frame_strict = {
    setup() { return sldWorldBuilt(SLD_MODE_STRICT); },
    hot(s, n) { const w = s.w, acc = s.acc; for (let i = 0; i < n; i++) { stepSld(w); acc[0] += (w.sink | 0); } },
};
// GATED render lane: renderSldPrep through quantileInto (F5, 0 B/call) -- was 3x scalar quantile() = 48 B.
// <= 0.5 B/op steady.
const sld_render = {
    setup() { return sldWorldBuilt(SLD_MODE_RANGE); },
    hot(s, n) { const w = s.w, a = s.a, acc = s.acc, flat = w.flat; for (let i = 0; i < n; i++) { renderSldPrep(w, a); acc[0] += (flat[Q_COUNT] | 0); } },
};
// MUST-BOX control (teeth): the scalar sd.quantile() keeps ITS documented one boxed return (~16 B/call).
// Sinking it into a retaining PACKED_ELEMENTS slot boxes -- proof the probe SEES the box the render's
// quantileInto elides. If this reads 0 the render's <= 0.5 gate is vacuous.
const SLD_QSINK = [{}, 0];
const sld_quantile_box = {
    setup() { return sldWorldBuilt(SLD_MODE_RANGE); },
    hot(s, n) { const w = s.w, acc = s.acc, sd = w.sd; for (let i = 0; i < n; i++) { SLD_QSINK[1] = sd.quantile(0.5); acc[0] += 1; } },
};

export const LANES = {
    mustbox, noop,
    hk_render_big, hk_step_big, hk_render_small,
    shll_step_q1, shll_step_never, shll_render,
    // P1 EH / ADWIN
    eh_frame_default, eh_frame_dense10k, eh_frame_spike, eh_render_spike, eh_render_dense10k,
    ad_frame_default, ad_frame_offset, ad_frame_preset,
    ad_render_default, ad_render_offset, ad_render_preset,
    ad_mean_sink, ad_variance_sink,
    // P3 DD / SLD. dd_frame + dd_frame_nolatch are 0-B/op frame lanes gated <= 0.5 under DEFAULT flags;
    // dd_render is a DOCUMENTED band [44, 52] (six _guardFinite getters, three box); sld_quantile_box is a
    // MUST-BOX control (the scalar quantile() return, >= 12); sld render/frame lanes are 0-B/op.
    dd_frame, dd_frame_nolatch, dd_render,
    sld_frame_range, sld_frame_strict, sld_render, sld_quantile_box,
};

const ALL_LANES = Object.assign(Object.create(null), LANES);

// ---------------------------------------------------------------------------
// runDemoLane: one lane per child process, pinned semi-space flags + --expose-gc, lane via LITE_DEMO_LANE.
// ---------------------------------------------------------------------------
/**
 * @param {string} laneName key into LANES
 * @param {number} [K=4000] ops per window
 * @param {number} [windows=5] measurement windows (steady = min over windows 1..n-1)
 * @returns {Promise<{lane:string, first:number, steady:number, readings:number[], execArgv:string[]}>}
 */
export function runDemoLane(laneName, K = 4000, windows = 5) {
    const argv = ['--expose-gc', '--min-semi-space-size=4', '--max-semi-space-size=4', SELF];
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, argv,
            { env: Object.assign({}, process.env,
                { LITE_DEMO_LANE: laneName, LITE_DEMO_K: String(K), LITE_DEMO_WINDOWS: String(windows) }),
              stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) return reject(new Error('[DemoProbe] lane ' + laneName + ' exited ' + code));
            const line = out.trim().split('\n').filter(Boolean).pop();
            try { resolve(JSON.parse(line)); }
            catch (e) { reject(new Error('[DemoProbe] bad lane output for ' + laneName + ': ' + out)); }
        });
    });
}

// ---------------------------------------------------------------------------
// child entry: only when THIS file is the process main module (run directly or spawned as SELF), not
// when a test that happens to carry a positional argv[2] IMPORTS it. The parent spawn runs `node SELF`
// with LITE_DEMO_LANE set, so it still fires; an importer (argv[1] != this file) never does.
// ---------------------------------------------------------------------------
const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN && (process.env.LITE_DEMO_LANE || process.argv[2])) {
    const laneName = process.env.LITE_DEMO_LANE || process.argv[2];
    const lane = ALL_LANES[laneName];
    if (!lane) { console.error('[DemoProbe] no lane "' + laneName + '"'); process.exit(2); }
    if (typeof globalThis.gc !== 'function') { console.error('[DemoProbe] child needs --expose-gc'); process.exit(2); }
    const K = parseInt(process.env.LITE_DEMO_K || '4000', 10);
    const windows = parseInt(process.env.LITE_DEMO_WINDOWS || '5', 10);
    const r = await steadyMin(lane, { windows, K });   // steadyMin asserts BOTH semi-space flags are pinned
    process.stdout.write(JSON.stringify({ lane: laneName, first: r.first, steady: r.steady, readings: r.readings, execArgv: process.execArgv }) + '\n');
    process.exit(0);
}
