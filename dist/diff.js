import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// The trace stores a full Int32 frontier for each edit-distance step. These
// guards cap both its width and depth before Myers can allocate quadratic state.
const MAX_DIFF_INPUT_CODE_UNITS = 2000000;
const MAX_DIFF_INPUT_LINES = 100000;
const MAX_MYERS_TRACE_CELLS = 8000000;
const snapshotDiffCurrentLineIndexes = new WeakMap();

function rememberSnapshotDiffProjection(result, currentLineIndexes) {
    snapshotDiffCurrentLineIndexes.set(result, currentLineIndexes);
    return result;
}

/**
 * Return the current-snapshot line represented by each rendered diff line.
 * Deleted lines and synthetic headers are null. This metadata never enters the
 * wire response; actions use it to keep only structurally visible current refs.
 */
export function getSnapshotDiffCurrentLineIndexes(result) {
    return snapshotDiffCurrentLineIndexes.get(result) ?? null;
}

function countLines(text) {
    let lines = 1;
    let offset = -1;
    while ((offset = text.indexOf('\n', offset + 1)) !== -1) {
        lines++;
    }
    return lines;
}

function boundRenderedDiff(diff, currentLineIndexes, maxLines, unbounded = false) {
    const lines = diff ? diff.split('\n') : [];
    if (unbounded && maxLines === undefined) {
        return { diff, currentLineIndexes, outputLines: lines.length, truncated: false, omittedLines: 0 };
    }
    const limit = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : 500;
    if (lines.length <= limit) {
        return { diff, currentLineIndexes, outputLines: lines.length, truncated: false, omittedLines: 0 };
    }
    if (limit === 1) {
        return {
            diff: `  ... ${lines.length} diff lines omitted ...`,
            currentLineIndexes: [null],
            outputLines: 1,
            truncated: true,
            omittedLines: lines.length,
        };
    }
    const retained = limit - 1;
    const headCount = Math.ceil(retained / 2);
    const tailCount = retained - headCount;
    const omittedLines = lines.length - retained;
    return {
        diff: [
            ...lines.slice(0, headCount),
            `  ... ${omittedLines} diff lines omitted ...`,
            ...(tailCount > 0 ? lines.slice(-tailCount) : []),
        ].join('\n'),
        currentLineIndexes: [
            ...currentLineIndexes.slice(0, headCount),
            null,
            ...(tailCount > 0 ? currentLineIndexes.slice(-tailCount) : []),
        ],
        outputLines: limit,
        truncated: true,
        omittedLines,
    };
}

function computationLimitedDiff(details) {
    const additions = Math.max(0, details.afterLines - details.commonPrefix - details.commonSuffix);
    const removals = Math.max(0, details.beforeLines - details.commonPrefix - details.commonSuffix);
    const unchanged = details.commonPrefix + details.commonSuffix;
    const changed = details.before !== details.after;
    const reason = details.reason === 'input_code_units'
        ? `combined input exceeded ${MAX_DIFF_INPUT_CODE_UNITS} UTF-16 code units`
        : details.reason === 'input_lines'
            ? `combined input exceeded ${MAX_DIFF_INPUT_LINES} lines`
            : `estimated Myers trace exceeded ${MAX_MYERS_TRACE_CELLS} Int32 cells`;
    const result = {
        diff: changed
            ? `@@ computation-limited replacement @@\n! [exact Myers diff skipped: ${reason}; changed middle treated as one replacement]`
            : '',
        additions: changed ? additions : 0,
        removals: changed ? removals : 0,
        unchanged: changed ? unchanged : details.beforeLines,
        changed,
        compacted: true,
        omittedUnchanged: changed ? unchanged : details.beforeLines,
        omittedChanged: changed ? additions + removals : 0,
        computationLimited: true,
        diffAlgorithm: 'bounded-replacement',
        computationLimit: {
            reason: details.reason,
            inputCodeUnits: details.before.length + details.after.length,
            beforeLines: details.beforeLines,
            afterLines: details.afterLines,
            commonPrefix: details.commonPrefix,
            commonSuffix: details.commonSuffix,
            ...(details.estimatedTraceCells === undefined
                ? {}
                : { estimatedTraceCells: details.estimatedTraceCells }),
            maxInputCodeUnits: MAX_DIFF_INPUT_CODE_UNITS,
            maxInputLines: MAX_DIFF_INPUT_LINES,
            maxTraceCells: MAX_MYERS_TRACE_CELLS,
            stats: 'replacement edit counts; not a minimal edit script',
        },
    };
    return rememberSnapshotDiffProjection(result, result.diff ? result.diff.split('\n').map(() => null) : []);
}
/**
 * Myers diff algorithm operating on arrays of lines.
 * Returns a minimal edit script.
 */
