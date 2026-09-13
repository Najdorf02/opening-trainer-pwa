import { Chess } from "chess.js";

import {
  colorToTurn,
  type RepertoireChapter,
  type RepertoireMove,
  type TrainingLine,
} from "./repertoire.js";

export type TrainingPhase = "initial" | "mistake-review" | "complete";

export type TrainerStatus =
  | "idle"
  | "awaiting-user"
  | "showing-correction"
  | "line-complete"
  | "complete";

export type UserMoveInput =
  | string
  | { from: string; to: string; promotion?: string };

export interface PromptMove {
  moveId: string;
  uci: string;
  san: string;
  cardId?: string;
  isScheduled: boolean;
}

export interface Correction {
  playedUci: string;
  correctMove: PromptMove;
  acceptedMoves: PromptMove[];
  /** Annotated repertoire edge when the submitted move is a known mistake. */
  knownAvoidMove?: RepertoireMove;
}

export interface TrainerSnapshot {
  phase: TrainingPhase;
  status: TrainerStatus;
  chapterId: string;
  repertoireColor: "white" | "black";
  currentNodeId: string;
  fen: string;
  scheduledLineId?: string;
  routeLineId?: string;
  actualMoveIds: string[];
  initialRemaining: number;
  reviewRemaining: number;
  mistakeLineIds: string[];
  prompt?: {
    target: PromptMove;
    acceptedMoves: PromptMove[];
    retry: boolean;
  };
  correction?: Correction;
}

export type TrainerEvent =
  | { type: "phase-changed"; phase: TrainingPhase }
  | { type: "line-started"; phase: TrainingPhase; lineId: string }
  | { type: "opponent-move"; move: RepertoireMove; fen: string }
  | { type: "awaiting-user"; target: PromptMove; acceptedMoves: PromptMove[] }
  | {
      type: "user-move-accepted";
      move: RepertoireMove;
      alternative: boolean;
      firstTry: boolean;
      fen: string;
    }
  | { type: "illegal-move"; playedUci: string }
  | { type: "incorrect-move"; correction: Correction }
  | { type: "retry-requested" }
  | {
      type: "line-completed";
      scheduledLineId: string;
      actualLineId: string;
      clean: boolean;
    }
  | { type: "session-completed" };

export interface TrainerTransition {
  snapshot: TrainerSnapshot;
  events: TrainerEvent[];
}

export type AttemptOutcome =
  | "target-correct"
  | "repertoire-alternative"
  | "known-avoid"
  | "incorrect"
  | "illegal";

export interface TrainerAttempt {
  chapterId: string;
  phase: Exclude<TrainingPhase, "complete">;
  scheduledLineId: string;
  routeLineId: string;
  nodeId: string;
  positionKey: string;
  targetCardId?: string;
  /** Present when the submitted move is a registered repertoire move. */
  playedCardId?: string;
  playedUci: string;
  outcome: AttemptOutcome;
  elapsedMs: number;
  occurredAt: number;
}

export type SessionSrsGrade = "again" | "good";

/**
 * One aggregate grade per card per chapter session. `again` wins over `good`,
 * so an immediate retry after a reveal cannot inflate the interval.
 */
export interface SessionCardGrade {
  cardId: string;
  grade: SessionSrsGrade;
  firstAttemptAt: number;
  lastAttemptAt: number;
  totalResponseMs: number;
}

interface GradeAccumulator extends SessionCardGrade {}

export const TRAINER_SESSION_VERSION = 1 as const;

export type TrainerSessionRestoreErrorCode =
  | "INVALID_SNAPSHOT"
  | "UNSUPPORTED_VERSION"
  | "CHAPTER_MISMATCH"
  | "STALE_CHAPTER";

/**
 * A JSON-safe checkpoint of all state that affects a chapter session.
 * `promptElapsedMs` preserves active thinking time without counting the time
 * between closing and reopening the app.
 */
export interface SerializedTrainerSessionV1 {
  version: typeof TRAINER_SESSION_VERSION;
  savedAt: number;
  chapterId: string;
  chapterRevision: string;
  state: {
    phase: TrainingPhase;
    status: TrainerStatus;
    currentNodeId: string;
    scheduledLineId?: string;
    routeLineId?: string;
    actualMoveIds: string[];
    pendingInitialLineIds: string[];
    dirtyLineOrder: string[];
    reviewQueue: string[];
    trialHadError: boolean;
    trialHadAlternative: boolean;
    promptHadError: boolean;
    promptElapsedMs: number;
    /** Only the played move is persisted; correction data is rebuilt safely. */
    correctionPlayedUci?: string;
    attempts: TrainerAttempt[];
    grades: SessionCardGrade[];
  };
}

export type SerializedTrainerSession = SerializedTrainerSessionV1;

export class TrainerSessionRestoreError extends Error {
  readonly code: TrainerSessionRestoreErrorCode;

  constructor(code: TrainerSessionRestoreErrorCode, message: string) {
    super(message);
    this.name = "TrainerSessionRestoreError";
    this.code = code;
  }
}

type UnknownRecord = Record<string, unknown>;

