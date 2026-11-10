import { describe, expect, it } from 'vitest';
import { createQueueState, reduce } from '../src/queue-engine.js';
function apply(state, event) {
    return reduce(state, event).state;
}
function join(id, phoneHash, partySize, at) {
    return {
        id: `join-${id}`,
        type: 'JOIN',
        at,
        token: { id, phoneHash, partySize, source: 'remote', joinedAt: at }
    };
}
describe('queue engine', () => {
    it('runs the skip-ahead dry run without penalizing size-incompatible parties', () => {
        let state = createQueueState([
            { id: 't2a', capacity: 2, status: 'FREE' },
            { id: 't4', capacity: 4, status: 'FREE' },
            { id: 't2b', capacity: 2, status: 'FREE' },
            { id: 't6', capacity: 6, status: 'FREE' }
        ]);
        state = apply(state, join('A', 'phone-a', 2, 1));
        state = apply(state, join('B', 'phone-b', 4, 2));
        state = apply(state, join('C', 'phone-c', 2, 3));
        state = apply(state, join('D', 'phone-d', 6, 4));
        state = apply(state, join('E', 'phone-e', 2, 5));
        state = apply(state, { id: 'check-b', type: 'CHECK_IN', at: 6, tokenId: 'B' });
        state = apply(state, { id: 'check-c', type: 'CHECK_IN', at: 7, tokenId: 'C' });
        state = apply(state, { id: 'check-d', type: 'CHECK_IN', at: 8, tokenId: 'D' });
        state = apply(state, { id: 'check-e', type: 'CHECK_IN', at: 9, tokenId: 'E' });
        state = apply(state, { id: 'free-1', type: 'TABLE_FREE', at: 10, tableId: 't2a' });
        expect(state.tokens.find((token) => token.id === 'C')?.tableId).toBe('t2a');
        expect(state.tokens.find((token) => token.id === 'A')?.bypassCount).toBe(1);
        state = apply(state, { id: 'free-2', type: 'TABLE_FREE', at: 11, tableId: 't4' });
        expect(state.tokens.find((token) => token.id === 'B')?.tableId).toBe('t4');
        expect(state.tokens.find((token) => token.id === 'A')?.status).toBe('WAITING');
        expect(state.tokens.find((token) => token.id === 'A')?.bypassCount).toBe(2);
        state = apply(state, { id: 'free-3', type: 'TABLE_FREE', at: 12, tableId: 't2b' });
        expect(state.tokens.find((token) => token.id === 'E')?.tableId).toBe('t2b');
        expect(state.tokens.find((token) => token.id === 'D')?.bypassCount).toBe(0);
        state = apply(state, { id: 'free-4', type: 'TABLE_FREE', at: 13, tableId: 't6' });
        expect(state.tokens.find((token) => token.id === 'D')?.tableId).toBe('t6');
    });
    it('does not seat a remote party until it checks in', () => {
        let state = createQueueState([{ id: 't2', capacity: 2, status: 'FREE' }]);
        state = apply(state, join('A', 'phone-a', 2, 1));
        state = apply(state, { id: 'free-1', type: 'TABLE_FREE', at: 2, tableId: 't2' });
        expect(state.tokens[0]?.status).toBe('WAITING');
        expect(state.tokens[0]?.bypassCount).toBe(1);
        expect(state.tables[0]?.status).toBe('FREE');
    });
    it('replays the same event idempotently', () => {
        const state = createQueueState();
        const event = join('A', 'phone-a', 2, 1);
        const once = reduce(state, event);
        const twice = reduce(once.state, event);
        expect(twice.state).toEqual(once.state);
        expect(twice.effects).toEqual([]);
    });
    it('rejects a second active token for the same phone', () => {
        const state = apply(createQueueState(), join('A', 'phone-a', 2, 1));
        expect(() => reduce(state, join('B', 'phone-a', 2, 2))).toThrow('active token');
    });
    it('requires the correct lifecycle order before seating', () => {
        let state = createQueueState([{ id: 't2', capacity: 2, status: 'FREE' }]);
        state = apply(state, join('A', 'phone-a', 2, 1));
        state = apply(state, { id: 'check-a', type: 'CHECK_IN', at: 2, tokenId: 'A' });
        state = apply(state, { id: 'free-1', type: 'TABLE_FREE', at: 3, tableId: 't2' });
        state = apply(state, { id: 'ready-a', type: 'TABLE_READY_ACK', at: 4, tokenId: 'A' });
        state = apply(state, { id: 'seated-a', type: 'SEATED', at: 5, tokenId: 'A' });
        expect(state.tokens[0]?.status).toBe('SEATED');
    });
    it('releases a called table when the guest cancels or misses grace', () => {
        let state = createQueueState([{ id: 't2', capacity: 2, status: 'FREE' }]);
        state = apply(state, join('A', 'phone-a', 2, 1));
        state = apply(state, { id: 'check-a', type: 'CHECK_IN', at: 2, tokenId: 'A' });
        state = apply(state, { id: 'free-a', type: 'TABLE_FREE', at: 3, tableId: 't2' });
        state = apply(state, { id: 'ready-a', type: 'TABLE_READY_ACK', at: 4, tokenId: 'A' });
        state = apply(state, { id: 'expire-a', type: 'GRACE_EXPIRED', at: 5, tokenId: 'A' });
        expect(state.tokens[0]?.status).toBe('NO_SHOW');
        expect(state.tokens[0]?.tableId).toBeUndefined();
        expect(state.tables[0]?.status).toBe('FREE');
    });
    it('rejects a second free event after a table is assigned', () => {
        let state = createQueueState([{ id: 't2', capacity: 2, status: 'FREE' }]);
        state = apply(state, join('A', 'phone-a', 2, 1));
        state = apply(state, { id: 'check-a', type: 'CHECK_IN', at: 2, tokenId: 'A' });
        state = apply(state, { id: 'free-a', type: 'TABLE_FREE', at: 3, tableId: 't2' });
        expect(() => reduce(state, { id: 'free-b', type: 'TABLE_FREE', at: 4, tableId: 't2' })).toThrow('already occupied');
    });
    it('requires an assigned occupied table before calling a guest', () => {
        let state = createQueueState([{ id: 't2', capacity: 2, status: 'FREE' }]);
        state = apply(state, join('A', 'phone-a', 2, 1));
        state = apply(state, { id: 'check-a', type: 'CHECK_IN', at: 2, tokenId: 'A' });
        expect(() => reduce(state, { id: 'ready-a', type: 'TABLE_READY_ACK', at: 3, tokenId: 'A' }))
            .toThrow('assigned table');
    });
});
