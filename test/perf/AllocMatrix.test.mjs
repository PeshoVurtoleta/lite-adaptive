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
//     the default-seed variants, now reads <= 0.5 with no `todo`. The remaining todo is F6.
//   - queryLanes (N4): the windowed READ paths. F5 landed: SDD quantileInto renders 0-alloc, scalar
//     quantile(0.99) boxes EXACTLY one ~16 B HeapNumber return (asserted 16 +-0.5, both ways). SCM
//     estimate of a count >= 2^31 boxes its return (F6, doc-only in 1.7.0 -> the reader lands in
//     1.8.0). EH sum / HK estimate box only in the FIRST window (steady 0, printed).
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

/** Measure every lane in a group through the child pool, keyed by lane+mode. */
async function measureGroup(rows) {
    const res = await runPool(rows, POOL, (r) => runLane(r.lane, r.mode || 'fresh'));
    for (let i = 0; i < rows.length; i++) { rows[i]._first = res[i].first; rows[i]._steady = res[i].steady; }
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
        // SlidingCountMin: clock x key x count. addFrom keeps keys/counts unboxed -> green (the box is
        // in estimate's return, F6 -- see queryLanes).
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
        { lane: 'q_scm_estimate_big', mode: 'fresh', label: 'SCM estimate (count>=2^31)', expected: '~16 (F6)', id: 'F6 (1.8.0 estimateInto)', check: gate },
        { lane: 'q_eh_sum', mode: 'fresh', label: 'EH sum() (first-window box)', expected: '<=0.5', check: gate },
        { lane: 'q_hk_estimate', mode: 'fresh', label: 'HK estimate() (small count)', expected: '<=0.5', check: gate },
        { lane: 'q_hk_foreach', mode: 'fresh', label: 'HK forEach(fn)', expected: '<=0.5', check: gate },
        { lane: 'q_dr_sampleInto', mode: 'fresh', label: 'DR sampleInto(buf)', expected: '<=0.5', check: gate },
    ];
    await measureGroup(rows);
    printTable('N4 queryLanes (steady B/op <= 0.5, except the exact quantile-16 box / F6 box):', rows, (r) => {
        const ok = r.check(r._steady, r._first) === null;
        if (r.id) return ok ? 'todo ' + r.id + ' (green here)' : 'todo ' + r.id;
        return ok ? 'GREEN' : 'NEW FINDING';
    });
    for (const r of rows) await emit(t, r, r.check);
});
