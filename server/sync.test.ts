import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuthStore } from './auth.js';
import type { ServerConfig } from './config.js';
import { LichessApiError, LichessClient } from './lichess.js';
import { StudyStorage } from './storage.js';
import { StudySyncService } from './sync.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

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

async function makeStorage(): Promise<StudyStorage> {
  const directory = await mkdtemp(path.join(tmpdir(), 'opening-trainer-sync-'));
  temporaryDirectories.push(directory);
  const storage = new StudyStorage(directory, 'SaturdayCthuns');
  await storage.initialize();
  return storage;
}

function connectedAuth(): MemoryAuthStore {
  const auth = new MemoryAuthStore(600_000);
  auth.setCredential({
    accessToken: 'private-token',
    username: 'SaturdayCthuns',
    expiresAt: Date.now() + 3_600_000,
  });
  return auth;
}

describe('StudySyncService rate limiting', () => {
  it('waits at least 60 seconds and retries once when Lichess returns 429', async () => {
    const storage = await makeStorage();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 429,
        headers: { 'Retry-After': '5' },
      }))
      .mockResolvedValueOnce(new Response('', {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      }));
    const slept: number[] = [];
    const service = new StudySyncService(
      connectedAuth(),
      new LichessClient(makeConfig('unused'), fetchMock as typeof fetch),
      storage,
      {
        now: () => new Date('2026-08-25T00:00:00.000Z'),
        sleep: async (milliseconds) => { slept.push(milliseconds); },
      },
    );

    await expect(service.sync()).resolves.toEqual({
      imported: 0,
      skipped: 0,
      failed: 0,
      lastSyncAt: '2026-08-25T00:00:00.000Z',
      errors: [],
    });
    expect(slept).toEqual([60_000]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops the whole sync when the one retry is also rate-limited', async () => {
    const storage = await makeStorage();
    const studies = [
      { id: 'study001', name: 'First', createdAt: 10, updatedAt: 20 },
      { id: 'study002', name: 'Second', createdAt: 10, updatedAt: 20 },
    ];
    const requestedPaths: string[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const pathName = new URL(String(input)).pathname;
      requestedPaths.push(pathName);
      if (pathName === '/api/study/by/SaturdayCthuns') {
        return new Response(`${studies.map((study) => JSON.stringify(study)).join('\n')}\n`);
      }
      return new Response(null, { status: 429, headers: { 'Retry-After': '1' } });
    });
    const slept: number[] = [];
    const service = new StudySyncService(
      connectedAuth(),
      new LichessClient(makeConfig('unused'), fetchMock as typeof fetch),
      storage,
      { sleep: async (milliseconds) => { slept.push(milliseconds); } },
    );

    await expect(service.sync()).rejects.toEqual(expect.objectContaining({
      name: 'LichessApiError',
      status: 429,
      retryAfterSeconds: 60,
      rateLimitedUntil: expect.any(String),
    } satisfies Partial<LichessApiError> & { rateLimitedUntil: unknown }));
    expect(slept).toEqual([60_000]);
    expect(requestedPaths).toEqual([
      '/api/study/by/SaturdayCthuns',
      '/api/study/study001.pgn',
      '/api/study/study001.pgn',
    ]);

    await expect(service.sync()).rejects.toEqual(expect.objectContaining({
      name: 'LichessApiError',
      status: 429,
      retryAfterSeconds: expect.any(Number),
      rateLimitedUntil: expect.any(String),
    }));
    expect(slept).toEqual([60_000]);
    expect(requestedPaths).toEqual([
      '/api/study/by/SaturdayCthuns',
      '/api/study/study001.pgn',
      '/api/study/study001.pgn',
    ]);
    await expect(storage.readCatalog()).resolves.toMatchObject({ lastSyncAt: null, studies: [] });
  });

  it('allows syncing again after the retained rate-limit cooldown expires', async () => {
    const storage = await makeStorage();
    let nowMs = Date.parse('2026-08-25T00:00:00.000Z');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response('', {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      }));
    const service = new StudySyncService(
      connectedAuth(),
      new LichessClient(makeConfig('unused'), fetchMock as typeof fetch),
      storage,
      {
        now: () => new Date(nowMs),
        sleep: async () => {},
      },
    );

    await expect(service.sync()).rejects.toMatchObject({ status: 429 });
    await expect(service.sync()).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 60,
      rateLimitedUntil: '2026-08-25T00:01:00.000Z',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    nowMs += 60_000;
    await expect(service.sync()).resolves.toMatchObject({ imported: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('StudySyncService import reporting', () => {
  it('returns a per-study error when one study cannot be parsed', async () => {
    const storage = await makeStorage();
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const pathName = new URL(String(input)).pathname;
      if (pathName === '/api/study/by/SaturdayCthuns') {
        return new Response(`${JSON.stringify({
          id: 'study001',
          name: 'Broken study',
          createdAt: 10,
          updatedAt: 20,
        })}\n`, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }
      if (pathName === '/api/study/study001.pgn') {
        return new Response([
          '[Event "Invalid"]',
          '[Site "https://lichess.org/study/study001/chapter1"]',
          '[ChapterURL "https://lichess.org/study/study001/chapter1"]',
          '[Result "*"]',
          '',
          '1. e4 *',
        ].join('\n'), {
          headers: { 'Content-Type': 'application/x-chess-pgn' },
        });
      }
      return new Response(null, { status: 404 });
    });
    const service = new StudySyncService(
      connectedAuth(),
      new LichessClient(makeConfig('unused'), fetchMock as typeof fetch),
      storage,
      { now: () => new Date('2026-08-25T00:00:00.000Z') },
    );

    const result = await service.sync();

    expect(result).toMatchObject({
      imported: 0,
      skipped: 0,
      failed: 1,
      lastSyncAt: '2026-08-25T00:00:00.000Z',
      errors: [{
        studyId: 'study001',
        studyName: 'Broken study',
        message: expect.stringMatching(/orientation/i),
      }],
    });
    await expect(storage.readCatalog()).resolves.toMatchObject({
      lastSyncAt: '2026-08-25T00:00:00.000Z',
      studies: [],
    });
  });
});
