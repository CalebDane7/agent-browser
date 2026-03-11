/**
 * Browser manager — raw CDP, no external browser automation library.
 * @author Caleb Dane <calebdanemusic@gmail.com>
 */
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { getEnhancedSnapshot, parseRef } from './snapshot.js';
import { safeHeaderMerge } from './state-utils.js';
import { getEncryptionKey, isEncryptedPayload, decryptData, ENCRYPTION_KEY_ENV } from './state-utils.js';
import {
    CDPClient, getTargets, attachToTarget, enableDomains,
    navigate, waitForNetworkIdle, screenshot, evaluate,
    querySelector, getBoxModel, scrollIntoView, clickAtPoint, clickNode,
    focusNode, insertText, fillNode, pressKey, typeChar,
    getAccessibilityTree, formatAccessibilityTree,
    resolveNode, callFunctionOn, getTextContent, getAttribute,
    isVisible, setViewport, trackConsole, trackErrors, handleDialogs,
    createTarget, closeTarget, probeDebugPort,
} from './cdp.js';

// ─── Keyboard Helpers ────────────────────────────────────────────────────────

const KEY_DEFS = {
    'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
    'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
    'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
    'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
    'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    'Home': { key: 'Home', code: 'Home', keyCode: 36 },
    'End': { key: 'End', code: 'End', keyCode: 35 },
    'PageUp': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    'PageDown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    'Space': { key: ' ', code: 'Space', keyCode: 32 },
    ' ': { key: ' ', code: 'Space', keyCode: 32 },
    'F1': { key: 'F1', code: 'F1', keyCode: 112 },
    'F2': { key: 'F2', code: 'F2', keyCode: 113 },
    'F3': { key: 'F3', code: 'F3', keyCode: 114 },
    'F4': { key: 'F4', code: 'F4', keyCode: 115 },
    'F5': { key: 'F5', code: 'F5', keyCode: 116 },
    'F6': { key: 'F6', code: 'F6', keyCode: 117 },
    'F7': { key: 'F7', code: 'F7', keyCode: 118 },
    'F8': { key: 'F8', code: 'F8', keyCode: 119 },
    'F9': { key: 'F9', code: 'F9', keyCode: 120 },
    'F10': { key: 'F10', code: 'F10', keyCode: 121 },
    'F11': { key: 'F11', code: 'F11', keyCode: 122 },
    'F12': { key: 'F12', code: 'F12', keyCode: 123 },
};

function parseKeyCombo(combo) {
    const parts = combo.split('+');
    let modifiers = 0;
    let key = '';
    for (const part of parts) {
        const lower = part.trim().toLowerCase();
        if (lower === 'control' || lower === 'ctrl') modifiers |= 2;
        else if (lower === 'alt') modifiers |= 1;
        else if (lower === 'shift') modifiers |= 8;
        else if (lower === 'meta' || lower === 'command' || lower === 'cmd') modifiers |= 4;
        else key = part.trim();
    }
    return { key, modifiers };
}

// ─── Device Descriptors ──────────────────────────────────────────────────────

