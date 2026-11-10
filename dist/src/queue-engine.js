export function createQueueState(tables = []) {
    return {
        version: 0,
        tokens: [],
        tables,
        processedEventIds: []
    };
}
export function reduce(currentState, event, bypassLimit = 2, graceWindowMs = 5 * 60 * 1000) {
    if (currentState.processedEventIds.includes(event.id)) {
        return { state: currentState, effects: [] };
    }
    const state = structuredClone(currentState);
    const effects = [];
    state.processedEventIds.push(event.id);
    state.version += 1;
    switch (event.type) {
        case 'JOIN': {
            if (state.tokens.some((token) => token.phoneHash === event.token.phoneHash && isActive(token.status))) {
                throw new Error('This phone already has an active token');
            }
            state.tokens.push({ ...event.token, status: 'WAITING', bypassCount: 0 });
            effects.push({ type: 'TOKEN_UPDATED', tokenId: event.token.id });
            break;
        }
        case 'ON_MY_WAY': {
            const token = requireToken(state, event.tokenId);
            requireStatus(token, ['WAITING']);
            token.status = 'ON_MY_WAY';
            effects.push({ type: 'TOKEN_UPDATED', tokenId: token.id });
            break;
        }
        case 'CHECK_IN': {
            const token = requireToken(state, event.tokenId);
            requireStatus(token, ['WAITING', 'ON_MY_WAY']);
            token.status = 'CHECKED_IN';
            effects.push({ type: 'TOKEN_UPDATED', tokenId: token.id });
            break;
        }
        case 'TABLE_FREE': {
            const table = state.tables.find((candidate) => candidate.id === event.tableId);
            if (!table)
                throw new Error(`Unknown table: ${event.tableId}`);
            if (table.status === 'OCCUPIED')
                throw new Error('Table is already occupied');
            table.status = 'FREE';
            assignFirstEligibleToken(state, table, effects, bypassLimit, event.at);
            break;
        }
        case 'TABLE_READY_ACK': {
            const token = requireToken(state, event.tokenId);
            requireStatus(token, ['CHECKED_IN']);
            token.status = 'CALLED';
            token.graceDeadline = event.at + graceWindowMs;
            effects.push({ type: 'NOTIFY', tokenId: token.id, message: 'Table ready' });
            effects.push({ type: 'TOKEN_UPDATED', tokenId: token.id });
            break;
        }
        case 'SEATED': {
            const token = requireToken(state, event.tokenId);
            requireStatus(token, ['CALLED']);
            token.status = 'SEATED';
            delete token.graceDeadline;
            effects.push({ type: 'TOKEN_UPDATED', tokenId: token.id });
            break;
        }
        case 'GRACE_EXPIRED': {
            const token = requireToken(state, event.tokenId);
            requireStatus(token, ['CALLED']);
            token.status = 'NO_SHOW';
            releaseAssignedTable(state, token, effects, bypassLimit, event.at);
            effects.push({ type: 'NOTIFY', tokenId: token.id, message: 'Grace window expired' });
            effects.push({ type: 'TOKEN_UPDATED', tokenId: token.id });
            break;
        }
        case 'CANCEL':
            {
                const token = requireToken(state, event.tokenId);
                if (!isActive(token.status))
                    throw new Error('Token is already closed');
                token.status = 'CANCELLED';
                releaseAssignedTable(state, token, effects, bypassLimit, event.at);
                effects.push({ type: 'TOKEN_UPDATED', tokenId: token.id });
                break;
            }
            function releaseAssignedTable(state, token, effects, bypassLimit, at) {
                if (!token.tableId)
                    return;
                const table = state.tables.find((candidate) => candidate.id === token.tableId);
                delete token.tableId;
                delete token.graceDeadline;
                if (!table)
                    return;
                table.status = 'FREE';
                effects.push({ type: 'TOKEN_UPDATED', tokenId: token.id });
                assignFirstEligibleToken(state, table, effects, bypassLimit, at);
            }
    }
    return { state, effects };
}
function assignFirstEligibleToken(state, table, effects, bypassLimit, at) {
    const candidates = state.tokens
        .filter((token) => isQueueable(token.status) && token.tableId === undefined && token.partySize <= table.capacity)
        .sort((left, right) => left.joinedAt - right.joinedAt);
    for (const token of candidates) {
        if (token.status === 'CHECKED_IN') {
            token.status = 'CHECKED_IN';
            token.tableId = table.id;
            table.status = 'OCCUPIED';
            effects.push({ type: 'TABLE_ASSIGNED', tableId: table.id, tokenId: token.id });
            effects.push({ type: 'TOKEN_UPDATED', tokenId: token.id });
            return;
        }
        token.bypassCount += 1;
        effects.push({ type: 'TOKEN_BYPASSED', tokenId: token.id, bypassCount: token.bypassCount });
        if (token.bypassCount >= bypassLimit) {
            token.joinedAt = at;
            effects.push({ type: 'TOKEN_REQUEUED', tokenId: token.id });
        }
    }
}
function requireToken(state, tokenId) {
    const token = state.tokens.find((candidate) => candidate.id === tokenId);
    if (!token)
        throw new Error(`Unknown token: ${tokenId}`);
    return token;
}
function requireStatus(token, allowed) {
    if (!allowed.includes(token.status)) {
        throw new Error(`Invalid transition from ${token.status}`);
    }
}
function isActive(status) {
    return ['WAITING', 'ON_MY_WAY', 'CHECKED_IN', 'CALLED'].includes(status);
}
function isQueueable(status) {
    return ['WAITING', 'ON_MY_WAY', 'CHECKED_IN'].includes(status);
}
