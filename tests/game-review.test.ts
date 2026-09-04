import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";

import {
  GameReviewError,
  identifyUserColor,
  importLichessStudyPgn,
  reviewGameAgainstRepertoire,
  type GameReviewInput,
  type RepertoireStudy,
} from "../shared/index.js";

function repertoire(
  moves: string,
  options: {
    studyId?: string;
    chapterId?: string;
    orientation?: "white" | "black";
    fen?: string;
    chapterName?: string;
  } = {},
): RepertoireStudy {
  const studyId = options.studyId ?? "study-a";
  const chapterId = options.chapterId ?? "chapter-a";
  const headers: Record<string, string> = {
    Event: "Repertoire fixture",
    Site: `https://lichess.org/study/${studyId}/${chapterId}`,
    StudyName: `Study ${studyId}`,
    ChapterName: options.chapterName ?? `Chapter ${chapterId}`,
    ChapterURL: `https://lichess.org/study/${studyId}/${chapterId}`,
    Orientation: options.orientation ?? "white",
    Result: "*",
  };
  if (options.fen) {
    headers.Variant = "From Position";
    headers.SetUp = "1";
    headers.FEN = options.fen;
  }
  const pgn = `${Object.entries(headers)
    .map(([key, value]) => `[${key} "${value}"]`)
    .join("\n")}\n\n${moves}`;
  return importLichessStudyPgn(pgn);
}

function game(
  moves: string,
  options: Partial<GameReviewInput> = {},
): GameReviewInput {
  const white = options.white ?? {
    username: "Yshaarrj",
    rating: 2100,
    result: "win",
  };
  const black = options.black ?? {
    username: "Opponent",
    rating: 2050,
    result: "resigned",
  };
  const result = options.pgn?.match(/^\[Result\s+"([^"]+)"\]/imu)?.[1]
    ?? (white.result === "win" ? "1-0" : black.result === "win" ? "0-1" : "*");
  const pgn = options.pgn ?? [
    '[Event "Chess.com game"]',
    '[Site "https://www.chess.com/game/live/123"]',
    '[Date "2026.08.31"]',
    `[White "${white.username}"]`,
    `[Black "${black.username}"]`,
    `[Result "${result}"]`,
    '[ECO "B90"]',
    '[ECOUrl "https://www.chess.com/openings/Sicilian-Defense-Najdorf-Variation"]',
    "",
    moves,
  ].join("\n");

  return {
    id: options.id ?? "game-123",
    url: options.url ?? "https://www.chess.com/game/live/123",
    pgn,
    endTime: options.endTime,
    playedAt: options.playedAt,
    timeClass: options.timeClass ?? "rapid",
    timeControl: options.timeControl ?? "600",
    rated: options.rated ?? true,
    rules: options.rules ?? "chess",
    initialFen: options.initialFen,
    white,
    black,
  };
}

