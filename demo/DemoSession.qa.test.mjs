// @zakkster/lite-adaptive -- B10 QA boundary pass for the demo session (ROADMAP 11 / 11.1, DEMO.md Scene 08
// D7/D8, Scene 10, S11, the DEMO AUDIT law). Boundaries the existing Demo.test.mjs / DemoAudit.test.mjs do not
// pin. A defect is written as a `todo` test (QA-<n>) and reported -- never patched here. QA-1..8 were fixed by
// the coordinator on 2026-10-04 and their todo markers removed, so each is now a regression gate. ASCII-only.
//
//   node --expose-gc --test demo/DemoSession.qa.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    createAllocState,
    createSaWorld, stepSa, stepSaOracle, renderSaPrep, renderSaEhPrep,
    SA_EVENTS_PER_FRAME, SA_DT, SA_DEFAULT_PANES, SA_RING_LEN, SA_SPIKE_MULT,
    L_COUNT, L_SUM, L_MEAN, L_MIN, L_MAX, L_TCOUNT, L_TSUM, L_TMEAN, L_TMIN, L_TMAX, L_EXACT, L_TSUMW,
    L_TCOUNTW, L_EHREL, L_EHRELMAX, L_ORACLE_BYTES,
    createScmWorld, stepScm, stepScmOracle, renderScmPrep,
    SCM_DEFAULT_EPS, SCM_DEFAULT_PANES, SCM_TRACKED, SCM_STRIDE, SCM_KEYS_PER_FRAME,
    C_BOUNDOK, C_TOTALOK, C_TOTAL, C_NLIVE, C_SATURATED,
    runKeyMagLane, kmAggregate, keyMagText, KM_CONTROL_MIN, KM_MIN_CLEAN,
} from './kernels.mjs';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');

function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
}

// =============================================================================================
// Scene 10 -- SlidingAggregate
// =============================================================================================

const SA_ORACLE_SLOTS = [L_TCOUNT, L_TSUM, L_TMEAN, L_TMIN, L_TMAX, L_EXACT, L_TSUMW, L_TCOUNTW];
const SA_SLIDER_W = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000];

/** A from-spec SA recount over a frame log (never the kernel ring). log entries: [frameNow, spikes, active, startPos]. */
function saTruth(world, log) {
    const K = SA_EVENTS_PER_FRAME, step = SA_DT / K, pw = world.W / world.panes, cut = world.now - world.W;
    let c = 0, s = 0, mn = Infinity, mx = -Infinity, cw = 0, sw = 0;
    for (let f = log.length - 1; f >= 0; f--) {
        const [frameNow, sp, active, startPos] = log[f];
        if (frameNow + SA_DT + pw + 1 < cut) break;
        if (!active) continue;
        for (let j = 0; j < K; j++) {
            const i = (startPos + j) & world.streamMask;
            const t = frameNow + (j + 1) * step;
            const v = (sp && world.spike[i] === 1) ? world.vals[i] * SA_SPIKE_MULT : world.vals[i];
            if ((Math.floor(t / pw) + 1) * pw > cut) {
                c++; s += v; if (v < mn) mn = v; if (v > mx) mx = v;
                if (t > cut) { cw++; sw += v; }
            }
        }
    }
    return { c, s, mn: c ? mn : NaN, mx: c ? mx : NaN, cw, sw };
}

/** One UI frame (index.html saStep): log, step the sketch, the oracle only while on. */
function saFrame(world, a, log) {
    log.push([world.now, world.spikes, !world.paused, world.cursor]);
    stepSa(world);
    if (world.oracleOn) stepSaOracle(world, a);
}

const saHold = (w) => !w.oracleOn || w.now - w.resumeNow < w.W + w.pw;

/** Every slot of the SA flat must agree with the oracle state (returns failures). */
function saStateFailures(world, tag) {
    const fl = world.flat, out = [];
    const nanIffEmpty = (slot, name) => { if (Number.isNaN(fl[slot]) !== (fl[L_COUNT] === 0)) out.push(tag + ': ' + name + '=' + fl[slot] + ' vs count ' + fl[L_COUNT]); };
    nanIffEmpty(L_MEAN, 'mean'); nanIffEmpty(L_MIN, 'min'); nanIffEmpty(L_MAX, 'max');
    if (saHold(world)) {
        for (const s of [...SA_ORACLE_SLOTS, L_EHREL, L_EHRELMAX]) if (!Number.isNaN(fl[s])) out.push(tag + ': hold but slot ' + s + '=' + fl[s]);
    } else {
        for (const s of [L_TCOUNT, L_TSUM, L_EXACT, L_TSUMW, L_TCOUNTW]) if (!Number.isFinite(fl[s])) out.push(tag + ': valid but slot ' + s + '=' + fl[s]);
        for (const s of [L_TMEAN, L_TMIN, L_TMAX]) if (Number.isNaN(fl[s]) !== (fl[L_TCOUNT] === 0)) out.push(tag + ': oracle slot ' + s + '=' + fl[s] + ' vs tcount ' + fl[L_TCOUNT]);
        if (Number.isNaN(fl[L_EHREL]) !== !(fl[L_TSUMW] > 0)) out.push(tag + ': EHREL=' + fl[L_EHREL] + ' vs tsumw ' + fl[L_TSUMW]);
        if (fl[L_EXACT] !== 1) out.push(tag + ': L_EXACT=' + fl[L_EXACT] + ' on a valid oracle');
    }
    return out;
}

