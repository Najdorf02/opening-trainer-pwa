import { describe, expect, it } from 'vitest';
import { ChapterTrainer } from '../shared/trainer.js';
import { parseStudyPgn } from './parser.js';
import { CACHE_SCHEMA_VERSION } from './types.js';

const BRANCHED_PGN = `[Event "Parser fixture"]
[Site "https://lichess.org/study/study001/chapter1"]
[StudyName "White repertoire"]
[ChapterName "King pawn"]
[ChapterURL "https://lichess.org/study/study001/chapter1"]
[Orientation "white"]
[Result "*"]

1. e4 e5 2. Nf3 (2. Bc4) *`;

describe('server PGN adapter', () => {
  it('maps the shared repertoire graph to the stable chapter contract', () => {
    const parsed = parseStudyPgn(BRANCHED_PGN, {
      studyId: 'study001',
      studyName: 'White repertoire',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });

    expect(parsed.study).toMatchObject({
      id: 'study001',
      name: 'White repertoire',
      orientation: 'white',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });
    expect(parsed.schemaVersion).toBe(CACHE_SCHEMA_VERSION);
    expect(parsed.study.chapters).toEqual([
      expect.objectContaining({
        id: 'chapter1',
        name: 'King pawn',
        orientation: 'white',
        sourceUrl: 'https://lichess.org/study/study001/chapter1',
        cardCount: 3,
        lineCount: 2,
      }),
    ]);

    const chapter = parsed.chapters[0];
    expect(chapter.repertoire.lines.map((line) => line.uciMoves)).toEqual([
      ['e2e4', 'e7e5', 'g1f3'],
      ['e2e4', 'e7e5', 'f1c4'],
    ]);
    expect(chapter.lines.map((line) => line.moves.map((move) => move.san))).toEqual([
      ['e4', 'e5', 'Nf3'],
      ['e4', 'e5', 'Bc4'],
    ]);
    expect(chapter.lines[0].moves[0]).toEqual({ from: 'e2', to: 'e4', san: 'e4' });
    expect(chapter.lines[0].initialFen).toContain(' w ');
  });

  it('feeds the parsed shared graph through correction, retry, and clean mistake review', () => {
    const chapter = parseStudyPgn(BRANCHED_PGN, {
      studyId: 'study001',
      studyName: 'White repertoire',
      updatedAt: '2026-08-25T00:00:00.000Z',
    }).chapters[0].repertoire;
    const trainer = new ChapterTrainer(chapter);
    const initial = trainer.start(100);
    const rootFen = initial.snapshot.fen;

    const correction = trainer.submitUserMove('d2d4', 110);
    expect(correction.snapshot).toMatchObject({
      status: 'showing-correction',
      fen: rootFen,
      correction: { correctMove: { uci: 'e2e4' } },
    });
    const retry = trainer.acknowledgeCorrection(120);
    expect(retry.snapshot).toMatchObject({
      status: 'awaiting-user',
      fen: rootFen,
      prompt: { retry: true, target: { uci: 'e2e4' } },
    });

    let transition = retry;
    let sawMistakeReview = false;
    let guard = 0;
    while (transition.snapshot.status !== 'complete' && guard++ < 30) {
      if (transition.snapshot.phase === 'mistake-review') sawMistakeReview = true;
      if (transition.snapshot.status === 'awaiting-user') {
        transition = trainer.submitUserMove(transition.snapshot.prompt!.target.uci, 130 + guard);
      } else if (transition.snapshot.status === 'line-complete') {
        transition = trainer.continue(130 + guard);
      } else {
        throw new Error(`Unexpected trainer status ${transition.snapshot.status}`);
      }
    }

    expect(guard).toBeLessThan(30);
    expect(sawMistakeReview).toBe(true);
    expect(transition.snapshot).toMatchObject({ phase: 'complete', status: 'complete' });
  });

  it('rejects a study that mixes white and black repertoire chapters', () => {
    const mixed = `${BRANCHED_PGN}\n\n${BRANCHED_PGN
      .replaceAll('chapter1', 'chapter2')
      .replace('[Orientation "white"]', '[Orientation "black"]')}`;

    expect(() => parseStudyPgn(mixed, {
      studyId: 'study001',
      studyName: 'Mixed repertoire',
      updatedAt: '2026-08-25T00:00:00.000Z',
    })).toThrow('exactly one repertoire orientation');
  });
});
