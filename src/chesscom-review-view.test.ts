import { describe, expect, it } from 'vitest';
import { DEFAULT_POSITION } from 'chess.js';
import {
  filterChessComGames,
  gameResultForUser,
  gradeReviewTrainingMove,
  normalizeChessComUsername,
  plyLabel,
  timeClassLabel,
} from './chesscom-review-view.js';
import type { RepertoireReviewMoveCandidate } from '../shared/game-review.js';
import type { ChessComGame } from './types.js';

function game(overrides: Partial<ChessComGame> = {}): ChessComGame {
  return {
    id: 'g1',
    url: 'https://www.chess.com/game/live/1',
    pgn: '',
    endTime: 1,
    timeClass: 'rapid',
    timeControl: '600',
    rated: true,
    rules: 'chess',
    white: { username: 'Yshaarrj', result: 'win' },
    black: { username: 'Opponent', result: 'resigned' },
    ...overrides,
  };
}

describe('Chess.com review view helpers', () => {
  it('normalizes an optional account prefix and whitespace', () => {
    expect(normalizeChessComUsername('  @Yshaarrj ')).toBe('Yshaarrj');
  });

  it('finds the user without case sensitivity and maps draw reasons', () => {
    expect(gameResultForUser(game(), 'ySHAARRJ')).toBe('win');
    expect(gameResultForUser(game({
      white: { username: 'Opponent', result: 'agreed' },
      black: { username: 'Yshaarrj', result: 'repetition' },
    }), 'Yshaarrj')).toBe('draw');
  });

  it('filters supported time classes and formats move sides', () => {
    const games = [game(), game({ id: 'g2', timeClass: 'blitz' })];
    expect(filterChessComGames(games, new Set(['rapid']))).toHaveLength(1);
    expect(timeClassLabel('rapid')).toBe('래피드');
    expect(plyLabel(9)).toBe('5.');
    expect(plyLabel(10)).toBe('5...');
  });

  it('grades every registered repertoire response and requires a legal move', () => {
    const candidate = (
      uci: string,
      san: string,
      cardId: string,
    ): RepertoireReviewMoveCandidate => ({
      moveId: `move:${uci}`,
      cardId,
      uci,
      san,
      annotations: { comments: [], nags: [], arrows: [], squares: [] },
      chapters: [],
    });
    const correctMoves = [
      candidate('e2e4', 'e4', 'card:e4'),
      candidate('g1f3', 'Nf3', 'card:nf3'),
    ];

    expect(gradeReviewTrainingMove(DEFAULT_POSITION, correctMoves, 'e2', 'e4')).toMatchObject({
      status: 'correct',
      uci: 'e2e4',
      candidate: { cardId: 'card:e4' },
    });
    expect(gradeReviewTrainingMove(DEFAULT_POSITION, correctMoves, 'g1', 'f3')).toMatchObject({
      status: 'correct',
      uci: 'g1f3',
      candidate: { cardId: 'card:nf3' },
    });
    expect(gradeReviewTrainingMove(DEFAULT_POSITION, correctMoves, 'd2', 'd4')).toMatchObject({
      status: 'incorrect',
      uci: 'd2d4',
    });
    expect(gradeReviewTrainingMove(DEFAULT_POSITION, correctMoves, 'e2', 'e5')).toEqual({
      status: 'illegal',
    });
  });
});
