import { describe, expect, it } from 'vitest';
import {
  filterChessComGames,
  gameResultForUser,
  normalizeChessComUsername,
  plyLabel,
  timeClassLabel,
} from './chesscom-review-view.js';
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
});
