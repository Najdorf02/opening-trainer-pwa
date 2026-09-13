import { Chess, DEFAULT_POSITION } from "chess.js";

import {
  canonicalPositionKey,
  type MoveAnnotations,
  type RepertoireChapter,
  type RepertoireColor,
  type RepertoireMove,
  type RepertoireStudy,
} from "./repertoire.js";

export interface GameReviewPlayerInput {
  username: string;
  rating?: number;
  /** Chess.com result token, for example `win`, `resigned`, or `timeout`. */
  result?: string;
}

/** Normalized subset of one Chess.com archive game. */
export interface GameReviewInput {
  id: string;
  pgn: string;
  white: GameReviewPlayerInput;
  black: GameReviewPlayerInput;
  url?: string;
  /** Unix seconds from Chess.com's `end_time`, when available. */
  endTime?: number;
  playedAt?: string;
  timeClass?: string;
  timeControl?: string;
  rated?: boolean;
  /** Chess.com calls standard chess `chess`; `standard` is also accepted. */
  rules?: string;
  /** Fallback for non-standard starts whose PGN omitted its FEN header. */
  initialFen?: string;
}

export type GameReviewResult = "win" | "loss" | "draw" | "unknown";

export interface GameReviewMeta {
  id: string;
  url?: string;
  playedAt?: string;
  timeClass?: string;
  timeControl?: string;
  rated?: boolean;
  userColor: RepertoireColor;
  user: GameReviewPlayerInput;
  opponent: GameReviewPlayerInput;
  result: GameReviewResult;
  resultReason?: string;
  opening?: string;
  openingUrl?: string;
  eco?: string;
}

export interface ReviewedGameMove {
  /** One-based half-move index. */
  ply: number;
  moveNumber: number;
  mover: RepertoireColor;
  isUserMove: boolean;
  uci: string;
  san: string;
  beforeFen: string;
  afterFen: string;
}

export interface RepertoireChapterRef {
  studyId: string;
  studyName?: string;
  chapterId: string;
  chapterName: string;
  repertoireColor: RepertoireColor;
  sourceUrl?: string;
}

export interface RepertoireReviewMoveCandidate {
  moveId: string;
  uci: string;
  san: string;
  cardId?: string;
  annotations: MoveAnnotations;
  chapters: RepertoireChapterRef[];
}

export type GameDeviationKind =
  | "opponent-uncovered"
  | "user-deviation"
  | "coverage-ended";
export type GameDeviationReason =
  | "move-not-covered"
  | "known-avoid"
  | "repertoire-ended";

export interface GameRepertoireDeviation {
  kind: GameDeviationKind;
  reason: GameDeviationReason;
  ply: number;
  beforeFen: string;
  afterFen: string;
  played: ReviewedGameMove;
  expectedMoves: RepertoireReviewMoveCandidate[];
  /** Set when the played user move is an explicitly annotated $2/$4 edge. */
  knownAvoid?: RepertoireReviewMoveCandidate;
  matchingChapters: RepertoireChapterRef[];
}

export interface GameReviewTrainingPosition {
  fen: string;
  positionKey: string;
  played: ReviewedGameMove;
  correctMoves: RepertoireReviewMoveCandidate[];
  matchingChapters: RepertoireChapterRef[];
}

export interface GameReviewTrainingOccurrence {
  gameId: string;
  gameUrl?: string;
  playedAt?: string;
  playedMove: Pick<ReviewedGameMove, "uci" | "san">;
  reason: Extract<GameDeviationReason, "move-not-covered" | "known-avoid">;
}

/**
 * One persistable review item, grouped by the position rather than by game.
 * Only genuine user deviations can produce this payload.
 */
export interface GameReviewTrainingAggregate {
  source: "chesscom-review";
  positionKey: string;
  fen: string;
  userColor: RepertoireColor;
  correctMoves: RepertoireReviewMoveCandidate[];
  matchingChapters: RepertoireChapterRef[];
  occurrences: GameReviewTrainingOccurrence[];
  occurrenceCount: number;
}

export interface GameReviewDrillResult {
  source: "chesscom-review";
  positionKey: string;
  gameId: string;
  /** Full position context lets the caller persist or grade the matching SRS cards. */
  trainingPosition: GameReviewTrainingAggregate;
  correctMove: Pick<RepertoireReviewMoveCandidate, "moveId" | "cardId" | "uci" | "san">;
  wrongAttempts: number;
  firstTryCorrect: boolean;
  completedAt: string;
}

export type GameRepertoireReviewStatus =
  | "in-repertoire"
  | "user-deviation"
  | "opponent-uncovered"
  | "coverage-ended"
  | "no-matching-repertoire";

