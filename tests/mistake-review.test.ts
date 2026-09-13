import { describe, expect, it } from "vitest";

import {
  MISTAKE_REASON_COPY,
  assessResponseAfterOpponentUncovered,
  classifyReviewedMove,
  createLearnFromMistakesDrillItems,
  selectUserMovesForEngineReview,
  severityFromEvaluation,
  type EvaluatedReviewedMove,
  type GameRepertoireReview,
  type GradedMoveEvaluation,
  type ReviewedGameMove,
} from "../shared/index.js";

const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function reviewedMove(
  ply: number,
  uci: string,
  san: string,
  beforeFen = INITIAL_FEN,
  afterFen = INITIAL_FEN,
  userColor: "white" | "black" = "white",
): ReviewedGameMove {
  const mover = ply % 2 === 1 ? "white" : "black";
  return {
    ply,
    moveNumber: Math.ceil(ply / 2),
    mover,
    isUserMove: mover === userColor,
    uci,
    san,
    beforeFen,
    afterFen,
  };
}

function evaluation(
  move: ReviewedGameMove,
  centipawnLoss: number,
  options: Partial<GradedMoveEvaluation> = {},
): GradedMoveEvaluation {
  return {
    status: "graded",
    verdict: centipawnLoss <= 50 ? "pass" : "fail",
    passed: centipawnLoss <= 50,
    reason: centipawnLoss <= 50 ? "engine-within-threshold" : "engine-loss-too-large",
    move: { uci: move.uci, san: move.san },
    centipawnLoss,
    thresholdCp: 50,
    depth: 16,
    before: { depth: 16, score: { type: "cp", value: 20 } },
    after: { depth: 16, score: { type: "cp", value: 20 - centipawnLoss } },
    bestMoves: [{ uci: "d2d4", san: "d4", score: { type: "cp", value: 20 } }],
    ...options,
  };
}

function gameReview(
  moves: ReviewedGameMove[],
  overrides: Partial<GameRepertoireReview> = {},
): GameRepertoireReview {
  return {
    status: "opponent-uncovered",
    meta: {
      id: "game-42",
      url: "https://www.chess.com/game/live/game-42",
      playedAt: "2026-09-12T10:00:00.000Z",
      white: "user",
      black: "opponent",
      result: "*",
      userColor: "white",
    },
    initialFen: INITIAL_FEN,
    moves,
    matchedPlies: 2,
    matchedUserMoves: 1,
    match: undefined,
    matchingChapters: [],
    firstDeviation: {
      ply: 3,
      moveNumber: 2,
      mover: "white",
      played: { uci: moves[2]?.uci ?? "g1f3", san: moves[2]?.san ?? "Nf3" },
      expectedMoves: [],
      positionKey: "position",
      matchingChapters: [],
    },
    firstOpponentUncovered: undefined,
    firstUserDeviation: undefined,
    reviewPosition: undefined,
    ...overrides,
  };
}

describe("mistake review severity", () => {
  const move = reviewedMove(1, "e2e4", "e4");

  it.each([
    [0, "best"],
    [15, "best"],
    [16, "good"],
    [50, "good"],
    [51, "inaccuracy"],
    [100, "inaccuracy"],
    [101, "mistake"],
    [200, "mistake"],
    [201, "blunder"],
  ] as const)("maps %i centipawns to %s", (loss, expected) => {
    expect(severityFromEvaluation(evaluation(move, loss))).toBe(expected);
  });

  it("always treats an explicitly lost forced mate as a blunder", () => {
    const graded = evaluation(move, 0, {
      reason: "engine-forced-mate-lost",
      before: { depth: 18, score: { type: "mate", value: 3 } },
      after: { depth: 18, score: { type: "cp", value: 500 } },
    });
    const classified = classifyReviewedMove(move, graded);

    expect(classified).toMatchObject({
      severity: "blunder",
      theme: "tactical",
      themeBasis: "forced-mate",
      reasonKey: "forced-mate-lost",
      meaningfulError: true,
    });
    expect(classified.reason).toEqual(MISTAKE_REASON_COPY["forced-mate-lost"]);
  });

  it("rejects invalid losses and mismatched move evaluations", () => {
    expect(() => severityFromEvaluation(evaluation(move, Number.NaN))).toThrow(/centipawnLoss/);
    expect(() =>
      classifyReviewedMove(move, evaluation({ ...move, uci: "d2d4", san: "d4" }, 10)),
    ).toThrow(/does not match/);
  });
});