function restoreError(
  code: TrainerSessionRestoreErrorCode,
  message: string,
): never {
  throw new TrainerSessionRestoreError(code, message);
}

function asRecord(value: unknown, field: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    restoreError("INVALID_SNAPSHOT", `${field} must be an object.`);
  }
  return value as UnknownRecord;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    restoreError("INVALID_SNAPSHOT", `${field} must be a string.`);
  }
  return value;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, field);
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    restoreError("INVALID_SNAPSHOT", `${field} must be a boolean.`);
  }
  return value;
}

function asNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    restoreError(
      "INVALID_SNAPSHOT",
      `${field} must be a finite non-negative number.`,
    );
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    restoreError("INVALID_SNAPSHOT", `${field} must be an array.`);
  }
  return value.map((item, index) => asString(item, `${field}[${index}]`));
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    restoreError("INVALID_SNAPSHOT", `${field} has an invalid value.`);
  }
  return value as T;
}

function parseAttempt(value: unknown, index: number): TrainerAttempt {
  const field = `state.attempts[${index}]`;
  const record = asRecord(value, field);
  return {
    chapterId: asString(record.chapterId, `${field}.chapterId`),
    phase: asEnum(
      record.phase,
      ["initial", "mistake-review"] as const,
      `${field}.phase`,
    ),
    scheduledLineId: asString(
      record.scheduledLineId,
      `${field}.scheduledLineId`,
    ),
    routeLineId: asString(record.routeLineId, `${field}.routeLineId`),
    nodeId: asString(record.nodeId, `${field}.nodeId`),
    positionKey: asString(record.positionKey, `${field}.positionKey`),
    targetCardId: asOptionalString(
      record.targetCardId,
      `${field}.targetCardId`,
    ),
    playedCardId: asOptionalString(
      record.playedCardId,
      `${field}.playedCardId`,
    ),
    playedUci: asString(record.playedUci, `${field}.playedUci`),
    outcome: asEnum(
      record.outcome,
      [
        "target-correct",
        "repertoire-alternative",
        "known-avoid",
        "incorrect",
        "illegal",
      ] as const,
      `${field}.outcome`,
    ),
    elapsedMs: asNonNegativeNumber(record.elapsedMs, `${field}.elapsedMs`),
    occurredAt: asNonNegativeNumber(record.occurredAt, `${field}.occurredAt`),
  };
}

function parseGrade(value: unknown, index: number): SessionCardGrade {
  const field = `state.grades[${index}]`;
  const record = asRecord(value, field);
  return {
    cardId: asString(record.cardId, `${field}.cardId`),
    grade: asEnum(record.grade, ["again", "good"] as const, `${field}.grade`),
    firstAttemptAt: asNonNegativeNumber(
      record.firstAttemptAt,
      `${field}.firstAttemptAt`,
    ),
    lastAttemptAt: asNonNegativeNumber(
      record.lastAttemptAt,
      `${field}.lastAttemptAt`,
    ),
    totalResponseMs: asNonNegativeNumber(
      record.totalResponseMs,
      `${field}.totalResponseMs`,
    ),
  };
}

function parseSerializedSession(value: unknown): SerializedTrainerSessionV1 {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      restoreError("INVALID_SNAPSHOT", "The trainer checkpoint is not valid JSON.");
    }
  }

  const record = asRecord(decoded, "checkpoint");
  if (record.version !== TRAINER_SESSION_VERSION) {
    if (typeof record.version === "number") {
      restoreError(
        "UNSUPPORTED_VERSION",
        `Trainer checkpoint version ${record.version} is not supported.`,
      );
    }
    restoreError("INVALID_SNAPSHOT", "Trainer checkpoint version is missing.");
  }

  const state = asRecord(record.state, "state");
  if (!Array.isArray(state.attempts) || !Array.isArray(state.grades)) {
    restoreError("INVALID_SNAPSHOT", "Trainer history must be stored as arrays.");
  }

  return {
    version: TRAINER_SESSION_VERSION,
    savedAt: asNonNegativeNumber(record.savedAt, "savedAt"),
    chapterId: asString(record.chapterId, "chapterId"),
    chapterRevision: asString(record.chapterRevision, "chapterRevision"),
    state: {
      phase: asEnum(
        state.phase,
        ["initial", "mistake-review", "complete"] as const,
        "state.phase",
      ),
      status: asEnum(
        state.status,
        [
          "idle",
          "awaiting-user",
          "showing-correction",
          "line-complete",
          "complete",
        ] as const,
        "state.status",
      ),
      currentNodeId: asString(state.currentNodeId, "state.currentNodeId"),
      scheduledLineId: asOptionalString(
        state.scheduledLineId,
        "state.scheduledLineId",
      ),
      routeLineId: asOptionalString(state.routeLineId, "state.routeLineId"),
      actualMoveIds: asStringArray(state.actualMoveIds, "state.actualMoveIds"),
      pendingInitialLineIds: asStringArray(
        state.pendingInitialLineIds,
        "state.pendingInitialLineIds",
      ),
      dirtyLineOrder: asStringArray(
        state.dirtyLineOrder,
        "state.dirtyLineOrder",
      ),
      reviewQueue: asStringArray(state.reviewQueue, "state.reviewQueue"),
      trialHadError: asBoolean(
        state.trialHadError,
        "state.trialHadError",
      ),
      trialHadAlternative: asBoolean(
        state.trialHadAlternative,
        "state.trialHadAlternative",
      ),
      promptHadError: asBoolean(
        state.promptHadError,
        "state.promptHadError",
      ),
      promptElapsedMs: asNonNegativeNumber(
        state.promptElapsedMs,
        "state.promptElapsedMs",
      ),
      correctionPlayedUci: asOptionalString(
        state.correctionPlayedUci,
        "state.correctionPlayedUci",
      ),
      attempts: state.attempts.map(parseAttempt),
      grades: state.grades.map(parseGrade),
    },
  };
}