function assertSaTruth(world, log, tag) {
    const t = saTruth(world, log), fl = world.flat;
    assert.equal(fl[L_COUNT], t.c, tag + ': count'); assert.equal(fl[L_SUM], t.s, tag + ': sum');
    assert.ok(Object.is(fl[L_MIN], t.mn) && Object.is(fl[L_MAX], t.mx), tag + ': min/max ' + fl[L_MIN] + '/' + fl[L_MAX] + ' vs ' + t.mn + '/' + t.mx);
    if (!saHold(world)) {
        assert.equal(fl[L_TCOUNT], t.c, tag + ': oracle count'); assert.equal(fl[L_TSUM], t.s, tag + ': oracle sum');
        assert.equal(fl[L_TSUMW], t.sw, tag + ': true-window sum'); assert.equal(fl[L_TCOUNTW], t.cw, tag + ': true-window count');
    }
}

test('QA SA slider extremes W=500 / W=4000 with spikes toggled EVERY frame: exact vs a from-spec recount on every render, and the oracle ring never comes near SA_RING_LEN', () => {
    for (const W of [500, 4000]) {
        const world = createSaWorld(W, SA_DEFAULT_PANES), a = createAllocState(), log = [];
        let renders = 0, maxLive = 0;
        for (let f = 0; f < 900; f++) {
            world.spikes = (f & 1) === 1;
            saFrame(world, a, log);
            maxLive = Math.max(maxLive, (world.oTail - world.oHead) & world.oMask);
            if (f % 3 !== 0) continue;
            renderSaPrep(world, a); renderSaEhPrep(world); renders++;
            assertSaTruth(world, log, 'W=' + W + ' frame ' + f);
            assert.deepEqual(saStateFailures(world, 'W=' + W + ' frame ' + f), []);
            assert.equal(world.flat[L_ORACLE_BYTES], ((world.oTail - world.oHead) & world.oMask) * 16, 'oracle bytes = live * 16');
        }
        assert.ok(renders >= 250, 'non-vacuous');
        // the ring holds the covered span plus one frame of appends before expiry -- a full ring would read 0 live
        const bound = Math.ceil((W + W / SA_DEFAULT_PANES) / SA_DT + 2) * SA_EVENTS_PER_FRAME;
        assert.ok(maxLive <= bound && bound < SA_RING_LEN, 'W=' + W + ': max live ' + maxLive + ' <= ' + bound + ' < ring ' + SA_RING_LEN);
    }
});

test('QA SA resume-hold boundary: NaN on the last frame with now - resumeNow < W + pw, exact on the first frame >= it; at EXACT equality (now - resumeNow === W + pw) the oracle is valid and exact; one ulp inside, it holds', () => {
    for (const W of [500, 1000, 4000]) {
        const world = createSaWorld(W, SA_DEFAULT_PANES), a = createAllocState(), log = [];
        const span = W + world.pw;
        for (let f = 0; f < 150; f++) saFrame(world, a, log);
        world.oracleOn = false;
        for (let f = 0; f < 37; f++) { world.spikes = (f % 5) === 0; saFrame(world, a, log); }
        world.spikes = true;
        world.oracleOn = true; world.resumeNow = world.now;           // index.html: on && !oracleOn -> resumeNow = now
        const R = world.now;
        let prevHold = true, flips = 0;
        for (let f = 0; f < Math.ceil(span / SA_DT) + 5; f++) {
            saFrame(world, a, log);
            renderSaPrep(world, a); renderSaEhPrep(world);
            const hold = world.now - R < span, tag = 'W=' + W + ' +' + (world.now - R).toFixed(3) + 'ms';
            assert.equal(Number.isNaN(world.flat[L_EXACT]), hold, tag + ': L_EXACT NaN iff inside the hold');
            assert.deepEqual(saStateFailures(world, tag), []);
            if (prevHold && !hold) { flips++; assert.equal(world.flat[L_EXACT], 1, tag + ': first valid render is exact'); assertSaTruth(world, log, tag); }
            prevHold = hold;
        }
        assert.equal(flips, 1, 'exactly one hold -> valid transition');
        // exact equality: any resumeNow >= the true resume time is a sound (conservative) hold point
        world.resumeNow = world.now - span;
        assert.ok(world.resumeNow >= R && world.now - world.resumeNow === span, 'the equality is constructed exactly');
        renderSaPrep(world, a); renderSaEhPrep(world);
        assert.equal(world.flat[L_EXACT], 1, 'W=' + W + ': at now - resumeNow === W + pw the oracle is valid and exact');
        assertSaTruth(world, log, 'W=' + W + ' equality');
        world.resumeNow = world.now - span + Math.max(1e-9, Math.abs(world.now) * 4e-16);
        assert.ok(world.now - world.resumeNow < span, 'one step inside');
        renderSaPrep(world, a); renderSaEhPrep(world);
        assert.deepEqual(saStateFailures(world, 'W=' + W + ' inside'), []);
        assert.ok(Number.isNaN(world.flat[L_EXACT]), 'W=' + W + ': strictly inside the hold -> NaN');
    }
});