describe("conservative theme classification", () => {
  it("recognizes a legal capture/check in the best move as tactical", () => {
    const fen = "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 4";
    const move = reviewedMove(7, "f7e7", "Qe7+", fen);
    const graded = evaluation(move, 250, {
      bestMoves: [{ uci: "f7f8", san: "Qxf8#", score: { type: "mate", value: 1 } }],
    });

    expect(classifyReviewedMove(move, graded)).toMatchObject({
      severity: "blunder",
      theme: "tactical",
      themeBasis: "mate-line",
      reasonKey: "missed-tactical-chance",
    });
  });

  it("recognizes a forcing best move from board traits even without SAN", () => {
    const fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    const move = reviewedMove(3, "g1f3", "Nf3", fen);
    const graded = evaluation(move, 120, {
      bestMoves: [{ uci: "d1h5", score: { type: "cp", value: 80 } }],
    });

    expect(classifyReviewedMove(move, graded)).toMatchObject({
      theme: "strategic",
      themeBasis: "quiet-best-move",
    });

    const captureFen = "rnbqkbnr/pppp1ppp/8/4p3/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2";
    const blackMove = reviewedMove(4, "g8f6", "Nf6", captureFen, INITIAL_FEN, "black");
    const captureGrade = evaluation(blackMove, 120, {
      bestMoves: [{ uci: "e5d4", score: { type: "cp", value: 30 } }],
    });
    expect(classifyReviewedMove(blackMove, captureGrade)).toMatchObject({
      theme: "tactical",
      themeBasis: "forcing-best-move",
    });
  });

  it("uses a forcing PV only when it contains repeated forcing play", () => {
    const move = reviewedMove(1, "g1f3", "Nf3");
    const graded = evaluation(move, 110, {
      bestMoves: [
        {
          uci: "e2e4",
          san: "e4",
          score: { type: "cp", value: 30 },
          pv: ["e2e4", "d7d5", "e4d5", "d8d5"],
        },
      ],
    });

    expect(classifyReviewedMove(move, graded)).toMatchObject({
      theme: "tactical",
      themeBasis: "forcing-pv",
    });
  });

  it("presents a quiet recommendation as a strategy candidate only for a meaningful error", () => {
    const move = reviewedMove(1, "e2e4", "e4");
    const mistake = evaluation(move, 110, {
      bestMoves: [{ uci: "d2d4", san: "d4", score: { type: "cp", value: 25 } }],
    });
    const good = evaluation(move, 30, {
      bestMoves: [{ uci: "d2d4", san: "d4", score: { type: "cp", value: 25 } }],
    });

    expect(classifyReviewedMove(move, mistake)).toMatchObject({
      theme: "strategic",
      themeLabel: "전략 후보",
      themeBasis: "quiet-best-move",
      reasonKey: "strategic-concession",
      reason: {
        title: "전략적으로 검토할 후보",
      },
    });
    expect(classifyReviewedMove(move, good)).toMatchObject({
      theme: "general",
      themeBasis: "insufficient-evidence",
      reasonKey: "sound-alternative",
    });
  });

  it("does not infer a tactical or strategic cause without best-line evidence", () => {
    const move = reviewedMove(1, "e2e4", "e4+");
    const graded = evaluation(move, 170, { bestMoves: [] });

    expect(classifyReviewedMove(move, graded)).toMatchObject({
      theme: "general",
      themeBasis: "insufficient-evidence",
      reasonKey: "general-mistake",
    });
  });
});

describe("full-game engine review selection", () => {
  const moves = [
    reviewedMove(1, "e2e4", "e4"),
    reviewedMove(2, "e7e5", "e5"),
    reviewedMove(3, "g1f3", "Nf3"),
    reviewedMove(4, "b8c6", "Nc6"),
    reviewedMove(5, "f1b5", "Bb5"),
    reviewedMove(6, "a7a6", "a6"),
  ];

  it("includes every user move around a user's repertoire deviation", () => {
    const review = gameReview(moves, { status: "user-deviation", matchedPlies: 2 });
    expect(selectUserMovesForEngineReview(review).map((move) => move.ply)).toEqual([1, 3, 5]);
  });

  it("keeps moves before and after an uncovered opponent move", () => {
    const review = gameReview(moves, { status: "opponent-uncovered", matchedPlies: 3 });
    expect(selectUserMovesForEngineReview(review).map((move) => move.ply)).toEqual([1, 3, 5]);
  });

  it("analyzes every user move whether the game is unmatched or fully covered", () => {
    const noMatch = gameReview(moves, { status: "no-matching-repertoire", matchedPlies: 0 });
    const covered = gameReview(moves, { status: "in-repertoire", matchedPlies: moves.length });
    expect(selectUserMovesForEngineReview(noMatch).map((move) => move.ply)).toEqual([1, 3, 5]);
    expect(selectUserMovesForEngineReview(covered).map((move) => move.ply)).toEqual([1, 3, 5]);
  });
});

