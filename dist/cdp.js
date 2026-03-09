/**
 * Raw Chrome DevTools Protocol client over WebSocket.
 * Zero dependencies — direct WebSocket CDP transport.
 *
 * @author Caleb Dane <calebdanemusic@gmail.com>
 *
 * Usage:
 *   const client = new CDPClient();
 *   await client.connect('ws://localhost:9222/devtools/browser/...');
 *   const { result } = await client.send('Page.navigate', { url: 'https://example.com' });
 */
import { WebSocket } from 'ws';

// ─── CDP Transport ───────────────────────────────────────────────────────────

export class CDPClient {
    ws = null;
    _msgId = 0;
    _callbacks = new Map();      // id → { resolve, reject }
    _eventHandlers = new Map();  // 'Domain.event' → Set<handler>
    _sessionId = null;
    _connected = false;

    /**
     * Connect to a Chrome CDP WebSocket endpoint.
     * @param {string} wsUrl - Full WebSocket URL (ws://...) or HTTP endpoint (http://...:9222)
     * @param {object} [opts]
     * @param {number} [opts.timeout=10000] - Connection timeout in ms
     */
    async connect(wsUrl, opts = {}) {
        const timeout = opts.timeout ?? 10000;

        // If given an HTTP URL, resolve the WebSocket URL from /json/version
        if (wsUrl.startsWith('http://') || wsUrl.startsWith('https://')) {
            wsUrl = await this._resolveWsUrl(wsUrl, timeout);
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`CDP connection timed out after ${timeout}ms to ${wsUrl}`));
            }, timeout);

            this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });

            this.ws.on('open', () => {
                clearTimeout(timer);
                this._connected = true;
                resolve();
            });

            this.ws.on('message', (data) => {
                this._handleMessage(data);
            });

            this.ws.on('close', () => {
                this._connected = false;
                // Reject all pending callbacks
                for (const [id, cb] of this._callbacks) {
                    cb.reject(new Error('CDP WebSocket closed'));
                }
                this._callbacks.clear();
            });

            this.ws.on('error', (err) => {
                clearTimeout(timer);
                if (!this._connected) {
                    reject(new Error(`CDP WebSocket error: ${err.message}`));
                }
            });
        });
    }

    /**
     * Resolve WebSocket debugger URL from an HTTP endpoint.
     * Fetches /json/version to discover the ws:// URL.
     */
    async _resolveWsUrl(httpUrl, timeout) {
        const base = httpUrl.replace(/\/$/, '');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
            const resp = await fetch(`${base}/json/version`, { signal: controller.signal });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (!data.webSocketDebuggerUrl) {
                throw new Error('No webSocketDebuggerUrl in /json/version response');
            }
            return data.webSocketDebuggerUrl;
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error(`Timed out resolving CDP endpoint at ${base}/json/version`);
            }
            throw new Error(`Failed to resolve CDP endpoint: ${err.message}`);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Send a CDP command and wait for the response.
     * @param {string} method - CDP method (e.g., 'Page.navigate')
     * @param {object} [params={}] - Command parameters
     * @param {string} [sessionId] - Target session ID (for page-level commands)
     * @returns {Promise<object>} - CDP response result
     */
    send(method, params = {}, sessionId) {
        if (!this._connected || !this.ws) {
            return Promise.reject(new Error(`CDP not connected. Cannot send ${method}`));
        }

        const id = ++this._msgId;
        const msg = { id, method, params };
        if (sessionId ?? this._sessionId) {
            msg.sessionId = sessionId ?? this._sessionId;
        }

        return new Promise((resolve, reject) => {
            this._callbacks.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(msg), (err) => {
                if (err) {
                    this._callbacks.delete(id);
                    reject(new Error(`Failed to send CDP command ${method}: ${err.message}`));
                }
            });
        });
    }

    /**
     * Subscribe to a CDP event.
     * @param {string} event - Event name (e.g., 'Page.loadEventFired')
     * @param {function} handler - Event handler
     */
    on(event, handler) {
        if (!this._eventHandlers.has(event)) {
            this._eventHandlers.set(event, new Set());
        }
        this._eventHandlers.get(event).add(handler);
    }

    /**
     * Unsubscribe from a CDP event.
     */
    off(event, handler) {
        const handlers = this._eventHandlers.get(event);
        if (handlers) {
            handlers.delete(handler);
        }
    }

    /**
     * Wait for a specific CDP event, with optional timeout.
     * @param {string} event - Event name
     * @param {object} [opts]
     * @param {number} [opts.timeout=30000] - Timeout in ms
     * @param {function} [opts.predicate] - Optional filter function
     * @returns {Promise<object>} - Event params
     */
    waitForEvent(event, opts = {}) {
        const timeout = opts.timeout ?? 30000;
        const predicate = opts.predicate ?? (() => true);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.off(event, handler);
                reject(new Error(`Timed out waiting for CDP event ${event} after ${timeout}ms`));
            }, timeout);

            const handler = (params) => {
                if (predicate(params)) {
                    clearTimeout(timer);
                    this.off(event, handler);
                    resolve(params);
                }
            };
            this.on(event, handler);
        });
    }

    /**
     * Handle incoming WebSocket messages — route responses and events.
     */
    _handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return; // Ignore malformed messages
        }

        // Response to a command (has 'id')
        if ('id' in msg) {
            const cb = this._callbacks.get(msg.id);
            if (cb) {
                this._callbacks.delete(msg.id);
                if (msg.error) {
                    cb.reject(new Error(`CDP error (${msg.error.code}): ${msg.error.message}`));
                } else {
                    cb.resolve(msg.result ?? {});
                }
            }
            return;
        }

        // Event (has 'method' but no 'id')
        if (msg.method) {
            const handlers = this._eventHandlers.get(msg.method);
            if (handlers) {
                for (const handler of handlers) {
                    try {
                        handler(msg.params ?? {});
                    } catch {
                        // Don't let one handler crash others
                    }
                }
            }
        }
    }

    /**
     * Check if connection is alive.
     */
    isConnected() {
        return this._connected && this.ws?.readyState === WebSocket.OPEN;
    }

    /**
     * Close the WebSocket connection.
     */
    async close() {
        if (this.ws) {
            this._connected = false;
            this.ws.close();
            this.ws = null;
        }
        this._callbacks.clear();
        this._eventHandlers.clear();
        this._sessionId = null;
    }
}

