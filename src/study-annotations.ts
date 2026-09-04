import type { Arrow } from 'react-chessboard';

import type { MoveAnnotations } from '../shared/repertoire.js';
import type { TrainerEvent, TrainerTransition } from '../shared/trainer.js';

const LICHESS_ARROW_COLORS = {
  G: '#2f9e44',
  R: '#e03131',
  Y: '#f08c00',
  B: '#1971c2',
} as const;

const LICHESS_SQUARE_COLORS = {
  G: 'rgba(47, 158, 68, 0.42)',
  R: 'rgba(224, 49, 49, 0.42)',
  Y: 'rgba(240, 140, 0, 0.42)',
  B: 'rgba(25, 113, 194, 0.42)',
} as const;

type LichessAnnotationColor = keyof typeof LICHESS_ARROW_COLORS;
type MoveEvent = Extract<
  TrainerEvent,
  { type: 'user-move-accepted' | 'opponent-move' }
>;

export interface StudySquareAnnotation {
  square: string;
  color: string;
}

export interface StudyAnnotationMoment {
  fen: string;
  moveId?: string;
  uci?: string;
  san?: string;
  historyLength: number;
  comments: string[];
  arrows: Arrow[];
  squares: StudySquareAnnotation[];
}

export function createRootStudyAnnotationMoment(
  fen: string,
  annotations: MoveAnnotations | undefined,
): StudyAnnotationMoment | null {
  if (!annotations) return null;

  const visible = visibleAnnotations(annotations);
  if (
    visible.comments.length === 0 &&
    visible.arrows.length === 0 &&
    visible.squares.length === 0
  ) {
    return null;
  }

  return {
    fen,
    historyLength: 0,
    ...visible,
  };
}

function uniqueBy<T>(values: T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeStudyComments(comments: string[]): string[] {
  return [...new Set(comments.map((comment) => comment.trim()).filter(Boolean))];
}

export function lichessArrowToBoardArrow(code: string): Arrow | null {
  const match = /^([GRYB])([a-h][1-8])([a-h][1-8])$/.exec(code.trim());
  if (!match || match[2] === match[3]) return null;

  return {
    startSquare: match[2],
    endSquare: match[3],
    color: LICHESS_ARROW_COLORS[match[1] as LichessAnnotationColor],
  };
}

export function lichessSquareToBoardSquare(
  code: string,
): StudySquareAnnotation | null {
  const match = /^([GRYB])([a-h][1-8])$/.exec(code.trim());
  if (!match) return null;

  return {
    square: match[2],
    color: LICHESS_SQUARE_COLORS[match[1] as LichessAnnotationColor],
  };
}

function visibleAnnotations(annotations: MoveAnnotations): Pick<
  StudyAnnotationMoment,
  'comments' | 'arrows' | 'squares'
> {
  const comments = normalizeStudyComments(annotations.comments);
  const arrows = uniqueBy(
    annotations.arrows
      .map(lichessArrowToBoardArrow)
      .filter((arrow): arrow is Arrow => arrow !== null),
    (arrow) => `${arrow.color}:${arrow.startSquare}:${arrow.endSquare}`,
  );
  const squares = uniqueBy(
    annotations.squares
      .map(lichessSquareToBoardSquare)
      .filter((square): square is StudySquareAnnotation => square !== null),
    (square) => `${square.color}:${square.square}`,
  );

  return { comments, arrows, squares };
}

function isMoveEvent(event: TrainerEvent): event is MoveEvent {
  return event.type === 'user-move-accepted' || event.type === 'opponent-move';
}

export function extractStudyAnnotationMoments(
  transition: TrainerTransition,
): StudyAnnotationMoment[] {
  const moments: StudyAnnotationMoment[] = [];
  let historySearchIndex = 0;

  for (const event of transition.events) {
    if (!isMoveEvent(event)) continue;

    const historyIndex = transition.snapshot.actualMoveIds.indexOf(
      event.move.id,
      historySearchIndex,
    );
    if (historyIndex < 0) continue;
    historySearchIndex = historyIndex + 1;

    const annotations = visibleAnnotations(event.move.annotations);
    if (
      annotations.comments.length === 0 &&
      annotations.arrows.length === 0 &&
      annotations.squares.length === 0
    ) {
      continue;
    }

    moments.push({
      fen: event.fen,
      moveId: event.move.id,
      uci: event.move.uci,
      san: event.move.san,
      historyLength: historyIndex + 1,
      ...annotations,
    });
  }

  return moments;
}
