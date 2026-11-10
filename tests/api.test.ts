import { afterEach, describe, expect, it } from 'vitest';
import { createApp, InMemoryQueueRepository } from '../src/api.js';
import { GnaniClient } from '../src/gnani-client.js';
import type { FastifyInstance } from 'fastify';

describe('queue API', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('serves the frontend dashboard', async () => {
    app = createApp();
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Join the waitlist');
  });

  it('creates a remote token and returns its position', async () => {
    app = createApp(new InMemoryQueueRepository([
      { id: 'table-2', capacity: 2, status: 'FREE' }
    ]));

    const createResponse = await app.inject({
      method: 'POST',
      url: '/restaurants/r1/tokens',
      payload: { phone: '+91 99999 11111', partySize: 2 }
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();

    const statusResponse = await app.inject({
      method: 'GET',
      url: `/restaurants/r1/tokens/${created.token.id}`
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json().position).toBe(1);
    expect(statusResponse.json().token.phoneHash).not.toContain('99999');
  });

  it('runs the corrected arrival and seating flow through HTTP', async () => {
    app = createApp(new InMemoryQueueRepository([
      { id: 'table-2', capacity: 2, status: 'FREE' }
    ]));
    const createResponse = await app.inject({
      method: 'POST',
      url: '/restaurants/r1/tokens',
      payload: { phone: '+91 99999 22222', partySize: 2 }
    });
    const tokenId = createResponse.json().token.id;

    expect((await app.inject({
      method: 'POST',
      url: `/restaurants/r1/tokens/${tokenId}/on-my-way`
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST',
      url: '/restaurants/r1/tables/table-2/free'
    })).json().effects).toContainEqual({
      type: 'TOKEN_BYPASSED', tokenId, bypassCount: 1
    });
    expect((await app.inject({
      method: 'POST',
      url: `/restaurants/r1/tokens/${tokenId}/check-in`
    })).statusCode).toBe(200);
    const freeResponse = await app.inject({
      method: 'POST',
      url: '/restaurants/r1/tables/table-2/free'
    });
    expect(freeResponse.json().effects).toContainEqual({
      type: 'TABLE_ASSIGNED', tableId: 'table-2', tokenId
    });
    expect((await app.inject({
      method: 'POST',
      url: `/restaurants/r1/tokens/${tokenId}/ready`
    })).json().token.status).toBe('CALLED');
    expect((await app.inject({
      method: 'POST',
      url: `/restaurants/r1/tokens/${tokenId}/seated`
    })).json().token.status).toBe('SEATED');
  });

  it('returns conflicts for a second active token on the same phone', async () => {
    app = createApp();
    const payload = { phone: '+91 99999 33333', partySize: 2 };
    expect((await app.inject({ method: 'POST', url: '/restaurants/r1/tokens', payload })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/restaurants/r1/tokens', payload })).statusCode).toBe(409);
  });

  it('proxies text-to-speech audio without exposing the API key', async () => {
    const gnani = new GnaniClient('test-key', async (input, init) => {
      expect(input).toBe('https://api.vachana.ai/api/v1/tts/inference');
      expect((init?.headers as Record<string, string>)['X-API-Key-ID']).toBe('test-key');
      return new Response(Buffer.from('wav-data'), {
        status: 200,
        headers: { 'content-type': 'audio/wav' }
      });
    });
    app = createApp(undefined, gnani);

    const response = await app.inject({
      method: 'POST',
      url: '/voice/text-to-speech',
      payload: { text: 'Your table is ready', voice: 'Nalini' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('audio/wav');
    expect(response.body).toBe('wav-data');
  });

  it('proxies multipart speech-to-text requests', async () => {
    const gnani = new GnaniClient('test-key', async (input, init) => {
      expect(input).toBe('https://api.vachana.ai/stt/v3');
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ text: 'table ready' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    app = createApp(undefined, gnani);

    const boundary = '----lowqueue-test';
    const multipartBody = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="audio_file"; filename="sample.wav"',
      'Content-Type: audio/wav',
      '',
      'audio-data',
      `--${boundary}--`,
      ''
    ].join('\r\n');
    const response = await app.inject({
      method: 'POST',
      url: '/voice/speech-to-text?languageCode=en-IN',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: 'table ready' });
  });
});
