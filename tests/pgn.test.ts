import { describe, expect, it } from "vitest";

import {
  RepertoireImportError,
  importLichessStudiesPgn,
  importLichessStudyPgn,
} from "../shared/index.js";

function chapterPgn(
  moves: string,
  headers: Record<string, string> = {},
): string {
  const merged = {
    Event: "Parser fixture",
    Site: "https://lichess.org/study/study01/chapter01",
    StudyName: "Study name",
    ChapterName: "Chapter name",
    ChapterURL: "https://lichess.org/study/study01/chapter01",
    Orientation: "white",
    Result: "*",
    ...headers,
  };
  return `${Object.entries(merged)
    .map(([key, value]) => `[${key} "${value}"]`)
    .join("\n")}\n\n${moves}`;
}

describe("Lichess Study PGN importer", () => {
  it("builds root-to-leaf lines from standard nested RAV anchors", () => {
    const study = importLichessStudyPgn(
      chapterPgn(
        "1. e4 (1. d4 d5 2. c4 (2. Nf3) e6) e5 (1... c5 2. Nf3) 2. Nf3 *",
      ),
    );
    const chapter = study.chapters[0];

    expect(chapter.repertoireColor).toBe("white");
    expect(chapter.lines.map((line) => line.uciMoves)).toEqual([
      ["e2e4", "e7e5", "g1f3"],
      ["e2e4", "c7c5", "g1f3"],
      ["d2d4", "d7d5", "c2c4", "e7e6"],
      ["d2d4", "d7d5", "g1f3"],
    ]);
    expect(
      chapter.positions[chapter.rootNodeId].outgoingMoveIds.map(
        (moveId) => chapter.moves[moveId].uci,
      ),
    ).toEqual(["e2e4", "d2d4"]);
  });

  it("derives the repertoire side from Orientation and cards only its moves", () => {
    const study = importLichessStudyPgn(
      chapterPgn("1. e4 c5 2. Nf3 d6 *", { Orientation: "black" }),
    );
    const chapter = study.chapters[0];
    const moves = chapter.lines[0].moveIds.map((id) => chapter.moves[id]);

    expect(chapter.repertoireColor).toBe("black");
    expect(moves.map((move) => Boolean(move.cardId))).toEqual([
      false,
      true,
      false,
      true,
    ]);
    expect(chapter.lines[0].userCardIds).toEqual([
      moves[1].cardId,
      moves[3].cardId,
    ]);
  });

  it("keeps repertoire-side $2/$4 examples as annotated avoid edges, not training lines", () => {
    const chapter = importLichessStudyPgn(
      chapterPgn(
        "1. e4 (1. d4 $2 {Do not play this.}) (1. c4 $4 {Loses quickly.}) e5 *",
      ),
    ).chapters[0];

    expect(chapter.lines.map((line) => line.uciMoves)).toEqual([
      ["e2e4", "e7e5"],
    ]);
    const rootMoves = chapter.positions[chapter.rootNodeId].outgoingMoveIds.map(
      (moveId) => chapter.moves[moveId],
    );
    expect(rootMoves.map((move) => [move.uci, move.trainingRole])).toEqual([
      ["e2e4", "train"],
      ["d2d4", "avoid"],
      ["c2c4", "avoid"],
    ]);
    expect(rootMoves[1]).toMatchObject({
      cardId: undefined,
      annotations: { nags: ["$2"], comments: ["Do not play this."] },
    });
    expect(rootMoves[2]).toMatchObject({
      cardId: undefined,
      annotations: { nags: ["$4"], comments: ["Loses quickly."] },
    });
  });

  it("keeps $6 and opponent-side $2/$4 moves in normal training lines", () => {
    const whiteChapter = importLichessStudyPgn(
      chapterPgn("1. e4 $6 e5 $2 2. Nf3 *"),
    ).chapters[0];
    const whiteMoves = whiteChapter.lines[0].moveIds.map(
      (moveId) => whiteChapter.moves[moveId],
    );

    expect(whiteMoves.map((move) => move.trainingRole)).toEqual([
      "train",
      "train",
      "train",
    ]);
    expect(whiteMoves[0].cardId).toBeDefined();
    expect(whiteMoves[1].annotations.nags).toEqual(["$2"]);

    const blackChapter = importLichessStudyPgn(
      chapterPgn("1. e4 $4 c5 2. Nf3 *", { Orientation: "black" }),
    ).chapters[0];
    const opponentExample =
      blackChapter.moves[blackChapter.lines[0].moveIds[0]];
    expect(opponentExample).toMatchObject({
      trainingRole: "train",
      cardId: undefined,
      annotations: { nags: ["$4"] },
    });
  });

  it("deduplicates comments when an annotated edge is merged", () => {
    const chapter = importLichessStudyPgn(
      chapterPgn("1. e4 {same note} (1. e4 {same note}) e5 *"),
    ).chapters[0];
    const e4 = Object.values(chapter.moves).find(
      (move) => move.uci === "e2e4",
    );

    expect(e4?.annotations.comments).toEqual(["same note"]);
  });

  it("preserves prose and board shapes attached before the first move", () => {
    const chapter = importLichessStudyPgn(
      chapterPgn(
        "{Root plan.} {[%cal Gd2d4,Rg1f3]} {[%csl Ge4,Yd5]} 1. e4 *",
      ),
    ).chapters[0];

    expect(chapter.rootAnnotations).toMatchObject({
      comments: ["Root plan."],
      nags: [],
      arrows: ["Gd2d4", "Rg1f3"],
      squares: ["Ge4", "Yd5"],
    });
  });

  it("preserves consecutive prose and shape comments after a move", () => {
    const chapter = importLichessStudyPgn(
      chapterPgn(
        "1. e4 {First note.} {[%cal Ge2e4,Rg1f3]} {Second note. [%csl Ge4,Yd5]} e5 *",
      ),
    ).chapters[0];
    const e4 = Object.values(chapter.moves).find(
      (move) => move.uci === "e2e4",
    );

    expect(e4?.annotations).toMatchObject({
      comments: ["First note. Second note."],
      arrows: ["Ge2e4", "Rg1f3"],
      squares: ["Ge4", "Yd5"],
    });
  });

  it("supports From Position chapters and keeps IDs stable across prose edits", () => {
    const fen = "8/8/8/8/8/8/4K3/6k1 w - - 0 1";
    const first = importLichessStudyPgn(
      chapterPgn("1. Kf3 *", {
        Variant: "From Position",
        FEN: fen,
        ChapterName: "Before",
      }),
    ).chapters[0];
    const second = importLichessStudyPgn(
      chapterPgn("1. Kf3 {new explanation} *", {
        Variant: "From Position",
        FEN: fen,
        ChapterName: "After",
      }),
    ).chapters[0];

    expect(first.rootFen).toBe(fen);
    expect(first.lines[0].id).toBe(second.lines[0].id);
    expect(first.lines[0].userCardIds).toEqual(second.lines[0].userCardIds);
    expect(
      second.moves[second.lines[0].moveIds[0]].annotations.comments,
    ).toContain("new explanation");
  });

  it("groups multi-study exports and rejects them in the single-study API", () => {
    const pgn = [
      chapterPgn("1. e4 *", {
        Site: "https://lichess.org/study/alpha/a1",
        ChapterURL: "https://lichess.org/study/alpha/a1",
      }),
      chapterPgn("1. d4 *", {
        Site: "https://lichess.org/study/beta/b1",
        ChapterURL: "https://lichess.org/study/beta/b1",
      }),
    ].join("\n\n");

    expect(importLichessStudiesPgn(pgn).map((study) => study.id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(() => importLichessStudyPgn(pgn)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: "MULTIPLE_STUDIES" })],
      }),
    );
  });

  it("reports missing orientation as a structured import error", () => {
    const pgn = chapterPgn("1. e4 *").replace(
      '[Orientation "white"]\n',
      "",
    );

    try {
      importLichessStudyPgn(pgn);
      throw new Error("Expected the importer to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RepertoireImportError);
      expect((error as RepertoireImportError).diagnostics).toEqual([
        expect.objectContaining({
          code: "MISSING_ORIENTATION",
          chapterId: "chapter01",
          chapterIndex: 0,
        }),
      ]);
    }
  });

  it("rejects unsupported chess variants", () => {
    expect(() =>
      importLichessStudyPgn(
        chapterPgn("1. e4 *", { Variant: "Chess960" }),
      ),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: "UNSUPPORTED_VARIANT" })],
      }),
    );
  });
});
