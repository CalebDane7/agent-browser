/**
 * Enhanced snapshot with element refs for deterministic element selection.
 *
 * This module generates accessibility snapshots with embedded refs that can be
 * used to click/fill/interact with elements without re-querying the DOM.
 *
 * Example output:
 *   - heading "Example Domain" [ref=e1] [level=1]
 *   - paragraph: Some text content
 *   - button "Submit" [ref=e2]
 *   - textbox "Email" [ref=e3]
 *
 * Usage:
 *   agent-browser snapshot              # Full snapshot
 *   agent-browser snapshot -i           # Interactive elements only
 *   agent-browser snapshot --depth 3    # Limit depth
 *   agent-browser click @e2             # Click element by ref
 */
import { getAccessibilityTree, formatAccessibilityTree } from './cdp.js';
// Counter for generating refs
let refCounter = 0;
let scopedObjectGroupCounter = 0;
const MAX_CURSOR_REF_CANDIDATES = 1000;
/**
 * Reset the standalone ref counter. BrowserManager supplies an owner-scoped
 * allocator so production refs are never positionally reused for another node.
 */
export function resetRefs() {
    refCounter = 0;
}
/**
 * Generate next ref ID
 */
function nextRef() {
    return `e${++refCounter}`;
}
function allocateSnapshotRef(options, refs, backendNodeId) {
    const ref = typeof options.allocateRef === 'function'
        ? options.allocateRef({ backendNodeId, ...options.refOwner })
        : nextRef();
    if (typeof ref !== 'string' || !/^e[1-9]\d*$/.test(ref) || refs[ref]) {
        throw new Error('Snapshot ref allocator returned an invalid or duplicate ref');
    }
    return ref;
}
/**
 * Roles that are interactive and should get refs
 */
const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'treeitem',
]);
/**
 * Roles that provide structure/context (get refs for text extraction)
 */
const CONTENT_ROLES = new Set([
    'heading',
    'cell',
    'gridcell',
    'columnheader',
    'rowheader',
    'listitem',
    'article',
    'region',
    'main',
    'navigation',
]);
/**
 * Roles that are purely structural (can be filtered in compact mode)
 */
const STRUCTURAL_ROLES = new Set([
    'generic',
    'group',
    'list',
    'table',
    'row',
    'rowgroup',
    'grid',
    'treegrid',
    'menu',
    'menubar',
    'toolbar',
    'tablist',
    'tree',
    'directory',
    'document',
    'application',
    'presentation',
    'none',
]);
/**
 * Build a selector string for storing in ref map
 */
function buildSelector(role, name) {
    if (name) {
        const escapedName = JSON.stringify(name);
        return `getByRole('${role}', { name: ${escapedName}, exact: true })`;
    }
    return `getByRole('${role}')`;
}
function escapeSnapshotText(value) {
    return JSON.stringify(String(value)).slice(1, -1)
        .replaceAll('\u2028', '\\u2028')
        .replaceAll('\u2029', '\\u2029');
}
async function resolveSnapshotDocument(page) {
    try {
        const { root } = await page._client.send('DOM.getDocument', { depth: 0 }, page._sessionId);
        return Number.isInteger(root?.nodeId) && Number.isInteger(root?.backendNodeId)
            ? { nodeId: root.nodeId, backendNodeId: root.backendNodeId }
            : null;
    }
    catch {
        return null;
    }
}
function createRefOwner(page, documentBackendNodeId) {
    if (!page?._targetId || !page?._sessionId || !Number.isInteger(documentBackendNodeId)) {
        return null;
    }
    return {
        targetId: page._targetId,
        sessionId: page._sessionId,
        documentBackendNodeId,
    };
}
async function resolveCursorBackendNodeId(page, documentNodeId, selector) {
    try {
        const { nodeId } = await page._client.send('DOM.querySelector', {
            nodeId: documentNodeId,
            selector,
        }, page._sessionId);
        if (!Number.isInteger(nodeId) || nodeId <= 0)
            return null;
        const { node } = await page._client.send('DOM.describeNode', {
            nodeId,
            depth: 0,
        }, page._sessionId);
        return Number.isInteger(node?.backendNodeId) ? node.backendNodeId : null;
    }
    catch {
        return null;
    }
}
/**
 * Query the page for clickable elements that might not have proper ARIA roles.
 * This finds elements with cursor: pointer or onclick handlers.
 */
