// @zakkster/lite-adaptive -- 1.10.0 SCM/SDD time-grid parity gate (repo-only; run:
//   node --test test/differential/GridParity.test.mjs).
//
// H2-1 (ROADMAP 10.1) moves SlidingCountMin / SlidingDDSketch pane ends from the accumulated
// `E += pw` to the exact grid `(floor(t/pw)+1)*pw` and adds a numeric-domain clock bound. Section 3.4:
// for a DYADIC pw the two are BIT-IDENTICAL; for a NON-DYADIC pw a boundary may move by the
// accumulated drift and then matches the exact-grid oracle. This gate freezes the 1.9.0 (HEAD)
// behavior so batch 2's fix is proven output-preserving where it must be:
//
//   - D (dyadic pw: W in {32, 1000, 60000} at 32 panes -> pw 1, 31.25, 1875): every per-add series
//     (SCM 4 probe-key estimates + total(W) + total(W/2); SDD count() + count(W/2) + quantile(.5) +
//     quantile(.99)) is asserted BIT-IDENTICAL to the golden. LIVE.
//   - count-mode (W=1000, tick clock): same, BIT-IDENTICAL. LIVE.
//   - N (non-dyadic pw: W=1000 @ 30 panes -> 33.33..; W=1e4/3 @ 7 panes -> 476.19..): replayed live
//     and reported (final query values + a per-add drift count vs the in-test grid oracle). NOT
//     asserted here -- batch 2 re-pins N against the grid oracle once the fix lands.
//
// SIZE: the golden stores each per-add series as a sha256 digest of the full IEEE-hex series plus a
// SPARSE sample (first 20, every 100th, last 20), not the whole 20k-entry stream (12.8 MB -> ~0.24 MB).
// The test recomputes the full series live, compares its digest bit-for-bit, and on a mismatch reports
// the first diverging SAMPLED index. The golden is a DATA file inside the package
// (grid-1.9.0-vectors.json); this test imports only package files. The STREAM block below is a
// VERBATIM copy of the generator's block.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SlidingCountMin, SlidingDDSketch } from '../../Adaptive.js';

const V = JSON.parse(readFileSync(
    fileURLToPath(new URL('./grid-1.9.0-vectors.json', import.meta.url)), 'utf8'));

const dv = new DataView(new ArrayBuffer(8));
function hx(x) { dv.setFloat64(0, x); return dv.getBigUint64(0).toString(16).padStart(16, '0'); }

// ===== STREAM (VERBATIM copy of the generator's block) =====
const NOW0 = 1.75e12;
const ADDS = 20000;
const PROBE_KEYS = [1, 33, 66, 97];
function scmKey(j) { return ((j * 733) % 97) + 1; }
function sddVal(j) { return ((j * 40503) % 9973) + 0.5; }
function stepAt(j) { return 1.5 + 0.25 * (j % 7); }

function scmRun(W, opts, countMode) {
    const scm = new SlidingCountMin(W, opts);
    const est = [[], [], [], []];
    const totW = [], totH = [];
    const buf = new Float64Array(3);
    let now = NOW0;
    for (let j = 0; j < ADDS; j++) {
        const key = scmKey(j), cnt = (j % 5) + 1;
        if (countMode) { scm.add(undefined, key, cnt); }
        else { now += stepAt(j); buf[0] = now; buf[1] = key; buf[2] = cnt; scm.addFrom(buf, 0); }
        for (let p = 0; p < 4; p++) est[p].push(hx(scm.estimate(PROBE_KEYS[p], W)));
        totW.push(hx(scm.total(W)));
        totH.push(hx(scm.total(W / 2)));
    }
    return { est: est.map((a) => a.join('')), totW: totW.join(''), totH: totH.join('') };
}
function sddRun(W, opts, countMode) {
    const sd = new SlidingDDSketch(W, opts);
    const cW = [], cH = [], q50 = [], q99 = [];
    const buf = new Float64Array(2);
    let now = NOW0;
    for (let j = 0; j < ADDS; j++) {
        const v = sddVal(j);
        if (countMode) { sd.add(undefined, v); }
        else { now += stepAt(j); buf[0] = now; buf[1] = v; sd.addFrom(buf, 0); }
        cW.push(hx(sd.count()));
        cH.push(hx(sd.count(W / 2)));
        q50.push(hx(sd.quantile(0.5, W)));
        q99.push(hx(sd.quantile(0.99, W)));
    }
    return { cW: cW.join(''), cH: cH.join(''), q50: q50.join(''), q99: q99.join('') };
}
// ===== END STREAM =====

