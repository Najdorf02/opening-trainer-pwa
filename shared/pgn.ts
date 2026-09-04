import { parseGames, type ParseTree } from "@mliebelt/pgn-parser";
import type { GameComment, PgnMove } from "@mliebelt/pgn-types";
import { Chess, DEFAULT_POSITION } from "chess.js";

import {
  canonicalPositionKey,
  colorToTurn,
  RepertoireImportError,
  stableDomainId,
  type MoveAnnotations,
  type RepertoireChapter,
  type RepertoireColor,
  type RepertoireImportDiagnostic,
  type RepertoireMove,
  type RepertoirePosition,
  type RepertoireStudy,
  type TrainingLine,
} from "./repertoire.js";

export interface ImportLichessPgnOptions {
  /** Use the ID from the API route when it is already known. */
  studyId?: string;
  studyName?: string;
  /** Escape hatch for old exports without the Orientation header. */
  orientationOverride?: RepertoireColor;
}

type StringTags = Record<string, string>;

interface SourceIds {
  studyId?: string;
  chapterId?: string;
  url?: string;
}

interface MutableChapter {
  chapter: RepertoireChapter;
  lineIds: Set<string>;
}

const AVOID_NAGS = new Set(["$2", "$4"]);

function asStringTags(tree: ParseTree): StringTags {
  const result: StringTags = {};
  const tags = (tree.tags ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value === "string") result[key] = value;
    else if (
      value &&
      typeof value === "object" &&
      "value" in value &&
      typeof value.value === "string"
    ) {
      result[key] = value.value;
    }
  }
  return result;
}

