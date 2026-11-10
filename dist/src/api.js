import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { PostgresEventStore } from './event-store.js';
import { GnaniClient } from './gnani-client.js';
import { StructuredLogNotificationService } from './notifications.js';
import { createQueueState, reduce } from './queue-engine.js';
export class InMemoryQueueRepository {
    states = new Map();
    idempotency = new Map();
    configs = new Map();
    constructor(initialTables = []) {
        this.defaultTables = initialTables;
    }
    defaultTables;
    get(restaurantId) {
        const existing = this.states.get(restaurantId);
        if (existing)
            return existing;
        const state = createQueueState(structuredClone(this.defaultTables));
        this.states.set(restaurantId, state);
        return state;
    }
    save(restaurantId, state) {
        this.states.set(restaurantId, state);
    }
    getIdempotency(restaurantId, operationKey) {
        return this.idempotency.get(`${restaurantId}:${operationKey}`);
    }
    saveIdempotency(restaurantId, operationKey, response) {
        this.idempotency.set(`${restaurantId}:${operationKey}`, response);
    }
    getRestaurantConfig(restaurantId) {
        return this.configs.get(restaurantId);
    }
    saveRestaurantConfig(restaurantId, config) {
        this.configs.set(restaurantId, config);
    }
}
export class PostgresQueueRepository {
    eventStore;
    defaultTables;
    constructor(eventStore = new PostgresEventStore(), defaultTables = []) {
        this.eventStore = eventStore;
        this.defaultTables = defaultTables;
    }
    async get(restaurantId) {
        await this.eventStore.ensureTables(restaurantId, this.defaultTables);
        let state = createQueueState(structuredClone(this.defaultTables));
        for (const record of await this.eventStore.list(restaurantId)) {
            const event = { ...record.payload, id: record.id, type: record.type };
            state = reduce(state, event).state;
        }
        return state;
    }
    async save(restaurantId, _state, event) {
        if (!event)
            throw new Error('Postgres queue saves require the applied event');
        await this.eventStore.append({
            id: event.id,
            restaurantId,
            ...(event.type === 'JOIN' ? { tokenId: event.token.id } : event.type !== 'TABLE_FREE' ? { tokenId: event.tokenId } : {}),
            type: event.type,
            payload: event
        }, _state);
    }
    async close() {
        await this.eventStore.close();
    }
    withLock(restaurantId, work) {
        return this.eventStore.withLock(restaurantId, work);
    }
    getIdempotency(restaurantId, operationKey) {
        return this.eventStore.getIdempotency(restaurantId, operationKey);
    }
    saveIdempotency(restaurantId, operationKey, response) {
        return this.eventStore.saveIdempotency(restaurantId, operationKey, response);
    }
    getRestaurantConfig(restaurantId) {
        return this.eventStore.getRestaurantConfig(restaurantId);
    }
    saveRestaurantConfig(restaurantId, config) {
        return this.eventStore.saveRestaurantConfig(restaurantId, config);
    }
}
export function createApp(repository = new InMemoryQueueRepository(), gnani = new GnaniClient(), notificationService = new StructuredLogNotificationService()) {
    const app = Fastify({ logger: { serializers: { req: (request) => ({ method: request.method, url: request.url }) } } });
    const locks = new Map();
    const graceTimers = new Map();
    const voiceRequests = new Map();
    const subscribers = new Map();
    const idempotency = new Map();
    const restaurants = new Map();
    const sessionSecret = process.env.STAFF_SESSION_SECRET ?? process.env.STAFF_API_KEY ?? 'development-staff-session-secret';
    const staffUsername = process.env.STAFF_USERNAME;
    const staffPassword = process.env.STAFF_PASSWORD;
    const graceWindowMs = Number(process.env.GRACE_WINDOW_MS ?? 5 * 60 * 1000);
    const scheduleGrace = (restaurantId, tokenId, deadline) => {
        const key = `${restaurantId}:${tokenId}`;
        const existing = graceTimers.get(key);
        if (existing)
            clearTimeout(existing);
        const timer = setTimeout(() => {
            void dispatch(repository, restaurantId, {
                id: randomUUID(),
                type: 'GRACE_EXPIRED',
                at: Date.now(),
                tokenId
            }, locks).finally(() => graceTimers.delete(key));
        }, Math.max(0, deadline - Date.now()));
        graceTimers.set(key, timer);
    };
    app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    const sourcePublic = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
    const compiledPublic = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
    app.register(fastifyStatic, {
        root: fs.existsSync(sourcePublic) ? sourcePublic : compiledPublic,
        index: 'index.html'
    });
    app.get('/', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/openapi.json', async () => ({
        openapi: '3.0.3',
        info: { title: 'LowQueue API', version: '1.0.0' },
        servers: [{ url: '/' }],
        paths: {
            '/restaurants/{restaurantId}/tokens': { post: { summary: 'Join the restaurant waitlist' } },
            '/restaurants/{restaurantId}/tokens/{tokenId}': { get: { summary: 'Get token status' }, delete: { summary: 'Cancel token' } },
            '/restaurants/{restaurantId}/tokens/{tokenId}/check-in': { post: { summary: 'Check in a guest' } },
            '/restaurants/{restaurantId}/tables/{tableId}/free': { post: { summary: 'Free a table' } },
            '/restaurants/{restaurantId}/events': { get: { summary: 'Subscribe to realtime queue updates' } },
            '/auth/staff/login': { post: { summary: 'Create a staff session' } },
            '/auth/staff/logout': { post: { summary: 'End a staff session' } }
        }
    }));
    app.post('/auth/staff/login', async (request, reply) => {
        if (!staffUsername || !staffPassword) {
            return reply.code(503).send({ error: 'staff credentials are not configured' });
        }
        if (request.body?.username !== staffUsername || !safeSecretEqual(request.body?.password, staffPassword)) {
            return reply.code(401).send({ error: 'invalid staff credentials' });
        }
        const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
        const value = signSession(staffUsername, expiresAt, sessionSecret);
        reply.header('set-cookie', `lowqueue_staff=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return { authenticated: true, expiresAt };
    });
    app.post('/auth/staff/logout', async (_request, reply) => {
        reply.header('set-cookie', 'lowqueue_staff=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return { authenticated: false };
    });
    app.get('/auth/staff/me', async (request) => ({
        authenticated: isStaffAuthenticated(request.headers.cookie, request.headers['x-staff-api-key'], staffUsername, sessionSecret)
    }));
    app.get('/restaurants/:restaurantId/events', async (request, reply) => {
        reply.hijack();
        const response = reply.raw;
        response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        });
        response.write(`event: ready\ndata: ${JSON.stringify({ restaurantId: request.params.restaurantId })}\n\n`);
        const listeners = subscribers.get(request.params.restaurantId) ?? new Set();
        const listener = (payload) => response.write(`event: queue\ndata: ${payload}\n\n`);
        listeners.add(listener);
        subscribers.set(request.params.restaurantId, listeners);
        request.raw.on('close', () => {
            listeners.delete(listener);
            if (listeners.size === 0)
                subscribers.delete(request.params.restaurantId);
        });
    });
    if (repository.close) {
        app.addHook('onClose', async () => repository.close?.());
    }
    app.post('/voice/text-to-speech', async (request, reply) => {
        if (!allowVoiceRequest(request.ip, voiceRequests)) {
            return reply.code(429).send({ error: 'voice request rate limit exceeded' });
        }
        const body = request.body;
        if (!body || typeof body.text !== 'string' || body.text.trim().length === 0 ||
            typeof body.voice !== 'string' || body.voice.trim().length === 0) {
            return reply.code(400).send({ error: 'text and voice are required' });
        }
        try {
            const response = await gnani.synthesize(body);
            if (!response.ok) {
                return reply.code(response.status).send({ error: await response.text() });
            }
            return reply.type(response.headers.get('content-type') ?? 'audio/wav').send(Buffer.from(await response.arrayBuffer()));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Speech synthesis failed';
            return reply.code(502).send({ error: message });
        }
    });
    app.post('/voice/speech-to-text', async (request, reply) => {
        if (!allowVoiceRequest(request.ip, voiceRequests)) {
            return reply.code(429).send({ error: 'voice request rate limit exceeded' });
        }
        const file = await request.file();
        if (!file)
            return reply.code(400).send({ error: 'audio file is required' });
        const audio = await file.toBuffer();
        if (audio.length === 0)
            return reply.code(400).send({ error: 'audio file is empty' });
        try {
            return await gnani.transcribe(audio, file.filename, file.mimetype, request.query.languageCode ?? 'en-IN');
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Speech transcription failed';
            return reply.code(502).send({ error: message });
        }
    });
    app.post('/restaurants/:restaurantId/tokens', async (request, reply) => {
        const requestKey = request.headers['idempotency-key'];
        const cacheKey = typeof requestKey === 'string'
            ? `${request.method}:${request.params.restaurantId}:${requestKey}`
            : undefined;
        const stored = cacheKey
            ? await getIdempotency(repository, request.params.restaurantId, cacheKey, idempotency)
            : undefined;
        if (stored !== undefined) {
            return reply.code(201).send(stored);
        }
        const { phone, partySize, source = 'remote' } = request.body ?? {};
        if (typeof phone !== 'string' || phone.trim().length < 5) {
            return reply.code(400).send({ error: 'phone is required' });
        }
        if (!Number.isInteger(partySize) || partySize < 1 || partySize > 20) {
            return reply.code(400).send({ error: 'partySize must be an integer from 1 to 20' });
        }
        if (source !== 'remote' && source !== 'walk_in') {
            return reply.code(400).send({ error: 'source must be remote or walk_in' });
        }
        const tokenId = randomUUID();
        const joinedAt = Date.now();
        const token = {
            id: tokenId,
            phoneHash: hashPhone(phone),
            partySize,
            source,
            joinedAt
        };
        const event = {
            id: randomUUID(),
            type: 'JOIN',
            at: joinedAt,
            token
        };
        const result = await dispatch(repository, request.params.restaurantId, event, locks);
        if (result.error)
            return reply.code(result.error.status).send({ error: result.error.message });
        const createdToken = findToken(result.state, tokenId);
        const payload = {
            token: createdToken,
            position: createdToken ? getPosition(result.state, tokenId) : null,
            version: result.state.version
        };
        if (cacheKey)
            await saveIdempotency(repository, request.params.restaurantId, cacheKey, payload, idempotency);
        return reply.code(201).send(payload);
    });
    app.get('/restaurants/:restaurantId/tokens/:tokenId', async (request, reply) => {
        const state = await repository.get(request.params.restaurantId);
        const token = findToken(state, request.params.tokenId);
        if (!token)
            return reply.code(404).send({ error: 'Token not found' });
        if (token.status === 'CALLED' && token.graceDeadline !== undefined && token.graceDeadline <= Date.now()) {
            const expired = await dispatch(repository, request.params.restaurantId, {
                id: randomUUID(),
                type: 'GRACE_EXPIRED',
                at: Date.now(),
                tokenId: token.id
            }, locks);
            if (expired.error)
                return reply.code(expired.error.status).send({ error: expired.error.message });
            return { token: findToken(expired.state, token.id), position: null, version: expired.state.version };
        }
        const position = getPosition(state, token.id);
        return { token, position, version: state.version };
    });
    app.get('/restaurants/:restaurantId/summary', async (request) => {
        const state = await repository.get(request.params.restaurantId);
        return {
            restaurantId: request.params.restaurantId,
            version: state.version,
            tables: state.tables,
            tokens: state.tokens,
            waiting: state.tokens.filter((token) => ['WAITING', 'ON_MY_WAY', 'CHECKED_IN'].includes(token.status)).length,
            called: state.tokens.filter((token) => token.status === 'CALLED').length,
            seated: state.tokens.filter((token) => token.status === 'SEATED').length,
            averageWaitMinutes: averageWaitMinutes(state)
        };
    });
    app.get('/restaurants', async () => [...restaurants.entries()].map(([id, config]) => ({ id, ...config })));
    app.post('/restaurants', async (request, reply) => {
        const id = typeof request.body?.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(request.body.id)
            ? request.body.id
            : randomUUID();
        const config = {
            name: typeof request.body?.name === 'string' && request.body.name.trim() ? request.body.name.trim() : id,
            averageTableTurnMinutes: Number.isFinite(request.body?.averageTableTurnMinutes) &&
                (request.body?.averageTableTurnMinutes ?? 0) > 0
                ? Number(request.body.averageTableTurnMinutes)
                : 15
        };
        restaurants.set(id, config);
        if (repository.saveRestaurantConfig)
            await repository.saveRestaurantConfig(id, config);
        return reply.code(201).send({ id, ...config });
    });
    app.post('/restaurants/:restaurantId/config', async (request, reply) => {
        const persisted = repository.getRestaurantConfig
            ? await repository.getRestaurantConfig(request.params.restaurantId)
            : undefined;
        const current = restaurants.get(request.params.restaurantId) ?? persisted ?? {
            name: request.params.restaurantId,
            averageTableTurnMinutes: 15
        };
        const next = {
            name: typeof request.body?.name === 'string' && request.body.name.trim() ? request.body.name.trim() : current.name,
            averageTableTurnMinutes: Number.isFinite(request.body?.averageTableTurnMinutes) &&
                (request.body?.averageTableTurnMinutes ?? 0) > 0
                ? Number(request.body?.averageTableTurnMinutes)
                : current.averageTableTurnMinutes
        };
        restaurants.set(request.params.restaurantId, next);
        if (repository.saveRestaurantConfig) {
            await repository.saveRestaurantConfig(request.params.restaurantId, next);
        }
        return reply.send({ id: request.params.restaurantId, ...next });
    });
    app.get('/restaurants/:restaurantId/analytics', async (request) => {
        const state = await repository.get(request.params.restaurantId);
        return {
            restaurantId: request.params.restaurantId,
            totalTokens: state.tokens.length,
            seated: state.tokens.filter((token) => token.status === 'SEATED').length,
            noShows: state.tokens.filter((token) => token.status === 'NO_SHOW').length,
            cancellations: state.tokens.filter((token) => token.status === 'CANCELLED').length,
            averageWaitMinutes: averageWaitMinutes(state)
        };
    });
    app.post('/restaurants/:restaurantId/tokens/:tokenId/on-my-way', async (request, reply) => executeTokenEvent(request, reply, repository, 'ON_MY_WAY', locks, subscribers, idempotency));
    app.post('/restaurants/:restaurantId/tokens/:tokenId/check-in', async (request, reply) => executeTokenEvent(request, reply, repository, 'CHECK_IN', locks, subscribers, idempotency));
    app.post('/restaurants/:restaurantId/tokens/:tokenId/ready', async (request, reply) => {
        const result = await executeTokenEvent(request, reply, repository, 'TABLE_READY_ACK', locks, subscribers, idempotency);
        if (result && typeof result === 'object' && 'token' in result) {
            const token = result.token;
            if (token && typeof token === 'object' && 'id' in token && 'graceDeadline' in token &&
                typeof token.id === 'string' && typeof token.graceDeadline === 'number') {
                scheduleGrace(request.params.restaurantId, token.id, token.graceDeadline);
            }
        }
        return result;
    });
    app.post('/restaurants/:restaurantId/tokens/:tokenId/seated', async (request, reply) => executeTokenEvent(request, reply, repository, 'SEATED', locks, subscribers, idempotency));
    app.delete('/restaurants/:restaurantId/tokens/:tokenId', async (request, reply) => executeTokenEvent(request, reply, repository, 'CANCEL', locks, subscribers, idempotency));
    app.post('/restaurants/:restaurantId/tables/:tableId/free', async (request, reply) => {
        if (!isStaffAuthenticated(request.headers.cookie, request.headers['x-staff-api-key'], staffUsername, sessionSecret)) {
            return reply.code(401).send({ error: 'staff authentication required' });
        }
        const event = {
            id: randomUUID(),
            type: 'TABLE_FREE',
            at: Date.now(),
            tableId: request.params.tableId
        };
        const requestKey = request.headers['idempotency-key'];
        const cacheKey = typeof requestKey === 'string'
            ? `${request.method}:${request.params.restaurantId}:${request.params.tableId}:${requestKey}`
            : undefined;
        const stored = cacheKey
            ? await getIdempotency(repository, request.params.restaurantId, cacheKey, idempotency)
            : undefined;
        if (stored !== undefined)
            return stored;
        const result = await dispatch(repository, request.params.restaurantId, event, locks);
        if (result.error)
            return reply.code(result.error.status).send({ error: result.error.message });
        publish(request.params.restaurantId, result, subscribers);
        for (const effect of result.effects) {
            if (effect.type === 'NOTIFY') {
                await notificationService.send({
                    restaurantId: request.params.restaurantId,
                    tokenId: effect.tokenId,
                    channel: 'sms',
                    message: effect.message
                });
            }
        }
        const payload = {
            effects: result.effects,
            version: result.state.version,
            tables: result.state.tables
        };
        if (cacheKey)
            await saveIdempotency(repository, request.params.restaurantId, cacheKey, payload, idempotency);
        return payload;
    });
    return app;
}
async function executeTokenEvent(request, reply, repository, type, locks, subscribers, idempotency) {
    const tokenId = request.params.tokenId;
    const requestKey = request.headers['idempotency-key'];
    const cacheKey = typeof requestKey === 'string'
        ? `${request.method}:${request.params.restaurantId}:${tokenId}:${type}:${requestKey}`
        : undefined;
    const stored = cacheKey
        ? await getIdempotency(repository, request.params.restaurantId, cacheKey, idempotency)
        : undefined;
    if (stored !== undefined)
        return stored;
    const event = {
        id: randomUUID(),
        type,
        at: Date.now(),
        tokenId
    };
    const result = await dispatch(repository, request.params.restaurantId, event, locks);
    if (result.error)
        return reply.code(result.error.status).send({ error: result.error.message });
    publish(request.params.restaurantId, result, subscribers);
    const payload = { token: findToken(result.state, tokenId), effects: result.effects, version: result.state.version };
    if (cacheKey)
        await saveIdempotency(repository, request.params.restaurantId, cacheKey, payload, idempotency);
    return payload;
}
async function dispatch(repository, restaurantId, event, locks) {
    const run = async () => {
        const currentState = await repository.get(restaurantId);
        try {
            const result = reduce(currentState, event);
            await repository.save(restaurantId, result.state, event);
            return result;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid queue event';
            return { state: currentState, effects: [], error: { status: 409, message } };
        }
    };
    const previous = locks.get(restaurantId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    locks.set(restaurantId, queued);
    await previous;
    try {
        return repository.withLock
            ? await repository.withLock(restaurantId, run)
            : await run();
    }
    finally {
        release();
        if (locks.get(restaurantId) === queued)
            locks.delete(restaurantId);
    }
}
function publish(restaurantId, result, subscribers) {
    const payload = JSON.stringify({ version: result.state.version, effects: result.effects });
    for (const listener of subscribers.get(restaurantId) ?? [])
        listener(payload);
}
function averageWaitMinutes(state) {
    const now = Date.now();
    const waiting = state.tokens.filter((token) => ['WAITING', 'ON_MY_WAY', 'CHECKED_IN'].includes(token.status));
    if (waiting.length === 0)
        return 0;
    return Math.round(waiting.reduce((total, token) => total + Math.max(0, now - token.joinedAt), 0) / waiting.length / 60000);
}
function findToken(state, tokenId) {
    return state.tokens.find((token) => token.id === tokenId);
}
function getPosition(state, tokenId) {
    const token = findToken(state, tokenId);
    if (!token || token.tableId || ['SEATED', 'NO_SHOW', 'CANCELLED'].includes(token.status))
        return null;
    return state.tokens
        .filter((candidate) => ['WAITING', 'ON_MY_WAY', 'CHECKED_IN', 'CALLED'].includes(candidate.status) &&
        candidate.joinedAt <= token.joinedAt)
        .sort((left, right) => left.joinedAt - right.joinedAt)
        .findIndex((candidate) => candidate.id === tokenId) + 1;
}
function hashPhone(phone) {
    return createHmac('sha256', process.env.PHONE_HASH_SECRET ?? 'development-only-salt')
        .update(phone.trim())
        .digest('hex');
}
function allowVoiceRequest(address, requests) {
    const now = Date.now();
    const current = requests.get(address);
    if (!current || now - current.startedAt >= 60_000) {
        requests.set(address, { startedAt: now, count: 1 });
        return true;
    }
    if (current.count >= 20)
        return false;
    current.count += 1;
    return true;
}
async function getIdempotency(repository, restaurantId, operationKey, fallback) {
    const persisted = repository.getIdempotency
        ? await repository.getIdempotency(restaurantId, operationKey)
        : undefined;
    return persisted ?? fallback.get(`${restaurantId}:${operationKey}`);
}
async function saveIdempotency(repository, restaurantId, operationKey, response, fallback) {
    fallback.set(`${restaurantId}:${operationKey}`, response);
    if (repository.saveIdempotency)
        await repository.saveIdempotency(restaurantId, operationKey, response);
}
function safeSecretEqual(value, expected) {
    if (value === undefined)
        return false;
    const actual = Buffer.from(value);
    const target = Buffer.from(expected);
    return actual.length === target.length && timingSafeEqual(actual, target);
}
function signSession(username, expiresAt, secret) {
    const payload = `${username}.${expiresAt}`;
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}
function isStaffAuthenticated(cookie, apiKey, username, sessionSecret) {
    if (!process.env.STAFF_API_KEY && !username)
        return true;
    if (process.env.STAFF_API_KEY && typeof apiKey === 'string' && apiKey === process.env.STAFF_API_KEY)
        return true;
    if (!username || !cookie)
        return false;
    const session = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('lowqueue_staff='));
    const value = session?.slice('lowqueue_staff='.length);
    if (!value)
        return false;
    const [sessionUser, expiresText, signature] = value.split('.');
    const expiresAt = Number(expiresText);
    if (!sessionUser || !signature || sessionUser !== username || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return false;
    }
    const expectedSignature = signSession(sessionUser, expiresAt, sessionSecret).split('.').pop();
    return expectedSignature !== undefined && safeSecretEqual(signature, expectedSignature);
}
