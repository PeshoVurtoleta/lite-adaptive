// @zakkster/lite-adaptive -- the allocation MATRIX gate (repo-only; run:
//   node --expose-gc --min-semi-space-size=4 --max-semi-space-size=4 --test test/perf/AllocMatrix.test.mjs
// or via `npm run test:perf:matrix`).
//
// STEP 1 (gates only) of the 1.7.0 hardening -- TEST-ONLY, no Adaptive.js change. Three lanes:
//   - sharedCallAdd (N2): a megamorphic `o.add(a, b)` call site fed >= 5 classes. This is a CONTROL:
//     a fractional arg through a non-inlinable site MUST box (>= one box/op), proving the lane has
//     teeth. FD and DD are asserted.
//   - addFromMatrix (N3): every member's zero-box addFrom over clock x key x count x fresh/warmed.
//     Gate: steady B/op <= 0.5 (== the no-op baseline). HK addFrom with a large / negative key or a
//     weight 2^30 was F3 (a boxed key / weight / seed argument); FIXED -- every HK lane, including
//     the default-seed variants, now reads <= 0.5 with no `todo`. No todo remains anywhere.
//   - queryLanes (N4): the windowed READ paths. F5 landed: SDD quantileInto renders 0-alloc, scalar
//     quantile(0.99) boxes EXACTLY one ~16 B HeapNumber return (asserted 16 +-0.5, both ways). SCM
//     estimateInto (1.8.0) reads a count >= 2^31 into an out slot with no boxed return (<= 0.5,
//     fresh + warmed), and SCM total() is 0 B/op; the plain estimate() of that count is KEPT as the must-box control
//     (q_scm_estimate_big, 16 +-0.5 B/op) so the lane proves it can see the box. EH sum /
//     HK estimate box only in the FIRST window (steady 0, printed).
//
// Each lane runs in its OWN pinned child (AllocProbe.runLane via LITE_LANE) so fresh vs warmed call
// sites never contaminate each other; a small pool parallelizes the children. Measurement is the
// steadyMin B/op (the minimum over >= 4 windows with both semi-space flags pinned + fail-closed); the
// first window is printed next to it and is never a floor. ASCII-only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { runLane, LANES, assertSemiSpacePinned } from './AllocProbe.mjs';
import { SlidingAggregate } from '../../Adaptive.js';

assertSemiSpacePinned();                 // fail closed if the semi-space flags are not pinned
process.env.LITE_MATRIX = '1';           // children skip the 8N scavenge sweep (matrix gates on B/op)

const GATES_STRICT = process.env.LITE_GATES_STRICT === '1';
const POOL = Math.max(2, Math.min(8, (os.cpus() || []).length || 4));

/** Bounded-concurrency pool over `items`, calling `fn(item)` -- returns results in input order. */
async function runPool(items, conc, fn) {
    const out = new Array(items.length);
    let idx = 0;
    async function worker() { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i]); } }
    const workers = [];
    for (let w = 0; w < Math.min(conc, items.length); w++) workers.push(worker());
    await Promise.all(workers);
    return out;
}

/** Measure every lane in a group through the child pool, keyed by lane+mode (+ optional r.flags,
 *  F19: extra node flags per row, e.g. ['--no-turbo-inlining']). */