describe("Chess.com repertoire game review", () => {
  it("identifies the user case-insensitively and reports their first deviation", () => {
    const source = repertoire("1. e4 c5 2. Nf3 d6 3. d4 *");
    const input = game("1. e4 c5 2. Nf3 d6 3. Bb5+ 1-0", {
      endTime: 1_788_134_400,
    });

    expect(identifyUserColor(input, "  ySHAARRJ ")).toBe("white");
    const review = reviewGameAgainstRepertoire(
      input,
      "ySHAARRJ",
      [source],
    );

    expect(review).toMatchObject({
      status: "user-deviation",
      matchedPlies: 4,
      matchedUserMoves: 2,
      meta: {
        id: "game-123",
        userColor: "white",
        opponent: { username: "Opponent", rating: 2050 },
        result: "win",
        timeClass: "rapid",
        eco: "B90",
        opening: "Sicilian Defense Najdorf Variation",
        playedAt: "2026-08-31T00:00:00.000Z",
      },
      firstDeviation: {
        kind: "user-deviation",
        reason: "move-not-covered",
        ply: 5,
        played: { uci: "f1b5", san: "Bb5+", isUserMove: true },
        expectedMoves: [{ uci: "d2d4", san: "d4" }],
      },
      firstUserDeviation: { ply: 5 },
      reviewPosition: {
        correctMoves: [{ uci: "d2d4" }],
      },
    });
    expect(review.firstOpponentUncovered).toBeUndefined();
    expect(review.reviewPosition?.fen).toBe(review.moves[4].beforeFen);
    expect(review.reviewPosition?.positionKey).toBe(
      review.moves[4].beforeFen.split(" ").slice(0, 4).join(" "),
    );
  });

  it("reports the first opponent move that the black repertoire does not cover", () => {
    const source = repertoire("1. e4 c5 2. Nf3 d6 *", {
      orientation: "black",
    });
    const input = game("1. e4 c5 2. Bc4 1-0", {
      white: { username: "Opponent", result: "win" },
      black: { username: "YSHAARRJ", result: "checkmated" },
    });

    const review = reviewGameAgainstRepertoire(input, "yshaarrj", [source]);

    expect(review).toMatchObject({
      status: "opponent-uncovered",
      matchedPlies: 2,
      matchedUserMoves: 1,
      meta: {
        userColor: "black",
        opponent: { username: "Opponent" },
        result: "loss",
      },
      firstOpponentUncovered: {
        kind: "opponent-uncovered",
        reason: "move-not-covered",
        ply: 3,
        played: { uci: "f1c4", isUserMove: false },
        expectedMoves: [{ uci: "g1f3" }],
      },
    });
    expect(review.firstUserDeviation).toBeUndefined();
    expect(review.reviewPosition).toBeUndefined();
  });

  it("distinguishes an annotated avoid move from an unknown user move", () => {
    const source = repertoire(
      "1. e4 (1. d4 $2 {Do not play this.}) e5 *",
    );
    const review = reviewGameAgainstRepertoire(
      game("1. d4 1-0"),
      "Yshaarrj",
      [source],
    );

    expect(review.firstUserDeviation).toMatchObject({
      kind: "user-deviation",
      reason: "known-avoid",
      expectedMoves: [{ uci: "e2e4" }],
      knownAvoid: {
        uci: "d2d4",
        annotations: {
          nags: ["$2"],
          comments: ["Do not play this."],
        },
      },
    });
  });

  it("keeps the longest matching chapter instead of an earlier short sibling", () => {
    const short = repertoire("1. e4 e5 *", {
      studyId: "short-study",
      chapterId: "short",
    });
    const long = repertoire("1. e4 c5 2. Nf3 d6 *", {
      studyId: "long-study",
      chapterId: "long",
    });

    const review = reviewGameAgainstRepertoire(
      game("1. e4 c5 2. Nf3 d6 1-0"),
      "Yshaarrj",
      [short, long],
    );

    expect(review).toMatchObject({
      status: "in-repertoire",
      matchedPlies: 4,
      matchedUserMoves: 2,
      match: { studyId: "long-study", chapterId: "long" },
      matchingChapters: [{ studyId: "long-study", chapterId: "long" }],
    });
  });

  it("unites answer candidates across chapters tied on the game prefix", () => {
    const openSicilian = repertoire("1. e4 c5 2. Nf3 *", {
      studyId: "open-sicilian",
      chapterId: "nf3",
    });
    const closedSicilian = repertoire("1. e4 c5 2. Nc3 *", {
      studyId: "closed-sicilian",
      chapterId: "nc3",
    });

    const review = reviewGameAgainstRepertoire(
      game("1. e4 c5 2. Bc4 1-0"),
      "Yshaarrj",
      [openSicilian, closedSicilian],
    );

    expect(review.firstUserDeviation?.expectedMoves.map((move) => move.uci))
      .toEqual(["g1f3", "b1c3"]);
    expect(review.matchingChapters).toHaveLength(2);
    expect(review.firstUserDeviation?.matchingChapters).toHaveLength(2);
  });

  it("supports a custom initial FEN even if the game PGN omitted FEN headers", () => {
    const initialFen = "8/8/8/8/8/8/4K3/6k1 w - - 0 23";
    const source = repertoire("23. Kf3 *", {
      studyId: "endgame",
      chapterId: "custom-root",
      fen: initialFen,
    });
    const input = game("", {
      pgn: [
        '[Event "Custom game"]',
        '[White "Yshaarrj"]',
        '[Black "Opponent"]',
        '[Result "*"]',
        "",
        "23. Kd3 *",
      ].join("\n"),
      initialFen,
    });

    const review = reviewGameAgainstRepertoire(input, "Yshaarrj", [source]);

    expect(review).toMatchObject({
      status: "user-deviation",
      initialFen,
      moves: [{ moveNumber: 23, uci: "e2d3" }],
      firstUserDeviation: {
        beforeFen: initialFen,
        expectedMoves: [{ uci: "e2f3" }],
      },
    });
  });

  it("returns explicit no-match/end-of-repertoire states and structured errors", () => {
    const whiteSource = repertoire("1. e4 *");
    const blackGame = game("1. e4 c5 1-0", {
      white: { username: "Opponent", result: "win" },
      black: { username: "Yshaarrj", result: "resigned" },
    });
    expect(
      reviewGameAgainstRepertoire(blackGame, "Yshaarrj", [whiteSource]),
    ).toMatchObject({
      status: "no-matching-repertoire",
      matchedPlies: 0,
      matchingChapters: [],
    });

    expect(
      reviewGameAgainstRepertoire(
        game("1. e4 e5 1-0"),
        "Yshaarrj",
        [whiteSource],
      ),
    ).toMatchObject({
      status: "coverage-ended",
      matchedPlies: 1,
      firstDeviation: {
        kind: "coverage-ended",
        reason: "repertoire-ended",
        expectedMoves: [],
      },
    });

    const userAfterBlackLine = repertoire("1. e4 c5 *", {
      orientation: "black",
      studyId: "short-black",
      chapterId: "short-black",
    });
    const userAfterEnd = reviewGameAgainstRepertoire(
      game("1. e4 c5 2. Nf3 d6 1-0", {
        white: { username: "Opponent", result: "win" },
        black: { username: "Yshaarrj", result: "resigned" },
      }),
      "Yshaarrj",
      [userAfterBlackLine],
    );
    expect(userAfterEnd).toMatchObject({
      status: "coverage-ended",
      matchedPlies: 2,
      firstDeviation: {
        kind: "coverage-ended",
        reason: "repertoire-ended",
        ply: 3,
        played: { isUserMove: false, uci: "g1f3" },
      },
    });
    expect(userAfterEnd.firstOpponentUncovered).toBeUndefined();
    expect(userAfterEnd.firstUserDeviation).toBeUndefined();
    expect(userAfterEnd.reviewPosition).toBeUndefined();

    const whiteAfterEnd = reviewGameAgainstRepertoire(
      game("1. e4 e5 2. Nf3 1-0"),
      "Yshaarrj",
      [repertoire("1. e4 e5 *")],
    );
    expect(whiteAfterEnd).toMatchObject({
      status: "coverage-ended",
      matchedPlies: 2,
      firstDeviation: {
        kind: "coverage-ended",
        reason: "repertoire-ended",
        ply: 3,
        played: { isUserMove: true, uci: "g1f3" },
      },
    });
    expect(whiteAfterEnd.firstUserDeviation).toBeUndefined();
    expect(whiteAfterEnd.reviewPosition).toBeUndefined();

    expect(() =>
      reviewGameAgainstRepertoire(game("1. e4 1-0"), "missing", [whiteSource]),
    ).toThrowError(expect.objectContaining({ code: "USER_NOT_IN_GAME" }));
    expect(() =>
      reviewGameAgainstRepertoire(
        game("1. e4 1-0", { rules: "chess960" }),
        "Yshaarrj",
        [whiteSource],
      ),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_RULES" }));
    expect(GameReviewError).toBeDefined();
  });

  it("records every move's FEN and UCI for board replay", () => {
    const source = repertoire("1. e4 e5 2. Nf3 *");
    const review = reviewGameAgainstRepertoire(
      game("1. e4 e5 2. Nf3 1-0"),
      "Yshaarrj",
      [source],
    );
    const replay = new Chess();

    for (const move of review.moves) {
      expect(move.beforeFen).toBe(replay.fen());
      replay.move(move.uci);
      expect(move.afterFen).toBe(replay.fen());
    }
  });
});