const DEVICES = {
    'iPhone 12': { viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1', deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    'iPhone 13': { viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1', deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    'iPhone 14': { viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1', deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    'iPhone SE': { viewport: { width: 375, height: 667 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1', deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    'Pixel 5': { viewport: { width: 393, height: 851 }, userAgent: 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.210 Mobile Safari/537.36', deviceScaleFactor: 2.75, isMobile: true, hasTouch: true },
    'iPad Mini': { viewport: { width: 768, height: 1024 }, userAgent: 'Mozilla/5.0 (iPad; CPU OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1', deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    'iPad Pro 11': { viewport: { width: 834, height: 1194 }, userAgent: 'Mozilla/5.0 (iPad; CPU OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1', deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    'Galaxy S21': { viewport: { width: 360, height: 800 }, userAgent: 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.87 Mobile Safari/537.36', deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    'Desktop Chrome': { viewport: { width: 1280, height: 720 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    'Desktop Firefox': { viewport: { width: 1280, height: 720 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0', deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};

// ─── CDPLocator ──────────────────────────────────────────────────────────────
// Locator API — resolves elements to DOM nodeIds via CDP.

class CDPLocator {
    constructor(page, selector, opts = {}) {
        this._page = page;
        this._selector = selector;
        this._role = opts.role;
        this._name = opts.name;
        this._exact = opts.exact ?? false;
        this._nthIndex = opts.nth;
    }

    /**
     * Resolve this locator to a CDP nodeId.
     * - CSS selector → DOM.querySelector
     * - role+name → Accessibility.queryAXTree + DOM node resolution
     */
    async _resolve() {
        const client = this._page._client;
        const sid = this._page._sessionId;

        if (this._role) {
            // ARIA role+name resolution via full accessibility tree walk.
            // Accessibility.queryAXTree hangs on targets with prior CDP sessions,
            // so we use getFullAXTree (proven reliable) and filter manually.
            const { nodes: allNodes } = await client.send('Accessibility.getFullAXTree', {}, sid);
            const matching = [];
            const roleLower = this._role.toLowerCase();
            for (const node of allNodes) {
                const nodeRole = (node.role?.value ?? '').toLowerCase();
                if (nodeRole !== roleLower) continue;
                const nodeName = node.name?.value ?? '';
                if (this._name) {
                    if (this._exact) {
                        if (nodeName !== this._name) continue;
                    } else {
                        if (!nodeName.includes(this._name)) continue;
                    }
                }
                if (node.backendDOMNodeId) matching.push(node);
            }

            if (matching.length === 0) {
                throw new Error(`No element found with role="${this._role}"${this._name ? ` and name="${this._name}"` : ''}`);
            }

            // Apply nth filter
            let targetNode = matching[0];
            if (this._nthIndex !== undefined) {
                const idx = this._nthIndex < 0 ? matching.length + this._nthIndex : this._nthIndex;
                if (idx < 0 || idx >= matching.length) {
                    throw new Error(`nth(${this._nthIndex}) out of range: only ${matching.length} elements match role="${this._role}"${this._name ? ` name="${this._name}"` : ''}`);
                }
                targetNode = matching[idx];
            }

            // Ensure DOM domain has a document root (required for pushNodesByBackendIdsToFrontend)
            await client.send('DOM.getDocument', { depth: 0 }, sid);
            // Resolve the AX node to a DOM nodeId
            const { nodeIds } = await client.send('DOM.pushNodesByBackendIdsToFrontend', {
                backendNodeIds: [targetNode.backendDOMNodeId],
            }, sid);
            if (nodeIds && nodeIds[0] > 0) return nodeIds[0];

            throw new Error(`Could not resolve DOM node for role="${this._role}"`);
        }

        // CSS or other selector
        const nodeId = await querySelector(client, this._selector, { sessionId: sid });
        if (!nodeId) {
            throw new Error(`No element found for selector: ${this._selector}`);
        }
        return nodeId;
    }

    /**
     * Create a sub-locator that selects the nth matching element.
     */
    nth(index) {
        return new CDPLocator(this._page, this._selector, {
            role: this._role,
            name: this._name,
            exact: this._exact,
            nth: index,
        });
    }

    get last() {
        return new CDPLocator(this._page, this._selector, {
            role: this._role,
            name: this._name,
            exact: this._exact,
            nth: -1, // Will resolve to last element
        });
    }

    async click(opts = {}) {
        const nodeId = await this._resolve();
        const client = this._page._client;
        const sid = this._page._sessionId;
        await scrollIntoView(client, nodeId, { sessionId: sid });
        const box = await getBoxModel(client, nodeId, { sessionId: sid });
        const clickCount = opts.clickCount ?? 1;
        await clickAtPoint(client, box.centerX, box.centerY, { sessionId: sid, clickCount });
    }

    async dblclick() {
        await this.click({ clickCount: 2 });
    }

    async fill(value) {
        const nodeId = await this._resolve();
        const client = this._page._client;
        const sid = this._page._sessionId;
        await scrollIntoView(client, nodeId, { sessionId: sid });
        await fillNode(client, nodeId, value, { sessionId: sid });
    }

    async pressSequentially(text, opts = {}) {
        const nodeId = await this._resolve();
        const client = this._page._client;
        const sid = this._page._sessionId;
        await focusNode(client, nodeId, { sessionId: sid });
        const delay = opts.delay ?? 0;
        for (const char of text) {
            await typeChar(client, char, { sessionId: sid });
            if (delay > 0) await new Promise(r => setTimeout(r, delay));
        }
    }

    async hover() {
        const nodeId = await this._resolve();
        const client = this._page._client;
        const sid = this._page._sessionId;
        await scrollIntoView(client, nodeId, { sessionId: sid });
        const box = await getBoxModel(client, nodeId, { sessionId: sid });
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: box.centerX, y: box.centerY,
        }, sid);
    }

    async check() {
        const checked = await this.isChecked();
        if (!checked) await this.click();
    }

    async uncheck() {
        const checked = await this.isChecked();
        if (checked) await this.click();
    }

    async selectOption(values) {
        const nodeId = await this._resolve();
        const client = this._page._client;
        const sid = this._page._sessionId;
        const obj = await resolveNode(client, nodeId, { sessionId: sid });
        const valArr = Array.isArray(values) ? values : [values];
        // Handle both string values and {value}/{label} objects
        const normalized = valArr.map(v => typeof v === 'string' ? v : (v.value ?? v.label ?? String(v)));
        const selected = await callFunctionOn(client, obj.objectId, function (vals) {
            const select = this;
            const result = [];
            for (const opt of select.options) {
                opt.selected = vals.includes(opt.value) || vals.includes(opt.label);
                if (opt.selected) result.push(opt.value);
            }
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return result;
        }, [normalized], { sessionId: sid });
        return selected;
    }

    async setInputFiles(files) {
        const nodeId = await this._resolve();
        const client = this._page._client;
        const sid = this._page._sessionId;
        const fileList = Array.isArray(files) ? files : [files];
        await client.send('DOM.setFileInputFiles', {
            nodeId,
            files: fileList,
        }, sid);
    }

    async focus() {
        const nodeId = await this._resolve();
        await focusNode(this._page._client, nodeId, { sessionId: this._page._sessionId });
    }

    async scrollIntoViewIfNeeded() {
        const nodeId = await this._resolve();
        await scrollIntoView(this._page._client, nodeId, { sessionId: this._page._sessionId });
    }

    async evaluate(fn, arg) {
        const nodeId = await this._resolve();
        const client = this._page._client;
        const sid = this._page._sessionId;
        const obj = await resolveNode(client, nodeId, { sessionId: sid });
        return callFunctionOn(client, obj.objectId, fn, arg !== undefined ? [arg] : [], { sessionId: sid });
    }

    async boundingBox() {
        try {
            const nodeId = await this._resolve();
            const box = await getBoxModel(this._page._client, nodeId, { sessionId: this._page._sessionId });
            return { x: box.x, y: box.y, width: box.width, height: box.height };
        } catch {
            return null;
        }
    }

    async getAttribute(name) {
        const nodeId = await this._resolve();
        return getAttribute(this._page._client, nodeId, name, { sessionId: this._page._sessionId });
    }

    async textContent() {
        const nodeId = await this._resolve();
        return getTextContent(this._page._client, nodeId, { sessionId: this._page._sessionId });
    }

    async innerText() {
        const nodeId = await this._resolve();
        const obj = await resolveNode(this._page._client, nodeId, { sessionId: this._page._sessionId });
        return callFunctionOn(this._page._client, obj.objectId, function () { return this.innerText; }, [], { sessionId: this._page._sessionId });
    }

    async innerHTML() {
        const nodeId = await this._resolve();
        const obj = await resolveNode(this._page._client, nodeId, { sessionId: this._page._sessionId });
        return callFunctionOn(this._page._client, obj.objectId, function () { return this.innerHTML; }, [], { sessionId: this._page._sessionId });
    }

    async inputValue() {
        const nodeId = await this._resolve();
        const obj = await resolveNode(this._page._client, nodeId, { sessionId: this._page._sessionId });
        return callFunctionOn(this._page._client, obj.objectId, function () { return this.value; }, [], { sessionId: this._page._sessionId });
    }

    async isVisible() {
        try {
            const nodeId = await this._resolve();
            return await isVisible(this._page._client, nodeId, { sessionId: this._page._sessionId });
        } catch {
            return false;
        }
    }

    async isEnabled() {
        try {
            const nodeId = await this._resolve();
            const obj = await resolveNode(this._page._client, nodeId, { sessionId: this._page._sessionId });
            return await callFunctionOn(this._page._client, obj.objectId, function () { return !this.disabled; }, [], { sessionId: this._page._sessionId });
        } catch {
            return false;
        }
    }

    async isChecked() {
        try {
            const nodeId = await this._resolve();
            const obj = await resolveNode(this._page._client, nodeId, { sessionId: this._page._sessionId });
            return await callFunctionOn(this._page._client, obj.objectId, function () { return !!this.checked; }, [], { sessionId: this._page._sessionId });
        } catch {
            return false;
        }
    }

    async count() {
        if (this._role) {
            try {
                const client = this._page._client;
                const sid = this._page._sessionId;
                const { root } = await client.send('DOM.getDocument', { depth: 0 }, sid);
                const { object } = await client.send('DOM.resolveNode', { nodeId: root.nodeId }, sid);
                const queryParams = { objectId: object.objectId, role: this._role };
                if (this._name) queryParams.name = this._name;
                const { nodes } = await client.send('Accessibility.queryAXTree', queryParams, sid);
                return nodes?.length ?? 0;
            } catch {
                return 0;
            }
        }
        // CSS: count matching elements
        try {
            const result = await evaluate(this._page._client,
                `document.querySelectorAll(${JSON.stringify(this._selector)}).length`,
                { sessionId: this._page._sessionId }
            );
            return result ?? 0;
        } catch {
            return 0;
        }
    }

    async screenshot(opts = {}) {
        const nodeId = await this._resolve();
        const client = this._page._client;
        const sid = this._page._sessionId;
        await scrollIntoView(client, nodeId, { sessionId: sid });
        const box = await getBoxModel(client, nodeId, { sessionId: sid });
        const buf = await screenshot(client, {
            sessionId: sid,
            format: opts.type ?? 'png',
            clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
        });
        if (opts.path) {
            const { writeFile: wf } = await import('node:fs/promises');
            const { mkdirSync } = await import('node:fs');
            const { dirname } = await import('node:path');
            mkdirSync(dirname(opts.path), { recursive: true });
            await wf(opts.path, buf);
        }
        return buf;
    }

    async highlight() {
        const nodeId = await this._resolve();
        const client = this._page._client;
        const sid = this._page._sessionId;
        await client.send('DOM.highlightNode', {
            highlightConfig: {
                contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
                paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
                borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
                marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
            },
            nodeId,
        }, sid);
    }

    async clear() {
        await this.fill('');
    }

    async selectText() {
        const nodeId = await this._resolve();
        const obj = await resolveNode(this._page._client, nodeId, { sessionId: this._page._sessionId });
        await callFunctionOn(this._page._client, obj.objectId, function () {
            if (this.select) this.select();
            else {
                const range = document.createRange();
                range.selectNodeContents(this);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }, [], { sessionId: this._page._sessionId });
    }

    async dispatchEvent(type, eventInit) {
        const nodeId = await this._resolve();
        const obj = await resolveNode(this._page._client, nodeId, { sessionId: this._page._sessionId });
        await callFunctionOn(this._page._client, obj.objectId, function (evtType, init) {
            this.dispatchEvent(new Event(evtType, init ?? { bubbles: true }));
        }, [type, eventInit], { sessionId: this._page._sessionId });
    }
}

// ─── CDPPage ─────────────────────────────────────────────────────────────────
// Page API — wraps raw CDP calls.

class CDPPage {
    constructor(client, sessionId, targetId) {
        this._client = client;
        this._sessionId = sessionId;
        this._targetId = targetId;
        this._url = 'about:blank';
        this._consoleUnsubscribe = null;
        this._errorUnsubscribe = null;
        this._dialogUnsubscribe = null;
        this._contextRef = null; // Back-reference to CDPContext

        // Set up URL tracking via navigation events
        client.on('Page.frameNavigated', (params) => {
            if (!params.frame?.parentId) { // Main frame only
                this._url = params.frame?.url ?? this._url;
            }
        });

        // Keyboard and mouse sub-objects matching browser automation API
        this.keyboard = {
            press: async (key) => {
                const { key: k, modifiers } = parseKeyCombo(key);
                const def = KEY_DEFS[k] ?? { key: k, code: `Key${k.toUpperCase()}`, keyCode: k.charCodeAt(0) };
                await pressKey(client, def.key, { sessionId, code: def.code, modifiers: modifiers || undefined, text: k.length === 1 ? k : def.key === ' ' ? ' ' : undefined });
            },
            type: async (text, opts = {}) => {
                const delay = opts.delay ?? 0;
                for (const char of text) {
                    await typeChar(client, char, { sessionId });
                    if (delay > 0) await new Promise(r => setTimeout(r, delay));
                }
            },
            down: async (key) => {
                const def = KEY_DEFS[key] ?? { key, code: `Key${key.toUpperCase()}`, keyCode: 0 };
                await client.send('Input.dispatchKeyEvent', {
                    type: 'keyDown', key: def.key, code: def.code,
                    ...(key.length === 1 && { text: key }),
                }, sessionId);
            },
            up: async (key) => {
                const def = KEY_DEFS[key] ?? { key, code: `Key${key.toUpperCase()}`, keyCode: 0 };
                await client.send('Input.dispatchKeyEvent', {
                    type: 'keyUp', key: def.key, code: def.code,
                }, sessionId);
            },
            insertText: async (text) => {
                await insertText(client, text, { sessionId });
            },
        };

        this.mouse = {
            click: async (x, y, opts = {}) => {
                await clickAtPoint(client, x, y, { sessionId, ...opts });
            },
            dblclick: async (x, y) => {
                await clickAtPoint(client, x, y, { sessionId, clickCount: 2 });
            },
            move: async (x, y) => {
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved', x, y,
                }, sessionId);
            },
            down: async (opts = {}) => {
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed', x: 0, y: 0, button: opts.button ?? 'left', clickCount: 1,
                }, sessionId);
            },
            up: async (opts = {}) => {
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: 0, y: 0, button: opts.button ?? 'left', clickCount: 1,
                }, sessionId);
            },
            wheel: async (deltaX, deltaY) => {
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseWheel', x: 0, y: 0, deltaX, deltaY,
                }, sessionId);
            },
        };
    }

    // ── Navigation ───────────────────────────────────────────────────────────

    async goto(url, opts = {}) {
        const waitMap = { load: 'load', domcontentloaded: 'domcontentloaded', networkidle: 'networkidle' };
        const waitUntil = waitMap[opts.waitUntil] ?? 'load';
        await navigate(this._client, url, { sessionId: this._sessionId, waitUntil, timeout: opts.timeout });
        this._url = url;
    }

    url() {
        return this._url;
    }

    async title() {
        return evaluate(this._client, 'document.title', { sessionId: this._sessionId });
    }

    async goBack() {
        await evaluate(this._client, 'history.back()', { sessionId: this._sessionId });
        await new Promise(r => setTimeout(r, 500)); // Brief wait for navigation
    }

    async goForward() {
        await evaluate(this._client, 'history.forward()', { sessionId: this._sessionId });
        await new Promise(r => setTimeout(r, 500));
    }

    async reload() {
        await this._client.send('Page.reload', {}, this._sessionId);
        await this._client.waitForEvent('Page.loadEventFired', { timeout: 30000 });
    }

    // ── Evaluation ───────────────────────────────────────────────────────────

    async evaluate(expression, arg) {
        if (typeof expression === 'function') {
            const fnStr = expression.toString();
            const expr = arg !== undefined
                ? `(${fnStr})(${JSON.stringify(arg)})`
                : `(${fnStr})()`;
            return evaluate(this._client, expr, { sessionId: this._sessionId });
        }
        return evaluate(this._client, expression, { sessionId: this._sessionId });
    }

    async evaluateHandle(expression) {
        const { result } = await this._client.send('Runtime.evaluate', {
            expression: typeof expression === 'function' ? `(${expression})()` : expression,
            returnByValue: false,
            awaitPromise: true,
        }, this._sessionId);
        return result;
    }

    async $eval(selector, fn) {
        const nodeId = await querySelector(this._client, selector, { sessionId: this._sessionId });
        if (!nodeId) throw new Error(`No element matches selector: ${selector}`);
        const obj = await resolveNode(this._client, nodeId, { sessionId: this._sessionId });
        return callFunctionOn(this._client, obj.objectId, fn, [], { sessionId: this._sessionId });
    }

    async $(selector) {
        const nodeId = await querySelector(this._client, selector, { sessionId: this._sessionId });
        if (!nodeId) return null;
        return nodeId; // Return nodeId directly; callers use it for contentFrame etc.
    }

    // ── Locators ─────────────────────────────────────────────────────────────

    locator(selector) {
        return new CDPLocator(this, selector);
    }

    getByRole(role, opts = {}) {
        return new CDPLocator(this, `[role="${role}"]`, {
            role,
            name: opts.name,
            exact: opts.exact,
        });
    }

    getByText(text, opts = {}) {
        // Use XPath to find by text content
        const exact = opts.exact;
        if (exact) {
            return new CDPLocator(this, `xpath=//*[normalize-space(.)="${text}" and not(./*[normalize-space(.)="${text}"])]`);
        }
        return new CDPLocator(this, `xpath=//*[contains(normalize-space(.), "${text}") and not(./*[contains(normalize-space(.), "${text}")])]`);
    }

    getByLabel(text, opts = {}) {
        return new CDPLocator(this, `[aria-label="${text}"]`);
    }

    getByPlaceholder(text, opts = {}) {
        return new CDPLocator(this, `[placeholder="${text}"]`);
    }

    getByAltText(text, opts = {}) {
        return new CDPLocator(this, `[alt="${text}"]`);
    }

    getByTitle(text, opts = {}) {
        return new CDPLocator(this, `[title="${text}"]`);
    }

    getByTestId(testId) {
        return new CDPLocator(this, `[data-testid="${testId}"]`);
    }

    // ── Screenshots & Content ────────────────────────────────────────────────

    async screenshot(opts = {}) {
        const buf = await screenshot(this._client, {
            sessionId: this._sessionId,
            format: opts.type ?? 'png',
            quality: opts.quality,
            captureBeyondViewport: opts.fullPage,
        });
        if (opts.path) {
            const { writeFile: wf } = await import('node:fs/promises');
            const { mkdirSync } = await import('node:fs');
            const { dirname } = await import('node:path');
            mkdirSync(dirname(opts.path), { recursive: true });
            await wf(opts.path, buf);
        }
        return buf;
    }

    async content() {
        return evaluate(this._client, 'document.documentElement.outerHTML', { sessionId: this._sessionId });
    }

    async setContent(html) {
        await this._client.send('Page.setDocumentContent', {
            frameId: (await this._client.send('Page.getFrameTree', {}, this._sessionId)).frameTree.frame.id,
            html,
        }, this._sessionId);
    }

    async pdf(opts = {}) {
        const { data } = await this._client.send('Page.printToPDF', {
            landscape: opts.landscape,
            printBackground: opts.printBackground ?? true,
            paperWidth: opts.width ? parseFloat(opts.width) / 96 : undefined,
            paperHeight: opts.height ? parseFloat(opts.height) / 96 : undefined,
            marginTop: opts.margin?.top ? parseFloat(opts.margin.top) / 96 : undefined,
            marginBottom: opts.margin?.bottom ? parseFloat(opts.margin.bottom) / 96 : undefined,
            marginLeft: opts.margin?.left ? parseFloat(opts.margin.left) / 96 : undefined,
            marginRight: opts.margin?.right ? parseFloat(opts.margin.right) / 96 : undefined,
            ...(opts.path && { transferMode: 'ReturnAsBase64' }),
        }, this._sessionId);

        const buffer = Buffer.from(data, 'base64');
        if (opts.path) {
            const { writeFile: wf } = await import('node:fs/promises');
            await wf(opts.path, buffer);
        }
        return buffer;
    }

    // ── Waiting ──────────────────────────────────────────────────────────────

    async waitForSelector(selector, opts = {}) {
        const timeout = opts.timeout ?? 30000;
        const start = Date.now();
        const state = opts.state ?? 'visible';

        while (Date.now() - start < timeout) {
            try {
                const nodeId = await querySelector(this._client, selector, { sessionId: this._sessionId });
                if (state === 'attached' && nodeId) return new CDPLocator(this, selector);
                if (state === 'detached' && !nodeId) return null;
                if (nodeId) {
                    if (state === 'visible') {
                        const vis = await isVisible(this._client, nodeId, { sessionId: this._sessionId });
                        if (vis) return new CDPLocator(this, selector);
                    } else if (state === 'hidden') {
                        const vis = await isVisible(this._client, nodeId, { sessionId: this._sessionId });
                        if (!vis) return new CDPLocator(this, selector);
                    }
                }
            } catch { /* retry */ }
            await new Promise(r => setTimeout(r, 100));
        }
        throw new Error(`waitForSelector("${selector}") timed out after ${timeout}ms`);
    }

    async waitForTimeout(ms) {
        await new Promise(r => setTimeout(r, ms));
    }

    async waitForLoadState(state, opts = {}) {
        const timeout = opts?.timeout ?? 30000;
        if (state === 'networkidle') {
            await waitForNetworkIdle(this._client, { timeout });
        } else if (state === 'domcontentloaded') {
            await this._client.waitForEvent('Page.domContentEventFired', { timeout });
        } else {
            await this._client.waitForEvent('Page.loadEventFired', { timeout });
        }
    }

    async waitForURL(urlOrPattern, opts = {}) {
        const timeout = opts.timeout ?? 30000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const current = this.url();
            if (typeof urlOrPattern === 'string' && current.includes(urlOrPattern)) return;
            if (urlOrPattern instanceof RegExp && urlOrPattern.test(current)) return;
            await new Promise(r => setTimeout(r, 100));
        }
        throw new Error(`waitForURL timed out after ${timeout}ms`);
    }

    async waitForEvent(eventName, opts = {}) {
        const timeout = opts.timeout ?? 30000;
        // Map standard event names to CDP equivalents
        if (eventName === 'download') {
            return this._client.waitForEvent('Page.downloadWillBegin', { timeout });
        }
        if (eventName === 'response') {
            return this._client.waitForEvent('Network.responseReceived', { timeout });
        }
        return this._client.waitForEvent(eventName, { timeout });
    }

    async waitForResponse(predicate, opts = {}) {
        const timeout = opts.timeout ?? 30000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._client.off('Network.responseReceived', handler);
                reject(new Error(`waitForResponse timed out after ${timeout}ms`));
            }, timeout);
            const handler = (params) => {
                const url = params.response?.url ?? '';
                if (typeof predicate === 'function' ? predicate({ url: () => url }) : url.includes(predicate)) {
                    clearTimeout(timer);
                    this._client.off('Network.responseReceived', handler);
                    resolve({ url: () => url, status: () => params.response?.status });
                }
            };
            this._client.on('Network.responseReceived', handler);
        });
    }

    async waitForFunction(expression, opts = {}) {
        const timeout = opts.timeout ?? 30000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                const result = await evaluate(this._client, expression, { sessionId: this._sessionId });
                if (result) return result;
            } catch { /* retry */ }
            await new Promise(r => setTimeout(r, 100));
        }
        throw new Error(`waitForFunction timed out after ${timeout}ms`);
    }

    // ── Input ────────────────────────────────────────────────────────────────

    async press(selector, key) {
        if (selector) {
            const loc = this.locator(selector);
            await loc.focus();
        }
        await this.keyboard.press(key);
    }

    async tap(selector) {
        const loc = this.locator(selector);
        const nodeId = await loc._resolve();
        await scrollIntoView(this._client, nodeId, { sessionId: this._sessionId });
        const box = await getBoxModel(this._client, nodeId, { sessionId: this._sessionId });
        await this._client.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: box.centerX, y: box.centerY }],
        }, this._sessionId);
        await this._client.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
        }, this._sessionId);
    }

    // ── Misc Page API ──────────────────────────────────────────────────────

    async setViewportSize(size) {
        await setViewport(this._client, size.width, size.height, { sessionId: this._sessionId });
    }

    async addScriptTag(opts = {}) {
        if (opts.content) {
            await evaluate(this._client, `{
                const s = document.createElement('script');
                s.textContent = ${JSON.stringify(opts.content)};
                document.head.appendChild(s);
            }`, { sessionId: this._sessionId });
        } else if (opts.url) {
            await evaluate(this._client, `new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = ${JSON.stringify(opts.url)};
                s.onload = resolve;
                s.onerror = reject;
                document.head.appendChild(s);
            })`, { sessionId: this._sessionId });
        }
    }

    async addStyleTag(opts = {}) {
        if (opts.content) {
            await evaluate(this._client, `{
                const s = document.createElement('style');
                s.textContent = ${JSON.stringify(opts.content)};
                document.head.appendChild(s);
            }`, { sessionId: this._sessionId });
        } else if (opts.url) {
            await evaluate(this._client, `new Promise((resolve, reject) => {
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = ${JSON.stringify(opts.url)};
                link.onload = resolve;
                link.onerror = reject;
                document.head.appendChild(link);
            })`, { sessionId: this._sessionId });
        }
    }

    async exposeFunction(name, fn) {
        // CDP: bind a function via Runtime.addBinding, then set up listener
        await this._client.send('Runtime.addBinding', { name }, this._sessionId);
        // Inject wrapper that calls console.debug with a special prefix so we can catch it
        await evaluate(this._client, `
            window.${name} = (...args) => {
                return new Promise((resolve) => {
                    // Exposed function stub — actual implementation lives in Node
                    resolve(undefined);
                });
            };
        `, { sessionId: this._sessionId });
    }

    async emulateMedia(opts = {}) {
        if (opts.media) {
            await this._client.send('Emulation.setEmulatedMedia', {
                media: opts.media,
            }, this._sessionId);
        }
        if (opts.colorScheme) {
            await this._client.send('Emulation.setEmulatedMedia', {
                features: [{ name: 'prefers-color-scheme', value: opts.colorScheme }],
            }, this._sessionId);
        }
    }

    async bringToFront() {
        await this._client.send('Page.bringToFront', {}, this._sessionId);
    }

    async pause() {
        // No-op in raw CDP mode
        console.warn('page.pause() is not available in raw CDP mode');
    }

    // ── Frame support (minimal) ──────────────────────────────────────────────

    mainFrame() {
        return this; // CDPPage acts as its own main frame for basic operations
    }

    frame(opts) {
        // Stub: frame selection needs iframe target management
        // In most agent-browser use cases, main frame is sufficient
        return null;
    }

    // ── Context reference ────────────────────────────────────────────────────

    context() {
        return this._contextRef;
    }

    // ── Video (not available in CDP mode) ────────────────────────────────────

    video() {
        return null; // Video recording via page.video() is not available in raw CDP mode
    }
}

