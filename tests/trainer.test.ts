import { describe, expect, it } from "vitest";

import {
  ChapterTrainer,
  importLichessStudyPgn,
  type RepertoireChapter,
  TrainerSessionRestoreError,
  type TrainerSessionRestoreErrorCode,
  type TrainerTransition,
} from "../shared/index.js";

function makeChapter(moves: string, orientation: "white" | "black" = "white") {
  const pgn = `[Event "Trainer fixture"]
[Site "https://lichess.org/study/trainer/chapter"]
[ChapterURL "https://lichess.org/study/trainer/chapter"]
[Orientation "${orientation}"]
[Result "*"]

${moves}`;
  return importLichessStudyPgn(pgn).chapters[0];
}

function expectPrompt(
  transition: TrainerTransition,
  uci: string,
): TrainerTransition {
  expect(transition.snapshot.status).toBe("awaiting-user");
  expect(transition.snapshot.prompt?.target.uci).toBe(uci);
  return transition;
}

function playCurrentLineCleanly(
  trainer: ChapterTrainer,
  chapter: RepertoireChapter,
  now: number,
): TrainerTransition {
  let transition: TrainerTransition = {
    snapshot: trainer.getSnapshot(),
    events: [],
  };
  while (transition.snapshot.status === "awaiting-user") {
    transition = trainer.submitUserMove(
      transition.snapshot.prompt!.target.uci,
      ++now,
    );
  }
  expect(transition.snapshot.status).toBe("line-complete");
  expect(chapter.lines.length).toBeGreaterThan(0);
  return transition;
}

