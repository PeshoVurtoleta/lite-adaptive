// @zakkster/lite-adaptive -- the static DEMO AUDIT over demo/index.html (DEMO.md sections 5-6; ROADMAP 11.1 D-S6).
//
// The GC torture harness is blind to forced synchronous reflow and to a DOM lookup in a handler (both cost
// zero bytes), so these rules read index.html AS TEXT and fail the build on a violation. Every rule has an
// INJECTED-VIOLATION control: the rule must report a violation on a mutated copy of the page, so the
// audit itself has teeth. ASCII-only per suite law.
//
//   node --test demo/DemoAudit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

// ---------------------------------------------------------------------------------------------
// parsing helpers (text-level; the page is hand-written, one top-level module script)
// ---------------------------------------------------------------------------------------------

function scriptOf(html) {
    const a = html.indexOf('<script type="module">');
    const b = html.indexOf('</script>', a);
    return html.slice(a, b);
}

function styleOf(html) {
    const a = html.indexOf('<style>');
    const b = html.indexOf('</style>', a);
    return html.slice(a, b);
}

function markupOf(html) {
    return html.slice(0, html.indexOf('<script type="module">'));
}

/** Every module-level `function name(...) {` (4-space indent) -> { name, body }. */
function topFunctions(src) {
    const out = [];
    const re = /\n {4}function (\w+)\s*\([^)]*\)\s*\{/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const open = src.indexOf('{', m.index + m[0].length - 1);
        let depth = 0, i = open;
        for (; i < src.length; i++) {
            const c = src[i];
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) break; }
        }
        out.push({ name: m[1], body: src.slice(open + 1, i) });
    }
    return out;
}

const isTick = (name) => /Tick$/.test(name);

/** The PER-FRAME set: every module function reachable from loop() through direct calls, NOT descending
 *  into the frame-masked *Tick functions (they run at ~10Hz, under their own rule). Review B9 MAJOR 6: a
 *  name-based set let per-frame helpers (drawHistLine, saY, rgbaq, ...) escape the rules. */
function perFrameSet(src) {
    const fns = topFunctions(src), byName = new Map(fns.map((f) => [f.name, f]));
    const seen = new Set(['loop']), stack = ['loop'];
    while (stack.length) {
        const f = byName.get(stack.pop());
        if (!f) continue;
        for (const m of f.body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
            const callee = m[1];
            if (byName.has(callee) && !seen.has(callee) && !isTick(callee)) { seen.add(callee); stack.push(callee); }
        }
    }
    return seen;
}