async function findCursorInteractiveElements(page, selector, scopeNodeId) {
    const rootSelector = selector || 'body';
    // Use a string function body to avoid TypeScript transpilation issues
    const scriptBody = `function(rootSel) {
    const results = [];

    // Elements that already have interactive ARIA roles - skip these
    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
      'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox',
      'slider', 'spinbutton', 'switch', 'tab', 'treeitem'
    ]);

    // Tags that are already interactive by default
    const interactiveTags = new Set([
      'a', 'button', 'input', 'select', 'textarea', 'details', 'summary'
    ]);

    const boundRoot = this && this.nodeType === 1 ? this : null;
    const root = boundRoot || (rootSel ? document.querySelector(rootSel) : document.body);
    if (!root) return results;
    const allElements = root.querySelectorAll('*');

    // Build a unique selector for an element
    const buildSelector = (el) => {
      const isUnique = (candidate) => {
        try {
          return document.querySelectorAll(candidate).length === 1;
        } catch (e) {
          return false;
        }
      };
      const testId = el.getAttribute('data-testid');
      if (testId) {
        const candidate = '[data-testid="' + CSS.escape(testId) + '"]';
        if (isUnique(candidate)) return candidate;
      }
      if (el.id) {
        const candidate = '#' + CSS.escape(el.id);
        if (isUnique(candidate)) return candidate;
      }

      const path = [];
      let current = el;
      while (current && current !== document.body) {
        let sel = current.tagName.toLowerCase();
        const classes = Array.from(current.classList).filter(c => c.trim());
        if (classes.length > 0) sel += '.' + CSS.escape(classes[0]);

        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const matching = siblings.filter(s => {
            if (s.tagName !== current.tagName) return false;
            if (classes.length > 0 && !s.classList.contains(classes[0])) return false;
            return true;
          });
          if (matching.length > 1) {
            const idx = matching.indexOf(current) + 1;
            sel += ':nth-of-type(' + idx + ')';
          }
        }
        path.unshift(sel);
        current = current.parentElement;
        // Stop once the selector uniquely identifies the element (max 10 levels)
        if (path.length >= 1) {
          if (isUnique(path.join(' > '))) break;
        }
        if (path.length >= 10) break;
      }
      const candidate = path.join(' > ');
      return isUnique(candidate) ? candidate : null;
    };

    for (const el of allElements) {
      const tagName = el.tagName.toLowerCase();
      if (interactiveTags.has(tagName)) continue;

      const role = el.getAttribute('role');
      if (role && interactiveRoles.has(role.toLowerCase())) continue;

      const computedStyle = getComputedStyle(el);
      const hasCursorPointer = computedStyle.cursor === 'pointer';
      const hasOnClick = el.hasAttribute('onclick') || el.onclick !== null;
      const tabIndex = el.getAttribute('tabindex');
      const hasTabIndex = tabIndex !== null && tabIndex !== '-1';

      if (!hasCursorPointer && !hasOnClick && !hasTabIndex) continue;

      // Skip elements that only inherit cursor:pointer from an ancestor
      // (the ancestor itself will be captured instead)
      if (hasCursorPointer && !hasOnClick && !hasTabIndex) {
        const parent = el.parentElement;
        if (parent && getComputedStyle(parent).cursor === 'pointer') continue;
      }

      const text = (el.textContent || '').trim().slice(0, 100);
      if (!text) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const selector = buildSelector(el);
      if (!selector) continue;
      let depth = 0;
      let ancestor = el;
      while (ancestor && ancestor !== root) {
        depth++;
        ancestor = ancestor.parentElement;
      }
      if (ancestor !== root) continue;
      results.push({
        selector,
        text,
        tagName,
        depth,
        hasOnClick,
        hasCursorPointer,
        hasTabIndex
      });
    }
    return results;
  }`;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('return ' + scriptBody)();
    if (scopeNodeId !== undefined) {
        const sessionId = page._sessionId;
        const objectGroup = `agent-browser-scoped-snapshot-${++scopedObjectGroupCounter}`;
        try {
            const { object } = await page._client.send('DOM.resolveNode', {
                nodeId: scopeNodeId,
                objectGroup,
            }, sessionId);
            if (!object?.objectId) {
                throw new Error(`Could not resolve scoped snapshot node ${scopeNodeId}`);
            }
            const { result, exceptionDetails } = await page._client.send('Runtime.callFunctionOn', {
                objectId: object.objectId,
                functionDeclaration: fn.toString(),
                arguments: [{ value: null }],
                returnByValue: true,
                awaitPromise: true,
            }, sessionId);
            if (exceptionDetails) {
                throw new Error(`Scoped cursor snapshot failed: ${exceptionDetails.text ?? 'unknown error'}`);
            }
            return result?.value ?? [];
        }
        finally {
            await page._client.send('Runtime.releaseObjectGroup', { objectGroup }, sessionId).catch(() => { });
        }
    }
    return page.evaluate(fn, rootSelector);
}

