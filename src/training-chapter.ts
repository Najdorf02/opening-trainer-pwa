import type { RepertoireChapter } from '../shared/repertoire.js';
import type { ChapterDetail } from './types.js';

export function chapterForLineIds(
  chapter: ChapterDetail,
  requestedLineIds: Iterable<string>,
): ChapterDetail | undefined {
  const lineIds = new Set(requestedLineIds);
  if (lineIds.size === 0) return undefined;

  const selectedLines = chapter.repertoire.lines.filter((line) => lineIds.has(line.id));
  if (selectedLines.length !== lineIds.size) return undefined;
  const selectedCards = new Set(selectedLines.flatMap((line) => line.userCardIds));
  const repertoire: RepertoireChapter = { ...chapter.repertoire, lines: selectedLines };
  return {
    ...chapter,
    repertoire,
    lines: chapter.lines.filter((line) => lineIds.has(line.id)),
    lineCount: selectedLines.length,
    cardCount: selectedCards.size,
  };
}

/**
 * Build a temporary chapter containing only routes that exercise at least one
 * requested card. The source repertoire is never mutated, so a due-card drill
 * cannot leak back into the synchronized Lichess cache.
 */
export function chapterForCardReview(
  chapter: ChapterDetail,
  requestedCardIds: Iterable<string>,
): ChapterDetail | undefined {
  const cardIds = new Set(requestedCardIds);
  if (cardIds.size === 0) return undefined;

  const selectedLines = chapter.repertoire.lines.filter((line) =>
    line.userCardIds.some((cardId) => cardIds.has(cardId)),
  );
  if (selectedLines.length === 0) return undefined;

  const selectedLineIds = new Set(selectedLines.map((line) => line.id));
  const visibleLines = chapter.lines.filter((line) => selectedLineIds.has(line.id));
  const selectedCards = new Set(
    selectedLines.flatMap((line) => line.userCardIds.filter((cardId) => cardIds.has(cardId))),
  );
  // A mixed valid/stale request must not silently complete only the surviving
  // cards. Callers can then prune obsolete SRS records explicitly.
  if (selectedCards.size !== cardIds.size) return undefined;
  const moves = Object.fromEntries(
    Object.entries(chapter.repertoire.moves).map(([moveId, move]) => {
      if (!move.cardId || cardIds.has(move.cardId)) return [moveId, move];
      const { cardId: _ignoredCardId, ...contextMove } = move;
      return [moveId, contextMove];
    }),
  );
  const repertoire: RepertoireChapter = {
    ...chapter.repertoire,
    moves,
    lines: selectedLines.map((line) => ({
      ...line,
      userCardIds: line.userCardIds.filter((cardId) => cardIds.has(cardId)),
    })),
  };

  return {
    ...chapter,
    repertoire,
    lines: visibleLines,
    lineCount: selectedLines.length,
    cardCount: selectedCards.size,
  };
}
