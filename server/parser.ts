import { importLichessStudyPgn } from '../shared/pgn.js';
import type {
  RepertoireChapter,
  RepertoireMove,
  RepertoireStudy,
} from '../shared/repertoire.js';
import type {
  ChapterDetail,
  MoveSpec,
  ParsedStudy,
  StoredChapter,
  TrainingLine,
} from './types';
import { CACHE_SCHEMA_VERSION as CURRENT_CACHE_SCHEMA_VERSION } from './types';

interface ParserContext {
  studyId: string;
  studyName: string;
  updatedAt: string;
}

/** Convert the shared repertoire graph into the compact HTTP/storage contract. */
export function parseStudyPgn(pgn: string, context: ParserContext): ParsedStudy {
  const imported = importLichessStudyPgn(pgn, {
    studyId: context.studyId,
    studyName: context.studyName,
  });
  return normalizeStudy(imported, context);
}

function normalizeStudy(imported: RepertoireStudy, context: ParserContext): ParsedStudy {
  if (imported.chapters.length === 0) throw new Error('The study contains no importable chapters.');
  const chapters = imported.chapters.map(toChapterDetail);
  const orientations = new Set(chapters.map((chapter) => chapter.orientation));
  if (orientations.size !== 1) {
    throw new Error('A study must contain exactly one repertoire orientation.');
  }
  return {
    schemaVersion: CURRENT_CACHE_SCHEMA_VERSION,
    study: {
      id: context.studyId,
      name: context.studyName,
      orientation: chapters[0].orientation,
      updatedAt: context.updatedAt,
      chapters: chapters.map(withoutLines),
    },
    chapters,
  };
}

function toChapterDetail(chapter: RepertoireChapter): ChapterDetail {
  const lines = [...chapter.lines]
    .sort((left, right) => left.order - right.order)
    .map((line): TrainingLine => ({
      id: line.id,
      initialFen: chapter.rootFen,
      moves: line.moveIds.map((moveId) => toMoveSpec(chapter.moves[moveId], chapter.id)),
    }));
  const cardIds = new Set(
    Object.values(chapter.moves)
      .map((move) => move.cardId)
      .filter((cardId): cardId is string => typeof cardId === 'string'),
  );
  return {
    id: chapter.id,
    studyId: chapter.studyId,
    name: chapter.name,
    orientation: chapter.repertoireColor,
    cardCount: cardIds.size,
    lineCount: lines.length,
    ...(chapter.sourceUrl ? { sourceUrl: chapter.sourceUrl } : {}),
    repertoire: chapter,
    lines,
  };
}

function toMoveSpec(move: RepertoireMove | undefined, chapterId: string): MoveSpec {
  if (!move || !/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(move.uci)) {
    throw new Error(`Chapter ${chapterId} contains an invalid move reference.`);
  }
  const promotion = move.uci[4] as MoveSpec['promotion'] | undefined;
  return {
    from: move.uci.slice(0, 2),
    to: move.uci.slice(2, 4),
    san: move.san,
    ...(promotion ? { promotion } : {}),
  };
}

function withoutLines(chapter: ChapterDetail): StoredChapter {
  const { lines: _lines, repertoire: _repertoire, ...summary } = chapter;
  return summary;
}
