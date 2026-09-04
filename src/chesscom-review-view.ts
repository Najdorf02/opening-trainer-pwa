import type { ChessComGame } from './types.js';

export const CHESSCOM_TIME_CLASSES = ['bullet', 'blitz', 'rapid', 'daily'] as const;
export type ChessComTimeClass = typeof CHESSCOM_TIME_CLASSES[number];

const DRAW_RESULTS = new Set([
  'agreed',
  'repetition',
  'stalemate',
  'insufficient',
  '50move',
  'timevsinsufficient',
]);

export function normalizeChessComUsername(value: string): string {
  return value.trim().replace(/^@/, '');
}

export function timeClassLabel(value: string): string {
  switch (value.toLowerCase()) {
    case 'bullet': return '불릿';
    case 'blitz': return '블리츠';
    case 'rapid': return '래피드';
    case 'daily': return '데일리';
    default: return value || '기타';
  }
}

export function gameResultForUser(
  game: Pick<ChessComGame, 'white' | 'black'>,
  username: string,
): 'win' | 'draw' | 'loss' {
  const normalized = username.toLowerCase();
  const player = game.white.username.toLowerCase() === normalized ? game.white : game.black;
  if (player.result === 'win') return 'win';
  if (DRAW_RESULTS.has(player.result.toLowerCase())) return 'draw';
  return 'loss';
}

export function resultLabel(result: 'win' | 'draw' | 'loss'): string {
  if (result === 'win') return '승';
  if (result === 'draw') return '무';
  return '패';
}

export function filterChessComGames(
  games: ChessComGame[],
  selected: ReadonlySet<ChessComTimeClass>,
): ChessComGame[] {
  return games.filter((game) => selected.has(game.timeClass.toLowerCase() as ChessComTimeClass));
}

export function plyLabel(ply: number): string {
  const move = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${move}.` : `${move}...`;
}

export function formatGameDate(endTime: number): string {
  return new Date(endTime * 1000).toLocaleDateString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
