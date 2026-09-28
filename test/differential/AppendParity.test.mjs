// @zakkster/lite-adaptive -- 1.10.0 CLASS-PARITY gate (repo-only; run:
//   node --test test/differential/AppendParity.test.mjs).
//
// 1.10.0 is an H2-hardening MINOR (ROADMAP 10.1). Unlike the 1.9.0 pure-append, it CHANGES ALL TEN
// class bodies BY DESIGN (container gates, value forms, the SCM/SDD numeric domain, the DD latched-PH
// accumulator fix, and -- H2-6 -- the trap-free reject-message stringifier that touches every class,
// SlidingAggregate included). There is NO byte-identical anchor left, so this gate has one arm plus a
// self-teeth control:
//
//   1. Each of the ten CHANGED-BY-DESIGN classes must be listed in CHANGED_BY_DESIGN_1_10 and MAPPED to
//      a parity test file that exists on disk and covers its behavior change (SA -> TrapFreeReject).
//      A byte assertion is deliberately NOT made on any of the ten (they change across batches 1-6);
//      instead the gate fails closed if a changed class has no declared behavioral cover, so a body
//      can never drift silently without a live parity gate watching its output.
//
// classes-1.9.0.sha256.json holds the sha256 + byte length of all ten 1.9.0 class bodies (the
// re-pin baseline). classes-1.8.0.sha256.json is KEPT as release history.
//
// A class body is `export class NAME {` through its column-0 closing `}` (inclusive), verbatim bytes.
//
// TEETH: an INDEPENDENT oracle, not a self-referential sha flip. For every CHANGED_BY_DESIGN class the
// live body sha MUST differ from its 1.9.0 golden sha (a class that did not actually change is a false
// entry here) AND the live byte length MUST stay within +-25% of golden.bytes (a collapsed extractor or
// a wrong body would blow this band). This catches a broken extractor without a golden to compare bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = readFileSync(fileURLToPath(new URL('../../Adaptive.js', import.meta.url)), 'utf8');
const GOLDEN = JSON.parse(readFileSync(
    fileURLToPath(new URL('./classes-1.9.0.sha256.json', import.meta.url)), 'utf8'));

// SlidingAggregate was the last byte-pinned anchor through batch 3. H2-6 (ROADMAP 10.1 section 1) makes
// the throw-message stringifier trap-free FAMILY-WIDE -- every `String(userArg)` in a reject message
// becomes `describeArg(userArg)` -- so it edits ALL TEN class bodies, SlidingAggregate included. There is
// therefore NO frozen anchor left in 1.10.0: every class is CHANGED_BY_DESIGN with a live cover.

// The classes 1.10.0 changes BY DESIGN: SCM + SDD (grid domain), the seven container-gate classes, and
// -- via H2-6 -- SlidingAggregate. Each is mapped to a differential parity test that owns an output
// contract it changes (ROADMAP 10.1 section 1). H2-6's trap-free-reject behavior for all ten is proven
// by test/TrapFreeReject.test.js. A changed body with no cover here fails closed.
const CHANGED_BY_DESIGN_1_10 = {
    SlidingDDSketch: 'GridParity.test.mjs',           // H2-1 numeric domain (grid) -- batches 1-2
    SlidingCountMin: 'GridParity.test.mjs',           // H2-1 numeric domain (grid) -- batches 1-2
    ExponentialHistogram: 'AddFromParity.test.mjs',   // H2-4 container gates -- batch 3
    ADWIN: 'AddFromParity.test.mjs',                  // H2-4 container gates -- batch 3
    ForwardDecay: 'AddFromParity.test.mjs',           // H2-4 container gates -- batch 3
    HeavyKeeper: 'AddFromParity.test.mjs',            // H2-4 container gates -- batch 3
    SlidingHyperLogLog: 'AddFromParity.test.mjs',     // H2-4 container gates -- batch 3
    DriftDetector: 'AddFromParity.test.mjs',          // H2-4 container gates -- batch 3
    DecayedReservoir: 'AddFromParity.test.mjs',       // H2-4 container gates -- batch 3
    SlidingAggregate: '../TrapFreeReject.test.js',    // H2-6 trap-free reject messages (the only edit to SA)
};