async function measureGroup(rows) {
    const res = await runPool(rows, POOL, (r) => runLane(r.lane, r.mode || 'fresh', 200000, r.flags || []));
    for (let i = 0; i < rows.length; i++) { rows[i]._first = res[i].first; rows[i]._steady = res[i].steady; rows[i]._execArgv = res[i].execArgv; }
    return rows;
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

/** One lane -> one (possibly `todo`) subtest. `check(steady, first)` returns null on pass or a reason. */
async function emit(t, row, check) {
    const opts = (row.id && !GATES_STRICT) ? { todo: row.id } : {};
    await t.test(row.label + (row.id ? ' [' + row.id + ']' : ''), opts, () => {
        const reason = check(row._steady, row._first);
        assert.ok(reason === null, reason + '  (first=' + row._first + ' steady=' + row._steady + ')');
    });
}

function printTable(title, rows, statusOf) {
    console.log('');
    console.log('  ' + title);
    console.log('  ' + pad('lane', 34) + padL('first', 8) + padL('steady', 8) + '  ' + pad('expected', 10) + 'status');
    console.log('  ' + '-'.repeat(34) + ' ' + '-'.repeat(7) + ' ' + '-'.repeat(7) + '  ' + '-'.repeat(10) + '------');
    for (const r of rows) {
        console.log('  ' + pad(r.label, 34) + padL(r._first, 8) + padL(r._steady, 8) + '  ' +
            pad(r.expected, 10) + statusOf(r));
    }
}

// ===========================================================================
// N2 (task 8): sharedCallAdd -- the megamorphic call-site CONTROL. It MUST box.
// ===========================================================================
test('sharedCallAdd', async (t) => {
    const rows = [
        { lane: 'shared_fd', mode: 'warmed', label: 'FD via shared o.add(a,b)', expected: '>=16 box' },
        { lane: 'shared_dd', mode: 'warmed', label: 'DD via shared o.add(a,b)', expected: '>=16 box' },
        { lane: 'shared_eh', mode: 'warmed', label: 'EH via shared o.add(a,b)', expected: '>=16 box' },
        { lane: 'shared_sdd', mode: 'warmed', label: 'SDD via shared o.add(a,b)', expected: '>=16 box' },
    ];
    await measureGroup(rows);
    // >= 12 proves >= one 16 B HeapNumber boxed at the megamorphic boundary (the no-op floor is ~0).
    const teeth = (steady) => (steady >= 12 ? null : 'shared call site did NOT box (>= 12 B/op required, lane has no teeth)');
    printTable('N2 sharedCallAdd (megamorphic control -- MUST box):', rows,
        (r) => (r._steady >= 12 ? 'GREEN (teeth)' : 'NO TEETH'));
    // FD and DD are the asserted controls (task 8); EH/SDD are printed corroboration.
    for (const r of rows) await emit(t, r, teeth);
});

// ===========================================================================
// N3 (task 9): addFromMatrix -- steady B/op <= 0.5 for every zero-box addFrom (F3 fixed: HK too).
// ===========================================================================
test('addFromMatrix', async (t) => {
    const rows = [
        // HeavyKeeper: key x weight, fresh + warmed. F3 FIXED -- large / negative keys AND weight
        // 2^30 now read 0 B/op (the numeric inputs route through the HK_KIN slot, never a boxed arg).
        { lane: 'hk_af_small_w1', mode: 'fresh', label: 'HK addFrom small key w=1', expected: '<=0.5' },
        { lane: 'hk_af_p30_w1', mode: 'fresh', label: 'HK addFrom key 2^30 w=1', expected: '<=0.5' },
        { lane: 'hk_af_p31_w1', mode: 'fresh', label: 'HK addFrom key 2^31 w=1', expected: '<=0.5' },
        { lane: 'hk_af_p32m1_w1', mode: 'fresh', label: 'HK addFrom key 2^32-1 w=1', expected: '<=0.5' },
        { lane: 'hk_af_p53m1_w1', mode: 'fresh', label: 'HK addFrom key 2^53-1 w=1', expected: '<=0.5' },
        { lane: 'hk_af_neg31_w1', mode: 'fresh', label: 'HK addFrom key -2^31 w=1', expected: '<=0.5' },
        { lane: 'hk_af_small_wp30', mode: 'fresh', label: 'HK addFrom small key w=2^30', expected: '<=0.5' },
        { lane: 'hk_af_p31_wp30', mode: 'fresh', label: 'HK addFrom key 2^31 w=2^30', expected: '<=0.5' },
        { lane: 'hk_af_p31_w1', mode: 'warmed', label: 'HK addFrom key 2^31 w=1 (warm)', expected: '<=0.5' },
        { lane: 'hk_af_neg31_w1', mode: 'warmed', label: 'HK addFrom key -2^31 w=1 (warm)', expected: '<=0.5' },
        { lane: 'hk_af_small_w1', mode: 'warmed', label: 'HK addFrom small key w=1 (warm)', expected: '<=0.5' },
        // default-seed (0x9e3779b1, a HeapNumber field) variants -- a Smi seed=4 would hide a
        // seed-arg box; these prove the default seed also reads 0 B/op through the slot.
        { lane: 'hk_af_p31_w1_defseed', mode: 'fresh', label: 'HK addFrom key 2^31 w=1 def-seed', expected: '<=0.5' },
        { lane: 'hk_af_p31_wp30_defseed', mode: 'fresh', label: 'HK addFrom key 2^31 w=2^30 def-seed', expected: '<=0.5' },
        // SlidingHyperLogLog: clock x large key, fresh + warmed. Its two-lane murmur keeps large keys
        // unboxed (design-parity), so every lane is green.
        { lane: 'shll_af_now_p31', mode: 'fresh', label: 'SHLL addFrom now-scale key 2^31', expected: '<=0.5' },
        { lane: 'shll_af_now_p53m1', mode: 'fresh', label: 'SHLL addFrom now-scale key 2^53-1', expected: '<=0.5' },
        { lane: 'shll_af_epoch_p31', mode: 'fresh', label: 'SHLL addFrom epoch key 2^31', expected: '<=0.5' },
        { lane: 'shll_af_epoch_p53m1', mode: 'fresh', label: 'SHLL addFrom epoch key 2^53-1', expected: '<=0.5' },
        { lane: 'shll_af_epoch_p31', mode: 'warmed', label: 'SHLL addFrom epoch key 2^31 (warm)', expected: '<=0.5' },
        // SlidingCountMin: clock x key x count. addFrom keeps keys/counts unboxed -> green (a scalar
        // estimate() of a count >= 2^31 still boxes its single return; the batch estimateInto reader
        // avoids it -- see queryLanes).
        { lane: 'scm_af_epoch_small_c1', mode: 'fresh', label: 'SCM addFrom small key count=1', expected: '<=0.5' },
        { lane: 'scm_af_epoch_p31_c1', mode: 'fresh', label: 'SCM addFrom key 2^31 count=1', expected: '<=0.5' },
        { lane: 'scm_af_epoch_p32m1_c1', mode: 'fresh', label: 'SCM addFrom key 2^32-1 count=1', expected: '<=0.5' },
        { lane: 'scm_af_epoch_p31_cp30', mode: 'fresh', label: 'SCM addFrom key 2^31 count=2^30', expected: '<=0.5' },
        { lane: 'scm_af_epoch_p31_c1', mode: 'warmed', label: 'SCM addFrom key 2^31 count=1 (warm)', expected: '<=0.5' },
        // Scalar / clock-only members (fresh + one warmed each).
        { lane: 'eh_af_now', mode: 'fresh', label: 'EH addFrom now-scale', expected: '<=0.5' },
        { lane: 'eh_af_epoch', mode: 'fresh', label: 'EH addFrom epoch', expected: '<=0.5' },
        { lane: 'eh_af_epoch', mode: 'warmed', label: 'EH addFrom epoch (warm)', expected: '<=0.5' },
        { lane: 'fd_af_now', mode: 'fresh', label: 'FD addFrom now-scale', expected: '<=0.5' },
        { lane: 'fd_af_epoch', mode: 'fresh', label: 'FD addFrom epoch', expected: '<=0.5' },
        { lane: 'fd_af_epoch', mode: 'warmed', label: 'FD addFrom epoch (warm)', expected: '<=0.5' },
        { lane: 'sd_af_epoch', mode: 'fresh', label: 'SDD addFrom epoch', expected: '<=0.5' },
        { lane: 'sd_af_epoch', mode: 'warmed', label: 'SDD addFrom epoch (warm)', expected: '<=0.5' },
        { lane: 'dr_af_epoch', mode: 'fresh', label: 'DR addFrom epoch', expected: '<=0.5' },
        { lane: 'dr_af_epoch', mode: 'warmed', label: 'DR addFrom epoch (warm)', expected: '<=0.5' },
        { lane: 'adwin_af', mode: 'fresh', label: 'ADWIN addFrom value', expected: '<=0.5' },
        { lane: 'adwin_af', mode: 'warmed', label: 'ADWIN addFrom value (warm)', expected: '<=0.5' },
        { lane: 'dd_af', mode: 'fresh', label: 'DD addFrom value', expected: '<=0.5' },
        { lane: 'dd_af', mode: 'warmed', label: 'DD addFrom value (warm)', expected: '<=0.5' },
        // DD latch steady-state, addFrom, FRACTIONAL threshold 5.5 (arm+clamp+re-arm cold path every window).
        { lane: 'dd_latch_af', mode: 'fresh', label: 'DD latch addFrom frac-threshold', expected: '<=0.5' },
        { lane: 'dd_latch_af', mode: 'warmed', label: 'DD latch addFrom frac-threshold (warm)', expected: '<=0.5' },
    ];
    await measureGroup(rows);
    const gate = (steady) => (steady <= 0.5 ? null : 'steady ' + steady + ' B/op > 0.5 (a box on a zero-box addFrom path)');
    printTable('N3 addFromMatrix (steady B/op <= 0.5; F3 fixed -- every HK lane is zero-box):', rows, (r) => {
        if (r._steady <= 0.5) return r.id ? 'todo ' + r.id + ' (green here)' : 'GREEN';
        return r.id ? 'todo ' + r.id : 'NEW FINDING';
    });
    for (const r of rows) await emit(t, r, gate);
});

// ===========================================================================
// N4 (task 10): queryLanes -- the windowed READ paths.
// ===========================================================================
test('queryLanes', async (t) => {
    const gate = (steady) => (steady <= 0.5 ? null : 'steady ' + steady + ' B/op > 0.5 (a box on the read path)');
    // F5 landed: quantileInto now renders 0-alloc (_walkInto writes each cell, no boxed return); the
    // scalar quantile(0.99) boxes EXACTLY one ~16 B HeapNumber for its single return (documented, not
    // a leak) -- an exact expectation both ways so it can neither silently regress to 32 nor be
    // mislabeled 0.
    const box16 = (steady) => (Math.abs(steady - 16) <= 0.5 ? null :
        'steady ' + steady + ' B/op != 16 +-0.5 (the one documented HeapNumber return)');
    const rows = [
        { lane: 'q_sdd_quantileInto', mode: 'fresh', label: 'SDD quantileInto (3 qs)', expected: '<=0.5', check: gate },
        { lane: 'q_sdd_quantile99', mode: 'fresh', label: 'SDD quantile(0.99)', expected: '16 +-0.5', check: box16 },
        { lane: 'q_sdd_count', mode: 'fresh', label: 'SDD count()', expected: '<=0.5', check: gate },
        { lane: 'q_scm_estimateInto_big', mode: 'fresh', label: 'SCM estimateInto (count>=2^31)', expected: '<=0.5', check: gate },
        { lane: 'q_scm_estimateInto_big', mode: 'warmed', label: 'SCM estimateInto (warmed)', expected: '<=0.5', check: gate },
        // CONTROL: the plain scalar estimate() returning a >=2^31 double MUST box (the estimateInto foil).
        { lane: 'q_scm_estimate_big', mode: 'fresh', label: 'SCM estimate(bigKey) [must-box control]', expected: '16 +-0.5', check: box16 },
        { lane: 'q_scm_total', mode: 'fresh', label: 'SCM total()', expected: '<=0.5', check: gate },
        { lane: 'q_scm_total', mode: 'warmed', label: 'SCM total() (warmed)', expected: '<=0.5', check: gate },
        { lane: 'q_eh_sum', mode: 'fresh', label: 'EH sum() (first-window box)', expected: '<=0.5', check: gate },
        { lane: 'q_hk_estimate', mode: 'fresh', label: 'HK estimate() (small count)', expected: '<=0.5', check: gate },
        { lane: 'q_hk_foreach', mode: 'fresh', label: 'HK forEach(fn)', expected: '<=0.5', check: gate },
        { lane: 'q_dr_sampleInto', mode: 'fresh', label: 'DR sampleInto(buf)', expected: '<=0.5', check: gate },
    ];
    await measureGroup(rows);
    printTable('N4 queryLanes (steady B/op <= 0.5, except the exact quantile-16 box):', rows, (r) => {
        const ok = r.check(r._steady, r._first) === null;
        if (r.id) return ok ? 'todo ' + r.id + ' (green here)' : 'todo ' + r.id;
        return ok ? 'GREEN' : 'NEW FINDING';
    });
    for (const r of rows) await emit(t, r, r.check);
});

// ===========================================================================
// 1.8.0 doc-truth findings: two honest lanes no library alloc gate measured before.
//   - q_shll_count (finding A): SlidingHyperLogLog.count() on a NON-degenerate sketch (thousands of
//     distinct keys). count() keeps its Ertl scratch (no ARRAY alloc) but RETURNS a rounded double --
//     a stable 16 B in the estimator tail, +16 B when the caller is not yet optimized. Documented BAND
//     [12, 40] B/op: the lower bound proves the probe SEES the cost (a 0-alloc claim would fail here),
//     the upper bound fails on a THIRD box (the tail stays exactly one box). Measured 16 B/op steady.
//   - dd_latch_ph_fireheavy (finding B): latched-PH on a fire-heavy square wave. Pre-T8 a latched fire
//     boxed one ~16 B HeapNumber because _clampGap(dir, ph, th) took the threshold/mode DOUBLES as
//     ARGUMENTS across a non-inlined call boundary. v1.10.0 T8 made _clampGap(dir) argument-free (it
//     reads this._mode / this._threshold from slots), so the fire path no longer crosses a double at a
//     call boundary. Measured 0 B/op fresh AND warmed. Gated at <= 0.25 B/op; a regression that restores
//     argument passing (or any per-ADD box, >= 16 B/op) fails RED. latch:false and CUSUM read 0 (the
//     dd_af / dd_latch_af lanes above).
// ===========================================================================
test('docTruthFindings', async (t) => {
    const shllBand = (steady) => (steady >= 12 && steady <= 40 ? null :
        'steady ' + steady + ' B/op outside the documented band [12, 40] (< 12: the probe went blind to the count() box; > 40: a THIRD box regressed the estimator tail)');
    // T8 argument-free _clampGap: the fire path no longer boxes -- 0 B/op fresh AND warmed. The <=0.5
    // ceiling catches a regression to argument passing (or any per-add box, >= 16 B/op).
    // <= 0.25, not 0.5: the pre-T8 arg-passing _clampGap read EXACTLY 0.5 steady on this lane, so a 0.5 bar
    // could not see the regression. The fixed code reads 0 fresh + warmed.
    const fireCeil = (steady) => (steady <= 0.25 ? null :
        'steady ' + steady + ' B/op > 0.25 (a latched-PH fire box regressed -- likely _clampGap arg passing restored)');
    const rows = [
        { lane: 'q_shll_count', mode: 'fresh', label: 'SHLL count() non-degenerate [finding A]', expected: '[12,40]', check: shllBand },
        { lane: 'dd_latch_ph_fireheavy', mode: 'fresh', label: 'DD latch:true PH fire-heavy [finding B]', expected: '<=0.25', check: fireCeil },
        { lane: 'dd_latch_ph_fireheavy', mode: 'warmed', label: 'DD latch:true PH fire-heavy (warm)', expected: '<=0.25', check: fireCeil },
    ];
    await measureGroup(rows);
    printTable('1.8.0 docTruthFindings (SHLL count() band [12,40]; latched-PH fire ceiling <=0.25):', rows, (r) => {
        const ok = r.check(r._steady, r._first) === null;
        return ok ? 'GREEN' : 'NEW FINDING';
    });
    for (const r of rows) await emit(t, r, r.check);
});

// ===========================================================================
// F19: noInlineLargeKey -- the large-key addFrom hash lanes RERUN under `--no-turbo-inlining`, the
// DETERMINISTIC repro of the contention flake. Pre-fix (1.7.0), the hash helpers passed the key low
// word `lo` (a HeapNumber for keys with bit 31 set) and the running int32 hash state as ARGUMENTS to
// hkRound / slRound; with inlining off (and, flakily, under CPU contention when Turbofan's cumulative
// budget left one *Round call site un-inlined) every such large-key lane boxed -- HK 32 B/op,
// SHLL / SCM ~16 B/op. F19 made the round/final helpers argument-free (state + key word in an
// Int32Array scratch, no number crosses the call), so all lanes now read <= 0.5 B/op even with
// inlining forced off, fresh AND warmed. Teeth: against the pre-fix file these lanes read 16-32 B/op
// (verified: HK 32, SHLL 16, SCM ~16). Gate: steady B/op <= 0.5.
// ===========================================================================
test('noInlineLargeKey', async (t) => {
    const NOINLINE = ['--no-turbo-inlining'];
    const gate = (steady) => (steady <= 0.5 ? null :
        'steady ' + steady + ' B/op > 0.5 under --no-turbo-inlining (a boxed hash-path argument -- F19 regressed)');
    const rows = [];
    // HeavyKeeper: the four large / negative key classes, fresh + warmed (pre-fix: 32 B/op).
    for (const [lane, lbl] of [['hk_af_p31_w1', 'HK addFrom key 2^31'], ['hk_af_p32m1_w1', 'HK addFrom key 2^32-1'],
        ['hk_af_neg31_w1', 'HK addFrom key -2^31'], ['hk_af_p53m1_w1', 'HK addFrom key 2^53-1']]) {
        rows.push({ lane, flags: NOINLINE, mode: 'fresh', label: lbl + ' [no-inline]', expected: '<=0.5' });
        rows.push({ lane, flags: NOINLINE, mode: 'warmed', label: lbl + ' [no-inline warm]', expected: '<=0.5' });
    }
    // SlidingHyperLogLog: epoch + perf.now clocks x key 2^31 / 2^53-1, fresh + warmed (pre-fix: 16 B/op).
    for (const [lane, lbl] of [['shll_af_now_p31', 'SHLL addFrom now key 2^31'], ['shll_af_now_p53m1', 'SHLL addFrom now key 2^53-1'],
        ['shll_af_epoch_p31', 'SHLL addFrom epoch key 2^31'], ['shll_af_epoch_p53m1', 'SHLL addFrom epoch key 2^53-1']]) {
        rows.push({ lane, flags: NOINLINE, mode: 'fresh', label: lbl + ' [no-inline]', expected: '<=0.5' });
        rows.push({ lane, flags: NOINLINE, mode: 'warmed', label: lbl + ' [no-inline warm]', expected: '<=0.5' });
    }
    // SlidingCountMin: key 2^31 / 2^32-1, fresh + warmed (pre-fix: ~16 B/op).
    for (const [lane, lbl] of [['scm_af_epoch_p31_c1', 'SCM addFrom key 2^31'], ['scm_af_epoch_p32m1_c1', 'SCM addFrom key 2^32-1']]) {
        rows.push({ lane, flags: NOINLINE, mode: 'fresh', label: lbl + ' [no-inline]', expected: '<=0.5' });
        rows.push({ lane, flags: NOINLINE, mode: 'warmed', label: lbl + ' [no-inline warm]', expected: '<=0.5' });
    }
    await measureGroup(rows);
    // FAIL CLOSED (F19 blocker 4): prove --no-turbo-inlining actually reached EVERY flagged child.
    // Without it the lane would silently measure the INLINED (0 B/op) path -- the deterministic box
    // repro would never fire and the gate would pass blind. The child echoes its process.execArgv.
    for (const r of rows) {
        assert.ok(Array.isArray(r._execArgv) && r._execArgv.includes('--no-turbo-inlining'),
            'child for "' + r.label + '" did NOT receive --no-turbo-inlining (execArgv=' +
            JSON.stringify(r._execArgv) + '); the no-inline repro never ran, gate is blind');
    }
    printTable('F19 noInlineLargeKey (--no-turbo-inlining; steady B/op <= 0.5; pre-fix boxed 16-32):', rows,
        (r) => (r._steady <= 0.5 ? 'GREEN' : 'NEW FINDING'));
    for (const r of rows) await emit(t, r, gate);
});

// ===========================================================================
// 1.9.0 SlidingAggregate (ADR 0012): the addFrom matrix (clock x value), the event-heavy rotate-every-add
// epoch lanes, advance / advanceFrom / clear, all steady B/op <= 0.5.
// ===========================================================================
test('saAllocMatrix', async (t) => {
    const gate = (steady) => (steady <= 0.5 ? null : 'steady ' + steady + ' B/op > 0.5 (a box on a zero-box SA path)');
    const rows = [
        // addFrom: clock {now, epoch} x value {small int, fraction, -1e149, 1e150}, fresh.
        { lane: 'sa_af_now_small', mode: 'fresh', label: 'SA addFrom now small-int', expected: '<=0.5' },
        { lane: 'sa_af_now_frac', mode: 'fresh', label: 'SA addFrom now fraction', expected: '<=0.5' },
        { lane: 'sa_af_now_neg149', mode: 'fresh', label: 'SA addFrom now -1e149', expected: '<=0.5' },
        { lane: 'sa_af_now_max150', mode: 'fresh', label: 'SA addFrom now 1e150 (cap)', expected: '<=0.5' },
        { lane: 'sa_af_epoch_small', mode: 'fresh', label: 'SA addFrom epoch small-int', expected: '<=0.5' },
        { lane: 'sa_af_epoch_frac', mode: 'fresh', label: 'SA addFrom epoch fraction', expected: '<=0.5' },
        { lane: 'sa_af_epoch_neg149', mode: 'fresh', label: 'SA addFrom epoch -1e149', expected: '<=0.5' },
        { lane: 'sa_af_epoch_max150', mode: 'fresh', label: 'SA addFrom epoch 1e150 (cap)', expected: '<=0.5' },
        // warmed (polymorphic call sites): a representative sample of clock x value.
        { lane: 'sa_af_epoch_frac', mode: 'warmed', label: 'SA addFrom epoch fraction (warm)', expected: '<=0.5' },
        { lane: 'sa_af_epoch_max150', mode: 'warmed', label: 'SA addFrom epoch 1e150 (warm)', expected: '<=0.5' },
        { lane: 'sa_af_now_frac', mode: 'warmed', label: 'SA addFrom now fraction (warm)', expected: '<=0.5' },
        // EVENT-HEAVY rotate-every-add epoch lanes (pw=1): the zero-box-per-rotation floor.
        { lane: 'sa_af_epoch_rot', mode: 'fresh', label: 'SA addFrom epoch ROTATE-every-add', expected: '<=0.5' },
        { lane: 'sa_af_epoch_rot', mode: 'warmed', label: 'SA addFrom epoch ROTATE (warm)', expected: '<=0.5' },
        { lane: 'sa_adv_epoch_rot', mode: 'fresh', label: 'SA advanceFrom epoch ROTATE-every-op', expected: '<=0.5' },
        { lane: 'sa_adv_epoch_rot', mode: 'warmed', label: 'SA advanceFrom epoch ROTATE (warm)', expected: '<=0.5' },
        // advance / advanceFrom / clear: 0.
        { lane: 'sa_advance', mode: 'fresh', label: 'SA advance(now)', expected: '<=0.5' },
        { lane: 'sa_advanceFrom', mode: 'fresh', label: 'SA advanceFrom(buf,i)', expected: '<=0.5' },
        { lane: 'sa_clear', mode: 'fresh', label: 'SA clear()', expected: '<=0.5' },
    ];
    await measureGroup(rows);
    printTable('SA allocMatrix (addFrom clock x value + event-heavy rotate + advance/clear; steady <= 0.5):',
        rows, (r) => (r._steady <= 0.5 ? 'GREEN' : 'NEW FINDING'));
    for (const r of rows) await emit(t, r, gate);
});

// ===========================================================================
// SA readers: scalar count/sum/mean/min/max at a monomorphic site (band [0, 16.5]); into at a
// monomorphic + polymorphic-4 site (<= 0.5); into at a MEGAMORPHIC-5 site (INFORMATIONAL, band [12, 20]
// -- documents the this._now megamorphic-field box, RE-SETTLED / logged for 1.10.0).
// ===========================================================================
test('saReaders', async (t) => {
    const gate = (steady) => (steady <= 0.5 ? null : 'steady ' + steady + ' B/op > 0.5 (a box on the 0-alloc reader path)');
    const scalarBand = (steady) => (steady >= 0 && steady <= 16.5 ? null :
        'steady ' + steady + ' B/op outside [0, 16.5] (docs: up to 16 B/call; use into())');
    const megaBand = (steady) => (steady >= 12 && steady <= 20 ? null :
        'steady ' + steady + ' B/op outside [12, 20] (< 12: the probe went blind to the megamorphic this._now box; > 20: a second box regressed)');
    const rows = [
        { lane: 'q_sa_count', mode: 'fresh', label: 'SA count() [mono]', expected: '[0,16.5]', check: scalarBand },
        { lane: 'q_sa_sum', mode: 'fresh', label: 'SA sum() [mono]', expected: '[0,16.5]', check: scalarBand },
        { lane: 'q_sa_mean', mode: 'fresh', label: 'SA mean() [mono]', expected: '[0,16.5]', check: scalarBand },
        { lane: 'q_sa_min', mode: 'fresh', label: 'SA min() [mono]', expected: '[0,16.5]', check: scalarBand },
        { lane: 'q_sa_max', mode: 'fresh', label: 'SA max() [mono]', expected: '[0,16.5]', check: scalarBand },
        { lane: 'sa_into_mono', mode: 'fresh', label: 'SA into() [monomorphic]', expected: '<=0.5', check: gate },
        { lane: 'sa_into_poly4', mode: 'fresh', label: 'SA into() [polymorphic 4]', expected: '<=0.5', check: gate },
        { lane: 'sa_into_mega5', mode: 'fresh', label: 'SA into() [megamorphic 5, INFO]', expected: '[12,20]', check: megaBand },
    ];
    await measureGroup(rows);
    printTable('SA readers (scalar [0,16.5]; into mono/poly4 <=0.5; into mega5 [12,20] documents the box):',
        rows, (r) => (r.check(r._steady, r._first) === null ? 'GREEN' : 'NEW FINDING'));
    for (const r of rows) await emit(t, r, r.check);
});

// ===========================================================================
// SA must-box controls (>= 12): mean() over 5 subclass maps (megamorphic return + this._now box), and a
// fractional now + value through the megamorphic callAdd site on the rotate-every-add shape. Both prove
// the probe SEES the box -- the teeth for the SA 0-alloc lanes above.
// ===========================================================================
test('saMustBox', async (t) => {
    const teeth = (steady) => (steady >= 12 ? null :
        'steady ' + steady + ' B/op < 12 (the must-box control did NOT box -- the SA alloc lanes have no teeth)');
    const rows = [
        { lane: 'q_sa_mean_mega', mode: 'fresh', label: 'SA mean() megamorphic (5 maps) [must-box]', expected: '>=12', check: teeth },
        { lane: 'sa_add_mega_rot', mode: 'fresh', label: 'SA add() megamorphic rotate [must-box]', expected: '>=12', check: teeth },
    ];
    await measureGroup(rows);
    printTable('SA must-box controls (>= 12 B/op -- the megamorphic boxing teeth):', rows,
        (r) => (r._steady >= 12 ? 'GREEN (teeth)' : 'NO TEETH'));
    for (const r of rows) await emit(t, r, r.check);
});

// ===========================================================================
// isView guard A/B (informational, NOT gated): the new container check is
// `ArrayBuffer.isView(buf) && buf instanceof Float64Array`. Measure the throughput cost of the extra
// ArrayBuffer.isView call vs a byte-identical replica whose only difference is `buf instanceof
// Float64Array` alone. In-process A/B (like HashThroughput): print the ratio only.
// ===========================================================================

// A faithful in-file replica of the SlidingAggregate hot fold + pane ring, with TWO addFrom variants that
// differ ONLY by the isView guard -- so the timing ratio isolates exactly that check's cost.
class ReplicaSA {
    constructor(W, panes) {
        this._W = W; this._panes = panes; this._ring = panes + 1; this._pw = W / panes;
        this._store = new Float64Array(this._ring * 5); this._paneEnd = new Float64Array(this._ring);
        for (let p = 0; p < this._ring; p++) { this._store[p * 5 + 3] = Infinity; this._store[p * 5 + 4] = -Infinity; }
        this._cur = 0; this._mode = 0; this._now = 0; this._last = 0;
    }
    _anchor() { const B = this._ring, pw = this._pw, now = this._now; const E = (Math.floor(now / pw) + 1) * pw; this._cur = 0; this._paneEnd[0] = E; let e = E, idx = 0; for (let s = 1; s < B; s++) { idx--; if (idx < 0) idx = B - 1; e -= pw; this._paneEnd[idx] = e; } }
    _clearPane(p) { const b = p * 5; this._store[b] = 0; this._store[b + 1] = 0; this._store[b + 2] = 0; this._store[b + 3] = Infinity; this._store[b + 4] = -Infinity; }
    _advance() { const pw = this._pw, B = this._ring, t = this._now; let cur = this._cur, E = this._paneEnd[cur], rot = 0; while (t >= E && rot < B) { cur++; if (cur === B) cur = 0; this._clearPane(cur); E += pw; this._paneEnd[cur] = E; rot++; } if (t >= E) { const nE = (Math.floor(t / pw) + 1) * pw; this._paneEnd[cur] = nE; let e = nE, idx = cur; for (let s = 1; s < B; s++) { idx--; if (idx < 0) idx = B - 1; e -= pw; this._paneEnd[idx] = e; } } this._cur = cur; }
    _fold(now, value) {
        let t;
        if (this._mode === 1) { t = now; this._last = now; } else { this._mode = 1; t = now; this._last = now; this._now = t; this._anchor(); }
        this._now = t; if (t >= this._paneEnd[this._cur]) this._advance();
        const b = this._cur * 5, store = this._store; store[b] += 1; const s = store[b + 1], c = store[b + 2]; const y = value - c, tt = s + y; store[b + 2] = (tt - s) - y; store[b + 1] = tt;
        if (value < store[b + 3]) store[b + 3] = value; if (value > store[b + 4]) store[b + 4] = value;
    }
    // GUARDED: the shipped check (ArrayBuffer.isView + instanceof).
    addFromGuard(buf, i) {
        if (!(ArrayBuffer.isView(buf) && buf instanceof Float64Array) || typeof i !== 'number' || !Number.isInteger(i) || i < 0 || !(i + 1 < buf.length)) return this;
        const now = buf[i], value = buf[i + 1]; if (!(value <= 1e150 && value >= -1e150)) return this; this._fold(now, value); return this;
    }
    // PLAIN: instanceof alone (the pre-hardening check) -- the only difference from addFromGuard.
    addFromPlain(buf, i) {
        if (!(buf instanceof Float64Array) || typeof i !== 'number' || !Number.isInteger(i) || i < 0 || !(i + 1 < buf.length)) return this;
        const now = buf[i], value = buf[i + 1]; if (!(value <= 1e150 && value >= -1e150)) return this; this._fold(now, value); return this;
    }
}

// Direct-call runners (NOT `sa[method]()` -- a computed-property dispatch would confound the ratio).
function runGuardAB(N, WARM, clk) {
    const sa = new ReplicaSA(1000, 32); const buf = new Float64Array(2); clk[0] = 1.75e12;
    for (let i = 0; i < WARM; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((i % 200) * 0.25) - 25; sa.addFromGuard(buf, 0); }
    const t0 = performance.now();
    for (let i = 0; i < N; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((i % 200) * 0.25) - 25; sa.addFromGuard(buf, 0); }
    return performance.now() - t0;
}
function runPlainAB(N, WARM, clk) {
    const sa = new ReplicaSA(1000, 32); const buf = new Float64Array(2); clk[0] = 1.75e12;
    for (let i = 0; i < WARM; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((i % 200) * 0.25) - 25; sa.addFromPlain(buf, 0); }
    const t0 = performance.now();
    for (let i = 0; i < N; i++) { clk[0] += 1.5; buf[0] = clk[0]; buf[1] = ((i % 200) * 0.25) - 25; sa.addFromPlain(buf, 0); }
    return performance.now() - t0;
}

test('saIsViewGuardAB', () => {
    const N = 4000000, WARM = 400000;
    const clk = new Float64Array(1);
    // interleave plain/guard reps to average out drift, take the min of each (least-noisy run).
    let guard = Infinity, plain = Infinity;
    for (let rep = 0; rep < 5; rep++) {
        plain = Math.min(plain, runPlainAB(N, WARM, clk));
        guard = Math.min(guard, runGuardAB(N, WARM, clk));
    }
    const ratio = guard / plain;
    console.log('');
    console.log('  isView guard A/B (ReplicaSA addFrom, ' + N + ' ops, min of 5 reps) -- INFORMATIONAL, not gated:');
    console.log('    plain (instanceof only) = ' + plain.toFixed(1) + ' ms;  guarded (isView + instanceof) = ' + guard.toFixed(1) +
        ' ms;  ratio = ' + ratio.toFixed(3) + (ratio > 1.10 ? '  <-- OVER 1.10 (reported to maintainer)' : '  (<= 1.10, negligible)'));
    // NOT gated (per T7): the ratio is printed only, never asserted.
});

// ===========================================================================
// 1.10.0 H2 hardening (batch 1, T1). SCM/SDD event-heavy pw=1 rotate-every-op lanes (H2-2): HEAD
// reads 0 B/op steady, so they gate LIVE at <= 0.5 (the argument-tagging box the roadmap flagged is
// NOT observable at steady state -- amortized below the probe floor; recorded REFUTED). The must-box
// scm_add_mega_rot proves the SCM event-heavy lanes have teeth (>= 12). mega5_<cls>_af are the H2-5
// megamorphic double-field-box lanes: INFORMATIONAL, gated in an [m-4, m+4] band around the measured
// HEAD value m (documents the box; a regression that removes or doubles it falls outside the band).
// ===========================================================================
test('h2EventHeavy', async (t) => {
    const gate = (steady) => (steady <= 0.5 ? null : 'steady ' + steady + ' B/op > 0.5 (a per-rotation box on the SCM/SDD event-heavy path)');
    const rows = [
        { lane: 'scm_af_epoch_rot', mode: 'fresh', label: 'SCM addFrom epoch ROTATE-every-add', expected: '<=0.5' },
        { lane: 'scm_af_epoch_rot', mode: 'warmed', label: 'SCM addFrom epoch ROTATE (warm)', expected: '<=0.5' },
        { lane: 'scm_adv_epoch_rot', mode: 'fresh', label: 'SCM advanceFrom epoch ROTATE-every-op', expected: '<=0.5' },
        { lane: 'scm_adv_epoch_rot', mode: 'warmed', label: 'SCM advanceFrom epoch ROTATE (warm)', expected: '<=0.5' },
        { lane: 'sdd_af_epoch_rot', mode: 'fresh', label: 'SDD addFrom epoch ROTATE-every-add', expected: '<=0.5' },
        { lane: 'sdd_af_epoch_rot', mode: 'warmed', label: 'SDD addFrom epoch ROTATE (warm)', expected: '<=0.5' },
        { lane: 'sdd_adv_epoch_rot', mode: 'fresh', label: 'SDD advanceFrom epoch ROTATE-every-op', expected: '<=0.5' },
        { lane: 'sdd_adv_epoch_rot', mode: 'warmed', label: 'SDD advanceFrom epoch ROTATE (warm)', expected: '<=0.5' },
    ];
    await measureGroup(rows);
    printTable('H2-2 SCM/SDD event-heavy rotate-every-op (steady <= 0.5; HEAD reads 0 -> LIVE, box REFUTED):',
        rows, (r) => (r._steady <= 0.5 ? 'GREEN' : 'NEW FINDING'));
    for (const r of rows) await emit(t, r, gate);
});

test('h2EventHeavyTeeth', async (t) => {
    const teeth = (steady) => (steady >= 12 ? null :
        'steady ' + steady + ' B/op < 12 (the must-box control did NOT box -- the SCM event-heavy lanes have no teeth)');
    const rows = [
        { lane: 'scm_add_mega_rot', mode: 'fresh', label: 'SCM add() megamorphic rotate [must-box]', expected: '>=12', check: teeth },
    ];
    await measureGroup(rows);
    printTable('H2-2 teeth: SCM add() megamorphic rotate (>= 12 B/op -- proves the event-heavy probe sees a box):',
        rows, (r) => (r._steady >= 12 ? 'GREEN (teeth)' : 'NO TEETH'));
    for (const r of rows) await emit(t, r, r.check);
});

test('h2Mega5', async (t) => {
    // INFO band [m-4, m+4] around the measured HEAD value m (H2-5 megamorphic double-field box).
    const band = (m) => (steady) => (steady >= m - 4 && steady <= m + 4 ? null :
        'steady ' + steady + ' B/op outside the INFO band [' + (m - 4) + ', ' + (m + 4) + '] (H2-5 megamorphic field box drifted from HEAD ' + m + ')');
    const rows = [
        { lane: 'mega5_eh_af', mode: 'fresh', label: 'EH addFrom mega5 [H2-5 INFO]', expected: '32+-4', check: band(32) },
        { lane: 'mega5_adwin_af', mode: 'fresh', label: 'ADWIN addFrom mega5 [H2-5 INFO]', expected: '147.3+-4', check: band(147.3) },
        { lane: 'mega5_fd_af', mode: 'fresh', label: 'FD addFrom mega5 [H2-5 INFO]', expected: '144+-4', check: band(144) },
        { lane: 'mega5_hk_af', mode: 'fresh', label: 'HK addFrom mega5 [H2-5 INFO]', expected: '16+-4', check: band(16) },
        { lane: 'mega5_shll_af', mode: 'fresh', label: 'SHLL addFrom mega5 [H2-5 INFO]', expected: '32+-4', check: band(32) },
        { lane: 'mega5_dd_af', mode: 'fresh', label: 'DD addFrom mega5 [H2-5 INFO]', expected: '226.5+-4', check: band(226.5) },
        // Re-cut for the batch 1-2 review fix (H2-5 INFO): the range check now loads this._nowMax ONCE
        // (`const nm = this._nowMax`) instead of reading the megamorphic double-field twice, so it drops
        // ONE of the two 16 B HeapNumber boxes at the 5-map site: SDD addFrom moves 86.5 -> ~70.5 B/op
        // (delta -16). INFO only, not a hot cost.
        { lane: 'mega5_sdd_af', mode: 'fresh', label: 'SDD addFrom mega5 [H2-5 INFO]', expected: '70.5+-4', check: band(70.5) },
        // Re-cut for the batch 1-2 review fix (H2-5 INFO): same single-load of this._nowMax drops one
        // megamorphic double-field box, so SCM addFrom moves 65 -> ~49 B/op (delta -16). INFO only.
        { lane: 'mega5_scm_af', mode: 'fresh', label: 'SCM addFrom mega5 [H2-5 INFO]', expected: '49+-4', check: band(49) },
        { lane: 'mega5_dr_af', mode: 'fresh', label: 'DR addFrom mega5 [H2-5 INFO]', expected: '80+-4', check: band(80) },
        { lane: 'mega5_sa_af', mode: 'fresh', label: 'SA addFrom mega5 [H2-5 INFO]', expected: '65+-4', check: band(65) },
    ];
    await measureGroup(rows);
    printTable('H2-5 mega5 addFrom (megamorphic double-field box; INFO band [m-4, m+4] around HEAD m):',
        rows, (r) => (r.check(r._steady, r._first) === null ? 'GREEN (in band)' : 'DRIFTED'));
    for (const r of rows) await emit(t, r, r.check);
});