// ─── CDPContext ───────────────────────────────────────────────────────────────
// Minimal BrowserContext API via CDP.

class CDPContext {
    constructor(client) {
        this._client = client;
        this._pages = [];
        this._extraHeaders = {};
        this._offline = false;
    }

    pages() {
        return this._pages;
    }

    async newPage() {
        const targetId = await createTarget(this._client);
        const sessionId = await attachToTarget(this._client, targetId);
        await enableDomains(this._client, sessionId);
        // Apply stored headers
        if (Object.keys(this._extraHeaders).length > 0) {
            await this._client.send('Network.setExtraHTTPHeaders', { headers: this._extraHeaders }, sessionId);
        }
        const page = new CDPPage(this._client, sessionId, targetId);
        page._contextRef = this;
        this._pages.push(page);
        return page;
    }

    setDefaultTimeout(ms) {
        // Stored but not enforced at context level (timeouts applied per-operation)
        this._defaultTimeout = ms;
    }

    async setExtraHTTPHeaders(headers) {
        this._extraHeaders = headers;
        for (const page of this._pages) {
            await this._client.send('Network.setExtraHTTPHeaders', { headers }, page._sessionId);
        }
    }

    async setGeolocation(geo) {
        for (const page of this._pages) {
            await this._client.send('Emulation.setGeolocation', geo, page._sessionId);
        }
    }