export interface GameRepertoireReview {
  status: GameRepertoireReviewStatus;
  meta: GameReviewMeta;
  initialFen: string;
  moves: ReviewedGameMove[];
  /** Number of consecutive game plies covered before the first deviation. */
  matchedPlies: number;
  matchedUserMoves: number;
  /** A deterministic representative of the chapters matching the longest prefix. */
  match?: RepertoireChapterRef;
  matchingChapters: RepertoireChapterRef[];
  firstDeviation?: GameRepertoireDeviation;
  firstOpponentUncovered?: GameRepertoireDeviation;
  firstUserDeviation?: GameRepertoireDeviation;
  /** Only created for a user deviation that has at least one learnable answer. */
  reviewPosition?: GameReviewTrainingPosition;
}

export type GameReviewSource = RepertoireStudy | RepertoireChapter;

export type GameReviewErrorCode =
  | "USER_NOT_IN_GAME"
  | "INVALID_PGN"
  | "UNSUPPORTED_RULES";

export class GameReviewError extends Error {
  constructor(
    readonly code: GameReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GameReviewError";
  }
}

interface ChapterCursor {
  chapter: RepertoireChapter;
  ref: RepertoireChapterRef;
  nodeId: string;
  lineMoveIds: Set<string>;
}

interface ParsedReviewGame {
  headers: Record<string, string>;
  initialFen: string;
  moves: Omit<ReviewedGameMove, "isUserMove">[];
}

const DRAW_RESULTS = new Set([
  "agreed",
  "repetition",
  "stalemate",
  "insufficient",
  "50move",
  "timevsinsufficient",
]);

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Resolve the user's board color without depending on username casing. */
export function identifyUserColor(
  game: Pick<GameReviewInput, "white" | "black">,
  username: string,
): RepertoireColor | undefined {
  const expected = normalizeUsername(username);
  if (!expected) return undefined;
  const isWhite = normalizeUsername(game.white.username) === expected;
  const isBlack = normalizeUsername(game.black.username) === expected;
  if (isWhite === isBlack) return undefined;
  return isWhite ? "white" : "black";
}

