import { afterEach, describe, expect, it, vi } from 'vitest';

const cdp = vi.hoisted(() => ({
    closeTarget: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../dist/cdp.js', async () => {
    const actual = await vi.importActual('../dist/cdp.js');
    return {
        ...actual,
        closeTarget: cdp.closeTarget,
    };
});

import { BrowserManager } from '../dist/browser.js';

function managerWithOneTarget({ owned }) {
    const browser = new BrowserManager();
    const context = { _pages: [] };
    const page = { _targetId: 'only-target', _contextRef: context };
    context._pages.push(page);
    browser.client = {};
    browser.pages = [page];
    browser.contexts = [context];
    browser._targets = [{
        targetId: 'only-target',
        sessionId: 'session',
        page,
        owned,
        generation: browser._connectionGeneration,
    }];
    browser.activePageIndex = 0;
    return browser;
}

describe('task-owned tab cleanup', () => {
    afterEach(() => vi.clearAllMocks());

    it('closes the last task-owned tab without closing persistent Chrome', async () => {
        const browser = managerWithOneTarget({ owned: true });

        await expect(browser.closeTab(0)).resolves.toEqual({ closed: 0, remaining: 0 });

        expect(cdp.closeTarget).toHaveBeenCalledWith(browser.client, 'only-target');
        expect(browser.pages).toEqual([]);
        expect(browser._targets).toEqual([]);
    });

    it('preserves a reused authenticated user tab', async () => {
        const browser = managerWithOneTarget({ owned: false });

        await expect(browser.closeTab(0)).rejects.toThrow(
            'Refusing to close an unowned, unknown, or stale Chrome tab',
        );

        expect(cdp.closeTarget).not.toHaveBeenCalled();
        expect(browser.pages).toHaveLength(1);
    });
});