    async grantPermissions(permissions) {
        for (const page of this._pages) {
            await this._client.send('Browser.grantPermissions', {
                permissions: permissions.map(p => p.replace(/-/g, '')), // CDP uses camelCase
            }, page._sessionId).catch(() => {});
        }
    }

    async clearPermissions() {
        await this._client.send('Browser.resetPermissions').catch(() => {});
    }

    async setOffline(offline) {
        this._offline = offline;
        for (const page of this._pages) {
            await this._client.send('Network.emulateNetworkConditions', {
                offline,
                latency: 0,
                downloadThroughput: -1,
                uploadThroughput: -1,
            }, page._sessionId);
        }
    }

    async storageState(opts = {}) {
        // Get cookies via CDP
        const { cookies } = await this._client.send('Network.getAllCookies');
        // Get localStorage per page via evaluation
        const origins = [];
        for (const page of this._pages) {
            try {
                const url = page.url();
                if (!url || url === 'about:blank') continue;
                const origin = new URL(url).origin;
                const storage = await evaluate(this._client, `
                    JSON.stringify(Object.entries(localStorage).map(([k, v]) => ({name: k, value: v})))
                `, { sessionId: page._sessionId });
                origins.push({ origin, localStorage: JSON.parse(storage || '[]') });
            } catch { /* skip */ }
        }
        const state = { cookies, origins };
        if (opts.path) {
            const { writeFile: wf } = await import('node:fs/promises');
            await wf(opts.path, JSON.stringify(state, null, 2));
        }
        return state;
    }

    on(event, handler) {
        // Context-level event emitter stub for 'page' events
        if (!this._eventHandlers) this._eventHandlers = new Map();
        if (!this._eventHandlers.has(event)) this._eventHandlers.set(event, []);
        this._eventHandlers.get(event).push(handler);
    }

    _emit(event, ...args) {
        if (this._eventHandlers) {
            const handlers = this._eventHandlers.get(event);
            if (handlers) {
                for (const h of handlers) {
                    try { h(...args); } catch { /* ignore */ }
                }
            }
        }
    }

    async close() {
        for (const page of this._pages) {
            try {
                await closeTarget(this._client, page._targetId);
            } catch { /* ignore */ }
        }
        this._pages = [];
    }

    // Tracing stubs — replaced by CDP profiling in BrowserManager
    get tracing() {
        return {
            start: async () => { throw new Error('Use profiling commands instead of tracing with raw CDP'); },
            stop: async () => { throw new Error('Use profiling commands instead of tracing with raw CDP'); },
        };
    }
}

// ─── Fetch Domain (request interception) ─────────────────────────────────────

class CDPRequestInterceptor {
    constructor(client, sessionId) {
        this._client = client;
        this._sessionId = sessionId;
        this._routes = new Map(); // pattern → handler
        this._enabled = false;
        this._handler = null;
    }

    async enable() {
        if (this._enabled) return;
        await this._client.send('Fetch.enable', {
            patterns: [{ requestStage: 'Request' }],
        }, this._sessionId);
        this._handler = async (params) => {
            const url = params.request?.url ?? '';
            let handled = false;
            for (const [pattern, handler] of this._routes) {
                if (this._matchPattern(url, pattern)) {
                    await handler({
                        request: () => ({
                            url: () => url,
                            method: () => params.request?.method ?? 'GET',
                            headers: () => Object.fromEntries(
                                (params.request?.headers ?? []).map(h => [h.name.toLowerCase(), h.value])
                            ),
                            resourceType: () => params.resourceType ?? 'other',
                        }),
                        abort: async () => {
                            await this._client.send('Fetch.failRequest', {
                                requestId: params.requestId,
                                reason: 'Aborted',
                            }, this._sessionId);
                        },
                        fulfill: async (opts) => {
                            await this._client.send('Fetch.fulfillRequest', {
                                requestId: params.requestId,
                                responseCode: opts.status ?? 200,
                                body: opts.body ? Buffer.from(opts.body).toString('base64') : undefined,
                                responseHeaders: [
                                    { name: 'Content-Type', value: opts.contentType ?? 'text/plain' },
                                    ...(opts.headers ? Object.entries(opts.headers).map(([k, v]) => ({ name: k, value: v })) : []),
                                ],
                            }, this._sessionId);
                        },
                        continue: async (overrides = {}) => {
                            const params2 = { requestId: params.requestId };
                            if (overrides.headers) {
                                params2.headers = Object.entries(overrides.headers).map(([k, v]) => ({ name: k, value: v }));
                            }
                            await this._client.send('Fetch.continueRequest', params2, this._sessionId);
                        },
                    });
                    handled = true;
                    break;
                }
            }
            if (!handled) {
                await this._client.send('Fetch.continueRequest', { requestId: params.requestId }, this._sessionId);
            }
        };
        this._client.on('Fetch.requestPaused', this._handler);
        this._enabled = true;
    }