/** A compact structural fingerprint; comments and names do not invalidate it. */
export function trainerChapterRevision(chapter: RepertoireChapter): string {
  const structure = JSON.stringify({
    variant: chapter.variant,
    repertoireColor: chapter.repertoireColor,
    rootFen: chapter.rootFen,
    rootNodeId: chapter.rootNodeId,
    positions: Object.keys(chapter.positions)
      .sort()
      .map((id) => {
        const position = chapter.positions[id];
        return [
          id,
          position.fen,
          position.positionKey,
          position.turn,
          position.outgoingMoveIds,
        ];
      }),
    moves: Object.keys(chapter.moves)
      .sort()
      .map((id) => {
        const move = chapter.moves[id];
        return [
          id,
          move.fromNodeId,
          move.toNodeId,
          move.uci,
          move.order,
          move.trainingRole,
          move.cardId ?? null,
        ];
      }),
    lines: chapter.lines.map((line) => [
      line.id,
      line.moveIds,
      line.userCardIds,
      line.order,
    ]),
  });

  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < structure.length; index += 1) {
    const codeUnit = structure.charCodeAt(index);
    hash ^= BigInt(codeUnit & 0xff);
    hash = (hash * prime) & mask;
    hash ^= BigInt(codeUnit >>> 8);
    hash = (hash * prime) & mask;
  }
  return `trainer-v1:${structure.length}:${hash.toString(16).padStart(16, "0")}`;
}

function isPrefix(prefix: string[], full: string[]): boolean {
  return prefix.every((moveId, index) => full[index] === moveId);
}

function inputToUci(input: UserMoveInput): string {
  if (typeof input === "string") return input.trim().toLowerCase();
  return `${input.from}${input.to}${input.promotion ?? ""}`.toLowerCase();
}

export class ChapterTrainer {
  private readonly chapter: RepertoireChapter;
  private readonly chapterRevision: string;
  private readonly linesById: Map<string, TrainingLine>;
  private readonly pendingInitial: Set<string>;
  private readonly dirtyLineIds = new Set<string>();
  private readonly dirtyLineOrder: string[] = [];
  private readonly reviewQueue: string[] = [];
  private readonly attempts: TrainerAttempt[] = [];
  private readonly grades = new Map<string, GradeAccumulator>();

  private phase: TrainingPhase = "initial";
  private status: TrainerStatus = "idle";
  private currentNodeId: string;
  private scheduledLineId?: string;
  private routeLineId?: string;
  private actualMoveIds: string[] = [];
  private trialHadError = false;
  private trialHadAlternative = false;
  private promptHadError = false;
  private promptStartedAt = 0;
  private correction?: Correction;

  constructor(chapter: RepertoireChapter) {
    this.chapter = chapter;
    this.chapterRevision = trainerChapterRevision(chapter);
    this.currentNodeId = chapter.rootNodeId;
    this.linesById = new Map(chapter.lines.map((line) => [line.id, line]));
    this.pendingInitial = new Set(chapter.lines.map((line) => line.id));
    this.assertChapterIntegrity();
  }

  /**
   * Restores a checkpoint created by `exportSession`. The input may be the
   * structured-clone object itself or its JSON string representation.
   */
  static restoreSession(
    chapter: RepertoireChapter,
    checkpoint: unknown,
    now = Date.now(),
  ): ChapterTrainer {
    if (!Number.isFinite(now) || now < 0) {
      restoreError("INVALID_SNAPSHOT", "Restore time must be non-negative.");
    }

    const parsed = parseSerializedSession(checkpoint);
    if (parsed.chapterId !== chapter.id) {
      restoreError(
        "CHAPTER_MISMATCH",
        "The saved session belongs to a different chapter.",
      );
    }
    const trainer = new ChapterTrainer(chapter);
    if (parsed.chapterRevision !== trainer.chapterRevision) {
      restoreError(
        "STALE_CHAPTER",
        "The chapter moves changed after this session was saved.",
      );
    }

    trainer.restoreParsedState(parsed, now);
    return trainer;
  }

  start(now = Date.now()): TrainerTransition {
    if (this.status !== "idle") {
      throw new Error(`Cannot start a session in status ${this.status}.`);
    }
    const events: TrainerEvent[] = [];
    this.beginNextLine(events, now);
    return this.transition(events);
  }

