/**
 * Browser manager — raw CDP, no external browser automation library.
 * @author Caleb Dane <calebdanemusic@gmail.com>
 */
import path from 'node:path';
import os from 'node:os';
import {
    closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync,
    mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
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
        this._backendNodeId = opts.backendNodeId;
        this._refOwner = opts.refOwner;
        this._requireRefOwner = opts.requireRefOwner === true;
    }

    /**
     * Resolve this locator to a CDP nodeId.
     * - CSS selector → DOM.querySelector
     * - role+name → Accessibility.queryAXTree + DOM node resolution
     */
    async _resolve() {
        const client = this._page._client;
        const sid = this._page._sessionId;
        let documentLoaded = false;

        if (this._requireRefOwner && !this._refOwner) {
            throw new Error('Snapshot ref ownership is unavailable');
        }
        if (this._refOwner) {
            if (this._page._targetId !== this._refOwner.targetId ||
                sid !== this._refOwner.sessionId) {
                throw new Error('Snapshot ref belongs to a different browser target');
            }
            const { root } = await client.send('DOM.getDocument', { depth: 0 }, sid);
            documentLoaded = true;
            if (!Number.isInteger(root?.backendNodeId) ||
                root.backendNodeId !== this._refOwner.documentBackendNodeId) {
                throw new Error('Snapshot ref belongs to a stale document');
            }
        }

        // Snapshot refs are capabilities for one structurally identified DOM
        // node. Never fall back to a same-role/name element when that node is
        // stale: doing so can turn a benign visible ref into a different action.
        if (Number.isInteger(this._backendNodeId)) {
            if (!documentLoaded)
                await client.send('DOM.getDocument', { depth: 0 }, sid);
            const { nodeIds } = await client.send('DOM.pushNodesByBackendIdsToFrontend', {
                backendNodeIds: [this._backendNodeId],
            }, sid);
            if (nodeIds && nodeIds[0] > 0)
                return nodeIds[0];
            throw new Error(`Snapshot ref target is stale (backend node ${this._backendNodeId})`);
        }

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
            backendNodeId: this._backendNodeId,
            refOwner: this._refOwner,
            requireRefOwner: this._requireRefOwner,
        });
    }

    get last() {
        return new CDPLocator(this._page, this._selector, {
            role: this._role,
            name: this._name,
            exact: this._exact,
            nth: -1, // Will resolve to last element
            backendNodeId: this._backendNodeId,
            refOwner: this._refOwner,
            requireRefOwner: this._requireRefOwner,
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

function snapshotRefIdentity(data) {
    if (!Number.isInteger(data?.backendNodeId) ||
        !Number.isInteger(data?.documentBackendNodeId) ||
        typeof data?.targetId !== 'string' ||
        typeof data?.sessionId !== 'string') {
        return null;
    }
    return JSON.stringify([
        data.targetId,
        data.sessionId,
        data.documentBackendNodeId,
        data.backendNodeId,
    ]);
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
            if (params.sessionId && params.sessionId !== this._sessionId) return;
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
        if (parseRef(selector) !== null) {
            throw new Error(`Snapshot ref token must be resolved through BrowserManager: ${selector}`);
        }
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
            await waitForNetworkIdle(this._client, { timeout, sessionId: this._sessionId });
        } else if (state === 'domcontentloaded') {
            await this._client.waitForEvent('Page.domContentEventFired', { timeout, sessionId: this._sessionId });
        } else {
            await this._client.waitForEvent('Page.loadEventFired', { timeout, sessionId: this._sessionId });
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
            return this._client.waitForEvent('Page.downloadWillBegin', { timeout, sessionId: this._sessionId });
        }
        if (eventName === 'response') {
            return this._client.waitForEvent('Network.responseReceived', { timeout, sessionId: this._sessionId });
        }
        return this._client.waitForEvent(eventName, { timeout, sessionId: this._sessionId });
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
        if (this._client?._brokerTransport) throw permissionMutationForbidden();
        for (const page of this._pages) {
            await this._client.send('Browser.grantPermissions', {
                permissions: permissions.map(p => p.replace(/-/g, '')), // CDP uses camelCase
            }, page._sessionId).catch(() => {});
        }
    }

    async clearPermissions() {
        if (this._client?._brokerTransport) throw permissionMutationForbidden();
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

    async cookies(urls) {
        // WHY: Raw CDP contexts do not have Playwright's BrowserContext.cookies
        // helper. Expose the same Agent Browser command through Network.getCookies
        // so account/debug flows can inspect login state without switching tools.
        const page = this._pages.find((candidate) => candidate?._sessionId);
        const effectiveUrls = urls?.length
            ? urls
            : this._pages
                .map((candidate) => candidate.url())
                .filter((url) => url && url !== 'about:blank' && !url.startsWith('chrome:'));
        const params = effectiveUrls.length ? { urls: effectiveUrls } : {};
        const { cookies } = page
            ? await this._client.send('Network.getCookies', params, page._sessionId).catch(async () => {
                return await this._client.send('Storage.getCookies', {});
            })
            : await this._client.send('Storage.getCookies', {});
        return cookies ?? [];
    }

    async addCookies(cookies) {
        for (const cookie of cookies) {
            const params = { ...cookie };
            if (!params.url && !params.domain) {
                const pageUrl = this._pages.find((page) => {
                    const url = page.url();
                    return url && url !== 'about:blank';
                })?.url();
                if (pageUrl) params.url = pageUrl;
            }
            if (!params.url && params.domain && !params.path) {
                params.path = '/';
            }
            const page = this._pages.find((candidate) => candidate?._sessionId);
            const result = await this._client.send('Network.setCookie', params, page?._sessionId);
            if (result?.success === false) {
                throw new Error(`Failed to set cookie '${cookie.name}'`);
            }
        }
    }

    async clearCookies() {
        const page = this._pages.find((candidate) => candidate?._sessionId);
        if (page) {
            await this._client.send('Network.clearBrowserCookies', {}, page._sessionId);
        } else {
            await this._client.send('Storage.clearCookies', {});
        }
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
const TARGET_RECEIPT_SCHEMA = 'agent-browser.target-lease.v1';
const TARGET_CLAIM_ENVELOPE_SCHEMA = 'agent-browser.target-claim-envelope.v2';
const CONTROLLER_ENDPOINT_ID = '9222-31e541860f6a45f39f32';
const PROFILE_ATTESTATION_SCHEMA = 'agent-browser.profile-attestation.v2';
const TRANSPORT_PROOF_STATE_SCHEMA = 'agent-browser.transport-proof-state.v1';
const TRANSPORT_PROOF_MAX_AGE_MS = 5_000;
const STABLE_CHROME_EXECUTABLE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const STABLE_CHROME_USER_DATA_ROOT = 'C:\\Users\\Kaleeb\\AppData\\Local\\Google\\Chrome\\User Data';
const PROFILE_ATTESTATION_MAX_BYTES = 16 * 1024;
const PROFILE_ATTESTATION_MAX_AGE_MS = 120_000;
const PROFILE_ATTESTATION_FUTURE_SKEW_MS = 5_000;
const PROFILE_ATTESTATION_KEYS = [
    'broker_generation', 'browser_generation', 'browser_ownership',
    'cdp_http_url', 'consent_generation', 'expires_at', 'helper_revision',
    'issued_at', 'profile_kind', 'profile_root', 'schema',
    'transport_generation', 'transport_proof_state_path',
    'transport_proof_state_sha256',
].sort();
// WHY: profile metadata is not process proof. Only the exact private artifact
// emitted by the pinned four-owner Windows/WSL transport producer can unlock a
// controller-consumed target receipt; the authenticated broker then rechecks
// that process/generation authority before any Target command is sent.
const TRUSTED_PROFILE_ATTESTATION_HELPER_REVISIONS = new Set([
    'agent-browser.transport-proof-helper.wsl-stable.v2',
]);
const TARGET_RECEIPT_MAX_TTL_MS = 30_000;
const TARGET_RECEIPT_CLOCK_SKEW_MS = 5_000;
const TARGET_RECEIPT_MAX_BYTES = 8 * 1024;
const TARGET_CLAIM_ENVELOPE_MAX_BYTES = 16 * 1024;
const TARGET_CLAIM_PATH_ENV = 'AGENT_BROWSER_TARGET_CLAIM_PATH';
const BROKER_AUTHORIZATION_ENV = 'AGENT_BROWSER_BROKER_AUTHORIZATION';
const TARGET_RECEIPT_KEYS = [
    'accountEmail', 'browserContextId', 'browserGeneration', 'expiresAt', 'issuedAt',
    'leaseId', 'nonce', 'profileBinding', 'profileDirectory', 'schema', 'session', 'targetId', 'targetKind', 'transportGeneration',
    'workspaceMarkerUrl',
];
const TARGET_CLAIM_ENVELOPE_KEYS = ['receipt', 'schema'];
const TARGET_LEASE_KINDS = new Set(['agent-workspace', 'user-collaboration']);
const TARGET_REPROVISION_REQUIRED = 'TARGET_REPROVISION_REQUIRED';
const TARGET_ACTION_OUTCOME_UNKNOWN = 'TARGET_ACTION_OUTCOME_UNKNOWN';
const TARGET_AUTHORITY_ATTEMPTED = Symbol('targetAuthorityAttempted');
const CLOUD_EPHEMERAL_ROOT_AUTHORITY = Symbol('cloudEphemeralRootAuthority');
const BROWSER_DIAGNOSTIC_LIMIT = 200;

// WHY: one Chrome endpoint spans profiles. profileBinding is only continuity
// with the controller's observed provision record; it is not derived profile
// proof. The nonempty TargetInfo context is checked exactly, while literal
// provisioning establishes which profile/account that opaque context means.

export function renderBrowserDiagnostic(label, error) {
    const safeLabel = typeof label === 'string' && /^[A-Za-z][A-Za-z ]{0,63}$/.test(label)
        ? label
        : 'Browser failure';
    let classification = 'failure';
    try {
        if (error && (typeof error === 'object' || typeof error === 'function')) {
            classification = typeof error.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(error.code)
                ? error.code
                : typeof error.name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(error.name)
                    ? error.name
                    : 'object';
        } else if (error !== undefined && error !== null) {
            classification = typeof error;
        }
    } catch {
        classification = 'object';
    }
    return `${safeLabel} [${classification}]`.slice(0, BROWSER_DIAGNOSTIC_LIMIT);
}

function validateTargetReceipt(receipt) {
    const receiptKeys = receipt && typeof receipt === 'object'
        ? Object.keys(receipt).sort()
        : [];
    const session = process.env.AGENT_BROWSER_SESSION || 'default';
    const workspaceMarkerValid = receipt?.targetKind === 'agent-workspace'
        ? typeof receipt.workspaceMarkerUrl === 'string' &&
            /^about:blank#agent-browser-workspace-[0-9a-f]{64}$/.test(receipt.workspaceMarkerUrl)
        : receipt?.targetKind === 'user-collaboration' && receipt.workspaceMarkerUrl === null;
    if (receipt?.schema !== TARGET_RECEIPT_SCHEMA ||
        receiptKeys.length !== TARGET_RECEIPT_KEYS.length ||
        receiptKeys.some((key, index) => key !== TARGET_RECEIPT_KEYS[index]) ||
        typeof receipt.targetId !== 'string' || !receipt.targetId || receipt.targetId.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(receipt.targetId) ||
        Buffer.from(receipt.targetId, 'utf8').toString('utf8') !== receipt.targetId ||
        typeof receipt.browserContextId !== 'string' || !receipt.browserContextId ||
        receipt.browserContextId.length > 256 || /[\u0000-\u001f\u007f]/.test(receipt.browserContextId) ||
        typeof receipt.profileBinding !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.profileBinding) ||
        typeof receipt.profileDirectory !== 'string' || !receipt.profileDirectory.trim() ||
        receipt.profileDirectory !== receipt.profileDirectory.trim() || receipt.profileDirectory.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(receipt.profileDirectory) ||
        typeof receipt.accountEmail !== 'string' || !receipt.accountEmail.includes('@') ||
        receipt.accountEmail !== receipt.accountEmail.trim() || receipt.accountEmail.length > 320 ||
        /[\u0000-\u001f\u007f]/.test(receipt.accountEmail) ||
        typeof receipt.browserGeneration !== 'string' ||
        !/^[0-9a-f]{64}$/.test(receipt.browserGeneration) ||
        typeof receipt.transportGeneration !== 'string' ||
        !/^[0-9a-f]{64}$/.test(receipt.transportGeneration) ||
        typeof receipt.leaseId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(receipt.leaseId) ||
        !TARGET_LEASE_KINDS.has(receipt.targetKind) || !workspaceMarkerValid ||
        typeof receipt.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.nonce) ||
        !Number.isSafeInteger(receipt.issuedAt) || !Number.isSafeInteger(receipt.expiresAt) ||
        receipt.issuedAt <= 0 || receipt.expiresAt <= receipt.issuedAt ||
        receipt.session !== session) {
        throw new Error('Invalid target lease: exact session, target, context, profile, account, generation, kind, marker, nonce, and lifetime are required.');
    }
}

function validateTargetReceiptFresh(receipt, now = Date.now()) {
    if (receipt.expiresAt <= now ||
        receipt.issuedAt > now + TARGET_RECEIPT_CLOCK_SKEW_MS ||
        receipt.expiresAt - receipt.issuedAt > TARGET_RECEIPT_MAX_TTL_MS) {
        throw new Error('Target lease is expired or outside the allowed 30-second claim lifetime; request a fresh lease.');
    }
}

function receiptsMatch(left, right) {
    const leftKeys = left && typeof left === 'object' ? Object.keys(left).sort() : [];
    const rightKeys = right && typeof right === 'object' ? Object.keys(right).sort() : [];
    return leftKeys.length === TARGET_RECEIPT_KEYS.length &&
        rightKeys.length === TARGET_RECEIPT_KEYS.length &&
        leftKeys.every((key, index) => key === TARGET_RECEIPT_KEYS[index] && rightKeys[index] === key) &&
        TARGET_RECEIPT_KEYS.every((key) => left[key] === right[key]);
}

function assertSecureReceiptPath(nodePath, expectedType) {
    const stat = lstatSync(nodePath);
    if (stat.isSymbolicLink() ||
        (expectedType === 'file' ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error(`Target receipt claim ${expectedType} is not a regular secure ${expectedType}.`);
    }
    if (process.platform !== 'win32') {
        const uid = process.geteuid?.() ?? process.getuid?.();
        if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
            throw new Error(`Target receipt claim ${expectedType} must be owned by this user with no group/other permissions.`);
        }
    }
}

function openBoundClaimEnvelope(consumedDir, claimPath) {
    let directoryDescriptor;
    let claimDescriptor;
    try {
        directoryDescriptor = openSync(consumedDir,
            fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) |
            (fsConstants.O_CLOEXEC ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
        const directoryStat = fstatSync(directoryDescriptor);
        const namedDirectoryStat = lstatSync(consumedDir);
        const uid = process.geteuid?.() ?? process.getuid?.();
        if (!directoryStat.isDirectory() || namedDirectoryStat.isSymbolicLink() ||
            !namedDirectoryStat.isDirectory() || directoryStat.dev !== namedDirectoryStat.dev ||
            directoryStat.ino !== namedDirectoryStat.ino ||
            (process.platform !== 'win32' &&
                ((uid !== undefined && directoryStat.uid !== uid) ||
                    (directoryStat.mode & 0o777) !== 0o700))) {
            throw new Error('Target receipt consumed directory changed while it was being bound.');
        }

        // Node has no openat binding. Holding the verified directory descriptor
        // and opening through procfs preserves that exact directory identity.
        const descriptorPath = `/proc/self/fd/${directoryDescriptor}/${path.basename(claimPath)}`;
        claimDescriptor = openSync(descriptorPath,
            fsConstants.O_RDONLY | (fsConstants.O_CLOEXEC ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
        const claimStat = fstatSync(claimDescriptor);
        const namedClaimStat = lstatSync(claimPath);
        if (!claimStat.isFile() || claimStat.nlink !== 1 || claimStat.size <= 0 ||
            claimStat.size > TARGET_CLAIM_ENVELOPE_MAX_BYTES ||
            namedClaimStat.isSymbolicLink() || !namedClaimStat.isFile() ||
            namedClaimStat.dev !== claimStat.dev || namedClaimStat.ino !== claimStat.ino ||
            (process.platform !== 'win32' &&
                ((uid !== undefined && claimStat.uid !== uid) ||
                    (claimStat.mode & 0o777) !== 0o600))) {
            throw new Error('Target receipt claim envelope must be one private mode-0600 single-link regular file no larger than 16 KiB.');
        }
        return { directoryDescriptor, claimDescriptor, claimStat };
    } catch (error) {
        if (claimDescriptor !== undefined) closeSync(claimDescriptor);
        if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
        throw error;
    }
}

function readBoundedClaimEnvelope(descriptor) {
    const buffer = Buffer.alloc(TARGET_CLAIM_ENVELOPE_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
        const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (count === 0) break;
        bytesRead += count;
    }
    if (bytesRead === 0 || bytesRead > TARGET_CLAIM_ENVELOPE_MAX_BYTES) {
        throw new Error('Target receipt claim envelope exceeded the safe size limit of 16 KiB.');
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
        throw new Error('Target receipt claim envelope must be valid UTF-8 JSON.');
    }
}

function exactControllerEndpointRoot() {
    const uid = process.geteuid?.() ?? process.getuid?.();
    if (!Number.isSafeInteger(uid) || uid < 0) {
        throw new Error('Target receipt controller endpoint identity requires a local numeric uid.');
    }
    const runtimeParent = `/run/user/${uid}`;
    try {
        const stat = lstatSync(runtimeParent);
        if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid &&
            (stat.mode & 0o077) === 0) {
            return `${runtimeParent}/agent-browser-controller/endpoints/${CONTROLLER_ENDPOINT_ID}`;
        }
    } catch {
        // The controller makes the same deterministic fallback choice.
    }
    return `/tmp/agent-browser-controller-${uid}/endpoints/${CONTROLLER_ENDPOINT_ID}`;
}

function bindExactControllerReceiptRoot(receiptRoot, testEndpointRoot) {
    const endpointRoot = path.dirname(receiptRoot);
    const allowedRoot = testEndpointRoot === undefined
        ? exactControllerEndpointRoot()
        : path.resolve(testEndpointRoot);
    if (endpointRoot !== allowedRoot ||
        receiptRoot !== path.join(endpointRoot, 'target-leases')) {
        throw new Error('Target lease claim root does not match the fixed attested controller endpoint.');
    }
    assertSecureReceiptPath(endpointRoot, 'directory');
    if (realpathSync(endpointRoot) !== endpointRoot) {
        throw new Error('Target receipt controller endpoint must not traverse symbolic links.');
    }
    return endpointRoot;
}

function parseRfc3339Utc(value) {
    if (typeof value !== 'string' || !/(?:Z|\+00:00)$/.test(value)) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function validateProfileAttestationFresh(attestation, now = Date.now()) {
    const issuedAt = parseRfc3339Utc(attestation?.issued_at);
    const expiresAt = parseRfc3339Utc(attestation?.expires_at);
    if (issuedAt === null || expiresAt === null || expiresAt <= issuedAt ||
        expiresAt - issuedAt > PROFILE_ATTESTATION_MAX_AGE_MS ||
        issuedAt - now > PROFILE_ATTESTATION_FUTURE_SKEW_MS || now > expiresAt) {
        throw new Error('Stable profile attestation freshness is outside the accepted 120-second window.');
    }
}

function normalizeControllerEndpoint(value) {
    try {
        const parsed = new URL(value);
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
            parsed.username || parsed.password || parsed.search || parsed.hash) return null;
        const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
        const port = parsed.port || defaultPort;
        const pathname = parsed.pathname.replace(/\/+$/, '');
        return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port === defaultPort ? '' : `:${port}`}${pathname}`;
    } catch {
        return null;
    }
}

function isExactBrokerTransportUrl(value, transportGeneration, expectedPort = null) {
    if (typeof value !== 'string') return false;
    const match = value.match(/^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/cdp\/([0-9a-f]{64})$/);
    if (!match) return false;
    const port = Number.parseInt(match[1], 10);
    return port <= 65535 && (expectedPort === null || port === expectedPort) &&
        match[2] === transportGeneration &&
        value === `ws://127.0.0.1:${port}/cdp/${transportGeneration}`;
}

function assertTargetAuthorityCurrent(authority, transportUrl) {
    assertTargetAuthorityFresh(authority);
    if (!isExactBrokerTransportUrl(
        transportUrl,
        authority.receipt.transportGeneration,
        authority.profileAttestation.broker_port,
    )) {
        throw new Error('Target lease transport does not match the exact authenticated broker WebSocket.');
    }
}

function assertTargetAuthorityFresh(authority) {
    validateTargetReceiptFresh(authority.receipt);
    validateProfileAttestationFresh(authority.profileAttestation);
}

function targetReprovisionRequired(message = 'The exact leased target is unavailable; the controller must supply a fresh registered target lease.') {
    const error = new Error(`${TARGET_REPROVISION_REQUIRED}: ${message}`);
    error.code = TARGET_REPROVISION_REQUIRED;
    return error;
}

function targetActionOutcomeUnknown() {
    const error = new Error(
        `${TARGET_ACTION_OUTCOME_UNKNOWN}: CDP transport closed while a command was pending; do not retry without fresh consent and a fresh target lease.`,
    );
    error.code = TARGET_ACTION_OUTCOME_UNKNOWN;
    return error;
}

function permissionMutationForbidden() {
    const error = new Error(
        'BROKER_PERMISSION_MUTATION_FORBIDDEN: browser-global permission state is outside the supported existing-profile target contract.',
    );
    error.code = 'BROKER_PERMISSION_MUTATION_FORBIDDEN';
    return error;
}

function guardTargetAuthorityCommands(client, authority) {
    const send = client.send;
    const guardedSend = function (...args) {
        assertTargetAuthorityCurrent(authority, client._resolvedWsUrl);
        return Reflect.apply(send, this, args);
    };
    client.send = guardedSend;
    return () => {
        if (client.send === guardedSend) client.send = send;
    };
}

function hasExactObjectKeys(value, expectedKeys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

function isSha256(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function transportProcessProofError(message, cause = undefined) {
    const error = new Error(`NEEDS_TRANSPORT_PROCESS_PROOF: ${message}`, cause === undefined ? undefined : { cause });
    error.code = 'NEEDS_TRANSPORT_PROCESS_PROOF';
    return error;
}

function browserGenerationFromTransportProof(chrome) {
    return createHash('sha256').update(canonicalJson({
        pid: chrome.pid,
        startedAtUtc: chrome.startedAtUtc,
        executablePath: chrome.executablePath,
        executableSha256: chrome.executableSha256,
        version: chrome.version,
        userDataRoot: chrome.userDataRoot,
    }), 'utf8').digest('hex');
}

function loadTrustedTransportProcessProof(attestation, controllerEndpointRoot) {
    const proofPath = path.join(
        controllerEndpointRoot,
        'profile-attestation',
        'transport-proof-state.v1.json',
    );
    if (attestation.transport_proof_state_path !== proofPath ||
        !isSha256(attestation.transport_proof_state_sha256)) {
        throw transportProcessProofError('profile attestation does not bind the fixed private proof artifact.');
    }

    let descriptor;
    try {
        descriptor = openSync(proofPath,
            fsConstants.O_RDONLY | (fsConstants.O_CLOEXEC ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
        const stat = fstatSync(descriptor);
        const uid = process.geteuid?.() ?? process.getuid?.();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 ||
            stat.size > PROFILE_ATTESTATION_MAX_BYTES ||
            (process.platform !== 'win32' &&
                ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== 0o600))) {
            throw new Error('proof artifact must be one private mode-0600 regular file.');
        }
        const raw = readFileSync(descriptor);
        const namedStat = lstatSync(proofPath);
        if (namedStat.isSymbolicLink() || !namedStat.isFile() ||
            namedStat.dev !== stat.dev || namedStat.ino !== stat.ino ||
            realpathSync(proofPath) !== proofPath) {
            throw new Error('proof artifact changed while it was being verified.');
        }
        const digest = createHash('sha256').update(raw).digest('hex');
        if (digest !== attestation.transport_proof_state_sha256) {
            throw new Error('proof artifact hash differs from the profile attestation.');
        }

        let proof;
        try {
            proof = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
        } catch {
            throw new Error('proof artifact must be strict JSON.');
        }
        if (!hasExactObjectKeys(proof, [
            'schema', 'observedAtMs', 'maxAgeMs', 'helperRevision',
            'chrome', 'portproxy', 'socat', 'broker',
        ]) || proof.schema !== TRANSPORT_PROOF_STATE_SCHEMA ||
            !Number.isSafeInteger(proof.observedAtMs) || proof.observedAtMs <= 0 ||
            proof.maxAgeMs !== TRANSPORT_PROOF_MAX_AGE_MS ||
            proof.helperRevision !== attestation.helper_revision ||
            !TRUSTED_PROFILE_ATTESTATION_HELPER_REVISIONS.has(proof.helperRevision) ||
            parseRfc3339Utc(attestation.issued_at) !== proof.observedAtMs) {
            throw new Error('proof artifact schema, helper, or issuance binding is invalid.');
        }

        const chrome = proof.chrome;
        const chromeListener = chrome?.listener;
        if (!hasExactObjectKeys(chrome, [
            'observation', 'pid', 'startedAtUtc', 'executablePath',
            'executableSha256', 'version', 'userDataRoot', 'listener',
            'browserGeneration',
        ]) || chrome.observation !== 'windows-tcp-cim-file-version-devtools-active-port' ||
            !Number.isSafeInteger(chrome.pid) || chrome.pid <= 0 ||
            parseRfc3339Utc(chrome.startedAtUtc) === null ||
            chrome.executablePath !== STABLE_CHROME_EXECUTABLE ||
            chrome.userDataRoot !== STABLE_CHROME_USER_DATA_ROOT ||
            typeof chrome.version !== 'string' || !chrome.version || chrome.version.length > 256 ||
            !isSha256(chrome.executableSha256) || !isSha256(chrome.browserGeneration) ||
            chrome.browserGeneration !== browserGenerationFromTransportProof(chrome) ||
            !hasExactObjectKeys(chromeListener, ['address', 'port', 'owningPid']) ||
            chromeListener.address !== '127.0.0.1' || chromeListener.port !== 9222 ||
            chromeListener.owningPid !== chrome.pid) {
            throw new Error('proof artifact does not identify the exact Stable Chrome listener and image.');
        }

        const portproxy = proof.portproxy;
        const proxyListen = portproxy?.listen;
        const proxyConnect = portproxy?.connect;
        const adapter = portproxy?.adapter;
        if (!hasExactObjectKeys(portproxy, [
            'observation', 'pid', 'startedAtUtc', 'executablePath', 'service',
            'listen', 'connect', 'adapter',
        ]) || portproxy.observation !== 'netsh-portproxy-cim-net-ip-address' ||
            !Number.isSafeInteger(portproxy.pid) || portproxy.pid <= 0 ||
            parseRfc3339Utc(portproxy.startedAtUtc) === null ||
            typeof portproxy.executablePath !== 'string' || !portproxy.executablePath ||
            portproxy.service !== 'iphlpsvc' ||
            !hasExactObjectKeys(proxyListen, ['address', 'port']) ||
            !hasExactObjectKeys(proxyConnect, ['address', 'port']) ||
            proxyConnect.address !== '127.0.0.1' || proxyConnect.port !== 9222 ||
            proxyListen.port !== 9222 ||
            !hasExactObjectKeys(adapter, [
                'interfaceIndex', 'name', 'description', 'address', 'prefixLength',
                'networkCategory', 'scope',
            ]) || !Number.isSafeInteger(adapter.interfaceIndex) || adapter.interfaceIndex < 1 ||
            !Number.isSafeInteger(adapter.prefixLength) || adapter.prefixLength < 1 ||
            adapter.prefixLength > 32 || adapter.address !== proxyListen.address ||
            adapter.scope !== 'wsl-hyper-v-internal') {
            throw new Error('proof artifact does not identify the protected Windows portproxy route.');
        }

        const socat = proof.socat;
        if (!hasExactObjectKeys(socat, [
            'observation', 'pid', 'startTicks', 'executablePath',
            'executableSha256', 'listen', 'connect',
        ]) || socat.observation !== 'proc-ss' ||
            !Number.isSafeInteger(socat.pid) || socat.pid <= 0 ||
            typeof socat.startTicks !== 'string' || !/^[0-9]+$/.test(socat.startTicks) ||
            typeof socat.executablePath !== 'string' || !path.isAbsolute(socat.executablePath) ||
            !isSha256(socat.executableSha256) ||
            !hasExactObjectKeys(socat.listen, ['address', 'port']) ||
            !hasExactObjectKeys(socat.connect, ['address', 'port']) ||
            socat.listen.address !== '127.0.0.1' || socat.listen.port !== 9222 ||
            socat.connect.address !== proxyListen.address || socat.connect.port !== 9222) {
            throw new Error('proof artifact does not identify the protected WSL bridge.');
        }

        const broker = proof.broker;
        if (!hasExactObjectKeys(broker, [
            'observation', 'pid', 'startTicks', 'executablePath', 'sourcePath',
            'sourceSha256', 'listen', 'brokerGeneration', 'browserGeneration',
            'consentGeneration', 'transportGeneration', 'producerContractPath',
            'producerContractSha256',
        ]) || broker.observation !== 'immutable-contract-proc-ss-authenticated-health' ||
            !Number.isSafeInteger(broker.pid) || broker.pid <= 0 || broker.pid === socat.pid ||
            typeof broker.startTicks !== 'string' || !/^[0-9]+$/.test(broker.startTicks) ||
            typeof broker.executablePath !== 'string' || !path.isAbsolute(broker.executablePath) ||
            typeof broker.sourcePath !== 'string' || !path.isAbsolute(broker.sourcePath) ||
            !isSha256(broker.sourceSha256) ||
            !hasExactObjectKeys(broker.listen, ['address', 'port']) ||
            broker.listen.address !== '127.0.0.1' ||
            !Number.isSafeInteger(broker.listen.port) || broker.listen.port < 1 ||
            broker.listen.port > 65535 || broker.listen.port === 9222 ||
            ![broker.brokerGeneration, broker.browserGeneration,
                broker.consentGeneration, broker.transportGeneration,
                broker.producerContractSha256].every(isSha256) ||
            broker.browserGeneration !== chrome.browserGeneration ||
            broker.producerContractPath !== path.join(
                controllerEndpointRoot, 'broker-authority', 'producer-contract.json') ||
            broker.browserGeneration !== attestation.browser_generation ||
            broker.brokerGeneration !== attestation.broker_generation ||
            broker.consentGeneration !== attestation.consent_generation ||
            broker.transportGeneration !== attestation.transport_generation ||
            chrome.userDataRoot !== attestation.profile_root) {
            throw new Error('proof artifact does not bind the authenticated broker and four transport generations.');
        }
        return proof;
    } catch (error) {
        if (error?.code === 'NEEDS_TRANSPORT_PROCESS_PROOF') throw error;
        throw transportProcessProofError('trusted controller process proof is invalid.', error);
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
    }
}

function loadAndValidateProfileAttestation(controllerEndpointRoot, options) {
    const attestationDir = path.join(controllerEndpointRoot, 'profile-attestation');
    const attestationPath = path.join(attestationDir, 'stable-chrome.v2.json');
    try {
        assertSecureReceiptPath(attestationDir, 'directory');
        if (realpathSync(attestationDir) !== attestationDir) {
            throw new Error('Stable profile attestation directory must not traverse symbolic links.');
        }
    } catch (error) {
        throw new Error('NEEDS_TRANSPORT_ATTESTATION: stable profile attestation directory is unavailable.', { cause: error });
    }

    let descriptor;
    try {
        descriptor = openSync(attestationPath,
            fsConstants.O_RDONLY | (fsConstants.O_CLOEXEC ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
        const stat = fstatSync(descriptor);
        const uid = process.geteuid?.() ?? process.getuid?.();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > PROFILE_ATTESTATION_MAX_BYTES ||
            (process.platform !== 'win32' &&
                ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== 0o600))) {
            throw new Error('Stable profile attestation must be one private, owned, mode-0600 regular file no larger than 16 KiB.');
        }
        const raw = readFileSync(descriptor, { encoding: 'utf8' });
        const namedStat = lstatSync(attestationPath);
        if (namedStat.isSymbolicLink() || !namedStat.isFile() ||
            namedStat.dev !== stat.dev || namedStat.ino !== stat.ino ||
            realpathSync(attestationPath) !== attestationPath) {
            throw new Error('Stable profile attestation changed while it was being verified.');
        }
        let attestation;
        try {
            attestation = JSON.parse(raw.replace(/^\uFEFF/, ''));
        } catch {
            throw new Error('Stable profile attestation must be strict JSON.');
        }
        const keys = attestation && typeof attestation === 'object'
            ? Object.keys(attestation).sort()
            : [];
        if (keys.length !== PROFILE_ATTESTATION_KEYS.length ||
            keys.some((key, index) => key !== PROFILE_ATTESTATION_KEYS[index]) ||
            attestation.schema !== PROFILE_ATTESTATION_SCHEMA ||
            attestation.profile_kind !== 'windows-stable' ||
            attestation.browser_ownership !== 'external-user-stable' ||
            attestation.profile_root !== STABLE_CHROME_USER_DATA_ROOT ||
            normalizeControllerEndpoint(attestation.cdp_http_url) !== 'http://127.0.0.1:9222' ||
            typeof attestation.helper_revision !== 'string' || !attestation.helper_revision ||
            attestation.helper_revision.length > 256 ||
            ![attestation.browser_generation, attestation.broker_generation,
                attestation.consent_generation, attestation.transport_generation,
                attestation.transport_proof_state_sha256].every(isSha256)) {
            throw new Error('Stable profile attestation does not match the exact v2 identity contract.');
        }
        validateProfileAttestationFresh(attestation);

        if (!TRUSTED_PROFILE_ATTESTATION_HELPER_REVISIONS.has(attestation.helper_revision)) {
            throw transportProcessProofError('profile attestation helper revision is not accepted.');
        }
        const transportProof = loadTrustedTransportProcessProof(
            attestation,
            controllerEndpointRoot,
        );
        return {
            ...attestation,
            endpoint: attestation.cdp_http_url,
            browser_executable: transportProof.chrome.executablePath,
            browser_pid: transportProof.chrome.pid,
            browser_start_time: transportProof.chrome.startedAtUtc,
            browser_version: transportProof.chrome.version,
            broker_port: transportProof.broker.listen.port,
            transportProof,
            path: attestationPath,
        };
    } catch (error) {
        if (error?.message?.startsWith('NEEDS_TRANSPORT_')) throw error;
        throw new Error('NEEDS_TRANSPORT_ATTESTATION: stable profile attestation is invalid.', { cause: error });
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
    }
}

/**
 * Claim the controller-consumed receipt exactly once across local daemon
 * processes. The retained daemon-consumed directory is the replay tombstone.
 * @internal Exported for deterministic cross-process contract tests.
 */
export function consumeTargetAuthorityFromEnvironment(options = {}) {
    const raw = process.env.AGENT_BROWSER_TARGET_RECEIPT;
    const rawClaimPath = process.env[TARGET_CLAIM_PATH_ENV];
    // A receipt is a capability: remove it before asynchronous work or an
    // error path can accidentally reuse it inside this daemon.
    delete process.env.AGENT_BROWSER_TARGET_RECEIPT;
    delete process.env[TARGET_CLAIM_PATH_ENV];
    if (!raw && !rawClaimPath) return null;
    if (!raw || !rawClaimPath) {
        throw new Error(`A target receipt requires both AGENT_BROWSER_TARGET_RECEIPT and ${TARGET_CLAIM_PATH_ENV}.`);
    }
    if (Buffer.byteLength(raw, 'utf8') > TARGET_RECEIPT_MAX_BYTES) {
        throw new Error('Invalid AGENT_BROWSER_TARGET_RECEIPT: public receipt exceeds the safe 8 KiB limit.');
    }
    let receipt;
    try {
        receipt = JSON.parse(raw);
    } catch {
        throw new Error('Invalid AGENT_BROWSER_TARGET_RECEIPT: expected JSON.');
    }
    validateTargetReceipt(receipt);
    validateTargetReceiptFresh(receipt);

    const claimPath = path.normalize(rawClaimPath);
    if (!path.isAbsolute(rawClaimPath) || claimPath !== rawClaimPath ||
        path.basename(claimPath) !== `${receipt.nonce}.json`) {
        throw new Error('Target receipt claim path must be an absolute normalized consumed/<nonce>.json path.');
    }
    const consumedDir = path.dirname(claimPath);
    const receiptRoot = path.dirname(consumedDir);
    if (path.basename(consumedDir) !== 'consumed' || path.basename(receiptRoot) !== 'target-leases') {
        throw new Error('Target lease claim path must be inside target-leases/consumed.');
    }
    const controllerEndpointRoot = bindExactControllerReceiptRoot(
        receiptRoot,
        options.testControllerEndpointRoot,
    );
    const profileAttestation = loadAndValidateProfileAttestation(controllerEndpointRoot, options);
    if (profileAttestation.browser_generation !== receipt.browserGeneration ||
        profileAttestation.transport_generation !== receipt.transportGeneration) {
        throw new Error('Target lease browser/transport generations do not match the trusted controller process proof.');
    }
    assertSecureReceiptPath(receiptRoot, 'directory');
    assertSecureReceiptPath(consumedDir, 'directory');
    const daemonConsumedDir = path.join(receiptRoot, 'daemon-consumed');
    const tombstoneDir = path.join(daemonConsumedDir, receipt.nonce);
    if (!existsSync(claimPath) && existsSync(tombstoneDir)) {
        throw new Error('Target receipt has already been consumed by another daemon; request a fresh one-use receipt.');
    }
    let boundClaim;
    try {
        boundClaim = openBoundClaimEnvelope(consumedDir, claimPath);
    } catch (error) {
        if (existsSync(tombstoneDir)) {
            throw new Error('Target receipt has already been consumed by another daemon; request a fresh one-use receipt.');
        }
        throw error;
    }
    try {
        if (realpathSync(receiptRoot) !== receiptRoot || realpathSync(consumedDir) !== consumedDir) {
            throw new Error('Target receipt claim directories must not traverse symbolic links.');
        }

        let envelope;
        let envelopeBytes;
        try {
            envelopeBytes = readBoundedClaimEnvelope(boundClaim.claimDescriptor);
            envelope = JSON.parse(envelopeBytes.replace(/^\uFEFF/, ''));
        } catch (error) {
            if (existsSync(tombstoneDir)) {
                throw new Error('Target receipt has already been consumed by another daemon; request a fresh one-use receipt.');
            }
            if (error?.message?.includes('16 KiB') || error?.message?.includes('UTF-8')) throw error;
            throw new Error('Invalid target receipt claim envelope: expected JSON.');
        }
        const envelopeKeys = envelope && typeof envelope === 'object'
            ? Object.keys(envelope).sort()
            : [];
        if (envelope?.schema !== TARGET_CLAIM_ENVELOPE_SCHEMA ||
            envelopeKeys.length !== TARGET_CLAIM_ENVELOPE_KEYS.length ||
            envelopeKeys.some((key, index) => key !== TARGET_CLAIM_ENVELOPE_KEYS[index]) ||
            !receiptsMatch(envelope.receipt, receipt)) {
            throw new Error('Target lease claim envelope does not match the public one-use lease contract.');
        }

        try {
            mkdirSync(daemonConsumedDir, { mode: 0o700 });
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
        assertSecureReceiptPath(daemonConsumedDir, 'directory');
        try {
            // mkdir is the local-filesystem atomic winner election. rename alone
            // may replace an existing destination on POSIX and is not exclusive.
            mkdirSync(tombstoneDir, { mode: 0o700 });
        } catch (error) {
            if (error?.code === 'EEXIST') {
                throw new Error('Target receipt has already been consumed by another daemon; request a fresh one-use receipt.');
            }
            throw error;
        }
        assertSecureReceiptPath(tombstoneDir, 'directory');
        const tombstonePath = path.join(tombstoneDir, 'receipt.json');
        try {
            renameSync(claimPath, tombstonePath);
        } catch (error) {
            throw new Error('Failed to atomically claim the controller-consumed target receipt.', { cause: error });
        }
        const claimedStat = lstatSync(tombstonePath);
        const descriptorStat = fstatSync(boundClaim.claimDescriptor);
        if (claimedStat.isSymbolicLink() || !claimedStat.isFile() || claimedStat.nlink !== 1 ||
            claimedStat.dev !== boundClaim.claimStat.dev || claimedStat.ino !== boundClaim.claimStat.ino ||
            descriptorStat.dev !== boundClaim.claimStat.dev || descriptorStat.ino !== boundClaim.claimStat.ino ||
            descriptorStat.nlink !== 1 || descriptorStat.size > TARGET_CLAIM_ENVELOPE_MAX_BYTES ||
            readBoundedClaimEnvelope(boundClaim.claimDescriptor) !== envelopeBytes) {
            throw new Error('Atomically claimed target receipt tombstone changed during claim; refusing CDP access.');
        }
        return {
            receipt,
            browserGeneration: receipt.browserGeneration,
            controllerEndpointRoot,
            profileAttestation,
            tombstonePath,
        };
    } finally {
        closeSync(boundClaim.claimDescriptor);
        closeSync(boundClaim.directoryDescriptor);
    }
}

function getBrowserIdentity(wsUrl) {
    try {
        const parsed = new URL(wsUrl);
        if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
        const match = parsed.pathname.match(/^\/devtools\/browser\/([^/]+)$/);
        return match?.[1] ?? null;
    } catch {
        return null;
    }
}

function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function pythonCasefold(value) {
    let folded = '';
    for (const char of value) {
        const codePoint = char.codePointAt(0);
        if (char.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
        // Match the controller's current Python Unicode table exactly. Node
        // already assigns these newer code points, while that producer still
        // casefolds them as identity characters.
        if (codePoint === 0x0131 || codePoint === 0x1c89 ||
            codePoint === 0xa7cb || codePoint === 0xa7cc ||
            codePoint === 0xa7da || codePoint === 0xa7dc ||
            (codePoint >= 0x10d50 && codePoint <= 0x10d65)) {
            folded += char;
        } else if (codePoint === 0x1e9e) {
            folded += 'ss';
        } else if ((codePoint >= 0x13a0 && codePoint <= 0x13ff) ||
            (codePoint >= 0xab70 && codePoint <= 0xabbf)) {
            folded += char.toUpperCase();
        } else {
            folded += char.toUpperCase().toLowerCase();
        }
    }
    return folded;
}

function normalizedWindowsGenerationPath(value) {
    const text = typeof value === 'string'
        ? value.trim().replaceAll('/', '\\').replace(/\\+$/, '')
        : '';
    return text ? pythonCasefold(text) : null;
}

function getAttestedBrowserGeneration(profileAttestation, wsUrl) {
    return isExactBrokerTransportUrl(
        wsUrl,
        profileAttestation?.transport_generation,
        profileAttestation?.broker_port,
    ) && isSha256(profileAttestation?.browser_generation)
        ? profileAttestation.browser_generation
        : null;
}

function isReceiptablePageUrl(url) {
    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname;
    } catch {
        return false;
    }
}

function isLeasedRootUrl(receipt, url) {
    return receipt.targetKind === 'agent-workspace'
        ? url === receipt.workspaceMarkerUrl
        : isReceiptablePageUrl(url);
}

function leaseBindingFromReceipt(receipt, overrides = {}) {
    return Object.freeze({
        accountEmail: receipt.accountEmail,
        browserContextId: receipt.browserContextId,
        browserGeneration: receipt.browserGeneration,
        leaseId: receipt.leaseId,
        leaseNonce: receipt.nonce,
        profileBinding: receipt.profileBinding,
        profileDirectory: receipt.profileDirectory,
        session: receipt.session,
        rootTargetId: receipt.rootTargetId ?? receipt.targetId,
        rootTargetKind: receipt.rootTargetKind ?? receipt.targetKind,
        targetId: overrides.targetId ?? receipt.targetId,
        targetKind: overrides.targetKind ?? receipt.targetKind,
        transportGeneration: receipt.transportGeneration,
        workspaceMarkerUrl: receipt.workspaceMarkerUrl,
    });
}

/**
 * Manages the browser lifecycle with multiple tabs/windows.
 * Raw CDP implementation — no external browser automation library.
 */
export class BrowserManager {
    // Core state
    client = null;         // CDPClient instance
    _targets = [];         // Array of { targetId, sessionId, page: CDPPage }
    cdpEndpoint = null;
    cdpHttpBase = null;
    _targetTrackingInstalled = false;
    _targetTrackingHandlers = null;
    _targetAttachPromises = new Set();
    _pendingTargetIds = new Set();
    _pendingTargetAttaches = new Map();
    _popupWaiters = new Set();
    _closingTargetIds = new Set();
    _closingOwnedTargetIds = new Set();
    _unresolvedOwnedTargetIds = new Set();
    _observedDestroyedTargetIds = new Set();
    _targetCloseOperations = new Map();
    _closeCycleAttemptedTargetIds = new Set();
    _recoveryTargets = [];
    _recoveryActiveOrder = null;
    _recoveryPromise = null;
    _adoptedTargetLost = false;
    _targetLeaseLost = null;
    _closing = false;
    _closePromise = null;
    _connectionGeneration = 0;
    _targetAuthority = undefined;
    _targetLifecycleEvents = [];
    _nextTargetOrder = 0;
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
    _nextSnapshotRefOrdinal = 1n;
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

    recordDescendantLifecycle(event, target) {
        if (!target?.binding || target.leaseRoot === true) return;
        this._targetLifecycleEvents = this._targetLifecycleEvents
            .filter((item) => item.targetId !== target.targetId);
        const item = event === 'descendant-attached'
            ? Object.freeze({
                schema: 'agent-browser.target-lifecycle.v1',
                event,
                targetId: target.targetId,
                targetKind: target.lifecycleKind,
                rootBinding: Object.freeze({
                    browserContextId: target.binding.browserContextId,
                    browserGeneration: target.binding.browserGeneration,
                    leaseId: target.binding.leaseId,
                    leaseNonce: target.binding.leaseNonce,
                    profileBinding: target.binding.profileBinding,
                    rootTargetId: target.binding.rootTargetId,
                    rootTargetKind: target.binding.rootTargetKind,
                    session: target.binding.session,
                    transportGeneration: target.binding.transportGeneration,
                }),
            })
            : Object.freeze({
                schema: 'agent-browser.target-lifecycle.v1',
                event,
                targetId: target.targetId,
                targetKind: target.lifecycleKind,
            });
        this._targetLifecycleEvents.push(item);
        if (this._targetLifecycleEvents.length > 64) this._targetLifecycleEvents.shift();
    }

    consumeTargetLifecycleEvents() {
        return this._targetLifecycleEvents.splice(0);
    }

    normalizeTargetInfo(targetInfo) {
        if (!targetInfo) return null;
        const targetId = targetInfo.targetId ?? targetInfo.id;
        if (!targetId) return null;
        return {
            ...targetInfo,
            targetId,
            type: targetInfo.type ?? 'page',
            url: targetInfo.url ?? 'about:blank',
        };
    }

    publicTargetUrl(target, url) {
        return target?.lifecycleKind === 'agent-workspace' &&
            target?.binding?.workspaceMarkerUrl === url
            ? 'about:blank'
            : url;
    }

    isInternalTargetUrl(url) {
        return !!url && (
            url.startsWith('chrome://') ||
            url.startsWith('chrome-extension://') ||
            url.startsWith('chrome-untrusted://') ||
            url.startsWith('devtools://')
        );
    }

    isKnownTarget(targetId) {
        return this._targets.some((target) => target.targetId === targetId);
    }

    async closeTargetBounded(targetId, timeoutMs = 500) {
        if (this._closing) this._closeCycleAttemptedTargetIds.add(targetId);
        if (this._observedDestroyedTargetIds.has(targetId)) {
            return { closed: true, timedOut: false, observedDestroyed: true };
        }
        if (!this.client) return { closed: false, timedOut: false, error: new Error('CDP client is unavailable') };
        let timer;
        let closing = this._targetCloseOperations.get(targetId);
        if (!closing) {
            const operationGeneration = this._connectionGeneration;
            closing = Promise.resolve()
                .then(() => closeTarget(this.client, targetId))
                .then(
                    () => ({ closed: true, timedOut: false }),
                    (error) => ({ closed: false, timedOut: false, error }),
                );
            this._targetCloseOperations.set(targetId, closing);
            closing.then((result) => {
                if (!result.closed || this._connectionGeneration !== operationGeneration) return;
                this._unresolvedOwnedTargetIds.delete(targetId);
                if (this.isKnownTarget(targetId)) {
                    this.removeTrackedTarget(targetId, { intentional: true });
                }
            });
            closing.finally(() => {
                if (this._targetCloseOperations.get(targetId) === closing) {
                    this._targetCloseOperations.delete(targetId);
                }
            });
        }
        const deadline = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ closed: false, timedOut: true }), timeoutMs);
            timer.unref?.();
        });
        const result = await Promise.race([closing, deadline]);
        clearTimeout(timer);
        return this._observedDestroyedTargetIds.has(targetId)
            ? { closed: true, timedOut: false, observedDestroyed: true }
            : result;
    }

    async assertOwnedDescendantIdentity(target) {
        if (!target?.binding || target.lifecycleKind !== 'ephemeral-owned-child') return;
        const { targetInfo } = await this.client.send('Target.getTargetInfo', {
            targetId: target.targetId,
        });
        const info = this.normalizeTargetInfo(targetInfo);
        if (!info || info.targetId !== target.targetId || info.type !== 'page' ||
            (info.browserContextId ?? null) !== target.binding.browserContextId ||
            info.openerId !== target.openerId) {
            throw targetReprovisionRequired('An ephemeral child changed identity; it will not be closed or replaced.');
        }
    }

    getTrackedOpener(targetInfo) {
        const info = this.normalizeTargetInfo(targetInfo);
        if (!info?.openerId) return null;
        return this._targets.find((target) => target.targetId === info.openerId) ?? null;
    }

    getExternalTargetDescriptor(targetInfo) {
        const info = this.normalizeTargetInfo(targetInfo);
        if (!info?.openerId) return null;
        const opener = this.getTrackedOpener(info);
        const pendingOpener = opener ? null : this._pendingTargetAttaches.get(info.openerId);
        const source = opener ?? pendingOpener;
        if (!source && !this._closingOwnedTargetIds.has(info.openerId)) return null;

        const sourceOwned = source ? source.owned === true : true;
        const sourceKind = source?.lifecycleKind;
        const sourceBinding = source?.binding ?? null;
        const browserContextId = sourceBinding
            ? sourceBinding.browserContextId
            : source?.browserContextId ?? null;
        if (sourceBinding && (info.browserContextId ?? null) !== browserContextId) return null;
        const owned = sourceKind === 'agent-workspace' ||
            sourceKind === 'ephemeral-owned-child' ||
            (!sourceKind && sourceOwned);
        const lifecycleKind = owned ? 'ephemeral-owned-child' : 'user-collaboration';
        return {
            owned,
            lifecycleKind,
            browserContextId,
            binding: sourceBinding
                ? leaseBindingFromReceipt({
                    accountEmail: sourceBinding.accountEmail,
                    browserContextId: sourceBinding.browserContextId,
                    browserGeneration: sourceBinding.browserGeneration,
                    leaseId: sourceBinding.leaseId,
                    nonce: sourceBinding.leaseNonce,
                    profileBinding: sourceBinding.profileBinding,
                    profileDirectory: sourceBinding.profileDirectory,
                    rootTargetId: sourceBinding.rootTargetId,
                    rootTargetKind: sourceBinding.rootTargetKind,
                    session: sourceBinding.session,
                    targetId: sourceBinding.targetId,
                    targetKind: sourceBinding.targetKind,
                    transportGeneration: sourceBinding.transportGeneration,
                    workspaceMarkerUrl: sourceBinding.workspaceMarkerUrl,
                }, { targetId: info.targetId, targetKind: lifecycleKind })
                : null,
        };
    }

    getExternalTargetOwnership(targetInfo) {
        return this.getExternalTargetDescriptor(targetInfo)?.owned ?? null;
    }

    shouldTrackExternalTarget(targetInfo) {
        const info = this.normalizeTargetInfo(targetInfo);
        if (!info || info.type !== 'page') return false;
        if (this.isKnownTarget(info.targetId)) return false;
        if (this._pendingTargetIds.has(info.targetId)) return false;
        if (this.isInternalTargetUrl(info.url)) return false;
        // WHY: OAuth/login popups are separate Chrome targets. We only adopt targets
        // whose opener is one of this session's pages, so Agent Browser can follow
        // Google/Exness-style popups without stealing unrelated user tabs.
        return this.getExternalTargetDescriptor(info) !== null;
    }

    async attachExternalTarget(targetInfo, options = {}) {
        if (!this.client) return null;
        let info = this.normalizeTargetInfo(targetInfo);
        if (!info || this.isKnownTarget(info.targetId)) return null;
        const descriptor = options.descriptor ?? this.getExternalTargetDescriptor(info);
        if (!descriptor) return null;
        const owned = options.owned ?? descriptor.owned === true;
        let sessionId;
        let safeToClose = owned && !descriptor.binding;
        try {
            if (descriptor.binding) {
                const { targetInfo: exactTargetInfo } = await this.client.send('Target.getTargetInfo', {
                    targetId: info.targetId,
                });
                const exactInfo = this.normalizeTargetInfo(exactTargetInfo);
                if (!exactInfo || exactInfo.targetId !== info.targetId || exactInfo.type !== 'page' ||
                    exactTargetInfo.attached !== false || exactInfo.openerId !== info.openerId ||
                    (exactInfo.browserContextId ?? null) !== descriptor.browserContextId) {
                    throw new Error('Derived child target changed before attachment.');
                }
                info = exactInfo;
            }
            sessionId = await attachToTarget(this.client, info.targetId);
            if (this._observedDestroyedTargetIds.has(info.targetId)) {
                await this.client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
                return null;
            }
            if (descriptor.binding) {
                const { targetInfo: attachedTargetInfo } = await this.client.send('Target.getTargetInfo', {
                    targetId: info.targetId,
                });
                const attachedInfo = this.normalizeTargetInfo(attachedTargetInfo);
                if (!attachedInfo || attachedInfo.targetId !== info.targetId || attachedInfo.type !== 'page' ||
                    attachedTargetInfo.attached !== true || attachedInfo.openerId !== info.openerId ||
                    (attachedInfo.browserContextId ?? null) !== descriptor.browserContextId) {
                    throw new Error('Derived child target changed during attachment.');
                }
                info = attachedInfo;
                safeToClose = owned;
            }
            await enableDomains(this.client, sessionId);
            if (this._observedDestroyedTargetIds.has(info.targetId)) {
                await this.client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
                return null;
            }
        } catch (error) {
            if (safeToClose) {
                this._closingTargetIds.add(info.targetId);
                const result = await this.closeTargetBounded(info.targetId);
                if (!result.closed) this._unresolvedOwnedTargetIds.add(info.targetId);
                this._closingTargetIds.delete(info.targetId);
            } else if (sessionId) {
                await this.client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
            }
            throw error;
        }
        if (this._closing) {
            if (owned) {
                this._closingOwnedTargetIds.add(info.targetId);
                const result = await this.closeTargetBounded(info.targetId);
                if (result.closed) {
                    this._unresolvedOwnedTargetIds.delete(info.targetId);
                } else {
                    this._unresolvedOwnedTargetIds.add(info.targetId);
                }
            } else if (sessionId) {
                await this.client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
            }
            return null;
        }
        const page = new CDPPage(this.client, sessionId, info.targetId);
        page._url = info.url || 'about:blank';
        const ctx = this.contexts[0];
        if (ctx) {
            page._contextRef = ctx;
            ctx._pages.push(page);
        }
        this.pages.push(page);
        // A popup is part of its opener's ownership tree. It is never a new
        // receipt root and should not be recreated after a normal self-close.
        const trackedTarget = {
            targetId: info.targetId,
            sessionId,
            page,
            owned,
            recoverable: false,
            adoptedReceipt: false,
            leaseRoot: false,
            lifecycleKind: descriptor.lifecycleKind,
            browserContextId: descriptor.browserContextId,
            binding: descriptor.binding,
            openerId: info.openerId,
            generation: this._connectionGeneration,
            order: this._nextTargetOrder++,
        };
        this._targets.push(trackedTarget);
        this.recordDescendantLifecycle('descendant-attached', trackedTarget);
        if (options.activate) {
            await this.invalidateCDPSession().catch(() => {});
            this.activePageIndex = this.pages.length - 1;
        }
        if (owned) {
            await setViewport(this.client, 1280, 720, { sessionId: page._sessionId }).catch(() => {});
        }
        return page;
    }

    trackExternalTarget(targetInfo, options = {}) {
        const info = this.normalizeTargetInfo(targetInfo);
        if (!this.shouldTrackExternalTarget(info)) return null;
        const descriptor = options.descriptor ?? this.getExternalTargetDescriptor(info);
        if (!descriptor) return null;
        const owned = options.owned ?? descriptor.owned === true;
        // WHY: Chrome can report the same popup through targetCreated,
        // targetInfoChanged, and the post-click HTTP target scan. Marking a
        // target pending before attach prevents duplicate Agent Browser tabs
        // for one real OAuth window.
        this._pendingTargetIds.add(info.targetId);
        let operation;
        if (this._closing) {
            operation = owned
                ? Promise.resolve()
                    .then(() => this.assertOwnedDescendantIdentity({
                        targetId: info.targetId,
                        lifecycleKind: descriptor.lifecycleKind,
                        binding: descriptor.binding,
                        openerId: info.openerId,
                    }))
                    .then(() => this.closeTargetBounded(info.targetId))
                    .then((result) => {
                    if (result.closed) this._unresolvedOwnedTargetIds.delete(info.targetId);
                    else this._unresolvedOwnedTargetIds.add(info.targetId);
                    return null;
                })
                : Promise.resolve(null);
            if (owned) this._closingOwnedTargetIds.add(info.targetId);
        } else {
            operation = this.attachExternalTarget(info, { ...options, owned, descriptor });
        }
        const promise = operation.catch((error) => {
            this.launchWarnings.push(renderBrowserDiagnostic('Popup attachment failed', error));
            return null;
        });
        this._pendingTargetAttaches.set(info.targetId, {
            promise,
            owned,
            lifecycleKind: descriptor.lifecycleKind,
            browserContextId: descriptor.browserContextId,
            binding: descriptor.binding,
        });
        this._targetAttachPromises.add(promise);
        promise.finally(() => {
            this._targetAttachPromises.delete(promise);
            this._pendingTargetIds.delete(info.targetId);
            this._pendingTargetAttaches.delete(info.targetId);
        });
        return promise;
    }

    dedupeTrackedTargets() {
        const seen = new Set();
        const targets = [];
        for (const target of this._targets) {
            if (seen.has(target.targetId)) continue;
            seen.add(target.targetId);
            targets.push(target);
        }
        if (targets.length === this._targets.length) return;
        this._targets = targets;
        this.pages = targets.map((target) => target.page);
        if (this.activePageIndex >= this.pages.length) {
            this.activePageIndex = Math.max(0, this.pages.length - 1);
        }
    }

    async settleExternalTargetTracking(timeoutMs = 300) {
        if (this._targetAttachPromises.size === 0) return true;
        await Promise.race([
            Promise.allSettled([...this._targetAttachPromises]),
            new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
        return this._targetAttachPromises.size === 0;
    }

    async elementMayOpenPopup(locator) {
        try {
            return await locator.evaluate((element) => {
                const candidate = element.closest?.('a,area,form,button,input') ?? element;
                const explicitTarget = candidate.getAttribute?.('target') ??
                    candidate.getAttribute?.('formtarget') ??
                    candidate.form?.getAttribute?.('target');
                if (explicitTarget && !['_self', '_top', '_parent'].includes(explicitTarget.toLowerCase())) return true;
                const inlineHandler = candidate.getAttribute?.('onclick') ?? '';
                return /(?:window\s*\.\s*)?open\s*\(/i.test(inlineHandler);
            });
        } catch {
            return false;
        }
    }

    async armPopupTracking(locator, options = {}) {
        if (!this.client || !this._targetTrackingInstalled || this._closing) return null;
        const mayOpenPopup = options.force === true || await this.elementMayOpenPopup(locator);
        if (!mayOpenPopup) return null;
        const timeoutMs = options.timeoutMs ?? 350;
        let waiter;
        let timer;
        let settled = false;
        const promise = new Promise((resolve) => {
            const finish = (trackingPromise = null) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (waiter) this._popupWaiters.delete(waiter);
                resolve(trackingPromise);
            };
            waiter = (trackingPromise) => finish(trackingPromise);
            this._popupWaiters.add(waiter);
            timer = setTimeout(() => finish(null), timeoutMs);
            timer.unref?.();
        });
        return {
            wait: () => promise,
            cancel: () => waiter?.(null),
        };
    }

    notifyPopupWaiters(trackingPromise) {
        for (const waiter of [...this._popupWaiters]) waiter(trackingPromise);
    }

    queueRecoveryTarget(target, index, active = false) {
        if (!target || this._recoveryTargets.some((item) => item.targetId === target.targetId)) return;
        const order = Number.isSafeInteger(target.order) ? target.order : index;
        const restoreActive = active && this._recoveryActiveOrder === null;
        if (restoreActive) this._recoveryActiveOrder = order;
        this._recoveryTargets.push({
            targetId: target.targetId,
            url: target.page?.url?.() || target.page?._url || 'about:blank',
            index,
            order,
            active: restoreActive,
        });
    }

    removeTrackedTarget(targetId, options = {}) {
        const index = this._targets.findIndex((target) => target.targetId === targetId);
        if (index < 0) return null;
        const [removed] = this._targets.splice(index, 1);
        const pageIndex = this.pages.indexOf(removed.page);
        const wasActive = pageIndex === this.activePageIndex;
        this.pages = this.pages.filter((page) => page !== removed.page);
        if (removed.page?._contextRef) {
            removed.page._contextRef._pages = removed.page._contextRef._pages.filter((page) => page !== removed.page);
        }
        if (!options.intentional) {
            if (removed.leaseRoot === true || removed.adoptedReceipt) {
                this._adoptedTargetLost = true;
                this._targetLeaseLost = {
                    targetKind: removed.lifecycleKind ?? 'user-collaboration',
                };
            } else if (removed.owned !== false && removed.recoverable !== false) {
                this.queueRecoveryTarget(removed, Math.max(0, pageIndex), wasActive);
            }
        }
        if (removed.leaseRoot !== true && removed.binding) {
            this.recordDescendantLifecycle(
                options.intentional ? 'descendant-released' : 'descendant-lost',
                removed,
            );
        }
        if (this.activePageIndex >= this.pages.length) {
            this.activePageIndex = Math.max(0, this.pages.length - 1);
        } else if (pageIndex >= 0 && this.activePageIndex > pageIndex) {
            this.activePageIndex--;
        }
        if (wasActive) void this.invalidateCDPSession().catch(() => {});
        this._unresolvedOwnedTargetIds.delete(targetId);
        return removed;
    }

    async installTargetTracking() {
        if (!this.client || this._targetTrackingInstalled) return;
        let ready = false;
        const bufferedEvents = [];
        const processors = {};
        processors.targetCreated = (params) => {
            const trackingPromise = this.trackExternalTarget(params.targetInfo, { activate: true });
            if (trackingPromise) this.notifyPopupWaiters(trackingPromise);
        };
        processors.targetInfoChanged = (params) => {
            const info = this.normalizeTargetInfo(params.targetInfo);
            if (!info) return;
            const tracked = this._targets.find((target) => target.targetId === info.targetId);
            if (tracked) {
                const contextChanged = tracked.binding &&
                    (info.browserContextId ?? null) !== tracked.browserContextId;
                const openerChanged = tracked.binding && tracked.leaseRoot !== true &&
                    info.openerId !== tracked.openerId;
                if (contextChanged || openerChanged) {
                    this.removeTrackedTarget(info.targetId, { intentional: false });
                    void this.client?.send('Target.detachFromTarget', { sessionId: tracked.sessionId }).catch(() => {});
                    return;
                }
                tracked.page._url = this.publicTargetUrl(tracked, info.url) || tracked.page._url;
                return;
            }
            const trackingPromise = this.trackExternalTarget(info, { activate: true });
            if (trackingPromise) this.notifyPopupWaiters(trackingPromise);
        };
        processors.targetCrashed = (params) => {
            const tracked = this._targets.find((target) => target.targetId === params.targetId);
            if (!tracked) return;
            this.removeTrackedTarget(params.targetId, { intentional: false });
            // A crashed derived child is closed only after its exact context and
            // opener still match. It is never replaced locally.
            if (tracked.owned !== false) {
                this._closingTargetIds.add(params.targetId);
                void this.assertOwnedDescendantIdentity(tracked)
                    .then(() => this.closeTargetBounded(params.targetId))
                    .then((result) => {
                        if (!result.closed) this._unresolvedOwnedTargetIds.add(params.targetId);
                    })
                    .catch((error) => {
                        this.launchWarnings.push(renderBrowserDiagnostic('Crashed child cleanup rejected', error));
                    })
                    .finally(() => this._closingTargetIds.delete(params.targetId));
            }
        };
        processors.targetDestroyed = (params) => {
            if (this.isKnownTarget(params.targetId) ||
                this._pendingTargetIds.has(params.targetId) ||
                this._closingTargetIds.has(params.targetId) ||
                this._unresolvedOwnedTargetIds.has(params.targetId)) {
                this._observedDestroyedTargetIds.add(params.targetId);
                this._unresolvedOwnedTargetIds.delete(params.targetId);
            }
            const intentional = this._closingTargetIds.has(params.targetId);
            this.removeTrackedTarget(params.targetId, { intentional });
        };
        const handlers = Object.fromEntries(Object.entries(processors).map(([name, processor]) => [
            name,
            (params) => {
                if (!ready) {
                    bufferedEvents.push({ processor, params });
                    return;
                }
                processor(params);
            },
        ]));
        this.client.on('Target.targetCreated', handlers.targetCreated);
        this.client.on('Target.targetInfoChanged', handlers.targetInfoChanged);
        this.client.on('Target.targetCrashed', handlers.targetCrashed);
        this.client.on('Target.targetDestroyed', handlers.targetDestroyed);
        try {
            await this.client.send('Target.setDiscoverTargets', { discover: true });
        } catch (error) {
            this.client.off('Target.targetCreated', handlers.targetCreated);
            this.client.off('Target.targetInfoChanged', handlers.targetInfoChanged);
            this.client.off('Target.targetCrashed', handlers.targetCrashed);
            this.client.off('Target.targetDestroyed', handlers.targetDestroyed);
            throw error;
        }
        this._targetTrackingHandlers = handlers;
        this._targetTrackingInstalled = true;
        ready = true;
        for (const event of bufferedEvents) event.processor(event.params);
    }

    removeTargetTrackingHandlers() {
        const handlers = this._targetTrackingHandlers;
        if (!handlers || !this.client) return;
        this.client.off('Target.targetCreated', handlers.targetCreated);
        this.client.off('Target.targetInfoChanged', handlers.targetInfoChanged);
        this.client.off('Target.targetCrashed', handlers.targetCrashed);
        this.client.off('Target.targetDestroyed', handlers.targetDestroyed);
        this._targetTrackingHandlers = null;
        this._targetTrackingInstalled = false;
    }

    async syncExternalTargets(options = {}) {
        // The authenticated existing-profile broker is event-only. HTTP target
        // listings are neither authenticated nor profile-authoritative, and the
        // broker intentionally exposes no /json/list surface.
        if (this._targetAuthority) return [];
        if (!this.client || !this.cdpHttpBase) return [];
        const waitMs = options.waitMs ?? 0;
        const deadline = Date.now() + waitMs;
        const added = [];
        do {
            const batch = await this.syncExternalTargetsOnce(options);
            added.push(...batch);
            if (batch.length > 0 || Date.now() >= deadline) break;
            await new Promise((resolve) => setTimeout(resolve, 75));
        } while (Date.now() < deadline);
        return added;
    }

    async syncExternalTargetsOnce(options = {}) {
        let targets;
        try {
            targets = await getTargets(this.cdpHttpBase, 1000);
        } catch {
            return [];
        }
        const targetsById = new Map(targets.map((target) => [target.id, target]));
        for (const tracked of this._targets) {
            const current = targetsById.get(tracked.targetId);
            // HTTP target listings do not carry the authoritative profile
            // context. Bound targets are updated only by exact CDP TargetInfo.
            if (!tracked.binding && current?.url) tracked.page._url = current.url;
        }
        const added = [];
        for (const target of targets) {
            let info = this.normalizeTargetInfo({ ...target, targetId: target.id });
            const opener = info?.openerId
                ? this._targets.find((candidate) => candidate.targetId === info.openerId)
                : null;
            if (opener?.binding && !info?.browserContextId) {
                try {
                    const { targetInfo } = await this.client.send('Target.getTargetInfo', {
                        targetId: info.targetId,
                    });
                    info = this.normalizeTargetInfo(targetInfo);
                } catch {
                    continue;
                }
            }
            if (!this.shouldTrackExternalTarget(info)) continue;
            const page = await this.trackExternalTarget(info, { activate: options.activateNew === true });
            if (page) added.push(page);
        }
        this.dedupeTrackedTargets();
        return added;
    }

    isLaunched() {
        return this.client !== null || this.isPersistentContext;
    }

    async getSnapshot(options) {
        const page = this.getPage();
        const priorRefsByIdentity = new Map();
        for (const [ref, data] of Object.entries(this.refMap)) {
            const identity = snapshotRefIdentity(data);
            if (identity)
                priorRefsByIdentity.set(identity, ref);
        }
        const claimedRefs = new Set();
        const allocateRef = (identityData) => {
            const identity = snapshotRefIdentity(identityData);
            if (!identity) {
                throw new Error('Snapshot ref ownership is incomplete');
            }
            const priorRef = priorRefsByIdentity.get(identity);
            if (priorRef && !claimedRefs.has(priorRef)) {
                claimedRefs.add(priorRef);
                return priorRef;
            }
            let ref;
            do {
                ref = `e${this._nextSnapshotRefOrdinal++}`;
            } while (claimedRefs.has(ref) || Object.hasOwn(this.refMap, ref));
            claimedRefs.add(ref);
            return ref;
        };
        const snapshot = await getEnhancedSnapshot(page, { ...options, allocateRef });
        // Snapshot generation owns a detached next map. Replace the prior epoch
        // only after the full structural snapshot succeeds; never merge maps.
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
        const refOwner = refData.targetId && refData.sessionId &&
            Number.isInteger(refData.documentBackendNodeId)
            ? {
                targetId: refData.targetId,
                sessionId: refData.sessionId,
                documentBackendNodeId: refData.documentBackendNodeId,
            }
            : null;
        if (Number.isInteger(refData.backendNodeId)) {
            return new CDPLocator(page, refData.selector, {
                backendNodeId: refData.backendNodeId,
                refOwner,
                requireRefOwner: true,
            });
        }
        // Cursor-interactive elements use CSS selector
        if (refData.role === 'clickable' || refData.role === 'focusable') {
            return new CDPLocator(page, refData.selector, {
                refOwner,
                requireRefOwner: true,
            });
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
        if (this.isRef(selectorOrRef)) {
            throw new Error(`Snapshot ref not found: ${selectorOrRef}`);
        }
        return this.getPage().locator(selectorOrRef);
    }

    hasPages() { return this.pages.length > 0; }

    needsPageRecovery() {
        this.markLeasedTransportLostIfDisconnected();
        return this._targetLeaseLost !== null || this._adoptedTargetLost || this._recoveryTargets.length > 0;
    }

    markLeasedTransportLostIfDisconnected() {
        if (this._targetAuthority && this.client?.isConnected?.() === false) {
            this._targetLeaseLost = {
                targetKind: this._targetAuthority.receipt.targetKind,
            };
        }
    }

    assertMutable(operation = 'mutate browser state') {
        this.markLeasedTransportLostIfDisconnected();
        if (this._targetLeaseLost) {
            throw targetReprovisionRequired('The leased root or transport was lost; no further browser mutation is authorized.');
        }
        if (this._closing) {
            throw new Error(`Browser cleanup is quiescent after close began; retry close before attempting to ${operation}.`);
        }
    }

    assertCommandAllowed(action) {
        this.markLeasedTransportLostIfDisconnected();
        if (this._targetLeaseLost && action !== 'close') {
            throw targetReprovisionRequired('The leased root or transport was lost; only cleanup is authorized.');
        }
        if (this._closing && action !== 'close') {
            throw new Error('Browser cleanup is quiescent after close began; only a close retry is allowed.');
        }
    }

    async createOwnedPage(url = 'about:blank', options = {}) {
        this.assertMutable('create a task target');
        if (!this.client) throw new Error('Browser not launched');
        if (this._targetAuthority) {
            throw targetReprovisionRequired('A leased persistent-profile session cannot create another root; supply an exact controller-provisioned lease.');
        }
        const targetId = await createTarget(this.client, url);
        let sessionId;
        try {
            sessionId = await attachToTarget(this.client, targetId);
            await enableDomains(this.client, sessionId);
        } catch (error) {
            this._closingTargetIds.add(targetId);
            const result = await this.closeTargetBounded(targetId);
            if (!result.closed) this._unresolvedOwnedTargetIds.add(targetId);
            this._closingTargetIds.delete(targetId);
            throw error;
        }
        const page = new CDPPage(this.client, sessionId, targetId);
        page._url = url;
        const ctx = this.contexts[0];
        const order = Number.isSafeInteger(options.order) ? options.order : this._nextTargetOrder++;
        this._nextTargetOrder = Math.max(this._nextTargetOrder, order + 1);
        const orderedIndex = this._targets.findIndex((target) =>
            Number.isSafeInteger(target.order) && target.order > order);
        const requestedIndex = options.index ?? this.pages.length;
        const index = orderedIndex >= 0
            ? orderedIndex
            : Number.isSafeInteger(options.order)
                ? this.pages.length
                : Math.min(Math.max(0, requestedIndex), this.pages.length);
        if (ctx) {
            page._contextRef = ctx;
            ctx._pages.splice(index, 0, page);
        }
        this.pages.splice(index, 0, page);
        this._targets.splice(index, 0, {
            targetId,
            sessionId,
            page,
            owned: true,
            recoverable: true,
            adoptedReceipt: false,
            leaseRoot: false,
            lifecycleKind: 'ephemeral-owned-child',
            browserContextId: null,
            binding: null,
            generation: this._connectionGeneration,
            order,
        });
        if (options.activate === true || (options.activate === undefined && this.pages.length === 1)) {
            this.activePageIndex = index;
        } else if (this.activePageIndex >= index) {
            this.activePageIndex++;
        }
        return page;
    }

    async ensurePage() {
        this.assertMutable('recover a task target');
        if (this._recoveryPromise) return this._recoveryPromise;
        const recoveryPromise = this.ensurePageOnce();
        this._recoveryPromise = recoveryPromise;
        try {
            return await recoveryPromise;
        } finally {
            if (this._recoveryPromise === recoveryPromise) this._recoveryPromise = null;
        }
    }

    async ensurePageOnce() {
        if (!this.client) return;
        if (this._targetLeaseLost || this._adoptedTargetLost) {
            throw targetReprovisionRequired('The leased root was lost or replaced; no target will be guessed or created.');
        }
        if (this._unresolvedOwnedTargetIds.size > 0) {
            throw new Error('A previous replacement target still has unresolved cleanup; retry close before creating another replacement.');
        }
        const activePage = this.pages[this.activePageIndex] ?? null;
        const recoveryBatch = this._recoveryTargets
            .splice(0)
            .sort((left, right) => left.order - right.order);
        for (let recoveryIndex = 0; recoveryIndex < recoveryBatch.length; recoveryIndex++) {
            const recovery = recoveryBatch[recoveryIndex];
            try {
                await this.createOwnedPage(recovery.url, {
                    index: recovery.index,
                    order: recovery.order,
                    activate: false,
                });
            } catch (error) {
                this._recoveryTargets.unshift(...recoveryBatch.slice(recoveryIndex));
                throw error;
            }
        }
        if (this._recoveryActiveOrder !== null) {
            const activeIndex = this._targets.findIndex((target) => target.order === this._recoveryActiveOrder);
            if (activeIndex >= 0) this.activePageIndex = activeIndex;
            this._recoveryActiveOrder = null;
        } else if (activePage && this.pages.includes(activePage)) {
            this.activePageIndex = this.pages.indexOf(activePage);
        }
        if (this.pages.length === 0) {
            if (this._targetAuthority) {
                throw targetReprovisionRequired('The leased root is absent; no target will be guessed or created.');
            }
            await this.createOwnedPage('about:blank', { activate: true });
        }
    }

    getPage() {
        this.markLeasedTransportLostIfDisconnected();
        if (this._targetLeaseLost) {
            throw targetReprovisionRequired('The leased root or transport was lost; no target action is authorized.');
        }
        if (this.pages.length === 0) {
            throw new Error('Browser not launched. Call launch first.');
        }
        const page = this.pages[this.activePageIndex];
        const tracked = this._targets.find((target) => target.page === page);
        if (this._targetAuthority &&
            (!tracked || tracked.generation !== this._connectionGeneration || !tracked.binding)) {
            throw targetReprovisionRequired('The active target no longer has the exact current-generation lease binding.');
        }
        return page;
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
        if (this._targetAuthority || this.client?._brokerTransport) {
            throw permissionMutationForbidden();
        }
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
        await this._connectToWsUrl(session.connectUrl, null, CLOUD_EPHEMERAL_ROOT_AUTHORITY);
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
        catch (error) { throw new Error(renderBrowserDiagnostic('Kernel response parse failed', error)); }
        if (!session.session_id || !session.cdp_ws_url) {
            throw new Error(`Invalid Kernel session response: missing ${!session.session_id ? 'session_id' : 'cdp_ws_url'}`);
        }
        await this._connectToWsUrl(session.cdp_ws_url, null, CLOUD_EPHEMERAL_ROOT_AUTHORITY);
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
        catch (error) { throw new Error(renderBrowserDiagnostic('Browser Use response parse failed', error)); }
        if (!session.id || !session.cdpUrl) {
            throw new Error(`Invalid Browser Use session response: missing ${!session.id ? 'id' : 'cdpUrl'}`);
        }
        await this._connectToWsUrl(session.cdpUrl, null, CLOUD_EPHEMERAL_ROOT_AUTHORITY);
        this.browserUseSessionId = session.id;
        this.browserUseApiKey = browserUseApiKey;
    }

    installLeasedTransportFailureGuard(client, authority) {
        const send = client.send;
        client.send = async (...args) => {
            try {
                return await Reflect.apply(send, client, args);
            } catch (error) {
                if (client.isConnected?.() === false) {
                    this._targetLeaseLost = { targetKind: authority.receipt.targetKind };
                    const unknown = targetActionOutcomeUnknown();
                    unknown.cause = error;
                    throw unknown;
                }
                throw error;
            }
        };
    }

    /**
     * Shared method: Connect to a WebSocket URL, discover targets, set up pages.
     */
    async _connectToWsUrl(wsUrl, targetAuthority = undefined, connectionAuthority = null) {
        // undefined means this entry point owns the one synchronous environment
        // consume. null is an explicit unreceipted authority state and must not
        // be recomputed by an auto-connect retry.
        let authority;
        try {
            authority = targetAuthority === undefined
                ? consumeTargetAuthorityFromEnvironment()
                : targetAuthority;
        } catch (error) {
            delete process.env[BROKER_AUTHORIZATION_ENV];
            throw error;
        }
        if (!authority && connectionAuthority !== CLOUD_EPHEMERAL_ROOT_AUTHORITY) {
            throw targetReprovisionRequired('Raw persistent-profile CDP requires one exact controller-provisioned target lease.');
        }
        if (authority) {
            if (authority[TARGET_AUTHORITY_ATTEMPTED] === true) {
                throw targetReprovisionRequired('A claimed target lease cannot be reused across transport attempts.');
            }
            Object.defineProperty(authority, TARGET_AUTHORITY_ATTEMPTED, {
                value: true,
                enumerable: false,
                configurable: false,
                writable: false,
            });
        }
        this._targetAuthority = authority;
        const client = new CDPClient();
        let ctx = null;
        let generation = null;
        let restoreAuthorityCommandGuard = () => {};
        try {
            if (authority) {
                try {
                    assertTargetAuthorityFresh(authority);
                } catch (error) {
                    delete process.env[BROKER_AUTHORIZATION_ENV];
                    throw error;
                }
            }
            await client.connect(wsUrl, authority ? {
                brokerTransportGeneration: authority.receipt.transportGeneration,
                brokerLeaseId: authority.receipt.leaseId,
            } : {});
            if (authority) {
                // Connection resolution can consume most of a receipt's short
                // lifetime. No Target command is allowed before this second check.
                assertTargetAuthorityCurrent(authority, client._resolvedWsUrl);
                // Keep the receipt and profile attestation current at the exact
                // send boundary for every command in this attachment transaction.
                // The guard is removed after ownership is established; the
                // short-lived receipt is not a lease on ordinary page actions.
                restoreAuthorityCommandGuard = guardTargetAuthorityCommands(client, authority);
                const browserGeneration = getAttestedBrowserGeneration(
                    authority.profileAttestation,
                    client._resolvedWsUrl,
                );
                if (!browserGeneration || browserGeneration !== authority.browserGeneration ||
                    browserGeneration !== authority.receipt.browserGeneration) {
                    throw new Error('Target lease browser generation does not match the connected Chrome instance.');
                }
            }
            this.client = client;
            this.cdpHttpBase = this.getHttpEndpointFromCdpUrl(wsUrl);
            generation = ++this._connectionGeneration;
            ctx = new CDPContext(client);
            this.contexts.push(ctx);

            if (authority) {
                const targetReceipt = authority.receipt;
                assertTargetAuthorityCurrent(authority, client._resolvedWsUrl);
                const { targetInfo } = await client.send('Target.getTargetInfo', {
                    targetId: targetReceipt.targetId,
                });
                const info = this.normalizeTargetInfo(targetInfo);
                if (!info || info.targetId !== targetReceipt.targetId ||
                    targetInfo?.type !== 'page' || targetInfo.attached !== false ||
                    (targetInfo.browserContextId ?? null) !== targetReceipt.browserContextId ||
                    !isLeasedRootUrl(targetReceipt, info.url)) {
                    throw new Error('Target lease does not identify the exact attachable registered root.');
                }
                assertTargetAuthorityCurrent(authority, client._resolvedWsUrl);
                const sessionId = await attachToTarget(client, info.targetId);
                try {
                    assertTargetAuthorityCurrent(authority, client._resolvedWsUrl);
                    const { targetInfo: attachedTargetInfo } = await client.send('Target.getTargetInfo', {
                        targetId: targetReceipt.targetId,
                    });
                    const attachedInfo = this.normalizeTargetInfo(attachedTargetInfo);
                    const provenanceKeys = ['openerId', 'browserContextId', 'subtype'];
                    const provenanceStable = provenanceKeys.every((key) =>
                        (attachedTargetInfo?.[key] ?? null) === (targetInfo?.[key] ?? null));
                    const attachedGeneration = getAttestedBrowserGeneration(
                        authority.profileAttestation,
                        client._resolvedWsUrl,
                    );
                    if (!attachedInfo || attachedInfo.targetId !== info.targetId ||
                        attachedTargetInfo?.type !== 'page' || attachedTargetInfo.attached !== true ||
                        attachedInfo.url !== info.url || !isLeasedRootUrl(targetReceipt, attachedInfo.url) ||
                        (attachedTargetInfo.browserContextId ?? null) !== targetReceipt.browserContextId ||
                        !provenanceStable || attachedGeneration !== authority.browserGeneration) {
                        throw new Error('Target lease identity changed during attachment.');
                    }
                } catch (error) {
                    await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
                    throw error;
                }
                assertTargetAuthorityCurrent(authority, client._resolvedWsUrl);
                await enableDomains(client, sessionId);
                const page = new CDPPage(client, sessionId, info.targetId);
                const binding = leaseBindingFromReceipt(targetReceipt);
                page._url = targetReceipt.targetKind === 'agent-workspace'
                    ? 'about:blank'
                    : info.url || 'about:blank';
                page._contextRef = ctx;
                ctx._pages.push(page);
                this.pages.push(page);
                this._targets.push({
                    targetId: info.targetId,
                    sessionId,
                    page,
                    owned: false,
                    recoverable: false,
                    adoptedReceipt: true,
                    leaseRoot: true,
                    lifecycleKind: targetReceipt.targetKind,
                    browserContextId: targetReceipt.browserContextId,
                    binding,
                    generation,
                    order: this._nextTargetOrder++,
                });
                this.activePageIndex = 0;
                this.browser = client;
                assertTargetAuthorityCurrent(authority, client._resolvedWsUrl);
                await this.installTargetTracking();
                restoreAuthorityCommandGuard();
                restoreAuthorityCommandGuard = () => {};
                this.installLeasedTransportFailureGuard(client, authority);
                return;
            }

            // Cloud sessions explicitly opt in to one disposable owned root.
            // Persistent-profile transports never reach this branch.
            const page = await this.createOwnedPage('about:blank', { activate: true });
            this.browser = client;

            // Set default viewport only on task-owned roots.
            await setViewport(client, 1280, 720, { sessionId: page._sessionId }).catch(() => {});
            await this.installTargetTracking();
        } catch (error) {
            const generationTargets = generation === null
                ? []
                : this._targets.filter((target) => target.generation === generation);
            if (authority) {
                // Leased roots are preserved. A failed pre/post attachment can
                // only detach/close this WebSocket; it must never close or select
                // another Chrome target.
                this._targets = this._targets.filter((target) => target.generation !== generation);
                this.pages = this._targets.map((target) => target.page);
                if (ctx) this.contexts = this.contexts.filter((item) => item !== ctx);
                await client.close().catch(() => {});
                if (this.client === client) this.client = null;
                this.browser = null;
                const reprovision = targetReprovisionRequired(
                    'The exact registered target lease was rejected; no URL, title, order, or replacement fallback was used.',
                );
                reprovision.cause = error;
                throw reprovision;
            }

            for (const target of generationTargets.filter((item) => item.owned === true)) {
                this._closingTargetIds.add(target.targetId);
                const result = await this.closeTargetBounded(target.targetId);
                if (result.closed) this.removeTrackedTarget(target.targetId, { intentional: true });
                else this._unresolvedOwnedTargetIds.add(target.targetId);
                this._closingTargetIds.delete(target.targetId);
            }
            if (this.getUnresolvedCleanup().targetIds.length === 0) {
                if (ctx) this.contexts = this.contexts.filter((item) => item !== ctx);
                await client.close().catch(() => {});
                if (this.client === client) this.client = null;
                this.browser = null;
            }
            throw error;
        } finally {
            restoreAuthorityCommandGuard();
        }
    }

    getHttpEndpointFromCdpUrl(cdpUrl) {
        try {
            const parsed = new URL(cdpUrl);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                return `${parsed.protocol}//${parsed.host}`;
            }
            if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
                return `${parsed.protocol === 'wss:' ? 'https:' : 'http:'}//${parsed.host}`;
            }
        } catch {
            return null;
        }
        return null;
    }

    // ── Launch ───────────────────────────────────────────────────────────────

    async launch(options) {
        const cdpEndpoint = options.cdpUrl ?? (options.cdpPort ? String(options.cdpPort) : undefined);
        let targetAuthority = this._targetAuthority;
        const hasExtensions = !!options.extensions?.length;
        const hasProfile = !!options.profile;

        if (hasExtensions && cdpEndpoint) throw new Error('Extensions cannot be used with CDP connection');
        if (hasProfile && cdpEndpoint) throw new Error('Profile cannot be used with CDP connection');

        // Extensions and profiles require a browser launcher (not available in raw CDP)
        if (hasExtensions) throw new Error('Extensions are not supported in raw CDP mode. Use a pre-launched Chrome with extensions instead.');
        if (hasProfile) throw new Error('Persistent profiles are not supported in raw CDP mode. Launch Chrome with --user-data-dir instead.');

        if (this.isLaunched()) {
            if (cdpEndpoint) {
                if (this.needsCdpReconnect(cdpEndpoint)) {
                    if (this._targetAuthority) {
                        this._targetLeaseLost = { targetKind: this._targetAuthority.receipt.targetKind };
                        throw targetReprovisionRequired('Transport loss or endpoint change requires fresh consent and a fresh target lease.');
                    }
                    await this.close();
                    targetAuthority = undefined;
                } else {
                    return;
                }
            } else if (options.autoConnect) {
                if (this.isCdpConnectionAlive()) {
                    return;
                }
                if (this._targetAuthority) {
                    this._targetLeaseLost = { targetKind: this._targetAuthority.receipt.targetKind };
                    throw targetReprovisionRequired('Transport loss requires fresh consent and a fresh target lease.');
                }
                await this.close();
                targetAuthority = undefined;
            } else {
                return;
            }
        }

        if (cdpEndpoint) {
            await this.connectViaCDP(cdpEndpoint, targetAuthority);
            return;
        }

        if (options.autoConnect) {
            await this.autoConnectViaCDP(targetAuthority);
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

    async connectViaCDP(cdpEndpoint, targetAuthority = undefined) {
        if (!cdpEndpoint) throw new Error('CDP endpoint is required for CDP connection');
        let cdpUrl;
        if (cdpEndpoint.startsWith('ws://') || cdpEndpoint.startsWith('wss://') ||
            cdpEndpoint.startsWith('http://') || cdpEndpoint.startsWith('https://')) {
            cdpUrl = cdpEndpoint;
        } else if (/^\d+$/.test(cdpEndpoint)) {
            cdpUrl = `http://127.0.0.1:${cdpEndpoint}`;
        } else {
            cdpUrl = `http://127.0.0.1:${cdpEndpoint}`;
        }

        try {
            await this._connectToWsUrl(cdpUrl, targetAuthority);
        } catch (error) {
            const wrapped = new Error(renderBrowserDiagnostic('CDP connection failed', error), { cause: error });
            if (error?.code === TARGET_REPROVISION_REQUIRED) wrapped.code = TARGET_REPROVISION_REQUIRED;
            throw wrapped;
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

    async autoConnectViaCDP(explicitTargetAuthority = undefined) {
        const targetAuthority = explicitTargetAuthority === undefined
            ? consumeTargetAuthorityFromEnvironment()
            : explicitTargetAuthority;
        if (targetAuthority) {
            throw targetReprovisionRequired(
                'An exact leased target requires its controller-supplied direct broker WebSocket; endpoint discovery and retry are forbidden.',
            );
        }
        let lastAuthorityError = null;
        // Strategy 1: Check DevToolsActivePort files
        const userDataDirs = this.getChromeUserDataDirs();
        for (const dir of userDataDirs) {
            const activePort = this.readDevToolsActivePort(dir);
            if (activePort) {
                const wsUrl = await this.probeDebugPort(activePort.port);
                if (wsUrl) {
                    try {
                        await this.connectViaCDP(wsUrl, targetAuthority);
                        return;
                    } catch (error) {
                        if (error?.code === TARGET_REPROVISION_REQUIRED) throw error;
                        if (this.client) throw error;
                        if (targetAuthority) lastAuthorityError = error;
                    }
                }
                try {
                    await this.connectViaCDP(`http://127.0.0.1:${activePort.port}`, targetAuthority);
                    return;
                } catch (error) {
                    if (error?.code === TARGET_REPROVISION_REQUIRED) throw error;
                    if (this.client) throw error;
                    if (targetAuthority) lastAuthorityError = error;
                }
            }
        }
        // Strategy 2: Probe common ports
        const commonPorts = [9222, 9229];
        for (const port of commonPorts) {
            const wsUrl = await this.probeDebugPort(port);
            if (wsUrl) {
                try {
                    await this.connectViaCDP(wsUrl, targetAuthority);
                    return;
                } catch (error) {
                    if (error?.code === TARGET_REPROVISION_REQUIRED) throw error;
                    if (this.client) throw error;
                    if (targetAuthority) lastAuthorityError = error;
                }
            }
        }
        if (targetAuthority) {
            throw new Error(
                'No discovered Chrome endpoint accepted the explicitly receipted target; refusing an unreceipted replacement.',
                { cause: lastAuthorityError },
            );
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
        this.assertMutable('create a new tab');
        if (!this.client) throw new Error('Browser not launched');
        if (this._targetAuthority) {
            throw targetReprovisionRequired('Additional persistent-profile roots require their own exact controller-provisioned lease.');
        }
        await this.createOwnedPage('about:blank', { activate: true });
        return { index: this.activePageIndex, total: this.pages.length };
    }

    async newWindow(viewport) {
        // In CDP, a new "window" is just another target
        return this.newTab();
    }

    async invalidateCDPSession() {
        if (this.screencastActive) await this.stopScreencast().catch(() => {});
        // In raw CDP, cdpSession is the client itself — no detach needed
        this.cdpSession = null;
    }

    async switchTo(index) {
        await this.syncExternalTargets();
        this.dedupeTrackedTargets();
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
        const page = this.pages[targetIndex];
        const tracked = this._targets.find((target) => target.page === page);
        if (!tracked || tracked.owned !== true || tracked.generation !== this._connectionGeneration) {
            throw new Error('Refusing to close an unowned, unknown, or stale Chrome tab. Close only exact current-generation task-owned tabs.');
        }
        // WHY: a CDP session owns targets, not the persistent real browser.
        // Rejecting the last owned tab forced models to leave blank tabs behind
        // even though Target.closeTarget is safe and BrowserManager.close() uses
        // the same ownership boundary.
        const targetId = tracked.targetId;
        this._closingTargetIds.add(targetId);
        try {
            await this.assertOwnedDescendantIdentity(tracked);
            const result = await this.closeTargetBounded(targetId);
            if (!result.closed && this.isKnownTarget(targetId)) {
                this._unresolvedOwnedTargetIds.add(targetId);
                const reason = result.timedOut
                    ? 'timed out'
                    : renderBrowserDiagnostic('Close failed', result.error);
                throw new Error(`Failed to close a task-owned tab: ${reason}. Ownership was retained for retry.`);
            }
            this.removeTrackedTarget(targetId, { intentional: true });
        } finally {
            this._closingTargetIds.delete(targetId);
        }
        return { closed: targetIndex, remaining: this.pages.length };
    }

    async listTabs() {
        await this.syncExternalTargets();
        this.dedupeTrackedTargets();
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
        if (this._closePromise) return this._closePromise;
        const closePromise = this.closeOnce();
        this._closePromise = closePromise;
        try {
            return await closePromise;
        } finally {
            if (this._closePromise === closePromise) this._closePromise = null;
        }
    }

    getUnresolvedCleanup() {
        const trackedOwned = this._targets
            .filter((target) => target.owned === true)
            .map((target) => target.targetId);
        const pendingOwned = [...this._pendingTargetAttaches.entries()]
            .filter(([, pending]) => pending.owned === true)
            .map(([targetId]) => targetId);
        return {
            targetIds: [...new Set([...trackedOwned, ...this._unresolvedOwnedTargetIds])].sort(),
            pendingTargetIds: [...new Set(pendingOwned)].sort(),
        };
    }

    async closeOwnedTargetsPass(options = {}) {
        const excludeTargetIds = options.excludeTargetIds ?? new Set();
        const ids = new Set([
            ...this._targets
                .filter((target) => target.owned === true && target.generation === this._connectionGeneration)
                .map((target) => target.targetId),
            ...(options.includeUnresolved === false ? [] : this._unresolvedOwnedTargetIds),
        ]);
        for (const targetId of excludeTargetIds) ids.delete(targetId);
        for (const targetId of ids) {
            this._closingTargetIds.add(targetId);
            this._closingOwnedTargetIds.add(targetId);
        }
        const results = await Promise.all([...ids].map(async (targetId) => {
            const tracked = this._targets.find((target) => target.targetId === targetId);
            await this.assertOwnedDescendantIdentity(tracked);
            return {
                targetId,
                result: await this.closeTargetBounded(targetId),
            };
        }));
        for (const { targetId, result } of results) {
            if (result.closed || !this.isKnownTarget(targetId) && !this._unresolvedOwnedTargetIds.has(targetId)) {
                this.removeTrackedTarget(targetId, { intentional: true });
                this._unresolvedOwnedTargetIds.delete(targetId);
            } else {
                this._unresolvedOwnedTargetIds.add(targetId);
            }
            this._closingTargetIds.delete(targetId);
        }
        return ids;
    }

    async restoreWorkspaceMarker(target) {
        if (!this.client || target.lifecycleKind !== 'agent-workspace' || target.leaseRoot !== true) return;
        const markerUrl = target.binding?.workspaceMarkerUrl;
        const expectedContextId = target.binding?.browserContextId;
        if (!markerUrl || !target.binding?.profileBinding) {
            throw targetReprovisionRequired('The workspace release binding is incomplete.');
        }
        const { targetInfo: currentTargetInfo } = await this.client.send('Target.getTargetInfo', {
            targetId: target.targetId,
        });
        const current = this.normalizeTargetInfo(currentTargetInfo);
        if (!current || current.targetId !== target.targetId || current.type !== 'page' ||
            currentTargetInfo.attached !== true ||
            (current.browserContextId ?? null) !== expectedContextId) {
            throw targetReprovisionRequired('The workspace root changed before privacy cleanup.');
        }
        const navigation = await this.client.send('Page.navigate', { url: markerUrl }, target.sessionId);
        if (navigation?.errorText) {
            throw new Error('Workspace privacy cleanup could not restore its registered inert marker.');
        }
        for (let attempt = 0; attempt < 10; attempt++) {
            const { targetInfo } = await this.client.send('Target.getTargetInfo', {
                targetId: target.targetId,
            });
            const info = this.normalizeTargetInfo(targetInfo);
            if (info?.targetId === target.targetId && info.type === 'page' &&
                targetInfo.attached === true &&
                (info.browserContextId ?? null) === expectedContextId &&
                info.url === markerUrl) {
                target.page._url = 'about:blank';
                return;
            }
            if (info?.targetId !== target.targetId ||
                (info?.browserContextId ?? null) !== expectedContextId) {
                throw targetReprovisionRequired('The workspace root changed during privacy cleanup.');
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('Workspace privacy cleanup did not reach its registered inert state.');
    }

    async assertPreservedTargetIdentity(target) {
        if (!target?.binding) return;
        const { targetInfo } = await this.client.send('Target.getTargetInfo', {
            targetId: target.targetId,
        });
        const info = this.normalizeTargetInfo(targetInfo);
        const openerMatches = target.leaseRoot === true || info?.openerId === target.openerId;
        const workspaceMarkerMatches = target.lifecycleKind !== 'agent-workspace' ||
            info?.url === target.binding.workspaceMarkerUrl;
        if (!info || info.targetId !== target.targetId || info.type !== 'page' ||
            targetInfo.attached !== true ||
            (info.browserContextId ?? null) !== target.binding.browserContextId ||
            !openerMatches || !workspaceMarkerMatches) {
            throw targetReprovisionRequired('A preserved target changed identity before detach.');
        }
    }

    async releasePreservedTargets() {
        if (!this.client) return;
        if (this._targetAuthority) {
            const liveGeneration = getAttestedBrowserGeneration(
                this._targetAuthority.profileAttestation,
                this.client._resolvedWsUrl,
            );
            if (liveGeneration !== this._targetAuthority.receipt.browserGeneration) {
                throw targetReprovisionRequired('The browser generation changed before target release.');
            }
        }
        const preserved = this._targets.filter((target) =>
            target.generation === this._connectionGeneration && target.owned !== true);
        for (const target of preserved) await this.restoreWorkspaceMarker(target);
        for (const target of [...preserved].reverse()) {
            if (!this.isKnownTarget(target.targetId)) continue;
            await this.assertPreservedTargetIdentity(target);
            try {
                await this.client.send('Target.detachFromTarget', { sessionId: target.sessionId });
            } catch (error) {
                if (!this._observedDestroyedTargetIds.has(target.targetId)) {
                    throw new Error('Target lease release is unresolved and retained for retry.', { cause: error });
                }
            }
            this.removeTrackedTarget(target.targetId, { intentional: true });
        }
    }

    async closeOnce() {
        this._closeCycleAttemptedTargetIds = new Set();
        this._closing = true;
        // Stop screencast if active
        if (this.screencastActive) await this.stopScreencast().catch(() => {});

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
            await this.closeBrowserbaseSession(this.browserbaseSessionId, this.browserbaseApiKey)
                .catch((error) => console.error(renderBrowserDiagnostic('Browserbase cleanup failed', error)));
        } else if (this.browserUseSessionId && this.browserUseApiKey) {
            await this.closeBrowserUseSession(this.browserUseSessionId, this.browserUseApiKey)
                .catch((error) => console.error(renderBrowserDiagnostic('Browser Use cleanup failed', error)));
        } else if (this.kernelSessionId && this.kernelApiKey) {
            await this.closeKernelSession(this.kernelSessionId, this.kernelApiKey)
                .catch((error) => console.error(renderBrowserDiagnostic('Kernel cleanup failed', error)));
        } else {
            // Close the discovery intake first, then drain both already-started
            // and late event-owned popup work. The closing gate never attaches
            // new targets and never closes adopted descendants.
            if (this.client && this._targetTrackingInstalled) {
                await this.client.send('Target.setDiscoverTargets', { discover: false }).catch((error) => {
                    this.launchWarnings.push(renderBrowserDiagnostic('Target discovery cleanup failed', error));
                });
            }
            await this.settleExternalTargetTracking(300);
            await this.closeOwnedTargetsPass({
                excludeTargetIds: new Set(this._closeCycleAttemptedTargetIds),
            });
            await this.settleExternalTargetTracking(300);
            await this.closeOwnedTargetsPass({
                excludeTargetIds: this._closeCycleAttemptedTargetIds,
                includeUnresolved: false,
            });

            const unresolved = this.getUnresolvedCleanup();
            if (unresolved.targetIds.length > 0 || unresolved.pendingTargetIds.length > 0) {
                throw new Error(`Task-owned target cleanup is unresolved and retained for retry: targets=${unresolved.targetIds.length}, pending=${unresolved.pendingTargetIds.length}.`);
            }
            await this.releasePreservedTargets();
        }

        // Close WebSocket
        this.removeTargetTrackingHandlers();
        if (this.client) {
            await this.client.close().catch(() => {});
        }

        // Reset all state
        this.client = null;
        this.browser = null;
        this.pages = [];
        this.contexts = [];
        this._targets = [];
        this.cdpEndpoint = null;
        this.cdpHttpBase = null;
        this._targetTrackingInstalled = false;
        this._targetTrackingHandlers = null;
        this._targetAttachPromises.clear();
        this._pendingTargetIds.clear();
        this._pendingTargetAttaches.clear();
        for (const waiter of [...this._popupWaiters]) waiter(null);
        this._popupWaiters.clear();
        this._closingTargetIds.clear();
        this._closingOwnedTargetIds.clear();
        this._unresolvedOwnedTargetIds.clear();
        this._observedDestroyedTargetIds.clear();
        this._targetCloseOperations.clear();
        this._closeCycleAttemptedTargetIds.clear();
        this._recoveryTargets = [];
        this._recoveryActiveOrder = null;
        this._recoveryPromise = null;
        this._adoptedTargetLost = false;
        this._targetLeaseLost = null;
        this._targetAuthority = undefined;
        this._closing = false;
        this.browserbaseSessionId = null;
        this.browserbaseApiKey = null;
        this.browserUseSessionId = null;
        this.browserUseApiKey = null;
        this.kernelSessionId = null;
        this.kernelApiKey = null;
        this.isPersistentContext = false;
        this.activePageIndex = 0;
        this._nextTargetOrder = 0;
        this.refMap = {};
        this.lastSnapshot = '';
        this.frameCallback = null;
        this.cdpSession = null;
        this._interceptor = null;
    }
}