    async disable() {
        if (!this._enabled) return;
        if (this._handler) {
            this._client.off('Fetch.requestPaused', this._handler);
        }
        await this._client.send('Fetch.disable', {}, this._sessionId).catch(() => {});
        this._enabled = false;
        this._routes.clear();
    }

    _matchPattern(url, pattern) {
        if (pattern === '**/*' || pattern === '*') return true;
        // Convert glob to regex
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '@@').replace(/\*/g, '[^/]*').replace(/@@/g, '.*');
        return new RegExp(escaped).test(url);
    }

    async addRoute(pattern, handler) {
        this._routes.set(pattern, handler);
        if (!this._enabled) await this.enable();
    }

    async removeRoute(pattern) {
        this._routes.delete(pattern);
        if (this._routes.size === 0) await this.disable();
    }

    async removeAllRoutes() {
        this._routes.clear();
        await this.disable();
    }
}


// ─── BrowserManager ──────────────────────────────────────────────────────────
/**
 * Manages the browser lifecycle with multiple tabs/windows.
 * Raw CDP implementation — no external browser automation library.
 */
export class BrowserManager {
    // Core state
    client = null;         // CDPClient instance
    _targets = [];         // Array of { targetId, sessionId, page: CDPPage }
    cdpEndpoint = null;
    isPersistentContext = false;

    // Cloud provider state
    browserbaseSessionId = null;
    browserbaseApiKey = null;
    browserUseSessionId = null;
    browserUseApiKey = null;
    kernelSessionId = null;
    kernelApiKey = null;

    // Compatibility fields
    browser = null;
    contexts = [];
    pages = [];
    activePageIndex = 0;
    activeFrame = null;
    dialogHandler = null;
    trackedRequests = [];
    routes = new Map();
    consoleMessages = [];
    pageErrors = [];
    isRecordingHar = false;
    refMap = {};
    lastSnapshot = '';
    scopedHeaderRoutes = new Map();
    launchWarnings = [];

    // CDP session (screencast/input injection uses the client directly now)
    cdpSession = null;
    screencastActive = false;
    screencastSessionId = 0;
    frameCallback = null;
    screencastFrameHandler = null;

    // Video recording (not available in CDP mode — stubs)
    recordingContext = null;
    recordingPage = null;
    recordingOutputPath = '';
    recordingTempDir = '';

    // CDP profiling state
    static MAX_PROFILE_EVENTS = 5_000_000;
    profilingActive = false;
    profileChunks = [];
    profileEventsDropped = false;
    profileCompleteResolver = null;
    profileDataHandler = null;
    profileCompleteHandler = null;

    // Request interceptor
    _interceptor = null;

    getAndClearWarnings() {
        const warnings = this.launchWarnings;
        this.launchWarnings = [];
        return warnings;
    }

    isLaunched() {
        return this.client !== null || this.isPersistentContext;
    }

    async getSnapshot(options) {
        const page = this.getPage();
        const snapshot = await getEnhancedSnapshot(page, options);
        this.refMap = snapshot.refs;
        this.lastSnapshot = snapshot.tree;
        return snapshot;
    }

    getLastSnapshot() { return this.lastSnapshot; }
    setLastSnapshot(snapshot) { this.lastSnapshot = snapshot; }
    getRefMap() { return this.refMap; }

    getLocatorFromRef(refArg) {
        const ref = parseRef(refArg);
        if (!ref) return null;
        const refData = this.refMap[ref];
        if (!refData) return null;
        const page = this.getPage();
        // Cursor-interactive elements use CSS selector
        if (refData.role === 'clickable' || refData.role === 'focusable') {
            return page.locator(refData.selector);
        }
        // ARIA role+name
        let locator = refData.name
            ? page.getByRole(refData.role, { name: refData.name, exact: true })
            : page.getByRole(refData.role);
        if (refData.nth !== undefined) {
            locator = locator.nth(refData.nth);
        }
        return locator;
    }

    isRef(selector) { return parseRef(selector) !== null; }

    getLocator(selectorOrRef) {
        const locator = this.getLocatorFromRef(selectorOrRef);
        if (locator) return locator;
        return this.getPage().locator(selectorOrRef);
    }

    hasPages() { return this.pages.length > 0; }

    async ensurePage() {
        if (this.pages.length > 0) return;
        if (!this.client) return;
        // Create a new page target
        const targetId = await createTarget(this.client);
        const sessionId = await attachToTarget(this.client, targetId);
        await enableDomains(this.client, sessionId);
        const page = new CDPPage(this.client, sessionId, targetId);
        const ctx = this.contexts[0];
        if (ctx) {
            page._contextRef = ctx;
            ctx._pages.push(page);
        }
        this.pages.push(page);
        this._targets.push({ targetId, sessionId, page });
        this.activePageIndex = this.pages.length - 1;
    }

    getPage() {
        if (this.pages.length === 0) {
            throw new Error('Browser not launched. Call launch first.');
        }
        return this.pages[this.activePageIndex];
    }

    getFrame() {
        if (this.activeFrame) return this.activeFrame;
        return this.getPage().mainFrame();
    }

    async switchToFrame(options) {
        // Frame switching is limited in raw CDP (requires target management for OOPIFs)
        // Basic support: find iframe by selector and switch
        if (options.selector) {
            // For now, just store the fact that we're in a frame
            this.activeFrame = this.getPage(); // simplified
        } else if (options.name || options.url) {
            this.activeFrame = this.getPage(); // simplified
        }
    }

    switchToMainFrame() { this.activeFrame = null; }

    setDialogHandler(response, promptText) {
        const page = this.getPage();
        // Clean up previous handler
        if (this._dialogCleanup) this._dialogCleanup();
        this._dialogCleanup = handleDialogs(this.client, {
            accept: response === 'accept',
            promptText,
        });
    }

    clearDialogHandler() {
        if (this._dialogCleanup) {
            this._dialogCleanup();
            this._dialogCleanup = null;
        }
    }

    startRequestTracking() {
        const handler = (params) => {
            this.trackedRequests.push({
                url: params.request?.url ?? '',
                method: params.request?.method ?? 'GET',
                headers: params.request?.headers ?? {},
                timestamp: Date.now(),
                resourceType: params.type ?? 'other',
            });
        };
        const page = this.getPage();
        this.client.on('Network.requestWillBeSent', handler);
        this._requestTrackingHandler = handler;
    }

    getRequests(filter) {
        if (filter) return this.trackedRequests.filter(r => r.url.includes(filter));
        return this.trackedRequests;
    }

    clearRequests() { this.trackedRequests = []; }

    async addRoute(url, options) {
        const page = this.getPage();
        if (!this._interceptor) {
            this._interceptor = new CDPRequestInterceptor(this.client, page._sessionId);
        }
        const handler = async (route) => {
            if (options.abort) {
                await route.abort();
            } else if (options.response) {
                await route.fulfill({
                    status: options.response.status ?? 200,
                    body: options.response.body ?? '',
                    contentType: options.response.contentType ?? 'text/plain',
                    headers: options.response.headers,
                });
            } else {
                await route.continue();
            }
        };
        this.routes.set(url, handler);
        await this._interceptor.addRoute(url, handler);
    }

    async removeRoute(url) {
        if (!this._interceptor) return;
        if (url) {
            this.routes.delete(url);
            await this._interceptor.removeRoute(url);
        } else {
            this.routes.clear();
            await this._interceptor.removeAllRoutes();
        }
    }

    async setGeolocation(latitude, longitude, accuracy) {
        const page = this.getPage();
        await this.client.send('Emulation.setGeolocation', { latitude, longitude, accuracy }, page._sessionId);
    }

    async setPermissions(permissions, grant) {
        if (grant) {
            await this.client.send('Browser.grantPermissions', {
                permissions: permissions.map(p => p.replace(/-/g, '')),
            }).catch(() => {});
        } else {
            await this.client.send('Browser.resetPermissions').catch(() => {});
        }
    }

    async setViewport(width, height) {
        const page = this.getPage();
        await setViewport(this.client, width, height, { sessionId: page._sessionId });
    }

    async setDeviceScaleFactor(deviceScaleFactor, width, height, mobile = false) {
        const page = this.getPage();
        await this.client.send('Emulation.setDeviceMetricsOverride', {
            width, height, deviceScaleFactor, mobile,
        }, page._sessionId);
    }

    async clearDeviceMetricsOverride() {
        const page = this.getPage();
        await this.client.send('Emulation.clearDeviceMetricsOverride', {}, page._sessionId);
    }

    getDevice(deviceName) { return DEVICES[deviceName]; }
    listDevices() { return Object.keys(DEVICES); }

    startConsoleTracking() {
        const page = this.getPage();
        if (page._consoleUnsubscribe) page._consoleUnsubscribe();
        page._consoleUnsubscribe = trackConsole(this.client, this.consoleMessages);
    }