function myersDiff(a, b) {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    if (max === 0)
        return [];
    // Optimize: if both are identical, skip diff
    if (n === m) {
        let identical = true;
        for (let i = 0; i < n; i++) {
            if (a[i] !== b[i]) {
                identical = false;
                break;
            }
        }
        if (identical)
            return a.map((line) => ({ type: 'equal', line }));
    }
    const vSize = 2 * max + 1;
    const v = new Int32Array(vSize);
    v.fill(-1);
    const trace = [];
    v[max + 1] = 0;
    for (let d = 0; d <= max; d++) {
        const snapshot = new Int32Array(v);
        trace.push(snapshot);
        for (let k = -d; k <= d; k += 2) {
            const idx = k + max;
            let x;
            if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
                x = v[idx + 1];
            }
            else {
                x = v[idx - 1] + 1;
            }
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[idx] = x;
            if (x >= n && y >= m) {
                return buildEditScript(trace, a, b, max);
            }
        }
    }
    return buildEditScript(trace, a, b, max);
}
function buildEditScript(trace, a, b, max) {
    const edits = [];
    let x = a.length;
    let y = b.length;
    for (let d = trace.length - 1; d > 0; d--) {
        const v = trace[d];
        const k = x - y;
        const idx = k + max;
        let prevK;
        if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
            prevK = k + 1;
        }
        else {
            prevK = k - 1;
        }
        const prevIdx = prevK + max;
        let prevX = v[prevIdx];
        let prevY = prevX - prevK;
        // Diagonal (equal lines)
        while (x > prevX && y > prevY) {
            x--;
            y--;
            edits.push({ type: 'equal', line: a[x] });
        }
        if (x === prevX) {
            y--;
            edits.push({ type: 'insert', line: b[y] });
        }
        else {
            x--;
            edits.push({ type: 'delete', line: a[x] });
        }
    }
    // Remaining diagonal at d=0
    while (x > 0 && y > 0) {
        x--;
        y--;
        edits.push({ type: 'equal', line: a[x] });
    }
    edits.reverse();
    return edits;
}
/**
 * Produce a unified diff string and stats from two snapshot texts.
 */