function collectDomBackendNodeIds(node, ids) {
    if (!node || typeof node !== 'object')
        return;
    if (Number.isInteger(node.backendNodeId)) {
        ids.add(node.backendNodeId);
    }
    for (const key of ['children', 'shadowRoots', 'pseudoElements']) {
        for (const child of node[key] ?? []) {
            collectDomBackendNodeIds(child, ids);
        }
    }
    if (node.contentDocument) {
        collectDomBackendNodeIds(node.contentDocument, ids);
    }
}

async function resolveScopeBackendNodeIds(page, selector, scopeNodeId) {
    const sessionId = page._sessionId;
    let nodeId = scopeNodeId;
    const { root } = await page._client.send('DOM.getDocument', { depth: 0 }, sessionId);
    if (nodeId === undefined) {
        const query = await page._client.send('DOM.querySelector', {
            nodeId: root.nodeId,
            selector,
        }, sessionId);
        nodeId = query.nodeId;
    }
    if (!nodeId) {
        throw new Error(`Selector "${selector}" did not match any element`);
    }
    const { node } = await page._client.send('DOM.describeNode', {
        nodeId,
        depth: -1,
        pierce: true,
    }, sessionId);
    const backendNodeIds = new Set();
    collectDomBackendNodeIds(node, backendNodeIds);
    if (backendNodeIds.size === 0) {
        throw new Error(`Could not resolve DOM subtree for selector "${selector}"`);
    }
    return {
        backendNodeIds,
        nodeId,
        backendNodeId: Number.isInteger(node.backendNodeId) ? node.backendNodeId : null,
        documentNodeId: Number.isInteger(root.nodeId) ? root.nodeId : null,
        documentBackendNodeId: Number.isInteger(root.backendNodeId) ? root.backendNodeId : null,
    };
}

/**
 * Adapted and materially changed from vercel-labs/agent-browser
 * 021d9255:cli/src/native/snapshot.rs (Apache-2.0). Restrict a full AX tree to nodes owned by one DOM subtree. A synthetic root
 * preserves the formatter contract without retaining out-of-scope ancestors.
 * Exported so deterministic fixtures can prove that scoping never widens.
 */
function scopeAccessibilityNodes(nodes, backendNodeIds) {
    if (!backendNodeIds)
        return nodes;
    if (!nodes?.length || backendNodeIds.size === 0)
        return [];
    const nodeMap = new Map(nodes.map((node) => [node.nodeId, node]));
    const parentById = new Map();
    for (const node of nodes) {
        for (const childId of node.childIds ?? []) {
            parentById.set(childId, node.nodeId);
        }
    }
    const included = new Set();
    for (const node of nodes) {
        if (Number.isInteger(node.backendDOMNodeId) && backendNodeIds.has(node.backendDOMNodeId)) {
            included.add(node.nodeId);
        }
    }
    // Preserve AX-only bridge/text nodes only when their AX parent is already
    // proven inside the DOM subtree. Nodes with an out-of-scope backend ID stay out.
    let changed = true;
    while (changed) {
        changed = false;
        for (const node of nodes) {
            if (included.has(node.nodeId) || Number.isInteger(node.backendDOMNodeId))
                continue;
            const parentId = parentById.get(node.nodeId);
            if (parentId !== undefined && included.has(parentId)) {
                included.add(node.nodeId);
                changed = true;
            }
        }
    }
    if (included.size === 0)
        return [];
    const roots = [];
    for (const node of nodes) {
        if (!included.has(node.nodeId))
            continue;
        const parentId = parentById.get(node.nodeId);
        if (parentId === undefined || !included.has(parentId)) {
            roots.push(node.nodeId);
        }
    }
    const scopedNodes = nodes
        .filter((node) => included.has(node.nodeId))
        .map((node) => ({
        ...node,
        ...(node.childIds ? { childIds: node.childIds.filter((id) => included.has(id)) } : {}),
    }));
    const syntheticRootId = '__agent_browser_scoped_root__';
    if (nodeMap.has(syntheticRootId)) {
        throw new Error('Unexpected AX node id collision while scoping snapshot');
    }
    return [{
            nodeId: syntheticRootId,
            ignored: false,
            role: { type: 'internalRole', value: 'RootWebArea' },
            name: { type: 'computedString', value: '' },
            properties: [],
            childIds: roots,
        }, ...scopedNodes];
}