test('QA SA pause LONGER than the window, then resume: the window empties (count 0, mean/min/max NaN, both-empty exact), EH error is NaN on the empty true window, and the FIRST render after resume is exact vs the recount', () => {
    for (const W of [500, 4000]) {
        const world = createSaWorld(W, SA_DEFAULT_PANES), a = createAllocState(), log = [];
        world.spikes = true;
        for (let f = 0; f < 300; f++) saFrame(world, a, log);
        world.paused = true;
        const pausedFrames = Math.ceil(3 * W / SA_DT);
        for (let f = 0; f < pausedFrames; f++) {
            saFrame(world, a, log);
            if (f % 10 === 0) { renderSaPrep(world, a); renderSaEhPrep(world); assert.deepEqual(saStateFailures(world, 'paused ' + f), []); }
        }
        renderSaPrep(world, a); renderSaEhPrep(world);
        assert.equal(world.flat[L_COUNT], 0); assert.equal(world.flat[L_EXACT], 1, 'both empty is exact');
        assert.ok(Number.isNaN(world.flat[L_EHREL]), 'empty true window: EH rel err NaN (never 0)');
        assert.equal(world.oTail, world.oHead, 'the oracle ring drained');
        world.paused = false;
        saFrame(world, a, log);
        renderSaPrep(world, a); renderSaEhPrep(world);
        assert.equal(world.flat[L_COUNT], SA_EVENTS_PER_FRAME, 'first resumed frame');
        assert.equal(world.flat[L_EXACT], 1, 'W=' + W + ': first render after resume exact');
        assertSaTruth(world, log, 'W=' + W + ' resume');
        assert.deepEqual(saStateFailures(world, 'resume'), []);
    }
});

test('QA SA random toggling (pause / spikes / oracle with the index.html resume rule / W slider rebuild), 3000 frames x 3 seeds: every slot agrees with the oracle state, exact on every valid render, and L_EHRELMAX never decreases while valid', () => {
    for (const seed of [1, 0xBEEF, 0x5eed]) {
        const rnd = lcg(seed);
        let W = 1000, world = createSaWorld(W, SA_DEFAULT_PANES), a = createAllocState(), log = [];
        let prevMax = -Infinity, valid = 0, holds = 0, fails = [];
        for (let f = 0; f < 3000; f++) {
            const r = rnd();
            if (r < 0.01) world.paused = !world.paused;
            else if (r < 0.06) world.spikes = !world.spikes;
            else if (r < 0.066 && (world.oracleOn ? rnd() < 0.1 : true)) { const on = !world.oracleOn; if (on && !world.oracleOn) world.resumeNow = world.now; world.oracleOn = on; }
            else if (r < 0.068) {                                           // saRebuild (the W slider)
                W = SA_SLIDER_W[(rnd() * SA_SLIDER_W.length) | 0];
                const p = world.paused, sp = world.spikes, on = world.oracleOn;
                world = createSaWorld(W, SA_DEFAULT_PANES); world.paused = p; world.spikes = sp; world.oracleOn = on;
                a = createAllocState(); log = []; prevMax = -Infinity;
            }
            saFrame(world, a, log);
            if (f % 6 !== 0) continue;
            renderSaPrep(world, a); renderSaEhPrep(world);
            const tag = 'seed ' + seed + ' frame ' + f + ' W=' + W;
            fails = fails.concat(saStateFailures(world, tag));
            assertSaTruth(world, log, tag);
            if (saHold(world)) { holds++; continue; }
            valid++;
            const m = world.flat[L_EHRELMAX];
            if (m === m) {
                if (m < prevMax) fails.push(tag + ': EHRELMAX decreased ' + prevMax + ' -> ' + m);
                if (m < world.flat[L_EHREL]) fails.push(tag + ': EHRELMAX ' + m + ' < EHREL ' + world.flat[L_EHREL]);
                prevMax = m;
            }
        }
        assert.deepEqual(fails.slice(0, 5), []);
        assert.ok(valid > 100 && holds > 10, 'non-vacuous: ' + valid + ' valid, ' + holds + ' held renders');
    }
});

// =============================================================================================
// Scene 08 -- SlidingCountMin
// =============================================================================================