export function diffSnapshots(before, after, options = {}) {
    const beforeLines = countLines(before);
    const afterLines = countLines(after);
    const inputCodeUnits = before.length + after.length;
    if (inputCodeUnits > MAX_DIFF_INPUT_CODE_UNITS) {
        return computationLimitedDiff({
            before,
            after,
            beforeLines,
            afterLines,
            commonPrefix: 0,
            commonSuffix: 0,
            reason: 'input_code_units',
        });
    }
    if (beforeLines + afterLines > MAX_DIFF_INPUT_LINES) {
        return computationLimitedDiff({
            before,
            after,
            beforeLines,
            afterLines,
            commonPrefix: 0,
            commonSuffix: 0,
            reason: 'input_lines',
        });
    }
    const linesA = before.split('\n');
    const linesB = after.split('\n');
    let commonPrefix = 0;
    while (commonPrefix < linesA.length && commonPrefix < linesB.length && linesA[commonPrefix] === linesB[commonPrefix]) {
        commonPrefix++;
    }
    let commonSuffix = 0;
    while (commonSuffix < linesA.length - commonPrefix &&
        commonSuffix < linesB.length - commonPrefix &&
        linesA[linesA.length - commonSuffix - 1] === linesB[linesB.length - commonSuffix - 1]) {
        commonSuffix++;
    }
    const changedMiddleLines = (linesA.length - commonPrefix - commonSuffix) +
        (linesB.length - commonPrefix - commonSuffix);
    const totalLines = linesA.length + linesB.length;
    const estimatedTraceCells = changedMiddleLines === 0
        ? 0
        : (2 * totalLines + 1) * (changedMiddleLines + 1);
    if (estimatedTraceCells > MAX_MYERS_TRACE_CELLS) {
        return computationLimitedDiff({
            before,
            after,
            beforeLines,
            afterLines,
            commonPrefix,
            commonSuffix,
            estimatedTraceCells,
            reason: 'estimated_trace_cells',
        });
    }
    const edits = myersDiff(linesA, linesB);
    let currentLineIndex = 0;
    for (const edit of edits) {
        edit.currentLineIndex = edit.type === 'delete' ? null : currentLineIndex++;
    }
    let additions = 0;
    let removals = 0;
    let unchanged = 0;
    const diffLines = [];
    const fullCurrentLineIndexes = [];
    for (const edit of edits) {
        switch (edit.type) {
            case 'equal':
                unchanged++;
                diffLines.push(`  ${edit.line}`);
                fullCurrentLineIndexes.push(edit.currentLineIndex);
                break;
            case 'insert':
                additions++;
                diffLines.push(`+ ${edit.line}`);
                fullCurrentLineIndexes.push(edit.currentLineIndex);
                break;
            case 'delete':
                removals++;
                diffLines.push(`- ${edit.line}`);
                fullCurrentLineIndexes.push(null);
                break;
        }
    }
    const fullDiff = diffLines.join('\n');
    const compactCandidate = options.full === true
        ? null
        : compactDiff(edits, options.contextLines, options.compact === true);
    // Hunk headers can outweigh a few omitted short lines. Compact output is a
    // size contract, so retain the legacy full form unless the projection is
    // materially smaller in serialized text bytes.
    const compacted = compactCandidate &&
        (options.compact === true ||
            Buffer.byteLength(compactCandidate.diff, 'utf8') < Buffer.byteLength(fullDiff, 'utf8'))
        ? compactCandidate
        : null;
    const bounded = boundRenderedDiff(compacted?.diff ?? fullDiff,
        compacted?.currentLineIndexes ?? fullCurrentLineIndexes,
        options.maxLines,
        options.full === true);
    const result = {
        diff: bounded.diff,
        additions,
        removals,
        unchanged,
        changed: additions > 0 || removals > 0,
        outputLines: bounded.outputLines,
        compactedUnchanged: compacted?.omittedUnchanged ?? 0,
        truncated: bounded.truncated,
        omittedLines: bounded.omittedLines,
        ...(compacted ? {
            compacted: true,
            omittedUnchanged: compacted.omittedUnchanged,
        } : {}),
    };
    return rememberSnapshotDiffProjection(result, bounded.currentLineIndexes);
}

const COMPACT_DIFF_CONTEXT_LINES = 3;
const SMALL_DIFF_COMPAT_LINES = 24;

/**
 * Adapted and materially changed from vercel-labs/agent-browser
 * 021d9255:cli/src/native/diff.rs (Apache-2.0). Keep legacy byte-for-byte diff
 * text for small snapshots. Larger snapshots use its three-line context radius, but
 * retain this daemon's existing line prefixes so current consumers keep working.
 */