    getConsoleMessages() { return this.consoleMessages; }
    clearConsoleMessages() { this.consoleMessages = []; }

    startErrorTracking() {
        const page = this.getPage();
        if (page._errorUnsubscribe) page._errorUnsubscribe();
        page._errorUnsubscribe = trackErrors(this.client, this.pageErrors);
    }

    getPageErrors() { return this.pageErrors; }
    clearPageErrors() { this.pageErrors = []; }

    async startHarRecording() { this.isRecordingHar = true; }
    isHarRecording() { return this.isRecordingHar; }

    async setOffline(offline) {
        const page = this.getPage();
        await this.client.send('Network.emulateNetworkConditions', {
            offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        }, page._sessionId);
    }

    async setExtraHeaders(headers) {
        const page = this.getPage();
        await this.client.send('Network.setExtraHTTPHeaders', { headers }, page._sessionId);
    }

    async setScopedHeaders(origin, headers) {
        const page = this.getPage();
        let urlPattern;
        try {
            const url = new URL(origin.startsWith('http') ? origin : `https://${origin}`);
            urlPattern = `**://${url.host}/**`;
        } catch {
            urlPattern = `**://${origin}/**`;
        }
        // Use request interception
        if (!this._interceptor) {
            this._interceptor = new CDPRequestInterceptor(this.client, page._sessionId);
        }
        const handler = async (route) => {
            const requestHeaders = route.request().headers();
            await route.continue({
                headers: safeHeaderMerge(requestHeaders, headers),
            });
        };
        this.scopedHeaderRoutes.set(urlPattern, handler);
        await this._interceptor.addRoute(urlPattern, handler);
    }

    async clearScopedHeaders(origin) {
        if (!this._interceptor) return;
        if (origin) {
            let urlPattern;
            try {
                const url = new URL(origin.startsWith('http') ? origin : `https://${origin}`);
                urlPattern = `**://${url.host}/**`;
            } catch {
                urlPattern = `**://${origin}/**`;
            }
            this.scopedHeaderRoutes.delete(urlPattern);
            await this._interceptor.removeRoute(urlPattern);
        } else {
            this.scopedHeaderRoutes.clear();
            await this._interceptor.removeAllRoutes();
        }
    }

    async startTracing(options) {
        // Redirect to CDP profiling
        await this.startProfiling({ categories: options?.categories });
    }

    async stopTracing(path) {
        if (path) {
            await this.stopProfiling(path);
        }
    }

    getContext() {
        return this.contexts[0] ?? null;
    }

    async saveStorageState(path) {
        const ctx = this.contexts[0];
        if (ctx) {
            await ctx.storageState({ path });
        }
    }

    getPages() { return this.pages; }
    getActiveIndex() { return this.activePageIndex; }

    getBrowser() { return this.client; /* return client as "browser" for compatibility */ }

    isCdpConnectionAlive() {
        if (!this.client) return false;
        return this.client.isConnected();
    }

    needsCdpReconnect(cdpEndpoint) {
        if (!this.client?.isConnected()) return true;
        if (this.cdpEndpoint !== cdpEndpoint) return true;
        if (!this.isCdpConnectionAlive()) return true;
        return false;
    }

    // ── Cloud Providers ──────────────────────────────────────────────────────

