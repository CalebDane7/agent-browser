import * as fs from 'fs';
import * as path from 'path';
import { mkdirSync } from 'node:fs';
import { getAppDir } from './daemon.js';
import { getSessionsDir, readStateFile, isValidSessionName, isEncryptedPayload, listStateFiles, cleanupExpiredStates, } from './state-utils.js';
import { successResponse, errorResponse, finalizeResponse } from './protocol.js';
import { diffSnapshots, diffScreenshots, getSnapshotDiffCurrentLineIndexes } from './diff.js';
import { execSync } from 'child_process';
// Max screenshot dimension to stay within Claude's 2000px multi-image limit
const SCREENSHOT_MAX_DIM = 1568;
const DEFAULT_MAX_OUTPUT_BYTES = 50000;
const MAX_CONFIGURED_OUTPUT_BYTES = 100000000;
// Output limiting is adapted and materially changed from vercel-labs/agent-browser
// 021d9255:cli/src/output.rs (Apache-2.0); this version bounds complete JSON bytes.
const snapshotBaselines = new WeakMap();

function responseBytes(response) {
    return Buffer.byteLength(JSON.stringify(response), 'utf8');
}

function fullOutputRequested(command) {
    return command.fullOutput === true || process.env.AGENT_BROWSER_FULL_OUTPUT === '1';
}

function outputLimit(command) {
    if (fullOutputRequested(command)) {
        return null;
    }
    if (command.maxOutput !== undefined) {
        return Number.isSafeInteger(command.maxOutput) &&
            command.maxOutput >= 512 &&
            command.maxOutput <= MAX_CONFIGURED_OUTPUT_BYTES
            ? command.maxOutput
            : DEFAULT_MAX_OUTPUT_BYTES;
    }
    const rawEnvLimit = process.env.AGENT_BROWSER_MAX_OUTPUT ?? '';
    if (!/^[0-9]+$/.test(rawEnvLimit)) {
        return DEFAULT_MAX_OUTPUT_BYTES;
    }
    const envLimit = Number(rawEnvLimit);
    return Number.isSafeInteger(envLimit) &&
        envLimit >= 512 &&
        envLimit <= MAX_CONFIGURED_OUTPUT_BYTES
        ? envLimit
        : DEFAULT_MAX_OUTPUT_BYTES;
}

function jsonEscapedUnit(text, index) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 ||
        code === 0x0a || code === 0x0c || code === 0x0d) {
        return { bytes: 2, units: 1 };
    }
    if (code < 0x20) {
        return { bytes: 6, units: 1 };
    }
    if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        return next >= 0xdc00 && next <= 0xdfff
            ? { bytes: 4, units: 2 }
            : { bytes: 6, units: 1 };
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
        return { bytes: 6, units: 1 };
    }
    return { bytes: code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3, units: 1 };
}

function countTextLines(text) {
    let count = 1;
    let offset = -1;
    while ((offset = text.indexOf('\n', offset + 1)) !== -1) {
        count++;
    }
    return count;
}

function textPrefixForJsonBudget(text, maxBytes) {
    let bytes = 0;
    let index = 0;
    while (index < text.length) {
        const unit = jsonEscapedUnit(text, index);
        if (bytes + unit.bytes > maxBytes)
            break;
        bytes += unit.bytes;
        index += unit.units;
    }
    return { prefix: text.slice(0, index), keepUnits: index };
}

function linePrefixForJsonBudget(text, maxBytes) {
    let bytes = 0;
    let index = 0;
    let lastEnd = 0;
    let keepUnits = 0;
    while (index < text.length) {
        if (text.charCodeAt(index) === 0x0a) {
            lastEnd = index;
            keepUnits++;
            if (bytes + 2 > maxBytes)
                break;
            bytes += 2;
            index++;
            continue;
        }
        const unit = jsonEscapedUnit(text, index);
        if (bytes + unit.bytes > maxBytes)
            break;
        bytes += unit.bytes;
        index += unit.units;
    }
    if (index === text.length && bytes <= maxBytes) {
        lastEnd = text.length;
        keepUnits++;
    }
    return { prefix: text.slice(0, lastEnd), keepUnits };
}

function boundedTextResponse(command, data, field, options = {}) {
    const fullResponse = options.originalResponse ?? successResponse(command.id, data);
    const limitBytes = outputLimit(command);
    // Explicit full output is the fast path: transport will serialize it once.
    if (limitBytes === null) {
        return fullResponse;
    }
    const fullBytes = options.originalBytes ?? responseBytes(fullResponse);
    if (!options.forceTruncate && fullBytes <= limitBytes) {
        return fullResponse;
    }
    const source = String(data[field] ?? '');
    const totalUnits = options.lineSafe ? countTextLines(source) : source.length;
    const unit = options.lineSafe ? 'lines' : 'UTF-16 code units';
    const makeResponse = (prefix, keepUnits) => {
        const omittedUnits = Math.max(0, totalUnits - keepUnits);
        const marker = `[truncated: showing ${keepUnits} of ${totalUnits} ${unit}; use protocol fullOutput=true/maxOutput or daemon-start AGENT_BROWSER_FULL_OUTPUT=1]`;
        const value = prefix ? `${prefix}\n${marker}` : marker;
        let nextData = {
            ...data,
            [field]: value,
            truncated: true,
            outputLimit: {
                field,
                limitBytes,
                originalBytes: fullBytes,
                omittedUnits,
                unit,
                ...(options.extraMeta ?? {}),
            },
        };
        if (options.projectData) {
            nextData = options.projectData(nextData, value, { keepUnits, totalUnits, unit });
        }
        return successResponse(command.id, nextData);
    };
    const zero = makeResponse('', 0);
    const zeroBytes = responseBytes(zero);
    let contentBudget = Math.max(0, limitBytes - zeroBytes - 24);
    for (let attempt = 0; attempt < 4; attempt++) {
        const fitted = options.lineSafe
            ? linePrefixForJsonBudget(source, contentBudget)
            : textPrefixForJsonBudget(source, contentBudget);
        const candidate = makeResponse(fitted.prefix, fitted.keepUnits);
        const candidateBytes = responseBytes(candidate);
        if (candidateBytes <= limitBytes) {
            return candidate;
        }
        contentBudget = Math.max(0, contentBudget - (candidateBytes - limitBytes) - 16);
    }
    if (zeroBytes <= limitBytes) {
        return zero;
    }
    let minimalData = {
        ...(options.requiredData ?? {}),
        truncated: true,
        outputLimit: { field, limitBytes, originalBytes: fullBytes },
        [field]: '[truncated: output limit too small for a preview]',
    };
    if (options.projectData) {
        minimalData = options.projectData(minimalData, minimalData[field], { keepUnits: 0, totalUnits, unit });
    }
    return successResponse(command.id, minimalData);
}

function boundedJsonResponse(command, data, field) {
    const fullResponse = successResponse(command.id, data);
    const limitBytes = outputLimit(command);
    if (limitBytes === null) {
        return fullResponse;
    }
    const fullBytes = responseBytes(fullResponse);
    if (fullBytes <= limitBytes) {
        return fullResponse;
    }
    let preview;
    try {
        preview = typeof data[field] === 'string' ? data[field] : JSON.stringify(data[field]);
    }
    catch {
        preview = String(data[field]);
    }
    const originalValue = data[field];
    const originalType = Array.isArray(originalValue) ? 'array' : originalValue === null ? 'null' : typeof originalValue;
    return boundedTextResponse(command, { ...data, [field]: preview }, field, {
        originalResponse: fullResponse,
        originalBytes: fullBytes,
        forceTruncate: true,
        extraMeta: { originalType },
    });
}

function boundedArrayResponse(command, data, field, markerItem) {
    const fullResponse = successResponse(command.id, data);
    const limitBytes = outputLimit(command);
    if (limitBytes === null) {
        return fullResponse;
    }
    const fullBytes = responseBytes(fullResponse);
    if (fullBytes <= limitBytes) {
        return fullResponse;
    }
    const items = Array.isArray(data[field]) ? data[field] : [];
    const makeResponse = (keepItems) => {
        const marker = `[truncated: showing ${keepItems} of ${items.length} items; use protocol fullOutput=true/maxOutput or daemon-start AGENT_BROWSER_FULL_OUTPUT=1]`;
        return successResponse(command.id, {
            ...data,
            [field]: [...items.slice(0, keepItems), markerItem(marker)],
            truncated: true,
            outputLimit: {
                field,
                limitBytes,
                originalBytes: fullBytes,
                omittedUnits: items.length - keepItems,
                unit: 'items',
            },
        });
    };
    let low = 0;
    let high = items.length;
    let best = makeResponse(0);
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = makeResponse(middle);
        if (responseBytes(candidate) <= limitBytes) {
            best = candidate;
            low = middle + 1;
        }
        else {
            high = middle - 1;
        }
    }
    if (responseBytes(best) > limitBytes) {
        return successResponse(command.id, {
            truncated: true,
            outputLimit: { field, limitBytes, originalBytes: fullBytes },
            [field]: [markerItem('[truncated: output limit too small for an item preview]')],
        });
    }
    return best;
}

function pageSurfaceIdentity(browser) {
    const page = browser.getPage();
    let url = null;
    try {
        url = typeof page?.url === 'function' ? page.url() : page?._url ?? null;
    }
    catch { }
    return {
        targetId: page?._targetId ?? null,
        sessionId: page?._sessionId ?? null,
        url,
    };
}

function snapshotSurfaceSignature(browser, options, scope) {
    const stableBackendNodeId = scope?.backendNodeId ?? null;
    return JSON.stringify({
        ...pageSurfaceIdentity(browser),
        selector: options.selector ?? null,
        // Frontend nodeIds can be re-issued when the same backend node is pushed
        // into a fresh document view. Prefer the stable backend capability and
        // use nodeId only when CDP did not provide one.
        scopeNodeId: stableBackendNodeId === null
            ? scope?.nodeId ?? options.scopeNodeId ?? null
            : null,
        scopeBackendNodeId: stableBackendNodeId,
        documentBackendNodeId: scope?.documentBackendNodeId ?? null,
        interactive: options.interactive === true,
        cursor: options.cursor === true,
        compact: options.compact === true,
        maxDepth: options.maxDepth ?? null,
    });
}

function snapshotScopeCapability(command, browser, snapshot) {
    if (!command.selector || !snapshot.scope) {
        return null;
    }
    return {
        selector: command.selector,
        ...pageSurfaceIdentity(browser),
        nodeId: snapshot.scope.nodeId ?? null,
        backendNodeId: snapshot.scope.backendNodeId ?? null,
        documentBackendNodeId: snapshot.scope.documentBackendNodeId ?? null,
    };
}

