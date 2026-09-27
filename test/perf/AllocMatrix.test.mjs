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
import { runLane, LANES, assertSemiSpacePinned } from './AllocProbe.mjs';

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
//   - dd_latch_ph_fireheavy (finding B): latched-PH on a fire-heavy square wave. A latched fire can box
//     one ~16 B HeapNumber; the effect is TIER-DEPENDENT -- Maglev boxes (the probe's per-window gc()
//     can re-tier the hot loop), steady Turbofan holds the value in a slot. No bit-identical source
//     change removes it (25+ variants measured). Gated as a documented CEILING (<= 4 B/op, naming the
//     Maglev re-tier mechanism) that the CURRENT code passes deterministically (measured ~0.5 B/op
//     steady across 5 fresh runs) while a regression to a per-ADD box (>= 16 B/op) fails RED. latch:false
//     and CUSUM read 0 (the dd_af / dd_latch_af lanes above).
// ===========================================================================
test('docTruthFindings', async (t) => {
    const shllBand = (steady) => (steady >= 12 && steady <= 40 ? null :
        'steady ' + steady + ' B/op outside the documented band [12, 40] (< 12: the probe went blind to the count() box; > 40: a THIRD box regressed the estimator tail)');
    // Maglev re-tier ceiling: the current code reads ~0.5 B/op steady (Turbofan holds the value in a
    // Float64Array slot); the ceiling catches a regression to a per-add box (>= 16), not the tier flake.
    const fireCeil = (steady) => (steady <= 4 ? null :
        'steady ' + steady + ' B/op > 4 (a per-ADD latched-PH box regressed; the Maglev re-tier flake is <= ~2)');
    const rows = [
        { lane: 'q_shll_count', mode: 'fresh', label: 'SHLL count() non-degenerate [finding A]', expected: '[12,40]', check: shllBand },
        { lane: 'dd_latch_ph_fireheavy', mode: 'fresh', label: 'DD latch:true PH fire-heavy [finding B]', expected: '<=4', check: fireCeil },
        { lane: 'dd_latch_ph_fireheavy', mode: 'warmed', label: 'DD latch:true PH fire-heavy (warm)', expected: '<=4', check: fireCeil },
    ];
    await measureGroup(rows);
    printTable('1.8.0 docTruthFindings (SHLL count() band [12,40]; latched-PH fire ceiling <=4):', rows, (r) => {
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