function expectRestoreError(
  restore: () => unknown,
  code: TrainerSessionRestoreErrorCode,
): void {
  try {
    restore();
    throw new Error("Expected restore to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(TrainerSessionRestoreError);
    expect((error as TrainerSessionRestoreError).code).toBe(code);
  }
}

describe("ChapterTrainer", () => {
  it("prompts White and automatically plays the opponent continuation", () => {
    const trainer = new ChapterTrainer(makeChapter("1. e4 e5 2. Nf3 Nc6 *"));

    expectPrompt(trainer.start(100), "e2e4");
    const afterE4 = expectPrompt(trainer.submitUserMove("e2e4", 150), "g1f3");
    expect(afterE4.events.map((event) => event.type)).toEqual([
      "user-move-accepted",
      "opponent-move",
      "awaiting-user",
    ]);
    const finish = trainer.submitUserMove(
      { from: "g1", to: "f3" },
      200,
    );
    expect(finish.snapshot.status).toBe("line-complete");
    expect(finish.events.map((event) => event.type)).toEqual([
      "user-move-accepted",
      "opponent-move",
      "line-completed",
    ]);
    expect(trainer.continue(201).snapshot).toMatchObject({
      phase: "complete",
      status: "complete",
    });
  });

  it("automatically plays White before prompting a Black repertoire", () => {
    const trainer = new ChapterTrainer(
      makeChapter("1. e4 c5 2. Nf3 d6 *", "black"),
    );

    const start = expectPrompt(trainer.start(100), "c7c5");
    expect(start.events.map((event) => event.type)).toEqual([
      "line-started",
      "opponent-move",
      "awaiting-user",
    ]);
    expectPrompt(trainer.submitUserMove("c7c5", 120), "d7d6");
  });

  it("reveals a correction without changing position, then retries it", () => {
    const chapter = makeChapter("1. e4 e5 2. Nf3 Nc6 *");
    const trainer = new ChapterTrainer(chapter);
    const initial = expectPrompt(trainer.start(1_000), "e2e4");
    const originalFen = initial.snapshot.fen;

    const wrong = trainer.submitUserMove("d2d4", 1_250);
    expect(wrong.snapshot).toMatchObject({
      phase: "initial",
      status: "showing-correction",
      fen: originalFen,
      correction: {
        playedUci: "d2d4",
        correctMove: { uci: "e2e4" },
      },
    });
    expect(wrong.events[0].type).toBe("incorrect-move");

    const retry = expectPrompt(trainer.acknowledgeCorrection(1_300), "e2e4");
    expect(retry.snapshot.prompt?.retry).toBe(true);
    expect(retry.snapshot.fen).toBe(originalFen);
    const accepted = expectPrompt(
      trainer.submitUserMove("e2e4", 1_400),
      "g1f3",
    );
    expect(accepted.events[0]).toMatchObject({
      type: "user-move-accepted",
      firstTry: false,
    });

    trainer.submitUserMove("g1f3", 1_500);
    const review = expectPrompt(trainer.continue(1_600), "e2e4");
    expect(review.snapshot).toMatchObject({
      phase: "mistake-review",
      reviewRemaining: 1,
    });
    playCurrentLineCleanly(trainer, chapter, 1_700);
    expect(trainer.continue(1_800).snapshot).toMatchObject({
      phase: "complete",
      status: "complete",
    });

    const cardId = chapter.lines[0].userCardIds[0];
    expect(trainer.getSessionCardGrades()).toContainEqual(
      expect.objectContaining({ cardId, grade: "again" }),
    );
  });

  it("reveals known avoid annotations without moving, then retries and reviews", () => {
    const chapter = makeChapter(
      "1. e4 (1. d4 $2 {Do not play this.}) e5 *",
    );
    const trainer = new ChapterTrainer(chapter);
    const start = expectPrompt(trainer.start(1_000), "e2e4");
    const originalFen = start.snapshot.fen;

    expect(start.snapshot.prompt?.acceptedMoves.map((move) => move.uci)).toEqual([
      "e2e4",
    ]);
    const avoided = trainer.submitUserMove("d2d4", 1_100);
    expect(avoided.snapshot).toMatchObject({
      status: "showing-correction",
      fen: originalFen,
      correction: {
        playedUci: "d2d4",
        correctMove: { uci: "e2e4" },
        knownAvoidMove: {
          uci: "d2d4",
          trainingRole: "avoid",
          cardId: undefined,
          annotations: {
            nags: ["$2"],
            comments: ["Do not play this."],
          },
        },
      },
    });
    expect(avoided.snapshot.correction?.acceptedMoves.map((move) => move.uci)).toEqual([
      "e2e4",
    ]);
    expect(trainer.getAttempts()[0]).toMatchObject({
      playedUci: "d2d4",
      outcome: "known-avoid",
      playedCardId: undefined,
    });

    const retry = expectPrompt(trainer.acknowledgeCorrection(1_200), "e2e4");
    expect(retry.snapshot).toMatchObject({
      fen: originalFen,
      prompt: { retry: true },
      mistakeLineIds: [chapter.lines[0].id],
    });
    expect(trainer.submitUserMove("e2e4", 1_300).snapshot.status).toBe(
      "line-complete",
    );

    const review = expectPrompt(trainer.continue(1_400), "e2e4");
    expect(review.snapshot).toMatchObject({
      phase: "mistake-review",
      reviewRemaining: 1,
    });
    trainer.submitUserMove("e2e4", 1_500);
    expect(trainer.continue(1_600).snapshot.status).toBe("complete");
  });

  it("accepts a registered repertoire branch and leaves the scheduled line pending", () => {
    const chapter = makeChapter("1. e4 (1. d4 d5) e5 *");
    const trainer = new ChapterTrainer(chapter);
    const start = expectPrompt(trainer.start(100), "e2e4");
    expect(start.snapshot.prompt?.acceptedMoves.map((move) => move.uci)).toEqual([
      "e2e4",
      "d2d4",
    ]);

    const alternative = trainer.submitUserMove("d2d4", 110);
    expect(alternative.events).toContainEqual(
      expect.objectContaining({
        type: "user-move-accepted",
        alternative: true,
      }),
    );
    expect(alternative.snapshot).toMatchObject({
      status: "line-complete",
      initialRemaining: 1,
    });
    const alternativeMove = chapter.moves[alternative.snapshot.actualMoveIds[0]];
    expect(trainer.getSessionCardGrades()).toContainEqual(
      expect.objectContaining({ cardId: alternativeMove.cardId, grade: "good" }),
    );
    expect(trainer.getAttempts()[0]).toMatchObject({
      outcome: "repertoire-alternative",
      playedCardId: alternativeMove.cardId,
    });

    const original = expectPrompt(trainer.continue(120), "e2e4");
    expect(original.snapshot.initialRemaining).toBe(1);
    expect(trainer.submitUserMove("e2e4", 130).snapshot.status).toBe(
      "line-complete",
    );
    expect(trainer.continue(140).snapshot.status).toBe("complete");
  });

  it("does not count illegal board input as a learning lapse", () => {
    const chapter = makeChapter("1. e4 e5 *");
    const trainer = new ChapterTrainer(chapter);
    const initial = trainer.start(100).snapshot;
    const illegal = trainer.submitUserMove("e2e5", 150);

    expect(illegal.events).toEqual([
      { type: "illegal-move", playedUci: "e2e5" },
    ]);
    expect(illegal.snapshot).toMatchObject({
      status: "awaiting-user",
      currentNodeId: initial.currentNodeId,
      fen: initial.fen,
    });
    expect(illegal.snapshot.mistakeLineIds).toEqual([]);
    expect(trainer.getSessionCardGrades()).toEqual([]);
    expect(trainer.getAttempts()[0].outcome).toBe("illegal");
  });

  it("requeues an errored mistake-review line until it is completed cleanly", () => {
    const chapter = makeChapter("1. e4 e5 *");
    const trainer = new ChapterTrainer(chapter);
    trainer.start(0);
    trainer.submitUserMove("d2d4", 10);
    trainer.acknowledgeCorrection(20);
    trainer.submitUserMove("e2e4", 30);
    expectPrompt(trainer.continue(40), "e2e4");

    trainer.submitUserMove("d2d4", 50);
    trainer.acknowledgeCorrection(60);
    trainer.submitUserMove("e2e4", 70);
    const repeated = expectPrompt(trainer.continue(80), "e2e4");
    expect(repeated.snapshot).toMatchObject({
      phase: "mistake-review",
      reviewRemaining: 1,
    });

    trainer.submitUserMove("e2e4", 90);
    expect(trainer.getSnapshot().reviewRemaining).toBe(0);
    expect(trainer.continue(100).snapshot.status).toBe("complete");
  });

  it("restores a mid-line prompt with attempts, grades, and paused response time", () => {
    const chapter = makeChapter("1. e4 e5 2. Nf3 Nc6 *");
    const trainer = new ChapterTrainer(chapter);
    trainer.start(100);
    const beforeSave = expectPrompt(trainer.submitUserMove("e2e4", 150), "g1f3");

    const checkpoint = trainer.exportSession(180);
    const restored = ChapterTrainer.restoreSession(
      chapter,
      JSON.stringify(checkpoint),
      1_000,
    );

    expect(restored.getSnapshot()).toEqual(beforeSave.snapshot);
    expect(restored.getAttempts()).toEqual(trainer.getAttempts());
    expect(restored.getSessionCardGrades()).toEqual(
      trainer.getSessionCardGrades(),
    );

    const finished = restored.submitUserMove("g1f3", 1_050);
    expect(finished.snapshot.status).toBe("line-complete");
    expect(restored.getAttempts().at(-1)).toMatchObject({
      playedUci: "g1f3",
      outcome: "target-correct",
      elapsedMs: 80,
    });
    expect(restored.continue(1_060).snapshot.status).toBe("complete");
  });

  it("restores a revealed correction and keeps the mandatory retry", () => {
    const chapter = makeChapter(
      "1. e4 (1. d4 $2 {Original warning.}) e5 2. Nf3 Nc6 *",
    );
    const trainer = new ChapterTrainer(chapter);
    trainer.start(100);
    trainer.submitUserMove("d2d4", 120);
    const checkpoint = trainer.exportSession(130);

    const refreshedChapter = structuredClone(chapter);
    const avoidMove = Object.values(refreshedChapter.moves).find(
      (move) => move.trainingRole === "avoid",
    )!;
    avoidMove.annotations.comments = ["Updated warning."];
    refreshedChapter.name = "Renamed chapter";

    const restored = ChapterTrainer.restoreSession(
      refreshedChapter,
      checkpoint,
      1_000,
    );
    expect(restored.getSnapshot()).toMatchObject({
      status: "showing-correction",
      correction: {
        playedUci: "d2d4",
        knownAvoidMove: {
          annotations: { comments: ["Updated warning."] },
        },
      },
    });

    const retry = restored.acknowledgeCorrection(1_010);
    expect(retry.snapshot.prompt).toMatchObject({
      retry: true,
      target: { uci: "e2e4" },
    });
    expectPrompt(restored.submitUserMove("e2e4", 1_020), "g1f3");
    expect(restored.getSessionCardGrades()[0].grade).toBe("again");
  });

  it("restores all dirty lines and the remaining mistake-review queue", () => {
    const chapter = makeChapter("1. e4 (1. d4 d5) e5 *");
    let trainer = new ChapterTrainer(chapter);
    trainer.start(0);

    trainer.submitUserMove("c2c4", 10);
    trainer.acknowledgeCorrection(20);
    trainer.submitUserMove("e2e4", 30);
    expectPrompt(trainer.continue(40), "d2d4");
    trainer.submitUserMove("c2c4", 50);
    trainer.acknowledgeCorrection(60);
    trainer.submitUserMove("d2d4", 70);

    trainer = ChapterTrainer.restoreSession(chapter, trainer.exportSession(75), 100);
    const firstReview = expectPrompt(trainer.continue(110), "e2e4");
    expect(firstReview.snapshot).toMatchObject({
      phase: "mistake-review",
      reviewRemaining: 2,
      mistakeLineIds: chapter.lines.map((line) => line.id),
    });
    trainer.submitUserMove("e2e4", 120);

    trainer = ChapterTrainer.restoreSession(chapter, trainer.exportSession(125), 200);
    const secondReview = expectPrompt(trainer.continue(210), "d2d4");
    expect(secondReview.snapshot).toMatchObject({
      phase: "mistake-review",
      reviewRemaining: 1,
    });
    trainer.submitUserMove("d2d4", 220);
    expect(trainer.continue(230).snapshot.status).toBe("complete");
  });

  it("restores an in-progress repertoire alternative without changing its semantics", () => {
    const chapter = makeChapter(
      "1. e4 e5 2. Nf3 (2. Bc4 Nc6 3. Nf3) Nc6 *",
    );
    const trainer = new ChapterTrainer(chapter);
    trainer.start(100);
    expectPrompt(trainer.submitUserMove("e2e4", 110), "g1f3");
    const alternative = expectPrompt(
      trainer.submitUserMove("f1c4", 120),
      "g1f3",
    );
    expect(alternative.events[0]).toMatchObject({
      type: "user-move-accepted",
      alternative: true,
    });
    expect(alternative.snapshot.routeLineId).not.toBe(
      alternative.snapshot.scheduledLineId,
    );

    const restored = ChapterTrainer.restoreSession(
      chapter,
      trainer.exportSession(130),
      1_000,
    );
    expect(restored.getSnapshot()).toEqual(alternative.snapshot);
    expect(restored.submitUserMove("g1f3", 1_010).snapshot).toMatchObject({
      status: "line-complete",
      initialRemaining: 1,
    });
  });

  it("restores idle and completed sessions after an earlier alternative", () => {
    const chapter = makeChapter("1. e4 (1. d4 d5) e5 *");
    let trainer = new ChapterTrainer(chapter);

    expect(
      ChapterTrainer.restoreSession(chapter, trainer.exportSession(10), 100)
        .getSnapshot(),
    ).toEqual(trainer.getSnapshot());

    trainer.start(110);
    trainer.submitUserMove("d2d4", 120);
    trainer.continue(130);
    trainer.submitUserMove("e2e4", 140);
    trainer.continue(150);

    expect(trainer.getSnapshot()).toMatchObject({
      phase: "complete",
      status: "complete",
    });
    const restored = ChapterTrainer.restoreSession(
      chapter,
      JSON.stringify(trainer.exportSession(160)),
      1_000,
    );
    expect(restored.getSnapshot()).toEqual(trainer.getSnapshot());
    expect(restored.getAttempts()).toEqual(trainer.getAttempts());
    expect(restored.getSessionCardGrades()).toEqual(
      trainer.getSessionCardGrades(),
    );
  });

  it("rejects mismatched, stale, unsupported, and corrupt checkpoints", () => {
    const chapter = makeChapter("1. e4 e5 2. Nf3 Nc6 *");
    const trainer = new ChapterTrainer(chapter);
    trainer.start(100);
    const checkpoint = trainer.exportSession(110);

    const otherChapter = structuredClone(chapter);
    otherChapter.id = "another-chapter";
    expectRestoreError(
      () => ChapterTrainer.restoreSession(otherChapter, checkpoint),
      "CHAPTER_MISMATCH",
    );

    const structurallyChanged = structuredClone(chapter);
    const firstMove = structurallyChanged.moves[
      structurallyChanged.lines[0].moveIds[0]
    ];
    firstMove.uci = "d2d4";
    expectRestoreError(
      () => ChapterTrainer.restoreSession(structurallyChanged, checkpoint),
      "STALE_CHAPTER",
    );

    expectRestoreError(
      () => ChapterTrainer.restoreSession(chapter, { ...checkpoint, version: 2 }),
      "UNSUPPORTED_VERSION",
    );

    const corrupt = structuredClone(checkpoint);
    corrupt.state.currentNodeId = "missing-node";
    expectRestoreError(
      () => ChapterTrainer.restoreSession(chapter, corrupt),
      "INVALID_SNAPSHOT",
    );
    expectRestoreError(
      () => ChapterTrainer.restoreSession(chapter, "{not json"),
      "INVALID_SNAPSHOT",
    );
  });
});