describe("first uncovered opponent response", () => {
  const fenAfterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const fenAfterC5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  const moves = [
    reviewedMove(1, "e2e4", "e4", INITIAL_FEN, fenAfterE4),
    reviewedMove(2, "c7c5", "c5", fenAfterE4, fenAfterC5),
    reviewedMove(3, "g1f3", "Nf3", fenAfterC5),
  ];
  const review = gameReview(moves, {
    matchedPlies: 1,
    firstOpponentUncovered: {
      ply: 2,
      moveNumber: 1,
      mover: "black",
      played: { uci: "c7c5", san: "c5" },
      expectedMoves: [{ uci: "e7e5", san: "e5" }],
      positionKey: "after-e4",
      matchingChapters: [],
    },
  });

  it.each([
    [5, "strong"],
    [30, "solid"],
    [51, "missed-chance"],
    [150, "missed-chance"],
  ] as const)("maps a %i cp response to %s", (loss, expected) => {
    const response = moves[2];
    const assessed = assessResponseAfterOpponentUncovered(review, [
      { move: response, evaluation: evaluation(response, loss) },
    ]);

    expect(assessed).toMatchObject({
      kind: expected,
      opponentMove: { ply: 2 },
      responseMove: { ply: 3 },
      review: { severity: severityFromEvaluation(evaluation(response, loss)) },
    });
  });

  it("returns undefined without the exact response evaluation", () => {
    expect(assessResponseAfterOpponentUncovered(review, [])).toBeUndefined();
    expect(
      assessResponseAfterOpponentUncovered(
        { ...review, firstOpponentUncovered: undefined },
        [],
      ),
    ).toBeUndefined();
  });
});

describe("learn-from-mistakes drill items", () => {
  const fenAfterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const fenAfterE5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  const fenAfterNf3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
  const fenAfterNc6 = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
  const moves = [
    reviewedMove(1, "e2e4", "e4", INITIAL_FEN, fenAfterE4),
    reviewedMove(2, "e7e5", "e5", fenAfterE4, fenAfterE5),
    reviewedMove(3, "g1f3", "Nf3", fenAfterE5, fenAfterNf3),
    reviewedMove(4, "b8c6", "Nc6", fenAfterNf3, fenAfterNc6),
    reviewedMove(5, "f1c4", "Bc4", fenAfterNc6),
  ];
  const review = gameReview(moves, { status: "user-deviation", matchedPlies: 2 });

  it("creates replayable items for meaningful errors across the entire game", () => {
    const evaluated: EvaluatedReviewedMove[] = [
      { move: moves[0], evaluation: evaluation(moves[0], 300) },
      { move: moves[2], evaluation: evaluation(moves[2], 30) },
      {
        move: moves[4],
        evaluation: evaluation(moves[4], 120, {
          bestMoves: [
            { uci: "f1b5", san: "Bb5", score: { type: "cp", value: 35 } },
            { uci: "f1b5", san: "Bb5", score: { type: "cp", value: 34 } },
            { uci: "z9z9", san: "invalid", score: { type: "cp", value: 33 } },
          ],
        }),
      },
    ];

    const items = createLearnFromMistakesDrillItems(review, evaluated);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      source: "engine-review",
      id: "engine-review:game-42:1",
      gameId: "game-42",
      ply: 1,
      fen: INITIAL_FEN,
      playedMove: { uci: "e2e4", san: "e4" },
      severity: "blunder",
      theme: "strategic",
      themeLabel: "전략 후보",
      reasonKey: "strategic-concession",
      recommendedMoves: [{ uci: "d2d4", san: "d4" }],
    });
    expect(items[1]).toMatchObject({
      source: "engine-review",
      id: "engine-review:game-42:5",
      gameId: "game-42",
      ply: 5,
      fen: fenAfterNc6,
      playedMove: { uci: "f1c4", san: "Bc4" },
      severity: "mistake",
      theme: "strategic",
      themeLabel: "전략 후보",
      reasonKey: "strategic-concession",
      recommendedMoves: [{ uci: "f1b5", san: "Bb5" }],
    });
    expect(items.every((item) => Boolean(item.positionKey))).toBe(true);
  });

  it("omits errors when no distinct legal recommendation is available", () => {
    const target = moves[2];
    const sameMove = evaluation(target, 150, {
      bestMoves: [
        { uci: target.uci, san: target.san, score: { type: "cp", value: 20 } },
        { uci: "a1a8", san: "Ra8", score: { type: "cp", value: 19 } },
      ],
    });

    expect(
      createLearnFromMistakesDrillItems(review, [{ move: target, evaluation: sameMove }]),
    ).toEqual([]);
  });
});
