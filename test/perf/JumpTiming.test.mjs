// @zakkster/lite-adaptive -- the huge-jump TIMING gate (repo-only; run via `npm run test:perf:matrix`,
// pinned semi-space, --expose-gc).
//
// N5 (task 11): a +1e12 clock jump must stay BOUNDED. The pane-ring members cap their rotate-and-clear
// at B+1 panes (a jump of k panes clears min(k, B+1), NEVER loops k), so `advance(now + 1e12)` + the
// next add is O(B), not O(jump). This gate measures per-op wall time over many trials (median + p99,
// after a warm-up) and asserts p99 < 1.0 ms.
//
// Members:
//   - SCM: advance(now + 1e12) then add -- the headline. p99 < 1.0 ms over >= 100 trials. HARD.
//   - FD, DR: a +1e12 jump carried on add() (neither exposes advance()). FD's landmark rebase is O(1)
//     and DR's order-preserving rebase is O(k); both are measured in MICROSECONDS. Gate: p99 < 1.0 ms
//     -- a generous but FINITE bound (~1000x the measured cost) that still trips if a future change
//     makes the jump path loop with the jump magnitude.
//   - PerPaneLoopScm: a subclass whose `_advance` loops ONCE PER SKIPPED PANE (the naive, uncapped
//     implementation). Overriding the private rotation IS possible from a subclass (it only touches
//     `this._paneW/_ring/_cur/_paneEnd/_clearPane`), so no Adaptive.js change is needed. It MUST FAIL
//     the same p99 < 1.0 ms gate. A full +1e12 jump would not terminate at all (paneW=125 -> 8e9
//     iterations) -- that is precisely the pathology the B+1 cap prevents -- so the control drives a
//     bounded-but-large jump that already clears enough panes to blow the budget while finishing.
//
// ASCII-only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ForwardDecay, SlidingDDSketch, SlidingCountMin, DecayedReservoir } from '../../Adaptive.js';

const JUMP = 1e12;
const TRIALS = 200;
const WARM = 200;

function percentile(sorted, p) {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
}

/** Run `step(i)` for WARM warm-up iterations, then TRIALS timed iterations; return { p50, p99, max }. */
function timeSteps(step, trials = TRIALS, warm = WARM) {
    for (let i = 0; i < warm; i++) step(i);
    const times = new Float64Array(trials);
    for (let i = 0; i < trials; i++) {
        const t0 = performance.now();
        step(warm + i);
        times[i] = performance.now() - t0;
    }
    const s = Array.from(times).sort((a, b) => a - b);
    return { p50: percentile(s, 0.5), p99: percentile(s, 0.99), max: s[s.length - 1] };
}

/**
 * The naive per-pane rotation: loops ONCE PER SKIPPED PANE with NO cap. On a k-pane jump this is
 * O(k) -- the exact blow-up the shipped B+1 cap prevents. (Overriding a private method from a
 * subclass is possible here because `_advance` reads only instance fields + `_clearPane`.)
 */
class PerPaneLoopScm extends SlidingCountMin {
    _advance(t) {
        const pw = this._paneW, B = this._ring;
        let cur = this._cur;
        let E = this._paneEnd[cur];
        while (t >= E) {                 // NO `rot < B` cap: one iteration per skipped pane
            cur++; if (cur === B) cur = 0;
            this._clearPane(cur);
            E += pw;
            this._paneEnd[cur] = E;
        }
        this._cur = cur;
    }
}

