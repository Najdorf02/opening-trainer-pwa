import { describe, expect, it, vi } from 'vitest';
import {
  ChessComApiError,
  ChessComClient,
  ChessComValidationError,
  parseChessComGamesQuery,
} from './chesscom.js';

const BASE_URL = 'http://127.0.0.1:49821';

function game(
  id: string,
  endTime: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    uuid: id,
    url: `https://www.chess.com/game/live/${id}`,
    pgn: `[Event "Live Chess"]\n\n1. e4 e5 2. Nf3 *`,
    end_time: endTime,
    time_class: 'rapid',
    time_control: '600',
    rated: true,
    rules: 'chess',
    white: { username: 'Yshaarrj', rating: 1800, result: 'win' },
    black: { username: 'Opponent', rating: 1750, result: 'resigned' },
    ...overrides,
  };
}

function json(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

describe('ChessComClient', () => {
  it('uses lowercase PubAPI paths, checks recent archives serially, caches them, and returns newest games first', async () => {
    const paths: string[] = [];
    const requestHeaders: Headers[] = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      requestHeaders.push(new Headers(init?.headers));
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeRequests -= 1;

      if (url.pathname.endsWith('/archives')) {
        return json({
          archives: [
            `${BASE_URL}/pub/player/yshaarrj/games/2026/07`,
            `${BASE_URL}/pub/player/yshaarrj/games/2026/09`,
            `${BASE_URL}/pub/player/yshaarrj/games/2026/08`,
          ],
        });
      }
      if (url.pathname.endsWith('/2026/09')) {
        return json({ games: [game('september', 300)] });
      }
      if (url.pathname.endsWith('/2026/08')) {
        return json({ games: [game('aug-new', 400), game('aug-old', 200)] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const client = new ChessComClient({
      baseUrl: BASE_URL,
      fetchImpl,
      cacheTtlMs: 60_000,
      now: () => Date.UTC(2026, 8, 3),
      userAgent: 'Opening-Trainer-Test/1.0',
    });

    const first = await client.games({ username: 'Yshaarrj', months: 2 });
    const second = await client.games({ username: 'Yshaarrj', months: 2 });

    expect(first).toEqual({
      username: 'Yshaarrj',
      fetchedAt: '2026-09-03T00:00:00.000Z',
      archivesChecked: 2,
      games: [
        expect.objectContaining({ id: 'aug-new', endTime: 400, timeClass: 'rapid' }),
        expect.objectContaining({ id: 'september', endTime: 300 }),
        expect.objectContaining({ id: 'aug-old', endTime: 200 }),
      ],
    });
    expect(second).toEqual(first);
    expect(paths).toEqual([
      '/pub/player/yshaarrj/games/archives',
      '/pub/player/yshaarrj/games/2026/09',
      '/pub/player/yshaarrj/games/2026/08',
    ]);
    expect(maximumActiveRequests).toBe(1);
    expect(requestHeaders.every((headers) => headers.get('Accept') === 'application/json')).toBe(true);
    expect(requestHeaders.every((headers) => headers.get('User-Agent') === 'Opening-Trainer-Test/1.0')).toBe(true);
  });

  it('uses calendar months and excludes stale active archives across a long gap', async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname.endsWith('/archives')) {
        return json({
          archives: [
            `${BASE_URL}/pub/player/yshaarrj/games/2021/04`,
            `${BASE_URL}/pub/player/yshaarrj/games/2026/07`,
            `${BASE_URL}/pub/player/yshaarrj/games/2026/09`,
          ],
        });
      }
      if (url.pathname.endsWith('/2026/09')) return json({ games: [game('september', 300)] });
      if (url.pathname.endsWith('/2026/07')) return json({ games: [game('july', 100)] });
      throw new Error(`Unexpected stale archive request: ${url}`);
    }) as typeof fetch;
    const client = new ChessComClient({
      baseUrl: BASE_URL,
      fetchImpl,
      now: () => Date.UTC(2026, 8, 3),
    });

    const result = await client.games({ username: 'Yshaarrj', months: 3 });

    expect(result.archivesChecked).toBe(2);
    expect(result.games.map((item) => item.id)).toEqual(['september', 'july']);
    expect(paths).toEqual([
      '/pub/player/yshaarrj/games/archives',
      '/pub/player/yshaarrj/games/2026/09',
      '/pub/player/yshaarrj/games/2026/07',
    ]);
  });

  it('serializes PubAPI traffic across concurrent users', async () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const username = url.pathname.split('/')[3];
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeRequests -= 1;
      return url.pathname.endsWith('/archives')
        ? json({ archives: [`${BASE_URL}/pub/player/${username}/games/2025/01`] })
        : json({ games: [game(`${username}-game`, username === 'first' ? 2 : 1)] });
    }) as typeof fetch;
    const client = new ChessComClient({
      baseUrl: BASE_URL,
      fetchImpl,
      cacheTtlMs: 0,
      now: () => Date.UTC(2025, 0, 15),
    });

    await Promise.all([
      client.games({ username: 'First', months: 1 }),
      client.games({ username: 'Second', months: 1 }),
    ]);

    expect(maximumActiveRequests).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('propagates Retry-After and observes a local cooldown after a PubAPI 429', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => new Response('', {
      status: 429,
      headers: { 'Retry-After': '17' },
    })) as typeof fetch;
    const client = new ChessComClient({ baseUrl: BASE_URL, fetchImpl, now: () => now });

    await expect(client.games({ username: 'Yshaarrj', months: 1 })).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 17,
    });
    now += 5_000;
    await expect(client.games({ username: 'Another', months: 1 })).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 12,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects malformed upstream game data instead of exposing a partial contract', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname.endsWith('/archives')
        ? json({ archives: [`${BASE_URL}/pub/player/yshaarrj/games/2025/01`] })
        : json({ games: [game('bad', 10, { pgn: undefined })] });
    }) as typeof fetch;
    const client = new ChessComClient({
      baseUrl: BASE_URL,
      fetchImpl,
      now: () => Date.UTC(2025, 0, 15),
    });

    await expect(client.games({ username: 'Yshaarrj', months: 1 })).rejects.toBeInstanceOf(ChessComApiError);
    await expect(client.games({ username: 'Yshaarrj', months: 1 })).rejects.toMatchObject({ status: 502 });
  });
});

describe('parseChessComGamesQuery', () => {
  it('supplies the local default and normalizes harmless username whitespace', () => {
    expect(parseChessComGamesQuery({})).toEqual({ username: 'Yshaarrj', months: 3 });
    expect(parseChessComGamesQuery({ username: '  Mixed_CASE  ', months: '12' })).toEqual({
      username: 'Mixed_CASE',
      months: 12,
    });
  });

  it.each([
    { username: ['duplicate'] },
    { username: '../player' },
    { months: '0' },
    { months: '13' },
    { months: '1.5' },
    { months: ['3', '4'] },
  ])('rejects invalid query values: %o', (query) => {
    expect(() => parseChessComGamesQuery(query)).toThrow(ChessComValidationError);
  });
});