const SCM_SLIDER_W = [1024, 1536, 2048, 2560, 3072, 3584, 4096];
const scmHold = (w) => !w.oracleOn || w.now - w.resumeNow < w.W + w.pw;

function scmFrame(world, a) {
    stepScm(world);
    if (world.oracleOn) stepScmOracle(world, a);
}

/** C_TOTALOK / C_BOUNDOK must be 1 on a valid oracle and NaN on a hold -- 0 is a false "VIOLATED". */
function scmVerdictFailures(world, tag) {
    const fl = world.flat, out = [];
    for (const [s, n] of [[C_TOTALOK, 'TOTALOK'], [C_BOUNDOK, 'BOUNDOK'], [C_NLIVE, 'NLIVE']]) {
        if (scmHold(world)) { if (!Number.isNaN(fl[s])) out.push(tag + ': hold but ' + n + '=' + fl[s]); }
        else if (n !== 'NLIVE' && fl[s] !== 1) out.push(tag + ': ' + n + '=' + fl[s] + ' (false VIOLATED) total=' + fl[C_TOTAL] + ' nlive=' + fl[C_NLIVE]);
    }
    if (scmHold(world)) for (let k = 0; k < SCM_TRACKED; k++) if (!Number.isNaN(fl[k * SCM_STRIDE + 1]) || !Number.isNaN(fl[k * SCM_STRIDE + 2])) out.push(tag + ': hold but tracked ' + k + ' true/upper live');
    if (fl[C_SATURATED] !== 0) out.push(tag + ': saturated ' + fl[C_SATURATED]);
    return out;
}

test('QA SCM heavy mode at W=1024 and W=4096 with pause / resume cycles: verdicts 1 on every render, key 0 passes 2^31 unsaturated, pause slides total() to 0 with the verdict still 1, resume is immediately 1', () => {
    for (const W of [1024, 4096]) {
        const world = createScmWorld(W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES), a = createAllocState();
        world.heavy = true;
        let fails = [], over31 = 0, renders = 0;
        for (let cycle = 0; cycle < 3; cycle++) {
            world.paused = false;
            for (let f = 0; f < 200; f++) {
                scmFrame(world, a);
                if (f % 4) continue;
                renderScmPrep(world, a); renders++;
                fails = fails.concat(scmVerdictFailures(world, 'W=' + W + ' c' + cycle + ' f' + f));
                if (world.flat[0] > 2147483648) over31++;
            }
            world.paused = true;
            for (let f = 0; f < Math.ceil((W + W / SCM_DEFAULT_PANES) / SCM_KEYS_PER_FRAME) + 2; f++) {
                scmFrame(world, a);
                renderScmPrep(world, a); renders++;
                fails = fails.concat(scmVerdictFailures(world, 'W=' + W + ' paused c' + cycle + ' f' + f));
            }
            assert.equal(world.flat[C_TOTAL], 0, 'W=' + W + ': paused past the span -> total() 0');
            assert.equal(world.flat[0], 0, 'W=' + W + ': paused -> key 0 estimate 0');
        }
        world.paused = false; scmFrame(world, a); renderScmPrep(world, a);
        fails = fails.concat(scmVerdictFailures(world, 'W=' + W + ' resumed'));
        assert.deepEqual(fails.slice(0, 5), []);
        assert.ok(over31 > 10 && renders > 150, 'W=' + W + ': non-vacuous (' + over31 + ' renders with key 0 > 2^31)');
    }
});

test('QA SCM oracle toggled off then on WITHIN one frame (0 and 1 skipped oracle steps): the hold starts at the toggle, ends exactly at now - resumeNow >= W + pw, and the verdict is never 0', () => {
    for (const skipped of [0, 1]) {
        for (const W of [1024, 4096]) {
            const world = createScmWorld(W, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES), a = createAllocState();
            world.heavy = W === 4096;
            for (let f = 0; f < 150; f++) scmFrame(world, a);
            world.oracleOn = false;
            for (let f = 0; f < skipped; f++) scmFrame(world, a);
            if (!world.oracleOn) world.resumeNow = world.now;
            world.oracleOn = true;
            const R = world.now;
            let fails = [], sawHold = 0, sawValid = 0;
            for (let f = 0; f < Math.ceil((W + world.pw) / SCM_KEYS_PER_FRAME) + 4; f++) {
                scmFrame(world, a); renderScmPrep(world, a);
                assert.equal(Number.isNaN(world.flat[C_TOTALOK]), world.now - R < W + world.pw, 'skip ' + skipped + ' W=' + W + ' +' + (world.now - R));
                fails = fails.concat(scmVerdictFailures(world, 'skip ' + skipped + ' W=' + W + ' f' + f));
                if (scmHold(world)) sawHold++; else sawValid++;
            }
            assert.deepEqual(fails, []);
            assert.ok(sawHold > 0 && sawValid > 0, 'both phases seen');
        }
    }
});

