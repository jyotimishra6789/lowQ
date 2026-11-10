import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { PostgresEventStore } from './event-store.js';
import { GnaniClient } from './gnani-client.js';
import { createQueueState, reduce } from './queue-engine.js';
export class InMemoryQueueRepository {
    states = new Map();
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
}
export function createApp(repository = new InMemoryQueueRepository(), gnani = new GnaniClient()) {
    const app = Fastify({ logger: false });
    const locks = new Map();
    const graceTimers = new Map();
    const voiceRequests = new Map();
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
        return reply.code(201).send({
            token: createdToken,
            position: createdToken ? getPosition(result.state, tokenId) : null,
            version: result.state.version
        });
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
    app.post('/restaurants/:restaurantId/tokens/:tokenId/on-my-way', async (request, reply) => executeTokenEvent(request, reply, repository, 'ON_MY_WAY', locks));
    app.post('/restaurants/:restaurantId/tokens/:tokenId/check-in', async (request, reply) => executeTokenEvent(request, reply, repository, 'CHECK_IN', locks));
    app.post('/restaurants/:restaurantId/tokens/:tokenId/ready', async (request, reply) => {
        const result = await executeTokenEvent(request, reply, repository, 'TABLE_READY_ACK', locks);
        if (result && typeof result === 'object' && 'token' in result) {
            const token = result.token;
            if (token && typeof token === 'object' && 'id' in token && 'graceDeadline' in token &&
                typeof token.id === 'string' && typeof token.graceDeadline === 'number') {
                scheduleGrace(request.params.restaurantId, token.id, token.graceDeadline);
            }
        }
        return result;
    });
    app.post('/restaurants/:restaurantId/tokens/:tokenId/seated', async (request, reply) => executeTokenEvent(request, reply, repository, 'SEATED', locks));
    app.delete('/restaurants/:restaurantId/tokens/:tokenId', async (request, reply) => executeTokenEvent(request, reply, repository, 'CANCEL', locks));
    app.post('/restaurants/:restaurantId/tables/:tableId/free', async (request, reply) => {
        if (process.env.STAFF_API_KEY && request.headers['x-staff-api-key'] !== process.env.STAFF_API_KEY) {
            return reply.code(401).send({ error: 'staff authentication required' });
        }
        const event = {
            id: randomUUID(),
            type: 'TABLE_FREE',
            at: Date.now(),
            tableId: request.params.tableId
        };
        const result = await dispatch(repository, request.params.restaurantId, event, locks);
        if (result.error)
            return reply.code(result.error.status).send({ error: result.error.message });
        return { effects: result.effects, version: result.state.version };
    });
    return app;
}
async function executeTokenEvent(request, reply, repository, type, locks) {
    const tokenId = request.params.tokenId;
    const event = {
        id: randomUUID(),
        type,
        at: Date.now(),
        tokenId
    };
    const result = await dispatch(repository, request.params.restaurantId, event, locks);
    if (result.error)
        return reply.code(result.error.status).send({ error: result.error.message });
    return { token: findToken(result.state, tokenId), effects: result.effects, version: result.state.version };
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