function compactDiff(edits, requestedContextLines, force = false) {
    if (!force && edits.length <= SMALL_DIFF_COMPAT_LINES) {
        return null;
    }
    const contextLines = Number.isInteger(requestedContextLines) && requestedContextLines >= 0
        ? requestedContextLines
        : COMPACT_DIFF_CONTEXT_LINES;
    const changedIndexes = [];
    for (let i = 0; i < edits.length; i++) {
        if (edits[i].type !== 'equal') {
            changedIndexes.push(i);
        }
    }
    if (changedIndexes.length === 0) {
        return {
            diff: '',
            omittedUnchanged: edits.length,
            currentLineIndexes: [],
        };
    }
    const ranges = [];
    for (const index of changedIndexes) {
        const start = Math.max(0, index - contextLines);
        const end = Math.min(edits.length, index + contextLines + 1);
        const previous = ranges[ranges.length - 1];
        if (previous && start <= previous.end) {
            previous.end = Math.max(previous.end, end);
        }
        else {
            ranges.push({ start, end });
        }
    }
    let oldLine = 1;
    let newLine = 1;
    const positions = edits.map((edit) => {
        const position = { oldLine, newLine };
        if (edit.type !== 'insert')
            oldLine++;
        if (edit.type !== 'delete')
            newLine++;
        return position;
    });
    const output = [];
    const currentLineIndexes = [];
    let includedUnchanged = 0;
    for (const range of ranges) {
        const rangeEdits = edits.slice(range.start, range.end);
        const oldCount = rangeEdits.filter((edit) => edit.type !== 'insert').length;
        const newCount = rangeEdits.filter((edit) => edit.type !== 'delete').length;
        const position = positions[range.start];
        output.push(`@@ -${position.oldLine},${oldCount} +${position.newLine},${newCount} @@`);
        currentLineIndexes.push(null);
        for (const edit of rangeEdits) {
            if (edit.type === 'equal') {
                includedUnchanged++;
                output.push(`  ${edit.line}`);
                currentLineIndexes.push(edit.currentLineIndex);
            }
            else if (edit.type === 'insert') {
                output.push(`+ ${edit.line}`);
                currentLineIndexes.push(edit.currentLineIndex);
            }
            else {
                output.push(`- ${edit.line}`);
                currentLineIndexes.push(null);
            }
        }
    }
    const totalUnchanged = edits.filter((edit) => edit.type === 'equal').length;
    const omittedUnchanged = totalUnchanged - includedUnchanged;
    if (omittedUnchanged <= 0) {
        return null;
    }
    return {
        diff: output.join('\n'),
        omittedUnchanged,
        currentLineIndexes,
    };
}
const DIFF_ROUTE_PREFIX = 'https://agent-browser-diff.localhost';
/**
 * Compare two image buffers using the browser's Canvas API for pixel comparison.
 * Uses an isolated blank page to avoid CSP interference or DOM side effects on the
 * user's page. Images are served via intercepted routes to avoid large base64 payloads
 * through page.evaluate (which can be slow or hit CDP message size limits).
 */
