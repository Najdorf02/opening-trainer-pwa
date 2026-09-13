import { describe, expect, it } from 'vitest';

import type { RepertoireChapter } from '../shared/repertoire.js';
import { chapterForCardReview, chapterForLineIds } from '../src/training-chapter.js';
import type { ChapterDetail } from '../src/types.js';

function chapter(): ChapterDetail {
  const repertoire = {
    id: 'chapter-1',
    studyId: 'study-1',
    name: 'Review chapter',
    repertoireColor: 'white',
    orientationSource: 'pgn',
    variant: 'standard',
    rootFen: 'root',
    rootNodeId: 'root',
    positions: {},
    moves: {
      a: { id: 'a', fromNodeId: 'root', toNodeId: 'after-a', uci: 'e2e4', san: 'e4', order: 0, trainingRole: 'train', cardId: 'card-a', annotations: { comments: [], nags: [], arrows: [], squares: [] } },
      b: { id: 'b', fromNodeId: 'root', toNodeId: 'after-b', uci: 'd2d4', san: 'd4', order: 1, trainingRole: 'train', cardId: 'card-b', annotations: { comments: [], nags: [], arrows: [], squares: [] } },
      c: { id: 'c', fromNodeId: 'after-a', toNodeId: 'after-c', uci: 'c7c5', san: 'c5', order: 2, trainingRole: 'train', cardId: 'card-c', annotations: { comments: [], nags: [], arrows: [], squares: [] } },
    },
    tags: {},
    lines: [
      { id: 'line-a', moveIds: ['a'], uciMoves: ['e2e4'], userCardIds: ['card-a'], order: 0 },
      { id: 'line-b', moveIds: ['b'], uciMoves: ['d2d4'], userCardIds: ['card-b'], order: 1 },
      { id: 'line-c', moveIds: ['a', 'c'], uciMoves: ['e2e4', 'c7c5'], userCardIds: ['card-a', 'card-c'], order: 2 },
    ],
  } satisfies RepertoireChapter;
  return {
    id: repertoire.id,
    studyId: repertoire.studyId,
    name: repertoire.name,
    orientation: 'white',
    cardCount: 3,
    lineCount: 3,
    repertoire,
    lines: repertoire.lines.map((line) => ({
      id: line.id,
      moves: [],
    })),
  };
}

describe('chapterForCardReview', () => {
  it('keeps only routes containing a requested due card', () => {
    const source = chapter();
    const review = chapterForCardReview(source, ['card-a']);

    expect(review?.repertoire.lines.map((line) => line.id)).toEqual(['line-a', 'line-c']);
    expect(review?.lines.map((line) => line.id)).toEqual(['line-a', 'line-c']);
    expect(review?.cardCount).toBe(1);
    expect(review?.repertoire.lines[1]?.userCardIds).toEqual(['card-a']);
    expect(review?.repertoire.moves.a?.cardId).toBe('card-a');
    expect(review?.repertoire.moves.c?.cardId).toBeUndefined();
    expect(source.repertoire.moves.c?.cardId).toBe('card-c');
    expect(source.repertoire.lines).toHaveLength(3);
  });

  it('returns undefined when the stored cards no longer exist', () => {
    expect(chapterForCardReview(chapter(), ['stale-card'])).toBeUndefined();
  });

  it('rejects a mixed request instead of silently skipping stale cards', () => {
    expect(chapterForCardReview(chapter(), ['card-a', 'stale-card'])).toBeUndefined();
  });
});

describe('chapterForLineIds', () => {
  it('restores the exact selected routes in source order', () => {
    const source = chapter();
    const selected = chapterForLineIds(source, ['line-b']);
    expect(selected?.repertoire.lines.map((line) => line.id)).toEqual(['line-b']);
    expect(selected?.lines.map((line) => line.id)).toEqual(['line-b']);
  });

  it('rejects a stale route set', () => {
    expect(chapterForLineIds(chapter(), ['line-missing'])).toBeUndefined();
  });
});