test('QA SCM 3000 frames of random toggling (pause / heavy / oracle with the index.html resume rule / W + eps rebuild) x 3 seeds: C_TOTALOK and C_BOUNDOK are never 0 (no false VIOLATED), NaN exactly on a hold', () => {
    for (const seed of [7, 0xC0FFEE, 0x9e37]) {
        const rnd = lcg(seed);
        let world = createScmWorld(2048, SCM_DEFAULT_EPS, SCM_DEFAULT_PANES), a = createAllocState();
        let fails = [], valid = 0, held = 0, heavyValid = 0;
        for (let f = 0; f < 3000; f++) {
            const r = rnd();
            if (r < 0.01) world.paused = !world.paused;
            else if (r < 0.05) world.heavy = !world.heavy;
            else if (r < 0.056 && (world.oracleOn ? rnd() < 0.1 : true)) { const on = !world.oracleOn; if (on && !world.oracleOn) world.resumeNow = world.now; world.oracleOn = on; }
            else if (r < 0.058) {                                           // scmRebuild (W / eps sliders)
                const W = SCM_SLIDER_W[(rnd() * SCM_SLIDER_W.length) | 0], eps = (5 + 5 * ((rnd() * 20) | 0)) / 1000;
                const p = world.paused, hv = world.heavy, on = world.oracleOn;
                world = createScmWorld(W, eps, SCM_DEFAULT_PANES); world.paused = p; world.heavy = hv; world.oracleOn = on;
                a = createAllocState();
            }
            scmFrame(world, a);
            if (f % 5) continue;
            renderScmPrep(world, a);
            fails = fails.concat(scmVerdictFailures(world, 'seed ' + seed + ' f' + f + ' W=' + world.W + ' eps=' + world.epsilon));
            if (scmHold(world)) held++; else { valid++; if (world.heavy) heavyValid++; }
        }
        assert.deepEqual(fails.slice(0, 5), []);
        assert.ok(valid > 150 && held > 10 && heavyValid > 20, 'non-vacuous: ' + valid + ' valid (' + heavyValid + ' heavy), ' + held + ' held');
    }
});

// =============================================================================================
// S11 -- the key-magnitude lane
// =============================================================================================

const clean = (arr) => { let n = 0; for (const r of arr) if (r >= 0) n++; return n; };