export async function diffScreenshots(context, baselineBuffer, currentBuffer, opts) {
    const baselineMime = opts.baselineMime ?? 'image/png';
    const threshold = opts.threshold ?? 0.1;
    const nonce = Math.random().toString(36).slice(2, 10);
    const blankUrl = `${DIFF_ROUTE_PREFIX}/${nonce}/index.html`;
    const baselineUrl = `${DIFF_ROUTE_PREFIX}/${nonce}/baseline.png`;
    const currentUrl = `${DIFF_ROUTE_PREFIX}/${nonce}/current.png`;
    const diffPage = await context.newPage();
    let blankRouted = false;
    let baselineRouted = false;
    let currentRouted = false;
    try {
        await diffPage.route(blankUrl, (route) => route.fulfill({ body: '<html><body></body></html>', contentType: 'text/html' }));
        blankRouted = true;
        await diffPage.route(baselineUrl, (route) => route.fulfill({ body: baselineBuffer, contentType: baselineMime }));
        baselineRouted = true;
        await diffPage.route(currentUrl, (route) => route.fulfill({ body: currentBuffer, contentType: 'image/png' }));
        currentRouted = true;
        await diffPage.goto(blankUrl);
        const pixelDiffFn = async (args) => {
            const g = globalThis;
            const doc = g.document;
            const Img = g.Image;
            function loadImage(url) {
                return new Promise((resolve, reject) => {
                    const img = new Img();
                    img.onload = () => resolve(img);
                    img.onerror = () => reject(new Error('Failed to load image'));
                    img.src = url;
                });
            }
            const [imgA, imgB] = (await Promise.all([
                loadImage(args.baselineUrl),
                loadImage(args.currentUrl),
            ]));
            if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
                const c = doc.createElement('canvas');
                c.width = 1;
                c.height = 1;
                return {
                    totalPixels: Math.max(imgA.width * imgA.height, imgB.width * imgB.height),
                    differentPixels: Math.max(imgA.width * imgA.height, imgB.width * imgB.height),
                    mismatchPercentage: 100,
                    diffBase64: c.toDataURL('image/png').split(',')[1],
                    dimensionMismatch: true,
                };
            }
            const w = imgA.width;
            const h = imgA.height;
            const canvasA = doc.createElement('canvas');
            canvasA.width = w;
            canvasA.height = h;
            const ctxA = canvasA.getContext('2d');
            ctxA.drawImage(imgA, 0, 0);
            const dataA = ctxA.getImageData(0, 0, w, h).data;
            const canvasB = doc.createElement('canvas');
            canvasB.width = w;
            canvasB.height = h;
            const ctxB = canvasB.getContext('2d');
            ctxB.drawImage(imgB, 0, 0);
            const dataB = ctxB.getImageData(0, 0, w, h).data;
            const diffCanvas = doc.createElement('canvas');
            diffCanvas.width = w;
            diffCanvas.height = h;
            const ctxDiff = diffCanvas.getContext('2d');
            const diffImageData = ctxDiff.createImageData(w, h);
            const diffData = diffImageData.data;
            const maxColorDistance = args.threshold * 255 * Math.sqrt(3);
            let differentPixels = 0;
            const totalPixels = w * h;
            for (let i = 0; i < totalPixels; i++) {
                const offset = i * 4;
                const rA = dataA[offset], gA = dataA[offset + 1], bA = dataA[offset + 2];
                const rB = dataB[offset], gB = dataB[offset + 1], bB = dataB[offset + 2];
                const dr = rA - rB, dg = gA - gB, db = bA - bB;
                const dist = Math.sqrt(dr * dr + dg * dg + db * db);
                if (dist > maxColorDistance) {
                    differentPixels++;
                    diffData[offset] = 255;
                    diffData[offset + 1] = 0;
                    diffData[offset + 2] = 0;
                    diffData[offset + 3] = 255;
                }
                else {
                    diffData[offset] = Math.round(rA * 0.3);
                    diffData[offset + 1] = Math.round(gA * 0.3);
                    diffData[offset + 2] = Math.round(bA * 0.3);
                    diffData[offset + 3] = 255;
                }
            }
            ctxDiff.putImageData(diffImageData, 0, 0);
            const diffBase64 = diffCanvas.toDataURL('image/png').split(',')[1];
            return {
                totalPixels,
                differentPixels,
                mismatchPercentage: Math.round((differentPixels / totalPixels) * 10000) / 100,
                diffBase64,
                dimensionMismatch: false,
            };
        };
        const result = (await diffPage.evaluate(pixelDiffFn, {
            baselineUrl,
            currentUrl,
            threshold,
        }));
        let outputPath = opts.outputPath;
        if (!outputPath) {
            const tmpDir = path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.agent-browser', 'tmp', 'diffs');
            await mkdir(tmpDir, { recursive: true });
            outputPath = path.join(tmpDir, `diff-${Date.now()}.png`);
        }
        const diffBuffer = Buffer.from(result.diffBase64, 'base64');
        await writeFile(outputPath, diffBuffer);
        return {
            diffPath: outputPath,
            totalPixels: result.totalPixels,
            differentPixels: result.differentPixels,
            mismatchPercentage: result.mismatchPercentage,
            match: result.differentPixels === 0,
            ...(result.dimensionMismatch ? { dimensionMismatch: true } : {}),
        };
    }
    finally {
        if (blankRouted)
            await diffPage.unroute(blankUrl).catch(() => { });
        if (baselineRouted)
            await diffPage.unroute(baselineUrl).catch(() => { });
        if (currentRouted)
            await diffPage.unroute(currentUrl).catch(() => { });
        await diffPage.close().catch(() => { });
    }
}