function refTrackerKey(role, name) {
    return `${role.toLowerCase()}:${name ?? ''}`;
}

/**
 * BrowserManager resolves role refs against the full AX tree. A scoped snapshot
 * therefore has to retain each included node's full-tree ordinal; re-numbering
 * only the visible subtree could make @refs resolve to an equal role/name outside
 * the requested scope.
 */
function buildSnapshotRefProvenance(fullNodes) {
    const roleTotals = new Map();
    const namedTotals = new Map();
    for (const node of fullNodes) {
        if (!node.backendDOMNodeId)
            continue;
        const role = (node.role?.value ?? '').toLowerCase();
        if (!role)
            continue;
        roleTotals.set(role, (roleTotals.get(role) ?? 0) + 1);
        const name = node.name?.value ?? '';
        if (name) {
            const key = refTrackerKey(role, name);
            namedTotals.set(key, (namedTotals.get(key) ?? 0) + 1);
        }
    }
    const roleSeen = new Map();
    const namedSeen = new Map();
    const provenanceByNodeId = new Map();
    for (const node of fullNodes) {
        if (!node.backendDOMNodeId)
            continue;
        const role = (node.role?.value ?? '').toLowerCase();
        if (!role)
            continue;
        const name = node.name?.value ?? '';
        let nth;
        let total;
        if (name) {
            const key = refTrackerKey(role, name);
            nth = namedSeen.get(key) ?? 0;
            namedSeen.set(key, nth + 1);
            total = namedTotals.get(key) ?? 1;
        }
        else {
            nth = roleSeen.get(role) ?? 0;
            total = roleTotals.get(role) ?? 1;
        }
        provenanceByNodeId.set(node.nodeId, {
            resolvable: true,
            nth,
            preserveNth: total > 1,
            backendNodeId: node.backendDOMNodeId,
        });
        roleSeen.set(role, (roleSeen.get(role) ?? 0) + 1);
    }
    return provenanceByNodeId;
}
/**
 * Get enhanced snapshot with refs and optional filtering
 */
