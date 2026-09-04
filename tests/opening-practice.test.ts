import { describe, expect, it } from "vitest";

import {
  assessMoveSoundness,
  buildOpponentMovePool,
  decideOpponentMoveSource,
  gameCount,
  scoreRate,
  selectOpponentMove,
  type OpeningExplorerPosition,
} from "../shared/opening-practice.js";

const position: OpeningExplorerPosition = {
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  results: { whiteWins: 960, draws: 500, blackWins: 539 },
  moves: [
    {
      uci: "e2e4",
      san: "e4",
      results: { whiteWins: 500, draws: 250, blackWins: 250 },
    },
    {
      uci: "d2d4",
      san: "d4",
      results: { whiteWins: 370, draws: 180, blackWins: 150 },
    },
    {
      uci: "c2c4",
      san: "c4",
      results: { whiteWins: 50, draws: 50, blackWins: 100 },
    },
    {
      uci: "b2b3",
      san: "b3",
      results: { whiteWins: 40, draws: 20, blackWins: 39 },
    },
  ],
};

describe("opening-practice opponent policy", () => {
  it("falls back to the engine and opens a session circuit after Explorer failure", () => {
    expect(decideOpponentMoveSource({
      mode: "auto",
      explorerOutcome: "failure",
    })).toEqual({
      source: "engine",
      reason: "database-failed",
      openExplorerCircuit: true,
    });

    expect(decideOpponentMoveSource({
      mode: "auto",
      explorerOutcome: "skipped",
      explorerCircuitOpen: true,
    })).toEqual({
      source: "engine",
      reason: "database-circuit-open",
      openExplorerCircuit: true,
    });
  });

  it("uses engine-only mode and falls back from an empty book without opening the circuit", () => {
    expect(decideOpponentMoveSource({
      mode: "engine",
      explorerOutcome: "skipped",
    })).toMatchObject({ source: "engine", reason: "engine-only" });

    expect(decideOpponentMoveSource({
      mode: "auto",
      explorerOutcome: "empty",
    })).toEqual({
      source: "engine",
      reason: "database-empty",
      openExplorerCircuit: false,
    });
  });

  it("prefers terminal game state over either move source", () => {
    expect(decideOpponentMoveSource({
      mode: "engine",
      explorerOutcome: "skipped",
      explorerCircuitOpen: true,
      gameOver: true,
    })).toEqual({
      source: "complete",
      reason: "game-over",
      openExplorerCircuit: true,
    });
  });

  it("computes game counts and mover-relative scores", () => {
    const results = { whiteWins: 4, draws: 2, blackWins: 2 };
    expect(gameCount(results)).toBe(8);
    expect(scoreRate(results, "white")).toBe(0.625);
    expect(scoreRate(results, "black")).toBe(0.375);
  });

  it("filters rare moves and preserves frequency-derived probabilities", () => {
    const pool = buildOpponentMovePool(position, {
      minimumGames: 100,
      minimumPlayRate: 0.05,
      maximumCandidates: 2,
      frequencyExponent: 1,
    });

    expect(pool.map((candidate) => candidate.move.uci)).toEqual([
      "e2e4",
      "d2d4",
    ]);
    expect(pool[0].probability).toBeCloseTo(10 / 17);
    expect(pool[1].probability).toBeCloseTo(7 / 17);
    expect(pool[0].playRate).toBeCloseTo(1_000 / 1_999);
  });

  it("selects deterministically at weighted bucket boundaries", () => {
    const policy = {
      minimumGames: 1,
      minimumPlayRate: 0,
      maximumCandidates: 4,
      frequencyExponent: 1,
    };
    const pool = buildOpponentMovePool(position, policy);
    const firstBoundary = pool[0].probability;

    expect(selectOpponentMove(position, policy, () => 0)?.move.uci).toBe(
      "e2e4",
    );
    expect(
      selectOpponentMove(position, policy, () => firstBoundary - 0.000001)
        ?.move.uci,
    ).toBe("e2e4");
    expect(
      selectOpponentMove(position, policy, () => firstBoundary)?.move.uci,
    ).toBe("d2d4");
  });

  it("ends the book cleanly when no database move meets the policy", () => {
    expect(
      selectOpponentMove(position, { minimumGames: 10_000 }),
    ).toBeUndefined();
  });

  it("rejects invalid policy and RNG inputs", () => {
    expect(() =>
      buildOpponentMovePool(position, { frequencyExponent: 0 }),
    ).toThrow(/frequencyExponent/);
    expect(() => selectOpponentMove(position, {}, () => 1)).toThrow(/RNG/);
  });
});