  submitUserMove(input: UserMoveInput, now = Date.now()): TrainerTransition {
    if (this.status !== "awaiting-user") {
      throw new Error(`Cannot submit a move in status ${this.status}.`);
    }

    const events: TrainerEvent[] = [];
    const rawUci = inputToUci(input);
    const node = this.currentNode();
    const route = this.currentRoute();
    const targetMove = this.chapter.moves[route.moveIds[this.actualMoveIds.length]];
    const legalUci = this.toLegalUci(rawUci, node.fen);

    if (!legalUci) {
      this.recordAttempt(rawUci, "illegal", targetMove, now);
      events.push({ type: "illegal-move", playedUci: rawUci });
      return this.transition(events);
    }

    const accepted = this.compatibleNextMoveIds()
      .map((moveId) => this.chapter.moves[moveId])
      .find((move) => move.uci === legalUci);

    if (!accepted) {
      const knownAvoidMove = Object.values(this.chapter.moves).find(
        (move) =>
          move.fromNodeId === node.id &&
          move.trainingRole === "avoid" &&
          move.uci === legalUci,
      );
      if (!this.promptHadError) {
        this.promptHadError = true;
        this.trialHadError = true;
        this.markLineDirty(this.routeLineId!);
        if (targetMove.cardId) this.recordGrade(targetMove.cardId, "again", now);
      }
      this.recordAttempt(
        legalUci,
        knownAvoidMove ? "known-avoid" : "incorrect",
        targetMove,
        now,
        knownAvoidMove,
      );
      this.correction = {
        playedUci: legalUci,
        correctMove: this.toPromptMove(targetMove, true),
        acceptedMoves: this.acceptedPromptMoves(targetMove.id),
        knownAvoidMove: knownAvoidMove
          ? this.cloneMoveWithDedupedAnnotations(knownAvoidMove)
          : undefined,
      };
      this.status = "showing-correction";
      events.push({ type: "incorrect-move", correction: this.correction });
      return this.transition(events);
    }

    const alternative = accepted.id !== targetMove.id;
    const firstTry = !this.promptHadError;
    this.recordAttempt(
      accepted.uci,
      alternative ? "repertoire-alternative" : "target-correct",
      targetMove,
      now,
      accepted,
    );

    if (accepted.cardId && firstTry) {
      this.recordGrade(accepted.cardId, "good", now);
    }

    this.actualMoveIds.push(accepted.id);
    this.currentNodeId = accepted.toNodeId;
    this.correction = undefined;
    this.promptHadError = false;
    events.push({
      type: "user-move-accepted",
      move: accepted,
      alternative,
      firstTry,
      fen: this.currentNode().fen,
    });

    if (alternative) {
      this.trialHadAlternative = true;
      this.routeLineId = this.findCompatibleRoute(this.actualMoveIds).id;
    }

    this.pumpRoute(events, now);
    return this.transition(events);
  }

  acknowledgeCorrection(now = Date.now()): TrainerTransition {
    if (this.status !== "showing-correction") {
      throw new Error(`No correction can be acknowledged in status ${this.status}.`);
    }
    this.correction = undefined;
    this.status = "awaiting-user";
    this.promptStartedAt = now;
    return this.transition([{ type: "retry-requested" }]);
  }

  continue(now = Date.now()): TrainerTransition {
    if (this.status !== "line-complete") {
      throw new Error(`Cannot continue a session in status ${this.status}.`);
    }
    const events: TrainerEvent[] = [];
    this.beginNextLine(events, now);
    return this.transition(events);
  }

  /** Returns a deeply detached, JSON-safe checkpoint of this session. */
  exportSession(now = Date.now()): SerializedTrainerSession {
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError("Checkpoint time must be a finite non-negative number.");
    }

    const promptElapsedMs =
      this.status === "awaiting-user" || this.status === "showing-correction"
        ? Math.max(0, now - this.promptStartedAt)
        : 0;