const ALL_CLASSES = Object.keys(CHANGED_BY_DESIGN_1_10);
// The band the independent oracle allows on live-vs-golden byte length (a collapsed extractor or a wrong
// body leaves this band; a real by-design edit stays well inside +-25%).
const BYTES_BAND = 0.25;

/** Extract the verbatim body of `export class NAME {` through its column-0 closing `}` (inclusive). */
function extractBody(src, name) {
    const lines = src.split('\n');
    const startRe = new RegExp('^export class ' + name + '\\b');
    let start = -1;
    for (let i = 0; i < lines.length; i++) { if (startRe.test(lines[i])) { start = i; break; } }
    assert.ok(start >= 0, 'class not found: ' + name);
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) { if (lines[i] === '}') { end = i; break; } }
    assert.ok(end >= 0, 'class close not found: ' + name);
    return lines.slice(start, end + 1).join('\n');
}

function sha(body) { return createHash('sha256').update(body, 'utf8').digest('hex'); }

test('ClassParity 1.10.0: every 1.10.0-changed class has a declared differential cover that exists', () => {
    for (const name of Object.keys(CHANGED_BY_DESIGN_1_10)) {
        assert.ok(GOLDEN[name], name + ' missing from the 1.9.0 golden baseline (regenerate classes-1.9.0.sha256.json)');
        // it must exist as a real class body in the source (fail closed if a class was renamed / dropped).
        const body = extractBody(SRC, name);
        assert.ok(body.length > 0, name + ' body is empty');
        const cover = CHANGED_BY_DESIGN_1_10[name];
        assert.ok(typeof cover === 'string' && cover.length > 0, name + ' has no declared differential cover');
        assert.ok(existsSync(HERE + cover),
            name + ' cover ' + cover + ' does not exist in test/differential/ -- a changed body has no live parity gate');
    }
});

test('ClassParity 1.10.0: the ten class bodies are all present and extractable', () => {
    for (const name of ALL_CLASSES) {
        const body = extractBody(SRC, name);
        assert.ok(body.startsWith('export class ' + name), name + ' body does not start with its export');
        assert.ok(body.endsWith('\n}'), name + ' body does not end at a column-0 close');
    }
    // exactly ten classes are accounted for -- a new class must be classified as changed-by-design.
    const exported = (SRC.match(/^export class /gm) || []).length;
    assert.equal(exported, ALL_CLASSES.length,
        'Adaptive.js exports ' + exported + ' classes but the gate classifies ' + ALL_CLASSES.length +
        ' -- classify any new class as changed-by-design');
});

test('ClassParity ORACLE: every changed class actually moved off its 1.9.0 golden, and its body stays within +-25% bytes', () => {
    // INDEPENDENT oracle (not a self-referential sha flip): for each CHANGED_BY_DESIGN class the live body
    // sha MUST differ from its 1.9.0 golden sha -- a class listed here that did not truly change is a false
    // claim. And the live byte length MUST stay within +-25% of golden.bytes -- a collapsed extractor
    // (body clipped to a constant) or a wrong body blows the band. Together this proves the extractor sees
    // a real, bounded change without needing a frozen golden to byte-compare against.
    for (const name of ALL_CLASSES) {
        const g = GOLDEN[name];
        assert.ok(g && typeof g.sha256 === 'string' && typeof g.bytes === 'number',
            name + ' missing sha256/bytes in the 1.9.0 golden baseline');
        const body = extractBody(SRC, name);
        const liveSha = sha(body);
        assert.notEqual(liveSha, g.sha256,
            name + ' live body sha equals its 1.9.0 golden -- it is listed as CHANGED_BY_DESIGN but did not change');
        const liveBytes = Buffer.byteLength(body, 'utf8');
        const lo = g.bytes * (1 - BYTES_BAND);
        const hi = g.bytes * (1 + BYTES_BAND);
        assert.ok(liveBytes >= lo && liveBytes <= hi,
            name + ' live body is ' + liveBytes + ' bytes, outside +-25% of golden ' + g.bytes +
            ' [' + Math.round(lo) + ', ' + Math.round(hi) + '] -- a collapsed extractor or a wrong body');
    }
});