const SCM_OPTS = V.scm.opts;
const SDD_OPTS = V.sdd.opts;

const WIDTH = 16;
function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
// Compare a live concatenated 16-hex series against a golden {len, sha, idx, hex}: digest-first (the
// true bit-for-bit gate); on a mismatch, walk the sparse sample and fail at the FIRST diverging
// sampled index for a useful message (a between-samples-only mismatch is still a hard fail).
function cmp(liveStr, gold, label) {
    const n = liveStr.length / WIDTH;
    assert.equal(n, gold.len, label + ' length drifted (' + n + ' vs ' + gold.len + ')');
    if (sha256(liveStr) === gold.sha) return;
    for (let k = 0; k < gold.idx.length; k++) {
        const i = gold.idx[k];
        const got = liveStr.slice(i * WIDTH, i * WIDTH + WIDTH);
        if (got !== gold.hex[k]) {
            assert.fail(label + ' series digest drifted; first diverging sampled index ' + i +
                ' (got ' + got + ' want ' + gold.hex[k] + ')');
        }
    }
    assert.fail(label + ' series digest drifted but every sampled index agrees -- divergence lies between samples');
}
function assertScm(got, gold, label) {
    for (let p = 0; p < 4; p++) cmp(got.est[p], gold.est[p], label + ' estimate(probe ' + p + ')');
    cmp(got.totW, gold.totW, label + ' total(W)');
    cmp(got.totH, gold.totH, label + ' total(W/2)');
}
function assertSdd(got, gold, label) {
    cmp(got.cW, gold.cW, label + ' count()');
    cmp(got.cH, gold.cH, label + ' count(W/2)');
    cmp(got.q50, gold.q50, label + ' quantile(.5)');
    cmp(got.q99, gold.q99, label + ' quantile(.99)');
}

test('GridParity D: SlidingCountMin dyadic pw (W 32/1000/60000) is bit-identical to the 1.9.0 golden', () => {
    for (const W of [32, 1000, 60000]) assertScm(scmRun(W, SCM_OPTS, false), V.scm.D[W], 'SCM D W=' + W);
});

test('GridParity D: SlidingDDSketch dyadic pw (W 32/1000/60000) is bit-identical to the 1.9.0 golden', () => {
    for (const W of [32, 1000, 60000]) assertSdd(sddRun(W, SDD_OPTS, false), V.sdd.D[W], 'SDD D W=' + W);
});

test('GridParity count-mode: SlidingCountMin (W=1000, tick clock) is bit-identical to the 1.9.0 golden', () => {
    assertScm(scmRun(1000, SCM_OPTS, true), V.scm.count, 'SCM count-mode');
});

test('GridParity count-mode: SlidingDDSketch (W=1000, tick clock) is bit-identical to the 1.9.0 golden', () => {
    assertSdd(sddRun(1000, SDD_OPTS, true), V.sdd.count, 'SDD count-mode');
});

// N (non-dyadic pw) -- batch 2 SCM verdict + re-pin.
// After the exact-grid fix, the SCM N pane ends are grid-correct: every pane end lands within
// ring*ulp(E) of its nearest grid line round(E/pw)*pw (the "within n_rot * ulp(E) of a grid line"
// clause), and the current pane always COVERS now (end-pw <= now < end). The 1.9.0 accumulated-E
// baseline drifted far off the grid (up to ~450 ulp @ panes=30, ~18 @ panes=7), so this gate has teeth
// against a reverted `E += pw`. NOTE (disclosed): the naive division oracle `(floor(now/pw)+1)*pw`
// disagrees with the multiplicative grid at ~50 EXACT-boundary adds (panes=30) -- a division/
// multiplication FP artifact where now sits exactly on a grid line; the fixed pane still covers now and
// is grid-aligned, so the robust (tolerance + coverage) property below is the asserted gate, and the
// SCM N query series is re-pinned bit-for-bit to grid-1.10.0. SDD N stays a printed report (T4 re-pins).
const V10 = JSON.parse(readFileSync(
    fileURLToPath(new URL('./grid-1.10.0-vectors.json', import.meta.url)), 'utf8'));