    return {
      version: TRAINER_SESSION_VERSION,
      savedAt: now,
      chapterId: this.chapter.id,
      chapterRevision: this.chapterRevision,
      state: {
        phase: this.phase,
        status: this.status,
        currentNodeId: this.currentNodeId,
        scheduledLineId: this.scheduledLineId,
        routeLineId: this.routeLineId,
        actualMoveIds: [...this.actualMoveIds],
        pendingInitialLineIds: [...this.pendingInitial],
        dirtyLineOrder: [...this.dirtyLineOrder],
        reviewQueue: [...this.reviewQueue],
        trialHadError: this.trialHadError,
        trialHadAlternative: this.trialHadAlternative,
        promptHadError: this.promptHadError,
        promptElapsedMs,
        correctionPlayedUci: this.correction?.playedUci,
        attempts: this.getAttempts(),
        grades: this.getSessionCardGrades(),
      },
    };
  }

  getSnapshot(): TrainerSnapshot {
    const node = this.currentNode();
    const snapshot: TrainerSnapshot = {
      phase: this.phase,
      status: this.status,
      chapterId: this.chapter.id,
      repertoireColor: this.chapter.repertoireColor,
      currentNodeId: node.id,
      fen: node.fen,
      scheduledLineId: this.scheduledLineId,
      routeLineId: this.routeLineId,
      actualMoveIds: [...this.actualMoveIds],
      initialRemaining: this.pendingInitial.size,
      reviewRemaining:
        this.reviewQueue.length +
        (this.phase === "mistake-review" &&
        this.scheduledLineId &&
        this.status !== "line-complete"
          ? 1
          : 0),
      mistakeLineIds: [...this.dirtyLineOrder],
      correction: this.correction,
    };

    if (this.status === "awaiting-user") {
      const route = this.currentRoute();
      const target = this.chapter.moves[route.moveIds[this.actualMoveIds.length]];
      snapshot.prompt = {
        target: this.toPromptMove(target, true),
        acceptedMoves: this.acceptedPromptMoves(target.id),
        retry: this.promptHadError,
      };
    }
    return snapshot;
  }

  getAttempts(): TrainerAttempt[] {
    return this.attempts.map((attempt) => ({ ...attempt }));
  }

  getSessionCardGrades(): SessionCardGrade[] {
    return [...this.grades.values()].map((grade) => ({ ...grade }));
  }

  private restoreParsedState(
    checkpoint: SerializedTrainerSessionV1,
    now: number,
  ): void {
    const state = checkpoint.state;
    this.phase = state.phase;
    this.status = state.status;
    this.currentNodeId = state.currentNodeId;
    this.scheduledLineId = state.scheduledLineId;
    this.routeLineId = state.routeLineId;
    this.actualMoveIds = [...state.actualMoveIds];
    this.trialHadError = state.trialHadError;
    this.trialHadAlternative = state.trialHadAlternative;
    this.promptHadError = state.promptHadError;
    this.promptStartedAt = now - state.promptElapsedMs;
    if (!Number.isFinite(this.promptStartedAt)) {
      restoreError(
        "INVALID_SNAPSHOT",
        "The saved prompt duration is outside the supported range.",
      );
    }
    this.correction = undefined;

    this.pendingInitial.clear();
    for (const lineId of state.pendingInitialLineIds) {
      this.pendingInitial.add(lineId);
    }

    this.dirtyLineIds.clear();
    this.dirtyLineOrder.splice(0);
    for (const lineId of state.dirtyLineOrder) {
      this.dirtyLineIds.add(lineId);
      this.dirtyLineOrder.push(lineId);
    }

    this.reviewQueue.splice(0);
    this.reviewQueue.push(...state.reviewQueue);
    this.attempts.splice(0);
    this.attempts.push(...state.attempts.map((attempt) => ({ ...attempt })));
    this.grades.clear();
    const restoredGradeIds = new Set<string>();
    for (const grade of state.grades) {
      if (restoredGradeIds.has(grade.cardId)) {
        restoreError("INVALID_SNAPSHOT", "The saved card grades contain duplicates.");
      }
      restoredGradeIds.add(grade.cardId);
      this.grades.set(grade.cardId, { ...grade });
    }

    this.assertRestoredState(state.correctionPlayedUci, state.promptElapsedMs);
  }

  private assertRestoredState(
    correctionPlayedUci: string | undefined,
    promptElapsedMs: number,
  ): void {
    const invalid = (message: string): never =>
      restoreError("INVALID_SNAPSHOT", message);
    const knownLineIds = new Set(this.chapter.lines.map((line) => line.id));
    const knownCardIds = new Set(
      Object.values(this.chapter.moves)
        .map((move) => move.cardId)
        .filter((cardId): cardId is string => Boolean(cardId)),
    );

    const assertUniqueKnownLines = (lineIds: string[], field: string): void => {
      const seen = new Set<string>();
      for (const lineId of lineIds) {
        if (!knownLineIds.has(lineId)) {
          invalid(`${field} contains an unknown line.`);
        }
        if (seen.has(lineId)) {
          invalid(`${field} contains a duplicate line.`);
        }
        seen.add(lineId);
      }
    };

    assertUniqueKnownLines([...this.pendingInitial], "pendingInitialLineIds");
    assertUniqueKnownLines(this.dirtyLineOrder, "dirtyLineOrder");
    assertUniqueKnownLines(this.reviewQueue, "reviewQueue");
    for (const lineId of this.reviewQueue) {
      if (!this.dirtyLineIds.has(lineId)) {
        invalid("reviewQueue contains a line that was never marked for review.");
      }
    }

    if (this.phase === "initial" && this.reviewQueue.length > 0) {
      invalid("An initial-phase checkpoint cannot contain a review queue.");
    }
    if (this.phase !== "initial" && this.pendingInitial.size > 0) {
      invalid("A review or completed session cannot have initial lines pending.");
    }
    if (this.phase === "complete") {
      if (this.status !== "complete") {
        invalid("A completed phase must have completed status.");
      }
      if (this.reviewQueue.length > 0) {
        invalid("A completed session cannot have review lines pending.");
      }
      if (this.trialHadError || this.trialHadAlternative) {
        invalid("A completed session cannot have unfinished trial results.");
      }
    } else if (this.status === "complete") {
      invalid("Completed status requires the completed phase.");
    }

    const isActiveStatus =
      this.status === "awaiting-user" ||
      this.status === "showing-correction" ||
      this.status === "line-complete";
    if (isActiveStatus) {
      if (!this.scheduledLineId || !knownLineIds.has(this.scheduledLineId)) {
        invalid("The active scheduled line is missing or unknown.");
      }
      if (!this.routeLineId || !knownLineIds.has(this.routeLineId)) {
        invalid("The active route line is missing or unknown.");
      }
    } else if (this.scheduledLineId || this.routeLineId) {
      invalid("An idle or completed session cannot have an active line.");
    }

    if (this.status === "idle") {
      if (
        this.phase !== "initial" ||
        this.currentNodeId !== this.chapter.rootNodeId ||
        this.actualMoveIds.length > 0 ||
        this.pendingInitial.size !== this.chapter.lines.length ||
        this.dirtyLineOrder.length > 0 ||
        this.attempts.length > 0 ||
        this.grades.size > 0
      ) {
        invalid("The idle trainer state is inconsistent.");
      }
    }

    let pathLine: TrainingLine | undefined;
    if (this.routeLineId) {
      pathLine = this.linesById.get(this.routeLineId);
    } else if (this.status === "complete" && this.actualMoveIds.length > 0) {
      pathLine = this.chapter.lines.find(
        (line) =>
          line.moveIds.length === this.actualMoveIds.length &&
          isPrefix(this.actualMoveIds, line.moveIds),
      );
      if (!pathLine) {
        invalid("The completed move path does not belong to the chapter.");
      }
    }

    let expectedNodeId = this.chapter.rootNodeId;
    if (pathLine) {
      if (!isPrefix(this.actualMoveIds, pathLine.moveIds)) {
        invalid("The saved moves are not a prefix of the active route.");
      }
      for (const moveId of this.actualMoveIds) {
        const move = this.chapter.moves[moveId];
        if (!move || move.fromNodeId !== expectedNodeId) {
          invalid("The saved move path is not continuous.");
        }
        expectedNodeId = move.toNodeId;
      }
    } else if (this.actualMoveIds.length > 0) {
      invalid("Moves were saved without a corresponding training route.");
    }

    if (
      !this.chapter.positions[this.currentNodeId] ||
      this.currentNodeId !== expectedNodeId
    ) {
      invalid("The saved board position does not match its move path.");
    }

    if (this.status === "line-complete") {
      if (!pathLine || this.actualMoveIds.length !== pathLine.moveIds.length) {
        invalid("A completed line must end at the end of its route.");
      }
    } else if (
      (this.status === "awaiting-user" ||
        this.status === "showing-correction") &&
      (!pathLine || this.actualMoveIds.length >= pathLine.moveIds.length)
    ) {
      invalid("A prompt requires a remaining move on its route.");
    }

    const isPrompting =
      this.status === "awaiting-user" || this.status === "showing-correction";
    if (!isPrompting && promptElapsedMs !== 0) {
      invalid("Only an active prompt may have elapsed response time.");
    }
    if (!isPrompting && this.promptHadError) {
      invalid("Only an active prompt may be marked for retry.");
    }
    if (this.promptHadError && !this.trialHadError) {
      invalid("A retry prompt must belong to an errored line attempt.");
    }

    if (
      this.status === "idle" &&
      (this.trialHadError || this.trialHadAlternative)
    ) {
      invalid("An idle trainer cannot have trial results.");
    }

    if (this.status !== "complete" && this.trialHadAlternative) {
      if (!this.scheduledLineId || this.routeLineId === this.scheduledLineId) {
        invalid("An alternative route must differ from the scheduled line.");
      }
    } else if (
      this.scheduledLineId &&
      this.routeLineId &&
      this.routeLineId !== this.scheduledLineId
    ) {
      invalid("A changed route must be marked as an alternative.");
    }

    if (isPrompting) {
      const route = pathLine!;
      const target = this.chapter.moves[route.moveIds[this.actualMoveIds.length]];
      const node = this.currentNode();
      if (
        !target ||
        target.fromNodeId !== node.id ||
        node.turn !== colorToTurn(this.chapter.repertoireColor)
      ) {
        invalid("The restored prompt is not on the repertoire side to move.");
      }
    }

    if (this.status === "showing-correction") {
      if (!this.promptHadError) {
        invalid("A revealed correction must include its failed move.");
      }
      if (correctionPlayedUci === undefined) {
        invalid("A revealed correction must include its failed move.");
      }
      const playedUci = correctionPlayedUci as string;
      const legalUci = this.toLegalUci(playedUci, this.currentNode().fen);
      if (legalUci !== playedUci) {
        invalid("The saved correction move is not legal in its position.");
      }
      const route = pathLine!;
      const target = this.chapter.moves[route.moveIds[this.actualMoveIds.length]];
      const correctionIsAccepted = this.compatibleNextMoveIds().some(
        (moveId) => this.chapter.moves[moveId].uci === playedUci,
      );
      if (correctionIsAccepted) {
        invalid("A saved correction cannot be an accepted repertoire move.");
      }
      const knownAvoidMove = Object.values(this.chapter.moves).find(
        (move) =>
          move.fromNodeId === this.currentNodeId &&
          move.trainingRole === "avoid" &&
          move.uci === playedUci,
      );
      this.correction = {
        playedUci,
        correctMove: this.toPromptMove(target, true),
        acceptedMoves: this.acceptedPromptMoves(target.id),
        knownAvoidMove: knownAvoidMove
          ? this.cloneMoveWithDedupedAnnotations(knownAvoidMove)
          : undefined,
      };
    } else if (correctionPlayedUci !== undefined) {
      invalid("A correction move was saved without a revealed correction.");
    }

    for (const attempt of this.attempts) {
      const node = this.chapter.positions[attempt.nodeId];
      if (
        attempt.chapterId !== this.chapter.id ||
        !knownLineIds.has(attempt.scheduledLineId) ||
        !knownLineIds.has(attempt.routeLineId) ||
        !node ||
        node.positionKey !== attempt.positionKey ||
        (attempt.targetCardId !== undefined &&
          !knownCardIds.has(attempt.targetCardId)) ||
        (attempt.playedCardId !== undefined &&
          !knownCardIds.has(attempt.playedCardId))
      ) {
        invalid("The saved attempt history does not match this chapter.");
      }
    }

    for (const grade of this.grades.values()) {
      if (
        !knownCardIds.has(grade.cardId) ||
        grade.lastAttemptAt < grade.firstAttemptAt
      ) {
        invalid("The saved card grades are invalid for this chapter.");
      }
    }
  }

  private beginNextLine(events: TrainerEvent[], now: number): void {
    let nextLineId: string | undefined;

    if (this.phase === "initial") {
      nextLineId = this.chapter.lines.find((line) =>
        this.pendingInitial.has(line.id),
      )?.id;
      if (!nextLineId) {
        if (this.dirtyLineOrder.length === 0) {
          this.completeSession(events);
          return;
        }
        this.phase = "mistake-review";
        this.reviewQueue.push(...this.dirtyLineOrder);
        events.push({ type: "phase-changed", phase: this.phase });
        nextLineId = this.reviewQueue.shift();
      }
    } else if (this.phase === "mistake-review") {
      nextLineId = this.reviewQueue.shift();
      if (!nextLineId) {
        this.completeSession(events);
        return;
      }
    }

    if (!nextLineId) {
      this.completeSession(events);
      return;
    }

    this.scheduledLineId = nextLineId;
    this.routeLineId = nextLineId;
    this.currentNodeId = this.chapter.rootNodeId;
    this.actualMoveIds = [];
    this.trialHadError = false;
    this.trialHadAlternative = false;
    this.promptHadError = false;
    this.correction = undefined;
    events.push({ type: "line-started", phase: this.phase, lineId: nextLineId });
    this.pumpRoute(events, now);
  }

  private pumpRoute(events: TrainerEvent[], now: number): void {
    const route = this.currentRoute();
    if (this.actualMoveIds.length === route.moveIds.length) {
      this.finishLine(events);
      return;
    }

    const node = this.currentNode();
    const targetMove = this.chapter.moves[route.moveIds[this.actualMoveIds.length]];
    if (targetMove.fromNodeId !== node.id) {
      throw new Error("Training route and current position diverged.");
    }

    if (node.turn === colorToTurn(this.chapter.repertoireColor)) {
      this.status = "awaiting-user";
      this.promptStartedAt = now;
      events.push({
        type: "awaiting-user",
        target: this.toPromptMove(targetMove, true),
        acceptedMoves: this.acceptedPromptMoves(targetMove.id),
      });
      return;
    }

    this.actualMoveIds.push(targetMove.id);
    this.currentNodeId = targetMove.toNodeId;
    events.push({
      type: "opponent-move",
      move: targetMove,
      fen: this.currentNode().fen,
    });
    this.pumpRoute(events, now);
  }

  private finishLine(events: TrainerEvent[]): void {
    const scheduledLineId = this.scheduledLineId!;
    const routeLineId = this.routeLineId!;
    const clean = !this.trialHadError && !this.trialHadAlternative;

    if (this.phase === "initial") {
      this.pendingInitial.delete(routeLineId);
    } else if (!clean || routeLineId !== scheduledLineId) {
      this.reviewQueue.push(scheduledLineId);
    }

    this.status = "line-complete";
    events.push({
      type: "line-completed",
      scheduledLineId,
      actualLineId: routeLineId,
      clean,
    });
  }

  private completeSession(events: TrainerEvent[]): void {
    this.phase = "complete";
    this.status = "complete";
    this.scheduledLineId = undefined;
    this.routeLineId = undefined;
    events.push({ type: "phase-changed", phase: "complete" });
    events.push({ type: "session-completed" });
  }

  private findCompatibleRoute(actualMoveIds: string[]): TrainingLine {
    const orderedPools =
      this.phase === "initial"
        ? [
            this.chapter.lines.filter((line) => this.pendingInitial.has(line.id)),
            this.chapter.lines,
          ]
        : [
            this.chapter.lines.filter((line) => this.reviewQueue.includes(line.id)),
            this.chapter.lines,
          ];

    for (const pool of orderedPools) {
      const match = pool.find((line) => isPrefix(actualMoveIds, line.moveIds));
      if (match) return match;
    }
    throw new Error("A registered move has no compatible training line.");
  }

  private acceptedPromptMoves(targetMoveId: string): PromptMove[] {
    return this.compatibleNextMoveIds().map((moveId) =>
      this.toPromptMove(this.chapter.moves[moveId], moveId === targetMoveId),
    );
  }

  private compatibleNextMoveIds(): string[] {
    const nextIndex = this.actualMoveIds.length;
    const moveIds = new Set<string>();
    for (const line of this.chapter.lines) {
      if (!isPrefix(this.actualMoveIds, line.moveIds)) continue;
      const moveId = line.moveIds[nextIndex];
      if (
        moveId &&
        this.chapter.moves[moveId]?.trainingRole !== "avoid"
      ) {
        moveIds.add(moveId);
      }
    }
    return [...moveIds];
  }

  private cloneMoveWithDedupedAnnotations(
    move: RepertoireMove,
  ): RepertoireMove {
    return {
      ...move,
      annotations: {
        ...move.annotations,
        comments: [...new Set(move.annotations.comments)],
        nags: [...new Set(move.annotations.nags)],
        arrows: [...new Set(move.annotations.arrows)],
        squares: [...new Set(move.annotations.squares)],
      },
    };
  }

  private toPromptMove(move: RepertoireMove, scheduled: boolean): PromptMove {
    return {
      moveId: move.id,
      uci: move.uci,
      san: move.san,
      cardId: move.cardId,
      isScheduled: scheduled,
    };
  }

  private currentNode() {
    const node = this.chapter.positions[this.currentNodeId];
    if (!node) throw new Error(`Unknown repertoire node ${this.currentNodeId}.`);
    return node;
  }

  private currentRoute(): TrainingLine {
    const line = this.routeLineId
      ? this.linesById.get(this.routeLineId)
      : undefined;
    if (!line) throw new Error("There is no active training route.");
    return line;
  }

  private toLegalUci(rawUci: string, fen: string): string | undefined {
    const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(rawUci);
    if (!match) return undefined;
    const chess = new Chess(fen);
    try {
      const move = chess.move({
        from: match[1],
        to: match[2],
        promotion: match[3],
      });
      return `${move.from}${move.to}${move.promotion ?? ""}`;
    } catch {
      return undefined;
    }
  }

  private recordAttempt(
    playedUci: string,
    outcome: AttemptOutcome,
    targetMove: RepertoireMove,
    now: number,
    playedMove?: RepertoireMove,
  ): void {
    const node = this.currentNode();
    this.attempts.push({
      chapterId: this.chapter.id,
      phase: this.phase as Exclude<TrainingPhase, "complete">,
      scheduledLineId: this.scheduledLineId!,
      routeLineId: this.routeLineId!,
      nodeId: node.id,
      positionKey: node.positionKey,
      targetCardId: targetMove.cardId,
      playedCardId: playedMove?.cardId,
      playedUci,
      outcome,
      elapsedMs: Math.max(0, now - this.promptStartedAt),
      occurredAt: now,
    });
  }

  private recordGrade(
    cardId: string,
    grade: SessionSrsGrade,
    now: number,
  ): void {
    const elapsed = Math.max(0, now - this.promptStartedAt);
    const current = this.grades.get(cardId);
    if (!current) {
      this.grades.set(cardId, {
        cardId,
        grade,
        firstAttemptAt: now,
        lastAttemptAt: now,
        totalResponseMs: elapsed,
      });
      return;
    }
    current.lastAttemptAt = now;
    current.totalResponseMs += elapsed;
    if (grade === "again") current.grade = "again";
  }

  private markLineDirty(lineId: string): void {
    if (this.dirtyLineIds.has(lineId)) return;
    this.dirtyLineIds.add(lineId);
    this.dirtyLineOrder.push(lineId);
  }

  private transition(events: TrainerEvent[]): TrainerTransition {
    return { snapshot: this.getSnapshot(), events };
  }

  private assertChapterIntegrity(): void {
    if (!this.chapter.positions[this.chapter.rootNodeId]) {
      throw new Error("Chapter root node is missing.");
    }
    for (const line of this.chapter.lines) {
      let expectedNodeId = this.chapter.rootNodeId;
      for (const moveId of line.moveIds) {
        const move = this.chapter.moves[moveId];
        if (!move || move.fromNodeId !== expectedNodeId) {
          throw new Error(`Line ${line.id} is not a continuous legal route.`);
        }
        if (move.trainingRole === "avoid") {
          throw new Error(`Line ${line.id} contains an avoid move.`);
        }
        expectedNodeId = move.toNodeId;
      }
    }
  }
}