export async function getEnhancedSnapshot(page, options = {}) {
    if (typeof options.allocateRef !== 'function') {
        resetRefs();
    }
    const refs = {};
    const scope = options.selector || options.scopeNodeId !== undefined
        ? await resolveScopeBackendNodeIds(page, options.selector, options.scopeNodeId)
        : null;
    const resolvedDocument = Number.isInteger(scope?.documentNodeId) &&
        Number.isInteger(scope?.documentBackendNodeId)
        ? { nodeId: scope.documentNodeId, backendNodeId: scope.documentBackendNodeId }
        : await resolveSnapshotDocument(page);
    const documentNodeId = resolvedDocument?.nodeId ?? null;
    const documentBackendNodeId = resolvedDocument?.backendNodeId ?? null;
    const refOwner = createRefOwner(page, documentBackendNodeId);
    // Get accessibility tree via raw CDP
    const fullAxNodes = await getAccessibilityTree(page._client, { sessionId: page._sessionId });
    const axNodes = scopeAccessibilityNodes(fullAxNodes, scope?.backendNodeIds ?? null);
    const formatted = formatAccessibilityTree(axNodes, { structured: true });
    if (!formatted.tree) {
        return {
            tree: '(empty)',
            refs: {},
            refLineIndexes: {},
            ...(scope ? {
                scope: {
                    nodeId: scope.nodeId,
                    backendNodeId: scope.backendNodeId,
                    documentBackendNodeId,
                },
            } : {}),
        };
    }
    // Ref identity and rendered-line provenance come from the AX nodes that
    // generated each annotation. Page text is untrusted and must never be parsed
    // to decide which refs remain actionable after output projection.
    const processingOptions = {
        ...options,
        refProvenanceByNodeId: refOwner ? buildSnapshotRefProvenance(fullAxNodes) : new Map(),
        refOwner,
    };
    const processed = processAriaTree(formatted.lines, refs, processingOptions);
    const enhancedTree = processed.tree;
    // When cursor flag is set, also find cursor-interactive elements
    // that may not have proper ARIA roles
    if (options.cursor) {
        const cursorElements = await findCursorInteractiveElements(page, options.selector, scope?.nodeId);
        // Filter out elements whose text is already captured in the snapshot
        const existingTexts = new Set(Object.values(refs).map((r) => r.name?.toLowerCase()));
        // Structural AX records keep page-controlled quotes/newlines inert.
        for (const line of formatted.lines) {
            if (line.kind === 'node' && line.name) {
                existingTexts.add(line.name.toLowerCase());
            }
        }
        const additionalLines = [];
        let cursorRefCandidates = 0;
        for (const el of cursorElements) {
            // Cursor candidates come from a separate DOM traversal. Enforce the
            // same public depth bound before text de-duplication or ref allocation;
            // missing/untrusted depth metadata fails closed when a bound exists.
            if (options.maxDepth !== undefined &&
                (!Number.isInteger(el.depth) || el.depth > options.maxDepth)) {
                continue;
            }
            const elTextLower = el.text.toLowerCase();
            // Skip if text already captured in the ARIA tree
            if (existingTexts.has(elTextLower))
                continue;
            existingTexts.add(elTextLower);
            const role = el.hasCursorPointer || el.hasOnClick ? 'clickable' : 'focusable';
            // Build description of why it's interactive
            const hints = [];
            if (el.hasCursorPointer)
                hints.push('cursor:pointer');
            if (el.hasOnClick)
                hints.push('onclick');
            if (el.hasTabIndex)
                hints.push('tabindex');
            const cursorBackendNodeId = refOwner && Number.isInteger(documentNodeId) &&
                cursorRefCandidates++ < MAX_CURSOR_REF_CANDIDATES
                ? await resolveCursorBackendNodeId(page, documentNodeId, el.selector)
                : null;
            if (refOwner && Number.isInteger(cursorBackendNodeId)) {
                const ref = allocateSnapshotRef(options, refs, cursorBackendNodeId);
                refs[ref] = {
                    selector: el.selector,
                    role: role,
                    name: el.text,
                    backendNodeId: cursorBackendNodeId,
                    ...refOwner,
                };
                additionalLines.push({
                    text: `- ${role} "${escapeSnapshotText(el.text)}" [ref=${ref}] [${hints.join(', ')}]`,
                    ref,
                });
            }
            else {
                additionalLines.push({
                    text: `- ${role} "${escapeSnapshotText(el.text)}" [${hints.join(', ')}]`,
                });
            }
        }
        if (additionalLines.length > 0) {
            const outputLines = enhancedTree === '(no interactive elements)'
                ? []
                : enhancedTree.split('\n');
            const refLineIndexes = enhancedTree === '(no interactive elements)'
                ? {}
                : { ...processed.refLineIndexes };
            if (outputLines.length > 0) {
                outputLines.push('# Cursor-interactive elements:');
            }
            for (const entry of additionalLines) {
                if (entry.ref)
                    refLineIndexes[entry.ref] = outputLines.length;
                outputLines.push(entry.text);
            }
            return {
                tree: outputLines.join('\n'),
                refs,
                refLineIndexes,
                ...(scope ? {
                    scope: {
                        nodeId: scope.nodeId,
                        backendNodeId: scope.backendNodeId,
                        documentBackendNodeId,
                    },
                } : {}),
            };
        }
    }
    return {
        tree: enhancedTree,
        refs,
        refLineIndexes: processed.refLineIndexes,
        ...(scope ? {
            scope: {
                nodeId: scope.nodeId,
                backendNodeId: scope.backendNodeId,
                documentBackendNodeId,
            },
        } : {}),
    };
}
function createRoleNameTracker(refProvenanceByNodeId) {
    const counts = new Map();
    const refsByKey = new Map();
    const preserveNthKeys = new Set();
    return {
        counts,
        refsByKey,
        getKey(role, name) {
            return `${role}:${name ?? ''}`;
        },
        getNextOrdinal(role, name, nodeId) {
            const key = this.getKey(role, name);
            const current = counts.get(key) ?? 0;
            counts.set(key, current + 1);
            if (refProvenanceByNodeId) {
                const ordinal = refProvenanceByNodeId.get(nodeId);
                return ordinal ?? { resolvable: false, nth: current, preserveNth: false };
            }
            return { resolvable: true, nth: current, preserveNth: false };
        },
        trackRef(role, name, ref, preserveNth = false) {
            const key = this.getKey(role, name);
            const refs = refsByKey.get(key) ?? [];
            refs.push(ref);
            refsByKey.set(key, refs);
            if (preserveNth) {
                preserveNthKeys.add(key);
            }
        },
        getDuplicateKeys() {
            const duplicates = new Set();
            for (const [key, refs] of refsByKey) {
                if (refs.length > 1) {
                    duplicates.add(key);
                }
            }
            return duplicates;
        },
        shouldPreserveNth(role, name) {
            return preserveNthKeys.has(this.getKey(role, name));
        },
    };
}
/**
 * Process ARIA snapshot: add refs and apply filters
 */
