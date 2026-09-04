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

function isPrefix(prefix: string[], full: string[]): boolean {
  return prefix.every((moveId, index) => full[index] === moveId);
}

function inputToUci(input: UserMoveInput): string {
  if (typeof input === "string") return input.trim().toLowerCase();
  return `${input.from}${input.to}${input.promotion ?? ""}`.toLowerCase();
}

export class ChapterTrainer {
  private readonly chapter: RepertoireChapter;
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
    this.currentNodeId = chapter.rootNodeId;
    this.linesById = new Map(chapter.lines.map((line) => [line.id, line]));
    this.pendingInitial = new Set(chapter.lines.map((line) => line.id));
    this.assertChapterIntegrity();
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