function pgnWithFallbackFen(game: GameReviewInput): string {
  if (!game.initialFen || /^\s*\[FEN\s+"/imu.test(game.pgn)) {
    return game.pgn;
  }
  return `[SetUp "1"]\n[FEN "${game.initialFen.replaceAll('"', '\\"')}"]\n${game.pgn}`;
}

function parseGame(game: GameReviewInput): ParsedReviewGame {
  const rules = game.rules?.trim().toLowerCase();
  if (rules && rules !== "chess" && rules !== "standard") {
    throw new GameReviewError(
      "UNSUPPORTED_RULES",
      `Unsupported Chess.com rules: ${game.rules}.`,
    );
  }

  const chess = new Chess();
  try {
    chess.loadPgn(pgnWithFallbackFen(game), { strict: false });
  } catch (error) {
    throw new GameReviewError(
      "INVALID_PGN",
      error instanceof Error ? error.message : "Could not parse game PGN.",
    );
  }

  const headers = chess.getHeaders();
  const verboseMoves = chess.history({ verbose: true });
  const initialFen =
    verboseMoves[0]?.before ?? headers.FEN ?? game.initialFen ?? DEFAULT_POSITION;
  try {
    // Also validates an empty custom-start game, for which history has no FEN.
    new Chess(initialFen);
  } catch (error) {
    throw new GameReviewError(
      "INVALID_PGN",
      error instanceof Error ? error.message : "The game has an invalid initial FEN.",
    );
  }

  return {
    headers,
    initialFen,
    moves: verboseMoves.map((move, index) => ({
      ply: index + 1,
      moveNumber: Number.parseInt(move.before.split(/\s+/u)[5] ?? "", 10),
      mover: move.color === "w" ? "white" : "black",
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      san: move.san,
      beforeFen: move.before,
      afterFen: move.after,
    })),
  };
}

function resultFromHeaders(
  resultHeader: string | undefined,
  userColor: RepertoireColor,
  userResult: string | undefined,
): GameReviewResult {
  if (resultHeader === "1/2-1/2") return "draw";
  if (resultHeader === "1-0") return userColor === "white" ? "win" : "loss";
  if (resultHeader === "0-1") return userColor === "black" ? "win" : "loss";

  const normalized = userResult?.trim().toLowerCase();
  if (normalized === "win") return "win";
  if (normalized && DRAW_RESULTS.has(normalized)) return "draw";
  if (normalized) return "loss";
  return "unknown";
}

function dateFromHeaders(headers: Record<string, string>): string | undefined {
  const rawDate = headers.UTCDate ?? headers.Date;
  if (!rawDate || rawDate.includes("?")) return undefined;
  const date = rawDate.replaceAll(".", "-");
  const rawTime = headers.UTCTime;
  return rawTime && /^\d{2}:\d{2}:\d{2}$/u.test(rawTime)
    ? `${date}T${rawTime}Z`
    : date;
}

function openingFromHeaders(headers: Record<string, string>): string | undefined {
  const named = headers.Opening?.trim();
  if (named) return headers.Variation?.trim()
    ? `${named}: ${headers.Variation.trim()}`
    : named;

  const openingUrl = headers.ECOUrl?.trim();
  if (!openingUrl) return undefined;
  const slug = openingUrl.match(/\/openings\/([^/?#]+)/iu)?.[1];
  if (!slug) return undefined;
  try {
    return decodeURIComponent(slug).replaceAll("-", " ");
  } catch {
    return slug.replaceAll("-", " ");
  }
}

function metadata(
  game: GameReviewInput,
  parsed: ParsedReviewGame,
  userColor: RepertoireColor,
): GameReviewMeta {
  const user = userColor === "white" ? game.white : game.black;
  const opponent = userColor === "white" ? game.black : game.white;
  const opening = openingFromHeaders(parsed.headers);
  const playedAt = game.playedAt
    ?? (Number.isFinite(game.endTime)
      ? new Date((game.endTime as number) * 1_000).toISOString()
      : dateFromHeaders(parsed.headers));
  return {
    id: game.id,
    ...(game.url ? { url: game.url } : {}),
    ...(playedAt ? { playedAt } : {}),
    ...(game.timeClass ? { timeClass: game.timeClass } : {}),
    ...(game.timeControl ? { timeControl: game.timeControl } : {}),
    ...(game.rated === undefined ? {} : { rated: game.rated }),
    userColor,
    user: { ...user },
    opponent: { ...opponent },
    result: resultFromHeaders(parsed.headers.Result, userColor, user.result),
    ...(user.result ? { resultReason: user.result } : {}),
    ...(opening ? { opening } : {}),
    ...(parsed.headers.ECOUrl
      ? { openingUrl: parsed.headers.ECOUrl }
      : {}),
    ...(parsed.headers.ECO ? { eco: parsed.headers.ECO } : {}),
  };
}

function chapterRef(
  chapter: RepertoireChapter,
  studyName?: string,
): RepertoireChapterRef {
  return {
    studyId: chapter.studyId,
    ...(studyName ? { studyName } : {}),
    chapterId: chapter.id,
    chapterName: chapter.name,
    repertoireColor: chapter.repertoireColor,
    ...(chapter.sourceUrl ? { sourceUrl: chapter.sourceUrl } : {}),
  };
}

function flattenSources(sources: readonly GameReviewSource[]): ChapterCursor[] {
  const cursors: ChapterCursor[] = [];
  const seen = new Set<string>();

  const addChapter = (chapter: RepertoireChapter, studyName?: string) => {
    const key = `${chapter.studyId}\u0000${chapter.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    cursors.push({
      chapter,
      ref: chapterRef(chapter, studyName),
      nodeId: chapter.rootNodeId,
      lineMoveIds: new Set(chapter.lines.flatMap((line) => line.moveIds)),
    });
  };

  for (const source of sources) {
    if ("chapters" in source) {
      for (const chapter of source.chapters) addChapter(chapter, source.name);
    } else {
      addChapter(source);
    }
  }
  return cursors;
}

function eligibleMoves(cursor: ChapterCursor): RepertoireMove[] {
  const node = cursor.chapter.positions[cursor.nodeId];
  if (!node) return [];
  return node.outgoingMoveIds
    .filter((moveId) => cursor.lineMoveIds.has(moveId))
    .map((moveId) => cursor.chapter.moves[moveId])
    .filter(
      (move): move is RepertoireMove =>
        Boolean(move) &&
        move.fromNodeId === node.id &&
        move.trainingRole === "train",
    )
    .sort((left, right) => left.order - right.order);
}

function avoidMove(cursor: ChapterCursor, uci: string): RepertoireMove | undefined {
  const node = cursor.chapter.positions[cursor.nodeId];
  return node?.outgoingMoveIds
    .map((moveId) => cursor.chapter.moves[moveId])
    .find(
      (move) =>
        move?.fromNodeId === node.id &&
        move.trainingRole === "avoid" &&
        move.uci === uci,
    );
}

function cloneAnnotations(annotations: MoveAnnotations): MoveAnnotations {
  return {
    comments: [...annotations.comments],
    nags: [...annotations.nags],
    arrows: [...annotations.arrows],
    squares: [...annotations.squares],
    ...(annotations.evaluation ? { evaluation: annotations.evaluation } : {}),
  };
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

function mergeCandidates(
  entries: Array<{ move: RepertoireMove; ref: RepertoireChapterRef }>,
): RepertoireReviewMoveCandidate[] {
  const byUci = new Map<string, RepertoireReviewMoveCandidate>();
  for (const { move, ref } of entries) {
    const current = byUci.get(move.uci);
    if (current) {
      if (
        !current.chapters.some(
          (chapter) =>
            chapter.studyId === ref.studyId && chapter.chapterId === ref.chapterId,
        )
      ) {
        current.chapters.push(ref);
      }
      mergeAnnotations(current.annotations, move.annotations);
      continue;
    }
    byUci.set(move.uci, {
      moveId: move.id,
      uci: move.uci,
      san: move.san,
      ...(move.cardId ? { cardId: move.cardId } : {}),
      annotations: cloneAnnotations(move.annotations),
      chapters: [ref],
    });
  }
  return [...byUci.values()];
}

function refsOf(cursors: ChapterCursor[]): RepertoireChapterRef[] {
  return cursors.map((cursor) => cursor.ref);
}

/**
 * Compare a Chess.com main line with every matching repertoire chapter.
 *
 * Chapters stay in contention while they match the same game prefix, so a
 * shorter sibling cannot hide a longer match and answer candidates are united
 * across chapters. Engine judgment of off-book alternatives is intentionally
 * left to the caller.
 */
export function reviewGameAgainstRepertoire(
  game: GameReviewInput,
  username: string,
  sources: readonly GameReviewSource[],
): GameRepertoireReview {
  const userColor = identifyUserColor(game, username);
  if (!userColor) {
    throw new GameReviewError(
      "USER_NOT_IN_GAME",
      `User ${username.trim() || "(empty)"} is not uniquely present in game ${game.id}.`,
    );
  }

  const parsed = parseGame(game);
  const moves: ReviewedGameMove[] = parsed.moves.map((move) => ({
    ...move,
    isUserMove: move.mover === userColor,
  }));
  const meta = metadata(game, parsed, userColor);
  const rootKey = canonicalPositionKey(parsed.initialFen);
  let active = flattenSources(sources).filter(
    (cursor) =>
      cursor.chapter.repertoireColor === userColor &&
      canonicalPositionKey(cursor.chapter.rootFen) === rootKey,
  );

  if (active.length === 0) {
    return {
      status: "no-matching-repertoire",
      meta,
      initialFen: parsed.initialFen,
      moves,
      matchedPlies: 0,
      matchedUserMoves: 0,
      matchingChapters: [],
    };
  }

  let matchedPlies = 0;
  let matchedUserMoves = 0;

  for (const played of moves) {
    const expectedEntries = active.flatMap((cursor) =>
      eligibleMoves(cursor).map((move) => ({ move, ref: cursor.ref })),
    );
    const matchedCursors: ChapterCursor[] = [];
    for (const cursor of active) {
      const matchingMove = eligibleMoves(cursor).find(
        (move) => move.uci === played.uci,
      );
      if (matchingMove) {
        matchedCursors.push({ ...cursor, nodeId: matchingMove.toNodeId });
      }
    }

    if (matchedCursors.length > 0) {
      active = matchedCursors;
      matchedPlies += 1;
      if (played.isUserMove) matchedUserMoves += 1;
      continue;
    }

    const expectedMoves = mergeCandidates(expectedEntries);
    const avoidEntries = played.isUserMove
      ? active.flatMap((cursor) => {
          const move = avoidMove(cursor, played.uci);
          return move ? [{ move, ref: cursor.ref }] : [];
        })
      : [];
    const knownAvoid = mergeCandidates(avoidEntries)[0];
    const matchingChapters = refsOf(active);
    const reason: GameDeviationReason = knownAvoid
      ? "known-avoid"
      : expectedMoves.length === 0
        ? "repertoire-ended"
        : "move-not-covered";
    const kind: GameDeviationKind = reason === "repertoire-ended"
      ? "coverage-ended"
      : played.isUserMove
        ? "user-deviation"
        : "opponent-uncovered";
    const deviation: GameRepertoireDeviation = {
      kind,
      reason,
      ply: played.ply,
      beforeFen: played.beforeFen,
      afterFen: played.afterFen,
      played,
      expectedMoves,
      ...(knownAvoid ? { knownAvoid } : {}),
      matchingChapters,
    };

    return {
      status: kind,
      meta,
      initialFen: parsed.initialFen,
      moves,
      matchedPlies,
      matchedUserMoves,
      match: matchingChapters[0],
      matchingChapters,
      firstDeviation: deviation,
      ...(kind === "opponent-uncovered"
        ? { firstOpponentUncovered: deviation }
        : kind === "user-deviation"
          ? { firstUserDeviation: deviation }
          : {}),
      ...(kind === "user-deviation" && expectedMoves.length > 0
        ? {
            reviewPosition: {
              fen: played.beforeFen,
              positionKey: canonicalPositionKey(played.beforeFen),
              played,
              correctMoves: expectedMoves,
              matchingChapters,
            },
          }
        : {}),
    };
  }

  const matchingChapters = refsOf(active);
  return {
    status: "in-repertoire",
    meta,
    initialFen: parsed.initialFen,
    moves,
    matchedPlies,
    matchedUserMoves,
    match: matchingChapters[0],
    matchingChapters,
  };
}

function mergeChapterRefs(
  target: RepertoireChapterRef[],
  incoming: readonly RepertoireChapterRef[],
): void {
  for (const chapter of incoming) {
    if (!target.some(
      (current) => current.studyId === chapter.studyId && current.chapterId === chapter.chapterId,
    )) {
      target.push({ ...chapter });
    }
  }
}

function mergeTrainingCandidates(
  target: RepertoireReviewMoveCandidate[],
  incoming: readonly RepertoireReviewMoveCandidate[],
): void {
  for (const candidate of incoming) {
    const current = target.find((move) => move.uci === candidate.uci);
    if (!current) {
      target.push({
        ...candidate,
        annotations: cloneAnnotations(candidate.annotations),
        chapters: candidate.chapters.map((chapter) => ({ ...chapter })),
      });
      continue;
    }
    mergeAnnotations(current.annotations, candidate.annotations);
    mergeChapterRefs(current.chapters, candidate.chapters);
  }
}

/**
 * Group repeated Chess.com user deviations into stable position-level review
 * items. Opponent novelties and positions where the repertoire has ended are
 * deliberately excluded, because neither represents a user lapse.
 */
export function aggregateGameReviewTrainingPositions(
  reviews: readonly GameRepertoireReview[],
): GameReviewTrainingAggregate[] {
  const grouped = new Map<string, GameReviewTrainingAggregate>();

  for (const review of reviews) {
    const position = review.reviewPosition;
    const deviation = review.firstUserDeviation;
    if (
      review.status !== "user-deviation" ||
      !position ||
      !deviation ||
      (deviation.reason !== "move-not-covered" && deviation.reason !== "known-avoid")
    ) {
      continue;
    }

    const occurrence: GameReviewTrainingOccurrence = {
      gameId: review.meta.id,
      ...(review.meta.url ? { gameUrl: review.meta.url } : {}),
      ...(review.meta.playedAt ? { playedAt: review.meta.playedAt } : {}),
      playedMove: { uci: position.played.uci, san: position.played.san },
      reason: deviation.reason,
    };
    const current = grouped.get(position.positionKey);
    if (current) {
      if (!current.occurrences.some((item) => item.gameId === occurrence.gameId)) {
        current.occurrences.push(occurrence);
        current.occurrenceCount = current.occurrences.length;
      }
      mergeTrainingCandidates(current.correctMoves, position.correctMoves);
      mergeChapterRefs(current.matchingChapters, position.matchingChapters);
      continue;
    }

    grouped.set(position.positionKey, {
      source: "chesscom-review",
      positionKey: position.positionKey,
      fen: position.fen,
      userColor: review.meta.userColor,
      correctMoves: [],
      matchingChapters: position.matchingChapters.map((chapter) => ({ ...chapter })),
      occurrences: [occurrence],
      occurrenceCount: 1,
    });
    mergeTrainingCandidates(
      grouped.get(position.positionKey)!.correctMoves,
      position.correctMoves,
    );
  }

  return [...grouped.values()].sort((left, right) => {
    if (left.occurrenceCount !== right.occurrenceCount) {
      return right.occurrenceCount - left.occurrenceCount;
    }
    const leftDate = left.occurrences.at(-1)?.playedAt ?? "";
    const rightDate = right.occurrences.at(-1)?.playedAt ?? "";
    return rightDate.localeCompare(leftDate) || left.positionKey.localeCompare(right.positionKey);
  });
}
