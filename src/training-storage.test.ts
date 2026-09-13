import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameReviewTrainingAggregate } from '../shared/game-review.js';
import type { RepertoireChapter } from '../shared/repertoire.js';
import {
  createTrainingState,
  loadTrainingState,
  mergeReviewPosition,
  parseTrainingState,
  pruneStaleSrsCards,
  saveTrainingCheckpointJournal,
  type SavedTrainingMode,
  type SavedTrainingSession,
} from './training-storage.js';

interface StubRequest<T> {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
}

function stubIndexedDbValue(value: unknown): void {
  const transaction = {
    oncomplete: null as (() => void) | null,
    onabort: null as (() => void) | null,
    onerror: null as (() => void) | null,
    objectStore: () => ({
      get: () => {
        const request: StubRequest<unknown> = {
          result: value,
          error: null,
          onsuccess: null,
          onerror: null,
        };
        queueMicrotask(() => {
          request.onsuccess?.();
          transaction.oncomplete?.();
        });
        return request;
      },
    }),
  };
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore: vi.fn(),
    transaction: () => transaction,
    close: vi.fn(),
  };
  const openRequest: StubRequest<typeof database> = {
    result: database,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
  };
  vi.stubGlobal('indexedDB', {
    open: () => {
      queueMicrotask(() => openRequest.onsuccess?.());
      return openRequest;
    },
  } as unknown as IDBFactory);
}

function stubLocalStorage(): { values: Map<string, string>; storage: Storage } {
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    clear: vi.fn(() => { values.clear(); }),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    get length() { return values.size; },
  } as Storage;
  vi.stubGlobal('window', { localStorage: storage });
  return { values, storage };
}

function savedSession(mode: SavedTrainingMode, selectedCardIds?: string[]): SavedTrainingSession {
  return {
    studyId: 'study',
    chapterId: 'chapter',
    chapterName: 'Open Game',
    orientation: 'white',
    sample: false,
    mode,
    selectedLineIds: ['line'],
    ...(selectedCardIds ? { selectedCardIds } : {}),
    savedAt: 123,
    checkpoint: {
      version: 1,
      savedAt: 123,
      chapterId: 'chapter',
      chapterRevision: 'revision',
      state: {
        phase: 'initial',
        status: 'awaiting-user',
        currentNodeId: 'root',
        scheduledLineId: 'line',
        routeLineId: 'line',
        actualMoveIds: [],
        pendingInitialLineIds: [],
        dirtyLineOrder: [],
        reviewQueue: [],
        trialHadError: false,
        trialHadAlternative: false,
        promptHadError: false,
        promptElapsedMs: 0,
        attempts: [],
        grades: [],
      },
    },
    ui: {
      annotationMoments: [],
      wrongCount: 0,
      correctCount: 0,
    },
  };
}

function position(gameId: string, count = 1): GameReviewTrainingAggregate {
  return {
    source: 'chesscom-review',
    positionKey: 'key',
    fen: 'fen',
    userColor: 'white',
    correctMoves: [{
      moveId: 'move',
      cardId: 'card',
      uci: 'e2e4',
      san: 'e4',
      annotations: { comments: [], nags: [], arrows: [], squares: [] },
      chapters: [{ studyId: 'study', chapterId: 'chapter', chapterName: 'Open Game', repertoireColor: 'white' }],
    }],
    matchingChapters: [{ studyId: 'study', chapterId: 'chapter', chapterName: 'Open Game', repertoireColor: 'white' }],
    occurrences: Array.from({ length: count }, (_, index) => ({
      gameId: index ? `${gameId}-${index}` : gameId,
      playedAt: `2026-09-${String(index + 1).padStart(2, '0')}`,
      playedMove: { uci: 'd2d4', san: 'd4' },
      reason: 'move-not-covered' as const,
    })),
    occurrenceCount: count,
  };
}

function repertoireChapter(studyId: string, chapterId: string, cardId: string): RepertoireChapter {
  return {
    id: chapterId,
    studyId,
    name: chapterId,
    repertoireColor: 'white',
    orientationSource: 'pgn',
    variant: 'standard',
    rootFen: 'fen',
    rootNodeId: 'root',
    positions: {
      root: { id: 'root', path: [], fen: 'fen', positionKey: 'key', turn: 'w', outgoingMoveIds: ['move'] },
    },
    moves: {
      move: {
        id: 'move',
        fromNodeId: 'root',
        toNodeId: 'next',
        uci: 'e2e4',
        san: 'e4',
        order: 0,
        trainingRole: 'train',
        cardId,
        annotations: { comments: [], nags: [], arrows: [], squares: [] },
      },
    },
    lines: [{ id: 'line', moveIds: ['move'], uciMoves: ['e2e4'], userCardIds: [cardId], order: 0 }],
    tags: {},
  };
}

