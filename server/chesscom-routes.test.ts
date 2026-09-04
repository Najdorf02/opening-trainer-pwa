import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { MemoryAuthStore } from './auth.js';
import {
  ChessComApiError,
  type ChessComGamesGateway,
  type ChessComGamesResponse,
} from './chesscom.js';
import type { ServerConfig } from './config.js';
import type { LichessClient } from './lichess.js';
import type { StudyStorage } from './storage.js';
import type { StudySyncService } from './sync.js';

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

function responseFixture(): ChessComGamesResponse {
  return {
    username: 'Yshaarrj',
    fetchedAt: '2026-09-03T00:00:00.000Z',
    archivesChecked: 1,
    games: [{
      id: 'game-1',
      url: 'https://www.chess.com/game/live/1',
      pgn: '[Event "Live Chess"]\n\n1. e4 e5 *',
      endTime: 1_700_000_000,
      timeClass: 'rapid',
      timeControl: '600',
      rated: true,
      rules: 'chess',
      white: { username: 'Yshaarrj', rating: 1800, result: 'win' },
      black: { username: 'Opponent', rating: 1750, result: 'resigned' },
    }],
  };
}

function makeGateway(): ChessComGamesGateway {
  return { games: vi.fn(async () => responseFixture()) };
}

async function listen(gateway: ChessComGamesGateway): Promise<Server> {
  const app = createApp({
    config,
    auth: new MemoryAuthStore(config.oauthPendingTtlMs),
    lichess: {} as LichessClient,
    storage: {} as StudyStorage,
    sync: {} as StudySyncService,
    chessCom: gateway,
  });
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

async function requestJson(server: Server, route: string): Promise<TestResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      path: route,
      method: 'GET',
      headers: {
        Host: '127.0.0.1:5173',
        Origin: 'http://127.0.0.1:5173',
        'Sec-Fetch-Site': 'same-origin',
      },
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
    request.end();
  });
}

describe('Chess.com public game route', () => {
  it('requires no account authentication and applies the configured query defaults', async () => {
    const gateway = makeGateway();
    const server = await listen(gateway);

    try {
      const response = await requestJson(server, '/api/chesscom/games');
      expect(response).toMatchObject({
        status: 200,
        body: {
          username: 'Yshaarrj',
          archivesChecked: 1,
          games: [expect.objectContaining({ id: 'game-1', pgn: expect.any(String) })],
        },
      });
      expect(response.headers['cache-control']).toBe('private, max-age=60');
      expect(gateway.games).toHaveBeenCalledWith({ username: 'Yshaarrj', months: 3 });
    } finally {
      await close(server);
    }
  });

  it('passes an explicit username and month count and rejects invalid query values', async () => {
    const gateway = makeGateway();
    const server = await listen(gateway);

    try {
      const valid = await requestJson(server, '/api/chesscom/games?username=Another_User&months=12');
      expect(valid.status).toBe(200);
      expect(gateway.games).toHaveBeenCalledWith({ username: 'Another_User', months: 12 });

      const invalid = await requestJson(server, '/api/chesscom/games?months=13');
      expect(invalid).toMatchObject({
        status: 400,
        body: { error: { code: 'invalid_request' } },
      });
      expect(gateway.games).toHaveBeenCalledOnce();
    } finally {
      await close(server);
    }
  });

  it('maps PubAPI rate limits to a retryable local response', async () => {
    const gateway = makeGateway();
    gateway.games = vi.fn(async () => {
      throw new ChessComApiError('Chess.com public API rate limit reached.', 429, 23);
    });
    const server = await listen(gateway);

    try {
      const response = await requestJson(server, '/api/chesscom/games');
      expect(response).toMatchObject({
        status: 503,
        body: { error: { code: 'chesscom_rate_limited' } },
      });
      expect(response.headers['retry-after']).toBe('23');
    } finally {
      await close(server);
    }
  });

  it('reports a missing public profile as not found', async () => {
    const gateway = makeGateway();
    gateway.games = vi.fn(async () => {
      throw new ChessComApiError('Chess.com player or game archive was not found.', 404);
    });
    const server = await listen(gateway);

    try {
      const response = await requestJson(server, '/api/chesscom/games?username=Missing');
      expect(response).toMatchObject({
        status: 404,
        body: { error: { code: 'chesscom_player_not_found' } },
      });
    } finally {
      await close(server);
    }
  });
});
