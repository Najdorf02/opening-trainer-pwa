import { Chess } from 'chess.js';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_CPL,
  OpeningDataError,
  OpeningPracticeClient,
  OpeningPracticeValidationError,
  parseEvaluationBody,
  parseExplorerQuery,
  type OpeningExplorerRequest,
} from './opening-practice.js';

const START_FEN = new Chess().fen();
const DEFAULT_REQUEST: OpeningExplorerRequest = {
  fen: START_FEN,
  speeds: ['blitz', 'rapid', 'classical'],
  ratings: [1600, 1800, 2000, 2200, 2500],
  moves: 12,
};

function asUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

function cloud(depth: number, score: { cp: number } | { mate: number }, moves: string): Response {
  return Response.json({ depth, pvs: [{ ...score, moves }] });
}

describe('OpeningPracticeClient explorer adapter', () => {
  it('authenticates the Explorer request, normalizes its response, and caches briefly', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = asUrl(input);
      expect(url.origin).toBe('https://explorer.lichess.org');
      expect(url.pathname).toBe('/lichess');
      expect(url.searchParams.get('variant')).toBe('standard');
      expect(url.searchParams.get('fen')).toBe(START_FEN);
      expect(url.searchParams.get('speeds')).toBe('blitz,rapid,classical');
      expect(url.searchParams.get('ratings')).toBe('1600,1800,2000,2200,2500');
      expect(url.searchParams.get('moves')).toBe('12');
      expect(url.search).not.toContain('private-token');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-token');
      return Response.json({
        white: 100,
        draws: 20,
        black: 80,
        opening: { eco: 'B00', name: "King's Pawn" },
        moves: [{
          uci: 'e2e4',
          san: 'ignored upstream SAN',
          averageRating: 1900,
          white: 60,
          draws: 10,
          black: 30,
        }],
      });
    });
    const client = new OpeningPracticeClient({ fetchImpl: fetchMock as typeof fetch });

    const first = await client.explore(DEFAULT_REQUEST, 'private-token');
    const second = await client.explore(DEFAULT_REQUEST, 'another-valid-token');

    expect(first).toEqual({
      fen: START_FEN,
      results: { whiteWins: 100, draws: 20, blackWins: 80 },
      opening: { eco: 'B00', name: "King's Pawn" },
      moves: [{
        uci: 'e2e4',
        san: 'e4',
        averageRating: 1900,
        results: { whiteWins: 60, draws: 10, blackWins: 30 },
      }],
    });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry and preserves Explorer rate-limit details', async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 429,
      headers: { 'Retry-After': '17' },
    }));
    const client = new OpeningPracticeClient({ fetchImpl: fetchMock as typeof fetch });

    await expect(client.explore(DEFAULT_REQUEST, 'private-token')).rejects.toMatchObject({
      name: 'OpeningDataError',
      source: 'explorer',
      status: 429,
      retryAfterSeconds: 17,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('serializes distinct Explorer outbound requests while retaining per-key caching', async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return Response.json({ white: 0, draws: 0, black: 0, moves: [] });
    });
    const client = new OpeningPracticeClient({ fetchImpl: fetchMock as typeof fetch });

    await Promise.all([
      client.explore({ ...DEFAULT_REQUEST, moves: 8 }, 'private-token'),
      client.explore({ ...DEFAULT_REQUEST, moves: 12 }, 'private-token'),
    ]);
    await client.explore({ ...DEFAULT_REQUEST, moves: 8 }, 'private-token');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
  });

  it('rejects malformed filters, positions, and bearer credentials before fetching', async () => {
    const fetchMock = vi.fn();
    const client = new OpeningPracticeClient({ fetchImpl: fetchMock as typeof fetch });

    expect(() => parseExplorerQuery({ fen: 'not a FEN' })).toThrow(OpeningPracticeValidationError);
    expect(() => parseExplorerQuery({ fen: START_FEN, speeds: 'blitz,postal' })).toThrow(
      OpeningPracticeValidationError,
    );
    expect(() => parseExplorerQuery({ fen: START_FEN, ratings: '1600,1700' })).toThrow(
      OpeningPracticeValidationError,
    );
    expect(() => parseExplorerQuery({ fen: START_FEN, ratings: '0x640' })).toThrow(
      OpeningPracticeValidationError,
    );
    expect(() => parseExplorerQuery({ fen: START_FEN, moves: '25' })).toThrow(
      OpeningPracticeValidationError,
    );
    expect(() => parseExplorerQuery({ fen: START_FEN, moves: '12.0' })).toThrow(
      OpeningPracticeValidationError,
    );
    await expect(client.explore(DEFAULT_REQUEST, 'token with spaces')).rejects.toBeInstanceOf(
      OpeningPracticeValidationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops reading an oversized upstream response', async () => {
    const fetchMock = vi.fn(async () => new Response('x'.repeat(256 * 1024 + 1)));
    const client = new OpeningPracticeClient({ fetchImpl: fetchMock as typeof fetch });

    await expect(client.explore(DEFAULT_REQUEST, 'private-token')).rejects.toMatchObject({
      name: 'OpeningDataError',
      source: 'explorer',
      status: 502,
      message: expect.stringContaining('too large'),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('OpeningPracticeClient cloud evaluation adapter', () => {
  it('computes White centipawn loss from White-POV scores without sending auth', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = asUrl(input);
      expect(url.pathname).toBe('/api/cloud-eval');
      expect(url.searchParams.get('variant')).toBe('standard');
      expect(url.searchParams.get('multiPv')).toBe('5');
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return fetchMock.mock.calls.length === 1
        ? Response.json({
          depth: 24,
          pvs: [
            { cp: 30, moves: 'e2e4 e7e5' },
            { cp: 10, moves: 'd2d4 d7d5' },
          ],
        })
        : cloud(22, { cp: 5 }, 'e7e5 g1f3');
    });
    const client = new OpeningPracticeClient({ fetchImpl: fetchMock as typeof fetch });

    const result = await client.evaluate(START_FEN, 'e2e4');

    expect(result).toEqual({
      status: 'graded',
      verdict: 'pass',
      passed: true,
      reason: 'engine-within-threshold',
      move: { uci: 'e2e4', san: 'e4' },
      centipawnLoss: 25,
      thresholdCp: DEFAULT_MAX_CPL,
      depth: 22,
      before: { depth: 24, score: { type: 'cp', value: 30 } },
      after: { depth: 22, score: { type: 'cp', value: 5 } },
      bestMoves: [
        { uci: 'e2e4', san: 'e4', score: { type: 'cp', value: 30 } },
        { uci: 'd2d4', san: 'd4', score: { type: 'cp', value: 10 } },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reverses the White-POV delta for Black and fails excessive loss', async () => {
    const board = new Chess();
    board.move('e4');
    const blackFen = board.fen();
    const fetchMock = vi.fn(async () => fetchMock.mock.calls.length === 1
      ? Response.json({
        depth: 21,
        pvs: [
          { cp: 20, moves: 'e7e5 g1f3' },
          { cp: 50, moves: 'c7c5 g1f3' },
        ],
      })
      : cloud(20, { cp: 125 }, 'g1f3 b8c6'));
    const client = new OpeningPracticeClient({ fetchImpl: fetchMock as typeof fetch });

    const result = await client.evaluate(blackFen, 'e7e5');

    expect(result).toMatchObject({
      status: 'graded',
      verdict: 'fail',
      passed: false,
      reason: 'engine-loss-too-large',
      centipawnLoss: 105,
      before: { score: { type: 'cp', value: 20 } },
      after: { score: { type: 'cp', value: 125 } },
    });
  });

  it('marks giving up a favorable forced mate as a distinct failure', async () => {
    const fetchMock = vi.fn(async () => fetchMock.mock.calls.length === 1
      ? cloud(25, { mate: 3 }, 'e2e4 e7e5')
      : cloud(24, { cp: 80 }, 'e7e5 g1f3'));
    const client = new OpeningPracticeClient({ fetchImpl: fetchMock as typeof fetch });

    await expect(client.evaluate(START_FEN, 'e2e4')).resolves.toMatchObject({
      status: 'graded',
      verdict: 'fail',
      passed: false,
      reason: 'engine-forced-mate-lost',
      before: { score: { type: 'mate', value: 3 } },
    });
  });

  it('returns explicit ungraded results when either cloud position is not cached', async () => {
    const beforeMissingFetch = vi.fn(async () => new Response(null, { status: 404 }));
    const beforeMissingClient = new OpeningPracticeClient({
      fetchImpl: beforeMissingFetch as typeof fetch,
    });
    await expect(beforeMissingClient.evaluate(START_FEN, 'e2e4')).resolves.toEqual({
      status: 'unavailable',
      reason: 'position_not_cached',
      move: { uci: 'e2e4', san: 'e4' },
    });
    expect(beforeMissingFetch).toHaveBeenCalledOnce();

    const childMissingFetch = vi.fn(async () => childMissingFetch.mock.calls.length === 1
      ? cloud(20, { cp: 15 }, 'e2e4 e7e5')
      : new Response(null, { status: 404 }));
    const childMissingClient = new OpeningPracticeClient({
      fetchImpl: childMissingFetch as typeof fetch,
    });
    await expect(childMissingClient.evaluate(START_FEN, 'e2e4')).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'child_not_cached',
    });
    expect(childMissingFetch).toHaveBeenCalledTimes(2);
  });

  it('never grades cloud evidence below the shared minimum engine depth', async () => {
    const shallowBeforeFetch = vi.fn(async () => cloud(15, { cp: 0 }, 'e2e4 e7e5'));
    const shallowBeforeClient = new OpeningPracticeClient({
      fetchImpl: shallowBeforeFetch as typeof fetch,
    });
    await expect(shallowBeforeClient.evaluate(START_FEN, 'e2e4')).resolves.toEqual({
      status: 'unavailable',
      reason: 'insufficient_depth',
      move: { uci: 'e2e4', san: 'e4' },
    });
    expect(shallowBeforeFetch).toHaveBeenCalledOnce();

    const shallowAfterFetch = vi.fn(async () => shallowAfterFetch.mock.calls.length === 1
      ? cloud(16, { cp: 10 }, 'e2e4 e7e5')
      : cloud(15, { cp: 0 }, 'e7e5 g1f3'));
    const shallowAfterClient = new OpeningPracticeClient({
      fetchImpl: shallowAfterFetch as typeof fetch,
    });
    await expect(shallowAfterClient.evaluate(START_FEN, 'e2e4')).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'insufficient_depth',
    });
    expect(shallowAfterFetch).toHaveBeenCalledTimes(2);
  });

  it('does not turn cloud transport failures into false move failures', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    const client = new OpeningPracticeClient({ fetchImpl: fetchMock as typeof fetch });

    await expect(client.evaluate(START_FEN, 'e2e4')).resolves.toEqual({
      status: 'unavailable',
      reason: 'upstream_unavailable',
      move: { uci: 'e2e4', san: 'e4' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('treats unsafe or zero-mate cloud scores as unavailable evidence', async () => {
    const invalidScores = [
      { cp: Number.MAX_SAFE_INTEGER + 1 },
      { mate: 0 },
    ];

    for (const score of invalidScores) {
      const fetchMock = vi.fn(async () => Response.json({
        depth: 20,
        pvs: [{ ...score, moves: 'e2e4 e7e5' }],
      }));
      const client = new OpeningPracticeClient({ fetchImpl: fetchMock as typeof fetch });

      await expect(client.evaluate(START_FEN, 'e2e4')).resolves.toMatchObject({
        status: 'unavailable',
        reason: 'upstream_unavailable',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it('rethrows cloud 429 with Retry-After and makes no second request', async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 429,
      headers: { 'Retry-After': '23' },
    }));
    const client = new OpeningPracticeClient({ fetchImpl: fetchMock as typeof fetch });

    await expect(client.evaluate(START_FEN, 'e2e4')).rejects.toEqual(expect.objectContaining({
      name: 'OpeningDataError',
      source: 'cloud',
      status: 429,
      retryAfterSeconds: 23,
    } satisfies Partial<OpeningDataError>));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('serializes cloud requests across concurrent evaluations', async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return cloud(20, { cp: 0 }, 'a2a3 a7a6');
    });
    const client = new OpeningPracticeClient({ fetchImpl: fetchMock as typeof fetch });
    const secondBoard = new Chess();
    secondBoard.move('d4');

    await Promise.all([
      client.evaluate(START_FEN, 'e2e4'),
      client.evaluate(secondBoard.fen(), 'd7d5'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(maximumActive).toBe(1);
  });

  it('validates legal UCI moves and threshold bounds before cloud access', () => {
    expect(() => parseEvaluationBody({ fen: START_FEN, move: 'e2e5' })).toThrow(
      OpeningPracticeValidationError,
    );
    expect(() => parseEvaluationBody({ fen: START_FEN, move: 'e2e4', maxCpl: 19 })).toThrow(
      OpeningPracticeValidationError,
    );
    expect(() => parseEvaluationBody({ fen: START_FEN, move: 'e2e4', maxCpl: '80' })).toThrow(
      OpeningPracticeValidationError,
    );
    expect(parseEvaluationBody({ fen: START_FEN, move: 'E2E4', maxCpl: 100 })).toEqual({
      fen: START_FEN,
      move: 'e2e4',
      maximumCentipawnLoss: 100,
    });
  });

  it('allows only HTTPS or HTTP loopback upstream base URLs', () => {
    expect(() => new OpeningPracticeClient({ explorerBaseUrl: 'http://example.com' })).toThrow(
      /must use HTTPS/u,
    );
    expect(() => new OpeningPracticeClient({ explorerBaseUrl: 'ftp://localhost' })).toThrow(
      /must use HTTPS/u,
    );
    expect(() => new OpeningPracticeClient({ explorerBaseUrl: 'http://127.0.0.1:9999' })).not.toThrow();
  });
});