function processAriaTree(lines, refs, options) {
    const result = [];
    const tracker = createRoleNameTracker(options.refProvenanceByNodeId);
    // For interactive-only mode, we collect just interactive elements
    if (options.interactive) {
        for (const line of lines) {
            if (line.kind !== 'node')
                continue;
            if (options.maxDepth !== undefined && line.depth > options.maxDepth)
                continue;
            const role = line.role;
            const name = line.name;
            const roleLower = role.toLowerCase();
            if (INTERACTIVE_ROLES.has(roleLower)) {
                const ordinal = tracker.getNextOrdinal(roleLower, name, line.nodeId);
                if (!ordinal.resolvable) {
                    result.push({ text: line.text });
                    continue;
                }
                const ref = allocateSnapshotRef(options, refs, ordinal.backendNodeId);
                const nth = ordinal.nth;
                tracker.trackRef(roleLower, name, ref, ordinal.preserveNth);
                refs[ref] = {
                    selector: buildSelector(roleLower, name),
                    role: roleLower,
                    name,
                    nth, // Always store nth, we'll use it for duplicates
                    backendNodeId: ordinal.backendNodeId,
                    ...options.refOwner,
                };
                let enhanced = `${line.head} [ref=${ref}]`;
                // Only show nth in output if it's > 0 (for readability)
                if (nth > 0)
                    enhanced += ` [nth=${nth}]`;
                enhanced += line.suffix;
                result.push({ text: enhanced, ref });
            }
        }
        // Post-process: remove nth from refs that don't have duplicates
        removeNthFromNonDuplicates(refs, tracker);
        if (result.length === 0) {
            return { tree: '(no interactive elements)', refLineIndexes: {} };
        }
        return renderSnapshotEntries(result);
    }
    // Normal processing with depth/compact filters
    for (const line of lines) {
        if (options.maxDepth !== undefined && line.depth > options.maxDepth)
            continue;
        if (line.kind !== 'node') {
            result.push({ text: line.text });
            continue;
        }
        const roleLower = line.role.toLowerCase();
        const isInteractive = INTERACTIVE_ROLES.has(roleLower);
        const isContent = CONTENT_ROLES.has(roleLower);
        const isStructural = STRUCTURAL_ROLES.has(roleLower);
        if (options.compact && isStructural && !line.name)
            continue;
        const shouldHaveRef = isInteractive || (isContent && line.name);
        if (!shouldHaveRef) {
            result.push({ text: line.text });
            continue;
        }
        const ordinal = tracker.getNextOrdinal(roleLower, line.name, line.nodeId);
        if (!ordinal.resolvable) {
            result.push({ text: line.text });
            continue;
        }
        const ref = allocateSnapshotRef(options, refs, ordinal.backendNodeId);
        const nth = ordinal.nth;
        tracker.trackRef(roleLower, line.name, ref, ordinal.preserveNth);
        refs[ref] = {
            selector: buildSelector(roleLower, line.name),
            role: roleLower,
            name: line.name,
            nth,
            backendNodeId: ordinal.backendNodeId,
            ...options.refOwner,
        };
        let enhanced = `${line.head} [ref=${ref}]`;
        if (nth > 0)
            enhanced += ` [nth=${nth}]`;
        enhanced += line.suffix;
        result.push({ text: enhanced, ref });
    }
    // Post-process: remove nth from refs that don't have duplicates
    removeNthFromNonDuplicates(refs, tracker);
    // If compact mode, remove empty structural elements
    return renderSnapshotEntries(options.compact ? compactTree(result) : result);
}
function renderSnapshotEntries(entries) {
    const refLineIndexes = {};
    for (let index = 0; index < entries.length; index++) {
        if (entries[index].ref) {
            refLineIndexes[entries[index].ref] = index;
        }
    }
    return {
        tree: entries.map((entry) => entry.text).join('\n'),
        refLineIndexes,
    };
}
/**
 * Remove nth from refs that ended up not having duplicates
 * This keeps single-element locators simple (no unnecessary .nth(0))
 */