function extractSourceIds(tags: StringTags): SourceIds {
  const candidates = [tags.ChapterURL, tags.Site].filter(Boolean);
  for (const candidate of candidates) {
    const match = candidate.match(/\/study\/([^/?#]+)(?:\/([^/?#]+))?/i);
    if (match) {
      return { studyId: match[1], chapterId: match[2], url: candidate };
    }
  }
  return { url: tags.ChapterURL ?? tags.Site };
}

function parseOrientation(
  tags: StringTags,
  override: RepertoireColor | undefined,
  chapterId: string,
  chapterIndex: number,
): { color: RepertoireColor; source: "pgn" | "override" } {
  if (override) return { color: override, source: "override" };

  const value = tags.Orientation?.trim().toLowerCase();
  if (!value) {
    throw new RepertoireImportError([
      {
        code: "MISSING_ORIENTATION",
        message: `Chapter ${chapterId} has no Orientation header.`,
        chapterId,
        chapterIndex,
      },
    ]);
  }
  if (value !== "white" && value !== "black") {
    throw new RepertoireImportError([
      {
        code: "INVALID_ORIENTATION",
        message: `Chapter ${chapterId} has invalid Orientation: ${tags.Orientation}.`,
        chapterId,
        chapterIndex,
      },
    ]);
  }
  return { color: value, source: "pgn" };
}

function annotationsOfComment(
  diag: GameComment | null | undefined,
): MoveAnnotations {
  return {
    comments: diag?.comment ? [diag.comment] : [],
    nags: [],
    arrows: [...new Set(diag?.colorArrows ?? [])],
    squares: [...new Set(diag?.colorFields ?? [])],
    evaluation: diag?.eval,
  };
}

function annotationsOf(move: PgnMove): MoveAnnotations {
  const annotations = annotationsOfComment(
    move.commentDiag as GameComment | null | undefined,
  );
  annotations.comments = [
    ...new Set(
      [
        ...annotations.comments,
        move.commentMove,
        move.commentAfter,
      ].filter((comment): comment is string => Boolean(comment)),
    ),
  ];
  annotations.nags = [...new Set(move.nag ?? [])];
  return annotations;
}

function mergeAnnotations(
  target: MoveAnnotations,
  incoming: MoveAnnotations,
): void {
  for (const key of ["comments", "nags", "arrows", "squares"] as const) {
    target[key] = [...new Set([...target[key], ...incoming[key]])];
  }
  target.evaluation ??= incoming.evaluation;
}

function createPosition(
  studyId: string,
  chapterId: string,
  path: string[],
  chess: Chess,
): RepertoirePosition {
  const fen = chess.fen();
  return {
    id: stableDomainId("node", studyId, chapterId, path),
    path: [...path],
    fen,
    positionKey: canonicalPositionKey(fen),
    turn: chess.turn(),
    outgoingMoveIds: [],
  };
}

function addLine(mutable: MutableChapter, moveIds: string[], uciMoves: string[]): void {
  if (moveIds.length === 0) return;
  const id = stableDomainId(
    "line",
    mutable.chapter.studyId,
    mutable.chapter.id,
    uciMoves,
  );
  if (mutable.lineIds.has(id)) return;
  mutable.lineIds.add(id);
  const userCardIds = moveIds
    .map((moveId) => mutable.chapter.moves[moveId].cardId)
    .filter((cardId): cardId is string => Boolean(cardId));
  mutable.chapter.lines.push({
    id,
    moveIds: [...moveIds],
    uciMoves: [...uciMoves],
    userCardIds,
    order: mutable.chapter.lines.length,
  });
}

function insertSequence(
  mutable: MutableChapter,
  sequence: PgnMove[],
  startNodeId: string,
  startingChess: Chess,
  priorMoveIds: string[],
  priorUciMoves: string[],
  chapterIndex: number,
): void {
  if (sequence.length === 0) {
    addLine(mutable, priorMoveIds, priorUciMoves);
    return;
  }

  const [sourceMove, ...continuation] = sequence;
  const parent = mutable.chapter.positions[startNodeId];
  const chess = new Chess(startingChess.fen());
  let applied: ReturnType<Chess["move"]>;
  try {
    applied = chess.move(sourceMove.notation.notation, { strict: false });
  } catch {
    throw new RepertoireImportError([
      {
        code: "ILLEGAL_MOVE",
        message: `Illegal move ${sourceMove.notation.notation} in chapter ${mutable.chapter.id}.`,
        chapterId: mutable.chapter.id,
        chapterIndex,
        movePath: priorUciMoves,
      },
    ]);
  }

  const uci = `${applied.from}${applied.to}${applied.promotion ?? ""}`;
  const nextUciMoves = [...priorUciMoves, uci];
  const childId = stableDomainId(
    "node",
    mutable.chapter.studyId,
    mutable.chapter.id,
    nextUciMoves,
  );
  let edge = parent.outgoingMoveIds
    .map((id) => mutable.chapter.moves[id])
    .find((candidate) => candidate.uci === uci);

  if (!edge) {
    const edgeId = stableDomainId(
      "move",
      mutable.chapter.studyId,
      mutable.chapter.id,
      priorUciMoves,
      uci,
    );
    const annotations = annotationsOf(sourceMove);
    const isRepertoireTurn =
      parent.turn === colorToTurn(mutable.chapter.repertoireColor);
    const trainingRole =
      isRepertoireTurn && annotations.nags.some((nag) => AVOID_NAGS.has(nag))
        ? "avoid"
        : "train";
    const cardId =
      isRepertoireTurn && trainingRole === "train"
        ? stableDomainId(
            "card",
            mutable.chapter.studyId,
            mutable.chapter.id,
            mutable.chapter.repertoireColor,
            parent.positionKey,
            uci,
          )
        : undefined;
    edge = {
      id: edgeId,
      fromNodeId: parent.id,
      toNodeId: childId,
      uci,
      san: applied.san,
      order: parent.outgoingMoveIds.length,
      trainingRole,
      cardId,
      annotations,
    };
    mutable.chapter.moves[edgeId] = edge;
    parent.outgoingMoveIds.push(edgeId);
    mutable.chapter.positions[childId] = createPosition(
      mutable.chapter.studyId,
      mutable.chapter.id,
      nextUciMoves,
      chess,
    );
  } else {
    const annotations = annotationsOf(sourceMove);
    mergeAnnotations(edge.annotations, annotations);
    if (
      parent.turn === colorToTurn(mutable.chapter.repertoireColor) &&
      annotations.nags.some((nag) => AVOID_NAGS.has(nag))
    ) {
      edge.trainingRole = "avoid";
      delete edge.cardId;
    }
  }

  const nextMoveIds = [...priorMoveIds, edge.id];

  // The PGN main line is inserted before its RAVs, preserving Lichess order.
  insertSequence(
    mutable,
    continuation,
    edge.toNodeId,
    chess,
    nextMoveIds,
    nextUciMoves,
    chapterIndex,
  );

  for (const variation of sourceMove.variations ?? []) {
    insertSequence(
      mutable,
      variation,
      startNodeId,
      startingChess,
      priorMoveIds,
      priorUciMoves,
      chapterIndex,
    );
  }
}

function compileChapter(
  tree: ParseTree,
  chapterIndex: number,
  options: ImportLichessPgnOptions,
): RepertoireChapter {
  const tags = asStringTags(tree);
  const source = extractSourceIds(tags);
  const studyId = options.studyId ?? source.studyId ?? "imported-study";
  const chapterId = source.chapterId ?? `chapter-${chapterIndex + 1}`;
  const orientation = parseOrientation(
    tags,
    options.orientationOverride,
    chapterId,
    chapterIndex,
  );
  const variant = (tags.Variant ?? "Standard").trim().toLowerCase();
  if (variant !== "standard" && variant !== "from position") {
    throw new RepertoireImportError([
      {
        code: "UNSUPPORTED_VARIANT",
        message: `Chapter ${chapterId} uses unsupported variant ${tags.Variant}.`,
        chapterId,
        chapterIndex,
      },
    ]);
  }

  const rootFen = tags.FEN ?? DEFAULT_POSITION;
  let rootChess: Chess;
  try {
    rootChess = new Chess(rootFen);
  } catch {
    throw new RepertoireImportError([
      {
        code: "INVALID_PGN",
        message: `Chapter ${chapterId} has an invalid FEN header.`,
        chapterId,
        chapterIndex,
      },
    ]);
  }

  const root = createPosition(studyId, chapterId, [], rootChess);
  const mutable: MutableChapter = {
    chapter: {
      id: chapterId,
      studyId,
      name: tags.ChapterName ?? tags.Event ?? `Chapter ${chapterIndex + 1}`,
      sourceUrl: source.url,
      repertoireColor: orientation.color,
      orientationSource: orientation.source,
      variant: "standard",
      rootFen: root.fen,
      rootNodeId: root.id,
      rootAnnotations: tree.gameComment
        ? annotationsOfComment(tree.gameComment)
        : undefined,
      positions: { [root.id]: root },
      moves: {},
      lines: [],
      tags,
    },
    lineIds: new Set(),
  };

  insertSequence(mutable, tree.moves, root.id, rootChess, [], [], chapterIndex);
  mutable.chapter.lines = mutable.chapter.lines
    .filter((line) =>
      line.moveIds.every(
        (moveId) =>
          mutable.chapter.moves[moveId]?.trainingRole !== "avoid",
      ),
    )
    .map((line, order) => ({
      ...line,
      order,
      userCardIds: line.moveIds
        .map((moveId) => mutable.chapter.moves[moveId]?.cardId)
        .filter((cardId): cardId is string => Boolean(cardId)),
    }));
  return mutable.chapter;
}

function parseTrees(pgn: string): ParseTree[] {
  try {
    const trees = parseGames(pgn);
    if (trees.length === 0) {
      throw new RepertoireImportError([
        { code: "EMPTY_STUDY", message: "The PGN contains no chapters." },
      ]);
    }
    return trees;
  } catch (error) {
    if (error instanceof RepertoireImportError) throw error;
    throw new RepertoireImportError([
      {
        code: "INVALID_PGN",
        message: error instanceof Error ? error.message : "Could not parse PGN.",
      },
    ]);
  }
}

export function importLichessStudiesPgn(
  pgn: string,
  options: ImportLichessPgnOptions = {},
): RepertoireStudy[] {
  const trees = parseTrees(pgn);
  const groups = new Map<string, RepertoireStudy>();
  trees.forEach((tree, index) => {
    const chapter = compileChapter(tree, index, options);
    const tags = asStringTags(tree);
    const existing = groups.get(chapter.studyId);
    if (existing) {
      existing.chapters.push(chapter);
      return;
    }
    groups.set(chapter.studyId, {
      id: chapter.studyId,
      name: options.studyName ?? tags.StudyName ?? tags.Event ?? "Imported study",
      chapters: [chapter],
    });
  });
  return [...groups.values()];
}

export function importLichessStudyPgn(
  pgn: string,
  options: ImportLichessPgnOptions = {},
): RepertoireStudy {
  const studies = importLichessStudiesPgn(pgn, options);
  if (studies.length !== 1) {
    const diagnostics: RepertoireImportDiagnostic[] = [
      {
        code: "MULTIPLE_STUDIES",
        message: `Expected one study, but the PGN contained ${studies.length}.`,
      },
    ];
    throw new RepertoireImportError(diagnostics);
  }
  return studies[0];
}