// ─── Page Target Management ──────────────────────────────────────────────────

/**
 * Discover available page targets from Chrome's HTTP endpoint.
 * @param {string} httpBase - e.g., 'http://localhost:9222'
 * @returns {Promise<Array>} - List of page targets
 */
export async function getTargets(httpBase, timeout = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const resp = await fetch(`${httpBase}/json/list`, { signal: controller.signal });
        const targets = await resp.json();
        return targets.filter(t => t.type === 'page');
    } catch (err) {
        throw new Error(`Failed to list targets: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Attach to a page target and enable core CDP domains.
 * Returns a sessionId for page-level commands.
 */
export async function attachToTarget(client, targetId) {
    const { sessionId } = await client.send('Target.attachToTarget', {
        targetId,
        flatten: true,
    });
    return sessionId;
}

/**
 * Enable the standard CDP domains needed for browser automation.
 */
export async function enableDomains(client, sessionId) {
    await Promise.all([
        client.send('Page.enable', {}, sessionId),
        client.send('Runtime.enable', {}, sessionId),
        client.send('DOM.enable', {}, sessionId),
        client.send('Network.enable', {}, sessionId),
        client.send('Accessibility.enable', {}, sessionId),
    ]);
}

// ─── High-Level CDP Operations ───────────────────────────────────────────────

/**
 * Navigate to a URL and optionally wait for a load state.
 * @param {CDPClient} client
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.waitUntil='load'] - 'load', 'domcontentloaded', or 'networkidle'
 * @param {number} [opts.timeout=30000]
 * @param {string} [opts.sessionId]
 */
export async function navigate(client, url, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;
    const waitUntil = opts.waitUntil ?? 'load';
    const timeout = opts.timeout ?? 30000;

    // Set up load event listener before navigating
    let loadPromise;
    if (waitUntil === 'load') {
        loadPromise = client.waitForEvent('Page.loadEventFired', { timeout });
    } else if (waitUntil === 'domcontentloaded') {
        loadPromise = client.waitForEvent('Page.domContentEventFired', { timeout });
    } else if (waitUntil === 'networkidle') {
        loadPromise = waitForNetworkIdle(client, { timeout });
    }

    const { frameId, errorText } = await client.send('Page.navigate', { url }, sessionId);
    if (errorText) {
        throw new Error(`Navigation failed: ${errorText}`);
    }

    if (loadPromise) {
        await loadPromise;
    }

    return { frameId };
}

/**
 * Wait for network idle (no pending requests for 500ms).
 */
export function waitForNetworkIdle(client, opts = {}) {
    const timeout = opts.timeout ?? 30000;
    const idleTime = opts.idleTime ?? 500;

    return new Promise((resolve, reject) => {
        let pending = 0;
        let idleTimer = null;
        const overallTimer = setTimeout(() => {
            cleanup();
            // Network idle timeout is not fatal — resolve anyway
            resolve();
        }, timeout);

        const checkIdle = () => {
            if (pending <= 0) {
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    cleanup();
                    resolve();
                }, idleTime);
            }
        };

        const onRequest = () => {
            pending++;
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };

        const onComplete = () => {
            pending = Math.max(0, pending - 1);
            checkIdle();
        };

        client.on('Network.requestWillBeSent', onRequest);
        client.on('Network.loadingFinished', onComplete);
        client.on('Network.loadingFailed', onComplete);

        const cleanup = () => {
            clearTimeout(overallTimer);
            if (idleTimer) clearTimeout(idleTimer);
            client.off('Network.requestWillBeSent', onRequest);
            client.off('Network.loadingFinished', onComplete);
            client.off('Network.loadingFailed', onComplete);
        };

        // Start idle check immediately (page might already be idle)
        checkIdle();
    });
}

/**
 * Take a screenshot.
 * @returns {Promise<Buffer>} - Screenshot as a Buffer
 */
export async function screenshot(client, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;
    const format = opts.format ?? 'png';
    const quality = format === 'jpeg' ? (opts.quality ?? 80) : undefined;

    const params = {
        format,
        ...(quality !== undefined && { quality }),
        ...(opts.clip && { clip: opts.clip }),
        ...(opts.captureBeyondViewport !== undefined && { captureBeyondViewport: opts.captureBeyondViewport }),
    };

    const { data } = await client.send('Page.captureScreenshot', params, sessionId);
    return Buffer.from(data, 'base64');
}

/**
 * Evaluate JavaScript in the page context.
 * @returns {Promise<any>} - Evaluation result
 */
export async function evaluate(client, expression, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;
    const returnByValue = opts.returnByValue ?? true;

    const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
        expression: typeof expression === 'function' ? `(${expression})()` : expression,
        returnByValue,
        awaitPromise: true,
    }, sessionId);

    if (exceptionDetails) {
        throw new Error(`Evaluation failed: ${exceptionDetails.text ?? exceptionDetails.exception?.description ?? 'Unknown error'}`);
    }

    return returnByValue ? result.value : result;
}

/**
 * Query a DOM element by CSS selector.
 * @returns {Promise<number|null>} - Node ID or null
 */
export async function querySelector(client, selector, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;

    const { root } = await client.send('DOM.getDocument', { depth: 0 }, sessionId);
    const { nodeId } = await client.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector,
    }, sessionId);

    return nodeId > 0 ? nodeId : null;
}

/**
 * Get the bounding box of a DOM node.
 * @returns {Promise<{x, y, width, height, centerX, centerY}>}
 */
export async function getBoxModel(client, nodeId, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;

    const { model } = await client.send('DOM.getBoxModel', { nodeId }, sessionId);
    const quad = model.border; // [x1,y1, x2,y2, x3,y3, x4,y4]

    const x = Math.min(quad[0], quad[2], quad[4], quad[6]);
    const y = Math.min(quad[1], quad[3], quad[5], quad[7]);
    const width = Math.max(quad[0], quad[2], quad[4], quad[6]) - x;
    const height = Math.max(quad[1], quad[3], quad[5], quad[7]) - y;

    return {
        x, y, width, height,
        centerX: x + width / 2,
        centerY: y + height / 2,
    };
}

/**
 * Scroll a node into view if needed.
 */
export async function scrollIntoView(client, nodeId, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;

    try {
        await client.send('DOM.scrollIntoViewIfNeeded', { nodeId }, sessionId);
    } catch {
        // Fallback: use Runtime to scroll
        const { object } = await client.send('DOM.resolveNode', { nodeId }, sessionId);
        await client.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: 'function() { this.scrollIntoView({ block: "center", behavior: "instant" }); }',
        }, sessionId);
    }
}

/**
 * Click at coordinates.
 */
export async function clickAtPoint(client, x, y, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;
    const button = opts.button ?? 'left';
    const clickCount = opts.clickCount ?? 1;

    await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button, clickCount,
    }, sessionId);
    await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button, clickCount,
    }, sessionId);
}

/**
 * Click a DOM node by nodeId — scroll into view, get center, click.
 */
export async function clickNode(client, nodeId, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;

    await scrollIntoView(client, nodeId, { sessionId });
    const box = await getBoxModel(client, nodeId, { sessionId });
    await clickAtPoint(client, box.centerX, box.centerY, { ...opts, sessionId });
}

/**
 * Focus a DOM node.
 */
export async function focusNode(client, nodeId, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;
    await client.send('DOM.focus', { nodeId }, sessionId);
}

/**
 * Type text into the focused element.
 */
export async function insertText(client, text, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;
    await client.send('Input.insertText', { text }, sessionId);
}

/**
 * Fill a node: focus, clear existing text, type new text.
 */
export async function fillNode(client, nodeId, text, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;

    // Focus the element
    await focusNode(client, nodeId, { sessionId });

    // Select all existing text and delete it
    await client.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
        modifiers: process.platform === 'darwin' ? 4 : 2, // meta on mac, ctrl on others
    }, sessionId);
    await client.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    }, sessionId);
    await client.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    }, sessionId);
    await client.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    }, sessionId);

    // Type new text
    await insertText(client, text, { sessionId });
}

/**
 * Press a key (keyDown + keyUp).
 */
export async function pressKey(client, key, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;

    await client.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        ...(opts.code && { code: opts.code }),
        ...(opts.modifiers && { modifiers: opts.modifiers }),
        ...(opts.text && { text: opts.text }),
    }, sessionId);
    await client.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        ...(opts.code && { code: opts.code }),
    }, sessionId);
}

/**
 * Type a single character (dispatches keyDown with text + keyUp).
 * For printable characters, includes the text field to trigger character input.
 * For special keys (length > 1), delegates to pressKey.
 */
export async function typeChar(client, char, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;
    if (char.length > 1) {
        return pressKey(client, char, opts);
    }
    await client.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: char,
        text: char,
    }, sessionId);
    await client.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: char,
    }, sessionId);
}

/**
 * Get the full accessibility tree from the page.
 * @returns {Promise<Array>} - Array of AX nodes
 */
export async function getAccessibilityTree(client, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;

    const { nodes } = await client.send('Accessibility.getFullAXTree', {}, sessionId);
    return nodes;
}

/**
 * Format an accessibility tree into the text format that snapshot.js expects.
 * Produces output matching the standard ariaSnapshot format:
 *   - role "name" [attr=value]
 *     - childrole "childname"
 *
 * @param {Array} nodes - Raw AX nodes from getAccessibilityTree()
 * @returns {string} - Formatted tree text
 */
export function formatAccessibilityTree(nodes) {
    if (!nodes || nodes.length === 0) return '';

    // Build a lookup map: nodeId → node
    const nodeMap = new Map();
    for (const node of nodes) {
        nodeMap.set(node.nodeId, node);
    }

    const root = nodes[0];
    const lines = [];

    // Skip these roles entirely (internal Chrome rendering details)
    const SKIP_ROLES = new Set(['InlineTextBox', 'LineBreak']);
    // These roles are transparent — walk children at same depth
    const TRANSPARENT_ROLES = new Set(['none', 'presentation', 'generic']);
    // Text-bearing roles whose content should be inlined into parent
    const TEXT_ROLES = new Set(['StaticText']);

    function getProperty(node, name) {
        if (!node.properties) return undefined;
        const prop = node.properties.find(p => p.name === name);
        return prop?.value?.value;
    }

    /**
     * Collect all text content from a node's subtree by flattening StaticText children.
     */
    function collectText(node) {
        if (!node) return '';
        const role = node.role?.value;
        if (TEXT_ROLES.has(role)) return node.name?.value ?? '';
        if (SKIP_ROLES.has(role)) return '';

        let text = '';
        if (node.childIds) {
            for (const childId of node.childIds) {
                const child = nodeMap.get(childId);
                if (child) text += collectText(child);
            }
        }
        return text;
    }

    /**
     * Check if a node's children are purely text (StaticText/InlineTextBox only).
     * If so, the text should be inlined as `: text` rather than expanded as children.
     */
    function isTextOnly(node) {
        if (!node.childIds || node.childIds.length === 0) return false;
        return node.childIds.every(childId => {
            const child = nodeMap.get(childId);
            if (!child) return true;
            const r = child.role?.value;
            return TEXT_ROLES.has(r) || SKIP_ROLES.has(r) || TRANSPARENT_ROLES.has(r) && isTextOnly(child);
        });
    }

    /**
     * Check if a node has any non-text children that need to be rendered.
     */
    function hasStructuralChildren(node) {
        if (!node.childIds) return false;
        return node.childIds.some(childId => {
            const child = nodeMap.get(childId);
            if (!child) return false;
            const r = child.role?.value;
            if (SKIP_ROLES.has(r) || TEXT_ROLES.has(r)) return false;
            if (TRANSPARENT_ROLES.has(r)) return hasStructuralChildren(child);
            return true;
        });
    }

    function walkNode(node, depth) {
        const role = node.role?.value;
        if (!role || SKIP_ROLES.has(role) || TEXT_ROLES.has(role)) return;

        // Transparent roles: skip but walk children at same depth
        if (TRANSPARENT_ROLES.has(role)) {
            if (node.childIds) {
                for (const childId of node.childIds) {
                    const child = nodeMap.get(childId);
                    if (child) walkNode(child, depth);
                }
            }
            return;
        }

        // Root document: process children, optionally wrap in document:
        if (role === 'RootWebArea' || role === 'WebArea') {
            if (node.childIds) {
                for (const childId of node.childIds) {
                    const child = nodeMap.get(childId);
                    if (child) walkNode(child, depth);
                }
            }
            return;
        }

        const name = node.name?.value ?? '';
        const indent = '  '.repeat(depth);

        // Build attribute list
        const attrs = [];
        const level = getProperty(node, 'level');
        if (level !== undefined) attrs.push(`level=${level}`);

        const checked = getProperty(node, 'checked');
        if (checked === 'true' || checked === true) attrs.push('checked');
        if (checked === 'mixed') attrs.push('checked=mixed');

        const selected = getProperty(node, 'selected');
        if (selected === true || selected === 'true') attrs.push('selected');

        const expanded = getProperty(node, 'expanded');
        if (expanded === true || expanded === 'true') attrs.push('expanded');
        if (expanded === false || expanded === 'false') attrs.push('collapsed');

        const disabled = getProperty(node, 'disabled');
        if (disabled === true || disabled === 'true') attrs.push('disabled');

        const required = getProperty(node, 'required');
        if (required === true || required === 'true') attrs.push('required');

        const readonly_ = getProperty(node, 'readonly');
        if (readonly_ === true || readonly_ === 'true') attrs.push('readonly');

        // Build the line
        let line = `${indent}- ${role}`;
        if (name) {
            line += ` "${name}"`;
        }
        if (attrs.length > 0) {
            line += ` [${attrs.join('] [')}]`;
        }

        // If children are text-only, inline the text after a colon
        if (!name && isTextOnly(node)) {
            const text = collectText(node).trim();
            if (text) {
                line += `: ${text}`;
            }
        }
        // Standard format appends ':' when node has structural children or sub-entries
        else if ((node.childIds && hasStructuralChildren(node)) ||
                 (role === 'link' && getProperty(node, 'url'))) {
            line += ':';
        }

        lines.push(line);

        // For links, add /url child if available
        if (role === 'link') {
            const url = getProperty(node, 'url');
            if (url) {
                lines.push(`${indent}  - /url: ${url}`);
            }
        }

        // Recurse into structural children (skip if text was already inlined)
        if (node.childIds && hasStructuralChildren(node)) {
            for (const childId of node.childIds) {
                const child = nodeMap.get(childId);
                if (child) walkNode(child, depth + 1);
            }
        }
    }

    walkNode(root, 0);
    return lines.join('\n');
}

/**
 * Resolve a DOM node to a Runtime object for callFunctionOn.
 */
export async function resolveNode(client, nodeId, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;
    const { object } = await client.send('DOM.resolveNode', { nodeId }, sessionId);
    return object;
}

/**
 * Call a function on a remote object.
 */
export async function callFunctionOn(client, objectId, fn, args = [], opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;

    const { result, exceptionDetails } = await client.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: typeof fn === 'function' ? fn.toString() : fn,
        arguments: args.map(a => ({ value: a })),
        returnByValue: true,
        awaitPromise: true,
    }, sessionId);

    if (exceptionDetails) {
        throw new Error(`callFunctionOn failed: ${exceptionDetails.text ?? 'Unknown error'}`);
    }

    return result.value;
}

/**
 * Get text content of a node.
 */
export async function getTextContent(client, nodeId, opts = {}) {
    const obj = await resolveNode(client, nodeId, opts);
    return callFunctionOn(client, obj.objectId, function () { return this.textContent; }, [], opts);
}

/**
 * Get an attribute of a node.
 */
export async function getAttribute(client, nodeId, attrName, opts = {}) {
    const obj = await resolveNode(client, nodeId, opts);
    return callFunctionOn(client, obj.objectId, function (attr) { return this.getAttribute(attr); }, [attrName], opts);
}

/**
 * Check if a node is visible.
 */
export async function isVisible(client, nodeId, opts = {}) {
    const obj = await resolveNode(client, nodeId, opts);
    return callFunctionOn(client, obj.objectId, function () {
        const style = window.getComputedStyle(this);
        const rect = this.getBoundingClientRect();
        return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity) > 0 &&
            rect.width > 0 &&
            rect.height > 0;
    }, [], opts);
}

/**
 * Set viewport size.
 */
export async function setViewport(client, width, height, opts = {}) {
    const sessionId = opts.sessionId ?? client._sessionId;
    const deviceScaleFactor = opts.deviceScaleFactor ?? 1;

    await client.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor, mobile: false,
    }, sessionId);
}

/**
 * Get console messages by subscribing to Runtime.consoleAPICalled.
 * Returns an unsubscribe function.
 */
export function trackConsole(client, messages) {
    const handler = (params) => {
        messages.push({
            type: params.type,
            text: params.args?.map(a => a.value ?? a.description ?? '').join(' ') ?? '',
            timestamp: Date.now(),
        });
    };
    client.on('Runtime.consoleAPICalled', handler);
    return () => client.off('Runtime.consoleAPICalled', handler);
}

/**
 * Get page errors by subscribing to Runtime.exceptionThrown.
 * Returns an unsubscribe function.
 */
export function trackErrors(client, errors) {
    const handler = (params) => {
        errors.push({
            message: params.exceptionDetails?.text ??
                params.exceptionDetails?.exception?.description ??
                'Unknown error',
            timestamp: Date.now(),
        });
    };
    client.on('Runtime.exceptionThrown', handler);
    return () => client.off('Runtime.exceptionThrown', handler);
}

/**
 * Handle JavaScript dialogs (alert, confirm, prompt, beforeunload).
 * Auto-dismisses by default.
 */
export function handleDialogs(client, opts = {}) {
    const onDialog = opts.onDialog ?? null;
    const handler = async (params) => {
        if (onDialog) {
            onDialog(params);
        }
        // Auto-accept by default
        await client.send('Page.handleJavaScriptDialog', {
            accept: opts.accept ?? true,
            promptText: opts.promptText,
        }).catch(() => {});
    };
    client.on('Page.javascriptDialogOpening', handler);
    return () => client.off('Page.javascriptDialogOpening', handler);
}

/**
 * Create a new page target.
 * @returns {Promise<string>} - Target ID
 */
export async function createTarget(client, url = 'about:blank', opts = {}) {
    const { targetId } = await client.send('Target.createTarget', {
        url,
        ...(opts.browserContextId && { browserContextId: opts.browserContextId }),
    });
    return targetId;
}

/**
 * Close a target.
 */
export async function closeTarget(client, targetId) {
    await client.send('Target.closeTarget', { targetId });
}

/**
 * Probe a debug port for a running Chrome instance.
 * Returns the WebSocket URL if found, null otherwise.
 */
export async function probeDebugPort(port, timeout = 2000) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.webSocketDebuggerUrl ?? null;
    } catch {
        return null;
    }
}