describe('training storage documents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts fresh when a document version is unsupported', () => {
    expect(parseTrainingState({ version: 99 }, 123)).toEqual(createTrainingState(123));
  });

  it('keeps valid SRS data while dropping a malformed optional session', () => {
    const state = createTrainingState(123);
    const parsed = parseTrainingState({ ...state, activeSession: { chapterId: 'broken' } }, 456);
    expect(parsed.srs).toEqual(state.srs);
    expect(parsed.activeSession).toBeUndefined();
  });

  it('drops a today-review session without its exact card selection', () => {
    const state = createTrainingState(123);
    const missingCards = parseTrainingState({ ...state, activeSession: savedSession('today-review') }, 456);
    const emptyCards = parseTrainingState({ ...state, activeSession: savedSession('today-review', []) }, 456);
    const valid = parseTrainingState({ ...state, activeSession: savedSession('today-review', ['card']) }, 456);

    expect(missingCards.activeSession).toBeUndefined();
    expect(emptyCards.activeSession).toBeUndefined();
    expect(valid.activeSession?.selectedCardIds).toEqual(['card']);
  });

  it('loads localStorage when IndexedDB is available but has no document', async () => {
    const fallback = createTrainingState(321);
    stubIndexedDbValue(undefined);
    vi.stubGlobal('window', {
      localStorage: { getItem: () => JSON.stringify(fallback) },
    });

    await expect(loadTrainingState(999)).resolves.toEqual(fallback);
  });

  it('chooses the newest valid copy across IndexedDB and localStorage', async () => {
    const indexed = createTrainingState(100);
    const fallback = createTrainingState(200);
    stubIndexedDbValue(indexed);
    vi.stubGlobal('window', {
      localStorage: { getItem: () => JSON.stringify(fallback) },
    });

    await expect(loadTrainingState(999)).resolves.toEqual(fallback);
  });

  it('writes a compact training checkpoint synchronously', () => {
    const { values, storage } = stubLocalStorage();
    const state = createTrainingState(200);
    state.activeSession = { ...savedSession('chapter'), savedAt: 200 };
    state.reviewQueue.key = position('game-1');

    expect(saveTrainingCheckpointJournal(state)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const payload = JSON.parse([...values.values()][0]) as Record<string, unknown>;
    expect(payload).toMatchObject({ version: 1, updatedAt: 200 });
    expect(payload.activeSession).toBeTruthy();
    expect(payload.srs).toEqual(state.srs);
    expect(payload.reviewQueue).toBeUndefined();
  });

  it('restores a checkpoint newer than the completed IndexedDB transaction', async () => {
    const indexed = createTrainingState(100);
    indexed.activeSession = savedSession('chapter');
    const checkpoint = createTrainingState(200);
    checkpoint.activeSession = { ...savedSession('chapter'), savedAt: 200 };
    stubLocalStorage();
    expect(saveTrainingCheckpointJournal(checkpoint)).toBe(true);
    stubIndexedDbValue(indexed);

    const loaded = await loadTrainingState(999);

    expect(loaded.updatedAt).toBe(200);
    expect(loaded.activeSession?.savedAt).toBe(200);
    expect(loaded.srs.updatedAt).toBe(200);
  });

  it('does not let an older queued save roll back a newer synchronous checkpoint', async () => {
    const older = createTrainingState(100);
    older.activeSession = { ...savedSession('chapter'), savedAt: 100 };
    const newer = createTrainingState(200);
    newer.activeSession = { ...savedSession('chapter'), savedAt: 200 };
    stubLocalStorage();

    expect(saveTrainingCheckpointJournal(newer)).toBe(true);
    // This is the ordering produced when an earlier full-state save begins
    // after the following UI commit has already journaled synchronously.
    expect(saveTrainingCheckpointJournal(older)).toBe(true);
    stubIndexedDbValue(older);

    const loaded = await loadTrainingState(999);

    expect(loaded.updatedAt).toBe(200);
    expect(loaded.activeSession?.savedAt).toBe(200);
    expect(loaded.srs.updatedAt).toBe(200);
  });

  it('restores the first checkpoint even when the synthetic fresh state has a later timestamp', async () => {
    const checkpoint = createTrainingState(200);
    checkpoint.activeSession = { ...savedSession('chapter'), savedAt: 200 };
    stubLocalStorage();
    expect(saveTrainingCheckpointJournal(checkpoint)).toBe(true);
    stubIndexedDbValue(undefined);

    const loaded = await loadTrainingState(999);

    expect(loaded.updatedAt).toBe(200);
    expect(loaded.activeSession?.savedAt).toBe(200);
  });

  it('uses a newer checkpoint tombstone to clear a session and retain its SRS update', async () => {
    const indexed = createTrainingState(100);
    indexed.activeSession = savedSession('chapter');
    const completed = createTrainingState(300);
    stubLocalStorage();
    expect(saveTrainingCheckpointJournal(completed)).toBe(true);
    stubIndexedDbValue(indexed);

    const loaded = await loadTrainingState(999);

    expect(loaded.activeSession).toBeUndefined();
    expect(loaded.srs.updatedAt).toBe(300);
  });

  it('keeps IndexedDB available when the synchronous journal is blocked', () => {
    vi.stubGlobal('window', {
      localStorage: { setItem: () => { throw new DOMException('blocked'); } },
    });

    expect(() => saveTrainingCheckpointJournal(createTrainingState(100))).not.toThrow();
    expect(saveTrainingCheckpointJournal(createTrainingState(100))).toBe(false);
  });

  it('merges repeated Chess.com deviations without duplicating one game', () => {
    const first = position('game-1');
    const repeated = position('game-1');
    const third = position('game-2');
    const merged = mergeReviewPosition(mergeReviewPosition(first, repeated), third);
    expect(merged.occurrenceCount).toBe(2);
    expect(merged.occurrences.map((item) => item.gameId).sort()).toEqual(['game-1', 'game-2']);
    expect(first.occurrenceCount).toBe(1);
  });

  it('keeps a merged move card attached to its leading chapter context', () => {
    const first = position('game-1');
    first.correctMoves[0].moveId = 'old-move';
    first.correctMoves[0].cardId = 'old-card';
    first.correctMoves[0].chapters[0] = {
      studyId: 'old-study', chapterId: 'old-chapter', chapterName: 'Old', repertoireColor: 'white',
    };
    const refreshed = position('game-2');
    refreshed.correctMoves[0].moveId = 'new-move';
    refreshed.correctMoves[0].cardId = 'new-card';
    refreshed.correctMoves[0].chapters[0] = {
      studyId: 'new-study', chapterId: 'new-chapter', chapterName: 'New', repertoireColor: 'white',
    };

    const merged = mergeReviewPosition(first, refreshed);

    expect(merged.correctMoves[0]).toMatchObject({ moveId: 'new-move', cardId: 'new-card' });
    expect(merged.correctMoves[0].chapters.map((chapter) => chapter.chapterId)).toEqual(['new-chapter', 'old-chapter']);
  });

  it('does not detach an existing card when a duplicate move has no card', () => {
    const trainable = position('game-1');
    const contextual = position('game-2');
    contextual.correctMoves[0].moveId = 'context-only-move';
    contextual.correctMoves[0].cardId = undefined;
    contextual.correctMoves[0].chapters[0] = {
      studyId: 'other-study', chapterId: 'other-chapter', chapterName: 'Other', repertoireColor: 'white',
    };

    const merged = mergeReviewPosition(trainable, contextual);

    expect(merged.correctMoves[0]).toMatchObject({ moveId: 'move', cardId: 'card' });
    expect(merged.correctMoves[0].chapters.map((chapter) => chapter.chapterId)).toEqual(['chapter', 'other-chapter']);
  });

  it('prunes stale current and future cards only in chapters that were loaded', () => {
    const state = createTrainingState(100);
    const record = (cardId: string, studyId: string, chapterId: string, dueAt: number) => ({
      cardId,
      studyId,
      chapterId,
      firstReviewedAt: 10,
      lastReviewedAt: 20,
      dueAt,
      intervalDays: 1,
      reviewCount: 1,
      successCount: 1,
      lapseCount: 0,
      consecutiveGood: 1,
      mastery: 20,
      totalResponseMs: 100,
      lastGrade: 'good' as const,
    });
    state.srs.cards = {
      current: record('current', 'study', 'chapter', 50),
      future: record('future', 'study', 'chapter', 5_000),
      valid: record('valid', 'study', 'chapter', 5_000),
      unseen: record('unseen', 'other-study', 'other-chapter', 50),
    };

    const pruned = pruneStaleSrsCards(state.srs, [repertoireChapter('study', 'chapter', 'valid')], 200);

    expect(Object.keys(pruned.cards).sort()).toEqual(['unseen', 'valid']);
    expect(pruned.updatedAt).toBe(200);
  });
});