describe("opening-practice soundness policy", () => {
  it("uses sufficiently deep normalized engine loss as authoritative evidence", () => {
    expect(
      assessMoveSoundness({
        legal: true,
        mover: "white",
        playedUci: "a2a3",
        position,
        engine: { depth: 20, centipawnLoss: 80 },
      }),
    ).toMatchObject({
      verdict: "pass",
      reason: "engine-within-threshold",
      basis: "engine",
    });

    expect(
      assessMoveSoundness({
        legal: true,
        mover: "white",
        playedUci: "e2e4",
        position,
        engine: { depth: 20, centipawnLoss: 81 },
      }),
    ).toMatchObject({
      verdict: "fail",
      reason: "engine-loss-too-large",
      centipawnLoss: 81,
    });
  });

  it("fails a reliably detected forced-mate loss", () => {
    expect(
      assessMoveSoundness({
        legal: true,
        mover: "white",
        playedUci: "e2e4",
        position,
        engine: { depth: 22, forcedMateLost: true },
      }),
    ).toMatchObject({
      verdict: "fail",
      reason: "engine-forced-mate-lost",
      basis: "engine",
    });
  });

  it("accepts a statistically supported response without requiring one line", () => {
    const assessment = assessMoveSoundness({
      legal: true,
      mover: "white",
      playedUci: " E2E4 ",
      position,
    });

    expect(assessment).toMatchObject({
      verdict: "pass",
      reason: "database-supported",
      basis: "database",
      playedUci: "e2e4",
      databaseGames: 1_000,
    });
    expect(assessment.databaseScoreRate).toBeCloseTo(0.625);
    expect(assessment.referenceScoreRate).toBeCloseTo(460 / 700);
  });

  it("falls back from shallow engine data to strong database support", () => {
    expect(
      assessMoveSoundness({
        legal: true,
        mover: "white",
        playedUci: "e2e4",
        position,
        engine: { depth: 10, centipawnLoss: 999 },
      }),
    ).toMatchObject({
      verdict: "pass",
      reason: "database-supported",
      engineDepth: 10,
    });
  });

  it("does not label rare or statistically weak moves as blunders", () => {
    expect(
      assessMoveSoundness({
        legal: true,
        mover: "white",
        playedUci: "b2b3",
        position,
      }),
    ).toMatchObject({
      verdict: "inconclusive",
      reason: "database-sample-too-small",
    });

    expect(
      assessMoveSoundness({
        legal: true,
        mover: "white",
        playedUci: "c2c4",
        position,
      }),
    ).toMatchObject({
      verdict: "inconclusive",
      reason: "database-performance-gap",
    });

    expect(
      assessMoveSoundness({
        legal: true,
        mover: "white",
        playedUci: "g1f3",
        position,
      }),
    ).toMatchObject({
      verdict: "inconclusive",
      reason: "move-not-in-database",
    });
  });

  it("scores historical results from Black's perspective", () => {
    const blackPosition: OpeningExplorerPosition = {
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      results: { whiteWins: 750, draws: 400, blackWins: 850 },
      moves: [
        {
          uci: "c7c5",
          san: "c5",
          results: { whiteWins: 350, draws: 200, blackWins: 450 },
        },
        {
          uci: "e7e5",
          san: "e5",
          results: { whiteWins: 400, draws: 200, blackWins: 400 },
        },
      ],
    };

    expect(
      assessMoveSoundness({
        legal: true,
        mover: "black",
        playedUci: "e7e5",
        position: blackPosition,
      }),
    ).toMatchObject({
      verdict: "pass",
      reason: "database-supported",
      databaseScoreRate: 0.5,
      referenceScoreRate: 0.55,
    });
  });

  it("rejects illegal moves before consulting other evidence", () => {
    expect(
      assessMoveSoundness({
        legal: false,
        mover: "white",
        playedUci: "e2e5",
        position,
        engine: { depth: 30, centipawnLoss: 0 },
      }),
    ).toEqual({
      verdict: "fail",
      reason: "illegal-move",
      basis: "legality",
      playedUci: "e2e5",
    });
  });
});
