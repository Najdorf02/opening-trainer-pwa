import type { RepertoireChapter } from '../shared/repertoire.js';

export type Orientation = 'white' | 'black';

export interface MoveSpec {
  from: string;
  to: string;
  san: string;
  promotion?: 'q' | 'r' | 'b' | 'n';
}

export interface TrainingLine {
  id: string;
  name?: string;
  initialFen?: string;
  moves: MoveSpec[];
}

export interface ChapterSummary {
  id: string;
  studyId: string;
  name: string;
  orientation: Orientation;
  cardCount: number;
  lineCount: number;
  sourceUrl?: string;
  lines?: TrainingLine[];
}

export interface StudySummary {
  id: string;
  name: string;
  orientation?: Orientation;
  updatedAt?: string;
  chapters: ChapterSummary[];
}

export interface LibraryPayload {
  studies: StudySummary[];
  sample: boolean;
}

export interface AuthStatus {
  connected: boolean;
  username?: string;
  expiresAt?: string;
}

export interface SyncResult {
  imported: number;
  skipped: number;
  failed: number;
  lastSyncAt: string;
  errors: Array<{ studyId: string; studyName: string; message: string }>;
}

export interface ChapterDetail extends ChapterSummary {
  repertoire: RepertoireChapter;
  lines: TrainingLine[];
}

export interface OpeningGameResults {
  whiteWins: number;
  draws: number;
  blackWins: number;
}

export interface OpeningExplorerMove {
  uci: string;
  san: string;
  results: OpeningGameResults;
  averageRating?: number;
}

export interface OpeningExplorerPayload {
  fen: string;
  results: OpeningGameResults;
  moves: OpeningExplorerMove[];
  opening?: { eco: string; name: string };
}

export type EvaluationScore =
  | { type: 'cp'; value: number }
  | { type: 'mate'; value: number };

export interface OpeningEvaluationMove {
  uci: string;
  san?: string;
  score: EvaluationScore;
  /** Principal variation from this candidate, when supplied by the local engine. */
  pv?: string[];
}

export type OpeningMoveEvaluation =
  | {
      status: 'graded';
      verdict: 'pass' | 'fail';
      passed: boolean;
      reason: 'engine-within-threshold' | 'engine-loss-too-large' | 'engine-forced-mate-lost';
      move: { uci: string; san: string; pv?: string[] };
      centipawnLoss: number;
      thresholdCp: number;
      depth: number;
      before: { depth: number; score: EvaluationScore };
      after: { depth: number; score: EvaluationScore };
      bestMoves: OpeningEvaluationMove[];
    }
  | {
      status: 'unavailable';
      reason:
        | 'position_not_cached'
        | 'child_not_cached'
        | 'insufficient_depth'
        | 'upstream_unavailable';
      move: { uci: string; san: string };
    };

export interface OpeningExplorerFilters {
  speeds: Array<'bullet' | 'blitz' | 'rapid' | 'classical'>;
  ratings: Array<1600 | 1800 | 2000 | 2200 | 2500>;
  moves?: number;
}

export interface ChessComPlayer {
  username: string;
  rating?: number;
  result: string;
}

export interface ChessComGame {
  id: string;
  url: string;
  pgn: string;
  endTime: number;
  timeClass: string;
  timeControl: string;
  rated: boolean;
  rules: string;
  white: ChessComPlayer;
  black: ChessComPlayer;
}

export interface ChessComGamesPayload {
  username: string;
  fetchedAt: string;
  archivesChecked: number;
  games: ChessComGame[];
}