/** The S11 law: ok only with a seen control in >= KM_MIN_CLEAN clean windows; non-ok never prints a key number. */
function kmLawFailures(r, tag) {
    const out = [], t = keyMagText(r);
    if (r.state === 'ok') {
        if (!(r.control >= KM_CONTROL_MIN)) out.push(tag + ': ok with control ' + r.control);
        for (const lane of ['control', 'small', 'big31']) if (clean(r.raw[lane]) < KM_MIN_CLEAN) out.push(tag + ': ok with ' + clean(r.raw[lane]) + ' clean ' + lane + ' windows');
        if (!/^small keys /.test(t)) out.push(tag + ': ok text ' + t);
    } else {
        if (!/^n\/a \(/.test(t)) out.push(tag + ': non-ok text ' + t);
        if (/keys -?\d|keys Inf|keys NaN|B\/op \|/.test(t)) out.push(tag + ': non-ok text prints a key-lane number: ' + t);
        if (!Number.isNaN(r.small) || !Number.isNaN(r.big31)) out.push(tag + ': non-ok key lanes ' + r.small + ' / ' + r.big31);
    }
    if (/NaN/.test(t)) out.push(tag + ': text shows NaN: ' + t);
    return out;
}

test('QA S11 adversarial synthetic meters (monotone junk, stutter-then-jump, sawtooth, NaN / -Infinity bursts, -0, overflow-to-Infinity growth): the ok law holds and no non-ok text prints a key-lane number', () => {
    const meters = {
        monotoneJunk: () => { let c = 0; const rnd = lcg(3); return () => (c += 1e5 + rnd() * 1e6); },
        stutterThenJump: () => { let i = 0; return () => Math.floor(i++ / 3) * 4e5; },
        sameTwiceThenJump: () => { let i = 0; return () => (i++ % 3 === 2 ? 1e9 + i * 1e5 : 1e6); },
        sawtooth: () => { let i = 0; return () => ((i++ & 1) ? 1e7 : 1e6); },
        nanBurst: () => { let i = 0, c = 1e6; return () => ((++i % 4 === 0) ? NaN : (c += 3e5)); },
        negInfBurst: () => { let i = 0, c = 1e6; return () => ((++i % 5 === 0) ? -Infinity : (c += 3e5)); },
        negZero: () => () => -0,
        alwaysNegInf: () => () => -Infinity,
        maxValueGrowth: () => { let c = 1e300; return () => (c *= 1e3); },
    };
    for (const [name, make] of Object.entries(meters)) {
        const r = runKeyMagLane(make(), 300);
        assert.deepEqual(kmLawFailures(r, name), [], name + ' -> ' + r.state + ' ' + keyMagText(r));
    }
    // and a monotone junk meter is reported 'ok' with a LARGE (non-zero) key-lane number -- fail-closed direction
    const j = runKeyMagLane(meters.monotoneJunk(), 300);
    assert.equal(j.state, 'ok'); assert.ok(j.small > 100 && j.big31 > 100, 'junk never reads as a clean 0');
});

test('QA S11 kmAggregate boundaries: 0 / 1 / 2 / 3 clean windows, empty input, -0 windows, duplicates of the top value', () => {
    assert.ok(Number.isNaN(kmAggregate(new Float64Array(0))), 'empty -> NaN');
    assert.ok(Number.isNaN(kmAggregate(Float64Array.of(5))), '1 clean -> NaN');
    assert.ok(Number.isNaN(kmAggregate(Float64Array.of(5, 5))), '2 clean -> NaN');
    assert.equal(kmAggregate(Float64Array.of(5, 5, 5)), 5, '3 clean (== KM_MIN_CLEAN) -> the second-largest');
    assert.ok(kmAggregate(Float64Array.of(-0, -0, -0)) === 0, '-0 is a clean zero window');
    assert.equal(kmAggregate(Float64Array.of(9, 9, 1, -1)), 9, 'a duplicated top value is the second-largest too');
});

test('QA-1 S11 a meter that THROWS must yield a non-ok result, not an exception (the click handler has no try / catch, so a throw leaves the PREVIOUS readout -- possibly a stale "ok" -- on screen)', () => {
    for (const at of [1, 30, 60]) {
        let i = 0;
        const meter = () => { if (++i === at) throw new Error('meter died'); return 1e6 + i * 1e5; };
        let r;
        assert.doesNotThrow(() => { r = runKeyMagLane(meter, 300); }, 'throw at call ' + at);
        assert.notEqual(r.state, 'ok');
        assert.deepEqual(kmLawFailures(r, 'throw@' + at), []);
    }
});

test('QA-2 S11 a +Infinity window is not a measurement: kmAggregate must not count it clean, and a BLIND meter (constant through the key lanes) that jumps to +Infinity at the control window ends must not be "ok" -- today it reports "small keys 0.0 B/op (control Infinity)", the fail-open 0 the self-test exists to prevent', () => {
    let i = 0;
    const infAtControlEnds = () => (++i >= 54 && (i & 1) === 1 ? Infinity : 1e6);      // reads 0 through the key lanes
    const r = runKeyMagLane(infAtControlEnds, 300);
    assert.notEqual(r.state, 'ok', 'blind key lanes + Infinity control: ' + keyMagText(r));
    assert.ok(Number.isNaN(kmAggregate(Float64Array.of(Infinity, Infinity, Infinity, 0))), 'three +Infinity windows are not three clean windows');
});

test('QA-3 S11 runKeyMagLane(meter, ops) with ops 0 / null (null is not zero) must fail closed, not divide by 0 -> "ok" with Infinity B/op', () => {
    for (const ops of [0, null]) {
        let c = 0;
        const r = runKeyMagLane(() => (c += 4096), ops);
        assert.notEqual(r.state, 'ok', 'ops ' + ops + ' -> ' + keyMagText(r));
    }
});

// =============================================================================================
// index.html write-on-change helpers (extracted exactly as Demo.test.mjs loadReadoutHelpers does)
// =============================================================================================

function loadReadoutHelpers(html) {
    const a = html.indexOf('    // ---- write-on-change readouts');
    const b = html.indexOf('    // Compact integer-ish formatter');
    assert.ok(a !== -1 && b > a, 'index.html must hold the write-on-change readout block');
    return new Function(html.slice(a, b) + '\nreturn { RO_N, putFixed, putInt, putNum, putExp, putSmi, setText, setClass };')();
}

function fakeEl() {
    let text = 'placeholder', cls = '';
    return {
        writes: 0,
        get textContent() { return text; }, set textContent(v) { text = v; this.writes++; },
        get className() { return cls; }, set className(v) { cls = v; this.writes++; },
    };
}

test('QA readouts putFixed, digits 0..4 x {0, -0, +-0.5, +-1.23456, +-1e15, +-Infinity, NaN, 1e-7}: the shown text is the format of the current value, never "NaN" / "-0", repeats (incl. -0 after 0 and Infinity twice) write nothing', () => {
    const ro = loadReadoutHelpers(HTML), f = new Float64Array(1);
    const vals = [0, -0, 0.5, -0.5, 1.23456, -1.23456, 1e15, -1e15, Infinity, -Infinity, NaN, 1e-7, -1e-7];
    for (let d = 0; d <= 4; d++) {
        const p = Math.pow(10, d);
        for (let vi = 0; vi < vals.length; vi++) {
            const el = fakeEl(), v = vals[vi], slot = d * 16 + vi;
            for (let rep = 0; rep < 2; rep++) {
                f[0] = rep === 1 && Object.is(v, 0) ? -0 : v;            // 0 then -0 on the same slot
                const before = el.writes;
                ro.putFixed(el, slot, f, 0, 1, d, ' u');
                const k = Math.round(v * p);
                const want = v !== v ? 'n/a' : (k / p).toFixed(d) + ' u';
                assert.equal(el.textContent, want, 'd=' + d + ' v=' + v + ' rep ' + rep);
                assert.ok(!/NaN|^-0(\.0*)? /.test(el.textContent), 'd=' + d + ' v=' + v + ': ' + el.textContent);
                if (rep === 1) assert.equal(el.writes, before, 'd=' + d + ' v=' + v + ': a repeat writes nothing');
            }
        }
        const el = fakeEl();
        f[0] = Infinity; ro.putFixed(el, 90 + d, f, 0, 1, d, '');
        f[0] = -Infinity; ro.putFixed(el, 90 + d, f, 0, 1, d, '');
        assert.equal(el.textContent, '-Infinity', 'Infinity -> -Infinity rewrites'); assert.equal(el.writes, 2);
    }
    const el = fakeEl();
    f[0] = 1e15; ro.putFixed(el, 100, f, 0, 1, 4, '');
    assert.equal(el.textContent, '1000000000000000.0000', '1e15 at 4 digits');
});

test('QA-4 putFixed: a FINITE value whose v * scale * 10^digits overflows renders "Infinity" (1e305 at 4 digits)', () => {
    const ro = loadReadoutHelpers(HTML), f = Float64Array.of(1e305), el = fakeEl();
    ro.putFixed(el, 0, f, 0, 1, 4, '');
    assert.notEqual(el.textContent, 'Infinity', 'a finite value must not read Infinity');
});

test('QA readouts putExp / putNum / setClass / setText: -0 then 0 writes once, Infinity / NaN render, the same class twice writes once', () => {
    const ro = loadReadoutHelpers(HTML), f = new Float64Array(1);
    let el = fakeEl();
    f[0] = -0; ro.putExp(el, 0, f, 0, 2); f[0] = 0; ro.putExp(el, 0, f, 0, 2);
    assert.equal(el.textContent, '0.00e+0'); assert.equal(el.writes, 1, 'putExp -0 then 0: one write');
    for (const [v, want] of [[Infinity, 'Infinity'], [-Infinity, '-Infinity'], [NaN, 'n/a'], [1e15, '1.00e+15'], [NaN, 'n/a']]) {
        f[0] = v; ro.putExp(el, 0, f, 0, 2); assert.equal(el.textContent, want, 'putExp ' + v);
    }
    el = fakeEl();
    f[0] = -0; ro.putNum(el, 1, f, 0); f[0] = 0; ro.putNum(el, 1, f, 0);
    assert.equal(el.textContent, '0'); assert.equal(el.writes, 1, 'putNum -0 then 0: one write');
    f[0] = 2147483649; ro.putNum(el, 1, f, 0); assert.equal(el.textContent, '2147483649', 'putNum never int32-folds');
    el = fakeEl();
    f[0] = 0; ro.putNum(el, 2, f, 0);
    assert.equal(el.textContent, '0'); assert.equal(el.writes, 1, 'a fresh slot whose first value is 0 still writes');
    el = fakeEl();
    ro.setClass(el, 'v inband'); ro.setClass(el, 'v inband');
    assert.equal(el.writes, 1, 'setClass same string twice: one write');
    ro.setClass(el, ''); assert.equal(el.className, ''); assert.equal(el.writes, 2);
    el = fakeEl();
    ro.setText(el, 'x'); ro.setText(el, 'x'); assert.equal(el.writes, 1, 'setText same string twice: one write');
});

// =============================================================================================
// DEMO AUDIT rules robustness: run the REAL DemoAudit.test.mjs in a child against a mutated copy of the page
// =============================================================================================

function runAuditOn(html) {
    const dir = mkdtempSync(join(tmpdir(), 'lite-adaptive-qa-audit-'));
    try {
        writeFileSync(join(dir, 'index.html'), html);
        copyFileSync(join(DEMO_DIR, 'DemoAudit.test.mjs'), join(dir, 'DemoAudit.test.mjs'));
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;                                    // a standalone child run, not a sub-reporter
        const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(dir, 'DemoAudit.test.mjs')], { env, encoding: 'utf8', timeout: 60000 });
        return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function injectBeforeLoop(html, code) {
    const at = html.indexOf('    // ---- main loop');
    assert.ok(at !== -1, 'the main-loop anchor moved');
    return html.slice(0, at) + code + '\n' + html.slice(at);
}

function intoSaDraw(html, code) {
    const anchor = '    function saDraw() {\n';
    assert.ok(html.indexOf(anchor) !== -1, 'saDraw anchor moved');
    return html.replace(anchor, anchor + code + '\n');
}

const notOk = (out, rule) => new RegExp('not ok \\d+ - DEMO AUDIT: ' + rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(out);

test('QA DEMO AUDIT baseline: the real audit is GREEN on an unmutated copy (the child harness is sound)', () => {
    const r = runAuditOn(HTML);
    assert.equal(r.status, 0, r.out.slice(-800));
});

const AUDIT_CAUGHT = [
    ['no DOM lookup inside a function body', 'document.getElementById in a module-level arrow handler',
        (h) => injectBeforeLoop(h, "    $('sa-w').addEventListener('change', (e) => {\n        document.getElementById('sa-w-v').textContent = 'x';\n    });")],
    ['no DOM lookup inside a function body', 'querySelector in a top-level handler function',
        (h) => injectBeforeLoop(h, "    function auditOnKey(e) { document.querySelector('#sa-w-v').className = 'v'; }")],
    ['no format / template / string build in a per-frame body', 'a template literal in a NEW helper reached from loop via saDraw',
        (h) => injectBeforeLoop(intoSaDraw(h, '        auditLabel(saVMax);'), '    function auditLabel(v) { return `max ${v}`; }')],
    ['no format / template / string build in a per-frame body', 'toLocaleString two hops from loop (saDraw -> auditFmt2 -> auditFmt3)',
        (h) => injectBeforeLoop(intoSaDraw(h, '        auditFmt2(saVMax);'), '    function auditFmt2(v) { return auditFmt3(v); }\n    function auditFmt3(v) { return v.toLocaleString(); }')],
    ['no layout read after a layout write in one body', '.style.width = then getBoundingClientRect',
        (h) => injectBeforeLoop(h, "    function auditStyle(el) { el.style.width = '10px'; return el.getBoundingClientRect().width; }")],
    ['no layout read after a layout write in one body', 'classList.add then offsetHeight',
        (h) => injectBeforeLoop(h, "    function auditCls(el) { el.classList.add('on'); return el.offsetHeight; }")],
];

for (const [rule, what, mutate] of AUDIT_CAUGHT) {
    test('QA DEMO AUDIT catches: ' + what + ' (rule "' + rule + '")', () => {
        const bad = mutate(HTML);
        assert.notEqual(bad, HTML, 'mutation applied');
        const r = runAuditOn(bad);
        assert.notEqual(r.status, 0, 'the audit must go RED');
        assert.ok(notOk(r.out, rule), 'the RED test must be "' + rule + '"\n' + r.out.split('\n').filter((l) => /^not ok/.test(l)).join('\n'));
    });
}

const AUDIT_GAPS = [
    ['QA-5', 'no DOM lookup inside a function body', 'a lookup in a module-level CONST arrow handler (const onX = (e) => { document.getElementById(...) }; then addEventListener(..., onX))',
        (h) => injectBeforeLoop(h, "    const auditOnInput = (e) => {\n        document.getElementById('sa-w-v').textContent = 'x';\n    };\n    $('sa-w').addEventListener('change', auditOnInput);"),
        'DemoAudit.test.mjs:103-115 scans only `function name(){}` bodies and inline `(args) => {` handlers'],
    ['QA-6', 'no DOM lookup inside a function body', "a lookup in a `function (e) { }` expression handler (document.addEventListener('keyup', function (e) { ... }))",
        (h) => injectBeforeLoop(h, "    document.addEventListener('keyup', function (e) {\n        document.getElementById('sa-w-v').textContent = 'x';\n    });"),
        'DemoAudit.test.mjs:110 handler regex requires an arrow `(args) => {`'],
    ['QA-7', 'no format / template / string build in a per-frame body', "an uncached string concatenation drawn every frame (g.fillText('max ' + saVMax, ...) in saDraw)",
        (h) => intoSaDraw(h, "        if (saCtx) saCtx.fillText('max ' + saVMax, 0, 0);"),
        'DemoAudit.test.mjs:132 matches toFixed / toLocaleString / toExponential / backtick only, not `+` string builds'],
    ['QA-8', 'no layout read after a layout write in one body', 'a layout write followed by a CALL to the layout reader (el.style.width = ...; measureScene(tab)) -- a forced reflow across one call',
        (h) => injectBeforeLoop(h, "    function auditResize(el, tab) { el.style.width = '10px'; measureScene(tab); }"),
        'DemoAudit.test.mjs:141-145 checks the write -> read order inside ONE body only'],
];

for (const [id, rule, what, mutate, where] of AUDIT_GAPS) {
    test(id + ' DEMO AUDIT catches (fixed 2026-10-04; was: ' + where + '): ' + what, () => {
        const bad = mutate(HTML);
        assert.notEqual(bad, HTML, 'mutation applied');
        const r = runAuditOn(bad);
        assert.notEqual(r.status, 0, 'the audit must go RED on ' + what);
        assert.ok(notOk(r.out, rule));
    });
}
