import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cdp = vi.hoisted(() => ({
    attachToTarget: vi.fn(),
    createTarget: vi.fn(),
    getTargets: vi.fn(),
}));

vi.mock('../dist/cdp.js', async () => {
    const actual = await vi.importActual('../dist/cdp.js');
    return {
        ...actual,
        CDPClient: class {
            async connect() {}
            async close() {}
        },
        attachToTarget: cdp.attachToTarget,
        createTarget: cdp.createTarget,
        getTargets: cdp.getTargets,
    };
});

import { BrowserManager } from '../dist/browser.js';

describe('existing authenticated target attachment', () => {
    beforeEach(() => {
        process.env.AGENT_BROWSER_ATTACH_EXISTING_URL =
            'https://www.tradingview.com/chart/gold';
        delete process.env.AGENT_BROWSER_ATTACH_EXISTING;
        cdp.getTargets.mockResolvedValue([
            {
                id: 'retained-gold-tab',
                type: 'page',
                url: 'https://www.tradingview.com/chart/gold',
            },
        ]);
        cdp.attachToTarget.mockRejectedValue(new Error('target already attached'));
    });

    afterEach(() => {
        delete process.env.AGENT_BROWSER_ATTACH_EXISTING_URL;
        delete process.env.AGENT_BROWSER_ATTACH_EXISTING;
        vi.clearAllMocks();
    });

    it('requires one controller-provisioned target instead of selecting or creating a tab', async () => {
        const browser = new BrowserManager();

        await expect(
            browser._connectToWsUrl('http://127.0.0.1:9222'),
        ).rejects.toThrow('one exact controller-provisioned target lease');

        expect(cdp.getTargets).not.toHaveBeenCalled();
        expect(cdp.attachToTarget).not.toHaveBeenCalled();
        expect(cdp.createTarget).not.toHaveBeenCalled();
    });
});