    async closeBrowserbaseSession(sessionId, apiKey) {
        await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
            method: 'DELETE',
            headers: { 'X-BB-API-Key': apiKey },
        });
    }

    async closeBrowserUseSession(sessionId, apiKey) {
        const response = await fetch(`https://api.browser-use.com/api/v2/browsers/${sessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Browser-Use-API-Key': apiKey },
            body: JSON.stringify({ action: 'stop' }),
        });
        if (!response.ok) throw new Error(`Failed to close Browser Use session: ${response.statusText}`);
    }

    async closeKernelSession(sessionId, apiKey) {
        const response = await fetch(`https://api.onkernel.com/browsers/${sessionId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!response.ok) throw new Error(`Failed to close Kernel session: ${response.statusText}`);
    }

    async connectToBrowserbase() {
        const browserbaseApiKey = process.env.BROWSERBASE_API_KEY;
        const browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID;
        if (!browserbaseApiKey || !browserbaseProjectId) {
            throw new Error('BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required when using browserbase as a provider');
        }
        const response = await fetch('https://api.browserbase.com/v1/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-BB-API-Key': browserbaseApiKey },
            body: JSON.stringify({ projectId: browserbaseProjectId }),
        });
        if (!response.ok) throw new Error(`Failed to create Browserbase session: ${response.statusText}`);
        const session = await response.json();

        // Connect via raw CDP
        await this._connectToWsUrl(session.connectUrl);
        this.browserbaseSessionId = session.id;
        this.browserbaseApiKey = browserbaseApiKey;
    }

    async findOrCreateKernelProfile(profileName, apiKey) {
        const getResponse = await fetch(`https://api.onkernel.com/profiles/${encodeURIComponent(profileName)}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (getResponse.ok) return { name: profileName };
        if (getResponse.status !== 404) throw new Error(`Failed to check Kernel profile: ${getResponse.statusText}`);
        const createResponse = await fetch('https://api.onkernel.com/profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ name: profileName }),
        });
        if (!createResponse.ok) throw new Error(`Failed to create Kernel profile: ${createResponse.statusText}`);
        return { name: profileName };
    }

    async connectToKernel() {
        const kernelApiKey = process.env.KERNEL_API_KEY;
        if (!kernelApiKey) throw new Error('KERNEL_API_KEY is required when using kernel as a provider');
        const profileName = process.env.KERNEL_PROFILE_NAME;
        let profileConfig;
        if (profileName) {
            await this.findOrCreateKernelProfile(profileName, kernelApiKey);
            profileConfig = { profile: { name: profileName, save_changes: true } };
        }
        const response = await fetch('https://api.onkernel.com/browsers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${kernelApiKey}` },
            body: JSON.stringify({
                headless: process.env.KERNEL_HEADLESS?.toLowerCase() === 'true',
                stealth: process.env.KERNEL_STEALTH?.toLowerCase() !== 'false',
                timeout_seconds: parseInt(process.env.KERNEL_TIMEOUT_SECONDS || '300', 10),
                ...profileConfig,
            }),
        });
        if (!response.ok) throw new Error(`Failed to create Kernel session: ${response.statusText}`);
        let session;
        try { session = await response.json(); }
        catch (error) { throw new Error(`Failed to parse Kernel session response: ${error instanceof Error ? error.message : String(error)}`); }
        if (!session.session_id || !session.cdp_ws_url) {
            throw new Error(`Invalid Kernel session response: missing ${!session.session_id ? 'session_id' : 'cdp_ws_url'}`);
        }
        await this._connectToWsUrl(session.cdp_ws_url);
        this.kernelSessionId = session.session_id;
        this.kernelApiKey = kernelApiKey;
    }

    async connectToBrowserUse() {
        const browserUseApiKey = process.env.BROWSER_USE_API_KEY;
        if (!browserUseApiKey) throw new Error('BROWSER_USE_API_KEY is required when using browseruse as a provider');
        const response = await fetch('https://api.browser-use.com/api/v2/browsers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Browser-Use-API-Key': browserUseApiKey },
            body: JSON.stringify({}),
        });
        if (!response.ok) throw new Error(`Failed to create Browser Use session: ${response.statusText}`);
        let session;
        try { session = await response.json(); }
        catch (error) { throw new Error(`Failed to parse Browser Use session response: ${error instanceof Error ? error.message : String(error)}`); }
        if (!session.id || !session.cdpUrl) {
            throw new Error(`Invalid Browser Use session response: missing ${!session.id ? 'id' : 'cdpUrl'}`);
        }
        await this._connectToWsUrl(session.cdpUrl);
        this.browserUseSessionId = session.id;
        this.browserUseApiKey = browserUseApiKey;
    }

    /**
     * Shared method: Connect to a WebSocket URL, discover targets, set up pages.
     */
    async _connectToWsUrl(wsUrl) {
        const client = new CDPClient();
        await client.connect(wsUrl);
        this.client = client;

        const ctx = new CDPContext(client);
        this.contexts.push(ctx);

        // Session isolation: always create a fresh target (tab) for this daemon session.
        // DO NOT attach to existing targets — they belong to other sessions or the user.
        // This prevents the multi-session regression where Daemon A and Daemon B both
        // attach to the same Chrome tab and fight over navigation.
        // See: https://github.com/cyrus-and/chrome-remote-interface/issues/186
        const targetId = await createTarget(client);
        const sessionId = await attachToTarget(client, targetId);
        await enableDomains(client, sessionId);
        const page = new CDPPage(client, sessionId, targetId);
        page._contextRef = ctx;
        ctx._pages.push(page);
        this.pages.push(page);
        this._targets.push({ targetId, sessionId, page });

        this.activePageIndex = 0;
        this.browser = client;

        // Set default viewport to avoid "0 width" screenshot errors.
        await setViewport(client, 1280, 720, { sessionId: page._sessionId }).catch(() => {});
    }

    // ── Launch ───────────────────────────────────────────────────────────────

    async launch(options) {
        const cdpEndpoint = options.cdpUrl ?? (options.cdpPort ? String(options.cdpPort) : undefined);
        const hasExtensions = !!options.extensions?.length;
        const hasProfile = !!options.profile;

        if (hasExtensions && cdpEndpoint) throw new Error('Extensions cannot be used with CDP connection');
        if (hasProfile && cdpEndpoint) throw new Error('Profile cannot be used with CDP connection');

        // Extensions and profiles require a browser launcher (not available in raw CDP)
        if (hasExtensions) throw new Error('Extensions are not supported in raw CDP mode. Use a pre-launched Chrome with extensions instead.');
        if (hasProfile) throw new Error('Persistent profiles are not supported in raw CDP mode. Launch Chrome with --user-data-dir instead.');

        if (this.isLaunched()) {
            const needsRelaunch = (!cdpEndpoint && !options.autoConnect && this.cdpEndpoint !== null) ||
                (!!cdpEndpoint && this.needsCdpReconnect(cdpEndpoint)) ||
                (!!options.autoConnect && !this.isCdpConnectionAlive());
            if (needsRelaunch) {
                await this.close();
            } else if (options.autoConnect && this.isCdpConnectionAlive()) {
                return;
            } else {
                return;
            }
        }

        if (cdpEndpoint) {
            await this.connectViaCDP(cdpEndpoint);
            return;
        }

        if (options.autoConnect) {
            await this.autoConnectViaCDP();
            return;
        }

        const provider = options.provider ?? process.env.AGENT_BROWSER_PROVIDER;
        if (provider === 'browserbase') { await this.connectToBrowserbase(); return; }
        if (provider === 'browseruse') { await this.connectToBrowserUse(); return; }
        if (provider === 'kernel') { await this.connectToKernel(); return; }

        // No CDP endpoint and no cloud provider — raw CDP requires an existing Chrome instance
        // Try auto-connect as fallback
        try {
            await this.autoConnectViaCDP();
        } catch {
            throw new Error(
                'Raw CDP mode requires a running Chrome instance with remote debugging enabled.\n' +
                'Start Chrome with: google-chrome --remote-debugging-port=9222\n' +
                'Or use: agent-browser launch --cdp-port 9222'
            );
        }
    }

    async connectViaCDP(cdpEndpoint) {
        if (!cdpEndpoint) throw new Error('CDP endpoint is required for CDP connection');
        let cdpUrl;
        if (cdpEndpoint.startsWith('ws://') || cdpEndpoint.startsWith('wss://') ||
            cdpEndpoint.startsWith('http://') || cdpEndpoint.startsWith('https://')) {
            cdpUrl = cdpEndpoint;
        } else if (/^\d+$/.test(cdpEndpoint)) {
            cdpUrl = `http://localhost:${cdpEndpoint}`;
        } else {
            cdpUrl = `http://localhost:${cdpEndpoint}`;
        }

        try {
            await this._connectToWsUrl(cdpUrl);
        } catch {
            throw new Error(`Failed to connect via CDP to ${cdpUrl}. ` +
                (cdpUrl.includes('localhost')
                    ? `Make sure the app is running with --remote-debugging-port=${cdpEndpoint}`
                    : 'Make sure the remote browser is accessible and the URL is correct.'));
        }

        if (this.pages.length === 0) {
            throw new Error('No page found. Make sure the app has loaded content.');
        }
        this.cdpEndpoint = cdpEndpoint;
    }

    getChromeUserDataDirs() {
        const home = os.homedir();
        const platform = os.platform();
        if (platform === 'darwin') {
            return [
                path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
                path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary'),
                path.join(home, 'Library', 'Application Support', 'Chromium'),
            ];
        } else if (platform === 'win32') {
            const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
            return [
                path.join(localAppData, 'Google', 'Chrome', 'User Data'),
                path.join(localAppData, 'Google', 'Chrome SxS', 'User Data'),
                path.join(localAppData, 'Chromium', 'User Data'),
            ];
        } else {
            return [
                path.join(home, '.config', 'google-chrome'),
                path.join(home, '.config', 'google-chrome-unstable'),
                path.join(home, '.config', 'chromium'),
            ];
        }
    }

    readDevToolsActivePort(userDataDir) {
        const filePath = path.join(userDataDir, 'DevToolsActivePort');
        try {
            if (!existsSync(filePath)) return null;
            const content = readFileSync(filePath, 'utf-8').trim();
            const lines = content.split('\n');
            if (lines.length < 2) return null;
            const port = parseInt(lines[0].trim(), 10);
            const wsPath = lines[1].trim();
            if (isNaN(port) || port <= 0 || port > 65535) return null;
            if (!wsPath) return null;
            return { port, wsPath };
        } catch {
            return null;
        }
    }

    async probeDebugPort(port) {
        return probeDebugPort(port);
    }

    async autoConnectViaCDP() {
        // Strategy 1: Check DevToolsActivePort files
        const userDataDirs = this.getChromeUserDataDirs();
        for (const dir of userDataDirs) {
            const activePort = this.readDevToolsActivePort(dir);
            if (activePort) {
                const wsUrl = await this.probeDebugPort(activePort.port);
                if (wsUrl) {
                    await this.connectViaCDP(wsUrl);
                    return;
                }
                try {
                    await this.connectViaCDP(`http://127.0.0.1:${activePort.port}`);
                    return;
                } catch { /* try next */ }
            }
        }
        // Strategy 2: Probe common ports
        const commonPorts = [9222, 9229];
        for (const port of commonPorts) {
            const wsUrl = await this.probeDebugPort(port);
            if (wsUrl) {
                await this.connectViaCDP(wsUrl);
                return;
            }
        }
        const platform = os.platform();
        let hint;
        if (platform === 'darwin') {
            hint = 'Start Chrome with: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n' +
                'Or enable remote debugging in Chrome 144+ at chrome://inspect/#remote-debugging';
        } else if (platform === 'win32') {
            hint = 'Start Chrome with: chrome.exe --remote-debugging-port=9222\n' +
                'Or enable remote debugging in Chrome 144+ at chrome://inspect/#remote-debugging';
        } else {
            hint = 'Start Chrome with: google-chrome --remote-debugging-port=9222\n' +
                'Or enable remote debugging in Chrome 144+ at chrome://inspect/#remote-debugging';
        }
        throw new Error(`No running Chrome instance with remote debugging found.\n${hint}`);
    }

    // ── Tab Management ───────────────────────────────────────────────────────

    async newTab() {
        if (!this.client) throw new Error('Browser not launched');
        const ctx = this.contexts[0];
        const targetId = await createTarget(this.client);
        const sessionId = await attachToTarget(this.client, targetId);
        await enableDomains(this.client, sessionId);
        const page = new CDPPage(this.client, sessionId, targetId);
        if (ctx) {
            page._contextRef = ctx;
            ctx._pages.push(page);
        }
        this.pages.push(page);
        this._targets.push({ targetId, sessionId, page });
        this.activePageIndex = this.pages.length - 1;
        return { index: this.activePageIndex, total: this.pages.length };
    }

    async newWindow(viewport) {
        // In CDP, a new "window" is just another target
        return this.newTab();
    }

    async invalidateCDPSession() {
        if (this.screencastActive) await this.stopScreencast();
        // In raw CDP, cdpSession is the client itself — no detach needed
        this.cdpSession = null;
    }

    async switchTo(index) {
        if (index < 0 || index >= this.pages.length) {
            throw new Error(`Invalid tab index: ${index}. Available: 0-${this.pages.length - 1}`);
        }
        if (index !== this.activePageIndex) {
            await this.invalidateCDPSession();
        }
        this.activePageIndex = index;
        const page = this.pages[index];
        return { index, url: page.url(), title: '' };
    }

    async closeTab(index) {
        const targetIndex = index ?? this.activePageIndex;
        if (targetIndex < 0 || targetIndex >= this.pages.length) {
            throw new Error(`Invalid tab index: ${targetIndex}`);
        }
        if (this.pages.length === 1) {
            throw new Error('Cannot close the last tab. Use "close" to close the browser.');
        }
        if (targetIndex === this.activePageIndex) await this.invalidateCDPSession();
        const page = this.pages[targetIndex];
        try { await closeTarget(this.client, page._targetId); } catch { /* ignore */ }
        this.pages.splice(targetIndex, 1);
        this._targets = this._targets.filter(t => t.page !== page);
        const ctx = page._contextRef;
        if (ctx) ctx._pages = ctx._pages.filter(p => p !== page);

        if (this.activePageIndex >= this.pages.length) {
            this.activePageIndex = this.pages.length - 1;
        } else if (this.activePageIndex > targetIndex) {
            this.activePageIndex--;
        }
        return { closed: targetIndex, remaining: this.pages.length };
    }

    async listTabs() {
        const tabs = await Promise.all(this.pages.map(async (page, index) => ({
            index,
            url: page.url(),
            title: await page.title().catch(() => ''),
            active: index === this.activePageIndex,
        })));
        return tabs;
    }

    // ── CDP Session (for screencast/profiling/input injection) ───────────────

    async getCDPSession() {
        // Return the client directly — it already has send/on/off
        // Use the active page's sessionId
        const page = this.getPage();
        if (!this.cdpSession) {
            this.cdpSession = {
                send: (method, params) => this.client.send(method, params, page._sessionId),
                on: (event, handler) => this.client.on(event, handler),
                off: (event, handler) => this.client.off(event, handler),
                detach: async () => { this.cdpSession = null; },
            };
        }
        return this.cdpSession;
    }

    isScreencasting() { return this.screencastActive; }

    async startScreencast(callback, options) {
        if (this.screencastActive) throw new Error('Screencast already active');
        const cdp = await this.getCDPSession();
        this.frameCallback = callback;
        this.screencastActive = true;
        this.screencastFrameHandler = async (params) => {
            const frame = { data: params.data, metadata: params.metadata, sessionId: params.sessionId };
            await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId });
            if (this.frameCallback) this.frameCallback(frame);
        };
        cdp.on('Page.screencastFrame', this.screencastFrameHandler);
        await cdp.send('Page.startScreencast', {
            format: options?.format ?? 'jpeg',
            quality: options?.quality ?? 80,
            maxWidth: options?.maxWidth ?? 1280,
            maxHeight: options?.maxHeight ?? 720,
            everyNthFrame: options?.everyNthFrame ?? 1,
        });
    }

    async stopScreencast() {
        if (!this.screencastActive) return;
        try {
            const cdp = await this.getCDPSession();
            await cdp.send('Page.stopScreencast');
            if (this.screencastFrameHandler) cdp.off('Page.screencastFrame', this.screencastFrameHandler);
        } catch { /* ignore */ }
        this.screencastActive = false;
        this.frameCallback = null;
        this.screencastFrameHandler = null;
    }

    // ── Profiling ────────────────────────────────────────────────────────────

    isProfilingActive() { return this.profilingActive; }

    async startProfiling(options) {
        if (this.profilingActive) throw new Error('Profiling already active');
        const cdp = await this.getCDPSession();
        const dataHandler = (params) => {
            if (params.value) {
                for (const evt of params.value) {
                    if (this.profileChunks.length >= BrowserManager.MAX_PROFILE_EVENTS) {
                        if (!this.profileEventsDropped) {
                            this.profileEventsDropped = true;
                            console.warn(`Profiling: exceeded ${BrowserManager.MAX_PROFILE_EVENTS} events, dropping further data`);
                        }
                        return;
                    }
                    this.profileChunks.push(evt);
                }
            }
        };
        const completeHandler = () => {
            if (this.profileCompleteResolver) this.profileCompleteResolver();
        };
        cdp.on('Tracing.dataCollected', dataHandler);
        cdp.on('Tracing.tracingComplete', completeHandler);
        const categories = options?.categories ?? [
            'devtools.timeline', 'disabled-by-default-devtools.timeline',
            'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-devtools.timeline.stack',
            'v8.execute', 'disabled-by-default-v8.cpu_profiler', 'disabled-by-default-v8.cpu_profiler.hires',
            'v8', 'disabled-by-default-v8.runtime_stats', 'blink', 'blink.user_timing',
            'latencyInfo', 'renderer.scheduler', 'sequence_manager', 'toplevel',
        ];
        try {
            await cdp.send('Tracing.start', {
                traceConfig: { includedCategories: categories, enableSampling: true },
                transferMode: 'ReportEvents',
            });
        } catch (error) {
            cdp.off('Tracing.dataCollected', dataHandler);
            cdp.off('Tracing.tracingComplete', completeHandler);
            throw error;
        }
        this.profilingActive = true;
        this.profileChunks = [];
        this.profileEventsDropped = false;
        this.profileDataHandler = dataHandler;
        this.profileCompleteHandler = completeHandler;
    }

    async stopProfiling(outputPath) {
        if (!this.profilingActive) throw new Error('No profiling session active');
        const cdp = await this.getCDPSession();
        const TRACE_TIMEOUT_MS = 30_000;
        const completePromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Profiling data collection timed out')), TRACE_TIMEOUT_MS);
            this.profileCompleteResolver = () => { clearTimeout(timer); resolve(); };
        });
        await cdp.send('Tracing.end');
        let chunks;
        try {
            await completePromise;
            chunks = this.profileChunks;
        } finally {
            if (this.profileDataHandler) cdp.off('Tracing.dataCollected', this.profileDataHandler);
            if (this.profileCompleteHandler) cdp.off('Tracing.tracingComplete', this.profileCompleteHandler);
            this.profilingActive = false;
            this.profileChunks = [];
            this.profileEventsDropped = false;
            this.profileCompleteResolver = null;
            this.profileDataHandler = null;
            this.profileCompleteHandler = null;
        }
        const clockDomain = process.platform === 'linux' ? 'LINUX_CLOCK_MONOTONIC'
            : process.platform === 'darwin' ? 'MAC_MACH_ABSOLUTE_TIME' : undefined;
        const traceData = { traceEvents: chunks };
        if (clockDomain) traceData.metadata = { 'clock-domain': clockDomain };
        const dir = path.dirname(outputPath);
        await mkdir(dir, { recursive: true });
        await writeFile(outputPath, JSON.stringify(traceData));
        return { path: outputPath, eventCount: chunks.length };
    }

    // ── Input Injection ──────────────────────────────────────────────────────

    async injectMouseEvent(params) {
        const page = this.getPage();
        const cdpButton = params.button === 'left' ? 'left'
            : params.button === 'right' ? 'right'
            : params.button === 'middle' ? 'middle' : 'none';
        await this.client.send('Input.dispatchMouseEvent', {
            type: params.type, x: params.x, y: params.y,
            button: cdpButton, clickCount: params.clickCount ?? 1,
            deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? 0,
            modifiers: params.modifiers ?? 0,
        }, page._sessionId);
    }

    async injectKeyboardEvent(params) {
        const page = this.getPage();
        await this.client.send('Input.dispatchKeyEvent', {
            type: params.type, key: params.key, code: params.code,
            text: params.text, modifiers: params.modifiers ?? 0,
        }, page._sessionId);
    }

    async injectTouchEvent(params) {
        const page = this.getPage();
        await this.client.send('Input.dispatchTouchEvent', {
            type: params.type,
            touchPoints: params.touchPoints.map((tp, i) => ({ x: tp.x, y: tp.y, id: tp.id ?? i })),
            modifiers: params.modifiers ?? 0,
        }, page._sessionId);
    }

    // ── Recording (not available in CDP mode — stubs with clear error messages) ─

    isRecording() { return false; }

    async startRecording(outputPath, url) {
        throw new Error('Video recording is not available in raw CDP mode. Use screencast instead.');
    }

    async stopRecording() {
        return { path: '', frames: 0, error: 'Video recording not available in raw CDP mode' };
    }

    async restartRecording(outputPath, url) {
        throw new Error('Video recording is not available in raw CDP mode. Use screencast instead.');
    }

    // ── Close ────────────────────────────────────────────────────────────────

    async close() {
        // Stop screencast if active
        if (this.screencastActive) await this.stopScreencast();

        // Clean up profiling
        if (this.profilingActive) {
            if (this.profileDataHandler) this.client?.off('Tracing.dataCollected', this.profileDataHandler);
            if (this.profileCompleteHandler) this.client?.off('Tracing.tracingComplete', this.profileCompleteHandler);
            try { await this.client?.send('Tracing.end'); } catch { /* ignore */ }
            this.profilingActive = false;
            this.profileChunks = [];
            this.profileEventsDropped = false;
            this.profileCompleteResolver = null;
            this.profileDataHandler = null;
            this.profileCompleteHandler = null;
        }

        // Clean up request interceptor
        if (this._interceptor) {
            await this._interceptor.disable().catch(() => {});
            this._interceptor = null;
        }

        // Close cloud sessions
        if (this.browserbaseSessionId && this.browserbaseApiKey) {
            await this.closeBrowserbaseSession(this.browserbaseSessionId, this.browserbaseApiKey).catch(e => console.error('Failed to close Browserbase session:', e));
        } else if (this.browserUseSessionId && this.browserUseApiKey) {
            await this.closeBrowserUseSession(this.browserUseSessionId, this.browserUseApiKey).catch(e => console.error('Failed to close Browser Use session:', e));
        } else if (this.kernelSessionId && this.kernelApiKey) {
            await this.closeKernelSession(this.kernelSessionId, this.kernelApiKey).catch(e => console.error('Failed to close Kernel session:', e));
        } else if (this.cdpEndpoint !== null) {
            // CDP mode: close targets THIS session created (session isolation cleanup).
            // Only closes our own tabs — other sessions' and user's tabs are untouched.
            for (const target of this._targets) {
                try { await closeTarget(this.client, target.targetId); } catch { /* ignore */ }
            }
        } else {
            // Close pages we created
            for (const target of this._targets) {
                try { await closeTarget(this.client, target.targetId); } catch { /* ignore */ }
            }
        }

        // Close WebSocket
        if (this.client) {
            await this.client.close();
        }

        // Reset all state
        this.client = null;
        this.browser = null;
        this.pages = [];
        this.contexts = [];
        this._targets = [];
        this.cdpEndpoint = null;
        this.browserbaseSessionId = null;
        this.browserbaseApiKey = null;
        this.browserUseSessionId = null;
        this.browserUseApiKey = null;
        this.kernelSessionId = null;
        this.kernelApiKey = null;
        this.isPersistentContext = false;
        this.activePageIndex = 0;
        this.refMap = {};
        this.lastSnapshot = '';
        this.frameCallback = null;
        this.cdpSession = null;
        this._interceptor = null;
    }
}
