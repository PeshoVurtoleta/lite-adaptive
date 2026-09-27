// @zakkster/lite-adaptive -- F19 boundary-key stream (repo-only, shared by the QA generator and
// test/differential/F19Boundary.test.mjs). It imports NOTHING: the caller injects the module namespace
// (the shipped ../../Adaptive.js in the test; a read-only `git show 1.7.0:Adaptive.js` copy in the
// generator), so the golden vectors and the replay run the byte-identical stream.
//
// The key set sits exactly on the int32 / uint32 / safe-integer edges where F19 changed the hash-path
// representation: 2^31-1 (last positive Smi-able int32), 2^31 (bit 31 set -- a HeapNumber argument
// pre-F19), 2^32 (low word 0, high word 1), -(2^31)-1 (one past int32 min), +-(2^53-1) (safe-integer
// edges), plus 0 / -0 / +-1 / 2^30 / 2^32-1 / -(2^31) and a +-1 neighbourhood of each edge. Both the
// scalar add() and the unboxed addFrom() paths are driven (alternating), so both hash call sites are
// pinned against the pre-F19 outputs.

export const EDGES = [
    2 ** 31 - 1, 2 ** 31, 2 ** 32, -(2 ** 31) - 1, 2 ** 53 - 1, -(2 ** 53 - 1),
    0, -0, 1, -1, 2 ** 30, 2 ** 32 - 1, -(2 ** 31),
];

/** The full key table: every edge plus its +-1 and +-7 neighbours, clamped to the safe-integer domain. */
export function keyTable() {
    const out = [];
    const seen = new Set();
    for (const e of EDGES) {
        for (const off of [0, 1, -1, 7, -7]) {
            const k = e + off;
            if (!Number.isSafeInteger(k)) continue;
            const tag = Object.is(k, -0) ? '-0' : String(k);
            if (seen.has(tag)) continue;
            seen.add(tag);
            out.push(k);
        }
    }
    return out;
}

function mkRng(seed) {
    let s = seed | 0;
    return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
}

/**
 * Replay the boundary stream on `mod` (an Adaptive.js namespace). Returns a plain JSON-able object of
 * every public output. `withInto` also records SCM estimateInto (absent in 1.7.0) for the current file.
 */
export function replay(mod, withInto) {
    const { HeavyKeeper, SlidingHyperLogLog, SlidingCountMin } = mod;
    const KEYS = keyTable();
    const NK = KEYS.length;
    const rng = mkRng(0x5eed19);
    const res = { keys: KEYS.map((k) => (Object.is(k, -0) ? '-0' : k)), hk: {}, shll: {}, scm: {} };

    // ---- HeavyKeeper: 2 x 8, k = 16 (small w: collisions + decay dominate, so the hash has teeth), seed 11; weights up to 2^32-1 on a few items. ----
    {
        const hk = new HeavyKeeper(2, 8, 16, { seed: 11 });
        const buf = new Float64Array(2);
        const snaps = [];
        const topBuf = new Float64Array(32);
        for (let i = 0; i < 6000; i++) {
            const key = KEYS[rng() % NK];
            const r = rng();
            const wt = (i % 997 === 0) ? 4294967295 : 1 + (r % 50);
            if (i & 1) { buf[0] = key; buf[1] = wt; hk.addFrom(buf, 0); } else hk.add(key, wt);
            if (i % 500 === 499) {
                const n = hk.topKInto(topBuf);
                snaps.push(Array.from(topBuf.subarray(0, 2 * n)));
            }
        }
        res.hk.snaps = snaps;
        res.hk.est = KEYS.map((k) => hk.estimate(k));
        res.hk.size = hk.size;
    }

    // ---- SlidingHyperLogLog: p = 6, ringCap 64, seed 3; explicit time, sub-window counts. ----
    {
        const W = 1000;
        const sl = new SlidingHyperLogLog(W, { p: 6, ringCap: 64, seed: 3 });
        const buf = new Float64Array(2);
        const counts = [];
        // distinct keys: each edge key walked by j so the register set gets many boundary-adjacent keys.
        let now = 0;
        for (let i = 0; i < 8000; i++) {
            const base = KEYS[i % NK];
            const j = Math.floor(i / NK);
            let key = base >= 0 ? base - j : base + j;   // walk toward 0 (stays safe-integer)
            if (!Number.isSafeInteger(key)) key = base;
            now += 0.25;
            if (i & 1) { buf[0] = now; buf[1] = key; sl.addFrom(buf, 0); } else sl.add(now, key);
            if (i % 250 === 249) counts.push([sl.count(), sl.count(W / 2), sl.count(W / 8)]);
        }
        res.shll.counts = counts;
        res.shll.overflows = sl.overflows;
    }

    // ---- SlidingCountMin: d = 2, w = 16, panes 8 (narrow: collision overestimates differ key to key), seed 5; explicit time; sub-windows. ----
    {
        const W = 800;
        const scm = new SlidingCountMin(W, { d: 2, w: 16, panes: 8, seed: 5 });
        const buf = new Float64Array(3);
        const SUBW = [W, W / 2, W / 8, 100];
        const probes = [];
        const into = [];
        const kf = new Float64Array(KEYS);
        const out = new Float64Array(NK);
        let now = 0;
        for (let i = 0; i < 6000; i++) {
            const key = KEYS[rng() % NK];
            const c = 1 + (rng() % 9);
            now += 0.5;
            if (i & 1) { buf[0] = now; buf[1] = key; buf[2] = c; scm.addFrom(buf, 0); } else scm.add(now, key, c);
            if (i % 600 === 599) {
                const row = [];
                for (const w of SUBW) for (let q = 0; q < NK; q++) row.push(scm.estimate(KEYS[q], w));
                probes.push(row);
                if (withInto) {
                    const irow = [];
                    for (const w of SUBW) { scm.estimateInto(kf, out, w); for (let q = 0; q < NK; q++) irow.push(out[q]); }
                    into.push(irow);
                }
            }
        }
        res.scm.probes = probes;
        if (withInto) res.scm.into = into;
        res.scm.saturated = scm.saturated;
    }
    return res;
}
