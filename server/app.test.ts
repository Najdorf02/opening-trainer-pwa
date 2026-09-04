import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { MemoryAuthStore } from './auth.js';
import type { ServerConfig } from './config.js';
import { LichessClient } from './lichess.js';
import { parseStudyPgn } from './parser.js';
import { StudyStorage } from './storage.js';
import { StudySyncService, SyncRateLimitedError } from './sync.js';
import { CACHE_SCHEMA_VERSION } from './types.js';

const GRAPH_PGN = `[Event "API graph fixture"]
[Site "https://lichess.org/study/study001/chapter1"]
[StudyName "White repertoire"]
[ChapterName "King pawn"]
[ChapterURL "https://lichess.org/study/study001/chapter1"]
[Orientation "white"]
[Result "*"]

1. e4 e5 2. Nf3 (2. Bc4) *`;

interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

function makeConfig(dataDir: string): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 5173,
    origin: 'http://127.0.0.1:5173',
    dataDir,
    lichessBaseUrl: 'https://lichess.org',
    lichessUsername: 'SaturdayCthuns',
    oauthClientId: 'opening-trainer.local',
    oauthCallbackPath: '/api/auth/callback',
    oauthPendingTtlMs: 600_000,
    requestTimeoutMs: 120_000,
    production: false,
  };
}

async function listen(app: ReturnType<typeof createApp>): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function requestJson(
  server: Server,
  method: string,
  route: string,
  host = '127.0.0.1:5173',
  extraHeaders: Record<string, string | undefined> = {},
): Promise<TestResponse> {
  const address = server.address() as AddressInfo;
  const headers: Record<string, string> = {
    Host: host,
    Origin: 'http://127.0.0.1:5173',
  };
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      path: route,
      method,
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = text ? JSON.parse(text) as unknown : undefined;
        } catch {
          body = text;
        }
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body,
        });
      });
    });
    request.once('error', reject);
    request.end();
  });
}