function ulp(x) { const a = Math.abs(x); return a === 0 ? Number.MIN_VALUE : 2 ** (Math.floor(Math.log2(a)) - 52); }

test('GridParity N (SCM, non-dyadic): every pane end is grid-aligned (within ring*ulp) and covers now', () => {
    for (const c of [{ W: 1000, panes: 30 }, { W: 10000 / 3, panes: 7 }]) {
        const opts = { ...SCM_OPTS, panes: c.panes }, pw = c.W / c.panes;
        const scm = new SlidingCountMin(c.W, opts), buf = new Float64Array(3), ring = c.panes + 1;
        let now = NOW0;
        for (let j = 0; j < ADDS; j++) {
            now += stepAt(j); buf[0] = now; buf[1] = scmKey(j); buf[2] = (j % 5) + 1; scm.addFrom(buf, 0);
            for (let p = 0; p < scm._ring; p++) {
                const e = scm._paneEnd[p], d = Math.abs(e - Math.round(e / pw) * pw);
                assert.ok(d <= ring * ulp(e),
                    'SCM N W=' + c.W + ' panes=' + c.panes + ': pane ' + p + ' end ' + e +
                    ' is ' + (d / ulp(e)).toFixed(1) + ' ulp off the grid (> ring*ulp) at add ' + j);
            }
            const end = scm._paneEnd[scm._cur];
            assert.ok((end - pw) <= now && now < end,
                'SCM N W=' + c.W + ' panes=' + c.panes + ': current pane [' + (end - pw) + ', ' + end +
                ') must cover now=' + now + ' at add ' + j);
            // Neighbouring pane ends must differ by EXACTLY pw (within ring*ulp) and be DISTINCT. This is
            // the self-contained (golden-free) teeth against a Math.floor-for-Math.round index mutant in
            // _advance: floor picks the wrong grid index k, so a pane end lands one pw off its neighbour
            // (a repeated or a doubled gap) while every end still sits ON a grid line -- invisible to the
            // round(E/pw)*pw tolerance clause above (which only sees off-grid drift, e.g. a reverted E+=pw).
            const ends = Array.from(scm._paneEnd).sort((a, b) => a - b);
            for (let q = 1; q < ends.length; q++) {
                const gap = ends[q] - ends[q - 1];
                assert.ok(gap > 0,
                    'SCM N W=' + c.W + ' panes=' + c.panes + ': pane ends must be distinct, got a repeat ' +
                    ends[q] + ' at add ' + j);
                assert.ok(Math.abs(gap - pw) <= ring * ulp(ends[q]),
                    'SCM N W=' + c.W + ' panes=' + c.panes + ': neighbouring pane ends must differ by pw (' +
                    pw + '), got gap ' + gap + ' at add ' + j);
            }
        }
    }
});

test('GridParity N (SCM, non-dyadic): query series is bit-identical to the grid-1.10.0 golden (re-pin)', () => {
    for (const [k, c] of [['W1000_p30', { W: 1000, panes: 30 }], ['W3333_p7', { W: 10000 / 3, panes: 7 }]]) {
        assertScm(scmRun(c.W, { ...SCM_OPTS, panes: c.panes }, false), V10.scm.N[k], 'SCM N ' + k);
    }
});

