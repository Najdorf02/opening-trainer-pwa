import type { RepertoireChapter } from '../shared/repertoire.js';

export const CACHE_SCHEMA_VERSION = 3 as const;

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

export interface StoredChapter {
  id: string;
  studyId: string;
  name: string;
  orientation: Orientation;
  cardCount: number;
  lineCount: number;
  sourceUrl?: string;
}

export interface StoredStudy {
  id: string;
  name: string;
  orientation: Orientation;
  updatedAt: string;
  chapters: StoredChapter[];
}

export interface CatalogDocument {
  version: typeof CACHE_SCHEMA_VERSION;
  owner: string;
  lastSyncAt: string | null;
  studies: StoredStudy[];
}

export interface ChapterDetail extends StoredChapter {
  /** Shared move graph used by ChapterTrainer. `lines` remains for older clients. */
  repertoire: RepertoireChapter;
  lines: TrainingLine[];
}

export interface ParsedStudy {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  study: StoredStudy;
  chapters: ChapterDetail[];
}