function removeNthFromNonDuplicates(refs, tracker) {
    const duplicateKeys = tracker.getDuplicateKeys();
    for (const [ref, data] of Object.entries(refs)) {
        const key = tracker.getKey(data.role, data.name);
        if (!duplicateKeys.has(key) && !tracker.shouldPreserveNth(data.role, data.name)) {
            // Not a duplicate, remove nth to keep locator simple
            delete refs[ref].nth;
        }
    }
}
/**
 * Get indentation level (number of spaces / 2)
 */
function getIndentLevel(line) {
    const match = line.match(/^(\s*)/);
    return match ? Math.floor(match[1].length / 2) : 0;
}
/**
 * Remove empty structural branches in compact mode
 */
function compactTree(lines) {
    const result = [];
    // Simple pass: keep lines that have content or refs
    for (let i = 0; i < lines.length; i++) {
        const entry = lines[i];
        const line = entry.text;
        // Always keep lines with refs
        if (entry.ref) {
            result.push(entry);
            continue;
        }
        // Keep lines with text content (after :)
        if (line.includes(':') && !line.endsWith(':')) {
            result.push(entry);
            continue;
        }
        // Check if this structural element has children with refs
        const currentIndent = getIndentLevel(line);
        let hasRelevantChildren = false;
        for (let j = i + 1; j < lines.length; j++) {
            const childIndent = getIndentLevel(lines[j].text);
            if (childIndent <= currentIndent)
                break;
            if (lines[j].ref) {
                hasRelevantChildren = true;
                break;
            }
        }
        if (hasRelevantChildren) {
            result.push(entry);
        }
    }
    return result;
}
/**
 * Parse a ref from command argument (e.g., "@e1" -> "e1")
 */
export function parseRef(arg) {
    if (arg.startsWith('@')) {
        return arg.slice(1);
    }
    if (arg.startsWith('ref=')) {
        return arg.slice(4);
    }
    if (/^e\d+$/.test(arg)) {
        return arg;
    }
    return null;
}
/**
 * Get snapshot statistics
 */
export function getSnapshotStats(tree, refs) {
    const interactive = Object.values(refs).filter((r) => INTERACTIVE_ROLES.has(r.role)).length;
    const tokenEstimate = Math.ceil(tree.length / 4);
    return {
        lines: tree.split('\n').length,
        chars: tree.length,
        utf8Bytes: Buffer.byteLength(tree, 'utf8'),
        // Backward-compatible alias. This is deliberately not presented as a
        // tokenizer result: it is the legacy four-UTF-16-code-units heuristic.
        tokens: tokenEstimate,
        tokenEstimate,
        tokenEstimateMethod: 'ceil(UTF-16 code units / 4); heuristic only',
        refs: Object.keys(refs).length,
        interactive,
    };
}