// N (non-dyadic pw) -- T4 SDD verdict + re-pin (mirrors the SCM N gate above). After the exact-grid fix
// the SDD N pane ends are grid-correct: every pane end lands within ring*ulp(E) of round(E/pw)*pw, and
// the current pane always COVERS now (end-pw <= now < end). The 1.9.0 accumulated-E baseline drifted far
// off the grid, so this gate has teeth against a reverted `E += pw`. The SDD N query series is then
// re-pinned bit-for-bit to grid-1.10.0.
test('GridParity N (SDD, non-dyadic): every pane end is grid-aligned (within ring*ulp) and covers now', () => {
    for (const c of [{ W: 1000, panes: 30 }, { W: 10000 / 3, panes: 7 }]) {
        const opts = { ...SDD_OPTS, panes: c.panes }, pw = c.W / c.panes;
        const sd = new SlidingDDSketch(c.W, opts), buf = new Float64Array(2), ring = c.panes + 1;
        let now = NOW0;
        for (let j = 0; j < ADDS; j++) {
            now += stepAt(j); buf[0] = now; buf[1] = sddVal(j); sd.addFrom(buf, 0);
            for (let p = 0; p < sd._ring; p++) {
                const e = sd._paneEnd[p], d = Math.abs(e - Math.round(e / pw) * pw);
                assert.ok(d <= ring * ulp(e),
                    'SDD N W=' + c.W + ' panes=' + c.panes + ': pane ' + p + ' end ' + e +
                    ' is ' + (d / ulp(e)).toFixed(1) + ' ulp off the grid (> ring*ulp) at add ' + j);
            }
            const end = sd._paneEnd[sd._cur];
            assert.ok((end - pw) <= now && now < end,
                'SDD N W=' + c.W + ' panes=' + c.panes + ': current pane [' + (end - pw) + ', ' + end +
                ') must cover now=' + now + ' at add ' + j);
            // Neighbouring pane ends must differ by EXACTLY pw (within ring*ulp) and be DISTINCT -- the
            // self-contained (golden-free) teeth against a Math.floor-for-Math.round index mutant in
            // _advance (a pane end one pw off its neighbour while still ON a grid line, invisible to the
            // round(E/pw)*pw tolerance clause above).
            const ends = Array.from(sd._paneEnd).sort((a, b) => a - b);
            for (let q = 1; q < ends.length; q++) {
                const gap = ends[q] - ends[q - 1];
                assert.ok(gap > 0,
                    'SDD N W=' + c.W + ' panes=' + c.panes + ': pane ends must be distinct, got a repeat ' +
                    ends[q] + ' at add ' + j);
                assert.ok(Math.abs(gap - pw) <= ring * ulp(ends[q]),
                    'SDD N W=' + c.W + ' panes=' + c.panes + ': neighbouring pane ends must differ by pw (' +
                    pw + '), got gap ' + gap + ' at add ' + j);
            }
        }
    }
});

test('GridParity N (SDD, non-dyadic): query series is bit-identical to the grid-1.10.0 golden (re-pin)', () => {
    for (const [k, c] of [['W1000_p30', { W: 1000, panes: 30 }], ['W3333_p7', { W: 10000 / 3, panes: 7 }]]) {
        assertSdd(sddRun(c.W, { ...SDD_OPTS, panes: c.panes }, false), V10.sdd.N[k], 'SDD N ' + k);
    }
});

// TEETH: the gate is a full-series sha256, so ONE flipped hex digit anywhere in the 20k-entry series
// must change the digest and go RED. Prove it: the live replay's digest matches the golden, and a
// single-nibble flip of that same live series produces a DIFFERENT digest (so no drift slips the gate).
test('GridParity CONTROL: a one-hex-digit flip changes the series digest (gate has teeth)', () => {
    const got = scmRun(1000, SCM_OPTS, false);
    const series = got.totW;
    const gold = V.scm.D['1000'].totW;
    assert.equal(sha256(series), gold.sha, 'sanity: the live replay digest matches the true golden');
    const pos = 40;   // some mid-series nibble
    const flip = (parseInt(series[pos], 16) ^ 0x1).toString(16);
    const mutated = series.slice(0, pos) + flip + series.slice(pos + 1);
    assert.notEqual(mutated, series, 'sanity: the flip changed the series string');
    assert.notEqual(sha256(mutated), gold.sha, 'a one-hex-digit flip must change the digest (gate is toothless)');
});
