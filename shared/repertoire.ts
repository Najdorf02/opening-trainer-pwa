export type RepertoireColor = "white" | "black";

export type MoveTurn = "w" | "b";

export interface MoveAnnotations {
  comments: string[];
  nags: string[];
  arrows: string[];
  squares: string[];
  evaluation?: string;
}

export interface RepertoireMove {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  uci: string;
  san: string;
  order: number;
  /** Whether this move is an answer to learn or a known mistake to avoid. */
  trainingRole: "train" | "avoid";
  /** Present only when this is a move the repertoire owner must recall. */
  cardId?: string;
  annotations: MoveAnnotations;
}

export interface RepertoirePosition {
  id: string;
  /** UCI moves from the chapter root. Kept path-specific for PGN annotations. */
  path: string[];
  fen: string;
  /** First four FEN fields; stable across clock/full-move counter changes. */
  positionKey: string;
  turn: MoveTurn;
  outgoingMoveIds: string[];
}

export interface TrainingLine {
  id: string;
  moveIds: string[];
  uciMoves: string[];
  userCardIds: string[];
  order: number;
}

export interface RepertoireChapter {
  id: string;
  studyId: string;
  name: string;
  sourceUrl?: string;
  repertoireColor: RepertoireColor;
  orientationSource: "pgn" | "override";
  variant: "standard";
  rootFen: string;
  rootNodeId: string;
  /** Lichess comments and board shapes attached before the first move. */
  rootAnnotations?: MoveAnnotations;
  positions: Record<string, RepertoirePosition>;
  moves: Record<string, RepertoireMove>;
  lines: TrainingLine[];
  tags: Record<string, string>;
}

export interface RepertoireStudy {
  id: string;
  name: string;
  chapters: RepertoireChapter[];
}

export interface RepertoireImportDiagnostic {
  code:
    | "INVALID_PGN"
    | "MISSING_ORIENTATION"
    | "INVALID_ORIENTATION"
    | "UNSUPPORTED_VARIANT"
    | "ILLEGAL_MOVE"
    | "MULTIPLE_STUDIES"
    | "EMPTY_STUDY";
  message: string;
  chapterId?: string;
  chapterIndex?: number;
  movePath?: string[];
}

export class RepertoireImportError extends Error {
  readonly diagnostics: RepertoireImportDiagnostic[];

  constructor(diagnostics: RepertoireImportDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    this.name = "RepertoireImportError";
    this.diagnostics = diagnostics;
  }
}

export function colorToTurn(color: RepertoireColor): MoveTurn {
  return color === "white" ? "w" : "b";
}

export function canonicalPositionKey(fen: string): string {
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 4) {
    throw new Error(`Invalid FEN: ${fen}`);
  }
  return fields.slice(0, 4).join(" ");
}

/** JSON tuples keep IDs collision-free and stable when names/comments are edited. */
export function stableDomainId(
  kind: "node" | "move" | "line" | "card",
  ...parts: unknown[]
): string {
  return `${kind}:${JSON.stringify(parts)}`;
}
