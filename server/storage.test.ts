import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStudyPgn } from './parser.js';
import { StudyStorage } from './storage.js';
import { CACHE_SCHEMA_VERSION } from './types.js';

const OWNER = 'SaturdayCthuns';
const temporaryDirectories: string[] = [];

const PGN = `[Event "Storage fixture"]
[Site "https://lichess.org/study/study001/chapter1"]
[StudyName "White repertoire"]
[ChapterName "King pawn"]
[ChapterURL "https://lichess.org/study/study001/chapter1"]
[Orientation "white"]
[Result "*"]

1. e4 e5 2. Nf3 *`;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeStorage(): Promise<{ directory: string; storage: StudyStorage }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'opening-trainer-storage-'));
  temporaryDirectories.push(directory);
  const storage = new StudyStorage(directory, OWNER);
  await storage.initialize();
  return { directory, storage };
}

describe('StudyStorage cache schema', () => {
  it.each([1, 2])('invalidates a v%i catalog instead of silently reusing it', async (version) => {
    const { directory, storage } = await makeStorage();
    await writeFile(path.join(directory, 'catalog.json'), JSON.stringify({
      version,
      owner: OWNER,
      lastSyncAt: '2026-08-24T00:00:00.000Z',
      studies: [{ id: 'stale-study', name: 'Stale flattened cache' }],
    }));

    await expect(storage.readCatalog()).resolves.toEqual({
      version: CACHE_SCHEMA_VERSION,
      owner: OWNER,
      lastSyncAt: null,
      studies: [],
    });
  });

  it('round-trips a v2 parsed study with its full repertoire graph', async () => {
    const { storage } = await makeStorage();
    const parsed = parseStudyPgn(PGN, {
      studyId: 'study001',
      studyName: 'White repertoire',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });

    await storage.writeStudy('study001', PGN, parsed);
    const cached = await storage.readParsedStudy('study001');

    expect(cached.schemaVersion).toBe(CACHE_SCHEMA_VERSION);
    expect(cached.chapters[0].repertoire).toMatchObject({
      id: 'chapter1',
      rootNodeId: expect.any(String),
      lines: [expect.objectContaining({ uciMoves: ['e2e4', 'e7e5', 'g1f3'] })],
    });
    expect(Object.keys(cached.chapters[0].repertoire.positions).length).toBeGreaterThan(1);
    expect(Object.keys(cached.chapters[0].repertoire.moves).length).toBe(3);
  });

  it('rejects a parsed-study cache without the v2 graph marker', async () => {
    const { directory, storage } = await makeStorage();
    await writeFile(path.join(directory, 'studies', 'study001.json'), JSON.stringify({
      study: { id: 'study001' },
      chapters: [{ id: 'chapter1', lines: [] }],
    }));

    await expect(storage.readParsedStudy('study001')).rejects.toThrow(
      'Parsed study cache is outdated',
    );
  });
});