async function restoreBaselineScope(command, browser, prior) {
    const capability = prior?.scopeCapability;
    if (!capability || capability.selector !== command.selector) {
        return null;
    }
    const current = pageSurfaceIdentity(browser);
    if (capability.targetId !== current.targetId ||
        capability.sessionId !== current.sessionId ||
        capability.url !== current.url) {
        throw new Error(`Snapshot scope is stale: ${command.selector}`);
    }
    if (!Number.isInteger(capability.backendNodeId)) {
        throw new Error(`Snapshot scope cannot be safely restored: ${command.selector}`);
    }
    if (!Number.isInteger(capability.documentBackendNodeId)) {
        throw new Error(`Snapshot scope cannot be safely restored: ${command.selector}`);
    }
    const page = browser.getPage();
    const client = page?._client;
    const sessionId = page?._sessionId;
    if (!client || typeof client.send !== 'function') {
        throw new Error(`Snapshot scope cannot be safely restored: ${command.selector}`);
    }
    const { root } = await client.send('DOM.getDocument', { depth: 0 }, sessionId);
    if (!Number.isInteger(root?.backendNodeId) ||
        capability.documentBackendNodeId !== root.backendNodeId) {
        throw new Error(`Snapshot scope is stale: ${command.selector}`);
    }
    const { nodeIds } = await client.send('DOM.pushNodesByBackendIdsToFrontend', {
        backendNodeIds: [capability.backendNodeId],
    }, sessionId);
    if (!nodeIds || !Number.isInteger(nodeIds[0]) || nodeIds[0] <= 0) {
        throw new Error(`Snapshot scope is stale: ${command.selector}`);
    }
    return nodeIds[0];
}

async function snapshotOptionsForCommand(command, browser, prior = null) {
    const options = {
        interactive: command.interactive,
        cursor: command.cursor,
        maxDepth: command.maxDepth,
        compact: command.compact,
        selector: command.selector,
    };
    if (command.selector && typeof browser.isRef === 'function' && browser.isRef(command.selector)) {
        const restoredNodeId = await restoreBaselineScope(command, browser, prior);
        if (restoredNodeId !== null) {
            options.scopeNodeId = restoredNodeId;
            return options;
        }
        const locator = browser.getLocatorFromRef(command.selector);
        if (!locator || typeof locator._resolve !== 'function') {
            throw new Error(`Snapshot ref not found: ${command.selector}`);
        }
        // The raw-CDP locator already owns role/name/nth resolution. Reusing its
        // nodeId keeps @ref scoping exact without translating it to a wider CSS query.
        options.scopeNodeId = await locator._resolve();
    }
    return options;
}

function boundedSnapshotResponse(command, tree, simpleRefs, refLineIndexes) {
    const refsByLine = Object.entries(simpleRefs)
        .map(([ref, data]) => ({ ref, data, line: refLineIndexes?.[ref] }))
        .filter((entry) => Number.isInteger(entry.line) && entry.line >= 0)
        .sort((a, b) => a.line - b.line);
    const refsBeforeLine = (lineCount) => {
        let low = 0;
        let high = refsByLine.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (refsByLine[middle].line < lineCount)
                low = middle + 1;
            else
                high = middle;
        }
        return Object.fromEntries(refsByLine.slice(0, low).map(({ ref, data }) => [ref, data]));
    };
    const data = {
        snapshot: tree || 'Empty page',
        refs: Object.keys(simpleRefs).length > 0 ? simpleRefs : undefined,
    };
    return boundedTextResponse(command, data, 'snapshot', {
        lineSafe: true,
        projectData(nextData, _visibleText, projection) {
            const refs = refsBeforeLine(projection.keepUnits);
            const projected = { ...nextData };
            if (Object.keys(refs).length > 0) {
                projected.refs = refs;
            }
            else {
                delete projected.refs;
            }
            return projected;
        },
    });
}

function compactDiffInvariant(result) {
    return {
        diff: result.diff,
        additions: result.additions,
        removals: result.removals,
        unchanged: result.unchanged,
        changed: result.changed,
        ...(result.compacted === true ? {
            compacted: true,
            ...(Number.isInteger(result.omittedUnchanged)
                ? { omittedUnchanged: result.omittedUnchanged }
                : {}),
        } : {}),
        ...(result.computationLimited === true ? {
            computationLimited: true,
            diffAlgorithm: result.diffAlgorithm,
            computationLimit: {
                reason: result.computationLimit?.reason,
                stats: result.computationLimit?.stats,
            },
        } : {}),
    };
}

function boundedSnapshotDiffResponse(command, result) {
    const fullResponse = successResponse(command.id, result);
    if (outputLimit(command) === null) {
        return fullResponse;
    }
    const fullBytes = responseBytes(fullResponse);
    if (fullBytes <= outputLimit(command)) {
        return fullResponse;
    }
    const compact = compactDiffInvariant(result);
    const { diff: _diff, ...requiredData } = compact;
    return boundedTextResponse(command, compact, 'diff', {
        originalResponse: fullResponse,
        originalBytes: fullBytes,
        forceTruncate: true,
        lineSafe: true,
        requiredData,
    });
}

function boundedNestedSnapshotDiffResponse(command, data) {
    const fullResponse = successResponse(command.id, data);
    if (outputLimit(command) === null) {
        return fullResponse;
    }
    const fullBytes = responseBytes(fullResponse);
    if (fullBytes <= outputLimit(command)) {
        return fullResponse;
    }
    const compactSnapshot = compactDiffInvariant(data.snapshot);
    const requiredData = {
        snapshot: { ...compactSnapshot, diff: '' },
        ...(data.screenshot ? { screenshot: data.screenshot } : {}),
    };
    return boundedTextResponse(command, {
        ...data,
        snapshot: { ...compactSnapshot, diff: '' },
        snapshotDiffPreview: data.snapshot.diff,
    }, 'snapshotDiffPreview', {
        originalResponse: fullResponse,
        originalBytes: fullBytes,
        lineSafe: true,
        forceTruncate: true,
        requiredData,
        projectData(nextData, visibleText) {
            const { snapshotDiffPreview, ...projected } = nextData;
            return {
                ...projected,
                snapshot: { ...projected.snapshot, diff: visibleText },
            };
        },
    });
}

function mutableBrowserRefMap(browser, refs) {
    if (refs && typeof refs === 'object')
        return refs;
    if (typeof browser.getRefMap === 'function')
        return browser.getRefMap();
    return browser.refMap && typeof browser.refMap === 'object' ? browser.refMap : null;
}

function retainBrowserRefs(browser, refs, retained) {
    const liveRefs = mutableBrowserRefMap(browser, refs);
    if (!liveRefs)
        return;
    for (const ref of Object.keys(liveRefs)) {
        if (!retained.has(ref)) {
            delete liveRefs[ref];
        }
    }
}

function clearBrowserRefs(browser, refs) {
    retainBrowserRefs(browser, refs, new Set());
}

function projectDiffRefs(browser, snapshot, diffResult, response) {
    const projection = getSnapshotDiffCurrentLineIndexes(diffResult);
    if (!Array.isArray(projection) || !snapshot?.refLineIndexes) {
        clearBrowserRefs(browser, snapshot?.refs);
        return;
    }
    let keptDiffLines = projection.length;
    if (response.data?.truncated) {
        const limit = response.data.outputLimit;
        keptDiffLines = limit?.unit === 'lines' && Number.isInteger(limit.omittedUnits)
            ? Math.max(0, projection.length - limit.omittedUnits)
            : 0;
    }
    const currentLines = new Set(projection.slice(0, keptDiffLines)
        .filter((line) => Number.isInteger(line) && line >= 0));
    const retained = new Set(Object.entries(snapshot.refLineIndexes)
        .filter(([, line]) => currentLines.has(line))
        .map(([ref]) => ref));
    retainBrowserRefs(browser, snapshot.refs, retained);
}
export const DAEMON_CAPABILITIES = Object.freeze(['click-expect-popup-v1']);
const ACTION_ERROR_LIMIT_BYTES = 400;

function truncateUtf8(value, maxBytes) {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes)
        return value;
    const ellipsis = '…';
    const budget = maxBytes - Buffer.byteLength(ellipsis, 'utf8');
    let result = '';
    let bytes = 0;
    for (const char of value) {
        const charBytes = Buffer.byteLength(char, 'utf8');
        if (bytes + charBytes > budget)
            break;
        result += char;
        bytes += charBytes;
    }
    return `${result}${ellipsis}`;
}

