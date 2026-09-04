import { describe, expect, it } from 'vitest';

import type { MoveAnnotations, RepertoireMove } from '../shared/repertoire.js';
import type { TrainerEvent, TrainerTransition } from '../shared/trainer.js';
import {
  createRootStudyAnnotationMoment,
  extractStudyAnnotationMoments,
  lichessArrowToBoardArrow,
  lichessSquareToBoardSquare,
  normalizeStudyComments,
} from './study-annotations.js';

const EMPTY_ANNOTATIONS: MoveAnnotations = {
  comments: [],
  nags: [],
  arrows: [],
  squares: [],
};

function makeMove(
  id: string,
  annotations: Partial<MoveAnnotations> = {},
): RepertoireMove {
  return {
    id,
    fromNodeId: `${id}-from`,
    toNodeId: `${id}-to`,
    uci: id === 'user' ? 'g1f3' : 'b8c6',
    san: id === 'user' ? 'Nf3' : 'Nc6',
    order: 0,
    trainingRole: 'train',
    annotations: {
      ...EMPTY_ANNOTATIONS,
      ...annotations,
    },
  };
}

function makeTransition(
  events: TrainerEvent[],
  actualMoveIds: string[],
): TrainerTransition {
  return {
    snapshot: {
      phase: 'initial',
      status: 'awaiting-user',
      chapterId: 'chapter',
      repertoireColor: 'white',
      currentNodeId: 'current',
      fen: 'final snapshot fen',
      actualMoveIds,
      initialRemaining: 1,
      reviewRemaining: 0,
      mistakeLineIds: [],
    },
    events,
  };
}

describe('Lichess study annotation conversion', () => {
  it('converts all supported arrow colors to react-chessboard arrows', () => {
    expect(lichessArrowToBoardArrow('Ge2e4')).toEqual({
      startSquare: 'e2',
      endSquare: 'e4',
      color: '#2f9e44',
    });
    expect(lichessArrowToBoardArrow('Ra8h8')?.color).toBe('#e03131');
    expect(lichessArrowToBoardArrow('Yb1c3')?.color).toBe('#f08c00');
    expect(lichessArrowToBoardArrow('Bd7d5')?.color).toBe('#1971c2');
  });

  it('trims valid codes and ignores malformed or zero-length arrows', () => {
    expect(lichessArrowToBoardArrow(' Ge2e4 ')).toMatchObject({
      startSquare: 'e2',
      endSquare: 'e4',
    });

    for (const code of ['ge2e4', 'Xe2e4', 'Ge9e4', 'Ge2e2', 'Ge2e4x', '']) {
      expect(lichessArrowToBoardArrow(code)).toBeNull();
    }
  });

  it('converts supported square colors and ignores invalid square codes', () => {
    expect(lichessSquareToBoardSquare('Gd4')).toEqual({
      square: 'd4',
      color: 'rgba(47, 158, 68, 0.42)',
    });
    expect(lichessSquareToBoardSquare('Ra1')?.color).toBe(
      'rgba(224, 49, 49, 0.42)',
    );
    expect(lichessSquareToBoardSquare('Yh8')?.color).toBe(
      'rgba(240, 140, 0, 0.42)',
    );
    expect(lichessSquareToBoardSquare('Bc6')?.color).toBe(
      'rgba(25, 113, 194, 0.42)',
    );

    for (const code of ['gd4', 'Xd4', 'Gi4', 'Gd9', 'Gd4d5', '']) {
      expect(lichessSquareToBoardSquare(code)).toBeNull();
    }
  });

  it('normalizes, filters, and deduplicates comments without collapsing content', () => {
    expect(normalizeStudyComments([
      '  Develop the knight.  ',
      '',
      '   ',
      'Develop the knight.',
      'Keep this\nline break',
    ])).toEqual(['Develop the knight.', 'Keep this\nline break']);
  });
});

describe('extractStudyAnnotationMoments', () => {
  it('creates a visible annotation moment for the chapter root', () => {
    expect(createRootStudyAnnotationMoment('root fen', {
      ...EMPTY_ANNOTATIONS,
      comments: ['  Before the first move  '],
      arrows: ['Ge2e4'],
      squares: ['Yd4'],
    })).toEqual({
      fen: 'root fen',
      historyLength: 0,
      comments: ['Before the first move'],
      arrows: [{
        startSquare: 'e2',
        endSquare: 'e4',
        color: '#2f9e44',
      }],
      squares: [{
        square: 'd4',
        color: 'rgba(240, 140, 0, 0.42)',
      }],
    });

    expect(createRootStudyAnnotationMoment('root fen', undefined)).toBeNull();
    expect(createRootStudyAnnotationMoment('root fen', EMPTY_ANNOTATIONS)).toBeNull();
  });

  it('extracts every visible move event in order with its event FEN and route index', () => {
    const userMove = makeMove('user', {
      comments: ['  Main idea  ', '', 'Main idea'],
      arrows: ['Gg1f3', 'Gg1f3', 'invalid'],
      squares: ['Ye5', 'Ye5'],
    });
    const opponentMove = makeMove('opponent', {
      comments: ['Opponent reply'],
      arrows: ['Rb8c6'],
      squares: ['Bc6'],
    });
    const transition = makeTransition([
      {
        type: 'user-move-accepted',
        move: userMove,
        alternative: false,
        firstTry: true,
        fen: 'fen immediately after user move',
      },
      {
        type: 'opponent-move',
        move: opponentMove,
        fen: 'fen immediately after opponent move',
      },
      {
        type: 'awaiting-user',
        target: {
          moveId: 'next',
          uci: 'f1b5',
          san: 'Bb5',
          isScheduled: true,
        },
        acceptedMoves: [],
      },
    ], ['earlier', 'user', 'opponent']);

    expect(extractStudyAnnotationMoments(transition)).toEqual([
      {
        fen: 'fen immediately after user move',
        moveId: 'user',
        uci: 'g1f3',
        san: 'Nf3',
        historyLength: 2,
        comments: ['Main idea'],
        arrows: [{
          startSquare: 'g1',
          endSquare: 'f3',
          color: '#2f9e44',
        }],
        squares: [{
          square: 'e5',
          color: 'rgba(240, 140, 0, 0.42)',
        }],
      },
      {
        fen: 'fen immediately after opponent move',
        moveId: 'opponent',
        uci: 'b8c6',
        san: 'Nc6',
        historyLength: 3,
        comments: ['Opponent reply'],
        arrows: [{
          startSquare: 'b8',
          endSquare: 'c6',
          color: '#e03131',
        }],
        squares: [{
          square: 'c6',
          color: 'rgba(25, 113, 194, 0.42)',
        }],
      },
    ]);
  });

  it('omits moves whose comments and board markings are not visible', () => {
    const annotationOnlyMove = makeMove('user', {
      comments: [' ', ''],
      nags: ['$1'],
      arrows: ['not-an-arrow', 'Ga1a1'],
      squares: ['not-a-square'],
      evaluation: '+0.4',
    });
    const transition = makeTransition([{
      type: 'user-move-accepted',
      move: annotationOnlyMove,
      alternative: false,
      firstTry: true,
      fen: 'event fen',
    }], ['user']);

    expect(extractStudyAnnotationMoments(transition)).toEqual([]);
  });

  it('ignores annotated move events that are not in the resulting route history', () => {
    const transition = makeTransition([{
      type: 'opponent-move',
      move: makeMove('opponent', { comments: ['Detached event'] }),
      fen: 'detached fen',
    }], ['different-move']);

    expect(extractStudyAnnotationMoments(transition)).toEqual([]);
  });
});