// Functions that run ONCE at init (they build the cached handles), so a lookup inside them is not a
// handler lookup. Each entry is justified: `$` IS the lookup; wireToggle is called only at module init to
// bind a toggle and caches its two handles in its closure.
const INIT_ONLY = new Set(['$', 'wireToggle', 'initCanvasMaps']);
const LOOKUP = /\$\(|getElementById|querySelector/;
const CACHED_BUILD = new Set(['rgbaq']);

// ---------------------------------------------------------------------------------------------
// the rules: each returns a list of violation strings (empty = pass)
// ---------------------------------------------------------------------------------------------

const RULES = {
    'unique ids': (html) => {
        const seen = new Map(), out = [];
        for (const m of markupOf(html).matchAll(/\sid="([^"]+)"/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
        for (const [id, n] of seen) if (n > 1) out.push('id "' + id + '" appears ' + n + ' times');
        return out;
    },
    'every $(id) exists': (html) => {
        const ids = new Set([...markupOf(html).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
        const out = [];
        for (const m of scriptOf(html).matchAll(/\$\('([^']+)'\)/g)) if (!ids.has(m[1])) out.push('$(\'' + m[1] + '\') has no element');
        for (const m of scriptOf(html).matchAll(/wireToggle\('([^']+)', '([^']+)'/g)) {
            for (const id of [m[1], m[2]]) if (!ids.has(id)) out.push('wireToggle id \'' + id + '\' has no element');
        }
        return out;
    },
    'no DOM lookup inside a function body': (html) => {
        const out = [];
        for (const f of topFunctions(scriptOf(html))) {
            if (INIT_ONLY.has(f.name)) continue;
            if (LOOKUP.test(f.body)) out.push(f.name + '() looks up the DOM (cache it at init)');
        }
        // arrow handlers registered at module level: `addEventListener('x', (e) => { ... $('...') ... })`
        // (MODULE-level only: the line starts at the 4-space module indent, so a nested handler inside an
        // init helper such as wireToggle is not mistaken for one)
        for (const m of scriptOf(html).matchAll(/\n {4}[$\w.()'-]*addEventListener\('[a-z]+', \([^)]*\) => \{([\s\S]*?)\n {4}\}\);/g)) {
            if (LOOKUP.test(m[1])) out.push('an event handler looks up the DOM: ' + m[1].trim().slice(0, 60));
        }
        // `addEventListener('x', function (e) { ... })` handlers (QA-6)
        for (const m of scriptOf(html).matchAll(/\n {4}[$\w.()'-]*addEventListener\('[a-z]+', function\s*\w*\s*\([^)]*\)\s*\{([\s\S]*?)\n {4}\}\);/g)) {
            if (LOOKUP.test(m[1])) out.push('an event handler looks up the DOM: ' + m[1].trim().slice(0, 60));
        }
        // module-level `const name = (...) => { ... }` arrows -- a handler stored in a const and passed by
        // name (QA-5). `$` itself is a one-line expression arrow, so it never matches the braced form.
        for (const m of scriptOf(html).matchAll(/\n {4}(?:const|let) (\w+) = (?:async )?\([^)]*\) => \{([\s\S]*?)\n {4}\};/g)) {
            if (!INIT_ONLY.has(m[1]) && LOOKUP.test(m[2])) out.push(m[1] + ' (a module-level arrow) looks up the DOM');
        }
        // wireToggle(..., (on) => { ... }) callbacks run on every click / key (review B9 BLOCKER 3)
        for (const m of scriptOf(html).matchAll(/\n {4}wireToggle\([^\n]*\(on\) => \{([\s\S]*?)\n {4}\}\);/g)) {
            if (LOOKUP.test(m[1])) out.push('a wireToggle callback looks up the DOM: ' + m[1].trim().slice(0, 60));
        }
        return out;
    },
    'no closure / function literal in a per-frame body': (html) => {
        const out = [];
        const pf = perFrameSet(scriptOf(html));
        for (const f of topFunctions(scriptOf(html))) {
            if (pf.has(f.name) && /=>|function\s*\(/.test(f.body)) out.push(f.name + '() builds a closure per frame');
        }
        return out;
    },
    'no format / template / string build in a per-frame body': (html) => {
        const out = [];
        const pf = perFrameSet(scriptOf(html));
        for (const f of topFunctions(scriptOf(html))) {
            if (!pf.has(f.name)) continue;
            if (/toFixed|toLocaleString|toExponential|`/.test(f.body)) out.push(f.name + '() formats or templates a string per frame');
            // string concatenation (QA-7). CACHED_BUILD: rgbaq concatenates only on a cache MISS (21 alpha
            // steps per colour, built during warm-up), never on the steady-state frame.
            if (!CACHED_BUILD.has(f.name) && /'\s*\+\s*[\w(]|[\w)\]]\s*\+\s*'/.test(f.body)) out.push(f.name + '() concatenates a string per frame');
            if (/\.textContent\s*=|\.className\s*=|setText\(|put(Fixed|Int|Num|Exp|Smi)\(/.test(f.body)) out.push(f.name + '() writes DOM text per frame (that belongs in the ~10Hz *Tick)');
        }
        return out;
    },
    'no layout read after a layout write in one body': (html) => {
        const WRITE = /\.(width|height)\s*=(?!=)|\.textContent\s*=|\.className\s*=|\.innerHTML\s*=|\.innerText\s*=|\.style\.|setAttribute\(|removeAttribute\(|classList\.|appendChild\(|insertBefore\(|removeChild\(|\.hidden\s*=/;
        const READ = /measureScene\(|getBoundingClientRect\(|\.offset(Width|Height|Top|Left)\b|\.client(Width|Height|Top|Left)\b|\.scroll(Width|Height|Top|Left)\b|getComputedStyle\(|\binnerWidth\b|\binnerHeight\b/;
        const out = [];
        for (const f of topFunctions(scriptOf(html))) {
            const w = f.body.search(WRITE);
            if (w === -1) continue;
            if (READ.test(f.body.slice(w))) out.push(f.name + '() reads layout after a layout write (forced reflow)');
        }
        return out;
    },
    'layout reads only in measureScene (D-S5: read every rect first, then write)': (html) => {
        const out = [];
        for (const f of topFunctions(scriptOf(html))) {
            if (f.name !== 'measureScene' && /getBoundingClientRect\(|getComputedStyle\(|\.offset(Width|Height)\b|\.client(Width|Height)\b/.test(f.body)) out.push(f.name + '() reads layout outside measureScene');
        }
        return out;
    },
    'ticks write only through put* / setText / setClass': (html) => {
        const out = [];
        for (const f of topFunctions(scriptOf(html))) {
            if (!isTick(f.name)) continue;
            if (/\.textContent\s*=|\.className\s*=/.test(f.body)) out.push(f.name + '() writes raw textContent / className (use put* / setText / setClass)');
            // toFixed is allowed only inside a setText(...) composite argument
            for (const line of f.body.split('\n')) {
                if (/toFixed|toExponential/.test(line) && !/setText\(/.test(line)) out.push(f.name + '(): a format outside a setText composite: ' + line.trim().slice(0, 70));
            }
        }
        return out;
    },
    'pointer events only (no mouse* / touch* listeners)': (html) => {
        const out = [];
        for (const m of scriptOf(html).matchAll(/addEventListener\('((?:mouse|touch)[a-z]+)'/g)) out.push('listens to ' + m[1]);
        return out;
    },
    ':hover only inside @media (hover: hover)': (html) => {
        const css = styleOf(html), out = [];
        // strip every @media (hover: hover) { ... } block (balanced), then any :hover left is bare
        let rest = '', i = 0;
        while (i < css.length) {
            const j = css.indexOf('@media (hover: hover)', i);
            if (j === -1) { rest += css.slice(i); break; }
            rest += css.slice(i, j);
            let k = css.indexOf('{', j), depth = 0;
            for (; k < css.length; k++) { if (css[k] === '{') depth++; else if (css[k] === '}') { depth--; if (depth === 0) break; } }
            i = k + 1;
        }
        for (const m of rest.matchAll(/[^\n{}]*:hover[^\n{]*/g)) out.push('bare :hover rule: ' + m[0].trim());
        return out;
    },
    'hex before oklch on the same property': (html) => {
        const out = [];
        const lines = styleOf(html).split('\n');
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^\s*([a-z-]+)\s*:\s*oklch\(/);
            if (!m) continue;
            let ok = false;
            for (let j = i - 1; j >= 0 && j >= i - 3; j--) if (new RegExp('^\\s*' + m[1] + '\\s*:\\s*#[0-9a-fA-F]{3,8}').test(lines[j])) ok = true;
            if (!ok) out.push('line ' + (i + 1) + ': ' + m[1] + ' uses oklch() without a hex fallback right before it');
        }
        return out;
    },
    'no inline style except custom properties': (html) => {
        const out = [];
        for (const m of markupOf(html).matchAll(/\sstyle="([^"]*)"/g)) {
            const decls = m[1].split(';').map((d) => d.trim()).filter(Boolean);
            for (const d of decls) if (!d.startsWith('--')) out.push('inline style "' + d + '"');
        }
        return out;
    },
};

// ---------------------------------------------------------------------------------------------
// injected-violation controls: one mutation per rule, applied to a COPY of the page
// ---------------------------------------------------------------------------------------------

function injectScript(html, code) {
    const at = html.indexOf('    // ---- main loop');
    assert.ok(at !== -1, 'control: the main-loop anchor moved');
    return html.slice(0, at) + code + '\n' + html.slice(at);
}

const CONTROLS = {
    'unique ids': (h) => h.replace('id="sa-mean-big"', 'id="dr-hl-r"'),
    'every $(id) exists': (h) => injectScript(h, "    const $ghost = $('no-such-element');"),
    'no DOM lookup inside a function body': (h) => injectScript(h, "    function auditBadTick() { $('sa-w-v').textContent = '1'; }"),
    // per-frame = reachable from loop(): mutate a REAL per-frame function (saDraw), not an uncalled one
    'no closure / function literal in a per-frame body': (h) => h.replace('    function saDraw() {\n', '    function saDraw() {\n        const auditY = (v) => v * 2;\n'),
    'no format / template / string build in a per-frame body': (h) => h.replace('    function saDraw() {\n', '    function saDraw() {\n        const auditS = saVMax.toFixed(2);\n'),
    'no layout read after a layout write in one body': (h) => injectScript(h, "    function auditLayout(el) { el.textContent = 'x'; return el.offsetWidth; }"),
    'ticks write only through put* / setText / setClass': (h) => injectScript(h, '    function auditTick(el, v) { el.textContent = v.toFixed(1); }'),
    // the D-S5 revert (review B9 Mutant B): sizeCanvas measuring its own canvas again
    'layout reads only in measureScene (D-S5: read every rect first, then write)': (h) => h.replace('const wh = CANVAS_RECT.get(c), w = wh[0], h = wh[1];', 'const r = c.getBoundingClientRect(), w = r.width, h = r.height;'),
    'pointer events only (no mouse* / touch* listeners)': (h) => injectScript(h, "    saCanvas.addEventListener('mousemove', onAuditMove);"),
    ':hover only inside @media (hover: hover)': (h) => h.replace('</style>', '        .audit:hover { color: #fff; }\n    </style>'),
    'hex before oklch on the same property': (h) => h.replace('</style>', '        .audit {\n            color: oklch(70% 0.1 250);\n        }\n    </style>'),
    'no inline style except custom properties': (h) => h.replace('id="sa-mean-big"', 'id="sa-mean-big" style="color: red"'),
};

for (const name of Object.keys(RULES)) {
    test('DEMO AUDIT: ' + name + ' -- GREEN on index.html, RED on its injected-violation control', () => {
        assert.deepEqual(RULES[name](HTML), [], name + ' must hold on demo/index.html');
        const bad = CONTROLS[name](HTML);
        assert.notEqual(bad, HTML, 'control for "' + name + '": the mutation must apply');
        assert.ok(RULES[name](bad).length > 0, 'control for "' + name + '": the injected violation must be caught');
    });
}

test('DEMO AUDIT: a DOM lookup inside a MODULE-level event handler is caught too (second control for the lookup rule)', () => {
    const bad = injectScript(HTML, "    $('sa-w').addEventListener('input', (e) => {\n        $('sa-w-v').textContent = '1';\n    });");
    const v = RULES['no DOM lookup inside a function body'](bad);
    assert.ok(v.some((x) => x.startsWith('an event handler looks up the DOM')), 'the handler lookup must be reported, got ' + JSON.stringify(v));
});

test('DEMO AUDIT: a DOM lookup inside a wireToggle callback is caught (review B9 Mutant A) and a canvas size write counts as a layout write', () => {
    const bad = injectScript(HTML, "    wireToggle('sa-spike-toggle', 'sa-spike-label', 'on', 'off', (on) => {\n        $('sa-w-v').textContent = 'x';\n    });");
    assert.ok(RULES['no DOM lookup inside a function body'](bad).some((x) => x.startsWith('a wireToggle callback')), 'wireToggle callback lookup must be caught');
    const bad2 = injectScript(HTML, '    function auditSize(c) { c.width = 10; return c.clientWidth; }');
    assert.ok(RULES['no layout read after a layout write in one body'](bad2).length > 0, 'a canvas .width write then a read must be caught');
    const pf = perFrameSet(scriptOf(HTML));
    for (const name of ['saY', 'fdMapV', 'rgbaq', 'drawSeries', 'saSeries']) assert.ok(pf.has(name), name + ' must be in the per-frame call graph');
    assert.ok(!pf.has('saTick') && !pf.has('putFixed'), 'the *Tick functions and their helpers are NOT per-frame');
});

test('DEMO AUDIT: every rule has a control (no rule without teeth)', () => {
    assert.deepEqual(Object.keys(CONTROLS).sort(), Object.keys(RULES).sort());
});
