import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Chess } from 'chess.js';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { MemoryAuthStore } from './auth.js';
import type { ServerConfig } from './config.js';
import type { LichessClient } from './lichess.js';
import {
  OpeningDataError,
  type OpeningPracticeEvaluationResponse,
  type OpeningPracticeGateway,
} from './opening-practice.js';
import type { StudyStorage } from './storage.js';
import type { StudySyncService } from './sync.js';

const START_FEN = new Chess().fen();

interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

const config: ServerConfig = {
  host: '127.0.0.1',
  port: 5173,
  origin: 'http://127.0.0.1:5173',
  dataDir: 'unused',
  lichessBaseUrl: 'https://lichess.org',
  lichessUsername: 'SaturdayCthuns',
  oauthClientId: 'opening-trainer.local',
  oauthCallbackPath: '/api/auth/callback',
  oauthPendingTtlMs: 600_000,
  requestTimeoutMs: 120_000,
  production: false,
};

function makeGateway(): OpeningPracticeGateway {
  return {
    explore: vi.fn(async (request) => ({
      fen: request.fen,
      results: { whiteWins: 10, draws: 4, blackWins: 6 },
      moves: [{
        uci: 'e2e4',
        san: 'e4',
        averageRating: 1900,
        results: { whiteWins: 6, draws: 2, blackWins: 2 },
      }],
    })),
    evaluate: vi.fn(async (_fen, move, maximumCentipawnLoss): Promise<OpeningPracticeEvaluationResponse> => ({
      status: 'graded',
      verdict: 'pass',
      passed: true,
      reason: 'engine-within-threshold',
      move: { uci: move, san: 'e4' },
      centipawnLoss: 20,
      thresholdCp: maximumCentipawnLoss ?? 80,
      depth: 20,
      before: { depth: 21, score: { type: 'cp', value: 25 } },
      after: { depth: 20, score: { type: 'cp', value: 5 } },
      bestMoves: [{ uci: 'e2e4', san: 'e4', score: { type: 'cp', value: 25 } }],
    })),
  };
}

function makeApp(auth: MemoryAuthStore, openingPractice: OpeningPracticeGateway) {
  return createApp({
    config,
    auth,
    lichess: {} as LichessClient,
    storage: {} as StudyStorage,
    sync: {} as StudySyncService,
    openingPractice,
  });
}

async function listen(auth: MemoryAuthStore, gateway: OpeningPracticeGateway): Promise<Server> {
  const app = makeApp(auth, gateway);
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
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
): Promise<TestResponse> {
  const address = server.address() as AddressInfo;
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string | number> = {
    Host: '127.0.0.1:5173',
    Origin: 'http://127.0.0.1:5173',
    'Sec-Fetch-Site': 'same-origin',
  };
  if (serialized !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(serialized);
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
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: text ? JSON.parse(text) as unknown : undefined,
        });
      });
    });
    request.once('error', reject);
    request.end(serialized);
  });
}

describe('opening practice same-origin routes', () => {
  it('requires a current OAuth credential for Explorer and never calls the gateway without one', async () => {
    const auth = new MemoryAuthStore(config.oauthPendingTtlMs);
    const gateway = makeGateway();
    const server = await listen(auth, gateway);

    try {
      const response = await requestJson(
        server,
        'GET',
        `/api/opening-practice/explorer?fen=${encodeURIComponent(START_FEN)}`,
      );
      expect(response).toMatchObject({
        status: 401,
        body: { error: { code: 'not_connected' } },
      });
      expect(gateway.explore).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('passes the server-held bearer credential and normalized CSV filters to Explorer', async () => {
    const auth = new MemoryAuthStore(config.oauthPendingTtlMs);
    auth.setCredential({
      accessToken: 'server-only-token',
      username: config.lichessUsername,
      expiresAt: Date.now() + 60_000,
    });
    const gateway = makeGateway();
    const server = await listen(auth, gateway);

    try {
      const route = '/api/opening-practice/explorer'
        + `?fen=${encodeURIComponent(START_FEN)}`
        + '&speeds=blitz,rapid&ratings=1800,2000&moves=8';
      const response = await requestJson(server, 'GET', route);

      expect(response).toMatchObject({
        status: 200,
        body: {
          fen: START_FEN,
          results: { whiteWins: 10, draws: 4, blackWins: 6 },
          moves: [expect.objectContaining({ uci: 'e2e4', san: 'e4' })],
        },
      });
      expect(response.headers['cache-control']).toBe('private, max-age=15');
      expect(JSON.stringify(response.body)).not.toContain('server-only-token');
      expect(gateway.explore).toHaveBeenCalledWith({
        fen: START_FEN,
        speeds: ['blitz', 'rapid'],
        ratings: [1800, 2000],
        moves: 8,
      }, 'server-only-token');
    } finally {
      await close(server);
    }
  });

  it('keeps cloud evaluation public, validates its body, and returns the graded contract', async () => {
    const auth = new MemoryAuthStore(config.oauthPendingTtlMs);
    const gateway = makeGateway();
    const server = await listen(auth, gateway);

    try {
      const response = await requestJson(server, 'POST', '/api/opening-practice/evaluate', {
        fen: START_FEN,
        move: 'e2e4',
        maxCpl: 90,
      });
      expect(response).toMatchObject({
        status: 200,
        body: {
          status: 'graded',
          verdict: 'pass',
          centipawnLoss: 20,
          thresholdCp: 90,
          before: { depth: 21, score: { type: 'cp', value: 25 } },
          after: { depth: 20, score: { type: 'cp', value: 5 } },
          bestMoves: [{ uci: 'e2e4', san: 'e4' }],
        },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(gateway.evaluate).toHaveBeenCalledWith(START_FEN, 'e2e4', 90);

      const invalid = await requestJson(server, 'POST', '/api/opening-practice/evaluate', {
        fen: START_FEN,
        move: 'e2e5',
      });
      expect(invalid).toMatchObject({
        status: 400,
        body: { error: { code: 'invalid_request' } },
      });
      expect(gateway.evaluate).toHaveBeenCalledOnce();
    } finally {
      await close(server);
    }
  });

  it('maps cloud 429 to a retryable same-origin response with Retry-After intact', async () => {
    const auth = new MemoryAuthStore(config.oauthPendingTtlMs);
    const gateway = makeGateway();
    gateway.evaluate = vi.fn(async () => {
      throw new OpeningDataError('Lichess cloud rate limit reached.', 'cloud', 429, 31);
    });
    const server = await listen(auth, gateway);

    try {
      const response = await requestJson(server, 'POST', '/api/opening-practice/evaluate', {
        fen: START_FEN,
        move: 'e2e4',
      });
      expect(response).toMatchObject({
        status: 503,
        body: { error: { code: 'opening_data_rate_limited' } },
      });
      expect(response.headers['retry-after']).toBe('31');
      expect(gateway.evaluate).toHaveBeenCalledOnce();
    } finally {
      await close(server);
    }
  });
});