describe('stable local API contract', () => {
  it('serves auth, library, chapter, and sync routes without exposing a token', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'opening-trainer-app-'));
    const config = makeConfig(dataDir);
    const auth = new MemoryAuthStore(config.oauthPendingTtlMs);
    const lichess = new LichessClient(config);
    const storage = new StudyStorage(dataDir, config.lichessUsername);
    await storage.initialize();
    const sync = new StudySyncService(auth, lichess, storage);
    const server = await listen(createApp({ config, auth, lichess, storage, sync }));

    try {
      await expect(requestJson(server, 'GET', '/api/auth/status')).resolves.toMatchObject({
        status: 200,
        body: { connected: false },
      });
      const login = await requestJson(server, 'POST', '/api/auth/login');
      expect(login.status).toBe(200);
      expect(login.body).toEqual({
        authorizationUrl: expect.stringContaining('https://lichess.org/oauth?'),
      });
      expect(JSON.stringify(login.body)).not.toContain('access_token');
      expect(login.headers['set-cookie']?.[0]).toContain('HttpOnly');

      const firstAuthorizationUrl = (login.body as { authorizationUrl: string }).authorizationUrl;
      const firstState = new URL(firstAuthorizationUrl).searchParams.get('state')!;
      const firstCookie = login.headers['set-cookie']![0].split(';', 1)[0];
      const firstSessionId = firstCookie.split('=', 2)[1];
      const secondLogin = await requestJson(server, 'POST', '/api/auth/login', undefined, {
        Cookie: firstCookie,
        'Sec-Fetch-Site': 'same-origin',
      });
      const secondCookie = secondLogin.headers['set-cookie']![0].split(';', 1)[0];
      const secondSessionId = secondCookie.split('=', 2)[1];
      const secondState = new URL(
        (secondLogin.body as { authorizationUrl: string }).authorizationUrl,
      ).searchParams.get('state')!;
      expect(secondSessionId).not.toBe(firstSessionId);
      expect(auth.consume(firstState, firstSessionId)).toBeUndefined();

      await expect(requestJson(server, 'GET', '/api/library')).resolves.toMatchObject({
        status: 200,
        body: { studies: [], sample: false },
      });
      await expect(requestJson(server, 'GET', '/api/repertoires')).resolves.toMatchObject({
        status: 200,
        headers: { 'cache-control': 'no-store' },
        body: { studies: [] },
      });
      await expect(requestJson(server, 'GET', '/api/chapters/missing')).resolves.toMatchObject({
        status: 404,
        body: { error: { code: 'not_found' } },
      });
      await expect(requestJson(server, 'POST', '/api/sync')).resolves.toMatchObject({
        status: 401,
        body: { error: { code: 'not_connected' } },
      });
      const logout = await requestJson(server, 'DELETE', '/api/auth/logout', undefined, {
        Cookie: secondCookie,
        'Sec-Fetch-Site': 'same-origin',
      });
      expect(logout).toMatchObject({
        status: 200,
        body: {},
      });
      expect(logout.headers['set-cookie']?.[0]).toContain('Max-Age=0');
      expect(auth.consume(secondState, secondSessionId)).toBeUndefined();

      await expect(requestJson(server, 'POST', '/api/auth/login', undefined, {
        Origin: undefined,
      })).resolves.toMatchObject({
        status: 403,
        body: { error: { code: 'missing_origin' } },
      });
      await expect(requestJson(server, 'DELETE', '/api/auth/logout', undefined, {
        'Sec-Fetch-Site': 'cross-site',
      })).resolves.toMatchObject({
        status: 403,
        body: { error: { code: 'cross_site' } },
      });
      await expect(requestJson(server, 'GET', '/api/auth/status', undefined, {
        Origin: undefined,
      })).resolves.toMatchObject({ status: 200 });
      const callback = await requestJson(server, 'GET', config.oauthCallbackPath, undefined, {
        Origin: undefined,
        'Sec-Fetch-Site': 'cross-site',
      });
      expect(callback.status).toBe(200);
      expect(callback.headers.location).toBeUndefined();
      expect(callback.headers['content-type']).toContain('text/html');
      expect(callback.body).toContain('window.location.replace("/?auth=error&lichess=error&reason=state")');
      await expect(requestJson(server, 'GET', '/api/auth/status', 'malicious.example')).resolves.toMatchObject({
        status: 403,
        body: { error: { code: 'invalid_host' } },
      });
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('ends the cross-site OAuth redirect chain before returning to the app shell', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'opening-trainer-oauth-return-'));
    const config = makeConfig(dataDir);
    const auth = new MemoryAuthStore(config.oauthPendingTtlMs);
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/token' && init?.method === 'POST') {
        return Response.json({
          token_type: 'Bearer',
          access_token: 'connected-token',
          expires_in: 3_600,
        });
      }
      if (url.pathname === '/api/account') {
        return Response.json({ id: 'saturdaycthuns', username: config.lichessUsername });
      }
      throw new Error(`Unexpected Lichess request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const lichess = new LichessClient(config, fetchMock as typeof fetch);
    const storage = new StudyStorage(dataDir, config.lichessUsername);
    await storage.initialize();
    const sync = new StudySyncService(auth, lichess, storage);
    const localApp = createApp({ config, auth, lichess, storage, sync });
    localApp.get('/', (_request, response) => response.type('html').send('<main>app shell</main>'));
    const server = await listen(localApp);

    try {
      const login = await requestJson(server, 'POST', '/api/auth/login', undefined, {
        'Sec-Fetch-Site': 'same-origin',
      });
      const state = new URL(
        (login.body as { authorizationUrl: string }).authorizationUrl,
      ).searchParams.get('state')!;
      const cookie = login.headers['set-cookie']![0].split(';', 1)[0];
      const callback = await requestJson(
        server,
        'GET',
        `${config.oauthCallbackPath}?code=valid-code&state=${encodeURIComponent(state)}`,
        undefined,
        {
          Cookie: cookie,
          Origin: undefined,
          'Sec-Fetch-Site': 'cross-site',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
        },
      );

      expect(callback.status).toBe(200);
      expect(callback.headers.location).toBeUndefined();
      expect(callback.headers['content-type']).toContain('text/html');
      expect(callback.headers['content-security-policy']).toContain("default-src 'none'");
      expect(callback.body).toContain('window.location.replace("/?auth=success&lichess=connected")');
      expect(auth.getCredential()).toMatchObject({
        accessToken: 'connected-token',
        username: config.lichessUsername,
      });

      await expect(requestJson(server, 'GET', '/?auth=success&lichess=connected', undefined, {
        Origin: undefined,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
      })).resolves.toMatchObject({
        status: 200,
        body: '<main>app shell</main>',
      });
      await expect(requestJson(server, 'GET', '/?auth=success&lichess=connected', undefined, {
        Origin: undefined,
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
      })).resolves.toMatchObject({
        status: 403,
        body: { error: { code: 'cross_site' } },
      });
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('returns the retained rate-limit deadline without starting another sync', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'opening-trainer-rate-limit-'));
    const config = makeConfig(dataDir);
    const auth = new MemoryAuthStore(config.oauthPendingTtlMs);
    const lichess = new LichessClient(config);
    const storage = new StudyStorage(dataDir, config.lichessUsername);
    await storage.initialize();
    const rateLimitedUntil = '2026-08-25T00:01:00.000Z';
    const syncCall = vi.fn().mockRejectedValue(new SyncRateLimitedError(rateLimitedUntil, 60));
    const sync = {
      sync: syncCall,
      library: () => storage.readCatalog(),
      chapter: async () => undefined,
    } as unknown as StudySyncService;
    const server = await listen(createApp({ config, auth, lichess, storage, sync }));

    try {
      const response = await requestJson(server, 'POST', '/api/sync', undefined, {
        'Sec-Fetch-Site': 'same-origin',
      });
      expect(response).toMatchObject({
        status: 503,
        body: {
          error: {
            code: 'rate_limited',
            rateLimitedUntil,
          },
        },
      });
      expect(response.headers['retry-after']).toBe('60');
      expect(syncCall).toHaveBeenCalledOnce();
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('serves the persisted shared repertoire graph with legacy flattened lines', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'opening-trainer-graph-api-'));
    const config = makeConfig(dataDir);
    const auth = new MemoryAuthStore(config.oauthPendingTtlMs);
    const lichess = new LichessClient(config);
    const storage = new StudyStorage(dataDir, config.lichessUsername);
    await storage.initialize();
    const parsed = parseStudyPgn(GRAPH_PGN, {
      studyId: 'study001',
      studyName: 'White repertoire',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });
    await storage.writeStudy('study001', GRAPH_PGN, parsed);
    await storage.writeCatalog({
      version: CACHE_SCHEMA_VERSION,
      owner: config.lichessUsername,
      lastSyncAt: '2026-08-25T00:00:00.000Z',
      studies: [parsed.study],
    });
    const sync = new StudySyncService(auth, lichess, storage);
    const server = await listen(createApp({ config, auth, lichess, storage, sync }));

    try {
      const response = await requestJson(server, 'GET', '/api/chapters/chapter1');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: 'chapter1',
        repertoire: {
          rootNodeId: expect.any(String),
          lines: [
            expect.objectContaining({ uciMoves: ['e2e4', 'e7e5', 'g1f3'] }),
            expect.objectContaining({ uciMoves: ['e2e4', 'e7e5', 'f1c4'] }),
          ],
        },
        lines: [
          { id: expect.any(String), initialFen: expect.any(String), moves: expect.any(Array) },
          { id: expect.any(String), initialFen: expect.any(String), moves: expect.any(Array) },
        ],
      });

      const repertoires = await requestJson(server, 'GET', '/api/repertoires');
      expect(repertoires.status).toBe(200);
      expect(repertoires.body).toMatchObject({
        studies: [{
          id: 'study001',
          name: 'White repertoire',
          chapters: [{
            id: 'chapter1',
            rootNodeId: expect.any(String),
            moves: expect.any(Object),
            positions: expect.any(Object),
          }],
        }],
      });
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('best-effort revokes an exchanged token when account verification fails', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'opening-trainer-auth-cleanup-'));
    const config = makeConfig(dataDir);
    const auth = new MemoryAuthStore(config.oauthPendingTtlMs);
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/token' && init?.method === 'POST') {
        return Response.json({
          token_type: 'Bearer',
          access_token: 'uncommitted-token',
          expires_in: 3_600,
        });
      }
      if (url.pathname === '/api/account') return new Response(null, { status: 502 });
      if (url.pathname === '/api/token' && init?.method === 'DELETE') {
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer uncommitted-token');
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected Lichess request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const lichess = new LichessClient(config, fetchMock as typeof fetch);
    const storage = new StudyStorage(dataDir, config.lichessUsername);
    await storage.initialize();
    const sync = new StudySyncService(auth, lichess, storage);
    const server = await listen(createApp({ config, auth, lichess, storage, sync }));

    try {
      const login = await requestJson(server, 'POST', '/api/auth/login', undefined, {
        'Sec-Fetch-Site': 'same-origin',
      });
      const state = new URL(
        (login.body as { authorizationUrl: string }).authorizationUrl,
      ).searchParams.get('state')!;
      const cookie = login.headers['set-cookie']![0].split(';', 1)[0];
      const callback = await requestJson(
        server,
        'GET',
        `${config.oauthCallbackPath}?code=valid-code&state=${encodeURIComponent(state)}`,
        undefined,
        {
          Cookie: cookie,
          Origin: undefined,
          'Sec-Fetch-Site': 'cross-site',
        },
      );

      expect(callback.status).toBe(200);
      expect(callback.headers.location).toBeUndefined();
      expect(callback.body).toContain('reason=lichess');
      expect(auth.getCredential()).toBeUndefined();
      expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
        'POST',
        'GET',
        'DELETE',
      ]);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
