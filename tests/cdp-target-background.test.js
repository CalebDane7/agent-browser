import { describe, expect, it, vi } from 'vitest';

import { createTarget } from '../dist/cdp.js';

describe('CDP target focus policy', () => {
    it('creates task targets in the background by default', async () => {
        const client = {
            send: vi.fn().mockResolvedValue({ targetId: 'task-target' }),
        };

        await expect(createTarget(client, 'about:blank')).resolves.toBe('task-target');

        expect(client.send).toHaveBeenCalledWith('Target.createTarget', {
            url: 'about:blank',
            background: true,
        });
    });

    it('allows an explicit foreground target only when requested', async () => {
        const client = {
            send: vi.fn().mockResolvedValue({ targetId: 'human-input-target' }),
        };

        await createTarget(client, 'about:blank', { background: false });

        expect(client.send).toHaveBeenCalledWith('Target.createTarget', {
            url: 'about:blank',
            background: false,
        });
    });
});