test('hugeJump', async (t) => {
    const results = [];

    // --- SCM advance(now + 1e12) + add: the O(B) capped path. HARD p99 < 1.0 ms. ---
    await t.test('SCM advance(now + 1e12) + add: p99 < 1.0 ms', () => {
        const scm = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 });
        let now = 1000;
        scm.add(now, 5);                              // lock EXPLICIT mode
        const r = timeSteps((i) => { now += JUMP; scm.advance(now); scm.add(now, (i & 7) + 1); });
        results.push(['SCM advance(+1e12)+add', r, 1.0]);
        assert.ok(r.p99 < 1.0, 'SCM huge-jump p99 ' + r.p99.toFixed(4) + ' ms >= 1.0 ms (jump path is not O(B))');
    });

    // --- FD +1e12 jump carried on add(): O(1) landmark rebase. Generous finite gate. ---
    await t.test('FD add across a +1e12 jump: p99 < 1.0 ms (O(1) rebase)', () => {
        const fd = new ForwardDecay(1e9);
        let now = 1000;
        fd.add(now, 1);
        const r = timeSteps((i) => { now += JUMP; fd.add(now, (i & 7) + 1); });
        results.push(['FD add(+1e12)', r, 1.0]);
        assert.ok(r.p99 < 1.0, 'FD huge-jump p99 ' + r.p99.toFixed(4) + ' ms >= 1.0 ms (rebase is not O(1))');
    });

    // --- DR +1e12 jump carried on add(): O(k) order-preserving rebase. Generous finite gate. ---
    await t.test('DR add across a +1e12 jump: p99 < 1.0 ms (O(k) rebase)', () => {
        const dr = new DecayedReservoir(32, 100000, { seed: 7 });
        let now = 1000;
        dr.add(now, 1);
        const r = timeSteps((i) => { now += JUMP; dr.add(now, (i & 63) + 0.5); });
        results.push(['DR add(+1e12)', r, 1.0]);
        assert.ok(r.p99 < 1.0, 'DR huge-jump p99 ' + r.p99.toFixed(4) + ' ms >= 1.0 ms (rebase is not bounded)');
    });

    // --- SDD advance(now + 1e12) + add: corroborating capped path (informational + a loose gate). ---
    await t.test('SDD advance(now + 1e12) + add: p99 < 1.0 ms', () => {
        const sd = new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 });
        let now = 1000;
        sd.add(now, 1.5);
        const r = timeSteps((i) => { now += JUMP; sd.advance(now); sd.add(now, (i & 63) + 0.5); });
        results.push(['SDD advance(+1e12)+add', r, 1.0]);
        assert.ok(r.p99 < 1.0, 'SDD huge-jump p99 ' + r.p99.toFixed(4) + ' ms >= 1.0 ms (jump path is not O(B))');
    });

    // --- CONTROL: the naive per-pane loop MUST FAIL the same p99 < 1.0 ms gate. ---
    await t.test('PerPaneLoopScm advance + add MUST FAIL p99 < 1.0 ms (naive O(jump) rotation)', () => {
        // paneW = 1000/8 = 125; a 4e7 jump clears ~320k panes per trial (each an O(d*w) fill) -> ms-scale
        // (~10 ms measured), well over the 1.0 ms budget, while the shipped SCM does the SAME jump in
        // O(B). (A full +1e12 jump here would not terminate -- the very pathology the B+1 cap prevents.)
        const CTRL_JUMP = 4e7;
        const scm = new PerPaneLoopScm(1000, { panes: 8, w: 128, d: 4, seed: 7 });
        let now = 1000;
        scm.add(now, 5);
        const r = timeSteps((i) => { now += CTRL_JUMP; scm.advance(now); scm.add(now, (i & 7) + 1); }, 40, 10);
        results.push(['PerPaneLoopScm(+4e7)', r, 1.0]);
        assert.ok(r.p99 >= 1.0, 'PerPaneLoopScm p99 ' + r.p99.toFixed(4) + ' ms < 1.0 ms -- the naive loop did NOT blow the budget (control has no teeth)');
    });

    // --- report ---
    console.log('');
    console.log('  N5 hugeJump timing (per-op wall time over ' + TRIALS + ' trials after ' + WARM + ' warm-up):');
    console.log('  ' + 'lane'.padEnd(30) + 'p50 ms'.padStart(10) + 'p99 ms'.padStart(10) + 'max ms'.padStart(10) + '  budget  status');
    console.log('  ' + '-'.repeat(30) + ' ' + '-'.repeat(9) + ' ' + '-'.repeat(9) + ' ' + '-'.repeat(9) + '  ------  ------');
    for (const [name, r, budget] of results) {
        const isCtrl = name.indexOf('PerPaneLoop') === 0;
        const ok = isCtrl ? r.p99 >= budget : r.p99 < budget;
        console.log('  ' + name.padEnd(30) + r.p50.toFixed(4).padStart(10) + r.p99.toFixed(4).padStart(10) +
            r.max.toFixed(4).padStart(10) + '  < ' + budget.toFixed(1) + '   ' +
            (isCtrl ? (ok ? 'FAILS-GATE (ok, teeth)' : 'NO TEETH') : (ok ? 'GREEN' : 'FAIL')));
    }
});