export function renderActionError(error) {
    let message;
    try {
        message = error instanceof Error ? error.message : String(error);
    }
    catch {
        message = 'Operation failed';
    }
    // Buffer's UTF-8 round trip replaces lone UTF-16 surrogates before any
    // diagnostic reaches JSON serialization or byte-bound truncation.
    message = Buffer.from(String(message), 'utf8').toString('utf8')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
        .replace(/(?:[A-Za-z]:\\|\/(?:home|run|tmp|mnt|Users)\/)[^\s"'<>]+/g, '[path]')
        .replace(/(["']?)(access[_-]?token|token|password|passwd|secret|authorization|cookie|api[_-]?key)\1\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer\s+)?[^\s,;}\]]+)/gi,
            (_match, quote, key) => `${quote}${key}${quote}=[redacted]`)
        .replace(/\s+/g, ' ')
        .trim();
    if (!message)
        message = 'Operation failed';
    return truncateUtf8(message, ACTION_ERROR_LIMIT_BYTES);
}
function renderSelector(selector) {
    return truncateUtf8(renderActionError(String(selector ?? '')), 120);
}
function resizeScreenshotIfNeeded(filePath) {
    const data = fs.readFileSync(filePath);
    let width, height;
    if (data[0] === 0x89 && data[1] === 0x50) {
        width = data.readUInt32BE(16);
        height = data.readUInt32BE(20);
    }
    else if (data[0] === 0xFF && data[1] === 0xD8) {
        for (let i = 2; i < data.length - 9; i++) {
            if (data[i] === 0xFF && (data[i + 1] === 0xC0 || data[i + 1] === 0xC2)) {
                height = data.readUInt16BE(i + 5);
                width = data.readUInt16BE(i + 7);
                break;
            }
        }
    }
    if (!width || !height || (width <= SCREENSHOT_MAX_DIM && height <= SCREENSHOT_MAX_DIM)) {
        return;
    }
    const tmpPath = filePath + '.resized' + path.extname(filePath);
    try {
        execSync(`ffmpeg -y -i "${filePath}" -vf "scale='min(${SCREENSHOT_MAX_DIM},iw)':'min(${SCREENSHOT_MAX_DIM},ih)':force_original_aspect_ratio=decrease" "${tmpPath}"`, { stdio: 'pipe', timeout: 10000 });
        fs.renameSync(tmpPath, filePath);
    }
    catch (e) {
        try { fs.unlinkSync(tmpPath); } catch { }
    }
}
// Callback for screencast frames - will be set by the daemon when streaming is active
let screencastFrameCallback = null;
/**
 * Set the callback for screencast frames
 * This is called by the daemon to set up frame streaming
 */
export function setScreencastFrameCallback(callback) {
    screencastFrameCallback = callback;
}
/**
 * Convert browser errors to AI-friendly messages
 * @internal Exported for testing
 */
export function toAIFriendlyError(error, selector) {
    const message = renderActionError(error);
    const safeSelector = renderSelector(selector);
    // Handle strict mode violation (multiple elements match)
    if (message.includes('strict mode violation')) {
        // Extract count if available
        const countMatch = message.match(/resolved to (\d+) elements/);
        const count = countMatch ? countMatch[1] : 'multiple';
        return new Error(`Selector "${safeSelector}" matched ${count} elements. ` +
            `Run 'snapshot' to get updated refs, or use a more specific CSS selector.`);
    }
    // Handle element not interactable (must be checked BEFORE timeout case)
    // This includes cases where an overlay/modal blocks the element
    if (message.includes('intercepts pointer events')) {
        return new Error(`Element "${safeSelector}" is blocked by another element (likely a modal or overlay). ` +
            `Try dismissing any modals/cookie banners first.`);
    }
    // Handle element not visible
    if (message.includes('not visible') && !message.includes('Timeout')) {
        return new Error(`Element "${safeSelector}" is not visible. ` +
            `Try scrolling it into view or check if it's hidden.`);
    }
    // Handle general timeout (element exists but action couldn't complete)
    if (message.includes('Timeout') && message.includes('exceeded')) {
        return new Error(`Action on "${safeSelector}" timed out. The element may be blocked, still loading, or not interactable. ` +
            `Run 'snapshot' to check the current page state.`);
    }
    // Handle element not found (timeout waiting for element)
    if (message.includes('waiting for') &&
        (message.includes('to be visible') || message.includes('Timeout'))) {
        return new Error(`Element "${safeSelector}" not found or not visible. ` +
            `Run 'snapshot' to see current page elements.`);
    }
    // Return original error for unknown cases
    return new Error(message);
}
/**
 * Execute a command and return a response
 */
export async function executeCommand(command, browser) {
    const response = await executeCommandUnchecked(command, browser);
    const publishesSnapshotRefs = command.action === 'snapshot' ||
        command.action === 'diff_snapshot' ||
        command.action === 'diff_url';
    if ((!response.success && publishesSnapshotRefs) || command.action === 'diff_screenshot') {
        clearBrowserRefs(browser);
    }
    const finalized = finalizeResponse(response, command);
    if (finalized !== response && publishesSnapshotRefs) {
        // The central envelope no longer exposes the structurally projected
        // snapshot lines, so no ref from the hidden handler response is valid.
        clearBrowserRefs(browser);
    }
    return finalized;
}

async function executeCommandUnchecked(command, browser) {
    try {
        // diff_url navigates before each snapshot, so a ref capability owned by
        // the current document cannot safely identify either post-navigation
        // scope. Reject it before navigation instead of treating it as raw CSS.
        if (command.action === 'diff_url' &&
            typeof command.selector === 'string' &&
            typeof browser.isRef === 'function' &&
            browser.isRef(command.selector)) {
            throw new Error(`Snapshot ref cannot scope diff_url across navigation: ${command.selector}`);
        }
        // eN/@eN/ref=eN are reserved snapshot capabilities. If projection or
        // reset revoked one, no selector-taking action may reinterpret its text
        // as page-controlled CSS. Scoped snapshot retry is the sole exception:
        // it can restore the structurally stored backend-node capability.
        if (command.action !== 'snapshot' &&
            command.action !== 'diff_snapshot' &&
            typeof command.selector === 'string' &&
            typeof browser.isRef === 'function' &&
            browser.isRef(command.selector) &&
            typeof browser.getLocatorFromRef === 'function' &&
            !browser.getLocatorFromRef(command.selector)) {
            throw new Error(`Snapshot ref not found: ${command.selector}`);
        }
        browser?.assertCommandAllowed?.(command.action);
        switch (command.action) {
            case 'launch':
                return await handleLaunch(command, browser);
            case 'navigate':
                return await handleNavigate(command, browser);
            case 'click':
                return await handleClick(command, browser);
            case 'type':
                return await handleType(command, browser);
            case 'fill':
                return await handleFill(command, browser);
            case 'check':
                return await handleCheck(command, browser);
            case 'uncheck':
                return await handleUncheck(command, browser);
            case 'upload':
                return await handleUpload(command, browser);
            case 'dblclick':
                return await handleDoubleClick(command, browser);
            case 'focus':
                return await handleFocus(command, browser);
            case 'drag':
                return await handleDrag(command, browser);
            case 'frame':
                return await handleFrame(command, browser);
            case 'mainframe':
                return await handleMainFrame(command, browser);
            case 'getbyrole':
                return await handleGetByRole(command, browser);
            case 'getbytext':
                return await handleGetByText(command, browser);
            case 'getbylabel':
                return await handleGetByLabel(command, browser);
            case 'getbyplaceholder':
                return await handleGetByPlaceholder(command, browser);
            case 'press':
                return await handlePress(command, browser);
            case 'screenshot':
                return await handleScreenshot(command, browser);
            case 'snapshot':
                return await handleSnapshot(command, browser);
            case 'evaluate':
                return await handleEvaluate(command, browser);
            case 'wait':
                return await handleWait(command, browser);
            case 'scroll':
                return await handleScroll(command, browser);
            case 'select':
                return await handleSelect(command, browser);
            case 'hover':
                return await handleHover(command, browser);
            case 'content':
                return await handleContent(command, browser);
            case 'close':
                return await handleClose(command, browser);
            case 'tab_new':
                return await handleTabNew(command, browser);
            case 'tab_list':
                return await handleTabList(command, browser);
            case 'tab_switch':
                return await handleTabSwitch(command, browser);
            case 'tab_close':
                return await handleTabClose(command, browser);
            case 'window_new':
                return await handleWindowNew(command, browser);
            case 'cookies_get':
                return await handleCookiesGet(command, browser);
            case 'cookies_set':
                return await handleCookiesSet(command, browser);
            case 'cookies_clear':
                return await handleCookiesClear(command, browser);
            case 'storage_get':
                return await handleStorageGet(command, browser);
            case 'storage_set':
                return await handleStorageSet(command, browser);
            case 'storage_clear':
                return await handleStorageClear(command, browser);
            case 'dialog':
                return await handleDialog(command, browser);
            case 'pdf':
                return await handlePdf(command, browser);
            case 'route':
                return await handleRoute(command, browser);
            case 'unroute':
                return await handleUnroute(command, browser);
            case 'requests':
                return await handleRequests(command, browser);
            case 'download':
                return await handleDownload(command, browser);
            case 'geolocation':
                return await handleGeolocation(command, browser);
            case 'permissions':
                return await handlePermissions(command, browser);
            case 'viewport':
                return await handleViewport(command, browser);
            case 'useragent':
                return await handleUserAgent(command, browser);
            case 'device':
                return await handleDevice(command, browser);
            case 'back':
                return await handleBack(command, browser);
            case 'forward':
                return await handleForward(command, browser);
            case 'reload':
                return await handleReload(command, browser);
            case 'url':
                return await handleUrl(command, browser);
            case 'title':
                return await handleTitle(command, browser);
            case 'getattribute':
                return await handleGetAttribute(command, browser);
            case 'gettext':
                return await handleGetText(command, browser);
            case 'isvisible':
                return await handleIsVisible(command, browser);
            case 'isenabled':
                return await handleIsEnabled(command, browser);
            case 'ischecked':
                return await handleIsChecked(command, browser);
            case 'count':
                return await handleCount(command, browser);
            case 'boundingbox':
                return await handleBoundingBox(command, browser);
            case 'styles':
                return await handleStyles(command, browser);
            case 'video_start':
                return await handleVideoStart(command, browser);
            case 'video_stop':
                return await handleVideoStop(command, browser);
            case 'trace_start':
                return await handleTraceStart(command, browser);
            case 'trace_stop':
                return await handleTraceStop(command, browser);
            case 'profiler_start':
                return await handleProfilerStart(command, browser);
            case 'profiler_stop':
                return await handleProfilerStop(command, browser);
            case 'har_start':
                return await handleHarStart(command, browser);
            case 'har_stop':
                return await handleHarStop(command, browser);
            case 'state_save':
                return await handleStateSave(command, browser);
            case 'state_load':
                return await handleStateLoad(command, browser);
            case 'state_list':
                return await handleStateList(command);
            case 'state_clear':
                return await handleStateClear(command);
            case 'state_show':
                return await handleStateShow(command);
            case 'state_clean':
                return await handleStateClean(command);
            case 'state_rename':
                return await handleStateRename(command);
            case 'console':
                return await handleConsole(command, browser);
            case 'errors':
                return await handleErrors(command, browser);
            case 'keyboard':
                return await handleKeyboard(command, browser);
            case 'wheel':
                return await handleWheel(command, browser);
            case 'tap':
                return await handleTap(command, browser);
            case 'clipboard':
                return await handleClipboard(command, browser);
            case 'highlight':
                return await handleHighlight(command, browser);
            case 'clear':
                return await handleClear(command, browser);
            case 'selectall':
                return await handleSelectAll(command, browser);
            case 'innertext':
                return await handleInnerText(command, browser);
            case 'innerhtml':
                return await handleInnerHtml(command, browser);
            case 'inputvalue':
                return await handleInputValue(command, browser);
            case 'setvalue':
                return await handleSetValue(command, browser);
            case 'dispatch':
                return await handleDispatch(command, browser);
            case 'evalhandle':
                return await handleEvalHandle(command, browser);
            case 'expose':
                return await handleExpose(command, browser);
            case 'addscript':
                return await handleAddScript(command, browser);
            case 'addstyle':
                return await handleAddStyle(command, browser);
            case 'emulatemedia':
                return await handleEmulateMedia(command, browser);
            case 'offline':
                return await handleOffline(command, browser);
            case 'headers':
                return await handleHeaders(command, browser);
            case 'pause':
                return await handlePause(command, browser);
            case 'getbyalttext':
                return await handleGetByAltText(command, browser);
            case 'getbytitle':
                return await handleGetByTitle(command, browser);
            case 'getbytestid':
                return await handleGetByTestId(command, browser);
            case 'nth':
                return await handleNth(command, browser);
            case 'waitforurl':
                return await handleWaitForUrl(command, browser);
            case 'waitforloadstate':
                return await handleWaitForLoadState(command, browser);
            case 'setcontent':
                return await handleSetContent(command, browser);
            case 'timezone':
                return await handleTimezone(command, browser);
            case 'locale':
                return await handleLocale(command, browser);
            case 'credentials':
                return await handleCredentials(command, browser);
            case 'mousemove':
                return await handleMouseMove(command, browser);
            case 'mousedown':
                return await handleMouseDown(command, browser);
            case 'mouseup':
                return await handleMouseUp(command, browser);
            case 'bringtofront':
                return await handleBringToFront(command, browser);
            case 'waitforfunction':
                return await handleWaitForFunction(command, browser);
            case 'scrollintoview':
                return await handleScrollIntoView(command, browser);
            case 'addinitscript':
                return await handleAddInitScript(command, browser);
            case 'keydown':
                return await handleKeyDown(command, browser);
            case 'keyup':
                return await handleKeyUp(command, browser);
            case 'inserttext':
                return await handleInsertText(command, browser);
            case 'multiselect':
                return await handleMultiSelect(command, browser);
            case 'waitfordownload':
                return await handleWaitForDownload(command, browser);
            case 'responsebody':
                return await handleResponseBody(command, browser);
            case 'screencast_start':
                return await handleScreencastStart(command, browser);
            case 'screencast_stop':
                return await handleScreencastStop(command, browser);
            case 'input_mouse':
                return await handleInputMouse(command, browser);
            case 'input_keyboard':
                return await handleInputKeyboard(command, browser);
            case 'input_touch':
                return await handleInputTouch(command, browser);
            case 'recording_start':
                return await handleRecordingStart(command, browser);
            case 'recording_stop':
                return await handleRecordingStop(command, browser);
            case 'recording_restart':
                return await handleRecordingRestart(command, browser);
            case 'diff_snapshot':
                return await handleDiffSnapshot(command, browser);
            case 'diff_screenshot':
                return await handleDiffScreenshot(command, browser);
            case 'diff_url':
                return await handleDiffUrl(command, browser);
            case 'share':
                return await handleShare(command);
            case 'shared':
                return await handleShared(command);
            case 'tasks_create':
                return await handleTasksCreate(command);
            case 'tasks_list':
                return await handleTasksList(command);
            case 'tasks_claim':
                return await handleTasksClaim(command);
            case 'tasks_complete':
                return await handleTasksComplete(command);
            default: {
                // TypeScript narrows to never here, but we handle it for safety
                const unknownCommand = command;
                return errorResponse(unknownCommand.id, `Unknown action: ${unknownCommand.action}`);
            }
        }
    }
    catch (error) {
        return errorResponse(command.id, renderActionError(error));
    }
}
async function handleLaunch(command, browser) {
    await browser.launch(command);
    return successResponse(command.id, {
        launched: true,
        capabilities: DAEMON_CAPABILITIES,
    });
}
async function handleNavigate(command, browser) {
    const page = browser.getPage();
    // If headers are provided, set up scoped headers for this origin
    if (command.headers && Object.keys(command.headers).length > 0) {
        await browser.setScopedHeaders(command.url, command.headers);
    }
    await page.goto(command.url, {
        waitUntil: command.waitUntil ?? 'load',
    });
    return successResponse(command.id, {
        url: page.url(),
        title: await page.title(),
    });
}
async function handleClick(command, browser) {
    // Support both refs (@e1) and regular selectors
    const locator = browser.getLocator(command.selector);
    let popupGuard = null;
    try {
        // If --new-tab flag is set, get the href and open in a new tab
        if (command.newTab) {
            const fullUrl = await locator.evaluate((el) => {
                const href = el.getAttribute('href');
                // URL and document.baseURI are available in the browser context
                return href
                    ? new globalThis.URL(href, globalThis.document.baseURI).toString()
                    : '';
            });
            if (!fullUrl) {
                throw new Error(`Element '${command.selector}' does not have an href attribute. --new-tab only works on links.`);
            }
            await browser.newTab();
            const newPage = browser.getPage();
            await newPage.goto(fullUrl);
            return successResponse(command.id, {
                clicked: true,
                newTab: true,
                url: fullUrl,
            });
        }
        if (command.expectPopup === true && typeof browser.armPopupTracking !== 'function') {
            throw new Error('Explicit popup tracking is unavailable; daemon capability click-expect-popup-v1 is required.');
        }
        if ((command.expectPopup === true || command.button === 'middle') &&
            typeof browser.armPopupTracking === 'function') {
            popupGuard = await browser.armPopupTracking(locator, {
                force: true,
                timeoutMs: 350,
            });
        }
        if (command.expectPopup === true && !popupGuard) {
            throw new Error('Explicit popup tracking could not be armed; refusing an unguarded popup click.');
        }
        await locator.click({
            button: command.button,
            clickCount: command.clickCount,
            delay: command.delay,
        });
        if (popupGuard) await popupGuard.wait();
    }
    catch (error) {
        popupGuard?.cancel();
        throw toAIFriendlyError(error, command.selector);
    }
    return command.expectPopup === true
        ? successResponse(command.id, { clicked: true, popupTracking: 'event-armed-v1' })
        : successResponse(command.id, { clicked: true });
}
async function handleType(command, browser) {
    const locator = browser.getLocator(command.selector);
    try {
        if (command.clear) {
            await locator.fill('');
        }
        await locator.pressSequentially(command.text, {
            delay: command.delay,
        });
    }
    catch (error) {
        throw toAIFriendlyError(error, command.selector);
    }
    return successResponse(command.id, { typed: true });
}
async function handlePress(command, browser) {
    const page = browser.getPage();
    if (command.selector) {
        await page.press(command.selector, command.key);
    }
    else {
        await page.keyboard.press(command.key);
    }
    return successResponse(command.id, { pressed: true });
}
const ANNOTATION_OVERLAY_ID = '__agent_browser_annotations__';
async function removeAnnotationOverlay(page) {
    await page
        .evaluate(`(() => { const el = document.getElementById(${JSON.stringify(ANNOTATION_OVERLAY_ID)}); if (el) el.remove(); })()`)
        .catch(() => { });
}
async function handleScreenshot(command, browser) {
    const page = browser.getPage();
    const options = {
        fullPage: command.fullPage,
        type: command.format ?? 'png',
        scale: 'css',
    };
    if (command.format === 'jpeg' && command.quality !== undefined) {
        options.quality = command.quality;
    }
    let target = page;
    if (command.selector) {
        target = browser.getLocator(command.selector);
    }
    let overlayInjected = false;
    try {
        let savePath = command.path;
        if (!savePath) {
            const ext = command.format === 'jpeg' ? 'jpg' : 'png';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const random = Math.random().toString(36).substring(2, 8);
            const filename = `screenshot-${timestamp}-${random}.${ext}`;
            const screenshotDir = path.join(getAppDir(), 'tmp', 'screenshots');
            mkdirSync(screenshotDir, { recursive: true });
            savePath = path.join(screenshotDir, filename);
        }
        let annotations;
        if (command.annotate) {
            const { refs } = await browser.getSnapshot({ interactive: true });
            const entries = Object.entries(refs);
            const results = await Promise.all(entries.map(async ([ref, data]) => {
                try {
                    const locator = browser.getLocatorFromRef(ref);
                    if (!locator)
                        return null;
                    const box = await locator.boundingBox();
                    if (!box || box.width === 0 || box.height === 0)
                        return null;
                    const num = parseInt(ref.replace('e', ''), 10);
                    return {
                        ref,
                        number: num,
                        role: data.role,
                        name: data.name || undefined,
                        box: {
                            x: Math.round(box.x),
                            y: Math.round(box.y),
                            width: Math.round(box.width),
                            height: Math.round(box.height),
                        },
                    };
                }
                catch {
                    return null;
                }
            }));
            // When a selector is provided the screenshot is cropped to that element,
            // so filter to annotations that overlap the target and shift coordinates.
            let targetBox = null;
            if (command.selector) {
                const raw = await browser.getLocator(command.selector).boundingBox();
                if (raw) {
                    targetBox = {
                        x: Math.round(raw.x),
                        y: Math.round(raw.y),
                        width: Math.round(raw.width),
                        height: Math.round(raw.height),
                    };
                }
            }
            const filtered = results.filter((a) => a !== null);
            // Filter by selector overlap if needed, but keep viewport-relative coords
            // for overlay positioning. Coordinate shifting happens later for metadata only.
            let overlayItems;
            if (targetBox) {
                const tb = targetBox;
                overlayItems = filtered
                    .filter((a) => {
                    const ax2 = a.box.x + a.box.width;
                    const ay2 = a.box.y + a.box.height;
                    const bx2 = tb.x + tb.width;
                    const by2 = tb.y + tb.height;
                    return a.box.x < bx2 && ax2 > tb.x && a.box.y < by2 && ay2 > tb.y;
                })
                    .sort((a, b) => a.number - b.number);
            }
            else {
                overlayItems = filtered.sort((a, b) => a.number - b.number);
            }
            if (overlayItems.length > 0) {
                const overlayData = overlayItems.map((a) => ({
                    number: a.number,
                    x: a.box.x,
                    y: a.box.y,
                    width: a.box.width,
                    height: a.box.height,
                }));
                // Uses position:absolute with document-relative coords so labels render
                // correctly for both viewport and fullPage screenshots, and when the
                // screenshot is scoped to a selector element.
                await page.evaluate(`(() => {
          var items = ${JSON.stringify(overlayData)};
          var id = ${JSON.stringify(ANNOTATION_OVERLAY_ID)};
          var sx = window.scrollX || 0;
          var sy = window.scrollY || 0;
          var c = document.createElement('div');
          c.id = id;
          c.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
          for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var dx = it.x + sx;
            var dy = it.y + sy;
            var b = document.createElement('div');
            b.style.cssText = 'position:absolute;left:' + dx + 'px;top:' + dy + 'px;width:' + it.width + 'px;height:' + it.height + 'px;border:2px solid rgba(255,0,0,0.8);box-sizing:border-box;pointer-events:none;';
            var l = document.createElement('div');
            l.textContent = String(it.number);
            var labelTop = dy < 14 ? '2px' : '-14px';
            l.style.cssText = 'position:absolute;top:' + labelTop + ';left:-2px;background:rgba(255,0,0,0.9);color:#fff;font:bold 11px/14px monospace;padding:0 4px;border-radius:2px;white-space:nowrap;';
            b.appendChild(l);
            c.appendChild(b);
          }
          document.documentElement.appendChild(c);
        })()`);
                overlayInjected = true;
            }
            // Build returned annotation metadata with image-relative coordinates.
            // Selector: shift to target-element-relative.
            // fullPage: convert to document-relative (matching fullPage image origin).
            // Default: viewport-relative (unchanged).
            if (targetBox) {
                const tb = targetBox;
                annotations = overlayItems.map((a) => ({
                    ...a,
                    box: {
                        x: a.box.x - tb.x,
                        y: a.box.y - tb.y,
                        width: a.box.width,
                        height: a.box.height,
                    },
                }));
            }
            else if (command.fullPage) {
                const scroll = (await page.evaluate(`({x: window.scrollX || 0, y: window.scrollY || 0})`));
                annotations = overlayItems.map((a) => ({
                    ...a,
                    box: {
                        x: a.box.x + scroll.x,
                        y: a.box.y + scroll.y,
                        width: a.box.width,
                        height: a.box.height,
                    },
                }));
            }
            else {
                annotations = overlayItems;
            }
        }
        await target.screenshot({ ...options, path: savePath });
        resizeScreenshotIfNeeded(savePath);
        if (overlayInjected) {
            await removeAnnotationOverlay(page);
        }
        return successResponse(command.id, {
            path: savePath,
            ...(annotations && annotations.length > 0 ? { annotations } : {}),
        });
    }
    catch (error) {
        if (overlayInjected) {
            await removeAnnotationOverlay(page);
        }
        if (command.selector) {
            throw toAIFriendlyError(error, command.selector);
        }
        throw error;
    }
}
async function handleSnapshot(command, browser) {
    // Use enhanced snapshot with refs and optional filtering
    const prior = snapshotBaselines.get(browser);
    const options = await snapshotOptionsForCommand(command, browser, prior);
    const snapshot = await browser.getSnapshot(options);
    const { tree, refs, refLineIndexes } = snapshot;
    snapshotBaselines.set(browser, {
        tree: tree || 'Empty page',
        signature: snapshotSurfaceSignature(browser, options, snapshot.scope),
        scopeCapability: snapshotScopeCapability(command, browser, snapshot),
    });
    // Simplify refs for output (just role and name)
    const simpleRefs = {};
    for (const [ref, data] of Object.entries(refs)) {
        simpleRefs[ref] = { role: data.role, name: data.name };
    }
    const response = boundedSnapshotResponse(command, tree, simpleRefs, refLineIndexes);
    if (response.data?.truncated) {
        const retained = new Set(Object.keys(response.data.refs ?? {}));
        retainBrowserRefs(browser, refs, retained);
    }
    return response;
}
async function handleEvaluate(command, browser) {
    const page = browser.getPage();
    // Evaluate the script directly as a string expression
    const result = await page.evaluate(command.script);
    return boundedJsonResponse(command, { result }, 'result');
}
async function handleWait(command, browser) {
    const page = browser.getPage();
    if (command.selector) {
        await page.waitForSelector(command.selector, {
            state: command.state ?? 'visible',
            timeout: command.timeout,
        });
    }
    else if (command.timeout) {
        await page.waitForTimeout(command.timeout);
    }
    else {
        // Default: wait for load state
        await page.waitForLoadState('load');
    }
    return successResponse(command.id, { waited: true });
}
async function handleScroll(command, browser) {
    const page = browser.getPage();
    if (command.selector) {
        const element = browser.getLocator(command.selector);
        await element.scrollIntoViewIfNeeded();
        if (command.x !== undefined || command.y !== undefined) {
            await element.evaluate((el, { x, y }) => {
                el.scrollBy(x ?? 0, y ?? 0);
            }, { x: command.x, y: command.y });
        }
    }
    else {
        // Scroll the page
        let deltaX = command.x ?? 0;
        let deltaY = command.y ?? 0;
        if (command.direction) {
            const amount = command.amount ?? 100;
            switch (command.direction) {
                case 'up':
                    deltaY = -amount;
                    break;
                case 'down':
                    deltaY = amount;
                    break;
                case 'left':
                    deltaX = -amount;
                    break;
                case 'right':
                    deltaX = amount;
                    break;
            }
        }
        await page.evaluate(`window.scrollBy(${deltaX}, ${deltaY})`);
    }
    return successResponse(command.id, { scrolled: true });
}
async function handleSelect(command, browser) {
    const locator = browser.getLocator(command.selector);
    const values = Array.isArray(command.values) ? command.values : [command.values];
    try {
        await locator.selectOption(values);
    }
    catch (error) {
        throw toAIFriendlyError(error, command.selector);
    }
    return successResponse(command.id, { selected: values });
}
async function handleHover(command, browser) {
    const locator = browser.getLocator(command.selector);
    try {
        await locator.hover();
    }
    catch (error) {
        throw toAIFriendlyError(error, command.selector);
    }
    return successResponse(command.id, { hovered: true });
}
async function handleContent(command, browser) {
    const page = browser.getPage();
    let html;
    if (command.selector) {
        html = await page.locator(command.selector).innerHTML();
    }
    else {
        html = await page.content();
    }
    return boundedTextResponse(command, { html }, 'html');
}
async function handleClose(command, browser) {
    await browser.close();
    return successResponse(command.id, { closed: true });
}
async function handleTabNew(command, browser) {
    const result = await browser.newTab();
    // Navigate to URL if provided (same pattern as handleNavigate)
    if (command.url) {
        const page = browser.getPage();
        await page.goto(command.url, { waitUntil: 'domcontentloaded' });
    }
    return successResponse(command.id, result);
}
async function handleTabList(command, browser) {
    const tabs = await browser.listTabs();
    return successResponse(command.id, {
        tabs,
        active: browser.getActiveIndex(),
    });
}
async function handleTabSwitch(command, browser) {
    const result = await browser.switchTo(command.index);
    const page = browser.getPage();
    return successResponse(command.id, {
        ...result,
        title: await page.title(),
    });
}
async function handleTabClose(command, browser) {
    const result = await browser.closeTab(command.index);
    return successResponse(command.id, result);
}
async function handleWindowNew(command, browser) {
    const result = await browser.newWindow(command.viewport);
    return successResponse(command.id, result);
}
// New handlers for enhanced browser API parity
async function handleFill(command, browser) {
    const locator = browser.getLocator(command.selector);
    try {
        await locator.fill(command.value);
    }
    catch (error) {
        throw toAIFriendlyError(error, command.selector);
    }
    return successResponse(command.id, { filled: true });
}
async function handleCheck(command, browser) {
    const locator = browser.getLocator(command.selector);
    try {
        await locator.check();
    }
    catch (error) {
        throw toAIFriendlyError(error, command.selector);
    }
    return successResponse(command.id, { checked: true });
}
async function handleUncheck(command, browser) {
    const locator = browser.getLocator(command.selector);
    try {
        await locator.uncheck();
    }
    catch (error) {
        throw toAIFriendlyError(error, command.selector);
    }
    return successResponse(command.id, { unchecked: true });
}
async function handleUpload(command, browser) {
    const locator = browser.getLocator(command.selector);
    const files = Array.isArray(command.files) ? command.files : [command.files];
    try {
        await locator.setInputFiles(files);
    }
    catch (error) {
        throw toAIFriendlyError(error, command.selector);
    }
    return successResponse(command.id, { uploaded: files });
}
async function handleDoubleClick(command, browser) {
    const locator = browser.getLocator(command.selector);
    try {
        await locator.dblclick();
    }
    catch (error) {
        throw toAIFriendlyError(error, command.selector);
    }
    return successResponse(command.id, { clicked: true });
}
async function handleFocus(command, browser) {
    const locator = browser.getLocator(command.selector);
    try {
        await locator.focus();
    }
    catch (error) {
        throw toAIFriendlyError(error, command.selector);
    }
    return successResponse(command.id, { focused: true });
}
async function handleDrag(command, browser) {
    const frame = browser.getFrame();
    await frame.dragAndDrop(command.source, command.target);
    return successResponse(command.id, { dragged: true });
}
async function handleFrame(command, browser) {
    await browser.switchToFrame({
        selector: command.selector,
        name: command.name,
        url: command.url,
    });
    return successResponse(command.id, { switched: true });
}
async function handleMainFrame(command, browser) {
    browser.switchToMainFrame();
    return successResponse(command.id, { switched: true });
}
async function handleGetByRole(command, browser) {
    const page = browser.getPage();
    const locator = page.getByRole(command.role, { name: command.name, exact: command.exact });
    switch (command.subaction) {
        case 'click':
            await locator.click();
            return successResponse(command.id, { clicked: true });
        case 'fill':
            await locator.fill(command.value ?? '');
            return successResponse(command.id, { filled: true });
        case 'check':
            await locator.check();
            return successResponse(command.id, { checked: true });
        case 'hover':
            await locator.hover();
            return successResponse(command.id, { hovered: true });
    }
}
async function handleGetByText(command, browser) {
    const page = browser.getPage();
    const locator = page.getByText(command.text, { exact: command.exact });
    switch (command.subaction) {
        case 'click':
            await locator.click();
            return successResponse(command.id, { clicked: true });
        case 'hover':
            await locator.hover();
            return successResponse(command.id, { hovered: true });
    }
}
async function handleGetByLabel(command, browser) {
    const page = browser.getPage();
    const locator = page.getByLabel(command.label, { exact: command.exact });
    switch (command.subaction) {
        case 'click':
            await locator.click();
            return successResponse(command.id, { clicked: true });
        case 'fill':
            await locator.fill(command.value ?? '');
            return successResponse(command.id, { filled: true });
        case 'check':
            await locator.check();
            return successResponse(command.id, { checked: true });
    }
}
async function handleGetByPlaceholder(command, browser) {
    const page = browser.getPage();
    const locator = page.getByPlaceholder(command.placeholder, { exact: command.exact });
    switch (command.subaction) {
        case 'click':
            await locator.click();
            return successResponse(command.id, { clicked: true });
        case 'fill':
            await locator.fill(command.value ?? '');
            return successResponse(command.id, { filled: true });
    }
}
async function handleCookiesGet(command, browser) {
    const page = browser.getPage();
    const context = page.context();
    const cookies = await context.cookies(command.urls);
    return successResponse(command.id, { cookies });
}
async function handleCookiesSet(command, browser) {
    const page = browser.getPage();
    const context = page.context();
    // Auto-fill URL for cookies that don't have domain/path/url set
    const pageUrl = page.url();
    const cookies = command.cookies.map((cookie) => {
        if (!cookie.url && !cookie.domain && !cookie.path) {
            return { ...cookie, url: pageUrl };
        }
        return cookie;
    });
    await context.addCookies(cookies);
    return successResponse(command.id, { set: true });
}
async function handleCookiesClear(command, browser) {
    const page = browser.getPage();
    const context = page.context();
    await context.clearCookies();
    return successResponse(command.id, { cleared: true });
}
async function handleStorageGet(command, browser) {
    const page = browser.getPage();
    const storageType = command.type === 'local' ? 'localStorage' : 'sessionStorage';
    if (command.key) {
        const value = await page.evaluate(`${storageType}.getItem(${JSON.stringify(command.key)})`);
        return successResponse(command.id, { key: command.key, value });
    }
    else {
        const data = await page.evaluate(`
      (() => {
        const storage = ${storageType};
        const result = {};
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key) result[key] = storage.getItem(key);
        }
        return result;
      })()
    `);
        return successResponse(command.id, { data });
    }
}
async function handleStorageSet(command, browser) {
    const page = browser.getPage();
    const storageType = command.type === 'local' ? 'localStorage' : 'sessionStorage';
    await page.evaluate(`${storageType}.setItem(${JSON.stringify(command.key)}, ${JSON.stringify(command.value)})`);
    return successResponse(command.id, { set: true });
}
async function handleStorageClear(command, browser) {
    const page = browser.getPage();
    const storageType = command.type === 'local' ? 'localStorage' : 'sessionStorage';
    await page.evaluate(`${storageType}.clear()`);
    return successResponse(command.id, { cleared: true });
}
async function handleDialog(command, browser) {
    browser.setDialogHandler(command.response, command.promptText);
    return successResponse(command.id, { handler: 'set', response: command.response });
}
async function handlePdf(command, browser) {
    const page = browser.getPage();
    await page.pdf({
        path: command.path,
        format: command.format ?? 'Letter',
    });
    return successResponse(command.id, { path: command.path });
}
// Network & Request handlers
async function handleRoute(command, browser) {
    await browser.addRoute(command.url, {
        response: command.response,
        abort: command.abort,
    });
    return successResponse(command.id, { routed: command.url });
}
async function handleUnroute(command, browser) {
    await browser.removeRoute(command.url);
    return successResponse(command.id, { unrouted: command.url ?? 'all' });
}
async function handleRequests(command, browser) {
    if (command.clear) {
        browser.clearRequests();
        return successResponse(command.id, { cleared: true });
    }
    // Start tracking if not already
    browser.startRequestTracking();
    const requests = browser.getRequests(command.filter);
    return boundedArrayResponse(command, { requests }, 'requests', (marker) => ({
        requestId: 'truncated',
        method: '…',
        url: marker,
        resourceType: 'metadata',
    }));
}
async function handleDownload(command, browser) {
    const page = browser.getPage();
    const locator = browser.getLocator(command.selector);
    const [download] = await Promise.all([page.waitForEvent('download'), locator.click()]);
    await download.saveAs(command.path);
    return successResponse(command.id, {
        path: command.path,
        suggestedFilename: download.suggestedFilename(),
    });
}
async function handleGeolocation(command, browser) {
    await browser.setGeolocation(command.latitude, command.longitude, command.accuracy);
    return successResponse(command.id, {
        latitude: command.latitude,
        longitude: command.longitude,
    });
}
async function handlePermissions(command, browser) {
    await browser.setPermissions(command.permissions, command.grant);
    return successResponse(command.id, {
        permissions: command.permissions,
        granted: command.grant,
    });
}
async function handleViewport(command, browser) {
    await browser.setViewport(command.width, command.height);
    return successResponse(command.id, {
        width: command.width,
        height: command.height,
    });
}
async function handleUserAgent(command, browser) {
    const page = browser.getPage();
    const context = page.context();
    // Note: Can't change user agent after context is created, but we can for new pages
    return successResponse(command.id, {
        note: 'User agent can only be set at launch time. Use device command instead.',
    });
}
async function handleDevice(command, browser) {
    const device = browser.getDevice(command.device);
    if (!device) {
        const available = browser.listDevices().slice(0, 10).join(', ');
        throw new Error(`Unknown device: ${command.device}. Available: ${available}...`);
    }
    // Apply device viewport
    await browser.setViewport(device.viewport.width, device.viewport.height);
    // Apply or clear device scale factor
    if (device.deviceScaleFactor && device.deviceScaleFactor !== 1) {
        // Apply device scale factor for HiDPI/retina displays
        await browser.setDeviceScaleFactor(device.deviceScaleFactor, device.viewport.width, device.viewport.height, device.isMobile ?? false);
    }
    else {
        // Clear device scale factor override to restore default (1x)
        try {
            await browser.clearDeviceMetricsOverride();
        }
        catch {
            // Ignore error if override was never set
        }
    }
    return successResponse(command.id, {
        device: command.device,
        viewport: device.viewport,
        userAgent: device.userAgent,
        deviceScaleFactor: device.deviceScaleFactor,
    });
}
async function handleBack(command, browser) {
    const page = browser.getPage();
    await page.goBack();
    return successResponse(command.id, { url: page.url() });
}
async function handleForward(command, browser) {
    const page = browser.getPage();
    await page.goForward();
    return successResponse(command.id, { url: page.url() });
}
async function handleReload(command, browser) {
    const page = browser.getPage();
    await page.reload();
    return successResponse(command.id, { url: page.url() });
}
async function handleUrl(command, browser) {
    const page = browser.getPage();
    return successResponse(command.id, { url: page.url() });
}
async function handleTitle(command, browser) {
    const page = browser.getPage();
    const title = await page.title();
    return successResponse(command.id, { title });
}
async function handleGetAttribute(command, browser) {
    const locator = browser.getLocator(command.selector);
    const value = await locator.getAttribute(command.attribute);
    return successResponse(command.id, { attribute: command.attribute, value });
}
async function handleGetText(command, browser) {
    const locator = browser.getLocator(command.selector);
    const text = await locator.textContent();
    return boundedTextResponse(command, { text }, 'text');
}
async function handleIsVisible(command, browser) {
    const locator = browser.getLocator(command.selector);
    const visible = await locator.isVisible();
    return successResponse(command.id, { visible });
}
async function handleIsEnabled(command, browser) {
    const locator = browser.getLocator(command.selector);
    const enabled = await locator.isEnabled();
    return successResponse(command.id, { enabled });
}
async function handleIsChecked(command, browser) {
    const locator = browser.getLocator(command.selector);
    const checked = await locator.isChecked();
    return successResponse(command.id, { checked });
}
async function handleCount(command, browser) {
    const page = browser.getPage();
    const count = await page.locator(command.selector).count();
    return successResponse(command.id, { count });
}
async function handleBoundingBox(command, browser) {
    const page = browser.getPage();
    const box = await page.locator(command.selector).boundingBox();
    return successResponse(command.id, { box });
}
async function handleStyles(command, browser) {
    const page = browser.getPage();
    // Shared extraction logic as a string to be eval'd in browser context
    const extractStylesScript = `(function(el) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      text: el.innerText?.trim().slice(0, 80) || null,
      box: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
      styles: {
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        fontFamily: s.fontFamily.split(',')[0].trim().replace(/"/g, ''),
        color: s.color,
        backgroundColor: s.backgroundColor,
        borderRadius: s.borderRadius,
        border: s.border !== 'none' && s.borderWidth !== '0px' ? s.border : null,
        boxShadow: s.boxShadow !== 'none' ? s.boxShadow : null,
        padding: s.padding,
      },
    };
  })`;
    // Check if it's a ref - single element
    if (browser.isRef(command.selector)) {
        const locator = browser.getLocator(command.selector);
        const element = (await locator.evaluate((el, script) => {
            const fn = eval(script);
            return fn(el);
        }, extractStylesScript));
        return successResponse(command.id, { elements: [element] });
    }
    // CSS selector - can match multiple elements
    const elements = (await page.$$eval(command.selector, (els, script) => {
        const fn = eval(script);
        return els.map((el) => fn(el));
    }, extractStylesScript));
    return successResponse(command.id, { elements });
}
// Advanced handlers
async function handleVideoStart(command, browser) {
    // Video recording requires context-level setup at launch
    // For now, return a note about this limitation
    return successResponse(command.id, {
        note: 'Video recording must be enabled at browser launch. Use --video flag when starting.',
        path: command.path,
    });
}
async function handleVideoStop(command, browser) {
    const page = browser.getPage();
    const video = page.video();
    if (video) {
        const path = await video.path();
        return successResponse(command.id, { path });
    }
    return successResponse(command.id, { note: 'No video recording active' });
}
async function handleTraceStart(command, browser) {
    await browser.startTracing({
        screenshots: command.screenshots,
        snapshots: command.snapshots,
    });
    return successResponse(command.id, { started: true });
}
async function handleTraceStop(command, browser) {
    await browser.stopTracing(command.path);
    return successResponse(command.id, command.path ? { path: command.path } : { traceStopped: true });
}
async function handleProfilerStart(command, browser) {
    await browser.startProfiling({ categories: command.categories });
    return successResponse(command.id, { started: true });
}
async function handleProfilerStop(command, browser) {
    let outputPath = command.path;
    if (!outputPath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const random = Math.random().toString(36).substring(2, 8);
        const filename = `profile-${timestamp}-${random}.json`;
        const profileDir = path.join(getAppDir(), 'tmp', 'profiles');
        mkdirSync(profileDir, { recursive: true });
        outputPath = path.join(profileDir, filename);
    }
    const result = await browser.stopProfiling(outputPath);
    return successResponse(command.id, result);
}
async function handleHarStart(command, browser) {
    await browser.startHarRecording();
    browser.startRequestTracking();
    return successResponse(command.id, { started: true });
}
async function handleHarStop(command, browser) {
    // HAR recording is handled at context level
    // For now, we save tracked requests as a simplified HAR-like format
    const requests = browser.getRequests();
    return successResponse(command.id, {
        path: command.path,
        requestCount: requests.length,
    });
}
async function handleStateSave(command, browser) {
    await browser.saveStorageState(command.path);
    return successResponse(command.id, { path: command.path });
}
async function handleStateLoad(command, browser) {
    if (browser.isLaunched()) {
        return errorResponse(command.id, 'Cannot load state while browser is running. Close browser first, then relaunch with loaded state.');
    }
    if (!fs.existsSync(command.path)) {
        return errorResponse(command.id, `State file not found: ${command.path}`);
    }
    await browser.launch({
        id: command.id,
        action: 'launch',
        headless: true,
        autoStateFilePath: command.path,
    });
    return successResponse(command.id, {
        loaded: true,
        path: command.path,
    });
}
async function handleStateList(command) {
    const sessionsDir = getSessionsDir();
    const files = listStateFiles();
    if (files.length === 0) {
        return successResponse(command.id, { files: [], directory: sessionsDir });
    }
    const stateFiles = files
        .map((filename) => {
        const filepath = path.join(sessionsDir, filename);
        const stats = fs.statSync(filepath);
        let encrypted = false;
        try {
            const content = fs.readFileSync(filepath, 'utf-8');
            const parsed = JSON.parse(content);
            encrypted = isEncryptedPayload(parsed);
        }
        catch {
            // Ignore parse errors
        }
        return {
            filename,
            path: filepath,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            encrypted,
        };
    })
        .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    return successResponse(command.id, { files: stateFiles, directory: sessionsDir });
}
async function handleStateClear(command) {
    const sessionsDir = getSessionsDir();
    if (command.sessionName && !isValidSessionName(command.sessionName)) {
        return errorResponse(command.id, 'Invalid session name. Use only letters, numbers, dashes, and underscores.');
    }
    const files = listStateFiles();
    if (files.length === 0) {
        return successResponse(command.id, { cleared: 0, deleted: [] });
    }
    const deleted = [];
    if (command.all) {
        for (const file of files) {
            fs.unlinkSync(path.join(sessionsDir, file));
            deleted.push(file);
        }
    }
    else if (command.sessionName) {
        for (const file of files) {
            if (file.startsWith(`${command.sessionName}-`)) {
                fs.unlinkSync(path.join(sessionsDir, file));
                deleted.push(file);
            }
        }
    }
    return successResponse(command.id, { cleared: deleted.length, deleted });
}
async function handleStateShow(command) {
    const sessionsDir = getSessionsDir();
    const baseName = command.filename.replace(/\.json$/, '');
    if (!command.filename.endsWith('.json') || !isValidSessionName(baseName)) {
        return errorResponse(command.id, 'Invalid filename. Use only letters, numbers, dashes, and underscores (with .json extension).');
    }
    const filepath = path.join(sessionsDir, command.filename);
    if (!fs.existsSync(filepath)) {
        return errorResponse(command.id, `State file not found: ${command.filename}`);
    }
    try {
        const { data: state, wasEncrypted } = readStateFile(filepath);
        const stats = fs.statSync(filepath);
        const stateObj = state;
        const cookies = stateObj.cookies?.length || 0;
        const origins = stateObj.origins?.length || 0;
        const domains = [...new Set((stateObj.cookies || []).map((c) => c.domain))];
        return successResponse(command.id, {
            filename: command.filename,
            path: filepath,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            encrypted: wasEncrypted,
            summary: {
                cookies,
                origins,
                domains,
            },
            state,
        });
    }
    catch (e) {
        return errorResponse(command.id, `Failed to parse state file: ${e.message}`);
    }
}
async function handleStateClean(command) {
    const deleted = cleanupExpiredStates(command.days);
    const keptCount = listStateFiles().length;
    return successResponse(command.id, {
        cleaned: deleted.length,
        deleted,
        keptCount,
        days: command.days,
    });
}
async function handleStateRename(command) {
    const sessionsDir = getSessionsDir();
    if (!isValidSessionName(command.oldName) || !isValidSessionName(command.newName)) {
        return errorResponse(command.id, 'Invalid name. Use only letters, numbers, dashes, and underscores.');
    }
    const oldPath = path.join(sessionsDir, `${command.oldName}.json`);
    const newPath = path.join(sessionsDir, `${command.newName}.json`);
    if (!fs.existsSync(oldPath)) {
        return errorResponse(command.id, `State file not found: ${command.oldName}.json`);
    }
    if (fs.existsSync(newPath)) {
        return errorResponse(command.id, `Destination already exists: ${command.newName}.json`);
    }
    fs.renameSync(oldPath, newPath);
    return successResponse(command.id, {
        renamed: true,
        oldName: `${command.oldName}.json`,
        newName: `${command.newName}.json`,
        path: newPath,
    });
}
async function handleConsole(command, browser) {
    if (command.clear) {
        browser.clearConsoleMessages();
        return successResponse(command.id, { cleared: true });
    }
    const messages = browser.getConsoleMessages();
    return boundedArrayResponse(command, { messages }, 'messages', (marker) => ({ type: 'warning', text: marker }));
}
async function handleErrors(command, browser) {
    if (command.clear) {
        browser.clearPageErrors();
        return successResponse(command.id, { cleared: true });
    }
    const errors = browser.getPageErrors();
    return boundedArrayResponse(command, { errors }, 'errors', (marker) => ({ message: marker }));
}
async function handleKeyboard(command, browser) {
    const page = browser.getPage();
    await page.keyboard.press(command.keys);
    return successResponse(command.id, { pressed: command.keys });
}
async function handleWheel(command, browser) {
    const page = browser.getPage();
    if (command.selector) {
        const element = page.locator(command.selector);
        await element.hover();
    }
    await page.mouse.wheel(command.deltaX ?? 0, command.deltaY ?? 0);
    return successResponse(command.id, { scrolled: true });
}
async function handleTap(command, browser) {
    const page = browser.getPage();
    await page.tap(command.selector);
    return successResponse(command.id, { tapped: true });
}
async function handleClipboard(command, browser) {
    const page = browser.getPage();
    switch (command.operation) {
        case 'copy':
            await page.keyboard.press('Control+c');
            return successResponse(command.id, { copied: true });
        case 'paste':
            await page.keyboard.press('Control+v');
            return successResponse(command.id, { pasted: true });
        case 'read':
            const text = await page.evaluate('navigator.clipboard.readText()');
            return boundedTextResponse(command, { text }, 'text');
        default:
            return errorResponse(command.id, 'Unknown clipboard operation');
    }
}
async function handleHighlight(command, browser) {
    const page = browser.getPage();
    await page.locator(command.selector).highlight();
    return successResponse(command.id, { highlighted: true });
}
async function handleClear(command, browser) {
    const page = browser.getPage();
    await page.locator(command.selector).clear();
    return successResponse(command.id, { cleared: true });
}
async function handleSelectAll(command, browser) {
    const page = browser.getPage();
    await page.locator(command.selector).selectText();
    return successResponse(command.id, { selected: true });
}
async function handleInnerText(command, browser) {
    const page = browser.getPage();
    const text = await page.locator(command.selector).innerText();
    return boundedTextResponse(command, { text }, 'text');
}
async function handleInnerHtml(command, browser) {
    const page = browser.getPage();
    const html = await page.locator(command.selector).innerHTML();
    return boundedTextResponse(command, { html }, 'html');
}
async function handleInputValue(command, browser) {
    const locator = browser.getLocator(command.selector);
    const value = await locator.inputValue();
    return successResponse(command.id, { value });
}
async function handleSetValue(command, browser) {
    const page = browser.getPage();
    await page.locator(command.selector).fill(command.value);
    return successResponse(command.id, { set: true });
}
async function handleDispatch(command, browser) {
    const page = browser.getPage();
    await page.locator(command.selector).dispatchEvent(command.event, command.eventInit);
    return successResponse(command.id, { dispatched: command.event });
}
async function handleEvalHandle(command, browser) {
    const page = browser.getPage();
    const handle = await page.evaluateHandle(command.script);
    const result = await handle.jsonValue().catch(() => 'Handle (non-serializable)');
    return boundedJsonResponse(command, { result }, 'result');
}
async function handleExpose(command, browser) {
    const page = browser.getPage();
    await page.exposeFunction(command.name, () => {
        // Exposed function - can be extended
        return `Function ${command.name} called`;
    });
    return successResponse(command.id, { exposed: command.name });
}
async function handleAddScript(command, browser) {
    const page = browser.getPage();
    if (command.content) {
        await page.addScriptTag({ content: command.content });
    }
    else if (command.url) {
        await page.addScriptTag({ url: command.url });
    }
    return successResponse(command.id, { added: true });
}
async function handleAddStyle(command, browser) {
    const page = browser.getPage();
    if (command.content) {
        await page.addStyleTag({ content: command.content });
    }
    else if (command.url) {
        await page.addStyleTag({ url: command.url });
    }
    return successResponse(command.id, { added: true });
}
async function handleEmulateMedia(command, browser) {
    const page = browser.getPage();
    await page.emulateMedia({
        media: command.media,
        colorScheme: command.colorScheme,
        reducedMotion: command.reducedMotion,
        forcedColors: command.forcedColors,
    });
    return successResponse(command.id, { emulated: true });
}
async function handleOffline(command, browser) {
    await browser.setOffline(command.offline);
    return successResponse(command.id, { offline: command.offline });
}
async function handleHeaders(command, browser) {
    await browser.setExtraHeaders(command.headers);
    return successResponse(command.id, { set: true });
}
async function handlePause(command, browser) {
    const page = browser.getPage();
    await page.pause();
    return successResponse(command.id, { paused: true });
}
async function handleGetByAltText(command, browser) {
    const page = browser.getPage();
    const locator = page.getByAltText(command.text, { exact: command.exact });
    switch (command.subaction) {
        case 'click':
            await locator.click();
            return successResponse(command.id, { clicked: true });
        case 'hover':
            await locator.hover();
            return successResponse(command.id, { hovered: true });
    }
}
async function handleGetByTitle(command, browser) {
    const page = browser.getPage();
    const locator = page.getByTitle(command.text, { exact: command.exact });
    switch (command.subaction) {
        case 'click':
            await locator.click();
            return successResponse(command.id, { clicked: true });
        case 'hover':
            await locator.hover();
            return successResponse(command.id, { hovered: true });
    }
}
async function handleGetByTestId(command, browser) {
    const page = browser.getPage();
    const locator = page.getByTestId(command.testId);
    switch (command.subaction) {
        case 'click':
            await locator.click();
            return successResponse(command.id, { clicked: true });
        case 'fill':
            await locator.fill(command.value ?? '');
            return successResponse(command.id, { filled: true });
        case 'check':
            await locator.check();
            return successResponse(command.id, { checked: true });
        case 'hover':
            await locator.hover();
            return successResponse(command.id, { hovered: true });
    }
}
async function handleNth(command, browser) {
    const page = browser.getPage();
    const base = page.locator(command.selector);
    const locator = command.index === -1 ? base.last() : base.nth(command.index);
    switch (command.subaction) {
        case 'click':
            await locator.click();
            return successResponse(command.id, { clicked: true });
        case 'fill':
            await locator.fill(command.value ?? '');
            return successResponse(command.id, { filled: true });
        case 'check':
            await locator.check();
            return successResponse(command.id, { checked: true });
        case 'hover':
            await locator.hover();
            return successResponse(command.id, { hovered: true });
        case 'text':
            const text = await locator.textContent();
            return boundedTextResponse(command, { text }, 'text');
    }
}
async function handleWaitForUrl(command, browser) {
    const page = browser.getPage();
    await page.waitForURL(command.url, { timeout: command.timeout });
    return successResponse(command.id, { url: page.url() });
}
async function handleWaitForLoadState(command, browser) {
    const page = browser.getPage();
    await page.waitForLoadState(command.state, { timeout: command.timeout });
    return successResponse(command.id, { state: command.state });
}
async function handleSetContent(command, browser) {
    const page = browser.getPage();
    await page.setContent(command.html);
    return successResponse(command.id, { set: true });
}
async function handleTimezone(command, browser) {
    // Timezone must be set at context level before navigation
    // This is a limitation - it sets for the current context
    const page = browser.getPage();
    await page.context().setGeolocation({ latitude: 0, longitude: 0 }); // Trigger context awareness
    return successResponse(command.id, {
        note: 'Timezone must be set at browser launch. Use --timezone flag.',
        timezone: command.timezone,
    });
}
async function handleLocale(command, browser) {
    // Locale must be set at context creation
    return successResponse(command.id, {
        note: 'Locale must be set at browser launch. Use --locale flag.',
        locale: command.locale,
    });
}
async function handleCredentials(command, browser) {
    const context = browser.getPage().context();
    await context.setHTTPCredentials({
        username: command.username,
        password: command.password,
    });
    return successResponse(command.id, { set: true });
}
async function handleMouseMove(command, browser) {
    const page = browser.getPage();
    await page.mouse.move(command.x, command.y);
    return successResponse(command.id, { moved: true, x: command.x, y: command.y });
}
async function handleMouseDown(command, browser) {
    const page = browser.getPage();
    await page.mouse.down({ button: command.button ?? 'left' });
    return successResponse(command.id, { down: true });
}
async function handleMouseUp(command, browser) {
    const page = browser.getPage();
    await page.mouse.up({ button: command.button ?? 'left' });
    return successResponse(command.id, { up: true });
}
async function handleBringToFront(command, browser) {
    const page = browser.getPage();
    await page.bringToFront();
    return successResponse(command.id, { focused: true });
}
async function handleWaitForFunction(command, browser) {
    const page = browser.getPage();
    await page.waitForFunction(command.expression, { timeout: command.timeout });
    return successResponse(command.id, { waited: true });
}
async function handleScrollIntoView(command, browser) {
    await browser.getLocator(command.selector).scrollIntoViewIfNeeded();
    return successResponse(command.id, { scrolled: true });
}
async function handleAddInitScript(command, browser) {
    const context = browser.getPage().context();
    await context.addInitScript(command.script);
    return successResponse(command.id, { added: true });
}
async function handleKeyDown(command, browser) {
    const page = browser.getPage();
    await page.keyboard.down(command.key);
    return successResponse(command.id, { down: true, key: command.key });
}
async function handleKeyUp(command, browser) {
    const page = browser.getPage();
    await page.keyboard.up(command.key);
    return successResponse(command.id, { up: true, key: command.key });
}
async function handleInsertText(command, browser) {
    const page = browser.getPage();
    await page.keyboard.insertText(command.text);
    return successResponse(command.id, { inserted: true });
}
async function handleMultiSelect(command, browser) {
    const page = browser.getPage();
    const selected = await page.locator(command.selector).selectOption(command.values);
    return successResponse(command.id, { selected });
}
async function handleWaitForDownload(command, browser) {
    const page = browser.getPage();
    const download = await page.waitForEvent('download', { timeout: command.timeout });
    let filePath;
    if (command.path) {
        filePath = command.path;
        await download.saveAs(filePath);
    }
    else {
        filePath = (await download.path()) || download.suggestedFilename();
    }
    return successResponse(command.id, {
        path: filePath,
        filename: download.suggestedFilename(),
        url: download.url(),
    });
}
async function handleResponseBody(command, browser) {
    const page = browser.getPage();
    const response = await page.waitForResponse((resp) => resp.url().includes(command.url), {
        timeout: command.timeout,
    });
    const body = await response.text();
    let parsed = body;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        // Keep as string if not JSON
    }
    return successResponse(command.id, {
        url: response.url(),
        status: response.status(),
        body: parsed,
    });
}
// Screencast and input injection handlers
async function handleScreencastStart(command, browser) {
    if (!screencastFrameCallback) {
        throw new Error('Screencast frame callback not set. Start the streaming server first.');
    }
    await browser.startScreencast(screencastFrameCallback, {
        format: command.format,
        quality: command.quality,
        maxWidth: command.maxWidth,
        maxHeight: command.maxHeight,
        everyNthFrame: command.everyNthFrame,
    });
    return successResponse(command.id, {
        started: true,
        format: command.format ?? 'jpeg',
        quality: command.quality ?? 80,
    });
}
async function handleScreencastStop(command, browser) {
    await browser.stopScreencast();
    return successResponse(command.id, { stopped: true });
}
async function handleInputMouse(command, browser) {
    await browser.injectMouseEvent({
        type: command.type,
        x: command.x,
        y: command.y,
        button: command.button,
        clickCount: command.clickCount,
        deltaX: command.deltaX,
        deltaY: command.deltaY,
        modifiers: command.modifiers,
    });
    return successResponse(command.id, { injected: true });
}
async function handleInputKeyboard(command, browser) {
    await browser.injectKeyboardEvent({
        type: command.type,
        key: command.key,
        code: command.code,
        text: command.text,
        modifiers: command.modifiers,
    });
    return successResponse(command.id, { injected: true });
}
async function handleInputTouch(command, browser) {
    await browser.injectTouchEvent({
        type: command.type,
        touchPoints: command.touchPoints,
        modifiers: command.modifiers,
    });
    return successResponse(command.id, { injected: true });
}
// Recording handlers (not available in CDP mode)
async function handleRecordingStart(command, browser) {
    await browser.startRecording(command.path, command.url);
    return successResponse(command.id, {
        started: true,
        path: command.path,
    });
}
async function handleRecordingStop(command, browser) {
    const result = await browser.stopRecording();
    return successResponse(command.id, result);
}
async function handleRecordingRestart(command, browser) {
    const result = await browser.restartRecording(command.path, command.url);
    return successResponse(command.id, {
        started: true,
        path: command.path,
        previousPath: result.previousPath,
        stopped: result.stopped,
    });
}
// Diff handlers
async function handleDiffSnapshot(command, browser) {
    const prior = snapshotBaselines.get(browser);
    const options = await snapshotOptionsForCommand(command, browser, prior);
    let before = null;
    if (command.baseline !== undefined) {
        try {
            before = fs.readFileSync(command.baseline, 'utf-8');
        }
        catch {
            return errorResponse(command.id, `Cannot read baseline file: ${command.baseline}`);
        }
    }
    // Use BrowserManager.getSnapshot so the current ref map and diff refs have
    // one owner. Direct getEnhancedSnapshot left follow-up @refs stale.
    const snapshot = await browser.getSnapshot(options);
    const { tree } = snapshot;
    const after = tree || 'Empty page';
    const signature = snapshotSurfaceSignature(browser, options, snapshot.scope);
    if (!command.baseline && !command.resetBaseline && prior?.signature === signature) {
        before = prior.tree;
    }
    snapshotBaselines.set(browser, {
        tree: after,
        signature,
        scopeCapability: snapshotScopeCapability(command, browser, snapshot),
    });
    if (before === null) {
        const baselineReason = command.resetBaseline
            ? 'explicit_reset'
            : prior
                ? 'stale_surface'
                : 'missing_or_discarded';
        clearBrowserRefs(browser, snapshot.refs);
        return errorResponse(command.id, `Snapshot diff baseline reset (${baselineReason}); the current snapshot is now the baseline. Run diff snapshot again.`, {
            comparable: false,
            baselineReset: true,
            baselineReason,
        });
    }
    const result = diffSnapshots(before, after, {
        full: fullOutputRequested(command),
        compact: command.compact,
        maxLines: command.maxLines,
        contextLines: command.contextLines,
    });
    browser.setLastSnapshot(after);
    const response = boundedSnapshotDiffResponse(command, result);
    projectDiffRefs(browser, snapshot, result, response);
    return response;
}
async function handleDiffScreenshot(command, browser) {
    if (!fs.existsSync(command.baseline)) {
        return errorResponse(command.id, `Baseline file not found: ${command.baseline}`);
    }
    const page = browser.getPage();
    let screenshotBuffer;
    if (command.selector) {
        const locator = browser.getLocator(command.selector);
        screenshotBuffer = await locator.screenshot({ type: 'png' });
    }
    else {
        screenshotBuffer = await page.screenshot({ fullPage: command.fullPage, type: 'png' });
    }
    const baselineBuffer = fs.readFileSync(command.baseline);
    const ext = path.extname(command.baseline).toLowerCase();
    const baselineMime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    const result = await diffScreenshots(page.context(), baselineBuffer, screenshotBuffer, {
        threshold: command.threshold,
        outputPath: command.output,
        baselineMime,
    });
    return successResponse(command.id, result);
}
async function handleDiffUrl(command, browser) {
    const page = browser.getPage();
    const waitUntil = command.waitUntil ?? 'load';
    const snapshotOpts = {
        selector: command.selector,
        compact: command.compact,
        maxDepth: command.maxDepth,
    };
    // Capture state of url1
    await page.goto(command.url1, { waitUntil });
    const firstSnapshot = await browser.getSnapshot(snapshotOpts);
    const snapshot1 = firstSnapshot.tree || 'Empty page';
    let screenshot1;
    if (command.screenshot) {
        screenshot1 = await page.screenshot({ fullPage: command.fullPage, type: 'png' });
    }
    // Capture state of url2
    await page.goto(command.url2, { waitUntil });
    // BrowserManager owns the final ref map so refs rendered in the URL diff
    // resolve against url2 rather than an older snapshot.
    const secondSnapshot = await browser.getSnapshot(snapshotOpts);
    const snapshot2 = secondSnapshot.tree || 'Empty page';
    const snapshotDiff = diffSnapshots(snapshot1, snapshot2, {
        full: fullOutputRequested(command),
        compact: command.compact,
        maxLines: command.maxLines,
        contextLines: command.contextLines,
    });
    const result = { snapshot: snapshotDiff };
    if (command.screenshot && screenshot1) {
        const screenshot2 = await page.screenshot({ fullPage: command.fullPage, type: 'png' });
        result.screenshot = await diffScreenshots(page.context(), screenshot1, screenshot2, {});
    }
    const response = boundedNestedSnapshotDiffResponse(command, result);
    projectDiffRefs(browser, secondSnapshot, snapshotDiff, response);
    return response;
}
// ── Multi-Agent Coordination Handlers ──────────────────────────────
const SHARED_DIR = path.join(getAppDir(), 'shared');
const TASKS_FILE = path.join(getAppDir(), 'tasks.jsonl');
function getSessionName() {
    return process.env.AGENT_BROWSER_SESSION || 'default';
}
async function handleShare(command) {
    const sessionDir = path.join(SHARED_DIR, getSessionName());
    mkdirSync(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, `${command.key}.json`);
    const tmpPath = filePath + '.tmp';
    const data = JSON.stringify({ key: command.key, value: command.value, session: getSessionName(), timestamp: new Date().toISOString() });
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
    return successResponse(command.id, { key: command.key, session: getSessionName(), shared: true });
}
async function handleShared(command) {
    if (!fs.existsSync(SHARED_DIR)) {
        return successResponse(command.id, { entries: [] });
    }
    const entries = [];
    const sessions = fs.readdirSync(SHARED_DIR).filter(f => fs.statSync(path.join(SHARED_DIR, f)).isDirectory());
    for (const session of sessions) {
        const sessionDir = path.join(SHARED_DIR, session);
        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            const key = file.replace('.json', '');
            if (command.key && command.key !== key) continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf8'));
                entries.push(data);
            } catch { /* skip corrupt files */ }
        }
    }
    return successResponse(command.id, { entries });
}
function readTasks() {
    if (!fs.existsSync(TASKS_FILE)) return [];
    return fs.readFileSync(TASKS_FILE, 'utf8').trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
}
function writeTasks(tasks) {
    const tmpPath = TASKS_FILE + '.tmp';
    fs.writeFileSync(tmpPath, tasks.map(t => JSON.stringify(t)).join('\n') + '\n');
    fs.renameSync(tmpPath, TASKS_FILE);
}
async function handleTasksCreate(command) {
    mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
    const tasks = readTasks();
    const id = tasks.length;
    const task = { id, description: command.description, status: 'pending', session: getSessionName(), created: new Date().toISOString() };
    fs.appendFileSync(TASKS_FILE, JSON.stringify(task) + '\n');
    return successResponse(command.id, task);
}
async function handleTasksList(command) {
    return successResponse(command.id, { tasks: readTasks() });
}
async function handleTasksClaim(command) {
    const tasks = readTasks();
    const pending = tasks.find(t => t.status === 'pending');
    if (!pending) {
        return successResponse(command.id, { claimed: false, message: 'No pending tasks' });
    }
    pending.status = 'claimed';
    pending.claimedBy = getSessionName();
    pending.claimedAt = new Date().toISOString();
    writeTasks(tasks);
    return successResponse(command.id, { claimed: true, task: pending });
}
async function handleTasksComplete(command) {
    const tasks = readTasks();
    const task = tasks.find(t => t.id === command.taskId);
    if (!task) {
        return errorResponse(command.id, `Task ${command.taskId} not found`);
    }
    task.status = 'completed';
    task.result = command.result || '';
    task.completedBy = getSessionName();
    task.completedAt = new Date().toISOString();
    writeTasks(tasks);
    return successResponse(command.id, { task });
}
